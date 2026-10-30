/**
 * dsh-dual-agent —— host 半边 v11 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * v11（2026-10-30，round 15）：**修复 GUI profile 下 HTTP 路由根本不注册的真 bug**。
 *   沙箱探针（WSPROBE）实测：GUI profile 里本插件 apply() 时刻
 *   `ctx.get('webServer')` 返回 **undefined**，要等 webserver 条目激活后才 present。
 *   旧代码在 apply 时同步取一次 → register 退化成 no-op → /dsh-dual-agent/* 全部
 *   404 → **工作箱开关在真实 GUI 里完全失效**（自测没抓到，因为 fake ctx 的
 *   webServer 一直立即可见）。
 *   修法：`whenWebServer()` 轮询等待服务出现（≤60s）再 register；路由 disposer
 *   收进 routeDisposers，插件卸载时一并拆。headless 没有该服务则超时放弃，
 *   程序化 `dualAgent` 服务面不受影响。
 *   附带：落盘 running 但会话不在本进程（幽灵态）时，note 不再宣称「执行者独立
 *   工作中」，改说实话并指向恢复入口。
 *
 * @module dsh-dual-agent/entry-v11
 */
export * from './index.js?v=da-17';
