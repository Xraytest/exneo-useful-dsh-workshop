#!/usr/bin/env node
/**
 * 换版：把整张 import 图的 loader 缓存标记统一改成新值，并生成新的入口文件。
 *
 * ── 为什么需要脚本而不是手改 ─────────────────────────────────────────────────
 * loader 按 specifier 缓存模块，而 `?v=` 只是**缓存键**。要让「改了某个 lib 之后
 * 运行实例真的重新读它」，标记必须在**整张图里同时换掉**：
 *
 *   entry-vN.js  →  protocol.js?v=X
 *                →  inventory-cache.js?v=X  →  inventory.js?v=X
 *                →  caller.js?v=X           →  exec.js?v=X  →  protocol.js?v=X
 *
 * 只换入口那一层的标记是**不够**的，而且失败方式极其隐蔽：换了的模块（如
 * inventory-cache.js）确实重读了，但它内部仍然 `import './inventory.js?v=旧'`，
 * 于是真正改动的那个文件还是旧实例 —— 表现就是「改了代码、/status 的版本号变了、
 * 但行为没变」。本项目实际踩过这个坑（inventory.js 的标题折叠修正没生效）。
 *
 * 用法：`node bump-version.mjs`（在当前版本号上 +1）。
 * 之后把 `cordis.patch.yml` 里 device-mesh 行的 name 指到新入口（保持同一行 id）。
 *
 * @module dsh-device-mesh/bump-version
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 匹配的是**字面量** `?v=mesh-N`：它只会出现在 import/export 说明符里，
// 不会出现在注释的散文里（注释写的是「从 mesh-1 换成 mesh-2」，没有 `?v=`）。
// 早期版本用了一个「从 ./ 到 ? 再吃掉 mesh-N」的正则，结果在
// `./inventory.js?v=mesh-4` 上匹配失败（`?` 与 `mesh-` 之间隔着 `v=`），
// 换版时把标记整个删掉了 —— 简单字面量替换在这里更难写错。
const SPECIFIER = /(\.\/[a-z0-9-]+\.js)(\?v=mesh-\d+)?/g

/**
 * 参与「整张图」的文件。
 *
 * 这里**曾经是硬编码名单**（v11 之前那 10 个模块）。v11 新增的 fs-bridge /
 * shell-bridge / fs-inbound / routing 一个都不在名单里，于是它们既不参与换版、
 * 也不参与下面的一致性检查 —— 结果是 v11 的入口写着 `?v=mesh-11`，而底下所有
 * 模块仍指向 `?v=mesh-10`，整张图悄悄裂成两个版本。这正是本文件开头警告的那种
 * 「隐蔽失败」，根因却是名单要靠人记得改。
 *
 * 所以改成**扫描目录**：新增模块自动入图，不再依赖人的记忆。
 * 入口（`entry-v<N>.js`）不在名单里 —— 它在第 3 步由旧入口复制生成；
 * `index.js` 也不在 —— 它只做再导出，另有单独的第 4 步处理。
 */
const SOURCES = fs.readdirSync(HERE)
  .filter((name) => name.endsWith('.js') && !/^entry-v\d+\.js$/.test(name) && name !== 'index.js')
  .sort()

if (SOURCES.length === 0) throw new Error('没有找到任何待换版的模块（目录不对？）')

/** 找当前入口文件与版本号。 */
function current() {
  const entries = fs.readdirSync(HERE)
    .map((name) => /^entry-v(\d+)\.js$/.exec(name))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]))
  if (entries.length === 0) throw new Error('找不到 entry-v<N>.js')
  const version = Math.max(...entries)
  return { version, entry: `entry-v${version}.js` }
}

const { version, entry } = current()
const next = version + 1

// 1) 先确认整张图当前是一致的 —— 不一致就先炸，而不是把不一致扩散到新版本。
//
//    `from` 从**图里实际的标记**推，而不是从入口编号推。旧写法是
//    `from = `mesh-${version}``，它假设「入口编号 == 缓存标记」；只要有人手工从上一版
//    复制出入口（本仓库真发生过：entry-v21.js 是手工造的，标记仍是 mesh-20），
//    这个假设就不成立，于是预检会把一次完全正常的换版判成「整张图标记不一致」顶回去
//    —— 报错说的是「文件不一致」，真正不一致的却是这行假设。
const markersByFile = new Map()
for (const name of [entry, ...SOURCES]) {
  const text = fs.readFileSync(path.join(HERE, name), 'utf8')
  const seen = new Set(
    [...text.matchAll(SPECIFIER)]
      .map((match) => match[2])
      .filter((suffix) => suffix !== undefined),
  )
  if (seen.size > 0) markersByFile.set(name, seen)
}
const allMarkers = new Set([...markersByFile.values()].flatMap((seen) => [...seen]))
if (allMarkers.size !== 1) {
  console.error('import 图的缓存标记不一致，先修好再换版：')
  for (const [name, seen] of markersByFile) console.error(`  - ${name}: ${[...seen].join(', ')}`)
  process.exit(1)
}
const from = [...allMarkers][0].replace('?v=', '')
const fromNumber = Number(from.replace('mesh-', ''))
if (!Number.isSafeInteger(fromNumber) || fromNumber <= 0) {
  console.error(`无法从标记 ${from} 解析出版本号`)
  process.exit(1)
}
const to = `mesh-${fromNumber + 1}`

