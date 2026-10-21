/**
 * dsh-settings-nav 热挂入口 v1。
 *
 * 组合层 loader **按 specifier 缓存模块**：原地改 `index.js` 不会让已加载的实例重新
 * 求值。故实现留在 `index.js`，本文件只做「带缓存标记的再导出」——换标记（或换
 * entry-v<N+1>.js）才会让 loader 重新求值，且**保持同一行 id** 时走 dispose→start，
 * 不会重复注册路由（webServer.register 对重复的 (kind,path) 会 throw，同一行 id 保证
 * 旧的先 dispose、路由先摘掉）。
 *
 * 回滚的正确姿势：entry-v* 只是 specifier 别名、**不是代码快照**——把 patch 行的
 * name 指回旧 entry 并不会退回旧代码（`index.js?v=…` 标记一变就是新代码）。要真正
 * 回滚，先用备份覆盖 `index.js`，再写一个新标记的 entry 并把 name 指过去。
 *
 * v1（2026-10-09 首版）：布局文档归一化 + revision 栅栏 + 冲突 409 + 三条同源路由。
 *
 * @module dsh-settings-nav/entry-v1
 */

export * from './index.js?v=nav-1';
