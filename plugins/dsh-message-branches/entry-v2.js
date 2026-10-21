/**
 * 消息分支（dsh-message-branches）— host 半边静态插件（entry-v2）。
 *
 * v2 相对 v1 的增量：**shell 命令的文件副作用不再只是「一句警告」**。
 * bash/pwsh 在出厂里完全不进文件层（不发 fs 事件、不经过 ctx.fs），任何钩子都拿不到
 * before 镜像；但「哪些文件被动过」是可以量出来的：对**看起来会写盘**的命令
 * （重定向 / heredoc / tee / cp / mv / rm / sed -i / git apply…）执行前后各扫一次会话
 * cwd 的清单（路径 + size + mtime，跳过 .git/node_modules/output 等重目录，有文件数与
 * 时间预算上限），差分出 added / modified / removed：
 *   · added    → 记账成「创建」，回退时**精确移入隔离区**（这条最值钱：agent 用
 *                heredoc 写新文件是常态，v1 对这种情况只能干看着）；
 *   · modified → 记账成「改动但无 before 镜像」，回退计划里如实列为人工项（附具体
 *                路径，比只报「跑过 5 条 shell 命令」有用得多）；
 *   · removed  → 记账成「删除」，同样列人工项。
 * 扫描只在启发式判定的写盘命令上触发（读类命令零开销），可配置关掉
 * （`shellScan: false` 即退回 v1 行为）。
 *
 * 解决什么：**改一条已经发出去的消息，并把「后文」整体转进一条新分支**，两条分支
 * 之间可来回切换，且选择是持久的——切出去以后不会被自动切回新分支。
 *
 * ── 为什么是「真会话分叉」而不是在日志里做覆盖 ───────────────────────────────
 * 会话日志是 append-only，模型可见面由 surface（surfaceOp:replace）折叠而成，但
 * **浏览器里的对话转录只认 append-origin 事件**（dsh-session/types/surface.d.ts：
 * 出厂只把 compact 源的替换渲染成检查点）。也就是说：用 surfaceOp 改写历史，
 * 模型看得见、用户看不见，而且 shadowed 节点**不可再次引用**，切回旧支还得重新
 * 物化一整串副本。出厂已经有更干净的机制——`session.fork({sessionId, atSeq})`：
 * 取源会话一个稳定前缀造一条子会话（`meta.parentSession` + `isSeeded`，侧栏会把它
 * 嵌在源会话下面）。所以本插件把「分支」实现为**真子会话**：
 *
 *   新分支 = [目标消息所在回合之前的完整前缀] + [改后的消息作为子会话首条 prompt]
 *   旧分支 = 原会话原样保留（含被「丢弃」的后文）
 *
 * 交付给模型的前缀是**逐字节的日志副本**（出厂 fork 语义），所以上下文是真的；
 * 用户在两条会话之间切换，就是出厂意义上的切换会话。
 *
 * ── 工作区回退（用户明确要求）─────────────────────────────────────────────
 * 分叉会丢掉目标消息之后的全部回合，这些回合造成的**文件修改**必须一起退回分叉点。
 * 本插件在 host 侧维护一份**变更账本（journal）**：
 *   · `tools/pre-execute`（prepend）在工具落地前抓 before 快照；
 *   · `tools/post-execute`（prepend）抓 after 快照，并把 `write`/`edit` 工具返回值里
 *     自带的 before/after 全文作为权威来源交叉校验；
 *   · `bash` / `pwsh` **没有任何文件级钩子**（出厂 dsh-shell / dsh-bash-local 不发事件），
 *     只能记命令原文当证据，回退时如实标注「副作用无法精确回退」。
 *
 * 回退规则（安全第一）：
 *   ① 只回退 journal 里能证明「尾巴期间改过」的路径；
 *   ② 恢复前校验当前内容哈希 == 账本里的 after 哈希，**不一致就改成隔离处置**，
 *      绝不覆盖用户后来手改的内容；
 *   ③ 尾巴期间**新建**的文件一律**移入隔离区**（trash），不硬删（AGENTS.md 硬闸）；
 *   ④ 每一步都写 receipt，`/rollback/undo` 可按 receipt 逐步还原（放进隔离区的能取回）。
 *   ⑤ 无法证明的（shell 副作用、跨根目录、后台任务、子代理写入）只列证据，不猜。
 *
 * ── 数据（全部在 $DSH_HOME 下，插件自持；出厂没有「按会话写元数据」的接口）──────
 *   <stateDir>/groups.json           分支组（rootSessionId → 分支列表 + 粘性选择）
 *   <stateDir>/journal/<sid>.jsonl   逐条变更（追加写）
 *   <stateDir>/blobs/<aa>/<sha256>   内容寻址快照
 *   <stateDir>/trash/<receipt>/…     隔离区（新建文件的回退落点）
 *   <stateDir>/receipts/<id>.json    回退回执（可撤销）
 *
 * ── 路由（同源守卫；sessionId 由浏览器半边显式携带）────────────────────────
 *   GET  /dsh-branches/status          ?sessionId=…   插件/会话/分支组总览
 *   GET  /dsh-branches/targets         ?sessionId=…   可编辑的消息（回合起点）+ cwd
 *   GET  /dsh-branches/state           ?sessionId=…   该会话所属分支组
 *   POST /dsh-branches/register        {parentSessionId, childSessionId, editSeq, cutSeq, …}
 *   POST /dsh-branches/select          {sessionId, branchSessionId}  显式切换（粘性）
 *   POST /dsh-branches/label           {sessionId, branchSessionId, label}
 *   POST /dsh-branches/rollback/plan   {sessionId, cutSeq}
 *   POST /dsh-branches/rollback/apply  {sessionId, cutSeq}
 *   POST /dsh-branches/rollback/undo   {receiptId}
 *
 * ── 组合行（cordis.patch.yml）──────────────────────────────────────────────
 *   - insert:
 *       - id: message-branches
 *         name: ./plugins/dsh-message-branches/entry-v1.js   # 换实现＝换 entry-v<N+1>.js
 *         config: {}                                          # 见 DEFAULTS
 *
 * 维护：本 profile 未开模块热载，loader 按 specifier 缓存模块——改实现要写新的
 * entry 文件并把上面 name 指过去（**保持同一行 id**）。client.js 由 dsh-client-hmr
 * 每 500ms stat-poll，就地热换，刷新页面即见。
 *
 * 自测（纯 node、无副作用，末行 SELFTEST PASS 才算过）：
 *   node plugins/dsh-message-branches/selftest.mjs
 *   node plugins/dsh-message-branches/client-selftest.mjs
 *
 * @module dsh-message-branches
 */

