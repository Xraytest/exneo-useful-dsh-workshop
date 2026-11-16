/**
 * dsh-session-title-context —— 浏览器半边（v4）。
 *
 * 设置页「设置 → 标题总结」（槽位 settings.section）。
 *
 * v4 改动（用户需求：优化外观 + 改完自动保存，不再手动点保存）：
 *   · 所有设置**改动即自动保存**：本地 patch → 防抖 600ms → POST /settings（整份；
 *     host 是「整份替换」语义，绝不能只发改动字段，否则其余设置回落默认）；
 *   · 底部「保存全部设置」按钮已移除，改为标题右侧的状态胶囊
 *     （正在自动保存 / 已自动保存 · 时刻 / 自动保存失败 + 重试 / 待完善后保存）；
 *   · 串行化 + 过期响应丢弃：同时最多一笔在途请求，回包只在「本地没再改」时回写，
 *     避免旧快照把新选择弹回去；
 *   · 数字输入允许临时非法值（不会被 Number('') 拍成 1），非法期间不落盘并在字段下提示；
 *   · 「指定全局标题模型」但还没选模型时暂停自动保存（host 会 400），模型一选好立刻落盘；
 *   · 规则的**增/改**是事务动作（草稿独立于 settings，填完整才并入），
 *     启停与删除即时保存，删除后可在顶部撤销；
 *   · 离开设置页（组件卸载）与关闭/刷新页面（pagehide）都会冲刷未落盘的那一笔。
 *
 * 与 host 半边只走同源 HTTP：
 *   GET  /dsh-session-title/settings   当前生效设置
 *   POST /dsh-session-title/settings   {settings} → 校验+写盘+热应用
 *   GET  /dsh-session-title/models     provider/模型目录（下拉用）
 *
 * @module dsh-session-title-context/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-title-context',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const ROUTE_PREFIX = '/dsh-session-title';
    const NS = 'dstc';
    /** 自动保存防抖：停手 600ms 落盘（host 每次写盘都是 tmp+rename）。 */
    const AUTOSAVE_MS = 600;
    /** 「已自动保存」胶囊回落到常态的时间。 */
    const SAVED_FLASH_MS = 2600;

    /** 设计令牌（都带 fallback，宿主换主题不会掉色）。 */
    const V = {
      labelP: 'var(--dsw-alias-label-primary)',
      labelS: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary))',
      labelT: 'var(--dsw-alias-label-tertiary)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      bgBase: 'var(--dsw-alias-bg-base, #fff)',
      bg1: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-l1, #fff))',
      // 真实主题里 bg-layer-1/2 都是纯白：卡片与输入框同色会糊在一起，
      // 所以填充色统一用 label-primary 的低比例混合（深/浅主题自动反转）。
      bg2: 'color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)',
      bg3: 'color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)',
      onBrand: 'var(--dsw-alias-label-primary-inverted, #fff)',
      brand: 'var(--dsw-alias-brand-primary, #4f46e5)',
      ok: 'var(--dsw-alias-state-success-primary, #16a34a)',
      err: 'var(--dsw-alias-state-error-primary, #dc2626)',
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
    };

    const CSS = [
      '.' + NS + '-page{--dstc-h:32px;max-width:940px;padding:2px 2px 40px;display:flex;flex-direction:column;gap:14px;color:' + V.labelP + ';font-size:13px;line-height:1.6;box-sizing:border-box}',
      '.' + NS + '-page *{box-sizing:border-box}',

      /* 头部 */
      // 设置页的滚动容器是外壳的 .options：整个头部（标题/胶囊/报错/撤销）一起吸顶，
      // 滚到页面下半部分也能看见「已自动保存」与撤销动作。背景必须与面板同色才挡得住内容。
      '.' + NS + '-head{position:sticky;top:0;z-index:5;display:flex;flex-direction:column;gap:8px;padding:4px 0 10px;border-bottom:1px solid ' + V.border1 + ';background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #fff))}',
      '.' + NS + '-headTop{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}',
      '.' + NS + '-headText{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1 1 320px}',
      '.' + NS + '-h1{font-size:18px;font-weight:600;line-height:26px;letter-spacing:.2px}',
      '.' + NS + '-desc{font-size:12px;line-height:19px;color:' + V.labelT + ';max-width:640px}',

      /* 状态胶囊 */
      '.' + NS + '-pill{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 10px;border-radius:999px;border:1px solid ' + V.border1 + ';background:' + V.bg2 + ';color:' + V.labelS + ';font-size:11.5px;line-height:1;white-space:nowrap;transition:color .16s,border-color .16s,background .16s;flex:none;margin-top:2px}',
      '.' + NS + '-pill .' + NS + '-dot{width:7px;height:7px;border-radius:999px;background:currentColor;flex:none;opacity:.85}',
      '.' + NS + '-pill.' + NS + '-saving .' + NS + '-dot{animation:' + NS + '-pulse 1s ease-in-out infinite}',
      '.' + NS + '-pill.' + NS + '-saved{color:' + V.ok + ';border-color:color-mix(in srgb,' + V.ok + ' 38%,transparent);background:color-mix(in srgb,' + V.ok + ' 9%,transparent)}',
      '.' + NS + '-pill.' + NS + '-error{color:' + V.err + ';border-color:color-mix(in srgb,' + V.err + ' 42%,transparent);background:color-mix(in srgb,' + V.err + ' 9%,transparent)}',
      '.' + NS + '-pill.' + NS + '-blocked{color:' + V.warn + ';border-color:color-mix(in srgb,' + V.warn + ' 40%,transparent);background:color-mix(in srgb,' + V.warn + ' 9%,transparent)}',
      '@keyframes ' + NS + '-pulse{0%,100%{opacity:.35}50%{opacity:1}}',

      /* 撤销条 */
      '.' + NS + '-undo{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 12px;border-radius:9px;border:1px solid ' + V.border1 + ';background:' + V.bg2 + ';color:' + V.labelS + ';font-size:12px}',

      /* 卡片 */
      '.' + NS + '-card{display:flex;flex-direction:column;gap:14px;padding:16px 18px;border:1px solid ' + V.border2 + ';border-radius:12px;background:' + V.bg1 + '}',
      '.' + NS + '-cardHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.' + NS + '-cardHeadText{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 240px}',
      '.' + NS + '-cardTitleRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.' + NS + '-cardTitle{font-size:13.5px;font-weight:600;line-height:20px}',
      '.' + NS + '-cardDesc{font-size:12px;line-height:18px;color:' + V.labelT + '}',

      /* 字段 */
      '.' + NS + '-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.' + NS + '-label{font-size:12px;font-weight:500;color:' + V.labelS + '}',
      '.' + NS + '-hint{font-size:11px;line-height:16px;color:' + V.labelT + '}',
      '.' + NS + '-errHint{font-size:11px;line-height:16px;color:' + V.err + '}',
      // 设置页内容列净宽只有 ~564px，媒体查询按视口算会失效 → 用 auto-fit 自动折行。
      '.' + NS + '-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr));gap:12px}',

      /* 控件 */
      '.' + NS + '-input,.' + NS + '-select{appearance:none;-webkit-appearance:none;width:100%;height:var(--dstc-h);padding:0 10px;border:1px solid ' + V.border2 + ';border-radius:8px;background:' + V.bg2 + ';color:' + V.labelP + ';font-size:12.5px;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s,background .15s;min-width:0}',
      '.' + NS + '-select{padding-right:26px;background-image:url("data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 12 12%22><path d=%22M2.6 4.6 6 8l3.4-3.4%22 fill=%22none%22 stroke=%22%23888%22 stroke-width=%221.4%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/></svg>");background-repeat:no-repeat;background-position:right 8px center;background-size:10px}',
      '.' + NS + '-input:hover,.' + NS + '-select:hover{border-color:color-mix(in srgb,' + V.brand + ' 34%,' + V.border2 + ')}',
      '.' + NS + '-input:focus,.' + NS + '-select:focus{border-color:' + V.brand + ';box-shadow:0 0 0 3px color-mix(in srgb,' + V.brand + ' 18%,transparent)}',
      '.' + NS + '-input:-webkit-outer-spin-button,.' + NS + '-input:-webkit-inner-spin-button{-webkit-appearance:none;margin:0}',
      '.' + NS + '-input[type=number]{-moz-appearance:textfield}',
      '.' + NS + '-inputWrap{position:relative;display:flex;align-items:center}',
      '.' + NS + '-inputWrap .' + NS + '-input{padding-right:36px}',
      '.' + NS + '-unit{position:absolute;right:10px;color:' + V.labelT + ';font-size:11px;pointer-events:none}',
      '.' + NS + '-inputWrap.' + NS + '-bad .' + NS + '-input{border-color:' + V.err + '}',

      /* 分段控件 */
      '.' + NS + '-seg{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:10px;background:' + V.bg2 + ';border:1px solid ' + V.border1 + ';flex-wrap:wrap;max-width:100%;align-self:flex-start}',
      '.' + NS + '-segBtn{appearance:none;border:none;background:transparent;color:' + V.labelS + ';font-size:12.5px;font-family:inherit;line-height:1;padding:7px 12px;border-radius:7px;cursor:pointer;transition:background .15s,color .15s,box-shadow .15s;white-space:nowrap}',
      '.' + NS + '-segBtn:hover{color:' + V.labelP + '}',
      '.' + NS + '-segBtnOn{background:' + V.bgBase + ';color:' + V.labelP + ';font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.1),0 0 0 1px color-mix(in srgb,' + V.brand + ' 22%,transparent)}',
      '.' + NS + '-segBtn:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,' + V.brand + ' 22%,transparent)}',

      /* 开关 */
      '.' + NS + '-switch{display:flex;align-items:flex-start;gap:9px;cursor:pointer;user-select:none;min-width:0}',
      '.' + NS + '-switchInput{position:absolute;width:1px;height:1px;opacity:0;margin:0;pointer-events:none}',
      '.' + NS + '-switchTrack{position:relative;flex:none;width:34px;height:20px;border-radius:999px;background:' + V.border2 + ';transition:background .18s;margin-top:1px}',
      '.' + NS + '-switchKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .18s}',
      '.' + NS + '-switchInput:checked+.' + NS + '-switchTrack{background:' + V.brand + '}',
      '.' + NS + '-switchInput:checked+.' + NS + '-switchTrack .' + NS + '-switchKnob{transform:translateX(14px)}',
      '.' + NS + '-switchInput:focus-visible+.' + NS + '-switchTrack{box-shadow:0 0 0 3px color-mix(in srgb,' + V.brand + ' 22%,transparent)}',
      '.' + NS + '-switchBody{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.' + NS + '-switchLabel{font-size:12.5px;line-height:18px;color:' + V.labelP + '}',
      '.' + NS + '-switchHint{font-size:11px;line-height:16px;color:' + V.labelT + '}',

      /* 按钮 */
      '.' + NS + '-btn{appearance:none;display:inline-flex;flex:none;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid ' + V.border2 + ';border-radius:8px;background:transparent;color:' + V.labelP + ';font-size:12.5px;font-family:inherit;cursor:pointer;transition:border-color .15s,color .15s,background .15s;white-space:nowrap}',
      '.' + NS + '-btn:hover{border-color:' + V.brand + ';color:' + V.brand + '}',
      '.' + NS + '-btn:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,' + V.brand + ' 20%,transparent)}',
      '.' + NS + '-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.' + NS + '-btn:disabled:hover{border-color:' + V.border2 + ';color:' + V.labelP + '}',
      '.' + NS + '-btnPrimary{background:' + V.brand + ';border-color:' + V.brand + ';color:' + V.onBrand + '}',
      '.' + NS + '-btnPrimary:hover{color:' + V.onBrand + ';filter:brightness(1.07)}',
      '.' + NS + '-btnTiny{height:22px;padding:0 8px;font-size:11.5px;border-radius:6px}',
      '.' + NS + '-btnIcon{width:26px;height:26px;padding:0;border-color:transparent;background:transparent;color:' + V.labelT + ';border-radius:7px}',
      '.' + NS + '-btnIcon:hover{color:' + V.labelP + ';border-color:' + V.border2 + ';background:' + V.bg2 + '}',
      '.' + NS + '-btnIcon.' + NS + '-danger:hover{color:' + V.err + ';border-color:color-mix(in srgb,' + V.err + ' 40%,transparent);background:color-mix(in srgb,' + V.err + ' 9%,transparent)}',
      '.' + NS + '-btn svg{width:13px;height:13px;flex:none}',

      /* 规则 */
      '.' + NS + '-rules{display:flex;flex-direction:column;gap:8px}',
      '.' + NS + '-rule{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid ' + V.border2 + ';border-radius:10px;background:' + V.bgBase + ';transition:border-color .15s,opacity .15s}',
      '.' + NS + '-rule:hover{border-color:color-mix(in srgb,' + V.brand + ' 32%,' + V.border2 + ')}',
      '.' + NS + '-ruleOff{opacity:.6}',
      '.' + NS + '-ruleMain{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}',
      '.' + NS + '-ruleTop{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
      '.' + NS + '-ruleTop .' + NS + '-badge{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}',
      '.' + NS + '-ruleMain .' + NS + '-code{min-width:0;flex:0 1 auto}',
      '.' + NS + '-ruleName{font-size:12.5px;font-weight:600;line-height:18px;word-break:break-word}',
      // 窄面板下规则行最易溢出：子项全部可收缩换行，整行超出时横向滚动兜底而不是盖到相邻列。
      '.' + NS + '-ruleMeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px;color:' + V.labelT + ';min-width:0}',
      '.' + NS + '-ruleActions{display:flex;align-items:center;gap:4px;flex:none}',
      '.' + NS + '-badge{display:inline-flex;align-items:center;font-size:10.5px;line-height:1;padding:4px 7px;border-radius:6px;border:1px solid ' + V.border2 + ';background:' + V.bg2 + ';color:' + V.labelS + ';white-space:nowrap;flex:none}',
      // 模型名可能很长（insidegate/Qwen/Qwen3.8-Flash-Next）：允许在斜杠/连字符处断行，不裁剪。
      '.' + NS + '-badgeBrand{color:' + V.brand + ';border-color:color-mix(in srgb,' + V.brand + ' 35%,transparent);background:color-mix(in srgb,' + V.brand + ' 9%,transparent);white-space:normal;overflow-wrap:anywhere;max-width:100%;line-height:1.6}',
      '.' + NS + '-badgeMuted{color:' + V.labelT + '}',
      '.' + NS + '-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;padding:2px 6px;border-radius:5px;border:1px solid ' + V.border1 + ';background:' + V.bg2 + ';color:' + V.labelS + ';word-break:break-all;line-height:1.5;min-width:0;max-width:100%}',
      '.' + NS + '-empty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:20px 12px;border:1px dashed ' + V.border2 + ';border-radius:10px;color:' + V.labelT + ';font-size:12px;text-align:center;line-height:18px}',

      /* 表单 */
      '.' + NS + '-form{display:flex;flex-direction:column;gap:12px;padding:14px;border:1px dashed color-mix(in srgb,' + V.brand + ' 42%,transparent);border-radius:10px;background:color-mix(in srgb,' + V.brand + ' 4%,transparent)}',
      '.' + NS + '-formBar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.' + NS + '-formBarRight{display:flex;align-items:center;gap:8px;margin-left:auto}',

      /* 尾部与状态 */
      '.' + NS + '-foot{display:flex;flex-direction:column;gap:5px;padding:2px 2px 0;color:' + V.labelT + ';font-size:11.5px;line-height:18px}',
      '.' + NS + '-loading{display:flex;align-items:center;gap:9px;padding:26px 0;color:' + V.labelT + ';font-size:12.5px}',
      '.' + NS + '-spin{width:13px;height:13px;border-radius:999px;border:1.5px solid currentColor;border-top-color:transparent;animation:' + NS + '-spin .7s linear infinite;display:inline-block;flex:none}',
      '@keyframes ' + NS + '-spin{to{transform:rotate(360deg)}}',
      '.' + NS + '-fail{display:flex;flex-direction:column;gap:10px;padding:16px 18px;border:1px solid color-mix(in srgb,' + V.err + ' 38%,transparent);border-radius:12px;background:color-mix(in srgb,' + V.err + ' 7%,transparent);color:' + V.labelP + ';font-size:12.5px;line-height:19px}',
      // 标题栏「标题」按钮：与 model-pool 等头部工具按钮同一视觉语言，但更轻（无面板）。
      '.' + NS + '-titleBtn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.4;font-family:inherit;cursor:pointer;transition:border-color .12s,color .12s;max-width:100%;min-width:0}',
      '.' + NS + '-titleBtn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '.' + NS + '-titleBtn:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent)}',
      '.' + NS + '-titleBtn:disabled{cursor:default;opacity:.75}',
      '.' + NS + '-titleIcon{display:inline-flex;flex:none;color:var(--dsw-alias-state-success-primary)}',
      '.' + NS + '-titleIcon svg{width:12px;height:12px}',
      '.' + NS + '-titleSpin{width:11px;height:11px;border-radius:999px;border:1.5px solid currentColor;border-top-color:transparent;animation:' + NS + '-spin .7s linear infinite;display:inline-block;flex:none}',
      '.' + NS + '-titleLabel{white-space:nowrap}',
      '.' + NS + '-titleNote{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px;min-width:0}',
      '.' + NS + '-titleNote-ok{color:var(--dsw-alias-state-success-primary)}',
      '.' + NS + '-titleNote-err{color:var(--dsw-alias-state-error-primary)}',
    ].join('\n');

    function injectStyles() {
      if (typeof document === 'undefined') return;
      const previous = document.getElementById('dsh-session-title-style');
      if (previous !== null && previous.textContent === CSS) return;
      if (previous !== null) previous.remove();
      const tag = document.createElement('style');
      tag.id = 'dsh-session-title-style';
      tag.setAttribute('data-plugin', 'dsh-session-title-context');
      tag.textContent = CSS;
      (document.head || document.documentElement).appendChild(tag);
    }

    /* ------------------------------------------------------------------ 工具 */

    /** 拼接 className：丢掉空值。 */
    function cx() {
      const parts = Array.prototype.slice.call(arguments);
      return parts.filter((part) => typeof part === 'string' && part !== '').join(' ');
    }

    function messageOf(reason) {
      if (reason instanceof Error) return reason.message;
      return String(reason);
    }

    async function api(path, options) {
      const response = await fetch(path, Object.assign({ credentials: 'same-origin' }, options));
      const text = await response.text();
      let payload;
      try {
        payload = text === '' ? {} : JSON.parse(text);
      } catch {
        throw new Error('接口返回的不是 JSON（HTTP ' + response.status + '）');
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(typeof payload.error === 'string' && payload.error !== '' ? payload.error : ('请求失败（HTTP ' + response.status + '）'));
      }
      return payload;
    }

    const postJson = (path, body) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    /**
     * 会落盘的字段（host 白名单）。整份回传是硬约束：
     * host 的 POST 是「整份替换」语义，缺的键会回落到组合行/默认值——
     * 只发改动字段会把 rules 清空、cadence 打回 first-prompt。
     * 这里固定顺序，保证「是否真有改动」的比较稳定。
     */
    const PERSIST_KEYS = [
      'cadence', 'targetWords', 'targetCjkCharacters', 'maxInputBytes', 'maxOutputTokens',
      'timeoutMs', 'toolResultMaxBytes', 'includeSystemPrompt', 'includeInjectedContext',
      'includeToolResults', 'logRequests', 'textFallback', 'autoRefreshOnTurnEnd',
      'instructions', 'reasoningEffort', 'provider', 'model', 'globalModel', 'rules',
      'scope', 'recentTurns', 'recentMessages',
    ];

    /** 一条规则只留 host 认识的字段。 */
    function ruleOf(rule) {
      const source = rule !== null && typeof rule === 'object' ? rule : {};
      return {
        id: source.id,
        name: source.name,
        matchType: source.matchType,
        matchValue: source.matchValue,
        provider: source.provider,
        model: source.model,
        enabled: source.enabled !== false,
      };
    }

    /** 提交用的整份设置（有序、去 undefined）。 */
    function toPayload(settings) {
      const out = {};
      for (const key of PERSIST_KEYS) {
        const value = settings[key];
        if (value === undefined) continue;
        if (key === 'rules') {
          out.rules = Array.isArray(value) ? value.map(ruleOf) : [];
          continue;
        }
        if (key === 'globalModel') {
          const global = value !== null && typeof value === 'object' ? value : {};
          out.globalModel = {
            mode: global.mode === 'custom' ? 'custom' : 'inherit',
            provider: typeof global.provider === 'string' ? global.provider : '',
            model: typeof global.model === 'string' ? global.model : '',
          };
          continue;
        }
        out[key] = value;
      }
      return out;
    }

    const payloadOf = (settings) => (settings === null ? '' : JSON.stringify(toPayload(settings)));

    /** 严格整数解析：空串/小数/负号/非数字一律 null（不学 Number('') = 0）。 */
    function intOf(text) {
      const raw = typeof text === 'string' ? text.trim() : String(text);
      if (!/^\d+$/.test(raw)) return null;
      const value = Number(raw);
      return Number.isSafeInteger(value) ? value : null;
    }

    /** 数值是否落在允许区间（自动保存前的本地闸门）。 */
    function inRange(value, min, max) {
      return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
    }

    /** 模型目录 → 按 provider 分组的下拉。 */
    function modelGroups(providers) {
      const groups = [];
      for (const provider of providers || []) {
        if (provider === null || typeof provider !== 'object') continue;
        const models = Array.isArray(provider.models) ? provider.models : [];
        if (models.length === 0) continue;
        groups.push({
          id: String(provider.id),
          label: String(provider.name || provider.id),
          models: models.map((model) => ({
            value: String(provider.id) + ':::' + String(model.id),
            label: String(model.name || model.id),
          })),
        });
      }
      return groups;
    }

    /** 活跃会话（从客户端会话存储里读，仅用于规则里快速选取 sessionId）。 */
    function liveSessions(pluginCtx) {
      try {
        const store = pluginCtx.sessions;
        const list = store && store.list;
        const snap = typeof list === 'function' ? list() : list && list.getSnapshot && list.getSnapshot();
        const byId = snap && snap.byId ? snap.byId : {};
        const out = [];
        for (const key of Object.keys(byId)) {
          const entry = byId[key];
          if (entry === null || typeof entry !== 'object') continue;
          out.push({
            id: typeof entry.id === 'string' ? entry.id : key,
            title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : key,
          });
        }
        out.sort((a, b) => (a.title < b.title ? -1 : 1));
        return out.slice(0, 200);
      } catch {
        return [];
      }
    }

    const EMPTY_RULE = { id: '', name: '', matchType: 'sessionId', matchValue: '', provider: '', model: '' };

    /** 规则草稿的完整性检查：不完整就不许并入 settings（host 会静默丢弃半成品）。 */
    function ruleProblem(draft) {
      if (typeof draft.matchValue !== 'string' || draft.matchValue.trim() === '') return '请填写匹配值';
      if (draft.provider === '' || draft.model === '') return '请选择这条规则使用的标题模型';
      if (draft.matchType === 'regex') {
        try {
          new RegExp(draft.matchValue.trim());
        } catch {
          return '正则表达式不合法';
        }
      }
      return '';
    }

    const MATCH_LABEL = { sessionId: '会话 ID', contains: '标题包含', prefix: '标题前缀', regex: '正则' };

    /* ------------------------------------------------------------------ 图标 */

    const ICONS = {
      plus: ['M8 3.2v9.6', 'M3.2 8h9.6'],
      trash: ['M3 4.6h10', 'M6.4 4.6V3.2h3.2v1.4', 'M4.6 4.6l.55 8h5.7l.55-8'],
      pencil: ['M11.2 2.9l1.9 1.9-7.1 7.1-2.5.6.6-2.5 7.1-7.1z'],
      undo: ['M3.6 7.4h6.1a3.1 3.1 0 0 1 0 6.2H6.4', 'M6.1 4.6L3.2 7.4l2.9 2.9'],
      check: ['M3.4 8.4l3 3 6.2-6.6'],
    };

    function Icon(props) {
      const paths = ICONS[props.name] || [];
      return h('svg', {
        viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
      }, paths.map((d, index) => h('path', { key: String(index), d })));
    }    /* ------------------------------------------------------------------ 控件 */

    /**
     * 下面几个都是**无 hook 的纯展示函数**（直接用函数调用拼子树，不交给 React 当组件），
     * 这样设置页只有一处 hook 序列，自测桩能按位置稳定驱动。
     */

    /** 分段选择（替代原生 radio：更紧凑、命中区域更大，仍带 radiogroup 语义）。 */
    function Segmented(props) {
      const options = props.options || [];
      return h('div', { className: NS + '-seg', role: 'radiogroup', 'aria-label': props.label || '' },
        options.map((option) => h('button', {
          key: option.value,
          type: 'button',
          role: 'radio',
          'aria-checked': props.value === option.value,
          'data-value': option.value,
          className: cx(NS + '-segBtn', props.value === option.value ? NS + '-segBtnOn' : ''),
          onClick: () => props.onChange(option.value),
          title: option.title || '',
        }, option.label)));
    }

    /** 开关（原生 checkbox 视觉隐藏，轨道由 :checked 驱动；保留键盘可达）。 */
    function Switch(props) {
      const body = props.label === undefined ? null : h('span', { className: NS + '-switchBody' },
        h('span', { className: NS + '-switchLabel' }, props.label),
        props.hint ? h('span', { className: NS + '-switchHint' }, props.hint) : null);
      return h('label', { className: NS + '-switch', title: props.title || '' },
        h('input', {
          type: 'checkbox',
          className: NS + '-switchInput',
          checked: props.checked === true,
          'data-field': props.field || '',
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('span', { className: NS + '-switchTrack' }, h('span', { className: NS + '-switchKnob' })),
        body);
    }

    /** 模型下拉：按 provider 分组；当前值不在目录里时补一个「（当前）」选项，避免空白。 */
    function ModelSelect(props) {
      const groups = props.groups || [];
      const value = props.value === undefined || props.value === null ? '' : props.value;
      let known = false;
      const children = [h('option', { key: '__none', value: '' }, props.placeholder || '── 选择模型 ──')];
      for (const group of groups) {
        children.push(h('optgroup', { key: group.id, label: group.label },
          group.models.map((model) => {
            if (model.value === value) known = true;
            return h('option', { key: model.value, value: model.value }, model.label);
          })));
      }
      if (value !== '' && known !== true) {
        children.push(h('option', { key: '__current', value }, value.split(':::').join(' / ') + '（当前）'));
      }
      return h('select', {
        className: NS + '-select',
        value,
        disabled: props.disabled === true,
        'data-field': props.field || '',
        onChange: (event) => props.onChange(event.target.value),
      }, children);
    }

    /** 数字输入：编辑态保留原文（非法值只提示、不落盘），失焦回落到已保存的整数。 */
    function NumberField(props) {
      const fallback = props.value === undefined || props.value === null ? '' : String(props.value);
      const shown = props.raw === undefined ? fallback : props.raw;
      const bad = props.raw !== undefined && inRange(intOf(props.raw), props.min, props.max) !== true;
      return h('div', { className: NS + '-field' },
        h('span', { className: NS + '-label' }, props.label),
        h('div', { className: cx(NS + '-inputWrap', bad ? NS + '-bad' : '') },
          h('input', {
            type: 'number',
            inputMode: 'numeric',
            className: NS + '-input',
            min: props.min,
            max: props.max,
            step: 1,
            value: shown,
            'data-field': props.field,
            onChange: (event) => props.onText(event.target.value),
            onBlur: () => props.onBlur(),
          }),
          props.unit ? h('span', { className: NS + '-unit' }, props.unit) : null),
        bad
          ? h('span', { className: NS + '-errHint' }, '需为 ' + props.min + '–' + props.max + ' 的整数；这一个值暂时不会保存')
          : (props.hint ? h('span', { className: NS + '-hint' }, props.hint) : null));
    }

    /* ------------------------------------------------------------------ 设置页 */

    let pluginCtx;

    function TitleSettingsPage(props) {
      const ctx = (props && props.ctx) || pluginCtx;

      // hook 次序（client-selftest.mjs 按位置驱动，改动时同步更新）：
      //  0 settings  1 providers  2 loading  3 save  4 showForm  5 draft  6 formError  7 editing  8 undo
      const [settings, setSettings] = React.useState(null);
      const [providers, setProviders] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [save, setSave] = React.useState({ kind: 'idle', message: '', at: '' });
      const [showForm, setShowForm] = React.useState(false);
      const [draft, setDraft] = React.useState(EMPTY_RULE);
      const [formError, setFormError] = React.useState('');
      const [editing, setEditing] = React.useState({});
      const [undo, setUndo] = React.useState(null);

      const loadedRef = React.useRef(false);      // 基线是否已记下（首次加载只记基线、不回写）
      const lastSavedRef = React.useRef('');      // 已落盘的 payload（比较用）
      const timerRef = React.useRef(null);        // 防抖计时器
      const pendingRef = React.useRef(null);      // 防抖窗口内那一笔（卸载/关页面时冲刷）
      const queueRef = React.useRef(null);        // 串行队列：在途期间的新改动排在这里
      const sendingRef = React.useRef(false);     // 是否有一笔在途
      const startedRef = React.useRef(false);     // 首屏只拉一次（StrictMode 会双调用 effect）

      const reload = React.useCallback(() => {
        setLoading(true);
        return Promise.all([
          api(ROUTE_PREFIX + '/settings'),
          api(ROUTE_PREFIX + '/models').catch(() => ({ providers: [] })),
        ]).then((values) => {
          setSettings(values[0].settings);
          setProviders(Array.isArray(values[1].providers) ? values[1].providers : []);
        }).catch((reason) => {
          setSave({ kind: 'error', message: '读取设置失败：' + messageOf(reason), at: '' });
        }).then(() => setLoading(false));
      }, []);

      React.useEffect(() => {
        if (startedRef.current === true) return undefined;
        startedRef.current = true;
        reload();
        return undefined;
      }, [reload]);

      /**
       * 发出队列里那一笔（串行：同一时刻只有一个在途请求，避免两次写盘乱序）。
       * 回包只用于两件事：记账（lastSavedRef）与提示；本地若在途期间又改过，绝不回写。
       */
      const pump = React.useCallback(() => {
        if (sendingRef.current === true) return;
        const job = queueRef.current;
        if (job === null) return;
        queueRef.current = null;
        sendingRef.current = true;
        setSave({ kind: 'saving', message: '', at: '' });
        const finish = () => {
          sendingRef.current = false;
          if (queueRef.current !== null) pump();
        };
        postJson(ROUTE_PREFIX + '/settings', job.body).then((response) => {
          const returned = response !== null && typeof response === 'object'
            && response.settings !== null && typeof response.settings === 'object'
            ? response.settings : job.settings;
          lastSavedRef.current = payloadOf(returned);
          setSave({ kind: 'saved', message: '', at: new Date().toTimeString().slice(0, 8) });
          setSettings((prev) => (prev !== null && payloadOf(prev) === job.payload ? returned : prev));
        }).catch((reason) => {
          setSave({ kind: 'error', message: messageOf(reason), at: '' });
        }).then(finish, finish);
      }, []);

      /** 立刻发（重试按钮 / 卸载补发用）。 */
      const sendNow = (snapshot) => {
        queueRef.current = { settings: snapshot, payload: payloadOf(snapshot), body: { settings: toPayload(snapshot) } };
        pump();
      };

      // 页面隐藏（刷新/关标签页）→ beacon 冲刷；组件卸载（关设置页/切分节）→ 立刻补发。
      React.useEffect(() => {
        const flush = () => {
          const pending = pendingRef.current;
          if (pending === null) return;
          if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
            try {
              const queued = navigator.sendBeacon(
                ROUTE_PREFIX + '/settings',
                new Blob([JSON.stringify(pending.body)], { type: 'application/json' }),
              );
              if (queued !== false) pendingRef.current = null;
            } catch { /* 冲刷失败：下一次改动会重新排队 */ }
            return;
          }
          try { pending.send(); } catch { /* 同上 */ }
        };
        const canListen = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
        if (canListen) window.addEventListener('pagehide', flush);
        return () => {
          if (canListen && typeof window.removeEventListener === 'function') window.removeEventListener('pagehide', flush);
          if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
          const pending = pendingRef.current;
          pendingRef.current = null;
          if (pending !== null) { try { pending.send(); } catch { /* 忽略 */ } }
        };
      }, []);

      /** 全局标题模型选了「指定」但还没选模型：host 会 400，先不提交。 */
      const globalModel = settings === null
        ? null
        : (settings.globalModel !== null && typeof settings.globalModel === 'object'
          ? settings.globalModel
          : { mode: 'inherit', provider: '', model: '' });
      const blocked = globalModel !== null && globalModel.mode === 'custom'
        && (globalModel.provider === '' || globalModel.model === '');

      /**
       * 自动保存：本地 settings 一变就比「已落盘 payload」，不同则防抖 600ms 落盘。
       * 三条纪律：① 首次加载只记基线，不回写；② 本地闸门不过（globalModel 半成品）不提交；
       * ③ 回到基线就撤销 pending（不重复 POST）。
       */
      React.useEffect(() => {
        if (settings === null) return undefined;
        const payload = payloadOf(settings);
        if (loadedRef.current !== true) {
          loadedRef.current = true;
          lastSavedRef.current = payload;
          return undefined;
        }
        if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (blocked === true) {
          pendingRef.current = null;
          setSave({ kind: 'blocked', message: '选择具体模型后立即自动保存', at: '' });
          return undefined;
        }
        if (payload === lastSavedRef.current) {
          pendingRef.current = null;
          setSave((prev) => (prev.kind === 'blocked' ? { kind: 'idle', message: '', at: prev.at } : prev));
          return undefined;
        }
        const body = { settings: toPayload(settings) };
        const send = () => {
          queueRef.current = { settings: settings, payload: payload, body: body };
          pump();
        };
        pendingRef.current = { payload: payload, body: body, send: send };
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          pendingRef.current = null;
          send();
        }, AUTOSAVE_MS);
        return () => {
          if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
        };
      }, [settings, blocked, pump]);

      // 「已自动保存」闪一下后回落到常态（保留时刻，方便核对）。
      React.useEffect(() => {
        if (save.kind !== 'saved') return undefined;
        const timer = setTimeout(() => {
          setSave((prev) => (prev.kind === 'saved' ? { kind: 'idle', message: '', at: prev.at } : prev));
        }, SAVED_FLASH_MS);
        return () => clearTimeout(timer);
      }, [save.kind]);

      const patch = (partial) => setSettings((prev) => (prev === null ? prev : Object.assign({}, prev, partial)));
      const modelOptions = React.useMemo(() => modelGroups(providers), [providers]);
      const retry = () => { if (settings !== null) sendNow(settings); };

      /** 数字字段工厂：编辑态原文不动 settings，只有合法整数才 patch（patch 即触发自动保存）。 */
      const numeric = (key, config) => NumberField({
        field: key,
        label: config.label,
        unit: config.unit || '',
        hint: config.hint || '',
        min: config.min,
        max: config.max,
        value: settings[key] === undefined ? config.fallback : settings[key],
        raw: editing[key],
        onText: (text) => {
          setEditing((prev) => Object.assign({}, prev, { [key]: text }));
          const next = intOf(text);
          if (next !== null && inRange(next, config.min, config.max) && settings[key] !== next) {
            patch({ [key]: next });
          }
        },
        onBlur: () => setEditing((prev) => {
          const copy = Object.assign({}, prev);
          delete copy[key];
          return copy;
        }),
      });

      if (loading && settings === null) {
        return h('div', { className: NS + '-page' },
          h('div', { className: NS + '-loading' },
            h('span', { className: NS + '-spin' }),
            '正在读取标题总结设置…'));
      }
      if (settings === null) {
        return h('div', { className: NS + '-page' },
          h('div', { className: NS + '-fail' },
            h('div', null, save.message !== '' ? save.message : '标题总结设置读取失败'),
            h('div', { className: NS + '-hint' },
              '读不到设置时这一页不会写盘，磁盘上的 session-title.json 保持原样。'),
            h('div', { className: NS + '-formBar' },
              h('div', { className: NS + '-formBarRight' },
                h('button', { type: 'button', className: NS + '-btn', onClick: () => reload() }, '重试')))));
      }

      const rules = Array.isArray(settings.rules) ? settings.rules : [];
      const scope = settings.scope === 'recentTurns' || settings.scope === 'recentMessages' ? settings.scope : 'full';
      const sessions = liveSessions(ctx);

      const pillText = save.kind === 'saving' ? '正在自动保存…'
        : save.kind === 'saved' ? ('已自动保存' + (save.at !== '' ? ' · ' + save.at : ''))
        : save.kind === 'error' ? '自动保存失败'
        : save.kind === 'blocked' ? '待完善后自动保存'
        : (save.at !== '' ? '改动自动保存 · 上次 ' + save.at : '改动会自动保存');

      /* ---------------------------------------------------------- 头部 */
      const head = h('div', { className: NS + '-head' },
        h('div', { className: NS + '-headTop' },
          h('div', { className: NS + '-headText' },
            h('div', { className: NS + '-h1' }, '标题总结'),
            h('div', { className: NS + '-desc' },
              '模型、匹配规则与上下文量都在这里设置。改动即自动保存（停手约 0.6 秒），没有「保存」按钮。')),
          h('div', {
            className: cx(NS + '-pill', NS + '-' + save.kind),
            title: save.message !== '' ? save.message : pillText,
            'aria-live': 'polite',
          },
            h('span', { className: NS + '-dot' }),
            h('span', null, pillText),
            save.kind === 'error'
              ? h('button', { type: 'button', className: cx(NS + '-btn', NS + '-btnTiny'), onClick: retry }, '重试')
              : null)),
        save.kind === 'error' && save.message !== ''
          ? h('div', { className: NS + '-errHint' }, save.message)
          : null,
        undo !== null
          ? h('div', { className: NS + '-undo' },
            h('span', null, '已删除规则「' + undo.name + '」'),
            h('button', {
              type: 'button', className: cx(NS + '-btn', NS + '-btnTiny'),
              onClick: () => { patch({ rules: undo.rules }); setUndo(null); },
            }, Icon({ name: 'undo' }), '撤销'),
            h('button', {
              type: 'button', className: cx(NS + '-btn', NS + '-btnTiny'),
              onClick: () => setUndo(null),
            }, '知道了'))
          : null);

      /* ---------------------------------------------------------- 标题模型 */
      const modelCard = h('div', { className: NS + '-card' },
        h('div', { className: NS + '-cardHead' },
          h('div', { className: NS + '-cardHeadText' },
            h('div', { className: NS + '-cardTitle' }, '标题模型'),
            h('div', { className: NS + '-cardDesc' },
              '解析优先级：/title 一次性指定 ＞ 会话规则 ＞ 全局标题模型 ＞ 当前会话模型。'))),
        Segmented({
          label: '标题模型来源',
          value: globalModel.mode === 'custom' ? 'custom' : 'inherit',
          options: [
            { value: 'inherit', label: '跟随当前会话模型' },
            { value: 'custom', label: '指定全局标题模型' },
          ],
          onChange: (value) => {
            if (value === 'custom') {
              patch({ globalModel: { mode: 'custom', provider: globalModel.provider || '', model: globalModel.model || '' } });
              return;
            }
            patch({ globalModel: { mode: 'inherit', provider: '', model: '' } });
          },
        }),
        globalModel.mode === 'custom'
          ? h('div', { className: NS + '-field' },
            h('span', { className: NS + '-label' }, '全局标题模型'),
            ModelSelect({
              field: 'globalModel',
              value: globalModel.provider !== '' && globalModel.model !== ''
                ? globalModel.provider + ':::' + globalModel.model
                : '',
              groups: modelOptions,
              placeholder: '── 选择模型 ──',
              onChange: (value) => {
                if (value === '') {
                  patch({ globalModel: { mode: 'custom', provider: '', model: '' } });
                  return;
                }
                const parts = value.split(':::');
                patch({ globalModel: { mode: 'custom', provider: parts[0], model: parts[1] } });
              },
            }),
            blocked
              ? h('span', { className: NS + '-errHint' },
                '选好模型后立即自动保存（空模型会被服务端拒绝，所以先不提交）。')
              : h('span', { className: NS + '-hint' },
                modelOptions.length === 0
                  ? '模型目录暂时读不到（provider 可能还没就绪）；清空则回落到会话模型。'
                  : '所有未命中下方规则的会话都用它生成标题。'))
          : null);

      /* ---------------------------------------------------------- 会话规则 */
      const startAdd = () => {
        setDraft(Object.assign({}, EMPTY_RULE));
        setFormError('');
        setShowForm(true);
      };
      const startEdit = (rule) => {
        setDraft({
          id: rule.id || '',
          name: rule.name || '',
          matchType: rule.matchType || 'sessionId',
          matchValue: rule.matchValue || '',
          provider: rule.provider || '',
          model: rule.model || '',
        });
        setFormError('');
        setShowForm(true);
      };
      const commitRule = () => {
        const problem = ruleProblem(draft);
        if (problem !== '') { setFormError(problem); return; }
        const isEdit = draft.id !== '';
        const existing = isEdit ? rules.filter((item) => item.id === draft.id)[0] : undefined;
        const record = {
          id: isEdit ? draft.id : 'rule-' + String(Date.now()),
          name: draft.name.trim() !== '' ? draft.name.trim() : ('规则 ' + String(rules.length + 1)),
          matchType: draft.matchType,
          matchValue: draft.matchValue.trim(),
          provider: draft.provider,
          model: draft.model,
          enabled: existing === undefined ? true : existing.enabled !== false,
        };
        // 规则是事务动作：草稿完整才并入 settings，随后由自动保存落盘。
        patch({
          rules: isEdit
            ? rules.map((item) => (item.id === draft.id ? record : item))
            : rules.concat([record]),
        });
        setShowForm(false);
        setDraft(Object.assign({}, EMPTY_RULE));
        setFormError('');
      };

      const ruleRow = (rule, index) => h('div', {
        key: rule.id || String(index),
        className: cx(NS + '-rule', rule.enabled === false ? NS + '-ruleOff' : ''),
      },
        h('div', { className: NS + '-ruleMain' },
          h('div', { className: NS + '-ruleTop' },
            h('span', { className: NS + '-ruleName' }, rule.name || ('规则 ' + String(index + 1))),
            h('span', { className: NS + '-badge' }, MATCH_LABEL[rule.matchType] || '会话 ID'),
            rule.enabled === false ? h('span', { className: cx(NS + '-badge', NS + '-badgeMuted') }, '已停用') : null),
          h('div', { className: NS + '-ruleMeta' },
            h('span', null, '匹配'),
            h('code', { className: NS + '-code' }, rule.matchValue || ''),
            h('span', null, '→'),
            h('span', { className: cx(NS + '-badge', NS + '-badgeBrand') },
              (rule.provider || '?') + '/' + (rule.model || '?')))),
        h('div', { className: NS + '-ruleActions' },
          Switch({
            field: 'rule-enabled-' + String(index),
            checked: rule.enabled !== false,
            title: rule.enabled === false ? '点击启用这条规则' : '点击停用这条规则',
            onChange: (checked) => patch({
              rules: rules.map((item, at) => (at === index ? Object.assign({}, item, { enabled: checked }) : item)),
            }),
          }),
          h('button', {
            type: 'button',
            className: cx(NS + '-btn', NS + '-btnIcon'),
            title: '编辑这条规则',
            'aria-label': '编辑规则',
            onClick: () => startEdit(rule),
          }, Icon({ name: 'pencil' })),
          h('button', {
            type: 'button',
            className: cx(NS + '-btn', NS + '-btnIcon', NS + '-danger'),
            title: '删除这条规则',
            'aria-label': '删除规则',
            onClick: () => {
              patch({ rules: rules.filter((item, at) => at !== index) });
              setUndo({ rules: rules, name: rule.name || ('规则 ' + String(index + 1)) });
            },
          }, Icon({ name: 'trash' }))));

      const ruleCard = h('div', { className: NS + '-card' },
        h('div', { className: NS + '-cardHead' },
          h('div', { className: NS + '-cardHeadText' },
            h('div', { className: NS + '-cardTitleRow' },
              h('span', { className: NS + '-cardTitle' }, '会话专用模型规则'),
              h('span', { className: cx(NS + '-badge', NS + '-badgeBrand') }, String(rules.length) + ' 条')),
            h('div', { className: NS + '-cardDesc' },
              '按会话 ID / 标题包含 / 前缀 / 正则匹配，自上而下取第一条命中；启停与删除即时保存。')),
          showForm
            ? h('button', {
              type: 'button', className: NS + '-btn',
              onClick: () => { setShowForm(false); setFormError(''); },
            }, '取消')
            : h('button', {
              type: 'button', className: cx(NS + '-btn', NS + '-btnPrimary'),
              onClick: startAdd,
            }, Icon({ name: 'plus' }), '添加规则')),

        rules.length === 0 && !showForm
          ? h('div', { className: NS + '-empty' },
            h('span', null, '还没有会话专用规则'),
            h('span', null, '所有会话都会用上面的全局标题模型；要单独指定时点右上角「添加规则」。'))
          : h('div', { className: NS + '-rules' }, rules.map(ruleRow)),

        showForm
          ? h('div', { className: NS + '-form' },
            h('div', { className: NS + '-grid' },
              h('div', { className: NS + '-field' },
                h('span', { className: NS + '-label' }, '规则名称'),
                h('input', {
                  className: NS + '-input',
                  'data-field': 'rule-name',
                  placeholder: '例如：数学课程会话',
                  value: draft.name,
                  onChange: (event) => setDraft(Object.assign({}, draft, { name: event.target.value })),
                })),
              h('div', { className: NS + '-field' },
                h('span', { className: NS + '-label' }, '匹配方式'),
                h('select', {
                  className: NS + '-select',
                  'data-field': 'rule-matchType',
                  value: draft.matchType,
                  onChange: (event) => setDraft(Object.assign({}, draft, { matchType: event.target.value })),
                },
                h('option', { value: 'sessionId' }, '精确匹配会话 ID'),
                h('option', { value: 'contains' }, '会话标题包含…'),
                h('option', { value: 'prefix' }, '会话标题以…开头'),
                h('option', { value: 'regex' }, '正则匹配（ID 或标题）')))),
            h('div', { className: NS + '-field' },
              h('span', { className: NS + '-label' }, '匹配值'),
              h('div', { className: NS + '-grid' },
                h('input', {
                  className: NS + '-input',
                  'data-field': 'rule-matchValue',
                  placeholder: draft.matchType === 'sessionId' ? '会话 ID' : '文本或正则',
                  value: draft.matchValue,
                  onChange: (event) => setDraft(Object.assign({}, draft, { matchValue: event.target.value })),
                }),
                draft.matchType === 'sessionId' && sessions.length > 0
                  ? h('select', {
                    className: NS + '-select',
                    'data-field': 'rule-pick',
                    value: '',
                    onChange: (event) => {
                      if (event.target.value !== '') {
                        setDraft(Object.assign({}, draft, { matchValue: event.target.value }));
                      }
                    },
                  },
                  h('option', { value: '' }, '从活跃会话选取…'),
                  sessions.map((session) => h('option', {
                    key: session.id, value: session.id,
                  }, session.title + '（' + session.id + '）')))
                  : h('div', { className: NS + '-hint' }, '匹配值区分大小写；正则不要带 /…/ 包裹。'))),
            h('div', { className: NS + '-field' },
              h('span', { className: NS + '-label' }, '这条规则使用的标题模型'),
              ModelSelect({
                field: 'rule-model',
                value: draft.provider !== '' && draft.model !== ''
                  ? draft.provider + ':::' + draft.model
                  : '',
                groups: modelOptions,
                onChange: (value) => {
                  if (value === '') {
                    setDraft(Object.assign({}, draft, { provider: '', model: '' }));
                    return;
                  }
                  const parts = value.split(':::');
                  setDraft(Object.assign({}, draft, { provider: parts[0], model: parts[1] }));
                },
              })),
            h('div', { className: NS + '-formBar' },
              formError !== ''
                ? h('span', { className: NS + '-errHint' }, formError)
                : h('span', { className: NS + '-hint' }, '填完整后点右侧按钮：规则并入设置并立即自动保存。'),
              h('div', { className: NS + '-formBarRight' },
                h('button', {
                  type: 'button', className: NS + '-btn',
                  onClick: () => { setShowForm(false); setFormError(''); },
                }, '取消'),
                h('button', {
                  type: 'button', className: cx(NS + '-btn', NS + '-btnPrimary'),
                  onClick: commitRule,
                }, Icon({ name: 'check' }), draft.id !== '' ? '应用修改' : '添加规则'))))
          : null);

      /* ---------------------------------------------------------- 上下文量 */
      const KB_CHOICES = [32768, 65536, 131072, 262144, 524288];
      const currentInput = Number(settings.maxInputBytes);
      const kbOptions = Number.isFinite(currentInput) && KB_CHOICES.indexOf(currentInput) < 0
        ? KB_CHOICES.concat([currentInput]).sort((a, b) => a - b)
        : KB_CHOICES;

      const contextCard = h('div', { className: NS + '-card' },
        h('div', { className: NS + '-cardHead' },
          h('div', { className: NS + '-cardHeadText' },
            h('div', { className: NS + '-cardTitle' }, '喂给标题模型的上下文'),
            h('div', { className: NS + '-cardDesc' },
              '不论选哪种口径，首条提问（任务起点）与最新一轮回答都会保留。'))),
        h('div', { className: NS + '-field' },
          h('span', { className: NS + '-label' }, '上下文范围'),
          Segmented({
            label: '上下文范围',
            value: scope,
            options: [
              { value: 'full', label: '全部可见上下文' },
              { value: 'recentTurns', label: '最近 N 轮' },
              { value: 'recentMessages', label: '最近 N 条' },
            ],
            onChange: (value) => patch({ scope: value }),
          }),
          h('span', { className: NS + '-hint' },
            '「全部」含压实摘要，信息最全；「最近」更省 token。')),
        scope === 'recentTurns' || scope === 'recentMessages'
          ? h('div', { className: NS + '-grid' },
            scope === 'recentTurns'
              ? numeric('recentTurns', { label: '最近轮数', min: 1, max: 50, fallback: 3 })
              : null,
            scope === 'recentMessages'
              ? numeric('recentMessages', { label: '最近条数', min: 2, max: 100, fallback: 6 })
              : null)
          : null,
        h('div', { className: NS + '-grid' },
          h('div', { className: NS + '-field' },
            h('span', { className: NS + '-label' }, '单次输入上限'),
            h('select', {
              className: NS + '-select',
              'data-field': 'maxInputBytes',
              value: String(settings.maxInputBytes === undefined ? 65536 : settings.maxInputBytes),
              onChange: (event) => patch({ maxInputBytes: Number(event.target.value) }),
            }, kbOptions.map((bytes) => h('option', {
              key: String(bytes), value: String(bytes),
            }, String(Math.round(bytes / 1024)) + ' KB'))),
            h('span', { className: NS + '-hint' }, '超出预算的旧消息会被丢弃。')),
          numeric('toolResultMaxBytes', {
            label: '单条工具结果截断', min: 200, max: 8000, fallback: 1200, unit: '字节',
          })),
        Switch({
          field: 'includeToolResults',
          checked: settings.includeToolResults !== false,
          label: '上下文里包含工具调用与结果',
          hint: '关掉只留纯文本问答：标题更简洁，但会丢掉文件与命令线索。',
          onChange: (checked) => patch({ includeToolResults: checked }),
        }));

      /* ---------------------------------------------------------- 节奏与长度 */
      const cadenceCard = h('div', { className: NS + '-card' },
        h('div', { className: NS + '-cardHead' },
          h('div', { className: NS + '-cardHeadText' },
            h('div', { className: NS + '-cardTitle' }, '生成节奏与标题长度'),
            h('div', { className: NS + '-cardDesc' },
              '节奏决定标题什么时候重算；长度是给模型的软约束。'))),
        h('div', { className: NS + '-grid' },
          h('div', { className: NS + '-field' },
            h('span', { className: NS + '-label' }, '重新生成节奏'),
            Segmented({
              label: '重新生成节奏',
              value: settings.cadence === 'first-prompt' ? 'first-prompt' : 'all-prompts',
              options: [
                { value: 'all-prompts', label: '每条新消息都重算' },
                { value: 'first-prompt', label: '只在首条消息生成' },
              ],
              onChange: (value) => patch({ cadence: value }),
            })),
          h('div', { className: NS + '-field', style: { justifyContent: 'flex-end' } },
            h('span', { className: NS + '-label' }, '回合结束'),
            Switch({
              field: 'autoRefreshOnTurnEnd',
              checked: settings.autoRefreshOnTurnEnd !== false,
              label: '回合结束后带上最新回答重算',
              hint: '关掉则只在收到新消息时重算（标题可能落后一回合）。',
              onChange: (checked) => patch({ autoRefreshOnTurnEnd: checked }),
            }))),
        h('div', { className: NS + '-grid' },
          numeric('targetCjkCharacters', {
            label: '中文目标字数', min: 4, max: 30, fallback: 12, unit: '字',
          }),
          numeric('targetWords', {
            label: '非中文目标词数', min: 2, max: 20, fallback: 6, unit: '词',
          })));

      /* ---------------------------------------------------------- 尾部 */
      const foot = h('div', { className: NS + '-foot' },
        h('div', null,
          '设置文件：',
          h('code', { className: NS + '-code' }, '<DSH_HOME>/session-title.json'),
          '（自动写回，临时文件 + rename，不会写坏）。'),
        h('div', null,
          '手动重算：输入框里 ',
          h('code', { className: NS + '-code' }, '/title'),
          '；一次性指定模型用 ',
          h('code', { className: NS + '-code' }, '/title <provider>/<model>'),
          '，可用模型看 ',
          h('code', { className: NS + '-code' }, '/title list'),
          '。'));

      return h('div', { className: NS + '-page' }, head, modelCard, ruleCard, contextCard, cadenceCard, foot);
    }

    /* ------------------------------------------------------------------ 标题栏按钮 */
    // 会话头部工具区的「重算标题」按钮：点击 → POST /generate（当前会话模型），
    // 完成后行内提示新标题（成功）或失败原因，2.6s 淡出。没有弹出面板、没有设置入口——
    // 设置只在设置页「标题总结」一节。sessionId 由槽位属主注入（与 model-pool 同构）。
    function TitleBarButton(props) {
      const sessionId = props.sessionId;
      const [state, setState] = React.useState({ busy: false, note: '', kind: '' });
      const timerRef = React.useRef(0);
      React.useEffect(() => function () {
        if (timerRef.current !== 0) clearTimeout(timerRef.current);
      }, []);
      const flash = (note, kind) => {
        setState({ busy: false, note: note, kind: kind });
        if (timerRef.current !== 0) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setState({ busy: false, note: '', kind: '' }), 2600);
      };
      const regenerate = async () => {
        if (state.busy || typeof sessionId !== 'string' || sessionId === '') return;
        setState({ busy: true, note: '', kind: '' });
        try {
          const res = await api('/dsh-session-title/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId }),
          });
          flash('已生成：' + String(res.title ?? ''), 'ok');
        } catch (error) {
          flash(String((error && error.message) || error), 'err');
        }
      };
      return h('button', {
        type: 'button',
        className: NS + '-titleBtn',
        title: state.note !== '' ? state.note : '重新生成当前会话标题（用当前会话模型）；标题设置在「设置 → 标题总结」',
        disabled: state.busy,
        onClick: regenerate,
      },
        state.busy
          ? h('span', { className: NS + '-titleSpin' })
          : h('span', { className: NS + '-titleIcon' }, Icon({ name: 'check' })),
        h('span', { className: NS + '-titleLabel' }, state.busy ? '生成中…' : '标题'),
        state.note !== ''
          ? h('span', { className: NS + '-titleNote ' + NS + '-titleNote-' + state.kind }, state.note)
          : null);
    }
    /* ------------------------------------------------------------------ 装配 */

    const inject = ['slots', 'sessions'];

    function apply(ctx) {
      pluginCtx = ctx;
      injectStyles();
      // v4.2：设置入口只在设置页；标题栏保留一个纯「重算」按钮（无展开、无设置）。
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'session-title-context',
          order: 48,
          label: () => '标题总结',
        },
        TitleSettingsPage,
      ));
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
        {
          name: 'conversation.session.header.utilities',
          id: 'session-title-context',
          order: 24,
        },
        TitleBarButton,
      ));
    }

    exports.inject = inject;
    exports.apply = apply;
    // 纯函数出口：给 client-selftest.mjs 做单测，宿主不会用到。
    exports.__internals = {
      toPayload: toPayload,
      payloadOf: payloadOf,
      intOf: intOf,
      ruleProblem: ruleProblem,
      AUTOSAVE_MS: AUTOSAVE_MS,
    };
    return module.exports;
  },
});