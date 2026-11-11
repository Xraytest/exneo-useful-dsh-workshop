/**
 * 插件装配自测：用假 ctx 驱动 `apply()`，验证
 *   · Config 是合法 JSON Schema；
 *   · 工具注册与 schema 形状（标准 JSON Schema，不是作者方言）；
 *   · server 真的起来又能停掉（幂等）；
 *   · bindHost=0.0.0.0 且 allowLan=false 时拒绝启动；
 *   · allowToolExecution 开关；
 *   · agent/disposed 清理 WS 订阅（走真实路径：真 WS 连接 → 真监听器 → 真客户端）。
 *
 * 运行：node --test test/plugin-test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';

import { FrameParser, OPCODE, unmask } from '../lib/ws.js?v=1';

const plugin = await import('../index.js?v=1');

/** 本测试文件所在目录（fixture 拷贝用）。 */
const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * 本用例收集到的 effect disposer。
 *
 * 以前 `apply()` 每次成功调用都会起一个真 HTTP server，而假 ctx 的 `effect()`
 * 只把 disposer 存起来、从来没人执行 —— 于是一个测试文件跑完会残留 5 个
 * LISTEN socket（其中 0.0.0.0 那个来自 allowLan 用例，测试结束后仍然对外暴露）。
 * 这也是 `--test-force-exit` 唯一真正必需的原因。现在由 afterEach 统一执行。
 *
 * @type {Array<() => unknown | Promise<unknown>>}
 */
let pendingDisposers = [];

/** 执行并清空收集到的 disposer（可重复调用，幂等）。 */
async function runDisposers() {
  const disposers = pendingDisposers;
  pendingDisposers = [];
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch {
      /* 单个清理失败不阻塞其余 */
    }
  }
}

/** 等一个事件循环 tick：server.close() 的回程里 TCP handle 还没释放完。 */
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 等到没有残留的监听 socket，或超过预算。
 *
 * `server.close()` 的回调触发时底层 handle 还没释放完，要再跑几个事件循环
 * tick 才真正消失（README 里说的「下一个事件循环 tick 后清空」就是指这个）。
 *
 * @param {number} [maxTicks]
 * @returns {Promise<string[]>} 仍然残留的资源类型
 */
async function drainListenHandles(maxTicks = 50) {
  for (let i = 0; i < maxTicks; i += 1) {
    await nextTick();
    const leaked = process.getActiveResourcesInfo().filter((kind) => kind === 'TCPServerWrap');
    if (leaked.length === 0) return [];
  }
  return process.getActiveResourcesInfo().filter((kind) => kind === 'TCPServerWrap');
}

/**
 * 用 node:http 发一个 GET（不用全局 fetch）。
 *
 * 一是绕开 undici 的坏端口黑名单（动态端口 1024-15000 里有 19 个 badPorts，
 * 撞上就 `TypeError: fetch failed / cause: bad port`）；二是 undici 的连接池
 * 会残留 keep-alive handle，让测试进程不肯自己退出。
 *
 * @param {string} url
 * @returns {Promise<{ status: number, json: any, text: string }>}
 */
function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: Number(res.statusCode ?? 0), json, text });
      });
    });
    request.on('error', reject);
  });
}

/** 从启动日志里取真实监听地址 `host:port`。 */
function listeningEndpoint(logs) {
  const line = logs.map(([, text]) => text).find((text) => text.includes('已监听'));
  const match = line === undefined ? undefined : /已监听 (\S+?)（/u.exec(line);
  return match?.[1];
}

/**
 * 收集 effect disposer 的假 ctx。
 * @param {{ services?: Record<string, any> }} [input]
 */
function makeCtx(input = {}) {
  const tools = [];
  const listeners = new Map();
  const logs = [];
  // 每个 ctx 一份待清理队列，避免上个用例的 disposer 串到这一个
  const disposers = [];
  pendingDisposers = disposers;
  // 真实的 Cordis ctx 会把服务同时暴露为 ctx.<name> 便捷访问器
  // （dsh-admin-channel 用的就是 ctx.tools.register），假 ctx 也要照做。
  const toolsService = {
    register: (definition) => {
      tools.push(definition);
      return () => {
        const index = tools.indexOf(definition);
        if (index >= 0) tools.splice(index, 1);
      };
    },
  };
  const ctx = {
    logger: {
      info: (text) => logs.push(['info', text]),
      warn: (text) => logs.push(['warn', text]),
      error: (text) => logs.push(['error', text]),
    },
    tools: toolsService,
    get(key) {
      if (key === 'tools') return toolsService;
      return input.services?.[key];
    },
    on(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
      return () => listeners.get(name)?.splice(listeners.get(name).indexOf(callback), 1);
    },
    effect(fn) {
      const disposer = fn();
      const wrapped = typeof disposer === 'function' ? disposer : () => {};
      disposers.push(wrapped);
      return wrapped;
    },
    inject() { return () => {}; },
  };
  return { ctx, tools, listeners, logs, disposers };
}

