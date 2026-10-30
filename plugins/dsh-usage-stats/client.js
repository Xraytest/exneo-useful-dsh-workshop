/**
 * DSH 用量统计（dsh-usage-stats）— 浏览器半边。
 *
 * 设置页新增「用量统计」一节：模型 / 供应商 / 会话 / 每日 / 每周 五个维度，
 * 图表（堆叠柱状 / 折线 / 累计面积 / 横向条形 / 环形占比）+ 明细表，
 * 支持时间范围、子代理归属口径切换、重建回填与 CSV 导出。
 *
 * 图表全部是纯 SVG / CSS（React.createElement 手写，无第三方图表库）：
 *   - 时间维：堆叠柱状图（输入/输出/缓存读/缓存写）· 折线趋势 · 累计面积
 *   - 其它维：横向堆叠条形图（Top N，含调用次数与会话数）· 环形占比图
 * 序列色为固定中调色（浅色/深色主题下都可读），网格线/文字/坐标轴走主题 token，
 * 折线与面积走 var(--dsw-alias-brand-primary)，随主题自动适配。
 *
 * 数据来自本插件 host 半边的 webServer 路由（静态插件没有动态包的 host.call，
 * 同源相对路径在 loopback 直连与 dsh-lanmode 反代下都可用）。
 *
 * 由 package.json 的 dsh.client 声明装载（inject：slots）；
 * 组合行见 cordis.patch.yml。
 *
 * @module dsh-usage-stats/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-stats',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const PAGE_CSS = [
      '.ust { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px 24px; }',
      '.ust-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }',
      '.ust-title { font-size: 16px; font-weight: 650; letter-spacing: .1px; color: var(--dsw-alias-label-primary); }',
      '.ust-sub { margin-top: 4px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }',
      '.ust-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px; border-radius: 12px; background: var(--dsw-alias-bg-layer-2); }',
      '.ust-tab { appearance: none; border: 1px solid transparent; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; padding: 5px 14px; cursor: pointer; transition: background .18s ease, color .18s ease, box-shadow .18s ease; }',
      '.ust-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }',
      '.ust-tab.is-on { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-brand-primary); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.12); }',
      '.ust-sep { width: 1px; height: 16px; background: var(--dsw-alias-border-l1); margin: 0 4px; }',
      '.ust-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 500; padding: 5px 12px; cursor: pointer; text-decoration: none; display: inline-block; transition: border-color .15s ease, background .15s ease, transform .15s ease; }',
      '.ust-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }',
      '.ust-btn:active:not(:disabled) { transform: translateY(1px); }',
      '.ust-btn:disabled { opacity: 0.55; cursor: default; }',
      '.ust-cards { display: flex; flex-wrap: wrap; gap: 8px; }',
      '.ust-card { flex: 1 1 130px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; box-shadow: 0 1px 2px rgba(0,0,0,.05); transition: box-shadow .18s ease, transform .18s ease; }',
      '.ust-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,.08); transform: translateY(-1px); }',
      '.ust-card-k { font-size: 11px; font-weight: 500; letter-spacing: .3px; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }',
      '.ust-card-v { margin-top: 6px; font-size: 20px; font-weight: 650; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; line-height: 1.2; }',
      '.ust-chart-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 1px 2px rgba(0,0,0,.05); }',
      '.ust-chart-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }',
      '.ust-chart-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.ust-legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }',
      '.ust-legend-i { display: inline-flex; align-items: center; gap: 4px; }',
      '.ust-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }',
      '.ust-chart svg { display: block; width: 100%; height: auto; }',
      '.ust-hover { font-size: 11px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; min-height: 15px; }',
      '.ust-hover em { font-style: normal; color: var(--dsw-alias-label-secondary); }',
      '.ust-hrows { display: flex; flex-direction: column; gap: 5px; }',
      '.ust-hrow { display: flex; align-items: center; gap: 8px; }',
      '.ust-hinfo { flex: 0 0 34%; min-width: 110px; }',
      '.ust-hlabel { font-size: 11px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.ust-hmeta { font-size: 10px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.ust-htrack { flex: 1 1 auto; height: 14px; background: var(--dsw-alias-bg-layer-2); border-radius: 4px; overflow: hidden; }',
      '.ust-hfill { height: 100%; display: flex; border-radius: 4px; overflow: hidden; min-width: 2px; }',
      '.ust-hseg { display: block; height: 100%; }',
      '.ust-hval { flex: 0 0 66px; text-align: right; font-size: 11px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }',
      '.ust-donut-wrap { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }',
      '.ust-donut { flex: 0 0 190px; max-width: 190px; }',
      '.ust-donut-legend { display: flex; flex-direction: column; gap: 5px; font-size: 11px; flex: 1 1 240px; min-width: 200px; }',
      '.ust-donut-row { display: flex; align-items: center; gap: 6px; }',
      '.ust-donut-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }',
      '.ust-donut-val { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }',
      '.ust-table-wrap { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; overflow: auto; max-height: 52vh; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 1px 2px rgba(0,0,0,.05); }',
      '.ust-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
      '.ust-table th { position: sticky; top: 0; z-index: 1; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-weight: 600; font-size: 11px; letter-spacing: .3px; text-transform: uppercase; text-align: right; padding: 9px 12px; white-space: nowrap; border-bottom: 1px solid var(--dsw-alias-border-l2); }',
      '.ust-table th.l, .ust-table td.l { text-align: left; }',
      '.ust-table td { padding: 8px 12px; text-align: right; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; transition: background .12s ease; }',
      '.ust-table tr:last-child td { border-bottom: none; }',
      '.ust-table tbody tr:hover td { background: var(--dsw-alias-bg-layer-2); }',
      '.ust-key { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }',
      '.ust-keybtn { display: block; max-width: 100%; margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; }',
      '.ust-keybtn:hover { color: var(--dsw-alias-brand-primary); text-decoration: underline; }',
      '.ust-keybtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 3px; }',
      '.ust-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }',
      '.ust-share { display: inline-block; height: 6px; border-radius: 3px; background: var(--dsw-alias-brand-primary); opacity: 0.75; min-width: 2px; vertical-align: middle; }',
      '.ust-cachebar-legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }',
      '.ust-crows { display: flex; flex-direction: column; gap: 5px; }',
      '.ust-crow { display: flex; align-items: center; gap: 8px; }',
      '.ust-cinfo { flex: 0 0 34%; min-width: 110px; }',
      '.ust-cnone { flex: 1 1 auto; font-size: 10px; color: var(--dsw-alias-label-secondary); }',
      '.ust-ccover { font-size: 10px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }',
      // 命中率详情弹窗：与 dsh-message-branches 同一套做法（fixed 覆盖层 + 面板，
      // 点背景关闭），不依赖 portal —— 设置页里没有可用的挂载点。
      '.ust-overlay { position: fixed; inset: 0; z-index: 1200; background: rgba(0,0,0,.42); display: flex; align-items: center; justify-content: center; padding: 24px; }',
      '.ust-modal { width: min(560px, 100%); max-height: 82vh; overflow: auto; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; box-shadow: 0 16px 40px rgba(0,0,0,.30); padding: 18px 20px; }',
      '.ust-modal-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }',
      '.ust-modal-title { flex: 1 1 auto; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); word-break: break-all; }',
      '.ust-modal-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }',
      '.ust-modal-close { flex: 0 0 auto; }',
      '.ust-modal-hero { display: flex; align-items: baseline; gap: 10px; margin: 6px 0 10px; }',
      '.ust-modal-rate { font-size: 26px; font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }',
      '.ust-modal-ratek { font-size: 11px; color: var(--dsw-alias-label-secondary); }',
      '.ust-modal-bar { display: flex; align-items: center; gap: 10px; margin: 8px 0; }',
      '.ust-modal-legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }',
      '.ust-modal-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px 14px; margin: 10px 0 4px; }',
      '.ust-modal-kv div { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; border-bottom: 1px dashed var(--dsw-alias-border-l1); padding-bottom: 3px; }',
      '.ust-modal-k { color: var(--dsw-alias-label-secondary); }',
      '.ust-modal-v { color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }',
      '.ust-modal-note { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 8px; line-height: 1.5; }',
      '.ust-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 10px 2px; }',
      '.ust-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }',
      '.ust-notice { font-size: 12px; color: var(--dsw-alias-state-success-primary); }',
    ].join('\n');

    function injectStyles() {
      if (typeof document === 'undefined') return;
      const tagId = 'dsh-usage-stats/page.css';
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-usage-stats';
      tag.dataset.pluginCss = tagId;
      tag.textContent = PAGE_CSS;
      (document.head || document.documentElement).appendChild(tag);
    }

    const errorText = (error) => String(error && error.message ? error.message : error);

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok) {
        throw new Error(body && body.error ? body.error : 'HTTP ' + response.status);
      }
      return body;
    }

    const TABS = [
      { by: 'model', label: '模型' },
      { by: 'provider', label: '供应商' },
      { by: 'group', label: '分组' },
      { by: 'session', label: '会话' },
      { by: 'day', label: '每日' },
      { by: 'week', label: '每周' },
    ];
    const RANGES = [
      { range: '1d', label: '今日' },
      { range: '7d', label: '近 7 天' },
      { range: '30d', label: '近 30 天' },
      { range: 'all', label: '全部' },
    ];
    const COLS = ['调用', '输入', '输出', '缓存读', '缓存写', '推理', '总计', '缓存占比', '会话'];

    /* ------------------------------------------------ 视图偏好持久化 ---- */

    // 「查看的页面与选项」存 localStorage：换页签 / 换范围 / 开关面板之后，刷新、
    // 热换（dsh-client-hmr 会重挂本组件）、重开设置页都回到上次的看处。
    // 只存这几个键，且**逐项校验**——存档可能来自旧版本或被人手改过，非法值一律
    // 丢掉用默认值（否则一个坏 by 就能让页面显示「host 没接入该维度」的红字）。
    const VIEW_KEY = 'dsh-usage-stats.view.v1';
    // 注意 subagents 的默认值是 null（跟随服务端配置），null 是合法取值，
    // 所以校验用「有没有这个键」而不是「值是不是 falsy」。
    const VIEW_SPEC = {
      by: ['model', 'provider', 'group', 'session', 'day', 'week'],
      range: ['all', '1d', '7d', '30d'],
      subagents: ['own', 'root', null],
      timeMode: ['bar', 'line', 'cum'],
      shareMode: ['bars', 'donut'],
      showTable: [true, false],
      showCache: [true, false],
    };
    const VIEW_DEFAULTS = {
      by: 'model', range: 'all', subagents: null,
      timeMode: 'bar', shareMode: 'bars',
      showTable: true,
      // 命中率总表现在是**可选项**：逐项命中率改由「点名称弹窗」查看，
      // 想同时铺开看所有项时再把这个开关打开（选择会被记住）。
      showCache: false,
    };
    const VIEW_KEYS = Object.keys(VIEW_SPEC);

    /** 取可用的 localStorage（无 window / 被禁用 / 隐私模式一律返回 null）。 */
    function viewStorage() {
      try {
        const storage = typeof window === 'undefined' ? null : window.localStorage;
        return storage && typeof storage.getItem === 'function' ? storage : null;
      } catch { return null; }
    }

    /** 读回已校验的偏好；缺失/非法/坏 JSON 一律落到默认值。 */
    function readView(storage) {
      const store = storage === undefined ? viewStorage() : storage;
      const out = Object.assign({}, VIEW_DEFAULTS);
      if (store === null || store === undefined) return out;
      let raw = null;
      try { raw = store.getItem(VIEW_KEY); } catch { return out; }
      if (typeof raw !== 'string' || raw === '') return out;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { return out; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
      for (const key of VIEW_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
        const value = parsed[key];
        if (VIEW_SPEC[key].indexOf(value) >= 0) out[key] = value;
      }
      return out;
    }

    /** 落盘：只写白名单里的键（不让别的状态混进来），失败静默（存储不可用）。 */
    function writeView(view, storage) {
      const store = storage === undefined ? viewStorage() : storage;
      if (store === null || store === undefined) return false;
      const payload = {};
      for (const key of VIEW_KEYS) {
        const value = view && Object.prototype.hasOwnProperty.call(view, key) ? view[key] : VIEW_DEFAULTS[key];
        if (VIEW_SPEC[key].indexOf(value) >= 0) payload[key] = value;
      }
      try { store.setItem(VIEW_KEY, JSON.stringify(payload)); return true; } catch { return false; }
    }

    /** 用量构成序列（浅/深主题都可读的中调色）。 */
    const SERIES = [
      { k: 'input', label: '输入', color: '#4c8df6' },
      { k: 'output', label: '输出', color: '#2fb98a' },
      { k: 'cacheRead', label: '缓存读', color: '#9b6ef3' },
      { k: 'cacheWrite', label: '缓存写', color: '#e8a33d' },
    ];
    const DONUT_COLORS = ['#4c8df6', '#2fb98a', '#9b6ef3', '#e8a33d', '#e5657a', '#39b8c9', '#8f9bb3', '#c9a227'];
    const REST_COLOR = '#7b8794';

    const fmt = (n) => (typeof n === 'number' && n > 0 ? n.toLocaleString('en-US') : '0');

    function shortNum(n) {
      if (typeof n !== 'number' || n <= 0) return '0';
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
      return String(n);
    }

    /** 坐标轴上界取整到 1/2/2.5/5/10 × 10^n。 */
    function niceMax(v) {
      if (!(v > 0)) return 1;
      const exp = Math.floor(Math.log10(v));
      const base = Math.pow(10, exp);
      const n = v / base;
      const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
      return step * base;
    }

    function fmtTime(ms) {
      if (typeof ms !== 'number' || ms <= 0) return '—';
      try { return new Date(ms).toLocaleString(); } catch { return '—'; }
    }

    const sum = (r) => (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);

    /* ---------------------------------------- 模型缓存占比（逐项口径） ---- */

    // 用量口径：inputTokens 与 cacheReadTokens **互斥**（未命中缓存的输入与命中缓存
    // 的输入各自单独计），故「计费输入」billed = input + cacheRead + cacheWrite。
    //
    // 缓存占比的分母**只算带缓存字段的那部分流量**：有些渠道根本不上报
    // cacheRead/cacheWrite（实测 ModelScope 渠道的 deepseek-ai/DeepSeek-V4.1-Flash
    // 全语料 1808 条 usage 都不带这两个键），把没上报的流量按「未命中」摊进分母
    // 等于把「没上报」当成 0% 命中——实测一个会话真实命中率 96.4% 会被拖成 25.9%。
    // 所以 host 给的是：cacheShare（实测命中率）+ cacheCoverage（覆盖了多少流量）
    // + cacheUnknownInput（没上报的计费输入）。
    //
    // **占比一律逐项计算**（每个模型 / 供应商 / 会话 / 分组各自算自己的），
    // 不拿总量一刀切——总量会被大用户稀释，掩盖单项的真实命中情况。
    // 可测流量为 0 时返回 null → 显示「无缓存数据」，绝不当 0%，
    // 否则等于断言「一次都没命中过缓存」。
    const cacheShareOf = (r) => {
      if (r.cacheKnown === false) return null;
      if (r.cacheShare === null || r.cacheShare === undefined) {
        // host 没给字段时才自行兜底算（老 host / 离线条目）。
        // 没有覆盖度信息时退回全量分母，与 v6 之前的展示一致。
        if (r.cacheCoverage === 0) return null;
        const billed = (r.input || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);
        if (billed <= 0) return null;
        return ((r.cacheRead || 0) + (r.cacheWrite || 0)) / billed;
      }
      return r.cacheShare;
    };
    /** 覆盖度 0..1；未知返回 null（表示「没有覆盖度信息」，不是「全没覆盖」）。 */
    const cacheCoverageOf = (r) => {
      if (r.cacheCoverage === null || r.cacheCoverage === undefined) return null;
      return r.cacheCoverage;
    };
    const pctText = (share) => (
      share === null || share === undefined ? '无缓存数据' : (share * 100).toFixed(1) + '%'
    );
    /** 覆盖度不足时补一句「覆盖 N%」，全覆盖/未知都不显示。 */
    const coverageHint = (r) => {
      const cov = cacheCoverageOf(r);
      // 0 = 完全没有可测流量，此时该行本身就是「无缓存数据」，再标一句「覆盖 0.00%」
      // 是同一件事说两遍；1 = 全覆盖，也没必要多嘴。
      if (cov === null || cov <= 0 || cov >= 0.9995) return null;
      return '覆盖 ' + (cov * 100).toFixed(cov < 0.01 ? 2 : 1) + '%';
    };

    /** 输入构成序列（三者互斥，和为计费输入）。 */
    const INPUT_SERIES = [
      { k: 'input', label: '未命中输入', color: '#4c8df6' },
      { k: 'cacheRead', label: '缓存读', color: '#9b6ef3' },
      { k: 'cacheWrite', label: '缓存写', color: '#e8a33d' },
    ];

    /**
     * 行的显示名：别名/标签 > 统计键 > 兜底占位。host 永远给 key，但前端**不该**
     * 把 undefined 画到屏幕上（空对象行曾在弹窗标题里渲染出「模型 · undefined」）。
     */
    const displayName = (r) => String((r && (r.label || r.key)) || '(未命名)');

    /** 该项的「可测计费输入」构成段（未命中输入 / 缓存读 / 缓存写，三者互斥）。 */
    function inputSegments(r) {
      return INPUT_SERIES.map((s) => ({
        k: s.k, label: s.label, color: s.color, value: r[s.k] || 0,
      })).filter((s) => s.value > 0);
    }

    /** 构成条本体（横条 / 弹窗共用）：按可测计费输入摊开三段，附 tokens 提示。 */
    function inputBar(r, extraClass) {
      const billed = (r.input || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);
      return h('div', { className: 'ust-htrack' + (extraClass ? ' ' + extraClass : ''),
        title: '计费输入 ' + fmt(billed) + ' tokens（其中可测 ' + fmt(billed - (r.cacheUnknownInput || 0)) + '）' },
        h('div', { className: 'ust-hfill', style: { width: '100%' } },
          inputSegments(r).map((seg) => h('span', {
            key: seg.k, className: 'ust-hseg',
            style: { flexGrow: seg.value, background: seg.color },
            title: seg.label + ' ' + fmt(seg.value),
          })),
        ),
      );
    }

    /**
     * 可点击的名称（明细表键列 / 命中率总表每行）：点开该项的命中率详情弹窗。
     * 单独抽成组件是为了能无头断言「名称真的是个带 onPick 的按钮」。
     */
    function KeyCell(props) {
      const r = props.row;
      return h('button', {
        type: 'button',
        className: 'ust-keybtn',
        title: (props.hint || '查看该项的缓存命中率详情') + '：' + hoverTitle(r),
        onClick: props.onPick ? () => props.onPick(r) : undefined,
      }, displayName(r));
    }

    /**
     * 缓存占比 · 单行横条：把该项**可测**的计费输入按 未命中输入 / 缓存读 / 缓存写
     * 摊开，右侧给该项自己的实测占比（不是总量口径），覆盖度不足时补「覆盖 N%」。
     * 名称可点（onPick）→ 同一行的详情弹窗。
     */
    function CacheRow(props) {
      const r = props.row;
      const share = cacheShareOf(r);
      const hint = coverageHint(r);
      return h('div', { className: 'ust-crow', key: r.key },
        h('div', { className: 'ust-cinfo' },
          // 直接调用（不是 h(KeyCell, …)）：KeyCell 无 hooks，直接调用后树是平的，
          // charts-harness 的静态渲染与 preview.mjs 才能展开出名称文本。
          h('div', { className: 'ust-hlabel' }, KeyCell({ row: r, onPick: props.onPick })),
          h('div', { className: 'ust-hmeta', title: hoverTitle(r) },
            (r.model ? rawName(r) + ' · ' : '') + fmt(r.calls) + ' 次'),
        ),
        share === null
          ? h('div', { className: 'ust-cnone' }, '无缓存数据')
          : inputBar(r),
        // share === null 时「无缓存数据」已经说明问题，不再重复标覆盖度。
        hint === null || share === null ? null
          : h('div', { className: 'ust-ccover', title: '未上报缓存状态的计费输入 ' + fmt(r.cacheUnknownInput || 0) + ' tokens' }, hint),
        h('div', { className: 'ust-hval', title: share === null ? '无缓存数据' : '缓存占比 ' + pctText(share) },
          share === null ? '—' : (share * 100).toFixed(1) + '%'),
      );
    }

    /**
     * 命中率总表（逐项）：当前维度每一行自己的输入构成与实测占比，
     * 按用量降序取前 N。任何页签 / 范围都用同一口径，不是只给模型维用。
     * 它是**可选项**（默认关，见 VIEW_DEFAULTS），单个模型的命中率走点击名称的弹窗。
     */
    function CacheBars(props) {
      const rows = props.rows.filter((r) => cacheShareOf(r) !== null || r.calls > 0);
      const withCache = rows.filter((r) => cacheShareOf(r) !== null).length;
      return h('div', { className: 'ust-chart-card' },
        h('div', { className: 'ust-chart-head' },
          h('div', { className: 'ust-chart-title' }, props.title || '命中率总表（逐项）'),
          h('div', { className: 'ust-cachebar-legend' },
            INPUT_SERIES.map((s) => h('span', { className: 'ust-legend-i', key: s.k },
              h('span', { className: 'ust-dot', style: { background: s.color } }), s.label)),
            h('span', { className: 'ust-legend-i' },
              '有缓存数据 ' + fmt(withCache) + ' / ' + fmt(rows.length) + ' 项'),
          ),
        ),
        rows.length === 0
          ? h('div', { className: 'ust-empty' }, '该范围没有用量记录。')
          // 直接调用（不是 h(CacheRow, …)）：CacheRow 无 hooks、纯函数，
          // 直接调用后元素树是平的，charts-harness 的静态渲染能照常展开它
          // （preview.mjs 同理只 renderToHtml 叶子组件）。
          : h('div', { className: 'ust-crows' }, rows.slice(0, props.limit || 20).map((r) => CacheRow({ row: r, onPick: props.onPick }))),
        h('div', { className: 'ust-sub' },
          '口径：input 与 cacheRead 互斥，计费输入 = 输入 + 缓存读 + 缓存写；'
          + '缓存占比 = 缓存读+写 / **可测计费输入**（只含有缓存字段的流量），逐项计算。'
          + '没上报缓存状态的流量不摊进分母（否则会把「没上报」当成「没命中」），'
          + '其占比用「覆盖 N%」标出。「无缓存数据」= 该项完全没有可测流量。'),
      );
    }

    /**
     * 命中率详情弹窗（点名称打开）：把**一项**的命中率讲清楚——
     * 实测占比 + 覆盖度 + 可测构成 + 未上报流量 + 各项 token。
     * 纯函数（无 hooks），可无头渲染断言；关闭：右上角按钮 / 点背景 / Esc。
     */
    function CacheDetail(props) {
      const r = props.row;
      if (r === null || r === undefined) return null;
      const onClose = props.onClose;
      const share = cacheShareOf(r);
      const cov = cacheCoverageOf(r);
      const hint = coverageHint(r);
      const billed = (r.input || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);
      const unknown = r.cacheUnknownInput || 0;
      const measured = Math.max(0, billed - unknown);
      const closeOnBackdrop = (event) => {
        if (onClose && event && event.target === event.currentTarget) onClose();
      };
      const kv = (k, v, title) => h('div', { key: k, title: title || undefined },
        h('span', { className: 'ust-modal-k' }, k),
        h('span', { className: 'ust-modal-v' }, v));
      const stats = [
        kv('调用次数', fmt(r.calls)),
        props.by === 'session' ? null : kv('会话数', fmt(r.sessions)),
        kv('计费输入', fmt(billed) + ' tokens', '输入 + 缓存读 + 缓存写'),
        kv('可测输入', fmt(measured) + ' tokens', '带缓存字段的流量，命中率的分母'),
        kv('未上报输入', fmt(unknown) + ' tokens', '不带缓存字段的流量，不进分母'),
        kv('未命中输入', fmt(r.input || 0)),
        kv('缓存读', fmt(r.cacheRead || 0)),
        kv('缓存写', fmt(r.cacheWrite || 0)),
        kv('输出', fmt(r.output || 0)),
      ].filter(Boolean);
      if (r.reasoning) stats.push(kv('推理', fmt(r.reasoning)));
      stats.push(kv('总计', fmt(r.total || 0)));
      const extras = [];
      if (props.by === 'model') {
        if (r.model) extras.push(kv('请求名', r.model));
        if (r.settingsName) extras.push(kv('模型设置名', r.settingsName));
        if (r.providers) extras.push(kv('供应商', r.providers.join(', ')));
      } else if (props.by === 'session') {
        if (r.cwd) extras.push(kv('工作目录', r.cwd));
        extras.push(kv('来源', r.origin === 'subagent' ? '子代理' : '主会话'));
        extras.push(kv('归档', r.archived ? '已归档' : '未归档'));
        if (r.createdAt) extras.push(kv('创建时间', fmtTime(r.createdAt)));
        if (r.parentSession) extras.push(kv('父会话', r.parentSession));
      } else if (props.by === 'group') {
        extras.push(kv('分组', r.ungrouped === true ? '未命中任何分组' : displayName(r)));
      }
      const segs = inputSegments(r);
      const legend = h('div', { className: 'ust-modal-legend' },
        segs.map((seg) => h('span', { className: 'ust-legend-i', key: seg.k },
          h('span', { className: 'ust-dot', style: { background: seg.color } }),
          seg.label + ' ' + fmt(seg.value))),
        unknown > 0 ? h('span', { className: 'ust-legend-i' }, '未上报 ' + fmt(unknown)) : null,
      );
      const unknownNote = unknown <= 0 ? null
        : share === null
          // 完全没有可测流量：这里不能说「覆盖 0.0%」——上面根本没有数字可覆盖。
          ? h('div', { className: 'ust-modal-note' },
              '这 ' + fmt(unknown) + ' tokens 计费输入全部来自不上报缓存字段的路由，'
              + '没有任何可测流量，所以该项的命中率不可测（显示「无缓存数据」，不当作 0%）。')
          : h('div', { className: 'ust-modal-note' },
              '另有 ' + fmt(unknown) + ' tokens 计费输入来自不上报缓存字段的路由，不进命中率分母'
              + '（否则会把「没上报」当成「没命中」），所以上面的数字只覆盖 '
              + (cov === null ? '—' : (cov * 100).toFixed(1) + '%') + ' 的计费输入。');
      return h('div', { className: 'ust-overlay', onMouseDown: closeOnBackdrop },
        h('div', { className: 'ust-modal', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'ust-modal-head' },
            h('div', null,
              h('div', { className: 'ust-modal-title' },
                (props.dimName ? props.dimName + ' · ' : '') + displayName(r) + ' · 缓存命中率'),
              h('div', { className: 'ust-modal-sub' }, hoverTitle(r)),
            ),
            h('button', { type: 'button', className: 'ust-btn ust-modal-close', onClick: onClose }, '关闭'),
          ),
          h('div', { className: 'ust-modal-hero' },
            h('span', { className: 'ust-modal-rate' }, share === null ? '无缓存数据' : pctText(share)),
            h('span', { className: 'ust-modal-ratek' },
              share === null
                ? '该项没有任何带缓存字段的流量，命中率不可测（不当作 0%）'
                : '缓存命中率 =（缓存读 + 缓存写）/ 可测计费输入'),
            hint === null ? null
              : h('span', { className: 'ust-ccover', title: '未上报缓存状态的计费输入 ' + fmt(unknown) + ' tokens' }, hint),
          ),
          share === null ? null : h('div', { className: 'ust-modal-bar' }, inputBar(r), legend),
          unknownNote,
          h('div', { className: 'ust-modal-kv' }, stats),
          extras.length === 0 ? null : h('div', { className: 'ust-modal-kv' }, extras),
          h('div', { className: 'ust-modal-note' },
            '口径：DSH 的 usage 里 input 与 cacheRead 互斥，计费输入 = 输入 + 缓存读 + 缓存写；'
            + '命中率只按**可测**（带缓存字段）的流量算，逐项各自计算，不是总量口径。'),
        ));
    }

    /**
     * 弹窗那一行：按 key 从**当前**渲染用的行里取（不是打开时的快照）。
     * 刷新 / 回填 / 自动刷新后行对象会被整体替换，按 key 重取才能显示最新数字；
     * 行已不在当前视图（换范围、被截断）时返回 null，弹窗自动收起。
     */
    function rowByKey(rows, key) {
      if (key === null || key === undefined) return null;
      const list = Array.isArray(rows) ? rows : [];
      for (const r of list) if (r && r.key === key) return r;
      return null;
    }

    /**
     * 页面版块顺序（纯函数，便于无头断言）：
     *   数值表 / 图表 → 命中率总表（可选项）→ 明细表（可选项）→ 截断提示
     * 「命中率总表」默认不显示（逐项命中率走点名称的弹窗）；打开后落在
     * 「数值表之后、明细表之前」。
     */
    function orderedPanels(props) {
      const out = [];
      if (props.chartCard) out.push(props.chartCard);
      if (props.showCache === true && props.cacheCard) out.push(props.cacheCard);
      if (props.showTable === true && props.table) out.push(props.table);
      if (props.tail) out.push(props.tail);
      return out;
    }

    /**
     * 行的「请求名」：模型维显示别名，原始请求名只在悬停与副行里露出。
     * 非模型维没有别名，返回 key 本身。
     */
    const rawName = (r) => String((r && (r.model || r.key)) || '');
    const hoverTitle = (r) => (r && r.model ? '请求名：' + r.model : String((r && r.key) || ''));

    /* ------------------------------------------------------------ 图表 ---- */

    function Legend() {
      return h('div', { className: 'ust-legend' },
        SERIES.map((s) => h('span', { className: 'ust-legend-i', key: s.k },
          h('span', { className: 'ust-dot', style: { background: s.color } }), s.label)),
      );
    }

    /**
     * 时间维图表：堆叠柱状 / 折线趋势 / 累计面积。
     * mode: 'bar' | 'line' | 'cum'
     */
    function TimeChart(props) {
      const rows = props.rows;
      const mode = props.mode;
      const n = rows.length;
      const W = 760, H = 250, padL = 64, padR = 14, padT = 12, padB = 46;
      const innerW = W - padL - padR;
      const innerH = H - padT - padB;

      let plotMax = 1;
      const totals = rows.map((r) => r.total);
      const stackedTotals = rows.map(sum);
      if (mode === 'cum') {
        let acc = 0;
        for (const t of totals) acc += t;
        plotMax = acc || 1;
      } else {
        plotMax = Math.max(1, ...stackedTotals, ...totals);
      }
      const max = niceMax(plotMax);
      const x = (i) => padL + (innerW * (i + 0.5)) / Math.max(1, n);
      const y = (v) => padT + innerH - (v / max) * innerH;
      const band = innerW / Math.max(1, n);
      const barW = Math.max(2, Math.min(30, band * 0.68));
      const labelStep = Math.max(1, Math.ceil(n / 7));

      const children = [];

      // 网格 + y 轴刻度
      for (let g = 0; g <= 4; g++) {
        const v = (max * g) / 4;
        const gy = y(v);
        children.push(h('line', {
          key: 'g' + g, x1: padL, x2: W - padR, y1: gy, y2: gy,
          stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1,
          strokeDasharray: g === 0 ? '0' : '3 4',
        }));
        children.push(h('text', {
          key: 'gt' + g, x: padL - 8, y: gy + 4, textAnchor: 'end',
          fontSize: 11, fill: 'var(--dsw-alias-label-secondary)',
        }, shortNum(v)));
      }

      if (mode === 'bar') {
        rows.forEach((r, i) => {
          let acc = 0;
          for (const s of SERIES) {
            const v = r[s.k] || 0;
            if (v <= 0) continue;
            const y0 = y(acc);
            const y1 = y(acc + v);
            acc += v;
            children.push(h('rect', {
              key: 'b' + i + s.k,
              x: x(i) - barW / 2, y: y1, width: barW, height: Math.max(0.6, y0 - y1),
              fill: s.color, rx: barW > 6 ? 1.5 : 0,
            }));
          }
        });
      } else {
        const vals = [];
        let acc = 0;
        for (const t of totals) {
          if (mode === 'cum') { acc += t; vals.push(acc); } else vals.push(t);
        }
        const pts = vals.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1));
        const area = 'M ' + padL + ',' + y(0).toFixed(1) + ' L ' + pts.join(' L ')
          + ' L ' + (W - padR) + ',' + y(0).toFixed(1) + ' Z';
        children.push(h('path', { key: 'area', d: area, fill: 'var(--dsw-alias-brand-primary)', opacity: 0.16 }));
        children.push(h('polyline', {
          key: 'line', points: pts.join(' '), fill: 'none',
          stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 2,
          strokeLinejoin: 'round', strokeLinecap: 'round',
        }));
        vals.forEach((v, i) => {
          const isHover = props.hoverIndex === i;
          children.push(h('circle', {
            key: 'p' + i, cx: x(i), cy: y(v), r: isHover ? 4.5 : 2.6,
            fill: 'var(--dsw-alias-brand-primary)',
            stroke: 'var(--dsw-alias-bg-layer-1)', strokeWidth: isHover ? 2 : 0,
          }));
        });
      }

      // x 轴刻度
      rows.forEach((r, i) => {
        if (i % labelStep !== 0 && i !== n - 1) return;
        children.push(h('text', {
          key: 'x' + i, x: x(i), y: H - padB + 16, textAnchor: 'middle',
          fontSize: 10, fill: 'var(--dsw-alias-label-secondary)',
        // 行的 key 正常是 YYYY-MM-DD；缺了也不能在渲染里抛错（渲染抛错会带塌整页），
        // 退化成空标签即可。
        }, (() => { const k = String((r && r.key) || ''); return k.length > 7 ? k.slice(5) : k; })()));
      });

      // 悬停热区
      rows.forEach((r, i) => {
        children.push(h('rect', {
          key: 'hit' + i,
          x: padL + band * i, y: padT, width: band, height: innerH,
          fill: props.hoverIndex === i ? 'var(--dsw-alias-brand-primary)' : 'transparent',
          opacity: props.hoverIndex === i ? 0.07 : 0,
          onMouseEnter: () => props.onHover(i),
          onMouseLeave: () => props.onHover(null),
        }));
      });

      return h('div', { className: 'ust-chart' },
        h('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid meet', role: 'img' }, children),
      );
    }

    /** 其它维：横向堆叠条形图（Top N）。 */
    function HBars(props) {
      const rows = props.rows.slice(0, props.limit || 20);
      const max = Math.max(1, ...rows.map(sum));
      return h('div', { className: 'ust-hrows' }, rows.map((r, i) => {
        const total = sum(r);
        const meta = fmt(r.calls) + ' 次'
          + (r.sessions ? ' · ' + fmt(r.sessions) + ' 会话' : '')
          + (r.archived ? ' · 已归档' : '')
          + (r.origin === 'subagent' ? ' · 子代理' : '');
        return h('div', { className: 'ust-hrow', key: r.key },
          h('div', { className: 'ust-hinfo' },
            h('div', { className: 'ust-hlabel', title: hoverTitle(r) }, (i + 1) + '. ' + displayName(r)),
            h('div', { className: 'ust-hmeta', title: hoverTitle(r) }, r.model ? rawName(r) : meta),
          ),
          h('div', { className: 'ust-htrack', title: fmt(r.total) + ' tokens' },
            h('div', { className: 'ust-hfill', style: { width: Math.max(0.4, (total / max) * 100) + '%' } },
              SERIES.map((s) => (r[s.k] > 0
                ? h('span', {
                    key: s.k, className: 'ust-hseg',
                    style: { flexGrow: r[s.k], background: s.color },
                    title: s.label + ' ' + fmt(r[s.k]),
                  })
                : null)),
            ),
          ),
          h('div', { className: 'ust-hval' }, shortNum(r.total)),
        );
      }));
    }

    /** 其它维：环形占比图（Top N + 其它）。 */
    function Donut(props) {
      const limit = props.limit || 8;
      // 扇形值统一在入口折成有限数：undefined/NaN 会一路传到 frac，画成 NaN% 与空弧。
      const num = (v) => (Number.isFinite(v) ? v : 0);
      const top = props.rows.slice(0, limit);
      const rest = props.rows.slice(limit);
      const items = top.map((r, i) => ({
        key: r.key, label: displayName(r), value: num(r.total),
        color: DONUT_COLORS[i % DONUT_COLORS.length], row: r,
      }));
      const restTotal = rest.reduce((a, r) => a + num(r.total), 0);
      if (restTotal > 0) items.push({ key: '__rest', label: '其它 ' + rest.length + ' 项', value: restTotal, color: REST_COLOR, row: null });
      // NaN || 1 仍然是 NaN（NaN 是 truthy），所以值已在上面折成有限数，这里再兜底 0 总量。
      const total = items.reduce((a, it) => a + it.value, 0) || 1;
      const R = 58, CX = 76, CY = 76, SW = 22;
      const C = 2 * Math.PI * R;
      let acc = 0;
      const arcs = items.map((it) => {
        const frac = it.value / total;
        const len = frac * C;
        const node = h('circle', {
          key: it.key, cx: CX, cy: CY, r: R, fill: 'none',
          stroke: it.color, strokeWidth: SW,
          strokeDasharray: len.toFixed(2) + ' ' + (C - len).toFixed(2),
          strokeDashoffset: (-acc * C).toFixed(2),
          transform: 'rotate(-90 ' + CX + ' ' + CY + ')',
        });
        acc += frac;
        return node;
      });
      return h('div', { className: 'ust-donut-wrap' },
        h('div', { className: 'ust-donut' },
          h('svg', { viewBox: '0 0 152 152', role: 'img' },
            arcs,
            h('text', {
              x: CX, y: CY - 2, textAnchor: 'middle', fontSize: 15, fontWeight: 600,
              fill: 'var(--dsw-alias-label-primary)',
            }, shortNum(total)),
            h('text', {
              x: CX, y: CY + 14, textAnchor: 'middle', fontSize: 10,
              fill: 'var(--dsw-alias-label-secondary)',
            }, 'tokens'),
          ),
        ),
        h('div', { className: 'ust-donut-legend' }, items.map((it) => h('div', { className: 'ust-donut-row', key: it.key },
          h('span', { className: 'ust-dot', style: { background: it.color } }),
          h('span', { className: 'ust-donut-name', title: it.row ? hoverTitle(it.row) : it.key }, it.label),
          h('span', { className: 'ust-donut-val' },
            shortNum(it.value) + ' · ' + ((it.value / total) * 100).toFixed(1) + '%'
            + (it.row ? ' · ' + fmt(it.row.calls) + ' 次' : '')),
        ))),
      );
    }

    /** 悬停详情（柱状/折线共用）：显示该桶的完整构成。 */
    function HoverLine(props) {
      const r = props.row;
      if (!r) {
        return h('div', { className: 'ust-hover' },
          h('em', null, props.hint || '把鼠标移到图表上查看该点的明细'));
      }
      return h('div', { className: 'ust-hover' },
        h('strong', null, r.key), ' · 总计 ' + fmt(r.total) + ' tokens · ' + fmt(r.calls) + ' 次调用'
        + (props.cumulative ? ' · 累计 ' + fmt(props.cumulative) : '')
        + '　',
        SERIES.map((s) => h('span', { key: s.k },
          h('em', null, s.label + ' '), fmt(r[s.k]), '　')),
        r.reasoning > 0 ? h('span', null, h('em', null, '推理 '), fmt(r.reasoning)) : null,
        // 与逐项横条、明细表同一套规矩：share 为 null 时只说「无缓存数据」，
        // 不再补「（覆盖 0.00%）」——那是同一件事说两遍。
        h('span', null, h('em', null, '缓存占比 '), pctText(cacheShareOf(r)),
          cacheShareOf(r) === null || coverageHint(r) === null ? null : '（' + coverageHint(r) + '）'),
      );
    }

    /* ------------------------------------------------------- 主组件 ---- */

    function UsageStats() {
      // 初值来自持久化的视图偏好（页签 / 范围 / 图表模式 / 两个开关），
      // 详见 readView：非法值一律落到默认值。detail 是瞬态弹窗，**不**持久化。
      const saved = React.useMemo(() => readView(), []);
      const [by, setBy] = React.useState(saved.by);
      const [range, setRange] = React.useState(saved.range);
      const [subagents, setSubagents] = React.useState(saved.subagents);
      const [timeMode, setTimeMode] = React.useState(saved.timeMode);    // bar | line | cum
      const [shareMode, setShareMode] = React.useState(saved.shareMode);  // bars | donut
      const [showTable, setShowTable] = React.useState(saved.showTable);
      const [showCache, setShowCache] = React.useState(saved.showCache);
      // 弹窗存的是**行的键**而不是行对象快照：刷新 / 回填完成 / 自动刷新后
      // 行对象会被整个替换，存快照会让弹窗一直显示刷新前的旧数字。
      const [detailKey, setDetailKey] = React.useState(null);
      const [hoverIndex, setHoverIndex] = React.useState(null);
      const [data, setData] = React.useState(null);
      const [status, setStatus] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);

      const query = React.useMemo(() => {
        const parts = ['by=' + encodeURIComponent(by), 'range=' + encodeURIComponent(range)];
        if (subagents !== null) parts.push('subagents=' + encodeURIComponent(subagents));
        return parts.join('&');
      }, [by, range, subagents]);

      // 过期响应守卫：切页签/范围/子代理归属时会同时存在多个在飞请求，而原来是
      // 「谁后到谁写状态」——旧维度的响应会覆盖新维度：
      //   ① 页面显示的是上一个维度的数字；
      //   ② 维度自检那行红字会一闪而过（data.by 是旧维度、by 已是新页签）。
      // 所以只让**最新**那次请求写状态，并且加载期间先清掉旧结果。
      const loadSeq = React.useRef(0);

      // 换维度 / 换范围 / 改子代理归属时，**在点击的同一次状态更新里**就把旧结果清掉。
      // 这样「旧维度的数据 + 新页签」这个组合永远不会被提交进 DOM——维度自检那行红字
      // 因此不是「靠 React 在绘制前冲刷 effect 的时序兜住」，而是根本没有出现的时机。
      // 无效点击（点的就是当前项）直接跳过：query 不变就不会重新取数，清了数据只会让
      // 表格一直空着。
      const changeQuery = (changed, apply) => {
        if (changed !== true) return;
        setData(null);
        setError(null);
        apply();
      };

      const load = React.useCallback(async () => {
        const seq = ++loadSeq.current;
        setLoading(true);
        setError(null);
        setData(null);   // 不拿上一个维度的结果跟新页签比对（红字闪现的直接根因）
        try {
          const summary = await fetchJson('/dsh-usage/summary?' + query);
          const state = await fetchJson('/dsh-usage/status');
          if (seq !== loadSeq.current) return;
          setData(summary);
          setStatus(state);
          setHoverIndex(null);
        } catch (err) {
          if (seq !== loadSeq.current) return;
          setError(errorText(err));
        } finally {
          if (seq === loadSeq.current) setLoading(false);
        }
      }, [query]);

      React.useEffect(() => { void load(); }, [load]);
      React.useEffect(() => { setHoverIndex(null); }, [by]);

      // 「查看的页面与选项」落盘：任何一项变化都写回（失败静默——存储不可用时
      // 页面照常工作，只是下次打开回到默认视图）。
      React.useEffect(() => {
        writeView({ by, range, subagents, timeMode, shareMode, showTable, showCache });
      }, [by, range, subagents, timeMode, shareMode, showTable, showCache]);

      // 详情弹窗开着时按 Esc 关闭（window 上没有 addEventListener 的环境直接跳过）。
      React.useEffect(() => {
        if (detailKey === null) return undefined;
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const onKey = (event) => { if (event && (event.key === 'Escape' || event.key === 'Esc')) setDetailKey(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [detailKey]);

      // 换页签 / 换范围时旧行的明细不再对应当前视图，直接关掉。
      React.useEffect(() => { setDetailKey(null); }, [query]);

      // 回填期间轮询状态，完成后自动刷新。
      React.useEffect(() => {
        if (!busy) return undefined;
        let stop = false;
        // /status 往返超过 900ms 时会有两次 tick 同时在飞：与 load() 同理，只让**最新**
        // 那次写状态行，否则旧响应会把「已折叠 / 事实」的数字顶回旧值。
        let pollSeq = 0;
        const tick = async () => {
          const seq = ++pollSeq;
          try {
            const state = await fetchJson('/dsh-usage/status');
            if (stop || seq !== pollSeq) return;
            setStatus(state);
            if (state.backfill && state.backfill.running === false) {
              setBusy(false);
              setNotice('回填完成：扫描 ' + state.backfill.scanned + ' · 折叠 ' + state.backfill.folded
                + ' · 跳过 ' + state.backfill.skipped + ' · 导入 ' + state.backfill.imported);
              await load();
            }
          } catch { /* 下一轮再试 */ }
        };
        const timer = setInterval(() => { void tick(); }, 900);
        void tick();
        return () => { stop = true; clearInterval(timer); };
      }, [busy, load]);

      const rescan = React.useCallback(async (full) => {
        setNotice(null);
        setError(null);
        setBusy(true);
        try {
          const result = await fetchJson('/dsh-usage/rescan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ full: full === true }),
          });
          if (result && result.started === false) {
            setBusy(false);
            setNotice('已有回填在进行中');
          }
        } catch (err) {
          setBusy(false);
          setError(errorText(err));
        }
      }, []);

      const rows = (data && data.rows) || [];
      const totals = (data && data.totals) || { calls: 0, total: 0, sessions: 0 };
      // 弹窗那一行**每次渲染都从当前数据里重新取**（按 key 找）：刷新/回填后数字是最新的，
      // 行被过滤掉（换范围/截断）时弹窗自动消失，不会挂着一个不存在的项。
      const detail = rowByKey(rows, detailKey);
      const maxShare = rows.reduce((m, r) => Math.max(m, r.share || 0), 0) || 1;
      const isTime = by === 'day' || by === 'week';

      const header = h('div', { className: 'ust-head' },
        h('div', null,
          h('div', { className: 'ust-title' }, '用量统计'),
          h('div', { className: 'ust-sub' },
            '按 模型 / 供应商 / 会话 / 每日 / 每周 统计 token。事实来自会话日志折叠：'
            + '插件上线前的历史对话与导出归档（zip）都能回填，与实时记账同一口径，可加可对账。'),
        ),
        h('div', { className: 'ust-bar' },
          h('button', { className: 'ust-btn', onClick: () => void load(), disabled: loading }, '刷新'),
          h('button', { className: 'ust-btn', onClick: () => void rescan(false), disabled: busy }, busy ? '回填中…' : '增量回填'),
          h('button', { className: 'ust-btn', onClick: () => void rescan(true), disabled: busy }, '重建全部'),
          h('a', {
            className: 'ust-btn',
            href: '/dsh-usage/export.csv?' + query,
            target: '_blank',
            rel: 'noreferrer',
          }, '导出 CSV'),
        ),
      );

      const cards = h('div', { className: 'ust-cards' },
        h('div', { className: 'ust-card' },
          h('div', { className: 'ust-card-k' }, '总 token'),
          h('div', { className: 'ust-card-v' }, shortNum(totals.total))),
        h('div', { className: 'ust-card' },
          h('div', { className: 'ust-card-k' }, '缓存占比（合计）'),
          h('div', { className: 'ust-card-v',
            title: '当前范围所有项合计的实测缓存占比 = 缓存读+写 / 可测计费输入'
              + (totals.cacheCoverage === null || totals.cacheCoverage === undefined
                ? '' : '；覆盖 ' + (totals.cacheCoverage * 100).toFixed(1) + '% 的计费输入')
              + '。逐项占比：**点名称弹窗**查看，或打开「命中率总表」铺开看。' },
            cacheShareOf(totals) === null ? '无' : pctText(cacheShareOf(totals)))),
        h('div', { className: 'ust-card' },
          h('div', { className: 'ust-card-k' }, '调用次数'),
          h('div', { className: 'ust-card-v' }, fmt(totals.calls))),
        h('div', { className: 'ust-card' },
          h('div', { className: 'ust-card-k' }, '会话数'),
          h('div', { className: 'ust-card-v' }, fmt(totals.sessions))),
        h('div', { className: 'ust-card' },
          h('div', { className: 'ust-card-k' }, '已记账会话'),
          h('div', { className: 'ust-card-v' }, status ? fmt(status.sessions.withFacts) + ' / ' + fmt(status.sessions.total) : '—')),
        h('div', { className: 'ust-card' },
          h('div', { className: 'ust-card-k' }, '实时补记'),
          h('div', { className: 'ust-card-v' }, status ? fmt(status.facts.aux) : '—')),
      );

      const controls = h('div', { className: 'ust-bar' },
        TABS.map((t) => h('button', {
          key: t.by,
          className: 'ust-tab' + (by === t.by ? ' is-on' : ''),
          onClick: () => changeQuery(t.by !== by, () => setBy(t.by)),
        }, t.label)),
        h('div', { className: 'ust-sep' }),
        RANGES.map((r) => h('button', {
          key: r.range,
          className: 'ust-tab' + (range === r.range ? ' is-on' : ''),
          onClick: () => changeQuery(r.range !== range, () => setRange(r.range)),
        }, r.label)),
        h('div', { className: 'ust-sep' }),
        h('button', {
          className: 'ust-tab' + (subagents === 'own' ? ' is-on' : ''),
          onClick: () => changeQuery(subagents !== 'own', () => setSubagents(subagents === 'own' ? null : 'own')),
          title: '子代理会话单独成行（默认，跟随插件配置）',
        }, '子代理单列'),
        h('button', {
          className: 'ust-tab' + (subagents === 'root' ? ' is-on' : ''),
          onClick: () => changeQuery(subagents !== 'root', () => setSubagents(subagents === 'root' ? null : 'root')),
          title: '子代理用量归到根会话',
        }, '归到根会话'),
      );

      const chartModes = isTime
        ? [['bar', '柱状图'], ['line', '折线图'], ['cum', '累计']]
        : [['bars', '条形图'], ['donut', '环形图']];
      const chartControls = h('div', { className: 'ust-bar' },
        h('span', { className: 'ust-chart-title' }, '图表'),
        chartModes.map((mode) => {
          const active = isTime ? timeMode === mode[0] : shareMode === mode[0];
          return h('button', {
            key: mode[0],
            className: 'ust-tab' + (active ? ' is-on' : ''),
            onClick: () => (isTime ? setTimeMode(mode[0]) : setShareMode(mode[0])),
          }, mode[1]);
        }),
        h('div', { className: 'ust-sep' }),
        h('button', {
          className: 'ust-tab' + (showCache ? ' is-on' : ''),
          onClick: () => setShowCache(!showCache),
          title: '逐项命中率总表（放在数值表之后、明细表之前）；单个模型的命中率点名称弹窗查看。默认关，选择会被记住。',
        }, '命中率总表'),
        h('button', {
          className: 'ust-tab' + (showTable ? ' is-on' : ''),
          onClick: () => setShowTable(!showTable),
          title: '明细表：每行的 token 数值与缓存占比。选择会被记住。',
        }, '明细表'),
      );

      const hovered = isTime && hoverIndex !== null && rows[hoverIndex] ? rows[hoverIndex] : null;
      let cumulative = null;
      if (isTime && timeMode === 'cum' && hoverIndex !== null) {
        let acc = 0;
        for (let i = 0; i <= hoverIndex && i < rows.length; i++) acc += rows[i].total;
        cumulative = acc;
      }

      const dimName = by === 'model' ? '模型' : by === 'provider' ? '供应商' : by === 'group' ? '分组' : by === 'session' ? '会话' : by === 'day' ? '每日用量' : '每周用量';
      const chartCard = rows.length === 0 ? null : h('div', { className: 'ust-chart-card' },
        h('div', { className: 'ust-chart-head' },
          h('div', { className: 'ust-chart-title' },
            isTime
              ? dimName + '（' + rows.length + (by === 'day' ? ' 天' : ' 周') + '）'
              : dimName + ' Top ' + Math.min(rows.length, shareMode === 'donut' ? 8 : 20)),
          (isTime || shareMode === 'bars') ? h(Legend, null) : null,
        ),
        isTime
          ? h(TimeChart, { rows, mode: timeMode, hoverIndex, onHover: setHoverIndex })
          : (shareMode === 'donut' ? h(Donut, { rows, limit: 8 }) : h(HBars, { rows, limit: 20 })),
        isTime ? h(HoverLine, { row: hovered, cumulative }) : null,
      );

      // 命中率总表（逐项口径，**可选项**）：每一行各自算自己的占比，按当前维度取前 20。
      // 渲染位置由 orderedPanels 决定：数值表之后、明细表之前。
      const cacheCard = rows.length === 0
        ? null
        : h(CacheBars, {
            rows: rows.slice(), limit: 20,
            title: '命中率总表（' + dimName + ' 逐项）',
            onPick: (row) => setDetailKey(row.key),
          });

      const table = h('div', { className: 'ust-table-wrap' },
        h('table', { className: 'ust-table' },
          h('thead', null, h('tr', null,
            h('th', { className: 'l' }, by === 'day' ? '日期' : by === 'week' ? '周起始' : by === 'group' ? '分组' : '键'),
            COLS.map((c) => h('th', { key: c }, c)),
            h('th', null, '占比'),
          )),
          h('tbody', null, rows.map((row) => h('tr', { key: row.key },
            h('td', { className: 'l' },
              h('div', { className: 'ust-key' },
                // 直接调用（不是 h(KeyCell, …)）：KeyCell 无 hooks，直接调用后元素树是平的。
                // 两个无头套件（charts-harness 的文本遍历、client-race-selftest 的
                // rowLabels）都不会展开函数组件，用 h() 会把首列文本藏进组件里，
                // rowLabels 只好退回下一行（副标题）读成「p」——2026-10-09 实测踩过。
                KeyCell({ row, onPick: (picked) => setDetailKey(picked.key), hint: '查看该项的缓存命中率' })),
              by === 'session'
                ? h('div', { className: 'ust-meta' }, [
                    row.cwd || '—',
                    row.archived ? '已归档' : null,
                    row.origin === 'subagent' ? '子代理' : null,
                    row.createdAt ? fmtTime(row.createdAt) : null,
                  ].filter(Boolean).join(' · '))
                : h('div', { className: 'ust-meta' },
                    by === 'group'
                      ? (row.ungrouped === true ? '未命中任何分组' : (row.providers ? '供应商：' + row.providers.join(', ') : ''))
                      : (row.model ? row.model : (row.providers ? row.providers.join(', ') : ''))),
            ),
            h('td', null, fmt(row.calls)),
            h('td', null, fmt(row.input)),
            h('td', null, fmt(row.output)),
            h('td', null, fmt(row.cacheRead)),
            h('td', null, fmt(row.cacheWrite)),
            h('td', null, fmt(row.reasoning)),
            h('td', null, fmt(row.total)),
            h('td', null, (() => {
              const share = cacheShareOf(row);
              if (share === null) return '无缓存数据';
              const hint = coverageHint(row);
              return h('span', { title: hint === null ? '实测缓存占比' : '实测缓存占比；' + hint + ' 的计费输入带缓存字段' },
                (share * 100).toFixed(1) + '%', hint === null ? null : h('span', { className: 'ust-ccover' }, ' · ' + hint));
            })()),
            h('td', null, fmt(row.sessions)),
            h('td', null, h('span', {
              className: 'ust-share',
              style: { width: Math.max(2, Math.round(((row.share || 0) / maxShare) * 64)) + 'px' },
            })),
          ))),
        ),
      );

      const statusLine = status
        ? h('div', { className: 'ust-sub' },
            '时区 ' + status.timeZone + ' · 周起始 ' + (status.weekStart === 1 ? '周一' : '周日')
            + ' · 已折叠 ' + fmt(status.sessions.folded) + ' 会话 · 事实 ' + fmt(status.facts.total)
            + (status.backfill && status.backfill.last && status.backfill.last.finishedAt
              ? ' · 上次回填 ' + fmtTime(status.backfill.last.finishedAt)
              : '')
            + (status.gaps && status.gaps.searchRequests > 0
              ? ' · 联网搜索调用 ' + fmt(status.gaps.searchRequests) + ' 次（无用量可恢复）'
              : '')
            + (status.mirrored && status.mirrored.enabled === true && status.mirrored.excludedSessions > 0
              ? ' · 网格镜像排除 ' + fmt(status.mirrored.excludedSessions) + ' 会话'
                + '（' + fmt(status.mirrored.excludedFacts) + ' 次调用 / ' + fmt(status.mirrored.excludedTokens)
                + ' tokens，由对端设备发出）'
              : ''),
          )
        : null;

      return h('div', { className: 'ust' },
        header,
        statusLine,
        controls,
        chartControls,
        error !== null ? h('div', { className: 'ust-error' }, error) : null,
        (data !== null && typeof data.by === 'string' && data.by !== by)
          ? h('div', { className: 'ust-error' }, '统计插件返回的维度是「' + data.by + '」而不是「' + by + '」——说明运行中的 host 半边还没接入该维度（改源码后需重启 dsh，或用 stats-integration.mjs --live 重新热挂）。')
          : null,
        notice !== null ? h('div', { className: 'ust-notice' }, notice) : null,
        cards,   // 数值卡片
        loading && rows.length === 0 ? h('div', { className: 'ust-empty' }, '加载中…') : null,
        !loading && rows.length === 0 ? h('div', { className: 'ust-empty' }, '该范围内没有用量记录。') : null,
        // 数值表/图表 → 命中率总表（可选项）→ 明细表（可选项）→ 截断提示
        ...orderedPanels({
          chartCard,
          cacheCard,
          showCache,
          showTable: showTable && rows.length > 0,
          table,
          tail: data && data.truncated
            ? h('div', { className: 'ust-empty' }, '结果已截断，仅显示前 ' + rows.length + ' 行。')
            : null,
        }),
        detail === null ? null : h(CacheDetail, { row: detail, by, dimName, onClose: () => setDetailKey(null) }),
      );
    }

    const inject = ['slots'];

    function apply(ctx) {
      injectStyles();
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'usage-stats', order: 905, label: '用量统计' },
        () => h(UsageStats, null),
      ));
    }

    exports.inject = inject;
    exports.apply = apply;

    // 供 selftest.mjs 做无头结构渲染测试：这些组件不使用 hooks，可当纯函数调用，
    // 返回的元素树可直接遍历断言（本部署没有可 require 的 React，无法跑真渲染）。
    exports.__charts = {
      css: PAGE_CSS, SERIES, INPUT_SERIES, Legend, TimeChart, HBars, Donut, HoverLine,
      CacheRow, CacheBars, CacheDetail, KeyCell, inputBar, orderedPanels, rowByKey, displayName,
      cacheShareOf, cacheCoverageOf, coverageHint, pctText,
      readView, writeView, VIEW_KEY, VIEW_DEFAULTS, niceMax, shortNum,
    };
    return module.exports;
  },
});
