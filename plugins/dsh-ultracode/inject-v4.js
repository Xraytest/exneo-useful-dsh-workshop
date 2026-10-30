/**
 * dsh-ultracode —— Claude Code「ultracode / ultra 思考强度」的 DSH 静态还原。
 * host 半边 **v4：家族共用的选择落盘**（2026-10-09）。
 *
 * 逆向对象：claude-code 2.1.287（linux-arm64，sha256
 * e4daf793d1e74fb0d9874dd09e98690bbfd7be515f78a87fd05b9e2b4bb33b03，
 * 取自自带分发服务 claude-code-releases/2.1.287/manifest.json）。
 *
 * 原实现（bundle 内符号 → 本文件对应）：
 *   nu           ["low","medium","high","xhigh","max"]      思考强度阶梯
 *   z            {med:"medium"}                             拼写别名
 *   q            {ultracode:"xhigh"}                        特殊档别名
 *   Arr          {TURNS_BETWEEN_MAINTENANCE:10}             稀疏重申阈值缺省
 *   tjt(state)   state.ultracode === true                   会话是否已开
 *   hx(model)    nm() && (model===undefined || SXe(model))   可用性闸
 *   nm()         动态工作流总开关（managed settings / disableWorkflows）
 *   SXe(model)   模型是否声明 xhigh_effort 能力
 *   BE(on,model) on === true && hx(model)                   生效判定
 *   usr(history) 附件状态机：full / sparse / exit            （见「设计变更」）
 *   Prr()        阈值解析（env → 配置 → 缺省 10，夹到 >=1 整数） （见「设计变更」）
 *   dsr(e)       ultrathink 关键字 → ultrathink_effort 附件（另一条线，未还原）
 *
 * 三条提醒文本逐字取自 bundle（attachment 渲染分支，均带 isMeta:!0）：
 *   ultra_effort_enter(full)   Ultracode is on: …
 *   ultra_effort_enter(sparse) Ultracode is still on — …
 *   ultra_effort_exit          Ultracode is off — …
 *
 * 设计变更（2026-10-03，用户指令：**关闭时不展示，开启后直接注入、不用模型调用**）：
 *   首版照搬原实现的「周期性注入元消息」，实测**不能有效改变模型行为**。根因两条：
 *     ① DSH 的 dsh-tool-workflow 注册了系统提示段 `tool:workflow`，正文写着
 *        「Use the workflow tool ONLY when the user explicitly asks…」——与本机制
 *        正面冲突，且它在系统提示里、每个请求都在场，一条历史消息赢不了它；
 *     ② 原提醒结尾指向「the **Ultracode** section and quality patterns in the
 *        workflow authoring reference」，而 DSH 两者都不存在 —— 空指针。
 *   现在改为**装配期直注**：开启即在系统提示里注入 Ultracode 段，并把
 *   `tool:workflow` 段就地换成 ultracode 感知版；关闭则一个字都不注入。
 *   代价是原实现的稀疏重申状态机（usr/Prr）不再是运行路径，其事实保留在
 *   ORIGINAL_EFFORT_MODEL / ORIGINAL_REMINDERS 快照里，仅由自测钉值。
 *
 * 设计变更（2026-10-09，用户指令：**持久化会话是否启用 ultracode 选择，不在重启后失效**）：
 *   上一版把会话态只放在内存 Map 里（照抄原实现自述的 "interactive toggles never
 *   persist it"），于是 dsh 进程一重启，输入框那颗胶囊就回到熄灭态，用户必须重新点亮。
 *   现在把**该会话的选择**落盘到 `$DSH_HOME/ultracode.json`，重启（含 systemd 重启
 *   dsh-web、会话被重新恢复）后按下列规则原样重建：
 *     ① 盘上有本会话记录 → 按记录重建（status.restored=true）；**预置不再覆盖它**
 *        （用户对某会话的显式选择高于进程级缺省，否则每次重启都会把用户的手动关闭
 *        又打开 —— 那正是本次要修的那类失效）；
 *     ② 没有记录 → 按预置（DSH_ULTRACODE / 行配置 provision）开局；预置也没有 →
 *        这个会话完全不管，装配期逐字节直通（与上一版一致，零开销）；
 *     ③ `/reset` **连盘上记录一起抹掉**，回到预置开局；否则重启会把 reset 掉的选择
 *        又恢复回来（reset 的语义是「抹掉本会话交互态」）。
 *   记录同时保存 `phase`：原实现的进入/退出是从**会话历史**里回扫出来的
 *   （s ∈ {none, enter, exit}），而历史是持久化的 —— 所以把 phase 一起落盘才是
 *   对原实现的忠实还原（退出闩锁同样跨重启存活）。
 *   `agent/disposed` 只清内存态、**不删记录** —— 「重启后不失效」的落点正在这里。
 *   落盘时机：只在 `/set` 与 `/reset`（人点一下开关）时同步原子写；装配期零 I/O、
 *   不写任何会话消息、不动模型调用配置。
 *   多进程纪律与 dsh-user-keep-compaction / dsh-model-groups 同款（写前先重读、
 *   合并盘上条目、tmp + rename 原子换名），并对**删除**也比同款多走一步。合并规则
 *   一句话：**盘上文件是共识，本进程刚改但还没写成功的条目优先，其余盘上说了算**
 *   ——
 *     ① 盘上有、内存没有 → 补进来（别的进程写的）；
 *     ② 本进程删过 → 不补（否则盘上旧值会复活刚 reset 掉的记录）；
 *     ③ 内存有、盘上没有、且本进程没改过它 → 跟着删（别的进程 reset 掉了；少了
 *        这一步，本进程下一次整表回写会把它复活 —— 跨进程 reset 失效）。
 *   逐会话记录 dirty（本进程改过但没写成功的），所以「已落盘」是**按会话**判断的：
 *   会话 A 写成功、会话 B 写失败时，A 不会跟着被报成未落盘。
 *   **不做封顶/淘汰**（同 dsh-user-keep-compaction）：一条记录约 120 字节，而
 *   「悄悄丢一条记录」正好就是本次要修的那类静默失效，用户的选择宁可一直留着。
 *   失败一律降级：坏文件、写不进去都不影响系统提示装配与 HTTP 路由；原因同时走
 *   ctx.logger?.warn?（本部署有状态插件的统一告警通道：user-keep-compaction /
 *   model-groups / message-branches 都走它）与 status.storeError（绝不静默）。
 *
 * 设计变更（2026-10-09 追加，用户指令：**需要继承，并且修改影响全部分支与前端上下文**）：
 *   用户口径定为**家族共用**（三选一里选的正是「一条分支上改，全部分支一起变」）：
 *   ultracode 不是「一个会话一个选择」，而是**一个血脉一个选择** —— 主线与它 fork／
 *   分叉出来的全部分支共享同一条记录，在哪条分支上点亮/熄灭，整族一起变；重启之后
 *   这条关系与这条选择都还在。落盘形状随之升到 version 2：
 *     { version: 2,
 *       families: { 子会话 id → 家族根 id },        // 家谱（只记非根本）
 *       sessions: { 家族根 id → {enabled, phase, decidedAt} } }
 *   家族根怎么找（顺序即权威性，三者共用一个 rootOf()）：
 *     ① 盘上家谱记着的归属（**父会话没被恢复也照样认得**，这是跨重启的关键）；
 *     ② 顺着父指针往上走：装配期直接用 `agent.session.header.parentSession`
 *        （零查询、零 I/O），路由期问 `sessions` 服务要活会话的 header；
 *     ③ 消息分支（dsh-message-branches）自己的账本 groups.json —— 它那条**空白分支**
 *        是 sessions.create 出来的、header 里没有父指针，出厂谱系在这一跳是断的，
 *        只有它的账本能补上（只读旁证，读不到就当没有）；
 *     ④ 都没有 → 自己就是家族根。
 *   归属的固化点有三处，都只写「家谱」不写「选择」：
 *     · `session/created`（**主挂点**）：唯一在子会话诞生瞬间就带着父指针的事件，
 *       此刻父会话必定还活着 → 同步落盘一次。⚠ 该事件的监听者同步抛错会**否决会话
 *       创建并回滚**，所以这里全程 try/catch、绝不 await、失败只告警；
 *     · 装配期（`agent` 顺手带进来的父指针）：只在内存里解析，**不写盘**；
 *     · `/status`（浏览器每 8s 拉一次）：发现新亲戚时补写一次（同值不重复写）。
 *   传播：**不推送**。任何会话下一次 `stateOf` 都会拿家族记录对一次账（开关或 phase
 *   不一致就跟上、并复位本会话的注入标记），所以「分支上一点、主线下一次装配就变」
 *   与「胶囊下次刷新就变」都是这条对账的结果（telemetry.syncs 记的就是它）。
 *   继承的边界（**刻意如此**）：继承的是**记录**，不是「父还活着」—— 父从没点过开关
 *   时，子会话不会凭空变成开启（仍按预置开局）；`/reset` 是**整族**的（记录抹掉、家谱
 *   保留）；子代理会话带 parentSession，因此**也会继承**父会话的开关（同一个血脉同一
 *   种工作方式，是有意识的选择，不是碰巧）。
 *   不覆盖：导入的会话（不经过 store、不发事件，根会话的 parentSession 被导入器丢弃）、
 *   以及既没有父指针又不在消息分支账本里的空白会话 —— 这两种都只能自成一家。
 *   前端上下文：statusView 增报 family / familyRoot / branches；胶囊 title 相应说明
 *   「全家族共用／另有 N 条分支／在此改动会同时影响全部分支」。切会话时胶囊会按
 *   sessionId 重新挂载（DSH 渲染器的既定行为），所以切进一条继承来的分支必然重新拉
 *   /status；首帧「还没读到」另走中性态（虚线 + 慢呼吸），不再以熄灭的姿态定帧。
 *   回归：host 自测 §29–§39（fork 继承／一次落盘形状／分支改主线跟／孙代／父无记录不
 *   凭空开／冷启动只有分支／空白分支靠账本／reset 整族／session/created 绝不外抛／
 *   旧 v1 文件仍可读／未知版本按坏文件）；客户端自测补中性态与家族 title 两组。
 *
 * 交接方式（**重要**）：host 半边按 Loader specifier 缓存，**改同名文件本体不会热生效**
 *   —— 本机 2026-10-09 实测：改了 patch 文件触发 live reload 之后，进程里跑的仍是旧
 *   代码。所以每次改 host 半边都要换**新文件名**（inject.js → inject-v2.js →
 *   inject-v3.js → inject-v4.js），再把 cordis.patch.yml 里那一行的 `name` 指过来即热生效
 *   （本 profile patchReload=live）。
 *   版本留档：inject.js = 最初的内存版（上一版，原样留着可随时回滚）；inject-v2.js =
 *   落盘改动的第一个版本，同一会话里又被对抗复核改过内容（必须换名才能生效），已由
 *   v3 取代并删除；inject-v3.js = per-session 落盘版（已验证通过，保留作回滚目标）；
 *   本文件 = 家族共用版。
 *   回归：`node plugins/dsh-ultracode/selftest.mjs`（含「新建实例 = 新进程」的恢复用例
 *   与 §29–§39 的家族用例）、`node plugins/dsh-ultracode/client-selftest.mjs`。
 *
 * 与原实现的对应关系（DSH 侧映射）：
 *   appState.ultracode  → 本插件按**家族**（会话谱系根）持有的状态；盘上有记录则以其为准
 *                         （$DSH_HOME/ultracode.json，见「设计变更 2026-10-09」两节）
 *   注入点              → system-prompt/assemble waterfall（装配期直注）
 *   模型路由            → agent/request waterfall（只读旁听，不改路由）
 *   /effort ultracode   → 输入框工具行的「点亮/熄灭」开关（./client.js）+ 本半边 HTTP 路由
 *
 * 思考强度（**硬约束，用户指令**）：
 *   ultracode **不得限制模型的思考强度**。本插件因此在所有路径上都不写
 *   `LlmCallConfig.reasoningEffort`：不改写、不下调、不上调、不封顶；开启
 *   ultracode 对强度是**零影响**（EFFORT_POLICY = 'untouched'）。原实现里
 *   `q={ultracode:"xhigh"}` 那张别名表只作逆向记录（ORIGINAL_EFFORT_MODEL），
 *   不施加。开关 title 里显示的强度取自会话真实路由值，不是本插件期望值。
 *
 * 刻意不还原的部分（DSH 无对应物，或属于 Claude Code 私有面）：
 *   - Workflow 工具本体（DSH 自带 workflow 工具；其提示段已按原文语义改写，
 *     见 ultracodeToolText；工具实现本身不复制）；
 *   - tengu_* 遥测（改为进程内计数，经 /dsh-ultracode/status 暴露）；
 *   - dynamic-workflows spinner tip（原实现已移除该视觉）；
 *   - ultrathink 关键字线（ultrathink_effort）—— 与 ultracode 是两条独立机制；
 *   - 原实现的 ultracode→xhigh 别名施加与 p4/T 的强度夹取（按硬约束放弃）。
 *
 * @module dsh-ultracode
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';

/** webServer 是硬依赖：浏览器半边全靠它回传状态。 */
export const inject = ['webServer'];