let root;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prts-plugin-'));
  process.env.PRTS_OMNI_BRIDGE_HOME = join(root, 'data');
});

test.afterEach(async () => {
  // apply() 起的 server 只由 effect disposer 关闭，所以这里必须真的执行它们
  await runDisposers();
  // server.close() 的回程里 handle 还没释放完，等几个 tick 才断言
  const leaked = await drainListenHandles();
  assert.deepEqual(leaked, [], `afterEach 后仍有未释放的监听 socket：${leaked.join(', ')}`);
  delete process.env.PRTS_OMNI_BRIDGE_HOME;
  await rm(root, { recursive: true, force: true });
});

/**
 * 假 schemastery 替身：只要能被 `.object()/.natural()/.boolean().string().default()`
 * 链式串起来，并且最终产物带 `.validate()`（Loader 真正需要的就是这个）即可。
 * 同时把传给 `object()` 的字段名记到 globalThis，供子进程读回来断言。
 *
 * 参考 `plugins/dsh-blender-plugin/tests/schema_resolve_selftest.mjs` 的同名替身。
 */
const SCHEMASTERY_SHIM = [
  'const chain = () => {',
  '  const o = {};',
  '  o.default = () => o; o.object = () => o; o.natural = () => o; o.boolean = () => o; o.string = () => o;',
  '  o.min = () => o; o.max = () => o; o.description = () => o;',
  '  o.validate = () => [];',
  '  return o;',
  '};',
  'export const object = (fields) => { globalThis.__SM_FIELDS__ = Object.keys(fields || {}); return chain(); };',
  'export const natural = () => chain();',
  'export const boolean = () => chain();',
  'export const string = () => chain();',
  'export default { object, natural, boolean, string };',
  '',
].join('\n');

/**
 * 在子进程里 import 一份 fixture 拷贝的 index.js，回报 Config 的构建结果。
 * @param {string} entry fixture 里 index.js 的绝对路径
 */
function probeFixtureEntry(entry) {
  const probe = [
    "import { pathToFileURL } from 'node:url';",
    'const spec = process.argv[1];',
    "const mod = await import(spec.startsWith('file:') ? spec : pathToFileURL(spec).href);",
    'let applyWorks = false;',
    'try {',
    "  const ctx = { effect: (fn) => { fn(); return () => {}; }, on: () => () => {}, tools: { register: () => () => {} }, logger: { info() {}, warn() {}, error() {} } };",
    "  await mod.apply(ctx, { enabled: false });",
    '  applyWorks = true;',
    '} catch (error) { applyWorks = String(error && error.message || error); }',
    "console.log('FIXTURE_JSON ' + JSON.stringify({",
    '  hasConfig: mod.Config !== undefined,',
    "  hasValidate: typeof (mod.Config && mod.Config.validate) === 'function',",
    '  fields: globalThis.__SM_FIELDS__ || null,',
    '  applyWorks,',
    '}));',
    '',
  ].join('\n');
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe, pathToFileURL(entry).href], { encoding: 'utf8' });
    const line = out.split('\n').find((text) => text.startsWith('FIXTURE_JSON '));
    if (line === undefined) return { threw: `fixture 没回 JSON：${out.slice(-300)}` };
    return JSON.parse(line.slice('FIXTURE_JSON '.length));
  } catch (error) {
    const tail = String(error?.stderr ?? error?.message ?? error).trim().split('\n').slice(-6).join(' | ');
    return { threw: tail.slice(0, 500) };
  }
}

/**
 * 造一份 fixture：index.js + lib/ 的拷贝，上方按需放 schemastery 替身。
 * @param {string} root
 * @param {string} name
 * @param {Array<'scoped' | 'unscoped'>} smNames
 */
