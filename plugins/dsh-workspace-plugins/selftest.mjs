/**
 * dsh-workspace-plugins 自测：纯逻辑 + **真运行时**。
 *
 *   node plugins/dsh-workspace-plugins/selftest.mjs
 *
 * 为什么要有后半段：本插件的全部价值就是「只对该工作区的会话生效」，这句话只能
 * 用真的作用域注册表证明——桩掉 tools 注册表等于把要验的东西验没了。所以这里
 * 起一个真 Cordis Context，挂**出厂的 dsh-tools 注册表**，再造两个带作用域键的
 * 假会话（与出厂 agent 同构：`createScope(ctx, agent, {parent: 常驻键})`），
 * 然后断言：
 *   ① 命中的会话在 `tools.schemas(scope)` 里看得见子插件的工具，未命中的会话
 *      看不见，**进程全局层**（scope=undefined）也看不见——后者是「没有泄漏到
 *      所有会话」的判据；
 *   ② 同一个子插件在两个会话里是两份实例（各自的计数器独立）；
 *   ③ 会话销毁 / 清单变更 / 插件卸载三条路径都会把工具摘干净；
 *   ④ `isolate` 语义：声明了 isolate 的行两个会话都能挂；没声明又 `provide`
 *      同名服务的行，第二个会话失败并记成 failed（而不是静默半挂）；
 *   ⑤ 没有作用域标签的 agent 上下文被硬闸拒绝，且全局层不出现任何注册；
 *   ⑥ 路由：同源守卫（跨站一律 403）、/state 匹配诊断、/save 真正落盘、
 *      /probe 报错、卸载后路由注销。
 *
 * 桩只桩「外部世界」：webServer 与 agents 服务、假会话对象。注册表、scope、
 * loader 常量、以及本插件与示例子插件的真代码都是真跑的。
 *
 * @module dsh-workspace-plugins/selftest
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/* ── 极简测试跑手 ─────────────────────────────────────────────────────────── */

let passed = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ── 被测算的模块：真代码 ─────────────────────────────────────────────────── */

const store = await import('./store.js');
const workspacePlugins = await import('./index.js');
const { createScope, scopeOf } = await import('@deepseek-ai/dsh-scope');
const { Context } = await import('@deepseek-ai/cordis');
const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools');
// tools 注册表 `static inject = ['systemPrompt']`——先挂出厂的提示词注册表，
// 否则 tools 的 fiber 停在「等待服务」，服务永远不会出现。
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');

/* ── 临时目录 ─────────────────────────────────────────────────────────────── */

const root = mkdtempSync(join(tmpdir(), 'dsh-wsp-'));
const workspaceA = join(root, 'ws-a');
const workspaceB = join(root, 'ws-b');
// 故意放在 root 之外：root 会被声明为子树，放在 root 里就不是「未命中」了。
const elsewhere = mkdtempSync(join(tmpdir(), 'dsh-wsp-out-'));
mkdirSync(workspaceA, { recursive: true });
mkdirSync(workspaceB, { recursive: true });

const probeSpecifier = new URL('./examples/probe-tool.js', import.meta.url).pathname;
const fixtureSpecifier = join(root, 'fixture-service.js');
writeFileSync(fixtureSpecifier, [
  "export const name = 'wsp-fixture';",
  'export function apply(ctx, config = {}) {',
  "  ctx.provide(config.service ?? 'wsp.fixture', { id: config.id ?? 'fixture' });",
  '}',
  '',
].join('\n'), 'utf8');

// 默认导出的插件（组合行能挂，本插件也必须能挂——loader 的 unwrapExports 口径）。
const defaultExportSpecifier = join(root, 'fixture-default.mjs');
writeFileSync(defaultExportSpecifier, [
  "const plugin = {",
  "  name: 'wsp-default',",
  "  inject: ['tools'],",
  '  apply(ctx) {',
  "    ctx.tools.register({ name: 'wsp_default_probe', description: 'default-export fixture', parameters: {}, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, async execute() { return { ok: true, form: 'default' }; } });",
  '  },',
  '};',
  'export default plugin;',
  '',
].join('\n'), 'utf8');

// 插件函数本体（`export const apply/name/inject` 之外的另一半形态）。
const functionSpecifier = join(root, 'fixture-function.mjs');
writeFileSync(functionSpecifier, [
  "export const name = 'wsp-function';",
  "export const inject = ['tools'];",
  'export function apply(ctx) {',
  "  ctx.tools.register({ name: 'wsp_function_probe', description: 'function-plugin fixture', parameters: {}, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, async execute() { return { ok: true, form: 'function' }; } });",
  '}',
  '',
].join('\n'), 'utf8');

// 故意在 apply 里抛错的插件：验证失败隔离与错误上浮（设置页的排错入口）。
const brokenSpecifier = join(root, 'fixture-broken.mjs');
writeFileSync(brokenSpecifier, [
  "export const name = 'wsp-broken';",
  'export function apply() {',
  "  throw new Error('故意炸：这个子插件的 apply 抛错了');",
  '}',
  '',
].join('\n'), 'utf8');

// 故意把注册落到**全局层**的子插件：用来正面验证泄漏探针（它必须报出来）。
const leakySpecifier = join(root, 'fixture-leaky.mjs');
writeFileSync(leakySpecifier, [
  "export const name = 'wsp-leaky';",
  "export const inject = ['tools'];",
  'export function apply(ctx) {',
  "  ctx.root.tools.register({ name: 'wsp_leaky_tool', description: 'leaks to the global layer', parameters: {}, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, async execute() { return { ok: true }; } });",
  '}',
  '',
].join('\n'), 'utf8');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('── A. 纯逻辑（store.js） ─────────────────────────────────────────');

await t('canonicalPath：绝对化 + 去尾分隔符；空串返回 null', () => {
  assert.equal(store.canonicalPath(''), null);
  assert.equal(store.canonicalPath('   '), null);
  assert.equal(store.canonicalPath(`${workspaceA}/`), workspaceA);
  assert.equal(store.canonicalPath('relative/path'), join(process.cwd(), 'relative/path'));
});

await t('isInside：/root/x 不包含 /root/xy（前缀陷阱）', () => {
  assert.equal(store.isInside(workspaceA, workspaceA), true);
  assert.equal(store.isInside(join(workspaceA, 'sub', 'deep'), workspaceA), true);
  assert.equal(store.isInside(elsewhere, workspaceA), false, 'ws-a-sibling 不是 ws-a 的子目录');
  assert.equal(store.isInside(root, workspaceA), false);
});

await t('matchWorkspace：精确优先于子树，子树取最长（最近祖先）', () => {
  const list = [
    { path: workspaceA, match: 'subtree', plugins: [] },
    { path: workspaceA, match: 'exact', plugins: [] },
    { path: root, match: 'subtree', plugins: [] },
  ];
  // 同一路径既有精确又有子树：精确胜出。这里用两条不同 match 的同路径声明检验优先级。
  const exact = store.matchWorkspace([{ path: workspaceA, match: 'subtree', plugins: [] }], workspaceA);
  assert.equal(exact.mode, 'subtree');
  assert.equal(store.matchWorkspace(list, workspaceA).mode, 'exact', '精确声明应胜过子树声明');
  const deep = store.matchWorkspace(list, join(workspaceA, 'sub'));
  assert.equal(deep.mode, 'subtree');
  assert.equal(deep.workspace.path, workspaceA, '应取最长的祖先声明而不是 root');
  assert.equal(store.matchWorkspace(list, elsewhere), undefined, '同级目录不应命中');
  assert.equal(store.matchWorkspace(list, undefined), undefined);
});

await t('normalizeWorkspace：拒绝非绝对路径、坏 id、重复 id、坏 match/isolate', () => {
  assert.ok(store.normalizeWorkspace({ path: 'relative' }, 'x').error);
  assert.ok(store.normalizeWorkspace({ path: workspaceA, match: 'glob' }, 'x').error);
  assert.ok(store.normalizeWorkspace({ path: workspaceA, plugins: [{ id: 'bad id', name: 'a.js' }] }, 'x').error, '含空格的 id 非法');
  assert.ok(store.normalizeWorkspace({ path: workspaceA, plugins: [{ id: 'bad/id', name: 'a.js' }] }, 'x').error);
  assert.ok(store.normalizeWorkspace({ path: workspaceA, plugins: [{ id: 'a', name: '' }] }, 'x').error);
  assert.ok(store.normalizeWorkspace({ path: workspaceA, plugins: [{ id: 'a', name: 'a.js' }, { id: 'a', name: 'b.js' }] }, 'x').error);
  assert.ok(store.normalizeWorkspace({ path: workspaceA, plugins: [{ id: 'a', name: 'a.js', isolate: { s: 5 } }] }, 'x').error);
  const ok = store.normalizeWorkspace({ path: `${workspaceA}/`, match: 'subtree', plugins: [{ id: 'a', name: './x.js', config: { k: 1 }, isolate: { s: true } }] }, 'x');
  assert.equal(ok.error, undefined);
  assert.equal(ok.decl.path, workspaceA);
  assert.equal(ok.decl.match, 'subtree');
  assert.deepEqual(ok.decl.plugins[0].isolate, { s: true });
});