import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const name = 'dsh-message-branches';
export const VERSION = 2;
export const ROUTE_PREFIX = '/dsh-branches';

/** 需要抓 before/after 快照的文件类工具（按参数里的路径键定位目标）。 */
export const FILE_TOOLS = Object.freeze(['write', 'edit', 'str_replace_editor', 'str_replace', 'notebook_edit', 'apply_patch']);
/** 参数里可能承载目标路径的键（按出现顺序取第一个非空字符串）。 */
export const PATH_KEYS = Object.freeze(['file_path', 'path', 'target_file', 'notebook_path', 'absolute_path', 'filename', 'file']);
/** shell 类工具：没有文件级钩子，只记命令当证据。 */
export const SHELL_TOOLS = Object.freeze(['bash', 'pwsh', 'powershell', 'shell', 'run_code']);

/* ── shell 副作用：写盘命令的清单差分（拿不到 before 内容，但拿得到「动过哪些文件」）── */

/** 扫描时跳过的重目录（都不是会话产物，扫了只会拖慢记账）。 */
const SCAN_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'output', '.stage-terraomni', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.mimosa', '.cache', '.next', 'target', '.pnpm-store', '.gradle',
]);

/**
 * 扫一棵树的轻量清单：路径 → {size, mtimeMs}。
 * 受文件数上限与时间预算双重约束（超限即 truncated，差分照做但会标注不完整）。
 */
export function scanTree(root, options = {}) {
  const maxFiles = options.maxFiles ?? DEFAULTS.maxScanFiles;
  const budgetMs = options.budgetMs ?? DEFAULTS.scanBudgetMs;
  const started = Date.now();
  const files = new Map();
  let truncated = false;
  const stack = [root];
  while (stack.length > 0) {
    if (files.size >= maxFiles || Date.now() - started > budgetMs) {
      truncated = true;
      break;
    }
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(entry.name)) stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = statSync(path);
        files.set(path, { size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        /* 抓不到（权限/竞态）就跳过 */
      }
      if (files.size >= maxFiles) {
        truncated = true;
        break;
      }
    }
  }
  return { files, truncated, count: files.size, ms: Date.now() - started };
}

/** 清单差分：只报 added / modified / removed（size 或 mtime 变即算 modified）。 */
export function diffScans(before, after) {
  const added = [];
  const modified = [];
  const removed = [];
  for (const [path, info] of after.files) {
    const old = before.files.get(path);
    if (old === undefined) added.push(path);
    else if (old.size !== info.size || old.mtimeMs !== info.mtimeMs) modified.push(path);
  }
  for (const path of before.files.keys()) if (!after.files.has(path)) removed.push(path);
  return { added, modified, removed, truncated: before.truncated === true || after.truncated === true };
}

/** 看起来会写盘的 shell 命令（读类命令直接跳过扫描，零开销）。 */
const MUTATING_SHELL = [
  /(^|[^<])>{1,2}/, // > file / >> file（含 2> ；heredoc 由下一条覆盖）
  /<</, // cat > f <<'EOF'
  /\btee\b/, /\bcp\b/, /\bmv\b/, /\brm\b/, /\bmkdir\b/, /\btouch\b/, /\btruncate\b/,
  /\bsed\b[^|;]*\s-i/, /\bdd\b/, /\binstall\b/, /\bpatch\b/, /\bunzip\b/, /\bchmod\b/, /\bchown\b/,
  /\bgit\s+(apply|checkout|restore|clean|stash|reset|mv|rm)\b/,
  /\b(python|python3|node|perl|ruby)\b[^|;]*\s(-c|-e)\b/,
  /\b(pip|pip3|npm|pnpm|yarn|bun|uv|cargo|go)\s+(install|add|i|remove|uninstall|build|run|exec)\b/,
  /\bwget\b/, /\bcurl\b[^|;]*\s(-o|--output)\b/, /\btar\b[^|;]*\s-[a-z]*x/,
];

export function looksMutating(command) {
  const text = typeof command === 'string' ? command : '';
  if (text === '') return false;
  for (const pattern of MUTATING_SHELL) if (pattern.test(text)) return true;
  return false;
}

