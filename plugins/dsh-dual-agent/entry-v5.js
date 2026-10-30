/**
 * dsh-dual-agent —— host 半边 v5 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * 规则：宿主按**完整 URL** 缓存 ESM。entry-v4.js 一旦在进程里 import 过，
 * 改它内容（哪怕把里面的 ?v= 改了）也不会重新求值——所以每次 host 代码变更，
 * 新建 entry-v<N+1>.js 并把 patch 行指过去。
 *
 * v5（2026-10-30，round 6 体验强化）：
 *   · running note 带「已工作 X 分 Y 秒」（≥60s 才显示）——长任务的静默不再像卡死；
 *   · armed note 在 hatch.ready=false 时**显式警告**没有可用 provider，
 *     不再让用户键入任务后才撞上「孵化失败」。
 *
 * @module dsh-dual-agent/entry-v5
 */
export * from './index.js?v=da-11';
