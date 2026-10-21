/**
 * resolve — 模型分组解析核心（纯函数，无 I/O、无 Cordis 依赖）。
 *
 * 分组 = 一组「(provider, model) 匹配式」。成员字段支持通配：
 *   `*`  任意长度（含 `/`、`:` 等）
 *   `?`  单个字符
 * 不含通配符的字段按字面比较（区分大小写；组级 ignoreCase 可关闭区分）。
 *
 * ## 归属语义（互斥，冻结契约）
 * 一个 (provider, model) 路由**最多归属一个组**：
 *   1. 只考虑 enabled 的组；
 *   2. 按 (priority 升序, 文件声明顺序) 排出解析次序 order（1 起）；
 *   3. 第一个「有成员命中」的组胜出，其后的候选组记为 shadowed（被遮蔽）；
 *   4. 无任何组命中 → 不属于任何组（统计口径里的「未分组」）。
 * 选「先到先得 + 显式优先级」而不是「最具体者胜」，是因为它在界面上可解释：
 * 用户只调一个数字就能决定归属，且解析次序可以原样打印出来。
 * 组内命中的成员按「模型字段规格 > 供应商字段规格」挑出最具体的一个，
 * 只用于展示与审计（不影响归属）。
 *
 * @module dsh-model-groups/resolve
 */

export const SCHEMA = 1;

export const LIMITS = Object.freeze({
  maxGroups: 64,
  maxMembers: 64,
  maxIdChars: 64,
  maxNameChars: 80,
  maxDescriptionChars: 400,
  maxPriority: 9999,
  maxPatternChars: 200,
});

/* --------------------------------------------------------------- 匹配 ---- */

const regexCache = new Map();
const REGEX_CACHE_MAX = 1024;

/** glob（`*` / `?`）→ 锚定 RegExp；其余正则元字符一律转义。 */
export function globToRegExp(pattern, ignoreCase = false) {
  const text = typeof pattern === 'string' ? pattern : '';
  const key = (ignoreCase ? 'i\u0000' : 's\u0000') + text;
  const cached = regexCache.get(key);
  if (cached !== undefined) return cached;
  let out = '^';
  for (const ch of text) {
    if (ch === '*') out += '[\\s\\S]*';
    else if (ch === '?') out += '[\\s\\S]';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  out += '$';
  const re = new RegExp(out, ignoreCase ? 'i' : '');
  if (regexCache.size >= REGEX_CACHE_MAX) regexCache.clear();
  regexCache.set(key, re);
  return re;
}

/**
 * 字段规格：字面=2，带通配的模式=1，全星号=0。
 *
 * 「全星号」= 只由 `*` 组成（`*`、`**`、`***`…）或空串——它们在语义上都等于「任意」，
 * 匹配范围与裸 `*` 完全一致，所以必须计 0（H7）。若按「含通配符」计 1，provider 与
 * model 双全星号的成员会假装比 provider 字面成员更具体，把「最具体命中成员」报错；
 * 语义上等同于「任意供应商 × 任意模型」的组，其遮蔽告警也会漏报。
 */
export function specOf(pattern) {
  const text = typeof pattern === 'string' ? pattern.trim() : '';
  if (text === '' || /^\*+$/.test(text)) return 0;
  return /[*?]/.test(text) ? 1 : 2;
}

/** 字段取值：非字符串一律按空串（与 resolve/explain 的入参口径一致）。 */
const asText = (value) => (typeof value === 'string' ? value : '');

/**
 * 复合键编码：`<左字段长度>:<左字段><右字段>`。
 *
 * 用长度前缀而不是 `\u0000` 拼接，是因为 NUL 可以出现在任意一侧字段里：
 * `("a", "b\u0000c")` 与 `("a\u0000b", "c")` 用 NUL 拼接会得到同一个键——成员去重会
 * 误删（H6），路由记忆表还会对两条不同路由返回同一个答案，与 explain 自相矛盾。
 * 本编码可无歧义反解（数字段不含 `:`，故第一个 `:` 就是分隔符），任意字段内容都不撞键。
 */
export function pairKey(left, right) {
  const a = asText(left);
  const b = asText(right);
  return a.length + ':' + a + b;
}

/** 归一化一个匹配式字段：空/空白 → 裸 `*`。 */
export function normPattern(value) {
  if (typeof value !== 'string') return '*';
  const text = value.trim();
  if (text === '') return '*';
  return text.slice(0, LIMITS.maxPatternChars);
}

/**
 * 成员字段归一化：在 normPattern 之上剥掉 U+0000 控制字符（剥完为空则退回 `*`）。
 * 返回 source 以便 issues 如实报告原值。
 */
function memberField(value) {
  const source = normPattern(value);
  if (!source.includes('\u0000')) return { text: source, source, hadNul: false };
  const cleaned = source.replace(/\u0000/g, '');
  return { text: cleaned === '' ? '*' : cleaned, source, hadNul: true };
}

/* ------------------------------------------------------------- 编译 ---- */

/**
 * 把文档里的组编译成解析次序表（只含 enabled 组）。
 * 纯函数：同一输入永远得到同一顺序。
 *
 * @param {Array} groups 归一化后的组数组（resolve.js:normalizeDocument 的产物）
 * @returns {Array<{group: object, fileIndex: number, order: number, matchers: Array}>}
 */
export function compileGroups(groups) {
  const rows = [];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    if (!group || group.enabled === false) continue;
    rows.push({ group, fileIndex: index });
  }
  rows.sort((a, b) => (a.group.priority - b.group.priority) || (a.fileIndex - b.fileIndex));
  return rows.map((row, at) => ({
    group: row.group,
    fileIndex: row.fileIndex,
    order: at + 1,
    matchers: (Array.isArray(row.group.members) ? row.group.members : []).map((member) => ({
      member,
      pRe: globToRegExp(member.provider, row.group.ignoreCase === true),
      mRe: globToRegExp(member.model, row.group.ignoreCase === true),
      pSpec: specOf(member.provider),
      mSpec: specOf(member.model),
    })),
  }));
}

