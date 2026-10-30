/**
 * dsh-dual-agent —— host 半边 v18 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * v18（2026-10-30，round 27）：修「后台执行者已结束，前台仍显示执行中」。
 *   现场（同进程真会话 session-19c360e9）：17:46 孵化执行者，执行者 21:20 自然
 *   completed；落盘记录自 17:46 起一直 running+childId，主会话再无任何事件——
 *   报告没回来、评估没注入、按钮与回合标签永远停在「执行中」。
 *   根因：在途编排只活在本插件实例的 runs 里，await 着的 activation.result 也是
 *   实例私产；一次 profile 重载（装/更任何插件都重建插件实例）就把两者一起丢掉，
 *   而落盘记录仍写 running，/status 于是照抄记录宣称执行者还在工作。
 *   v18 起：
 *     · 落盘 childId 兼作一次性结算令牌（跨实例互斥，同一份报告只投一次）；
 *     · 任何时候都能用「活的执行者 + 落盘记录」把 running 收敛到真实情形——
 *       执行者还活着就重新接管并盯到它停；已结束就把它会话里的报告读回来照常
 *       评估，读不回来才诚实说明「报告未取回」；
 *     · /status 不再照抄记录：running 必须有可核对的活执行者，否则就是待命；
 *     · 会话事件不再只靠 WeakMap：用 session.id 兜底 + 懒恢复，重载后依旧能孵化。
 *   验证：host-selftest ㉖～㉚（幽灵 running、读回报告、重载接管、事件驱动恢复、
 *   不重复投递）；真实内核 E2E 场景⑪ 复现并验证。
 *
 * @module dsh-dual-agent/entry-v18
 */
export * from './index.js?v=da-24';
