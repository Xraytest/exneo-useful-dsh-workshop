/**
 * 统计插件「按分组」维度接入器（dsh-model-groups → dsh-usage-stats）。
 *
 *   node plugins/dsh-model-groups/stats-integration.mjs            # 只检查（默认）
 *   node plugins/dsh-model-groups/stats-integration.mjs --apply    # 打补丁（自动备份 + 语法校验）
 *   node plugins/dsh-model-groups/stats-integration.mjs --copy <目录> [--apply]
 *                                                                  # 对副本演练（推荐先跑）
 *   node plugins/dsh-model-groups/stats-integration.mjs --live     # 写热挂入口 <ENTRY> + 改 patch 行 name
 *   node plugins/dsh-model-groups/stats-integration.mjs --unlive   # 把 patch 行 name 退回 index.js
 *   node plugins/dsh-model-groups/stats-integration.mjs --revert --apply   # 撤销全部补丁（回滚首选）
 *
 * 落盘是**逐文件原子**的：同一文件的补丁要么一起生效、要么一处不落；锚点对不上就拒绝
 * 该文件（绝不改错地方）。备份名永不复用（同一次运行的第一个备份才是回滚点）。
 * `--copy` 演练禁止 `--live`（真实 patch 行只由真实 profile 的操作改写）。
 *
 * 为什么需要这个脚本：统计插件的 `by` 维度是硬编码的 if/else 链与白名单，
 * 分组维度必须在三处落地——白名单、分桶、以及（客户端）页签与文案。
 * 补丁全部按「锚点唯一匹配」施加，已打过就跳过（幂等）；锚点对不上就报错，
 * 不猜、不模糊匹配——对面插件在演进，宁可拒绝也不改错地方。
 *
 * 落地的语义（与 dsh-model-groups 的冻结口径一致）：
 *   - **查询时解析分组**：事实（facts）里从不写组名，改组/改名/停用后历史用量
 *     立刻按新口径重排，不需要重扫；
 *   - **互斥**：一个 (provider, model) 最多归属一个组（解析规则见 resolve.js），
 *     故分组行天然可加、恰好等于总量，不会重复计入；
 *   - 未命中任何组的用量进「未分组」桶（key = `__ungrouped__`，与客户端同常量）；
 *   - 分组插件不在线时：整个维度退化为单个「未分组」行，接口不报错。
 *
 * 热生效（本 profile 未开模块热载，loader 按 specifier 缓存模块）：
 *   `--live` 会把 patch 行的 name 指向新写的入口文件（`ENTRY` 常量，当前 entry-v9.js；
 *   **保持同一行 id**，loader 走 dispose→start），该入口以 `?v=<TAG>` 重新求值 index.js，
 *   而 index.js 的 fold.js 导入也带同一 TAG，于是整张图是新实例。
 *   回滚：`--unlive`（或重启 dsh，磁盘上的源码本身就是对的）。
 *
 * @module dsh-model-groups/stats-integration
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = resolvePath(HERE, '..', '..');
const DEFAULT_STATS = join(PROFILE, 'plugins', 'dsh-usage-stats');
const PATCH_FILE = join(PROFILE, 'cordis.patch.yml');
// TAG = **当前图代号**，由「换实现的人」bump（谁改 index.js/fold.js 谁换一个，
// 保证 loader 拿到新实例）。2026-10-09 缓存占比 v7 把它从 group-dim-4 换成
// cache-share-4；分组维接入本身没变，但本工具的 TAG/ENTRY 必须跟着走，
// 否则锚点对不上会直接拒绝写入（--check 报 INTEGRATION FAIL）。
const TAG = 'cache-share-4';
const ENTRY = 'entry-v9.js';   // 与 TAG 配套：--live 生成/指向的就是当前这一版图

/* ------------------------------------------------------------- 工具 ---- */

/**
 * 参数解析**失败即拒绝**（unknown flag 一律 exit 2）。
 *
 * 独立验证报出的 high：以前只认 `argv` 里独立的 `--copy` token，于是 `--copy=/tmp/x`
 * （等号形式，最容易手滑）被静默忽略 → `COPY=null` → `STATS` 落回**真实 profile**，
 * `--apply` 就写生产了；任何 `--copy*` 拼错同理（未知 flag 静默忽略是共同根因）。
 */
