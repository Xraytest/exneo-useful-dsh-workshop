/**
 * dsh-workbench —— host 半边 v5（v3.2 时长透传）。
 *
 * 规则同 dual-agent：宿主按完整 URL 缓存 ESM，改 host 实现要换 entry 文件名。
 *
 * v5 变更（2026-10-30）：status 探测回包多透传 `hatchAt`（属主 running 中的孵化
 *   时刻 epoch ms）；client 据此**每秒**渲染「已工作 X 分 Y 秒」（runningElapsed），
 *   不再依赖属主 note 里 8s 一跳的时长。属主 note 变稳定文案，两者互补不重复。
 * v4 变更：开关 checked 把 armed 算「已启用」；徽标用属主 runningLabel。
 * v3：动作表加 dsh-admin-channel 开关；status 透传 hint。v2.1：透传 note。
 *
 * @module dsh-workbench/entry-v5
 */
export * from './index.js?v=wb-7';
