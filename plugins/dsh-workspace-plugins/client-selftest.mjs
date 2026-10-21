/**
 * dsh-workspace-plugins 浏览器半边自测（无头）。
 *
 *   node plugins/dsh-workspace-plugins/client-selftest.mjs
 *
 * 设置页那一半的代码只有真浏览器才会渲染，但**能出错的部分**大多是纯逻辑：
 * 界面草稿 → 状态文件载荷的转换与校验、状态徽章判定、槽位注册参数、样式注入。
 * 这里用一个最小的 `window.__ModuleLoader__` + React 桩把 client.js 的工厂函数
 * 真跑一遍（不渲染组件），把上面这些逐条断言，避免「保存后被 host 拒绝」或者
 * 「装上了但设置页没有这一节」这类只有点开界面才知道的错。
 *
 * @module dsh-workspace-plugins/client-selftest
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// 测试用的固定身份（与真实部署同形：两台设备、同一个工作区 UUID 各自有路径）。
const SELF_ID = 'bf7e92cf6de979871eb225736373ffc0';
const PEER_ID = 'a0d8c46c63f4f6e66b1b4dcc6ea14114';
const WS_ID = '863de1b8-a5f4-4560-beb7-fda46cf99189';
const PEER_ONLY_ID = '5f0d2c31-9a44-4b27-8f6e-1c2d3e4f5a6b';

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

/* ── 装一个最小的模块加载器与 React 桩 ─────────────────────────────────────── */

let stylesInjected = 0;
// 渲染自测需要一个「可编排的 hook 脚本」：按声明顺序把指定值喂给 useState。
let hookScript = [];
let hookCursor = 0;
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => {
    const index = hookCursor;
    hookCursor += 1;
    const value = index < hookScript.length ? hookScript[index] : (typeof initial === 'function' ? initial() : initial);
    return [value, () => {}];
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value === undefined ? null : value }),
  useEffect: () => {},
};

/** 把组件渲染成一棵元素树，并把所有文本节点收集成一个字符串（渲染崩溃会直接抛）。 */
function render(element) {
  const parts = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    if (typeof node === 'object') {
      if (typeof node.type === 'function') { walk(node.type(node.props ?? {})); return; }
      walk(node.children);
      return;
    }
    parts.push(String(node));
  };
  walk(element);
  return parts.join(' ');
}

/** 按 hook 脚本渲染一次页面组件。 */
function renderPage(values) {
  hookScript = values;
  hookCursor = 0;
  return render(fakeReact.createElement(ui.Page, {}));
}
const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded.push(definition);
      globalThis.__wspExports = definition.factory((name) => {
        if (name === 'react') return fakeReact;
        throw new Error(`未预期的 require：${name}`);
      });
    },
  },
};
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => { stylesInjected += 1; } },
};

const clientUrl = pathToFileURL(join(here, 'client.js')).href;
await import(clientUrl);
const ui = globalThis.__wspExports.__ui;
const moduleExports = globalThis.__wspExports;

console.log('── client.js 装载与槽位注册 ─────────────────────────────────────');

await t('工厂函数可加载，导出 apply/inject/__ui', () => {
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'dsh-workspace-plugins');
  assert.equal(typeof moduleExports.apply, 'function');
  assert.deepEqual(moduleExports.inject, ['slots']);
  assert.equal(typeof ui.Page, 'function');
  assert.ok(ui.css.length > 5);
});

await t('apply 注册「设置」一节并注入样式（order 30，可被卸载）', () => {
  const registrations = [];
  const effects = [];
  const ctx = {
    effect(fn, label) {
      effects.push(label);
      return fn();
    },
    slots: {
      inject(name, fn) {
        assert.equal(name, 'settings.section');
        return fn();
      },
      register(fields, Component) {
        registrations.push({ fields, Component });
        return () => {};
      },
    },
  };
  moduleExports.apply(ctx);
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].fields, { name: 'settings.section', id: 'workspace-plugins', order: 30, label: '工作区插件' });
  assert.equal(registrations[0].Component().type, ui.Page, '注册的组件应渲染本插件的页面');
  assert.equal(stylesInjected, 1, '样式应被注入一次');
  assert.ok(effects.some((label) => String(label).includes('page css')));
});

console.log('\n── 纯逻辑：草稿 ↔ 状态文件 ──────────────────────────────────────');