const KNOWN_FLAGS = new Set(['--check', '--apply', '--copy', '--live', '--unlive', '--revert']);
const STRICT_KEYS = new Set(['--copy']);
const argv = process.argv.slice(2);
const parsed = new Map();
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i];
  const eq = token.indexOf('=');
  const key = eq >= 0 && token.startsWith('--') ? token.slice(0, eq) : token;
  if (!KNOWN_FLAGS.has(key)) {
    process.stdout.write(`  ✗ 未知参数「${token}」——本工具一律拒绝（拼错的 --copy 会静默写真实 profile，太危险）\n`);
    process.stdout.write(`    可用：${[...KNOWN_FLAGS].join(' ')}\n`);
    process.exit(2);
  }
  if (STRICT_KEYS.has(key)) {
    const value = eq >= 0 ? token.slice(eq + 1) : argv[i + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      process.stdout.write(`  ✗ ${key} 后面必须跟目录（缺参数时会静默写成对真实 profile 落盘——那太危险了）\n`);
      process.exit(2);
    }
    parsed.set(key, value);
    if (eq < 0) i += 1;
    continue;
  }
  if (eq >= 0) {
    process.stdout.write(`  ✗ ${key} 不接受取值：${token}\n`);
    process.exit(2);
  }
  parsed.set(key, true);
}
const hasFlag = (flag) => parsed.get(flag) === true;
const APPLY = hasFlag('--apply');
const COPY = typeof parsed.get('--copy') === 'string' ? parsed.get('--copy') : null;
const STATS = COPY === null ? DEFAULT_STATS : resolvePath(COPY);
const MARK = 'dsh-model-groups 接入';

let problems = 0;
let pending = 0;
/** 撤销前的文件文本（key=文件名），撤销后做往返校验用。 */
const REVERT_BEFORE = new Map();
const log = (text) => process.stdout.write(text + '\n');
const bad = (text) => { problems += 1; log('  ✗ ' + text); };
const ok = (text) => log('  ✓ ' + text);

if (COPY !== null && !existsSync(COPY)) {
  log(`  ✗ --copy 目录不存在：${COPY}`);
  process.exit(2);
}

/**
 * 一处补丁：anchor 必须在文件里**恰好出现一次**，否则拒绝。
 *
 * 只登记、不落盘——同一个文件的多处补丁要么一起成功、要么一处不落（`flushPlan()`），
 * 避免「一半补丁生效」把对面文件留在不自洽的中间态（那比不改更糟）。
 */
const PLAN = new Map();
function patch(file, label, anchor, replacement, extra = {}) {
  if (!existsSync(join(STATS, file))) { bad(`${file} 不存在`); return; }
  if (!PLAN.has(file)) PLAN.set(file, []);
  PLAN.get(file).push({ label, anchor, replacement, aliases: extra.aliases });
}

/** 备份名永不复用：同一次运行的第一个备份才是真正的回滚点。 */
function backupOf(path, tag) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  for (let n = 0; n < 100; n += 1) {
    const candidate = `${path}.bak-${tag}-${stamp}${n === 0 ? '' : '-' + n}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${path}.bak-${tag}-${stamp}-x${Date.now()}`;
}

/**
 * 落盘：逐文件判定。
 *   - 全部补丁的 anchor 都在 → 备份一次、一次写入（原子：不会留下半成品）；
 *   - 全部补丁的 replacement 都在 → 已接入，跳过；
 *   - 混合 → 报错并**拒绝该文件**（人工核对），其余文件照常处理。
 * @returns {string[]} 真正被写过的文件名
 */
