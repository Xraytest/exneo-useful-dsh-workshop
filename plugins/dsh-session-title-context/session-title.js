/**
 * dsh-session-title-context —— DeepSeek Harness 静态插件（host 半边）。
 *
 * 会话标题生成器：给 `ctx.sessionTitle` 注册唯一的标题提供者
 * （provider id `session-title-context`），并额外提供 `/title` 人用命令。
 * 出厂 `@deepseek-ai/dsh-session-title-first-prompt-llm` 行必须停用
 * （本插件与它争同一个注册位，服务只接受一个提供者）。
 *
 * 设计要点（对着用户提出的六条要求逐条落地）：
 *
 * 1. 对当前会话生成标题：走 `ctx.sessionTitle.register()`，标题作为
 *    `session/title` 事件落进会话日志，客户端列表行自动显示；
 *    `/title` 命令可随时手动重生成（内部调 `sessionTitle.refresh()`）。
 * 2. 支持推理模型：标题由**工具调用**携带，而不是普通文本。请求带上
 *    `submit_session_title` 工具，模型把标题写进 `title` 参数，
 *    插件的解析优先读 tool-call 块、忽略 reasoning 块，
 *    并接受 `finish.kind === 'tool-calls'`（出厂策略反而会把工具调用
 *    当错误拒绝）。若某条路由不支持工具，可回退成文本解析
 *    （`textFallback`，默认开）。
 * 3. 完整上下文但去除图片：上下文取自 `session.surface` 的顺序节点
 *    （即 `deriveMessages()` 的同一套投影），包含 human / assistant /
 *    tool 全部消息；图片块换成占位文本、文件块换成占位文本、
 *    reasoning 块丢弃，工具结果按 `toolResultMaxBytes` 截断。
 *    另外默认丢掉 harness 注入的说明性上下文行（AGENTS.md 之类的说明文件、
 *    技能目录、运行时快照——source 带 `form`，动辄几十 KB 且与标题无关；
 *    压缩摘要不带 `form`，照常保留），可用 `includeInjectedContext: true` 打开。
 * 4. 默认用当前会话模型：路由取自服务传入的 `request.route`
 *    （= 会话日志里 `request/header` 的 provider/model），
 *    也可用配置 `provider`/`model` 固定，或用 `/title <模型>` 指定
 *    **一次性**模型（只作用于紧接着的那一次生成）。
 * 5. 与会话工作同时进行：服务把提供者调用放在 detached 任务里，
 *    本插件的 `generate()` 只读会话日志、只发自己的 `llm.stream()`
 *    （`purpose: 'session-title'`，因此不会被 model-pool /
 *    subagent-models 计入会话用量），从不阻塞 agent loop；
 *    被更新的修订取代时按 `request.signal` 立刻中断。
 * 6. 允许忽略未完整生成的消息：上下文只读到本次修订最后一条
 *    human 消息的 seq 为止（正在流式生成的 assistant 回复、正在跑的
 *    工具结果天然不在范围内），并额外丢弃 `interrupted: true` 的
 *    assistant 消息，以及配对不上的 tool-call / tool-result。
 * 7. 标题栏 UI（client 半边 `client.js`）：会话标题栏右侧（槽位
 *    `conversation.session.header.utilities`，order 24，落在 model-pool 与
 *    subagent-models 之间）一个「标题」控件——点一下＝用当前会话模型重生成，
 *    展开面板可看当前标题、上次路由/via/耗时、上次失败原因与后台是否在跑，
 *    并可「指定模型生成一次」（与 `/title <provider>/<model>` 共用同一张
 *    一次性模型表）。浏览器与宿主只走下面三条同源接口，不依赖出厂 remote：
 *      GET  /dsh-session-title/state?sessionId=
 *      GET  /dsh-session-title/models
 *      POST /dsh-session-title/generate   {sessionId, provider?, model?}
 *
 * 组合行（`/root/.dsh/profiles/web/cordis.patch.yml`）：
 *   - id: session-title-llm
 *     disabled: true
 *   - insert:
 *       - id: session-title-context
 *         name: ./plugins/dsh-session-title-context/session-title.js
 *
 * 运维注意（本 profile 未开 HMR 模块热载）：改本文件或 `client.js` 之后，
 * live patch 重载只重放配置、不会重新 import 模块，也没有 bundle 重建；
 * 要立刻生效得换组合行的 `name`（新模块 URL＝一次真实重载）或重启 dsh。
 * 另外 client 半边「是不是客户端包」的判定按加载器 specifier 缓存到进程结束，
 * 所以**新增/改动 dsh.client 声明后必须换 name**；浏览器侧还要刷新页面
 * （`window.__DSH_BOOT__` 每次页面加载才重新生成）。
 *
 * @module dsh-session-title-context
 */

import { BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { MAX_TIMER_DELAY_MS, deadline } from '@deepseek-ai/dsh-timeout';

export const name = 'session-title-context';
/**
 * 硬依赖标题服务、LLM 注册表与会话表（UI 路由要按 sessionId 找回活会话）；
 * `commands` 与 `webServer` 在 apply 里按需等待（非 web profile 也能只用命令）。
 */
export const inject = ['sessionTitle', 'llm', 'sessions'];

const PROVIDER_ID = 'session-title-context';
const TIMEOUT_CODE = 'SESSION_TITLE_TIMEOUT';
const TITLE_TOOL_NAME = 'submit_session_title';
/** 标题栏 UI（client 半边）调用的同源 HTTP 前缀。 */
const ROUTE_PREFIX = '/dsh-session-title';
/** UI 手动触发的硬上限：比配置的 timeoutMs 再宽一点，覆盖排队与重试。 */
const UI_GENERATE_GRACE_MS = 30000;
const INSTRUCTION_ID = 'session-title-context-request';
const OMIT_ID = 'session-title-context-omitted';

/** 标题请求唯一的工具：模型必须把标题放进它的 `title` 参数。 */
const TITLE_TOOL = {
  name: TITLE_TOOL_NAME,
  description: '提交这次会话的最终标题。整次请求只调用一次；标题只写在 title 参数里，不要写进普通文本。',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '会话标题：一行纯文本，使用会话的主要语言，不要引号、编号、句号或“标题：”前缀。',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

/** 收尾的用户消息：把模型的注意力压到“现在就调工具”上。 */
const INSTRUCTION_TEXT = `请现在调用 ${TITLE_TOOL_NAME} 提交本次会话标题（title 参数），不要在助手文本里重复标题。`;

const DEFAULT_CONFIG = {
  cadence: 'all-prompts',
  targetWords: 6,
  targetCjkCharacters: 12,
  maxInputBytes: 65536,
  maxOutputTokens: 2048,
  // 慢路由（本地网关/免费通道）单次标题请求可达 1 分钟以上，缺省给 2 分钟。
  timeoutMs: 120000,
  toolResultMaxBytes: 1200,
  includeSystemPrompt: false,
  includeInjectedContext: false,
  logRequests: false,
  textFallback: true,
};

/** 注册重试：live patch 重载时旧提供者的异步卸载可能还没跑完。 */
const REGISTER_RETRY_DELAY_MS = 200;
const REGISTER_MAX_ATTEMPTS = 50;
/** 一次性模型指定的有效期，避免陈旧指定泄漏到很久以后的自动修订。 */
const OVERRIDE_TTL_MS = 60000;

const encoder = new TextEncoder();

/** 纯 JSON 对象守卫。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** UTF-8 字节数。 */
function byteLength(text) {
  return encoder.encode(text).length;
}

/** 统一的错误文案。 */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 读一个正整数字段。 */
function positiveInt(raw, fallback, field) {
  if (raw === undefined || raw === null) return fallback;
  if (!Number.isInteger(raw) || raw <= 0) throw new Error(`session-title-context: ${field} 必须是正整数`);
  return raw;
}

/**
 * 校验并合并插件配置（不导出 Config schema，保持零依赖与直白的报错）。
 * @param raw - 组合行里的 config。
 * @returns 冻结的完整配置。
 */
export function readConfig(raw) {
  const value = isRecord(raw) ? raw : {};
  const hasProvider = typeof value.provider === 'string' && value.provider.length > 0;
  const hasModel = typeof value.model === 'string' && value.model.length > 0;
  if (hasProvider !== hasModel) throw new Error('session-title-context: provider 与 model 必须成对配置');
  if (value.cadence !== undefined && value.cadence !== 'all-prompts' && value.cadence !== 'first-prompt') {
    throw new Error('session-title-context: cadence 只能是 "all-prompts" 或 "first-prompt"');
  }
  const timeoutMs = positiveInt(value.timeoutMs, DEFAULT_CONFIG.timeoutMs, 'timeoutMs');
  if (timeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`session-title-context: timeoutMs 不能超过 ${MAX_TIMER_DELAY_MS}`);
  return Object.freeze({
    cadence: value.cadence === 'first-prompt' ? 'first-prompt' : DEFAULT_CONFIG.cadence,
    targetWords: positiveInt(value.targetWords, DEFAULT_CONFIG.targetWords, 'targetWords'),
    targetCjkCharacters: positiveInt(value.targetCjkCharacters, DEFAULT_CONFIG.targetCjkCharacters, 'targetCjkCharacters'),
    maxInputBytes: positiveInt(value.maxInputBytes, DEFAULT_CONFIG.maxInputBytes, 'maxInputBytes'),
    maxOutputTokens: positiveInt(value.maxOutputTokens, DEFAULT_CONFIG.maxOutputTokens, 'maxOutputTokens'),
    timeoutMs,
    toolResultMaxBytes: positiveInt(value.toolResultMaxBytes, DEFAULT_CONFIG.toolResultMaxBytes, 'toolResultMaxBytes'),
    includeSystemPrompt: value.includeSystemPrompt === true,
    includeInjectedContext: value.includeInjectedContext === true,
    logRequests: value.logRequests === true,
    textFallback: value.textFallback !== false,
    instructions: typeof value.instructions === 'string' ? value.instructions.trim() : '',
    reasoningEffort: typeof value.reasoningEffort === 'string' && value.reasoningEffort.length > 0 ? value.reasoningEffort : undefined,
    provider: hasProvider ? value.provider : undefined,
    model: hasModel ? value.model : undefined,
  });
}

/** 图片占位文本：保留文件名与尺寸，绝不带图片字节。 */
function imagePlaceholder(attachment) {
  if (!isRecord(attachment)) return '[图片已省略]';
  const name = typeof attachment.name === 'string' && attachment.name.length > 0 ? ` ${attachment.name}` : '';
  const size = Number.isFinite(attachment.width) && Number.isFinite(attachment.height) ? ` ${attachment.width}x${attachment.height}` : '';
  return `[图片已省略:${name}${size}]`;
}

/** 文件占位文本。 */
function filePlaceholder(attachment) {
  if (!isRecord(attachment)) return '[文件已省略]';
  const name = typeof attachment.name === 'string' && attachment.name.length > 0 ? ` ${attachment.name}` : '';
  return `[文件已省略:${name}]`;
}

/**
 * 工具结果消息在两个协议代里的形态不同：
 *   · 0.1：\`role:'user'\` 消息里一枚 \`tool-result\` 包装块，callId/isError 在块内；
 *   · 0.2：一等 \`role:'tool'\` 消息，callId/isError 在消息顶层，内容是普通块。
 * 本文件内部（配对、去图片、截断、预算收缩）只认包装块这一种形态，所以在入口
 * 归一、在出口还原成当前代的原生形态。0.1 上两个函数都是恒等变换，行为逐字节不变。
 */
const TOOL_MESSAGES_ARE_FIRST_CLASS = (() => {
  try {
    return createToolResultMessage({ callId: 'probe', content: [], isError: false }).role === 'tool';
  } catch {
    return false;
  }
})();

/** 把当前代的原生工具结果消息折叠成内部统一形态；旧代或非工具结果原样返回。 */
function foldToolResult(message) {
  if (!TOOL_MESSAGES_ARE_FIRST_CLASS) return message;
  if (message === undefined || message === null || message.role !== 'tool') return message;
  if (typeof message.toolCallId !== 'string') return message;
  return {
    ...message,
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: message.toolCallId,
      content: Array.isArray(message.content) ? message.content : [],
      ...(message.isError === true ? { isError: true } : {}),
    }],
  };
}