const DEFAULTS = Object.freeze({
  stateDir: '',
  autoRollback: false,
  journalShellTools: true,
  shellScan: true,
  maxScanFiles: 60000,
  scanBudgetMs: 2500,
  maxBlobBytes: 4 * 1024 * 1024,
  maxEditedTextChars: 20000,
  maxJournalLines: 20000,
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

/** $DSH_HOME（本部署 = /root/.dsh）。 */
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
    autoRollback: merged.autoRollback === true,
    journalShellTools: merged.journalShellTools !== false,
    shellScan: merged.shellScan !== false,
    maxScanFiles: clampInt(merged.maxScanFiles, 0, 500000, DEFAULTS.maxScanFiles),
    scanBudgetMs: clampInt(merged.scanBudgetMs, 0, 60000, DEFAULTS.scanBudgetMs),
    maxBlobBytes: clampInt(merged.maxBlobBytes, 1024, 512 * 1024 * 1024, DEFAULTS.maxBlobBytes),
    maxEditedTextChars: clampInt(merged.maxEditedTextChars, 200, 1024 * 1024, DEFAULTS.maxEditedTextChars),
    maxJournalLines: clampInt(merged.maxJournalLines, 100, 1000000, DEFAULTS.maxJournalLines),
    bodyLimit: clampInt(merged.bodyLimit, 4096, 16 * 1024 * 1024, DEFAULTS.bodyLimit),
    registerRetries: clampInt(merged.registerRetries, 0, 400, DEFAULTS.registerRetries),
    registerRetryMs: clampInt(merged.registerRetryMs, 10, 5000, DEFAULTS.registerRetryMs),
  });
}

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(file, value) {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

function readJsonFile(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 读文件字节；不存在/不可读/目录 → null（调用方按「不存在」处理并记录原因）。 */
function readBytesSafe(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { missing: true, reason: stat.isDirectory() ? 'directory' : 'not-a-file' };
    return { bytes: readFileSync(path), mode: stat.mode };
  } catch (error) {
    return { missing: true, reason: errorText(error) };
  }
}

/** 文本内容归一化：CRLF/CR → LF（回退写回时按原样写 LF，见头部「已知边界」）。 */
function normalizeText(text) {
  return typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : null;
}

/* ── 存储：分支组 + 账本 + 快照 + 隔离区 + 回执 ─────────────────────────── */

export function createStore(root, onError = () => {}) {
  const groupsFile = join(root, 'groups.json');
  const journalDir = join(root, 'journal');
  const blobDir = join(root, 'blobs');
  const trashDir = join(root, 'trash');
  const receiptsDir = join(root, 'receipts');

  const emptyGroup = (rootSessionId) => ({
    id: rootSessionId,
    rootSessionId,
    createdAt: Date.now(),
    updatedAt: 0,
    selectedSessionId: rootSessionId,
    branches: [],
  });

  const readGroupsFile = () => {
    const table = new Map();
    const parsed = readJsonFile(groupsFile, null);
    if (isRecord(parsed) && isRecord(parsed.groups)) {
      for (const [id, group] of Object.entries(parsed.groups)) {
        if (!isRecord(group) || !Array.isArray(group.branches)) continue;
        table.set(id, {
          ...emptyGroup(id),
          ...group,
          id,
          branches: group.branches.filter((b) => isRecord(b) && typeof b.sessionId === 'string'),
        });
      }
    }
    return table;
  };

  const groups = new Map();
  try {
    for (const [id, group] of readGroupsFile()) groups.set(id, group);
  } catch (error) {
    onError(error);
  }

  const persistGroups = () => {
    try {
      ensureDir(root);
      // 先重读再合并：两个 dsh 进程共用 $DSH_HOME 时不互相覆盖（本部署的既定做法）。
      try {
        for (const [id, group] of readGroupsFile()) if (!groups.has(id)) groups.set(id, group);
      } catch {
        /* 坏文件：按内存表整表重写，至少不丢本进程的改动 */
      }
      atomicWriteJson(groupsFile, { version: 1, groups: Object.fromEntries(groups) });
    } catch (error) {
      onError(error);
    }
  };

  const journalFile = (sessionId) => join(journalDir, `${encodeURIComponent(sessionId)}.jsonl`);

  /** 内容寻址落盘：同内容只存一份；超过上限则只记哈希（回退时降级为人工）。 */
  const putBlob = (bytes, maxBytes) => {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
    const sha = sha256Hex(buffer);
    const truncated = buffer.byteLength > maxBytes;
    if (truncated) return { sha, size: buffer.byteLength, ref: null, truncated: true };
    const ref = join(sha.slice(0, 2), sha);
    const file = join(blobDir, ref);
    try {
      if (!existsSync(file)) {
        ensureDir(dirname(file));
        const tmp = `${file}.tmp-${process.pid}`;
        writeFileSync(tmp, buffer);
        renameSync(tmp, file);
      }
      return { sha, size: buffer.byteLength, ref, truncated: false };
    } catch (error) {
      onError(error);
      return { sha, size: buffer.byteLength, ref: null, truncated: true };
    }
  };

  const readBlob = (ref) => {
    if (typeof ref !== 'string' || ref === '') return null;
    const file = join(blobDir, ref);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file);
    } catch (error) {
      onError(error);
      return null;
    }
  };

  const journalAppend = (sessionId, entry, maxLines) => {
    try {
      ensureDir(journalDir);
      const file = journalFile(sessionId);
      if (existsSync(file)) {
        const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
        if (lines.length >= maxLines) {
          // 记账上限：丢掉最老的一半，保留最近的（账本是尽力而为的证据，不是审计日志）。
          const kept = lines.slice(Math.floor(lines.length / 2));
          writeFileSync(file, `${kept.join('\n')}\n`, 'utf8');
        }
      }
      writeFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
    } catch (error) {
      onError(error);
    }
  };

  const journalRead = (sessionId) => {
    const file = journalFile(sessionId);
    if (!existsSync(file)) return [];
    const entries = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line);
        if (isRecord(parsed)) entries.push(parsed);
      } catch {
        /* 坏行跳过：账本容错优先 */
      }
    }
    return entries;
  };

  return {
    root,
    groupsFile,
    journalDir,
    blobDir,
    trashDir,
    receiptsDir,
    putBlob,
    readBlob,
    journalAppend,
    journalRead,
    readJsonFile: (file, fallback) => readJsonFile(file, fallback),
    atomicWriteJson,
    /** 找到 sessionId 所在的分支组（分支都是组成员）。 */
    groupForSession(sessionId) {
      for (const group of groups.values()) {
        if (group.rootSessionId === sessionId) return group;
        if (group.branches.some((branch) => branch.sessionId === sessionId)) return group;
      }
      return null;
    },
    getGroup: (id) => groups.get(id) ?? null,
    listGroups: () => [...groups.values()],
    /** 登记一条分支（幂等：同 sessionId 覆盖，保留 createdAt）。 */
    registerBranch(rootSessionId, branch) {
      const group = groups.get(rootSessionId) ?? emptyGroup(rootSessionId);
      const at = group.branches.findIndex((item) => item.sessionId === branch.sessionId);
      if (at >= 0) group.branches[at] = { ...group.branches[at], ...branch };
      else group.branches.push({ ...branch });
      group.updatedAt = Date.now();
      groups.set(group.id, group);
      persistGroups();
      return group;
    },
    /** 粘性选择：**只由显式动作调用**，绝不按「最新分支」推导。 */
    selectBranch(rootSessionId, branchSessionId) {
      const group = groups.get(rootSessionId);
      if (group === undefined) throw new Error(`分支组不存在：${rootSessionId}`);
      if (!group.branches.some((branch) => branch.sessionId === branchSessionId)) throw new Error(`分支不属于该组：${branchSessionId}`);
      group.selectedSessionId = branchSessionId;
      group.updatedAt = Date.now();
      persistGroups();
      return group;
    },
    labelBranch(rootSessionId, branchSessionId, label) {
      const group = groups.get(rootSessionId);
      if (group === undefined) throw new Error(`分支组不存在：${rootSessionId}`);
      const branch = group.branches.find((item) => item.sessionId === branchSessionId);
      if (branch === undefined) throw new Error(`分支不属于该组：${branchSessionId}`);
      branch.label = label;
      group.updatedAt = Date.now();
      persistGroups();
      return group;
    },
    writeReceipt(receipt) {
      atomicWriteJson(join(receiptsDir, `${encodeURIComponent(receipt.id)}.json`), receipt);
      return receipt;
    },
    readReceipt(id) {
      const file = join(receiptsDir, `${encodeURIComponent(id)}.json`);
      if (!existsSync(file)) return null;
      return readJsonFile(file, null);
    },
  };
}

/* ── 目标路径与快照 ─────────────────────────────────────────────────────── */

