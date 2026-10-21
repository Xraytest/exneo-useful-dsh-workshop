/**
 * 会话级模型供应池（dsh-model-pool）— host 半边静态插件。
 *
 * 纯静态组合行运行（profile 的 cordis.patch.yml），不依赖任何 agent 预设、
 * skill 或模型工具：启用/配置/调整/重置全部由用户在会话头部的「供应池」
 * 工具（./client.js）经本半边的 webServer 路由完成。按 SessionId 严格隔离：
 * 路由交换只作用于配置它的会话，计量只记它的请求，子代理各自持独立
 * sessionId 因此天然不受影响；未配置池的会话在所有钩子里直通。
 *
 * 行为：
 *  - 路由交换挂 agent/request waterfall（洗掉 reasoningEffort/maxTokens，
 *    新路由适配器按自己的缺省物化）。
 *  - 计量挂 llm/stream：tokens 取提供商混合总数（缺省则
 *    输入+输出+cache 求和），requests 只在成功 finish 计 1。
 *  - 故障转移挂 agent/request-error：401/403 或配额/计费/权限类致命错误
 *    把当前级标记耗尽并在同轮内转移到下一级重试（限一次防线）。
 *  - 清理挂 agent/disposed：会话销毁即删池。
 *
 * 供浏览器调用的路由（均带同源守卫；sessionId 由前端显式携带）：
 *   GET  /dsh-model-pool/status   ?sessionId=…            → {pool}
 *   POST /dsh-model-pool/enable   {sessionId,levels[…]}  → 换配/新建，计数归零
 *   POST /dsh-model-pool/adjust   {sessionId,index,kind,value} → 改一级上限，保留计数
 *   POST /dsh-model-pool/reset    {sessionId}            → 全部计数归零
 *   POST /dsh-model-pool/disable  {sessionId}            → 移除池（回到会话自身模型）
 *
 * 组合行（profile 的 cordis.patch.yml）：
 *   - insert:
 *       - id: model-pool
 *         name: ./plugins/dsh-model-pool/index.js
 *
 * @module dsh-model-pool
 */

export const inject = ['webServer'];

const MAX_LEVELS = 8;
const ROUTE_PREFIX = '/dsh-model-pool';

const isPositiveInt = (value) => typeof value === 'number' && Number.isInteger(value) && value > 0;

const levelExhausted = (level) => {
  if (level.limit.kind === 'requests') return level.used.requests >= level.limit.value;
  return level.used.tokens >= level.limit.value;
};

// First level that still has budget; when all are exhausted the last level
// keeps serving (token mode's allowed overshoot; request mode stays alive).
const activeIndex = (pool) => {
  for (let index = 0; index < pool.levels.length; index += 1) {
    if (!levelExhausted(pool.levels[index])) return index;
  }
  return pool.levels.length - 1;
};

const markExhausted = (level) => {
  if (level.limit.kind === 'requests') level.used.requests = level.limit.value;
  else level.used.tokens = level.limit.value;
};

// Mixed total: provider total, else input(+cache) + output summed together.
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

const sessionIdOf = (agent) => {
  if (agent === undefined || agent === null) return undefined;
  const session = agent.session;
  if (session === undefined || session === null) return undefined;
  return typeof session.id === 'string' ? session.id : undefined;
};

