/**
 * 会话导入（dsh-session-import）自测——纯 node、无副作用、不碰真实会话库。
 *
 *   node plugins/dsh-session-import/selftest.mjs
 *   node plugins/dsh-session-import/selftest.mjs --quick   # 跳过真实语料那一段
 *
 * 四段：
 *   A. zipread      自己造的 ZIP（store/deflate 混排）往返 + 五类损坏拒绝
 *   B. sessionlog   日志解析、归档归类、头规范化、导入规划（纯函数）
 *   C. routes       用假 ctx / 假服务**真跑 apply()**，驱动六条路由走完
 *                   「解析 → 新建工作区 → 落库 → 记账」全链路
 *   D. real         从磁盘上一条真实会话日志造出与 /export 同形的归档，
 *                   断言解析出的头与事件数、再走一遍导入并核对落库内容
 *
 * D 段是这套自测的价值所在：它证明「导入器读得进 DSH 真正写出来的日志」，
 * 而不是只证明了它读得进我自己编的假日志。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ZipError, crc32, normalizeEntryPath, readZip } from './zipread.js';
import {
  SessionLogError,
  buildImportedHeader,
  classifyArchiveEntries,
  loadFormatCatalog,
  loadPersistenceContract,
  parseLogBasename,
  parseSessionLog,
  planArchiveImport,
  prevalidateSession,
  summarizeArchive,
} from './sessionlog.js';
import { decodeZstdSessionLog, scanZstdFrames } from './zstdframes.js';
import { apply, normalizeConfig } from './entry-v2.js';

// ─────────────────────────── 会话存储代自适应 ───────────────────────────
// 会话存储代跟着 DSH 版本走：0.1 是 v3，0.2 是 v4。测试里凡是「写死 4」的地方，
// 本意都是「比本进程更新的那一代」——在 0.2 上 v4 已经**不是**更新代了，
// 必须用 current + 1，否则那些用例会静默走到另一条通道、测不到原本要测的东西。
const FORMAT_VERSION = Number((await loadFormatCatalog())?.currentVersion ?? 3);
const NEXT_FORMAT_VERSION = FORMAT_VERSION + 1;
/**
 * 当前代的 v3→v4 迁移会给**有历史子节点的父会话**追加一条 `subagent/catalog` 事件
 * ——子节点事实正是那次迁移的产物。0.1 没有这条边，追加数为 0，所以带子代理的
 * 夹具在两代上事件数差这一条。
 */
const PARENT_CATALOG_EVENTS = FORMAT_VERSION >= 4 ? 1 : 0;

// ───────────────────────────── 迷你测试台 ─────────────────────────────

let passed = 0;
const failures = [];
const skipped = [];

function test(name, fn) {
  try {
    const value = fn();
    if (value instanceof Promise) throw new Error('异步用例请用 testAsync');
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function skip(name, reason) {
  skipped.push({ name, reason });
  process.stdout.write(`  skip ${name}（${reason}）\n`);
}

/** 断言某个同步调用抛出指定构造器的错误。 */
function throwsWith(fn, ctor, messagePattern) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== null, '期望抛出错误，但没有');
  assert.ok(thrown instanceof ctor, `期望 ${ctor.name}，实得 ${thrown?.constructor?.name}: ${thrown?.message}`);
  if (messagePattern !== undefined) {
    assert.match(String(thrown.message), messagePattern);
  }
  return thrown;
}

// ───────────────────────────── ZIP 写入器（测试夹具） ─────────────────────────────

/**
 * 造一个最小 ZIP。**只用于测试**——生产路径只读不写。
 * @param {Array<{path: string, data: string|Buffer, store?: boolean, corruptCrc?: boolean, fakeSize?: number}>} entries 条目。
 * @returns {Buffer} 归档字节。
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.store === true ? 0 : 8;
    const body = entry.store === true ? raw : deflateRawSync(raw);
    const crc = entry.corruptCrc === true ? (crc32(raw) ^ 0xffff) >>> 0 : crc32(raw);
    const declaredSize = entry.fakeSize !== undefined ? entry.fakeSize : raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ───────────────────────────── 日志夹具 ─────────────────────────────

const HEADER_LINE = (overrides = {}) => `${JSON.stringify({
  type: 'session',
  version: 3,
  id: 'session-source-0001',
  createdAt: 1700000000000,
  cwd: '/root/code/original',
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
  ...overrides,
})}\n`;

const eventLine = (type, seq, data = {}) => `${JSON.stringify({ type, seq, time: 1700000000000 + seq, data })}\n`;

/**
 * 一组「形状确实合法」的当前代事件。
 *
 * 不能随手编事件类型：格式目录的编解码器对当前代输入仍做结构校验，实测
 * `user/message` / `assistant/message` 会因缺少 `surfaceOp` 标记被拒
 * （`format v3 user/message at seq 1 requires a surfaceOp marker`）。这里只挑
 * 无 surface 依赖、经探针确认可通过的类型，让夹具专注于测导入逻辑本身。
 */
const SAMPLE_EVENTS = [
  ['sandbox/mode', { mode: 'workspace-write' }],
  ['turn/start', { turn: 1 }],
  ['step/start', { turn: 1, step: 1 }],
  ['step/end', { turn: 1, step: 1 }],
  ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
];

/** 一条含 N 个合法事件的当前代日志文本。 */
function sampleLog(overrides = {}, eventCount = 3) {
  let text = HEADER_LINE(overrides);
  for (let index = 0; index < eventCount; index += 1) {
    const [type, data] = SAMPLE_EVENTS[index % SAMPLE_EVENTS.length];
    text += eventLine(type, index, data);
  }
  return text;
}

// ─────────────────────── 假 ctx / 假服务（C 段用） ───────────────────────

/**
 * 造一份内存版持久化：语义对齐 JSONL 后端的关键拒绝（重复 id、seq 不连续）。
 * @returns {object} 假 sessionPersistence。
 */
function makeFakePersistence() {
  const stored = new Map();
  return {
    stored,
    async stat(id) {
      const entry = stored.get(String(id));
      if (entry === undefined) return undefined;
      return { header: entry.header, revision: entry.events.length };
    },
    async list() {
      return [...stored.values()].map((entry) => ({ header: entry.header, revision: entry.events.length }));
    },
    async create(header) {
      const id = String(header.id);
      if (stored.has(id)) throw new Error(`session already exists: ${id}`);
      const entry = { header, events: [], flushed: false, closed: false };
      stored.set(id, entry);
      return {
        id,
        header,
        inheritedEventCount: 0,
        access: 'write',
        async read() { return { eventState: 'detached', events: [...entry.events] }; },
        async append(events) {
          for (const event of events) {
            assert.equal(event.seq, entry.events.length, `append seq 必须从 ${entry.events.length} 连续`);
            entry.events.push(event);
          }
        },
        async flush() { entry.flushed = true; },
        async close() { entry.closed = true; },
      };
    },
  };
}

