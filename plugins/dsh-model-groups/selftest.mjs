/**
 * dsh-model-groups host 半边自测（无 Cordis、无 dsh 进程）。
 *
 *   node plugins/dsh-model-groups/selftest.mjs
 *
 * A 解析核心（resolve.js 纯函数）
 * B 插件主体（createModelGroups：状态文件 / 服务 / 路由 / 热生效 / 坏文件韧性）
 * C 与消费方约定的契约（未分组桶键、服务形状、快路径语义）
 * D 缺陷回归（每个已修缺陷一条：H1 形状非法 / H2 快照陈旧 / H3 超长 id /
 *   H4 Origin:null / H5 超限请求体 / H6 复合键碰撞 / H7 全星号规格）
 *
 * 末行 SELFTEST PASS 才算过。
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LIMITS, SCHEMA, compileGroups, emptyDocument, explainRoute, globToRegExp, normalizeDocument,
  resolveRoute, slugify, specOf, uniqueId,
} from './resolve.js';
import { BUILD, createModelGroups, normalizeUiState } from './index.js';

/* --------------------------------------------------------------- runner ---- */

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write('.');
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write('x');
  }
}
const section = (title) => process.stdout.write(`\n${title}\n  `);

/* ------------------------------------------------------------- 假 Cordis ---- */

function makeReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers,
    destroyed: false,
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); return req; },
    // 真实 socket 上 destroy() 会重置连接；这里只记账，供 H5 回归断言「不得先 destroy」。
    destroy() { req.destroyed = true; },
  };
  setImmediate(() => {
    if (body !== null) for (const fn of listeners.get('data') || []) fn(Buffer.from(body, 'utf8'));
    for (const fn of listeners.get('end') || []) fn();
  });
  return req;
}

function makeRes() {
  const res = {
    status: 0, headers: null, body: '', done: false,
    writeHead(status, headers) { res.status = status; res.headers = headers; },
    end(text) { res.body = text === undefined || text === null ? '' : String(text); res.done = true; },
  };
  return res;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function callRoute(routes, path, options = {}) {
  const pathname = path.split('?')[0];
  const route = routes.find((item) => item.path === pathname);
  assert.ok(route !== undefined, `路由不存在: ${pathname}`);
  const req = makeReq(Object.assign({ url: path }, options));
  const res = makeRes();
  await route.handler(req, res);
  // 必须用真实定时器等待：只用 setImmediate 空转会让事件循环的 poll 阶段变成非阻塞，
  // 异步 fs 写入（atomicWriteJson）等不到完成，响应就会「超时」——这正是本测试曾经的假阴性。
  const deadline = Date.now() + 3000;
  while (!res.done && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(res.done, `路由 ${path} 未在预期内结束响应`);
  let json = null;
  try { json = JSON.parse(res.body); } catch { json = null; }
  return { status: res.status, headers: res.headers, body: res.body, json, req };
}

/** 假 ctx：webServer / provide / effect / get('llm') / logger。 */
function fakeCtx(catalogProviders = null) {
  const routes = [];
  const provided = new Map();
  const effects = [];
  const warnings = [];
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1); }; } },
    provide(serviceName, value) {
      if (provided.has(serviceName)) throw new Error(`service "${serviceName}" has been registered`);
      provided.set(serviceName, value);
      return () => provided.delete(serviceName);
    },
    effect(fn, label) { effects.push({ label, dispose: fn() }); return () => {}; },
    get(serviceName) {
      if (serviceName !== 'llm' || catalogProviders === null) return undefined;
      return {
        listProviders: () => catalogProviders.map((entry) => ({ id: entry.id, name: entry.name || entry.id })),
        listModels: async (id) => {
          const found = catalogProviders.find((entry) => entry.id === id);
          if (found === undefined) throw new Error('unknown provider ' + id);
          if (found.fail === true) throw new Error('目录拉取失败');
          return (found.models || []).map((model) => ({ id: model, name: model }));
        },
      };
    },
    logger: { warn: (text) => warnings.push(String(text)) },
  };
  return { ctx, routes, provided, effects, warnings, disposeAll: () => { for (const entry of effects) if (typeof entry.dispose === 'function') entry.dispose(); } };
}

const GROUP = (id, name, priority, members, extra = {}) => Object.assign({
  id, name, description: '', enabled: true, priority, ignoreCase: false, members,
}, extra);

/* =========================================================== A 解析核心 ==== */

section('A 解析核心');

await test('glob：* 跨 / 与 :，? 单字符，特殊字符按字面', () => {
  assert.equal(globToRegExp('*').test('a/b:c'), true);
  assert.equal(globToRegExp('qwen/*').test('qwen/qwen3.8-27b:free'), true);
  assert.equal(globToRegExp('qwen/*').test('deepseek/x'), false);
  assert.equal(globToRegExp('a?c').test('abc'), true);
  assert.equal(globToRegExp('a?c').test('ac'), false);
  assert.equal(globToRegExp('a.c').test('abc'), false, '. 必须转义');
  assert.equal(globToRegExp('a.c').test('a.c'), true);
  assert.equal(globToRegExp('a+b').test('a+b'), true, '+ 必须转义');
  assert.equal(globToRegExp('x').test('x/y'), false, '必须锚定两端');
});

await test('大小写：默认区分，ignoreCase 生效', () => {
  assert.equal(globToRegExp('DeepSeek-V4.1').test('deepseek-v4.1'), false);
  assert.equal(globToRegExp('DeepSeek-V4.1', true).test('deepseek-v4.1'), true);
});

await test('specOf：字面 2 / 模式 1 / 裸 * 0', () => {
  assert.equal(specOf('localhost'), 2);
  assert.equal(specOf('qwen/*'), 1);
  assert.equal(specOf('moonshotai/kimi-k?'), 1);
  assert.equal(specOf('*'), 0);
  assert.equal(specOf(''), 0);
  assert.equal(specOf(undefined), 0);
});

await test('slugify / uniqueId', () => {
  assert.equal(slugify('Free Lane'), 'free-lane');
  assert.equal(slugify('免费车道'), '');
  const taken = new Set(['free-lane']);
  assert.equal(uniqueId('free lane', taken), 'free-lane-2');
  assert.equal(uniqueId('', new Set()), 'group');
  assert.equal(uniqueId('9lives', new Set()), '9lives');
});

await test('normalizeDocument：id 修正/去重、成员去重、优先级钳制、警告', () => {
  const { doc, issues, fatal } = normalizeDocument({
    groups: [
      { id: 'Bad Id', name: 'A', priority: 1e9, members: [{ provider: 'localhost', model: 'x' }, { provider: 'localhost', model: 'x' }] },
      { id: 'bad-id', name: '', members: [] },
      { id: 'catch', name: 'C', members: [{ provider: '', model: '' }] },
    ],
  });
  assert.deepEqual(fatal, []);
  assert.equal(doc.groups.length, 3);
  assert.equal(doc.groups[0].id, 'bad-id');
  assert.equal(doc.groups[0].members.length, 1, '重复成员应被去重');
  assert.equal(doc.groups[0].priority, 9999, 'priority 应被钳制');
  assert.equal(doc.groups[1].id, 'bad-id-2', '重复 id 应被唯一化');
  assert.equal(doc.groups[1].name, '分组 2', '空名称应有兜底');
  assert.ok(issues.some((text) => text.includes('没有成员')));
  assert.ok(issues.some((text) => text.includes('catch-all')));
  assert.ok(issues.some((text) => text.includes('重复')));
});

