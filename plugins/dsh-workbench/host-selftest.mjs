
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-test-'));
const stateFile = join(dir, 'workbench.json');
const reaFile = join(dir, 'rea-mcp', 'tools.json');

// REA 的 v2 状态夹具：本插件只读它，写它必须在测试里模拟（真实写者是 rea-mcp）。
// 初值 master=false，这样「勾上 REA」才会真的产生一次驱动调用。
const writeRea = (master, sessions = {}) => {
  mkdirSync(join(dir, 'rea-mcp'), { recursive: true });
  writeFileSync(reaFile, JSON.stringify({
    version: 2,
    defaults: { masterEnabled: master, mode: 'all', enabled: [], updatedAt: null },
    sessions,
    updatedAt: null,
  }), 'utf8');
};
writeRea(false);

// capture exported internals via a hacked import: we re-run the module with its route registry faked.
const mod = await import('./index.js?v=wb-test-1').catch(() => null);
if (mod === null) { console.log('IMPORT_FAIL'); process.exit(1); }

// Build a fake ctx
const routes = new Map();
const waterfallHandlers = [];
const ctx = {
  logger: { info(){}, warn(){} },
  effect(fn, label) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  on(name, handler) { if (name === 'system-prompt/assemble') waterfallHandlers.push(handler); },
  get(key) {
    if (key === 'sessions') return { get(id){ return sessionsById.get(id); } };
    if (key === 'webServer') return { port: 3999 };
    return undefined;
  },
  webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
};
const sessionsById = new Map();

// Fake the ultracode & rea routes on our fake webserver via fetch interception
const ultraCalls = [];
const reaCalls = [];
const orchCalls = [];
const adminCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).includes('/dsh-ultracode/')) {
    ultraCalls.push({ url: String(url), options });
    return { ok: true, json: async () => ({ active: true, available: true, requested: true, persisted: true, family: 'fam-1', familyRoot: true, branches: 0 }) };
  }
  if (String(url).includes('/dsh-rea-mcp/')) {
    reaCalls.push({ url: String(url), options });
    // 忠实模拟 rea-mcp：/workbench 只翻转本会话语义下的 masterEnabled，/reset 清覆盖。
    if (String(url).includes('/workbench')) {
      writeRea(JSON.parse(options.body).on === true);
      return { ok: true, json: async () => ({ ok: true, saved: true }) };
    }
    if (String(url).includes('/reset')) {
      writeRea(false);
      return { ok: true, json: async () => ({ ok: true, cleared: 'sessions[root-1]' }) };
    }
    return { ok: true, json: async () => ({ ok: true, stats: { enabled: 28, total: 207 }, state: { masterEnabled: true } }) };
  }
  if (String(url).includes('/dsh-admin-channel/')) {
    adminCalls.push({ url: String(url), options });
    const wanted = options?.body === undefined ? undefined : JSON.parse(options.body).enabled;
    const phase = wanted === false ? 'off' : 'running';
    return {
      ok: true,
      json: async () => ({
        sessionId: 'SID',
        phase,
        running: phase === 'running',
        armed: false,
        elevated: true,
        brokerPid: 4321,
        note: phase === 'running' ? '已开启：通道运行中（PID 4321）。' : '未开启：在「工作箱」打开开关。',
        hint: phase === 'running' ? '关闭开关会结束提权进程并清除通道' : '打开开关：弹出一次 UAC 确认',
      }),
    };
  }
  // v14：dual-agent 属主已删，夹具换 dsh-orchestrator（同为带二级菜单的开关行）。
  if (String(url).includes('/dsh-orchestrator/')) {
    orchCalls.push({ url: String(url), options });
    if (String(url).includes('/status')) {
      return { ok: true, json: async () => ({ running: true, phase: 'running', note: '子代理默认 glm / glm-5.3', hint: '关闭后本会话的 orch_run 隐藏、触发器停用', menu: { route: '/dsh-orchestrator/menu', label: '子代理设置' } }) };
    }
    const wanted = options?.body === undefined ? undefined : JSON.parse(options.body).enabled;
    const running = wanted !== false;
    return { ok: true, json: async () => ({ ok: true, running, phase: running ? 'running' : 'off', note: running ? '子代理默认 glm / glm-5.3' : '子代理沿用插件配置', menu: { route: '/dsh-orchestrator/menu', label: '子代理设置' } }) };
  }
  throw new Error('unexpected fetch ' + url);
};

