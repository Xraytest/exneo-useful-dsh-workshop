/**
 * dsh-dual-agent —— host 半边 v7 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * v7（2026-10-30，round 8）：评估轮兜底——执行者报告送达后注入的【挑刺者评估】
 *   若因模型调用失败（额度/网络）没产出正文：自动重试一次；再失败用编排消息
 *   把情况讲明白（报告已在、评估暂不可用），不再让用户对着一条内部注入消息
 *   干等。用户手动打断评估轮（aborted）= 明确意图，静默清账不重试。
 *   ⚠ 投递必须等 whenIdle + 一拍宏任务：turn/end 观察点在**拆解窗口**里，
 *   微任务投递会落进 inbox 却被收尾中的旧回合吞掉唤醒（真实内核 E2E 实测到
 *   inbox/spliced 后无 turn/start）。idleThenDeliver 守住这个时机。
 *
 * @module dsh-dual-agent/entry-v7
 */
export * from './index.js?v=da-13';
