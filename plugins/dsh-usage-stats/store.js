/**
 * store — 用量事实的持久化（纯 node，无 Cordis 依赖）。
 *
 * 布局（$DSH_HOME/usage-stats/）：
 *   state.json            全局：schema、导入索引、回填状态、模型设置名称索引
 *   facts/<sessionId>.json 每会话：游标 lastSeq、当前路由、标题、日志事实、实时补记事实
 *
 * 会话日志只追加，故「已折叠到的 seq」就是幂等键：同一段日志折两次结果相同。
 * 写入一律 tmp + rename（原子替换），避免半截 JSON。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createFoldState } from './fold.js?v=mirror-origin-1';

export const SCHEMA = 1;

const UNSAFE = /[^A-Za-z0-9._-]/g;

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** 会话 id → 安全文件名（保留原名，仅在含异常字符时加哈希后缀）。 */
export function safeFileName(id) {
  const raw = String(id);
  const safe = raw.replace(UNSAFE, '_');
  if (safe === raw && safe.length > 0 && safe.length <= 160) return safe;
  return `${safe.slice(0, 120)}__${djb2(raw)}`;
}

function writeAtomicSync(filePath, text) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

export function emptyEntry(id) {
  return {
    id,
    source: null,
    header: null,
    sizeBytes: null,
    // 设备网格镜像的来源边界（seq）。只在「本机 sessions/ 里是对端会话副本」时存在，
    // 见 fold.js::foldEvents 的 remoteBelow；undefined/null = 不是镜像副本。
    remoteBelow: null,
    foldedAt: 0,
    state: createFoldState(),
  };
}

export class FactStore {
  constructor(dir) {
    this.dir = dir;
    this.factsDir = path.join(dir, 'facts');
    this.statePath = path.join(dir, 'state.json');
    this.entries = new Map();
    this.dirty = new Set();
    this.metaDirty = false;
    this.meta = { v: SCHEMA, updatedAt: 0, backfill: null, imports: {}, modelSettingsNames: null };
    this.loadErrors = [];
  }

  /* ------------------------------------------------------------- load ---- */

  loadSync() {
    fs.mkdirSync(this.factsDir, { recursive: true });
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.meta = {
          v: SCHEMA,
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
          backfill: parsed.backfill || null,
          imports: parsed.imports && typeof parsed.imports === 'object' ? parsed.imports : {},
          // 「模型设置」展示名索引（由 host 半边刷新后写入；离线 preview 复用）。
          modelSettingsNames: parsed.modelSettingsNames && typeof parsed.modelSettingsNames === 'object'
            ? parsed.modelSettingsNames
            : null,
        };
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') this.loadErrors.push(`state.json: ${msg(error)}`);
    }
    let names = [];
    try { names = fs.readdirSync(this.factsDir); } catch (error) { this.loadErrors.push(`facts/: ${msg(error)}`); }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.factsDir, name);
      try {
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string') continue;
        const entry = emptyEntry(rec.id);
        entry.source = typeof rec.source === 'string' ? rec.source : null;
        entry.header = rec.header && typeof rec.header === 'object' ? rec.header : null;
        entry.sizeBytes = typeof rec.sizeBytes === 'number' ? rec.sizeBytes : null;
        entry.remoteBelow = typeof rec.remoteBelow === 'number' ? rec.remoteBelow : null;
        entry.foldedAt = typeof rec.foldedAt === 'number' ? rec.foldedAt : 0;
        entry.state = createFoldState({
          lastSeq: typeof rec.lastSeq === 'number' ? rec.lastSeq : -1,
          route: rec.route && typeof rec.route === 'object' ? rec.route : null,
          title: typeof rec.title === 'string' ? rec.title : null,
          logFacts: Array.isArray(rec.logFacts) ? rec.logFacts : [],
          auxFacts: Array.isArray(rec.auxFacts) ? rec.auxFacts : [],
          gaps: rec.gaps && typeof rec.gaps === 'object' ? rec.gaps : undefined,
          remoteSkipped: rec.remoteSkipped,
        });
        this.entries.set(entry.id, entry);
      } catch (error) {
        this.loadErrors.push(`${name}: ${msg(error)}`);
      }
    }
    return this;
  }

  entry(id) {
    const key = String(id);
    let entry = this.entries.get(key);
    if (!entry) { entry = emptyEntry(key); this.entries.set(key, entry); }
    return entry;
  }

  has(id) { return this.entries.has(String(id)); }

  markDirty(id) { this.dirty.add(String(id)); }
  markMetaDirty() { this.metaDirty = true; }
  get pending() { return this.dirty.size + (this.metaDirty ? 1 : 0); }

  /* ------------------------------------------------------------ stats ---- */

  stats() {
    let logFacts = 0, auxFacts = 0, withFacts = 0, folded = 0;
    const gaps = { noUsageMessages: 0, searchRequests: 0, titleRequests: 0 };
    const remoteSkipped = { facts: 0, tokens: 0 };
    const bySource = {};
    for (const entry of this.entries.values()) {
      const n = entry.state.logFacts.length + entry.state.auxFacts.length;
      logFacts += entry.state.logFacts.length;
      auxFacts += entry.state.auxFacts.length;
      if (n > 0) withFacts++;
      if (entry.state.lastSeq >= 0) folded++;
      const g = entry.state.gaps || {};
      gaps.noUsageMessages += g.noUsageMessages || 0;
      gaps.searchRequests += g.searchRequests || 0;
      gaps.titleRequests += g.titleRequests || 0;
      const rs = entry.state.remoteSkipped || {};
      remoteSkipped.facts += Number.isFinite(rs.facts) ? rs.facts : 0;
      remoteSkipped.tokens += Number.isFinite(rs.tokens) ? rs.tokens : 0;
      const src = entry.source || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;
    }
    return { sessions: this.entries.size, withFacts, folded, logFacts, auxFacts, gaps, remoteSkipped, bySource };
  }

  /* ------------------------------------------------------------ write ---- */

  serializeEntry(entry) {
    return JSON.stringify({
      v: SCHEMA,
      id: entry.id,
      source: entry.source,
      header: entry.header,
      sizeBytes: entry.sizeBytes,
      // undefined 会被 JSON 丢掉：只有镜像副本才落这个字段，普通会话的账本形状不变。
      remoteBelow: typeof entry.remoteBelow === 'number' ? entry.remoteBelow : undefined,
      foldedAt: entry.foldedAt,
      lastSeq: entry.state.lastSeq,
      route: entry.state.route,
      title: entry.state.title,
      gaps: entry.state.gaps,
      remoteSkipped: entry.state.remoteSkipped,
      logFacts: entry.state.logFacts,
      auxFacts: entry.state.auxFacts,
    });
  }

  flushSync() {
    if (this.dirty.size === 0 && !this.metaDirty) return 0;
    fs.mkdirSync(this.factsDir, { recursive: true });
    let written = 0;
    for (const id of this.dirty) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      try {
        writeAtomicSync(path.join(this.factsDir, `${safeFileName(id)}.json`), this.serializeEntry(entry));
        written++;
      } catch (error) {
        this.loadErrors.push(`flush ${id}: ${msg(error)}`);
      }
    }
    this.dirty.clear();
    if (this.metaDirty || written > 0) {
      this.meta.updatedAt = Date.now();
      try {
        writeAtomicSync(this.statePath, JSON.stringify(this.meta));
        this.metaDirty = false;
      } catch (error) {
        this.metaDirty = true;
        this.loadErrors.push(`flush state: ${msg(error)}`);
      }
    }
    return written;
  }
}

export function msg(error) {
  return String(error && error.message ? error.message : error);
}