// ── 原实现常量（逐字） ──────────────────────────────────────────────────────

/** `nu`：思考强度阶梯（**仅记录**原实现事实）。 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** `z`：拼写别名（**仅记录**）。 */
const EFFORT_SPELLINGS = { med: 'medium' };

/**
 * `q`：特殊档别名（**仅记录**）—— 原实现里 `ultracode` 这个名字曾等于 `xhigh`。
 *
 * ⚠ 本插件**不施加**这张表。用户要求：ultracode 不得限制模型的思考强度。
 * 因此这里既不把会话强度改写成 xhigh，也不给它设上限；思考强度完全由模型
 * 路由与用户设置决定，本插件只读不写（见 statusView 的 effortPolicy）。
 * 导出的 ORIGINAL_EFFORT_MODEL 只供自测钉住逆向事实，不参与运行行为。
 */
const EFFORT_ALIASES = { ultracode: 'xhigh' };

/** `Arr.TURNS_BETWEEN_MAINTENANCE`：稀疏重申的缺省间隔（用户轮次）。 */
const TURNS_BETWEEN_MAINTENANCE = 10;

/**
 * 逆向事实快照（供自测断言，不参与运行行为）。
 * 对应 bundle 内 `nu` / `z` / `q` / `Arr` 四个符号。
 */
export const ORIGINAL_EFFORT_MODEL = Object.freeze({
  ladder: Object.freeze([...EFFORT_LEVELS]),
  spellings: Object.freeze({ ...EFFORT_SPELLINGS }),
  aliases: Object.freeze({ ...EFFORT_ALIASES }),
  turnsBetweenMaintenance: TURNS_BETWEEN_MAINTENANCE,
});

/**
 * 思考强度策略：**untouched**。
 *
 * 本插件在任何路径上都不写 `LlmCallConfig.reasoningEffort`：
 *   - `agent/request` 只旁听（把 next() 的结果按**同引用**原样 return）；
 *   - 注入发生在 `system-prompt/assemble`（只改 sections），与调用配置无关；
 *   - `/dsh-ultracode/*` 路由不暴露任何强度写入面。
 * 即：开启 ultracode 既不下调、也不上调、更不封顶模型的思考强度。
 */
const EFFORT_POLICY = 'untouched';

/** 三条提醒正文（bundle 内 attachment 渲染分支，逐字，含 U+2014）。 */
const REMINDERS = {
  full:
    'Ultracode is on: optimize for the most exhaustive, correct answer \u2014 not the fastest or cheapest. '
    + 'Use the Workflow tool on every substantive task; token cost is not a constraint. '
    + 'See the **Ultracode** section and quality patterns in the workflow authoring reference. '
    + 'Solo only on conversational/trivial turns.',
  sparse:
    'Ultracode is still on \u2014 use the Workflow tool; '
    + 'see the Ultracode section of the workflow authoring reference.',
  exit:
    "Ultracode is off \u2014 the Workflow tool's standard opt-in rule applies again.",
};

/**
 * 三条提醒原文快照（供自测钉值）。运行路径只用 `full`（派生 Ultracode 段正文），
 * `sparse` / `exit` 对应的稀疏重申与退出提醒已随「装配期直注」改版退出运行路径。
 */
export const ORIGINAL_REMINDERS = Object.freeze({ ...REMINDERS });


const ROUTE_PREFIX = '/dsh-ultracode';

// ── 持久化：家族级选择的落盘存储 ────────────────────────────────────────────
//
// 与 dsh-user-keep-compaction（$DSH_HOME/user-keep-compaction.json）、
// dsh-model-groups（$DSH_HOME/model-groups.json）同一套纪律，便于运维统一理解：
//   $DSH_HOME/ultracode.json
//   { "version": 2,
//     "families": { "session-<子>": "session-<家族根>" },          // 家谱（只记非根本）
//     "sessions": { "session-<家族根>": { "enabled": true,        // 一个家族一条开关
//                                         "phase": "enter",
//                                         "decidedAt": 1791534284000 } } }
// 只存「人做过的选择」；从未点过开关、也没有预置的家族不占条目。
// version 1 的旧文件（只有 sessions、每个键各自成家）照常读得进来，语义等价。