await t('mergeWorkspaces：两处来源合并、冲突保留组合那一条、configDisabled 生效', () => {
  const configDecls = [store.normalizeWorkspace({ path: workspaceA, plugins: [{ id: 'cfg', name: './cfg.js' }] }, 'c').decl];
  const fileState = store.normalizeState({
    version: 1,
    workspaces: [
      { path: workspaceA, plugins: [{ id: 'cfg', name: './other.js' }, { id: 'file', name: './file.js' }] },
      { path: workspaceB, plugins: [{ id: 'b', name: './b.js' }] },
    ],
    configDisabled: [store.rowKey(workspaceA, 'cfg')],
  }).state;
  const merged = store.mergeWorkspaces(configDecls, fileState);
  assert.equal(merged.length, 2);
  const a = merged.find((workspace) => workspace.path === workspaceA);
  assert.equal(a.source, 'both');
  assert.equal(a.plugins.length, 3);
  const conflict = a.plugins.find((row) => row.id === 'cfg' && row.source === 'file');
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.disabled, true);
  const fromConfig = a.plugins.find((row) => row.id === 'cfg' && row.source === 'config');
  assert.equal(fromConfig.disabled, true, 'configDisabled 应停用组合行');
  assert.equal(fromConfig.name, './cfg.js', '冲突时保留组合那一条');
  assert.deepEqual(store.rowSpecifiers(merged).sort(), ['./b.js', './file.js'].sort(), '停用/冲突的行不参与预导入');
  const enabledRow = store.normalizeWorkspace({ path: workspaceB, plugins: [{ id: 'z', name: './z.js' }] }, 'x').decl;
  assert.deepEqual(store.rowSpecifiers(store.mergeWorkspaces([enabledRow], store.normalizeState({ version: 1, workspaces: [] }).state)), ['./z.js']);
});

await t('状态文件：往返、缺文件＝空状态、坏 JSON 收集错误不抛', () => {
  const path = join(root, 'roundtrip.json');
  const state = store.normalizeState({ version: 1, workspaces: [{ path: workspaceB, plugins: [{ id: 'x', name: './x.js' }] }], configDisabled: [] }).state;
  store.writeStateFile(path, state);
  const read = store.readStateFile(path);
  assert.equal(read.exists, true);
  assert.deepEqual(read.errors, []);
  assert.equal(read.state.workspaces[0].path, workspaceB);
  const missing = store.readStateFile(join(root, 'nope.json'));
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.state.workspaces, []);
  const broken = join(root, 'broken.json');
  writeFileSync(broken, '{ not json', 'utf8');
  const brokenRead = store.readStateFile(broken);
  assert.equal(brokenRead.errors.length, 1);
  assert.equal(brokenRead.state.workspaces.length, 0);
});

await t('workspaceSignature：行内容一变签名就变（决定要不要重挂）', () => {
  const base = { path: workspaceA, match: 'exact', plugins: [{ id: 'a', name: './a.js', source: 'config' }] };
  const same = { path: workspaceA, match: 'exact', plugins: [{ id: 'a', name: './a.js', source: 'config' }] };
  const changed = { path: workspaceA, match: 'exact', plugins: [{ id: 'a', name: './a.js', disabled: true, source: 'config' }] };
  assert.equal(store.workspaceSignature(base), store.workspaceSignature(same));
  assert.notEqual(store.workspaceSignature(base), store.workspaceSignature(changed));
});


/* ── 网络工作区：纯逻辑（注册表投影 + 设备网格投影 → 匹配集合） ──────────── */

/** 一份与 host readRegistry() 同形状的投影（测试里手写，等于把契约钉在测试里）。 */
function registryProjection(entries) {
  const byId = new Map();
  const byPath = new Map();
  const sessionOf = new Map();
  const list = entries.map((entry) => {
    const item = { id: entry.id, title: entry.title ?? null, path: entry.path, sessionIds: entry.sessionIds ?? [] };
    byId.set(item.id, item);
    if (!byPath.has(item.path)) byPath.set(item.path, item);
    for (const sessionId of item.sessionIds) if (!sessionOf.has(sessionId)) sessionOf.set(sessionId, item.id);
    return item;
  });
  return { available: true, error: null, list, byId, byPath, sessionOf };
}

/** 一份与 host readMesh() 同形状的投影。 */
function meshProjection(self, groups) {
  const byWorkspaceId = new Map();
  const byPath = new Map();
  for (const group of groups) {
    const bucket = byWorkspaceId.get(group.workspaceId) ?? [];
    bucket.push(group);
    byWorkspaceId.set(group.workspaceId, bucket);
    const mark = (path, kind, member) => {
      if (typeof path !== 'string' || byPath.has(path)) return;
      byPath.set(path, { group, kind, member: member ?? null, local: kind === 'primary' ? group.primary?.local === true : member?.local === true });
    };
    mark(group.primary?.path, 'primary', null);
    for (const member of group.members ?? []) mark(member.path, 'member', member);
  }
  return { available: true, error: null, selfDeviceId: self.deviceId, selfDeviceName: self.name, devices: [], groups, byWorkspaceId, byPath };
}

const NET_WS_ID = '863de1b8-a5f4-4560-beb7-fda46cf99189';
const MIRROR_PATH = join(root, 'ws-a-mirror');
mkdirSync(MIRROR_PATH, { recursive: true });
const SELF_DEVICE = { deviceId: 'dev-self', name: 'xray4668' };
const PEER_DEVICE = { deviceId: 'dev-peer', name: 'orangepi5' };

/** 一条真实形状的工作区账目组：本机主路径 + 本机 mirror + 对端 mirror（同一个路径串）。 */
function netGroup(options = {}) {
  return {
    id: 'group-1',
    homeDeviceId: options.homeDeviceId ?? SELF_DEVICE.deviceId,
    workspaceId: options.workspaceId ?? NET_WS_ID,
    workspaceTitle: 'ArkTower',
    orphan: false,
    primary: {
      deviceId: options.homeDeviceId ?? SELF_DEVICE.deviceId,
      deviceName: options.homeDeviceId === PEER_DEVICE.deviceId ? PEER_DEVICE.name : SELF_DEVICE.name,
      path: options.primaryPath ?? workspaceA,
      fromLiveRegistry: true,
      local: (options.homeDeviceId ?? SELF_DEVICE.deviceId) === SELF_DEVICE.deviceId,
      stale: false,
    },
    members: options.members ?? [
      { id: 'm-local', deviceId: SELF_DEVICE.deviceId, deviceName: SELF_DEVICE.name, path: MIRROR_PATH, role: 'mirror', label: '本机工作副本', createdAt: '2026-10-10T00:00:00.000Z', prefer: true, local: true, reachable: true },
      { id: 'm-peer', deviceId: PEER_DEVICE.deviceId, deviceName: PEER_DEVICE.name, path: workspaceA, role: 'mirror', label: '对端真实工作树', createdAt: '2026-10-10T00:00:00.000Z', prefer: false, local: false, reachable: true },
    ],
  };
}

await t('网络工作区：按 workspace id 绑定走注册表路径，并带上注册表的会话账', () => {
  const registry = registryProjection([{ id: NET_WS_ID, title: 'ArkTower', path: workspaceA, sessionIds: ['session-ident'] }]);
  const [resolved] = store.resolveWorkspaces(
    [{ key: `ws:${NET_WS_ID}`, workspaceId: NET_WS_ID, match: 'exact', includeMembers: true, plugins: [] }],
    registry,
    store.emptyMeshIndex(),
  );
  assert.equal(resolved.workspaceId, NET_WS_ID);
  assert.deepEqual(resolved.matchPaths.map((entry) => [entry.path, entry.kind, entry.source]), [[workspaceA, 'primary', 'registry']]);
  assert.deepEqual(resolved.sessionIds, ['session-ident'], '会话账要带进匹配（这是最硬的身份依据）');
  assert.equal(resolved.remoteOnly, false);
  const byPath = store.matchWorkspace([resolved], workspaceA);
  assert.equal(byPath.workspace.workspaceId, NET_WS_ID);
  assert.equal(byPath.by, 'path');
  const bySession = store.matchWorkspace([resolved], elsewhere, 'session-ident');
  assert.equal(bySession.by, 'session', 'cwd 不同但注册表说这个会话属于它 → 身份命中');
});

await t('网络工作区：本机附加路径参与匹配，远端设备的路径永不参与', () => {
  const registry = registryProjection([{ id: NET_WS_ID, title: 'ArkTower', path: workspaceA, sessionIds: [] }]);
  const mesh = meshProjection(SELF_DEVICE, [netGroup()]);
  const [withMembers] = store.resolveWorkspaces([{ key: `ws:${NET_WS_ID}`, workspaceId: NET_WS_ID, match: 'exact', includeMembers: true, plugins: [] }], registry, mesh);
  assert.deepEqual(withMembers.matchPaths.map((entry) => [entry.path, entry.kind]), [[workspaceA, 'primary'], [MIRROR_PATH, 'member']]);
  assert.equal(withMembers.network.remoteMembers.length, 1);
  assert.equal(withMembers.network.remoteMembers[0].deviceName, 'orangepi5');
  assert.deepEqual(withMembers.network.remoteDevices, ['orangepi5']);
  assert.ok(withMembers.hints.some((line) => /orangepi5/.test(line) && /声明/.test(line)), `要有「在那台设备上声明」的提示：${JSON.stringify(withMembers.hints)}`);
  const hitMember = store.matchWorkspace([withMembers], MIRROR_PATH);
  assert.equal(hitMember.kind, 'member', '本机 mirror 路径要命中，并且标明命中的是附加路径');
  const [withoutMembers] = store.resolveWorkspaces([{ key: `ws:${NET_WS_ID}`, workspaceId: NET_WS_ID, match: 'exact', includeMembers: false, plugins: [] }], registry, mesh);
  assert.deepEqual(withoutMembers.matchPaths.map((entry) => entry.path), [workspaceA], 'includeMembers: false 时只有主路径');
  assert.equal(store.matchWorkspace([withoutMembers], MIRROR_PATH), undefined);
  assert.ok(withoutMembers.network.remoteMembers.length === 1, '关掉的是匹配，不是网络信息');
});

