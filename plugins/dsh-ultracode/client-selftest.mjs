/**
 * dsh-ultracode 浏览器半边自测：在最小桩环境里跑 factory + apply，确认
 * 槽位注册契约、组件可构造，并把**行为**走一遍（取状态 → 点击 → 结果）。
 * 不渲染真实 DOM、不联网。
 *
 * 契约要点（2026-10-22 起变更，用户指令「去掉原来的 ultracode 按钮」）：
 *   - **本半边不再注册任何槽位**：输入框工具行的那颗胶囊已删除，唯一入口是
 *     工作箱（dsh-workbench）工作列表里的 Ultracode 开关行；
 *   - 组件本体（UltracodeToggle）与样式实现保留在 exports.__ui 里，本自测
 *     直接驱动它验证「读状态 → 点击 → 落盘语义」不回退；
 *   - **页面上不出现任何提示语**：状态与原因全部只在按钮 title（悬停）里；
 *   - 实心胶囊、**保留圆角**，熄灭态**底色与对话框（输入卡片）一致**；
 *   - 点亮态是**磨砂玻璃质感的浅绿**（半透明绿 + backdrop 模糊），不是纯绿实心；
 *   - 没有点形指示灯；没有任何浮层（position/z-index/overlay/portal/dialog/popup）。
 *
 * 2026-10-09 追加：会话选择落盘后，title 必须如实说明「重启后还在不在」
 *   （已落盘 / 未落盘示警 / 落盘失败原因 —— 见「行为⑤」）。
 *
 * 运行：node plugins/dsh-ultracode/client-selftest.mjs
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'client.js'), 'utf8');

// ── 桩：定时器 ──────────────────────────────────────────────────────────────
// 组件会起轮询 interval；自测里既不需要它真的跑，也不能让它把 event loop 挂住。
let timerSeq = 0;
globalThis.setInterval = () => ++timerSeq;
globalThis.clearInterval = () => {};
globalThis.setTimeout = () => ++timerSeq;
globalThis.clearTimeout = () => {};

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ── 桩：可编程的上游状态与请求记录 ──────────────────────────────────────────
// host 半边路由的真实形状见 ./inject-v4.js 的 statusView（含落盘四件套
// persisted / restored / decidedAt / storeError，以及家族三件套 family /
// familyRoot / branches；桩必须与它同形）。
const baseStatus = (sessionId) => ({
  sessionId,
  requested: false,
  active: false,
  available: true,
  reason: undefined,
  model: 'selftest-model',
  provider: 'selftest-provider',
  injection: 'system-prompt',
  injected: false,
  shadowed: false,
  phase: 'none',
  source: 'interactive',
  persisted: false,
  restored: false,
  decidedAt: null,
  family: null,
  familyRoot: false,
  branches: 0,
  stateFile: '/tmp/dsh-ultracode-selftest/ultracode.json',
  storeError: null,
  validOptions: 'low, high, max, auto, ultracode [on|off]',
  reasoningEffort: null,
  effortPolicy: 'untouched',
  workflowsEnabled: true,
  workflowToolName: 'workflow',
});

const states = new Map();
const failures = new Set();
/** 永不返回的会话：用来定格「状态还没读到」的首帧（挂载瞬间）。 */
const pending = new Set();
const requests = [];

const setInitial = (sessionId, patch) => {
  states.set(sessionId, { ...baseStatus(sessionId), ...patch });
};

const programmableFetch = async (url, options) => {
  const target = String(url);
  const body = options !== undefined && options.body !== undefined ? JSON.parse(options.body) : null;
  requests.push({ url: target, body });
  const sessionId = body !== null
    ? body.sessionId
    : decodeURIComponent(target.slice(target.indexOf('sessionId=') + 'sessionId='.length));
  if (pending.has(sessionId)) return new Promise(() => {});
  if (failures.has(sessionId)) throw new Error('selftest transport failure');
  if (target.indexOf('/set') !== -1) {
    const current = states.get(sessionId) || baseStatus(sessionId);
    // 与 host 一致：active = requested && available。
    const next = {
      ...current,
      requested: body.active === true,
      active: body.active === true && current.available === true,
    };
    states.set(sessionId, next);
    return { ok: true, status: 200, statusText: 'OK', json: async () => next };
  }
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => states.get(sessionId) || baseStatus(sessionId),
  };
};

