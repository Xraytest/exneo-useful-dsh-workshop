/**
 * dsh-settings-nav —— host 半边（Cordis 静态插件）。
 *
 * 功能一句话：**把设置页左侧那一列「设置项」变成可分组、可折叠、可自由排序的导航**。
 *
 * ── 分成两半，各管一件事 ─────────────────────────────────────────────────────
 * 本体（布局文档）在 host 半边：`$DSH_HOME/settings-nav.json`，一份极小的 JSON，
 * 由本文件提供三条同源路由读写（`/dsh-settings-nav/{state,save,reset}`）。
 * 生效在浏览器半边（见 ./client.js）：它**不替换出厂设置壳**，而是在壳渲染出来的
 * 导航列表上做增强——见下面「为什么只能在 DOM 上做」。改设置页的展示属于纯 UI 行为，
 * host 这半边只负责「把布局持久化、并把它读回来」。
 *
 * ── 文档形状（schema 1）────────────────────────────────────────────────────
 *   {
 *     "schema": 1,
 *     "revision": 7,                         // 单调不减，见 load()
 *     "updatedAt": 1759999999999,
 *     "order": [                             // 整个导航的视觉顺序，逐项排列
 *       { "type": "item",  "id": "general" },
 *       { "type": "group", "id": "g-1a2b", "name": "模型与路由",
 *         "collapsed": false, "items": ["models", "model-groups"] }
 *     ]
 *   }
 * 语义严格是「**布局**」而不是「注册表」：
 *   · `order` 里没提到的设置项**不会被丢弃**，而是按出厂 order 追加在最后（新装插件
 *     自动出现在末尾，不需要手工登记）；
 *   · `order` 里提到、但当前不存在（插件被停用/卸载）的 id 只**跳过**、不自动删除——
 *     这样临时停用一个插件不会把它的位置忘掉（`orphans` 由客户端算出来并在管理页提示）；
 *   · 同一个 id 在文档里出现两次是**非法**的，归一化时保留先出现的那次并记 issue。
 *
 * ── revision 的语义（照抄 dsh-model-groups 的结论）──────────────────────────
 * 单调**不减**：内容变了要递增，内容没变也不能往回落。只报文件里的字段会在外部把
 * 文件改小时回落（同一个号指向两份内容，消费方误判「没变」）；只报进程内计数器又在
 * 重启后失真。取 `max(文件字段, 进程计数器)`，并且**先算后写、写完再提交内存值**——
 * 落盘失败时绝不对外宣称一个从未落盘的号。
 *
 * ── 写入保护（冲突不静默覆盖）──────────────────────────────────────────────
 * POST /save 必须带 `baseRevision`。与当前 revision 不一致时返回 **409 + 当前文档**，
 * 客户端拿到后**采用 host 的文档**并提示冲突，而不是把别人的改动盖掉。这是本项目里
 * 唯一有并发写者的设置面（导航内折叠 + 管理页编辑 + 直接改文件），静默覆盖会让人
 * 以为自己丢过一次操作。
 *
 * ── 为什么只能在 DOM 上做（**别拆掉这个结论**）──────────────────────────────
 * 一开始想的是「把 `sidebar.settings` 这个 single 槽位顶掉、自己渲染整个设置壳」。
 * 读过 SlotCore 与渲染器实现后确认**此路不通**：
 *   ① single 槽位在同一 priority 上再注册会 **throw**（"already has a registration …
 *      register at a different priority to shadow it (lowest renders)"）——要顶掉出厂
 *      壳（priority 0）得用更低优先级；
 *   ② 但 `renderSlot` 这个 prop **只发给「自己声明了 children」的注册**，而
 *      `register()` 在 children 里出现「别人已声明的槽位」时**也会 throw**；
 *      `settings.section` 已被出厂壳声明，后来者无法再声明 → 顶掉壳就再也渲染不出
 *      各设置页的正文。释放（dispose）才解除声明，而别人的注册我们无权释放。
 * 结论：**能渲染 `settings.section` 正文的组件有且只有出厂的那个壳**，所以壳必须留着，
 * 分组/排序只能在它渲染出来的导航 DOM 上叠加。client.js 顶部有同一段结论的复述。
 *
 * ── 维护 ────────────────────────────────────────────────────────────────────
 * 本 profile 未开模块热载，loader **按 specifier 缓存模块**：改本文件后要让运行实例
 * 生效，需把 cordis.patch.yml 里那一行的 `name` 指到新的 `entry-v<N+1>.js`（**保持
 * 同一行 id**），或重启 dsh。只改 config 不改 name 会走同 id 的 dispose→start 路径，
 * 是安全的。自测：`node plugins/dsh-settings-nav/selftest.mjs`（纯 node，无副作用，
 * 含真实 HTTP 处理器 + 临时目录落盘）。
 *
 * @module dsh-settings-nav
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';

/** 插件名（诊断回显用）。 */
export const name = 'dsh-settings-nav';