await test('normalizeDocument：致命错误（超上限）与宽容读取（根不是对象）', () => {
  const many = { groups: Array.from({ length: 65 }, (_, at) => ({ id: 'g' + at, members: [] })) };
  assert.equal(normalizeDocument(many).fatal.length, 1);
  const bad = normalizeDocument([1, 2, 3]);
  assert.equal(bad.doc.groups.length, 0);
  assert.ok(bad.issues.length > 0);
  const empty = normalizeDocument(emptyDocument());
  assert.equal(empty.doc.groups.length, 0);
  assert.equal(empty.doc.schema, SCHEMA);
});

await test('compileGroups：priority 升序 → 同级按声明顺序；停用组剔除', () => {
  const { doc } = normalizeDocument({
    groups: [
      GROUP('a', 'A', 50, [{ provider: 'p', model: '*' }]),
      GROUP('b', 'B', 10, [{ provider: 'p', model: '*' }]),
      GROUP('c', 'C', 50, [{ provider: 'p', model: '*' }]),
      GROUP('d', 'D', 1, [{ provider: 'p', model: '*' }], { enabled: false }),
    ],
  });
  const compiled = compileGroups(doc.groups);
  assert.deepEqual(compiled.map((entry) => entry.group.id), ['b', 'a', 'c']);
  assert.deepEqual(compiled.map((entry) => entry.order), [1, 2, 3]);
  assert.deepEqual(compiled.map((entry) => entry.fileIndex), [1, 0, 2]);
});

await test('resolveRoute：第一个命中的组胜出（互斥），跨供应商组成员生效', () => {
  const { doc } = normalizeDocument({
    groups: [
      GROUP('free', '免费', 10, [
        { provider: 'our-free-model', model: '*' },
        { provider: 'localhost', model: 'qwen/qwen3.8-27b:free' },
      ]),
      GROUP('all', '兜底', 900, [{ provider: '*', model: '*' }]),
    ],
  });
  const compiled = compileGroups(doc.groups);
  assert.equal(resolveRoute(compiled, 'our-free-model', 'anything').groupId, 'free');
  assert.equal(resolveRoute(compiled, 'localhost', 'qwen/qwen3.8-27b:free').groupId, 'free');
  assert.equal(resolveRoute(compiled, 'localhost', 'step-5-preview').groupId, 'all');
  assert.equal(resolveRoute(compiled, 'our-free-model', 'x').member.provider, 'our-free-model');
});

await test('resolveRoute：无组命中返回 null；停用组不参与', () => {
  const { doc } = normalizeDocument({
    groups: [GROUP('off', '停用', 1, [{ provider: '*', model: '*' }], { enabled: false })],
  });
  assert.equal(resolveRoute(compileGroups(doc.groups), 'p', 'm'), null);
});

await test('组内最具体命中成员被报告（模型字段优先于供应商字段）', () => {
  const { doc } = normalizeDocument({
    groups: [GROUP('g', 'G', 1, [
      { provider: '*', model: 'deepseek-ai/deepseek-v4.1-flash' },
      { provider: 'localhost', model: 'deepseek-ai/*' },
    ])],
  });
  const hit = resolveRoute(compileGroups(doc.groups), 'localhost', 'deepseek-ai/deepseek-v4.1-flash');
  assert.equal(hit.member.model, 'deepseek-ai/deepseek-v4.1-flash');
  assert.equal(hit.member.provider, '*');
});

await test('explainRoute：胜出组 + 被遮蔽候选', () => {
  const { doc } = normalizeDocument({
    groups: [
      GROUP('a', 'A', 10, [{ provider: '*', model: '*' }]),
      GROUP('b', 'B', 20, [{ provider: 'localhost', model: '*' }]),
    ],
  });
  const explained = explainRoute(compileGroups(doc.groups), 'localhost', 'm');
  assert.equal(explained.winner.groupId, 'a');
  assert.equal(explained.candidates.length, 2);
  assert.equal(explained.candidates[1].shadowed, true);
});

await test('大小写变体：字面组区分大小写，ignoreCase 组才能收拢两种拼写', () => {
  const literal = GROUP('nv', 'NVIDIA', 10, [{ provider: 'localhost', model: 'deepseek-ai/DeepSeek-V4.1-Flash' }]);
  const insensitive = GROUP('ci', '不区分大小写', 20, [{ provider: 'localhost', model: 'deepseek-ai/deepseek-v4.1-flash' }], { ignoreCase: true });

  const literalOnly = compileGroups(normalizeDocument({ groups: [literal] }).doc.groups);
  assert.equal(resolveRoute(literalOnly, 'localhost', 'deepseek-ai/DeepSeek-V4.1-Flash').groupId, 'nv');
  assert.equal(resolveRoute(literalOnly, 'localhost', 'deepseek-ai/deepseek-v4.1-flash'), null, '字面组默认不命中大小写变体');

  const both = compileGroups(normalizeDocument({ groups: [literal, insensitive] }).doc.groups);
  const hit = resolveRoute(both, 'localhost', 'deepseek-ai/deepseek-v4.1-flash');
  assert.equal(hit.groupId, 'ci', '只有 ignoreCase 的那个组命中小写拼写');
  assert.equal(explainRoute(both, 'localhost', 'deepseek-ai/deepseek-v4.1-flash').candidates.length, 1);

  const ciOnly = compileGroups(normalizeDocument({ groups: [insensitive] }).doc.groups);
  assert.equal(resolveRoute(ciOnly, 'localhost', 'deepseek-ai/DeepSeek-V4.1-Flash').groupId, 'ci', 'ignoreCase 组两种拼写都收');
});

/* =========================================================== B 插件主体 ==== */

section('B 插件主体');

const root = mkdtempSync(join(tmpdir(), 'dsh-model-groups-selftest-'));
const statePath = join(root, 'model-groups.json');

await test('未建文件时：state 可用、0 组、不抛错', async () => {
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const state = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.ok, true);
  assert.equal(state.json.exists, false);
  assert.deepEqual(state.json.groups, []);
  assert.equal(handle.servicePublished, true);
  harness.disposeAll();
});

await test('POST 保存：原子落盘、revision 递增、回读一致', async () => {
  rmSync(statePath, { force: true });
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const payload = {
    groups: [
      GROUP('free', '免费车道', 10, [{ provider: 'our-free-model', model: '*' }, { provider: 'localhost', model: 'qwen/*' }]),
      GROUP('nv', 'NVIDIA 直连', 20, [{ provider: 'localhost', model: 'deepseek-ai/deepseek-v4.1-flash' }], { enabled: false }),
    ],
  };
  const saved = await callRoute(harness.routes, '/dsh-model-groups/groups', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: undefined }, body: JSON.stringify(payload),
  });
  assert.equal(saved.status, 200, saved.body);
  assert.equal(saved.json.revision, 1);
  const onDisk = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(onDisk.schema, SCHEMA);
  assert.equal(onDisk.groups.length, 2);
  assert.equal(onDisk.groups[0].id, 'free');
  const state = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.equal(state.json.groups.length, 2);
  assert.equal(state.json.groups[0].order, 1, '启用的组应拿到解析次序');
  assert.equal(state.json.groups[1].order, 0, '停用的组不参与解析');
  assert.ok(handle.service.resolve('our-free-model', 'x') !== null);
  harness.disposeAll();
});

await test('服务形状：resolve 快路径 / memo / list / ids / members', async () => {
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const service = harness.provided.get('modelGroups');
  assert.equal(service.schema, SCHEMA);
  assert.deepEqual(service.ids(), ['free']);
  assert.equal(service.resolve('localhost', 'qwen/qwen3.8-27b:free').groupId, 'free');
  assert.equal(service.resolve('localhost', 'step-5-preview'), null);
  const first = service.resolve('localhost', 'qwen/qwen3.8-27b:free');
  const second = service.resolve('localhost', 'qwen/qwen3.8-27b:free');
  assert.deepEqual(first, second);
  const list = service.list();
  assert.equal(list[0].members.length, 2);
  list[0].members[0].provider = 'tampered';
  assert.equal(service.list()[0].members[0].provider, 'our-free-model', 'list() 必须返回拷贝');
  assert.equal(service.members('free').length, 2);
  assert.deepEqual(service.members('nope'), []);
  harness.disposeAll();
});