/** 把内部统一形态还原成当前代的原生工具结果消息；旧代或非工具结果原样返回。 */
function unfoldToolResult(message) {
  if (!TOOL_MESSAGES_ARE_FIRST_CLASS) return message;
  if (message === undefined || message === null) return message;
  const source = message.source;
  const blocks = message.content;
  if (source === undefined || source === null || source.kind !== 'tool') return message;
  if (!Array.isArray(blocks) || blocks.length !== 1) return message;
  const block = blocks[0];
  if (!isRecord(block) || block.type !== 'tool-result') return message;
  const next = {
    ...message,
    role: 'tool',
    toolCallId: typeof block.toolCallId === 'string' ? block.toolCallId : '',
    content: Array.isArray(block.content) ? block.content : [],
    isError: block.isError === true,
  };
  return next;
}

/** 单个文本块的截断（工具结果用）。 */
function truncateText(text, maxBytes, stats) {
  if (byteLength(text) <= maxBytes) return text;
  let used = 0;
  let output = '';
  for (const character of text) {
    const bytes = byteLength(character);
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  stats.truncatedResults += 1;
  return `${output}…[已截断]`;
}

/**
 * 把一条消息的内容块净化为“可安全送给标题模型”的形式。
 * 返回全新的普通对象（后续预算收缩会就地改写它们）。
 */
function sanitizeBlocks(blocks, config, stats) {
  const out = [];
  if (!Array.isArray(blocks)) return out;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    switch (block.type) {
      case 'text': {
        const text = typeof block.text === 'string' ? block.text : '';
        if (text.trim().length === 0) break;
        out.push({ type: 'text', text });
        break;
      }
      case 'reasoning':
        stats.reasoning += 1;
        break;
      case 'image':
        stats.images += 1;
        out.push({ type: 'text', text: imagePlaceholder(block.attachment) });
        break;
      case 'file':
        stats.files += 1;
        out.push({ type: 'text', text: filePlaceholder(block.attachment) });
        break;
      case 'tool-call':
        out.push({
          type: 'tool-call',
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          arguments: typeof block.arguments === 'string' ? block.arguments : '',
        });
        break;
      case 'tool-result': {
        stats.toolResults += 1;
        const content = sanitizeBlocks(block.content, config, stats).map((inner) => (
          inner.type === 'text' ? { type: 'text', text: truncateText(inner.text, config.toolResultMaxBytes, stats) } : inner
        ));
        if (content.length === 0) content.push({ type: 'text', text: '(无输出)' });
        out.push({
          type: 'tool-result',
          toolCallId: typeof block.toolCallId === 'string' ? block.toolCallId : '',
          content,
          ...(block.isError === true ? { isError: true } : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** 预算估算：按 JSON 落地形态量每个消息。 */
function measureEntries(entries) {
  let total = 0;
  for (const entry of entries) total += byteLength(JSON.stringify(entry.message)) + 8;
  return total;
}

/** 省略标记消息（不是会话事件，只是提示模型中间被裁掉了）。 */
function omissionMessage(count) {
  return {
    seq: -1,
    message: {
      id: OMIT_ID,
      role: 'user',
      source: { kind: 'plugin', plugin: PROVIDER_ID },
      content: [{ type: 'text', text: `[为控制长度，前面 ${count} 条消息已省略]` }],
    },
  };
}

/** 找到最大的可收缩文本块（含 tool-result 内部块），返回其容器。 */
function largestTextHolder(entries) {
  let best;
  let bestLength = -1;
  for (const entry of entries) {
    for (const block of entry.message.content) {
      const holders = block.type === 'tool-result' ? block.content : [block];
      for (const holder of holders) {
        if (holder.type !== 'text' || typeof holder.text !== 'string') continue;
        if (holder.text.length > bestLength) {
          best = holder;
          bestLength = holder.text.length;
        }
      }
    }
  }
  return best;
}

/**
 * 预算收缩：先丢中间最老的消息（保留首条与最近若干条），
 * 仍超预算就把最长的文本块折半，最后再丢消息。
 * @returns 收缩后的条目与丢弃计数。
 */
function fitBudget(entries, budgetBytes, stats) {
  if (measureEntries(entries) <= budgetBytes) return { entries, dropped: 0 };
  const kept = entries.slice();
  let dropped = 0;
  const withNote = () => (dropped === 0 ? kept : [kept[0], omissionMessage(dropped), ...kept.slice(1)]);
  while (kept.length > 2 && measureEntries(withNote()) > budgetBytes) {
    kept.splice(1, 1);
    dropped += 1;
  }
  let guard = 0;
  while (measureEntries(withNote()) > budgetBytes && guard < 64) {
    const holder = largestTextHolder(kept);
    if (holder === undefined || holder.text.length <= 64) break;
    holder.text = `${holder.text.slice(0, Math.floor(holder.text.length / 2))}…`;
    guard += 1;
  }
  while (kept.length > 2 && measureEntries(withNote()) > budgetBytes) {
    kept.splice(1, 1);
    dropped += 1;
  }
  stats.budgetDropped = dropped;
  const result = withNote();
  if (measureEntries(result) > budgetBytes) {
    throw new Error(`session-title-context: 无法把标题上下文压进 maxInputBytes=${budgetBytes} 字节`);
  }
  return { entries: result, dropped };
}

/**
 * 取会话的“完整上下文（去图片、去 reasoning、去未完成消息）”。
 *
 * 顺序来自 `session.surface.nodes`（与 `Session.deriveMessages()` 同一套
 * 投影规则），因此 compaction 的 replace 会被正确遵守；每条消息都带着
 * 自己的事件 seq，供结果回填 `messageSeqs`。
 *
 * @param session - 服务传入的活会话。
 * @param options - throughSeq（修订上界）、config、reservedBytes（信封预留）。
 * @returns 净化后的消息、其中 human 消息的 seq、统计信息。
 */
export function buildTitleContext(session, options) {
  const config = options.config;
  const throughSeq = options.throughSeq;
  const reservedBytes = typeof options.reservedBytes === 'number' ? options.reservedBytes : 0;

  /** 采一遍可见面（`limit` 之内），返回已配对、已去头的条目与当轮统计。 */
  const collect = (limit) => {
    const stats = {
      events: 0,
      kept: 0,
      images: 0,
      files: 0,
      reasoning: 0,
      toolResults: 0,
      truncatedResults: 0,
      interrupted: 0,
      systemDropped: 0,
      injectedDropped: 0,
      orphanCalls: 0,
      orphanResults: 0,
      budgetDropped: 0,
      wholeSurface: false,
    };
    const surface = session.surface;
    const nodes = surface === undefined || surface === null ? [] : surface.nodes;
    const collected = [];
    for (const seq of nodes ?? []) {
      if (typeof seq !== 'number' || seq > limit) continue;
      const event = session.eventAt(seq);
      if (event === undefined || event === null) continue;
      stats.events += 1;
      if (event.type === 'assistant/message' && event.data !== null && event.data !== undefined && event.data.interrupted === true) {
        stats.interrupted += 1;
        continue;
      }
      const message = foldToolResult(session.deriveEventMessage(event));
      if (message === undefined || message === null) continue;
      if (message.role === 'system' && config.includeSystemPrompt !== true) {
        stats.systemDropped += 1;
        continue;
      }
      // 注入行（AGENTS.md 等说明文件、技能目录、运行时快照）对标题零信息量，
      // 却能有几十 KB：默认丢掉，避免把真正的对话挤出预算。
      if (config.includeInjectedContext !== true && isInjectedContext(message.source)) {
        stats.injectedDropped += 1;
        continue;
      }
      const blocks = sanitizeBlocks(message.content, config, stats);
      if (blocks.length === 0) continue;
      collected.push({ seq, message: { ...message, content: blocks } });
    }

    // 工具调用 / 结果配对清理：孤儿块会让严格 provider 直接 400。
    const callIds = new Set();
    const resultIds = new Set();
    for (const entry of collected) {
      for (const block of entry.message.content) {
        if (block.type === 'tool-call') callIds.add(block.id);
        else if (block.type === 'tool-result') resultIds.add(block.toolCallId);
      }
    }
    const paired = [];
    for (const entry of collected) {
      const blocks = entry.message.content.filter((block) => {
        if (block.type === 'tool-call' && !resultIds.has(block.id)) {
          stats.orphanCalls += 1;
          return false;
        }
        if (block.type === 'tool-result' && !callIds.has(block.toolCallId)) {
          stats.orphanResults += 1;
          return false;
        }
        return true;
      });
      if (blocks.length === 0) continue;
      paired.push({ seq: entry.seq, message: blocks.length === entry.message.content.length ? entry.message : { ...entry.message, content: blocks } });
    }

    // 首条必须是 user 文本消息：开头残留的 assistant / tool 消息会被 provider 拒绝。
    while (paired.length > 0) {
      const first = paired[0].message;
      if (first.role === 'user' && first.source !== undefined && first.source.kind !== 'tool') break;
      paired.shift();
    }
    return { paired, stats };
  };

  let attempt = collect(throughSeq);
  // 修订上界可能已被 compaction 的 replace 遮蔽（压实之后，上界之前的节点都不在
  // 可见面里，人工 /title 重算必然踩到）。此时退回“当前可见面全量”——那正是
  // harness 此刻真正发给模型的那份上下文（含压实摘要）。
  if (attempt.paired.length === 0 && Number.isFinite(throughSeq)) {
    const whole = collect(Number.POSITIVE_INFINITY);
    if (whole.paired.length > 0) {
      whole.stats.wholeSurface = true;
      attempt = whole;
    }
  }

  const budgetBytes = Math.max(1024, config.maxInputBytes - reservedBytes);
  const fitted = fitBudget(attempt.paired, budgetBytes, attempt.stats);
  const entries = fitted.entries;
  const messages = entries.map((entry) => unfoldToolResult(entry.message));
  const seqs = entries
    .filter((entry) => entry.seq >= 0 && entry.message.source !== undefined && entry.message.source.kind === 'user')
    .map((entry) => entry.seq);
  attempt.stats.kept = entries.length;
  return { messages, seqs, stats: attempt.stats };
}

/**
 * 判断一条消息是不是 harness 注入的“说明性上下文行”。
 * 这些行的 source 带 `form`（instructions / catalog / snapshot / notice）；
 * compaction 摘要是 `plugin: 'compact'` 且不带 `form`，必须保留。
 * @param source - 消息来源。
 * @returns 属于注入行时为 true。
 */
function isInjectedContext(source) {
  if (source === undefined || source === null) return false;
  const form = source.form;
  return form === 'instructions' || form === 'catalog' || form === 'snapshot';
}

/** 解析模型返回的工具参数 JSON。 */
function parseJsonObject(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 清洗候选标题：只留一行纯文本，去掉代码围栏、引号与“标题：”前缀。
 * @param raw - 模型给的原始文本。
 * @returns 清洗后的标题（可能为空串）。
 */
export function cleanTitleText(raw) {
  let text = String(raw);
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return '';
  const cleaned = lines.map((line) => {
    let current = line;
    // 代码围栏 / 包裹引号 / “标题：”前缀可能互相嵌套，反复剥几轮直到稳定。
    for (let round = 0; round < 3; round += 1) {
      const next = current
        .replace(/^```[A-Za-z0-9_-]*\s*/, '')
        .replace(/```$/, '')
        .replace(/^["'`“”‘’【《]+/, '')
        .replace(/["'`“”‘’】》]+$/, '')
        .replace(/^(?:title|session title|标题|会话标题)\s*[:：]\s*/i, '')
        .trim();
      if (next === current) break;
      current = next;
    }
    return current.replace(/\s+/g, ' ').trim();
  });
  const preamble = /^(?:sure|here(?:'s| is)|the title is|of course|当然|好的|这是|以下是|标题为)/i;
  const body = cleaned.find((line) => line.length > 0 && !preamble.test(line));
  return (body ?? cleaned[0] ?? '').replace(/[。.]+$/, '').trim();
}

/**
 * 从模型回复块里取标题：**优先 tool-call**，文本仅作兜底。
 * reasoning 块永远不参与（推理内容不是标题）。
 * @param blocks - BlockAssembler 的 blocks()。
 * @returns `{ title, via }`，取不到时为 undefined。
 */
export function titleFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== 'tool-call' || block.name !== TITLE_TOOL_NAME) continue;
    const args = parseJsonObject(block.arguments);
    const value = args === undefined ? undefined : args.title;
    if (typeof value === 'string') {
      const title = cleanTitleText(value);
      if (title.length > 0) return { title, via: 'tool-call' };
    }
  }
  const texts = blocks.filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0);
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const title = cleanTitleText(texts[index].text);
    if (title.length > 0) return { title, via: 'text' };
  }
  return undefined;
}

/** 系统指令。 */
function buildSystemPrompt(config) {
  const lines = [
    '你是 DeepSeek Harness 编程会话的标题生成器：为下面给出的完整会话上下文起一个简短标题。',
    `必须调用 ${TITLE_TOOL_NAME} 工具一次，把标题写进它的 title 参数；不要在普通文本里输出标题，也不要输出解释、思考过程、Markdown 或代码块。`,
    '标题是一行纯文本，使用会话本身的主要语言（中文会话用中文，英文会话用英文）；不要引号、不要句尾句号、不要“标题：”之类前缀、不要表情符号。',
    `长度：非中日韩语言约 ${config.targetWords} 个词；中日韩语言约 ${config.targetCjkCharacters} 个字符。`,
    '上下文里的图片与文件已省略（用占位文本标记），不要提及它们，也不要提及省略这件事。',
  ];
  if (config.instructions.length > 0) lines.push(config.instructions);
  return lines.join('\n');
}

/** 收尾指令消息（带稳定 id，便于日志调试）。 */
function buildInstructionMessage() {
  return {
    id: INSTRUCTION_ID,
    role: 'user',
    source: { kind: 'plugin', plugin: PROVIDER_ID },
    content: [{ type: 'text', text: INSTRUCTION_TEXT }],
  };
}

/** 信封预留：系统指令 + 工具 schema + 收尾消息 + 结构开销。 */
function envelopeBytes(system) {
  return byteLength(system) + byteLength(JSON.stringify([TITLE_TOOL])) + byteLength(INSTRUCTION_TEXT) + 512;
}

/** 决定这次生成用哪条路由：一次性指定 > 配置固定 > 当前会话路由。 */
function resolveRoute(config, requestRoute, override) {
  if (override !== undefined) {
    const provider = override.provider;
    const model = override.model;
    if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) return { provider, model };
    throw new Error('session-title-context: 一次性模型指定非法');
  }
  if (config.provider !== undefined && config.model !== undefined) return { provider: config.provider, model: config.model };
  if (isRecord(requestRoute) && typeof requestRoute.provider === 'string' && typeof requestRoute.model === 'string') {
    return { provider: requestRoute.provider, model: requestRoute.model };
  }
  throw new Error('session-title-context: 当前会话还没有模型路由（也没有配置 provider/model）');
}

/** 取消时抛出取消原因。 */
function abortError(signal) {
  const reason = signal === undefined ? undefined : signal.reason;
  return reason instanceof Error ? reason : new Error('session-title-context: 标题生成已取消');
}

/** 发一次标题请求并组装回复块。 */
async function dispatch(ctx, config, params) {
  const options = {
    provider: params.route.provider,
    model: params.route.model,
    messages: params.messages,
    system: params.system,
    maxTokens: config.maxOutputTokens,
    sessionId: params.session.id,
    // purpose 让这次调用被识别为辅助请求：官方 DeepSeek 适配器据此关闭思考，
    // 会话池 / 子代理链也不会把它计入会话用量。
    purpose: 'session-title',
    signal: params.signal,
    ...(params.useTools ? { tools: [TITLE_TOOL] } : {}),
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  };
  const assembler = new BlockAssembler();
  for await (const chunk of ctx.llm.stream(options)) {
    if (params.signal.aborted) break;
    assembler.push(chunk);
  }
  if (params.signal.aborted) throw abortError(params.signal);
  const finish = assembler.finish;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const failure = finish.failure;
    const error = new Error(failure === undefined ? '标题请求失败' : failure.message);
    if (failure !== undefined && typeof failure.code === 'string') error.code = failure.code;
    throw error;
  }
  if (finish.kind === 'max-tokens') {
    throw new Error(`session-title-context: 标题请求在 ${config.maxOutputTokens} 个输出 token 内没有给出标题`);
  }
  return assembler.blocks();
}

/** 取走并按有效期检查一次性模型指定（同步读，避免被陈旧的修订消费）。 */
function consumeOverride(overrides, sessionId) {
  const entry = overrides === undefined ? undefined : overrides.get(sessionId);
  if (entry === undefined) return undefined;
  overrides.delete(sessionId);
  if (Date.now() - entry.at > OVERRIDE_TTL_MS) return undefined;
  return { provider: entry.provider, model: entry.model };
}

/**
 * UI 用的生成状态（进程内存、按会话 id）：最近一次成功结果、最近一次失败、
 * 以及是否正在生成。自动生成与手动生成都记，所以标题栏按钮能显示后台进度。
 * 纯观测数据，丢进程即丢，不进会话日志。
 * @returns `{begin, finish, fail, view}`。
 */
function createTitleTelemetry() {
  const last = new Map();
  const failure = new Map();
  const inflight = new Set();
  return {
    begin(sessionId) {
      inflight.add(sessionId);
    },
    finish(sessionId, info) {
      inflight.delete(sessionId);
      failure.delete(sessionId);
      last.set(sessionId, info);
    },
    fail(sessionId, error) {
      inflight.delete(sessionId);
      failure.set(sessionId, { message: messageOf(error), at: Date.now() });
    },
    view(sessionId) {
      return {
        last: last.get(sessionId),
        failure: failure.get(sessionId),
        inflight: inflight.has(sessionId),
      };
    },
  };
}

/**
 * 构造标题提供者（纯函数形态，便于自测直接驱动）。
 * @param options - `{ ctx, config, overrides, telemetry }`。
 * @returns `ctx.sessionTitle.register()` 的提供者对象。
 */
export function createTitleProvider(options) {
  const ctx = options.ctx;
  const config = options.config;
  const overrides = options.overrides;
  const telemetry = options.telemetry;
  return {
    id: PROVIDER_ID,
    automatic: config.cadence,
    async generate(request) {
      request.signal.throwIfAborted();
      const session = request.session;
      const startedAt = Date.now();
      // 自动生成与手动生成都会经过这里：UI 靠这份进程内状态显示
      // 「正在生成 / 上次结果 / 上次失败」，任何抛错路径都要清掉在跑标记。
      telemetry?.begin(session.id);
      try {
        const outcome = await run();
        telemetry?.finish(session.id, { ...outcome.info, ms: Date.now() - startedAt, at: Date.now() });
        return outcome.result;
      } catch (error) {
        telemetry?.fail(session.id, error);
        throw error;
      }

      /** 真正的生成流程（拆成内部函数，只为让上面的 telemetry 包住全部抛错路径）。 */
      async function run() {
        const humanSeqs = Array.isArray(request.messages) ? request.messages.map((message) => message.seq) : [];
        // 修订上界 = 本次修订最后一条 human 消息：之后生成的消息（正在流式输出的
        // assistant 回复、正在执行的工具结果）一律不进上下文。
        const boundary = humanSeqs.length > 0 ? humanSeqs[humanSeqs.length - 1] : Math.max(0, session.seq - 1);
        const route = resolveRoute(config, request.route, consumeOverride(overrides, session.id));
        const system = buildSystemPrompt(config);
        const context = buildTitleContext(session, {
          throughSeq: boundary,
          config,
          reservedBytes: envelopeBytes(system),
        });
        if (context.messages.length === 0) throw new Error('session-title-context: 会话里没有可用的文本上下文');
        const messages = [...context.messages, buildInstructionMessage()];
        // 服务要求 messageSeqs 非空、递增，且必须取自本次 request.messages。
        // 正常路径下，上界以内的 human 消息必然都在 request.messages 里；但
        // 上界被 compaction 遮蔽时走的是“全量可见面”，面里可能混着之后修订的
        // human 消息（不在本次 request.messages 里），必须先求交。可见面一条
        // human 都没有时，退回本次修订覆盖的那几条 human 消息——它们的内容正
        // 存活在压实摘要里。
        const requestHumanSeqs = new Set(humanSeqs);
        const visibleHumanSeqs = context.seqs.filter((seq) => requestHumanSeqs.has(seq));
        const messageSeqs = visibleHumanSeqs.length > 0 ? visibleHumanSeqs : humanSeqs;
        if (messageSeqs.length === 0) throw new Error('session-title-context: 会话里还没有人类消息，无法生成标题');
        if (config.logRequests) {
          // 复用出厂已声明的事件类型，便于排查这一次请求到底发了什么。
          session.append('session/title-llm-request', {
            titleProvider: PROVIDER_ID,
            messageSeqs,
            route,
            system,
            messages,
            maxTokens: config.maxOutputTokens,
            // 只记工具名，不记整份 schema：够看清「这次确实开了工具通道」。
            tools: [TITLE_TOOL_NAME],
          });
        }
        const callDeadline = deadline(request.signal, config.timeoutMs, TIMEOUT_CODE);
        let blocks;
        try {
          try {
            blocks = await dispatch(ctx, config, { session, route, messages, system, signal: callDeadline.signal, useTools: true });
          } catch (error) {
            if (config.textFallback !== true || callDeadline.signal.aborted) throw error;
            ctx.logger.warn(`session-title-context: 工具调用方式失败，改用文本兜底：${messageOf(error)}`);
            blocks = await dispatch(ctx, config, { session, route, messages, system, signal: callDeadline.signal, useTools: false });
          }
        } finally {
          callDeadline[Symbol.dispose]();
        }
        const picked = titleFromBlocks(blocks);
        if (picked === undefined) throw new Error('session-title-context: 模型没有通过 submit_session_title 给出标题');
        ctx.logger.info(`session-title-context: 标题已生成（via=${picked.via}, ${route.provider}/${route.model}, ${context.stats.kept} 条上下文, 丢弃图片 ${context.stats.images}${context.stats.wholeSurface ? ', 上界被压实遮蔽→用当前可见面' : ''}）`);
        return {
          result: { title: picked.title, messageSeqs, model: route },
          info: { title: picked.title, provider: route.provider, model: route.model, via: picked.via },
        };
      }
    },
  };
}

/**
 * 注册提供者；live patch 重载时旧注册的异步卸载可能还未结束，按固定间隔重试。
 */
function registerProvider(ctx, config, overrides, telemetry) {
  const provider = createTitleProvider({ ctx, config, overrides, telemetry });
  let disposeRegistration;
  let attempts = 0;
  let timer;
  let cancelled = false;
  ctx.effect(() => () => {
    cancelled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const dispose = disposeRegistration;
    disposeRegistration = undefined;
    // 返回服务的卸载 promise，让组合行重载能等到位（重试只是兜底）。
    return dispose === undefined ? undefined : dispose();
  }, 'session-title-context registration');
  const attempt = () => {
    if (cancelled) return;
    try {
      disposeRegistration = ctx.sessionTitle.register(provider);
      ctx.logger.info(`session-title-context: 标题提供者已注册（cadence=${provider.automatic}）`);
    } catch (error) {
      attempts += 1;
      if (attempts >= REGISTER_MAX_ATTEMPTS) {
        ctx.logger.error(`session-title-context: 注册标题提供者失败：${messageOf(error)}（请确认组合行 session-title-llm 已 disabled）`);
        return;
      }
      timer = setTimeout(attempt, REGISTER_RETRY_DELAY_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
  };
  attempt();
}

/** 把一段字符串按 provider 优先解析成路由；空串＝沿用当前会话模型。 */
async function parseRouteSpec(ctx, raw) {
  const text = raw.trim();
  if (text.length === 0) return undefined;
  let providers = [];
  try {
    providers = ctx.llm.listProviders().map((info) => info.id);
  } catch {
    providers = [];
  }
  if (text.includes('/')) {
    const head = text.slice(0, text.indexOf('/'));
    if (providers.includes(head)) return { provider: head, model: text.slice(head.length + 1).trim() };
  }
  const parts = text.split(/\s+/);
  if (parts.length >= 2 && providers.includes(parts[0])) {
    return { provider: parts[0], model: parts.slice(1).join(' ').trim() };
  }
  const matches = [];
  for (const provider of providers) {
    try {
      const models = await ctx.llm.listModels(provider);
      if (models.some((model) => model.id === text)) matches.push({ provider, model: text });
    } catch {
      // 某条路由列不出模型不影响其它路由。
    }
  }
  if (matches.length === 0) throw new Error(`没找到模型 "${text}"；用 /title list 看可用列表，或用 <provider>/<model> 显式指定`);
  if (matches.length > 1) {
    const options = matches.map((match) => `${match.provider}/${match.model}`).join('、');
    throw new Error(`模型 "${text}" 出现在多条路由里：${options}；请显式写 <provider>/<model>`);
  }
  return matches[0];
}

/** 渲染可用路由目录（`/title list`）。 */
async function renderRouteCatalog(ctx) {
  let providers = [];
  try {
    providers = ctx.llm.listProviders();
  } catch (error) {
    return `读取模型路由失败：${messageOf(error)}`;
  }
  if (providers.length === 0) return '当前没有可用的模型路由';
  const lines = [];
  for (const info of providers) {
    let models = [];
    try {
      models = await ctx.llm.listModels(info.id);
    } catch {
      models = [];
    }
    const suffix = info.name === undefined || info.name === info.id ? '' : `（${info.name}）`;
    lines.push(`${info.id}${suffix}: ${models.map((model) => model.id).join(', ') || '—'}`);
  }
  return `可用 provider/模型：\n${lines.join('\n')}`;
}

/** `/title` 命令处理：可选一次性模型 → 显式 refresh。 */
async function runTitleCommand(ctx, config, overrides, invocation) {
  const agent = invocation.agent;
  const session = agent === undefined || agent === null ? undefined : agent.session;
  if (session === undefined || session === null) return { kind: 'error', text: '当前会话不支持标题生成（拿不到会话）' };
  const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : '';
  if (raw === 'list' || raw === 'models' || raw === 'ls') return { kind: 'success', text: await renderRouteCatalog(ctx) };
  let override;
  try {
    override = await parseRouteSpec(ctx, raw);
  } catch (error) {
    return { kind: 'error', text: messageOf(error) };
  }
  const entry = override === undefined ? undefined : { provider: override.provider, model: override.model, at: Date.now() };
  if (entry !== undefined) overrides.set(session.id, entry);
  try {
    const snapshot = await ctx.sessionTitle.refresh(session, invocation.signal);
    if (snapshot === undefined) return { kind: 'error', text: '会话里还没有可参与标题生成的文本内容' };
    const used = snapshot.source === undefined ? undefined : snapshot.source.model;
    const route = used === undefined ? '' : `（${used.provider}/${used.model}）`;
    return { kind: 'success', text: `会话标题已更新${route}：${snapshot.title}` };
  } catch (error) {
    return { kind: 'error', text: `标题生成失败：${messageOf(error)}` };
  } finally {
    if (entry !== undefined && overrides.get(session.id) === entry) overrides.delete(session.id);
  }
}

/**
 * 标题栏 UI（client 半边）用的同源 HTTP 接口：
 *   GET  `${ROUTE_PREFIX}/state?sessionId=` → 当前标题、上次结果/失败、是否在跑；
 *   GET  `${ROUTE_PREFIX}/models`           → 供「一次性指定模型」用的路由目录；
 *   POST `${ROUTE_PREFIX}/generate`         → `{sessionId, provider?, model?}`，
 *        带 provider/model 时按一次性模型生成（与 `/title <provider>/<model>` 同义）。
 * 全部要求同源；会话只认运行中的活会话（`ctx.sessions.get`）。
 * @param scope - 已就绪 webServer 的子作用域（路由挂它，随组合行卸载）。
 * @param ctx - 插件上下文（读 sessions / sessionTitle / llm）。
 * @param config - 归一化配置。
 * @param overrides - 与 `/title` 命令共用的「一次性模型」表。
 * @param telemetry - 生成状态表。
 */
function registerUiRoutes(scope, ctx, config, overrides, telemetry) {
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const ok = (res, value) => json(res, 200, { ok: true, ...value });
  const bad = (res, status, error) => json(res, status, { ok: false, error: messageOf(error) });
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 65536) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
  const sessionOf = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('需要 sessionId');
    const session = ctx.sessions.get(sessionId);
    if (session === undefined) throw new Error(`会话 ${sessionId} 不在运行中`);
    return session;
  };
  const pinned = config.provider === undefined || config.model === undefined
    ? null
    : { provider: config.provider, model: config.model };
  const stateOf = (sessionId) => {
    const session = sessionOf(sessionId);
    const current = ctx.sessionTitle.get(session);
    const view = telemetry.view(sessionId);
    return {
      sessionId,
      cadence: config.cadence,
      pinned,
      tool: TITLE_TOOL_NAME,
      textFallback: config.textFallback !== false,
      timeoutMs: config.timeoutMs,
      current: current === undefined ? null : { title: current.title, source: current.source ?? null },
      last: view.last ?? null,
      failure: view.failure ?? null,
      inflight: view.inflight,
    };
  };
  const catalogOf = async () => {
    const providers = [];
    for (const info of ctx.llm.listProviders()) {
      let models = [];
      try {
        models = await ctx.llm.listModels(info.id);
      } catch {
        models = [];
      }
      providers.push({
        id: info.id,
        name: info.name === undefined || info.name === info.id ? info.id : info.name,
        models: models.map((model) => ({ id: model.id, name: model.name === undefined ? model.id : model.name })),
      });
    }
    return providers;
  };

  scope.effect(() => scope.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/state`,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return bad(res, 405, 'Method Not Allowed');
      if (!sameOrigin(req)) return bad(res, 403, 'cross-origin request rejected');
      const url = new URL(req.url, 'http://localhost');
      try {
        return ok(res, stateOf(url.searchParams.get('sessionId') ?? ''));
      } catch (error) {
        return bad(res, 400, error);
      }
    },
  }), 'session-title-context: state route');

  scope.effect(() => scope.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/models`,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return bad(res, 405, 'Method Not Allowed');
      if (!sameOrigin(req)) return bad(res, 403, 'cross-origin request rejected');
      catalogOf().then(
        (providers) => ok(res, { providers }),
        (error) => bad(res, 500, error),
      );
    },
  }), 'session-title-context: models route');

  scope.effect(() => scope.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/generate`,
    handler: (req, res) => {
      if (req.method !== 'POST') return bad(res, 405, 'Method Not Allowed');
      if (!sameOrigin(req)) return bad(res, 403, 'cross-origin request rejected');
      readBody(req).then(async (text) => {
        let args = {};
        if (text !== '') {
          try {
            args = JSON.parse(text);
          } catch {
            return bad(res, 400, 'body 不是合法 JSON');
          }
        }
        try {
          const session = sessionOf(args.sessionId);
          const provider = typeof args.provider === 'string' ? args.provider.trim() : '';
          const model = typeof args.model === 'string' ? args.model.trim() : '';
          const oneOff = provider === '' || model === '' ? undefined : { provider, model, at: Date.now() };
          if (oneOff !== undefined) overrides.set(session.id, oneOff);
          // 手动触发也要有硬上限：配置超时 + 一点余量，避免请求悬着。
          const signal = AbortSignal.timeout(config.timeoutMs + UI_GENERATE_GRACE_MS);
          try {
            const snapshot = await ctx.sessionTitle.refresh(session, signal);
            if (snapshot === undefined) return bad(res, 409, '会话里还没有可参与标题生成的文本内容');
            return ok(res, { title: snapshot.title, source: snapshot.source ?? null, state: stateOf(session.id) });
          } finally {
            if (oneOff !== undefined && overrides.get(session.id) === oneOff) overrides.delete(session.id);
          }
        } catch (error) {
          return bad(res, 400, error);
        }
      }).catch(() => bad(res, 400, 'body 读取失败'));
    },
  }), 'session-title-context: generate route');
}

/**
 * 插件入口。
 * @param ctx - 组合行上下文。
 * @param rawConfig - 组合行配置。
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig);
  const overrides = new Map();
  const telemetry = createTitleTelemetry();
  registerProvider(ctx, config, overrides, telemetry);
  ctx.inject(['commands'], (scope) => scope.commands.register({
    name: 'title',
    description: '重新生成当前会话标题（默认用当前会话模型，可一次性指定 provider/model）',
    input: { hint: '[<模型> | <provider>/<model> | list]　留空＝当前会话模型' },
    handler: (invocation) => runTitleCommand(ctx, config, overrides, invocation),
  }));
  // 标题栏 UI 的接口；跑在没有 webServer 的 profile 里时只保留上面的命令入口。
  ctx.inject(['webServer'], (scope) => registerUiRoutes(scope, ctx, config, overrides, telemetry));
}