/** 从工具参数里取目标路径（相对路径按会话 cwd 解析）。 */
export function resolveTargetPath(cwd, args) {
  if (!isRecord(args)) return null;
  for (const key of PATH_KEYS) {
    const raw = args[key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const value = raw.trim();
    if (isAbsolute(value)) return value;
    if (typeof cwd === 'string' && cwd !== '') return resolve(cwd, value);
    return resolve(value);
  }
  return null;
}

/** before/after 快照：文本走工具返回值，字节走磁盘（二进制也能回退）。 */
function snapshotFromText(store, text, maxBlobBytes) {
  if (text === null || text === undefined) return { exists: false, sha: null, size: 0, ref: null, truncated: false, mode: null };
  const bytes = Buffer.from(String(text), 'utf8');
  const image = store.putBlob(bytes, maxBlobBytes);
  return { exists: true, sha: image.sha, size: image.size, ref: image.ref, truncated: image.truncated, mode: null, source: 'tool-value' };
}

function snapshotFromDisk(store, path, maxBlobBytes) {
  const read = readBytesSafe(path);
  if (read.missing === true) return { exists: false, sha: null, size: 0, ref: null, truncated: false, mode: null };
  const image = store.putBlob(read.bytes, maxBlobBytes);
  return { exists: true, sha: image.sha, size: image.size, ref: image.ref, truncated: image.truncated, mode: read.mode ?? null, source: 'disk' };
}

/* ── 会话读取：可编辑目标（回合起点的人类消息）──────────────────────────── */

function contentText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function countImages(content) {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) if (isRecord(block) && block.type === 'image') count += 1;
  return count;
}

/**
 * 从会话事件里抽出「可编辑并分叉」的候选消息。
 *
 * 口径：一个回合的**起点人类消息**（`source.kind === 'user'` 且是该回合第一条）才是
 * 分叉点——分叉语义是「这条消息连同它之后的一切都留旧支」，回合中途的追加消息
 *（steer / 队列）不在此列（它们不是回合起点，分叉点无意义）。
 *
 * @param events - 会话事件数组（按 seq 升序）。
 * @returns 目标数组，含 fork 所需的 cutSeq / prevTurnEndSeq。
 */
export function extractTargets(events) {
  const targets = [];
  let turnIndex = 0;
  let openTurn = false;
  let turnStartSeq = null;
  let prevTurnEndSeq = null;
  let lastTurnEndSeq = null;
  let seenInTurn = false;
  for (const event of Array.isArray(events) ? events : []) {
    const type = event?.type;
    if (type === 'turn/start') {
      turnIndex += 1;
      turnStartSeq = event.seq;
      prevTurnEndSeq = lastTurnEndSeq;
      openTurn = true;
      seenInTurn = false;
      continue;
    }
    if (type === 'turn/end') {
      lastTurnEndSeq = event.seq;
      openTurn = false;
      continue;
    }
    if (type !== 'user/message' || !openTurn) continue;
    const data = event.data;
    if (!isRecord(data) || data.source?.kind !== 'user') continue;
    if (seenInTurn) continue; // 只认回合起点那条
    seenInTurn = true;
    const text = contentText(data.content);
    targets.push({
      seq: event.seq,
      time: typeof event.time === 'number' ? event.time : null,
      turnIndex,
      turnStartSeq,
      prevTurnEndSeq: prevTurnEndSeq ?? null,
      cutSeq: turnStartSeq,
      text,
      chars: text.length,
      images: countImages(data.content),
      // 首回合没有「已完成的上一回合」可分叉：由浏览器半边改用「新建空白会话」。
      forkable: prevTurnEndSeq !== null && prevTurnEndSeq !== undefined,
    });
  }
  return targets;
}

/** 从会话日志里补出的证据（插件装上前就发生过的工具调用）。 */
export function extractLogEvidence(events, cutSeq) {
  const evidence = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'tool/call') continue;
    if (typeof event.seq === 'number' && typeof cutSeq === 'number' && event.seq < cutSeq) continue;
    const data = event.data;
    if (!isRecord(data)) continue;
    const tool = String(data.name ?? '');
    let args = null;
    try {
      args = JSON.parse(String(data.arguments ?? 'null'));
    } catch {
      args = null;
    }
    const path = resolveTargetPath(null, args);
    evidence.push({
      seq: event.seq ?? null,
      callId: typeof data.callId === 'string' ? data.callId : null,
      tool,
      path,
      command: isRecord(args) && typeof args.command === 'string' ? args.command : null,
    });
  }
  return evidence;
}

/* ── 回退计划 ───────────────────────────────────────────────────────────── */

const TAIL_AFTER = (entry, cutSeq) => typeof entry.seq !== 'number' || typeof cutSeq !== 'number' || entry.seq >= cutSeq;

/**
 * 把账本尾巴合并成「按路径净效果」的回退计划。
 *
 * method：
 *   restore      — 尾巴期间被改/被删，账本里有可用的 before 快照 → 写回
 *   quarantine   — 尾巴期间新建 → 移入隔离区（不硬删）
 *   conflict     — 账本有快照但当前内容与 after 不符（用户后来手改过）→ 隔离 + 报告
 *   manual       — 只有证据（shell 副作用 / 快照超限 / 无法证明）→ 人工
 *   noop         — 净效果为零（改回原样）
 */