await test('热生效：外部改文件 → TTL 内仍旧值，refresh/超时后新值', async () => {
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 60000 });
  assert.equal(handle.service.resolve('localhost', 'step-5-preview'), null);
  writeFileSync(statePath, JSON.stringify({
    schema: SCHEMA, revision: 9, groups: [GROUP('all', '全部', 1, [{ provider: '*', model: '*' }])],
  }, null, 2), 'utf8');
  assert.equal(handle.service.resolve('localhost', 'step-5-preview'), null, 'TTL 内不重读（快路径不做 I/O）');
  handle.service.refresh();
  assert.equal(handle.service.resolve('localhost', 'step-5-preview').groupId, 'all');
  assert.equal(handle.service.revision(), 9);
  harness.disposeAll();
});

await test('缓存 TTL 到期后自动重载（无需 refresh）', async () => {
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 10 });
  writeFileSync(statePath, JSON.stringify({ schema: SCHEMA, revision: 10, groups: [] }, null, 2), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(handle.service.revision(), 10);
  assert.equal(handle.service.resolve('localhost', 'qwen/qwen3.8-27b:free'), null);
  harness.disposeAll();
});

await test('坏文件韧性：保留上次可用快照 + 记警告（不把分组清空）', async () => {
  writeFileSync(statePath, JSON.stringify({
    schema: SCHEMA, revision: 11, groups: [GROUP('keep', '保留', 1, [{ provider: '*', model: '*' }])],
  }, null, 2), 'utf8');
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  assert.equal(handle.service.resolve('x', 'y').groupId, 'keep');
  writeFileSync(statePath, '{ this is not json', 'utf8');
  assert.equal(handle.service.resolve('x', 'y').groupId, 'keep', '坏文件不应清空分组');
  const state = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.ok(state.json.warnings.some((text) => text.includes('读取失败') || text.includes('不可解析')));
  assert.ok(harness.warnings.length > 0, '应留下 logger 警告');
  harness.disposeAll();
});

await test('路由守卫：GET /groups → 405，跨源 POST → 403，非法 JSON → 400', async () => {
  rmSync(statePath, { force: true });
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const wrongMethod = await callRoute(harness.routes, '/dsh-model-groups/groups', { method: 'GET' });
  assert.equal(wrongMethod.status, 405);
  const crossOrigin = await callRoute(harness.routes, '/dsh-model-groups/groups', {
    method: 'POST', headers: { origin: 'http://evil.example' }, body: '{"groups":[]}',
  });
  assert.equal(crossOrigin.status, 403);
  const badJson = await callRoute(harness.routes, '/dsh-model-groups/groups', { method: 'POST', body: '{oops' });
  assert.equal(badJson.status, 400);
  const selfOrigin = await callRoute(harness.routes, '/dsh-model-groups/groups', {
    method: 'POST', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }, body: JSON.stringify({ groups: [] }),
  });
  assert.equal(selfOrigin.status, 200, selfOrigin.body);
  harness.disposeAll();
});

await test('POST /resolve：单条与批量；无参数 → 400', async () => {
  rmSync(statePath, { force: true });
  writeFileSync(statePath, JSON.stringify({
    schema: SCHEMA, revision: 1,
    groups: [
      GROUP('free', '免费', 10, [{ provider: 'our-free-model', model: '*' }]),
      GROUP('rest', '其余', 900, [{ provider: '*', model: '*' }]),
    ],
  }, null, 2), 'utf8');
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const single = await callRoute(harness.routes, '/dsh-model-groups/resolve', {
    method: 'POST', body: JSON.stringify({ provider: 'our-free-model', model: 'kimi-k3' }),
  });
  assert.equal(single.status, 200);
  assert.equal(single.json.winner.groupId, 'free');
  const batch = await callRoute(harness.routes, '/dsh-model-groups/resolve', {
    method: 'POST',
    body: JSON.stringify({ routes: [{ provider: 'our-free-model', model: 'a' }, { provider: 'localhost', model: 'b' }] }),
  });
  assert.deepEqual(batch.json.results.map((row) => row.winner.groupId), ['free', 'rest']);
  const none = await callRoute(harness.routes, '/dsh-model-groups/resolve', { method: 'POST', body: '{}' });
  assert.equal(none.status, 400);
  harness.disposeAll();
});

await test('GET /audit：真实目录核算命中/未归组/重叠', async () => {
  writeFileSync(statePath, JSON.stringify({
    schema: SCHEMA, revision: 2,
    groups: [
      GROUP('ci', '不区分大小写', 10, [{ provider: 'localhost', model: 'deepseek-ai/deepseek-v4.1-flash' }], { ignoreCase: true }),
      GROUP('rest', '其余', 900, [{ provider: '*', model: '*' }], { enabled: false }),
    ],
  }, null, 2), 'utf8');
  const harness = fakeCtx([
    { id: 'localhost', name: 'NewAPIGate', models: ['deepseek-ai/DeepSeek-V4.1-Flash', 'step-5-preview'] },
    { id: 'our-free-model', name: 'OurFreeModel', models: ['kimi-k3'] },
    { id: 'broken', name: 'Broken', fail: true },
  ]);
  createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const audit = await callRoute(harness.routes, '/dsh-model-groups/audit?fresh=1');
  assert.equal(audit.status, 200, audit.body);
  assert.equal(audit.json.catalog.available, true);
  assert.equal(audit.json.catalog.routes, 3);
  assert.equal(audit.json.catalog.failures.length, 1, '坏供应商应进 failures');
  const ci = audit.json.groups.find((row) => row.id === 'ci');
  assert.equal(ci.matched.length, 1, 'ignoreCase 组应命中大小写变体');
  assert.equal(ci.matched[0].model, 'deepseek-ai/DeepSeek-V4.1-Flash');
  assert.equal(audit.json.ungrouped.length, 2);
  harness.disposeAll();
});

await test('llm 服务缺失时 audit 优雅降级', async () => {
  const harness = fakeCtx(null);
  createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const audit = await callRoute(harness.routes, '/dsh-model-groups/audit');
  assert.equal(audit.status, 200);
  assert.equal(audit.json.catalog.available, false);
  assert.ok(String(audit.json.catalog.error).includes('llm'));
  harness.disposeAll();
});

await test('dispose：注销路由，且不重复注销服务', async () => {
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  assert.equal(harness.routes.length, 5, 'state / groups / resolve / audit / ui');
  handle.dispose();
  assert.equal(harness.routes.length, 0);
  assert.equal(harness.provided.has('modelGroups'), true, '服务由 fiber 注销，dispose 不应越权删除');
  harness.disposeAll();
});

await test('服务名已被占用时不炸整行（降级为无服务）', async () => {
  const harness = fakeCtx();
  harness.provided.set('modelGroups', { preexisting: true });
  const handle = createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  assert.equal(handle.servicePublished, false);
  assert.equal(harness.warnings.length, 1);
  assert.equal(harness.routes.length, 5, '路由照常注册');
  harness.disposeAll();
});

/* ============================================================ C 契约 ====== */

section('C 消费方契约');

