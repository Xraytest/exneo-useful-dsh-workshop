/**
 * 模型分组热挂入口 v5（ui-2：折叠状态落盘的可靠性修复 —— 有界目录创建、revision
 * 单调、/state 内联 warning+issues、impl 身份回显；客户端：孤儿项不回写、分组不可
 * 落盘时冻结折叠写盘、卸载/切后台补发、id 尺子与 host 同源）。
 *
 * 换文件名 = 换 specifier，loader 才会重新求值该模块（同 id 换 name 走 dispose→start，
 * 不会重复注册路由）；`?v=ui-2` 同时是 index.js → resolve.js 导入的标记，
 * 整张图（index / resolve）一起换新实例。
 *
 * **回滚的正确姿势**（entry-v* 只是 specifier 别名、**不是代码快照**：三份 entry 都
 * `export * from './index.js?<tag>'`，指向同一个物理文件，所以把 patch 行的 name 指回
 * entry-v4.js 并不会退回旧行为——本进程内若还留着 `index.js?v=ui-1` 的旧模块实例，
 * 会「此刻看似生效、重启后静默变回新版」）：
 *   1. 用备份覆盖现文件：`index.js.bak-uistate-20261009-012606`（以及需要时的
 *      `client.js.bak-*` / `resolve.js.bak-*`）；
 *   2. 新写一个入口（例如 entry-v6.js，内容 `export * from './index.js?v=rollback-ui';`
 *      ——**必须换新标记**，旧标记在本进程里可能仍命中缓存）；
 *   3. 把 cordis.patch.yml 里 `id: model-groups` 那一行的 name 指到新入口。
 * 核对线上跑的是哪张图：`GET /dsh-model-groups/state` 的 `impl`（= index.js?v=ui-2，
 * 带 query）；单看 `build` 只能证明 index.js 这一层的内容版本。
 */
export * from './index.js?v=ui-2';
