#!/usr/bin/env node
/**
 * tests/tool_cards_selftest.mjs —— v2.6.1：工具卡片（presentCall / presentResult）
 *
 * 宿主（dsh-TUI / Web）用这两个方法决定卡片怎么显示；没有它们时卡片头是整段 JSON 参数、
 * 正文是原始回执（renderStructured 的第 0 块是单行 JSON 信封）。本测试固定：
 *   A 15 个工具都挂了 presenter（经 vTool 统一注入）
 *   B 调用卡片：标题「Blender <动作> · <要点>」，带代码的调用把代码放进正文
 *   C 结果卡片：去信封、摘要在前、代码在后、图片原样透传；出错 / 没东西可改 ⇒ undefined
 *   D 模型侧回执不变：render 输出仍带信封
 *   E 纯函数 + lossless JSON + 坏参数不抛
 *
 * 不需要 Blender，也不起后端（autoStart=false）。
 * 用法：node tests/tool_cards_selftest.mjs
 */
const { apply, __internals } = await import('../lib/index.js')

let pass = 0, fail = 0
const failures = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; failures.push(name); console.log('  ✗ ' + name + (detail === undefined ? '' : (' — ' + String(detail).slice(0, 300)))) }
}
const NL = String.fromCharCode(10)

console.log('== 工具卡片自检（presentCall / presentResult）==')

const tools = new Map()
const ctx = {
  effect(fn) { const d = fn(); return d },
  tools: { register(t) { tools.set(t.name, t); return () => tools.delete(t.name) } },
  inject() {},
  get() { return undefined },
}
apply(ctx, { autoStart: false, port: 9899 })

// ── A：全部工具都有 presenter
ok('注册了 15 个工具', tools.size === 15, tools.size)
const missing = [...tools.values()].filter((t) => typeof t.presentCall !== 'function' || typeof t.presentResult !== 'function').map((t) => t.name)
ok('每个工具都有 presentCall + presentResult', missing.length === 0, JSON.stringify(missing))
const specNames = Object.keys(__internals.cards.specs).sort()
ok('CARD_SPECS 与注册的工具名一一对应', JSON.stringify(specNames) === JSON.stringify([...tools.keys()].sort()), JSON.stringify(specNames))

const call = (name, args) => tools.get(name).presentCall(args)
const result = (name, args, content, isError = false) => tools.get(name).presentResult(args, { content, isError })

// ── B：调用卡片
const see = call('blender_rt_see', {})
ok('rt_see 默认标题', see && see.card === 'generic' && see.title === 'Blender 看视口 · 560px' && see.kind === 'read', JSON.stringify(see))
const seeCustom = call('blender_rt_see', { from: '7,-7,5', look_at: '0,0,1', max_size: 900, shading: 'SOLID' })
ok('rt_see 自定义视角标题', seeCustom.title === 'Blender 看视口 · 自定义视角 7,-7,5 → 0,0,1 · SOLID · 900px', seeCustom.title)
ok('rt_see full=true 是截窗口', call('blender_rt_see', { full: true, area: 2 }).title === 'Blender 截窗口 · 区域 2')

const code = '# 换材质' + NL + 'import bpy' + NL + 'o = bpy.data.objects["Cube"]' + NL + NL + 'o.location.z += 1'
const doCall = call('blender_rt_do', { code: code })
ok('rt_do 标题取首个非注释行 + 行数', doCall.title === 'Blender 执行 Python · import bpy（+3 行）' && doCall.kind === 'execute', doCall.title)
ok('rt_do 代码进调用卡片正文', Array.isArray(doCall.content) && doCall.content.length === 1
  && doCall.content[0].text.startsWith('▸ Python（5 行）' + NL) && doCall.content[0].text.endsWith('o.location.z += 1'), JSON.stringify(doCall.content))
ok('rt_do session 进标题', call('blender_rt_do', { code: 'x = 1', session: 'w1' }).title === 'Blender 执行 Python · x = 1 · 无头 w1')
ok('rt_do 只给 file 时取文件名', call('blender_rt_do', { file: 'C:\\work\\scripts\\fix.py' }).title === 'Blender 执行 Python · fix.py')
ok('rt_cmd 标题带命令名与参数键', call('blender_rt_cmd', { name: 'get_selection', params: { a: 1, b: 2, c: 3, d: 4 } }).title === 'Blender 命令 · get_selection · {a, b, c, …}')
ok('rt_commands 标题', call('blender_rt_commands', {}).title === 'Blender 命令清单')
ok('rt_plan 标题带 op', call('blender_rt_plan', { op: 'catalog' }).title === 'Blender 规划 · catalog')
ok('rt_headless 脚本文件取文件名 + 作业标记', call('blender_rt_headless', { script_file: '/tmp/a/bake.py', file: '/tmp/m.blend', as_job: true }).title === 'Blender 无头 · bake.py · m.blend · 作业')
ok('rt_job 标题', call('blender_rt_job', { op: 'status', id: 'job-42' }).title === 'Blender 作业 · status · job-42')
ok('blender_viewport 标题带 op', call('blender_viewport', { op: 'doctor' }).title === 'Blender 通道 · doctor')
ok('参数不合 schema ⇒ undefined（defineTool 先校验，宿主退回通用卡片）', call('blender_viewport', {}) === undefined)
ok('不带代码的调用卡片没有正文', call('blender_rt_see', {}).content === undefined)

