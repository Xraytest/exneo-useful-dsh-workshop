/**
 * dsh-dual-agent —— host 半边 v17 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * v17（2026-10-30，round 26）：多轮闭环升级——从「带上一轮注入消息」到「带评估结论史」。
 *   da-22 只带 lastCriticText（整条【挑刺者评估】注入消息，含执行者报告原文），
 *   有两个缺点：① 报告原文对下一轮执行者是噪音；② 只有 1 条，用户说「把前两个
 *   问题都修了」时执行者看不到更早的结论。
 *   现在改为捕获挑刺者每轮的**结论正文**（assistant/message，仅在 criticPending
 *   挂起期捕获，避免混入主 Agent 其它发言），保留最近 CRITIQUE_HISTORY_DEPTH(3) 条、
 *   每条截到 2K，孵化时作为「⟦最近几轮挑刺者评估结论⟧」块带进子 prompt。
 *   带的仍是编排自己的评估结论（非主 Agent 推理、不含报告原文），有界。
 *   验证：host-selftest ㉕ 扩到 11 项（含 6 连跑后历史仍 ≤3 条）；
 *   真实内核 E2E 场景⑩ 实证第二轮 executor prompt 头一块就是结论史。
 *
 * @module dsh-dual-agent/entry-v17
 */
export * from './index.js?v=da-23';