/** 落盘格式版本（自测钉值；将来改形状时按它迁移）。2 = 家族表 + 家谱表。 */
const STATE_VERSION = 2;
/** 还能照常读取的历史格式版本（1 = 按会话一条记录的旧文件，每个键视作各自成家）。 */
const READABLE_STATE_VERSIONS = new Set([1, 2]);
/** 合法 phase 取值（对应原实现从历史回扫出的 s ∈ {none, enter, exit}）。 */
const PHASES = new Set(['none', 'enter', 'exit']);
// 不设封顶、不做淘汰（与 dsh-user-keep-compaction 同口径）：一条记录约 120 字节，
// 而「悄悄丢一条记录」正好就是本次要修的那类静默失效。

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const errorText = (error) => String((error && error.message) || error);

/** 展开 `~` 前缀（DSH_HOME 允许写成 ~/…，与 dsh-safefull / dsh-user-keep-compaction 同口径）。 */
function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/** 会话缺省落盘路径：$DSH_HOME/ultracode.json（展开 ~ 后绝对化）。 */
export function defaultStateFile() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return resolve(expandHome(home), 'ultracode.json');
}

/**
 * 消息分支（dsh-message-branches）的**分支组账本**：$DSH_HOME/message-branches/groups.json。
 *
 * 为什么要读别人的账本：消息分支里「第一条分支」是 `sessions.create` 出来的空白会话
 * （那条分支的 header 里没有 parentSession，见该插件 client.js 的 runFork），出厂谱系
 * 在这一跳是断的。而它在自己的账本里清清楚楚记着「这个会话属于哪个组、组根是谁」，
 * 所以把它当作谱系的**最后一路来源**：只读、读得到就认，读不到就当没有（绝不因此报错）。
 */
export function defaultBranchLedgerFile() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return resolve(expandHome(home), 'message-branches', 'groups.json');
}

/**
 * 有界目录创建（**不要**换回 mkdirSync(dir, {recursive:true})）。
 *
 * 抄自 dsh-model-groups 的实测记录：Node v22.23.3 对 procfs 这类「父目录不存在、
 * 且 mkdir 对缺失父目录返回 ENOENT 而不是 EPERM」的文件系统，recursive mkdir 会
 * **永不返回**——同步调用占死唯一的 JS 线程，整个 DSH（GUI + 会话）冻结，既不抛错
 * 也不打日志，只能重启进程。逐级非递归创建把这种路径变成立刻抛出的 ENOENT，
 * 落进既有的 storeError 上报分支。
 *
 * 逐级切分必须以 `parse().root` 为根，**不能假设根是 `sep`**：Windows 绝对路径是
 * `C:\Users\…`（盘符 `C:`）或 `\\server\share\…`（UNC），POSIX 才是 `/…`。旧实现写死
 * `absolute.slice(1).split(sep)`，在 Windows 上第一段就是盘符里的 `:`，于是 mkdir
 * `C:\:` → `EINVAL`——`$DSH_HOME/ultracode.json` 所在目录的写入从此永远失败、选择跨
 * 重启必丢（根因与修复同 dsh-settings-nav，见其 README 6.2）。UNC 同理。
 *
 * @param dir 目标目录（相对路径按进程 cwd 解析）
 */
function ensureDirSync(dir) {
  const absolute = resolve(dir);
  const { root } = parse(absolute);
  // 根为空说明不是绝对路径（resolve 之后不该出现，防御性返回）；已到根目录则无事可做。
  if (root === '' || absolute === root) return;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep)) {
    if (part === '') continue;
    // root 自带尾部隔符（`/`、`C:\`、`\\server\share\`），直接拼接即可。
    current = current.endsWith(sep) ? current + part : current + sep + part;
    if (existsSync(current)) continue;
    try {
      mkdirSync(current);            // 非递归：失败立刻抛（procfs → ENOENT，不再死循环）
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;   // 并发创建：谁先谁赢
    }
    if (!existsSync(current)) throw new Error('无法创建目录：' + current);
  }
}

/** 归一一条盘上记录；形状不对就丢弃（坏条目不该拖垮整张表）。 */
function normalizeRecord(raw) {
  if (!isRecord(raw) || typeof raw.enabled !== 'boolean') return undefined;
  return {
    enabled: raw.enabled,
    // phase 缺省由 enabled 推出：开着就是 enter，关着就是 none。
    phase: typeof raw.phase === 'string' && PHASES.has(raw.phase)
      ? raw.phase
      : (raw.enabled ? 'enter' : 'none'),
    decidedAt: Number.isFinite(raw.decidedAt) ? raw.decidedAt : 0,
  };
}

/**
 * 建立按 sessionId 索引的选择存储（读写接口；`set` / `remove` 之后立刻落盘）。
 *
 * 写盘是「先重读、再合并、再原子换名」：同一份 $DSH_HOME 可能同时被两个 dsh
 * 进程使用（例如 web 与另一个 profile 实例），整表覆写会让后写的进程抹掉前者
 * 刚写的记录；合并后各进程只增改自己动过的 key，互不覆盖。
 *
 * @param file - JSON 落盘路径。
 * @param onError - 读/写失败的告警回调（调用方负责如实上报，绝不静默）。
 */
