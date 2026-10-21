/**
 * dsh-message-branches host 半边（entry-v4.js）自测 —— 纯 node、无副作用。
 *
 * 覆盖三块：
 *   ① 纯逻辑：resolveConfig / sanitizeMessageSet / viewMessageSet / createStore
 *      （建分支、幂等去重、粘性切换、越界拒绝、落盘 round-trip、旧版字段保留、
 *       双实例合并写）；
 *   ② 路由：用假 ctx + 假 req/res 真调 apply 注册进来的 handler（方法守卫、
 *      同源守卫、参数校验、成功路径、错误路径）；
 *   ③ 静态钉住 v4 的语义边界：不建会话、不记账、不碰会话日志读取服务。
 *
 * 硬约束：所有状态目录都是 mkdtemp 造在 /tmp 下的显式路径，**绝不**指向
 * $DSH_HOME/message-branches（线上真实数据根零接触）。
 *
 * 运行：node plugins/dsh-message-branches/selftest.mjs
 * 末行输出 SELFTEST PASS n/n 或 SELFTEST FAIL …，退出码 0/1。
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mod = await import('./entry-v4.js');
const {
  name, VERSION, ROUTE_PREFIX, resolveConfig, sanitizeMessageSet, viewMessageSet, viewGroup,
  createStore, dshHomeDir, defaultStateDir, apply,
} = mod;

const SANDBOX = mkdtempSync(join(tmpdir(), 'mb-host-selftest-'));
let seq = 0;
const stateDir = () => { seq += 1; return mkdtempSync(join(SANDBOX, `state-${seq}-`)); };

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };
const deepEq = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks += 1; };
const throws = (fn, pattern, message) => {
  assert.throws(fn, pattern, message);
  checks += 1;
};
const step = (label) => console.log(`· ${label}`);

/* ══════════════════════ 假 HTTP（req/res + ctx） ══════════════════════ */

/** 极简 req：body 通过 send() 异步灌入（readBody 只认 data/end/error/aborted）。 */
function makeReq(method, url, body, headers = {}) {
  const handlers = new Map();
  return {
    method,
    url,
    headers,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    emit(event, arg) { for (const fn of handlers.get(event) ?? []) fn(arg); },
    send() {
      if (body !== undefined && body !== null) this.emit('data', Buffer.from(body, 'utf8'));
      this.emit('end');
      return Promise.resolve();
    },
  };
}

function makeRes() {
  const res = { status: 0, headers: null, body: '', ended: false };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = (text) => { res.body = String(text ?? ''); res.ended = true; };
  res.json = () => JSON.parse(res.body);
  return res;
}

/** 假 ctx：effect 立即执行并记账；webServer.register 捕获 handler。 */
function makeCtx(options = {}) {
  const routes = new Map();
  const effects = [];
  const warnings = [];
  const infos = [];
  const duplicateTimes = options.duplicateTimes ?? 0;
  const attempts = new Map();
  const ctx = {
    routes,
    effects,
    warnings,
    infos,
    attempts,
    // clientModules 桩：让 /status 的 client 半边状态走「已组装」分支（与线上一致）。
    get(service) {
      if (service === 'clientModules') {
        return {
          graph: () => ({ rev: 'graph-rev', entries: [{ id: name, rev: 'entry-rev', url: 'plugins/??dsh-message-branches/client.js&rev=entry-rev' }] }),
          clientPath: (id) => `/fake/client/${id}/client.js`,
        };
      }
      return undefined;
    },
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: (message) => infos.push(String(message)),
    },
    webServer: {
      register(spec) {
        // 报文与出厂 dsh-host-webserver 逐字一致（插件靠 /duplicate .*route/i 识别它）。
        const seen = (attempts.get(spec.path) ?? 0) + 1;
        attempts.set(spec.path, seen);
        if (routes.has(spec.path)) { const error = new Error(`webserver: duplicate exact route "${spec.path}"`); error.code = 'DUPLICATE'; throw error; }
        if (seen <= duplicateTimes) { const error = new Error(`webserver: duplicate exact route "${spec.path}"`); error.code = 'DUPLICATE'; throw error; }
        routes.set(spec.path, spec.handler);
        return () => routes.delete(spec.path);
      },
    },
    effect(callback, label) {
      const disposer = callback();
      effects.push({ label, disposer });
      return () => { if (typeof disposer === 'function') disposer(); };
    },
  };
  return ctx;
}