await t('rowToState：config/isolate 文本解析与错误收集', () => {
  const ok = ui.rowToState({ id: 'probe', name: './p.js', configText: '{"label":"x"}', isolateText: 'wsp.demo, cache=shared' }, 'w1');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.row, { id: 'probe', name: './p.js', config: { label: 'x' }, isolate: { 'wsp.demo': true, cache: 'shared' } });
  const empty = ui.rowToState(ui.emptyRow(), 'w1');
  assert.deepEqual(empty.row, { id: '', name: '' }, '空模板应只产生 id/name 两个字段（由校验兜住）');
  assert.ok(ui.rowToState({ id: 'a', name: 'n.js', configText: '{bad' }, 'w1').errors.length > 0, '坏 JSON 应报错');
  assert.ok(ui.rowToState({ id: 'a', name: 'n.js', configText: '[1,2]' }, 'w1').errors.length > 0, 'config 必须是对象而不是数组');
  assert.ok(ui.rowToState({ id: 'bad id', name: 'n.js' }, 'w1').errors.length > 0, '坏 id 应报错');
  assert.ok(ui.rowToState({ id: 'a', name: '' }, 'w1').errors.length > 0, '空模块标识应报错');
  const disabled = ui.rowToState({ id: 'a', name: 'n.js', disabled: true }, 'w1');
  assert.equal(disabled.row.disabled, true);
});

await t('draftToState：拒绝相对路径、空工作区、重复 id；子树按子树写', () => {
  const good = ui.draftToState([{ path: '/root/ws', match: 'subtree', plugins: [ui.stateToRow({ id: 'a', name: './a.js' })] }]);
  assert.deepEqual(good.errors, []);
  assert.equal(good.workspaces[0].match, 'subtree');
  assert.deepEqual(good.workspaces[0].plugins, [{ id: 'a', name: './a.js' }]);
  assert.ok(ui.draftToState([{ path: 'relative/dir', plugins: [ui.stateToRow({ id: 'a', name: './a.js' })] }]).errors.length > 0);
  assert.ok(ui.draftToState([{ path: '/root/ws', plugins: [] }]).errors.length > 0, '没有行的工作区应被拒');
  const dup = ui.draftToState([{ path: '/root/ws', plugins: [ui.stateToRow({ id: 'a', name: './a.js' }), ui.stateToRow({ id: 'a', name: './b.js' })] }]);
  assert.ok(dup.errors.some((line) => line.includes('id 重复')));
  const tilde = ui.draftToState([{ path: '~/ws', plugins: [ui.stateToRow({ id: 'a', name: './a.js' })] }]);
  assert.deepEqual(tilde.errors, [], '~/ 开头的路径应被接受');
});

await t('stateToRow ↔ fileToDraft：往返不丢字段（config/isolate/disabled）', () => {
  const fileState = {
    version: 1,
    configDisabled: ['/root/a#cfg'],
    workspaces: [{ path: '/root/a', match: 'subtree', plugins: [{ id: 'r', name: './r.js', disabled: true, config: { k: 1 }, isolate: { s: true, t: 'label' } }] }],
  };
  const draft = ui.fileToDraft(fileState);
  assert.equal(draft.length, 1);
  assert.equal(draft[0].match, 'subtree');
  const row = draft[0].plugins[0];
  assert.equal(row.id, 'r');
  assert.equal(row.disabled, true);
  assert.equal(row.configText, '{"k":1}');
  assert.equal(row.isolateText, 's, t=label');
  const back = ui.draftToState(draft);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.workspaces[0].plugins[0], { id: 'r', name: './r.js', disabled: true, config: { k: 1 }, isolate: { s: true, t: 'label' } });
  assert.deepEqual(ui.fileToDraft(undefined), [], '缺状态文件时应得到空草稿而不是抛错');
  assert.deepEqual(ui.fileToDraft({ version: 1, workspaces: [], configDisabled: [] }), []);
});

await t('workspaceKeyOf/disableKeyOf/workspaceTitleOf：身份绑定的键与本机显示名', () => {
  assert.equal(ui.workspaceKeyOf({ path: '/root/a' }), 'path:/root/a');
  assert.equal(ui.workspaceKeyOf({ workspaceId: WS_ID, path: '/root/a' }), 'ws:' + WS_ID, '有 id 就以身份为键（路径只是线索）');
  assert.equal(ui.disableKeyOf({ path: '/root/a' }), '/root/a', 'configDisabled 的键要跟 v6 的裸路径一致（老状态文件不用迁移）');
  assert.equal(ui.disableKeyOf({ workspaceId: WS_ID, path: '/root/a' }), 'ws:' + WS_ID);
  assert.equal(ui.workspaceTitleOf({ path: '/root/a', workspaceId: WS_ID }), '/root/a');
  assert.equal(ui.workspaceTitleOf({ path: null, registryPath: '/srv/x', workspaceId: WS_ID }), '/srv/x');
  assert.match(ui.workspaceTitleOf({ path: null, workspaceId: WS_ID }), /本机无路径/, '本机没有路径时要说清，而不是显示空白');
  assert.match(ui.workspaceTitleOf({ workspaceId: WS_ID }), /^工作区 /);
});

