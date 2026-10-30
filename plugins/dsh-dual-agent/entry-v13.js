/**
 * dsh-dual-agent —— host 半边 v13 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * v13（2026-10-30，round 21）：挑刺者提示质量（对应用户原始诉求「发现更多的具有
 *   表现力的指标」）：
 *     · CRITIC_PROMPT 新增「指标的表现力是核心追求」段——逐轮找**更有表现力**的
 *       指标（更接近用户真实意图、更不容易被虚假达标蒙混、更易一句话判定），
 *       已用过的指标不原样重复，钝指标要换锋利表述；
 *     · 评估注入 prompt 同步要求「在 X 输入下必须返回 Y」式可判定表述，
 *       拒绝「功能要正确」这类空话；
 *     · 修掉 RUNNING_PROMPT 里的 **stale 机制描述**（v2 delivery:'parent' 时代的
 *       「带 settlement 通知的那个孩子」——caller 模式根本没有 settlement notice，
 *       报告由编排取回后注入）。模型-facing 文案说错机制会直接误导主智能。
 *   host-selftest ㉔ 用源码契约锁住这几条（防回退）。
 *
 * @module dsh-dual-agent/entry-v13
 */
export * from './index.js?v=da-19';
