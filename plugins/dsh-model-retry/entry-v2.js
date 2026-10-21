/**
 * 按模型的重试策略（dsh-model-retry）— host 半边（当前实现，v2）。
 *
 * 本插件接管 @deepseek-ai/dsh-llm-retry 的角色（组合层经 patch 行
 * `- id: llm-retry / disabled: true` 停用出厂执行器），在同一个
 * agent/request-error waterfall 上执行，并增加三项能力：
 *   1. 策略解析按 (provider, model) 匹配规则——出厂的 retryPolicy 只能
 *      按 provider 配置；
 *   2. 触发条件除失败类别码（EMPTY_RESPONSE/RATE_LIMIT/…）外，支持按
 *      HTTP 状态码（429/500/502/…）触发；
 *   3. **v2 新增：规则可以按「模型分组」（dsh-model-groups 的命名组）命中**，
 *      用 `group: <组 id>` 给一整组模型（成员可跨供应商）下同一套策略。
 *
 * ## 规则匹配与优先级（v2 冻结口径）
 * 规则的三个选择器 provider / model / group 是**与**关系（写了就必须命中）；
 * 命中后按「选择器权重之和」打分，分高者胜，同分取文件中靠前的规则：
 *   provider 字面 +2 · model 字面 +2 · group 命中 +3
 * 完整的优先级序（高→低）：
 *   7  group+provider+model
 *   5  group+provider 或 group+model
 *   4  provider+model（单路由精确）
 *   3  group（仅按组）
 *   2  provider 或 model（单选择器）
 *   0  全通配（`*`）
 * 语义意图：
 *   - **只按组的规则 (3) 不会盖掉已有的精确路由规则 (4)**——旧库升级后行为稳定；
 *   - **只按组的规则 (3) 一定盖掉 provider/model 通配规则 (2)**——这正是
 *     「给整组下一套策略」的用途，且不受规则先后顺序影响；
 *   - **选择器越多越具体**：组规则再钉上 provider/model（5/7）就会优先于单路由精确
 *     规则——这是用户显式写下的更窄规则，设置页「试算」会在保存前算出归属；
 *     要让某条路由反过来压过这种组规则，就给它写同样多（或更多）选择器的规则。
 *   - v1 规则集（无 group）的打分与 v1 逐项一致（0/2/4，同分取靠前者），行为不变。
 * group 规则只在 dsh-model-groups 在线且该 (provider, model) 确实归属该组时命中；
 * 插件不在线或组被停用/删除 → 该规则静默不命中（GET /rules 会带 warnings 提示）。
 * 分组归属是 (provider, model) 的函数、与重试次数无关，故 policyKey 在重试过程中
 * 保持稳定，不会破坏 llmRetryModel 投影的预算折叠（不会出现重试风暴）。
 *
 * v2 另加只读试算路由（给设置页用）：
 *   POST /dsh-model-retry/preview {provider, model}
 *     → 用真实匹配逻辑回报命中规则、其优先级分数、解析到的组、以及最终策略。
 *
 * 其余机制与出厂执行器逐项对齐（移植自其源码）：
 *   - 每次重试先落 durable `llm/retry` 事件再退避等待，等待前写
 *     `llm/retry-started`，返回 {kind:'retry'} 让 agent loop 在同一
 *     open turn 内重跑失败步；
 *   - 预算计数经 sessionProjections 投影单元（key: llmRetryModel）从
 *     会话日志折叠，step/start 与 turn/end 归零（=当前步的重试次数）；
 *   - 退避指数+抖动，provider Retry-After 优先并受 maxDelayMs 钳制；
 *   - always 模式先问下游、失败不限次；
 *   - 未匹配任何规则的模型完全按适配器自带的 retryPolicy（出厂缺省：
 *     普通 5 次、五类失败码、500ms→10s）执行，行为与停用前一致。
 *
 * 规则落盘 $DSH_HOME/model-retry-rules.json（缺省 ~/.dsh/），每次失败
 * 现读现用（改文件即热生效）；浏览器经设置页「重试策略」（./client.js）
 * 走 webServer 路由读写。规则文件是手工可编辑的，故读取路径对坏输入的口径
 * 单独冻结如下：
 *
 * ## 坏输入与读取路径（归一化口径）
 *   - **一次归一化**：非对象条目（null/数字/字符串/数组）在 readRules 出口
 *     剔除并逐条给 warnings（「第 N 条规则不是对象（null），已忽略」）；字段
 *     类型坏掉的（provider/model/group 非字符串、retryableCodes/statusCodes
 *     非数组、mode 非法）就地摘除或归为 normal。GET /rules、POST /preview、
 *     打分、匹配、分组目录只见对象，任何坏输入都不抛；
 *   - **形状非法不静默**：根不是对象、rules 不是数组，或 JSON 解析失败时，
 *     返回 rules: [] 的同时带 error + 同名 warning（文件**未被改写**），
 *     明确「在本页保存会用空规则集覆盖原文件」——旧的静默空集会诱导设置页
 *     把坏文件当「正常空配置」自动保存，覆盖用户数据；
 *   - 请求体 >256 KiB：**先**完整写出 413 JSON（`Connection: close`），
 *     **再**排空请求体结束连接；绝不提前 `req.destroy()`（那会让响应根本
 *     到不了客户端，只剩「连接被重置」）；
 *   - 写入路由同源守卫：无 Origin 头放行（本机 curl / 同进程调用），
 *     `Origin: null` 按**外部**来源处理（403）。
 *
 * 组合行（profile 的 cordis.patch.yml）：
 *   - id: llm-retry
 *     disabled: true
 *   - insert:
 *       - id: model-retry
 *         name: ./plugins/dsh-model-retry/entry-v2.js      ← 换实现＝换这个 name（同 id）
 *
 * @module dsh-model-retry
 */

