/**
 * 沙盒生命周期测试（无 UAC、无桌面操作）：
 * 用注入的 launcher 直接起 **非提权** broker，跑完整的 host 管理器路径：
 *   启动 → 握手 → admin_exec → 并发上限 → 关闭清理 → 空闲自动关闭 → 审计。
 *
 * 生产 launcher（UAC 那条）不在这里跑；它需要用户在真实桌面点一次「是」，
 * 已在 2026-10-29 的实测中验证（见 README「实测」）。
 *
 * 运行：node test/sandbox-lifecycle.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PS = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const BROKER = join(fileURLToPath(new URL('..', import.meta.url)), 'broker.ps1');
const HOME = await mkdtemp(join(tmpdir(), 'dsh-admin-sandbox-'));
process.env.DSH_HOME = HOME;

const { createAdminChannelManager } = await import('../lib/channel.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(200);
  }
  throw new Error(`等待超时：${label}`);
};

const launched = [];
const manager = createAdminChannelManager({
  ctx: {},
  config: {
    requireElevation: false,
    uacTimeoutMs: 20_000,
    idleTimeoutMs: 6_000,
    maxChannels: 1,
    execTimeoutMs: 20_000,
  },
  launch: async ({ specPath }) => {
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BROKER, '-Spec', specPath], {
      windowsHide: true,
      stdio: 'ignore',
    });
    launched.push(child.pid);
    return child;
  },
});

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

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const session = 'session-sandbox';

// 1. 未开启时 exec 给可执行错误
{
  let error;
  try {
    await manager.exec(session, { command: 'whoami' });
  } catch (caught) {
    error = caught;
  }
  check('未开启时 exec 拒绝', error instanceof Error && error.message.includes('管理员权限通道'));
}

// 2. 启动 → 就绪
const startStatus = await manager.start(session);
check('start 立即返回 starting', startStatus.phase === 'starting' && startStatus.running === true && startStatus.armed === true);
await until(() => manager.statusOf(session).phase === 'running', 20_000, 'broker 就绪');
const running = manager.statusOf(session);
check('通道就绪（沙盒 broker 未提权）', running.running === true && running.elevated === false);
check('broker pid 已记录', Number.isFinite(running.brokerPid) && alive(running.brokerPid));

// 3. 执行
const result = await manager.exec(session, { command: 'Write-Output "sandbox-ok"; [Console]::OutputEncoding.WebName; exit 0' });
check('exec stdout 正确', String(result.stdout).includes('sandbox-ok'), result.stdout);
check('exec exitCode 为 0', result.exitCode === 0, String(result.exitCode));
check('exec 记录了 lastCommand', manager.statusOf(session).lastCommand.includes('sandbox-ok'));

// 4. 并发上限：另一会话不能偷偷再开一条
{
  let error;
  try {
    await manager.start('session-other');
  } catch (caught) {
    error = caught;
  }
  check('并发上限拒绝第二个会话', error instanceof Error && error.message.includes('另一会话'), error?.message);
}

// 5. 关闭 → 进程与临时目录清理
const brokerPid = manager.statusOf(session).brokerPid;
await manager.stop(session, 'sandbox-test');
check('stop 后状态 off', manager.statusOf(session).phase === 'off');
await sleep(800);
check('broker 进程已退出', alive(brokerPid) === false, String(brokerPid));
check('exec 在关闭后再次拒绝', await manager.exec(session, { command: 'x' }).then(() => false, () => true));

// 6. 空闲自动关闭（idleTimeoutMs = 6s）
await manager.start(session);
await until(() => manager.statusOf(session).phase === 'running', 20_000, '第二次就绪');
const idlePid = manager.statusOf(session).brokerPid;
check('第二次通道已开启', Number.isFinite(idlePid));
await until(() => manager.statusOf(session).phase === 'off', 15_000, '空闲自动关闭');
check('空闲超时自动关闭', manager.statusOf(session).phase === 'off');
await sleep(800);
check('空闲关闭后 broker 退出', alive(idlePid) === false);

// 7. 执行长命令期间关闭：cancel 文件必须让 broker 杀掉命令并退出
await manager.start(session);
await until(() => manager.statusOf(session).phase === 'running', 20_000, '第三次就绪');
const longPid = manager.statusOf(session).brokerPid;
const longRun = manager
  .exec(session, { command: 'Start-Sleep -Seconds 30; Write-Output "late"', timeoutMs: 60_000 })
  .then(() => 'resolved', () => 'rejected');
await sleep(1000); // 让 broker 进入 WaitForExit 轮询
await manager.stop(session, 'stop-during-exec');
check('执行中关闭后状态 off', manager.statusOf(session).phase === 'off');
const outcome = await Promise.race([longRun, sleep(15_000).then(() => 'timeout')]);
check('执行中的命令在关闭时被取消', outcome === 'rejected' || outcome === 'resolved', String(outcome));
await sleep(800);
check('执行中关闭后 broker 退出', alive(longPid) === false, String(longPid));

// 8. 审计落盘
{
  const auditPath = join(HOME, 'admin-channel', 'audit.jsonl');
  check('审计文件存在', existsSync(auditPath));
  const lines = existsSync(auditPath) ? (await readFile(auditPath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const events = new Set(lines.map((entry) => entry.event));
  check('审计含 start/exec/stop', events.has('start') && events.has('exec') && events.has('stop'), [...events].join(','));
  check('审计命令为原文', lines.some((entry) => entry.event === 'exec' && String(entry.command).includes('sandbox-ok')));
}

await manager.disposeAll();
console.log(`\n${passed} checks passed（sandbox home: ${HOME}）`);