/** 真调一条路由：建 req/res → send → 等 readBody 的 promise 链走完。 */
async function call(ctx, method, url, body) {
  const path = new URL(url, 'http://localhost').pathname; // 路由按 path 注册，查询串由 handler 自己解析
  const handler = ctx.routes.get(path);
  assert.ok(handler !== undefined, `路由未注册：${path}`);
  const req = makeReq(method, url, body, { host: 'localhost:3080' });
  const res = makeRes();
  handler(req, res);
  await req.send();
  for (let round = 0; round < 8 && !res.ended; round += 1) await new Promise((r) => setImmediate(r));
  return res;
}

const post = (ctx, path, body) => call(ctx, 'POST', path, JSON.stringify(body));
const get = (ctx, path) => call(ctx, 'GET', path);

/* ══════════════════════ ① 纯逻辑 ══════════════════════ */

function caseConfig() {
  const base = resolveConfig({});
  eq(base.stateDir, defaultStateDir(), '缺省 stateDir = $DSH_HOME/message-branches');
  eq(base.maxEditedTextChars, 20000, '缺省单条分支文本上限 20000 字符');
  eq(base.bodyLimit, 256 * 1024, '缺省 body 上限 256KB');
  eq(resolveConfig({ stateDir: '/tmp/x', maxEditedTextChars: 50 }).stateDir, '/tmp/x', 'stateDir 可覆盖');
  eq(resolveConfig({ maxEditedTextChars: 10 }).maxEditedTextChars, 200, '上限被夹到 200（防 0/负值）');
  throws(() => resolveConfig({ shellScan: true }), /未知配置项/, 'v3 的记账类配置项一律不再接受（语义已删）');
  throws(() => resolveConfig('nope'), /config 必须是对象/, 'config 必须是对象');
  ok(dshHomeDir().length > 1, 'dshHomeDir 可解析');
}

function caseSanitize() {
  deepEq(sanitizeMessageSet(null), null, '非对象 → null');
  deepEq(sanitizeMessageSet({ seq: 'x' }), null, 'seq 非整数 → null');
  deepEq(sanitizeMessageSet({ seq: -1 }), null, 'seq 负数 → null');
  const clean = sanitizeMessageSet({ seq: 7, variants: [{ text: '甲' }, { text: '乙' }, { nope: 1 }, null], selected: 99 });
  eq(clean.seq, 7, 'seq 归一');
  eq(clean.variants.length, 2, '坏 variant 记录被剔除（只留有 text 的）');
  eq(clean.selected, 2, 'selected 越界时夹到最大分支号');
  eq(clean.variants[0].label, '甲', '缺省 label 取首行');
  eq(sanitizeMessageSet({ seq: 3, variants: [] }).selected, 0, '无 variant 时 selected=0（原文）');
  const view = viewMessageSet(clean);
  eq(view.total, 3, 'total = 1（原文）+ 2 个改写版');
  eq(view.selected, 2, '视图透出 selected');
  eq(view.variants[1].text, '乙', '视图带全文（渲染要用）');
  eq(viewGroup(null), null, 'viewGroup(null) = null');
}

