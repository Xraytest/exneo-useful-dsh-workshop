/**
 * 「用户消息完全保留」压缩规则（dsh-user-keep-compaction）— host 半边静态插件。
 *
 * 规则（用户 2026-10-08 指定）：压缩只作用于 user 角色可见节点之间的助手/工具
 * 内容 —— 人类消息与注入上下文一律逐字留在可见面上，永远不进摘要。2026-11-05
 * 起本规则**默认启用**（见下方 v4）。其余策略与出厂 compaction-basic 同口径
 * （阈值/保留预算同一套公式 / 先裁剪后摘要（能拿到裁剪器时）/ 摘要失败不
 * 阻断本轮 / 溢出恢复 / 影子计价 / 只增日志 + surface replace）。
 *
 * ── v3（2026-10-28）修了什么 ────────────────────────────────────────────
 * v2 的阈值口径与出厂不一致，导致本规则在真实长会话里几乎不被执行：
 *   出厂：threshold = min(窗口 × 0.8, 窗口 − 预留输出 − headroom)
 *         retain    = (窗口 − 预留输出) × 0.16
 *   v2：  threshold = 窗口 × 0.8；retain = 窗口 × 0.16
 * 以 opencode-go/deepseek-v4.1-flash（窗口 300000、请求 maxTokens 100000）
 * 为例：出厂 134464 就压，v2 要等 240000。于是每步压力刚过出厂线就被出厂
 * 引擎整段压掉（user 消息一并阴影），本插件每步都 below-threshold 空转。
 * 实测某启用会话：117 次压缩里 111 次是出厂干的，用户原话被换成摘要。
 * v3 把这两项改成与出厂同一套公式（headroom 可配置），插件作为 prepend
 * 监听器仍在同一步抢先动手，压完压力回落后出厂那段阈值检查自然空转。
 *
 * ── v4（2026-11-05）默认启用 ─────────────────────────────────────────────
 * 用户指定：本规则改为**默认启用**（与 ultracode 的 provision 口径对齐）。改的
 * 是「没有记录 = 关」这个缺省：没有落盘记录的会话（含新会话）一律按启用处理；
 * 显式关掉的会话（enabled:false 已落盘）仍然保持关闭，重启后也仍是关。
 * 具体落在三处：
 *   ① store.enabled() 无记录 → true（缺省启用）；
 *   ② status 路由对无记录会话报 enabled:true、decidedAt:null —— 浏览器半边
 *      的开关因此开局即点亮，用户仍可在首条消息发出前点一下关掉；
 *   ③ manualCompactBypasses 用「生效中的启用态」计算，而不是只认落盘记录。
 *
 * ── v5（2026-11-07）失败要说真话 + 摘要路由跟住「当前选择」 ──────────────────
 * 事故现场（真实会话 session-cc7f25a0…）：用户把模型从 zcodecoding/GLM-5.3 换成
 * insidegate/Qwen/Qwen3.8-Flash-Next，紧接着敲 /compact，回执只有一句
 *   Rule-based compaction did not run (summary-failed).
 * 所有信息被压成一个标签，看不出是路由错、配额耗尽还是实现 bug。查明两条：
 *   ① 摘要调用用的是**上一轮已落盘的 request/header**（zcodecoding/GLM-5.3），
 *      不是用户刚选中的路由。换模型只写 model/selection，要等下一次 turn/start
 *      才落 header；手工压缩发生在这两步之间，于是必然拿旧路由去撞那家已经用尽
 *      的 5 小时配额（HTTP 429 / code 1308）。v5 的路由解析顺序改为：
 *        agent.model.current()（活的 pending/next 选择）
 *        → session.requestHeader().config → agent.options
 *      并在回执里注明取自哪一处、以及 header 与活选择的差异。
 *   ② callSummarizer 把「为什么失败」全吞了（catch → null；finish 非正常 → null），
 *      调用方只剩 summary-failed 可说。v5 让它返回结构化结果
 *        { ok, blocks, usage, failure: { stage, code, message, kind, elapsedMs, aborted } }
 *      把 provider 错误码 / HTTP 状态 / 耗时如实带回 /compact 回执。
 * 另外两条硬约束：
 *   - 用户取消（signal aborted、finish.kind='aborted'）**永不**报成失败；回执写
 *     cancelled，不写 "did not run (…)"。
 *   - `summary-failed` 只作最后兜底：拿不到任何具体原因时才出现。
 * 还加了一个诊断路由 GET /dsh-ukc/probe（同一套同源守卫）：一次把路由三源、
 * resolveModelInfo、预算/阈值、meter、planRuns、锁状态，以及可选的一次极小摘要
 * 调用（?summarize=1，可带 provider/model 覆盖）全部吐出来 —— 下次再出问题不必
 * 再从 zstd 会话日志里反推。
 *
 * 为什么是「多段替换」：出厂压缩是一次连续区间替换（surfaceOp.replace 只能
 * 覆盖一个连续跨度），而被保留的 user 节点散落在区间内部，所以本插件把
 * 「user 消息之间的助手/工具段」逐段规划为各自连续的 run，一次模型调用产出
 * 一份摘要，落在**最老的那一段**，其余段各落一条极短的指针检查点。可见面
 * 顺序因此完全不变：用户消息留在原位，段与段之间的助手/工具内容被摘要取代。
 *
 * 与原版逐条对齐的实现要点：
 *  - 计量：一律 `ctx.tokenMeter`（决策用路由价 tokens，影子价用固定启发式
 *    heuristicTokens，与 foldSurfaceProjection 的自我一致要求一致）。
 *  - 确定权：本监听器 `prepend: true` 排在 agent/pre-step waterfall 最前，
 *    先于预设里的 compaction-basic 动手；本插件压完压力若已回落，原版那段
 *    阈值检查自然空转。
 *  - 事务：`compaction/start`（同步落盘即锁）→ `compaction/summary`（或后续段
 *    的 `compaction/prune` 影子计价）紧邻替换事件 → `compaction/end` 只尝试一次。
 *    可见面替换事件沿用出厂标记（source.kind='plugin' && plugin='compact'），
 *    因此轨迹/聊天页按压缩检查点渲染，不会显示成用户气泡。
 *  - 溢出恢复：agent/request-error 上按 CONTEXT_WINDOW_EXCEEDED 接管（prepend，
 *    顺序与注册时间/热重载无关），只在真的改动了可见面时返回 retry，配额按成功
 *    次数扣、回到 idle 还清。
 *  - 失败语义：start 之后的任何一步失败都会补一条 `compaction/end{error}` 放掉
 *    锁（否则半截事务会把整个会话堵死）；单轮失败不阻断本轮。当规则压不下去
 *    （保留内容本身就超过阈值）时退回出厂压缩，并在状态路由里记为 fallback。
 *
 * 规则覆盖不到的地方（如实记录，不假装覆盖）：
 *  - 预设实景里的 `/compact`：v3 起已在 agent 作用域 Shadow 一份规则版命令
 *    （见 shadowManualCompact），启用规则的会话里手工压缩也逐字保留 user 消息；
 *    但**未启用**的会话、以及 agent 不在本进程时，仍走出厂 compactNow。
 *  - 本部署的 toolResultPruner 只存在于预设实景：host 平面 `ctx.get` 拿不到，
 *    退一步经 `agent.ctx` 取同一实例，两处都没有就跳过裁剪（状态路由 `pruner`
 *    字段如实报告 host / agent / none）。
 *  - minimal 预设没有 compaction 栈，「退回出厂压缩」在那类会话里等于不压。
 *
 * 组合行（profile 的 cordis.patch.yml，v5 起指向本文件）：
 *   - insert:
 *       - id: user-keep-compaction
 *         name: ./plugins/dsh-user-keep-compaction/entry-v5.js
 *
 * 路由（同源守卫；sessionId 由浏览器半边显式携带）：
 *   GET  /dsh-ukc/status ?sessionId=…  → {sessionId, enabled, canSet, decidedAt, live, pruner, fallback, entryVersion, route}
 *   GET  /dsh-ukc/probe  ?sessionId=…[&summarize=1][&provider=…&model=…] → v5 诊断快照
 *   POST /dsh-ukc/set    {sessionId, enabled} → 新会话未发消息时写入并落盘
 *
 * @module dsh-user-keep-compaction
 */

import { compactCheckpointSource, isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const name = 'dsh-user-keep-compaction';

/** 浏览器半边调用的路由前缀。 */
const ROUTE_PREFIX = '/dsh-ukc';
/** 出厂压缩检查点的稳定标记（`isCompactCheckpointSource` 判定的就是这两个字段）。 */
const COMPACT_PLUGIN = 'compact';
/** 上游上下文溢出的归一错误码。 */
const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED';

/** 缺省策略：阈值/保留预算与 dsh-compaction-basic 的出厂缺省逐项同口径。 */
const DEFAULTS = Object.freeze({
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  maxTokens: 8192,
  maxOverflowRetries: 1,
  /** 每一步最多尝试几轮（第 2 轮把保留尾巴压到 0，用于极端情况下的尽职压降）。 */
  maxPassesPerStep: 2,
  /** 出厂口径的压缩余量：阈值再被「窗口 − 预留输出 − headroom」压一次（出厂缺省 65536）。 */
  headroomTokens: 65536,
  /** 选择落盘文件；空串表示 $DSH_HOME/user-keep-compaction.json。 */
  stateFile: '',
});

/* ── 出厂压缩的框架文案（逐字取自 @deepseek-ai/dsh-compaction-basic，保持
 *    模型侧观感与「历史检查点要合并」的规则一致） ───────────────────────── */
const SUMMARY_OPEN_TAG = '<compacted-summary>';
const SUMMARY_CLOSE_TAG = '</compacted-summary>';
const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the ASSISTANT AND TOOL OUTPUT in the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'The user-role messages above are NOT being condensed: they stay in the conversation verbatim, in place. Do not restate, quote, or summarize them — cite one only where a technical fact would otherwise be ambiguous.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n');
/** 后续段落的指针检查点正文：极短，只为让模型知道这段内容已并入上方检查点。 */
const POINTER_TEXT = '(This span of assistant and tool output was condensed into the checkpoint above. The user messages around it are preserved verbatim and in place.)';

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const seqOf = (value) => Number(value);