/** 造一份内存版工作区注册表，成员判定对齐出厂：账目 ∩ 头 cwd === 工作区路径。 */
function makeFakeWorkspaces(persistence, initial = []) {
  const records = new Map();
  for (const record of initial) {
    records.set(record.id, { ...record, sessionIds: [...(record.sessionIds ?? [])] });
  }
  const wrap = (record) => ({
    id: record.id,
    title: record.title,
    path: record.path,
    get sessionIds() {
      // 出厂语义：账目里的 id 还要经头 cwd 过滤一遍才算成员。
      return record.sessionIds.filter((id) => {
        const entry = persistence.stored.get(String(id));
        return entry !== undefined && entry.header.cwd === record.path;
      });
    },
    async attachSession(id) {
      const entry = persistence.stored.get(String(id));
      if (entry === undefined) throw new Error(`unknown session: ${id}`);
      if (entry.header.cwd !== record.path) throw new Error(`session cwd 与工作区路径不符：${entry.header.cwd} ≠ ${record.path}`);
      if (!record.sessionIds.includes(String(id))) record.sessionIds.unshift(String(id));
    },
    async status() { return 'ok'; },
  });
  return {
    records,
    async list() { return [...records.values()].map(wrap); },
    get(id) { return records.has(String(id)) ? wrap(records.get(String(id))) : undefined; },
    async create(path, title) {
      if (!path.startsWith('/')) throw new Error('路径必须是绝对路径且已存在');
      // 出厂语义：create() 对路径做 fs.realpath（尾斜杠 / ".." / 符号链接都会被解析），
      // 目录不存在则抛错。假的也必须这么做——否则「新工作区路径被规范化后写进 header.cwd」
      // 这条一旦回退就测不出来，而它恰恰是导入后会话在侧边栏可见与否的唯一判据。
      let canonical;
      try {
        canonical = await realpath(path);
      } catch {
        throw new Error(`工作区路径不存在或不可解析：${path}`);
      }
      const existing = [...records.values()].find((record) => record.path === canonical);
      if (existing !== undefined) return wrap(existing);
      const record = {
        id: `ws-${records.size + 1}`,
        path: canonical,
        title: title ?? canonical.split('/').filter(Boolean).pop() ?? canonical,
        sessionIds: [],
      };
      records.set(record.id, record);
      return wrap(record);
    },
  };
}

/** 造一个假 cordis ctx：捕获 webServer 路由，按名字提供假服务。 */
function makeFakeCtx(services) {
  const routes = new Map();
  const disposers = [];
  const ctx = {
    logger: { warn() {}, info() {} },
    services,
    routes,
    disposeAll() { for (const dispose of disposers) dispose(); },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    get(name) { return services[name]; },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  };
  return ctx;
}

/** 造一个假 IncomingMessage。 */
function makeReq(method, url, body, headers = {}) {
  const chunks = body === undefined || body === null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')];
  const stream = Readable.from(chunks);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

/** 造一个假 ServerResponse，记录状态码与响应体。 */
function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk); this.writableEnded = true; },
  };
}

/** 驱动一条已注册路由，返回解析后的 JSON。路由按 pathname 查找，查询串原样交给处理器。 */
async function callRoute(ctx, path, { method = 'GET', body, headers = {} } = {}) {
  const pathname = path.split('?')[0];
  const handler = ctx.routes.get(pathname);
  assert.ok(handler !== undefined, `路由未注册：${pathname}`);
  const req = makeReq(method, path, body, headers);
  const res = makeRes();
  await handler(req, res);
  let value = null;
  try {
    value = res.body === '' ? null : JSON.parse(res.body);
  } catch {
    value = { raw: res.body };
  }
  return { status: res.statusCode, value };
}

// ───────────────────────────── A. zipread ─────────────────────────────

process.stdout.write('\nA. zipread — 归档读取\n');

test('crc32 取值对齐已知向量', () => {
  assert.equal(crc32(Buffer.from('', 'utf8')), 0);
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
});

test('deflate + store 混排往返一致', () => {
  const zip = makeZip([
    { path: 'session.v3.jsonl', data: 'hello deflate' },
    { path: 'media/abc.png', data: Buffer.from([1, 2, 3, 4, 5]), store: true },
    { path: 'files/ab/abcdef/note.txt', data: 'plain' },
  ]);
  const { entries, list } = readZip(zip);
  assert.equal(entries.size, 3);
  assert.equal(Buffer.from(entries.get('session.v3.jsonl')).toString('utf8'), 'hello deflate');
  assert.deepEqual([...entries.get('media/abc.png')], [1, 2, 3, 4, 5]);
  assert.equal(Buffer.from(entries.get('files/ab/abcdef/note.txt')).toString('utf8'), 'plain');
  assert.equal(list.find((entry) => entry.path === 'media/abc.png').method, 0);
  assert.equal(list.find((entry) => entry.path === 'session.v3.jsonl').method, 8);
});

test('目录条目被跳过', () => {
  const zip = makeZip([
    { path: 'subagents/', data: '', store: true },
    { path: 'subagents/x/session.v3.jsonl', data: '{}', store: true },
  ]);
  const { entries } = readZip(zip);
  assert.equal(entries.size, 1);
  assert.ok(entries.has('subagents/x/session.v3.jsonl'));
});

test('CRC 不符被拒绝', () => {
  const zip = makeZip([{ path: 'session.v3.jsonl', data: 'tampered', corruptCrc: true }]);
  throwsWith(() => readZip(zip), ZipError, /CRC/u);
});

test('声明长度与实际不符被拒绝', () => {
  const zip = makeZip([{ path: 'session.v3.jsonl', data: 'abcd', fakeSize: 999 }]);
  throwsWith(() => readZip(zip), ZipError, /长度不符/u);
});

test('非 ZIP 字节被拒绝', () => {
  // 两种拒绝路径都要覆盖：太短（进不了 EOCD 扫描）与够长但找不到 EOCD。
  throwsWith(() => readZip(Buffer.from('这不是 zip', 'utf8')), ZipError, /字节数不足/u);
  throwsWith(
    () => readZip(Buffer.from('这不是一个 zip 归档，长度足够走到 EOCD 扫描这一步了。', 'utf8')),
    ZipError,
    /EOCD/u,
  );
});

test('ZIP64 哨兵被显式拒绝', () => {
  const zip = makeZip([{ path: 'a.jsonl', data: 'x' }]);
  // 把 EOCD 里的条目数改成 0xFFFF 哨兵
  zip.writeUInt16LE(0xffff, zip.length - 22 + 10);
  throwsWith(() => readZip(zip), ZipError, /ZIP64/u);
});

test('条目路径逃逸被拒绝（zip-slip）', () => {
  const zip = makeZip([{ path: '../../etc/passwd', data: 'x' }]);
  throwsWith(() => readZip(zip), ZipError, /逃逸/u);
});

test('normalizeEntryPath 折叠 ./ 与反斜杠', () => {
  assert.equal(normalizeEntryPath('./a\\b/c.jsonl'), 'a/b/c.jsonl');
  throwsWith(() => normalizeEntryPath('a/../../b'), ZipError);
  throwsWith(() => normalizeEntryPath('C:/x'), ZipError);
});

// ───────────────────────────── B. sessionlog ─────────────────────────────

process.stdout.write('\nB. sessionlog — 解析、归类、规划\n');

test('parseLogBasename 认规范名、拒非规范名', () => {
  assert.equal(parseLogBasename('session.jsonl'), 0);
  assert.equal(parseLogBasename('session.v3.jsonl'), 3);
  assert.equal(parseLogBasename('session.v12.jsonl'), 12);
  assert.equal(parseLogBasename('session.v0.jsonl'), undefined);
  assert.equal(parseLogBasename('session.v03.jsonl'), undefined);
  assert.equal(parseLogBasename('session.v3.jsonl.zstd'), undefined);
  assert.equal(parseLogBasename('other.jsonl'), undefined);
});

test('classifyArchiveEntries 按角色归类', () => {
  const entries = new Map([
    ['session.v3.jsonl', Buffer.from('x')],
    ['subagents/child-1/session.v3.jsonl', Buffer.from('x')],
    ['media/abc123.png', Buffer.from('x')],
    ['files/ab/abcdef/note.txt', Buffer.from('x')],
    ['README.md', Buffer.from('x')],
  ]);
  const result = classifyArchiveEntries(entries);
  assert.equal(result.rootPath, 'session.v3.jsonl');
  assert.equal(result.subagentPaths.length, 1);
  assert.equal(result.subagentPaths[0].idFromPath, 'child-1');
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].mediaType, 'image/png');
  assert.equal(result.media[0].attachmentId, 'abc123');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].digest, 'abcdef');
  assert.equal(result.files[0].name, 'note.txt');
  assert.deepEqual(result.unknown, ['README.md']);
});