process.env.DSH_HOME = dir;
const plugin = await import('./index.js?v=wb-test-2');
// re-apply with our own state file
await plugin.apply(ctx, { stateFile });

const res = () => ({ headersSent: false, writeHead(){ this.headersSent = true; }, end(body){ this.body = body; } });
const call = async (path, method='GET', body=null) => {
  const [routePath] = path.split('?');
  const handler = routes.get(routePath);
  if (handler === undefined) throw new Error('no route ' + routePath);
  const req = { method, headers: { origin: '' }, url: path, on(){}, destroy(){} };
  if (body !== null) {
    const text = JSON.stringify(body);
    req.on = (event, cb) => {
      if (event === 'data') setImmediate(() => cb(Buffer.from(text)));
      if (event === 'end') setImmediate(() => cb());
    };
  } else {
    req.on = () => {};
  }
  const response = res();
  handler(req, response);
  for (let i = 0; i < 50 && response.body === undefined; i++) await new Promise((r) => setTimeout(r, 2));
  return JSON.parse(response.body ?? '{}');
};

const failures = [];
const check = (label, cond) => { console.log((cond?'ok   ':'FAIL ') + label); if(!cond) failures.push(label); };

// sessions: parent -> child family
sessionsById.set('child-1', { id: 'child-1', header: { parentSession: 'root-1' } });
sessionsById.set('root-1', { id: 'root-1', header: {} });

// 1. status: nothing checked
let st = await call('/dsh-workbench/status?sessionId=child-1');
check('status ok', st.ok !== false && Array.isArray(st.entries));
check('family resolved via parent', st.family === 'root-1');
check('default none checked', st.checked.length === 0);
check('two entries', st.entries.length === 2);

// 2. set both -> ultracode set + rea workbench called（带 sessionId，只动本会话）
st = await call('/dsh-workbench/set', 'POST', { sessionId: 'child-1', checked: ['ultracode', 'rea'] });
check('set saved', st.checked.includes('ultracode') && st.checked.includes('rea'));
check('ultracode driven', ultraCalls.some((c) => c.url.includes('/set') && JSON.parse(c.options.body).active === true));
check('rea driven', reaCalls.some((c) => c.url.includes('/workbench') && JSON.parse(c.options.body).on === true));
const reaWorkbenchCall = reaCalls.filter((c) => c.url.includes('/workbench')).at(-1);
check('rea driven with sessionId (not defaults)', JSON.parse(reaWorkbenchCall.options.body).sessionId === 'child-1');
check('status reports rea source', st.rea?.source === 'defaults' && st.rea?.masterEnabled === true);
const onDisk = JSON.parse(readFileSync(stateFile, 'utf8'));
check('persisted family-root key', onDisk.sessions['root-1'].checked.includes('ultracode'));

// 2b. 状态没变就不发写：再提交同一份勾选，不该产生新的 REA 调用
const reaCallCountBefore = reaCalls.length;
await call('/dsh-workbench/set', 'POST', { sessionId: 'child-1', checked: ['ultracode', 'rea'] });
check('no redundant rea write when unchanged', reaCalls.length === reaCallCountBefore);

// 3. family sharing: sibling sees the same selection
sessionsById.set('child-2', { id: 'child-2', header: { parentSession: 'root-1' } });
st = await call('/dsh-workbench/status?sessionId=child-2');
check('sibling inherits', st.checked.includes('rea') && st.checked.includes('ultracode'));

// 4. rea unchecked -> prompt waterfall strips mcp:rea section
st = await call('/dsh-workbench/set', 'POST', { sessionId: 'child-1', checked: ['ultracode'] });
const reaOffCall = reaCalls.filter((c) => c.url.includes('/workbench')).at(-1);
check('rea off driven with sessionId', JSON.parse(reaOffCall.options.body).on === false && JSON.parse(reaOffCall.options.body).sessionId === 'child-1');
const assembly = { sections: [
  { name: 'harness:identity', text: 'x' },
  { name: 'mcp:rea', text: '### MCP server: rea\n\n...' },
  { name: 'tool:workflow', text: 'y' },
]};
const ctxAgent = { session: { id: 'child-1', header: { parentSession: 'root-1' } } };
// family resolution needs sessions for the assemble path too
const result = await waterfallHandlers[0](assembly, { agent: ctxAgent, scope: undefined }, async () => assembly);
check('rea section stripped when unchecked', !result.sections.some((s) => s.name === 'mcp:rea'));
check('other sections kept', result.sections.some((s) => s.name === 'harness:identity'));

