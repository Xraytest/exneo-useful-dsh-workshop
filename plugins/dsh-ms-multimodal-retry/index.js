/**
 * dsh-ms-multimodal-retry — 面向 ModelScope（MS）渠道的多模态失败自愈插件。
 *
 * 背景（2026-10-05 实测，见本文件末尾「现场证据」）：
 *   DSH → new-api → ModelScope(api-inference.modelscope.cn) 的
 *   `deepseek-ai/DeepSeek-V4.1-Flash` 等模型，在请求体较大（长上下文 +
 *   每请求重发的 base64 内联图 + 工具 schema）时，上游的「下载/预处理多模态
 *   文件」步骤偶发超过其约 60s 预算，返回：
 *
 *     <400> InternalError.Algo.InvalidParameter: Download multimodal file timed out
 *
 *   DSH 把 400 归一成失败类别码 `INVALID_REQUEST`，而出厂重试策略
 *   （dsh-llm/retry-policy 的 normal 模式）只重试 EMPTY_RESPONSE /
 *   RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT 五类，因此这类抖动既不会被
 *   new-api 换渠道（它只对 429/5xx 重试），也不会被 DSH 重试——整个 turn 直接
 *   失败。本 profile 里 dsh-model-retry 接管了重试 waterfall，但它同样只认
 *   配置过的类别码 / 状态码，缺省仍会把这口锅原样下传。
 *
 * 本插件挂在同一个 `agent/request-error` waterfall 上（位于 model-retry
 * 之后，见 cordis.patch.yml 的行序），做一件事：
 *
 *   命中「特定模型 + MS 多模态下载超时」→ 剔除模型可见面里**最早**的图像
 *   → 退避 → 返回 { kind: 'retry' }，让 agent loop 在同一个 turn 内重跑该步。
 *
 * 图像剔除机制与出厂 `unload_images` 工具 / `compaction-tool-result-pruner`
 * 完全一致：被替换的面节点先落一条 `compaction/prune` 影子计价事件，再用
 * `surfaceOp: {op:'replace'}` + `sourceEventSeqs` 落替换事件。会话日志是
 * 只增的，人工转录不变；只有模型后续请求不再重发那张图（省 base64 字节、
 * 也绕开上游那次多模态下载）。`keep_last`（配置项）可保住最新的若干张。
 *
 * 选区（哪些模型生效）完全由配置决定，见下方 Config 说明；models 为空 =
 *   对所有模型都不生效（插件空转，仅消耗一次监听）。
 *
 * 纯 host 半边：不发布服务、不注入 UI、不依赖任何 agent 预设 / skill /
 *   动态插件，故「启动 dsh 即持续运行」，刷新与重启都不丢。
 *
 * 职责边界：本插件任何自身异常都不得搞垮用户 turn —— 一律 try/catch 记
 *   warn 后 `next()` 交回下游（等价于本插件缺位）。
 *
 * @module dsh-ms-multimodal-retry
 */

export const name = 'dsh-ms-multimodal-retry';

/** 缺省配置（patch 里 `config:` 覆盖）。 */
const DEFAULTS = Object.freeze({
  /** DSH provider 名（settings.yaml 的 provider 键）匹配；'*' = 不限。 */
  providers: Object.freeze(['*']),
  /**
   * 生效的模型 id 匹配列表。空数组 = 不生效（显式选区，避免误伤）。
   * 支持通配符 `*` / `?`；精确匹配优先于通配匹配（与 dsh-model-retry 同规。
   */
  models: Object.freeze([]),
  /** 命中的 HTTP 状态码（failure.status）。 */
  errorStatus: Object.freeze([400]),
  /** 命中特征子串（对 failure.message 大小写不敏感）。 */
  errorPatterns: Object.freeze([
    'download multimodal file timed out',
    'multimodal file timed out',
  ]),
  /** 每次重试剔除的最早图像张数。 */
  drop: 1,
  /** 单个 (session, turn, step) 的最大自愈次数；同时也是图像剔除预算上限。 */
  maxRetries: 3,
  /** 重试前退避（ms）。 */
  delayMs: 500,
});

