/**
 * 双智能指导 · 子代理模型链（dg-chain.js）
 *
 * 合并自 dsh-subagent-models（会话级有序候选链：按序使用、用量耗尽或请求失败自动
 * 回退、可选计入整会话供应池）。这里保留它的全部机制，并加两件事：
 *
 *   ① 孵化执行者时**直接用官方 agentOptions**（`SubagentStartRequest.agentOptions
 *      = {provider, model}`，见 @deepseek-ai/dsh-subagent 的 resolveChildAgentOptions）
 *      ——子代理从出生就走选定的模型，不依赖请求期改路由；
 *   ② 请求期改路由（agent/request waterfall）**保留**，作为兜底与统一回退：嵌套
 *      子代理、由 subagent 工具另起的子会话、以及失败后换下一候选，都靠它。
 *
 * 与旧版的一处实质改进：换路由时不再无脑丢掉 reasoningEffort。改路由前先问一次
 * `llm.resolveModelInfo(provider, model)`，目标模型支持这档思考强度就带上，不支持
 * 就丢掉（丢掉正是官方 resolveChildAgentOptions 在 routeChanged 时的做法）。旧版
 * 一律丢，等于悄悄改了执行者的推理档位。
 *
 * 生效范围：`gate(rootSessionId)` 为真才动路由——门由 index.js 的总开关（双智能指导
 * 是否使能）决定；总开关关掉时子代理照旧沿用父会话模型，与没装本插件一致。
 *
 * 计量与池联动：ctx.provide('subagentModels') 的 `billingRedirect` 必须继续存在，
 * 否则 dsh-model-pool 的子代理用量重定向会静默失效（它是 ctx.get('subagentModels')
 * 的既有消费者）。
 *
 * @module dsh-dual-agent/dg-chain
 */

const MAX_CANDIDATES = 8;
const CATALOG_TTL_MS = 30_000;
const MODEL_INFO_TTL_MS = 300_000;

const isPositiveInt = (value) => typeof value === 'number' && Number.isInteger(value) && value > 0;

const candidateExhausted = (candidate) => {
  if (candidate.failed === true) return true;
  if (candidate.limit === null) return false;
  if (candidate.limit.kind === 'requests') return candidate.used.requests >= candidate.limit.value;
  return candidate.used.tokens >= candidate.limit.value;
};

/** 第一个还有预算的候选下标；全部用完回 -1。 */
const activeIndex = (chain) => {
  for (let index = 0; index < chain.candidates.length; index += 1) {
    if (!candidateExhausted(chain.candidates[index])) return index;
  }
  return -1;
};

const mixedTokenTotal = (usage) => {
  if (usage === undefined || usage === null) return 0;
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) return usage.totalTokens;
  let total = 0;
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value)) total += value;
  }
  return total;
};

/**
 * @param ctx 插件根作用域
 * @param deps {
 *   gate(rootSessionId): boolean          // 总开关（该会话的指导是否使能）
 *   persist(): void                       // 链变更后的落盘时机（由 index.js 提供）
 *   restore(): Array<{sessionId, chain}>  // 启动时读回的持久化链（计数已清）
 *   log?(level, text)
 * }
 */
