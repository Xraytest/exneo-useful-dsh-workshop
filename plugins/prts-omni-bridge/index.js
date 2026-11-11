/**
 * prts-omni-bridge -- 让 PRTS Omni 安卓客户端访问 DSH 的会话 / 智能体 / 工具。
 *
 * 这个插件只做 Host 半边：
 *
 *   1. 起一个**独立的** node:http 服务（默认 127.0.0.1:8787），暴露 REST + WebSocket：
 *        GET    /prts-omni/v1/health
 *        GET    /prts-omni/v1/sessions
 *        GET    /prts-omni/v1/sessions/:id
 *        GET    /prts-omni/v1/sessions/:id/events?since=&limit=
 *        POST   /prts-omni/v1/sessions/:id/message   { text, interrupt? }
 *        POST   /prts-omni/v1/sessions/:id/interrupt
 *        POST   /prts-omni/v1/sessions                { title, model, branch, goal }
 *        GET    /prts-omni/v1/tools                   （需 allowToolExecution）
 *        POST   /prts-omni/v1/tools/:name             （需 allowToolExecution）
 *        WS     /prts-omni/v1/stream
 *   2. 注册模型工具 `prts_omni`（list_sessions / send / interrupt / spawn）；
 *   3. 会话销毁时清掉对应的 WS 订阅；插件卸载时关服务、关 WS、清定时器（幂等）。
 *
 * 安全边界：
 *   · 默认只绑回环；`bindHost=0.0.0.0` 必须同时 `allowLan=true`，否则**拒绝启动**；
 *   · 除 `/health` 与 `/auth/token`（仅本机回环免令牌）外，全部要 Bearer 令牌；
 *   · 令牌 256 位随机、落盘 0600、恒定时间比较、绝不进 info 日志；
 *   · 请求体上限 64 KiB；handler 内部异常一律转 500，不崩服务；
 *   · 拒绝带 Origin / Sec-Fetch-* 的跨站请求（防 DNS rebinding）；
 *   · 工具执行默认关闭；WS 未确认积压超过 1000 条即断开。
 *
 * @module prts-omni-bridge
 */

import { loadOrCreateToken } from './lib/token.js?v=1';
import { createBridge } from './lib/http.js?v=1';
import { createPrtsOmniTool } from './lib/tool.js?v=1';

export const name = 'prts-omni-bridge';

/** 工具注册表是硬依赖：没有它这个插件没有存在意义。 */
export const inject = ['tools'];

/**
 * 解析 schemastery。
 *
 * Loader 要求 `Config` 是一个**带 `.validate()` 的 schema 对象**（schemastery），
 * 不是裸 JSON Schema —— 传裸对象会在激活期抛
 * `TypeError: Cannot read properties of undefined (reading 'validate')`。
 *
 * 包名在 DSH 各版本间有 scope / 无 scope 两种形态（`@deepseek-ai/schemastery` ↔
 * `schemastery`），静态 import 无法条件化，只能运行期解析：ESM `await import()` 优先，
 * 失败再退回 `createRequire`。取不到时 `Config = undefined`，由 `resolveConfig()`
 * 自己兜底（它本来就会做类型检查与夹取），插件照样能跑。
 *
 * 参考实现：`plugins/dsh-blender-plugin/lib/index.js` 的 schemaResolve。
 */
const SM_NAMES = ['@deepseek-ai/schemastery', 'schemastery'];
/** 形态判定：能拿到带 `.object()` 的那一层才算可用（拿不到就是不认，不赌）。 */
const smPick = (m) => {
  for (const candidate of [m && m.default, m]) {
    if (candidate && typeof candidate.object === 'function') return candidate;
  }
  return null;
};

let z = null;
for (const id of SM_NAMES) {
  try {
    const hit = smPick(await import(/* webpackIgnore: true */ id));
    if (hit) {
      z = hit;
      break;
    }
  } catch {
    /* 换下一个名字 */
  }
}
if (z === null) {
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    for (const id of SM_NAMES) {
      try {
        const hit = smPick(require(id));
        if (hit) {
          z = hit;
          break;
        }
      } catch {
        /* 换下一个名字 */
      }
    }
  } catch {
    /* 连 createRequire 都不可用 */
  }
}