/** 组内挑最具体命中成员：模型字段优先，其次供应商字段；并列取先声明者。 */
function bestMatcher(entry, provider, model) {
  let best = null;
  for (const matcher of entry.matchers) {
    if (!matcher.pRe.test(provider) || !matcher.mRe.test(model)) continue;
    if (best === null
      || matcher.mSpec > best.mSpec
      || (matcher.mSpec === best.mSpec && matcher.pSpec > best.pSpec)) {
      best = matcher;
    }
  }
  return best;
}

/* ------------------------------------------------------------- 解析 ---- */

/**
 * 解析一个路由的归属。
 *
 * @param {Array} compiled compileGroups 的产物
 * @param {string} provider
 * @param {string} model
 * @returns {null | {groupId, groupName, order, priority, member: {provider, model}, fileIndex}}
 */
export function resolveRoute(compiled, provider, model) {
  const p = asText(provider);
  const m = asText(model);
  for (const entry of compiled) {
    const matcher = bestMatcher(entry, p, m);
    if (matcher === null) continue;
    return {
      groupId: entry.group.id,
      groupName: entry.group.name,
      order: entry.order,
      priority: entry.group.priority,
      fileIndex: entry.fileIndex,
      member: { provider: matcher.member.provider, model: matcher.member.model },
    };
  }
  return null;
}

/**
 * 解释一个路由的归属：胜出组 + 全部其它命中组（被遮蔽者）。
 * 用于设置页「试算」与审计，不参与运行期判定。
 *
 * @returns {{provider, model, winner: object|null, candidates: Array<{groupId, groupName, order, priority, member, shadowed: boolean}>}}
 */
export function explainRoute(compiled, provider, model) {
  const p = asText(provider);
  const m = asText(model);
  const candidates = [];
  let winner = null;
  for (const entry of compiled) {
    const matcher = bestMatcher(entry, p, m);
    if (matcher === null) continue;
    const row = {
      groupId: entry.group.id,
      groupName: entry.group.name,
      order: entry.order,
      priority: entry.group.priority,
      fileIndex: entry.fileIndex,
      member: { provider: matcher.member.provider, model: matcher.member.model },
      shadowed: winner !== null,
    };
    candidates.push(row);
    if (winner === null) winner = row;
  }
  return { provider: p, model: m, winner, candidates };
}

/* --------------------------------------------------- 归一化与校验 ---- */

