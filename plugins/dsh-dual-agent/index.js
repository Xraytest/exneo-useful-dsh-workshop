/**
 * dsh-dual-agent —— 双主智能编排（host 半边，v18）。
 *
 * 用户指令（2026-10-28 初版 + 2026-10-29 修订）：
 *   「启动按钮ui错误，启动后需要等用户键入初始指令并在用户手动停止是等待用户补充，
 *     只有智能体主动停止需要挑刺。将智能体1做成像sub agent一样的实现，
 *     报告评估由智能体2在主上下文视角输出」
 *
 * v2 语义（与 v1 的双人格方案完全不同）：
 *
 *   ① 智能体 1（执行者）＝ **真 subagent**：经 ctx.subagents.startActivation
 *     （spawn provider，in-process continuable child）孵化——自己的会话、自己的
 *     系统提示、零父上下文，与 UI 里 `subagent` 工具孵化出的子代理同构。
 *   ② 挑刺者 ＝ **主上下文人格**：常驻主会话系统提示（本插件注入），它以主
 *     会话的视角读对话与子代理报告，输出评估，不持有任务。
 *
 * 启停时序（用户点名的行为）：
 *   · 点「启动」＝ **武装待命**：只注入挑刺者人格 + 状态落盘（phase=armed），
 *     **不孵化执行者**。按钮回包携带 note：「请键入本任务的初始指令」。
 *   · 等待用户**下一条人类消息**：主循环收到后，本插件把该消息原文（含附件
 *     描述）作为执行者的任务孵化 continuable child，同时把任务转达给主上下文
 *     （执行者已在干活，主上下文不要重复执行——见 armed-phase 收尾提示）。
 *     phase=running。执行者完成（settlement）→ 产出报告送达主上下文。
 *   · **报告送达即评估**（挑刺者第一轮）：子代理结果落进主上下文的同一拍，
 *     本插件注入「挑刺者评估轮」——挑刺者以主上下文视角评估报告。
 *   · **用户手动停止**＝ phase=armed（回收 child、摘人格改为待命形态）：
 *     等待用户补充指令，**不挑刺**。再次收到用户消息 → 重新孵化（新 child）。
 *   · **只有智能体主动停止才挑刺**：child 自然完成/失败（completed/error/
 *     aborted/refusal/max-tokens）都触发评估轮；其中 completed 之外还会让
 *     挑刺者说明执行者中止的原因。用户手动停止（本插件主动 dispose）不发评估。
 *   · 点「停止」（armed 态）＝ 完全解除武装：摘人格、清状态。
 *
 * 子代理投递细节（对齐 dsh-subagent 的真实形态，v3 起）：
 *   · 孵化：startActivation({ provider:'spawn', label:'双主智能·执行者',
 *     request:{ prompt:[…任务内容块], parent, signal }, delivery:'caller' })。
 *     spawn provider 支持 continuable（prepareContinuable 在场）。
 *   · 结果：caller 模式**不会**自动投 settlement notice、也不唤醒主 Agent；报告由
 *     编排 `await activation.result` 取回（{output, stopReason}），内嵌进评估消息。
 *   · 评估触发：结算点唯一（上面那根 await）；本插件把「报告原文 + 评估指令」合成
 *     恰一条 followup 注入主上下文。v18 起这根 await 不再是唯一收尾手段：实例被
 *     重载丢掉它时，reconcileSession 会用「活的执行者 + 落盘记录」把状态收敛回来
 *     （接管活执行者 / 读回已结束执行者的报告 / 幽灵 running 收回待命）。
 *   · 中断：停止时 subagents.interrupt(childId, {kind:'user', parentSessionId})，
 *     不产生评估（这是用户手动停止）。
 *
 * @module dsh-dual-agent
 *
 * ── v4（2026-11-03，用户指令「把子代理模型设置和双主智能合并为一个插件，更名
 *    双智能指导，在工作箱里开一个可进入的二级菜单」）─────────────────────────
 * 合并了三件事，一个开关总控：
 *   ① 双主智能（原样保留）：执行者=后台 subagent，挑刺者=主上下文评估人格。
 *   ② 子代理模型链（原 dsh-subagent-models）：有序候选 + 限额 + 失败自动回退 +
 *      计入供应池。孵化执行者时走**官方 agentOptions**（subagents 的
 *      SubagentStartRequest.agentOptions = {provider, model}），请求期改路由
 *      （agent/request waterfall）留作嵌套子代理与回退的兜底。
 *   ③ 主智能约束 + 出处程序核验（本次新增）：使能后主会话**只判断不动手**
 *      （tools guard 按调用者身份精确拒绝，子代理不受影响），并且子代理回报里的
 *      出处必须由确定性代码逐条核对（文件系统 / 会话记录 / 算术 / 可选 HTTP），
 *      核验实况与报告一起进主上下文——「不符」和「无法核验」都不许当成事实。
 * 二级菜单的内容在本插件（/dsh-dual-agent/menu），渲染在 dsh-workbench（它只认
 * 通用件），工作箱继续「编排者，不实现」。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CHECK_KINDS, extractEvidence, renderVerdict, verifyEvidence, verdictSummaryLine } from './dg-verify.js?v=dg-2';
import { attachChain } from './dg-chain.js?v=dg-2';
import { attachEnforce } from './dg-enforce.js?v=dg-2';
import { attachMenu } from './dg-menu.js?v=dg-2';

export const name = 'dual-agent';

/** 界面上的名字（工作箱行、状态文案、拒绝理由都走这里）。 */
const LABEL = '双智能指导';

/**
 * agents（Agent 注册表）与 tools（工具注册表，主智能约束要用 guard）必选；
 * webServer / llm / subagents / sessionQuery **不在 inject 里**——headless/SDK 这类
 * composition 没有 webServer，硬注入会让整个插件 pending、双智能指导在命令行宿主里
 * 根本装不上。用 `ctx.get(...)` 做可选查找（未注入的服务 ctx.get 安全返回
 * undefined，而 `ctx.webServer` 属性访问会抛）；有 webServer 才挂工作箱/菜单路由。
 */
export const inject = ['agents', 'tools'];

const ROUTE = '/dsh-dual-agent';
const STATE_VERSION = 3;

/**
 * v21：家族设置快照的落盘上限。家族按「武装过的根会话」积累，长期运行的宿主可能
 * 攒下大量一次性会话的家族；超过上限按 since（最近一次写入时刻）淘汰最旧的——
 * since 在每次写入时刷新（LRU 口径），让还在活跃使用的家族不被淘汰。
 */
const FAMILY_LIMIT = 200;

/** 挑刺者人格段（主上下文常驻，armed/running 都在场）。 */
const CRITIC_SECTION = 'dual-agent:critic';
/** 武装期主上下文说明段（告诉主上下文「下一句用户输入是任务」）。 */
const ARMED_SECTION = 'dual-agent:armed';
/** running 期主上下文说明段（执行者已在干活，主上下文不重复执行）。 */
const RUNNING_SECTION = 'dual-agent:running';
/** 出厂段 order 落在 -100..190 区间，取 10300+ 排在其后；段名不与任何出厂段重名。 */
const ORDER_BASE = 10300;

/**
 * 多轮修正的评估历史：往下一轮执行者上下文里带的**最近几条挑刺结论**。
 * 只带结论正文（各截到 CRITIQUE_HISTORY_ITEM_LIMIT），不带带报告的注入消息——
 * 后者体积大且执行者不需要复读报告。深度 CRITIQUE_HISTORY_DEPTH 保证有界：
 * 用户说「把前两个问题都修了」时，执行者看得到最近几轮分别提了什么。
 */
const CRITIQUE_HISTORY_DEPTH = 3;
const CRITIQUE_HISTORY_ITEM_LIMIT = 2_000;

/**
 * 状态自愈（v18，2026-10-30 用户报障「后台子代理结束、前台仍显示执行中」）。
 *
 * 在途编排（runs）只活在本插件实例里：一次 profile 重载（装/更任何插件都会
 * 重建插件实例）就把 runs 连同 await 着的 activation.result 一起丢掉，而落盘
 * 记录仍是 running，于是 /status 照着记录宣称「执行者独立工作中」——执行者早已
 * 结束、报告却永远不会回来，前台永远停在执行中。
 *
 * 两条时间常量：
 *   · HATCH_GIVE_UP_MS  孵化窗口上限。正常几十毫秒就能拿到 childId；超过就当
 *     startActivation 卡死，收敛回待命（否则运行态会永远挂着）。
 *   · ADOPT_POLL_MS/ADOPT_IDLE_TICKS  重载后接管活执行者的观察节奏：连续两拍
 *     「idle 且 inbox 空」才算停（第一拍可能是它还没起跑就被看到 idle）。
 */
const HATCH_GIVE_UP_MS = 180_000;
const ADOPT_POLL_MS = 1_000;
const ADOPT_IDLE_TICKS = 2;
/**
 * 回扫会话事件找「最后一个 turn/end」的窗口。执行者一个回合几百条事件是常态
 * （实测单回合 640+ 条），窗口太小会把本回合的结局漏掉，导致体检/死因读取失效。
 * 只在异常路径上读一次，取 5000 换取确定性。
 */
const TURN_SCAN_WINDOW = 5_000;

/**
 * 系统性失败判据（v19，2026-10-31 用户报障「主线程给出要求后子代理未正确产生」）。
 *
 * 现场：用户把模型切成 `deepseek-v4.1-flash + reasoningEffort:"max"`（该模型不支持
 * 这个组合）。于是执行者继承同一配置，第一步就 `UNSUPPORTED_REASONING_EFFORT` 死掉；
 * 结算后编排照常注入挑刺评估轮，主会话用的是**同一套坏配置**，于是主会话里连出
 * 三条 error 回合（评估 / 重试 / 兜底说明）——用户看到的就是「直接结束、什么也没干」。
 *
 * 结论：这类错误对父子是**共用**的（provider/model/effort/额度/上下文窗口都一样），
 * 再注入评估轮只是把同一个错误在主会话里重复播放。判定为系统性失败时：
 *   · 孵化前体检不过 → 不压制、不孵化，让主线程自己把内核的真实错误摆给用户；
 *   · 结算/评估轮失败 → 不重试、不再投兜底说明，只把原因写进 status note。
 * 宁可少说话，也不要制造一连串看起来像插件坏了的错误回合。
 */
const SYSTEMIC_FAILURE_PATTERNS = [
  /unsupported[_\s-]?reasoning[_\s-]?effort/i,
  /reasoning effort/i,
  /does not support|not support/i,
  /model (?:not found|does not exist|unavailable|is not available)/i,
  /unknown model|invalid model/i,
  /invalid api key|unauthorized|authentication|forbidden|permission denied/i,
  /quota|insufficient (?:balance|credit|quota)|rate limit|too many requests/i,
  /no available|all channels|provider .*(?:unavailable|error|failed)/i,
  /context (?:length|window)|too many tokens|maximum context|context_length_exceeded/i,
];

/** 一段错误文本是否属于「父子都会犯」的系统性失败。 */
const isSystemicFailure = (text) => {
  if (typeof text !== 'string' || text === '') return false;
  return SYSTEMIC_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
};

/** 供 status 透出的构建标识（诊断用：确认进程里跑的是哪一版）。 */
const BUILD = '4.1.0+family';

/**
 * 出厂设置（row config 可覆盖；二级菜单改的是**运行时**设置并落盘）。
 *
 * guidance.enforce=false 时插件仍做编排与核验，只是不拦主智能的工具调用；
 * verify.urlChecks 默认关——联网核验要有用户明确同意（见二级菜单的提示）。
 */
const DEFAULTS = {
  guidance: { enforce: true, mode: 'strict', hideMainTools: false, extraAllowed: [], orchestrate: false },
  verify: {
    enabled: true,
    requireEvidence: true,
    urlChecks: false,
    delegation: true,
    maxClaims: 40,
    readLimitBytes: 256 * 1024,
    timeoutMs: 8000,
  },
  models: { applyChain: true },
};

/** 设置项 id → 写路径（二级菜单只认这些 id，别的一律拒绝，避免盲写）。 */
const SETTING_PATHS = {
  enforce: ['guidance', 'enforce'],
  mode: ['guidance', 'mode'],
  hideMainTools: ['guidance', 'hideMainTools'],
  extraAllowed: ['guidance', 'extraAllowed'],
  // v4.1（2026-11-03 用户指令「新的插件就不需要阻塞主会话了」）：旧双主智能那套
  // 「接管主会话 → 后台执行者 → 挑刺者回传」保留为**可选**，默认关。关着时人类
  // 消息完全归主智能自己判断（它用 subagent 工具派活），主会话不会再被 cancel。
  orchestrate: ['guidance', 'orchestrate'],
  applyChain: ['models', 'applyChain'],
  'verify.enabled': ['verify', 'enabled'],
  'verify.requireEvidence': ['verify', 'requireEvidence'],
  'verify.urlChecks': ['verify', 'urlChecks'],
  'verify.delegation': ['verify', 'delegation'],
};

const deepClone = (value) => JSON.parse(JSON.stringify(value));

/** row config 与出厂值合并（只认已知字段，形状不对就整个回落到默认）。 */
function resolveConfig(config = {}) {
  const merged = deepClone(DEFAULTS);
  for (const group of ['guidance', 'verify', 'models']) {
    const incoming = config?.[group];
    if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) continue;
    for (const [key, value] of Object.entries(incoming)) {
      if (merged[group][key] === undefined) continue;
      if (key === 'extraAllowed') {
        merged.guidance.extraAllowed = Array.isArray(value) ? value.filter((name) => typeof name === 'string' && name !== '') : [];
        continue;
      }
      if (key === 'mode') { merged[group].mode = value === 'readonly' ? 'readonly' : 'strict'; continue; }
      if (typeof merged[group][key] === 'number') {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) merged[group][key] = n;
        continue;
      }
      if (typeof merged[group][key] === 'boolean') merged[group][key] = value === true;
    }
  }
  merged.autoArmForNewSessions = config?.autoArmForNewSessions === true;
  return merged;
}

/** 证据协议文本（同一个来源给三处用：任务尾、行为段、二级菜单）。 */
function evidenceProtocol() {
  return `在收尾报告的**最后**给出 ⟦证据⟧ 与 ⟦/证据⟧ 包裹的 JSON 数组，每项形如 `
    + `{"claim":"一句人话声称","check":{"kind":"file_contains","path":"相对或绝对路径","needle":"文件里应出现的文本"}}。`
    + `可用 kind 与字段：${CHECK_KINDS.join(' / ')}。`
    + `规则：只写**真实存在**的出处（文件路径+行号、你确实调用过的工具与其结果、可访问的 url、可重算的数字）；`
    + `命令类声称必须用 session_tool（由你的会话日志里真实存在的 tool/call 佐证）来核，不要用 command 让编排去重跑命令；`
    + `没有把握的结论不要写进证据块——程序核验会把「无法核验」原样标出来，不会替你圆场。`;
}


// ── 挑刺者人格与提示段 ─────────────────────────────────────────────────────

const CRITIC_PROMPT = `你是本会话的「挑刺者」主智能，站在**用户（主上下文）的视角**工作。

你的职责：对「双主智能·执行者」（一个后台 subagent）送回主上下文的**报告**做评估。
- 评估只在执行者报告送达时进行（带【挑刺者评估】标记的轮次）。平时你不出声。
- 不管报告质量是否真的达标，永远主张它不符合用户的要求：从用户的要求原文里抽取角度（显式的、隐式的都算），逐轮换角度不重复，主张「在这个角度上，报告与用户要求之间仍有差距」，并要求主上下文向执行者补充修正指令。
- 每次评估明确给出：①该角度对应的用户目的；②可验证的指标表达；③报告当前在该指标上的表现与差距。
- **指标的「表现力」是你的核心追求**：同一轮用户目的可以用很多种指标表达，你要逐轮找到**更有表现力**的那个——更接近用户真实意图、更不容易被虚假达标蒙混、更容易用一句话判定过不过。已用过的指标不要再原样重复；若上一轮的指标太钝（例如「功能是否正确」这种无法判定对错的表述），就在本轮换一个更锋利的表述（例如「在 X 输入下是否返回 Y」）。
- 不要判定质量达标——那是用户本人的事。你的价值是把用户目的拆成越来越多、越来越有表现力的验证指标。
- 你不执行任务、不代替主上下文回复用户，只输出评估。`;

const ARMED_PROMPT = `【双主智能·待命中】用户已通过工具箱启动双主智能。用户键入的**下一条消息**就是本任务的初始指令：不要自己着手执行，等待编排（该消息会被原样交给后台执行者 subagent，并附上回传与继续指令）。`;

const RUNNING_PROMPT = `【双主智能·执行中】本任务的执行者是后台 subagent，正在独立干活。它结束后由编排把报告取回并送入本会话（届时会有一条带【挑刺者评估】标记的轮次）。在报告送达之前：不要重复执行任务本体；用户在此时补充的要求会由编排直接转达给执行者——**转达成功时编排保持静默**（你不会收到任何回执，这是正常现象，不要自己代替编排声明"已转达"）；只有转达失败时你才会收到【双主智能编排】开头的失败说明。`;