/** 朴素 record 判定（块走查用）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 通配符 → 正则；非法 pattern 退化为永假。 */
function patternToRegExp(pattern) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^]*');
  try {
    return new RegExp(`^${escaped}$`, 'i');
  } catch {
    return /(?!)/;
  }
}

/** 一个模式的具体度：非通配部分越长越具体。 */
function patternScore(pattern) {
  const wild = pattern.replace(/[*?]/g, '');
  return wild.length * 10 + (pattern.includes('*') || pattern.includes('?') ? 0 : 1);
}

/** 列表里最具体的匹配者，或 undefined。精确 > 通配。 */
function bestMatch(patterns, value) {
  if (typeof value !== 'string' || value === '') return undefined;
  let best;
  let bestScore = -1;
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '') continue;
    if (!patternToRegExp(pattern).test(value)) continue;
    const score = patternScore(pattern);
    if (score > bestScore) {
      best = pattern;
      bestScore = score;
    }
  }
  return best;
}

/** 统计一段内容里的图像块数（含嵌套 tool-result）。 */
/**
 * 把一条工具结果消息归一成「真正的内容块数组 + 用新块数组重建消息的函数」。
 *
 * 两代形状不同：
 *   · 0.1：`role:'user'`，content = [一枚 `tool-result` 包装块]，真块在它的 `.content` 里；
 *   · 0.2：一等 `role:'tool'` 消息，content **就是**真块，callId/isError 挪到消息顶层。
 * 只认旧形状会让 0.2 上工具返回的图片被静默跳过（计数 0 → 不进 targets → 该丢的
 * 超时图片永远留在上下文里）；沿用旧包装块回写则会在 0.2 上写出非法消息。
 *
 * @param {object} message 工具结果消息。
 * @returns {{blocks: unknown[], rebuild: (blocks: unknown[]) => object}|undefined} 归一视图。
 */
function toolResultView(message) {
  const content = message === null || message === undefined ? undefined : message.content;
  if (!Array.isArray(content)) return undefined;
  const first = isRecord(content[0]) ? content[0] : undefined;
  if (first !== undefined && first.type === 'tool-result' && Array.isArray(first.content)) {
    return {
      blocks: first.content,
      rebuild: (blocks) => ({ ...message, content: [{ ...first, content: blocks }] }),
    };
  }
  return {
    blocks: content,
    rebuild: (blocks) => ({ ...message, content: blocks }),
  };
}

function countImages(blocks) {
  if (!Array.isArray(blocks)) return 0;
  let total = 0;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === 'image') total += 1;
    else if (block.type === 'tool-result') total += countImages(block.content);
  }
  return total;
}

/**
 * 把最早出现的 `budget` 张图像换成占位文本；绝不改动冻结的持久块。
 * 与出厂 unload_images 的 stripImages 同一套不变量：
 * 部分命中的节点保留其尾部，被替换的只有头部若干张。
 *
 * `budget` 是**数字**（张数），调用方一律传数字。<=0 必须原样返回：嵌套走查
 * （tool-result 内）会以余量 0 递归进来，此时整块保留该 tool-result——
 * 若把余量算错（对象/NaN），嵌套里的图会被连带误删，那是丢数据，不是剔除。
 */
function stripImages(blocks, budget, onDrop) {
  if (!Array.isArray(blocks) || !(budget > 0)) return { blocks, used: 0 };
  let used = 0;
  let next;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (isRecord(block) && block.type === 'image') {
      if (used >= budget) {
        if (next !== undefined) next.push(block);
        continue;
      }
      next ??= blocks.slice(0, index);
      next.push({ type: 'text', text: onDrop(block.attachment) });
      used += 1;
      continue;
    }
    if (isRecord(block) && block.type === 'tool-result') {
      const nested = stripImages(block.content, budget - used, onDrop);
      if (nested.used > 0) {
        next ??= blocks.slice(0, index);
        next.push({ ...block, content: nested.blocks });
        used += nested.used;
        continue;
      }
    }
    if (next !== undefined) next.push(block);
  }
  return { blocks: next === undefined ? blocks : next, used };
}