await t('draftToState：按工作区 id 绑定可无路径保存；坏 id 被拒；includeMembers 只写 false', () => {
  const onlyId = ui.draftToState([{ path: '', workspaceId: WS_ID, plugins: [ui.stateToRow({ id: 'a', name: './a.js' })] }]);
  assert.deepEqual(onlyId.errors, []);
  assert.equal(onlyId.workspaces[0].workspace, WS_ID);
  assert.equal('path' in onlyId.workspaces[0], false, '只按 id 绑定时不该往文件里写空路径');
  assert.equal('includeMembers' in onlyId.workspaces[0], false, '默认开启不写进文件（保持干净）');
  const both = ui.draftToState([{ path: '/root/a', workspaceId: WS_ID, plugins: [ui.stateToRow({ id: 'a', name: './a.js' })] }]);
  assert.deepEqual(both.errors, []);
  assert.equal(both.workspaces[0].path, '/root/a');
  assert.equal(both.workspaces[0].workspace, WS_ID);
  const off = ui.draftToState([{ path: '/root/a', workspaceId: '', includeMembers: false, plugins: [ui.stateToRow({ id: 'a', name: './a.js' })] }]);
  assert.equal(off.workspaces[0].includeMembers, false, '关掉附加路径要显式写下来');
  const badId = ui.draftToState([{ path: '/root/a', workspaceId: '不是 id！', plugins: [ui.stateToRow({ id: 'a', name: './a.js' })] }]);
  assert.ok(badId.errors.some((line) => /工作区 id/.test(line)), `坏 id 要给出形如 uuid 的说明：${JSON.stringify(badId.errors)}`);
  const neither = ui.draftToState([{ path: '', workspaceId: '', plugins: [ui.stateToRow({ id: 'a', name: './a.js' })] }]);
  assert.ok(neither.errors.some((line) => /至少要给路径或工作区 id/.test(line)), '两个都给空时必须拒绝');
});

await t('fileToDraft ↔ draftToState：workspaceId/includeMembers 往返不丢', () => {
  const fileState = { version: 1, workspaces: [{ workspace: WS_ID, path: '/srv/a', match: 'exact', plugins: [{ id: 'a', name: './a.js' }] }], configDisabled: [] };
  const draft = ui.fileToDraft(fileState);
  assert.equal(draft[0].workspaceId, WS_ID);
  assert.equal(draft[0].path, '/srv/a');
  assert.equal(draft[0].includeMembers, true, '缺字段按默认（含本机附加路径）解释');
  const back = ui.draftToState(draft);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.workspaces[0], { match: 'exact', plugins: [{ id: 'a', name: './a.js' }], path: '/srv/a', workspace: WS_ID });
  const noMembers = ui.fileToDraft({ version: 1, workspaces: [{ workspace: WS_ID, includeMembers: false, plugins: [{ id: 'a', name: './a.js' }] }], configDisabled: [] });
  assert.equal(noMembers[0].includeMembers, false);
  assert.equal(noMembers[0].path, '', '只按 id 绑定的声明在草稿里路径为空串');
  assert.deepEqual(ui.draftToState(noMembers).workspaces[0], { match: 'exact', plugins: [{ id: 'a', name: './a.js' }], workspace: WS_ID, includeMembers: false });
  assert.match(ui.workspaceKeyOf(noMembers[0]), /^ws:/, '空路径的草稿也要有稳定键（否则渲染时对不上 host 视图）');
});

console.log('\n── 纯逻辑：展示文案 ─────────────────────────────────────────────');

await t('rowStateText：组合冲突/停用/无命中/生效/失败/等待各有正确档位', () => {
  assert.equal(ui.rowStateText({ conflict: true }).tone, 'bad');
  assert.equal(ui.rowStateText({ disabled: true }).text, '已停用');
  assert.equal(ui.rowStateText({}).text, '无命中会话');
  assert.equal(ui.rowStateText({ live: { total: 2, active: 2, failed: 0, waiting: 0, pending: 0 } }).tone, 'on');
  assert.equal(ui.rowStateText({ live: { total: 2, active: 1, failed: 1, waiting: 0, pending: 0 } }).tone, 'bad');
  assert.equal(ui.rowStateText({ live: { total: 1, active: 0, failed: 0, waiting: 1, pending: 0 } }).tone, 'warn');
  assert.match(ui.rowStateText({ live: { total: 3, active: 1, failed: 0, waiting: 0, pending: 2 } }).text, /挂载中/);
});

