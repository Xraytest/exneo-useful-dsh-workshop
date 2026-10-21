#!/usr/bin/env node
/**
 * dsh-usage-stats / prewarm — 离线重建用量账本（可脱离 DSH 运行）。
 *
 *   node prewarm.mjs                       # 扫 $DSH_HOME/sessions 并入账
 *   node prewarm.mjs --dry-run             # 只统计不写盘
 *   node prewarm.mjs --root /backup/sessions --zip ~/exports
 *   node prewarm.mjs --replace             # 丢弃日志事实重建（aux 保留）
 *   node prewarm.mjs --tz Asia/Shanghai --week-start 1
 *
 * 用途：
 *   ① 立刻恢复插件上线前的历史用量（同一个 fold.js，与运行时口径完全一致）；
 *   ② 给下次 DSH 启动预热存储——已折叠会话带 sizeBytes 指纹，启动回填会跳过重读；
 *   ③ 把别的 DSH home / 导出的归档 zip 并进同一本账（来源等级：语料 > 备份根 > zip）。
 *
 * 幂等：日志只追加，游标 lastSeq 保证重复运行不重复计账；aux（实时补记）永不丢。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { aggregate, foldEvents } from './fold.js';
import { FactStore } from './store.js';
import {
  inheritedCutFromEvents, readLogFile, sessionLogsFromZip, sessionMetaFromHeader, walkSessionRoot,
} from './rawlog.js';
import { loadMirrorIndex, normalizeSessionId } from './mesh-mirror.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const values = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  return out;
};

const HOME = os.homedir();
const DSH = process.env.DSH_HOME || path.join(HOME, '.dsh');
const ROOTS = values('--root');
if (ROOTS.length === 0) ROOTS.push(path.join(DSH, 'sessions'));
const ZIPS = values('--zip');
const OUT = value('--out', path.join(DSH, 'usage-stats'));
const TZ = value('--tz', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
const WEEK_START = Number(value('--week-start', '1'));
const DRY = flag('--dry-run');
const REPLACE = flag('--replace');
const QUIET = flag('--quiet');

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '0');

function say(line) { if (!QUIET) process.stdout.write(`${line}\n`); }

/** 镜像索引里某条会话的来源边界（seq；-1 = 不是副本）。 */
function floorOf(mirror, id) {
  if (mirror === null) return -1;
  const hit = mirror.byId.get(normalizeSessionId(id));
  return hit !== undefined && Number.isFinite(hit.floor) ? hit.floor : -1;
}

function foldLogInto(entry, header, events, source, sizeBytes, force, mirror) {
  // 设备网格镜像：本机 sessions/ 里对端会话副本的请求不是本机发出的，按来源边界排除
  // （与运行时 index.js 同口径、同一条 fold.js 路径）。
  const floor = floorOf(mirror, entry.id);
  const previous = typeof entry.remoteBelow === 'number' ? entry.remoteBelow : -1;
  if (force || floor !== previous) {
    entry.state.lastSeq = -1;
    entry.state.route = null;
    entry.state.logFacts = [];
    entry.state.gaps = { noUsageMessages: 0, searchRequests: 0, titleRequests: 0 };
    entry.state.remoteSkipped = { facts: 0, tokens: 0 };
  }
  if (floor >= 0) entry.remoteBelow = floor; else delete entry.remoteBelow;
  const inheritedBelow = inheritedCutFromEvents(events);
  entry.header = Object.assign({}, sessionMetaFromHeader(header, entry.id), entry.header || {});
  entry.source = source;
  if (typeof sizeBytes === 'number') entry.sizeBytes = sizeBytes;
  const added = foldEvents(entry.state, events, { inheritedBelow, remoteBelow: floor });
  entry.foldedAt = Date.now();
  return added;
}

