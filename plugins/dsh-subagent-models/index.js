/**
 * 会话级子代理模型链（dsh-subagent-models）— host 半边静态插件。
 *
 * 为用户会话配置「子代理可用模型」的**有序候选链**（多个），每个候选可带
 * 用量限额（成功请求数 / 混合 token 总数，或 不限）。子代理（含嵌套子代理，
 * 经 session.header.parentSession 走到根会话）的每次模型请求都按链选第一个
 * 未耗尽的候选；用量耗尽或请求失败自动回退到下一个；候选全部不可用时
 * 放行（子代理以自己的路由失败）。
 *
 * 机制对齐 dsh-model-pool：路由交换挂 agent/request waterfall（仅作用于
 * 本会话血统内的子代理 agent，其会话 header.parentSession 非空）；计量挂
 * llm/stream；失败回退挂 agent/request-error（任何非中断失败都标记当前
 * 候选 failed 并在有下一候选时返回 {kind:'retry'}；注意链上 model-retry
 * 在前，可重试类别会先走它的重试预算，耗尽后才落到本回退）。
 *
 * 与请求池（dsh-model-pool）联动：本插件 ctx.provide 服务
 * `subagentModels.billingRedirect(sessionId)`；池插件在处理 llm/stream 时
 * 若本会话无池，会向该服务查询「这个子代理会话是否计入某根会话的池」，
 * 开关由用户在本插件的 UI 里选择（countTowardPool）。
 *
 * 配置仅存进程内存（与请求池一致，DSH 重启后回到未启用态；配置文件不落盘，
 * 因为其作用对象——子代理会话——本身也随重启消失）。
 *
 * 浏览器 API（同源守卫）：/dsh-subagent-models/{status,enable,adjust,reset,disable}
 *
 * 组合行（profile 的 cordis.patch.yml）：
 *   - insert:
 *       - id: subagent-models
 *         name: ./plugins/dsh-subagent-models/index.js
 *
 * @module dsh-subagent-models
 */

export const inject = ['webServer'];

const MAX_CANDIDATES = 8;
const ROUTE_PREFIX = '/dsh-subagent-models';

const isPositiveInt = (value) => typeof value === 'number' && Number.isInteger(value) && value > 0;

const candidateExhausted = (candidate) => {
  if (candidate.failed === true) return true;
  if (candidate.limit === null) return false;
  if (candidate.limit.kind === 'requests') return candidate.used.requests >= candidate.limit.value;
  return candidate.used.tokens >= candidate.limit.value;
};

// First candidate that still has budget; undefined when every candidate is spent.
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
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value)) total += value;
  }
  return total;
};