/** 展开 `~` 前缀（DSH_HOME 允许写成 ~/…，与 dsh-safefull 同口径）。 */
function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/** 会话缺省落盘路径：$DSH_HOME/user-keep-compaction.json（展开 ~ 后绝对化）。 */
export function defaultStateFile() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return resolve(expandHome(home), 'user-keep-compaction.json');
}

/** 校验并冻结一份策略配置。 */
export function resolveConfig(raw) {
  if (raw !== undefined && !isRecord(raw)) throw new Error('dsh-user-keep-compaction: config 必须是对象');
  const config = { ...DEFAULTS, ...(raw ?? {}) };
  for (const key of Object.keys(config)) {
    if (!(key in DEFAULTS)) throw new Error(`dsh-user-keep-compaction: 未知配置项 "${key}"`);
  }
  if (!Number.isFinite(config.thresholdRatio) || config.thresholdRatio <= 0 || config.thresholdRatio > 1) {
    throw new Error('dsh-user-keep-compaction: thresholdRatio 必须落在 (0, 1]');
  }
  if (!Number.isFinite(config.retainRatio) || config.retainRatio < 0 || config.retainRatio >= config.thresholdRatio) {
    throw new Error('dsh-user-keep-compaction: retainRatio 必须落在 [0, thresholdRatio)');
  }
  if (!Number.isInteger(config.maxTokens) || config.maxTokens < 1) {
    throw new Error('dsh-user-keep-compaction: maxTokens 必须是正整数');
  }
  if (!Number.isInteger(config.maxOverflowRetries) || config.maxOverflowRetries < 0) {
    throw new Error('dsh-user-keep-compaction: maxOverflowRetries 必须是非负整数');
  }
  if (!Number.isInteger(config.maxPassesPerStep) || config.maxPassesPerStep < 1) {
    throw new Error('dsh-user-keep-compaction: maxPassesPerStep 必须是正整数');
  }
  if (!Number.isInteger(config.headroomTokens) || config.headroomTokens < 0) {
    throw new Error('dsh-user-keep-compaction: headroomTokens 必须是非负整数');
  }
  if (typeof config.stateFile !== 'string') throw new Error('dsh-user-keep-compaction: stateFile 必须是字符串');
  return Object.freeze({ ...config, stateFile: config.stateFile === '' ? defaultStateFile() : config.stateFile });
}

/* ── 会话级选择：落盘存储（原子写 tmp + rename） ─────────────────────────── */

/**
 * 建立按 sessionId 索引的选择存储。
 *
 * 写盘是「先重读、再合并、再原子换名」：同一份 $DSH_HOME 可能同时被两个 dsh
 * 进程使用（例如 web 与另一个 profile 实例），整表覆写会让后写的进程抹掉前者
 * 刚写的记录；合并后各进程只增改自己动过的 key，互不覆盖。
 *
 * @param file - JSON 落盘路径。
 * @param onError - 落盘失败的告警回调。
 * @returns 读写接口；`set` 之后立刻落盘。
 */
export function createStore(file, onError = () => {}) {
  const sessions = new Map();
  /** 读回一份盘上记录表（缺文件返回空表；坏文件抛给调用方）。 */
  const readFileRecords = () => {
    const table = new Map();
    if (!existsSync(file)) return table;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (isRecord(parsed) && isRecord(parsed.sessions)) {
      for (const [sessionId, record] of Object.entries(parsed.sessions)) {
        if (isRecord(record) && typeof record.enabled === 'boolean') {
          table.set(sessionId, {
            enabled: record.enabled,
            decidedAt: Number.isFinite(record.decidedAt) ? record.decidedAt : 0,
          });
        }
      }
    }
    return table;
  };
  try {
    for (const [sessionId, record] of readFileRecords()) sessions.set(sessionId, record);
  } catch (error) {
    onError(error);
  }
  const persist = () => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      // 先补上盘上已有、本进程内存里没有的条目（本进程的改动优先）。
      try {
        for (const [sessionId, record] of readFileRecords()) {
          if (!sessions.has(sessionId)) sessions.set(sessionId, record);
        }
      } catch {
        /* 坏文件/读失败：按内存表整表重写，至少不丢本进程的选择 */
      }
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions: Object.fromEntries(sessions) }, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    } catch (error) {
      onError(error);
    }
  };
  return {
    /** 该会话是否启用了本规则（缺省启用：只有显式关掉的会话才算关）。 */
    enabled(sessionId) {
      return sessions.get(sessionId)?.enabled !== false;
    },
    /** 读取一条记录（无则 undefined）。 */
    get(sessionId) {
      return sessions.get(sessionId);
    },
    /** 写入一条选择并落盘。 */
    set(sessionId, enabled) {
      const record = { enabled: enabled === true, decidedAt: Date.now() };
      sessions.set(sessionId, record);
      persist();
      return record;
    },
    /** 仅测试用：清空内存态。 */
    size() {
      return sessions.size;
    },
  };
}

/* ── 可见面分类与选区（纯逻辑，自测覆盖） ───────────────────────────────── */

/**
 * 事件是否为出厂压缩检查点（历史检查点要可被并入新摘要，因此算「可压」。）
 *
 * marker 随协议代变过：0.1 是 `{kind:'plugin', plugin:'compact'}`，0.2 是
 * `{kind:'compact-checkpoint'}`。这里优先问当前代的 `isCompactCheckpointSource`，
 * 再兜底认旧字面量——旧会话日志在 harness 迁移跑完之前仍要能被正确分类。
 */
export function isCheckpointSource(source) {
  if (!isRecord(source)) return false;
  if (isCompactCheckpointSource(source)) return true;
  return source.kind === 'plugin' && source.plugin === COMPACT_PLUGIN;
}

/**
 * 判定一个可见面节点在本规则下是「逐字保留」还是「可压」。
 *
 * 保留 = 一切 user 角色内容（人类消息、工作区指令、运行时上下文、技能目录、
 * 压缩后注入的提醒……）—— 规则原文是「用户消息完全保留」，本实现按最保守的
 * 读法执行：user 角色的东西一律不摘。唯一例外是**历史压缩检查点**：它本身
 * 就是早先压缩的产物，必须能被下一代摘要合并，否则检查点会层层堆积。
 *
 * @param session - 提供事件日志的会话。
 * @param seq - 可见面节点 seq。
 * @returns 'preserved' | 'compressible'。
 */
export function nodeKind(session, seq) {
  const event = session.eventAt(seq);
  if (event === undefined || event === null) return 'compressible';
  if (event.type !== 'user/message') return 'compressible';
  if (isCheckpointSource(event.data?.source)) return 'compressible';
  return 'preserved';
}

/**
 * 计算每个位置之前的边界是否「工具对平衡」：平衡 = 此前发出的 tool-call 已全
 * 部拿到 tool/result。切点只允许落在平衡边界上，否则会把一次工具调用和它的
 * 结果劈成两半，provider 侧直接报错。
 *
 * @param session - 提供事件日志的会话。
 * @param surface - 当前可见面 seq 列表。
 * @returns 长度 n+1 的数组，[i] 表示「节点 i 之前」是否平衡。
 */
export function balanceBoundaries(session, surface) {
  const pending = new Set();
  const balanced = new Array(surface.length + 1).fill(true);
  for (let index = 0; index < surface.length; index += 1) {
    const event = session.eventAt(surface[index]);
    if (event?.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type === 'tool-call' && typeof block.id === 'string') pending.add(block.id);
      }
    } else if (event?.type === 'tool/result') {
      const message = event.data?.message;
      const callId = message?.source?.callId ?? message?.content?.[0]?.toolCallId;
      if (typeof callId === 'string') pending.delete(callId);
    }
    balanced[index + 1] = pending.size === 0;
  }
  return balanced;
}

/** 可见面 0 号节点是否是被保护的 system 头。 */
function hasSystemHead(session, seq) {
  return session.eventAt(seq)?.type === 'system/message';
}

/**
 * 规划本次压缩：先按出厂策略切出「可动头部」（尾部按 retainTokens 逐字保留），
 * 再在头部里把可压节点切成若干连续 run，每个 run 两端吸附到工具对平衡边界。
 *
 * @param session - 会话（提供权威可见面）。
 * @param measurement - `tokenMeter.measure(session)` 的结果。
 * @param retainTokens - 至少逐字保留的近期尾巴预算。
 * @returns `{ firstIdx, keepFromIdx, headSeqs, runs, headTokens, headHeuristicTokens }` 或 null。
 */
