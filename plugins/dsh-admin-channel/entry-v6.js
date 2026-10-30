/**
 * dsh-admin-channel —— host 半边入口（v6）。
 *
 * v6（二次独立复核后的加固）：
 *   · 路由增加**回环来源**检查（除浏览器来源守卫外），webServer 即使监听局域网也
 *     只接受本机回环；
 *   · `agents` 服务缺失时**失败关闭**（不再让伪造 sessionId 占用唯一槽位）；
 *   · `agent/disposed` 同时兼容 payload {agent} 与直接 Agent 两种形状；
 *   · 工具按 Agent.id / Session.id 双候选解析通道键（运行时身份口径不同的兜底）；
 *   · `presentationMeta` 用结果值里的 cwd；
 *   · start 在既有记录处于 stopping 时拒绝（防「关-开」竞态删掉新记录）。
 * v5：绝对路径启动、cancel 文件、关闭确认语义、移除诊断路由。
 * v4：可注入 launcher + idleTimeoutMs 下限 5 秒。v2：标准 JSON Schema。
 *
 * 为什么要有 entry-vN.js：Loader / Node ESM 都按**完整 URL** 缓存模块，
 * 改过 index.js 或 lib/*.js 后必须让 import 图的 URL 变化，否则运行中的实例
 * 继续跑旧代码。每改一次：新写 entry-v<N+1>.js 并把 `?v=` 加一，再把
 * cordis.patch.yml 的 name 指过去（row id 不变），最后 remove → install。
 *
 * @module dsh-admin-channel/entry-v6
 */
export * from './index.js?v=ac-6';
