#!/usr/bin/env node
/** tests/scene_hygiene_selftest.mjs —— v2.6 · 反馈 #3「多灯卫生」
 *
 * 现场：36 盏灯时 EEVEE 每帧刷 Shadow buffer full (3040 / 2048)，而 shadow_pool_size='4096' 静默无效
 * （枚举上限就是 2048）。旧行为只在 stderr 里刷屏；新行为进回执 warnings[]，带能直接粘贴的修法。
 *
 *   A 一行溢出 → 1 条 warning，带 used/limit/occurrences
 *   B 多条 → occurrences 计数
 *   C 正常输出 → 不产生 warning（防误报）
 *   D fix 里点名 2048 与 use_shadow（可执行）
 *   E K.light_hygiene 的提示文案与校验（静态检查 bootstrap 里有这个 helper）
 *
 * 用法：node tests/scene_hygiene_selftest.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const engine = await import(pathToFileURL(path.join(ROOT, 'runtime', 'engine.mjs')).href)
const NL = String.fromCharCode(10)
let pass = 0, fail = 0
const failures = []
function ok(name, cond, detail) { if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; failures.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) } }
const audit = engine.sceneHygieneAudit
ok('sceneHygieneAudit 已导出', typeof audit === 'function')
// A
let w = audit('', 'Error: Shadow buffer full, may result in missing shadows and lower performance. (3040 / 2048)' + NL)
ok('A 一行溢出 → 1 条 warning', w.length === 1 && w[0].code === 'eevee_shadow_pool_full', JSON.stringify(w))
ok('A 解析出 used/limit', w[0] && w[0].used_mb === 3040 && w[0].limit_mb === 2048, JSON.stringify(w[0] && [w[0].used_mb, w[0].limit_mb]))
// B
w = audit('', ['x', 'Error: Shadow buffer full (10 / 2048)', 'Error: Shadow buffer full (3000 / 2048)'].join(NL))
ok('B 多条 → occurrences 计数且取最后一条的数值', w.length === 1 && w[0].occurrences === 2 && w[0].used_mb === 3000, JSON.stringify(w[0]))
// C
w = audit('building geometry' + NL + 'Saved: ok.png' + NL, '')
ok('C 正常输出不误报', w.length === 0)
// D
const fix = w.length ? '' : audit('', 'Error: Shadow buffer full (1 / 2048)')[0].fix
ok('D fix 点名 2048 且行得通（use_shadow=False）', fix.indexOf('2048') >= 0 && fix.indexOf('use_shadow') >= 0, fix)
// E
ok('E K.light_hygiene 在 KERNEL_BOOTSTRAP 里', String(engine.KERNEL_BOOTSTRAP).indexOf('K.light_hygiene') >= 0)
ok('E K.route_collections 在 KERNEL_BOOTSTRAP 里（写作用域第二维）', String(engine.KERNEL_BOOTSTRAP).indexOf('K.route_collections') >= 0)
console.log('')
console.log('scene-hygiene-selftest：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) for (const f of failures) console.log('  x ' + f)
process.exit(fail ? 1 : 0)