test('classifyArchiveEntries 把第二条根日志当未知条目', () => {
  const entries = new Map([
    ['session.v3.jsonl', Buffer.from('x')],
    ['session.v2.jsonl', Buffer.from('x')],
  ]);
  assert.deepEqual(classifyArchiveEntries(entries).unknown, ['session.v2.jsonl']);
});

await testAsync('splitSessionLog 容忍空行、拒绝坏 JSON', async () => {
  const ok = await parseSessionLog(`${HEADER_LINE()}\n${eventLine('sandbox/mode', 0)}\n\n`);
  assert.equal(ok.events.length, 1);
  await assert.rejects(
    () => parseSessionLog(`${HEADER_LINE()}\n{ 这不是 json\n`),
    (error) => error instanceof SessionLogError && /合法 JSON/u.test(error.message),
  );
});

test('buildImportedHeader 丢弃未知字段并强制独立会话语义', () => {
  const header = buildImportedHeader(
    { version: 3, id: 'old', createdAt: 123, cwd: '/a', isSeeded: true, parentSession: 'p', origin: 'subagent', delegationDepth: 4, agentPreset: 'standard', type: 'session', extra: 'x' },
    { id: 'new', cwd: '/ws' },
  );
  assert.deepEqual(header, { version: FORMAT_VERSION, id: 'new', createdAt: 123, cwd: '/ws', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' });
});

test('buildImportedHeader 为子代理保留 origin/深度/父引用', () => {
  const header = buildImportedHeader(
    { version: 3, id: 'old', createdAt: 5, cwd: '/a', isSeeded: false, delegationDepth: 2 },
    { id: 'new', cwd: '/ws', parentSession: 'root-new', origin: 'subagent' },
  );
  assert.equal(header.origin, 'subagent');
  assert.equal(header.delegationDepth, 2);
  assert.equal(header.parentSession, 'root-new');
});

test('buildImportedHeader 拒绝非法 createdAt 与空 cwd', () => {
  throwsWith(() => buildImportedHeader({ createdAt: -1 }, { id: 'n', cwd: '/ws' }), SessionLogError, /createdAt/u);
  throwsWith(() => buildImportedHeader({ createdAt: 1 }, { id: 'n', cwd: '' }), SessionLogError, /工作区路径/u);
});

/** 造一份「根 + 两层子代理」的规划输入。 */
function planFixture() {
  const root = { header: { id: 'root-old', createdAt: 10, cwd: '/old', isSeeded: false }, events: [{ seq: 0 }], storedVersion: 3 };
  const childA = { header: { id: 'child-a', createdAt: 11, cwd: '/old', isSeeded: false, parentSession: 'root-old', origin: 'subagent', delegationDepth: 1 }, events: [{ seq: 0 }], storedVersion: 3 };
  const childB = { header: { id: 'child-b', createdAt: 12, cwd: '/old', isSeeded: false, parentSession: 'child-a', origin: 'subagent', delegationDepth: 2 }, events: [], storedVersion: 3 };
  return {
    root: { parsed: root },
    subagents: [
      { idFromPath: 'child-a', parsed: childA },
      { idFromPath: 'child-b', parsed: childB },
    ],
    media: [],
    files: [],
    unknown: [],
  };
}

test('planArchiveImport 重映射嵌套子代理的父引用', () => {
  let counter = 0;
  const plan = planArchiveImport(planFixture(), {
    cwd: '/ws',
    idFactory: () => `new-${++counter}`,
    assignNewIds: true,
  });
  assert.equal(plan.sessions.length, 3);
  const [root, childA, childB] = plan.sessions;
  assert.equal(root.id, 'new-1');
  assert.equal(root.header.cwd, '/ws');
  assert.equal(childA.id, 'new-2');
  assert.equal(childA.header.parentSession, 'new-1', '子代理应挂到本次导入的新根 id');
  assert.equal(childB.header.parentSession, 'new-2', '孙代理应挂到重映射后的父 id，而不是新根 id');
  assert.equal(childB.header.delegationDepth, 2);
  assert.equal(plan.idMap.get('child-b'), 'new-3');
});

test('planArchiveImport 对归档外的父引用回落到新根并给出警告', () => {
  const archive = planFixture();
  archive.subagents[0].parsed.header.parentSession = 'not-in-archive';
  let counter = 0;
  const plan = planArchiveImport(archive, { cwd: '/ws', idFactory: () => `n${++counter}` });
  assert.equal(plan.sessions[1].header.parentSession, plan.sessions[0].id);
  assert.ok(plan.warnings.some((text) => /不在本归档内/u.test(text)));
});

test('planArchiveImport 可保留原 id，并在跳过子代理时告警', () => {
  const plan = planArchiveImport(planFixture(), { cwd: '/ws', idFactory: () => 'never', assignNewIds: false, includeSubagents: false });
  assert.equal(plan.sessions.length, 1);
  assert.equal(plan.sessions[0].id, 'root-old');
  assert.ok(plan.warnings.some((text) => /保留了原始会话 id/u.test(text)));
  assert.ok(plan.warnings.some((text) => /跳过/u.test(text)));
});

test('planArchiveImport 对 seed 派生源会话告警', () => {
  const archive = planFixture();
  archive.root.parsed.header.isSeeded = true;
  const plan = planArchiveImport(archive, { cwd: '/ws', idFactory: () => 'x' });
  assert.ok(plan.warnings.some((text) => /isSeeded/u.test(text)));
});

test('summarizeArchive 汇总形状稳定', () => {
  const archive = planFixture();
  archive.media = [{ path: 'media/a.png' }];
  const summary = summarizeArchive(archive);
  assert.equal(summary.originalSessionId, 'root-old');
  assert.equal(summary.rootEventCount, 1);
  assert.equal(summary.subagents.length, 2);
  assert.equal(summary.mediaCount, 1);
  assert.equal(summary.fileCount, 0);
});

test('normalizeConfig 坏值回落、好值保留', () => {
  const defaults = normalizeConfig(undefined);
  assert.equal(defaults.maxArchiveBytes, 256 * 1024 * 1024);
  assert.equal(defaults.assignNewIds, true);
  assert.equal(defaults.attachSubagents, false);
  const custom = normalizeConfig({ maxArchiveBytes: 2048, assignNewIds: false, attachSubagents: true, registerRetries: 'x' });
  assert.equal(custom.maxArchiveBytes, 2048);
  assert.equal(custom.assignNewIds, false);
  assert.equal(custom.attachSubagents, true);
  assert.equal(custom.registerRetries, defaults.registerRetries);
  assert.equal(normalizeConfig({ maxArchiveBytes: 1 }).maxArchiveBytes, 1024, '低于下限应夹到下限');
});

// ───────────────────────────── C. routes ─────────────────────────────

process.stdout.write('\nC. routes — 用假服务真跑 apply()\n');

/** 装配一套带假服务的 ctx 并 apply 本插件。 */
function setupPlugin(config) {
  const persistence = makeFakePersistence();
  const registry = makeFakeWorkspaces(persistence, [
    { id: 'ws-existing', path: '/root/nas/ArkTower', title: 'ArkTower', sessionIds: [] },
  ]);
  const savedFiles = [];
  const savedImages = [];
  const ctx = makeFakeCtx({
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    attachments: {
      async saveFile(input) { savedFiles.push(input); return { attachmentId: 'sha256:abcdef', name: input.name ?? '', bytes: input.data.length }; },
      async saveImage(input) { savedImages.push(input); return { attachmentId: 'not-the-same-id', mediaType: input.mediaType }; },
    },
  });
  apply(ctx, config);
  return { ctx, persistence, registry, savedFiles, savedImages };
}

/** 造一份含根 + 一条子代理的完整归档字节。 */
function archiveFixture() {
  return makeZip([
    { path: 'session.v3.jsonl', data: sampleLog({ id: 'session-source-0001' }, 3) },
    { path: 'subagents/child-1/session.v3.jsonl', data: sampleLog({ id: 'session-child-0001', parentSession: 'session-source-0001', origin: 'subagent', delegationDepth: 1 }, 2) },
    { path: 'files/ab/abcdef/note.txt', data: 'attachment body' },
  ]);
}

await testAsync('apply 注册六条路由，dispose 后全部撤销', () => {
  const { ctx } = setupPlugin();
  for (const path of ['/dsh-session-import/status', '/dsh-session-import/workspaces', '/dsh-session-import/browse', '/dsh-session-import/mkdir', '/dsh-session-import/inspect', '/dsh-session-import/import']) {
    assert.ok(ctx.routes.has(path), `缺少路由 ${path}`);
  }
  ctx.disposeAll();
  assert.equal(ctx.routes.size, 0);
});

await testAsync('GET /status 报告能力探测结果', async () => {
  const { ctx } = setupPlugin();
  const { status, value } = await callRoute(ctx, '/dsh-session-import/status');
  assert.equal(status, 200);
  assert.equal(value.ok, true);
  assert.equal(value.capabilities.workspaceRegistry, true);
  assert.equal(value.capabilities.sessionPersistence, true);
  assert.equal(value.capabilities.attachments, true);
  assert.equal(value.capabilities.formatCatalog, true, '格式目录应可装载');
});

await testAsync('GET /workspaces 列出既有工作区', async () => {
  const { ctx } = setupPlugin();
  const { value } = await callRoute(ctx, '/dsh-session-import/workspaces');
  assert.equal(value.workspaces.length, 1);
  assert.equal(value.workspaces[0].path, '/root/nas/ArkTower');
  assert.equal(value.workspaces[0].status, 'ok');
});

await testAsync('POST /inspect 只读：回概览且不写任何会话', async () => {
  const { ctx, persistence } = setupPlugin();
  const { status, value } = await callRoute(ctx, '/dsh-session-import/inspect', { method: 'POST', body: archiveFixture() });
  assert.equal(status, 200);
  assert.equal(value.summary.originalSessionId, 'session-source-0001');
  assert.equal(value.summary.rootEventCount, 3 + PARENT_CATALOG_EVENTS);
  assert.equal(value.summary.subagents.length, 1);
  assert.equal(value.summary.fileCount, 1);
  assert.equal(persistence.stored.size, 0, 'inspect 不得写入任何会话');
});

await testAsync('POST /inspect 拒绝非归档字节（400 而非 500）', async () => {
  const { ctx } = setupPlugin();
  const { status, value } = await callRoute(ctx, '/dsh-session-import/inspect', { method: 'POST', body: Buffer.from('not a zip', 'utf8') });
  assert.equal(status, 400);
  assert.equal(value.ok, false);
  assert.match(value.error, /EOCD|ZIP/u);
});

await testAsync('POST /inspect 拒绝空体', async () => {
  const { ctx } = setupPlugin();
  const { status } = await callRoute(ctx, '/dsh-session-import/inspect', { method: 'POST', body: Buffer.alloc(0) });
  assert.equal(status, 400);
});

await testAsync('跨站请求被拒（sec-fetch-site: cross-site）', async () => {
  const { ctx } = setupPlugin();
  const { status, value } = await callRoute(ctx, '/dsh-session-import/workspaces', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(status, 403);
  assert.match(value.error, /cross-origin/u);
});

await testAsync('跨站 Origin 被拒、同源 Origin 放行', async () => {
  const { ctx } = setupPlugin();
  const bad = await callRoute(ctx, '/dsh-session-import/workspaces', { headers: { origin: 'http://evil.test', host: '127.0.0.1:3080' } });
  assert.equal(bad.status, 403);
  const good = await callRoute(ctx, '/dsh-session-import/workspaces', { headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } });
  assert.equal(good.status, 200);
});

await testAsync('方法不匹配回 405', async () => {
  const { ctx } = setupPlugin();
  const { status } = await callRoute(ctx, '/dsh-session-import/workspaces', { method: 'DELETE' });
  assert.equal(status, 405);
});

await testAsync('GET /browse 列出真实目录并可上溯', async () => {
  const { ctx } = setupPlugin();
  const { value } = await callRoute(ctx, '/dsh-session-import/browse?path=%2Froot%2Fnas%2FArkTower');
  assert.equal(value.path, '/root/nas/ArkTower');
  assert.ok(Array.isArray(value.entries));
  const parent = await callRoute(ctx, '/dsh-session-import/browse?path=%2Froot');
  assert.equal(parent.value.path, '/root');
  assert.ok(parent.value.entries.some((entry) => entry.name === 'nas'), '应列出 /root/nas');
});

await testAsync('GET /browse 拒绝不存在的目录（404）', async () => {
  const { ctx } = setupPlugin();
  const { status } = await callRoute(ctx, '/dsh-session-import/browse?path=%2Fno%2Fsuch%2Fdir%2Fxyz');
  assert.equal(status, 404);
});

await testAsync('POST /mkdir 拒绝带分隔符的名字', async () => {
  const { ctx } = setupPlugin();
  const { status, value } = await callRoute(ctx, '/dsh-session-import/mkdir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parent: '/root', name: 'a/b' }),
  });
  assert.equal(status, 400);
  assert.match(value.error, /单个非空路径段/u);
});

await testAsync('POST /import 缺目标工作区时报 400 且不落库', async () => {
  const { ctx, persistence } = setupPlugin();
  const { status } = await callRoute(ctx, '/dsh-session-import/import', { method: 'POST', body: archiveFixture() });
  assert.equal(status, 400);
  assert.equal(persistence.stored.size, 0);
});

await testAsync('POST /import 到既有工作区：落库 + 记账 + 头 cwd 改写', async () => {
  const { ctx, persistence, registry } = setupPlugin();
  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing&includeSubagents=0', {
    method: 'POST',
    body: archiveFixture(),
  });
  assert.equal(status, 200, value?.error);
  assert.equal(value.ok, true);
  assert.equal(value.workspace.created, false);
  assert.equal(value.sessions.length, 1, 'includeSubagents=0 时只导入根会话');
  assert.match(value.sessionId, /^session-[0-9a-f-]{36}$/u);

  const root = persistence.stored.get(value.sessionId);
  assert.ok(root !== undefined, '根会话应落库');
  assert.equal(root.header.cwd, '/root/nas/ArkTower', '头 cwd 必须改写为目标工作区路径');
  assert.equal(root.header.isSeeded, false);
  assert.equal(root.header.id, value.sessionId);
  assert.equal(root.header.agentPreset, 'standard', 'agentPreset 应保留');
  assert.equal(root.events.length, 3 + PARENT_CATALOG_EVENTS);
  assert.equal(root.flushed, true, '必须走过 flush 才算落盘');
  assert.equal(root.closed, true, '句柄必须关闭');

  // 工作区账目：成员判定 = 账目 ∩ 头 cwd
  const workspace = await registry.get('ws-existing');
  assert.deepEqual([...workspace.sessionIds], [value.sessionId]);
});

