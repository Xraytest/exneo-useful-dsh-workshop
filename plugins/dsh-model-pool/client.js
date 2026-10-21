/**
 * 会话级模型供应池（dsh-model-pool）— 浏览器半边。
 *
 * 在每个会话的头部工具区（conversation.session.header.utilities，scope:
 * session）放一个「供应池」按钮，点开浮动面板：
 *   - 未启用：编辑层级（provider/model 建议来自 remote.session.modelCatalog，
 *     可增删排序；限额按成功请求数或混合 token 总数）→「启用」；
 *   - 已启用：各级用量进度条 + 当前层级徽标，就地调整任一级上限（保留
 *     计数）、切换辅助调用统计、重置全部计数、二次确认停用。
 * 面板打开时每 3s 轮询本会话状态（本地 HTTP，不涉及模型请求）；数量按
 * 中文习惯缩写（万/亿）。所有操作以 props.sessionId 为键，会话间严格
 * 隔离；host 路由见 ./index.js。
 *
 * @module dsh-model-pool/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-pool',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    const MAX_LEVELS = 8;

    const PAGE_CSS = [
      // ---- header button ----
      '.mpool-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 8px; padding: 4px 10px; font-size: 12px; line-height: 1.4; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: border-color .12s, color .12s; }',
      '.mpool-btn:hover, .mpool-btn[data-open="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }',
      '.mpool-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--dsw-alias-border-l2); flex-shrink: 0; transition: background .2s; }',
      '.mpool-dot.on { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent); }',
      '.mpool-dot.dead { background: var(--dsw-alias-state-error-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); }',
      // ---- floating panel ----
      // 层级必须压过 DSH 壳层的最高浮层（模态 z-index 1100）——portal 到
      // body 后若低于壳层表面，面板会被应用层盖住（挂载了但看不见）。
      // 关闭不用全屏 backdrop（会吞点击），用「点外关闭」监听。
      '.mpool-panel { position: fixed; z-index: 3001; width: min(520px, calc(100vw - 20px)); overflow-y: auto; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; box-shadow: 0 16px 48px rgba(0,0,0,.30), 0 2px 8px rgba(0,0,0,.18); padding: 14px 16px 14px; display: flex; flex-direction: column; gap: 10px; color: var(--dsw-alias-label-primary); font-size: 12px; animation: mpool-pop .14s ease-out; }',
      '@keyframes mpool-pop { from { opacity: 0; transform: translateY(-5px) scale(.985); } to { opacity: 1; transform: none; } }',
      '.mpool-head { display: flex; align-items: center; gap: 8px; }',
      '.mpool-title { font-size: 13px; font-weight: 600; }',
      '.mpool-state { font-size: 10px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }',
      '.mpool-state.on { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }',
      '.mpool-state.dead { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }',
      '.mpool-sid { margin-left: auto; font-size: 10px; color: var(--dsw-alias-label-secondary); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }',
      '.mpool-desc { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }',
      // ---- level cards ----
      '.mpool-level { display: flex; flex-direction: column; gap: 7px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 9px 11px; }',
      '.mpool-level.active { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 5%, var(--dsw-alias-bg-layer-1)); }',
      '.mpool-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.mpool-label { color: var(--dsw-alias-label-secondary); flex-shrink: 0; }',
      '.mpool-chip { font-size: 10px; font-weight: 600; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; padding: 1px 6px; color: var(--dsw-alias-label-secondary); flex-shrink: 0; }',
      '.mpool-chip.now { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }',
      '.mpool-chip.dead { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }',
      '.mpool-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 230px; }',
      '.mpool-input { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 8px; font-size: 12px; min-width: 0; }',
      '.mpool-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
      '.mpool-provider { width: 108px; }',
      '.mpool-model { flex: 1; min-width: 110px; }',
      '.mpool-num { width: 88px; font-variant-numeric: tabular-nums; }',
      '.mpool-btn2 { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; flex-shrink: 0; transition: border-color .12s, background .12s, color .12s; }',
      '.mpool-btn2:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }',
      '.mpool-btn2:disabled { opacity: .45; cursor: default; }',
      '.mpool-mini { padding: 2px 7px; font-size: 11px; line-height: 1.3; }',
      '.mpool-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }',
      '.mpool-primary:hover:not(:disabled) { filter: brightness(1.08); border-color: var(--dsw-alias-brand-primary); }',
      '.mpool-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }',
      '.mpool-armed { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-bg-base); }',
      // ---- usage bar ----
      '.mpool-bar { position: relative; height: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; flex: 1; min-width: 60px; }',
      '.mpool-fill { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width .35s ease; }',
      '.mpool-fill.warn { background: var(--dsw-alias-state-warn-primary); }',
      '.mpool-fill.full { background: var(--dsw-alias-state-error-primary); }',
      '.mpool-used { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; flex-shrink: 0; }',
      '.mpool-tag { font-size: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; padding: 0 5px; color: var(--dsw-alias-label-secondary); }',
      '.mpool-error { color: var(--dsw-alias-state-error-primary); }',
      '.mpool-muted { color: var(--dsw-alias-label-secondary); }',
      '.mpool-checks { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-secondary); cursor: pointer; user-select: none; }',
      '.mpool-foot { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--dsw-alias-label-secondary); padding-top: 2px; }',
      '.mpool-spacer { flex: 1; }',
    ].join('\n');

    const BOOT_CSS_ID = 'dsh-model-pool/page.css';
    function injectStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css="' + BOOT_CSS_ID + '"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-model-pool';
      tag.dataset.pluginCss = BOOT_CSS_ID;
      tag.textContent = PAGE_CSS;
      (document.head || document.documentElement).appendChild(tag);
    }

    const errorText = (error) => String(error && error.message ? error.message : error);

    /** Compact Chinese number style: 128000 → 12.8万, 120000000 → 1.2亿. */
    function fmtNum(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
      const abs = Math.abs(n);
      const trim = (s) => s.replace(/\.0$/, '');
      if (abs >= 1e8) return trim((n / 1e8).toFixed(1)) + '亿';
      if (abs >= 1e4) return trim((n / 1e4).toFixed(1)) + '万';
      return String(n);
    }

    async function api(path, options) {
      const response = await fetch(path, options);
      let body = null;
      try {
        body = await response.json();
      } catch {
        /* 非 JSON 响应体：落到状态码分支 */
      }
      if (!response.ok) {
        throw new Error((body && body.error) || (response.status + ' ' + response.statusText));
      }
      return body;
    }
    const postJson = (path, payload) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const emptyDraftRow = () => ({ provider: '', model: '', kind: 'requests', value: '' });

    /** One editable level row inside the draft editor (add/reorder/remove).
     *  provider/model 用下拉列出模型目录里的可用项；目录未就绪或选项
     *  不含当前值（如目录加载失败）时退回手动输入框。 */
    function DraftRow(props) {
      const { row, index, total, providerGroups, modelsOf, onChange, onRemove, onMove } = props;
      const set = (patch) => onChange(index, patch);
      const models = modelsOf(row.provider);
      const providerKnown = providerGroups.some((g) => g.id === row.provider);
      const modelKnown = models.some((m) => m.id === row.model);
      const labelOf = (id, name) => (name && name !== id ? name + '（' + id + '）' : id);

      let providerControl;
      if (providerGroups.length > 0) {
        providerControl = h('select', {
          className: 'mpool-input mpool-provider', value: row.provider,
          onChange: (e) => {
            const provider = e.target.value;
            const keepModel = modelsOf(provider).some((m) => m.id === row.model);
            set(keepModel ? { provider } : { provider, model: '' });
          },
        },
          h('option', { value: '' }, row.provider === '' ? '选择 provider…' : row.provider),
          row.provider !== '' && !providerKnown ? h('option', { value: row.provider }, row.provider + '（目录外）') : null,
          providerGroups.map((g) => h('option', { key: g.id, value: g.id }, labelOf(g.id, g.name))),
        );
      } else {
        providerControl = h('input', {
          className: 'mpool-input mpool-provider', placeholder: 'provider（目录不可用，手动输入）',
          value: row.provider, onChange: (e) => set({ provider: e.target.value }),
        });
      }

      let modelControl;
      if (models.length > 0) {
        modelControl = h('select', {
          className: 'mpool-input mpool-model', value: row.model,
          disabled: row.provider === '',
          onChange: (e) => set({ model: e.target.value }),
        },
          h('option', { value: '' }, row.provider === '' ? '先选 provider' : (row.model === '' ? '选择 model…' : row.model)),
          row.model !== '' && !modelKnown ? h('option', { value: row.model }, row.model + '（目录外）') : null,
          models.map((m) => h('option', { key: m.id, value: m.id }, labelOf(m.id, m.name))),
        );
      } else {
        modelControl = h('input', {
          className: 'mpool-input mpool-model', placeholder: row.provider === '' ? 'model' : 'model（该 provider 无目录，手动输入）',
          value: row.model, onChange: (e) => set({ model: e.target.value }),
        });
      }

      return h('div', { className: 'mpool-level' },
        h('div', { className: 'mpool-row' },
          h('span', { className: 'mpool-chip' }, 'L' + (index + 1)),
          providerControl,
          modelControl,
          total > 1 ? h('button', {
            className: 'mpool-btn2 mpool-mini', disabled: index === 0, title: '上移（优先级更高）',
            onClick: () => onMove(index, -1),
          }, '↑') : null,
          total > 1 ? h('button', {
            className: 'mpool-btn2 mpool-mini', disabled: index === total - 1, title: '下移',
            onClick: () => onMove(index, 1),
          }, '↓') : null,
          total > 1 ? h('button', {
            className: 'mpool-btn2 mpool-mini mpool-danger', title: '移除该层级',
            onClick: () => onRemove(index),
          }, '✕') : null,
        ),
        h('div', { className: 'mpool-row' },
          h('select', {
            className: 'mpool-input', value: row.kind,
            onChange: (e) => set({ kind: e.target.value }),
          },
            h('option', { value: 'requests' }, '按成功请求数'),
            h('option', { value: 'tokens' }, '按混合 token 总数'),
          ),
          h('input', {
            className: 'mpool-input mpool-num', type: 'number', min: 1, step: 1, placeholder: '限额',
            value: row.value, onChange: (e) => set({ value: e.target.value }),
          }),
          h('span', { className: 'mpool-used' }, row.kind === 'tokens' ? 'tokens' : '次'),
        ),
      );
    }

    /** One configured level: usage bar + live usage + in-place limit editor. */
    function LiveRow(props) {
      const { level, index, active, onAdjust, busy } = props;
      const [kind, setKind] = React.useState(level.kind);
      const [value, setValue] = React.useState(String(level.limit));
      React.useEffect(() => {
        setKind(level.kind);
        setValue(String(level.limit));
      }, [level.kind, level.limit]);
      const num = Number(value);
      const dirty = kind !== level.kind || (Number.isFinite(num) && num !== level.limit);
      const usedNow = kind === 'tokens' ? level.used.tokens : level.used.requests;
      const ratio = level.limit > 0 ? Math.min(1, usedNow / level.limit) : 0;
      const fillClass = ratio >= 1 || level.exhausted ? 'mpool-fill full' : (ratio >= 0.8 ? 'mpool-fill warn' : 'mpool-fill');
      return h('div', { className: 'mpool-level' + (active ? ' active' : '') },
        h('div', { className: 'mpool-row' },
          h('span', { className: 'mpool-chip' + (active ? ' now' : '') }, 'L' + (index + 1)),
          h('span', { className: 'mpool-name', title: level.provider + ':' + level.model }, level.provider + ':' + level.model),
          active ? h('span', { className: 'mpool-chip now' }, '当前') : null,
          level.exhausted ? h('span', { className: 'mpool-chip dead' }, '已耗尽') : null,
          h('span', { className: 'mpool-spacer' }),
          h('span', { className: 'mpool-used' },
            fmtNum(usedNow) + ' / ' + fmtNum(level.limit) + (kind === 'tokens' ? ' tokens' : ' 次'),
          ),
        ),
        h('div', { className: 'mpool-bar', role: 'progressbar', 'aria-valuenow': Math.round(ratio * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('div', { className: fillClass, style: { width: Math.round(ratio * 100) + '%' } }),
        ),
        h('div', { className: 'mpool-row' },
          h('span', { className: 'mpool-label' }, '上限'),
          h('select', {
            className: 'mpool-input', value: kind,
            onChange: (e) => setKind(e.target.value),
          },
            h('option', { value: 'requests' }, '请求数'),
            h('option', { value: 'tokens' }, 'tokens'),
          ),
          h('input', {
            className: 'mpool-input mpool-num', type: 'number', min: 1, step: 1, value,
            onChange: (e) => setValue(e.target.value),
          }),
          h('button', {
            className: 'mpool-btn2 mpool-primary mpool-mini', disabled: !dirty || busy || !isFinite(Number(value)) || Number(value) < 1,
            onClick: () => onAdjust(index, kind, Number(value)),
            title: '调整该级用量上限（保留现有计数）',
          }, '应用'),
        ),
      );
    }

    /**
     * apply 期持有的插件 ctx（slots/remote 经闭包取用）。槽位内容按出厂
     * 占用者（open-in-app）的形式直接传组件，合并 props 里带 sessionId。
     */
    let pluginCtx = undefined;

    function ModelPoolControl(props) {
      const ctx = pluginCtx;
      const { sessionId } = props;
      const [open, setOpen] = React.useState(false);
      const [btnRect, setBtnRect] = React.useState(null);
      const [pool, setPool] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [draft, setDraft] = React.useState([emptyDraftRow()]);
      const [draftAux, setDraftAux] = React.useState(false);
      const [armed, setArmed] = React.useState(false);
      const [catalog, setCatalog] = React.useState(null);
      const btnRef = React.useRef(null);
      const panelRef = React.useRef(null);

      const configured = pool !== null && pool.configured === true;

      const refresh = React.useCallback(() => {
        if (sessionId === undefined || sessionId === '') return;
        api('/dsh-model-pool/status?sessionId=' + encodeURIComponent(sessionId))
          .then((value) => setPool(value.pool || null))
          .catch((reason) => setError(errorText(reason)));
      }, [sessionId]);

      React.useEffect(() => {
        refresh();
        const timer = setInterval(refresh, open ? 3000 : 5000);
        return () => clearInterval(timer);
      }, [refresh, open]);

      React.useEffect(() => {
        if (catalog !== null || ctx === undefined) return;
        let alive = true;
        Promise.resolve(ctx.remote && ctx.remote.session ? ctx.remote.session.modelCatalog() : null)
          .then((response) => {
            if (!alive || response === null || response === undefined) return;
            setCatalog(response.ok === true ? (response.value || {}) : {});
          })
          .catch(() => { if (alive) setCatalog({}); });
        return () => { alive = false; };
      }, [ctx, catalog]);

      // 面板关闭时复位临时状态（编辑草稿、停用确认）。
      React.useEffect(() => {
        if (!open) {
          setArmed(false);
          setError('');
        }
      }, [open]);

      const toggleOpen = () => {
        if (open) {
          setOpen(false);
          return;
        }
        const rect = btnRef.current !== undefined && btnRef.current !== null && typeof btnRef.current.getBoundingClientRect === 'function'
          ? btnRef.current.getBoundingClientRect()
          : null;
        setBtnRect(rect);
        setOpen(true);
      };

      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        // 点外关闭：pointerdown 落在面板与按钮之外即收起（capture 阶段，
        // composedPath 兼容 shadow DOM；面板/按钮内部的点击不受影响）。
        const onPointerDown = (event) => {
          const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
          const inPanel = panelRef.current !== null && panelRef.current !== undefined && path.includes(panelRef.current);
          const inButton = btnRef.current !== null && btnRef.current !== undefined && path.includes(btnRef.current);
          if (!inPanel && !inButton) setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          window.removeEventListener('keydown', onKey);
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [open]);

      const act = (payload) => {
        setBusy(true);
        setError('');
        return postJson(payload.path, Object.assign({ sessionId }, payload.body || {}))
          .then((value) => {
            if (value !== null && typeof value === 'object' && value.pool) setPool(value.pool);
            else refresh();
          })
          .catch((reason) => setError(errorText(reason)))
          .then(() => setBusy(false));
      };

      const enable = () => {
        const levels = [];
        for (const row of draft) {
          const provider = String(row.provider || '').trim();
          const model = String(row.model || '').trim();
          const value = Number(row.value);
          if (provider === '' && model === '' && row.value === '') continue;
          if (provider === '' || model === '' || !Number.isInteger(value) || value < 1) {
            setError('每个层级都需要 provider、model 和正整数限额');
            return;
          }
          levels.push({ provider, model, kind: row.kind, value });
        }
        if (levels.length === 0) {
          setError('供应池至少需要一级');
          return;
        }
        setBusy(true);
        setError('');
        postJson('/dsh-model-pool/enable', { sessionId, levels, countAuxiliary: draftAux })
          .then((value) => {
            setPool(value.pool || null);
            setDraft([emptyDraftRow()]);
            setDraftAux(false);
          })
          .catch((reason) => setError(errorText(reason)))
          .then(() => setBusy(false));
      };

      const disable = () => {
        if (armed !== true) {
          setArmed(true);
          setTimeout(() => setArmed(false), 3000);
          return;
        }
        setArmed(false);
        act({ path: '/dsh-model-pool/disable' });
      };

      const providerGroups = (catalog !== null && Array.isArray(catalog.groups)) ? catalog.groups : [];
      const modelOptions = (provider) => {
        const group = providerGroups.find((entry) => entry.id === provider);
        return group !== undefined && Array.isArray(group.models) ? group.models : [];
      };

      const moveDraft = (index, dir) => {
        setDraft((rows) => {
          const at = index + dir;
          if (at < 0 || at >= rows.length) return rows;
          const next = rows.slice();
          const tmp = next[index];
          next[index] = next[at];
          next[at] = tmp;
          return next;
        });
      };

      const dotClass = !configured ? 'mpool-dot' : (pool.exhausted === true ? 'mpool-dot dead' : 'mpool-dot on');
      const stateChip = !configured
        ? h('span', { className: 'mpool-state' }, '未启用')
        : (pool.exhausted === true
            ? h('span', { className: 'mpool-state dead' }, '全部耗尽')
            : h('span', { className: 'mpool-state on' }, '运行中 · L' + (pool.activeIndex + 1)));
      const btnTitle = !configured
        ? '为本会话启用模型供应池（只影响当前会话）'
        : '供应池运行中 · 当前 L' + (pool.activeIndex + 1) + ' ' + (pool.levels[pool.activeIndex] ? pool.levels[pool.activeIndex].provider + ':' + pool.levels[pool.activeIndex].model : '');

      // 面板定位：按钮下方展开；下方放不下则压缩 maxHeight，绝不遮出屏。
      const vw = window.innerWidth || 1200;
      const vh = window.innerHeight || 800;
      const top = btnRect !== null ? btnRect.bottom + 8 : 52;
      const maxH = Math.max(200, Math.min(560, vh - top - 12));
      const panelStyle = { top: Math.max(8, top), right: Math.max(10, btnRect !== null ? vw - btnRect.right : 16), maxHeight: maxH + 'px' };

      return h('div', null,
        h('button', { ref: btnRef, className: 'mpool-btn', 'data-open': open ? 'true' : 'false', onClick: toggleOpen, title: btnTitle },
          h('span', { className: dotClass, 'aria-hidden': true }),
          '供应池',
        ),
        // 面板经 portal 渲染到 document.body：会话头部可能带 transform /
        // filter（改变 position:fixed 的包含块并把面板裁剪掉）——portal 到
        // body 后不存在；层级压过壳层最高浮层，关闭走点外监听（无 backdrop）。
        open && sessionId ? ReactDOM.createPortal(
          h('div', { ref: panelRef, className: 'mpool-panel', style: panelStyle, role: 'dialog', 'aria-label': '模型供应池' },
            h('div', { className: 'mpool-head' },
              h('span', { className: 'mpool-title' }, '模型供应池'),
              stateChip,
              h('span', { className: 'mpool-sid', title: sessionId }, sessionId || ''),
            ),
            h('div', { className: 'mpool-desc' },
              '按优先级多级路由：高级别用量耗尽后自动切下一级（token 限额允许末次超量；401/403 与配额/计费类致命错误触发故障转移）。只对当前会话生效，不影响其他会话。'),
            !configured ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              draft.map((row, index) => h(DraftRow, {
                key: index,
                row,
                index,
                total: draft.length,
                providerGroups,
                modelsOf: modelOptions,
                onChange: (at, patch) => setDraft((rows) => rows.map((r, i) => (i === at ? Object.assign({}, r, patch) : r))),
                onRemove: (at) => setDraft((rows) => rows.filter((_, i) => i !== at)),
                onMove: moveDraft,
              })),
              h('div', { className: 'mpool-row' },
                h('button', {
                  className: 'mpool-btn2 mpool-mini',
                  disabled: busy || draft.length >= MAX_LEVELS,
                  onClick: () => setDraft((rows) => rows.concat([emptyDraftRow()])),
                }, '＋ 添加层级'),
                h('label', { className: 'mpool-checks' },
                  h('input', {
                    type: 'checkbox', checked: draftAux,
                    onChange: (e) => setDraftAux(e.target.checked),
                  }),
                  '辅助调用（标题/压缩）计入用量'),
                h('span', { className: 'mpool-spacer' }),
                h('button', { className: 'mpool-btn2 mpool-primary', disabled: busy, onClick: enable }, '启用'),
              ),
            ) : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              (pool.levels || []).map((level, index) => h(LiveRow, {
                key: index,
                level,
                index,
                active: pool.activeIndex === index,
                busy,
                onAdjust: (at, kind, value) => act({ path: '/dsh-model-pool/adjust', body: { index: at, kind, value } }),
              })),
              pool.exhausted === true ? h('div', { className: 'mpool-error' }, '全部层级已耗尽：继续使用最后一级（token 限额允许末次超量）。') : null,
              h('div', { className: 'mpool-row' },
                h('button', {
                  className: 'mpool-btn2', disabled: busy,
                  onClick: () => act({ path: '/dsh-model-pool/reset' }),
                  title: '把所有层级的已用计数清零',
                }, '重置计数'),
                h('button', {
                  className: 'mpool-btn2' + (armed ? ' mpool-danger mpool-armed' : ''),
                  disabled: busy,
                  onClick: disable,
                  title: '移除供应池，会话回到自身模型',
                }, armed ? '确认停用？' : '停用'),
                h('label', { className: 'mpool-checks', title: '立即生效，不影响已计用量' },
                  h('input', {
                    type: 'checkbox', disabled: busy,
                    checked: pool.countAuxiliary === true,
                    onChange: (e) => act({ path: '/dsh-model-pool/adjust', body: { countAuxiliary: e.target.checked } }),
                  }),
                  '辅助调用计入'),
                h('span', { className: 'mpool-spacer' }),
                h('button', { className: 'mpool-btn2 mpool-mini', disabled: busy, onClick: refresh, title: '立即刷新' }, '刷新'),
              ),
            ),
            error !== '' ? h('div', { className: 'mpool-error' }, error) : null,
            h('div', { className: 'mpool-foot' },
              h('span', null, '打开期间每 3 秒自动刷新 · 点面板外或 Esc 关闭'),
            ),
        ), document.body) : null,
      );
    }

    const inject = ['slots', 'remote', 'remote.session'];

    function apply(ctx) {
      pluginCtx = ctx;
      injectStyles();
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
        {
          name: 'conversation.session.header.utilities',
          id: 'model-pool',
          order: 20,
        },
        // 与出厂占用者（open-in-app）一致：内容直接是组件，槽位属主把
        // standardProps（含 sessionId）合并进渲染 props。
        ModelPoolControl,
      ));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