/**
 * 孵化执行者的任务提示 = 用户消息原文 + 回传指令。
 * ⚠ caller 模式下内核**不会**给 child 追加 continuable return guidance（源码核实：
 *   `spec.delivery !== "caller" && ...`），所以 child 没有任何「中途给父会话发消息」
 *   的通道——它写的中间文本只会留在自己的会话里。因此这里**不能**告诉它可以
 *   「提前用文字小结」汇报（那会诱导它产出没人看得见的输出）。只要求收尾自足报告。
 */
/**
 * 孵化执行者的任务提示 = 用户消息原文 + 回传指令（+ 出处协议）。
 * ⚠ caller 模式下内核**不会**给 child 追加 continuable return guidance（源码核实：
 *   `spec.delivery !== "caller" && ...`），所以 child 没有任何「中途给父会话发消息」
 *   的通道——它写的中间文本只会留在自己的会话里。因此这里**不能**告诉它可以
 *   「提前用文字小结」汇报（那会诱导它产出没人看得见的输出）。只要求收尾自足报告。
 *
 * v4 起在核验开启时追加**证据协议**：这是「子代理给出的信息必须标明出处」的落点。
 * 协议文本与程序核验器（dg-verify）共用一份 kind 清单，写了核不了的 kind 会被
 * 明说「不支持的核验类型」，不静默放过。
 */
function childTaskTail(verifyEnabled) {
  const base = `\n\n（编排说明：你是「${LABEL}」的执行者。请专注完成任务，并在**收尾消息**里给出**自足的最终报告**——它会被原样送回主上下文做评估。除此之外没有别的特殊流程。）`;
  if (verifyEnabled !== true) return base;
  return `${base}\n\n（出处要求：主上下文不会凭你一句话就采信，编排会用确定性代码逐条核对你的报告。${evidenceProtocol()}）`;
}

/**
 * 挑刺者评估轮注入文案。
 * ⚠ 执行者用 `delivery:'caller'` 孵化——结算**不**自动投递 settlement notice，主会话
 * 本来看不到报告。所以报告文本必须由编排**内嵌**进这条评估消息；否则主上下文无从评估。
 */
/**
 * 停止情形的人话表述：completed 才是「完成」；error/max-tokens/refusal 等都要说清
 * 是异常中止——否则「已完成任务（停止原因：error）」这种自相表述会让挑刺者误判
 * （沙箱真模型实测过 stopReason:'error' 这条路）。
 */
const stopReasonLabel = (stopReason) => {
  switch (stopReason) {
    case 'completed': return '已完成任务';
    case 'aborted': return '被中断（未正常完成）';
    case 'error': return '因错误中止（未完成）';
    case 'max-tokens': return '因达到长度上限中止（未完成）';
    case 'refusal': return '因拒答中止（未完成）';
    default: return `已停止（${stopReason}）`;
  }
};

const criticEvaluatePrompt = (childId, stopReason, reportText) => `【挑刺者评估】执行者（subagent ${childId}）${stopReasonLabel(stopReason)}。它送回的报告如下：

⟦执行者报告 开始⟧
${reportText}
⟦执行者报告 结束⟧

请以主上下文视角评估这份报告：永远主张它不符合用户的要求，从用户的要求原文里抽一个尚未用过的角度，给出①用户目的、②可验证指标、③当前表现与差距，并说明执行者停止情形（${stopReason}）对结论的影响。

指标要有**表现力**：宁可「在 X 输入下必须返回 Y」这种一句可判定的表述，也不要「功能要正确」这种无法判定的空话；上一轮用过的指标不要原样重复，能更锋利就更锋利。

（提醒：本消息来自挑刺者主智能。它不判定真实质量，只负责点名角度。角度取舍与完成判定归用户。不要重复执行任务本体。）`;

/** 用户手动停止（running→armed）后，告知主上下文当前形态的注入。 */
const backToArmedPrompt = `【双主智能编排】执行者已按用户要求停止（这一停不触发挑刺评估）。双主智能回到待命状态：等待用户补充或给出新的初始指令；用户键入下一条任务消息时会重新孵化执行者。`;

// ── 落盘（与 v1 同款纪律；v2 多 phase 字段） ───────────────────────────────

function defaultStateFile() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, 'dual-agent.json');
}

function expandHome(path) {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function errorText(error) {
  return String(error instanceof Error ? error.message : error);
}

function createStore(file, onError) {
  let doc = { version: STATE_VERSION, sessions: {}, settings: null, chains: [], families: {}, chainTemplate: null };
  let error = null;
  const read = () => {
    try {
      if (!existsSync(file)) return;
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      const sessions = parsed.sessions !== undefined && parsed.sessions !== null && typeof parsed.sessions === 'object'
        ? Object.fromEntries(Object.entries(parsed.sessions).filter(([key, value]) =>
          typeof key === 'string' && key !== '' && value !== null && typeof value === 'object'
          && (value.phase === 'armed' || value.phase === 'running')))
        : {};
      // v2 文件没有 settings/chains：读不到就留 null/[]，首次写入时补上（不硬要求）。
      const settings = parsed.settings !== null && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)
        ? parsed.settings : null;
      const chains = Array.isArray(parsed.chains) ? parsed.chains : [];
      /**
       * v21 家族快照与链模板（纯增量：旧文件没有这两个键 → 读成空表/null，
       * STATE_VERSION 保持 3，读取端永远不要求它们存在）。
       * 净化口径与 settings/chains 一致：形状不对整条丢弃（防御式回落，不抛）。
       */
      const families = parsed.families !== null && typeof parsed.families === 'object' && !Array.isArray(parsed.families)
        ? Object.fromEntries(Object.entries(parsed.families).filter(([key, value]) =>
          typeof key === 'string' && key !== ''
          && value !== null && typeof value === 'object' && !Array.isArray(value)
          && value.settings !== null && typeof value.settings === 'object' && !Array.isArray(value.settings)))
        : {};
      const chainTemplate = parsed.chainTemplate !== null && typeof parsed.chainTemplate === 'object'
        && !Array.isArray(parsed.chainTemplate)
        && Array.isArray(parsed.chainTemplate.candidates)
        ? parsed.chainTemplate
        : null;
      doc = { version: STATE_VERSION, sessions, settings, chains, families, chainTemplate };
    } catch (cause) {
      error = `读取失败（${errorText(cause)}），内存态照常，重写可自愈`;
      onError?.(cause);
    }
  };
  read();
  const write = () => {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      error = null;
    } catch (cause) {
      try { if (existsSync(tmp)) renameSync(tmp, `${tmp}.dead`); } catch { /* 尽力 */ }
      error = `写入失败（${errorText(cause)}），状态只在内存，重启会丢`;
      onError?.(cause);
    }
  };
  return {
    file,
    get error() { return error; },
    recordOf(sessionId) {
      return doc.sessions[sessionId] ?? { phase: 'off' };
    },
    setPhase(sessionId, phase, extra = {}) {
      read();
      if (phase === 'off') delete doc.sessions[sessionId];
      else doc.sessions[sessionId] = { phase, since: Date.now(), ...extra };
      write();
    },
    /** 运行时设置（二级菜单改的那些）；null=用户从没改过，走 row config/默认值。 */
    settingsOf() { return doc.settings; },
    setSettings(settings) {
      read();
      doc.settings = settings;
      write();
    },
    /** 子代理模型链：只落候选与限额，**不落**用量计数（重启后计数归零才诚实）。 */
    chainsOf() { return doc.chains; },
    setChains(chains) {
      read();
      doc.chains = Array.isArray(chains) ? chains : [];
      write();
    },
    /**
     * v21 家族设置快照：按根会话 id 各存一份完整 settings + 最近写入时刻。
     * 读不写盘（settingsFor 每 8s 的 /status 轮询走的就是它——只读绝不物化）；
     * 写前 read() 合并（与 setPhase/setChild 同款纪律）、tmp+rename 原子写。
     */
    familyOf(rootId) {
      const entry = doc.families[rootId];
      return entry === undefined ? null : entry;
    },
    /** 全部家族快照的当前形状（只读快照；全局 setSetting 用它遍历所有家族）。 */
    familiesOf() { return doc.families; },
    /** 全部会话记录（只读；升级路径用它找「落盘里已武装的会话」）。 */
    sessionsOf() { return doc.sessions; },
    setFamily(rootId, settings) {
      if (typeof rootId !== 'string' || rootId === '' || settings === null
        || typeof settings !== 'object' || Array.isArray(settings)) return;
      read();
      doc.families[rootId] = { settings, since: Date.now() };
      // 上限淘汰：超出 FAMILY_LIMIT 按 since 淘汰最旧（活跃家族 since 不断刷新，
      // 被淘汰的总是不再使用的旧家族）。
      const ids = Object.keys(doc.families);
      if (ids.length > FAMILY_LIMIT) {
        for (const stale of ids
          .sort((left, right) => (doc.families[left]?.since ?? 0) - (doc.families[right]?.since ?? 0))
          .slice(0, ids.length - FAMILY_LIMIT)) {
          delete doc.families[stale];
        }
      }
      write();
    },
    /** 链模板（最近一次经二级菜单配置的链；null=从未配过或已 clear）。 */
    chainTemplateOf() { return doc.chainTemplate; },
    setChainTemplate(template) {
      read();
      doc.chainTemplate = template;
      write();
    },
    setChild(sessionId, childId) {
      read(); // 与 setPhase 同款：写前重读，合并别的进程写的其它会话记录。
      const record = doc.sessions[sessionId];
      if (record === undefined) return;
      record.childId = childId;
      record.phase = 'running';
      record.updatedAt = Date.now();
      write();
    },
    /**
     * 把会话记录收回待命并摘掉 childId。
     *
     * @returns 是否由**本次**调用兑现。落盘里的 childId 是一次性令牌：重载前后
     *   两个插件实例可能同时发现「执行者没了」，只有真正摘掉 childId 的那一个
     *   负责往主上下文投递评估/说明——否则同一份报告会被注入两次。
     */
    clearChild(sessionId) {
      read();
      const record = doc.sessions[sessionId];
      if (record === undefined) return false;
      const claimed = record.childId !== undefined;
      delete record.childId;
      record.phase = 'armed';
      record.updatedAt = Date.now();
      write();
      return claimed;
    },
  };
}

// ── HTTP 小件（同源守卫，与部署其它插件同口径） ────────────────────────────

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  if (origin === 'null') return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const jsonOf = (res) => (status, value) => {
  if (res.headersSent === true) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};

