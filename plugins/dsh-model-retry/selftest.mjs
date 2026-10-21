/**
 * dsh-model-retry host 半边自测（无 Cordis、无 dsh 进程）。
 *
 *   node plugins/dsh-model-retry/selftest.mjs
 *
 * A 规则打分与优先级（含与 v1 的**逐项等价性**随机对照）
 * B 分组集成（group 选择器、GET /rules 目录与告警、POST 归一化）
 * C 试算路由 POST /preview
 * D 端到端恢复决策（waterfall 监听器 + 预算折叠的 policyKey 稳定性）
 * E 坏输入与请求体加固回归（R1 坏条目归一化 / R2 形状非法不静默 /
 *   R3 超限先回 413 / R4 写入路由 Origin 口径）
 *
 * 安全：本测试全程把 DSH_HOME 指向临时目录。跑之前会断言这一点——
 * 绝不能碰到真实的 ~/.dsh/model-retry-rules.json。
 *
 * 末行 SELFTEST PASS 才算过。
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// ---- 先把 DSH_HOME 指到临时目录，再导入被测模块 ----
const root = mkdtempSync(join(tmpdir(), 'dsh-model-retry-selftest-'));
process.env.DSH_HOME = root;
const RULES_FILE = join(root, 'model-retry-rules.json');
assert.ok(process.env.DSH_HOME.startsWith(tmpdir()), 'DSH_HOME 必须已被指向临时目录');
assert.ok(!existsSync('/root/.dsh/model-retry-rules.json') || RULES_FILE !== '/root/.dsh/model-retry-rules.json');

const retry = await import('./entry-v2.js');
const { apply, matchRule, scoreOf, groupSelectorOf, normalizeRuleEntry, KNOWN_CODES, inject } = retry;

/* --------------------------------------------------------------- runner ---- */

let passed = 0;
let skipped = 0;
const failures = [];
/** SELFTEST_ONLY=子串 只跑名字里含该子串的用例（排查用）。 */
const ONLY = process.env.SELFTEST_ONLY;
async function test(name, fn) {
  const filters = ONLY === undefined || ONLY === '' ? null : ONLY.split(',');
  if (filters !== null && !filters.some((part) => name.includes(part))) { skipped++; return; }
  try { await fn(); passed++; process.stdout.write('.'); }
  catch (error) { failures.push({ name, error }); process.stdout.write('x'); }
}
const section = (title) => process.stdout.write(`\n${title}\n  `);

/* ------------------------------------------------------------- 假 Cordis ---- */

function makeReq({ method = 'GET', url = '/', headers = {}, body = null, errorAfter = false } = {}) {
  const listeners = new Map();
  const events = [];
  const req = {
    method, url, headers, events,
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); return req; },
    removeListener(type, fn) {
      const list = listeners.get(type);
      if (list !== undefined) { const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); }
      return req;
    },
    // 记录顺序：R3 回归要断言「先写完响应再收连接」（不得先 destroy）。
    pause() { events.push('req.pause'); },
    resume() { events.push('req.resume'); },
    destroy() { events.push('req.destroy'); },
  };
  setImmediate(() => {
    if (body !== null) for (const fn of [...(listeners.get('data') || [])]) fn(Buffer.from(body, 'utf8'));
    if (errorAfter === true) {
      for (const fn of [...(listeners.get('error') || [])]) fn(new Error('transport boom'));
      return;
    }
    for (const fn of [...(listeners.get('end') || [])]) fn();
  });
  return req;
}
function makeRes() {
  const listeners = new Map();
  const res = {
    status: 0, headers: null, body: '', done: false, events: [],
    writeHead(status, headers) { res.status = status; res.headers = headers; res.events.push('res.writeHead'); },
    once(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); return res; },
    end(text) {
      res.body = text === undefined || text === null ? '' : String(text);
      res.done = true;
      res.events.push('res.end');
      for (const fn of [...(listeners.get('finish') || [])]) fn();
    },
  };
  return res;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function callRoute(routes, path, options = {}) {
  const route = routes.find((item) => item.path === path);
  assert.ok(route !== undefined, `路由不存在: ${path}`);
  const req = makeReq(Object.assign({ url: path }, options));
  const res = makeRes();
  await route.handler(req, res);
  // 必须用真实定时器等待：只用 setImmediate 空转会让事件循环的 poll 阶段变成非阻塞，
  // 异步 fs 写入（atomicWriteJson）等不到完成，响应就会「超时」——这正是本测试曾经的假阴性。
  const deadline = Date.now() + 3000;
  while (!res.done && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(res.done, `路由 ${path} 未结束响应`);
  let json = null;
  try { json = JSON.parse(res.body); } catch { json = null; }
  // res/req 一并返回：E 段要断言响应头与「先响应后收连接」的事件顺序。
  return { status: res.status, json, body: res.body, res, req };
}

/** 假分组服务（dsh-model-groups 的公开面）。 */
function fakeGroups(groups, routes = []) {
  return {
    list: () => groups.map((group) => Object.assign({ enabled: true, priority: 100, order: 1, members: [] }, group)),
    resolve: (provider, model) => {
      const hit = routes.find((row) => row.provider === provider && row.model === model);
      return hit === undefined ? null : { groupId: hit.groupId, groupName: hit.groupId, order: 1, member: { provider, model } };
    },
  };
}

function fakeCtx(options = {}) {
  const routes = [];
  const events = new Map();
  const projections = [];
  const effects = [];
  const warnings = [];
  const appended = [];
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1); }; } },
    sessionProjections: {
      register(projection) { projections.push(projection); return () => {}; },
      stateOf: (session, key) => (typeof options.stateOf === 'function'
        ? options.stateOf(session, key)
        : (options.projectionState === undefined ? {} : options.projectionState)),
    },
    on(event, handler) { if (!events.has(event)) events.set(event, []); events.get(event).push(handler); return () => {}; },
    effect(fn, label) { effects.push({ label, dispose: fn() }); return () => {}; },
    get(name) {
      if (name !== 'modelGroups') return undefined;
      return options.groups === undefined ? undefined : options.groups;
    },
    logger: { warn: (text) => warnings.push(String(text)) },
  };
  return {
    ctx, routes, events, projections, effects, warnings, appended,
    disposeAll: () => { for (const entry of effects) if (typeof entry.dispose === 'function') entry.dispose(); },
  };
}