// ── 桩：模块加载器 / react ──────────────────────────────────────────────────
let captured = null;
const styleNodes = [];
const effectCleanups = [];
const react = {
  createElement(type, props, ...children) {
    return { type, props: props === null ? {} : props, children };
  },
  Fragment: Symbol('Fragment'),
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
  // 立即执行 effect 并收集清理函数：组件因此真的会去取状态。
  useEffect(fn) {
    const cleanup = fn();
    if (typeof cleanup === 'function') effectCleanups.push(cleanup);
  },
  useRef(value) { return { current: value }; },
  useCallback(fn) { return fn; },
};

globalThis.window = {
  __ModuleLoader__: { load(entry) { captured = entry; } },
  addEventListener() {}, removeEventListener() {}, innerWidth: 1440,
};
globalThis.document = {
  head: {
    appendChild(node) {
      node.parentNode = {
        removeChild(target) {
          const at = styleNodes.indexOf(target);
          if (at >= 0) styleNodes.splice(at, 1);
        },
      };
      styleNodes.push(node);
    },
  },
  createElement() { return { setAttribute() {}, textContent: '', parentNode: null }; },
  addEventListener() {}, removeEventListener() {},
};

const require = (name) => {
  if (name === 'react') return react;
  throw new Error('unexpected require: ' + name);
};

// ── 执行 ────────────────────────────────────────────────────────────────────
new Function('window', 'document', 'require', 'fetch', source)(
  globalThis.window, globalThis.document, require, programmableFetch,
);

assert.ok(captured !== null, 'factory 未注册到 __ModuleLoader__');
assert.equal(captured.id, 'dsh-ultracode', 'boot 图 id 必须与 package.json name 一致');

const exports = captured.factory(require);
assert.deepEqual(exports.inject, [], '2026-10-22 起：不再注入任何服务、不注册任何槽位');

const registrations = [];
const injectedNames = [];
const effectFactories = [];
const ctx = {
  slots: {
    inject(name, fn) { injectedNames.push(name); fn(); },
    register(meta, component) { registrations.push({ meta, component }); },
  },
  effect(factory, label) { effectFactories.push({ factory, label }); },
};
exports.apply(ctx);

// ── 注册契约：零座位（按钮已删；唯一入口是工作箱）──────────────────────────
assert.deepEqual(injectedNames, [], '不得再向任何槽位注入（原按钮已按用户指令删除）');
assert.equal(registrations.length, 0, '不得注册任何槽位条目');
assert.equal(typeof exports.__ui.UltracodeToggle, 'function', '组件本体保留在 __ui（工作箱语义仍可复用）');

const Toggle = exports.__ui.UltracodeToggle;
const renderChip = async (sessionId) => {
  Toggle({ sessionId });
  await tick();
  await tick();
  return Toggle({ sessionId });
};

// ── 静态渲染：按钮 + 唯一文字子节点（没有点灯、没有提示语）─────────────────
const element = await renderChip('session-static');
assert.ok(element !== null && element !== undefined, '开关组件应返回元素');
assert.equal(element.type, 'button', '开关应是一颗按钮（点击即切换）');
assert.equal(element.props.type, 'button');
assert.equal(element.props['aria-pressed'], 'false', '未点亮时 aria-pressed=false');
assert.equal(element.props.disabled, false, '读到状态之前不得禁用');
assert.equal(typeof element.props.title, 'string', '状态详情应只在 title 里');
assert.equal(element.children.length, 1, '按钮里只能有文字，不能有点形指示灯或第二行提示语');
assert.equal(String(element.children[0].props.className), 'uc-label', '唯一子节点应是文字标签');
assert.equal(String(element.children[0].children[0]), 'Ultracode', '标签文字应是 Ultracode');
// 与同排出厂控件一致：按下时 preventDefault，保住输入框焦点与正在打的字。
assert.equal(typeof element.props.onMouseDown, 'function', '按下时须 preventDefault 保住编辑器焦点');
let prevented = false;
element.props.onMouseDown({ preventDefault() { prevented = true; } });
assert.equal(prevented, true, 'onMouseDown 必须真的调用 preventDefault');

