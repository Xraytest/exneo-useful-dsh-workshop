/**
 * 工作区常驻上下文（dsh-workspace-context）热挂入口 v1。
 *
 * 组合层 loader **按 specifier 缓存模块**：原地改 `index.js` 不会让已加载的实例重新
 * 求值。故实现留在 `index.js`，本文件只做「带缓存标记的再导出」——换标记（或换
 * entry-v<N+1>.js）才会让 loader 重新求值，且**保持同一行 id** 时走 dispose→start，
 * 不会重复注册路由（本插件不发布服务，重挂安全）。
 *
 * 回滚的正确姿势：entry-v* 只是 specifier 别名、**不是代码快照**——把 patch 行的 name
 * 指回旧 entry 并不会退回旧代码（`index.js?v=…` 标记一变就是新代码）。要真正回滚，
 * 先用备份覆盖 `index.js` / `client.js`，再写一个新标记的 entry 并把 name 指过去。
 *
 * v1（2026-10-09 首版 + 同日修正）：
 *   - 装配期直注 section（system-prompt/assemble，{prepend:true}）；
 *   - 工具 workspace_context 的规范值统一过 `lossless()`（活体实测：read 精确命中时
 *     `inheritedFrom: undefined` 会被出厂判 INVALID_TOOL_OUTPUT）；
 *   - `{{…}}` 中和 + `</workspace-context>` 转义（正文安全注入）。
 *
 * @module dsh-workspace-context/entry-v1
 */

export * from './index.js?v=wctx-1';