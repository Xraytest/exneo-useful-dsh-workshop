/**
 * dsh-workbench — host 半边的版本化入口。
 *
 * 宿主按完整 URL 缓存 ESM，改 index.js 必须换入口文件名 + \`?v=\`，否则运行中的
 * 实例继续跑旧代码（README「维护」一节的规矩）。
 *
 * v14（2026-11-20 用户指令「删除 双智能指导 …插件」）：ACTIONS 移除
 * dsh-dual-agent 行（属主插件已删，行 id 'dual-agent' 退役）。其余 row id 与
 * route **都不动**。
 *
 * @module dsh-workbench/entry-v13
 */
export * from './index.js?v=wb-15';