/** 造一个 waterfall 失败载荷 + next。 */
function failurePayload({ provider = 'localhost', model = 'm', code = 'RATE_LIMIT', status = 429, retryPolicy = { mode: 'normal' }, next = null } = {}) {
  const session = {
    appended: [],
    append(type, data) { session.appended.push({ type, data }); },
    requestHeader: () => ({ config: { model } }),
  };
  const payload = {
    agent: { session },
    turn: 1,
    step: 1,
    provider,
    failure: { code, status },
    retryPolicy,
    signal: new AbortController().signal,
  };
  return { payload, session, next: next === null ? (() => { throw new Error('downstream 不应被调用'); }) : next };
}

const writeRules = (rules) => writeFileSync(RULES_FILE, JSON.stringify({ rules }, null, 2), 'utf8');
const readRulesFile = () => JSON.parse(readFileSync(RULES_FILE, 'utf8')).rules;

/* ================================================================= A ====== */

section('A 规则打分与优先级');

await test('权重表：0/2/3/4/5/7 与「写了就必须命中」', () => {
  const groupId = 'free';
  assert.equal(scoreOf({ mode: 'always' }, 'p', 'm', groupId), 0, '全通配');
  assert.equal(scoreOf({ mode: 'always', provider: 'p' }, 'p', 'm', groupId), 2);
  assert.equal(scoreOf({ mode: 'always', model: 'm' }, 'p', 'm', groupId), 2);
  assert.equal(scoreOf({ mode: 'always', group: groupId }, 'p', 'm', groupId), 3);
  assert.equal(scoreOf({ mode: 'always', provider: 'p', model: 'm' }, 'p', 'm', groupId), 4);
  assert.equal(scoreOf({ mode: 'always', group: groupId, provider: 'p' }, 'p', 'm', groupId), 5);
  assert.equal(scoreOf({ mode: 'always', group: groupId, model: 'm' }, 'p', 'm', groupId), 5);
  assert.equal(scoreOf({ mode: 'always', group: groupId, provider: 'p', model: 'm' }, 'p', 'm', groupId), 7);
  assert.equal(scoreOf({ mode: 'always', provider: 'other' }, 'p', 'm', groupId), -1);
  assert.equal(scoreOf({ mode: 'always', model: 'other' }, 'p', 'm', groupId), -1);
  assert.equal(scoreOf({ mode: 'always', group: 'other' }, 'p', 'm', groupId), -1);
  assert.equal(scoreOf({ mode: 'always', group: groupId }, 'p', 'm', null), -1, '无组归属时 group 规则不命中');
  assert.equal(scoreOf({ mode: 'always', provider: '*', model: '*', group: '*' }, 'p', 'm', null), 0, '`*` = 不限制');
});

await test('关键保护：只按组的规则 (3) 不会盖掉已有的单路由精确规则 (4)', () => {
  const existing = { provider: 'localhost', model: 'deepseek-ai/deepseek-v4.1-flash', mode: 'normal', maxRetries: 9 };
  const groupRule = { group: 'nv', mode: 'always' };
  assert.equal(matchRule([existing, groupRule], 'localhost', 'deepseek-ai/deepseek-v4.1-flash', 'nv'), existing);
  // 组规则显式钉上 provider/model（更窄）时才反过来优先
  const pinned = { group: 'nv', provider: 'localhost', model: 'deepseek-ai/deepseek-v4.1-flash', mode: 'normal', maxRetries: 1 };
  assert.equal(matchRule([existing, pinned], 'localhost', 'deepseek-ai/deepseek-v4.1-flash', 'nv'), pinned);
});

await test('优先级实测：精确 (provider, model) > 组 > provider 通配 > 全通配', () => {
  const rules = [
    { provider: '*', model: '*', mode: 'normal', maxRetries: 1 },
    { provider: 'localhost', mode: 'normal', maxRetries: 2 },
    { group: 'free', mode: 'always' },
    { provider: 'localhost', model: 'x', mode: 'normal', maxRetries: 3 },
  ];
  assert.equal(matchRule(rules, 'localhost', 'x', 'free').maxRetries, 3);
  assert.equal(matchRule(rules, 'localhost', 'y', 'free').mode, 'always');
  assert.equal(matchRule(rules, 'localhost', 'y', null).maxRetries, 2);
  assert.equal(matchRule(rules, 'other', 'y', null).maxRetries, 1);
});

await test('同分取文件中靠前者（严格 > 保持 v1 行为）', () => {
  const rules = [
    { provider: 'localhost', mode: 'normal', maxRetries: 1 },
    { provider: 'localhost', mode: 'always' },
  ];
  assert.equal(matchRule(rules, 'localhost', 'm', null).maxRetries, 1);
  assert.equal(matchRule([], 'localhost', 'm', null), null);
});

await test('group 选择器归一：空/`*`/空白 → 不限制', () => {
  assert.equal(groupSelectorOf('free'), 'free');
  assert.equal(groupSelectorOf(' free '), 'free');
  assert.equal(groupSelectorOf('*'), null);
  assert.equal(groupSelectorOf(''), null);
  assert.equal(groupSelectorOf('   '), null);
  assert.equal(groupSelectorOf(undefined), null);
  assert.equal(groupSelectorOf(42), null);
});

await test('与 v1 逐项等价：700 组随机规则无 group 时选择结果完全相同', () => {
  // v1 参考实现（原文照抄的算法）
  const v1 = (rules, provider, model) => {
    let best = null; let bestScore = -1;
    for (const rule of rules) {
      const ruleProvider = typeof rule.provider === 'string' && rule.provider !== '' && rule.provider !== '*' ? rule.provider : null;
      const ruleModel = typeof rule.model === 'string' && rule.model !== '' && rule.model !== '*' ? rule.model : null;
      if (ruleProvider !== null && ruleProvider !== provider) continue;
      if (ruleModel !== null && ruleModel !== model) continue;
      const score = (ruleProvider !== null ? 2 : 0) + (ruleModel !== null ? 2 : 0);
      if (score > bestScore) { best = rule; bestScore = score; }
    }
    return best;
  };
  let seed = 20261008;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const providers = ['localhost', 'our-free-model', '*', 'ms'];
  const models = ['a', 'b', 'x/y:free', '*', ''];
  let compared = 0;
  for (let round = 0; round < 700; round += 1) {
    const rules = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, at) => {
      const rule = { mode: rnd() < 0.5 ? 'normal' : 'always', tag: at };
      if (rnd() < 0.8) rule.provider = pick(providers);
      if (rnd() < 0.8) rule.model = pick(models);
      return rule;
    });
    const provider = pick(['localhost', 'our-free-model', 'ms', 'ghost']);
    const model = pick(['a', 'b', 'x/y:free', 'zzz']);
    const expected = v1(rules, provider, model);
    const actual = matchRule(rules, provider, model, null);
    assert.equal(actual === null ? null : actual.tag, expected === null ? null : expected.tag,
      `round ${round}: ${JSON.stringify({ rules, provider, model })}`);
    compared += 1;
  }
  assert.equal(compared, 700);
  // 无 group 的规则在给了 groupId 时也不受影响
  const plain = [{ provider: 'localhost', mode: 'normal', tag: 0 }];
  assert.equal(matchRule(plain, 'localhost', 'm', 'free').tag, 0);
});

