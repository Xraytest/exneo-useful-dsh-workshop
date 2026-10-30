/**
 * dsh-settings-nav host 半边自测（纯 node，无副作用；真实落盘 + 真实 HTTP 处理器）。
 *
 * 覆盖：
 *   · 归一化：形状错 vs 单项错的分界、重复 id、未知 type、名字回落、上限、超长截断报 issue；
 *   · 落盘：真实临时目录、原子写、文件内容形状；
 *   · revision：单调不减、先算后写、坏文件保留上次快照、写盘失败不前进；
 *   · 冲突：baseRevision 不一致 → 409 且**绝不覆盖**盘上内容；
 *   · 不可读冻结：文件存在但读不出来 → state 如实上报、/save 与 /reset 都 503 且文件逐字节不变；
 *   · 路由：GET/POST 方法检查、同源守卫（可信 authority / scheme / IPv6 回环）、
 *     超大 body 413、readBody 超时 408、bad JSON 400、未知路径。
 *
 * 运行：node plugins/dsh-settings-nav/selftest.mjs
 */

import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BODY_TIMEOUT_MS,
  BUILD,
  bodyStatusOf,
  LIMITS,
  SCHEMA,
  apply,
  capIssues,
  createSettingsNav,
  emptyDocument,
  ensureDirSync,
  isTrustedLocalAuthority,
  normalizeConfig,
  normalizeDocument,
  readBody,
} from './index.js';

let checks = 0;
const ok = (value, message) => {
  checks += 1;
  assert.ok(value, message);
};
const eq = (actual, expected, message) => {
  checks += 1;
  assert.equal(actual, expected, message);
};
const deepEq = (actual, expected, message) => {
  checks += 1;
  assert.deepEqual(actual, expected, message);
};

// ── 桩：cordis ctx（只用 get / effect / logger 三个面） ──────────────────────
function makeCtx() {
  const routes = new Map();
  const effects = [];
  const warnings = [];
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  const ctx = {
    routes,
    effects,
    warnings,
    get(key) {
      return key === 'webServer' ? webServer : undefined;
    },
    effect(fn) {
      const disposer = fn();
      effects.push(disposer);
      return disposer;
    },
    logger: {
      warn: (text) => warnings.push(String(text)),
    },
  };
  return ctx;
}

// ── 桩：极简 req/res ────────────────────────────────────────────────────────
function makeReq({ method = 'GET', headers = {}, url = '/', body = null, hang = false, omitHost = false } = {}) {
  // 真实 HTTP/1.1 请求一定带 Host，所以默认给一个本机 authority：绝大多数用例只需声明
  // 自己关心的那个头，不会被「根本没有 Host」这个无关分支带偏（那一条单独测）。
  const allHeaders = omitHost ? { ...headers } : { host: '127.0.0.1:3080', ...headers };
  const listeners = new Map();
  const req = {
    method,
    headers: allHeaders,
    url,
    setEncoding() {},
    destroy() {
      req.destroyed = true;
    },
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(callback);
      return req;
    },
  };
  // 异步派发，逼真地跨过 readBody 的 Promise。hang=true 模拟「声明了 body 却一个字节不发」。
  if (!hang) {
    queueMicrotask(() => {
      if (body !== null) {
        for (const callback of listeners.get('data') ?? []) callback(body);
      }
      for (const callback of listeners.get('end') ?? []) callback();
    });
  }
  return req;
}

function makeRes() {
  return {
    status: 0,
    headers: null,
    text: '',
    finished: false,
    listeners: new Map(),
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    once(event, callback) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(callback);
      return this;
    },
    /** 手动触发（真实 res 由 Node 在响应发完时触发 finish）。 */
    fire(event) {
      for (const callback of this.listeners.get(event) ?? []) callback();
    },
    end(value) {
      this.text = value === undefined ? '' : String(value);
    },
    get json() {
      return JSON.parse(this.text);
    },
  };
}

/** 走一次真实路由：返回 { status, json }。 */
async function call(ctx, path, options = {}) {
  const route = ctx.routes.get(path);
  ok(route !== undefined, `路由已注册：${path}`);
  const res = makeRes();
  route.handler(makeReq({ url: path, ...options }), res);
  // readBody 的 then 链至少跨两个微任务。
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
  return { status: res.status, json: res.json };
}

// ── 临时工作目录 ────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'dsh-settings-nav-selftest-'));
const file = join(root, 'settings-nav.json');

