/**
 * dsh-model-groups 热挂入口（模块级修复后由主控生成）。
 *
 * 本 profile 未开模块热载，组合层 loader 按 specifier 缓存模块；原地改 index.js /
 * resolve.js 不会重新求值。本文件以 `?v=fix-1` 重新求值 index.js（其 resolve.js
 * 导入带同一标记），整张图换新实例；patch 行保持同一 id，loader 走 dispose→start，
 * 不会重复注册路由。
 *
 * 回滚：把 patch 行的 name 指回 ./plugins/dsh-model-groups/index.js。
 */
export * from './index.js?v=fix-1';
