#!/usr/bin/env node
/**
 * dsh-usage-stats / preview — 把真实账本渲染成**单文件 HTML**（离线可看）。
 *
 *   node preview.mjs                          # 读 $DSH_HOME/usage-stats，写 preview.html
 *   node preview.mjs --out /tmp/u.html        # 指定输出
 *   node preview.mjs --source corpus          # 忽略账本，直接折 $DSH_HOME/sessions
 *   node preview.mjs --tz Asia/Shanghai --week-start 1
 *
 * 用的是**同一份** client.js 图表代码 + 同一份 fold.js 聚合口径，
 * 所以预览里的数字与插件挂载后看到的一致；静态 HTML 不支持切页签，
 * 因此把六维（模型按「供应商×模型」成行）、三种时间图、条形/环形、
 * 速率总表（平均 TTFT / TPS）、命中率总表与详情弹窗一次全画出来。
 *
 * 模型行显示别名 + 供应商注记，`title` 属性保留「供应商 / 原始请求名」。
 * 注：`--source store` 读的是账本；改版前写入的老事实没有速率字段，
 * 那一列会显示「—」，跑一次 `node prewarm.mjs --replace` 或线上「重建全部」即可补齐。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { aggregate, foldEvents, foldLog } from './fold.js';
import { FactStore } from './store.js';
import { inheritedCutFromEvents, readLogFile, walkSessionRoot } from './rawlog.js';
import { loadMirrorIndex, normalizeSessionId } from './mesh-mirror.js';
import { loadClientCharts, renderToHtml, toHtml } from './charts-harness.mjs';
import { aliasForModel, settingsNameLookup } from './index.js';

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(name);

const HOME = os.homedir();
const ROOT = process.env.DSH_HOME || path.join(HOME, '.dsh');
const STORE_DIR = path.join(ROOT, 'usage-stats');
const OUT = value('--out', path.join(STORE_DIR, 'preview.html'));
const TZ = value('--tz', 'Asia/Shanghai');
const WEEK_START = Number(value('--week-start', '1'));
const SOURCE = value('--source', 'store');

const fmt = (n) => (typeof n === 'number' && n > 0 ? n.toLocaleString('en-US') : '0');

/** 缓存占比单元格：无实测流量时显式写出，绝不当 0% 显示；覆盖不足补「覆盖 N%」。 */
function cacheCell(row) {
  const p = row.cacheShare === null || row.cacheShare === undefined ? null : (row.cacheShare * 100).toFixed(1);
  if (p === null) return '无缓存数据';
  const cov = row.cacheCoverage;
  return p + '%' + (typeof cov === 'number' && cov < 0.9995 ? '（覆盖 ' + (cov * 100).toFixed(1) + '%）' : '');
}

/** 速率单元格：无样本显示「—」（不是 0）；单位与线上明细表一致。 */
function ttftCell(row) {
  const v = row.ttftAvg;
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) + ' s' : '—';
}
function tpsCell(row) {
  const v = row.tpsAvg;
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '—';
}

function sessionsFromStore() {
  const store = new FactStore(STORE_DIR).loadSync();
  return [...store.entries.values()].map((entry) => ({
    id: entry.id,
    meta: {
      title: entry.state.title,
      cwd: entry.header && entry.header.cwd,
      createdAt: entry.header && entry.header.createdAt,
      parentSession: entry.header && entry.header.parentSession,
      origin: entry.header && entry.header.origin,
    },
    logFacts: entry.state.logFacts,
    auxFacts: entry.state.auxFacts,
  }));
}

function sessionsFromCorpus() {
  const files = walkSessionRoot(path.join(ROOT, 'sessions'));
  // 与运行时同口径：设备网格镜像副本按来源边界排除（见 mesh-mirror.js）。
  const mirror = loadMirrorIndex(ROOT);
  const out = [];
  for (const file of files) {
    try {
      const parsed = readLogFile(file.filePath);
      const id = (parsed.header && parsed.header.id) || file.sessionId;
      const hit = mirror.byId.get(normalizeSessionId(id));
      const floor = hit !== undefined && Number.isFinite(hit.floor) ? hit.floor : -1;
      const state = foldLog(parsed.events, {
        inheritedBelow: inheritedCutFromEvents(parsed.events),
        remoteBelow: floor,
      });
      out.push({
        id,
        meta: {
          title: state.title,
          cwd: parsed.header && parsed.header.cwd,
          createdAt: parsed.header && parsed.header.createdAt,
          parentSession: parsed.header && parsed.header.parentSession,
          origin: parsed.header && parsed.header.origin,
        },
        logFacts: state.logFacts,
        auxFacts: state.auxFacts,
      });
    } catch { /* 单个日志坏了不影响整体 */ }
  }
  return out;
}