function caseStore() {
  const dir = stateDir();
  const errors = [];
  const store = createStore(dir, (error) => errors.push(error));

  eq(store.groupForSession('s1'), null, '初始没有任何组');
  eq(store.messageSet('s1', 42), null, '没有分支集 → null（调用方不渲染导航条）');

  const first = store.addVariant('s1', 42, '第一版改写');
  eq(first.total, 2, '建第一个分支后 total=2');
  eq(first.selected, 1, '新建的分支自动成为当前分支（显式动作）');
  eq(first.variants[0].text, '第一版改写', '分支文本入库');

  const again = store.addVariant('s1', 42, '第一版改写');
  eq(again.total, 2, '同一文本重复提交不造重复分支（幂等）');
  eq(again.selected, 1, '重复提交只把选择移过去');

  const second = store.addVariant('s1', 42, '第二版改写');
  eq(second.total, 3, '第二个分支 total=3');
  eq(second.selected, 2, '当前 = 新分支');

  const other = store.addVariant('s1', 7, '另一条消息的分支');
  eq(other.total, 2, '同一会话的另一条消息各自成集');
  eq(store.messageSet('s1', 42).total, 3, '两条消息互不影响');

  throws(() => store.addVariant('s1', 42, '   '), /不能为空/, '空白文本拒绝');
  throws(() => store.addVariant('', 42, 'x'), /需要 sessionId/, '缺 sessionId 拒绝');
  throws(() => store.addVariant('s1', 1.5, 'x'), /seq 必须是非负整数/, '非整数 seq 拒绝');

  const zero = store.addVariant('s2', 0, 'seq 0 也认');
  eq(zero.seq, 0, 'seq=0（首条）可用');

  // 粘性切换
  eq(store.selectVariant('s1', 42, 0).selected, 0, '可切回原文（分支 1）');
  eq(store.selectVariant('s1', 42, 1).selected, 1, '可切到中间分支');
  throws(() => store.selectVariant('s1', 42, 3), /越界/, '序号越界拒绝');
  throws(() => store.selectVariant('s1', 42, -1), /越界/, '负序号拒绝');
  throws(() => store.selectVariant('s1', 999, 0), /没有分支/, '不存在的消息拒绝');
  throws(() => store.selectVariant('nope', 42, 0), /没有分支/, '不存在的会话拒绝');

  // 落盘 round-trip：新实例（模拟重启）必须读得回来
  const reopened = createStore(dir, (error) => errors.push(error));
  eq(reopened.messageSet('s1', 42).total, 3, '重启后分支数不变');
  eq(reopened.messageSet('s1', 42).selected, 1, '重启后粘性选择不变');
  eq(reopened.messageSet('s1', 42).variants[1].text, '第二版改写', '重启后分支文本不丢');
  eq(reopened.messageSet('s2', 0).total, 2, '另一会话也在');

  // 双实例合并写：A 写 s1、B 写 s3，互不抹
  const other2 = createStore(dir, (error) => errors.push(error));
  other2.addVariant('s3', 5, 'C 的分支');
  reopened.addVariant('s1', 42, '第三版改写');
  const merged = createStore(dir, (error) => errors.push(error));
  eq(merged.messageSet('s1', 42).total, 4, 'A 的写入没被 B 抹掉');
  eq(merged.messageSet('s3', 5).total, 2, 'B 的写入也没被 A 抹掉');

  deepEq(errors, [], '全过程无状态读写错误');
}

function caseLegacy() {
  const dir = stateDir();
  // v1 的真账本（2026-10-18 那条空白分支）：v4 读入不解释、写回不删除。
  const legacy = {
    version: 1,
    groups: {
      'session-root': {
        id: 'session-root',
        rootSessionId: 'session-root',
        createdAt: 1792320707411,
        updatedAt: 1792320707414,
        selectedSessionId: 'session-child',
        branches: [
          { sessionId: 'session-root', parentSessionId: null, kind: 'root', label: '原始' },
          { sessionId: 'session-child', parentSessionId: 'session-root', kind: 'blank', label: '✎ 找出龙门的餐馆场景', editSeq: 8 },
        ],
      },
    },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'groups.json'), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

  const store = createStore(dir, () => {});
  eq(store.groupForSession('session-root').branches.length, 2, 'v1 的 branches 原样读入（ultracode 谱系要靠它）');
  eq(store.messageSet('session-root', 8), null, '旧账本里没有 messages → 没有分支集');

  store.addVariant('session-root', 8, '新口径下的分支');
  const onDisk = JSON.parse(readFileSync(join(dir, 'groups.json'), 'utf8'));
  eq(onDisk.version, 2, '写回时版本号升到 2');
  eq(onDisk.groups['session-root'].branches.length, 2, '旧 branches 字段写回时仍在（不被悄悄删掉）');
  eq(onDisk.groups['session-root'].messages['8'].variants.length, 1, '新分支写进 messages');
}

