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
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const name = 'dual-agent';

/**
 * agents（Agent 注册表）必选；webServer **不在 inject 里**——headless/SDK 这类
 * composition 没有 webServer，硬注入会让整个插件 pending、双主智能在命令行宿主里
 * 根本装不上。用 `ctx.get('webServer')` 做可选查找（未注入的服务 ctx.get 安全返回
 * undefined，而 `ctx.webServer` 属性访问会抛）；有 webServer 才挂工具箱/自测路由。
 */
export const inject = ['agents'];

const ROUTE = '/dsh-dual-agent';
const STATE_VERSION = 2;
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

/** 供 status 透出的构建标识（诊断用：确认进程里跑的是哪一版）。 */
const BUILD = '3.5.0+reconcile';

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
const CHILD_TASK_TAIL = `\n\n（编排说明：你是「双主智能」的执行者。请专注完成任务，并在**收尾消息**里给出**自足的最终报告**——它会被原样送回主上下文做评估。除此之外没有别的特殊流程。）`;

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
  let doc = { version: STATE_VERSION, sessions: {} };
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
      doc = { version: STATE_VERSION, sessions };
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
const ORCHESTRATOR_PREFIXES = ['【挑刺者评估】', '【双主智能编排】'];

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
    const names = run.phase === 'running'
      ? [{ name: CRITIC_SECTION, text: CRITIC_PROMPT }, { name: RUNNING_SECTION, text: RUNNING_PROMPT }]
      : [{ name: CRITIC_SECTION, text: CRITIC_PROMPT }, { name: ARMED_SECTION, text: ARMED_PROMPT }];
    run.dispose = installSections(agent, names);
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
      label: '双主智能·执行者',
      request: {
        // 内容块原样转交，任务说明作为最后一枚 text 块附上。
        prompt: [...priorBlocks, ...taskBlocks, { type: 'text', text: CHILD_TASK_TAIL }],
        parent: agent,
        ...maxDepth === undefined ? {} : { maxDepth },
      },
      signal: new AbortController().signal,
      delivery: 'caller',
    });
    return { childId: activation.childId, result: activation.result, dispose: activation.dispose };
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
    run.dispose?.();
    run.watchDispose?.();
    runs.delete(agent.id);
    store.setPhase(agent.id, 'off');
  });

  // 插件卸载（含 profile 重载）→ 全拆本实例的装配。
  // ⚠ 落盘记录**故意保留**：会话还活着、执行者可能还在跑，record 里的 childId 就是
  // 下一个实例把执行者接回来的唯一线索（见 reconcileSession 的接管分支）。这里只
  // 摘段拆监视器——不写盘、不改 phase。
  ctx.effect(() => () => {
    for (const [sessionId, run] of [...runs.entries()]) {
      run.dispose?.();
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
      criticPending: false,
      criticRetried: false,
      lastCriticText: undefined,
      criticBase: 0,
      critiqueHistory: [],
      // 上一次进程内是 running（执行者随进程消亡，或插件重载丢了在途结算）→ 让用户
      // 知道旧任务已结束，而不是对着通用待命文案以为任务还在跑。用户发新任务时清除。
      recoveredFrom: record.phase === 'running' ? 'running' : null,
    };
    store.setPhase(sessionId, 'armed');
    runs.set(sessionId, recovered);
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
      const from = Math.max(0, seq - 400);
      return lastTurnStopReasonOfEvents(child.session?.snapshotEvents?.(from) ?? []);
    } catch { return undefined; }
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

  /** 注入挑刺者评估轮（结算路径与「读回报告」路径共用）。 */
  const deliverCritic = (agent, run, childId, stopReason, reportText) => {
    const criticText = criticEvaluateWithAngle(agent, run.used, childId, stopReason, reportText);
    // 记录评估轮状态：注入后若该轮**自己失败**（额度/网络报错、无正文），
    // 主上下文会停在一条用户看得见的注入消息上没有任何回复——观感是
    // 「插件哑了」。监听 turn/end 给它一次自动重试 + 可读兜底。
    run.criticPending = true;
    run.criticRetried = false;
    run.lastCriticText = criticText;
    run.criticBase = agent.session?.seq ?? 0;
    deliver(agent, criticText);
  };

  /** 结算：报告到手 → 回待命 + 评估轮（只由兑现结算令牌的那一方投递）。 */
  const settleWithReport = (sessionId, agent, run, childId, stopReason, reportText) => {
    const { claimed } = releaseRun(sessionId, agent, run);
    if (claimed !== true) {
      ctx.logger?.debug?.(`dsh-dual-agent: 结算已由别处兑现（session=${sessionId} child=${childId}），不重复投递`);
      return false;
    }
    deliverCritic(agent, run, childId, stopReason, reportText);
    return true;
  };

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
        deliverCritic(agent, run, childId, report.stopReason,
          reportTextOf({ output: [{ type: 'text', text: report.text }] }));
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
      settleWithReport(sessionId, agent, run, childId, stopReason,
        reportTextOf({ output: [{ type: 'text', text: report?.text ?? '' }] }));
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
      adopted: true,
    };
    runs.set(sessionId, adopted);
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

      // ── armed 态：这条人类消息就是初始指令 → 孵化执行者 ──
      if (current.phase !== 'armed') return;
      // 纯文本为空但有附件（截图/文档）时**也要**孵化：否则这条消息会被吞掉。
      if (taskBlocks.length === 0) return;
      if (current.hatchedSeq === event.seq) return;
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
          // 结算收口（含跨实例互斥）与评估注入共用同一条实现，见 settleWithReport。
          settleWithReport(sessionId, agent, st, childId, stopReason, reportTextOf(settled));
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
        // 评估轮兜底：注入【挑刺者评估】后，若这一轮以 error/aborted 收场且没产出
        // 任何 assistant 正文，用户只会看见一条内部注入消息而没有回复。给它一次
        // 自动重试；再失败就用编排消息把情况讲明白（报告已送达、评估暂时不可用）。
        const run = runs.get(sessionId);
        if (run === undefined || !run.criticPending) return;
        const reason = event.data?.reason?.kind;
        if (reason === 'completed') { run.criticPending = false; return; }
        // 用户手动打断评估轮（aborted/其它）= 明确意图：不重试、不兜底，静默清账。
        if (reason !== 'error') { run.criticPending = false; return; }
        run.criticPending = false;
        const wroteText = ((agent.session?.snapshotEvents?.(run.criticBase ?? 0) ?? [])
          .some((ev) => ev.type === 'assistant/message'));
        if (wroteText) return; // 已经有正文（哪怕回合收尾异常），不打扰
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
    return {
      sessionId: sessionId ?? null,
      phase,
      // 工作箱的约定是 `running: boolean`（它据此决定按钮文案与徽标）。
      // 三态里「已进场」= armed 或 running；armed 另有 `armed` 供 UI 显示待命。
      running: phase !== 'off',
      armed: phase === 'armed',
      note: phase === 'off'
        ? null
        : phase === 'armed'
          ? (run?.recoveredFrom === 'running'
            ? '上次的后台执行者已结束（结算在插件重载/进程重启时丢失，报告未取回）。已回到待命：键入下一条消息即可重新开工。'
            : anglesUsed > 0
              ? `已评估 ${anglesUsed} 轮，最近点名角度：「${lastAngle}」。键入下一条消息继续修正（执行者会带着这几轮结论开工）。`
              : hatch.ready
                ? '已武装：请键入本任务的初始指令（下一条你发出的消息就是任务）。'
                : `已武装，但暂时无法孵化执行者：${hatch.reason ?? '没有可用的非继承型 provider'}。键入任务会尝试孵化并在失败时说明。`)
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
    };
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
      criticPending: false, criticRetried: false, lastCriticText: undefined, criticBase: 0,
      critiqueHistory: [],
      recoveredFrom: null,
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
      run?.dispose?.();
      run?.watchDispose?.();
      runs.delete(sessionId);
      store.setPhase(sessionId, 'off');
    };

    const arm = () => {
      const fresh = makeFresh();
      runs.set(sessionId, fresh);
      shapeSections(sessionId, agent);
      attachHatchWatcher(sessionId, agent);
      store.setPhase(sessionId, 'armed');
      ctx.logger?.info?.(`dsh-dual-agent: 已武装待命（session=${sessionId}）`);
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

  // 可编程面：headless/SDK/E2E 没有 HTTP 也能武装双主智能并读实况。
  // 只 provide，不强制任何消费方注入；工具箱仍走 HTTP 路由。
  ctx.provide('dualAgent', {
    status: (sessionId) => statusOf(sessionId),
    transition: (sessionId, enabled) => transition(sessionId, enabled),
    readiness: () => hatchReadiness(),
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

  ctx.logger?.info?.(`dsh-dual-agent: 就绪 v2（state=${stateFile}）`);
}