import { randomUUID } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const inject = ['sessionProjections', 'webServer'];

const RULES_ROUTE = '/dsh-model-retry/rules';
const PREVIEW_ROUTE = '/dsh-model-retry/preview';
const MAX_TIMER_DELAY_MS = 2147483647;
/** 请求体上限：256 KiB（按 UTF-8 字节计）。 */
const MAX_BODY_BYTES = 262144;
/** 构建标记（变更时递增；GET /dsh-model-retry/rules 会回报，用于确认线上代码版本）。 */
const BUILD = 'fix-2';
/** 读路径净化的口径（与写路由的 zod schema 逐项一致）。 */
const MAX_RETRIES_LIMIT = 1000;
const MAX_STATUS_CODES = 64;
const MAX_CODES = 32;
const MAX_CODE_CHARS = 80;
const MAX_DELAY_MS = 2147483647;
/** 坏条目告警条数上限（其余折叠成一行汇总，避免坏文件把响应刷爆）。 */
const MAX_ENTRY_WARNINGS = 10;

/** 出厂缺省（dsh-llm/retry-policy）。 */
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 10000;
const DEFAULT_JITTER_RATIO = 0.1;
const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
]);
/** 全部已知失败类别（UI 供选项；校验保持宽容）。 */
export const KNOWN_CODES = Object.freeze([
  'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
  'QUOTA', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED',
]);

/** 选择器权重（v2）：字面 provider/model 各 2，group 命中 3。 */
const W_PROVIDER = 2;
const W_MODEL = 2;
const W_GROUP = 3;

const MAX_TIMER = MAX_TIMER_DELAY_MS;
const backoffSchema = z.object({
  initialDelayMs: z.number().positive().max(MAX_TIMER).optional(),
  maxDelayMs: z.number().positive().max(MAX_TIMER).optional(),
  jitterRatio: z.number().min(0).max(1).optional(),
});
const ruleSchema = z.object({
  provider: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  group: z.string().max(200).optional(),
  mode: z.enum(['normal', 'always']),
  maxRetries: z.number().int().min(0).max(1000).optional(),
  retryableCodes: z.array(z.string().min(1).max(80)).max(32).optional(),
  statusCodes: z.array(z.number().int().min(100).max(599)).max(64).optional(),
  backoff: backoffSchema.optional(),
});
const rulesSchema = z.object({ rules: z.array(ruleSchema).max(64) });

const rulesPath = () => {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'model-retry-rules.json');
};

/** 字面选择器：空 / `*` → null（= 不限制）。 */
function literalOf(value) {
  return typeof value === 'string' && value !== '' && value !== '*' ? value : null;
}

/** group 选择器：空 / `*` → null（= 不限制）。 */
export function groupSelectorOf(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' || text === '*' ? null : text;
}

/** 条目类型的中文描述（归一化告警文案用）。 */
function entryKindOf(value) {
  if (value === null) return 'null';
  if (value === undefined) return '缺失';
  if (Array.isArray(value)) return '数组';
  return typeof value;   // number / string / boolean / object
}

/** 条目是否为可用的规则对象（排除 null / 数组 / 标量）。 */
function isRuleObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 归一化单条规则——**只摘除坏字段，不改动任何匹配/打分语义**：
 *   - provider / model / group 非字符串 → 摘除（scoreOf 对非字符串本就按
 *     「不限制」处理，故打分与命中结果逐项不变）；
 *   - retryableCodes / statusCodes 存在但非数组 → 摘除（policyFor 会把它们
 *     展开成数组，非可迭代值会抛 TypeError）；
 *   - mode 不是 'always' → 归为 'normal'（policyFor 对非 'always' 本就按
 *     normal 处理，行为不变，只是让回显与设置页下拉一致）；
 *   - 其余字段（含 tag/note 之类未知扩展字段）原样保留。
 *
 * @param {object} item 已确认是对象的规则条目
 * @returns {object} 归一化后的**副本**（不改写原对象）
 */