export function attachChain(ctx, deps = {}) {
  const chains = new Map(); // rootSessionId -> { candidates, countAuxiliary, countTowardPool }
  const gate = typeof deps.gate === 'function' ? deps.gate : () => true;

  const agentsOf = () => { try { return ctx.get('agents'); } catch { return undefined; } };
  const llmOf = () => { try { return ctx.get('llm'); } catch { return undefined; } };

  // ── 血缘：子代理会话 → 根会话 ──────────────────────────────────────────────
  /** 沿 session.header.parentSession 上溯到根会话；非子代理回 isSubagent:false。 */
  const lineageOf = (session) => {
    if (session === undefined || session === null) return { rootId: undefined, isSubagent: false };
    let current = session;
    let isSubagent = false;
    for (let hops = 0; hops < 32; hops += 1) {
      const parentId = current?.header?.parentSession;
      if (typeof parentId !== 'string' || parentId === '') break;
      isSubagent = true;
      const directory = agentsOf();
      const parentAgent = directory === undefined ? undefined : directory.get(parentId);
      if (parentAgent === undefined || parentAgent === null) return { rootId: current?.id, isSubagent };
      current = parentAgent.session;
    }
    return { rootId: current?.id, isSubagent };
  };

  /** 命中「已配置 + 门开着」的链；否则 undefined（完全放行）。 */
  const chainOf = (session) => {
    const { rootId, isSubagent } = lineageOf(session);
    if (isSubagent !== true || rootId === undefined) return undefined;
    if (gate(rootId) !== true) return undefined;
    const chain = chains.get(rootId);
    if (chain === undefined) return undefined;
    return { chain, rootId };
  };

  // ── 模型元数据缓存（换路由时判断思考强度是否被支持）────────────────────────
  const modelInfo = new Map(); // "provider:model" -> { at, efforts:Set<string>|null, name }
  const infoOf = async (provider, model) => {
    const key = `${provider}:${model}`;
    const hit = modelInfo.get(key);
    if (hit !== undefined && Date.now() - hit.at < MODEL_INFO_TTL_MS) return hit;
    const llm = llmOf();
    let entry = { at: Date.now(), efforts: null, name: model, contextWindow: undefined };
    if (llm !== undefined && typeof llm.resolveModelInfo === 'function') {
      try {
        const info = await llm.resolveModelInfo(provider, model);
        const efforts = info?.reasoning?.efforts;
        entry = {
          at: Date.now(),
          efforts: Array.isArray(efforts) ? new Set(efforts.map((item) => String(item?.id ?? item))) : null,
          name: typeof info?.name === 'string' ? info.name : model,
          contextWindow: Number.isFinite(info?.context?.contextWindow) ? info.context.contextWindow : undefined,
        };
      } catch { /* 问不到就当作不支持：宁可不带 effort，也不要撞 UNSUPPORTED_* */ }
    }
    modelInfo.set(key, entry);
    return entry;
  };

  const supportsEffort = async (provider, model, effort) => {
    if (effort === undefined || effort === null || effort === '') return true;
    const info = await infoOf(provider, model);
    if (info.efforts === null) return false; // 元数据拿不到 → 不带，交给模型默认档
    return info.efforts.has(String(effort));
  };

  // ── 目录（供二级菜单挑选）──────────────────────────────────────────────────
  let catalog = { at: 0, groups: [], error: null };
  async function refreshCatalog(force = false) {
    if (!force && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog;
    const llm = llmOf();
    if (llm === undefined || typeof llm.listProviders !== 'function') {
      catalog = { at: Date.now(), groups: [], error: 'llm 服务不可用' };
      return catalog;
    }
    const groups = [];
    let error = null;
    let infos = [];
    try { infos = (llm.listProviders() ?? []); } catch (cause) {
      error = `列 provider 失败：${String(cause?.message ?? cause)}`;
    }
    for (const info of infos) {
      const provider = String(info?.id ?? '');
      if (provider === '') continue;
      const displayName = String(info?.name ?? provider);
      try {
        const models = typeof llm.listModels === 'function' ? await llm.listModels(provider) : [];
        groups.push({
          id: provider,
          name: displayName,
          models: (models ?? []).map((model) => ({
            id: String(model?.id ?? ''),
            name: String(model?.name ?? model?.id ?? ''),
            description: typeof model?.description === 'string' ? model.description : undefined,
          })).filter((model) => model.id !== ''),
        });
      } catch (cause) {
        groups.push({ id: provider, name: displayName, models: [], error: String(cause?.message ?? cause) });
      }
    }
    catalog = { at: Date.now(), groups: groups.filter((group) => group.models.length > 0), error };
    return catalog;
  }

  const knownProviders = () => {
    const llm = llmOf();
    const known = [];
    if (llm === undefined) return known;
    try { for (const entry of llm.listProviders() ?? []) known.push(String(entry.id)); } catch { /* 宽容 */ }
    try { for (const entry of llm.listConfigurableProviders?.() ?? []) known.push(String(entry.provider)); } catch { /* 宽容 */ }
    return known;
  };

  // ── 链的读写 ───────────────────────────────────────────────────────────────
  const candidateView = (candidate) => ({
    provider: candidate.provider,
    model: candidate.model,
    unlimited: candidate.limit === null,
    kind: candidate.limit === null ? null : candidate.limit.kind,
    limit: candidate.limit === null ? null : candidate.limit.value,
    used: { requests: candidate.used.requests, tokens: candidate.used.tokens },
    failed: candidate.failed === true,
    exhausted: candidateExhausted(candidate),
  });

  const chainView = (rootId) => {
    const chain = chains.get(rootId);
    if (chain === undefined) {
      return {
        configured: false, sessionId: rootId, countAuxiliary: false, countTowardPool: false,
        activeIndex: -1, exhausted: false, candidates: [],
      };
    }
    const active = activeIndex(chain);
    return {
      configured: true,
      sessionId: rootId,
      countAuxiliary: chain.countAuxiliary === true,
      countTowardPool: chain.countTowardPool === true,
      activeIndex: active,
      exhausted: active < 0,
      candidates: chain.candidates.map(candidateView),
    };
  };

  /** 校验 + 归一化候选数组（旧版语义原样保留，包括 provider 必须已注册）。 */
  function normalizeCandidates(raw) {
    if (!Array.isArray(raw)) throw new Error('candidates 必须是数组');
    if (raw.length === 0) throw new Error('子代理模型链至少需要一个候选');
    if (raw.length > MAX_CANDIDATES) throw new Error(`子代理模型链最多支持 ${MAX_CANDIDATES} 个候选`);
    const known = knownProviders();
    return raw.map((entry, index) => {
      const at = `candidates[${index}]`;
      if (entry === null || typeof entry !== 'object') throw new Error(`${at} 必须是对象`);
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
      const model = typeof entry.model === 'string' ? entry.model.trim() : '';
      if (provider === '') throw new Error(`${at}.provider 不能为空`);
      if (model === '') throw new Error(`${at}.model 不能为空`);
      if (known.length > 0 && !known.includes(provider)) throw new Error(`${at}.provider "${provider}" 未注册；可用：${known.join(', ')}`);
      let limit = null;
      if (entry.limit !== undefined && entry.limit !== null) {
        const kind = entry.limit.kind;
        if (kind !== 'requests' && kind !== 'tokens') throw new Error(`${at}.limit.kind 必须是 requests 或 tokens（或省略 limit 表示不限）`);
        if (!isPositiveInt(entry.limit.value)) throw new Error(`${at}.limit.value 必须是正整数`);
        limit = { kind, value: entry.limit.value };
      }
      return { provider, model, limit, used: { requests: 0, tokens: 0 }, failed: false };
    });
  }

  const setChain = (rootId, candidates, flags = {}) => {
    chains.set(rootId, {
      candidates: normalizeCandidates(candidates),
      countAuxiliary: flags.countAuxiliary === true,
      countTowardPool: flags.countTowardPool === true,
    });
    deps.persist?.();
    return chainView(rootId);
  };

  const clearChain = (rootId) => {
    const existed = chains.delete(rootId);
    deps.persist?.();
    return existed;
  };

  /** 该会话当前应该用的模型（孵化执行者时作为 agentOptions 传给 subagents）。 */
  const activeAgentOptions = (rootId) => {
    const chain = chains.get(rootId);
    if (chain === undefined || gate(rootId) !== true) return undefined;
    const index = activeIndex(chain);
    if (index < 0) return undefined;
    const candidate = chain.candidates[index];
    return { provider: candidate.provider, model: candidate.model };
  };

  const chargeCandidate = (chain, provider, model, delta) => {
    let index = -1;
    for (let i = 0; i < chain.candidates.length; i += 1) {
      const candidate = chain.candidates[i];
      if (candidate.provider === provider && candidate.model === model) { index = i; break; }
    }
    if (index < 0) index = activeIndex(chain);
    const candidate = index < 0 ? undefined : chain.candidates[index];
    if (candidate === undefined) return;
    candidate.used.tokens += delta.tokens;
    candidate.used.requests += delta.requests;
  };

  // ── waterfall：请求期改路由（兜底 + 回退都在这）────────────────────────────
  ctx.on('agent/request', async (payload, next) => {
    const config = await next();
    const entry = chainOf(payload?.agent?.session);
    if (entry === undefined) return config;
    const index = activeIndex(entry.chain);
    if (index < 0) return config;
    const candidate = entry.chain.candidates[index];
    const sameRoute = candidate.provider === config.provider && candidate.model === config.model;
    const swapped = { provider: candidate.provider, model: candidate.model };
    if (config.temperature !== undefined) swapped.temperature = config.temperature;
    if (config.stop !== undefined) swapped.stop = config.stop;
    if (config.maxTokens !== undefined) swapped.maxTokens = config.maxTokens;
    if (config.reasoningEffort !== undefined && config.reasoningEffort !== null) {
      if (sameRoute) return config; // 同路由且原样能跑，别多事
      if (await supportsEffort(candidate.provider, candidate.model, config.reasoningEffort)) {
        swapped.reasoningEffort = config.reasoningEffort;
      } // 目标模型不支持这档 → 丢掉，让模型走自己的默认（与官方 routeChanged 口径一致）
    }
    if (sameRoute && swapped.reasoningEffort === config.reasoningEffort) return config;
    return swapped;
  });

  // ── 计量：给实际服务的那个候选记账 ─────────────────────────────────────────
  ctx.on('llm/stream', async function* (options, next) {
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined;
    const directory = agentsOf();
    const agent = sessionId === undefined || directory === undefined ? undefined : directory.get(sessionId);
    const entry = chainOf(agent?.session);
    if (entry === undefined) {
      for await (const chunk of next()) yield chunk;
      return;
    }
    const auxiliary = options.purpose !== undefined;
    if (auxiliary === true && entry.chain.countAuxiliary !== true) {
      for await (const chunk of next()) yield chunk;
      return;
    }
    for await (const chunk of next()) {
      try {
        if (chunk.type === 'usage') {
          chargeCandidate(entry.chain, options.provider, options.model, { tokens: mixedTokenTotal(chunk.usage), requests: 0 });
        } else if (chunk.type === 'finish' && chunk.reason !== undefined
          && chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') {
          chargeCandidate(entry.chain, options.provider, options.model, { tokens: 0, requests: 1 });
        }
      } catch (error) {
        console.error('dual-guidance accounting failed:', String(error));
      }
      yield chunk;
    }
  });

  // ── 回退：请求失败就把当前候选降级，有下一候选就重试 ───────────────────────
  ctx.on('agent/request-error', async (payload, next) => {
    const signal = payload?.signal;
    if (signal?.aborted === true) return next();
    const entry = chainOf(payload?.agent?.session);
    if (entry === undefined) return next();
    const chain = entry.chain;
    const index = activeIndex(chain);
    const candidate = index < 0 ? undefined : chain.candidates[index];
    if (candidate === undefined) return next();
    candidate.failed = true;
    if (activeIndex(chain) < 0) return next();
    return { kind: 'retry' };
  });

  // ── 服务面：dsh-model-pool 用它把子代理用量重定向到根会话的池 ──────────────
  ctx.provide('subagentModels', {
    billingRedirect(sessionId) {
      const directory = agentsOf();
      const agent = directory === undefined ? undefined : directory.get(sessionId);
      const entry = chainOf(agent?.session);
      if (entry === undefined || entry.chain.countTowardPool !== true) return undefined;
      return { rootSessionId: entry.rootId };
    },
  });

  // ── 持久化：候选与限额落盘（用量计数不落盘）────────────────────────────────
  const serialize = () => {
    const out = [];
    for (const [sessionId, chain] of chains.entries()) {
      out.push({
        sessionId,
        countAuxiliary: chain.countAuxiliary === true,
        countTowardPool: chain.countTowardPool === true,
        candidates: chain.candidates.map((candidate) => ({
          provider: candidate.provider,
          model: candidate.model,
          limit: candidate.limit === null ? null : { kind: candidate.limit.kind, value: candidate.limit.value },
        })),
      });
    }
    return out;
  };

  const restore = (records) => {
    if (!Array.isArray(records)) return 0;
    let loaded = 0;
    for (const record of records) {
      const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
      if (sessionId === '') continue;
      try {
        chains.set(sessionId, {
          candidates: normalizeCandidates(record.candidates ?? []),
          countAuxiliary: record.countAuxiliary === true,
          countTowardPool: record.countTowardPool === true,
        });
        loaded += 1;
      } catch { /* 一条坏记录不拖垮其它恢复 */ }
    }
    return loaded;
  };

  const adjust = (rootId, patch = {}) => {
    const chain = chains.get(rootId);
    if (chain === undefined) throw new Error('本会话没有已启用的子代理模型链');
    if (patch.countAuxiliary !== undefined) chain.countAuxiliary = patch.countAuxiliary === true;
    if (patch.countTowardPool !== undefined) chain.countTowardPool = patch.countTowardPool === true;
    if (patch.index !== undefined) {
      const index = patch.index;
      if (!Number.isInteger(index) || index < 0 || index >= chain.candidates.length) throw new Error('index 越界');
      // 手工修正用量（测试与「我知道它其实没满」的现场修正都用这条）：
      // 只接受非负整数，且立刻按新用量重算该候选是否还有额度——不绕开限额判定。
      if (patch.used !== undefined && patch.used !== null && typeof patch.used === 'object') {
        const used = patch.used;
        const next = { ...chain.candidates[index].used };
        for (const kind of ['requests', 'tokens']) {
          if (used[kind] === undefined) continue;
          if (!Number.isInteger(used[kind]) || used[kind] < 0) throw new Error(`used.${kind} 必须是非负整数`);
          next[kind] = used[kind];
        }
        chain.candidates[index].used = next;
        chain.candidates[index].failed = false;
      }
      // 改限额（不给 kind/value 就不动限额——例如只想修用量时）。
      if (patch.unlimited === true) {
        chain.candidates[index].limit = null;
        chain.candidates[index].failed = false;
      } else if (patch.kind !== undefined || patch.value !== undefined) {
        if (patch.kind !== 'requests' && patch.kind !== 'tokens') throw new Error('kind 必须是 requests 或 tokens');
        if (!isPositiveInt(patch.value)) throw new Error('value 必须是正整数');
        chain.candidates[index].limit = { kind: patch.kind, value: patch.value };
        chain.candidates[index].failed = false;
      }
    }
    if (patch.removeIndex !== undefined) {
      const index = patch.removeIndex;
      if (!Number.isInteger(index) || index < 0 || index >= chain.candidates.length) throw new Error('index 越界');
      chain.candidates.splice(index, 1);
      if (chain.candidates.length === 0) { chains.delete(rootId); deps.persist?.(); return { removedAll: true }; }
    }
    if (patch.move !== undefined) {
      const from = patch.move?.from;
      const to = patch.move?.to;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= chain.candidates.length
        || to < 0 || to >= chain.candidates.length) throw new Error('move.from/to 越界');
      const [moved] = chain.candidates.splice(from, 1);
      chain.candidates.splice(to, 0, moved);
    }
    if (patch.add !== undefined) {
      if (chain.candidates.length >= MAX_CANDIDATES) throw new Error(`最多 ${MAX_CANDIDATES} 个候选`);
      // 只校验新加入的这条（既有候选的 used 计数必须原样保留，不能整体重建）
      const [validated] = normalizeCandidates([patch.add]);
      chain.candidates.push({
        provider: validated.provider,
        model: validated.model,
        limit: validated.limit,
        used: { requests: 0, tokens: 0 },
        failed: false,
      });
    }
    deps.persist?.();
    return chainView(rootId);
  };

  const resetCounters = (rootId) => {
    const chain = chains.get(rootId);
    if (chain === undefined) throw new Error('本会话没有已启用的子代理模型链');
    for (const candidate of chain.candidates) {
      candidate.used.requests = 0;
      candidate.used.tokens = 0;
      candidate.failed = false;
    }
    return chainView(rootId);
  };

  return {
    MAX_CANDIDATES,
    chainView,
    chainCount: () => chains.size,
    setChain,
    clearChain,
    adjust,
    resetCounters,
    activeAgentOptions,
    activeCandidate: (rootId) => {
      const chain = chains.get(rootId);
      const index = chain === undefined ? -1 : activeIndex(chain);
      return index < 0 ? undefined : chain.candidates[index];
    },
    lineageRoot: (session) => lineageOf(session).rootId,
    refreshCatalog,
    catalogView: () => catalog,
    modelInfoOf: infoOf,
    supportsEffort,
    knownProviders,
    serialize,
    restore,
    dropSession: (rootId) => chains.delete(rootId),
  };
}

export { MAX_CANDIDATES };