export function planRuns(session, measurement, retainTokens) {
  const priced = measurement?.nodes;
  const surface = session?.surface?.nodes;
  if (!Array.isArray(priced) || !Array.isArray(surface) || priced.length === 0 || surface.length !== priced.length) return null;
  for (let index = 0; index < surface.length; index += 1) {
    if (seqOf(surface[index]) !== seqOf(priced[index].seq)) return null;
  }
  const firstIdx = hasSystemHead(session, surface[0]) ? 1 : 0;
  if (priced.length <= firstIdx) return null;

  // 与出厂一致的尾部保留：从尾部累加路由价，到 retainTokens 为止。
  let accumulated = 0;
  let keepFromIdx = priced.length;
  for (let index = priced.length - 1; index >= 0; index -= 1) {
    accumulated += priced[index].tokens;
    keepFromIdx = index;
    if (accumulated >= retainTokens) break;
  }
  if (keepFromIdx <= firstIdx) return null;

  const balanced = balanceBoundaries(session, surface);
  const kinds = new Array(surface.length);
  for (let index = 0; index < surface.length; index += 1) kinds[index] = nodeKind(session, surface[index]);

  const runs = [];
  let index = firstIdx;
  while (index < keepFromIdx) {
    if (kinds[index] !== 'compressible') {
      index += 1;
      continue;
    }
    let end = index;
    while (end + 1 < keepFromIdx && kinds[end + 1] === 'compressible') end += 1;
    let from = index;
    let to = end;
    while (from <= to && balanced[from] !== true) from += 1;
    while (to >= from && balanced[to + 1] !== true) to -= 1;
    if (from <= to) {
      const seqs = [];
      let tokens = 0;
      let heuristicTokens = 0;
      for (let cursor = from; cursor <= to; cursor += 1) {
        seqs.push(seqOf(surface[cursor]));
        tokens += priced[cursor].tokens;
        heuristicTokens += priced[cursor].heuristicTokens;
      }
      runs.push({ seqs, tokens, heuristicTokens, startSeq: seqs[0], endSeq: seqs[seqs.length - 1] });
    }
    index = end + 1;
  }
  if (runs.length === 0) return null;

  let headTokens = 0;
  let headHeuristicTokens = 0;
  for (let cursor = firstIdx; cursor < keepFromIdx; cursor += 1) {
    headTokens += priced[cursor].tokens;
    headHeuristicTokens += priced[cursor].heuristicTokens;
  }
  return {
    firstIdx,
    keepFromIdx,
    headSeqs: surface.slice(firstIdx, keepFromIdx).map(seqOf),
    runs,
    headTokens,
    headHeuristicTokens,
  };
}

/** 头部里被逐字保留的节点总路由价（用于收缩校验）。 */
export function preservedTokens(session, plan, measurement) {
  const inRuns = new Set();
  for (const run of plan.runs) for (const seq of run.seqs) inRuns.add(seq);
  let tokens = 0;
  for (let index = plan.firstIdx; index < plan.keepFromIdx; index += 1) {
    const seq = seqOf(session.surface.nodes[index]);
    if (!inRuns.has(seq)) tokens += measurement.nodes[index].tokens;
  }
  return tokens;
}

/* ── 消息与摘要框架 ─────────────────────────────────────────────────────── */

/** 出厂风格的检查点 user 消息（标记为 compact 检查点，UI 按压缩卡片渲染）。 */
export function checkpointMessage(compactionId, blocks) {
  return {
    role: 'user',
    id: randomUUID(),
    source: compactCheckpointSource(compactionId),
    content: [
      { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
      ...blocks,
      { type: 'text', text: SUMMARY_CLOSE_TAG },
    ],
  };
}

/** 后续段落的指针检查点：同样是 compact 检查点，下一代压缩可并入。 */
export function pointerMessage(compactionId) {
  return {
    role: 'user',
    id: randomUUID(),
    source: compactCheckpointSource(compactionId),
    content: [{ type: 'text', text: POINTER_TEXT }],
  };
}

/** 把流式 text 增量按块序号拼成摘要正文。 */
export function joinTextDeltas(chunks) {
  return chunks.filter((text) => typeof text === 'string').join('');
}

/* ── 运行时 ─────────────────────────────────────────────────────────────── */

/** 会话日志里是否已经有真实人类消息（决定这条会话还能不能改选择）。 */
export function hasHumanMessage(session) {
  if (session === undefined || session === null) return false;
  const last = Number.isFinite(session.seq) ? session.seq : 0;
  for (let seq = 0; seq < last; seq += 1) {
    const event = session.eventAt(seq);
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') return true;
  }
  return false;
}

/** 会话日志里是否存在未配对的 compaction/start（= 压缩进行中）。 */
export function hasOpenCompaction(session) {
  const last = Number.isFinite(session.seq) ? session.seq : 0;
  for (let seq = last - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (event?.type === 'compaction/start') return true;
    if (event?.type === 'compaction/end') return false;
    if (event?.type === 'session/end-seed') return false;
  }
  return false;
}

/** 候选是否构成可用路由：provider 与 model 都是非空字符串。 */
function isRoute(candidate) {
  return (
    isRecord(candidate)
    && typeof candidate.provider === 'string' && candidate.provider !== ''
    && typeof candidate.model === 'string' && candidate.model !== ''
  );
}

/**
 * 读「当前选择」：Agent 的活选择器（用户在 UI 里挑的那个），读不到就返回 null。
 * 出厂摘要走的是 `session.requestHeader()?.config`，即最近一次真正发出去的请求；
 * 用户刚改完选择、还没发下一轮时，那个头是**过期的**，于是摘要会打到一条已经
 * 失效的路由上（这正是 v4 那次 0.75 s 失败：头里还是额度耗尽的 zcodecoding）。
 */
export function readLiveSelection(agent) {
  try {
    const selection = agent?.model?.current?.();
    return isRoute(selection) ? { provider: selection.provider, model: selection.model } : null;
  } catch {
    return null;
  }
}

/**
 * 解析当前路由目标。优先级按「用户的心智模型」排：
 * ① Agent 的活选择（刚在 UI 里挑的模型，即使这一轮还没发出去）；
 * ② 最近一次已落盘的请求头（出厂行为，保留作兜底）；
 * ③ Agent 选项（配置默认值）。
 * 同时回传已落盘的请求头，便于报错时说清「选的是哪条、头里是哪条」。
 * （导出只为离线自测：这条优先级就是 v4 那次 0.75 s 失败的行为面修复。）
 */
export function routeTarget(session, agent) {
  const headerConfig = session.requestHeader()?.config;
  const header = isRoute(headerConfig) ? { provider: headerConfig.provider, model: headerConfig.model } : null;
  const live = readLiveSelection(agent);
  if (live !== null) return { ...live, source: 'agent-model', header };
  if (header !== null) return { ...header, source: 'header', header };
  const options = agent?.options;
  if (isRoute(options)) return { provider: options.provider, model: options.model, source: 'agent-options', header };
  return null;
}

/** 构造摘要调用的输入：出厂请求的逐字前缀 + 追加一条压缩指令。 */
function buildSummarizationInput(session, plan) {
  const header = session.requestHeader();
  const messages = [];
  const headEvent = session.eventAt(session.surface.nodes[0]);
  if (headEvent?.type === 'system/message') {
    const system = session.deriveEventMessage(headEvent);
    if (system !== null) messages.push(system);
  }
  for (const seq of plan.headSeqs) {
    const message = session.deriveEventMessage(session.eventAt(seq));
    if (message !== null) messages.push(message);
  }
  messages.push({
    role: 'user',
    id: randomUUID(),
    source: { kind: 'plugin', plugin: COMPACT_PLUGIN },
    content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
  });
  return {
    ...(Array.isArray(header?.tools) && header.tools.length > 0 ? { tools: header.tools } : {}),
    messages,
  };
}

/**
 * 把一次失败的调用归一成可解释的结构：坏在哪个阶段、错误码、原始消息、耗时，
 * 以及是否只是「用户取消」（取消是正常终态，绝不能被说成失败）。
 */
function failureOf(error, stage, startedAt, signal) {
  const failure = {
    stage,
    code: null,
    message: '',
    kind: null,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    aborted: signal?.aborted === true,
  };
  if (isRecord(error)) {
    if (typeof error.code === 'string' && error.code !== '') failure.code = error.code;
    if (typeof error.message === 'string' && error.message !== '') failure.message = error.message;
    if (typeof error.kind === 'string' && error.kind !== '') failure.kind = error.kind;
    const nested = isRecord(error.failure) ? error.failure : (isRecord(error.cause) ? error.cause : null);
    if (nested !== null) {
      if (failure.code === null && typeof nested.code === 'string' && nested.code !== '') failure.code = nested.code;
      if (failure.message === '' && typeof nested.message === 'string' && nested.message !== '') failure.message = nested.message;
    }
  } else if (typeof error === 'string' && error !== '') {
    failure.message = error;
  }
  if (failure.message === '' && failure.code === null) failure.message = '未知错误（适配器没有给出 message）';
  return failure;
}

/**
 * 调用一次摘要（`purpose: 'compaction'`，一次调用、只取文本）。
 * @returns `{ ok: true, blocks, usage }` 或 `{ ok: false, failure }`。
 * 截断的检查点依然不落地（与原版一致），但**失败原因要带出来**：哪个阶段、
 * 什么错误码、等了多久 —— 上层据此说出人话，而不是一句 summary-failed。
 */
async function callSummarizer(llm, options) {
  const startedAt = Date.now();
  const texts = [];
  let usage;
  let finish;
  try {
    const stream = llm.stream({
      provider: options.provider,
      model: options.model,
      messages: options.messages,
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      maxTokens: options.maxTokens,
      sessionId: options.sessionId,
      purpose: 'compaction',
      signal: options.signal,
    });
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        const index = Number.isInteger(chunk.index) ? chunk.index : 0;
        texts[index] = (texts[index] ?? '') + chunk.text;
      } else if (chunk?.type === 'usage') {
        usage = chunk.usage;
      } else if (chunk?.type === 'finish') {
        finish = chunk.reason;
      }
    }
  } catch (error) {
    return { ok: false, failure: failureOf(error, 'stream', startedAt, options.signal) };
  }
  if (options.signal?.aborted === true) {
    return { ok: false, failure: failureOf('摘要调用被取消，未拿到终态', 'stream', startedAt, options.signal) };
  }
  if (finish === undefined || finish === null) {
    return { ok: false, failure: failureOf('流结束但没有 finish 终态', 'stream-ended', startedAt, options.signal) };
  }
  if (finish.kind === 'aborted' || finish.kind === 'error' || finish.kind === 'max-tokens') {
    const failure = failureOf(finish.failure ?? null, 'finish', startedAt, options.signal);
    failure.kind = finish.kind;
    if (finish.kind === 'aborted') failure.aborted = true;
    if (finish.kind === 'max-tokens') {
      if (failure.code === null) failure.code = 'MAX_TOKENS';
      if (failure.message === '未知错误（适配器没有给出 message）') failure.message = '摘要在 token 上限处被截断（检查点不完整）';
    }
    return { ok: false, failure };
  }
  const text = joinTextDeltas(texts).trim();
  if (text === '') {
    const failure = failureOf('摘要没有产出任何文本', 'empty', startedAt, options.signal);
    if (failure.code === null) failure.code = 'EMPTY_RESPONSE';
    return { ok: false, failure };
  }
  return { ok: true, blocks: [{ type: 'text', text }], ...(usage === undefined ? {} : { usage }) };
}