export function createStore(file, onError = () => {}) {
  /**
   * 家族开关表：**键 = 家族根会话 id**，值 = {enabled, phase, decidedAt}。
   *
   * 一个「家族」= 一条会话谱系（根会话 + 它 fork/分支出来的全部后代）。用户口径
   * （2026-10-09）是**家族共用**：在哪条分支上点亮/熄灭，全家族一起变，所以记录
   * 按家族根存一条，而不是按会话各存一条 —— 这就是「修改影响全部分支」的落点。
   */
  const sessions = new Map();

  /**
   * 谱系表：`{ 子会话 id → 家族根 id }`，**只记非根本的成员**（根本＝自己，无需记）。
   *
   * 为什么不靠父子指针现算：`session.header.parentSession` 只给直接父级，而父级
   * 在重启后可能还没被恢复（`ctx.sessions.get()` 只认活着的会话）。把归属**落盘**，
   * 家族关系就不会因为「父会话暂时不在内存里」而断掉。
   */
  const families = new Map();

  /**
   * 本进程改过、但**还没能成功写进盘**的键（记录键 = 家族根；谱系键 = 子会话）。
   *
   * 落盘是整表原子换名，所以一次成功就把两张表都刷上去了，只有失败的那一次会留下
   * 「内存跑在盘前面」的条目。它有两个用处（都必须是**逐条目**的，不能用全局标志：
   * 会话 A 写成功、会话 B 写失败时，A 的记录确实在盘上，不能连它一起报成未落盘）：
   *   ① persisted 的诚实性来源：写不进去时宁可报 false，也不假装已经落盘；
   *   ② 合并时「本进程的改动优先」的判据 —— 不脏的条目在盘上消失就认作别人删的。
   */
  const dirty = new Set();
  const dirtyFamilies = new Set();

  /**
   * 本进程删过、但**还没能成功写进盘**的记录键（删除墓碑）。
   *
   * 合并盘上条目时要跳过它们，否则刚删掉的记录会被盘上旧值「复活」（remove 的
   * 语义就是不留痕）。一次成功的写盘之后盘上已经不含这些条目，集合随即清空 ——
   * 所以它只在「删了但没写成功」的那段时间里生效，不会长期屏蔽别的进程后来为
   * 同一家族写进来的新记录。谱系表没有删除路径（reset 只抹开关、不动家谱），
   * 因此不需要对应的墓碑。
   */
  const tombstones = new Set();

  const readTable = (raw, normalize) => {
    const table = new Map();
    if (!isRecord(raw)) return table;
    for (const [key, value] of Object.entries(raw)) {
      const item = normalize(value);
      if (item !== undefined) table.set(key, item);
    }
    return table;
  };

  /** 读回盘上两张表；文件不存在时 exists=false（空表）。坏文件抛给调用方。 */
  const readFileRecords = () => {
    if (!existsSync(file)) return { records: new Map(), families: new Map(), exists: false };
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.sessions)) return { records: new Map(), families: new Map(), exists: true };
    // 版本白名单：1 = 只有按会话的记录（每个键各自成家，语义等价）；
    // 2 = 家族表 + 谱系表。未知版本按坏文件处理（同 model-groups：不猜、不迁移）。
    if (parsed.version !== undefined && !READABLE_STATE_VERSIONS.has(parsed.version)) {
      throw new Error(`unsupported state file version: ${String(parsed.version)}`);
    }
    return {
      records: readTable(parsed.sessions, normalizeRecord),
      families: readTable(parsed.families, (value) => (typeof value === 'string' && value !== '' ? value : undefined)),
      exists: true,
    };
  };

  try {
    const loaded = readFileRecords();
    for (const [key, record] of loaded.records) sessions.set(key, record);
    for (const [sessionId, rootId] of loaded.families) families.set(sessionId, rootId);
  } catch (error) {
    onError(error);
  }

  /**
   * 写盘前把盘上两张表并进内存（盘上是共识，本进程刚改还没写成功的条目优先）：
   *
   *   ① 盘上有、内存没有 → 补进来（别的进程写的，或本进程还没见过的旧值）；
   *   ② 本进程删过（墓碑）→ 不补，否则盘上旧值会把刚删掉的记录复活；
   *   ③ 内存有、盘上没有、且**不脏**（= 这条是从盘上读来的、或已经写成功过）
   *      → 说明别的进程把它删了，跟着删。少了这一条，本进程下一次整表回写就会
   *      把别人 reset 掉的记录又写回去（跨进程复活）。
   * 盘读不动（坏文件/无权限）或文件整个被外部删掉时不动内存：宁可整表重写，
   * 也不误删一批别人可能只是暂时读不到的记录。
   */
  const mergeFromDisk = (onDisk, onDiskFamilies, fileExists) => {
    for (const [key, record] of onDisk) {
      if (tombstones.has(key)) continue;
      if (!sessions.has(key)) sessions.set(key, record);
    }
    for (const [sessionId, rootId] of onDiskFamilies) {
      if (!families.has(sessionId)) families.set(sessionId, rootId);
    }
    if (!fileExists) return;
    for (const key of [...sessions.keys()]) {
      if (dirty.has(key)) continue;
      if (!onDisk.has(key)) sessions.delete(key);
    }
    for (const sessionId of [...families.keys()]) {
      if (dirtyFamilies.has(sessionId)) continue;
      if (!onDiskFamilies.has(sessionId)) families.delete(sessionId);
    }
  };

  /** 原子落盘（写前先重读 + 合并，见上）。 */
  const persist = () => {
    let tmp;
    try {
      ensureDirSync(dirname(file));
      // 先补上盘上已有、本进程内存里没有的条目（本进程的改动优先）。
      try {
        const onDisk = readFileRecords();
        mergeFromDisk(onDisk.records, onDisk.families, onDisk.exists);
      } catch {
        /* 坏文件/读失败：按内存表整表重写，至少不丢本进程的选择 */
      }
      tmp = file + '.tmp-' + randomUUID();
      const payload = {
        version: STATE_VERSION,
        families: Object.fromEntries(families),
        sessions: Object.fromEntries(sessions),
      };
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      renameSync(tmp, file);
      dirty.clear();               // 整表已经刷上盘，没有谁再跑在盘前面
      dirtyFamilies.clear();
      tombstones.clear();          // 盘上已不含它们，解禁
      return true;
    } catch (error) {
      // rename 失败时清掉 tmp，避免在 $DSH_HOME 里留垃圾（清理失败不掩盖原始错误）。
      if (tmp !== undefined) {
        try { rmSync(tmp, { force: true }); } catch { /* 尽力而为 */ }
      }
      // dirty 原样留着：内存已经跑在盘前面，persisted 要如实转 false。
      onError(error);
      return false;
    }
  };

  return {
    file,
    /** 读取某个家族的记录（无则 undefined）。键是家族根 id。 */
    get(rootId) {
      return sessions.get(rootId);
    },
    /** 读取谱系表里记着的归属（无则 undefined —— 调用方自行按父子指针推算）。 */
    familyOf(sessionId) {
      return families.get(sessionId);
    },
    /**
     * 这个会话当下的有效选择是否**真的在盘上**（= 重启后还认得它）。
     *
     * 家族共用时，选择存在家族根那条记录里，所以判据是：记录在、不脏，
     * 且（该会话就是根，或它的归属映射也写成功了）。判据逐条计算，不是全局状态：
     * 会话 A 写成功、会话 B 写失败时，A 仍然是已落盘（否则客户端会同时打印
     * 「本次由落盘恢复」和「未落盘：重启会丢」两句自相矛盾的话）。内存里有、但盘上
     * 没写成功时返回 false —— 此时 status.storeError 会说明原因。
     * 「假装已落盘」比「承认写失败」危险得多。
     */
    durable(sessionId, rootId) {
      if (!sessions.has(rootId) || dirty.has(rootId)) return false;
      if (sessionId === rootId) return true;
      return families.get(sessionId) === rootId && !dirtyFamilies.has(sessionId);
    },
    /**
     * 写入一个家族的开关并落盘（顺带记下该会话的归属）。一次 persist 写两张表，
     * 所以「记录 + 归属」要么一起在盘上、要么一起没写成。
     */
    set(sessionId, rootId, enabled, phase) {
      const record = {
        enabled: enabled === true,
        phase: typeof phase === 'string' && PHASES.has(phase) ? phase : (enabled === true ? 'enter' : 'none'),
        decidedAt: Date.now(),
      };
      sessions.set(rootId, record);
      dirty.add(rootId);              // 先标记：这一次写失败也不至于假装已落盘
      tombstones.delete(rootId);      // 重新做出选择 → 撤销待删标记
      if (sessionId !== rootId) {
        families.set(sessionId, rootId);
        dirtyFamilies.add(sessionId);
      }
      return { record, ok: persist() };   // 写成功会清空 dirty
    },
    /** 删除一个家族的开关并落盘（reset 用）；**家谱保留**。返回此前是否存在与本轮是否写成。 */
    remove(rootId) {
      const existed = sessions.delete(rootId);
      dirty.delete(rootId);           // 条目已不在内存，无所谓脏不脏
      // 墓碑先记上：万一这次写盘失败（盘上旧值还在），后续合并也不会把它复活。
      tombstones.add(rootId);
      return { existed, ok: persist() };
    },
    /** 表内条目数（自测/运维用）。 */
    size() {
      return sessions.size;
    },
    /** 谱系表条目数（自测/运维用）。 */
    familySize() {
      return families.size;
    },
    /** 某个家族在谱系表里记着的成员会话 id（不含根本自己）。 */
    familyMembers(rootId) {
      const members = [];
      for (const [sessionId, mapped] of families) {
        if (mapped === rootId) members.push(sessionId);
      }
      return members;
    },
    /**
     * 只记家谱归属，不动开关记录（**发现新亲戚时先把它记住**）。
     *
     * 为什么值得单独写一次盘：`session.header.parentSession` 只给直接父级，而父会话
     * 在重启后不一定被恢复（`ctx.sessions.get()` 只认活着的会话）。把归属落盘之后，
     * 「分支单独重开、父会话不在内存里」也照样认得自己属于哪个家族 —— 否则这条分支
     * 会退化成一个新家族，看不到家族的开关。已有同值映射时不重复写。
     */
    link(sessionId, rootId) {
      if (typeof sessionId !== 'string' || typeof rootId !== 'string') return { ok: true, changed: false };
      if (sessionId === rootId || families.get(sessionId) === rootId) return { ok: true, changed: false };
      families.set(sessionId, rootId);
      dirtyFamilies.add(sessionId);
      return { ok: persist(), changed: true };
    },
  };
}

// ── 纯函数：原实现的可执行镜像 ──────────────────────────────────────────────

// 原实现的 Mue / n1e / Ygt / C8n（强度档解析与 ultracode→xhigh 别名解析）
// 在此**刻意不实现**：DSH 侧没有 /effort 取值面，而本插件又不允许触碰思考
// 强度（EFFORT_POLICY），所以那四个解析器在这里没有调用点。逆向事实保存在
// ORIGINAL_EFFORT_MODEL 与 §2.1 文档里。

/**
 * Ultracode 段正文 —— 承载原实现里提醒所指向的「Ultracode 段 + 质量模式」。
 *
 * 首段由原提醒逐字派生，只摘掉指向 `workflow authoring reference` 的那一句：
 * DSH 没有那份 reference，留着就是空指针（这正是首版"开了没效果"的第二层原因）。
 * 摘掉之后指向的内容就地写在下面，提醒不再指向不存在的东西。
 */
const ULTRACODE_DIRECTIVE = REMINDERS.full
  .replace(/\s*See the \*\*Ultracode\*\* section and quality patterns in the workflow authoring reference\./, '');

/** 「质量模式」实文：把"最穷尽、最正确"落成可执行动作。 */
const ULTRACODE_PATTERNS = [
  'Decompose a substantive task into independent pieces and fan them out with the Workflow tool instead of answering in one pass.',
  'Verify independently: have a separate agent check each non-trivial claim, derivation, or edit against the primary source, rather than confirming your own work.',
  'Attack the result before presenting it: run an adversarial pass that tries to falsify the conclusion, and report what survived.',
  'Do not stop at the first plausible answer when a more complete one is reachable.',
];

/** 注入用段名 / 落位（放在第一个 `tool:` 段之前，紧邻它所治理的工具说明）。 */
const ULTRACODE_SECTION_NAME = 'ultracode';

/**
 * 工具段改写文案。DSH 原生段写的是「ONLY when the user explicitly asks」，
 * 与本机制正面冲突 —— 那是"开了没效果"的根因。开启时按原文语义改为
 * ultracode 感知版（原文的 Workflow 工具描述本身就点名 ultracode opt-in）。
 */
