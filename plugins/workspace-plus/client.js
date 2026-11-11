/**
 * WorkSpacePlus — 浏览器半边。
 *
 * 给「多工作目录」补上**工作区设置**：在侧边栏每个工作区行右侧的「⋯」菜单里
 * 增加一项「工作区设置」，用于设置
 *   ① 工作区名称 —— 自由标签，**不锁定主路径文件夹名称**（Host 侧只写
 *      Workspace 的 title，从不改目录名）；
 *   ② 支持的目录 —— 与该工作区同属一个项目的附加目录，会一并告知模型。
 *
 * 两条入口，同一个编辑器：
 *   · 侧边栏工作区行的「⋯」菜单 → 弹层（shell.overlay）；
 *   · 设置 → 工作区 → 行内展开（settings.section）。
 * 第二条是常驻入口：即使侧边栏的菜单注入因为上游改版失效，设置页仍然可用。
 *
 * 为什么菜单项要注入 DOM：出厂 ui-workspace 的工作区行菜单是 `Menu items=[…]`
 * 的固定两项（重命名 / 删除），没有留给插件的槽位（只有**会话**行菜单有
 * `sidebar.workspaces.session.menu.item`），插件也没有办法替换出厂的侧边栏
 * 组件。因此这里只做**纯增量**注入：监听行内按钮的 pointerdown 记住工作区 id，
 * 菜单出现时克隆一个已有菜单项、换掉图标与文字、挂上自己的点击处理。
 * 注入失败时出厂菜单保持原样（优雅降级），设置页入口不受影响。
 *
 * 数据与动作全部来自本插件 Host 半边的同源路由（静态插件没有动态包的
 * host.call，同源相对路径在 loopback 与反代下都可用）：
 *   GET  /workspace-plus/list       项目 + 原生工作区清单
 *   GET  /workspace-plus/workspace  单个工作区/项目的编辑数据
 *   POST /workspace-plus/save       保存名称 + 支持的目录
 *   POST /workspace-plus/pick       原生目录选择器（用户主动点击才会打开）
 *
 * @module @local/workspace-plus/client
 */

