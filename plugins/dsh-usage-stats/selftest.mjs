#!/usr/bin/env node
/**
 * dsh-usage-stats / selftest — 基于【本机真实环境】的模拟测试。
 *
 *   node selftest.mjs            # 全跑（语料很大时会吃内存：1840 会话实测 >4.5 GB）
 *   node selftest.mjs --quick    # 跳过全语料扫描（只跑合成 + 抽样 12 个真实会话）
 *   node selftest.mjs --limit 200 # 只抽样 200 个会话跑 B~E 段（省内存的全链路）
 *
 * 段：
 *   A 合成用例  —— 折叠口径 / 幂等 / 增量 / fork 前缀 / 时区与周边界 / 聚合互等
 *   B 真实语料  —— 用 rawlog 解码 ~/.dsh/sessions 全部会话，与「独立重算」对账，
 *                  并对五维聚合做互等校验
 *   C 归档 zip  —— python3 造 zip（deflate + store 两种），验证归档导入路径
 *   D 假环境    —— 用真实语料桩住 sessionQuery/sessionPersistence/webServer，
 *                  跑 createUsageStats：回填 → 路由 → 实时事件 → llm/stream 补记
 *                  → 重复回填幂等 → 语料升格不双计
 *   F 网格镜像  —— 执行端 sessions/ 里对端会话副本按来源边界排除（合成语料，恒跑）：
 *                  纯副本不计 / 本机远程工作区照常计 / 接手后续跑照常计 / sender 游标
 *                  不作依据 / 幂等 / 边界变化重折 / 开关与坏索引的安全退化 / 持久化往返
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import * as fold from './fold.js';
import * as rawlog from './rawlog.js';
import * as indexApi from './index.js';
import { FactStore } from './store.js';
import { classesUsed, findAll, loadClientCharts, nonFiniteNumbers, toHtml, walk } from './charts-harness.mjs';

const { createUsageStats } = indexApi;

/** 元素树里的全部文本（断言 UI 文案用；walk 只看节点，这里再取字符串子节点）。 */
function treeText(root) {
  const parts = [];
  walk(root, (n) => {
    const kids = (n.props && n.props.children) || [];
    for (const c of Array.isArray(kids) ? kids : [kids]) {
      if (typeof c === 'string' || typeof c === 'number') parts.push(String(c));
    }
  });
  return parts.join(' ');
}

const QUICK = process.argv.includes('--quick');
/** `--limit N`：只抽样 N 个会话跑 B~E 段。语料超过 ~1000 会话时全量会把全部事件常驻内存
 *  （1840 会话实测 >4.5 GB），本机 7 GB 会被打爆 —— 要跑全链路但不想 OOM 就用它；
 *  F 段（网格镜像）是合成语料，不受 limit 影响。 */
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
})();
const HOME = os.homedir();
const DSH = process.env.DSH_HOME || path.join(HOME, '.dsh');
const SESSIONS_ROOT = path.join(DSH, 'sessions');

let passed = 0;
const failures = [];
const notes = [];

function section(title) { process.stdout.write(`\n== ${title} ==\n`); }

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  \u2713 ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    const detail = error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n      ') : String(error);
    process.stdout.write(`  \u2717 ${name}\n      ${detail}\n`);
  }
}

const ev = (seq, type, data, time) => ({ type, seq, time, data });

/* ------------------------------------------------------------------ A ---- */

const T0 = Date.UTC(2026, 9, 7, 16, 30); // 2026-10-07T16:30Z = 上海 2026-10-08 00:30

function syntheticLog() {
  return [
    ev(0, 'request/header', { header: { config: { provider: 'p1', model: 'm1' } } }, T0),
    ev(1, 'assistant/message', { usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }, T0 + 1000),
    ev(2, 'assistant/message', { stream: [] }, T0 + 2000), // 被打断，无 usage
    ev(3, 'assistant/attempt', {
      stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } } }],
    }, T0 + 3000),
    ev(4, 'request/header', { header: { config: { provider: 'p2', model: 'm2' } } }, T0 + 4000),
    ev(5, 'assistant/message', { usage: { inputTokens: 7, outputTokens: 3 } }, T0 + 5000),
    ev(6, 'compaction/summary', {
      provider: 'p3', model: 'm3',
      usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 20, totalTokens: 1070 },
    }, T0 + 6000),
    ev(7, 'session/title', { title: '合成会话' }, T0 + 7000),
    ev(8, 'web/deepseek-search-llm-request', { endpoint: '/x' }, T0 + 8000),
  ];
}