function ultracodeToolText(toolName) {
  return `Use the ${toolName} tool on every substantive task: you write a JavaScript script `
    + '(the tool description documents the exact format) that fans work out across many subagents '
    + 'with phases and structured results. Ultracode is on for this session, so this standing '
    + 'instruction overrides the default opt-in rule. Stay solo only on conversational or trivial turns.';
}

/**
 * 会话态：对应原实现的 appState。
 *
 * 生命周期（对照原实现 settings schema 的自述）：
 *   "Enable ultracode for the session: standing dynamic-workflow orchestration at any
 *    effort level. **Session-scoped** — typically provided via --settings or the
 *    apply_flag_settings control request; **interactive toggles never persist it**."
 *
 * 本插件分三路来源（2026-10-09 起第三路是新增的落盘恢复）：
 *   - `provisioned`：进程级预置（对应 --settings / apply_flag_settings），由
 *     `DSH_ULTRACODE` 或行配置 `provision` 给出，**每个会话开局即生效**；
 *   - `interactive`：输入框开关（会话级），只作用于该会话 —— 现在**会落盘**
 *     （$DSH_HOME/ultracode.json），dsh 重启后按记录原样重建；
 *   - `restored`：内存态由上述落盘记录恢复而来（status.restored 标出）。
 * 三路都随会话销毁而清掉**内存**副本；落盘那份留着，供下次恢复。
 * 输出里带 `source` 标明当前值来自哪一路，`persisted` / `restored` 标明落盘情况。
 */
const PROVISION_ENV = 'DSH_ULTRACODE';

/** 解析预置值：'on'/'1'/'true' → true，'off'/'0'/'false' → false，其余 undefined。 */
function parseProvisioned(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  if (lowered === 'on' || lowered === '1' || lowered === 'true' || lowered === 'yes') return true;
  if (lowered === 'off' || lowered === '0' || lowered === 'false' || lowered === 'no') return false;
  return undefined;
}

/** 拼出 Ultracode 段正文。 */
function ultracodeSectionText() {
  return '## Ultracode (this session)\n\n'
    + ULTRACODE_DIRECTIVE + '\n\n'
    + 'Quality patterns for this session:\n'
    + ULTRACODE_PATTERNS.map((line) => '- ' + line).join('\n');
}

/**
 * 收口段正文（对应原实现的 `ultra_effort_exit` 附件）。
 *
 * 原实现把 exit 附件写进历史，它会一直留在上下文里直到压缩；这里等价地做成
 * **闩锁段**：关闭后每次装配都在场，直到重新开启或 reset。第二句取自
 * `workflow-authoring` skill 的 Ultracode 段：`When a reminder says ultracode is
 * off, revert to the opt-in rule in the Workflow tool description.`
 */
function ultracodeExitText() {
  return '## Ultracode (this session)\n\n'
    + REMINDERS.exit + '\n\n'
    + 'Revert to the opt-in rule in the Workflow tool description: call it only when the user '
    + 'explicitly asked for multi-agent orchestration.';
}

/**
 * 收据里的 `Valid options are: …` —— 原实现 `g(e)`：
 *   `${Iue(e).join(", ")}, auto${hx(e) ? ", ultracode [on|off]" : ""}`
 * 即「模型声明的档位（去掉 off） + auto + 支持时附 ultracode」。
 */
function validOptionsText(effortIds, ultraAvailable) {
  const ids = Array.isArray(effortIds)
    ? effortIds.filter((id) => typeof id === 'string' && id !== '' && id !== 'off')
    : [];
  const list = ids.length > 0 ? ids.join(', ') : 'low, medium, high, xhigh, max';
  return list + ', auto' + (ultraAvailable ? ', ultracode [on|off]' : '');
}

/**
 * 直注：按状态改写一次装配结果。
 *
 * 开启 → 加 Ultracode 段，并把 `tool:<name>` 段换成 ultracode 感知版；
 * 关闭（闩锁 exit）→ 只替换成收口段，工具段保持原生（闸自动恢复）；
 * 其余 → 调用方根本不进这里，装配结果原样送出。
 *
 * 注意 `AssembledSection` 只有 `{name,text}`、**不带 order**，所以位置靠插入
 * 下标决定：统一插在第一个 `tool:` 段之前，保证它在工具说明之前被读到。
 *
 * @param {'enter'|'exit'} mode - 进入态注入编排指令，退出态注入收口。
 * @returns {{assembly: object, shadowed: boolean}} 改写后的装配结果与是否改写了工具段。
 */