// ── 行为①：熄灭 → 点亮（写 active:true，胶囊转点亮态）──────────────────────
setInitial('session-on', {});
const offChip = await renderChip('session-on');
assert.equal(String(offChip.props.className).indexOf('uc-on') === -1, true, '未请求时不应是点亮态');
requests.length = 0;
offChip.props.onClick();
await tick();
await tick();
const onCalls = requests.filter((entry) => entry.url.indexOf('/set') !== -1);
assert.equal(onCalls.length, 1, '点击应发一次 set');
assert.equal(onCalls[0].body.active, true, '熄灭 → 点亮应写 active:true');
const litChip = await renderChip('session-on');
assert.equal(String(litChip.props.className).indexOf('uc-on') !== -1, true, '写成功后胶囊应转为点亮态');
assert.equal(litChip.props['aria-pressed'], 'true', '点亮后 aria-pressed=true');

// ── 行为②：已请求但当前不可用 → 点击必须能关掉（写 active:false）─────────────
// 这条是真实缺陷的回归钉：host 的 active = requested && available，若按
// 「取反」推断，点击会再写一次 true，请求永远退不出来。
setInitial('session-stuck', { available: false, requested: true, active: false });
const stuckChip = await renderChip('session-stuck');
assert.equal(String(stuckChip.props.className).indexOf('uc-blocked') !== -1, true, '不可用时应是琥珀态');
requests.length = 0;
stuckChip.props.onClick();
await tick();
await tick();
const stuckCalls = requests.filter((entry) => entry.url.indexOf('/set') !== -1);
assert.equal(stuckCalls.length, 1, '已请求但不可用时点击必须发一次 set');
assert.equal(stuckCalls[0].body.active, false, '必须写 active:false（关掉请求），不能推断成 true');

// ── 行为③：没请求过且不可用 → 点击不写状态（原因只在 title 里）───────────────
setInitial('session-blocked', { available: false, requested: false, active: false, reason: 'workflows' });
const blockedChip = await renderChip('session-blocked');
assert.equal(String(blockedChip.props.className).indexOf('uc-blocked') !== -1, true,
  '只要不可用就必须点亮琥珀态（不能只在「请求过」时才提示）');
assert.equal(String(blockedChip.props.title).indexOf('dynamic workflows enabled') !== -1, true,
  '不可用原因必须是原实现原文，且只出现在 title 里');
requests.length = 0;
blockedChip.props.onClick();
await tick();
assert.equal(requests.filter((entry) => entry.url.indexOf('/set') !== -1).length, 0,
  '没请求过的不可用会话，点击不得写状态');

// ── 行为④：状态读取失败 → 红色胶囊，且仍可点击（下一轮轮询自愈）──────────────
failures.add('session-err');
const errChip = await renderChip('session-err');
assert.equal(String(errChip.props.className).indexOf('uc-error') !== -1, true, '读取失败应转红色');
assert.equal(errChip.props.disabled, false, '读取失败时不得禁用（否则永远看不到重试）');
assert.equal(String(errChip.props.title).indexOf('状态读取失败') !== -1, true, '失败原因应在 title 里');
failures.delete('session-err');

// ── 行为⑤：落盘标记（2026-10-09）——title 必须如实说明「重启后还在不在」 ──────
// 三种情况都要在悬停标题里说得清清楚楚（页面上仍然一个字都不写）：
//   已落盘 → 「重启后保留」；开着但没落盘 → 示警；落盘失败 → 报出原因。
setInitial('session-durable', {
  requested: true,
  active: true,
  phase: 'enter',
  persisted: true,
  restored: true,
  decidedAt: 1791534284000,
});
const durableChip = await renderChip('session-durable');
const durableTitle = String(durableChip.props.title);
assert.equal(durableTitle.indexOf('已落盘，重启后保留') !== -1, true, '已落盘时 title 必须写明「重启后保留」');
assert.equal(durableTitle.indexOf('本次由落盘恢复') !== -1, true, 'restored 时 title 必须写明本次由落盘恢复');
assert.equal(durableTitle.indexOf('上次决定') !== -1, true, '能给时间就必须在 title 里给出上次决定时间');
assert.equal(durableTitle.indexOf('ultracode-selftest/ultracode.json') !== -1, true, 'title 必须报出实际落盘文件');
assert.equal(durableTitle.indexOf('仅本会话') === -1, true, '落盘之后不得再声称「仅本会话」');

