#!/usr/bin/env node
/**
 * tests/windows_hide_selftest.mjs —— 静态扫描 `runtime/*.mjs` 里的子进程调用（issue #38 / #43）。
 *
 * 规则：Windows 上会创建控制台的 child_process 调用必须带 `windowsHide: true`；
 *       GUI 启动（`runtime/launch.mjs`，`detached: true` ⇒ libuv `DETACHED_PROCESS`）本无控制台，
 *       允许用 `detached: true` 替代。
 *
 * 为什么静态扫：issue #38 修了 `spawn` 族三处，同族的 `execFileSync` 两处漏到 #43 ——
 * 靠人肉记住「新加子进程调用要带 windowsHide」不可靠。
 *
 * 口径：只看 `runtime/*.mjs`（不含 `runtime/ext/` 下随包第三方代码）；字符串 / 注释先遮掉再做括号配对，
 * 所以 `exec(compile(...))` 这类**字符串里的 Python 代码**不会被误判成调用。
 *
 * 用法：node tests/windows_hide_selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(HERE, '..', 'runtime');
const METHODS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];


/** 判断 src[i] 的 '/' 是否为正则字面量起点（启发式：前一个非空白字符属于运算符/关键字）。 */
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const c = src[j];
  if ('([{,;:=!&|?+-*%<>~^'.indexOf(c) >= 0) return true;
  let k = j;
  while (k >= 0 && /[\w$]/.test(src[k])) k--;
  return /^(return|typeof|instanceof|in|of|new|delete|void|do|else|case|yield|await)$/.test(src.slice(k + 1, j + 1));
}

/** 把字符串字面量 / 行注释 / 块注释 / 正则字面量替换成空格（保留长度与换行），便于安全地找调用与配对括号。 */
function maskStringsAndComments(src) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += blank(src.slice(i, j)); i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      out += blank(src.slice(i, j)); i = j; continue;
    }
    // 正则字面量：不处理会被里面的引号带偏（例如 /['"]/ 会把后续代码全遮成"字符串"）。
    // 用"前一个非空白字符 / 关键字"这个常见启发式区分正则与除法。
    if (c === '/' && isRegexStart(src, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '\n') { j++; break; }        // 未闭合按行末收尾，避免吞掉整份文件
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { j++; break; }
        j++;
      }
      out += blank(src.slice(i, j)); i = j; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      out += blank(src.slice(i, j)); i = j; continue;
    }
    out += c; i++;
  }
  return out;
}

/** 从 openIdx 处的 '(' 起做括号配对，返回配对的 ')' 下标（找不到回 -1）。masked 里没有字符串，可直接计数。 */
function matchingClose(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const files = fs.readdirSync(RUNTIME).filter((f) => f.endsWith('.mjs')).sort();
let checked = 0;
const fails = [];
const scanned = [];

for (const file of files) {
  const src = fs.readFileSync(path.join(RUNTIME, file), 'utf8');
  const masked = maskStringsAndComments(src);

  // 找 child_process 的本地绑定：具名 import（含 as 改名）与 `const cp = await import('node:child_process')`
  const direct = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:child_process['"]/g)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      const local = bits[bits.length - 1].trim();
      if (local) direct.add(local);
    }
  }
  const aliases = new Set();
  for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\s*\(\s*['"]node:child_process['"]\s*\)/g)) {
    aliases.add(m[1]);
  }
  if (!direct.size && !aliases.size) continue;
  scanned.push(file);

  const patterns = [];
  for (const name of direct) patterns.push({ re: new RegExp('\\b' + name + '\\s*\\(', 'g'), label: name });
  for (const alias of aliases) patterns.push({ re: new RegExp('\\b' + alias + '\\s*\\.\\s*(?:' + METHODS.join('|') + ')\\s*\\(', 'g'), label: alias + '.*' });

  for (const { re, label } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked)) !== null) {
      // 跳过 `re.exec(` / `x.spawn(` 这类属性调用（我们要的是 child_process 的裸调用 / 命名空间调用）
      const before = m.index > 0 ? masked[m.index - 1] : '';
      if (/[.\w$]/.test(before)) continue;
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = matchingClose(masked, openIdx);
      if (closeIdx < 0) { fails.push(file + ':' + String(src.slice(0, m.index).split('\n').length) + ' ' + label + ' 括号没配对（扫描器无法判定）'); continue; }
      checked++;
      const call = src.slice(m.index, closeIdx + 1);
      const ok = /windowsHide\s*:/.test(call) || /detached\s*:\s*true/.test(call);
      if (!ok) {
        const line = String(src.slice(0, m.index).split('\n').length);
        fails.push(file + ':' + line + ' ' + label + ' 缺 windowsHide: true（或 detached: true）');
      }
    }
  }
}

if (fails.length) {
  console.log('windowsHide 静态自检：FAIL（' + String(fails.length) + ' 项）');
  for (const f of fails) console.log('  x ' + f);
  process.exit(1);
}
console.log('windowsHide 静态自检：PASS（' + String(scanned.length) + ' 个 runtime 文件 / ' + String(checked) + ' 处 child_process 调用均带 windowsHide 或 detached）');
