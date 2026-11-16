/**
 * 工作区常驻上下文（dsh-workspace-context）热挂入口 v2。
 *
 * v2（2026-10-09）相对 v1 的**行为差异只有一处**（实现都在 `../index.js`）：
 *   同源守卫收紧——`Origin: null` 按跨站拒绝，并新增 `sec-fetch-site: cross-site`
 *   拒绝。v1 沿用了 dsh-ultracode 那版守卫（`origin === 'null'` 放行），而本插件的
 *   写路由会把正文写进 system prompt，等价于一条可持久的 prompt 注入面：沙箱
 *   iframe / data: 页面正是发 `Origin: null` 的那一类，不能靠「读者拿不到响应」兜底。
 *
 * 回滚的正确姿势：entry-v* 只是 specifier 别名、**不是代码快照**——`?v=` 是模块缓存
 * 键：`./index.js?v=任意值` 读的都是磁盘上当前的 `index.js`。要真正回滚，先用备份
 * 覆盖 `index.js` / `client.js`，再写一个新标记的 entry 并把 patch 行的 name 指过去。
 *
 * @module dsh-workspace-context/entry-v2
 */

export * from './index.js?v=wctx-2';