function flushPlan() {
  const written = [];
  for (const [file, entries] of PLAN) {
    const path = join(STATS, file);
    let source = readFileSync(path, 'utf8');
    // `aliases`：同一处补丁**历史版本的完整替换文本**（不是其中一行）。payload 改过文案
    // 之后，已落盘的旧形态仍算「已接入」（否则会被判成半成品而拒绝写入），
    // 撤销时按 alias → anchor 整段还原。
    const hasIt = (entry, text) => text.includes(entry.replacement)
      || (Array.isArray(entry.aliases) && entry.aliases.some((alias) => text.includes(alias)));
    const already = entries.filter((entry) => hasIt(entry, source));
    if (already.length === entries.length) {
      for (const entry of entries) ok(`${file}：${entry.label.name} 已接入`);
      continue;
    }
    const missing = entries.filter((entry) => !hasIt(entry, source));
    const unmatched = missing.filter((entry) => source.split(entry.anchor).length - 1 !== 1);
    if (unmatched.length > 0) {
      for (const entry of unmatched) {
        const hits = source.split(entry.anchor).length - 1;
        bad(`${file}：${entry.label.name} 锚点匹配 ${hits} 次（应为 1）——对面文件已改动，请人工核对`);
      }
      if (already.length > 0) bad(`${file}：该文件有 ${already.length} 处已接入、${unmatched.length} 处锚点不匹配 → 拒绝写入本文件（避免半成品）`);
      else log(`  · ${file}：${unmatched.length} 处无法定位，已跳过`);
      continue;
    }
    if (!APPLY) {
      // 只报**真正缺的**那几处：以前只要有 1 处锚点失配就把整文件所有补丁都列成待接入
      //（1 处缺失报成 7 处），独立验证报出的误导。
      pending += missing.length;
      if (already.length > 0) log(`  · ${file}：${already.length} 处已接入、${missing.length} 处待接入`);
      for (const entry of missing) log(`  · ${file}：${entry.label.name} 待接入`);
      continue;
    }
    let next = source;
    // 只打**缺的**：anchor ⊆ replacement 的补丁（本工具里有 4 处，如 fold.js 的 opts
    // 声明、client.js 的能力提示）在已接入后 anchor 仍在文件里，遍历 entries 会把内容
    // 再插一份（fold.js 会直接语法坏），而工具还会报成功——独立验证报出的 high。
    for (const entry of missing) next = next.replace(entry.anchor, entry.replacement);
    const backup = backupOf(path, MARK.replace(/\s+/g, ''));
    try {
      copyFileSync(path, backup);
      writeFileSync(path, next, 'utf8');
    } catch (error) {
      // 只读目录 / 同名目录 / 磁盘满……以前是未捕获异常 + 栈回溯（独立验证报出）。
      bad(`${file}：写入失败（${String(error.code || error.message)}）——该文件保持原样，未产生半成品`);
      continue;
    }
    // 写盘后**立刻**校验语法：坏了就用刚做的备份回滚。以前只有收尾时那道全局校验，
    // 坏了只打印一行 ✗，磁盘上的半成品留着（独立验证报出）。
    try {
      execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    } catch (error) {
      copyFileSync(backup, path);
      // 这里**不能** written.pop()：本文件还没 push（失败发生在 push 之前），
      // pop 会把上一个已写成功文件从记录里抹掉，汇总就少报一个文件。
      bad(`${file}：写入后语法校验失败，已从备份回滚（${String(error.stderr || error.message).split('\n')[0]}）`);
      continue;
    }
    written.push(file);
    ok(`${file}：写入 ${missing.length} 处补丁${already.length > 0 ? `（另 ${already.length} 处本就已接入，未重复打）` : ''}（备份 ${backup.split('/').pop()}）`);
    pending += missing.length;
  }
  return written;
}

/** 反向撤销：replacement → anchor（回滚走这条路，不依赖备份文件）。 */
function revertPlan() {
  const written = [];
  for (const [file, entries] of PLAN) {
    const path = join(STATS, file);
    let source = readFileSync(path, 'utf8');
    const applied = entries.filter((entry) => source.includes(entry.replacement)
      || (Array.isArray(entry.aliases) && entry.aliases.some((alias) => source.includes(alias))));
    if (applied.length === 0) { ok(`${file}：没有本工具的补丁，跳过`); continue; }
    if (!APPLY) { pending += applied.length; log(`  · ${file}：${applied.length} 处补丁待撤销`); continue; }
    REVERT_BEFORE.set(file, source);
    for (const entry of applied) {
      source = source.split(entry.replacement).join(entry.anchor);
      for (const alias of entry.aliases || []) source = source.split(alias).join(entry.anchor);
    }
    const backup = backupOf(path, 'revert');
    copyFileSync(path, backup);
    writeFileSync(path, source, 'utf8');
    written.push(file);
    ok(`${file}：撤销 ${applied.length} 处补丁（备份 ${backup.split('/').pop()}）`);
  }
  return written;
}

