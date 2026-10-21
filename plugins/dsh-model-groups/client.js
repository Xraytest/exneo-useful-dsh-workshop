/**
 * 模型分组（dsh-model-groups）— 浏览器半边。
 *
 * 设置页新增「模型分组」一节（order 25，紧跟「模型能力」、在「重试策略」之前）：
 *   - 分组列表：名称 / id / 优先级 / 启用 / 描述 / ignoreCase / 成员；
 *   - 成员：(provider, model) 匹配式，provider 与 model 都可从真实模型目录里选，
 *     也支持 `*` / `?` 通配（批量输入里直接写 `localhost/qwen/*`）；
 *   - **每张分组卡可收起 / 展开**：开关是卡片**最左侧**的无杆箭头（chevron，收起朝右、
 *     展开朝下）。收起后这张卡只留一行「展示名称」，**不留任何修改入口**（没有输入框 /
 *     开关 / 上移 / 复制 / 删除，统计徽标也不显示）——长列表里把不关心的组压成一行，
 *     要改就先展开。展开态与旧版完全一致。
 *     折叠状态按**组 id** 落盘到 host（$DSH_HOME/model-groups-ui.json），
 *     刷新页面 / 重启 DSH / 换浏览器都还在；host 路由缺失时降级为「仅本次会话」；
 *   - 解析顺序条：按 (priority 升序, 声明顺序) 打印「1. 组 A → 2. 组 B → …」，
 *     未命中任何组的模型归入统计口径的「未分组」；
 *   - 试算：给定 provider/model，显示胜出组与全部被遮蔽的候选组（host 计算）；
 *   - 检查冲突：用 host 的真实模型目录核算每组的命中/被遮蔽/未归组（host 计算）；
 *   - 每组用量：读统计插件的 /dsh-usage/summary?by=group；统计侧未接入分组维度时
 *     这一列自动隐藏并给出提示（不报错）。
 *
 * 数据全部走本插件 host 半边的同源路由（静态插件没有动态包的 host.call）：
 *   GET  /dsh-model-groups/{state,audit,ui}
 *   POST /dsh-model-groups/{groups,resolve,ui}
 * 任何改动防抖 900ms 自动保存，保存后 host 强制重载快照 → 统计与重试即时生效。
 *
 * 由 package.json 的 dsh.client 声明装载（exports["./client"]）。
 *
 * @module dsh-model-groups/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-groups',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    /** 统计插件的「未分组」桶键（与 dsh-usage-stats 接入契约共用同一个常量）。 */
    const UNGROUPED_KEY = '__ungrouped__';
    const GROUP_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

    /**
     * 分组卡的**稳定标识**（uid）：与 id / name 等可编辑字段无关，加载 / 新建 / 复制时生成，
     * 只活在客户端。React key、折叠状态、批量框 ref 一律用它：
     *   - 不能用 group.id：id 就是输入框里的值，每敲一个字符 key 就变 → 整卡重挂载；
     *     输入框失焦后用户实际只能输入一个字符；
     *   - 不能用 index：↑↓ 排序后 React 按位置复用节点，会把不受控的批量子框内容带到错的卡。
     * 保存时它不在 buildPayload 的字段白名单里，不会发给 host。
     */
    let uidSeq = 0;
    const nextUid = () => 'u' + (++uidSeq);

    /** 给一批行补 uid（已有 uid 的原样保留，返回新数组）。host 数据进入本地状态的入口。 */
    function ensureUids(rows) {
      return (rows || []).map((row) => {
        if (row === null || typeof row !== 'object') return row;
        if (typeof row.uid === 'string' && row.uid !== '') return row;
        return Object.assign({}, row, { uid: nextUid() });
      });
    }

    const PAGE_CSS = [
      '.mgrp { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px 24px; color: var(--dsw-alias-label-primary); font-size: 13px; }',
      '.mgrp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }',
      '.mgrp-title { font-size: 15px; font-weight: 600; }',
      '.mgrp-sub { margin-top: 4px; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }',
      '.mgrp-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.mgrp-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; padding: 5px 12px; cursor: pointer; flex-shrink: 0; }',
      '.mgrp-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }',
      '.mgrp-btn:disabled { opacity: 0.5; cursor: default; }',
      '.mgrp-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }',
      '.mgrp-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }',
      '.mgrp-mini { padding: 2px 8px; font-size: 11px; }',
      '.mgrp-order { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 9px 12px; font-size: 11px; line-height: 1.9; color: var(--dsw-alias-label-secondary); }',
      '.mgrp-order b { color: var(--dsw-alias-label-primary); font-weight: 600; }',
      '.mgrp-chip { display: inline-block; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 1px 8px; margin-right: 4px; font-size: 11px; }',
      '.mgrp-warn { border: 1px solid var(--dsw-alias-state-warn-primary); border-radius: 8px; padding: 8px 10px; font-size: 11px; line-height: 1.8; color: var(--dsw-alias-state-warn-primary); }',
      '.mgrp-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); font-weight: 600; }',
      '.mgrp-notice { font-size: 12px; color: var(--dsw-alias-state-success-primary); }',
      '.mgrp-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }',
      '.mgrp-card.off { opacity: 0.62; }',
      '.mgrp-card-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.mgrp-card.collapsed { padding: 6px 10px; gap: 0; }',
      '.mgrp-chevron { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 16px; line-height: 1; padding: 2px 5px; border-radius: 6px; cursor: pointer; flex-shrink: 0; transition: transform 120ms ease; }',
      '.mgrp-chevron:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }',
      '.mgrp-chevron.open { transform: rotate(90deg); }',
      '.mgrp-card-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.mgrp-pos { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 1px 6px; flex-shrink: 0; }',
      '.mgrp-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.mgrp-label { font-size: 11px; color: var(--dsw-alias-label-secondary); min-width: 58px; flex-shrink: 0; }',
      '.mgrp-input { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 4px 8px; font-size: 12px; min-width: 0; }',
      '.mgrp-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
      '.mgrp-name { width: 170px; font-weight: 600; }',
      '.mgrp-id { width: 130px; font-family: monospace; font-size: 11px; }',
      '.mgrp-prio { width: 68px; font-variant-numeric: tabular-nums; }',
      '.mgrp-desc { flex: 1 1 240px; min-width: 160px; }',
      '.mgrp-provider { width: 160px; }',
      '.mgrp-model { flex: 1 1 220px; min-width: 150px; font-family: monospace; font-size: 11px; }',
      '.mgrp-member { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.mgrp-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.7; }',
      '.mgrp-batch { width: 100%; min-height: 52px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 6px 8px; font-size: 11px; font-family: monospace; resize: vertical; }',
      '.mgrp-spacer { flex: 1; }',
      '.mgrp-probe { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }',
      '.mgrp-hit { border: 1px solid var(--dsw-alias-brand-primary); border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.8; }',
      '.mgrp-nohit { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.mgrp-toggle { border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 2px 10px; font-size: 11px; cursor: pointer; }',
      '.mgrp-toggle.on { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }',
    ].join('\n');

    function injectStyles() {
      if (typeof document === 'undefined') return;
      const tagId = 'dsh-model-groups/page.css';
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-model-groups';
      tag.dataset.pluginCss = tagId;
      tag.textContent = PAGE_CSS;
      (document.head || document.documentElement).appendChild(tag);
    }

    /* ------------------------------------------------------------ 纯函数 ---- */

    const errorText = (error) => String(error && error.message ? error.message : error);
    const fmt = (n) => (typeof n === 'number' && n > 0 ? n.toLocaleString('en-US') : '0');

    function shortNum(n) {
      if (typeof n !== 'number' || n <= 0) return '0';
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
      return String(n);
    }

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok) throw new Error((body && body.error) || (response.status + ' ' + response.statusText));
      return body;
    }

    /** 解析次序：enabled 组按 (priority 升序, 声明顺序) 排；返回 id → order(1 起)。 */
    function orderOf(groups) {
      const map = {};
      const rows = [];
      for (let index = 0; index < (groups || []).length; index++) {
        const group = groups[index];
        if (group === null || typeof group !== 'object' || group.enabled === false) continue;
        rows.push({ id: group.id, index, priority: Number.isFinite(group.priority) ? group.priority : 100 });
      }
      rows.sort((a, b) => (a.priority - b.priority) || (a.index - b.index));
      for (let at = 0; at < rows.length; at++) map[rows[at].id] = at + 1;
      return map;
    }

    /** 生成一个未被占用的新组 id：g1 / g2 …（避免与既有 id 冲突）。 */
    function nextGroupId(groups) {
      const taken = new Set((groups || []).map((group) => group && group.id));
      for (let n = 1; n < 1000; n++) if (!taken.has('g' + n)) return 'g' + n;
      return 'g' + Date.now().toString(36);
    }

    function newGroup(groups) {
      return {
        uid: nextUid(),
        id: nextGroupId(groups), name: '新分组', description: '',
        enabled: true, priority: 100, ignoreCase: false, members: [],
      };
    }

    /**
     * 只保留会被 host 落盘的字段：自动保存的「是否已保存」比对不能被 order 之类的派生值污染。
     * uid 是客户端稳定标识，**故意不在白名单里**——绝不发给 host。
     */
    function buildPayload(groups) {
      return (groups || []).map((group) => ({
        id: typeof group.id === 'string' ? group.id.trim().toLowerCase() : '',
        name: typeof group.name === 'string' ? group.name : '',
        description: typeof group.description === 'string' ? group.description : '',
        enabled: group.enabled !== false,
        priority: Number.isFinite(Number(group.priority)) ? Math.trunc(Number(group.priority)) : 100,
        ignoreCase: group.ignoreCase === true,
        members: (Array.isArray(group.members) ? group.members : []).map((member) => ({
          provider: typeof member.provider === 'string' && member.provider.trim() !== '' ? member.provider.trim() : '*',
          model: typeof member.model === 'string' && member.model.trim() !== '' ? member.model.trim() : '*',
        })),
      }));
    }

    /**
     * 保存前的本地校验：id 缺失 / 非法 / 重复都会阻止 POST。
     * 判定口径与 buildPayload 完全一致（trim + 小写），否则会出现「界面觉得没问题、
     * host 却按自己的规则改名」的静默不一致：
     *   - 重复 id：host 把后一个改名（free → free-2）后仍回 200，界面若照旧显示旧 id 就是假象；
     *   - 缺失 / 非法 id：host 用组名 slug 兜底，同样是静默改名。
     * 所以这些情况一律不发 POST，改成在界面里明确报错，让用户自己改好。
     *
     * @returns {{blocked: boolean, reason: string, messages: string[],
     *            missing: number[], invalid: number[], duplicates: Array<{id: string, indexes: number[]}>}}
     */
    function validateGroups(groups) {
      const rows = Array.isArray(groups) ? groups : [];
      const ids = rows.map((group) => (group !== null && typeof group === 'object' && typeof group.id === 'string'
        ? group.id.trim().toLowerCase()
        : ''));
      const missing = [];
      const invalid = [];
      const positions = new Map();
      for (let index = 0; index < rows.length; index++) {
        if (ids[index] === '') { missing.push(index); continue; }
        if (!GROUP_ID_RE.test(ids[index])) { invalid.push(index); continue; }
        if (!positions.has(ids[index])) positions.set(ids[index], []);
        positions.get(ids[index]).push(index);
      }
      const duplicates = [];
      for (const [id, indexes] of positions) if (indexes.length > 1) duplicates.push({ id, indexes });
      duplicates.sort((a, b) => a.indexes[0] - b.indexes[0]);

      const at = (index) => '第 ' + (index + 1) + ' 个分组';
      const messages = [];
      for (const index of missing) messages.push(at(index) + '缺少 id：id 是统计与重试规则引用分组的标识，不填无法保存');
      for (const index of invalid) {
        messages.push(at(index) + '的 id「' + String(rows[index].id) + '」不合法：只允许小写字母或数字开头，其后可含小写字母、数字、. _ -');
      }
      for (const dup of duplicates) {
        messages.push('有 ' + dup.indexes.length + ' 个分组用了同一个 id「' + dup.id + '」（'
          + dup.indexes.map((index) => at(index)).join('、') + '）：保存会触发 host 静默改名，已阻止保存');
      }
      const reason = duplicates.length > 0
        ? '有 ' + duplicates[0].indexes.length + ' 个分组用了同一个 id「' + duplicates[0].id + '」'
        : (missing.length > 0 ? at(missing[0]) + '缺少 id'
          : (invalid.length > 0 ? at(invalid[0]) + '的 id 不合法' : ''));
      return { blocked: messages.length > 0, reason, messages, missing, invalid, duplicates };
    }

    /**
     * 把 host 返回的分组按**位置**合并回本地行（uid 原样保留）：
     * host 仍可能改掉 id（并发改名、超长截断等本地看不出来的情况），
     * 界面必须显示落盘后的真值，不能让用户继续看着旧 id。
     * 位置对不上（host 丢弃/截断过分组）时不动本地行，由调用方按落盘结果整体重载。
     *
     * @returns {{groups: Array, changed: boolean, adjustments: string[], countMismatch: boolean}}
     */
    function mergeHostGroups(local, host) {
      const rows = Array.isArray(local) ? local : [];
      const saved = Array.isArray(host) ? host : [];
      if (rows.length !== saved.length) {
        return {
          groups: rows,
          changed: false,
          countMismatch: true,
          adjustments: ['分组数从 ' + rows.length + ' 个变为 ' + saved.length + ' 个（host 会丢弃超限或非法的分组）'],
        };
      }
      const adjustments = [];
      const merged = rows.map((group, index) => {
        const returned = saved[index];
        if (returned === null || returned === undefined || typeof returned.id !== 'string') return group;
        const wanted = group !== null && typeof group === 'object' && typeof group.id === 'string' ? group.id.trim().toLowerCase() : '';
        if (returned.id === wanted) return group;
        adjustments.push('第 ' + (index + 1) + ' 个分组的 id 已被 host 调整为「' + returned.id + '」（原「' + wanted + '」）');
        return Object.assign({}, group, { id: returned.id });
      });
      return { groups: merged, changed: adjustments.length > 0, adjustments, countMismatch: false };
    }

    /* -------------------------------------------------- 折叠状态（持久化） ---- */

    /**
     * 折叠项的 id 长度上限：与 host 侧 `resolve.js` 的 `LIMITS.maxIdChars`（64）对齐。
     * 两边必须同一把尺子——客户端多收了超长 id，host 会在归一化时静默丢掉，
     * 客户端却以为「已经落盘」，于是每次 pagehide 都白冲一次 beacon。
     * 漂移由 `client-selftest.mjs` 的跨端一致性断言兜住（比对 ID_RE 与这个数）。
     */
    const UI_MAX_ID_CHARS = 64;

    /**
     * host 的 `ui.collapsed`（组 id 数组）→ 规范化的 id 列表。
     * 只认字符串、trim + 小写、去重 + 排序——与 host 侧 normalizeUiState 的口径一致
     * （含长度上限），这样「客户端派生键」与「host 落盘键」可以逐字符比较。
     * 宿主没有这半边（/state 无 ui 字段）时返回 []（= 全部展开）。
     *
     * 注意：这里**不做**「该 id 是否真有对应分组」的校验——那是 collapsedIdsOf 的事。
     * 两者语义不同，正是「加载时不回写」与「只写真实存在的组」的分工所在。
     */
    function collapsedIdsFromHost(ui) {
      const list = ui !== null && ui !== undefined && typeof ui === 'object' && Array.isArray(ui.collapsed)
        ? ui.collapsed
        : [];
      const out = new Set();
      for (const item of list) {
        if (typeof item !== 'string') continue;
        const id = item.trim().toLowerCase();
        if (id === '' || id.length > UI_MAX_ID_CHARS) continue;
        out.add(id);
      }
      return Array.from(out).sort();
    }

    /**
     * 界面当前的折叠集合 → 要落盘的 id 列表（去重 + 排序）。
     * 三条纪律：
     *   1. 键必须是**组 id**（内存里按 uid 记账只是为了「改 id 不失焦」）——
     *      uid 每次加载重新生成，落盘没有意义；
     *   2. 只收**合法 id**：合法性还没定下来的半截输入（`Bad ID`、空串）不落盘，
     *      否则文件里会留下永远匹配不上任何分组的项；
     *   3. 长度上限与 host 同口径（见 UI_MAX_ID_CHARS）。
     */
    function collapsedIdsOf(rows, collapsed) {
      const out = new Set();
      for (const row of rows || []) {
        if (row === null || typeof row !== 'object') continue;
        if (typeof row.uid !== 'string' || collapsed[row.uid] !== true) continue;
        const id = typeof row.id === 'string' ? row.id.trim().toLowerCase() : '';
        if (id === '' || id.length > UI_MAX_ID_CHARS || !GROUP_ID_RE.test(id)) continue;
        out.add(id);
      }
      return Array.from(out).sort();
    }

    /** 落盘的 id 列表 → 内存折叠表（按 uid 记账；找不到对应行的 id 直接忽略）。 */
    function collapsedMapOf(rows, ids) {
      const wanted = new Set(ids || []);
      const map = {};
      for (const row of rows || []) {
        if (row === null || typeof row !== 'object' || typeof row.uid !== 'string') continue;
        const id = typeof row.id === 'string' ? row.id.trim().toLowerCase() : '';
        if (id !== '' && wanted.has(id)) map[row.uid] = true;
      }
      return map;
    }

    /** 折叠键 ↔ id 列表：用 `\n` 连接（id 里不可能有换行，键可逐字符比较）。 */
    const collapsedKeyOf = (ids) => (ids === null ? null : ids.join('\n'));
    const idsOfCollapsedKey = (key) => (key === '' || key === null ? [] : key.split('\n'));

    /**
     * 批量成员文本 → 成员数组。每行一条，两种写法：
     *   `provider model`（空白分隔）
     *   `provider/model`（首个 `/` 之前是 provider；model 里的 `/` 与 `:` 原样保留）
     * `#` 开头与空行忽略；重复项去重。
     */
    function parseBatch(text) {
      const out = [];
      const seen = new Set();
      const issues = [];
      for (const rawLine of String(text === undefined || text === null ? '' : text).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) continue;
        let provider = '';
        let model = '';
        const spaced = /^(\S+)[\s]+(\S.*)$/.exec(line);
        if (spaced !== null) {
          provider = spaced[1];
          model = spaced[2];
        } else {
          const at = line.indexOf('/');
          if (at <= 0) { issues.push('无法解析：' + line); continue; }
          provider = line.slice(0, at);
          model = line.slice(at + 1);
        }
        if (provider === '' || model === '') { issues.push('无法解析：' + line); continue; }
        const key = provider + '\u0000' + model;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ provider, model });
      }
      return { members: out, issues };
    }

    /** 按目录里的每个供应商各建一个组（成员 = 该供应商的全部模型）。 */
    function groupsByProvider(catalog, groups) {
      const rows = [];
      const existing = new Set((groups || []).map((group) => group && group.id));
      for (const provider of providerGroupsOf(catalog)) {
        const models = Array.isArray(provider.models) ? provider.models : [];
        if (models.length === 0) continue;
        let id = String(provider.id || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '');
        if (id === '') id = nextGroupId(groups.concat(rows));
        // 与既有/本批已用 id 冲突时按 -2 / -3 … 顺延（与 host uniqueId 同款口径），
        // 否则会造出本地看不出来、host 却要静默改名的重复 id。
        if (existing.has(id)) {
          const base = id;
          for (let n = 2; n < 1000; n++) if (!existing.has(base + '-' + n)) { id = base + '-' + n; break; }
        }
        existing.add(id);
        rows.push({
          uid: nextUid(),
          id,
          name: (provider.name && provider.name !== provider.id ? provider.name : provider.id) + ' 全部模型',
          description: '',
          enabled: true,
          priority: 100,
          ignoreCase: false,
          members: models.map((model) => ({ provider: provider.id, model: model.id })),
        });
      }
      return rows;
    }

    const providerGroupsOf = (catalog) => (catalog !== null && catalog !== undefined && Array.isArray(catalog.groups) ? catalog.groups : []);

    function modelsOf(catalog, provider) {
      if (typeof provider !== 'string' || provider === '' || provider === '*') {
        const seen = new Set();
        const out = [];
        for (const group of providerGroupsOf(catalog)) {
          for (const model of (group.models || [])) {
            if (!seen.has(model.id)) { seen.add(model.id); out.push(model); }
          }
        }
        return out;
      }
      const found = providerGroupsOf(catalog).find((group) => group.id === provider);
      return found !== undefined && Array.isArray(found.models) ? found.models : [];
    }

    /** /dsh-usage/summary?by=group 的响应 → 组用量表；统计侧未接入时 available=false。 */
    function usageTable(payload) {
      if (payload === null || payload === undefined || payload.by !== 'group' || !Array.isArray(payload.rows)) {
        return { available: false, rows: {}, note: '统计插件（dsh-usage-stats）尚未接入 by=group 维度：本列暂不可用。接入后这里会显示每组的用量。' };
      }
      const rows = {};
      for (const row of payload.rows) {
        rows[row.key] = { total: row.total || 0, calls: row.calls || 0, sessions: row.sessions || 0, label: row.label || row.key };
      }
      return { available: true, rows, note: null };
    }

    const labelOf = (id, name) => (name && name !== id ? name + '（' + id + '）' : String(id));

    /* ------------------------------------------------------------ 组件 ---- */

    let pluginCtx = undefined;

    /**
     * hook 次序（client-selftest.mjs 按位置驱动，改动时同步更新）：
     *  0 groups  1 meta  2 catalog  3 error  4 notice  5 saveState
     *  6 probe   7 audit 8 usage    9 collapsed 10 uiError
     * effect 次序：0 挂载（拉 state + 模型目录 + pagehide/visibilitychange 冲刷 + 卸载补发）
     *              1 分组自动保存（防抖 900ms）
     *              2 折叠状态落盘（防抖 200ms，依赖 [collapsedKey, groupsBlocked]）
     */
    function ModelGroupsPage() {
      const ctx = pluginCtx;
      const [groups, setGroups] = React.useState(null);
      const [meta, setMeta] = React.useState(null);
      const [catalog, setCatalog] = React.useState(null);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [saveState, setSaveState] = React.useState('');
      const [probe, setProbe] = React.useState({ provider: '', model: '', result: null, busy: false });
      const [audit, setAudit] = React.useState(null);
      const [usage, setUsage] = React.useState(null);
      const [collapsed, setCollapsed] = React.useState({});
      const [uiError, setUiError] = React.useState('');

      const loadedRef = React.useRef(false);
      const lastSavedRef = React.useRef('');
      const timerRef = React.useRef(null);
      const batchRefs = React.useRef({});
      // 折叠状态持久化（host 文件）：wanted = 界面当前派生的键，saved = host 已确认落盘的键，
      // 两者不等就说明有未落盘的改动（页面隐藏时用 beacon 冲刷这一笔）。
      const uiWantedRef = React.useRef(null);
      const uiSavedRef = React.useRef(null);
      const uiTimerRef = React.useRef(null);
      const uiRunningRef = React.useRef(false);
      // uiFlush 定义在本函数靠后的位置：挂载 effect 的清理要调它，用 ref 拿最新引用
      // （useCallback([]) 身份稳定，这里只是避免「先用后定义」的阅读障碍）。
      const uiFlushRef = React.useRef(null);
      // 分组本体「还没落盘的那一笔编辑」（900ms 防抖窗口内）：卸载时补发 / 页面隐藏时 beacon。
      const pendingSaveRef = React.useRef(null);

      const applyState = React.useCallback((value) => {
        // 折叠状态：宿主把「分组 + 折叠」一起回给我们（一次请求还原上次的视图）。
        //
        // 基线必须取**派生值**（界面上真有这张卡、且 id 合法的那部分），不能取文件里的
        // 原始集合：文件里可能留着「当前不存在的组 id」（另一个标签页删过组、改过名，
        // 或有人手改过文件）。若基线取原始集合，那种情况下基线天然不等于比较键，
        // 于是**只是打开设置页**就会触发一次写盘，把孤儿项抹掉并吃掉一个 revision
        // ——既违背「加载时不回写」，又会在多标签页之间互相覆盖。孤儿项留着不动，
        // 下一次真实改动自然会重写整份集合。
        const uiIds = collapsedIdsFromHost(value.ui);
        const rows = ensureUids(buildPayload(value.groups || []));
        const known = collapsedMapOf(rows, uiIds);
        const baseline = collapsedKeyOf(collapsedIdsOf(rows, known));
        uiSavedRef.current = baseline;
        uiWantedRef.current = baseline;
        setCollapsed(known);
        // 折叠状态文件坏了（host 的 ui.warning）：页面得说一声，否则用户只看到
        // 「折叠莫名其妙全展开了」。它是**提示**不是错误——下一次改动就会自愈。
        const uiWarning = value.ui !== null && value.ui !== undefined && typeof value.ui.warning === 'string'
          ? value.ui.warning
          : '';
        setUiError(uiWarning === '' ? '' : '折叠状态文件不可用，已按「全部展开」显示：' + uiWarning);
        setGroups(rows);
        setMeta({ revision: value.revision || 0, warnings: value.warnings || [], path: value.path, exists: value.exists !== false });
      }, []);

      React.useEffect(() => {
        fetchJson('/dsh-model-groups/state')
          .then((value) => { applyState(value); })
          .catch((reason) => setError(errorText(reason)));
        Promise.resolve(ctx && ctx.remote && ctx.remote.session ? ctx.remote.session.modelCatalog() : null)
          .then((response) => {
            if (response === null || response === undefined) return;
            setCatalog(response.ok === true ? (response.value || {}) : {});
          })
          .catch(() => setCatalog({}));
        // 页面隐藏（刷新 / 关标签页 / 切后台）：防抖还没到点的那几笔用 sendBeacon
        // 冲出去——「收起分组后立刻刷新」不能丢状态，这是本功能的验收口径之一。
        // 覆盖两条通路：
        //   · pagehide —— 刷新 / 关标签页 / 前进后退（真正要卸载页面）；
        //   · visibilitychange → hidden —— 切标签页 / 手机切后台（pagehide 不保证触发）。
        const flushOnHide = () => {
          // 1) 有未落盘的折叠改动 → beacon 一发。
          const wanted = uiWantedRef.current;
          if (wanted !== null && wanted !== uiSavedRef.current
            && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
            try {
              const queued = navigator.sendBeacon(
                '/dsh-model-groups/ui',
                new Blob([JSON.stringify({ collapsed: idsOfCollapsedKey(wanted) })], { type: 'application/json' }),
              );
              // sendBeacon 队列满/被策略拒绝时返回 false 且**不会**发请求：那种情况下
              // 不能把基线标记成已落盘（否则这一笔再也没机会补发）。
              if (queued !== false) uiSavedRef.current = wanted;
            } catch { /* 冲刷失败：下次改动或下次加载自愈 */ }
          }
          // 2) 有未落盘的分组编辑（900ms 防抖）→ 同样 beacon 一发，别再丢一次编辑。
          const pending = pendingSaveRef.current;
          if (pending !== null && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
            try { pending.beacon(); } catch { /* 同上 */ }
          }
        };
        const onVisibility = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flushOnHide();
        };
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('pagehide', flushOnHide);
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibility);
        }
        return () => {
          // 卸载（关设置弹层 / 切到别的设置分节）也要冲刷，而且用**普通 fetch**——
          // 组件卸载并不等于页面卸载，请求不会被取消；这里清定时器前先补发，
          // 否则「收起后 200ms 内关掉设置页」会静默丢掉这一笔（实测确实会丢）。
          if (pendingSaveRef.current !== null && timerRef.current !== null) {
            const pending = pendingSaveRef.current;
            pendingSaveRef.current = null;
            clearTimeout(timerRef.current);
            timerRef.current = null;
            pending.send();
          }
          if (uiWantedRef.current !== null && uiWantedRef.current !== uiSavedRef.current
            && uiTimerRef.current !== null) {
            if (uiTimerRef.current !== null) { clearTimeout(uiTimerRef.current); uiTimerRef.current = null; }
            uiFlushRef.current();
          }
          if (timerRef.current !== null) clearTimeout(timerRef.current);
          if (uiTimerRef.current !== null) clearTimeout(uiTimerRef.current);
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('pagehide', flushOnHide);
          }
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility);
          }
        };
      }, [applyState, ctx]);

      const payloadOf = (rows) => JSON.stringify({ groups: buildPayload(rows) });

      // 防抖自动保存：首次加载不回写；保存成功只在 host 改了 id 时回写本地状态（见下）。
      // 本地校验不通过（id 缺失 / 非法 / 重复）时**一律不发 POST**：host 会静默改名后仍回
      // 200，界面却照旧显示旧 id——显示与落盘不一致比不保存更糟。改成错误态 + 明确文案。
      React.useEffect(() => {
        if (groups === null) return undefined;
        const check = validateGroups(groups);
        if (loadedRef.current !== true) {
          loadedRef.current = true;
          // 带病加载（例如手改过的配置文件）时不记「已保存」基线，改好后照常上报。
          lastSavedRef.current = check.blocked === true ? '' : payloadOf(groups);
        }
        if (check.blocked === true) {
          if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
          pendingSaveRef.current = null;      // 这一版不可落盘：别让卸载时的补发把它送上去
          setSaveState('blocked');
          return undefined;
        }
        const payload = payloadOf(groups);
        if (payload === lastSavedRef.current) {
          // 改回原样（或修好 id 后与落盘一致）：把错误态收回正常。
          pendingSaveRef.current = null;      // 已与落盘一致：没有待补发的编辑
          setSaveState((prev) => (prev === 'blocked' ? '' : prev));
          return undefined;
        }
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        const send = () => {
          setSaveState('saving');
          fetchJson('/dsh-model-groups/groups', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: payload,
          })
            .then((value) => {
              const returned = value !== null && value !== undefined && Array.isArray(value.groups) ? value.groups : null;
              if (returned === null) {
                // 响应里没有 groups（老 host / 异常）：按本次提交内容记账，行为同改动前。
                lastSavedRef.current = payloadOf(groups);
              } else if (returned.length !== groups.length) {
                // 位置对不上：按落盘结果整体重载，绝不假装本地就是落盘内容。
                lastSavedRef.current = payloadOf(returned);
                setGroups(ensureUids(buildPayload(returned)));
                setError('host 落盘后的分组数与本地不同（本地 ' + groups.length + ' 个 → 落盘 ' + returned.length
                  + ' 个）：已按落盘结果重新加载界面');
              } else {
                const merged = mergeHostGroups(groups, returned);
                lastSavedRef.current = payloadOf(returned);
                if (merged.changed === true) {
                  // 按位置合并回本地（uid 保留）：界面必须显示 host 落盘后的真值。
                  setGroups(merged.groups);
                  setNotice('⚠ ' + merged.adjustments.join('；'));
                }
              }
              setMeta((prev) => Object.assign({}, prev || {}, {
                revision: (value && value.revision) || 0,
                warnings: (value && value.warnings) || [],
              }));
              setSaveState('saved');
            })
            .catch((reason) => { setSaveState('error'); setError(errorText(reason)); });
        };
        // 把「这一笔还没落盘的编辑」登记出来：组件卸载（关设置弹层 / 切分节）时补发 fetch，
        // 页面卸载（pagehide）时改走 beacon —— 否则 900ms 防抖窗口内离开就静默丢编辑
        // （实测：改完优先级立刻关弹层 → host 侧仍是旧值）。登记的是本轮闭包里的 payload，
        // 每次 groups 变化都会重登记，因此永远是最新一笔。
        pendingSaveRef.current = {
          payload,
          send,
          beacon: () => {
            if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false;
            const queued = navigator.sendBeacon('/dsh-model-groups/groups', new Blob([payload], { type: 'application/json' }));
            // 与折叠状态那条路同规矩：beacon 队列满/被策略拒绝时返回 false 且**不会**发请求，
            // 那就不能把这一笔标记成「已送出去」——留着，等下一次 pagehide/visibilitychange 再试。
            if (queued !== false) pendingSaveRef.current = null;
            return queued !== false;
          },
        };
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          pendingSaveRef.current = null;
          send();
        }, 900);
        return () => { if (timerRef.current !== null) clearTimeout(timerRef.current); };
      }, [groups]);

      /* ------------------------------------------------ 折叠状态落盘 ---- */

      /**
       * 把界面当前的折叠集合写回 host。三条纪律：
       *   1. **串行**：同一时刻至多一个在途请求（避免两个 POST 乱序落盘，
       *      文件最后的赢家不是用户最后一次点的那一下）；
       *   2. 在途期间用户又改了 → 收尾时自动再写一次（最后一次改动一定落盘）；
       *   3. **失败只提示、不回滚界面**：折叠是视图偏好，写不进去不该影响编辑；
       *      失败后不自动重试（避免错误风暴），下一次改动会把整份集合一起带上去。
       */
      const uiFlush = React.useCallback(() => {
        if (uiRunningRef.current === true) return;
        const wanted = uiWantedRef.current;
        if (wanted === null || wanted === uiSavedRef.current) return;
        const ids = idsOfCollapsedKey(wanted);
        uiRunningRef.current = true;
        fetchJson('/dsh-model-groups/ui', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ collapsed: ids }),
        })
          .then(
            (value) => {
              // 以 host 的归一化结果为准（它可能丢掉非法项）：否则我们会一直以为还有没写完的改动。
              const returned = value !== null && value !== undefined && Array.isArray(value.collapsed) ? value.collapsed : ids;
              uiSavedRef.current = collapsedKeyOf(collapsedIdsFromHost({ collapsed: returned }));
              // host 回 200 但丢了项（issues，例如超长/非法 id）时必须说话：
              // 否则用户「收起了却下次加载又展开」，页面上没有任何线索。
              const issues = value !== null && value !== undefined && Array.isArray(value.issues) ? value.issues : [];
              setUiError(issues.length === 0
                ? ''
                : '折叠状态有 ' + issues.length + ' 项未被接受（' + issues[0] + '）');
            },
            (reason) => {
              setUiError('折叠状态未能保存：' + errorText(reason) + '（本次仍已在页面上生效；改动分组或再次收起/展开会重试）');
            },
          )
          .then(() => {
            uiRunningRef.current = false;
            // 在途期间界面又变了：接着写最后一版；失败时 wanted 不变，不会在这里空转重试。
            if (uiWantedRef.current !== wanted) uiFlush();
          });
      }, []);
      uiFlushRef.current = uiFlush;

      // 派生键：''=一个都没收起，null=还没加载完（加载完成前绝不写盘）。
      // 依赖只有这一个字符串：改名字、拖顺序、改成员都不会触发无谓的写盘，
      // 而「收起/展开」与「被收起的那张卡改了 id」都会让键变化 → 跟着更新落盘内容。
      const collapsedIds = groups === null ? null : collapsedIdsOf(groups || [], collapsed);
      const collapsedKey = collapsedKeyOf(collapsedIds);
      // 本地校验不通过（id 缺失/非法/重复）时分组本体根本不会落盘（见上面的自动保存）：
      // 此时它的 id 还不是「已落盘的 id」，按它记折叠会把收起意图挂到别的组上
      // （两张卡同 id 时尤其明显）。所以这里与分组保存同闸门：不可落盘就不写折叠。
      const groupsBlocked = groups !== null && validateGroups(groups).blocked === true;

      React.useEffect(() => {
        if (groupsBlocked === true) return undefined;   // 冻结折叠写盘，等分组本体可落盘再补
        uiWantedRef.current = collapsedKey;
        if (collapsedKey === null || collapsedKey === uiSavedRef.current) return undefined;
        if (uiTimerRef.current !== null) clearTimeout(uiTimerRef.current);
        // 防抖 200ms：收起/展开是离散动作，200ms 后落盘。更早离开的几条路径都有兜底：
        // 刷新/关标签页 → pagehide beacon；关设置弹层/切分节（组件卸载）→ 卸载时 fetch 补发。
        uiTimerRef.current = setTimeout(() => { uiTimerRef.current = null; uiFlush(); }, 200);
        return () => { if (uiTimerRef.current !== null) { clearTimeout(uiTimerRef.current); uiTimerRef.current = null; } };
      }, [collapsedKey, groupsBlocked, uiFlush]);

      const patchGroup = (index, patch) => setGroups((rows) => (rows || []).map((group, at) => (at === index ? Object.assign({}, group, patch) : group)));
      const moveGroup = (index, delta) => setGroups((rows) => {
        const list = (rows || []).slice();
        const to = index + delta;
        if (to < 0 || to >= list.length) return list;
        const moved = list.splice(index, 1)[0];
        list.splice(to, 0, moved);
        return list;
      });

      const loadAudit = () => {
        setAudit({ busy: true, value: null });
        fetchJson('/dsh-model-groups/audit?fresh=1')
          .then((value) => setAudit({ busy: false, value }))
          .catch((reason) => { setAudit({ busy: false, value: null }); setError(errorText(reason)); });
      };

      const loadUsage = () => {
        fetchJson('/dsh-usage/summary?by=group&range=all')
          .then((payload) => setUsage(usageTable(payload)))
          .catch(() => setUsage({ available: false, rows: {}, note: '统计插件不可用（/dsh-usage/summary 无响应）：分组用量暂不可见。' }));
      };

      const runProbe = () => {
        setProbe((prev) => Object.assign({}, prev, { busy: true, result: null }));
        fetchJson('/dsh-model-groups/resolve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: probe.provider, model: probe.model }),
        })
          .then((value) => setProbe((prev) => Object.assign({}, prev, { busy: false, result: value })))
          .catch((reason) => { setProbe((prev) => Object.assign({}, prev, { busy: false, result: null })); setError(errorText(reason)); });
      };

      const rows = groups || [];
      const order = orderOf(rows);
      const localCheck = validateGroups(rows);
      const providerGroups = providerGroupsOf(catalog);
      const usageAvailable = usage !== null && usage.available === true;
      const auditValue = audit !== null && audit.value !== null ? audit.value : null;
      const auditOf = (id) => {
        if (auditValue === null || !Array.isArray(auditValue.groups)) return null;
        return auditValue.groups.find((row) => row.id === id) || null;
      };

      /* ---------------------------------------------------------- header ---- */

      const header = h('div', { className: 'mgrp-head' },
        h('div', null,
          h('div', { className: 'mgrp-title' }, '模型分组'),
          h('div', { className: 'mgrp-sub' },
            '把 (供应商, 模型) 路由编成命名组——组成员可以来自多个供应商。'
            + '一个模型最多归属一个组：按「优先级小者优先、同级按列表顺序」解析，第一个命中的组胜出；'
            + '未命中任何组的模型在统计里归入「未分组」。分组同时供用量统计（按分组看用量）与重试策略（整组一套策略）消费。'),
        ),
        h('div', { className: 'mgrp-bar' },
          saveState === 'saving' ? h('span', { className: 'mgrp-meta' }, '自动保存中…') : null,
          saveState === 'saved' ? h('span', { className: 'mgrp-notice' }, '✓ 已保存并即时生效') : null,
          saveState === 'blocked' ? h('span', { className: 'mgrp-error' }, '⚠ 未保存：' + localCheck.reason + '（保存已阻止）') : null,
          saveState === 'error' ? h('span', { className: 'mgrp-error' }, '自动保存失败') : null,
          h('button', { className: 'mgrp-btn', onClick: () => { loadedRef.current = true; fetchJson('/dsh-model-groups/state').then(applyState).catch((reason) => setError(errorText(reason))); } }, '重新加载'),
          h('button', { className: 'mgrp-btn', onClick: loadUsage }, '刷新用量'),
          h('button', { className: 'mgrp-btn', disabled: audit !== null && audit.busy === true, onClick: loadAudit },
            audit !== null && audit.busy === true ? '检查中…' : '检查冲突'),
        ),
      );

      const statusLine = h('div', { className: 'mgrp-meta' },
        '配置 ' + ((meta && meta.path) || '—')
        + ' · 修订 ' + ((meta && meta.revision) || 0)
        + ' · ' + rows.length + ' 个组（' + Object.keys(order).length + ' 个参与解析）'
        + (usage !== null && usage.available === true ? ' · 用量已接入' : ''),
      );

      // 警告区 = 本地校验（⛔ 阻止保存的原因）+ host 的结构性警告（⚠），本地问题排在前面。
      const warnings = (meta && Array.isArray(meta.warnings) ? meta.warnings : []);
      const warnLines = localCheck.messages.map((text) => '⛔ ' + text).concat(warnings.map((text) => '⚠ ' + text));
      const warnBox = warnLines.length === 0 ? null : h('div', { className: 'mgrp-warn' },
        warnLines.map((text, at) => h('div', { key: 'w' + at }, text)),
      );

      const orderList = Object.keys(order)
        .map((id) => ({ id, order: order[id] }))
        .sort((a, b) => a.order - b.order);
      const orderBox = h('div', { className: 'mgrp-order' },
        h('b', null, '解析顺序：'),
        orderList.length === 0
          ? h('span', null, '（没有启用的分组——当前所有模型都归入「未分组」）')
          : orderList.map((row, at) => h('span', { key: row.id },
              at > 0 ? ' → ' : ' ',
              h('span', { className: 'mgrp-chip' }, row.order + '. ' + ((rows.find((group) => group.id === row.id) || {}).name || row.id)),
            )),
        h('div', null, '未命中以上任何一条的模型 → ', h('b', null, '未分组')),
      );

      /* ---------------------------------------------------------- 分组卡 ---- */

      const cards = rows.map((group, index) => {
        const models = modelsOf(catalog, group);
        // 稳定标识：卡片 key、折叠、批量框 ref 都用它。行永远带 uid（所有入口都过
        // ensureUids / newGroup / groupsByProvider / 复制），兜底只为防御性渲染。
        // 兜底键只防「uid 意外缺失」导致 React key 为 undefined（当前不可达：所有写 groups
        // 的入口都过 ensureUids）。注意它与 collapsedIdsOf 的口径不同——'idx-N' 不是稳定
        // 身份（排序后会串位），所以那种行**不参与折叠落盘**，宁可少记也不记错。
        const uid = typeof group.uid === 'string' && group.uid !== '' ? group.uid : 'idx-' + index;
        // 下面三项是 host / 统计侧的**落盘口径**，按 id 取（不能改成 uid）：
        // 解析次序、目录审计、用量统计的行键都是 id。
        const auditRow = auditOf(group.id);
        const used = usageAvailable ? usage.rows[group.id] : null;
        const localId = typeof group.id === 'string' ? group.id.trim().toLowerCase() : '';
        const dupWith = localCheck.duplicates.find((dup) => dup.id === localId && dup.indexes.indexOf(index) !== -1);
        const idProblem = localId === ''
          ? '缺 id：不填无法保存'
          : (!GROUP_ID_RE.test(localId)
            ? 'id 不合法：只能小写字母/数字开头，其后可含小写字母、数字、. _ -'
            : (dupWith === undefined
              ? ''
              : 'id 与第 ' + dupWith.indexes.filter((at) => at !== index).map((at) => at + 1).join('、') + ' 个分组重复：保存已阻止'));
        const isCollapsed = collapsed[uid] === true;
        const memberRows = (group.members || []).map((member, at) => {
          const choices = modelsOf(catalog, member.provider);
          const knownProvider = member.provider === '*' || providerGroups.some((entry) => entry.id === member.provider);
          const knownModel = member.model === '*' || choices.some((entry) => entry.id === member.model);
          const modelChoices = member.provider === '*' || member.provider === '' ? modelsOf(catalog, '*') : choices;
          const knownInList = member.model === '*' || modelChoices.some((entry) => entry.id === member.model);
          return h('div', { className: 'mgrp-member', key: 'm' + at },
            h('span', { className: 'mgrp-label' }, at === 0 ? '成员' : ''),
            providerGroups.length > 0
              ? h('select', {
                  className: 'mgrp-input mgrp-provider', value: member.provider,
                  onChange: (event) => {
                    const provider = event.target.value;
                    const nextModels = modelsOf(catalog, provider);
                    const keep = member.model === '*' || nextModels.some((entry) => entry.id === member.model);
                    const members = (group.members || []).slice();
                    members[at] = { provider, model: keep ? member.model : '*' };
                    patchGroup(index, { members });
                  },
                },
                  h('option', { value: '*' }, '*（任意供应商）'),
                  !knownProvider && member.provider !== '*' ? h('option', { value: member.provider }, member.provider + '（目录外）') : null,
                  providerGroups.map((entry) => h('option', { key: entry.id, value: entry.id }, labelOf(entry.id, entry.name))),
                )
              : h('input', {
                  className: 'mgrp-input mgrp-provider', value: member.provider, placeholder: 'provider（* = 任意）',
                  onChange: (event) => {
                    const members = (group.members || []).slice();
                    members[at] = Object.assign({}, member, { provider: event.target.value });
                    patchGroup(index, { members });
                  },
                }),
            modelChoices.length > 0
              ? h('select', {
                  className: 'mgrp-input mgrp-model', value: member.model,
                  onChange: (event) => {
                    const members = (group.members || []).slice();
                    members[at] = Object.assign({}, member, { model: event.target.value });
                    patchGroup(index, { members });
                  },
                },
                  h('option', { value: '*' }, '*（该供应商全部模型）'),
                  !knownInList && member.model !== '*' ? h('option', { value: member.model }, member.model + '（通配/目录外）') : null,
                  modelChoices.map((entry) => h('option', { key: entry.id, value: entry.id }, labelOf(entry.id, entry.name))),
                )
              : h('input', {
                  className: 'mgrp-input mgrp-model', value: member.model, placeholder: 'model（* 或 qwen/* 这类通配）',
                  onChange: (event) => {
                    const members = (group.members || []).slice();
                    members[at] = Object.assign({}, member, { model: event.target.value });
                    patchGroup(index, { members });
                  },
                }),
            !knownModel && member.model !== '*' ? h('span', { className: 'mgrp-meta' }, '（目录外/通配）') : null,
            h('button', {
              className: 'mgrp-btn mgrp-danger mgrp-mini',
              onClick: () => patchGroup(index, { members: (group.members || []).filter((_, keep) => keep !== at) }),
              title: '删除该成员',
            }, '×'),
          );
        });

        const badgeParts = [];
        if (auditRow !== null) {
          badgeParts.push('目录命中 ' + auditRow.matched.length + ' 个模型');
          if (auditRow.shadowed.length > 0) badgeParts.push('被前面的组遮蔽 ' + auditRow.shadowed.length + ' 个');
          if (auditRow.empty === true) badgeParts.push('（目录里没有模型命中该组）');
        }
        if (used !== undefined && used !== null) badgeParts.push('用量 ' + shortNum(used.total) + ' tokens · ' + fmt(used.calls) + ' 次');

        // 卡片**最左侧**的折叠开关：一个无杆箭头（chevron）。收起时朝右（› = 可展开），
        // 展开时原地转 90° 朝下。旧版是右上角一个「收起 / 展开」文字按钮。
        const chevron = h('button', {
          className: 'mgrp-chevron' + (isCollapsed ? '' : ' open'),
          'aria-expanded': isCollapsed ? 'false' : 'true',
          'aria-label': isCollapsed ? '展开分组' : '收起分组',
          title: isCollapsed ? '展开分组' : '收起分组',
          onClick: () => setCollapsed((prev) => Object.assign({}, prev, { [uid]: !isCollapsed })),
        }, '›');

        const cardClass = 'mgrp-card' + (group.enabled === false ? ' off' : '') + (isCollapsed ? ' collapsed' : '');

        // 收起的卡只留「展示名称」一行，并且**不给任何修改入口**：没有输入框、没有开关、
        // 没有上移 / 复制 / 删除、也不显示统计徽标——想改就先展开。这是「收拢得更彻底」
        // 的全部含义；id 挂在 title 上，悬停仍看得到。
        if (isCollapsed) {
          const title = group.name !== undefined && group.name !== null && String(group.name) !== ''
            ? String(group.name)
            : (group.id !== '' ? String(group.id) : '（未命名）');
          return h('div', { className: cardClass, key: uid, 'data-uid': uid },
            h('div', { className: 'mgrp-card-head' },
              chevron,
              h('span', {
                className: 'mgrp-card-title',
                title: group.id !== '' ? 'id: ' + group.id : 'id 未填写',
              }, title),
            ),
          );
        }

        return h('div', { className: cardClass, key: uid, 'data-uid': uid },
          h('div', { className: 'mgrp-card-head' },
            chevron,
            h('span', { className: 'mgrp-pos' }, order[group.id] !== undefined ? '#' + order[group.id] : '—'),
            h('input', {
              className: 'mgrp-input mgrp-name', value: group.name, placeholder: '组名',
              onChange: (event) => patchGroup(index, { name: event.target.value }),
            }),
            h('input', {
              className: 'mgrp-input mgrp-id', value: group.id, placeholder: 'id',
              title: '规则/接口引用的稳定标识：小写字母数字与 . _ -（重试规则用 group: <id> 引用）',
              onChange: (event) => patchGroup(index, { id: event.target.value }),
            }),
            idProblem === '' ? null : h('span', { className: 'mgrp-error' }, idProblem),
            h('span', { className: 'mgrp-spacer' }),
            h('span', { className: 'mgrp-meta' }, '优先级'),
            h('input', {
              className: 'mgrp-input mgrp-prio', type: 'number', min: 0, max: 9999, value: group.priority,
              title: '数值小者先解析（同级按列表顺序）', onChange: (event) => patchGroup(index, { priority: event.target.value === '' ? 100 : Number(event.target.value) }),
            }),
            h('button', {
              className: 'mgrp-toggle' + (group.enabled !== false ? ' on' : ''),
              onClick: () => patchGroup(index, { enabled: group.enabled === false }),
              title: '停用的组不参与解析',
            }, group.enabled !== false ? '启用' : '停用'),
            h('button', {
              className: 'mgrp-toggle' + (group.ignoreCase === true ? ' on' : ''),
              onClick: () => patchGroup(index, { ignoreCase: group.ignoreCase !== true }),
              title: '开启后 provider/model 比较不区分大小写（目录里存在 DeepSeek-V4.1-Flash 与 deepseek-v4.1-flash 这类大小写变体时有用）',
            }, '忽略大小写'),
            h('button', { className: 'mgrp-btn mgrp-mini', title: '上移', disabled: index === 0, onClick: () => moveGroup(index, -1) }, '↑'),
            h('button', { className: 'mgrp-btn mgrp-mini', title: '下移', disabled: index === rows.length - 1, onClick: () => moveGroup(index, 1) }, '↓'),
            h('button', {
              className: 'mgrp-btn mgrp-mini', title: '复制该组',
              onClick: () => setGroups((list) => {
                const next = (list || []).slice();
                const clone = JSON.parse(JSON.stringify(group));
                clone.uid = nextUid();          // 副本是一张新卡：换新 uid，不能沿用原卡的
                clone.id = nextGroupId(next);
                clone.name = group.name + ' 副本';
                next.splice(index + 1, 0, clone);
                return next;
              }),
            }, '复制'),
            h('button', {
              className: 'mgrp-btn mgrp-danger mgrp-mini',
              onClick: () => {
                if (typeof window !== 'undefined' && typeof window.confirm === 'function' && window.confirm('删除分组「' + group.name + '」？') !== true) return;
                setGroups((list) => (list || []).filter((_, keep) => keep !== index));
              },
            }, '删除'),
          ),
          h('div', { className: 'mgrp-row' },
            h('span', { className: 'mgrp-label' }, '描述'),
            h('input', {
              className: 'mgrp-input mgrp-desc', value: group.description || '', placeholder: '可选：这组是干什么的',
              onChange: (event) => patchGroup(index, { description: event.target.value }),
            }),
          ),
          badgeParts.length > 0 ? h('div', { className: 'mgrp-meta' }, badgeParts.join(' · ')) : null,
          isCollapsed ? null : h('div', { className: 'mgrp-row' },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', width: '100%' } },
              memberRows.length === 0 ? h('div', { className: 'mgrp-meta' }, '还没有成员——空组不会命中任何模型。') : memberRows,
              h('div', { className: 'mgrp-row' },
                h('button', {
                  className: 'mgrp-btn mgrp-mini',
                  onClick: () => patchGroup(index, { members: (group.members || []).concat([{ provider: providerGroups.length > 0 ? providerGroups[0].id : '*', model: '*' }]) }),
                }, '＋ 添加成员'),
                h('span', { className: 'mgrp-meta' }, 'provider / model 都可留 * 或写通配（qwen/* 、?）'),
              ),
              h('div', { className: 'mgrp-row' },
                h('textarea', {
                  className: 'mgrp-batch', placeholder: '批量添加：每行一条，`provider model` 或 `provider/model`（支持通配），# 开头忽略',
                  // ref 按 uid 记账：改 id 或 ↑↓ 换位后，批量框仍然只属于自己这张卡。
                  ref: (node) => { batchRefs.current[uid] = node; },
                }),
                h('button', {
                  className: 'mgrp-btn mgrp-mini',
                  onClick: () => {
                    const node = batchRefs.current[uid];
                    const text = node !== undefined && node !== null && typeof node.value === 'string' ? node.value : '';
                    const parsed = parseBatch(text);
                    if (parsed.issues.length > 0) setError('批量解析：' + parsed.issues.slice(0, 3).join('；'));
                    else setError('');
                    if (parsed.members.length === 0) return;
                    const members = (group.members || []).slice();
                    const seen = new Set(members.map((member) => member.provider + '\u0000' + member.model));
                    let added = 0;
                    for (const member of parsed.members) {
                      const key = member.provider + '\u0000' + member.model;
                      if (seen.has(key)) continue;
                      seen.add(key);
                      members.push(member);
                      added++;
                    }
                    if (node !== undefined && node !== null) node.value = '';
                    setNotice('已添加 ' + added + ' 个成员到「' + group.name + '」');
                    patchGroup(index, { members });
                  },
                }, '应用批量'),
              ),
              auditRow !== null && auditRow.matched.length > 0
                ? h('div', { className: 'mgrp-meta' }, '目录命中示例：' + auditRow.matched.slice(0, 4).map((entry) => entry.provider + '/' + entry.model).join('、') + (auditRow.matched.length > 4 ? ' …' : ''))
                : null,
            ),
          ),
        );
      });

      /* ----------------------------------------------------------- 试算 ---- */

      const probeWinner = probe.result !== null && probe.result !== undefined ? probe.result.winner : null;
      const probeCandidates = probe.result !== null && probe.result !== undefined && Array.isArray(probe.result.candidates) ? probe.result.candidates : [];
      const probeBox = h('div', { className: 'mgrp-probe' },
        h('div', { className: 'mgrp-row' },
          h('span', { className: 'mgrp-title', style: { fontSize: '13px' } }, '试算归属'),
          h('span', { className: 'mgrp-meta' }, '给定一个 (供应商, 模型)，看它落到哪个组——由 host 用真实解析逻辑计算'),
        ),
        h('div', { className: 'mgrp-row' },
          h('span', { className: 'mgrp-label' }, '供应商'),
          providerGroups.length > 0
            ? h('select', {
                className: 'mgrp-input mgrp-provider', value: probe.provider,
                onChange: (event) => setProbe((prev) => Object.assign({}, prev, { provider: event.target.value, model: '', result: null })),
              },
                h('option', { value: '' }, '（选择…）'),
                providerGroups.map((entry) => h('option', { key: entry.id, value: entry.id }, labelOf(entry.id, entry.name))),
              )
            : h('input', { className: 'mgrp-input mgrp-provider', value: probe.provider, placeholder: 'provider', onChange: (event) => setProbe((prev) => Object.assign({}, prev, { provider: event.target.value })) }),
          h('span', { className: 'mgrp-label' }, '模型'),
          modelsOf(catalog, probe.provider).length > 0
            ? h('select', {
                className: 'mgrp-input mgrp-model', value: probe.model,
                onChange: (event) => setProbe((prev) => Object.assign({}, prev, { model: event.target.value, result: null })),
              },
                h('option', { value: '' }, '（选择…）'),
                modelsOf(catalog, probe.provider).map((entry) => h('option', { key: entry.id, value: entry.id }, labelOf(entry.id, entry.name))),
              )
            : h('input', { className: 'mgrp-input mgrp-model', value: probe.model, placeholder: 'model', onChange: (event) => setProbe((prev) => Object.assign({}, prev, { model: event.target.value })) }),
          h('button', { className: 'mgrp-btn mgrp-primary', disabled: probe.busy === true || (probe.provider === '' && probe.model === ''), onClick: runProbe }, probe.busy === true ? '计算中…' : '试算'),
        ),
        probe.result === null || probe.result === undefined
          ? null
          : (probeWinner === null
              ? h('div', { className: 'mgrp-nohit' }, '不属于任何分组 → 统计口径里的「未分组」。')
              : h('div', { className: 'mgrp-hit' },
                  h('div', null, '归属：', h('b', null, probeWinner.groupName), '（id ' + probeWinner.groupId + '，解析次序 #' + probeWinner.order + '）'),
                  h('div', { className: 'mgrp-meta' }, '命中成员：' + probeWinner.member.provider + ' / ' + probeWinner.member.model),
                  probeCandidates.length > 1
                    ? h('div', { className: 'mgrp-meta' }, '同时命中但被遮蔽：' + probeCandidates.slice(1).map((row) => row.groupName + '(#' + row.order + ')').join('、') + '——把该组优先级调小即可改变归属')
                    : null,
                )),
      );

      /* ---------------------------------------------------------- 审计块 ---- */

      const auditBox = auditValue === null ? null : h('div', { className: 'mgrp-order' },
        h('b', null, '目录核算：'),
        auditValue.catalog !== null && auditValue.catalog !== undefined && auditValue.catalog.available === false
          ? h('span', null, '（无法枚举模型目录：' + (auditValue.catalog.error || '未知原因') + '）')
          : h('span', null,
              '供应商 ' + ((auditValue.catalog && auditValue.catalog.providers) || 0) + ' 个 · 模型 ' + ((auditValue.catalog && auditValue.catalog.routes) || 0) + ' 个 · '
              + '未归组 ' + ((auditValue.ungrouped && auditValue.ungrouped.length) || 0) + ' 个 · '
              + '同时命中多组 ' + ((auditValue.overlaps && auditValue.overlaps.length) || 0) + ' 个'),
        auditValue.overlaps !== undefined && Array.isArray(auditValue.overlaps) && auditValue.overlaps.length > 0
          ? h('div', null, '重叠示例：' + auditValue.overlaps.slice(0, 3).map((row) => row.provider + '/' + row.model + ' → ' + row.winner + '（另命中 ' + row.also.join('、') + '）').join('；'))
          : null,
        auditValue.ungrouped !== undefined && Array.isArray(auditValue.ungrouped) && auditValue.ungrouped.length > 0
          ? h('div', null, '未归组示例：' + auditValue.ungrouped.slice(0, 4).map((row) => row.provider + '/' + row.model).join('、') + (auditValue.ungrouped.length > 4 ? ' …' : ''))
          : null,
      );

      const usageNote = usage !== null && usage.available !== true ? h('div', { className: 'mgrp-meta' }, usage.note) : null;

      return h('div', { className: 'mgrp' },
        header,
        statusLine,
        warnBox,
        orderBox,
        h('div', { className: 'mgrp-bar' },
          h('button', {
            className: 'mgrp-btn mgrp-primary',
            onClick: () => setGroups((list) => (list || []).concat([newGroup(list || [])])),
            disabled: rows.length >= 64,
          }, '＋ 新建分组'),
          h('button', {
            className: 'mgrp-btn',
            disabled: providerGroups.length === 0,
            title: providerGroups.length === 0 ? '模型目录不可用' : '为目录里的每个供应商建一个「该供应商全部模型」的组',
            onClick: () => {
              const added = groupsByProvider(catalog, rows);
              if (added.length === 0) { setError('模型目录为空，无法按供应商建组'); return; }
              setGroups((list) => (list || []).concat(added));
              setNotice('已按供应商新建 ' + added.length + ' 个组');
            },
          }, '按供应商快速建组'),
          h('span', { className: 'mgrp-spacer' }),
          h('span', { className: 'mgrp-meta' }, '改动自动保存（防抖 900ms）'),
        ),
        error !== '' ? h('div', { className: 'mgrp-error' }, error) : null,
        // 折叠状态写盘失败（host 路由缺失 / 网络错）：只提示，界面里的折叠照旧生效。
        uiError !== '' ? h('div', { className: 'mgrp-error' }, uiError) : null,
        // 「⚠ 开头」的提示（如 host 调整过 id）用警告色，不要冒充成功提示。
        notice !== '' ? h('div', { className: notice.indexOf('⚠') === 0 ? 'mgrp-warn' : 'mgrp-notice' }, notice) : null,
        groups === null ? h('div', { className: 'mgrp-meta' }, '加载中…') : null,
        groups !== null && rows.length === 0 ? h('div', { className: 'mgrp-meta' }, '还没有分组。可以「按供应商快速建组」起步，再改名、调优先级、加通配成员。') : null,
        cards,
        probeBox,
        auditBox,
        usageNote,
      );
    }

    const inject = ['slots', 'remote', 'remote.session'];

    function apply(ctx) {
      pluginCtx = ctx;
      injectStyles();
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'model-groups', order: 25, label: '模型分组' },
        (ownerProps) => h(ModelGroupsPage, { close: ownerProps && ownerProps.close }),
      ));
    }

    exports.inject = inject;
    exports.apply = apply;

    // 供 client-selftest.mjs 无头驱动：纯函数与常量直接可用，组件按 hook 次序渲染。
    exports.__ui = {
      css: PAGE_CSS,
      UNGROUPED_KEY, GROUP_ID_RE,
      orderOf, nextGroupId, newGroup, buildPayload, parseBatch, groupsByProvider,
      modelsOf, providerGroupsOf, usageTable, shortNum, fmt, labelOf,
      nextUid, ensureUids, validateGroups, mergeHostGroups,
      collapsedIdsFromHost, collapsedIdsOf, collapsedMapOf, collapsedKeyOf, idsOfCollapsedKey, UI_MAX_ID_CHARS,
      hookLayout: ['groups', 'meta', 'catalog', 'error', 'notice', 'saveState', 'probe', 'audit', 'usage', 'collapsed', 'uiError'],
      Page: ModelGroupsPage,
    };
    return module.exports;
  },
});
