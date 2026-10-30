#!/usr/bin/env node
/**
 * 客户端 bundle 自检 —— 「用户重启 DSH 后插件会不会崩」的安全网（v2.3 精简版）。
 *
 * v2.3 起 DSH 侧**视口面板**与 `blender_rt_pick` 已删除（原生选中取代），客户端半边只剩两块：
 *   ① `@` 提及源（`GET /host/scene-items`）；
 *   ② Blender 原生选中 → 草稿的无头桥（`conversation.input.dock` + `/host/selection/*`）。
 * 本测试保证：
 *   - bundle 仍是合法的 `window.__ModuleLoader__.load({id, factory})`，id = 包名；
 *   - factory 返回 `{apply, inject}`；`inject` 含 `slots`；
 *   - 没有顶层 `import`/`export`/`await`、没有 Node 内置模块；
 *   - **面板相关旧入口不再存在**（`conversation.view` / `/host/view` / `/host/pick` 字面量）；
 *   - `__selftest` 暴露的纯函数语义（@ codec、选中文本、插入路径）逐条成立。
 *
 * 纪律：零依赖（node:fs/path/vm）、只在假 loader 下执行、不联网、不写文件、不调 apply。
 * 用法：node tests/client_bundle_selftest.mjs；退出码 0 = 通过/SKIP，1 = 有失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BUNDLE = path.join(ROOT, 'lib', 'client.js');
const PKG_PATH = path.join(ROOT, 'package.json');
const EXPECTED_ID = '@dsh-external/dsh-blender-plugin';

if (!fs.existsSync(BUNDLE)) {
  console.log('SKIP: lib/client.js 尚未生成');
  process.exit(0);
}
const src = fs.readFileSync(BUNDLE, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

let pass = 0;
let fail = 0;
let skip = 0;
const fails = [];
const infos = [];
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  fails.push({ clause: name, detail: extra === undefined ? null : extra });
}
function doSkip(name, why) { skip++; infos.push('SKIP ' + name + ' — ' + String(why)); }
function info(msg) { infos.push(String(msg)); }

/** 单遍字符扫描：code=注释挖空/字符串保留；codeNoStr=字符串内容也挖空。 */
function tokenizeViews(s) {
  let code = '';
  let codeNoStr = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && s[i] !== '\n') { code += ' '; codeNoStr += ' '; i++; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      code += ' '; codeNoStr += ' '; i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) {
        code += s[i] === '\n' ? '\n' : ' '; codeNoStr += s[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { code += ' '; codeNoStr += ' '; i += 2; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      code += c; codeNoStr += c; i++;
      while (i < n) {
        const ch = s[i];
        if (ch === '\\') { code += s.slice(i, i + 2); codeNoStr += '  '; i += 2; continue; }
        if (ch === quote) { code += ch; codeNoStr += ch; i++; break; }
        if (quote === '`' && ch === '$' && s[i + 1] === '{') {
          let depth = 1; let j = i + 2;
          while (j < n && depth > 0) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
          code += ' '.repeat(j - i); codeNoStr += ' '.repeat(j - i); i = j; continue;
        }
        code += ch; codeNoStr += ch === '\n' ? '\n' : ' '; i++;
      }
      continue;
    }
    code += c; codeNoStr += c; i++;
  }
  return { code, codeNoStr };
}
const { code, codeNoStr } = tokenizeViews(src);

// ── ② 注册形状 ────────────────────────────────────────────────────────────────
ok('加载器：window.__ModuleLoader__.load(...) 存在', src.includes('__ModuleLoader__.load('));
ok('注册 id = 包名（契约 §2.2）', new RegExp("id:\\s*['\"]" + EXPECTED_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "['\"]").test(code));
ok('factory 是函数且返回 module.exports', /factory:\s*\(require\)\s*=>/.test(code) && code.includes('return module.exports'));
ok('无顶层 import / export', !/^\s*(import|export)\b/m.test(codeNoStr), (codeNoStr.match(/^\s*(import|export)\b/gm) || []).slice(0, 3));
ok('无顶层 await（契约 §2.2）', !/^[ \t]*await\b/m.test(codeNoStr), (codeNoStr.match(/^[ \t]*await\b/gm) || []).slice(0, 3));
for (const mod of ['fs', 'path', 'vm', 'child_process', 'http', 'https', 'net']) {
  ok('不 require Node 内置 ' + mod, !new RegExp("require\\(\\s*['\"]" + mod + "['\"]").test(code));
}

