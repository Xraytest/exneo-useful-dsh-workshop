/**
 * 管理员权限通道的会话级生命周期。
 *
 * 每个会话最多一条通道；通道 = 一个**常驻提权进程**（broker.ps1）+ 一条随机命名
 * 管道。启动时经 UAC 授权一次（用户必须点「是」），之后 host 用随机令牌 + 客户端
 * PID 校验与 broker 通信，命令不再触发 UAC。
 *
 * 关闭条件（任一满足）：
 *   · 用户在工作箱里拨关；
 *   · 会话被销毁（agent/disposed）；
 *   · 空闲超时（idleTimeoutMs；**默认 0 = 不限时**，不自动关闭）；
 *   · 插件卸载 / 重载；
 *   · broker 退出或管道断开（状态转为 error，等用户重新开启）。
 *
 * v9（2026-11-07 用户指令「去除隧道提权时间限制」）：uacTimeoutMs / idleTimeoutMs /
 * execTimeoutMs / maxExecTimeoutMs 默认全部为 0 = 不限时——UAC 可以慢慢点、通道不因
 * 闲置过期、单条命令不掐表。时间不再是生命周期边界：cancel 文件、spec 删除、
 * ownerPid 消失、管道断开仍会让提权进程退出。
 *
 * 状态只在内存里按 SessionId 保存（不落盘、不跨进程复活）：host 进程退出后
 * broker 的管道断开即自行退出，不会留下“无人接管”的提权进程。
 *
 * @module dsh-admin-channel/lib/channel
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PipeClient } from './pipe-client.js?v=ac-11';

/** 本包根目录（lib/ 的上一级）。 */
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));
const BROKER_PATH = join(PLUGIN_DIR, 'broker.ps1');
const LAUNCH_PATH = join(PLUGIN_DIR, 'launch.ps1');

/** 启动失败但可重试时抛的错（用于区分“连接还没起来”和“真的失败”）。 */
class ChannelStartError extends Error {}

/**
 * 单条命令可接受的正数超时的绝对上限（24 小时）。超过它（或 Node 的 32 位计时器
 * 上限）不当成“更长的超时”，而当作**不限时**：Node 的 setTimeout 对 >2^31-1 的
 * 毫秒值会静默夹成 1ms（TimeoutOverflowWarning），于是「请求很长的超时」反而会让
 * 命令秒退、并被 exec-failure 逻辑连带关掉整条通道。broker 侧同一口径夹到 24h。
 */
const ABSOLUTE_EXEC_MS = 24 * 60 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function truncate(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}…（已截断，共 ${value.length} 字符）`;
}

/**
 * 当前会话的短标识，只用于给人看的提示。
 * @param {string} sessionId
 * @returns {string}
 */
function shortSession(sessionId) {
  const value = String(sessionId ?? '');
  return value.length <= 10 ? value : `${value.slice(0, 8)}…`;
}

/**
 * 数据目录：$DSH_HOME/admin-channel（缺省 ~/.dsh/admin-channel）。
 * @returns {string}
 */
function dataDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'admin-channel');
}

/**
 * 用 Windows PowerShell 5.1；找不到退回 PATH 上的 powershell.exe。
 * @returns {string}
 */
function powershellPath() {
  const root = typeof process.env.SystemRoot === 'string' && process.env.SystemRoot !== ''
    ? process.env.SystemRoot
    : 'C:\\Windows';
  const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(candidate) ? candidate : 'powershell.exe';
}

/**
 * 生产环境的启动方式：非提权 PowerShell 跑 launch.ps1，由它 ShellExecute RunAs
 * 拉起 broker（用户点一次 UAC）。测试可以注入一个直接启动 broker 的 launcher，
 * 从而在**不弹 UAC、不碰桌面**的情况下跑完整生命周期。
 * @param {{ specPath: string, powershell: string }} input
 * @returns {import('node:child_process').ChildProcess}
 */
function defaultLaunch({ specPath, powershell }) {
  return spawn(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', LAUNCH_PATH, '-Spec', specPath],
    { windowsHide: true, stdio: 'ignore' },
  );
}

/**
 * 时长解析（v9，2026-11-07 用户指令「去除隧道提权时间限制」）：
 * 每一项都支持 **0（或负值）= 不限时**；只有显式给正数才生效并夹在 [min, max] 内。
 * 缺省值一律取「不限时」，即隧道不再自带任何过期/掐表语义。
 * @param {Record<string, unknown>} raw
 * @param {string} name
 * @param {{ fallback: number, min: number, max: number }} bounds
 * @returns {number} 0 = 不限时
 */
function resolveDuration(raw, name, bounds) {
  const value = raw[name];
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) {
    return bounds.fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return bounds.fallback;
  if (parsed <= 0) return 0;
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(parsed)));
}

/**
 * 默认配置。patch 里可以逐项覆盖（没有 Config schema，未知字段被忽略）。
 * v9 起所有时长默认 0 = 不限时：
 *   · uacTimeoutMs：等 UAC 点「是」的预算（0 = 一直等，用户慢慢决定）；
 *   · idleTimeoutMs：最后一次执行后多久自动关通道（0 = 不因闲置关闭）；
 *   · execTimeoutMs：单条命令的默认超时（0 = 命令可以跑任意久）；
 *   · maxExecTimeoutMs：模型显式给 timeout_ms 时的上限（0 = 不设上限）。
 * @param {Record<string, unknown>} config
 */
function resolveSettings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const number = (name, fallback, min, max) => {
    const value = Number(raw[name]);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
  };
  return {
    uacTimeoutMs: resolveDuration(raw, 'uacTimeoutMs', { fallback: 0, min: 10_000, max: 600_000 }),
    idleTimeoutMs: resolveDuration(raw, 'idleTimeoutMs', { fallback: 0, min: 5_000, max: 24 * 60 * 60_000 }),
    maxChannels: number('maxChannels', 1, 1, 8),
    execTimeoutMs: resolveDuration(raw, 'execTimeoutMs', { fallback: 0, min: 1_000, max: ABSOLUTE_EXEC_MS }),
    maxExecTimeoutMs: resolveDuration(raw, 'maxExecTimeoutMs', { fallback: 0, min: 1_000, max: ABSOLUTE_EXEC_MS }),
    maxOutputBytes: number('maxOutputBytes', 262_144, 4_096, 4_194_304),
    requireElevation: raw.requireElevation !== false,
    // v11：DSH 启动时就请求一次管理员授权（一次 UAC），之后任意会话拨开关零弹窗。
    // 默认开（用户指令 2026-11-07）；设 startupConsent: false 回到「每会话拨开关才弹」。
    startupConsent: raw.startupConsent !== false,
    /** 授权被拒后是否允许重启进程再自动追问一次（默认允许；拒绝过就不骚扰）。 */
    authorityRetry: raw.authorityRetry !== false,
  };
}

/** 人话时长（0 = 不限时），给日志与 UI note 用。 */
function durationText(ms) {
  if (!(ms > 0)) return '不限时';
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${Math.round(ms / 1000)} 秒`;
}