setInitial('session-not-durable', { requested: true, active: true, phase: 'enter', persisted: false });
const notDurableChip = await renderChip('session-not-durable');
assert.equal(String(notDurableChip.props.title).indexOf('未落盘：重启会丢') !== -1, true,
  '开着但没落盘必须在 title 里示警（否则用户以为已经保住了）');

setInitial('session-store-err', {
  requested: true,
  active: true,
  phase: 'enter',
  persisted: false,
  storeError: 'EISDIR: illegal operation on a directory',
});
const storeErrChip = await renderChip('session-store-err');
assert.equal(String(storeErrChip.props.title).indexOf('落盘失败：EISDIR') !== -1, true,
  '落盘失败必须在 title 里给出原因');

// 熄灭且从未决定过的会话：不该被落盘那段话打扰（不啰嗦）。
setInitial('session-quiet', { requested: false, active: false, phase: 'none', persisted: false });
const quietChip = await renderChip('session-quiet');
const quietTitle = String(quietChip.props.title);
assert.equal(quietTitle.indexOf('落盘') === -1, true, '没开又没落盘时，title 不该出现落盘噪音');
assert.equal(quietTitle.indexOf('未落盘') === -1, true, '没开又没落盘时不该示警');

// ── 行为⑥：状态还没读到（挂载首帧）→ 中性态，不得以熄灭的姿态定帧 ───────────
// 切进一条**继承**来的分支时，首帧还没有 /status 结果；若按 off 画，胶囊会先熄灭
// 一下再跳亮。中性态（虚线 + 慢呼吸）表达「还不知道」，同时保留「没读到就不给点」。
pending.add('session-cold');
const coldChip = await renderChip('session-cold');
const coldClass = String(coldChip.props.className);
assert.equal(coldClass.indexOf('uc-unknown') !== -1, true, '首帧未读到状态必须是中性态（否则会闪一下错的 off）');
assert.equal(coldClass.indexOf('uc-on') === -1, true, '未知态不得冒充点亮');
assert.equal(coldClass.indexOf('uc-blocked') === -1, true, '未知态不得冒充不可用');
assert.equal(coldChip.props['aria-pressed'], 'false', '未知态对外仍是未按下');
assert.equal(String(coldChip.props.title).indexOf('正在读取状态…') !== -1, true, '未知态的 title 要说明正在读取');
requests.length = 0;
coldChip.props.onClick();
await tick();
assert.equal(requests.filter((entry) => entry.url.indexOf('/set') !== -1).length, 0,
  '状态没读到时点击不得写状态（不能拿未知反推）');
pending.delete('session-cold');

// ── 行为⑦：家族共用（2026-10-09 追加）——title 必须讲清「改动影响全部分支」────
setInitial('session-fam-child', {
  requested: true, active: true, phase: 'enter', persisted: true,
  family: 'session-fam-root', familyRoot: false, branches: 2,
});
const famChildChip = await renderChip('session-fam-child');
const famChildTitle = String(famChildChip.props.title);
assert.equal(famChildTitle.indexOf('全家族共用') !== -1, true, '家族内点亮必须写明「全家族共用」');
assert.equal(famChildTitle.indexOf('分支（继承家族根的选择）') !== -1, true, '分支要说明自己的选择是从家族根继承的');
assert.equal(famChildTitle.indexOf('另有 2 条分支') !== -1, true, '要报出同族其它分支数');
assert.equal(famChildTitle.indexOf('在此改动会同时影响全部分支') !== -1, true, '要讲清一次点击会波及全部分支');

