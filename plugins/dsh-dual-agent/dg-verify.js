/**
 * 双智能指导 · 证据核验器（dg-verify.js）
 *
 * 职责：把执行者/子代理报告里的**出处声明**逐条交给确定性代码核对。这里没有
 * 任何模型判断——每个 check 只做文件系统读取、会话记录比对、纯算术或（可选、
 * 明确开关的）HTTP 请求，并把「实际看到什么」原样写进结果，让主智能与用户都
 * 能分辨「程序核过」与「程序核不了」。
 *
 * 证据块约定（由编排附在任务尾部要求执行者输出，见 index.js CHILD_TASK_TAIL）：
 *
 *   ⟦证据⟧
 *   [{"claim":"index.js 第 3 节已合并","check":{"kind":"file_contains","path":"a.js","needle":"merge"}}]
 *   ⟦/证据⟧
 *
 * 支持的 kind（字段见 CHECKS）：
 *   file_exists / file_absent / file_contains / file_regex / file_line
 *   file_metric / file_modified / session_tool / url / number / text_contains
 * 不做的：`command`（不在宿主里重跑子代理声称的命令——那是提权面，且不可信；
 * 命令类声称必须改用 session_tool，由会话日志里真实存在的 tool/call 佐证）。
 *
 * 诚实边界（写进 detail，不粉饰）：
 *   · 网络类声称默认「未开启联网核验」→ unverifiable，除非 urlChecks:true；
 *   · 越出会话 cwd 的路径仍然核对，但打上 outOfScope 标记；
 *   · 读取有字节上限，超限文件判 unverifiable（不猜内容）。
 *
 * @module dsh-dual-agent/dg-verify
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';

/** 证据块字符上限（解析前）：超过就当格式不可信，不硬解。 */
export const EVIDENCE_BLOCK_LIMIT = 24_000;
/** 单条 claim 文本上限。 */
const CLAIM_TEXT_LIMIT = 400;
/** 默认读文件字节上限（核验用，越小越确定）。 */
const DEFAULT_READ_LIMIT = 256 * 1024;
/** 正文字符上限，防 ReDoS 面过大。 */
const REGEX_SOURCE_LIMIT = 200;
/** 允许的正则 flag 字符。 */
const REGEX_FLAGS = /^[gimsuy]{0,6}$/;

const PASS = 'pass';
const FAIL = 'fail';
const UNKNOWN = 'unverifiable';

const clip = (text, limit = 200) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= limit ? s : `${s.slice(0, limit)}…`;
};

const isStr = (v) => typeof v === 'string' && v !== '';

// ── 证据块解析 ────────────────────────────────────────────────────────────────

const START_MARKERS = ['⟦证据⟧', '[证据]', '⟦证据开始⟧', 'EVIDENCE_BEGIN', '<evidence>'];
const END_MARKERS = ['⟦/证据⟧', '[/证据]', '⟦证据结束⟧', 'EVIDENCE_END', '</evidence>'];

/**
 * 从报告正文里取证据块。
 *
 * 三种形态都收：①带显式起止标记；②只给起始标记（取到文末）；③无标记但收尾是
 * 一个 ```json 围栏且内容是数组——这是对「模型忘了标记」的容忍，但会注明
 * `inferred:true`，让主智能知道它不是按协议交上来的。
 *
 * @param text 报告正文
 * @returns { found, claims, error, inferred }
 */