/**
 * 落地一条压缩事务：start → (summary|prune + replace) × N → end。
 * 事件与替换同步紧邻，满足影子计价协议与 compaction 不变式（一个 start/end
 * 括号、括号内至多一条 summary、每个 replace 前面紧跟它的计价事件）。
 *
 * 导出只为让 `verify-shipped.mjs` 能把这里产出的事件序列，喂给出厂的不变式
 * 校验器与影子计价折叠做交叉验证（生产路径不经外部调用）。
 */
export function appendTransaction(session, plan, summary, meta) {
  const compactionId = randomUUID();
  const turn = Number.isInteger(meta.turn) ? meta.turn : null;
  const startEvent = session.append('compaction/start', { compactionId, turn });
  let summarySeq = null;
  let lastSeq = startEvent.seq;
  /**
   * 括号一旦落盘就是**锁**：出厂不变式（validateTurnBoundary / validateCompactionEvent）
   * 会让任何 turn/start、turn/end、第二条 compaction/start 在预校验阶段直接失败。
   * 所以 start 之后的任何一步抛错都必须补一条 compaction/end{error} 把锁放掉，
   * 否则这个会话会被自己的半截事务永久堵死（出厂引擎同样用 closed/closing +
   * 恰好一次 end{error} 兜底）。
   */
  try {
    plan.runs.forEach((run, index) => {
      const shadowedRange = { start: run.startSeq, end: run.endSeq };
      const shadowedSeqs = [...run.seqs];
      const priced = {
        shadowedRange,
        shadowedSeqs,
        shadowedTokenCount: run.heuristicTokens,
      };
      const meterEvent = index === 0
        ? session.append('compaction/summary', {
          compactionId,
          ...priced,
          summary: summary.blocks,
          provider: meta.provider,
          model: meta.model,
          maxTokens: meta.maxTokens,
          ...(summary.usage === undefined ? {} : { usage: summary.usage }),
          rawOutput: summary.blocks,
          llmStreamCall: true,
        })
        : session.append('compaction/prune', priced);
      if (index === 0) summarySeq = meterEvent.seq;
      const message = index === 0 ? checkpointMessage(compactionId, summary.blocks) : pointerMessage(compactionId);
      const replacement = session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: run.startSeq, endSeq: run.endSeq },
        sourceEventSeqs: [startEvent.seq, meterEvent.seq, ...run.seqs],
      });
      lastSeq = replacement.seq;
    });
    const endEvent = session.append('compaction/end', { compactionId, turn });
    return {
      compactionId,
      startSeq: startEvent.seq,
      summarySeq,
      endSeq: endEvent.seq,
      replaceSeq: lastSeq,
      runs: plan.runs.length,
      shadowedTokens: plan.runs.reduce((total, run) => total + run.tokens, 0),
    };
  } catch (error) {
    try {
      session.append('compaction/end', { compactionId, turn, error: String(error?.message ?? error) });
    } catch (closeError) {
      meta.onError?.('释放压缩锁失败（会话可能被半截事务堵住）', closeError);
    }
    throw error;
  }
}

/**
 * 执行一轮「用户消息完全保留」压缩。
 * @returns `{ skipped }` 或 `{ compacted, pressureAfter, thresholdTokens }`。
 */
async function runPass(runtime, agent, options) {
  const { ctx, config } = runtime;
  const session = agent.session;
  const meter = ctx.get('tokenMeter');
  const llm = ctx.get('llm');
  if (meter === undefined || llm === undefined) return { skipped: 'services-missing' };
  const startedAt = Date.now();
  const route = routeTarget(session, agent);
  if (route === null) return { skipped: 'no-route' };
  runtime.lastRoute = { provider: route.provider, model: route.model, source: route.source };
  let info;
  try {
    info = await llm.resolveModelInfo(route.provider, route.model, options.signal);
  } catch (error) {
    return { skipped: 'model-info-failed', route, failure: failureOf(error, 'model-info', startedAt, options.signal) };
  }
  const contextWindow = info?.context?.contextWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return { skipped: 'no-context-window' };

  // v3：与出厂 compaction-basic 逐项同口径的压力预算（见文件头 v3 说明）。
  //   出厂 resolveCompactSpec：
  //     messageBudget = contextWindow − reservedCompletionTokens
  //     pressureBudget = messageBudget − headroomTokens
  //     threshold = min(contextWindow × thresholdRatio, pressureBudget)
  //     retain    = messageBudget × retainRatio
  //   reservedCompletionTokens = 最近一次路由请求的 config.maxTokens，
  //   缺省回落到适配器的 defaultMaxTokens（与出厂 reservedCompletionTokens 一致）。
  // 少了这一层，本插件阈值系统性偏高，会被出厂引擎抢先压掉 user 消息。
  const reservedRaw = session.requestHeader()?.config?.maxTokens ?? info?.defaultMaxTokens ?? 0;
  const reservedCompletionTokens = Number.isFinite(reservedRaw) && reservedRaw > 0 ? reservedRaw : 0;
  const messageBudgetTokens = contextWindow - reservedCompletionTokens;
  if (messageBudgetTokens <= 0) return { skipped: 'no-message-budget' };
  const pressureBudgetTokens = messageBudgetTokens - config.headroomTokens;
  if (pressureBudgetTokens <= 0) return { skipped: 'no-pressure-budget' };
  const thresholdTokens = Math.floor(Math.min(contextWindow * config.thresholdRatio, pressureBudgetTokens));

  let measurement = meter.measure(session);
  if (options.force !== true && measurement.totalTokens < thresholdTokens) return { skipped: 'below-threshold' };

  // 出厂先手：无模型裁剪。裁完重新测压，够低就不再摘要。
  //
  // 注意本部署的服务归属：tool-result-pruner 挂在**预设实景**里（agent.cordis.yml
  // 的 compaction 组带 isolate: {compaction, toolResultPruner}），而本插件行在
  // host 平面 —— `ctx.get('toolResultPruner')` 在 host 平面恒为 undefined。
  // 出厂引擎自己走的是 realm 里的那个实例，于是这里退一步用 **agent 的作用域
  // 上下文**（agent.ctx 继承预设实景）去找同一个实例；两处都拿不到就如实跳过
  // 这一步（诊断字段在状态路由的 `pruner` 里可见），不做「假装裁剪过」。
  const pruner = ctx.get('toolResultPruner') ?? agent.ctx?.get?.('toolResultPruner');
  if (pruner !== undefined && typeof pruner.pruneSession === 'function') {
    runtime.prunerSource = pruner === ctx.get('toolResultPruner') ? 'host' : 'agent';
    try {
      pruner.pruneSession(session);
      measurement = meter.measure(session);
    } catch (error) {
      runtime.warn('tool-result 裁剪失败', error);
    }
  } else {
    runtime.prunerSource = 'none';
  }
  if (options.force !== true && measurement.totalTokens < thresholdTokens) return { skipped: 'pruned-enough' };

  if (hasOpenCompaction(session)) return { skipped: 'busy' };

  // v3：保留尾巴按出厂口径基于 messageBudget（窗口 − 预留输出）计算，
  // 而不是整个 contextWindow —— 否则保留尾巴偏大，可压头部被进一步蚕食。
  const retainTokens = Number.isInteger(options.retainTokens)
    ? options.retainTokens
    : (options.force === true ? 0 : Math.floor(messageBudgetTokens * config.retainRatio));
  const plan = planRuns(session, measurement, retainTokens);
  if (plan === null) return { skipped: 'no-range' };

  const input = buildSummarizationInput(session, plan);
  const summary = await callSummarizer(llm, {
    provider: route.provider,
    model: route.model,
    messages: input.messages,
    tools: input.tools,
    maxTokens: config.maxTokens,
    sessionId: session.id,
    signal: options.signal,
  });
  if (summary.ok !== true) {
    // 用户取消是正常终态：不落地、不报警，也绝不叫「失败」。
    const skipped = summary.failure?.aborted === true ? 'cancelled' : 'summary-failed';
    return { skipped, route, failure: summary.failure };
  }

  // 摘要期间可见面不得变化：比对两次测量的节点 seq 序列（逐位相等）。
  // 比代数比较更严：任何替换都会改变 seq 序列，任何追加都会改变长度。
  const after = meter.measure(session);
  if (!sameSurface(measurement, after)) return { skipped: 'surface-changed' };

  // 收缩校验：新面（保留节点 + 检查点 + 指针）必须真比原头部小。
  const kept = preservedTokens(session, plan, after);
  const checkpointCost = meter.estimateMessage(checkpointMessage('probe', summary.blocks));
  const pointerCost = meter.estimateMessage(pointerMessage('probe'));
  const newTokens = kept + checkpointCost + (plan.runs.length - 1) * pointerCost;
  if (newTokens >= plan.headTokens) return { skipped: 'not-smaller' };

  const compacted = appendTransaction(session, plan, summary, {
    provider: route.provider,
    model: route.model,
    maxTokens: config.maxTokens,
    turn: options.turn,
    onError: (message, error) => runtime.warn(message, error),
  });
  return { compacted, pressureAfter: meter.measure(session).totalTokens, thresholdTokens };
}

