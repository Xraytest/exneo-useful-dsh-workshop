/**
 * Session orb — 会话悬浮球（渲染器半边，v2）。
 *
 * v2 把「球」搬出了页面。v1 的球是 `shell.overlay` 里的一层 DOM：它跟着窗口走，
 * 窗口一缩到托盘就整层消失，「置顶」也只是页面内的 `z-index`，而且窗口隐藏后
 * Chromium 会把页面的定时器压到 1 次/秒（5 分钟后 1 次/分钟），提示条和确认窗口
 * 全都会迟到几十秒。这些都不是能靠 CSS 修的东西，所以球改成一个独立进程的原生
 * 分层窗口（`native/SessionOrb.cs`，由 Host 现场编译并用 `WS_EX_TOPMOST` 拉起）。
 *
 * 页面这一半因此只剩三件事：
 *
 *   ① 设置页（`settings.section`）：读写 Host 侧持久化的设置，显示原生窗口的真实
 *      状态。页面上那颗球只是静态预览——真正的球在屏幕上，不在这张页面里。
 *   ② 指令通道：原生窗口在 Electron 进程之外，没法让 DSH 跳到某个会话，于是它把
 *     「点了提示」交给 Host 排队，页面用一条 700ms 的轮询把指令取走并执行
 *     `uiWorkspace.openSession()`。
 *   ③ 上报：把 `visible` / 语言 / 窗口矩形 / 会话标题告诉 Host。标题只有这里拿得到
 *      （Host 的 `SessionSummary` 不带 title），而原生窗口弹提示时要用它。
 *
 * 为什么是轮询而不是 SSE：渲染器侧的 `EventSource` 不能加请求头，而这些路由都要求
 * `x-dsh-orb: 1`（它们会吐出会话 id 与标题）。Host 给原生窗口用的那条 SSE 不受影响，
 * 那是 Node 里的 http 客户端，能带头。
 *
 * 隐藏时的轮询只是「尽力而为」；真正的保证来自唤醒：原生窗口点提示后会先把 DSH
 * 窗口显示并聚焦（`RevealDsh`），渲染器随即收到 `visibilitychange` / `focus` /
 * `pointerdown`，这些事件都会立刻打一次轮询。指令在 Host 侧有 60 秒 TTL，漏一次
 * 也不会积成雪崩。
 *
 * @module dsh-session-orb/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-orb',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-session-orb';

    // ------------------------------------------------------------------ 常量 --

    /** 渲染器请求必须带的 CSRF 头；Host 缺了直接 403（这些路由会暴露会话 id 与标题）。 */
    const CSRF_HEADER = 'x-dsh-orb';
    /** 单条请求的上限：Host 就在本机，慢到这个程度只可能是它卡住了。 */
    const REQUEST_TIMEOUT_MS = 5000;
    /** 页面可见时的指令轮询间隔。 */
    const POLL_VISIBLE_MS = 700;
    /** 页面隐藏时的轮询间隔（Chromium 会再把它压到 1 次/秒起步，所以只是兜底）。 */
    const POLL_HIDDEN_MS = 10_000;
    /** 唤醒节流：打字时不要每敲一下就打一次请求。 */
    const WAKE_MIN_MS = 400;
    /** 状态刷新间隔（只在可见时跑）。 */
    const REFRESH_MS = 3_000;
    /** 上报心跳间隔。 */
    const REPORT_MS = 5_000;
    /** 标题同步间隔（只在可见时跑）。 */
    const TITLES_MS = 4_000;
    /** 一次最多带多少条标题去 Host 缓存。 */
    const TITLES_MAX = 60;
    /** 设置写回防抖。 */
    const PATCH_MS = 120;
    /** 超过这段时间没有上报，就认为指令通道断了。 */
    const STALE_MS = 15_000;
    /** 诊断块最长展示多少字符。 */
    const DIAG_CHARS = 6000;
    /** v1 存在浏览器里的键：迁移一次后清掉。 */
    const LEGACY_POS_KEY = 'dsh.sessionOrb.position.v1';
    const LEGACY_SETTINGS_KEY = 'dsh.sessionOrb.settings.v1';
    /** 迁移标记：有它就不再读 v1 的值。 */
    const MIGRATED_KEY = 'dsh.sessionOrb.migrated.v2';

    /**
     * 与 `host/store.js` 的 `LIMITS` 逐项一致：滑块的范围就是 Host 的钳制范围，
     * 否则会出现「拖到头、松手又跳回去」。
     */
    const LIMITS = {
      fill: [0.08, 0.9],
      opacity: [0.25, 1],
      size: [40, 80],
      radius: [4, 40],
      bubbleAlpha: [0.5, 1],
      bubbleMs: [2_000, 30_000],
      confirmMs: [0, 15_000],
    };

    /** 与 `host/store.js` 的 `DEFAULTS` 一致；Host 没答话时用它兜底渲染。 */
    const DEFAULTS = {
      fill: 0.3,
      opacity: 0.88,
      size: 56,
      radius: 17,
      bubbleAlpha: 0.92,
      bubbleMs: 8_000,
      confirmMs: 2_500,
      pulse: true,
      badge: true,
      visible: true,
    };

    /** `native.status().state` 的所有取值，用来决定要不要翻译。 */
    const NATIVE_STATES = ['idle', 'compiling', 'running', 'restarting', 'stopped', 'failed', 'unsupported'];

    // ------------------------------------------------------------------ 文案 --

    const STRINGS = {
      zh: {
        'orb.label': '会话悬浮球',
        'settings.section': '会话悬浮球',
        'settings.title': '会话悬浮球',
        'settings.desc':
          '屏幕上的那颗球是独立进程的独立窗口：它不属于任何一页界面，所以 DSH 窗口缩到托盘、页面刷新、切走标签页都不会让它消失或变慢；它用 Win32 的置顶属性压在其它窗口之上。下面这些设置存在 Host 的 state.json 里，由原生窗口与这一页共享。',
        'settings.loading': '正在读取 Host 侧状态…',
        'settings.group.status': '运行状态',
        'settings.group.look': '外观',
        'settings.group.behavior': '行为',
        'settings.error': '请求失败：',
        'settings.failed.hint': '悬浮球没能启动。下面是原生宿主报的原文：',
        'settings.restart': '重启悬浮球',
        'settings.diagnose': '诊断',
        'settings.diagnose.hide': '收起诊断',
        'settings.test': '弹一条测试提示',
        'settings.reset.position': '复位到右下角',
        'settings.reset.look': '恢复默认外观',
        'settings.fill': '球体填充浓度',
        'settings.fill.hint': '黑色填充的不透明度，越低越透',
        'settings.opacity': '整体不透明度',
        'settings.size': '球体大小',
        'settings.radius': '圆角',
        'settings.bubbleAlpha': '提示框不透明度',
        'settings.bubbleMs': '提示停留时长',
        'settings.confirmMs': '完成确认窗口',
        'settings.confirmMs.hint': '会话停下后先等这么久再确认「完成」，避免轮间抖动误报',
        'settings.pulse': '有会话在跑时脉冲',
        'settings.badge': '球角显示待看条数',
        'settings.visible': '显示悬浮球',
        'settings.visible.hint':
          '关掉后球从屏幕上消失；DSH 照常在后台记录待看提示，要再显示只能回到这一页打开（隐藏后球上的右键菜单也一起消失）。',
        'settings.preview': '一条会话完成的提示',
        'settings.previewNote': '上面只是外观预览；真正的球在屏幕上，这里看到的颜色与它一致。',
        'settings.note':
          '设置与位置存在本机数据目录的 state.json 里，由 Host、原生窗口与这一页共享：换浏览器、刷新页面都不会丢；把球拖到别处，位置也会写回这里。',
        'settings.migrated': '已把 v1 存在浏览器里的设置与位置迁移过来（只做一次，之后以本页为准）。',
        'status.native': '原生窗口',
        'status.visible': '可见性',
        'status.visibleOn': '显示中',
        'status.visibleOff': '已隐藏（设置里可再打开）',
        'status.topmost': '置顶',
        'status.tray': 'DSH 隐藏时',
        'status.position': '位置',
        'status.pending': '待看提示',
        'status.renderer': '指令通道',
        'status.helper': '助手程序',
        'status.topmostValue': 'WS_EX_TOPMOST（+ 每 0.5 秒 z 序看护）',
        'status.trayValue': '独立窗口，不受影响',
        'status.none': '未设置（右下角）',
        'status.connected': '已连接',
        'status.disconnected': '未连接',
        'status.hidden': '页面不可见',
        'state.idle': '未启动',
        'state.compiling': '正在编译助手',
        'state.running': '运行中',
        'state.restarting': '正在重启',
        'state.stopped': '已停止',
        'state.failed': '启动失败',
        'state.unsupported': '当前平台不支持',
        'bubble.done': '会话完成',
        'bubble.unnamed': '未命名会话',
        'bubble.more': '还有 {n} 条',
      },
      en: {
        'orb.label': 'Session orb',
        'settings.section': 'Session orb',
        'settings.title': 'Session orb',
        'settings.desc':
          'The ball on your screen is a separate native window in its own process: it belongs to no page, so hiding DSH to the tray, reloading a page or switching tabs neither removes nor slows it down, and it sits above other windows by a real Win32 topmost flag. These settings live in the host state.json and are shared by the native window and this page.',
        'settings.loading': 'Reading host state…',
        'settings.group.status': 'Status',
        'settings.group.look': 'Look',
        'settings.group.behavior': 'Behaviour',
        'settings.error': 'Request failed: ',
        'settings.failed.hint': 'The orb could not start. The native host reported:',
        'settings.restart': 'Restart orb',
        'settings.diagnose': 'Diagnose',
        'settings.diagnose.hide': 'Hide diagnostics',
        'settings.test': 'Show a test notice',
        'settings.reset.position': 'Reset to bottom-right',
        'settings.reset.look': 'Restore default look',
        'settings.fill': 'Fill density',
        'settings.fill.hint': 'Opacity of the dark fill; lower is more transparent',
        'settings.opacity': 'Overall opacity',
        'settings.size': 'Size',
        'settings.radius': 'Corner radius',
        'settings.bubbleAlpha': 'Notice opacity',
        'settings.bubbleMs': 'Notice duration',
        'settings.confirmMs': 'Completion window',
        'settings.confirmMs.hint': 'How long a session must stay idle before it counts as finished, so a turn gap is not mistaken for completion',
        'settings.pulse': 'Pulse while a session runs',
        'settings.badge': 'Show the pending count on the ball',
        'settings.visible': 'Show the orb',
        'settings.visible.hint':
          'Turning this off removes the ball from the screen; DSH keeps recording notices in the background, and this page is the only way back — the ball’s own right-click menu goes away with it.',
        'settings.preview': 'A session finished',
        'settings.previewNote': 'Preview only — the real ball lives on your screen with exactly these colours.',
        'settings.note':
          'Settings and position live in state.json in the data directory and are shared by the host, the native window and this page: they survive reloads and browser changes, and dragging the ball writes the position back here.',
        'settings.migrated': 'Migrated the v1 browser settings and position once; this page is authoritative from now on.',
        'status.native': 'Native window',
        'status.visible': 'Visibility',
        'status.visibleOn': 'shown',
        'status.visibleOff': 'hidden (re-enable in settings)',
        'status.topmost': 'Topmost',
        'status.tray': 'With DSH hidden',
        'status.position': 'Position',
        'status.pending': 'Pending notices',
        'status.renderer': 'Command channel',
        'status.helper': 'Helper',
        'status.topmostValue': 'WS_EX_TOPMOST (+ z-order check every 0.5s)',
        'status.trayValue': 'Separate window — unaffected',
        'status.none': 'Not set (bottom-right)',
        'status.connected': 'connected',
        'status.disconnected': 'disconnected',
        'status.hidden': 'page hidden',
        'state.idle': 'idle',
        'state.compiling': 'compiling helper',
        'state.running': 'running',
        'state.restarting': 'restarting',
        'state.stopped': 'stopped',
        'state.failed': 'failed to start',
        'state.unsupported': 'unsupported platform',
        'bubble.done': 'Session finished',
        'bubble.unnamed': 'Untitled session',
        'bubble.more': '{n} more',
      },
    };

    // -------------------------------------------------------------------- CSS --

    /**
     * 全部样式都挂 `sorb_` 前缀，只描述「预览里的那颗球」和设置页控件。
     * 球的视觉与原生窗口的 `ComposeFrame` 保持一致（同一组数值），所以预览不是
     * 另一套设计，而是同一套颜色的 CSS 复刻。
     */
    const CSS = [
      // ---- 球本体（预览用；真实的那颗由 GDI+ 分层窗口画） ----
      '.sorb_ball{position:relative;display:flex;align-items:center;justify-content:center;box-sizing:border-box;',
      'width:var(--sorb-size,56px);height:var(--sorb-size,56px);border-radius:var(--sorb-radius,17px);border:0;padding:0;',
      'background:rgba(0,0,0,var(--sorb-fill,.3));',
      '-webkit-backdrop-filter:blur(12px) saturate(150%);backdrop-filter:blur(12px) saturate(150%);',
      'box-shadow:0 8px 22px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.14),inset 0 0 0 1px rgba(255,255,255,.05);',
      'opacity:var(--sorb-opacity,.88);cursor:default;pointer-events:none}',
      '.sorb_ring{position:absolute;inset:-1px;border-radius:inherit;border:1px solid rgba(255,255,255,.5);opacity:0;pointer-events:none}',
      '.sorb_ball.is-running .sorb_ring{animation:sorb-pulse 2.6s cubic-bezier(.22,.61,.36,1) infinite}',
      '@keyframes sorb-pulse{0%{opacity:.45;transform:scale(1)}70%{opacity:0;transform:scale(1.32)}100%{opacity:0;transform:scale(1.32)}}',
      '.sorb_core{width:calc(var(--sorb-size,56px) * .214);height:calc(var(--sorb-size,56px) * .214);border-radius:50%;',
      'background:rgba(255,255,255,.92);box-shadow:0 0 10px rgba(255,255,255,.45)}',
      '.sorb_badge{position:absolute;top:5px;right:5px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;',
      'background:#ff5f57;color:#fff;font-size:10px;font-weight:600;line-height:16px;text-align:center;',
      'box-shadow:0 1px 4px rgba(0,0,0,.35)}',
      // ---- 提示条（预览用） ----
      '.sorb_bubble{display:flex;flex-direction:column;gap:5px;box-sizing:border-box;',
      'width:max-content;max-width:min(300px,calc(100vw - 28px));padding:9px 12px 10px;',
      'border:1px solid rgba(255,255,255,.14);border-radius:13px;',
      'background:rgba(8,9,12,var(--sorb-bubble,.92));color:#f5f6f8;',
      '-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);',
      'box-shadow:0 12px 30px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.09)}',
      '.sorb_bubbleKicker{display:flex;align-items:center;gap:5px;font-size:11px;line-height:14px;color:rgba(255,255,255,.62)}',
      '.sorb_blip{width:5px;height:5px;border-radius:50%;background:#4ade80;box-shadow:0 0 6px rgba(74,222,128,.7);flex:0 0 auto}',
      '.sorb_bubbleTitle{font-size:13.5px;line-height:19px;font-weight:500;color:#f7f8fa;overflow-wrap:anywhere;',
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.sorb_bubbleMore{font-size:11px;line-height:14px;color:rgba(255,255,255,.5)}',
      // ---- 设置页骨架 ----
      '.sorb_set{display:flex;flex-direction:column;gap:16px;padding:2px 2px 28px;font-size:13px}',
      '.sorb_setHead{display:flex;flex-direction:column;gap:6px}',
      '.sorb_setTitle{font-size:14.5px;line-height:1.4;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.sorb_setDesc{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary)}',
      '.sorb_setCard{display:flex;flex-direction:column;gap:12px;padding:14px 14px 15px;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,10px);background:var(--dsw-alias-bg-layer-1)}',
      '.sorb_setCardTitle{font-size:12.5px;line-height:1.4;font-weight:600;color:var(--dsw-alias-label-primary)}',
      // ---- 状态表 ----
      '.sorb_stats{display:flex;flex-direction:column;gap:6px}',
      '.sorb_stat{display:grid;grid-template-columns:104px minmax(0,1fr);align-items:baseline;gap:10px;font-size:12px;line-height:1.55}',
      '.sorb_statKey{color:var(--dsw-alias-label-secondary)}',
      '.sorb_statVal{min-width:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}',
      '.sorb_ok{color:#4ade80}',
      '.sorb_bad{color:#f87171}',
      '.sorb_warn{padding:10px 12px;border:1px solid rgba(248,113,113,.42);border-radius:var(--dsw-radius-sm,8px);',
      'background:rgba(248,113,113,.08);font-size:12px;line-height:1.6;overflow-wrap:anywhere}',
      '.sorb_diag{margin:0;padding:10px 12px;max-height:220px;overflow:auto;border-radius:var(--dsw-radius-sm,8px);',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);',
      'font:11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;',
      'color:var(--dsw-alias-label-secondary)}',
      // ---- 表单 ----
      '.sorb_setRow{display:grid;grid-template-columns:minmax(0,1fr) minmax(96px,132px) 54px;align-items:center;gap:10px}',
      '.sorb_setLabel{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.sorb_setName{font-size:12.5px;line-height:1.4}',
      '.sorb_setHint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.sorb_setVal{font-size:12px;line-height:1.4;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.sorb_setRange{-webkit-appearance:none;appearance:none;width:100%;height:18px;background:transparent;cursor:pointer}',
      '.sorb_setRange::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:var(--dsw-alias-border-l2)}',
      '.sorb_setRange::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5.5px;border:none;border-radius:50%;',
      'background:var(--dsw-alias-brand-primary,#3b82f6);box-shadow:0 1px 3px rgba(0,0,0,.32)}',
      '.sorb_setRange:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:4px}',
      '.sorb_setChecks{display:flex;flex-wrap:wrap;gap:16px}',
      '.sorb_setCheck{display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer}',
      '.sorb_setCheck input{width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}',
      // ---- 开关行（显示/隐藏这类单值布尔） ----
      '.sorb_setToggle{grid-template-columns:minmax(0,1fr) auto}',
      '.sorb_switch{position:relative;display:inline-flex;align-items:center;cursor:pointer}',
      '.sorb_switch input{position:absolute;left:0;top:0;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}',
      '.sorb_switchTrack{display:inline-flex;align-items:center;box-sizing:border-box;width:38px;height:22px;padding:2px;',
      'border-radius:11px;background:rgba(128,128,128,.38);transition:background .14s ease}',
      '.sorb_switchKnob{width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.35);',
      'transition:transform .14s ease}',
      '.sorb_switch input:checked+.sorb_switchTrack{background:var(--dsw-alias-brand-primary,#3b82f6)}',
      '.sorb_switch input:checked+.sorb_switchTrack .sorb_switchKnob{transform:translateX(16px)}',
      '.sorb_switch input:focus-visible+.sorb_switchTrack{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:2px}',
      '.sorb_setSwitchNote{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary)}',
      // ---- 预览舞台 ----
      '.sorb_setStage{display:flex;align-items:center;justify-content:center;gap:20px;min-height:104px;padding:16px 14px;',
      'border:1px dashed var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,10px);background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.sorb_setBallBox{position:relative;flex:0 0 auto;width:var(--sorb-size,56px);height:var(--sorb-size,56px)}',
      '.sorb_setBubbleSample{cursor:default}',
      // ---- 按钮与注释 ----
      '.sorb_setActions{display:flex;flex-wrap:wrap;gap:8px}',
      '.sorb_setBtn{font:inherit;font-size:12px;line-height:1;padding:8px 12px;border-radius:var(--dsw-radius-sm,8px);',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;',
      'transition:border-color .15s ease,background .15s ease}',
      '.sorb_setBtn:hover:enabled{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.sorb_setBtn:disabled{opacity:.55;cursor:default}',
      '.sorb_setBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.sorb_setNote{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '@media (prefers-reduced-motion:reduce){.sorb_ball.is-running .sorb_ring{animation:none}}',
    ].join('');

    (function injectCss() {
      if (typeof document === 'undefined' || document.head === null) return;
      const tagId = NS + '/orb.css';
      try {
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return;
        const tag = document.createElement('style');
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (error) {
        /* 无头的环境就不带样式渲染 */
      }
    })();

    // -------------------------------------------------------------- 小工具 --

    /** 极简可订阅 store；不引 zustand，免得和宿主自带的版本打架。 */
    function createStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => snapshot,
        set(next) {
          const value = typeof next === 'function' ? next(snapshot) : next;
          if (value === snapshot) return;
          snapshot = value;
          for (const listener of listeners) {
            try {
              listener();
            } catch (error) {
              /* 一个坏订阅者不该拖垮其它订阅者 */
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    /** React 18 的 `useSyncExternalStore`；老版本退回 `useState` + `useEffect`。 */
    const useStore =
      typeof React.useSyncExternalStore === 'function'
        ? (store) => React.useSyncExternalStore(store.subscribe, store.getSnapshot)
        : (store) => {
            const [value, setValue] = React.useState(store.getSnapshot());
            React.useEffect(() => store.subscribe(() => setValue(store.getSnapshot())), [store]);
            return value;
          };

    /**
     * 带 CSRF 头与超时的请求。所有 `/session-orb/*` 路由都要求 `x-dsh-orb: 1`。
     * @param {string} path
     * @param {{ method?: string, body?: unknown }} [options]
     */
    async function request(path, options) {
      const opts = options === undefined || options === null ? {} : options;
      const method = typeof opts.method === 'string' ? opts.method : 'GET';
      const headers = {};
      headers[CSRF_HEADER] = '1';
      const init = { method, headers, cache: 'no-store', credentials: 'same-origin' };
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      init.signal = controller.signal;
      let response = null;
      try {
        response = await fetch(path, init);
      } finally {
        clearTimeout(timer);
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (!response.ok) {
        const reason =
          payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + String(response.status);
        throw new Error(reason);
      }
      return payload !== null && typeof payload === 'object' ? payload : {};
    }

    function round2(value) {
      return Math.round(value * 100) / 100;
    }

    function clampNumber(value, min, max, fallback) {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) return fallback;
      if (num < min) return min;
      if (num > max) return max;
      return round2(num);
    }

    /** 与 `host/store.js` 的 `normalizeSettings` 逐字段一致，只用于本地即时预览。 */
    function normalizeSettings(raw) {
      const input = raw === null || typeof raw !== 'object' ? {} : raw;
      const size = clampNumber(input.size, LIMITS.size[0], LIMITS.size[1], DEFAULTS.size);
      const radiusMax = Math.min(LIMITS.radius[1], Math.round(size / 2));
      return {
        fill: clampNumber(input.fill, LIMITS.fill[0], LIMITS.fill[1], DEFAULTS.fill),
        opacity: clampNumber(input.opacity, LIMITS.opacity[0], LIMITS.opacity[1], DEFAULTS.opacity),
        size,
        radius: clampNumber(input.radius, LIMITS.radius[0], radiusMax, Math.min(DEFAULTS.radius, radiusMax)),
        bubbleAlpha: clampNumber(input.bubbleAlpha, LIMITS.bubbleAlpha[0], LIMITS.bubbleAlpha[1], DEFAULTS.bubbleAlpha),
        bubbleMs: clampNumber(input.bubbleMs, LIMITS.bubbleMs[0], LIMITS.bubbleMs[1], DEFAULTS.bubbleMs),
        confirmMs: clampNumber(input.confirmMs, LIMITS.confirmMs[0], LIMITS.confirmMs[1], DEFAULTS.confirmMs),
        pulse: typeof input.pulse === 'boolean' ? input.pulse : DEFAULTS.pulse,
        badge: typeof input.badge === 'boolean' ? input.badge : DEFAULTS.badge,
        visible: typeof input.visible === 'boolean' ? input.visible : DEFAULTS.visible,
      };
    }

    function isDefaultSettings(raw) {
      const settings = normalizeSettings(raw);
      const keys = Object.keys(DEFAULTS);
      for (const key of keys) {
        if (settings[key] !== DEFAULTS[key]) return false;
      }
      return true;
    }

    function detectLang() {
      const domLang = typeof document === 'undefined' ? '' : String(document.documentElement.lang || '').toLowerCase();
      if (domLang.indexOf('zh') === 0) return 'zh';
      if (domLang.indexOf('en') === 0) return 'en';
      const navLang = typeof navigator === 'undefined' ? '' : String(navigator.language || '').toLowerCase();
      if (navLang.indexOf('zh') === 0) return 'zh';
      if (navLang.indexOf('en') === 0) return 'en';
      return 'zh';
    }

    function isPageVisible() {
      if (typeof document === 'undefined') return true;
      return document.visibilityState !== 'hidden';
    }

    function basename(path) {
      const text = String(path === undefined || path === null ? '' : path);
      const at = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
      return at === -1 ? text : text.slice(at + 1);
    }

    function titleOf(row) {
      if (row === null || row === undefined || typeof row !== 'object') return '';
      if (typeof row.title === 'string' && row.title !== '') return row.title;
      if (typeof row.displayTitle === 'string' && row.displayTitle !== '') return row.displayTitle;
      const projections = row.projections;
      const values =
        projections !== null && typeof projections === 'object' ? projections.values : null;
      if (values !== null && typeof values === 'object') {
        const keys = Object.keys(values);
        for (const key of keys) {
          if (!/title|name|label/i.test(key)) continue;
          const value = values[key];
          if (typeof value === 'string' && value !== '') return value;
        }
      }
      return '';
    }

    // ------------------------------------------------------------------ 设置页 --

    /**
     * 设置页。`api` 由 `apply()` 注入（闭包里有 store、`t`、请求函数），
     * 所以这个组件不依赖任何模块级可变状态，两次渲染之间也不会串味。
     *
     * @param {{ api: object }} props
     */
    function OrbSettingsView(props) {
      const api = props.api;
      const snapshot = useStore(api.view);
      const t = api.t;

      const state = snapshot.state;
      const settings = state !== null && state.settings !== null && typeof state.settings === 'object'
        ? normalizeSettings(state.settings)
        : DEFAULTS;
      const native = state !== null && state.native !== null && typeof state.native === 'object' ? state.native : null;
      const summary =
        state !== null && state.summary !== null && typeof state.summary === 'object' ? state.summary : null;
      const position =
        state !== null && state.position !== null && typeof state.position === 'object' ? state.position : null;

      // 打开设置页就立刻拉一次：轮询最长 700ms，但没必要让用户盯着空表。
      React.useEffect(() => {
        void api.refresh().catch(() => {});
      }, []);

      const nativeState = native !== null && typeof native.state === 'string' ? native.state : 'idle';
      const stateLabel = NATIVE_STATES.indexOf(nativeState) === -1 ? nativeState : t('state.' + nativeState);
      const running = nativeState === 'running';
      const failed = nativeState === 'failed';
      const pid = native !== null && Number.isFinite(Number(native.pid)) ? Number(native.pid) : null;
      const exe = native !== null && typeof native.exe === 'string' ? native.exe : '';
      const reason = failed && native !== null && typeof native.reason === 'string' ? native.reason : '';

      const renderer =
        summary !== null && summary.renderer !== null && typeof summary.renderer === 'object' ? summary.renderer : null;
      const rendererFresh =
        renderer !== null && typeof renderer.at === 'number' && Date.now() - renderer.at < STALE_MS;
      const pending = summary !== null && Number.isFinite(Number(summary.notices)) ? Number(summary.notices) : 0;
      const queue = summary !== null && Array.isArray(summary.queue) ? summary.queue : [];
      const head = queue.length > 0 && queue[0] !== null && typeof queue[0] === 'object' ? queue[0] : null;
      const headTitle =
        head !== null && typeof head.title === 'string' && head.title !== '' ? head.title : t('bubble.unnamed');

      const row = (key, label, value, tone) =>
        h(
          'div',
          { className: 'sorb_stat', key },
          h('span', { className: 'sorb_statKey' }, label),
          h('span', { className: tone === undefined ? 'sorb_statVal' : 'sorb_statVal ' + tone }, value),
        );

      const rows = [
        row(
          'native',
          t('status.native'),
          running && pid !== null ? stateLabel + ' · pid ' + String(pid) : stateLabel,
          running ? 'sorb_ok' : failed ? 'sorb_bad' : undefined,
        ),
        row(
          'visible',
          t('status.visible'),
          settings.visible === false ? t('status.visibleOff') : t('status.visibleOn'),
          settings.visible === false ? 'sorb_bad' : undefined,
        ),
        row('topmost', t('status.topmost'), running ? t('status.topmostValue') : '—'),
        row('tray', t('status.tray'), t('status.trayValue')),
        row(
          'position',
          t('status.position'),
          position !== null ? String(position.x) + ', ' + String(position.y) : t('status.none'),
        ),
        row('pending', t('status.pending'), pending === 0 ? '0' : String(pending) + ' · ' + headTitle),
        row(
          'renderer',
          t('status.renderer'),
          rendererFresh
            ? t('status.connected') + (renderer.visible === false ? ' · ' + t('status.hidden') : '')
            : t('status.disconnected'),
          rendererFresh ? undefined : 'sorb_bad',
        ),
        exe === '' ? null : row('helper', t('status.helper'), basename(exe)),
      ].filter(Boolean);

      const callAction = (name) => {
        void api.action(name);
      };

      const buttons = [
        h(
          'button',
          {
            type: 'button',
            className: 'sorb_setBtn',
            key: 'restart',
            disabled: snapshot.busy !== '',
            onClick: () => callAction('revive-native'),
          },
          t('settings.restart'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'sorb_setBtn',
            key: 'diag',
            onClick: () => api.toggleDiagnostics(),
          },
          snapshot.diagOpen ? t('settings.diagnose.hide') : t('settings.diagnose'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'sorb_setBtn',
            key: 'test',
            disabled: snapshot.busy !== '' || !running,
            onClick: () => callAction('test-notice'),
          },
          t('settings.test'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'sorb_setBtn',
            key: 'reset-position',
            disabled: snapshot.busy !== '' || position === null,
            onClick: () => callAction('reset-position'),
          },
          t('settings.reset.position'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'sorb_setBtn',
            key: 'reset-look',
            onClick: () => api.resetLook(),
          },
          t('settings.reset.look'),
        ),
      ];

      const slider = (key, label, hint, min, max, step, value, format) =>
        h(
          'div',
          { className: 'sorb_setRow', key },
          h(
            'div',
            { className: 'sorb_setLabel' },
            h('span', { className: 'sorb_setName' }, label),
            hint === '' ? null : h('span', { className: 'sorb_setHint' }, hint),
          ),
          h('input', {
            className: 'sorb_setRange',
            type: 'range',
            min,
            max,
            step,
            value,
            'aria-label': label,
            onChange: (event) => api.patch({ [key]: Number(event.target.value) }),
          }),
          h('span', { className: 'sorb_setVal' }, format(value)),
        );

      const check = (key, label) =>
        h(
          'label',
          { className: 'sorb_setCheck', key },
          h('input', {
            type: 'checkbox',
            checked: settings[key] === true,
            onChange: (event) => api.patch({ [key]: event.target.checked }),
          }),
          h('span', null, label),
        );

      /** 单值开关：整行可点，右侧是 iOS 风格滑道，跟 sliders 同一套栅格。 */
      const toggle = (key, label, hint) =>
        h(
          'div',
          { className: 'sorb_setRow sorb_setToggle', key },
          h(
            'div',
            { className: 'sorb_setLabel' },
            h('span', { className: 'sorb_setName' }, label),
            hint === '' ? null : h('span', { className: 'sorb_setHint' }, hint),
          ),
          h(
            'label',
            { className: 'sorb_switch' },
            h('input', {
              type: 'checkbox',
              checked: settings[key] !== false,
              'aria-label': label,
              onChange: (event) => api.patch({ [key]: event.target.checked }),
            }),
            h(
              'span',
              { className: 'sorb_switchTrack', 'aria-hidden': 'true' },
              h('span', { className: 'sorb_switchKnob' }),
            ),
          ),
        );

      const pct = (value) => Math.round(value * 100) + '%';
      const sizeText = (value) => String(Math.round(value)) + 'px';
      const secText = (value) => (value >= 1000 ? String(Math.round(value / 100) / 10) + 's' : String(value) + 'ms');

      // 预览：与原生窗口同一组数值（见 native/SessionOrb.cs 的 ComposeFrame）。
      const vars = {
        '--sorb-size': String(settings.size) + 'px',
        '--sorb-radius': String(settings.radius) + 'px',
        '--sorb-fill': String(settings.fill),
        '--sorb-opacity': String(settings.opacity),
        '--sorb-bubble': String(settings.bubbleAlpha),
      };

      const previewBall = h(
        'div',
        { className: 'sorb_setBallBox' },
        h(
          'div',
          { className: 'sorb_ball' + (settings.pulse ? ' is-running' : '') },
          settings.pulse ? h('span', { className: 'sorb_ring', 'aria-hidden': 'true' }) : null,
          h('span', { className: 'sorb_core', 'aria-hidden': 'true' }),
          settings.badge && pending > 0
            ? h('span', { className: 'sorb_badge' }, pending > 9 ? '9+' : String(pending))
            : null,
        ),
      );

      const previewBubble = h(
        'div',
        { className: 'sorb_bubble sorb_setBubbleSample' },
        h(
          'span',
          { className: 'sorb_bubbleKicker' },
          h('span', { className: 'sorb_blip', 'aria-hidden': 'true' }),
          t('bubble.done'),
        ),
        h('span', { className: 'sorb_bubbleTitle' }, t('settings.preview')),
        pending > 1
          ? h('span', { className: 'sorb_bubbleMore' }, t('bubble.more').replace('{n}', String(pending - 1)))
          : null,
      );

      const diagText =
        snapshot.diag === null
          ? ''
          : (() => {
              try {
                const text = JSON.stringify(snapshot.diag, null, 2);
                return text.length > DIAG_CHARS ? text.slice(0, DIAG_CHARS) + '\n…' : text;
              } catch (error) {
                return String(error);
              }
            })();

      const notes = [];
      if (snapshot.error !== '') {
        notes.push(h('div', { className: 'sorb_warn', key: 'error' }, t('settings.error') + snapshot.error));
      }
      if (snapshot.migrated) {
        notes.push(h('div', { className: 'sorb_setNote', key: 'migrated' }, t('settings.migrated')));
      }
      notes.push(h('div', { className: 'sorb_setNote', key: 'note' }, t('settings.note')));

      return h(
        'div',
        { className: 'sorb_set' },
        h(
          'div',
          { className: 'sorb_setHead' },
          h('div', { className: 'sorb_setTitle' }, t('settings.title')),
          h('div', { className: 'sorb_setDesc' }, t('settings.desc')),
        ),

        h(
          'div',
          { className: 'sorb_setCard' },
          h('div', { className: 'sorb_setCardTitle' }, t('settings.group.status')),
          snapshot.loaded ? h('div', { className: 'sorb_stats' }, rows) : h('div', { className: 'sorb_setNote' }, t('settings.loading')),
          reason === '' ? null : h('div', { className: 'sorb_warn' }, t('settings.failed.hint'), h('div', null, reason)),
          h('div', { className: 'sorb_setActions' }, buttons),
          snapshot.diagOpen ? h('pre', { className: 'sorb_diag' }, diagText) : null,
        ),

        h('div', { className: 'sorb_setStage', style: vars }, previewBall, previewBubble),
        h('div', { className: 'sorb_setNote' }, t('settings.previewNote')),

        h(
          'div',
          { className: 'sorb_setCard' },
          h('div', { className: 'sorb_setCardTitle' }, t('settings.group.look')),
          slider('fill', t('settings.fill'), t('settings.fill.hint'), LIMITS.fill[0], LIMITS.fill[1], 0.01, settings.fill, pct),
          slider('opacity', t('settings.opacity'), '', LIMITS.opacity[0], LIMITS.opacity[1], 0.01, settings.opacity, pct),
          slider('size', t('settings.size'), '', LIMITS.size[0], LIMITS.size[1], 1, settings.size, sizeText),
          slider('radius', t('settings.radius'), '', LIMITS.radius[0], Math.min(LIMITS.radius[1], Math.round(settings.size / 2)), 1, settings.radius, sizeText),
          slider('bubbleAlpha', t('settings.bubbleAlpha'), '', LIMITS.bubbleAlpha[0], LIMITS.bubbleAlpha[1], 0.01, settings.bubbleAlpha, pct),
        ),

        h(
          'div',
          { className: 'sorb_setCard' },
          h('div', { className: 'sorb_setCardTitle' }, t('settings.group.behavior')),
          toggle('visible', t('settings.visible'), t('settings.visible.hint')),
          slider('bubbleMs', t('settings.bubbleMs'), '', LIMITS.bubbleMs[0], LIMITS.bubbleMs[1], 500, settings.bubbleMs, secText),
          slider('confirmMs', t('settings.confirmMs'), t('settings.confirmMs.hint'), LIMITS.confirmMs[0], LIMITS.confirmMs[1], 250, settings.confirmMs, secText),
          h('div', { className: 'sorb_setChecks' }, check('pulse', t('settings.pulse')), check('badge', t('settings.badge'))),
        ),

        notes,
      );
    }

    // ------------------------------------------------------------------ 插件 --

    return {
      /** `uiWorkspace` 是可选服务：没有它，指令通道退化成「只显示提示」。 */
      inject: ['slots', 'sessions', 'locale'],

      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, STRINGS), 'session-orb: dictionary');
        const t = ctx.locale.bind(NS);
        const sectionLabel = () => t('settings.section');

        const view = createStore({
          loaded: false,
          error: '',
          state: null,
          diag: null,
          diagOpen: false,
          busy: '',
          migrated: false,
        });

        let disposed = false;
        let pumpTimer = null;
        let patchTimer = null;
        let pendingPatch = null;
        let lastPollAt = 0;
        let lastRefreshAt = 0;
        let lastReportAt = 0;
        let lastTitlesAt = 0;
        let lastWakeAt = 0;
        let reportedVisible = null;
        let sentTitles = '';
        let lastError = '';

        // ---- 上报与采集 ------------------------------------------------------

        function readSessions() {
          try {
            const list = ctx.sessions === undefined || ctx.sessions === null ? null : ctx.sessions.list;
            if (list === undefined || list === null || typeof list.getSnapshot !== 'function') return null;
            const snapshot = list.getSnapshot();
            return snapshot !== null && typeof snapshot === 'object' ? snapshot : null;
          } catch (error) {
            return null;
          }
        }

        /** 收集「有标题的会话」并只把最近的一批送给 Host。Host 自己读不到标题。 */
        function collectTitles() {
          const snapshot = readSessions();
          if (snapshot === null) return null;
          const byId = snapshot.byId !== null && typeof snapshot.byId === 'object' ? snapshot.byId : null;
          if (byId === null) return null;
          const rows = [];
          const ids = Object.keys(byId);
          for (const id of ids) {
            const row = byId[id];
            const title = titleOf(row);
            if (title === '') continue;
            const raw = Number(row !== null && typeof row === 'object' ? row.updatedAt || row.createdAt || 0 : 0);
            rows.push({ id, title, at: Number.isFinite(raw) ? raw : 0 });
          }
          if (rows.length === 0) return null;
          rows.sort((left, right) => right.at - left.at);
          const out = {};
          const slice = rows.slice(0, TITLES_MAX);
          for (const item of slice) out[item.id] = item.title;
          return out;
        }

        function windowBox() {
          if (typeof window === 'undefined') return null;
          const x = Number(window.screenX);
          const y = Number(window.screenY);
          const w = Number(window.outerWidth);
          const outerH = Number(window.outerHeight);
          const innerH = Number(window.innerHeight);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
          if (!Number.isFinite(w) || !Number.isFinite(outerH)) return null;
          const chrome = Number.isFinite(innerH) ? Math.max(0, outerH - innerH) : 0;
          return { x, y: y + chrome, w, h: outerH };
        }

        async function refresh() {
          const payload = await request('/session-orb/state');
          if (disposed) return payload;
          lastRefreshAt = Date.now();
          view.set((current) => ({ ...current, loaded: true, state: payload }));
          return payload;
        }

        async function pushTitles(force) {
          const titles = collectTitles();
          if (titles === null) return;
          const json = JSON.stringify(titles);
          if (force !== true && json === sentTitles) return;
          lastTitlesAt = Date.now();
          await request('/session-orb/titles', { method: 'POST', body: { titles } });
          sentTitles = json;
        }

        async function report(note) {
          const visible = isPageVisible();
          const body = { visible, lang: detectLang(), url: String(location.href).slice(0, 200) };
          const box = windowBox();
          if (box !== null) body.box = box;
          if (typeof note === 'string' && note !== '') body.note = note.slice(0, 300);
          lastReportAt = Date.now();
          reportedVisible = visible;
          await request('/session-orb/report', { method: 'POST', body });
        }

        // ---- 指令 ------------------------------------------------------------

        /** 把 DSH 切到某个会话；没有 `uiWorkspace`（例如 Web 端未启用）时只报告。 */
        function openSession(sessionId) {
          if (typeof sessionId !== 'string' || sessionId === '') {
            void report('open-session failed: invalid sessionId');
            return false;
          }
          let workspace = null;
          try {
            workspace = ctx.get('uiWorkspace');
          } catch (error) {
            workspace = null;
          }
          if (workspace === null || workspace === undefined || typeof workspace.openSession !== 'function') {
            void report('open-session failed: uiWorkspace.openSession is unavailable');
            return false;
          }
          // `uiWorkspace.openSession(target)` 的 target 是 `SessionId | SubagentAddress`：
          // 字符串＝会话 id；对象只有 SubagentAddress（parentSessionId/childSessionId/mode）才合法。
          // 传 `{ sessionId }` 会被会话控制器读成 `target.childSessionId` = undefined，
          // 于是选中的会话被清空（UI 留在主页）且留下一个 id 为 undefined 的残留 scope。
          try {
            workspace.openSession(sessionId);
          } catch (error) {
            const message = String(error === null || error === undefined ? '' : error.message || error);
            void report('open-session threw: ' + message.slice(0, 200));
            return false;
          }
          return true;
        }

        async function drainCommands() {
          const payload = await request('/session-orb/commands');
          const commands = Array.isArray(payload.commands) ? payload.commands : [];
          for (const command of commands) {
            if (command === null || typeof command !== 'object') continue;
            if (command.type !== 'open-session') continue;
            const sessionId = typeof command.sessionId === 'string' ? command.sessionId : '';
            if (sessionId === '') continue;
            openSession(sessionId);
          }
          return commands.length;
        }

        // ---- 写入 ------------------------------------------------------------

        function normalizeError(error) {
          if (error === null || error === undefined) return 'unknown error';
          if (typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message;
          return String(error);
        }

        function flushPatch() {
          patchTimer = null;
          const patch = pendingPatch;
          pendingPatch = null;
          if (patch === null) return;
          request('/session-orb/settings', { method: 'POST', body: { patch } })
            .then((payload) => {
              if (disposed) return;
              const settings = payload !== null && payload.settings !== null && typeof payload.settings === 'object'
                ? normalizeSettings(payload.settings)
                : null;
              view.set((current) => {
                if (current.state === null || settings === null) return { ...current, error: '' };
                return { ...current, error: '', state: { ...current.state, settings } };
              });
            })
            .catch((error) => {
              if (disposed) return;
              view.set((current) => ({ ...current, error: normalizeError(error) }));
            });
        }

        /** 本地先落地（预览立刻跟手），120ms 后把改动合并成一次写回。 */
        function patchSettings(partial) {
          if (partial === null || partial === undefined || typeof partial !== 'object') return;
          view.set((current) => {
            if (current.state === null) return current;
            const merged = normalizeSettings({ ...current.state.settings, ...partial });
            return { ...current, state: { ...current.state, settings: merged } };
          });
          pendingPatch = { ...(pendingPatch === null ? {} : pendingPatch), ...partial };
          if (patchTimer !== null) clearTimeout(patchTimer);
          patchTimer = setTimeout(flushPatch, PATCH_MS);
        }

        async function action(name) {
          view.set((current) => ({ ...current, busy: name }));
          try {
            await request('/session-orb/action', { method: 'POST', body: { action: name } });
            await refresh();
            await pushTitles(false);
          } catch (error) {
            if (disposed) return;
            view.set((current) => ({ ...current, busy: '', error: normalizeError(error) }));
            return;
          }
          if (disposed) return;
          view.set((current) => ({ ...current, busy: '' }));
        }

        function resetLook() {
          patchSettings({
            fill: DEFAULTS.fill,
            opacity: DEFAULTS.opacity,
            size: DEFAULTS.size,
            radius: DEFAULTS.radius,
            bubbleAlpha: DEFAULTS.bubbleAlpha,
            bubbleMs: DEFAULTS.bubbleMs,
            confirmMs: DEFAULTS.confirmMs,
            pulse: DEFAULTS.pulse,
            badge: DEFAULTS.badge,
            visible: DEFAULTS.visible,
          });
        }

        async function toggleDiagnostics() {
          const open = view.getSnapshot().diagOpen;
          view.set((current) => ({ ...current, diagOpen: !open }));
          if (open || view.getSnapshot().diag !== null) return;
          try {
            const payload = await request('/session-orb/selfcheck');
            if (disposed) return;
            view.set((current) => ({ ...current, diag: payload }));
          } catch (error) {
            if (disposed) return;
            view.set((current) => ({ ...current, error: normalizeError(error) }));
          }
        }

        // ---- v1 迁移 ---------------------------------------------------------

        function readLegacyJson(key) {
          try {
            const raw = localStorage.getItem(key);
            if (raw === null || raw === '') return null;
            const parsed = JSON.parse(raw);
            return parsed !== null && typeof parsed === 'object' ? parsed : null;
          } catch (error) {
            return null;
          }
        }

        function clearLegacyKeys() {
          try {
            localStorage.removeItem(LEGACY_POS_KEY);
            localStorage.removeItem(LEGACY_SETTINGS_KEY);
          } catch (error) {
            /* 存储不可用时无所谓 */
          }
        }

        /**
         * v1 把设置和位置存在渲染器的 localStorage 里；Host 侧当时拿不到，所以现在
         * 是默认值。只在「Host 侧从未被写过」（位置为空 且 设置全是默认）时迁移
         * 一次，之后以 Host 为准，避免把用户后来的修改又按 v1 的老值盖回去。
         */
        async function migrateOnce() {
          let legacySettings = null;
          let legacyPosition = null;
          try {
            if (localStorage.getItem(MIGRATED_KEY) === '1') {
              clearLegacyKeys();
              return;
            }
            legacySettings = readLegacyJson(LEGACY_SETTINGS_KEY);
            legacyPosition = readLegacyJson(LEGACY_POS_KEY);
          } catch (error) {
            return;
          }
          if (legacySettings === null && legacyPosition === null) {
            try {
              localStorage.setItem(MIGRATED_KEY, '1');
            } catch (error) {
              /* ignore */
            }
            return;
          }
          let hostState = null;
          try {
            hostState = await request('/session-orb/state');
          } catch (error) {
            return;
          }
          const hostFresh =
            (hostState.position === null || hostState.position === undefined) && isDefaultSettings(hostState.settings);
          if (hostFresh) {
            const applied = [];
            try {
              if (legacySettings !== null) {
                await request('/session-orb/settings', {
                  method: 'POST',
                  body: { patch: normalizeSettings(legacySettings) },
                });
                applied.push('settings');
              }
              if (legacyPosition !== null) {
                const screen = viewportToScreen(legacyPosition);
                if (screen !== null) {
                  await request('/session-orb/position', { method: 'POST', body: screen });
                  applied.push('position');
                }
              }
            } catch (error) {
              /* 迁移是尽力而为；失败就保持 Host 现状，下一轮因为不再是默认值而自然跳过 */
              return;
            }
            if (applied.length > 0) {
              view.set((current) => ({ ...current, migrated: true }));
              try {
                await report('migrated v1 renderer state (' + applied.join('+') + ')');
              } catch (error) {
                /* ignore */
              }
            }
          }
          try {
            localStorage.setItem(MIGRATED_KEY, '1');
          } catch (error) {
            /* ignore */
          }
          clearLegacyKeys();
        }

        /**
         * v1 存的是「视口坐标」，原生窗口要的是「屏幕坐标」。加上窗口原点与边框
         * 偏移即可；本机 100% 缩放，CSS px 与物理 px 一比一。原生窗口还会把结果
         * 夹进最近的工作区，所以这里算偏一点也只会落到屏幕边缘。
         */
        function viewportToScreen(position) {
          if (position === null || typeof position !== 'object') return null;
          const x = Number(position.x);
          const y = Number(position.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
          if (typeof window === 'undefined') return null;
          const outerW = Number(window.outerWidth);
          const innerW = Number(window.innerWidth);
          const outerH = Number(window.outerHeight);
          const innerH = Number(window.innerHeight);
          const borderX = Number.isFinite(outerW) && Number.isFinite(innerW) ? Math.max(0, (outerW - innerW) / 2) : 0;
          const chromeY = Number.isFinite(outerH) && Number.isFinite(innerH) ? Math.max(0, outerH - innerH) : 0;
          const originX = Number.isFinite(Number(window.screenX)) ? Number(window.screenX) : 0;
          const originY = Number.isFinite(Number(window.screenY)) ? Number(window.screenY) : 0;
          return { x: Math.round(originX + borderX + x), y: Math.round(originY + chromeY + y) };
        }

        // ---- 轮询循环 --------------------------------------------------------

        function schedule(delay) {
          if (disposed) return;
          if (pumpTimer !== null) clearTimeout(pumpTimer);
          const fallback = isPageVisible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
          const wait = Number.isFinite(delay) ? Math.max(0, delay) : fallback;
          pumpTimer = setTimeout(() => {
            pumpTimer = null;
            void tick();
          }, wait);
        }

        async function tick() {
          if (disposed) return;
          const now = Date.now();
          lastPollAt = now;

          // ① 取指令。失败要显式暴露在设置页上，而不是静默吞掉。
          try {
            await drainCommands();
            if (lastError !== '') {
              lastError = '';
              view.set((current) => ({ ...current, error: '' }));
            }
          } catch (error) {
            const message = normalizeError(error);
            if (message !== lastError) {
              lastError = message;
              view.set((current) => ({ ...current, error: message }));
            }
          }

          // ② 上报：可见性一变立刻发，否则按心跳走。
          const visible = isPageVisible();
          if (reportedVisible !== visible || now - lastReportAt >= REPORT_MS) {
            try {
              await report();
            } catch (error) {
              /* 下一轮再说 */
            }
          }

          // ③ 状态与标题只在可见时刷（隐藏页的定时器本来就被压扁了）。
          if (visible) {
            if (now - lastRefreshAt >= REFRESH_MS) {
              try {
                await refresh();
              } catch (error) {
                /* 上面的 drainCommands 已经把错误显示过了 */
              }
            }
            if (now - lastTitlesAt >= TITLES_MS) {
              try {
                await pushTitles(false);
              } catch (error) {
                /* ignore */
              }
            }
          }

          schedule();
        }

        /** 唤醒：立刻打一次轮询，但同一时刻最多每 `WAKE_MIN_MS` 一次。 */
        function wake() {
          if (disposed) return;
          const now = Date.now();
          if (now - lastWakeAt < WAKE_MIN_MS) return;
          lastWakeAt = now;
          schedule(0);
        }

        const unbind = [];
        function listen(target, event, handler) {
          if (target === undefined || target === null || typeof target.addEventListener !== 'function') return;
          target.addEventListener(event, handler, true);
          unbind.push(() => target.removeEventListener(event, handler, true));
        }

        listen(document, 'visibilitychange', () => {
          if (isPageVisible()) wake();
        });
        listen(window, 'focus', wake);
        listen(document, 'pointerdown', wake);

        const api = {
          t,
          view,
          refresh,
          patch: patchSettings,
          resetLook,
          action,
          toggleDiagnostics,
        };

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: NS, order: 47, label: sectionLabel },
            () => h(OrbSettingsView, { api }),
          ),
        );

        ctx.effect(
          () => () => {
            disposed = true;
            if (pumpTimer !== null) {
              clearTimeout(pumpTimer);
              pumpTimer = null;
            }
            if (patchTimer !== null) {
              clearTimeout(patchTimer);
              patchTimer = null;
            }
            for (const off of unbind) {
              try {
                off();
              } catch (error) {
                /* ignore */
              }
            }
            unbind.length = 0;
          },
          'session-orb: command pump',
        );

        // 先迁移一次 v1 的浏览器状态，再拉首屏状态，最后开始轮询。
        void (async () => {
          try {
            await migrateOnce();
          } catch (error) {
            /* 迁移失败不影响使用 */
          }
          try {
            await refresh();
          } catch (error) {
            if (disposed) return;
            view.set((current) => ({ ...current, error: normalizeError(error) }));
          }
          try {
            await pushTitles(true);
            await report('renderer ready');
          } catch (error) {
            /* 上报失败下一轮补 */
          }
          lastPollAt = Date.now();
          schedule(0);
        })();
      },
    };
  },
});
