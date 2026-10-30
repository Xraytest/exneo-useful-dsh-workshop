/**
 * dsh-workbench —— host 半边 v3（新增「管理员权限通道」动作条目）。
 *
 * v3（2026-10-29 用户指令「启动通道的 UI 也放在工具箱内」）：动作表新增
 *       dsh-admin-channel 的开关行；status 探测回包的 hint（随阶段变化的悬停提示）
 *       透传给 client。工作箱仍然只编排：提权、UAC、会话生命周期全在属主插件。
 * v2.1 变更（2026-10-29）：note（属主阶段说明）透传给 client。
 * v1 的全部路由（/status /set /reset）与开关语义原样保留。
 * entry-v1/v2 保留不删（历史版本）；patch 行 id 不变（workbench），name 指到本文件。
 *
 * @module dsh-workbench/entry-v3
 */
export * from './index.js?v=wb-5';