/** 图像身份的一行摘要（占位文本与日志共用）。 */
function describeImage(ref) {
  const raw = typeof ref?.attachmentId === 'string' ? ref.attachmentId : String(ref?.attachmentId ?? '');
  const digest = raw.startsWith('sha256:') ? raw.slice(7, 15) : raw.slice(0, 8);
  const name = typeof ref?.name === 'string' && ref.name.length > 0 ? `"${ref.name}"` : `sha256:${digest}`;
  const dims = typeof ref?.width === 'number' && typeof ref?.height === 'number' ? `, ${ref.width}x${ref.height}px` : '';
  const bytes = typeof ref?.bytes === 'number' ? `, ${ref.bytes} bytes` : '';
  return `${name} (${digest}${dims}${bytes})`;
}

/** 占位文本：保留身份与恢复方式，模型可据此调 read_image 取回。 */
function placeholderText(ref) {
  return `[image dropped by dsh-ms-multimodal-retry: ${describeImage(ref)}. `
    + 'The provider timed out downloading this multimodal file, so it was removed from the model context. '
    + 'Call read_image on the same path when you need it again.]';
}

/**
 * 当前模型可见面里仍带图像的节点，最旧优先。
 * `assistant/message` 不承载 sourceEventSeqs，永远不是替换目标；
 * 节点 0 是系统提示，本走查不碰（只收 user/message 与 tool/result）。
 */
function collectTargets(session) {
  const targets = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (!isRecord(event)) continue;
    if (event.type === 'user/message') {
      const count = countImages(event.data?.content);
      if (count === 0) continue;
      targets.push({
        type: 'user/message',
        seq,
        origin: 'attachment',
        count,
        blocks: event.data.content,
        price: event.data,
        replacement(blocks) {
          return { ...event.data, content: blocks };
        },
      });
      continue;
    }
    if (event.type === 'tool/result') {
      const view = toolResultView(event.data?.message);
      if (view === undefined) continue;
      const count = countImages(view.blocks);
      if (count === 0) continue;
      targets.push({
        type: 'tool/result',
        seq,
        origin: 'tool-result',
        count,
        blocks: view.blocks,
        price: event.data.message,
        replacement(blocks) {
          return { ...event.data, message: view.rebuild(blocks) };
        },
      });
    }
  }
  return targets;
}

/** 失败是否命中本插件的选区与特征。 */
function matchFailure(failure, config) {
  if (!isRecord(failure)) return false;
  const status = typeof failure.status === 'number' ? failure.status : undefined;
  if (config.errorStatus.length > 0) {
    if (status === undefined || !config.errorStatus.includes(status)) return false;
  }
  const message = typeof failure.message === 'string' ? failure.message : '';
  if (config.errorPatterns.length > 0) {
    const lowered = message.toLowerCase();
    if (!config.errorPatterns.some((pattern) => lowered.includes(pattern.toLowerCase()))) return false;
  }
  return true;
}

/** 配置归一：未知/越界值一律回落缺省，绝不因为配置敲错而在启动时抛异常。 */
function normalizeConfig(raw) {
  /** 字符串列表；空列表保留为空（models 为空 = 插件空转，是关键语义）。 */
  const strList = (value, fallback) => {
    if (!Array.isArray(value)) return [...fallback];
    const items = value
      .filter((item) => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim());
    return items.length > 0 ? items : [...fallback];
  };
  /** 整数列表；允许数字或数字字符串，去重、越界丢弃。 */
  const intList = (value, fallback, min, max) => {
    if (!Array.isArray(value)) return [...fallback];
    const items = [];
    for (const item of value) {
      const parsed = typeof item === 'number' ? item : Number.parseInt(String(item), 10);
      if (Number.isInteger(parsed) && parsed >= min && parsed <= max && !items.includes(parsed)) items.push(parsed);
    }
    return items.length > 0 ? items : [...fallback];
  };
  const num = (value, fallback, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.trunc(value), min), max);
  };
  return Object.freeze({
    providers: strList(raw?.providers, DEFAULTS.providers),
    models: strList(raw?.models, DEFAULTS.models),
    errorStatus: intList(raw?.errorStatus, DEFAULTS.errorStatus, 100, 599),
    errorPatterns: strList(raw?.errorPatterns, DEFAULTS.errorPatterns),
    drop: num(raw?.drop, DEFAULTS.drop, 1, 16),
    maxRetries: num(raw?.maxRetries, DEFAULTS.maxRetries, 1, 16),
    delayMs: num(raw?.delayMs, DEFAULTS.delayMs, 0, 600000),
  });
}