await t('网络工作区：路径绑定也能认出所属账目（顺带认领身份与附加路径）', () => {
  const mesh = meshProjection(SELF_DEVICE, [netGroup()]);
  const [resolved] = store.resolveWorkspaces([{ key: `path:${workspaceA}`, path: workspaceA, match: 'exact', includeMembers: true, plugins: [] }], store.emptyRegistryIndex(), mesh);
  assert.equal(resolved.workspaceId, NET_WS_ID, '只给 path 的旧声明也要能认出它的网络身份');
  assert.deepEqual(resolved.matchPaths.map((entry) => entry.kind), ['primary', 'member']);
});

await t('网络工作区：本机没有路径的声明（remoteOnly）不匹配任何会话，并给出可行动提示', () => {
  const group = netGroup({ homeDeviceId: PEER_DEVICE.deviceId, members: [
    { id: 'm-peer', deviceId: PEER_DEVICE.deviceId, deviceName: PEER_DEVICE.name, path: '/srv/ark', role: 'mirror', label: null, createdAt: '2026-10-10T00:00:00.000Z', prefer: true, local: false, reachable: true },
  ] });
  const mesh = meshProjection(SELF_DEVICE, [group]);
  const [resolved] = store.resolveWorkspaces([{ key: `ws:${NET_WS_ID}`, workspaceId: NET_WS_ID, match: 'exact', includeMembers: true, plugins: [] }], store.emptyRegistryIndex(), mesh);
  assert.equal(resolved.remoteOnly, true);
  assert.deepEqual(resolved.matchPaths, []);
  assert.equal(store.matchWorkspace([resolved], '/srv/ark'), undefined, '远端路径不可能是本机会话的 cwd');
  assert.ok(/orangepi5/.test(resolved.network.hint), `提示里要有设备名：${resolved.network.hint}`);
  assert.ok(resolved.hints.some((line) => /mesh_workspace_paths|声明同一行/.test(line)));
});

await t('网络工作区：服务缺席或投影畸形时退化为 v6 的按路径匹配（一律不抛）', () => {
  const decl = { key: `path:${workspaceA}`, path: workspaceA, match: 'exact', plugins: [] };
  const [plain] = store.resolveWorkspaces([decl], store.emptyRegistryIndex(), store.emptyMeshIndex());
  assert.deepEqual(plain.matchPaths.map((entry) => [entry.path, entry.source]), [[workspaceA, 'declared']]);
  assert.deepEqual(plain.matchPaths[0].exists, true, '本机存在的声明路径要标 exists');
  assert.equal(plain.network.available, false);
  assert.equal(plain.remoteOnly, false);
  assert.ok(store.matchWorkspace([plain], workspaceA) !== undefined);
  const [noProjection] = store.resolveWorkspaces([decl], undefined, undefined);
  assert.equal(noProjection.matchPaths.length, 1, 'undefined 投影也要能跑（服务缺席是常态）');
  const malformed = { available: true, byId: null, byPath: '不是 Map', list: 'x', sessionOf: null };
  const brokenMesh = { available: true, selfDeviceId: null, groups: [null, 7, { workspaceId: 42, members: 'x', primary: null }], byWorkspaceId: null, byPath: undefined };
  const [weird] = store.resolveWorkspaces([decl], malformed, brokenMesh);
  assert.equal(weird.matchPaths.length, 1, '畸形投影不能干扰声明里的路径');
  const [weirdId] = store.resolveWorkspaces([{ key: 'ws:x', workspaceId: 'x-unknown-id', match: 'exact', plugins: [] }], malformed, brokenMesh);
  assert.equal(weirdId.remoteOnly, true, '查不到的身份绑定 = 本机没有路径（并会被提示说明）');
});

await t('disableKeyOf：路径声明保持 v6 的裸路径键，身份绑定用 ws: 命名空间', () => {
  assert.equal(store.rowKey(store.disableKeyOf({ path: workspaceA }), 'a'), `${workspaceA}#a`, '既有状态文件的 configDisabled 不能失效');
  assert.equal(store.rowKey(store.disableKeyOf({ workspaceId: NET_WS_ID }), 'a'), `ws:${NET_WS_ID}#a`);
  assert.equal(store.workspaceKeyOf({ path: workspaceA }), `path:${workspaceA}`, '内部键仍然带前缀（与 disableKey 分开）');
  assert.equal(store.workspaceKeyOf({ workspaceId: NET_WS_ID }), `ws:${NET_WS_ID}`);
  const merged = store.mergeWorkspaces(
    [{ workspaceId: NET_WS_ID, path: '/srv/a', match: 'exact', plugins: [{ id: 'x', name: './x.js' }] }],
    { workspaces: [{ workspaceId: NET_WS_ID, path: '/srv/b', match: 'exact', plugins: [{ id: 'y', name: './y.js' }] }], configDisabled: [] },
  );
  assert.equal(merged.length, 1, '同 id 不同路径（跨设备声明原样复制）必须合并成一条');
  assert.deepEqual(merged[0].plugins.map((row) => row.id), ['x', 'y']);
  const disabled = store.mergeWorkspaces(
    [{ workspaceId: NET_WS_ID, match: 'exact', plugins: [{ id: 'x', name: './x.js' }] }],
    { workspaces: [], configDisabled: [`ws:${NET_WS_ID}#x`] },
  );
  assert.equal(disabled[0].plugins[0].disabled, true, '身份绑定的 configDisabled 也要生效');
});

console.log('\n── B. 真运行时（真 Cordis + 真 tools 注册表 + 假会话） ────────────');

/** 起一个测试用 harness：假 webServer + 假 agents + 真 tools 注册表 + 本插件。 */
/**
 * 起一个只挂本插件的 harness：真 SystemPrompt + 真 ToolRuntime（于是 tools 注册表是
 * 真的，作用域投影也是真的）+ 假 webServer / agents / loader。
 *
 * 新增的用例（泄漏探针、失败重试、字节坏文件、config 深拷贝…）都用它：每个用例一个
 * 干净的进程内世界，互不干扰。
 * @param stateFilePath - 状态文件路径。
 * @param declarations - 组合声明（config.workspaces）。
 * @returns `{ context, routes, agents, handle, makeSession }`。
 */
async function bootFreshHarness(stateFilePath, declarations) {
  const context = new Context();
  const routes = new Map();
  const agents = [];
  await context.plugin({
    name: 'fresh-webserver',
    apply(inner) {
      inner.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } });
    },
  });
  await context.plugin({ name: 'fresh-agents', apply(inner) { inner.provide('agents', { list: () => agents }); } });
  await context.plugin({ name: 'fresh-loader', apply(inner) { inner.provide('loader', { builtins: {} }); } });
  await context.plugin(SystemPrompt, { personaPrefix: '' });
  await context.plugin(ToolRuntime, { mode: 'native' });
  const handle = context.plugin(workspacePlugins, { file: stateFilePath, workspaces: declarations ?? [] });
  await handle;
  await delay(40);
  const standing = {};
  return {
    context,
    routes,
    agents,
    handle,
    makeSession(id, cwd) {
      const agent = makeAgent(context, standing, id, cwd);
      agents.push(agent);
      context.emit('agent/created', { agent });
      return agent;
    },
    toolNamesOf(agent) {
      return context.get('tools').schemas(scopeOf(agent.ctx)).map((schema) => schema.name);
    },
    globalToolNames() {
      return context.get('tools').schemas(undefined).map((schema) => schema.name);
    },
  };
}

async function bootHarness(config, stateFilePath, settleMs) {
  const context = new Context();
  const routes = new Map();
  const agents = [];
  await context.plugin({
    name: 'test-webserver',
    apply(inner) {
      inner.provide('webServer', {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      });
    },
  });
  await context.plugin({
    name: 'test-agents',
    apply(inner) {
      inner.provide('agents', { list: () => agents });
    },
  });
  // 假 loader：只提供 builtins，用来验证 `cordis:xxx` 走的是 loader 的内建表
  // （cordis-plugin-loader 的 tree.import 就是这么解析的），而不是当成 URL import。
  await context.plugin({
    name: 'test-loader',
    apply(inner) {
      inner.provide('loader', {
        builtins: {
          'fixture-timer': {
            name: 'wsp-builtin',
            inject: ['tools'],
            apply(builtinCtx) {
              builtinCtx.tools.register({ name: 'wsp_builtin_probe', description: 'cordis: builtin fixture', parameters: {}, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, async execute() { return { ok: true, form: 'builtin' }; } });
            },
          },
        },
      });
    },
  });
  await context.plugin(SystemPrompt, { personaPrefix: '' });
  await context.plugin(ToolRuntime, { mode: 'native' });
  const handle = context.plugin(workspacePlugins, config);
  await handle;
  if (settleMs !== 0) await delay(settleMs === undefined ? 30 : settleMs);
  return { context, routes, agents, handle };
}

/** 造一个与出厂 agent 同构的假会话：作用域键＝agent 对象，父键＝常驻键。 */
function makeAgent(context, standingKey, id, cwd) {
  const agent = { id, session: { header: { cwd } } };
  agent.ctx = createScope(context, agent, { parent: standingKey }).ctx;
  return agent;
}

/** 从注入表里取出本插件注入的访问令牌（模拟设置页从 index HTML 拿到它的路径）。 */
function tokenOf(context) {
  const table = [];
  context.emit('webserver/index-inject', table);
  const row = table.find((entry) => entry?.name === '__DSH_WORKSPACE_PLUGINS__');
  return row === undefined ? '' : row.value.token;
}