/**
 * 必须声明的服务依赖。`webServer` 由 `dsh-host-webserver` 提供，而**它的就绪时机不由
 * 本插件决定**：不声明 inject 时 Cordis 在本行一被挂载就立刻 apply，此刻
 * `ctx.get('webServer')` 可能仍是 undefined，于是三条路由静默不注册（只剩一条 warn），
 * 症状就是「客户端半边在 boot 图里、`GET /dsh-settings-nav/state` 却 404」。
 *
 * 这不是理论风险：本 profile 里**每一个注册路由的兄弟插件**（dsh-model-groups、
 * dsh-model-pool、dsh-subagent-models、dsh-usage-stats）都声明了这一条；本插件 v1 漏了，
 * 在 0.2.0-rc.2 上实测复现（客户端在、路由 404），v2 起跟上。
 */
export const inject = ['webServer'];

/** 本文件的构建标记（变更时递增；GET /state 会回报）。 */
export const BUILD = 'nav-5';

/**
 * 文档 schema 版本。
 *
 * 2 = 分组可以嵌套（`group.items` 里既有设置项 id 字符串，也有子分组对象）；
 * 1 = 只有平铺的分组。读的时候两者都认：`items` 里的未知类型就地丢弃，
 * 不会把整份文件判成坏文件。
 */
export const SCHEMA = 2;

/** 浏览器 API 前缀。 */
const ROUTE_PREFIX = '/dsh-settings-nav';

/** 硬上限：既是拒绝坏文件的门槛，也是「回显不放大」的依据。 */
export const LIMITS = {
  /** 一个文档里最多几个分组（含嵌套）。 */
  maxGroups: 64,
  /** 分组最多嵌套几层（顶层分组为第 0 层，所以最深 5 层）。 */
  maxDepth: 5,
  /** 一个文档里最多登记几个设置项（含分组内成员）。 */
  maxIds: 2000,
  /** 分组名最大字符数。 */
  maxName: 60,
  /** id 最大字符数。 */
  maxId: 120,
  /** /save 请求体上限（字节/字符；UTF-8 下按字符计，见 readBody）。 */
  maxBodyBytes: 262144,
  /** 回显 issues 的条数上限。 */
  maxEchoedIssues: 20,
};

/**
 * 读请求体的最长等待（毫秒）。
 *
 * 声明了 body 却一个字节不发时，若不设限就只能靠 Node 默认 300s 的 requestTimeout
 * 兜底——那 5 分钟里连接无响应地挂着，是一种便宜的资源占用。有界超时把它压到业务
 * 可接受的范围，超时按 408 拒绝并拆连接。
 */
export const BODY_TIMEOUT_MS = 15000;

const msg = (error) => String((error && error.message) || error);

/**
 * 有界目录创建（**不要**换回 mkdirSync(dir, {recursive:true})）。
 *
 * Node v22.23.3 实测：对 procfs 这类「父目录不存在、且 mkdir 对缺失父目录返回 ENOENT
 * 而不是 EPERM」的文件系统，recursive mkdir 会**永不返回**——同步调用占死唯一的 JS
 * 线程，整个 DSH（GUI + 会话）冻结，既不抛错也不打日志，只能重启进程。
 * 逐级非递归创建把这种路径变成立刻抛出的 ENOENT，落进既有的 500 / 告警分支。
 *
 * 逐级切分必须以 `parse().root` 为根，**不能假设根是 `sep`**：Windows 的绝对路径是
 * `C:\Users\…`（盘符 `C:`）或 `\\server\share\…`（UNC），POSIX 才是 `/…`。旧实现写死
 * `absolute.slice(1).split(sep)`，在 Windows 上第一段就是盘符里的 `:`，于是 mkdir
 * `C:\:` → `EINVAL: invalid argument, mkdir 'C:\:'`，凡是「配置文件所在目录尚不存在」
 * 的写入都会 500（报错原文见 README 6.2）。
 *
 * @param {string} dir 目标目录（相对路径按进程 cwd 解析）。
 */
export function ensureDirSync(dir) {
  const absolute = resolve(dir);
  const { root } = parse(absolute);
  // 根为空说明不是绝对路径（resolve 之后不该出现，防御性返回）；已到根目录则无事可做。
  if (root === '' || absolute === root) return;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep)) {
    if (part === '') continue;
    // root 自带尾部隔符（`/`、`C:\`、`\\server\share\`），直接拼接即可。
    current = current.endsWith(sep) ? current + part : current + sep + part;
    if (existsSync(current)) continue;
    try {
      mkdirSync(current); // 非递归：失败立刻抛（procfs → ENOENT，不再死循环）
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error; // 并发创建：谁先谁赢
    }
    if (!existsSync(current)) throw new Error(`无法创建目录：${current}`);
  }
}

/** 原子写 JSON（tmp + rename）。rename 失败时清掉 tmp，避免在配置目录留下垃圾。 */
function atomicWriteJson(path, value) {
  ensureDirSync(dirname(path));
  const tmp = path + '.tmp-' + randomUUID();
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 尽力而为：清理失败不掩盖原始错误 */
    }
    throw error;
  }
}

/** $DSH_HOME（缺省 ~/.dsh）。 */
export function dshHome() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
  return home;
}

/** 布局文件缺省路径。 */
export function defaultFilePath() {
  return join(dshHome(), 'settings-nav.json');
}