await testAsync('POST /import 保留原会话 id 时，事件序号从 0 连续', async () => {
  const { ctx, persistence } = setupPlugin();
  const { value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing&assignNewIds=0', {
    method: 'POST',
    body: archiveFixture(),
  });
  assert.equal(value.sessionId, 'session-source-0001');
  const root = persistence.stored.get('session-source-0001');
  const seqs = root.events.map((event) => event.seq);
  assert.deepEqual(seqs, seqs.map((_, index) => index), '事件序号必须从 0 起严格连续');
});

await testAsync('POST /import 到新工作区：调用 create() 并标记 created', async () => {
  const { ctx, persistence, registry } = setupPlugin();
  // 用一个还不在 registry 里、但确实存在的目录（出厂的 create() 会对路径做 realpath）。
  const newPath = '/root/nas/ArkTower/docs';
  const { status, value } = await callRoute(ctx, `/dsh-session-import/import?newPath=${encodeURIComponent(newPath)}&newTitle=Imported`, {
    method: 'POST',
    body: archiveFixture(),
  });
  assert.equal(status, 200, value?.error);
  assert.equal(value.workspace.created, true, '新建时 registry 里还没有该路径，应走 create()');
  assert.equal(value.workspace.path, newPath);
  assert.equal(value.workspace.title, 'Imported');
  assert.equal(registry.records.size, 2, '应新增一条工作区记录');
  const root = persistence.stored.get(value.sessionId);
  assert.equal(root.header.cwd, newPath, '头 cwd 必须是新工作区路径，否则成员判定不成立');
  // 成员判定真的成立：账目 ∩ 头 cwd
  const workspace = await registry.get(value.workspace.id);
  assert.deepEqual([...workspace.sessionIds], [value.sessionId]);
});

