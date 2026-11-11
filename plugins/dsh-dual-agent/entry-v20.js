/**
 * dsh-dual-agent —— host 半边 v20 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * v20（2026-11-03，round 40）：**合并**——本插件从此叫「双智能指导」，一个开关
 * 总控三件事（原来分属两个插件）：
 *   ① 双主智能编排（原样）：执行者=后台 subagent，挑刺者=主上下文评估人格，
 *      armed→running→自然结算→恰一条【挑刺者评估】，手动停止不挑刺，重载自愈。
 *   ② 子代理模型链（原 dsh-subagent-models）：有序候选 + 每候选限额（请求数/混合
 *      token/不限）+ 失败自动回退 + 辅助调用计入 + 计入整会话供应池
 *      （ctx.provide('subagentModels') 的服务键保持不变，dsh-model-pool 照旧联动）。
 *      孵化执行者走**官方 spawn 通道** `request.agentOptions={provider,model}`
 *      （@deepseek-ai/dsh-subagent resolveChildAgentOptions：routeChanged 时内核自己
 *      清掉不匹配的 reasoningEffort）；请求期 agent/request 改路由留作嵌套子代理与
 *      回退的兜底——换路由时先问 llm.resolveModelInfo，目标模型支持才带 effort。
 *   ③ 主智能约束 + 出处程序核验（本次新增）：
 *      「插件使能则主会话的智能体不应亲自进行任何除判断以外的行为」＝根作用域
 *      tools.guard 按 exec.agent.id 精确拒绝主会话的受限调用（子代理不受影响；
 *      作用域链上 restrict 会连孩子一起摘，故不当权威，hideMainTools 只是可降级增强，
 *      装完立即回读子代理可见清单自检）；
 *      「子代理给出的信息必须标明出处并由流程化程序检查是否真实」＝报告里的
 *      ⟦证据⟧ JSON 块交给 dg-verify 逐条跑确定性检查（文件/会话日志/算术/可选 HTTP），
 *      核验块与挑刺评估拼成**同一条**消息进主上下文；主智能自己用 subagent/workflow
 *      工具派的活，结果落盘时由 tool/result 旁路核验，另投一条【程序核验】。
 *      核不了的一律写「无法核验」，绝不当成已证实。
 *
 * 交接：工作箱二级菜单的内容由本插件 `/dsh-dual-agent/menu`（GET spec / POST op）
 * 出，渲染在 dsh-workbench 的浮层里——工作箱继续「编排者，不实现」。
 *
 * @module dsh-dual-agent/entry-v20
 */
export * from './index.js?v=dg-1';
