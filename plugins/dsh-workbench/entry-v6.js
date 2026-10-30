/**
 * dsh-workbench —— host 半边 v6（v3.3 执行者活性透传）。
 *
 * 规则同 dual-agent：宿主按完整 URL 缓存 ESM，改 host 实现要换 entry 文件名。
 *
 * v6 变更（2026-10-30）：status 探测回包多透传 `childLive` / `childStatus`
 *   （属主 running 中的执行者活性）；client 真值合并同步这两个字段，离开
 *   running 时清掉，避免残留上一轮状态。属主 note 已带人话后缀，这两个字段
 *   供客户端做更细的呈现（如徽标变色）。
 * v5 变更：透传 hatchAt（客户端每秒渲染「已工作 X 分 Y 秒」）。
 * v4 变更：开关 checked 把 armed 算「已启用」；徽标用属主 runningLabel。
 *
 * @module dsh-workbench/entry-v6
 */
export * from './index.js?v=wb-8';
