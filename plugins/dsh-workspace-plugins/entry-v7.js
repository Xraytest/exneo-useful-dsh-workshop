/**
 * 工作区插件容器（dsh-workspace-plugins）热挂入口 v7。
 *
 * entry-v* 只是 specifier 别名、**不是代码快照**：实现永远在 ./index.js。这里的
 * `?v=` 是**模块缓存键**（Node ESM 按完整 URL 缓存，查询串不同即从磁盘重读），
 * index.js 里对 ./store.js、./mount.js 的相对导入带着同一个标记——三者必须一致，
 * 否则只有一半模块被重读。改实现时：①三个 `?v=` 标记一起 +1（含 mount.js 里对
 * store.js 的那处），②index.js 的 BUILD 一起 +1，③新写 entry-v<N+1>.js 并改 patch
 * 行的 name。
 *
 * v7（2026-10-10，网络工作区适配）：
 *   · **冷启动路由修复**——此前 apply 里 `ctx.get('webServer')` 只取一次，patch 的
 *     `- insert:` 行在启动期先于 webserver 行被应用时拿到 undefined，整段设置页路由
 *     被静默跳过：冷启动后 /dsh-workspace-plugins/* 全 404（挂载机制却一切正常，
 *     只有设置页一片报错）。改为 `ctx.inject(['webServer'], …)` 等它出现再注册，
 *     并把状态记进 `diagnostics.routes` 与 /status。
 *   · **按工作区身份绑定**——声明可以写 `workspace: <出厂注册表的工作区 id>`（跨设备
 *     一致），此时 path 只当线索：同一份声明在两台设备上都能对上同一个工作区，这是
 *     网络工作区（同一份工作区在多台设备各有路径）的正解。
 *   · **本机附加路径参与匹配**——读设备网格的工作区路径账目（deviceMesh.paths()），
 *     把该工作区在**本机**的 mirror/scratch 附加路径一并纳入匹配（`includeMembers:
 *     false` 可关）；远端设备上的那些路径永远不会被当成本机会话的 cwd。
 *   · **会话身份账**——命中判定先看本机 workspaceRegistry 的会话归属（最硬），再看
 *     路径精确命中，最后是子树最长优先；命中方式（session/path/主路径/附加路径）
 *     在设置页与 /state 里可见。
 *   · **网络维度可见**——/state 与设置页显示本机是哪台设备、接入了谁、每张工作区
 *     卡片的设备归属与远端副本、remoteOnly（本机没有路径因而永远挂不上）以及
 *     可行动的 hints（「请在 <设备> 上声明同一行」）；未命中测试会解释原因。
 *   · **行状态 unavailable**——网络工作区上「本机没有这个模块」的路径类子插件不再
 *     报成 failed，而是「本机没有」并给出在哪台设备上声明；模块真的修好后照旧自动重试。
 *   · mount.js 对 store.js 的导入补上同一个 `?v=`：此前它走无查询串的 URL，热重载后
 *     会与 index.js 各自持有一份 store.js 实例（匹配逻辑一新一旧，且无人察觉）。
 *
 * @module dsh-workspace-plugins/entry-v7
 */

export * from './index.js?v=wsp-7';
