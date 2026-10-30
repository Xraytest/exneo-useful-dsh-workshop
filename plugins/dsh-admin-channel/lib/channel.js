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
 *   · 空闲超时（idleTimeoutMs，默认 30 分钟）；
 *   · 插件卸载 / 重载；
 *   · broker 退出或管道断开（状态转为 error，等用户重新开启）。
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

import { PipeClient } from './pipe-client.js';

/** 本包根目录（lib/ 的上一级）。 */
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));
const BROKER_PATH = join(PLUGIN_DIR, 'broker.ps1');
const LAUNCH_PATH = join(PLUGIN_DIR, 'launch.ps1');

/** 启动失败但可重试时抛的错（用于区分“连接还没起来”和“真的失败”）。 */
class ChannelStartError extends Error {}

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
 * 默认配置。patch 里可以逐项覆盖（没有 Config schema，未知字段被忽略）。
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
    uacTimeoutMs: number('uacTimeoutMs', 120_000, 10_000, 600_000),
    idleTimeoutMs: number('idleTimeoutMs', 30 * 60_000, 5_000, 24 * 60 * 60_000),
    maxChannels: number('maxChannels', 1, 1, 8),
    execTimeoutMs: number('execTimeoutMs', 120_000, 1_000, 1_800_000),
    maxExecTimeoutMs: number('maxExecTimeoutMs', 1_800_000, 1_000, 3_600_000),
    maxOutputBytes: number('maxOutputBytes', 262_144, 4_096, 4_194_304),
    requireElevation: raw.requireElevation !== false,
  };
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
   * @param {any} record
   */
  function resetIdle(record) {
    clearIdle(record);
    record.idleTimer = setTimeout(() => {
      logger.info(`dsh-admin-channel: 会话 ${shortSession(record.sessionId)} 空闲超时，关闭通道`);
      void stop(record.sessionId, 'idle');
    }, settings.idleTimeoutMs);
    record.idleTimer.unref?.();
  }

  /**
   * 尝试连接并握手；管道还没建好时返回 null（上层重试）。
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
   * @param {any} record
   */
  async function waitForBroker(record) {
    const deadline = Date.now() + settings.uacTimeoutMs;
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
   * 启动（或返回已在运行的）通道。异步等待在后台进行；这里只同步走到“已提交”。
   * @param {string} sessionId
   * @returns {Promise<any>} 当前状态
   */
  async function start(sessionId) {
    const existing = records.get(sessionId);
    if (existing !== undefined && (existing.phase === 'starting' || existing.phase === 'running')) {
      return statusOf(sessionId);
    }
    if (existing !== undefined && existing.phase === 'stopping') {
      throw new Error('管理员权限通道正在关闭：请等它退出后再重新打开（不要连点）。');
    }

    const activeCount = () => [...records.values()]
      .filter((record) => record.phase === 'starting' || record.phase === 'running').length;

    if (activeCount() >= settings.maxChannels) {
      const other = [...records.values()].find((record) => record.phase === 'starting' || record.phase === 'running');
      throw new Error(
        `另一会话已开启管理员权限通道（会话 ${shortSession(other?.sessionId)}）：全局只允许 ${settings.maxChannels} 条，请先在该会话关闭。`,
      );
    }

    if (existing !== undefined) {
      await rm(existing.tempDir, { recursive: true, force: true }).catch(() => {});
      // 删除旧记录后重新检查容量：await 期间别的会话可能已经占用了槽位。
      if (activeCount() >= settings.maxChannels) {
        throw new Error(`全局只允许 ${settings.maxChannels} 条管理员权限通道，请先关闭其它会话的通道。`);
      }
      if (records.get(sessionId) === existing) records.delete(sessionId);
    }

    const nonce = randomBytes(8).toString('hex');
    const pipeName = `dsh-admin-channel-${nonce}`;
    const token = randomBytes(32).toString('hex');
    const tempDir = join(tempRoot, nonce);
    const specPath = join(tempDir, 'spec.json');

    const record = {
      sessionId,
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
    records.set(sessionId, record);

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
        connectTimeoutMs: settings.uacTimeoutMs + 30_000,
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
            if (records.get(sessionId) === record) {
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
    void audit({ event: 'start-request', sessionId });
    return statusOf(sessionId);
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
   * 关键顺序：先写 cancel 文件（broker 每 200ms 检查一次，能在执行命令期间杀掉
   * 子进程），再发 stop 消息（空闲时立刻响应），最后等 broker 真正退出。非提权
   * host 的 taskkill 打不动高完整性进程，所以未确认退出时**不谎报 off**。
   * @param {string} sessionId
   * @param {string} reason
   * @returns {Promise<any>}
   */
  async function stop(sessionId, reason) {
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
   * 在当前会话的提权通道里执行一条命令。
   * @param {string} sessionId
   * @param {{ command: string, cwd?: string, timeoutMs?: number }} input
   * @returns {Promise<Record<string, unknown>>}
   */
  async function exec(sessionId, input) {
    const record = records.get(sessionId);
    if (record === undefined) {
      throw new Error(
        '本会话没有开启「管理员权限通道」。请让用户在输入框工具行的「工作箱」里打开「管理员权限通道」开关'
        + '（会弹出一次 UAC 确认）。在用户完成授权前不要执行提权操作，也不要用 runas / 计划任务 / 服务等方式绕过。',
      );
    }
    if (record.phase === 'starting') {
      throw new Error('「管理员权限通道」正在等待 UAC 授权：请让用户在 UAC 窗口点击「是」后重试。不要重复拨开关。');
    }
    if (record.phase !== 'running' || record.client === null) {
      throw new Error(
        `「管理员权限通道」当前不可用${record.lastError === null ? '' : `：${record.lastError}`}。`
        + '请让用户在工作箱里关闭再打开开关重试；不要用其它方式自行提权。',
      );
    }

    const timeoutMs = Math.min(
      settings.maxExecTimeoutMs,
      Math.max(1_000, Math.floor(Number(input.timeoutMs) || settings.execTimeoutMs)),
    );
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
          timeoutMs + 20_000,
          '提权命令执行',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void stop(sessionId, 'exec-failure');
        throw new Error(`「管理员权限通道」执行失败（${message}）。通道已关闭，请让用户重新打开开关。`);
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
    const record = typeof sessionId === 'string' && sessionId !== '' ? records.get(sessionId) : undefined;
    const active = [...records.values()].filter((candidate) => candidate.phase === 'starting' || candidate.phase === 'running');

    if (record === undefined) {
      const other = active.find((candidate) => candidate.sessionId !== sessionId);
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
        note: other === undefined
          ? '未开启：在「工作箱」打开开关后会弹出一次 UAC 授权。'
          : `另一会话（${shortSession(other.sessionId)}）已开启通道：全局只允许 ${settings.maxChannels} 条，请先在那里关闭。`,
        hint: other === undefined
          ? '打开开关：弹出一次 UAC 确认；授权后本会话的提权命令不再确认'
          : '先关闭另一会话的通道',
      };
    }

    const phase = record.phase;
    const running = phase === 'starting' || phase === 'running';
    const startedText = record.startedAt === null
      ? ''
      : new Date(record.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const note = phase === 'starting'
      ? '正在请求管理员授权：请在 UAC 窗口点击「是」（只会弹这一次）。'
      : phase === 'running'
        ? `已开启：通道运行中（PID ${record.brokerPid ?? '?'}${startedText === '' ? '' : `，${startedText} 启动`}）。本会话的提权命令不再逐次确认。`
        : phase === 'stopping'
          ? '正在关闭管理员权限通道…'
          : `启动失败：${record.lastError ?? '未知原因'}。可重新拨开开关重试。`;
    const hint = phase === 'starting'
      ? '等待 UAC 授权（最长 2 分钟）'
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
      note,
      hint,
    };
  }

  /**
   * 插件卸载：尽力关闭全部通道（不等待用户）。
   * @returns {Promise<void>}
   */
  async function disposeAll() {
    const ids = [...records.keys()];
    await Promise.all(ids.map((id) => stop(id, 'plugin-dispose').catch(() => {})));
  }

  return {
    settings,
    auditFile,
    start,
    stop,
    exec,
    statusOf,
    /** 该键是否已有通道记录（含 starting/running/error/stopping），供工具解析会话身份。 */
    has: (sessionId) => typeof sessionId === 'string' && records.has(sessionId),
    disposeAll,
    get recordCount() {
      return records.size;
    },
  };
}
