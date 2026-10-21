/**
 * 消息分支（dsh-message-branches）— host 半边静态插件（entry-v4）。
 *
 * ── v4 是一次语义重写：分支不再创建会话 ────────────────────────────────────
 * v1–v3 把「分支」实现为**真会话分叉**（出厂 session.fork：observeSession +
 * agents.create 带 seed，侧栏里会多出一条子会话记录）。用户明确要求：
 * **分支不应该创建新的会话记录**。于是 v4 把分支降维成——
 *
 *   分支 ＝ 我发出的某一条消息的多个**版本**（variants）
 *   · 第 1 个分支永远是日志原文（append-only，谁也改不了它）；
 *   · 第 2..N 个分支是用户改写的版本，只存在于本插件自己的账本里；
 *   · 每条消息带一个**粘性**的「当前分支序号」，渲染时按它决定显示哪一版。
 *
 * 因此 v4 **不建会话、不写会话日志、不 prompt、不回退文件**：
 *   · 没有 session.fork / agents.create（一个会话记录都不新增）；
 *   · 没有 tools/pre-execute、tools/post-execute 记账钩子（没有「被丢弃的
 *     后文」，也就没有需要退回的文件修改——journal/blobs/trash/receipts
 *     整套机制连同路由一起删除）；
 *   · 会话日志是唯一的事实来源，插件只在上层做**显示层的分支切换**。
 *
 * 为什么「改写后不重新生成回复」：不建新会话就没有第二条日志，助手回复只能
 * 追加到当前会话尾巴——而日志是 append-only 的，模型看到的仍是原文+旧后文，
 * 改写版根本进不了模型上下文（硬做只会得到「答非所问」）。要「从这里重新
 * 问」，请用户直接发下一条消息；分支在这里的定位是**同一句话的多个说法**。
 *
 * ── 数据（$DSH_HOME/message-branches/groups.json，version 2）────────────────
 *   groups: {
 *     "<sessionId>": {
 *       id, rootSessionId, createdAt, updatedAt,
 *       messages: {
 *         "<seq>": {
 *           seq, createdAt, updatedAt,
 *           selected: 0,                       // 0 = 日志原文；1..N = 第几个改写版
 *           variants: [ { id, kind:'edit', text, label, createdAt } ]
 *         }
 *       }
 *     }
 *   }
 * 兼容：v1 的 `branches` / `selectedSessionId` 等字段**原样保留**（读入不解释、
 * 写回不删除）——dsh-ultracode 的家族谱系把 groups.json 当只读旁证，删掉字段
 * 会让历史上那条空白分支突然「没有父亲」。本版本自己只写 messages。
 *
 * ── 路由（同源守卫；sessionId 由浏览器半边显式携带）────────────────────────
 *   GET  /dsh-branches/status          ?sessionId=…   插件/会话/分支总览
 *   GET  /dsh-branches/client                     浏览器半边是否组进启动图
 *   GET  /dsh-branches/state           ?sessionId=…   该会话的全部分支集
 *   POST /dsh-branches/branch          {sessionId, seq, text}   新建一个分支版本
 *   POST /dsh-branches/select          {sessionId, seq, index}  显式切换（粘性）
 *
 * ── 组合行（cordis.patch.yml）──────────────────────────────────────────────
 *   - insert:
 *       - id: message-branches
 *         name: ./plugins/dsh-message-branches/entry-v4.js
 *         config: {}                    // 见 DEFAULTS
 *
 * 维护：loader 按 specifier 缓存模块，改 host 实现要写 entry-v<N+1>.js 并把
 * 上面 name 指过去（**保持同一行 id**）。client.js 由 dsh-client-hmr 每 500ms
 * stat-poll 就地热换，刷新页面即见。
 *
 * 自测（纯 node、无副作用，末行 SELFTEST PASS 才算过）：
 *   node plugins/dsh-message-branches/selftest.mjs          # host：账本 + 路由
 *   node plugins/dsh-message-branches/client-selftest.mjs   # 浏览器半边行为
 *
 * @module dsh-message-branches
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const name = 'dsh-message-branches';
export const VERSION = 4;
export const ROUTE_PREFIX = '/dsh-branches';

const DEFAULTS = Object.freeze({
  stateDir: '',
  maxEditedTextChars: 20000,
  bodyLimit: 256 * 1024,
  registerRetries: 40,
  registerRetryMs: 120,
});

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const errorText = (error) => String(error && error.message !== undefined ? error.message : error);
const clampInt = (raw, min, max, fallback) => {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
};

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/** $DSH_HOME（本部署 = /home/xray4668/.dsh）。 */
export function dshHomeDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
  return resolve(expandHome(home));
}

