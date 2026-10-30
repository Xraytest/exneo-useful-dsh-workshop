/**
 * dsh-dual-agent —— host 半边 v3 入口（入口换名 + 模块标记：loader 按 specifier 缓存）。
 *
 * v3（2026-10-30）：双线阻塞修正——执行者改用 `delivery:'caller'` 孵化：结算不再
 * 自动投递 settlement notice 唤醒主 Agent（那会让主 Agent 抢答一轮汇报、与挑刺轮
 * 双输出）；改由编排 await activation.result，把**报告原文 + 评估指令**合成恰一条
 * 消息注入主上下文——主 Agent 在整个任务期间只出现这一轮动作。真实内核沙箱 E2E
 * （19 断言 ×3 连跑全绿）验证：任务回合 0 条 assistant、执行者独立跑完、评估恰 1 轮、
 * 手动关闭不触发挑刺。
 *
 * 另：webServer 改为可选（ctx.get），headless/SDK 也能装载；新增 `dualAgent` 可编程
 * 服务面（status/transition/readiness），/action 与它共用同一 transition 实现。
 * row id 不变（dual-agent），name 指到本文件。
 *
 * @module dsh-dual-agent/entry-v3
 */
export * from './index.js?v=da-10';
