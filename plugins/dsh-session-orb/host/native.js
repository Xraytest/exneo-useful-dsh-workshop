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
import { dirname, join, basename } from 'node:path';

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
  '/warn:4',
  '/utf8output',
];

/**
 * Assemblies the helper links against. They are resolved by absolute path: a
 * bare `/r:System.dll` is looked up next to the *source* file and in the current
 * directory, neither of which is the framework directory, so the compile would
 * fail with CS0006 from any working directory but the framework's own.
 * `System.Web.Extensions.dll` is what provides `JavaScriptSerializer`; it ships
 * in the same in-box directory.
 */
const FRAMEWORK_ASSEMBLIES = [
  'System.dll',
  'System.Core.dll',
  'System.Drawing.dll',
  'System.Windows.Forms.dll',
  'System.Web.Extensions.dll',
];

/**
 * @param {string} csc
 * @returns {string[]} `/r:` switches with absolute paths
 */
function referenceArgs(csc) {
  const dir = dirname(csc);
  return FRAMEWORK_ASSEMBLIES.map((name) => {
    const path = join(dir, name);
    if (!existsSync(path)) {
      throw new Error(`the .NET Framework assemblies are incomplete: ${path} is missing (needed to compile the orb helper)`);
    }
    return `/r:${path}`;
  });
}

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
   */
  constructor({ pluginRoot, log }) {
    this.pluginRoot = pluginRoot;
    this.source = join(pluginRoot, 'native', 'SessionOrb.cs');
    this.log = log;
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
    /** Bumped on every spawn: an exit handler that no longer matches the
     * current generation belongs to a helper we already replaced, and must not
     * touch the supervision state (it used to null out a live `pid` and schedule
     * a second, tokenless spawn). */
    this.generation = 0;
    /** @type {string | null} */
    this.lastExitReason = null;
    this.buildDir = null;
    /** Build directory the live helper was started from; excluded from pruning. */
    this.activeBuildDir = null;
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
    if (typeof options?.origin !== 'string' || typeof options?.token !== 'string' || options.token === '') {
      // Never spawn a helper we know the bridge will reject: it would look
      // alive for a minute and then take the ball away with it.
      this.state = 'failed';
      this.reason = 'refusing to start the helper without a bridge token';
      this.log.error(`orb: ${this.reason}`);
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
    const flags = [...CSC_FLAGS, ...referenceArgs(csc)];
    const hash = createHash('sha1')
      .update(source)
      .update(csc)
      .update(flags.join(' '))
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
    await this.runCompiler(csc, flags, staging, exe);
    this.exe = exe;
    this.compiledAt = statSync(exe).mtimeMs;
    this.log.info(`orb: helper compiled in ${Date.now() - started} ms`);
    this.pruneBuilds(root, hash);
    return exe;
  }

  /** @param {string} root @param {string} keep */
  pruneBuilds(root, keep) {
    /** @type {string[]} */
    let names;
    try {
      names = readdirSync(root);
    } catch {
      return; // Cache pruning is best effort.
    }
    for (const name of names) {
      if (name === keep) continue;
      // Never prune the build the live helper was started from: Windows cannot
      // delete a running image anyway, and a half-deleted directory would be
      // reused by the next compile.
      if (this.activeBuildDir !== null && name === basename(this.activeBuildDir)) continue;
      try {
        rmSync(join(root, name), { recursive: true, force: true });
      } catch (error) {
        this.log.warn(`orb: cannot prune build ${name}: ${String(error?.message ?? error)}`);
      }
    }
  }

  /** @param {string} csc @param {string[]} flags @param {string} source @param {string} exe */
  runCompiler(csc, flags, source, exe) {
    return new Promise((resolve, reject) => {
      const args = [...flags, `/out:${exe}`, source];
      const child = spawn(csc, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      /** @type {Buffer[]} */
      const chunks = [];
      const timer = setTimeout(() => {
        child.kill();
        // A killed csc can leave a truncated image behind; `existsSync` would
        // then reuse it forever because the cache key already matches.
        try {
          rmSync(exe, { force: true });
        } catch {
          // Best effort: the next compile overwrites it anyway.
        }
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
    // A fresh generation has no pending exit reason: a late "revive"/"stop" left
    // over from the helper we just replaced would otherwise be read as the cause
    // of this helper's next crash and silently suppress its restart.
    this.lastExitReason = null;
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
    const generation = (this.generation += 1);
    this.child = child;
    this.pid = child.pid ?? null;
    this.exe = exe;
    this.activeBuildDir = dirname(exe);
    this.state = 'running';
    this.reason = null;
    this.spawnLog.push(Date.now());
    this.spawnLog = this.spawnLog.filter((at) => Date.now() - at <= RESTART_WINDOW_MS);
    child.stdout?.on('data', (chunk) => this.logChild('out', chunk));
    child.stderr?.on('data', (chunk) => this.logChild('err', chunk));
    child.on('error', (error) => {
      if (generation !== this.generation) return;
      this.log.error(`orb: spawn error ${String(error?.message ?? error)}`);
      this.state = 'failed';
      this.reason = String(error?.message ?? error);
    });
    child.on('exit', (code, signal) => {
      // A helper we already replaced (revive, stop, or a newer spawn) must not
      // report into the supervision state: doing so cleared the live `pid` and
      // scheduled a second spawn with no token.
      if (generation !== this.generation) {
        this.log.info(`orb: old helper (pid=${String(child.pid)}) exited code=${String(code)} signal=${String(signal)}; ignored`);
        return;
      }
      const exitedAt = Date.now();
      this.exitedAt = exitedAt;
      this.pid = null;
      this.child = null;
      if (this.disposed) return;
      const why = this.lastExitReason;
      this.lastExitReason = null;
      const clean = code === 0;
      this.log.warn(`orb: helper exited code=${String(code)} signal=${String(signal)}${why === null ? '' : ` (${why})`}`);
      if (why === 'revive' || why === 'stop') {
        // We killed it on purpose (settings-page restart, plugin dispose). The
        // caller owns what happens next, so this exit must neither consume a
        // restart slot nor schedule a second helper: the old code did both, which
        // put two balls on screen for ~400 ms per revive and burned the
        // 5-spawns-in-10-minutes budget on a few button clicks.
        this.state = 'idle';
        this.reason = null;
        return;
      }
      // Only "the Host is going away" makes a retired helper correct. Any other
      // exit — including a clean one, which used to be filed as "somebody else
      // owns the orb" — leaves the user without a ball, so it is retried within
      // the same bound as a crash.
      if (clean && (why === 'parent-gone' || why === 'shutdown')) {
        this.state = 'idle';
        this.reason = null;
        return;
      }
      this.state = 'restarting';
      this.reason = clean
        ? 'helper exited cleanly without leaving a ball behind'
        : `helper exited with code ${String(code)}`;
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
   * Apply a message the native process reported over HTTP to the supervision
   * state. This is a *sink*, never a relay: the Host already dispatches every
   * helper event through `index.js:onNativeEvent`, and re-emitting it from here
   * called straight back into that dispatcher. The result was infinite mutual
   * recursion — every event logged and applied ~1000 times before the stack
   * blew, which is why `orb.log` filled with repeated `helper ready` lines.
   * @param {{type?: string}} event
   */
  handleEvent(event) {
    if (event?.type === 'ready') {
      this.state = 'running';
      this.reason = null;
    }
    if (event?.type === 'bye') {
      // The helper announces why it is leaving before it goes: "parent-gone"
      // and "shutdown" are correct exits, anything else is a ball we have to
      // bring back.
      this.lastExitReason = typeof event.reason === 'string' ? event.reason : null;
    }
    if (event?.type === 'fatal') {
      this.state = 'failed';
      this.reason = typeof event.message === 'string' ? event.message : 'native helper reported a fatal error';
    }
  }

  /** Restart the helper from scratch (settings page "重试").
   * @param {{origin: string, token: string, lang: string}} options */
  async revive(options) {
    this.spawnLog = [];
    this.restarts = 0;
    this.reason = null;
    this.stopChild('revive');
    this.state = 'idle';
    return this.start(options);
  }

  /** @param {string|null} [reason] */
  stopChild(reason = null) {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (child === null) return;
    this.child = null;
    if (reason !== null) this.lastExitReason = reason;
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
    this.stopChild('stop');
  }
}