function caseBrokenFile() {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'groups.json'), '{ 这不是 JSON', 'utf8');
  const errors = [];
  const store = createStore(dir, (error) => errors.push(error));
  eq(errors.length, 1, '坏文件只在装配期告警一次，不抛');
  eq(store.groupForSession('s1'), null, '坏文件按空表服务');
  const view = store.addVariant('s1', 1, '坏文件之后照样能写');
  eq(view.total, 2, '坏文件不阻塞后续写入（整表重写）');
  const backups = readdirSync(dir).filter((f) => f.startsWith('groups.json.corrupt-'));
  eq(backups.length, 1, '重写前把坏文件改名留证（绝不静默覆盖）');
  eq(readFileSync(join(dir, backups[0]), 'utf8'), '{ 这不是 JSON', '备份里是原文');
  eq(errors.length, 2, '写期也告警一次（装配 + 写期各一次）');
  const reopened = createStore(dir, () => {});
  eq(reopened.messageSet('s1', 1).total, 2, '重写后文件可读');
}

function caseWrongShapeFile() {
  // 合法 JSON 但形状不符：这正是「静默毁数据」的那条路，必须备份 + 告警。
  for (const shape of [{ version: 2, groups: null }, { version: 2, groups: [] }, { version: 2, groups: '文本' }, { nope: 1 }]) {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const original = JSON.stringify(shape);
    writeFileSync(join(dir, 'groups.json'), original, 'utf8');
    const errors = [];
    const store = createStore(dir, (error) => errors.push(error));
    eq(errors.length, 1, `形状不符（${original.slice(0, 24)}…）照样告警（不静默按空表服务）`);
    store.addVariant('s1', 1, 'x');
    const backups = readdirSync(dir).filter((f) => f.startsWith('groups.json.corrupt-'));
    eq(backups.length, 1, '形状不符的文件也被留证');
    eq(readFileSync(join(dir, backups[0]), 'utf8'), original, '备份里是原文（一个字节都没动）');
    const onDisk = JSON.parse(readFileSync(join(dir, 'groups.json'), 'utf8'));
    eq(onDisk.version, 2, '重写后是 version 2');
    eq(Object.keys(onDisk.groups).length, 1, '重写后只有本进程这一条');
  }
}

/** 把账本文件换成同名目录：之后任何写（含 rename）必失败，用来造「写盘失败」。 */
function blockWrites(dir) {
  const target = join(dir, 'groups.json');
  try { rmSync(target, { recursive: true, force: true }); } catch { /* 本来就没有 */ }
  mkdirSync(target);
}

function caseReadFailure() {
  // 账本**读不到**（不是损坏）：绝不能备份、不能重写——文件可能完全好。
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  blockWrites(dir); // 把账本文件换成一个目录：readFileSync 必失败
  const errors = [];
  const store = createStore(dir, (error) => errors.push(error));
  eq(errors.length, 1, '读不到只在装配期告警一次');
  eq(store.groupForSession('s1'), null, '读不到按空表服务');
  throws(() => store.addVariant('s1', 1, 'x'), /未做任何改动/, '读不到时拒绝写入（不假成功）');
  const backups = readdirSync(dir).filter((f) => f.startsWith('groups.json.corrupt-'));
  eq(backups.length, 0, '读不到绝不备份（好账不能被当坏账搬走）');
  eq(statSync(join(dir, 'groups.json')).isDirectory(), true, '原样原封不动（还是个目录）');
}

