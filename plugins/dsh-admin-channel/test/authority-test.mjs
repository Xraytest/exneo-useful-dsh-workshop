/**
 * v11 启动授权（常驻提权授权）生命周期测试 —— 全程无 UAC、无桌面操作。
 *
 * 覆盖用户指令「在 dsh 启动时请求管理员权限提供给会话，可选开启权限时不需要再弹窗」
 * 的行为契约：
 *   1. 授权就绪后，会话拨开关 = **零次** launcher 调用（只挂载，不再弹窗）；
 *   2. 会话拨关 / 会话销毁 = 只摘挂载，常驻提权进程**不被杀**（其它会话还能用）；
 *   3. 命令走授权进程时审计仍按**发起会话**记录（审计不糊账）；
 *   4. ensureAuthority 幂等：重复调用不新建进程；
 *   5. 授权不可用时回落到「会话自建通道」（旧行为，仍只弹一次）；
 *   6. startupConsent: false 时 start() 绝不挂载（完全回到 v10 语义）；
 *   7. maxChannels 计数不含授权记录：授权在跑时第二个会话仍能自建/挂载；
 *   8. releaseAuthority 关掉进程并让挂载会话回到 off。
 *
 * 提权本身用注入的 fake launcher 起**非提权** broker（requireElevation:false），
 * 与 sandbox-lifecycle.mjs 同一套桩；被断言的是「谁在什么时候被 spawn」和挂载语义，
 * 而不是 UAC 结果。
 *
 * 运行：node test/authority-test.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PS = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const BROKER = join(fileURLToPath(new URL('..', import.meta.url)), 'broker.ps1');
const HOME = await mkdtemp(join(tmpdir(), 'dsh-admin-authority-'));
process.env.DSH_HOME = HOME;

const { createAdminChannelManager } = await import('../lib/channel.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(150);
  }
  throw new Error(`等待超时：${label}`);
};

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
 * 造一个「launcher 计数」的 manager：fake broker 与生产 broker 同一个脚本，
 * 只是不经 UAC（非提权）。spawns 记录每次被拉起的 key，用于断言零弹窗。
 */
function makeManager(config = {}) {
  const spawns = [];
  const children = [];
  const manager = createAdminChannelManager({
    ctx: {},
    config: {
      requireElevation: false,
      uacTimeoutMs: 20_000,
      idleTimeoutMs: 0,
      maxChannels: 1,
      execTimeoutMs: 20_000,
      ...config,
    },
    launch: async ({ specPath }) => {
      spawns.push(specPath);
      const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BROKER, '-Spec', specPath], {
        windowsHide: true,
        stdio: 'ignore',
      });
      children.push(child);
      return child;
    },
  });
  return { manager, spawns, children };
}

/**
 * 每次 launcher 被调用 == 一次潜在 UAC 弹窗。spawns.length 就是「用户被弹了几次」
 * 的直接证据；本套测试的多数断言都在证明「除了第一次，其余全是 0」。
 */

// ── 1. 授权就绪 → 会话挂载 = 零 spawn ────────────────────────────────────
{
  const { manager, spawns } = makeManager();
  await manager.ensureAuthority();
  await until(() => manager.authorityStatus().ready, 20_000, '启动授权就绪');
  check('授权建立后 status.ready 为真', manager.authorityStatus().ready === true);
  check('授权记录本身确实提权进程在跑（brokerPid 有效）',
    Number.isFinite(manager.authorityStatus().brokerPid) && manager.authorityStatus().brokerPid > 0,
    JSON.stringify(manager.authorityStatus()));
  check('ensureAuthority 只 spawn 一次', spawns.length === 1, JSON.stringify(spawns));

  const before = spawns.length;
  const st = await manager.start('sess-a');
  check('会话拨开关后 phase=running', st.phase === 'running', st.phase);
  check('会话拨开关**没有**再 spawn 进程（零 UAC）', spawns.length === before, JSON.stringify(spawns));
  check('会话被判定为挂载（borrowed）', st.borrowed === true, JSON.stringify(st.note));
  check('会话自身没有 broker 记录（recordCount 只算真实记录）', manager.recordCount === 1, String(manager.recordCount));
  check('isBorrowed 反映挂载', manager.isBorrowed('sess-a') === true);
  check('status.note 明确说了零弹窗', /零弹窗|挂载/.test(String(st.note)), String(st.note));

  // 命令确实由授权进程执行，且审计按发起会话记账
  const out = await manager.exec('sess-a', { command: 'Write-Output "via-authority"' });
  check('挂载会话的命令跑通并回到发起会话', out.exitCode === 0 && String(out.stdout).includes('via-authority'), JSON.stringify(out));
  check('命令没有额外 spawn', spawns.length === before, JSON.stringify(spawns));

  // 第二个会话也走同一条：maxChannels=1 不该拦住挂载
  const second = await manager.start('sess-b');
  check('第二个会话同样挂载成功（不受 maxChannels 限制）', second.phase === 'running' && second.borrowed === true, JSON.stringify({ phase: second.phase, borrowed: second.borrowed }));
  const out2 = await manager.exec('sess-b', { command: 'Write-Output "second-session"' });
  check('第二个会话的命令也跑通', out2.exitCode === 0 && String(out2.stdout).includes('second-session'));

  // 会话拨关 = 只摘挂载，进程还活着
  const pidBefore = manager.authorityStatus().brokerPid;
  await manager.stop('sess-a', 'user');
  check('会话拨关后自己回到 off', manager.statusOf('sess-a').phase === 'off', manager.statusOf('sess-a').phase);
  check('拨关没有杀常驻进程（brokerPid 不变）', manager.authorityStatus().brokerPid === pidBefore && manager.authorityStatus().ready === true,
    JSON.stringify({ before: pidBefore, after: manager.authorityStatus().brokerPid }));
  const out3 = await manager.exec('sess-b', { command: 'Write-Output "still-alive"' });
  check('剩余会话继续可用', out3.exitCode === 0 && String(out3.stdout).includes('still-alive'));

  // 关键回归：**授权存在 ≠ 会话有权**。没拨开关的会话必须仍然被拒——挂载只由
  // 用户在工作箱里的明确动作触发，模型不能自己借用常驻授权（同意不被稀释）。
  const out4 = await manager.exec('sess-never-flipped', { command: 'Write-Output "should-not-run"' })
    .then(() => null)
    .catch((error) => error.message);
  check('未拨开关的会话不能借用常驻授权（同意未被稀释）',
    typeof out4 === 'string' && /没有开启/.test(out4), String(out4));
  const stOff = manager.statusOf('sess-never-flipped');
  check('未拨开关的会话 status 仍为 off（但告知可零弹窗开启）',
    stOff.phase === 'off' && /零弹窗|不会弹 UAC/.test(String(stOff.note)), JSON.stringify({ phase: stOff.phase, note: stOff.note }));

  // 会话销毁（index.js 走 stop(...,'session-disposed')）同样只摘挂载
  await manager.stop('sess-b', 'session-disposed');
  check('会话销毁后授权仍在（不属于任何会话）', manager.authorityStatus().ready === true);

  await manager.disposeAll();
  await until(() => manager.authorityStatus().ready === false, 20_000, 'disposeAll 关掉授权');
  check('disposeAll 会关掉常驻进程（提权不比宿主长寿）', manager.authorityStatus().ready === false);
}

