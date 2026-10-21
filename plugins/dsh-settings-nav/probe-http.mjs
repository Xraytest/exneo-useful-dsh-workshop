/**
 * dsh-settings-nav host 半边的**真实走线**探针（与 selftest.mjs 互补）。
 *
 * selftest.mjs 用假的 req/res 桩把守卫的每个分支都点过一遍，但它伪造了头——而 4.4 那个
 * 漏洞恰恰是「头本身不可信」。这里把 index.js 挂到一个**临时端口**上，用真正的
 * `http.request` 发请求，所以验的是端到端的事实，且**完全不碰正在跑的 dsh**：
 * 挂临时端口 → 临时目录里的布局文件 → 跑完就删。
 *
 * 覆盖：
 *   · DNS rebinding（Host 与 Origin 都是攻击者域名）→ 403（修复前会放行到 409）；
 *   · 可信 authority 的各种写法（localhost / 127.0.0.1 / dsh.local / 私网字面量）；
 *   · Origin: null、scheme 与实际传输不符、端口不符、没有 Host、sec-fetch-site: cross-site；
 *   · 不可读冻结：exists:true + unreadable:true + /save 与 /reset 都 503 且盘上内容不变；
 *   · body 上限 413、声明了 body 却不发 → 408（真实超时，会真的等 4.6 那段 15 秒）。
 *
 * 前置条件：`chmod 000` 必须真能挡住读（**别用 root 跑**，否则 B 段的前提断言会失败，
 * 那是在提醒你现在验的东西没意义，不是在报插件的问题）。
 *
 * 运行：node plugins/dsh-settings-nav/probe-http.mjs
 */
import { createServer, request as httpRequest } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const plugin = await import(new URL('./index.js', import.meta.url).href);