/** 让**写**必败而读照常：在 atomicWriteJson 的 tmp 路径上放一个同名目录（EISDIR）。 */
function blockWriteOnly(dir) {
  const target = join(dir, `groups.json.tmp-${process.pid}`);
  try { rmSync(target, { recursive: true, force: true }); } catch { /* 本来就没有 */ }
  mkdirSync(target);
}

function caseWriteFailure() {
  // 写盘失败：内存改动回滚 + 抛 STORE_WRITE_FAILED（路由据此回 500）。
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  blockWrites(dir); // 写必失败（EISDIR）
  const errors = [];
  const store = createStore(dir, (error) => errors.push(error));
  let failure = null;
  try { store.addVariant('s1', 1, 'x'); } catch (error) { failure = error; }
  ok(failure !== null, '写盘失败要抛');
  eq(failure.code, 'STORE_WRITE_FAILED', '错误带 STORE_WRITE_FAILED 码（路由回 500 用）');
  eq(store.groupForSession('s1'), null, '内存改动已回滚（这个会话本来没有组）');
  eq(errors.length >= 2, true, '写期也告警了');

  // 已有分支时切换失败：selected 停在原值。
  const dir2 = stateDir();
  const good = createStore(dir2, () => {});
  good.addVariant('s1', 1, '甲');
  good.addVariant('s1', 1, '乙');
  const before = good.messageSet('s1', 1).selected;
  blockWriteOnly(dir2); // 现在再写必失败（读不受影响，走到的是写分支）
  throws(() => good.selectVariant('s1', 1, 0), /未做任何改动/, '切换写盘失败也抛');
  eq(good.messageSet('s1', 1).selected, before, 'selected 回滚到原值');
}

function caseMergeTieBreak() {
  // 同一毫秒内的两次写（冻结时钟）：后一次绝不能被前一次抹掉。
  const dir = stateDir();
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    const store = createStore(dir, () => {});
    store.addVariant('s1', 1, '甲');     // updatedAt = frozen
    store.selectVariant('s1', 1, 0);     // 同一毫秒 → updatedAt 不变
    const reopened = createStore(dir, () => {});
    eq(reopened.messageSet('s1', 1).selected, 0, '同一毫秒内的后一次写赢（平局时内存优先）');
    eq(reopened.messageSet('s1', 1).total, 2, '分支本身也在');
  } finally {
    Date.now = realNow;
  }
}

function casePerMessageMerge() {
  // 两个实例（模拟两个进程）写**同一个会话的不同消息**：逐条合并，谁都不许抹谁。
  const dir = stateDir();
  const a = createStore(dir, () => {});
  const b = createStore(dir, () => {});
  a.addVariant('shared', 1, 'A 写的 seq1');
  b.addVariant('shared', 2, 'B 写的 seq2');
  a.addVariant('shared', 3, 'A 写的 seq3');
  const merged = createStore(dir, () => {});
  eq(merged.messageSet('shared', 1).total, 2, 'A 的 seq1 没被 B 抹掉');
  eq(merged.messageSet('shared', 2).total, 2, 'B 的 seq2 没被 A 抹掉');
  eq(merged.messageSet('shared', 3).total, 2, 'A 的 seq3 也在');

  // 同一条消息的并发：updatedAt 较新的赢（不会两条变体无故互相吞）。
  const c = createStore(dir, () => {});
  const d = createStore(dir, () => {});
  c.addVariant('shared', 1, 'C 的第一版');
  d.addVariant('shared', 1, 'D 的第一版');
  const last = createStore(dir, () => {});
  ok(last.messageSet('shared', 1).variants.length >= 1, '同消息并发后至少保留一条（不炸）');
}