export function buildRollbackPlan(entries, cutSeq) {
  const byPath = new Map();
  const shellRisks = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!TAIL_AFTER(entry, cutSeq)) continue;
    if (entry.kind === 'shell') {
      shellRisks.push({ seq: entry.seq ?? null, tool: entry.tool ?? 'shell', command: entry.command ?? '', t: entry.t ?? null });
      continue;
    }
    const path = typeof entry.path === 'string' && entry.path !== '' ? entry.path : null;
    if (path === null) continue;
    let record = byPath.get(path);
    if (record === undefined) {
      record = { path, first: entry, last: entry, count: 0, tools: new Set() };
      byPath.set(path, record);
    }
    record.last = entry;
    record.count += 1;
    if (typeof entry.tool === 'string') record.tools.add(entry.tool);
  }

  const items = [];
  for (const record of byPath.values()) {
    const before = isRecord(record.first.before) ? record.first.before : null;
    const after = isRecord(record.last.after) ? record.last.after : null;
    const existedBefore = before !== null && before.exists === true;
    const existsAfter = after !== null && after.exists === true;
    const viaShell = record.first.source === 'shell-scan';
    const evidence = {
      path: record.path,
      changes: record.count,
      tools: [...record.tools],
      source: record.first.source ?? 'tool',
      scanTruncated: record.first.scanTruncated === true,
      firstSeq: typeof record.first.seq === 'number' ? record.first.seq : null,
      lastSeq: typeof record.last.seq === 'number' ? record.last.seq : null,
      beforeSha: existedBefore ? before.sha : null,
      afterSha: existsAfter ? after.sha : null,
      beforeRestorable: existedBefore && before.ref !== null && typeof before.ref === 'string',
      size: existedBefore ? before.size : (existsAfter ? after.size : 0),
    };
    if (!existedBefore && existsAfter) {
      items.push({
        ...evidence,
        method: 'quarantine',
        note: viaShell ? 'shell 命令新建：移入隔离区，可撤销' : '尾巴期间新建：移入隔离区，可撤销',
      });
      continue;
    }
    if (existedBefore && !existsAfter) {
      items.push(before.ref === null
        ? { ...evidence, method: 'manual', note: viaShell ? 'shell 命令删除（出厂无文件级钩子，取不到原内容）：只能人工恢复' : '尾巴期间删除，但 before 快照超限/缺失：只能人工恢复' }
        : { ...evidence, method: 'restore', note: '尾巴期间删除：写回 before 快照' });
      continue;
    }
    if (existedBefore && existsAfter) {
      if (before.sha === after.sha) {
        items.push({ ...evidence, method: 'noop', note: '净效果为零（内容与分叉点一致）' });
        continue;
      }
      items.push(before.ref === null
        ? { ...evidence, method: 'manual', note: viaShell ? 'shell 命令改动（出厂无文件级钩子，取不到 before 内容）：只能人工恢复' : '尾巴期间被改，但 before 快照超限/缺失：只能人工恢复' }
        : { ...evidence, method: 'restore', note: '尾巴期间被改：写回 before 快照' });
      continue;
    }
    items.push({ ...evidence, method: 'manual', note: '账本缺少可用快照（可能是插件装载前的改动）' });
  }

  items.sort((a, b) => a.path.localeCompare(b.path));
  return {
    cutSeq: typeof cutSeq === 'number' ? cutSeq : null,
    items,
    shellRisks,
    counts: {
      restore: items.filter((item) => item.method === 'restore').length,
      quarantine: items.filter((item) => item.method === 'quarantine').length,
      manual: items.filter((item) => item.method === 'manual').length,
      noop: items.filter((item) => item.method === 'noop').length,
      shell: shellRisks.length,
    },
  };
}

/** 隔离区落点：保留原文件名 + 序号，避免同名互相覆盖。 */
function trashPathFor(store, receiptId, path, index) {
  const dir = join(store.trashDir, encodeURIComponent(receiptId));
  ensureDir(dir);
  return join(dir, `${index}-${basename(path) || 'file'}`);
}

/** 把文件移到隔离区：优先 rename；跨设备时 copy + unlink（内容已进隔离区，可撤销）。 */
function quarantineFile(path, target) {
  try {
    renameSync(path, target);
    return { moved: true, how: 'rename' };
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      copyFileSync(path, target);
      unlinkSync(path);
      return { moved: true, how: 'copy+unlink', note: '跨设备隔离' };
    }
    throw error;
  }
}

/** 写回快照：先写临时文件再改名，尽量保留原权限位。 */
function restoreFile(path, bytes, mode) {
  ensureDir(dirname(path));
  const tmp = `${path}.dsh-branches-restore-${process.pid}`;
  writeFileSync(tmp, bytes);
  if (typeof mode === 'number') {
    try {
      chmodSync(tmp, mode & 0o7777);
    } catch {
      /* 权限位恢复失败不影响内容 */
    }
  }
  renameSync(tmp, path);
}

/**
 * 执行回退计划。
 * 安全闸：写回/隔离前校验「当前内容哈希 == 账本 after 哈希」，不一致就不动它。
 */