/** 离线拿不到 llm 服务：读账本 state.json 里持久化的「模型设置」名称索引。 */
function loadPersistedNames() {
  try {
    const meta = new FactStore(STORE_DIR).loadSync().meta;
    return meta.modelSettingsNames && typeof meta.modelSettingsNames === 'object'
      ? meta.modelSettingsNames
      : null;
  } catch { return null; }
}

/**
 * 标注名与运行时同一条链：config.modelAliases（离线为空）> 模型设置展示名
 * （持久化索引）> 内置表 > 兜底美化。供应商行用 displayName。
 *
 * by=model 的行键是「供应商␟请求名」复合键（同一模型多家供应商各成一行），
 * 因此查名用**拆出来的请求名 + 本行供应商**，label 再附注供应商——与
 * index.js::summaryPayload 完全一致，离线预览与线上看到的同一。
 */
function withAliases(result, names) {
  if (result.by === 'model') {
    const lookup = settingsNameLookup(names);
    const providers = (names !== null && names.providers && typeof names.providers === 'object')
      ? names.providers
      : {};
    return Object.assign({}, result, {
      rows: result.rows.map((row) => {
        const provider = typeof row.provider === 'string' ? row.provider : null;
        const requestName = typeof row.model === 'string' ? row.model : row.key;
        const settingsName = lookup(requestName, provider === null ? row.providers : [provider]) || null;
        const alias = aliasForModel(requestName, {}, settingsName === null ? undefined : settingsName);
        const dn = provider === null ? '' : String(providers[provider] || '').trim();
        const providerLabel = provider === null ? null : (dn !== '' ? dn : provider);
        // 只有**撞名**（同名挂在多家供应商下）才在显示名上注明供应商；独家模型不标注。
        const shared = row.sharedModel === true;
        return Object.assign({}, row, {
          model: requestName,
          provider,
          providerLabel,
          sharedModel: shared,
          alias,
          label: shared && providerLabel !== null ? `${alias} @ ${providerLabel}` : alias,
          settingsName,
        });
      }),
    });
  }
  if (result.by === 'provider') {
    const providers = (names !== null && names.providers && typeof names.providers === 'object')
      ? names.providers
      : {};
    return Object.assign({}, result, {
      rows: result.rows.map((row) => {
        const name = typeof providers[row.key] === 'string' ? providers[row.key].trim() : '';
        return Object.assign({}, row, { label: name !== '' ? name : row.key });
      }),
    });
  }
  return result;
}

function block(title, note, body) {
  return `<section class="pv-block"><h2>${title}</h2>${note ? `<p class="pv-note">${note}</p>` : ''}${body}</section>`;
}

