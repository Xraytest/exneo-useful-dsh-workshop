/**
 * dsh-dual-agent —— host 半边 v14 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * v14（2026-10-30，round 23）：模型-facing 文案与实现对齐（续 round 21 的审计）：
 *   · RUNNING_PROMPT 原来要求主智能「如实转述编排给出的『已转达/转达失败』结论」，
 *     但实现的真实语义是**转达成功=静默**（无回执）、只有失败才发【双主智能编排】说明。
 *     承诺一个不存在的「已转达」回执会误导模型自己声明已转达。改为明说：
 *     「转达成功时编排保持静默…只有转达失败时你才会收到【双主智能编排】开头的失败说明」。
 *   · 删除死代码 RUNNING_TAIL（v2 delivery:'parent' 遗留，零引用）。
 *   host-selftest ㉔ 扩到 7 条源码契约（含这两条 + 死代码守卫）。
 *
 * @module dsh-dual-agent/entry-v14
 */
export * from './index.js?v=da-20';