try {
  /* ════════════════════════════ 1. 归一化 ════════════════════════════════ */

  {
    const shape = normalizeDocument(null);
    deepEq(shape.shapeErrors, ['根必须是对象'], '根为 null → 形状错');
    eq(shape.order.length, 0, '形状错时没有 order');

    const shape2 = normalizeDocument({ order: 'nope' });
    deepEq(shape2.shapeErrors, ['order 必须是数组'], 'order 不是数组 → 形状错');

    const shape3 = normalizeDocument([]);
    deepEq(shape3.shapeErrors, ['根必须是对象'], '数组根 → 形状错');

    // 缺 order 字段 = 空布局（不是错误）：这样 {"schema":1} 这种最小文件也合法。
    const shape4 = normalizeDocument({ schema: 1 });
    deepEq(shape4.shapeErrors, [], '缺 order 字段合法');
    deepEq(shape4.order, [], '缺 order 字段按空布局');

    const tooMany = normalizeDocument({ order: new Array(LIMITS.maxIds + LIMITS.maxGroups + 1).fill({ type: 'item', id: 'x' }) });
    ok(tooMany.shapeErrors.length === 1, '条目数超限 → 形状错');
  }

  {
    const result = normalizeDocument({
      order: [
        { type: 'item', id: 'general' },
        { type: 'group', id: 'g1', name: '  模型   与路由  ', collapsed: true, items: ['models', 'models', 'model-groups'] },
        { type: 'group', id: 'g1', name: '重复组', items: [] },
        { type: 'item', id: 'general' },
        { type: 'item', id: '   ' },
        { type: 'group', id: 'g3', name: '', items: 'bad' },
        { type: 'wat', id: 'x' },
        null,
        { type: 'item', id: 'usage-stats' },
      ],
    });
    eq(result.shapeErrors.length, 0, '全部是单项级问题，不是形状错');
    deepEq(
      result.order,
      [
        { type: 'item', id: 'general' },
        { type: 'group', id: 'g1', name: '模型 与路由', collapsed: true, items: ['models', 'model-groups'] },
        { type: 'group', id: 'g3', name: '未命名分组', collapsed: false, items: [] },
        { type: 'item', id: 'usage-stats' },
      ],
      '重复 id / 非法 id / 未知 type / 非对象项都被丢弃，名字被规范化',
    );
    ok(result.issues.some((text) => text.includes('重复')), '报告重复分组 id');
    ok(result.issues.some((text) => text.includes('分组 id')), '报告缺失分组 id 被丢弃');
    ok(result.issues.some((text) => text.includes('未知')), '报告未知 type');
    ok(result.issues.some((text) => text.includes('items 不是数组')), '报告 items 形状问题');
    ok(result.issues.some((text) => text.includes('分组名为空')), '报告分组名回落');
    ok(result.issues.some((text) => text.includes('不是对象')), '报告非对象项');
  }

  {
    // 成员 id 与顶层 id 共用同一张「不得重复」的账。
    const cross = normalizeDocument({
      order: [
        { type: 'group', id: 'g1', name: 'A', items: ['models'] },
        { type: 'item', id: 'models' },
      ],
    });
    eq(cross.order.length, 1, '跨分层重复的 id 被丢弃');
    deepEq(cross.order[0].items, ['models'], '分组内的那次保留');
  }

  {
    // schema 2：分组可嵌套（`items` 里既能放 id 字符串，也能放子分组对象）。
    const nested = normalizeDocument({
      order: [
        { type: 'item', id: 'general' },
        { type: 'group', id: 'g-top', name: '顶层', collapsed: false, items: [
          'models',
          { type: 'group', id: 'g-in', name: '子组', items: ['plugins', { type: 'group', id: 'g-deep', name: '更深', items: ['usage-stats'] }] },
          'model-groups',
        ] },
      ],
    });
    deepEq(nested.shapeErrors, [], '嵌套文档没有形状错');
    deepEq(nested.issues, [], '合法的嵌套结构不产生 issue');
    deepEq(nested.order, [
      { type: 'item', id: 'general' },
      { type: 'group', id: 'g-top', name: '顶层', collapsed: false, items: [
        'models',
        { type: 'group', id: 'g-in', name: '子组', collapsed: false, items: [
          'plugins',
          { type: 'group', id: 'g-deep', name: '更深', collapsed: false, items: ['usage-stats'] },
        ] },
        'model-groups',
      ] },
    ], '三层结构原样保留（交错顺序不变、collapsed 补齐为 false）');

    // 深度上限：顶层分组是第 0 层，所以第 5 层起整棵丢掉。
    let deepDoc = { type: 'group', id: 'g5', name: 'x', items: ['x5'] };
    for (let level = 4; level >= 0; level -= 1) deepDoc = { type: 'group', id: 'g' + level, name: 'x', items: [deepDoc] };
    const cappedDepth = normalizeDocument({ order: [deepDoc] });
    deepEq(cappedDepth.shapeErrors, [], '超深不是形状错（只是那一层被丢掉）');
    deepEq(cappedDepth.issues, ['order[0]' + '.items[0]'.repeat(5) + ` 的嵌套超过 ${LIMITS.maxDepth} 层，整棵子分组已丢弃`], '超深报成一条点明层数的 issue（g5 是第 5 层）');
    const depthOf = (group) => (group.items.length === 0 || typeof group.items[0] === 'string' ? 0 : 1 + depthOf(group.items[0]));
    eq(depthOf(cappedDepth.order[0]), 4, '保留到第 4 层（共 5 层）');

    // items 里的坏东西：未知 type / 数字 / null / 数组都只丢自己，好的成员与子分组留下。
    const messy = normalizeDocument({
      order: [{ type: 'group', id: 'g', name: 'G', items: [
        'models',
        42,
        null,
        ['models'],
        { type: 'wat', id: 'x' },
        { type: 'group', id: 'g-sub', name: 'S', items: ['plugins'] },
        'plugins',
      ] }],
    });
    eq(messy.shapeErrors.length, 0, 'items 里有杂物也不是形状错');
    deepEq(messy.order[0].items, ['models', { type: 'group', id: 'g-sub', name: 'S', collapsed: false, items: ['plugins'] }], '杂物被逐条丢掉，合法成员与子分组留下');
    ok(messy.issues.some((text) => text.includes('既不是 id 也不是分组')), '报告「既不是 id 也不是分组」');
    ok(messy.issues.some((text) => text.includes('items[4]') && text.includes('未知')), '报告子项下标与未知 type');
    ok(messy.issues.some((text) => text.includes('已出现过')), '子分组里的重复 id 被丢掉（id 账在整棵树里共用）');

    // 子分组里的 id 不能与顶层重复。
    const crossNested = normalizeDocument({
      order: [
        { type: 'group', id: 'g-a', name: 'A', items: [{ type: 'group', id: 'g-b', name: 'B', items: ['models'] }] },
        { type: 'item', id: 'models' },
      ],
    });
    eq(crossNested.order.length, 1, '跨嵌套层级重复的设置项 id 被丢弃');
    eq(crossNested.order[0].items[0].items.join(','), 'models', '嵌套里的那次保留');

    // 分组 id 也不能在整棵树里重复（嵌套里的重复分组整棵丢掉）。
    const crossGroups = normalizeDocument({
      order: [
        { type: 'group', id: 'g-a', name: 'A', items: [{ type: 'group', id: 'g-a', name: 'A2', items: ['models'] }] },
      ],
    });
    deepEq(crossGroups.order[0].items, [], '同名分组 id 的子分组被丢弃');
    ok(crossGroups.issues.some((text) => text.includes('重复')), '报告嵌套分组 id 重复');

    eq(SCHEMA, 2, 'schema 升到 2');
    eq(LIMITS.maxDepth, 5, '深度上限 5 层');
    eq(emptyDocument().schema, 2, '空文档也写 schema 2');
  }


  {
    const capped = capIssues(new Array(100).fill('x'));
    eq(capped.issues.length, LIMITS.maxEchoedIssues, 'issues 回显被夹住');
    eq(capped.issueCount, 100, 'issueCount 保留真实条数');
  }

  {
    const opt = normalizeConfig({ file: '  /tmp/x.json  ', enabled: false, cacheTtlMs: 1e9 });
    eq(opt.file, '/tmp/x.json', 'file 去空白');
    eq(opt.enabled, false, 'enabled=false 生效');
    // cacheTtlMs 是死配置（每个内部调用都实读，它从未生效过），已删除。旧组合行里残留
    // 这个键时按未知键**静默忽略**：一个惰性键不该把插件挡在启动之外。
    eq(Object.hasOwn(opt, 'cacheTtlMs'), false, 'cacheTtlMs 不再是配置项（未知键被忽略）');
    eq(normalizeConfig().enabled, true, 'enabled 缺省 true');
    eq(normalizeConfig().file.endsWith('settings-nav.json'), true, 'file 缺省落在 $DSH_HOME/settings-nav.json');
    eq(normalizeConfig({ whatIsThis: 1 }).enabled, true, '完全未知的键也不影响其余默认值');
  }

  {
    // 超长不是「没事」：静默截断会让两个共享前缀的长 id 变成同一个 id，后一个被误报成
    // 重复——那是**错诊断**。返回值仍然截断，但截断本身必须出现在 issues 里。
    const longName = 'N'.repeat(LIMITS.maxName + 40);
    const longId = 'i'.repeat(LIMITS.maxId + 10);
    const truncated = normalizeDocument({
      order: [{ type: 'group', id: 'g-trunc', name: longName, items: [longId] }],
    });
    eq(truncated.order[0].name.length, LIMITS.maxName, '分组名仍被截断到上限（返回值不变）');
    eq(truncated.order[0].items[0].length, LIMITS.maxId, 'id 仍被截断到上限（返回值不变）');
    ok(
      truncated.issues.some((text) => text.includes('截断') && text.includes(String(LIMITS.maxName))),
      '分组名过长被报成 issue（点明 60 字符）',
    );
    ok(
      truncated.issues.some((text) => text.includes('截断') && text.includes(String(LIMITS.maxId))),
      'id 过长被报成 issue（点明 120 字符）',
    );

    // 顶层 item 的长 id 走的是另一条分支，也要报。
    const longItem = normalizeDocument({ order: [{ type: 'item', id: longId }] });
    eq(longItem.order[0].id.length, LIMITS.maxId, '顶层 item 的 id 仍被截断');
    ok(longItem.issues.some((text) => text.includes('id') && text.includes('截断')), '顶层 item 的长 id 也报截断');
  }

  {
    // ensureDirSync 逐级创建（不依赖 recursive）；已存在的目录原样返回。
    const nested = join(root, 'a', 'b', 'c');
    ensureDirSync(nested);
    eq(existsSync(nested), true, 'ensureDirSync 逐级建目录');
    ensureDirSync(nested);
    eq(existsSync(nested), true, 'ensureDirSync 幂等');

    // Windows 回归：绝对路径以盘符（`C:\`）开头时，一旦把根当成 `sep`，盘符里的 `:`
    // 就会被切成第一级目录 → mkdir `C:\:` → EINVAL。这里再往下建两层，锁死「以
    // path.parse().root（盘符 / UNC / `/`）为根」的切分方式。
    if (process.platform === 'win32') {
      const drivePath = join(root, 'win-drive-regression', 'nested');
      ensureDirSync(drivePath);
      eq(existsSync(drivePath), true, 'ensureDirSync 支持盘符绝对路径（不把 : 当成目录名）');
    }
  }

  /* ════════════════════════════ 2. 落盘与 revision ═══════════════════════ */

  {
    const ctx = makeCtx();
    const handle = createSettingsNav(ctx, { file });
    eq(handle.path, file, '句柄暴露文件路径');
    eq(handle.diag.routes, true, '注册了 webServer 路由');
    eq(ctx.routes.size, 3, '三条路由：state / save / reset');
    ok(ctx.routes.has('/dsh-settings-nav/state'), 'state 路由');
    ok(ctx.routes.has('/dsh-settings-nav/save'), 'save 路由');
    ok(ctx.routes.has('/dsh-settings-nav/reset'), 'reset 路由');

    const initial = handle.state();
    eq(initial.ok, true, 'state ok');
    eq(initial.schema, SCHEMA, 'state 回报 schema');
    eq(initial.build, BUILD, 'state 回报 build');
    eq(initial.exists, false, '文件还不存在');
    eq(initial.revision, 0, '初始 revision 0');
    deepEq(initial.order, [], '初始布局为空');
    eq(initial.config.enabled, true, 'state 回报 enabled');
    deepEq(initial.order, emptyDocument().order, '空文档形状一致');

    // 首次写盘：revision 1，文件形状正确。
    const saved = handle.save({ baseRevision: 0, order: [{ type: 'item', id: 'general' }] });
    eq(saved.status, 200, '首次 save 成功');
    eq(saved.body.revision, 1, 'revision 从 1 起');
    deepEq(saved.body.order, [{ type: 'item', id: 'general' }], '回显落盘后的布局');
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    eq(onDisk.schema, SCHEMA, '盘上 schema');
    eq(onDisk.revision, 1, '盘上 revision');
    deepEq(onDisk.order, [{ type: 'item', id: 'general' }], '盘上 order');
    ok(typeof onDisk.updatedAt === 'number' && onDisk.updatedAt > 0, '盘上 updatedAt');
    ok(readFileSync(file, 'utf8').endsWith('\n'), '文件以换行结尾（人可读）');

    // 再写一次 → revision 单调递增。
    const again = handle.save({ baseRevision: 1, order: [{ type: 'item', id: 'models' }] });
    eq(again.status, 200, '第二次 save 成功');
    eq(again.body.revision, 2, 'revision 递增');

    // 不存在的 id 也会被原样保存（host 不知道有哪些设置项，孤儿由客户端算）。
    handle.save({ baseRevision: 2, order: [{ type: 'group', id: 'g1', name: '高级', collapsed: true, items: ['ghost'] }] });
    eq(handle.state().order[0].items[0], 'ghost', 'host 不替客户端判断孤儿');

    /* ---------------------------- 冲突栅栏 ---------------------------- */
    const before = readFileSync(file, 'utf8');
    const conflict = handle.save({ baseRevision: 1, order: [{ type: 'item', id: 'plugins' }] });
    eq(conflict.status, 409, 'baseRevision 过期 → 409');
    eq(conflict.body.conflict, true, '冲突标记');
    eq(conflict.body.revision, 3, '冲突响应带上当前 revision');
    deepEq(conflict.body.order, [{ type: 'group', id: 'g1', name: '高级', collapsed: true, items: ['ghost'] }], '冲突响应带上当前布局');
    eq(readFileSync(file, 'utf8'), before, '冲突时**绝不**覆盖盘上内容');
    ok(conflict.body.error.includes('拒绝'), '冲突文案说明是拒绝而非覆盖');
    eq(handle.diag.conflicts, 1, '冲突计数');

    /* ---------------------------- 拒绝分支 ---------------------------- */
    eq(handle.save({ baseRevision: 3, order: 'nope' }).status, 400, 'order 不是数组 → 400');
    eq(handle.save({ baseRevision: 3 }).status, 400, '缺 order → 400');
    eq(handle.save(null).status, 400, 'body 不是对象 → 400');
    eq(handle.diag.rejected, 3, '拒绝计数');
    eq(readFileSync(file, 'utf8'), before, '拒绝的请求不落盘');

    // 不带 baseRevision = 显式「无条件覆盖」（CLI 用）。
    const blind = handle.save({ order: [{ type: 'item', id: 'general' }] });
    eq(blind.status, 200, '缺 baseRevision 时无条件写');

    /* ---------------------------- reset ---------------------------- */
    const reset = handle.reset({ baseRevision: blind.body.revision });
    eq(reset.status, 200, 'reset 成功');
    deepEq(reset.body.order, [], 'reset 清空布局');
    eq(JSON.parse(readFileSync(file, 'utf8')).order.length, 0, '盘上 order 为空数组');
    eq(handle.diag.resets, 1, 'reset 计数');
  }

  /* ═══════════════════════ 3. 坏文件 / 外部改写 ═══════════════════════════ */

  {
    const ctx = makeCtx();
    const handle = createSettingsNav(ctx, { file });
    handle.save({ order: [{ type: 'item', id: 'general' }] });
    const good = handle.state();
    ok(good.revision >= 1, '有内容');

    // 语法错 → 沿用上次快照 + loadError，不抛、不清空。
    writeFileSync(file, '{ this is not json', 'utf8');
    const broken = handle.state();
    deepEq(broken.order, [{ type: 'item', id: 'general' }], '坏文件时沿用上次可用快照');
    ok(broken.warnings.some((text) => text.includes('读取失败')), '坏文件进 warnings');
    ok(broken.revision >= good.revision, '坏文件时 revision 不回落');

    // 「JSON 合法但形状非法」按坏文件同等处理：不能让 {"order":null} 把分组清空。
    writeFileSync(file, JSON.stringify({ schema: 1, revision: 9, order: null }), 'utf8');
    const shapeBroken = handle.state();
    deepEq(shapeBroken.order, [{ type: 'item', id: 'general' }], '形状非法时也沿用上次快照');
    ok(shapeBroken.warnings.some((text) => text.includes('形状非法')), '形状非法进 warnings');

    // 外部改写（合法）→ revision 只增不减，且内容被采纳。
    writeFileSync(file, JSON.stringify({ schema: SCHEMA, revision: 2, order: [{ type: 'item', id: 'external' }] }), 'utf8');
    const external = handle.state();
    deepEq(external.order, [{ type: 'item', id: 'external' }], '外部改写被采纳');
    ok(external.revision > shapeBroken.revision, '外部改写后 revision 前进');

    // 外部把 revision 改小 → 对外 revision 仍不得回落（同一个号不能指向两份内容）。
    writeFileSync(file, JSON.stringify({ schema: SCHEMA, revision: 0, order: [{ type: 'item', id: 'external2' }] }), 'utf8');
    const lowered = handle.state();
    ok(lowered.revision > external.revision, '外部把 revision 改小时对外仍递增');
    deepEq(lowered.order, [{ type: 'item', id: 'external2' }], '内容仍被采纳');

    // 文件被删除 → 回到空布局（不是错误），revision 仍不回落。
    rmSync(file, { force: true });
    const gone = handle.state();
    eq(gone.exists, false, '文件被删除');
    deepEq(gone.order, [], '删除后回到空布局');
    ok(gone.revision > lowered.revision, '删除也算内容变化，revision 前进');

    // 写盘失败（父路径是文件）→ 500，且 advertised revision 不前进、目标文件逐字节未变。
    const blockedPath = join(file, 'nested.json');
    writeFileSync(file, '{}', 'utf8');
    const blockedBytesBefore = readFileSync(file, 'utf8');
    const blocked = createSettingsNav(makeCtx(), { file: blockedPath });
    const blockedRevisionBefore = blocked.state().revision;
    const blockedSave = blocked.save({ order: [{ type: 'item', id: 'x' }] });
    eq(blockedSave.status, 500, '父路径被文件占住 → 500');
    ok(blockedSave.body.error.includes('写入失败'), '写入失败文案');
    ok(blocked.diag.lastError !== null, '写入失败记进诊断');
    eq(blocked.state().revision, blockedRevisionBefore, '写盘失败后 advertised revision 不前进（不宣称没落盘的号）');
    eq(readFileSync(file, 'utf8'), blockedBytesBefore, '写盘失败后目标文件逐字节未变');
  }

  /* ═══════════════ 4. 路由行为（含同源守卫的真实边界） ═══════════════ */

  {
    // 同源守卫的第一道门：请求自己声明的 authority 必须是本机可信来源。只比 Origin 与
    // Host 是同义反复——两者都由调用方填，DNS rebinding 页面天然让它们相等。
    eq(isTrustedLocalAuthority('127.0.0.1:3080'), true, '回环 + 端口可信');
    eq(isTrustedLocalAuthority('127.5.5.5'), true, '127.0.0.0/8 全段可信');
    eq(isTrustedLocalAuthority('localhost:3080'), true, 'localhost 可信');
    eq(isTrustedLocalAuthority('DSH.LOCAL'), true, 'dsh.local 大小写不敏感');
    eq(isTrustedLocalAuthority('[::1]:3080'), true, 'IPv6 回环（带方括号）可信');
    eq(isTrustedLocalAuthority('::1'), true, '裸 IPv6 回环不被误当「主机:端口」切坏');
    eq(isTrustedLocalAuthority('10.1.2.3:80'), true, '10/8 可信');
    eq(isTrustedLocalAuthority('192.168.31.7'), true, '192.168/16 可信');
    eq(isTrustedLocalAuthority('172.16.0.1'), true, '172.16/12 下界可信');
    eq(isTrustedLocalAuthority('172.31.255.255'), true, '172.16/12 上界可信');
    eq(isTrustedLocalAuthority('172.15.0.1'), false, '172.15 不在 172.16/12');
    eq(isTrustedLocalAuthority('172.32.0.1'), false, '172.32 不在 172.16/12');
    eq(isTrustedLocalAuthority('11.0.0.1'), false, '非私有网段不可信');
    eq(isTrustedLocalAuthority('evil.example:3080'), false, '外部域不可信（DNS rebinding 的关键一环）');
    eq(isTrustedLocalAuthority('[::1'), false, '残缺 IPv6 不可信');
    eq(isTrustedLocalAuthority(''), false, '空 authority 不可信');
    eq(isTrustedLocalAuthority(undefined), false, '缺失 authority 不可信');
  }

  {
    rmSync(file, { force: true });
    const ctx = makeCtx();
    createSettingsNav(ctx, { file });

    const state = await call(ctx, '/dsh-settings-nav/state');
    eq(state.status, 200, 'GET /state 200');
    eq(state.json.ok, true, 'GET /state ok');
    eq(state.json.impl.startsWith('index.js'), true, 'impl 是本文件的真实身份（带 ?v= 标记）');

    const wrongMethod = await call(ctx, '/dsh-settings-nav/state', { method: 'POST' });
    eq(wrongMethod.status, 405, 'GET 路由挡 POST');

    const crossSite = await call(ctx, '/dsh-settings-nav/state', { headers: { 'sec-fetch-site': 'cross-site' } });
    eq(crossSite.status, 403, 'sec-fetch-site: cross-site 被拒');

    const nullOrigin = await call(ctx, '/dsh-settings-nav/state', { headers: { origin: 'null' } });
    eq(nullOrigin.status, 403, 'Origin: null 被拒（沙箱 iframe / file: 页面）');

    const foreign = await call(ctx, '/dsh-settings-nav/state', { headers: { origin: 'http://evil.example' } });
    eq(foreign.status, 403, '跨站 Origin 被拒');

    const sameHost = await call(ctx, '/dsh-settings-nav/state', { headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } });
    eq(sameHost.status, 200, '同源 Origin 放行');

    const noOrigin = await call(ctx, '/dsh-settings-nav/state', { headers: {} });
    eq(noOrigin.status, 200, '无 Origin（curl / 本机 CLI）+ 本机 Host 放行');

    // —— 同义反复漏洞的现场：Host 与 Origin 同为攻击者的域。—— //

    const rebound = await call(ctx, '/dsh-settings-nav/state', {
      headers: { host: 'evil.example', origin: 'http://evil.example' },
    });
    eq(rebound.status, 403, 'Host 与 Origin 同为外部域（DNS rebinding）被拒');

    const foreignHostNoOrigin = await call(ctx, '/dsh-settings-nav/state', { headers: { host: 'evil.example' } });
    eq(foreignHostNoOrigin.status, 403, '无 Origin 但 Host 是外部域 → 拒');

    const noHostAtAll = await call(ctx, '/dsh-settings-nav/state', { omitHost: true });
    eq(noHostAtAll.status, 403, '完全没有 Host（HTTP/1.0）→ 拒');

    const schemeMismatch = await call(ctx, '/dsh-settings-nav/state', {
      headers: { host: '127.0.0.1:3080', origin: 'https://127.0.0.1:3080' },
    });
    eq(schemeMismatch.status, 403, '明文 socket 上的 https Origin 被拒（scheme 必须匹配真实传输）');

    const malformed = await call(ctx, '/dsh-settings-nav/state', {
      headers: { host: '127.0.0.1:3080', origin: 'http://[bad' },
    });
    eq(malformed.status, 403, '无法解析的畸形 Origin 被拒');

    const ipv6Loopback = await call(ctx, '/dsh-settings-nav/state', {
      headers: { host: '[::1]:3080', origin: 'http://[::1]:3080' },
    });
    eq(ipv6Loopback.status, 200, 'IPv6 回环同源放行');

    // POST /save：正常路径。
    const saved = await call(ctx, '/dsh-settings-nav/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 0, order: [{ type: 'item', id: 'general' }] }),
    });
    eq(saved.status, 200, 'POST /save 200');
    deepEq(saved.json.order, [{ type: 'item', id: 'general' }], 'POST /save 回显布局');

    // POST /save：GET 被挡。
    const saveGet = await call(ctx, '/dsh-settings-nav/save', { method: 'GET' });
    eq(saveGet.status, 405, 'POST 路由挡 GET');

    // 漏洞真正发生的地方是写路由：Host 与 Origin 同为攻击者的域时，必须挡在业务逻辑之前。
    const rebindSave = await call(ctx, '/dsh-settings-nav/save', {
      method: 'POST',
      headers: { host: 'evil.example', origin: 'http://evil.example' },
      body: JSON.stringify({ order: [{ type: 'item', id: 'pwn' }] }),
    });
    eq(rebindSave.status, 403, 'DNS rebinding 的 POST /save 被拒（曾经能拿到 409 业务响应）');
    deepEq(JSON.parse(readFileSync(file, 'utf8')).order, [{ type: 'item', id: 'general' }], '被拒的 rebinding 写没有落盘');

    // POST /save：冲突。
    const conflict = await call(ctx, '/dsh-settings-nav/save', {
      method: 'POST',
      body: JSON.stringify({ baseRevision: 0, order: [{ type: 'item', id: 'plugins' }] }),
    });
    eq(conflict.status, 409, '路由层透传 409');
    eq(conflict.json.conflict, true, '路由层透传冲突标记');

    // POST /save：bad JSON。
    const bad = await call(ctx, '/dsh-settings-nav/save', { method: 'POST', body: '{not json' });
    eq(bad.status, 400, 'bad JSON → 400');
    ok(bad.json.error.includes('JSON'), 'bad JSON 文案');

    // POST /save：超大 body（有界 drain，不 reset 连接）。
    const huge = await call(ctx, '/dsh-settings-nav/save', { method: 'POST', body: 'x'.repeat(LIMITS.maxBodyBytes + 10) });
    eq(huge.status, 413, '超大 body → 413');

    // POST /save：跨站。
    const crossSave = await call(ctx, '/dsh-settings-nav/save', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ order: [] }),
    });
    eq(crossSave.status, 403, '跨站写被拒');

    // POST /reset。
    const reset = await call(ctx, '/dsh-settings-nav/reset', { method: 'POST', body: JSON.stringify({ baseRevision: 1 }) });
    eq(reset.status, 200, 'POST /reset 200');
    deepEq(reset.json.order, [], 'POST /reset 清空');

    // 未知路径没有路由。
    ok(ctx.routes.get('/dsh-settings-nav/nope') === undefined, '未知路径未注册');
  }

  /* ═════════════════ 5. 生命周期：同 id 重挂不重复注册路由 ═══════════════ */

  {
    const ctx = makeCtx();
    const first = createSettingsNav(ctx, { file });
    eq(ctx.routes.size, 3, '首次挂载 3 条路由');
    // 模拟 dispose→start：先跑 effects 的清理，再挂一次。
    for (const effect of ctx.effects.splice(0)) {
      if (typeof effect === 'function') effect();
    }
    eq(ctx.routes.size, 0, 'dispose 后路由全摘');
    createSettingsNav(ctx, { file });
    eq(ctx.routes.size, 3, '重挂后仍是 3 条（不会因重复路径 throw）');
    eq(typeof apply, 'function', '导出 apply');
    eq(first.disposed, false, '先前的句柄不受后续挂载影响');
  }

  /* ════════════════════════════ 6. 无 webServer ═════════════════════════ */

  {
    const ctx = { get: () => undefined, effect: (fn) => fn(), logger: { warn() {} } };
    const handle = createSettingsNav(ctx, { file });
    eq(handle.diag.routes, false, '没有 webServer 时不做路由');
    eq(handle.state().ok, true, '没有 webServer 时 state 仍可读（供测试/CLI）');
  }
  /* ═════════════ 7. 文件存在但读不出来：冻结写入（FIX 2） ═════════════ */

  {
    const permFile = join(root, 'perm.json');
    writeFileSync(permFile, JSON.stringify({ schema: SCHEMA, revision: 4, order: [{ type: 'item', id: 'seed' }] }), 'utf8');
    const handle = createSettingsNav(makeCtx(), { file: permFile });
    const readable = handle.state();
    eq(readable.exists, true, '可读时 exists=true');
    eq(readable.unreadable, false, '可读时 unreadable=false');
    deepEq(readable.order, [{ type: 'item', id: 'seed' }], '可读时读到内容');
    const bytesBefore = readFileSync(permFile, 'utf8');
    const revisionBefore = readable.revision;

    // 先确认这台机器上 chmod 000 真的能挡住读取：root 仍然读得到，那样这条断言就没有意义。
    chmodSync(permFile, 0);
    let reproduces = false;
    try {
      readFileSync(permFile);
    } catch {
      reproduces = true;
    }

    if (!reproduces) {
      chmodSync(permFile, 0o600);
      console.log('dsh-settings-nav host selftest: 跳过「文件不可读冻结」——当前用户仍能读 000 文件（root？）');
    } else {
      const frozen = handle.state();
      eq(frozen.exists, true, '不可读时 exists 仍为 true（文件**在**）');
      eq(frozen.unreadable, true, '不可读时 unreadable=true');
      eq(frozen.revision, revisionBefore, '不可读时 revision 不回落成 0');
      ok(frozen.order.length > 0, '不可读时不把布局报成空文档');
      ok(frozen.warnings.some((text) => text.includes('读不出来')), '不可读进 warnings');
      const lastErrorAfterLoad = handle.diag.lastError;

      const frozenSave = handle.save({ baseRevision: revisionBefore, order: [{ type: 'item', id: 'second' }] });
      eq(frozenSave.status, 503, '不可读时 save 被拒（503，不是会被当成「采用服务端文档」的 409）');
      eq(frozenSave.body.unreadable, true, '503 响应点明不可读');
      const frozenReset = handle.reset({ baseRevision: revisionBefore });
      eq(frozenReset.status, 503, '不可读时 reset 同样被拒');
      eq(handle.diag.frozen, 2, '冻结拒绝单独计数');
      eq(handle.diag.lastError, lastErrorAfterLoad, '冻结拒绝不污染 lastError（它是正常业务分支）');

      // 报告里的原始复现场景：**启动时**文件就已经读不出来，初始空快照绝不能被包装成
      // 「没有文件」——那正是 baseRevision:0 能通过栅栏、把原文件覆盖掉的原因。
      const freshHandle = createSettingsNav(makeCtx(), { file: permFile });
      const freshState = freshHandle.state();
      eq(freshState.exists, true, '启动即不可读时 exists=true（不是「没有文件」）');
      eq(freshState.unreadable, true, '启动即不可读时 unreadable=true');
      deepEq(freshState.order, [], '没有历史快照时 order 仍为空，但 exists/unreadable 已如实上报');
      eq(freshHandle.save({ baseRevision: 0, order: [{ type: 'item', id: 'pwn' }] }).status, 503, '启动即不可读时 baseRevision:0 的保存也被拒（原漏洞入口）');

      chmodSync(permFile, 0o600);
      eq(readFileSync(permFile, 'utf8'), bytesBefore, '被拒的保存/重置后文件逐字节未变（盘上 revision 4 没有变成 1）');

      const recovered = handle.state();
      eq(recovered.unreadable, false, '权限恢复后 unreadable 清零');
      deepEq(recovered.order, [{ type: 'item', id: 'seed' }], '权限恢复后读回原布局');
      const recoveredSave = handle.save({ baseRevision: recovered.revision, order: [{ type: 'item', id: 'after-fix' }] });
      eq(recoveredSave.status, 200, '权限恢复后保存又能工作');
      deepEq(JSON.parse(readFileSync(permFile, 'utf8')).order, [{ type: 'item', id: 'after-fix' }], '恢复后确实写进去了');
    }
  }

  /* ═══════════ 8. readBody 超时：不发 body 也要有界结案（FIX 3） ═══════════ */

  {
    eq(BODY_TIMEOUT_MS, 15000, '默认超时是具名常量 15000ms');

    const hanging = makeReq({ method: 'POST', hang: true });
    const startedAt = Date.now();
    // 测试侧再加一道硬闸：万一 readBody 又变成「永不结案」，这里会以 'hung' 结案并把断言
    // 打红——否则整个自测会无输出地挂死，反而说不清是谁坏了。
    const outcome = await Promise.race([
      readBody(hanging, LIMITS.maxBodyBytes, 20).then(
        () => 'resolved',
        (error) => error,
      ),
      new Promise((done) => setTimeout(() => done('hung'), 2000)),
    ]);
    ok(outcome !== 'hung' && outcome !== 'resolved', 'body 永不到达 → readBody 以拒绝结案（不是无响应地挂着）');
    eq(outcome && outcome.statusCode, 408, '超时错误的 statusCode 是 408');
    // 关键：readBody **不能**自己 destroy。它一 reject，调用方是下一个微任务才去写 408 的，
    // 而同步 destroy 会把那条还没写出去的响应一起重置——真实走线上客户端只看到
    // "socket hang up"（probe-http.mjs 就是钉这件事的）。拆连接是调用方在 finish 之后的事。
    eq(hanging.destroyed === true, false, '超时不在 readBody 里销毁请求（销毁会把还没写出的 408 一起重置）');
    eq(bodyStatusOf(outcome), 408, '超时错误映射成 408（不是 400）');
    ok(Date.now() - startedAt < 5000, '在注入的短超时窗口内结案');

    // 映射是三段式：413 / 408 / 其余 400。漏掉任何一段都不会有别的测试发现。
    eq(bodyStatusOf({ statusCode: 413 }), 413, '413 原样');
    eq(bodyStatusOf({ statusCode: 408 }), 408, '408 原样（曾经被压成 400）');
    eq(bodyStatusOf({ statusCode: 500 }), 400, '别的 statusCode 不照抄，压成 400');
    eq(bodyStatusOf(new Error('普通错误')), 400, '没有 statusCode 的错误 → 400');
    eq(bodyStatusOf(undefined), 400, 'undefined → 400');

    // 提前收完仍然按 body 结案，且结算后不会被超时二次打扰。
    const quick = makeReq({ method: 'POST', body: 'hello' });
    eq(await readBody(quick, LIMITS.maxBodyBytes, 20), 'hello', '超时前收完 → 正常返回 body');
  }

  /* ═══════════ 9. load() 立即反映外部改动（没有 TTL 窗口，FIX 5） ═══════════ */

  {
    const noTtlFile = join(root, 'no-ttl.json');
    writeFileSync(noTtlFile, JSON.stringify({ schema: SCHEMA, revision: 1, order: [{ type: 'item', id: 'first' }] }), 'utf8');
    // 故意**不**传 cacheTtlMs：删除前它缺省 1000ms，正是这个窗口会让下面的断言失败。
    const handle = createSettingsNav(makeCtx(), { file: noTtlFile });
    eq(Object.hasOwn(handle.options, 'cacheTtlMs'), false, 'options 里没有 cacheTtlMs（死配置已删）');
    deepEq(handle.load().order, [{ type: 'item', id: 'first' }], 'load() 首次读盘');
    writeFileSync(noTtlFile, JSON.stringify({ schema: SCHEMA, revision: 2, order: [{ type: 'item', id: 'second' }] }), 'utf8');
    deepEq(handle.load().order, [{ type: 'item', id: 'second' }], '外部改动立刻被 load() 看到（没有 TTL 缓存窗口）');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`dsh-settings-nav host selftest: ${checks} 项全过`);