setInitial('session-fam-root', {
  requested: true, active: true, phase: 'enter', persisted: true,
  family: 'session-fam-root', familyRoot: true, branches: 3,
});
const famRootChip = await renderChip('session-fam-root');
const famRootTitle = String(famRootChip.props.title);
assert.equal(famRootTitle.indexOf('家族根（主线）') !== -1, true, '家族根要标明自己是主线');
assert.equal(famRootTitle.indexOf('另有 3 条分支') !== -1, true, '主线要报出自己带了几条分支');

// 家族里熄灭：措辞同样要说是整族的行为
setInitial('session-fam-off', {
  requested: false, active: false, phase: 'exit', persisted: true,
  family: 'session-fam-root', familyRoot: false, branches: 1,
});
const famOffTitle = String((await renderChip('session-fam-off')).props.title);
assert.equal(famOffTitle.indexOf('已熄灭（off）· 全家族共用') !== -1, true, '家族内熄灭也要说明是整族的');

// 独立会话（没有家族信息）不得冒出家族话术
setInitial('session-solo', { requested: true, active: true, phase: 'enter', persisted: true });
const soloTitle = String((await renderChip('session-solo')).props.title);
assert.equal(soloTitle.indexOf('本会话（重启后保留）') !== -1, true, '独立会话仍按「本会话」措辞');
assert.equal(soloTitle.indexOf('家族') === -1, true, '没有家族信息的会话不得冒出家族话术');

// ── 页面上不出现任何提示语 ──────────────────────────────────────────────────
assert.equal(source.indexOf('uc-receipt') === -1, true, '回执行（页面提示语）应已删除');
assert.equal(source.indexOf('conversation.input.dock') === -1, true, '不应再注册回执行座位');
assert.equal(/role:\s*'status'/.test(source), false, '不应再有 status 提示节点');
assert.equal(source.indexOf('conversation.session.header.utilities') === -1, true, '触发器不应再挂在会话头部');