/**
 * 本模块的**真实身份**：`index.js?v=nav-3`（带 query，标记随 entry-v<N> 走）。
 *
 * `build` 只是文件里的常量，而 entry-v1/v2/v3… 都指向同一个 index.js 物理文件（只是
 * query 不同）——光看 build 分不清 patch 行指向哪份 entry、哪个 `?v=` 标记，回滚没
 * 生效时也会看到同一个 build（假阳性）。`import.meta.url` 带得住 query，才是「线上
 * 跑的是哪张图」的可观测证据。
 */
function implTag() {
  try {
    const url = String(import.meta.url || '');
    const at = url.lastIndexOf('/');
    return at >= 0 ? url.slice(at + 1) : url;
  } catch {
    return '';
  }
}

/** 空文档。 */
export function emptyDocument() {
  return { schema: SCHEMA, revision: 0, updatedAt: 0, order: [] };
}

/** 清掉控制字符并夹住长度；不合法就返回 ''；超长会截断，并把截断**报成 issue**。 */
function cleanText(value, max, { allowSpace = true, issues = null, label = '文本' } = {}) {
  if (typeof value !== 'string') return '';
  // 名字里的控制字符换成空格再折叠（`a\nb` → `a b`，不能粘成 `ab`）；id 直接删掉。
  // eslint-disable-next-line no-control-regex
  let text = value.replace(/[\u0000-\u001f\u007f]/g, allowSpace ? ' ' : '');
  text = allowSpace ? text.replace(/\s+/g, ' ').trim() : text.trim();
  if (text === '') return '';
  if (text.length > max) {
    // 静默截断是**错诊断**的源头：两个只在第 120 个字符之后才分叉的 id 截断后完全相同，
    // 后一个会被报成「重复 id」，而真正的问题是「太长了」。返回值保持截断后的样子，
    // 只是把这件事实说出来。
    if (issues !== null) issues.push(`${label}过长已截断到 ${max} 字符`);
    return text.slice(0, max);
  }
  return text;
}

/** 设置项 id / 分组 id 的取值口径：非空、无控制字符、长度有界（超长会截断并记 issue）。 */
function cleanId(value, issues = null, label = 'id') {
  return cleanText(value, LIMITS.maxId, { allowSpace: false, issues, label });
}

/**
 * 归一化一份布局文档。**宽容读、严格写**：
 *   · 形状级错误（根不是对象、order 不是数组、条目数超限）→ `shapeErrors`，调用方按
 *     「坏文件」处理（保留上次可用快照，绝不当成空文档，否则一个手抖的编辑就会把
 *     全部分组清空）；
 *   · 单项级错误（类型未知、id 非法/重复、items 不是数组、嵌套超深）→ `issues`，
 *     就地丢弃/纠正。
 *
 * schema 2 起 `group.items` 里既能放设置项 id **字符串**，也能放**子分组对象**
 * （`{type:'group', …}`，可多层嵌套，上限 `LIMITS.maxDepth` 层）。顶层 `order` 的形状
 * 不变（设置项是对象、分组是对象）。字符串这种「老写法」继续被接受：老版本插件读到
 * 新文件时，子分组会被当成未知类型丢掉，而普通成员原样保留——降级是**丢层级**，
 * 不是丢设置项。
 *
 * @param {unknown} raw 解析出来的 JSON。
 * @returns {{ order: object[], issues: string[], shapeErrors: string[] }}
 */