await test('导出面保持 v1 形状（inject / KNOWN_CODES / apply）', () => {
  assert.deepEqual(inject, ['sessionProjections', 'webServer']);
  assert.ok(KNOWN_CODES.includes('RATE_LIMIT'));
  assert.equal(typeof apply, 'function');
});

/* ================================================================= B ====== */

section('B 分组集成');

await test('GET /rules：带分组目录与可用性标记', async () => {
  writeRules([{ provider: 'localhost', model: '*', mode: 'always' }]);
  const harness = fakeCtx({
    groups: fakeGroups([{ id: 'free', name: '免费车道' }, { id: 'nv', name: 'NVIDIA' }], [{ provider: 'our-free-model', model: 'kimi-k3', groupId: 'free' }]),
  });
  apply(harness.ctx);
  const response = await callRoute(harness.routes, '/dsh-model-retry/rules');
  assert.equal(response.status, 200);
  assert.equal(response.json.groupsAvailable, true);
  assert.deepEqual(response.json.groups.map((group) => group.id), ['free', 'nv']);
  assert.deepEqual(response.json.warnings, []);
  assert.equal(response.json.defaults.maxRetries, 5);
  assert.ok(response.json.knownCodes.includes('EMPTY_RESPONSE'));
  harness.disposeAll();
});

await test('分组插件不在线：group 规则不命中（退回适配器策略），GET /rules 明确告警', async () => {
  writeRules([{ group: 'free', mode: 'always' }]);
  const harness = fakeCtx({ groups: undefined });
  apply(harness.ctx);
  const response = await callRoute(harness.routes, '/dsh-model-retry/rules');
  assert.equal(response.json.groupsAvailable, false);
  assert.ok(response.json.warnings.some((text) => text.includes('dsh-model-groups')));
  const run = failurePayload({ provider: 'our-free-model', model: 'kimi-k3', retryPolicy: { mode: 'normal', maxRetries: 4 } });
  await harness.events.get('agent/request-error')[0](run.payload, run.next);
  assert.equal(run.session.appended[0].data.mode, 'normal', 'always 组规则不应生效');
  assert.equal(run.session.appended[0].data.maxRetries, 4, '应完整落到适配器策略');
  harness.disposeAll();
});

await test('规则引用了不存在的组 / 已停用的组 → 告警', async () => {
  writeRules([{ group: 'ghost', mode: 'always' }, { group: 'nv', mode: 'always' }]);
  const harness = fakeCtx({ groups: fakeGroups([{ id: 'nv', name: 'NVIDIA', enabled: false }, { id: 'free', name: '免费' }]) });
  apply(harness.ctx);
  const response = await callRoute(harness.routes, '/dsh-model-retry/rules');
  assert.ok(response.json.warnings.some((text) => text.includes('ghost') && text.includes('不存在')));
  assert.ok(response.json.warnings.some((text) => text.includes('nv') && text.includes('停用')));
  harness.disposeAll();
});

await test('POST /rules：group 字段被保留；`*`/空 group 被剔除', async () => {
  rmSync(RULES_FILE, { force: true });
  const harness = fakeCtx({ groups: fakeGroups([{ id: 'free', name: '免费' }]) });
  apply(harness.ctx);
  const posted = await callRoute(harness.routes, '/dsh-model-retry/rules', {
    method: 'POST',
    body: JSON.stringify({
      rules: [
        { group: 'free', mode: 'always' },
        { provider: 'localhost', model: '*', group: '*', mode: 'normal', maxRetries: 2 },
        { provider: 'ms', model: 'x', group: '', mode: 'normal' },
        { group: 'free', provider: '*', mode: 'normal', retryableCodes: ['RATE_LIMIT', 'RATE_LIMIT'] },
      ],
    }),
  });
  assert.equal(posted.status, 200, posted.body);
  const onDisk = readRulesFile();
  assert.equal(onDisk[0].group, 'free');
  assert.equal(onDisk[1].group, undefined, '`*` group 应整字段丢弃');
  assert.equal(onDisk[2].group, undefined, '空 group 应整字段丢弃');
  assert.deepEqual(onDisk[3].retryableCodes, ['RATE_LIMIT'], '重复项应去重');
  assert.equal(onDisk[1].provider, 'localhost');
  // 且校验仍然严格
  const rejected = await callRoute(harness.routes, '/dsh-model-retry/rules', {
    method: 'POST', body: JSON.stringify({ rules: [{ mode: 'nope' }] }),
  });
  assert.equal(rejected.status, 400);
  harness.disposeAll();
});

/* ================================================================= C ====== */

section('C 试算路由');

await test('POST /preview：命中规则 + 组 + 策略 + 打分明细', async () => {
  writeRules([
    { provider: '*', model: '*', mode: 'normal', maxRetries: 5, tag: 'fallback' },
    { group: 'free', mode: 'always', tag: 'group' },
    { provider: 'localhost', model: 'exact', mode: 'normal', maxRetries: 1, tag: 'exact' },
  ]);
  const harness = fakeCtx({
    groups: fakeGroups([{ id: 'free', name: '免费车道' }], [{ provider: 'our-free-model', model: 'kimi-k3', groupId: 'free' }]),
  });
  apply(harness.ctx);

  const inGroup = await callRoute(harness.routes, '/dsh-model-retry/preview', {
    method: 'POST', body: JSON.stringify({ provider: 'our-free-model', model: 'kimi-k3' }),
  });
  assert.equal(inGroup.status, 200, inGroup.body);
  assert.equal(inGroup.json.groupId, 'free');
  assert.equal(inGroup.json.groupName, '免费车道');
  assert.equal(inGroup.json.ruleIndex, 1);
  assert.equal(inGroup.json.policy.mode, 'always');
  assert.equal(inGroup.json.source, 'rule');
  assert.deepEqual(inGroup.json.scores.map((row) => row.score), [0, 3, -1], '逐条打分应与分数一致');
  assert.equal(inGroup.json.rule.tag, 'group');

  const exact = await callRoute(harness.routes, '/dsh-model-retry/preview', {
    method: 'POST', body: JSON.stringify({ provider: 'localhost', model: 'exact' }),
  });
  assert.equal(exact.json.rule.tag, 'exact', '精确规则压过组策略');
  assert.equal(exact.json.groupId, null);

  // 全通配兜底规则命中一切（score 0）
  const fallback = await callRoute(harness.routes, '/dsh-model-retry/preview', {
    method: 'POST', body: JSON.stringify({ provider: 'ghost', model: 'zzz' }),
  });
  assert.equal(fallback.json.rule.tag, 'fallback');
  assert.equal(fallback.json.ruleIndex, 0);
  assert.equal(fallback.json.source, 'rule');

  // 规则集里一条都不命中 → 展示适配器缺省（不写规则时的真实行为）
  writeRules([{ group: 'free', mode: 'always' }]);
  const none = await callRoute(harness.routes, '/dsh-model-retry/preview', {
    method: 'POST', body: JSON.stringify({ provider: 'ghost', model: 'zzz' }),
  });
  assert.equal(none.json.rule, null);
  assert.equal(none.json.ruleIndex, -1);
  assert.equal(none.json.source, 'adapter-default');
  assert.equal(none.json.policy.maxRetries, 5, '展示出厂缺省');
  assert.deepEqual(none.json.policy.retryableCodes, [...KNOWN_CODES.slice(0, 5)]);

  const bad = await callRoute(harness.routes, '/dsh-model-retry/preview', { method: 'POST', body: '{}' });
  assert.equal(bad.status, 400);
  const wrongMethod = await callRoute(harness.routes, '/dsh-model-retry/preview', { method: 'GET' });
  assert.equal(wrongMethod.status, 405);
  harness.disposeAll();
});

