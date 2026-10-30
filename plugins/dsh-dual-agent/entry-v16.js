/**
 * dsh-dual-agent —— host 半边 v16 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * v16（2026-10-30，round 25）：多轮修正闭环。
 *   执行者是**零父上下文** subagent（不继承主会话历史）——这带来一个真实断点：
 *   第一轮评估后用户说「按上面的第 2 点改」，新执行者根本不知道「第 2 点」是什么，
 *   多轮修正循环断掉，用户只能手动粘贴上下文。
 *   修法：孵化时把**上一轮挑刺者评估**作为独立上下文块带进子 prompt（放在任务
 *   块之前，同样走 reportTextOf 的 12K 截断纪律，并明确标注「不是你自己的工作
 *   记录」）。带的只是编排自己的评估记录，不是主 Agent 的推理过程——闭环了，
 *   但没有变回继承式 subagent。
 *   验证：host-selftest ㉕（7 项：带上/有界/标注/滚动更新）+ 真实内核 E2E
 *   场景⑩（8 项，二轮 executor prompt 头一块就是上一轮评估）。
 *
 * @module dsh-dual-agent/entry-v16
 */
export * from './index.js?v=da-22';