await t('deviceText/meshLine：网络维度文案（不可用时如实说、不编数据）', () => {
  assert.equal(ui.deviceText({ network: null }), null, '单机部署不显示设备行');
  const text = ui.deviceText({ network: { homeLocal: false, homeDeviceName: 'orangepi5', remoteDevices: ['orangepi5'], available: true } });
  assert.match(text, /主路径在 orangepi5/);
  assert.match(text, /远端副本：orangepi5/);
  assert.match(ui.deviceText({ network: { homeLocal: true, homeDeviceName: 'xray4668', remoteDevices: [], available: true } }), /本机为主/);
  const offline = ui.meshLine({ mesh: { available: false, error: '没装网格插件' }, registry: { available: true, workspaces: [{ id: 'a' }] } });
  assert.match(offline, /设备：单机（设备网格不可用：没装网格插件）/);
  assert.match(offline, /本机注册表：1 个工作区/);
  const online = ui.meshLine({ mesh: { available: true, self: { deviceId: SELF_ID, name: 'xray4668' }, peers: [{ name: 'orangepi5', liveness: 'online' }], groups: 4, remoteMembers: 4 }, registry: { available: false, error: '注册表没起来' } });
  assert.match(online, /本机 xray4668/);
  assert.match(online, /接入 1 台（orangepi5\/online）/);
  assert.match(online, /工作区账目 4 组、远端副本 4 条/);
  assert.match(online, /本机注册表：不可用（注册表没起来）/);
  assert.doesNotThrow(() => ui.meshLine(undefined), '缺 state 也不能抛');
});

await t('matchText/sourceText/moduleText/sessionLine 文案', () => {
  assert.match(ui.matchText('subtree'), /子树/);
  assert.match(ui.matchText('exact'), /精确/);
  assert.equal(ui.sourceText('config'), '组合配置');
  assert.equal(ui.sourceText('file'), '设置页');
  assert.equal(ui.sourceText('both'), '组合配置 + 设置页');
  assert.match(ui.moduleText({ state: 'ok', pluginShape: { apply: 'function', inject: ['tools'] } }), /apply 就绪/);
  assert.match(ui.moduleText({ state: 'failed', error: 'boom' }), /导入失败：boom/);
  const line = ui.sessionLine({ rows: [{ id: 'a', state: 'active' }, { id: 'b', state: 'failed', error: '撞车' }, { id: 'c', state: 'waiting', waitingFor: ['svc'] }] });
  assert.match(line, /a=生效/);
  assert.match(line, /b=失败（撞车）/);
  assert.match(line, /c=等待服务（缺 svc）/);
  const netLine = ui.sessionLine({ rows: [{ id: 'a', state: 'unavailable', error: 'Cannot find module（本机没有）' }] });
  assert.match(netLine, /a=本机没有（Cannot find module（本机没有））/, '「本机没有」要连原因一起说，别只给一个词');
});

await t('rowStateText：unavailable 单独一档（预警色，不冒充失败）', () => {
  const live = { total: 2, active: 1, failed: 0, unavailable: 1, waiting: 0, pending: 0 };
  assert.equal(ui.rowStateText({ live }).tone, 'warn');
  assert.match(ui.rowStateText({ live }).text, /1 本机没有（网络工作区）/);
  assert.equal(ui.rowStateText({ live: { total: 1, active: 0, failed: 1, unavailable: 1, waiting: 0, pending: 0 } }).tone, 'bad', '真失败优先压过「本机没有」');
  assert.equal(ui.STATE_TEXT.unavailable, '本机没有');
});

await t('catalogText：候选模块一行一个', () => {
  assert.equal(ui.catalogText({ catalog: ['./a.js', './b.js'] }), './a.js\n./b.js');
  assert.equal(ui.catalogText({}), '');
});