/* ================================================================= D ====== */

section('D 端到端恢复决策');

await test('组规则生效：整组模型走同一套策略，policyKey 在重复失败间稳定', async () => {
  writeRules([{ group: 'free', mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } }]);
  const harness = fakeCtx({
    groups: fakeGroups([{ id: 'free', name: '免费' }], [
      { provider: 'our-free-model', model: 'kimi-k3', groupId: 'free' },
      { provider: 'localhost', model: 'qwen/qwen3.8-27b:free', groupId: 'free' },
    ]),
  });
  apply(harness.ctx);
  const listener = harness.events.get('agent/request-error')[0];
  assert.equal(typeof listener, 'function');

  const first = failurePayload({ provider: 'our-free-model', model: 'kimi-k3' });
  const decision = await listener(first.payload, first.next);
  assert.deepEqual(decision, { kind: 'retry' });
  assert.deepEqual(first.session.appended.map((row) => row.type), ['llm/retry', 'llm/retry-started']);
  assert.equal(first.session.appended[0].data.mode, 'always');
  assert.equal(first.session.appended[0].data.provider, 'our-free-model');
  assert.equal(typeof first.session.appended[0].data.model, 'string', 'durable 事件必须带 model（投影以此识别本插件的重试）');
  assert.equal(first.session.appended[0].data.retry, 1);

  // 同一组的另一个 (provider, model) —— 策略相同，但投影键不同
  const second = failurePayload({ provider: 'localhost', model: 'qwen/qwen3.8-27b:free' });
  await listener(second.payload, second.next);
  assert.equal(second.session.appended[0].data.mode, 'always');

  // 同一路由重复失败：policyKey 必须一致（否则预算永不耗尽 → 重试风暴）
  const again = failurePayload({ provider: 'our-free-model', model: 'kimi-k3' });
  await listener(again.payload, again.next);
  assert.equal(again.session.appended[0].data.policyKey, first.session.appended[0].data.policyKey);

  // 组外模型：落到适配器缺省（RATE_LIMIT 可重试，normal 模式）
  const outside = failurePayload({ provider: 'ghost', model: 'zzz' });
  await listener(outside.payload, outside.next);
  assert.equal(outside.session.appended[0].data.mode, 'normal');
  harness.disposeAll();
});

await test('normal 模式预算：组规则 maxRetries=2 时第 3 次失败交还下游', async () => {
  writeRules([{ group: 'free', mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } }]);
  const groups = fakeGroups([{ id: 'free', name: '免费' }], [{ provider: 'our-free-model', model: 'kimi-k3', groupId: 'free' }]);
  let projection = {};
  const harness = fakeCtx({ groups, stateOf: () => projection });
  apply(harness.ctx);
  const listener = harness.events.get('agent/request-error')[0];

  const first = failurePayload({ provider: 'our-free-model', model: 'kimi-k3' });
  assert.deepEqual(await listener(first.payload, first.next), { kind: 'retry' });
  assert.equal(first.session.appended[0].data.retry, 1);
  assert.equal(first.session.appended[0].data.maxRetries, 2);
  const policyKey = first.session.appended[0].data.policyKey;
  const stateKey = JSON.stringify(['our-free-model', 'kimi-k3', policyKey]);

  projection = { [stateKey]: { retry: 1, retryId: 'r' } };
  const second = failurePayload({ provider: 'our-free-model', model: 'kimi-k3' });
  assert.deepEqual(await listener(second.payload, second.next), { kind: 'retry' });
  assert.equal(second.session.appended[0].data.retry, 2);
  assert.equal(second.session.appended[0].data.retryId, 'r', '同一预算链沿用同一 retryId');

  projection = { [stateKey]: { retry: 2, retryId: 'r' } };
  let downstream = 0;
  const third = failurePayload({ provider: 'our-free-model', model: 'kimi-k3', next: () => { downstream += 1; return undefined; } });
  assert.equal(await listener(third.payload, third.next), undefined);
  assert.equal(downstream, 1, '预算耗尽应把决定权交还下游');
  assert.equal(third.session.appended.length, 0, '不应再落 llm/retry 事件');
  harness.disposeAll();
});

await test('无规则命中且适配器允可重试：仍按适配器策略重试（行为与停用出厂执行器前一致）', async () => {
  writeRules([{ group: 'free', mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } }]);
  const harness = fakeCtx({ groups: fakeGroups([{ id: 'free', name: '免费' }], []) });
  apply(harness.ctx);
  const listener = harness.events.get('agent/request-error')[0];
  const run = failurePayload({ provider: 'localhost', model: 'plain', retryPolicy: { mode: 'normal', maxRetries: 3, initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } });
  const decision = await listener(run.payload, run.next);
  assert.deepEqual(decision, { kind: 'retry' });
  assert.equal(run.session.appended[0].data.mode, 'normal');
  assert.equal(run.session.appended[0].data.maxRetries, 3, '应取适配器策略的 maxRetries');
  harness.disposeAll();
});