/** 从任意字符串派生一个合法 id（ASCII slug；中文等非 ASCII → 空）。 */
export function slugify(value) {
  const text = typeof value === 'string' ? value.normalize('NFKD') : '';
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, LIMITS.maxIdChars);
  return slug;
}

/** id 合法性与唯一化：确保 `^[a-z0-9][a-z0-9._-]*$` 且不与 taken 冲突。 */
export function uniqueId(candidate, taken) {
  const base = (slugify(candidate) || 'group').replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '') || 'group';
  let id = base.slice(0, LIMITS.maxIdChars);
  if (!taken.has(id)) return id;
  for (let n = 2; n < 1000; n++) {
    const suffix = '-' + n;
    const next = base.slice(0, LIMITS.maxIdChars - suffix.length) + suffix;
    if (!taken.has(next)) return next;
  }
  return base.slice(0, LIMITS.maxIdChars - 7) + '-' + Date.now().toString(36).slice(-5);
}

/**
 * 组 id 的形状（小写字母/数字开头，其后可含小写字母、数字、. _ -）。
 * 导出给 host 半边的折叠状态存储复用：折叠项就是组 id，两处必须同一把尺子。
 */
export const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * 归一化 + 校验一份分组文档。宽容读取（坏字段就地修正并记 issue），
 * 严格写入（POST 路径在写入前跑同一函数并拒绝致命错误）。
 *
 * 三类问题分开报告，调用方各取所需：
 *   - `issues`      结构合法，只有某个组/字段不规范 → 就地修正后照常使用；
 *   - `fatal`       超上限，写入必须拒绝（读盘侧仍按上限截断使用）；
 *   - `shapeErrors` 「JSON 合法但形状非法」：根不是对象 / 缺少或不是 `groups` 数组 /
 *                   `schema` 写了但不认识 → 整份文件不可信，读盘侧必须按**坏文件**
 *                   处理（保留上次可用快照 + 告警），不得当作「空文档」把分组清空（H1）。
 *
 * @param {unknown} raw 解析后的 JSON（或客户端提交体）
 * @returns {{doc: {schema, revision, groups: Array}, issues: string[], fatal: string[], shapeErrors: string[]}}
 */
