/**
 * dsh-safefull —— 权限等级「安全审计后完整权限」（audited-full-access）的审计闸。
 *
 * 等级本身 = 沙箱 `danger-full-access` + 审批 `never`（见 profile patch 的
 * `- id: permission` 预设表）；本插件补上第三件：**执行前的命令安全审计**。
 * 三者合起来才是完整语义——「完整权限，但每条命令先过一道静态安全审计」。
 *
 * 机制来源：claude-code 2.1.287（linux-arm64）解包 bundle 的「命令安全协同」
 * 面，逐条对应关系：
 *
 *   permissions.deny / ask / allow 规则表（Aa 的 allow/ask/deny 三数组）
 *       → 本文件规则表：`deny` > `ask` > `allow` 优先级，未命中默认放行。
 *         原实现里 deny 规则可覆盖钩子的 allow/ask 决定（permission_denials
 *         事件描述逐字证实："deny-rule overrides of hook allow/ask decisions"），
 *         故 deny 必须最先判。
 *   PreToolUse 钩子返回 permissionDecision allow|deny|ask + 原因
 *       → DSH 的 `tools/pre-execute` waterfall：deny → {kind:'deny', reason}。
 *   dontAsk 模式："Don't prompt for permissions, deny if not pre-approved."
 *       → 本等级审批策略是 never、没有提示面，所以 ask 规则**就地转 deny**
 *         并给出富理由（原文：无提示面时 ask 决策是终局拒绝），让模型拿到
 *         可行动反馈而不是一句空洞的 rejected。
 *   钩子失败不阻断运行（runner 失败只是记录，agent 继续）
 *       → 本插件任何自身异常一律 catch → warn → next()，等价于本插件缺位；
 *         审计闸绝不能因为自身 bug 把用户 turn 打死。
 *   规则内容语法 Tool / Tool(content)，content 支持 `*` 通配与 `:*` 前缀形式
 *       → parseRule/matchContent 实现同一套（`\*` 表字面星号）。
 *
 * 落点：这是 profile patch 里的 host 行，无 client 半边、无路由、无设置页——
 * 「基于静态插件机制随 dsh 启动、不需要用户界面管理」。生效范围由预设名
 * 门控（`config.preset`）：只有当前会话解析到该等级时才审计，其余等级与
 * 存量会话完全不受影响。
 *
 * 审计记录：命中 deny/ask 的调用追加一行 JSONL 到 `config.log`
 * （缺省 `$DSH_HOME/safefull-audit.jsonl`），是给人看的审计轨迹，不写会话
 * 日志、不进模型上下文；启停各记一行 load/unload。
 *
 * @module dsh-safefull
 */

import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-safefull';

/** 默认服务的预设名（与 patch 里的预设表键一致）。 */
const DEFAULT_PRESET = 'audited-full-access';

/** 缺省规则表；patch 的 `config.rules` 可整表覆盖（覆盖是逐数组替换）。 */
const DEFAULT_RULES = Object.freeze({
  deny: Object.freeze([
    // 磁盘/文件系统级破坏
    'bash(mkfs*)',
    'bash(sudo mkfs*)',
    'bash(dd *of=/dev/*)',
    'bash(*if=/dev/sd*)',
    'bash(*if=/dev/nvme*)',
    'bash(*> /dev/sd*)',
    'bash(*> /dev/nvme*)',
    'bash(:(){ :|:& };:*)',
    'bash(rm -rf /)',
    'bash(rm -rf /\\*)',
    'bash(rm -fr /)',
    'bash(rm -fr /\\*)',
    // 主机电源状态（本机是承载服务的 NAS，误关即事故）
    'bash(shutdown*)',
    'bash(reboot*)',
    'bash(halt*)',
    'bash(poweroff*)',
    'bash(sudo shutdown*)',
    'bash(sudo reboot*)',
    'bash(sudo halt*)',
    'bash(sudo poweroff*)',
    'bash(systemctl poweroff*)',
    'bash(systemctl reboot*)',
    'bash(sudo systemctl poweroff*)',
    'bash(sudo systemctl reboot*)',
    // 私钥面
    'write(~/.ssh/*)',
    'edit(~/.ssh/*)',
    'read(~/.ssh/id_*)',
  ]),
  /** 需要人工确认的形态；本等级无提示面 → 就地转 deny 并解释。 */
  ask: Object.freeze([
    'bash(*curl *| sh*)',
    'bash(*curl *| bash*)',
    'bash(*wget *| sh*)',
    'bash(*wget *| bash*)',
  ]),
  allow: Object.freeze([]),
});

