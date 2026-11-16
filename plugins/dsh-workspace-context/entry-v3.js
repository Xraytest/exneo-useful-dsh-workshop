/**
 * 工作区常驻上下文（dsh-workspace-context）热挂入口 v3。
 *
 * v3（2026-10-31）相对 v2 的行为差异（实现都在 `../index.js` 与 `../store.js`）：
 *   新增**全局增量**——一条所有工作区共享的常驻上下文，存在存储根下的
 *   `global.md`（缺省 `$DSH_HOME/workspace-context/global.md`），人可以直接改
 *   （热生效），模型可用 `workspace_context` 工具 `scope: "global"` 读写，
 *   设置页/CLI 可走 `POST /dsh-workspace-context/save` 带 `{scope:"global"}`。
 *
 *   它与每工作区条目是**相加**关系，不是二选一：装配期先注入全局段
 *   `workspace:context:global`，再注入该工作区的 `workspace:context` 段；
 *   某工作区**没有**条目时，全局增量照样注入。全局段有独立字节预算
 *   （config.globalMaxBytes，缺省 8192），不占用各工作区自己的 maxBytes。
 *   全局增量没有单独启用位：清空正文即停用，或在插件 config 里
 *   `globalEnabled: false` 整体关掉注入。
 *
 * 回滚的正确姿势：entry-v* 只是 specifier 别名、**不是代码快照**——`?v=` 是模块缓存
 * 键：`./index.js?v=任意值` 读的都是磁盘上当前的 `index.js`。要真正回滚，先用备份
 * 覆盖 `index.js` / `store.js`，再写一个新标记的 entry 并把 patch 行的 name 指过去。
 *
 * @module dsh-workspace-context/entry-v3
 */

export * from './index.js?v=wctx-3';
