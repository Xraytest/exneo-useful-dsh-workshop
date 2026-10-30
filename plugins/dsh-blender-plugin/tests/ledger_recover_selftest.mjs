#!/usr/bin/env node
/**
 * tests/ledger_recover_selftest.mjs —— v2.6 · 反馈 #1「台账以文件为准」
 *
 * 现场（两次，各赔一轮往返）：后端重启后，磁盘台账里只剩一条 status=running、pid 已不存在，
 * 但**子进程其实已经跑完、产物与日志都在**；旧逻辑一律判 stale，调用方只能自己去
 * Get-Process + ls 破案。本测试钉住新语义：
 *
 *   A summary.json 在            → status=done, recovered=true, recoveredFrom=summary.json
 *   B resultPath 在              → status=done, recovered=true, recoveredFrom=resultPath
 *   C stdout 有 DSH_STAGE done   → status=done, recovered=true, recoveredFrom=stdout.log
 *   D stdout 有 HEADLESS {...}   → status=done（headless 同步执行的终态回执）
 *   E stdout 只有 Traceback      → status=failed（判失败，不是完成）
 *   F 日志在但没终态            → status=stale + evidence.lastStage（不许谎报完成）
 *   G 什么证据都没有            → status=stale + evidenceChecked
 *   H pid 还活着                 → 原样返回（不许抢活着的任务）
 *   I 大日志（>256KB，done 在尾部）→ 只读尾部也能判完成
 *   J job 目录形态（dir + stdout.log）→ 走 job 分支也能判完成
 *   K failed 的 summary.json     → status=failed（不把失败判成完成）
 *
 * 用法：node tests/ledger_recover_selftest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const mod = await import(pathToFileURL(path.join(ROOT, 'runtime', 'recover.mjs')).href)
const { reconcileLedger, recoverFromDisk, logEvidence } = mod

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recover-'))
let pass = 0, fail = 0
const failures = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? (' — ' + detail) : '')) }
}
const NL = String.fromCharCode(10)
const map = { winToWsl: (p) => p, wslToWin: (p) => p }   // 测试用恒等映射（真实后端注入 config.mjs 的实现）
const mk = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d }
const write = (p, s) => fs.writeFileSync(p, s, 'utf8')
const rec = (extra) => Object.assign({ id: 'job-x', kind: 'job', status: 'running', pid: 999999, startedAt: Date.now() - 60000 }, extra)

// ---------- A: summary.json ----------
{
  const d = mk('A')
  write(path.join(d, 'summary.json'), JSON.stringify({ id: 'job-x', status: 'done', exitCode: 0, finishedAt: 123, artifacts: ['a.blend'] }))
  const r = reconcileLedger(rec({ dir: d }), map, () => false)
  ok('A summary.json → done + recovered', r.status === 'done' && r.recovered === true && r.recoveredFrom === 'summary.json', JSON.stringify(r.status))
  ok('A 保留证据路径', !!(r.recoveredEvidence && r.recoveredEvidence.path))
  ok('A 结果可读（artifacts 透传）', Array.isArray(r.artifacts) && r.artifacts[0] === 'a.blend')
}
// ---------- A2: failed 的 summary ----------
{
  const d = mk('A2')
  write(path.join(d, 'summary.json'), JSON.stringify({ id: 'job-x', status: 'failed', exitCode: 1, finishedAt: 124 }))
  const r = reconcileLedger(rec({ dir: d }), map, () => false)
  ok('A2 summary failed → failed（不判成完成）', r.status === 'failed' && r.recovered === true)
}

// ---------- B: resultPath ----------
{
  const d = mk('B')
  const rp = path.join(d, 'result.json')
  write(rp, '{"ok":true}')
  const r = reconcileLedger(rec({ resultPath: rp }), map, () => false)
  ok('B resultPath → done + recovered', r.status === 'done' && r.recoveredFrom === 'resultPath')
}

// ---------- C: stdout 有 done ----------
{
  const d = mk('C')
  const so = path.join(d, 'stdout.log')
  write(so, ['DSH_STAGE {"name": "boot", "run": "run-x"}', 'DSH_STAGE {"name": "done", "run": "run-x"}', ''].join(NL))
  const r = reconcileLedger(rec({ stdoutLog: so }), map, () => false)
  ok('C stdout done → done + recovered', r.status === 'done' && r.recoveredFrom === 'stdout.log')
  ok('C stage 取日志里的最后一条', r.stage === 'done', String(r.stage))
}

// ---------- D: HEADLESS 终态 ----------
{
  const d = mk('D')
  const so = path.join(d, 'stdout.log')
  write(so, ['noise', 'HEADLESS {"ok": true, "status": "done"}', ''].join(NL))
  const r = reconcileLedger(rec({ stdoutLog: so }), map, () => false)
  ok('D HEADLESS → done', r.status === 'done' && r.recovered === true)
}

// ---------- E: Traceback ----------
{
  const d = mk('E')
  const so = path.join(d, 'stdout.log')
  write(so, ['Traceback (most recent call last):', '  File "x.py", line 1', 'TypeError: boom', ''].join(NL))
  const r = reconcileLedger(rec({ stdoutLog: so }), map, () => false)
  ok('E Traceback → failed', r.status === 'failed' && r.recovered === true)
}

// ---------- F: 日志在但没终态 ----------
{
  const d = mk('F')
  const so = path.join(d, 'stdout.log')
  write(so, ['DSH_STAGE {"name": "boot", "run": "run-x"}', 'DSH_STAGE {"name": "preload-done"}', 'building geometry…', ''].join(NL))
  const r = reconcileLedger(rec({ stdoutLog: so }), map, () => false)
  ok('F 没有终态 → stale（不许判完成）', r.status === 'stale' && r.recovered !== true)
  ok('F 附上证据（lastStage）', r.evidence && r.evidence.lastStage === 'preload-done', JSON.stringify(r.evidence && r.evidence.lastStage))
}

// ---------- G: 无证据 ----------
{
  const d = mk('G')
  const r = reconcileLedger(rec({ dir: d }), map, () => false)
  ok('G 无证据 → stale', r.status === 'stale')
  ok('G 说明查过哪些证据', Array.isArray(r.evidenceChecked) && r.evidenceChecked.join(',') === 'summary.json,resultPath,stdout.log')
}

// ---------- H: pid 活着 ----------
{
  const r = reconcileLedger(rec({ dir: mk('H') }), map, () => true)
  ok('H pid 活着 → 原样返回（不抢）', r.status === 'running' && !r.recovered)
}

// ---------- I: 大日志尾部 ----------
{
  const d = mk('I')
  const so = path.join(d, 'stdout.log')
  const pad = 'x'.repeat(300 * 1024)
  write(so, pad + NL + 'DSH_STAGE {"name": "done"}' + NL)
  const ev = logEvidence(so)
  const r = reconcileLedger(rec({ stdoutLog: so }), map, () => false)
  ok('I 大日志只读尾部也认终态', ev.exists && ev.sawDone && r.status === 'done')
  ok('I 证据里带字节数', ev.bytes > 300 * 1024)
}

// ---------- J: job 目录形态 ----------
{
  const d = mk('J')
  write(path.join(d, 'stdout.log'), 'HEADLESS {"ok":true}' + NL)
  const r = recoverFromDisk(rec({ dir: d }), map)
  ok('J job 目录（dir + stdout.log）也能对账', r.found && r.status === 'done' && r.source === 'stdout.log')
}

// ---------- K: 非 running 不碰 ----------
{
  const r = reconcileLedger({ id: 'x', status: 'done' }, map, () => false)
  ok('K 终态记录原样返回', r.status === 'done' && !r.recovered)
}

console.log('')
console.log('ledger-recover-selftest：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) for (const f of failures) console.log('  x ' + f)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}
process.exit(fail ? 1 : 0)