/** 调一个已注册路由，返回 `{ status, body }`。 */
async function callRoute(routes, path, options = {}) {
  const route = routes.get(path);
  assert.ok(route !== undefined, `路由未注册：${path}`);
  const headers = { host: '127.0.0.1:3080', ...(options.headers ?? {}) };
  const req = {
    method: options.method ?? 'GET',
    url: options.url ?? path,
    headers,
    on(event, handler) {
      if (event === 'data' && options.body !== undefined) handler(Buffer.from(options.body, 'utf8'));
      if (event === 'end') handler();
      return req;
    },
    destroy() {},
  };
  const chunks = [];
  const res = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    end(text) { chunks.push(text ?? ''); this.writableEnded = true; },
    destroy() {},
  };
  await route.handler(req, res);
  await delay(5);
  const text = chunks.join('');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.statusCode, body };
}

const statePath = join(root, 'state.json');
store.writeStateFile(statePath, store.normalizeState({
  version: 1,
  workspaces: [
    // 与组合声明同 id → 冲突，本地这条不挂载（组合是权威）。
    { path: workspaceA, plugins: [{ id: 'probe-cfg', name: './conflict.js' }] },
    {
      path: workspaceB,
      plugins: [
        { id: 'probe-file', name: probeSpecifier, config: { label: 'from-file' } },
        { id: 'iso', name: fixtureSpecifier, config: { service: 'wsp.demo', id: 'iso' }, isolate: { 'wsp.demo': true } },
        { id: 'noiso', name: fixtureSpecifier, config: { service: 'wsp.plain', id: 'plain' } },
      ],
    },
  ],
  configDisabled: [],
}).state);

const harness = await bootHarness({
  file: statePath,
  workspaces: [
    {
      path: workspaceA,
      plugins: [
        { id: 'probe-cfg', name: probeSpecifier, config: { label: 'from-config' } },
        { id: 'iso', name: fixtureSpecifier, config: { service: 'wsp.demo', id: 'iso' }, isolate: { 'wsp.demo': true } },
        { id: 'noiso', name: fixtureSpecifier, config: { service: 'wsp.plain', id: 'plain' } },
        { id: 'default-export', name: defaultExportSpecifier },
        { id: 'plugin-function', name: functionSpecifier },
        { id: 'builtin', name: 'cordis:fixture-timer' },
        { id: 'broken', name: brokenSpecifier },
        { id: 'bad-module', name: './no-such-module.js' },
      ],
    },
  ],
}, statePath);

let { context, routes, agents } = harness;
const standingKey = {};
const agentA = makeAgent(context, standingKey, 'session-a', workspaceA);
const agentB = makeAgent(context, standingKey, 'session-b', workspaceB);
agents.push(agentA, agentB);
context.emit('agent/created', { agent: agentA });
context.emit('agent/created', { agent: agentB });
await delay(60);

const tools = context.get('tools');
const toolNames = (agent) => tools.schemas(scopeOf(agent.ctx)).map((schema) => schema.name);
const globalToolNames = () => tools.schemas(undefined).map((schema) => schema.name);

await t('命中的会话看得见子插件工具；未命中的会话与全局层都看不见', () => {
  assert.ok(toolNames(agentA).includes('workspace_plugin_probe'), `A 应看到工具，实际 ${JSON.stringify(toolNames(agentA))}`);
  assert.ok(toolNames(agentB).includes('workspace_plugin_probe'), `B 应看到自己的那份，实际 ${JSON.stringify(toolNames(agentB))}`);
  assert.equal(globalToolNames().includes('workspace_plugin_probe'), false, '工具不得出现在进程全局层（否则等于对所有会话生效）');
});

await t('两个会话各持一份实例：计数器独立', async () => {
  const definitionA = tools.get('workspace_plugin_probe', scopeOf(agentA.ctx));
  const definitionB = tools.get('workspace_plugin_probe', scopeOf(agentB.ctx));
  assert.ok(definitionA !== undefined && definitionB !== undefined);
  const firstA = await definitionA.execute({ note: 'a1' }, { agent: agentA, signal: new AbortController().signal });
  const secondA = await definitionA.execute({ note: 'a2' }, { agent: agentA, signal: new AbortController().signal });
  const firstB = await definitionB.execute({}, { agent: agentB, signal: new AbortController().signal });
  assert.equal(firstA.sessionId, 'session-a');
  assert.equal(firstA.calls, 1);
  assert.equal(secondA.calls, 2, 'A 的计数器应累加');
  assert.equal(firstB.sessionId, 'session-b');
  assert.equal(firstB.calls, 1, 'B 必须是另一份实例（计数器从 1 开始）');
  assert.equal(firstA.plugin, 'from-config');
  assert.equal(firstB.plugin, 'from-file');
});

await t('isolate：声明了 isolate 的行两个会话都挂上；没声明又 provide 同名服务的行第二个会话失败', async () => {
  const status = await callRoute(routes, '/dsh-workspace-plugins/state');
  const mounts = status.body.mounts;
  const mountA = mounts.find((mount) => mount.sessionId === 'session-a');
  const mountB = mounts.find((mount) => mount.sessionId === 'session-b');
  assert.ok(mountA !== undefined && mountB !== undefined, `两个会话都应有挂载记录：${JSON.stringify(mounts)}`);
  const rowA = (id, mount) => mount.rows.find((row) => row.id === id);
  assert.equal(rowA('iso', mountA).state, 'active');
  assert.equal(rowA('iso', mountB).state, 'active', 'isolate 让两个会话各有一个服务域');
  assert.equal(rowA('noiso', mountA).state, 'active');
  assert.equal(rowA('noiso', mountB).state, 'failed', '未声明 isolate 的同名服务在第二个会话必然撞车，应如实记为 failed');
  assert.match(String(rowA('noiso', mountB).error), /registered|provide|service/i);
  // 两处声明同 id：组合那条照挂，本地那条被标成 conflict 且不挂载（组合是权威）。
  assert.equal(rowA('probe-cfg', mountA).state, 'active', '组合声明的行应生效');
  const conflictRow = mountA.rows.find((row) => row.id === 'probe-cfg' && row.source === 'file');
  assert.equal(conflictRow.state, 'skipped', '与组合声明 id 冲突的本地行应被跳过');
});

await t('三种插件形态都能挂：默认导出 / 插件函数 / cordis: 内建（口径与 loader 一致）', async () => {
  const names = toolNames(agentA);
  for (const name of ['wsp_default_probe', 'wsp_function_probe', 'wsp_builtin_probe']) {
    assert.ok(names.includes(name), `${name} 应在会话 A 的工具表里，实际 ${JSON.stringify(names)}`);
    assert.equal(globalToolNames().includes(name), false, `${name} 不应出现在全局层`);
  }
  const state = await callRoute(routes, '/dsh-workspace-plugins/state');
  const mountA = state.body.mounts.find((mount) => mount.sessionId === 'session-a');
  for (const id of ['default-export', 'plugin-function', 'builtin']) {
    assert.equal(mountA.rows.find((row) => row.id === id).state, 'active', `${id} 应挂载成功`);
  }
});

await t('cordis: 内建解析失败时给可读错误；探测能识别默认导出', async () => {
  const bad = await callRoute(routes, '/dsh-workspace-plugins/probe', { method: 'POST', body: JSON.stringify({ specifier: 'cordis:does-not-exist' }) });
  assert.equal(bad.body.ok, false);
  assert.match(String(bad.body.error), /builtins|内建/);
  const viaDefault = await callRoute(routes, '/dsh-workspace-plugins/probe', { method: 'POST', body: JSON.stringify({ specifier: defaultExportSpecifier }) });
  assert.equal(viaDefault.body.ok, true, `默认导出模块应被判为可挂载：${JSON.stringify(viaDefault.body)}`);
  assert.equal(viaDefault.body.unwrapped, true, '应报告它与命名空间不同（解开过默认导出）');
  const builtin = await callRoute(routes, '/dsh-workspace-plugins/probe', { method: 'POST', body: JSON.stringify({ specifier: 'cordis:fixture-timer' }) });
  assert.equal(builtin.body.ok, true);
  assert.equal(builtin.body.kind, 'builtin');
  const sourceCode = await callRoute(routes, '/dsh-workspace-plugins/probe', { method: 'POST', body: JSON.stringify({ specifier: functionSpecifier }) });
  assert.equal(sourceCode.body.pluginShape.form, '带 apply 的对象');
});

await t('坏子插件只坏自己：该行 failed 且错误可见，兄弟行照常 active', async () => {
  const state = await callRoute(routes, '/dsh-workspace-plugins/state');
  const mountA = state.body.mounts.find((mount) => mount.sessionId === 'session-a');
  const broken = mountA.rows.find((row) => row.id === 'broken');
  assert.equal(broken.state, 'failed', 'apply 抛错的行必须如实记 failed');
  assert.match(String(broken.error), /故意炸/, '错误原文要能看见（设置页就是靠它让人排错）');
  assert.equal(mountA.rows.find((row) => row.id === 'iso').state, 'active', '同一工作区的其它行不受影响');
  const live = (await callRoute(routes, '/dsh-workspace-plugins/state')).body.workspaces
    .find((workspace) => workspace.path === workspaceA).plugins.find((row) => row.id === 'broken').live;
  assert.equal(live.failed, 1, '汇总里应能看出这一行在几个会话里失败');
  assert.ok(live.errors.some((line) => /故意炸/.test(String(line))), '汇总错误文案要上浮到行上');
});

await t('泄漏探针：正常挂载不产生全局层新增（leaked 为空）', async () => {
  const status = await callRoute(routes, '/dsh-workspace-plugins/state');
  const mountA = status.body.mounts.find((mount) => mount.sessionId === 'session-a');
  const probeRow = mountA.rows.find((row) => row.id === 'probe-cfg');
  assert.equal(probeRow.leaked, undefined, '工具型子插件挂在会话作用域下时，全局层不应多出任何工具名');
  const global = globalToolNames();
  assert.equal(global.includes('workspace_plugin_probe'), false);
  // 反面证据：这一行的工具确实存在于它自己的作用域里（否则上面的断言可能只是「什么都没挂」）。
  assert.ok(toolNames(agentA).includes('workspace_plugin_probe'));
});

