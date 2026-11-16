/**
 * dsh-workbench — host 半边的版本化入口。
 *
 * 宿主按完整 URL 缓存 ESM，改 index.js 必须换入口文件名 + `?v=`，否则运行中的
 * 实例继续跑旧代码（README「维护」一节的规矩）。
 *
 * v12（2026-11-13）：ACTIONS 新增「上下文注入」开关（属主 dsh-inject-switch，
 * 二级菜单 /dsh-inject-switch/menu）。row id 与已有 route **都不动**。
 *
 * @module dsh-workbench/entry-v11
 */
export * from './index.js?v=wb-13';