/** 两次测量是否描述同一个可见面（节点 seq 序列逐位相等；替换/追加都会破坏它）。 */
function sameSurface(left, right) {
  if (left.nodes.length !== right.nodes.length) return false;
  for (let index = 0; index < left.nodes.length; index += 1) {
    if (seqOf(left.nodes[index].seq) !== seqOf(right.nodes[index].seq)) return false;
  }
  return true;
}

/* ── 插件装配 ───────────────────────────────────────────────────────────── */

/**
 * 手工 `/compact` 的规则化（v3 新增）。
 *
 * 出厂 `/compact` 走的是预设实景里 compaction 组的 `BasicCompactionEngine.compactNow`
 * （retain=0 的整段压缩），host 平面换不掉那个 realm 的服务实例，所以只能从
 * **命令解析层**下手。
 *
 * 机制（官方预留的遮蔽路径，见 dsh-commands 的同名冲突诊断文案）：
 *   - `commands` 是进程级单例（`ctx[symbols.isolate]['commands']` 全局一个 key），
 *     但它的注册表 `ScopedLayers` 按 **scope** 分层：`register()` 用
 *     `scopeOf(this.ctx)` 决定落到全局层还是某个 scope 层。
 *   - agent loop 用 `createScope(loopCtx, this)` 建作用域，于是 `scopeOf(agent.ctx)`
 *     就是 agent 本身；`find(agent, name)` = 全局层 + agent 层覆盖，**近者胜出**。
 *   - 因此直接拿 host 那个 commands 实例的 `layers`，把 effect 挂到 `agent.ctx` 上，
 *     就能给**这一个 agent** Shadow 一份 `compact`，不影响别的会话。
 *   - effect 归 agent 的 fiber：agent 销毁时自动摘除，不泄漏。
 *
 * 依赖的内部形状（`commands.layers` / `layer.commands.insert`）不是公开 API，
 * 每次 DSH 升级后都要重新核对；形状不符就静默跳过，保持出厂 `/compact` 不变。
 */

/* ── 把「为什么没压」说成人话（v5） ─────────────────────────────────────── */

/** 截断长文本，保留头部并给出省略号（Provider 的原话可能很长）。 */
export function truncateText(text, max) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (max <= 0 || value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/**
 * 把一次失败归类。顺序是刻意的：先认「取消」（取消不是失败），再认截断/空产出，
 * 然后才按错误码与文案嗅探限流/鉴权/超时/网络 —— 宿主各适配器给的 code 并不统一，
 * 有时只有一句 `HTTP 429` 文案，所以两路都要看。
 */
export function classifyFailure(failure) {
  if (failure?.aborted === true) return 'cancelled';
  const code = typeof failure?.code === 'string' ? failure.code.toUpperCase() : '';
  const message = typeof failure?.message === 'string' ? failure.message : '';
  if (code === 'MAX_TOKENS' || failure?.kind === 'max-tokens') return 'truncated';
  if (code === 'EMPTY_RESPONSE') return 'empty';
  if (code === 'RATE_LIMIT' || /rate.?limit|too many requests|quota|usage limit|\b429\b/i.test(message)) return 'rate-limit';
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return 'context-window';
  if (code === 'UNSUPPORTED_CONTENT') return 'unsupported';
  if (/unauthoriz|forbidden|invalid.?api.?key|no auth|\b401\b|\b403\b/i.test(message)) return 'auth';
  if (code === 'TIMEOUT' || /timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(message)) return 'timeout';
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(message)) return 'network';
  if (failure?.stage === 'model-info') return 'model-info';
  if (failure?.stage === 'stream-ended') return 'no-finish';
  return 'error';
}

/** 每类的「人话原因」。 */
const FAILURE_CAUSES = {
  cancelled: 'the run was cancelled',
  'rate-limit': 'the route is rate-limited or out of quota',
  'context-window': "the request exceeds the model's context window",
  truncated: 'the summary hit the output token cap, so the checkpoint would have been truncated',
  empty: 'the model returned no text',
  unsupported: 'the model returned content a text summary cannot hold',
  auth: 'the route rejected the request as unauthenticated',
  timeout: 'the request timed out',
  network: 'the provider could not be reached',
  'model-info': 'the provider could not describe the model',
  'no-finish': 'the stream ended without a terminal status',
  error: 'the provider call failed',
};

/** 每类的下一步建议（只在真的失败时出现）。 */
const FAILURE_HINTS = {
  'rate-limit': 'the same route will keep failing until the quota resets — pick another model and retry, /compact follows your current selection.',
  auth: 'check the API key / provider credentials for this route.',
  'context-window': 'pick a model with a larger context window, or compact earlier.',
  truncated: 'raise the compaction output budget, or pick a model with a larger output cap.',
  network: 'check the provider endpoint and network access, then retry.',
  'model-info': 'check the provider configuration for this route, then retry.',
  'no-finish': 'retry; if it repeats, the provider adapter is returning a malformed stream.',
};

const ROUTE_SOURCES = {
  'agent-model': 'your current model selection',
  header: 'the last request header (no live selection was readable)',
  'agent-options': 'agent options',
};

/**
 * 拼出一条可诊断的失败说明：**哪条路由、怎么坏的、什么错误码、等了多久**，
 * 再附上 Provider 原话与下一步。绝不把一切塌成 summary-failed。
 */
export function describeSummaryFailure(route, failure) {
  const category = classifyFailure(failure);
  const cause = FAILURE_CAUSES[category] ?? FAILURE_CAUSES.error;
  const target = route === null || route === undefined
    ? 'the summarizer route (unknown provider/model)'
    : `${route.provider}/${route.model}`;
  const lines = [`Compaction did not run: ${target} — ${cause}.`];

  const meta = [];
  if (typeof failure?.code === 'string' && failure.code !== '') meta.push(`code ${failure.code}`);
  if (typeof failure?.stage === 'string' && failure.stage !== '') meta.push(`stage ${failure.stage}`);
  if (Number.isFinite(failure?.elapsedMs)) meta.push(`${Math.round(failure.elapsedMs)} ms`);
  if (meta.length > 0) lines.push(meta.join(' · '));

  const said = truncateText(failure?.message, 240);
  if (said !== '') lines.push(`Provider said: "${said}"`);

  if (route !== null && route !== undefined) {
    const source = ROUTE_SOURCES[route.source];
    lines.push(source === undefined ? 'Route: unspecified.' : `Route: ${source}.`);
    const header = route.header;
    if (route.source === 'agent-model' && header !== null && header !== undefined
      && (header.provider !== route.provider || header.model !== route.model)) {
      lines.push(`Note: the last request header still named ${header.provider}/${header.model}; newer turns use the selection, and the summary followed it.`);
    }
  }

  const hint = FAILURE_HINTS[category];
  if (hint !== undefined) lines.push(`Hint: ${hint}`);
  lines.push('Nothing was changed.');
  return lines.join('\n');
}

/**
 * 把一次 runPass/runForAgent 的结果翻成命令回复。
 * 成功、取消、跳过、失败各有措辞；`Rule-based compaction did not run (...)` 只作为
 * 最后兜底 —— 未知原因时才允许出现。
 */
export function explainOutcome(outcome) {
  if (outcome?.compacted !== undefined) {
    const nodes = outcome.compacted.shadowedNodes;
    const tokens = outcome.compacted.shadowedTokens;
    return `Compacted ${nodes ?? '?'} surface nodes (~${tokens ?? '?'} tokens); user messages kept verbatim.`;
  }
  const reason = typeof outcome?.skipped === 'string' && outcome.skipped !== '' ? outcome.skipped : 'unknown';
  const route = outcome?.route ?? null;
  const target = route === null ? 'this model' : `${route.provider}/${route.model}`;
  switch (reason) {
    case 'cancelled':
      return 'Compaction cancelled — nothing was changed.';
    case 'no-range':
      return 'No compactable history yet (everything left must be kept verbatim).';
    case 'summary-failed':
    case 'model-info-failed':
    case 'error':
      return describeSummaryFailure(route, outcome?.failure ?? null);
    case 'busy':
    case 'busy-agent':
      return 'A compaction is already running for this session — nothing was changed. Try again when it finishes.';
    case 'no-route':
      return 'No provider/model route available for compaction: select a model (or send one request) and retry.';
    case 'no-context-window':
      return `Cannot compact: ${target} does not report a context window, so the pressure threshold is unknown.`;
    case 'no-message-budget':
    case 'no-pressure-budget':
      return `Cannot compact: ${target} reserves its whole context window for output, leaving no room for history.`;
    case 'surface-changed':
      return 'The visible surface changed while the summary was being generated — nothing was committed. Try again.';
    case 'not-smaller':
      return 'Skipped: the summary would not have been smaller than the history it replaces, so compaction would not have helped.';
    case 'services-missing':
      return 'Cannot compact: the tokenMeter/llm services are unavailable in this context.';
    case 'pruned-enough':
      return 'Nothing to compact: pruning tool results already brought the history under the threshold.';
    case 'below-threshold':
      return 'Nothing to compact: the history is already below the pressure threshold.';
    default:
      return `Rule-based compaction did not run (${reason}).`;
  }
}