function caseSelectedDefault() {
  // 脏数据里 selected 缺失 → 回原文（0），绝不默认跳到最后一个改写版。
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'groups.json'), JSON.stringify({
    version: 2,
    groups: { s1: { id: 's1', rootSessionId: 's1', messages: { '9': { seq: 9, variants: [{ id: 'x', text: '甲' }, { id: 'y', text: '乙' }] } } } },
  }), 'utf8');
  const store = createStore(dir, () => {});
  eq(store.messageSet('s1', 9).selected, 0, 'selected 缺失 → 0（原文）');
  eq(store.messageSet('s1', 9).total, 3, 'variants 照常读入');
}

/* ══════════════════════ ② 路由 ══════════════════════ */

function caseRoutes() {
  const dir = stateDir();
  const ctx = makeCtx();
  apply(ctx, { stateDir: dir });
  eq(ctx.routes.size, 5, 'v4 只注册 5 条路由（status/client/state/branch/select）');
  for (const path of [`${ROUTE_PREFIX}/status`, `${ROUTE_PREFIX}/client`, `${ROUTE_PREFIX}/state`, `${ROUTE_PREFIX}/branch`, `${ROUTE_PREFIX}/select`]) {
    ok(ctx.routes.has(path), `路由在场：${path}`);
  }
  for (const gone of ['register', 'label', 'rollback/plan', 'rollback/apply', 'rollback/undo', 'targets']) {
    ok(!ctx.routes.has(`${ROUTE_PREFIX}/${gone}`), `v3 的 ${gone} 路由已删除（语义不存在了）`);
  }
  ok(ctx.infos.some((line) => line.includes('不建会话')), '就绪日志说明新语义');
}