window.__ModuleLoader__.load({
  id: '@local/workspace-plus',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    // `react-dom` is part of the client platform module map (`staticModules` in the
    // web boot facade), so a plugin bundle may require it. Guarded anyway: a
    // missing entry would otherwise take the whole bundle (and the page) down.
    let ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch {}

    // ---- strings ----------------------------------------------------------
    const STRINGS = {
      zh: {
        'menuItem': '工作区设置',
        'dialog.title': '工作区设置',
        'dialog.sub': '名称只是显示标签，不会重命名主路径文件夹。',
        'field.name': '工作区名称',
        'field.namePlaceholder': '例如：数学课程',
        'field.primary': '主路径',
        'field.paths': '支持的目录',
        'field.pathsHint': '这些目录与主路径同属一个工作区，会一并告知模型。',
        'field.pathsEmpty': '还没有支持的目录。',
        'add.placeholder': '输入目录绝对路径，或点「浏览…」',
        'btn.browse': '浏览…',
        'btn.add': '添加',
        'btn.remove': '移除',
        'btn.cancel': '取消',
        'btn.save': '保存',
        'btn.saving': '保存中…',
        'btn.done': '完成',
        'btn.edit': '编辑',
        'btn.retry': '重试',
        'btn.close': '关闭',
        'saved': '已保存',
        'loading': '正在读取…',
        'error.load': '读取工作区失败',
        'error.save': '保存失败',
        'error.nameRequired': '工作区名称不能为空。',
        'page.title': '工作区',
        'page.sub': '每个工作区有名称、一条主路径和若干支持的目录。侧边栏工作区行右侧「⋯」菜单里的「工作区设置」打开的是同一个编辑器。',
        'page.empty': '还没有工作区。',
        'page.orphans': '未关联侧边栏工作区的项目',
        'page.orphansHint': '这些项目的主路径没有出现在侧边栏，可能来自模型创建的 project_create。',
        'page.needWorkspace': '这个 Host 没有可读的工作区列表，只能在侧边栏菜单里编辑单个工作区。',
        'meta.paths': '{n} 个支持的目录',
        'meta.noProject': '尚未建立项目分组',
        'meta.project': '项目：{name}',
      },
      en: {
        'menuItem': 'Workspace settings',
        'dialog.title': 'Workspace settings',
        'dialog.sub': 'The name is only a label; the primary folder is never renamed.',
        'field.name': 'Workspace name',
        'field.namePlaceholder': 'e.g. Math course',
        'field.primary': 'Primary path',
        'field.paths': 'Supported directories',
        'field.pathsHint': 'These directories belong to the same workspace and are shared with the model.',
        'field.pathsEmpty': 'No supported directories yet.',
        'add.placeholder': 'Absolute directory path, or use Browse…',
        'btn.browse': 'Browse…',
        'btn.add': 'Add',
        'btn.remove': 'Remove',
        'btn.cancel': 'Cancel',
        'btn.save': 'Save',
        'btn.saving': 'Saving…',
        'btn.done': 'Done',
        'btn.edit': 'Edit',
        'btn.retry': 'Retry',
        'btn.close': 'Close',
        'saved': 'Saved',
        'loading': 'Loading…',
        'error.load': 'Could not load the workspace',
        'error.save': 'Save failed',
        'error.nameRequired': 'The workspace name cannot be empty.',
        'page.title': 'Workspaces',
        'page.sub': 'Each workspace has a name, one primary path and any number of supported directories. The “Workspace settings” item in the sidebar row menu opens the same editor.',
        'page.empty': 'No workspaces yet.',
        'page.orphans': 'Projects not attached to a sidebar workspace',
        'page.orphansHint': 'Their primary path is not in the sidebar; they were probably created by project_create.',
        'page.needWorkspace': 'This Host exposes no workspace list; edit workspaces from the sidebar menu instead.',
        'meta.paths': '{n} supported directories',
        'meta.noProject': 'No project grouping yet',
        'meta.project': 'Project: {name}',
      },
    };
    // The app writes its UI language to `document.documentElement.lang`; the browser
    // locale is only a fallback (it is the OS language and can differ from the UI).
    const LANG = (() => {
      let tag = '';
      try {
        if (typeof document !== 'undefined' && document.documentElement) tag = document.documentElement.lang || '';
      } catch {}
      if (!tag) {
        try {
          tag = (typeof navigator !== 'undefined' && navigator.language) || '';
        } catch {}
      }
      return String(tag).toLowerCase().startsWith('en') ? 'en' : 'zh';
    })();
    const t = (key, vars) => {
      const table = STRINGS[LANG] || STRINGS.zh;
      const raw = table[key] !== undefined ? table[key] : STRINGS.zh[key] !== undefined ? STRINGS.zh[key] : key;
      return vars === undefined ? raw : String(raw).replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined ? m : String(vars[name])));
    };

    // ---- styles -----------------------------------------------------------
    const CSS = [
      '.wsplus-backdrop { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, .32); pointer-events: auto; }',
      // Literal fallbacks: the alias tokens are defined by the runtime theme layer on
      // html/:root, which this bundle cannot see. If a future build renames or drops
      // one, the dialog must still be an opaque, bordered surface with readable text
      // instead of a transparent rectangle.
      '.wsplus-dialog { width: min(560px, 100%); max-height: min(82vh, 720px); display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .16)); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #ffffff); box-shadow: 0 18px 48px rgba(0, 0, 0, .28); overflow: hidden; }',
      '.wsplus-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 18px 10px; }',
      '.wsplus-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #0f1115); }',
      '.wsplus-sub { margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #5a5f6a); }',
      '.wsplus-x { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 18px; line-height: 1; padding: 2px 6px; cursor: pointer; border-radius: 6px; }',
      '.wsplus-x:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }',
      '.wsplus-body { display: flex; flex-direction: column; gap: 14px; padding: 4px 18px 16px; overflow: auto; }',
      '.wsplus-field { display: flex; flex-direction: column; gap: 6px; }',
      '.wsplus-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary); }',
      '.wsplus-hint { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }',
      '.wsplus-input { width: 100%; box-sizing: border-box; appearance: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; padding: 7px 10px; outline: none; }',
      '.wsplus-input:focus { border-color: var(--dsw-alias-brand-primary); }',
      '.wsplus-input::placeholder { color: var(--dsw-alias-label-secondary); }',
      '.wsplus-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); word-break: break-all; }',
      '.wsplus-paths { display: flex; flex-direction: column; gap: 6px; }',
      '.wsplus-pathrow { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
      '.wsplus-pathrow .wsplus-code { flex: 1 1 auto; min-width: 0; color: var(--dsw-alias-label-primary); }',
      '.wsplus-addrow { display: flex; align-items: center; gap: 8px; }',
      '.wsplus-addrow .wsplus-input { flex: 1 1 auto; min-width: 0; }',
      '.wsplus-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; padding: 5px 12px; cursor: pointer; white-space: nowrap; }',
      '.wsplus-btn:hover { border-color: var(--dsw-alias-border-l3); }',
      '.wsplus-btn:disabled { opacity: .55; cursor: default; }',
      '.wsplus-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }',
      '.wsplus-btn-quiet { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); padding: 4px 8px; }',
      '.wsplus-btn-quiet:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }',
      '.wsplus-error { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-left: 3px solid var(--dsw-alias-label-primary); border-radius: 8px; padding: 7px 10px; background: var(--dsw-alias-bg-layer-2); }',
      '.wsplus-notice { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.wsplus-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }',
      '.wsplus-page { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px 24px; }',
      '.wsplus-page-head { display: flex; flex-direction: column; gap: 4px; }',
      '.wsplus-page-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.wsplus-page-sub { font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }',
      '.wsplus-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }',
      '.wsplus-rowmain { min-width: 0; display: flex; flex-direction: column; gap: 3px; }',
      '.wsplus-rowtitle { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.wsplus-rowsub { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.wsplus-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }',
      '.wsplus-inline { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 12px; background: var(--dsw-alias-bg-layer-2); }',
      '.wsplus-section { margin-top: 4px; padding-top: 10px; border-top: .5px solid var(--dsw-alias-border-l2); }',
    ].join('\n');

    let stylesInstalled = false;
    function injectStyles() {
      if (stylesInstalled || typeof document === 'undefined') return;
      // A reloaded module instance must not stack a second copy of the sheet.
      if (document.querySelector('style[data-wsplus-style]')) {
        stylesInstalled = true;
        return;
      }
      stylesInstalled = true;
      const tag = document.createElement('style');
      tag.setAttribute('data-wsplus-style', '1');
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---- transport --------------------------------------------------------
    async function api(path, options) {
      const init = Object.assign({ credentials: 'same-origin', method: 'GET' }, options || {});
      if (init.body !== undefined && init.headers === undefined) {
        init.headers = { 'content-type': 'application/json' };
      }
      const response = await fetch(path, init);
      const text = await response.text();
      let payload = null;
      try {
        payload = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        payload = { error: text };
      }
      if (!response.ok) {
        const message = (payload && (payload.message || payload.error)) || `HTTP ${response.status}`;
        throw new Error(String(message));
      }
      return payload;
    }

    const targetQuery = (target) => {
      if (!target) return '';
      if (target.workspaceId) return `workspaceId=${encodeURIComponent(target.workspaceId)}`;
      if (target.projectId) return `projectId=${encodeURIComponent(target.projectId)}`;
      return '';
    };
    const loadTarget = (target) => api(`/workspace-plus/workspace?${targetQuery(target)}`);
    const loadList = () => api('/workspace-plus/list');

    // ---- tiny store (dialog + page share one opener) ----------------------
    const listeners = new Set();
    let state = { open: false, target: null, data: null, loading: false, error: null, seq: 0 };
    const emit = () => {
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch (error) {
          console.error('[workspace-plus] listener failed', error);
        }
      }
    };
    const setState = (patch) => {
      state = Object.assign({}, state, patch);
      emit();
    };
    const store = {
      get: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      // Bumping the sequence makes any in-flight load a no-op after close.
      close: () => setState({ open: false, target: null, data: null, error: null, loading: false, seq: state.seq + 1 }),
      setData: (data) => setState({ data }),
      openFor: async (target) => {
        const seq = state.seq + 1;
        setState({ open: true, target, data: null, loading: true, error: null, seq });
        try {
          const data = await loadTarget(target);
          if (state.seq !== seq) return;
          setState({ data, loading: false });
        } catch (error) {
          if (state.seq !== seq) return;
          setState({ loading: false, error: String(error && error.message ? error.message : error) });
        }
      },
    };
    const useStore = () => {
      const [, force] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => store.subscribe(force), []);
      return state;
    };

    // ---- helpers ----------------------------------------------------------
    const samePath = (left, right) => String(left).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() === String(right).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const trimTrailing = (value) => String(value).replace(/[\\/]+$/, '');

    /**
     * The editor shared by the overlay dialog and the settings page.
     * `data` is one `GET /workspace-plus/workspace` payload.
     */
    function WorkspaceEditor(props) {
      const data = props.data;
      const [name, setName] = React.useState('');
      const [paths, setPaths] = React.useState([]);
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const nameRef = React.useRef(null);
      // Payload this editor produced itself: re-initializing from it would wipe
      // the "saved" notice the user just earned.
      const ownSaveRef = React.useRef(null);

      React.useEffect(() => {
        if (!data) return;
        if (ownSaveRef.current === data) return;
        const initial = data.workspace ? data.workspace.title : data.project ? data.project.name : '';
        setName(initial || '');
        setPaths(data.project && Array.isArray(data.project.secondaryPaths) ? data.project.secondaryPaths.slice() : []);
        setDraft('');
        setError(null);
        setNotice(null);
        if (props.autoFocus && nameRef.current) {
          try {
            nameRef.current.focus();
            nameRef.current.select();
          } catch {}
        }
      }, [data]);

      if (!data) return null;

      const primaryPath = data.workspace ? data.workspace.path : data.project ? data.project.primaryPath : '';
      const pickerAvailable = data.picker !== false;

      const addPath = (value) => {
        const raw = trimTrailing(String(value === undefined ? draft : value).trim());
        if (raw.length === 0) return;
        setPaths((previous) => (previous.some((entry) => samePath(entry, raw)) ? previous : previous.concat([raw])));
        setDraft('');
        setNotice(null);
      };
      const removePath = (value) => {
        setPaths((previous) => previous.filter((entry) => !samePath(entry, value)));
        setNotice(null);
      };
      const browse = async () => {
        setError(null);
        try {
          const result = await api('/workspace-plus/pick', { method: 'POST', body: '{}' });
          if (result && typeof result.path === 'string' && result.path.length > 0) addPath(result.path);
          else if (result && result.error) setError(String(result.error));
        } catch (caught) {
          setError(String(caught && caught.message ? caught.message : caught));
        }
      };
      const save = async () => {
        if (busy) return;
        const cleanName = name.trim();
        if (cleanName.length === 0) {
          setError(t('error.nameRequired'));
          return;
        }
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          const body = { name: cleanName, title: cleanName, secondaryPaths: paths };
          if (data.workspace) body.workspaceId = data.workspace.workspaceId;
          else if (data.project) body.projectId = data.project.id;
          const result = await api('/workspace-plus/save', { method: 'POST', body: JSON.stringify(body) });
          const next = {
            workspace: result.workspace || data.workspace || null,
            project: result.project || data.project || null,
            picker: pickerAvailable,
          };
          setNotice(t('saved'));
          ownSaveRef.current = next;
          if (props.onSaved) props.onSaved(next);
        } catch (caught) {
          setError(String(caught && caught.message ? caught.message : caught));
        } finally {
          setBusy(false);
        }
      };

      const nameField = h(
        'div',
        { className: 'wsplus-field' },
        h('div', { className: 'wsplus-label' }, t('field.name')),
        h('input', {
          ref: nameRef,
          className: 'wsplus-input',
          type: 'text',
          value: name,
          placeholder: t('field.namePlaceholder'),
          onChange: (event) => {
            setName(event.target.value);
            setNotice(null);
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') save();
          },
        }),
        h('div', { className: 'wsplus-hint' }, t('dialog.sub')),
      );

      const pathRows = paths.length === 0
        ? h('div', { className: 'wsplus-hint' }, t('field.pathsEmpty'))
        : h(
            'div',
            { className: 'wsplus-paths' },
            paths.map((entry) =>
              h(
                'div',
                { className: 'wsplus-pathrow', key: entry },
                h('span', { className: 'wsplus-code', title: entry }, entry),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'wsplus-btn wsplus-btn-quiet',
                    'aria-label': `${t('btn.remove')} ${entry}`,
                    onClick: () => removePath(entry),
                  },
                  t('btn.remove'),
                ),
              ),
            ),
          );

      const addRow = h(
        'div',
        { className: 'wsplus-addrow' },
        h('input', {
          className: 'wsplus-input',
          type: 'text',
          value: draft,
          placeholder: t('add.placeholder'),
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addPath();
            }
          },
        }),
        pickerAvailable
          ? h('button', { type: 'button', className: 'wsplus-btn', onClick: browse }, t('btn.browse'))
          : null,
        h('button', { type: 'button', className: 'wsplus-btn', disabled: draft.trim().length === 0, onClick: () => addPath() }, t('btn.add')),
      );

      return h(
        'div',
        { className: 'wsplus-body' },
        h(
          'div',
          { className: 'wsplus-field' },
          h('div', { className: 'wsplus-label' }, t('field.primary')),
          h('div', { className: 'wsplus-code' }, primaryPath),
        ),
        nameField,
        h(
          'div',
          { className: 'wsplus-field' },
          h('div', { className: 'wsplus-label' }, t('field.paths')),
          pathRows,
          addRow,
          h('div', { className: 'wsplus-hint' }, t('field.pathsHint')),
        ),
        error ? h('div', { className: 'wsplus-error' }, error) : null,
        notice ? h('div', { className: 'wsplus-notice' }, notice) : null,
        h(
          'div',
          { className: 'wsplus-actions', style: { justifyContent: 'flex-end' } },
          props.onCancel
            ? h('button', { type: 'button', className: 'wsplus-btn', onClick: props.onCancel }, t('btn.cancel'))
            : null,
          h('button', { type: 'button', className: 'wsplus-btn wsplus-btn-primary', disabled: busy, onClick: save }, busy ? t('btn.saving') : t('btn.save')),
        ),
      );
    }

    // ---- overlay dialog ---------------------------------------------------
    function WorkspaceSettingsDialog() {
      const current = useStore();
      React.useEffect(() => {
        if (!current.open) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            store.close();
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [current.open]);

      if (!current.open) return null;

      const body = current.loading
        ? h('div', { className: 'wsplus-body' }, h('div', { className: 'wsplus-hint' }, t('loading')))
        : current.error
          ? h('div', { className: 'wsplus-body' }, h('div', { className: 'wsplus-error' }, `${t('error.load')}：${current.error}`))
          : h(WorkspaceEditor, {
              data: current.data,
              autoFocus: true,
              onSaved: (next) => {
                store.setData(next);
              },
              onCancel: () => store.close(),
            });

      const node = h(
        'div',
        {
          className: 'wsplus-backdrop',
          'data-wsplus-backdrop': '1',
          onPointerDown: (event) => {
            if (event.target === event.currentTarget) store.close();
          },
        },
        h(
          'div',
          { className: 'wsplus-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('dialog.title') },
          h(
            'div',
            { className: 'wsplus-head' },
            h(
              'div',
              null,
              h('div', { className: 'wsplus-title' }, t('dialog.title')),
              current.data && current.data.workspace
                ? h('div', { className: 'wsplus-sub' }, current.data.workspace.title || current.data.workspace.path)
                : null,
            ),
            h('button', { type: 'button', className: 'wsplus-x', 'aria-label': t('btn.close'), onClick: () => store.close() }, '\u00d7'),
          ),
          body,
        ),
      );

      // `shell.overlay` renders inside the frame's overlay layer, which is
      // `position:absolute; z-index:20` — a stacking context. Any z-index on our
      // backdrop is clamped to that local context, so in the narrow/drawer layout
      // the sidebar column (z-index:71) and its mask (70) paint over the dialog.
      // Portaling to <body> puts it in the root stacking context instead; the theme
      // tokens are defined on html/:root (`body` itself consumes
      // `var(--dsw-alias-*)`), so they still resolve, and this is the app's own
      // react-dom instance, which React requires for a portal.
      if (typeof document !== 'undefined' && document.body && ReactDOM && typeof ReactDOM.createPortal === 'function') {
        return ReactDOM.createPortal(node, document.body);
      }
      return node;
    }

    // ---- settings page ----------------------------------------------------
    function WorkspaceSettingsPage() {
      const [list, setList] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [editing, setEditing] = React.useState(null);
      const [editorData, setEditorData] = React.useState(null);
      const [editorError, setEditorError] = React.useState(null);

      const refresh = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
          const payload = await loadList();
          // A 200 with a non-JSON body must not reach the render path.
          if (!payload || !Array.isArray(payload.projects) || !(payload.workspaces === null || Array.isArray(payload.workspaces))) {
            throw new Error(payload && payload.error ? String(payload.error) : t('error.load'));
          }
          setList(payload);
        } catch (caught) {
          setError(String(caught && caught.message ? caught.message : caught));
        } finally {
          setLoading(false);
        }
      }, []);

      // Same read without the loading flag: used after a save so the inline
      // editor keeps its "saved" notice instead of being unmounted.
      const quietRefresh = React.useCallback(async () => {
        try {
          const payload = await loadList();
          if (payload && Array.isArray(payload.projects)) setList(payload);
        } catch {}
      }, []);

      React.useEffect(() => {
        refresh();
      }, [refresh]);

      // Monotonic token: a slow load for row A must never overwrite row B.
      const editToken = React.useRef(0);
      const openEditor = async (target) => {
        const token = editToken.current + 1;
        editToken.current = token;
        setEditing(target);
        setEditorData(null);
        setEditorError(null);
        try {
          const payload = await loadTarget(target);
          if (editToken.current !== token) return;
          setEditorData(payload);
        } catch (caught) {
          if (editToken.current !== token) return;
          setEditorError(String(caught && caught.message ? caught.message : caught));
        }
      };

      const closeEditor = () => {
        editToken.current += 1;
        setEditing(null);
        setEditorData(null);
        setEditorError(null);
      };

      const applySaved = (next) => {
        setEditorData(next);
        quietRefresh();
      };

      const header = h(
        'div',
        { className: 'wsplus-page-head' },
        h('div', { className: 'wsplus-page-title' }, t('page.title')),
        h('div', { className: 'wsplus-page-sub' }, t('page.sub')),
      );

      if (loading) {
        return h('div', { className: 'wsplus-page' }, header, h('div', { className: 'wsplus-hint' }, t('loading')));
      }
      if (error) {
        return h(
          'div',
          { className: 'wsplus-page' },
          header,
          h('div', { className: 'wsplus-error' }, `${t('error.load')}：${error}`),
          h('div', { className: 'wsplus-actions' }, h('button', { type: 'button', className: 'wsplus-btn', onClick: refresh }, t('btn.retry'))),
        );
      }

      const projects = list && Array.isArray(list.projects) ? list.projects : [];
      const workspaces = list && Array.isArray(list.workspaces) ? list.workspaces : null;
      const projectById = new Map(projects.map((project) => [project.id, project]));
      const rows = [];

      if (workspaces === null) {
        rows.push(h('div', { className: 'wsplus-hint', key: 'no-workspaces' }, t('page.needWorkspace')));
      } else if (workspaces.length === 0) {
        rows.push(h('div', { className: 'wsplus-hint', key: 'empty' }, t('page.empty')));
      } else {
        for (const workspace of workspaces) {
          const project = workspace.projectId ? projectById.get(workspace.projectId) : null;
          const isEditing = editing && editing.workspaceId === workspace.workspaceId;
          const meta = project
            ? [t('meta.project', { name: project.name }), t('meta.paths', { n: project.secondaryPaths.length })].join(' · ')
            : t('meta.noProject');
          rows.push(
            h(
              'div',
              { className: 'wsplus-row', key: workspace.workspaceId, style: { flexDirection: 'column', alignItems: 'stretch' } },
              h(
                'div',
                { className: 'wsplus-rowmain', style: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
                h(
                  'div',
                  { className: 'wsplus-rowmain' },
                  h('div', { className: 'wsplus-rowtitle' }, workspace.title || workspace.path),
                  h('div', { className: 'wsplus-rowsub' }, workspace.path),
                  h('div', { className: 'wsplus-rowsub' }, meta),
                ),
                h(
                  'div',
                  { className: 'wsplus-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'wsplus-btn',
                      onClick: () => (isEditing ? closeEditor() : openEditor({ workspaceId: workspace.workspaceId })),
                    },
                    isEditing ? t('btn.close') : t('btn.edit'),
                  ),
                ),
              ),
              isEditing
                ? h(
                    'div',
                    { className: 'wsplus-inline', style: { marginTop: 10 } },
                    editorError
                      ? h('div', { className: 'wsplus-error' }, editorError)
                      : editorData
                        ? h(WorkspaceEditor, { data: editorData, autoFocus: true, onSaved: applySaved, onCancel: closeEditor })
                        : h('div', { className: 'wsplus-hint' }, t('loading')),
                  )
                : null,
            ),
          );
        }
      }

      const workspaceProjectIds = new Set((workspaces || []).map((workspace) => workspace.projectId).filter(Boolean));
      const orphans = projects.filter((project) => !workspaceProjectIds.has(project.id));
      if (orphans.length > 0) {
        rows.push(
          h(
            'div',
            { className: 'wsplus-section', key: 'orphans' },
            h('div', { className: 'wsplus-label' }, t('page.orphans')),
            h('div', { className: 'wsplus-hint', style: { marginBottom: 8 } }, t('page.orphansHint')),
            orphans.map((project) => {
              const isEditing = editing && editing.projectId === project.id;
              return h(
                'div',
                { className: 'wsplus-row', key: project.id, style: { flexDirection: 'column', alignItems: 'stretch', marginBottom: 8 } },
                h(
                  'div',
                  { className: 'wsplus-rowmain', style: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
                  h(
                    'div',
                    { className: 'wsplus-rowmain' },
                    h('div', { className: 'wsplus-rowtitle' }, project.name),
                    h('div', { className: 'wsplus-rowsub' }, project.primaryPath),
                    h('div', { className: 'wsplus-rowsub' }, t('meta.paths', { n: project.secondaryPaths.length })),
                  ),
                  h(
                    'div',
                    { className: 'wsplus-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wsplus-btn',
                        onClick: () => (isEditing ? closeEditor() : openEditor({ projectId: project.id })),
                      },
                      isEditing ? t('btn.close') : t('btn.edit'),
                    ),
                  ),
                ),
                isEditing
                  ? h(
                      'div',
                      { className: 'wsplus-inline', style: { marginTop: 10 } },
                      editorError
                        ? h('div', { className: 'wsplus-error' }, editorError)
                        : editorData
                          ? h(WorkspaceEditor, { data: editorData, autoFocus: true, onSaved: applySaved, onCancel: closeEditor })
                          : h('div', { className: 'wsplus-hint' }, t('loading')),
                    )
                  : null,
              );
            }),
          ),
        );
      }

      return h('div', { className: 'wsplus-page' }, header, rows);
    }

    // ---- sidebar row menu injection (additive, degrades gracefully) -------
    // `IconSettingsOutlineRegular` from the shipped icon set (16×16, stroke 1),
    // so the injected item is visually native instead of a foreign glyph.
    const GEAR_PATHS = [
      "M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z",
      "M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z",
    ];

    const ROW_PREFIX = 'workspace:';
    const MENU_MARK = 'data-wsplus-item';
    const HOOK_KEY = '__dshWorkspacePlusRowMenuHook';
    let pendingRow = null;
    let observer = null;
    // The observer sees every node added while a menu opens (backing, material,
    // viewport, items…), so a diagnostic for one menu surface would otherwise be
    // repeated a dozen times.
    const warnedMenus = new WeakSet();

    function warnMenuOnce(root, message, extra) {
      try {
        if (warnedMenus.has(root)) return;
        warnedMenus.add(root);
      } catch {}
      console.warn(message, extra === undefined ? undefined : extra);
    }

    /** Deepest element that still carries visible text — the label of a menu item. */
    function findLabelElement(root) {
      if (typeof document === 'undefined' || !document.createTreeWalker) return null;
      const walker = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
      let node = walker.nextNode();
      while (node) {
        if (node.nodeValue && node.nodeValue.trim().length > 0) return node.parentElement;
        node = walker.nextNode();
      }
      return null;
    }

    /**
     * Close the shipped menu. It listens for Escape on `document` in the capture
     * phase (guarded only against IME composition), so one synthetic keydown is
     * enough — and unlike a synthetic outside pointerdown it cannot dismiss any
     * unrelated host popover.
     */
    function closeNativeMenu() {
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      } catch {}
      // Fallback for the IME case: the shipped Escape handler is gated on
      // `isComposing || keyCode === 229`, and that flag can stay set after a
      // composition ends, which would swallow the synthetic keydown above and
      // leave the menu open behind our dialog. An outside `pointerdown` closes the
      // menu through a different listener (it only requires the target to be
      // outside both the anchor and the surface), so one dispatched on `body`
      // works when the keydown did not.
      try {
        if (document.querySelector('[role="menu"]')) {
          document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
        }
      } catch {}
    }

    /**
     * Swap the cloned item's glyph for the shipped settings icon. The template svg
     * is already 16×16 / fill:none / stroke-width:1 with the native class, so only
     * the paths are replaced — the item then matches the host's own icons exactly.
     */
    function swapIcon(button) {
      const svg = button.querySelector('svg');
      if (!svg) return;
      try {
        const NS = 'http://www.w3.org/2000/svg';
        for (const child of Array.from(svg.childNodes)) svg.removeChild(child);
        for (const d of GEAR_PATHS) {
          const path = document.createElementNS(NS, 'path');
          path.setAttribute('d', d);
          path.setAttribute('stroke', 'currentColor');
          svg.appendChild(path);
        }
        if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', '0 0 16 16');
        if (!svg.getAttribute('fill')) svg.setAttribute('fill', 'none');
        if (!svg.getAttribute('stroke-width')) svg.setAttribute('stroke-width', '1');
      } catch {}
    }

    /**
     * Add one item to a freshly opened workspace menu.
     *
     * The shipped menu renders `div.itemWrap > button[role="menuitem"]` inside a
     * `div[role="presentation"]` viewport, so the clone has to be a whole wrapper
     * inserted into that viewport: inserting a bare button before the next item's
     * button would throw NotFoundError (they are not siblings).
     *
     * @returns {boolean} whether an item was injected.
     */
    function injectIntoMenu(root, workspaceId) {
      if (!root || root.nodeType !== 1) return false;
      if (root.querySelector(`[${MENU_MARK}="1"]`)) return false;
      const buttons = Array.from(root.querySelectorAll('button[role="menuitem"]'));
      // The workspace row menu is "rename / delete". A menu with fewer items is a
      // different surface and is left alone; a menu with MORE items still works —
      // clone the first item, insert before the last — so a future extra host item
      // cannot silently disable the injection.
      if (buttons.length < 2) {
        warnMenuOnce(root, '[workspace-plus] menu has too few items, nothing injected', { items: buttons.length });
        return false;
      }
      const wrap = buttons[0].parentElement;
      const deleteWrap = buttons[buttons.length - 1].parentElement;
      const viewport = wrap && wrap.parentElement;
      if (!wrap || !deleteWrap || !viewport || deleteWrap.parentElement !== viewport) {
        warnMenuOnce(root, '[workspace-plus] unexpected menu layout, nothing injected');
        return false;
      }

      const clone = wrap.cloneNode(true);
      clone.setAttribute(MENU_MARK, '1');
      const button = clone.querySelector('button[role="menuitem"]');
      if (!button) return false;
      button.removeAttribute('aria-haspopup');
      button.removeAttribute('aria-expanded');
      button.removeAttribute('aria-keyshortcuts');
      button.removeAttribute('aria-current');
      if ('disabled' in button) button.disabled = false;
      const label = findLabelElement(button);
      if (label) label.textContent = t('menuItem');
      swapIcon(button);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeNativeMenu();
        store.openFor({ workspaceId });
      });
      viewport.insertBefore(clone, deleteWrap);
      console.info('[workspace-plus] menu item injected', { workspaceId, items: buttons.length });
      return true;
    }

    function stopObserving() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      pendingRow = null;
    }

    /**
     * One observer for the page lifetime. It stays cheap while disarmed (a single
     * null check per mutation batch) and, once armed, also re-injects when React
     * re-renders the open menu and wipes the cloned item.
     */
    function startObserving() {
      if (observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
      observer = new MutationObserver((records) => {
        if (!pendingRow) return;
        try {
          for (const record of records) {
            for (const added of Array.from(record.addedNodes)) {
              if (!added || added.nodeType !== 1) continue;
              const menu = typeof added.closest === 'function' ? added.closest('[role="menu"]') : null;
              if (!menu) continue;
              // `injectIntoMenu` dedupes per surface, so re-scanning is cheap and
              // also re-injects if React re-rendered the menu and dropped the clone.
              if (injectIntoMenu(menu, pendingRow.workspaceId)) {
                pendingRow.injected = true;
                return;
              }
            }
          }
        } catch (error) {
          console.warn('[workspace-plus] menu injection failed', error);
          // A throwing callback is otherwise re-entered on every mutation batch for
          // the rest of the page's life.
          stopObserving();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * Arm the injection for the row a press/keyboard activation belongs to.
     * Bound to both `pointerdown` and `click` in the capture phase: the mouse path
     * is covered by pointerdown, and a keyboard-activated button (Enter/Space)
     * only ever fires a click.
     */
    function onArmCapture(event) {
      // A reloaded module instance owns the hook: this listener detaches itself so
      // two live instances can never race to inject into the same menu.
      if (hookOwner && typeof window !== 'undefined' && window[HOOK_KEY] !== hookOwner) {
        document.removeEventListener('pointerdown', onArmCapture, true);
        document.removeEventListener('click', onArmCapture, true);
        return;
      }
      // Any new press disarms the previous row, so a menu opened by another route
      // can never inherit a stale workspace id.
      pendingRow = null;
      const target = event.target;
      if (!target || target.nodeType !== 1 || typeof target.closest !== 'function') return;
      if (target.closest('[data-wsplus-backdrop="1"]')) return;
      // `data-row-key` is `workspace:<id>` on a workspace row and `session:<id>` on
      // a session row (they are siblings inside one group section), so the nearest
      // row is exactly the row that was pressed.
      const row = target.closest('[data-row-key]');
      if (!row) return;
      const key = row.getAttribute('data-row-key') || '';
      if (key.slice(0, ROW_PREFIX.length) !== ROW_PREFIX) return;
      if (!target.closest('button')) return;
      const workspaceId = key.slice(ROW_PREFIX.length);
      if (workspaceId.length === 0) return;
      pendingRow = { workspaceId, injected: false };
      startObserving();
    }

    let hookOwner = null;
    /**
     * Install the document listeners. A reloaded module instance takes the hook
     * over from its predecessor (which detaches itself on its next event) and
     * drops any item the dead instance injected, so an item can never stay wired
     * to a disposed store.
     *
     * @returns {(() => void) | null} teardown, or null when this instance already owns it.
     */
    function installRowMenuHook() {
      if (typeof document === 'undefined' || typeof window === 'undefined') return null;
      if (hookOwner && window[HOOK_KEY] === hookOwner) return null;
      for (const stale of Array.from(document.querySelectorAll(`[${MENU_MARK}="1"]`))) {
        try {
          stale.remove();
        } catch {}
      }
      hookOwner = {};
      window[HOOK_KEY] = hookOwner;
      // One-line self report. Typing `__workspacePlusDiag()` in the DevTools console
      // shows which gate failed without guessing: no rows means the hook is not
      // installed, `armed: null` after clicking "..." means the capture listener
      // never matched the row, `items: 0` with an open menu means the injection
      // itself refused the surface.
      try {
        window.__workspacePlusDiag = () => ({
          hook: window[HOOK_KEY] === hookOwner,
          armed: pendingRow ? pendingRow.workspaceId : null,
          injected: !!(pendingRow && pendingRow.injected),
          items: document.querySelectorAll(`[${MENU_MARK}="1"]`).length,
          openMenus: document.querySelectorAll('[role="menu"]').length,
          workspaceRows: document.querySelectorAll(`[data-row-key^="${ROW_PREFIX}"]`).length,
          lang: LANG,
        });
      } catch {}
      document.addEventListener('pointerdown', onArmCapture, true);
      document.addEventListener('click', onArmCapture, true);
      return () => {
        document.removeEventListener('pointerdown', onArmCapture, true);
        document.removeEventListener('click', onArmCapture, true);
        if (window[HOOK_KEY] === hookOwner) delete window[HOOK_KEY];
        try {
          delete window.__workspacePlusDiag;
        } catch {}
        hookOwner = null;
        stopObserving();
      };
    }

    // ---- plugin -----------------------------------------------------------
    const inject = ['slots'];

    function apply(ctx) {
      injectStyles();
      const teardown = installRowMenuHook();
      if (teardown) {
        if (typeof ctx.effect === 'function') ctx.effect(() => teardown, 'workspace-plus: row menu hook');
        else if (typeof ctx.on === 'function') ctx.on('dispose', teardown);
      }
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'workspace-plus-settings', order: 500 },
          () => h(WorkspaceSettingsDialog),
        ),
      );
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'workspace-plus', order: 920, label: t('page.title') },
          () => h(WorkspaceSettingsPage),
        ),
      );
    }

    exports.inject = inject;
    exports.apply = apply;
    // Pure-ish seams for the offline DOM test (`uitest.mjs`).
    exports.__test = { samePath, trimTrailing, targetQuery, STRINGS, MENU_MARK, findLabelElement, injectIntoMenu, store };
    return module.exports;
  },
});