await testAsync('POST /import 对已存在的工作区路径复用而非重复创建', async () => {
  const { ctx, registry } = setupPlugin();
  const before = registry.records.size;
  const { value } = await callRoute(ctx, '/dsh-session-import/import?newPath=%2Froot%2Fnas%2FArkTower', {
    method: 'POST',
    body: archiveFixture(),
  });
  assert.equal(value.workspace.created, true, 'create() 语义上仍算一次创建调用');
  assert.equal(value.workspace.id, 'ws-existing', '同一路径应复用既有记录');
  assert.equal(registry.records.size, before, '不应新增工作区记录');
});

await testAsync('POST /import 的 includeSubagents=1 会导入子代理并重映射父引用', async () => {
  const { ctx, persistence, registry } = setupPlugin();
  const { value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing&includeSubagents=1', {
    method: 'POST',
    body: archiveFixture(),
  });
  assert.equal(value.sessions.length, 2);
  const rootId = value.sessionId;
  const child = value.sessions.find((entry) => entry.role === 'subagent');
  const childStored = persistence.stored.get(child.id);
  assert.equal(childStored.header.parentSession, rootId, '子代理父引用应指向新根 id');
  assert.equal(childStored.header.origin, 'subagent');
  assert.equal(childStored.header.cwd, '/root/nas/ArkTower');

  // 默认记账口径：只有根会话进工作区账目（对齐本部署 438 条子代理会话无一记账的惯例）
  const workspace = await registry.get('ws-existing');
  assert.deepEqual([...workspace.sessionIds], [rootId]);
});

await testAsync('POST /import 的 attachSubagents=1 才把子代理记入账目', async () => {
  const { ctx, registry } = setupPlugin();
  const { value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing&includeSubagents=1&attachSubagents=1', {
    method: 'POST',
    body: archiveFixture(),
  });
  const workspace = await registry.get('ws-existing');
  assert.equal(workspace.sessionIds.length, 2);
  assert.ok(value.attached.length === 2);
});

await testAsync('POST /import 未知 workspaceId 回 404', async () => {
  const { ctx, persistence } = setupPlugin();
  const { status } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-nope', { method: 'POST', body: archiveFixture() });
  assert.equal(status, 404);
  assert.equal(persistence.stored.size, 0);
});

await testAsync('POST /import 非绝对路径回 400', async () => {
  const { ctx } = setupPlugin();
  const { status } = await callRoute(ctx, '/dsh-session-import/import?newPath=relative%2Fdir', { method: 'POST', body: archiveFixture() });
  assert.equal(status, 400);
});

await testAsync('POST /import 重复导入同一归档（保留 id）回 409 且不写第二条', async () => {
  const { ctx, persistence } = setupPlugin();
  const body = archiveFixture();
  const first = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing&assignNewIds=0&includeSubagents=0', { method: 'POST', body });
  assert.equal(first.status, 200);
  const second = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing&assignNewIds=0&includeSubagents=0', { method: 'POST', body });
  assert.equal(second.status, 409);
  assert.match(second.value.error, /已存在/u);
  assert.equal(persistence.stored.size, 1);
});

await testAsync('POST /import 重复导入同一归档（新分配 id）每次都成功且互不覆盖', async () => {
  const { ctx, persistence } = setupPlugin();
  const body = archiveFixture();
  // 默认 includeSubagents=1，所以每次导入写 2 条（根 + 1 条子代理）。
  const first = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing', { method: 'POST', body });
  const second = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing', { method: 'POST', body });
  assert.equal(first.status, 200, first.value?.error);
  assert.equal(second.status, 200, second.value?.error);
  assert.notEqual(first.value.sessionId, second.value.sessionId, '两次导入必须产出不同会话');
  assert.equal(persistence.stored.size, 4, '每次导入 2 条会话，两次共 4 条，互不覆盖');
  // 全部 4 条都在同一个工作区账目下（成员判定 = 账目 ∩ 头 cwd）
  const firstStored = persistence.stored.get(first.value.sessionId);
  const secondStored = persistence.stored.get(second.value.sessionId);
  assert.equal(firstStored.header.cwd, '/root/nas/ArkTower');
  assert.equal(secondStored.header.cwd, '/root/nas/ArkTower');
  assert.equal(firstStored.events.length, 3 + PARENT_CATALOG_EVENTS, '事件应逐条写入');
  assert.equal(secondStored.events.length, 3 + PARENT_CATALOG_EVENTS);
});

await testAsync('归档字节超上限回 413', async () => {
  const { ctx } = setupPlugin({ maxArchiveBytes: 1024 });
  const { status, value } = await callRoute(ctx, '/dsh-session-import/inspect', { method: 'POST', body: Buffer.alloc(4096, 0x41) });
  assert.equal(status, 413);
  assert.match(value.error, /超过上限/u);
});