await t('页面源码不含常见禁忌（TS 语法、JSX、宿主全局）', () => {
  const source = readFileSync(join(here, 'client.js'), 'utf8');
  assert.equal(/:\s*(string|number|boolean)\b/.test(source), false, '不应出现 TS 类型标注');
  assert.equal(source.includes('</'), false, '不应出现 JSX 闭合标签');
  assert.equal(/\brequire\(['"](?!react)/.test(source), false, '除 react 外不应 require 别的模块');
  assert.match(source, /React\.createElement|const h = React\.createElement/);
  assert.equal(/innerHTML|dangerouslySetInnerHTML/.test(source), false, '不应直接注入 HTML');
});

/* ── 渲染自测：页面组件本身能不能画出来 ──────────────────────────────────── */

/** 一份与 host `/state` 同形状的样例（含冲突行、等待服务行、泄漏行、挂载明细）。 */
function stateFixture() {
  const fileState = {
    version: 1,
    workspaces: [{
      // 文件里按**工作区 id** 绑定（跨设备一致）；path 只是本机的线索。
      workspace: WS_ID,
      path: '/root/DSHpluginWorkSpace',
      match: 'exact',
      plugins: [
        { id: 'probe', name: './plugins/dsh-workspace-plugins/examples/probe-tool.js', config: { label: 'ui' }, isolate: { wspState: true } },
        { id: 'off-row', name: './plugins/off.js', disabled: true },
      ],
    }],
    configDisabled: [],
  };
  return {
    name: 'workspace-plugins',
    build: 'wsp-5',
    version: 1,
    baseUrl: 'file:///root/.dsh/profiles/web/',
    statePath: '/root/.dsh/workspace-plugins.json',
    file: { exists: true, bytes: 360, errors: [], warnings: [] },
    routes: 'registered',
    mesh: {
      available: true,
      error: null,
      self: { deviceId: SELF_ID, name: 'xray4668' },
      peers: [{ deviceId: PEER_ID, name: 'orangepi5', liveness: 'online' }],
      devices: [{ deviceId: SELF_ID, name: 'xray4668', self: true }, { deviceId: PEER_ID, name: 'orangepi5', self: false }],
      groups: 4,
      remoteMembers: 4,
    },
    registry: {
      available: true,
      error: null,
      workspaces: [
        { id: WS_ID, title: 'DSHpluginWorkSpace', path: '/root/DSHpluginWorkSpace', sessionIds: ['session-render-1'] },
        { id: PEER_ONLY_ID, title: '对端专属工作区', path: '/srv/peer-only', sessionIds: [] },
      ],
    },
    fileState,
    config: {
      errors: [],
      declared: [{
        path: '/root/nas/ArkTower',
        match: 'subtree',
        label: 'ArkTower',
        plugins: [{ id: 'deploy', name: './plugins/dsh-ark-deploy/index.js', disabled: false, conflict: true }],
      }],
    },
    workspaces: [
      {
        key: 'ws:' + WS_ID,
        disableKey: 'ws:' + WS_ID,
        workspaceId: WS_ID,
        title: 'DSHpluginWorkSpace',
        registryPath: '/root/DSHpluginWorkSpace',
        includeMembers: true,
        remoteOnly: false,
        path: '/root/DSHpluginWorkSpace',
        match: 'exact',
        source: 'file',
        sessions: 2,
        matchPaths: [
          { path: '/root/DSHpluginWorkSpace', kind: 'primary', source: 'registry', role: null, deviceId: SELF_ID, deviceName: 'xray4668', prefer: false, exists: true },
          { path: '/root/DSHpluginWorkSpace', kind: 'member', source: 'mesh', role: 'mirror', deviceId: SELF_ID, deviceName: 'xray4668', prefer: true, exists: true },
        ],
        network: {
          available: true,
          homeDeviceId: PEER_ID,
          homeDeviceName: 'orangepi5',
          homeLocal: false,
          localMembers: [{ id: 'm-local', deviceId: SELF_ID, deviceName: 'xray4668', path: '/root/DSHpluginWorkSpace', role: 'mirror', prefer: true }],
          remoteMembers: [{ id: 'm-peer', deviceId: PEER_ID, deviceName: 'orangepi5', path: '/root/DSHpluginWorkSpace', role: 'mirror', prefer: false }],
          remoteDevices: ['orangepi5'],
          hint: '「/root/DSHpluginWorkSpace」在 orangepi5 上也有一份（mirror）：想让它在那边也挂上这些插件，请在对端的 profile 里声明同一行。',
        },
        hints: ['该工作区的路径账目里有一份在 orangepi5 上：插件文件与本机缺失的模块不会跨设备传递，对端要各声明一行。'],
        plugins: [
          { id: 'probe', name: './x.js', source: 'file', disabled: false, live: { total: 2, active: 1, pending: 0, waiting: 1, failed: 0, unavailable: 0, skipped: 0, errors: [], waitingFor: ['someService'], leaked: ['some_tool'] } },
          { id: 'off-row', name: './off.js', source: 'file', disabled: true, live: { total: 0, active: 0, pending: 0, waiting: 0, failed: 0, unavailable: 0, skipped: 0, errors: [], waitingFor: [], leaked: [] } },
        ],
      },
      {
        key: 'path:/root/nas/ArkTower',
        disableKey: '/root/nas/ArkTower',
        workspaceId: null,
        title: null,
        registryPath: null,
        includeMembers: true,
        remoteOnly: false,
        path: '/root/nas/ArkTower',
        match: 'subtree',
        source: 'config',
        sessions: 0,
        matchPaths: [{ path: '/root/nas/ArkTower', kind: 'primary', source: 'declared', role: null, deviceId: SELF_ID, deviceName: 'xray4668', prefer: false, exists: false }],
        network: { available: true, homeDeviceId: SELF_ID, homeDeviceName: 'xray4668', homeLocal: true, localMembers: [], remoteMembers: [], remoteDevices: [], hint: null },
        hints: [],
        plugins: [{ id: 'deploy', name: './plugins/dsh-ark-deploy/index.js', source: 'config', disabled: false, conflict: true, live: { total: 0, active: 0, pending: 0, waiting: 0, failed: 0, unavailable: 0, skipped: 0, errors: [], waitingFor: [], leaked: [] } }],
      },
      {
        // 本机没有路径的网络工作区：永远挂不上，但要在页面上说清为什么。
        key: 'ws:' + PEER_ONLY_ID,
        disableKey: 'ws:' + PEER_ONLY_ID,
        workspaceId: PEER_ONLY_ID,
        title: '对端专属工作区',
        registryPath: null,
        includeMembers: true,
        remoteOnly: true,
        path: null,
        match: 'exact',
        source: 'config',
        sessions: 0,
        matchPaths: [],
        network: {
          available: true,
          homeDeviceId: PEER_ID,
          homeDeviceName: 'orangepi5',
          homeLocal: false,
          localMembers: [],
          remoteMembers: [{ id: 'm-peer-only', deviceId: PEER_ID, deviceName: 'orangepi5', path: '/srv/peer-only', role: 'mirror', prefer: true }],
          remoteDevices: ['orangepi5'],
          hint: '这份声明在本机没有任何路径：本机不会挂上任何会话（要挂请在本机加一条 mirror 路径，或在对端声明同一行）。',
        },
        hints: ['本机没有它的任何路径——这份声明在本机永远不会命中任何会话。'],
        plugins: [{ id: 'peer-row', name: './peer-only.js', source: 'config', disabled: false, live: { total: 1, active: 0, pending: 0, waiting: 0, failed: 0, unavailable: 1, skipped: 0, errors: ['Cannot find module'], waitingFor: [], leaked: [] } }],
      },
    ],
    mounts: [{
      sessionId: 'session-render-1',
      cwd: '/root/DSHpluginWorkSpace',
      workspace: '/root/DSHpluginWorkSpace',
      workspaceId: WS_ID,
      key: 'ws:' + WS_ID,
      mode: 'exact',
      matchedBy: 'session',
      matchedPath: '/root/DSHpluginWorkSpace',
      matchedKind: 'primary',
      rows: [
        { id: 'probe', name: './x.js', source: 'file', state: 'active' },
        { id: 'peer-row', name: './peer-only.js', source: 'config', state: 'unavailable', error: 'Cannot find module（本机没有这个模块；它在 orangepi5 上——请在那台设备上声明同一行）' },
      ],
    }],
    modules: [
      { specifier: './plugins/dsh-workspace-plugins/examples/probe-tool.js', state: 'ok', attempts: 1, pluginShape: { apply: 'function', name: 'workspace-plugin-probe' } },
      { specifier: './plugins/broken.js', state: 'failed', attempts: 2, error: 'Cannot find module' },
    ],
    live: { agents: 12, mountedSessions: 1 },
    catalog: ['dsh-workspace-context', 'dsh-model-pool'],
    diagnostics: { startedAt: '2026-10-09T00:00:00.000Z', refreshes: 3, routeErrors: 0, mountDecisions: 9, lastError: null, lastRefreshAt: '2026-10-09T01:00:00.000Z', lastRefreshReason: 'save' },
  };
}

/** 一份「字段都缺」的样例：host 换版本时页面不该整节炸掉。 */
function sparseStateFixture() {
  return { name: 'workspace-plugins', build: 'wsp-5', version: 1, baseUrl: 'file:///x/', statePath: '/x.json', fileState: { version: 1 } };
}

await t('渲染：加载中视图不抛错且给出等待文案', () => {
  const text = renderPage([]);
  assert.match(text, /正在读取工作区插件状态/);
});

await t('渲染：已加载视图（含挂载明细、冲突行、等待服务、泄漏提示）不抛错', () => {
  const state = stateFixture();
  const text = renderPage([state, ui.fileToDraft(state.fileState), [], false, '', '', false, {}, '', null, '', 'exact', false]);
  for (const needle of ['工作区插件', '保存', state.statePath, '/root/nas/ArkTower', '组合配置', 'probe', '命中测试', '活会话挂载（1）', 'session-render-1', '等待的服务', '展开诊断', '已停用']) {
    assert.ok(text.includes(needle), `已加载视图应渲染出「${needle}」：${text.slice(0, 400)}`);
  }
});

await t('渲染：网络工作区（设备归属、本机匹配路径、远端提示、本机没有的行）要素齐全', () => {
  const state = stateFixture();
  const text = renderPage([state, ui.fileToDraft(state.fileState), [], false, '', '', false, {}, '', null, '', 'exact', false, '', true]);
  for (const needle of [
    '设备：本机 xray4668',
    '接入 1 台（orangepi5/online）',
    '工作区账目 4 组、远端副本 4 条',
    '本机注册表：2 个工作区（可按 id 绑定）',
    'id ' + WS_ID.slice(0, 8),
    '网络 · orangepi5',
    '本机无路径',
    '本机匹配路径：',
    '附加路径 mirror，优先',
    '目录不存在',
    '本机没有它的任何路径——这份声明在本机永远不会命中任何会话。',
    '本机没有',
    'Cannot find module',
    '身份命中（注册表）',
    '工作区 ' + PEER_ONLY_ID + '（本机无路径）',
    '工作区标题：对端专属工作区',
  ]) {
    assert.ok(text.includes(needle), `网络视图应渲染出「${needle}」`);
  }
  assert.match(text, /命中[^」]*归属|按注册表的会话归属命中|要填一个目录/, '命中测试区域要能解释命中依据');
});

await t('渲染：命中测试命中时说明凭什么（身份/附加路径）', () => {
  const state = stateFixture();
  const info = { hit: true, workspace: '/root/DSHpluginWorkSpace', workspaceId: WS_ID, mode: 'exact', by: 'session', kind: 'member', matchedPath: '/root/DSHpluginWorkSpace', plugins: ['probe'] };
  const text = renderPage([state, ui.fileToDraft(state.fileState), [], false, '', '', false, {}, '/root/DSHpluginWorkSpace', info, '', 'exact', false, '', true]);
  assert.ok(text.includes('按注册表的会话归属命中'), `要说清是身份命中：${text.slice(0, 200)}`);
  assert.ok(text.includes('工作区 id：' + WS_ID), '要把 id 显示出来（想跨设备一致就按它绑定）');
  assert.ok(text.includes('会挂上：'), '仍然要列出会挂上什么');
});

await t('渲染：未命中时把网络提示带出来（而不是只说未命中）', () => {
  const state = stateFixture();
  const info = { hit: false, hints: ['本机的路径账目里没有它；orangepi5 上有一份：请在那台设备上声明同一行。'] };
  const text = renderPage([state, ui.fileToDraft(state.fileState), [], false, '', '', false, {}, '/srv/other', info, '', 'exact', false, '', true]);
  assert.ok(text.includes('未命中任何工作区'), '仍然要说未命中');
  assert.ok(text.includes('请在那台设备上声明同一行'), `未命中时的网络提示要带出来：${text.slice(0, 300)}`);
});

await t('渲染：路由未注册时给出红字（冷启动 404 的形状）', () => {
  const state = stateFixture();
  state.routes = 'waiting';
  const text = renderPage([state, ui.fileToDraft(state.fileState), [], false, '', '', false, {}, '', null, '', 'exact', false, '', true]);
  assert.ok(text.includes('设置页路由状态异常：waiting'), '路由没注册时要明说（否则用户只会看到一堆空数据）');
  state.routes = 'registered';
});

await t('渲染：展开诊断不抛错（含模块预导入与候选模块）', () => {
  const state = stateFixture();
  const text = renderPage([state, ui.fileToDraft(state.fileState), [], false, '', '', false, {}, '', null, '', 'exact', true]);
  for (const needle of ['模块预导入（2）', 'workspace-plugin-probe', 'Cannot find module', '诊断', '刷新次数', '候选本地模块', 'dsh-model-pool', '设置页路由：registered', '本机工作区注册表：2 个工作区', '设备网格：本机 xray4668', '远端副本 4 条']) {
    assert.ok(text.includes(needle), `诊断区应渲染出「${needle}」：${text.slice(-400)}`);
  }
});

await t('渲染：字段残缺的 state 不整节崩（容错分支）', () => {
  const state = sparseStateFixture();
  const text = renderPage([state, ui.fileToDraft(state.fileState), [], false, '读状态失败：500', '', false, {}, '', null, '', 'exact', true]);
  assert.match(text, /读状态失败/);
  assert.match(text, /没有已挂载的会话|活会话挂载/);
});

await t('渲染：全局泄漏与会话明细一起显示（横幅 + 明细行）', () => {
  const state = stateFixture();
  state.live.leaked = ['wsp_leaky_tool'];
  state.mounts[0].leaked = ['wsp_leaky_tool'];
  const text = renderPage([state, ui.fileToDraft(state.fileState), [], false, '', '', false, {}, '', null, '', 'exact', false]);
  assert.ok(text.includes('疑似有子插件把注册落到了进程全局层'), `要有页首横幅：${text.slice(0, 300)}`);
  assert.ok(text.includes('wsp_leaky_tool'), '要点出具体的工具名');
  assert.ok(text.includes('不定位到具体的行'), '要说明为什么不定位到行（窗口按时间切）');
});

await t('渲染：config 不可序列化的行被标红（本页不编辑/不保存）', () => {
  const state = stateFixture();
  state.workspaces[0].plugins[0].configUnsafe = true;
  state.fileState.workspaces[0].plugins[0].configUnsafe = true;
  state.fileState.workspaces[0].plugins[0].config = '[占位]';
  const text = renderPage([state, ui.fileToDraft(state.fileState), [], false, '', '', false, {}, '', null, '', 'exact', false]);
  assert.ok(text.includes('含无法序列化的值'), `要有明确提示：${text.slice(0, 400)}`);
});

await t('草稿保存：含 configUnsafe 的行一律拒绝（不静默丢 config）', () => {
  const draft = ui.fileToDraft({ version: 1, workspaces: [{ path: '/root/x', match: 'exact', plugins: [{ id: 'a', name: './a.js' }] }], configDisabled: [] });
  assert.equal(ui.draftToState(draft).errors.length, 0, '前置：正常情况下可保存');
  draft[0].plugins[0].configUnsafe = true;
  const blocked = ui.draftToState(draft);
  assert.equal(blocked.state, null);
  assert.ok(blocked.errors.some((line) => /无法序列化/.test(line)), `应拒绝并说明原因：${JSON.stringify(blocked.errors)}`);
});

await t('令牌：有注入就带上 x-workspace-plugins-token，没有就不带', () => {
  const before = ui.withToken({ method: 'GET' });
  assert.equal(before.headers['x-workspace-plugins-token'], undefined, '没有注入令牌时不应凭空造一个');
  assert.equal(before.credentials, 'same-origin');
  globalThis.__DSH_WORKSPACE_PLUGINS__ = { token: 'abc123' };
  try {
    const after = ui.withToken({ method: 'POST', headers: { 'content-type': 'application/json' } });
    assert.equal(after.headers['x-workspace-plugins-token'], 'abc123');
    assert.equal(after.headers['content-type'], 'application/json', '原有头要保留');
  } finally {
    delete globalThis.__DSH_WORKSPACE_PLUGINS__;
  }
});

await t('渲染辅助函数的声明必须先于使用（作用域回归守卫）', () => {
  const source = readFileSync(join(here, 'client.js'), 'utf8').split('\n');
  const lineOf = (needle) => {
    const hits = source.map((line, index) => (line.includes(needle) ? index + 1 : 0)).filter((value) => value > 0);
    assert.equal(hits.length, 1, `「${needle}」应恰好声明/使用一次，实际 ${JSON.stringify(hits)}`);
    return hits[0];
  };
  const loading = lineOf('if (state === null) {');
  const mountRow = lineOf('const renderMountRow =');
  const diagnostics = lineOf('const renderDiagnostics =');
  const mountUse = lineOf('mounts.map(renderMountRow)');
  const diagUse = lineOf('renderDiagnostics() : null');
  assert.ok(mountRow > loading && diagnostics > loading, '辅助函数必须在组件作用域里，不能缩在 if (state === null) 块内');
  assert.ok(mountUse > mountRow && diagUse > diagnostics, '使用点必须在声明之后');
});

/* ── 收尾 ─────────────────────────────────────────────────────────────────── */

if (failures.length > 0) {
  console.log(`\nCLIENT SELFTEST FAIL ${String(passed)}/${String(passed + failures.length)}`);
  for (const failure of failures) console.log(`  · ${failure.name}: ${failure.error instanceof Error ? failure.error.stack ?? failure.error.message : String(failure.error)}`);
  process.exit(1);
}
console.log(`\nCLIENT SELFTEST PASS ${String(passed)}/${String(passed)}`);