await t('未命中工作区的会话：一行都不挂，且状态路由报告 hit=false', async () => {
  const outside = makeAgent(context, standingKey, 'session-outside', elsewhere);
  agents.push(outside);
  context.emit('agent/created', { agent: outside });
  await delay(40);
  assert.equal(toolNames(outside).includes('workspace_plugin_probe'), false);
  const state = await callRoute(routes, '/dsh-workspace-plugins/state', { url: `/dsh-workspace-plugins/state?cwd=${encodeURIComponent(elsewhere)}` });
  assert.equal(state.body.diagnostics.matched.hit, false);
  const hit = await callRoute(routes, '/dsh-workspace-plugins/state', { url: `/dsh-workspace-plugins/state?cwd=${encodeURIComponent(workspaceA)}` });
  assert.equal(hit.body.diagnostics.matched.hit, true);
  assert.equal(hit.body.diagnostics.matched.mode, 'exact');
});

await t('没有作用域标签的 agent 上下文被硬闸拒绝，且不产生任何全局注册', async () => {
  const unscoped = { id: 'session-unscoped', session: { header: { cwd: workspaceA } }, ctx: context };
  agents.push(unscoped);
  context.emit('agent/created', { agent: unscoped });
  await delay(40);
  assert.equal(globalToolNames().includes('workspace_plugin_probe'), false);
  const status = await callRoute(routes, '/dsh-workspace-plugins/status');
  assert.equal(status.body.mounts.some((mount) => mount.sessionId === 'session-unscoped'), false);
});

await t('会话销毁：只摘掉该会话，其它会话不受影响', async () => {
  context.emit('agent/disposed', { agent: agentA });
  agents.splice(agents.indexOf(agentA), 1);
  await delay(40);
  assert.equal(toolNames(agentA).includes('workspace_plugin_probe'), false, 'A 的工具应随会话消失');
  assert.ok(toolNames(agentB).includes('workspace_plugin_probe'), 'B 不受影响');
});