function makeSchemaFixture(root, name, smNames) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(HERE, '..', 'index.js'), join(dir, 'index.js'));
  cpSync(join(HERE, '..', 'lib'), join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `prts-fixture-${name}`, type: 'module' }), 'utf8');
  const nm = join(dir, 'node_modules');
  for (const kind of smNames) {
    const pkg = kind === 'scoped' ? '@deepseek-ai/schemastery' : 'schemastery';
    const target = join(nm, ...pkg.split('/'));
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: pkg, version: '0.0.0-fixture', type: 'module', main: 'index.js' }), 'utf8');
    writeFileSync(join(target, 'index.js'), SCHEMASTERY_SHIM, 'utf8');
  }
  return join(dir, 'index.js');
}

test('Config 是 Loader 可用的 schema 对象（schemastery 可用时）', (t) => {
  const schema = plugin.Config;
  if (schema === undefined) {
    // 独立运行环境解析不到 schemastery：按设计降级为「不声明 Config」，
    // 由 resolveConfig() 做运行期归一化。形状断言由下面的 fixture 用例覆盖。
    t.diagnostic('schemastery 不可解析 → Config=undefined（降级模式）；schema 形状由 fixture 用例覆盖');
    assert.equal(schema, undefined);
    return;
  }
  // Loader 要的是带 .validate() 的 schema 对象，不是裸 JSON Schema
  assert.equal(typeof schema.validate, 'function');
});

