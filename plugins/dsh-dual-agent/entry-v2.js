/**
 * dsh-dual-agent —— host 半边 v2（入口换名 + 模块标记：loader 按 specifier 缓存）。
 *
 * 为什么要换 marker：Node 的 ESM 缓存以**完整 URL**为键，`index.js?v=da-2` 一旦
 * 在宿主进程里 import 过，改动 index.js 内容也不会重新求值。每次改 host 实现都要
 * 递增下面的 `?v=` 标记，再 remove → install 本 bundle。
 *
 * v2（2026-10-29 用户修订）：启动=武装待命（等用户键入初始指令）；执行者改为
 * 真 subagent（startActivation 的 continuable child）；用户手动停止回待命
 * （等待补充，不挑刺）；只有智能体主动停止才触发主上下文视角的报告评估。
 * running 期用户补充经服务面 sendMessage 转达给执行者。
 * row id 不变（dual-agent），name 指到本文件。
 *
 * @module dsh-dual-agent/entry-v2
 */
export * from './index.js?v=da-8';
