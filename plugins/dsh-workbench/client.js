/**
 * dsh-workbench —— 浏览器半边（工作箱图标 + 展开列表）。
 *
 * 入口位置：conversation.input.left，order 23 —— **正是原 Ultracode 胶囊的座位**
 * （用户指令「将现在 UltraCode 位置改成一个工作箱」）。dsh-ultracode 的 client
 * 随本插件一起改为 order 90 退到工具行更右侧（不再占 23），避免同排两颗按钮。
 *
 * 视觉（对齐 dsh-ultracode 的胶囊语言，同一行并排不突兀）：
 *   收起：一颗 28px 高的圆角胶囊，内有一个「工作箱」图标（四宫格 + 提手），
 *         底色与输入卡片一致 + 1px 描边，与熄灭态的 Ultracode 胶囊同款；
 *   展开列出条目：每行 = **开关**（track+thumb，role="switch"，与设置页开关
 *         同一视觉语言）+ 名称 + 一句描述（2026-10-22 用户指令「换成开关
 *         样式」——不再是复选框）；开关数显示在图标右上角的小徽标里；
 *   状态全走 title 悬停提示，页面上不写提示语（与 ultracode 的约定一致）。
 *
 * 点击语义（2026-10-22「点击秒开」）：
 *   点图标 → 立即展开/收起浮层：数据常驻本地缓存、无入场动画，第一帧就是
 *   最终画面；缓存过期（>4s）只在后台补一次刷新，绝不阻塞打开；
 *   拨开关 → 乐观翻转：本地状态先变、POST /dsh-workbench/set 随后台发出，
 *   下一帧就看到开关翻过去；失败才回滚到服务器真值并在浮层给红字。
 *   （勾选生效语义不变：下一次请求就注入/摘除上下文。）
 *
 * 2026-10-30 用户指令「去掉工具箱插件页面底部的文本描述」：删掉浮层底注（原
 *   `.wb-note` 那段「拨动开关即时生效…」长文）及其样式。上面约定的「状态全走
 *   title 悬停提示，页面上不写提示语」由此真正成立——浮层里只剩标题、条目与
 *   异常行，不再有常驻说明文字。
 *
 * @module dsh-workbench/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-workbench',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const ROUTE = '/dsh-workbench';
    const POLL_MS = 8000;
    const CSS = [
      /* ── 收起的图标胶囊 ────────────────────────────────────────────────────
       * 尺寸/字体与同一行的「权限」选择器逐字对齐（28px / 24px 圆角 / 13px /
       * 400 / line-height 20px —— dsh-ultracode 胶囊验证过的同一组参数），
       * 并排时高度、字号、字重完全一致。悬停/按下用出厂 interactive 面，
       * focus-visible 用品牌描边——键盘可达性与出厂控件同档。 */
      '.wb-chip { appearance:none; height:28px; border-radius:24px; border:1px solid var(--dsw-alias-border-l1);',
      '  background:var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1)); color:var(--dsw-alias-label-primary);',
      '  display:inline-flex; align-items:center; justify-content:center; gap:6px;',
      '  font-family:inherit; font-size:13px; font-weight:400; line-height:20px; padding:0 10px; cursor:pointer;',
      '  position:relative; transition: background .16s ease, border-color .16s ease; }',
      '.wb-chip:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover-solid); border-color:var(--dsw-alias-border-l2); }',
      '.wb-chip:active:not(:disabled) { background:var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover-solid)); }',
      '.wb-chip:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }',
      '.wb-chip:disabled { cursor:default; opacity:.5; }',
      /* 展开态：图标染品牌色，与徽标呼应（不出提示语，色彩即状态）。 */
      '.wb-chip.wb-open { border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-interactive-bg-hover-solid); }',
      '.wb-chip.wb-open svg { color:var(--dsw-alias-brand-primary); }',
      '.wb-chip.wb-busy { animation: wb-breath 1.2s ease-in-out infinite; }',
      '.wb-chip.wb-error { background:var(--dsw-alias-state-error-primary); color:#fff; border-color:transparent; }',
      /* 角标（2026-10-22「圆点角标而不是方形」）：8px 纯圆点，不再放数字——
       * 数量在浮层头部 n/m 与悬停提示里；2px 底色描边环让它在任何底色上清晰。 */
      '.wb-count { position:absolute; top:-4px; right:-4px; width:8px; height:8px; border-radius:50%;',
      '  background:var(--dsw-alias-brand-primary);',
      '  box-shadow:0 0 0 2px var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1)); }',
      '.wb-count-enter { animation: wb-pop-in .14s cubic-bezier(.32,.72,0,1); }',
      /* ── 浮层（对齐宿主命令面板 mufS8W_card 的构造方式）────────────────────
       * radius/elevation/interactive 三组全用出厂 token：命令菜单同款
       * --dsw-elevation-prominent + --dsw-radius-md，行 hover 同款
       * --dsw-alias-interactive-bg-hover；不再手写阴影与圆角。
       * 无入场动画（2026-10-22「点击秒开」）：点开第一帧就是最终画面，
       * 不做位移/淡入——树莓派上 160ms 的 slide 会被放大成明显的迟滞。 */
      '.wb-pop { position:absolute; bottom:calc(100% + 6px); left:0; z-index:100;',
      '  min-width:300px; max-width:400px; border-radius:var(--dsw-radius-md, 12px); padding:4px;',
      '  background:var(--dsw-alias-bg-overlay); border:0; outline:none;',
      '  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);',
      '  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);',
      '  box-shadow:var(--dsw-elevation-prominent);',
      '  display:flex; flex-direction:column; gap:1px; overflow:hidden; }',
      /* 头部：一行「工作列表」小标题 + 全关快捷键；不出正文提示语。 */
      '.wb-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 9px 5px; }',
      '.wb-head-title { font-size:11px; font-weight:600; color:var(--dsw-alias-label-secondary);',
      '  letter-spacing:.2px; }',
      '.wb-head-count { font-size:10.5px; color:var(--dsw-alias-label-tertiary); }',
      '.wb-clear { font:inherit; font-size:11px; line-height:1; padding:4px 8px; border-radius:var(--dsw-radius-sm, 8px);',
      '  border:0; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer;',
      '  transition:background .15s ease, color .15s ease; }',
      '.wb-clear:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }',
      '.wb-clear:disabled { opacity:.45; cursor:default; }',
      /* 行：开关 + 名称 + 描述；hover 用出厂 interactive 面，圆角用 radius token。 */
      '.wb-row { display:flex; align-items:flex-start; gap:10px; padding:7px 9px;',
      '  border-radius:var(--dsw-radius-sm, 8px); cursor:pointer; transition:background .15s ease; }',
      '.wb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      /* 动作行（v2）：与开关行同一骨架，但左列是一颗主按钮（启动/停止）。
       * 按钮视觉对齐宿主主操作：品牌底、白字、focus-visible 品牌描边。 */
      '.wb-act { display:flex; align-items:flex-start; gap:10px; padding:7px 9px;',
      '  border-radius:var(--dsw-radius-sm, 8px); transition:background .15s ease; }',
      '.wb-act:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.wb-act-btn { flex:none; margin:0; appearance:none; height:24px; padding:0 12px;',
      '  border-radius:var(--dsw-radius-sm, 8px); border:1px solid var(--dsw-alias-brand-primary);',
      '  background:var(--dsw-alias-brand-primary); color:#fff; font:inherit; font-size:12px;',
      '  font-weight:500; line-height:22px; cursor:pointer;',
      '  transition:opacity .15s ease; }',
      '.wb-act-btn:hover:not(:disabled) { opacity:.88; }',
      '.wb-act-btn:active:not(:disabled) { opacity:.78; }',
      '.wb-act-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }',
      '.wb-act-btn:disabled { opacity:.5; cursor:default; }',
      '.wb-act-btn.wb-stop { background:transparent; color:var(--dsw-alias-label-primary);',
      '  border-color:var(--dsw-alias-border-l2); }',
      /* armed（已武装待命）：描边 + 品牌色文字——与 running 的灰描边区分开。 */
      '.wb-act-btn.wb-armed { background:transparent; color:var(--dsw-alias-brand-primary);',
      '  border-color:var(--dsw-alias-brand-primary); }',
      /* 开关式动作行：与开关条目同款排布（track+thumb 在左，文字在中，状态点在右）。 */
      '.wb-act-row { cursor:pointer; }',
      '.wb-act-row:has(.wb-switch:disabled) { cursor:default; opacity:.72; }',
      '.wb-act-label { font-size:12.5px; font-weight:500; color: var(--dsw-alias-label-primary);',
      '  display:flex; align-items:baseline; gap:6px; }',
      '.wb-act-desc { font-size:11px; line-height:1.55; color: var(--dsw-alias-label-secondary); margin-top:1px; }',
      /* 阶段说明单独一行：与功能说明分离，切换阶段不改动说明文本。 */
      '.wb-act-state { font-size:10.5px; line-height:1.5; margin-top:3px;',
      '  color:var(--dsw-alias-label-tertiary); }',
      '.wb-act-badge { font-size:10px; font-weight:400; color:var(--dsw-alias-state-success-primary); }',
      '.wb-act-badge.wb-act-badge-armed { color:var(--dsw-alias-brand-primary); }',
      /* 开关（track + thumb）：颜色/比例对齐设置页 role="switch"；勾着时染品牌色，
       * thumb 用阴影描边而不是硬阴影；transition 用宿主同款缓动手感。 */
      '.wb-switch { flex:none; width:34px; height:19px; border-radius:999px;',
      '  border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2);',
      '  position:relative; cursor:pointer; padding:0; margin:2px 0 0; appearance:none;',
      '  transition: background .18s cubic-bezier(.32,.72,0,1), border-color .18s cubic-bezier(.32,.72,0,1); }',
      '.wb-switch:hover:not(:disabled) { border-color:var(--dsw-alias-border-inverted); }',
      '.wb-switch:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }',
      '.wb-switch i { position:absolute; top:2px; left:2px; width:13px; height:13px; border-radius:50%;',
      '  background:#fff; transition: left .18s cubic-bezier(.32,.72,0,1); display:block;',
      '  box-shadow: 0 1px 2px rgb(0 0 0 / 25%); }',
      '.wb-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }',
      '.wb-switch[aria-checked="true"] i { left:17px; }',
      '.wb-switch:disabled { opacity:.5; cursor:default; }',
      '.wb-row-label { font-size:12.5px; font-weight:500; color: var(--dsw-alias-label-primary);',
      '  display:flex; align-items:baseline; gap:6px; }',
      '.wb-row-desc { font-size:11px; line-height:1.55; color: var(--dsw-alias-label-secondary); margin-top:1px; }',
      /* 每行右侧的实时状态点：开=绿、关=灰、忙碌=呼吸——文案仍只在 title。 */
      '.wb-dot { flex:none; margin-left:auto; margin-top:4px; width:6px; height:6px; border-radius:50%;',
      '  background:var(--dsw-alias-border-l2); transition:background .2s ease; }',
      '.wb-dot.on { background:var(--dsw-alias-state-success-primary); }',
      '.wb-dot.busy { background:var(--dsw-alias-state-warn-primary); animation:wb-breath 1s ease-in-out infinite; }',
      /* 联动问题 / 保存失败：警告色一行，不出现在正常态。 */
      '.wb-warn { font-size:11px; line-height:1.6; color:var(--dsw-alias-state-warn-primary);',
      '  padding:2px 9px 6px; }',
      /* 读态失败：浮层内给重试行（红字 + 按钮），不再只留空壳。 */
      '.wb-empty { display:flex; align-items:center; gap:8px; padding:7px 9px;',
      '  font-size:11.5px; color:var(--dsw-alias-state-error-primary); }',
      '.wb-retry { font:inherit; font-size:11px; padding:4px 9px; border-radius:var(--dsw-radius-sm, 8px);',
      '  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2);',
      '  color:var(--dsw-alias-label-primary); cursor:pointer; }',
      '.wb-retry:hover { border-color:var(--dsw-alias-border-l2); }',
      '@keyframes wb-breath { 0%,100% { opacity:1; } 50% { opacity:.55; } }',
      '@keyframes wb-pop-in { from { transform:scale(.4); } to { transform:scale(1); } }',
    ].join('\n');

    /**
     * 图标（2026-10-22 用户指令「改一下图标图案」）：**电源开关**——圆弧 + 顶杆，
     * 「on/off」的第一直觉符号，和工作箱「拨开关注入上下文」的语义完全同构。
     * 替换旧版「提手 + 四宫格工具箱」（16px 下四宫格挤成一团，且与 REA 等真实
     * 工具没有视觉对应）。画法对齐宿主小图标语言：currentColor、圆头、1.6 粗
     * 描边（16px 网格里 1.6 与宿主 2px 大图标等比缩小的观感一致）、无填充。
     * 勾着任意一项时外层 .wb-open 已把图标染成品牌色（见 CSS），无需双色。
     */
    function toolboxIcon(size) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
      },
      // 电源符号本体（首版 2.6 半径在胶囊里偏小，已放大一档）：r=3.4 圆心
      // (8,8.6)，顶部 ±40° 缺口，顶杆 (8,3.4)→(8,6.6) 伸进缺口内 1.4px —— 顶杆
      // 不与弧相接（留 0.2px 视觉呼吸），是电源图标的标准画法。整体 bounding
      // 3.2..12.8，光心 y≈7.6，居中。大弧 + 逆时针绕底部。
      h('path', {
        d: 'M5.81 6A3.4 3.4 0 1 0 10.19 6',
        fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round',
      }),
      h('path', {
        d: 'M8 3.4v3.2',
        fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round',
      }));
    }

    async function api(path, options) {
      const response = await fetch(path, options);
      let body = null;
      try { body = await response.json(); } catch { /* 非 JSON */ }
      if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
      return body;
    }

    function tooltipFor(status, count, error) {
      const lines = ['工作箱：选择本会话要注入上下文的工作项；动作条目一键触发'];
      if (status === null) {
        lines.push('正在读取状态…');
      } else {
        for (const entry of status.entries ?? []) {
          lines.push(`  ${entry.checked ? '● 开' : '○ 关'} ${entry.label} — ${entry.description}`);
        }
        for (const action of status.actions ?? []) {
          const mark = action.running === true ? '▶ 运行中' : action.running === false ? '○ 停止' : '· 未知';
          lines.push(`  ${mark} ${action.label} — ${action.description}`);
        }
        if ((status.checked ?? []).length === 0 && (status.actions ?? []).length === 0) lines.push('（未勾选任何项 = 不注入任何相关上下文）');
        if (Array.isArray(status.issues) && status.issues.length > 0) lines.push(`联动问题：${status.issues.join('；')}`);
        if (typeof status.storeError === 'string' && status.storeError !== '') lines.push(`落盘：${status.storeError}`);
      }
      if (error !== '') lines.push(`读取失败：${error}`);
      lines.push('点击展开工作列表；拨动开关即时生效（下一次请求就是新上下文）');
      return lines.join('\n');
    }

    let stylesInjected = false;
    function injectStyles() {
      if (stylesInjected) return null;
      const node = document.createElement('style');
      node.textContent = CSS;
      document.head.appendChild(node);
      stylesInjected = true;
      return node;
    }

    const statusCache = new Map();   // sessionId → {status, error, busy, pending, saveSeq, saveError, fetchedAt, listeners}
    function notify(sessionId) {
      const record = statusCache.get(sessionId);
      record?.listeners.forEach((listener) => listener());
    }

    function freshRecord() {
      return { status: null, error: '', busy: false, pending: 0, saveSeq: 0, saveError: '', fetchedAt: 0, listeners: new Set() };
    }

    async function refresh(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      let record = statusCache.get(sessionId);
      if (record === undefined) {
        record = freshRecord();
        statusCache.set(sessionId, record);
      }
      // 有保存在路上时跳过这轮读取：轮询结果会盖掉还没落账的乐观翻转。
      if (record.pending > 0) return;
      try {
        record.status = await api(`${ROUTE}/status?sessionId=${encodeURIComponent(sessionId)}`);
        record.error = '';
        record.fetchedAt = Date.now();
      } catch (cause) {
        record.error = cause instanceof Error ? cause.message : String(cause);
      }
      // 双主智能在跑/待命时，把它阻塞回合的「已停止」标签改写成「执行中」；
      // 关掉后还原（用户自己按停止键仍看到「已停止」）。
      syncStoppedLabel(record.status);
      notify(sessionId);
    }

    // 把一组勾选 id 同步进整个状态对象（checked 数组 + 每行的 checked 标记），
    // 乐观更新走这里——返回新对象，绝不原地改缓存里的旧状态。
    function withChecked(status, nextIds) {
      const set = new Set(nextIds);
      return {
        ...status,
        checked: nextIds,
        entries: (status.entries ?? []).map((entry) => ({ ...entry, checked: set.has(entry.id) })),
      };
    }

    // 动作条目：开关式（kind === 'switch'）与按钮式（默认）两种形态。
    // 开关式上送**目标状态** enabled，属主按目标推进；乐观翻转先翻开关不等网络。
    const actionCheckedOf = (action) => typeof action.checked === 'boolean'
      ? action.checked
      : action.running === true;
    const actionPhaseOf = (action) => {
      if (typeof action.phase === 'string') return action.phase;
      if (action.running === true) return 'running';
      return 'off';
    };
    const nextPhaseOf = (action) => {
      const phase = actionPhaseOf(action);
      if (phase === 'off') return 'armed';
      if (phase === 'armed') return 'off';
      return 'armed';
    };

    /**
     * running 中的「已工作 X 分 Y 秒」——客户端每秒重算，比属主 note 里一跳一跳
     * 的 8s 轮询顺滑；不足 1 分钟返回空串（刚点完晃个 0 分几秒是噪音）。
     */
    function runningElapsed(action, nowMs) {
      if (actionPhaseOf(action) !== 'running') return '';
      const at = action.hatchAt;
      if (typeof at !== 'number' || !Number.isFinite(at)) return '';
      const secs = Math.max(0, Math.floor((nowMs - at) / 1000));
      if (secs < 60) return '';
      const m = Math.floor(secs / 60);
      return m < 60 ? `（已工作 ${m} 分 ${secs % 60} 秒）` : `（已工作 ${Math.floor(m / 60)} 时 ${m % 60} 分）`;
    }

    async function triggerAction(sessionId, actionId, enabled) {
      const record = statusCache.get(sessionId);
      if (record === undefined || record.status === null) return;
      const seq = record.saveSeq + 1;
      record.saveSeq = seq;
      const previous = record.status;
      const source = (previous.actions ?? []).find((action) => action.id === actionId) ?? {};
      const isSwitch = source.kind === 'switch';
      // 目标状态：开关式取点击后的目标值；按钮式按三态推进。
      const targetChecked = isSwitch ? enabled === true : nextPhaseOf(source) !== 'off';
      const targetPhase = isSwitch
        ? (targetChecked ? (actionPhaseOf(source) === 'running' ? 'running' : 'armed') : 'off')
        : nextPhaseOf(source);
      const optimistic = {
        ...previous,
        actions: (previous.actions ?? []).map((action) =>
          action.id === actionId
            ? {
              ...action,
              phase: targetPhase,
              running: targetPhase !== 'off',
              ...isSwitch ? { checked: targetChecked } : {},
            }
            : action),
      };
      record.status = optimistic;
      record.saveError = '';
      record.pending += 1;
      record.busy = true;
      // 乐观阶段也同步一次标签：拨开开关那一刻「已停止」就该变成「执行中」，
      // 不必等服务器回包（回合标签是即时渲染的）。
      syncStoppedLabel(optimistic);
      notify(sessionId);
      try {
        const truth = await api(`${ROUTE}/action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            actionId,
            ...isSwitch ? { enabled: targetChecked } : {},
          }),
        });
        // 动作回包是属主插件的 status：只并入该动作行关心的字段（整包回填会丢
        // 工作箱自己的字段）。没有 phase 的旧属主退回 running 布尔。
        if (seq === record.saveSeq && record.status !== null) {
          record.status = {
            ...record.status,
            actions: (record.status.actions ?? []).map((action) => {
              if (action.id !== actionId) return action;
              const truthPhase = typeof truth?.phase === 'string' ? truth.phase : undefined;
              const truthRunning = typeof truth?.running === 'boolean' ? truth.running : undefined;
              const mergedRunning = truthRunning ?? (truthPhase === undefined ? undefined : truthPhase !== 'off');
              return {
                ...action,
                ...truthPhase === undefined ? {} : { phase: truthPhase },
                ...mergedRunning === undefined ? {} : { running: mergedRunning },
                ...mergedRunning === undefined ? {} : { checked: mergedRunning },
                available: true,
                ...typeof truth?.note === 'string' && truth.note !== '' ? { note: truth.note } : {},
                ...typeof truth?.armed === 'boolean' ? { armed: truth.armed } : {},
                ...typeof truth?.hatchAt === 'number' ? { hatchAt: truth.hatchAt } : {},
                // 回包没带 hatchAt 且已不在 running：清掉旧锚点，防止计时器拿
                // 上一轮的孵化时刻继续数（phase 离开 running 本就不显示，这里是
                // 双保险——万一属主回包慢，phase 已 running 但没有新锚点）。
                ...truth?.phase !== undefined && truth.phase !== 'running' && typeof truth?.hatchAt !== 'number'
                  ? { hatchAt: undefined } : {},
                // v3.3：执行者活性随真值合并；离开 running 时清掉，避免残留上一轮状态。
                ...typeof truth?.childLive === 'boolean' ? { childLive: truth.childLive } : {},
                ...typeof truth?.childStatus === 'string' ? { childStatus: truth.childStatus } : {},
                ...truth?.phase !== undefined && truth.phase !== 'running'
                  ? { childLive: undefined, childStatus: undefined } : {},
                ...typeof truth?.hint === 'string' && truth.hint !== '' ? { hint: truth.hint } : {},
              };
            }),
          };
          record.error = '';
          record.fetchedAt = Date.now();
        }
      } catch (cause) {
        // 回滚仍带 seq 守卫（迟到的旧失败不许盖掉更新的真值），但错误提示
        // 无条件显示——动作失败不能静默等 8s 轮询才暴露。
        if (seq === record.saveSeq) {
          record.status = previous;
          syncStoppedLabel(previous);   // 回滚：标签也跟着回到真值口径
        }
        record.saveError = cause instanceof Error ? cause.message : String(cause);
      } finally {
        const wasLast = record.pending === 1;
        record.pending -= 1;
        record.busy = record.pending > 0;
        // 成功后也补一次真值收敛：armed/running 的 note 是关键提示，
        // 不能等下一轮 8s 轮询才出现在面板上。
        if (wasLast) void refresh(sessionId);
        notify(sessionId);
      }
    }

    async function save(sessionId, nextChecked) {
      const record = statusCache.get(sessionId);
      if (record === undefined || record.status === null) return;
      const seq = record.saveSeq + 1;
      record.saveSeq = seq;
      const previous = record.status;                       // 最近一次服务器真值，失败回滚用
      record.status = withChecked(previous, nextChecked);   // 乐观：先翻开关，不等网络
      record.saveError = '';
      record.pending += 1;
      record.busy = true;
      notify(sessionId);
      try {
        const truth = await api(`${ROUTE}/set`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, checked: nextChecked }),
        });
        // 只认最新一拍的结果：连拨两下时，迟到的旧响应不许覆盖新状态。
        if (seq === record.saveSeq) {
          record.status = truth;
          record.error = '';
          record.fetchedAt = Date.now();
        }
      } catch (cause) {
        if (seq === record.saveSeq) {
          record.status = previous;
          record.saveError = cause instanceof Error ? cause.message : String(cause);
        }
      } finally {
        record.pending -= 1;
        record.busy = record.pending > 0;
        notify(sessionId);
      }
    }

    function useStatus(sessionId) {
      const [, bump] = useState(0);
      useEffect(() => {
        let record = statusCache.get(sessionId);
        if (record === undefined) {
          record = freshRecord();
          statusCache.set(sessionId, record);
        }
        const listener = () => bump((n) => n + 1);
        record.listeners.add(listener);
        refresh(sessionId);
        return () => { record.listeners.delete(listener); };
      }, [sessionId]);
      return statusCache.get(sessionId) ?? freshRecord();
    }

    function WorkbenchToggle(props) {
      const sessionId = props.sessionId;
      const record = useStatus(sessionId);
      const [open, setOpen] = useState(false);
      const status = record.status;
      const checkedCount = status === null ? 0 : (status.checked ?? []).length;

      // running 中的属主（带 hatchAt）需要每秒刷时长；没有 running 就不挂计时器。
      const [nowTick, setNowTick] = useState(() => Date.now());
      const anyTimed = (status?.actions ?? []).some(
        (action) => actionPhaseOf(action) === 'running' && typeof action.hatchAt === 'number');
      useEffect(() => {
        if (!anyTimed) return undefined;
        const timer = setInterval(() => setNowTick(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [anyTimed]);

      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        const timer = setInterval(() => refresh(sessionId), POLL_MS);
        return () => clearInterval(timer);
      }, [sessionId]);

      useEffect(() => {
        if (!open) return undefined;
        const onDoc = (event) => {
          if (event.target instanceof Node && !event.target.isConnected) return;
          // 点击浮层外即收起
          const pop = document.getElementById('wb-pop-' + sessionId);
          const chip = document.getElementById('wb-chip-' + sessionId);
          if (pop !== null && !pop.contains(event.target) && chip !== null && !chip.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDoc);
          document.removeEventListener('keydown', onKey);
        };
      }, [open, sessionId]);

      const toggleEntry = (entryId) => {
        // 不再看 busy 门禁：乐观翻转让连拨也即时成立，时序由 saveSeq 守卫。
        if (status === null) return;
        const current = [...(status.checked ?? [])];
        const at = current.indexOf(entryId);
        if (at >= 0) current.splice(at, 1);
        else current.push(entryId);
        void save(sessionId, current);
      };

      const className = 'wb-chip'
        + (open ? ' wb-open' : '')
        + (record.busy ? ' wb-busy' : '')
        + (record.error !== '' && status === null ? ' wb-error' : '');

      const entries = status?.entries ?? [];
      const actions = status?.actions ?? [];
      const issues = Array.isArray(status?.issues) ? status.issues.filter((issue) => typeof issue === 'string' && issue !== '') : [];

      return h('div', { style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          type: 'button',
          className,
          id: 'wb-chip-' + sessionId,
          'aria-expanded': open ? 'true' : 'false',
          'aria-haspopup': 'true',
          'aria-label': `工作箱（${checkedCount} 项已选）`,
          title: tooltipFor(status, checkedCount, record.error),
          disabled: typeof sessionId !== 'string' || sessionId === '',
          onMouseDown: (event) => { event.preventDefault(); },
          onClick: () => {
            setOpen((value) => !value);
            // 秒开后台补鲜：缓存太旧才在展开的同时拉一次新状态，不阻塞打开。
            const cached = statusCache.get(sessionId);
            if (cached !== undefined && Date.now() - cached.fetchedAt > 4000) void refresh(sessionId);
          },
        },
        toolboxIcon(15),
        checkedCount > 0 ? h('span', { className: 'wb-count wb-count-enter' }) : null,
        ),
        open ? h('div', {
          className: 'wb-pop',
          id: 'wb-pop-' + sessionId,
          role: 'menu',
          'aria-label': '工作列表',
        },
        // 头部：标题 + 已选计数 + 全关快捷键（全部次要文字，无正文提示语）。
        h('div', { className: 'wb-head' },
          h('span', { className: 'wb-head-title' }, '工作列表'),
          h('span', { className: 'wb-head-count' }, `${checkedCount}/${entries.length + actions.length}`),
          checkedCount > 0 ? h('button', {
            type: 'button',
            className: 'wb-clear',
            onMouseDown: (event) => { event.preventDefault(); },
            onClick: (event) => {
              event.stopPropagation();
              if ((status?.checked ?? []).length > 0) void save(sessionId, []);
            },
          }, '全关') : null,
        ),
        status === null
          ? h('div', { className: 'wb-empty' },
            record.error !== '' ? String(record.error) : '正在读取状态…',
            record.error !== '' ? h('button', {
              type: 'button',
              className: 'wb-retry',
              onClick: () => { void refresh(sessionId); },
            }, '重试') : null,
          )
          : null,
        ...(status === null ? [] : entries.map((entry) => h('div', {
          key: entry.id,
          className: 'wb-row',
          onClick: () => toggleEntry(entry.id),
        },
        h('button', {
          type: 'button',
          className: 'wb-switch',
          role: 'switch',
          'aria-checked': entry.checked === true ? 'true' : 'false',
          'aria-label': entry.label + (entry.checked === true ? '（开）' : '（关）'),
          onMouseDown: (event) => { event.preventDefault(); },
          onClick: (event) => {
            event.stopPropagation();
            toggleEntry(entry.id);
          },
        }, h('i', null)),
        h('span', { style: { minWidth: 0 } },
          h('div', { className: 'wb-row-label' }, entry.label),
          h('div', { className: 'wb-row-desc' }, entry.description),
        ),
        // 行尾状态点：开=绿 / 关=灰 / 保存中=琥珀呼吸（文字仍只在 title）。
        h('span', {
          className: 'wb-dot'
            + (record.busy ? ' busy' : '')
            + (entry.checked === true ? ' on' : ''),
        }),
        ))),
        // ── 动作条目：开关式（kind==='switch'）与按钮式两种形态 ──
        ...(status === null ? [] : actions.map((action) => {
          const isSwitch = action.kind === 'switch';
          const phase = actionPhaseOf(action);
          const checked = actionCheckedOf(action);
          // v3.1：徽标用属主的 runningLabel（admin-channel =「已开启」），
          // 没给时才退回双主智能的「运行中 / 待命中」。
          const badge = phase === 'running'
            ? (action.runningLabel ?? '运行中')
            : phase === 'armed' ? '待命中' : null;
          // 属主 note 是稳定文案；running 时长由客户端每秒叠加（见 runningElapsed）。
          const elapsed = runningElapsed(action, nowTick);
          const stateLine = (typeof action.note === 'string' && action.note !== '') || elapsed !== ''
            ? h('div', { className: 'wb-act-state' }, `${action.note ?? ''}${elapsed}`)
            : null;
          if (isSwitch) {
            // 属主自带随阶段变化的提示（管理员权限通道的「等待 UAC」/「关闭会结束
            // 提权进程」就在这里）；没有时：双主智能保留固定文案，其它属主用中性文案。
            const fallbackHint = action.id === 'dual-agent'
              ? phase === 'running'
                ? '关闭将中断执行者（不触发挑刺）'
                : phase === 'armed'
                  ? '已启用：下一条你发出的消息就是任务'
                  : '打开后武装待命，键入初始指令即交给后台执行者'
              : `${action.label}：${checked ? (action.runningLabel ?? '已开启') : (action.idleLabel ?? '未开启')}`;
            const hint = action.available !== true
              ? '动作属主插件未响应（可能未安装或未启动）'
              : typeof action.hint === 'string' && action.hint !== ''
                ? action.hint
                : fallbackHint;
            return h('div', {
              key: 'action:' + action.id,
              className: 'wb-row wb-act-row',
              onClick: action.available === true && record.pending === 0
                ? () => { void triggerAction(sessionId, action.id, !checked); }
                : undefined,
            },
            h('button', {
              type: 'button',
              className: 'wb-switch',
              role: 'switch',
              'aria-checked': checked ? 'true' : 'false',
              'aria-label': `${action.label}：${checked ? '已启用' : '已关闭'}`,
              disabled: action.available !== true || record.pending > 0,
              title: hint,
              onMouseDown: (event) => { event.preventDefault(); },
              onClick: (event) => {
                event.stopPropagation();
                if (action.available !== true || record.pending > 0) return;
                void triggerAction(sessionId, action.id, !checked);
              },
            }, h('i', null)),
            h('span', { style: { minWidth: 0 } },
              h('div', { className: 'wb-row-label' },
                action.label,
                badge !== null ? h('span', { className: 'wb-act-badge' + (phase === 'armed' ? ' wb-act-badge-armed' : '') }, badge) : null,
              ),
              h('div', { className: 'wb-row-desc' }, action.description),
              stateLine,
            ),
            // 行尾状态点与开关条目同款：开=绿 / 关=灰 / 保存中=琥珀呼吸。
            h('span', { className: 'wb-dot' + (record.busy ? ' busy' : '') + (checked ? ' on' : '') }),
            );
          }
          const label = phase === 'running'
            ? (action.runningLabel ?? '停止')
            : phase === 'armed'
              ? '取消待命'
              : (action.idleLabel ?? '启动');
          const hint = phase === 'running'
            ? '点击暂停执行者（回到待命，等用户补充）'
            : phase === 'armed'
              ? '点击取消待命（完全关闭双主智能）'
              : '点击启动（之后键入初始指令）';
          return h('div', {
            key: 'action:' + action.id,
            className: 'wb-act',
          },
          h('button', {
            type: 'button',
            className: 'wb-act-btn' + (phase === 'running' ? ' wb-stop' : phase === 'armed' ? ' wb-armed' : ''),
            disabled: action.available !== true || record.pending > 0,
            'aria-label': `${action.label}：${label}`,
            title: action.available !== true ? '动作属主插件未响应（可能未安装或未启动）' : hint,
            onMouseDown: (event) => { event.preventDefault(); },
            onClick: (event) => {
              event.stopPropagation();
              void triggerAction(sessionId, action.id);
            },
          }, label),
          h('span', { style: { minWidth: 0 } },
            h('div', { className: 'wb-act-label' },
              action.label,
              badge !== null ? h('span', { className: 'wb-act-badge' + (phase === 'armed' ? ' wb-act-badge-armed' : '') }, badge) : null,
            ),
            // 功能说明常驻；阶段说明单独一行（不覆盖说明，也不改变行高节奏）。
            h('div', { className: 'wb-act-desc' }, action.description),
            stateLine,
          ),
          );
        })),
        issues.length > 0 ? h('div', { className: 'wb-warn' }, issues.join('；')) : null,
        typeof record.saveError === 'string' && record.saveError !== '' ? h('div', { className: 'wb-warn' }, `保存失败：${record.saveError}（已还原，可重拨）`) : null,
        ) : null,
      );
    }

    let pluginCtx = null;

    /**
     * 「已停止」→「执行中」的文案改写（2026-10-30 用户指令「主页面不要用已停止，
     * 用执行中」，并指明是对话上下文区里的那个）。
     *
     * 背景：双主智能的阻塞语义要求主 Agent 的任务回合被 cancel —— 内核据此把
     * `turn/end` 记成 `reason.kind='aborted'`，而 dsh-client-ui-chat 的
     * `message.stopped`（zh「已停止」）正是渲染给 aborted/interrupted 回合的标签。
     * 于是用户每发一条任务，主页面就出现一个「已停止」——而活其实正在后台执行者
     * 那里干，观感像坏了。
     *
     * 实现口径：宿主 locale 的字典是**按引用**查找的（LocaleRuntime.lookup 读
     * `dicts.get(ns).get(locale)[key]`），所以直接改 chat ns 里那个 entries 对象
     * 的 `message.stopped` 即可生效。作用域按双主智能的阶段收窄：
     *   · armed / running → 改成「执行中」（这段时间被 cancel 的回合都是它的阻塞回合）；
     *   · off             → 还原（用户自己按停止键时仍应看到「已停止」）。
     * 全程 try/catch：宿主内部结构若变（ns 改名、字段私有化），静默降级为不改写，
     * 绝不让 UI 挂掉。
     */
    const CHAT_NS = 'chat';
    const STOPPED_KEY = 'message.stopped';
    const RUNNING_LABEL = '执行中';
    // 原始文案快照键：挂在 dict 上，只写一次（首次见到时），off 时据此还原。
    // 故意**不用**模块级布尔标记状态——改写与否完全由 dict 现值 vs 快照值推导，
    // 这样即使 locale 实例被替换（或测试里换实例）也不会卡在错误的状态上。
    const ORIGIN_KEY = '__wbOrigStopped';

    function chatDicts() {
      const locale = pluginCtx?.get?.('locale');
      const dicts = locale?.dicts;
      if (!(dicts instanceof Map)) return null;
      const perLocale = dicts.get(CHAT_NS);
      if (!(perLocale instanceof Map)) return null;
      return perLocale;
    }

    /** 首次见到就先快照原始文案（只写一次，之后不被覆盖）。 */
    function snapshotOriginals(perLocale) {
      for (const dict of perLocale.values()) {
        if (dict !== null && typeof dict === 'object'
          && typeof dict[STOPPED_KEY] === 'string' && dict[ORIGIN_KEY] === undefined) {
          dict[ORIGIN_KEY] = dict[STOPPED_KEY];
        }
      }
    }

    function patchStoppedLabel(on) {
      try {
        const perLocale = chatDicts();
        if (perLocale === null) return;
        snapshotOriginals(perLocale);
        for (const dict of perLocale.values()) {
          if (dict === null || typeof dict !== 'object') continue;
          if (on) {
            if (typeof dict[STOPPED_KEY] === 'string' && dict[STOPPED_KEY] !== RUNNING_LABEL) {
              dict[STOPPED_KEY] = RUNNING_LABEL;
            }
          } else if (typeof dict[ORIGIN_KEY] === 'string' && dict[STOPPED_KEY] !== dict[ORIGIN_KEY]) {
            dict[STOPPED_KEY] = dict[ORIGIN_KEY];
          }
        }
      } catch { /* 宿主内部结构变化：静默不改写 */ }
    }

    /** 按双主智能的阶段收窄/还原「已停止」文案。 */
    function syncStoppedLabel(status) {
      const action = (status?.actions ?? []).find((a) => a.id === 'dual-agent');
      const phase = action === undefined ? 'off' : actionPhaseOf(action);
      patchStoppedLabel(phase === 'armed' || phase === 'running');
    }

    function apply(ctx) {
      pluginCtx = ctx;
      // 尽早快照 chat ns 的原始「已停止」文案：之后的轮询只负责按阶段改写/还原。
      try { snapshotOriginals(chatDicts() ?? new Map()); } catch { /* 宿主结构变化：静默 */ }
      const styleNode = injectStyles();
      ctx.effect(() => () => {
        stylesInjected = false;
        if (styleNode !== null && styleNode.parentNode !== null) styleNode.parentNode.removeChild(styleNode);
      }, 'dsh-workbench: styles');
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
        {
          name: 'conversation.input.left',
          id: 'workbench',
          // 原 ultracode 的座位（23）；它让位后挪到 90。
          order: 23,
        },
        WorkbenchToggle,
      ));
    }

    const exports = { inject: ['slots'], apply };
    return exports;
  },
});
