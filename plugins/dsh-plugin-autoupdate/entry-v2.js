/**
 * 版本化 entry（第 2 代）：link: 源更新改为 remove→install（pnpm 对 link:
 * 依赖「已满足」，直接 installBundle 报 ambiguous-install——先摘再装与设置页
 * 手工流程一致）。改 index.js 后照例 +1 新 entry。
 */
export * from './index.js?v=pau-host-2';