/**
 * 插件配置 schema。
 *
 * 字段含义见 `resolveConfig()` 与 README 的配置表。拿不到 schemastery 时导出
 * `undefined`（等价于「不声明 Config」），Loader 会跳过 schema 校验，
 * 由 `resolveConfig()` 做运行期归一化。
 */
export const Config = z === null
  ? undefined
  : z.object({
    enabled: z.boolean().default(true)
      .description('是否启用桥接服务。关闭时 apply 直接返回，不起服务、不注册工具。'),
    bindHost: z.string().default('127.0.0.1')
      .description('监听地址。设为 0.0.0.0 或 :: 监听所有网卡时，必须同时把 allowLan 设为 true。'),
    port: z.natural().min(1024).max(65535).default(8787)
      .description('监听端口。'),
    allowLan: z.boolean().default(false)
      .description('是否允许局域网访问。false 时只接受 127.0.0.1。'),
    allowToolExecution: z.boolean().default(false)
      .description('是否开放 /tools 与 /tools/:name（可让远端执行任意 Host 工具，谨慎开启）。'),
    maxSessions: z.natural().min(1).max(1000).default(50)
      .description('GET /sessions 单页最多返回多少个会话。'),
  });

/**
 * 归一化配置：类型不对就回落到默认值，绝不抛异常让插件激活失败。
 *
 * 夹取（clamp）不是静默的：每次改动都会 `ctx.logger.warn` 说明「你配的值被改成了
 * 什么」，否则 `port: 80` 悄悄变成 1024、`maxSessions: 99999` 悄悄变成 1000，
 * 用户只会看到「我配了却没生效」而日志里毫无线索。
 *
 * @param {Record<string, unknown>} config
 * @param {(level: string, text: string) => void} [log]
 */
function resolveConfig(config, log) {
  const warn = (text) => {
    try {
      log?.('warn', text);
    } catch {
      /* 日志失败不影响配置解析 */
    }
  };
  const raw = config !== null && typeof config === 'object' ? config : {};
  const bool = (name, fallback) => (typeof raw[name] === 'boolean' ? raw[name] : fallback);
  const int = (name, fallback, min, max) => {
    const value = Number(raw[name]);
    if (!Number.isFinite(value)) return fallback;
    const floored = Math.floor(value);
    if (floored === value && value >= min && value <= max) return floored;
    const clamped = Math.min(max, Math.max(min, floored));
    warn(`prts-omni-bridge: 配置 ${name}=${JSON.stringify(raw[name])} 越界，已夹取到 ${clamped}（允许范围 ${min}-${max}）`);
    return clamped;
  };
  const str = (name, fallback) => {
    const value = typeof raw[name] === 'string' ? raw[name].trim() : '';
    return value === '' ? fallback : value;
  };
  const port = Number(raw.port);
  let resolvedPort;
  if (!Number.isFinite(port)) {
    if (raw.port !== undefined) {
      warn(`prts-omni-bridge: 配置 port=${JSON.stringify(raw.port)} 不是数字，已回落到默认值 8787`);
    }
    resolvedPort = 8787;
  } else if (port === 0) {
    // 0 是「让操作系统挑一个空闲端口」的约定（测试用），不能夹到 1024 去；
    // Config schema 对用户仍然要求 1024-65535。
    resolvedPort = 0;
  } else {
    const floored = Math.floor(port);
    const clamped = Math.min(65535, Math.max(1024, floored));
    if (clamped !== port) {
      warn(`prts-omni-bridge: 配置 port=${JSON.stringify(raw.port)} 越界，已夹取到 ${clamped}（允许范围 1024-65535）`);
    }
    resolvedPort = clamped;
  }
  return {
    enabled: bool('enabled', true),
    bindHost: str('bindHost', '127.0.0.1'),
    port: resolvedPort,
    allowLan: bool('allowLan', false),
    allowToolExecution: bool('allowToolExecution', false),
    maxSessions: int('maxSessions', 50, 1, 1000),
  };
}

/**
 * 是否「监听所有网卡」。
 * @param {string} host
 * @returns {boolean}
 */
function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::' || host === '::0' || host === '';
}

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} [config]
 */