/** **用量表**：只有 token 数值与缓存占比（速率一律在下面的独立速率表里，两区互不混列）。 */
function tableHtml(result, timeDim) {
  const head = ['键', '调用', '输入', '输出', '缓存读', '缓存写', '推理', '总计', '缓存占比', '会话', '占比'];
  const maxShare = result.rows.reduce((m, r) => Math.max(m, r.share || 0), 0) || 1;
  const rows = result.rows.map((row) => {
    // 模型维副行：只有**撞名**（同名多家供应商）才标「供应商 · 请求名」；独家模型只给请求名。
    // 绝不把带分隔符的复合键画到页面上。
    const sub = row.sharedModel === true && row.provider
      ? `${row.providerLabel || row.provider} · ${row.model || ''}`
      : (row.model ? row.model : (row.providers ? row.providers.join(', ') : ''));
    const meta = sub ? `<div class="ust-meta">${sub}</div>` : '';
    const tip = row.provider ? `${row.provider} / ${row.model}` : (row.model || row.key);
    return `<tr><td class="l"><div class="ust-key" title="${tip}">${row.label || row.key}</div>${meta}</td>`
      + [row.calls, row.input, row.output, row.cacheRead, row.cacheWrite, row.reasoning, row.total]
          .map((v) => `<td>${fmt(v)}</td>`).join('')
      + `<td>${cacheCell(row)}</td>`
      + `<td>${fmt(row.sessions)}</td>`
      + `<td><span class="ust-share" style="width:${Math.max(2, Math.round(((row.share || 0) / maxShare) * 64))}px"></span></td></tr>`;
  }).join('');
  return `<div class="ust-table-wrap"><table class="ust-table"><thead><tr>`
    + head.map((t, i) => `<th${i === 0 ? ' class="l"' : ''}>${timeDim && i === 0 ? '日期' : t}</th>`).join('')
    + `</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/**
 * **速率表**（独立于用量表，与线上「速率区」同构）：只有速率列。
 * 无样本一律「—」，不当 0；剔除列 = 被上界（5 分钟）裁掉的样本条数。
 */
function rateTableHtml(result) {
  const head = ['键', '调用', '样本', '平均TTFT', '中位TTFT', '最快/最慢TTFT', '平均TPS', '逐条均值TPS', '中位TPS', '剔除'];
  const rows = result.rows.map((row) => {
    const sub = row.sharedModel === true && row.provider
      ? `<div class="ust-meta">${row.providerLabel || row.provider} · ${row.model || ''}</div>`
      : (row.model ? `<div class="ust-meta">${row.model}</div>` : '');
    const sec = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) + ' s' : '—');
    const tps = (v) => (typeof v === 'number' && Number.isFinite(v) ? (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' tok/s' : '—');
    const excluded = (row.ttftExcluded || 0) + (row.tpsExcluded || 0);
    return `<tr><td class="l"><div class="ust-key" title="${row.provider ? row.provider + ' / ' + row.model : row.key}">${row.label || row.key}</div>${sub}</td>`
      + `<td>${fmt(row.calls)}</td>`
      + `<td>${fmt(row.ttftSamples)}</td>`
      + `<td>${sec(row.ttftAvg)}</td>`
      + `<td>${sec(row.ttftMedian)}</td>`
      + `<td>${sec(row.ttftMin)} / ${sec(row.ttftMax)}</td>`
      + `<td>${tps(row.tpsAvg)}</td>`
      + `<td>${tps(row.tpsMean)}</td>`
      + `<td>${tps(row.tpsMedian)}</td>`
      + `<td>${excluded > 0 ? fmt(excluded) : '0'}</td></tr>`;
  }).join('');
  return `<div class="ust-table-wrap"><table class="ust-table"><thead><tr>`
    + head.map((t, i) => `<th${i === 0 ? ' class="l"' : ''}>${t}</th>`).join('')
    + `</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function main() {
  const sessions = SOURCE === 'corpus' ? sessionsFromCorpus() : sessionsFromStore();
  const useCorpus = sessions.length === 0;
  const data = useCorpus ? sessionsFromCorpus() : sessions;
  if (data.length === 0) {
    process.stdout.write('没有会话数据：账本为空且 sessions 目录无日志。\n');
    process.exitCode = 1;
    return;
  }

  const { charts } = loadClientCharts();
  const { TimeChart, HBars, Donut, HoverLine, Legend, CacheBars, CacheDetail, RatePanel, css } = charts;
  const names = loadPersistedNames();
  const nameSource = names !== null
    ? `模型设置名称索引（state.json 持久化，${Object.keys(names.byModel || {}).length} 个模型 · ${Object.keys(names.providers || {}).length} 个供应商）`
    : '无模型设置索引（未持久化或账本为空）→ 内置表/兜底美化';
  const agg = (by) => withAliases(aggregate(data, { by, timeZone: TZ, weekStart: WEEK_START }), names);

  const byModel = agg('model');
  const byProvider = agg('provider');
  const bySession = agg('session');
  const byDay = agg('day');
  const byWeek = agg('week');
  const totals = byModel.totals;

  const dayChart = (mode) => renderToHtml(TimeChart, {
    rows: byDay.rows, mode, hoverIndex: null, onHover: () => {},
  });
  const weekChart = (mode) => renderToHtml(TimeChart, {
    rows: byWeek.rows, mode, hoverIndex: null, onHover: () => {},
  });

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 用量统计 · 离线预览</title>
<style>
:root{--dsw-alias-bg-base:#0f1115;--dsw-alias-bg-layer-1:#161a21;--dsw-alias-bg-layer-2:#1d222b;
--dsw-alias-border-l1:#2a3038;--dsw-alias-border-l2:#3a424d;--dsw-alias-brand-primary:#4c8df6;
--dsw-alias-label-primary:#e6e9ee;--dsw-alias-label-secondary:#9aa4b2;--dsw-alias-state-error-primary:#e5657a;
--dsw-alias-state-success-primary:#2fb98a;}
*{box-sizing:border-box}
body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.pv-wrap{max-width:1180px;margin:0 auto;padding:24px 16px 64px;display:flex;flex-direction:column;gap:18px}
h1{font-size:19px;margin:0}
h2{font-size:14px;margin:0 0 8px}
.pv-note{margin:0 0 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
/* 弹窗在线上是 fixed 覆盖层；离线预览把它降级为页内一块，别盖住整页。 */
.pv-modalscope .ust-overlay{position:relative;inset:auto;z-index:auto;background:none;padding:0}
.pv-block{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);
padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.pv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:14px}
.ust{display:flex;flex-direction:column;gap:10px}
.ust-chart-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);
padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.ust-chart-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.ust-chart-title{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}
${css}
</style></head>
<body><div class="pv-wrap">
<h1>DSH 用量统计 · 离线预览</h1>
<p class="pv-note">数据源：${useCorpus ? '会话日志直折' : '账本 ' + STORE_DIR} · ${data.length} 个会话 ·
时区 ${TZ} · 周起始 ${WEEK_START === 1 ? '周一' : '周日'} · 生成于 ${new Date().toLocaleString()} ·
标注名：${nameSource}；<b>鼠标停在名称上可看到原始请求名</b>（模型的副行也直接显示请求名）</p>

<div class="ust">
  <div class="ust-cards">
    <div class="ust-card"><div class="ust-card-k">总 token</div><div class="ust-card-v">${(totals.total / 1e9).toFixed(2)}B</div></div>
    <div class="ust-card"><div class="ust-card-k">调用次数</div><div class="ust-card-v">${fmt(totals.calls)}</div></div>
    <div class="ust-card"><div class="ust-card-k">会话数</div><div class="ust-card-v">${fmt(totals.sessions)}</div></div>
    <div class="ust-card"><div class="ust-card-k">缓存占比（合计）</div><div class="ust-card-v">${cacheCell(totals)}</div></div>
    <div class="ust-card"><div class="ust-card-k">模型条目（供应商×模型）</div><div class="ust-card-v">${fmt(byModel.rows.length)}</div></div>
    <div class="ust-card"><div class="ust-card-k">供应商</div><div class="ust-card-v">${fmt(byProvider.rows.length)}</div></div>
  </div>
</div>

${block('每日用量 · 堆叠柱状图（输入 / 输出 / 缓存读 / 缓存写）', '', `<div class="ust-chart-card"><div class="ust-chart-head"><div class="ust-chart-title">每日（${byDay.rows.length} 天）</div>${toHtml(Legend())}</div>${dayChart('bar')}</div>`)}
${block('每日用量 · 折线趋势 / 累计', '', `<div class="pv-grid">`
  + `<div class="ust-chart-card"><div class="ust-chart-head"><div class="ust-chart-title">折线（每日总量）</div></div>${dayChart('line')}</div>`
  + `<div class="ust-chart-card"><div class="ust-chart-head"><div class="ust-chart-title">累计（面积）</div></div>${dayChart('cum')}</div>`
  + `</div>`)}
${block('每周用量', '', `<div class="pv-grid">`
  + `<div class="ust-chart-card"><div class="ust-chart-head"><div class="ust-chart-title">每周（${byWeek.rows.length} 周）</div>${toHtml(Legend())}</div>${weekChart('bar')}</div>`
  + `<div class="ust-chart-card"><div class="ust-chart-head"><div class="ust-chart-title">折线</div></div>${weekChart('line')}</div>`
  + `</div>`)}

${block('模型 · Top 20 横向条形图 + 别名', '条内按 输入/输出/缓存读/缓存写 堆叠（**只有用量**）；副行只在**撞名模型**（同名挂在多家供应商下）上标「供应商 · 原始请求名」，独家模型不标注',
    `<div class="ust-chart-card"><div class="ust-chart-head"><div class="ust-chart-title">模型条目（供应商×模型，${byModel.rows.length} 个）</div>${toHtml(Legend())}</div>${renderToHtml(HBars, { rows: byModel.rows, limit: 20 })}</div>`)}
${block('模型 · 环形占比（Top 8 + 其它）', '', `<div class="ust-chart-card">${renderToHtml(Donut, { rows: byModel.rows, limit: 8 })}</div>`)}
${block('命中率总表（逐项 · 线上是可选项）', '每项自己的实测占比 = 缓存读+写 / 可测计费输入（只含有缓存字段的流量）；「覆盖 N%」标出有多少计费输入带缓存字段，「无缓存数据」= 该路由从不上报缓存字段。线上默认不铺开，点名称看单项弹窗（下面是静态预览出来的样子）',
    renderToHtml(CacheBars, { rows: byModel.rows, limit: 20, title: '命中率总表（模型条目 逐项）' }))}
${block('命中率详情弹窗（点模型名称打开）', '线上是覆盖层弹窗：点明细表或总表里的名称打开，点背景 / 「关闭」/ Esc 收起。离线预览没有交互，这里把第一名的弹窗静态画出来（并把它从 fixed 降级到页内）',
    '<div class="pv-modalscope">' + renderToHtml(CacheDetail, { row: byModel.rows[0], by: 'model', dimName: '模型' }) + '</div>')}
${block('速率区 · 模型条目（与用量区**完全分区**：这里只有速率列，不掺 token 数）',
    '**分组规则与用量区完全一致**：同一批「供应商␟模型」条目，逐条各算自己的平均 TTFT / TPS；'
    + '只有展示名会撞车的条目才注明供应商。'
    + 'TTFT = 首个内容时刻 − 请求起始时刻（step/start，重试取最后一条 retry-started）；TPS = Σ输出tokens / Σ生成时长（聚合口径，按耗时加权；逐条算术均值与中位数并列给出）。'
    + '生成 &lt; 500 ms 或输出 &lt; 32 tokens 的调用不进 TPS 样本；TTFT/生成时长 &gt; 5 分钟的点不进均值（会话挂起/接手留下的污染），剔除条数如实标出。「—」= 无数据，不是 0。',
    renderToHtml(RatePanel, { rows: byModel.rows, limit: 50, totals: byModel.totals, by: 'model', title: '速率 · 模型条目（平均 TTFT / TPS）' }))}
${block('供应商', '', `<div class="pv-grid">`
  + `<div class="ust-chart-card">${renderToHtml(HBars, { rows: byProvider.rows, limit: 20 })}</div>`
  + `<div class="ust-chart-card">${renderToHtml(Donut, { rows: byProvider.rows, limit: 8 })}</div>`
  + `</div>`)}
${block('会话 · Top 20', '标题为会话名；副行为工作目录与标记', `<div class="ust-chart-card">${renderToHtml(HBars, { rows: bySession.rows, limit: 20 })}</div>`)}
${block('每日明细', '', tableHtml(byDay, true))}
${block('模型明细（用量）', '第一列显示别名；**只有撞名模型**（同名挂在多家供应商下）才在名称与副行注明供应商，独家模型不标注。本表不含速率列——速率看上面的「速率区」', tableHtml(byModel, false))}
<p class="pv-note">本页由 <code>preview.mjs</code> 用 client.js 的同一份图表代码静态渲染；
插件挂载后（重启 dsh）设置页还有页签、时间范围、子代理归属切换与实时刷新。</p>
</div></body></html>`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  process.stdout.write(`预览已写入 ${OUT}\n`);
  process.stdout.write(`  ${data.length} 会话 · ${(totals.total / 1e9).toFixed(2)}B tokens · ${fmt(totals.calls)} 次调用`
    + ` · 模型条目（供应商×模型）${byModel.rows.length} · 供应商 ${byProvider.rows.length} · ${byDay.rows.length} 天 / ${byWeek.rows.length} 周`
    + ` · 缓存占比 ${cacheCell(totals)} · 缓存读 ${(totals.cacheRead / 1e6).toFixed(1)}M / 计费输入 ${(totals.billedInput / 1e6).toFixed(1)}M\n`);
  // 速率（复合键 r.key 含分隔符，示例一律打印拆分值，不打印原始 key）
  process.stdout.write(`  速率：平均 TTFT ${ttftCell(totals)} · 平均 TPS ${tpsCell(totals)}`
    + `（TTFT 样本 ${fmt(totals.ttftSamples)} / ${fmt(totals.calls)} 次调用`
    + (totals.ttftExcluded > 0 ? ` · 剔除 ${fmt(totals.ttftExcluded)} 条超 5 分钟污染点` : '')
    + `；TPS 样本 ${fmt(totals.tpsSamples)}）\n`);
  process.stdout.write(`  标注名来源：${nameSource}\n`);
  process.stdout.write(`  模型标注示例：${byModel.rows.slice(0, 3).map((r) => `${r.provider || '?'}/${r.model || '?'} → ${r.label}`).join(' · ')}\n`);
}

main();