/**
 * dsh-workspace-context host 半边自测（纯 node、无副作用、不联网）。
 *
 * 覆盖四层：
 *   ① store.js 纯函数：slug/头部解析与渲染/两个注入危害的中和/字节截断/路径规范化；
 *   ② store 文件语义：写读、祖先继承、启用位、未绑定、重复绑定、回收站、收编；
 *   ③ index.js 在假 ctx 上的真实装配：注入位置与跳过分支、工具六个 action、
 *      六条同源路由（含跨域拒绝 / 方法拒绝 / 400）；
 *   ④ 与出厂 `renderPrompt` 的**交叉验证**：证明「正文里的 {{…}} 若中和就会打挂
 *      装配」这一前提成立（出厂包找不到时跳过并打印原因，不算失败）。
 *
 * 运行：node plugins/dsh-workspace-context/selftest.mjs
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalPath,
  contextFileFor,
  createStore,
  frameSectionText,
  isAncestor,
  neutralizeTemplateRefs,
  parseContextFile,
  renderContextFile,
  slugFor,
  truncateUtf8,
} from './store.js';
import { apply, name as pluginName } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
let checks = 0;
const ok = (value, message) => {
  checks += 1;
  assert.ok(value, message);
};
const eq = (actual, expected, message) => {
  checks += 1;
  assert.equal(actual, expected, message);
};
const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));

const root = mkdtempSync(join(tmpdir(), 'dsh-wctx-selftest-'));
const workspaceA = join(root, 'proj-a');
const workspaceB = join(root, 'proj-b');
const nested = join(workspaceA, 'pkg', 'inner');
mkdirSync(nested, { recursive: true });
mkdirSync(workspaceB, { recursive: true });

try {
  // ── ① store.js 纯函数 ──────────────────────────────────────────────────────
  console.log('① store.js 纯函数');
  eq(pluginName, 'workspace-context', '插件名');
  ok(slugFor('/root/nas/ArkTower') === slugFor('/root/nas/ArkTower'), 'slug 对同一路径稳定');
  ok(slugFor('/root/nas/ArkTower') !== slugFor('/root/nas/Ark-Tower'), '不同路径 slug 不同');
  ok(slugFor('/root/nas/ArkTower').startsWith('root-nas-ArkTower--'), 'slug 带可读尾部与哈希');
  ok(/^[A-Za-z0-9._-]+$/.test(slugFor('/a b/中文 目录/x')), 'slug 只含文件名安全字符');
  eq(contextFileFor('/tmp/store', '/x/y').endsWith('.md'), true, '上下文文件是 .md');

  const roundTrip = renderContextFile({
    workspace: '/root/nas/ArkTower',
    title: 'ArkTower',
    enabled: false,
    updatedAt: '2026-10-09T00:00:00.000Z',
    updatedBy: 'tool',
    text: '第一行\n\n第二段',
  });
  const parsedRoundTrip = parseContextFile(roundTrip);
  eq(parsedRoundTrip.bound, true, '往返：已绑定');
  eq(parsedRoundTrip.workspace, '/root/nas/ArkTower', '往返：工作区');
  eq(parsedRoundTrip.title, 'ArkTower', '往返：显示名');
  eq(parsedRoundTrip.enabled, false, '往返：启用位');
  eq(parsedRoundTrip.updatedBy, 'tool', '往返：修改者');
  eq(parsedRoundTrip.text, '第一行\n\n第二段', '往返：正文逐字（头部后的空行不进正文）');
  eq(parseContextFile('就是一段没有头部的正文').bound, false, '无头部 → 未绑定');
  eq(parseContextFile('就是一段没有头部的正文').reason, 'missing-header', '无头部原因');
  eq(parseContextFile('<!-- dsh-workspace-context\ntitle: x\n-->\n正文').reason, 'missing-workspace', '头部缺 workspace → 未绑定');
  eq(parseContextFile('<!-- dsh-workspace-context\nworkspace: /a\nenabled: true\n-->\n正文').enabled, true, 'enabled 缺省真');

  eq(neutralizeTemplateRefs('用 {{name}} 填充').includes('{{'), false, '中和后不再有 {{');
  ok(neutralizeTemplateRefs('用 {{name}} 填充').includes('name'), '中和保留变量名文本');
  eq(neutralizeTemplateRefs('没有模板').indexOf('{{'), -1, '无模板时原样');
  eq(neutralizeTemplateRefs('{{a}} {{b}}').split('\u200B').length - 1, 2, '每组 {{ 各中和一次');
  // 重叠花括号：全局 replace 是非重叠的，`{{{name}}}` 只消掉第一对、留下 `{{name}}`
  // ——那正是出厂 renderPrompt 会 throw 的形状（2026-10-09 实测抓到）。
  for (const probe of ['{{{name}}}', '{{{{a}}}}', '{{{{{{x}}}}}}', '{{{{{', '${ {a} }', '{{']) {
    eq(neutralizeTemplateRefs(probe).includes('{{'), false, '重叠花括号也中和干净：' + JSON.stringify(probe));
    ok(neutralizeTemplateRefs(probe).replace(/\u200B/g, '').replace(/\{/g, '').includes('{') === false, '中和只插零宽字符、不删花括号：' + JSON.stringify(probe));
  }
  eq(neutralizeTemplateRefs('{{a}}').replace(/\u200B/g, ''), '{{a}}', '中和可逆（去掉零宽字符即原文）');
  eq(neutralizeTemplateRefs('{{{{a}}}}').replace(/\u200B/g, ''), '{{{{a}}}}', '重叠情形也可逆');
  const framed = frameSectionText({
    workspace: '/root/nas/ArkTower',
    title: 'ArkTower',
    text: '见 {{name}} 与 </workspace-context> 结尾',
    maxBytes: 4096,
  });
  eq(framed.text.includes('{{'), false, '注入文本里没有 {{');
  eq(/<\/workspace-context>/i.test(framed.text.slice(framed.text.indexOf('\n\n') + 2, -20)), false, '正文里的闭合标签已转义');
  ok(framed.text.endsWith('</workspace-context>'), '外框闭合标签仍在');
  ok(framed.text.includes('workspace="/root/nas/ArkTower"'), '外框带工作区属性');
  ok(framed.text.includes('不覆盖 system'), '外框写明权限关系');

  const cjk = '中'.repeat(100);
  const cut = truncateUtf8(cjk, 10);
  eq(cut.truncated, true, '截断标记');
  eq(Buffer.byteLength(cut.text, 'utf8') <= 10, true, '截断不超字节上限');
  eq(cut.text.endsWith('中'), true, 'CJK 不会被切成半个字符');
  eq(Buffer.from(cut.text, 'utf8').toString('utf8'), cut.text, '截断结果是合法 UTF-8');
  eq(truncateUtf8('short', 100).truncated, false, '未超限不截断');

  const big = frameSectionText({ workspace: '/w', text: 'x'.repeat(5000), maxBytes: 1024 });
  eq(big.truncated, true, '超限即截断');
  eq(Buffer.byteLength(big.text, 'utf8') <= 1024, true, '注入文本受 maxBytes 约束');
  ok(big.text.includes('已截断'), '截断给出可见提示');

  assert.throws(() => canonicalPath('relative/path'), /绝对路径/, '相对路径被拒');
  eq(canonicalPath(workspaceA), canonicalPath(workspaceA + '/'), '尾斜杠规范化一致');
  assert.throws(() => canonicalPath(join(root, 'nope'), { mustExist: true }), /不存在/, 'mustExist 拒绝不存在');
  assert.throws(() => canonicalPath(join(root, 'file.txt'), { mustExist: true }), /不存在|不是目录/, 'mustExist 拒绝非目录');
  eq(isAncestor('/a/b', '/a/b/c'), true, '祖先判定：真');
  eq(isAncestor('/a/b', '/a/bc'), false, '祖先判定：前缀不越过目录边界');
  eq(isAncestor('/a/b', '/a/b'), true, '祖先判定：含相等');

  // ── ② store 文件语义 ───────────────────────────────────────────────────────
  console.log('② store 文件语义');
  const storeDir = join(root, 'store');
  const store = createStore({ dir: storeDir, ttlMs: 0, maxBytes: 4096, inheritFromAncestor: true });
  store.ensureDirs();
  ok(existsSync(join(storeDir, 'contexts')), '启动建好 contexts 目录');
  eq(store.scan(true).entries.length, 0, '初始为空');

  const entryA = store.writeEntry({ path: workspaceA, text: 'A 的常驻正文', updatedBy: 'human' });
  eq(entryA.path, canonicalPath(workspaceA), '写入后路径规范化');
  eq(entryA.textBytes, Buffer.byteLength('A 的常驻正文', 'utf8'), '写入后字节数');
  eq(entryA.title, 'proj-a', '显示名缺省取目录名');
  ok(existsSync(entryA.file), '文件真的落盘');
  ok(readFileSync(entryA.file, 'utf8').startsWith('<!-- dsh-workspace-context'), '文件头部标记');
  eq(store.scan(true).entries.length, 1, '扫描到 1 条');

  const exact = store.sectionFor(workspaceA);
  eq(exact.skipped, undefined, '精确命中不会跳过');
  eq(exact.via, 'exact', '精确命中的 via');
  ok(exact.text.includes('A 的常驻正文'), 'section 含正文');
  const inherited = store.sectionFor(nested);
  eq(inherited.via, 'ancestor', '子目录继承祖先条目');
  eq(inherited.entry.path, canonicalPath(workspaceA), '继承的是祖先条目');
  eq(store.sectionFor(workspaceB), undefined, '无条目的工作区返回 undefined');
  const noInherit = createStore({ dir: storeDir, ttlMs: 0, inheritFromAncestor: false });
  eq(noInherit.sectionFor(nested), undefined, '关掉继承后子目录不再命中');

  store.setEnabled(workspaceA, false);
  eq(store.sectionFor(workspaceA).skipped, 'disabled', '停用后跳过');
  eq(store.scan(true).entries[0].textBytes, Buffer.byteLength('A 的常驻正文', 'utf8'), '停用不丢正文');
  store.setEnabled(workspaceA, true);
  eq(store.resolveFor(workspaceA).entry.enabled, true, '重新启用');

  store.writeEntry({ path: workspaceA, text: '   ', updatedBy: 'tool' });
  eq(store.sectionFor(workspaceA).skipped, 'empty', '纯空白正文按空处理');
  store.writeEntry({ path: workspaceA, text: 'A 的常驻正文（v2）', updatedBy: 'tool' });
  eq(store.scan(true).entries[0].updatedBy, 'tool', '写入者被记录');

  // 未绑定：手写一个没有头部的 .md
  const orphanPath = join(storeDir, 'contexts', 'hand-written.md');
  writeFileSync(orphanPath, '手写但没有头部的正文', 'utf8');
  const withOrphan = store.scan(true);
  eq(withOrphan.unbound.length, 1, '未绑定文件被列出');
  eq(withOrphan.unbound[0].reason, 'missing-header', '未绑定原因');
  ok(withOrphan.unbound[0].preview.includes('手写'), '未绑定带预览');
  eq(store.sectionFor(workspaceB), undefined, '未绑定文件不会被注入');

  const bound = store.bind({ file: 'hand-written.md', path: workspaceB });
  eq(bound.path, canonicalPath(workspaceB), '收编到目标工作区');
  eq(bound.text, '手写但没有头部的正文', '收编保留正文');
  eq(existsSync(orphanPath), false, '收编后原文件已清理');
  eq(store.scan(true).unbound.length, 0, '收编后无未绑定');
  eq(store.scan(true).entries.length, 2, '收编后 2 条');

  // 重复绑定：两个文件声明同一 workspace
  const dupPath = join(storeDir, 'contexts', 'dup.md');
  writeFileSync(dupPath, renderContextFile({ workspace: workspaceB, text: '重复', enabled: true }), 'utf8');
  const dupIndex = store.scan(true);
  eq(dupIndex.entries.length, 2, '重复绑定不新增条目');
  ok(dupIndex.unbound.some((item) => item.reason === 'duplicate-binding'), '重复绑定进 unbound');
  ok(dupIndex.errors.some((line) => line.includes('重复绑定')), '重复绑定进 errors');
  rmSync(dupPath, { force: true });

  const trashed = store.trashEntry(workspaceB);
  ok(trashed.includes('trash'), '回收站路径');
  ok(existsSync(trashed), '文件真的移入回收站');
  eq(store.scan(true).entries.length, 1, '回收后剩 1 条');
  assert.throws(() => store.trashEntry(workspaceB), /还没有常驻上下文/, '回收不存在的条目报错');
  assert.throws(() => store.writeEntry({ path: join(root, 'nope'), text: 'x' }), /不存在/, '给不存在的目录写入报错');

  // 外部改文件的热读（mtime+size 变化即重新解析）
  const fileA = store.scan(true).entries[0].file;
  store.writeEntry({ path: workspaceA, text: '旧正文', updatedBy: 'human' });
  writeFileSync(fileA, renderContextFile({ workspace: workspaceA, text: '人手改的新正文', enabled: true }), 'utf8');
  ok(store.sectionFor(workspaceA).text.includes('人手改的新正文'), '外部改文件后热读到新正文');

  // ── ③ index.js 在假 ctx 上的真实装配 ───────────────────────────────────────
  console.log('③ index.js 假 ctx 装配');
  const harness = makeHarness({
    dir: join(root, 'store2'),
    workspaceRegistry: [{ path: workspaceA, title: '项目 A' }, { path: workspaceB, title: '项目 B' }],
  });
  apply(harness.ctx, { dir: join(root, 'store2'), ttlMs: 0, maxBytes: 4096, inheritFromAncestor: true });
  eq(harness.tools.length, 1, '注册了 1 个工具');
  const tool = harness.tools[0];
  eq(tool.name, 'workspace_context', '工具名');
  ok(tool.description.includes('workspace context'), '工具描述讲清语义');
  eq(JSON.stringify(tool.parameters.properties.action.enum), JSON.stringify(['list', 'read', 'write', 'append', 'clear', 'set_enabled']), 'action 枚举');
  eq(harness.routes.size, 6, '注册 6 条路由');
  for (const path of ['/state', '/save', '/enabled', '/bind', '/trash', '/reload']) {
    ok(harness.routes.has('/dsh-workspace-context' + path), '路由存在：' + path);
  }
  const assemble = harness.listeners.get('system-prompt/assemble');
  eq(typeof assemble, 'function', '挂了系统提示装配瀑布');
  eq(harness.listenerOptions.get('system-prompt/assemble').prepend, true, '装配监听是 prepend');

  const agent = (cwd) => ({ session: { id: 's-' + cwd, header: { cwd } } });
  const next = async () => nativeAssembly();
  const runAssemble = (cwd) => assemble({}, cwd === undefined ? {} : { agent: agent(cwd) }, next);

  const untouched = await runAssemble(workspaceA);
  eq(untouched.sections.length, nativeAssembly().sections.length, '无条目时装配原样');
  eq(untouched.sections.some((section) => section.name === 'workspace:context'), false, '无条目时不注入');

  const writeResult = await tool.execute({ action: 'write', path: workspaceA, text: '装配测试正文' }, { agent: agent(workspaceA) });
  eq(writeResult.ok, true, '工具写入成功');
  eq(writeResult.action, 'write', '工具回显 action');
  const injected = await runAssemble(workspaceA);
  const mine = injected.sections.find((section) => section.name === 'workspace:context');
  ok(mine !== undefined, '有条目时注入 section');
  ok(mine.text.includes('装配测试正文'), 'section 含正文');
  const personaAt = injected.sections.findIndex((section) => section.name === 'deployment:persona-prefix');
  const mineAt = injected.sections.findIndex((section) => section.name === 'workspace:context');
  eq(mineAt, personaAt + 1, 'section 紧跟部署人设前缀');
  eq(injected.sections.filter((section) => section.name === 'workspace:context').length, 1, '只注入一次');

  const noCwd = await runAssemble(undefined);
  eq(noCwd.sections.some((section) => section.name === 'workspace:context'), false, '无 session cwd 不注入');
  const otherWorkspace = await runAssemble(workspaceB);
  eq(otherWorkspace.sections.some((section) => section.name === 'workspace:context'), false, '无条目的工作区不注入');
  const nestedInjected = await runAssemble(nested);
  ok(nestedInjected.sections.some((section) => section.name === 'workspace:context'), '子目录继承注入');
  const noPersona = await assemble({}, { agent: agent(workspaceA) }, async () => ({
    sections: [{ name: 'harness:identity', text: 'x' }, { name: 'tool:bash', text: 'y' }],
    contexts: [],
    tools: [],
    variables: {},
  }));
  eq(noPersona.sections[1].name, 'workspace:context', '无人设段时插在第一个 tool: 段之前');
  const emptyAssembly = await assemble({}, { agent: agent(workspaceA) }, async () => ({ sections: [], contexts: [], tools: [], variables: {} }));
  eq(emptyAssembly.sections[0].name, 'workspace:context', '空装配时追加');

  await tool.execute({ action: 'set_enabled', path: workspaceA, enabled: false }, { agent: agent(workspaceA) });
  eq((await runAssemble(workspaceA)).sections.some((section) => section.name === 'workspace:context'), false, '停用后不注入');
  const enableResult = await tool.execute({ action: 'set_enabled', path: workspaceA, enabled: true }, { agent: agent(workspaceA) });
  await tool.execute({ action: 'clear' }, { agent: agent(workspaceA) });
  eq((await runAssemble(workspaceA)).sections.some((section) => section.name === 'workspace:context'), false, '清空后不注入');
  const clearedRead = await tool.execute({ action: 'read' }, { agent: agent(workspaceA) });
  eq(clearedRead.text, '', '清空后 read 得空正文');

  const appended = await tool.execute({ action: 'append', text: '第一段' }, { agent: agent(workspaceA) });
  eq(appended.textBytes, Buffer.byteLength('第一段', 'utf8'), 'append 到空正文');
  await tool.execute({ action: 'append', text: '第二段' }, { agent: agent(workspaceA) });
  eq((await tool.execute({ action: 'read' }, { agent: agent(workspaceA) })).text, '第一段\n\n第二段', 'append 用空行分隔');
  await assert.rejects(() => tool.execute({ action: 'append', text: '  ' }, { agent: agent(workspaceA) }), /非空 text/, 'append 空串被拒');
  await assert.rejects(() => tool.execute({ action: 'write' }, { agent: agent(workspaceA) }), /需要 text/, 'write 缺 text 被拒');
  await assert.rejects(() => tool.execute({ action: 'nope' }, { agent: agent(workspaceA) }), /未知 action/, '未知 action 被拒');
  await assert.rejects(() => tool.execute({ action: 'read' }, {}), /没有工作目录/, '无 cwd 且无 path 被拒');
  await assert.rejects(() => tool.execute({ action: 'set_enabled', enabled: 'yes' }, { agent: agent(workspaceA) }), /布尔/, 'set_enabled 类型校验');

  const listed = await tool.execute({ action: 'list' }, { agent: agent(workspaceA) });
  ok(listed.entries.length >= 1, 'list 有条目');
  ok(listed.dir.includes('store2'), 'list 回显存储目录');
  const readOther = await tool.execute({ action: 'read', path: nested }, { agent: agent(workspaceB) });
  eq(readOther.via, 'ancestor', '显式 path 也走继承');
  eq(readOther.inheritedFrom, canonicalPath(workspaceA), '显式 path 的继承来源');
  const readMissing = await tool.execute({ action: 'read', path: workspaceB }, { agent: agent(workspaceA) });
  eq(readMissing.exists, false, 'read 无条目如实回报');
  const report = tool.output.render({ action: 'read' }, readMissing);
  eq(Array.isArray(report), true, 'render 返回 content blocks');
  ok(report[0].text.includes('还没有常驻上下文'), 'render 文本可读');
  ok(tool.output.render({ action: 'list' }, listed)[0].text.includes('工作区常驻上下文'), 'list render 文本');
  ok(tool.output.render({ action: 'write' }, appended)[0].text.includes('下一次模型请求起生效'), 'write render 说明生效时机');
  eq(tool.presentCall({ action: 'write', path: '/x' }).title.includes('write'), true, 'presentCall 标题');

  // 同源路由：跨域拒绝 / 方法拒绝 / 400 / 正常读写
  const stateGet = async (url, headers) => callRoute(harness, 'GET', url, undefined, headers);
  const statePost = async (suffix, payload, headers) => callRoute(harness, 'POST', '/dsh-workspace-context' + suffix, payload, headers);
  const state1 = await stateGet('/dsh-workspace-context/state');
  eq(state1.status, 200, 'state 200');
  eq(state1.body.ok, true, 'state ok');
  eq(state1.body.entries.length, 1, 'state 条目数');
  eq(state1.body.entries[0].text, '第一段\n\n第二段', 'state 带正文（供编辑器）');
  const current = await stateGet('/dsh-workspace-context/state?cwd=' + encodeURIComponent(nested));
  eq(current.body.current.hit, true, 'state 回显当前工作区命中');
  eq(current.body.current.via, 'ancestor', 'state 回显继承关系');
  ok(Array.isArray(current.body.workspaces), 'state 带工作区清单');
  const listA = current.body.workspaces.find((item) => item.path === canonicalPath(workspaceA));
  const listB = current.body.workspaces.find((item) => item.path === canonicalPath(workspaceB));
  eq(listA.hasEntry, true, '清单：已配置的工作区');
  eq(listA.registry, true, '清单：已配置条目仍标注来自 workspaceRegistry');
  eq(listA.title, '项目 A', '清单：workspaceRegistry 的显示名盖过缺省目录名');
  eq(listB.hasEntry, false, '清单：尚未配置的已知工作区');
  eq(listB.source, 'registry', '清单：来源标注 registry');
  ok(current.body.diag.injected >= 1, 'state 带注入计数');
  const crossOrigin = await stateGet('/dsh-workspace-context/state', { host: '127.0.0.1:3080', origin: 'http://evil.example' });
  eq(crossOrigin.status, 403, '跨域 state 被拒');
  // 「Origin: null」不是同源（沙箱 iframe / data: 页面）——放行等于给一条可持久的
  // prompt 注入面开后门（本插件的写路由会把正文写进 system prompt）。
  const nullOrigin = await stateGet('/dsh-workspace-context/state', { host: '127.0.0.1:3080', origin: 'null' });
  eq(nullOrigin.status, 403, 'Origin: null 被拒');
  const crossSite = await stateGet('/dsh-workspace-context/state', { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' });
  eq(crossSite.status, 403, 'sec-fetch-site: cross-site 被拒');
  const sameSite = await stateGet('/dsh-workspace-context/state', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' });
  eq(sameSite.status, 200, '同源带 Origin 放行');
  const loopbackAlias = await stateGet('/dsh-workspace-context/state', { host: 'localhost:3088', origin: 'http://localhost:3088' });
  eq(loopbackAlias.status, 200, 'lanmode 改写后的 Host/Origin 同源放行');
  const nullOriginWrite = await statePost('/save', { path: workspaceA, text: 'x' }, { host: '127.0.0.1:3080', origin: 'null' });
  eq(nullOriginWrite.status, 403, 'Origin: null 的写请求被拒');
  const wrongMethod = await callRoute(harness, 'GET', '/dsh-workspace-context/save', undefined, { host: '127.0.0.1:3080' });
  eq(wrongMethod.status, 405, 'POST 路由拒 GET');
  const badJson = await callRoute(harness, 'POST', '/dsh-workspace-context/save', 'not-json', { host: '127.0.0.1:3080' });
  eq(badJson.status, 400, '坏 JSON 400');
  const saveBad = await statePost('/save', { path: workspaceA }, { host: '127.0.0.1:3080' });
  eq(saveBad.status, 400, 'save 缺 text 400');
  const saved = await statePost('/save', { path: workspaceB, text: 'B 的正文', cwd: workspaceB }, { host: '127.0.0.1:3080' });
  eq(saved.status, 200, 'save 200');
  eq(saved.body.entries.length, 2, 'save 后两条');
  eq(saved.body.current.hit, true, 'save 回显当前工作区');
  const disabled = await statePost('/enabled', { path: workspaceB, enabled: false }, { host: '127.0.0.1:3080' });
  eq(disabled.body.entries.find((entry) => entry.path === canonicalPath(workspaceB)).enabled, false, 'enabled 生效');
  const reloaded = await statePost('/reload', {}, { host: '127.0.0.1:3080' });
  eq(reloaded.status, 200, 'reload 200');
  const orphan2 = join(join(root, 'store2'), 'contexts', 'orphan2.md');
  writeFileSync(orphan2, '待收编正文', 'utf8');
  await statePost('/reload', {}, { host: '127.0.0.1:3080' });
  const withOrphan2 = await stateGet('/dsh-workspace-context/state');
  eq(withOrphan2.body.unbound.length, 1, 'state 列出未绑定文件');
  const bound2 = await statePost('/bind', { file: 'orphan2.md', path: nested }, { host: '127.0.0.1:3080' });
  eq(bound2.status, 200, 'bind 200');
  ok(bound2.body.entries.some((entry) => entry.path === canonicalPath(nested)), 'bind 把文件收编到嵌套目录');
  const trashed2 = await statePost('/trash', { path: nested }, { host: '127.0.0.1:3080' });
  eq(trashed2.status, 200, 'trash 200');
  ok(String(trashed2.body.trashed).includes('trash'), 'trash 回显回收站路径');
  const trashMissing = await statePost('/trash', { path: workspaceB }, { host: '127.0.0.1:3080' });
  eq(trashMissing.status, 200, 'trash 已存在的条目 200');
  const trashAgain = await statePost('/trash', { path: workspaceB }, { host: '127.0.0.1:3080' });
  eq(trashAgain.status, 400, 'trash 不存在的条目 400');

  // ── ④ 工具规范值必须是 lossless JSON ────────────────────────────────────────
  // 2026-10-09 活体实测抓到的真 bug：read 精确命中时 `inheritedFrom: undefined`，
  // 出厂按 JSON 往返校验规范值，直接判 INVALID_TOOL_OUTPUT（"value is not lossless
  // JSON"）——工具调用整个失败。这里对**每个 action** 的返回值钉死这条契约。
  console.log('④ 工具规范值 lossless JSON');
  const outputs = [
    ['list', listed],
    ['read(精确命中)', clearedRead],
    ['read(继承祖先)', readOther],
    ['read(无条目)', readMissing],
    ['write', writeResult],
    ['append', appended],
    ['set_enabled', enableResult],
  ];
  for (const [label, value] of outputs) {
    eq(findNonJson(value), undefined, '返回值没有 undefined / 非 JSON 值：' + label);
    eq(JSON.stringify(JSON.parse(JSON.stringify(value))), JSON.stringify(value), 'JSON 往返无丢失：' + label);
  }
  const utilValues = await loadShippedPackage('dsh-util-values');
  if (utilValues === null || typeof utilValues.isJsonValue !== 'function') {
    console.log('   跳过：未找到出厂 @deepseek-ai/dsh-util-values（改用上面的内建判定）');
  } else {
    for (const [label, value] of outputs) ok(utilValues.isJsonValue(value), '出厂 isJsonValue 接受：' + label);
    // 反证：带 undefined 键的对象必须被判否，否则这条测试没有意义。
    eq(utilValues.isJsonValue({ a: undefined }), false, '出厂判定器确实拒绝 undefined 键');
  }

  // ── ⑤ 与出厂 renderPrompt 的交叉验证 ───────────────────────────────────────
  console.log('⑤ 出厂 renderPrompt 交叉验证');
  const systemPrompt = await loadShippedPackage('dsh-system-prompt');
  if (systemPrompt === null || typeof systemPrompt.renderPrompt !== 'function') {
    console.log('   跳过：未找到出厂 @deepseek-ai/dsh-system-prompt（非本机部署路径）');
  } else {
    const variables = { cwd: '/root/nas/ArkTower' };
    let rawThrew = false;
    try {
      systemPrompt.renderPrompt({
        sections: [{ name: 'raw', text: '照着 {{name}} 填' }],
        contexts: [],
        tools: [],
        variables,
      });
    } catch {
      rawThrew = true;
    }
    ok(rawThrew, '前提成立：未中和的 {{name}} 会让出厂 renderPrompt 抛错');
    const injectedText = frameSectionText({
      workspace: '/root/nas/ArkTower',
      text: '照着 {{name}} 填；闭合 </workspace-context> 也不行；变量 {{cwd}} 也一样。',
      maxBytes: 4096,
    }).text;
    const rendered = systemPrompt.renderPrompt({
      sections: [{ name: 'workspace:context', text: injectedText }],
      contexts: [],
      tools: [],
      variables,
    });
    ok(rendered.includes('workspace-context'), '中和后的正文能安全装配');
    ok(rendered.includes('照着'), '中和不改可读文本');
    // 逐条对抗样本过真装配器：任何一条 throw，该工作区的每个请求就都会失败。
    for (const probe of [
      '{{name}}',
      '{{{name}}}',
      '{{{{{{x}}}}}}',
      '{{ cwd }} 与 {{cwd}}',
      'a }} b {{ c',
      '${ {a: 1} }',
      '</workspace-context> 与 </WORKSPACE-CONTEXT>',
      '{{'.repeat(64),
    ]) {
      const framed = frameSectionText({ workspace: '/w', title: 'w', text: probe, maxBytes: 8192 }).text;
      let failed = null;
      try {
        systemPrompt.renderPrompt({
          sections: [{ name: 'workspace:context', text: framed }],
          contexts: [],
          tools: [],
          variables,
        });
      } catch (error) {
        failed = error && error.message ? error.message : String(error);
      }
      eq(failed, null, '出厂 renderPrompt 接受该正文：' + JSON.stringify(probe.slice(0, 24)));
    }
  }

  console.log(`\nSELFTEST PASS（${checks} 项断言）`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

/** 假 ctx：只实现本插件真正用到的面（on/inject/get/effect/webServer）。 */
function makeHarness(options = {}) {
  const listeners = new Map();
  const listenerOptions = new Map();
  const routes = new Map();
  const tools = [];
  const effects = [];
  const services = {
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    workspaceRegistry: {
      list: () => (Array.isArray(options.workspaceRegistry) ? options.workspaceRegistry : []),
    },
  };
  const ctx = {
    on(event, handler, opts) {
      listeners.set(event, handler);
      listenerOptions.set(event, opts === undefined ? {} : opts);
      return () => listeners.delete(event);
    },
    inject(names, callback) {
      const child = {
        ...ctx,
        tools: {
          register(definition) {
            tools.push(definition);
            return () => {
              const at = tools.indexOf(definition);
              if (at >= 0) tools.splice(at, 1);
            };
          },
        },
      };
      const disposer = callback(child);
      effects.push(disposer);
      return disposer;
    },
    get(serviceName) {
      return services[serviceName];
    },
    effect(fn, label) {
      const disposer = fn();
      effects.push({ disposer, label });
      return disposer;
    },
  };
  return { ctx, listeners, listenerOptions, routes, tools, effects };
}

