/**
 * dsh-settings-nav 热挂入口 v4。
 *
 * 组合层 loader **按 specifier 缓存模块**：原地改 `index.js` 不会让已加载的实例重新
 * 求值。故实现留在 `index.js`，本文件只做「带缓存标记的再导出」——换标记才会让 loader
 * 重新求值，且**保持同一行 id** 时走 dispose→start，不会重复注册路由
 * （`webServer.register` 对重复的 (kind, path) 会 throw；同一行 id 保证旧的先 dispose、
 * 路由先摘掉）。
 *
 * 回滚的正确姿势：`entry-v*` 只是 specifier 别名、**不是代码快照**——把 patch 行的
 * `name` 指回旧 entry 并不会退回旧代码（`index.js?v=…` 标记一变就是新代码）。要真正
 * 回滚，先用备份覆盖 `index.js`，再写一个新标记的 entry 并把 `name` 指过去。
 *
 * v1（2026-10-09 首版）：布局文档归一化 + revision 栅栏 + 冲突 409 + 三条同源路由。
 * v2（2026-10-11）：补 `export const inject = ['webServer']`。BUILD → nav-2。
 *   ⚠️ v2 当时的说法是「v1 缺这条声明 → apply 早于 webServer 就绪 → 三条路由静默不注册」。
 *   这个**机制**成立（cordis 只等 inject 声明过的 fiber），但那**次事故本身不可核实**：
 *   本谱系没有 pre-v2 快照，`index.js.bak-*` 与 v2 逐字节相同。别再当史实引用（README 6.1）。
 * v3（2026-10-13）三处对抗性复核后的加固，BUILD → nav-3：
 *   ① 同源守卫原先只比 `Origin` 与 `Host` 相等——两个头都是调用方填的，等于同义反复，
 *      DNS rebinding 页面能一路走到 409（live 复现过）。现在先要求 `Host` 是本机 authority
 *      （`isTrustedLocalAuthority`），再比 host 与 scheme-vs-实际传输。
 *   ② 文件存在但读不动**不再**被当成空文档：`state` 报 `exists:true` + `unreadable:true`，
 *      `/save` 与 `/reset` 一律 **503** 冻结写入——否则一次 `baseRevision:0` 的保存能用
 *      rename 覆盖它（rename 只要目录可写），盘上 revision 还会从 4 退回 1。
 *   ③ `readBody` 增加 15s 超时（408）。**超时不在 readBody 里 destroy 连接**：同步 destroy
 *      会把还没写出去的 408 一起重置，客户端只看到 `socket hang up`（真实走线实测）。
 *      状态映射也要显式认 `error.statusCode`，别把 408 压成 400。
 *   另：删掉惰性的 `cacheTtlMs` 配置项，超长分组名/超长 id 的截断改为记进 `issues`。
 * v4（2026-10-15）**schema 2：分组可嵌套（真正的多级结构）**，BUILD → nav-4：
 *   · `normalizeDocument` 改成递归：`group.items` 里既能放设置项 id 字符串，也能放
 *     子分组对象 `{type:'group', …}`，最多 `LIMITS.maxDepth`(5) 层（顶层分组为第 0 层）。
 *     顶层 `order` 的形状不变，所以 v3 写出来的老文件原样可读。
 *   · 深度与 id 账都是全树共享：嵌套里的重复 id 一样被丢弃并记 issue；越深的那一层
 *     整棵丢掉并记一条点明位置的 issue；`items` 里的数字/null/数组/未知 type 只丢自己。
 *   · 这条路径**只放宽**了「分组里能放什么」：形状级错误（根/order/条目数）的判定口径
 *     一点没变，坏文件仍然按坏文件处理（保留上次可用快照）。
 *
 * @module dsh-settings-nav/entry-v4
 */

export * from './index.js?v=nav-4';
