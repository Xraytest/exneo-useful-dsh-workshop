#!/usr/bin/env node
/**
 * tests/skill_bundle_selftest.mjs —— v2.2.0 捆绑技能（bundled skill）回归门
 *
 * 为什么有这个文件
 * ---------------------------------------------------------------------------
 * v2.2.0 起 `blender-modeling` skill 不再要求用户去独立仓库下载，而是随插件发布：
 *   - 内容：`skills/blender-modeling/`（SKILL.md + references + LICENSE/NOTICE）
 *   - 注册：host 侧 `apply()` 在宿主有 `skills` 服务时注册一个 bundled provider
 * 这条链路**静默失败**的代价很高（用户以为装插件就自带，实际技能目录里没有），
 * 所以这里把「文件在不在 / frontmatter 合不合法 / provider 形状对不对 / 注册路径通不通」
 * 全部变成可自动断言的用例。
 *
 * 用法：node tests/skill_bundle_selftest.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.join(HERE, '..')
const SKILL_DIR = path.join(PKG, 'skills', 'blender-modeling')
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md')
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; failures.push(name + (detail ? (' — ' + detail) : '')); console.log('  ✗ ' + name + (detail ? (' — ' + detail) : '')) }
}
function section(t) { console.log('\n== ' + t + ' ==') }

function stripFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  return m ? raw.slice(m[0].length) : raw
}

async function main() {
  /* ── 1. 资产树（发布包里必须真的存在） ─────────────────────────────── */
  section('1. skills/blender-modeling 资产树')
  ok('SKILL.md 存在', fs.existsSync(SKILL_FILE), SKILL_FILE)
  if (fs.existsSync(SKILL_FILE)) {
    const raw = fs.readFileSync(SKILL_FILE, 'utf8')
    ok('SKILL.md 以 YAML frontmatter 开头', raw.startsWith('---\n') || raw.startsWith('---\r\n'))
    ok('SKILL.md 体量合理（> 50 KB）', raw.length > 50 * 1024, raw.length + ' chars')
    const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
    ok('frontmatter 可解析', fm !== null)
    const meta = {}
    if (fm) {
      let key = ''
      for (const line of fm[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
        if (kv) { key = kv[1]; meta[key] = kv[2].trim() } else if (key && /^\s+\S/.test(line)) meta[key] = (meta[key] || '') + ' ' + line.trim()
      }
    }
    ok('name = blender-modeling', meta.name === 'blender-modeling', String(meta.name))
    ok('description 非空且足够长（catalog 会截 500 字）', typeof meta.description === 'string' && meta.description.length >= 100, String(meta.description || '').length + ' chars')
    ok('license 字段保留（MIT 来源声明）', typeof meta.license === 'string' && meta.license.length > 0)
  }

  const expectedRefs = ['modeling-overview.md', 'multiview-calibration.md', '参考图通用还原SOP.md', '验收清单.md']
  const refDir = path.join(SKILL_DIR, 'references')
  ok('references/ 目录存在', fs.existsSync(refDir))
  for (const f of expectedRefs) ok('references/' + f, fs.existsSync(path.join(refDir, f)))
  ok('LICENSE（MIT）随包', fs.existsSync(path.join(SKILL_DIR, 'LICENSE')))
  ok('NOTICE.md（上游归属）随包', fs.existsSync(path.join(SKILL_DIR, 'NOTICE.md')))
  ok('README.md（随包说明）存在', fs.existsSync(path.join(SKILL_DIR, 'README.md')))

  // .bak / 临时文件绝不能混进发布包（独立仓库里有过 3 个 SKILL.md.bak-*）
  const bad = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(bak|tmp|orig)$|\.bak-|~$/.test(e.name)) bad.push(path.relative(PKG, p))
    }
  }
  walk(SKILL_DIR)
  ok('没有 .bak/.tmp 等临时文件', bad.length === 0, bad.join(', '))

  /* ── 2. 打包面：package.json files 必须包含 skills ─────────────────── */
  section('2. package.json 打包面 / 版本')
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'))
  ok('files 包含 "skills"', Array.isArray(pkg.files) && pkg.files.includes('skills'), JSON.stringify(pkg.files || []))
  ok('name 正确', pkg.name === '@dsh-external/dsh-blender-plugin')
  ok('license 仍是 BSD-3-Clause（技能子目录单独 MIT）', pkg.license === 'BSD-3-Clause', String(pkg.license))

  /* ── 3. lib 里的 bundled provider（编译产物 = 真正装载的东西） ─────── */
  section('3. lib/index.js · bundled provider')
  let lib
  try {
    lib = await import(pathToFileURL(path.join(PKG, 'lib', 'index.js')).href)
  } catch (e) {
    ok('lib/index.js 可 import（先跑 npm run build）', false, String((e && e.message) || e))
    return finish()
  }
  ok('lib/index.js 可 import', true)
  ok('导出版本号与 package.json 一致', lib.__internals.PLUGIN_VERSION === pkg.version, lib.__internals.PLUGIN_VERSION + ' vs ' + pkg.version)
  const bs = lib.__internals && lib.__internals.bundledSkill
  ok('测试接缝 __internals.bundledSkill 存在', !!bs)
  if (!bs) return finish()
  ok('bundled skill 目录解析正确', path.resolve(bs.dir) === path.resolve(SKILL_DIR), bs.dir)
  ok('provider 名合法', typeof bs.provider === 'string' && NAME_RE.test(bs.provider), String(bs.provider))
  ok('rank = 600（与 DSH BUNDLED_SKILL_RANK 同值）', bs.rank === 600, String(bs.rank))

  const provider = bs.createProvider()
  ok('createProvider() 非空（SKILL.md 可读且 frontmatter 合法）', provider !== null)
  if (provider !== null) {
    ok('provider.name 与声明一致', provider.name === bs.provider)
    const candidates = await provider.list({ cwd: PKG })
    ok('list() 返回数组且恰好 1 条', Array.isArray(candidates) && candidates.length === 1)
    // 宿主契约：registry.waitWithAbort() 在调用方带 signal 时直接对返回值 `.then(...)`；
    // 同步返回数组会抛 `promise.then is not a function` 并被静默 skip（真实会话里每条 lookup 都带 signal）。
    const listWithSignal = provider.list({ cwd: PKG, signal: new AbortController().signal })
    ok('list() 返回 thenable（带 signal 的宿主调用不会 TypeError）', !!listWithSignal && typeof listWithSignal.then === 'function')
    const candidatesWithSignal = await listWithSignal
    ok('带 signal 的 list() 结果正常', Array.isArray(candidatesWithSignal) && candidatesWithSignal.length === 1)
    const cand = candidates[0]
    // 逐条对照 @deepseek-ai/dsh-skill 的 validateCandidate（不 import 宿主包，避免测试依赖宿主安装）
    ok('candidate.name = blender-modeling', cand.name === 'blender-modeling', String(cand.name))
    ok('candidate.description 非空', typeof cand.description === 'string' && cand.description.length > 0)
    ok('candidate.invocation 开关都是 boolean', cand.invocation && cand.invocation.modelInvocable === true && cand.invocation.userInvocable === true)
    ok('candidate.source = bundled', cand.source === 'bundled', String(cand.source))
    ok('candidate.provider 与 provider.name 一致', cand.provider === provider.name)
    ok('candidate.rank 是有限数且 = 600', cand.rank === 600)
    ok('candidate.resourceBase = directory 且真实存在', cand.resourceBase && cand.resourceBase.kind === 'directory' && fs.existsSync(cand.resourceBase.path), JSON.stringify(cand.resourceBase))
    ok('candidate.path 指向 SKILL.md', path.resolve(cand.path) === path.resolve(SKILL_FILE), String(cand.path))

    const def = await provider.get(cand, {})
    ok('get() 返回完整定义', def && typeof def === 'object')
    const getWithSignal = provider.get(cand, { signal: new AbortController().signal })
    ok('get() 返回 thenable（带 signal 的宿主调用不会 TypeError）', !!getWithSignal && typeof getWithSignal.then === 'function')
    const defWithSignal = await getWithSignal
    ok('带 signal 的 get() 能加载全文', !!defWithSignal && typeof defWithSignal.content === 'string' && defWithSignal.content.includes('# Blender 建模流程'))
    ok('定义名 = candidate 名', def.name === cand.name)
    ok('定义带 content（已剥离 frontmatter）', typeof def.content === 'string' && !def.content.startsWith('---\n') && def.content.length > 50 * 1024)
    ok('正文含 skill 标题（# Blender 建模流程）', def.content.includes('# Blender 建模流程'))
    const raw = fs.readFileSync(SKILL_FILE, 'utf8')
    ok('content 与磁盘 SKILL.md 去 frontmatter 后逐字一致', def.content === stripFrontmatter(raw))
    ok('resourceBase 在定义里同样存在', def.resourceBase && def.resourceBase.kind === 'directory')
  }

  /* ── 4. frontmatter 解析器边界（catalog 全靠它拿 description） ──────── */
  section('4. parseSkillFrontmatter 边界')
  const pf = bs.parseFrontmatter
  const a = pf('---\nname: demo-skill\ndescription: "a quoted line"\n---\nbody\n')
  ok('双引号包裹的值去引号', a.meta.name === 'demo-skill' && a.meta.description === 'a quoted line', JSON.stringify(a.meta))
  ok('body 不含 frontmatter', a.body === 'body\n')
  const b = pf("---\nname: demo-skill\ndescription: 'single'\n---\n")
  ok('单引号包裹的值去引号', b.meta.description === 'single', JSON.stringify(b.meta))
  const c = pf('---\nname: demo-skill\ndescription: line one\n  line two\n---\nx')
  ok('缩进 continuation 合并', c.meta.description === 'line one line two', JSON.stringify(c.meta))
  const d = pf('no frontmatter here')
  ok('无 frontmatter 时不抛且 body 原文返回', d.meta.name === undefined && d.body === 'no frontmatter here')

  /* ── 5. 注册路径：有 skills 服务 / 没有 skills 服务都不能拖垮插件 ───── */
  section('5. 注册路径（fake ctx，不启动 DSH）')
  let injectedDeps = null
  let registeredProvider = null
  const fakeCtx = {
    logger: { warn() {} },
    inject(deps, cb) { injectedDeps = deps; cb({ skills: { registerProvider(factory) { registeredProvider = factory({}) } } }) },
  }
  let threw = null
  try { bs.register(fakeCtx) } catch (e) { threw = e }
  ok('register() 不抛', threw === null, String(threw))
  ok('走 ctx.inject([\'skills\'])（服务可用时才注册）', Array.isArray(injectedDeps) && injectedDeps.length === 1 && injectedDeps[0] === 'skills', JSON.stringify(injectedDeps))
  ok('注册到的 provider 名正确', registeredProvider && registeredProvider.name === bs.provider)
  if (registeredProvider) {
    const list = await registeredProvider.list({ cwd: PKG })
    ok('注册后的 provider.list() 仍返回 1 条', Array.isArray(list) && list.length === 1)
  }

  // 老宿主/精简组合：没有 ctx.inject，但已经有 ctx.skills
  let directProvider = null
  const directCtx = { skills: { registerProvider(factory) { directProvider = factory({}) } }, logger: { warn() {} } }
  let threw2 = null
  try { bs.register(directCtx) } catch (e) { threw2 = e }
  ok('无 ctx.inject 时走 ctx.skills 直挂', threw2 === null && directProvider !== null && directProvider.name === bs.provider, String(threw2))

  // 没有任何 skill 服务：静默跳过，绝不能抛（技能是附加能力）
  let threw3 = null
  try { bs.register({ logger: { warn() {} } }) } catch (e) { threw3 = e }
  ok('宿主没有 skills 服务时不抛', threw3 === null, String(threw3))

  /* ── 6. 真注册表集成（可选：本机装了 DSH 宿主包才跑） ───────────────── */
  section('6. 真 SkillRegistry 集成（找到宿主才跑）')
  // 找到宿主包就**真的**过一遍 dsh-skill 的注册表：候选校验 / rank 合并 / 全文加载。
  // 找不到就明确跳过（不把"本机没装 DSH"当成插件缺陷）。
  function findHostLib(pkg) {
    const candidates = []
    if (pkg === 'dsh-skill' && process.env.DSH_SKILL_LIB) candidates.push(process.env.DSH_SKILL_LIB)
    if (pkg === 'cordis' && process.env.DSH_CORDIS_LIB) candidates.push(process.env.DSH_CORDIS_LIB)
    candidates.push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/' + pkg + '/lib/index.js')
    for (const root of [process.env.DSH_CHECKOUT, path.join(os.homedir(), 'dsh-harness'), path.join(os.homedir(), 'dsh')].filter(Boolean)) {
      candidates.push(path.join(String(root), 'node_modules', '@deepseek-ai', pkg, 'lib', 'index.js'))
    }
    for (const p of candidates) { try { if (p && fs.existsSync(p)) return p } catch (e) {} }
    return null
  }
  const cordisPath = findHostLib('cordis')
  const skillLibPath = findHostLib('dsh-skill')
  if (!cordisPath || !skillLibPath) {
    console.log('  · skip 真注册表集成 — 本机未找到 DSH 宿主包（可用 DSH_CORDIS_LIB / DSH_SKILL_LIB 指定）')
  } else {
    try {
      const { Context } = await import(pathToFileURL(cordisPath).href)
      const host = await import(pathToFileURL(skillLibPath).href)
      const ctx = new Context()
      ctx.plugin(host.SkillRegistry, {})
      const rc = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('skills 服务 5s 内未就绪')), 5000)
        ctx.inject(['skills'], (c) => { clearTimeout(t); resolve(c) })
      })
      ok('宿主 BUNDLED_SKILL_RANK 与本插件常量一致', host.BUNDLED_SKILL_RANK === bs.rank, String(host.BUNDLED_SKILL_RANK) + ' vs ' + String(bs.rank))
      bs.register(rc)
      await new Promise((r) => setTimeout(r, 50))
      const list = await rc.skills.list({ cwd: PKG, signal: new AbortController().signal })
      ok('真注册表 list() 能看到 blender-modeling（带 signal）', list.some((s) => s.name === 'blender-modeling'))
      const got = await rc.skills.get('blender-modeling', { cwd: PKG, signal: new AbortController().signal })
      ok('真注册表 get() 能加载全文（带 signal，含正文标题）', !!got && got.name === 'blender-modeling' && typeof got.content === 'string' && got.content.includes('# Blender 建模流程'))
      // rank 优先级：用户自装副本（rank 400）必须压过 bundled（600）—— 不能"强制更新"老用户
      const userCandidate = {
        name: 'blender-modeling', description: 'user-level copy', invocation: { modelInvocable: true, userInvocable: true },
        source: 'user-dsh', provider: 'fake-user-level', rank: 400, locator: 'x',
      }
      rc.skills.registerProvider(() => ({
        name: 'fake-user-level',
        list: () => [userCandidate],
        get: () => ({ ...userCandidate, content: 'user-level copy' }),
      }))
      const list2 = await rc.skills.list({ cwd: PKG })
      const winner = list2.find((s) => s.name === 'blender-modeling')
      ok('用户级副本（rank 400）覆盖 bundled（600）', !!winner && winner.provider === 'fake-user-level', winner && winner.provider)
    } catch (e) {
      console.log('  · skip 真注册表集成 — ' + String((e && e.message) || e))
    }
  }

  finish()
}

function finish() {
  console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' — ' + pass + ' passed, ' + fail + ' failed' + (fail ? '\n  ' + failures.join('\n  ') : ''))
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('skill_bundle_selftest crashed:', e)
  process.exit(1)
})
