/**
 * dsh-dual-agent —— host 半边 v10 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * v10（2026-10-30，round 15）：进程重启恢复提示。落盘 phase=running 的记录在
 *   新进程里一律降级 armed（child 不跨进程恢复），但用户看到的是通用待命文案，
 *   会以为任务还在跑。现在：
 *     · ensureRun 恢复时记 `recoveredFrom:'running'`，armed note 明说
 *       「上次的执行者已随进程重启被中断（不会自动恢复）。重新键入任务即可再次孵化」；
 *     · 用户发新任务（hatch）即清除该提示，不永久残留；
 *     · 落盘同步纠偏为 armed（setChild 之后再写回 running 是既有语义，正确）。
 *
 * @module dsh-dual-agent/entry-v10
 */
export * from './index.js?v=da-16';