await test('不可重试的失败码 + 未声明状态码 → 交还下游', async () => {
  writeRules([{ group: 'free', mode: 'normal', maxRetries: 3, retryableCodes: ['RATE_LIMIT'] }]);
  const harness = fakeCtx({ groups: fakeGroups([{ id: 'free', name: '免费' }], [{ provider: 'our-free-model', model: 'kimi-k3', groupId: 'free' }]) });
  apply(harness.ctx);
  const listener = harness.events.get('agent/request-error')[0];
  let downstreamCalls = 0;
  const run = failurePayload({ provider: 'our-free-model', model: 'kimi-k3', code: 'INVALID_CREDENTIAL', status: 401, next: () => { downstreamCalls += 1; return { kind: 'retry' }; } });
  await listener(run.payload, run.next);
  assert.equal(downstreamCalls, 1, '应把决定权交还下游');
  assert.equal(run.session.appended.length, 0);

  const listed = failurePayload({ provider: 'our-free-model', model: 'kimi-k3', code: 'SERVER', status: 429, next: () => ({ kind: 'retry' }) });
  writeRules([{ group: 'free', mode: 'normal', maxRetries: 3, retryableCodes: ['RATE_LIMIT'], statusCodes: [429], backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } }]);
  const decision = await listener(listed.payload, listed.next);
  assert.deepEqual(decision, { kind: 'retry' }, '声明了状态码 429 → 可重试');
  harness.disposeAll();
});

await test('分组服务抛异常：记警告并按无组处理，不炸用户轮次', async () => {
  writeRules([{ group: 'free', mode: 'always' }]);
  const broken = { list: () => [], resolve: () => { throw new Error('boom'); } };
  const harness = fakeCtx({ groups: broken });
  apply(harness.ctx);
  const listener = harness.events.get('agent/request-error')[0];
  const run = failurePayload({ provider: 'our-free-model', model: 'kimi-k3', retryPolicy: { mode: 'normal', maxRetries: 2 } });
  const decision = await listener(run.payload, run.next);
  assert.deepEqual(decision, { kind: 'retry' }, '按无组处理 → 退回适配器策略，照常重试');
  assert.equal(run.session.appended[0].data.mode, 'normal', 'always 组规则不应生效');
  assert.ok(harness.warnings.some((text) => text.includes('分组解析失败')));
  harness.disposeAll();
});

await test('sessionProjections 注册形状与 v1 一致（key/stateVersion/stateSchema）', () => {
  const harness = fakeCtx({ groups: fakeGroups([]) });
  apply(harness.ctx);
  assert.equal(harness.projections.length, 1);
  const projection = harness.projections[0];
  assert.equal(projection.key, 'llmRetryModel');
  assert.equal(projection.stateVersion, 1);
  assert.deepEqual(projection.init(), {});
  const folded = projection.apply({}, { type: 'llm/retry', data: { provider: 'p', model: 'm', policyKey: 'k', retry: 1, retryId: 'r1' } });
  assert.deepEqual(Object.values(folded)[0], { retry: 1, retryId: 'r1' });
  assert.deepEqual(projection.apply({ a: 1 }, { type: 'step/start' }), {});
  assert.deepEqual(projection.apply({ a: 1 }, { type: 'turn/end' }), {});
  const state = { a: 1 };
  assert.equal(projection.apply(state, { type: 'llm/retry', data: { provider: 'p' } }), state, '缺 model 的事件不参与折叠');
  harness.disposeAll();
});

await test('dispose：注销监听与路由', () => {
  const harness = fakeCtx({ groups: fakeGroups([]) });
  apply(harness.ctx);
  assert.equal(harness.routes.length, 2);
  harness.disposeAll();
  assert.equal(harness.routes.length, 0);
});

/* ================================================================= E ====== */

section('E 坏输入与请求体加固回归');

await test('规则文件混入 null/数字/字符串条目：读取即归一化剔除并逐条告警，GET /rules 不抛（不再卡「加载中…」）', async () => {
  // 回归 R1：手工写出 {"rules":[null]} 时，旧实现放任 null 流到
  // groupCatalog 的 `rule.group` → TypeError → 真实 webServer 把它变成
  // 无 Content-Type 的空 400 → 设置页 fetchJson 解析失败、永久停在
  // 「加载中…」且没有恢复入口。复现条件：分组服务必须在线。
  writeFileSync(RULES_FILE, JSON.stringify({
    rules: [
      null,                                                                        // 1 非对象
      { provider: 'localhost', model: 'keep', mode: 'always', tag: 'kept' },        // 2 正常
      42,                                                                          // 3 非对象
      'text',                                                                      // 4 非对象
      [],                                                                          // 5 数组（旧实现会被当 score 0 的全局规则）
      { provider: 7, model: null, group: 3, retryableCodes: 'RATE_LIMIT', statusCodes: 429, mode: 'nope', tag: 'repaired' }, // 6 字段类型坏
    ],
  }), 'utf8');
  const harness = fakeCtx({ groups: fakeGroups([{ id: 'free', name: '免费车道' }]) });
  apply(harness.ctx);

  const response = await callRoute(harness.routes, '/dsh-model-retry/rules');
  assert.equal(response.status, 200, '读取必须 200 且带可解析 JSON 体');
  assert.equal(response.res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.json.rules.length, 2, '只有对象条目存活');
  for (const rule of response.json.rules) {
    assert.ok(rule !== null && typeof rule === 'object' && !Array.isArray(rule), '出口只见对象');
  }
  assert.equal(response.json.rules[0].tag, 'kept');
  assert.equal(response.json.rules[1].tag, 'repaired');
  // 逐条告警（1-based 序号 + 实际类型）
  assert.ok(response.json.warnings.some((text) => text.includes('第 1 条') && text.includes('null')), `缺第 1 条告警: ${JSON.stringify(response.json.warnings)}`);
  assert.ok(response.json.warnings.some((text) => text.includes('第 3 条') && text.includes('number')));
  assert.ok(response.json.warnings.some((text) => text.includes('第 4 条') && text.includes('string')));
  assert.ok(response.json.warnings.some((text) => text.includes('第 5 条') && text.includes('数组')));
  assert.equal(response.json.error, undefined, '只是坏条目、文件形状本身合法 → 不应报 error');
  // 坏字段就地摘除 / 归 normal（不抛、也不把脏值带进打分与策略解析）
  const repaired = response.json.rules[1];
  assert.equal(repaired.provider, undefined);
  assert.equal(repaired.model, undefined);
  assert.equal(repaired.group, undefined);
  assert.equal(repaired.retryableCodes, undefined, 'statusCodes/retryableCodes 非数组会在 policyFor 里展开时抛');
  assert.equal(repaired.statusCodes, undefined);
  assert.equal(repaired.mode, 'normal');

  // 试算：同一条读取路径，不抛；只对存活规则打分
  const preview = await callRoute(harness.routes, '/dsh-model-retry/preview', {
    method: 'POST', body: JSON.stringify({ provider: 'localhost', model: 'keep' }),
  });
  assert.equal(preview.status, 200, preview.body);
  assert.equal(preview.json.ruleIndex, 0);
  assert.equal(preview.json.rule.tag, 'kept');
  assert.equal(preview.json.scores.length, 2, '打分只见存活规则');

  // 端到端：坏条目不影响存活规则的命中与恢复决策
  const run = failurePayload({ provider: 'localhost', model: 'keep', retryPolicy: { mode: 'normal', maxRetries: 1 } });
  await harness.events.get('agent/request-error')[0](run.payload, run.next);
  assert.equal(run.session.appended[0].data.mode, 'always', '存活规则照常命中');
  harness.disposeAll();
});