export function apply(ctx) {
  const configs = new Map(); // rootSessionId -> { candidates, countAuxiliary, countTowardPool }
  const agentsOf = () => ctx.get('agents');

  /**
   * Walk the lineage upward from a session object to its root session id.
   * Returns { rootId, isSubagent } — isSubagent=false when the session has no
   * parent (i.e. this plugin never touches the user's own turns).
   */
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
      if (parentAgent === undefined || parentAgent === null) {
        // Parent already gone: the deepest known ancestor is the session we have.
        return { rootId: current?.id, isSubagent };
      }
      current = parentAgent.session;
    }
    return { rootId: current?.id, isSubagent };
  };

  const chainOf = (session) => {
    const { rootId, isSubagent } = lineageOf(session);
    if (isSubagent !== true || rootId === undefined) return undefined;
    const chain = configs.get(rootId);
    if (chain === undefined) return undefined;
    return { chain, rootId };
  };

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
    const chain = configs.get(rootId);
    if (chain === undefined) {
      return { configured: false, sessionId: rootId, countAuxiliary: false, countTowardPool: false, activeIndex: -1, exhausted: false, candidates: [] };
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

  const chargeCandidate = (chain, provider, model, delta) => {
    let index = -1;
    for (let i = 0; i < chain.candidates.length; i += 1) {
      const candidate = chain.candidates[i];
      if (candidate.provider === provider && candidate.model === model) { index = i; break }
    }
    if (index < 0) index = activeIndex(chain);
    const candidate = index < 0 ? undefined : chain.candidates[index];
    if (candidate === undefined) return;
    candidate.used.tokens += delta.tokens;
    candidate.used.requests += delta.requests;
  };

  // ---- routing: swap the route of subagent requests inside a configured lineage ----
  ctx.on('agent/request', async (payload, next) => {
    const config = await next();
    const entry = chainOf(payload?.agent?.session);
    if (entry === undefined) return config;
    const index = activeIndex(entry.chain);
    if (index < 0) return config;
    const candidate = entry.chain.candidates[index];
    if (candidate.provider === config.provider && candidate.model === config.model) return config;
    const swapped = { provider: candidate.provider, model: candidate.model };
    if (config.temperature !== undefined) swapped.temperature = config.temperature;
    if (config.stop !== undefined) swapped.stop = config.stop;
    return swapped;
  });

  // ---- accounting: charge the serving candidate (and optionally the session pool) ----
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
        console.error('subagent_models accounting failed:', String(error));
      }
      yield chunk;
    }
  });

  // ---- fallback: a request failure demotes the serving candidate, then retries on the next ----
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

  // ---- service: let the model-pool plugin redirect pool billing to this chain ----
  ctx.provide('subagentModels', {
    /** Resolve a (sub)session to the billing root configured to count toward the pool. */
    billingRedirect(sessionId) {
      const directory = agentsOf();
      const agent = directory === undefined ? undefined : directory.get(sessionId);
      const entry = chainOf(agent?.session);
      if (entry === undefined || entry.chain.countTowardPool !== true) return undefined;
      return { rootSessionId: entry.rootId };
    },
  });

  // ---- browser API ----
  const listKnownProviders = () => {
    const llm = ctx.get('llm');
    const known = [];
    try {
      const providers = llm.listProviders();
      if (Array.isArray(providers)) for (const entry of providers) known.push(String(entry.id));
    } catch { /* provider directory unavailable: stay permissive */ }
    try {
      const configurable = llm.listConfigurableProviders();
      if (Array.isArray(configurable)) for (const entry of configurable) known.push(String(entry.provider));
    } catch { /* ignore */ }
    return known;
  };

  const candidatesFromRequest = (rawCandidates) => {
    if (!Array.isArray(rawCandidates)) throw new Error('candidates 必须是数组');
    if (rawCandidates.length === 0) throw new Error('子代理模型链至少需要一个候选');
    if (rawCandidates.length > MAX_CANDIDATES) throw new Error('子代理模型链最多支持 ' + MAX_CANDIDATES + ' 个候选');
    const known = listKnownProviders();
    return rawCandidates.map((entry, index) => {
      const at = 'candidates[' + index + ']';
      if (entry === null || typeof entry !== 'object') throw new Error(at + ' 必须是对象');
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
      const model = typeof entry.model === 'string' ? entry.model.trim() : '';
      if (provider.length === 0) throw new Error(at + '.provider 不能为空');
      if (model.length === 0) throw new Error(at + '.model 不能为空');
      if (known.length > 0 && known.indexOf(provider) < 0) {
        throw new Error(at + '.provider "' + provider + '" 未注册；可用：' + known.join(', '));
      }
      let limit = null;
      if (entry.limit !== undefined && entry.limit !== null) {
        const kind = entry.limit.kind;
        if (kind !== 'requests' && kind !== 'tokens') throw new Error(at + '.limit.kind 必须是 requests 或 tokens（或省略 limit 表示不限）');
        if (!isPositiveInt(entry.limit.value)) throw new Error(at + '.limit.value 必须是正整数');
        limit = { kind, value: entry.limit.value };
      }
      return { provider, model, limit, used: { requests: 0, tokens: 0 }, failed: false };
    });
  };

  const requireSessionId = (args) => {
    const sessionId = args !== null && typeof args === 'object' && typeof args.sessionId === 'string' ? args.sessionId : null;
    if (sessionId === null || sessionId === '') throw new Error('需要 { sessionId: string }');
    return sessionId;
  };

  const apiError = (res, status, error) => {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: message }));
  };
  const apiJson = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 262144) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };
  const registerPost = (path, handler, label) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        if (req.method !== 'POST') return apiError(res, 405, 'Method Not Allowed');
        if (!sameOrigin(req)) return apiError(res, 403, 'cross-origin request rejected');
        readBody(req).then(async (text) => {
          let args = {};
          if (text !== '') {
            try {
              args = JSON.parse(text);
            } catch {
              return apiError(res, 400, 'body 不是合法 JSON');
            }
          }
          try {
            return apiJson(res, 200, await handler(args));
          } catch (error) {
            return apiError(res, 400, error);
          }
        }).catch(() => apiError(res, 400, 'body 读取失败'));
      },
    }), label);
  };

  registerPost(ROUTE_PREFIX + '/enable', (args) => {
    const sessionId = requireSessionId(args);
    const candidates = candidatesFromRequest(args.candidates);
    configs.set(sessionId, {
      candidates,
      countAuxiliary: args.countAuxiliary === true,
      countTowardPool: args.countTowardPool === true,
    });
    return { ok: true, chain: chainView(sessionId) };
  }, 'dsh-subagent-models: enable route');

  registerPost(ROUTE_PREFIX + '/adjust', (args) => {
    const sessionId = requireSessionId(args);
    const chain = configs.get(sessionId);
    if (chain === undefined) throw new Error('会话没有已启用的子代理模型链');
    let changed = false;
    if (args.countAuxiliary !== undefined) {
      chain.countAuxiliary = args.countAuxiliary === true;
      changed = true;
    }
    if (args.countTowardPool !== undefined) {
      chain.countTowardPool = args.countTowardPool === true;
      changed = true;
    }
    if (args.index !== undefined) {
      const index = args.index;
      if (!Number.isInteger(index) || index < 0 || index >= chain.candidates.length) throw new Error('index 越界');
      if (args.unlimited === true) {
        chain.candidates[index].limit = null;
        chain.candidates[index].failed = false;
      } else {
        const kind = args.kind;
        if (kind !== 'requests' && kind !== 'tokens') throw new Error('kind 必须是 requests 或 tokens');
        if (!isPositiveInt(args.value)) throw new Error('value 必须是正整数');
        chain.candidates[index].limit = { kind, value: args.value };
        chain.candidates[index].failed = false;
      }
      changed = true;
    }
    if (changed !== true) throw new Error('没有可调整的字段（index/kind/value/unlimited 或 countAuxiliary/countTowardPool）');
    return { ok: true, chain: chainView(sessionId) };
  }, 'dsh-subagent-models: adjust route');

  registerPost(ROUTE_PREFIX + '/reset', (args) => {
    const sessionId = requireSessionId(args);
    const chain = configs.get(sessionId);
    if (chain === undefined) throw new Error('会话没有已启用的子代理模型链');
    for (const candidate of chain.candidates) {
      candidate.used.requests = 0;
      candidate.used.tokens = 0;
      candidate.failed = false;
    }
    return { ok: true, chain: chainView(sessionId) };
  }, 'dsh-subagent-models: reset route');

  registerPost(ROUTE_PREFIX + '/disable', (args) => {
    const sessionId = requireSessionId(args);
    const existed = configs.delete(sessionId);
    return { ok: true, removed: existed, chain: chainView(sessionId) };
  }, 'dsh-subagent-models: disable route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PREFIX + '/status',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return apiError(res, 405, 'Method Not Allowed');
      if (!sameOrigin(req)) return apiError(res, 403, 'cross-origin request rejected');
      const url = new URL(req.url, 'http://localhost');
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (sessionId === '') return apiError(res, 400, '需要 sessionId 查询参数');
      apiJson(res, 200, { chain: chainView(sessionId) });
    },
  }), 'dsh-subagent-models: status route');
}