export function normalizeDocument(raw) {
  const issues = [];
  const shapeErrors = [];
  const order = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    shapeErrors.push('根必须是对象');
    return { order, issues, shapeErrors };
  }
  const input = raw.order;
  if (input !== undefined && !Array.isArray(input)) {
    shapeErrors.push('order 必须是数组');
    return { order, issues, shapeErrors };
  }
  const list = Array.isArray(input) ? input : [];
  if (list.length > LIMITS.maxIds + LIMITS.maxGroups) {
    shapeErrors.push(`order 条目数 ${list.length} 超过上限 ${LIMITS.maxIds + LIMITS.maxGroups}`);
    return { order, issues, shapeErrors };
  }

  const seenIds = new Set();
  const seenGroups = new Set();
  let idCount = 0;

  /** 把一个设置项 id 记进账（重复/超限都记 issue 并丢弃）。 */
  const takeId = (value, where, wrapped) => {
    const id = cleanId(value, issues, `${where} 的 id`);
    if (id === '') {
      issues.push(wrapped ? `${where} 含非法 id，已丢弃` : `${where} 缺少合法 id，已丢弃`);
      return null;
    }
    if (seenIds.has(id)) {
      issues.push(wrapped
        ? `「${id}」在本文件里已出现过，分组内的重复项已丢弃`
        : `${where} 的「${id}」在本文件里已出现过，重复项已丢弃`);
      return null;
    }
    if (idCount >= LIMITS.maxIds) {
      issues.push(wrapped ? `${where} 超出 ${LIMITS.maxIds} 个设置项上限，已丢弃` : `${where} 之后超出 ${LIMITS.maxIds} 个设置项上限，已丢弃`);
      return null;
    }
    seenIds.add(id);
    idCount += 1;
    return id;
  };

  /**
   * 递归归一化一个分组。`depth` 是它**自己**的嵌套深度（顶层分组为 0）。
   * 返回 null 表示这个分组（整棵）被丢弃。
   */
  const normalizeGroup = (entry, where, depth) => {
    if (depth >= LIMITS.maxDepth) {
      issues.push(`${where} 的嵌套超过 ${LIMITS.maxDepth} 层，整棵子分组已丢弃`);
      return null;
    }
    const id = cleanId(entry.id, issues, `${where} 的分组 id`);
    if (id === '') {
      issues.push(`${where} 分组缺少合法 id，已丢弃`);
      return null;
    }
    if (seenGroups.has(id)) {
      issues.push(`${where} 的分组 id「${id}」重复，已丢弃`);
      return null;
    }
    if (seenGroups.size >= LIMITS.maxGroups) {
      issues.push(`${where} 之后超出 ${LIMITS.maxGroups} 个分组上限，已丢弃`);
      return null;
    }
    seenGroups.add(id);

    const rawName = cleanText(entry.name, LIMITS.maxName, { issues, label: `${where} 的分组名` });
    if (rawName === '') issues.push(`${where} 分组名为空，已回落到「未命名分组」`);
    const name = rawName === '' ? '未命名分组' : rawName;

    const items = [];
    if (entry.items !== undefined && !Array.isArray(entry.items)) {
      issues.push(`${where}.items 不是数组，按空分组处理`);
    }
    const rawItems = Array.isArray(entry.items) ? entry.items : [];
    for (let at = 0; at < rawItems.length; at += 1) {
      const candidate = rawItems[at];
      const child = `${where}.items[${at}]`;
      if (typeof candidate === 'string') {
        const memberId = takeId(candidate, child, true);
        if (memberId !== null) items.push(memberId);
        continue;
      }
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        issues.push(`${child} 既不是 id 也不是分组，已丢弃`);
        continue;
      }
      if (candidate.type !== 'group') {
        issues.push(`${child} 的 type「${String(candidate.type)}」未知，已丢弃`);
        continue;
      }
      const sub = normalizeGroup(candidate, child, depth + 1);
      if (sub !== null) items.push(sub);
    }

    return { type: 'group', id, name, collapsed: entry.collapsed === true, items };
  };

  for (let at = 0; at < list.length; at++) {
    const entry = list[at];
    const where = `order[${at}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push(`${where} 不是对象，已丢弃`);
      continue;
    }

    if (entry.type === 'item') {
      const id = takeId(entry.id, where, false);
      if (id !== null) order.push({ type: 'item', id });
      continue;
    }

    if (entry.type === 'group') {
      const group = normalizeGroup(entry, where, 0);
      if (group !== null) order.push(group);
      continue;
    }

    issues.push(`${where} 的 type「${String(entry.type)}」未知，已丢弃`);
  }

  return { order, issues, shapeErrors };
}

/** 把 issues 夹到回显上限（逐条回显会让一个请求换回数 MB 响应）。 */
export function capIssues(issues) {
  const list = Array.isArray(issues) ? issues : [];
  return { issues: list.slice(0, LIMITS.maxEchoedIssues), issueCount: list.length };
}

/** 夹取 apply 的 config（loader 已保证是对象，这里再夹一遍取值边界）。 */
export function normalizeConfig(config) {
  const input = config !== null && typeof config === 'object' ? config : {};
  const opt = {
    file: defaultFilePath(),
    enabled: true,
  };
  if (typeof input.file === 'string' && input.file.trim() !== '') opt.file = input.file.trim();
  if (input.enabled === false) opt.enabled = false;
  // 未知键（含已删除的 cacheTtlMs）**静默忽略**，不报 issue：这个归一化器只负责夹取值，
  // 组合层里残留一个旧键不该让整个插件起不来。
  return opt;
}

/**
 * 请求自己声明的 authority（`Host` 头）是不是**本机可信来源**。
 *
 * 为什么需要它：只比较 `Origin` 与 `Host` 是**同义反复**——两者都是调用方随手填的请求头。
 * 攻击者只要让它们一致就过，而 DNS-rebinding 页面恰好天然一致：页面的域就是攻击者的域，
 * 于是 `Host: evil.example` 与 `Origin: http://evil.example` 相等。实测（真服务器）带这
 * 两个头打 /save 拿到了插件的 409 业务响应，即已经越过守卫。所以必须额外要求请求自己
 * 写的 authority 落在本机——攻击者没法让浏览器把 `Host` 写成 `127.0.0.1`（那已经不是他的
 * 域了，同源策略会拦住他读响应，而写副作用在这一关被挡下）。
 *
 * 为什么本 profile 的 LAN 访问不会被误伤：dsh-lanmode 的直连桥转发上游请求时把 Host 与
 * Origin **改写成回环 authority**（bridge.js:68 `const authority = '127.0.0.1:' + upstreamPort`，
 * bridge.js:286 传给 rewrittenHeaders），所以经桥进来的 LAN 流量抵达本插件时 Host 已是
 * `127.0.0.1:<port>`。
 *
 * 判定口径对齐平台的 isTrustedLocalAuthority（dsh-lanmode/lib/access.js），但**不 import**
 * 它：dsh-lanmode 是可选插件，本插件不能因此多一个硬依赖。只取本机安全所需的最小集合：
 * `localhost` / `dsh.local` / 回环 / 私有 IPv4。ULA（fc00::/7）等其它私有 v6 不收——经桥
 * 到达时 Host 已被改写成回环，直接暴露的 v6 字面量不需要放行。
 *
 * @param {unknown} authority `Host` 头原样（可带端口、可带 IPv6 方括号）。
 * @returns {boolean}
 */
export function isTrustedLocalAuthority(authority) {
  if (typeof authority !== 'string') return false;
  const clean = authority.trim().toLowerCase();
  if (clean === '') return false;
  let hostname = clean;
  if (clean.startsWith('[')) {
    const end = clean.indexOf(']');
    if (end === -1) return false; // "[::1" 这种残缺 IPv6 一律不认
    hostname = clean.slice(1, end);
  } else {
    const firstColon = clean.indexOf(':');
    // 只有一个冒号才是「主机:端口」；多于一个说明是裸 IPv6 字面量（如 ::1），按最后一个
    // 冒号切会把地址切坏（`:1`）。
    if (firstColon !== -1 && firstColon === clean.lastIndexOf(':')) hostname = clean.slice(0, firstColon);
  }
  if (hostname === '') return false;
  if (hostname === 'localhost' || hostname === 'dsh.local') return true;
  if (hostname === '::1' || hostname === '::ffff:127.0.0.1' || hostname.startsWith('127.')) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) return true;
  return false;
}