/**
 * 压力预算换算，与 runPass 内联的那套**同口径**（见文件头 v3 说明）。
 * 抽出来是给诊断路由用的：诊断算出的阈值若与真跑不一致，诊断就没有意义。
 * 返回值里的 null 表示「这一项算不出来」（窗口未知/预算不为正）。
 */
export function budgetOf(info, headerMaxTokens, config) {
  const contextWindow = info?.context?.contextWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return { contextWindow: null };
  const fallbackMax = info?.defaultMaxTokens;
  const reservedSource = Number.isFinite(headerMaxTokens) && headerMaxTokens > 0
    ? headerMaxTokens
    : (Number.isFinite(fallbackMax) ? fallbackMax : 0);
  const reservedCompletionTokens = reservedSource > 0 ? reservedSource : 0;
  const messageBudgetTokens = contextWindow - reservedCompletionTokens;
  const pressureBudgetTokens = messageBudgetTokens - config.headroomTokens;
  return {
    contextWindow,
    defaultMaxTokens: Number.isFinite(fallbackMax) ? fallbackMax : null,
    reservedCompletionTokens,
    messageBudgetTokens,
    pressureBudgetTokens,
    thresholdTokens: pressureBudgetTokens > 0
      ? Math.floor(Math.min(contextWindow * config.thresholdRatio, pressureBudgetTokens))
      : null,
    retainTokens: messageBudgetTokens > 0
      ? Math.floor(messageBudgetTokens * config.retainRatio)
      : null,
  };
}

/** 构造与 `normalizeDefinition` 等价的注册值（该函数未导出，这里按源码逐字段复刻）。 */
function buildCompactRegistration(handler) {
  const definition = Object.freeze({
    name: 'compact',
    description: 'Compact older conversation history (user messages kept verbatim)',
    handler,
  });
  const descriptor = Object.freeze({
    name: definition.name,
    description: definition.description,
  });
  return { definition, descriptor };
}

/** 把任意抛出物收敛成可 JSON 的一行诊断（错误对象常常只有 message/code 可用）。 */
function thrownText(error) {
  try {
    if (error === undefined || error === null) return null;
    if (typeof error === 'string') return truncateText(error, 400);
    const message = error.message === undefined ? String(error) : String(error.message);
    const text = truncateText(message, 400);
    const code = error.code === undefined ? null : String(error.code);
    return code === null ? text : `${code}: ${text}`;
  } catch {
    return '<unprintable>';
  }
}

/**
 * 给单个 agent 挂上规则版的 `/compact`。
 *
 * 落点必须是**和出厂 `command-compact` 同一条 `commands` 视图**：出厂那份在
 * preset 的 `compaction` 组里注册（该组只 isolate 了 compaction / toolResultPruner，
 * 没 isolate commands），所以它落在 agent 自己这一层的 `NamedEntries` 上。`NamedEntries`
 * 只有同名唯一约束、没有 replace/delete 导出面，因此这里分两条路：
 *   - 该层还没有 `compact` → 正常 `insert`，undo 就是它的撤销；
 *   - 已有出厂的 `compact` → 只在它暴露的 `data` Map 上就地替换，undo 负责还原出厂值。
 * 每次尝试都记一份 `runtime.shadowDiag`，诊断路由直接回显，免得失败原因只留在
 * 看不见的 `logger.warn` 里。
 * @returns 是否成功挂上（false = 保持出厂行为）。
 */
function shadowManualCompact(runtime, agent) {
  const sessionId = String(agent?.session?.id ?? '');
  const previous = sessionId === '' ? undefined : runtime.shadowDiag.get(sessionId);
  const diag = {
    at: Date.now(),
    calls: (previous?.calls ?? 0) + 1,
    ok: false,
    strategy: null,
    reason: null,
    stages: {},
    error: null,
  };
  if (sessionId !== '') runtime.shadowDiag.set(sessionId, diag);
  const stage = (name, value) => {
    diag.stages[name] = value;
  };
  try {
    const agentCtx = agent?.ctx;
    stage('agent', {
      present: agent !== undefined && agent !== null,
      ctx: agentCtx === undefined || agentCtx === null ? null : typeof agentCtx,
      hasModel: typeof agent?.model?.current === 'function',
    });
    if (agentCtx === undefined || agentCtx === null) {
      diag.reason = 'no-agent-ctx';
      return false;
    }
    let commands;
    try {
      commands = typeof agentCtx.get === 'function' ? agentCtx.get('commands') : undefined;
    } catch (error) {
      diag.reason = 'commands-unreachable';
      diag.error = thrownText(error);
      return false;
    }
    stage('commands', commands === undefined || commands === null
      ? null
      : { keys: Object.keys(commands).slice(0, 12) });
    const layers = commands?.layers;
    if (layers === undefined || typeof layers.effect !== 'function') {
      diag.reason = 'no-command-layers';
      return false;
    }
    stage('layers', {
      effect: typeof layers.effect,
      peek: typeof layers.peek,
      chainLayers: typeof layers.chainLayers,
      merge: typeof layers.merge,
    });

    // 作用域标签是包内私有 `Symbol("dsh.scope")`（不导出）：按描述符从自身符号里认它。
    // `peek(scope)` 收的是**作用域键**，不是 ctx —— 传 ctx 永远拿 undefined。
    let scopeKey;
    try {
      const symbol = Object.getOwnPropertySymbols(agentCtx)
        .find((item) => item.description === 'dsh.scope');
      scopeKey = symbol === undefined ? undefined : agentCtx[symbol];
    } catch (error) {
      diag.error = thrownText(error);
      scopeKey = undefined;
    }
    const existingLayer = scopeKey === undefined ? undefined : layers.peek?.(scopeKey);
    const existingTable = existingLayer?.commands;
    stage('scope', {
      tagged: scopeKey !== undefined,
      keyType: scopeKey === undefined ? null : typeof scopeKey,
      layer: existingTable === undefined || existingTable === null
        ? null
        : {
          size: existingTable.data instanceof Map ? existingTable.data.size : null,
          names: existingTable.data instanceof Map
            ? [...existingTable.data.keys()].slice(0, 12)
            : null,
          hasCompact: typeof existingTable.has === 'function'
            ? existingTable.has('compact')
            : null,
        },
    });

    const registration = buildCompactRegistration(async (invocation) => {
      const rawInput = String(invocation?.rawInput ?? '');
      if (rawInput.trim().length > 0) {
        return { kind: 'error', text: 'Usage: /compact (no arguments)' };
      }
      const outcome = await runtime.runForAgent(invocation.agent, {
        signal: invocation.signal,
        turn: null,
        force: true,
      });
      // 用法错误之外，一律走 explainOutcome：成功/取消/跳过/失败各有措辞，
      // 失败必须带上 provider/model、错误码、阶段与耗时，绝不塌成 summary-failed。
      const text = explainOutcome(outcome);
      if (outcome?.compacted !== undefined) {
        return { kind: 'success', text, sourceEventSeq: outcome.compacted.summarySeq ?? undefined };
      }
      // 用户取消是正常终态（不是失败），按 success 报，免得看起来像坏了。
      const kind = outcome?.skipped === 'cancelled' ? 'success' : 'error';
      return { kind, text };
    });

    let applied = null;
    try {
      layers.effect(agentCtx, (layer) => {
        const table = layer?.commands;
        if (table === undefined || table === null || typeof table.insert !== 'function') {
          diag.reason = 'no-layer-table';
          return () => {};
        }
        const had = typeof table.has === 'function' && table.has('compact');
        if (!had) {
          const undo = table.insert('compact', registration);
          applied = 'insert';
          return typeof undo === 'function' ? undo : () => {};
        }
        // 出厂 /compact 与我们在同一层：NamedEntries 只有 insert、没有 replace/delete，
        // 也不导出它，所以在这一层暴露的 data Map 上就地替换，并保留能还原出厂的 undo。
        if (!(table.data instanceof Map)) {
          diag.reason = 'no-data-map';
          return () => {};
        }
        const original = table.get('compact');
        table.data.set('compact', registration);
        applied = 'replace';
        return () => {
          if (table.data.get('compact') === registration) {
            if (original === undefined) table.data.delete('compact');
            else table.data.set('compact', original);
          }
        };
      }, { label: 'user-keep-compaction: scoped /compact' });
    } catch (error) {
      diag.strategy = applied;
      diag.reason = 'effect-failed';
      diag.error = thrownText(error);
      runtime.warn('手工 /compact 遮蔽失败（保持出厂行为）', error);
      return false;
    }
    diag.ok = true;
    diag.strategy = applied;
    diag.reason = applied === 'replace' ? 'replaced-factory-registration' : 'inserted-scoped-registration';
    runtime.manualShadowed.add(sessionId);
    return true;
  } catch (error) {
    diag.reason = diag.reason ?? 'shadow-threw';
    diag.error = diag.error ?? thrownText(error);
    runtime.warn('手工 /compact 遮蔽失败（保持出厂行为）', error);
    return false;
  }
}