// 5. rea checked -> section kept
await call('/dsh-workbench/set', 'POST', { sessionId: 'child-1', checked: ['ultracode', 'rea'] });
const result2 = await waterfallHandlers[0](assembly, { agent: ctxAgent }, async () => assembly);
check('rea section kept when checked', result2.sections.some((s) => s.name === 'mcp:rea'));

// 6. reset clears（含本会话的 REA 覆盖）
st = await call('/dsh-workbench/reset', 'POST', { sessionId: 'child-1' });
check('reset clears checked', st.checked.length === 0);
check('ultracode reset called', ultraCalls.some((c) => c.url.includes('/reset')));
const reaResetCall = reaCalls.filter((c) => c.url.includes('/reset')).at(-1);
check('rea reset called with sessionId', reaResetCall !== undefined && JSON.parse(reaResetCall.options.body).sessionId === 'child-1');

// 7. 动作条目的开关契约：status 透出 kind/checked/phase/note，action 转发目标 enabled
st = await call('/dsh-workbench/status?sessionId=child-1');
const action = (st.actions ?? []).find((a) => a.id === 'orchestrator');
check('action row present', action !== undefined);
check('action declares switch control', action?.kind === 'switch');
check('action checked mirrors owner running', action?.checked === true && action?.running === true);
check('action phase passed through', action?.phase === 'running');
check('action note passed through', typeof action?.note === 'string' && action.note.includes('子代理默认'));
check('action menu forwarded', action?.menu?.route === '/dsh-orchestrator/menu');
await call('/dsh-workbench/action', 'POST', { sessionId: 'child-1', actionId: 'orchestrator', enabled: false });
const offCall = orchCalls.filter((c) => c.url.includes('/action')).at(-1);
check('action forwards enabled=false to owner', JSON.parse(offCall.options.body).enabled === false);
await call('/dsh-workbench/action', 'POST', { sessionId: 'child-1', actionId: 'orchestrator', enabled: true });
const onCall = orchCalls.filter((c) => c.url.includes('/action')).at(-1);
check('action forwards enabled=true to owner', JSON.parse(onCall.options.body).enabled === true);
await call('/dsh-workbench/action', 'POST', { sessionId: 'child-1', actionId: 'orchestrator' });
const legacyCall = orchCalls.filter((c) => c.url.includes('/action')).at(-1);
check('legacy action without enabled omits the key', !('enabled' in JSON.parse(legacyCall.options.body)));

// 8. v3：管理员权限通道动作条目（属主 dsh-admin-channel）
st = await call('/dsh-workbench/status?sessionId=child-1');
const admin = (st.actions ?? []).find((a) => a.id === 'admin-channel');
check('admin-channel row present', admin !== undefined);
check('admin-channel declares switch control', admin?.kind === 'switch');
check('admin-channel checked mirrors owner running', admin?.checked === true && admin?.running === true);
check('admin-channel hint passed through', typeof admin?.hint === 'string' && admin.hint.includes('提权进程'));
check('admin-channel label is localized', admin?.label === '管理员权限通道');
await call('/dsh-workbench/action', 'POST', { sessionId: 'child-1', actionId: 'admin-channel', enabled: false });
const adminOff = adminCalls.filter((c) => c.url.includes('/action')).at(-1);
check('admin-channel forwards enabled=false', JSON.parse(adminOff.options.body).enabled === false);
await call('/dsh-workbench/action', 'POST', { sessionId: 'child-1', actionId: 'admin-channel', enabled: true });
const adminOn = adminCalls.filter((c) => c.url.includes('/action')).at(-1);
check('admin-channel forwards enabled=true', JSON.parse(adminOn.options.body).enabled === true);

globalThis.fetch = originalFetch;
console.log(failures.length === 0 ? 'SELFTEST PASS' : `SELFTEST FAIL (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);