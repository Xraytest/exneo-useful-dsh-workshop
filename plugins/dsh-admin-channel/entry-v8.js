/**
 * dsh-admin-channel —— host 半边入口（v8）。
 *
 * v8（2026-11-01 用户指令「将 UAC 插件授权时长改为无限」）：
 *   idleTimeoutMs 支持 **0 = 不限时**——不因闲置自动关闭通道；patch 里的
 *   idleTimeoutMs 已切到 0，通道只随会话销毁 / 用户拨关 / 插件卸载 / host
 *   退出而结束。status 回包新增 idleTimeoutMs 字段（0 = 不限时）。
 * v7（供应商 schema 报错修复）：admin_exec 的 parameters 从作者方言改为**标准
 * JSON Schema**（顶层 type:'object' + properties + required 数组）。
 * v6：回环守卫、失败关闭、dispose 双形状、presentationMeta、stopping 拒开。
 * v5：绝对路径启动、cancel 文件、关闭确认语义、移除诊断路由。
 *
 * 为什么要有 entry-vN.js：Loader / Node ESM 都按**完整 URL** 缓存模块，
 * 改过 index.js 或 lib/*.js 后必须让 import 图的 URL 变化，否则运行中的实例
 * 继续跑旧代码。每改一次：新写 entry-v<N+1>.js 并把 `?v=` 加一，再把
 * cordis.patch.yml 的 name 指过去（row id 不变），最后 remove → install。
 *
 * @module dsh-admin-channel/entry-v8
 */
export * from './index.js?v=ac-8';
