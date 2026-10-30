/**
 * dsh-workbench —— host 半边 v2.1（工作箱 + 动作条目，透传属主 note）。
 *
 * v2   变更（2026-10-28）：工作列表从「纯开关条目」扩为「开关条目 + 动作条目」，
 *      /status 回包多出 actions 数组，新增 /action 转发路由。
 * v2.1 变更（2026-10-29）：status 探测回包的 note（属主阶段说明）透传给 client，
 *      动作行描述随阶段变化（如双主智能：待命→「请键入初始指令」）。
 * v1 的全部路由（/status /set /reset）与开关语义原样保留。
 * entry-v1.js 保留不删（历史版本）；patch 行 id 不变（workbench），name 指到本文件。
 *
 * @module dsh-workbench/entry-v2
 */
export * from './index.js?v=wb-4';