test('schemastery 三种解析结果都走对分支（fixture 子进程）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'prts-sm-'));
  try {
    const expected = ['enabled', 'bindHost', 'port', 'allowLan', 'allowToolExecution', 'maxSessions'];

    t.diagnostic('A：只提供带 scope 的 @deepseek-ai/schemastery');
    const scoped = probeFixtureEntry(makeSchemaFixture(root, 'scoped-only', ['scoped']));
    assert.equal(scoped.threw, undefined, scoped.threw);
    assert.equal(scoped.hasConfig, true);
    assert.equal(scoped.hasValidate, true, 'Config 必须带 validate()');
    assert.deepEqual(scoped.fields, expected);

    t.diagnostic('B：只提供无 scope 的 schemastery');
    const unscoped = probeFixtureEntry(makeSchemaFixture(root, 'unscoped-only', ['unscoped']));
    assert.equal(unscoped.threw, undefined, unscoped.threw);
    assert.equal(unscoped.hasConfig, true);
    assert.equal(unscoped.hasValidate, true, 'Config 必须带 validate()');
    assert.deepEqual(unscoped.fields, expected);

    t.diagnostic('C：两个名字都没有 → Config=undefined 且插件仍然可用');
    const none = probeFixtureEntry(makeSchemaFixture(root, 'none', []));
    assert.equal(none.threw, undefined, none.threw);
    assert.equal(none.hasConfig, false, '拿不到 schemastery 时 Config 必须是 undefined');
    assert.equal(none.applyWorks, true, '降级不应影响 apply()');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('export const inject 声明 tools 为硬依赖', () => {
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(plugin.name, 'prts-omni-bridge');
});

test('apply 注册 prts_omni 工具且 parameters 是标准 JSON Schema', async () => {
  const { ctx, tools, logs } = makeCtx();
  await plugin.apply(ctx, { port: 0 });
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.name, 'prts_omni');
  assert.equal(tool.parameters.type, 'object');
  assert.equal(typeof tool.parameters.properties, 'object');
  assert.ok(Array.isArray(tool.parameters.required));
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.deepEqual(tool.parameters.properties.action.enum, ['list_sessions', 'send', 'interrupt', 'spawn']);
  // 不允许残留作者方言：每个属性上不能有 required: true
  for (const [name, property] of Object.entries(tool.parameters.properties)) {
    assert.equal(property.required, undefined, `${name} 上不允许有 required`);
  }
  // output.schema 也必须是 object 根
  assert.equal(tool.output.schema.type, 'object');
  assert.ok(Array.isArray(tool.output.schema.required));

  // 启动日志提示配对，且不泄漏令牌
  const joined = logs.map(([, text]) => text).join('\n');
  assert.match(joined, /配对令牌已就绪/u);
  const token = JSON.parse(await readFile(join(root, 'data', 'token.json'), 'utf8')).token;
  assert.equal(joined.includes(token), false);
});

test('presentCall 不引用 execute 作用域外的 agentId（不抛 ReferenceError）', async () => {
  const { ctx, tools } = makeCtx();
  await plugin.apply(ctx, { port: 0 });
  const tool = tools[0];
  // 以前 presentCall 里引用 execute() 的局部 const agentId，每次调用都 ReferenceError
  const view = tool.presentCall({ action: 'send', sessionId: 'session-1' });
  assert.equal(view.card, 'generic');
  assert.equal(view.title, 'send');
  assert.equal(view.sessionId, 'session-1');
  // Host 契约是 presentCall?(args)，不传 exec → agentId 省略而不是抛错
  assert.equal(view.agentId, undefined);
  assert.doesNotThrow(() => tool.presentCall({}));
  assert.doesNotThrow(() => tool.presentCall({ action: 'list_sessions' }, { agent: { id: 'a-1' } }));
  // 万一 Host 传了 exec，也能取到
  assert.equal(tool.presentCall({ action: 'send' }, { agent: { id: 'a-1' } }).agentId, 'a-1');
});

test('prts_omni 工具在 exec.agent 缺失时明确报错', async () => {
  const { ctx, tools } = makeCtx();
  await plugin.apply(ctx, { port: 0 });
  const result = await tools[0].execute({ action: 'list_sessions' }, {});
  assert.equal(result.ok, false);
  assert.ok(String(result.error).length > 0);
});

test('prts_omni 工具四个动作都能跑通', async () => {
  const sessions = new Map();
  const agents = new Map([['root', { id: 'root', root: true }]]);
  const services = {
    sessions: {
      list: () => [...sessions.values()],
      get: (id) => sessions.get(id),
      create: (id, options) => {
        const newId = id ?? `session-${sessions.size + 1}`;
        const session = { id: newId, header: { version: 4, id: newId, createdAt: 1, isSeeded: false, ...(options?.meta ?? {}) }, seq: 0, snapshotEvents: () => Object.freeze([]), deriveMessages: () => [] };
        sessions.set(newId, session);
        return session;
      },
    },
    agents: { list: () => [...agents.values()], get: (id) => agents.get(id), roots: () => [...agents.values()] },
    subagents: { sendMessage: async () => 'msg-1', interrupt: () => {} },
    sessionTitle: { get: () => undefined, rename: () => {} },
  };
  const { ctx, tools } = makeCtx({ services });
  await plugin.apply(ctx, { port: 0 });
  const tool = tools[0];

  const listed = await tool.execute({ action: 'list_sessions' }, { agent: { id: 'root' } });
  assert.equal(listed.ok, true);
  assert.equal(Array.isArray(listed.sessions), true);

  const spawned = await tool.execute({ action: 'spawn', title: 'T', goal: 'g' }, { agent: { id: 'root' } });
  assert.equal(spawned.ok, true);
  assert.equal(spawned.created, true);

  const sent = await tool.execute({ action: 'send', sessionId: 'session-1', text: 'hi' }, { agent: { id: 'root' } });
  assert.equal(sent.ok, true);

  const interrupted = await tool.execute({ action: 'interrupt', sessionId: 'session-1' }, { agent: { id: 'root' } });
  assert.equal(interrupted.ok, true);

  const unknown = await tool.execute({ action: 'bogus' }, { agent: { id: 'root' } });
  assert.equal(unknown.ok, false);
});

test('enabled=false 时不起服务也不注册工具', async () => {
  const { ctx, tools, logs } = makeCtx();
  await plugin.apply(ctx, { enabled: false });
  assert.equal(tools.length, 0);
  assert.ok(logs.some(([, text]) => text.includes('enabled=false')));
});

test('bindHost=0.0.0.0 且 allowLan=false 时拒绝启动', async () => {
  const { ctx, tools, logs } = makeCtx();
  await plugin.apply(ctx, { bindHost: '0.0.0.0', allowLan: false, port: 0 });
  assert.equal(tools.length, 0);
  const joined = logs.map(([, text]) => text).join('\n');
  assert.match(joined, /allowLan=false/u);
  assert.match(joined, /拒绝启动/u);
});

test('bindHost=0.0.0.0 且 allowLan=true 时可以启动，停止后不再接受连接', async () => {
  const { ctx, tools, logs } = makeCtx();
  await plugin.apply(ctx, { bindHost: '0.0.0.0', allowLan: true, port: 0 });
  assert.equal(tools.length, 1);
  assert.ok(logs.some(([, text]) => text.includes('已监听')));

  const endpoint = listeningEndpoint(logs);
  assert.ok(endpoint, '启动日志里没有监听地址');
  const health = await getJson(`http://${endpoint}/prts-omni/v1/health`);
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.lan, true);

  // 用例内主动收尾：跑掉 disposer 之后这个 server 必须真的停止
  await runDisposers();
  const leaked = await drainListenHandles();
  assert.deepEqual(leaked, [], 'allowLan 用例结束后 server 仍在监听');
  await assert.rejects(() => getJson(`http://${endpoint}/prts-omni/v1/health`));
});

