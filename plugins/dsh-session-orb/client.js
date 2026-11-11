/**
 * Session orb — 会话悬浮球（浏览器半边）。
 *
 * 屏幕上的一颗半透明黑色圆角小球（`shell.overlay` 槽位里的 frame 级浮层），
 * 有四个行为：
 *   ① **可拖动**：指针按住拖动改位置，位置存进 localStorage，窗口缩放时自动
 *      夹回可视区内（不会被拖到看不见的地方）。
 *   ② **可调透明度**：球体是 `rgba(0,0,0,var(--sorb-fill))` + 背景模糊，整体
 *      `opacity:var(--sorb-opacity)`；默认 30% 黑 / 88% 不透明，压在深色界面上
 *      是一层薄纱。这两个值（还有大小、圆角）都在设置页里实时改。
 *   ③ **会话完成提示**：某个会话从「进行中」变成「空闲」并且复查仍空闲时，在球
 *      **上方**弹一个小会话框，写该会话的名称；点它跳回该会话，点球清掉当前提示。
 *      多条完成会排队（最多 4 条），每条按设置里的时长自动收起，球角上的计数是
 *      还压着几条。一次 `running:false` 不算数（goal 会话轮间只抖 28–47ms），
 *      所以要等「完成确认窗口」（默认 2.5s）复查，期间又开始跑就把提示收回。
 *   ④ **设置页**：`settings.section` 里的一页（设置 → 会话悬浮球），调外观/行为、
 *      弹测试提示、复位位置；设置存 localStorage，改完立刻生效。
 *
 * 数据来源（全部是 Client 侧已确认存在的公开面）：
 *   · `ctx.sessions.list`（`createSnapshotStore`）——会话目录、`title` /
 *     `displayTitle`、`running`、`origin`。**列表是唯一事实来源**：
 *     `api-session/status` 只当作「去看一眼列表」的唤醒信号，避免两套状态
 *     互相打架。
 *   · `ctx.remote.$on('api-session/status')` —— 可选加速器；拿不到就只靠列表
 *     订阅（`typeof` 探测，不假设）。
 *   · `ctx.get('uiWorkspace').openSession({ sessionId })` —— 点击提示跳回会话。
 *
 * 生命周期全部挂在 `ctx.effect` / `ctx.slots.inject` 上，插件卸载时清定时器、
 * 退订列表、注销事件。
 *
 * @module dsh-session-orb/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-orb',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-session-orb';
    /** 位置持久化键（每个浏览器/设备各自记住自己的位置）。 */
    const POS_KEY = 'dsh.sessionOrb.position.v1';
    /** 球体边长，与 CSS 里的 56px 必须一致。 */
    const ORB_SIZE = 56;
    /** 默认位置离右下角的距离。 */
    const EDGE = 18;
    /** 每条提示的停留时长。 */
    const BUBBLE_MS = 8000;
    /** 最多排队几条完成提示。 */
    const MAX_QUEUE = 4;
    /** 设置页「弹一条测试提示」用的假会话 id；点它不跳转。 */
    const TEST_ID = '__session_orb_test__';
    /** 位移超过这个像素数才算「拖动」，否则算点击。 */
    const DRAG_SLOP = 3;
    /** 球离顶部这么近时，提示改到球下方，避免被视口切掉。 */
    const FLIP_TOP = 132;
    /**
     * 一次 running 变 false 不能直接当「会话完成」：真实观测到 goal 会话的 `running`
     * 只在 step 边界抖 **28–47ms**，旧逻辑（立即弹）就是这种误报。这里等一小段再复查：
     * 仍然没在跑才算完成；期间又开始跑就把提示收回。
     */
    const DONE_CONFIRM_MS = 2500;

    /** 设置持久化键（每个浏览器/设备各自一份）。 */
    const SETTINGS_KEY = 'dsh.sessionOrb.settings.v1';
    /**
     * 默认外观 / 行为。透明度偏「玻璃」：默认只有 30% 的黑，压在深色界面上是一层薄纱，
     * 想要更实可以在设置页里拉高。
     */
    const DEFAULT_SETTINGS = {
      fill: 0.3,
      opacity: 0.88,
      size: ORB_SIZE,
      radius: 17,
      bubbleAlpha: 0.92,
      bubbleMs: BUBBLE_MS,
      confirmMs: DONE_CONFIRM_MS,
      pulse: true,
      badge: true,
    };
    const SETTING_LIMITS = {
      fill: [0.08, 0.9],
      opacity: [0.25, 1],
      size: [40, 80],
      radius: [4, 40],
      bubbleAlpha: [0.5, 1],
      bubbleMs: [2000, 30000],
      confirmMs: [0, 15000],
    };

    const STRINGS = {
      zh: {
        'orb.label': '会话悬浮球',
        'orb.drag': '按住可拖动',
        'bubble.done': '会话完成',
        'bubble.unnamed': '未命名会话',
        'bubble.open': '点击打开这个会话',
        'bubble.dismiss': '收起这条提示',
        'bubble.more': '还有 {n} 条',
        'settings.section': '会话悬浮球',
        'settings.title': '会话悬浮球',
        'settings.desc': '屏幕右下角那颗半透明黑球：拖到哪里、多透明、弹多久，都在这里调。改完立刻生效，不用刷新。',
        'settings.group.look': '外观',
        'settings.group.behavior': '行为',
        'settings.fill': '球体填充浓度',
        'settings.fill.hint': '黑色填充的不透明度，越低越透',
        'settings.opacity': '整体不透明度',
        'settings.size': '球体大小',
        'settings.radius': '圆角',
        'settings.bubbleAlpha': '提示框不透明度',
        'settings.bubbleMs': '提示停留时长',
        'settings.confirmMs': '完成确认窗口',
        'settings.confirmMs.hint': '先等这么久再复查，仍在跑就不弹 —— 防 goal 会话轮间抖动误报；0 = 立刻弹',
        'settings.pulse': '运行时有呼吸脉冲',
        'settings.badge': '球角显示待看条数',
        'settings.preview': '实时预览',
        'settings.test': '弹一条测试提示',
        'settings.testBubble': '这是一条测试提示，长相就是真提示的样子。',
        'settings.reset.position': '复位到右下角',
        'settings.reset.defaults': '恢复默认外观',
        'settings.note': '设置只存在本机浏览器（localStorage），不同设备各调各的。',
      },
      en: {
        'orb.label': 'Session orb',
        'orb.drag': 'Drag to move',
        'bubble.done': 'Session finished',
        'bubble.unnamed': 'Untitled session',
        'bubble.open': 'Click to open this session',
        'bubble.dismiss': 'Dismiss this notice',
        'bubble.more': '{n} more',
        'settings.section': 'Session orb',
        'settings.title': 'Session orb',
        'settings.desc': 'The translucent black orb in the corner: where it sits, how see-through it is, how long a notice stays. Changes apply immediately.',
        'settings.group.look': 'Appearance',
        'settings.group.behavior': 'Behaviour',
        'settings.fill': 'Orb fill density',
        'settings.fill.hint': 'Opacity of the black fill — lower is more transparent',
        'settings.opacity': 'Overall opacity',
        'settings.size': 'Orb size',
        'settings.radius': 'Corner radius',
        'settings.bubbleAlpha': 'Notice opacity',
        'settings.bubbleMs': 'Notice duration',
        'settings.confirmMs': 'Completion confirm window',
        'settings.confirmMs.hint': 'Wait this long, then re-check: still running means no notice. Stops goal sessions from false-alarming; 0 = immediate',
        'settings.pulse': 'Pulse while running',
        'settings.badge': 'Show queued count on the orb',
        'settings.preview': 'Live preview',
        'settings.test': 'Pop a test notice',
        'settings.testBubble': 'A test notice — this is what a real one looks like.',
        'settings.reset.position': 'Move to bottom-right',
        'settings.reset.defaults': 'Reset appearance',
        'settings.note': 'Settings live in this browser (localStorage); each device tunes its own.',
      },
    };

    // ---- styles -----------------------------------------------------------
    // 球体是「作品」而不是界面皮肤，所以这里用字面颜色（黑色半透明玻璃 + 白字），
    // 不依赖主题 token：深浅两套主题下它都是同一颗黑球，会话框也沿用同一块玻璃，
    // 视觉上是一体的。
    const CSS = [
      '.sorb_layer{position:fixed;inset:0;z-index:40;pointer-events:none;font-family:inherit;line-height:1.4}',
      '.sorb_box{position:absolute;width:var(--sorb-size,' + ORB_SIZE + 'px);height:var(--sorb-size,' + ORB_SIZE + 'px);pointer-events:none}',
      // 球体：半透明黑色、圆角、背景模糊；静止略透明，悬停/拖动变实。
      '.sorb_ball{position:absolute;inset:0;box-sizing:border-box;display:flex;align-items:center;justify-content:center;',
      // 纯黑而非 #0c0d11：深色界面上只有纯黑填充才和背景拉开层次（实测 #0c0d11 只差 4 灰阶，
      // 球体几乎隐形）。填充浓度与整体不透明度都走 CSS 变量，由设置页实时改。
      'padding:0;margin:0;border:1px solid rgba(255,255,255,.17);border-radius:var(--sorb-radius,17px);background:rgba(0,0,0,var(--sorb-fill,.3));',
      '-webkit-backdrop-filter:blur(12px) saturate(150%);backdrop-filter:blur(12px) saturate(150%);',
      'box-shadow:0 8px 22px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.14),inset 0 0 0 1px rgba(255,255,255,.05);',
      'color:#fff;cursor:grab;',
      'pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;',
      'opacity:var(--sorb-opacity,.88);transition:opacity .18s ease,box-shadow .18s ease,transform .18s ease}',
      '.sorb_ball:hover{opacity:min(1,calc(var(--sorb-opacity,.88) + .12));box-shadow:0 10px 26px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.22),inset 0 0 0 1px rgba(255,255,255,.07)}',
      '.sorb_ball:focus-visible{outline:2px solid rgba(255,255,255,.72);outline-offset:3px}',
      '.sorb_ball.is-dragging{cursor:grabbing;opacity:1;transition:none;transform:scale(1.03)}',
      // 有会话在跑时，一圈很淡的脉冲；不跑就没有。
      '.sorb_ring{position:absolute;inset:-1px;border-radius:inherit;border:1px solid rgba(255,255,255,.5);opacity:0;pointer-events:none}',
      '.sorb_ball.is-running .sorb_ring{animation:sorb-pulse 2.6s cubic-bezier(.22,.61,.36,1) infinite}',
      '.sorb_ball.no-pulse .sorb_ring{display:none}',
      '@keyframes sorb-pulse{0%{opacity:.45;transform:scale(1)}70%{opacity:0;transform:scale(1.32)}100%{opacity:0;transform:scale(1.32)}}',
      '.sorb_core{width:calc(var(--sorb-size,' + ORB_SIZE + 'px) * .214);height:calc(var(--sorb-size,' + ORB_SIZE + 'px) * .214);border-radius:50%;background:rgba(255,255,255,.92);box-shadow:0 0 10px rgba(255,255,255,.45)}',
      '.sorb_badge{position:absolute;top:5px;right:5px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;',
      'background:#ff5f57;color:#fff;font-size:10px;font-weight:600;line-height:16px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.35)}',
      // 会话框：同款黑玻璃，贴在球上方（贴边时自动换锚点/翻到下方）。
      '.sorb_bubble{position:absolute;display:flex;flex-direction:column;gap:2px;box-sizing:border-box;',
      'width:max-content;max-width:min(300px,calc(100vw - 28px));padding:9px 12px 10px;',
      'border:1px solid rgba(255,255,255,.14);border-radius:13px;background:rgba(8,9,12,var(--sorb-bubble,.92));color:#f5f6f8;',
      'text-align:left;font:inherit;pointer-events:auto;cursor:pointer;',
      '-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);',
      'box-shadow:0 12px 30px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.09);',
      'animation:sorb-fade .16s ease-out both}',
      '.sorb_bubble.is-above{bottom:calc(100% + 10px)}',
      '.sorb_bubble.is-below{top:calc(100% + 10px)}',
      '.sorb_bubble.is-left{left:0}',
      '.sorb_bubble.is-right{right:0}',
      '.sorb_bubble.is-center{left:50%;transform:translateX(-50%)}',
      '@keyframes sorb-fade{from{opacity:0}to{opacity:1}}',
      '.sorb_bubble:hover{background:rgba(16,17,22,min(1,calc(var(--sorb-bubble,.92) + .06)))}',
      '.sorb_bubbleKicker{display:flex;align-items:center;gap:6px;font-size:11px;line-height:14px;color:rgba(255,255,255,.62)}',
      '.sorb_blip{width:5px;height:5px;border-radius:50%;background:#4ade80;box-shadow:0 0 6px rgba(74,222,128,.8);flex:0 0 auto}',
      '.sorb_bubbleTitle{-webkit-line-clamp:2;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden;',
      'font-size:13.5px;line-height:19px;font-weight:500;color:#f7f8fa;overflow-wrap:anywhere}',
      '.sorb_bubbleMore{font-size:11px;line-height:14px;color:rgba(255,255,255,.5);margin-top:2px}',
      '.sorb_bubbleClose{position:absolute;top:-7px;right:-7px;width:18px;height:18px;padding:0;border:1px solid rgba(255,255,255,.16);',
      'border-radius:50%;background:rgba(30,31,38,.96);color:rgba(255,255,255,.72);font-size:12px;line-height:15px;',
      'text-align:center;cursor:pointer;pointer-events:auto}',
      '.sorb_bubbleClose:hover{color:#fff;background:rgba(48,49,58,.98)}',
      // ---- 设置页（settings.section）——用主题 token，深浅主题都跟着走 ----
      '.sorb_set{display:flex;flex-direction:column;gap:16px;padding:2px 2px 28px;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.sorb_setHead{display:flex;flex-direction:column;gap:4px}',
      '.sorb_setTitle{font-size:15px;line-height:1.4;font-weight:600}',
      '.sorb_setDesc{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
      '.sorb_setCard{display:flex;flex-direction:column;gap:14px;padding:14px;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:var(--dsw-radius-sm,10px);background:var(--dsw-alias-bg-layer-1)}',
      '.sorb_setCardTitle{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary)}',
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
      '.sorb_setStage{display:flex;align-items:center;justify-content:center;gap:20px;height:104px;padding:0 14px;',
      'border:1px dashed var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,10px);background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.sorb_setBallBox{position:relative;flex:0 0 auto;width:var(--sorb-size,' + ORB_SIZE + 'px);height:var(--sorb-size,' + ORB_SIZE + 'px)}',
      '.sorb_setBubbleSample{position:relative;inset:auto;left:auto;right:auto;bottom:auto;top:auto;transform:none;animation:none;cursor:default}',
      '.sorb_setActions{display:flex;flex-wrap:wrap;gap:8px}',
      '.sorb_setBtn{font:inherit;font-size:12px;line-height:1;padding:8px 12px;border-radius:var(--dsw-radius-sm,8px);',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;',
      'transition:border-color .15s ease,background .15s ease}',
      '.sorb_setBtn:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.sorb_setBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.sorb_setNote{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '@media (prefers-reduced-motion:reduce){.sorb_ball.is-running .sorb_ring{animation:none}.sorb_bubble{animation:none}}',
    ].join('');

    (function injectCss() {
      if (typeof document === 'undefined') return;
      const tagId = NS + '/orb.css';
      try {
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return;
        const tag = document.createElement('style');
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (error) {
        /* a head-less environment simply renders unstyled */
      }
    })();

    // ---- tiny store -------------------------------------------------------
    /**
     * 最小 snapshot store：`getSnapshot` 返回稳定引用，`set` 换引用并通知。
     * 满足 `useSyncExternalStore` 的契约（快照只在真的变了以后换引用）。
     * @param {object} initial
     */
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        getSnapshot() {
          return state;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set(next) {
          const value = typeof next === 'function' ? next(state) : next;
          if (value === state) return;
          state = value;
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch (error) {
              /* one bad listener must not stop the others */
            }
          }
        },
      };
    }

    // ---- module-scope bindings written by apply() -------------------------
    /** @type {ReturnType<typeof createStore> | null} */
    let store = null;
    /** @type {ReturnType<typeof createStore> | null} 外观/行为设置，挂在模块上让浮层和设置页共用一个快照 */
    let settingsStore = null;
    /** @type {{t: Function, openSession: Function, onBallClick: Function, dismiss: Function, report: Function} | null} */
    let handlers = null;

    // ---- geometry ---------------------------------------------------------
    /**
     * 把位置夹进浮层可视区。
     * @param {{x: number, y: number}} pos
     * @param {{w: number, h: number}} box
     * @param {number} [size] 球边长，默认取当前设置
     */
    function clampPos(pos, box, size) {
      const side = Number.isFinite(size) ? size : orbSize();
      const maxX = Math.max(0, box.w - side);
      const maxY = Math.max(0, box.h - side);
      const x = Math.min(Math.max(0, pos.x), maxX);
      const y = Math.min(Math.max(0, pos.y), maxY);
      return x === pos.x && y === pos.y ? pos : { x, y };
    }

    /** @param {{w: number, h: number}} box */
    function defaultPos(box) {
      const side = orbSize();
      return clampPos({ x: box.w - side - EDGE, y: box.h - side - EDGE }, box, side);
    }

    function readStoredPos() {
      try {
        const raw = localStorage.getItem(POS_KEY);
        if (typeof raw !== 'string' || raw === '') return null;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return null;
        const x = Number(parsed.x);
        const y = Number(parsed.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { x, y };
      } catch (error) {
        return null;
      }
    }

    /** @param {{x: number, y: number}} pos */
    function writeStoredPos(pos) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }));
      } catch (error) {
        /* private mode / quota: the orb simply forgets its place */
      }
    }

    function clampNumber(value, min, max, fallback) {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    }

    /**
     * 把任意来路的设置收敛成合法值：越界夹回来、类型不对用默认值、
     * 圆角不超过半个球（否则就不是圆角方块了）。
     * @param {unknown} raw
     */
    function normalizeSettings(raw) {
      const base = DEFAULT_SETTINGS;
      const src = raw !== null && typeof raw === 'object' ? raw : {};
      const size = Math.round(clampNumber(src.size, SETTING_LIMITS.size[0], SETTING_LIMITS.size[1], base.size));
      const radius = Math.round(clampNumber(src.radius, SETTING_LIMITS.radius[0], Math.min(SETTING_LIMITS.radius[1], size / 2), base.radius));
      return {
        fill: clampNumber(src.fill, SETTING_LIMITS.fill[0], SETTING_LIMITS.fill[1], base.fill),
        opacity: clampNumber(src.opacity, SETTING_LIMITS.opacity[0], SETTING_LIMITS.opacity[1], base.opacity),
        size,
        radius,
        bubbleAlpha: clampNumber(src.bubbleAlpha, SETTING_LIMITS.bubbleAlpha[0], SETTING_LIMITS.bubbleAlpha[1], base.bubbleAlpha),
        bubbleMs: Math.round(clampNumber(src.bubbleMs, SETTING_LIMITS.bubbleMs[0], SETTING_LIMITS.bubbleMs[1], base.bubbleMs)),
        confirmMs: Math.round(clampNumber(src.confirmMs, SETTING_LIMITS.confirmMs[0], SETTING_LIMITS.confirmMs[1], base.confirmMs)),
        pulse: src.pulse === undefined ? base.pulse : src.pulse !== false,
        badge: src.badge === undefined ? base.badge : src.badge !== false,
      };
    }

    function readStoredSettings() {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (typeof raw !== 'string' || raw === '') return normalizeSettings(null);
        return normalizeSettings(JSON.parse(raw));
      } catch (error) {
        return normalizeSettings(null);
      }
    }

    /** @param {object} settings */
    function writeStoredSettings(settings) {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch (error) {
        /* private mode / quota: 设置只在本次页面存活期间生效 */
      }
    }

    /** 球体边长：设置里那份是唯一来源（几何计算都走这里）。 */
    function orbSize() {
      return settingsStore === null ? ORB_SIZE : settingsStore.getSnapshot().size;
    }

    function currentSettings() {
      return settingsStore === null ? DEFAULT_SETTINGS : settingsStore.getSnapshot();
    }

    /** 诊断用：localStorage 到底能不能读写（自定义协议下被禁声时，这是唯一的线索）。 */
    function storageProbe() {
      try {
        const key = POS_KEY + '.probe';
        localStorage.setItem(key, '1');
        const ok = localStorage.getItem(key) === '1';
        localStorage.removeItem(key);
        return ok ? 'ok' : 'readback-mismatch';
      } catch (error) {
        const name = error !== null && error !== undefined && typeof error.name === 'string' ? error.name : 'unknown';
        return 'error:' + name;
      }
    }

    function detectLang() {
      try {
        const html = typeof document !== 'undefined' ? document.documentElement : null;
        const raw = (html !== null && html.lang) || (typeof navigator !== 'undefined' ? navigator.language : '') || 'zh';
        return /^zh/i.test(String(raw)) ? 'zh' : 'en';
      } catch (error) {
        return 'zh';
      }
    }

    // ---- the overlay entry ------------------------------------------------
    /**
     * 订阅设置快照。设置页和浮层看同一份 state：改设置 → 两边一起重渲染，
     * 球当场变形/变透明，不需要刷新页面。
     */
    function useSettings() {
      const [snapshot, setSnapshot] = React.useState(() => currentSettings());
      React.useEffect(() => {
        if (settingsStore === null) return undefined;
        setSnapshot(settingsStore.getSnapshot());
        return settingsStore.subscribe(() => setSnapshot(settingsStore.getSnapshot()));
      }, []);
      return snapshot;
    }

    /**
     * `shell.overlay` 的浮层条目。整层 `pointer-events:none`（浮层本身是点击穿透的），
     * 只有球和会话框把指针事件收回自己身上。
     */
    function OrbLayer() {
      const subscribe = React.useCallback((listener) => (store === null ? () => {} : store.subscribe(listener)), []);
      const getSnapshot = React.useCallback(
        () => (store === null ? { queue: [], running: 0, posNonce: 0 } : store.getSnapshot()),
        [],
      );
      const state = React.useSyncExternalStore(subscribe, getSnapshot);
      const settings = useSettings();

      const layerRef = React.useRef(null);
      const boxRef = React.useRef(null);
      const posRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const reportedRef = React.useRef(false);
      const storedRef = React.useRef(null);
      const [box, setBox] = React.useState(null);
      const [pos, setPos] = React.useState(null);
      const [initialized, setInitialized] = React.useState(false);
      const [dragging, setDragging] = React.useState(false);
      // 没被拖过时位置是推导出来的（永远贴右下角，窗口一变就跟着变）；
      // 拖过以后才有自己的坐标，只需要夹回可视区。
      const renderPos = pos !== null ? pos : box !== null ? defaultPos(box) : null;
      boxRef.current = box;
      posRef.current = renderPos;

      // 浮层矩形就是这个组件的坐标系：拖动、夹边、放置都换算到这里，
      // 所以外层就算被 transform 过也不会错位。
      React.useLayoutEffect(() => {
        const el = layerRef.current;
        if (el === null) return undefined;
        const measure = () => {
          const rect = el.getBoundingClientRect();
          const minSide = orbSize();
          const w = Math.max(minSide, Math.round(rect.width));
          const hgt = Math.max(minSide, Math.round(rect.height));
          if (w <= 0 || hgt <= 0) return;
          setBox((prev) => (prev !== null && prev.w === w && prev.h === hgt ? prev : { w, h: hgt }));
        };
        measure();
        let observer = null;
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure);
          observer.observe(el);
        }
        window.addEventListener('resize', measure);
        return () => {
          if (observer !== null) observer.disconnect();
          window.removeEventListener('resize', measure);
        };
      }, []);

      // 首次落位：记得住就复原（并夹回可视区），记不得就右下角。
      React.useEffect(() => {
        if (box === null || initialized) return;
        setInitialized(true);
        const stored = readStoredPos();
        storedRef.current = stored === null ? null : { x: Math.round(stored.x), y: Math.round(stored.y) };
        if (stored !== null) setPos(clampPos(stored, box));
      }, [box, initialized]);

      // 窗口尺寸变了以后别把球留在可视区外面（没拖过的球则继续贴右下角）。
      React.useEffect(() => {
        if (box === null) return;
        setPos((prev) => (prev === null ? prev : clampPos(prev, box)));
      }, [box]);

      // 球变大以后同样要夹回来，否则右/下边缘会被裁掉半颗。
      React.useEffect(() => {
        if (box === null) return;
        setPos((prev) => (prev === null ? prev : clampPos(prev, box, settings.size)));
      }, [settings.size, box]);

      // 设置页点「复位到右下角」：丢掉记着的位置，回到推导出来的角落。
      React.useEffect(() => {
        if (!(state.posNonce > 0)) return;
        storedRef.current = null;
        setPos(null);
      }, [state.posNonce]);

      React.useEffect(() => {
        // 等复原落地后再报：首次提交时 pos 还是 null，报出去的是默认角，会误导诊断。
        if (reportedRef.current || box === null || !initialized) return;
        const settled = posRef.current;
        if (settled === null) return;
        reportedRef.current = true;
        handlers?.report({
          event: 'mounted',
          box,
          pos: { x: Math.round(settled.x), y: Math.round(settled.y) },
          stored: storedRef.current,
        });
      }, [box, initialized, renderPos]);

      const beginDrag = (event) => {
        const origin = renderPos;
        if (origin === null) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const layer = layerRef.current;
        if (layer === null) return;
        const rect = layer.getBoundingClientRect();
        dragRef.current = {
          pointerId: event.pointerId,
          offsetX: event.clientX - rect.left - origin.x,
          offsetY: event.clientY - rect.top - origin.y,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        };
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch (error) {
          /* pointer capture is best-effort: plain pointermove still works */
        }
        setDragging(true);
      };

      const moveDrag = (event) => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) return;
        const layer = layerRef.current;
        const area = boxRef.current;
        if (layer === null || area === null) return;
        if (!drag.moved) {
          const moved = Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY);
          if (moved <= DRAG_SLOP) return;
          drag.moved = true;
        }
        const rect = layer.getBoundingClientRect();
        const next = clampPos({
          x: event.clientX - rect.left - drag.offsetX,
          y: event.clientY - rect.top - drag.offsetY,
        }, area);
        // 记在 drag 上：pointerup 可能紧接着 pointermove 到达，此时 React 还没
        // 渲染完，读 ref 会慢一帧。
        drag.last = next;
        setPos(next);
      };

      const endDrag = (event) => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
        try {
          event.currentTarget.releasePointerCapture(drag.pointerId);
        } catch (error) {
          /* already released */
        }
        if (!drag.moved) {
          handlers?.onBallClick();
          return;
        }
        const settled = drag.last ?? posRef.current;
        if (settled !== null) {
          writeStoredPos(settled);
          handlers?.report({ event: 'drag', pos: { x: Math.round(settled.x), y: Math.round(settled.y) } });
        }
      };

      const tr = (key) => (handlers === null ? key : handlers.t(key));
      const queue = state.queue;
      const current = queue.length > 0 ? queue[0] : null;
      const running = state.running > 0;
      const below = renderPos !== null && renderPos.y < FLIP_TOP;
      const centerX = renderPos === null ? 0 : renderPos.x + settings.size / 2;
      const side = box === null ? 'center' : centerX < box.w * 0.34 ? 'left' : centerX > box.w * 0.66 ? 'right' : 'center';

      const bubble = current === null ? null : h('div', {
        key: current.id,
        role: 'button',
        tabIndex: 0,
        className: 'sorb_bubble is-' + side + (below ? ' is-below' : ' is-above'),
        title: tr('bubble.open'),
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          handlers?.openSession(current.id);
        },
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          handlers?.openSession(current.id);
        },
      },
      h('span', { className: 'sorb_bubbleKicker' },
        h('span', { className: 'sorb_blip', 'aria-hidden': 'true' }),
        tr('bubble.done'),
      ),
      h('span', { className: 'sorb_bubbleTitle' }, current.title === '' ? tr('bubble.unnamed') : current.title),
      queue.length > 1 ? h('span', { className: 'sorb_bubbleMore' }, tr('bubble.more').replace('{n}', String(queue.length - 1))) : null,
      h('button', {
        type: 'button',
        className: 'sorb_bubbleClose',
        'aria-label': tr('bubble.dismiss'),
        title: tr('bubble.dismiss'),
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          handlers?.dismiss();
        },
      }, '×'),
      );

      const ball = h('button', {
        type: 'button',
        className: 'sorb_ball' + (dragging ? ' is-dragging' : '') + (running ? ' is-running' : '') + (settings.pulse ? '' : ' no-pulse'),
        'aria-label': tr('orb.label'),
        title: tr('orb.label') + ' · ' + tr('orb.drag'),
        onPointerDown: beginDrag,
        onPointerMove: moveDrag,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
        onContextMenu: (event) => event.preventDefault(),
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          handlers?.onBallClick();
        },
      },
      h('span', { className: 'sorb_ring', 'aria-hidden': 'true' }),
      h('span', { className: 'sorb_core', 'aria-hidden': 'true' }),
      queue.length > 0 && settings.badge ? h('span', { className: 'sorb_badge' }, String(Math.min(queue.length, 9))) : null,
      );

      return h('div', {
        className: 'sorb_layer',
        ref: layerRef,
        style: {
          '--sorb-size': settings.size + 'px',
          '--sorb-radius': settings.radius + 'px',
          '--sorb-fill': String(settings.fill),
          '--sorb-opacity': String(settings.opacity),
          '--sorb-bubble': String(settings.bubbleAlpha),
        },
      },
        renderPos === null ? null : h('div', {
          className: 'sorb_box',
          style: { left: renderPos.x + 'px', top: renderPos.y + 'px' },
          'aria-live': 'polite',
        }, bubble, ball),
      );
    }

    // ---- the settings page ------------------------------------------------
    /**
     * `settings.section` 里的一页。只动本插件自己的设置：合并 → 收敛 → 写
     * localStorage → 推共享快照；浮层和下面的预览吃同一份快照，所以拖一格就当场见效。
     */
    function OrbSettingsPage() {
      const settings = useSettings();
      const tr = React.useCallback((key) => (handlers === null ? key : handlers.t(key)), []);

      const patch = React.useCallback((partial) => {
        if (settingsStore === null) return;
        const next = normalizeSettings({ ...settingsStore.getSnapshot(), ...partial });
        settingsStore.set(next);
        writeStoredSettings(next);
      }, []);

      const pct = (value) => Math.round(value * 100) + '%';
      const secs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1) + 's' : ms + 'ms');

      const slider = (opts) => h('div', { className: 'sorb_setRow', key: opts.key },
        h('div', { className: 'sorb_setLabel' },
          h('span', { className: 'sorb_setName' }, opts.label),
          opts.hint === undefined ? null : h('span', { className: 'sorb_setHint' }, opts.hint)),
        h('input', {
          type: 'range',
          className: 'sorb_setRange',
          min: opts.min,
          max: opts.max,
          step: opts.step,
          value: opts.value,
          'aria-label': opts.label,
          onChange: (event) => patch({ [opts.key]: Number(event.currentTarget.value) }),
        }),
        h('span', { className: 'sorb_setVal' }, opts.display));

      const check = (key, label) => h('label', { className: 'sorb_setCheck', key },
        h('input', {
          type: 'checkbox',
          checked: settings[key] === true,
          onChange: (event) => patch({ [key]: event.currentTarget.checked }),
        }),
        label);

      const vars = {
        '--sorb-size': settings.size + 'px',
        '--sorb-radius': settings.radius + 'px',
        '--sorb-fill': String(settings.fill),
        '--sorb-opacity': String(settings.opacity),
        '--sorb-bubble': String(settings.bubbleAlpha),
      };

      return h('div', { className: 'sorb_set' },
        h('div', { className: 'sorb_setHead' },
          h('div', { className: 'sorb_setTitle' }, tr('settings.title')),
          h('div', { className: 'sorb_setDesc' }, tr('settings.desc'))),
        // 预览直接用球体/提示框本身的 class：这里看到的颜色就是屏幕上的颜色。
        h('div', { className: 'sorb_setStage', style: vars },
          h('div', { className: 'sorb_setBallBox' },
            h('div', { className: 'sorb_ball', style: { cursor: 'default', pointerEvents: 'none' } },
              h('span', { className: 'sorb_ring', 'aria-hidden': 'true' }),
              h('span', { className: 'sorb_core', 'aria-hidden': 'true' }))),
          h('div', { className: 'sorb_bubble is-left sorb_setBubbleSample' },
            h('span', { className: 'sorb_bubbleKicker' },
              h('span', { className: 'sorb_blip', 'aria-hidden': 'true' }),
              tr('bubble.done')),
            h('span', { className: 'sorb_bubbleTitle' }, tr('settings.preview')))),
        h('div', { className: 'sorb_setCard' },
          h('div', { className: 'sorb_setCardTitle' }, tr('settings.group.look')),
          slider({
            key: 'fill', label: tr('settings.fill'), hint: tr('settings.fill.hint'),
            min: SETTING_LIMITS.fill[0], max: SETTING_LIMITS.fill[1], step: 0.01,
            value: settings.fill, display: pct(settings.fill),
          }),
          slider({
            key: 'opacity', label: tr('settings.opacity'),
            min: SETTING_LIMITS.opacity[0], max: SETTING_LIMITS.opacity[1], step: 0.01,
            value: settings.opacity, display: pct(settings.opacity),
          }),
          slider({
            key: 'size', label: tr('settings.size'),
            min: SETTING_LIMITS.size[0], max: SETTING_LIMITS.size[1], step: 1,
            value: settings.size, display: settings.size + 'px',
          }),
          slider({
            key: 'radius', label: tr('settings.radius'),
            min: SETTING_LIMITS.radius[0], max: Math.min(SETTING_LIMITS.radius[1], Math.round(settings.size / 2)), step: 1,
            value: settings.radius, display: settings.radius + 'px',
          }),
          slider({
            key: 'bubbleAlpha', label: tr('settings.bubbleAlpha'),
            min: SETTING_LIMITS.bubbleAlpha[0], max: SETTING_LIMITS.bubbleAlpha[1], step: 0.01,
            value: settings.bubbleAlpha, display: pct(settings.bubbleAlpha),
          })),
        h('div', { className: 'sorb_setCard' },
          h('div', { className: 'sorb_setCardTitle' }, tr('settings.group.behavior')),
          slider({
            key: 'bubbleMs', label: tr('settings.bubbleMs'),
            min: SETTING_LIMITS.bubbleMs[0], max: SETTING_LIMITS.bubbleMs[1], step: 500,
            value: settings.bubbleMs, display: secs(settings.bubbleMs),
          }),
          slider({
            key: 'confirmMs', label: tr('settings.confirmMs'), hint: tr('settings.confirmMs.hint'),
            min: SETTING_LIMITS.confirmMs[0], max: 10000, step: 250,
            value: settings.confirmMs, display: secs(settings.confirmMs),
          }),
          h('div', { className: 'sorb_setChecks' },
            check('pulse', tr('settings.pulse')),
            check('badge', tr('settings.badge')))),
        h('div', { className: 'sorb_setActions' },
          h('button', {
            type: 'button', className: 'sorb_setBtn',
            onClick: () => handlers?.testBubble(),
          }, tr('settings.test')),
          h('button', {
            type: 'button', className: 'sorb_setBtn',
            onClick: () => handlers?.resetPosition(),
          }, tr('settings.reset.position')),
          h('button', {
            type: 'button', className: 'sorb_setBtn',
            onClick: () => patch(DEFAULT_SETTINGS),
          }, tr('settings.reset.defaults'))),
        h('div', { className: 'sorb_setNote' }, tr('settings.note')));
    }

    // ---- plugin -----------------------------------------------------------
    return {
      inject: ['slots', 'sessions', 'remote', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, STRINGS), 'session-orb: dictionary');
        const t = ctx.locale.bind(NS);

        settingsStore = createStore(readStoredSettings());
        store = createStore({ queue: [], running: 0, lang: detectLang(), posNonce: 0 });

        let disposed = false;
        let dismissTimer = null;
        /** 上一轮每个会话的运行状态；第一次只记账不触发。 */
        let previousRunning = new Map();
        let baseline = false;
        let statusEvents = 0;
        /** 已发生 running→false 但还在等复查的会话：id -> { timer, at } */
        const pendingConfirm = new Map();
        let confirmedCount = 0;
        let suppressedCount = 0;
        let retractedCount = 0;

        const readList = () => {
          try {
            const list = ctx.sessions?.list;
            if (list === undefined || list === null || typeof list.getSnapshot !== 'function') return null;
            const snapshot = list.getSnapshot();
            return snapshot !== null && typeof snapshot === 'object' ? snapshot : null;
          } catch (error) {
            return null;
          }
        };

        const titleOf = (row) => {
          if (row === null || row === undefined) return '';
          if (typeof row.title === 'string' && row.title !== '') return row.title;
          if (typeof row.displayTitle === 'string' && row.displayTitle !== '') return row.displayTitle;
          return '';
        };

        const scheduleDismiss = () => {
          if (dismissTimer !== null || disposed) return;
          if (store.getSnapshot().queue.length === 0) return;
          dismissTimer = setTimeout(() => {
            dismissTimer = null;
            advance();
          }, currentSettings().bubbleMs);
        };

        const advance = () => {
          if (dismissTimer !== null) {
            clearTimeout(dismissTimer);
            dismissTimer = null;
          }
          const queue = store.getSnapshot().queue;
          if (queue.length === 0) return;
          store.set((state) => ({ ...state, queue: state.queue.slice(1) }));
          scheduleDismiss();
        };

        const enqueue = (sessionId, title, meta) => {
          store.set((state) => {
            const queue = state.queue.filter((item) => item.id !== sessionId);
            queue.push({ id: sessionId, title, at: Date.now() });
            while (queue.length > MAX_QUEUE) queue.shift();
            return { ...state, queue };
          });
          scheduleDismiss();
          handlers?.report({ event: 'complete', sessionId, title, pending: store.getSnapshot().queue.length, ...(meta ?? {}) });
        };

        /**
         * 只有明确的布尔值才算数：投影还没到位时 `running` 是 undefined，
         * 把它当成「跑完了」正是假完成的一个来源。
         * @returns {boolean|null} null = 未知
         */
        const runningFlagOf = (row) => {
          if (row === null || row === undefined) return null;
          if (row.running === true) return true;
          if (row.running === false) return false;
          return null;
        };

        /** 复查：真的还在空闲才弹；期间又开始跑了就静默丢弃。 */
        const confirmDone = (id) => {
          const entry = pendingConfirm.get(id);
          pendingConfirm.delete(id);
          if (disposed) return;
          const snapshot = readList();
          if (snapshot === null) return;
          const byId = snapshot.byId !== null && typeof snapshot.byId === 'object' ? snapshot.byId : {};
          const row = byId[id];
          const delayMs = entry === undefined ? null : Date.now() - entry.at;
          if (row === undefined) {
            suppressedCount += 1;
            handlers?.report({ event: 'suppress', sessionId: id, reason: 'row-gone', delayMs });
            return;
          }
          const flag = runningFlagOf(row);
          if (flag !== false) {
            suppressedCount += 1;
            handlers?.report({ event: 'suppress', sessionId: id, reason: flag === true ? 'resumed' : 'unknown', delayMs });
            return;
          }
          if (row.origin === 'subagent') return;
          confirmedCount += 1;
          enqueue(id, titleOf(row), { origin: row.origin ?? null, delayMs });
        };

        const scheduleConfirm = (id) => {
          const existing = pendingConfirm.get(id);
          if (existing !== undefined) clearTimeout(existing.timer);
          const entry = { at: Date.now(), timer: 0 };
          entry.timer = setTimeout(() => confirmDone(id), currentSettings().confirmMs);
          pendingConfirm.set(id, entry);
        };

        /** 又把提示收回来：那条「完成」是轮间空档，不是真的结束。 */
        const retract = (id) => {
          const state = store.getSnapshot();
          if (state.queue.length === 0) return;
          const index = state.queue.findIndex((item) => item.id === id);
          if (index < 0) return;
          retractedCount += 1;
          const queue = state.queue.slice(0, index).concat(state.queue.slice(index + 1));
          store.set((prev) => ({ ...prev, queue }));
          if (dismissTimer !== null) {
            clearTimeout(dismissTimer);
            dismissTimer = null;
          }
          scheduleDismiss();
          handlers?.report({ event: 'retract', sessionId: id, reason: 'resumed' });
        };

        /**
         * 以 `ctx.sessions.list` 为准，逐轮比对 running：true → false 只是「一轮结束」，
         * 先挂起复查（{@link DONE_CONFIRM_MS}），复查仍空闲才算一次完成。
         * 同时把排队中的标题刷新成最新值（标题可能比回合晚到）。
         */
        const reconcile = () => {
          if (disposed) return;
          const snapshot = readList();
          if (snapshot === null) return;
          const byId = snapshot.byId !== null && typeof snapshot.byId === 'object' ? snapshot.byId : {};
          const nextRunning = new Map();
          const candidates = [];
          const resumed = [];
          let runningCount = 0;
          for (const id of Object.keys(byId)) {
            const row = byId[id] ?? {};
            const flag = runningFlagOf(row);
            if (flag === null) {
              // 未知：保留上一次已知状态，别制造一次假的 true→false。
              if (previousRunning.get(id) === true) nextRunning.set(id, true);
              continue;
            }
            if (flag) runningCount += 1;
            nextRunning.set(id, flag);
            if (!baseline) continue;
            const was = previousRunning.get(id);
            if (flag) {
              if (was !== true) resumed.push(id);
              continue;
            }
            if (was !== true) continue;
            if (row.origin === 'subagent') continue;
            candidates.push(id);
          }
          previousRunning = nextRunning;
          baseline = true;

          // 又开始跑了：撤掉待复查的候选，并把已经弹出的气泡收回。
          for (const id of resumed) {
            const pending = pendingConfirm.get(id);
            if (pending !== undefined) {
              clearTimeout(pending.timer);
              pendingConfirm.delete(id);
              suppressedCount += 1;
              handlers?.report({ event: 'suppress', sessionId: id, reason: 'resumed-before-confirm', delayMs: Date.now() - pending.at });
            }
            retract(id);
          }

          const state = store.getSnapshot();
          let queueChanged = false;
          const nextQueue = state.queue.map((item) => {
            const title = titleOf(byId[item.id]);
            if (title === '' || title === item.title) return item;
            queueChanged = true;
            return { ...item, title };
          });
          if (state.running !== runningCount || queueChanged) {
            store.set((prev) => ({
              ...prev,
              running: runningCount,
              queue: queueChanged ? nextQueue : prev.queue,
            }));
          }
          for (const id of candidates) scheduleConfirm(id);
        };

        /** `api-session/status` 只是「列表该变了」的唤醒信号，事实仍从列表读。 */
        const wake = () => {
          if (disposed) return;
          try {
            queueMicrotask(reconcile);
          } catch (error) {
            reconcile();
          }
          setTimeout(reconcile, 150);
        };

        handlers = {
          t(key) {
            try {
              const value = t(key);
              if (typeof value === 'string' && value !== '' && value !== key) return value;
            } catch (error) {
              /* fall through to the local table */
            }
            const table = STRINGS[detectLang()] ?? STRINGS.zh;
            return table[key] ?? key;
          },
          openSession(sessionId) {
            advance();
            if (sessionId === TEST_ID) return;
            try {
              ctx.get('uiWorkspace')?.openSession({ sessionId });
            } catch (error) {
              /* no view host: the notice still dismisses */
            }
          },
          onBallClick() {
            advance();
          },
          dismiss() {
            advance();
          },
          /** 设置页：弹一条测试提示，眼睛验收提示框样式，不用等真会话结束。 */
          testBubble() {
            enqueue(TEST_ID, handlers === null ? 'Test notice' : handlers.t('settings.testBubble'), { origin: 'test' });
          },
          /** 设置页：忘掉记着的位置，回到推导出来的右下角。 */
          resetPosition() {
            try {
              localStorage.removeItem(POS_KEY);
            } catch (error) {
              /* ignore */
            }
            store.set((prev) => ({ ...prev, posNonce: prev.posNonce + 1 }));
            handlers?.report({ event: 'reset-position' });
          },
          report(payload) {
            if (typeof fetch !== 'function') return;
            try {
              const body = JSON.stringify({ ...payload, plugin: NS, at: Date.now() });
              void fetch('/session-orb/report', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body,
              }).catch(() => {});
            } catch (error) {
              /* diagnostics are optional */
            }
          },
        };

        // 设置变更也进诊断流：滑杆改变量 → 这里看得到，浮层与设置页吃同一份快照。
        const disposeSettings = settingsStore.subscribe(() => {
          handlers?.report({ event: 'settings', settings: currentSettings() });
        });

        // 会话目录订阅：完成检测的主通道。
        let disposeList = () => {};
        const list = readList() === null ? null : ctx.sessions?.list;
        if (list !== null && list !== undefined && typeof list.subscribe === 'function') {
          disposeList = list.subscribe(() => {
            reconcile();
          });
        }

        // 可选的加速器：拿不到就只靠列表订阅。
        let disposeStatus = () => {};
        try {
          if (typeof ctx.remote?.$on === 'function') {
            disposeStatus = ctx.remote.$on('api-session/status', () => {
              statusEvents += 1;
              wake();
            });
          }
        } catch (error) {
          disposeStatus = () => {};
        }

        // 语言切换后重渲染（t 是当场求值的，所以只需推一次重渲染）。
        try {
          ctx.on('locale/change', () => {
            store.set((state) => ({ ...state, lang: detectLang() }));
          });
        } catch (error) {
          /* no locale events: the static table is enough */
        }

        reconcile();
        handlers?.report({
          event: 'apply',
          list: list !== null && list !== undefined,
          subscribe: typeof list?.subscribe === 'function',
          status: typeof ctx.remote?.$on === 'function',
          sessions: (() => {
            const snapshot = readList();
            return snapshot !== null && snapshot.byId !== null && typeof snapshot.byId === 'object'
              ? Object.keys(snapshot.byId).length
              : -1;
          })(),
          lang: detectLang(),
          storage: storageProbe(),
          confirmMs: currentSettings().confirmMs,
          bubbleMs: currentSettings().bubbleMs,
          settings: currentSettings(),
        });

        // 与本地既有插件同形：第二个参数是零参渲染函数，返回真正的组件元素，
        // 这样 OrbLayer 里的 hooks 在独立组件里运行。
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: NS, order: 620 }, () => h(OrbLayer)),
        );

        // 设置 → 会话悬浮球：设置页导航标题用 thunk，语言切换后自动跟着变。
        const sectionLabel = () => (handlers === null ? STRINGS.zh['settings.section'] : handlers.t('settings.section'));
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: NS, order: 47, label: sectionLabel }, () => h(OrbSettingsPage)),
        );

        // 让 150ms 的唤醒定时器在插件卸载后不再触发。
        ctx.effect(() => () => {
          disposed = true;
          if (dismissTimer !== null) {
            clearTimeout(dismissTimer);
            dismissTimer = null;
          }
          for (const entry of pendingConfirm.values()) clearTimeout(entry.timer);
          pendingConfirm.clear();
          try {
            disposeStatus();
          } catch (error) {
            /* ignore */
          }
          try {
            disposeSettings();
          } catch (error) {
            /* ignore */
          }
          try {
            disposeList();
          } catch (error) {
            /* ignore */
          }
          handlers?.report({ event: 'dispose', statusEvents, confirmed: confirmedCount, suppressed: suppressedCount, retracted: retractedCount, settings: currentSettings() });
          settingsStore = null;
          handlers = null;
        }, 'session-orb: teardown');
      },
    };
  },
});