// ── 2. ensureAuthority 幂等 + 挂载可恢复 ────────────────────────────────
{
  const { manager, spawns } = makeManager();
  await manager.ensureAuthority();
  await until(() => manager.authorityStatus().ready, 20_000, '授权就绪（幂等用例）');
  await manager.ensureAuthority();
  await manager.ensureAuthority();
  check('重复 ensureAuthority 不再 spawn', spawns.length === 1, JSON.stringify(spawns));

  await manager.start('sess-c');
  check('挂载后重复 start 幂等（不新增 spawn）', spawns.length === 1 && manager.isBorrowed('sess-c') === true);

  await manager.releaseAuthority('test');
  check('releaseAuthority 后授权不可用', manager.authorityStatus().ready === false);
  check('releaseAuthority 让挂载会话回到 off', manager.statusOf('sess-c').phase === 'off', manager.statusOf('sess-c').phase);
  check('释放后 attached 归零', manager.authorityStatus().attached === 0, String(manager.authorityStatus().attached));

  // 关键回归：授权被释放后，会话再拨开关必须能**自建**通道（旧 bug：挂在死授权上恢复不了）
  await manager.start('sess-c');
  check('授权释放后重新拨开关会自建通道（spawn +1）', spawns.length === 2, JSON.stringify(spawns));
  check('自建后不再被标记为 borrowed', manager.isBorrowed('sess-c') === false);
  // 自建路径 start() 立刻返回 starting（UAC/握手在后台），exec 必须等就绪——
  // 这正是「授权不可用时回到旧行为」的证明。
  await until(() => manager.statusOf('sess-c').phase === 'running', 20_000, '自建通道就绪');
  const own = await manager.exec('sess-c', { command: 'Write-Output "own-channel"' });
  check('自建通道命令跑通', own.exitCode === 0 && String(own.stdout).includes('own-channel'));

  await manager.disposeAll();
}

// ── 3. startupConsent:false = 完全回到 v10 语义 ─────────────────────────
{
  const { manager, spawns } = makeManager({ startupConsent: false });
  const boot = manager.bootstrapAuthority();
  check('startupConsent=false 时 bootstrapAuthority 不 spawn', spawns.length === 0 && boot.enabled === false, JSON.stringify({ spawn: spawns.length, enabled: boot.enabled }));
  await manager.ensureAuthority();
  await until(() => manager.authorityStatus().ready, 20_000, '手动建立的授权（关闭开关场景）');
  const st = await manager.start('sess-d');
  check('startupConsent=false 时 start 不挂载授权（走自建）', st.borrowed === false && spawns.length === 2, JSON.stringify({ borrowed: st.borrowed, spawns: spawns.length }));
  await manager.disposeAll();
}

// ── 4. 授权失败 → declined，会话不被卡死 ────────────────────────────────
{
  const spawns = [];
  const manager = createAdminChannelManager({
    ctx: {},
    config: { requireElevation: false, uacTimeoutMs: 3_000, idleTimeoutMs: 0, maxChannels: 1, startupConsent: true },
    // launcher 立即失败（等价于用户在 UAC 点了「否」）
    launch: async () => {
      spawns.push('x');
      return spawn(PS, ['-NoProfile', '-Command', 'exit 1'], { windowsHide: true, stdio: 'ignore' });
    },
  });
  await manager.ensureAuthority();
  await until(() => manager.authorityStatus().phase === 'error', 20_000, '授权失败进入 error');
  const auth = manager.authorityStatus();
  check('授权失败后 phase=error', auth.phase === 'error', auth.phase);
  check('授权失败后 declined=true（不再自动追问）', auth.declined === true, JSON.stringify(auth));
  check('失败后会话不被标记为挂载', manager.isBorrowed('sess-e') === false);

  const st = manager.statusOf('sess-e');
  check('授权坏了会话仍可自建（status 不谎报 running）', st.phase === 'off' && st.authority.ready === false, JSON.stringify({ phase: st.phase }));
  await manager.disposeAll();
}

console.log(`\n${passed} checks passed（authority home: ${HOME}）`);