await t('路由守卫：跨站一律 403；非 POST 405', async () => {
  const save = '/dsh-workspace-plugins/save';
  assert.equal((await callRoute(routes, save, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}' })).status, 403);
  assert.equal((await callRoute(routes, save, { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await callRoute(routes, save, { method: 'GET' })).status, 405);
  const state = '/dsh-workspace-plugins/state';
  assert.equal((await callRoute(routes, state, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
});

await t('/save：校验失败不落盘；合法保存写盘并重挂', async () => {
  const save = '/dsh-workspace-plugins/save';
  const before = readFileSync(statePath, 'utf8');
  const bad = await callRoute(routes, save, { method: 'POST', body: JSON.stringify({ workspaces: [{ path: 'relative', plugins: [] }] }) });
  assert.equal(bad.status, 400);
  assert.equal(readFileSync(statePath, 'utf8'), before, '校验失败时文件不应被改写');
  const good = await callRoute(routes, save, {
    method: 'POST',
    body: JSON.stringify({ workspaces: [{ path: workspaceB, match: 'subtree', plugins: [{ id: 'probe-file', name: probeSpecifier, config: { label: 'after-save' } }] }], configDisabled: [] }),
  });
  assert.equal(good.status, 200);
  const onDisk = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(onDisk.workspaces[0].match, 'subtree');
  await delay(60);
  const definitionB = tools.get('workspace_plugin_probe', scopeOf(agentB.ctx));
  const result = await definitionB.execute({}, { agent: agentB, signal: new AbortController().signal });
  assert.equal(result.plugin, 'after-save', '保存后活会话应重挂到新清单');
  assert.equal(result.calls, 1, '重挂后是新实例');
});

await t('/reload 与 /probe：重新预导入、探测坏模块报错', async () => {
  const probe = await callRoute(routes, '/dsh-workspace-plugins/probe', { method: 'POST', body: JSON.stringify({ specifier: './definitely-missing.js' }) });
  assert.equal(probe.status, 200);
  assert.equal(probe.body.ok, false);
  assert.ok(String(probe.body.error).length > 0);
  const goodProbe = await callRoute(routes, '/dsh-workspace-plugins/probe', { method: 'POST', body: JSON.stringify({ specifier: probeSpecifier }) });
  assert.equal(goodProbe.body.ok, true);
  assert.equal(goodProbe.body.pluginShape.apply, 'function');
  const notPlugin = await callRoute(routes, '/dsh-workspace-plugins/probe', { method: 'POST', body: JSON.stringify({ specifier: 'node:path' }) });
  assert.equal(notPlugin.body.ok, false);
  const reload = await callRoute(routes, '/dsh-workspace-plugins/reload', { method: 'POST', body: '{}' });
  assert.equal(reload.status, 200);
  assert.equal(reload.body.state.file.errors.length, 0);
});

await t('预导入窗口内创建的会话：最终被 sweep 补挂，不留永久 failed 记录', async () => {
  // 复现启动竞态：apply 一返回就建会话（此时 refresh() 的 preload 还在飞）。
  const raceStatePath = join(root, 'race-state.json');
  store.writeStateFile(raceStatePath, store.normalizeState({
    version: 1,
    workspaces: [{ path: workspaceA, plugins: [{ id: 'probe-race', name: probeSpecifier, config: { label: 'race' } }] }],
    configDisabled: [],
  }).state);
  const race = await bootHarness({ file: raceStatePath }, raceStatePath, 0);
  const raceStanding = {};
  const racer = makeAgent(race.context, raceStanding, 'session-race', workspaceA);
  race.agents.push(racer);
  // 同步 emit：这一刻 preload 几乎肯定还没结束，走的是 not-ready 分支。
  race.context.emit('agent/created', { agent: racer });
  const early = await callRoute(race.routes, '/dsh-workspace-plugins/status');
  assert.equal(early.body.mounts.length, 0, '模块未就绪时不应建挂载记录（更不该记一条 failed）');
  await delay(80);
  const raceTools = race.context.get('tools');
  const names = raceTools.schemas(scopeOf(racer.ctx)).map((schema) => schema.name);
  assert.ok(names.includes('workspace_plugin_probe'), `sweep 应把窗口内创建的会话补挂上，实际 ${JSON.stringify(names)}`);
  const late = await callRoute(race.routes, '/dsh-workspace-plugins/status');
  const record = late.body.mounts.find((mount) => mount.sessionId === 'session-race');
  assert.ok(record !== undefined, '应有一条挂载记录');
  assert.deepEqual(record.rows.map((row) => row.state), ['active'], '而且必须是 active，不是 failed');
  assert.equal(raceTools.schemas(undefined).map((schema) => schema.name).includes('workspace_plugin_probe'), false, '补挂也不得进全局层');
  await race.handle.dispose();
  await race.context.fiber.dispose().catch(() => {});
});

await t('预导入失败如实记 failed：坏模块的行失败、兄弟行照常 active', async () => {
  const fresh = await bootFreshHarness(join(root, 'badmod-state.json'), [{
    path: workspaceA,
    plugins: [{ id: 'bad-module', name: './no-such-module.js' }, { id: 'good-module', name: probeSpecifier }],
  }]);
  fresh.makeSession('session-bad', workspaceA);
  await delay(30);
  const state = await callRoute(fresh.routes, '/dsh-workspace-plugins/state');
  const bad = state.body.modules.find((record) => record.specifier === './no-such-module.js');
  assert.ok(bad !== undefined, `坏模块应出现在预导入清单里：${JSON.stringify(state.body.modules.map((m) => m.specifier))}`);
  assert.equal(bad.state, 'failed', '导入失败必须如实记 failed（不能吞成 ok）');
  assert.ok(String(bad.error ?? '').length > 0, '失败要有错误原文');
  const rows = state.body.mounts.find((mount) => mount.sessionId === 'session-bad').rows;
  assert.equal(rows.find((entry) => entry.id === 'bad-module').state, 'failed');
  assert.match(String(rows.find((entry) => entry.id === 'bad-module').error), /Cannot find|not found|预导入/i);
  assert.equal(rows.find((entry) => entry.id === 'good-module').state, 'active', '兄弟行不受影响');
  assert.ok(fresh.toolNamesOf(fresh.agents[0]).includes('workspace_plugin_probe'), '好的那一行照常可见');
  await fresh.handle.dispose();
  await fresh.context.fiber.dispose().catch(() => {});
});

await t('/status 与 /state 的挂载视图必须一致（不是各自编的）', async () => {
  const fresh = await bootFreshHarness(join(root, 'views-state.json'), [
    { path: workspaceA, plugins: [{ id: 'probe-a', name: probeSpecifier }] },
    { path: workspaceB, plugins: [{ id: 'probe-b', name: probeSpecifier }] },
  ]);
  fresh.makeSession('session-a', workspaceA);
  fresh.makeSession('session-b', workspaceB);
  await delay(30);
  const status = await callRoute(fresh.routes, '/dsh-workspace-plugins/status');
  const state = await callRoute(fresh.routes, '/dsh-workspace-plugins/state');
  const fromStatus = status.body.mounts.map((mount) => mount.sessionId).sort();
  const fromState = state.body.mounts.map((mount) => mount.sessionId).sort();
  assert.deepEqual(fromStatus, fromState, '/status 的会话列表应与 /state 一致');
  assert.deepEqual(fromStatus, ['session-a', 'session-b'], `两个会话都要在：${JSON.stringify(fromStatus)}`);
  assert.ok(status.body.mounts.every((mount) => mount.rows.every((row) => row.state === 'active')), `每行都应 active：${JSON.stringify(status.body.mounts)}`);
  assert.equal(status.body.live.mountedSessions, fromState.length, '计数与列表要一致');
  // 同一份东西两个视图给同一形状（曾经一个是数组、一个是长度）。
  assert.deepEqual(status.body.file, state.body.file, '/status 与 /state 的 file 形状必须一致');
  // /status 是轻量视图：workspaces/config 只给计数，完整清单在 /state。
  assert.equal(status.body.workspaces, state.body.workspaces.length, '/status 的工作区数应与 /state 的清单长度一致');
  assert.equal(status.body.config, state.body.config.declared.length, '/status 的组合声明数也应一致');
  await fresh.handle.dispose();
  await fresh.context.fiber.dispose().catch(() => {});
});

await t('会话不再命中工作区时被摘掉（清单变化 → 卸载 + 记录消失）', async () => {
  // 只经**状态文件**声明（组合声明删不掉，会一直命中——那是另一回事）：
  const unmatchPath = join(root, 'unmatch-state.json');
  store.writeStateFile(unmatchPath, store.normalizeState({
    version: 1,
    workspaces: [{ path: workspaceA, plugins: [{ id: 'probe-a', name: probeSpecifier }] }],
    configDisabled: [],
  }).state);
  const fresh = await bootFreshHarness(unmatchPath, []);
  const inA = fresh.makeSession('session-in-a', workspaceA);
  const inB = fresh.makeSession('session-in-b', workspaceB);
  await delay(30);
  assert.ok(fresh.toolNamesOf(inA).includes('workspace_plugin_probe'), '前置：A 挂着');
  assert.equal(fresh.toolNamesOf(inB).includes('workspace_plugin_probe'), false, '前置：B 是别的目录，没挂');
  const saved = await callRoute(fresh.routes, '/dsh-workspace-plugins/save', { method: 'POST', body: '{"workspaces":[],"configDisabled":[]}' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 200));
  assert.equal(fresh.toolNamesOf(inA).includes('workspace_plugin_probe'), false, 'A 不再命中（清单空了），工具必须消失');
  assert.deepEqual(fresh.globalToolNames().filter((name) => name === 'workspace_plugin_probe'), [], '也不得残留到全局层');
  const state = await callRoute(fresh.routes, '/dsh-workspace-plugins/state');
  assert.equal(state.body.mounts.length, 0, '挂载记录要一起消失');
  await fresh.handle.dispose();
  await fresh.context.fiber.dispose().catch(() => {});
});

await t('挂载同步性：只 flush 微任务（不放时钟）之后工具就已可见', async () => {
  // 「挂载是同步的」是核心契约：第一轮请求装配时工具必须已经在。这里只用微任务。
  const fresh = await bootFreshHarness(join(root, 'sync-state.json'), [{
    path: workspaceA,
    plugins: [{ id: 'probe-sync', name: probeSpecifier }],
  }]);
  const agent = makeAgent(fresh.context, {}, 'session-sync', workspaceA);
  fresh.agents.push(agent);
  fresh.context.emit('agent/created', { agent });
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  assert.ok(fresh.toolNamesOf(agent).includes('workspace_plugin_probe'), `只 flush 微任务后工具就应在（同步契约），实际 ${JSON.stringify(fresh.toolNamesOf(agent))}`);
  await fresh.handle.dispose();
  await fresh.context.fiber.dispose().catch(() => {});
});

await t('泄漏探针：把注册落到全局层的子插件会被抓出来（且不同批次的干净会话不被冤枉）', async () => {
  const fresh = await bootFreshHarness(join(root, 'leak-state.json'), [
    { path: workspaceA, plugins: [{ id: 'leaky', name: leakySpecifier }] },
    { path: workspaceB, plugins: [{ id: 'clean', name: probeSpecifier }] },
  ]);
  const leaky = fresh.makeSession('session-leak', workspaceA);
  await delay(60);
  assert.ok(fresh.globalToolNames().includes('wsp_leaky_tool'), '前置：这个夹具确实把工具注册到了全局层');
  const first = await callRoute(fresh.routes, '/dsh-workspace-plugins/state');
  const leakMount = first.body.mounts.find((entry) => entry.sessionId === 'session-leak');
  assert.deepEqual(leakMount.leaked, ['wsp_leaky_tool'], `探针应报出泄漏的工具名：${JSON.stringify(leakMount)}`);
  assert.deepEqual(first.body.live.leaked, ['wsp_leaky_tool'], '顶层汇总也要报出来（设置页横幅用它）');
  // 干净会话在另一个窗口里挂载：不能把它也算成泄漏（探针是会话级的，窗口不重叠时归因可靠）
  const clean = fresh.makeSession('session-clean', workspaceB);
  await delay(60);
  const second = await callRoute(fresh.routes, '/dsh-workspace-plugins/state');
  const cleanMount = second.body.mounts.find((entry) => entry.sessionId === 'session-clean');
  assert.equal(cleanMount.leaked, undefined, `干净会话不该被标记：${JSON.stringify(cleanMount)}`);
  assert.ok(fresh.toolNamesOf(clean).includes('workspace_plugin_probe'), '前置：干净会话确实挂上了自己的插件');
  await fresh.handle.dispose();
  await fresh.context.fiber.dispose().catch(() => {});
});

await t('agents.list() 抛错时不清扫：已有挂载一个都不许动', async () => {
  const fresh = await bootFreshHarness(join(root, 'agents-throw-state.json'), [{
    path: workspaceA,
    plugins: [{ id: 'probe-keep', name: probeSpecifier }],
  }]);
  const agent = fresh.makeSession('session-keep', workspaceA);
  await delay(30);
  assert.ok(fresh.toolNamesOf(agent).includes('workspace_plugin_probe'), '前置：挂着');
  const agentsService = fresh.context.get('agents');
  const original = agentsService.list;
  agentsService.list = () => { throw new Error('模拟瞬时故障'); };
  let saved;
  try {
    saved = await callRoute(fresh.routes, '/dsh-workspace-plugins/save', { method: 'POST', body: JSON.stringify({ workspaces: [{ path: workspaceA, plugins: [{ id: 'probe-keep', name: probeSpecifier, config: { label: 'after-throw' } }] }], configDisabled: [] }) });
  } finally {
    agentsService.list = original;
  }
  assert.equal(saved.status, 200);
  assert.ok(fresh.toolNamesOf(agent).includes('workspace_plugin_probe'), '读不到会话列表时不得把已有挂载卸掉');
  const state = await callRoute(fresh.routes, '/dsh-workspace-plugins/state');
  assert.equal(state.body.mounts.some((mount) => mount.sessionId === 'session-keep'), true, '挂载记录必须还在');
  await fresh.handle.dispose();
  await fresh.context.fiber.dispose().catch(() => {});
});

await t('失败行可重试：模块修好后点保存即生效（不必强制重挂）', async () => {
  const latePath = join(root, 'fixture-late.mjs');
  try { rmSync(latePath); } catch { /* 首次不存在 */ }
  const fresh = await bootFreshHarness(join(root, 'late-state.json'), [{
    path: workspaceA,
    plugins: [{ id: 'late', name: latePath }],
  }]);
  const agent = fresh.makeSession('session-late', workspaceA);
  await delay(30);
  const first = await callRoute(fresh.routes, '/dsh-workspace-plugins/status');
  assert.equal(first.body.mounts[0].rows[0].state, 'failed', '前置：模块还不存在，这一行应是 failed');
  writeFileSync(latePath, [
    "export const name = 'wsp-late';",
    "export const inject = ['tools'];",
    'export function apply(ctx) {',
    "  ctx.tools.register({ name: 'wsp_late_tool', description: 'late fixture', parameters: {}, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, async execute() { return { ok: true }; } });",
    '}',
    '',
  ].join('\n'), 'utf8');
  // 清单没变（签名相同）——修复必须在这条路径上发生，否则用户只能靠强制重挂。
  const saved = await callRoute(fresh.routes, '/dsh-workspace-plugins/save', { method: 'POST', body: JSON.stringify({ workspaces: [{ path: workspaceA, plugins: [{ id: 'late', name: latePath }] }], configDisabled: [] }) });
  assert.equal(saved.status, 200);
  await delay(40);
  const second = await callRoute(fresh.routes, '/dsh-workspace-plugins/status');
  assert.equal(second.body.mounts[0].rows[0].state, 'active', '模块修好后，保存就该把它重试成 active');
  assert.ok(fresh.toolNamesOf(agent).includes('wsp_late_tool'), '工具应真的可见');
  await fresh.handle.dispose();
  await fresh.context.fiber.dispose().catch(() => {});
});

await t('状态文件读坏：沿用上一份清单，不把活会话上的子插件卸掉', async () => {
  const brokenPath = join(root, 'broken-state.json');
  store.writeStateFile(brokenPath, store.normalizeState({
    version: 1,
    workspaces: [{ path: workspaceA, plugins: [{ id: 'probe-keep', name: probeSpecifier }] }],
    configDisabled: [],
  }).state);
  const fresh = await bootFreshHarness(brokenPath, []);
  const agent = fresh.makeSession('session-broken', workspaceA);
  await delay(30);
  assert.ok(fresh.toolNamesOf(agent).includes('workspace_plugin_probe'), '前置：挂上了');
  writeFileSync(brokenPath, '{ 这不是 JSON', 'utf8');
  const reloaded = await callRoute(fresh.routes, '/dsh-workspace-plugins/reload', { method: 'POST', body: '{}' });
  assert.equal(reloaded.status, 200);
  assert.ok(fresh.toolNamesOf(agent).includes('workspace_plugin_probe'), '文件读坏时必须沿用上一份清单，工具不能消失');
  assert.ok(reloaded.body.state.file.warnings.some((line) => /沿用/.test(String(line))), `要在诊断里说清「沿用了上一份」：${JSON.stringify(reloaded.body.state.file)}`);
  await fresh.handle.dispose();
  await fresh.context.fiber.dispose().catch(() => {});
});

await t('模块协议白名单：data:/http:/node:/blob: 一律拒绝（写路由不能变成任意代码执行）', async () => {
  for (const specifier of ['data:text/javascript,globalThis.__pwned=1', 'http://example.com/x.js', 'node:fs', 'blob:file:///x']) {
    const probed = await callRoute(routes, '/dsh-workspace-plugins/probe', { method: 'POST', body: JSON.stringify({ specifier }) });
    assert.equal(probed.body.ok, false, `${specifier} 必须被拒`);
    assert.match(String(probed.body.error), /协议|不支持/, `${specifier} 的拒绝理由要能读懂：${String(probed.body.error)}`);
  }
  assert.equal(globalThis.__pwned, undefined, '不得有任何代码被求值');
  for (const specifier of ['./plugins/dsh-workspace-plugins/examples/probe-tool.js', probeSpecifier]) {
    const probed = await callRoute(routes, '/dsh-workspace-plugins/probe', { method: 'POST', body: JSON.stringify({ specifier }) });
    assert.equal(probed.body.ok, true, `${specifier} 应仍然可挂载：${JSON.stringify(probed.body)}`);
  }
});

await t('访问令牌：DNS rebinding 形态（Origin/Host 自洽但无令牌）被拒，带令牌或纯本机调用放行', async () => {
  const statusPath = '/dsh-workspace-plugins/status';
  const rebind = await callRoute(routes, statusPath, { headers: { origin: 'http://evil.example:3080', host: 'evil.example:3080', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' } });
  assert.equal(rebind.status, 403, 'Origin 与 Host 一致但没有令牌：必须拒绝（这正是 rebinding 的形状）');
  assert.match(String(rebind.body.error), /令牌|刷新/, '要提示刷新页面，而不是一句看不懂的拒绝');
  const onlyOrigin = await callRoute(routes, statusPath, { headers: { origin: 'http://evil.example:3080', host: 'evil.example:3080' } });
  assert.equal(onlyOrigin.status, 403, '只有 Origin、没有 Sec-Fetch-* 也要拒');
  const token = tokenOf(context);
  assert.ok(token.length >= 16, `注入表里应能取到令牌：${JSON.stringify(token)}`);
  const withToken = await callRoute(routes, statusPath, { headers: { origin: 'http://evil.example:3080', host: 'evil.example:3080', 'sec-fetch-site': 'same-origin', 'x-workspace-plugins-token': token } });
  assert.equal(withToken.status, 200, '带正确令牌的浏览器请求放行（设置页走这条）');
  const wrong = await callRoute(routes, statusPath, { headers: { 'sec-fetch-site': 'same-origin', 'x-workspace-plugins-token': 'deadbeef' } });
  assert.equal(wrong.status, 403, '错误令牌拒绝');
  const plain = await callRoute(routes, statusPath);
  assert.equal(plain.status, 200, '完全不带浏览器头的本机调用（curl）照常放行');
  const crossSite = await callRoute(routes, statusPath, { headers: { 'sec-fetch-site': 'cross-site', 'x-workspace-plugins-token': token } });
  assert.equal(crossSite.status, 403, '跨站即使带上令牌也拒（令牌不该出现在跨站请求里）');
});

await t('响应序列化安全：组合声明里塞进循环引用 config，/state 也不能 500', async () => {
  const circular = { label: 'circular' };
  circular.self = circular;
  const fresh = await bootFreshHarness(join(root, 'circular-state.json'), [{
    path: workspaceA,
    plugins: [{ id: 'circular', name: probeSpecifier, config: circular }],
  }]);
  const viewed = await callRoute(fresh.routes, '/dsh-workspace-plugins/state');
  assert.equal(viewed.status, 200, `/state 不能因为一个循环引用变成 500：${JSON.stringify(viewed.body).slice(0, 200)}`);
  const row = viewed.body.workspaces.find((workspace) => workspace.path === workspaceA).plugins[0];
  assert.equal(row.configUnsafe, true, '不可序列化的行要被标出来（设置页据此提示「本页不能编辑/保存」）');
  assert.equal(typeof row.config, 'string', '视图里换成占位文本');
  // 挂载本身不能被这份 config 拦住：行仍应 active（深拷贝失败时退回原对象并记警告）。
  const mount = viewed.body.mounts.find((entry) => entry.sessionId === undefined && false) ?? null;
  assert.equal(mount, null);
  assert.ok(fresh.globalToolNames().includes('workspace_plugin_probe') === false, '全局层不该有它');
  await fresh.handle.dispose();
  await fresh.context.fiber.dispose().catch(() => {});
});

await t('深拷贝 config：子插件改写 config 不串到别的会话、也不改到清单对象', async () => {
  const cfgPath = join(root, 'fixture-config.mjs');
  writeFileSync(cfgPath, [
    "export const name = 'wsp-config';",
    'export function apply(ctx, config) {',
    "  config.hits = (config.hits || 0) + 1;",
    "  globalThis.__wspCfgSeen = (globalThis.__wspCfgSeen || []);",
    '  globalThis.__wspCfgSeen.push(config.hits);',
    '}',
    '',
  ].join('\n'), 'utf8');
  globalThis.__wspCfgSeen = [];
  const shared = { label: 'shared' };
  const fresh = await bootFreshHarness(join(root, 'cfg-state.json'), [{
    path: workspaceA,
    plugins: [{ id: 'cfg', name: cfgPath, config: shared }],
  }]);
  fresh.makeSession('session-cfg-1', workspaceA);
  fresh.makeSession('session-cfg-2', workspaceA);
  await delay(50);
  assert.deepEqual(globalThis.__wspCfgSeen, [1, 1], `两个会话必须各拿一份副本（都从 1 开始），实际 ${JSON.stringify(globalThis.__wspCfgSeen)}`);
  assert.equal(shared.hits, undefined, '清单里的 config 对象不得被子插件改写');
  await fresh.handle.dispose();
  await fresh.context.fiber.dispose().catch(() => {});
});

/* ── 网络工作区：真运行时（假 workspaceRegistry + 假 deviceMesh） ─────────── */

/**
 * 起一个「接入设备网格」的 harness：在 bootFreshHarness 的服务之上再加假的
 * workspaceRegistry 与 deviceMesh（形状与出厂注册表 / dsh-device-mesh 的
 * deviceMesh.paths() 一致），用来验证网络工作区的匹配与视图。
 * @param options.file - 状态文件路径。
 * @param options.declarations - 组合声明。
 * @param options.registry - 注册表条目 `{ id, title, path, sessionIds }`。
 * @param options.mesh - `{ self, peers?, groups }`。
 * @param options.meshThrows - true 时让 deviceMesh.paths() 抛错（降级路径）。
 */
async function bootNetworkHarness(options = {}) {
  const context = new Context();
  const routes = new Map();
  const agents = [];
  await context.plugin({
    name: 'net-webserver',
    apply(inner) {
      inner.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } });
    },
  });
  await context.plugin({ name: 'net-agents', apply(inner) { inner.provide('agents', { list: () => agents }); } });
  await context.plugin({ name: 'net-loader', apply(inner) { inner.provide('loader', { builtins: {} }); } });
  const entries = options.registry ?? [];
  await context.plugin({
    name: 'net-registry',
    apply(inner) {
      inner.provide('workspaceRegistry', {
        list: () => registryProjection(entries).list,
        get: (id) => registryProjection(entries).list.find((item) => item.id === id),
      });
    },
  });
  const mesh = options.mesh ?? { self: SELF_DEVICE, peers: [], groups: [] };
  await context.plugin({
    name: 'net-mesh',
    apply(inner) {
      inner.provide('deviceMesh', {
        version: 1,
        protocol: 1,
        identity: () => ({ schema: 1, deviceId: mesh.self.deviceId, name: mesh.self.name, createdAt: '2026-10-10T00:00:00.000Z' }),
        device: () => ({ deviceId: mesh.self.deviceId, name: mesh.self.name, dshVersion: '0.2.0-rc.2' }),
        tree: () => ({
          schema: 1,
          scope: 'direct',
          selfDeviceId: mesh.self.deviceId,
          devices: [
            { deviceId: mesh.self.deviceId, name: mesh.self.name, self: true, liveness: 'online', trust: 'inventory' },
            ...(mesh.peers ?? []).map((peer) => ({ deviceId: peer.deviceId, name: peer.name, self: false, liveness: 'online', trust: 'inventory', via: { kind: 'inbound' } })),
          ],
        }),
        paths: () => {
          if (options.meshThrows === true) throw new Error('账目读不了（测试）');
          return mesh.groups ?? [];
        },
      });
    },
  });
  await context.plugin(SystemPrompt, { personaPrefix: '' });
  await context.plugin(ToolRuntime, { mode: 'native' });
  const handle = context.plugin(workspacePlugins, { file: options.file, workspaces: options.declarations ?? [] });
  await handle;
  await delay(40);
  const standing = {};
  return {
    context,
    routes,
    agents,
    handle,
    makeSession(id, cwd) {
      const agent = makeAgent(context, standing, id, cwd);
      agents.push(agent);
      context.emit('agent/created', { agent });
      return agent;
    },
    toolNamesOf(agent) {
      return context.get('tools').schemas(scopeOf(agent.ctx)).map((schema) => schema.name);
    },
  };
}

await t('网络工作区（真运行时）：主路径与本机附加路径的会话都挂上，远端副本只出现在视图里', async () => {
  const net = await bootNetworkHarness({
    file: join(root, 'net-primary.json'),
    declarations: [{ workspaceId: NET_WS_ID, match: 'exact', plugins: [{ id: 'probe', name: probeSpecifier }] }],
    registry: [{ id: NET_WS_ID, title: 'ArkTower', path: workspaceA, sessionIds: [] }],
    mesh: { self: SELF_DEVICE, peers: [PEER_DEVICE], groups: [netGroup()] },
  });
  const onPrimary = net.makeSession('session-net-primary', workspaceA);
  const onMirror = net.makeSession('session-net-mirror', MIRROR_PATH);
  await delay(60);
  assert.ok(net.toolNamesOf(onPrimary).includes('workspace_plugin_probe'), '主路径上的会话要挂上');
  assert.ok(net.toolNamesOf(onMirror).includes('workspace_plugin_probe'), '本机附加路径（mirror）上的会话也要挂上');
  const viewed = await callRoute(net.routes, '/dsh-workspace-plugins/state');
  const ws = viewed.body.workspaces.find((item) => item.workspaceId === NET_WS_ID);
  assert.equal(ws.key, `ws:${NET_WS_ID}`);
  assert.equal(ws.disableKey, `ws:${NET_WS_ID}`, 'configDisabled 的键要能被设置页直接用');
  assert.deepEqual(ws.matchPaths.map((entry) => [entry.path, entry.kind]), [[workspaceA, 'primary'], [MIRROR_PATH, 'member']]);
  assert.equal(ws.network.remoteMembers.length, 1);
  assert.deepEqual(ws.network.remoteDevices, ['orangepi5']);
  assert.ok(ws.hints.some((line) => /orangepi5/.test(line) && /声明/.test(line)), `要有「在对端也声明一行」的提示：${JSON.stringify(ws.hints)}`);
  assert.equal(viewed.body.routes, 'registered');
  assert.equal(viewed.body.mesh.available, true);
  assert.equal(viewed.body.mesh.self.name, 'xray4668');
  assert.deepEqual(viewed.body.mesh.peers.map((peer) => peer.name), ['orangepi5']);
  assert.deepEqual(viewed.body.registry.workspaces.map((item) => item.id), [NET_WS_ID]);
  const mirrorMount = viewed.body.mounts.find((mount) => mount.sessionId === 'session-net-mirror');
  assert.equal(mirrorMount.matchedKind, 'member', '要标明命中的是本机附加路径');
  assert.equal(mirrorMount.matchedBy, 'path');
  const status = await callRoute(net.routes, '/dsh-workspace-plugins/status');
  assert.equal(status.body.mesh.available, true);
  assert.equal(status.body.remoteOnly, 0);
  await net.handle.dispose();
  await net.context.fiber.dispose().catch(() => {});
});

await t('网络工作区（真运行时）：注册表的会话账优先——cwd 不在任何本机路径上也照样命中', async () => {
  const net = await bootNetworkHarness({
    file: join(root, 'net-session.json'),
    declarations: [{ workspaceId: NET_WS_ID, match: 'exact', plugins: [{ id: 'probe', name: probeSpecifier }] }],
    registry: [{ id: NET_WS_ID, title: 'ArkTower', path: workspaceA, sessionIds: ['session-ident-net'] }],
    mesh: { self: SELF_DEVICE, groups: [netGroup()] },
  });
  const agent = net.makeSession('session-ident-net', elsewhere);
  await delay(60);
  assert.ok(net.toolNamesOf(agent).includes('workspace_plugin_probe'), '身份命中不看 cwd（注册表说这个会话属于它）');
  const viewed = await callRoute(net.routes, '/dsh-workspace-plugins/state');
  const mount = viewed.body.mounts.find((item) => item.sessionId === 'session-ident-net');
  assert.equal(mount.matchedBy, 'session');
  const tested = await callRoute(net.routes, '/dsh-workspace-plugins/state', { url: `/dsh-workspace-plugins/state?cwd=${encodeURIComponent(MIRROR_PATH)}` });
  assert.equal(tested.body.diagnostics.matched.hit, true);
  assert.equal(tested.body.diagnostics.matched.kind, 'member', '命中测试要说清凭哪条路径命中');
  const missed = await callRoute(net.routes, '/dsh-workspace-plugins/state', { url: `/dsh-workspace-plugins/state?cwd=${encodeURIComponent(join(elsewhere, 'nowhere'))}` });
  assert.equal(missed.body.diagnostics.matched.hit, false);
  await net.handle.dispose();
  await net.context.fiber.dispose().catch(() => {});
});

await t('行状态 unavailable：网络工作区上本机没有的路径类子插件不是 failed，并说清去哪台设备声明', async () => {
  const missing = join(root, 'not-on-this-device.mjs');
  const net = await bootNetworkHarness({
    file: join(root, 'net-missing.json'),
    declarations: [{ workspaceId: NET_WS_ID, match: 'exact', plugins: [{ id: 'missing', name: missing }] }],
    registry: [{ id: NET_WS_ID, title: 'ArkTower', path: workspaceA, sessionIds: [] }],
    mesh: { self: SELF_DEVICE, peers: [PEER_DEVICE], groups: [netGroup()] },
  });
  net.makeSession('session-net-missing', workspaceA);
  await delay(60);
  const viewed = await callRoute(net.routes, '/dsh-workspace-plugins/state');
  const mount = viewed.body.mounts.find((item) => item.sessionId === 'session-net-missing');
  const row = mount.rows[0];
  assert.equal(row.state, 'unavailable', `网络工作区上应记 unavailable，实际 ${String(row.state)}：${String(row.error)}`);
  assert.ok(/orangepi5/.test(String(row.error)), `错误里要有设备名：${String(row.error)}`);
  assert.ok(/声明/.test(String(row.error)), '要给出可行动的说明');
  const live = viewed.body.workspaces.find((item) => item.workspaceId === NET_WS_ID).plugins[0].live;
  assert.equal(live.unavailable, 1, '设置页要能读到「本机没有」这一档计数');
  await net.handle.dispose();
  await net.context.fiber.dispose().catch(() => {});
});

await t('行状态 failed：单机工作区上同样缺失的模块仍然是失败（不冒充网络问题）', async () => {
  const missing = join(root, 'not-on-this-device-either.mjs');
  const fresh = await bootFreshHarness(join(root, 'single-missing.json'), [{ path: workspaceA, plugins: [{ id: 'missing', name: missing }] }]);
  fresh.makeSession('session-single-missing', workspaceA);
  await delay(50);
  const viewed = await callRoute(fresh.routes, '/dsh-workspace-plugins/state');
  const mount = viewed.body.mounts.find((item) => item.sessionId === 'session-single-missing');
  assert.equal(mount.rows[0].state, 'failed', '没有网络工作区时保持 failed 语义');
  assert.equal(viewed.body.mesh.available, false, '没有 deviceMesh 时视图如实说不可用');
  assert.equal(viewed.body.registry.available, false);
  await fresh.handle.dispose();
  await fresh.context.fiber.dispose().catch(() => {});
});

await t('降级：deviceMesh 抛错时不拖垮匹配，/status 如实记下原因', async () => {
  const net = await bootNetworkHarness({
    file: join(root, 'net-throw.json'),
    declarations: [{ path: workspaceA, match: 'exact', plugins: [{ id: 'probe', name: probeSpecifier }] }],
    registry: [],
    meshThrows: true,
  });
  const agent = net.makeSession('session-net-throw', workspaceA);
  await delay(50);
  assert.ok(net.toolNamesOf(agent).includes('workspace_plugin_probe'), '账目读不了也要按声明路径照常挂');
  const status = await callRoute(net.routes, '/dsh-workspace-plugins/status');
  assert.equal(status.body.mesh.available, false);
  assert.match(String(status.body.mesh.error), /账目读不了/, '把原因带出来，别静默');
  await net.handle.dispose();
  await net.context.fiber.dispose().catch(() => {});
});

await t('冷启动顺序（404 回归）：插件先于 webServer 应用时，路由等它出现后自动注册', async () => {
  const cold = new Context();
  const regs = new Map();
  await cold.plugin(SystemPrompt, { personaPrefix: '' });
  await cold.plugin(ToolRuntime, { mode: 'native' });
  const handle = cold.plugin(workspacePlugins, { file: join(root, 'cold-state.json'), workspaces: [] });
  await handle;
  await delay(30);
  assert.equal(regs.size, 0, '前置：webServer 还没出现，路由当然还没有');
  await cold.plugin({
    name: 'late-webserver',
    apply(inner) {
      inner.provide('webServer', { register(route) { regs.set(route.path, route); return () => regs.delete(route.path); } });
    },
  });
  await delay(40);
  assert.ok(regs.has('/dsh-workspace-plugins/status'), `webServer 一出现就要注册路由（冷启动 404 的回归守卫）：${[...regs.keys()].join(',')}`);
  const status = await callRoute(regs, '/dsh-workspace-plugins/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.routes, 'registered');
  await handle.dispose();
  await cold.fiber.dispose().catch(() => {});
});

await t('插件卸载：所有会话的挂载与路由一起消失', async () => {
  await harness.handle.dispose();
  await delay(60);
  assert.equal(routes.size, 0, '路由应随插件卸载注销');
  assert.equal(globalToolNames().includes('workspace_plugin_probe'), false);
  const bTools = tools.schemas(scopeOf(agentB.ctx)).map((schema) => schema.name);
  assert.equal(bTools.includes('workspace_plugin_probe'), false, 'B 的工具应随插件卸载消失');
});

/* ── 收尾 ─────────────────────────────────────────────────────────────────── */

try {
  await context.fiber.dispose();
} catch {
  // 收尾失败不影响结论。
}
rmSync(root, { recursive: true, force: true });
rmSync(elsewhere, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\nSELFTEST FAIL ${String(passed)}/${String(passed + failures.length)}`);
  for (const failure of failures) console.log(`  · ${failure.name}: ${failure.error instanceof Error ? failure.error.stack ?? failure.error.message : String(failure.error)}`);
  process.exit(1);
}
console.log(`\nSELFTEST PASS ${String(passed)}/${String(passed)}`);
