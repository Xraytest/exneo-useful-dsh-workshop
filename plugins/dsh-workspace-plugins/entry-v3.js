/**
 * 工作区插件容器（dsh-workspace-plugins）热挂入口 v3。
 *
 * entry-v* 只是 specifier 别名、**不是代码快照**：实现永远在 ./index.js。这里的
 * `?v=` 是**模块缓存键**（Node ESM 按完整 URL 缓存，查询串不同即从磁盘重读），
 * index.js 里对 ./store.js、./mount.js 的相对导入带着同一个标记——三者必须一致，
 * 否则只有一半模块被重读。改实现时：①三个 `?v=` 标记一起 +1，②index.js 的 BUILD
 * 一起 +1，③新写 entry-v<N+1>.js 并改 patch 行的 name。
 *
 * v2：新增「疑似全局泄漏」探针（挂载前后比对进程全局层的工具名，多出来的记进该行
 *   诊断并在设置页标红）。
 * v3：模块解析口径对齐 loader —— ①`cordis:xxx` 走 loader 的 builtins 表（不是当 URL
 *   import，之前会报 "Received protocol 'cordis:'"）；②统一过 `unwrapExports`，使
 *   `export default plugin` 的模块也能挂（此前会挂出一个没有 apply 的 fiber）；
 *   ③探测接口回报 form/kind/unwrapped。
 *
 * @module dsh-workspace-plugins/entry-v3
 */

export * from './index.js?v=wsp-3';