// IMPORT_TAG 是 /status 的「跑的是哪一版」自报值。它不是说明符，所以曾经
// 在换版时被漏掉，/status 于是长期报着旧版本号 —— 一个专门用来判断版本的
// 字段报错版本，比没有这个字段更糟。这里一并检查、一并换。
const inconsistent = []
for (const name of [entry, ...SOURCES]) {
  const text = fs.readFileSync(path.join(HERE, name), 'utf8')
  const tag = /const IMPORT_TAG = '(mesh-\d+)'/.exec(text)
  if (tag !== null && tag[1] !== from) {
    inconsistent.push(`${name}: IMPORT_TAG 是 ${tag[1]}（期望 ${from}）`)
  }
}
if (inconsistent.length > 0) {
  console.error('import 图的 IMPORT_TAG 与标记不一致，先修好再换版：')
  for (const line of inconsistent) console.error('  - ' + line)
  process.exit(1)
}

// 2) 整张图一起换（入口在下一步由旧入口复制生成，所以这里先改 lib）。
for (const name of SOURCES) {
  const file = path.join(HERE, name)
  const text = fs.readFileSync(file, 'utf8')
  // 整份文件里只替换说明符上的标记；注释里的历史叙述保持原样。
  fs.writeFileSync(
    file,
    text.replace(SPECIFIER, (_all, modulePath) => `${modulePath}?v=${to}`)
      .replace(/const IMPORT_TAG = 'mesh-\d+'/, `const IMPORT_TAG = '${to}'`),
    'utf8',
  )
}

// 3) 新入口 = 旧入口（此时旧入口还是旧标记）换标记后落盘。
//
// 先把**之前生成过的**头部整块剥掉再套新的：否则每换一版就会叠一层
// 「本文件与上一版逐字相同」，几版之后那几句就全是假的（它还与上上版相同）。
const GENERATED_HEADER = /^\/\*\*\n \* 本文件由 `node bump-version\.mjs` 生成[\s\S]*?\*\/\n\n/g
let entrySource = fs.readFileSync(path.join(HERE, entry), 'utf8')
while (GENERATED_HEADER.test(entrySource)) entrySource = entrySource.replace(GENERATED_HEADER, '')
const header = `/**
 * 本文件由 \`node bump-version.mjs\` 生成（v${version} → v${next}），与 v${version} 逐字相同，
 * 只是把整张 import 图的 loader 缓存标记从 ${from} 换成了 ${to}。
 *
 * 为什么需要它：loader 按 specifier 缓存模块，改完 lib 之后必须让**整个图**按新 URL
 * 重新求值，而入口文件的路径本身也是缓存键的一部分 —— 所以「换版本」= 新入口文件名
 * + 全图统一的新标记。细节与踩过的坑见 bump-version.mjs 头部注释。
 *
 * @module dsh-device-mesh/entry-v${next}
 */

`
fs.writeFileSync(
  path.join(HERE, `entry-v${next}.js`),
  header + entrySource
    .replace(SPECIFIER, (_all, modulePath) => `${modulePath}?v=${to}`)
    .replace(/const IMPORT_TAG = 'mesh-\d+'/, `const IMPORT_TAG = '${to}'`),
  'utf8',
)

// 4) 稳定入口指向新版本。
//
// 这里曾经有两个坑，都是「静默 no-op」那一类：
//   ① 旧正则要求说明符带 `?v=mesh-N`，而 index.js 里写的是 `./entry-v<N>.js`（无标记）
//      —— 于是这一步从来没生效过，只有靠人肉发现；
//   ② 改成「匹配第一处 `./entry-v<N>.js`」之后，第一个命中的其实是**文件头注释**里的
//      那一处，真正的 `export * from ...` 还是没被动过（实测：注释一路被改成 v13，
//      export 却停在 v11）。
// 所以现在**只认 export 语句**，并在没命中时明确警告，而不是假装成功。
const indexFile = path.join(HERE, 'index.js')
const indexText = fs.readFileSync(indexFile, 'utf8')
const EXPORT_SPECIFIER = /(export \* from '\.\/entry-v)\d+(\.js)';/
const indexNext = indexText
  .replace(EXPORT_SPECIFIER, (_all, prefix, suffix) => `${prefix}${next}${suffix}';`)
  // 注释里的那一处一并跟上，免得文档和代码说的是两件事（先替换注释，再替换 export，
  // 否则注释会被上面那条规则一起吃掉——两条规则各管各的更清楚）。
  .replace(/(\* 实现全在 `\.\/entry-v)\d+(\.js`)/, (_all, prefix, suffix) => `${prefix}${next}${suffix}`)
if (!EXPORT_SPECIFIER.test(indexText)) {
  console.warn('警告：index.js 里没有匹配到 `export * from \'./entry-v<N>.js\';`，未做替换，请手工确认。')
} else {
  fs.writeFileSync(indexFile, indexNext, 'utf8')
}

console.log(`已换版：${entry} → entry-v${next}.js（标记 ${from} → ${to}）`)
console.log(`下一步：把 cordis.patch.yml 里 device-mesh 行的 name 指到 ./plugins/dsh-device-mesh/entry-v${next}.js`)
