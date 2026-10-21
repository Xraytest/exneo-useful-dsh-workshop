/**
 * dsh-user-keep-compaction —— 浏览器半边（「用户消息完全保留」开关 + 状态标记）。
 *
 * 两个入口，都在官方插槽上，都按 sessionId 与 host 半边同源路由对账：
 *
 *  1) 开关 `conversation.input.left`（order 24，紧挨 ultracode 右侧；ultracode = 23）
 *     —— **只在新会话里出现**：host 说 canSet（没有人类消息）且会话快照仍空白时可见；
 *     首条消息一发出（`blank` 翻假 / `running` 置位）立即消失，host 侧同时开始拒绝
 *     再改（409）。
 *  2) 状态标记 `conversation.session.header.actions`（order -9，紧挨 Agent 预设标签
 *     右侧；预设标签 id = `agent-preset`，order -10）—— **启用才出现**：浅灰压缩图标，
 *     只是标记，不可点（属性在创建时定死，之后不该有能改它的入口）。
 *
 * 视觉（用户指定）：浅灰、不显眼、手绘的简洁 metal design——上下两块压板加一对
 * 对向箭头，银色斜向渐变描边。悬停提示：**用户消息完全保留**。
 *
 * 状态与写入都走 host 半边同源路由（见 ./index.js）：
 *   GET  /dsh-ukc/status?sessionId=…   → {enabled, canSet, live, …}
 *   POST /dsh-ukc/set   {sessionId, enabled}
 *
 * 轮询策略：每个会话一条共享轮询（模块级记录，组件只订阅），**只在属性还可改时**
 * （host 说 canSet=true，或状态还没取到）继续；host 一旦说 canSet=false 就停表，
 * 之后除首次取值外不再产生任何请求。
 *
 * @module dsh-user-keep-compaction/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-user-keep-compaction',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/dsh-ukc';
    /** 属性还可改时的轮询间隔（新会话创建界面停留时间很短）。 */
    const POLL_MS = 4000;
    /** 悬停提示原文（用户指定）。 */
    const TOOLTIP_ON = '用户消息完全保留';
    const TOOLTIP_OFF = '保留用户消息（点击开启）：本会话压缩只摘助手与工具内容';

    const PAGE_CSS = [
      /* ── 开关：与同一行出厂控件同高（28px），但只占一个图标宽，不抢视线 ── */
      '.ukc-toggle { appearance: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border-radius: 24px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-caption, #9aa0a6); cursor: pointer; opacity: .5; transition: opacity .16s ease, background .16s ease, border-color .16s ease; }',
      '.ukc-toggle:hover:not(:disabled) { opacity: 1; background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover, rgba(127, 137, 150, .14))); }',
      '.ukc-toggle:disabled { cursor: default; opacity: .3; }',
      '.ukc-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }',
      /* 点亮：一层很淡的金属底 + 细描边，仍然低调，只是能看出「它开着」。 */
      '.ukc-toggle.ukc-on { opacity: .92; border-color: rgba(198, 206, 216, .34); background: rgba(198, 206, 216, .13); }',
      '.ukc-toggle.ukc-on:hover:not(:disabled) { background: rgba(198, 206, 216, .2); }',
      '.ukc-busy { animation: ukc-breathe .7s ease-in-out infinite; }',
      '@keyframes ukc-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }',
      /* ── 头部状态标记：比标题行矮一点，浅灰、不参与交互 ── */
      '.ukc-badge { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 6px; color: var(--dsw-alias-label-caption, #9aa0a6); opacity: .55; cursor: default; transition: opacity .16s ease; }',
      '.ukc-badge:hover { opacity: .95; }',
    ].join('\n');

    let stylesInjected = false;
    function injectStyles() {
      if (stylesInjected || typeof document === 'undefined') return null;
      stylesInjected = true;
      const el = document.createElement('style');
      el.setAttribute('data-dsh-user-keep-compaction', '');
      // 归属标记：dsh-client-hmr 就地换半边时会摘掉「属于自己」的样式节点，
      // 不写这两个属性的话新挂载的插件可能顺手把这份样式一起摘走。
      el.setAttribute('data-plugin', 'dsh-user-keep-compaction');
      el.setAttribute('data-plugin-css', 'dsh-user-keep-compaction');
      el.textContent = PAGE_CSS;
      document.head.appendChild(el);
      return el;
    }

    async function api(path, options) {
      const response = await fetch(path, options);
      let body = null;
      try {
        body = await response.json();
      } catch {
        /* 非 JSON 响应体：落到状态码分支 */
      }
      if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
      return body;
    }

    const postJson = (path, payload) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    /* ── 每会话一条共享记录 + 一条共享轮询 ───────────────────────────────── */

    const records = new Map();
    const keyOf = (sessionId) => (typeof sessionId === 'string' ? sessionId : '');

    function recordOf(sessionId) {
      const key = keyOf(sessionId);
      let record = records.get(key);
      if (record === undefined) {
        record = { status: null, error: '', pending: false, listeners: new Set(), timer: null };
        records.set(key, record);
      }
      return record;
    }

    function notify(record) {
      for (const listener of [...record.listeners]) listener();
    }

    /** 属性是否还可能变化：未知时当作可能，定死后停表。 */
    const stillOpen = (record) => record.status === null || record.status.canSet !== false;

    function stopLoop(record) {
      if (record.timer !== null) {
        clearTimeout(record.timer);
        record.timer = null;
      }
    }

    function schedule(record, sessionId) {
      stopLoop(record);
      if (record.listeners.size === 0 || !stillOpen(record)) return;
      record.timer = setTimeout(() => {
        record.timer = null;
        refresh(sessionId).catch(() => {});
      }, POLL_MS);
    }

    async function refresh(sessionId) {
      const record = recordOf(sessionId);
      if (record.pending || typeof sessionId !== 'string' || sessionId === '') return;
      record.pending = true;
      try {
        record.status = await api(`${ROUTE}/status?sessionId=${encodeURIComponent(sessionId)}`);
        record.error = '';
      } catch (failure) {
        record.error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        record.pending = false;
        notify(record);
        schedule(record, sessionId);
      }
    }

    /** 订阅一份会话状态；首个订阅者建立轮询，最后一个离开或属性定死即停表。 */
    function subscribe(sessionId, listener) {
      const record = recordOf(sessionId);
      record.listeners.add(listener);
      if (record.status === null && !record.pending && record.timer === null) {
        refresh(sessionId).catch(() => {});
      } else {
        schedule(record, sessionId);
      }
      return () => {
        record.listeners.delete(listener);
        if (record.listeners.size === 0) {
          stopLoop(record);
          // 没人再看了就整条丢弃，别让 records 随「开过的会话数」无限长大；
          // 状态本来就能随时重新取一次（除了已定死的会话，取回还是同一个值）。
          if (records.get(keyOf(sessionId)) === record) records.delete(keyOf(sessionId));
        }
      };
    }

    function useStatus(sessionId) {
      const record = recordOf(sessionId);
      const [, bump] = React.useState(0);
      React.useEffect(() => subscribe(sessionId, () => bump((n) => n + 1)), [sessionId]);
      return record;
    }

    /**
     * 手绘「压缩」图标：上下两块压板 + 一对对向箭头，银色斜向渐变描边。
     * 纯内联 SVG，无外链、无字体依赖。
     */
    /**
     * 手绘的「压缩」图标：**两支细人字（V 形带）对向**，尖端之间留 4.4 的空隙。
     *
     * 这一版是踩了三次坑之后定下来的，别再改回去：
     *   ① **箭尖不能接触**。最早那版把两个 V 的顶点画在同一个点上，两个 V 叠起来
     *      就是一个叉——用户看到的就是「叉」。箭尖一旦接触、轮廓一闭合，就再也
     *      读不出「压缩」了。所以：尖端间距 4.4，两支人字互不相交（自测里有相交断言）。
     *   ② **不要箭杆**。第二版给每支箭加了 2 宽的箭杆，但半高图标里的箭杆太短，
     *      从顶边戳出来像一根刺，整体变成三叉鸟形。人字带本身就是箭，不需要杆。
     *   ③ **必须平涂**。本部署的 metal design 是「平涂、无渐变、无内高光」（见
     *      dsh-ultracode 的样式注释），出厂图标也一律是 16×16 的实心 `currentColor`
     *      路径。所以这里只有两段填充路径，颜色交给 CSS 的 `color`/`opacity`。
     *
     * 形状口径：45° 臂 + 45° 端切（与出厂人字图标同样的构造），带宽 2.4，两支关于
     * y=8 完全镜像，整体 8.8×15.6，落在 16 网格内不越界。
     */
    const ICON_PATHS = [
      /* 上人字（朝下）：尖端 (8,5.8)，两翼尖 (12.4,1.4)/(3.6,1.4) */
      'M8 5.8L12.4 1.4 11.2 0.2 8 3.4 4.8 0.2 3.6 1.4Z',
      /* 下人字（朝上）：上面那支关于 y=8 的镜像 */
      'M8 10.2L12.4 14.6 11.2 15.8 8 12.6 4.8 15.8 3.6 14.6Z',
    ];

    function compressIcon(size) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      ...ICON_PATHS.map((d) => h('path', { key: d, d, fill: 'currentColor' })));
    }

    /* ── 入口 1：新会话的开关（ultracode 右侧） ──────────────────────────── */

    function KeepUserMessagesToggle(props) {
      const sessionId = props.sessionId;
      const useSession = props.useSession;
      const session = typeof useSession === 'function' ? useSession((snapshot) => snapshot) : undefined;
      const record = useStatus(sessionId);
      const [busy, setBusy] = React.useState(false);

      const status = record.status;
      if (status === null || status.canSet !== true) return null;
      // 客户端这一层只做「立刻消失」：快照一旦不再是空白态就不再渲染，不等轮询。
      // authority 在 host（hasHumanMessage：只有 source.kind==='user' 的人类消息
      // 才算「发过了」）。
      //
      // 刻意**不看** promptAttempted：它是「按过发送」的粘性标记，发送失败
      // （网络错、被拒）时也会置位，而那时 host 仍然允许改；用它会凭空锁死一个
      // 从没发出去过消息的新会话。blank/running 覆盖了真正「消息已发出」的时刻
      // （turn 一开 blank 即翻假，running 即置位）。
      if (session !== undefined && session !== null
        && (session.blank !== true || session.running === true)) return null;

      const enabled = status.enabled === true;
      const onClick = async () => {
        if (busy) return;
        setBusy(true);
        try {
          const next = await postJson(`${ROUTE}/set`, { sessionId, enabled: !enabled });
          const live = recordOf(sessionId);
          live.status = next;
          live.error = '';
          notify(live);
        } catch (failure) {
          const live = recordOf(sessionId);
          live.error = failure instanceof Error ? failure.message : String(failure);
          // 409 是权威答复（host 侧已经定死）：立刻按定死处理，别把按钮留着
          // 让用户再点一次；网络类失败只提示、保留按钮。
          if (/不可再改|409/.test(live.error)) live.status = { ...(live.status ?? {}), canSet: false };
          notify(live);
        } finally {
          setBusy(false);
        }
      };

      const title = enabled ? TOOLTIP_ON : TOOLTIP_OFF;
      return h('button', {
        type: 'button',
        className: 'ukc-toggle' + (enabled ? ' ukc-on' : '') + (busy ? ' ukc-busy' : ''),
        'aria-pressed': enabled ? 'true' : 'false',
        'aria-label': title,
        disabled: busy,
        title: record.error === '' ? title : `${title}\n${record.error}`,
        // 与同一行出厂控件的 keepFocus 约定一致：按下时不让按钮抢走编辑器焦点。
        onMouseDown: (event) => { event.preventDefault(); },
        onClick,
      }, compressIcon(16));
    }

    /* ── 入口 2：会话头部的状态标记（Agent 预设标签右侧） ───────────────── */

    function KeepUserMessagesBadge(props) {
      const record = useStatus(props.sessionId);
      if (record.status === null || record.status.enabled !== true) return null;
      return h('span', {
        className: 'ukc-badge',
        role: 'img',
        'aria-label': TOOLTIP_ON,
        title: TOOLTIP_ON,
      }, compressIcon(14));
    }

    const inject = ['slots'];

    function apply(ctx) {
      const styleNode = injectStyles();
      // 热换（dsh-client-hmr 就地换半边）会重跑整个 bundle：卸载时带走自己的 <style>。
      ctx.effect(() => () => {
        stylesInjected = false;
        if (styleNode !== null && styleNode.parentNode !== null) styleNode.parentNode.removeChild(styleNode);
      }, 'dsh-user-keep-compaction: styles');
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
        {
          name: 'conversation.input.left',
          id: 'user-keep-compaction',
          // ultracode = 23；取 24 即排在它右边（order 升序）。
          order: 24,
        },
        KeepUserMessagesToggle,
      ));
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
        {
          name: 'conversation.session.header.actions',
          id: 'user-keep-compaction',
          // Agent 预设标签 id = agent-preset / order = -10；取 -9 即排在它右边。
          order: -9,
        },
        KeepUserMessagesBadge,
      ));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
