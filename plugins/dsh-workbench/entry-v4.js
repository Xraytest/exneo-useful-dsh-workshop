/**
 * dsh-workbench —— host 半边 v4（v3.1 UI 细节 + checked 修正）。
 *
 * v4 变更：开关的 checked 也把 armed 算作「已启用」（与注释/契约一致）；
 *       client 的徽标改用属主 runningLabel（admin-channel =「已开启」），
 *       非双主智能的动作在属主没给 hint 时用中性提示，不再显示双主智能文案。
 * v3 变更（2026-10-29）：动作表新增 dsh-admin-channel 开关；status 透传 hint。
 * v2.1：透传 note。v1 路由原样保留。
 *
 * @module dsh-workbench/entry-v4
 */
export * from './index.js?v=wb-6';