await test('统计侧：resolve 对同一 (provider, model) 恒定（互斥 → 无重复计入）', async () => {
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const service = harness.provided.get('modelGroups');
  const routes = [['localhost', 'a'], ['localhost', 'b'], ['our-free-model', 'a']];
  const first = routes.map(([provider, model]) => service.resolve(provider, model));
  const second = routes.map(([provider, model]) => service.resolve(provider, model));
  assert.deepEqual(first, second);
  const buckets = new Set(first.map((hit) => (hit === null ? '__ungrouped__' : hit.groupId)));
  assert.ok(buckets.size >= 1);
  harness.disposeAll();
});

await test('重试侧：resolve 返回值可直接当 groupId 比对（形状稳定）', async () => {
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const service = harness.provided.get('modelGroups');
  const hit = service.resolve('our-free-model', 'kimi-k3');
  if (hit !== null) {
    assert.equal(typeof hit.groupId, 'string');
    assert.equal(typeof hit.groupName, 'string');
    assert.equal(typeof hit.order, 'number');
    assert.equal(typeof hit.member.provider, 'string');
    assert.equal(typeof hit.member.model, 'string');
  }
  assert.equal(typeof service.resolve, 'function');
  harness.disposeAll();
});

/* ============================================================ D 回归 ====== */

section('D 缺陷回归');

await test('回归 H1：JSON 合法但形状非法（groups:null / 根 null / 缺 groups / schema 不认识）保留上次可用快照并告警', async () => {
  rmSync(statePath, { force: true });
  writeFileSync(statePath, JSON.stringify({
    schema: SCHEMA, revision: 21, groups: [GROUP('keep', '保留', 1, [{ provider: '*', model: '*' }])],
  }, null, 2), 'utf8');
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  assert.equal(handle.service.resolve('x', 'y').groupId, 'keep');

  const badShapes = ['{"groups":null}', 'null', '{}', '{"schema":2,"groups":[]}', '[]', '{"groups":"nope"}'];
  for (const text of badShapes) {
    writeFileSync(statePath, text, 'utf8');
    const hit = handle.service.resolve('x', 'y');
    assert.ok(hit !== null && hit.groupId === 'keep', `形状非法 ${text} 不得清空分组`);
    const state = await callRoute(harness.routes, '/dsh-model-groups/state');
    assert.deepEqual(state.json.groups.map((group) => group.id), ['keep'], `形状非法 ${text} 的 state 不应变化`);
    assert.ok(state.json.warnings.some((warn) => warn.includes('配置文件读取失败')),
      `形状非法 ${text} 必须如实告警：${JSON.stringify(state.json.warnings)}`);
  }

  // 边界：结构合法、只有一个组不规范 → 仍走逐组归一化 + issues，不得误判成坏文件
  writeFileSync(statePath, JSON.stringify({ schema: SCHEMA, revision: 22, groups: [{ id: 'soft', name: 'S', members: 'nope' }] }), 'utf8');
  const soft = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.deepEqual(soft.json.groups.map((group) => group.id), ['soft']);
  assert.ok(soft.json.warnings.some((warn) => warn.includes('members 不是数组')), JSON.stringify(soft.json.warnings));

  // 写入侧同样拒绝：一次手抖的 POST 不能把已落盘的分组清空
  const before = readFileSync(statePath, 'utf8');
  const rejected = await callRoute(harness.routes, '/dsh-model-groups/groups', { method: 'POST', body: '{"groups":null}' });
  assert.equal(rejected.status, 400, rejected.body);
  assert.ok(String(rejected.json.error).includes('groups 不是数组'), rejected.body);
  assert.equal(readFileSync(statePath, 'utf8'), before, '400 之后文件不得被改动');
  harness.disposeAll();
});

await test('回归 H2：mtime 与 size 都没变（同尺寸改写 / cp -p 保留时间戳）也必须按内容热生效', async () => {
  const textA = JSON.stringify({ schema: SCHEMA, revision: 1, groups: [GROUP('aaaa', 'A', 1, [{ provider: '*', model: '*' }])] });
  const textB = JSON.stringify({ schema: SCHEMA, revision: 1, groups: [GROUP('bbbb', 'B', 1, [{ provider: '*', model: '*' }])] });
  assert.equal(textA.length, textB.length, '本回归要求两份内容等长');
  const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
  writeFileSync(statePath, textA, 'utf8');
  utimesSync(statePath, stamp, stamp);
  const statA = statSync(statePath);
  assert.equal(statA.mtimeMs, stamp.getTime(), '文件系统需能按整秒保留 mtime，否则本回归测不到点子上');

  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  assert.equal(handle.service.resolve('p', 'm').groupId, 'aaaa');
  writeFileSync(statePath, textB, 'utf8');
  utimesSync(statePath, stamp, stamp);                  // 模拟 cp -p / utimes：时间戳被拨回原值
  const statB = statSync(statePath);
  assert.equal(statB.size, statA.size, '(mtime,size) 必须与改写前完全一致');
  assert.equal(statB.mtimeMs, statA.mtimeMs, '(mtime,size) 必须与改写前完全一致');
  assert.equal(handle.service.resolve('p', 'm').groupId, 'bbbb', 'stat 未变时仍必须按内容重载');
  assert.equal(handle.service.explain('p', 'm').winner.groupId, 'bbbb', 'explain 与 resolve 必须一致');
  harness.disposeAll();
});

await test('回归 H2：默认 TTL 下同 stat 改写也能在 1 秒左右热生效（README 承诺），且 TTL 内不读盘', async () => {
  const textA = JSON.stringify({ schema: SCHEMA, revision: 1, groups: [GROUP('cccc', 'C', 1, [{ provider: '*', model: '*' }])] });
  const textB = JSON.stringify({ schema: SCHEMA, revision: 1, groups: [GROUP('dddd', 'D', 1, [{ provider: '*', model: '*' }])] });
  assert.equal(textA.length, textB.length, '本回归要求两份内容等长');
  const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
  writeFileSync(statePath, textA, 'utf8');
  utimesSync(statePath, stamp, stamp);
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 1000 });
  assert.equal(handle.service.resolve('p', 'm').groupId, 'cccc');
  writeFileSync(statePath, textB, 'utf8');
  utimesSync(statePath, stamp, stamp);
  assert.equal(handle.service.resolve('p', 'm').groupId, 'cccc', 'TTL 内必须走快路径（不逐请求读盘）');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(handle.service.resolve('p', 'm').groupId, 'dddd', 'TTL 到期后必须按内容重载');
  harness.disposeAll();
});

await test('回归 H3：超长 id 确定性截断到 limits.maxIdChars，截断后仍唯一、仍合法、落盘受限', async () => {
  const longId = 'g' + 'x'.repeat(299);
  const longId2 = 'g' + 'x'.repeat(298) + 'y';           // 前 64 位与上一条相同 → 截断后必须唯一化
  const parsed = normalizeDocument({ groups: [
    GROUP(longId, '长一', 1, [{ provider: '*', model: '*' }]),
    GROUP(longId2, '长二', 2, [{ provider: '*', model: '*' }]),
  ] });
  assert.equal(parsed.doc.groups[0].id.length, LIMITS.maxIdChars);
  assert.equal(parsed.doc.groups[1].id.length, LIMITS.maxIdChars);
  assert.notEqual(parsed.doc.groups[0].id, parsed.doc.groups[1].id, '截断后必须仍然唯一');
  for (const group of parsed.doc.groups) {
    assert.ok(/^[a-z0-9][a-z0-9._-]*$/.test(group.id), `截断后必须仍然合法：${group.id}`);
  }
  assert.ok(parsed.issues.some((text) => text.includes('超过上限')), JSON.stringify(parsed.issues));
  assert.deepEqual(parsed.shapeErrors, [], '形状本身合法（只是 id 超长）');

  rmSync(statePath, { force: true });
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const saved = await callRoute(harness.routes, '/dsh-model-groups/groups', {
    method: 'POST', body: JSON.stringify({ groups: [GROUP(longId, '长 id', 1, [{ provider: '*', model: '*' }])] }),
  });
  assert.equal(saved.status, 200, saved.body);
  const onDisk = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.ok(onDisk.groups[0].id.length <= LIMITS.maxIdChars, `落盘 id 不得超过 ${LIMITS.maxIdChars}`);
  assert.equal(saved.json.groups[0].id, onDisk.groups[0].id);
  const state = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.equal(state.json.limits.maxIdChars, LIMITS.maxIdChars, 'state 暴露的上限就是实际强制的上限');
  harness.disposeAll();
});