await testAsync('附件回灌：文件摘要一致才计数，图片 id 不同则告警', async () => {
  const { ctx, savedFiles, savedImages } = setupPlugin();
  const { value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing', { method: 'POST', body: archiveFixture() });
  assert.equal(savedFiles.length, 1);
  assert.equal(savedFiles[0].name, 'note.txt');
  assert.equal(Buffer.from(savedFiles[0].data).toString('utf8'), 'attachment body');
  assert.equal(value.attachments.files, 1);
  assert.equal(savedImages.length, 0, '本归档没有图片条目');
});

await testAsync('配 rehydrateAttachments:false 时完全不碰附件服务', async () => {
  const { ctx, savedFiles } = setupPlugin({ rehydrateAttachments: false });
  await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing', { method: 'POST', body: archiveFixture() });
  assert.equal(savedFiles.length, 0);
});

await testAsync('附件服务缺席时导入照常成功', async () => {
  const persistence = makeFakePersistence();
  const registry = makeFakeWorkspaces(persistence, [{ id: 'ws-1', path: '/root/nas/ArkTower', title: 't', sessionIds: [] }]);
  const ctx = makeFakeCtx({ workspaceRegistry: registry, sessionPersistence: persistence });
  apply(ctx, {});
  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-1', { method: 'POST', body: archiveFixture() });
  assert.equal(status, 200, value?.error);
  assert.equal(value.attachments.files, 0);
});

await testAsync('会话持久化服务缺席时回 503 而不是 TypeError', async () => {
  // 目标工作区必须存在，处理链才会走到「取 sessionPersistence」那一步。
  const persistence = makeFakePersistence();
  const registry = makeFakeWorkspaces(persistence, [{ id: 'ws-1', path: '/root/nas/ArkTower', title: 't', sessionIds: [] }]);
  const ctx = makeFakeCtx({ workspaceRegistry: registry });
  apply(ctx, {});
  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-1', { method: 'POST', body: archiveFixture() });
  assert.equal(status, 503, value?.error);
  assert.match(value.error, /sessionPersistence/u);
});

// ───────────────────────────── D. real ─────────────────────────────

process.stdout.write('\nD. real — 用磁盘上的真实会话日志造归档\n');

const REAL_SESSION = '/root/.dsh/sessions/--root-code-Stronghold-Protocol-NetworkUnion--/session-05da3d09-98d9-4452-942c-55d5a80c7570/session.v3.jsonl.zstd';
const quick = process.argv.includes('--quick');

if (quick) {
  skip('真实语料往返', '--quick');
} else if (!existsSync(REAL_SESSION)) {
  skip('真实语料往返', '本机没有该样例会话（换机后跳过是正常的）');
} else {
  await testAsync('scanZstdFrames 定位全部帧（多帧是追加写的结果）', () => {
    const bytes = readFileSync(REAL_SESSION);
    const { frames, tornStart } = scanZstdFrames(bytes);
    assert.ok(frames.length > 1, `真实日志应为多帧，实得 ${frames.length}`);
    assert.equal(tornStart, undefined, '已正常结束的会话不应有撕裂尾帧');
    assert.equal(frames[0].start, 0, '第一帧应从头开始');
    assert.equal(frames.at(-1).end, bytes.length, '最后一帧应到文件末尾');
  });

  await testAsync('decodeZstdSessionLog 还原出连续事件的规范化 JSONL', async () => {
    const decoded = decodeZstdSessionLog(readFileSync(REAL_SESSION));
    const parsed = await parseSessionLog(decoded.text);
    assert.equal(parsed.via, 'catalog');
    assert.equal(parsed.degraded, null);
    assert.equal(parsed.storedVersion, 3);
    assert.ok(parsed.events.length > 3000, `事件数偏少：${parsed.events.length}`);
    // 序号必须从 0 起严格连续——这是 append 能否接受的前提
    parsed.events.forEach((event, index) => assert.equal(event.seq, index, `第 ${index} 条事件 seq 应为 ${index}`));
    assert.equal(String(parsed.header.id), 'session-05da3d09-98d9-4452-942c-55d5a80c7570');
  });

  await testAsync('真实归档走完整导入链路：落库内容与源逐条一致', async () => {
    const decoded = decodeZstdSessionLog(readFileSync(REAL_SESSION));
    const realArchive = makeZip([{ path: 'session.v3.jsonl', data: decoded.text }]);
    const { ctx, persistence, registry } = setupPlugin();
    const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing', { method: 'POST', body: realArchive });
    assert.equal(status, 200, value?.error);

    const stored = persistence.stored.get(value.sessionId);
    assert.ok(stored !== undefined);
    assert.equal(stored.header.cwd, '/root/nas/ArkTower', 'cwd 应改写为目标工作区');
    assert.equal(stored.header.agentPreset, 'standard');
    assert.equal(stored.header.createdAt, 1791428423680, 'createdAt 应保留源值');

    const source = await parseSessionLog(decoded.text);
    assert.equal(stored.events.length, source.events.length, '事件数应与源一致');
    assert.deepEqual(stored.events[0], source.events[0]);
    assert.deepEqual(stored.events.at(-1), source.events.at(-1));

    const workspace = await registry.get('ws-existing');
    assert.deepEqual([...workspace.sessionIds], [value.sessionId]);
  });
}

// ───────────── E. 对抗：真实写入器 / 符号链接 / 边界归档 ─────────────

/** 建一个临时目录，返回 { root, cleanup }。 */
async function scratchDir(label) {
  const root = await mkdtemp(join(tmpdir(), `dsh-import-${label}-`));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

await testAsync('fflate 流式 Zip（导出功能的实际写入器）产出的归档可被读取', async () => {
  let fflate;
  try {
    fflate = await import('fflate');
  } catch {
    skip('fflate 流式归档往返', 'fflate 不在解析路径上');
    return;
  }
  const encoder = new TextEncoder();
  // 逐字复刻 dsh-session-log-export.streamSessionLogZip 的写法：流式 Zip + ZipDeflate。
  // 流式 API 会把「数据描述符」标志（通用位标记 bit 3）置上——本地头的 crc/长度全是 0，
  // 真值跟在数据后面、只有中央目录里才有。这正是导出归档的真实形状。
  const expected = [
    ['session.v3.jsonl', sampleLog({ id: 'session-fflate-0001' }, 3)],
    ['subagents/child-1/session.v3.jsonl', sampleLog({ id: 'session-fflate-child', parentSession: 'session-fflate-0001', origin: 'subagent', delegationDepth: 1 }, 2)],
    ['files/ab/abcdef/note.txt', 'attachment body 中文'],
  ];
  const build = (level) => new Promise((resolve, reject) => {
    const chunks = [];
    const zip = new fflate.Zip((error, data, final) => {
      if (error) { reject(error); return; }
      chunks.push(Buffer.from(data));
      if (final) resolve(Buffer.concat(chunks));
    });
    for (const [path, text] of expected) {
      const file = new fflate.ZipDeflate(path, { level });
      zip.add(file);
      file.push(encoder.encode(text), true);
    }
    zip.end();
  });

  for (const level of [6, 0]) {
    const bytes = await build(level);
    const { entries } = readZip(bytes); // 读不动就抛，CRC/长度对不上也抛
    for (const [path, text] of expected) {
      assert.equal(new TextDecoder().decode(entries.get(path)), text, `level=${level} 条目 ${path} 内容不符`);
    }
    assert.equal(entries.size, expected.length);
  }

  // 确认夹具确实是「带数据描述符」的那一支，否则这条测试等于没测到点子上。
  const flagOf = (buffer) => new DataView(buffer.buffer, buffer.byteOffset).getUint16(6, true);
  const streamed = await build(6);
  const plain = makeZip([{ path: 'session.v3.jsonl', data: 'x' }]);
  assert.equal(flagOf(plain) & 0x8, 0, '本仓自带的夹具写入器不置 bit 3');
  // fflate 的流式写入器把 crc/长度留到数据之后（通用位标记 bit 3），本地头里全是 0。
  // 读取器必须只信中央目录——信本地头就会把长度读成 0、整包解不出来。
  assert.equal(flagOf(streamed) & 0x8, 0x8, 'fflate 流式归档应带数据描述符（bit 3）');

  // 完整导入一次，确认端到端也吃这套字节。
  const { ctx, persistence } = setupPlugin();
  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing', {
    method: 'POST', body: await build(6),
  });
  assert.equal(status, 200, JSON.stringify(value));
  const stored = persistence.stored.get(value.sessionId);
  assert.equal(stored.events.length, 3 + PARENT_CATALOG_EVENTS);
  assert.equal(stored.header.agentPreset, 'standard');
});

await testAsync('新工作区：符号链接路径经 fs.realpath 后写进 header.cwd', async () => {
  const { root, cleanup } = await scratchDir('symlink');
  try {
    const real = join(root, 'real-target');
    const link = join(root, 'link-to-target');
    await mkdir(real, { recursive: true });
    await symlink(real, link, 'dir');

    const { ctx, persistence, registry } = setupPlugin();
    const { status, value } = await callRoute(ctx, `/dsh-session-import/import?newPath=${encodeURIComponent(link)}`, {
      method: 'POST', body: archiveFixture(),
    });
    assert.equal(status, 200, JSON.stringify(value));

    const canonical = await realpath(real);
    const workspace = await registry.get(value.workspace.id);
    assert.equal(workspace.path, canonical, '工作区路径必须是 realpath 后的真实路径');
    assert.notEqual(workspace.path, link, '不应把符号链接路径留在账目里');

    const stored = persistence.stored.get(value.sessionId);
    assert.equal(stored.header.cwd, canonical, 'header.cwd 必须等于工作区路径，否则会话不会出现在侧边栏');
    // 账目 ∩ 头 cwd 过滤：这是成员判定的完整语义，必须真过一遍。
    assert.ok([...workspace.sessionIds].includes(value.sessionId), '导入的会话必须仍是工作区成员');
  } finally {
    await cleanup();
  }
});

