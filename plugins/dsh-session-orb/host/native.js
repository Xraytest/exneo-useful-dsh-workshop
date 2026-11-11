/**
 * Supervisor for the native orb helper process.
 *
 * The orb has to live in a window this Host does not own: a Cordis plugin runs
 * in the DSH backend process (plain Node, no Electron window API) and the
 * desktop `DESKTOP_IPC` surface offers no channel to create a window or to set
 * a topmost bit (main.js:1441-1473). Patching `app.asar` is out of the question,
 * so the only honest route to a real, independent, always-on-top window is a
 * process of our own.
 *
 * That process is a small C# WinForms app compiled on demand with the in-box
 * compiler. Compiling at runtime keeps the plugin a pure source drop (no binary
 * in the repository, no build step for the user) at the cost of one ~3 s compile
 * per source revision, cached by content hash afterwards.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Restart policy: at most this many spawns inside the window, then give up. */
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60_000;
const RESTART_DELAYS_MS = [400, 900, 1_800, 3_500, 7_000];
const COMPILE_TIMEOUT_MS = 120_000;

const CSC_FLAGS = [
  '/nologo',
  '/target:winexe',
  '/platform:anycpu',
  '/optimize+',
  '/warn:1',
  '/utf8output',
  '/r:System.dll',
  '/r:System.Core.dll',
  '/r:System.Drawing.dll',
  '/r:System.Windows.Forms.dll',
];

/** @param {string} frameworkDir */
function cscCandidates() {
  const root = process.env.WINDIR ?? 'C:\\Windows';
  const versions = ['v4.0.30319'];
  /** @type {string[]} */
  const list = [];
  for (const version of versions) {
    list.push(join(root, 'Microsoft.NET', 'Framework64', version, 'csc.exe'));
    list.push(join(root, 'Microsoft.NET', 'Framework', version, 'csc.exe'));
  }
  return list.filter((path) => existsSync(path));
}

export class NativeOrb {
  /**
   * @param {object} options
   * @param {string} options.pluginRoot
   * @param {import('./store.js').Log} options.log
   * @param {(state: object) => void} options.onEvent native -> host event
   */
  constructor({ pluginRoot, log, onEvent }) {
    this.pluginRoot = pluginRoot;
    this.source = join(pluginRoot, 'native', 'SessionOrb.cs');
    this.log = log;
    this.onEvent = onEvent;
    /** @type {'idle'|'compiling'|'running'|'restarting'|'failed'|'unsupported'} */
    this.state = 'idle';
    this.reason = null;
    this.pid = null;
    this.exe = null;
    this.exitedAt = null;
    this.restarts = 0;
    this.compiledAt = null;
    /** @type {number[]} */
    this.spawnLog = [];
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** @type {NodeJS.Timeout | null} */
    this.watchdog = null;
    /** @type {NodeJS.Timeout | null} */
    this.restartTimer = null;
    this.disposed = false;
    this.starting = false;
    this.buildDir = null;
  }

  get supported() {
    return process.platform === 'win32';
  }

  status() {
    return {
      state: this.state,
      reason: this.reason,
      pid: this.pid,
      exe: this.exe,
      restarts: this.restarts,
      compiledAt: this.compiledAt,
      platform: process.platform,
      source: this.source,
    };
  }

  /**
   * @param {{origin: string, token: string, lang: string}} options
   */
  async start(options) {
    if (this.disposed || this.starting) return this.status();
    if (!this.supported) {
      this.state = 'unsupported';
      this.reason = `the native orb helper targets Windows; this Host runs on ${process.platform}`;
      this.log.warn(`orb: ${this.reason}`);
      return this.status();
    }
    if (!existsSync(this.source)) {
      this.state = 'failed';
      this.reason = `native source is missing: ${this.source}`;
      this.log.error(`orb: ${this.reason}`);
      return this.status();
    }
    this.starting = true;
    this.state = this.exe === null ? 'compiling' : 'restarting';
    try {
      const exe = await this.ensureCompiled();
      if (this.disposed) return this.status();
      this.spawn(exe, options);
    } catch (error) {
      this.state = 'failed';
      this.reason = String(error?.message ?? error);
      this.log.error(`orb: could not start the native helper — ${this.reason}`);
    } finally {
      this.starting = false;
    }
    return this.status();
  }

