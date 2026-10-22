/**
 * dsh-ultracode —— 浏览器半边（会话级「点亮 / 熄灭」实心胶囊开关）。
 *
 * 入口位置（2026-10-22 起变更，用户指令「去掉原来的 ultracode 按钮」）：
 * **本半边不再注册任何界面座位** —— 输入框工具行的那颗胶囊已删除，点亮/熄灭
 * 的唯一入口是**工作箱**（dsh-workbench，order 23 原座位）：点开工作列表，
 * 在 Ultracode 行上拨开关。本文件仍保留组件与样式实现（工作箱拨动时同一份
 * 状态/路由语义，host 半边零改动），但 apply() 不再把它挂进任何 slot。
 *
 * 视觉（用户指定）：**实心胶囊 + 圆角，底色与对话框（输入卡片）一致，
 * 没有点形指示灯，页面上不出现任何提示语**。
 * **尺寸与字体对齐同一行的「权限」选择器**（PermissionSelect trigger：
 *   height 28px / border-radius 24px / font-size 13px / line-height 20px），
 *   并排时高度与字号完全一致；字重取**细体 400**（权限写 500，但它渲染中文
 *   字形，纯拉丁 "Ultracode" 在 500 下视觉更粗）。
 *   熄灭：  与输入卡片同底色（--dsw-specific-input-major）+ 1px 描边保轮廓，
 *           文字取 label-primary（暗色主题即白字，亮色主题自动转深字）
 *   点亮：  **不要边框，整颗胶囊内部全部填充同一个均匀色号**——没有渐变、
 *           没有 backdrop 模糊、没有内高光/外发光、没有 brightness 滤镜
 *           （metal design 式平涂）；色号本身**透明度比较高且偏白**（22%
 *           green-500 兑白得到的淡薄荷，以 38% 不透明度铺满）
 *   不可用：琥珀底白字（工作流关 / 模型不支持）
 *   读取失败：红底白字（仍可点击，下一轮轮询自愈）
 *   请求中： 整颗胶囊呼吸，避免连点
 * 所有细节（状态、注入方式、工具段改写、会话思考强度、路由、不可用原因）只在
 * 按钮的 title 悬停提示里，**不往页面上写一个字**——回执行已按用户要求删除。
 *
 * 点击语义：
 *   点亮 → 熄灭；熄灭 → 点亮；已请求但当前不可用 → 关掉请求（否则请求再也退
 *   不出来）；未请求且不可用 → 不发任何写请求（原因在 title 里，页面不出现提示语）。
 *
 * 与原实现唯一的差别（2026-10-09，用户指令「持久化会话是否启用 ultracode 选择，不在
 * 重启后失效」）：**会话级不变，但选择会落盘**——host 半边把它写进
 * $DSH_HOME/ultracode.json，dsh 重启后胶囊按记录回到原来的状态；`reset` 连盘上记录
 * 一起抹掉。其余仍与原实现一致（this session only）。所有读写走 host 半边同源路由
 * （见 ./inject-v2.js）：
 *   GET  /dsh-ultracode/status?sessionId=…   （含 persisted / restored / stateFile）
 *   POST /dsh-ultracode/set    {sessionId, active}
 *   POST /dsh-ultracode/reset  {sessionId}   （仍可用，只是不再有面板按钮）
 *
 * @module dsh-ultracode/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-ultracode',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/dsh-ultracode';

    /** 状态轮询间隔：开关状态可能被 host 侧预置或别的半边改动，胶囊要跟着走。 */
    const POLL_MS = 8000;

    const PAGE_CSS = [
      /* 熄灭态：**与对话框（输入卡片）同一底色**，只留 1px 描边让圆角胶囊仍有
       * 轮廓（否则会和卡片融为一体、看不出是个按钮）。
       * 文字用主题的 label-primary：暗色主题下就是白字，亮色主题下自动变深字
       * （硬写 #fff 会在这张白卡片上消失）。
       * **尺寸与字体对齐同一行的「权限」选择器**（PermissionSelect 的 trigger：
       * height 28px / border-radius 24px / font-size 13px / line-height 20px）；
       * 字重取**细体 400**：权限选择器写的是 500，但它渲染的是中文字形，本胶囊
       * 是纯拉丁 "Ultracode"，同一字重在 Inter 下视觉明显更粗——400 才与它观感一致。
       * `font-family: inherit` 显式继承，免得 <button> 退回 UA 默认字体。
       * 权限选择器左右内边距是 0 4px 0 8px（它带图标），本胶囊是纯文字，
       * 用 0 10px 取得同样的视觉宽度节奏。 */
      '.uc-chip { appearance: none; display: inline-flex; align-items: center; height: 28px; padding: 0 10px; border-radius: 24px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; font-weight: 400; line-height: 20px; cursor: pointer; white-space: nowrap; transition: background .16s ease, border-color .16s ease; }',
      /* 悬停用与输入框行内出厂按钮同一个 hover 面。 */
      '.uc-chip:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }',
      '.uc-chip:disabled { cursor: default; opacity: .5; }',
      '.uc-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }',
      /* 点亮（用户指定）：**不要边框，整颗胶囊内部全部填充同一个均匀色号**——
       * 没有渐变、没有 backdrop 模糊、没有内高光/外发光、没有 brightness 滤镜，
       * 就是 metal design 式的一整块平涂。
       * 颜色本身**透明度比较高且偏白**：先取 22% green-500 兑白得到的淡薄荷
       * （≈ #CEF2DC），再以 38% 不透明度铺上去——底层卡片与文字透出来，暗色主题
       * 下是柔和的灰绿、亮色主题下是极淡的薄荷白。
       * border-color 只置 transparent：视觉上没有边框，但保留 1px 边框占位，
       * 点亮↔熄灭切换时外框尺寸不跳动。
       * 文字回到 label-primary：半透明淡底随主题明暗自动取色（暗色主题近白、
       * 亮色主题深字），两种情况都够读。 */
      '.uc-chip.uc-on { border-color: transparent; background: rgba(206, 242, 220, .38); background: color-mix(in srgb, color-mix(in srgb, var(--dsw-static-green-500, #22c55e) 22%, #ffffff) 38%, transparent); color: var(--dsw-alias-label-primary); }',
      /* 悬停只把同一个色号的不透明度调高一档，不加亮、不加光。 */
      '.uc-chip.uc-on:hover:not(:disabled) { background: rgba(206, 242, 220, .48); background: color-mix(in srgb, color-mix(in srgb, var(--dsw-static-green-500, #22c55e) 22%, #ffffff) 48%, transparent); }',
      /* 不可用：琥珀底白字（amber-600 直接铺白字 ~2.8:1，同样压深一档到 ~4.5:1）；
       * 外框与熄灭/点亮共用同一条朴素 1px 描边，不另作处理。 */
      '.uc-chip.uc-blocked { color: #fff; background: var(--dsw-static-amber-600, #dd8629); background: color-mix(in srgb, var(--dsw-static-amber-600, #dd8629) 70%, #3a1d00); }',
      /* 读取失败：红底白字（red-600 本身即 ~4.5:1）。 */
      '.uc-chip.uc-error { color: #fff; background: var(--dsw-static-red-600, #ec1313); }',
      /* 请求中：整颗胶囊呼吸，表达「正在切换」。 */
      '@keyframes uc-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }',
      '.uc-chip.uc-busy { animation: uc-breathe .7s ease-in-out infinite; }',
      /* 状态未读到（挂载首帧）：虚线描边 + 慢呼吸，明确区别于「熄灭」的实线常态。
       * 切进一条**继承**来的分支时，首帧还没有 /status 结果——若按 off 画，胶囊会先
       * 熄灭一下再跳亮（闪一下的错状态比慢半帧更刺眼）。 */
      '.uc-chip.uc-unknown { border-style: dashed; animation: uc-breathe 1.4s ease-in-out infinite; }',
    ].join('\n');

    let stylesInjected = false;
    function injectStyles() {
      if (stylesInjected || typeof document === 'undefined') return null;
      stylesInjected = true;
      const el = document.createElement('style');
      el.setAttribute('data-dsh-ultracode', '');
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

    /** 原实现里 `bot` 的字面值（`Ultracode on (this session only): ${bot}.`）。 */
    const ON_BLURB = 'dynamic workflows on every task';

    /** 熄灭回执（原实现 `D(e,t,n)` 的 off 分支，逐字）。 */
    function offMessage(status) {
      const effort = status.reasoningEffort || 'the model default';
      return 'Ultracode off. Effort stays ' + effort + '.';
    }

    /**
     * `/effort ultracode` 的文案。**只出现在按钮 title（悬停）里，不写进页面。**
     *
     * `Effort stays {s}` 里的 `s` 在原实现里是**会话自身的强度**
     * （`O(t.effort) ?? qT(r,t.effort)`），不是 ultracode 期望的档位。
     * 这里照此办理：取会话真实强度，缺省则说"模型路由缺省"。
     * 本插件对思考强度零写入（effortPolicy='untouched'）。
     *
     * 前四句（on / off / needs-workflows / isn't-available）逐字取自逆向 bundle；
     * 最后一句「本来就没开」**不是**回执——原实现那个函数两种情况都印
     * 'Ultracode off. Effort stays …'——它只是状态描述。
     */
    function effortMessage(status, justToggled) {
      const effort = status.reasoningEffort || 'the model default';
      const options = status.validOptions || 'low, medium, high, xhigh, max, auto';
      if (!status.available) {
        if (status.reason === 'workflows') {
          return 'Ultracode needs dynamic workflows enabled (see /config). Valid options are: ' + options;
        }
        return "Ultracode isn't available on " + (status.model || 'this model') + '. Valid options are: ' + options;
      }
      if (status.active) {
        return 'Ultracode on (this session only): ' + ON_BLURB + '. Effort stays ' + effort + '.';
      }
      if (justToggled === true) return offMessage(status);
      return 'Ultracode is off for this session. Turn it on to opt this session into standing dynamic-workflow orchestration.';
    }

    // ── 会话级共享状态 ─────────────────────────────────────────────────────
    //
    // 按 SessionId 隔离、只在内存里。页面不给任何提示语，所以这里只保留
    // 「状态 / 在途 / 读取错误」三样，点击结果一律反映在胶囊底色上。

    const store = new Map();

    function recordOf(sessionId) {
      const key = typeof sessionId === 'string' ? sessionId : '';
      let record = store.get(key);
      if (record === undefined) {
        record = {
          status: null,
          error: '',
          busy: false,
          listeners: new Set(),
        };
        store.set(key, record);
      }
      return record;
    }

    function notify(sessionId) {
      for (const listener of recordOf(sessionId).listeners) {
        try {
          listener();
        } catch {
          /* 单个订阅者出错不影响其余订阅者 */
        }
      }
    }

    /** 订阅当前会话的记录；记录是活对象，notify 即重渲染。 */
    function useRecord(sessionId) {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const record = recordOf(sessionId);
        const listener = () => bump((n) => n + 1);
        record.listeners.add(listener);
        return () => { record.listeners.delete(listener); };
      }, [sessionId]);
      return recordOf(sessionId);
    }

    async function refresh(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      const record = recordOf(sessionId);
      try {
        const next = await api(ROUTE + '/status?sessionId=' + encodeURIComponent(sessionId));
        record.status = next;
        record.error = '';
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err);
      }
      notify(sessionId);
    }

    /**
     * 切换开关。`target` 显式给出要写入的值；不传则按当前态取反。
     *
     * 显式 target 是为「已请求但当前不可用」准备的：此时 host 的 active 恒为
     * false（active = requested && available），若仍按取反推断就会再次写入 true，
     * 请求再也退不出来。
     */
    async function toggle(sessionId, target) {
      const record = recordOf(sessionId);
      if (record.busy || record.status === null) return;
      const next = target === undefined ? record.status.active !== true : target === true;
      record.busy = true;
      notify(sessionId);
      try {
        record.status = await postJson(ROUTE + '/set', { sessionId, active: next });
        record.error = '';
      } catch (err) {
        // 页面不出提示语：失败只体现在胶囊转红 + title 里的原因。
        record.error = err instanceof Error ? err.message : String(err);
      } finally {
        record.busy = false;
        notify(sessionId);
      }
    }

    /**
     * 落盘时间戳 → 可读文本（只出现在 title 里）。坏值一律返回空串，交给调用方省略。
     */
    function formatDecidedAt(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
      try {
        return new Date(value).toLocaleString('zh-CN', { hour12: false });
      } catch {
        return '';
      }
    }

    /** title 提示（悬停才可见，不属于页面上的提示语）：状态详情全在这里。 */
    function tooltipFor(status, record, active, blocked, requested) {
      const lines = [];
      // 家族共用（2026-10-09）：开关按**会话谱系**存一条 —— 主线与它 fork 出来的
      // 全部分支共享同一个选择，在哪条分支上点一下，整族一起变。
      const shared = status !== null && typeof status.family === 'string' && status.family !== '';
      const branches = status !== null && typeof status.branches === 'number' ? status.branches : 0;
      lines.push(active
        ? (shared
          ? 'Ultracode：已点亮（on）· 全家族共用（重启后保留）'
          : 'Ultracode：已点亮（on）· 本会话（重启后保留）')
        : (blocked
          ? (requested
            ? 'Ultracode：已请求，但当前路由/工作流下不可用'
            : (shared ? 'Ultracode：全家族不可用' : 'Ultracode：本会话不可用'))
          : (shared ? 'Ultracode：已熄灭（off）· 全家族共用' : 'Ultracode：已熄灭（off）')));
      lines.push(effortMessage(status === null ? { available: true, active: false } : status, false));
      if (status === null) {
        lines.push('正在读取状态…');
      } else {
        lines.push('注入：系统提示直注 · ' + (status.injected ? '已注入（每请求在场）' : '未注入'));
        lines.push('工作流工具段：' + (status.shadowed ? '已改写为 ultracode 感知版' : '原生（仅明确要求才启用）'));
        lines.push('思考强度：' + (status.reasoningEffort || '路由缺省') + ' · 不受干预');
        lines.push('路由：' + (status.provider || '—') + ' / ' + (status.model || '—'));
        // 落盘只在需要时多说一句：已落盘就报「重启后保留」；没落盘而当前又是
        // 「开着」的时候必须示警（那意味着重启会丢），其余情况不啰嗦。
        lines.push('状态来源：'
          + (status.source === 'provisioned' ? '预置（DSH_ULTRACODE）' : '会话开关')
          + (status.persisted === true
            ? '（已落盘，重启后保留）'
            : (status.requested === true ? '（未落盘：重启会丢）' : '')));
        // 家族：讲清「这条选择是谁的、会波及谁」。分支数只统计本进程里已知的成员。
        if (shared) {
          lines.push('家族：'
            + (status.familyRoot === true ? '家族根（主线）' : '分支（继承家族根的选择）')
            + (branches > 0 ? ' · 另有 ' + branches + ' 条分支' : '')
            + ' · 在此改动会同时影响全部分支');
        }
        if (status.restored === true) {
          const when = formatDecidedAt(status.decidedAt);
          lines.push('本次由落盘恢复' + (when === '' ? '' : '（上次决定 ' + when + '）'));
        }
        if (status.persisted === true && typeof status.stateFile === 'string' && status.stateFile !== '') {
          lines.push('落盘文件：' + status.stateFile);
        }
        if (typeof status.storeError === 'string' && status.storeError !== '') {
          lines.push('落盘失败：' + status.storeError);
        }
      }
      if (record.error !== '') lines.push('状态读取失败：' + record.error);
      lines.push(
        (active ? '点击熄灭'
          : (blocked
            ? (requested ? '点击关闭本会话的 ultracode 请求' : '可用性由工作流总开关与模型能力决定')
            : '点击点亮'))
        + '（只改编排方式，不改动模型思考强度）',
      );
      return lines.join('\n');
    }

    /** 输入框工具行里的点亮 / 熄灭开关：唯一触发器，页面上不写任何提示语。 */
    function UltracodeToggle(props) {
      const sessionId = props.sessionId;
      const record = useRecord(sessionId);

      // 挂载与会话切换时取一次状态。
      React.useEffect(() => { refresh(sessionId); }, [sessionId]);

      // 常态轮询：预置态或 host 侧改动都要反映在胶囊上。
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        const timer = setInterval(() => refresh(sessionId), POLL_MS);
        return () => clearInterval(timer);
      }, [sessionId]);

      const status = record.status;
      const active = status !== null && status.active === true;
      const requested = status !== null && status.requested === true;
      const available = status === null || status.available !== false;
      // 不可用就点亮琥珀胶囊（不管本会话有没有请求过）：用户必须一眼看出
      // 「这个东西现在用不了」，而不是一颗看起来正常的胶囊。
      const blocked = status !== null && !available;
      const hasSession = typeof sessionId === 'string' && sessionId !== '';
      // 状态还没读到（挂载首帧 / 读取失败）：既不是 on 也不是 off，走中性外观。
      const unknown = status === null;

      const onClick = () => {
        if (record.busy || status === null) return;
        if (!available) {
          // 已请求但当前不可用（例如模型换成不支持 xhigh 档的）：必须允许关掉，
          // 否则这个会话的请求再也退不出来。没请求过则什么都不做——原因只在
          // title 里，页面不出现提示语。
          if (requested) toggle(sessionId, false);
          return;
        }
        toggle(sessionId);
      };

      const className = 'uc-chip'
        + (active ? ' uc-on' : '')
        + (blocked ? ' uc-blocked' : '')
        + (record.error !== '' && !active ? ' uc-error' : '')
        + (record.busy ? ' uc-busy' : '')
        + (unknown && !record.busy ? ' uc-unknown' : '');

      return h('button', {
        type: 'button',
        className,
        'aria-pressed': active ? 'true' : 'false',
        'aria-label': 'Ultracode ' + (active ? 'on' : 'off'),
        // 状态没读到也保持可点击（悬停 title 会说明情况）；只有请求在途或无会话才禁用。
        disabled: record.busy || !hasSession,
        title: tooltipFor(status, record, active, blocked, requested),
        // 与同一行里出厂控件的 keepFocus 约定一致：按下时不让按钮抢走编辑器焦点，
        // 否则点一下胶囊光标就离开输入框、正在打的字断掉。
        onMouseDown: (event) => { event.preventDefault(); },
        onClick,
      },
      // 实心胶囊：状态全靠底色表达（绿=on / 卡片色=off / 琥珀=不可用 / 红=读取失败），
      // 没有点形指示灯，也没有第二行提示语。
      h('span', { className: 'uc-label' }, 'Ultracode'),
      );
    }

    const inject = [];

    function apply(ctx) {
      // 2026-10-22（用户指令「去掉原来的 ultracode 按钮」）：不再注册任何槽位。
      // 保留两个清理 effect 的登记习惯没有意义了 —— 没有样式注入、没有会话
      // 记录可清（store 仍归模块所有，工作箱经 HTTP 驱动 host 半边），但为了
      // 热换时的健壮性，仍把 store 清理挂在 fiber 上。
      ctx.effect(() => () => {
        store.clear();
      }, 'dsh-ultracode: session state');
    }

    exports.inject = inject;
    exports.apply = apply;
    // 供无头自测与（未来）其它半边复用：组件本体仍在，只是不再入座。
    exports.__ui = { UltracodeToggle, tooltipFor };
    return module.exports;
  },
});