/* ------------------------------------------------------------ 补丁 ---- */

log(`目标：${STATS}`);
log(`模式：${APPLY ? 'APPLY（会写盘）' : 'CHECK（只检查）'}${COPY === null ? '' : ' 副本演练'}`);

log('\n[1/6] fold.js —— 分桶、选项、行输出');
patch('fold.js', { name: 'opts 声明 groupOf/未分组桶' },
`export function aggregate(sessions, opts = {}) {
  const by = opts.by || 'model';
  const tz = opts.timeZone || 'UTC';
  const weekStart = Number.isFinite(opts.weekStart) ? opts.weekStart : 1;
  const fromKey = opts.fromKey || null;
  const toKey = opts.toKey || null;
  const root = opts.attributeSubagents === 'root';
`,
`export function aggregate(sessions, opts = {}) {
  const by = opts.by || 'model';
  const tz = opts.timeZone || 'UTC';
  const weekStart = Number.isFinite(opts.weekStart) ? opts.weekStart : 1;
  const fromKey = opts.fromKey || null;
  const toKey = opts.toKey || null;
  const root = opts.attributeSubagents === 'root';
  // ${MARK}：分组维度。opts.groupOf(provider, model) → 组 id（查询时解析，
  // 事实里不落组名）；缺省（或返回 null）归入未分组桶。
  const groupOf = typeof opts.groupOf === 'function' ? opts.groupOf : null;
  const ungroupedKey = typeof opts.ungroupedKey === 'string' && opts.ungroupedKey !== '' ? opts.ungroupedKey : '__ungrouped__';
  const groupLabels = opts.groupLabels !== null && typeof opts.groupLabels === 'object' ? opts.groupLabels : null;
  const ungroupedLabel = typeof opts.ungroupedLabel === 'string' && opts.ungroupedLabel !== '' ? opts.ungroupedLabel : '未分组';
`);

patch('fold.js', { name: 'by=group 分桶' },
`      if (by === 'model') key = f.m;
      else if (by === 'provider') key = f.p;
      else if (by === 'session') key = sid;
      else if (by === 'day') key = dk;
      else key = weekKey(dk, weekStart);`,
`      if (by === 'model') key = f.m;
      else if (by === 'provider') key = f.p;
      else if (by === 'group') key = (groupOf === null ? null : groupOf(f.p, f.m)) || ungroupedKey;
      else if (by === 'session') key = sid;
      else if (by === 'day') key = dk;
      else key = weekKey(dk, weekStart);`);

patch('fold.js', { name: 'by=group 计入 sessions 去重' },
`      if (by === 'model' || by === 'provider' || by === 'week' || by === 'day') {`,
`      if (by === 'model' || by === 'provider' || by === 'group' || by === 'week' || by === 'day') {`);

patch('fold.js', { name: 'by=group 行输出（label/ungrouped/providers）' },
`      out.sessions = seenSessions.has(row.key) ? seenSessions.get(row.key).size : 0;
      if (row.providers && by === 'model') out.providers = [...row.providers];
      if (row.kinds && by !== 'session') out.kinds = row.kinds;`,
`      out.sessions = seenSessions.has(row.key) ? seenSessions.get(row.key).size : 0;
      if (row.providers && (by === 'model' || by === 'group')) out.providers = [...row.providers];
      if (row.kinds && by !== 'session') out.kinds = row.kinds;
      if (by === 'group') {
        out.ungrouped = row.key === ungroupedKey;
        out.label = out.ungrouped ? ungroupedLabel : ((groupLabels !== null && groupLabels[row.key]) || row.key);
      }`);

log('\n[2/6] fold.js —— 文档注释');
patch('fold.js', { name: 'opts 文档补 group' },
` * opts: { by, fromKey, toKey, timeZone, weekStart, attributeSubagents }`,
` * opts: { by, fromKey, toKey, timeZone, weekStart, attributeSubagents,
 *         groupOf, groupLabels, ungroupedKey, ungroupedLabel }   // by=group 用`);