await testAsync('新工作区：尾斜杠 / "." / ".." 同样被规范化', async () => {
  const { root, cleanup } = await scratchDir('messy');
  try {
    const real = join(root, 'w');
    await mkdir(real, { recursive: true });
    const messy = `${root}/./w/../w/`;
    const { ctx, persistence } = setupPlugin();
    const { status, value } = await callRoute(ctx, `/dsh-session-import/import?newPath=${encodeURIComponent(messy)}`, {
      method: 'POST', body: archiveFixture(),
    });
    assert.equal(status, 200, JSON.stringify(value));
    const canonical = await realpath(real);
    assert.equal(value.workspace.path, canonical);
    assert.equal(persistence.stored.get(value.sessionId).header.cwd, canonical);
  } finally {
    await cleanup();
  }
});

await testAsync('新工作区：目录不存在时拒绝，且不留下任何会话', async () => {
  const { root, cleanup } = await scratchDir('missing');
  try {
    const { ctx, persistence } = setupPlugin();
    const { status } = await callRoute(ctx, `/dsh-session-import/import?newPath=${encodeURIComponent(join(root, 'nope'))}`, {
      method: 'POST', body: archiveFixture(),
    });
    assert.equal(status, 400);
    assert.equal(persistence.stored.size, 0, '解析失败不得写入任何会话');
  } finally {
    await cleanup();
  }
});

await testAsync('源 cwd 在本机不存在也能导入（cwd 一律以目标工作区为准）', async () => {
  const { ctx, persistence } = setupPlugin();
  const archive = makeZip([
    { path: 'session.v3.jsonl', data: sampleLog({ id: 'session-src-9', cwd: '/nonexistent/elsewhere/xyz' }, 2) },
  ]);
  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing', {
    method: 'POST', body: archive,
  });
  assert.equal(status, 200, JSON.stringify(value));
  assert.equal(persistence.stored.get(value.sessionId).header.cwd, '/root/nas/ArkTower');
});

await testAsync('零事件归档（只有头）也能导入并记账', async () => {
  const { ctx, persistence, registry } = setupPlugin();
  const archive = makeZip([{ path: 'session.v3.jsonl', data: HEADER_LINE({ id: 'session-empty-1' }) }]);
  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing', {
    method: 'POST', body: archive,
  });
  assert.equal(status, 200, JSON.stringify(value));
  assert.equal(persistence.stored.get(value.sessionId).events.length, 0);
  assert.ok([...(await registry.get('ws-existing')).sessionIds].includes(value.sessionId));
});

await testAsync('根日志末尾没有换行也能解析', async () => {
  const { ctx } = setupPlugin();
  const noNewline = JSON.stringify({
    type: 'session', version: 3, id: 'session-nonl-1', createdAt: 1, cwd: '/x', isSeeded: false, delegationDepth: 0,
  });
  const archive = makeZip([{ path: 'session.v3.jsonl', data: noNewline }]);
  const { status, value } = await callRoute(ctx, '/dsh-session-import/inspect', { method: 'POST', body: archive });
  assert.equal(status, 200, JSON.stringify(value));
  assert.equal(value.summary.originalSessionId, 'session-nonl-1');
});

await testAsync('归档里出现两条根日志：用第一条，第二条如实上报为未知条目', async () => {
  const archive = makeZip([
    { path: 'session.v3.jsonl', data: sampleLog({ id: 'session-a' }, 1) },
    { path: 'session.v2.jsonl', data: sampleLog({ id: 'session-b' }, 1) },
  ]);
  const { entries } = readZip(archive);
  const classified = classifyArchiveEntries(entries);
  assert.equal(classified.rootPath, 'session.v3.jsonl', '第一条根日志胜出，不静默覆盖');
  assert.deepEqual(classified.unknown, ['session.v2.jsonl']);
});

await testAsync('非 ASCII 附件名可原样读回', async () => {
  const path = 'files/ab/abcdef/设计说明.txt';
  const archive = makeZip([
    { path: 'session.v3.jsonl', data: sampleLog({}, 1) },
    { path, data: '中文内容' },
  ]);
  const { entries } = readZip(archive);
  assert.equal(new TextDecoder().decode(entries.get(path)), '中文内容');
});

await testAsync('两万事件归档可导入且逐条保真', async () => {
  const count = 20000;
  const parts = [HEADER_LINE({ id: 'session-big-1' })];
  for (let index = 0; index < count; index += 1) {
    const turn = Math.floor(index / SAMPLE_EVENTS.length) + 1;
    const [type, data] = SAMPLE_EVENTS[index % SAMPLE_EVENTS.length];
    // turn 必须逐轮递增：v4 的迁移会校验 turn/start 是否开在「期望的那一轮」，
    // 整条日志反复用 turn: 1 会被判非法（0.1 不校验，所以旧夹具才蒙混过关）。
    parts.push(eventLine(type, index, typeof data.turn === 'number' ? { ...data, turn } : data));
  }
  const archive = makeZip([{ path: 'session.v3.jsonl', data: parts.join('') }]);
  const { ctx, persistence } = setupPlugin();
  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing&includeSubagents=0', {
    method: 'POST', body: archive,
  });
  assert.equal(status, 200, JSON.stringify(value));
  const stored = persistence.stored.get(value.sessionId);
  assert.equal(stored.events.length, count);
  assert.equal(stored.events.at(-1).seq, count - 1, 'seq 必须严格连续到末尾');
});

await testAsync('中途写入失败：如实上报已写入的会话，句柄全部关闭，且不记账', async () => {
  const { ctx, persistence, registry } = setupPlugin();
  const realCreate = persistence.create.bind(persistence);
  let calls = 0;
  persistence.create = async (header) => {
    calls += 1;
    if (calls === 2) throw new Error('磁盘写满（模拟）');
    return realCreate(header);
  };

  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing', {
    method: 'POST', body: archiveFixture(),
  });
  assert.equal(status, 500);
  assert.match(value.error, /已成功写入 1 条会话/, '必须如实上报已写入的部分，而不是假装整体回滚');

  const ids = [...persistence.stored.keys()];
  assert.equal(ids.length, 1, '只有第一条应当落库');
  assert.ok(value.error.includes(ids[0]), '错误信息必须点名已写入的会话');
  assert.equal(persistence.stored.get(ids[0]).flushed, true);
  assert.equal(persistence.stored.get(ids[0]).closed, true, '已写入会话的句柄必须被关闭');
  assert.deepEqual([...(await registry.get('ws-existing')).sessionIds], [], '失败的导入不得记入工作区账目');
});

await testAsync('append 抛错时句柄同样被关闭', async () => {
  const { ctx, persistence } = setupPlugin();
  const realCreate = persistence.create.bind(persistence);
  persistence.create = async (header) => {
    const handle = await realCreate(header);
    return { ...handle, async append() { throw new Error('append 失败（模拟）'); } };
  };
  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing&includeSubagents=0', {
    method: 'POST', body: archiveFixture(),
  });
  assert.equal(status, 500);
  assert.match(value.error, /append 失败/);
  const ids = [...persistence.stored.keys()];
  assert.equal(ids.length, 1);
  assert.equal(persistence.stored.get(ids[0]).closed, true, 'append 抛错后句柄仍必须被关闭');
});

// ───────────── F. 更新代（前向通道）与写前预校验 ─────────────

/**
 * 一条「头声明的存储代」与「事件内容」解耦的日志。
 * 专测前向通道：本进程只写到 v3，头写 v4 即触发。
 */
function forwardLog(version, events, overrides = {}) {
  let text = `${JSON.stringify({
    type: 'session',
    version,
    id: 'session-future-0001',
    createdAt: 1700000000000,
    cwd: '/root/code/elsewhere',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
    ...overrides,
  })}\n`;
  for (const [type, seq, data, extra] of events) {
    text += `${JSON.stringify({ type, seq, time: 1700000000000 + seq, data, ...(extra ?? {}) })}\n`;
  }
  return text;
}

/** 前向通道夹具：四个本进程**认识**的事件，信封合法。 */
const FORWARD_EVENTS = [
  ['turn/start', 0, { turn: 1 }],
  ['step/start', 1, { turn: 1, step: 1 }],
  ['step/end', 2, { turn: 1, step: 1 }],
  ['turn/end', 3, { turn: 1, reason: { kind: 'completed' } }],
];

