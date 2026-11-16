// Minimal MCP stdio probe: initialize -> tools/list -> optional tools/call.
// Usage: node rea-mcp-probe.mjs <rea.mjs path> [toolName toolArgsJSON]
import { spawn } from 'node:child_process';

const [entry, toolName, toolArgs] = process.argv.slice(2);
if (!entry) {
  console.error('usage: node rea-mcp-probe.mjs <rea.mjs> [toolName] [argsJSON]');
  process.exit(2);
}

const child = spawn(process.execPath, [entry, 'mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let buf = '';
let stderr = '';
const pending = new Map();
let id = 0;

child.stderr.on('data', (d) => { stderr += d; });
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function request(method, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout: ' + method)); }
    }, timeoutMs);
  });
}

const t0 = Date.now();
try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-rea-probe', version: '0.0.1' },
  });
  if (init.error) throw new Error('initialize error: ' + JSON.stringify(init.error));
  console.log('handshake_ms=' + (Date.now() - t0));
  console.log('server=' + JSON.stringify(init.result?.serverInfo));
  console.log('protocol=' + init.result?.protocolVersion);
  console.log('instructions_bytes=' + Buffer.byteLength(init.result?.instructions ?? ''));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const tl = await request('tools/list', {});
  if (tl.error) throw new Error('tools/list error: ' + JSON.stringify(tl.error));
  const tools = tl.result?.tools ?? [];
  console.log('tool_count=' + tools.length);
  console.log('TOOLS=' + tools.map((t) => t.name).join(','));

  if (toolName) {
    const call = await request('tools/call', {
      name: toolName,
      arguments: toolArgs ? JSON.parse(toolArgs) : {},
    }, 600000);
    if (call.error) throw new Error('tools/call error: ' + JSON.stringify(call.error));
    const text = (call.result?.content ?? [])
      .map((c) => (c.type === 'text' ? c.text : `<${c.type}>`)).join('\n');
    console.log('CALL_OK=' + (call.result?.isError ? 'isError' : 'ok'));
    console.log('CALL_RESULT_HEAD=' + text.slice(0, 1500).replaceAll('\n', ' \\n '));
  }
} catch (e) {
  console.error('PROBE_FAIL: ' + e.message);
  if (stderr) console.error(stderr.slice(0, 3000));
  child.kill('SIGKILL');
  process.exit(1);
}
child.kill('SIGTERM');
setTimeout(() => process.exit(0), 300);
