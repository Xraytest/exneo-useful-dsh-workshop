/**
 * 会话导入（dsh-session-import）— 浏览器半边。
 *
 * 设置页「会话导入」一节：把 `/export` 导出的会话归档 ZIP 传回本机并选择归属
 * 工作区。三步式界面，对应 host 半边的两条 POST：
 *
 *   ① 选择归档      `<input type=file>` / 拖放拿到 File 对象（不上传）；
 *   ② 解析归档      POST /dsh-session-import/inspect   —— **只读**，回概览；
 *   ③ 选择工作区    GET  /dsh-session-import/workspaces / /browse / POST /mkdir
 *      并导入       POST /dsh-session-import/import    —— 归档字节即请求体，
 *                                                        目标选择放查询串。
 *
 * 归档字节直接作为 `fetch` 的 body（不套 base64，几十 MB 的归档也只走一次
 * 内存拷贝）。导入成功后给「打开会话」按钮——走 `ctx.get('uiWorkspace')
 * .openSession(id)` 切到新导入的会话，省得用户自己去侧边栏翻。
 *
 * 由 package.json 的 dsh.client 声明装载（inject 依赖：设置页骨架、slots）；
 * 组合行见 cordis.patch.yml。UI 只注册进官方插槽，不碰出厂界面。
 *
 * ## 两条容易踩的机制（都在这里解决，别在别处重复实现）
 *
 * **① 拖放会被会话半边抢走。** `dsh-client-ui-attachment` 在 **document 冒泡阶段**
 * 挂了 drop/dragover，不看落点，任何拖进窗口的文件都会被当作会话附件上传——于是往
 * 本节拖一个归档会同时触发两份上传。`installDropGuard()` 在 **window 捕获阶段**
 * 拦截落点在本节拖放区内的事件（`preventDefault` + `stopPropagation`），会话侧
 * 根本收不到。capture 阶段 stopPropagation 会连带挡住本元素上的 React 处理器，
 * 所以守卫自己把文件交给 `dropSlot.accept`。
 *
 * **② 导入不能绑在组件生命周期上。** 设置页一关这一节就卸载了；若把上传放在组件
 * state 里，离开即中断、结果也丢。导入任务因此放在 **模块级任务仓 `job`** 里（一个
 * 普通 fetch，**没有** AbortController）：组件只是订阅者，挂载时接回同一份进度与
 * 结果，卸载不影响它。这正是「暂离设置而不刷新页面、上传不中断」的实现方式。
 *
 * @module dsh-session-import/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-import',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const API = '/dsh-session-import';

    /** `summary.via` 的中文说法（host 半边三条代际通道的标识）。 */
    const VIA_LABEL = {
      catalog: '格式目录还原',
      forward: '更新代前向通道',
      raw: '直接解析（未迁移）',
    };

    const CSS = [
      '.dsimp { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 24px; }',
      '.dsimp-head { display: flex; flex-direction: column; gap: 4px; }',
      '.dsimp-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.dsimp-sub { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }',
      '.dsimp-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 12px; display: flex; flex-direction: column; gap: 10px; }',
      '.dsimp-cardhead { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.dsimp-step { flex-shrink: 0; width: 18px; height: 18px; border-radius: 999px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-size: 11px; font-weight: 600; display: flex; align-items: center; justify-content: center; }',
      '.dsimp-drop { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; padding: 16px 12px; text-align: center; cursor: pointer; background: var(--dsw-alias-bg-layer-2); transition: border-color .12s, background .12s; }',
      '.dsimp-drop:hover { border-color: var(--dsw-alias-brand-primary); }',
      '.dsimp-drop.is-over { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); }',
      '.dsimp-dropmain { font-size: 12px; color: var(--dsw-alias-label-primary); }',
      '.dsimp-drophint { margin-top: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); }',
      '.dsimp-file { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-primary); }',
      '.dsimp-filemeta { color: var(--dsw-alias-label-secondary); font-size: 11px; }',
      '.dsimp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.dsimp-label { font-size: 12px; color: var(--dsw-alias-label-secondary); min-width: 68px; }',
      '.dsimp-input, .dsimp-select { appearance: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; padding: 6px 8px; outline: none; }',
      '.dsimp-input { flex: 1 1 240px; min-width: 160px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
      '.dsimp-input:focus, .dsimp-select:focus { border-color: var(--dsw-alias-brand-primary); }',
      '.dsimp-select { flex: 1 1 260px; min-width: 180px; }',
      '.dsimp-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; padding: 5px 12px; cursor: pointer; }',
      '.dsimp-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }',
      '.dsimp-btn:disabled { opacity: .5; cursor: not-allowed; }',
      '.dsimp-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 500; }',
      '.dsimp-radio { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-primary); cursor: pointer; }',
      '.dsimp-check { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-primary); cursor: pointer; }',
      '.dsimp-checkdesc { display: block; font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }',
      '.dsimp-grid { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 12px; }',
      '.dsimp-key { color: var(--dsw-alias-label-secondary); }',
      '.dsimp-val { color: var(--dsw-alias-label-primary); word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
      '.dsimp-warn { border: 1px solid var(--dsw-alias-border-l2); border-left: 3px solid var(--dsw-alias-state-warning-primary, var(--dsw-alias-brand-primary)); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); padding: 8px 10px; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }',
      '.dsimp-error { border: 1px solid var(--dsw-alias-state-error-primary, #d33); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); padding: 8px 10px; font-size: 12px; color: var(--dsw-alias-state-error-primary, #d33); word-break: break-word; }',
      '.dsimp-ok { border: 1px solid var(--dsw-alias-state-success-primary, #2a2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }',
      '.dsimp-oktitle { font-size: 12px; font-weight: 600; color: var(--dsw-alias-state-success-primary, #2a2); }',
      '.dsimp-browse { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-base); padding: 10px; display: flex; flex-direction: column; gap: 8px; }',
      '.dsimp-browsepath { font-size: 11px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }',
      '.dsimp-list { max-height: 220px; overflow: auto; display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 4px; }',
      '.dsimp-item { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; text-align: left; padding: 4px 8px; border-radius: 6px; cursor: pointer; }',
      '.dsimp-item:hover { background: var(--dsw-alias-bg-layer-2); }',
      '.dsimp-empty { font-size: 11px; color: var(--dsw-alias-label-secondary); padding: 6px 8px; }',
      '.dsimp-sub-list { display: flex; flex-direction: column; gap: 3px; margin-top: 4px; }',
      '.dsimp-sub-item { font-size: 11px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
      '.dsimp-spin { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.dsimp-note { border: 1px solid var(--dsw-alias-border-l2); border-left-width: 3px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); padding: 8px 10px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }',
      '.dsimp-note strong { color: var(--dsw-alias-label-primary); font-weight: 600; }',
      '.dsimp-job { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); flex-wrap: wrap; }',
      '.dsimp-badge { flex-shrink: 0; border-radius: 999px; padding: 1px 8px; font-size: 11px; background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }',
    ].join('\n');

    let stylesInjected = false;
    function injectStyles() {
      if (stylesInjected) return;
      stylesInjected = true;
      const tag = document.createElement('style');
      tag.setAttribute('data-dsh-session-import', '1');
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** 统一 API 调用：同源相对路径；非 2xx 或 ok:false 都抛带后端文案的 Error。 */
    async function callApi(path, options = {}) {
      const response = await fetch(path, {
        method: options.method || 'GET',
        body: options.body,
        headers: options.headers,
        credentials: 'same-origin',
      });
      const text = await response.text();
      let value = null;
      try {
        value = text === '' ? null : JSON.parse(text);
      } catch {
        throw new Error(text || `HTTP ${response.status}`);
      }
      if (!response.ok || (value !== null && value.ok === false)) {
        throw new Error((value && value.error) || `HTTP ${response.status}`);
      }
      return value;
    }

    const formatBytes = (bytes) => {
      if (!Number.isFinite(bytes)) return '—';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
      return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
    };

    const formatTime = (ms) => {
      if (!Number.isFinite(ms)) return '—';
      try {
        return new Date(ms).toLocaleString();
      } catch {
        return String(ms);
      }
    };

    /** 把后端返回的 warnings 数组渲染成一块提示（空数组返回 null）。 */
    function warnings(items) {
      if (!Array.isArray(items) || items.length === 0) return null;
      return h('div', { className: 'dsimp-warn' },
        ...items.map((text, index) => h('div', { key: index }, `· ${text}`)));
    }

    // ── 落在本区域里的拖放：抢在会话附件之前吃掉 ──────────────────────────────
    //
    // 会话半边（dsh-client-ui-attachment）在 **document 冒泡阶段** 挂了
    // drop / dragover / dragenter，**不看落点**，把任何拖进窗口的文件都当会话附件
    // 上传。于是往设置里拖一个归档会同时触发两份上传（一份进会话、一份进本插件）。
    //
    // 这里在 **window 捕获阶段** 拦截：捕获自外向内，window 最先拿到事件；只要落点
    // 在本插件的拖放区里，就 preventDefault + stopPropagation 并自行处理，会话侧
    // 根本看不到这个事件，也就不会亮起「可放置」提示、更不会上传。
    //
    // 捕获阶段 stopPropagation 会连带挡住本元素上的 React 处理器，所以文件在这里
    // 直接交给 dropSlot.accept——React 那侧的 onDrop 只作为守卫未装上时的兜底。
    const dropSlot = { element: null, accept: null, hover: null };

    function insideDropZone(node) {
      const zone = dropSlot.element;
      if (zone === null || zone === undefined || node === null || node === undefined) return false;
      if (zone === node) return true;
      return typeof zone.contains === 'function' && zone.contains(node) === true;
    }

    /** 装上拖放守卫，返回卸载函数（由 ctx.effect 拥有生命周期）。 */
    function installDropGuard() {
      const swallow = (event) => {
        if (!insideDropZone(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof dropSlot.hover === 'function') dropSlot.hover(true);
      };
      const onDrop = (event) => {
        if (!insideDropZone(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof dropSlot.hover === 'function') dropSlot.hover(false);
        const transfer = event.dataTransfer;
        const files = transfer === null || transfer === undefined ? null : transfer.files;
        const dropped = files !== null && files !== undefined && files.length > 0 ? files[0] : null;
        if (dropped !== null && typeof dropSlot.accept === 'function') dropSlot.accept(dropped);
      };
      const onLeave = (event) => {
        if (insideDropZone(event.relatedTarget)) return;
        if (typeof dropSlot.hover === 'function') dropSlot.hover(false);
      };
      const onEnd = () => {
        if (typeof dropSlot.hover === 'function') dropSlot.hover(false);
      };
      window.addEventListener('dragenter', swallow, true);
      window.addEventListener('dragover', swallow, true);
      window.addEventListener('dragleave', onLeave, true);
      window.addEventListener('drop', onDrop, true);
      window.addEventListener('dragend', onEnd, true);
      return () => {
        window.removeEventListener('dragenter', swallow, true);
        window.removeEventListener('dragover', swallow, true);
        window.removeEventListener('dragleave', onLeave, true);
        window.removeEventListener('drop', onDrop, true);
        window.removeEventListener('dragend', onEnd, true);
      };
    }

    // ── 模块级导入任务仓 ────────────────────────────────────────────────────
    //
    // 为什么放在模块作用域而不是组件 state：设置页一关，这一节就卸载了，组件 state
    // 随之消失——上传被遗忘、结果也看不到。任务必须活在组件之外，才能在**不刷新页面**
    // 的前提下暂离设置而不中断整条导入流程；重新挂载时接回同一份进度与结果。
    //
    // 组件只是订阅者。任务本身是一个普通 fetch（**没有** AbortController 绑生命周期），
    // 归档 File 由闭包持有，所以卸载不会取消它。
    const IDLE_JOB = Object.freeze({
      phase: 'idle', fileName: null, bytes: 0, error: null, result: null, startedAt: 0, finishedAt: 0,
    });

    const job = {
      state: { ...IDLE_JOB },
      snapshot: null,
      listeners: new Set(),
      get() {
        if (job.snapshot === null) job.snapshot = { ...job.state };
        return job.snapshot;
      },
      subscribe(listener) {
        job.listeners.add(listener);
        return () => { job.listeners.delete(listener); };
      },
      patch(next) {
        job.state = { ...job.state, ...next };
        job.snapshot = { ...job.state };
        for (const listener of [...job.listeners]) listener();
      },
      reset() {
        job.patch({ ...IDLE_JOB });
      },
    };

    /** 订阅任务仓的 hook：组件卸载即退订，任务本身不受影响。 */
    function useImportJob() {
      const [snapshot, setSnapshot] = React.useState(job.get());
      React.useEffect(() => job.subscribe(() => setSnapshot(job.get())), []);
      return snapshot;
    }

    /**
     * 启动一次导入。**故意不返回 Promise**——调用方不等它，任务由 job 仓承载，
     * 因此设置页的卸载与它无关。
     * @param {{file: File, query: string}} options 归档 File 与查询串。
     */
    function startImport(options) {
      const { file, query } = options;
      job.patch({
        phase: 'importing',
        fileName: file.name,
        bytes: file.size,
        error: null,
        result: null,
        startedAt: Date.now(),
        finishedAt: 0,
      });
      fetch(`${API}/import?${query}`, {
        method: 'POST',
        headers: { accept: 'application/json' },
        body: file,
      })
        .then(async (response) => {
          const text = await response.text();
          let value = null;
          try {
            value = text === '' ? null : JSON.parse(text);
          } catch {
            value = null;
          }
          if (!response.ok || (value !== null && value.ok === false)) {
            throw new Error((value !== null && value.error) || `HTTP ${response.status}`);
          }
          return value;
        })
        .then((value) => job.patch({ phase: 'done', result: value, finishedAt: Date.now() }))
        .catch((cause) => job.patch({
          phase: 'failed',
          error: String((cause && cause.message) || cause),
          finishedAt: Date.now(),
        }));
    }

    function SessionImportPanel(props) {
      const ctx = props.ctx;

      const [workspaces, setWorkspaces] = React.useState([]);
      const [workspacesError, setWorkspacesError] = React.useState(null);
      const [targetMode, setTargetMode] = React.useState('existing');
      const [workspaceId, setWorkspaceId] = React.useState('');
      const [newPath, setNewPath] = React.useState('');
      const [newTitle, setNewTitle] = React.useState('');

      const [browse, setBrowse] = React.useState(null);
      const [browseBusy, setBrowseBusy] = React.useState(false);
      const [newDirName, setNewDirName] = React.useState('');

      const [file, setFile] = React.useState(null);
      const [dragOver, setDragOver] = React.useState(false);
      const fileInput = React.useRef(null);
      const dropRef = React.useRef(null);

      const [summary, setSummary] = React.useState(null);
      const [inspectWarnings, setInspectWarnings] = React.useState([]);
      const [includeSubagents, setIncludeSubagents] = React.useState(true);
      const [assignNewIds, setAssignNewIds] = React.useState(true);

      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);

      // 导入任务的状态来自模块级任务仓：离开设置页不会中断，回来就是同一份进度与结果。
      const jobState = useImportJob();
      const importing = jobState.phase === 'importing';
      const result = jobState.phase === 'done' ? jobState.result : null;

      const loadWorkspaces = React.useCallback(() => {
        setWorkspacesError(null);
        callApi(`${API}/workspaces`)
          .then((value) => {
            const list = Array.isArray(value.workspaces) ? value.workspaces : [];
            setWorkspaces(list);
            setWorkspaceId((current) => (current === '' && list.length > 0 ? list[0].id : current));
          })
          .catch((cause) => setWorkspacesError(String(cause.message || cause)));
      }, []);

      React.useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);

      // 每次渲染都刷新模块槽，保证 window 捕获监听里拿到的是最新闭包（latest-ref 模式）。
      React.useEffect(() => {
        dropSlot.element = dropRef.current;
        dropSlot.accept = chooseFile;
        dropSlot.hover = setDragOver;
        return () => {
          if (dropSlot.element === dropRef.current) {
            dropSlot.element = null;
            dropSlot.accept = null;
            dropSlot.hover = null;
          }
        };
      });

      // 导入完成后刷新工作区清单——本次新建的工作区要出现在下拉里。用 finishedAt
      // 去重，所以无论任务是当场完成、还是离开设置页期间完成，回到这一节都会刷新一次。
      const settledRef = React.useRef(0);
      React.useEffect(() => {
        if (jobState.phase !== 'done' || jobState.finishedAt === settledRef.current) return;
        settledRef.current = jobState.finishedAt;
        loadWorkspaces();
      }, [jobState.phase, jobState.finishedAt, loadWorkspaces]);

      const resetInspect = () => {
        setSummary(null);
        setInspectWarnings([]);
        setError(null);
      };

      const chooseFile = (next) => {
        if (next === null || next === undefined) return;
        setFile(next);
        // 正在导入时不动任务仓——换个文件不该把跑着的任务状态抹掉。
        if (job.get().phase !== 'importing') job.reset();
        resetInspect();
      };

      const doInspect = async () => {
        if (file === null) return;
        setBusy('inspect');
        setError(null);
        try {
          const value = await callApi(`${API}/inspect`, { method: 'POST', body: file });
          setSummary(value.summary);
          setInspectWarnings(Array.isArray(value.warnings) ? value.warnings : []);
        } catch (cause) {
          setSummary(null);
          setError(String(cause.message || cause));
        } finally {
          setBusy(null);
        }
      };

      const openBrowse = async (path) => {
        setBrowseBusy(true);
        setError(null);
        try {
          const suffix = path === undefined || path === null || path === '' ? '' : `?path=${encodeURIComponent(path)}`;
          const value = await callApi(`${API}/browse${suffix}`);
          setBrowse({ path: value.path, parent: value.parent, entries: value.entries, truncated: value.truncated === true });
        } catch (cause) {
          setError(String(cause.message || cause));
        } finally {
          setBrowseBusy(false);
        }
      };

      const doMkdir = async () => {
        if (browse === null || newDirName.trim() === '') return;
        setBrowseBusy(true);
        setError(null);
        try {
          const value = await callApi(`${API}/mkdir`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ parent: browse.path, name: newDirName.trim() }),
          });
          setNewDirName('');
          await openBrowse(value.path);
          setNewPath(value.path);
        } catch (cause) {
          setError(String(cause.message || cause));
        } finally {
          setBrowseBusy(false);
        }
      };

      const doImport = () => {
        if (file === null) return;
        const params = new URLSearchParams();
        if (targetMode === 'existing') {
          if (workspaceId === '') {
            setError('请选择一个既有工作区。');
            return;
          }
          params.set('workspaceId', workspaceId);
        } else {
          if (newPath.trim() === '') {
            setError('请填写新工作区的绝对路径（目录必须已存在，可用「浏览」新建）。');
            return;
          }
          params.set('newPath', newPath.trim());
          if (newTitle.trim() !== '') params.set('newTitle', newTitle.trim());
        }
        params.set('includeSubagents', includeSubagents ? '1' : '0');
        params.set('assignNewIds', assignNewIds ? '1' : '0');

        setError(null);
        // 交给模块级任务仓跑：调用方不等它，设置页卸载也不影响。
        startImport({ file, query: params.toString() });
      };

      const openSession = () => {
        if (result === null || result.sessionId === null || result.sessionId === undefined) return;
        const workspace = ctx.get('uiWorkspace');
        if (workspace !== undefined && typeof workspace.openSession === 'function') {
          workspace.openSession(result.sessionId);
          if (typeof props.close === 'function') props.close();
        }
      };

      const targetReady = targetMode === 'existing' ? workspaceId !== '' : newPath.trim() !== '';

      // ── 归档概览 ────────────────────────────────────────────────────────────
      const summaryView = summary === null ? null : h('div', { className: 'dsimp-card' }, [
        h('div', { className: 'dsimp-cardhead', key: 'head' }, '归档概览'),
        h('div', { className: 'dsimp-grid', key: 'grid' }, [
          h('span', { className: 'dsimp-key', key: 'k1' }, '源会话 ID'),
          h('span', { className: 'dsimp-val', key: 'v1' }, summary.originalSessionId),
          h('span', { className: 'dsimp-key', key: 'k2' }, '创建时间'),
          h('span', { className: 'dsimp-val', key: 'v2' }, formatTime(summary.createdAt)),
          h('span', { className: 'dsimp-key', key: 'k3' }, '原工作目录'),
          h('span', { className: 'dsimp-val', key: 'v3' }, summary.originalCwd === null ? '（无）' : summary.originalCwd),
          h('span', { className: 'dsimp-key', key: 'k4' }, 'Agent 预设'),
          h('span', { className: 'dsimp-val', key: 'v4' }, summary.agentPreset === null ? '（无）' : summary.agentPreset),
          h('span', { className: 'dsimp-key', key: 'k5' }, '根会话事件'),
          h('span', { className: 'dsimp-val', key: 'v5' }, `${summary.rootEventCount} 条 · 存储代 v${summary.storedVersion} · 经 ${VIA_LABEL[summary.via] || '直接解析'}`),
          h('span', { className: 'dsimp-key', key: 'k6' }, '子代理会话'),
          h('span', { className: 'dsimp-val', key: 'v6' }, summary.subagents.length === 0 ? '（无）' : `${summary.subagents.length} 条`),
          h('span', { className: 'dsimp-key', key: 'k7' }, '附件'),
          h('span', { className: 'dsimp-val', key: 'v7' }, `图片 ${summary.mediaCount} · 文件 ${summary.fileCount}`),
        ]),
        summary.subagents.length === 0 ? null : h('div', { className: 'dsimp-sub-list', key: 'subs' },
          ...summary.subagents.slice(0, 12).map((entry, index) => h('div', { className: 'dsimp-sub-item', key: index },
            `${entry.originalId} — ${entry.eventCount} 条事件${entry.agentPreset === null ? '' : ` · ${entry.agentPreset}`}`)),
          summary.subagents.length > 12 ? h('div', { className: 'dsimp-sub-item', key: 'more' }, `… 另有 ${summary.subagents.length - 12} 条`) : null),
        summary.degraded === null || summary.degraded === undefined ? null : h('div', { className: 'dsimp-note', key: 'degraded' },
          summary.degraded.kind === 'newer-format'
            ? [
              h('strong', { key: 'h' },
                `归档是存储代 v${summary.degraded.storedVersion}，本机只写到 v${summary.degraded.targetVersion}。`),
              '本机没有这一代的编解码器，因此不尝试翻译事件语义：事件逐字保留，交由持久化层的校验器逐条裁决——写入方标记为可忽略（ignorable）的未知事件会被跳过，其余未知事件会让整个导入被拒（校验器原话会照实显示）。这是出厂为「更新代日志」设计的闸，不做猜测。',
            ]
            : `提示：${summary.degraded.reason}`),
        warnings(inspectWarnings),
      ]);

      // ── 工作区选择 ──────────────────────────────────────────────────────────
      const workspacePicker = h('div', { className: 'dsimp-card' }, [
        h('div', { className: 'dsimp-cardhead', key: 'head' }, [
          h('span', { className: 'dsimp-step', key: 'step' }, '3'),
          h('span', { key: 'text' }, '选择归属工作区'),
        ]),
        h('div', { className: 'dsimp-row', key: 'modes' }, [
          h('label', { className: 'dsimp-radio', key: 'existing' }, [
            h('input', {
              key: 'r',
              type: 'radio',
              name: 'dsimp-target',
              checked: targetMode === 'existing',
              onChange: () => setTargetMode('existing'),
            }),
            h('span', { key: 't' }, '导入到既有工作区'),
          ]),
          h('label', { className: 'dsimp-radio', key: 'new' }, [
            h('input', {
              key: 'r',
              type: 'radio',
              name: 'dsimp-target',
              checked: targetMode === 'new',
              onChange: () => {
                setTargetMode('new');
                if (browse === null) openBrowse(newPath.trim() === '' ? undefined : newPath.trim());
              },
            }),
            h('span', { key: 't' }, '新建工作区'),
          ]),
        ]),
        workspacesError === null ? null : h('div', { className: 'dsimp-error', key: 'werr' }, `工作区清单读取失败：${workspacesError}`),

        targetMode === 'existing'
          ? h('div', { className: 'dsimp-row', key: 'sel' }, [
            h('span', { className: 'dsimp-label', key: 'l' }, '工作区'),
            h('select', {
              key: 's',
              className: 'dsimp-select',
              value: workspaceId,
              onChange: (event) => setWorkspaceId(event.target.value),
            },
              workspaces.length === 0
                ? h('option', { value: '', key: 'none' }, '（没有可选工作区）')
                : workspaces.map((workspace) => h('option', { value: workspace.id, key: workspace.id },
                  `${workspace.title || workspace.path} — ${workspace.path}（${workspace.sessionCount} 个会话${workspace.status === 'missing-dir' ? '，目录已丢失' : ''}）`)),
            ),
            h('button', { className: 'dsimp-btn', key: 'r', type: 'button', onClick: loadWorkspaces }, '刷新'),
          ])
          : h('div', { key: 'newbox', style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
            h('div', { className: 'dsimp-row', key: 'path' }, [
              h('span', { className: 'dsimp-label', key: 'l' }, '目录'),
              h('input', {
                key: 'i',
                className: 'dsimp-input',
                value: newPath,
                placeholder: '/root/nas/ArkTower',
                onChange: (event) => setNewPath(event.target.value),
              }),
              h('button', {
                className: 'dsimp-btn',
                key: 'b',
                type: 'button',
                disabled: browseBusy,
                onClick: () => openBrowse(newPath.trim() === '' ? undefined : newPath.trim()),
              }, browseBusy ? '读取中…' : '浏览'),
            ]),
            h('div', { className: 'dsimp-row', key: 'title' }, [
              h('span', { className: 'dsimp-label', key: 'l' }, '显示名'),
              h('input', {
                key: 'i',
                className: 'dsimp-input',
                value: newTitle,
                placeholder: '（留空则取目录名）',
                onChange: (event) => setNewTitle(event.target.value),
              }),
            ]),
            h('div', { className: 'dsimp-sub', key: 'hint' },
              '工作区目录必须已存在——DSH 的工作区记录对路径做 realpath 规范化，不存在的目录建不了。下面的「浏览」可以在任意已有目录下新建一级目录。'),
            browse === null ? null : h('div', { className: 'dsimp-browse', key: 'browse' }, [
              h('div', { className: 'dsimp-browsepath', key: 'p' }, browse.path),
              h('div', { className: 'dsimp-row', key: 'nav' }, [
                h('button', {
                  className: 'dsimp-btn',
                  key: 'up',
                  type: 'button',
                  disabled: browse.parent === null || browseBusy,
                  onClick: () => openBrowse(browse.parent),
                }, '上一级'),
                h('button', {
                  className: 'dsimp-btn',
                  key: 'use',
                  type: 'button',
                  onClick: () => { setNewPath(browse.path); setBrowse(null); },
                }, '选用此目录'),
                h('button', {
                  className: 'dsimp-btn',
                  key: 'close',
                  type: 'button',
                  onClick: () => setBrowse(null),
                }, '关闭'),
              ]),
              h('div', { className: 'dsimp-row', key: 'mk' }, [
                h('input', {
                  key: 'i',
                  className: 'dsimp-input',
                  value: newDirName,
                  placeholder: '新目录名',
                  onChange: (event) => setNewDirName(event.target.value),
                }),
                h('button', {
                  className: 'dsimp-btn',
                  key: 'b',
                  type: 'button',
                  disabled: browseBusy || newDirName.trim() === '',
                  onClick: doMkdir,
                }, '新建目录'),
              ]),
              h('div', { className: 'dsimp-list', key: 'list' },
                browse.entries.length === 0
                  ? h('div', { className: 'dsimp-empty', key: 'e' }, '（此目录下没有子目录）')
                  : browse.entries.map((entry) => h('button', {
                    className: 'dsimp-item',
                    key: entry.path,
                    type: 'button',
                    onClick: () => openBrowse(entry.path),
                  }, `📁 ${entry.name}`)),
                browse.truncated ? h('div', { className: 'dsimp-empty', key: 't' }, '（条目过多，已截断）') : null),
            ]),
          ]),
      ]);

      // ── 导入结果 ────────────────────────────────────────────────────────────
      const resultView = result === null ? null : h('div', { className: 'dsimp-ok' }, [
        h('div', { className: 'dsimp-oktitle', key: 't' }, `导入成功：${result.sessions.length} 条会话已写入`),
        h('div', { className: 'dsimp-grid', key: 'grid' }, [
          h('span', { className: 'dsimp-key', key: 'k1' }, '新会话 ID'),
          h('span', { className: 'dsimp-val', key: 'v1' }, String(result.sessionId)),
          h('span', { className: 'dsimp-key', key: 'k2' }, '归属工作区'),
          h('span', { className: 'dsimp-val', key: 'v2' }, `${result.workspace.title} — ${result.workspace.path}${result.workspace.created ? '（本次新建）' : ''}`),
          h('span', { className: 'dsimp-key', key: 'k3' }, '已记入账目'),
          h('span', { className: 'dsimp-val', key: 'v3' }, `${result.attached.length} 条`),
          h('span', { className: 'dsimp-key', key: 'k4' }, '附件回灌'),
          h('span', { className: 'dsimp-val', key: 'v4' }, `图片 ${result.attachments.images} · 文件 ${result.attachments.files}`),
        ]),
        warnings(result.warnings),
        h('div', { className: 'dsimp-row', key: 'actions' }, [
          h('button', { className: 'dsimp-btn dsimp-primary', key: 'open', type: 'button', onClick: openSession }, '打开会话'),
          h('button', {
            className: 'dsimp-btn',
            key: 'again',
            type: 'button',
            onClick: () => { job.reset(); setSummary(null); setFile(null); },
          }, '再导入一个'),
        ]),
      ]);

      return h('div', { className: 'dsimp' }, [
        h('div', { className: 'dsimp-head', key: 'head' }, [
          h('div', { className: 'dsimp-title', key: 't' }, '会话导入'),
          h('div', { className: 'dsimp-sub', key: 's' },
            '把「下载会话日志」（Session Header 的更多操作）或 /export 命令导出的 ZIP 归档导回本机，成为可继续对话的会话。归档离机后 DSH 出厂没有回程入口，这一节补上它。'),
        ]),

        // 任务横幅：导入跑在模块级任务仓里，所以离开设置页再回来，这里仍是同一条进度。
        jobState.phase === 'idle' ? null : h('div', { className: 'dsimp-card', key: 'job' }, [
          h('div', { className: 'dsimp-job', key: 'head' }, [
            h('span', { className: 'dsimp-badge', key: 'b' },
              jobState.phase === 'importing' ? '进行中' : jobState.phase === 'done' ? '已完成' : '失败'),
            h('span', { key: 'f' }, `归档 ${jobState.fileName} · ${formatBytes(jobState.bytes)}`),
          ]),
          jobState.phase === 'importing'
            ? h('div', { className: 'dsimp-note', key: 'n' },
              '正在写入会话库与工作区账目。这一步不依赖本页面：可以直接关闭设置、切去别的会话，导入照常跑完；回到本节即接回同一份进度与结果。')
            : null,
          jobState.phase === 'failed' ? h('div', { className: 'dsimp-error', key: 'e' }, jobState.error) : null,
        ]),

        h('div', { className: 'dsimp-card', key: 'pick' }, [
          h('div', { className: 'dsimp-cardhead', key: 'head' }, [
            h('span', { className: 'dsimp-step', key: 'step' }, '1'),
            h('span', { key: 'text' }, '选择归档文件'),
          ]),
          h('div', {
            className: dragOver ? 'dsimp-drop is-over' : 'dsimp-drop',
            key: 'drop',
            ref: dropRef,
            onClick: () => fileInput.current && fileInput.current.click(),
            // 下面这三个只在 window 捕获守卫**没装上**时才会触发——守卫在捕获阶段
            // 就 stopPropagation 了，事件根本到不了这里（见 installDropGuard）。
            onDragOver: (event) => { event.preventDefault(); setDragOver(true); },
            onDragLeave: () => setDragOver(false),
            onDrop: (event) => {
              event.preventDefault();
              setDragOver(false);
              const dropped = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
              if (dropped) chooseFile(dropped);
            },
          }, [
            h('div', { className: 'dsimp-dropmain', key: 'm' }, '点击选择 .zip 归档，或把它拖到这里'),
            h('div', { className: 'dsimp-drophint', key: 'h' }, '归档只在本机解析与写入，不会上传到任何外部服务'),
          ]),
          h('input', {
            key: 'input',
            ref: fileInput,
            type: 'file',
            accept: '.zip,application/zip',
            style: { display: 'none' },
            onChange: (event) => {
              const chosen = event.target.files ? event.target.files[0] : null;
              chooseFile(chosen || null);
              event.target.value = '';
            },
          }),
          file === null ? null : h('div', { className: 'dsimp-file', key: 'file' }, [
            h('span', { key: 'n' }, `📦 ${file.name}`),
            h('span', { className: 'dsimp-filemeta', key: 'm' }, formatBytes(file.size)),
          ]),
          h('div', { className: 'dsimp-row', key: 'actions' }, [
            h('button', {
              className: 'dsimp-btn',
              key: 'inspect',
              type: 'button',
              disabled: file === null || busy !== null,
              onClick: doInspect,
            }, busy === 'inspect' ? '解析中…' : '解析归档（只读）'),
          ]),
        ]),

        summaryView,

        summary === null ? null : h('div', { className: 'dsimp-card', key: 'options' }, [
          h('div', { className: 'dsimp-cardhead', key: 'head' }, [
            h('span', { className: 'dsimp-step', key: 'step' }, '2'),
            h('span', { key: 'text' }, '导入选项'),
          ]),
          h('label', { className: 'dsimp-check', key: 'sub' }, [
            h('input', {
              key: 'c',
              type: 'checkbox',
              checked: includeSubagents,
              onChange: (event) => setIncludeSubagents(event.target.checked),
            }),
            h('span', { key: 't' }, [
              '同时导入子代理会话',
              h('span', { className: 'dsimp-checkdesc', key: 'd' },
                `归档里有 ${summary.subagents.length} 条子代理会话；它们的父引用会重映射到本次导入的根会话。按本部署惯例，子代理不单独记入工作区账目（随父会话呈现）。`),
            ]),
          ]),
          h('label', { className: 'dsimp-check', key: 'ids' }, [
            h('input', {
              key: 'c',
              type: 'checkbox',
              checked: assignNewIds,
              onChange: (event) => setAssignNewIds(event.target.checked),
            }),
            h('span', { key: 't' }, [
              '重新分配会话 id（推荐）',
              h('span', { className: 'dsimp-checkdesc', key: 'd' },
                '勾选后每次导入都产生全新会话，同一归档可重复导入、绝不覆盖已有会话；取消勾选则保留原 id，若该 id 已存在会直接报错。'),
            ]),
          ]),
        ]),

        summary === null ? null : workspacePicker,

        error === null ? null : h('div', { className: 'dsimp-error', key: 'err' }, error),

        summary === null ? null : h('div', { className: 'dsimp-row', key: 'go' }, [
          h('button', {
            className: 'dsimp-btn dsimp-primary',
            key: 'import',
            type: 'button',
            disabled: busy !== null || !targetReady,
            onClick: doImport,
          }, busy === 'import' ? '导入中…' : '开始导入'),
          busy === 'import' ? h('span', { className: 'dsimp-spin', key: 's' }, '正在写入会话库与工作区账目…') : null,
        ]),

        resultView,
      ]);
    }

    const inject = ['slots'];

    function apply(ctx) {
      injectStyles();
      // 拖放守卫是全局监听：由 ctx.effect 拥有，插件卸载即摘除。
      ctx.effect(installDropGuard);
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'session-import', order: 910, label: '会话导入' },
        (ownerProps) => h(SessionImportPanel, { ctx, close: ownerProps && ownerProps.close }),
      ));
    }

    exports.inject = inject;
    exports.apply = apply;
    exports.__test = { formatBytes, formatTime, CSS };
    return module.exports;
  },
});