async function caseRouteFlows() {
  const dir = stateDir();
  const ctx = makeCtx();
  apply(ctx, { stateDir: dir });

  // 方法守卫
  let res = await post(ctx, `${ROUTE_PREFIX}/state`, {});
  eq(res.status, 405, 'POST /state → 405');
  res = await get(ctx, `${ROUTE_PREFIX}/branch`);
  eq(res.status, 405, 'GET /branch → 405');

  // 参数校验
  res = await get(ctx, `${ROUTE_PREFIX}/state`);
  eq(res.status, 400, '缺 sessionId → 400');
  res = await post(ctx, `${ROUTE_PREFIX}/branch`, { sessionId: 's1', seq: 3, text: '  ' });
  eq(res.status, 400, '空白文本 → 400');
  res = await post(ctx, `${ROUTE_PREFIX}/branch`, { sessionId: 's1', text: 'x' });
  eq(res.status, 400, '缺 seq → 400');
  res = await post(ctx, `${ROUTE_PREFIX}/branch`, { sessionId: '', seq: 3, text: 'x' });
  eq(res.status, 400, '空 sessionId → 400');
  res = await post(ctx, `${ROUTE_PREFIX}/select`, { sessionId: 's1', seq: 3, index: 0 });
  eq(res.status, 400, '不存在的分支集 → 400');

  // 同源守卫（sec-fetch-site: cross-site 直接拒）
  const cross = makeReq('GET', `${ROUTE_PREFIX}/state?sessionId=s1`, undefined, { host: 'x', 'sec-fetch-site': 'cross-site' });
  const crossRes = makeRes();
  ctx.routes.get(`${ROUTE_PREFIX}/state`)(cross, crossRes);
  eq(crossRes.status, 403, 'cross-site 请求 → 403');

  // 同源守卫（不带 sec-fetch-site 时靠 Origin/Host 比对——这条才是防跨源 POST 的主力）
  const evil = makeReq('POST', `${ROUTE_PREFIX}/branch`, JSON.stringify({ sessionId: 's1', seq: 1, text: 'x' }),
    { host: 'localhost:3080', origin: 'http://evil.example' });
  const evilRes = makeRes();
  ctx.routes.get(`${ROUTE_PREFIX}/branch`)(evil, evilRes);
  eq(evilRes.status, 403, 'Origin 与 Host 不一致 → 403（改成一律放行会让这条红）');
  const same = makeReq('POST', `${ROUTE_PREFIX}/branch`, JSON.stringify({ sessionId: 's-origin-ok', seq: 1, text: 'x' }),
    { host: 'localhost:3080', origin: 'http://localhost:3080' });
  const sameRes = makeRes();
  ctx.routes.get(`${ROUTE_PREFIX}/branch`)(same, sameRes);
  await same.send();
  for (let round = 0; round < 8 && !sameRes.ended; round += 1) await new Promise((r) => setImmediate(r));
  eq(sameRes.status, 200, 'Origin 与 Host 一致 → 放行');

  // 成功路径
  res = await get(ctx, `${ROUTE_PREFIX}/state?sessionId=s1`);
  eq(res.status, 200, 'GET /state 200');
  eq(res.json().group, null, '还没有分支时 group=null');

  res = await post(ctx, `${ROUTE_PREFIX}/branch`, { sessionId: 's1', seq: 42, text: '改写后的消息' });
  eq(res.status, 200, 'POST /branch 200');
  eq(res.json().message.total, 2, '响应带分支集（total=2）');
  eq(res.json().message.selected, 1, '新分支即当前分支');
  eq(res.json().message.variants[0].text, '改写后的消息', '响应带分支全文');
  ok(res.json().group.messages['42'] !== undefined, '响应也带整组视图');

  res = await get(ctx, `${ROUTE_PREFIX}/state?sessionId=s1`);
  eq(res.json().group.messages['42'].total, 2, 'GET /state 读得到刚建的分支');

  res = await post(ctx, `${ROUTE_PREFIX}/select`, { sessionId: 's1', seq: 42, index: 0 });
  eq(res.status, 200, 'POST /select 200');
  eq(res.json().message.selected, 0, '切回原文');
  res = await post(ctx, `${ROUTE_PREFIX}/select`, { sessionId: 's1', seq: 42, index: 5 });
  eq(res.status, 400, '越界序号 → 400');

  res = await get(ctx, `${ROUTE_PREFIX}/status?sessionId=s1`);
  eq(res.status, 200, 'GET /status 200');
  eq(res.json().version, VERSION, 'status 报 version 4');
  eq(res.json().plugin, name, 'status 报插件名');
  eq(res.json().routes.length, 5, 'status 列 5 条路由');
  ok(res.json().client.available === true, 'status 带 client 半边组装状态');
  eq(res.json().client.composed, true, 'client 半边报告已组进启动图');

  // 过长文本
  res = await post(ctx, `${ROUTE_PREFIX}/branch`, { sessionId: 's1', seq: 9, text: 'x'.repeat(20001) });
  eq(res.status, 400, '超过 maxEditedTextChars → 400');

  // 路由可被 effect 清理（卸载时不留死路由）
  for (const effect of ctx.effects) if (typeof effect.disposer === 'function') effect.disposer();
  eq(ctx.routes.size, 0, 'dispose 后路由全部注销');
}

async function caseRouteWriteFailure() {
  // 账本写不进去：路由必须回 500（不是 400），且内存不回填假数据。
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  blockWrites(dir); // 写必失败
  const ctx = makeCtx();
  apply(ctx, { stateDir: dir });
  let res = await post(ctx, `${ROUTE_PREFIX}/branch`, { sessionId: 's1', seq: 1, text: 'x' });
  eq(res.status, 500, '写盘失败 → 500（服务端故障，不是参数错）');
  ok(res.json().error.includes('未做任何改动'), '500 的响应体说清「未做任何改动」');
  res = await get(ctx, `${ROUTE_PREFIX}/state?sessionId=s1`);
  eq(res.json().group, null, '失败后账本里没有这条（没有假数据）');
}

