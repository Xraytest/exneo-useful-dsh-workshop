#!/usr/bin/env node
/**
 * tests/host_routes_selftest.mjs —— 后端 `/host/*` 真 HTTP 自检（v2.3 精简版）
 *
 * v2.3 起 DSH 侧视口面板 / 点选 / TUI 面板全部删除，`/host/*` 只剩：
 *   · `GET  /host/scene-items`（`@` 提及数据源，需 Blender）
 *   · `GET  /host/jobs`、`GET /host/jobs/log`（只读台账）
 *   · `POST /host/selection` · `GET /host/selection/latest` · `POST /host/selection/consume`
 *     （Blender 原生选中 → DSH 草稿，纯内存、零 Blender 往返）
 *
 * 本测试同时钉住"已删除的旧路由确实 404"（防止有人把面板/点选代码又加回来）。
 *
 * 用法：node tests/host_routes_selftest.mjs [--server /path/to/runtime/server.mjs]
 *   - 后端不可达 → SKIP 且 exit 0（先 blender_viewport(op="start")）
 *   - `--server` 会起一个隔离后端（随机端口），测试结束自动杀；不给则打 DSH_BLENDER_BACKEND / 127.0.0.1:9877
 * 退出码：0 = 通过或 SKIP；1 = 有断言失败。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const argServer = process.argv.indexOf('--server');
const SERVER = argServer >= 0 ? process.argv[argServer + 1] : path.join(ROOT, 'runtime', 'server.mjs');
const USE_ISOLATED = argServer >= 0;
const LOOPBACK = 'http://127.0.0.1:3080';
const EVIL = 'http://evil.example';

let BASE = String(process.env.DSH_BLENDER_BACKEND || 'http://127.0.0.1:9877').replace(/\/+$/, '');
let child = null;

function req(method, p, opts = {}) {
  const url = new URL(p, BASE);
  const body = opts.json === undefined ? null : JSON.stringify(opts.json);
  return new Promise((resolve) => {
    const r = http.request(url, {
      method: method,
      headers: Object.assign({}, opts.headers || {}, body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      timeout: opts.timeout || 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { json = null; }
        resolve({ ok: true, status: res.statusCode, headers: res.headers, buf: buf, json: json });
      });
    });
    r.on('timeout', () => { try { r.destroy(); } catch (e) {} resolve({ ok: false, err: 'timeout' }); });
    r.on('error', (e) => resolve({ ok: false, err: String(e && e.message || e) }));
    if (body) r.write(body);
    r.end();
  });
}

let pass = 0; let fail = 0; const fails = [];
function ok(name, cond, extra) { if (cond) pass++; else { fail++; fails.push(name + (extra === undefined ? '' : ' — ' + JSON.stringify(extra))); } }
function skip(name, why) { console.log('  SKIP ' + name + '：' + why); }

async function waitHealth(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await req('GET', '/health', { timeout: 1000 });
    if (r.ok) return true;
    await new Promise((res) => setTimeout(res, 150));
  }
  return false;
}

// ── 0) 起隔离后端（可选）─────────────────────────────────────────────────────
if (USE_ISOLATED) {
  const port = 19000 + Math.floor(Math.random() * 1000);
  try {
    child = spawn(process.execPath, [SERVER, '--port', String(port)], { stdio: 'ignore', env: Object.assign({}, process.env) });
  } catch (e) { child = null; }
  BASE = 'http://127.0.0.1:' + String(port);
}

console.log('宿主 /host 路由自检 —— 目标 ' + BASE + (USE_ISOLATED ? '（隔离后端）' : ''));
if (!(await waitHealth(USE_ISOLATED ? 15000 : 3000))) {
  console.log('SKIP: 后端不可达（' + BASE + '）—— 先 blender_viewport(op="start") 再重跑本自检');
  if (child) { try { child.kill(); } catch (e) {} }
  process.exit(0);
}

// ── 1) 已删除的旧路由必须 404（防止回潮）────────────────────────────────────
for (const gone of ['/host/view/latest', '/host/view.png', '/host/view/capture', '/host/view/pick',
  '/host/pick/request', '/host/pick/result', '/host/ready']) {
  const r = await req('GET', gone);
  ok('旧路由已删除 ' + gone + ' → 404', r.ok && r.status === 404, r.ok ? r.status : r.err);
}

// ── 2) CORS：只对 loopback / dsh-app://app 回显 ─────────────────────────────
{
  const pre = await req('OPTIONS', '/host/selection/latest', { headers: { Origin: LOOPBACK } });
  ok('OPTIONS 预检 → 204 空体', pre.ok && pre.status === 204 && pre.buf.length === 0, pre.ok ? pre.status : pre.err);
  ok('ACAO 回显 loopback Origin', pre.headers['access-control-allow-origin'] === LOOPBACK, pre.headers['access-control-allow-origin']);
  ok('allow-methods 含 GET/POST/OPTIONS', String(pre.headers['access-control-allow-methods'] || '') === 'GET,POST,OPTIONS', pre.headers['access-control-allow-methods']);
  const evil = await req('OPTIONS', '/host/selection/latest', { headers: { Origin: EVIL } });
  ok('非 loopback Origin 不回显 ACAO', evil.headers['access-control-allow-origin'] === undefined, evil.headers['access-control-allow-origin']);
  const app = await req('GET', '/host/selection/latest', { headers: { Origin: 'dsh-app://app' } });
  ok('dsh-app://app 回显 ACAO', app.headers['access-control-allow-origin'] === 'dsh-app://app', app.headers['access-control-allow-origin']);
}

// ── 3) 原生选中 → DSH（S1–S3）────────────────────────────────────────────────
{
  const marker = 'SELFTEST-' + Date.now().toString(36);
  const post = await req('POST', '/host/selection', {
    headers: { Origin: LOOPBACK },
    json: {
      v: 1, source: 'host-routes-selftest', sent_at: Date.now(),
      selection: {
        kind: 'objects', count: 2, names: [marker + '-Cube', marker + '-Camera'], truncated: false,
        active: marker + '-Cube', mode: 'OBJECT', collections: [{ name: 'SELFTEST-COL', count: 2 }],
        objects: [{ name: marker + '-Cube', type: 'MESH', dimensions_mm: [100, 100, 100] }],
      },
      scene: { name: 'SELFTEST-SCENE', file: 'selftest.blend' },
      activity: { state: 'human', human_active: true, agent_active: false },
    },
  });
  const pj = post.json;
  ok('POST /host/selection → 200 + ok + seq', post.ok && post.status === 200 && pj && pj.ok === true && Number.isInteger(pj.seq), { status: post.status, body: pj });
  const seq = pj && pj.seq;
  const latest = await req('GET', '/host/selection/latest', { headers: { Origin: LOOPBACK } });
  const lj = latest.json;
  ok('GET latest → unconsumed=true 且带对象名',
    latest.ok && lj && lj.ok === true && lj.unconsumed === true && lj.selection
    && Array.isArray(lj.selection.names) && lj.selection.names.indexOf(marker + '-Cube') >= 0, lj);
  ok('latest 带 collections 摘要 / activity / scene',
    lj && lj.selection && Array.isArray(lj.selection.collections) && lj.selection.collections[0].name === 'SELFTEST-COL'
    && lj.activity && lj.activity.state === 'human' && lj.scene && lj.scene.name === 'SELFTEST-SCENE', lj);
  const consume = await req('POST', '/host/selection/consume', { headers: { Origin: LOOPBACK }, json: { seq: seq, ok: true, how: 'actions' } });
  ok('consume → 200 + consumed_seq=seq', consume.ok && consume.json && consume.json.ok === true && consume.json.consumed_seq === seq, consume.json);
  const latest2 = await req('GET', '/host/selection/latest');
  ok('消费后 unconsumed=false / selection=null', latest2.json && latest2.json.unconsumed === false && latest2.json.selection === null, latest2.json);
  ok('last_consume 记录插入结果', latest2.json && latest2.json.last_consume && latest2.json.last_consume.ok === true && latest2.json.last_consume.how === 'actions', latest2.json && latest2.json.last_consume);
  const bad = await req('POST', '/host/selection/consume', { json: { seq: 0 } });
  ok('非法 consume(0) → 400', bad.ok && bad.status === 400, { status: bad.status, body: bad.json });
  const badPut = await req('POST', '/host/selection', { json: null });
  ok('非对象 payload → 400', badPut.ok && badPut.status === 400, { status: badPut.status, body: badPut.json });
}

// ── 4) 只读路由仍可用 ────────────────────────────────────────────────────────
{
  const jobs = await req('GET', '/host/jobs?limit=5');
  ok('GET /host/jobs → 200 ok:true', jobs.ok && jobs.status === 200 && jobs.json && jobs.json.ok === true, jobs.json);
  const doctor = await req('GET', '/doctor', { timeout: 15000 });
  const kind = doctor.json && (doctor.json.kind || (doctor.json.addon && doctor.json.addon.kind));
  if (kind === 'ok') {
    const items = await req('GET', '/host/scene-items?q=Cu&limit=5');
    ok('GET /host/scene-items → objects 数组（@ 提及）',
      items.ok && items.json && items.json.ok === true && Array.isArray(items.json.objects), items.json);
  } else {
    skip('scene-items', 'Blender 不可达（doctor.kind=' + JSON.stringify(kind) + '）');
  }
}

for (const f of fails) console.log('  ✗ ' + f);
console.log('\n/host 路由自检：' + pass + ' 通过 / ' + fail + ' 失败');
if (child) { try { child.kill(); } catch (e) {} }
process.exit(fail === 0 ? 0 : 1);
