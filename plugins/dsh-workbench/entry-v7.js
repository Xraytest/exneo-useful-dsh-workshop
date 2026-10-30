/**
 * dsh-workbench —— host 半边 v7（v3.4 文案改写透传 + client 侧「已停止→执行中」）。
 *
 * 规则同 dual-agent：宿主按完整 URL 缓存 ESM，改 host 实现要换 entry 文件名。
 * v7 变更（2026-10-30，round 27）：无 host 侧行为变化（client.js 才有），
 *   仅因 client 改动需要换 specifier 让浏览器侧热更生效。
 * v6 变更：透传 childLive / childStatus（执行者活性）。
 * v5 变更：透传 hatchAt（客户端每秒渲染「已工作 X 分 Y 秒」）。
 *
 * @module dsh-workbench/entry-v7
 */
export * from './index.js?v=wb-9';
