/**
 * dsh-model-retry 热挂入口（v2 修复后由主控生成）。
 *
 * 组合层 loader 按 specifier 缓存模块：entry-v2.js 被原地改过，必须换一个 specifier
 * 才会重新求值。patch 行保持同一 id（model-retry），loader 走 dispose→start。
 *
 * 回滚：把 patch 行的 name 指回 ./plugins/dsh-model-retry/entry-v2.js。
 */
export * from './entry-v2.js?v=fix-1';