  /** Compile once per source revision and cache the binary.
   * @returns {Promise<string>} */
  async ensureCompiled() {
    const csc = cscCandidates()[0];
    if (csc === undefined) {
      throw new Error('no in-box C# compiler (csc.exe) found under %WINDIR%\\Microsoft.NET');
    }
    const source = readFileSync(this.source);
    const hash = createHash('sha1')
      .update(source)
      .update(csc)
      .update(CSC_FLAGS.join(' '))
      .digest('hex')
      .slice(0, 12);
    const root = join(join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local')), 'dsh-session-orb', 'build');
    const dir = join(root, hash);
    const exe = join(dir, 'SessionOrb.exe');
    this.buildDir = dir;
    if (existsSync(exe)) {
      this.exe = exe;
      this.compiledAt = statSync(exe).mtimeMs;
      this.log.info(`orb: reusing cached helper ${exe}`);
      this.pruneBuilds(root, hash);
      return exe;
    }
    mkdirSync(dir, { recursive: true });
    // The BOM makes the compiler read the source as UTF-8 regardless of the
    // console code page, which is GBK on a Chinese Windows install.
    const staging = join(dir, 'SessionOrb.cs');
    writeFileSync(staging, `\uFEFF${source.toString('utf8')}`, 'utf8');
    this.log.info(`orb: compiling helper with ${csc} -> ${exe}`);
    const started = Date.now();
    await this.runCompiler(csc, staging, exe);
    this.exe = exe;
    this.compiledAt = statSync(exe).mtimeMs;
    this.log.info(`orb: helper compiled in ${Date.now() - started} ms`);
    this.pruneBuilds(root, hash);
    return exe;
  }

  /** @param {string} root @param {string} keep */
  pruneBuilds(root, keep) {
    try {
      for (const name of readdirSync(root)) {
        if (name === keep) continue;
        rmSync(join(root, name), { recursive: true, force: true });
      }
    } catch {
      // Cache pruning is best effort.
    }
  }

  /** @param {string} csc @param {string} source @param {string} exe */
  runCompiler(csc, source, exe) {
    return new Promise((resolve, reject) => {
      const args = [...CSC_FLAGS, `/out:${exe}`, source];
      const child = spawn(csc, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      /** @type {Buffer[]} */
      const chunks = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`csc timed out after ${COMPILE_TIMEOUT_MS} ms`));
      }, COMPILE_TIMEOUT_MS);
      child.stdout?.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`csc failed to run: ${String(error?.message ?? error)}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks).toString('utf8').trim();
        if (code === 0 && existsSync(exe)) {
          resolve(undefined);
          return;
        }
        const tail = output === '' ? '(no compiler output)' : output.slice(-4000);
        this.log.error(`orb: csc exited ${String(code)}\n${tail}`);
        reject(new Error(`csc exited ${String(code)}: ${tail.split('\n').slice(0, 6).join(' | ')}`));
      });
    });
  }

  /** @param {string} exe @param {{origin: string, token: string, lang: string}} options */
  spawn(exe, options) {
    if (this.disposed) return;
    const args = [
      '--origin',
      options.origin,
      '--token',
      options.token,
      '--parent',
      String(process.pid),
      '--lang',
      options.lang,
    ];
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.pid = child.pid ?? null;
    this.exe = exe;
    this.state = 'running';
    this.reason = null;
    this.spawnLog.push(Date.now());
    this.spawnLog = this.spawnLog.filter((at) => Date.now() - at <= RESTART_WINDOW_MS);
    child.stdout?.on('data', (chunk) => this.logChild('out', chunk));
    child.stderr?.on('data', (chunk) => this.logChild('err', chunk));
    child.on('error', (error) => {
      this.log.error(`orb: spawn error ${String(error?.message ?? error)}`);
      this.state = 'failed';
      this.reason = String(error?.message ?? error);
    });
    child.on('exit', (code, signal) => {
      const exitedAt = Date.now();
      this.exitedAt = exitedAt;
      this.pid = null;
      this.child = null;
      if (this.disposed) return;
      this.log.warn(`orb: helper exited code=${String(code)} signal=${String(signal)}`);
      if (code === 0) {
        // A clean exit means "another instance owns the orb" or "we were told to go".
        this.state = 'idle';
        this.reason = null;
        return;
      }
      this.state = 'restarting';
      this.reason = `helper exited with code ${String(code)}`;
      if (this.spawnLog.length >= MAX_RESTARTS) {
        this.state = 'failed';
        this.reason = `helper exited ${this.spawnLog.length} times in under 10 minutes; giving up. See orb.log.`;
        this.log.error(`orb: ${this.reason}`);
        return;
      }
      const delay = RESTART_DELAYS_MS[Math.min(this.restarts, RESTART_DELAYS_MS.length - 1)];
      this.restarts += 1;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        void this.start(options);
      }, delay);
      this.restartTimer.unref?.();
    });
    this.log.info(`orb: helper started pid=${String(this.pid)} (${exe})`);
  }

  /** @param {'out'|'err'} stream @param {Buffer|string} chunk */
  logChild(stream, chunk) {
    const text = String(chunk).trimEnd();
    if (text === '') return;
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      if (stream === 'err') this.log.warn(`orb[${this.pid ?? '?'}]: ${line}`);
      else this.log.info(`orb[${this.pid ?? '?'}]: ${line}`);
    }
  }

  /**
   * Relay a message the native process reported over HTTP. Kept here so the
   * transport layer does not have to know about supervision.
   * @param {{type?: string}} event
   */
  handleEvent(event) {
    if (event?.type === 'ready') {
      this.state = 'running';
      this.reason = null;
    }
    if (event?.type === 'fatal') {
      this.state = 'failed';
      this.reason = typeof event.message === 'string' ? event.message : 'native helper reported a fatal error';
    }
    this.onEvent?.(event);
  }

  /** Restart the helper from scratch (settings page "重试").
   * @param {{origin: string, token: string, lang: string}} options */
  async revive(options) {
    this.spawnLog = [];
    this.restarts = 0;
    this.reason = null;
    this.stopChild();
    this.state = 'idle';
    return this.start(options);
  }

  stopChild() {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (child === null) return;
    this.child = null;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }

  dispose() {
    this.disposed = true;
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.stopChild();
  }
}