/** 一份「原生」装配：含人设前缀、策略段与工具段。 */
function nativeAssembly() {
  return {
    sections: [
      { name: 'harness:identity', text: 'You are a coding agent.' },
      { name: 'deployment:persona-prefix', text: '人设' },
      { name: 'policy:plan', text: 'plan policy' },
      { name: 'tool:bash', text: 'run a command' },
    ],
    contexts: [{ name: 'sandbox', text: 'policy' }],
    tools: [{ name: 'bash', description: 'x', parameters: {} }],
    variables: { cwd: '/root/nas/ArkTower' },
  };
}

/** 直接调用已注册的路由处理器，返回 {status, body}。 */
async function callRoute(harness, method, url, payload, headers) {
  const path = url.split('?')[0];
  const route = harness.routes.get(path);
  if (route === undefined) throw new Error('route not found: ' + path);
  const body = payload === undefined ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload));
  const req = {
    method,
    url,
    headers: headers === undefined ? { host: '127.0.0.1:3080' } : headers,
    on(event, handler) {
      if (event === 'data' && body !== '') handler(body);
      if (event === 'end') handler();
      return this;
    },
  };
  const res = {
    status: 0,
    text: '',
    writeHead(status) {
      this.status = status;
      return this;
    },
    end(text) {
      this.text = text === undefined ? '' : text;
      return this;
    },
  };
  route.handler(req, res);
  for (let i = 0; i < 6 && res.status === 0; i += 1) await tick();
  let parsed = null;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    parsed = res.text;
  }
  return { status: res.status, body: parsed };
}