function injectUltracode(assembly, toolName, mode) {
  const toolSectionName = 'tool:' + toolName;
  const mine = {
    name: ULTRACODE_SECTION_NAME,
    text: mode === 'exit' ? ultracodeExitText() : ultracodeSectionText(),
  };
  const sections = [];
  let shadowed = false;
  let placed = false;
  for (const section of assembly.sections) {
    if (!placed && typeof section.name === 'string' && section.name.startsWith('tool:')) {
      sections.push(mine);
      placed = true;
    }
    // 退出态不改写工具段：原生的 opt-in 闸原样恢复，正是收口要表达的语义。
    if (mode !== 'exit' && section.name === toolSectionName) {
      shadowed = true;
      sections.push({ name: section.name, text: ultracodeToolText(toolName) });
      continue;
    }
    sections.push(section);
  }
  if (!placed) sections.push(mine);
  return { assembly: { ...assembly, sections }, shadowed };
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const workflowToolName = typeof config.workflowToolName === 'string' && config.workflowToolName !== ''
    ? config.workflowToolName
    : 'workflow';
  /** 缺省 true：与原实现 `nm()` 的缺省（未被 managed settings 关掉即启用）一致。 */
  const workflowsEnabled = config.workflowsEnabled !== false;
  /** 模型需声明的最低可用档数（非 off）；对应 `SXe` 的 xhigh_effort 能力位。 */
  const requireTiers = Number.isInteger(config.requireTiers) && config.requireTiers > 0 ? config.requireTiers : 2;

  /** 会话态：对应原实现的 appState 三件套（会话级内存态；盘上另有一份选择记录）。 */
  const states = new Map();
  /** 旁听来的当前路由：availability 需要模型标识。 */
  const routes = new Map();
  /** 模型能力缓存：key = `${provider}\u0000${model}`。 */
  const modelSupport = new Map();
  /**
   * 遥测计数（只在进程内，不外发）。语义要说清，免得被误读：
   *   injections 注入次数 · exits 收口注入次数 · unavailable 因不可用跳过次数
   *   restores = 「从盘上重建内存态」的**次数**（不是会话数）——同一会话被
   *     agent/disposed 清掉内存后再问一次会再计一次；用于确认重启后确实走了恢复路径。
   *   inherits = 以**非家族根**身份认领家族记录的重建次数（= 走继承路径的次数）。
   *   syncs = 家族内其它分支改了开关、本会话对账跟上的次数（家族共用的证据）。
   *   storeWrites 成功写盘次数 · storeErrors 读/写失败次数。
   */
  const telemetry = { injections: 0, exits: 0, unavailable: 0, restores: 0, inherits: 0, syncs: 0, storeWrites: 0, storeErrors: 0 };
  /** 最近一次落盘读/写失败的原因（null = 正常）；成功写入后自动清掉。 */
  let storeError = null;

  const sessionIdOf = (agent) => {
    const session = agent === undefined || agent === null ? undefined : agent.session;
    return session !== undefined && session !== null && typeof session.id === 'string' ? session.id : undefined;
  };

  /** 预置值（--settings / apply_flag_settings 的对应物）：新会话开局即生效。 */
  const provisioned = parseProvisioned(process.env[PROVISION_ENV]) ?? parseProvisioned(config.provision);

  // ── 落盘存储：进程启动时读一次，之后只在人点开关时写 ──────────────────────
  const configuredFile = typeof config.stateFile === 'string' ? config.stateFile.trim() : '';
  const stateFile = configuredFile === '' ? defaultStateFile() : resolve(expandHome(configuredFile));
  const store = createStore(stateFile, (error) => {
    storeError = errorText(error);
    telemetry.storeErrors += 1;
    // 与部署里其它有状态的插件走同一条告警通道（dsh-user-keep-compaction /
    // dsh-model-groups / dsh-message-branches 都是 ctx.logger?.warn?）：
    // 失败不能只躺在 /status 里等人来问。
    ctx.logger?.warn?.('dsh-ultracode: 会话选择落盘读写失败', error);
  });

  /** 落盘成功即清掉上一次的失败原因（文件已被这次写入救回来）。 */
  const noteStoreWrite = (ok) => {
    if (ok) {
      telemetry.storeWrites += 1;
      storeError = null;
    }
  };

  // ── 家族（会话谱系）：一个家族共用一条开关 ─────────────────────────────────
  //
  // 用户口径（2026-10-09）：ultracode 不是一个会话一个选择，而是**一个家族一个选择**
  // —— 在哪条分支上点亮/熄灭，主线与全部分支/分叉一起变（「修改影响全部分支」）。
  // 所以记录按「家族根会话 id」存一条，任意会话先解析出自己的家族根再读写它。
  //
  // 家族根怎么找（顺序即权威性）：
  //   ① 家谱表里落过盘的归属（**重启后父会话没被恢复也照样认得**）；
  //   ② 顺着父指针往上走：装配期直接用 `agent.session.header.parentSession`（零查询），
  //      路由期（/status、/set）问 `sessions` 服务要活会话的 header；
  //   ③ 走到头 → 自己就是家族根（新会话、独立会话）。
  //
  // 结果缓存在内存里，**只缓存「非自身」的结论**：把「我自己就是根」缓存下来会把
  // 后来的归属钉死（父会话那时可能只是还没被恢复）。家谱很浅，重算一次就是几次
  // Map 查询，值得。

  const familyCache = new Map();
  const MAX_FAMILY_DEPTH = 64;   // 家谱实际只有几层，这个上限纯粹是防环

  /**
   * 消息分支组账本的内存镜像（表：子会话 id → 组根会话 id）。
   *
   * 刷新只在**路由期**做（/status 由浏览器每 8s 拉一次）：一次 statSync 看 mtime 变没变，
   * 变了才真读。装配期只用这里的内存结果 —— 「装配期零落盘 I/O」的承诺不破。
   * 账本缺失/损坏/读不动一律静默降级：那只是少一路来源，不是错误。
   */
  const branchLedger = { file: defaultBranchLedgerFile(), mtimeMs: -1, map: new Map(), read: false };

  /** 把消息分支账本读进内存（只读得到就认）。 */
  const refreshBranchLedger = () => {
    try {
      const stat = statSync(branchLedger.file);
      if (branchLedger.read && stat.mtimeMs === branchLedger.mtimeMs) return;
      const parsed = JSON.parse(readFileSync(branchLedger.file, 'utf8'));
      const map = new Map();
      if (isRecord(parsed) && isRecord(parsed.groups)) {
        for (const [rootId, group] of Object.entries(parsed.groups)) {
          if (typeof rootId !== 'string' || rootId === '' || !isRecord(group)) continue;
          const branches = Array.isArray(group.branches) ? group.branches : [];
          for (const branch of branches) {
            const sessionId = isRecord(branch) ? branch.sessionId : undefined;
            // 组根自己也作为 kind:'root' 记在列表里（sessionId === rootId），跳过。
            if (typeof sessionId === 'string' && sessionId !== '' && sessionId !== rootId) {
              map.set(sessionId, rootId);
            }
          }
        }
      }
      branchLedger.map = map;
      branchLedger.mtimeMs = stat.mtimeMs;
      branchLedger.read = true;
    } catch {
      /* 没装消息分支 / 还没分过叉 / 文件坏了：当这一路不存在 */
    }
  };

  /** 父会话 id：优先用调用方手里的 agent（装配期零查询），否则问 sessions 服务。 */
  const parentIdOf = (sessionId, agentHint) => {
    if (agentHint !== undefined && agentHint !== null && sessionIdOf(agentHint) === sessionId) {
      const parent = agentHint.session?.header?.parentSession;
      if (typeof parent === 'string' && parent !== '') return parent;
    }
    try {
      // 只在路由期兜底：活会话的 header 里带着 parentSession（fork 时写入，见
      // dsh-session 的 SessionStore.fork）。
      const live = ctx.get('sessions')?.get?.(sessionId);
      const parent = live?.header?.parentSession;
      if (typeof parent === 'string' && parent !== '') return parent;
    } catch {
      /* 服务缺席/查询失败一律按「没有父级」处理：家族退化成单人家庭，不影响开关本身 */
    }
    return undefined;
  };

  /** 解析会话所属的家族根 id（undefined 输入 → undefined）。 */
  const rootOf = (sessionId, agentHint) => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    const cached = familyCache.get(sessionId);
    if (cached !== undefined) return cached;
    const path = [];
    let current = sessionId;
    let hint = agentHint;
    let root = sessionId;
    for (let depth = 0; depth < MAX_FAMILY_DEPTH; depth += 1) {
      path.push(current);
      const mapped = store.familyOf(current);
      if (mapped !== undefined) { root = mapped; break; }
      const known = familyCache.get(current);
      if (known !== undefined) { root = known; break; }
      // 消息分支账本是**只读的旁证**：空白分支在这一跳没有父指针，账本记着它属于哪个组。
      const grouped = branchLedger.map.get(current);
      const parent = grouped !== undefined ? grouped : parentIdOf(current, hint);
      hint = undefined;
      if (parent === undefined || parent === current || path.includes(parent)) { root = current; break; }
      current = parent;
    }
    // 只记非根本的成员：根本就是自己，没有信息量。
    for (const member of path) {
      if (member !== root) familyCache.set(member, root);
    }
    return root;
  };

  /**
   * 本进程里与 sessionId 同家族的**其它**成员数（前端用来讲清「改动影响全部分支」）。
   * = 落过盘的家谱成员 ∪ 此刻活着的同家族会话，再去掉自己。查不动就按 0。
   */
  const countFamilyBranches = (sessionId, familyId) => {
    const ids = new Set(store.familyMembers(familyId));
    try {
      const list = ctx.get('sessions')?.list?.();
      if (Array.isArray(list)) {
        for (const session of list) {
          const id = session === undefined || session === null ? undefined : session.id;
          if (typeof id === 'string' && rootOf(id) === familyId) ids.add(id);
        }
      }
    } catch {
      /* 服务缺席/查询失败：只报家谱里记着的成员数 */
    }
    ids.delete(sessionId);
    return ids.size;
  };

  const stateFor = (sessionId) => {
    let state = states.get(sessionId);
    if (state === undefined) {
      state = {
        // 会话开局值来自预置；interactive 开关一旦动手就接管（并立刻落盘）。
        requested: provisioned === true,
        source: provisioned === true ? 'provisioned' : 'interactive',
        // restored：内存态是否由盘上记录恢复而来（本进程的点击/预置则 false）。
        restored: false,
        // phase 对应原实现从历史里回扫出的 s ∈ {none, enter, exit}。
        phase: provisioned === true ? 'enter' : 'none',
        injected: false,
        shadowed: false,
        // 本会话自己写下去的那条记录的时间戳；用来分辨「盘上这条是我写的」还是
        // 「是别的分支写的」（后者才算 restored）。
        localDecidedAt: 0,
      };
      states.set(sessionId, state);
    }
    return state;
  };

  /**
   * 读取会话态。来源顺序即优先级：
   *   ① 内存已有 → 先跟家族记录对一次账（**家族共用**的关键：别的分支改了开关，
   *      本会话下一次读就要跟上）；
   *   ② 家族记录在盘上 → 按记录重建（**重启后走的就是这一路**）；
   *   ③ 都没有 → 有预置才 materialize，没有预置的会话拿到 undefined（装配期零开销直通）。
   *
   * ② 高于 ③：用户对某家族的显式选择不能被进程级缺省覆盖，否则每次重启都会把
   * 用户手动关掉的 ultracode 又打开 —— 那正是本次要修的那类失效。
   *
   * @param sessionId - 会话 id。
   * @param agentHint - 手里已有的 agent（装配期传，省掉一次服务查询并拿到父指针）。
   */
  const stateOf = (sessionId, agentHint) => {
    const rootId = rootOf(sessionId, agentHint);
    const record = rootId === undefined ? undefined : store.get(rootId);
    const existing = states.get(sessionId);
    if (existing === undefined) {
      if (record === undefined) {
        if (provisioned === undefined) return undefined;
        return stateFor(sessionId);
      }
      const restored = {
        requested: record.enabled,
        source: 'interactive',
        restored: record.decidedAt !== 0,
        // 记录里存着 phase：原实现的进入/退出本就从持久化的历史里回扫，
        // 所以退出闩锁同样跨重启存活。
        phase: record.phase,
        injected: false,
        shadowed: false,
        localDecidedAt: 0,
      };
      states.set(sessionId, restored);
      telemetry.restores += 1;
      if (rootId !== sessionId) telemetry.inherits += 1;
      return restored;
    }
    // 对账：家族记录才是权威（可能被别的分支、别的进程或 reset 改过）。
    const wanted = record === undefined
      ? {
        requested: provisioned === true,
        phase: provisioned === true ? 'enter' : 'none',
        source: provisioned === true ? 'provisioned' : 'interactive',
      }
      : { requested: record.enabled, phase: record.phase, source: 'interactive' };
    if (existing.requested !== wanted.requested || existing.phase !== wanted.phase) {
      existing.requested = wanted.requested;
      existing.phase = wanted.phase;
      existing.source = wanted.source;
      // injected/shadowed 是**本会话的提示装配事实**，状态一变就复位，
      // 好让下一次装配按新状态重新注入（开→注入 Ultracode 段，关→收口段）。
      existing.injected = false;
      existing.shadowed = false;
      if (record !== undefined) telemetry.syncs += 1;
    }
    existing.restored = record !== undefined && record.decidedAt !== existing.localDecidedAt;
    return existing;
  };

  /**
   * `nm()`：动态工作流是否可用。原实现读 managed settings 与
   * `disableWorkflows`；DSH 侧先看配置总开关，再看会话工作流工具是否真的在
   * 工具注册表里可见（可见即正向确认；受 realm 作用域看不到时不误判为关）。
   */
  const workflowsAvailable = () => {
    if (!workflowsEnabled) return false;
    const tools = ctx.get('tools');
    if (tools === undefined || typeof tools.get !== 'function') return true;
    try {
      if (tools.get(workflowToolName) !== undefined) return true;
    } catch {
      return true;
    }
    return true;
  };

  /**
   * `SXe(model)`：模型是否具备 ultra 档能力。原实现读声明的 `xhigh_effort`
   * 能力位；DSH 的模型按 id 自述思考档，故按「非 off 档数 >= requireTiers」
   * 判定，并把结果按路由缓存。
   */
  const supportsUltra = async (provider, model) => {
    if (typeof provider !== 'string' || typeof model !== 'string') return { supported: false, effortIds: [] };
    const key = provider + '\u0000' + model;
    const cached = modelSupport.get(key);
    if (cached !== undefined) return cached;
    const llm = ctx.get('llm');
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') {
      const fallback = { supported: true, effortIds: [] };
      modelSupport.set(key, fallback);
      return fallback;
    }
    let result = { supported: false, effortIds: [] };
    try {
      const info = await llm.resolveModelInfo(provider, model);
      const efforts = info !== undefined && info !== null && info.reasoning !== undefined && Array.isArray(info.reasoning.efforts)
        ? info.reasoning.efforts
        : [];
      const effortIds = efforts
        .filter((effort) => effort !== undefined && effort !== null && typeof effort.id === 'string' && effort.id !== 'off')
        .map((effort) => effort.id);
      result = { supported: effortIds.length >= requireTiers, effortIds };
    } catch {
      result = { supported: false, effortIds: [] };
    }
    modelSupport.set(key, result);
    return result;
  };

  /** `hx(model)`：可用性闸 = 工作流可用 && 模型支持。 */
  const availability = async (sessionId) => {
    if (!workflowsAvailable()) {
      return { available: false, reason: 'workflows', model: undefined };
    }
    const route = sessionId === undefined ? undefined : routes.get(sessionId);
    const provider = route === undefined ? undefined : route.provider;
    const model = route === undefined ? undefined : route.model;
    if (model === undefined) {
      // 首轮请求之前还没有路由：原实现此处 `e===undefined` 视为可用。
      return { available: true, reason: undefined, model: undefined };
    }
    const support = await supportsUltra(provider, model);
    return support.supported
      ? { available: true, reason: undefined, model, effortIds: support.effortIds }
      : { available: false, reason: 'model', model, effortIds: support.effortIds };
  };

  /** 供浏览器半边读取的完整视图。 */
  const statusView = async (sessionId) => {
    const state = sessionId === undefined ? undefined : stateOf(sessionId);
    const avail = await availability(sessionId);
    const route = sessionId === undefined ? undefined : routes.get(sessionId);
    // 家族共用：记录键是家族根，本会话可能只是其中一条分支。
    const familyId = sessionId === undefined ? undefined : rootOf(sessionId);
    const record = familyId === undefined ? undefined : store.get(familyId);
    return {
      sessionId,
      requested: state === undefined ? false : state.requested,
      active: state !== undefined && state.requested === true && avail.available,
      available: avail.available,
      reason: avail.reason,
      model: avail.model ?? (route === undefined ? undefined : route.model),
      provider: route === undefined ? undefined : route.provider,
      // 直注状态：注入方式是系统提示装配，每请求都在场、不依赖模型调用。
      injection: 'system-prompt',
      injected: state !== undefined && state.injected === true,
      shadowed: state !== undefined && state.shadowed === true,
      // 生命周期：phase 对应原实现从历史回扫出的 s；source 标明当前值来自
      // 预置（--settings 对应物）还是会话交互开关。
      phase: state === undefined ? 'none' : state.phase,
      source: state === undefined ? (provisioned === true ? 'provisioned' : 'interactive') : state.source,
      // 落盘情况（2026-10-09）：
      //   persisted = 本会话当下的有效选择在盘上确有一条记录（= 重启后还记得它）；
      //   restored  = 本进程的内存态就是由那条记录恢复出来的（不是本次点击/预置得到）。
      persisted: sessionId === undefined ? false : store.durable(sessionId, familyId),
      restored: state !== undefined && state.restored === true,
      decidedAt: record === undefined ? null : record.decidedAt,
      // 家族（2026-10-09）：family = 本条会话所属的家族根 id；rooted 标明本会话就是根；
      // branches = 本进程里同家族的**其它**活会话数（前端用来讲清「改动影响全部分支」）。
      family: familyId ?? null,
      familyRoot: familyId !== undefined && familyId === sessionId,
      branches: familyId === undefined ? 0 : countFamilyBranches(sessionId, familyId),
      stateFile: store.file,
      storeError,
      // 收据里的 `Valid options are: …`（原实现 g(e)）。
      validOptions: validOptionsText(avail.effortIds, avail.available),
      // 会话自身的思考强度，**原样上报**（undefined = 交给模型路由缺省）。
      // 这里不做任何别名映射、不填任何"应有"档位 —— ultracode 不限制思考
      // 强度，开关 title 显示的必须是真实值而不是本插件期望的值。
      reasoningEffort: route === undefined || route.reasoningEffort === undefined
        ? null
        : String(route.reasoningEffort),
      effortPolicy: EFFORT_POLICY,
      workflowsEnabled: workflowsAvailable(),
      workflowToolName,
      telemetry: { ...telemetry },
    };
  };

  // ── 注入点①：装配期直注（每请求都在场，不依赖任何模型调用） ────────────────
  //
  // 这是本插件唯一的注入路径。三种去向：
  //   - 开启且可用 → 加 Ultracode 段 + 换掉冲突的工具段；
  //   - 关闭但进入过（phase==='exit'）→ 注入**收口段**（闩锁，对应原实现把 exit
  //     附件写进历史后长期留存），工具段保持原生、opt-in 闸自动恢复；
  //   - 从未启用 / 不可用 → 直接 return assembly，提示里一个字都不加。
  // 因为走的是系统提示装配，开关一落就生效，**不需要**等下一次模型调用，
  // 也不会往会话里写任何可见消息。
  //
  // 装配期**不做任何落盘 I/O**：状态在进程启动时已从盘上读进内存（见 stateOf）。
  //
  // `{prepend:true}` 让我们处于瀑布最外层：`await next()` 拿到的是下游全部
  // 处理完的结果，我们再做最后的改写，因此不会被后续监听者覆盖（出厂
  // dsh-session-reference 用的就是这个写法）。

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    const agent = context === undefined ? undefined : context.agent;
    const sessionId = sessionIdOf(agent);
    if (sessionId === undefined) return assembly;
    // 把 agent 一并交给 stateOf：家族解析可以零查询地拿到父指针 —— **fork 的第一条
    // 请求就在这里认领父会话的家族**（继承的落点），而且装配期仍然不做任何落盘 I/O。
    const state = stateOf(sessionId, agent);
    if (state === undefined) return assembly;

    if (state.requested !== true) {
      // 收口：只有真正进入过（enter）的会话才欠一条退出说明。
      if (state.phase !== 'exit') {
        state.injected = false;
        state.shadowed = false;
        return assembly;
      }
      const exited = injectUltracode(assembly, workflowToolName, 'exit');
      telemetry.exits += 1;
      state.injected = true;
      state.shadowed = false;
      return exited.assembly;
    }

    const avail = await availability(sessionId);
    if (!avail.available) {
      telemetry.unavailable += 1;
      state.injected = false;
      state.shadowed = false;
      return assembly;
    }

    const result = injectUltracode(assembly, workflowToolName, 'enter');
    telemetry.injections += 1;
    state.injected = true;
    state.shadowed = result.shadowed;
    return result.assembly;
  }, { prepend: true });

  // ── 注入点②：只旁听路由（availability 需要模型标识） ──────────────────────
  //
  // 思考强度承诺（EFFORT_POLICY = 'untouched'）：这里把 next() 的结果**按同
  // 引用**原样返回，绝不构造新对象、绝不改写 reasoningEffort / maxTokens /
  // temperature。ultracode 开关与模型思考强度完全解耦 —— 不施加、不收敛、
  // 不封顶；开关 title 显示的强度就是会话真实强度（route.reasoningEffort）。
  // 自测里 pinned：即便入参带 reasoningEffort，返回值也必须 `===` 原对象。

  ctx.on('agent/request', async (payload, next) => {
    const callConfig = await next();
    const sessionId = sessionIdOf(payload.agent);
    if (sessionId !== undefined && callConfig !== undefined && callConfig !== null) {
      routes.set(sessionId, {
        provider: callConfig.provider,
        model: callConfig.model,
        // 只读留档，供开关 title 如实显示；不参与任何写回。
        reasoningEffort: callConfig.reasoningEffort,
      });
    }
    return callConfig;
  });

  // ── 清理：会话销毁只清内存态，**落盘记录留着** ────────────────────────────
  //
  // 「重启后不失效」的落点正在这里：若在这一步把盘上记录一并删掉，那就回到了
  // 「重启即失」的老行为。会话下次被恢复时，stateOf 会按盘上记录原样重建
  // （status.restored=true）。
  //
  // 本事件什么时候到场（2026-10-09 内核侧核实）：它是**纯进程内派发**
  // （dsh-agent 的 ctx.events.dispatch），只在「本次进程内活着的 agent 被销毁」时
  // 触发 —— 唯一移除路径是 agent-loop 注册 effect 的 dispose，即进程/插件卸载，
  // 外加子代理 owner 的显式 teardown。没有 idle 驱逐，归档会话也不销毁会话对象。
  // 重启后**不会**为旧会话补发本事件（旧会话只是被 resume 成新对象），SIGKILL/崩溃
  // 时也不会到场 —— 都无所谓：本 handler 只清内存，记录本来就在盘上。

  ctx.on('agent/disposed', (payload) => {
    const sessionId = sessionIdOf(payload.agent);
    if (sessionId !== undefined) {
      states.delete(sessionId);
      routes.delete(sessionId);
    }
  });

  // ── 会话诞生：把新分支的归属**同步**固化（继承的挂点） ──────────────────────
  //
  // `session/created` 是唯一在子会话诞生瞬间就带着 `session.header.parentSession`
  // 的事件（fork 在 agents.create 之前就把父指针写进 meta），而此刻父会话必定还活着
  // （会话进 store 只增不减）→ 零查询就能定族。趁这一刻把「子 → 家族根」写进家谱，
  // 重启后即使父会话没被恢复、或用户只单独打开这条分支，它也照样认领家族的选择。
  // 装配期于是退化成一次 Map 查询 —— 「装配期零落盘 I/O」不破。
  //
  // ⚠ 这个事件的监听者**同步抛错会否决会话创建并回滚**（见 dsh-tool-cordis 的
  // 事件契约），所以这里：全程 try/catch；不做任何 await（store 的落盘是同步
  // writeFileSync + rename）；认亲失败只告警，绝不让会话建不出来。
  ctx.on('session/created', (session) => {
    try {
      const childId = session === undefined || session === null ? undefined : session.id;
      const parentId = session === undefined || session === null ? undefined : session.header?.parentSession;
      if (typeof childId !== 'string' || childId === '') return;
      if (typeof parentId !== 'string' || parentId === '' || parentId === childId) return;
      const rootId = rootOf(parentId) ?? parentId;
      if (rootId === childId) return;
      const linked = store.link(childId, rootId);
      if (linked.changed) noteStoreWrite(linked.ok);
    } catch (error) {
      storeError = errorText(error);
      telemetry.storeErrors += 1;
      ctx.logger?.warn?.('dsh-ultracode: 分支归属落盘失败（已忽略，不影响会话创建）', error);
    }
  });

  // ── 浏览器 API（均带同源守卫） ────────────────────────────────────────────

  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  const apiJson = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };

  const apiError = (res, status, error) => {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: message }));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });

  const requireSessionId = (args) => {
    const sessionId = args === undefined || args === null ? undefined : args.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId 必填');
    return sessionId;
  };

  const registerPost = (path, handler, label) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        if (req.method !== 'POST') return apiError(res, 405, 'Method Not Allowed');
        if (!sameOrigin(req)) return apiError(res, 403, 'cross-origin request rejected');
        readBody(req).then(async (text) => {
          let args = {};
          if (text !== '') {
            try {
              args = JSON.parse(text);
            } catch {
              return apiError(res, 400, 'body 不是合法 JSON');
            }
          }
          try {
            return apiJson(res, 200, await handler(args));
          } catch (error) {
            return apiError(res, 400, error);
          }
        }).catch(() => apiError(res, 400, 'body 读取失败'));
      },
    }), label);
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PREFIX + '/status',
    handler: (req, res) => {
      if (req.method !== 'GET') return apiError(res, 405, 'Method Not Allowed');
      if (!sameOrigin(req)) return apiError(res, 403, 'cross-origin request rejected');
      let sessionId;
      try {
        sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId') ?? undefined;
      } catch {
        sessionId = undefined;
      }
      // 顺路认亲：这是一次浏览器发起的读（不是每条模型请求），在这儿把新发现的家族
      // 归属落盘一次（**只在新发现时写**，同值不再重复写），重启后单独打开一条分支
      // 也还认得它属于哪个家族。写失败不影响这次查询 ——statusView 里的 storeError 会说。
      if (sessionId !== undefined) {
        refreshBranchLedger();
        const familyId = rootOf(sessionId);
        if (familyId !== undefined && familyId !== sessionId && store.familyOf(sessionId) !== familyId) {
          noteStoreWrite(store.link(sessionId, familyId).ok);
        }
      }
      statusView(sessionId).then(
        (value) => apiJson(res, 200, value),
        (error) => apiError(res, 500, error),
      );
    },
  }), 'dsh-ultracode status route');

  registerPost(ROUTE_PREFIX + '/set', async (args) => {
    const sessionId = requireSessionId(args);
    if (typeof args.active !== 'boolean') throw new Error('active 必须是布尔值');
    // 先看一眼消息分支账本：空白分支的归属只在这本账里，必须在解析家族**之前**刷新，
    // 否则这一次点击会落到「自成一家」的记录上（一次 statSync，mtime 没变就不读）。
    refreshBranchLedger();
    // 必须先走 stateOf（唯一会读盘的一路）再退回 stateFor：进程刚重启、内存还冷时
    // 盘上可能正躺着 {enabled:true, phase:'enter'}，此时先到的 /set 若只看预置造态，
    // 就会把退出闩锁算丢（was=false → phase 停在 none）并把那条记录覆写成 phase:'none'。
    // 浏览器半边靠「/status 没成功就不给点」避开了这条路径，直接打 HTTP 的调用者能踩到。
    const state = stateOf(sessionId) ?? stateFor(sessionId);
    const was = state.requested === true;
    state.requested = args.active;
    // 交互开关一旦动手就接管来源；本次点击之后就不再算「由落盘恢复」。
    state.source = 'interactive';
    state.restored = false;
    if (args.active) {
      state.phase = 'enter';            // 本次进入，从此欠一条收口
    } else if (was || state.phase === 'enter') {
      state.phase = 'exit';             // enter → exit：闩上收口段
      state.injected = false;
      state.shadowed = false;
    }
    // 落盘（2026-10-09）：人做的选择从此跨 dsh 重启存活。写失败不阻断本次切换
    // ——内存态已经生效，失败原因经 status.storeError 如实上报。
    // 家族共用（同日追加）：写的是**家族根**那条记录，所以本分支上的一次点击对
    // 全家族生效；同时把「本会话属于这个家族」一并记进家谱（一次 persist 落两张表），
    // 重启后即使父会话没被恢复也认得这门亲戚。别的活分支不用推送：它们下一次
    // stateOf 对账时自会跟上（telemetry.syncs 记的就是这件事）。
    const written = store.set(sessionId, rootOf(sessionId) ?? sessionId, state.requested, state.phase);
    // 记下「这条记录是我写的」：别的分支写进来的记录才让 restored 为真。
    state.localDecidedAt = written.record.decidedAt;
    noteStoreWrite(written.ok);
    return statusView(sessionId);
  }, 'dsh-ultracode set route');

  registerPost(ROUTE_PREFIX + '/reset', (args) => {
    const sessionId = requireSessionId(args);
    // reset 抹掉交互状态，重新按预置开局（phase 归 none，不再欠收口）。
    // 家族共用下这是**整族的**操作：记录按家族根存，抹掉它 = 全部分支一起回到预置；
    // 家谱本身保留（骨架还在，只是没有选择了）。
    const familyId = rootOf(sessionId) ?? sessionId;
    states.delete(sessionId);
    // **盘上记录一并抹掉**：只清内存等于没 reset —— 下次重启会把这条记录恢复回来。
    noteStoreWrite(store.remove(familyId).ok);
    return statusView(sessionId);
  }, 'dsh-ultracode reset route');
}
