/**
 * dsh-plugin-autoupdate —— 插件源有新版本自动更新（host 半边，v1）。
 *
 * 用户指令（2026-10-22）：
 *   「编写插件自动更新插件在插件源有插件有新版本自动更新。」
 *
 * 职责：监看 profile 里已安装的 bundle，发现「插件源」有新版本就自动更新。
 *
 * 「插件源」在本机有两类（都支持，语义不同）：
 *   · **link: 目录源**（本仓库 plugins/*）：pnpm 的 link: 依赖**不会**把文件复制进
 *     profile——它直接指向源目录，所以「源目录的 package.json 版本」就是已装版本。
 *     自动更新 = 用户在源目录里改了代码/升了版本之后**点一下**（或定时器触发）
 *     「同步」，本插件做三件事：
 *       ① removeBundle → installBundle（让 pnpm 重新解析 link:，拿到新 manifest）；
 *       ② profile 的 cordis.patch.yml **不动**（行 id 与 name 保持用户版本）；
 *       ③ 重新安装后由 loader 的 patchReload=live 热生效（application: applied）。
 *     版本没变时不重装（pnpm 会报 ambiguous-install）。
 *   · **git / npm / tarball 源**：检查远端（git: ls-remote 取 HEAD sha；npm:
 *     registry 元数据取 latest）对比**安装时记录的版本**（本插件维护一份
 *     $DSH_HOME/plugin-autoupdate/installed.json 的快照），有新版本 → 调
 *     ctx.get('pluginManager').installBundle(同一 spec)。
 *
 * 安全边界（刻意保守）：
 *   · **默认只自动更新 link: 目录源**（本机开发流）；git/npm 的自动应用要
 *     config.autoApplyRemote=true（默认 false，只报告不安装）。
 *   · 更新走 pluginManager 的公开服务（与设置页同一入口，享有它的文件锁、
 *     兼容性检查、回滚），不绕过任何审批面。
 *   · 每轮检查串行、失败只记日志与 /status，绝不阻塞 dsh 启动。
 *
 * 状态与路由：
 *   状态在内存（快照对比表），历史落 $DSH_HOME/plugin-autoupdate/history.json。
 *   GET  /dsh-plugin-autoupdate/status   → 当前快照 + 上轮检查结果
 *   POST /dsh-plugin-autoupdate/check    → 立刻跑一轮检查（含更新应用）
 *   POST /dsh-plugin-autoupdate/apply    → { name } 只应用一个 bundle 的更新
 *
 * 交接：改 host 实现要新写 entry-v<N+1>.js（?v= +1）并把 patch 里
 * `plugin-autoupdate` 行指过去（row id 不变）。
 *
 * @module dsh-plugin-autoupdate
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const name = 'plugin-autoupdate';
export const inject = ['webServer'];

const ROUTE = '/dsh-plugin-autoupdate';
const MAX_HISTORY = 50;

// ── 小件 ───────────────────────────────────────────────────────────────────

function errorText(error) {
  return String(error instanceof Error ? error.message : error);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  if (origin === 'null') return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const jsonOf = (res) => (status, value) => {
  if (res.headersSent === true) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};

function readBody(req, limit) {
  return new Promise((settle) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => { if (!done) { done = true; settle(value); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, error: '请求体过大' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', (cause) => finish({ ok: false, error: errorText(cause) }));
  });
}

/** x.y.z（容错 pre-release/build 尾巴）→ 可比较的数字数组；解析不了 → null。 */
function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return left === null && right === null ? 0 : left === null ? -1 : 1;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

// ── 安装账本（installed.json：name → { spec, version, at }） ───────────────

function ledgerFile() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'plugin-autoupdate', 'installed.json');
}