await testAsync('更新代（current+1）：经 readHeader 结构化判定走前向通道，而不是抛出「this build writes vN」', async () => {
  const parsed = await parseSessionLog(forwardLog(NEXT_FORMAT_VERSION, FORWARD_EVENTS));
  assert.equal(parsed.via, 'forward');
  assert.equal(parsed.storedVersion, NEXT_FORMAT_VERSION);
  assert.equal(parsed.degraded.kind, 'newer-format');
  assert.equal(parsed.degraded.storedVersion, NEXT_FORMAT_VERSION);
  assert.equal(parsed.degraded.targetVersion, FORMAT_VERSION);
  assert.equal(parsed.events.length, FORWARD_EVENTS.length, '事件必须逐字保留');
  assert.equal(parsed.events[0].seq, 0);
  assert.equal(parsed.events[3].type, 'turn/end');
});

await testAsync('更新代（current+1）：POST /inspect 如实报告代际，并给出一条讲明代际的告警', async () => {
  const { ctx } = setupPlugin();
  const zip = makeZip([{ path: `session.v${NEXT_FORMAT_VERSION}.jsonl`, data: forwardLog(NEXT_FORMAT_VERSION, FORWARD_EVENTS) }]);
  const { status, value } = await callRoute(ctx, '/dsh-session-import/inspect', { method: 'POST', body: zip });
  assert.equal(status, 200);
  assert.equal(value.summary.via, 'forward');
  assert.equal(value.summary.storedVersion, NEXT_FORMAT_VERSION);
  assert.equal(value.summary.degraded.kind, 'newer-format');
  assert.equal(value.summary.rootEventCount, FORWARD_EVENTS.length);
  assert.ok(value.warnings.some((text) => text.includes('v4')), '应有一条讲明代际的告警');
});

await testAsync('更新代（v4）：事件全是本进程认识的类型时可导入，且逐条保真', async () => {
  const { ctx, persistence } = setupPlugin();
  const zip = makeZip([{ path: `session.v${NEXT_FORMAT_VERSION}.jsonl`, data: forwardLog(NEXT_FORMAT_VERSION, FORWARD_EVENTS) }]);
  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing', { method: 'POST', body: zip });
  assert.equal(status, 200);
  const written = persistence.stored.get(String(value.sessionId));
  assert.ok(written !== undefined, '会话应已写入');
  assert.equal(written.events.length, FORWARD_EVENTS.length);
  for (let index = 0; index < FORWARD_EVENTS.length; index += 1) {
    const [type, seq, data] = FORWARD_EVENTS[index];
    assert.equal(written.events[index].type, type);
    assert.equal(written.events[index].seq, seq);
    assert.deepEqual(written.events[index].data, data);
  }
  assert.equal(written.closed, true);
});

await testAsync('更新代（v4）：未知且未标 ignorable 的事件 -> 整包被拒，且一条会话都没写', async () => {
  const { ctx, persistence } = setupPlugin();
  const zip = makeZip([{ path: `session.v${NEXT_FORMAT_VERSION}.jsonl`, data: forwardLog(NEXT_FORMAT_VERSION, [
    ['turn/start', 0, { turn: 1 }],
    ['future/brand-new', 1, { x: 1 }],
  ]) }]);
  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing', { method: 'POST', body: zip });
  assert.equal(status, 400, '归档内容不合格属请求侧错误（SessionLogError -> 400），不是 500');
  assert.match(value.error, /unknown to this harness and not marked ignorable/);
  assert.equal(persistence.stored.size, 0, '写前预校验必须先于 create——不能留下只有头的残会话');
});

await testAsync('更新代（v4）：标了 ignorable 的未知事件被放行，标记原样保留', async () => {
  const { ctx, persistence } = setupPlugin();
  const zip = makeZip([{ path: `session.v${NEXT_FORMAT_VERSION}.jsonl`, data: forwardLog(NEXT_FORMAT_VERSION, [
    ['turn/start', 0, { turn: 1 }],
    ['future/brand-new', 1, { x: 1 }, { ignorable: true }],
  ]) }]);
  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing', { method: 'POST', body: zip });
  assert.equal(status, 200);
  const written = persistence.stored.get(String(value.sessionId));
  assert.equal(written.events.length, 2);
  assert.equal(written.events[1].type, 'future/brand-new');
  assert.equal(written.events[1].ignorable, true, 'ignorable 标记必须原样带过去');
});

await testAsync('写前预校验：seq 不连续的批次在 create 之前被拒，磁盘无残留', async () => {
  const { ctx, persistence } = setupPlugin();
  const zip = makeZip([{ path: `session.v${NEXT_FORMAT_VERSION}.jsonl`, data: forwardLog(NEXT_FORMAT_VERSION, [
    ['turn/start', 0, { turn: 1 }],
    ['turn/end', 7, { turn: 1, reason: { kind: 'completed' } }],
  ]) }]);
  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing', { method: 'POST', body: zip });
  assert.equal(status, 400);
  assert.match(value.error, /未通过写前校验/);
  assert.equal(persistence.stored.size, 0);
});

await testAsync('写前预校验：整个计划先全过再写——第 2 条不合格时第 1 条也不会落盘', async () => {
  const { ctx, persistence } = setupPlugin();
  const zip = makeZip([
    { path: `session.v${NEXT_FORMAT_VERSION}.jsonl`, data: forwardLog(NEXT_FORMAT_VERSION, FORWARD_EVENTS) },
    { path: `subagents/child-1/session.v${NEXT_FORMAT_VERSION}.jsonl`, data: forwardLog(NEXT_FORMAT_VERSION, [
      ['turn/start', 0, { turn: 1 }],
      ['future/brand-new', 1, { x: 1 }],
    ], { id: 'session-future-child', parentSession: 'session-future-0001', origin: 'subagent', delegationDepth: 1 }) },
  ]);
  const { status, value } = await callRoute(ctx, '/dsh-session-import/import?workspaceId=ws-existing&includeSubagents=1', { method: 'POST', body: zip });
  assert.equal(status, 400);
  assert.match(value.error, /unknown to this harness and not marked ignorable/);
  assert.equal(persistence.stored.size, 0, '根会话合格、子代理不合格时，根会话也不得写入');
});

await testAsync('prevalidateSession：契约缺席时退化为放行（真正把关仍在 append）', () => {
  const header = { version: 3, id: 's-x', createdAt: 1, cwd: '/tmp', isSeeded: false, agentPreset: null, delegationDepth: 0 };
  const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }];
  assert.equal(prevalidateSession(header, events, undefined), events);
});

await testAsync('prevalidateSession：真实契约下 seq 不从 0 起即拒绝', async () => {
  const contract = await loadPersistenceContract();
  assert.ok(contract !== undefined, '持久化契约应可装载');
  const header = { version: 3, id: 's-x', createdAt: 1, cwd: '/tmp', isSeeded: false, agentPreset: null, delegationDepth: 0 };
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 5, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  assert.throws(() => prevalidateSession(header, events, contract), (error) => {
    assert.ok(error instanceof SessionLogError, '应包成 SessionLogError');
    assert.match(error.message, /未通过写前校验/);
    return true;
  });
});

await testAsync('目录通道的 degraded 为 null（只有前向/朴素通道才是对象）', async () => {
  const parsed = await parseSessionLog(sampleLog({}, 2));
  assert.equal(parsed.via, 'catalog');
  assert.equal(parsed.degraded, null);
});

// ───────────────────────────── 汇总 ─────────────────────────────

process.stdout.write(`\n${passed} 项通过，${failures.length} 项失败，${skipped.length} 项跳过\n`);
if (failures.length > 0) {
  process.stdout.write('\n失败明细：\n');
  for (const failure of failures) {
    process.stdout.write(`  · ${failure.name}\n    ${failure.error instanceof Error ? failure.error.stack : String(failure.error)}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write('SELFTEST PASS\n');
}
