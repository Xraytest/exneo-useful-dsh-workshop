/**
 * REA 工具选择器 — 浏览器半边（设置页「REA 工具」）。
 *
 * 只做一件事：把 host 半边的选择状态画出来、让人改，然后 POST 回去。真正的
 * 过滤发生在 host：`agent.ctx.tools.restrict({ deny })` 把没选中的 `mcp__rea__*`
 * 从模型工具表里摘掉（schema 不再随请求下发，调用也会 UNKNOWN_TOOL）。
 *
 * 数据面（同源路由，见 index.js）：
 *   GET  /dsh-rea-mcp/state  → { state, tools[], groups[], presets[], stats, server }
 *   POST /dsh-rea-mcp/save   → { masterEnabled, mode, enabled[] }
 *   POST /dsh-rea-mcp/reset  → 回到全选
 *
 * 约定：主题只用 `--dsw-alias-*` token；不 import 任何 Harness Client 包；
 * 文案走 locale 服务（bind 不到时按 active locale 回落中/英字典）；保存前不改
 * host 状态，保存失败给出可重试的错误，不把页面留在「加载中…」。
 *
 * @module @local/rea-mcp/client
 */

window.__ModuleLoader__.load({
  id: '@local/rea-mcp',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const NS = 'rea-mcp';
    const ROUTE_STATE = '/dsh-rea-mcp/state';
    const ROUTE_SAVE = '/dsh-rea-mcp/save';
    const ROUTE_RESET = '/dsh-rea-mcp/reset';

    const ZH = {
      section: 'REA 工具',
      title: 'REA 工具选择',
      desc: 'REA 通过 MCP 暴露 200+ 个逆向分析工具，全部 schema 会随每轮请求进入模型上下文。这里决定哪些工具对模型可见：没选中的工具模型看不到、也调不动（连接保持）。保存后立即生效。',
      master: '启用 REA 工具',
      masterOff: '已整体停用：连接保留，但模型看不到任何 REA 工具。',
      connected: '已连接',
      disconnected: '未检测到 REA 工具（MCP 服务器可能还在启动，或该行被停用）',
      total: '工具',
      enabled: '已启用',
      bytes: '本轮 schema 体积',
      allBytes: '全量体积',
      search: '搜索工具名或描述…',
      all: '全选',
      none: '全不选',
      core: '核心推荐',
      save: '保存',
      saving: '保存中…',
      saved: '已保存并生效',
      reset: '恢复全选',
      retry: '重试',
      loading: '加载中…',
      loadFailed: '读取选择失败',
      saveFailed: '保存失败',
      dirty: '有未保存的修改',
      noMatch: '没有匹配的工具',
      noTools: '还没有 REA 工具。等 MCP 服务器连上后刷新本页即可。',
      refresh: '刷新',
      hint: '提示：隐藏的工具不会进入工具表（省上下文），但模型也完全看不见它们；需要时在这里打开即可。',
      groupCore: '全选分组',
    };

    const EN = {
      section: 'REA tools',
      title: 'REA tool selection',
      desc: 'REA exposes 200+ reverse-engineering tools over MCP, and every schema rides along in each request. Choose which tools the model can see: unselected tools are invisible and uncallable, while the connection stays live. Changes apply on save.',
      master: 'Enable REA tools',
      masterOff: 'Disabled entirely: the connection stays, but the model sees no REA tool.',
      connected: 'connected',
      disconnected: 'No REA tools detected (the MCP server may still be starting, or its row is disabled)',
      total: 'tools',
      enabled: 'enabled',
      bytes: 'schema bytes / request',
      allBytes: 'full set',
      search: 'Search name or description…',
      all: 'Select all',
      none: 'Select none',
      core: 'Core set',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved and applied',
      reset: 'Reset to all',
      retry: 'Retry',
      loading: 'Loading…',
      loadFailed: 'Could not load the selection',
      saveFailed: 'Save failed',
      dirty: 'Unsaved changes',
      noMatch: 'No matching tools',
      noTools: 'No REA tools yet. Refresh once the MCP server connects.',
      refresh: 'Refresh',
      hint: 'Hidden tools leave the tool list (saving context) but also become invisible to the model; re-enable them here when needed.',
      groupCore: 'Select group',
    };

    const CSS = [
      '.rea-page { padding: 4px 2px 28px; display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); font-size: 13px; }',
      '.rea-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }',
      '.rea-title { font-size: 15px; font-weight: 600; }',
      '.rea-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }',
      '.rea-badge.on { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }',
      '.rea-badge.warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }',
      '.rea-desc { font-size: 12px; line-height: 1.75; color: var(--dsw-alias-label-secondary); }',
      '.rea-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }',
      '.rea-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
      '.rea-grow { flex: 1 1 auto; }',
      '.rea-switch { width: 38px; height: 21px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); position: relative; cursor: pointer; padding: 0; appearance: none; transition: background .18s cubic-bezier(.32,.72,0,1), border-color .18s cubic-bezier(.32,.72,0,1); }',
      '.rea-switch:hover:not(:disabled) { border-color: var(--dsw-alias-border-inverted); }',
      '.rea-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }',
      '.rea-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }',
      '.rea-switch i { position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: #fff; transition: left .18s cubic-bezier(.32,.72,0,1); display: block; box-shadow: 0 1px 2px rgb(0 0 0 / 25%); }',
      '.rea-switch[aria-checked="true"] i { left: 20px; }',
      '.rea-stat { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.rea-stat b { color: var(--dsw-alias-label-primary); font-weight: 600; }',
      '.rea-btn { font: inherit; font-size: 12px; line-height: 1; padding: 7px 11px; border-radius: var(--dsw-radius-sm, 8px); border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; transition: border-color .15s ease, background .15s ease; }',
      '.rea-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-interactive-bg-hover-solid); }',
      '.rea-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }',
      '.rea-btn:disabled { opacity: .5; cursor: default; }',
      '.rea-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }',
      '.rea-input { flex: 1 1 200px; min-width: 160px; font-size: 12px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }',
      '.rea-list { display: flex; flex-direction: column; gap: 8px; max-height: 460px; overflow: auto; padding-right: 2px; }',
      '.rea-group { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }',
      '.rea-group > summary { cursor: pointer; padding: 9px 12px; font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 8px; list-style: none; }',
      '.rea-group > summary::-webkit-details-marker { display: none; }',
      '.rea-count { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary); }',
      '.rea-tools { display: flex; flex-direction: column; border-top: 1px solid var(--dsw-alias-border-l1); }',
      '.rea-tool { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: start; padding: 7px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }',
      '.rea-tool:last-child { border-bottom: 0; }',
      '.rea-tool input { margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary); }',
      '.rea-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; word-break: break-all; }',
      '.rea-tool-desc { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); margin-top: 2px; }',
      '.rea-note { font-size: 11px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }',
      '.rea-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }',
      '.rea-warn { font-size: 12px; color: var(--dsw-alias-state-warn-primary); }',
      '.rea-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary); }',
      '.rea-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 12px; text-align: center; }',
      '.rea-disabled { opacity: .55; }',
    ].join('\n');

    async function api(path, options) {
      const response = await fetch(path, options);
      let body = null;
      try {
        body = await response.json();
      } catch {
        /* 非 JSON：走状态码分支 */
      }
      if (!response.ok) throw new Error((body && body.error) || `${response.status} ${response.statusText}`);
      return body;
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1048576).toFixed(2)} MB`;
    }

    /** 语言回落：优先 locale 服务字典，取不到时按 active locale 选中/英静态字典。 */
    function useTranslate(ctx) {
      const [revision, setRevision] = useState(0);
      useEffect(() => {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined;
        return locale.subscribe(() => setRevision((value) => value + 1));
      }, [ctx]);
      // revision 参与重渲染：字典晚到或切语言时本组件要重新取词。
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
      let active = '';
      let bound = null;
      if (locale !== undefined) {
        try {
          active = String(locale.getLocale().active || '');
        } catch { /* 快照读失败不致命 */ }
        try {
          bound = locale.bind(NS);
        } catch { /* 未注册命名空间时退回静态字典 */ }
      }
      const zh = active === '' || /^zh/i.test(active);
      const translate = (key) => {
        if (typeof bound === 'function') {
          try {
            const translated = bound(key);
            if (typeof translated === 'string' && translated !== key) return translated;
          } catch { /* 字典异常不阻塞渲染，落到静态字典 */ }
        }
        const dict = zh ? ZH : EN;
        return dict[key] !== undefined ? dict[key] : key;
      };
      // 引用必须稳定：调用方（load 的 useCallback / effect 依赖）拿它当依赖项，
      // 每次渲染新建函数会让「首次加载」effect 无限重跑。revision 参与 memo 键，
      // 切语言或字典晚到时仍会换掉这个引用。
      return useMemo(() => translate, [active, bound, zh, revision]);
    }

    function draftOf(snapshot) {
      const all = Array.isArray(snapshot.tools) ? snapshot.tools.map((tool) => tool.name) : [];
      const enabled = snapshot.state.mode === 'all' ? all : (Array.isArray(snapshot.state.enabled) ? snapshot.state.enabled : []);
      return { master: snapshot.state.masterEnabled !== false, enabled: new Set(enabled) };
    }

    function ReaToolsPage(props) {
      const ctx = props.ctx;
      const t = useTranslate(ctx);
      const [snapshot, setSnapshot] = useState(null);
      const [draft, setDraft] = useState(null);
      const [phase, setPhase] = useState('loading');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [search, setSearch] = useState('');
      const [saving, setSaving] = useState(false);

      const load = useCallback(async (announce) => {
        setPhase((current) => (current === 'ready' ? 'ready' : 'loading'));
        setError('');
        try {
          const payload = await api(ROUTE_STATE, { headers: { accept: 'application/json' } });
          setSnapshot(payload);
          setDraft(draftOf(payload));
          setPhase('ready');
          if (announce === true) setNotice(t('saved'));
        } catch (cause) {
          setError(`${t('loadFailed')}：${String(cause && cause.message ? cause.message : cause)}`);
          setPhase('error');
        }
      }, [t]);

      useEffect(() => { void load(false); }, [load]);

      const tools = snapshot && Array.isArray(snapshot.tools) ? snapshot.tools : [];
      const total = tools.length;
      const dirty = useMemo(() => {
        if (snapshot === null || draft === null) return false;
        const base = draftOf(snapshot);
        if (base.master !== draft.master) return true;
        if (base.enabled.size !== draft.enabled.size) return true;
        for (const name of base.enabled) if (!draft.enabled.has(name)) return true;
        return false;
      }, [snapshot, draft]);

      const groups = useMemo(() => {
        if (snapshot === null || !Array.isArray(snapshot.groups)) return [];
        const term = search.trim().toLowerCase();
        const byGroup = new Map();
        for (const tool of tools) {
          const hit = term === '' || tool.name.toLowerCase().includes(term) || (tool.description || '').toLowerCase().includes(term);
          if (!hit) continue;
          const entry = byGroup.get(tool.group) ?? { key: tool.group, label: tool.groupLabel, tools: [] };
          entry.tools.push(tool);
          byGroup.set(tool.group, entry);
        }
        const order = new Map(snapshot.groups.map((group, index) => [group.key, index]));
        return [...byGroup.values()].sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
      }, [snapshot, tools, search]);

      const enabledCount = useMemo(() => {
        if (draft === null) return 0;
        if (draft.master !== true) return 0;
        let count = 0;
        for (const tool of tools) if (draft.enabled.has(tool.name)) count += 1;
        return count;
      }, [draft, tools]);

      const enabledBytes = useMemo(() => {
        if (draft === null || draft.master !== true) return 0;
        let bytes = 0;
        for (const tool of tools) if (draft.enabled.has(tool.name)) bytes += tool.bytes || 0;
        return bytes;
      }, [draft, tools]);

      const toggleTool = (name) => {
        setNotice('');
        setDraft((current) => {
          if (current === null) return current;
          const enabled = new Set(current.enabled);
          if (enabled.has(name)) enabled.delete(name);
          else enabled.add(name);
          return { ...current, enabled };
        });
      };

      const applyPreset = (preset) => {
        setNotice('');
        setDraft((current) => (current === null ? current : { ...current, master: true, enabled: new Set(preset.names) }));
      };

      const toggleGroup = (group, on) => {
        setNotice('');
        setDraft((current) => {
          if (current === null) return current;
          const enabled = new Set(current.enabled);
          for (const tool of group.tools) {
            if (on) enabled.add(tool.name);
            else enabled.delete(tool.name);
          }
          return { ...current, enabled };
        });
      };

      const save = async () => {
        if (draft === null || total === 0) return;
        setSaving(true);
        setError('');
        setNotice('');
        try {
          const payload = await api(ROUTE_SAVE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              masterEnabled: draft.master,
              mode: draft.enabled.size >= total ? 'all' : 'custom',
              enabled: [...draft.enabled],
            }),
          });
          setSnapshot(payload);
          setDraft(draftOf(payload));
          setNotice(t('saved'));
        } catch (cause) {
          setError(`${t('saveFailed')}：${String(cause && cause.message ? cause.message : cause)}`);
        } finally {
          setSaving(false);
        }
      };

      const reset = async () => {
        setSaving(true);
        setError('');
        setNotice('');
        try {
          const payload = await api(ROUTE_RESET, { method: 'POST' });
          setSnapshot(payload);
          setDraft(draftOf(payload));
          setNotice(t('saved'));
        } catch (cause) {
          setError(`${t('saveFailed')}：${String(cause && cause.message ? cause.message : cause)}`);
        } finally {
          setSaving(false);
        }
      };

      const stats = snapshot && snapshot.stats ? snapshot.stats : null;
      const server = snapshot && snapshot.server ? snapshot.server : null;
      const connected = server !== null && server.connected === true;
      const issues = snapshot && Array.isArray(snapshot.issues) ? snapshot.issues.filter((issue) => typeof issue === 'string') : [];
      const notes = server !== null && Array.isArray(server.notes) ? server.notes.filter((item) => typeof item === 'string') : [];

      const header = h('div', { className: 'rea-head' },
        h('div', { className: 'rea-title' }, t('title')),
        h('span', { className: connected ? 'rea-badge on' : 'rea-badge warn' }, connected ? t('connected') : t('disconnected')),
        dirty ? h('span', { className: 'rea-badge warn' }, t('dirty')) : null,
      );

      const summary = stats === null ? null : h('div', { className: 'rea-stat' },
        h('span', null, t('enabled'), ' ', h('b', null, String(draft && draft.master === true ? enabledCount : 0)), ' / ', String(stats.total), ' ', t('total')),
        ' · ', t('bytes'), ' ', h('b', null, formatBytes(draft && draft.master === true ? enabledBytes : 0)),
        ' · ', t('allBytes'), ' ', formatBytes(stats.allSchemaBytes),
      );

      const master = h('div', { className: 'rea-card' },
        h('div', { className: 'rea-row' },
          h('button', {
            type: 'button',
            className: 'rea-switch',
            role: 'switch',
            'aria-checked': draft !== null && draft.master === true ? 'true' : 'false',
            'aria-label': t('master'),
            disabled: draft === null || saving,
            onClick: () => {
              setNotice('');
              setDraft((current) => (current === null ? current : { ...current, master: current.master !== true }));
            },
          }, h('i', null)),
          h('div', { className: 'rea-grow' },
            h('div', null, t('master')),
            draft !== null && draft.master !== true ? h('div', { className: 'rea-note' }, t('masterOff')) : null,
          ),
          h('button', {
            type: 'button',
            className: 'rea-btn',
            disabled: saving || phase !== 'ready',
            onClick: () => { void reset(); },
          }, t('reset')),
          h('button', {
            type: 'button',
            className: 'rea-btn primary',
            disabled: saving || phase !== 'ready' || total === 0 || !dirty,
            onClick: () => { void save(); },
          }, saving ? t('saving') : t('save')),
        ),
        summary,
      );

      const toolbar = h('div', { className: 'rea-row' },
        h('input', {
          className: 'rea-input',
          type: 'search',
          placeholder: t('search'),
          value: search,
          onChange: (event) => setSearch(event.target.value),
          'aria-label': t('search'),
        }),
        ...(snapshot && Array.isArray(snapshot.presets)
          ? snapshot.presets.map((preset) => h('button', {
            key: preset.id,
            type: 'button',
            className: 'rea-btn',
            disabled: phase !== 'ready' || saving,
            onClick: () => applyPreset(preset),
          }, preset.label))
          : []),
        h('button', {
          type: 'button',
          className: 'rea-btn',
          disabled: phase !== 'ready' || saving,
          onClick: () => { void load(false); },
        }, t('refresh')),
      );

      const list = phase === 'loading'
        ? h('div', { className: 'rea-empty' }, t('loading'))
        : phase === 'error'
          ? h('div', { className: 'rea-empty' },
            h('div', { className: 'rea-error' }, error),
            h('button', { type: 'button', className: 'rea-btn', onClick: () => { void load(false); } }, t('retry')),
          )
          : total === 0
            ? h('div', { className: 'rea-empty' }, t('noTools'))
            : groups.length === 0
              ? h('div', { className: 'rea-empty' }, t('noMatch'))
              : h('div', { className: 'rea-list' }, ...groups.map((group) => {
                const picked = group.tools.filter((tool) => draft !== null && draft.enabled.has(tool.name)).length;
                return h('details', {
                  key: group.key,
                  className: 'rea-group',
                  open: search.trim() !== '' || undefined,
                },
                h('summary', null,
                  h('span', { className: 'rea-grow' }, group.label),
                  h('span', { className: 'rea-count' }, `${picked}/${group.tools.length}`),
                  h('button', {
                    type: 'button',
                    className: 'rea-btn',
                    onClick: (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleGroup(group, picked < group.tools.length);
                    },
                  }, t('groupCore')),
                ),
                h('div', { className: 'rea-tools' }, ...group.tools.map((tool) => h('label', {
                  key: tool.name,
                  className: 'rea-tool',
                },
                h('input', {
                  type: 'checkbox',
                  checked: draft !== null && draft.enabled.has(tool.name),
                  disabled: draft === null || saving,
                  onChange: () => toggleTool(tool.name),
                }),
                h('div', null,
                  h('div', { className: 'rea-name' }, tool.raw),
                  tool.description !== '' ? h('div', { className: 'rea-tool-desc' }, tool.description) : null,
                ),
                ))),
                );
              }));

      return h(React.Fragment, null,
        h('style', { key: 'rea-style' }, CSS),
        h('div', { className: 'rea-page' },
          header,
          h('div', { className: 'rea-desc' }, t('desc')),
          phase !== 'ready' ? null : master,
          toolbar,
          list,
          notice !== '' ? h('div', { className: 'rea-ok' }, notice) : null,
          error !== '' && phase === 'ready' ? h('div', { className: 'rea-error' }, error) : null,
          issues.length > 0 ? h('div', { className: 'rea-warn' }, issues.join('；')) : null,
          notes.length > 0 ? h('div', { className: 'rea-warn' }, `宿主诊断：${notes.join('；')}`) : null,
          h('div', { className: 'rea-note' }, t('hint')),
        ),
      );
    }

    const inject = ['slots'];

    let pluginCtx = null;

    /** 导航标题：槽位的 label 可以是 thunk，每次投影重读，跟随当前语言。 */
    function sectionLabel(ctx) {
      try {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        if (locale !== undefined) {
          const active = String(locale.getLocale().active || '');
          if (active !== '' && !/^zh/i.test(active)) return EN.section;
        }
      } catch { /* 读不到语言快照就用中文 */ }
      return ZH.section;
    }

    function apply(ctx) {
      pluginCtx = ctx;
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'rea-tools', order: 45, label: () => sectionLabel(ctx) },
        () => h(ReaToolsPage, { ctx: pluginCtx }),
      ));
    }

    const exports = { inject, apply, __ui: { Page: ReaToolsPage, ZH, EN, formatBytes, draftOf, sectionLabel } };
    return exports;
  },
});