await test('坏条目告警有条数上限：超过 10 条折叠成一行汇总，不把响应刷爆', async () => {
  writeFileSync(RULES_FILE, JSON.stringify({ rules: Array.from({ length: 15 }, () => null) }), 'utf8');
  const harness = fakeCtx({ groups: fakeGroups([]) });
  apply(harness.ctx);
  const response = await callRoute(harness.routes, '/dsh-model-retry/rules');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.rules, []);
  assert.equal(response.json.warnings.length, 11, '10 条逐条 + 1 行汇总');
  assert.ok(response.json.warnings[10].includes('另有 5 条'), response.json.warnings[10]);
  harness.disposeAll();
});

await test('归一化不改变打分：随机脏规则 scoreOf 前后逐项一致（打分/优先级逻辑未被改动）', () => {
  // 硬约束回归：本轮加固只摘除坏字段，不得动打分。
  let seed = 20261008;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const junk = [undefined, null, 0, 7, '', '*', 'p', 'm', 'nope', true, false, [], {}, { a: 1 }];
  let compared = 0;
  for (let round = 0; round < 700; round += 1) {
    const raw = {
      provider: pick(junk), model: pick(junk), group: pick(junk),
      mode: pick(['normal', 'always', 'nope', undefined]),
      retryableCodes: pick(junk), statusCodes: pick(junk), maxRetries: pick(junk), tag: round,
    };
    const normalized = normalizeRuleEntry(raw);
    for (const provider of ['p', 'other']) {
      for (const model of ['m', 'other']) {
        for (const groupId of ['g', null]) {
          const before = scoreOf(raw, provider, model, groupId);
          const after = scoreOf(normalized, provider, model, groupId);
          assert.equal(after, before, `round ${round}: ${JSON.stringify({ raw, provider, model, groupId })}`);
          compared += 1;
        }
      }
    }
  }
  assert.equal(compared, 700 * 8);
  assert.equal(scoreOf(normalizeRuleEntry({ provider: 'p' }), 'p', 'm', null), 2, '正常规则打分不变');
  assert.equal(normalizeRuleEntry({ provider: 'p', tag: 'x' }).tag, 'x', '未知扩展字段原样保留');
});

await test('规则文件形状不合法（根不是对象 / rules 不是数组）：返回空规则集 + error，且不写回文件', async () => {
  // 回归 R2：旧实现把「JSON 合法但形状坏」静默当空规则集（error 与 warnings
  // 都缺失），设置页会按「正常空配置」自动保存 → 覆盖用户文件（数据丢失）。
  const cases = [
    { raw: '{"rules": null}', hint: 'rules' },
    { raw: '[1,2,3]', hint: '根' },
    { raw: '{}', hint: 'rules' },
    { raw: '"nope"', hint: '根' },
    { raw: '{"rules": {"a": 1}}', hint: 'rules' },
  ];
  for (const item of cases) {
    writeFileSync(RULES_FILE, item.raw, 'utf8');
    const harness = fakeCtx({ groups: fakeGroups([{ id: 'free', name: '免费' }]) });
    apply(harness.ctx);
    const response = await callRoute(harness.routes, '/dsh-model-retry/rules');
    assert.equal(response.status, 200, '读取仍然 200（设置页据此才能渲染出东西）');
    assert.deepEqual(response.json.rules, []);
    assert.ok(typeof response.json.error === 'string' && response.json.error !== '', `必须有 error: ${response.body}`);
    assert.ok(response.json.error.includes(item.hint), `error 应指明形状问题: ${response.json.error}`);
    assert.ok(response.json.error.includes('未被改写'), 'error 必须明说文件未被改写');
    assert.ok(response.json.warnings.some((text) => text.includes('未被改写')),
      '同一句话必须进 warnings——设置页只渲染 warnings/error，而当前客户端忽略 error 字段');
    assert.ok(response.json.warnings.some((text) => text.includes('覆盖原文件')), '必须警告「保存会覆盖原文件」');
    assert.equal(readFileSync(RULES_FILE, 'utf8'), item.raw, 'GET 不得写回文件');
    // 保存前用户看得见：试算路由同样带 error，且不抛
    const preview = await callRoute(harness.routes, '/dsh-model-retry/preview', {
      method: 'POST', body: JSON.stringify({ provider: 'p', model: 'm' }),
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.error, response.json.error);
    assert.equal(preview.json.ruleIndex, -1, '坏文件 → 空规则集 → 落到适配器缺省');
    harness.disposeAll();
  }
});

await test('规则文件 JSON 非法：GET /rules 仍 200 且带 error + warning，不静默当空配置', async () => {
  const brokenText = '{"rules": [ { oops }';
  writeFileSync(RULES_FILE, brokenText, 'utf8');
  const harness = fakeCtx({ groups: fakeGroups([]) });
  apply(harness.ctx);
  const response = await callRoute(harness.routes, '/dsh-model-retry/rules');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.rules, []);
  assert.ok(response.json.error.includes('JSON 解析失败'), response.body);
  assert.ok(response.json.warnings.length > 0, 'warnings 是当前设置页唯一会渲染的错误通道');
  assert.equal(readFileSync(RULES_FILE, 'utf8'), brokenText, 'GET 不得写回文件');
  harness.disposeAll();
});

