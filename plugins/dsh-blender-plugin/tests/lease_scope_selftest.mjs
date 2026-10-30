#!/usr/bin/env node
/** 集成自检：后端 /lease 的写作用域（v2.6 反馈 #7）+ 台账恢复（#1）的端到端形态。
 *  用独立 workDir + 独立端口起一个后端，不起 Blender（只测 HTTP 契约）。
 *  用法：node tests/lease_scope_selftest.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const PORT = Number(process.env.DSH_SELFTEST_SCOPE_PORT || 9897)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scope-selftest-'))
let pass = 0, fail = 0
const failures = []
function ok(name, cond, detail) { if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; failures.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function post(route, body) {
  const r = await fetch('http://127.0.0.1:' + PORT + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  return { status: r.status, json: await r.json() }
}
async function get(route) { const r = await fetch('http://127.0.0.1:' + PORT + route); return { status: r.status, json: await r.json() } }
const child = spawn(process.execPath, [path.join(ROOT, 'runtime', 'server.mjs')], {
  env: { ...process.env, DSH_BLENDER_WORKDIR: TMP, DSH_BLENDER_HTTP_PORT: String(PORT), DSH_BLENDER_HOLDER: 'selftest-holder' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (d) => { stderr += d.toString() })
let ready = false
for (let i = 0; i < 60; i++) {
  await sleep(300)
  try { const s = await get('/status'); if (s.json && s.json.ok) { ready = true; break } } catch (e) {}
}
ok('后端起来了（独立 workDir/端口）', ready, stderr.slice(-300))
if (ready) {
  // A: 不带 scope
  let r = await post('/lease', { holder: 'scope-A', ttlMs: 60000 })
  ok('A lease 成功且 scope=null（未声明 = 不限制）', r.json.ok === true && (r.json.lease.scope === null), JSON.stringify(r.json.lease && r.json.lease.scope))
  // B: 声明两维 scope
  r = await post('/lease', { holder: 'scope-A', ttlMs: 60000, scope: 'collection:COL_Lights, prefix:LGT-' })
  const sc = r.json.lease && r.json.lease.scope
  ok('B scope 规范化成两维', Array.isArray(sc) && sc.length === 2 && sc[0].kind === 'collection' && sc[0].value === 'COL_Lights' && sc[1].kind === 'prefix' && sc[1].value === 'LGT-', JSON.stringify(sc))
  // C: /who 能看到 scope
  r = await get('/who')
  ok('C /who 回 scope', !!(r.json.lease && r.json.lease.scope && r.json.lease.scope.length === 2))
  // D: 别的 holder 被挡，且 409 里带 holderScope
  r = await post('/lease', { holder: 'scope-B' })
  ok('D 别人拿租约 → 409 + holderScope', r.status === 409 && r.json.error === 'leased' && Array.isArray(r.json.holderScope), JSON.stringify(r.json.holderScope))
  // E: 裸 token 推断维度（COL_ → collection，带 -* → prefix）
  r = await post('/lease', { holder: 'scope-B', force: true, scope: 'COL_VFX,GEO-GZ-*' })
  const sc2 = r.json.lease && r.json.lease.scope
  ok('E 裸 token 也能推断维度', Array.isArray(sc2) && sc2[0].kind === 'collection' && sc2[0].value === 'COL_VFX' && sc2[1].kind === 'prefix' && sc2[1].value === 'GEO-GZ-', JSON.stringify(sc2))
  await post('/release', { holder: 'scope-B' })
}
// Windows/Node 24 上 child.kill('SIGKILL') 后立刻 process.exit 会在 libuv 关闭 async 句柄时
// 触发 Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)（exit 127）。先等子进程退出，
// 再销毁管道，最后用 exitCode 让事件循环自然收尾；不要 process.exit() 抢跑。
async function stopChild() {
  if (child.exitCode !== null) return
  const exited = new Promise((resolve) => {
    const done = () => resolve()
    child.once('exit', done)
    child.once('close', done)
    setTimeout(done, 3000)
  })
  try { child.kill('SIGTERM') } catch (e) {}
  await exited
  if (child.exitCode === null) {
    try { child.kill('SIGKILL') } catch (e) {}
    await new Promise((r) => setTimeout(r, 100))
  }
}
await stopChild()
try { child.stdout && child.stdout.destroy() } catch (e) {}
try { child.stderr && child.stderr.destroy() } catch (e) {}
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}
console.log('')
console.log('lease-scope-selftest：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) for (const f of failures) console.log('  x ' + f)
process.exitCode = fail ? 1 : 0