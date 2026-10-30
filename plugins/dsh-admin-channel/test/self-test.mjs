/**
 * 非提权自测：直接拉起 broker.ps1（不带 UAC），验证命名管道协议、认证、执行、
 * 超时、退出码、UTF-8 输出与停止语义。
 *
 * 这不是提权测试：提权后的路径（launch.ps1 → UAC → broker）要在真实桌面里由用户
 * 点一次「是」才能端到端验证。本测试恰好证明 **未提权** 的 broker 会被 host 拒绝
 * （ready.elevated === false），并且协议层不依赖管理员令牌。
 *
 * 运行：node test/self-test.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PipeClient } from '../lib/pipe-client.js';

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));
const BROKER = join(PLUGIN_DIR, 'broker.ps1');
const PS = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
    return;
  }
  console.error(`  FAIL ${name}${detail === undefined ? '' : `：${detail}`}`);
  process.exitCode = 1;
};

/**
 * 写一份 spec 并起 broker（非提权）。
 * @param {string} root
 * @param {{ token?: string, ownerPid?: number }} [options]
 */
async function startBroker(root, options = {}) {
  const nonce = randomBytes(6).toString('hex');
  const pipeName = `dsh-admin-test-${nonce}`;
  const token = options.token ?? randomBytes(32).toString('hex');
  const tempDir = join(root, nonce);
  await mkdir(tempDir, { recursive: true });
  const spec = {
    version: 1,
    pipeName,
    token,
    ownerPid: options.ownerPid ?? process.pid,
    ownerUser: `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`,
    brokerPath: BROKER,
    tempDir,
    maxOutputBytes: 32768,
    connectTimeoutMs: 20000,
  };
  const specPath = join(tempDir, 'spec.json');
  await writeFile(specPath, JSON.stringify(spec, null, 2), 'utf8');
  const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BROKER, '-Spec', specPath], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const exit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exit, spec, tempDir, pipePath: `\\\\.\\pipe\\${pipeName}`, token, stderr: () => stderr };
}

/**
 * @param {string} pipePath
 * @param {string} token
 * @param {number} [timeoutMs]
 */
async function handshake(pipePath, token, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const client = new PipeClient();
    try {
      await client.connect(pipePath, 1000);
    } catch (error) {
      lastError = error;
      client.close();
      await sleep(150);
      continue;
    }
    client.send({ type: 'auth', token });
    const ready = await client.waitFor((message) => message.type === 'ready', 5000, 'ready');
    return { client, ready };
  }
  throw lastError ?? new Error('broker 没有起来');
}

async function main() {
  const root = join(tmpdir(), `dsh-admin-test-${randomBytes(4).toString('hex')}`);
  await mkdir(root, { recursive: true });
  console.log(`# broker: ${BROKER}`);
  console.log(`# scratch: ${root}`);

  // ── 1. 正常握手 + 执行 + UTF-8 + 退出码 ────────────────────────────────
  {
    const broker = await startBroker(root);
    const { client, ready } = await handshake(broker.pipePath, broker.token);
    check('broker 握手成功', ready.type === 'ready');
    check('非提权 broker 报告 elevated=false', ready.elevated === false, String(ready.elevated));
    check('broker 报告的 pid 是自身进程', Number(ready.pid) === broker.child.pid, `${ready.pid} != ${broker.child.pid}`);

    const first = await client.request({ type: 'exec', command: "Write-Output 'hello-世界'; Write-Error 'err-line'", cwd: root, timeoutMs: 30000 }, 45000);
    check('执行返回 ok', first.ok === true, JSON.stringify(first).slice(0, 200));
    check('stdout 含 hello-世界', typeof first.stdout === 'string' && first.stdout.includes('hello-世界'), first.stdout);
    check('stderr 含 err-line', typeof first.stderr === 'string' && first.stderr.includes('err-line'), first.stderr);
    check('exitCode 为 0', first.exitCode === 0, String(first.exitCode));

    const failed = await client.request({ type: 'exec', command: 'exit 3', timeoutMs: 15000 }, 30000);
    check('显式 exit 3 被保留', failed.exitCode === 3, String(failed.exitCode));

    const cwdResult = await client.request({ type: 'exec', command: '(Get-Location).Path', cwd: root, timeoutMs: 15000 }, 30000);
    check('cwd 生效', String(cwdResult.stdout).trim() === root, JSON.stringify(cwdResult.stdout));

    const timed = await client.request({ type: 'exec', command: 'Start-Sleep -Seconds 10', timeoutMs: 1500 }, 30000);
    check('超时会杀掉命令并标记 timedOut', timed.timedOut === true, JSON.stringify({ timedOut: timed.timedOut, exit: timed.exitCode }));

    client.send({ type: 'stop' });
    const stopped = await client.waitFor((m) => m.type === 'stopped', 5000, 'stopped').catch(() => null);
    check('stop 有回执', stopped !== null && stopped.type === 'stopped');
    client.close();
    const code = await Promise.race([broker.exit, sleep(8000).then(() => 'timeout')]);
    check('stop 后 broker 退出', code === 0, String(code));
    await rm(broker.tempDir, { recursive: true, force: true });
  }

  // ── 2. 错误令牌被拒绝 ───────────────────────────────────────────────────
  {
    const broker = await startBroker(root);
    let rejected = false;
    try {
      const client = new PipeClient();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try { await client.connect(broker.pipePath, 1000); break; } catch { await sleep(150); }
      }
      client.send({ type: 'auth', token: 'x'.repeat(64) });
      const message = await client.waitFor((m) => m.type === 'error' || m.type === 'ready', 4000, 'auth 结果').catch(() => null);
      rejected = message === null || message.type === 'error';
      client.close();
    } catch {
      rejected = true;
    }
    const code = await Promise.race([broker.exit, sleep(8000).then(() => 'timeout')]);
    check('错误令牌被拒绝且 broker 退出', rejected && code === 18, `${rejected}/${code}`);
    await rm(broker.tempDir, { recursive: true, force: true });
  }

  // ── 3. owner 进程不存在时 broker 拒绝启动 ───────────────────────────────
  {
    const gone = spawn('node', ['-e', ''], { windowsHide: true, stdio: 'ignore' });
    const gonePid = gone.pid;
    await new Promise((resolve) => gone.on('exit', resolve));
    const broker = await startBroker(root, { ownerPid: gonePid });
    const code = await Promise.race([broker.exit, sleep(8000).then(() => 'timeout')]);
    check('owner 进程不存在时 broker 拒绝启动', code === 12, String(code));
    await rm(broker.tempDir, { recursive: true, force: true });
  }

  // ── 4. 日志存在且包含握手记录 ──────────────────────────────────────────
  {
    const broker = await startBroker(root);
    const { client } = await handshake(broker.pipePath, broker.token);
    client.close();
    await Promise.race([broker.exit, sleep(8000).then(() => 'timeout')]);
    const logPath = join(broker.tempDir, 'broker.log');
    const log = existsSync(logPath) ? await readFile(logPath, 'utf8') : '';
    check('broker.log 记录了 ready', log.includes('ready'), log.split('\n').slice(-3).join(' | '));
    await rm(broker.tempDir, { recursive: true, force: true });
  }

  await rm(root, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