export function extractEvidence(text) {
  const body = typeof text === 'string' ? text : '';
  if (body.trim() === '') return { found: false, claims: [], error: '报告为空' };

  let startIndex = -1;
  let startMarker = '';
  for (const marker of START_MARKERS) {
    const at = body.indexOf(marker);
    if (at >= 0 && (startIndex < 0 || at < startIndex)) { startIndex = at; startMarker = marker; }
  }

  if (startIndex >= 0) {
    const after = body.slice(startIndex + startMarker.length);
    let endIndex = -1;
    for (const marker of END_MARKERS) {
      const at = after.indexOf(marker);
      if (at >= 0 && (endIndex < 0 || at < endIndex)) endIndex = at;
    }
    const raw = (endIndex >= 0 ? after.slice(0, endIndex) : after).trim();
    return parseClaims(raw, false);
  }

  // 无标记：找最后一个 json 围栏，且必须是数组。
  const fences = [...body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (fences.length === 0) return { found: false, claims: [], error: '报告未带证据块' };
  const raw = fences[fences.length - 1][1].trim();
  if (raw.length > 0 && raw.startsWith('[')) return parseClaims(raw, true);
  return { found: false, claims: [], error: '报告未带证据块' };
}

function parseClaims(raw, inferred) {
  if (raw === '') return { found: true, claims: [], error: '证据块为空', inferred };
  if (raw.length > EVIDENCE_BLOCK_LIMIT) {
    return { found: true, claims: [], error: `证据块过长（${raw.length} 字符 > ${EVIDENCE_BLOCK_LIMIT}）`, inferred };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    return { found: true, claims: [], error: `证据块不是合法 JSON：${clip(cause?.message ?? cause, 120)}`, inferred };
  }
  const list = Array.isArray(value) ? value : (value !== null && typeof value === 'object' ? [value] : null);
  if (list === null) return { found: true, claims: [], error: '证据块必须是数组（每项 {claim, check}）', inferred };
  const claims = [];
  const skipped = [];
  for (const [index, entry] of list.entries()) {
    if (entry === null || typeof entry !== 'object') { skipped.push(`第 ${index + 1} 项不是对象`); continue; }
    const check = entry.check !== null && typeof entry.check === 'object' ? entry.check : entry;
    const kind = isStr(check.kind) || isStr(check.type) ? String(check.kind ?? check.type) : '';
    if (kind === '') { skipped.push(`第 ${index + 1} 项缺 check.kind`); continue; }
    claims.push({
      index,
      claim: clip(entry.claim ?? entry.text ?? '', CLAIM_TEXT_LIMIT),
      kind,
      check,
    });
  }
  return {
    found: true,
    claims,
    inferred,
    error: claims.length === 0 ? `证据块没有可核对的条目（${skipped.join('；') || '空数组'}）` : (skipped.length > 0 ? `部分条目被跳过：${skipped.join('；')}` : null),
  };
}

// ── 路径与读取 ────────────────────────────────────────────────────────────────

/** 把声称里的路径落到会话 cwd，并说明是否越出会话目录。 */
function locate(pathValue, cwd) {
  if (!isStr(pathValue)) return { ok: false, detail: '缺少 path 字段' };
  const base = isStr(cwd) ? cwd : process.cwd();
  let abs;
  try {
    abs = isAbsolute(pathValue) ? pathValue : resolvePath(base, pathValue);
  } catch (cause) {
    return { ok: false, detail: `路径解析失败：${clip(cause?.message ?? cause, 120)}` };
  }
  let outOfScope = false;
  try {
    const rel = relative(base, abs);
    outOfScope = rel.startsWith('..') || isAbsolute(rel);
  } catch { outOfScope = true; }
  return { ok: true, abs, display: pathValue, outOfScope };
}

/** 受限读取：只读文本，超过 limit 直接判无法核验（不猜内容）。 */
function readCapped(abs, limitBytes) {
  const cap = Number.isInteger(limitBytes) && limitBytes > 0 ? limitBytes : DEFAULT_READ_LIMIT;
  let info;
  try {
    info = statSync(abs);
  } catch (cause) {
    return { ok: false, reason: 'stat', detail: `stat 失败：${clip(cause?.code ?? cause?.message ?? cause, 120)}` };
  }
  if (!info.isFile()) return { ok: false, reason: 'not-file', detail: '不是普通文件' };
  if (info.size > cap) {
    return { ok: false, reason: 'too-large', detail: `文件 ${info.size} 字节 > 读取上限 ${cap}`, size: info.size };
  }
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (cause) {
    return { ok: false, reason: 'read', detail: `读取失败：${clip(cause?.code ?? cause?.message ?? cause, 120)}` };
  }
  return { ok: true, text, info };
}

const lineOf = (text, offset) => {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
};

// ── 单项核对 ──────────────────────────────────────────────────────────────────

const result = (status, detail, extra = {}) => ({ status, detail, ...extra });

/**
 * 每个 check 的实现。签名 (check, ctx) → 同步或 Promise，必须**只读**。
 * ctx: { cwd, afterMs, readLimit, urlChecks, timeoutMs, probe }
 */
export const CHECKS = {
  file_exists(check, ctx) {
    const at = locate(check.path, ctx.cwd);
    if (!at.ok) return result(UNKNOWN, at.detail);
    try {
      const info = statSync(at.abs);
      return result(info.isFile() || info.isDirectory() ? PASS : UNKNOWN,
        info.isDirectory() ? '路径是目录，按存在处理' : `存在（${info.size} 字节，mtime=${new Date(info.mtimeMs).toISOString()}）`,
        { path: at.display, outOfScope: at.outOfScope });
    } catch (cause) {
      return result(FAIL, `不存在：${clip(cause?.code ?? cause?.message ?? cause, 120)}`, { path: at.display });
    }
  },

  file_absent(check, ctx) {
    const at = locate(check.path, ctx.cwd);
    if (!at.ok) return result(UNKNOWN, at.detail);
    const exists = existsSync(at.abs);
    return result(!exists ? PASS : FAIL, exists ? '文件其实在' : '确认不存在', { path: at.display });
  },

  file_contains(check, ctx) {
    const at = locate(check.path, ctx.cwd);
    if (!at.ok) return result(UNKNOWN, at.detail);
    if (!isStr(check.needle)) return result(UNKNOWN, '缺少 needle 字符串');
    const read = readCapped(at.abs, ctx.readLimit);
    if (!read.ok) return result(read.reason === 'stat' ? FAIL : UNKNOWN, read.detail, { path: at.display });
    let count = 0;
    let first = -1;
    for (let i = 0; i + check.needle.length <= read.text.length; i += 1) {
      if (read.text.startsWith(check.needle, i)) { count += 1; if (first < 0) first = i; i += check.needle.length - 1; }
    }
    if (count === 0) return result(FAIL, `未命中（文件 ${read.text.length} 字符）`, { path: at.display });
    return result(PASS, `命中 ${count} 处，首处第 ${lineOf(read.text, first)} 行：「${clip(firstLine(read.text, first), 120)}」`,
      { path: at.display, count, outOfScope: at.outOfScope });
  },

  file_regex(check, ctx) {
    const at = locate(check.path, ctx.cwd);
    if (!at.ok) return result(UNKNOWN, at.detail);
    if (!isStr(check.regex)) return result(UNKNOWN, '缺少 regex 字符串');
    if (check.regex.length > REGEX_SOURCE_LIMIT) return result(UNKNOWN, `regex 过长（> ${REGEX_SOURCE_LIMIT} 字符）`);
    const flags = check.flags === undefined ? '' : String(check.flags);
    if (!REGEX_FLAGS.test(flags)) return result(UNKNOWN, 'flags 只允许 gimsuy 组合');
    let pattern;
    try { pattern = new RegExp(check.regex, flags.replace('g', '')); } catch (cause) {
      return result(UNKNOWN, `正则编译失败：${clip(cause?.message ?? cause, 120)}`);
    }
    const read = readCapped(at.abs, ctx.readLimit);
    if (!read.ok) return result(read.reason === 'stat' ? FAIL : UNKNOWN, read.detail, { path: at.display });
    const match = pattern.exec(read.text);
    if (match === null) return result(FAIL, '正则未命中', { path: at.display });
    return result(PASS, `命中于第 ${lineOf(read.text, match.index)} 行：「${clip(match[0], 120)}」`,
      { path: at.display, outOfScope: at.outOfScope });
  },

  file_line(check, ctx) {
    const at = locate(check.path, ctx.cwd);
    if (!at.ok) return result(UNKNOWN, at.detail);
    const line = Number(check.line);
    if (!Number.isInteger(line) || line < 1) return result(UNKNOWN, 'line 必须是 ≥1 的整数');
    const read = readCapped(at.abs, ctx.readLimit);
    if (!read.ok) return result(read.reason === 'stat' ? FAIL : UNKNOWN, read.detail, { path: at.display });
    const lines = read.text.split(/\r?\n/);
    if (line > lines.length) return result(FAIL, `文件只有 ${lines.length} 行，不存在第 ${line} 行`, { path: at.display });
    const actual = lines[line - 1];
    if (!isStr(check.text)) return result(PASS, `第 ${line} 行 = 「${clip(actual, 160)}」（未声明期望文本，只报实际）`, { path: at.display });
    const same = actual.trim() === check.text.trim();
    return result(same ? PASS : FAIL, same ? `第 ${line} 行逐字一致` : `第 ${line} 行不符：期望「${clip(check.text, 160)}」实际「${clip(actual, 160)}」`,
      { path: at.display, outOfScope: at.outOfScope });
  },

  file_metric(check, ctx) {
    const at = locate(check.path, ctx.cwd);
    if (!at.ok) return result(UNKNOWN, at.detail);
    const expect = Number(check.expect);
    if (!Number.isFinite(expect)) return result(UNKNOWN, 'expect 必须是数字');
    const metric = String(check.metric ?? '');
    const read = readCapped(at.abs, ctx.readLimit);
    if (!read.ok) return result(read.reason === 'stat' ? FAIL : UNKNOWN, read.detail, { path: at.display });
    let actual;
    let label;
    if (metric === 'bytes') { actual = Buffer.byteLength(read.text, 'utf8'); label = '字节'; }
    else if (metric === 'lines') { actual = read.text.split(/\r?\n/).length; label = '行'; }
    else if (metric === 'matches') {
      if (!isStr(check.needle)) return result(UNKNOWN, 'metric=matches 需要 needle');
      actual = read.text.split(check.needle).length - 1;
      label = `needle 命中次数`;
    } else return result(UNKNOWN, 'metric 只支持 bytes / lines / matches');
    const tolerance = Number.isFinite(Number(check.tolerance)) ? Math.abs(Number(check.tolerance)) : 0;
    const ok = Math.abs(actual - expect) <= tolerance;
    return result(ok ? PASS : FAIL, `${label} 实际 ${actual} / 声称 ${expect}（容差 ${tolerance}）`, { path: at.display });
  },

  file_modified(check, ctx) {
    const at = locate(check.path, ctx.cwd);
    if (!at.ok) return result(UNKNOWN, at.detail);
    const afterMs = Number.isFinite(Number(check.afterMs)) ? Number(check.afterMs) : ctx.afterMs;
    if (!Number.isFinite(afterMs)) return result(UNKNOWN, '既没给 afterMs，也不知道任务开始时刻');
    try {
      const info = statSync(at.abs);
      const ok = info.mtimeMs >= afterMs;
      return result(ok ? PASS : FAIL,
        `mtime=${new Date(info.mtimeMs).toISOString()} ${ok ? '≥' : '<'} 任务开始 ${new Date(afterMs).toISOString()}`,
        { path: at.display, outOfScope: at.outOfScope });
    } catch (cause) {
      return result(FAIL, `stat 失败：${clip(cause?.code ?? cause?.message ?? cause, 120)}`, { path: at.display });
    }
  },

  /**
   * 会话记录比对：子代理真的调用过某个工具吗？
   * 证据 = 子代理会话日志里的 tool/call（名字 + arguments 文本包含 needle）以及
   * 其对应 tool/result（isError 不为真，且 resultContains 命中）。
   * 这是最强的核对：不重跑命令，只读已经落盘的调用与结果。
   */
  async session_tool(check, ctx) {
    const tool = isStr(check.tool) ? check.tool : (Array.isArray(check.tools) ? check.tools.join('|') : '');
    if (tool === '') return result(UNKNOWN, '缺少 tool（工具名）字段');
    const probe = ctx.probe;
    if (probe === undefined || typeof probe.childEvents !== 'function') {
      return result(UNKNOWN, '无法读取子代理会话记录（probe 未注入）');
    }
    const names = tool.split('|').map((name) => name.trim()).filter(isStr);
    let childIds;
    if (isStr(check.childId)) childIds = [check.childId];
    else {
      try { childIds = await probe.childIds(ctx.rootId); } catch (cause) {
        return result(UNKNOWN, `枚举子会话失败：${clip(cause?.message ?? cause, 120)}`);
      }
    }
    if (!Array.isArray(childIds) || childIds.length === 0) return result(FAIL, '本会话没有可核对的子代理会话记录');
    const needleArgs = isStr(check.argumentContains) ? check.argumentContains : null;
    const needleResult = isStr(check.resultContains) ? check.resultContains : null;
    const wantError = check.expectError === true;
    const seen = [];
    for (const childId of childIds) {
      let events;
      try { events = await probe.childEvents(childId); } catch { continue; }
      if (!Array.isArray(events)) continue;
      for (const event of events) {
        if (event?.type !== 'tool/call') continue;
        const name = String(event.data?.name ?? '');
        if (!names.includes('*') && !names.some((pattern) => name === pattern || name.endsWith(`__${pattern}`))) continue;
        const args = String(event.data?.arguments ?? '');
        if (needleArgs !== null && !args.includes(needleArgs)) continue;
        const callId = event.data?.callId;
        const resultEvent = events.find((candidate) => candidate?.type === 'tool/result'
          && (candidate.data?.message?.toolCallId === callId || candidate.data?.message?.source?.callId === callId));
        if (resultEvent === undefined) { seen.push(`${name}@${childId}（调用有了，结果没落盘）`); continue; }
        const message = resultEvent.data?.message;
        const isError = message?.isError === true || resultEvent.data?.error !== undefined;
        const text = textOfBlocks(message?.content);
        if (wantError && !isError) { seen.push(`${name} 结果为成功，声称要求失败`); continue; }
        if (!wantError && isError && needleResult === null) {
          seen.push(`${name} 结果标了 isError（${clip(text, 120)}）`);
          continue;
        }
        if (needleResult !== null && !text.includes(needleResult)) {
          seen.push(`${name} 结果未含「${clip(needleResult, 80)}」（实际：${clip(text, 160)}）`);
          continue;
        }
        return result(PASS, `子会话 ${childId} 第 ${event.seq ?? '?'} 条事件确实调用 ${name}`
          + `${needleArgs !== null ? `，入参含「${clip(needleArgs, 80)}」` : ''}`
          + `${needleResult !== null ? `，结果含「${clip(needleResult, 80)}」` : ''}`,
        { childId, seq: event.seq, tool: name });
      }
    }
    return result(FAIL, `子代理会话记录里找不到匹配的 ${names.join('/')}`
      + (needleArgs !== null ? `（入参需含「${clip(needleArgs, 80)}」）` : '')
      + (seen.length > 0 ? `；近似命中：${seen.slice(0, 3).join(' / ')}` : ''), { tried: childIds.length });
  },

  async url(check, ctx) {
    if (!isStr(check.url)) return result(UNKNOWN, '缺少 url');
    let parsed;
    try { parsed = new URL(check.url); } catch { return result(UNKNOWN, 'url 不合法'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return result(UNKNOWN, `不支持的协议 ${parsed.protocol}`);
    if (ctx.urlChecks !== true) {
      return result(UNKNOWN, '未开启联网核验（二级菜单里可开），出处是否存在未经程序确认', { url: check.url });
    }
    const maxStatus = Number.isFinite(Number(check.maxStatus)) ? Number(check.maxStatus) : 400;
    const timeoutMs = Number.isFinite(Number(ctx.timeoutMs)) ? ctx.timeoutMs : 8000;
    for (const method of ['HEAD', 'GET']) {
      try {
        const response = await fetch(check.url, {
          method,
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (method === 'HEAD' && response.status >= 400) continue; // 有些源站不答 HEAD，再用 GET 试一次
        const ok = response.status < maxStatus;
        return result(ok ? PASS : FAIL, `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}（阈值 <${maxStatus}）`,
          { url: check.url, status: response.status });
      } catch (cause) {
        if (method === 'GET') {
          return result(UNKNOWN, `请求失败：${clip(cause?.name ?? 'Error', 40)} ${clip(cause?.message ?? cause, 120)}`, { url: check.url });
        }
      }
    }
    return result(UNKNOWN, '请求未完成', { url: check.url });
  },

  /**
   * 明确拒绝执行外部命令。子代理声称「我跑过 X」时，正确做法是 session_tool——
   * 由它自己会话日志里真实存在的 tool/call + tool/result 佐证；这里重跑一次既
   * 不安全（等于让报告内容驱动宿主执行命令），也没有必要（日志就是事实）。
   */
  command() {
    return result(UNKNOWN, '不重跑子代理声称的命令（报告内容不得驱动宿主执行）。'
      + '要证明跑过什么，请改用 {"kind":"session_tool","tool":"pwsh","argumentContains":"…","resultContains":"…"}，'
      + '由会话日志里真实存在的调用与结果佐证。');
  },

  number(check) {
    const a = Number(check.a);
    const b = Number(check.b);
    const op = String(check.op ?? '==');
    if (!Number.isFinite(a) || !Number.isFinite(b)) return result(UNKNOWN, 'a / b 必须是数字');
    let ok = false;
    switch (op) {
      case '==': case '===': case 'eq': ok = a === b; break;
      case '!=': case 'ne': ok = a !== b; break;
      case '<': case 'lt': ok = a < b; break;
      case '<=': case 'le': ok = a <= b; break;
      case '>': case 'gt': ok = a > b; break;
      case '>=': case 'ge': ok = a >= b; break;
      default: return result(UNKNOWN, `不支持的比较符 ${op}`);
    }
    return result(ok ? PASS : FAIL, `${a} ${op} ${b} → ${ok}`);
  },

  text_contains(check) {
    if (!isStr(check.text)) return result(UNKNOWN, '缺少 text');
    if (!isStr(check.needle)) return result(UNKNOWN, '缺少 needle');
    const ok = check.text.includes(check.needle);
    return result(ok ? PASS : FAIL, ok ? '命中' : '未命中', { count: check.text.split(check.needle).length - 1 });
  },
};

export const CHECK_KINDS = Object.keys(CHECKS);

const firstLine = (text, offset) => {
  const nl = text.indexOf('\n', offset);
  return text.slice(text.lastIndexOf('\n', offset) + 1, nl < 0 ? text.length : nl);
};

const textOfBlocks = (content) => (Array.isArray(content) ? content : [])
  .filter((block) => block?.type === 'text')
  .map((block) => block.text ?? '')
  .join('');

// ── 核对执行 ──────────────────────────────────────────────────────────────────

/**
 * 逐条核对。任何一条抛错都归 unverifiable，绝不让整份核验失败。
 *
 * @param claims extractEvidence().claims
 * @param ctx { cwd, rootId, afterMs, readLimit?, urlChecks?, timeoutMs?, probe? , maxClaims? }
 */
export async function verifyEvidence(claims, ctx = {}) {
  const list = Array.isArray(claims) ? claims : [];
  const maxClaims = Number.isInteger(ctx.maxClaims) && ctx.maxClaims > 0 ? ctx.maxClaims : 40;
  const taken = list.slice(0, maxClaims);
  const results = [];
  for (const item of taken) {
    const runner = CHECKS[String(item.kind ?? item.check?.kind ?? item.check?.type ?? '')];
    if (runner === undefined) {
      results.push({
        index: item.index, claim: item.claim, kind: String(item.kind ?? ''), status: UNKNOWN,
        detail: `不支持的核验类型（可用：${CHECK_KINDS.join(' / ')}）`,
      });
      continue;
    }
    try {
      const outcome = await runner(item.check ?? {}, {
        cwd: ctx.cwd,
        rootId: ctx.rootId,
        afterMs: ctx.afterMs,
        readLimit: ctx.readLimit,
        urlChecks: ctx.urlChecks === true,
        timeoutMs: ctx.timeoutMs,
        probe: ctx.probe,
      });
      results.push({ index: item.index, claim: item.claim, kind: String(item.kind ?? ''), ...outcome });
    } catch (cause) {
      results.push({
        index: item.index, claim: item.claim, kind: String(item.kind ?? ''), status: UNKNOWN,
        detail: `核验代码异常：${clip(cause?.message ?? cause, 160)}`,
      });
    }
  }
  const dropped = Math.max(0, list.length - taken.length);
  const counts = {
    total: results.length + dropped,
    pass: results.filter((entry) => entry.status === PASS).length,
    fail: results.filter((entry) => entry.status === FAIL).length,
    unverifiable: results.filter((entry) => entry.status !== PASS && entry.status !== FAIL).length + dropped,
  };
  return { ...counts, results, dropped, ranAt: Date.now() };
}

const STATUS_MARK = { [PASS]: '通过', [FAIL]: '不符', [UNKNOWN]: '无法核验' };

/**
 * 渲染成人读的一节文本（同时给主智能与用户看）。
 * 明确写出「本节由插件代码逐条执行，不含模型判断」——这是它和模型自评的区别。
 */
export function renderVerdict(report, meta = {}) {
  if (report === null || report === undefined) return '';
  const lines = [];
  lines.push(`【程序核验】确定性检查 ${report.total} 条：通过 ${report.pass} · 不符 ${report.fail} · 无法核验 ${report.unverifiable}`);
  if (typeof meta.source === 'string' && meta.source !== '') lines.push(`出处声明来源：${meta.source}`);
  if (meta.extractError !== undefined && meta.extractError !== null && meta.extractError !== '') {
    lines.push(`证据块解析：${meta.extractError}`);
  }
  if (meta.inferred === true) lines.push('（注意：报告没有按 ⟦证据⟧ 协议给出，本节是从 JSON 围栏里推断的）');
  if (report.dropped > 0) lines.push(`超出 ${report.total - report.dropped} 条上限的声称未核对。`);
  if (report.results.length === 0) {
    lines.push('（没有可核对的条目——这份回报没有任何出处被程序验证过。）');
  }
  for (const entry of report.results) {
    lines.push(`- [${STATUS_MARK[entry.status] ?? entry.status}] ${entry.kind}｜${entry.claim !== '' ? entry.claim : '（未写声称文本）'} → ${entry.detail}`);
  }
  if (report.fail > 0) {
    lines.push(`判定口径：${report.fail} 条「不符」= 该出处与现实不一致，必须当作未达标项处理；`
      + `${report.unverifiable} 条「无法核验」= 程序拿不到证据，不得当成已证实。`);
  } else if (report.pass > 0 && report.unverifiable === 0) {
    lines.push('判定口径：全部出处均被程序核对通过（这不等于任务质量达标，只说明出处是真的）。');
  } else {
    lines.push('判定口径：没有「不符」项，但存在无法核验项——未经程序确认的部分不得当作已证实。');
  }
  lines.push('（本节由插件代码逐条执行文件系统 / 会话记录 / 算术 / HTTP 检查生成，不含模型判断。）');
  return lines.join('\n');
}

/** 汇总一行，供 status note 与日志用。 */
export function verdictSummaryLine(report) {
  if (report === null || report === undefined) return '未核验';
  return `核验 ${report.total} 条：通过 ${report.pass}、不符 ${report.fail}、无法核验 ${report.unverifiable}`;
}

export const VERIFY_STATUS = { PASS, FAIL, UNKNOWN };