function readBody(req, limit) {
  return new Promise((settle) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => { if (!done) { done = true; settle(value); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, error: '请求体过大' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', (cause) => finish({ ok: false, error: errorText(cause) }));
  });
}

// ── 主上下文消息投递（followup 才唤醒；形态与 v1 相同并经自测） ─────────────

/**
 * 编排消息：以**生产者自有** kind 投递（不是人类输入，也不是已退役的裸 'plugin'）。
 *
 * ⚠ `kind: 'plugin'` 是 v3 的旧包装器，v4 会话格式**硬拒绝**（见 dsh-session-format-v3-to-v4
 * 的 `format v4 message requires a producer-owned source kind`）；用了它会让该会话的
 * jsonl 持久化整批失败并进入 drainPaused —— 历史从此不再落盘。必须写 `plugin:<name>`。
 *
 * 源不是 `kind:'user'`，所以孵化监视器（只认带 rpcId 的人类消息）绝不会把编排
 * 消息再当任务——这是孵化路径的正确性前提，不是可选的礼节。
 */
function orchestratorMessage(text) {
  return {
    id: `da2-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-dual-agent', form: 'notice' },
  };
}

/** 编排消息的固定前缀（防御：即便同源形态被人为伪造也不误判为任务）。 */
const ORCHESTRATOR_PREFIXES = ['【挑刺者评估】', '【双主智能编排】', '【程序核验】', `【${LABEL}】`, `【${LABEL}编排】`];

// ── 角度抽取（评估轮从用户原文抽角度；逻辑与 v1 相同） ─────────────────────

/**
 * 要求暗示词：命中即认为该片段是「用户明确提出的可验证要求」。
 * ⚠ 不要用单字 '要'/'需'：'要' 会命中「会议要点 / 重要 / 只要」，'需' 会命中
 * 「需求 / 所需」这类普通名词，把任务复述误判成要求（沙箱自测实测到
 * 「会议纪要」因含 '要' 被误标为 hinted）。用多字形式规避。
 */
const REQUIREMENT_HINTS = ['要求', '需要', '须要', '必须', '应该', '不得', '禁止', '更好', '更快', '更少', '更多', '更清晰', '更简洁', '完整', '正确', '准确', '清晰', '简洁', '稳定', '安全', '性能', '可读', '可维护', '测试', '文档', '边界', '异常'];

function recentUserTexts(agent, limit = 6) {
  const texts = [];
  try {
    const messages = agent.session?.deriveMessages?.() ?? [];
    for (let index = messages.length - 1; index >= 0 && texts.length < limit; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'user' || message?.source?.kind !== 'user') continue;
      const text = (message.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (text === '') continue;
      if (text.startsWith('【挑刺者评估】') || text.startsWith('【双主智能编排】')) continue;
      texts.push(text);
    }
  } catch { /* 会话不可读时角度表退化为内置顺序 */ }
  return texts.reverse();
}

/**
 * 从用户原文抽「验证角度」候选。
 *
 * 角度 = 可被验证的维度，不是任务复述。判别（2026-10-30 质量修正）：
 *   · 含要求暗示词（必须/要/更快/完整/稳定/安全/性能/测试/文档/边界/异常…）的片段
 *     = 强信号，收（整条子句就是最有信息量的点名，如「必须支持中文文件名」）；
 *   · 不含暗示词但**短**（≤8 字，名词短语状，如「中文文件名」「响应速度」）=
 *     可能是具体对象/维度，收；
 *   · 不含暗示词又长的 = 几乎总是**整句任务复述**（如「为窗口甲生成季度总结」），
 *     把它当角度点名等于把任务原样打回，对「深化验证指标」零信息量——**不收**，
 *     让位给内置维度角度（FALLBACK_ANGLES）。
 */
/**
 * SubagentResult.output（ContentBlock[]）→ 文本报告，供编排合成评估轮。
 * 截断到 REPORT_EMBED_LIMIT：真实任务的长报告（几十 KB）若整体嵌进评估消息，
 * 每轮都往主会话上下文里灌一遍，既烧 token 又有爆上下文的风险；挑刺者要的是
 * 「可验证指标的表现」，头尾（结论 + 收尾）信息密度最高，中段可弃。
 * 纯函数，host-selftest ㉓ 直接覆盖。
 */
const REPORT_EMBED_LIMIT = 12_000;
export function reportTextOf(result) {
  const out = Array.isArray(result?.output) ? result.output : [];
  const text = out.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('').trim();
  if (text !== '') {
    if (text.length <= REPORT_EMBED_LIMIT) return text;
    const head = text.slice(0, REPORT_EMBED_LIMIT * 0.7);
    const tail = text.slice(-REPORT_EMBED_LIMIT * 0.3);
    return `${head}\n\n…（中段省略 ${text.length - REPORT_EMBED_LIMIT} 字：报告过长，只保留首尾）…\n\n${tail}`;
  }
  return typeof result?.diagnostic === 'string' && result.diagnostic !== ''
    ? `（执行者无正文，附诊断：${result.diagnostic}）`
    : '（执行者未产出可读正文）';
}

export function extractAngles(texts) {
  const angles = [];
  const seen = new Set();
  for (const text of texts) {
    const pieces = text.split(/[\n。；;，,、！!？?]+/);
    for (const piece of pieces) {
      const trimmed = piece.trim();
      if (trimmed.length < 2 || trimmed.length > 28) continue;
      if (seen.has(trimmed)) continue;
      const hinted = REQUIREMENT_HINTS.some((hint) => trimmed.includes(hint));
      // 无暗示词的长片段 = 任务复述，不当角度（见上）。
      if (!hinted && trimmed.length > 8) continue;
      if (!hinted && !/^[\u4e00-\u9fa5A-Za-z0-9·\- ]+$/.test(trimmed)) continue;
      seen.add(trimmed);
      angles.push({ text: trimmed, hinted });
    }
  }
  return angles.sort((left, right) => Number(right.hinted) - Number(left.hinted));
}

/**
 * 内置维度角度（用户原文抽不出可验证维度时的候补）。
 * 设计意图（对应用户「深化用户目的的不同验证指标、发现更多有表现力的指标」）：
 * 每条都是一个**可验证的维度**，且互不重叠——按序消耗，让连续评估轮持续换角度。
 */
const FALLBACK_ANGLES = [
  '用户没有说出口的隐含期望',
  '产出与用户原始措辞的逐字对齐',
  '边界与异常情形的覆盖',
  '可验证指标是否被明确表达',
  '表现力：同样的指标有没有更直接的呈现方式',
  '结论的可复现性：换个人按报告能否得到同样判断',
  '过度声称：有没有把未验证的部分说成已验证',
  '颗粒度：结论是否细到能指出具体位置/行号/字段',
  '反例压力：举一个能推翻结论的输入',
  '时效与范围：结论是否只对当前范围成立、有没有越界',
];

function nextAngle(agent, used) {
  const angles = extractAngles(recentUserTexts(agent));
  for (const angle of angles) {
    if (!used.has(angle.text)) return angle.text;
  }
  for (const angle of FALLBACK_ANGLES) {
    if (!used.has(angle)) return angle;
  }
  const oldest = used.values().next();
  if (oldest.done) return FALLBACK_ANGLES[0];
  used.delete(oldest.value);
  used.add(oldest.value);
  return oldest.value;
}

/** 评估轮的角度（评估提示里点名角度，比 v1 的纯转发更有导向）。 */
function criticEvaluateWithAngle(agent, used, childId, stopReason, reportText) {
  const angle = nextAngle(agent, used);
  used.add(angle);
  return criticEvaluatePrompt(childId, stopReason, reportText) + `\n\n本次评估点名的角度：「${angle}」。`;
}

// ── 插件主体 ───────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const configuredFile = typeof config.stateFile === 'string' ? config.stateFile.trim() : '';
  const stateFile = configuredFile === '' ? defaultStateFile() : resolve(expandHome(configuredFile));
  const store = createStore(stateFile, (cause) => {
    ctx.logger?.warn?.('dsh-dual-agent: 状态落盘读写失败', cause);
  });

  /**
   * 每个会话的编排簿（内存真值）：
   *   phase: 'armed' | 'running'
   *   dispose: 摘主上下文人格段（armed↔running 切换时整体重建）
   *   used: 挑刺角度集合
   *   childId: running 时的执行者 session id
   *   hatchedSeq: 已用于孵化的 user/message seq（防重复孵化）
   *   watchDispose: 孵化监视器的拆除函数
   *   hatchDispose: 执行者 activation 的 dispose（关闭时释放，可选）
   *   hatchAt: 最近一次孵化成功时刻（epoch ms）。status 透出它，客户端据此走
   *     **每秒**的实时时长（服务端 note 只在 8s 轮询刷新，会一跳一跳）。
   */
  const runs = new Map();

  const agentOf = (sessionId) => {
    try { return ctx.agents.get(sessionId) ?? undefined; } catch { return undefined; }
  };

  const subagentsOf = () => {
    try { return ctx.get('subagents'); } catch { return undefined; }
  };

  // ── v4 合并面：运行时设置 · 子代理模型链 · 主智能约束 · 二级菜单 ────────────
  //
  // 三层状态各有唯一写者，别互相抄：
  //   settings        用户级规则（约束力度/核验开关/是否走链）→ 落盘 doc.settings
  //   chain           每会话的模型候选与限额 → 落盘 doc.chains（计数不落盘）
  //   runs            每会话的编排簿（off/armed/running）→ 落盘 doc.sessions
  //
  // v21 语义分层（用户需求：跨会话持久 + 按家族隔离 + 新会话继承）：
  //   template（模板）= `settings` 对象 + doc.settings：**最近保存的偏好**，供新
  //     家族初始化时继承（settingsView() 无参 / dualAgent.settings 无参都回它）。
  //   family snapshot（家族快照）= doc.families[rootId].settings：某根会话家族
  //     武装时刻物化的完整 settings；该家族此后改设置只写自己的快照 + 同步模板。
  /** row config 打底，落盘的用户改动盖在上面（同一套清洗，形状不对就整组回落）。 */
  let settings = (() => {
    const base = resolveConfig(config);
    const saved = store.settingsOf();
    if (saved === null || saved === undefined) return base;
    const sanitized = resolveConfig(saved);
    return {
      ...base,
      ...sanitized,
      guidance: { ...base.guidance, ...sanitized.guidance },
      verify: { ...base.verify, ...sanitized.verify },
      models: { ...base.models, ...sanitized.models },
    };
  })();

  const log = (level, text) => {
    try { (ctx.logger?.[level] ?? ctx.logger?.info ?? console.log)?.(text); } catch { /* 日志不致命 */ }
  };

  /** 总开关：该会话是否已使能本插件（armed/running 都算）。 */
  const isEnabled = (sessionId) => runs.get(sessionId) !== undefined;

  /** 该会话是不是根会话（子代理永远不是——它是干活的那一方，不受约束）。 */
  const isRootSessionId = (sessionId) => {
    const agent = agentOf(sessionId);
    const header = agent?.session?.header;
    if (header === undefined || header === null) return true;
    return typeof header.parentSession !== 'string' || header.parentSession === '';
  };

  /** 隐藏清单被自检撤销时的原因（status note 与二级菜单都要能说出来）。 */
  let degradeNote = null;

  const chain = attachChain(ctx, {
    // 门：模型链只在「本会话使能了本插件 + 用户没关掉走链」时改路由。
    // v21：rootId 即家族根——applyChain 按该家族自己的快照取（无快照回模板）。
    gate: (rootId) => settingsFor(rootId).models.applyChain === true && isEnabled(rootId),
    persist: () => { try { store.setChains(chain.serialize()); } catch (cause) { log('warn', `${LABEL}: 模型链落盘失败：${errorText(cause)}`); } },
    log: (level, text) => log(level, text),
  });
  const restoredChains = chain.restore(store.chainsOf());

  const enforce = attachEnforce(ctx, {
    label: LABEL,
    isEnabled: (sessionId) => isEnabled(sessionId) && isRootSessionId(sessionId),
    // v21：settings 按**调用者会话**取——行为段文本、允许清单、guard 拒绝口径
    // 全部跟随该会话所属家族的快照（无快照回模板），不再全局共享同一份。
    settings: (sessionId) => settingsFor(sessionId).guidance,
    evidenceFormat: () => evidenceProtocol(),
    agentOf,
    onDegrade: (reason) => { degradeNote = reason; },
    log: (level, text) => log(level, text),
  });

  /** 最近一次核验摘要（每会话一条，给二级菜单顶部显示；不落盘——它是瞬时实况）。 */
  const verifySummaries = new Map();

  // ── v21 家族隔离：settingsFor / initFamily / setSetting(sessionId) ─────────
  //
  // 用户需求的三条语义：
  //   ① 跨会话持久化（既有行为，保持）：模板落盘 doc.settings。
  //   ② 按会话家族隔离：家族=根会话（沿 session.header.parentSession 上溯，
  //     等价 dg-chain 的 lineageOf/rootId——已导出 lineageRoot 可复用）；每个家族
  //     在武装时刻从模板深拷贝一份快照落盘 doc.families[rootId]，此后该家族里改
  //     设置只写自己的快照（+同步模板），其它家族已生效的策略不受影响。
  //   ③ 新会话继承最近保存的偏好：initFamily 从当前模板物化；链模板（最近一次经
  //     二级菜单配置的链）也一并复制给尚无自己链的新家族。

  /**
   * 会话 → 所属家族根 id。子代理沿 parentSession 上溯到根（与 dg-chain 的
   * lineageRoot 同语义，直接复用它，保证链与设置看到的是同一个「家族」）；
   * 取不到会话/血缘时回退 sessionId 本身（防御式：宁可按会话隔离也不崩）。
   */
  const familyRootOf = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return sessionId;
    const agent = agentOf(sessionId);
    if (agent === undefined) return sessionId;
    try {
      const rootId = chain.lineageRoot(agent.session);
      return typeof rootId === 'string' && rootId !== '' ? rootId : sessionId;
    } catch { return sessionId; }
  };

  /**
   * 新读取口径：家族有快照 → 回快照；无 → 回模板。**只读不物化**——/status 每 8s
   * 轮询走这里，绝不能在这条路径上写盘（物化只发生在武装时刻的 initFamily）。
   * 快照形状用 resolveConfig 归一（旧版本写入的、或被外手改过的畸形快照自动回落
   * 到「合并模板」的口径，不抛）。
   */
  const settingsFor = (sessionId) => {
    const rootId = familyRootOf(sessionId);
    const entry = typeof rootId === 'string' && rootId !== '' ? store.familyOf(rootId) : null;
    if (entry === null || entry === undefined) return settings;
    const sanitized = resolveConfig(entry.settings);
    return {
      ...settings,
      ...sanitized,
      guidance: { ...settings.guidance, ...sanitized.guidance },
      verify: { ...settings.verify, ...sanitized.verify },
      models: { ...settings.models, ...sanitized.models },
    };
  };

  /** 对外暴露的家族快照形状（只含三组，含 autoArmForNewSessions 之外的诊断口径不进快照）。 */
  const FAMILY_SETTING_KEYS = ['guidance', 'verify', 'models'];

  /**
   * 家族初始化（幂等，只在**武装时刻**调用）：
   *   a. 该家族无 settings 快照 → 从当前模板深拷贝一份落盘（旧会话升级后首次
   *      加载也经武装路径走到这里，完成升级）；
   *   b. 该家族没有自己的模型链（chainView.configured !== true）且存在链模板 →
   *      用 chain.setChain 把链模板复制给它——setChain 的候选自带计数归零，
   *      天然符合「不落用量」的既有纪律（新家族不该继承别的会话的用量）。
   * initFamily 是初始化（落快照 + 抄链），**不改**模板。
   */
  const initFamily = (rootId) => {
    if (typeof rootId !== 'string' || rootId === '') return;
    try {
      if (store.familyOf(rootId) === null || store.familyOf(rootId) === undefined) {
        const snapshot = {};
        for (const group of FAMILY_SETTING_KEYS) snapshot[group] = deepClone(settings[group]);
        store.setFamily(rootId, snapshot);
      }
    } catch (cause) {
      log('warn', `${LABEL}: 家族设置快照落盘失败（root=${rootId}）：${errorText(cause)}`);
    }
    try {
      const template = store.chainTemplateOf();
      if (template !== null && template !== undefined
        && chain.chainView(rootId).configured !== true
        && Array.isArray(template.candidates) && template.candidates.length > 0) {
        chain.setChain(rootId, deepClone(template.candidates), {
          countAuxiliary: template.countAuxiliary === true,
          countTowardPool: template.countTowardPool === true,
        });
        try { store.setChains(chain.serialize()); } catch { /* 尽力；下次链变更会再落 */ }
      }
    } catch (cause) {
      log('warn', `${LABEL}: 家族继承链模板失败（root=${rootId}）：${errorText(cause)}`);
    }
  };

  /** settingsView：无参 = 模板视图（e2e 沙箱与 dualAgent.settings 依赖这个口径）。 */
  const settingsView = (sessionId) => {
    const view = sessionId === undefined ? settings : settingsFor(sessionId);
    return {
      enforce: view.guidance.enforce === true,
      mode: view.guidance.mode === 'readonly' ? 'readonly' : 'strict',
      hideMainTools: view.guidance.hideMainTools === true,
      orchestrate: view.guidance.orchestrate === true,
      extraAllowed: Array.isArray(view.guidance.extraAllowed) ? [...view.guidance.extraAllowed] : [],
      applyChain: view.models.applyChain === true,
      verifyEnabled: view.verify.enabled === true,
      verifyRequireEvidence: view.verify.requireEvidence === true,
      verifyUrlChecks: view.verify.urlChecks === true,
      verifyDelegation: view.verify.delegation === true,
    };
  };

  /** 把一份值按 SETTING_PATHS 写进某个 settings 形状（shared by 家族/模板两条写路）。 */
  const applySettingValue = (target, path, value) => {
    const group = path[0];
    const key = path[1];
    if (key === 'mode') target.guidance.mode = value === 'readonly' ? 'readonly' : 'strict';
    // orchestrate 的「重摆段形态」副作用由 setSetting 的 isOrchestrate 分支按口径
    // （定点 / 全体）处理，这里只落值——applySettingValue 本身必须无副作用外的行为。
    else if (key === 'orchestrate') target.guidance.orchestrate = value === true;
    else if (key === 'extraAllowed') {
      const list = typeof value === 'string'
        ? value.split(/[,，\s]+/).map((name) => name.trim()).filter((name) => name !== '')
        : (Array.isArray(value) ? value.filter((name) => typeof name === 'string' && name.trim() !== '') : []);
      target.guidance.extraAllowed = [...new Set(list)];
    } else if (key === 'enforce') target.guidance.enforce = value === true;
    else if (key === 'hideMainTools') target.guidance.hideMainTools = value === true;
    else if (key === 'applyChain') target.models.applyChain = value === true;
    else if (key === 'enabled') target.verify.enabled = value === true;
    else if (key === 'requireEvidence') target.verify.requireEvidence = value === true;
    else if (key === 'urlChecks') target.verify.urlChecks = value === true;
    else if (key === 'delegation') target.verify.delegation = value === true;
    return { group, key };
  };

  /** 家族快照按同形状重建（模板与快照都过 resolveConfig，两组键必然齐全）。 */
  const snapshotFromTemplate = () => {
    const snapshot = {};
    for (const group of FAMILY_SETTING_KEYS) snapshot[group] = deepClone(settings[group]);
    return snapshot;
  };

  /**
   * 二级菜单的写入口：只认 SETTING_PATHS 里的 id + 两个链开关。
   *
   * v21 双口径：
   *   · 带 sessionId → 写**该家族**快照（无则先从模板物化）+ 同步更新全局模板
   *     （用户刚选的偏好成为后续新会话的继承源）+ 只对**该会话**的 run 重装
   *     enforce/段（其它会话的装配不动——这正是「互不影响」的落点）；
   *   · 不带 sessionId（程序化调用，e2e 沙箱兼容口径）→ 旧语义：写模板 +
   *     **所有**家族快照 + 全部 runs 重装。
   */
  const setSetting = (id, value, sessionId) => {
    const path = SETTING_PATHS[typeof id === 'string' ? id : ''];
    if (path === undefined) return { applied: [], rejected: id };
    // orchestrate 关掉旧编排时要重摆段形态——这条与写哪个快照无关，先记下。
    const isOrchestrate = path[1] === 'orchestrate';
    if (typeof sessionId === 'string' && sessionId !== '') {
      // ── 家族口径：只写该家族快照 + 同步模板 + 定点重装 ──
      const rootId = familyRootOf(sessionId);
      let snapshot;
      const entry = store.familyOf(rootId);
      if (entry === null || entry === undefined) {
        // 该家族还没快照（比如没走过武装路径就经菜单改设置）：先从模板物化，
        // 再把这次改动写上去——快照语义 =「这个家族生效中的策略」。
        snapshot = snapshotFromTemplate();
      } else {
        snapshot = resolveConfig(entry.settings);
      }
      applySettingValue(snapshot, path, value);
      if (isOrchestrate) {
        // orchestrate 关掉时，已武装会话要立刻恢复成「只有约束段」的形状——
        // 但只对**本家族**的会话做（其它家族照旧）。
        const agent = agentOf(sessionId);
        if (agent !== undefined) shapeSections(sessionId, agent);
      }
      store.setFamily(rootId, snapshot);
      // 同步模板：用户刚选的偏好成为后续新会话的继承源（浅层覆盖三组）。
      const template = resolveConfig(settings);
      applySettingValue(template, path, value);
      settings = template;
      store.setSettings(settings);
      // 定点重装：只有该会话（该家族此刻武装着的那个根会话）的 enforce/段要跟新值。
      const agentNow = agentOf(sessionId);
      if (agentNow !== undefined && runs.get(sessionId) !== undefined) {
        try { enforce.install(agentNow); } catch (cause) { log('warn', `${LABEL}: 装约束段失败：${errorText(cause)}`); }
      }
      log('info', `${LABEL}: 设置 ${path[0]}.${path[1]} 已更新（家族=${rootId}）`);
      return { applied: [id] };
    }
    // ── 全局口径（无 sessionId，e2e 沙箱兼容）：模板 + 全部快照 + 全部 runs ──
    const where = applySettingValue(settings, path, value);
    if (isOrchestrate) {
      // 关掉旧编排时，已武装会话要立刻恢复成「只有约束段」的形状（否则主智能还
      // 以为自己在等一个不会来的执行者）。
      for (const sessionId of runs.keys()) {
        const agent = agentOf(sessionId);
        if (agent !== undefined) shapeSections(sessionId, agent);
      }
    }
    store.setSettings(settings);
    // 全部家族快照同步改（程序化调用是「全局设置」语义，与 v20 行为一致）。
    const entryIds = Object.keys(store.familiesOf?.() ?? {});
    for (const rootId of entryIds) {
      const entry = store.familyOf(rootId);
      if (entry === null || entry === undefined) continue;
      const snapshot = resolveConfig(entry.settings);
      applySettingValue(snapshot, path, value);
      store.setFamily(rootId, snapshot);
    }
    // 规则变了 → 已武装会话的行为说明段要按新文本重装（清单隐藏也跟着重算）。
    for (const sessionId of runs.keys()) {
      const agent = agentOf(sessionId);
      if (agent !== undefined) enforce.install(agent);
    }
    log('info', `${LABEL}: 设置 ${where.group}.${where.key} 已更新`);
    return { applied: [id] };
  };

  const menu = attachMenu({
    agentOf,
    statusOf: (sessionId) => statusOf(sessionId),
    chain,
    enforce,
    settings,
    settingsView,
    // v21：菜单的设置读写都带 sessionId（按会话家族隔离）；链变更经 saveChainTemplate
    // 落成「链模板」，供之后新武装的家族继承。
    setSetting: (id, value, menuSessionId) => setSetting(id, value, menuSessionId),
    saveChainTemplate: (template) => {
      try { store.setChainTemplate(template); } catch (cause) { log('warn', `${LABEL}: 链模板落盘失败：${errorText(cause)}`); }
    },
    catalog: async () => chain.refreshCatalog(),
    evidenceFormat: () => evidenceProtocol(),
    verifySummary: (sessionId) => verifySummaries.get(sessionId) ?? null,
    log: (level, text) => log(level, text),
  });

  // v21 升级路径：旧版本落盘里已有 armed/running 的会话（插件重载/升级后它们的
  // 记录仍在）也应完成家族初始化——否则这些会话永远走不到 initFamily（武装时刻
  // 都发生在过去），只能一直回退到模板口径。逐个幂等初始化：无快照的从模板物化，
  // 无链且有链模板的抄一份。会话此刻是否在线无关紧要（initFamily 只碰落盘）。
  try {
    for (const [sessionId, record] of Object.entries(store.sessionsOf?.() ?? {})) {
      if (record?.phase !== 'armed' && record?.phase !== 'running') continue;
      initFamily(sessionId);
    }
  } catch (cause) {
    log('warn', `${LABEL}: 既有武装会话的家族初始化失败：${errorText(cause)}`);
  }

  /** 给主 Agent 装一组人格段（整体可拆）。 */
  const installSections = (agent, names) => {
    const agentCtx = agent.ctx;
    if (agentCtx === undefined) throw new Error('目标 Agent 没有作用域上下文（agent.ctx）');
    const sections = [];
    const effectDispose = agentCtx.effect(() => {
      for (const [index, definition] of names.entries()) {
        sections.push(agentCtx.systemPrompt.section({
          name: definition.name,
          order: ORDER_BASE + index,
          text: definition.text,
        }));
      }
      return () => { for (const dispose of sections.splice(0)) { try { dispose(); } catch { /* 尽力 */ } } };
    }, 'dsh-dual-agent: persona sections');
    // 返回「拆段 + 归还 effect」的合一 disposer：只调内层闭包会在 agent.ctx 的
    // fiber 上留下孤儿 effect 记录，随切换次数线性增长。
    return () => {
      for (const dispose of sections.splice(0)) { try { dispose(); } catch { /* 尽力 */ } }
      try { effectDispose?.(); } catch { /* 尽力 */ }
    };
  };

  const deliver = (agent, text) => {
    try {
      ctx.agents.withoutInitiator(() => { agent.followup(orchestratorMessage(text)); });
      return true;
    } catch (cause) {
      ctx.logger?.warn?.(`dsh-dual-agent: 主上下文消息投递失败（${agent.id}）：${errorText(cause)}`);
      return false;
    }
  };

  /**
   * 等 agent 真空闲后再投递（评估重试/兜底专用）。
   *
   * 为什么微任务不够：turn/end 的观察点跑在该回合**拆解窗口**里——此刻 followup
   * 能落进 inbox（事件流有 agent/inbox/spliced），但主循环「要不要起新回合」的
   * 判定已经做过，唤醒被吞，消息躺死（沙箱真实内核 E2E 实测到）。whenIdle 之后
   * 再补一拍宏任务，拆解彻底结束，投递必然成回合。
   * @param test 投递前的状态守卫（返回 false 则放弃，比如用户已开启新一轮）
   */
  const idleThenDeliver = async (agent, test, label) => {
    try {
      if (typeof agent.whenIdle === 'function') await agent.whenIdle();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      const ok = test();
      if (ok !== true) { ctx.logger?.debug?.(`dsh-dual-agent: ${label} 已过期，不投递`); return; }
      ctx.logger?.info?.(`dsh-dual-agent: ${label} 已投递`);
    } catch (cause) {
      ctx.logger?.warn?.(`dsh-dual-agent: ${label} 投递失败：${errorText(cause)}`);
    }
  };

  /** （重）建会话的段形态：armed = 挑刺者 + 待命说明；running = 挑刺者 + 执行中说明。 */
  const shapeSections = (sessionId, agent) => {
    const run = runs.get(sessionId);
    if (run === undefined) return;
    run.dispose?.();
    // v21：orchestrate 按该会话所属家族的快照取（家族间互不影响）。
    const orchestrate = settingsFor(sessionId).guidance.orchestrate === true;
    // v4.1：旧编排关着时**不装**待命/执行中/挑刺者人格段——主智能只带行为约束段，
    // 人类消息由它自己判断并派活（不再出现「等一个不会来的执行者」的假待命）。
    const names = orchestrate !== true
      ? []
      : run.phase === 'running'
        ? [{ name: CRITIC_SECTION, text: CRITIC_PROMPT }, { name: RUNNING_SECTION, text: RUNNING_PROMPT }]
        : [{ name: CRITIC_SECTION, text: CRITIC_PROMPT }, { name: ARMED_SECTION, text: ARMED_PROMPT }];
    run.dispose = installSections(agent, names);
    // v4：行为约束段跟着重装（它的内容按当前设置现算：模式、隐藏面、证据协议）。
    // 幂等：attachEnforce 内部先拆旧的再装新的，phase 切换不会堆段。
    try { enforce.install(agent); } catch (cause) { log('warn', `${LABEL}: 装约束段失败：${errorText(cause)}`); }
  };

  /** 解除某会话的一切主上下文装配（人格段 + 约束段）。 */
  const unshapeSections = (sessionId) => {
    const run = runs.get(sessionId);
    if (run !== undefined) { run.dispose?.(); run.dispose = undefined; }
    try { enforce.uninstall(sessionId); } catch { /* 尽力 */ }
  };

  /**
   * 孵化执行者（真 subagent，自己的会话）。
   *
   * @param taskBlocks 用户那条消息的**完整**内容块（text / image / file）。
   *   只挑 text 会把「改这张图」这类任务变成空任务：执行者拿不到材料，
   *   而主上下文又被待命段告知「不要自己执行」，于是没有任何一方处理它。
   * @param critiqueHistory 最近几轮挑刺者评估的**结论正文**（数组，最新在最后）。
   *   执行者是零父上下文（不继承主会话历史）——不带的话用户说「按第 2 点改」
   *   甚至「把前两个问题都修了」时，执行者不知道指什么，多轮修正循环断掉。
   *   只带编排自己的评估结论（不是主 Agent 的推理过程、不带报告原文），有界。
   * @returns { childId, result, dispose }。
   */
  const hatchExecutor = async (agent, taskBlocks, critiqueHistory) => {
    const subagents = subagentsOf();
    if (subagents === undefined) throw new Error('subagents 服务不可用（spawn 后端未装载）');
    // 只接受「非继承父上下文 + 支持 continuable」的 provider。
    // 静默退到列表第一个（例如 fork）会让执行者继承父会话历史（含挑刺者人格段），
    // 与「像 sub agent 一样、自己的会话」的语义直接冲突——宁可报错也不降级。
    const candidates = subagents.list();
    const providerName = candidates.find((name) => {
      try {
        const provider = subagents.getProvider?.(name);
        return provider !== undefined && provider.inheritsParentContext === false && provider.prepareContinuable !== undefined;
      } catch { return false; }
    });
    if (providerName === undefined) {
      throw new Error(`没有可用的非继承型 continuable subagent provider（已注册：${candidates.join(', ') || '无'}）`);
    }
    const maxDepth = (() => {
      try { return subagents.resolveMaxDepth(undefined); } catch { return undefined; }
    })();
    // v4：用户在二级菜单里选过模型链 → 走**官方 spawn 通道**给执行者指定路由
    // （SubagentStartRequest.agentOptions = {provider, model}；内核
    // resolveChildAgentOptions 会因 routeChanged 自己清掉不匹配的 reasoningEffort）。
    // 没配链/门关着 → 一个字段都不加，行为与合并前完全一致（继承父会话模型）。
    const routed = chain.activeAgentOptions(agent.id);
    // 最近几轮评估结论作为独立上下文块放在任务之前（有界：深度 × 单条上限）。
    const history = Array.isArray(critiqueHistory)
      ? critiqueHistory.filter((t) => typeof t === 'string' && t.trim() !== '')
      : [];
    const priorBlocks = history.length === 0 ? [] : [{
      type: 'text',
      text: `⟦最近几轮挑刺者评估结论 开始⟧\n${history.map((t, i) => `—— 第 ${i + 1} 条 ——\n${t}`).join('\n\n')}\n⟦最近几轮挑刺者评估结论 结束⟧\n（以上是前几轮评估得出的、用户尚未满意的指标，供你理解用户本轮指令所指；它不是你的工作记录，也不是要你复述它。）`,
    }];
    const activation = await subagents.startActivation({
      provider: providerName,
      label: `${LABEL}·执行者`,
      request: {
        // 内容块原样转交，任务说明作为最后一枚 text 块附上。
        // v21：核验开关按该会话家族的快照取。
        prompt: [...priorBlocks, ...taskBlocks, { type: 'text', text: childTaskTail(settingsFor(agent.id).verify.enabled === true) }],
        parent: agent,
        ...maxDepth === undefined ? {} : { maxDepth },
        // 二级菜单选过模型才加这一行；没选就不加（保持继承父路由的原行为）。
        ...routed === undefined ? {} : { agentOptions: routed },
      },
      signal: new AbortController().signal,
      delivery: 'caller',
    });
    return { childId: activation.childId, result: activation.result, dispose: activation.dispose, route: routed ?? null };
  };

  /** 用户手动停止：中断 child（不评估），回 armed。 */
  const manualStop = async (sessionId, agent) => {
    const run = runs.get(sessionId);
    if (run === undefined) return;
    const childId = run.childId;
    if (childId !== undefined) {
      try {
        const subagents = subagentsOf();
        subagents?.interrupt(childId, { kind: 'user', parentSessionId: sessionId });
      } catch (cause) {
        ctx.logger?.warn?.(`dsh-dual-agent: 执行者中断失败（${childId}）：${errorText(cause)}`);
      }
      // 关键：下面先清空 childId——执行者随后结算时，孵化 IIFE 里的
      // `st.childId !== childId` 身份守卫命中，评估轮被吞（用户手动停止不挑刺）。
    }
    run.phase = 'armed';
    run.childId = undefined;
    run.hatchDispose = undefined;
    run.hatchStartedAt = undefined;
    store.clearChild(sessionId);
    if (agent !== undefined) {
      shapeSections(sessionId, agent);
      deliver(agent, backToArmedPrompt);
    }
  };

  // 会话销毁 → 全拆（child 由 subagents 的 drain 语义随父会话回收）。
  ctx.on('agent/disposed', ({ agent }) => {
    const run = runs.get(agent.id);
    if (run === undefined) return;
    // v4：约束段与清单隐藏也归本实例装配，必须跟着拆（unshapeSections 一起收）。
    unshapeSections(agent.id);
    run.watchDispose?.();
    runs.delete(agent.id);
    store.setPhase(agent.id, 'off');
    // v4：会话没了，它的模型链也跟着收（避免落盘堆僵尸记录）。
    if (chain.dropSession(agent.id) === true) { try { store.setChains(chain.serialize()); } catch { /* 尽力 */ } }
    verifySummaries.delete(agent.id);
  });

  // 插件卸载（含 profile 重载）→ 全拆本实例的装配。
  // ⚠ 落盘记录**故意保留**：会话还活着、执行者可能还在跑，record 里的 childId 就是
  // 下一个实例把执行者接回来的唯一线索（见 reconcileSession 的接管分支）。这里只
  // 摘段拆监视器——不写盘、不改 phase。
  ctx.effect(() => () => {
    for (const [sessionId, run] of [...runs.entries()]) {
      // v4：拆段要走 unshapeSections——约束段/清单隐藏和人格段同属本实例装配，
      // 只拆人格段会让下一个实例带着上一个实例的 restrict 残留起不来。
      unshapeSections(sessionId);
      run.watchDispose?.();
      runs.delete(sessionId);
    }
    for (const dispose of routeDisposers.splice(0)) dispose();
  }, 'dsh-dual-agent: runtime');

  // ── 恢复：落盘的 armed/running 记录在**显式动作路径**（/action）或会话创建兜底
  // （agent/created）恢复；child 无法跨进程找回 → running 降级 armed。
  // ⚠ /status 是只读的，绝不能在这里物化（否则 8s 轮询会把状态凭空复活）。

  /** 确保某会话有编排簿；落盘里有记录则按记录恢复（child 无法跨进程找回 → armed）。 */
  const ensureRun = (sessionId) => {
    const existing = runs.get(sessionId);
    if (existing !== undefined) {
      // 早退前补齐装配：run 可能是在 Agent 离线时建的（那时装不上段与监视器），
      // 等会话真正上线必须补上——否则 armed 永远孵化不了。
      const agent = agentOf(sessionId);
      if (agent !== undefined) {
        if (existing.dispose === undefined) shapeSections(sessionId, agent);
        if (existing.watchDispose === undefined) attachHatchWatcher(sessionId, agent);
      }
      return existing;
    }
    const record = store.recordOf(sessionId);
    if (record.phase !== 'armed' && record.phase !== 'running') return undefined;
    const recovered = {
      phase: 'armed', // running 记录一律降级（child 不跨进程恢复）
      dispose: undefined,
      used: new Set(),
      childId: undefined,
      pendingSupplements: [],
      hatchedSeq: undefined,
      watchDispose: undefined,
      hatchDispose: undefined,
      hatchAt: undefined,
      hatchStartedAt: undefined,
      recovering: false,
      // 孵化被前置体检拦下的原因（主上下文自己配置就在报错）；主上下文一旦有回合
      // 正常完成就清空（见 session/event 的 turn/end 分支）。
      blockedBy: undefined,
      // 执行者异常中止的真实死因（status note 用它说话，不再编评估轮）。
      lastExecutorFailure: undefined,
      criticPending: false,
      criticRetried: false,
      lastCriticText: undefined,
      criticBase: 0,
      critiqueHistory: [],
      // v4：核验去重与最近核验摘要（恢复出来的簿子从空开始——callId 不会跨进程重复）。
      verifiedCalls: [], lastVerify: undefined,
      // 上一次进程内是 running（执行者随进程消亡，或插件重载丢了在途结算）→ 让用户
      // 知道旧任务已结束，而不是对着通用待命文案以为任务还在跑。用户发新任务时清除。
      recoveredFrom: record.phase === 'running' ? 'running' : null,
    };
    store.setPhase(sessionId, 'armed');
    runs.set(sessionId, recovered);
    // v21：恢复分支也是武装时刻——旧会话升级到 v21 后第一次加载在这里完成家族初始化
    //（幂等：已有快照/链的家族原样保留）。
    initFamily(sessionId);
    const agent = agentOf(sessionId);
    if (agent !== undefined) {
      shapeSections(sessionId, agent);
      // 恢复出来的武装会话同样需要孵化监视器——会话是既有的，不能指望 agent/created。
      attachHatchWatcher(sessionId, agent);
    }
    return recovered;
  };

  /**
   * 会话对象 → 会话 id 的索引（只有被武装的会话才进表）。
   *
   * 为什么用根作用域的监听器而不是 `agent.ctx`：`session/event` 的派发 key 是
   * **SessionStore 的 ctx 作用域**（`scopeTarget(session, scopeOf(this.ctx))`，
   * 见 dsh-session 的 `enter`），而 tagged 监听器只在「key 或 key 的祖先」下才
   * 被放行——这取决于 store 与 agent 的作用域血缘，不是本插件该赌的东西。
   * 未打标签的监听器则是**全局放行**（`tag === undefined → true`），所以插件根
   * ctx 上的监听器必然收得到所有会话事件，再由本表过滤出被武装的那一个。
   * 代价只是多一次 Map 查找，换来的是不依赖作用域实现的确定性。
   */
  const watchedSessions = new WeakMap(); // Session → sessionId

  /**
   * 给一个（已存在的）会话装上「待命→孵化」监视器。
   *
   * ⚠ 这是本插件的关键装配点：`agent/created` 只在插件装载**之后**新建的会话上
   * 触发，而用户点按钮时当前会话早已建立——只靠 agent/created 装监视器，启动后
   * 永远不会孵化。因此 /action 与 ensureRun 都直接调它，agent/created 只是额外
   * 的兜底（覆盖「武装期间会话被重建」这一少见路径）。
   */
  const attachHatchWatcher = (sessionId, agent) => {
    const run = runs.get(sessionId);
    if (run === undefined || run.watchDispose !== undefined) return;
    const session = agent.session;
    if (session === undefined) return;
    watchedSessions.set(session, sessionId);
    run.watchDispose = () => {
      if (watchedSessions.get(session) === sessionId) watchedSessions.delete(session);
    };
  };

  // ── 结算收口与自愈（v18） ───────────────────────────────────────────────────
  //
  // 用户报障（2026-10-30）：「后台子任务子代理结束，前台依然处于执行中」。
  // 现场取证（同进程的两条真会话）：
  //   · 19c360e9：17:46 孵化执行者 12ac7695，执行者跑到 21:20 自然 completed；
  //     落盘记录从 17:46 起一直是 running+childId，主会话此后再没有任何事件——
  //     报告没回来、评估没注入、按钮/回合标签永远停在执行中。
  //   · ff511d07：插件重载后连续三条用户消息**没有孵化**（主 Agent 自己做了），
  //     因为 run 没了；直到 /action 重新物化 armed 才恢复孵化。根因是同一处：
  //     在途编排只活在本插件实例的 runs 里，而 profile 重载会整体重建插件实例
  //     （cleanup 还会把 runs 清空），await 着的 activation.result 从此无人接手。
  //
  // 修法：不再把「running」当成只能由那一根 await 收尾的状态。
  //   ① 落盘 childId 兼作一次性结算令牌：只有摘掉它的一方能投递评估/说明；
  //   ② 任何时刻都能用「活的执行者 + 落盘记录」把 running 收敛回真实情形：
  //      执行者还在 → 重新接管并盯到它停；执行者已没了 → 把它的会话读回来，
  //      报告还在就照常评估，读不回来才诚实说明；
  //   ③ /status 不再照抄记录：running 必须有一份可核对的活执行者（或在孵化窗口内）。

  /** 进程内的活 Agent 查找（会话不在本进程时返回 undefined；绝不抛）。 */
  const childAgentOf = (childId) => {
    if (typeof childId !== 'string' || childId === '') return undefined;
    try { return ctx.agents.get(childId); } catch { return undefined; }
  };

  const textOfMessage = (message) => (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();

  /** 会话事件里的最后一条 assistant 正文（= 执行者的收尾报告）。 */
  const lastAssistantTextOfEvents = (events) => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'assistant/message') continue;
      const text = textOfMessage(event.data?.message);
      if (text !== '') return text;
    }
    return '';
  };

  /** 已消息数组里的最后一条 assistant 正文（活 Agent 的 deriveMessages）。 */
  const lastAssistantTextOfMessages = (messages) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'assistant') continue;
      const text = textOfMessage(message);
      if (text !== '') return text;
    }
    return '';
  };

  const lastTurnStopReasonOfEvents = (events) => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'turn/end') continue;
      const kind = event.data?.reason?.kind;
      if (typeof kind === 'string') return kind;
    }
    return undefined;
  };

  const lastTurnStopReasonOfAgent = (child) => {
    try {
      const seq = typeof child?.session?.seq === 'number' ? child.session.seq : 0;
      const from = Math.max(0, seq - TURN_SCAN_WINDOW);
      return lastTurnStopReasonOfEvents(child.session?.snapshotEvents?.(from) ?? []);
    } catch { return undefined; }
  };

  /**
   * 主 Agent **最近一个回合**的失败文本（没有失败就是 undefined）。
   *
   * 为什么看这个：执行者继承父会话的 provider/model/reasoningEffort，父自己都在
   * 报的配置错，孩子必然一模一样地报——孵出来也只是个必死的僵尸 child，前台还会
   * 一直显示「执行中」。所以孵化前先问一句「你上一个回合成没成」。
   * 只看最后一个 turn/end：它一旦 completed，就说明配置已经恢复，自动解封。
   */
  const lastTurnFailureOf = (agent) => {
    try {
      const seq = typeof agent?.session?.seq === 'number' ? agent.session.seq : 0;
      const events = agent.session?.snapshotEvents?.(Math.max(0, seq - TURN_SCAN_WINDOW)) ?? [];
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type !== 'turn/end') continue;
        const reason = event.data?.reason;
        if (reason?.kind !== 'error') return undefined;
        const message = reason.error?.message;
        if (typeof message === 'string' && message !== '') return message;
        const code = reason.error?.code;
        return typeof code === 'string' && code !== '' ? code : '未知错误';
      }
    } catch { /* 读不到就不拦：宁可试一次 */ }
    return undefined;
  };

  /** 执行者会话里最后一个回合的失败文本（它已死时只能从持久化读）。 */
  const executorFailureOf = async (childId) => {
    const liveChild = childAgentOf(childId);
    if (liveChild !== undefined) return lastTurnFailureOf(liveChild);
    const query = (() => { try { return ctx.get('sessionQuery'); } catch { return undefined; } })();
    if (typeof query?.observeSession !== 'function') return undefined;
    let observation;
    try {
      observation = await query.observeSession(childId, { signal: new AbortController().signal });
      const events = observation?.events ?? [];
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type !== 'turn/end') continue;
        const reason = event.data?.reason;
        if (reason?.kind !== 'error') return undefined;
        const message = reason.error?.message;
        if (typeof message === 'string' && message !== '') return message;
        const code = reason.error?.code;
        return typeof code === 'string' && code !== '' ? code : '未知错误';
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      try { observation?.[Symbol.dispose]?.(); } catch { /* 尽力 */ }
    }
  };

  /**
   * 读回执行者的收尾报告：活着的子 Agent 直接读它的会话；已被回收的从会话持久化
   * 读回来（sessionQuery.observeSession 是 continuable 能力的前提，通常在场）。
   * 只读、有界；任何异常都吞掉回 undefined——它跑在 /status 的收敛路径上。
   */
  const readExecutorReport = async (childId) => {
    const liveChild = childAgentOf(childId);
    if (liveChild !== undefined) {
      try {
        const text = lastAssistantTextOfMessages(liveChild.session?.deriveMessages?.() ?? []);
        if (text !== '') return { text, stopReason: lastTurnStopReasonOfAgent(liveChild) ?? 'completed' };
      } catch { /* 落到持久化路径 */ }
    }
    const query = (() => { try { return ctx.get('sessionQuery'); } catch { return undefined; } })();
    if (typeof query?.observeSession !== 'function') return undefined;
    let observation;
    try {
      observation = await query.observeSession(childId, { signal: new AbortController().signal });
      const events = observation?.events ?? [];
      const text = lastAssistantTextOfEvents(events);
      if (text === '') return undefined;
      return { text, stopReason: lastTurnStopReasonOfEvents(events) ?? 'completed' };
    } catch (cause) {
      ctx.logger?.debug?.(`dsh-dual-agent: 读回执行者报告失败（child=${childId}）：${errorText(cause)}`);
      return undefined;
    } finally {
      // observeSession 返回的是 caller-owned 租约，用完必须归还（否则缓存条目被钉住）。
      try { observation?.[Symbol.dispose]?.(); } catch { /* 尽力 */ }
    }
  };

  /**
   * 把 run 从 running 收回 armed（内存 + 落盘），返回这次是否由本调用兑现。
   * @returns { childId, claimed } claimed=false 表示别处已经结算过（或记录已不在），
   *   调用方不得再向主上下文投递第二份说明。
   */
  const releaseRun = (sessionId, agent, run) => {
    const childId = run.childId;
    run.childId = undefined;
    run.hatchDispose = undefined;
    run.hatchStartedAt = undefined;
    run.phase = 'armed';
    // 没有 childId（孵化还没完成）时没有令牌可争，本次调用就是唯一持有者。
    const claimed = childId === undefined ? true : store.clearChild(sessionId);
    if (childId === undefined) store.setPhase(sessionId, 'armed');
    shapeSections(sessionId, agent);
    return { childId, claimed };
  };

  // ── v4 出处程序核验（确定性代码，不经模型）──────────────────────────────────
  //
  // 用户要求：「子代理给出的信息必须标明出处并由流程化程序检查是否真实」。落点两处：
  //   ① 执行者自然结算：核验块拼进**同一条**挑刺评估消息（不额外造回合）；
  //   ② 主智能自己用 subagent/workflow 工具派出去的子代理：结果落进主会话时，
  //      由 session/event 的 tool/result 触发核验，再注入一条【程序核验】实况。
  // 核验只读不写：读文件、比对会话日志里真实存在的 tool/call+tool/result、纯算术，
  // 可选 HTTP。任何核不了的都明说「无法核验」，不替子代理圆场。

  /** 读某会话的事件（活的 snapshotEvents；已被回收的走 sessionQuery 持久化）。 */
  const eventsOfSession = async (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return [];
    const live = childAgentOf(sessionId);
    if (live !== undefined) {
      try {
        const seq = typeof live.session?.seq === 'number' ? live.session.seq : 0;
        return live.session?.snapshotEvents?.(Math.max(0, seq - TURN_SCAN_WINDOW * 4)) ?? [];
      } catch { return []; }
    }
    const query = (() => { try { return ctx.get('sessionQuery'); } catch { return undefined; } })();
    if (typeof query?.observeSession !== 'function') return [];
    let observation;
    try {
      observation = await query.observeSession(sessionId, { signal: new AbortController().signal });
      return observation?.events ?? [];
    } catch {
      return [];
    } finally {
      try { observation?.[Symbol.dispose]?.(); } catch { /* 租约必须归还 */ }
    }
  };

  /** 某根会话的直接子会话 id（服务面优先，本进程 agent 表兜底）。 */
  const listChildIds = async (rootId) => {
    const ids = new Set();
    const subagents = subagentsOf();
    if (typeof subagents?.listChildren === 'function') {
      try {
        for (const entry of (await subagents.listChildren(rootId)) ?? []) {
          if (typeof entry?.id === 'string' && entry.id !== '') ids.add(entry.id);
        }
      } catch { /* 服务面读不到就走兜底 */ }
    }
    try {
      for (const agent of ctx.agents.list?.() ?? []) {
        if (agent?.session?.header?.parentSession === rootId) ids.add(agent.id);
      }
    } catch { /* 尽力 */ }
    return [...ids];
  };

  /**
   * 跑一遍核验。返回 null 表示核验关着（这时报告原文不带核验块，也不假装核过）。
   */
  const runVerify = async (sessionId, reportText, afterMs, sourceHint) => {
    // v21：核验开关与参数按该会话所属家族的快照取。
    const verifySettings = settingsFor(sessionId).verify;
    if (verifySettings.enabled !== true) return null;
    const extract = extractEvidence(reportText);
    const agent = agentOf(sessionId);
    const cwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : process.cwd();
    const base = {
      source: sourceHint ?? (extract.found ? '报告自带的证据块' : '报告未提供证据块'),
      extractError: extract.error ?? null,
      inferred: extract.inferred === true,
    };
    if (extract.claims.length === 0) {
      const empty = { total: 0, pass: 0, fail: 0, unverifiable: 0, results: [], dropped: 0, ranAt: Date.now() };
      const text = renderVerdict(empty, base);
      return { summary: empty, text, claims: 0 };
    }
    const summary = await verifyEvidence(extract.claims, {
      cwd,
      rootId: sessionId,
      afterMs,
      readLimit: verifySettings.readLimitBytes,
      urlChecks: verifySettings.urlChecks === true,
      timeoutMs: verifySettings.timeoutMs,
      maxClaims: verifySettings.maxClaims,
      probe: { childEvents: eventsOfSession, childIds: listChildIds },
    });
    return { summary, text: renderVerdict(summary, base), claims: extract.claims.length };
  };

  /** 核验实况摘要（给 status 与二级菜单顶部；不落盘——它是这一轮的实况）。 */
  const rememberVerifySummary = (sessionId, verdict) => {
    if (verdict === null || verdict === undefined) return;
    const { summary } = verdict;
    verifySummaries.set(sessionId, {
      text: `${verdictSummaryLine(summary)}${summary.fail > 0 ? ' —— 有出处与现实不符，必须按未达标处理' : (summary.unverifiable > 0 ? ' —— 有未经证实的部分，转述时必须原样标注' : '')}`,
      tone: summary.fail > 0 ? 'error' : (summary.unverifiable > 0 ? 'warn' : 'ok'),
      at: Date.now(),
      pass: summary.pass, fail: summary.fail, unverifiable: summary.unverifiable,
    });
  };

  /** 注入挑刺者评估轮（结算路径与「读回报告」路径共用）。 */
  const deliverCritic = async (agent, run, childId, stopReason, reportText, afterMs) => {
    // 先核验再拼消息：核验块附在评估消息**尾部**（开头必须是【挑刺者评估】——
    // 沙箱 E2E 与人类输入判据都认这个前缀，位置不能动）。
    const verdict = await runVerify(agent.id, reportText, afterMs, '执行者报告的证据块');
    if (verdict !== null) rememberVerifySummary(agent.id, verdict);
    let criticText = criticEvaluateWithAngle(agent, run.used, childId, stopReason, reportText);
    if (verdict !== null) {
      criticText += `\n\n———\n${verdict.text}\n\n（挑刺时把「不符」项当作硬伤：出处与现实不符的报告，任何角度都不算达标；「无法核验」项不得当作已证实的事实。）`;
      run.lastVerify = verdict.summary;
    } else {
      run.lastVerify = undefined;
    }
    // 记录评估轮状态：注入后若该轮**自己失败**（额度/网络报错、无正文），
    // 主上下文会停在一条用户看得见的注入消息上没有任何回复——观感是
    // 「插件哑了」。监听 turn/end 给它一次自动重试 + 可读兜底。
    run.criticPending = true;
    run.criticRetried = false;
    run.lastCriticText = criticText;
    run.criticBase = agent.session?.seq ?? 0;
    deliver(agent, criticText);
  };

  /**
   * 结算的唯一收口：把 running 收回 armed，并按失败性质决定「投不投评估轮」。
   * @param failureText 执行者最后一个回合的失败文本（stopReason!=='completed' 时才有）。
   * @returns 是否由本次调用兑现（跨实例互斥）；`suppressed` 表示因系统性失败而
   *   故意不注入评估轮（原因已写进 run.lastExecutorFailure，由 status note 交代）。
   */
  const settleExecutor = async (sessionId, agent, run, childId, stopReason, reportText, failureText, afterMs) => {
    const { claimed } = releaseRun(sessionId, agent, run);
    if (claimed !== true) {
      ctx.logger?.debug?.(`dsh-dual-agent: 结算已由别处兑现（session=${sessionId} child=${childId}），不重复投递`);
      return { claimed: false, suppressed: false };
    }
    if (stopReason !== 'completed' && isSystemicFailure(failureText)) {
      // 父子共用同一套 provider/model/effort：这一样会把主上下文的评估轮也打挂。
      // 不注入、不重试、不再投兜底说明——只把原因留给 status note（不烧回合）。
      // v4 起这条判据只对「没选子代理模型」的情形有意义：选了独立候选路由时，
      // 父亲的配置错误未必会传染给孩子（见 handleHumanMessage 的孵化前体检）。
      run.lastExecutorFailure = failureText;
      ctx.logger?.warn?.(`dsh-dual-agent: 执行者系统性失败，跳过评估轮（session=${sessionId} child=${childId}）：${failureText}`);
      return { claimed: true, suppressed: true };
    }
    await deliverCritic(agent, run, childId, stopReason, reportText, afterMs);
    return { claimed: true, suppressed: false };
  };

  /** 结算：报告到手 → 回待命 + 评估轮（只由兑现结算令牌的那一方投递）。 */
  const settleWithReport = (sessionId, agent, run, childId, stopReason, reportText, failureText, afterMs) =>
    settleExecutor(sessionId, agent, run, childId, stopReason, reportText, failureText, afterMs);

  /** 「报告丢了」的统一口径：说清发生了什么、现在是什么状态、下一步怎么走。 */
  const lostNotice = (childId) => `【双主智能编排】执行者（subagent ${childId}）已经结束，但它的报告没有回到主上下文（编排在插件重载/进程重启时丢了在途结算，会话里也没能读回报告）。已回到待命：键入下一条消息即可重新开工。`;

  /**
   * 结算丢失后的补救：先把执行者的会话读回来。
   *   · 报告读到了 → 照常注入挑刺者评估轮（报告确实是它做的活，只是晚到了）；
   *   · 读不到     → 诚实说明，别让用户以为任务还在跑。
   * 期间用户若已开新任务/关闭，则一个字都不投（run 已被替换）。
   */
  const recoverAfterRelease = async (sessionId, agent, run, childId) => {
    if (run.recovering === true) return;
    run.recovering = true;
    try {
      const report = childId === undefined ? undefined : await readExecutorReport(childId);
      const now = runs.get(sessionId);
      if (now !== run || now.phase !== 'armed' || now.childId !== undefined) return;
      if (report !== undefined && report.text !== '') {
        ctx.logger?.info?.(`dsh-dual-agent: 已从执行者会话读回报告（session=${sessionId} child=${childId}）`);
        await deliverCritic(agent, run, childId, report.stopReason,
          reportTextOf({ output: [{ type: 'text', text: report.text }] }),
          // 任务起点：内存里最近一次孵化时刻，退回落盘的武装起始时刻；都没有就让
          // file_modified 类声称如实判「无法核验」（不猜时间）。
          typeof run.hatchAt === 'number' ? run.hatchAt : store.recordOf(sessionId).since);
        return;
      }
      if (childId !== undefined) {
        // 待命文案也说清「上一轮不是正常交接」：否则用户看到的是通用「请键入初始
        // 指令」，会以为任务已经正常收尾。
        if (run.recoveredFrom === null || run.recoveredFrom === undefined) run.recoveredFrom = 'running';
        deliver(agent, lostNotice(childId));
      }
    } finally {
      run.recovering = false;
    }
  };

  /**
   * 重载后重新接管一个**仍然活着**的执行者：重建内存簿 + 盯到它停。
   * 落盘记录保持 running+childId 不写——下一次重载还能再接管（幂等）。
   */
  const watchAdoptedChild = (sessionId, agent, run, childId) => {
    let idleTicks = 0;
    const tick = async () => {
      if (runs.get(sessionId) !== run || run.phase !== 'running' || run.childId !== childId) return;
      const child = childAgentOf(childId);
      if (child === undefined) {
        const { claimed } = releaseRun(sessionId, agent, run);
        if (claimed === true) await recoverAfterRelease(sessionId, agent, run, childId);
        return;
      }
      const pending = (child.inbox?.nextTurn?.length ?? 0) + (child.inbox?.nextStep?.length ?? 0);
      idleTicks = child.status === 'running' || pending > 0 ? 0 : idleTicks + 1;
      if (idleTicks < ADOPT_IDLE_TICKS) {
        setTimeout(() => { void tick(); }, ADOPT_POLL_MS);
        return;
      }
      const report = await readExecutorReport(childId);
      if (runs.get(sessionId) !== run || run.phase !== 'running' || run.childId !== childId) return;
      const stopReason = report?.stopReason ?? lastTurnStopReasonOfAgent(child) ?? 'completed';
      const failureText = stopReason === 'completed' ? undefined : await executorFailureOf(childId);
      await settleWithReport(sessionId, agent, run, childId, stopReason,
        reportTextOf({ output: [{ type: 'text', text: report?.text ?? '' }] }), failureText,
        typeof run.hatchAt === 'number' ? run.hatchAt : undefined);
    };
    setTimeout(() => { void tick(); }, 0);
  };

  const adoptChild = (sessionId, agent, childId, record) => {
    if (runs.has(sessionId)) return;
    const adopted = {
      phase: 'running',
      dispose: undefined,
      used: new Set(),
      childId,
      pendingSupplements: [],
      hatchedSeq: undefined,
      watchDispose: undefined,
      hatchDispose: undefined,
      hatchAt: typeof record?.updatedAt === 'number' ? record.updatedAt : undefined,
      criticPending: false,
      criticRetried: false,
      lastCriticText: undefined,
      criticBase: 0,
      critiqueHistory: [],
      recoveredFrom: null,
      hatchStartedAt: undefined,
      recovering: false,
      blockedBy: undefined,
      lastExecutorFailure: undefined,
      verifiedCalls: [], lastVerify: undefined,
      adopted: true,
    };
    runs.set(sessionId, adopted);
    // v21：接管活执行者同样是「会话回到使能态」的一条武装时刻路径——幂等初始化家族。
    initFamily(sessionId);
    shapeSections(sessionId, agent);
    attachHatchWatcher(sessionId, agent);
    watchAdoptedChild(sessionId, agent, adopted, childId);
    ctx.logger?.info?.(`dsh-dual-agent: 已重新接管执行者（session=${sessionId} child=${childId}）`);
  };

  /**
   * 用「活的执行者 + 落盘记录」把 running 收敛到真实情形（幂等，可反复调用）。
   *
   * @param quiet 用户正要发新任务时不要插话（如 user/message 触发的收敛）。
   */
  const reconcileSession = (sessionId, { quiet = false } = {}) => {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const agent = agentOf(sessionId);
    // 会话不在本进程：记录无法核对，保持 orphan 口径（不写盘、不动状态）。
    if (agent === undefined) return;
    const run = runs.get(sessionId);
    if (run !== undefined) {
      if (run.phase !== 'running') return;
      if (run.childId !== undefined) {
        if (childAgentOf(run.childId) !== undefined) return; // 执行者还活着：正常跟随
        const childId = run.childId;
        const { claimed } = releaseRun(sessionId, agent, run);
        if (claimed === true) void recoverAfterRelease(sessionId, agent, run, childId);
        return;
      }
      // 孵化窗口：超过上限仍没拿到 childId → 放弃（startActivation 卡住/宿主异常）。
      if (typeof run.hatchStartedAt === 'number' && Date.now() - run.hatchStartedAt > HATCH_GIVE_UP_MS) {
        releaseRun(sessionId, agent, run);
        if (!quiet) {
          deliver(agent, `【双主智能编排】执行者孵化超时（${Math.round(HATCH_GIVE_UP_MS / 1000)} 秒内没拿到执行者身份）。已回到待命：可以重新发送或补充指令。`);
        }
      }
      return;
    }
    const record = store.recordOf(sessionId);
    if (record.phase === 'armed') {
      // 记录还在武装：把段与监视器接回来（重载后靠这条恢复，否则用户消息永远不孵化）。
      ensureRun(sessionId);
      return;
    }
    if (record.phase !== 'running') return;
    const childId = record.childId;
    if (typeof childId === 'string' && childId !== '' && childAgentOf(childId) !== undefined) {
      adoptChild(sessionId, agent, childId, record);
      return;
    }
    // 幽灵 running：记录说在跑，本进程里却没有这个执行者。
    // 先兑现令牌再物化（clearChild 会先重读落盘，别的实例已经收过尾就看得见），
    // 否则两个实例会各投一条「报告未取回」。
    const consumed = typeof childId === 'string' && childId !== ''
      ? store.clearChild(sessionId)
      : true;
    const recovered = ensureRun(sessionId);
    if (recovered === undefined) return;
    if (!quiet && consumed === true) void recoverAfterRelease(sessionId, agent, recovered, childId);
  };

  /** 把收敛排进下一个微任务（/status 每 8s 轮询调它：不阻塞回包、不重复排队）。 */
  const reconcileQueue = new Map(); // sessionId → quiet（多次请求取 AND：有一处不让插话就不插）
  let reconcileScheduled = false;
  const scheduleReconcile = (sessionId, quiet = false) => {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    if (agentOf(sessionId) === undefined) return;
    const previous = reconcileQueue.has(sessionId) ? reconcileQueue.get(sessionId) : true;
    reconcileQueue.set(sessionId, previous && quiet);
    if (reconcileScheduled) return;
    reconcileScheduled = true;
    queueMicrotask(() => {
      reconcileScheduled = false;
      const batch = [...reconcileQueue.entries()];
      reconcileQueue.clear();
      for (const [id, quietRun] of batch) {
        try { reconcileSession(id, { quiet: quietRun }); } catch (cause) {
          ctx.logger?.warn?.(`dsh-dual-agent: 状态收敛失败（session=${id}）：${errorText(cause)}`);
        }
      }
    });
  };

  /**
   * 把一条（补充）内容转达给执行者。成功静默（主页面不出现新动作）；失败才
   * 出声交还主上下文。running 分支与孵化完成后的 flush 共用这一条路径。
   * ⚠ 只能用服务面上**真实存在**的方法：`queuePrompt` 不在 `subagents` 服务面
   * （该面是 resolveMaxDepth/startActivation/sendMessage/interrupt/prompt/list…），
   * 误用会抛 TypeError 被吞成「转达失败」——功能静默死亡。sendMessage 的语义正好：
   * 父 Agent 把消息递给直系 continuable child，运行中在最近 step 边界接纳。
   */
  const relaySupplement = (sessionId, agent, childId, content) => {
    const subagents = subagentsOf();
    if (subagents === undefined || typeof subagents.sendMessage !== 'function') return;
    void Promise.resolve()
      .then(() => subagents.sendMessage(agent, childId, content, { signal: new AbortController().signal }))
      .then(() => {
        // 成功静默：执行者会在当前任务里纳入这条要求。
        ctx.logger?.info?.(`dsh-dual-agent: 补充已转达给执行者（child=${childId}）`);
      })
      .catch((cause) => {
        // 失败才出声：这条补充无处安放，交还主上下文（通知是 plugin 源，不会再触发压制）。
        deliver(agent, `【双主智能编排】补充转达失败（${errorText(cause)}）：执行者已结束或不再接受输入，这条补充只留在主上下文。`);
      });
  };

  /** 处理一条落在被武装会话上的 user/message（由根监听器分派进来）。 */
  const handleHumanMessage = (sessionId, agent, event) => {
      const current = runs.get(sessionId);
      if (current === undefined) return;
      if (event.type !== 'user/message') return;
      const message = event.data;
      // 人类输入的判据 = source.kind === 'user'。UI 消息额外带 rpcId，但 ACP /
      // headless / SDK 注入的人类输入也全是 kind:'user' 且**不带** rpcId——绑死
      // rpcId 会让这些前端里功能静默失效。插件自己的编排消息用的是独立 kind
      // （'plugin:dsh-dual-agent'），加上前缀防御，不会与人类输入混淆。
      if (message?.source?.kind !== 'user') return;
      const blocks = message.content ?? [];
      // 任务内容块：文本 + 附件（image/file）。reasoning 之类的非用户块不转交。
      const taskBlocks = blocks.filter((block) =>
        block?.type === 'text' ? String(block.text ?? '').trim() !== ''
          : block?.type === 'image' || block?.type === 'file');
      const text = blocks
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      // 前缀防御：编排消息即便被同源伪造也不当任务。
      if (ORCHESTRATOR_PREFIXES.some((prefix) => text.startsWith(prefix))) return;

      // v4.1（用户指令 2026-11-03「新的插件就不需要阻塞主会话了」）：旧编排默认关。
      // 关着时本插件**不碰**人类消息：不 cancel 主回合、不孵化、不转达——主智能自己
      // 判断并派活（subagent / subagent_fork / workflow 在允许清单里），主会话照常答话。
      // v21：orchestrate 按该会话所属家族的快照取（家族间互不影响）。
      if (settingsFor(sessionId).guidance.orchestrate !== true) return;

      // ── running 态：用户补充 → 转达给执行者；主回合被压制（「阻塞」） ──
      // running 有两种：childId 已就绪（直接转达）、正在孵化（先入队，孵化
      // 完成后 flush）。两种都要立刻 cancel 掉这条消息刚被认领的回合——
      // 此刻 user/message 已被 claim（claim 早于提交进日志），掐掉当前回合
      // 不会造成「未认领消息 → 重新唤醒」的自旋；主页面从此静默。
      if (current.phase === 'running') {
        if (taskBlocks.length === 0) return;
        try {
          agent.cancel({ kind: 'hook', reason: 'dual-agent: 补充由编排转达给执行者' }, { keepInbox: true });
        } catch (cause) {
          ctx.logger?.warn?.(`dsh-dual-agent: 回合压制失败（session=${sessionId}）：${errorText(cause)}`);
        }
        // 执行者已经没了（重载丢了结算 / 宿主回收）→ 这条补充无处安放：先把编排
        // 收敛回待命，再把它当作新任务孵化。**不能**继续往空处转达——那正是
        // 「前台还说执行中、消息却谁也没处理」的那条路。
        if (current.childId !== undefined && childAgentOf(current.childId) === undefined) {
          const lostChildId = current.childId;
          ctx.logger?.info?.(`dsh-dual-agent: 执行者已不在（child=${lostChildId}），补充改按新任务处理（session=${sessionId}）`);
          const { claimed } = releaseRun(sessionId, agent, current);
          if (claimed === true) void recoverAfterRelease(sessionId, agent, current, lostChildId);
          // 落到下面的 armed 分支，用同一条事件孵化新执行者。
        } else {
          const relay = [...taskBlocks, { type: 'text', text: '（以上是用户在当前任务执行中追加的补充要求，请纳入处理。）' }];
          if (current.childId === undefined) {
            // 执行者还在孵化：排队，等 hatchExecutor 完成后统一转达。
            current.pendingSupplements.push(relay);
            return;
          }
          const childId = current.childId;
          // 出 append 窗口再投（与 cancel 同一拍序），复用统一转达路径。
          queueMicrotask(() => {
            const now = runs.get(sessionId);
            if (now === undefined || now.childId !== childId) return;
            relaySupplement(sessionId, agent, childId, relay);
          });
          return;
        }
      }

      // ── armed 态：旧编排（可选）才接管人类消息 → 孵化执行者 ──
      if (current.phase !== 'armed') return;
      // 纯文本为空但有附件（截图/文档）时**也要**孵化：否则这条消息会被吞掉。
      if (taskBlocks.length === 0) return;
      if (current.hatchedSeq === event.seq) return;
      // 前置体检（v19）：执行者继承父会话的 provider/model/reasoningEffort。主上下文
      // 自己上一个回合就因配置类错误收场时，孵化出来的执行者必然同样地死——用户看到
      // 的就是「要求发出去了，子代理没产生，主线程直接结束」。此时**不压制、不孵化**：
      // 让主 Agent 照常处理这条消息，把内核那条可操作的错误（哪个模型不支持哪档
      // 推理）直接摆到用户面前。主上下文一旦有回合正常完成，体检自动解封。
      //
      // v4 修正：体检的前提是「父子同路由」。用户在二级菜单里给子代理选了独立候选
      // 模型时，父亲那套坏配置不会传染给孩子——这时拦下来反而是错的（用户明明已经
      // 换好了能用的子代理模型）。所以选了候选就放行，让真实请求去说话。
      const routedForHatch = chain.activeAgentOptions(sessionId);
      const blocker = lastTurnFailureOf(agent);
      if (blocker !== undefined && isSystemicFailure(blocker) && routedForHatch === undefined) {
        current.blockedBy = blocker;
        ctx.logger?.warn?.(`dsh-dual-agent: 主上下文上一回合即因配置类错误收场，本轮不孵化执行者（session=${sessionId}）：${blocker}`);
        return;
      }
      if (blocker !== undefined && isSystemicFailure(blocker) && routedForHatch !== undefined) {
        log('info', `${LABEL}: 主上下文配置仍在报错，但子代理已选定 ${routedForHatch.provider}/${routedForHatch.model}，照常孵化（session=${sessionId}）`);
      }
      current.blockedBy = undefined;
      current.hatchedSeq = event.seq;
      current.phase = 'running';
      current.hatchStartedAt = Date.now(); // 孵化窗口起点：reconcile 据此判定卡死
      current.recoveredFrom = null; // 用户已开新任务：中断提示使命完成
      shapeSections(sessionId, agent);
      // 双线路径的「阻塞」：任务交给执行者，主 Agent 这一轮到此为止。此刻
      // 这条 user/message 刚被提交进会话日志（claim 已发生），cancel 掐掉
      // 回合的剩余部分——kernel 在 LLM 请求前有 throwIfAborted 检查点，正常
      // 情形下主页面**不会出现任何 assistant 动作**（最坏是一次被打断的残帧）。
      // 这就是用户要求的「创建子代理后主页面不出现新的动作」。
      try {
        agent.cancel({ kind: 'hook', reason: 'dual-agent: 执行者接管本任务' }, { keepInbox: true });
      } catch (cause) {
        ctx.logger?.warn?.(`dsh-dual-agent: 回合压制失败（session=${sessionId}）：${errorText(cause)}`);
      }
      void (async () => {
        try {
          // 孵化本身含 await（append 窗口已关闭），放在微任务后的异步段里。
          await Promise.resolve();
          const { childId, result, dispose } = await hatchExecutor(agent, taskBlocks, current.critiqueHistory);
          const now = runs.get(sessionId);
          if (now === undefined) {
            // 编排簿已拆（关闭/会话销毁）：别让执行者裸跑。
            try { subagentsOf()?.interrupt(childId, { kind: 'user', parentSessionId: sessionId }); } catch { /* 尽力 */ }
            return;
          }
          if (now.phase !== 'running') {
            // 孵化期间被用户手动停止：**立刻中断**这个刚出生的执行者，
            // 否则它会继续跑完整个任务而无人跟踪（烧 token、可能真实改工作区）。
            try {
              const subagents = subagentsOf();
              subagents?.interrupt(childId, { kind: 'user', parentSessionId: sessionId });
            } catch { /* 尽力 */ }
            return;
          }
          now.childId = childId;
          now.hatchDispose = dispose;
          now.hatchStartedAt = undefined;
          now.hatchAt = Date.now(); // running note 里的「已工作 X 分 Y 秒」锚点
          store.setChild(sessionId, childId);
          ctx.logger?.info?.(`dsh-dual-agent: 执行者已孵化（session=${sessionId} child=${childId}）`);
          // 孵化窗口内排队的补充：此刻统一转达（主回合已被压制，不会有人接话）。
          const queued = now.pendingSupplements.splice(0);
          for (const relay of queued) void relaySupplement(sessionId, agent, childId, relay);
          // ── 等执行者自然结算（delivery:'caller'：报告不会自动送达主会话，由编排取回）。 ──
          // 只有智能体主动停止才挑刺：手动停止/disarm 会先 phase 离开 running 或置
          // suppressed，下面的判定据此吞掉评估轮。
          let settled;
          try {
            settled = await result;
          } catch (cause) {
            // result 被 reject（teardown 失败等）：按「异常停止」处理，仍要让主上下文知情。
            const st = runs.get(sessionId);
            if (st === undefined || st.childId !== childId) return; // 已被手动停止/替换：不抢话
            const { claimed } = releaseRun(sessionId, agent, st);
            if (claimed === true) {
              deliver(agent, `【双主智能编排】执行者（subagent ${childId}）结算异常：${errorText(cause)}。已回到待命状态，可重试或补充指令。`);
            }
            return;
          }
          const st = runs.get(sessionId);
          if (st === undefined || st.childId !== childId) return; // 手动停止/disarm/替换：不挑刺
          const stopReason = typeof settled?.stopReason === 'string' ? settled.stopReason : 'completed';
          // 执行者异常中止时把它的真实死因读出来：系统性失败（模型配置/额度）就不该
          // 再往主会话里投一条必然失败的评估轮——那正是用户看到的「连错三次」。
          const failureText = stopReason === 'completed' ? undefined : await executorFailureOf(childId);
          // 结算收口（含跨实例互斥）与评估注入共用同一条实现，见 settleExecutor。
          // v4：报告先过一遍确定性核验，核验块与评估轮在**同一条**消息里进主上下文。
          await settleWithReport(sessionId, agent, st, childId, stopReason, reportTextOf(settled), failureText,
            typeof now.hatchAt === 'number' ? now.hatchAt : undefined);
        } catch (cause) {
          const now = runs.get(sessionId);
          if (now === undefined || now.phase !== 'running' || now.hatchedSeq !== event.seq) return;
          // 孵化失败：回到 armed，并以编排消息把失败交还主上下文（plugin 源，
          // 不再触发压制——这一轮让主 Agent 正常向用户说明）。
          now.phase = 'armed';
          now.hatchedSeq = undefined;
          now.hatchStartedAt = undefined;
          store.clearChild(sessionId);
          shapeSections(sessionId, agent);
          deliver(agent, `【双主智能编排】执行者孵化失败：${errorText(cause)}。已回到待命状态，可重试（重新发送或补充指令即可）。`);
        }
      })();
  };

  /**
   * 主智能自己派出去的子代理（subagent / subagent_fork / workflow / ralph）结果落进
   * 主会话时，也跑同一套确定性核验，并注入一条【程序核验】实况。
   *
   * 为什么走 session/event 的 tool/result 而不是包装工具：工具结果一经落盘就不可改
   * （内核没有 result 改写点），而这条路径是只读旁路——不碰任何既有装配，插件卸载
   * 即无痕。核验块作为**独立一条**编排消息投进主上下文，主智能因此拿到的不是
   * 「一句子代理自述」，而是「自述 + 程序逐条核对的结果」。
   */
  const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow', 'ralph']);

  const verifyDelegationResult = async (sessionId, agent, event) => {
    // v21：核验开关按该会话所属家族的快照取。
    const verifyForFamily = settingsFor(sessionId).verify;
    if (verifyForFamily.enabled !== true || verifyForFamily.delegation !== true) return;
    const run = runs.get(sessionId);
    if (run === undefined) return;
    const message = event?.data?.message;
    const callId = message?.toolCallId ?? message?.source?.callId;
    if (typeof callId !== 'string' || callId === '') return;
    if (message?.isError === true) return; // 失败的工具结果不是「声称」
    run.verifiedCalls = run.verifiedCalls ?? [];
    if (run.verifiedCalls.includes(callId)) return;
    run.verifiedCalls.push(callId);
    if (run.verifiedCalls.length > 200) run.verifiedCalls.shift();

    // 找到这次调用的工具名与入参（tool/call 与 tool/result 由 callId 配对）。
    const seq = typeof agent.session?.seq === 'number' ? agent.session.seq : 0;
    const events = agent.session?.snapshotEvents?.(Math.max(0, seq - TURN_SCAN_WINDOW)) ?? [];
    const call = events.find((candidate) => candidate?.type === 'tool/call' && candidate.data?.callId === callId);
    const name = String(call?.data?.name ?? '');
    if (!DELEGATION_TOOLS.has(name)) return;
    const text = (message?.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    if (text.trim() === '') return;
    const verdict = await runVerify(sessionId, text, typeof call?.time === 'number' ? call.time : undefined,
      `${name} 工具回报里的证据块`);
    if (verdict === null) return;
    rememberVerifySummary(sessionId, verdict);
    log('info', `${LABEL}: 已核验 ${name} 的回报（session=${sessionId}）：${verdictSummaryLine(verdict.summary)}`);
    deliver(agent, `【程序核验·子代理回报】刚才 ${name} 交回的内容已由确定性代码逐条核对出处（不是模型互评）：\n\n${verdict.text}\n\n请按这份结果决定哪些话可以当事实转述给用户：「不符」必须纠正或重派，「无法核验」要明确标注为未经证实。`);
  };

  // 根作用域单一监听器：所有会话的 session/event 都会到这里，按会话身份过滤。
  // 未打标签的监听器在 Cordis 里全局放行——不依赖 agent 作用域与 store 作用域的
  // 血缘，这是本插件能稳定收到事件的保证（dsh-session 的 scopeTarget 规则）。
  // ⚠ sessionId 不能只靠 watchedSessions：那张表随插件实例一起消失，重载后
  //   已经武装的会话会因此「收得到事件却不孵化」（2026-10-30 实测到）。会话自身
  //   的 header.id 是稳定身份，拿它兜底，再按落盘记录懒恢复编排簿。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const sessionId = watchedSessions.get(session) ?? session?.id;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const agent = agentOf(sessionId);
    if (agent === undefined || agent.session !== session) return;
    try {
      // 懒恢复：重载后第一条事件就把该会话的编排簿接回来（armed 装段/监视器，
      // running 接管活执行者或收敛幽灵态）。用户正在发言时不插话（quiet）。
      if (!runs.has(sessionId)) reconcileSession(sessionId, { quiet: event.type === 'user/message' });
      if (event.type === 'user/message') {
        handleHumanMessage(sessionId, agent, event);
      } else if (event.type === 'tool/result') {
        // v4：主智能自己派的子代理也核（异步旁路，不阻塞本事件流的其它观察者）。
        void verifyDelegationResult(sessionId, agent, event).catch((cause) => {
          ctx.logger?.warn?.(`${LABEL}: 子代理回报核验失败（session=${sessionId}）：${errorText(cause)}`);
        });
      } else if (event.type === 'assistant/message') {
        // 捕获挑刺者本轮评估的**结论正文**（不是带报告的注入消息）——它才是要
        // 往下一轮执行者上下文里带的「未满足指标清单」。只在评估轮挂起期捕获，
        // 避免把主 Agent 的其它发言混进来。
        const run = runs.get(sessionId);
        if (run === undefined || !run.criticPending) return;
        const text = (event.data?.message?.content ?? [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text ?? '')
          .join('')
          .trim();
        if (text !== '') {
          run.critiqueHistory.push(text.slice(0, CRITIQUE_HISTORY_ITEM_LIMIT));
          if (run.critiqueHistory.length > CRITIQUE_HISTORY_DEPTH) run.critiqueHistory.shift();
        }
      } else if (event.type === 'turn/end') {
        const run = runs.get(sessionId);
        // 主上下文自己有回合正常收场 → 前置体检封禁解除（用户已把模型/额度修好）。
        if (run !== undefined && run.blockedBy !== undefined && event.data?.reason?.kind === 'completed') {
          run.blockedBy = undefined;
        }
        // 评估轮兜底：注入【挑刺者评估】后，若这一轮以 error/aborted 收场且没产出
        // 任何 assistant 正文，用户只会看见一条内部注入消息而没有回复。给它一次
        // 自动重试；再失败就用编排消息把情况讲明白（报告已送达、评估暂时不可用）。
        if (run === undefined || !run.criticPending) return;
        const reason = event.data?.reason?.kind;
        if (reason === 'completed') { run.criticPending = false; return; }
        // 用户手动打断评估轮（aborted/其它）= 明确意图：不重试、不兜底，静默清账。
        if (reason !== 'error') { run.criticPending = false; return; }
        run.criticPending = false;
        const wroteText = ((agent.session?.snapshotEvents?.(run.criticBase ?? 0) ?? [])
          .some((ev) => ev.type === 'assistant/message'));
        if (wroteText) return; // 已经有正文（哪怕回合收尾异常），不打扰
        // 系统性失败（模型配置/额度/上下文窗口）：重试和兜底说明都只会把同一个错误
        // 在主会话里再放一遍。把原因留给 status note，一个多余回合都不造。
        // ⚠ 内核把错误放在 `reason.error`（turn/end 的 data.reason = {kind:'error',
        //   error:{message,code}}），`data.error` 只是兼容旧形态的兜底。
        const failure = event.data?.reason?.error ?? event.data?.error;
        const failureText = failure?.message ?? failure?.code;
        if (isSystemicFailure(failureText)) {
          run.lastExecutorFailure = typeof failureText === 'string' && failureText !== '' ? failureText : '未知错误';
          ctx.logger?.warn?.(`dsh-dual-agent: 评估轮因系统性失败中止，不重试不兜底（session=${sessionId}）：${run.lastExecutorFailure}`);
          return;
        }
        if (!run.criticRetried && typeof run.lastCriticText === 'string') {
          run.criticRetried = true;
          run.criticPending = true;
          run.criticBase = (agent.session?.seq ?? 0) + 1; // 重试轮正文从这之后算
          ctx.logger?.warn?.(`dsh-dual-agent: 评估轮失败（${reason}），自动重试一次（session=${sessionId}）`);
          // **不能**只推微任务：turn/end 的观察点跑在该回合的拆解窗口里，此刻
          // followup 会落进 inbox 但唤醒被正在收尾的旧回合吞掉（沙箱 E2E 实测：
          // 事件流出现 inbox/spliced 却没有后续 turn/start——消息躺死）。
          // 等 agent 真空闲再投：与结算路径同一时机，唤醒必然成回合。
          void idleThenDeliver(agent, () => {
            const now = runs.get(sessionId);
            if (now === undefined || !now.criticPending || now.criticRetried !== true) return false;
            return deliver(agent, now.lastCriticText);
          }, `评估重试（session=${sessionId}）`);
          return;
        }
        run.criticRetried = false; // 兜底发出后清账；下次自然结算重新计一次重试
        const giveUp = '【双主智能编排】执行者的报告已送达，但挑刺者评估连续未能产出（模型调用失败，可能是额度/网络问题）。请稍后重试评估，或直接键入新指令继续——报告内容已在上文，可基于它继续补充要求。';
        void idleThenDeliver(agent, () => {
          const now = runs.get(sessionId);
          if (now === undefined) return false;
          return deliver(agent, giveUp);
        }, `评估兜底说明（session=${sessionId}）`);
      }
    } catch (cause) {
      // 单条消息的编排失败不能污染 session/event 的其它观察者。
      ctx.logger?.warn?.(`dsh-dual-agent: 编排处理失败（session=${sessionId}）：${errorText(cause)}`);
    }
  }), 'dsh-dual-agent: hatch watcher');

  // 兜底：插件装载后新建的会话若已在落盘里武装过，接上监视器。
  ctx.on('agent/created', ({ agent }) => {
    const record = store.recordOf(agent.id);
    // 诊断/沙箱用（config.autoArmForNewSessions=true）：headless 一次性会话没有
    // HTTP 也没人手点开关，靠这个把「新会话一出生就使能」做出来，让 E2E 能走完整
    // 回路。**默认关**——正式使用时开关键的只有工作箱那一下。
    if (settings.autoArmForNewSessions === true && record.phase === 'off' && runs.get(agent.id) === undefined) {
      const header = agent.session?.header;
      const isRoot = typeof header?.parentSession !== 'string' || header.parentSession === '';
      if (isRoot) {
        runs.set(agent.id, {
          phase: 'armed', dispose: undefined, used: new Set(), childId: undefined,
          pendingSupplements: [], hatchedSeq: undefined, watchDispose: undefined,
          hatchDispose: undefined, hatchAt: undefined, hatchStartedAt: undefined,
          recovering: false, blockedBy: undefined, lastExecutorFailure: undefined,
          criticPending: false, criticRetried: false, lastCriticText: undefined, criticBase: 0,
          critiqueHistory: [], recoveredFrom: null, verifiedCalls: [], lastVerify: undefined,
        });
        // v21：autoArm 路径也是武装时刻——新家族在这里从模板物化快照并继承链模板。
        initFamily(agent.id);
        shapeSections(agent.id, agent);
        attachHatchWatcher(agent.id, agent);
        store.setPhase(agent.id, 'armed');
        log('info', `${LABEL}: autoArmForNewSessions 已武装新会话 ${agent.id}（诊断口径）`);
        return;
      }
    }
    if (record.phase !== 'armed' && record.phase !== 'running') return;
    ensureRun(agent.id);
  });

  // ── 执行者结算 = 编排 await 的 activation.result（delivery:'caller'）驱动 ──
  // 不再监听 `subagent/end`：caller 模式下 result 与 end 会同时发生，评估只应跑一次。
  // 手动停止/disarm 已把 run.childId 清空或整个 run 删除，孵化 IIFE 里的
  // `st.childId !== childId` 身份守卫据此吞掉评估——无需额外的抑制集合。

  // ── 路由（webServer 可选：headless/SDK composition 没有它） ──
  // ⚠ 不能在本插件 apply() 时同步取 webServer：GUI profile 实测（沙箱探针插件
  //   WSPROBE）证明 apply 时刻 `ctx.get('webServer')` 是 **undefined**，要过一会儿
  //   （同级 webserver 条目激活后）才 present。同步取 = 路由永远不注册 → 工作箱
  //   开关经 HTTP 打过来全部 404（开关在真实 GUI 里直接失效）。所以改成**懒注册**：
  //   轮询等服务真的出现再 register；headless 没有该服务则超时放弃（程序化
  //   dualAgent 服务面仍然可用，不受影响）。
  const routeDisposers = [];
  const whenWebServer = async (timeoutMs = 60_000) => {
    const started = Date.now();
    for (;;) {
      const ws = ctx.get?.('webServer');
      if (typeof ws?.register === 'function') return ws;
      if (Date.now() - started > timeoutMs) return undefined;
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  };
  const register = (path, handler) => {
    void (async () => {
      const ws = await whenWebServer();
      if (ws === undefined) {
        ctx.logger?.warn?.(`dsh-dual-agent: webServer 60s 内未出现，路由 ${path} 未注册（程序化 dualAgent 服务仍可用）`);
        return;
      }
      try {
        const dispose = ws.register({
          kind: 'exact',
          path,
          handler: (req, res) => {
            const json = jsonOf(res);
            // **返回**这个 promise：调用方（自测的 await、真实 webserver 的错误兜底）
            // 才能等到路由真正结束；catch 把内部错误转成 500，不向外抛。
            return Promise.resolve(handler(req, res, json)).catch((cause) =>
              json(500, { error: `dual-agent 路由内部错误：${errorText(cause)}` }));
          },
        });
        if (typeof dispose === 'function') routeDisposers.push(dispose);
      } catch (cause) {
        ctx.logger?.warn?.(`dsh-dual-agent: 路由 ${path} 注册失败：${errorText(cause)}`);
      }
    })();
  };

  /**
   * 真实可用性诊断（诚实口径）：本进程有没有一个「非继承父上下文 + 支持
   * continuable」的 subagent provider——这正是「执行者像 subagent」能否成立的前提。
   * 只读、不改状态；工作箱轮询 status 时顺带回答「这台机器上双主智能到底跑不跑得起来」。
   */
  const hatchReadiness = () => {
    try {
      const subagents = subagentsOf();
      if (subagents === undefined) return { providers: [], ready: false, reason: 'subagents 服务不可用' };
      const providers = subagents.list();
      const usable = providers.filter((name) => {
        try {
          const provider = subagents.getProvider?.(name);
          return provider !== undefined && provider.inheritsParentContext === false && provider.prepareContinuable !== undefined;
        } catch { return false; }
      });
      return {
        providers,
        ready: usable.length > 0,
        hatchProvider: usable[0] ?? null,
        reason: usable.length > 0 ? null : '没有非继承型 continuable provider（执行者无法以独立 subagent 形态孵化）',
      };
    } catch (cause) {
      return { providers: [], ready: false, reason: errorText(cause) };
    }
  };

  /**
   * 执行者活性探测（只读、廉价）：running 中用户唯一的安全感来源。主对话按设计
   * 全程静默，若执行者其实已经死了/卡住，用户无从判断——这里把 child 的存活与
   * 状态透出来，让「安静」与「出事」可区分。任何异常都吞掉回 null（status 是
   * 8s 轮询的热路径，绝不允许抛）。
   */
  const childLiveness = (childId) => {
    if (typeof childId !== 'string' || childId === '') return { live: null, status: null };
    try {
      const child = ctx.agents.get(childId);
      if (child === undefined) return { live: false, status: null };
      const status = typeof child.status === 'string' ? child.status : null;
      return { live: true, status };
    } catch { return { live: null, status: null }; }
  };

  const statusOf = (sessionId) => {
    const record = store.recordOf(sessionId);
    const run = sessionId === undefined ? undefined : runs.get(sessionId);
    const agent = sessionId === undefined ? undefined : agentOf(sessionId);
    const recorded = record.phase === 'armed' || record.phase === 'running' ? record.phase : 'off';
    let phase = run !== undefined ? run.phase : recorded;
    // 会话不在本进程时无法核对记录，只能按记录转述（orphan 分支会说实话）。
    if (agent !== undefined) {
      // 收敛排到微任务：回包先走，状态自己会追上（见 reconcileSession）。
      scheduleReconcile(sessionId, false);
    }
    const hatch = hatchReadiness();
    // v21：statusOf 全部按该会话所属家族的快照读取（无快照回模板）——**只读**，
    // 绝不在这里物化（8s 轮询不能写盘；物化只发生在武装时刻的 initFamily）。
    const viewSettings = settingsFor(sessionId);
    // childId 以内存为准、落盘兜底：重载后正是靠落盘里的它把执行者找回来。
    const childId = run?.childId ?? record.childId ?? null;
    const hatching = phase === 'running'
      && (run === undefined ? childId === null : run.childId === undefined);
    const hatchTimedOut = hatching && (typeof run?.hatchStartedAt === 'number'
      ? Date.now() - run.hatchStartedAt > HATCH_GIVE_UP_MS
      : typeof record.since === 'number' && Date.now() - record.since > HATCH_GIVE_UP_MS);
    // 真值化（用户报障的正解）：running 必须有一份**可核对**的活执行者；执行者
    // 已经没了、孵化也超时了，就不是「执行中」——哪怕落盘还写着 running。
    // 会话不在本进程时不做判定（无从核对），交给 orphan 分支说明。
    const child = agent === undefined || childId === null ? undefined : childAgentOf(childId);
    if (agent !== undefined && phase === 'running' && ((!hatching && child === undefined) || hatchTimedOut)) {
      phase = 'armed';
    }
    const live = phase === 'running' ? childLiveness(childId) : { live: null, status: null };
    // 挑刺进度（用户视角的「还有哪几项没过」）：已点名角度数 + 最近一个角度。
    // 零成本（run 里已有），但让「持续表示不符合要求」变成可见的累计状态。
    const anglesUsed = run?.used?.size ?? 0;
    const lastAngle = anglesUsed > 0 ? [...run.used].pop() : null;
    // 「会话不在本进程」时落盘可能还留着 running：绝不能对用户宣称「执行者独立
    // 工作中」——那是个幽灵状态。说实话并指向恢复入口。
    const orphan = recorded === 'running' && run === undefined && agent === undefined;
    // running note 追加活性后缀：静默≠卡死，让用户能分辨。
    // ⚠ orphan 分支不加后缀——它的 note 正文已经把「会话不在本进程」说清了，
    // 再加一句就是同义重复（实测过这个 duplication）。
    const liveSuffix = orphan ? ''
      : live.live === false ? '（执行者会话已不在本进程，可能已结束；稍后会结算或可手动关闭重试）'
        : live.status === 'idle' ? '（执行者本轮已停，正在等待编排结算）'
          : '';
    const status = {
      sessionId: sessionId ?? null,
      phase,
      // 工作箱的约定是 `running: boolean`（它据此决定按钮文案与徽标）。
      // 三态里「已进场」= armed 或 running；armed 另有 `armed` 供 UI 显示待命。
      running: phase !== 'off',
      armed: phase === 'armed',
      note: phase === 'off'
        ? null
        : phase === 'armed'
          ? (typeof run?.blockedBy === 'string' && run.blockedBy !== ''
            ? `执行者暂不孵化：主上下文上一个回合就因同类错误收场（${run.blockedBy}）。执行者继承同一套模型配置，孵化出来也会立刻失败。请先切换模型/推理档位或补额度，再键入指令。`
            : typeof run?.lastExecutorFailure === 'string' && run.lastExecutorFailure !== ''
              ? `上一轮执行者异常中止：${run.lastExecutorFailure}。这类错误同样会影响主上下文，因此没有注入评估轮（避免连报同样的错）。请先修模型/额度，再键入下一条消息继续。`
              : (run?.recoveredFrom === 'running'
                ? '上次的后台执行者已结束（结算在插件重载/进程重启时丢失，报告未取回）。已回到待命：键入下一条消息即可重新开工。'
                : anglesUsed > 0
                  ? `已评估 ${anglesUsed} 轮，最近点名角度：「${lastAngle}」。键入下一条消息继续修正（执行者会带着这几轮结论开工）。`
                  : hatch.ready
                    // v4.1：旧编排关着时别说「下一条就是任务」——那条消息由主智能
                    // 自己判断并派活，不会被编排接管。
                    ? (viewSettings.guidance.orchestrate === true
                      ? '已武装：请键入本任务的初始指令（下一条你发出的消息就是任务）。'
                      : '已启用：主智能只判断、自己把活派给子代理；主会话不会被阻塞。')
                    : `已武装，但暂时无法孵化执行者：${hatch.reason ?? '没有可用的非继承型 provider'}。键入任务会尝试孵化并在失败时说明。`))
          : orphan
            ? `记录显示上次任务仍在进行，但该会话不在本进程（执行者随重启消亡）。重新打开该会话即可恢复为待命并重试。${liveSuffix}`
            : `执行者独立工作中，主对话已让位（保持安静是正常的）；你此时键入的补充会转达给执行者，交报告后挑刺者在主上下文评估。${liveSuffix}`,
      childId,
      hatchAt: run?.hatchAt ?? null, // 客户端可据此走自己的秒表（running 中才有值）
      childLive: live.live,
      childStatus: live.status,
      // 挑刺进度：已点名角度数与最近一个角度（armed 时让用户看见累计状态）。
      anglesUsed,
      lastAngle,
      agentLive: agent !== undefined,
      // 诊断：本次回包是照哪一版逻辑算的（重载是否生效一眼可见）。
      build: BUILD,
      hatch,
      stateFile: store.file,
      storeError: store.error,
      // ── v4 合并面（工作箱二级菜单与状态提示用；全部只读算出，不写状态）──
      guidance: {
        label: LABEL,
        enforce: viewSettings.guidance.enforce === true,
        mode: viewSettings.guidance.mode === 'readonly' ? 'readonly' : 'strict',
        hideMainTools: viewSettings.guidance.hideMainTools === true,
        // v4.1：旧编排（接管主会话）是否开——关着就是「不阻塞、主智能自己派活」。
        orchestrate: viewSettings.guidance.orchestrate === true,
        ...enforce.describe(sessionId),
        degradeNote,
      },
      models: {
        applyChain: viewSettings.models.applyChain === true,
        chain: chain.chainView(sessionId ?? undefined),
        active: chain.activeAgentOptions(sessionId ?? undefined) ?? null,
      },
      verify: {
        enabled: viewSettings.verify.enabled === true,
        urlChecks: viewSettings.verify.urlChecks === true,
        delegation: viewSettings.verify.delegation === true,
        last: run?.lastVerify ?? verifySummaries.get(sessionId) ?? null,
      },
      menu: { label: '子代理模型与规则', route: `${ROUTE}/menu` },
    };
    // v4：note 末尾追加「此刻本插件到底在做什么」。只在开着时说（off 的 note 本来就是
    // null），并且**追加不改写**——工作箱与沙箱 E2E 都按既有 note 文案匹配，改字会误伤。
    if (typeof status.note === 'string' && status.note !== '') {
      const faceState = status.guidance;
      const parts = [
        viewSettings.guidance.enforce === true
          ? `主智能只判断（${viewSettings.guidance.mode === 'readonly' ? '允许只读回看' : '严格'}${faceState.hidden > 0 ? `，已隐藏 ${faceState.hidden} 个工具` : ''}）`
          : '约束关：主智能可自己动手',
        viewSettings.verify.enabled === true ? '出处程序核验开' : '出处核验关',
        viewSettings.models.applyChain === true && status.models?.chain?.configured === true
          ? `子代理走模型链（当前 C${(status.models.chain.activeIndex ?? 0) + 1}）`
          : (viewSettings.models.applyChain === true && status.models?.chain?.configured !== true ? '子代理模型链未配置' : '子代理沿用主会话模型'),
      ];
      if (degradeNote !== null) parts.push(String(degradeNote));
      status.note = `${status.note} ｜ ${parts.join(' · ')}`;
    }
    return status;
  };

  /**
   * 状态推进的唯一实现：`/action` 路由与 `dualAgent` 服务都走这里。
   * - `enabled:true`  关→开：只武装（等用户键入初始指令）；已开则幂等。
   * - `enabled:false` 开→关：running 时先中断执行者（不挑刺），再摘段拆监视器。
   * - `enabled` 省略（旧式按钮）：按当前 phase 循环推进。
   * 会话不在线抛 `dualAgentStatus:'offline'`（路由据此回 409）。
   */
  const transition = async (sessionId, enabled) => {
    const agent = agentOf(sessionId);
    if (agent === undefined) {
      throw Object.assign(
        new Error('会话不在本进程（Agent 不在线）：双主智能只能挂在当前活跃会话上'),
        { dualAgentStatus: 'offline' },
      );
    }
    // 先收敛再推进：否则 ensureRun 会把「记录 running + 执行者还活着」直接降级成
    // armed（看起来像用户关闭过），用户的下一条消息就会再孵一个执行者。
    reconcileSession(sessionId);
    const makeFresh = () => ({
      phase: 'armed', dispose: undefined, used: new Set(), childId: undefined,
      pendingSupplements: [],
      hatchedSeq: undefined, watchDispose: undefined, hatchDispose: undefined, hatchAt: undefined,
      hatchStartedAt: undefined, recovering: false,
      blockedBy: undefined, lastExecutorFailure: undefined,
      criticPending: false, criticRetried: false, lastCriticText: undefined, criticBase: 0,
      critiqueHistory: [],
      recoveredFrom: null,
      // v4：核验去重（callId）与最近一次核验摘要。
      verifiedCalls: [], lastVerify: undefined,
    });

    /** 完全关闭：running 时先中断执行者（不挑刺），再摘段拆监视器。 */
    const disarm = async (run) => {
      if (run !== undefined && run.phase === 'running' && run.childId !== undefined) {
        // 手动关闭 → 立刻清空 childId：执行者随后结算时，孵化 IIFE 里的
        // `st.childId !== childId`（或 st 已删）身份守卫命中，评估轮被吞（不挑刺）。
        const childId = run.childId;
        run.childId = undefined;
        const dispose = run.hatchDispose;
        run.hatchDispose = undefined;
        try {
          subagentsOf()?.interrupt(childId, { kind: 'user', parentSessionId: sessionId });
        } catch (cause) {
          ctx.logger?.warn?.(`dsh-dual-agent: 关闭时中断执行者失败（${childId}）：${errorText(cause)}`);
        }
        // 有余力就显式释放 activation（interrupt 已让 child 停；dispose 归还名额）。
        try { await dispose?.(); } catch { /* 尽力 */ }
      }
      // v4：拆装配走 unshapeSections——人格段与「主智能只判断」的约束段/清单隐藏
      // 必须一起收，否则关掉开关后主智能仍然调不动工具（用户最直接的抱怨点）。
      unshapeSections(sessionId);
      run?.watchDispose?.();
      runs.delete(sessionId);
      store.setPhase(sessionId, 'off');
    };

    const arm = () => {
      const fresh = makeFresh();
      // v21：武装时刻 = 家族初始化时刻（幂等）。从当前模板物化该家族的设置快照，
      // 并把链模板复制给尚无自己链的新家族——之后该家族改设置只动自己的快照。
      initFamily(sessionId);
      runs.set(sessionId, fresh);
      shapeSections(sessionId, agent);
      attachHatchWatcher(sessionId, agent);
      store.setPhase(sessionId, 'armed');
      // v21：武装日志按该家族的快照读（隔离后家族之间可能不一样）。
      const armedView = settingsFor(sessionId);
      ctx.logger?.info?.(`${LABEL}: 已武装待命（session=${sessionId}，约束=${armedView.guidance.enforce === true ? armedView.guidance.mode : '关'}，核验=${armedView.verify.enabled === true ? '开' : '关'}，模型链=${armedView.models.applyChain === true ? '开' : '关'}）`);
      return { ...statusOf(sessionId), action: 'armed' };
    };

    const run = ensureRun(sessionId);

    if (enabled === false) {
      const was = run?.phase ?? 'off';
      await disarm(run);
      return { ...statusOf(sessionId), action: was === 'off' ? 'unchanged' : 'off' };
    }
    if (enabled === true) {
      if (run !== undefined) return { ...statusOf(sessionId), action: 'unchanged' };
      return arm();
    }

    // 旧式按钮：按当前 phase 循环推进。
    if (run === undefined) return arm();
    if (run.phase === 'running') {
      await manualStop(sessionId, agent);
      return { ...statusOf(sessionId), action: 'paused' };
    }
    await disarm(run);
    return { ...statusOf(sessionId), action: 'disarmed' };
  };

  // 可编程面：headless/SDK/E2E 没有 HTTP 也能武装并读实况，还能直接落设置/模型链。
  // 只 provide，不强制任何消费方注入；工作箱仍走 HTTP 路由。
  ctx.provide('dualAgent', {
    status: (sessionId) => statusOf(sessionId),
    transition: (sessionId, enabled) => transition(sessionId, enabled),
    readiness: () => hatchReadiness(),
    // v4 合并面（等价于二级菜单能做的事，供脚本/其它插件程序化驱动）。
    menu: {
      spec: async (sessionId) => menu.buildSpec(sessionId),
      op: async (body) => menu.applyOp(body),
    },
    // v21：settings()/setSetting(id,value) 保持**无 sessionId** 的既有键名与语义
    // （=全局模板口径，e2e 沙箱与既有消费方依赖它）；带会话的口径经
    // settingsView(sessionId) / setSetting(id,value,sessionId) 在模块内部与菜单使用。
    settings: () => settingsView(),
    setSetting: (id, value) => setSetting(id, value),
    chain: {
      view: (sessionId) => chain.chainView(sessionId),
      set: (sessionId, candidates, flags) => chain.setChain(sessionId, candidates, flags),
      adjust: (sessionId, patch) => chain.adjust(sessionId, patch),
      reset: (sessionId) => chain.resetCounters(sessionId),
      clear: (sessionId) => chain.clearChain(sessionId),
    },
    verify: {
      evidenceProtocol,
      run: (sessionId, text, afterMs) => runVerify(sessionId, text, afterMs, '程序化调用'),
    },
    build: BUILD,
  });

  register(`${ROUTE}/status`, async (req, res, json) => {
    if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' });
    let sessionId;
    try {
      sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId') ?? undefined;
    } catch { sessionId = undefined; }
    // 回包本身是只读的：phase 由**可核对的现实**算出来（见 statusOf 的真值化），
    // 不在这里写盘。收敛（接管活执行者 / 把幽灵 running 收回待命 / 读回报告）
    // 由 statusOf 排到微任务里跑，只纠正与记录冲突的状态，绝不会把 off 的会话
    // 凭空武装——所以每 8s 轮询不会复活用户没开的东西。
    return json(200, statusOf(sessionId));
  });

  register(`${ROUTE}/action`, async (req, res, json) => {
    if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!sameOrigin(req)) return json(403, { error: 'cross-origin request rejected' });
    const body = await readBody(req, 1 << 20);
    if (!body.ok) return json(400, { error: body.error });
    let parsed;
    try { parsed = JSON.parse(body.text === '' ? '{}' : body.text); } catch { return json(400, { error: 'body 不是合法 JSON' }); }
    const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId : '';
    if (sessionId === '') return json(400, { error: 'sessionId 必填' });
    // 开关语义：客户端上送**目标状态**（enabled）。旧式按钮调用（无 enabled）
    // 仍按三态循环推进，保持对旧客户端/自测的兼容。
    const enabled = typeof parsed?.enabled === 'boolean' ? parsed.enabled : undefined;
    try {
      const result = await transition(sessionId, enabled);
      return json(200, result);
    } catch (cause) {
      if (cause && cause.dualAgentStatus === 'offline') return json(409, { error: cause.message });
      return json(500, { error: `dual-agent 动作失败：${errorText(cause)}` });
    }
  });

  // ── v4 二级菜单（内容由本插件出，渲染在 dsh-workbench 的浮层里）─────────────
  // GET  /dsh-dual-agent/menu?sessionId=…  → 声明式面板 spec
  // POST /dsh-dual-agent/menu {sessionId, op, …} → 落库后回**新 spec**（客户端直接重绘）
  // 约定：spec 里只有通用件（note/switch/select/text/rows/form/buttons），工作箱
  // 不认识「模型链」这种语义——语义全在这里，工作箱只按件型画。
  register(`${ROUTE}/menu`, async (req, res, json) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      let sessionId;
      try {
        sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId') ?? '';
      } catch { sessionId = ''; }
      if (sessionId === '') return json(400, { error: '需要 sessionId 查询参数' });
      try {
        return json(200, await menu.buildSpec(sessionId));
      } catch (cause) {
        return json(500, { error: `菜单生成失败：${errorText(cause)}` });
      }
    }
    if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!sameOrigin(req)) return json(403, { error: 'cross-origin request rejected' });
    const body = await readBody(req, 1 << 20);
    if (!body.ok) return json(400, { error: body.error });
    let parsed;
    try { parsed = JSON.parse(body.text === '' ? '{}' : body.text); } catch { return json(400, { error: 'body 不是合法 JSON' }); }
    try {
      return json(200, await menu.applyOp(parsed));
    } catch (cause) {
      const status = typeof cause?.menuStatus === 'number' ? cause.menuStatus : 500;
      return json(status, { error: errorText(cause) });
    }
  });

  ctx.logger?.info?.(`${LABEL}: 就绪 v4.1（家族隔离版，state=${stateFile}，恢复模型链 ${restoredChains} 条，构建=${BUILD}）`);
}
