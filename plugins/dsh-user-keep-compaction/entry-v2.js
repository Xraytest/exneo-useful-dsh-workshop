/**
 * 「用户消息完全保留」压缩规则（dsh-user-keep-compaction）— host 半边静态插件。
 *
 * 规则（用户 2026-10-08 指定）：会话创建时选择是否启用本规则；启用后压缩只
 * 作用于 user 角色可见节点之间的助手/工具内容 —— 人类消息与注入上下文一律
 * 逐字留在可见面上，永远不进摘要。其余规则与出厂 compaction-basic 一致
 * （80% 阈值 / 16% 逐字保留尾巴 / 先裁剪后摘要（能拿到裁剪器时）/ 摘要失败不
 * 阻断本轮 / 溢出恢复 / 影子计价 / 只增日志 + surface replace）。
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
 *  - 预设实景里的 `/compact`（command-compact → 出厂引擎 compactNow(retain=0)）：
 *    host 平面换不掉那个 realm 的服务实例，那条手动路径不遵守本规则；状态路由
 *    以 `manualCompactBypasses: true` 标注。
 *  - 本部署的 toolResultPruner 只存在于预设实景：host 平面 `ctx.get` 拿不到，
 *    退一步经 `agent.ctx` 取同一实例，两处都没有就跳过裁剪（状态路由 `pruner`
 *    字段如实报告 host / agent / none）。
 *  - minimal 预设没有 compaction 栈，「退回出厂压缩」在那类会话里等于不压。
 *
 * 组合行（profile 的 cordis.patch.yml）：
 *   - insert:
 *       - id: user-keep-compaction
 *         name: ./plugins/dsh-user-keep-compaction/index.js
 *
 * 路由（同源守卫；sessionId 由浏览器半边显式携带）：
 *   GET  /dsh-ukc/status ?sessionId=…  → {sessionId, enabled, canSet, decidedAt, live, pruner, fallback}
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

/** 缺省策略：与 dsh-compaction-basic 的出厂缺省逐项相同。 */
const DEFAULTS = Object.freeze({
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  maxTokens: 8192,
  maxOverflowRetries: 1,
  /** 每一步最多尝试几轮（第 2 轮把保留尾巴压到 0，用于极端情况下的尽职压降）。 */
  maxPassesPerStep: 2,
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
    /** 该会话是否启用了本规则（未知会话 = 关）。 */
    enabled(sessionId) {
      return sessions.get(sessionId)?.enabled === true;
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

/** 解析当前路由目标：优先最近一次已落盘的请求路由，其次 Agent 选项。 */
function routeTarget(session, agent) {
  const config = session.requestHeader()?.config;
  if (isRecord(config) && typeof config.provider === 'string' && config.provider !== '' && typeof config.model === 'string' && config.model !== '') {
    return { provider: config.provider, model: config.model };
  }
  const options = agent?.options;
  if (isRecord(options) && typeof options.provider === 'string' && options.provider !== '' && typeof options.model === 'string' && options.model !== '') {
    return { provider: options.provider, model: options.model };
  }
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
 * 调用一次摘要（`purpose: 'compaction'`，一次调用、只取文本）。
 * @returns `{ blocks, usage }`，失败或截断返回 null（与原版一致：截断的检查点不落地）。
 */
async function callSummarizer(llm, options) {
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
  } catch {
    return null;
  }
  if (finish === undefined || finish === null) return null;
  if (finish.kind === 'aborted' || finish.kind === 'error' || finish.kind === 'max-tokens') return null;
  const text = joinTextDeltas(texts).trim();
  if (text === '') return null;
  return { blocks: [{ type: 'text', text }], ...(usage === undefined ? {} : { usage }) };
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
  const route = routeTarget(session, agent);
  if (route === null) return { skipped: 'no-route' };
  let info;
  try {
    info = await llm.resolveModelInfo(route.provider, route.model, options.signal);
  } catch {
    return { skipped: 'model-info-failed' };
  }
  const contextWindow = info?.context?.contextWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return { skipped: 'no-context-window' };
  const thresholdTokens = Math.floor(contextWindow * config.thresholdRatio);

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

  const retainTokens = Number.isInteger(options.retainTokens)
    ? options.retainTokens
    : (options.force === true ? 0 : Math.floor(contextWindow * config.retainRatio));
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
  if (summary === null) return { skipped: 'summary-failed' };

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
 * 挂载 host 半边：会话级选择存储 + `agent/pre-step` 规则压缩 + 溢出恢复 + 两条路由。
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
    warn(message, error) {
      ctx.logger?.warn?.(`user-keep-compaction: ${message}`, error);
    },
  };

  /** 一步一步地压：先按出厂保留策略；仍越线则把保留尾巴压到 0 再试一轮。 */
  const runForAgent = async (agent, options) => {
    const key = String(agent?.session?.id ?? '');
    if (key !== '' && runtime.busy.has(key)) return { skipped: 'busy-agent' };
    if (key !== '') runtime.busy.add(key);
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
      runtime.warn('压缩轮次异常，本轮放弃', error);
      return { skipped: 'error' };
    } finally {
      if (key !== '') runtime.busy.delete(key);
    }
  };

  // 自动压力：排在 waterfall 最前，先于预设里的 compaction-basic 动手。
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const sessionId = String(payload?.agent?.session?.id ?? '');
      if (sessionId !== '' && store.enabled(sessionId) && payload.signal?.aborted !== true) {
        await runForAgent(payload.agent, { signal: payload.signal, turn: payload.turn });
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
      return {
        sessionId,
        enabled: record?.enabled === true,
        canSet,
        decidedAt: record?.decidedAt ?? null,
        live,
        /** 诊断：无模型裁剪能不能拿到实例（host / agent 作用域 / 拿不到）。 */
        pruner: runtime.prunerSource ?? null,
        /** 如实标注：预设实景里的 /compact 走的是出厂引擎，不遵守本规则。 */
        manualCompactBypasses: true,
        ...(fallback === undefined ? {} : { fallback }),
      };
    };

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

  ctx.logger?.info?.(`user-keep-compaction: 就绪（状态文件 ${config.stateFile}）`);
}

export const inject = [];