await test('超 256 KiB 的 POST：先完整写出 413 JSON 再排空请求体，绝不先 destroy（onTooLarge 不再是死代码）', async () => {
  // 回归 R3：旧实现一超限就 req.destroy()，socket 连响应一起没了——声明的
  // 400「body 读取失败或过大」永远不会发生（真实 socket 上是 ECONNRESET）。
  rmSync(RULES_FILE, { force: true });
  const harness = fakeCtx({ groups: fakeGroups([]) });
  apply(harness.ctx);
  const oversized = JSON.stringify({ rules: [{ provider: '*', model: '*', mode: 'always' }], pad: 'x'.repeat(300000) });
  const response = await callRoute(harness.routes, '/dsh-model-retry/rules', { method: 'POST', body: oversized });

  assert.equal(response.status, 413, '必须是 413，而不是「连接被重置」');
  assert.equal(response.res.headers['content-type'], 'application/json; charset=utf-8');
  assert.ok(JSON.parse(response.body).error.includes('过大'), `body 必须可解析且说明原因: ${response.body}`);
  const endAt = response.res.events.indexOf('res.end');
  const destroyAt = response.req.events.indexOf('req.destroy');
  assert.ok(endAt >= 0, '必须写出响应');
  assert.ok(destroyAt === -1 || destroyAt > endAt, `不得在响应写出前 destroy: ${JSON.stringify({ req: response.req.events, res: response.res.events })}`);
  assert.ok(response.req.events.includes('req.resume'), '超限后必须排空剩余请求体（否则响应到不了对端）');
  assert.ok(!existsSync(RULES_FILE), '超限请求不得落盘');
  harness.disposeAll();
});

await test('请求体读到一半断流：回 400 JSON「body 读取失败」，同样先写响应再收连接', async () => {
  const harness = fakeCtx({ groups: fakeGroups([]) });
  apply(harness.ctx);
  const response = await callRoute(harness.routes, '/dsh-model-retry/rules', { method: 'POST', body: '{"rules"', errorAfter: true });
  assert.equal(response.status, 400);
  assert.equal(response.res.headers['content-type'], 'application/json; charset=utf-8');
  assert.ok(JSON.parse(response.body).error.includes('body 读取失败'), response.body);
  assert.ok(response.req.events.indexOf('req.destroy') === -1 || response.req.events.indexOf('req.destroy') > response.res.events.indexOf('res.end'));
  harness.disposeAll();
});

await test('真实 http 服务器：300 KiB POST 收到 413 JSON（不是 ECONNRESET），限内请求照常保存', async () => {
  // 回归 R3 的端到端形态：只有真实 socket 才能证明 413 真的到达客户端。
  rmSync(RULES_FILE, { force: true });
  const harness = fakeCtx({ groups: fakeGroups([]) });
  apply(harness.ctx);
  const server = http.createServer((req, res) => {
    const path = String(req.url || '/').split('?')[0];
    const route = harness.routes.find((item) => item.path === path);
    if (route === undefined) { res.writeHead(404); res.end(); return; }
    route.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const post = (payload) => new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1', port, path: '/dsh-model-retry/rules', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ outcome: 'response', status: res.statusCode, contentType: res.headers['content-type'] ?? null, body }));
    });
    request.on('error', (error) => resolve({ outcome: 'socket-error', code: error.code, message: error.message }));
    request.end(payload);
  });
  try {
    const tooLarge = await post(Buffer.from(JSON.stringify({ rules: [], pad: 'x'.repeat(300000) }), 'utf8'));
    assert.equal(tooLarge.outcome, 'response', `超限请求不得以连接重置收场: ${JSON.stringify(tooLarge)}`);
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.contentType, 'application/json; charset=utf-8');
    assert.ok(JSON.parse(tooLarge.body).error.includes('过大'));
    assert.ok(!existsSync(RULES_FILE), '超限请求不得落盘');

    const withinLimit = await post(Buffer.from(JSON.stringify({ rules: [], pad: 'x'.repeat(200000) }), 'utf8'));
    assert.equal(withinLimit.status, 200, `256 KiB 以内应照常保存: ${JSON.stringify(withinLimit)}`);
    assert.deepEqual(readRulesFile(), [], '限内请求正常落盘');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    harness.disposeAll();
  }
});

