/**
 * entry-v6.js — 诊断包装器（临时）。
 *
 * 目的：搞清楚为什么 cordis.patch.yml 的组合行已经指向 entry-v5.js、插件管理
 * 也报 fiberPhase=active，但运行时 /dsh-ukc/status 仍然回 entryVersion:4。
 *
 * 做法：全新文件名 ⇒ 全新 ESM URL ⇒ 强制宿主重新求值模块（同 URL 会被 Node 的
 * ESM 注册表缓存，重新 import 不会重跑顶层代码）。
 *   - 顶层写一行 loadtrace（证明模块真的被 import 了）；
 *   - apply 外包 try/catch，把真实异常栈写进同一个 log；
 *   - 其余导出原样转发给 entry-v5.js，所以它一旦启动成功，行为就是 v5。
 *
 * 这个文件只是探针，稳定之后应删掉并把组合行指回 entry-v5.js。
 */

import { appendFileSync } from 'node:fs';
import * as v5 from './entry-v5.js';

const LOG = 'D:/WorkSpace/dsh-probes/_tmp/ukc-v5/loadtrace.log';

function trace(message) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} pid=${process.pid} ${message}\n`);
  } catch {
    /* 诊断写不进去就算了，不能因此影响插件 */
  }
}

trace('v6: module evaluated (entry-v6.js imported)');

export const name = v5.name;
export const inject = v5.inject;

export const apply = (ctx, config) => {
  const shape = [
    `ctx=${ctx === null || ctx === undefined ? String(ctx) : typeof ctx}`,
    `inject=${typeof ctx?.inject}`,
    `effect=${typeof ctx?.effect}`,
    `on=${typeof ctx?.on}`,
    `get=${typeof ctx?.get}`,
    `webServer=${typeof ctx?.webServer}`,
    `sessions=${typeof ctx?.sessions}`,
    `logger=${typeof ctx?.logger}`,
    `config=${JSON.stringify(config ?? null)?.slice(0, 240) ?? 'null'}`,
  ].join(' ');
  trace(`v6: apply start ${shape}`);
  try {
    const result = v5.apply(ctx, config);
    trace(`v6: apply returned type=${typeof result}`);
    return result;
  } catch (error) {
    const detail =
      error === null || error === undefined
        ? String(error)
        : typeof error === 'object'
          ? `${error.name ?? 'Error'}: ${error.message ?? ''}\n${error.stack ?? ''}`
          : String(error);
    trace(`v6: apply THREW ${detail}`);
    throw error;
  }
};