export async function apply(ctx, config = {}) {
  const log = (level, text) => {
    try {
      ctx.logger?.[level]?.(text);
    } catch {
      /* 日志失败不影响插件 */
    }
  };

  const settings = resolveConfig(config, log);

  if (settings.enabled !== true) {
    log('info', 'prts-omni-bridge: 已在配置里停用（enabled=false）');
    return;
  }

  // ── 局域网守卫：失败关闭 ─────────────────────────────────────────────────
  if (isWildcardHost(settings.bindHost) && settings.allowLan !== true) {
    log(
      'warn',
      `prts-omni-bridge: bindHost "${settings.bindHost}" 会把桥接暴露给整个局域网，但 allowLan=false；`
      + '拒绝启动。如需局域网访问，请在 cordis.patch.yml 里显式设置 allowLan: true。',
    );
    return;
  }

  // ── 配对令牌 ─────────────────────────────────────────────────────────────
  let token;
  try {
    const loaded = await loadOrCreateToken();
    token = loaded.token;
    // 只提示路径与「已就绪」，绝不把令牌本体打进日志
    log('info', `prts-omni-bridge: 配对令牌已就绪（${loaded.created ? '已生成' : '已复用'}，存放于 ${loaded.path}），请填入 PRTS Omni`);
  } catch (error) {
    log('error', `prts-omni-bridge: 无法读写配对令牌文件：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const bridge = createBridge({
    ctx,
    config: settings,
    token,
    logger: {
      info: (text) => log('info', text),
      warn: (text) => log('warn', text),
      error: (text) => log('error', text),
    },
  });

  // ── 模型工具 ─────────────────────────────────────────────────────────────
  // ⚠ parameters 必须是标准 JSON Schema（顶层 type:'object' + properties +
  // required 数组）。ctx.tools.register() 把 parameters 原样透传给模型供应商；
  // 写成作者方言（每个属性上挂 required:true、顶层没有 type:'object'）会让
  // 部分供应商直接拒绝整个请求。
  const tool = createPrtsOmniTool({ getContext: () => ctx });

  // ── 启动 ────────────────────────────────────────────────────────────────
  // 工具注册放在启动成功之后：桥接没起来就没有 prts_omni 工具，
  // 避免模型调到一个必然失败的空壳上。
  let endpoint;
  try {
    endpoint = await bridge.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('error', `prts-omni-bridge: 监听 ${settings.bindHost}:${settings.port} 失败：${message}`);
    await bridge.stop().catch(() => {});
    return;
  }

  ctx.effect(() => ctx.tools.register(tool), 'prts-omni-bridge: prts_omni tool');

  // ── 会话销毁 → 清掉该会话的 WS 订阅 ──────────────────────────────────────
  // 事件契约是 payload { agent }；同时兼容「直接传 Agent」的形状。
  // 放在 start() **成功之后**注册：以前它在 start() 之前就注册，且 ctx.on() 返回的
  // disposer 被直接丢掉 —— start() 失败提前 return 时监听器仍然挂在 ctx 上，
  // 插件重载后会累积僵尸监听器。现在既保证只有真跑起来才监听，disposer 也由
  // 下面的 ctx.effect 统一纳管。
  const disposeAgentListener = ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent ?? payload;
    const candidates = [agent?.id, agent?.session?.id].filter((id) => typeof id === 'string' && id !== '');
    for (const sessionId of candidates) bridge.dropSession(sessionId);
  });

  log(
    'info',
    `prts-omni-bridge: 已监听 ${endpoint}（局域网 ${isWildcardHost(settings.bindHost) ? '开' : '关'}，`
    + `工具执行 ${settings.allowToolExecution ? '开' : '关'}）；配对令牌已就绪，请填入 PRTS Omni`,
  );

  // ── 卸载 / 重载：关 server、关 WS、清定时器（幂等）──────────────────────
  ctx.effect(() => async () => {
    try {
      disposeAgentListener?.();
    } catch {
      /* 监听器摘除失败不影响后续清理 */
    }
    try {
      await bridge.stop();
      log('info', 'prts-omni-bridge: 服务已停止');
    } catch (error) {
      log('warn', `prts-omni-bridge: 停止服务时出错：${error instanceof Error ? error.message : String(error)}`);
    }
  }, 'prts-omni-bridge: stop server');
}