await test('回归 H4：Origin: null 按外部处理 → 403；无 Origin 头（curl / 本机 CLI）仍放行', async () => {
  rmSync(statePath, { force: true });
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const nullOrigin = await callRoute(harness.routes, '/dsh-model-groups/groups', {
    method: 'POST', headers: { origin: 'null' }, body: JSON.stringify({ groups: [] }),
  });
  assert.equal(nullOrigin.status, 403, 'Origin: null（沙箱 iframe / file:// 页面）必须按外部处理');
  const nullOriginResolve = await callRoute(harness.routes, '/dsh-model-groups/resolve', {
    method: 'POST', headers: { origin: 'null' }, body: JSON.stringify({ provider: 'p', model: 'm' }),
  });
  assert.equal(nullOriginResolve.status, 403, '/resolve 同样受同源守卫保护');
  const noOrigin = await callRoute(harness.routes, '/dsh-model-groups/groups', {
    method: 'POST', body: JSON.stringify({ groups: [] }),
  });
  assert.equal(noOrigin.status, 200, '无 Origin 头必须放行（curl / 本机 CLI）');
  const sameOrigin = await callRoute(harness.routes, '/dsh-model-groups/groups', {
    method: 'POST', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }, body: JSON.stringify({ groups: [] }),
  });
  assert.equal(sameOrigin.status, 200, '同源页面必须放行');
  harness.disposeAll();
});

await test('回归 H5：请求体超限先完整发出 413 JSON，不得先 destroy 连接（错误文案照旧）', async () => {
  rmSync(statePath, { force: true });
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const huge = JSON.stringify({ groups: [], pad: 'x'.repeat(300000) });   // > 262144 上限
  const over = await callRoute(harness.routes, '/dsh-model-groups/groups', { method: 'POST', body: huge });
  assert.equal(over.req.destroyed, false, '不得先 destroy：否则客户端只看得到连接重置');
  assert.equal(over.status, 413, over.body);
  assert.equal(over.json.error, 'body too large', '错误文案保持不变');
  const overResolve = await callRoute(harness.routes, '/dsh-model-groups/resolve', { method: 'POST', body: huge });
  assert.equal(overResolve.status, 413, overResolve.body);
  assert.equal(overResolve.req.destroyed, false);
  harness.disposeAll();
});

await test('回归 H6：成员 U+0000 被剥除并入 issues，记忆表与 explain 对含 NUL 路由永远一致', async () => {
  const parsed = normalizeDocument({ groups: [GROUP('g', 'G', 1, [
    { provider: 'a', model: 'b\u0000c' }, { provider: 'a\u0000b', model: 'c' },
  ])] });
  assert.equal(parsed.doc.groups[0].members.length, 2, '两条不同成员不得因 NUL 拼接撞键被误删');
  assert.deepEqual(parsed.doc.groups[0].members.map((m) => m.provider + '|' + m.model), ['a|bc', 'ab|c']);
  assert.ok(parsed.issues.some((text) => text.includes('U+0000')), JSON.stringify(parsed.issues));

  // 匹配式本身不含 NUL（用 ? 命中 NUL 字符），所以这里只可能撞在复合键编码上
  writeFileSync(statePath, JSON.stringify({
    schema: SCHEMA, revision: 1,
    groups: [GROUP('g1', 'G1', 1, [{ provider: 'a?b', model: 'c' }]), GROUP('g2', 'G2', 2, [{ provider: 'a', model: 'b?c' }])],
  }), 'utf8');
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const first = handle.service.resolve('a', 'b\u0000c');
  const second = handle.service.resolve('a\u0000b', 'c');
  assert.equal(first.groupId, 'g2');
  assert.equal(second.groupId, 'g1', '两条不同路由不得共用记忆表条目');
  assert.equal(handle.service.explain('a\u0000b', 'c').winner.groupId, second.groupId, 'resolve 与 explain 必须一致');
  assert.equal(handle.service.explain('a', 'b\u0000c').winner.groupId, first.groupId);
  harness.disposeAll();
});

await test('回归 H7：全星号（* / ** / ***）一律按「任意」计，遮蔽告警按语义比较', async () => {
  assert.equal(specOf('*'), 0);
  assert.equal(specOf('**'), 0);
  assert.equal(specOf('***'), 0);
  assert.equal(specOf('  *  '), 0);
  assert.equal(specOf('a*'), 1, '含字面字符的通配式仍是模式');
  const parsed = normalizeDocument({ groups: [GROUP('g', 'G', 1, [
    { provider: 'localhost', model: '*' }, { provider: '**', model: '**' },
  ])] });
  const hit = resolveRoute(compileGroups(parsed.doc.groups), 'localhost', 'anything');
  assert.equal(hit.member.provider, 'localhost', '双全星号只是「任意」，不能算比 provider 字面更具体');

  // provider=** + model=* 语义等于 */*：遮蔽告警必须照报（旧实现漏报）
  writeFileSync(statePath, JSON.stringify({
    schema: SCHEMA, revision: 1,
    groups: [GROUP('star', '全星号写法', 1, [{ provider: '**', model: '*' }]), GROUP('later', '后面的组', 2, [{ provider: 'localhost', model: 'x' }])],
  }), 'utf8');
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const state = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.ok(state.json.warnings.some((text) => text.includes('会遮蔽其后')), JSON.stringify(state.json.warnings));
  harness.disposeAll();
});

/* ------------------------------------------------- E fix-2 缺陷回归 ---- */

section('E fix-2 缺陷回归（H8 revision 单调 / H9 跨块 UTF-8 / H10 drain 有界）');

await test('回归 H8：revision 单调不减——内容变必递增，仅 touch 不回落到文件里的旧值', async () => {
  const file = join(root, 'h8-groups.json');
  const doc = (rev, id) => JSON.stringify({ schema: 1, revision: rev, groups: [GROUP(id, id, 100, [{ provider: '*', model: '*' }])] });
  writeFileSync(file, doc(5, 'a'));
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file, cacheTtlMs: 0 });
  const rev = () => handle.service.revision();
  const ids = () => handle.service.list().map((g) => g.id);
  assert.equal(rev(), 5);
  assert.deepEqual(ids(), ['a']);
  writeFileSync(file, doc(5, 'b'));            // 内容变、revision 字段不动
  assert.equal(rev(), 6, '内容变必须 +1');
  assert.deepEqual(ids(), ['b']);
  const before = rev();
  const st = statSync(file);
  utimesSync(file, st.atime, st.mtime);        // 仅 touch（同尺寸改写场景的伪装）
  assert.equal(rev(), before, '仅 touch 不得改变 revision');
  assert.deepEqual(ids(), ['b']);
  writeFileSync(file, doc(2, 'c'));            // 内容变、revision 字段**回退**
  assert.equal(rev(), before + 1, '字段回退也不得让 revision 回落');
  assert.deepEqual(ids(), ['c']);
  // GET /state 幂等：同一文件连读两次必须同值（否则消费方会误判「没变」）
  const one = await callRoute(harness.routes, '/dsh-model-groups/state');
  const two = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.equal(one.json.revision, two.json.revision, 'GET /state 必须幂等');
  handle.dispose();
  rmSync(file, { force: true });
});

