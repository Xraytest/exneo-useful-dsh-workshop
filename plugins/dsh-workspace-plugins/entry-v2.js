/**
 * 工作区插件容器（dsh-workspace-plugins）热挂入口 v2。
 *
 * entry-v* 只是 specifier 别名、**不是代码快照**：实现永远在 ./index.js。这里的
 * `?v=` 是**模块缓存键**（Node ESM 按完整 URL 缓存，查询串不同即从磁盘重读），
 * index.js 里对 ./store.js、./mount.js 的相对导入带着同一个标记——三者必须一致，
 * 否则只有一半模块被重读。改实现时：①三个 `?v=` 标记一起 +1，②index.js 的 BUILD
 * 一起 +1，③新写 entry-v<N+1>.js 并改 patch 行的 name。
 *
 * v2（2026-10-09）：新增「疑似全局泄漏」探针——挂载前后各取一次进程全局层的工具
 * 名，凭空多出来的名字记进该行诊断（设置页红字提示）。本插件唯一的承诺就是注册不会
 * 逃出会话作用域，这道探针把「万一逃了」变成可见信号。
 *
 * @module dsh-workspace-plugins/entry-v2
 */

export * from './index.js?v=wsp-2';
