/**
 * 归档会话浏览器（dsh-archived-sessions）— 浏览器半边。
 *
 * 设置页「归档会话」一节：把被归档隐藏的会话**按工作区归类**展示，并提供
 * **两级检索**：
 *   1. 标题 / 路径 / 会话 ID / 工作区名 —— 输入即筛（纯前端，零延迟）；
 *   2. 消息内容 —— 回车或「检索内容」走 host 半边的
 *      `GET /dsh-arcsess/search`（全文索引可用时为 FTS 排序命中，否则逐条
 *      字面量扫描），命中回填摘要片段，并按会话给出命中数。
 * 每行保留「恢复 / 恢复并打开」——DSH 出厂未提供取消归档入口。
 *
 * 检索状态机（都为了「一次只认最新一代」）：
 *   - 每次检索带一个自增代次（searchSeq ref）并在换代时 abort 旧的 fetch；
 *     被取代的一代一个状态都不许写（否则「检索中」提前结束、秒表与按钮禁用态
 *     错乱，Enter 还能叠出并发检索）；
 *   - 命中/已扫名单只在**同一个检索词**下累加（「继续检索」才出现，换了词就
 *     重新开始——否则会拿旧词的 skip 名单跳过真正命中的会话、并把旧词的片段
 *     并进来）；
 *   - 续检方式按引擎分：FTS 传后端 `cursor=`，字面量扫描传 `skip=<已扫 id>`。
 *
 * 数据与动作全部来自本插件 host 半边的同源路由（静态插件没有动态包的
 * host.call，同源相对路径在 loopback 直连与 dsh-lanmode 反代下都可用）：
 *   GET  /dsh-arcsess/list     分组清单
 *   GET  /dsh-arcsess/search   内容检索
 *   POST /dsh-arcsess/restore  恢复一个会话
 *
 * 2026-10-19 两处改动：
 *   ① 恢复流程在本地 /restore 落地后，再送一次
 *      POST /dsh-device-mesh/session-state/propose {action:'unarchive'}——
 *      本机是副本（权威 orangepi5）时，设备网格每 30 s 从权威拉归档态并
 *      重新应用，只改本地 registry 的恢复会在 30 s 内被撤销；propose 把
 *      unarchive 同步给权威后，这轮同步不再收回。网格不在（404）时跳过，
 *      纯单机部署行为不变；权威不可达时恢复仍成立（propose 自身降级）。
 *      与出厂侧边栏「归档」动作的 propose 补丁（dsh-client-ui-workspace）
 *      同一套路；出厂侧边栏的「取消归档」按钮同轮也补了 propose（在那边）。
 *   ② 本设置节声明子槽位 settings.arcsess.item 并在节首渲染它：「归档会话
 *      显示」选择行（出厂 ui-workspace 注册、store 挂侧边栏视图存储）从
 *      「通用设置」挪进本节——注册侧（ui-workspace）只改了注入的槽位名。
 *   ③ 远程行（host 半边 /list 合并进来的其它设备归档会话）：动作区给
 *      「归档于 <设备名>」说明而不是假按钮（本机 /restore 改不了那台设备的
 *      归档集）；元信息行带「设备 <名>」。
 *   ④ 分组区分本地/远程工作区。**两件事分开标**（2026-10-19 第三轮修正：
 *      用户实测指出 4 个互联工作区被错标「本机工作区」——「本地/远程」的真相
 *      是**执行端（属主）**，不是归档记录在哪台的 registry）：
 *      · 执行端标识：GET /dsh-device-mesh/drivers（约 4 KB，与侧边栏 🌐
 *        转发执行标示同源）按 workspaceId 匹配分组——属主是本机标
 *        「本机工作区」，属主在别台标「执行于 <设备名>」。互联会话的 cwd
 *        落点会被本机 registry 记成「本机工作区」，但文件与命令真正跑在
 *        属主那台，必须按 drivers 判定说。判定缺失（网格不在 / 没这条）
 *        时**不标**——宁可不标也不错标。
 *      · 归档记录标识（host mergeRemoteViews 的口径，说的是归档集写在哪台
 *        的 registry）：远程独有组标「归档记录在 <设备名>」；同名合并组标
 *        「归档记录 本机+<设备>（本机 X / 远程 Y）」。客户端按行统计
 *        devices/remoteRows 补齐组上缺失的声明（未登记兜底组）。
 *      工作区筛选下拉带双后缀（执行端 + 归档记录）；状态行分组账目按
 *      「本机执行 / 远程执行」分开数（同样以 drivers 为准）。
 *
 * 由 package.json 的 dsh.client 声明装载（inject 依赖：设置页骨架、slots、
 * 工作区导航）；组合行见 cordis.patch.yml。
 *
 * @module dsh-archived-sessions/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-archived-sessions',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const PAGE_CSS = [
      '.arcsess { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px 24px; }',
      '.arcsess-children { border-bottom: .5px solid var(--dsw-alias-border-l2); }',
      '.arcsess-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }',
      '.arcsess-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.arcsess-sub { margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }',
      '.arcsess-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }',
      '.arcsess-search { position: relative; display: flex; align-items: center; flex: 1 1 220px; min-width: 180px; }',
      '.arcsess-input { width: 100%; box-sizing: border-box; appearance: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; padding: 6px 26px 6px 10px; outline: none; }',
      '.arcsess-input:focus { border-color: var(--dsw-alias-brand-primary); }',
      '.arcsess-input::placeholder { color: var(--dsw-alias-label-secondary); }',
      '.arcsess-clear { position: absolute; right: 4px; appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 1; padding: 2px 5px; cursor: pointer; border-radius: 6px; }',
      '.arcsess-clear:hover { color: var(--dsw-alias-label-primary); }',
      '.arcsess-modes { display: flex; align-items: center; gap: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; overflow: hidden; }',
      '.arcsess-mode { appearance: none; border: 0; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 6px 10px; cursor: pointer; }',
      '.arcsess-mode.is-on { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }',
      '.arcsess-select { appearance: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; padding: 6px 8px; max-width: 220px; }',
      '.arcsess-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }',
      '.arcsess-info { min-width: 0; display: flex; flex-direction: column; gap: 3px; }',
      '.arcsess-name { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.arcsess-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.arcsess-hits { display: flex; flex-direction: column; gap: 3px; margin-top: 2px; }',
      '.arcsess-snip { font-size: 11px; line-height: 1.55; color: var(--dsw-alias-label-secondary); word-break: break-word; }',
      '.arcsess-hl { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); border-radius: 3px; padding: 0 1px; }',
      '.arcsess-more { font-size: 11px; color: var(--dsw-alias-label-secondary); }',
      '.arcsess-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }',
      '.arcsess-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; padding: 5px 12px; cursor: pointer; }',
      '.arcsess-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }',
      '.arcsess-danger { flex-shrink: 0; color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }',
      '.arcsess-danger:hover:not(:disabled) { border-color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }',
      '.arcsess-btn:disabled { opacity: 0.55; cursor: default; }',
      '.arcsess-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }',
      '.arcsess-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 8px 2px; }',
      '.arcsess-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }',
      '.arcsess-notice { font-size: 12px; color: var(--dsw-alias-state-success-primary); }',
      '.arcsess-status { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }',
      '.arcsess-warn { color: var(--dsw-alias-state-warn-primary); }',
      '.arcsess-engine { text-decoration: underline dotted; text-underline-offset: 2px; cursor: help; }',
      '.arcsess-group { display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 8px; background: var(--dsw-alias-bg-base); }',
      '.arcsess-grouphead { display: flex; align-items: center; gap: 8px; width: 100%; appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; padding: 4px 6px; cursor: pointer; text-align: left; border-radius: 8px; }',
      '.arcsess-grouprow { display: flex; align-items: center; gap: 8px; }',
      '.arcsess-grouprow .arcsess-grouphead { flex: 1 1 auto; min-width: 0; }',
      '.arcsess-grouphead:hover { background: var(--dsw-alias-bg-layer-1); }',
      '.arcsess-caret { color: var(--dsw-alias-label-secondary); font-size: 11px; width: 10px; flex-shrink: 0; }',
      '.arcsess-groupname { flex-shrink: 0; }',
      '.arcsess-grouppath { flex: 1 1 auto; min-width: 0; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.arcsess-count { flex-shrink: 0; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 1px 7px; }',
      '.arcsess-badge { flex-shrink: 0; font-size: 11px; font-weight: 400; color: var(--dsw-alias-bg-base); background: var(--dsw-alias-state-success-primary); border-radius: 999px; padding: 1px 7px; }',
      '.arcsess-tag { flex-shrink: 0; font-size: 10px; font-weight: 400; color: var(--dsw-alias-label-secondary); border: 1px dashed var(--dsw-alias-border-l2); border-radius: 999px; padding: 0 6px; }',
      // 分组来源标识：本机（实线、次要色）/ 远程（虚线、品牌色）/ 混合（虚线、警示色）。
      '.arcsess-scope { border-style: solid; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.arcsess-scopeRemote { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }',
      '.arcsess-scopeMixed { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }',
      '.arcsess-check { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-secondary); cursor: pointer; }',
    ].join('\n');

    function injectStyles() {
      if (typeof document === 'undefined') return;
      const tagId = 'dsh-archived-sessions/page.css';
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-archived-sessions';
      tag.dataset.pluginCss = tagId;
      tag.textContent = PAGE_CSS;
      (document.head || document.documentElement).appendChild(tag);
    }

    const errorText = (error) => String(error && error.message ? error.message : error);

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      let body = null;
      try {
        body = await response.json();
      } catch {
        /* 非 JSON 响应体：落到下面的状态码分支 */
      }
      if (!response.ok) {
        // 浏览器半边与 host 半边是两条独立的装载路径：host 行没生效（旧实现
        // 或插件被停用）时 /search、/status 会是 404，这里给出人话解释，
        // 而不是把「404 Not Found」直接糊在设置页上。
        if (response.status === 404 && String(url).indexOf('/dsh-arcsess/search') !== -1) {
          throw new Error('内容检索不可用：host 半边还是旧版本（插件行未生效）。标题/路径筛选与恢复不受影响。');
        }
        throw new Error((body && body.error) || (response.status + ' ' + response.statusText));
      }
      return body;
    }

    // ─────────────────────── 纯函数（client-selftest 直接调用） ───────────────────────

    /** 检索词：小写、按空白切分（多词 AND 语义）。 */
    function termsOf(value) {
      return String(value === null || value === undefined ? '' : value)
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term !== '');
    }

    /** 元数据匹配：标题 / 会话 id / cwd / 工作区名 / 工作区路径，多词 AND。 */
    function matchSession(session, terms) {
      if (terms.length === 0) return true;
      const haystack = [session.title, session.id, session.cwd, session.workspaceTitle, session.workspacePath]
        .filter((value) => typeof value === 'string' && value !== '')
        .join('\n')
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    }

    function baseName(path) {
      const clean = String(path === null || path === undefined ? '' : path).replace(/[/\\]+$/, '');
      if (clean === '') return '';
      const parts = clean.split(/[/\\]/);
      return parts[parts.length - 1] || clean;
    }

    /** 会话归属键：工作区优先，其次 cwd，最后「未知」。 */
    function groupKeyOf(session) {
      if (typeof session.workspaceId === 'string' && session.workspaceId !== '') return 'ws:' + session.workspaceId;
      if (typeof session.cwd === 'string' && session.cwd !== '') return 'cwd:' + session.cwd;
      return 'none';
    }

    const createdOf = (session) => (typeof session.createdAt === 'number' ? session.createdAt : Number.NEGATIVE_INFINITY);
    const activityOf = (session) => (
      typeof session.titleUpdatedAt === 'number'
        ? session.titleUpdatedAt
        : (typeof session.createdAt === 'number' ? session.createdAt : Number.NEGATIVE_INFINITY)
    );

    function sortSessions(sessions, sortKey) {
      const compare = (left, right) => {
        if (sortKey === 'created-asc') {
          if (createdOf(left) !== createdOf(right)) return createdOf(left) > createdOf(right) ? 1 : -1;
        } else if (sortKey === 'activity-desc') {
          if (activityOf(left) !== activityOf(right)) return activityOf(left) > activityOf(right) ? -1 : 1;
        } else if (sortKey === 'title') {
          const delta = String(left.title || left.id).localeCompare(String(right.title || right.id));
          if (delta !== 0) return delta;
        } else {
          if (createdOf(left) !== createdOf(right)) return createdOf(left) > createdOf(right) ? -1 : 1;
        }
        return String(left.id).localeCompare(String(right.id));
      };
      return sessions.slice().sort(compare);
    }

    /**
     * 把 host 的清单折叠成分组列表。host 已按工作区分好组
     * （`workspaces` + `unassigned`）；字段缺失（host 半边未刷新）时退化为
     * 按 cwd 兜底分组，保证 UI 永远可用。
     *
     * 分组来源（host 半边 mergeRemoteViews 的口径，2026-10-19 起客户端如实呈现）：
     *   - 本地工作区：host 没标 remote/mixed —— 组上 `remote: false`；
     *   - 远程独有工作区：组上 `remote: true` + deviceId/deviceName；
     *   - 同名合并组（两台设备各有一份）：`mixed: true`，组内行按各自的
     *     `remote` 标记区分。
     * @returns {Array<{key, title, path, fromHost, remote, deviceId, deviceName, devices, sessions}>}
     */
    function buildGroups(data) {
      const source = data !== null && typeof data === 'object' ? data : {};
      const groups = [];
      const seen = new Set();
      const push = (group) => {
        if (group.sessions.length === 0) return;
        // 组上挂的设备账目：remote/mixed 组按行算出涉及哪些设备（显示与筛选用）。
        const devices = [];
        let remoteRows = 0;
        for (const session of group.sessions) {
          if (session.remote === true) {
            remoteRows += 1;
            const name = typeof session.deviceName === 'string' && session.deviceName !== '' ? session.deviceName : null;
            const hit = devices.find((entry) => entry.name === name);
            if (hit === undefined) devices.push({ name, count: 1 });
            else hit.count += 1;
          }
        }
        group.devices = devices;
        group.remoteRows = remoteRows;
        // remote 只认「远程独有工作区」（host 的声明）：组上没声明但行里有远程行时
        // 那是**合并组**（本机也有一份），标 mixed 而不是 remote——下拉后缀、组头
        // 标识都靠这两个字段区分「纯本机 / 纯远程 / 两边各一份」。
        group.remote = group.remote === true && remoteRows === group.sessions.length;
        group.mixed = group.mixed === true || (remoteRows > 0 && remoteRows < group.sessions.length);
        groups.push(group);
        seen.add(group.key);
      };
      const list = Array.isArray(source.workspaces) ? source.workspaces : [];
      for (const workspace of list) {
        const sessions = Array.isArray(workspace.sessions) ? workspace.sessions : [];
        push({
          key: 'ws:' + String(workspace.id),
          title: typeof workspace.title === 'string' && workspace.title !== ''
            ? workspace.title
            : (baseName(workspace.path) || String(workspace.id)),
          path: typeof workspace.path === 'string' ? workspace.path : '',
          fromHost: true,
          remote: workspace.remote === true,
          mixed: workspace.mixed === true,
          deviceId: typeof workspace.deviceId === 'string' ? workspace.deviceId : null,
          deviceName: typeof workspace.deviceName === 'string' ? workspace.deviceName : null,
          sessions,
        });
      }
      const loose = Array.isArray(source.unassigned)
        ? source.unassigned
        : (list.length === 0 && Array.isArray(source.sessions) ? source.sessions : []);
      const buckets = new Map();
      for (const session of loose) {
        const key = groupKeyOf(session);
        if (seen.has(key)) continue;
        let bucket = buckets.get(key);
        if (bucket === undefined) {
          bucket = {
            key,
            title: key === 'none'
              ? '未归入工作区'
              : (baseName(session.cwd) || String(session.cwd || '未归入工作区')),
            path: key === 'none' ? '' : String(session.cwd || ''),
            fromHost: false,
            remote: false,
            sessions: [],
          };
          buckets.set(key, bucket);
        }
        bucket.sessions.push(session);
      }
      for (const bucket of buckets.values()) push(bucket);
      return groups;
    }

    /**
     * 过滤 + 排序：内容检索模式下，命中元数据或命中内容的会话都保留。
     * @returns {Array<{key, title, path, fromHost, sessions, matched}>}
     */
    function visibleGroups(groups, view) {
      const terms = termsOf(view.query);
      const content = view.contentResults instanceof Map ? view.contentResults : new Map();
      const contentMode = view.mode === 'content';
      const result = [];
      for (const group of groups) {
        if (view.workspaceFilter !== 'all' && group.key !== view.workspaceFilter) continue;
        const sessions = [];
        let matched = 0;
        for (const session of group.sessions) {
          // 命中只在内容检索模式下贴出来：否则「标题/路径」模式会带上一轮检索的
          // 片段，读者会以为那是当前检索词的结果。
          const hits = contentMode ? content.get(session.id) : undefined;
          const metaHit = matchSession(session, terms);
          const contentHit = contentMode && hits !== undefined;
          if (terms.length > 0 && !metaHit && !contentHit) continue;
          if (contentHit) matched += 1;
          sessions.push(hits === undefined ? session : Object.assign({}, session, { hits }));
        }
        if (sessions.length === 0) continue;
        result.push(Object.assign({}, group, { sessions: sortSessions(sessions, view.sortKey), matched }));
      }
      return result;
    }

    function highlight(snippet, start, end) {
      const text = String(snippet === null || snippet === undefined ? '' : snippet);
      if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end <= start || end > text.length) {
        return text;
      }
      return [
        text.slice(0, start),
        h('span', { className: 'arcsess-hl', key: 'hl' }, text.slice(start, end)),
        text.slice(end),
      ];
    }

    // ─────────────────────────────────── 组件 ───────────────────────────────────

    const MODES = [
      { id: 'meta', label: '标题/路径' },
      { id: 'content', label: '消息内容' },
    ];

    const SORTS = [
      { id: 'created-desc', label: '最近创建' },
      { id: 'created-asc', label: '最早创建' },
      { id: 'activity-desc', label: '最近活动' },
      { id: 'title', label: '标题' },
    ];

    const STATUS_LABEL = {
      'user/message': '用户',
      'assistant/message': '模型',
      'tool/result': '工具',
      'system/message': '系统',
    };

    function ArchivedSessions(props) {
      const [data, setData] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [notice, setNotice] = React.useState(null);

      const [query, setQuery] = React.useState('');
      const [mode, setMode] = React.useState('meta');
      const [includeTools, setIncludeTools] = React.useState(false);
      const [workspaceFilter, setWorkspaceFilter] = React.useState('all');
      const [sortKey, setSortKey] = React.useState('created-desc');
      const [collapsed, setCollapsed] = React.useState(() => new Set());

      const [contentResults, setContentResults] = React.useState(() => new Map());
      const [searching, setSearching] = React.useState(false);
      const [searchInfo, setSearchInfo] = React.useState(null);
      const [scannedIds, setScannedIds] = React.useState([]);
      const [drivers, setDrivers] = React.useState(null);
      const [, setTick] = React.useState(0);

      const inflight = React.useRef(null);
      const searchStartedAt = React.useRef(0);
      /** 检索代次：只有最新一代能写状态（AbortController 不可用时也成立）。 */
      const searchSeq = React.useRef(0);

      /** 本节的子槽位渲染器（settings.arcsess.item）：出厂注册的「归档会话显示」
       *  选择行在这里渲染。注册没声明 children 时（旧组合）为 undefined，静默不画。 */
      const renderSlot = typeof props.renderSlot === 'function' ? props.renderSlot : null;

      /** 设备网格的执行端判定（/dsh-device-mesh/drivers，约 4 KB）：
       *  「本地/远程工作区」的真相是**属主/执行端**——文件与命令真正跑在哪台。
       *  本机 registry 会把「会话 cwd 落在某路径上」记成本机工作区，互联会话
       *  （会话在本机跑、文件在属主那台）因此被错标成「本机工作区」（用户实测
       *  指出）。权威是 mesh 的 drivers 判定（与侧边栏 🌐 标示同源），按
       *  workspaceId 匹配分组。网格不在（404）或判定缺失时不标——宁可不标
       *  也不错标。 */
      React.useEffect(() => {
        let cancelled = false;
        fetchJson('/dsh-device-mesh/drivers')
          .then((value) => { if (!cancelled) setDrivers(value); })
          .catch(() => { if (!cancelled) setDrivers(null); });
        return () => { cancelled = true; };
      }, []);

      /** 分组 → 执行端判定。drivers.workspaces 按本机注册表 workspaceId 判；
       *  返回 null = 无判定（不画执行端标识）。 */
      const ownerOf = React.useCallback((group) => {
        if (drivers === null || group === null || typeof group !== 'object') return null;
        const list = Array.isArray(drivers.workspaces) ? drivers.workspaces : [];
        // 分组 key 形如 'ws:<workspaceId>'；远程合并组（remote:<dev>:<ws>）不在
        // 本机注册表里，drivers 不判它们——归「无判定」，只按行上的 remote 账目标。
        const id = typeof group.key === 'string' && group.key.startsWith('ws:')
          ? group.key.slice(3) : null;
        if (id === null) return null;
        const hit = list.find((entry) => entry !== null && typeof entry === 'object' && String(entry.workspaceId) === id);
        if (hit === undefined) return null;
        const owner = hit.owner !== null && typeof hit.owner === 'object' ? hit.owner : null;
        if (owner === null) return null;
        return {
          isSelf: owner.isSelf === true,
          name: typeof owner.name === 'string' && owner.name !== '' ? owner.name : null,
        };
      }, [drivers]);

      const readList = (value) => (
        value !== null && typeof value === 'object' ? value : { workspaces: [], unassigned: [], sessions: [] }
      );

      /** 落一份新清单（load 与「恢复」后的刷新共用同一个入口）。
       *  工作区筛选存的是原始 key：分组可能因为重载而消失（例如该工作区最后一个
       *  归档会话被恢复了），重建选项后必须退回 all，否则列表会静默变空。 */
      const applyList = (value) => {
        const next = readList(value);
        setData(next);
        const keys = buildGroups(next).map((group) => group.key);
        setWorkspaceFilter((previous) => (previous === 'all' || keys.includes(previous) ? previous : 'all'));
      };

      const load = React.useCallback((fresh) => {
        setLoading(true);
        setError(null);
        fetchJson(fresh === true ? '/dsh-arcsess/list?fresh=1' : '/dsh-arcsess/list')
          .then(applyList)
          .catch((reason) => setError(errorText(reason)))
          .then(() => setLoading(false));
      }, []);

      React.useEffect(() => {
        load(false);
      }, [load]);

      // 检索进行中：秒级刷新已用时间（host 单次响应，无流式进度）。
      React.useEffect(() => {
        if (!searching) return undefined;
        const timer = setInterval(() => setTick((value) => value + 1), 1000);
        return () => clearInterval(timer);
      }, [searching]);

      React.useEffect(() => () => {
        if (inflight.current !== null) inflight.current.abort();
      }, []);

      const mergeResults = (previous, incoming) => {
        const next = new Map(previous);
        for (const hit of incoming) {
          if (hit === null || typeof hit !== 'object' || typeof hit.id !== 'string') continue;
          next.set(hit.id, {
            matchCount: typeof hit.matchCount === 'number' ? hit.matchCount : null,
            matches: Array.isArray(hit.matches) ? hit.matches : [],
          });
        }
        return next;
      };

      const runSearch = (skip, cursor) => {
        const keyword = query.trim();
        if ([...keyword].length < 2) {
          setError('内容检索至少 2 个字符');
          return;
        }
        if (inflight.current !== null) inflight.current.abort();
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        inflight.current = controller;
        searchSeq.current += 1;
        const seq = searchSeq.current;
        setSearching(true);
        setError(null);
        setNotice(null);
        setSearchInfo(null);
        // 续检只在同一个检索词下成立：换了词就必须从零开始，否则会拿旧词的
        // skip 名单跳过真正命中的会话，并把旧词的命中片段并进来。
        const sameKeyword = searchInfo !== null && searchInfo.keyword === keyword;
        const carried = sameKeyword && Array.isArray(skip) && skip.length > 0 ? skip : [];
        const resumeCursor = sameKeyword && typeof cursor === 'string' && cursor !== '' ? cursor : '';
        // 两条引擎的续检凭据不同（skip / cursor），但「这一轮是续检」是同一件事：
        // 命中与已扫名单要累加而不是覆盖（FTS 翻页时 skip 恒为空，只看 carried 会把
        // 第一页的命中整片抹掉）。
        const continuing = carried.length > 0 || resumeCursor !== '';
        const params = new URLSearchParams({ q: keyword, limit: '3', includeTools: includeTools ? '1' : '0' });
        if (carried.length > 0) params.set('skip', carried.join(','));
        if (resumeCursor !== '') params.set('cursor', resumeCursor);
        const startedAt = Date.now();
        searchStartedAt.current = startedAt;
        fetchJson('/dsh-arcsess/search?' + params.toString(), controller === null ? undefined : { signal: controller.signal })
          .then((value) => {
            if (searchSeq.current !== seq) return;
            const payload = value !== null && typeof value === 'object' ? value : {};
            const results = Array.isArray(payload.results) ? payload.results : [];
            setContentResults((previous) => (continuing ? mergeResults(previous, results) : mergeResults(new Map(), results)));
            const scanned = Array.isArray(payload.scannedIds) ? payload.scannedIds : [];
            const pending = Array.isArray(payload.pendingIds) ? payload.pendingIds : [];
            setScannedIds((previous) => {
              const next = new Set(continuing ? previous : []);
              for (const id of scanned) next.add(id);
              return [...next];
            });
            setSearchInfo({
              engine: typeof payload.engine === 'string' ? payload.engine : 'literal',
              reason: typeof payload.engineReason === 'string' ? payload.engineReason : '',
              scanned: scanned.length,
              pending: pending.length,
              hits: results.length,
              errors: Array.isArray(payload.errors) ? payload.errors.length : 0,
              elapsedMs: typeof payload.elapsedMs === 'number' ? payload.elapsedMs : Date.now() - startedAt,
              truncated: payload.truncated === true,
              cursor: typeof payload.nextCursor === 'string' ? payload.nextCursor : '',
              keyword,
            });
          })
          .catch((reason) => {
            if (searchSeq.current !== seq) return;
            if (reason !== null && typeof reason === 'object' && reason.name === 'AbortError') return;
            setError(errorText(reason));
          })
          .then(() => {
            // 被更新的一代取代后不得收尾：否则检索中提示、秒表与按钮禁用态会
            // 提前结束（新一代还在跑），Enter 还能再叠一层并发检索。
            if (searchSeq.current !== seq) return;
            if (inflight.current === controller) inflight.current = null;
            setSearching(false);
          });
      };

      const clearSearch = () => {
        if (inflight.current !== null) inflight.current.abort();
        inflight.current = null;
        searchSeq.current += 1;
        setQuery('');
        setContentResults(new Map());
        setSearchInfo(null);
        setScannedIds([]);
        setSearching(false);
        setError(null);
        setNotice(null);
      };

      const restore = (sessionId, open) => {
        setBusy(sessionId);
        setError(null);
        setNotice(null);
        fetchJson('/dsh-arcsess/restore', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
          .then((result) => {
            if (result !== null && typeof result === 'object' && result.restored === false) {
              setNotice('该会话已不在归档集中');
              return;
            }
            setNotice(open ? '已恢复并打开会话' : '已恢复：侧边栏按原位置重新可见');
            if (open) {
              const uiWorkspace = props.ctx.uiWorkspace;
              if (uiWorkspace !== undefined && typeof uiWorkspace.openSession === 'function') {
                uiWorkspace.openSession(sessionId);
                return;
              }
              const sessions = props.ctx.get !== undefined ? props.ctx.get('sessions') : undefined;
              if (sessions !== undefined && typeof sessions.open === 'function') sessions.open(sessionId);
            }
          })
          // ── 多机会话状态同步（2026-10-19）───────────────────────────────────
          // 本机是副本（权威 orangepi5）时，dsh-device-mesh 每 30 s 从权威拉一次
          // 会话归档态：权威说 archived=true 而本地没有 → 重新归档。只走本插件的
          // /restore（直接改本地 registry）会被这轮同步**在 30 s 内撤销**——这就是
          // 「恢复按钮看似成功、会话很快又消失」的真实原因。出厂侧边栏的「归档」
          // 动作早就为此先送 /dsh-device-mesh/session-state/propose（dsh-client-ui-workspace
          // 的手补丁），「取消归档」/本插件恢复走同一条路：先落地本地，再送 propose
          // 把 unarchive 同步给权威（副本侧 propose 自己也会本地应用，幂等）。
          // 网格不在（404）或权威不可达（propose 的响应里 degraded）时恢复仍然成立，
          // 只是可能被下一轮同步收回——与出厂「归档」动作的降级语义一致。
          .then(() => fetch('/dsh-device-mesh/session-state/propose', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, action: 'unarchive' }),
          }).then((response) => {
            if (response.ok) return response.json();
            if (response.status === 404) return null; // 网格插件不在：纯单机部署，无需同步
            throw new Error('设备网格同步失败（HTTP ' + String(response.status) + '）');
          }).catch((reason) => {
            setError('已恢复，但同步到会话状态权威失败：' + errorText(reason) + '（多机部署下可能被权威同步重新归档）');
            return null;
          }))
          .then(() => fetchJson('/dsh-arcsess/list?fresh=1'))
          .then((value) => {
            // 与 load 走同一个入口：恢复掉的可能是当前筛选工作区的最后一个会话，
            // 筛选 key 随之消失，必须一起回落 all（否则列表空白 + select 值悬空）。
            applyList(value);
            setContentResults((previous) => {
              if (!previous.has(sessionId)) return previous;
              const next = new Map(previous);
              next.delete(sessionId);
              return next;
            });
          })
          .catch((reason) => setError(errorText(reason)))
          .then(() => setBusy(null));
      };

      // ── 删除历史记录（2026-10-19）──────────────────────────────────────────
      // 删的是磁盘上的会话日志（host 半边 /dsh-arcsess/delete 摘归档集 → 删
      // sessions 目录 → 清投影缓存）。只允许**未登记工作区**分组用（host 侧也
      // 会再校验：登记在册的工作区会话一律跳过，返回 skipped）。远程行不给
      // 这个入口——日志在别台设备，本机删不到。
      // 删完逐条送 mesh propose unarchive（与恢复同套路）：本机是副本时，
      // 权威 30 s 同步会把归档态盖回来，不送的话删掉的会话变成「日志已删除」
      // 的幽灵行。网格不在（404）时跳过。
      const deleteSessions = (ids) => {
        const targets = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id !== '') : [];
        if (targets.length === 0) return;
        setBusy('delete');
        setError(null);
        setNotice(null);
        fetchJson('/dsh-arcsess/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionIds: targets }),
        })
          .then(async (result) => {
            const payload = result !== null && typeof result === 'object' ? result : {};
            const deleted = Array.isArray(payload.deleted) ? payload.deleted : [];
            const skipped = Array.isArray(payload.skipped) ? payload.skipped : [];
            const failed = Array.isArray(payload.failed) ? payload.failed : [];
            // 网格归档态同步：逐条 propose，best-effort。
            for (const id of deleted) {
              try {
                await fetch('/dsh-device-mesh/session-state/propose', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ sessionId: id, action: 'unarchive' }),
                });
              } catch {
                /* 网格不在 / 权威不可达：删除本身已生效，只留提示 */
              }
            }
            const parts = [];
            if (deleted.length > 0) parts.push('已删除 ' + String(deleted.length) + ' 条历史记录');
            if (skipped.length > 0) parts.push(String(skipped.length) + ' 条属于已登记工作区，未删');
            if (failed.length > 0) parts.push(String(failed.length) + ' 条删除失败');
            setNotice(parts.join('；'));
            if (deleted.length === 0 && failed.length > 0) {
              setError('删除失败：' + failed.map((entry) => entry.id + '（' + entry.error + '）').join('；'));
            }
          })
          .catch((reason) => setError(errorText(reason)))
          .then(() => fetchJson('/dsh-arcsess/list?fresh=1'))
          .then((value) => applyList(value))
          .catch(() => { /* 刷新失败不覆盖删除结果的提示 */ })
          .then(() => setBusy(null));
      };

      const groups = buildGroups(data);
      // 命中片段属于「某一轮检索词」：只有输入框里还是那个词时才贴出来，
      // 否则「标题/路径」临时改词也会看到上一轮的片段与只靠内容命中的行。
      const hitsActive = searchInfo !== null && searchInfo.keyword === query.trim();
      const visible = visibleGroups(groups, {
        query,
        mode,
        contentResults: hitsActive ? contentResults : new Map(),
        workspaceFilter,
        sortKey,
      });
      const totalSessions = groups.reduce((acc, group) => acc + group.sessions.length, 0);
      const shownSessions = visible.reduce((acc, group) => acc + group.sessions.length, 0);
      const onContentMode = mode === 'content';
      const searchingElapsed = searching
        ? Math.max(0, Math.round((Date.now() - searchStartedAt.current) / 1000))
        : 0;
      const engineLabel = searchInfo === null
        ? ''
        : (searchInfo.engine === 'fts' ? '全文索引' : (searchInfo.engine === 'empty' ? '无归档会话' : '逐条扫描'));

      const toggleGroup = (key) => {
        setCollapsed((previous) => {
          const next = new Set(previous);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      };

      const rows = [];
      for (const group of visible) {
        const isCollapsed = collapsed.has(group.key);
        // ── 分组的本地/远程标识（两件事，分开标）──────────────────────────────
        // ① 执行端（属主）：「这个工作区」的本地/远程真相——文件与命令真正跑在
        //    哪台设备。权威是设备网格的 drivers 判定（与侧边栏 🌐 转发执行标示
        //    同源），按 workspaceId 匹配。本机 registry 会把「会话 cwd 落在
        //    某路径」记成本机工作区——互联会话（会话在本机跑、文件在属主那台）
        //    因此曾被错标「本机工作区」（2026-10-19 用户实测指出）。判定缺失
        //    （网格不在 / drivers 没这条）时**不标**——宁可不标也不错标。
        // ② 归档记录的账目（host mergeRemoteViews 的口径）：远程独有组
        //    remote:true、同名合并组 mixed——说的是**归档集写在哪台的 registry**，
        //    与①是两回事，用第二种颜色/文案呈现。
        const deviceParts = (group.devices || []).map((entry) => ({
          name: entry.name === null ? '远程设备' : entry.name,
          count: entry.count,
        }));
        const groupIsRemote = group.remote === true;
        const groupIsMixed = group.mixed === true || (groupIsRemote !== true && deviceParts.length > 0);
        const remoteTotal = (group.devices || []).reduce((acc, entry) => acc + entry.count, 0);
        const localTotal = group.sessions.length - remoteTotal;
        const owner = ownerOf(group);
        // 执行端标识：有判定才画。owner.isSelf=false 就是「远程工作区」（命令与
        // 文件在 owner.name 那台执行），哪怕它的会话、归档记录都在本机。
        const ownerMark = owner === null
          ? null
          : owner.isSelf
            ? { text: '本机工作区', cls: '', title: '这个工作区注册并执行在本机。' }
            : {
              text: '执行于 ' + (owner.name === null ? '远程设备' : owner.name),
              cls: ' arcsess-scopeRemote',
              title: '这个工作区的文件与命令在 ' + (owner.name === null ? '另一台设备' : owner.name)
                + ' 上执行（互联工作区：会话可以在这边跑，但落盘与命令都在属主那台；与侧边栏 🌐 标示同源）。',
            };
        // 账目标识：归档记录跨设备时才画（远程独有 / 两边各一份）。
        const accountMark = groupIsMixed
          ? {
            text: '归档记录 本机+' + (deviceParts.map((entry) => entry.name).join('、') || '远程') + '（本机 ' + String(localTotal) + ' / 远程 ' + String(remoteTotal) + '）',
            cls: ' arcsess-scopeMixed',
            title: '同一个工作区在多台设备上各有一份归档记录：本机与其它设备的归档会话合在这一组，行上再按设备区分。',
          }
          : groupIsRemote
            ? {
              text: '归档记录在 ' + (typeof group.deviceName === 'string' && group.deviceName !== '' ? group.deviceName : (deviceParts.map((entry) => entry.name).join('、') || '远程设备')),
              cls: ' arcsess-scopeRemote',
              title: '这个工作区只在其它设备的注册表里：归档集写在那台设备，本机没有写入口。',
            }
            : null;
        // 删除历史按钮：只给**未登记工作区**分组（fromHost=false）。已登记
        // 工作区的会话归工作区自己管（删槽位要动 sessionIds），本面板不越界；
        // 远程行（remote:true）的日志在别台设备，删不到，整组过滤掉再判。
        const deletable = group.fromHost !== true
          && group.sessions.some((session) => session.remote !== true);
        rows.push(h('section', { className: 'arcsess-group', key: group.key },
          h('div', { className: 'arcsess-grouprow' },
            h('button', {
              className: 'arcsess-grouphead',
              type: 'button',
              'aria-expanded': isCollapsed ? 'false' : 'true',
              onClick: () => toggleGroup(group.key),
            },
            h('span', { className: 'arcsess-caret' }, isCollapsed ? '▸' : '▾'),
            h('span', { className: 'arcsess-groupname' }, group.title),
            group.path !== '' ? h('span', { className: 'arcsess-grouppath' }, group.path) : null,
            group.fromHost ? null : h('span', { className: 'arcsess-tag' }, '未登记'),
            ownerMark === null ? null : h('span', {
              className: 'arcsess-tag arcsess-scope' + ownerMark.cls,
              title: ownerMark.title,
              key: 'owner-mark',
            }, ownerMark.text),
            accountMark === null ? null : h('span', {
              className: 'arcsess-tag arcsess-scope' + accountMark.cls,
              title: accountMark.title,
              key: 'account-mark',
            }, accountMark.text),
            h('span', { className: 'arcsess-count' }, String(group.sessions.length)),
            group.matched > 0 ? h('span', { className: 'arcsess-badge' }, '内容命中 ' + group.matched) : null,
            ),
            deletable ? h('button', {
              className: 'arcsess-btn arcsess-danger',
              type: 'button',
              disabled: busy !== null,
              title: '删除这个未登记工作区下全部会话的历史记录（磁盘日志，不可恢复）。属于已登记工作区或其它设备的会话不受影响。',
              onClick: (event) => {
                event.stopPropagation();
                const ids = group.sessions
                  .filter((session) => session.remote !== true)
                  .map((session) => session.id);
                if (ids.length === 0) return;
                const ok = typeof window === 'undefined' || window.confirm === undefined
                  ? true
                  : window.confirm('确定删除「' + group.title + '」下 ' + String(ids.length)
                    + ' 条会话的历史记录吗？磁盘上的会话日志会被永久删除，无法恢复。'
                    + '已登记工作区的会话不受影响。');
                if (ok) deleteSessions(ids);
              },
            }, busy === 'delete' ? '删除中…' : '删除历史') : null,
          ),
          isCollapsed ? null : group.sessions.map((session) => {
            const hits = session.hits;
            // 远程行（其它设备自己的归档会话，host 半边 v4/v5 起 /list 会合并进来）：
            // 归档集写在那台设备的 registry，本机 /restore 改不了它——按钮只会
            // 「看似成功」然后什么都没发生（restored:false）。给说明而不是假按钮；
            // 想恢复它去那台设备的设置页（或它的侧边栏）操作。
            const actions = session.remote === true
              ? [h('span', {
                className: 'arcsess-tag',
                title: '这条会话归档在 ' + (typeof session.deviceName === 'string' && session.deviceName !== '' ? session.deviceName : '另一台设备')
                  + ' 的归档集里，本机没有写入口；到那台设备的「归档会话」设置页恢复。',
                key: 'remote-note',
              }, '归档于 ' + (typeof session.deviceName === 'string' && session.deviceName !== '' ? session.deviceName : '远程设备'))]
              : [
                h('button', {
                  className: 'arcsess-btn', type: 'button', disabled: busy === session.id, onClick: () => restore(session.id, false),
                }, busy === session.id ? '处理中…' : '恢复'),
                h('button', {
                  className: 'arcsess-btn arcsess-primary', type: 'button', disabled: busy === session.id, onClick: () => restore(session.id, true),
                }, '恢复并打开'),
              ];
            return h('div', { className: 'arcsess-row', key: String(session.id) },
              h('div', { className: 'arcsess-info' },
                h('div', { className: 'arcsess-name' }, typeof session.title === 'string' && session.title !== '' ? session.title : String(session.id)),
                h('div', { className: 'arcsess-meta' }, [
                  typeof session.createdAt === 'number' ? new Date(session.createdAt).toLocaleString() : '创建时间未知',
                  typeof session.titleUpdatedAt === 'number' ? '活动 ' + new Date(session.titleUpdatedAt).toLocaleString() : '',
                  typeof session.cwd === 'string' && session.cwd !== '' ? session.cwd : '',
                  session.live === true ? '运行中' : (session.persisted === true ? '' : '日志已删除'),
                  typeof session.origin === 'string' && session.origin !== '' ? session.origin : '',
                  session.remote === true && typeof session.deviceName === 'string' && session.deviceName !== '' ? '设备 ' + session.deviceName : '',
                ].filter((part) => part !== '').join(' · ')),
                hits === undefined ? null : h('div', { className: 'arcsess-hits' },
                  hits.matches.map((match, index) => h('div', { className: 'arcsess-snip', key: 'm' + String(index) },
                    (match.type !== null && STATUS_LABEL[match.type] !== undefined ? STATUS_LABEL[match.type] + '·' : '') + ' ',
                    highlight(match.snippet, match.highlightStart, match.highlightEnd),
                  )),
                  hits.matchCount !== null && hits.matchCount > hits.matches.length
                    ? h('div', { className: 'arcsess-more', key: 'more' }, '共 ' + String(hits.matchCount) + ' 处命中')
                    : null,
                ),
              ),
              h('div', { className: 'arcsess-actions' }, actions),
            );
          }),
        ));
      }

      const workspaceOptions = [{ id: 'all', label: '全部工作区' }].concat(groups.map((group) => {
        // 下拉后缀说「执行端」（与组头同一判定源）：远程执行的工作区带「· 设备名」，
        // 归档记录跨设备再叠「归档记录…」。名字相同的工作区靠它分得开。
        const owner = ownerOf(group);
        const ownerSuffix = owner === null
          ? ''
          : (owner.isSelf ? '' : ' · ' + (owner.name === null ? '远程' : owner.name));
        const accountSuffix = group.remote === true
          ? ' · 归档在' + (typeof group.deviceName === 'string' && group.deviceName !== '' ? group.deviceName : '远程')
          : (group.mixed === true
            ? ' · 归档本机+' + (group.devices || []).map((entry) => entry.name === null ? '远程' : entry.name).join('、')
            : '');
        return {
          id: group.key,
          label: group.title + ownerSuffix + accountSuffix + '（' + String(group.sessions.length) + '）',
        };
      }));

      return h('div', { className: 'arcsess' },
        h('div', { className: 'arcsess-head' },
          h('div', null,
            h('div', { className: 'arcsess-title' }, '归档会话'),
            h('div', { className: 'arcsess-sub' }, '归档会话会从侧边栏的每个位置隐藏（工作区账目保留原槽位）。本页按工作区归类，支持标题/路径即时筛选与消息内容检索；恢复后会话按原位置重新出现。'),
          ),
          h('button', { className: 'arcsess-btn', type: 'button', onClick: () => load(true), disabled: loading }, loading ? '加载中…' : '刷新'),
        ),

        // 「是否在工作区列表显示归档会话」选择行（出厂 dsh-client-ui-workspace 注册，
        // 原在「通用设置」，2026-10-19 应用户要求挪进本节）。放在头部下方、工具栏
        // 上方——它是本节的入口性开关，且侧边栏「视图选项」菜单与它同步。
        renderSlot !== null ? h('div', { className: 'arcsess-children', key: 'children' },
          renderSlot('settings.arcsess.item', {})) : null,

        h('div', { className: 'arcsess-toolbar' },
          h('div', { className: 'arcsess-search' },
            h('input', {
              className: 'arcsess-input',
              type: 'search',
              value: query,
              placeholder: onContentMode ? '输入关键词后回车检索消息内容…' : '筛选标题 / 路径 / 会话 ID…',
              'aria-label': '归档会话检索',
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && onContentMode) runSearch([]);
                if (event.key === 'Escape') {
                  // 设置页外壳在 document 上监听 Escape 关整个面板：先清检索词，
                  // 只有输入框已空时才让 Escape 继续冒泡（否则一次 Escape 会连面板一起关）。
                  if (query === '') return;
                  event.stopPropagation();
                  clearSearch();
                }
              },
            }),
            query !== '' ? h('button', {
              className: 'arcsess-clear', type: 'button', title: '清空', 'aria-label': '清空检索词', onClick: clearSearch,
            }, '×') : null,
          ),
          h('div', { className: 'arcsess-modes', role: 'group', 'aria-label': '检索范围' },
            MODES.map((entry) => h('button', {
              key: entry.id,
              type: 'button',
              className: entry.id === mode ? 'arcsess-mode is-on' : 'arcsess-mode',
              'aria-pressed': entry.id === mode,
              onClick: () => setMode(entry.id),
            }, entry.label)),
          ),
          onContentMode ? h('button', {
            className: 'arcsess-btn arcsess-primary',
            type: 'button',
            disabled: searching,
            onClick: () => runSearch([]),
          }, searching ? '检索中…' : '检索内容') : null,
          h('select', {
            className: 'arcsess-select',
            value: workspaceFilter,
            'aria-label': '工作区筛选',
            onChange: (event) => setWorkspaceFilter(event.target.value),
          }, workspaceOptions.map((option) => h('option', { key: option.id, value: option.id }, option.label))),
          h('select', {
            className: 'arcsess-select',
            value: sortKey,
            'aria-label': '排序方式',
            onChange: (event) => setSortKey(event.target.value),
          }, SORTS.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label))),
          onContentMode ? h('label', { className: 'arcsess-check' },
            h('input', { type: 'checkbox', checked: includeTools, onChange: (event) => setIncludeTools(event.target.checked) }),
            '含工具输出',
          ) : null,
        ),

        error !== null ? h('div', { className: 'arcsess-error' }, error) : null,
        notice !== null ? h('div', { className: 'arcsess-notice' }, notice) : null,

        h('div', { className: 'arcsess-status' },
          // 分组账目按执行端分开说（与组头同一判定源：mesh drivers 的属主判定；
          // 判定缺失的组算「未判」）。让读者一眼分清这份清单里有几个工作区
          // 的文件与命令真正跑在本机。
          h('span', null, '共 ' + String(totalSessions) + ' 个归档会话 · '
            + String(groups.length) + ' 个分组（本机执行 ' + String(groups.filter((g) => { const o = ownerOf(g); return o !== null && o.isSelf; }).length)
            + ' · 远程执行 ' + String(groups.filter((g) => { const o = ownerOf(g); return o !== null && o.isSelf !== true; }).length)
            + '）· 显示 ' + String(shownSessions) + ' 个'),
          searching ? h('span', { className: 'arcsess-warn' }, '检索中… 已用 ' + String(searchingElapsed) + 's') : null,
          !searching && searchInfo !== null ? h('span', null,
            '内容检索「' + searchInfo.keyword + '」：' + String(searchInfo.hits) + ' 个会话命中 · 已扫描 ' + String(searchInfo.scanned) + ' 个'
            + (searchInfo.truncated ? '（还有 ' + String(searchInfo.pending) + ' 个未扫描）' : '')
            + ' · ',
            h('span', {
              className: 'arcsess-engine',
              role: 'note',
              tabIndex: 0,
              title: searchInfo.reason === '' ? undefined : searchInfo.reason,
              'aria-label': searchInfo.reason === '' ? engineLabel : engineLabel + '：' + searchInfo.reason,
            }, engineLabel),
            ' · ' + (searchInfo.elapsedMs / 1000).toFixed(1) + 's',
          ) : null,
          !searching && searchInfo !== null && searchInfo.errors > 0
            ? h('span', { className: 'arcsess-warn' }, String(searchInfo.errors) + ' 个会话读取失败')
            : null,
          !searching && searchInfo !== null && searchInfo.truncated && searchInfo.keyword === query.trim()
            ? h('button', {
              className: 'arcsess-btn',
              type: 'button',
              // 两条引擎的续检方式不同：全文索引翻页用游标，字面量扫描跳过已扫会话。
              onClick: () => runSearch(searchInfo.engine === 'fts' ? [] : scannedIds, searchInfo.cursor),
            }, '继续检索')
            : null,
          collapsed.size > 0 ? h('button', {
            className: 'arcsess-btn', type: 'button', onClick: () => setCollapsed(new Set()),
          }, '全部展开') : (visible.length > 0 ? h('button', {
            className: 'arcsess-btn', type: 'button', onClick: () => setCollapsed(new Set(visible.map((group) => group.key))),
          }, '全部折叠') : null),
        ),

        loading && data === null ? h('div', { className: 'arcsess-empty' }, '加载中…') : null,
        !loading && shownSessions === 0
          ? h('div', { className: 'arcsess-empty' }, totalSessions === 0
            ? '没有归档会话。'
            : (onContentMode && query.trim() !== ''
              ? '没有匹配的归档会话；「消息内容」范围需要点「检索内容」或回车才会扫描会话正文。'
              : '没有匹配的归档会话。'))
          : null,
        rows,
      );
    }

    const inject = ['slots', 'uiWorkspace'];

    function apply(ctx) {
      injectStyles();
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'arcsess',
          order: 900,
          label: '归档会话',
          // 子槽位（2026-10-19）：「是否在工作区列表显示归档会话」的选择行由出厂
          // dsh-client-ui-workspace 注册（settings.arcsess.item，id archived-filter，
          // store 就是侧边栏视图存储——改它侧边栏立即生效）。它原本注册在
          // settings.general.item（通用设置）里，应用户要求挪进本节；本节声明
          // children 并在自己的组件里 renderSlot 渲染它，注册侧只改了槽位名。
          children: { 'settings.arcsess.item': { kind: 'list', scope: 'root' } },
        },
        (ownerProps) => h(ArchivedSessions, {
          ctx,
          close: ownerProps && ownerProps.close,
          renderSlot: ownerProps && ownerProps.renderSlot,
        }),
      ));
    }

    exports.inject = inject;
    exports.apply = apply;
    exports.__test = {
      termsOf,
      matchSession,
      baseName,
      groupKeyOf,
      sortSessions,
      buildGroups,
      visibleGroups,
      highlight,
      PAGE_CSS,
    };
    return module.exports;
  },
});
