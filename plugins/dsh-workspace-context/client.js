/**
 * dsh-workspace-context —— 浏览器半边。
 *
 * 设置页新增「工作区常驻上下文」一节（order 20，排在「模型分组」(25) 之前）：
 *   - 工作区清单：已配置条目（路径/显示名/字节/启用位/最后修改者）+ 已知但还没
 *     配置的工作区（来自 workspaceRegistry 与本插件见过的会话 cwd），一键新建；
 *   - 正文编辑器：文本框直接改该工作区的常驻正文，防抖 1200ms 自动保存 + 显式
 *     「保存」+ Ctrl/Cmd+S；页面上同时给出**磁盘文件路径**——人可以直接 `vim`
 *     那个文件，host 半边按 mtime/size 热读，约 1 秒内生效；
 *   - 未绑定文件：头部缺失/写坏的 .md 不猜不删，列在这里一键收编到指定工作区；
 *   - 诊断：装配次数 / 注入次数 / 各类跳过计数 / 最近一次注入的工作区与字节数，
 *     用来回答「为什么这条没有进上下文」。
 *
 * 数据全部走本插件 host 半边的同源路由（静态插件没有动态包的 host.call）：
 *   GET  /dsh-workspace-context/state[?cwd=…]
 *   POST /dsh-workspace-context/{save,enabled,bind,trash,reload}
 *
 * 由 package.json 的 dsh.client 声明装载（exports["./client"]）。
 *
 * @module dsh-workspace-context/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-context',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/dsh-workspace-context';
    const AUTOSAVE_MS = 1200;

    const PAGE_CSS = [
      '.wctx-root { display: flex; flex-direction: column; gap: 12px; font-size: 13px; color: var(--dsw-alias-label-primary); }',
      '.wctx-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }',
      '.wctx-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.7; }',
      '.wctx-code { font-family: monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }',
      '.wctx-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.wctx-list { display: flex; flex-direction: column; gap: 6px; }',
      '.wctx-entry { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }',
      '.wctx-entry.active { border-color: var(--dsw-alias-brand-primary); }',
      '.wctx-path { font-family: monospace; font-size: 12px; font-weight: 600; word-break: break-all; }',
      '.wctx-name { font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }',
      '.wctx-dim { opacity: .72; }',
      '.wctx-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; }',
      '.wctx-btn:hover { border-color: var(--dsw-alias-brand-primary); }',
      '.wctx-btn.primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }',
      '.wctx-btn.danger { color: var(--dsw-alias-label-secondary); }',
      '.wctx-input { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 4px 8px; font-size: 12px; flex: 1 1 320px; min-width: 200px; }',
      '.wctx-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
      '.wctx-text { width: 100%; min-height: 260px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 10px; font-size: 12px; line-height: 1.7; font-family: monospace; resize: vertical; box-sizing: border-box; }',
      '.wctx-text:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
      '.wctx-badge { border-radius: 999px; padding: 1px 8px; font-size: 11px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }',
      '.wctx-badge.on { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }',
      '.wctx-error { color: #d9534f; font-size: 12px; line-height: 1.6; white-space: pre-wrap; }',
      '.wctx-notice { color: var(--dsw-alias-brand-primary); font-size: 12px; }',
      '.wctx-spacer { flex: 1; }',
      '.wctx-diag { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.8; }',
      '.wctx-sub { font-size: 12px; font-weight: 600; }',
    ].join('\n');

    /** 样式只注入一次（按 data-plugin-css 去重）；返回的清理函数由 fiber 回收时执行。 */
    function injectStyles() {
      if (typeof document === 'undefined') return () => {};
      const tagId = 'dsh-workspace-context/page.css';
      let tag = document.querySelector('style[data-plugin-css="' + tagId + '"]');
      if (tag === null || tag === undefined) {
        tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-workspace-context';
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

    const errorText = (error) => String(error && error.message ? error.message : error);

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) throw new Error((body && body.error) || (response.status + ' ' + response.statusText));
      return body;
    }

    const post = (suffix, payload) => fetchJson(ROUTE + '/' + suffix, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    /** host 路由封装（自测里可整体替换）。 */
    const api = {
      state: (cwd) => fetchJson(ROUTE + '/state' + (typeof cwd === 'string' && cwd !== '' ? '?cwd=' + encodeURIComponent(cwd) : '')),
      save: (payload) => post('save', payload),
      enabled: (payload) => post('enabled', payload),
      bind: (payload) => post('bind', payload),
      trash: (payload) => post('trash', payload),
      reload: (payload) => post('reload', payload),
    };

    /* ------------------------------------------------------------ 纯函数 ---- */

    function formatBytes(n) {
      if (!Number.isFinite(n) || n <= 0) return '0 B';
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1048576).toFixed(2) + ' MB';
    }

    /** 绝对路径判定（Linux `/…` 或 Windows `C:\…`）。相对路径 host 会拒，先在界面上拦。 */
    function isAbsolutePath(value) {
      return typeof value === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(value.trim());
    }

    /** 最近活跃的工作区：host 的 seenCwds 是「旧→新」，取最后一个。 */
    function activeWorkspaceOf(state) {
      const seen = state && state.diag && Array.isArray(state.diag.seenCwds) ? state.diag.seenCwds : [];
      return seen.length > 0 ? seen[seen.length - 1] : '';
    }

    /** 诊断行文案。 */
    function diagText(state) {
      const diag = state && state.diag ? state.diag : {};
      const skipped = diag.skipped || {};
      const parts = [
        '装配 ' + (diag.assemblies || 0) + ' 次',
        '注入 ' + (diag.injected || 0) + ' 次',
        '无条目 ' + (skipped.noEntry || 0),
        '已停用 ' + (skipped.disabled || 0),
        '空正文 ' + (skipped.empty || 0),
        '无会话 cwd ' + (skipped.noSession || 0),
        diag.lastInjection
          ? '最近注入：' + diag.lastInjection.path + '（' + formatBytes(diag.lastInjection.injectedBytes) + '，'
            + (diag.lastInjection.via === 'ancestor' ? '继承自祖先' : '精确命中') + '）'
          : '最近注入：无',
      ];
      if (diag.lastSkip) parts.push('最近跳过：' + diag.lastSkip.reason);
      if (diag.routeErrors > 0) parts.push('路由错误 ' + diag.routeErrors);
      return parts.join(' · ');
    }

    /** 供 UI 组合的清单：已配置条目 + 未配置的已知工作区。 */
    function workspaceRows(state) {
      const workspaces = state && Array.isArray(state.workspaces) ? state.workspaces : [];
      const entries = state && Array.isArray(state.entries) ? state.entries : [];
      const byPath = new Map();
      for (const item of workspaces) byPath.set(item.path, item);
      for (const entry of entries) {
        const known = byPath.get(entry.path);
        byPath.set(entry.path, Object.assign({ source: 'entry' }, known, {
          path: entry.path,
          title: entry.title,
          hasEntry: true,
          enabled: entry.enabled,
          textBytes: entry.textBytes,
          file: entry.file,
          updatedAt: entry.updatedAt,
          updatedBy: entry.updatedBy,
          exists: entry.exists,
        }));
      }
      const rows = [...byPath.values()];
      rows.sort((a, b) => {
        if (a.hasEntry !== b.hasEntry) return a.hasEntry ? -1 : 1;
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });
      return rows;
    }

    /* -------------------------------------------------------------- 组件 ---- */

    function WorkspaceContextPage() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [selected, setSelected] = React.useState('');
      const [draft, setDraft] = React.useState(null);
      const [saveState, setSaveState] = React.useState('idle');
      const [customPath, setCustomPath] = React.useState('');
      const [reloadKey, setReloadKey] = React.useState(0);
      const timer = React.useRef(null);

      // 首次装载 / 点「重新读取」：拉状态，并默认选中最近活跃的工作区。
      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const next = await api.state();
            if (!alive) return;
            setState(next);
            const entries = Array.isArray(next.entries) ? next.entries : [];
            const preferred = entries.find((entry) => entry.path === activeWorkspaceOf(next)) || entries[0];
            if (preferred !== undefined) {
              setSelected(preferred.path);
              setDraft(preferred.text);
              setSaveState('idle');
            }
          } catch (loadError) {
            if (alive) setError(errorText(loadError));
          }
        })();
        return () => {
          alive = false;
        };
      }, [reloadKey]);

      // 卸载时清掉未落盘的防抖计时器。
      React.useEffect(() => () => {
        if (timer.current !== null && timer.current !== undefined) clearTimeout(timer.current);
      }, []);

      const cancelTimer = () => {
        if (timer.current !== null && timer.current !== undefined) clearTimeout(timer.current);
        timer.current = null;
      };

      const entriesOf = (view) => (view !== null && Array.isArray(view.entries) ? view.entries : []);
      const entryOf = (path) => entriesOf(state).find((entry) => entry.path === path);

      const reload = () => setReloadKey((value) => (value || 0) + 1);

      async function save(path, text) {
        if (typeof path !== 'string' || path === '') {
          setError('先选一个工作区，再保存');
          return;
        }
        setSaveState('saving');
        try {
          const next = await api.save({
            path,
            text: typeof text === 'string' ? text : '',
            cwd: state !== null && state.current !== undefined ? state.current.cwd : undefined,
          });
          setState(next);
          setSaveState('saved');
          setNotice('已保存 ' + path + '（下一次模型请求起生效）');
          setError('');
        } catch (saveError) {
          setSaveState('error');
          setError(errorText(saveError));
        }
      }

      function scheduleSave(path, text) {
        cancelTimer();
        timer.current = setTimeout(() => {
          timer.current = null;
          save(path, text);
        }, AUTOSAVE_MS);
      }

      function openWorkspace(path, text) {
        cancelTimer();
        setSelected(path);
        setDraft(typeof text === 'string' ? text : '');
        setSaveState('idle');
        setError('');
        setNotice('');
      }

      async function toggle(entry) {
        try {
          const next = await api.enabled({ path: entry.path, enabled: entry.enabled !== true });
          setState(next);
          setNotice((entry.enabled === true ? '已停用 ' : '已启用 ') + entry.path);
          setError('');
        } catch (toggleError) {
          setError(errorText(toggleError));
        }
      }

      async function trash(entry) {
        const question = '把 ' + entry.path + ' 的常驻上下文移入回收站？（文件移入 trash/，可人工捞回）';
        const ok = typeof confirm === 'function' ? confirm(question) : true;
        if (ok !== true) return;
        try {
          const next = await api.trash({ path: entry.path });
          setState(next);
          if (selected === entry.path) {
            setSelected('');
            setDraft(null);
          }
          setNotice('已移入回收站：' + entry.path);
          setError('');
        } catch (trashError) {
          setError(errorText(trashError));
        }
      }

      async function bind(item) {
        const target = customPath.trim() !== '' ? customPath.trim() : selected;
        if (target === '') {
          setError('先在上面填一个绝对路径，或选中一个工作区，再收编该文件');
          return;
        }
        if (!isAbsolutePath(target)) {
          setError('目标工作区必须是绝对路径');
          return;
        }
        try {
          const next = await api.bind({ file: item.name, path: target });
          setState(next);
          setSelected(target);
          const entry = entriesOf(next).find((candidate) => candidate.path === target);
          setDraft(entry !== undefined ? entry.text : null);
          setNotice('已收编 ' + item.name + ' → ' + target);
          setError('');
        } catch (bindError) {
          setError(errorText(bindError));
        }
      }

      function openCustom() {
        const path = customPath.trim();
        if (!isAbsolutePath(path)) {
          setError('请填绝对路径（例如 /root/nas/ArkTower 或 C:\\work\\proj）');
          return;
        }
        const entry = entryOf(path);
        openWorkspace(path, entry !== undefined ? entry.text : '');
      }

      function onTextKeyDown(event) {
        if ((event.ctrlKey === true || event.metaKey === true) && (event.key === 's' || event.key === 'S')) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          cancelTimer();
          save(selected, draft);
        }
      }

      function renderEntryRow(row) {
        const entry = row.hasEntry ? entryOf(row.path) : undefined;
        const buttons = [];
        if (entry !== undefined) {
          buttons.push(h('button', { key: 'edit', className: 'wctx-btn', onClick: () => openWorkspace(entry.path, entry.text) }, '编辑'));
          buttons.push(h('button', { key: 'toggle', className: 'wctx-btn', onClick: () => toggle(entry) }, entry.enabled ? '停用' : '启用'));
          buttons.push(h('button', { key: 'trash', className: 'wctx-btn danger', onClick: () => trash(entry) }, '回收站'));
        } else {
          buttons.push(h('button', {
            key: 'new',
            className: 'wctx-btn',
            onClick: () => {
              setCustomPath(row.path);
              openWorkspace(row.path, '');
            },
          }, '新建'));
        }
        return h('div', {
          key: row.path,
          className: 'wctx-entry' + (row.path === selected ? ' active' : '') + (row.hasEntry ? '' : ' wctx-dim'),
        },
        h('div', { className: 'wctx-row' },
          h('span', { className: 'wctx-path' }, row.path),
          h('span', { className: 'wctx-name' }, row.title || ''),
          h('span', { className: row.hasEntry && row.enabled ? 'wctx-badge on' : 'wctx-badge' },
            row.hasEntry ? (row.enabled ? '注入中' : '已停用') : '未配置'),
          row.exists === false ? h('span', { className: 'wctx-badge' }, '目录不存在') : null,
          h('span', { className: 'wctx-spacer' }),
          h('span', { className: 'wctx-meta' }, formatBytes(row.textBytes || 0)),
          buttons,
        ),
        entry !== undefined
          ? h('div', { className: 'wctx-name' },
            '更新：' + (entry.updatedAt || '未知') + '（' + (entry.updatedBy || '未知') + '）　' + entry.file)
          : null);
      }

      function renderEditor() {
        const entry = selected !== '' ? entryOf(selected) : undefined;
        if (selected === '') {
          return h('div', { className: 'wctx-card' },
            h('div', { className: 'wctx-meta' }, '左侧选一个工作区，或填一个绝对路径后点「新建 / 打开」。'));
        }
        const dirty = entry !== undefined && typeof draft === 'string' && draft !== entry.text;
        const stateText = saveState === 'saving' ? '保存中…'
          : saveState === 'saved' ? (dirty ? '有未保存改动' : '已保存')
            : saveState === 'error' ? '保存失败'
              : (dirty ? '有未保存改动（防抖 ' + (AUTOSAVE_MS / 1000) + 's 自动保存）' : '无改动');
        return h('div', { className: 'wctx-card' },
          h('div', { className: 'wctx-row' },
            h('span', { className: 'wctx-path' }, selected),
            h('span', { className: entry !== undefined && entry.enabled ? 'wctx-badge on' : 'wctx-badge' },
              entry === undefined ? '尚未保存' : (entry.enabled ? '注入中' : '已停用')),
            h('span', { className: 'wctx-spacer' }),
            h('span', { className: 'wctx-meta' }, stateText)),
          h('div', { className: 'wctx-code' },
            entry !== undefined
              ? '磁盘文件：' + entry.file + '　（直接编辑该文件也可，约 1 秒内热生效）'
              : '保存后在此工作区创建：contexts/<slug>.md'),
          h('textarea', {
            className: 'wctx-text',
            value: typeof draft === 'string' ? draft : '',
            placeholder: '写这个工作区的长期准则/背景：它常驻在本工作区每个会话的 system prompt 里，请尽量精简、稳定、可长期复用。',
            onChange: (event) => {
              const value = event !== null && event !== undefined && event.target !== undefined ? event.target.value : '';
              setDraft(value);
              if (selected !== '') scheduleSave(selected, value);
            },
            onKeyDown: onTextKeyDown,
          }),
          h('div', { className: 'wctx-row' },
            h('button', {
              className: 'wctx-btn primary',
              onClick: () => {
                cancelTimer();
                save(selected, draft);
              },
            }, '保存'),
            h('button', { className: 'wctx-btn', onClick: reload }, '重新读取'),
            h('button', {
              className: 'wctx-btn',
              onClick: () => {
                openWorkspace(selected, '');
                cancelTimer();
                save(selected, '');
              },
            }, '清空正文'),
            h('span', { className: 'wctx-spacer' }),
            h('span', { className: 'wctx-meta' }, '正文 ' + (typeof draft === 'string' ? draft.length : 0) + ' 字符')));
      }

      if (state === null) {
        return h('div', { className: 'wctx-root' },
          h('div', { className: 'wctx-meta' }, error !== '' ? error : '加载中…'));
      }

      const rows = workspaceRows(state);
      const unbound = Array.isArray(state.unbound) ? state.unbound : [];
      const errors = Array.isArray(state.errors) ? state.errors : [];

      return h('div', { className: 'wctx-root' },
        h('div', { className: 'wctx-card' },
          h('div', { className: 'wctx-sub' }, '工作区常驻上下文'),
          h('div', { className: 'wctx-meta' },
            '每个工作区一份长期提示词，常驻在该工作区会话的 system prompt 装配里（精确命中会话的工作目录，'
            + '或继承其最近祖先工作区的条目）。人可直接编辑磁盘文件，也可以在这里改；模型可用工具 workspace_context 读写。'),
          h('div', { className: 'wctx-code' }, '存储：' + state.dir + '　回收站：' + state.trashDir),
          h('div', { className: 'wctx-diag' }, diagText(state)),
          error !== '' ? h('div', { className: 'wctx-error' }, error) : null,
          notice !== '' ? h('div', { className: 'wctx-notice' }, notice) : null,
          errors.length > 0 ? h('div', { className: 'wctx-error' }, errors.join('\n')) : null),
        h('div', { className: 'wctx-card' },
          h('div', { className: 'wctx-row' },
            h('input', {
              className: 'wctx-input',
              value: customPath,
              placeholder: '绝对路径（已存在的目录），例如 /root/nas/ArkTower',
              onChange: (event) => setCustomPath(event !== null && event !== undefined && event.target !== undefined ? event.target.value : ''),
            }),
            h('button', { className: 'wctx-btn primary', onClick: openCustom }, '新建 / 打开'),
            h('button', { className: 'wctx-btn', onClick: reload }, '刷新')),
          rows.length === 0
            ? h('div', { className: 'wctx-meta' }, '还没有任何工作区条目。上面填一个绝对路径即可开始。')
            : h('div', { className: 'wctx-list' }, rows.map(renderEntryRow))),
        unbound.length > 0
          ? h('div', { className: 'wctx-card' },
            h('div', { className: 'wctx-sub' }, '未绑定文件（' + unbound.length + '）'),
            h('div', { className: 'wctx-meta' }, '这些 .md 的头部缺失或写坏，正文不会被注入；点「收编」把它绑定到上面填/选中的工作区。'),
            h('div', { className: 'wctx-list' }, unbound.map((item) => h('div', { key: item.name, className: 'wctx-row' },
              h('span', { className: 'wctx-path' }, item.name),
              h('span', { className: 'wctx-name' }, item.reason + (item.detail !== undefined ? '：' + item.detail : '')),
              h('span', { className: 'wctx-spacer' }),
              h('button', { className: 'wctx-btn', onClick: () => bind(item) }, '收编')))))
          : null,
        renderEditor());
    }

    const inject = ['slots'];

    function apply(ctx) {
      ctx.effect(() => injectStyles(), 'dsh-workspace-context: page css');
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'workspace-context', order: 20, label: '工作区常驻上下文' },
        () => h(WorkspaceContextPage, {}),
      ));
    }

    exports.inject = inject;
    exports.apply = apply;

    // 供 client-selftest.mjs 无头驱动：纯函数与组件直接可用。
    exports.__ui = {
      css: PAGE_CSS,
      api,
      AUTOSAVE_MS,
      formatBytes,
      isAbsolutePath,
      activeWorkspaceOf,
      diagText,
      workspaceRows,
      hookLayout: ['state', 'error', 'notice', 'selected', 'draft', 'saveState', 'customPath', 'reloadKey'],
      Page: WorkspaceContextPage,
    };
    return module.exports;
  },
});