function boot(file) {
  const routes = new Map();
  const webServer = {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  const ctx = {
    get: (key) => (key === 'webServer' ? webServer : undefined),
    effect: (fn) => fn(),
    logger: { warn() {}, info() {}, error() {} },
  };
  plugin.apply(ctx, { file });
  const server = createServer(async (req, res) => {
    const route = routes.get(new URL(req.url, 'http://x').pathname);
    if (route === undefined) {
      res.statusCode = 404;
      res.end('no route');
      return;
    }
    await route.handler(req, res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function call(port, method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, setHost: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body === null ? undefined : body);
  });
}

let fail = 0;
const check = (label, actual, expected) => {
  const good = actual === expected;
  if (!good) fail += 1;
  console.log(`${good ? '  ok  ' : ' FAIL '} ${label} → ${actual}${good ? '' : `（期望 ${expected}）`}`);
};

const dir = mkdtempSync(join(tmpdir(), 'dsn-probe-'));
const file = join(dir, 'settings-nav.json');
try {
  // ── A. 同源守卫
  writeFileSync(file, JSON.stringify({ schema: 1, revision: 4, order: [{ type: 'item', id: 'general' }] }));
  const { server, port } = await boot(file);
  const authority = `127.0.0.1:${port}`;
  console.log(`\n[A] 同源守卫（真实 HTTP，authority=${authority}）`);

  const post = (headers, payload) => call(port, 'POST', '/dsh-settings-nav/save', {
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

  // 旧守卫会被这几个头骗过：Host 与 Origin 都是攻击者域名，二者相等。
  check('Host=Origin=evil.example（DNS rebinding）', (await post({ host: 'evil.example', origin: 'http://evil.example' }, { baseRevision: 4, order: [] })).status, 403);
  check('Host 可信 + Origin 是外部域名', (await post({ host: authority, origin: 'http://evil.example' }, { baseRevision: 4, order: [] })).status, 403);
  check('Host 可信 + 无 Origin（curl）', (await post({ host: authority }, { baseRevision: 4, order: [] })).status, 200);
  check('Host 可信 + Origin 同 authority', (await post({ host: authority, origin: `http://${authority}` }, { baseRevision: 5, order: [] })).status, 200);
  // 上面那次写把 revision 推到 6；下面的用例用活 revision，避免把 409 误读成守卫拦截。
  check('sec-fetch-site: cross-site', (await post({ host: authority, origin: `http://${authority}`, 'sec-fetch-site': 'cross-site' }, { baseRevision: 6, order: [] })).status, 403);
  check('Origin: null', (await post({ host: authority, origin: 'null' }, { baseRevision: 7, order: [] })).status, 403);
  check('Host 带尾巴端口 ≠ Origin 端口', (await post({ host: authority, origin: 'http://127.0.0.1:1' }, { baseRevision: 7, order: [] })).status, 403);
  // 这两条只关心「守卫有没有放行」：409 = 放行了但 revision 过期，403 = 被守卫挡住。
  const liveRev = async () => JSON.parse((await call(port, 'GET', '/dsh-settings-nav/state', { headers: { host: authority } })).text).revision;
  check('Host=私网字面量 + Origin 配套（LAN 直连，非 403 即放行）', [403].includes((await post({ host: '192.168.1.50:3088', origin: 'http://192.168.1.50:3088' }, { baseRevision: await liveRev(), order: [] })).status), false);
  check('Host=dsh.local + Origin 配套（非 403 即放行）', [403].includes((await post({ host: 'dsh.local:3080', origin: 'http://dsh.local:3080' }, { baseRevision: await liveRev(), order: [] })).status), false);
  check('可信 host 但 https scheme（scheme 不含在 authority 里）', (await post({ host: authority, origin: `https://${authority}` }, { baseRevision: 10, order: [] })).status, 403);
  check('没有 Host 头（畸形请求）', (await post({ host: '', origin: `http://${authority}` }, { baseRevision: 11, order: [] })).status, 403);
  check('GET /state 正常', (await call(port, 'GET', '/dsh-settings-nav/state', { headers: { host: authority } })).status, 200);
  check('HEAD /state', (await call(port, 'HEAD', '/dsh-settings-nav/state', { headers: { host: authority } })).status, 200);
  check('已知路径上的 PUT → 405', (await call(port, 'PUT', '/dsh-settings-nav/save', { headers: { host: authority, 'content-length': '0' } })).status, 405);
  check('未知路径 → 404（没注册）', (await call(port, 'GET', '/dsh-settings-nav/nope', { headers: { host: authority } })).status, 404);
  check('坏 JSON', (await post({ host: authority }, 'not json')).status, 400);

  await new Promise((r) => server.close(r));

  // ── B. 不可读冻结
  console.log('\n[B] 存在但读不动');
  writeFileSync(file, JSON.stringify({ schema: 1, revision: 4, order: [{ type: 'item', id: 'general' }] }));
  chmodSync(file, 0o000);
  let blocked = false;
  try {
    readFileSync(file, 'utf8');
  } catch (error) {
    blocked = error.code === 'EACCES';
  }
  check('探针前置条件：chmod 000 真的挡住了读', blocked, true);
  const b = await boot(file);
  const stateRes = await call(b.port, 'GET', '/dsh-settings-nav/state', { headers: { host: `127.0.0.1:${b.port}` } });
  const state = JSON.parse(stateRes.text);
  console.log('  · /state 在不可读时返回:', JSON.stringify({ exists: state.exists, unreadable: state.unreadable, revision: state.revision, warnings: (state.warnings || []).slice(0, 2) }));
  check('/state exists', state.exists, true);
  check('/state unreadable', state.unreadable, true);
  check('/state warnings 有话说', Array.isArray(state.warnings) && state.warnings.length > 0, true);
  check('POST /save 被拒（503，不是 409）', (await call(b.port, 'POST', '/dsh-settings-nav/save', {
    headers: { host: `127.0.0.1:${b.port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: 0, order: [] }),
  })).status, 503);
  check('POST /reset 被拒（503）', (await call(b.port, 'POST', '/dsh-settings-nav/reset', {
    headers: { host: `127.0.0.1:${b.port}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })).status, 503);
  chmodSync(file, 0o600);
  check('盘上内容一字未改', readFileSync(file, 'utf8').includes('"revision":4'), true);
  await new Promise((r) => b.server.close(r));

  // ── C. body 边界（真实走线）
  console.log('\n[C] body 边界');
  const c = await boot(file);
  const cAuth = `127.0.0.1:${c.port}`;
  const big = await call(c.port, 'POST', '/dsh-settings-nav/save', {
    headers: { host: cAuth, 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: 4, order: [], pad: 'x'.repeat(300 * 1024) }),
  });
  check('超过 256 KiB → 413', big.status, 413);
  // 声明 100 字节却只发 1 个字节、并且不 end()：真实走线下应当由 readBody 自己在 15s 兜住。
  const started = Date.now();
  let socketClosedAt = null;
  const hung = await new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: c.port, method: 'POST', path: '/dsh-settings-nav/save', headers: { host: cAuth, 'content-type': 'application/json', 'content-length': '100' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.setTimeout(30000, () => req.destroy(new Error('probe 自己超时')));
    req.on('close', () => {
      if (socketClosedAt === null) socketClosedAt = Date.now();
    });
    req.on('error', (error) => resolve({ status: 0, text: error.message }));
    req.write('{');
    // 刻意不 end()
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log('  · 客户端实际看到:', JSON.stringify(hung).slice(0, 200));
  check(`声明了 body 却不发 → 408（${seconds}s 后）`, hung.status, 408);
  check('408 说明里讲清是超时', /超时|timeout/i.test(hung.text), true);
  // 「拆连接」这件事也要验：客户端不发了，服务端不能在 408 之后再挂 300s。
  const closeDeadline = Date.now() + 3000;
  while (socketClosedAt === null && Date.now() < closeDeadline) {
    await new Promise((done) => setTimeout(done, 50));
  }
  check('408 之后连接被关掉（不挂到 Node 默认 300s）', socketClosedAt !== null, true);
  check('关闭发生在响应之后（不是把响应一起重置）', socketClosedAt === null ? false : socketClosedAt >= started + 14000, true);
  await new Promise((r) => c.server.close(r));
} finally {
  try {
    chmodSync(file, 0o600);
  } catch (error) {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail === 0 ? '\n探针全过' : `\n探针有 ${fail} 条失败`);
process.exit(fail === 0 ? 0 : 1);