async function caseRouteRetry() {
  // 前 3 次注册撞车（出厂 webserver 的真实报文），重试后 5 条路由必须全部就位。
  const dir = stateDir();
  const ctx = makeCtx({ duplicateTimes: 3 });
  apply(ctx, { stateDir: dir, registerRetryMs: 10 });
  eq(ctx.routes.size, 0, '第一次全撞车：此刻一条都没注册（重试还没跑）');
  await new Promise((resolve) => setTimeout(resolve, 300)); // 3 次 × 10ms 重试
  eq(ctx.routes.size, 5, '撞车重试后 5 条路由全部注册成功');
  for (const path of [`${ROUTE_PREFIX}/status`, `${ROUTE_PREFIX}/client`, `${ROUTE_PREFIX}/state`, `${ROUTE_PREFIX}/branch`, `${ROUTE_PREFIX}/select`]) {
    ok((ctx.attempts.get(path) ?? 0) >= 4, `重试链真的跑过：${path}`);
  }
  deepEq(ctx.warnings, [], '重试成功时不该有告警');
  for (const effect of ctx.effects) if (typeof effect.disposer === 'function') effect.disposer();

  // registerRetries: 0 → 每条路由告警一次后放弃（不无限重试、不抛）。
  const ctx2 = makeCtx({ duplicateTimes: 99 });
  apply(ctx2, { stateDir: dir, registerRetries: 0 });
  eq(ctx2.routes.size, 0, '不给重试时撞车即放弃');
  eq(ctx2.warnings.length, 5, '5 条路由各告警一次');
  ok(ctx2.warnings.every((line) => line.includes('注册失败')), '告警带路由名与原因');
}

/* ══════════════════════ ③ 静态语义边界 ══════════════════════ */

function caseStatic() {
  // 注释里提一句「v3 用 session.fork」是文档，不是行为：先把注释剥掉再查。
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  const source = strip(readFileSync(new URL('./entry-v4.js', import.meta.url), 'utf8'));
  for (const forbidden of ['session.fork', 'agents.create', 'sessions.create', 'sessionQuery', 'journal', 'blobDir', 'trashDir', 'receiptsDir', 'scanTree', 'attachJournal']) {
    eq(source.includes(forbidden), false, `entry-v4.js 不再引用 ${forbidden}（分支不建会话、不记账）`);
  }
  ok(source.includes("inject: ['webServer']"), 'host 半边只依赖 webServer');
  const client = strip(readFileSync(new URL('./client.js', import.meta.url), 'utf8'));
  for (const forbidden of ['sessions.fork', 'sessions.create', 'openSession', 'bindingFor', '/dsh-branches/register', '/dsh-branches/rollback']) {
    eq(client.includes(forbidden), false, `client.js 不再引用 ${forbidden}`);
  }
  ok(client.includes('mb-branchNav'), 'client.js 带分支导航条样式类');
  ok(client.includes('conversation.chat.node'), 'client.js 仍接管 user 键（分支只长在我的消息上）');
}

/* ══════════════════════ 主流程 ══════════════════════ */

const cases = [
  caseConfig, caseSanitize, caseStore, caseLegacy, caseBrokenFile, caseWrongShapeFile,
  caseReadFailure, caseWriteFailure, casePerMessageMerge, caseMergeTieBreak, caseSelectedDefault,
  caseRoutes, caseRouteFlows, caseRouteWriteFailure, caseRouteRetry, caseStatic,
];

let failure = null;
for (const run of cases) {
  try {
    step(run.name);
    await run();
  } catch (error) {
    failure = error;
    break;
  }
}

try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* /tmp 清理失败不影响结论 */ }

if (failure !== null) {
  console.log(`SELFTEST FAIL 前 ${checks} 项断言通过后中断：${failure.message !== undefined ? failure.message : String(failure)}`);
  process.exit(1);
}
console.log(`SELFTEST PASS ${checks}/${checks}`);