/**
 * 请求体类错误 → HTTP 状态。413 超限、408 读超时，其余一律 400。
 *
 * 单独提出来是因为它必须可被单测直接钉住：路由级的 408 要走满 15s 超时才能出现，而这里
 * 一行分支错了（例如漏掉 408、把超时映射成 400）是**肉眼看不出来**的。
 *
 * @param {unknown} error readBody 拒出来的错误。
 * @returns {number} 413 / 408 / 400。
 */
export function bodyStatusOf(error) {
  return error && (error.statusCode === 413 || error.statusCode === 408) ? error.statusCode : 400;
}

/**
 * 读请求体。超限时**不**立刻 destroy 连接：先让调用方把 413 响应完整发出去，这里
 * 只把剩余请求体读完（有界 drain）——立刻 destroy 会把连接重置，客户端只会看到
 * ECONNRESET，看不到任何响应。
 *
 * **超时也一样不在这里 destroy**（同一道理，而且是真实走线实测出来的）：本函数一旦
 * `reject`，调用方是在**下一个微任务**里才去写 408 的，而 `req.destroy()` 是同步执行的
 * ——响应还没写就被连坐重置，客户端只看到 `socket hang up`，根本收不到 408。所以拆连接
 * 这件事交给调用方，在响应发完（`res.once('finish')`）之后做，见 bodyError()。
 *
 * @param {object} req 请求。
 * @param {number} [limit] 体积上限（字符数）。
 * @param {number} [timeoutMs] 收完请求体的超时；声明了 body 却一个字节不发时，不能靠
 *   Node 默认 300s 的 requestTimeout 兜底（那期间连接无响应地挂着）。
 */
export function readBody(req, limit = LIMITS.maxBodyBytes, timeoutMs = BODY_TIMEOUT_MS) {
  // setEncoding('utf8') 让 Node 用 StringDecoder 拼接**跨 TCP 分块**的多字节字符：
  // 手工 `body += chunk`（chunk 是 Buffer）会在分块切断处插入 U+FFFD，静默损坏
  // 分组名这类多字节字段。
  if (typeof req.setEncoding === 'function') req.setEncoding('utf8');
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    let overflowed = false;
    let drained = 0;
    let settled = false;
    let timer = null;
    // 所有结案路径都走这两只闸：计时器一定被清掉，且**只可能 settle 一次**（原有的
    // overflowed 护栏保留，这里再加一层 settled，避免 timeout 与 end/error 竞态）。
    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolveBody(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimer();
      rejectBody(error);
    };
    timer = setTimeout(() => {
      rejectOnce(Object.assign(new Error('读取请求体超时'), { statusCode: 408, code: 'BODY_TIMEOUT' }));
      // 这里**故意不** destroy：reject 之后要等调用方把 408 写出去。立刻拆连接会让这条
      // 响应一起被重置，客户端只看到 "socket hang up"（probe-http.mjs 钉的就是这个）。
    }, timeoutMs);
    req.on('data', (chunk) => {
      if (overflowed) {
        // setEncoding('utf8') 之后 chunk 恒为字符串，按 .length 量已排水量是安全的。
        drained += chunk.length;
        if (drained > limit * 4) req.destroy();
        return;
      }
      body += chunk;
      if (body.length > limit) {
        overflowed = true;
        body = '';
        rejectOnce(Object.assign(new Error('body too large'), { statusCode: 413, code: 'BODY_TOO_LARGE' }));
      }
    });
    req.on('end', () => {
      if (!overflowed) resolveOnce(body);
    });
    req.on('error', (error) => {
      if (!overflowed) rejectOnce(error);
    });
  });
}

/**
 * 建插件主体；返回句柄（selftest 直接调它，无需真 Cordis，也不碰全局状态）。
 *
 * @param {object} ctx cordis 上下文（只用 ctx.get / ctx.effect / ctx.logger 三个可选面）。
 * @param {object} [config] 组合行里的 config。
 * @returns {object} 句柄：`{ state, save, reset, load, diag, path, options, dispose }`。
 */
