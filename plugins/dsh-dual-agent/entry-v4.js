/**
 * dsh-dual-agent —— host 半边 v4 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * 规则：宿主按**完整 URL** 缓存 ESM。entry-v3.js 一旦在进程里 import 过，
 * 改它内容（哪怕把里面的 ?v= 改了）也不会重新求值——所以每次 host 代码变更，
 * 新建 entry-v<N+1>.js 并把 patch 行指过去。
 *
 * v4（2026-10-30）：running 阶段 note 讲清「阻塞语义」——执行者独立工作、主对话
 * 让位（安静是正常）、补充会转达、结算后挑刺评估。避免用户把静默误读为卡死。
 * host 实现与 entry-v3 相同（同一 index.js，仅标记换 da-10）。
 *
 * @module dsh-dual-agent/entry-v4
 */
export * from './index.js?v=da-10';