log('\n[3/6] index.js —— by 白名单与未分组常量');
// 一处补丁把白名单与常量一起落（分两步会在 CHECK 模式下因先行补丁未落而误报锚点缺失）。
patch('index.js', { name: "BY 允许 'group' + 未分组桶常量" },
`const BY = ['model', 'provider', 'session', 'day', 'week'];`,
`const BY = ['model', 'provider', 'group', 'session', 'day', 'week'];
/** by=group 的未分组桶键（与 dsh-model-groups/client.js 同常量）。 */
const UNGROUPED_KEY = '__ungrouped__';
const UNGROUPED_LABEL = '未分组';`);

log('\n[4/6] index.js —— 分组解析与聚合');
patch('index.js', { name: 'groupService/groupResolver（惰性可选依赖）' },
`  function summaryPayload(searchParams) {`,
`  // ${MARK}：分组维度（可选依赖）。服务来自 dsh-model-groups；插件不在线时
  // 一律返回 null → 整个维度退化为单个「未分组」行（接口不报错、不改行为）。
  // 每次查询现取，插件热重载/后挂载都能跟上。
  function groupService() {
    try {
      const service = ctx.get('modelGroups');
      return service !== undefined && typeof service.resolve === 'function' ? service : undefined;
    } catch {
      return undefined;
    }
  }

  function groupResolver() {
    const service = groupService();
    if (service === undefined) return null;
    const labels = {};
    try {
      for (const group of service.list()) labels[group.id] = group.name || group.id;
    } catch { /* 名字拿不到不影响分桶 */ }
    return {
      labels,
      of: (provider, model) => {
        try {
          const hit = service.resolve(provider, model);
          return hit === null || hit === undefined ? null : hit.groupId;
        } catch {
          return null;
        }
      },
    };
  }

  function summaryPayload(searchParams) {`);

patch('index.js', { name: 'summaryPayload 传 groupOf' },
`    const result = aggregate(buildSessions(), {
      by, fromKey, toKey, timeZone: zone, weekStart: opt.weekStart, attributeSubagents: subagents,
    });`,
`    const groupIndex = by === 'group' ? groupResolver() : null;
    const result = aggregate(buildSessions(), {
      by, fromKey, toKey, timeZone: zone, weekStart: opt.weekStart, attributeSubagents: subagents,
      groupOf: groupIndex === null ? null : groupIndex.of,
      groupLabels: groupIndex === null ? null : groupIndex.labels,
      ungroupedKey: UNGROUPED_KEY,
      ungroupedLabel: UNGROUPED_LABEL,
    });
    if (by === 'group') result.ungroupedKey = UNGROUPED_KEY;`);

log('\n[5/6] index.js —— status 接线自检');
patch('index.js', { name: 'status 回报分组可用性' },
`      facts: { log: s.logFacts, aux: s.auxFacts, total: s.logFacts + s.auxFacts },`,
`      facts: { log: s.logFacts, aux: s.auxFacts, total: s.logFacts + s.auxFacts },
      groups: (() => {
        const service = groupService();
        if (service === undefined) return { available: false, groups: 0, ungroupedKey: UNGROUPED_KEY };
        try { return { available: true, groups: service.list().length, ungroupedKey: UNGROUPED_KEY }; } catch { return { available: true, groups: 0, ungroupedKey: UNGROUPED_KEY }; }
      })(),`);

log('\n[6/6] client.js —— 页签、文案、能力自检');
patch('client.js', { name: 'TABS 增加分组' },
`      { by: 'provider', label: '供应商' },
      { by: 'session', label: '会话' },`,
`      { by: 'provider', label: '供应商' },
      { by: 'group', label: '分组' },
      { by: 'session', label: '会话' },`);

patch('client.js', { name: 'dimName 增加分组' },
`      const dimName = by === 'model' ? '模型' : by === 'provider' ? '供应商' : by === 'session' ? '会话' : by === 'day' ? '每日用量' : '每周用量';`,
`      const dimName = by === 'model' ? '模型' : by === 'provider' ? '供应商' : by === 'group' ? '分组' : by === 'session' ? '会话' : by === 'day' ? '每日用量' : '每周用量';`);