/**
 * @param {{
 *   ctx: any,
 *   config?: Record<string, unknown>,
 *   log?: (level: string, text: string) => void,
 *   launch?: (input: { specPath: string, powershell: string }) => any,
 * }} options
 */
export function createAdminChannelManager({ ctx, config, log, launch = defaultLaunch }) {
  const settings = resolveSettings(config);
  const records = new Map();
  const auditFile = join(dataDir(), 'audit.jsonl');
  const tempRoot = join(tmpdir(), 'dsh-admin-channel');
  const powershell = powershellPath();
  const ownerUser = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? userInfo().username}`;

  const logger = {
    info: (text) => log?.('info', text),
    warn: (text) => log?.('warn', text),
  };

  /**
   * 常驻「提权授权」（authority）：v11（用户指令 2026-11-07「DSH 启动时请求管理员
   * 权限，会话可选开启，开启时不再弹窗」）。
   *
   * 它复用会话通道的**同一套** broker / 管道 / 令牌 / PID 校验代码，只是绑到一个
   * 不会与会话 id 相撞的合成键上，并且**不受会话销毁影响、不占用 maxChannels 槽位**。
   * 会话「开启」= 挂到这个已经活着的提权进程上（不新建进程、不弹 UAC）；
   * 「关闭」= 摘下来（提权进程继续为其它会话服务）。
   *
   * 为什么授权不可能跨 DSH 进程存活：broker 只接受 1 个管道实例的唯一客户端，
   * 客户端断开时 ReadLine 返回 null → broker 立即退出。因此启动时的那一次 UAC
   * 覆盖**整个 DSH 进程生命周期**，重启 DSH 会再弹一次（这是设计上的边界，
   * 不是漏掉的优化：提权进程绝不比宿主活得更久）。
   */
  const AUTHORITY_KEY = 'authority:dsh-admin-channel';

  /** 当前挂载在常驻授权上的会话：sessionId → AUTHORITY_KEY。 */
  const attached = new Map();

  /**
   * 授权生命周期（与任何会话无关，供 status 展示）。
   * phase: idle（未启动）/ starting / running / error / off（已释放）
   */
  const authority = {
    phase: 'idle',
    enabled: settings.startupConsent,
    lastError: null,
    startedAt: null,
    reason: null,
    /** 本次 DSH 进程内用户是否拒绝过：拒绝后不再自动追问。 */
    declined: false,
  };

  /** 授权记录（若存在）。 */
  const authorityRecord = () => records.get(AUTHORITY_KEY);

  /** 授权是否可用（进程活着且管道已连上）。 */
  function authorityReady() {
    const record = authorityRecord();
    return record !== undefined && record.phase === 'running' && record.client !== null;
  }

  /**
   * 授权是否「存在且可能可用」：running 或还在等 UAC（starting）。
   * 用于 UI 文案与 start() 的判断——starting 期间挂载上去也是对的，命令会等
   * broker 就绪（exec 会明确报「正在等待 UAC 授权」）。
   */
  function authorityAvailable() {
    if (!authority.enabled) return false;
    if (authorityReady()) return true;
    const record = authorityRecord();
    return record !== undefined && record.phase === 'starting';
  }

  /**
   * 审计：一行一条 JSON；写失败不影响通道本身。
   * @param {Record<string, unknown>} entry
   */
  async function audit(entry) {
    try {
      await mkdir(dirname(auditFile), { recursive: true });
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
      await appendFile(auditFile, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch { /* 审计失败不阻断 */ }
  }

  /**
   * 清掉几天前的临时目录（异常退出留下的 spec/日志）。
   */
  async function sweepTempRoot() {
    try {
      const entries = await readdir(tempRoot, { withFileTypes: true });
      const cutoff = Date.now() - 3 * 24 * 60 * 60_000;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(tempRoot, entry.name);
        try {
          const info = await stat(dir);
          if (info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
        } catch { /* 忽略单个目录 */ }
      }
    } catch { /* 目录还不存在 */ }
  }

  void sweepTempRoot();

  /**
   * @param {any} record
   * @param {string} text
   */
  function setError(record, text) {
    record.phase = 'error';
    record.lastError = text;
    record.client?.close();
    record.client = null;
    record.brokerPid = null;
  }

  /**
   * 启动失败后的收尾（保留记录以便 UI 展示错误；下次拨开时替换）。
   * @param {any} record
   * @param {unknown} error
   */
  function handleStartFailure(record, error) {
    if (record.cancelled) return;
    const message = error instanceof Error ? error.message : String(error);
    setError(record, message);
    record.queue = Promise.resolve();
    void audit({ event: 'start-failed', sessionId: record.sessionId, error: message });
    // 启动授权失败（含用户点「否」）：记下 declined，本次进程内不再自动追问，
    // 避免每次会话拨开关都弹一次 UAC 骚扰用户。用户可在工作箱里手动重试。
    if (record.sessionId === AUTHORITY_KEY) {
      authority.phase = 'error';
      authority.lastError = message;
      authority.declined = true;
      attached.clear();
    }
    logger.warn(`dsh-admin-channel: 会话 ${shortSession(record.sessionId)} 通道启动失败：${message}`);
  }

  /**
   * 通道断开（broker 退出 / 管道坏掉）：不再保留半死状态。
   * @param {any} record
   * @param {Error} error
   */
  function markLost(record, error) {
    if (record.cancelled || record.phase === 'stopping') return;
    if (record.phase !== 'running' && record.phase !== 'starting') return;
    record.phase = 'error';
    record.lastError = `提权进程已退出：${error.message}`;
    record.exited = true;
    record.client = null;
    record.brokerPid = null;
    clearIdle(record);
    // 授权断开：所有挂载会话立刻回落（拨开关会另起一条或重走 UAC）。
    if (record.sessionId === AUTHORITY_KEY) {
      authority.phase = 'error';
      authority.lastError = record.lastError;
      attached.clear();
    }
    void audit({ event: 'channel-lost', sessionId: record.sessionId, error: error.message });
    logger.warn(`dsh-admin-channel: 会话 ${shortSession(record.sessionId)} 通道断开：${error.message}`);
  }

  /**
   * @param {any} record
   */
  function clearIdle(record) {
    if (record.idleTimer !== null) {
      clearTimeout(record.idleTimer);
      record.idleTimer = null;
    }
  }

  /**
   * 每次有效执行后重置空闲计时；到点由 host 主动关闭（broker 不自己猜业务）。
   * `idleTimeoutMs <= 0`（不限时，v9 起的默认）时不设计时器：通道只随会话销毁 /
   * 用户拨关 / 插件卸载 / host 退出关闭。
   *
   * v11 特例：**常驻授权**的「空闲」含义不同——只要还有会话挂载在它上面，它就不算
   * 空闲（那些会话随时可能发命令），到点时**重新计时**而不是关掉共享进程；
   * 只有真的没人挂载时才按用户配置的 idleTimeoutMs 关闭。
   * @param {any} record
   */
  function resetIdle(record) {
    clearIdle(record);
    if (settings.idleTimeoutMs <= 0) return;
    record.idleTimer = setTimeout(() => {
      if (record.sessionId === AUTHORITY_KEY && attached.size > 0) {
        resetIdle(record);   // 还有人挂载：继续等，绝不断掉共享提权进程
        return;
      }
      logger.info(`dsh-admin-channel: 会话 ${shortSession(record.sessionId)} 空闲超时，关闭通道`);
      void stop(record.sessionId, 'idle');
    }, settings.idleTimeoutMs);
    record.idleTimer.unref?.();
  }

  /**
   * 尝试连接并握手；管道还没建好时返回 null（上层重试）。
   * 这里的 1.2s/5s 只是**单次探测**的窗口（连不上就重试、握手不回就重试），
   * 不是隧道的时间限制：整体「等多久 UAC」由 waitForBroker 的 uacTimeoutMs 决定
   * （v9 默认 0 = 不限时）。5s 的 ready 窗口保留是为了防「假 broker 抢占管道」：
   * 真 broker 在 host 连上之前就已经完成 UAC 提权，auth→ready 是微秒级。
   * @param {any} record
   * @returns {Promise<{ client: PipeClient, ready: any } | null>}
   */
  async function tryConnect(record) {
    const client = new PipeClient();
    try {
      await client.connect(record.pipePath, 1_200);
    } catch {
      client.close();
      return null;
    }
    try {
      client.send({ type: 'auth', token: record.token });
      const ready = await client.waitFor((message) => message.type === 'ready', 5_000, 'broker 握手');
      if (settings.requireElevation && ready.elevated !== true) {
        client.close();
        throw new ChannelStartError('提权进程没有管理员权限（UAC 未生效或策略阻止）');
      }
      return { client, ready };
    } catch (error) {
      client.close();
      if (error instanceof ChannelStartError) throw error;
      return null;
    }
  }

  /**
   * UAC 结果文件（launch.ps1 写入）。
   * @param {any} record
   * @returns {Promise<any | null>}
   */
  async function readLaunchResult(record) {
    try {
      const text = await readFile(join(record.tempDir, 'launch.json'), 'utf8');
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * @param {any} launch
   * @returns {string}
   */
  function launchErrorText(launch) {
    const code = String(launch?.code ?? '');
    const error = String(launch?.error ?? '').trim();
    if (code === 'uac-cancelled' || /cancel|1223|0x800704C7|取消/i.test(error)) {
      return 'UAC 授权被取消（需要点击「是」）';
    }
    return error === '' ? 'UAC 启动失败（未知原因）' : `UAC 启动失败：${error}`;
  }

  /**
   * 在后台等待 broker 连上来（UAC 可能让用户想一会儿）。
   * `uacTimeoutMs <= 0` = 不限时：一直等用户点「是」，不掐表；期间 host 拨关或
   * 会话销毁会由 record.cancelled 收敛，broker 侧靠 cancel/spec 删除退出。
   * @param {any} record
   */
  async function waitForBroker(record) {
    // 0/负值 = 不限时：不设 deadline，只在 cancelled 时退出。
    const deadline = settings.uacTimeoutMs > 0 ? Date.now() + settings.uacTimeoutMs : Infinity;
    let launchSeen = null;
    while (!record.cancelled) {
      if (launchSeen === null) {
        const launch = await readLaunchResult(record);
        if (launch !== null) {
          launchSeen = launch;
          if (launch.ok === false) throw new ChannelStartError(launchErrorText(launch));
          if (Number.isFinite(launch.pid)) record.elevatedPid = Number(launch.pid);
        }
      }
      if (record.cancelled) return;
      const connected = await tryConnect(record);
      if (connected !== null) {
        if (record.cancelled) {
          connected.client.close();
          return;
        }
        record.client = connected.client;
        record.phase = 'running';
        record.elevated = connected.ready.elevated === true;
        record.brokerPid = Number.isFinite(connected.ready.pid) ? Number(connected.ready.pid) : null;
        record.startedAt = Date.now();
        record.user = typeof connected.ready.user === 'string' ? connected.ready.user : null;
        record.lastActivityAt = Date.now();
        record.lastError = null;
        record.client.onClose((error) => markLost(record, error));
        resetIdle(record);
        // 授权记录就绪：把授权自身状态对齐（authorityStatus 以记录为准，这里只是
        // 保证 ensureAuthority 的幂等判断与 declined 标记不会停留在 starting）。
        if (record.sessionId === AUTHORITY_KEY) {
          authority.phase = 'running';
          authority.startedAt = record.startedAt;
          authority.lastError = null;
          authority.declined = false;
        }
        void audit({
          event: 'start',
          sessionId: record.sessionId,
          brokerPid: record.brokerPid,
          elevated: record.elevated,
          user: record.user,
        });
        logger.info(`dsh-admin-channel: 会话 ${shortSession(record.sessionId)} 通道就绪（pid=${record.brokerPid} elevated=${record.elevated}）`);
        return;
      }
      if (Date.now() > deadline) {
        throw new ChannelStartError(`等待 UAC 授权超时（${Math.round(settings.uacTimeoutMs / 1000)} 秒）：请确认 UAC 窗口已点「是」`);
      }
      await sleep(350);
    }
  }

  /**
   * 建一条 broker 记录 + spec + 拉起启动器，并在后台等握手（不阻塞调用方）。
   * `start()`（会话自建通道）与 `ensureAuthority()`（启动时的常驻授权）共用这里，
   * 保证两条路径走**完全相同**的安全代码（同一 broker.ps1、同一令牌与 PID 校验）。
   * @param {string} key 记录键：sessionId 或 AUTHORITY_KEY
   * @param {any} existing 需要被替换掉的旧记录（可空）
   * @returns {Promise<any>} statusOf(key)
   */
  async function spawnBrokerRecord(key, existing) {
    const nonce = randomBytes(8).toString('hex');
    const pipeName = `dsh-admin-channel-${nonce}`;
    const token = randomBytes(32).toString('hex');
    const tempDir = join(tempRoot, nonce);
    const specPath = join(tempDir, 'spec.json');

    const record = {
      sessionId: key,
      phase: 'starting',
      pipeName,
      pipePath: `\\\\.\\pipe\\${pipeName}`,
      token,
      tempDir,
      specPath,
      createdAt: Date.now(),
      startedAt: null,
      elevated: false,
      brokerPid: null,
      launcherPid: null,
      elevatedPid: null,
      client: null,
      user: null,
      lastActivityAt: null,
      lastCommand: null,
      lastExitCode: null,
      lastError: null,
      cancelled: false,
      exited: false,
      queue: Promise.resolve(),
      idleTimer: null,
      launchSeen: false,
      startPromise: null,
    };
    records.set(key, record);

    try {
      await mkdir(tempDir, { recursive: true });
      const spec = {
        version: 1,
        pipeName,
        token,
        ownerPid: process.pid,
        ownerUser,
        brokerPath: BROKER_PATH,
        tempDir,
        maxOutputBytes: settings.maxOutputBytes,
        // broker 等 host 连上来的预算。0 = 不限时（v9：不再偷偷给 +30s 的死线）；
        // broker 会持续校验 ownerPid 与 cancel/spec，host 没了它自己退出。
        connectTimeoutMs: settings.uacTimeoutMs > 0 ? settings.uacTimeoutMs + 30_000 : 0,
        createdAt: new Date().toISOString(),
      };
      await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      setError(record, `无法创建通道临时文件：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }

    // 拉起启动器（生产 = UAC；测试 = 直接起 broker）。非阻塞：结果由 waitForBroker 收。
    try {
      const child = await launch({ specPath, powershell });
      if (child !== null && child !== undefined) {
        record.launcherPid = Number.isFinite(child.pid) ? Number(child.pid) : null;
        if (typeof child.on === 'function') {
          child.on('error', (error) => {
            if (records.get(key) === record) {
              setError(record, `无法启动 UAC 启动器：${error.message}`);
            }
          });
        }
        child.unref?.();
      }
    } catch (error) {
      setError(record, `无法启动 UAC 启动器：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }

    record.startPromise = waitForBroker(record).catch((error) => handleStartFailure(record, error));
    void audit({ event: 'start-request', sessionId: key });
    return statusOf(key);
  }

  /**
   * 启动（或返回已在运行的）通道。会话通道优先**借用**常驻授权（零 UAC）；
   * 授权不可用时才为这个会话单独起一个提权进程（一次 UAC）。
   * @param {string} sessionId
   * @returns {Promise<any>} 当前状态
   */
  async function start(sessionId) {
    // ① 已挂载：授权还可用/还在等就幂等返回；授权已经没了/坏了就丢掉这次挂载，
    //    继续往下走自建通道——否则「拨关再拨开」永远恢复不了。
    if (attached.has(sessionId)) {
      if (authorityAvailable()) return statusOf(sessionId);
      attached.delete(sessionId);
    }

    const existing = records.get(sessionId);
    if (existing !== undefined && (existing.phase === 'starting' || existing.phase === 'running')) {
      return statusOf(sessionId);
    }
    if (existing !== undefined && existing.phase === 'stopping') {
      throw new Error('管理员权限通道正在关闭：请等它退出后再重新打开（不要连点）。');
    }

    // ② 授权可用**或正在等 UAC** → 直接挂载，不另起进程（否则用户会看到两次 UAC：
    //    启动那一次还没点完，会话又弹一次）。挂载后若授权最终失败，handleStartFailure
    //    会清掉挂载，会话回到「未开启」。
    if (authorityAvailable()) {
      attached.set(sessionId, AUTHORITY_KEY);
      void audit({ event: 'attach', sessionId, brokerPid: authorityRecord()?.brokerPid });
      logger.info(`dsh-admin-channel: 会话 ${shortSession(sessionId)} 挂载到常驻提权授权（零 UAC）`);
      return statusOf(sessionId);
    }

    // ③ 没有可用授权：走会话自建通道（本会话弹一次 UAC）。
    const ownActive = () => [...records.entries()]
      .filter(([key, record]) => key !== AUTHORITY_KEY
        && (record.phase === 'starting' || record.phase === 'running'))
      .map(([key]) => key);

    const active = ownActive();
    if (active.length >= settings.maxChannels) {
      const other = records.get(active[0]);
      throw new Error(
        `另一会话已开启管理员权限通道（会话 ${shortSession(other?.sessionId)}）：全局只允许 ${settings.maxChannels} 条，请先在该会话关闭。`,
      );
    }

    if (existing !== undefined) {
      await rm(existing.tempDir, { recursive: true, force: true }).catch(() => {});
      // 删除旧记录后重新检查容量：await 期间别的会话可能已经占用了槽位。
      if (ownActive().length >= settings.maxChannels) {
        throw new Error(`全局只允许 ${settings.maxChannels} 条管理员权限通道，请先关闭其它会话的通道。`);
      }
      if (records.get(sessionId) === existing) records.delete(sessionId);
    }

    return spawnBrokerRecord(sessionId, existing);
  }

  /**
   * 等 broker 真正退出（socket 关闭或进程消失）。非提权 host 无法强杀高完整性
   * 进程，所以只能靠 broker 的协作式取消（cancel 文件）来收敛。
   * @param {any} record
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async function waitForBrokerExit(record, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (record.exited === true) return true;
      if (record.client !== null && record.client.closed) return true;
      if (record.brokerPid !== null) {
        try {
          process.kill(record.brokerPid, 0);
        } catch {
          return true;
        }
      }
      if (record.client === null && record.brokerPid === null && record.elevatedPid === null) return true;
      await sleep(200);
    }
    return false;
  }

  /**
   * 关闭一条通道并清理临时文件。
   *
   * 会话**挂载在常驻授权上**时（v11）：只把自己摘下来——共享的提权进程继续为
   * 其它会话服务，绝不因为某个会话拨关就把它杀掉。授权本身只由 releaseAuthority()
   * 或插件卸载关闭。
   *
   * 关键顺序：先写 cancel 文件（broker 每 200ms 检查一次，能在执行命令期间杀掉
   * 子进程），再发 stop 消息（空闲时立刻响应），最后等 broker 真正退出。非提权
   * host 的 taskkill 打不动高完整性进程，所以未确认退出时**不谎报 off**。
   * @param {string} sessionId
   * @param {string} reason
   * @returns {Promise<any>}
   */
  async function stop(sessionId, reason) {
    // ① 挂载视图：摘下来即可（会话销毁同义——提权进程不属于这个会话）。
    if (attached.has(sessionId)) {
      attached.delete(sessionId);
      void audit({ event: 'detach', sessionId, reason });
      logger.info(`dsh-admin-channel: 会话 ${shortSession(sessionId)} 已脱离常驻提权授权（${reason}）`);
      return statusOf(sessionId);
    }

    // ② 关掉常驻授权本身：先把挂载中的会话摘掉，别让它们指向一条死通道。
    if (sessionId === AUTHORITY_KEY && attached.size > 0) {
      void audit({ event: 'detach-all', reason, attached: attached.size });
      attached.clear();
    }

    const record = records.get(sessionId);
    if (record === undefined) return statusOf(sessionId);

    record.cancelled = true;
    if (record.phase !== 'starting' && record.phase !== 'running') record.phase = 'stopping';
    clearIdle(record);

    // 1) 协作式取消：broker 在连接等待与命令等待里都会轮询这个文件。
    await writeFile(join(record.tempDir, 'cancel'), '1', 'utf8').catch(() => {});

    // 2) 还没连上（UAC 还没批 / broker 没起来）：杀掉非提权 launcher，立刻清目录；
    //    之后才被批下来的 broker 读不到 spec 或看到 cancel，会在启动阶段退出。
    if (record.client === null && record.brokerPid === null) {
      if (record.launcherPid !== null) {
        try { process.kill(record.launcherPid); } catch { /* 已经退出 */ }
      }
      if (records.get(sessionId) === record) records.delete(sessionId);
      await rm(record.tempDir, { recursive: true, force: true }).catch(() => {});
      void audit({ event: 'stop', sessionId, reason, phase: 'pre-connect' });
      logger.info(`dsh-admin-channel: 会话 ${shortSession(sessionId)} 通道在连接前取消（${reason}）`);
      return statusOf(sessionId);
    }

    // 3) 请 broker 退出（空闲时走这条；执行命令时它读不到，靠 cancel 文件）。
    if (record.client !== null) {
      try { record.client.send({ type: 'stop' }); } catch { /* 可能已断开 */ }
    }

    const exited = await waitForBrokerExit(record, 10_000);
    if (!exited) {
      record.phase = 'error';
      record.lastError = '提权进程仍在执行命令，未能确认退出；请稍后再次关闭（已写入取消标记）';
      void audit({ event: 'stop-timeout', sessionId, reason });
      logger.warn(`dsh-admin-channel: 会话 ${shortSession(sessionId)} 关闭超时（${reason}）`);
      return statusOf(sessionId);
    }

    record.client?.close();
    record.client = null;
    if (record.brokerPid !== null) {
      await killTree(record.brokerPid);
    }
    if (record.launcherPid !== null && record.launcherPid !== record.brokerPid) {
      try { process.kill(record.launcherPid); } catch { /* 已经退出 */ }
    }

    if (records.get(sessionId) === record) records.delete(sessionId);
    await rm(record.tempDir, { recursive: true, force: true }).catch(() => {});
    void audit({ event: 'stop', sessionId, reason });
    logger.info(`dsh-admin-channel: 会话 ${shortSession(sessionId)} 通道已关闭（${reason}）`);
    return statusOf(sessionId);
  }

  /**
   * 建立/复用常驻提权授权（DSH 启动时调用；工作箱的「启动授权」开关也走这里）。
   * 幂等：已在 starting/running 就原样返回。
   * @returns {Promise<any>} 授权状态（不是会话状态）
   */
  async function ensureAuthority() {
    if (authority.phase === 'running' && authorityReady()) return authorityStatus();
    if (authority.phase === 'starting' && records.get(AUTHORITY_KEY) !== undefined) return authorityStatus();

    const existing = records.get(AUTHORITY_KEY);
    if (existing !== undefined) {
      await rm(existing.tempDir, { recursive: true, force: true }).catch(() => {});
      if (records.get(AUTHORITY_KEY) === existing) records.delete(AUTHORITY_KEY);
    }

    authority.phase = 'starting';
    authority.lastError = null;
    authority.reason = null;
    attached.clear();
    // 授权重建 = 旧的挂载全部失效（旧 broker 已被上面清掉）。
    await spawnBrokerRecord(AUTHORITY_KEY, existing);
    return authorityStatus();
  }

  /**
   * 释放常驻授权（关掉提权进程）。会先把挂载中的会话摘掉，让它们回到「未开启」，
   * 而不是被误认为还在使用一条已经死掉的通道。
   * @param {string} reason
   */
  async function releaseAuthority(reason) {
    const count = attached.size;
    attached.clear();
    const record = records.get(AUTHORITY_KEY);
    if (record === undefined) {
      authority.phase = 'idle';
      authority.declined = false;
      return authorityStatus();
    }
    authority.phase = 'off';
    await stop(AUTHORITY_KEY, reason ?? 'authority-release');
    authority.phase = 'idle';
    authority.reason = reason ?? 'released';
    void audit({ event: 'authority-release', reason: reason ?? 'released', attached: count });
    logger.info(`dsh-admin-channel: 常驻提权授权已释放（${reason ?? 'released'}，先前挂载 ${count} 个会话）`);
    return authorityStatus();
  }

  /** 授权自身状态（供 statusOf 与 UI 用）。一切以记录为准，避免状态与进程脱节。 */
  function authorityStatus() {
    const record = authorityRecord();
    const ready = authorityReady();
    let phase;
    if (ready) phase = 'running';
    else if (record !== undefined) phase = record.phase;            // starting / stopping / error
    else phase = authority.phase === 'starting' ? 'starting' : 'idle';
    return {
      phase,
      enabled: authority.enabled,
      ready,
      declined: authority.declined === true,
      brokerPid: record?.brokerPid ?? null,
      elevated: record?.elevated === true,
      startedAt: record?.startedAt ?? authority.startedAt,
      lastError: record?.lastError ?? authority.lastError,
      attached: attached.size,
      /** 授权不可用时，会话拨开关会退回「本会话弹一次 UAC」的旧行为。 */
      fallbackPerSession: !ready,
    };
  }

  /** 启动时授权：只请求一次 UAC；被拒绝就不再自动追问（等用户手动拨）。 */
  function bootstrapAuthority() {
    if (!settings.startupConsent) return authorityStatus();
    void ensureAuthority().catch(() => {});
    return authorityStatus();
  }

  /**
   * taskkill 整棵进程树（broker 可能还挂着一个正在跑的命令）。
   * @param {number} pid
   */
  async function killTree(pid) {
    await new Promise((resolve) => {
      try {
        const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        child.on('error', () => resolve());
        child.on('exit', () => resolve());
      } catch {
        resolve();
      }
    });
  }

  /**
   * 把执行请求串行化（同一条通道一次只跑一条命令）。
   * @param {any} record
   * @param {() => Promise<any>} task
   * @returns {Promise<any>}
   */
  function enqueue(record, task) {
    const run = record.queue.then(task, task);
    record.queue = run.then(() => {}, () => {});
    return run;
  }

  /**
   * 解析一个会话该用哪条 broker 记录：自己的，还是挂载在常驻授权上的（v11）。
   * 授权记录存在但已经不可用（error/stopping）时**丢掉这次挂载**并回落到会话
   * 自建通道——否则会一直卡在「通道当前不可用」，即使会话已经能另起一条。
   * @param {string} sessionId
   * @returns {{ record: any, borrowed: boolean }}
   */
  function resolveRecord(sessionId) {
    const borrowKey = attached.get(sessionId);
    if (borrowKey !== undefined) {
      const shared = records.get(borrowKey);
      if (shared !== undefined && (shared.phase === 'starting' || shared.phase === 'running')) {
        return { record: shared, borrowed: true };
      }
      attached.delete(sessionId);
    }
    const own = records.get(sessionId);
    return { record: own, borrowed: false };
  }

  /**
   * 在当前会话的提权通道里执行一条命令。
   * @param {string} sessionId
   * @param {{ command: string, cwd?: string, timeoutMs?: number }} input
   * @returns {Promise<Record<string, unknown>>}
   */
  async function exec(sessionId, input) {
    const { record, borrowed } = resolveRecord(sessionId);
    if (record === undefined) {
      throw new Error(
        '本会话没有开启「管理员权限通道」。请让用户在输入框工具行的「工作箱」里打开「管理员权限通道」开关'
        + '（启动授权已就绪时拨开关不会弹 UAC）。在用户完成授权前不要执行提权操作，'
        + '也不要用 runas / 计划任务 / 服务等方式绕过。',
      );
    }
    if (record.phase === 'starting') {
      throw new Error(borrowed
        ? '「管理员权限通道」正在等待**启动时那一次** UAC 授权：请让用户在 UAC 窗口点「是」（或取消它），点完即自动可用；不要重复拨开关，也不要另起提权方式。'
        : '「管理员权限通道」正在等待 UAC 授权：请让用户在 UAC 窗口点击「是」后重试。不要重复拨开关。');
    }
    if (record.phase !== 'running' || record.client === null) {
      throw new Error(
        `「管理员权限通道」当前不可用${record.lastError === null ? '' : `：${record.lastError}`}。`
        + '请让用户在工作箱里关闭再打开开关重试；不要用其它方式自行提权。',
      );
    }

    // v9：单条命令默认**不限时**。语义：
    //   · 模型显式给正数 timeout_ms → 用它（并受 maxExecTimeoutMs 约束，若该上限>0）；
    //   · 模型显式给 0 / 负数 → 视为「不限时」；
    //   · 没给 → settings.execTimeoutMs（默认 0 = 不限时）。
    // 超过 24h 的正数按「不限时」处理：Node 的 setTimeout 只吃 32 位有符号整数，
    // 1e12 这类数值会被夹成 1ms 立刻超时（连带 exec-failure 把整条通道关掉）。
    const requested = Number(input.timeoutMs);
    let timeoutMs;
    if (Number.isFinite(requested) && requested > 0) {
      timeoutMs = requested > ABSOLUTE_EXEC_MS ? 0 : Math.floor(requested);
      if (timeoutMs > 0 && settings.maxExecTimeoutMs > 0) {
        timeoutMs = Math.min(settings.maxExecTimeoutMs, Math.max(1_000, timeoutMs));
      }
    } else {
      timeoutMs = settings.execTimeoutMs;
    }
    const command = String(input.command ?? '');
    const cwd = typeof input.cwd === 'string' && input.cwd.trim() !== '' ? input.cwd.trim() : undefined;

    return enqueue(record, async () => {
      if (record.client === null || record.phase !== 'running') {
        throw new Error('「管理员权限通道」在执行前已关闭。请让用户重新打开工作箱里的开关。');
      }
      const startedAt = Date.now();
      let response;
      try {
        response = await record.client.request(
          { type: 'exec', command, cwd: cwd ?? '', timeoutMs },
          // 不限时（0）时透传 0：pipe-client 不设计时器，靠管道关闭/broker 退出收敛。
          timeoutMs > 0 ? timeoutMs + 20_000 : 0,
          '提权命令执行',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 传输层失败 = 管道已断（broker 退出或握手坏掉）。让 stop() 收敛：会话自建
        // 通道会关掉进程；挂载在授权上的会话只摘挂载，进程由 markLost 处理。
        void stop(sessionId, 'exec-failure').catch(() => {});
        throw new Error(borrowed
          ? `「管理员权限通道」执行失败（${message}）。本会话已从常驻提权进程摘除，请让用户重新打开开关（授权仍在时不会再弹 UAC）。`
          : `「管理员权限通道」执行失败（${message}）。通道已关闭，请让用户重新打开开关。`);
      }

      if (response === null || typeof response !== 'object' || response.ok !== true) {
        const message = String(response?.error ?? '未知错误');
        throw new Error(`提权命令执行失败：${message}`);
      }

      if (response.cancelled === true) {
        throw new Error('提权命令被取消：管理员权限通道已关闭（命令进程树已被终止）');
      }

      record.lastActivityAt = Date.now();
      record.lastCommand = truncate(command, 200);
      record.lastExitCode = Number.isFinite(response.exitCode) ? Number(response.exitCode) : null;
      resetIdle(record);

      const durationMs = Number.isFinite(response.durationMs) ? Number(response.durationMs) : Date.now() - startedAt;
      const stdout = typeof response.stdout === 'string' ? response.stdout : '';
      const stderr = typeof response.stderr === 'string' ? response.stderr : '';
      const truncated = response.stdoutTruncated === true || response.stderrTruncated === true;
      void audit({
        event: 'exec',
        sessionId,
        command: truncate(command, 500),
        cwd: cwd ?? null,
        exitCode: record.lastExitCode,
        timedOut: response.timedOut === true,
        durationMs,
        truncated,
      });

      return {
        ok: true,
        sessionId,
        elevated: record.elevated === true,
        command,
        cwd: cwd ?? null,
        exitCode: record.lastExitCode,
        stdout,
        stderr,
        timedOut: response.timedOut === true,
        durationMs,
        truncated,
      };
    });
  }

  /**
   * 当前会话的通道状态（工作箱每 8 秒读一次；必须是纯读、无副作用）。
   * @param {string} sessionId
   * @returns {Record<string, unknown>}
   */
  function statusOf(sessionId) {
    const own = typeof sessionId === 'string' && sessionId !== '' ? records.get(sessionId) : undefined;
    const borrowKey = typeof sessionId === 'string' ? attached.get(sessionId) : undefined;
    const shared = borrowKey === undefined ? undefined : records.get(borrowKey);
    const record = shared ?? own;
    const borrowed = shared !== undefined;
    const auth = authorityStatus();
    // 计数口径：常驻授权不算「会话通道」，否则 maxChannels=1 时第二个会话会被拒。
    const active = [...records.entries()]
      .filter(([key, candidate]) => key !== AUTHORITY_KEY
        && (candidate.phase === 'starting' || candidate.phase === 'running'))
      .map(([, candidate]) => candidate);

    if (record === undefined) {
      const other = active.find((candidate) => candidate.sessionId !== sessionId);
      const canBorrow = settings.startupConsent && authorityAvailable();
      return {
        sessionId: sessionId === '' ? null : sessionId,
        phase: 'off',
        running: false,
        armed: false,
        available: true,
        elevated: false,
        brokerPid: null,
        startedAt: null,
        lastActivityAt: null,
        lastCommand: null,
        lastExitCode: null,
        lastError: null,
        activeChannels: active.length,
        maxChannels: settings.maxChannels,
        /** 0 = 不限时（不因空闲自动关闭）。 */
        idleTimeoutMs: settings.idleTimeoutMs,
        // v11：授权就绪时拨开关**不弹 UAC**，这行说明就是给用户看的差异。
        borrowed: false,
        authority: auth,
        note: canBorrow
          ? '未开启：常驻提权授权已就绪，拨开关即可用（不会弹 UAC）。'
          : other === undefined
            ? '未开启：在「工作箱」打开开关后会弹出一次 UAC 授权。'
            : `另一会话（${shortSession(other.sessionId)}）已开启通道：全局只允许 ${settings.maxChannels} 条，请先在那里关闭。`,
        hint: canBorrow
          ? '拨开即用：复用常驻提权进程，零弹窗'
          : other === undefined
            ? '打开开关：弹出一次 UAC 确认；授权后本会话的提权命令不再确认'
            : '先关闭另一会话的通道',
      };
    }

    const phase = record.phase;
    const running = phase === 'starting' || phase === 'running';
    const startedText = record.startedAt === null
      ? ''
      : new Date(record.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const note = borrowed
      ? phase === 'running'
        ? `已开启（挂载常驻授权，零弹窗）：PID ${record.brokerPid ?? '?'}${startedText === '' ? '' : `，${startedText} 启动`}，${attached.size} 个会话共用。`
        : phase === 'starting'
          ? '正在等待启动时的管理员授权：请在 UAC 窗口点击「是」（整个 DSH 生命周期只弹这一次）。'
          : `常驻授权不可用：${record.lastError ?? '未知原因'}`
      : phase === 'starting'
        ? '正在请求管理员授权：请在 UAC 窗口点击「是」（只会弹这一次）。'
        : phase === 'running'
          ? `已开启：通道运行中（PID ${record.brokerPid ?? '?'}${startedText === '' ? '' : `，${startedText} 启动`}）。本会话的提权命令不再逐次确认。`
          : phase === 'stopping'
            ? '正在关闭管理员权限通道…'
            : `启动失败：${record.lastError ?? '未知原因'}。可重新拨开开关重试。`;
    const hint = borrowed
      ? phase === 'running'
        ? '关闭开关只摘除本会话；提权进程继续为其它会话服务'
        : '等待启动授权完成'
      : phase === 'starting'
        ? `等待 UAC 授权（${settings.uacTimeoutMs > 0 ? `最长 ${durationText(settings.uacTimeoutMs)}` : '不限时，慢慢点'}）`
        : phase === 'running'
          ? '关闭开关会结束提权进程并清除通道'
          : '可重新拨开开关重试';

    return {
      sessionId,
      phase,
      running,
      armed: phase === 'starting',
      available: true,
      elevated: record.elevated === true,
      brokerPid: record.brokerPid,
      startedAt: record.startedAt,
      lastActivityAt: record.lastActivityAt,
      lastCommand: record.lastCommand,
      lastExitCode: record.lastExitCode,
      lastError: record.lastError,
      activeChannels: active.length,
      maxChannels: settings.maxChannels,
      /** 0 = 不限时（不因空闲自动关闭）。 */
      idleTimeoutMs: settings.idleTimeoutMs,
      borrowed,
      authority: auth,
      note,
      hint,
    };
  }

  /**
   * 插件卸载：尽力关闭全部通道**与常驻授权**（不等待用户）。
   * @returns {Promise<void>}
   */
  async function disposeAll() {
    const ids = [...records.keys()];
    await Promise.all(ids.map((id) => stop(id, 'plugin-dispose').catch(() => {})));
    attached.clear();
    authority.phase = 'idle';
  }

  return {
    settings,
    auditFile,
    start,
    stop,
    exec,
    statusOf,
    /** 该键是否已有通道记录（含挂载在授权上的会话，v11）。 */
    has: (sessionId) => typeof sessionId === 'string'
      && (records.has(sessionId) || attached.has(sessionId)),
    // ── 常驻提权授权（v11）───────────────────────────────────────────────
    ensureAuthority,
    releaseAuthority,
    authorityStatus,
    bootstrapAuthority,
    isBorrowed: (sessionId) => attached.has(sessionId),
    disposeAll,
    get recordCount() {
      return records.size;
    },
  };
}