test('resolveConfig 夹取越界值时会 warn 说明', async () => {
  const { ctx, logs } = makeCtx();
  await plugin.apply(ctx, { enabled: false, port: 80, maxSessions: 99999 });
  const joined = logs.map(([, text]) => text).join('\n');
  // port: 80 会被夹到 1024，必须留下日志而不是静默改掉
  assert.match(joined, /port.*80.*夹取到 1024/u);
  // maxSessions: 99999 会被夹到 1000
  assert.match(joined, /maxSessions.*99999.*夹取到 1000/u);

  const numeric = makeCtx();
  await plugin.apply(numeric.ctx, { enabled: false, port: 'abc' });
  const numericLogs = numeric.logs.map(([, text]) => text).join('\n');
  assert.match(numericLogs, /port.*不是数字.*8787/u);
});

/**
 * 一个极简 WebSocket 测试客户端：手工握手 + 复用被测模块的帧解析。
 * 与 http-test.mjs 里的 TestWsClient 同思路，这里只保留本用例需要的部分。
 */
class TestWsClient extends EventEmitter {
  /**
   * @param {string} url ws://host:port/path
   * @param {string} token
   */
  static async connect(url, token) {
    const target = new URL(url);
    const crypto = await import('node:crypto');
    const net = await import('node:net');
    const key = crypto.randomBytes(16).toString('base64');
    const client = new TestWsClient();
    client.messages = [];
    client.waiters = [];

    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: target.hostname, port: Number(target.port) });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('handshake timeout'));
      }, 3000);
      let handshake = '';
      socket.on('connect', () => {
        socket.write(
          `GET ${target.pathname}${target.search} HTTP/1.1\r\n`
          + `host: ${target.host}\r\n`
          + 'connection: Upgrade\r\n'
          + 'upgrade: websocket\r\n'
          + `sec-websocket-key: ${key}\r\n`
          + 'sec-websocket-version: 13\r\n'
          + `sec-websocket-protocol: ${token}\r\n`
          + '\r\n',
        );
      });
      const onHandshakeData = (chunk) => {
        handshake += chunk.toString('latin1');
        const boundary = handshake.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const statusLine = handshake.slice(0, handshake.indexOf('\r\n'));
        const status = Number(/^HTTP\/1\.\d (\d+)/u.exec(statusLine)?.[1] ?? 0);
        clearTimeout(timer);
        socket.removeListener('data', onHandshakeData);
        // 服务端必须回写 sec-websocket-protocol，否则浏览器路径按规范必须失败
        const headers = handshake.slice(0, boundary).toLowerCase();
        if (status !== 101 || !headers.includes(`sec-websocket-protocol: ${token.toLowerCase()}`)) {
          socket.destroy();
          reject(new Error(`upgrade rejected (status ${status}, protocol echoed=${headers.includes('sec-websocket-protocol:')})`));
          return;
        }
        client.socket = socket;
        socket.on('data', (later) => client.#onData(later));
        socket.on('close', () => { client.closed = true; });
        socket.on('error', () => { client.closed = true; });
        resolve(undefined);
        const remainder = chunk.subarray(chunk.length - (handshake.length - boundary - 4));
        if (remainder.length > 0) client.#onData(remainder);
      };
      socket.on('data', onHandshakeData);
      socket.on('close', () => {
        clearTimeout(timer);
        reject(new Error('socket closed during handshake'));
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return client;
  }

  /** @param {Buffer} chunk */
  #onData(chunk) {
    const frames = new FrameParser({ maxFrameBytes: 8 * 1024 * 1024 }).push(chunk);
    for (const frame of frames) {
      if (frame.opcode !== OPCODE.TEXT) continue;
      const parsed = JSON.parse(frame.payload.toString('utf8'));
      this.messages.push(parsed);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(parsed)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(parsed);
        }
      }
    }
  }

  /**
   * @param {(message: any) => boolean} predicate
   * @param {number} [timeoutMs]
   */
  waitFor(predicate, timeoutMs = 4000) {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`waitFor timeout：已收到 ${JSON.stringify(this.messages).slice(0, 400)}`));
      }, timeoutMs);
    });
  }

  /** @param {Record<string, unknown>} payload */
  send(payload) {
    const mask = Buffer.from([1, 2, 3, 4]);
    const text = Buffer.from(JSON.stringify(payload));
    const masked = Buffer.from(text);
    unmask(masked, mask);
    this.socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | masked.length]), mask, masked]));
  }

  close() {
    try {
      this.socket.write(Buffer.concat([Buffer.from([0x88, 0x82]), Buffer.from([0x03, 0xe8])]));
      this.socket.destroy();
    } catch {
      /* 已关闭 */
    }
  }
}

