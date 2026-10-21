/**
 * 会话级子代理模型链（dsh-subagent-models）— 浏览器半边。
 *
 * 会话头部工具区「子代理模型」按钮 + 浮动面板（portal 到 body，层级压过
 * 壳层浮层，点外/Esc 关闭）：
 *   - 未启用：编辑有序候选（provider/model 从模型目录下拉选取；每候选可设
 *     请求数或混合 token 限额，或勾选「不限量」）→「启用」；
 *   - 已启用：逐候选显示用量进度条、当前/已耗尽/已失败标记，就地调整限额
 *     （保留计数并清除失败标记）、重置全部计数与失败、停用；
 *   - 两个开关：辅助调用是否计入本链用量；本链用量是否计入整会话请求池。
 * 所有操作以根会话 id 为键（面板显示当前会话 id），子代理沿血缘自动适用。
 *
 * @module dsh-subagent-models/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-subagent-models',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    const MAX_CANDIDATES = 8;

    const PAGE_CSS = [
      '.sam-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 8px; padding: 4px 10px; font-size: 12px; line-height: 1.4; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: border-color .12s, color .12s; }',
      '.sam-btn:hover, .sam-btn[data-open="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }',
      '.sam-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--dsw-alias-border-l2); flex-shrink: 0; transition: background .2s; }',
      '.sam-dot.on { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent); }',
      '.sam-dot.dead { background: var(--dsw-alias-state-error-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); }',
      '.sam-panel { position: fixed; z-index: 3001; width: min(540px, calc(100vw - 20px)); overflow-y: auto; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; box-shadow: 0 16px 48px rgba(0,0,0,.30), 0 2px 8px rgba(0,0,0,.18); padding: 14px 16px 14px; display: flex; flex-direction: column; gap: 10px; color: var(--dsw-alias-label-primary); font-size: 12px; animation: sam-pop .14s ease-out; }',
      '@keyframes sam-pop { from { opacity: 0; transform: translateY(-5px) scale(.985); } to { opacity: 1; transform: none; } }',
      '.sam-head { display: flex; align-items: center; gap: 8px; }',
      '.sam-title { font-size: 13px; font-weight: 600; }',
      '.sam-state { font-size: 10px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }',
      '.sam-state.on { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }',
      '.sam-state.dead { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }',
      '.sam-sid { margin-left: auto; font-size: 10px; color: var(--dsw-alias-label-secondary); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }',
      '.sam-desc { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }',
      '.sam-cand { display: flex; flex-direction: column; gap: 7px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 9px 11px; }',
      '.sam-cand.active { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 5%, var(--dsw-alias-bg-layer-1)); }',
      '.sam-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.sam-label { color: var(--dsw-alias-label-secondary); flex-shrink: 0; }',
      '.sam-chip { font-size: 10px; font-weight: 600; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; padding: 1px 6px; color: var(--dsw-alias-label-secondary); flex-shrink: 0; }',
      '.sam-chip.now { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }',
      '.sam-chip.dead { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }',
      '.sam-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }',
      '.sam-input { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 8px; font-size: 12px; min-width: 0; }',
      '.sam-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
      '.sam-provider { width: 128px; }',
      '.sam-model { flex: 1; min-width: 120px; }',
      '.sam-num { width: 88px; font-variant-numeric: tabular-nums; }',
      '.sam-btn2 { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; flex-shrink: 0; transition: border-color .12s, background .12s, color .12s; }',
      '.sam-btn2:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }',
      '.sam-btn2:disabled { opacity: .45; cursor: default; }',
      '.sam-mini { padding: 2px 7px; font-size: 11px; line-height: 1.3; }',
      '.sam-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }',
      '.sam-primary:hover:not(:disabled) { filter: brightness(1.08); border-color: var(--dsw-alias-brand-primary); }',
      '.sam-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }',
      '.sam-armed { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-bg-base); }',
      '.sam-bar { position: relative; height: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; flex: 1; min-width: 60px; }',
      '.sam-fill { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width .35s ease; }',
      '.sam-fill.warn { background: var(--dsw-alias-state-warn-primary); }',
      '.sam-fill.full { background: var(--dsw-alias-state-error-primary); }',
      '.sam-fill.inf { background: var(--dsw-alias-label-secondary); opacity: .35; }',
      '.sam-used { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; flex-shrink: 0; }',
      '.sam-checks { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-secondary); cursor: pointer; user-select: none; }',
      '.sam-error { color: var(--dsw-alias-state-error-primary); }',
      '.sam-foot { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--dsw-alias-label-secondary); padding-top: 2px; }',
      '.sam-spacer { flex: 1; }',
    ].join('\n');

    const BOOT_CSS_ID = 'dsh-subagent-models/page.css';
    function injectStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css="' + BOOT_CSS_ID + '"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-subagent-models';
      tag.dataset.pluginCss = BOOT_CSS_ID;
      tag.textContent = PAGE_CSS;
      (document.head || document.documentElement).appendChild(tag);
    }

    const errorText = (error) => String(error && error.message ? error.message : error);

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
      if (!response.ok) throw new Error((body && body.error) || (response.status + ' ' + response.statusText));
      return body;
    }
    const postJson = (path, payload) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const emptyDraft = () => ({ provider: '', model: '', unlimited: false, kind: 'requests', value: '' });

    /** 未启用态：有序候选编辑器。 */
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
          className: 'sam-input sam-provider', value: row.provider,
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
          className: 'sam-input sam-provider', placeholder: 'provider（目录不可用，手动输入）',
          value: row.provider, onChange: (e) => set({ provider: e.target.value }),
        });
      }

      let modelControl;
      if (models.length > 0) {
        modelControl = h('select', {
          className: 'sam-input sam-model', value: row.model,
          disabled: row.provider === '',
          onChange: (e) => set({ model: e.target.value }),
        },
          h('option', { value: '' }, row.provider === '' ? '先选 provider' : (row.model === '' ? '选择 model…' : row.model)),
          row.model !== '' && !modelKnown ? h('option', { value: row.model }, row.model + '（目录外）') : null,
          models.map((m) => h('option', { key: m.id, value: m.id }, labelOf(m.id, m.name))),
        );
      } else {
        modelControl = h('input', {
          className: 'sam-input sam-model', placeholder: row.provider === '' ? 'model' : 'model（该 provider 无目录，手动输入）',
          value: row.model, onChange: (e) => set({ model: e.target.value }),
        });
      }

      return h('div', { className: 'sam-cand' },
        h('div', { className: 'sam-row' },
          h('span', { className: 'sam-chip' }, 'C' + (index + 1)),
          providerControl,
          modelControl,
          total > 1 ? h('button', {
            className: 'sam-btn2 sam-mini', disabled: index === 0, title: '上移（优先级更高）',
            onClick: () => onMove(index, -1),
          }, '↑') : null,
          total > 1 ? h('button', {
            className: 'sam-btn2 sam-mini', disabled: index === total - 1, title: '下移',
            onClick: () => onMove(index, 1),
          }, '↓') : null,
          total > 1 ? h('button', {
            className: 'sam-btn2 sam-mini sam-danger', title: '移除该候选',
            onClick: () => onRemove(index),
          }, '✕') : null,
        ),
        h('div', { className: 'sam-row' },
          h('label', { className: 'sam-checks' },
            h('input', {
              type: 'checkbox', checked: row.unlimited,
              onChange: (e) => set({ unlimited: e.target.checked }),
            }),
            '不限量'),
          row.unlimited ? null : h('select', {
            className: 'sam-input', value: row.kind,
            onChange: (e) => set({ kind: e.target.value }),
          },
            h('option', { value: 'requests' }, '按成功请求数'),
            h('option', { value: 'tokens' }, '按混合 token 总数'),
          ),
          row.unlimited ? null : h('input', {
            className: 'sam-input sam-num', type: 'number', min: 1, step: 1, placeholder: '限额',
            value: row.value, onChange: (e) => set({ value: e.target.value }),
          }),
          row.unlimited ? null : h('span', { className: 'sam-used' }, row.kind === 'tokens' ? 'tokens' : '次'),
        ),
      );
    }

    /** 已启用态：用量 + 就地调限。 */
    function LiveRow(props) {
      const { candidate, index, active, busy, onAdjust, onUnlimited } = props;
      const [kind, setKind] = React.useState(candidate.unlimited ? 'requests' : candidate.kind);
      const [value, setValue] = React.useState(candidate.unlimited ? '' : String(candidate.limit));
      React.useEffect(() => {
        setKind(candidate.unlimited ? 'requests' : candidate.kind);
        setValue(candidate.unlimited ? '' : String(candidate.limit));
      }, [candidate.unlimited, candidate.kind, candidate.limit]);
      const num = Number(value);
      const dirty = candidate.unlimited !== true && (kind !== candidate.kind || (Number.isFinite(num) && num !== candidate.limit));
      const usedNow = kind === 'tokens' ? candidate.used.tokens : candidate.used.requests;
      const ratio = candidate.unlimited ? 0 : Math.min(1, candidate.limit > 0 ? usedNow / candidate.limit : 0);
      const fillClass = candidate.unlimited ? 'sam-fill inf' : (ratio >= 1 || candidate.exhausted ? 'sam-fill full' : (ratio >= 0.8 ? 'sam-fill warn' : 'sam-fill'));
      const usedText = candidate.unlimited
        ? fmtNum(usedNow) + (kind === 'tokens' ? ' tokens（不限）' : ' 次（不限）')
        : fmtNum(usedNow) + ' / ' + fmtNum(candidate.limit) + (kind === 'tokens' ? ' tokens' : ' 次');
      return h('div', { className: 'sam-cand' + (active ? ' active' : '') },
        h('div', { className: 'sam-row' },
          h('span', { className: 'sam-chip' + (active ? ' now' : '') }, 'C' + (index + 1)),
          h('span', { className: 'sam-name', title: candidate.provider + ':' + candidate.model }, candidate.provider + ':' + candidate.model),
          active ? h('span', { className: 'sam-chip now' }, '当前') : null,
          candidate.failed ? h('span', { className: 'sam-chip dead' }, '已失败') : (candidate.exhausted ? h('span', { className: 'sam-chip dead' }, '已耗尽') : null),
          h('span', { className: 'sam-spacer' }),
          h('span', { className: 'sam-used' }, usedText),
        ),
        h('div', { className: 'sam-bar', role: 'progressbar', 'aria-valuenow': Math.round(ratio * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('div', { className: fillClass, style: { width: candidate.unlimited ? '100%' : Math.round(ratio * 100) + '%' } }),
        ),
        h('div', { className: 'sam-row' },
          h('span', { className: 'sam-label' }, '限额'),
          h('label', { className: 'sam-checks', title: '不限量：该候选不会被用量耗尽，仅在请求失败时回退' },
            h('input', {
              type: 'checkbox', disabled: busy, checked: candidate.unlimited,
              onChange: (e) => onUnlimited(index, e.target.checked),
            }),
            '不限量'),
          candidate.unlimited ? null : h('select', {
            className: 'sam-input', value: kind, disabled: busy,
            onChange: (e) => setKind(e.target.value),
          },
            h('option', { value: 'requests' }, '请求数'),
            h('option', { value: 'tokens' }, 'tokens'),
          ),
          candidate.unlimited ? null : h('input', {
            className: 'sam-input sam-num', type: 'number', min: 1, step: 1, value, disabled: busy,
            onChange: (e) => setValue(e.target.value),
          }),
          candidate.unlimited ? null : h('button', {
            className: 'sam-btn2 sam-primary sam-mini', disabled: !dirty || busy || !Number.isFinite(num) || num < 1,
            onClick: () => onAdjust(index, kind, Number(num)),
            title: '调整该候选用量上限（保留现有计数并清除失败标记）',
          }, '应用'),
        ),
      );
    }

    let pluginCtx = undefined;

    function SubagentModelsControl(props) {
      const ctx = pluginCtx;
      const { sessionId } = props;
      const [open, setOpen] = React.useState(false);
      const [btnRect, setBtnRect] = React.useState(null);
      const [chain, setChain] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [draft, setDraft] = React.useState([emptyDraft()]);
      const [draftAux, setDraftAux] = React.useState(false);
      const [draftPool, setDraftPool] = React.useState(false);
      const [armed, setArmed] = React.useState(false);
      const [catalog, setCatalog] = React.useState(null);
      const btnRef = React.useRef(null);
      const panelRef = React.useRef(null);

      const configured = chain !== null && chain.configured === true;

      const refresh = React.useCallback(() => {
        if (sessionId === undefined || sessionId === '') return;
        api('/dsh-subagent-models/status?sessionId=' + encodeURIComponent(sessionId))
          .then((value) => setChain(value.chain || null))
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
        const rect = btnRef.current !== null && btnRef.current !== undefined && typeof btnRef.current.getBoundingClientRect === 'function'
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
            if (value !== null && typeof value === 'object' && value.chain) setChain(value.chain);
            else refresh();
          })
          .catch((reason) => setError(errorText(reason)))
          .then(() => setBusy(false));
      };

      const enable = () => {
        const candidates = [];
        for (const row of draft) {
          const provider = String(row.provider || '').trim();
          const model = String(row.model || '').trim();
          const value = Number(row.value);
          if (provider === '' && model === '' && row.value === '' && row.unlimited !== true) continue;
          if (provider === '' || model === '') {
            setError('每个候选都需要 provider 和 model');
            return;
          }
          if (row.unlimited !== true && (!Number.isInteger(value) || value < 1)) {
            setError('未勾选「不限量」的候选需要正整数限额');
            return;
          }
          candidates.push(row.unlimited === true
            ? { provider, model }
            : { provider, model, limit: { kind: row.kind, value } });
        }
        if (candidates.length === 0) {
          setError('子代理模型链至少需要一个候选');
          return;
        }
        setBusy(true);
        setError('');
        postJson('/dsh-subagent-models/enable', { sessionId, candidates, countAuxiliary: draftAux, countTowardPool: draftPool })
          .then((value) => {
            setChain(value.chain || null);
            setDraft([emptyDraft()]);
            setDraftAux(false);
            setDraftPool(false);
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
        act({ path: '/dsh-subagent-models/disable' });
      };

      const providerGroups = (catalog !== null && Array.isArray(catalog.groups)) ? catalog.groups : [];
      const modelOptions = (provider) => {
        if (typeof provider !== 'string' || provider === '' || provider === '*') return [];
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

      const activeCandidate = configured && chain.activeIndex >= 0 ? chain.candidates[chain.activeIndex] : null;
      const dotClass = !configured ? 'sam-dot' : (chain.exhausted === true ? 'sam-dot dead' : 'sam-dot on');
      const stateChip = !configured
        ? h('span', { className: 'sam-state' }, '未启用')
        : (chain.exhausted === true
            ? h('span', { className: 'sam-state dead' }, '全部不可用')
            : h('span', { className: 'sam-state on' }, '启用中 · C' + (chain.activeIndex + 1)));
      const btnTitle = !configured
        ? '为本会话指定子代理可用模型链（只影响本会话的子代理）'
        : '子代理模型链启用中 · 当前候选 C' + (chain.activeIndex + 1) + (activeCandidate ? ' ' + activeCandidate.provider + ':' + activeCandidate.model : '');

      const vw = window.innerWidth || 1200;
      const vh = window.innerHeight || 800;
      const top = btnRect !== null ? btnRect.bottom + 8 : 52;
      const maxH = Math.max(200, Math.min(600, vh - top - 12));
      const panelStyle = { top: Math.max(8, top), right: Math.max(10, btnRect !== null ? vw - btnRect.right : 16), maxHeight: maxH + 'px' };

      return h('div', null,
        h('button', { ref: btnRef, className: 'sam-btn', 'data-open': open ? 'true' : 'false', onClick: toggleOpen, title: btnTitle },
          h('span', { className: dotClass, 'aria-hidden': 'true' }),
          '子代理模型',
        ),
        open && sessionId ? ReactDOM.createPortal(
          h('div', { ref: panelRef, className: 'sam-panel', style: panelStyle, role: 'dialog', 'aria-label': '子代理模型链' },
            h('div', { className: 'sam-head' },
              h('span', { className: 'sam-title' }, '子代理模型链'),
              stateChip,
              h('span', { className: 'sam-sid', title: sessionId }, sessionId),
            ),
            h('div', { className: 'sam-desc' },
              '为本会话的子代理（含嵌套子代理）指定有序可用模型：请求按 C1 → C2 … 顺序使用，某个候选用量耗尽或请求失败时自动回退到下一个；全部不可用时子代理以自己原路由执行。仅影响子代理，主会话模型不受影响。'),
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
              h('div', { className: 'sam-row' },
                h('button', {
                  className: 'sam-btn2 sam-mini',
                  disabled: busy || draft.length >= MAX_CANDIDATES,
                  onClick: () => setDraft((rows) => rows.concat([emptyDraft()])),
                }, '＋ 添加候选'),
                h('label', { className: 'sam-checks', title: '标题、压缩等辅助调用是否计入本链用量' },
                  h('input', { type: 'checkbox', checked: draftAux, onChange: (e) => setDraftAux(e.target.checked) }),
                  '辅助调用计入本链'),
                h('label', { className: 'sam-checks', title: '子代理用量是否同时计入本会话「供应池」的限额' },
                  h('input', { type: 'checkbox', checked: draftPool, onChange: (e) => setDraftPool(e.target.checked) }),
                  '计入会话请求池'),
                h('span', { className: 'sam-spacer' }),
                h('button', { className: 'sam-btn2 sam-primary', disabled: busy, onClick: enable }, '启用'),
              ),
            ) : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              (chain.candidates || []).map((candidate, index) => h(LiveRow, {
                key: index,
                candidate,
                index,
                active: chain.activeIndex === index,
                busy,
                onAdjust: (at, kind, value) => act({ path: '/dsh-subagent-models/adjust', body: { index: at, kind, value } }),
                onUnlimited: (at, unlimited) => act({
                  path: '/dsh-subagent-models/adjust',
                  body: unlimited ? { index: at, unlimited: true } : { index: at, kind: 'requests', value: 20 },
                }),
              })),
              chain.exhausted === true ? h('div', { className: 'sam-error' }, '全部候选不可用（耗尽或失败）：子代理将按自己的原路由执行，直到重置或调整限额。') : null,
              h('div', { className: 'sam-row' },
                h('button', {
                  className: 'sam-btn2', disabled: busy,
                  onClick: () => act({ path: '/dsh-subagent-models/reset' }),
                  title: '把所有候选的已用计数与失败标记清零',
                }, '重置计数'),
                h('button', {
                  className: 'sam-btn2' + (armed ? ' sam-danger sam-armed' : ''),
                  disabled: busy,
                  onClick: disable,
                  title: '移除本会话的子代理模型链',
                }, armed ? '确认停用？' : '停用'),
                h('label', { className: 'sam-checks', title: '立即生效，不影响已计用量' },
                  h('input', {
                    type: 'checkbox', disabled: busy,
                    checked: chain.countAuxiliary === true,
                    onChange: (e) => act({ path: '/dsh-subagent-models/adjust', body: { countAuxiliary: e.target.checked } }),
                  }),
                  '辅助调用计入'),
                h('label', { className: 'sam-checks', title: '子代理用量是否同时计入本会话「供应池」的限额' },
                  h('input', {
                    type: 'checkbox', disabled: busy,
                    checked: chain.countTowardPool === true,
                    onChange: (e) => act({ path: '/dsh-subagent-models/adjust', body: { countTowardPool: e.target.checked } }),
                  }),
                  '计入会话请求池'),
                h('span', { className: 'sam-spacer' }),
                h('button', { className: 'sam-btn2 sam-mini', disabled: busy, onClick: refresh, title: '立即刷新' }, '刷新'),
              ),
            ),
            error !== '' ? h('div', { className: 'sam-error' }, error) : null,
            h('div', { className: 'sam-foot' },
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
          id: 'subagent-models',
          order: 25,
        },
        SubagentModelsControl,
      ));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});