patch('client.js', { name: '表头增加分组' },
`            h('th', { className: 'l' }, by === 'day' ? '日期' : by === 'week' ? '周起始' : '键'),`,
`            h('th', { className: 'l' }, by === 'day' ? '日期' : by === 'week' ? '周起始' : by === 'group' ? '分组' : '键'),`);

patch('client.js', { name: '分组行的副标题（供应商 / 未分组）' },
`                : h('div', { className: 'ust-meta' },
                    row.model ? row.model : (row.providers ? row.providers.join(', ') : '')),`,
`                : h('div', { className: 'ust-meta' },
                    by === 'group'
                      ? (row.ungrouped === true ? '未命中任何分组' : (row.providers ? '供应商：' + row.providers.join(', ') : ''))
                      : (row.model ? row.model : (row.providers ? row.providers.join(', ') : ''))),`);

patch('client.js', { name: '能力自检提示（统计侧未接入时说明原因）' },
`        error !== null ? h('div', { className: 'ust-error' }, error) : null,`,
`        error !== null ? h('div', { className: 'ust-error' }, error) : null,
        (data !== null && typeof data.by === 'string' && data.by !== by)
          ? h('div', { className: 'ust-error' }, '统计插件返回的维度是「' + data.by + '」而不是「' + by + '」——说明运行中的 host 半边还没接入该维度（改源码后需重启 dsh，或用 stats-integration.mjs --live 重新热挂）。')
          : null,`,
// 旧版补丁的**完整替换文本**（entry-v2 时代已落盘的那份）：算作同一处补丁的已接入
// 形态，撤销时按 alias → anchor 还原。必须是完整替换文本而不是其中一行——否则会把
// anchor 行复制成两行（副本演练踩过）。
{ aliases: [
  // v2 时代的文案
  `        error !== null ? h('div', { className: 'ust-error' }, error) : null,
        (data !== null && typeof data.by === 'string' && data.by !== by)
          ? h('div', { className: 'ust-error' }, '统计插件返回的维度是「' + data.by + '」而不是「' + by + '」——说明运行中的 host 半边还没接入该维度（改源码后需重启 dsh，或用 stats-integration.mjs --live 热挂 entry-v2）。')
          : null,`,
  // v3 时代（内插 ENTRY，bump 入口名后会变）——留着就不必再改历史文件
  `        error !== null ? h('div', { className: 'ust-error' }, error) : null,
        (data !== null && typeof data.by === 'string' && data.by !== by)
          ? h('div', { className: 'ust-error' }, '统计插件返回的维度是「' + data.by + '」而不是「' + by + '」——说明运行中的 host 半边还没接入该维度（改源码后需重启 dsh，或用 stats-integration.mjs --live 热挂 entry-v3.js）。')
          : null,`,
] });

/* -------------------------------------------------------- 热挂/回滚 ---- */

log('\n[附] 热挂（--live / --unlive）');

const entryPath = join(STATS, ENTRY);
function patchRowName(from, to) {
  if (COPY !== null) { bad('--copy 演练禁止改 patch 行（--live/--unlive 只能对真实 profile 用）'); return; }
  if (!existsSync(PATCH_FILE)) { bad(`${PATCH_FILE} 不存在`); return; }
  const source = readFileSync(PATCH_FILE, 'utf8');
  const anchor = `    - id: usage-stats\n      name: ${from}`;
  const target = `    - id: usage-stats\n      name: ${to}`;
  if (source.includes(target)) { ok(`patch 行 name 已是 ${to}`); return; }
  const hits = source.split(anchor).length - 1;
  if (hits !== 1) { bad(`patch 行锚点匹配 ${hits} 次（应为 1）`); return; }
  if (!APPLY) { pending += 1; log(`  · patch 行 name 待改为 ${to}`); return; }
  copyFileSync(PATCH_FILE, backupOf(PATCH_FILE, TAG));
  writeFileSync(PATCH_FILE, source.replace(anchor, target), 'utf8');
  ok(`patch 行 name：${from} → ${to}`);
}

const WANT_LIVE = hasFlag('--live');
const WANT_UNLIVE = hasFlag('--unlive');
const WANT_REVERT = hasFlag('--revert');

