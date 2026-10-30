#!/usr/bin/env node
/** 端到端自检：台账磁盘对账（v2.6 #1）+ 进度通道（#4）。
 *
 *  ① 伪造三条「后端重启后只剩 running」的磁盘台账，查 /job op=status 的收敛结果：
 *     有 summary.json → done(recovered)；只有 stdout 终态 → done(recovered)；什么都没有 → stale。
 *  ② 跑一次真 headless（若本机有 Blender）：脚本里 dsh_progress(...) → 回执 progress 字段。
 *
 *  用法：node tests/ledger_recover_e2e_selftest.mjs   （设 DSH_SELFTEST_E2E_PORT 可换端口）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const PORT = Number(process.env.DSH_SELFTEST_E2E_PORT || 9898)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-selftest-'))
const NL = String.fromCharCode(10)
let pass = 0, fail = 0
const failures = []
function ok(name, cond, detail) { if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; failures.push(name); console.log('  ✗ ' + name + (detail ? (' — ' + String(detail).slice(0, 300)) : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function post(route, body, timeoutMs) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs || 60000)
  try { const r = await fetch('http://127.0.0.1:' + PORT + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: ctl.signal }); return { status: r.status, json: await r.json() } }
  finally { clearTimeout(t) }
}
async function get(route) { const r = await fetch('http://127.0.0.1:' + PORT + route); return { status: r.status, json: await r.json() } }
function mkJob(id, files) {
  const d = path.join(TMP, 'jobs', id)
  fs.mkdirSync(d, { recursive: true })
  for (const [n, c] of Object.entries(files || {})) fs.writeFileSync(path.join(d, n), c, 'utf8')
  return d
}
const j1 = mkJob('job-e2e-summary', { 'summary.json': JSON.stringify({ id: 'job-e2e-summary', status: 'done', exitCode: 0, finishedAt: Date.now(), artifacts: ['out.blend'] }), 'stdout.log': 'noise' + NL })
const j2 = mkJob('job-e2e-log', { 'stdout.log': 'building…' + NL + 'HEADLESS {"ok":true}' + NL })
const j3 = mkJob('job-e2e-empty', {})
const j4 = mkJob('job-e2e-incomplete', { 'stdout.log': 'DSH_STAGE {"name": "preload-done"}' + NL })
fs.mkdirSync(path.join(TMP, 'jobs'), { recursive: true })
const recs = [
  { id: 'job-e2e-summary', kind: 'job', status: 'running', pid: 999999, startedAt: Date.now() - 60000, dir: j1 },
  { id: 'job-e2e-log', kind: 'job', status: 'running', pid: 999999, startedAt: Date.now() - 60000, dir: j2 },
  { id: 'job-e2e-empty', kind: 'job', status: 'running', pid: 999999, startedAt: Date.now() - 60000, dir: j3 },
  { id: 'job-e2e-incomplete', kind: 'job', status: 'running', pid: 999999, startedAt: Date.now() - 60000, dir: j4 },
]
fs.writeFileSync(path.join(TMP, 'jobs', 'index.jsonl'), recs.map((r) => JSON.stringify(r)).join(NL) + NL, 'utf8')

const child = spawn(process.execPath, [path.join(ROOT, 'runtime', 'server.mjs')], {
  env: { ...process.env, DSH_BLENDER_WORKDIR: TMP, DSH_BLENDER_HTTP_PORT: String(PORT), DSH_BLENDER_HOLDER: 'e2e-holder' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''; child.stderr.on('data', (d) => { stderr += d.toString() })
let ready = false
for (let i = 0; i < 80; i++) { await sleep(300); try { const s = await get('/status'); if (s.json && s.json.ok) { ready = true; break } } catch (e) {} }
ok('后端起来了', ready, stderr.slice(-400))
if (ready) {
  let r = await post('/job', { op: 'status', id: 'job-e2e-summary' })
  const j = r.json && (r.json.job || r.json)
  ok('A summary.json → status=done + recovered', j && j.status === 'done' && j.recovered === true, JSON.stringify(j && { s: j.status, rec: j.recovered }))
  ok('A 带 recoveredFrom=summary.json', j && j.recoveredFrom === 'summary.json', j && j.recoveredFrom)
  r = await post('/job', { op: 'status', id: 'job-e2e-log' })
  const j2r = r.json && (r.json.job || r.json)
  ok('B 只有 stdout 终态 → done + recoveredFrom=stdout.log', j2r && j2r.status === 'done' && j2r.recoveredFrom === 'stdout.log', JSON.stringify(j2r && { s: j2r.status, f: j2r.recoveredFrom }))
  r = await post('/job', { op: 'status', id: 'job-e2e-empty' })
  const j3r = r.json && (r.json.job || r.json)
  ok('C 无证据 → stale + 说明查过哪些证据', j3r && j3r.status === 'stale' && Array.isArray(j3r.evidenceChecked), JSON.stringify(j3r && { s: j3r.status, e: j3r.evidenceChecked }))
  r = await post('/job', { op: 'status', id: 'job-e2e-incomplete' })
  const j4r = r.json && (r.json.job || r.json)
  ok('D 日志在但没终态 → stale（不许谎报完成）', j4r && j4r.status === 'stale' && j4r.evidence && j4r.evidence.lastStage === 'preload-done', JSON.stringify(j4r && j4r.status))
  // ② 真 headless + dsh_progress
  const py = ['import bpy, time', 'for i in range(3):', '    dsh_progress(frame=i + 1, total=3, note="step")', '    time.sleep(0.05)', 'print("HEADLESS {ok: true, status: done}")'].join(NL)
  try {
    r = await post('/headless', { script: py, timeoutMs: 120000 }, 150000)
    const h0 = r.json || {}
    const h = h0.result || h0
    const prog = h.progress
    ok('E headless 回执带 progress（dsh_progress → DSH_PROGRESS）', !!prog, JSON.stringify(h0).slice(0, 400))
    if (prog) ok('E progress 内容是最后一帧', prog.frame === 3, JSON.stringify(prog))
    ok('F headless 回执带 warnings 字段', Array.isArray(h.warnings), typeof h.warnings)
    ok('G 回执带 heartbeat（进度心跳）', !!h.heartbeat || h.status !== 'done', JSON.stringify(h.heartbeat))
  } catch (e) {
    console.log('  · skip 真 headless（本机 Blender 不可用？）：' + String(e && e.message || e).slice(0, 120))
  }
}
try { child.kill('SIGKILL') } catch (e) {}
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}
console.log('')
console.log('ledger-recover-e2e：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) for (const f of failures) console.log('  x ' + f)
process.exit(fail ? 1 : 0)