export function apply(ctx) {
  const pools = new Map();
  const llmOf = () => ctx.get('llm');

  const chargeLevel = (pool, provider, model, delta) => {
    let index = -1;
    for (let i = 0; i < pool.levels.length; i += 1) {
      const level = pool.levels[i];
      if (level.provider === provider && level.model === model) { index = i; break }
    }
    if (index < 0) index = activeIndex(pool);
    const level = pool.levels[index];
    if (level === undefined) return;
    level.used.tokens += delta.tokens;
    level.used.requests += delta.requests;
  };

  const levelView = (level) => ({
    provider: level.provider,
    model: level.model,
    kind: level.limit.kind,
    limit: level.limit.value,
    used: { requests: level.used.requests, tokens: level.used.tokens },
    exhausted: levelExhausted(level),
  });

  const poolView = (sessionId) => {
    const pool = pools.get(sessionId);
    if (pool === undefined) {
      return { configured: false, sessionId, countAuxiliary: false, activeIndex: -1, exhausted: false, levels: [] };
    }
    let allExhausted = true;
    for (const level of pool.levels) {
      if (!levelExhausted(level)) { allExhausted = false; break }
    }
    return {
      configured: true,
      sessionId,
      countAuxiliary: pool.countAuxiliary === true,
      activeIndex: activeIndex(pool),
      exhausted: allExhausted,
      levels: pool.levels.map(levelView),
    };
  };

  // ---- routing: swap provider/model for pooled sessions (sanctioned replacement point) ----
  ctx.on('agent/request', async (payload, next) => {
    const config = await next();
    const sessionId = sessionIdOf(payload.agent);
    const pool = sessionId === undefined ? undefined : pools.get(sessionId);
    if (pool === undefined || pool.levels.length === 0) return config;
    const level = pool.levels[activeIndex(pool)];
    if (level === undefined) return config;
    if (level.provider === config.provider && level.model === config.model) return config;
    // Drop reasoningEffort/maxTokens: the new route's adapter materializes its own defaults.
    const swapped = { provider: level.provider, model: level.model };
    if (config.temperature !== undefined) swapped.temperature = config.temperature;
    if (config.stop !== undefined) swapped.stop = config.stop;
    return swapped;
  });

  // ---- accounting: count requests (successful finishes) and mixed token totals ----
  ctx.on('llm/stream', async function* (options, next) {
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined;
    let pool = sessionId === undefined ? undefined : pools.get(sessionId);
    // 子代理用量重定向：会话本身没有池时，询问 dsh-subagent-models 服务该
    // 子代理是否计入某根会话的池（用户在其面板里选择的开关）。
    if (pool === undefined && sessionId !== undefined) {
      const service = ctx.get('subagentModels');
      const redirect = service !== undefined && typeof service.billingRedirect === 'function'
        ? service.billingRedirect(sessionId)
        : undefined;
      if (redirect !== undefined && redirect !== null && typeof redirect.rootSessionId === 'string') {
        pool = pools.get(redirect.rootSessionId);
      }
    }
    const auxiliary = options.purpose !== undefined;
    if (pool === undefined || (auxiliary === true && pool.countAuxiliary !== true)) {
      for await (const chunk of next()) yield chunk;
      return;
    }
    for await (const chunk of next()) {
      try {
        if (chunk.type === 'usage') {
          chargeLevel(pool, options.provider, options.model, { tokens: mixedTokenTotal(chunk.usage), requests: 0 });
        } else if (chunk.type === 'finish' && chunk.reason !== undefined
          && chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') {
          chargeLevel(pool, options.provider, options.model, { tokens: 0, requests: 1 });
        }
      } catch (error) {
        console.error('model_pool accounting failed:', String(error));
      }
      yield chunk;
    }
  });

  // ---- failover: a fatal provider failure marks the serving level exhausted, then retries on the next ----
  const FATAL_STATUSES = [401, 403];
  const FATAL_CODE = /quota|billing|insufficient|exhausted|permission|unauthorized|forbidden|invalid_api_key|authentication|expired/i;

  ctx.on('agent/request-error', async (payload, next) => {
    const sessionId = sessionIdOf(payload.agent);
    const pool = sessionId === undefined ? undefined : pools.get(sessionId);
    if (pool === undefined || pool.levels.length === 0) return next();
    const failure = payload.failure === undefined || payload.failure === null ? {} : payload.failure;
    const status = typeof failure.status === 'number' ? failure.status : undefined;
    const code = typeof failure.code === 'string' ? failure.code : '';
    const message = typeof failure.message === 'string' ? failure.message : '';
    const fatal = (status !== undefined && FATAL_STATUSES.indexOf(status) >= 0)
      || FATAL_CODE.test(code) || FATAL_CODE.test(message);
    const index = activeIndex(pool);
    const level = pool.levels[index];
    if (fatal !== true || level === undefined || level.provider !== payload.provider) return next();
    markExhausted(level);
    if (activeIndex(pool) === index) return next();
    if (pool.failoverTurn !== payload.turn) {
      pool.failoverTurn = payload.turn;
      pool.failoverCount = 0;
    }
    pool.failoverCount += 1;
    if (pool.failoverCount > pool.levels.length) return next();
    return { kind: 'retry' };
  });

  // ---- cleanup: a disposed session loses its process-local pool ----
  ctx.on('agent/disposed', (payload) => {
    const sessionId = sessionIdOf(payload.agent);
    if (sessionId !== undefined) pools.delete(sessionId);
  });

  // ---- browser API ----
  const listKnownProviders = () => {
    const llm = llmOf();
    const known = [];
    try {
      const providers = llm.listProviders();
      if (Array.isArray(providers)) {
        for (const entry of providers) known.push(String(entry.id));
      }
    } catch { /* provider directory unavailable: stay permissive */ }
    try {
      const configurable = llm.listConfigurableProviders();
      if (Array.isArray(configurable)) {
        for (const entry of configurable) known.push(String(entry.provider));
      }
    } catch { /* ignore */ }
    return known;
  };

  /** Validate one configure request body into pool levels; throws teaching errors. */
  const levelsFromRequest = (rawLevels) => {
    if (!Array.isArray(rawLevels)) throw new Error('levels 必须是数组');
    if (rawLevels.length === 0) throw new Error('供应池至少需要一级');
    if (rawLevels.length > MAX_LEVELS) throw new Error('供应池最多支持 ' + MAX_LEVELS + ' 级');
    const known = listKnownProviders();
    return rawLevels.map((entry, index) => {
      const at = 'levels[' + index + ']';
      if (entry === null || typeof entry !== 'object') throw new Error(at + ' 必须是对象');
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
      const model = typeof entry.model === 'string' ? entry.model.trim() : '';
      if (provider.length === 0) throw new Error(at + '.provider 不能为空');
      if (model.length === 0) throw new Error(at + '.model 不能为空');
      if (known.length > 0 && known.indexOf(provider) < 0) {
        throw new Error(at + '.provider "' + provider + '" 未注册；可用：' + known.join(', '));
      }
      const kind = entry.kind;
      if (kind !== 'requests' && kind !== 'tokens') throw new Error(at + '.kind 必须是 requests 或 tokens');
      if (!isPositiveInt(entry.value)) throw new Error(at + '.value 必须是正整数');
      return { provider, model, limit: { kind, value: entry.value }, used: { requests: 0, tokens: 0 } };
    });
  };

  const requireSessionId = (args) => {
    const sessionId = args !== null && typeof args === 'object' && typeof args.sessionId === 'string'
      ? args.sessionId
      : null;
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
  /** Same-origin guard: absolute Origin must match Host（dsh-lanmode 把两者都
   *  重写为 loopback，LAN 客户端同样通过；无 Origin 的本机调用放行）。 */
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };
  /** One POST route: same-origin → JSON body → handler → {pool} envelope. */
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
    const levels = levelsFromRequest(args.levels);
    pools.set(sessionId, {
      levels,
      countAuxiliary: args.countAuxiliary === true,
      failoverTurn: undefined,
      failoverCount: 0,
    });
    return { ok: true, pool: poolView(sessionId) };
  }, 'dsh-model-pool: enable route');

  registerPost(ROUTE_PREFIX + '/adjust', (args) => {
    const sessionId = requireSessionId(args);
    const pool = pools.get(sessionId);
    if (pool === undefined) throw new Error('会话没有已启用的供应池');
    let changed = false;
    if (args.countAuxiliary !== undefined) {
      pool.countAuxiliary = args.countAuxiliary === true;
      changed = true;
    }
    if (args.index !== undefined) {
      const index = args.index;
      if (!Number.isInteger(index) || index < 0 || index >= pool.levels.length) {
        throw new Error('index 越界');
      }
      const kind = args.kind;
      if (kind !== 'requests' && kind !== 'tokens') throw new Error('kind 必须是 requests 或 tokens');
      if (!isPositiveInt(args.value)) throw new Error('value 必须是正整数');
      pool.levels[index].limit = { kind, value: args.value };
      changed = true;
    }
    if (changed !== true) throw new Error('没有可调整的字段（index/kind/value 或 countAuxiliary）');
    return { ok: true, pool: poolView(sessionId) };
  }, 'dsh-model-pool: adjust route');

  registerPost(ROUTE_PREFIX + '/reset', (args) => {
    const sessionId = requireSessionId(args);
    const pool = pools.get(sessionId);
    if (pool === undefined) throw new Error('会话没有已启用的供应池');
    for (const level of pool.levels) { level.used.requests = 0; level.used.tokens = 0 }
    pool.failoverCount = 0;
    pool.failoverTurn = undefined;
    return { ok: true, pool: poolView(sessionId) };
  }, 'dsh-model-pool: reset route');

  registerPost(ROUTE_PREFIX + '/disable', (args) => {
    const sessionId = requireSessionId(args);
    const existed = pools.delete(sessionId);
    return { ok: true, removed: existed, pool: poolView(sessionId) };
  }, 'dsh-model-pool: disable route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PREFIX + '/status',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return apiError(res, 405, 'Method Not Allowed');
      }
      if (!sameOrigin(req)) return apiError(res, 403, 'cross-origin request rejected');
      const url = new URL(req.url, 'http://localhost');
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (sessionId === '') return apiError(res, 400, '需要 sessionId 查询参数');
      apiJson(res, 200, { pool: poolView(sessionId) });
    },
  }), 'dsh-model-pool: status route');
}