function readLedger(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = parsed.entries;
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return {};
    const out = {};
    for (const [name, value] of Object.entries(entries)) {
      if (typeof name !== 'string' || value === null || typeof value !== 'object') continue;
      out[name] = {
        spec: typeof value.spec === 'string' ? value.spec : '',
        version: typeof value.version === 'string' ? value.version : '',
        at: Number.isFinite(value.at) ? value.at : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeLedgerAtomic(file, entries) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function historyFile() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'plugin-autoupdate', 'history.json');
}

function readHistory(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.applied) ? parsed.applied : [];
  } catch {
    return [];
  }
}

function recordHistory(file, entry) {
  const applied = [...readHistory(file), entry].slice(-MAX_HISTORY);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify({ applied }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// ── 远端检查 ───────────────────────────────────────────────────────────────

/** git 源：ls-remote 取 HEAD sha（GitHub 走 api.github.com 由 pluginManager 自查）。 */
async function gitHead(spec, signal) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', spec, 'HEAD'], { signal, timeout: 15000 });
    const line = stdout.split('\n')[0]?.trim() ?? '';
    return line.split(/\s+/)[0] ?? '';
  } catch {
    return '';
  }
}

/** npm 源：registry 元数据取 dist-tags.latest。spec 形如 name / name@range / name@url。 */
async function npmLatest(spec, signal) {
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  if (name === '' || name.startsWith('@') && at === 0) return '';
  try {
    const response = await fetch(`https://registry.npmmirror.com/${encodeURIComponent(name).replace('%40', '@')}`, {
      signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return '';
    const meta = await response.json();
    const latest = meta?.['dist-tags']?.latest;
    return typeof latest === 'string' ? latest : '';
  } catch {
    return '';
  }
}

// ── 插件主体 ───────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const log = (level, message, extra) => {
    const line = `[plugin-autoupdate] ${message}`;
    try {
      const logger = ctx.logger;
      const sink = logger?.[level];
      if (typeof sink === 'function') {
        if (extra !== undefined) sink.call(logger, line, extra);
        else sink.call(logger, line);
      }
    } catch { /* 日志不是关键路径 */ }
  };

  const autoApplyRemote = config.autoApplyRemote === true;
  const intervalMs = Number.isFinite(config.intervalMs) && config.intervalMs > 0 ? config.intervalMs : 6 * 3600 * 1000;
  const ledger = ledgerFile();
  const history = historyFile();
  const profileDir = ctx.profileContext?.dir ?? process.env.DSH_PROFILE_DIR ?? '';

  let running = false;
  let lastCheck = null;
  const notes = [];
  const note = (message) => {
    notes.push(message);
    if (notes.length > 30) notes.splice(0, notes.length - 30);
  };

  /** 读 profile package.json 的依赖表（name → spec）。 */
  const readDependencies = () => {
    try {
      const parsed = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
      const deps = parsed?.dependencies;
      if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) return {};
      return Object.fromEntries(Object.entries(deps).filter(([, value]) => typeof value === 'string'));
    } catch {
      return {};
    }
  };

  /** 读 profile manifest 的 bundle 列表（只有这些算「已安装」）。 */
  const readBundles = () => {
    try {
      const parsed = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
      const bundles = parsed?.dsh?.profile?.bundles;
      return Array.isArray(bundles) ? bundles.filter((name) => typeof name === 'string') : [];
    } catch {
      return [];
    }
  };

  const manager = () => {
    const service = ctx.get('pluginManager');
    if (service === undefined || typeof service.installBundle !== 'function') return undefined;
    return service;
  };

  /**
   * 一轮检查。
   *
   * link: 源不比版本——link 本来就是活的（源目录改了，重装就拿到新的）；
   * 但**记录**它当前版本，供 git/npm 对比与 UI 展示。git/npm 源才比
   * 「安装账本里的版本」与「远端 latest」。
   */
  async function runCheck(applyUpdates) {
    const dependencies = readDependencies();
    const bundles = readBundles();
    const known = readLedger(ledger);
    const results = [];
    for (const name of bundles) {
      const spec = dependencies[name] ?? '';
      const entry = { name, spec, kind: 'unknown', current: '', latest: '', updateAvailable: false, note: '' };
      if (spec.startsWith('link:')) {
        entry.kind = 'link';
        const dir = spec.slice('link:'.length);
        try {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
          entry.current = typeof pkg.version === 'string' ? pkg.version : '';
        } catch (cause) {
          entry.note = `源目录读不到（${errorText(cause)}）`;
        }
        if (known[name]?.version !== entry.current) entry.updateAvailable = known[name]?.version !== undefined;
      } else if (spec.startsWith('git') || /^[^/@]+\/[^/@]+$/.test(spec.split('#')[0])) {
        entry.kind = 'git';
        entry.current = known[name]?.version ?? '';
        const head = await gitHead(spec.replace(/^git\+/, ''), undefined);
        if (head !== '') entry.latest = head.slice(0, 12);
        if (head !== '' && known[name]?.sha !== head) entry.updateAvailable = known[name] !== undefined;
        entry.note = head === '' ? '远端不可达（git ls-remote 失败）' : '';
      } else if (spec !== '' && !spec.startsWith('file:') && !spec.startsWith('/')) {
        entry.kind = 'npm';
        entry.current = known[name]?.version ?? '';
        const latest = await npmLatest(spec, undefined);
        entry.latest = latest;
        entry.updateAvailable = latest !== '' && compareVersions(entry.current, latest) < 0;
        entry.note = latest === '' ? 'registry 不可达' : '';
      } else {
        entry.kind = 'path';
        entry.note = '本地路径/目录源：改完直接重装即生效';
      }
      results.push(entry);
    }
    return results;
  }

  /**
   * 应用更新：走 pluginManager（与设置页同一入口：锁/兼容/回滚都在它那）。
   *
   * link: 源必须 remove→install：pnpm 对 link: 依赖「已满足」不做任何事，
   * 直接 installBundle 会报 ambiguous-install（依赖表没变化，它找不出装了谁）。
   * 先 removeBundle 再 installBundle 与人在设置页做的流程逐字一致；remove
   * 会从 bundles 列表摘名，install 的 enabled 选项按摘之前的列表恢复。
   */
  async function applyUpdate(name, spec) {
    const service = manager();
    if (service === undefined) throw new Error('pluginManager 服务不可用（profile 未启动管理器？）');
    const enabled = readBundles().includes(name);
    if (spec.startsWith('link:')) {
      const removed = await service.removeBundle(name);
      if (removed.application === 'failed') {
        // remove 失败要如实报，不能拿着半状态去 install。
        throw new Error(`removeBundle: ${removed.error?.code ?? removed.application}`);
      }
    }
    const result = await service.installBundle(spec, { enabled });
    return result;
  }

  const check = async (applyUpdates) => {
    if (running) return { busy: true };
    running = true;
    try {
      const results = await runCheck(applyUpdates);
      const applied = [];
      const failures = [];
      if (applyUpdates === true) {
        for (const entry of results) {
          if (entry.updateAvailable !== true) continue;
          if (entry.kind === 'npm' && autoApplyRemote !== true) continue;
          if (entry.kind === 'git') continue; // git 自动应用一律关（用户显式点「更新」除外）
          try {
            const result = await applyUpdate(entry.name, entry.spec);
            if (result.application === 'applied' || result.application === 'restart-required') {
              applied.push({ name: entry.name, spec: entry.spec, at: Date.now() });
              recordHistory(history, { name: entry.name, spec: entry.spec, at: Date.now(), ok: true });
            } else {
              failures.push(`${entry.name}: ${result.application}${result.error?.code ? `（${result.error.code}）` : ''}`);
            }
          } catch (cause) {
            failures.push(`${entry.name}: ${errorText(cause)}`);
            recordHistory(history, { name: entry.name, spec: entry.spec, at: Date.now(), ok: false, error: errorText(cause) });
          }
        }
      }
      // 账本更新为「检查时刻的已知版本」
      const entries = readLedger(ledger);
      for (const entry of results) {
        if (entry.kind === 'link' || entry.kind === 'npm') {
          entries[entry.name] = { spec: entry.spec, version: entry.current || entry.latest, at: Date.now() };
        } else if (entry.kind === 'git') {
          entries[entry.name] = { spec: entry.spec, version: entry.current, sha: entry.latest, at: Date.now() };
        }
      }
      writeLedgerAtomic(ledger, entries);
      lastCheck = { at: Date.now(), results, applied, failures };
      if (applied.length > 0) log('info', `已应用 ${applied.length} 个插件更新：${applied.map((a) => a.name).join(', ')}`);
      if (failures.length > 0) note(`上轮更新失败：${failures.join('；')}`);
      return lastCheck;
    } finally {
      running = false;
    }
  };

  // 定时检查（只在启动后 delayMs 再跑第一轮，避免拖慢启动）
  const delayMs = Number.isFinite(config.delayMs) && config.delayMs > 0 ? config.delayMs : 5 * 60 * 1000;
  const timer = setTimeout(() => {
    void check(false).catch((cause) => log('warn', `定时检查失败：${errorText(cause)}`));
  }, delayMs);
  timer.unref?.();
  const ticker = setInterval(() => {
    void check(false).catch((cause) => log('warn', `定时检查失败：${errorText(cause)}`));
  }, intervalMs);
  ticker.unref?.();
  ctx.effect(() => () => {
    clearTimeout(timer);
    clearInterval(ticker);
  }, 'plugin-autoupdate: timers');

  // ── 路由 ────────────────────────────────────────────────────────────────

  const status = () => ({
    ok: true,
    busy: running,
    autoApplyRemote,
    intervalMs,
    lastCheck,
    notes: notes.slice(),
    ledger: readLedger(ledger),
    history: readHistory(history).slice(-10).reverse(),
    managerAvailable: manager() !== undefined,
  });

  const register = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: (req, res) => {
      const json = jsonOf(res);
      Promise.resolve(handler(req, res, json)).catch((cause) =>
        json(500, { error: `plugin-autoupdate 路由内部错误：${errorText(cause)}` }));
    },
  }), `plugin-autoupdate: ${path}`);

  register(`${ROUTE}/status`, async (req, res, json) => {
    if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' });
    return json(200, status());
  });

  register(`${ROUTE}/check`, async (req, res, json) => {
    if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!sameOrigin(req)) return json(403, { error: 'cross-origin request rejected' });
    const body = await readBody(req, 1 << 20);
    if (!body.ok) return json(400, { error: body.error });
    let applyUpdates = false;
    if (body.text !== '') {
      try { applyUpdates = JSON.parse(body.text).apply === true; } catch { return json(400, { error: 'body 不是合法 JSON' }); }
    }
    const result = await check(applyUpdates);
    return json(200, { ...status(), check: result });
  });

  register(`${ROUTE}/apply`, async (req, res, json) => {
    if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!sameOrigin(req)) return json(403, { error: 'cross-origin request rejected' });
    const body = await readBody(req, 1 << 20);
    if (!body.ok) return json(400, { error: body.error });
    let name = '';
    try { name = JSON.parse(body.text === '' ? '{}' : body.text).name ?? ''; } catch { return json(400, { error: 'body 不是合法 JSON' }); }
    if (typeof name !== 'string' || name === '') return json(400, { error: 'name 必填' });
    const dependencies = readDependencies();
    const spec = dependencies[name];
    if (spec === undefined) return json(404, { error: `bundle ${name} 不在依赖表里` });
    try {
      const result = await applyUpdate(name, spec);
      recordHistory(history, { name, spec, at: Date.now(), ok: result.application === 'applied' });
      return json(200, { ...status(), install: result });
    } catch (cause) {
      recordHistory(history, { name, spec, at: Date.now(), ok: false, error: errorText(cause) });
      return json(500, { error: `更新失败：${errorText(cause)}` });
    }
  });

  log('info', `插件自动更新就绪（ledger=${ledger}，定时=${Math.round(intervalMs / 60000)} 分钟，远程自动应用=${autoApplyRemote ? '开' : '关'}）`);
}