async function sectionA() {
  section('A 合成用例（折叠口径 / 幂等 / 边界）');

  await test('mixedTotal：有总账用总账，否则四项相加', () => {
    assert.equal(fold.mixedTotal({ inputTokens: 100, outputTokens: 10, totalTokens: 110 }), 110);
    assert.equal(fold.mixedTotal({ inputTokens: 5, outputTokens: 1 }), 6);
    assert.equal(fold.mixedTotal({ inputTokens: 5, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 }), 11);
    assert.equal(fold.mixedTotal({ totalTokens: 999, inputTokens: 1 }), 999);
    assert.equal(fold.mixedTotal(null), 0);
  });

  await test('折叠：消息/尝试/压缩三类事实 + 路由跟随 + 缺口计数', () => {
    const state = fold.foldLog(syntheticLog());
    assert.equal(state.logFacts.length, 4, 'step + attempt + step + compaction');
    assert.deepEqual(state.logFacts.map((f) => f.k), ['step', 'attempt', 'step', 'compaction']);
    assert.deepEqual(state.logFacts.map((f) => f.p), ['p1', 'p1', 'p2', 'p3'], '中途换供应商要跟随');
    assert.deepEqual(state.logFacts.map((f) => f.m), ['m1', 'm1', 'm2', 'm3']);
    assert.equal(state.logFacts[0].tt, 110);
    assert.equal(state.logFacts[1].tt, 6);
    assert.equal(state.logFacts[2].tt, 10);
    assert.equal(state.logFacts[3].tt, 1070);
    assert.equal(state.logFacts[3].cr, 20, '压缩调用带缓存读');
    assert.equal(state.title, '合成会话');
    assert.equal(state.gaps.noUsageMessages, 1, '被打断的消息只进缺口');
    assert.equal(state.gaps.searchRequests, 1, '联网搜索记账为缺口');
    assert.equal(state.lastSeq, 8);
  });

  await test('幂等：同一日志折两次结果完全一致', () => {
    const events = syntheticLog();
    const a = fold.foldLog(events);
    const b = fold.foldLog(events, { seed: { lastSeq: a.lastSeq, route: a.route, title: a.title, logFacts: a.logFacts } });
    assert.equal(b.logFacts.length, a.logFacts.length);
    assert.deepEqual(b.logFacts, a.logFacts);
  });

  await test('增量：折前缀再折剩余 == 一次折完', () => {
    const all = syntheticLog();
    const state = fold.foldLog(all.slice(0, 5));
    fold.foldEvents(state, all.slice(5));
    const once = fold.foldLog(all);
    assert.deepEqual(state.logFacts, once.logFacts);
    assert.equal(state.lastSeq, once.lastSeq);
  });

  await test('fork 前缀：继承段只承接路由，不产生事实', () => {
    const state = fold.foldLog(syntheticLog(), { inheritedBelow: 4 });
    assert.equal(state.logFacts.length, 2, '只保留 seq>=4 的两条');
    assert.deepEqual(state.logFacts.map((f) => f.p), ['p2', 'p3']);
    assert.equal(state.gaps.noUsageMessages, 0, '继承段里的缺口不计');
  });

  await test('时区：同一时刻在上海是次日、在 UTC 是当日', () => {
    assert.equal(fold.dayKey(T0, 'Asia/Shanghai'), '2026-10-08');
    assert.equal(fold.dayKey(T0, 'UTC'), '2026-10-07');
  });

  await test('周边界：weekStart 全时段对齐且不超过 7 天', () => {
    for (const weekStart of [0, 1]) {
      for (const day of ['2026-09-26', '2026-10-04', '2026-10-08', '2026-01-01', '2025-12-31']) {
        const wk = fold.weekKey(day, weekStart);
        assert.equal(new Date(`${wk}T00:00:00Z`).getUTCDay(), weekStart, `${day} 的周键应是 weekStart=${weekStart}`);
        assert.ok(wk <= day, '周键不能晚于当日');
        const span = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${wk}T00:00:00Z`)) / 86400000;
        assert.ok(span >= 0 && span <= 6, `跨度 ${span} 天`);
      }
    }
    assert.equal(fold.weekKey('2026-10-08', 1), '2026-10-05', '2026-10-08 是周四 → 周一 10-05');
  });

  await test('range 起始键：1d/7d/30d/all', () => {
    const now = Date.UTC(2026, 9, 8, 12, 0);
    assert.equal(fold.rangeStartKey('1d', now, 'Asia/Shanghai'), '2026-10-08');
    assert.equal(fold.rangeStartKey('7d', now, 'Asia/Shanghai'), '2026-10-02');
    assert.equal(fold.rangeStartKey('30d', now, 'Asia/Shanghai'), '2026-09-09');
    assert.equal(fold.rangeStartKey('all', now, 'Asia/Shanghai'), null);
  });

  await test('聚合：五维 totals 互等，时间维按时间排序', () => {
    const state = fold.foldLog(syntheticLog());
    const sessions = [{ id: 's1', meta: { title: 'A' }, logFacts: state.logFacts, auxFacts: [] }];
    const dims = ['model', 'provider', 'session', 'day', 'week'];
    const results = dims.map((by) => fold.aggregate(sessions, { by, timeZone: 'Asia/Shanghai', weekStart: 1 }));
    const grand = results[0].totals.total;
    assert.ok(grand > 0);
    for (const r of results) assert.equal(r.totals.total, grand, `${r.by} 维度总计应一致`);
    assert.equal(results[0].rows.length, 3, '三个模型');
    const days = results[3].rows.map((r) => r.key);
    assert.deepEqual(days, [...days].sort(), '日期升序');
  });

  await test('聚合：子代理归到根会话（attributeSubagents=root）', () => {
    const parent = { id: 'root', meta: {}, logFacts: [fold.makeFact('step', T0, 'p', 'm', { inputTokens: 1 })], auxFacts: [] };
    const child = { id: 'kid', meta: { parentSession: 'root' }, logFacts: [fold.makeFact('step', T0, 'p', 'm', { inputTokens: 2 })], auxFacts: [] };
    const own = fold.aggregate([parent, child], { by: 'session', timeZone: 'UTC' });
    const rolled = fold.aggregate([parent, child], { by: 'session', timeZone: 'UTC', attributeSubagents: 'root' });
    assert.equal(own.rows.length, 2);
    assert.equal(rolled.rows.length, 1);
    assert.equal(rolled.rows[0].key, 'root');
    assert.equal(rolled.rows[0].total, 3);
  });

  await test('缓存占比：逐项计算 + 实测占比/覆盖度（未上报流量不摊进分母）', () => {
    const T = Date.UTC(2026, 9, 8, 0, 0);
    const mk = (model, usages) => {
      const events = [{ seq: 0, type: 'request/header', data: { header: { config: { provider: 'p', model } } }, time: T }];
      usages.forEach((usage, i) => events.push({ seq: i + 1, type: 'assistant/message', data: { usage }, time: T }));
      const st = fold.foldLog(events);
      return { id: model, meta: {}, logFacts: st.logFacts, auxFacts: [] };
    };
    // 四项：强缓存 / 完全没有缓存字段（老日志或不上报的路由）/ 写了缓存 /
    // **混合项**（同一项里既有上报的事实又有不上报的事实——最容易算错的一种）
    const sessions = [
      mk('hit', [{ inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 }]),
      mk('old', [{ inputTokens: 500, outputTokens: 20 }]),
      mk('write', [{ inputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 50, outputTokens: 30 }]),
      mk('mixed', [
        { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 },   // 可测：命中率 90%
        { inputTokens: 1000, outputTokens: 10 },                        // 不上报：不能假设成未命中
        { inputTokens: 1000, outputTokens: 10 },                        // 同上
      ]),
    ];
    const res = fold.aggregate(sessions, { by: 'model', timeZone: 'UTC', weekStart: 1 });
    const row = (k) => res.rows.find((r) => r.key === k);

    // 单一口径：占比 = 缓存读+写 / 可测计费输入，逐项各自算
    assert.equal(row('hit').cacheShare, 900 / 1000, 'hit：900 /（100+900）');
    assert.equal(row('write').cacheShare, 150 / 350, 'write：（100+50）/（200+100+50）');
    assert.equal(row('hit').cacheCoverage, 1, '全量可测时覆盖度 = 1');
    assert.equal(row('old').cacheShare, null, '没有缓存字段 → null（不是 0%）');
    assert.equal(row('old').cacheKnown, false);
    assert.equal(row('old').cacheCoverage, 0, '完全不可测 → 覆盖度 0');
    assert.equal(row('hit').cacheFacts, 1, '带缓存字段的事实条数');
    assert.equal(row('old').cacheFacts, 0);

    // **混合项**：实测命中率必须只按可测流量算 —— 若把不上报的 2000 tokens 当「未命中」
    // 摊进分母，会得到 900/3000 = 30%，把真实的 90% 谎报成 30%（这正是对抗验证抓到的缺陷）。
    assert.equal(row('mixed').cacheShare, 900 / 1000, '混合项：占比只用可测流量（否则会谎报 30%）');
    assert.equal(row('mixed').cacheCoverage, 1000 / 3000, '混合项：覆盖度 = 可测/全部');
    assert.equal(row('mixed').cacheUnknownInput, 2000, '未上报缓存状态的计费输入');
    assert.equal(row('mixed').cacheKnown, true);

    // 逐项口径 ≠ 总量口径：总量是各行的合计，不能拿来当某一项的占比
    const totalShare = res.totals.cacheShare;
    assert.ok(totalShare > 0 && totalShare < 1, `总量占比应落在 (0,1)：${totalShare}`);
    assert.notEqual(totalShare, row('hit').cacheShare, '逐项占比不得等于总量占比（检查是否误用总量口径）');
    assert.equal(res.totals.cacheKnown, true);
    assert.equal(res.totals.cacheFacts, 3, '三条事实带缓存字段');
    // 总量也要遵守同一口径：可测分母 = hit 1000 + write 350 + mixed 的可测 1000 = 2350
    //（old 完全没有缓存字段，不进分母；mixed 里两条不上报的 2000 也不进）
    const measured = 1000 + 350 + 1000;
    assert.equal(res.totals.cacheShare, (900 + 150 + 900) / measured, '总量同样是实测口径');
    assert.equal(res.totals.cacheCoverage, measured / res.totals.billedInput);

    // pct() 展示助手：null → null（交给调用方显示「无缓存数据」）
    assert.equal(fold.pct(0.9444), '94.4');
    assert.equal(fold.pct(null), null);

    // 老账本兼容：v6 之前写入的事实没有 cacheKnown 字段，不能整批被误判成「无缓存数据」。
    const legacy = (cr, cw) => ({
      logFacts: [{ t: T, k: 'step', p: 'p', m: 'legacy', it: 100, ot: 1, cr, cw, rt: 0, tt: 101 + cr + cw }],
      auxFacts: [],
    });
    const legacyHit = fold.aggregate(
      [{ id: 'legacy', meta: {}, ...legacy(900, 0) }], { by: 'model', timeZone: 'UTC' },
    ).rows[0];
    assert.equal(legacyHit.cacheShare, 900 / 1000, '老事实有非零缓存读 → 按有缓存数据处理');
    const legacyZero = fold.aggregate(
      [{ id: 'legacy0', meta: {}, ...legacy(0, 0) }], { by: 'model', timeZone: 'UTC' },
    ).rows[0];
    assert.equal(legacyZero.cacheShare, null, '老事实缓存全 0 且无标记 → 未知（null），不谎报 0%');
    assert.equal(fold.factCacheKnown({ cr: 5, cw: 0 }), true, '缺标记但有非零值 → 有缓存数据');
    assert.equal(fold.factCacheKnown({ cr: 0, cw: 0 }), false, '缺标记且全 0 → 未知');
    assert.equal(fold.factCacheKnown({ cr: 0, cw: 0, cacheKnown: true }), true, '显式标记优先');
    assert.equal(fold.factCacheKnown({ cr: 9, cw: 0, cacheKnown: false }), false, '显式 false 优先');

    // 「有缓存字段但命中 0」必须是真实的 0（不是 null），与「没有字段」区分开
    const zeroRow = mk('zero', [{ inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }]);
    const zero = fold.aggregate([zeroRow], { by: 'model', timeZone: 'UTC' }).rows[0];
    assert.equal(zero.cacheShare, 0, '有字段、命中 0 → 真实 0%');
    assert.equal(zero.cacheKnown, true);
    assert.equal(zero.cacheCoverage, 1);
  });

  await test('缓存占比：分组维度同样逐项（by=group 走同一口径）', () => {
    const T = Date.UTC(2026, 9, 8, 0, 0);
    const mk = (model, usage) => {
      const st = fold.foldLog([
        { seq: 0, type: 'request/header', data: { header: { config: { provider: 'p', model } } }, time: T },
        { seq: 1, type: 'assistant/message', data: { usage }, time: T },
      ]);
      return { id: model, meta: {}, logFacts: st.logFacts, auxFacts: [] };
    };
    const sessions = [
      mk('a1', { inputTokens: 100, cacheReadTokens: 900, outputTokens: 1 }),
      mk('a2', { inputTokens: 100, cacheReadTokens: 100, outputTokens: 1 }),
      mk('b1', { inputTokens: 500, outputTokens: 1 }),
    ];
    const groups = { a1: 'GA', a2: 'GA', b1: 'GB' };
    const res = fold.aggregate(sessions, {
      by: 'group',
      timeZone: 'UTC',
      groupOf: (p, m) => groups[m] || null,
      groupLabels: { GA: '甲组', GB: '乙组' },
      ungroupedKey: '__ungrouped__',
      ungroupedLabel: '未分组',
    });
    assert.equal(res.by, 'group');
    const ga = res.rows.find((r) => r.key === 'GA');
    const gb = res.rows.find((r) => r.key === 'GB');
    assert.equal(ga.label, '甲组');
    assert.equal(ga.cacheShare, 1000 / 1200, '整组只算一组：可测分母 = (100+900)+(100+100)');
    assert.equal(ga.cacheCoverage, 1);
    assert.equal(gb.cacheShare, null, '整组都不上报 → null');
    assert.deepEqual(gb.providers, ['p']);
  });

  await test('实时补记：aux 事实独立于日志游标，重折不丢', () => {
    const state = fold.foldLog(syntheticLog());
    fold.addAuxFact(state, { purpose: 'session-title', provider: 'p9', model: 'm9', usage: { inputTokens: 42, outputTokens: 2 }, time: T0 });
    assert.equal(state.auxFacts.length, 1);
    assert.equal(state.auxFacts[0].u, 'session-title');
    // 模拟「重建全部」：清日志事实但保留 aux
    state.logFacts = [];
    state.lastSeq = -1;
    fold.foldEvents(state, syntheticLog());
    assert.equal(state.auxFacts.length, 1, 'aux 必须保留');
    assert.equal(state.logFacts.length, 4);
  });

  await test('rawlog：zstd 帧扫描能解出多帧拼接的日志', () => {
    const frames = ['{"type":"session","id":"z1"}\n', '{"type":"a","seq":0}\n', '{"type":"b","seq":1}\n']
      .map((t) => zlib.zstdCompressSync(Buffer.from(t, 'utf8')));
    const buf = Buffer.concat(frames);
    const text = rawlog.decodeLogBytes(buf);
    assert.equal(text, '{"type":"session","id":"z1"}\n{"type":"a","seq":0}\n{"type":"b","seq":1}\n');
    const parsed = rawlog.parseLogText(text);
    assert.equal(parsed.header.id, 'z1');
    assert.equal(parsed.events.length, 2);
    // 整块解压只出第一帧（这正是必须逐帧扫描的原因）
    assert.ok(zlib.zstdDecompressSync(buf).length < text.length);
  });
}

/* ------------------------------------------------------------------ B ---- */

function loadCorpus(limit) {
  const files = rawlog.walkSessionRoot(SESSIONS_ROOT);
  // 同一会话目录里可能两代日志并存（v3 + v4 同目录，实测本机 95 处）。出厂读**最高世代**，
  // 这里同样每个 session id 只留一份：否则同一条会话会在语料里出现两次，D 段按 id 去重的
  // 账本（entries 是 Map）就与「语料条数」对不上——那是语料桩的假失败，不是插件缺陷。
  const byId = new Map();
  for (const file of files) {
    const gen = Number((/\.v(\d+)\.jsonl(?:\.zstd)?$/.exec(file.filePath) || [])[1] || 0);
    const prev = byId.get(file.sessionId);
    if (prev === undefined) byId.set(file.sessionId, { file, gen, duplicates: 0 });
    else {
      prev.duplicates += 1;
      if (gen > prev.gen) { prev.file = file; prev.gen = gen; }
    }
  }
  const unique = [...byId.values()];
  const picked = (limit ? unique.slice(0, limit) : unique).map((item) => item.file);
  const duplicateFiles = unique.reduce((a, item) => a + item.duplicates, 0);
  const out = [];
  const errors = [];
  let bytes = 0;
  for (const file of picked) {
    try {
      const stat = fs.statSync(file.filePath);
      bytes += stat.size;
      const parsed = rawlog.readLogFile(file.filePath);
      const id = (parsed.header && typeof parsed.header.id === 'string' && parsed.header.id) || file.sessionId;
      out.push({
        id, filePath: file.filePath, header: parsed.header, events: parsed.events,
        badLines: parsed.badLines, sizeBytes: stat.size,
      });
    } catch (error) {
      errors.push({ file: file.filePath, error: String(error && error.message ? error.message : error) });
    }
  }
  return { sessions: out, fileCount: files.length, duplicateFiles, bytes, errors };
}

/** 独立重算：不复用 fold.js 的另一条代码路径，用于对账。 */
function naiveRecount(events, inheritedBelow = 0) {
  let steps = 0, attempts = 0, compactions = 0, noUsage = 0, search = 0;
  let total = 0, input = 0, output = 0;
  for (const e of events) {
    if (!e || typeof e.seq !== 'number' || e.seq < inheritedBelow) continue;
    if (e.type === 'assistant/message') {
      const u = e.data && e.data.usage;
      if (!u) { noUsage++; continue; }
      steps++;
      input += u.inputTokens || 0;
      output += u.outputTokens || 0;
      total += typeof u.totalTokens === 'number' ? u.totalTokens
        : (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
    } else if (e.type === 'assistant/attempt') {
      const stream = (e.data && e.data.stream) || [];
      let u = null;
      for (let i = stream.length - 1; i >= 0; i--) {
        const r = stream[i];
        if (r && r.type === 'chunk' && r.chunk && r.chunk.type === 'usage' && r.chunk.usage) { u = r.chunk.usage; break; }
      }
      if (!u) continue;
      attempts++;
      total += typeof u.totalTokens === 'number' ? u.totalTokens
        : (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
    } else if (e.type === 'compaction/summary') {
      const u = e.data && e.data.usage;
      if (!u) continue;
      compactions++;
      total += typeof u.totalTokens === 'number' ? u.totalTokens
        : (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
    } else if (e.type === 'web/deepseek-search-llm-request') search++;
  }
  return { steps, attempts, compactions, noUsage, search, total, input, output };
}

async function sectionB(corpus) {
  section('B 真实语料对账（本机 sessions 全量）');
  notes.push(`语料：${corpus.fileCount} 个日志文件 / ${(corpus.bytes / 1048576).toFixed(1)} MB（压缩态）/ 解码 ${corpus.sessions.length} 会话`
    + (corpus.duplicateFiles > 0 ? `（另有 ${corpus.duplicateFiles} 份同会话的低世代日志，按最高世代去重）` : ''));

  await test('解码：全部日志无解析错误，且每条用量事件都带 time', () => {
    assert.equal(corpus.errors.length, 0, JSON.stringify(corpus.errors.slice(0, 3)));
    let bad = 0;
    for (const s of corpus.sessions) for (const e of s.events) {
      if (e.time === undefined && e.type !== 'session') bad++;
    }
    assert.equal(bad, 0, `${bad} 条事件缺 time`);
  });

  await test('折叠 == 独立重算（逐会话计数与总量）', () => {
    for (const s of corpus.sessions) {
      const state = fold.foldLog(s.events, { inheritedBelow: rawlog.inheritedCutFromEvents(s.events) });
      const expect = naiveRecount(s.events, rawlog.inheritedCutFromEvents(s.events));
      const got = { steps: 0, attempts: 0, compactions: 0, total: 0 };
      for (const f of state.logFacts) {
        if (f.k === 'step') got.steps++;
        else if (f.k === 'attempt') got.attempts++;
        else if (f.k === 'compaction') got.compactions++;
        got.total += f.tt;
      }
      assert.equal(got.steps, expect.steps, `${s.id} step`);
      assert.equal(got.attempts, expect.attempts, `${s.id} attempt`);
      assert.equal(got.compactions, expect.compactions, `${s.id} compaction`);
      assert.equal(got.total, expect.total, `${s.id} total`);
      assert.equal(state.gaps.noUsageMessages, expect.noUsage, `${s.id} 缺口`);
    }
  });

  await test('路由归属：每条事实都有 provider/model', () => {
    const state = fold.foldLog(corpus.sessions.flatMap((s) => s.events));
    const bad = state.logFacts.filter((f) => !f.p || !f.m || f.p === 'unknown' || f.m === 'unknown');
    assert.equal(bad.length, 0, `${bad.length} 条事实路由缺失`);
  });

  await test('五维聚合 totals 互等（真实语料）', () => {
    const sessions = corpus.sessions.map((s) => {
      const state = fold.foldLog(s.events, { inheritedBelow: rawlog.inheritedCutFromEvents(s.events) });
      return {
        id: s.id,
        meta: {
          title: state.title,
          cwd: s.header && s.header.cwd,
          createdAt: s.header && s.header.createdAt,
          parentSession: s.header && s.header.parentSession,
          origin: s.header && s.header.origin,
        },
        logFacts: state.logFacts,
        auxFacts: state.auxFacts,
      };
    });
    const dims = ['model', 'provider', 'session', 'day', 'week'];
    const results = dims.map((by) => fold.aggregate(sessions, { by, timeZone: 'Asia/Shanghai', weekStart: 1 }));
    const grand = results[0].totals.total;
    for (const r of results) assert.equal(r.totals.total, grand, `${r.by} 维度`);
    assert.ok(grand > 0);

    const byModel = results[0];
    const byProvider = results[1];
    const byDay = results[3];
    notes.push(`真实语料总计 ${grand.toLocaleString('en-US')} tokens / ${byModel.totals.calls.toLocaleString('en-US')} 次调用`);
    notes.push(`供应商：${byProvider.rows.map((r) => `${r.key}=${r.total.toLocaleString('en-US')}`).join(', ')}`);
    notes.push(`模型 top5：${byModel.rows.slice(0, 5).map((r) => `${r.key}=${r.total.toLocaleString('en-US')}`).join(', ')}`);
    notes.push(`日期跨度：${byDay.rows[0] && byDay.rows[0].key} … ${byDay.rows[byDay.rows.length - 1] && byDay.rows[byDay.rows.length - 1].key}（${byDay.rows.length} 天）`);
    notes.push(`会话数 ${results[2].rows.length}；其中子代理 ${sessions.filter((s) => s.meta.parentSession).length}`);
  });

  await test('按日分桶的合 == 按会话分桶的合（换维度不丢账）', () => {
    const sessions = corpus.sessions.slice(0, 20).map((s) => {
      const state = fold.foldLog(s.events);
      return { id: s.id, meta: {}, logFacts: state.logFacts, auxFacts: state.auxFacts };
    });
    const byDay = fold.aggregate(sessions, { by: 'day', timeZone: 'UTC' });
    const bySession = fold.aggregate(sessions, { by: 'session', timeZone: 'UTC' });
    assert.equal(byDay.totals.total, bySession.totals.total);
    assert.equal(byDay.totals.calls, bySession.totals.calls);
  });
}

/* ------------------------------------------------------------------ C ---- */

function havePython() {
  try {
    execFileSync('python3', ['-c', 'print(1)'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function makeZip(zipPath, entries, compress) {
  const py = [
    'import zipfile,sys,json',
    'zip_path = sys.argv[1]',
    'compress = sys.argv[2] == "1"',
    'entries = json.loads(sys.argv[3])',
    'mode = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED',
    'with zipfile.ZipFile(zip_path, "w", mode) as z:',
    '    for e in entries:',
    '        z.write(e["src"], arcname=e["name"])',
  ].join('\n');
  const payload = JSON.stringify(entries);
  execFileSync('python3', ['-c', py, zipPath, compress ? '1' : '0', payload], { stdio: 'ignore' });
}

async function sectionC(corpus, tmpRoot) {
  section('C 归档 zip 导入（python3 造包：deflate + store）');
  if (!havePython()) { notes.push('python3 不可用，跳过 C 段'); return; }
  const sample = corpus.sessions.find((s) => s.events.length > 5);
  if (!sample) { notes.push('语料为空，跳过 C 段'); return; }

  const text = rawlog.decodeLogBytes(fs.readFileSync(sample.filePath));
  const src = path.join(tmpRoot, 'session.v3.jsonl');
  fs.writeFileSync(src, text, 'utf8');

  for (const compress of [true, false]) {
    await test(`zip(${compress ? 'deflate' : 'store'}) 解出的事实 == 直接折叠`, () => {
      const zipPath = path.join(tmpRoot, `arc-${compress ? 'd' : 's'}.zip`);
      makeZip(zipPath, [{ src, name: `${sample.id}/session.v3.jsonl` }], compress);
      const logs = rawlog.sessionLogsFromZip(fs.readFileSync(zipPath));
      assert.equal(logs.length, 1);
      assert.equal(logs[0].header.id, sample.id, '头行 id 优先');
      const viaZip = fold.foldLog(logs[0].events, { inheritedBelow: rawlog.inheritedCutFromEvents(logs[0].events) });
      const direct = fold.foldLog(sample.events, { inheritedBelow: rawlog.inheritedCutFromEvents(sample.events) });
      assert.equal(viaZip.logFacts.length, direct.logFacts.length);
      assert.deepEqual(viaZip.logFacts, direct.logFacts);
    });
  }
}

/* ------------------------------------------------------------------ D ---- */

function fakeCtx(corpus, archivedIds = [], options = {}) {
  const failReads = new Set((options.failReads || []).map(String));
  const byId = new Map(corpus.map((s) => [s.id, s]));
  const handlers = new Map();
  const routes = [];
  const disposers = [];
  const sizes = corpus.map((s) => ({ header: { id: s.id }, sizeBytes: s.sizeBytes }));
  const ctx = {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
      return () => {};
    },
    get(name) {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => corpus.map((s) => ({ header: s.header, live: false, persisted: true })),
          readSession: async (id) => {
            if (failReads.has(String(id))) {
              // 复刻本机真实故障：seeded 会话在 session 侧无法物化
              throw new Error('seeded session constructor seed must equal its inherited prefix');
            }
            const s = byId.get(String(id));
            if (!s) throw new Error(`未知会话 ${id}`);
            return { session: s.header, inheritedEventCount: 0, events: s.events };
          },
        };
      }
      if (name === 'sessionPersistence') return { list: async () => sizes };
      if (name === 'workspaceRegistry') return { archivedSessionIds: archivedIds };
      if (name === 'llm') return options.llm;   // 「模型设置」桩（缺省 undefined = 服务不在）
      return undefined;
    },
    sessions: { list: () => [] },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
  };
  return { ctx, handlers, routes, disposers, fire: (type, ...args) => {
    for (const fn of handlers.get(type) || []) fn(...args);
  } };
}

function fakeReq(method, url, body) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:3080' },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return req; },
    destroy() {},
  };
  setImmediate(() => {
    if (body !== undefined && body !== null) for (const cb of listeners.get('data') || []) cb(Buffer.from(body));
    for (const cb of listeners.get('end') || []) cb();
  });
  return req;
}

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    end(chunk) { if (chunk !== undefined) this.body += chunk; },
  };
}

async function callRoute(routes, routePath, { method = 'GET', query = '', body, timeoutMs = 20000 } = {}) {
  const route = routes.find((r) => r.path === routePath);
  assert.ok(route, `路由 ${routePath} 未注册`);
  const req = fakeReq(method, routePath + (query ? `?${query}` : ''), body);
  const res = fakeRes();
  route.handler(req, res);
  const deadline = Date.now() + timeoutMs;
  while (res.status === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(res.status !== 0, `${routePath} 超时未响应`);
  return { status: res.status, headers: res.headers, body: res.body };
}

const jparse = (body) => JSON.parse(body);

async function sectionD(corpus, tmpRoot) {
  section('D 假环境全链路（真实语料桩住服务 + 真存储 + 真路由）');

  // 取两个会话：A 走语料，B 只存在于归档 zip（验证导入 + 不双计）
  const withFacts = corpus.sessions.filter((s) => s.events.length > 3);
  const sampleB = withFacts[0];
  const corpusWithoutB = corpus.sessions.filter((s) => s.id !== sampleB.id);

  const home = path.join(tmpRoot, 'home');
  const zipDir = path.join(tmpRoot, 'zips');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(zipDir, { recursive: true });
  if (havePython()) {
    const src = path.join(tmpRoot, 'b.jsonl');
    fs.writeFileSync(src, rawlog.decodeLogBytes(fs.readFileSync(sampleB.filePath)), 'utf8');
    makeZip(path.join(zipDir, 'export-b.zip'), [{ src, name: `${sampleB.id}/session.v3.jsonl` }], true);
  }

  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let handle = null;
  let harness = null;
  try {
    harness = fakeCtx(corpusWithoutB, [corpusWithoutB[1] ? corpusWithoutB[1].id : 'none']);
    handle = createUsageStats(harness.ctx, {
      timeZone: 'Asia/Shanghai',
      weekStart: 1,
      autoBackfill: false,
      zipImportDirs: havePython() ? [zipDir] : [],
      flushIntervalMs: 60000,
    });

    await test('回填：语料全部折叠，归档 zip 里的会话被导入', async () => {
      const r = await handle.runBackfill();
      assert.equal(r.started, true);
      const status = handle.statusPayload();
      assert.equal(status.sessions.total, corpusWithoutB.length + (havePython() ? 1 : 0));
      assert.ok(status.facts.log > 0);
      if (havePython()) {
        assert.equal(status.sessions.bySource.zip, 1, '归档来源应有 1 个会话');
      }
      const expectTotal = corpusWithoutB.reduce((acc, s) => {
        const st = fold.foldLog(s.events);
        return acc + st.logFacts.reduce((a, f) => a + f.tt, 0);
      }, 0) + (havePython() ? fold.foldLog(sampleB.events).logFacts.reduce((a, f) => a + f.tt, 0) : 0);
      const got = handle.buildSessions().reduce((a, s) => a + s.logFacts.reduce((x, f) => x + f.tt, 0), 0);
      assert.equal(got, expectTotal, '回填总量 == 逐会话折叠之和');
      notes.push(`回填：扫描 ${r.stats.scanned} · 折叠 ${r.stats.folded} · 跳过 ${r.stats.skipped} · 导入 ${r.stats.imported}`
        + (r.stats.errors.length ? ` · 错误 ${r.stats.errors.length}` : ''));
    });

    await test('路由：status / summary(五维) / export.csv 全部可用且 totals 互等', async () => {
      const st = await callRoute(harness.routes, '/dsh-usage/status');
      assert.equal(st.status, 200);
      const status = jparse(st.body);
      assert.equal(status.schema, 1);
      assert.equal(status.timeZone, 'Asia/Shanghai');

      let grand = null;
      for (const by of ['model', 'provider', 'session', 'day', 'week']) {
        const r = await callRoute(harness.routes, '/dsh-usage/summary', { query: `by=${by}` });
        assert.equal(r.status, 200, `${by} 路由状态`);
        const payload = jparse(r.body);
        assert.equal(payload.by, by);
        assert.ok(payload.rows.length > 0, `${by} 应有数据`);
        if (grand === null) grand = payload.totals.total;
        else assert.equal(payload.totals.total, grand, `${by} 总计应一致`);
        if (by === 'session') assert.ok(payload.rows.every((row) => typeof row.key === 'string'));
      }
      const csv = await callRoute(harness.routes, '/dsh-usage/export.csv', { query: 'by=model' });
      assert.equal(csv.status, 200);
      assert.match(csv.headers['content-type'], /text\/csv/);
      const lines = csv.body.trim().split('\n');
      assert.ok(lines.length > 1, 'CSV 至少一行数据');
      // 缓存占比两列**追加在末尾**（前 10 列与历史导出逐列一致，位置解析器不受影响）；
      // cacheShare 为 null 时该格留空，不能写 0。
      assert.deepEqual(lines[0].split(','), [
        'key', 'label', 'calls', 'input', 'output', 'cacheRead', 'cacheWrite',
        'reasoning', 'total', 'sessions', 'cacheShare', 'cacheCoverage',
      ]);
      for (const line of lines.slice(1)) assert.equal(line.split(',').length, 12, `CSV 列数不符：${line}`);
      const modelPayload = jparse((await callRoute(harness.routes, '/dsh-usage/summary', { query: 'by=model' })).body);
      // 逐行比对两列：null 必须留空（不是 0）。--quick 抽样可能一条「无缓存数据」都没有，
      // 所以在有 null 行时额外显式断言一次留空。
      let sawNull = 0;
      for (const r of modelPayload.rows) {
        const line = lines.find((l) => l.startsWith(r.key + ','));
        assert.ok(line !== undefined, `CSV 应有该行：${r.key}`);
        const cells = line.split(',');
        assert.equal(cells[10], r.cacheShare === null || r.cacheShare === undefined ? '' : (r.cacheShare * 100).toFixed(2),
          `第 11 列 cacheShare 与接口不一致：${r.key}`);
        assert.equal(cells[11], r.cacheCoverage === null || r.cacheCoverage === undefined ? '' : (r.cacheCoverage * 100).toFixed(2),
          `第 12 列 cacheCoverage 与接口不一致：${r.key}`);
        if (r.cacheShare === null) {
          sawNull++;
          // 「无缓存数据」行：占比必须留空（绝不写 0），但覆盖度是真实的 0.00
          // （全部计费输入都不带缓存字段），两者语义不同，别混为一谈。
          assert.equal(cells[10], '', `无缓存数据的占比列必须留空：${line}`);
          // 覆盖度：有流量但全不可测 = 0.00；连流量都没有（billed=0，0/0 无意义）= 留空。
          assert.ok(cells[11] === '0.00' || cells[11] === '',
            `无缓存数据的覆盖度只能是 0.00（全不可测）或留空（无流量）：${line}`);
        }
      }
      assert.equal(lines.length, modelPayload.rows.length + 1, 'CSV 行数 = 表头 + 数据行');
      // 全量语料里必然存在「无缓存数据」的模型（该渠道从不上报缓存字段），
      // 这条断言确保上面那段留空检查真的被走到过，而不是空转。
      if (modelPayload.rows.length >= 8) assert.ok(sawNull > 0, '全量语料应至少有一个「无缓存数据」的模型行');
    });

    await test('路由：range=1d 过滤生效；rescan 需要同源', async () => {
      const all = jparse((await callRoute(harness.routes, '/dsh-usage/summary', { query: 'by=day' })).body);
      const one = jparse((await callRoute(harness.routes, '/dsh-usage/summary', { query: 'by=day&range=1d' })).body);
      assert.ok(one.totals.total <= all.totals.total, '单日不应超过全部');
      assert.ok(one.rows.length <= 1);
      const r = await callRoute(harness.routes, '/dsh-usage/rescan', {
        method: 'POST', body: JSON.stringify({ full: false }),
      });
      assert.equal(r.status, 200);
      await callRoute(harness.routes, '/dsh-usage/status');
      const deadline = Date.now() + 20000;
      while (handle.statusPayload().backfill.running && Date.now() < deadline) await new Promise((x) => setTimeout(x, 25));
      assert.equal(handle.statusPayload().backfill.running, false, '回填应结束');
    });

    await test('幂等：再跑一次回填，总量不变', async () => {
      const before = handle.buildSessions().reduce((a, s) => a + s.logFacts.reduce((x, f) => x + f.tt, 0), 0);
      await handle.runBackfill({ full: false });
      const after = handle.buildSessions().reduce((a, s) => a + s.logFacts.reduce((x, f) => x + f.tt, 0), 0);
      assert.equal(after, before, '增量回填不得重复计账');
      await handle.runBackfill({ full: true });
      const rebuilt = handle.buildSessions().reduce((a, s) => a + s.logFacts.reduce((x, f) => x + f.tt, 0), 0);
      assert.equal(rebuilt, before, '重建全部结果一致');
    });

    await test('实时：session/created + session/event 立即记账', () => {
      const liveEvents = [
        ev(0, 'request/header', { header: { config: { provider: 'live-p', model: 'live-m' } } }, T0),
        ev(1, 'assistant/message', { usage: { inputTokens: 11, outputTokens: 1 } }, T0 + 10),
      ];
      const session = {
        id: 'live-1',
        header: { createdAt: T0, cwd: '/tmp/live' },
        inheritedEventCount: 0,
        snapshotEvents: (fromSeq) => (fromSeq ? liveEvents.filter((e) => e.seq >= fromSeq) : liveEvents.slice()),
      };
      harness.fire('session/created', session);
      const after = ev(2, 'assistant/message', { usage: { inputTokens: 5, outputTokens: 5 } }, T0 + 20);
      liveEvents.push(after);
      harness.fire('session/event', session, after);
      const entry = handle.store.entries.get('live-1');
      assert.ok(entry, '实时会话应入账本');
      assert.equal(entry.state.logFacts.length, 2);
      assert.equal(entry.state.logFacts[0].p, 'live-p');
      assert.equal(handle.statusPayload().sessions.bySource.live >= 1, true);
    });

    await test('实时补记：llm/stream 只记 liveOnlyPurposes，且不改动流内容', async () => {
      const before = handle.statusPayload().facts.aux;
      const chunks = [{ type: 'usage', usage: { inputTokens: 42, outputTokens: 2 } }, { type: 'finish', reason: { kind: 'stop' } }];
      const next = async function* () { for (const c of chunks) yield c; };
      const out = [];
      for await (const c of harness.handlers.get('llm/stream')[0](
        { sessionId: 'live-1', provider: 'title-p', model: 'title-m', purpose: 'session-title' }, next,
      )) out.push(c);
      assert.deepEqual(out, chunks, '必须原样透传 chunk');
      assert.equal(handle.statusPayload().facts.aux, before + 1, '标题调用应补记 1 条');
      const entry = handle.store.entries.get('live-1');
      assert.equal(entry.state.auxFacts[0].u, 'session-title');
      assert.equal(entry.state.auxFacts[0].tt, 44);

      // compaction 必须排除（其用量已在日志里）
      const out2 = [];
      for await (const c of harness.handlers.get('llm/stream')[0](
        { sessionId: 'live-1', provider: 'x', model: 'y', purpose: 'compaction' },
        async function* () { yield { type: 'usage', usage: { inputTokens: 999 } }; },
      )) out2.push(c);
      assert.equal(handle.statusPayload().facts.aux, before + 1, 'compaction 不得补记（否则双计）');

      // 无 purpose 的普通调用原样透传
      const out3 = [];
      for await (const c of harness.handlers.get('llm/stream')[0](
        { sessionId: 'live-1', provider: 'x', model: 'y' },
        async function* () { yield { type: 'usage', usage: { inputTokens: 1 } }; },
      )) out3.push(c);
      assert.equal(handle.statusPayload().facts.aux, before + 1);
    });

    await test('持久化：重启后从 facts/ 恢复，数字不变', async () => {
      const before = handle.buildSessions().reduce((a, s) => a + s.logFacts.reduce((x, f) => x + f.tt, 0), 0);
      const auxBefore = handle.statusPayload().facts.aux;
      handle.flush();
      const files = fs.readdirSync(path.join(home, 'usage-stats', 'facts'));
      assert.ok(files.length >= corpusWithoutB.length, `facts/ 应有 ${corpusWithoutB.length}+ 个文件，实际 ${files.length}`);
      const harness2 = fakeCtx(corpusWithoutB, []);
      const handle2 = createUsageStats(harness2.ctx, {
        timeZone: 'Asia/Shanghai', autoBackfill: false, flushIntervalMs: 60000,
      });
      const after = handle2.buildSessions().reduce((a, s) => a + s.logFacts.reduce((x, f) => x + f.tt, 0), 0);
      assert.equal(after, before, '冷启动读盘后总量一致');
      assert.equal(handle2.statusPayload().facts.aux, auxBefore, 'aux 事实也要恢复');
      assert.equal(handle2.store.loadErrors.length, 0, JSON.stringify(handle2.store.loadErrors));
      harness2.disposers.forEach((d) => d());
    });

    await test('来源升格：会话同时出现在归档与语料时只计一次（语料优先）', async () => {
      if (!havePython()) return;
      const before = handle.store.entries.get(sampleB.id);
      assert.equal(before.source, 'zip');
      const beforeTotal = handle.buildSessions().reduce((a, s) => a + s.logFacts.reduce((x, f) => x + f.tt, 0), 0);
      const harness3 = fakeCtx(corpus.sessions, []);
      const handle3 = createUsageStats(harness3.ctx, {
        timeZone: 'Asia/Shanghai', autoBackfill: false, zipImportDirs: [zipDir], flushIntervalMs: 60000,
      });
      await handle3.runBackfill({ full: false });
      const entry = handle3.store.entries.get(sampleB.id);
      assert.equal(entry.source, 'corpus', '语料等级更高，应升格');
      const afterTotal = handle3.buildSessions().reduce((a, s) => a + s.logFacts.reduce((x, f) => x + f.tt, 0), 0);
      assert.equal(afterTotal, beforeTotal, '升格不得改变总量');
      harness3.disposers.forEach((d) => d());
    });

    await test('语料读取失败 → 自动回退原始日志折叠（不漏账、口径一致）', async () => {
      const sample = withFacts[1] || withFacts[0];
      // 独立 home：否则该会话已被前面几项测试折过账本，会走 skip 分支而测不到回退
      const home2 = path.join(tmpRoot, 'home-fallback');
      process.env.DSH_HOME = home2;
      // 造一个 sessions 树：<root>/<workspace>/<session-id>/session.jsonl
      const sessRoot = path.join(home2, 'sessions', '--fallback--', sample.id);
      fs.mkdirSync(sessRoot, { recursive: true });
      fs.writeFileSync(path.join(sessRoot, 'session.jsonl'),
        rawlog.decodeLogBytes(fs.readFileSync(sample.filePath)), 'utf8');

      const parsed = rawlog.readLogFile(sample.filePath);
      const expected = fold.foldLog(parsed.events, {
        inheritedBelow: rawlog.inheritedCutFromEvents(parsed.events),
      });

      const harness4 = fakeCtx(corpusWithoutB, [], { failReads: [sample.id] });
      const handle4 = createUsageStats(harness4.ctx, {
        timeZone: 'Asia/Shanghai', autoBackfill: false, flushIntervalMs: 60000,
      });
      await handle4.runBackfill({ full: false });
      const stats = handle4.statusPayload().backfill;
      const entry = handle4.store.entries.get(sample.id);
      assert.ok(entry, '会话应通过原始日志补回账本');
      assert.equal(entry.source, 'corpus', '回退来源仍记作语料（同一口径）');
      assert.ok(stats.recovered >= 1, `应记录 recovered，实际 ${stats.recovered}`);
      assert.ok(stats.notes.some((n) => n.id === sample.id), '应在 notes 里说明回退原因');
      assert.equal(stats.errors.filter((e) => e.id === sample.id).length, 0, '回退成功就不该再记 error');
      const got = entry.state.logFacts.reduce((a, f) => a + f.tt, 0);
      const want = expected.logFacts.reduce((a, f) => a + f.tt, 0);
      assert.equal(got, want, `回退折叠的 token 必须与直接折叠一致（${got} != ${want}）`);
      assert.equal(entry.state.logFacts.length, expected.logFacts.length, '事实条数也应一致');
      harness4.disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
      process.env.DSH_HOME = home;
    });
  } finally {
    if (harness) harness.disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  }
}

/* -------------------------------------------------------------- E ---- */

async function sectionE(corpus) {
  section('E 浏览器半边（图表结构渲染 + 模型别名）');

  const { charts } = loadClientCharts();
  const { TimeChart, HBars, Donut, HoverLine, Legend, CacheBars, CacheDetail, KeyCell, niceMax, shortNum, SERIES, css } = charts;

  // 真实聚合行（有语料就折前 30 个会话当样本，否则用合成会话）
  const sessions = corpus && corpus.sessions && corpus.sessions.length > 0
    ? corpus.sessions.slice(0, 30).map((s) => {
        const st = fold.foldLog(s.events, { inheritedBelow: rawlog.inheritedCutFromEvents(s.events) });
        return { id: s.id, meta: { title: st.title }, logFacts: st.logFacts, auxFacts: st.auxFacts };
      })
    : [{ id: 's1', meta: { title: '合成' }, logFacts: fold.foldLog(syntheticLog()).logFacts, auxFacts: [] }];
  const agg = (by) => fold.aggregate(sessions, { by, timeZone: 'Asia/Shanghai', weekStart: 1 });
  const dayRows = agg('day').rows;
  const modelRows = agg('model').rows;

  await test('装载：client.js 经 __ModuleLoader__ 注册，图表组件齐备', () => {
    for (const name of ['TimeChart', 'HBars', 'Donut', 'HoverLine', 'Legend', 'niceMax', 'shortNum']) {
      assert.equal(typeof charts[name], 'function', `缺少 ${name}`);
    }
    assert.ok(css.includes('.ust-chart-card'), 'PAGE_CSS 未注入');
    assert.equal(SERIES.length, 4);
  });

  await test('堆叠柱状图：按非零序列出 rect，且无 NaN 坐标', () => {
    const tree = TimeChart({ rows: dayRows, mode: 'bar', hoverIndex: null, onHover: () => {} });
    const rects = findAll(tree, 'rect');
    const bars = rects.filter((r) => r.props.fill !== undefined && r.props.fill !== 'transparent');
    const expected = dayRows.reduce((a, r) => a + SERIES.filter((s) => (r[s.k] || 0) > 0).length, 0);
    assert.equal(bars.length, expected, `堆叠段数不符：${bars.length} != ${expected}`);
    for (const b of bars) {
      assert.ok(b.props.height >= 0 && b.props.height <= 250, `柱高越界：${b.props.height}`);
      assert.ok(b.props.y >= 0, `柱顶越界：${b.props.y}`);
    }
    assert.deepEqual(nonFiniteNumbers(tree), []);
    // 悬停热区数量 = 数据点数
    const hits = rects.filter((r) => typeof r.props.onMouseEnter === 'function');
    assert.equal(hits.length, dayRows.length);
  });

  await test('折线图：1 条 polyline + 1 块面积 + 每点一个圆点，且首尾对齐', () => {
    const tree = TimeChart({ rows: dayRows, mode: 'line', hoverIndex: 0, onHover: () => {} });
    const lines = findAll(tree, 'polyline');
    assert.equal(lines.length, 1);
    const pts = lines[0].props.points.trim().split(/\s+/);
    assert.equal(pts.length, dayRows.length, '折线点数应等于数据点数');
    assert.equal(findAll(tree, 'path').length, 1, '应有面积块');
    assert.equal(findAll(tree, 'circle').length, dayRows.length);
    assert.equal(findAll(tree, 'circle')[0].props.r, 4.5, '悬停点应放大');
    assert.deepEqual(nonFiniteNumbers(tree), []);
  });

  await test('累计模式：折线数值单调不减，且末点=总量', () => {
    const tree = TimeChart({ rows: dayRows, mode: 'cum', hoverIndex: null, onHover: () => {} });
    const pts = findAll(tree, 'polyline')[0].props.points.trim().split(/\s+/).map((p) => Number(p.split(',')[1]));
    for (let i = 1; i < pts.length; i++) assert.ok(pts[i] <= pts[i - 1] + 1e-6, '累计曲线必须单调不减（y 轴向下）');
    const total = dayRows.reduce((a, r) => a + r.total, 0);
    const maxY = niceMax(total);
    const lastY = pts[pts.length - 1];
    assert.ok(Math.abs(lastY - (12 + 192 - (total / maxY) * 192)) < 1.5, '末点应等于总量对应高度');
  });

  await test('横向条形图：宽度在 0..100%，标签与数值齐备', () => {
    const tree = HBars({ rows: modelRows, limit: 20 });
    const rows = findAll(tree, 'div').filter((n) => n.props.className === 'ust-hrow');
    assert.equal(rows.length, Math.min(modelRows.length, 20));
    const fills = findAll(tree, 'div').filter((n) => n.props.className === 'ust-hfill');
    for (const f of fills) {
      const w = Number(String(f.props.style.width).replace('%', ''));
      assert.ok(w > 0 && w <= 100.5, `条宽越界：${w}`);
    }
    const segs = findAll(tree, 'span').filter((n) => n.props.className === 'ust-hseg');
    const expected = modelRows.slice(0, 20).reduce((a, r) => a + SERIES.filter((s) => (r[s.k] || 0) > 0).length, 0);
    assert.equal(segs.length, expected);
    assert.ok(findAll(tree, 'div').some((n) => n.props.className === 'ust-hval'), '缺少数值列');
  });

  await test('环形图：弧长占比合计为 1，超限项并入「其它」', () => {
    const tree = Donut({ rows: modelRows, limit: 8 });
    const arcs = findAll(tree, 'circle').filter((n) => n.props.strokeDasharray !== undefined);
    const total = modelRows.slice(0, 8).reduce((a, r) => a + r.total, 0)
      + modelRows.slice(8).reduce((a, r) => a + r.total, 0);
    const C = 2 * Math.PI * 58;
    let lenSum = 0;
    for (const a of arcs) {
      const len = Number(String(a.props.strokeDasharray).split(' ')[0]);
      assert.ok(Number.isFinite(len) && len >= 0, `弧长非法：${a.props.strokeDasharray}`);
      lenSum += len;
    }
    assert.ok(Math.abs(lenSum / C - 1) < 1e-3, `占比合计应为 1（弧长按 2 位小数取整，容差 1e-3），实际 ${lenSum / C}`);
    if (modelRows.length > 8) {
      const names = findAll(tree, 'span').filter((n) => n.props.className === 'ust-donut-name').map((n) => n.props.children);
      assert.ok(names.some((t) => String(t).startsWith('其它')), '超出 limit 的行应并入「其它」');
    }
    assert.deepEqual(nonFiniteNumbers(tree), []);
  });

  await test('悬停详情：空行与全零行都不炸', () => {
    const empty = HoverLine({ row: null, cumulative: null });
    assert.ok(findAll(empty, 'em').length > 0, '空态应给提示');
    const zero = { key: 'z', total: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    assert.deepEqual(nonFiniteNumbers(HoverLine({ row: zero, cumulative: 0 })), []);
  });

  await test('缓存占比 UI：逐项构成条 + 覆盖度 + 「无缓存数据」只落在真正无数据的行', () => {
    const { CacheBars, CacheRow, cacheShareOf, cacheCoverageOf, coverageHint, pctText, INPUT_SERIES } = charts;
    assert.equal(typeof CacheBars, 'function');
    assert.equal(INPUT_SERIES.length, 3, '输入构成 = 未命中输入 / 缓存读 / 缓存写');

    // 三行：强缓存（全量可测）/ 有字段但命中 0 / 完全无字段；外加一行混合项（覆盖度 < 100%）
    const mk = (key, extra) => Object.assign({
      key, label: key, calls: 7, output: 10, reasoning: 0, cacheUnknownInput: 0,
    }, extra);
    const rows = [
      mk('strong', { input: 100, cacheRead: 900, cacheWrite: 0, total: 1010, cacheKnown: true, cacheShare: 0.9, cacheCoverage: 1 }),
      mk('zero', { input: 500, cacheRead: 0, cacheWrite: 0, total: 510, cacheKnown: true, cacheShare: 0, cacheCoverage: 1 }),
      mk('none', { input: 500, cacheRead: 0, cacheWrite: 0, total: 510, cacheKnown: false, cacheShare: null, cacheCoverage: 0 }),
      mk('mixed', { input: 2100, cacheRead: 900, cacheWrite: 0, total: 3010, cacheKnown: true, cacheShare: 0.9, cacheCoverage: 1 / 3, cacheUnknownInput: 2000 }),
    ];
    assert.equal(cacheShareOf(rows[0]), 0.9);
    assert.equal(cacheShareOf(rows[1]), 0, '有字段但命中 0 → 真实 0%（不是 null）');
    assert.equal(cacheShareOf(rows[2]), null, '没有缓存字段 → null');
    // 标志优先：cacheKnown=false 就是「没有缓存数据」，哪怕行上还挂着数字（脏输入 /
    // 老 host）也不能把它显示成有占比——这条守卫以前没有任何用例覆盖（变异测试逃逸）。
    assert.equal(cacheShareOf({ cacheKnown: false, cacheShare: 0.5, cacheCoverage: 1, input: 100, cacheRead: 100 }), null,
      'cacheKnown=false 优先于行上的数字');
    assert.equal(cacheShareOf({ cacheKnown: true, cacheShare: null, cacheCoverage: 0 }), null,
      '有标志但覆盖度为 0（无可测流量）→ null');
    // 覆盖度提示：0（无数据）不提示、1（全覆盖）不提示、不足才提示
    assert.equal(coverageHint({ cacheCoverage: 0 }), null);
    assert.equal(coverageHint({ cacheCoverage: 1 }), null);
    assert.equal(coverageHint({ cacheCoverage: 0.5 }), '覆盖 50.0%');

    // 回归守卫：loading/切换页签时 totals 是兜底对象（没有 cacheShare 字段），
    // 以前卡片会把它算成 NaN% —— 现在必须落到 null → 显示「无」。
    assert.equal(cacheShareOf({ calls: 0, total: 0, sessions: 0 }), null, '兜底 totals 不得算出 NaN');
    assert.equal(pctText(undefined), '无缓存数据', 'pctText(undefined) 不得是 NaN%');
    assert.equal(pctText(null), '无缓存数据');

    const tree = CacheBars({ rows, limit: 20, title: '缓存占比（模型 逐项）' });
    assert.equal(findAll(tree, 'div').filter((n) => n.props.className === 'ust-crow').length, 4, '每项一行');
    const vals = findAll(tree, 'div').filter((n) => n.props.className === 'ust-hval')
      .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : n.props.children));
    assert.deepEqual(vals, ['90.0%', '0.0%', '—', '90.0%'], '每行显示自己的实测占比');
    // 覆盖度：只有覆盖不足的行标「覆盖 N%」
    const covers = findAll(tree, 'div').filter((n) => n.props.className === 'ust-ccover')
      .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : n.props.children));
    assert.deepEqual(covers, ['覆盖 33.3%'], '只有混合项（覆盖 1/3）带覆盖度提示');

    // 「无缓存数据」必须**只**由无缓存数据的那一行产生 —— 注意卡片底部口径说明里
    // 也含这四个字，所以断言要落在行节点上，不能用整棵树 includes（那会恒真）。
    const noneNodes = findAll(tree, 'div').filter((n) => n.props.className === 'ust-cnone');
    assert.equal(noneNodes.length, 1, '只有完全无数据的行出「无缓存数据」占位');
    assert.equal(treeText({ type: 'x', props: { children: noneNodes } }).trim(), '无缓存数据');
    // 命中 0 的行必须画构成条，不能被当成无数据
    assert.equal(findAll(tree, 'div').filter((n) => n.props.className === 'ust-hfill').length, 3,
      'strong/zero/mixed 都要出构成条，只有 none 不出');
    const segs = findAll(tree, 'span').filter((n) => n.props.className === 'ust-hseg');
    // strong 2（input+cacheRead）/ zero 1（input）/ mixed 2（input+cacheRead）
    assert.equal(segs.length, 5, '每项只出自己非零的构成段');
    assert.ok(treeText(tree).includes('有缓存数据 3 / 4 项'));
    assert.deepEqual(nonFiniteNumbers(tree), []);

    // 全无数据：0 个构成条，图例如实报 0 项
    const tree2 = CacheBars({ rows: [rows[2]], limit: 20 });
    assert.equal(findAll(tree2, 'div').filter((n) => n.props.className === 'ust-hfill').length, 0);
    assert.ok(treeText(tree2).includes('有缓存数据 0 / 1 项'));
    assert.deepEqual(nonFiniteNumbers(tree2), []);
    assert.equal(typeof CacheRow({ row: rows[0] }), 'object');
  });

  await test('视图偏好持久化：页签/范围/开关可存可读，坏存档一律落默认', () => {
    const { readView, writeView, VIEW_KEY, VIEW_DEFAULTS } = charts;
    const mk = (initial) => {
      const map = new Map();
      if (initial !== undefined) map.set(VIEW_KEY, initial);
      return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, v),
        raw: () => map.get(VIEW_KEY),
      };
    };
    // 没有存储 / 坏 JSON / 不是对象 / 数组 / 非法值 / 原型污染 → 默认值
    assert.deepEqual(readView(null), VIEW_DEFAULTS, '无 localStorage → 默认视图');
    assert.deepEqual(readView(mk('{不是 JSON')), VIEW_DEFAULTS, '坏 JSON → 默认视图');
    assert.deepEqual(readView(mk('"model"')), VIEW_DEFAULTS, '字符串 → 默认视图');
    assert.deepEqual(readView(mk('[1,2,3]')), VIEW_DEFAULTS, '数组 → 默认视图');
    assert.deepEqual(readView(mk('{"by":"hack","range":"9d","showCache":"yes","showTable":null}')), VIEW_DEFAULTS,
      '非法取值必须逐项丢掉（一个坏 by 会让页面报「host 未接入该维度」）');
    assert.deepEqual(readView(mk('{"__proto__":{"polluted":1}}')), VIEW_DEFAULTS, '__proto__ 不进结果');
    assert.equal({}.polluted, undefined, '不得污染 Object 原型');

    // 合法值原样恢复（subagents 的合法取值包含 null，不能按 falsy 丢）
    const store = mk();
    assert.equal(writeView({ by: 'session', range: '7d', subagents: 'root', timeMode: 'cum', shareMode: 'donut', showTable: false, showCache: true }, store), true);
    assert.deepEqual(readView(store), {
      by: 'session', range: '7d', subagents: 'root', timeMode: 'cum', shareMode: 'donut', showTable: false, showCache: true,
    });
    assert.deepEqual(readView(mk('{"subagents":null}')).subagents, null, '显式 null 是合法取值');
    // 只写白名单键；存储抛错不炸（隐私模式 / 配额满）
    writeView({ by: 'day', evil: 123, __proto__: { x: 1 } }, store);
    assert.deepEqual(Object.keys(JSON.parse(store.raw())).sort(),
      ['by', 'range', 'shareMode', 'showCache', 'showTable', 'subagents', 'timeMode'], '只写白名单键');
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.deepEqual(readView(broken), VIEW_DEFAULTS, '读取抛错 → 默认视图');
    assert.equal(writeView({ by: 'day' }, broken), false, '写入抛错 → 返回 false，不抛');
    assert.equal(writeView({ by: 'day' }, null), false, '无存储 → 返回 false');
  });

  await test('命中率：点名称弹窗看单项，总表默认关且排在数值表后明细表前', () => {
    const { CacheDetail, KeyCell, CacheBars, orderedPanels, VIEW_DEFAULTS } = charts;
    const strong = {
      key: 'm1', label: 'NvidiaDeepSeekV4.1', model: 'deepseek-ai/deepseek-v4.1-flash',
      calls: 100, sessions: 3, input: 1000, output: 50, cacheRead: 9000, cacheWrite: 0,
      reasoning: 0, total: 10050, cacheKnown: true, cacheShare: 0.9, cacheCoverage: 0.9,
      cacheUnknownInput: 1000, providers: ['localhost'], settingsName: 'NvidiaDeepSeekV4.1',
    };
    const none = {
      key: 'x', label: 'MS 路由', calls: 5, sessions: 1, input: 500, output: 1,
      cacheRead: 0, cacheWrite: 0, total: 501, cacheKnown: false, cacheShare: null,
      cacheCoverage: 0, cacheUnknownInput: 500,
    };

    // 名称是按钮，点了把该行交给 onPick（弹窗由上层用这一行打开）
    const picked = [];
    const cell = KeyCell({ row: strong, onPick: (row) => picked.push(row) });
    assert.equal(cell.type, 'button');
    assert.equal(typeof cell.props.onClick, 'function');
    cell.props.onClick();
    assert.deepEqual(picked, [strong]);
    assert.equal(KeyCell({ row: strong }).props.onClick, undefined, '不给 onPick 时不挂空处理器');

    // 弹窗内容：这一项的占比 / 覆盖度 / 未上报，且不得出现 NaN。
    // 注意：断言必须**结构化**——同一份弹窗里 `includes('覆盖 90.0%')` 会被下方
    // 「未上报…只覆盖 90.0%」的说明喂饱、`includes('请求名')` 会被副标题里
    // `hoverTitle()` 的「请求名：…」喂饱（都是恒真的假断言，变异测试抓出来的）。
    const modalTree = CacheDetail({ row: strong, by: 'model', dimName: '模型', onClose: () => {} });
    const html = toHtml(modalTree);
    assert.ok(html.includes('90.0%'), '显示该项自己的命中率');
    const covers = [];
    const kvKeys = [];
    walk(modalTree, (n) => {
      const cls = n.props && n.props.className;
      if (typeof cls === 'string' && cls.split(/\s+/).includes('ust-ccover')) covers.push(n);
      if (n.props && n.props.key !== undefined && n.props.key !== null) kvKeys.push(n.props.key);
    });
    assert.equal(covers.length, 1, '弹窗里应有且只有一个覆盖度提示（hero 那个）');
    // harness 的 children 一律是数组（createElement 里 flat 过），拼回来再比字符串。
    assert.equal([].concat(covers[0].props.children).join(''), '覆盖 90.0%', '覆盖度提示内容正确');
    assert.ok(html.includes('不进命中率分母'), '要说明未上报流量为何不进分母');
    for (const k of ['调用次数', '会话数', '计费输入', '可测输入', '未上报输入', '未命中输入', '缓存读', '缓存写', '输出', '总计']) {
      assert.ok(kvKeys.includes(k), '弹窗缺少数值项：' + k);
    }
    for (const k of ['请求名', '模型设置名', '供应商']) {
      assert.ok(kvKeys.includes(k), '模型维缺少信息项：' + k);
    }
    // 会话维给的是另一组信息项
    const sessKeys = [];
    walk(CacheDetail({
      row: Object.assign({}, strong, { cwd: '/x', origin: 'subagent', archived: true, createdAt: 1, parentSession: 'p' }),
      by: 'session', dimName: '会话', onClose: () => {},
    }), (n) => { if (n.props && n.props.key !== undefined && n.props.key !== null) sessKeys.push(n.props.key); });
    for (const k of ['工作目录', '来源', '归档', '创建时间', '父会话']) {
      assert.ok(sessKeys.includes(k), '会话维缺少信息项：' + k);
    }
    assert.ok(!sessKeys.includes('会话数'), '会话维不重复列出会话数');
    assert.deepEqual(nonFiniteNumbers(modalTree), []);
    // 无缓存数据的那一项：不谎报 0%，也不说「覆盖 0.0%」。
    // 「命中率不可测」也不能用 includes 断言（下方未上报说明里也有这句），
    // 要断言到 hero 那个 .ust-modal-ratek 节点上。
    const heroText = (tree) => {
      const nodes = [];
      walk(tree, (n) => {
        const cls = n.props && n.props.className;
        if (typeof cls === 'string' && cls.split(/\s+/).includes('ust-modal-ratek')) nodes.push(n);
      });
      assert.equal(nodes.length, 1, '弹窗 hero 应有且只有一个说明节点');
      return [].concat(nodes[0].props.children).join('');
    };
    const noneTree = CacheDetail({ row: none, by: 'model', dimName: '模型', onClose: () => {} });
    const htmlNone = toHtml(noneTree);
    assert.ok(htmlNone.includes('无缓存数据'));
    assert.ok(heroText(noneTree).includes('不可测'), 'hero 要说明这一项的命中率不可测');
    assert.ok(!htmlNone.includes('0.0%'), '无实测流量时不得出现任何 0.0%');
    assert.ok(heroText(modalTree).includes('缓存读 + 缓存写'), '有数据时 hero 要给出算法口径');
    assert.equal(CacheDetail({ row: null, onClose: () => {} }), null, '没有行就不渲染');
    // 背景点击关闭 / 关闭按钮存在（Esc 由上层 effect 处理）
    const modal = CacheDetail({ row: strong, by: 'model', onClose: () => {} });
    assert.equal(typeof modal.props.onMouseDown, 'function');
    assert.ok(findAll(modal, 'button').some((b) => b.props.children.includes('关闭')));

    // 总表每行的名称也可点（同一入口）
    const bars = CacheBars({ rows: [strong, none], limit: 20 });
    assert.equal(findAll(bars, 'button').length, 2, '总表两行各一个可点名称');

    // 版块顺序：数值表 → 命中率总表 → 明细表；总表关掉时不占位
    const panel = (t) => ({ type: 'div', props: { children: [t] } });
    const seq = (o) => orderedPanels(o).map((n) => n.props.children[0]).join(' → ');
    assert.equal(seq({ chartCard: panel('图表'), cacheCard: panel('命中率'), table: panel('明细'), showCache: true, showTable: true }),
      '图表 → 命中率 → 明细', '命中率总表夹在数值表与明细表之间');
    assert.equal(seq({ chartCard: panel('图表'), cacheCard: panel('命中率'), table: panel('明细'), showCache: false, showTable: true }),
      '图表 → 明细', '默认不显示总表');
    assert.equal(seq({ chartCard: panel('图表'), cacheCard: panel('命中率'), table: panel('明细'), showCache: true, showTable: false }),
      '图表 → 命中率', '只关明细表时总表照常显示');
    assert.equal(seq({ chartCard: panel('图表'), cacheCard: null, table: null, showCache: true, showTable: true }), '图表');
    assert.equal(VIEW_DEFAULTS.showCache, false, '命中率总表默认关（单项走弹窗）');
    assert.equal(VIEW_DEFAULTS.showTable, true, '明细表默认开');

    // 弹窗按 key 绑定到**当前**数据，而不是打开时的行快照：
    // 刷新/回填会把行对象整体换掉，存快照会让弹窗一直显示旧数字。
    const { rowByKey, displayName } = charts;
    const fresh = { key: 'm1', label: 'NvidiaDeepSeekV4.1', cacheShare: 0.95 };
    const stale = { key: 'm1', label: 'NvidiaDeepSeekV4.1', cacheShare: 0.10 };
    assert.equal(rowByKey([fresh], 'm1'), fresh, '取的是当前数组里的那个对象');
    assert.notEqual(rowByKey([fresh], 'm1'), stale, '绝不会取回旧快照');
    assert.equal(rowByKey([fresh], 'm1').cacheShare, 0.95);
    assert.equal(rowByKey([fresh], 'gone'), null, '行不在当前视图 → 收起');
    assert.equal(rowByKey([fresh], null), null);
    assert.equal(rowByKey([], 'm1'), null);
    assert.equal(rowByKey(null, 'm1'), null);
    assert.equal(rowByKey([null, undefined, fresh], 'm1'), fresh, '跳过数组里的空洞');
    // 显示名兜底：host 永远给 key，但空行不该把 undefined 画到屏幕上
    assert.equal(displayName({}), '(未命名)');
    assert.equal(displayName({ key: 'k' }), 'k');
    assert.equal(displayName({ key: 'k', label: 'L' }), 'L');
    assert.ok(!toHtml(CacheDetail({ row: {}, by: 'model', dimName: '模型', onClose: () => {} })).includes('undefined'),
      '空行弹窗不得出现 undefined');
  });

  await test('接线（源码级）：弹窗两处入口 / 三种关闭 / 视图偏好落盘 都在', () => {
    // UsageStats 是 hooks 组件，无头 harness 渲染不了它（没有可 require 的 React），
    // 所以这几处接线只能做**源码级**存在性断言。它抓的是「接线被误删/改错」这类回归
    // （变异测试逐条验证过），代价是重构这些行时这条测试要一起改——值得。
    const src = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8');
    const must = [
      ['明细表名称入口（点名称开弹窗）', "KeyCell({ row, onPick: (picked) => setDetailKey(picked.key)"],
      // 必须是直接调用：两个无头套件都不展开函数组件，用 h(KeyCell, …) 会让
      // client-race-selftest 的首列文本退回副标题（实测读成「p」）。
      ['表格名称用直接调用（保持元素树扁平）', "KeyCell({ row, onPick:"],
      ['命中率总表名称入口', "onPick: (row) => setDetailKey(row.key),"],
      ['关闭按钮/点背景（弹窗 onClose 清键）', "onClose: () => setDetailKey(null) }"],
      ['Esc 关闭', "event.key === 'Escape' || event.key === 'Esc'"],
      ['Esc 监听拆装', "window.removeEventListener('keydown', onKey)"],
      ['换页签 / 换范围关闭弹窗', "React.useEffect(() => { setDetailKey(null); }, [query]);"],
      ['弹窗行按 key 从当前数据取（不是快照）', "rowByKey(rows, detailKey)"],
      ['视图偏好落盘', "writeView({ by, range, subagents, timeMode, shareMode, showTable, showCache });"],
      ['初值从存档恢复', "React.useMemo(() => readView(), [])"],
      ['两个开关都在工具条上', "'命中率总表'"],
    ];
    for (const [name, needle] of must) assert.ok(src.includes(needle), 'client.js 缺少接线：' + name);
    // 只扫**代码**：注释里正好会写到「不是 h(KeyCell, …)」这种解释，别把注释当代码。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/setDetail\(/.test(code), '不得残留旧的「存行对象快照」写法 setDetail(row)');
    assert.ok(!code.includes('h(KeyCell'), '表格/总表里的 KeyCell 必须直接调用（h() 会藏起首列文本）');
  });

  await test('样式：元素树里用到的每个 class 都在 PAGE_CSS 中有定义', () => {
    const trees = [
      Legend(),
      TimeChart({ rows: dayRows, mode: 'bar', hoverIndex: 1, onHover: () => {} }),
      TimeChart({ rows: dayRows, mode: 'line', hoverIndex: null, onHover: () => {} }),
      HBars({ rows: modelRows, limit: 20 }),
      Donut({ rows: modelRows, limit: 8 }),
      HoverLine({ row: dayRows[0], cumulative: 1 }),
      // 缓存占比两块也必须纳入：否则新增的 ust-crows/ust-crow/ust-cinfo/ust-cnone/
      // ust-ccover 全靠人工核对（上一轮就漏在这——CSS 测试写了等于没写）。
      CacheBars({ rows: modelRows.map((r, i) => (i === 0
        ? Object.assign({}, r, { cacheKnown: true, cacheShare: 0.9, cacheCoverage: 1 })
        : Object.assign({}, r, { cacheKnown: false, cacheShare: null, cacheCoverage: 0 }))), limit: 20 }),
      HoverLine({ row: Object.assign({}, dayRows[0], { cacheKnown: false, cacheShare: null, cacheCoverage: 0 }), cumulative: 1 }),
      // 命中率详情弹窗（.ust-overlay / .ust-modal*）与可点名称（.ust-keybtn）也要纳入。
      CacheDetail({
        row: Object.assign({}, modelRows[0] || {}, {
          cacheKnown: true, cacheShare: 0.9, cacheCoverage: 0.5, cacheUnknownInput: 1234, calls: 3, sessions: 1,
        }),
        by: 'model', dimName: '模型', onClose: () => {},
      }),
      KeyCell({ row: modelRows[0] || { key: 'k', label: 'k' }, onPick: () => {} }),
    ];
    const missing = new Set();
    for (const tree of trees) {
      for (const c of classesUsed(tree)) {
        if (!c.startsWith('ust')) continue;
        if (!css.includes('.' + c)) missing.add(c);
      }
    }
    assert.deepEqual([...missing], [], `PAGE_CSS 缺少样式：${[...missing].join(', ')}`);
  });

  await test('别名：内置表命中请求名，未知模型走兜底美化', () => {
    // 别名实现位于 host 半边，这里直接从 index.js 取（同一份配置口径）
    assert.equal(typeof indexApi.aliasForModel, 'function', '缺少别名实现导出');
    assert.equal(indexApi.aliasForModel('deepseek-ai/deepseek-v4.1-flash', {}), 'DeepSeek V4.1 Flash');
    assert.equal(indexApi.aliasForModel('step-5-preview', {}), 'Step 5 Preview');
    assert.equal(indexApi.aliasForModel('openai/gpt-5.2-turbo', {}), 'GPT 5.2 Turbo');
    assert.equal(indexApi.aliasForModel('qwen/qwen3.8-27b:free', {}), 'Qwen3.8 27B（免费）');
    assert.equal(indexApi.aliasForModel('some/local-thing:free', {}), 'Local Thing（免费）');
    assert.equal(indexApi.prettifyModelName('deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash');
  });

  await test('别名：自定义表覆盖内置表，空值不生效', () => {
    const table = { 'step-5-preview': '自建 Step5', 'x/y': '   ' };
    assert.equal(indexApi.aliasForModel('step-5-preview', table), '自建 Step5');
    assert.equal(indexApi.aliasForModel('x/y', table), 'Y', '空白覆盖应被忽略，回落到兜底');
    assert.equal(indexApi.aliasForModel('deepseek-ai/DeepSeek-V4.1-Flash', {}), 'DeepSeek V4.1 Flash');
  });

  await test('别名：模型设置展示名排在配置表之下、内置表之上', () => {
    // 新链：config.modelAliases > 模型设置展示名 > 内置表 > 兜底美化
    assert.equal(indexApi.aliasForModel('deepseek-ai/deepseek-v4.1-flash', {}, 'NvidiaDeepSeekV4.1'), 'NvidiaDeepSeekV4.1',
      '设置展示名应压过内置表');
    assert.equal(indexApi.aliasForModel('m-one', {}, '设置名甲'), '设置名甲', '无内置条目时直接用设置名');
    assert.equal(indexApi.aliasForModel('m-one', { 'm-one': '配置优先' }, '设置名甲'), '配置优先',
      'config.modelAliases 仍是最高优先级');
    assert.equal(indexApi.aliasForModel('m-one', {}, '   '), 'M One', '空白设置名应被忽略');
    assert.equal(indexApi.aliasForModel('m-one', {}, undefined), 'M One', '无设置名走兜底');
    assert.equal(indexApi.aliasForModel('m-one', {}, null), 'M One', 'null 设置名走兜底');
    // settingsNameLookup：按行内供应商优先、退全局表；坏形状不炸
    const lookup = indexApi.settingsNameLookup({
      byModel: { 'm-x': 'X 全局名' },
      byRoute: { p1: { 'm-x': 'P1 专属名' }, p2: { 'm-x': '   ' } },
    });
    assert.equal(lookup('m-x', ['p1']), 'P1 专属名', '行内供应商命中优先');
    assert.equal(lookup('m-x', ['p2']), 'X 全局名', '供应商侧空白名退全局表');
    assert.equal(lookup('m-x', ['p3']), 'X 全局名', '未知供应商退全局表');
    assert.equal(lookup('m-x'), 'X 全局名');
    assert.equal(lookup('m-y'), undefined);
    assert.equal(indexApi.settingsNameLookup(null)('m-x'), undefined, '空索引安全退化');
    assert.equal(indexApi.settingsNameLookup({})('m-x'), undefined, '缺字段安全退化');
    assert.equal(indexApi.settingsNameLookup({ byModel: { 'm-x': '仅全局' } })('m-x', 'not-array'), '仅全局', 'providers 非数组安全退化');
  });

  await test('标注名：运行时经 llm 服务取「模型设置」展示名（name=id 视为未配置）', async () => {
    // 独立 DSH_HOME：避免读到真实账本
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-names-'));
    try {
      const harness = fakeCtx([], [], {
        llm: {
          listProviders: () => [
            { id: 'p1', name: '一号供应' },
            { id: 'p2', name: 'p2' },            // displayName 未配置（=id）→ 不采用
          ],
          listModels: async (pid) => {
            if (pid === 'p1') return [
              { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'NvidiaDeepSeekV4.1' },
              { id: 'step-5-preview', name: 'step-5-preview' },  // name=id → 未配置，走内置表
              { id: 'm-one', name: '设置名甲' },
            ];
            return [{ id: 'm-x', name: 'P2 名下' }, { id: 'm-raw', name: 'm-raw' }];
          },
        },
      });
      const handle = createUsageStats(harness.ctx, {
        timeZone: 'Asia/Shanghai', autoBackfill: false, flushIntervalMs: 60000,
      });
      const state = fold.createFoldState();
      fold.foldEvents(state, [
        ev(0, 'request/header', { header: { config: { provider: 'p1', model: 'deepseek-ai/deepseek-v4.1-flash' } } }, T0),
        ev(1, 'assistant/message', { usage: { inputTokens: 5, outputTokens: 1 } }, T0 + 1),
        ev(2, 'request/header', { header: { config: { provider: 'p1', model: 'step-5-preview' } } }, T0 + 2),
        ev(3, 'assistant/message', { usage: { inputTokens: 6, outputTokens: 1 } }, T0 + 3),
        ev(4, 'request/header', { header: { config: { provider: 'p1', model: 'm-one' } } }, T0 + 4),
        ev(5, 'assistant/message', { usage: { inputTokens: 7, outputTokens: 1 } }, T0 + 5),
      ]);
      handle.store.entries.set('names-s', {
        id: 'names-s', source: 'live', header: {}, sizeBytes: 0, foldedAt: Date.now(), state,
      });
      // 刷新前（索引未建）：退回旧链（内置表）
      let payload = handle.summaryPayload(new URLSearchParams('by=model'));
      let row = payload.rows.find((r) => r.key === 'deepseek-ai/deepseek-v4.1-flash');
      assert.equal(row.label, 'DeepSeek V4.1 Flash', '刷新前走内置表');
      assert.equal(row.settingsName, null);
      // 刷新后：模型设置展示名接管标注
      await handle.refreshModelNames(true);
      payload = handle.summaryPayload(new URLSearchParams('by=model'));
      row = payload.rows.find((r) => r.key === 'deepseek-ai/deepseek-v4.1-flash');
      assert.equal(row.label, 'NvidiaDeepSeekV4.1', '刷新后用模型设置展示名');
      assert.equal(row.alias, 'NvidiaDeepSeekV4.1');
      assert.equal(row.settingsName, 'NvidiaDeepSeekV4.1');
      assert.equal(row.model, 'deepseek-ai/deepseek-v4.1-flash', '统计键仍是请求名');
      const step = payload.rows.find((r) => r.key === 'step-5-preview');
      assert.equal(step.label, 'Step 5 Preview', 'name=id 视为未配置 → 内置表');
      assert.equal(step.settingsName, null);
      const m1 = payload.rows.find((r) => r.key === 'm-one');
      assert.equal(m1.label, '设置名甲');
      // 供应商维度：displayName 接管 label
      const byProv = handle.summaryPayload(new URLSearchParams('by=provider'));
      const p1row = byProv.rows.find((r) => r.key === 'p1');
      assert.equal(p1row.label, '一号供应', '供应商行用 displayName');
      // status：模型设置索引可见
      const status = handle.statusPayload();
      assert.equal(status.modelSettings.available, true);
      assert.equal(status.modelSettings.names['m-one'], '设置名甲');
      assert.equal(status.config.modelNamesTtlMs >= 5000, true);
      // 持久化到账本 meta，重载可见（离线 preview 复用同一份）
      handle.flush();
      const reloaded = new FactStore(path.join(process.env.DSH_HOME, 'usage-stats')).loadSync();
      const saved = reloaded.meta.modelSettingsNames;
      assert.ok(saved !== null, 'state.json 应持久化模型设置名称索引');
      assert.equal(saved.byModel['m-one'], '设置名甲');
      assert.equal(saved.providers['p1'], '一号供应');
      assert.equal(saved.byRoute['p1']['deepseek-ai/deepseek-v4.1-flash'], 'NvidiaDeepSeekV4.1');
      harness.disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
    } finally {
      try { fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });

  await test('标注名：llm 服务不在/抛错时安全退化，请求不被卡住', async () => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-nollm-'));
    try {
      const boom = {
        listProviders: () => { throw new Error('目录不可用'); },
        listModels: async () => { throw new Error('模型不可用'); },
      };
      for (const llm of [undefined, boom]) {
        const harness = fakeCtx([], [], llm === undefined ? {} : { llm });
        const handle = createUsageStats(harness.ctx, {
          timeZone: 'Asia/Shanghai', autoBackfill: false, flushIntervalMs: 60000,
        });
        const state = fold.createFoldState();
        fold.foldEvents(state, [
          ev(0, 'request/header', { header: { config: { provider: 'p', model: 'deepseek-ai/deepseek-v4.1-flash' } } }, T0),
          ev(1, 'assistant/message', { usage: { inputTokens: 5, outputTokens: 1 } }, T0 + 1),
        ]);
        handle.store.entries.set('nollm-s', {
          id: 'nollm-s', source: 'live', header: {}, sizeBytes: 0, foldedAt: Date.now(), state,
        });
        await handle.ensureModelNames();       // 不抛、不挂
        await handle.refreshModelNames(true);  // 同上
        const payload = handle.summaryPayload(new URLSearchParams('by=model'));
        assert.equal(payload.rows[0].label, 'DeepSeek V4.1 Flash', '无索引时回退内置表');
        assert.equal(payload.rows[0].settingsName, null);
        const status = handle.statusPayload();
        assert.equal(status.modelSettings.available, false, 'status 应如实报告索引不可用');
        harness.disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
      }
    } finally {
      try { fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });

  await test('别名：只换显示名，统计键仍是请求名（不合并不同写法）', async () => {
    // 独立 DSH_HOME：否则会读到真实账本（那是 190+ 个会话的模型行）
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-alias-'));
    try {
    const harness = fakeCtx([], []);
    const handle = createUsageStats(harness.ctx, {
      timeZone: 'Asia/Shanghai', autoBackfill: false, flushIntervalMs: 60000,
      modelAliases: { 'm-one': '一号模型' },   // 键 = 请求名（模型维的 key 就是它）
    });
    const state = fold.createFoldState();
    fold.foldEvents(state, [
      ev(0, 'request/header', { header: { config: { provider: 'p', model: 'm-one' } } }, T0),
      ev(1, 'assistant/message', { usage: { inputTokens: 10, outputTokens: 1 } }, T0 + 1),
      ev(2, 'request/header', { header: { config: { provider: 'p', model: 'M-One' } } }, T0 + 2),
      ev(3, 'assistant/message', { usage: { inputTokens: 20, outputTokens: 2 } }, T0 + 3),
    ]);
    // 直接把折叠结果塞进账本（summaryPayload → buildSessions 读的就是 store.entries）
    handle.store.entries.set('alias-s', {
      id: 'alias-s', source: 'live', header: {}, sizeBytes: 0, foldedAt: Date.now(), state,
    });
    const payload = handle.summaryPayload(new URLSearchParams('by=model'));
    const rows = payload.rows;
    assert.equal(rows.length, 2, '大小写不同的请求名必须各自成行');
    // 模型维的键就是请求名本身（不含 provider 前缀）
    const one = rows.find((r) => r.key === 'm-one');
    const two = rows.find((r) => r.key === 'M-One');
    assert.ok(one && two, `未找到两行：${rows.map((r) => r.key).join(', ')}`);
    assert.equal(one.label, '一号模型');
    assert.equal(one.model, 'm-one', '行上应保留请求名');
    assert.equal(two.label, 'M One', '未配别名的一侧走兜底');
    assert.equal(two.model, 'M-One');
    assert.equal(payload.totals.total, rows.reduce((a, r) => a + r.total, 0));
    harness.disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
    } finally {
      try { fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
}

/* ------------------------------------------------------------------ F ---- */

/**
 * 设备网格镜像的来源边界（mesh-mirror.js + fold 的 remoteBelow）。
 *
 * 规则（本段钉住）：
 *   - 执行端 sessions/ 里**对端会话的副本**（镜像索引 session-replica/index.json 里有
 *     记录，边界 = syncedSeq ?? lastSeq）→ 边界内的 usage 事实**不计**（请求由对端发出）；
 *   - 本机自己跑的会话，**哪怕工作目录在远端工作区**（cwd 是执行端路径）也照常计——
 *     LLM 请求是本机发出的（"记录任何从当前设备发出的请求，包括远程工作区"）；
 *   - 边界之后本机接手/续跑的事件照常计；
 *   - sender 游标（session-mirror.json，本机推给对端的会话）**不是**排除依据；
 *   - 边界变化（网格又同步了一轮）会强制重折；索引缺失/损坏 = 不排除、不崩。
 */
async function sectionF(tmpRoot) {
  section('F 设备网格镜像（执行端的对端会话副本不计入本机账本）');

  const usage = (input, output) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output });
  const home = path.join(tmpRoot, 'mirror-home');
  const replicaDir = path.join(home, 'device-mesh', 'session-replica');
  fs.mkdirSync(replicaDir, { recursive: true });

  const A = 'session-aaaa1111-1111-1111-1111-111111111111';   // 纯对端历史（floor 覆盖全部）
  const C = 'session-cccc3333-3333-3333-3333-333333333333';   // 对端 0..2 + 本机接手 3..4
  const GHOST = 'session-9e9e9e9e-9e9e-9e9e-9e9e-9e9e9e9e9e9e'; // 镜像里有、本机没有落地的会话
  const SENDER = 'session-dd111111-1111-1111-1111-111111111111'; // 本机推给对端的会话（sender 游标）
  const LOCAL = 'session-bbbb2222-2222-2222-2222-222222222222'; // 本机会话，cwd 在远端工作区

  const corpus = [
    {
      id: A,
      header: { id: A, cwd: '/work/shared', createdAt: T0 },
      sizeBytes: 600,
      events: [
        ev(0, 'request/header', { header: { config: { provider: 'peer-p', model: 'peer-m' } } }, T0),
        ev(1, 'assistant/message', { usage: usage(100, 10) }, T0 + 1),
        ev(2, 'assistant/message', { usage: usage(200, 20) }, T0 + 2),
        ev(3, 'session/title', { title: '对端会话' }, T0 + 3),
        ev(4, 'assistant/message', { usage: usage(300, 30) }, T0 + 4),
        ev(5, 'assistant/message', { usage: usage(400, 40) }, T0 + 5),
      ],
    },
    {
      id: LOCAL,
      header: { id: LOCAL, cwd: '/work/shared', createdAt: T0 + 10 },
      sizeBytes: 300,
      events: [
        ev(0, 'request/header', { header: { config: { provider: 'local-p', model: 'local-m' } } }, T0 + 10),
        ev(1, 'assistant/message', { usage: usage(7, 1) }, T0 + 11),
        ev(2, 'assistant/message', { usage: usage(8, 2) }, T0 + 12),
      ],
    },
    {
      id: C,
      header: { id: C, cwd: '/work/shared', createdAt: T0 + 20 },
      sizeBytes: 500,
      events: [
        ev(0, 'request/header', { header: { config: { provider: 'peer-p', model: 'peer-m' } } }, T0 + 20),
        ev(1, 'assistant/message', { usage: usage(1000, 100) }, T0 + 21),
        ev(2, 'assistant/message', { usage: usage(2000, 200) }, T0 + 22),
        ev(3, 'request/header', { header: { config: { provider: 'local-p', model: 'local-m' } } }, T0 + 23),
        ev(4, 'assistant/message', { usage: usage(11, 3) }, T0 + 24),
      ],
    },
    {
      id: SENDER,
      header: { id: SENDER, cwd: '/work/shared', createdAt: T0 + 30 },
      sizeBytes: 200,
      events: [
        ev(0, 'request/header', { header: { config: { provider: 'local-p', model: 'local-m' } } }, T0 + 30),
        ev(1, 'assistant/message', { usage: usage(50, 5) }, T0 + 31),
      ],
    },
  ];

  const writeIndex = (entries) => {
    fs.writeFileSync(
      path.join(replicaDir, 'index.json'),
      JSON.stringify({
        schema: 1,
        sessions: entries.map((e) => Object.assign({
          deviceId: 'peer-device',
          sourceDeviceName: 'peer',
          workspacePath: '/work/shared',
          events: 0,
          bytes: 0,
          firstSeq: 0,
          lastSeq: 0,
          syncedAt: '2026-10-19T00:00:00.000Z',
          syncedSeq: null,
        }, e)),
      }),
      'utf8',
    );
  };
  // sender 游标（本机 → 对端）：绝不能当作排除依据。
  fs.writeFileSync(
    path.join(home, 'device-mesh', 'session-mirror.json'),
    JSON.stringify({ schema: 1, cursors: [{ sessionId: SENDER, deviceId: 'peer-device', cursorSeq: 1, backfilled: true }] }),
    'utf8',
  );

  const factsOf = (handle, id) => handle.store.entries.get(id).state.logFacts;
  const skippedOf = (handle, id) => handle.store.entries.get(id).state.remoteSkipped;
  const tokens = (facts) => facts.reduce((a, f) => a + f.tt, 0);
  const withHome = async (homePath, fn) => {
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = homePath;
    try { return await fn(); } finally {
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    }
  };

  writeIndex([
    { sessionId: A, lastSeq: 5, syncedSeq: 5 },
    { sessionId: C, lastSeq: 4, syncedSeq: 2 },
    { sessionId: GHOST, lastSeq: 42, syncedSeq: 42 },
  ]);

  await withHome(home, async () => {
    const harness = fakeCtx(corpus, []);
    const handle = createUsageStats(harness.ctx, {
      timeZone: 'Asia/Shanghai', autoBackfill: false, flushIntervalMs: 60000,
    });
    try {
      await handle.runBackfill();

      await test('镜像副本：边界内的事实不计（纯对端历史 → 0 事实）', () => {
        assert.equal(factsOf(handle, A).length, 0, '对端发出的请求不应计入本机账本');
        assert.equal(handle.store.entries.get(A).remoteBelow, 5, '账本要记住来源边界');
        assert.equal(skippedOf(handle, A).facts, 4);
        assert.equal(skippedOf(handle, A).tokens, 110 + 220 + 330 + 440);
        assert.equal(handle.store.entries.get(A).state.lastSeq, 5, '游标仍要推进（幂等键）');
      });

      await test('远程工作区：本机会话 cwd 在执行端路径也照常计', () => {
        assert.equal(factsOf(handle, LOCAL).length, 2);
        assert.equal(tokens(factsOf(handle, LOCAL)), 8 + 10);
        assert.equal(handle.store.entries.get(LOCAL).remoteBelow, undefined, '非副本不落边界字段');
        const row = handle.summaryPayload(new URLSearchParams('by=session')).rows.find((r) => r.key === LOCAL);
        assert.ok(row, '会话维应有本机会话行');
        assert.equal(row.cwd, '/work/shared', '工作目录保留原样');
        assert.equal(row.total, 18);
      });

      await test('接手/续跑：边界之后本机发出的事件照常计', () => {
        assert.equal(handle.store.entries.get(C).remoteBelow, 2);
        assert.equal(factsOf(handle, C).length, 1);
        assert.equal(tokens(factsOf(handle, C)), 11 + 3);
        assert.equal(skippedOf(handle, C).facts, 2);
        assert.equal(skippedOf(handle, C).tokens, 1100 + 2200);
      });

      await test('sender 游标不是排除依据（本机推给对端的会话照常计）', () => {
        assert.equal(factsOf(handle, SENDER).length, 1);
        assert.equal(handle.store.entries.get(SENDER).remoteBelow, undefined);
        assert.ok(handle.summaryPayload(new URLSearchParams('by=session')).rows.some((r) => r.key === SENDER));
      });

      await test('状态：mirrored 如实报告副本数 / 排除量；summary 不含纯副本会话', () => {
        const status = handle.statusPayload();
        assert.equal(status.mirrored.enabled, true);
        assert.equal(status.mirrored.available, true);
        assert.equal(status.mirrored.sessions, 3, '索引里的副本数（含未落地的 ghost）');
        assert.equal(status.mirrored.synced, 3);
        assert.equal(status.mirrored.excludedSessions, 2, '本机账本里按边界折叠的副本会话');
        assert.equal(status.mirrored.excludedFacts, 6);
        assert.equal(status.mirrored.excludedTokens, 110 + 220 + 330 + 440 + 1100 + 2200);
        assert.equal(status.mirrored.devices[0].name, 'peer');
        assert.equal(status.mirrored.devices[0].sessions, 3);
        const rows = handle.summaryPayload(new URLSearchParams('by=session')).rows;
        assert.equal(rows.some((r) => r.key === A), false, '纯对端历史的会话不应出现在会话维');
        assert.equal(rows.some((r) => r.key === C), true, '有本机事实的会话照常出现');
      });

      await test('重复回填幂等：第二次增量回填不改变任何数字', async () => {
        const before = handle.buildSessions().map((s) => s.logFacts.length);
        await handle.runBackfill();
        const after = handle.buildSessions().map((s) => s.logFacts.length);
        assert.deepEqual(after, before);
      });

      await test('边界推进：网格再同步一轮（syncedSeq 变大）会强制重折并清掉旧事实', async () => {
        // 边界 5 → 3：seq 4/5 回到「本机发出」？不——这里让边界**缩小**，模拟首次识别到
        // 边界（旧账本按无边界记过账）：重折后只保留 seq > 3 的事实（4、5 两条）。
        writeIndex([
          { sessionId: A, lastSeq: 5, syncedSeq: 3 },
          { sessionId: C, lastSeq: 4, syncedSeq: 2 },
          { sessionId: GHOST, lastSeq: 42, syncedSeq: 42 },
        ]);
        await handle.runBackfill();
        assert.equal(handle.store.entries.get(A).remoteBelow, 3);
        assert.equal(factsOf(handle, A).length, 2);
        assert.equal(tokens(factsOf(handle, A)), 330 + 440);
        assert.equal(skippedOf(handle, A).facts, 2);
      });
    } finally {
      harness.disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // 关闭开关 = 旧行为（全部计入）。
  await test('config.excludeMirroredSessions=false 时不做排除（可回退）', async () => {
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-mirror-off-'));
    fs.mkdirSync(path.join(home2, 'device-mesh', 'session-replica'), { recursive: true });
    fs.writeFileSync(path.join(home2, 'device-mesh', 'session-replica', 'index.json'), JSON.stringify({
      schema: 1,
      sessions: [
        { sessionId: A, deviceId: 'peer-device', sourceDeviceName: 'peer', lastSeq: 5, syncedSeq: 5 },
        { sessionId: C, deviceId: 'peer-device', sourceDeviceName: 'peer', lastSeq: 4, syncedSeq: 2 },
      ],
    }), 'utf8');
    await withHome(home2, async () => {
      const harness = fakeCtx(corpus, []);
      const handle = createUsageStats(harness.ctx, {
        timeZone: 'Asia/Shanghai', autoBackfill: false, flushIntervalMs: 60000,
        excludeMirroredSessions: false,
      });
      try {
        await handle.runBackfill();
        assert.equal(factsOf(handle, A).length, 4, '关闭开关后按旧行为全部计入');
        assert.equal(handle.statusPayload().mirrored.enabled, false);
      } finally {
        harness.disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
        try { fs.rmSync(home2, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  // 索引损坏：安全退化（不排除、不崩），并把错误如实报告在 status 里。
  await test('镜像索引损坏：安全退化（照旧记账），status 如实报错', async () => {
    const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-mirror-bad-'));
    fs.mkdirSync(path.join(home3, 'device-mesh', 'session-replica'), { recursive: true });
    fs.writeFileSync(path.join(home3, 'device-mesh', 'session-replica', 'index.json'), '{ not json', 'utf8');
    await withHome(home3, async () => {
      const harness = fakeCtx(corpus, []);
      const handle = createUsageStats(harness.ctx, {
        timeZone: 'Asia/Shanghai', autoBackfill: false, flushIntervalMs: 60000,
      });
      try {
        await handle.runBackfill();
        assert.equal(factsOf(handle, A).length, 4, '读不出索引就按旧行为记账，不整块漏账');
        const mirrored = handle.statusPayload().mirrored;
        assert.equal(mirrored.available, false);
        assert.ok(typeof mirrored.error === 'string' && mirrored.error.length > 0, '错误要如实回显');
      } finally {
        harness.disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
        try { fs.rmSync(home3, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  // 账本持久化往返：remoteBelow / remoteSkipped 必须落盘（否则每次重启都会重复折）。
  await test('持久化往返：remoteBelow 与排除计数写进 facts/*.json 并可读回', async () => {
    const home4 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-mirror-store-'));
    fs.mkdirSync(path.join(home4, 'device-mesh', 'session-replica'), { recursive: true });
    fs.writeFileSync(path.join(home4, 'device-mesh', 'session-replica', 'index.json'), JSON.stringify({
      schema: 1,
      sessions: [{ sessionId: A, deviceId: 'peer-device', sourceDeviceName: 'peer', lastSeq: 5, syncedSeq: 5 }],
    }), 'utf8');
    await withHome(home4, async () => {
      const harness = fakeCtx(corpus, []);
      const handle = createUsageStats(harness.ctx, {
        timeZone: 'Asia/Shanghai', autoBackfill: false, flushIntervalMs: 60000,
      });
      try {
        await handle.runBackfill();
        handle.flush();
        const reloaded = new FactStore(path.join(home4, 'usage-stats')).loadSync();
        const entry = reloaded.entries.get(A);
        assert.equal(entry.remoteBelow, 5);
        assert.equal(entry.state.remoteSkipped.facts, 4);
        assert.equal(entry.state.remoteSkipped.tokens, 1100);
      } finally {
        harness.disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
        try { fs.rmSync(home4, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });
}

/* --------------------------------------------------------------- main ---- */

async function main() {
  const started = Date.now();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-selftest-'));

  try {
    await sectionA();

    let corpus = loadCorpus(LIMIT || (QUICK ? 12 : 0));
    if (corpus.sessions.length === 0) {
      notes.push(`未在 ${SESSIONS_ROOT} 找到会话日志，B 段跳过`);
    } else {
      await sectionB(corpus);
      await sectionC(corpus, tmpRoot);
      await sectionD(corpus, tmpRoot);
      await sectionE(corpus);
    }
    // F 段只用合成语料，不依赖本机真实会话（执行端镜像边界）。
    await sectionF(tmpRoot);
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const ms = Date.now() - started;
  process.stdout.write(`\n${'-'.repeat(72)}\n`);
  for (const n of notes) process.stdout.write(`  · ${n}\n`);
  process.stdout.write(`\n  通过 ${passed} · 失败 ${failures.length} · 用时 ${(ms / 1000).toFixed(1)}s\n`);
  if (failures.length > 0) {
    process.stdout.write('\n失败明细：\n');
    for (const f of failures) process.stdout.write(`  - ${f.name}\n`);
    process.stdout.write('\nSELFTEST FAIL\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('\nSELFTEST PASS\n');
  }
}

main().catch((error) => {
  process.stdout.write(`\nSELFTEST CRASH: ${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});