/** 缺省状态根：$DSH_HOME/message-branches。 */
export function defaultStateDir() {
  return join(dshHomeDir(), 'message-branches');
}

export function resolveConfig(raw) {
  if (raw !== undefined && raw !== null && !isRecord(raw)) throw new Error('dsh-message-branches: config 必须是对象');
  const input = { ...(raw ?? {}) };
  for (const key of Object.keys(input)) if (!(key in DEFAULTS)) throw new Error(`dsh-message-branches: 未知配置项 "${key}"`);
  const merged = { ...DEFAULTS, ...input };
  return Object.freeze({
    stateDir: typeof merged.stateDir === 'string' && merged.stateDir !== '' ? resolve(expandHome(merged.stateDir)) : defaultStateDir(),
    maxEditedTextChars: clampInt(merged.maxEditedTextChars, 200, 1024 * 1024, DEFAULTS.maxEditedTextChars),
    bodyLimit: clampInt(merged.bodyLimit, 4096, 16 * 1024 * 1024, DEFAULTS.bodyLimit),
    registerRetries: clampInt(merged.registerRetries, 0, 400, DEFAULTS.registerRetries),
    registerRetryMs: clampInt(merged.registerRetryMs, 10, 5000, DEFAULTS.registerRetryMs),
  });
}

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(file, value) {
  ensureDir(dirname(file));
  // tmp 名带 pid：两个进程同时写同一本账时不互相踩（v3 对大文件就是这么做的）。
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

function readJsonFile(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 首行预览（分支清单/未来总览用）；永远不带换行。 */
export function firstLine(text, max) {
  const line = String(text ?? '').split('\n').find((item) => item.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/* ── 存储：按会话 → 按消息 seq 的分支版本集 ─────────────────────────────── */

/**
 * 读盘时把一个消息条目洗干净。
 *
 * 口径：seq 必须是有限非负整数；variants 只留「有字符串 text」的记录；
 * selected 夹回 [0, variants.length]（0 = 原文）。坏数据一律降级，
 * 绝不因为一条脏记录让整个会话的分支都读不出来。
 */
export function sanitizeMessageSet(raw) {
  if (!isRecord(raw)) return null;
  const seq = Number(raw.seq);
  if (!Number.isInteger(seq) || seq < 0) return null;
  const variants = [];
  for (const item of Array.isArray(raw.variants) ? raw.variants : []) {
    if (!isRecord(item) || typeof item.text !== 'string') continue;
    // 未知字段原样透传（未来版本多带的键不被静默抹掉）；kind 只兜底不改写。
    variants.push({
      ...item,
      id: typeof item.id === 'string' && item.id !== '' ? item.id : `legacy-${variants.length + 1}`,
      kind: typeof item.kind === 'string' && item.kind !== '' ? item.kind : 'edit',
      label: typeof item.label === 'string' && item.label !== '' ? item.label : firstLine(item.text, 24),
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0,
    });
  }
  return {
    seq,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    selected: clampInt(raw.selected, 0, variants.length, 0),
    variants,
  };
}

/** 对外视图：total = 1（原文）+ variants.length；selected ∈ [0, total-1]。 */
export function viewMessageSet(entry) {
  if (entry === null || entry === undefined) return null;
  return {
    seq: entry.seq,
    total: entry.variants.length + 1,
    selected: entry.selected,
    variants: entry.variants.map((variant) => ({
      id: variant.id,
      kind: variant.kind,
      label: variant.label,
      preview: firstLine(variant.text, 80),
      chars: variant.text.length,
      text: variant.text,
      createdAt: variant.createdAt,
    })),
  };
}

export function createStore(root, onError = () => {}) {
  const groupsFile = join(root, 'groups.json');

  const emptyGroup = (sessionId) => ({
    id: sessionId,
    rootSessionId: sessionId,
    createdAt: Date.now(),
    updatedAt: 0,
    messages: {},
  });

  /**
   * 读盘。三种失败必须分开对待（混为一谈就会毁数据）：
   *   · 文件不存在            → 空表（首次使用的正常状态）；
   *   · JSON 坏行 / 形状不符   → 抛 `parseFailed` / `shapeFailed`：调用方备份后重写；
   *   · 其它 I/O 错（权限/占用/IO）→ 抛 `readFailed`：**文件可能完全好，只是此刻
   *     读不到**——调用方必须放弃本次写、绝不动文件（好账不能被当坏账备份掉）。
   */
  const readGroupsFile = () => {
    const table = new Map();
    if (!existsSync(groupsFile)) return table;
    let text;
    try {
      text = readFileSync(groupsFile, 'utf8');
    } catch (error) {
      error.readFailed = true;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      error.parseFailed = true;
      throw error;
    }
    // 存在但形状不符（含空文件、groups 不是对象）一律抛：让调用方走「备份后重写」，
    // 绝不静默按空表服务——那会把一本只是长得不一样的好账直接抹掉。
    if (!isRecord(parsed) || !isRecord(parsed.groups)) {
      const error = new Error(`groups.json 形状不符（拒绝按空表覆盖）：${groupsFile}`);
      error.shapeFailed = true;
      throw error;
    }
    for (const [id, group] of Object.entries(parsed.groups)) {
      if (!isRecord(group)) continue;
      // 展开保留一切未知字段（v1 的 branches/selectedSessionId 就在这里原样存活）。
      const messages = {};
      for (const [seq, entry] of Object.entries(isRecord(group.messages) ? group.messages : {})) {
        const clean = sanitizeMessageSet({ ...entry, seq: entry?.seq ?? seq });
        if (clean !== null) messages[String(clean.seq)] = clean;
      }
      table.set(id, { ...emptyGroup(id), ...group, id, messages });
    }
    return table;
  };

  const groups = new Map();
  try {
    for (const [id, group] of readGroupsFile()) groups.set(id, group);
  } catch (error) {
    onError(error);
  }

  /**
   * 磁盘条目合并进内存条目：**按变体 id 求并集**（同 id 内存赢），selected 以内存
   * 为准、updatedAt 取较新，磁盘上多出来的未知字段照样保留。两个进程共用
   * $DSH_HOME 时，各写各的消息、各建各的变体，都不会再把对方抹掉。
   */
  const mergeEntry = (memory, disk) => {
    if (disk === undefined) return memory;
    const variants = [...(Array.isArray(disk.variants) ? disk.variants : [])];
    for (const variant of memory.variants) {
      const at = variants.findIndex((item) => item.id === variant.id);
      if (at >= 0) variants[at] = variant;
      else variants.push(variant);
    }
    return {
      ...disk,
      ...memory,
      variants,
      updatedAt: Math.max(memory.updatedAt ?? 0, disk.updatedAt ?? 0),
    };
  };

  const mergeGroup = (memory, disk) => {
    if (disk === undefined) return memory;
    const messages = { ...(isRecord(disk.messages) ? disk.messages : {}) };
    for (const [key, entry] of Object.entries(memory.messages ?? {})) {
      messages[key] = mergeEntry(entry, messages[key]);
    }
    return { ...disk, ...memory, messages };
  };

  /**
   * 落盘。返回**是否真的写成功**——失败时调用方必须回滚内存改动并让上层报错，
   * 绝不「界面说建好了、盘上什么都没有」。读不动的文件不备份、不重写。
   */
  const persistGroups = () => {
    try {
      ensureDir(root);
      // 合并结果先进**临时表**：只有落盘成功才并回内存。写失败时 groups 原封不动，
      // 调用方的「回滚内存改动」因此一定落在真实的那几个对象上。
      const merged = new Map(groups);
      try {
        for (const [id, group] of readGroupsFile()) {
          const mine = merged.get(id);
          merged.set(id, mine === undefined ? group : mergeGroup(mine, group));
        }
      } catch (error) {
        if (error?.readFailed === true) {
          // 读不到（权限/占用/IO）：文件可能完全好。放弃本次写，一个字节都不动。
          onError(error);
          return false;
        }
        // JSON 坏行 / 形状不符：先留证（带随机后缀，避免同毫秒互踩）再按内存表整表重写。
        try {
          renameSync(groupsFile, `${groupsFile}.corrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        } catch {
          /* 已经没了/改名失败：照旧重写 */
        }
        onError(error);
      }
      atomicWriteJson(groupsFile, { version: 2, groups: Object.fromEntries(merged) });
      for (const [id, group] of merged) groups.set(id, group);
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  };

  const groupFor = (sessionId) => {
    const group = groups.get(sessionId);
    return group ?? null;
  };

  /** 置灰并落盘；返回是否写成功（false 时调用方负责回滚内存改动）。 */
  const touch = (group) => {
    group.updatedAt = Date.now();
    groups.set(group.id, group);
    return persistGroups();
  };

  return {
    root,
    groupsFile,
    readJsonFile: (file, fallback) => readJsonFile(file, fallback),
    atomicWriteJson,
    groupForSession: (sessionId) => groupFor(sessionId),
    getGroup: (id) => groups.get(id) ?? null,
    listGroups: () => [...groups.values()],
    /** 某条消息的分支集视图（没有分支时返回 null——调用方据此不渲染导航条）。 */
    messageSet(sessionId, seq) {
      const group = groupFor(sessionId);
      const entry = group === null ? undefined : group.messages[String(seq)];
      return entry === undefined ? null : viewMessageSet(entry);
    },
    /**
     * 新建一个分支版本并**切到它**（显式动作：刚写的那版就是当前版）。
     * 幂等保护：文本与某个既有版本完全相同时不重复造，只把选择移过去。
     * 写盘失败时回滚内存改动并抛出——上层路由据此回 5xx，绝不假成功。
     */
    addVariant(sessionId, seq, text, maxChars) {
      if (typeof sessionId !== 'string' || sessionId === '') throw new Error('需要 sessionId');
      if (!Number.isInteger(seq) || seq < 0) throw new Error('seq 必须是非负整数');
      if (typeof text !== 'string' || text.trim() === '') throw new Error('分支文本不能为空');
      const limit = Number.isFinite(maxChars) ? maxChars : DEFAULTS.maxEditedTextChars;
      if (text.length > limit) throw new Error(`分支文本过长（上限 ${limit} 字符）`);
      const hadGroup = groups.has(sessionId);
      const group = groups.get(sessionId) ?? emptyGroup(sessionId);
      const key = String(seq);
      const previous = group.messages[key];
      const entry = previous ?? { seq, createdAt: Date.now(), updatedAt: 0, selected: 0, variants: [] };
      const at = entry.variants.findIndex((variant) => variant.text === text);
      if (at >= 0) {
        entry.selected = at + 1;
      } else {
        entry.variants.push({
          id: randomUUID(),
          kind: 'edit',
          text,
          label: firstLine(text, 24),
          createdAt: Date.now(),
        });
        entry.selected = entry.variants.length;
      }
      entry.updatedAt = Date.now();
      group.messages[key] = entry;
      if (!touch(group)) {
        // 落盘失败：内存改回原样（连「这个会话本来没有组」也一并还原），然后抛。
        if (previous === undefined) delete group.messages[key];
        else group.messages[key] = previous;
        if (!hadGroup) groups.delete(group.id);
        const error = new Error('分支账本写入失败（未做任何改动）');
        error.code = 'STORE_WRITE_FAILED';
        throw error;
      }
      return viewMessageSet(group.messages[key]);
    },
    /** 粘性切换：只由显式动作调用，绝不按「最新分支」推导。 */
    selectVariant(sessionId, seq, index) {
      const group = groupFor(sessionId);
      if (group === null) throw new Error(`会话没有分支：${sessionId}`);
      const entry = group.messages[String(seq)];
      if (entry === undefined) throw new Error(`该消息没有分支：seq ${seq}`);
      if (!Number.isInteger(index) || index < 0 || index > entry.variants.length) {
        throw new Error(`分支序号越界：${index}（共 ${entry.variants.length + 1} 个分支）`);
      }
      const previousSelected = entry.selected;
      const previousUpdatedAt = entry.updatedAt;
      entry.selected = index;
      entry.updatedAt = Date.now();
      if (!touch(group)) {
        entry.selected = previousSelected;
        entry.updatedAt = previousUpdatedAt;
        const error = new Error('分支账本写入失败（未做任何改动）');
        error.code = 'STORE_WRITE_FAILED';
        throw error;
      }
      return viewMessageSet(entry);
    },
  };
}

/** 组视图（/status 与 /state 共用）：只外传 messages，活对象不外泄。 */
export function viewGroup(group) {
  if (group === null || group === undefined) return null;
  const messages = {};
  for (const [key, entry] of Object.entries(group.messages ?? {})) {
    messages[key] = viewMessageSet(entry);
  }
  return {
    id: group.id,
    rootSessionId: group.rootSessionId,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    messages,
  };
}

/* ── HTTP 小工具（与 v3 同一套：同源守卫 + 原子读 + 重试注册） ───────────── */

function json(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readBody(req, limit) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectBody(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const error = new Error('body 过大');
        error.code = 'BODY_TOO_LARGE';
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('request aborted')));
  });
}

/**
 * 浏览器半边的组装状态（只读叶子字段，不外传活对象）。
 *
 * dsh-client-modules 扫 loader 条目上声明了 `dsh.client` 的包，把 client.js 编成
 * 启动图里的一行；`/plugins/??<id>/client.js&rev=<rev>` 才是它真正服务的 URL。
 * 本函数是维护窗口：composed=false 或 url=null 就说明刷新浏览器也看不到控件。
 */
export function clientHalfStatus(ctx) {
  const modules = ctx.get('clientModules');
  if (modules === undefined || modules === null) {
    return { available: false, hint: 'clientModules 服务未挂载（此部署可能没有 Web 前端）' };
  }
  try {
    const graph = typeof modules.graph === 'function' ? modules.graph() : undefined;
    const rows = Array.isArray(graph?.entries) ? graph.entries : [];
    const row = rows.find((item) => isRecord(item) && item.id === name);
    return {
      available: true,
      packageName: name,
      composed: row !== undefined,
      graphRev: typeof graph?.rev === 'string' ? graph.rev : null,
      entryRev: isRecord(row) && typeof row.rev === 'string' ? row.rev : null,
      bundleUrl: isRecord(row) && typeof row.url === 'string' ? row.url : null,
      clientPath: typeof modules.clientPath === 'function' ? (modules.clientPath(name) ?? null) : null,
      hint: row === undefined
        ? 'client.js 未进启动图：确认 package.json 里有 dsh.client 声明，并刷新一次浏览器'
        : '已组装：刷新浏览器即可看到控件（client.js 内容改动会被 dsh-client-hmr 就地热换）',
    };
  } catch (error) {
    return { available: true, error: error instanceof Error ? error.message : String(error) };
  }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const store = createStore(config.stateDir, (error) => ctx.logger?.warn?.(`message-branches: 状态读写失败：${errorText(error)}`));

  const routes = {
    status: `${ROUTE_PREFIX}/status`,
    client: `${ROUTE_PREFIX}/client`,
    state: `${ROUTE_PREFIX}/state`,
    branch: `${ROUTE_PREFIX}/branch`,
    select: `${ROUTE_PREFIX}/select`,
  };

  const registerRoute = (label, path, handler) => ctx.effect(() => {
    let disposed = false;
    let unregister = null;
    let timer = null;
    const attempt = (remaining) => {
      if (disposed) return;
      try {
        unregister = ctx.webServer.register({ kind: 'exact', path, handler });
      } catch (error) {
        if (remaining > 0 && /duplicate .*route/i.test(errorText(error))) {
          timer = setTimeout(() => attempt(remaining - 1), config.registerRetryMs);
          return;
        }
        ctx.logger?.warn?.(`message-branches: 路由 ${path} 注册失败：${errorText(error)}`);
      }
    };
    attempt(config.registerRetries);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      if (unregister !== null) unregister();
    };
  }, label);

  const requireGet = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'Method Not Allowed' });
      return false;
    }
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'cross-origin request rejected' });
      return false;
    }
    return true;
  };

  const requirePost = (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'Method Not Allowed' });
      return false;
    }
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'cross-origin request rejected' });
      return false;
    }
    return true;
  };

  const searchParams = (req, path) => new URL(req.url ?? path, 'http://localhost').searchParams;

  const withJson = (req, res, run) => {
    readBody(req, config.bodyLimit).then(async (text) => {
      let args = {};
      if (text.trim() !== '') {
        try {
          args = JSON.parse(text);
        } catch {
          json(res, 400, { error: 'body 不是合法 JSON' });
          return;
        }
      }
      try {
        json(res, 200, await run(isRecord(args) ? args : {}));
      } catch (error) {
        // 账本写不进去是**服务端**故障：回 500，别让客户端以为是自己参数错。
        json(res, isRecord(error) && error.code === 'STORE_WRITE_FAILED' ? 500 : 400, { error: errorText(error) });
      }
    }).catch((error) => {
      const tooLarge = isRecord(error) && error.code === 'BODY_TOO_LARGE';
      json(res, tooLarge ? 413 : 400, { error: tooLarge ? `body 过大（上限 ${config.bodyLimit} 字节）` : 'body 读取失败' });
    });
  };

  /** 会话参数解析：GET 走查询串，POST 走 body。 */
  const sessionOf = (args, params) => {
    const raw = params !== undefined ? params.get('sessionId') : args.sessionId;
    return typeof raw === 'string' ? raw : '';
  };

  registerRoute('message-branches: status', routes.status, (req, res) => {
    if (!requireGet(req, res)) return;
    const sessionId = searchParams(req, routes.status).get('sessionId') ?? '';
    if (sessionId === '') {
      json(res, 400, { error: '需要 sessionId 查询参数' });
      return;
    }
    json(res, 200, {
      plugin: name,
      version: VERSION,
      sessionId,
      live: ctx.get('sessions')?.get(sessionId) !== undefined,
      group: viewGroup(store.groupForSession(sessionId)),
      stateDir: store.root,
      config: { maxEditedTextChars: config.maxEditedTextChars },
      routes: Object.keys(routes),
      client: clientHalfStatus(ctx),
    });
  });

  // 维护用：浏览器半边（client.js）到底有没有被 dsh-client-modules 组进启动图。
  // client.js 不像 host 半边走模块缓存，它由 dsh-client-hmr stat-poll 就地热换，
  // 但**新增 dsh.client 声明**必须让浏览器重新拉一次启动图，否则页面上啥也不出现。
  registerRoute('message-branches: client', routes.client, (req, res) => {
    if (!requireGet(req, res)) return;
    json(res, 200, clientHalfStatus(ctx));
  });

  registerRoute('message-branches: state', routes.state, (req, res) => {
    if (!requireGet(req, res)) return;
    const sessionId = searchParams(req, routes.state).get('sessionId') ?? '';
    if (sessionId === '') {
      json(res, 400, { error: '需要 sessionId 查询参数' });
      return;
    }
    json(res, 200, { sessionId, group: viewGroup(store.groupForSession(sessionId)) });
  });

  registerRoute('message-branches: branch', routes.branch, (req, res) => {
    if (!requirePost(req, res)) return;
    withJson(req, res, (args) => {
      const sessionId = sessionOf(args);
      if (sessionId === '') throw new Error('需要 sessionId');
      const seq = Number(args.seq);
      if (!Number.isInteger(seq) || seq < 0) throw new Error('seq 必须是非负整数');
      const message = store.addVariant(sessionId, seq, typeof args.text === 'string' ? args.text : '', config.maxEditedTextChars);
      return {
        sessionId,
        seq,
        message,
        group: viewGroup(store.getGroup(sessionId)),
      };
    });
  });

  registerRoute('message-branches: select', routes.select, (req, res) => {
    if (!requirePost(req, res)) return;
    withJson(req, res, (args) => {
      const sessionId = sessionOf(args);
      if (sessionId === '') throw new Error('需要 sessionId');
      const seq = Number(args.seq);
      if (!Number.isInteger(seq) || seq < 0) throw new Error('seq 必须是非负整数');
      const message = store.selectVariant(sessionId, seq, Number(args.index));
      return {
        sessionId,
        seq,
        message,
        group: viewGroup(store.getGroup(sessionId)),
      };
    });
  });

  ctx.logger?.info?.(`message-branches: 就绪（v${VERSION}，状态根 ${config.stateDir}，路由 ${Object.values(routes).length} 条；分支＝消息版本，不建会话）`);
}

export default { name, inject: ['webServer'], apply };
