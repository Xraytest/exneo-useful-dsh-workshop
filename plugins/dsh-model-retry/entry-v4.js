/**
 * 重试插件热挂入口 v4（fix-2：读路径限值净化、请求体跨块 UTF-8、drain 有界、build 标记）。
 * index.js（非热挂入口）同步指向本版，避免两条路径版本不一致。
 */
export * from './entry-v2.js?v=fix-2';