await test('回归 H9：请求体跨 TCP 分块的多字节字符不被破坏（setEncoding 而非逐块 toString）', async () => {
  const { StringDecoder } = await import('node:string_decoder');
  rmSync(statePath, { force: true });
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const payload = JSON.stringify({ groups: [GROUP('multi', '多字节组名😀', 100, [{ provider: '命名供应商', model: '模型-中文' }])] });
  const bytes = Buffer.from(payload, 'utf8');
  const cut = bytes.indexOf(Buffer.from('供', 'utf8')) + 1;    // 故意切在多字节字符中间
  // 模拟真实 IncomingMessage：handler 调了 setEncoding('utf8') → data 事件给字符串
  //（用 StringDecoder 拼接跨界字节）；没调 → 给 Buffer（逐块 toString 会插 U+FFFD）。
  const listeners = new Map();
  const req = {
    method: 'POST', url: '/dsh-model-groups/groups',
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    setEncoding(encoding) { this.encoding = encoding; },
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); return req; },
    removeListener(type, fn) { const list = listeners.get(type); if (list !== undefined) { const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); } return req; },
    resume() { return req; }, pause() {}, destroy() { req.destroyed = true; },
  };
  const res = makeRes();
  const route = harness.routes.find((item) => item.path === '/dsh-model-groups/groups');
  await route.handler(req, res);
  const decoder = new StringDecoder('utf8');
  setImmediate(() => {
    for (const chunk of [bytes.subarray(0, cut), bytes.subarray(cut)]) {
      for (const fn of [...(listeners.get('data') || [])]) fn(req.encoding === 'utf8' ? decoder.write(chunk) : chunk);
    }
    for (const fn of [...(listeners.get('end') || [])]) fn();
  });
  const deadline = Date.now() + 3000;
  while (!res.done && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(res.status, 200, res.body);
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(saved.groups[0].name, '多字节组名😀', '跨块多字节不得变 U+FFFD：' + JSON.stringify(saved.groups[0]));
  assert.equal(saved.groups[0].members[0].provider, '命名供应商');
  assert.equal(saved.groups[0].members[0].model, '模型-中文');
  harness.disposeAll();
  rmSync(statePath, { force: true });
});

await test('回归 H10：413 之后的排空有界——持续投喂超预算即断开，且 413 仍能被读到', async () => {
  rmSync(statePath, { force: true });
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, cacheTtlMs: 0 });
  const listeners = new Map();
  const req = {
    method: 'POST', url: '/dsh-model-groups/groups',
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    destroyed: false,
    setEncoding() {}, on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); return req; },
    removeListener(type, fn) { const list = listeners.get(type); if (list !== undefined) { const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); } return req; },
    resume() { return req; }, pause() {}, destroy() { req.destroyed = true; },
  };
  const res = makeRes();
  const route = harness.routes.find((item) => item.path === '/dsh-model-groups/groups');
  await route.handler(req, res);
  await tick(); await tick();                               // 等 handler 走到挂监听器那一步
  await new Promise((resolve) => setTimeout(resolve, 2));
  const chunk = 'x'.repeat(65536);
  const feed = () => [...(listeners.get('data') || [])].forEach((fn) => fn(chunk));
  let fed = 0;
  for (let i = 0; i < 5; i += 1) { fed += 1; feed(); }       // 262144 之后再一块即越界
  await tick();                                             // reject → catch → 写响应要过一个微任务
  assert.equal(res.status, 413, res.body);
  assert.equal(req.destroyed, false, '回 413 时不得先 destroy（客户端要能读到响应）');
  while (!req.destroyed && fed < 200) { fed += 1; feed(); } // 持续投喂：262144*4 预算 + 若干块
  assert.equal(req.destroyed, true, '超预算必须断开，否则客户端可无限占住 socket');
  assert.ok(fed < 60, `应在有限块数内断开（实际 ${fed} 块）`);
  assert.equal(JSON.parse(res.body).error, 'body too large', '413 文案照旧');
  harness.disposeAll();
  rmSync(statePath, { force: true });
});

/* ================================================ F 折叠状态（UI 偏好） ==== */

section('F 折叠状态（UI 偏好，model-groups-ui.json）');

const uiPath = join(root, 'model-groups-ui.json');

await test('ui 路径：缺省跟随分组文件目录（file 的 dirname + model-groups-ui.json）', async () => {
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: join(root, 'sub', 'groups.json'), cacheTtlMs: 0 });
  assert.equal(handle.uiPath, join(root, 'sub', 'model-groups-ui.json'));
  harness.disposeAll();
  const explicit = fakeCtx();
  const other = createModelGroups(explicit.ctx, { file: statePath, uiFile: join(root, 'explicit-ui.json'), cacheTtlMs: 0 });
  assert.equal(other.uiPath, join(root, 'explicit-ui.json'), 'uiFile 可显式覆盖');
  explicit.disposeAll();
});

await test('normalizeUiState：去重 / 排序 / 大小写归一 / 非法项丢弃 / 上限截断', async () => {
  const clean = normalizeUiState({ schema: 1, revision: 7, collapsed: ['B', 'a', 'a', ' b '] });
  assert.deepEqual(clean.collapsed, ['a', 'b']);
  assert.equal(clean.revision, 7);
  assert.deepEqual(clean.issues, []);
  const dirty = normalizeUiState({ collapsed: ['ok', '', 'Bad ID', 42, null, 'x'.repeat(200)] });
  assert.deepEqual(dirty.collapsed, ['ok']);
  assert.equal(dirty.issues.length, 5, '空串 / 带空格 / 数字 / null / 超长各记一条：' + JSON.stringify(dirty.issues));
  const notObject = normalizeUiState(null);
  assert.deepEqual(notObject.collapsed, []);
  assert.ok(notObject.issues.some((text) => text.includes('根不是对象')));
  const wrongShape = normalizeUiState({ collapsed: 'nope' });
  assert.deepEqual(wrongShape.collapsed, []);
  assert.ok(wrongShape.issues.some((text) => text.includes('不是数组')));
  const many = normalizeUiState({ collapsed: Array.from({ length: LIMITS.maxGroups + 3 }, (_, at) => 'g' + at) });
  assert.equal(many.collapsed.length, LIMITS.maxGroups);
  assert.ok(many.issues.some((text) => text.includes('超过上限')));
});

await test('未建文件：GET /ui 给空集合、/state 内联 ui.collapsed，不抛错', async () => {
  rmSync(uiPath, { force: true });
  rmSync(statePath, { force: true });
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, uiFile: uiPath, cacheTtlMs: 0 });
  const ui = await callRoute(harness.routes, '/dsh-model-groups/ui');
  assert.equal(ui.status, 200);
  assert.equal(ui.json.ok, true);
  assert.equal(ui.json.exists, false);
  assert.deepEqual(ui.json.collapsed, []);
  assert.equal(ui.json.issues.length, 0);
  const state = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.deepEqual(state.json.ui.collapsed, [], '加载时一次请求就能拿到折叠集合');
  assert.equal(state.json.ui.exists, false);
  assert.equal(state.json.ui.path, uiPath);
  harness.disposeAll();
});

