/**
 * 按模型的重试策略（dsh-model-retry）— 浏览器半边。
 *
 * 设置页「重试策略」一节：按 (provider, model) 管理重试规则——
 * 重试次数、触发重试的失败类别码与 HTTP 状态码、退避参数；**规则还可以按
 * 「模型分组」命中**（group 选择器取自 dsh-model-groups，见设置页「模型分组」），
 * 一条规则就能给整组模型（成员可跨供应商）下同一套策略。
 * 规则经 host 的 /dsh-model-retry/rules 路由读写（落盘 $DSH_HOME/
 * model-retry-rules.json，保存即热生效）；「试算」调 host 的
 * /dsh-model-retry/preview 用真实匹配逻辑算出某条路由最终落到哪条规则
 * （含逐条打分），避免前端复刻打分规则。未匹配规则的模型按官方缺省执行
 * （页面顶部展示缺省值）。模型建议来自 remote.session.modelCatalog，支持 * 通配。
 *
 * 三条客户端约定：① 每条规则在浏览器侧带一个稳定 uid，只做 React key、保存时
 * 剥掉（下标作 key 时删中间一条会让未受控输入框串位）；② 保存前按 host 的同一
 * 口径先校验，非法值只报 inline 错误、不发 POST（host 整批校验，一条越界会让
 * 全部规则的修改都存不进去）；③ GET /rules 的任何失败都进 error 态并给「重试」
 * 入口，绝不把页面留在「加载中…」。切 mode 只影响下发的 payload，绝不动状态里
 * 用户填过的值。
 *
 * @module dsh-model-retry/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-retry',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const PAGE_CSS = [
      '.mretry-page { padding: 4px 2px 24px; display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); font-size: 13px; }',
      '.mretry-head { display: flex; align-items: center; gap: 8px; }',
      '.mretry-title { font-size: 15px; font-weight: 600; }',
      '.mretry-desc { font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }',
      '.mretry-defaults { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; padding: 9px 12px; font-size: 11px; line-height: 1.7; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); }',
      '.mretry-defaults code { font-family: monospace; font-size: 10px; }',
      '.mretry-rule { display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; }',
      '.mretry-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.mretry-label { font-size: 11px; color: var(--dsw-alias-label-secondary); min-width: 64px; flex-shrink: 0; }',
      '.mretry-input { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 4px 8px; font-size: 12px; min-width: 0; }',
      '.mretry-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
      '.mretry-provider { width: 150px; }',
      '.mretry-model { flex: 1; min-width: 140px; }',
      '.mretry-num { width: 76px; font-variant-numeric: tabular-nums; }',
      '.mretry-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; flex-shrink: 0; }',
      '.mretry-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }',
      '.mretry-btn:disabled { opacity: .5; cursor: default; }',
      '.mretry-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }',
      '.mretry-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }',
      '.mretry-mini { padding: 2px 8px; font-size: 11px; }',
      '.mretry-chip { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 2px 10px; font-size: 11px; cursor: pointer; font-family: monospace; }',
      '.mretry-chip.on { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); font-weight: 600; }',
      '.mretry-chip:hover { border-color: var(--dsw-alias-brand-primary); }',
      '.mretry-hint { font-size: 10px; color: var(--dsw-alias-label-secondary); }',
      '.mretry-group { width: 150px; }',
      '.mretry-warn { border: 1px solid var(--dsw-alias-state-warn-primary); border-radius: 8px; padding: 8px 10px; font-size: 11px; line-height: 1.8; color: var(--dsw-alias-state-warn-primary); }',
      '.mretry-preview { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }',
      '.mretry-hit { border: 1px solid var(--dsw-alias-brand-primary); border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.8; }',
      '.mretry-miss { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.mretry-scores { display: flex; gap: 4px; flex-wrap: wrap; }',
      '.mretry-score { border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 1px 7px; font-size: 10px; font-family: monospace; color: var(--dsw-alias-label-secondary); }',
      '.mretry-score.win { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 600; }',
      '.mretry-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); font-weight: 600; }',
      '.mretry-error-box { border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.8; color: var(--dsw-alias-state-error-primary); display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }',
      '.mretry-inline-error { font-size: 10px; color: var(--dsw-alias-state-error-primary); }',
      '.mretry-inline-warn { font-size: 10px; color: var(--dsw-alias-state-warn-primary); }',
      '.mretry-bad { border-color: var(--dsw-alias-state-error-primary); }',
      '.mretry-notice { font-size: 12px; color: var(--dsw-alias-state-success-primary); }',
      '.mretry-spacer { flex: 1; }',
    ].join('\n');

    const BOOT_CSS_ID = 'dsh-model-retry/page.css';
    function injectStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css="' + BOOT_CSS_ID + '"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-model-retry';
      tag.dataset.pluginCss = BOOT_CSS_ID;
      tag.textContent = PAGE_CSS;
      (document.head || document.documentElement).appendChild(tag);
    }

    const errorText = (error) => String(error && error.message ? error.message : error);

    /* ---- 客户端预校验口径：与 host 的 ruleSchema（entry-v2.js）逐项对齐 ----
       host 是整批校验：一条越界就让整批规则 400，连其它规则的修改也一起存不进去。
       所以非法值只在卡片内报 inline 错误、不发 POST。 ---- */
    const MAX_RETRIES_LIMIT = 1000;
    const MAX_RULES = 64;
    const MAX_SELECTOR_CHARS = 200;
    const MAX_CODES = 32;
    const MAX_CODE_CHARS = 80;
    const MAX_STATUS_CODES = 64;
    const MAX_TIMER_DELAY_MS = 2147483647;

    /** 字段口径表：中文名 + 允许范围（inline 错误与 host 400 报错翻译共用一份）。 */
    const FIELD_TEXT = {
      mode: { label: '模式', range: 'normal 或 always' },
      provider: { label: 'provider', range: '最多 ' + MAX_SELECTOR_CHARS + ' 字符' },
      model: { label: 'model', range: '最多 ' + MAX_SELECTOR_CHARS + ' 字符' },
      group: { label: '分组', range: '最多 ' + MAX_SELECTOR_CHARS + ' 字符' },
      maxRetries: { label: '重试次数', range: '0..' + MAX_RETRIES_LIMIT + ' 的整数' },
      retryableCodes: { label: '失败类别', range: '最多 ' + MAX_CODES + ' 个，每个 1..' + MAX_CODE_CHARS + ' 字符' },
      statusCodes: { label: '状态码', range: '100..599 的整数，最多 ' + MAX_STATUS_CODES + ' 个' },
      'backoff.initialDelayMs': { label: '退避初始延迟', range: '正数，最大 ' + MAX_TIMER_DELAY_MS + ' ms' },
      'backoff.maxDelayMs': { label: '退避上限延迟', range: '正数，最大 ' + MAX_TIMER_DELAY_MS + ' ms' },
      'backoff.jitterRatio': { label: '退避抖动', range: '0..1 的数' },
    };
    const fieldTextOf = (field) => (Object.prototype.hasOwnProperty.call(FIELD_TEXT, field) ? FIELD_TEXT[field] : null);

    const isIntIn = (value, min, max) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
    const isNumIn = (value, min, max, exclusiveMin) => {
      if (typeof value !== 'number' || Number.isFinite(value) !== true) return false;
      if (exclusiveMin === true ? value <= min : value < min) return false;
      return value <= max;
    };

    let uidSeq = 0;
    /** 规则稳定 uid：只做 React key；buildPayload 逐字段重建，uid 从不进 payload。 */
    const nextUid = () => 'r' + Date.now().toString(36) + '-' + (++uidSeq).toString(36);

    /** 新的空规则（带 uid；「新增规则」用）。 */
    const emptyRule = () => ({ uid: nextUid(), provider: '*', model: '*', group: null, mode: 'normal', maxRetries: 5, retryableCodes: null, statusCodes: [], backoff: null });

    /**
     * GET /rules 的规则 → 组件状态（补稳定 uid）。
     * 数组下标作 key 时，删除中间一条会让后面的卡片复用错位的 DOM
     * （未受控的「自定义状态码」输入框首当其冲）；uid 让卡片跟着数据走。
     */
    function hydrateRules(rows) {
      const used = new Set();
      return (Array.isArray(rows) ? rows : []).map((rule) => {
        const source = rule !== null && typeof rule === 'object' ? rule : {};
        const uid = typeof source.uid === 'string' && source.uid !== '' && used.has(source.uid) !== true ? source.uid : nextUid();
        used.add(uid);
        return Object.assign({}, source, { uid });
      });
    }

    /** 单条规则的校验问题（与 host ruleSchema 同口径）；返回 [{field, text}]。 */
    function ruleIssues(rule) {
      if (rule === null || typeof rule !== 'object') return [{ field: 'mode', text: '规则内容不是对象' }];
      const out = [];
      const add = (field, current) => {
        const info = fieldTextOf(field) || { label: field, range: '' };
        out.push({
          field,
          text: info.label + (info.range === '' ? '' : ' 只能填 ' + info.range)
            + (current === undefined ? '' : '（当前 ' + current + '）'),
        });
      };
      if (rule.mode !== undefined && rule.mode !== null && rule.mode !== 'normal' && rule.mode !== 'always') add('mode', rule.mode);
      for (const key of ['provider', 'model', 'group']) {
        const value = rule[key];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') { add(key, typeof value); continue; }
        const text = key === 'group' ? value.trim() : value;
        if (text !== '' && text !== '*' && text.length > MAX_SELECTOR_CHARS) add(key, text.length + ' 字符');
      }
      // always 模式不校验 limit 类字段：buildPayload 根本不下发它们（host 也整段
      // 忽略），在这里拦会把「切模式」这种与之无关的改动一起堵死。
      const effectiveMode = rule.mode === 'always' ? 'always' : 'normal';
      if (effectiveMode === 'normal') {
        if (rule.maxRetries !== undefined && rule.maxRetries !== null && !isIntIn(rule.maxRetries, 0, MAX_RETRIES_LIMIT)) add('maxRetries', rule.maxRetries);
        if (rule.retryableCodes !== undefined && rule.retryableCodes !== null
          && (!Array.isArray(rule.retryableCodes) || rule.retryableCodes.length > MAX_CODES
            || rule.retryableCodes.some((code) => typeof code !== 'string' || code.length < 1 || code.length > MAX_CODE_CHARS))) {
          add('retryableCodes', Array.isArray(rule.retryableCodes) ? rule.retryableCodes.length + ' 个' : typeof rule.retryableCodes);
        }
        if (rule.statusCodes !== undefined && rule.statusCodes !== null
          && (!Array.isArray(rule.statusCodes) || rule.statusCodes.length > MAX_STATUS_CODES
            || rule.statusCodes.some((code) => !isIntIn(code, 100, 599)))) {
          add('statusCodes', Array.isArray(rule.statusCodes) ? rule.statusCodes.length + ' 个' : typeof rule.statusCodes);
        }
      }
      const backoff = rule.backoff;
      if (backoff !== undefined && backoff !== null) {
        if (typeof backoff !== 'object' || Array.isArray(backoff)) add('backoff.initialDelayMs', typeof backoff);
        else {
          if (backoff.initialDelayMs !== undefined && backoff.initialDelayMs !== null && !isNumIn(backoff.initialDelayMs, 0, MAX_TIMER_DELAY_MS, true)) add('backoff.initialDelayMs', backoff.initialDelayMs);
          if (backoff.maxDelayMs !== undefined && backoff.maxDelayMs !== null && !isNumIn(backoff.maxDelayMs, 0, MAX_TIMER_DELAY_MS, true)) add('backoff.maxDelayMs', backoff.maxDelayMs);
          if (backoff.jitterRatio !== undefined && backoff.jitterRatio !== null && !isNumIn(backoff.jitterRatio, 0, 1, false)) add('backoff.jitterRatio', backoff.jitterRatio);
        }
      }
      return out;
    }

    /** 全部规则的问题（带规则下标）：保存闸门与卡片 inline 错误共用同一份结果。 */
    function collectIssues(rows) {
      const list = Array.isArray(rows) ? rows : [];
      const out = [];
      list.forEach((rule, index) => {
        for (const issue of ruleIssues(rule)) out.push({ index, field: issue.field, text: issue.text });
      });
      if (list.length > MAX_RULES) out.push({ index: -1, field: 'rules', text: '规则最多 ' + MAX_RULES + ' 条（当前 ' + list.length + ' 条）' });
      return out;
    }

    /**
     * host 400 的 `规则校验失败: 0.maxRetries: Too big: ...` → 用户看得懂的
     * 「第几条规则 · 哪个字段 · 允许范围」；网络错另给一句人话。
     */
    function describeSaveFailure(reason) {
      const raw = errorText(reason);
      if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(raw)) {
        return '保存失败：联系不上 dsh host（网络错误），规则没有落盘。' + raw;
      }
      const marker = '规则校验失败: ';
      const at = raw.indexOf(marker);
      if (at === -1) return '保存失败：' + (raw === '' ? 'host 未返回原因' : raw);
      const pieces = raw.slice(at + marker.length).split('; ').map((piece) => piece.trim()).filter((piece) => piece !== '');
      const described = pieces.map((piece) => {
        // host（zod）实际发出的路径带 rules. 前缀，两种写法都要认：
        //   `rules.0.maxRetries: Too big: …`（字段级）
        //   `rules: Too big: expected array to have <=64 items`（整数组超限）
        const match = /^(?:rules\.)?(\d+)\.(.+?):\s*(.*)$/.exec(piece);
        if (match === null) {
          return /^rules:\s/.test(piece) ? '规则条数超出上限（最多 ' + MAX_RULES + ' 条）' : '（' + piece + '）';
        }
        const ruleAt = Number(match[1]);
        const field = match[2].replace(/\.\d+$/, '');
        const info = fieldTextOf(field);
        return info === null
          ? '第 ' + (ruleAt + 1) + ' 条规则的字段 ' + field + ' 不合法（host 原话：' + match[3] + '）'
          : '第 ' + (ruleAt + 1) + ' 条规则的「' + info.label + '」不在允许范围（' + info.range + '）';
      });
      return '保存失败（host 校验拒绝，未落盘）：' + (described.length === 0 ? raw : described.join('；'));
    }

    const QUICK_STATUSES = [429, 500, 502, 503, 504, 529];

    /** 规则选择器权重的中文说明（与 host 的 scoreOf 同口径）。 */
    const WEIGHT_TEXT = 'provider 字面 2 · model 字面 2 · group 命中 3';

    /** 策略 → 一行中文摘要（试算面板与缺省说明共用）。 */
    function policyText(policy) {
      if (policy === null || policy === undefined) return '（无策略）';
      const backoff = policy.backoff || {};
      const tail = `退避 ${backoff.initialDelayMs ?? '—'}ms → ${backoff.maxDelayMs ?? '—'}ms（抖动 ${backoff.jitterRatio ?? '—'}）`;
      if (policy.mode === 'always') return `持续重试（不限次，直到成功）· ${tail}`;
      const codes = Array.isArray(policy.retryableCodes) ? policy.retryableCodes.join(' / ') : '—';
      const statuses = Array.isArray(policy.statusCodes) && policy.statusCodes.length > 0 ? ` · 状态码 ${policy.statusCodes.join(' / ')}` : '';
      return `普通模式 · 最多 ${policy.maxRetries} 次 · 触发类别 ${codes}${statuses} · ${tail}`;
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

    /** Toggle one value inside an array copy; `on` forces state when given. */
    function toggle(list, value, on) {
      const has = Array.isArray(list) && list.includes(value);
      const base = Array.isArray(list) ? list : [];
      if (on === undefined) return has ? base.filter((v) => v !== value) : [...base, value];
      if (on === true && !has) return [...base, value];
      if (on === false && has) return base.filter((v) => v !== value);
      return base;
    }

    function Chip({ label, on, onClick, title }) {
      return h('button', {
        type: 'button', className: 'mretry-chip' + (on ? ' on' : ''), onClick, title: title || label,
      }, label);
    }

    /** 选项标签：名称与 id 不同就都显示。 */
    const labelOf = (id, name) => (name && name !== id ? name + '（' + id + '）' : id);

    function RuleCard({ rule, index, onChange, onRemove, onCopy, knownCodes, providerGroups, modelsOf, allModels, groups, groupsAvailable, issues, canCopy }) {
      const set = (patch) => onChange(index, patch);
      const codes = Array.isArray(rule.retryableCodes) ? rule.retryableCodes : null;
      const statuses = Array.isArray(rule.statusCodes) ? rule.statusCodes : [];
      const backoff = rule.backoff || {};
      const isAlways = rule.mode === 'always';
      const providerValue = rule.provider || '*';
      const modelValue = rule.model || '*';
      // 该字段的 inline 校验问题（由页面用 collectIssues 统一算出后传进来）
      const firstIssue = (field) => (Array.isArray(issues) ? issues.filter((issue) => issue.field === field)[0] : undefined);
      const bad = (field) => (firstIssue(field) === undefined ? '' : ' mretry-bad');
      const issueLine = (field) => {
        const issue = firstIssue(field);
        return issue === undefined ? null : h('span', { className: 'mretry-inline-error' }, '⚠ ' + issue.text);
      };

      // 规则的 model 可为 *（任意）；目录里没有的值（如旧规则/hand-edited）保留为「目录外」选项。
      let providerControl;
      if (providerGroups.length > 0) {
        const providerKnown = providerValue === '*' || providerGroups.some((g) => g.id === providerValue);
        providerControl = h('select', {
          className: 'mretry-input mretry-provider', value: providerValue,
          onChange: (e) => {
            const provider = e.target.value;
            const models = modelsOf(provider);
            const keepModel = modelValue === '*' || models.some((m) => m.id === modelValue);
            set(keepModel ? { provider } : { provider, model: '*' });
          },
        },
          h('option', { value: '*' }, '*（任意 provider）'),
          !providerKnown && providerValue !== '*' ? h('option', { value: providerValue }, providerValue + '（目录外）') : null,
          providerGroups.map((g) => h('option', { key: g.id, value: g.id }, labelOf(g.id, g.name))),
        );
      } else {
        providerControl = h('input', {
          className: 'mretry-input mretry-provider', placeholder: 'provider（* = 任意；目录不可用，手动输入）',
          value: providerValue, onChange: (e) => set({ provider: e.target.value }),
        });
      }

      const modelChoices = providerValue === '*' || providerValue === '' ? allModels : modelsOf(providerValue);
      let modelControl;
      if (modelChoices.length > 0) {
        const modelKnown = modelValue === '*' || modelChoices.some((m) => m.id === modelValue);
        modelControl = h('select', {
          className: 'mretry-input mretry-model', value: modelValue,
          onChange: (e) => set({ model: e.target.value }),
        },
          h('option', { value: '*' }, '*（任意 model）'),
          !modelKnown && modelValue !== '*' ? h('option', { value: modelValue }, modelValue + '（目录外）') : null,
          modelChoices.map((m) => h('option', { key: m.id, value: m.id }, labelOf(m.id, m.name))),
        );
      } else {
        modelControl = h('input', {
          className: 'mretry-input mretry-model', placeholder: 'model（* = 任意）',
          value: modelValue, onChange: (e) => set({ model: e.target.value }),
        });
      }

      // 分组选择器（规则可整组生效）。分组插件不在线 / 还没有分组时退化为自由输入，
      // 并写明原因——绝不渲染一个没有 option 的空下拉。
      const groupValue = typeof rule.group === 'string' ? rule.group : '';
      const hasGroupCatalog = Array.isArray(groups) && groups.length > 0;
      const groupKnown = groupValue === '' || (hasGroupCatalog && groups.some((entry) => entry.id === groupValue));
      let groupControl;
      let groupHint = null;
      if (hasGroupCatalog) {
        groupControl = h('select', {
          className: 'mretry-input mretry-group', value: groupValue,
          title: '按「模型分组」命中：整组模型（成员可跨供应商）共用这条策略',
          onChange: (e) => set({ group: e.target.value === '' ? null : e.target.value }),
        },
          h('option', { value: '' }, '不按组'),
          !groupKnown ? h('option', { value: groupValue }, groupValue + '（组不存在或已停用）') : null,
          groups.map((entry) => h('option', { key: entry.id, value: entry.id },
            labelOf(entry.id, entry.name) + (entry.enabled === false ? '（已停用）' : '') + (entry.order > 0 ? ' #' + entry.order : ''))),
        );
        if (!groupKnown) {
          groupHint = h('span', { className: 'mretry-inline-warn' }, '⚠ 分组「' + groupValue + '」不存在或已停用：这条规则不会命中任何请求。');
        }
      } else {
        groupControl = h('input', {
          className: 'mretry-input mretry-group', value: groupValue,
          placeholder: groupsAvailable === false ? '组 id（分组插件不在线）' : '组 id',
          onChange: (e) => set({ group: e.target.value.trim() === '' ? null : e.target.value.trim() }),
        });
        groupHint = h('span', { className: 'mretry-hint' }, groupsAvailable === false
          ? '分组插件（dsh-model-groups）不在线：暂时按组 id 手输，启用后这里会变成下拉。'
          : (groupsAvailable === true
            ? '还没有分组：去设置页「模型分组」新建，或先留空。'
            : '分组目录尚未加载：带 group 的规则可能不命中。'));
      }

      // provider/model/group 任一项越界（>MAX_SELECTOR_CHARS）时的卡片内提示。
      const overLong = ['provider', 'model', 'group'].filter((field) => {
        const raw = field === 'provider' ? providerValue : field === 'model' ? modelValue : groupValue;
        const text = field === 'group' && typeof raw === 'string' ? raw.trim() : raw;
        return typeof text === 'string' && text !== '' && text !== '*' && text.length > MAX_SELECTOR_CHARS;
      });
      const selectorIssue = overLong.length === 0 ? null : h('span', { className: 'mretry-inline-warn' },
        '⚠ ' + overLong.map((field) => field + ' 超过 ' + MAX_SELECTOR_CHARS + ' 字符').join('、') + '：保存被拦下，请改短。');

      return h('div', { className: 'mretry-rule' },
        h('div', { className: 'mretry-row' },
          h('span', { className: 'mretry-label' }, '匹配'),
          providerControl,
          modelControl,
          groupControl,
          h('span', { className: 'mretry-spacer' }),
          h('button', {
            className: 'mretry-btn mretry-mini', title: '复制该规则（副本紧随其后，最多 ' + MAX_RULES + ' 条）',
            disabled: canCopy === false,
            onClick: () => { if (typeof onCopy === 'function') onCopy(index); },
          }, '复制'),
          h('button', {
            className: 'mretry-btn mretry-danger mretry-mini', onClick: () => onRemove(index), title: '删除该规则',
          }, '删除'),
        ),
        // provider / model / group 越界也要有卡片内提示：保存被拦下时页头写的是
        // 「见规则卡内提示」，而这三个字段原先没有任何 inline 错误，用户会找不到原因。
        (selectorIssue !== null || groupHint !== null) ? h('div', { className: 'mretry-row' },
          h('span', { className: 'mretry-label' }),
          selectorIssue,
          groupHint,
        ) : null,
        h('div', { className: 'mretry-row' },
          h('span', { className: 'mretry-label' }, '模式'),
          h('select', {
            className: 'mretry-input', value: rule.mode || 'normal',
            onChange: (e) => set({ mode: e.target.value }),
          },
            h('option', { value: 'normal' }, '普通（限额重试）'),
            h('option', { value: 'always' }, '持续（不限次重试直到成功）'),
          ),
          issueLine('mode'),
          !isAlways ? h('span', { className: 'mretry-row' },
            h('span', { className: 'mretry-label' }, '重试次数'),
            h('input', {
              className: 'mretry-input mretry-num mretry-retries' + bad('maxRetries'), type: 'number',
              min: 0, max: MAX_RETRIES_LIMIT, step: 1,
              placeholder: '5', value: typeof rule.maxRetries === 'number' && Number.isFinite(rule.maxRetries) ? rule.maxRetries : '',
              onChange: (e) => set({ maxRetries: e.target.value === '' ? null : Number(e.target.value) }),
            }),
            h('span', { className: 'mretry-hint' }, '0..' + MAX_RETRIES_LIMIT + '（留空按官方缺省）'),
            issueLine('maxRetries'),
          ) : null,
        ),
        !isAlways ? h('div', { className: 'mretry-row' },
          h('span', { className: 'mretry-label' }, '失败类别'),
          knownCodes.map((code) => h(Chip, {
            key: code,
            label: code,
            title: codes === null ? '未勾选时按缺省（前五类）执行；点击后显式保存' : undefined,
            on: codes === null ? ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'].includes(code) : codes.includes(code),
            onClick: () => set({ retryableCodes: codes === null
              ? ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'].filter((c) => c !== code)
              : toggle(codes, code) }),
          })),
          h('span', { className: 'mretry-hint' }, codes === null ? '（缺省五类）' : ''),
          issueLine('retryableCodes'),
        ) : null,
        !isAlways ? h('div', { className: 'mretry-row' },
          h('span', { className: 'mretry-label' }, '状态码'),
          QUICK_STATUSES.map((status) => h(Chip, {
            key: status,
            label: String(status),
            on: statuses.includes(status),
            onClick: () => set({ statusCodes: toggle(statuses, status) }),
          })),
          // 自定义 / 越界值（手改 JSON 写进 999 之类）也要给一个能点掉的入口：
          // 否则校验一直不通过，整页规则都保存不了，而界面上没有任何控件能删掉它。
          statuses.filter((status) => !QUICK_STATUSES.includes(status)).map((status) => h(Chip, {
            key: 'custom-' + String(status),
            label: String(status) + ' ✕',
            on: true,
            title: '自定义状态码，点一下移除',
            onClick: () => set({ statusCodes: toggle(statuses, status) }),
          })),
          h('input', {
            className: 'mretry-input mretry-num', type: 'number', min: 100, max: 599, placeholder: '自定义…',
            onKeyDown: (e) => {
              if (e.key !== 'Enter') return;
              const value = Number(e.target.value);
              if (Number.isInteger(value) && value >= 100 && value <= 599) {
                set({ statusCodes: toggle(statuses, value, true) });
                e.target.value = '';
              }
            },
            title: '输入状态码后回车添加',
          }),
          h('span', { className: 'mretry-hint' }, '命中即触发重试（如 402/418）'),
          issueLine('statusCodes'),
        ) : null,
        h('div', { className: 'mretry-row' },
          h('span', { className: 'mretry-label' }, '退避(ms)'),
          h('input', {
            className: 'mretry-input mretry-num' + bad('backoff.initialDelayMs'), type: 'number', min: 1, placeholder: '500',
            value: backoff.initialDelayMs ?? '',
            onChange: (e) => set({ backoff: { ...backoff, initialDelayMs: e.target.value === '' ? undefined : Number(e.target.value) } }),
          }),
          h('span', { className: 'mretry-hint' }, '→'),
          h('input', {
            className: 'mretry-input mretry-num' + bad('backoff.maxDelayMs'), type: 'number', min: 1, placeholder: '10000',
            value: backoff.maxDelayMs ?? '',
            onChange: (e) => set({ backoff: { ...backoff, maxDelayMs: e.target.value === '' ? undefined : Number(e.target.value) } }),
          }),
          h('span', { className: 'mretry-hint' }, '抖动'),
          h('input', {
            className: 'mretry-input mretry-num' + bad('backoff.jitterRatio'), type: 'number', min: 0, max: 1, step: 0.05, placeholder: '0.1',
            value: backoff.jitterRatio ?? '',
            onChange: (e) => set({ backoff: { ...backoff, jitterRatio: e.target.value === '' ? undefined : Number(e.target.value) } }),
          }),
          issueLine('backoff.initialDelayMs'),
          issueLine('backoff.maxDelayMs'),
          issueLine('backoff.jitterRatio'),
        ),
      );
    }

    let pluginCtx = undefined;

    function RetryPolicyPage() {
      const ctx = pluginCtx;
      const [rules, setRules] = React.useState(null);
      const [defaults, setDefaults] = React.useState(null);
      const [knownCodes, setKnownCodes] = React.useState(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']);
      const [catalog, setCatalog] = React.useState(null);
      const [error, setError] = React.useState('');
      // 自动保存：任何规则改动防抖 900ms 后落盘；lastSaved 记录上次已保存
      // 的序列化形态，避免初始加载与保存回写造成的重复保存。
      const [saveState, setSaveState] = React.useState('');
      // 分组目录（来自 host GET /rules 的 groups/groupsAvailable）与引用告警
      const [groups, setGroups] = React.useState([]);
      const [groupsAvailable, setGroupsAvailable] = React.useState(null);
      const [warnings, setWarnings] = React.useState([]);
      // 试算：host 用真实匹配逻辑算出的归属 + 逐条打分
      const [preview, setPreview] = React.useState({ provider: '', model: '', result: null, busy: false });
      // 加载态：GET /rules 的任何失败都必须离开 'loading'（否则页面永久停在
      // 「加载中…」且没有恢复入口）；reloadSeq 是「重试」按钮的重新加载开关。
      const [loadState, setLoadState] = React.useState('loading');
      const [reloadSeq, setReloadSeq] = React.useState(0);
      const loadedRef = React.useRef(false);
      // host 报告「规则文件读不出来」（形状坏/语法坏）时置位：此时页面显示的是
      // 兜底的空规则集，任何自动保存都会把用户的文件覆盖掉——必须一直拦住，
      // 直到用户自己把文件修好（或明确重试成功后清零）。
      const hostErrorRef = React.useRef(null);
      const lastSavedRef = React.useRef('');
      const timerRef = React.useRef(null);

      React.useEffect(() => {
        let cancelled = false;
        setLoadState('loading');
        api('/dsh-model-retry/rules')
          .then((value) => {
            if (cancelled) return;
            // 200 但响应体不是对象（代理/网关插页返回 `null` 之类）：按加载失败处理。
            // 绝不能当成「一条规则都没有」——那样用户一编辑就把磁盘上的规则覆盖了。
            if (value === null || typeof value !== 'object' || Array.isArray(value)) {
              throw new Error('host 返回的规则响应不是对象：' + String(value).slice(0, 80));
            }
            // 形状不完整（rules 不是数组）同样按加载失败处理：静默当成「零条规则」会让用户
            // 一编辑就把磁盘上的规则覆盖掉。host 正常永远回数组，这里挡的是中间层/未来回归。
            if (!Array.isArray(value.rules)) {
              throw new Error('host 返回的 rules 不是数组（收到 ' + (value.rules === null ? 'null' : typeof value.rules) + '）：拒绝加载');
            }
            setRules(hydrateRules(value.rules));
            setDefaults(value.defaults || null);
            setGroups(Array.isArray(value.groups) ? value.groups : []);
            setGroupsAvailable(value.groupsAvailable === true);
            // host 读文件失败时仍回 200（规则退化为空），错误只在 error 字段里：
            // 必须显示出来，否则页面像「一条规则都没有」，用户一编辑就把它覆盖了。
            const hostError = typeof value.error === 'string' && value.error !== '' ? ['读取规则文件出错（host 报告）：' + value.error + '（为避免覆盖你的文件，本页在修复它之前不会自动保存）'] : [];
            hostErrorRef.current = hostError.length > 0 ? value.error : null;
            setWarnings(hostError.concat(Array.isArray(value.warnings) ? value.warnings : []));
            if (Array.isArray(value.knownCodes) && value.knownCodes.length > 0) setKnownCodes(value.knownCodes);
            setError('');
            setLoadState('ready');
          })
          .catch((reason) => {
            // 非 JSON 的 4xx / 网络错 / 5xx 一律落到这里：进 error 态并显示「重试」，
            // 绝不让 loading 永远为 true（rules 保持 null，保存闸门因此不会写盘）。
            if (cancelled) return;
            setRules(null);
            loadedRef.current = false;
            setError(errorText(reason));
            setLoadState('error');
          });
        Promise.resolve(ctx && ctx.remote && ctx.remote.session ? ctx.remote.session.modelCatalog() : null)
          .then((response) => {
            if (cancelled) return;
            if (response !== null && response !== undefined && response.ok === true) setCatalog(response.value || {});
          })
          .catch(() => { if (cancelled !== true) setCatalog({}); });
        return () => { cancelled = true; if (timerRef.current !== null) clearTimeout(timerRef.current); };
      }, [ctx, reloadSeq]);

      const providerGroups = (catalog !== null && Array.isArray(catalog.groups)) ? catalog.groups : [];
      const allModels = (() => {
        const seen = new Set();
        const out = [];
        for (const group of providerGroups) {
          for (const m of (group.models || [])) {
            if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
          }
        }
        return out;
      })();
      const modelsOf = (provider) => {
        if (typeof provider !== 'string' || provider === '' || provider === '*') return allModels;
        const group = providerGroups.find((entry) => entry.id === provider);
        return group !== undefined && Array.isArray(group.models) ? group.models : [];
      };

      // 切 mode 只影响下发的 payload（buildPayload 在 always 下省略 limit 类字段），
      // 绝不从组件状态里删用户填过的值——否则 normal→always→normal 往返就静默丢数据。
      const patchRule = (index, patch) => setRules((rows) => rows.map((r, i) => (
        i === index ? { ...r, ...patch, uid: r.uid || nextUid() } : r
      )));

      // 复制一条规则：副本紧随其后并拿一个**新 uid**（与 dsh-model-groups 同做法）。
      const copyRule = (index) => setRules((rows) => {
        const source = rows[index];
        if (source === undefined || rows.length >= MAX_RULES) return rows;
        const next = rows.slice();
        next.splice(index + 1, 0, Object.assign({}, source, { uid: nextUid() }));
        return next;
      });

      /** 保存当前规则集（防抖到期与「重试保存」按钮共用；失败不自动重发）。 */
      const saveNow = (payload) => {
        setSaveState('saving');
        api('/dsh-model-retry/rules', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
        })
          .then(() => {
            lastSavedRef.current = payload;
            // 写盘成功即文件已被这份内容取代：读取错误的闸门随之解除
            //（用户此时看到的就是磁盘上的内容）。
            hostErrorRef.current = null;
            setWarnings((prev) => prev.filter((text) => !text.includes('读取规则文件出错')));
            setSaveState('saved');
            setError('');
          })
          .catch((reason) => {
            setSaveState('error');
            setError(describeSaveFailure(reason));
          });
      };

      const buildPayload = (rows) => (rows || []).map((rule) => {
        // 逐字段重建（uid 只做 React key，从不进入 payload；host schema 里也没有它）。
        const out = { provider: rule.provider || '*', model: rule.model || '*', mode: rule.mode === 'always' ? 'always' : 'normal' };
        if (typeof rule.group === 'string' && rule.group.trim() !== '' && rule.group.trim() !== '*') out.group = rule.group.trim();
        if (out.mode === 'normal') {
          if (rule.maxRetries !== null && rule.maxRetries !== undefined) out.maxRetries = Number(rule.maxRetries);
          if (Array.isArray(rule.retryableCodes)) out.retryableCodes = rule.retryableCodes;
          if (Array.isArray(rule.statusCodes) && rule.statusCodes.length > 0) out.statusCodes = rule.statusCodes;
          const backoff = {};
          if (rule.backoff && rule.backoff.initialDelayMs !== undefined && rule.backoff.initialDelayMs !== null) backoff.initialDelayMs = Number(rule.backoff.initialDelayMs);
          if (rule.backoff && rule.backoff.maxDelayMs !== undefined && rule.backoff.maxDelayMs !== null) backoff.maxDelayMs = Number(rule.backoff.maxDelayMs);
          if (rule.backoff && rule.backoff.jitterRatio !== undefined && rule.backoff.jitterRatio !== null) backoff.jitterRatio = Number(rule.backoff.jitterRatio);
          if (Object.keys(backoff).length > 0) out.backoff = backoff;
        } else if (rule.backoff) {
          const backoff = {};
          if (rule.backoff.initialDelayMs !== undefined && rule.backoff.initialDelayMs !== null) backoff.initialDelayMs = Number(rule.backoff.initialDelayMs);
          if (rule.backoff.maxDelayMs !== undefined && rule.backoff.maxDelayMs !== null) backoff.maxDelayMs = Number(rule.backoff.maxDelayMs);
          if (rule.backoff.jitterRatio !== undefined && rule.backoff.jitterRatio !== null) backoff.jitterRatio = Number(rule.backoff.jitterRatio);
          if (Object.keys(backoff).length > 0) out.backoff = backoff;
        }
        return out;
      });

      // POST 信封须与 host 侧 rulesSchema（{ rules: [...] }）及 GET 返回同形：
      // buildPayload 只产出规则数组本体，经此包一层后才发出。
      const payloadOf = (rows) => JSON.stringify({ rules: buildPayload(rows) });

      // 任何规则变化：先按 host 同口径校验，通过后防抖 900ms 自动保存。
      // 保存成功不回写本地状态（避免打断正在进行的编辑）；失败只显示可读错误，
      // 不自动重发（要重发由用户点「重试保存」或再改一次规则）。
      React.useEffect(() => {
        if (rules === null) return;
        const payload = payloadOf(rules);
        if (loadedRef.current !== true) {
          loadedRef.current = true;
          lastSavedRef.current = payload;
          // 磁盘上的规则本身就有非法值（手改过文件）：先提示，不落盘也不覆盖。
          if (collectIssues(rules).length > 0) setSaveState('invalid');
          return;
        }
        // host 读不出规则文件（页面显示的是兜底空集）：绝不自动保存，否则用户的
        // 文件会被这份空集覆盖。仅首次加载成立是不够的——同实例的任何二次加载
        //（ctx 身份变化触发 effect 重跑）都会把闸门绕过去。
        if (hostErrorRef.current !== null) {
          if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
          setSaveState('invalid');
          return;
        }
        // 非法值（如 maxRetries > 1000）不发 POST：host 整批校验，发出去就是
        // 永久 400，连其它规则的修改也一起存不进去。改成合法值后自动恢复。
        if (collectIssues(rules).length > 0) {
          if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
          setSaveState('invalid');
          return;
        }
        if (payload === lastSavedRef.current) {
          // 值改回已保存的原样：只清掉「不合法」提示，不重复 POST。
          setSaveState((prev) => (prev === 'invalid' ? '' : prev));
          return;
        }
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          saveNow(payload);
        }, 900);
        return () => { if (timerRef.current !== null) clearTimeout(timerRef.current); };
      }, [rules]);

      const defaultText = defaults === null ? '' : `官方缺省（未匹配任何规则时）：${defaults.mode === 'normal' ? '普通模式' : defaults.mode} · 重试 ${defaults.maxRetries} 次 · 触发类别 ${defaults.retryableCodes.join(' / ')} · 退避 ${defaults.backoff.initialDelayMs}ms → ${defaults.backoff.maxDelayMs}ms（抖动 ${defaults.backoff.jitterRatio}）。provider 的 Retry-After 头始终优先并受上限约束。`;

      const runPreview = () => {
        setPreview((prev) => Object.assign({}, prev, { busy: true, result: null }));
        api('/dsh-model-retry/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: preview.provider, model: preview.model }),
        })
          .then((value) => setPreview((prev) => Object.assign({}, prev, { busy: false, result: value })))
          .catch((reason) => {
            setPreview((prev) => Object.assign({}, prev, { busy: false, result: null }));
            setError(errorText(reason));
          });
      };

      const previewModels = modelsOf(preview.provider);
      const result = preview.result;
      const winnerIndex = result !== null && result !== undefined && typeof result.ruleIndex === 'number' ? result.ruleIndex : -1;
      const scores = result !== null && result !== undefined && Array.isArray(result.scores) ? result.scores : [];
      // 校验问题（保存闸门与卡片 inline 错误同源）与「引用了用不了的分组」的规则。
      const issueList = collectIssues(rules);
      const issuesOf = (index) => issueList.filter((issue) => issue.index === index);
      const groupProblems = (Array.isArray(rules) ? rules : []).reduce((acc, rule, index) => {
        const id = typeof rule.group === 'string' ? rule.group.trim() : '';
        if (id === '') return acc;
        let reason = null;
        if (groupsAvailable === false) reason = '分组插件不在线';
        else if (Array.isArray(groups) && groups.length === 0) reason = '还没有任何分组';
        else if (Array.isArray(groups) && !groups.some((entry) => entry.id === id)) reason = '分组不存在或已停用';
        if (reason !== null) acc.push({ index, id, reason });
        return acc;
      }, []);
      const previewBox = h('div', { className: 'mretry-preview' },
        h('div', { className: 'mretry-row' },
          h('span', { className: 'mretry-title', style: { fontSize: '13px' } }, '试算'),
          h('span', { className: 'mretry-hint' }, '给定一条路由，看它最终落到哪条规则（' + WEIGHT_TEXT + '，同分取靠前者）——由 host 用真实匹配逻辑计算'),
        ),
        h('div', { className: 'mretry-row' },
          h('span', { className: 'mretry-label' }, '供应商'),
          providerGroups.length > 0
            ? h('select', {
                className: 'mretry-input mretry-provider', value: preview.provider,
                onChange: (e) => setPreview((prev) => Object.assign({}, prev, { provider: e.target.value, model: '', result: null })),
              },
                h('option', { value: '' }, '（选择…）'),
                providerGroups.map((g) => h('option', { key: g.id, value: g.id }, labelOf(g.id, g.name))),
              )
            : h('input', {
                className: 'mretry-input mretry-provider', placeholder: 'provider（模型目录不可用，手动输入）', value: preview.provider,
                onChange: (e) => setPreview((prev) => Object.assign({}, prev, { provider: e.target.value })),
              }),
          h('span', { className: 'mretry-label' }, '模型'),
          previewModels.length > 0
            ? h('select', {
                className: 'mretry-input mretry-model', value: preview.model,
                onChange: (e) => setPreview((prev) => Object.assign({}, prev, { model: e.target.value, result: null })),
              },
                h('option', { value: '' }, '（选择…）'),
                previewModels.map((m) => h('option', { key: m.id, value: m.id }, labelOf(m.id, m.name))),
              )
            : h('input', {
                className: 'mretry-input mretry-model', placeholder: 'model（可手输目录外的值）', value: preview.model,
                onChange: (e) => setPreview((prev) => Object.assign({}, prev, { model: e.target.value })),
              }),
          h('button', {
            className: 'mretry-btn mretry-primary',
            disabled: preview.busy === true || (preview.provider === '' && preview.model === ''),
            onClick: runPreview,
          }, preview.busy === true ? '计算中…' : '试算'),
        ),
        providerGroups.length === 0
          ? h('div', { className: 'mretry-hint' }, catalog === null
              ? '模型目录加载中：provider / model 可先手动输入。'
              : '模型目录为空：provider / model 手动输入即可（不依赖模型分组插件）。')
          : null,
        result === null || result === undefined
          ? null
          : (result.rule === null || result.rule === undefined
              ? h('div', { className: 'mretry-miss' },
                  '未命中任何规则 → 按官方缺省执行：' + policyText(result.policy),
                  result.groupsAvailable === false ? '（分组插件不在线，带 group 的规则一律不命中）' : null,
                )
              : h('div', { className: 'mretry-hit' },
                  h('div', null, '命中第 ' + (winnerIndex + 1) + ' 条规则'
                    + (scores[winnerIndex] !== undefined ? '（分数 ' + scores[winnerIndex].score + '）' : '')
                    + ' · 分组：' + (result.groupId === null || result.groupId === undefined
                      ? '未分组'
                      : (result.groupName || result.groupId) + '（' + result.groupId + '）')),
                  h('div', { className: 'mretry-hint' }, '策略：' + policyText(result.policy)),
                )),
        scores.length > 0
          ? h('div', { className: 'mretry-scores' },
              scores.map((row) => h('span', {
                key: 's' + row.index,
                className: 'mretry-score' + (row.index === winnerIndex ? ' win' : ''),
                title: JSON.stringify(row.rule),
              }, '第 ' + (row.index + 1) + ' 条 ' + (row.score < 0 ? '不命中' : row.score + ' 分'))),
            )
          : null,
        warnings.length > 0
          ? h('div', { className: 'mretry-warn' }, warnings.map((text, at) => h('div', { key: 'w' + at }, '⚠ ' + text)))
          : null,
        groupProblems.length > 0
          ? h('div', { className: 'mretry-warn' }, groupProblems.map((row) => h('div', { key: 'p' + row.index },
              '⚠ 第 ' + (row.index + 1) + ' 条规则引用了分组「' + row.id + '」（' + row.reason + '）：这条规则不会命中任何请求。')))
          : null,
        groupsAvailable === false
          ? h('div', { className: 'mretry-warn' }, '⚠ 模型分组插件（dsh-model-groups）不在线：带 group 的规则不会命中任何请求，请先启用它或改用 provider/model。')
          : null,
        groupsAvailable === true
          ? h('div', { className: 'mretry-hint' }, '可用分组：' + (groups.length === 0
              ? '（还没有分组，去设置页「模型分组」新建）'
              : groups.map((g) => (g.name || g.id) + (g.enabled === false ? '(停用)' : '')).join('、')))
          : null,
        groupsAvailable === null
          ? h('div', { className: 'mretry-hint' }, '分组目录尚未加载：带 group 的规则可能不命中。')
          : null,
      );

      return h('div', { className: 'mretry-page' },
        h('div', { className: 'mretry-head' },
          h('span', { className: 'mretry-title' }, '重试策略'),
          h('span', { className: 'mretry-spacer' }),
          saveState === 'saving' ? h('span', { className: 'mretry-hint' }, '自动保存中…') : null,
          saveState === 'saved' ? h('span', { className: 'mretry-notice' }, '✓ 已自动保存，即时生效') : null,
          saveState === 'invalid' ? h('span', { className: 'mretry-error' }, '⚠ 有 ' + issueList.length + ' 处填写不合法，未保存（见规则卡内提示）') : null,
          saveState === 'error' ? h('span', { className: 'mretry-error' }, '自动保存失败（未落盘）') : null,
        ),
        h('div', { className: 'mretry-desc' },
          '为指定模型或整个模型分组配置请求失败后的重试行为：重试次数、触发重试的失败类别与 HTTP 状态码、退避节奏。'
          + '规则按选择器权重取最具体者（' + WEIGHT_TEXT + '，同分取靠前者）：只按组的规则会盖掉 provider/model 通配规则，但不会盖掉已有的单路由精确规则；'
          + '组规则再钉上 provider/model 则更具体。所有修改自动保存并立即热生效，无需重启。'),
        defaults !== null ? h('div', { className: 'mretry-defaults' }, defaultText) : null,
        loadState === 'error'
          ? h('div', { className: 'mretry-error-box' },
              h('div', { className: 'mretry-error' }, '读取重试规则失败：' + (error === '' ? '未知原因' : error)),
              h('div', { className: 'mretry-hint' }, '规则没有加载出来：本页既不会自动保存，也不会覆盖磁盘上的规则文件。'),
              h('button', { className: 'mretry-btn', onClick: () => setReloadSeq((seq) => seq + 1) }, '重试'),
            )
          : (rules === null ? h('div', { className: 'mretry-desc' }, '加载中…') : null),
        Array.isArray(rules) ? rules.map((rule, index) => h(RuleCard, {
          key: rule.uid || 'idx' + index,
          rule,
          index,
          knownCodes,
          providerGroups,
          modelsOf,
          allModels,
          groups,
          groupsAvailable,
          issues: issuesOf(index),
          canCopy: rules.length < MAX_RULES,
          onChange: patchRule,
          onCopy: copyRule,
          onRemove: (at) => setRules((rows) => rows.filter((_, i) => i !== at)),
        })) : null,
        issueList.some((issue) => issue.index < 0)
          ? h('div', { className: 'mretry-inline-error' }, '⚠ ' + issueList.filter((issue) => issue.index < 0).map((issue) => issue.text).join('；'))
          : null,
        Array.isArray(rules) ? h('div', { className: 'mretry-row' },
          h('button', {
            className: 'mretry-btn', disabled: rules.length >= MAX_RULES,
            onClick: () => setRules((rows) => [...rows, emptyRule()]),
          }, '＋ 新增规则'),
          h('span', { className: 'mretry-hint' }, 'provider/model 留 * 表示任意；「组」选一个模型分组即整组生效；三者是与关系，全留 * 即全局缺省覆盖'),
        ) : null,
        loadState !== 'error' && error !== '' ? h('div', { className: 'mretry-error-box' },
          h('div', { className: 'mretry-error' }, error),
          saveState === 'error' ? h('div', { className: 'mretry-row' },
            h('button', { className: 'mretry-btn', onClick: () => saveNow(payloadOf(rules || [])) }, '重试保存'),
            h('span', { className: 'mretry-hint' }, '不会自动重发：修好后点这里，或再改一次规则。'),
          ) : null,
        ) : null,
        previewBox,
      );
    }

    const inject = ['slots', 'remote', 'remote.session'];

    function apply(ctx) {
      pluginCtx = ctx;
      injectStyles();
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'retry-policy', order: 30, label: '重试策略' },
        (ownerProps) => h(RetryPolicyPage, { close: ownerProps && ownerProps.close }),
      ));
    }

    exports.inject = inject;
    exports.apply = apply;

    // 供 client-selftest.mjs 无头驱动。
    exports.__ui = {
      css: PAGE_CSS, policyText, labelOf, emptyRule, WEIGHT_TEXT,
      hookLayout: ['rules', 'defaults', 'knownCodes', 'catalog', 'error', 'saveState', 'groups', 'groupsAvailable', 'warnings', 'preview', 'loadState', 'reloadSeq'],
      // 校验口径与错误翻译（回归测试直接断言这几件）
      hydrateRules, ruleIssues, collectIssues, describeSaveFailure, FIELD_TEXT,
      MAX_RETRIES_LIMIT, MAX_RULES, MAX_TIMER_DELAY_MS, MAX_SELECTOR_CHARS,
      Page: RetryPolicyPage, RuleCard,
    };
    return module.exports;
  },
});
