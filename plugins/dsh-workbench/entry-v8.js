/**
 * dsh-workbench —— host 半边 v8（管理员权限通道描述：授权时长不限）。
 *
 * 规则同 dual-agent：宿主按完整 URL 缓存 ESM，改 host 实现要换 entry 文件名。
 * v8 变更（2026-11-01）：ACTIONS 里 admin-channel 的描述随属主
 *   dsh-admin-channel 的 idleTimeoutMs=0（授权时长改为无限）更新，
 *   去掉「空闲超时关闭」的过期说法；无其它行为变化。
 * v7 变更（2026-10-30，round 27）：无 host 侧行为变化（client.js 才有），
 *   仅因 client 改动需要换 specifier 让浏览器侧热更生效。
 * v6 变更：透传 childLive / childStatus（执行者活性）。
 * v5 变更：透传 hatchAt（客户端每秒渲染「已工作 X 分 Y 秒」）。
 *
 * @module dsh-workbench/entry-v8
 */
export * from './index.js?v=wb-10';