test('agent/disposed 走真实路径：客户端收到 session/gone 且订阅归零', async () => {
  const services = {
    sessions: {
      list: () => [],
      get: () => undefined,
      create: () => { throw new Error('unused'); },
    },
    agents: { list: () => [], get: () => undefined, roots: () => [] },
    subagents: { sendMessage: async () => 'msg-1', interrupt: () => {} },
  };
  const { ctx, listeners, logs } = makeCtx({ services });
  await plugin.apply(ctx, { port: 0 });

  // apply() 必须真的注册了且只注册了一个 agent/disposed 监听器
  const callbacks = listeners.get('agent/disposed') ?? [];
  assert.equal(callbacks.length, 1);

  const endpoint = listeningEndpoint(logs);
  assert.ok(endpoint, '启动日志里没有监听地址');
  const token = JSON.parse(await readFile(join(root, 'data', 'token.json'), 'utf8')).token;

  const client = await TestWsClient.connect(`ws://${endpoint}/prts-omni/v1/stream`, token);
  const hello = await client.waitFor((message) => message.type === 'hello');
  assert.equal(hello.type, 'hello');

  client.send({ type: 'subscribe', sessionIds: ['gone-session'] });
  const subscribed = await client.waitFor((message) => message.type === 'subscribed');
  assert.deepEqual(subscribed.sessionIds, ['gone-session']);

  // 订阅确实生效了（/health 的 subscriptions 就是 bridge.stats().subscriptions）
  const before = await getJson(`http://${endpoint}/prts-omni/v1/health`);
  assert.equal(before.json.subscriptions, 1);
  assert.equal(before.json.connections, 1);

  // 真实路径：触发 apply() 注册的那个监听器
  callbacks[0]({ agent: { id: 'gone-session' } });

  const gone = await client.waitFor((message) => message.type === 'session/gone');
  assert.equal(gone.type, 'session/gone');
  assert.equal(gone.sessionId, 'gone-session');

  // 订阅表必须归零，而不是留下一个指向已销毁会话的空壳
  await new Promise((resolve) => setTimeout(resolve, 80));
  const after = await getJson(`http://${endpoint}/prts-omni/v1/health`);
  assert.equal(after.json.subscriptions, 0);
  assert.equal(after.json.connections, 1);

  // 兼容「直接传 Agent」的形状，两条路径都要能清掉订阅
  client.send({ type: 'subscribe', sessionIds: ['gone-session-2'] });
  await client.waitFor((message) => message.type === 'subscribed' && message.sessionIds.includes('gone-session-2'));
  callbacks[0]({ id: 'gone-session-2' });
  const gone2 = await client.waitFor((message) => message.type === 'session/gone' && message.sessionId === 'gone-session-2');
  assert.equal(gone2.sessionId, 'gone-session-2');

  client.close();
  await new Promise((resolve) => setTimeout(resolve, 60));
});

test('start() 失败时不注册 agent/disposed 监听器（无僵尸监听器）', async () => {
  const { createServer } = await import('node:http');
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = /** @type {any} */ (blocker.address()).port;
  const { ctx, tools, listeners, logs } = makeCtx();
  await plugin.apply(ctx, { port });
  assert.equal(tools.length, 0);
  assert.ok(logs.some(([level]) => level === 'error'));
  // 启动失败就提前 return：不能留下 agent/disposed 监听器
  assert.equal((listeners.get('agent/disposed') ?? []).length, 0);
  await new Promise((resolve) => blocker.close(resolve));
});

test('端口被占用时 apply 不抛错且不注册工具', async () => {
  const { createServer } = await import('node:http');
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = /** @type {any} */ (blocker.address()).port;
  const { ctx, tools, logs } = makeCtx();
  await plugin.apply(ctx, { port });
  assert.equal(tools.length, 0);
  assert.ok(logs.some(([level]) => level === 'error'));
  await new Promise((resolve) => blocker.close(resolve));
});
