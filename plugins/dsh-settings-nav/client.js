/**
 * dsh-settings-nav —— 浏览器半边。
 *
 * 一句话：**把设置页左侧那一列「设置项」变成可分组、可折叠收纳、可自由排序的导航**，
 * 并在设置页里新增「设置导航」一节作为管理面。布局由 host 半边落盘
 * （`$DSH_HOME/settings-nav.json`），这里只负责「把它读回来 → 作用到导航 DOM 上」。
 *
 * ── 为什么必须在 DOM 上做（**这是本文件最重要的结论，别试图改回「顶掉设置壳」**）──
 * 一开始的设计是：注册 `sidebar.settings`（single 槽位）用一个更低 priority 顶掉出厂的
 * `SettingsRoot`，自己渲染整列导航 → 分组/排序天然是 React 状态。
 * 读过 SlotCore 与渲染器（dsh-client-ui-renderer）的实现后，这条路**能顶掉槽位、却什么都
 * 渲染不出来**（注意：准确说法是「顶出来没用」，不是「顶不掉」——我一度写成前者）：
 *   ① `SlotCore.register` 对 single 槽位：**同一 priority 上已有人 → 直接 throw**
 *      （"single slot … already has a registration … register at a different priority to
 *      shadow it (lowest renders)"）——用更低优先级**确实能赢**：渲染取
 *      `entriesOfSlot(key)[0]`，core 按 priority 升序排；
 *   ② `renderSlot` 这个 prop **只发给「自己声明了 children」的注册**
 *      （renderer 的 standardKit：`if (entry.children !== void 0) kit.renderSlot = …`），
 *      而 `register()` 在 children 里出现**别人已声明**的槽位时**也会 throw**
 *      （"slot X is already declared (by Y)"）；
 *   ③ `settings.section` / `settings.trigger` / … 已被出厂壳的注册声明；只有**释放**
 *      （dispose）那份注册才会解除声明（releaseEntry 会把 spec 置空并递归释放），
 *      而别人的注册我们无权释放。
 * 于是一个新注册只有两条路：重新声明 `settings.section` 等子槽位 → 在 ② 上 throw；不声明 →
 * 拿不到 `renderSlot`（正是 ② 那句 `if`）→ 渲染不出任何注册进来的设置页。
 * 结论：**能渲染 `settings.section` 正文的组件有且只有出厂的那个壳**。所以壳必须原样留着，
 * 增强只能叠在它渲染出来的导航 DOM 上。
 * 另有一处平台限制顺带记下：`ctx.slots.register` 对 list 槽位在同一 priority + 同一 id
 * 上也会 throw，所以本插件**不覆盖任何出厂槽位**，只新增自己的 `settings-nav` 一节。
 *
 * 增强手段（都不用替换 React 节点，所以与 React 的重渲染天然共存）：
 *   · 视觉顺序：给导航列表的**直接子** `<button>` 设内联 `style.order`
 *     （列表容器是 `display:flex; flex-direction:column`，`order` 即视觉位置）。
 *     出厂壳渲染每个行时**不设 style prop**，React 只更新它自己给过的属性，因此我们加的
 *     内联样式不会被重渲染抹掉；即使 React 因列表变化移动节点，视觉顺序仍由 order 决定。
 *   · 收纳折叠：折叠组内的行设内联 `display:none`。
 *   · 分组标题：我们自己 `createElement` 的 `<div>` 插进同一个 flex 容器，同样用 order
 *     定位。React 不认识这些「外来节点」，既不会删它也不会给它排序（插入新节点时用的
 *     参照物永远来自它自己的 fiber 树），所以外来节点是安全的。
 *
 * ── 失效即静默降级 ──────────────────────────────────────────────────────────
 * 导航增强全程 try/catch，任何一步出错只记诊断、**绝不抛出**——设置页坏掉比「分组没生效」
 * 严重得多。定位不到导航（出厂改版换了 DOM）时什么都不做，出厂行为一字不变。
 *
 * ── 身份口径 ────────────────────────────────────────────────────────────────
 * 设置项的身份是它在 `settings.section` 槽位上的 **id**（出厂的 nav 行 id 与注册 id
 * 一一对应）。导航 DOM 的行 ↔ 账本行的对应关系按**位置**建立：出厂壳用
 * `rows.map(row => <button key={row.id}>)` 渲染，keyed 列表的 DOM 顺序恒等于它那次渲染
 * 用的账本顺序；我们再用**标签文本逐位比对**做校验，对不上就跳过这一帧、等下一次
 * 重渲染（连续对不上若干次才退回「只按位置」并记警告）。
 *
 * 自测：`node plugins/dsh-settings-nav/client-selftest.mjs`（无头，桩 document /
 * MutationObserver / React 极小 hooks 运行时，真跑分组/折叠/排序/拖放与组件交互）。
 *
 * @module dsh-settings-nav/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-settings-nav',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    /** 同源读写前缀（host 半边 index.js 注册）。 */
    const ROUTE = '/dsh-settings-nav';
    /** 本文件构建标记（诊断用，与 host 的 build 对不上就说明半边版本不同步）。 */
    const BUILD = 'nav-4';
    /**
     * 文档 schema。2 = 分组可嵌套（`group.items` 里既有 id 字符串也有子分组对象）；
     * 读的时候 1/2 都认（客户端归一化对 `items` 里的未知类型静默丢弃，host 才报 issue）。
     */
    const SCHEMA = 2;
    /** 本插件自己在导航里的那一节的 id。 */
    const SECTION_ID = 'settings-nav';
    /** 本插件那一节在导航里的缺省位置：紧跟「通用」，找管理入口不用翻到底。 */
    const SECTION_ORDER = 6;
    /** 落盘防抖。 */
    const SAVE_DEBOUNCE_MS = 250;
    // 保存失败后的有界重试：面板可能一直开着，不重试就等于这次编辑永远停在内存里；
    // 但也不能无限重试（比如文件一直读不动），所以指数退避 + 次数上限，之后把错误留在界面上。
    const SAVE_RETRY_BASE_MS = 1200;
    const SAVE_RETRY_MAX_MS = 8000;
    const SAVE_RETRY_LIMIT = 5;
    /** 分组名上限。 */
    const MAX_NAME = 60;
    /** 分组数上限（含嵌套）。 */
    const MAX_GROUPS = 64;
    /** 分组嵌套深度上限（顶层分组为第 0 层，所以最深 5 层）。 */
    const MAX_DEPTH = 5;
    /** 左列各类层级每级的缩进（px）。 */
    const RAIL_INDENT = 10;
    /** 连续多少帧标签对不上才放弃校验、退回纯位置对应。 */
    const MISMATCH_GIVE_UP = 5;
    /** 拖动时用来标记「放到前/后」的类名。 */
    const DROP_BEFORE = 'dsn-drop-before';
    const DROP_AFTER = 'dsn-drop-after';
    /** 「放进这一组」的落点标记（分组标题的中段）。 */
    const DROP_INTO = 'dsn-drop-into';

    /* ══════════════════════════════ 文案 ══════════════════════════════ */

    /** `键: [中文, English]`；语言取 `ctx.locale` 的 active，取不到按中文。 */
    const T = {
      navLabel: ['设置导航', 'Settings nav'],
      title: ['设置导航分组收纳', 'Settings navigation groups'],
      intro: [
        '把左侧这一列设置项编成命名分组（可折叠收纳），并按你想要的顺序排列。改动**即时生效**：左列顺序、分组、收起状态当场变化，同时写入 host 的布局文件，刷新后照旧。',
        'Group the settings entries in the left rail into collapsible named groups and order them however you like. Changes apply instantly to the rail and are written to the host layout file, so they survive a reload.',
      ],
      loading: ['加载中…', 'Loading…'],
      disabled: [
        'host 侧配置里 enabled=false，导航增强已关闭（本页仍可查看与编辑布局，但不会作用到左列）。',
        'enabled=false in the host config: the rail enhancement is off (this page still edits the layout, but the rail is untouched).',
      ],
      persistUnavailable: [
        '读不到 host 的布局文件，本页改动**只在当前页面有效**，刷新即丢。检查 dsh 是否在跑、或 host 半边是否挂载。',
        'Cannot reach the host layout file. Changes here live only in this page and are lost on reload.',
      ],
      conflict: ['布局刚被别处改写，已采用磁盘上的版本（本次改动未覆盖它）。', 'The layout was changed elsewhere; the on-disk version was adopted instead.'],
      saveFailed: ['布局写入失败：', 'Failed to write the layout: '],
      saved: ['已保存', 'Saved'],
      unsaved: ['未保存', 'Unsaved'],
      file: ['文件', 'File'],
      revision: ['修订', 'Revision'],
      persist: ['持久化', 'Persistence'],
      persistOk: ['已接上', 'connected'],
      persistNo: ['不可用', 'unavailable'],
      layout: ['布局', 'Layout'],
      groupsCount: ['分组', 'groups'],
      itemsCount: ['已登记设置项', 'entries'],
      ungrouped: ['未分组（还在出厂位置）', 'Ungrouped (still in factory order)'],
      ungroupedHint: ['这些设置项还没被排进上面的布局，它们按出厂顺序跟在最后。', 'These entries are not in the layout yet and follow the factory order at the end.'],
      orphans: ['失联项（布局里有、当前找不到）', 'Orphans (in the layout, not registered now)'],
      orphansHint: [
        '通常是插件被停用/卸载了。位置会**保留**——插件回来时自动复位；确认不再需要可以清理。',
        'Usually a plugin was disabled or removed. Their positions are kept so they return to place; clean them up when you are sure.',
      ],
      cleanup: ['清理', 'Clean up'],
      newGroup: ['新建分组', 'New group'],
      subGroup: ['子分组', 'Subgroup'],
      subGroupHint: ['在这个分组里新建一个子分组（多级结构）', 'Create a subgroup inside this group (multi-level)'],
      groupNamePlaceholder: ['分组名', 'Group name'],
      emptyLayout: ['还没有分组。点「新建分组」，或试试「预置方案」。', 'No groups yet. Create one, or try the suggested layout.'],
      dragHint: [
        '拖拽行首的 ⠿ 手柄可以上下移动 / 跨分组移动；也可以直接用「↑ ↓」按钮。',
        'Drag the ⠿ handle to move a row, including across groups; the ↑ ↓ buttons work too.',
      ],
      collapse: ['收起', 'Collapse'],
      expand: ['展开', 'Expand'],
      rename: ['重命名', 'Rename'],
      remove: ['移出分组', 'Remove from group'],
      save: ['保存', 'Save'],
      cancel: ['取消', 'Cancel'],
      delete: ['删除分组', 'Delete group'],
      deleteHint: ['删除分组不会删除里面的设置项，它们会回到「未分组」。', 'Deleting a group keeps its entries; they return to Ungrouped.'],
      addTo: ['加入分组…', 'Add to group…'],
      toEnd: ['放到末尾', 'Move to end'],
      collapseAll: ['全部收起', 'Collapse all'],
      expandAll: ['全部展开', 'Expand all'],
      preset: ['预置方案', 'Suggested layout'],
      presetHint: ['按名字猜一套分组（可再手改），会覆盖当前布局。', 'Guess a grouping from entry names (overwrites the current layout).'],
      reset: ['恢复出厂顺序', 'Reset to factory order'],
      resetHint: ['清空布局：左列回到出厂顺序，分组定义一并清除。', 'Clears the layout: the rail returns to factory order and all groups are removed.'],
      confirmReset: ['确认清空整个布局？', 'Clear the entire layout?'],
      confirmPreset: ['用预置方案覆盖当前布局？', 'Overwrite the layout with the suggested one?'],
      sectionUnknown: ['（未注册的设置项）', '(unregistered entry)'],
      diag: ['诊断', 'Diagnostics'],
      diagNav: ['导航增强', 'Rail enhancer'],
      navFound: ['定位到导航', 'nav located'],
      navApplied: ['应用布局', 'layouts applied'],
      navMismatch: ['标签校验未过', 'label mismatches'],
      navErrors: ['异常', 'errors'],
      lastError: ['最近异常', 'last error'],
      noError: ['无', 'none'],
      standalone: ['独立', 'standalone'],
      organized: ['整理中：拖动行或分组标题即可排序；点「完成」退出', 'Arranging: drag rows or group headers to reorder; click Done to finish'],
      navHint: ['直接拖动设置项或分组标题即可排序（可跨分组）；点「整理」可新建分组、全部收起 / 展开', 'Drag entries or group headers to reorder, including across groups; click Arrange for new-group / collapse-all'],
      organize: ['整理', 'Arrange'],
      done: ['完成', 'Done'],
      toggleGroup: ['折叠 / 展开这一组', 'Collapse / expand this group'],
      entries: ['项', 'items'],
      hostBuild: ['host / client', 'host / client'],
    };

    /** 当前语言（apply 时从 ctx.locale 取，并在 locale 变化时刷新）。 */
    let localeId = 'zh';
    /** 注册设置项节失败时的原因（见 apply 里的 try/catch）。 */
    let registrationFailure = null;

    /** 取一条文案。 */
    const t = (key) => {
      const pair = T[key];
      if (pair === undefined) return key;
      return localeId === 'en' ? pair[1] : pair[0];
    };

    /* ══════════════════════════════ 样式 ══════════════════════════════ */

    const PAGE_CSS = [
      '.dsn-root { display: flex; flex-direction: column; gap: 12px; font-size: 13px; color: var(--dsw-alias-label-primary); }',
      '.dsn-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }',
      '.dsn-sub { font-size: 12px; font-weight: 600; }',
      '.dsn-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.7; }',
      '.dsn-code { font-family: monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }',
      '.dsn-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.dsn-list { display: flex; flex-direction: column; gap: 4px; }',
      '.dsn-entry { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 8px; display: flex; align-items: center; gap: 8px; background: var(--dsw-alias-bg-layer-2); }',
      '.dsn-entry.dsn-group { border-color: var(--dsw-alias-border-l2); }',
      '.dsn-entry.dsn-dragging { opacity: .45; }',
      '.dsn-entry.dsn-over { border-color: var(--dsw-alias-brand-primary); }',
      '.dsn-name { font-size: 12px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.dsn-section { font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.dsn-id { font-family: monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); }',
      '.dsn-spacer { flex: 1; }',
      '.dsn-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer; font-family: inherit; }',
      '.dsn-btn:hover { border-color: var(--dsw-alias-brand-primary); }',
      '.dsn-btn.primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }',
      '.dsn-btn.icon { padding: 2px 6px; line-height: 1.2; }',
      '.dsn-btn:disabled { opacity: .4; cursor: default; }',
      '.dsn-input { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 8px; font-size: 12px; font-family: inherit; min-width: 120px; flex: 1 1 160px; }',
      '.dsn-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
      '.dsn-select { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 2px 6px; font-size: 12px; font-family: inherit; }',
      '.dsn-badge { border-radius: 999px; padding: 0 7px; font-size: 11px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }',
      '.dsn-badge.on { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }',
      '.dsn-error { color: #d9534f; font-size: 12px; line-height: 1.6; white-space: pre-wrap; }',
      '.dsn-notice { color: var(--dsw-alias-brand-primary); font-size: 12px; }',
      '.dsn-handle { cursor: grab; color: var(--dsw-alias-label-secondary); user-select: none; padding: 0 2px; }',
      '.dsn-member { margin-left: 18px; }',
      '.dsn-entry.dsn-empty { border-style: dashed; }',
      /* ---- 左列导航：分组标题 / 整理工具条 ---- */
      // sticky：设置项多起来左列就要滚动，滚动时分组标题停在顶部才分得清「现在在哪一组」。
      // 6px 的间隔做成**盒子内部的 padding-top** 而不是 margin-top——margin 不属于 sticky
      // 盒子，会留出一条能看见下面的行滚过去的缝。背景必须用面板同款 token 才挡得住。
      '.dsn-navheader { position: sticky; top: 0; z-index: 2; box-sizing: border-box; display: flex; align-items: center; gap: 6px; height: 34px; padding: 6px 12px 0; color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600; letter-spacing: .02em; background: var(--dsw-alias-bg-layer-2); }',
      '.dsn-navheader-btn { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; background: none; border: none; padding: 0; font: inherit; color: inherit; cursor: pointer; text-align: left; }',
      '.dsn-navheader-btn:hover { color: var(--dsw-alias-label-primary); }',
      '.dsn-navheader-label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.dsn-navheader-count { font-weight: 400; opacity: .7; }',
      '.dsn-chev { width: 10px; display: inline-block; transition: transform .12s ease; font-size: 9px; }',
      /* 当前分节就在这个（收起的）分组里：标题用品牌色标出来，否则收起后左列只剩
         内容区在告诉我们「在哪一页」，左列一个字都不说。 */
      '.dsn-navheader-active .dsn-navheader-btn { color: var(--dsw-alias-brand-primary); }',
      '.dsn-navheader-active .dsn-navheader-label { font-weight: 700; }',
      '.dsn-navheader[data-dsn-collapsed="1"] .dsn-chev { transform: rotate(-90deg); }',
      '.dsn-taskbar { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 4px; padding: 2px 4px 2px 10px; }',
      '.dsn-taskbar-btn { background: none; border: none; padding: 0 4px; font: inherit; font-size: 11px; color: var(--dsw-alias-label-secondary); cursor: pointer; border-radius: 4px; }',
      '.dsn-taskbar-btn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }',
      '.dsn-taskbar-btn.on { color: var(--dsw-alias-brand-primary); }',
      '.dsn-navlist-organizing > button { outline: 1px dashed var(--dsw-alias-border-l2); outline-offset: -2px; }',
      '.dsn-drop-before { box-shadow: inset 0 2px 0 0 var(--dsw-alias-brand-primary); }',
      '.dsn-drop-after { box-shadow: inset 0 -2px 0 0 var(--dsw-alias-brand-primary); }',
      '.dsn-drop-into { box-shadow: inset 0 0 0 2px var(--dsw-alias-brand-primary); border-radius: 4px; }',
      '.dsn-navheader[data-dsn-depth]:not([data-dsn-depth="0"]) { height: 30px; font-weight: 500; }',
      '.dsn-navdragging { opacity: .45; }',
    ].join('\n');

    /** 样式只注入一次（按 data-plugin-css 去重）；返回的清理函数由 fiber 回收时执行。 */
    function injectStyles() {
      if (typeof document === 'undefined') return () => {};
      const tagId = 'dsh-settings-nav/page.css';
      let tag = document.querySelector('style[data-plugin-css="' + tagId + '"]');
      if (tag === null || tag === undefined) {
        tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-settings-nav';
        tag.dataset.pluginCss = tagId;
        tag.textContent = PAGE_CSS;
        (document.head || document.documentElement).appendChild(tag);
      }
      return () => {
        if (tag !== null && tag !== undefined && tag.parentNode !== null && tag.parentNode !== undefined) {
          tag.parentNode.removeChild(tag);
        }
      };
    }

    /* ══════════════════════════ 纯函数（自测主战场） ══════════════════════════ */

    /** 空文档。 */
    function emptyDoc() {
      return { schema: SCHEMA, revision: 0, updatedAt: 0, order: [] };
    }

    const errorText = (error) => String(error && error.message ? error.message : error);

    /** 去控制字符 + 折叠空白 + 夹长度。 */
    function cleanName(value) {
      if (typeof value !== 'string') return '';
      // 控制字符换成空格再折叠：`a\nb` 必须变成 `a b`，而不是被粘成 `ab`。
      let text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > MAX_NAME) text = text.slice(0, MAX_NAME);
      return text;
    }

    /** 标签可能是 thunk（出厂的本地化写法），两边都接受。 */
    function resolveLabel(label) {
      const value = typeof label === 'function' ? label() : label;
      return typeof value === 'string' ? value : '';
    }

    /**
     * 客户端侧的归一化（host 已经归一化过一次，这里是**防御性**的：外部手改文件、
     * 版本错位、缓存里的旧文档都可能进来）。策略与 host 一致：宽进严出、坏项丢弃。
     *
     * @param {unknown} raw 候选文档。
     */
    /** 分组节点判定（顶层与分组内通用：分组永远是对象）。 */
    const isGroupNode = (node) => node !== null && typeof node === 'object' && !Array.isArray(node) && node.type === 'group';

    /** 子条目的设置项 id：分组内是字符串，顶层是 {type:'item'}；都不是就返回 null。 */
    function childItemId(node) {
      if (typeof node === 'string') return node;
      if (node !== null && typeof node === 'object' && node.type === 'item' && typeof node.id === 'string') return node.id;
      return null;
    }

    /** 同级参照物匹配（item 与 group 的 id 各自独立、可能同名，必须分开比）。 */
    function matchesRef(child, ref) {
      if (isGroupNode(child)) return ref.kind === 'group' && child.id === ref.id;
      const id = childItemId(child);
      return ref.kind === 'item' && id === ref.id;
    }

    /** 递归收集所有分组 id（含嵌套）。 */
    function collectGroupIds(list, out) {
      for (const child of list) {
        if (!isGroupNode(child)) continue;
        out.add(child.id);
        collectGroupIds(child.items, out);
      }
      return out;
    }

    /** 递归数分组总数（含嵌套）。 */
    function countGroups(list) {
      let total = 0;
      for (const child of list) {
        if (!isGroupNode(child)) continue;
        total += 1 + countGroups(child.items);
      }
      return total;
    }

    /** 按 id 找分组节点（递归，含嵌套）。 */
    function findGroupNode(list, id) {
      for (const child of list) {
        if (!isGroupNode(child)) continue;
        if (child.id === id) return child;
        const inner = findGroupNode(child.items, id);
        if (inner !== null) return inner;
      }
      return null;
    }

    /** 节点所在的**容器路径**（`[]` = 顶层）。找不到返回 null。 */
    function pathOfNode(list, kind, id) {
      const ref = { kind, id };
      const search = (children, path) => {
        for (const child of children) {
          if (matchesRef(child, ref)) return path;
          if (isGroupNode(child)) {
            const found = search(child.items, path.concat([child.id]));
            if (found !== null) return found;
          }
        }
        return null;
      };
      return search(list, []);
    }

    /** 逐级下钻到路径指向的容器；路径不存在返回 null（**先验存在，再动手**）。 */
    function containerExisting(list, path) {
      let current = list;
      for (const gid of path) {
        const group = current.find((child) => isGroupNode(child) && child.id === gid);
        if (group === undefined) return null;
        current = group.items;
      }
      return current;
    }

    /**
     * 对路径指向的容器里的子列表应用 transform（沿途的分组对象按需重建）。
     * `transform(list, topLevel)` 的 `topLevel` **只对整个 order 为真**——分组内永远是
     * 字符串 id，这一点错了就会出现「组里塞进了一个对象」的脏文档。
     */
    function updateContainer(list, path, transform) {
      if (path.length === 0) return transform(list, true);
      return diveContainer(list, path, transform);
    }

    function diveContainer(list, path, transform) {
      if (path.length === 0) return transform(list, false);
      const head = path[0];
      let changed = false;
      const out = list.map((child) => {
        if (!isGroupNode(child) || child.id !== head) return child;
        const items = diveContainer(child.items, path.slice(1), transform);
        if (items === child.items) return child;
        changed = true;
        return Object.assign({}, child, { items });
      });
      return changed ? out : list;
    }

    /** 从树上摘掉一个节点（设置项 id 或整个分组子树）；没找到就原样返回。 */
    function removeNode(list, kind, id) {
      let changed = false;
      const out = [];
      for (const child of list) {
        if (isGroupNode(child)) {
          if (kind === 'group' && child.id === id) {
            changed = true;
            continue;
          }
          const items = removeNode(child.items, kind, id);
          if (items !== child.items) {
            changed = true;
            out.push(Object.assign({}, child, { items }));
            continue;
          }
          out.push(child);
          continue;
        }
        if (kind === 'item' && childItemId(child) === id) {
          changed = true;
          continue;
        }
        out.push(child);
      }
      return changed ? out : list;
    }

    /**
     * 客户端侧的归一化（host 已经归一化过一次，这里是**防御性**的：外部手改文件、
     * 版本错位、缓存里的旧文档都可能进来）。策略与 host 一致：宽进严出、坏项丢弃。
     *
     * schema 2 起 `group.items` 里既能放设置项 id 字符串，也能放**子分组对象**（多层嵌套）；
     * 顶层 `order` 的形状不变。深度超过 `MAX_DEPTH` 的分组整棵丢掉。
     *
     * @param {unknown} raw 候选文档。
     */
    function normalizeDoc(raw) {
      const doc = emptyDoc();
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return doc;
      const list = Array.isArray(raw.order) ? raw.order : [];
      const ctx = { seenIds: new Set(), seenGroups: new Set(), groups: 0 };
      doc.revision = Number.isFinite(raw.revision) && raw.revision >= 0 ? Math.trunc(raw.revision) : 0;
      doc.updatedAt = Number.isFinite(raw.updatedAt) ? Math.trunc(raw.updatedAt) : 0;
      doc.order = normalizeEntryList(list, 0, ctx);
      return doc;
    }

    /** 顶层条目列表归一化。 */
    function normalizeEntryList(list, depth, ctx) {
      const out = [];
      for (const entry of list) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (entry.type === 'item') {
          if (id === '' || ctx.seenIds.has(id)) continue;
          ctx.seenIds.add(id);
          out.push({ type: 'item', id });
          continue;
        }
        if (entry.type === 'group') {
          const group = normalizeGroupNode(entry, depth, ctx);
          if (group !== null) out.push(group);
        }
      }
      return out;
    }

    /** 一个分组节点归一化（递归）。`depth` 是本分组自己的嵌套深度，顶层为 0。 */
    function normalizeGroupNode(entry, depth, ctx) {
      if (depth >= MAX_DEPTH) return null;
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (id === '' || ctx.seenGroups.has(id) || ctx.groups >= MAX_GROUPS) return null;
      ctx.seenGroups.add(id);
      ctx.groups += 1;
      const items = [];
      for (const candidate of Array.isArray(entry.items) ? entry.items : []) {
        if (typeof candidate === 'string') {
          const memberId = candidate.trim();
          if (memberId === '' || ctx.seenIds.has(memberId)) continue;
          ctx.seenIds.add(memberId);
          items.push(memberId);
          continue;
        }
        if (isGroupNode(candidate)) {
          const sub = normalizeGroupNode(candidate, depth + 1, ctx);
          if (sub !== null) items.push(sub);
        }
        // 其余（数字 / 布尔 / 数组 / 非分组对象）静默丢弃：host 才是报 issue 的那一侧。
      }
      return { type: 'group', id, name: cleanName(entry.name) || '未命名分组', collapsed: entry.collapsed === true, items };
    }

    /** 生成一个不与现有分组冲突的 id。 */
    function generateGroupId(existing) {
      const taken = existing instanceof Set ? existing : new Set(Array.isArray(existing) ? existing : []);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const id = 'g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        if (!taken.has(id)) return id;
      }
      return 'g-' + Math.random().toString(36).slice(2, 12);
    }

    /**
     * 把「布局文档 + 当前账本行」算成一份**导航计划**（schema 2：分组可嵌套）。
     *
     * 语义（与 host 的文档注释一致）：
     *   · 布局里没提到的行**不丢**，按账本顺序追加到最后；
     *   · 布局里提到、账本里没有的 id 只**跳过**（算进 orphans，供管理页提示）；
     *   · 空分组（成员全失联）仍然出现标题，数量显示 0——比静默消失诚实。
     *
     * 层级语义：**深度优先**展开；折叠是**子树级**的（任一祖先收起，整棵子树都 `hidden`，
     * 包括子分组的标题）。`header.path` 是它的祖先分组 id 链，`header.count` 是它子树里
     * 当前活着的设置项总数。`item.path` 含它的直接父分组（顶层项为 `[]`）。
     *
     * @param {object} doc 归一化后的文档。
     * @param {Array<{id: string, label: string, order: number}>} rows 账本行。
     * @returns {{ entries: object[], byId: Map<string, object>, orphans: string[], loose: string[], groupCount: number }}
     */
    function computePlan(doc, rows) {
      const rowList = Array.isArray(rows) ? rows : [];
      const live = new Set();
      for (const row of rowList) live.add(row.id);

      const placed = new Set();
      const entries = [];
      const byId = new Map();
      let rank = 0;
      let groupCount = 0;

      const pushItem = (id, path, hidden) => {
        const entry = {
          kind: 'item',
          id,
          rank: rank++,
          groupId: path.length === 0 ? null : path[path.length - 1],
          path,
          depth: path.length,
          hidden: hidden === true,
        };
        entries.push(entry);
        if (!byId.has(id)) byId.set(id, entry);
      };

      /** 子树里**当前活着、还没被排过**的设置项数（标题上的「N 项」）。 */
      const countLive = (items) => {
        let total = 0;
        for (const child of items) {
          if (typeof child === 'string') {
            if (live.has(child) && !placed.has(child)) total += 1;
            continue;
          }
          if (isGroupNode(child)) total += countLive(child.items);
        }
        return total;
      };

      const walkItems = (items, path, hiddenByAncestor) => {
        for (const child of items) {
          if (typeof child === 'string') {
            if (!live.has(child) || placed.has(child)) continue;
            placed.add(child);
            pushItem(child, path, hiddenByAncestor);
            continue;
          }
          if (isGroupNode(child)) walkGroup(child, path, hiddenByAncestor);
        }
      };

      const walkGroup = (group, path, hiddenByAncestor) => {
        groupCount += 1;
        const collapsed = group.collapsed === true;
        entries.push({
          kind: 'header',
          gid: group.id,
          name: group.name,
          collapsed,
          depth: path.length,
          path,
          hidden: hiddenByAncestor === true,
          count: countLive(group.items),
          rank: rank++,
        });
        walkItems(group.items, path.concat([group.id]), hiddenByAncestor === true || collapsed);
      };

      const order = Array.isArray(doc && doc.order) ? doc.order : [];
      for (const entry of order) {
        if (entry.type === 'item') {
          if (!live.has(entry.id) || placed.has(entry.id)) continue;
          placed.add(entry.id);
          pushItem(entry.id, [], false);
          continue;
        }
        if (isGroupNode(entry)) walkGroup(entry, [], false);
      }

      const loose = [];
      for (const row of rowList) {
        if (placed.has(row.id)) continue;
        placed.add(row.id);
        loose.push(row.id);
        pushItem(row.id, [], false);
      }

      const orphans = [];
      const seenDocIds = new Set();
      const collectOrphans = (items) => {
        for (const child of items) {
          if (typeof child === 'string') {
            if (seenDocIds.has(child)) continue;
            seenDocIds.add(child);
            if (!live.has(child)) orphans.push(child);
            continue;
          }
          if (isGroupNode(child)) collectOrphans(child.items);
        }
      };
      for (const entry of order) {
        if (entry.type === 'item') {
          if (seenDocIds.has(entry.id)) continue;
          seenDocIds.add(entry.id);
          if (!live.has(entry.id)) orphans.push(entry.id);
          continue;
        }
        if (isGroupNode(entry)) collectOrphans(entry.items);
      }

      return { entries, byId, orphans, loose, groupCount };
    }

    /**
     * 计划签名：变了才重刷 DOM（每帧重刷内联样式会与 React 的提交互相打脸）。
     *
     * `activeId` 必须进签名：出厂壳把「当前分节」标在行自己的 `aria-current` 上，
     * 而我们的折叠会把行藏起来——切分节时账本与文档都没变，只有这个属性变了，
     * 漏掉它就会出现「换了页面但当前项仍被折叠藏住」。层级（depth）与标题的 hidden
     * 也必须进签名，否则「父组收起/展开」这类改动不会重刷。
     */
    function planSignature(plan, rows, buttons, organize, revision, activeId) {
      const rowPart = (Array.isArray(rows) ? rows : []).map((row) => row.id).join('|');
      const planPart = plan.entries
        .map((entry) =>
          entry.kind === 'header'
            ? `H${entry.gid}:${entry.name}:${entry.collapsed ? 1 : 0}:${entry.depth}:${entry.hidden ? 1 : 0}:${entry.count}`
            : `I${entry.id}:${entry.rank}:${entry.hidden ? 1 : 0}:${entry.depth}`,
        )
        .join(',');
      // localeId 必须进签名：切语言时账本、文档、revision 都没变，只有 `t()` 的结果变了。
      return rowPart + '#' + planPart + '#' + String(buttons) + '#' + (organize ? '1' : '0') + '#' + String(revision) + '#' + String(activeId) + '#' + String(localeId);
    }

    /** 定位一个 id 在文档里的位置（兼容返回：顶层 index 与组内 at）。 */
    function locate(doc, id) {
      const order = Array.isArray(doc && doc.order) ? doc.order : [];
      for (let index = 0; index < order.length; index += 1) {
        const entry = order[index];
        if (entry.type === 'item') {
          if (entry.id === id) return { type: 'item', path: [], index, at: index };
          continue;
        }
        if (entry.id === id) return { type: 'group', path: [], index, at: index };
        const at = entry.items.findIndex((child) => childItemId(child) === id);
        if (at >= 0) return { type: 'group', path: [entry.id], index, at };
      }
      return null;
    }

    /** 去掉一个设置项 id（任意层级；分组本身不动，允许留下空分组给用户重填）。 */
    function withoutId(order, id) {
      return removeNode(Array.isArray(order) ? order : [], 'item', id);
    }

    /**
     * 落一次拖放（纯函数，schema 2）。
     *
     * 锚点 = **容器路径 + 同级参照物**：
     *   · `container`：目标容器的祖先分组 id 数组；`[]` 是顶层，`[g1,g2]` 是 g2 的分组内；
     *   · `ref`：同级参照物 `{kind:'item'|'group', id}`；`null` 表示「落到该容器末尾」，
     *     也就是「拖进这一组」；
     *   · `side`：`'before' | 'after'`（`ref` 为 null 时忽略）。
     *
     * 分组**可以**放进分组（多级结构），但绝不允许落进自己或自己的后代（成环），
     * 也绝不允许落到自己身上。
     *
     * @param {object} doc 当前文档。
     * @param {{kind: 'item'|'group', id: string}|null} drag 被拖的东西。
     * @param {{container: string[], ref: object|null, side?: string}|null} anchor 落点。
     * @returns {object} 新文档（拖放无效时原样返回）。
     */
    function applyDrop(doc, drag, anchor) {
      if (doc === null || typeof doc !== 'object' || drag === null || anchor === null) return doc;
      if (typeof drag.id !== 'string' || drag.id === '') return doc;
      const order = Array.isArray(doc.order) ? doc.order : [];
      const container = Array.isArray(anchor.container) ? anchor.container : [];
      const ref = anchor.ref === undefined ? null : anchor.ref;

      // 1) 成环：分组的祖先链里若出现它自己，目标容器就在它内部。
      if (drag.kind === 'group' && container.indexOf(drag.id) >= 0) return doc;
      // 2) 目标容器必须真的存在——**先验存在再动手**，否则会「摘掉了却没插回去」。
      if (containerExisting(order, container) === null) return doc;
      // 3) 落到自己身上：空操作。
      if (ref !== null && ref.kind === drag.kind && ref.id === drag.id) return doc;
      // 4) 拖分组时它必须在树上（要在摘之前拿到整棵子树的对象）。
      const source = drag.kind === 'group' ? findGroupNode(order, drag.id) : null;
      if (drag.kind === 'group' && source === null) return doc;

      const stripped = removeNode(order, drag.kind, drag.id);
      const next = updateContainer(stripped, container, (list, topLevel) => {
        const node = drag.kind === 'group' ? source : topLevel ? { type: 'item', id: drag.id } : drag.id;
        let at = list.length;
        if (ref !== null) {
          const index = list.findIndex((child) => matchesRef(child, ref));
          // 账本里有、文档里没提到的设置项**确实画在左列上**（computePlan 把它当未分组项
          // 追加），所以它必须算有效落点。找不到位置就落到末尾——总比静默不动强。
          at = index < 0 ? list.length : anchor.side === 'after' ? index + 1 : index;
        }
        const spliced = list.slice();
        spliced.splice(Math.max(0, Math.min(list.length, at)), 0, node);
        return spliced;
      });
      // 容器没找到（前面已挡住，这里是防御）：宁可不动，也不能只摘不插。
      if (next === stripped) return doc;
      return Object.assign({}, doc, { order: next });
    }

    /** 把一个**新**节点插进某个容器（createGroup 用，不涉及「摘掉」）。 */
    function insertNode(doc, node, container, ref) {
      const order = Array.isArray(doc.order) ? doc.order : [];
      if (containerExisting(order, container) === null) return doc;
      const next = updateContainer(order, container, (list, topLevel) => {
        const value = topLevel ? node : node.type === 'item' ? node.id : node;
        let at = list.length;
        if (ref !== null && ref !== undefined) {
          const index = list.findIndex((child) => matchesRef(child, ref));
          if (index >= 0) at = ref.side === 'after' ? index + 1 : index;
        }
        const spliced = list.slice();
        spliced.splice(Math.max(0, Math.min(list.length, at)), 0, value);
        return spliced;
      });
      return next === order ? doc : Object.assign({}, doc, { order: next });
    }

    /** 把一个设置项移进某个分组（追加到该组末尾）；已经在该组里就不动。 */
    function moveIntoGroup(doc, id, groupId) {
      const order = Array.isArray(doc.order) ? doc.order : [];
      const group = findGroupNode(order, groupId);
      if (group === null) return doc;
      if (group.items.some((child) => typeof child === 'string' && child === id)) return doc;
      return applyDrop(doc, { kind: 'item', id }, { container: [groupId], ref: null });
    }

    /** 把一个子条目移出分组，落成紧跟该分组后面的同级条目（设置项或子分组都可以）。 */
    function moveOutOfGroup(doc, id, groupId) {
      const order = Array.isArray(doc.order) ? doc.order : [];
      const group = findGroupNode(order, groupId);
      if (group === null) return doc;
      let kind = null;
      if (group.items.some((child) => typeof child === 'string' && child === id)) kind = 'item';
      else if (group.items.some((child) => isGroupNode(child) && child.id === id)) kind = 'group';
      if (kind === null) return doc;
      const path = pathOfNode(order, 'group', groupId);
      if (path === null) return doc;
      return applyDrop(doc, { kind, id }, { container: path, ref: { kind: 'group', id: groupId }, side: 'after' });
    }

    /** 把一个设置项挪成顶层最后一项（「放到末尾」）。 */
    function appendLoose(doc, id) {
      return applyDrop(doc, { kind: 'item', id }, { container: [], ref: null });
    }

    /** 新建一个空分组；给了 parentId 就建成那个分组的**子分组**。 */
    function createGroup(doc, parentId) {
      const order = Array.isArray(doc.order) ? doc.order : [];
      if (countGroups(order) >= MAX_GROUPS) return doc;
      const container = [];
      if (typeof parentId === 'string' && parentId !== '') {
        const parentPath = pathOfNode(order, 'group', parentId);
        if (parentPath === null) return doc;
        if (parentPath.length + 1 >= MAX_DEPTH) return doc;
        container.push(...parentPath, parentId);
      }
      const taken = new Set();
      collectGroupIds(order, taken);
      const node = { type: 'group', id: generateGroupId(taken), name: '新分组', collapsed: false, items: [] };
      return insertNode(doc, node, container, null);
    }

    /** 对某个分组做一次替换（找不到就原样返回，保持引用不变以便 no-op 判定）。 */
    function mapGroup(doc, groupId, transform) {
      const order = Array.isArray(doc.order) ? doc.order : [];
      const walk = (list) => {
        let changed = false;
        const out = list.map((child) => {
          if (!isGroupNode(child)) return child;
          if (child.id === groupId) {
            changed = true;
            return transform(child);
          }
          const items = walk(child.items);
          if (items === child.items) return child;
          changed = true;
          return Object.assign({}, child, { items });
        });
        return changed ? out : list;
      };
      const next = walk(order);
      return next === order ? doc : Object.assign({}, doc, { order: next });
    }

    /** 重命名分组。 */
    function renameGroup(doc, groupId, name) {
      return mapGroup(doc, groupId, (group) => Object.assign({}, group, { name: cleanName(name) || '未命名分组' }));
    }

    /** 折叠/展开分组。 */
    function setGroupCollapsed(doc, groupId, collapsed) {
      return mapGroup(doc, groupId, (group) => Object.assign({}, group, { collapsed: collapsed === true }));
    }

    /** 全部收起 / 全部展开（含嵌套分组）。 */
    function setAllCollapsed(doc, collapsed) {
      const walk = (list) =>
        list.map((child) => (isGroupNode(child) ? Object.assign({}, child, { collapsed: collapsed === true, items: walk(child.items) }) : child));
      return Object.assign({}, doc, { order: walk(Array.isArray(doc.order) ? doc.order : []) });
    }

    /**
     * 删除分组：子条目**不删**，按原顺序就地摊回它所在的容器（设置项落成同级设置项，
     * 子分组整棵保留）。这样「删掉分组」永远不会让人丢掉设置项的可见性。
     */
    function deleteGroup(doc, groupId) {
      const flatten = (list, topLevel) => {
        let changed = false;
        const out = [];
        for (const child of list) {
          if (isGroupNode(child)) {
            if (child.id === groupId) {
              changed = true;
              for (const inner of child.items) {
                if (typeof inner === 'string') out.push(topLevel ? { type: 'item', id: inner } : inner);
                else out.push(inner);
              }
              continue;
            }
            const items = flatten(child.items, false);
            if (items !== child.items) {
              changed = true;
              out.push(Object.assign({}, child, { items }));
              continue;
            }
            out.push(child);
            continue;
          }
          out.push(child);
        }
        return changed ? out : list;
      };
      const order = Array.isArray(doc.order) ? doc.order : [];
      const next = flatten(order, true);
      return next === order ? doc : Object.assign({}, doc, { order: next });
    }

    /** 在一个分组内把一个设置项上/下移（只看该组的直接成员）。 */
    function moveMember(doc, groupId, id, delta) {
      const order = Array.isArray(doc.order) ? doc.order : [];
      const group = findGroupNode(order, groupId);
      if (group === null) return doc;
      const at = group.items.findIndex((child) => typeof child === 'string' && child === id);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= group.items.length) return doc;
      return mapGroup(doc, groupId, (found) => {
        const items = found.items.slice();
        const [node] = items.splice(at, 1);
        items.splice(to, 0, node);
        return Object.assign({}, found, { items });
      });
    }

    /** 在**它自己的容器里**上/下移一个条目（任意层级；管理页的 ↑ ↓ 用它）。 */
    function moveSibling(doc, kind, id, delta) {
      const order = Array.isArray(doc.order) ? doc.order : [];
      const path = pathOfNode(order, kind, id);
      if (path === null) return doc;
      const container = containerExisting(order, path);
      if (container === null) return doc;
      const at = container.findIndex((child) => matchesRef(child, { kind, id }));
      const to = at + delta;
      if (at < 0 || to < 0 || to >= container.length) return doc;
      const next = updateContainer(order, path, (list) => {
        const spliced = list.slice();
        const [node] = spliced.splice(at, 1);
        spliced.splice(to, 0, node);
        return spliced;
      });
      return next === order ? doc : Object.assign({}, doc, { order: next });
    }

    /** 把顶层条目（独立项或整个分组）上/下移。 */
    function moveTopLevel(doc, id, delta) {
      const order = Array.isArray(doc.order) ? doc.order.slice() : [];
      const at = order.findIndex((entry) => (isGroupNode(entry) ? entry.id === id : entry.type === 'item' && entry.id === id));
      const to = at + delta;
      if (at < 0 || to < 0 || to >= order.length) return doc;
      const [entry] = order.splice(at, 1);
      order.splice(to, 0, entry);
      return Object.assign({}, doc, { order });
    }

    /** 清掉布局里当前不存在的 id（任意层级；分组因此变空也不删组，交给用户决定）。 */
    function cleanupOrphans(doc, liveIds) {
      const live = liveIds instanceof Set ? liveIds : new Set(Array.isArray(liveIds) ? liveIds : []);
      const clean = (list) => {
        const out = [];
        for (const child of list) {
          if (typeof child === 'string') {
            if (live.has(child)) out.push(child);
            continue;
          }
          if (isGroupNode(child)) out.push(Object.assign({}, child, { items: clean(child.items) }));
        }
        return out;
      };
      const order = [];
      for (const entry of Array.isArray(doc.order) ? doc.order : []) {
        if (entry.type === 'item') {
          if (live.has(entry.id)) order.push(entry);
          continue;
        }
        if (isGroupNode(entry)) order.push(Object.assign({}, entry, { items: clean(entry.items) }));
      }
      return Object.assign({}, doc, { order });
    }

    /**
     * 按名字猜一套分组方案（**建议值**，用户可再手改）。
     * 只按「已登记设置项的 id + 标签」做关键词匹配，不硬编码任何插件名——新装插件
     * 也能落进合适的分组，猜错了改一下就行。
     */
    function suggestedLayout(rows) {
      const rules = [
        { id: 'g-model', name: localeId === 'en' ? 'Models & routing' : '模型与路由', re: /模型|model|provider|供应商|路由|routing|重试|retry/i },
        { id: 'g-session', name: localeId === 'en' ? 'Sessions & data' : '会话与数据', re: /会话|session|统计|stat|用量|usage|归档|archive|导入|import|分支|branch|压实|compaction|标题|title/i },
        { id: 'g-workspace', name: localeId === 'en' ? 'Workspaces & context' : '工作区与上下文', re: /工作区|workspace|上下文|context|目录|directory/i },
        { id: 'g-plugin', name: localeId === 'en' ? 'Plugins & extensions' : '插件与扩展', re: /插件|plugin|扩展|extension/i },
      ];
      // 「通用」永远单独留在最上面：它是每次都要点的入口。
      const top = new Set(['general']);
      const buckets = new Map();
      const order = [{ type: 'item', id: 'general' }];
      for (const row of rows) {
        if (top.has(row.id)) continue;
        const haystack = row.id + ' ' + (row.label || '');
        const rule = rules.find((candidate) => candidate.re.test(haystack));
        const key = rule === undefined ? 'g-other' : rule.id;
        const name = rule === undefined ? (localeId === 'en' ? 'Other' : '其它') : rule.name;
        if (!buckets.has(key)) {
          buckets.set(key, { type: 'group', id: key, name, collapsed: false, items: [] });
          order.push(buckets.get(key));
        }
        buckets.get(key).items.push(row.id);
      }
      // 只有一组的方案没有意义，直接回落到只留「通用」。
      const groups = order.filter((entry) => entry.type === 'group');
      if (groups.length <= 1) return { schema: SCHEMA, revision: 0, updatedAt: 0, order: [{ type: 'item', id: 'general' }] };
      return { schema: SCHEMA, revision: 0, updatedAt: 0, order };
    }

    /* ══════════════════════════════ 远端状态仓 ══════════════════════════════ */

    /**
     * 布局状态仓：唯一的内存真相 + 唯一的上行写者。
     * 管理页与导航增强订阅同一份状态，所以「管理页改了什么，左列立刻变」是结构保证，
     * 不需要任何事件桥。
     *
     * @param {object} [options] `{ fetchImpl }`（自测注入桩）。
     */
    function createStore(options) {
      const opts = options === null || options === undefined ? {} : options;
      const doFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (typeof fetch === 'function' ? fetch : null);
      let state = {
        doc: emptyDoc(),
        revision: 0,
        loaded: false,
        persist: 'ok',
        enabled: true,
        warnings: [],
        issues: [],
        error: null,
        notice: null,
        saving: false,
        dirty: false,
        lastSavedAt: null,
        hostBuild: '',
        hostImpl: '',
        path: '',
      };
      const listeners = new Set();
      let timer = null;
      let inFlight = false;
      let queued = false;
      let disposed = false;
      let retryAttempts = 0;

      const emit = () => {
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch (error) {
            /* 一个订阅者抛错不能连累其它订阅者 */
          }
        }
      };
      const patch = (fields) => {
        state = Object.assign({}, state, fields);
        emit();
      };

      async function request(path, body) {
        if (doFetch === null) throw new Error('fetch 不可用');
        const init = body === undefined
          ? { method: 'GET', headers: { accept: 'application/json' } }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
        const response = await doFetch(ROUTE + path, init);
        let parsed = null;
        try {
          parsed = await response.json();
        } catch (error) {
          parsed = null;
        }
        return { status: response.status, ok: response.ok === true, body: parsed };
      }

      /**
       * 拼「保存失败」文案。host 的 5xx 响应体自己已经带 `布局写入失败：` 前缀
       * （host index.js 的路由出口），客户端再拼一次就会显示成
       * 「布局写入失败：布局写入失败：EINVAL…」。前缀只补一次。
       */
      function saveFailure(detail) {
        const prefix = t('saveFailed');
        const text = typeof detail === 'string' ? detail : String(detail);
        return text.startsWith(prefix) ? text : prefix + text;
      }

      /** 读一次 host 状态；失败不致命（降级为「本页有效」）。 */
      async function load() {
        try {
          const answer = await request('/state');
          if (answer.ok !== true || answer.body === null || answer.body.ok !== true) {
            throw new Error((answer.body && answer.body.error) || 'HTTP ' + answer.status);
          }
          const body = answer.body;
          patch({
            doc: normalizeDoc(body.order === undefined ? body : { revision: body.revision, order: body.order }),
            revision: Number.isFinite(body.revision) ? body.revision : 0,
            loaded: true,
            persist: 'ok',
            enabled: body.config === undefined || body.config.enabled !== false,
            warnings: Array.isArray(body.warnings) ? body.warnings : [],
            error: null,
            dirty: false,
            hostBuild: typeof body.build === 'string' ? body.build : '',
            hostImpl: typeof body.impl === 'string' ? body.impl : '',
            path: typeof body.path === 'string' ? body.path : '',
          });
          return state;
        } catch (error) {
          patch({ loaded: true, persist: 'unavailable', error: errorText(error) });
          return state;
        }
      }

      /** 立即写盘（跳过防抖）。 */
      async function flush() {
        if (disposed === true) return;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (state.persist !== 'ok' || state.dirty !== true) return;
        if (inFlight === true) {
          queued = true;
          return;
        }
        inFlight = true;
        const payload = { baseRevision: state.revision, order: state.doc.order };
        // 记住这次发出去的到底是哪一份文档：保存在途时用户还能继续改（mutate 会生成**新的**
        // doc 引用），回来时只有 `state.doc === savedDoc` 才等于「磁盘 == 内存」。否则那个更晚
        // 的编辑还没落盘，绝不能把 dirty 清成 false——清了就再没人写它，用户看到「已保存」，
        // 刷新后改动没了。
        const savedDoc = state.doc;
        let failed = false;
        patch({ saving: true });
        try {
          const answer = await request('/save', payload);
          const body = answer.body === null ? {} : answer.body;
          const newerDoc = state.doc !== savedDoc;
          if (answer.status === 409 && body.conflict === true) {
            // 冲突不覆盖。但如果等待期间用户又改了，那份改动比磁盘上的更新，不能拿磁盘版本把
            // 它盖掉——只把基线挪到磁盘版本（相当于 rebase），留着 dirty 让重投去写。
            if (newerDoc) {
              patch({
                revision: Number.isFinite(body.revision) ? body.revision : state.revision,
                dirty: true,
                notice: t('conflict'),
                error: null,
              });
            } else {
              patch({
                doc: normalizeDoc({ revision: body.revision, order: body.order }),
                revision: Number.isFinite(body.revision) ? body.revision : state.revision,
                dirty: false,
                notice: t('conflict'),
                error: null,
              });
            }
            retryAttempts = 0;
          } else if (answer.ok === true && body.ok === true) {
            retryAttempts = 0;
            patch({
              revision: Number.isFinite(body.revision) ? body.revision : state.revision,
              // 在途期间如果又改了，仍然算脏（真正的落盘交给 queued 排水或那个还在的防抖计时器）。
              dirty: newerDoc,
              lastSavedAt: Date.now(),
              notice: null,
              error: null,
              warnings: Array.isArray(body.warnings) ? body.warnings : [],
            });
          } else {
            patch({ error: saveFailure((body && body.error) || 'HTTP ' + answer.status) });
            failed = true;
          }
        } catch (error) {
          patch({ error: saveFailure(errorText(error)) });
          failed = true;
        } finally {
          inFlight = false;
          patch({ saving: false });
          if (queued === true) {
            queued = false;
            await flush();
          } else if (failed === true) {
            // 必须等 inFlight 落回 false 再排重试——scheduleRetry 自己会看这个标志，
            // 早一步调就是空转。
            scheduleRetry();
          }
        }
      }

      const schedule = () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, SAVE_DEBOUNCE_MS);
      };

      /**
       * 保存失败后自己再试一次（指数退避，有上限）。
       *
       * 失败时防抖计时器已经被清掉、`queued` 也是 false，不补一个计时器这次编辑就一直停在
       * 内存里，直到用户下次动手或切走页面——界面上那句错误提示就成了唯一线索。次数有上限是
       * 为了对付「怎么试都不会成」的情况（例如磁盘上的布局文件读不动，host 会一直拒绝），
       * 试满就把错误留在界面上，等下一次编辑重新开始。
       */
      const scheduleRetry = () => {
        if (disposed === true || state.dirty !== true || state.persist !== 'ok') return;
        if (timer !== null || inFlight === true) return; // 已经有人排队了
        if (retryAttempts >= SAVE_RETRY_LIMIT) return;
        retryAttempts += 1;
        const delay = Math.min(SAVE_RETRY_MAX_MS, SAVE_RETRY_BASE_MS * Math.pow(2, retryAttempts - 1));
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, delay);
      };

      return {
        /** @returns {object} 当前状态快照（引用稳定到下次改动）。 */
        get: () => state,
        /** @param {Function} listener 订阅状态变化。 @returns {Function} 退订。 */
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        load,
        flush,
        /** 用纯函数改文档：`mutator(doc) => newDoc`。 */
        mutate(mutator) {
          let next;
          try {
            next = mutator(state.doc);
          } catch (error) {
            patch({ error: errorText(error) });
            return state;
          }
          if (next === state.doc) return state;
          retryAttempts = 0; // 用户重新动手 → 重试额度重来
          patch({ doc: normalizeDoc(next), dirty: true, notice: null });
          if (state.persist === 'ok') schedule();
          return state;
        },
        /** 直接把整份文档换掉（预置方案 / 恢复出厂顺序）。 */
        replace(doc) {
          retryAttempts = 0;
          patch({ doc: normalizeDoc(doc), dirty: true, notice: null });
          if (state.persist === 'ok') schedule();
          return state;
        },
        dispose() {
          // 先尽力把最后一次编辑送出去，再拆。清掉防抖计时器就等于把它扔掉（用户刚拖完就
          // 卸载插件时会静默丢改动）。必须在 disposed = true **之前**调，flush 自己会看这个标志。
          if (disposed !== true && state.dirty === true && state.persist === 'ok' && inFlight === false) {
            void flush();
          }
          disposed = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          listeners.clear();
        },
        /** 供自测观察内部计时器与重试进度。 */
        __peek: () => ({ timer: timer !== null, inFlight, queued, retryAttempts }),
      };
    }

    /* ══════════════════════════ 导航增强器（DOM 层） ══════════════════════════ */

    /** 导航列表的**直接子** button 才是设置项行（我们插的分组标题/工具条里也有 button，必须排除）。 */
    function directButtons(list) {
      const out = [];
      const children = list === null || list === undefined ? [] : list.children;
      for (let index = 0; index < (children ? children.length : 0); index += 1) {
        const child = children[index];
        if (child !== null && child !== undefined && child.tagName === 'BUTTON') out.push(child);
      }
      return out;
    }

    /** 直接子元素里找 tagName。 */
    function firstChildOfTag(list, tag) {
      const children = list === null || list === undefined ? [] : list.children;
      for (let index = 0; index < (children ? children.length : 0); index += 1) {
        const child = children[index];
        if (child !== null && child !== undefined && child.tagName === tag) return child;
      }
      return null;
    }

    /**
     * 在文档里定位设置导航列表。
     *
     * 选择器刻意**不依赖构建期哈希过的类名**（`VOzbGW_navList` 这类名字每次打包都会变）：
     * 结构是「设置模态 `[role=dialog][aria-modal=true]` → 后代 `nav` → 直接子 div 且它的
     * 直接子里有 button」。出厂的模态里只有这一个 nav，标题 div 不含 button，所以判据唯一。
     *
     * @returns {Element|null} 导航列表容器。
     */
    function locateNavList(doc) {
      const document_ = doc === undefined ? document : doc;
      const dialogs = document_.querySelectorAll('[role="dialog"][aria-modal="true"]');
      for (let index = 0; index < dialogs.length; index += 1) {
        const dialog = dialogs[index];
        const nav = typeof dialog.querySelector === 'function' ? dialog.querySelector('nav') : null;
        if (nav === null || nav === undefined) continue;
        const direct = firstChildOfTag(nav, 'DIV');
        if (direct !== null && directButtons(direct).length > 0) return direct;
        const children = nav.children;
        for (let at = 0; at < children.length; at += 1) {
          const child = children[at];
          if (child.tagName !== 'DIV') continue;
          if (directButtons(child).length > 0) return child;
        }
      }
      return null;
    }

    /**
     * 建导航增强器。
     *
     * @param {object} config `{ store, getRows, getDoc }`。
     */
    function createNavEnhancer(config) {
      const store = config.store;
      const getRows = typeof config.getRows === 'function' ? config.getRows : () => [];
      let stopped = false;
      let frame = null;
      let navList = null;
      let appliedFor = null;
      let appliedSignature = '';
      let observer = null;
      let scheduled = false;
      let headers = new Map();
      let taskbar = null;
      let railRecord = null;
      let organize = false;
      let drag = null;
      let marker = null;
      /** 当前落点标记是哪一类（避免每帧重复增删类名）。 */
      let markerClass = null;
      let mismatchStreak = 0;
      const diag = { locates: 0, applies: 0, mismatch: 0, errors: 0, drops: 0, toggles: 0, lastError: null };

      const schedule = () => {
        if (stopped === true || scheduled === true) return;
        scheduled = true;
        const run = () => {
          frame = null;
          scheduled = false;
          // 拆卸之后才轮到的帧：到此为止。否则它会重新 locateNavList()，把监听、留白和
          // 行上的 order/display 又装回去——而 observer 已经断开、disposer 也已经跑过，
          // 那个复活出来的实例再也没人能收拾（面板开着时卸载/重载插件就是这个下场）。
          if (stopped === true) return;
          tick();
        };
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') frame = window.requestAnimationFrame(run);
        else frame = setTimeout(run, 16);
      };

      /** 我们插进导航的节点全部认这个属性，便于一次性摘干净。 */
      const OURS = 'data-dsn-own';

      function dropOurNodes() {
        for (const [, record] of headers) {
          if (record.el.parentNode !== null && record.el.parentNode !== undefined) record.el.parentNode.removeChild(record.el);
        }
        headers = new Map();
        if (taskbar !== null && taskbar.parentNode !== null && taskbar.parentNode !== undefined) taskbar.parentNode.removeChild(taskbar);
        taskbar = null;
      }

      /**
       * 给左列底部留一点白。
       *
       * **不要在这里接管 `overflow` / `flex` / `min-height`**：出厂的 `.VOzbGW_navList`
       * 本来就带 `overflow-y:auto`，而 `nav` 是外层面板里 `align-items:stretch` 的行向 flex
       * 子项（高度被拉伸到面板的确定高度），flex 项的自动最小尺寸又是 0——所以**出厂就滚得动**，
       * 末行永远够得着。早先那版把「出厂不滚动、末行被裁掉」当成前提，还在测试里按 16 行算了
       * 一套高度预算，那些都建立在一次被管道截断的 grep 上，是错的，已删。
       *
       * 真正缺的只有底部留白：出厂 `padding-bottom:0`，滚动到底时最后一行贴住面板圆角。只动
       * 内联样式（不碰出厂 CSS），与 `style.order` 同理：出厂壳不设这个属性，React 不会抹掉。
       *
       * @param {object|null} list 导航列表。
       * @returns {object|null} 改之前的原值，供卸载时还原。
       */
      function padRail(list) {
        if (list === null || list === undefined || list.style === undefined) return null;
        const record = { list, paddingBottom: list.style.paddingBottom };
        list.style.paddingBottom = '12px';
        return record;
      }

      /** 还原 padRail 改过的内联样式（置空而非留值，与行样式同一套口径）。 */
      function unpadRail(record) {
        if (record === null || record === undefined) return;
        // 必须归一成 ''：真实浏览器里给 CSSStyleDeclaration 赋 `undefined` 会被串成非法值
        // 而被**忽略**，我们的留白就留在元素上了（卸载后仍生效）。
        record.list.style.paddingBottom = record.paddingBottom === undefined ? '' : record.paddingBottom;
      }

      function detach() {
        dropOurNodes();
        unpadRail(railRecord);
        railRecord = null;
        // 拖放到一半被卸载（面板被关/插件重载）时，`dragstart` 加过的类和落点标记还挂在
        // 出厂的行上，而 `dragend` 再也不会来了——必须在这里一并擦掉。
        drag = null;
        clearMarker();
        for (const button of navList === null ? [] : directButtons(navList)) button.classList.remove('dsn-navdragging');
        for (const [, record] of headers) record.el.classList.remove('dsn-navdragging');
        if (navList !== null && navList.classList !== undefined && typeof navList.classList.remove === 'function') {
          navList.classList.remove('dsn-navlist-organizing');
        }
        for (const button of navList === null ? [] : directButtons(navList)) {
          button.style.order = '';
          button.style.display = '';
          button.style.marginLeft = '';
          button.removeAttribute('draggable');
        }
        // 必须摘监听：detach() 会把 navList 置空，下一次 tick 又会 locateNavList()；若拿回的
        // 是**同一个**元素（enabled false→true 正是这条路），监听就会叠加一套，于是点一下分组
        // 标题，toggle 被处理两次——收起又被展开，用户看到的是「点了没反应」。
        if (navList !== null && typeof navList.removeEventListener === 'function') {
          navList.removeEventListener('click', onClick, false);
          navList.removeEventListener('dragstart', onDragStart, false);
          navList.removeEventListener('dragover', onDragOver, false);
          navList.removeEventListener('drop', onDrop, false);
          navList.removeEventListener('dragend', onDragEnd, false);
        }
        navList = null;
        appliedFor = null;
        appliedSignature = '';
      }

      /* ------------------------------ 工具条 ------------------------------ */

      function ensureTaskbar(doc) {
        if (taskbar === null || taskbar.parentNode !== navList) {
          taskbar = document.createElement('div');
          taskbar.className = 'dsn-taskbar';
          taskbar.setAttribute(OURS, 'taskbar');
          taskbar.style.order = '-1000';
          navList.appendChild(taskbar);
        }
        taskbar.textContent = '';
        const add = (label, act, extraClass) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'dsn-taskbar-btn' + (extraClass === undefined ? '' : ' ' + extraClass);
          button.setAttribute('data-dsn-act', act);
          button.textContent = label;
          taskbar.appendChild(button);
          return button;
        };
        add(organize ? t('done') : t('organize'), 'organize', organize ? 'on' : undefined);
        if (organize === true) {
          add('＋' + t('newGroup'), 'new-group');
          add(t('collapseAll'), 'collapse-all');
          add(t('expandAll'), 'expand-all');
        }
        taskbar.title = organize === true ? t('organized') : t('navHint');
        // doc 目前不参与工具条渲染，保留参数是为了以后加「当前有 N 组」之类的提示。
        void doc;
      }

      /* ---------------------------- 分组标题 ---------------------------- */

      function ensureHeader(entry, isActiveGroup, onActivePath) {
        let record = headers.get(entry.gid);
        if (record === undefined) {
          const el = document.createElement('div');
          el.className = 'dsn-navheader';
          el.setAttribute(OURS, 'header');
          el.setAttribute('data-dsn-gid', entry.gid);
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'dsn-navheader-btn';
          button.setAttribute('data-dsn-act', 'toggle');
          button.setAttribute('data-dsn-gid', entry.gid);
          const chev = document.createElement('span');
          chev.className = 'dsn-chev';
          chev.textContent = '▾';
          const label = document.createElement('span');
          label.className = 'dsn-navheader-label';
          const count = document.createElement('span');
          count.className = 'dsn-navheader-count';
          button.appendChild(chev);
          button.appendChild(label);
          button.appendChild(count);
          el.appendChild(button);
          record = { el, button, label, count };
          headers.set(entry.gid, record);
          navList.appendChild(el);
        }
        record.el.style.order = String(entry.rank * 10);
        // 层级靠**内联**左内边距表达：出厂 CSS 不设这个属性，React 不会抹掉（同 style.order）。
        record.el.style.paddingLeft = String(12 + entry.depth * RAIL_INDENT) + 'px';
        record.el.setAttribute('data-dsn-collapsed', entry.collapsed === true ? '1' : '0');
        record.el.setAttribute('data-dsn-depth', String(entry.depth));
        // 祖先链写进 DOM：把落点翻回锚点时要它（分组 id 里可能有空格，所以用 JSON）。
        record.el.setAttribute('data-dsn-parent-path', JSON.stringify(entry.path));
        // 祖先被收起 → 整个子树的标题一起藏；但**当前分节所在的那条链**永远露出来，
        // 否则「我在哪」的唯一指示会被一起藏掉。
        record.el.style.display = entry.hidden === true && onActivePath !== true ? 'none' : '';
        if (isActiveGroup === true) record.el.classList.add('dsn-navheader-active');
        else record.el.classList.remove('dsn-navheader-active');
        record.label.textContent = entry.name;
        record.count.textContent = String(entry.count) + ' ' + t('entries');
        record.button.setAttribute('aria-expanded', entry.collapsed === true ? 'false' : 'true');
        record.button.title = t('toggleGroup');
        // 拖动**不再要求先进「整理」模式**：导航里的行与分组标题始终可拖（整理模式只多出
        // 「新建分组 / 全部收起 / 全部展开」这几个按钮与虚线外框）。HTML5 拖拽不影响点击导航。
        record.el.setAttribute('draggable', 'true');
        return record;
      }

      /**
       * 画/更新所有分组标题（含嵌套）。
       *
       * @param {object} plan 导航计划。
       * @param {string[]} activePath 当前分节的祖先链（这条链上的标题永远不隐藏）。
       * @param {string|null} activeGroupId 当前分节的直接父组。
       */
      function renderHeaders(plan, activePath, activeGroupId) {
        const pathSet = new Set(Array.isArray(activePath) ? activePath : []);
        const alive = new Set();
        for (const entry of plan.entries) {
          if (entry.kind !== 'header') continue;
          alive.add(entry.gid);
          ensureHeader(entry, entry.gid === activeGroupId, pathSet.has(entry.gid));
        }
        for (const [gid, record] of Array.from(headers)) {
          if (alive.has(gid)) continue;
          if (record.el.parentNode !== null && record.el.parentNode !== undefined) record.el.parentNode.removeChild(record.el);
          headers.delete(gid);
        }
      }

      /* ------------------------------ 应用 ------------------------------ */

      function tick() {
        try {
          if (stopped === true) return;
          if (typeof document === 'undefined') return;
          if (navList !== null && navList.isConnected === false) detach();
          if (navList === null) {
            navList = locateNavList();
            if (navList === null) return;
            diag.locates += 1;
            navList.addEventListener('click', onClick, false);
            navList.addEventListener('dragstart', onDragStart, false);
            navList.addEventListener('dragover', onDragOver, false);
            navList.addEventListener('drop', onDrop, false);
            navList.addEventListener('dragend', onDragEnd, false);
            appliedFor = null;
            appliedSignature = '';
          }
          apply();
        } catch (error) {
          diag.errors += 1;
          diag.lastError = errorText(error);
        }
      }

      function apply() {
        const state = store.get();
        if (state.loaded !== true) return;
        if (state.enabled !== true) {
          // 被 host 关掉：把上一次留下的痕迹擦干净，然后什么都不做。
          if (appliedFor !== null) detach();
          return;
        }
        // 只在确实要增强时才动左列：enabled=false 是「一字不改」，连底部留白也算改。
        // 幂等，记下的原值由 detach() 还原。
        if (railRecord === null) railRecord = padRail(navList);
        const rows = getRows();
        const buttons = directButtons(navList);
        if (buttons.length !== rows.length) return; // 账本和 DOM 还没对齐，等下一次 mutation
        if (buttons.length > 0) {
          let consistent = true;
          for (let index = 0; index < buttons.length; index += 1) {
            const text = String(buttons[index].textContent === undefined ? '' : buttons[index].textContent).trim();
            if (text !== String(rows[index].label === undefined ? '' : rows[index].label).trim()) {
              consistent = false;
              break;
            }
          }
          if (consistent === false) {
            diag.mismatch += 1;
            mismatchStreak += 1;
            // 连续对不上：出厂改版的可能大于「React 还没提交」的可能。退回纯位置对应，
            // 记诊断，但**继续工作**——宁可顺序可能错位，也不要静默失效。
            if (mismatchStreak < MISMATCH_GIVE_UP) return;
          } else {
            mismatchStreak = 0;
          }
        }

        // 当前分节：出厂壳只把高亮标在行自己身上（`aria-current="true"` + 一个哈希类名
        // 的背景），所以一旦它所在的组被收起，`display:none` 会把「我在哪」的唯一指示
        // 一起藏掉——用户看着内容区却不知道左列哪一项是亮的。两件事补救：
        //   ① 当前那一行**永远不隐藏**（哪怕它所在的组是收起的）；
        //   ② 它所在的分组标题标上 dsn-navheader-active（品牌色），收起时也能一眼看到。
        let activeIndex = -1;
        for (let index = 0; index < buttons.length; index += 1) {
          if (buttons[index].getAttribute('aria-current') === 'true') {
            activeIndex = index;
            break;
          }
        }
        const activeId = activeIndex >= 0 && rows[activeIndex] !== undefined ? rows[activeIndex].id : null;

        const plan = computePlan(state.doc, rows);
        const signature = planSignature(plan, rows, buttons.length, organize, state.revision, activeId);
        if (appliedFor === navList && signature === appliedSignature) return;
        appliedFor = navList;
        appliedSignature = signature;
        diag.applies += 1;

        if (organize === true) navList.classList.add('dsn-navlist-organizing');
        else navList.classList.remove('dsn-navlist-organizing');

        ensureTaskbar(state.doc);
        const activeEntry = activeId === null ? undefined : plan.byId.get(activeId);
        renderHeaders(plan, activeEntry === undefined ? [] : activeEntry.path, activeEntry === undefined ? null : activeEntry.groupId);

        let overflow = plan.entries.length;
        for (let index = 0; index < buttons.length; index += 1) {
          const button = buttons[index];
          const row = rows[index];
          const entry = row === undefined ? undefined : plan.byId.get(row.id);
          const rank = entry === undefined ? overflow++ : entry.rank;
          button.style.order = String(rank * 10);
          // 层级缩进：顶层项不加边距（保持出厂观感），成员按祖先深度右移一级。
          button.style.marginLeft = entry === undefined || entry.depth === 0 ? '' : String(entry.depth * RAIL_INDENT + 12) + 'px';
          const hidden = entry !== undefined && entry.hidden === true;
          const isActive = entry !== undefined && entry.id === activeId;
          button.style.display = hidden && !isActive ? 'none' : '';
          button.setAttribute('draggable', 'true');
        }
      }

      /* ------------------------------ 交互 ------------------------------ */

      /** 落点元素 → 设置项 id（只认导航列表的直接子 button）；不是设置项行就返回 null。 */
      function rowIdOf(target) {
        if (target === null || target === undefined) return null;
        let node = target;
        while (node !== null && node !== undefined && node.parentNode !== navList) node = node.parentNode;
        if (node === null || node === undefined || node.parentNode !== navList || node.tagName !== 'BUTTON') return null;
        const index = directButtons(navList).indexOf(node);
        const rows = getRows();
        return index >= 0 && rows[index] !== undefined ? rows[index].id : null;
      }

      /** 命中判定：只有两种合法落点——我们自己插的分组标题，或导航列表的直接子 button。 */
      function hitTest(target) {
        if (target === null || target === undefined || typeof target.closest !== 'function') return null;
        const header = target.closest('[' + OURS + '="header"]');
        if (header !== null && header !== undefined) return header;
        if (rowIdOf(target) === null) return null;
        let node = target;
        while (node !== null && node !== undefined && node.parentNode !== navList) node = node.parentNode;
        return node;
      }

      /** 读回标题上的祖先链（把落点翻成锚点时要它）。 */
      function pathOfHeader(element) {
        const raw = element.getAttribute('data-dsn-parent-path');
        if (typeof raw !== 'string' || raw === '') return [];
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
        } catch (error) {
          return [];
        }
      }

      /** 分组标题的三段判定：上 30% 前、下 30% 后、中间 40% 是「放进这一组」。 */
      function zoneOf(element, clientY) {
        try {
          const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
          if (rect !== null && rect.height > 0) {
            const ratio = (clientY - rect.top) / rect.height;
            if (ratio < 0.3) return 'before';
            if (ratio > 0.7) return 'after';
            return 'into';
          }
        } catch (error) {
          /* 拿不到几何信息就按「前面」处理 */
        }
        return 'before';
      }

      /**
       * 把一个 DOM 落点翻成**锚点**（容器路径 + 同级参照物）。
       *
       * 分组标题有**三段**：上 30% = 落到它前面，下 30% = 落到它后面，中间 40% = 拖进这一组
       * （`ref: null`，追加成该组最后一个子条目，落点已收起时顺带展开）。设置项行只有前后两段；
       * 账本里有、文档里没提到的行也是有效落点（`computePlan` 把它当未分组项追加，它确实画在
       * 左列上），它的锚点落到顶层末尾。
       *
       * @param {object} element 落点元素。
       * @param {number} clientY 指针的纵向位置。
       * @returns {{container: string[], ref: object|null, side?: string}|null} 锚点。
       */
      function anchorOf(element, clientY) {
        if (element === null || element === undefined) return null;
        const gid = element.getAttribute('data-dsn-gid');
        if (element.getAttribute('data-dsn-act') === 'toggle' || element.getAttribute(OURS) === 'header') {
          if (gid === null || gid === undefined) return null;
          const path = pathOfHeader(element);
          const zone = zoneOf(element, clientY);
          if (zone === 'into') {
            // 往里放会多出**一层**；已经到顶就不再往深处落（否则文档会被归一化悄悄削掉一层）。
            if (path.length >= MAX_DEPTH - 1) return null;
            return { container: path.concat([gid]), ref: null, side: 'after' };
          }
          return { container: path, ref: { kind: 'group', id: gid }, side: zone };
        }
        const id = rowIdOf(element);
        if (id === null) return null;
        const entry = computePlan(store.get().doc, getRows()).byId.get(id);
        if (entry === undefined) return null;
        return { container: entry.path.slice(), ref: { kind: 'item', id }, side: sideOf(element, clientY) };
      }

      function sideOf(element, clientY) {
        try {
          const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
          if (rect !== null && rect.height > 0) return clientY > rect.top + rect.height / 2 ? 'after' : 'before';
        } catch (error) {
          /* 拿不到几何信息就默认放前面 */
        }
        return 'before';
      }

      function clearMarker() {
        if (marker === null) return;
        marker.classList.remove(DROP_BEFORE);
        marker.classList.remove(DROP_AFTER);
        marker.classList.remove(DROP_INTO);
        marker = null;
        markerClass = null;
      }

      /** 给落点元素点上标记；`ref === null` 的锚点是「放进这一组」，用另一种标记。 */
      function markDrop(element, anchor) {
        const cls = anchor === null ? null : anchor.ref === null ? DROP_INTO : anchor.side === 'after' ? DROP_AFTER : DROP_BEFORE;
        if (cls === null) {
          clearMarker();
          return;
        }
        if (marker === element && markerClass === cls) return;
        clearMarker();
        marker = element;
        markerClass = cls;
        element.classList.add(cls);
      }

      function onDragStart(event) {
        const target = event.target;
        if (target === null || target === undefined) return;
        const header = typeof target.closest === 'function' ? target.closest('[data-dsn-gid][' + OURS + '="header"]') : null;
        if (header !== null && header !== undefined) {
          drag = { kind: 'group', id: header.getAttribute('data-dsn-gid') };
        } else {
          const id = rowIdOf(target);
          if (id === null) return;
          drag = { kind: 'item', id };
        }
        if (event.dataTransfer !== undefined && event.dataTransfer !== null) {
          try {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', drag.kind + ':' + drag.id);
          } catch (error) {
            /* 某些浏览器对自定义 dataTransfer 挑剔，拖拽本身照常 */
          }
        }
        if (typeof target.classList !== 'undefined' && target.classList !== null) target.classList.add('dsn-navdragging');
      }

      function onDragOver(event) {
        if (drag === null) return;
        const target = event.target;
        if (target === null || target === undefined || typeof target.closest !== 'function') return;
        const element = hitTest(target);
        const inNav = target.closest('nav');
        if (inNav === null || inNav === undefined || element === null) {
          clearMarker();
          return;
        }
        if (event.preventDefault !== undefined) event.preventDefault();
        markDrop(element, anchorOf(element, event.clientY === undefined ? 0 : event.clientY));
      }

      function onDrop(event) {
        if (drag === null) return;
        const target = event.target;
        if (target === null || target === undefined || typeof target.closest !== 'function') return;
        if (event.preventDefault !== undefined) event.preventDefault();
        const element = hitTest(target);
        const anchor = element === null ? null : anchorOf(element, event.clientY === undefined ? 0 : event.clientY);
        const source = drag;
        drag = null;
        clearMarker();
        if (anchor === null) return;
        diag.drops += 1;
        store.mutate((current) => {
          const next = applyDrop(current, source, anchor);
          if (next === current) return current;
          // 落进一个**收起**的组：把它展开，否则刚放进去的东西立刻藏起来，看着像没生效。
          if (anchor.ref === null && anchor.container.length > 0) {
            return setGroupCollapsed(next, anchor.container[anchor.container.length - 1], false);
          }
          return next;
        });
      }

      function onDragEnd() {
        drag = null;
        clearMarker();
        for (const button of navList === null ? [] : directButtons(navList)) button.classList.remove('dsn-navdragging');
        for (const [, record] of headers) record.el.classList.remove('dsn-navdragging');
      }

      function onClick(event) {
        const target = event.target;
        if (target === null || target === undefined || typeof target.closest !== 'function') return;
        const button = target.closest('[data-dsn-act]');
        if (button === null || button === undefined) return;
        const act = button.getAttribute('data-dsn-act');
        if (act === 'toggle') {
          const gid = button.getAttribute('data-dsn-gid');
          const group = findGroupNode(store.get().doc.order, gid);
          if (group === null) return;
          // 左列的折叠是「即时的收纳」，不经过管理页：直接改文档 → 重刷 → 落盘（防抖）。
          event.preventDefault();
          event.stopPropagation();
          diag.toggles += 1;
          store.mutate((current) => setGroupCollapsed(current, gid, group.collapsed !== true));
          return;
        }
        if (act === 'organize') {
          event.preventDefault();
          organize = organize !== true;
          appliedSignature = '';
          apply();
          return;
        }
        if (act === 'new-group') {
          event.preventDefault();
          store.mutate((current) => createGroup(current));
          organize = true;
          appliedSignature = '';
          apply();
          return;
        }
        if (act === 'collapse-all' || act === 'expand-all') {
          event.preventDefault();
          const collapsed = act === 'collapse-all';
          store.mutate((current) => setAllCollapsed(current, collapsed));
        }
      }

      return {
        diag,
        /** 开始观察（返回清理函数，挂到 ctx.effect 上）。 */
        install() {
          if (typeof document === 'undefined' || document.body === null || document.body === undefined) return () => {};
          if (typeof MutationObserver === 'function') {
            observer = new MutationObserver(() => schedule());
            observer.observe(document.body, { childList: true, subtree: true });
          }
          schedule();
          return () => {
            // 先立旗再拆：已经排出去的那一帧会在 run()/tick() 里自己退出，不必跟它抢时序。
            stopped = true;
            scheduled = false;
            if (frame !== null) {
              if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
              else clearTimeout(frame);
              frame = null;
            }
            if (observer !== null) {
              observer.disconnect();
              observer = null;
            }
            detach();
          };
        },
        /** 手动催一帧（状态变化时调用）。 */
        schedule,
        /** 绝对化的一帧（自测用，跳过 rAF）。 */
        tick,
        /** 供自测观察内部状态。 */
        __peek: () => ({ navList, organized: organize, headers: Array.from(headers.keys()), taskbar: taskbar !== null, signature: appliedSignature }),
      };
    }

    /* ══════════════════════════ 设置页「设置导航」 ══════════════════════════ */

    /**
     * 管理面。所有改动都只做一件事：`store.mutate(纯函数)`——左列立刻跟着变，
     * 落盘由状态仓防抖负责。
     */
    function SettingsNavPage(props) {
      const store = props.store;
      const getRows = props.getRows;
      const [, setTick] = React.useState(0);
      const [draft, setDraft] = React.useState(null);
      const dragRef = React.useRef(null);
      const [overKey, setOverKey] = React.useState(null);

      React.useEffect(() => store.subscribe(() => setTick((value) => value + 1)), [store]);

      const state = store.get();
      const rows = getRows();
      const labelOf = (id) => {
        const row = rows.find((candidate) => candidate.id === id);
        return row === undefined ? null : row.label;
      };
      const nameOf = (id) => {
        const label = labelOf(id);
        return label === null || label === '' ? id : label;
      };

      const cards = [];

      cards.push(
        h('div', { className: 'dsn-card', key: 'head' },
          h('div', { className: 'dsn-sub' }, t('title')),
          h('div', { className: 'dsn-meta' }, t('intro')),
          h('div', { className: 'dsn-code' }, t('file') + '：' + (state.path === '' ? '—' : state.path)),
          h('div', { className: 'dsn-meta' },
            t('revision') + ' ' + state.revision + '　·　' + t('persist') + ' ' + (state.persist === 'ok' ? t('persistOk') : t('persistNo'))
            + '　·　' + t('hostBuild') + ' ' + (state.hostBuild === '' ? '—' : state.hostBuild + ' / ' + BUILD)
            + (state.saving === true ? '　·　…' : state.dirty === true ? '　·　' + t('unsaved') : state.lastSavedAt === null ? '' : '　·　' + t('saved'))),
        ),
      );

      if (state.loaded !== true) {
        cards.push(h('div', { className: 'dsn-card', key: 'loading' }, h('div', { className: 'dsn-meta' }, t('loading'))));
        return h('div', { className: 'dsn-root' }, cards);
      }
      if (state.enabled !== true) {
        cards.push(h('div', { className: 'dsn-card', key: 'disabled' }, h('div', { className: 'dsn-error' }, t('disabled'))));
      }
      if (state.persist !== 'ok') {
        cards.push(h('div', { className: 'dsn-card', key: 'persist' },
          h('div', { className: 'dsn-error' }, t('persistUnavailable')),
          state.error === null ? null : h('div', { className: 'dsn-error' }, state.error)));
      } else if (state.error !== null) {
        cards.push(h('div', { className: 'dsn-card', key: 'error' }, h('div', { className: 'dsn-error' }, state.error)));
      }
      if (state.notice !== null) {
        cards.push(h('div', { className: 'dsn-card', key: 'notice' }, h('div', { className: 'dsn-notice' }, state.notice)));
      }
      if (Array.isArray(state.warnings) && state.warnings.length > 0) {
        cards.push(h('div', { className: 'dsn-card', key: 'warnings' },
          h('div', { className: 'dsn-sub' }, t('diag')),
          state.warnings.map((warning, index) => h('div', { className: 'dsn-meta', key: 'w' + index }, '· ' + warning))));
      }

      /* ------------------------------ 工具行 ------------------------------ */

      const toolbar = h('div', { className: 'dsn-row', key: 'actions' },
        h('button', { className: 'dsn-btn primary', onClick: () => store.mutate((doc) => createGroup(doc)) }, '＋ ' + t('newGroup')),
        h('button', { className: 'dsn-btn', onClick: () => store.mutate((doc) => setAllCollapsed(doc, true)) }, t('collapseAll')),
        h('button', { className: 'dsn-btn', onClick: () => store.mutate((doc) => setAllCollapsed(doc, false)) }, t('expandAll')),
        h('span', { className: 'dsn-spacer' }),
        h('button', {
          className: 'dsn-btn',
          title: t('presetHint'),
          onClick: () => {
            if (typeof window !== 'undefined' && typeof window.confirm === 'function' && window.confirm(t('confirmPreset')) !== true) return;
            store.replace(suggestedLayout(rows));
          },
        }, t('preset')),
        h('button', {
          className: 'dsn-btn',
          title: t('resetHint'),
          onClick: () => {
            if (typeof window !== 'undefined' && typeof window.confirm === 'function' && window.confirm(t('confirmReset')) !== true) return;
            store.replace(emptyDoc());
          },
        }, t('reset')));

      /* ------------------------------ 布局编辑 ------------------------------ */

      const order = state.doc.order;
      /** 分组总数（含嵌套）。 */
      const groupTotal = countGroups(order);

      /** 悬停高亮的 key：`#into` 后缀区分「放进这一组」与「落在它前/后」。 */
      const isOver = (key) => overKey === key || overKey === key + '#into';

      /**
       * 落点的三段判定（分组行）：上 30% 前、下 30% 后、中间 40% 是「放进这一组」。
       * 设置项行与未分组池只有前后两段（`includeInto` 为假）。
       */
      const zoneOfRow = (event, element, includeInto) => {
        try {
          const rect = element !== null && element !== undefined && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
          if (rect !== null && rect.height > 0) {
            const ratio = (event.clientY - rect.top) / rect.height;
            if (ratio < 0.3) return 'before';
            if (includeInto === true && ratio <= 0.7) return 'into';
            return 'after';
          }
        } catch (error) {
          /* 拿不到几何信息就按「前面」处理 */
        }
        return 'before';
      };

      /**
       * 落点处理：可拖的元素与「只作落点」的元素（空分组占位条）共用同一套。
       *
       * `payload.anchor` 是「落在它前/后」的锚点；`payload.into` 是「放进这一组」的锚点；
       * `payload.intoOnly === true`（空分组占位条）表示无论落在条子的哪一段都是「放进这一组」。
       */
      const dropProps = (key, payload) => ({
        onDragOver: (event) => {
          if (dragRef.current === null) return;
          if (event.preventDefault !== undefined) event.preventDefault();
          const zone = zoneOfRow(event, event.currentTarget, payload.into !== undefined && payload.into !== null);
          setOverKey(zone === 'into' || payload.intoOnly === true ? key + '#into' : key);
        },
        onDragLeave: () => setOverKey((current) => (current === key || current === key + '#into' ? null : current)),
        onDrop: (event) => {
          if (event.preventDefault !== undefined) event.preventDefault();
          const source = dragRef.current;
          dragRef.current = null;
          setOverKey(null);
          if (source === null) return;
          const zone = zoneOfRow(event, event.currentTarget, payload.into !== undefined && payload.into !== null);
          const into = payload.into !== undefined && payload.into !== null && (payload.intoOnly === true || zone === 'into');
          const anchor = into ? payload.into : Object.assign({}, payload.anchor, { side: zone === 'after' ? 'after' : 'before' });
          store.mutate((doc) => applyDrop(doc, source, anchor));
        },
      });

      const dragProps = (key, payload) => Object.assign({
        draggable: true,
        onDragStart: (event) => {
          dragRef.current = { kind: payload.kind, id: payload.id };
          if (event.dataTransfer !== null && event.dataTransfer !== undefined) {
            try {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', key);
            } catch (error) {
              /* 忽略：不影响内部拖拽状态 */
            }
          }
        },
      }, dropProps(key, payload));

      /** 一个设置项行（顶层项或分组成员）。 */
      const itemRow = (id, path, depth, at, total) => {
        const topLevel = path.length === 0;
        const key = (topLevel ? 'i:' : 'm:') + id;
        return h('div', {
          className: 'dsn-entry' + (topLevel ? '' : ' dsn-member') + (isOver(key) ? ' dsn-over' : ''),
          key,
          // 缩进 = 自己的层级 * 16（分组行用 d*16，成员天然比它的组深一级）。
          style: { marginLeft: String(path.length * 16) + 'px' },
          ...dragProps(key, { kind: 'item', id, anchor: { container: path, ref: { kind: 'item', id }, side: 'before' } }),
        },
        h('span', { className: 'dsn-handle' }, '⠿'),
        h('span', { className: 'dsn-section' }, nameOf(id)),
        h('span', { className: 'dsn-id' }, id),
        id === 'general' || labelOf(id) !== null ? null : h('span', { className: 'dsn-badge' }, t('sectionUnknown')),
        h('span', { className: 'dsn-spacer' }),
        h('button', { className: 'dsn-btn icon', title: t('expand'), disabled: at === 0, onClick: () => store.mutate((doc) => moveSibling(doc, 'item', id, -1)) }, '↑'),
        h('button', { className: 'dsn-btn icon', title: t('collapse'), disabled: at === total - 1, onClick: () => store.mutate((doc) => moveSibling(doc, 'item', id, 1)) }, '↓'),
        topLevel
          ? groupSelect(id, store, order, t)
          : h('button', { className: 'dsn-btn', onClick: () => store.mutate((doc) => moveOutOfGroup(doc, id, path[path.length - 1])) }, t('remove')));
      };

      /** 一个分组行（含「＋ 子分组」与「移出分组」）。 */
      const groupRow = (group, path, depth, at, total) => {
        const key = 'g:' + group.id;
        const drafting = draft !== null && draft.gid === group.id;
        // 往里放会多出一层：到顶时不给 into 锚点（否则归一化会把整层悄悄削掉）。
        const into = path.length >= MAX_DEPTH - 1 ? null : { container: path.concat([group.id]), ref: null, side: 'after' };
        return h('div', {
          className: 'dsn-entry dsn-group' + (isOver(key) ? ' dsn-over' : ''),
          key,
          style: { marginLeft: String(depth * 16) + 'px' },
          ...dragProps(key, {
            kind: 'group',
            id: group.id,
            anchor: { container: path, ref: { kind: 'group', id: group.id }, side: 'before' },
            into,
          }),
        },
        h('span', { className: 'dsn-handle' }, '⠿'),
        drafting
          ? h('input', {
            className: 'dsn-input',
            value: draft.name,
            autoFocus: true,
            onChange: (event) => setDraft({ gid: group.id, name: event.target.value }),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                store.mutate((doc) => renameGroup(doc, group.id, draft.name));
                setDraft(null);
              }
              if (event.key === 'Escape') setDraft(null);
            },
          })
          : h('span', { className: 'dsn-name' }, group.name),
        h('span', { className: 'dsn-badge' + (group.collapsed === true ? ' on' : '') }, group.collapsed === true ? t('collapse') : t('expand')),
        h('span', { className: 'dsn-id' }, group.id + ' · ' + String(group.items.length) + ' ' + t('entries')),
        h('span', { className: 'dsn-spacer' }),
        drafting
          ? h('button', {
            className: 'dsn-btn primary',
            onClick: () => {
              store.mutate((doc) => renameGroup(doc, group.id, draft.name));
              setDraft(null);
            },
          }, t('save'))
          : h('button', { className: 'dsn-btn', onClick: () => setDraft({ gid: group.id, name: group.name }) }, t('rename')),
        h('button', {
          className: 'dsn-btn',
          title: t('toggleGroup'),
          onClick: () => store.mutate((doc) => setGroupCollapsed(doc, group.id, group.collapsed !== true)),
        }, group.collapsed === true ? t('expand') : t('collapse')),
        h('button', {
          className: 'dsn-btn',
          title: t('subGroupHint'),
          disabled: into === null,
          onClick: () => store.mutate((doc) => createGroup(doc, group.id)),
        }, '＋ ' + t('subGroup')),
        h('button', { className: 'dsn-btn icon', title: t('expand'), disabled: at === 0, onClick: () => store.mutate((doc) => moveSibling(doc, 'group', group.id, -1)) }, '↑'),
        h('button', { className: 'dsn-btn icon', title: t('collapse'), disabled: at === total - 1, onClick: () => store.mutate((doc) => moveSibling(doc, 'group', group.id, 1)) }, '↓'),
        path.length === 0
          ? null
          : h('button', { className: 'dsn-btn', onClick: () => store.mutate((doc) => moveOutOfGroup(doc, group.id, path[path.length - 1])) }, t('remove')),
        h('button', {
          className: 'dsn-btn',
          title: t('deleteHint'),
          onClick: () => store.mutate((doc) => deleteGroup(doc, group.id)),
        }, t('delete')));
      };

      /**
       * 递归渲染一棵子树。管理页**永远展开**（编辑时不藏东西），层级只用缩进表达；
       * 空分组补一条只作落点的占位条（「把设置项拖进来」这句文案得有个兑现的地方）。
       */
      const renderLevel = (list, path, depth) => {
        const out = [];
        const total = list.length;
        for (let at = 0; at < total; at += 1) {
          const child = list[at];
          if (isGroupNode(child)) {
            out.push(groupRow(child, path, depth, at, total));
            out.push(...renderLevel(child.items, path.concat([child.id]), depth + 1));
            if (child.items.length === 0) {
              const key = 'g:' + child.id + ':empty';
              out.push(h('div', {
                className: 'dsn-entry dsn-member dsn-empty' + (isOver(key) ? ' dsn-over' : ''),
                key,
                style: { marginLeft: String((depth + 1) * 16) + 'px' },
                ...dropProps(key, { into: { container: path.concat([child.id]), ref: null, side: 'after' }, intoOnly: true }),
              },
              h('span', { className: 'dsn-meta' }, localeId === 'en' ? 'Empty. Drag entries here from Ungrouped.' : '（空分组）把下面的设置项拖进来，或从「未分组」加入。')));
            }
            continue;
          }
          const id = childItemId(child);
          if (id === null) continue;
          out.push(itemRow(id, path, depth, at, total));
        }
        return out;
      };

      const list = renderLevel(order, [], 0);

      cards.push(h('div', { className: 'dsn-card', key: 'layout' },
        h('div', { className: 'dsn-sub' }, t('layout')),
        h('div', { className: 'dsn-meta' }, t('dragHint')),
        toolbar,
        order.length === 0 ? h('div', { className: 'dsn-meta' }, t('emptyLayout')) : h('div', { className: 'dsn-list' }, list)));

      /* ------------------------------ 未分组 ------------------------------ */

      const placed = new Set();
      const collectPlaced = (children) => {
        for (const child of children) {
          if (typeof child === 'string') {
            placed.add(child);
            continue;
          }
          if (isGroupNode(child)) {
            collectPlaced(child.items);
            continue;
          }
          const id = childItemId(child);
          if (id !== null) placed.add(id);
        }
      };
      collectPlaced(order);
      const loose = rows.filter((row) => !placed.has(row.id));
      if (loose.length > 0) {
        cards.push(h('div', { className: 'dsn-card', key: 'loose' },
          h('div', { className: 'dsn-sub' }, t('ungrouped') + '（' + loose.length + '）'),
          h('div', { className: 'dsn-meta' }, t('ungroupedHint')),
          h('div', { className: 'dsn-list' }, loose.map((row) => h('div', {
            className: 'dsn-entry' + (isOver('l:' + row.id) ? ' dsn-over' : ''),
            key: 'l:' + row.id,
            ...dragProps('l:' + row.id, { kind: 'item', id: row.id, anchor: { container: [], ref: { kind: 'item', id: row.id }, side: 'before' } }),
          },
          h('span', { className: 'dsn-handle' }, '⠿'),
          h('span', { className: 'dsn-section' }, row.label === '' ? row.id : row.label),
          h('span', { className: 'dsn-id' }, row.id),
          h('span', { className: 'dsn-spacer' }),
          groupSelect(row.id, store, order, t))))));
      }

      /* ------------------------------ 失联项 ------------------------------ */

      const live = new Set(rows.map((row) => row.id));
      const orphans = computePlan(state.doc, rows).orphans;
      if (orphans.length > 0) {
        cards.push(h('div', { className: 'dsn-card', key: 'orphans' },
          h('div', { className: 'dsn-sub' }, t('orphans') + '（' + orphans.length + '）'),
          h('div', { className: 'dsn-meta' }, t('orphansHint')),
          h('div', { className: 'dsn-list' }, orphans.map((id) => h('div', { className: 'dsn-entry', key: 'o:' + id },
            h('span', { className: 'dsn-id' }, id)))),
          h('div', { className: 'dsn-row' }, h('button', {
            className: 'dsn-btn',
            onClick: () => store.mutate((doc) => cleanupOrphans(doc, live)),
          }, t('cleanup')))));
      }

      /* ------------------------------ 诊断 ------------------------------ */

      const enhancerDiag = props.enhancerDiag === undefined ? null : props.enhancerDiag;
      cards.push(h('div', { className: 'dsn-card', key: 'diag' },
        h('div', { className: 'dsn-sub' }, t('diag')),
        h('div', { className: 'dsn-meta' },
          t('layout') + '：' + t('groupsCount') + ' ' + groupTotal
          + '　·　' + t('itemsCount') + ' ' + placed.size
          + '　·　' + t('ungrouped') + ' ' + loose.length),
        enhancerDiag === null ? null : h('div', { className: 'dsn-meta' },
          t('diagNav') + '：' + t('navFound') + ' ' + enhancerDiag.locates
          + '　·　' + t('navApplied') + ' ' + enhancerDiag.applies
          + '　·　' + t('navMismatch') + ' ' + enhancerDiag.mismatch
          + '　·　' + t('navErrors') + ' ' + enhancerDiag.errors
          + '　·　' + t('lastError') + ' ' + (enhancerDiag.lastError === null ? t('noError') : enhancerDiag.lastError))));

      return h('div', { className: 'dsn-root' }, cards);
    }

    /** 「加入分组…」下拉：把某个设置项移到指定分组末尾（含嵌套分组，选项按层级缩进）。 */
    function groupSelect(id, store, order, translate) {
      const options = [];
      const walk = (children, depth) => {
        for (const child of children) {
          if (!isGroupNode(child)) continue;
          options.push({ id: child.id, label: '\u3000'.repeat(depth) + child.name });
          walk(child.items, depth + 1);
        }
      };
      walk(Array.isArray(order) ? order : [], 0);
      if (options.length === 0) return null;
      return h('select', {
        className: 'dsn-select',
        value: '',
        onChange: (event) => {
          const target = event.target.value;
          event.target.value = '';
          if (target === '') return;
          if (target === '__end') {
            store.mutate((doc) => appendLoose(doc, id));
            return;
          }
          store.mutate((doc) => moveIntoGroup(doc, id, target));
        },
      },
      h('option', { value: '' }, translate('addTo')),
      h('option', { value: '__end' }, translate('toEnd')),
      options.map((option) => h('option', { key: option.id, value: option.id }, option.label)));
    }

    /* ══════════════════════════════ 装配 ══════════════════════════════ */

    /** 账本行：与出厂壳的投影口径逐条对齐（`entries()` + 只按 order 的稳定排序）。 */
    function ledgerRows(ctx) {
      try {
        const slots = ctx.slots;
        if (slots === undefined || slots === null || typeof slots.entries !== 'function') return [];
        const entries = slots.entries('settings.section');
        const rows = [];
        for (const entry of entries) {
          const options = entry !== null && entry !== undefined && entry.options !== undefined ? entry.options : {};
          const id = typeof options.id === 'string' ? options.id : '';
          if (id === '') continue;
          rows.push({ id, order: typeof options.order === 'number' ? options.order : 0, label: resolveLabel(options.label) });
        }
        rows.sort((left, right) => left.order - right.order);
        return rows;
      } catch (error) {
        return [];
      }
    }

    const inject = ['slots'];

    /**
     * 当前挂载实例（与 dsh-model-groups 的 pluginCtx 同款做法）。只为两件事：
     *   ① 自测能拿到 apply 真正装配出来的那对 store/enhancer（而不是自己另造一对，
     *      那样两个增强器会同时改同一列 DOM，测出来的顺序谁也不算数）；
     *   ② 排障时可以 `ui.active()` 看实时状态。
     */
    let active = null;

    function apply(ctx) {
      ctx.effect(() => injectStyles(), 'dsh-settings-nav: page css');

      const store = createStore({});
      const enhancer = createNavEnhancer({
        store,
        getRows: () => ledgerRows(ctx),
      });
      active = { ctx, store, enhancer };

      ctx.effect(() => enhancer.install(), 'dsh-settings-nav: nav enhancer');
      ctx.effect(() => store.subscribe(() => enhancer.schedule()), 'dsh-settings-nav: state → nav');
      ctx.effect(() => {
        void store.load();
      }, 'dsh-settings-nav: initial load');
      ctx.effect(() => () => store.dispose(), 'dsh-settings-nav: store dispose');

      // 切后台 / 关页面前把挂起的写发出去（防抖窗口内直接关页会丢掉最后一次拖动）。
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        ctx.effect(() => {
          const flush = () => {
            void store.flush();
          };
          const onVisibility = () => {
            if (document.visibilityState === 'hidden') flush();
          };
          document.addEventListener('visibilitychange', onVisibility);
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', flush);
          return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('pagehide', flush);
          };
        }, 'dsh-settings-nav: flush on hide');
      }

      // 账本或语言一变，左列的标签/行集合就变，签名要重算。
      try {
        if (typeof ctx.slots.subscribe === 'function') {
          ctx.effect(() => ctx.slots.subscribe('settings.section', () => enhancer.schedule()), 'dsh-settings-nav: ledger → nav');
        }
      } catch (error) {
        /* 没有 subscribe 面也能跑：MutationObserver 会兜住重渲染 */
      }
      const locale = ctx.get('locale');
      if (locale !== undefined && locale !== null && typeof locale.subscribe === 'function') {
        ctx.effect(() => {
          const sync = () => {
            try {
              const snapshot = locale.getSnapshot();
              localeId = snapshot !== undefined && snapshot !== null && snapshot.active === 'en' ? 'en' : 'zh';
            } catch (error) {
              localeId = 'zh';
            }
            enhancer.schedule();
          };
          sync();
          return locale.subscribe(sync);
        }, 'dsh-settings-nav: locale');
      }

      // 必须包一层：`settings.section` 是 list 槽，**同一个 priority 下的重复 id 会让
      // register 抛错**，而这个错会一路穿过 slots.inject → apply，让整条 fiber 失败，出厂壳
      // 的启动审计随即抛「web boot: N entries did not activate」——整个 Web UI 起不来。
      // 代价一比就清楚：宁可我们这一节不出现（留一条 warning 和可查的原因），也不能拖垮页面。
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: SECTION_ID, order: SECTION_ORDER, label: () => t('navLabel') },
          (slotProps) => h(SettingsNavPage, Object.assign({}, slotProps, { store, getRows: () => ledgerRows(ctx), enhancerDiag: enhancer.diag })),
        ));
        registrationFailure = null;
      } catch (error) {
        registrationFailure = errorText(error);
        ctx.logger?.warn?.(`dsh-settings-nav: 注册设置项节失败（id 冲突？）：${registrationFailure}`);
      }
    }

    exports.inject = inject;
    exports.apply = apply;

    // 供 client-selftest.mjs 无头驱动：纯函数、状态仓、导航增强器、组件直接可用。
    exports.__ui = {
      BUILD,
      SCHEMA,
      SECTION_ID,
      SECTION_ORDER,
      SAVE_DEBOUNCE_MS,
      MAX_GROUPS,
      MAX_DEPTH,
      RAIL_INDENT,
      ROUTE,
      t,
      setLocale: (id) => {
        localeId = id === 'en' ? 'en' : 'zh';
      },
      emptyDoc,
      normalizeDoc,
      computePlan,
      planSignature,
      applyDrop,
      moveIntoGroup,
      moveOutOfGroup,
      appendLoose,
      createGroup,
      renameGroup,
      setGroupCollapsed,
      setAllCollapsed,
      deleteGroup,
      moveMember,
      moveTopLevel,
      cleanupOrphans,
      moveSibling,
      isGroupNode,
      childItemId,
      matchesRef,
      findGroupNode,
      pathOfNode,
      containerExisting,
      updateContainer,
      removeNode,
      insertNode,
      mapGroup,
      countGroups,
      collectGroupIds,
      suggestedLayout,
      generateGroupId,
      locate,
      withoutId,
      resolveLabel,
      cleanName,
      locateNavList,
      directButtons,
      createStore,
      createNavEnhancer,
      ledgerRows,
      hookLayout: ['tick', 'draft', 'dragRef', 'overKey', 'subscribe'],
      active: () => active,
      registrationFailure: () => registrationFailure,
      Page: SettingsNavPage,
    };
    return module.exports;
  },
});