await test('写入路由 Origin 口径：Origin: null 按外部处理（403），无 Origin 头保持放行', async () => {
  // 回归 R4：旧实现把 `Origin: null` 与「无 Origin 头」同样放行。
  const harness = fakeCtx({ groups: fakeGroups([]) });
  apply(harness.ctx);
  const body = JSON.stringify({ rules: [{ provider: 'p', model: '*', mode: 'always' }] });
  const post = (headers) => callRoute(harness.routes, '/dsh-model-retry/rules', { method: 'POST', headers, body });

  const nullOrigin = await post({ origin: 'null', host: '127.0.0.1:3080' });
  assert.equal(nullOrigin.status, 403, '`Origin: null` 是外部来源（file:// / 沙箱 iframe）→ 拒绝');
  const foreign = await post({ origin: 'http://evil.example', host: '127.0.0.1:3080' });
  assert.equal(foreign.status, 403);
  const noOrigin = await post({ host: '127.0.0.1:3080' });
  assert.equal(noOrigin.status, 200, '无 Origin 头（本机 curl / 同进程）保持放行');
  const sameOrigin = await post({ origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' });
  assert.equal(sameOrigin.status, 200);
  // 试算路由同一守卫；GET（只读）不走守卫，不受影响
  const previewNull = await callRoute(harness.routes, '/dsh-model-retry/preview', {
    method: 'POST', headers: { origin: 'null', host: '127.0.0.1:3080' }, body: JSON.stringify({ provider: 'p', model: 'm' }),
  });
  assert.equal(previewNull.status, 403);
  const get = await callRoute(harness.routes, '/dsh-model-retry/rules', { headers: { origin: 'null', host: '127.0.0.1:3080' } });
  assert.equal(get.status, 200, 'GET /rules 是只读路由，保持无 Origin 守卫');
  harness.disposeAll();
});

await test('读路径限值净化：手改文件里的越界/非数值字段不生效，且逐条告警', async () => {
  const harness = fakeCtx({ groups: undefined });
  apply(harness.ctx);
  // 直接写规则文件（本自测的 RULES_FILE 在临时 HOME 下，绝不碰真文件）。
  writeFileSync(RULES_FILE, JSON.stringify({
    rules: [
      { provider: 'a', model: '*', mode: 'normal', maxRetries: 5000000 },
      { provider: 'b', model: '*', mode: 'normal', maxRetries: 'abc' },
      { provider: 'c', model: '*', mode: 'normal', maxRetries: 12, statusCodes: [999, 429], retryableCodes: ['RATE_LIMIT'] },
      { provider: 'd', model: '*', mode: 'normal', backoff: { initialDelayMs: -5, maxDelayMs: 1e12, jitterRatio: 3 } },
    ],
  }), 'utf8');
  const response = await callRoute(harness.routes, '/dsh-model-retry/rules');
  assert.equal(response.status, 200);
  const rules = response.json.rules;
  assert.equal(rules.length, 4);
  assert.equal(rules[0].maxRetries, undefined, '越界 maxRetries 应被摘掉（回落出厂缺省）');
  assert.equal(rules[1].maxRetries, undefined, '非数值 maxRetries 应被摘掉');
  assert.equal(rules[2].maxRetries, 12, '合法值必须原样保留');
  assert.equal(rules[2].statusCodes, undefined, '含越界状态码的数组应整段摘掉');
  assert.equal(rules[3].backoff, undefined, '全部越界的 backoff 应整段摘掉');
  const warnings = response.json.warnings.join(' | ');
  assert.ok(warnings.includes('maxRetries'), '应告警 maxRetries：' + warnings);
  assert.ok(warnings.includes('statusCodes'), '应告警 statusCodes：' + warnings);
  assert.ok(warnings.includes('backoff'), '应告警 backoff：' + warnings);
  harness.disposeAll();
});

await test('请求体跨块的多字节字符不被破坏（StringDecoder 而非逐块 toString）', async () => {
  const { StringDecoder } = await import('node:string_decoder');
  const harness = fakeCtx({ groups: undefined });
  apply(harness.ctx);
  const route = harness.routes.find((item) => item.path === '/dsh-model-retry/rules');
  const text = JSON.stringify({ rules: [{ provider: '命名供应商', model: '模型-中文', mode: 'normal' }] });
  const bytes = Buffer.from(text, 'utf8');
  const cut = bytes.indexOf(Buffer.from('供', 'utf8')) + 1;   // 故意切在多字节字符中间
  // 模拟真实 IncomingMessage：handler 调了 setEncoding('utf8') → data 事件给字符串
  // （用 StringDecoder 拼接跨界字节）；没调 → 给 Buffer（逐块 toString 会插 U+FFFD）。
  const listeners = new Map();
  const req = {
    method: 'POST', url: '/dsh-model-retry/rules', headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    setEncoding(encoding) { this.encoding = encoding; },
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); return req; },
    removeListener(type, fn) { const list = listeners.get(type); if (list) { const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); } return req; },
    resume() { return req; }, pause() {}, destroy() {},
  };
  const response = await new Promise((resolve) => {
    const res = { writeHead(status) { this.status = status; }, end(payload) { resolve({ status: this.status, json: JSON.parse(payload) }); } };
    route.handler(req, res);
    const decoder = new StringDecoder('utf8');
    setImmediate(() => {
      for (const chunk of [bytes.subarray(0, cut), bytes.subarray(cut)]) {
        for (const fn of [...(listeners.get('data') || [])]) fn(req.encoding === 'utf8' ? decoder.write(chunk) : chunk);
      }
      for (const fn of [...(listeners.get('end') || [])]) fn();
    });
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  const saved = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
  assert.equal(saved.rules[0].provider, '命名供应商', '跨块多字节字符不得变成 U+FFFD：' + JSON.stringify(saved.rules[0]));
  assert.equal(saved.rules[0].model, '模型-中文');
  harness.disposeAll();
});

await test('请求体排空有界：持续投喂超预算即断开，且 413 仍能被完整读到', async () => {
  const harness = fakeCtx({ groups: undefined });
  apply(harness.ctx);
  const route = harness.routes.find((item) => item.path === '/dsh-model-retry/rules');
  const listeners = new Map();
  const req = {
    method: 'POST', url: '/dsh-model-retry/rules', headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    destroyed: false, encoding: null,
    setEncoding(encoding) { this.encoding = encoding; },
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); return req; },
    removeListener(type, fn) { const list = listeners.get(type); if (list !== undefined) { const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); } return req; },
    resume() { return req; }, pause() {}, destroy() { req.destroyed = true; },
  };
  let status = 0;
  let body = '';
  const res = { writeHead(code) { status = code; }, end(payload) { body = payload === undefined ? '' : String(payload); } };
  const done = route.handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  const chunk = 'x'.repeat(65536);
  const feed = () => [...(listeners.get('data') || [])].forEach((fn) => fn(chunk));
  for (let i = 0; i < 5; i += 1) feed();                 // 跨过 262144 上限
  await new Promise((resolve) => setImmediate(resolve)); // reject → catch → 写响应
  assert.equal(status, 413, body);
  assert.ok(body.includes('body 过大'), '413 文案应保持：' + body);
  let fed = 5;
  while (!req.destroyed && fed < 400) { fed += 1; feed(); }
  assert.equal(req.destroyed, true, '超预算必须断开（否则持续投喂可无限占住 socket）');
  assert.ok(fed < 60, `应在有限块数内断开（实际 ${fed} 块）`);
  if (typeof done === 'object' && done !== null && typeof done.then === 'function') await done.catch(() => {});
  harness.disposeAll();
});

await test('读路径限值净化：告警超上限后仍有「另有 N 处已摘除」汇总（不得静默）', async () => {
  const harness = fakeCtx({ groups: undefined });
  apply(harness.ctx);
  const rules = [];
  for (let i = 1; i <= 14; i += 1) rules.push({ provider: 'p' + i, model: '*', mode: 'normal', maxRetries: 999999 });
  writeFileSync(RULES_FILE, JSON.stringify({ rules }), 'utf8');
  const response = await callRoute(harness.routes, '/dsh-model-retry/rules');
  assert.equal(response.status, 200);
  assert.equal(response.json.rules.length, 14);
  assert.ok(response.json.rules.every((rule) => rule.maxRetries === undefined), '14 条都要被摘掉');
  const fieldWarnings = response.json.warnings.filter((w) => w.includes('maxRetries'));
  assert.equal(fieldWarnings.length, 10, '逐条告警以 10 条为上限：' + fieldWarnings.length);
  assert.ok(response.json.warnings.some((w) => w.includes('另有') && w.includes('4 处')), '剩余 4 处必须有汇总：' + JSON.stringify(response.json.warnings.slice(-2)));
  harness.disposeAll();
});

/* ------------------------------------------------------------- 收尾 ---- */

rmSync(root, { recursive: true, force: true });

process.stdout.write('\n');
if (failures.length > 0) {
  process.stdout.write(`\n失败 ${failures.length} 项：\n`);
  for (const failure of failures) {
    process.stdout.write(`  ✗ ${failure.name}\n    ${failure.error && failure.error.stack ? failure.error.stack.split('\n').slice(0, 14).join('\n    ') : failure.error}\n`);
  }
  process.stdout.write(`SELFTEST FAIL (${passed} passed, ${failures.length} failed)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`SELFTEST PASS (${passed} checks)\n`);
}