export function normalizeDocument(raw, options = {}) {
  const issues = [];
  const fatal = [];
  const shapeErrors = [];
  const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  // raw === undefined（根本没有文档）沿用旧的宽容口径：等同空文档，不算形状非法。
  const absent = raw === undefined;
  const source = isPlain(raw) ? raw : {};
  if (!absent && !isPlain(raw)) {
    shapeErrors.push(raw === null ? '文档根是 null（期望对象）' : `文档根是 ${Array.isArray(raw) ? '数组' : typeof raw}（期望对象）`);
    issues.push('文档根不是对象：已按空文档处理');
  }
  // schema 缺省按 1 收（兼容手写文件）；写了但不认识 → 不猜未来格式，整份文件按坏文件处理。
  // 宽容一处：字符串 "1"（很多手写/工具产出的 JSON 会把数字写成字符串）等同数字 1；
  // 其余（"2"、true、对象…）仍按不认识处理——宁可拒绝，也不猜格式。
  const schemaNumber = typeof source.schema === 'string' && source.schema.trim() !== '' ? Number(source.schema) : source.schema;
  if (source.schema !== undefined && schemaNumber !== SCHEMA) {
    shapeErrors.push(`schema ${JSON.stringify(source.schema)} 不是本插件认识的 ${SCHEMA}`);
  }
  if (!absent && !Array.isArray(source.groups)) {
    shapeErrors.push(source.groups === undefined
      ? '缺少 groups 数组'
      : `groups 不是数组（${source.groups === null ? 'null' : typeof source.groups}）`);
    if (source.groups !== undefined) issues.push('groups 不是数组：已按空数组处理');
  }
  const rawGroups = Array.isArray(source.groups) ? source.groups : [];
  if (rawGroups.length > LIMITS.maxGroups) fatal.push(`分组数 ${rawGroups.length} 超过上限 ${LIMITS.maxGroups}`);
  const revision = Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0;
  const keepRevision = options.revision !== undefined ? options.revision : revision;

  const taken = new Set();
  const groups = [];
  for (let index = 0; index < Math.min(rawGroups.length, LIMITS.maxGroups); index++) {
    const item = rawGroups[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`groups[${index}] 不是对象：已跳过`);
      continue;
    }
    const name = typeof item.name === 'string' && item.name.trim() !== ''
      ? item.name.trim().slice(0, LIMITS.maxNameChars)
      : `分组 ${index + 1}`;
    let id = typeof item.id === 'string' && item.id.trim() !== '' ? item.id.trim().toLowerCase() : '';
    if (id.length > LIMITS.maxIdChars) {
      // 长度上限必须在合法性判定**之前**强制：合法但超长的 id 会原样落盘、绕过
      // limits.maxIdChars（H3）。截断策略与 name/description 一致（确定性前缀 + issues）。
      const cut = id.slice(0, LIMITS.maxIdChars);
      issues.push(`groups[${index}].id 长度 ${id.length} 超过上限 ${LIMITS.maxIdChars}：已截断为 "${cut}"`);
      id = cut;
    }
    if (id === '' || !ID_RE.test(id)) {
      const next = uniqueId(id || name, taken);
      if (id !== '') issues.push(`groups[${index}].id "${id}" 不合法（需匹配 ${ID_RE.source}）：已改为 "${next}"`);
      id = next;
    }
    if (taken.has(id)) {
      // 含「截断后与前面的组撞名」：截断后仍必须唯一。
      const next = uniqueId(id, taken);
      issues.push(`组 id "${id}" 重复：后者已改为 "${next}"`);
      id = next;
    }
    taken.add(id);

    const members = [];
    const seen = new Set();
    const rawMembers = Array.isArray(item.members) ? item.members : [];
    if (!Array.isArray(item.members) && item.members !== undefined) issues.push(`组 "${id}" 的 members 不是数组：已按空数组处理`);
    if (rawMembers.length > LIMITS.maxMembers) {
      fatal.push(`组 "${id}" 成员数 ${rawMembers.length} 超过上限 ${LIMITS.maxMembers}`);
    }
    for (let at = 0; at < Math.min(rawMembers.length, LIMITS.maxMembers); at++) {
      const entry = rawMembers[at];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        issues.push(`组 "${id}" 的 members[${at}] 不是对象：已跳过`);
        continue;
      }
      const provider = memberField(entry.provider);
      const model = memberField(entry.model);
      if (provider.hadNul || model.hadNul) {
        // U+0000 会污染复合键（成员去重 / 路由记忆表），归一化时直接剥掉（H6）。
        issues.push(`组 "${id}" 的成员 ${JSON.stringify(provider.source)} / ${JSON.stringify(model.source)} 含 U+0000：已剥除`);
      }
      if (provider.text === '*' && model.text === '*') {
        issues.push(`组 "${id}" 含 catch-all 成员 */*：它会遮蔽所有排在它后面的组`);
      }
      const key = pairKey(provider.text, model.text);
      if (seen.has(key)) {
        issues.push(`组 "${id}" 含重复成员 ${provider.text} / ${model.text}：已去重`);
        continue;
      }
      seen.add(key);
      members.push({ provider: provider.text, model: model.text });
    }
    if (members.length === 0) issues.push(`组 "${id}" 没有成员：不会命中任何模型`);

    const priorityRaw = item.priority;
    const priority = Number.isFinite(priorityRaw)
      ? Math.max(0, Math.min(LIMITS.maxPriority, Math.trunc(priorityRaw)))
      : 100;
    if (Number.isFinite(priorityRaw) && Math.trunc(priorityRaw) !== priority) {
      issues.push(`组 "${id}" 的 priority 超出 0..${LIMITS.maxPriority}：已钳制为 ${priority}`);
    }

    groups.push({
      id,
      name,
      description: typeof item.description === 'string' ? item.description.slice(0, LIMITS.maxDescriptionChars) : '',
      enabled: item.enabled !== false,
      priority,
      ignoreCase: item.ignoreCase === true,
      members,
    });
  }

  const allDisabled = groups.length > 0 && groups.every((group) => group.enabled === false);
  if (allDisabled) issues.push('所有分组都已停用：当前所有模型都归入「未分组」');

  return {
    doc: { schema: SCHEMA, revision: keepRevision, groups },
    issues,
    fatal,
    shapeErrors,
  };
}

/** 空的初始文档（无分组）。 */
export function emptyDocument() {
  return { schema: SCHEMA, revision: 0, groups: [] };
}