const longCode = 'bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0), rotation=(0, 0, 0), scale=(1, 1, 1))' + NL + 'x = 1'
const longTitle = call('blender_rt_do', { code: longCode }).title
ok('超长首行在标题里截断', longTitle.length <= 80 && longTitle.includes('…'), longTitle)

const hugeCode = Array.from({ length: 3000 }, (_, i) => 'x' + String(i) + ' = ' + String(i)).join(NL)
const huge = call('blender_rt_do', { code: hugeCode }).content[0].text
ok('超长代码在正文里保留头尾、中间省略', huge.length < 4300 && huge.includes('中间省略') && huge.endsWith('x2999 = 2999'), huge.length)

// ── C：结果卡片
const envelope = JSON.stringify({ ok: true, op: 'asm_scan', ms: 120 })
const image = { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 4, height: 4 } }
const plan = result('blender_rt_plan', { op: 'asm_scan' }, [{ type: 'text', text: envelope }, { type: 'text', text: 'PLAN asm_scan ok · 12 件' + NL + '明细…' }, image])
ok('结构化回执去掉 JSON 信封', plan && plan.card === 'generic' && plan.content[0].type === 'text' && !plan.content[0].text.includes('"ok":true'), JSON.stringify(plan))
ok('摘要在最前', plan.content[0].text.startsWith('PLAN asm_scan ok · 12 件'), plan.content[0].text)
ok('图片块原样透传到最后', plan.content.length === 2 && JSON.stringify(plan.content[1]) === JSON.stringify(image))
ok('不给 title（沿用调用卡片标题）', plan.title === undefined)

const doRes = result('blender_rt_do', { code: code }, [{ type: 'text', text: 'DO ok · 105ms' + NL + 'stdout: 1' }, image])
ok('rt_do 结果：摘要在前、代码在后（单个 text block）', doRes.content[0].text.startsWith('DO ok · 105ms' + NL + 'stdout: 1' + NL + NL + '▸ Python（5 行）')
  && doRes.content.filter((b) => b.type === 'text').length === 1, JSON.stringify(doRes.content[0]))
ok('rt_do 结果图片仍在', doRes.content[doRes.content.length - 1] === image)

ok('出错的结果交给宿主默认显示', result('blender_rt_do', { code: code }, [{ type: 'text', text: 'boom' }], true) === undefined)
ok('没有信封也没有代码 ⇒ undefined（原始回执已经是人读文本）', result('blender_rt_see', {}, [{ type: 'text', text: 'SEE ok' }, image]) === undefined)
ok('多行 JSON 不当信封剥', result('blender_rt_plan', { op: 'x' }, [{ type: 'text', text: '{' + NL + '"a": 1' + NL + '}' }, { type: 'text', text: 'b' }]) === undefined)
ok('只有一块 JSON 时不剥（那是唯一内容）', result('blender_rt_plan', { op: 'x' }, [{ type: 'text', text: envelope }]) === undefined)

// ── D：模型侧回执不变
const rendered = tools.get('blender_rt_plan').output.render({ op: 'x' }, { text: 'hi', envelope: { ok: true } })
ok('render 输出仍以 JSON 信封开头', Array.isArray(rendered) && rendered[0].text === '{"ok":true}' && rendered[1].text === 'hi', JSON.stringify(rendered))

// ── E：纯函数 / lossless / 坏参数
ok('同一参数两次 presentCall 结果相同', JSON.stringify(call('blender_rt_do', { code: code })) === JSON.stringify(call('blender_rt_do', { code: code })))
let threw = null
try {
  for (const t of tools.values()) {
    t.presentCall({})
    t.presentCall(null)
    t.presentCall({ op: 123, code: 5, session: {} })
    t.presentResult({}, { content: [{ type: 'text', text: envelope }, { type: 'text', text: 'x' }], isError: false })
    t.presentResult({}, {})
    t.presentResult(null, null)
  }
} catch (e) { threw = e }
ok('奇怪参数 / 空结果都不抛', threw === null, threw && threw.stack)
const views = [...tools.values()].map((t) => [t.presentCall({}), t.presentResult({}, { content: [{ type: 'text', text: envelope }, { type: 'text', text: 'x' }], isError: false })])
ok('所有 view 都是 lossless JSON', views.every(([c, r]) => (c === undefined || JSON.stringify(JSON.parse(JSON.stringify(c))) === JSON.stringify(c))
  && (r === undefined || JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r))))

console.log('')
console.log('工具卡片自检：' + String(pass) + ' 通过 / ' + String(fail) + ' 失败')
if (fail) { console.log('失败项：' + failures.join(' | ')); process.exit(1) }
process.exit(0)
