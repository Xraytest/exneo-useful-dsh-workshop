/**
 * dsh-admin-channel —— host 半边入口（v11）。
 *
 * v11（2026-11-07 用户指令「制作一个插件允许在 dsh 启动时请求管理员权限提供给会话
 * 可选开启权限时不需要再弹窗」）：**启动授权**（startup consent）。
 *   · DSH 一起来就弹**一次** UAC，拉起常驻提权进程（复用同一个 broker.ps1、同一套
 *     令牌 / PID 校验 / 管道 ACL，不复制任何提权逻辑）；
 *   · 之后任意会话拨「管理员权限通道」开关 = 挂载到这条常驻进程上，**零弹窗**；
 *   · 会话拨关 / 会话销毁 = 只摘挂载，常驻进程继续为其它会话服务；
 *   · 授权不可能比 DSH 进程活得更久：broker 只服务一个管道客户端，host 断开即自退；
 *   · 用户点了「否」→ 本进程内不再自动追问（declined），会话可另起自建通道；
 *   · startupConsent: false 可整体关闭本特性，回到「每会话拨开关才弹一次」。
 * v10（同日自审修正）：超大 timeout_ms 按不限时处理（防 Node 计时器溢出成 1ms），
 *   execTimeoutMs / maxExecTimeoutMs 上限放宽到 24h，与 broker 侧一致。
 * v9（2026-11-07 用户指令「去除隧道提权时间限制」）：隧道不再自带任何时间限制，
 *   uacTimeoutMs / idleTimeoutMs / execTimeoutMs / maxExecTimeoutMs 默认全部 0 = 不限时。
 * v8（2026-11-01）：idleTimeoutMs 支持 0 = 不限时。
 * v7：admin_exec 的 parameters 改为标准 JSON Schema。
 * v6：回环守卫、失败关闭、dispose 双形状、presentationMeta、stopping 拒开。
 * v5：绝对路径启动、cancel 文件、关闭确认语义、移除诊断路由。
 *
 * 为什么要有 entry-vN.js：Loader / Node ESM 都按**完整 URL** 缓存模块，
 * 改过 index.js 或 lib/*.js 后必须让 import 图的 URL 变化，否则运行中的实例
 * 继续跑旧代码。每改一次：新写 entry-v<N+1>.js 并把 `?v=` 加一，再把
 * cordis.patch.yml 的 name 指过去（row id 不变），最后 remove → install。
 *
 * @module dsh-admin-channel/entry-v11
 */
export * from './index.js?v=ac-11';