await test('POST /ui：原子落盘、revision 递增、回读一致、/state 同步', async () => {
  rmSync(uiPath, { force: true });
  writeFileSync(statePath, JSON.stringify({
    schema: SCHEMA, revision: 1, groups: [GROUP('free', '免费', 1, [{ provider: '*', model: '*' }])],
  }, null, 2), 'utf8');
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, uiFile: uiPath, cacheTtlMs: 0 });
  const saved = await callRoute(harness.routes, '/dsh-model-groups/ui', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collapsed: ['nv', 'free', 'nv'] }),
  });
  assert.equal(saved.status, 200, saved.body);
  assert.equal(saved.json.revision, 1);
  assert.deepEqual(saved.json.collapsed, ['free', 'nv'], 'host 返回归一化结果（去重 + 排序）');
  const onDisk = JSON.parse(readFileSync(uiPath, 'utf8'));
  assert.equal(onDisk.schema, 1);
  assert.equal(onDisk.revision, 1);
  assert.deepEqual(onDisk.collapsed, ['free', 'nv']);
  assert.equal(typeof onDisk.updatedAt, 'number');
  const again = await callRoute(harness.routes, '/dsh-model-groups/ui', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collapsed: [] }),
  });
  assert.equal(again.json.revision, 2, 'revision 单调递增');
  assert.deepEqual(again.json.collapsed, []);
  const state = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.deepEqual(state.json.ui.collapsed, []);
  assert.equal(state.json.ui.revision, 2);
  // 折叠状态**不碰**分组文件：两件事各存各的
  const groupsOnDisk = readFileSync(statePath, 'utf8');
  assert.ok(!groupsOnDisk.includes('collapsed'), '分组本体里不能出现折叠状态');
  harness.disposeAll();
});

await test('POST /ui 校验：空 body / 坏 JSON / 非对象 / 缺 collapsed / 非数组 / 跨源 / 错方法', async () => {
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, uiFile: uiPath, cacheTtlMs: 0 });
  const post = (options) => callRoute(harness.routes, '/dsh-model-groups/ui', Object.assign({ method: 'POST' }, options));
  assert.equal((await post({ body: '' })).status, 400);
  assert.equal((await post({ body: '{oops' })).status, 400);
  assert.equal((await post({ body: '[]' })).status, 400);
  assert.equal((await post({ body: '{"nope":1}' })).status, 400, '缺 collapsed 必须拒绝（避免手抖清空）');
  assert.equal((await post({ body: '{"collapsed":"x"}' })).status, 400);
  const cross = await post({ headers: { origin: 'http://evil.example' }, body: '{"collapsed":[]}' });
  assert.equal(cross.status, 403);
  const crossNull = await post({ headers: { origin: 'null' }, body: '{"collapsed":[]}' });
  assert.equal(crossNull.status, 403, 'Origin: null 按外部处理（H4 口径一致）');
  const selfOrigin = await post({
    headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }, body: '{"collapsed":["free"]}',
  });
  assert.equal(selfOrigin.status, 200, selfOrigin.body);
  assert.equal((await callRoute(harness.routes, '/dsh-model-groups/ui', { method: 'DELETE' })).status, 405);
  // 元素级问题宽松：坏项丢弃 + issues 回报，好项照常落盘
  const mixed = await post({ body: JSON.stringify({ collapsed: ['free', 'Bad ID', 7] }) });
  assert.equal(mixed.status, 200, mixed.body);
  assert.deepEqual(mixed.json.collapsed, ['free']);
  assert.equal(mixed.json.issues.length, 2);
  const onDisk = JSON.parse(readFileSync(uiPath, 'utf8'));
  assert.deepEqual(onDisk.collapsed, ['free']);
  harness.disposeAll();
});

await test('坏文件降级：JSON 语法坏 → 空集合 + warning，且分组本体不受影响', async () => {
  writeFileSync(statePath, JSON.stringify({
    schema: SCHEMA, revision: 3, groups: [GROUP('keep', '保留', 1, [{ provider: '*', model: '*' }])],
  }, null, 2), 'utf8');
  writeFileSync(uiPath, '{ this is not json', 'utf8');
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, uiFile: uiPath, cacheTtlMs: 0 });
  const ui = await callRoute(harness.routes, '/dsh-model-groups/ui');
  assert.equal(ui.status, 200);
  assert.deepEqual(ui.json.collapsed, [], '坏文件按「全部展开」');
  assert.ok(String(ui.json.warning).includes('折叠状态文件不可用'), ui.json.warning);
  const state = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.equal(state.json.groups.length, 1, '分组本体照常');
  assert.equal(handle.service.resolve('x', 'y').groupId, 'keep');
  // 坏文件下的写入是自愈的：先前的坏内容被一份合法文件替换
  const healed = await callRoute(harness.routes, '/dsh-model-groups/ui', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collapsed: ['keep'] }),
  });
  assert.equal(healed.status, 200, healed.body);
  assert.deepEqual(JSON.parse(readFileSync(uiPath, 'utf8')).collapsed, ['keep']);
  harness.disposeAll();
});

await test('并发写：两次覆盖写不互相破坏（原子 tmp+rename，revision 不回退）', async () => {
  rmSync(uiPath, { force: true });
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, uiFile: uiPath, cacheTtlMs: 0 });
  const post = (collapsed) => callRoute(harness.routes, '/dsh-model-groups/ui', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collapsed }),
  });
  const first = post(['a']);
  const second = post(['b', 'c']);
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  const onDisk = JSON.parse(readFileSync(uiPath, 'utf8'));
  assert.ok(Array.isArray(onDisk.collapsed), '落盘文件必须始终是可解析的完整 JSON');
  assert.deepEqual(onDisk.collapsed.slice().sort(), ['b', 'c'].sort(), '后写入者胜（覆盖写语义）');
  assert.ok(two.json.revision > one.json.revision, 'revision 单调递增');
  harness.disposeAll();
  rmSync(uiPath, { force: true });
});

/* ------------------------------------ G 折叠状态的可靠性回归（ui-2 修复） --- */

section('G 折叠状态可靠性（目录创建 / 回滚护栏 / revision / 回包体积）');

await test('H11 有界目录创建：procfs 这类路径必须**立刻抛错**，不能占死事件循环', async () => {
  // Node v22.23.3 实测：mkdirSync('/proc/<缺失>/x', {recursive:true}) 永不返回，
  // 同步调用会把整个 DSH（GUI + 会话）冻住。这里用子进程 + 超时把这条钉死。
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync(process.execPath, ['-e', `
    import(${JSON.stringify(new URL('./index.js', import.meta.url).href)}).then((mod) => {
      const started = Date.now();
      try { mod.ensureDirSync('/proc/mg-selftest-missing-dir'); process.stdout.write('NO-THROW'); }
      catch (error) { process.stdout.write('THREW:' + (error.code || 'none') + ':' + (Date.now() - started)); }
    });
  `], { timeout: 5000, encoding: 'utf8' });
  assert.equal(probe.signal, null, '子进程必须自己退出（超时被杀 = 又回到会冻住进程的实现）');
  assert.ok(String(probe.stdout).startsWith('THREW:'), '必须抛错而不是静默返回：' + probe.stdout + probe.stderr);
  assert.ok(Number(String(probe.stdout).split(':')[2]) < 1000, '必须在毫秒级失败：' + probe.stdout);
  // 正常路径照旧：多级目录一次建出来
  const deep = join(root, 'a', 'b', 'c');
  const { ensureDirSync } = await import('./index.js');
  ensureDirSync(deep);
  assert.equal(statSync(deep).isDirectory(), true);
});

await test('H12 uiFile 配成与分组文件同一路径时：告警 + 退回缺省派生路径（绝不写坏分组本体）', async () => {
  rmSync(uiPath, { force: true });
  writeFileSync(statePath, JSON.stringify({
    schema: SCHEMA, revision: 1, groups: [GROUP('keep', '保留', 1, [{ provider: '*', model: '*' }])],
  }, null, 2), 'utf8');
  const before = readFileSync(statePath, 'utf8');
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, uiFile: statePath, cacheTtlMs: 0 });
  assert.equal(handle.uiPath, uiPath, '退回 file 的 dirname 下的缺省 ui 文件');
  assert.ok(harness.warnings.some((text) => text.includes('同一路径')), JSON.stringify(harness.warnings));
  const posted = await callRoute(harness.routes, '/dsh-model-groups/ui', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collapsed: ['keep'] }),
  });
  assert.equal(posted.status, 200, posted.body);
  assert.equal(readFileSync(statePath, 'utf8'), before, '分组本体必须逐字节不变');
  assert.deepEqual(JSON.parse(readFileSync(uiPath, 'utf8')).collapsed, ['keep']);
  harness.disposeAll();
  rmSync(uiPath, { force: true });
});

