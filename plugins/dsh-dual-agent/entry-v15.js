/**
 * dsh-dual-agent —— host 半边 v15 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * v15（2026-10-30，round 24）：模型-facing 文案审计（第三轮，前两轮见 da-19/da-20）：
 *   1. **CHILD_TASK_TAIL 删掉「中途结论也可以提前用文字小结」**：caller 模式下内核
 *      不给 child 追加 continuable return guidance（源码 `spec.delivery !== "caller"`），
 *      child 根本没有中途回传通道——那句话会诱导它产出没人看得见的中间文本。
 *   2. **停止情形人话化**（stopReasonLabel）：原文案对 error/max-tokens/refusal 也写
 *      「已完成任务（停止原因：error）」——自相表述会让挑刺者误判（沙箱真模型实测过
 *      stopReason:'error' 这条路）。现在 completed 才说「已完成任务」，其余说清
 *      「因错误中止（未完成）」等。
 *   3. **orphan note 去重**：正文已说清「会话不在本进程」，后缀又重复一遍。
 *   host-selftest ㉔ 契约扩到 12 条，把这三条不变量锁住。
 *
 * @module dsh-dual-agent/entry-v15
 */
export * from './index.js?v=da-21';