/** 一次调用的审计主体：返回参与规则匹配的字符串，无主体则 null。 */
const SUBJECT_FIELDS = Object.freeze({
  bash: ['command'],
  write: ['file_path'],
  edit: ['file_path'],
  read: ['file_path'],
});

/**
 * 解析一条规则 `Tool` 或 `Tool(content)`。
 * content 取首个 `(` 到**末个** `)`：括号在内容里是字面量（同原实现
 * "parentheses inside the content are literal"）。空内容或畸形返回 null。
 * @param {unknown} raw 规则文本
 * @returns {{tool: string, content: string | null} | null}
 */
export function parseRule(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;
  const open = text.indexOf('(');
  if (open === -1) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return null;
    return { tool: text, content: null };
  }
  if (!text.endsWith(')')) return null;
  const tool = text.slice(0, open).trim();
  const content = text.slice(open + 1, -1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tool) || content === '') return null;
  return { tool, content };
}

/** 把 `~` 前缀展开成 home（规则与主体两侧都做，保证可比）。 */
function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/** glob（仅 `*` 通配，`\*` 字面星）→ 锚定整串的 RegExp。 */
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\' && pattern[i + 1] === '*') {
      out += '\\*';
      i += 1;
      continue;
    }
    if (ch === '*') {
      out += '[\\s\\S]*';
      continue;
    }
    out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * 规则内容与调用主体的匹配。
 * 支持三种形态：`foo:*` 前缀、含 `*` 的 glob、其余精确等值。
 * @param {string} content 规则内容（未展开）
 * @param {string} subject 调用主体
 * @returns {boolean}
 */
export function matchContent(content, subject) {
  const pattern = expandHome(content);
  const value = expandHome(subject);
  if (pattern.endsWith(':*')) return value.startsWith(pattern.slice(0, -2));
  if (!pattern.includes('*')) return value.trim() === pattern.trim();
  return globToRegExp(pattern).test(value);
}

/**
 * 取一次工具调用的审计主体（bash 的命令、文件工具的目标路径）。
 * @param {{name?: unknown, arguments?: unknown}} exec 待审计的调用
 * @returns {string | null}
 */
