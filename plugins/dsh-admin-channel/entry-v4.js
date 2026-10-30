/**
 * dsh-admin-channel —— host 半边入口（v4）。
 *
 * v4：`lib/channel.js` 增加可注入的 launcher（生产仍是 UAC 那条；测试注入
 * 「直接起 broker」的 launcher，从而在无桌面、无 UAC 的沙盒里跑完整生命周期）；
 * idleTimeoutMs 下限放宽到 5 秒（便于沙盒测试；生产默认仍 30 分钟）。
 * v3：只读诊断路由 /dsh-admin-channel/diagnostics。
 * v2：输出 schema 改为标准 JSON Schema（顶层 required 数组）。
 *
 * 为什么要有 entry-vN.js：Loader / Node ESM 都按**完整 URL** 缓存模块，
 * 改过 index.js 或 lib/*.js 后必须让 import 图的 URL 变化，否则运行中的实例
 * 继续跑旧代码。每改一次：新写 entry-v<N+1>.js 并把 `?v=` 加一，再把
 * cordis.patch.yml 的 name 指过去（row id 不变），最后 remove → install。
 *
 * @module dsh-admin-channel/entry-v4
 */
export * from './index.js?v=ac-4';