// ?v= 版本标记**永远**登记（不再只在 --live/--revert 下）：它们是「整张图换新实例」的
// 前提，而默认 CHECK / 不带 --live 的 --apply 以前完全不看它们——标记全缺时也会打印
// all patches in place（独立验证报出的静默缺口）。标记本身对未热挂的树无害。
{
  // 热挂必须给**整张图**打版本标记：loader 按 specifier 缓存模块，只标 index.js 的话
  // 它 import 的 store.js / rawlog.js（以及 store.js 再 import 的 fold.js）仍是旧实例
  // ——v2 就踩过这个坑：只标了 index.js/fold.js，结果同事随后对 index.js+store.js 的
  // 改动被旧缓存实例永久挡住（线上静默跑旧代码）。--revert 同样要撤干净这四处。
  // 替换串**不带尾注释**：带注释的话「去掉标记再打回来」会把注释叠成两份（副本演练踩过）。
  patch('index.js', { name: `fold 导入带 ?v=${TAG}` },
    `} from './fold.js';`,
    `} from './fold.js?v=${TAG}';`);
  patch('index.js', { name: `store 导入带 ?v=${TAG}` },
    `import { FactStore, msg } from './store.js';`,
    `import { FactStore, msg } from './store.js?v=${TAG}';`);
  patch('index.js', { name: `rawlog 导入带 ?v=${TAG}` },
    `} from './rawlog.js';`,
    `} from './rawlog.js?v=${TAG}';`);
  patch('store.js', { name: `store→fold 导入带 ?v=${TAG}（与 index.js 共用同一实例）` },
    `import { createFoldState } from './fold.js';`,
    `import { createFoldState } from './fold.js?v=${TAG}';`);
}

if (WANT_LIVE && COPY !== null) bad('--copy 演练不能与 --live 同时用（那是真实 profile 的操作）');
if (!WANT_LIVE && !WANT_UNLIVE && !WANT_REVERT) log('  （未指定 --live / --unlive / --revert：跳过）');

/* ------------------------------------------------- 落盘、校验、收尾 ---- */

log('\n落盘：');
const written = WANT_REVERT ? revertPlan() : flushPlan();

const SHIM = `/**
 * 统计插件热挂入口（由 dsh-model-groups 的 stats-integration.mjs --live 生成）。
 * 注意：TAG 一变就要换新文件名（${ENTRY} ↔ ${TAG}），否则新图仍会拿到缓存里的旧 index.js。
 *
 * 本 profile 未开模块热载、loader 按 specifier 缓存模块，原地改 index.js 不会重新
 * 求值。本文件以 \`?v=${TAG}\` 重新求值 index.js，而**整张图**的下游 import 都带
 * 同一标记（index.js → fold.js / store.js / rawlog.js，store.js → fold.js），
 * 于是新图里没有一个是旧实例；patch 行仍用同一 id（usage-stats），loader 走
 * dispose→start，不会出现重复路由。回滚：--unlive（name 指回 ./index.js）
 * 或 --revert（把补丁整体撤掉）。
 */
export * from './index.js?v=${TAG}';
`;
// 语法校验必须排在 --live 切换**之前**：门禁只看此刻累计的 problems，
// 否则「补丁就位 + 某核心文件本来就语法坏」会先把 patch 行切到 ENTRY 再报错。
log('\n语法校验：');
for (const file of new Set(['index.js', 'fold.js', 'client.js'].concat(APPLY ? written : []))) {
  const path = join(STATS, file);
  if (!existsSync(path)) continue;
  try {
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    ok(`${file} 语法通过`);
  } catch (error) {
    bad(`${file} 语法错误：${String(error.stderr || error.message).split('\n').slice(0, 3).join(' ')}`);
  }
}

