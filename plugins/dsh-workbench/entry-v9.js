/**
 * dsh-workbench —— host 半边 v9（双智能指导：动作条目更名 + 二级菜单声明）。
 *
 * 规则同 dual-agent：宿主按完整 URL 缓存 ESM，改 host 实现要换 entry 文件名。
 * v9 变更（2026-11-03，round 40）：
 *   ① ACTIONS 的 dual-agent 行随属主更名「双主智能」→「双智能指导」，描述改成
 *      合并后的实际语义（一个开关总控：主智能只判断 + 子代理模型链 + 出处核验）；
 *      row id 与 route 都**不变**（属主的路由面保持兼容，旧的调用方不受影响）。
 *   ② 新增 `menu`：声明这一行有**可进入的二级菜单**（GET spec / POST op 都由属主
 *      插件出，工作箱只按通用件渲染）。两处来源：ACTIONS 静态声明 + 属主 status
 *      回包里的 `menu`（属主回了就以属主为准，它才是知道自己在哪个路径出 spec 的）。
 *      statusOf 的白名单因此多了 menu 一项——不加就透不出去（工作箱一贯是白名单摘取）。
 *   ③ client 侧配合加二级菜单视图（返回/Esc 分层、乐观不涉开关、通用件 8 种）。
 * v8 变更（2026-11-01）：admin-channel 描述改「授权时长不限」（属主 idleTimeoutMs=0）。
 * v6/v5：透传 childLive/childStatus、hatchAt。
 *
 * @module dsh-workbench/entry-v9
 */
export * from './index.js?v=wb-11';
