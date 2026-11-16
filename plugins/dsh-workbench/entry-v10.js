/**
 * dsh-workbench — host 半边 v10（按会话隔离的 REA 开关）。
 *
 * 规则同 dual-agent：宿主按完整 URL 缓存 ESM，改 host 实现要换 entry 文件名。
 * v10 变更（2026-11-12）：
 *   ① rea-mcp 的状态升到 v2（defaults + 按会话覆盖），这里同步：读文件时按
 *      本会话的家族根挑桶，不再看「那个全局的 masterEnabled」；
 *   ② /set 里驱动 REA 时**带上 sessionId**，并且状态没变就不发请求——
 *      v9 之前省略 sessionId，等于每次在本箱里动任意条目都顺手改全局 REA 开关
 *      （这正是「改一个上下文影响另一个上下文」的泄漏点）；
 *   ③ /reset 顺手清掉本会话的 REA 覆盖（回到 defaults 继承）；
 *   ④ status 的 rea 多透出 source（session/defaults/none）。
 * row id 与 route **都不变**。
 *
 * @module dsh-workbench/entry-v10
 */
export * from './index.js?v=wb-12';