/**
 * 挂载 host 半边：会话级选择存储 + `agent/pre-step` 规则压缩 + 溢出恢复 +
 * 手工 `/compact` 遮蔽 + 两条路由。
 * @param ctx - host 平面 Cordis 上下文。
 * @param rawConfig - 组合行 config。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const store = createStore(config.stateFile, (error) => ctx.logger?.warn?.('user-keep-compaction: 状态落盘失败', error));
  const runtime = {
    ctx,
    config,
    store,
    /**
     * 正在跑的会话（防止同一会话并发两轮压缩）。
     * 按 sessionId 而不是 agent 对象记：会话才是并发单元，同一会话可能先后出现
     * 不同的 agent 句柄（resume/fork 出来的新句柄指向同一份会话日志）。
     */
    busy: new Set(),
    /** 每个会话已用掉的溢出重试次数（回到 idle 还清，disposed 时删除）。 */
    overflow: new Map(),
    /** 最近的退回出厂压缩记录：sessionId → {at, reason}。 */
    fallback: new Map(),
    /** 已成功 Shadow 手工 /compact 的会话（状态路由的 manualCompactBypasses 据此报告）。 */
    manualShadowed: new Set(),
    /**
     * 每次尝试遮蔽时留下的现场：sessionId → {at, calls, ok, strategy, reason, stages, error}。
     * 失败原因不能只落在看不见的 logger.warn 里，诊断路由要把这份直接回显。
     */
    shadowDiag: new Map(),
    /** sessionId → 活着的 agent 句柄（诊断路由要借它读「当前选择」）。 */
    agents: new Map(),
    /** 最近一次解析出的摘要路由 {provider, model, source}，诊断路由要回显。 */
    lastRoute: null,
    warn(message, error) {
      ctx.logger?.warn?.(`user-keep-compaction: ${message}`, error);
    },
    /** 由下面的 runForAgent 赋值；手工 /compact 遮蔽的 handler 要复用它。 */
    runForAgent: null,
  };

  /** 一步一步地压：先按出厂保留策略；仍越线则把保留尾巴压到 0 再试一轮。 */
  const runForAgent = async (agent, options) => {
    const key = String(agent?.session?.id ?? '');
    if (key !== '' && runtime.busy.has(key)) return { skipped: 'busy-agent' };
    if (key !== '') runtime.busy.add(key);
    const runStartedAt = Date.now();
    try {
      let outcome = await runPass(runtime, agent, options);
      let passes = 1;
      while (
        outcome.compacted !== undefined
        && outcome.pressureAfter >= outcome.thresholdTokens
        && passes < config.maxPassesPerStep
        && options.force !== true
      ) {
        passes += 1;
        outcome = await runPass(runtime, agent, { ...options, retainTokens: 0 });
      }
      if (outcome.compacted !== undefined && outcome.pressureAfter >= outcome.thresholdTokens) {
        // 规则已尽力：可见面里剩下的全是必须保留的内容。此时退回出厂压缩，
        // 否则会话会直接撞上下文上限；这条退回会记进状态路由。
        const sessionId = String(agent.session.id);
        runtime.fallback.set(sessionId, { at: Date.now(), pressure: outcome.pressureAfter, threshold: outcome.thresholdTokens });
        runtime.warn(`规则压不下去（${outcome.pressureAfter} ≥ ${outcome.thresholdTokens}），本步退回出厂压缩：${sessionId}`);
      } else if (outcome.compacted !== undefined) {
        runtime.fallback.delete(String(agent.session.id));
      }
      return outcome;
    } catch (error) {
      // 连失败原因都留着：命令回复要能说清「哪一步、什么错、等了多久」。
      runtime.warn('压缩轮次异常，本轮放弃', error);
      return {
        skipped: 'error',
        route: runtime.lastRoute,
        failure: failureOf(error, 'run', runStartedAt, options?.signal),
      };
    } finally {
      if (key !== '') runtime.busy.delete(key);
    }
  };
  runtime.runForAgent = runForAgent;

  // 手工 /compact：给启用规则的会话挂一份 scoped 命令，遮蔽预设实景里的出厂版本。
  // 在 agent/created 时挂：此时 agent.ctx 已就绪，且 effect 归 agent fiber，随 agent 销毁自动摘除。
  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload?.agent;
      const sessionId = String(agent?.session?.id ?? '');
      if (sessionId === '') return;
      // 先登记句柄，再判断是否启用：诊断路由要能对任何会话回答「选了什么模型」。
      runtime.agents.set(sessionId, agent);
      if (!store.enabled(sessionId)) return;
      const shadowed = shadowManualCompact(runtime, agent);
      if (shadowed) runtime.warn(`会话 ${sessionId} 的 /compact 已按规则遮蔽（用户消息逐字保留）`);
    } catch (error) {
      runtime.warn('agent/created 处理异常', error);
    }
  });

  // 自动压力：排在 waterfall 最前，先于预设里的 compaction-basic 动手。
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const sessionId = String(payload?.agent?.session?.id ?? '');
      const stepAgent = payload?.agent;
      const stepEnabled = sessionId !== '' && store.enabled(sessionId);
      if (sessionId !== '' && stepAgent !== undefined && stepAgent !== null) {
        // 插件热重载之后，老会话的 agent/created 早已发生过：每步补一次登记 +
        // 幂等遮蔽，免得这些会话的 /compact 一直停在出厂版本上。
        runtime.agents.set(sessionId, stepAgent);
        if (stepEnabled && !runtime.manualShadowed.has(sessionId)) {
          const shadowed = shadowManualCompact(runtime, stepAgent);
          if (shadowed) runtime.warn(`会话 ${sessionId} 的 /compact 已在 pre-step 按规则遮蔽`);
        }
      }
      if (stepEnabled && payload.signal?.aborted !== true) {
        await runForAgent(stepAgent, { signal: payload.signal, turn: payload.turn });
      }
    } catch (error) {
      runtime.warn('pre-step 处理异常', error);
    }
    return next();
  }, { prepend: true });

  // 溢出恢复：只在启用了规则的会话里接管。
  //
  // 这里**必须 prepend**：cordis 是「全进程一张监听表 + prepend=unshift」，热重载
  // （unload→re-apply）会把未 prepend 的监听器追加到表尾，于是 compaction-basic
  // （或配了模型链的 subagent-models）会先认领 CONTEXT_WINDOW_EXCEEDED —— 而出厂
  // 的溢出路径正是 retainTokens=0 的整段压缩，那会直接违反本规则。prepend 让顺序
  // 与注册时间无关。代价是抢在别的恢复插件之前：本插件只在**真的改动了可见面**
  // 时才返回 retry，改不动就 next() 让链继续，且配额只按成功次数扣。
  ctx.on('agent/request-error', async (payload, next) => {
    try {
      const agent = payload?.agent;
      const sessionId = String(agent?.session?.id ?? '');
      if (sessionId !== '' && store.enabled(sessionId) && payload?.failure?.code === CONTEXT_WINDOW_EXCEEDED) {
        const used = runtime.overflow.get(sessionId) ?? 0;
        if (used < config.maxOverflowRetries) {
          const before = agent.session.surface.replaceGeneration;
          // 先记账、失败即回滚：避免同一轮里并发两步把配额吃两次。
          runtime.overflow.set(sessionId, used + 1);
          await runForAgent(agent, { signal: payload.signal, turn: payload.turn, force: true });
          if (agent.session.surface.replaceGeneration > before) return { kind: 'retry' };
          runtime.overflow.set(sessionId, used);
        }
      }
    } catch (error) {
      runtime.warn('溢出恢复异常', error);
    }
    return next();
  }, { prepend: true });

  // 回到空闲即还清溢出配额：与出厂引擎「一个新回合给一次机会」的口径对齐
  // （否则会话一旦在某个回合用完那一次，之后整条生命周期都不再自救了）。
  ctx.on('agent/status', (payload) => {
    if (payload?.status !== 'idle') return;
    const sessionId = String(payload?.agent?.session?.id ?? '');
    if (sessionId !== '') runtime.overflow.delete(sessionId);
  });

  ctx.on('agent/disposed', (payload) => {
    const sessionId = String(payload?.agent?.session?.id ?? '');
    if (sessionId === '') return;
    runtime.fallback.delete(sessionId);
    runtime.overflow.delete(sessionId);
    runtime.busy.delete(sessionId);
    // scoped /compact 的 effect 归 agent fiber，随 agent 销毁自动摘除；这里只清诊断标记。
    runtime.manualShadowed.delete(sessionId);
    // 同一会话可能换过句柄（resume/fork）：只摘掉自己那一份，别把新句柄也删了。
    const stored = runtime.agents.get(sessionId);
    if (stored === undefined || stored === payload?.agent) runtime.agents.delete(sessionId);
  });

  ctx.inject(['webServer', 'sessions'], (scoped) => {
    const apiError = (res, status, error) => {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message }));
    };
    const apiJson = (res, status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    const readBody = (req) => new Promise((resolve, reject) => {
      let text = '';
      req.on('data', (chunk) => {
        text += chunk;
        if (text.length > 65536) {
          reject(new Error('body too large'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(text));
      req.on('error', reject);
    });
    /** 同源守卫：绝对 Origin 必须与 Host 一致（dsh-lanmode 会重写成 loopback）。 */
    const sameOrigin = (req) => {
      const origin = req.headers.origin;
      if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    };
    const statusOf = (sessionId) => {
      const session = scoped.sessions.get(sessionId);
      const record = store.get(sessionId);
      const live = session !== undefined && session !== null;
      const canSet = live && !hasHumanMessage(session);
      const fallback = runtime.fallback.get(sessionId);
      /** v4：缺省启用 —— 没有记录也算开；显式 false 才是关。 */
      const enabled = record === undefined ? true : record.enabled === true;
      /** v5：摘要会走哪条路由（「当前选择」优先，与 /compact 的实际行为一致）。 */
      let route = null;
      if (live) {
        try {
          const resolved = routeTarget(session, runtime.agents.get(sessionId));
          if (resolved !== null) {
            route = { provider: resolved.provider, model: resolved.model, source: resolved.source };
          }
        } catch {
          route = null;
        }
      }
      return {
        sessionId,
        enabled,
        canSet,
        decidedAt: record?.decidedAt ?? null,
        live,
        route,
        lastRoute: runtime.lastRoute,
        /** 诊断：无模型裁剪能不能拿到实例（host / agent 作用域 / 拿不到）。 */
        pruner: runtime.prunerSource ?? null,
        /**
         * 手工 /compact 是否被本规则接管。
         * v3 起：启用规则的会话会在 agent 作用域 Shadow 一份 /compact（见
         * shadowManualCompact），所以 enabled 且 agent 在线时为 false；
         * 未启用、agent 不在线、或遮蔽没挂上时为 true（走出厂 compactNow）。
         */
        manualCompactBypasses: enabled && live ? runtime.manualShadowed?.has(sessionId) !== true : true,
        /**
         * 诊断：生效的实现代次。
         * 5 = 失败说真话（路由/错误码/耗时）+ 摘要路由跟住「当前选择」。
         */
        entryVersion: 5,
        ...(fallback === undefined ? {} : { fallback }),
      };
    };

    /**
     * 诊断路由（v5）：把「/compact 会走哪条路由、预算多少、坏在哪」一次问清。
     *
     * 只读：不写状态文件、不动会话。`summarize=1` 时才真发一次**极小**请求
     * （maxTokens 64，只要求回一个单词），用来在真实路由上复现错误码 ——
     * 这正是 /compact 那种「0.7 秒就失败」的可复现入口。
     * `provider`/`model` 可显式覆盖，用来对比「当前选择」和「上次请求头」。
     */
    const probeOf = async (sessionId, searchParams) => {
      const session = scoped.sessions.get(sessionId);
      const live = session !== undefined && session !== null;
      const agent = runtime.agents.get(sessionId);
      const record = store.get(sessionId);
      const out = {
        entryVersion: 5,
        sessionId,
        live,
        agent: { present: agent !== undefined, hasModel: typeof agent?.model?.current === 'function' },
        enabled: record === undefined ? true : record.enabled === true,
        busy: runtime.busy.has(sessionId),
        manualShadowed: runtime.manualShadowed.has(sessionId),
        /** 最近一次遮蔽尝试的现场（ok / 策略 / 阶段探针 / 错误），遮蔽没挂上时看这里。 */
        shadow: runtime.shadowDiag.get(sessionId) ?? null,
        pruner: runtime.prunerSource ?? null,
        lastRoute: runtime.lastRoute,
        fallback: runtime.fallback.get(sessionId) ?? null,
        header: null,
        liveSelection: null,
        window: null,
        resolved: null,
        chosen: null,
      };
      if (!live) return out;

      /*
       * 决定性证据：commands.find(agent,'compact') 走的就是 execute() 派发时用的同一段
       * this.view(agent).get(name)（dsh-commands/lib/index.js:330 / :297）。这里回显它，
       * 等于直接问「用户敲 /compact 时，命令运行时到底会拿到谁的注册」——不是问我们的层
       * 里有什么，而是问派发器自己解析出什么。
       */
      try {
        const commands = ctx.get('commands');
        const effective = commands?.find?.(agent, 'compact');
        const description = effective?.description ?? null;
        out.commandsView = {
          found: effective !== undefined,
          name: effective?.name ?? null,
          description,
          ours: description === 'Compact older conversation history (user messages kept verbatim)',
        };
      } catch (error) {
        out.commandsView = { error: String(error?.message ?? error) };
      }

      try {
        out.liveSelection = readLiveSelection(agent);
      } catch {
        out.liveSelection = null;
      }
      try {
        // 注意：这里用 headerConfig，别遮蔽外层的插件 config（下面算预算要用它）。
        const headerConfig = session.requestHeader()?.config;
        out.header = isRoute(headerConfig)
          ? {
            provider: headerConfig.provider,
            model: headerConfig.model,
            maxTokens: Number.isFinite(headerConfig.maxTokens) ? headerConfig.maxTokens : null,
          }
          : null;
      } catch {
        out.header = null;
      }
      try {
        out.openCompaction = hasOpenCompaction(session);
      } catch {
        out.openCompaction = null;
      }

      const meter = ctx.get('tokenMeter');
      const llm = ctx.get('llm');
      if (meter !== undefined) {
        try {
          const measured = meter.measure(session);
          out.measure = { totalTokens: measured.totalTokens, nodes: measured.nodes.length };
        } catch (error) {
          out.measure = { error: String(error?.message ?? error) };
        }
      }

      let route = null;
      try {
        route = routeTarget(session, agent);
      } catch (error) {
        out.routeError = String(error?.message ?? error);
      }
      if (route !== null) {
        out.resolved = { provider: route.provider, model: route.model, source: route.source };
      }

      const overrideProvider = searchParams.get('provider') ?? '';
      const overrideModel = searchParams.get('model') ?? '';
      const target = overrideProvider !== '' && overrideModel !== ''
        ? { provider: overrideProvider, model: overrideModel, source: 'override', header: route?.header ?? null }
        : route;
      if (target !== null) {
        out.chosen = { provider: target.provider, model: target.model, source: target.source };
      }

      if (target !== null && llm !== undefined && typeof llm.resolveModelInfo === 'function') {
        const infoStartedAt = Date.now();
        try {
          const info = await llm.resolveModelInfo(target.provider, target.model, undefined);
          out.model = budgetOf(info, out.header?.maxTokens ?? null, config);
          out.model.resolveModelInfoMs = Date.now() - infoStartedAt;
        } catch (error) {
          out.model = {
            resolveModelInfoMs: Date.now() - infoStartedAt,
            error: failureOf(error, 'model-info', infoStartedAt, undefined),
          };
        }
      }

      if (target !== null && llm !== undefined && searchParams.get('summarize') === '1') {
        const summarizeStartedAt = Date.now();
        const result = await callSummarizer(llm, {
          provider: target.provider,
          model: target.model,
          messages: [{
            role: 'user',
            id: randomUUID(),
            source: { kind: 'plugin', plugin: COMPACT_PLUGIN },
            content: [{ type: 'text', text: 'Reply with the single word OK.' }],
          }],
          tools: [],
          maxTokens: 64,
          sessionId,
          signal: undefined,
        });
        const elapsedMs = Date.now() - summarizeStartedAt;
        out.summarize = result.ok === true
          ? {
            ok: true,
            elapsedMs,
            text: truncateText(result.blocks?.[0]?.text, 120),
            usage: result.usage ?? null,
          }
          : { ok: false, elapsedMs, failure: result.failure };
      }
      return out;
    };

    ctx.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/probe`,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return apiError(res, 405, 'Method Not Allowed');
        if (!sameOrigin(req)) return apiError(res, 403, 'cross-origin request rejected');
        const url = new URL(req.url, 'http://localhost');
        const sessionId = url.searchParams.get('sessionId') ?? '';
        if (sessionId === '') return apiError(res, 400, '需要 sessionId 查询参数');
        probeOf(sessionId, url.searchParams)
          .then((value) => apiJson(res, 200, value))
          .catch((error) => apiError(res, 500, error));
      },
    }), 'dsh-user-keep-compaction: probe route');

    ctx.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return apiError(res, 405, 'Method Not Allowed');
        if (!sameOrigin(req)) return apiError(res, 403, 'cross-origin request rejected');
        const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId') ?? '';
        if (sessionId === '') return apiError(res, 400, '需要 sessionId 查询参数');
        return apiJson(res, 200, statusOf(sessionId));
      },
    }), 'dsh-user-keep-compaction: status route');

    ctx.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/set`,
      handler: (req, res) => {
        if (req.method !== 'POST') return apiError(res, 405, 'Method Not Allowed');
        if (!sameOrigin(req)) return apiError(res, 403, 'cross-origin request rejected');
        readBody(req).then((text) => {
          let args = {};
          try {
            args = text === '' ? {} : JSON.parse(text);
          } catch {
            return apiError(res, 400, 'body 不是合法 JSON');
          }
          const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
          if (sessionId === '') return apiError(res, 400, '需要 { sessionId: string }');
          const session = scoped.sessions.get(sessionId);
          if (session === undefined || session === null) return apiError(res, 409, '会话不在本进程中，无法设置');
          if (hasHumanMessage(session)) return apiError(res, 409, '该会话已经发过消息，压缩规则不可再改');
          store.set(sessionId, args.enabled === true);
          return apiJson(res, 200, statusOf(sessionId));
        }).catch((error) => apiError(res, 400, error));
      },
    }), 'dsh-user-keep-compaction: set route');
  });

  ctx.logger?.info?.(`user-keep-compaction v5: 就绪（默认启用；摘要路由跟随当前模型选择；失败回复带路由/错误码/耗时；状态文件 ${config.stateFile}）`);
}

export const inject = [];