// 执行 bundle 取 exports（假 loader + 假 React；不调 apply）
let mod = null;
let loadError = null;
const fakeReact = {
  createElement: () => null,
  useEffect: () => undefined,
  useRef: (v) => ({ current: v }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => undefined],
};
const sandbox = {
  window: {
    __ModuleLoader__: { load: (def) => { mod = def; } },
    fetch: () => Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve(null) }),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    localStorage: { getItem: () => null, setItem: () => undefined },
  },
  console,
  Promise,
  JSON,
  Math,
  Date,
};
try {
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { timeout: 10000 });
} catch (e) {
  loadError = e;
}
ok('bundle 在假 loader 下可执行（不抛）', !loadError, loadError && String(loadError.message || loadError));
let exportsObj = null;
try {
  exportsObj = mod && typeof mod.factory === 'function' ? mod.factory((name) => (name === 'react' ? fakeReact : undefined)) : null;
} catch (e) {
  ok('factory 调用不抛', false, String(e && e.message || e));
}
ok('factory 返回 {apply, inject}', !!exportsObj && typeof exportsObj.apply === 'function' && Array.isArray(exportsObj.inject),
  exportsObj ? { apply: typeof exportsObj.apply, inject: exportsObj.inject } : null);
if (exportsObj && Array.isArray(exportsObj.inject)) {
  ok('exports.inject 含 slots（原生选中桥要注册 dock）', exportsObj.inject.includes('slots'), exportsObj.inject);
  if (exportsObj.inject.length === 0) info('⚠ inject 为空数组 —— 通常说明 dsh.client.inject 与 exports.inject 不一致');
}

// ── ③ v2.3 结构：面板已删，选中桥在 ─────────────────────────────────────────
ok('注册了 conversation.input.dock（无头桥）', code.includes('conversation.input.dock') && code.includes('blender-selection-bridge'));
ok('不再注册 conversation.view（视口面板已删除）', !code.includes('conversation.view'));
ok('不再引用 /host/view 或 /host/pick（面板/点选已删除）', !code.includes('/host/view') && !code.includes('/host/pick'));
ok('不再有 makePanelBody / makeSidebarPane', !code.includes('makePanelBody') && !code.includes('makeSidebarPane'));
ok('仍有 /host/selection/latest 与 /host/selection/consume', code.includes('/host/selection/latest') && code.includes('/host/selection/consume'));
ok('仍有 @ 提及源（/host/scene-items）', code.includes('/host/scene-items') && code.includes('registerSource'));