if (WANT_LIVE && COPY === null && problems > 0) {
  bad(`补丁计划有 ${problems} 处问题：本轮**不**改写热挂入口与 patch 行（避免把运行实例切到半成品上）`);
} else if (WANT_LIVE && COPY === null) {
  // CHECK 模式也要说真话：entry 与 patch 行都可能**已经**就位（重复跑本工具是常态），
  // 无条件记 2 处待处理会让人以为线上还没热挂。
  // 入口文件只要**指向同一 TAG** 就算就位：entry-v7.js 是手写入口（带改动说明），
  // 内容与模板不同但完全等价，不能因此被模板覆盖掉。
  const entryText = existsSync(entryPath) ? readFileSync(entryPath, 'utf8') : null;
  const entryReady = entryText !== null && entryText.includes(`?v=${TAG}`);
  if (!APPLY) {
    if (entryReady) ok(`${ENTRY} 已是本版热挂入口`);
    else { pending += 1; log(`  · ${ENTRY} 待写入`); }
    patchRowName('./plugins/dsh-usage-stats/index.js', './plugins/dsh-usage-stats/' + ENTRY);
  } else {
    if (entryReady) ok(`${ENTRY} 内容已是本版（未改写）`);
    else { writeFileSync(entryPath, SHIM, 'utf8'); ok(`${ENTRY} 已写入`); }
    patchRowName('./plugins/dsh-usage-stats/index.js', './plugins/dsh-usage-stats/' + ENTRY);
  }
} else if (WANT_UNLIVE || (WANT_REVERT && COPY === null)) {
  // 撤销补丁时顺手把 patch 行指回 index.js：否则行还挂着热挂入口（能跑，但没有意义）。
  patchRowName('./plugins/dsh-usage-stats/' + ENTRY, './plugins/dsh-usage-stats/index.js');
  log(`  · ${ENTRY} 可留可删（不再被引用后无副作用）`);
}


if (WANT_REVERT && APPLY) {
  log('\n撤销结果核对：');
  for (const file of ['index.js', 'fold.js', 'client.js', 'store.js', 'rawlog.js']) {
    const text = readFileSync(join(STATS, file), 'utf8');
    // token 扫描只是粗筛（残留代码仍在时也可能通过某些写法）。
    const left = text.split('groupOf').length - 1 + text.split('UNGROUPED_KEY').length - 1 + text.split("by === 'group'").length - 1;
    const tags = text.split(`?v=${TAG}`).length - 1;
    // 真凭据用**往返校验**：把本工具的补丁按原样重打在撤销结果上，必须逐字节复现撤销前的文本。
    // 以前拿「最老的备份」当真凭据，可那份备份本身可能是中途态（生产树就是：
    // 14:02 的备份里已含分组代码 → 干净回滚被误报成「不逐字节相同」+ FAIL，横幅永远打不出来）。
    const plan = PLAN.get(file) || [];
    const before = REVERT_BEFORE.get(file);
    const roundTrip = before === undefined ? null : (() => {
      let again = text;
      for (const entry of plan) again = again.replace(entry.anchor, entry.replacement);
      return again === before;
    })();
    if (left === 0 && tags === 0 && roundTrip !== false) {
      ok(`${file} 已无分组维度残留` + (roundTrip === true ? '（往返校验：重打一次可逐字节复现撤销前文本）' : '（无撤销前快照，仅 token 核对）'));
    } else {
      bad(`${file} 仍有 ${left} 处分组维度痕迹${tags > 0 ? `、${tags} 处 ?v=${TAG} 标记` : ''}`
        + (roundTrip === false ? '；**往返校验不一致**（撤销结果与补丁模型对不上）' : ''));
    }
  }
}

log('');
if (problems > 0) {
  log(`INTEGRATION FAIL（${problems} 处问题）`);
  process.exitCode = 1;
} else if (WANT_REVERT && APPLY) {
  log('INTEGRATION REVERTED（统计插件**磁盘**已回到未接入分组维度的状态）');
  // 运行实例不会重读磁盘：loader 按 specifier 缓存模块，把 patch 行指回 ./index.js 之后
  // start 的是**进程启动时**求值的那一份（独立验证用真实 loader 复现过）。用 log 而不是
  // bad：磁盘撤销本身成功，不该把退出码判成失败；但这句必须显眼。
  log('');
  log('  ⚠ 注意：运行中的 dsh 不会自动回到这版代码——要让撤销在运行实例生效需重启 dsh；');
  log('    若只是想换实现，请再跑一次 --live（会写新的 entry 文件名，bump TAG）。');
} else if (!APPLY && pending > 0) {
  log(`INTEGRATION CHECK：${pending} 处待处理（加 --apply 落盘）`);
} else {
  log(APPLY ? 'INTEGRATION APPLIED (all patches in place)' : 'INTEGRATION CHECK PASS (all patches in place)');
}