await test('H13 revision 单调不减：外部把文件改小 / 删掉后，GET 也不回退', async () => {
  rmSync(uiPath, { force: true });
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, uiFile: uiPath, cacheTtlMs: 0 });
  const post = (collapsed) => callRoute(harness.routes, '/dsh-model-groups/ui', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collapsed }),
  });
  await post(['a']);
  await post(['a', 'b']);
  const high = (await callRoute(harness.routes, '/dsh-model-groups/ui')).json.revision;
  assert.ok(high >= 2, 'POST 之后 revision 至少 2：' + high);
  // 外部改写（手改 / 回滚 / 别的工具）：文件 revision 归零
  writeFileSync(uiPath, JSON.stringify({ schema: 1, revision: 0, collapsed: ['a'] }), 'utf8');
  const afterRewrite = (await callRoute(harness.routes, '/dsh-model-groups/ui')).json.revision;
  assert.ok(afterRewrite >= high, `外部改写后 GET 不得回落（${afterRewrite} < ${high}）`);
  const state = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.ok(state.json.ui.revision >= high, '/state.ui.revision 与 GET /ui 同一口径');
  // 文件被删掉也一样
  rmSync(uiPath, { force: true });
  const afterDelete = (await callRoute(harness.routes, '/dsh-model-groups/ui')).json.revision;
  assert.ok(afterDelete >= high, '删文件后也不得回落');
  const bumped = await post(['c']);
  assert.ok(bumped.json.revision > afterDelete, '继续写仍然单调递增');
  harness.disposeAll();
  rmSync(uiPath, { force: true });
});

await test('H14 写失败（rename 撞目录）→ 500 且不留 .tmp-* 垃圾文件', async () => {
  rmSync(uiPath, { force: true });
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, uiFile: uiPath, cacheTtlMs: 0 });
  const { mkdirSync, readdirSync } = await import('node:fs');
  mkdirSync(uiPath);                                  // 目标路径被占成目录 → rename EISDIR
  try {
    const failed = await callRoute(harness.routes, '/dsh-model-groups/ui', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collapsed: ['a'] }),
    });
    assert.equal(failed.status, 500, failed.body);
    assert.ok(String(failed.json.error).includes('折叠状态写入失败'), failed.body);
    const leftovers = readdirSync(root).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], '失败后必须清掉自己写的 tmp 文件：' + JSON.stringify(leftovers));
  } finally {
    rmSync(uiPath, { recursive: true, force: true });
  }
  harness.disposeAll();
});

await test('H15 回包体积有界：上万坏项只回前 20 条 + 总数（落盘内容不受影响）', async () => {
  rmSync(uiPath, { force: true });
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, uiFile: uiPath, cacheTtlMs: 0 });
  const bad = Array.from({ length: 5000 }, (_, at) => 'Bad Id ' + at);
  const posted = await callRoute(harness.routes, '/dsh-model-groups/ui', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collapsed: bad.concat(['ok']) }),
  });
  assert.equal(posted.status, 200);
  assert.equal(posted.json.issues.length, 20, '回包 issues 截断到 20 条');
  assert.equal(posted.json.issueCount, bad.length, '总数照实回报');
  assert.ok(posted.body.length < 4096, '回包必须远小于请求体：' + posted.body.length);
  assert.deepEqual(posted.json.collapsed, ['ok']);
  assert.deepEqual(JSON.parse(readFileSync(uiPath, 'utf8')).collapsed, ['ok'], '落盘内容不受回包截断影响');
  harness.disposeAll();
  rmSync(uiPath, { force: true });
});

await test('H16 /state 内联 ui 也带 warning / issues（客户端只读 /state，否则坏了也看不见）', async () => {
  writeFileSync(uiPath, '{ 坏文件', 'utf8');
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, uiFile: uiPath, cacheTtlMs: 0 });
  const state = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.ok(String(state.json.ui.warning).includes('折叠状态文件不可用'), JSON.stringify(state.json.ui));
  assert.deepEqual(state.json.ui.issues, []);
  // 元素级问题同样内联（超长项被丢时，页面能说出原因）
  writeFileSync(uiPath, JSON.stringify({ schema: 1, revision: 1, collapsed: ['ok', 'x'.repeat(80)] }), 'utf8');
  const state2 = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.equal(state2.json.ui.issues.length, 1, JSON.stringify(state2.json.ui));
  assert.equal(state2.json.ui.issueCount, 1);
  assert.deepEqual(state2.json.ui.collapsed, ['ok']);
  harness.disposeAll();
});

await test('H17 /state 回报 impl（index.js?v=…）：build 分不清 entry/?v 标记，这个能', async () => {
  const harness = fakeCtx();
  createModelGroups(harness.ctx, { file: statePath, uiFile: uiPath, cacheTtlMs: 0 });
  const state = await callRoute(harness.routes, '/dsh-model-groups/state');
  assert.equal(state.json.build, BUILD, 'build 仍是本文件的构建标记');
  assert.ok(String(state.json.impl).startsWith('index.js'), 'impl 指向真实模块：' + state.json.impl);
  harness.disposeAll();
});

await test('H18 落盘失败不消耗 revision（先写后提交：号与内容永远对得上）', async () => {
  rmSync(uiPath, { force: true });
  const harness = fakeCtx();
  const handle = createModelGroups(harness.ctx, { file: statePath, uiFile: uiPath, cacheTtlMs: 0 });
  const post = (collapsed) => callRoute(harness.routes, '/dsh-model-groups/ui', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collapsed }),
  });
  const first = await post(['a']);
  const before = handle.uiRevision;
  assert.equal(first.json.revision, before);
  const { mkdirSync } = await import('node:fs');
  rmSync(uiPath, { force: true });
  mkdirSync(uiPath);                                  // 目标被占成目录 → 本次写盘必失败
  try {
    const failed = await post(['b']);
    assert.equal(failed.status, 500, failed.body);
    assert.equal(handle.uiRevision, before, '写失败不得推进进程内计数器');
    const read = await callRoute(harness.routes, '/dsh-model-groups/ui');
    assert.equal(read.json.revision, before, 'GET 不得报一个从未落盘的号');
  } finally {
    rmSync(uiPath, { recursive: true, force: true });
  }
  const recovered = await post(['c']);
  assert.equal(recovered.json.revision, before + 1, '失败没有烧掉号：下一次成功写正好接上');
  assert.deepEqual(JSON.parse(readFileSync(uiPath, 'utf8')).collapsed, ['c']);
  harness.disposeAll();
  rmSync(uiPath, { force: true });
});

/* ------------------------------------------------------------- 收尾 ---- */

rmSync(root, { recursive: true, force: true });

process.stdout.write('\n');
if (failures.length > 0) {
  process.stdout.write(`\n失败 ${failures.length} 项：\n`);
  for (const failure of failures) {
    process.stdout.write(`  ✗ ${failure.name}\n    ${failure.error && failure.error.stack ? failure.error.stack.split('\n').slice(0, 4).join('\n    ') : failure.error}\n`);
  }
  process.stdout.write(`SELFTEST FAIL (${passed} passed, ${failures.length} failed)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`SELFTEST PASS (${passed} assertions groups)\n`);
}
