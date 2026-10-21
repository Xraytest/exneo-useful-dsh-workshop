/**
 * 模型分组热挂入口 v4（ui-1：设置页折叠状态落盘 —— $DSH_HOME/model-groups-ui.json
 * + GET/POST /dsh-model-groups/ui，且 /state 内联 ui.collapsed）。
 *
 * 换文件名 = 换 specifier，loader 才会重新求值该模块（同 id 换 name 走 dispose→start，
 * 不会重复注册路由）；`?v=ui-1` 同时是 index.js → resolve.js 导入的标记，
 * 整张图（index / resolve）一起换新实例。
 *
 * 回滚：把 patch 行的 name 指回 ./plugins/dsh-model-groups/entry-v3.js。
 */
export * from './index.js?v=ui-1';