/** 可取消退避；取消即 false。 */
function cancellableDelay(delayMs, signal) {
  if (delayMs <= 0) return Promise.resolve(!signal?.aborted);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function apply(ctx, config = {}) {
  const options = normalizeConfig(config);
  const logger = ctx.logger;

  /** (session, turn, step) → 已自愈次数；agent 空闲即清。 */
  const budgets = /* @__PURE__ */ new Map();
  const lifetime = new AbortController();

  const keyOf = (session, turn, step) => {
    let perSession = budgets.get(session);
    if (perSession === undefined) {
      perSession = /* @__PURE__ */ new Map();
      budgets.set(session, perSession);
    }
    const key = `${turn}:${step}`;
    return { perSession, key, used: perSession.get(key) ?? 0 };
  };

  /** 本次失败对应的模型与 provider（取不到就当不匹配，宁可不作为）。 */
  const routeOf = (agent, provider) => {
    let model;
    try {
      model = agent?.session?.requestHeader?.()?.config?.model;
    } catch {
      model = undefined;
    }
    return { model: typeof model === 'string' ? model : '', provider: typeof provider === 'string' ? provider : '' };
  };

  /**
   * 剔除最早的 `drop` 张图像，落影子计价 + 替换事件。
   * @returns 实际剔除张数与摘要；0 = 面上已无图可剔。
   */
  const dropEarliestImages = (session, drop) => {
    const tokenMeter = (() => {
      try {
        return ctx.get('tokenMeter');
      } catch {
        return undefined;
      }
    })();
    const priceOf = (message) => {
      if (tokenMeter === undefined || typeof tokenMeter.estimateMessage !== 'function') return 0;
      try {
        const value = tokenMeter.estimateMessage(message);
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
      } catch {
        return 0;
      }
    };

    const targets = collectTargets(session);
    let total = 0;
    for (const target of targets) total += target.count;
    if (total === 0) return { dropped: 0, remaining: 0, images: [] };

    // 与 unload_images 同一语义：从头（最旧）开始剔，部分命中的节点保留尾部。
    let budget = Math.max(0, Math.min(drop, total));
    let dropped = 0;
    const images = [];
    for (const target of targets) {
      if (budget <= 0) break;
      const take = Math.min(target.count, budget);
      const onDrop = (ref) => {
        images.push(describeImage(ref));
        return placeholderText(ref);
      };
      const stripped = stripImages(target.blocks, take, onDrop);
      if (stripped.used <= 0) continue;
      // 影子计价必须先于替换：token 折叠从紧邻其前的计量事件取价，
      // 未计价的替换会让上下文压力投影漂移（toolResultPruner 的邻接契约）。
      session.append('compaction/prune', {
        shadowedRange: { start: target.seq, end: target.seq },
        shadowedSeqs: [target.seq],
        shadowedTokenCount: priceOf(target.price),
      });
      session.append(target.type, target.replacement(stripped.blocks), {
        surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
        sourceEventSeqs: [target.seq],
      });
      dropped += stripped.used;
      budget -= stripped.used;
    }
    return { dropped, remaining: total - dropped, images };
  };

  async function recover({ agent, turn, step, provider, failure, signal }, next) {
    const session = agent?.session;
    if (session === undefined) return next();

    const { model, provider: providerName } = routeOf(agent, provider);
    const providerHit = bestMatch(options.providers, providerName);
    const modelHit = bestMatch(options.models, model);
    if (providerHit === undefined || modelHit === undefined) return next();
    if (!matchFailure(failure, options)) return next();

    const { perSession, key, used } = keyOf(session, turn, step);
    if (used >= options.maxRetries) {
      logger?.warn?.(`dsh-ms-multimodal-retry: ${model} 第 ${turn}/${step} 步已自愈 ${used} 次（预算 ${options.maxRetries}），放弃并交回原始错误`);
      return next();
    }

    let total = 0;
    try {
      for (const target of collectTargets(session)) total += target.count;
    } catch (error) {
      logger?.warn?.(`dsh-ms-multimodal-retry: 面走查失败，放弃自愈: ${String(error?.message ?? error)}`);
      return next();
    }
    if (total === 0) {
      logger?.info?.(`dsh-ms-multimodal-retry: ${model} 的 ${turn}/${step} 步命中多模态下载超时，但上下文已无图像，无法剔除`);
      return next();
    }

    if (signal?.aborted || lifetime.signal.aborted) return next();

    const before = used + 1;
    let result;
    try {
      result = dropEarliestImages(session, options.drop);
    } catch (error) {
      logger?.warn?.(`dsh-ms-multimodal-retry: 剔除图像失败，放弃自愈: ${String(error?.stack ?? error)}`);
      return next();
    }
    if (result.dropped <= 0) return next();
    perSession.set(key, before);

    logger?.info?.(`dsh-ms-multimodal-retry: ${model} 命中「${failure?.code ?? '?'}」多模态下载超时，`
      + `剔除最早 ${result.dropped} 张图像（剩 ${result.remaining} 张）后重试 ${turn}/${step} 步（第 ${before}/${options.maxRetries} 次）`);

    if (!(await cancellableDelay(options.delayMs, signal ?? lifetime.signal))) return next();
    if (signal?.aborted || lifetime.signal.aborted) return next();
    return { kind: 'retry' };
  }

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    // 责任边界同 model-retry：自身异常不得搞垮用户轮次。
    return (async () => {
      try {
        return await recover(payload, next);
      } catch (error) {
        logger?.warn?.(`dsh-ms-multimodal-retry: 自愈决策异常，交回原始错误: ${String(error?.stack ?? error)}`);
        return next();
      }
    })();
  });

  // 预算只在「当前打开步」内累计：agent 转空闲即归零，跨 turn 不串味。
  const disposeStatus = ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') budgets.delete(agent?.session);
  });

  ctx.effect(() => async () => {
    disposeListener?.();
    disposeStatus?.();
    budgets.clear();
    lifetime.abort(new Error('dsh-ms-multimodal-retry disposed'));
  }, 'dsh-ms-multimodal-retry: dispose');

  logger?.info?.(`dsh-ms-multimodal-retry: 已挂载（models=${JSON.stringify(options.models)}, `
    + `pattern=${failureMessagePattern(options)}, drop=${options.drop}, `
    + `maxRetries=${options.maxRetries}, delayMs=${options.delayMs}）`);
}

function failureMessagePattern(options) {
  return options.errorPatterns.join(' | ');
}

/*
 * 现场证据（2026-10-05，本机 new-api 日志 + 直连复测）：
 *   - 失败请求耗时 1m1.87s / 1m1.99s（网关 GIN 行），成功请求 11–35s；
 *   - 同图同模型小请求直连 6/6 成功，1.44 MiB 流式请求实测 17.8s 与 63.7s
 *     —— 该体量请求本就贴在 60s 预算上，压线即返回本错误；
 *   - 网关 8 天日志共 10 次该错误，全部落在 ModelScope 渠道（#22/#24），
 *     其他渠道 0 次；证明是供应商侧多模态 ingest 超时，与 DSH 无关
 *     （pi-ai 恒以 base64 data URL 内联，DSH 从不发可下载的 URL）。
 */