function main() {
  const store = DRY ? new FactStore(path.join(os.tmpdir(), `dsh-usage-prewarm-${process.pid}`)) : new FactStore(OUT);
  store.loadSync();
  const MIRROR = loadMirrorIndex(DSH);

  let scanned = 0, addedFacts = 0, badLines = 0, failed = 0;
  const failures = [];

  for (const root of ROOTS) {
    let files = [];
    try { files = walkSessionRoot(root); } catch (error) {
      failures.push(`${root}: ${error && error.message ? error.message : error}`);
      continue;
    }
    say(`扫描 ${root} → ${files.length} 个日志文件`);
    for (const file of files) {
      scanned++;
      try {
        const stat = fs.statSync(file.filePath);
        const parsed = readLogFile(file.filePath);
        badLines += parsed.badLines;
        const id = (parsed.header && typeof parsed.header.id === 'string' && parsed.header.id) || file.sessionId;
        const entry = store.entry(id);
        addedFacts += foldLogInto(entry, parsed.header, parsed.events, 'corpus', stat.size, REPLACE, MIRROR);
        store.markDirty(id);
      } catch (error) {
        failed++;
        failures.push(`${file.filePath}: ${error && error.message ? error.message : error}`);
      }
    }
  }

  for (const zipDir of ZIPS) {
    let names = [];
    try { names = fs.readdirSync(zipDir).filter((n) => /\.zip$/i.test(n)); } catch (error) {
      failures.push(`${zipDir}: ${error && error.message ? error.message : error}`);
      continue;
    }
    say(`扫描归档 ${zipDir} → ${names.length} 个 zip`);
    for (const base of names) {
      const file = path.join(zipDir, base);
      try {
        const stat = fs.statSync(file);
        for (const log of sessionLogsFromZip(fs.readFileSync(file))) {
          const id = (log.header && typeof log.header.id === 'string' && log.header.id) || log.fallbackId;
          if (!id) { failures.push(`${base}:${log.entryName}: 无法确定会话 id`); continue; }
          const entry = store.entry(id);
          if (entry.source && entry.source !== 'zip') continue; // 语料优先，不重复计
          addedFacts += foldLogInto(entry, log.header, log.events, 'zip', stat.size, REPLACE, MIRROR);
          store.markDirty(id);
        }
      } catch (error) {
        failures.push(`${file}: ${error && error.message ? error.message : error}`);
      }
    }
  }

  if (!DRY) {
    store.meta.backfill = {
      startedAt: Date.now(), finishedAt: Date.now(),
      scanned, folded: scanned, skipped: 0, imported: 0,
      errors: failures.slice(0, 20).map((error) => ({ id: 'prewarm', error })),
    };
    store.markMetaDirty();
    const written = store.flushSync();
    say(`写盘：${written} 个会话文件 → ${OUT}/facts/`);
  }

  const sessions = [...store.entries.values()].map((entry) => ({
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
  const stats = store.stats();
  const byModel = aggregate(sessions, { by: 'model', timeZone: TZ, weekStart: WEEK_START });
  const byProvider = aggregate(sessions, { by: 'provider', timeZone: TZ, weekStart: WEEK_START });
  const byDay = aggregate(sessions, { by: 'day', timeZone: TZ, weekStart: WEEK_START });

  say('');
  say(`会话 ${fmt(stats.sessions)}（有账单 ${fmt(stats.withFacts)}）· 事实 ${fmt(stats.logFacts + stats.auxFacts)}（其中实时补记 ${fmt(stats.auxFacts)}）`);
  say(`总计 ${fmt(byModel.totals.total)} tokens · ${fmt(byModel.totals.calls)} 次调用 · 时区 ${TZ} · 周起始 ${WEEK_START === 1 ? '周一' : '周日'}`);
  say(`新折叠 ${fmt(addedFacts)} 条事实 · 解析失败行 ${fmt(badLines)} · 失败文件 ${fmt(failed)}`);
  if (MIRROR.available) {
    say(`网格镜像：${fmt(MIRROR.byId.size)} 条对端会话副本，按来源边界排除 ${fmt(stats.remoteSkipped.facts)} 次调用 / ${fmt(stats.remoteSkipped.tokens)} tokens（请求由对端设备发出）`);
  }
  say('');
  say('供应商：');
  for (const row of byProvider.rows) {
    say(`  ${row.key.padEnd(20)} ${fmt(row.total).padStart(14)} tokens  ${fmt(row.calls).padStart(8)} 次  ${row.sessions} 会话`);
  }
  say('');
  say('模型 top 10：');
  for (const row of byModel.rows.slice(0, 10)) {
    say(`  ${row.key.padEnd(34)} ${fmt(row.total).padStart(14)} tokens  ${fmt(row.calls).padStart(8)} 次`);
  }
  say('');
  say(`按日（${byDay.rows.length} 天）：`);
  const max = byDay.rows.reduce((m, r) => Math.max(m, r.total), 0) || 1;
  for (const row of byDay.rows) {
    const bar = '#'.repeat(Math.max(1, Math.round((row.total / max) * 40)));
    say(`  ${row.key}  ${fmt(row.total).padStart(14)}  ${bar}`);
  }
  if (stats.gaps.searchRequests > 0 || stats.gaps.noUsageMessages > 0) {
    say('');
    say(`已知缺口：联网搜索 ${fmt(stats.gaps.searchRequests)} 次（无 usage 可恢复）· 被打断消息 ${fmt(stats.gaps.noUsageMessages)} 条`);
  }
  if (failures.length > 0) {
    say('');
    say(`失败明细（前 10）：`);
    for (const f of failures.slice(0, 10)) say(`  - ${f}`);
  }
  say('');
  say(DRY ? 'PREWARM DRY-RUN OK' : 'PREWARM OK');
}

main();