export function subjectOf(exec) {
  const fields = SUBJECT_FIELDS[String(exec?.name ?? '')];
  if (fields === undefined) return null;
  const args = exec.arguments;
  if (args === null || typeof args !== 'object') return null;
  for (const field of fields) {
    const value = args[field];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/**
 * 按 deny > ask > allow 求值一张调用。
 * 无主体的工具只可能命中「整工具名」规则（带内容的规则一律不匹配），
 * 与原实现里没有路径可言的工具只受工具级规则约束一致。
 * @param {{deny: readonly object[], ask: readonly object[], allow: readonly object[]}} table 已解析规则表
 * @param {string} tool 工具名
 * @param {string | null} subject 审计主体
 * @returns {{behavior: 'deny' | 'ask' | 'allow', rule: string | null}}
 */
export function evaluate(table, tool, subject) {
  const hits = (rules) => {
    for (const rule of rules) {
      if (rule.tool.toLowerCase() !== tool.toLowerCase()) continue;
      if (rule.content === null) return rule.raw;
      if (subject === null) continue;
      if (matchContent(rule.content, subject)) return rule.raw;
    }
    return null;
  };
  for (const behavior of ['deny', 'ask', 'allow']) {
    const hit = hits(table[behavior] ?? []);
    if (hit !== null) return { behavior, rule: hit };
  }
  return { behavior: 'allow', rule: null };
}

/** 把配置里的规则数组解析成 {tool, content, raw}，丢弃畸形项并计数。 */
function compileRules(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const table = { deny: [], ask: [], allow: [] };
  const malformed = [];
  for (const behavior of ['deny', 'ask', 'allow']) {
    const list = Array.isArray(source[behavior]) ? source[behavior] : DEFAULT_RULES[behavior];
    for (const raw of list) {
      const parsed = parseRule(raw);
      if (parsed === null) {
        malformed.push(String(raw));
        continue;
      }
      table[behavior].push({ ...parsed, raw });
    }
  }
  return { table, malformed };
}

/** 面向模型的拒绝理由：命中哪条规则、为什么在这里是拒绝、下一步能做什么。 */
function reasonOf(behavior, rule, subject) {
  const shown = subject === null ? '' : ` 命令：\`${subject.length > 300 ? `${subject.slice(0, 300)}…` : subject}\``;
  if (behavior === 'ask') {
    return [
      `[安全审计] 命中需人工确认的规则 \`${rule}\`。`,
      shown,
      '当前权限等级「安全审计后完整权限」没有人工审批提示面（审批策略 never），按原实现的 dontAsk 语义，这类命令一律就地拒绝。',
      '请改写为不触发该形态的做法（例如先下载到临时文件、审阅后再执行），或请用户在 /permission 里切换到其他等级。',
    ].filter((part) => part !== '').join(' ');
  }
  return [
    `[安全审计] 命中禁止规则 \`${rule}\`，该调用已被拒绝执行。`,
    shown,
    '这是「安全审计后完整权限」等级的静态审计规则（沙箱与审批都不设限，由本闸把关）。',
    '请改用不触碰该规则的等价做法；确需执行时请用户切换权限等级或调整 dsh-safefull 的规则配置。',
  ].filter((part) => part !== '').join(' ');
}

/** 缺省审计日志路径：$DSH_HOME/safefull-audit.jsonl。 */
function defaultLogPath() {
  const home = process.env.DSH_HOME;
  return join(home !== undefined && home !== '' ? home : join(homedir(), '.dsh'), 'safefull-audit.jsonl');
}

export function apply(ctx, config = {}) {
  const options = config !== null && typeof config === 'object' ? config : {};
  const preset = typeof options.preset === 'string' && options.preset !== '' ? options.preset : DEFAULT_PRESET;
  const { table, malformed } = compileRules(options.rules);
  const logPath = options.log === false
    ? null
    : (typeof options.log === 'string' && options.log !== '' ? options.log : defaultLogPath());

  /** 审计轨迹：best-effort，绝不影响判定。 */
  const record = (entry) => {
    if (logPath === null) return;
    try {
      appendFileSync(logPath, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
    } catch (error) {
      ctx.logger?.warn?.(`safefull: audit log write failed: ${error?.message ?? error}`);
    }
  };

  record({
    event: 'load',
    plugin: name,
    preset,
    rules: { deny: table.deny.length, ask: table.ask.length, allow: table.allow.length },
    malformed,
  });
  if (malformed.length > 0) {
    ctx.logger?.warn?.(`safefull: ${malformed.length} malformed rule(s) ignored: ${malformed.join(', ')}`);
  }
  ctx.effect(() => () => record({ event: 'unload', plugin: name }), 'dsh-safefull audit log');

  /** 会话当前解析到的预设名；服务缺失或异常时返回 null（= 不审计）。 */
  const presetOf = (agent) => {
    try {
      const presets = ctx.get('permissionPresets');
      const sessions = ctx.get('sessions');
      if (presets === undefined || sessions === undefined || agent === undefined) return null;
      const session = sessions.get(agent.id);
      if (session === undefined) return null;
      return presets.current(session);
    } catch (error) {
      ctx.logger?.warn?.(`safefull: preset lookup failed: ${error?.message ?? error}`);
      return null;
    }
  };

  ctx.on('tools/pre-execute', async (exec, next) => {
    let decision = null;
    try {
      if (presetOf(exec.agent) !== preset) return next();
      const subject = subjectOf(exec);
      const verdict = evaluate(table, String(exec.name ?? ''), subject);
      if (verdict.behavior === 'allow') return next();
      decision = { behavior: verdict.behavior, rule: verdict.rule, subject };
    } catch (error) {
      // 审计闸自身故障绝不阻断运行（同原实现「钩子失败不停止运行」）。
      ctx.logger?.warn?.(`safefull: audit failed open: ${error?.message ?? error}`);
      return next();
    }
    record({
      event: 'decision',
      behavior: decision.behavior,
      tool: exec.name,
      rule: decision.rule,
      session: exec.agent?.id,
      subject: decision.subject === null ? null : decision.subject.slice(0, 500),
    });
    return { kind: 'deny', reason: reasonOf(decision.behavior, decision.rule, decision.subject) };
  });
}