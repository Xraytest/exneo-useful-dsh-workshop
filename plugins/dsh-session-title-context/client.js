/**
 * dsh-session-title-context（dsh-session-title-context）— 浏览器半边。
 *
 * 会话标题栏右侧的「标题」控件：按钮即时重生成标题（用当前会话模型），
 * 展开面板可看到上次结果/失败与后台是否正在生成，并能**一次性指定模型**
 * （与输入框里的 `/title <provider>/<model>` 同义，共用 host 侧同一张
 * 一次性模型表）。
 *
 * 与 host 半边只通过同源 HTTP 说话（前缀 `/dsh-session-title`）：
 *   GET  /state?sessionId=   当前标题、上次结果/失败、inflight
 *   GET  /models             可用的 provider/模型目录
 *   POST /generate           {sessionId, provider?, model?}
 * 因此 client 半边不依赖任何出厂 remote，只注入 `slots`。
 *
 * @module dsh-session-title-context/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-title-context',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    const ROUTE_PREFIX = '/dsh-session-title';
    const STATE_POLL_MS = 5000;

    const PAGE_CSS = [
      '.dst-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 8px; padding: 4px 10px; font-size: 12px; line-height: 1.4; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: border-color .12s, color .12s; }',
      '.dst-btn:hover, .dst-btn[data-open="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }',
      '.dst-btn:disabled { opacity: .55; cursor: default; }',
      '.dst-btn[data-state="ok"] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }',
      '.dst-btn[data-state="err"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }',
      '.dst-spin { width: 11px; height: 11px; border-radius: 999px; border: 1.5px solid currentColor; border-top-color: transparent; animation: dst-spin .7s linear infinite; flex-shrink: 0; }',
      '@keyframes dst-spin { to { transform: rotate(360deg); } }',
      '.dst-panel { position: fixed; z-index: 3001; width: min(460px, calc(100vw - 20px)); max-height: min(70vh, 560px); overflow-y: auto; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; box-shadow: 0 16px 48px rgba(0,0,0,.30), 0 2px 8px rgba(0,0,0,.18); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; color: var(--dsw-alias-label-primary); font-size: 12px; animation: dst-pop .14s ease-out; }',
      '@keyframes dst-pop { from { opacity: 0; transform: translateY(-5px) scale(.985); } to { opacity: 1; transform: none; } }',
      '.dst-head { display: flex; align-items: center; gap: 8px; }',
      '.dst-title { font-size: 13px; font-weight: 600; }',
      '.dst-badge { font-size: 10px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-tertiary); }',
      '.dst-badge.live { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); }',
      '.dst-spacer { flex: 1; }',
      '.dst-now { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-l2); }',
      '.dst-now-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; word-break: break-word; }',
      '.dst-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }',
      '.dst-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.dst-primary { appearance: none; border: 1px solid var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); color: var(--dsw-alias-brand-primary); border-radius: 8px; padding: 5px 12px; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }',
      '.dst-primary:disabled { opacity: .55; cursor: default; }',
      '.dst-ghost { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; }',
      '.dst-ghost:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }',
      '.dst-provider { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }',
      '.dst-provider-name { color: var(--dsw-alias-label-secondary); font-size: 11px; }',
      '.dst-models { display: flex; flex-wrap: wrap; gap: 6px; }',
      '.dst-model { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 2px 9px; font-size: 11px; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.dst-model:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }',
      '.dst-model[data-current="true"] { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }',
      '.dst-error { color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 1.5; word-break: break-word; }',
      '.dst-hint { color: var(--dsw-alias-label-caption); font-size: 10px; line-height: 1.5; }',
    ].join('\n');

    function injectStyles() {
      if (document.getElementById('dsh-session-title-style') !== null) return;
      const tag = document.createElement('style');
      tag.id = 'dsh-session-title-style';
      tag.textContent = PAGE_CSS;
      document.head.appendChild(tag);
    }

    let pluginCtx;

    const errorText = (reason) => (reason instanceof Error ? reason.message : String(reason));

    async function api(path, options) {
      const response = await fetch(path, Object.assign({ credentials: 'same-origin' }, options));
      const text = await response.text();
      let payload;
      try {
        payload = text === '' ? {} : JSON.parse(text);
      } catch {
        throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`);
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(typeof payload.error === 'string' && payload.error !== '' ? payload.error : `请求失败（HTTP ${response.status}）`);
      }
      return payload;
    }
    const postJson = (path, body) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const VIA_LABEL = { 'tool-call': '工具调用', text: '文本兜底' };

    function clockOf(at) {
      if (typeof at !== 'number') return '';
      const date = new Date(at);
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    /** 会话标题栏右侧的「标题」控件。 */
    function SessionTitleControl(props) {
      const ctx = pluginCtx;
      const sessionId = props.sessionId;
      const [open, setOpen] = React.useState(false);
      const [rect, setRect] = React.useState(null);
      const [state, setState] = React.useState(null);
      const [models, setModels] = React.useState(null);
      const [picking, setPicking] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [flash, setFlash] = React.useState('');
      const [error, setError] = React.useState('');
      const btnRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const flashTimer = React.useRef(null);

      const ready = typeof sessionId === 'string' && sessionId !== '';

      const loadState = React.useCallback(() => {
        if (!ready) return;
        api(`${ROUTE_PREFIX}/state?sessionId=${encodeURIComponent(sessionId)}`)
          .then((value) => setState(value))
          .catch((reason) => {
            // 状态轮询失败不打断使用，只在面板里显示。
            if (open) setError(errorText(reason));
          });
      }, [ready, sessionId, open]);

      React.useEffect(() => {
        loadState();
        const timer = setInterval(loadState, STATE_POLL_MS);
        return () => clearInterval(timer);
      }, [loadState]);

      React.useEffect(() => () => {
        if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (panelRef.current !== null && panelRef.current.contains(event.target)) return;
          if (btnRef.current !== null && btnRef.current.contains(event.target)) return;
          setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [open]);

      React.useEffect(() => {
        if (!open || models !== null) return;
        api(`${ROUTE_PREFIX}/models`)
          .then((value) => setModels(Array.isArray(value.providers) ? value.providers : []))
          .catch((reason) => setError(errorText(reason)));
      }, [open, models]);

      const generate = React.useCallback((route) => {
        if (!ready) return;
        setBusy(true);
        setError('');
        postJson(`${ROUTE_PREFIX}/generate`, Object.assign(
          { sessionId },
          route === undefined ? {} : { provider: route.provider, model: route.model },
        )).then((value) => {
          if (value.state !== undefined) setState(value.state);
          setFlash('ok');
          if (flashTimer.current !== null) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setFlash(''), 2600);
        }).catch((reason) => {
          setError(errorText(reason));
          setFlash('err');
          if (flashTimer.current !== null) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setFlash(''), 4000);
        }).finally(() => setBusy(false));
      }, [ready, sessionId]);

      const inflight = busy || (state !== null && state.inflight === true);
      const last = state === null ? null : state.last;
      const failure = state === null ? null : state.failure;
      const current = state === null ? null : state.current;

      const metaOf = (info) => {
        if (info === null || typeof info !== 'object') return '';
        const via = VIA_LABEL[info.via] === undefined ? String(info.via) : VIA_LABEL[info.via];
        const took = typeof info.ms === 'number' ? ` · ${(info.ms / 1000).toFixed(1)}s` : '';
        const when = clockOf(info.at);
        return `${info.provider}/${info.model} · ${via}${took}${when === '' ? '' : ` · ${when}`}`;
      };

      const modelList = picking
        ? h('div', null,
            models === null
              ? h('div', { className: 'dst-meta' }, '读取模型目录…')
              : models.map((provider) => h('div', { className: 'dst-provider', key: provider.id },
                  h('div', { className: 'dst-provider-name' }, provider.name),
                  h('div', { className: 'dst-models' },
                    provider.models.length === 0
                      ? h('span', { className: 'dst-meta' }, '（这个 provider 没列出模型）')
                      : provider.models.map((model) => h('button', {
                          type: 'button',
                          key: `${provider.id}/${model.id}`,
                          className: 'dst-model',
                          'data-current': last !== null && last.provider === provider.id && last.model === model.id ? 'true' : 'false',
                          disabled: busy,
                          title: `${provider.id}/${model.id}`,
                          onClick: () => generate({ provider: provider.id, model: model.id }),
                        }, model.name)),
                  ),
                )),
          )
        : null;


      const button = h('button', {
        type: 'button',
        ref: btnRef,
        className: 'dst-btn',
        'data-open': open ? 'true' : 'false',
        'data-state': flash,
        disabled: !ready,
        title: ready
          ? (inflight ? '标题生成中…' : '重新生成会话标题（右键或点右侧箭头可选模型）')
          : '当前没有会话',
        onClick: () => {
          setOpen(false);
          generate(undefined);
        },
        onContextMenu: (event) => {
          event.preventDefault();
          if (!ready) return;
          const box = btnRef.current === null ? null : btnRef.current.getBoundingClientRect();
          if (box !== null) setRect({ top: box.bottom + 6, left: box.left, right: box.right });
          setOpen((value) => !value);
        },
      },
        inflight ? h('span', { className: 'dst-spin' }) : h('span', { 'aria-hidden': 'true' }, '✦'),
        h('span', null, inflight ? '生成中' : '标题'),
        h('span', {
          'aria-hidden': 'true',
          style: { opacity: .6, marginLeft: '2px' },
          onClick: (event) => {
            event.stopPropagation();
            if (!ready) return;
            const box = btnRef.current === null ? null : btnRef.current.getBoundingClientRect();
            if (box !== null) setRect({ top: box.bottom + 6, left: box.left, right: box.right });
            setOpen((value) => !value);
          },
        }, '▾'));

      const panel = open && rect !== null ? ReactDOM.createPortal(
        h('div', {
          className: 'dst-panel',
          ref: panelRef,
          style: {
            top: `${rect.top}px`,
            left: `${Math.max(10, Math.min(rect.left, window.innerWidth - 470))}px`,
          },
        },
          h('div', { className: 'dst-head' },
            h('span', { className: 'dst-title' }, '标题生成'),
            h('span', {
              className: state !== null && state.cadence === 'all-prompts' ? 'dst-badge live' : 'dst-badge',
            }, state === null ? '—' : (state.cadence === 'all-prompts' ? '每条消息自动重算' : '仅首次')),
            h('span', { className: 'dst-spacer' }),
            inflight ? h('span', { className: 'dst-badge live' }, '正在生成…') : null,
          ),
          h('div', { className: 'dst-now' },
            h('div', { className: 'dst-now-title' }, current === null ? '（还没有标题）' : current.title),
            last === null
              ? h('div', { className: 'dst-meta' }, '本进程里还没有生成记录')
              : h('div', { className: 'dst-meta' }, `上次：${last.title}`),
            last === null ? null : h('div', { className: 'dst-meta' }, metaOf(last)),
            state !== null && state.pinned !== null
              ? h('div', { className: 'dst-meta' }, `配置固定路由：${state.pinned.provider}/${state.pinned.model}`)
              : null,
          ),
          failure === null ? null : h('div', { className: 'dst-error' }, `上次失败${clockOf(failure.at) === '' ? '' : `（${clockOf(failure.at)}）`}：${failure.message}`),
          error === '' ? null : h('div', { className: 'dst-error' }, error),
          h('div', { className: 'dst-row' },
            h('button', {
              type: 'button',
              className: 'dst-primary',
              disabled: !ready || busy,
              onClick: () => generate(undefined),
            }, busy ? h('span', { className: 'dst-spin' }) : null, '用当前会话模型重新生成'),
            h('button', {
              type: 'button',
              className: 'dst-ghost',
              disabled: !ready || busy,
              onClick: () => setPicking((value) => !value),
            }, picking ? '收起模型列表' : '指定模型生成一次…'),
          ),
          modelList,
          h('div', { className: 'dst-hint' },
            `点按钮＝用当前会话模型重生成；面板每 ${STATE_POLL_MS / 1000} 秒刷新一次状态（自动生成的进度也会显示）。输入框里的 /title 同效，/title list 看模型清单。`),
        ), document.body) : null;

      return h(React.Fragment, null, button, panel);
    }

    const inject = ['slots'];

    function apply(ctx) {
      pluginCtx = ctx;
      injectStyles();
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
        {
          name: 'conversation.session.header.utilities',
          id: 'session-title',
          order: 24,
        },
        SessionTitleControl,
      ));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
