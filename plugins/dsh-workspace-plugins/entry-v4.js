/**
 * 工作区插件容器（dsh-workspace-plugins）热挂入口 v4。
 *
 * entry-v* 只是 specifier 别名、**不是代码快照**：实现永远在 ./index.js。这里的
 * `?v=` 是**模块缓存键**（Node ESM 按完整 URL 缓存，查询串不同即从磁盘重读），
 * index.js 里对 ./store.js、./mount.js 的相对导入带着同一个标记——三者必须一致，
 * 否则只有一半模块被重读。改实现时：①三个 `?v=` 标记一起 +1，②index.js 的 BUILD
 * 一起 +1，③新写 entry-v<N+1>.js 并改 patch 行的 name。
 *
 * v2：新增「疑似全局泄漏」探针（挂载前后比对进程全局层的工具名，多出来的记进该行
 *   诊断并在设置页标红）。
 * v3：模块解析口径对齐 loader —— `cordis:xxx` 走 builtins 表；统一 `unwrapExports`，
 *   使 `export default plugin` 的模块也能挂；探测接口回报 form/kind/unwrapped。
 * v4：修预导入窗口竞态——模块尚未就绪时不建挂载记录（旧行为会留下一条永久 failed，
 *   因为随后 sweep 时签名没变就不会重挂），改为什么都不做、由 refresh() 在 preload
 *   之后的 sweep 补挂。自测里新增一项专门复现这个窗口（并已做变异验证：去掉闸门
 *   该项即失败）。
 *
 * @module dsh-workspace-plugins/entry-v4
 */

export * from './index.js?v=wsp-4';