export function createSettingsNav(ctx, config = {}) {
  const options = normalizeConfig(config);
  const path = options.file;

  /** 上次可用快照。**任何失败都保留它**，只覆盖错误字段。 */
  let snapshot = {
    exists: false,
    // 非 ENOENT 的读失败会把 exists 置 true 并打开这个旗标：文件**在**，只是读不出来。
    // 见 load() 的 catch——它就是「坏文件 ≠ 空文档」在 IO 层面的同一条要求。
    unreadable: false,
    revision: 0,
    checkedAt: 0,
    signature: '',
    order: [],
    issues: [],
    loadError: null,
  };
  /** 进程内单调计数器：对外 revision 取 `max(文件字段, 它)`。 */
  let processRevision = 0;
  let disposed = false;

  const diag = {
    version: 1,
    build: BUILD,
    impl: implTag(),
    reads: 0,
    saves: 0,
    resets: 0,
    conflicts: 0,
    rejected: 0,
    // 「文件存在但读不出来」时被拒绝的写入次数。与 rejected 分开：那是坏输入，这是
    // 保护性冻结，且**不进 lastError**（它是正常业务分支，不是路由故障）。
    frozen: 0,
    routeErrors: 0,
    lastSaveAt: null,
    lastError: null,
    routes: false,
  };

  function signatureOf(text) {
    return createHash('sha1').update(text).digest('hex').slice(0, 12);
  }

  /**
   * 读盘并合并快照。**每次调用都真的读盘**。
   *
   * 本插件的文件极小（几 KB 上限），客户端也只在 boot 时读一次 /state（没有轮询），
   * 所以不做 mtime/TTL 短路：短路省不了什么，却要担 `cp -p` / `utimes` 保留下来的
   * mtime 骗过缓存的风险（dsh-model-groups 正为此额外做内容指纹复核），还让「外部改了
   * 文件却不生效」变成一条需要解释的窗口。删掉那个窗口比维护它便宜。
   *
   * @returns {object} 当前快照。
   */
  function load() {
    const now = Date.now();
    diag.reads += 1;

    let text = null;
    let exists = false;
    try {
      text = readFileSync(path, 'utf8');
      exists = true;
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        // 文件不存在（ENOENT）；或**父路径不是目录**（ENOTDIR）——目标文件不可能存在，
        // 不是「存在但读不出来」。两者都按出厂空布局处理，让写路径自己去报真正的问题
        // （父路径被文件占住 → 写盘失败 → 500，这是已文档化的行为），而不是在这里冻成
        // 503：那种情况下根本没有文件可被覆盖，冻结没有保护价值。revision 不回落。
        const signature = '';
        const changed = snapshot.exists;
        const revision = changed ? Math.max(0, snapshot.revision + 1) : snapshot.revision;
        snapshot = { exists: false, unreadable: false, revision, checkedAt: now, signature, order: [], issues: [], loadError: null };
        return snapshot;
      }
      // 非 ENOENT 的读失败 = 文件**在，但读不出来**（权限 / IO 错误）。绝不能让它看起来
      // 和「没有文件」一样：否则 state 会报 {exists:false, revision:0, order:[]}，一次
      // baseRevision:0 的保存就能靠「只有目录可写」的 rename 把原文件覆盖掉——实测
      // 盘上 revision 4→1、用户布局全丢。这就是模块自己的不变量「坏文件 ≠ 空文档」在
      // IO 层面要守的同一条线。
      snapshot = { ...snapshot, exists: true, unreadable: true, checkedAt: now, loadError: msg(error) };
      diag.lastError = msg(error);
      ctx.logger?.warn?.(`dsh-settings-nav: 布局文件不可读，沿用上次快照并冻结写入：${msg(error)}`);
      return snapshot;
    }

    try {
      const raw = JSON.parse(text);
      const normalized = normalizeDocument(raw);
      if (normalized.shapeErrors.length > 0) {
        // 「JSON 合法但形状非法」与语法错同等对待：否则一个 {"order":null} 或根为 null
        // 的文件就会静默顶掉上次可用快照、把全部分组清空。
        throw new Error('布局文件形状非法：' + normalized.shapeErrors.join('；'));
      }
      const signature = signatureOf(text);
      const changed = signature !== snapshot.signature;
      // revision：单调不减。内容变了要递增（外部改写通常不动 revision 字段），
      // 内容没变也不能往回落。
      const fileRevision = Number.isFinite(raw && raw.revision) && raw.revision >= 0 ? Math.trunc(raw.revision) : 0;
      const revision = changed
        ? Math.max(fileRevision, snapshot.revision + 1, processRevision)
        : Math.max(fileRevision, snapshot.revision, processRevision);
      snapshot = {
        exists: true,
        // 读得出来就不是 IO 不可读。坏内容走下面那条分支，也不设这个旗标。
        unreadable: false,
        revision,
        checkedAt: now,
        signature,
        order: normalized.order,
        issues: normalized.issues,
        loadError: null,
      };
    } catch (error) {
      // 坏文件：保留上一次可用快照（不让一个手抖的编辑把分组全部清空），只记错误。
      // unreadable 要显式清掉：文件已经能读出来了，此刻的问题是内容而不是权限；否则
      // 「先 000 再改回可读但内容坏」会一直停在冻结态。
      snapshot = { ...snapshot, unreadable: false, checkedAt: now, loadError: msg(error) };
      diag.lastError = msg(error);
      ctx.logger?.warn?.(`dsh-settings-nav: 布局文件不可用，沿用上次快照：${msg(error)}`);
    }
    return snapshot;
  }

  /** 对外 revision：`max(文件字段, 进程计数器)`，单调不减。 */
  function revisionNow(current) {
    return Math.max(current.revision, processRevision);
  }

  /** 警告折叠成一条数组：不可读冻结 + 坏文件 + 归一化 issues。 */
  function warningsOf(current) {
    const warnings = [];
    if (current.unreadable === true) {
      warnings.push('布局文件存在但当前读不出来（已冻结保存/重置，避免把上次快照当成空文档覆盖它）');
    }
    if (current.loadError !== null) warnings.push(`布局文件读取失败：${current.loadError}`);
    for (const issue of current.issues) warnings.push(issue);
    return warnings;
  }

  /**
   * 落盘一份新布局。先算后写、写完再提交内存计数器：失败时绝不前进到一个从未落盘的号。
   *
   * @param {object[]} order 已归一化的 order 数组。
   * @returns {object} `{ revision, order, issues }`。
   */
  function persist(order) {
    const current = load();
    const next = {
      schema: SCHEMA,
      revision: Math.max(revisionNow(current), processRevision) + 1,
      updatedAt: Date.now(),
      order,
    };
    atomicWriteJson(path, next);
    processRevision = next.revision;
    const after = load();
    return { revision: after.revision, order: after.order, issues: after.issues };
  }

  /** GET /state 的响应体。 */
  function state() {
    const current = load();
    return {
      ok: true,
      schema: SCHEMA,
      build: BUILD,
      impl: diag.impl,
      path,
      exists: current.exists,
      // 让客户端和人一眼看得出「文件在、但读不出来」这是冻结态，而不是「没有文件」。
      unreadable: current.unreadable === true,
      revision: revisionNow(current),
      order: current.order,
      warnings: warningsOf(current),
      limits: LIMITS,
      // 客户端需要的开关只有 enabled：管理页自己那一节在导航里的位置由用户拖拽决定，
      // 不做成 host 配置（否则注册时机要等这次 GET 回来，凭空多一条异步注册路径）。
      config: { enabled: options.enabled },
      diag: { ...diag },
    };
  }

  /**
   * 覆盖写布局（带 revision 栅栏）。
   *
   * @param {object} input `{ baseRevision?: number, order: unknown }`。
   * @returns {object} `{ status, body }`——HTTP 映射只是照抄 status/body。
   */
  function save(input) {
    const current = load();
    // 「文件存在但读不出来」时先冻结写入，**且必须在 revision 栅栏之前**：栅栏比的是
    // 上一次可用快照的 revision，而它没变，所以用户手里的 baseRevision 会正好「匹配」，
    // 覆盖就会把一个（很可能内容完好、只是权限错了）文件换掉。用 503 而不是 409：
    // 客户端把 409 当「采用 host 的文档」并丢弃本地布局，那会变成第二次数据丢失。
    if (current.unreadable === true) {
      diag.frozen += 1;
      return {
        status: 503,
        body: {
          ok: false,
          unreadable: true,
          error: '布局文件当前存在但读不出来（权限或 IO 错误），已拒绝写入以免覆盖它；请先修复文件后重试',
        },
      };
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      diag.rejected += 1;
      return { status: 400, body: { ok: false, error: 'body 必须是对象：{ baseRevision, order }' } };
    }
    if (!Array.isArray(input.order)) {
      diag.rejected += 1;
      return { status: 400, body: { ok: false, error: 'order 必须是数组（要清空布局就提交 order:[]）' } };
    }
    const base = Number.isFinite(input.baseRevision) ? Math.trunc(input.baseRevision) : null;
    if (base !== null && base !== revisionNow(current)) {
      // 冲突不静默覆盖：把 host 现状原样回给客户端，由它采用并提示。
      diag.conflicts += 1;
      return {
        status: 409,
        body: {
          ok: false,
          conflict: true,
          revision: revisionNow(current),
          order: current.order,
          warnings: warningsOf(current),
          error: '布局已被别处改写，已拒绝本次覆盖',
        },
      };
    }
    const normalized = normalizeDocument({ schema: SCHEMA, order: input.order });
    if (normalized.shapeErrors.length > 0) {
      diag.rejected += 1;
      return { status: 400, body: { ok: false, error: '布局形状非法：' + normalized.shapeErrors.join('；') } };
    }
    const capped = capIssues(normalized.issues);
    let written;
    try {
      written = persist(normalized.order);
    } catch (error) {
      diag.lastError = msg(error);
      return { status: 500, body: { ok: false, error: '布局写入失败：' + msg(error) } };
    }
    diag.saves += 1;
    diag.lastSaveAt = new Date().toISOString();
    const after = load();
    return {
      status: 200,
      body: {
        ok: true,
        revision: revisionNow(after),
        order: after.order,
        warnings: warningsOf(after),
        issues: capped.issues,
        issueCount: capped.issueCount,
      },
    };
  }

  /** 清空布局（回到出厂顺序）。冲突语义与 save 一致。 */
  function reset(input) {
    diag.resets += 1;
    const base = input !== null && typeof input === 'object' && Number.isFinite(input.baseRevision) ? Math.trunc(input.baseRevision) : null;
    return save({ baseRevision: base, order: [] });
  }

  /* ------------------------------------------------------------ HTTP ---- */

  function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  /**
   * 同源守卫。顺序即安全边界，别重排：
   *   ① `sec-fetch-site: cross-site` 一律拒；
   *   ② 请求自己的 authority 不可信 → 拒（见 isTrustedLocalAuthority 的 WHY；少这一步
   *      Origin/Host 比较就是同义反复）；
   *   ③ 无 Origin（curl / 本机 CLI）放行——只能在 ② 之后；
   *   ④ `Origin: null` 按**外部**处理：它不是本页面的同源来源（沙箱 iframe、file:// 页面
   *      都会发 `null`），不能只靠「读者拿不到响应」兜底；
   *   ⑤ 其余 Origin 必须**与 Host 同 host 且 scheme 与真实传输一致**（只比 host 会放过
   *      「明文连接上的 https Origin」这种被忽略的协议错配），畸形 Origin 一律拒。
   */
  function sameOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const host = req.headers.host;
    if (!isTrustedLocalAuthority(host)) return false;
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '') return true;
    if (origin === 'null') return false;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.host !== host) return false;
    // 真实传输决定允许的 scheme；反向代理终止 TLS 时由代理负责改写 Host/Origin，这里只信
    // socket 的实际加密状态，不信 Origin 自称的 https。
    const encrypted = req.socket !== undefined && req.socket !== null && req.socket.encrypted === true;
    return parsed.protocol === (encrypted ? 'https:' : 'http:');
  }

  /**
   * 请求体相关的失败响应：超限 413，读 body 超时 408，其余 400。
   *
   * 408 要在响应**发完之后**才拆连接——客户端声明了 body 却一个字节不发，不拆就会一直
   * 挂到 Node 默认 300s 的 requestTimeout；但立刻拆（在 readBody 里同步 destroy）会把
   * 还没写出去的 408 一起重置，客户端只会看到 `socket hang up`。折中就是挂在 `finish` 上：
   * 报文已交给内核再关，两边都满足。真实走线上这么做客户端能完整收到 408（probe-http.mjs）。
   */
  function bodyError(req, res, error) {
    const status = bodyStatusOf(error);
    if (status === 408 && typeof res.once === 'function') {
      res.once('finish', () => {
        if (typeof req.destroy === 'function') req.destroy();
      });
    }
    diag.routeErrors += 1;
    return json(res, status, { error: msg(error) });
  }

  /** 把 `{status, body}` 写回响应。4xx 是正常业务分支（冲突/拒绝），不进 routeErrors。 */
  function reply(res, result) {
    return json(res, result.status, result.body);
  }

  /** 注册一条 POST 路由（405 → 403 → body → 业务）。 */
  function registerPost(webServer, routePath, handler, label) {
    return ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: routePath,
          handler: (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' });
            if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request rejected' });
            readBody(req)
              .then((text) => {
                let parsed = {};
                if (text !== '') {
                  try {
                    parsed = JSON.parse(text);
                  } catch {
                    diag.routeErrors += 1;
                    return json(res, 400, { error: 'body 不是合法 JSON' });
                  }
                }
                try {
                  return reply(res, handler(parsed === null || typeof parsed !== 'object' ? {} : parsed));
                } catch (error) {
                  diag.routeErrors += 1;
                  diag.lastError = msg(error);
                  return json(res, 500, { error: msg(error) });
                }
              })
              .catch((error) => bodyError(req, res, error));
          },
        }),
      label,
    );
  }

  const webServer = ctx.get('webServer');
  if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
    diag.routes = true;

    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: ROUTE_PREFIX + '/state',
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method Not Allowed' });
            if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request rejected' });
            try {
              return json(res, 200, state());
            } catch (error) {
              diag.routeErrors += 1;
              diag.lastError = msg(error);
              return json(res, 500, { error: msg(error) });
            }
          },
        }),
      'dsh-settings-nav state route',
    );

    registerPost(webServer, ROUTE_PREFIX + '/save', (body) => save(body), 'dsh-settings-nav save route');
    registerPost(webServer, ROUTE_PREFIX + '/reset', (body) => reset(body), 'dsh-settings-nav reset route');
  } else {
    ctx.logger?.warn?.('dsh-settings-nav: 没有 webServer 服务，浏览器半边的读写路由未注册');
  }

  const handle = {
    name,
    options,
    path,
    /** @returns {object} GET /state 的响应体。 */
    state,
    /** @param {object} input `{baseRevision?, order}` */
    save,
    /** @param {object} input `{baseRevision?}` */
    reset,
    /** 读盘刷新快照（每次都会真的读；没有 TTL/缓存窗口）。 */
    load,
    /** 诊断计数器（活体对象，直接读即可）。 */
    diag,
    dispose() {
      disposed = true;
    },
    get disposed() {
      return disposed;
    },
  };
  return handle;
}

/**
 * Cordis 入口。
 *
 * @param {object} ctx cordis 上下文。
 * @param {object} [config] 组合行里的 config（`{file, enabled}`）。
 * @returns {object} 句柄（同时被挂到 `ctx` 生命周期上）。
 */
export function apply(ctx, config = {}) {
  return createSettingsNav(ctx, config);
}