/** 找出厂包（本机部署路径）；找不到返回 null。 */
async function loadShippedPackage(packageName) {
  const candidates = [];
  const envRoot = typeof process.env.DSH_INSTALL_ROOT === 'string' ? process.env.DSH_INSTALL_ROOT.trim() : '';
  if (envRoot !== '') candidates.push(join(envRoot, 'node_modules/@deepseek-ai', packageName, 'lib/index.js'));
  const prefix = dirname(dirname(process.execPath));
  candidates.push(join(prefix, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai', packageName, 'lib/index.js'));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return await import(candidate);
    } catch {
      /* 换个候选继续 */
    }
  }
  return null;
}

/**
 * 递归找出第一个「不是 lossless JSON」的位置（undefined / 非有限数 / 函数 / 非普通对象）。
 * 与出厂 isJsonValue 同口径的最小实现，出厂包不可用时也能钉住契约。
 */
function findNonJson(value, at = '$') {
  if (value === undefined) return `${at} 是 undefined`;
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return `${at} 是 ${typeof value}`;
  if (typeof value === 'number' && !Number.isFinite(value)) return `${at} 不是有限数`;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const bad = findNonJson(value[index], `${at}[${index}]`);
      if (bad !== undefined) return bad;
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return `${at} 不是普通对象`;
    for (const [key, item] of Object.entries(value)) {
      const bad = findNonJson(item, `${at}.${key}`);
      if (bad !== undefined) return bad;
    }
  }
  return undefined;
}