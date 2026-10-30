
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-test-'));
const stateFile = join(dir, 'workbench.json');
const reaFile = join(dir, 'rea-mcp', 'tools.json');

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
const dualCalls = [];
const adminCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).includes('/dsh-ultracode/')) {
    ultraCalls.push({ url: String(url), options });
    return { ok: true, json: async () => ({ active: true, available: true, requested: true, persisted: true, family: 'fam-1', familyRoot: true, branches: 0 }) };
  }
  if (String(url).includes('/dsh-rea-mcp/')) {
    reaCalls.push({ url: String(url), options });
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
  if (String(url).includes('/dsh-dual-agent/')) {
    dualCalls.push({ url: String(url), options });
    // 开关式属主：status 回 phase/running/armed；action 回新的 phase。
    if (String(url).includes('/status')) {
      return { ok: true, json: async () => ({ sessionId: 'SID', phase: 'armed', running: true, armed: true, note: '已武装：请键入本任务的初始指令。', childId: null, hatchAt: 1_700_000_000_000, agentLive: true, stateFile: '/x', storeError: null }) };
    }
    const wanted = options?.body === undefined ? undefined : JSON.parse(options.body).enabled;
    const phase = wanted === false ? 'off' : wanted === true ? 'armed' : 'armed';
    return { ok: true, json: async () => ({ sessionId: 'SID', phase, running: phase !== 'off', armed: phase === 'armed', note: null, childId: null, hatchAt: phase === 'running' ? 1_700_000_000_000 : null, agentLive: true, stateFile: '/x', storeError: null, action: phase === 'off' ? 'off' : 'armed' }) };
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

// 2. set both -> ultracode set + rea workbench called
st = await call('/dsh-workbench/set', 'POST', { sessionId: 'child-1', checked: ['ultracode', 'rea'] });
check('set saved', st.checked.includes('ultracode') && st.checked.includes('rea'));
check('ultracode driven', ultraCalls.some((c) => c.url.includes('/set') && JSON.parse(c.options.body).active === true));
check('rea driven', reaCalls.some((c) => c.url.includes('/workbench') && JSON.parse(c.options.body).on === true));
const onDisk = JSON.parse(readFileSync(stateFile, 'utf8'));
check('persisted family-root key', onDisk.sessions['root-1'].checked.includes('ultracode'));

// 3. family sharing: sibling sees the same selection
sessionsById.set('child-2', { id: 'child-2', header: { parentSession: 'root-1' } });
st = await call('/dsh-workbench/status?sessionId=child-2');
check('sibling inherits', st.checked.includes('rea') && st.checked.includes('ultracode'));

// 4. rea unchecked -> prompt waterfall strips mcp:rea section
st = await call('/dsh-workbench/set', 'POST', { sessionId: 'child-1', checked: ['ultracode'] });
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

// 6. reset clears
st = await call('/dsh-workbench/reset', 'POST', { sessionId: 'child-1' });
check('reset clears checked', st.checked.length === 0);
check('ultracode reset called', ultraCalls.some((c) => c.url.includes('/reset')));

// 7. 动作条目的开关契约：status 透出 kind/checked/phase/note，action 转发目标 enabled
st = await call('/dsh-workbench/status?sessionId=child-1');
const action = (st.actions ?? []).find((a) => a.id === 'dual-agent');
check('action row present', action !== undefined);
check('action declares switch control', action?.kind === 'switch');
check('action checked mirrors owner running', action?.checked === true && action?.running === true);
check('action phase passed through', action?.phase === 'armed');
check('action note passed through', typeof action?.note === 'string' && action.note.includes('已武装'));
check('action hatchAt forwarded (client live-timer anchor)', action?.hatchAt === 1_700_000_000_000);
await call('/dsh-workbench/action', 'POST', { sessionId: 'child-1', actionId: 'dual-agent', enabled: false });
const offCall = dualCalls.filter((c) => c.url.includes('/action')).at(-1);
check('action forwards enabled=false to owner', JSON.parse(offCall.options.body).enabled === false);
await call('/dsh-workbench/action', 'POST', { sessionId: 'child-1', actionId: 'dual-agent', enabled: true });
const onCall = dualCalls.filter((c) => c.url.includes('/action')).at(-1);
check('action forwards enabled=true to owner', JSON.parse(onCall.options.body).enabled === true);
await call('/dsh-workbench/action', 'POST', { sessionId: 'child-1', actionId: 'dual-agent' });
const legacyCall = dualCalls.filter((c) => c.url.includes('/action')).at(-1);
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