export function applyRollbackPlan(store, plan, options = {}) {
  const receiptId = typeof options.receiptId === 'string' && options.receiptId !== '' ? options.receiptId : `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const maxBlobBytes = options.maxBlobBytes ?? DEFAULTS.maxBlobBytes;
  const items = [];
  let index = 0;
  for (const item of plan.items) {
    index += 1;
    if (item.method === 'noop' || item.method === 'manual') {
      items.push({ path: item.path, method: item.method, status: 'skipped', note: item.note });
      continue;
    }
    const current = readBytesSafe(item.path);
    const currentSha = current.missing === true ? null : sha256Hex(current.bytes);
    const expectedSha = item.afterSha ?? null;
    const matches = current.missing === true ? expectedSha === null : currentSha === expectedSha;

    if (item.method === 'quarantine') {
      if (current.missing === true) {
        items.push({ path: item.path, method: 'quarantine', status: 'skipped', note: '文件已不存在（可能已被手工处理）' });
        continue;
      }
      if (!matches) {
        // 用户后来动过它：不覆盖也不移走，只报告（绝不吞掉用户的工作）。
        items.push({ path: item.path, method: 'quarantine', status: 'conflict', currentSha, expectedSha, note: '当前内容与账本 after 不符：保留原地，需人工确认' });
        continue;
      }
      try {
        const target = trashPathFor(store, receiptId, item.path, index);
        const moved = quarantineFile(item.path, target);
        items.push({ path: item.path, method: 'quarantine', status: 'applied', trashPath: target, how: moved.how, currentSha, expectedSha, note: moved.note ?? '已移入隔离区（可用 undo 取回）' });
      } catch (error) {
        items.push({ path: item.path, method: 'quarantine', status: 'failed', currentSha, expectedSha, note: errorText(error) });
      }
      continue;
    }

    // method === 'restore'
    const journalEntry = plan.entriesByPath?.[item.path] ?? null;
    const before = journalEntry?.before ?? null;
    const bytes = before !== null && typeof before.ref === 'string' ? store.readBlob(before.ref) : null;
    if (bytes === null) {
      items.push({ path: item.path, method: 'restore', status: 'failed', note: '快照不可读（blob 缺失或超限）' });
      continue;
    }
    if (current.missing === false && !matches) {
      items.push({ path: item.path, method: 'restore', status: 'conflict', currentSha, expectedSha, note: '当前内容与账本 after 不符：保留现状，需人工确认' });
      continue;
    }
    try {
      restoreFile(item.path, bytes, before.mode ?? null);
      items.push({
        path: item.path, method: 'restore', status: 'applied', currentSha, expectedSha,
        restoredSha: before.sha ?? sha256Hex(bytes), restoredSize: bytes.byteLength,
        note: '已写回分叉点的内容',
      });
    } catch (error) {
      items.push({ path: item.path, method: 'restore', status: 'failed', currentSha, expectedSha, note: errorText(error) });
    }
  }
  const receipt = {
    id: receiptId,
    sessionId: options.sessionId ?? null,
    cutSeq: plan.cutSeq ?? null,
    createdAt: Date.now(),
    items,
    shellRisks: plan.shellRisks ?? [],
    counts: {
      applied: items.filter((item) => item.status === 'applied').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      conflict: items.filter((item) => item.status === 'conflict').length,
      failed: items.filter((item) => item.status === 'failed').length,
    },
  };
  store.writeReceipt(receipt);
  return receipt;
}

/** 撤销一次回退：写回的按 after 快照还原；进隔离区的搬回原位（原位被占则留在隔离区并报告）。 */
export function undoRollback(store, receipt, options = {}) {
  const items = [];
  for (const item of receipt.items ?? []) {
    if (item.status !== 'applied') {
      items.push({ path: item.path, method: item.method, status: 'skipped', note: '本次回退未改动它' });
      continue;
    }
    if (item.method === 'quarantine') {
      if (typeof item.trashPath !== 'string' || !existsSync(item.trashPath)) {
        items.push({ path: item.path, status: 'failed', note: '隔离区文件已不存在' });
        continue;
      }
      if (existsSync(item.path)) {
        items.push({ path: item.path, status: 'conflict', note: '原位已有文件：隔离副本保留在 trash，未覆盖' });
        continue;
      }
      try {
        quarantineFile(item.trashPath, item.path);
        items.push({ path: item.path, status: 'applied', note: '已从隔离区取回' });
      } catch (error) {
        items.push({ path: item.path, status: 'failed', note: errorText(error) });
      }
      continue;
    }
    // restore → 用 receipt 里记录的 after 内容还原
    const after = isRecord(item.after) ? item.after : null;
    const bytes = after !== null && typeof after.ref === 'string' ? store.readBlob(after.ref) : null;
    if (bytes === null) {
      items.push({ path: item.path, status: 'failed', note: 'after 快照不可读：无法撤销这一次写回' });
      continue;
    }
    try {
      restoreFile(item.path, bytes, after.mode ?? null);
      items.push({ path: item.path, status: 'applied', note: '已还原回退前的内容' });
    } catch (error) {
      items.push({ path: item.path, status: 'failed', note: errorText(error) });
    }
  }
  return { ...receipt, undoneAt: Date.now(), undo: items };
}

/* ── host 半边注册 ─────────────────────────────────────────────────────── */

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

/** 读一条会话的头部与事件（live 或落盘都能读）。 */
async function readSessionLog(ctx, sessionId) {
  const query = ctx.get('sessionQuery');
  if (query === undefined) throw new Error('sessionQuery 服务不可用');
  if (typeof query.observeSession === 'function') {
    const observation = await query.observeSession(sessionId);
    try {
      return { header: observation.header ?? null, events: observation.events ?? [] };
    } finally {
      if (typeof observation.dispose === 'function') {
        try {
          observation.dispose();
        } catch {
          /* lease 释放失败不影响本次读取 */
        }
      }
    }
  }
  const snapshot = await query.readSession(sessionId);
  return { header: snapshot.session ?? snapshot.header ?? null, events: snapshot.events ?? [] };
}

/**
 * 命令跑完后的清单差分 → 把 shell 动过的文件补进账本。
 *
 * 拿不到 before 内容（出厂没有任何文件级钩子），所以：
 *   · 新建 → before:{exists:false}：回退时能**精确移入隔离区**；
 *   · 改动/删除 → before 标记 unknown：回退计划里列成人工项，但至少给出确切路径。
 */
function journalShellScan(store, config, record, callId) {
  const before = record.scanBefore;
  if (before === null || before === undefined || typeof record.cwd !== 'string' || record.cwd === '') return;
  const after = scanTree(record.cwd, { maxFiles: config.maxScanFiles, budgetMs: config.scanBudgetMs });
  const delta = diffScans(before, after);
  const unknownBefore = { exists: true, sha: null, size: null, ref: null, truncated: false, mode: null, unknown: true };
  const missingBefore = { exists: false, sha: null, size: 0, ref: null, truncated: false, mode: null };
  const missingAfter = { exists: false, sha: null, size: 0, ref: null, truncated: false, mode: null };
  const base = { sid: record.sessionId, seq: record.seq ?? null, callId, tool: record.tool, kind: 'file', source: 'shell-scan', scanTruncated: delta.truncated };
  for (const path of delta.added) {
    store.journalAppend(record.sessionId, {
      ...base, t: Date.now(), path, op: 'create', before: missingBefore,
      after: snapshotFromDisk(store, path, config.maxBlobBytes),
    }, config.maxJournalLines);
  }
  for (const path of delta.modified) {
    store.journalAppend(record.sessionId, {
      ...base, t: Date.now(), path, op: 'update', before: unknownBefore,
      after: snapshotFromDisk(store, path, config.maxBlobBytes),
    }, config.maxJournalLines);
  }
  for (const path of delta.removed) {
    store.journalAppend(record.sessionId, {
      ...base, t: Date.now(), path, op: 'delete', before: unknownBefore, after: missingAfter,
    }, config.maxJournalLines);
  }
}

/**
 * 账本记录钩子。
 *
 * 挂在 `tools/pre-execute` / `tools/post-execute` 上（**prepend**：本部署里
 * dsh-fs-observation-policy 之类的插件会在瀑布里先行，且有不调用 next() 的先例，
 * 不 prepend 就可能永远轮不到我们）。两个钩子都只观察、都调用 next()，不改工具行为。
 */
function attachJournal(ctx, store, config) {
  const pending = new Map();
  const note = (error) => ctx.logger?.warn?.(`message-branches: 记账失败：${errorText(error)}`);

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const sessionId = exec?.agent?.session?.id;
      if (typeof sessionId === 'string' && sessionId !== '') {
        const tool = String(exec.name ?? '');
        const args = exec.arguments;
        if (FILE_TOOLS.includes(tool)) {
          const cwd = exec.agent?.session?.header?.cwd ?? null;
          const path = resolveTargetPath(cwd, args);
          if (path !== null) {
            pending.set(exec.callId, {
              sessionId,
              tool,
              path,
              cwd,
              seq: typeof exec.agent?.session?.seq === 'number' ? exec.agent.session.seq : null,
              beforeDisk: snapshotFromDisk(store, path, config.maxBlobBytes),
            });
          }
        } else if (config.journalShellTools && SHELL_TOOLS.includes(tool)) {
          const command = isRecord(args) && typeof args.command === 'string' ? args.command : '';
          const cwd = isRecord(args) && typeof args.cwd === 'string' ? args.cwd : (exec.agent?.session?.header?.cwd ?? null);
          let scanBefore = null;
          if (config.shellScan && typeof cwd === 'string' && cwd !== '' && looksMutating(command)) {
            try {
              scanBefore = scanTree(cwd, { maxFiles: config.maxScanFiles, budgetMs: config.scanBudgetMs });
            } catch {
              scanBefore = null;
            }
          }
          pending.set(exec.callId, {
            sessionId,
            tool,
            shell: true,
            command,
            cwd,
            scanBefore,
            seq: typeof exec.agent?.session?.seq === 'number' ? exec.agent.session.seq : null,
          });
        }
      }
    } catch (error) {
      note(error);
    }
    return next();
  }, { prepend: true });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const record = pending.get(exec.callId);
      if (record !== undefined) {
        pending.delete(exec.callId);
        const value = isRecord(result?.value) ? result.value : null;
        if (record.shell === true) {
          store.journalAppend(record.sessionId, {
            t: Date.now(), sid: record.sessionId, seq: record.seq, callId: exec.callId, tool: record.tool,
            kind: 'shell', command: record.command, cwd: record.cwd,
          }, config.maxJournalLines);
          journalShellScan(store, config, record, exec.callId);
        } else {
          const toolBefore = value !== null && Object.prototype.hasOwnProperty.call(value, 'before') ? normalizeText(value.before) : undefined;
          const toolAfter = value !== null && Object.prototype.hasOwnProperty.call(value, 'after') ? normalizeText(value.after) : undefined;
          const before = toolBefore !== undefined ? snapshotFromText(store, toolBefore, config.maxBlobBytes) : record.beforeDisk;
          const after = toolAfter !== undefined ? snapshotFromText(store, toolAfter, config.maxBlobBytes) : snapshotFromDisk(store, record.path, config.maxBlobBytes);
          const op = !before.exists && after.exists ? 'create' : (before.exists && !after.exists ? 'delete' : 'update');
          store.journalAppend(record.sessionId, {
            t: Date.now(), sid: record.sessionId, seq: record.seq, callId: exec.callId, tool: record.tool,
            kind: 'file', path: record.path,
            displayPath: value !== null && typeof value.path === 'string' ? value.path : null,
            op, before, after,
            ok: result?.isError !== true,
          }, config.maxJournalLines);
        }
      }
    } catch (error) {
      note(error);
    }
    return next(result);
  }, { prepend: true });
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const store = createStore(config.stateDir, (error) => ctx.logger?.warn?.(`message-branches: 状态读写失败：${errorText(error)}`));
  attachJournal(ctx, store, config);

  const routes = {
    status: `${ROUTE_PREFIX}/status`,
    targets: `${ROUTE_PREFIX}/targets`,
    state: `${ROUTE_PREFIX}/state`,
    register: `${ROUTE_PREFIX}/register`,
    select: `${ROUTE_PREFIX}/select`,
    label: `${ROUTE_PREFIX}/label`,
    plan: `${ROUTE_PREFIX}/rollback/plan`,
    applyRollback: `${ROUTE_PREFIX}/rollback/apply`,
    undo: `${ROUTE_PREFIX}/rollback/undo`,
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
        json(res, 400, { error: errorText(error) });
      }
    }).catch((error) => {
      const tooLarge = isRecord(error) && error.code === 'BODY_TOO_LARGE';
      json(res, tooLarge ? 413 : 400, { error: tooLarge ? `body 过大（上限 ${config.bodyLimit} 字节）` : 'body 读取失败' });
    });
  };

  const viewGroup = (group) => (group === null ? null : {
    id: group.id,
    rootSessionId: group.rootSessionId,
    selectedSessionId: group.selectedSessionId,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    branches: group.branches.map((branch) => ({
      sessionId: branch.sessionId,
      parentSessionId: branch.parentSessionId ?? null,
      kind: branch.kind ?? 'root',
      label: branch.label ?? '',
      title: branch.title ?? '',
      editSeq: branch.editSeq ?? null,
      cutSeq: branch.cutSeq ?? null,
      editedSha: branch.editedSha ?? null,
      editedPreview: typeof branch.editedText === 'string' ? branch.editedText.slice(0, 120) : '',
      createdAt: branch.createdAt ?? null,
    })),
  });

  registerRoute('message-branches: status', routes.status, (req, res) => {
    if (!requireGet(req, res)) return;
    const sessionId = searchParams(req, routes.status).get('sessionId') ?? '';
    if (sessionId === '') {
      json(res, 400, { error: '需要 sessionId 查询参数' });
      return;
    }
    const group = store.groupForSession(sessionId);
    json(res, 200, {
      plugin: name,
      version: VERSION,
      sessionId,
      live: ctx.get('sessions')?.get(sessionId) !== undefined,
      group: viewGroup(group),
      stateDir: store.root,
      config: { autoRollback: config.autoRollback, journalShellTools: config.journalShellTools, maxBlobBytes: config.maxBlobBytes },
      routes: Object.keys(routes),
    });
  });

  registerRoute('message-branches: targets', routes.targets, (req, res) => {
    if (!requireGet(req, res)) return;
    const sessionId = searchParams(req, routes.targets).get('sessionId') ?? '';
    if (sessionId === '') {
      json(res, 400, { error: '需要 sessionId 查询参数' });
      return;
    }
    readSessionLog(ctx, sessionId).then(({ header, events }) => {
      const targets = extractTargets(events);
      json(res, 200, {
        sessionId,
        cwd: isRecord(header) && typeof header.cwd === 'string' ? header.cwd : null,
        title: isRecord(header) && typeof header.title === 'string' ? header.title : null,
        parentSessionId: isRecord(header) && isRecord(header.meta) && typeof header.meta.parentSession === 'string' ? header.meta.parentSession : null,
        targets,
        group: viewGroup(store.groupForSession(sessionId)),
      });
    }).catch((error) => json(res, 500, { error: errorText(error) }));
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

  registerRoute('message-branches: register', routes.register, (req, res) => {
    if (!requirePost(req, res)) return;
    withJson(req, res, (args) => {
      const parentSessionId = typeof args.parentSessionId === 'string' ? args.parentSessionId : '';
      const childSessionId = typeof args.childSessionId === 'string' ? args.childSessionId : '';
      if (parentSessionId === '' || childSessionId === '') throw new Error('需要 parentSessionId 与 childSessionId');
      // 组根：父会话已在某组里就沿用该组，否则父会话自己当根。
      const existing = store.groupForSession(parentSessionId);
      const rootSessionId = existing !== null ? existing.rootSessionId : parentSessionId;
      const editedText = typeof args.editedText === 'string' ? args.editedText : '';
      if (existing === null) {
        store.registerBranch(rootSessionId, {
          sessionId: parentSessionId, parentSessionId: null, kind: 'root',
          label: typeof args.parentLabel === 'string' && args.parentLabel !== '' ? args.parentLabel : '原始',
          title: typeof args.parentTitle === 'string' ? args.parentTitle : '',
          cwd: typeof args.cwd === 'string' ? args.cwd : null,
          createdAt: Date.now(),
        });
      }
      const group = store.registerBranch(rootSessionId, {
        sessionId: childSessionId,
        parentSessionId,
        kind: args.blank === true ? 'blank' : 'fork',
        label: typeof args.label === 'string' && args.label !== '' ? args.label : '',
        title: typeof args.title === 'string' ? args.title : '',
        cwd: typeof args.cwd === 'string' ? args.cwd : null,
        editSeq: Number.isFinite(args.editSeq) ? args.editSeq : null,
        cutSeq: Number.isFinite(args.cutSeq) ? args.cutSeq : null,
        prevTurnEndSeq: Number.isFinite(args.prevTurnEndSeq) ? args.prevTurnEndSeq : null,
        editedText: editedText.slice(0, config.maxEditedTextChars),
        editedSha: editedText === '' ? null : sha256Hex(editedText),
        createdAt: Date.now(),
      });
      store.selectBranch(rootSessionId, childSessionId); // 刚分叉出来就是当前选择（显式动作）
      return { group: viewGroup(store.getGroup(rootSessionId) ?? group), rootSessionId };
    });
  });

  registerRoute('message-branches: select', routes.select, (req, res) => {
    if (!requirePost(req, res)) return;
    withJson(req, res, (args) => {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
      const branchSessionId = typeof args.branchSessionId === 'string' && args.branchSessionId !== '' ? args.branchSessionId : sessionId;
      if (sessionId === '') throw new Error('需要 sessionId');
      const group = store.groupForSession(sessionId);
      if (group === null) throw new Error('该会话不属于任何分支组');
      store.selectBranch(group.rootSessionId, branchSessionId);
      return { group: viewGroup(store.getGroup(group.rootSessionId)) };
    });
  });

  registerRoute('message-branches: label', routes.label, (req, res) => {
    if (!requirePost(req, res)) return;
    withJson(req, res, (args) => {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
      const branchSessionId = typeof args.branchSessionId === 'string' ? args.branchSessionId : '';
      const label = typeof args.label === 'string' ? args.label.slice(0, 80) : '';
      if (sessionId === '' || branchSessionId === '') throw new Error('需要 sessionId 与 branchSessionId');
      const group = store.groupForSession(sessionId);
      if (group === null) throw new Error('该会话不属于任何分支组');
      store.labelBranch(group.rootSessionId, branchSessionId, label);
      return { group: viewGroup(store.getGroup(group.rootSessionId)) };
    });
  });

  /** 计划：账本尾巴 → 逐路径净效果；再把日志证据（插件装载前的调用）附在后面。 */
  const buildPlan = async (sessionId, cutSeq) => {
    const entries = store.journalRead(sessionId);
    const plan = buildRollbackPlan(entries, cutSeq);
    const byPath = new Map();
    for (const entry of entries) {
      if (entry.kind === 'file' && typeof entry.path === 'string') {
        if (byPath.get(entry.path) === undefined) byPath.set(entry.path, entry);
      }
    }
    plan.entriesByPath = Object.fromEntries(byPath);
    try {
      const { events } = await readSessionLog(ctx, sessionId);
      // 已被账本记过的调用不再进「日志证据」（否则同一条 shell 会报两遍）。
      const journaledCalls = new Set(entries.map((entry) => entry.callId).filter((id) => typeof id === 'string'));
      const evidence = extractLogEvidence(events, cutSeq).filter((item) => item.callId === null || !journaledCalls.has(item.callId));
      const journaledPaths = new Set(entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path));
      plan.logEvidence = evidence.filter((item) => item.path !== null && !journaledPaths.has(item.path));
      plan.logEvidenceOnly = evidence.filter((item) => item.path === null);
    } catch (error) {
      plan.logEvidence = [];
      plan.logEvidenceOnly = [];
      plan.logError = errorText(error);
    }
    return plan;
  };

  const publicPlan = (plan) => ({
    cutSeq: plan.cutSeq,
    counts: plan.counts,
    items: plan.items.map((item) => ({
      path: item.path, method: item.method, note: item.note, changes: item.changes, tools: item.tools,
      source: item.source ?? 'tool', scanTruncated: item.scanTruncated === true,
      beforeSha: item.beforeSha, afterSha: item.afterSha, size: item.size,
    })),
    shellRisks: plan.shellRisks,
    logEvidence: plan.logEvidence ?? [],
    logEvidenceOnly: plan.logEvidenceOnly ?? [],
    logError: plan.logError ?? null,
    journalEntries: store.journalRead(plan.sessionId ?? '').length,
  });

  registerRoute('message-branches: rollback plan', routes.plan, (req, res) => {
    if (!requirePost(req, res)) return;
    withJson(req, res, async (args) => {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
      if (sessionId === '') throw new Error('需要 sessionId');
      const cutSeq = Number.isFinite(args.cutSeq) ? args.cutSeq : null;
      const plan = await buildPlan(sessionId, cutSeq);
      plan.sessionId = sessionId;
      return { plan: publicPlan(plan), sessionId, cutSeq };
    });
  });

  registerRoute('message-branches: rollback apply', routes.applyRollback, (req, res) => {
    if (!requirePost(req, res)) return;
    withJson(req, res, async (args) => {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
      if (sessionId === '') throw new Error('需要 sessionId');
      const cutSeq = Number.isFinite(args.cutSeq) ? args.cutSeq : null;
      const plan = await buildPlan(sessionId, cutSeq);
      plan.sessionId = sessionId;
      const receipt = applyRollbackPlan(store, plan, { sessionId, receiptId: typeof args.receiptId === 'string' ? args.receiptId : undefined, maxBlobBytes: config.maxBlobBytes });
      return { receipt, plan: publicPlan(plan) };
    });
  });

  registerRoute('message-branches: rollback undo', routes.undo, (req, res) => {
    if (!requirePost(req, res)) return;
    withJson(req, res, (args) => {
      const receiptId = typeof args.receiptId === 'string' ? args.receiptId : '';
      if (receiptId === '') throw new Error('需要 receiptId');
      const receipt = store.readReceipt(receiptId);
      if (receipt === null) throw new Error(`回执不存在：${receiptId}`);
      return { receipt: undoRollback(store, receipt) };
    });
  });

  ctx.logger?.info?.(`message-branches: 就绪（状态根 ${config.stateDir}，路由 ${Object.values(routes).length} 条）`);
}

export default { name, inject: ['webServer', 'sessionQuery'], apply };