export function normalizeRuleEntry(item) {
  const rule = { ...item };
  for (const key of ['provider', 'model', 'group']) {
    if (rule[key] !== undefined && typeof rule[key] !== 'string') delete rule[key];
  }
  for (const key of ['retryableCodes', 'statusCodes']) {
    if (rule[key] !== undefined && !Array.isArray(rule[key])) delete rule[key];
  }
  if (rule.mode !== 'always') rule.mode = 'normal';
  return rule;
}

/**
 * 单条规则的匹配度：不命中返回 -1；命中返回权重和
 * （provider 字面 2 + model 字面 2 + group 命中 3）。
 *
 * @param {object} rule
 * @param {string} provider 请求实际使用的 provider
 * @param {string} model    请求实际使用的 model（来自 requestHeader）
 * @param {string|null} groupId 该 (provider, model) 解析到的组 id（无 → null）
 * @returns {number} -1 = 不命中
 */
export function scoreOf(rule, provider, model, groupId) {
  if (rule === null || typeof rule !== 'object') return -1;
  const ruleProvider = literalOf(rule.provider);
  const ruleModel = literalOf(rule.model);
  const ruleGroup = groupSelectorOf(rule.group);
  if (ruleProvider !== null && ruleProvider !== provider) return -1;
  if (ruleModel !== null && ruleModel !== model) return -1;
  if (ruleGroup !== null && ruleGroup !== groupId) return -1;
  return (ruleProvider !== null ? W_PROVIDER : 0)
    + (ruleModel !== null ? W_MODEL : 0)
    + (ruleGroup !== null ? W_GROUP : 0);
}

/**
 * 选规则：权重高者胜；同分取文件中靠前者（严格 `>` 比较，保持 v1 行为）。
 * v1 的 (provider, model) 打分是 2/2，本函数在没有 group 的规则上与之逐项一致。
 */
