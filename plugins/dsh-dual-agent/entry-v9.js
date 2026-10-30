/**
 * dsh-dual-agent —— host 半边 v9 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * v9（2026-10-30，round 13）：执行者活性透出——running 中主对话按设计全程静默，
 *   用户唯一的安全感来源是「它到底还活着吗」。statusOf 增加只读探测：
 *     · childLive   ：执行者 agent 是否还在本进程 registry（false=已消失）；
 *     · childStatus ：执行者当前状态（running/idle…；idle=本轮已停等待编排结算）。
 *   并按活性给 running note 追加人话后缀（等待编排结算 / 已不在本进程），
 *   让「安静」与「出事」可分辨。探测全程 try/catch 吞异常回 null——status 是
 *   工作箱 8s 轮询的热路径，绝不允许抛。
 *
 * @module dsh-dual-agent/entry-v9
 */
export * from './index.js?v=da-15';