// ── ④ 纯函数语义 ────────────────────────────────────────────────────────────
const st = exportsObj && exportsObj.__selftest && typeof exportsObj.__selftest === 'object' ? exportsObj.__selftest : null;
if (!st) {
  ok('__selftest 存在（纯函数离线断言入口）', false, null);
} else {
  ok('默认后端 = http://127.0.0.1:9877', st.DEFAULT_BACKEND === 'http://127.0.0.1:9877', st.DEFAULT_BACKEND);

  // @ codec（对象/材质/集合 三类 ref）
  const cb = st.blenderCodec && typeof st.blenderCodec.clipboardText === 'function' ? st.blenderCodec.clipboardText : null;
  const ser = st.blenderCodec && typeof st.blenderCodec.serialize === 'function' ? st.blenderCodec.serialize : null;
  ok('@ codec.clipboardText 是函数', !!cb, typeof cb);
  ok('@ codec.serialize 是函数', !!ser, typeof ser);
  if (cb) {
    for (const [ref, want] of [['object:Cube', '@Cube'], ['material:Mat', '@Mat'], ['collection:Col', '@Col'], ['Cube', '@Cube']]) {
      ok('clipboardText(' + JSON.stringify(ref) + ') === ' + JSON.stringify(want), cb(ref) === want, cb(ref));
    }
  }
  if (ser) {
    for (const [ref, want] of [['object:Cube', '<blender-object>Cube</blender-object>'],
      ['material:Mat', '<blender-material>Mat</blender-material>'],
      ['collection:Col', '<blender-collection>Col</blender-collection>'],
      ['Cube', '<blender-object>Cube</blender-object>']]) {
      let got = null; let err = null;
      try { got = await ser(ref); } catch (e) { err = e; }
      ok('serialize(' + JSON.stringify(ref) + ') === ' + JSON.stringify(want), err === null && got === want, err ? String(err.message || err) : got);
    }
  }
  const onPick = typeof st.onPickItem === 'function' ? st.onPickItem : null;
  if (onPick) {
    const ins = onPick({ candidate: { name: 'Cube', value: 'object:Cube' } });
    ok('@ onPick 返回 ReferenceInsert（source=blender / clipboardText=@Cube）',
      !!ins && !!ins.insert && ins.insert.source === 'blender' && ins.insert.clipboardText === '@Cube', ins && ins.insert);
  } else {
    ok('@ onPickItem 是函数', false, typeof st.onPickItem);
  }

  // v2.3 选中桥：文本与插入路径
  ok('选中轮询间隔 = 100 ms', st.SELECTION_POLL_MS === 100, st.SELECTION_POLL_MS);
  ok('草稿名单上限 = 24', st.SELECTION_DRAFT_NAME_LIMIT === 24, st.SELECTION_DRAFT_NAME_LIMIT);
  const selPayload = { selection: { count: 2, names: ['GEO-blade', 'GEO-guard'], truncated: false, active: 'GEO-blade', mode: 'OBJECT' } };
  const selText = typeof st.selectionMessageText === 'function' ? st.selectionMessageText(selPayload) : null;
  ok('对象选中文本含名单/活动对象/模式/对象名可直接用',
    typeof selText === 'string' && selText.includes('GEO-blade、GEO-guard')
    && selText.includes('活动对象：GEO-blade') && selText.includes('模式：OBJECT') && selText.includes('bpy.data.objects'), selText);
  ok('空选中 → null', typeof st.selectionMessageText === 'function' && st.selectionMessageText({ selection: { names: [] } }) === null,
    typeof st.selectionMessageText === 'function' ? st.selectionMessageText({ selection: { names: [] } }) : null);
  ok('截断信息如实带出（共 3 件，只列前 2 件）',
    typeof st.selectionMessageText === 'function'
    && /共 3 件，只列前 2 件/.test(st.selectionMessageText({ selection: { count: 3, names: ['a', 'b'], truncated: true } }) || ''),
    typeof st.selectionMessageText === 'function' ? st.selectionMessageText({ selection: { count: 3, names: ['a', 'b'], truncated: true } }) : null);
  {
    const many = { selection: { kind: 'objects', count: 30, names: Array.from({ length: 30 }, (_, i) => 'p' + i), truncated: false } };
    const text = typeof st.selectionMessageText === 'function' ? st.selectionMessageText(many) : '';
    ok('30 件 → 只列 24 个 + 共 30 件摘要', /共 30 件，只列前 24 件/.test(text), text);
    const coll = { selection: { kind: 'collection', collection: 'COL-armor', count: 500, names: ['p1', 'p2', 'p3'], truncated: true } };
    const collText = typeof st.selectionMessageText === 'function' ? st.selectionMessageText(coll) : '';
    ok('集合 payload → 集合名 + 件数 + 成员入口',
      collText.includes('Blender 集合：COL-armor（500 件') && collText.includes("bpy.data.collections['COL-armor'].objects"), collText);
    const withColls = { selection: { count: 5, names: ['a', 'b', 'c', 'd', 'e'], collections: [{ name: 'COL-a', count: 3 }, { name: 'COL-b', count: 2 }] } };
    const collsText = typeof st.selectionMessageText === 'function' ? st.selectionMessageText(withColls) : '';
    ok('对象名单带"涉及集合"摘要', /涉及集合：COL-a\(3\)、COL-b\(2\)/.test(collsText), collsText);
  }
  // v2.4：编辑模式 / 骨骼子元素
  if (typeof st.selectionMessageText === 'function' && typeof st.subSelectionText === 'function') {
    const meshSub = { selection: { kind: 'objects', count: 1, names: ['Cube'], sub: {
      type: 'MESH', object: 'Cube', mode: 'EDIT_MESH',
      select_mode: { vertex: true, edge: false, face: false },
      counts: { vertices: 3, edges: 0, faces: 0 },
      indices: { vertices: [0, 1, 2], edges: [], faces: [] }, truncated: false } } };
    const meshText = st.selectionMessageText(meshSub);
    ok('子元素：网格编辑模式 → 草稿含计数 + 顶点索引',
      /编辑模式（网格）「Cube」：已选 3 顶点/.test(meshText) && /顶点索引：0,1,2/.test(meshText)
      && /BMesh/.test(meshText), meshText);

    const armSub = { selection: { kind: 'objects', count: 1, names: ['Rig'], sub: {
      type: 'ARMATURE', object: 'Rig', mode: 'POSE',
      counts: { bones: 2 }, bones: ['BoneA', 'BoneB'], truncated: false } } };
    const armText = st.selectionMessageText(armSub);
    ok('子元素：骨架姿态模式 → 草稿含骨骼名',
      /骨架.*「Rig」.*姿势模式.*已选 2 根/.test(armText) && /BoneA、BoneB/.test(armText), armText);

    const curveSub = { selection: { kind: 'objects', count: 1, names: ['Curve'], sub: {
      type: 'CURVE', object: 'Curve', mode: 'EDIT_CURVE', counts: { points: 2 },
      points: [[0, 1], [0, 3]], truncated: false } } };
    const curveText = st.selectionMessageText(curveSub);
    ok('子元素：曲线控制点 → 草稿含 (spline:point)',
      /曲线\/曲面控制点「Curve」/.test(curveText) && /0:1、0:3/.test(curveText), curveText);

    ok('空 sub 不影响普通对象文本', st.subSelectionText({ sub: null }) === null);
  } else {
    ok('__selftest 暴露 subSelectionText', false, typeof st.subSelectionText);
    ok('__selftest 暴露 SUB_DRAFT_INDEX_LIMIT', false, st.SUB_DRAFT_INDEX_LIMIT);
  }

  if (typeof st.applySelectionToDraft === 'function') {
    let inserted = null;
    const fakeActions = { captureInsertion: () => ({ rev: 1 }), insertText: (text) => { inserted = text; return true; } };
    const rActions = await st.applySelectionToDraft({ sessionId: 's1', inputActions: fakeActions }, selPayload);
    ok('inputActions 路径：insertText 收到逐字文本', rActions.ok === true && rActions.how === 'actions' && inserted === selText, { r: rActions, inserted });
    let drafted = null;
    const emptyFallback = { state: { getSnapshot: () => ({ draft: '' }) }, setDraft: (t) => { drafted = t; } };
    const rFallback = await st.applySelectionToDraft({ sessionId: 's1', fallbackInput: emptyFallback }, selPayload);
    ok('备用通道：草稿为空 → setDraft 写入', rFallback.ok === true && rFallback.how === 'fallback' && drafted === selText, rFallback);
    drafted = null;
    const busyFallback = { state: { getSnapshot: () => ({ draft: '用户已经写的内容' }) }, setDraft: (t) => { drafted = t; } };
    const rBusy = await st.applySelectionToDraft({ sessionId: 's1', fallbackInput: busyFallback }, selPayload);
    ok('备用通道：草稿非空 → 拒绝覆盖', rBusy.ok === false && drafted === null && /已有内容/.test(String(rBusy.reason)), rBusy);
    const rNone = await st.applySelectionToDraft({ sessionId: 's1' }, selPayload);
    ok('无写入通道 → 明确失败（不静默吞掉）', rNone.ok === false && /inputActions/.test(String(rNone.reason)), rNone);
  } else {
    ok('__selftest 暴露 applySelectionToDraft', false, typeof st.applySelectionToDraft);
  }

  // @ 候选源：失败静默返回 []
  if (typeof st.sceneItemCandidates === 'function') {
    const empty = await st.sceneItemCandidates({ query: 'cu' }).catch(() => 'THREW');
    ok('scene items 失败时返回 []（不抛）', Array.isArray(empty) && empty.length === 0, empty);
  } else {
    ok('__selftest 暴露 sceneItemCandidates', false, typeof st.sceneItemCandidates);
  }
}

// ── ⑤ 汇总 ───────────────────────────────────────────────────────────────────
for (const s of infos) console.log('  · ' + s);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of fails) console.log('  x ' + f.clause + (f.detail === undefined || f.detail === null ? '' : ' — ' + JSON.stringify(f.detail)));
}
console.log('\n客户端 bundle 自检：' + pass + ' 通过 / ' + fail + ' 失败' + (skip ? (' / ' + skip + ' SKIP') : '')
  + (fail === 0 ? '  ✅' : '  ❌') + '   （lib/client.js）');
process.exit(fail === 0 ? 0 : 1);