export function matchRule(rules, provider, model, groupId = null) {
  let best = null;
  let bestScore = -1;
  for (const rule of rules) {
    const score = scoreOf(rule, provider, model, groupId);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

function resolveBackoff(config) {
  return Object.freeze({
    initialDelayMs: config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs: config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    jitterRatio: config?.jitterRatio ?? DEFAULT_JITTER_RATIO,
  });
}

/** 适配器解析出的政策是扁平结构（initialDelayMs 等在顶层，见 dsh-llm
 * resolveRetryPolicy 的 `...resolveBackoff(...)` 展开）→ 统一归一为嵌套
 * backoff 形状；已是嵌套形状（本插件规则产物）则原样返回。 */
function normalizePolicy(policy) {
  if (policy === undefined || policy === null || policy.backoff !== undefined) return policy;
  const backoff = Object.freeze({
    initialDelayMs: policy.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs: policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    jitterRatio: policy.jitterRatio ?? DEFAULT_JITTER_RATIO,
  });
  if (policy.mode === 'always') return Object.freeze({ mode: 'always', backoff });
  return Object.freeze({
    mode: 'normal',
    maxRetries: policy.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryableCodes: Object.freeze([...(policy.retryableCodes ?? DEFAULT_RETRYABLE_CODES)]),
    backoff,
  });
}

/** Rule (or adapter policy fallback) → executor policy. Returns undefined when nothing applies. */
function policyFor(rule, adapterPolicy) {
  if (rule === undefined || rule === null) return normalizePolicy(adapterPolicy);
  if (rule.mode === 'always') {
    return Object.freeze({ mode: 'always', backoff: resolveBackoff(rule.backoff) });
  }
  return Object.freeze({
    mode: 'normal',
    maxRetries: rule.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryableCodes: Object.freeze([...(rule.retryableCodes ?? DEFAULT_RETRYABLE_CODES)]),
    statusCodes: Object.freeze([...(rule.statusCodes ?? [])]),
    backoff: resolveBackoff(rule.backoff),
  });
}

/** 无规则命中时适配器自带策略的缺省形态（用于预览展示）。 */
function factoryDefaults() {
  return {
    mode: 'normal',
    maxRetries: DEFAULT_MAX_RETRIES,
    retryableCodes: [...DEFAULT_RETRYABLE_CODES],
    statusCodes: [],
    backoff: { initialDelayMs: DEFAULT_INITIAL_DELAY_MS, maxDelayMs: DEFAULT_MAX_DELAY_MS, jitterRatio: DEFAULT_JITTER_RATIO },
  };
}

function retryPolicyKey(policy) {
  const backoff = policy.backoff ?? {};
  return policy.mode === 'always'
    ? JSON.stringify([policy.mode, backoff.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS, backoff.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, backoff.jitterRatio ?? DEFAULT_JITTER_RATIO])
    : JSON.stringify([
        policy.mode, policy.maxRetries, [...(policy.retryableCodes ?? DEFAULT_RETRYABLE_CODES)].sort(),
        backoff.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS, backoff.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, backoff.jitterRatio ?? DEFAULT_JITTER_RATIO,
      ]);
}

function localDelay(backoff, retry, random) {
  const exponent = Math.min(retry - 1, 1024);
  const exponential = Math.min(backoff.initialDelayMs * 2 ** exponent, backoff.maxDelayMs);
  const jitter = 1 - backoff.jitterRatio + 2 * backoff.jitterRatio * random();
  return Math.min(exponential * jitter, backoff.maxDelayMs);
}

function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function settleDownstream(next) {
  try {
    return { type: 'decision', decision: await next() };
  } catch (error) {
    return { type: 'error', error };
  }
}

export function apply(ctx) {
  const random = Math.random;
  const lifetime = new AbortController();
  const active = new Set();
  const track = (operation) => {
    const tracked = operation.finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  };

  // ---- durable retry budget: fold our llm/retry events per (provider, model, policy) ----
  const stateSchema = z.record(z.string(), z.object({
    retry: z.number().int().nonnegative(),
    retryId: z.string(),
  }));
  ctx.sessionProjections.register({
    key: 'llmRetryModel',
    stateVersion: 1,
    stateSchema,
    init: () => ({}),
    apply: (state, event) => {
      if (event.type === 'step/start' || event.type === 'turn/end') return {};
      if (event.type !== 'llm/retry') return state;
      if (typeof event.data?.model !== 'string') return state; // 只计本插件排的重试
      const key = JSON.stringify([event.data.provider, event.data.model, event.data.policyKey]);
      const entry = state[key];
      if (entry?.retry === event.data.retry && entry.retryId === event.data.retryId) return state;
      return { ...state, [key]: { retry: event.data.retry, retryId: event.data.retryId } };
    },
  });

  // ---- 分组解析（可选依赖：分组插件不在线时 group 规则静默不命中）----

  /** 取模型分组服务（每次现取：插件可后于本行挂载/热重载）。 */
  function groupService() {
    try {
      const service = ctx.get('modelGroups');
      return service !== undefined && typeof service.resolve === 'function' ? service : undefined;
    } catch {
      return undefined;
    }
  }

  /** (provider, model) → 组 id（无组/服务不可用 → null）。归属与重试次数无关，故稳定。 */
  function groupIdOf(provider, model) {
    const service = groupService();
    if (service === undefined) return null;
    try {
      const hit = service.resolve(provider, model);
      return hit === null || hit === undefined || typeof hit.groupId !== 'string' ? null : hit.groupId;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-model-retry: 分组解析失败，本次按无组处理: ${String(error && error.message || error)}`);
      return null;
    }
  }

  /** 给设置页/预览用的分组目录 + 规则引用检查。 */
  function groupCatalog(rules) {
    const service = groupService();
    if (service === undefined || typeof service.list !== 'function') {
      return {
        available: false,
        groups: [],
        warnings: ['模型分组插件（dsh-model-groups）不在线：带 group 的规则不会命中任何请求。'],
      };
    }
    let list = [];
    try {
      list = service.list().map((group) => ({
        id: group.id, name: group.name, enabled: group.enabled !== false, order: group.order,
        members: Array.isArray(group.members) ? group.members.length : 0,
      }));
    } catch (error) {
      return { available: false, groups: [], warnings: [`读取分组失败：${String(error && error.message || error)}`] };
    }
    const warnings = [];
    const referenced = new Set();
    for (const rule of Array.isArray(rules) ? rules : []) {
      // readRules 出口已归一化；此处再挡一道，保证「任何坏输入都不抛」
      // （旧实现让 null 项走到 `rule.group` → TypeError → 真实 webServer
      // 变成无 Content-Type 的空 400）。
      const id = isRuleObject(rule) ? groupSelectorOf(rule.group) : null;
      if (id !== null) referenced.add(id);
    }
    for (const id of referenced) {
      const found = list.find((group) => group.id === id);
      if (found === undefined) warnings.push(`规则引用的分组「${id}」不存在：该规则不会命中。`);
      else if (found.enabled === false) warnings.push(`规则引用的分组「${id}」已停用：该规则不会命中。`);
    }
    return { available: true, groups: list, warnings };
  }

  async function backoff(agent, turn, step, provider, model, failure, policy, policyKey, retry, retryId, delayMs, signal) {
    const fusedSignal = AbortSignal.any([signal, lifetime.signal]);
    if (fusedSignal.aborted) return;
    const eventData = policy.mode === 'normal' ? {
      retryId, turn, step, provider, model, mode: policy.mode, policyKey, retry,
      maxRetries: policy.maxRetries, delayMs, failure,
    } : {
      retryId, turn, step, provider, model, mode: policy.mode, policyKey, retry, delayMs, failure,
    };
    agent.session.append('llm/retry', eventData);
    if (!await cancellableDelay(delayMs, fusedSignal)) return;
    agent.session.append('llm/retry-started', { retryId, turn, step, retry });
    return { kind: 'retry' };
  }

  async function recover({ agent, turn, step, provider, failure, retryPolicy: adapterPolicy, signal: rawSignal }, next) {
    const signal = rawSignal ?? lifetime.signal;
    if (adapterPolicy === undefined || adapterPolicy === null) return next();
    if (signal.aborted || lifetime.signal.aborted) return;
    let model;
    try {
      model = agent?.session?.requestHeader?.()?.config?.model;
    } catch {
      model = undefined;
    }
    model = typeof model === 'string' ? model : '';

    let rule;
    try {
      const groupId = groupIdOf(provider, model);
      const loaded = readRules();
      if (loaded.error !== undefined) {
        ctx.logger?.warn?.(`dsh-model-retry: 规则文件有问题，本次只按可用规则/适配器缺省处理: ${loaded.error}`);
      }
      rule = matchRule(loaded.rules, provider, model, groupId);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-model-retry: 规则文件不可读，按适配器缺省策略执行: ${String(error)}`);
    }
    const policy = policyFor(rule, adapterPolicy);
    const policyKey = retryPolicyKey(policy);

    if (policy.mode === 'always') {
      const fusedSignal = AbortSignal.any([signal, lifetime.signal]);
      const downstream = await settleDownstream(next);
      if (fusedSignal.aborted) return;
      if (downstream.type === 'error') ctx.logger?.warn?.(`dsh-model-retry: always 策略忽略下游恢复失败: ${String(downstream.error)}`);
      if (downstream.type === 'decision' && downstream.decision?.kind === 'retry') return downstream.decision;
    } else {
      // normal：类别码或（规则声明的）状态码命中才算可重试
      const statusListed = Array.isArray(rule?.statusCodes)
        && typeof failure?.status === 'number'
        && rule.statusCodes.includes(failure.status);
      if (!policy.retryableCodes.includes(failure?.code) && !statusListed) return next();
    }

    // 预算：会话日志投影折叠（step/start 与 turn/end 归零），两种模式都计。
    const state = ctx.sessionProjections.stateOf(agent.session, 'llmRetryModel');
    const key = JSON.stringify([provider, model, policyKey]);
    const previous = state[key];
    const previousRetry = previous?.retry ?? 0;
    if (policy.mode === 'normal' && previousRetry >= policy.maxRetries) return next();
    const retry = previousRetry + 1;
    const retryId = previous?.retryId ?? randomUUID();

    let delayMs;
    if (failure?.providerRetryAfterMs !== undefined && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) {
      if (failure.providerRetryAfterMs > policy.backoff.maxDelayMs) {
        if (policy.mode === 'normal') return next();
        delayMs = localDelay(policy.backoff, retry, random);
      } else {
        delayMs = failure.providerRetryAfterMs;
      }
    } else {
      delayMs = localDelay(policy.backoff, retry, random);
    }
    return backoff(agent, turn, step, provider, model, failure, policy, policyKey, retry, retryId, delayMs, signal);
  }

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    // 责任边界：重试执行器的任何自身异常都不允许搞垮用户轮次——
    // 记警告并放弃本次重试决策（等价于官方执行器缺位）。
    return track((async () => {
      try {
        return await recover(payload, next);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-model-retry: 恢复决策异常，本次放弃重试: ${String(error && error.stack || error)}`);
        return undefined;
      }
    })());
  });
  ctx.effect(() => async () => {
    disposeListener();
    lifetime.abort(new Error('dsh-model-retry disposed'));
    await Promise.allSettled([...active]);
  }, 'dsh-model-retry: abort and drain active recovery');

  // ---- rules file + browser API ----

  /**
   * 读取路径的**唯一归一化出口**（本函数永不抛、永不写回文件）。
   *
   *   - 文件不存在            → `{rules: [], warnings: [], error: undefined}`（正常空配置）
   *   - JSON 解析失败 / 不可读 → `{rules: [], …, error}`（文件有问题，必须让用户看见）
   *   - 形状非法（根不是对象 / rules 不是数组）→ `{rules: [], …, error}`
   *   - 非对象条目            → 逐个剔除 + 逐条 warning（第 N 条…）
   *   - 对象条目里的坏字段    → 见 normalizeRuleEntry（摘除/归 normal，语义不变）
   *
   * error 表示「文件有问题，已按空规则集处理、**未写回**」；同一句话同时出现在
   * warnings 里——设置页只渲染 warnings/error 两个通道，而当前客户端忽略
   * error 字段，写进 warnings 才能保证「保存会覆盖原文件」在保存前可见。
   *
   * @returns {{rules: object[], warnings: string[], error: string|undefined}}
   */

  /**
   * 读路径的限值净化：手改文件写进来的越界/非数值字段**不再原样生效**。
   *
   * 写路由（zod）本来就按同一批上限拦；但规则文件是「现读现用」的热配置，
   * 手改一个 `"maxRetries": 5000000`（或 `"abc"`）会让运行时变成无上限重试，
   * 且恢复路径不落任何日志。这里按**同一口径**逐字段检查，坏值直接摘掉
   * （回落到出厂缺省）并在 GET /rules 的 warnings 里说明。
   */
  let suppressedDrops = 0;

  function sanitizeLimits(rule, humanIndex, warnings) {
    const drop = (field, why) => {
      delete rule[field];
      if (warnings.length < MAX_ENTRY_WARNINGS) {
        warnings.push(`第 ${humanIndex} 条规则的 ${field} ${why}，已忽略该字段（回落出厂缺省）。`);
      } else {
        // 告警预算被吃光时**不能静默**：字段照摘，但至少留一个可数的总数
        //（独立验证报出：超过 10 条后一个字都不说）。
        suppressedDrops += 1;
      }
    };
    if (rule.maxRetries !== undefined
      && !(Number.isInteger(rule.maxRetries) && rule.maxRetries >= 0 && rule.maxRetries <= MAX_RETRIES_LIMIT)) {
      drop('maxRetries', `应为 0..${MAX_RETRIES_LIMIT} 的整数（实际 ${JSON.stringify(rule.maxRetries)}）`);
    }
    if (Array.isArray(rule.statusCodes)) {
      const bad = rule.statusCodes.some((code) => !(Number.isInteger(code) && code >= 100 && code <= 599));
      if (bad || rule.statusCodes.length > MAX_STATUS_CODES) drop('statusCodes', '应为 100..599 的整数数组');
    }
    if (Array.isArray(rule.retryableCodes)) {
      const bad = rule.retryableCodes.some((code) => typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_CHARS);
      if (bad || rule.retryableCodes.length > MAX_CODES) drop('retryableCodes', '应为非空字符串数组');
    }
    if (isRuleObject(rule.backoff)) {
      const backoff = { ...rule.backoff };
      let touched = false;
      for (const field of ['initialDelayMs', 'maxDelayMs']) {
        const value = backoff[field];
        if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DELAY_MS)) {
          delete backoff[field]; touched = true;
        }
      }
      if (backoff.jitterRatio !== undefined
        && !(typeof backoff.jitterRatio === 'number' && Number.isFinite(backoff.jitterRatio) && backoff.jitterRatio >= 0 && backoff.jitterRatio <= 1)) {
        delete backoff.jitterRatio; touched = true;
      }
      if (touched) {
        if (Object.keys(backoff).length === 0) {
          delete rule.backoff;
          if (warnings.length < MAX_ENTRY_WARNINGS) warnings.push(`第 ${humanIndex} 条规则的 backoff 全部越界，已忽略整段（回落出厂缺省）。`);
          else suppressedDrops += 1;
        } else {
          rule.backoff = backoff;
          if (warnings.length < MAX_ENTRY_WARNINGS) warnings.push(`第 ${humanIndex} 条规则的 backoff 有越界字段，已逐项摘除。`);
          else suppressedDrops += 1;
        }
      }
    }
    return rule;
  }

  function readRules() {
    suppressedDrops = 0;
    // 同步读取（失败路径上的热配置；文件很小，代价可忽略）。
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(rulesPath(), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { rules: [], warnings: [], error: undefined };
      const detail = error instanceof SyntaxError
        ? `规则文件 JSON 解析失败（${String(error.message)}）`
        : `规则文件读取失败（${String(error?.message ?? error)}）`;
      return brokenRules(detail);
    }
    if (!isRuleObject(parsed)) {
      return brokenRules(`规则文件形状不合法：根应为对象，实际是${entryKindOf(parsed)}`);
    }
    if (!Array.isArray(parsed.rules)) {
      return brokenRules(`规则文件形状不合法：rules 应为数组，实际是${entryKindOf(parsed.rules)}`);
    }
    const rules = [];
    const warnings = [];
    let ignored = 0;
    let reported = 0;
    parsed.rules.forEach((item, index) => {
      if (!isRuleObject(item)) {
        ignored += 1;
        if (reported < MAX_ENTRY_WARNINGS) {
          reported += 1;
          warnings.push(`第 ${index + 1} 条规则不是对象（${entryKindOf(item)}），已忽略。`);
        }
        return;
      }
      rules.push(sanitizeLimits(normalizeRuleEntry(item), index + 1, warnings));
    });
    if (ignored > reported) {
      warnings.push(`另有 ${ignored - reported} 条坏条目被忽略（同类问题不再逐条列出）。`);
    }
    if (suppressedDrops > 0) {
      warnings.push(`另有 ${suppressedDrops} 处越界限值已摘除（告警条数上限 ${MAX_ENTRY_WARNINGS}，不再逐条列出；生效策略已回落出厂缺省）。`);
    }
    return { rules, warnings, error: undefined };
  }

  /**
   * 写入路由的同源守卫（口径冻结）：
   *   - 无 Origin 头 / 空 Origin → 放行（本机 curl、同进程调用；与
   *     dsh-model-groups 一致）；
   *   - `Origin: null` → **外部**来源（file:// 页面、沙箱 iframe、跨源重定向
   *     等浏览器场景都会发这个值）→ 拒绝。注意 dsh-model-groups 的同款守卫
   *     仍放行 `null`，两者口径自此不同，勿互相推断；
   *   - 其余 Origin 必须与 Host 同源。
   */
  const sameOriginOf = (req) => () => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '') return true;
    if (origin === 'null') return false;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  const jsonOf = (res) => (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };

  /**
   * body 层失败的统一出口：**先**完整写出 JSON 响应（带 Content-Type），
   * **再**排空剩余请求体、由 `Connection: close` 收连接。
   * 顺序不可对调：先 `req.destroy()` 会把 socket 连响应一起干掉，客户端只看到
   * ECONNRESET（这正是旧实现「400 body 读取失败或过大」永不发生的原因）。
   */
  const failBody = (req, res, status, message) => {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
      res.end(JSON.stringify({ error: message }));
    } catch { /* 响应已发出：忽略，连接已在收尾 */ }
    // 客户端可能还在写；不发读会让对端写阻塞、响应到不了它手里。
    // 但排空**有界**：持续投喂的客户端能无限占住 socket（requestTimeout 是空闲
    // 计时器，会被不断到达的数据重置，不构成兜底），超预算就断开。
    if (typeof req.resume === 'function') {
      let drained = 0;
      const onDrain = (chunk) => {
        drained += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        if (drained > MAX_BODY_BYTES * 4) {
          req.removeListener('data', onDrain);
          try { req.destroy(); } catch { /* 已断开 */ }
        }
      };
      req.on('data', onDrain);
      req.resume();
    }
  };

  /**
   * 读取请求体文本（UTF-8）。
   *
   * 超过 MAX_BODY_BYTES 字节：回 413 JSON（`body 过大：上限 256 KiB`），
   * 排空并结束连接，**不再调用 onDone**（超长内容不进入业务处理）。
   * 传输层错误：回 400 JSON，同样先写响应再收连接。
   */
  const readTextBody = (req, res, onDone) => {
    // 用 StringDecoder 解码：手工 `text += chunk`（chunk 是 Buffer）会在跨 TCP 分块的
    // 多字节字符处插入 U+FFFD。字节计数改成对解码后的字符串折算（只会略微少算，
    // 不会超算，上限仍然是紧的）。
    if (typeof req.setEncoding === 'function') req.setEncoding('utf8');
    let text = '';
    let bytes = 0;
    let done = false;
    const onData = (chunk) => {
      if (done) return;
      // 按 UTF-8 字节计（Buffer 直接取 length，字符串按字节折算），
      // 逐块累加而不重复测量整串，避免大 body 下的二次复杂度。
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      text += chunk;
      if (bytes <= MAX_BODY_BYTES) return;
      done = true;
      text = '';
      req.removeListener('data', onData);
      failBody(req, res, 413, `body 过大：上限 ${MAX_BODY_BYTES} 字节（256 KiB）`);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (done) return;
      done = true;
      onDone(text);
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      failBody(req, res, 400, 'body 读取失败');
    });
  };

  /** GET/HEAD 的响应体：规则 + 出厂缺省 + 分组目录 + 读取/分组全部告警。 */
  function rulesPayload() {
    const loaded = readRules();
    const groups = groupCatalog(loaded.rules);
    return {
      rules: loaded.rules,
      error: loaded.error,
      build: BUILD,
      defaults: factoryDefaults(),
      knownCodes: [...KNOWN_CODES],
      groups: groups.groups,
      groupsAvailable: groups.available,
      // 读取告警（坏条目 / 文件形状非法）排在分组告警之前：前者更要紧。
      warnings: [...loaded.warnings, ...groups.warnings],
    };
  }

  /** POST 归一化：通配符统一为 '*'；去掉重复项；group 为空/`*` 时整字段丢弃。 */
  function normalizePostedRules(rows) {
    return rows.map((rule) => {
      const group = groupSelectorOf(rule.group);
      return {
        provider: normPattern(rule.provider),
        model: normPattern(rule.model),
        ...(group === null ? {} : { group }),
        mode: rule.mode,
        ...(rule.mode === 'normal' ? {
          ...(rule.maxRetries === undefined ? {} : { maxRetries: rule.maxRetries }),
          ...(rule.retryableCodes === undefined ? {} : { retryableCodes: [...new Set(rule.retryableCodes)] }),
          ...(rule.statusCodes === undefined ? {} : { statusCodes: [...new Set(rule.statusCodes)].sort((a, b) => a - b) }),
        } : {}),
        ...(rule.backoff === undefined ? {} : { backoff: rule.backoff }),
      };
    });
  }

  function handleRulesRequest(req, res, json) {
    if (req.method === 'GET' || req.method === 'HEAD') return json(200, rulesPayload());
    if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!sameOriginOf(req)()) return json(403, { error: 'cross-origin request rejected' });
    readTextBody(req, res, (text) => {
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return json(400, { error: 'body 不是合法 JSON' });
      }
      const parsed = rulesSchema.safeParse(body);
      if (!parsed.success) {
        return json(400, { error: '规则校验失败: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      }
      const rules = normalizePostedRules(parsed.data.rules);
      const groups = groupCatalog(rules);
      return atomicWriteJson(rulesPath(), { rules })
        .then(() => json(200, { ok: true, rules, warnings: groups.warnings }))
        .catch((e) => json(500, { error: '规则写入失败: ' + String(e?.message ?? e) }));
    });
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RULES_ROUTE,
    handler: (req, res) => {
      const json = jsonOf(res);
      try {
        return handleRulesRequest(req, res, json);
      } catch (error) {
        // 兜底：任何意外异常也必须以 JSON 作答——空响应 / 无 Content-Type 的
        // 400 会让设置页解析失败并永久停在「加载中…」，且没有恢复入口。
        if (res.headersSent === true) return undefined;
        return json(500, { error: `规则路由内部错误: ${String(error && error.message || error)}` });
      }
    },
  }), 'dsh-model-retry: rules route');

  // ---- 只读试算（设置页「试算」；用真实匹配逻辑，避免前端复刻打分规则）----
  function handlePreviewRequest(req, res, json) {
    if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!sameOriginOf(req)()) return json(403, { error: 'cross-origin request rejected' });
    readTextBody(req, res, (text) => {
      let body = {};
      if (text !== '') {
        try {
          body = JSON.parse(text);
        } catch {
          return json(400, { error: 'body 不是合法 JSON' });
        }
      }
      const provider = typeof body.provider === 'string' ? body.provider : '';
      const model = typeof body.model === 'string' ? body.model : '';
      if (provider === '' && model === '') return json(400, { error: '需要 provider 与 model' });
      // 与 GET /rules 同一条读取路径：坏条目已在 readRules 出口剔除，
      // 故打分/匹配只见过对象（规则文件坏掉时试算照常给结果 + error）。
      const loaded = readRules();
      const rules = loaded.rules;
      const error = loaded.error;
      const service = groupService();
      const groupId = groupIdOf(provider, model);
      let groupName = null;
      if (groupId !== null && service !== undefined && typeof service.list === 'function') {
        try {
          const found = service.list().find((group) => group.id === groupId);
          if (found !== undefined) groupName = found.name;
        } catch { /* 名称拿不到不影响试算 */ }
      }
      const scored = rules.map((rule, index) => ({ index, score: scoreOf(rule, provider, model, groupId), rule }));
      const winner = matchRule(rules, provider, model, groupId);
      const winnerIndex = winner === null ? -1 : rules.indexOf(winner);
      const policy = winner === null ? factoryDefaults() : policyFor(winner, undefined);
      return json(200, {
        ok: true,
        provider,
        model,
        error,
        groupsAvailable: service !== undefined,
        groupId,
        groupName,
        ruleIndex: winnerIndex,
        rule: winner === null ? null : winner,
        policy,
        source: winner === null ? 'adapter-default' : 'rule',
        scores: scored,
      });
    });
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREVIEW_ROUTE,
    handler: (req, res) => {
      const json = jsonOf(res);
      try {
        return handlePreviewRequest(req, res, json);
      } catch (error) {
        if (res.headersSent === true) return undefined;
        return json(500, { error: `试算路由内部错误: ${String(error && error.message || error)}` });
      }
    },
  }), 'dsh-model-retry: preview route');
}

function normPattern(value) {
  if (typeof value !== 'string' || value === '' || value.trim() === '' || value.trim() === '*') return '*';
  return value.trim();
}

/**
 * 「文件有问题」的统一返回：空规则集 + error，并把同一句话放进 warnings。
 * 关键在**明说未写回**：设置页拿到空规则集后一旦自动保存，就会把用户的坏文件
 * 覆盖成空规则集——旧实现静默返回空集，用户既看不到错误也无从恢复。
 */
function brokenRules(detail) {
  const text = `${detail}：已按空规则集处理，规则文件未被改写；`
    + `在本页保存会用这组空规则覆盖原文件，请先手工修好 ${rulesPath()}。`;
  return { rules: [], warnings: [text], error: text };
}

async function atomicWriteJson(path, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  const tmp = path + '.tmp-' + randomUUID();
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}