// ── 视觉契约 ────────────────────────────────────────────────────────────────
// 尺寸与字体必须与同一行的「权限」选择器对齐（PermissionSelect 的 trigger：
// height 28px / border-radius 24px / font-size 13px / line-height 20px），
// 字重按用户要求取**细体 400**（权限写 500，但它渲染中文字形，纯拉丁的
// "Ultracode" 在 500 下视觉更粗），字体族显式继承以免 <button> 退回 UA 默认字体。
assert.equal(/\.uc-chip \{[^}]*border-radius: 24px/.test(source), true, '圆角必须与权限选择器一致（24px，仍是圆角）');
assert.equal(/\.uc-chip \{[^}]*height: 28px/.test(source), true, '按钮高度必须与权限选择器一致（28px）');
assert.equal(/\.uc-chip \{[^}]*font-size: 13px/.test(source), true, '字号必须与权限选择器一致（13px）');
assert.equal(/\.uc-chip \{[^}]*font-weight: 400/.test(source), true, '字重必须是细体 400');
assert.equal(/\.uc-chip \{[^}]*font-family: inherit/.test(source), true, '字体族必须显式继承（不能用 <button> 的 UA 默认字体）');
assert.equal(/\.uc-chip \{[^}]*line-height: 20px/.test(source), true, '行高必须与权限选择器一致（20px）');
assert.equal(/\.uc-chip \{[^}]*padding: 0 10px/.test(source), true, '纯文字胶囊用 0 10px 内边距（权限选择器带图标，为 0 4px 0 8px）');
assert.equal(
  /\.uc-chip \{[^}]*background: var\(--dsw-specific-input-major/.test(source),
  true,
  '熄灭态底色必须与对话框（输入卡片）一致',
);
assert.equal(source.indexOf('uc-led') === -1, true, '点形指示灯已按用户要求删除');
const onRule = source.slice(source.indexOf('.uc-chip.uc-on {'), source.indexOf('.uc-chip.uc-on:hover'));
// 点亮态（用户指定）：不要边框、整颗内部铺同一个均匀色号、透明度偏高且偏白。
// 「均匀平涂」= 不得出现渐变 / backdrop 模糊 / 阴影 / brightness 滤镜这类光效。
assert.equal(
  /border-color:\s*transparent/.test(onRule),
  true,
  '点亮态必须没有边框（只留 transparent 占位，切换时不跳动）',
);
assert.equal(onRule.indexOf('background: rgba(206, 242, 220, .38)') !== -1, true, '点亮态必须是偏高透明度、偏白的淡薄荷（不支持 color-mix 时的回退）');
assert.equal(
  /color-mix\(in srgb, color-mix\(in srgb, var\(--dsw-static-green-500[^)]*\) 22%, #ffffff\) 38%, transparent\)/.test(onRule),
  true,
  '点亮色号必须是「22% 绿兑白后再取 38% 不透明度」的偏白半透明绿',
);
assert.equal(/linear-gradient/.test(onRule), false, '点亮态不得有渐变（光效变化）');
assert.equal(/backdrop-filter/.test(onRule), false, '点亮态不得有 backdrop 模糊（光效变化）');
assert.equal(onRule.indexOf('box-shadow') === -1, true, '点亮态不得有内高光/外发光');
assert.equal(/\bfilter\s*:/.test(onRule), false, '点亮态不得用 brightness 之类的滤镜');
assert.equal(onRule.indexOf('background: var(--dsw-static-green-500') === -1, true, '点亮态不得退回纯绿实心');
// 熄灭/不可用/失败态仍共用同一条朴素 1px 描边（不染色、不加艺术处理）。
assert.equal(
  /\.uc-chip \{[^}]*border: 1px solid var\(--dsw-alias-border-l2\)/.test(source),
  true,
  '外框必须是与熄灭态一致的朴素 1px 描边',
);
const blockedRule = source.slice(source.indexOf('.uc-chip.uc-blocked {'), source.indexOf('.uc-chip.uc-error {'));
const errorRule = source.slice(source.indexOf('.uc-chip.uc-error {'), source.indexOf('@keyframes uc-breathe'));
assert.equal(/border-color\s*:/.test(blockedRule), false, '不可用态不得改变外框');
assert.equal(/border-color\s*:/.test(errorRule), false, '读取失败态不得改变外框');
assert.equal(/box-shadow/.test(blockedRule + errorRule), false, '不可用/失败态不得加阴影装饰');
// 全局：整个样式表里不出现任何光效手段（渐变/模糊/阴影/滤镜）。
assert.equal(/linear-gradient|backdrop-filter|box-shadow/.test(source), false, '整个胶囊样式不得含渐变/模糊/阴影等光效');
assert.equal(/\bfilter\s*:/.test(source), false, '整个胶囊样式不得含 brightness 等滤镜');
// 未知态（挂载首帧）：虚线描边 + 复用同一条呼吸动画，与熄灭态的实线常态一眼可分。
assert.equal(/\.uc-chip\.uc-unknown \{[^}]*border-style: dashed/.test(source), true,
  '未知态必须用虚线描边（否则与熄灭态的实线常态无从区分）');
assert.equal(/\.uc-chip\.uc-unknown \{[^}]*animation: uc-breathe/.test(source), true,
  '未知态要复用同一条呼吸动画表达「正在读」');

// ── 没有任何浮层 ────────────────────────────────────────────────────────────
assert.equal(source.indexOf('uc-panel') === -1, true, '不应再有弹出面板样式');
assert.equal(/position\s*:\s*['"]?(fixed|absolute)/.test(source), false, '不应再有 fixed/absolute 定位的浮层');
assert.equal(/z-?index/i.test(source), false, '不应再有层级抬升（浮层特征）');
assert.equal(/overlay|portal|dialog|popup/i.test(source), false, '不应再有覆盖层 / 传送门 / 对话框字样');

// ── 会话状态归本 fiber 所有；样式不再注入（没有座位就没有样式）──────────────
assert.equal(styleNodes.length, 0, '不再注入样式（按钮已删除）');
assert.deepEqual(
  effectFactories.map((entry) => entry.label),
  ['dsh-ultracode: session state'],
  'apply 只登记「会话状态」一个清理 effect',
);
assert.equal(typeof effectFactories[0].factory(), 'function', '会话状态 effect 应返回清理函数');

console.log('CLIENT SELFTEST PASS');