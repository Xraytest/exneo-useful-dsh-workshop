/**
 * dsh-dual-agent —— host 半边 v6 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * 规则：宿主按**完整 URL** 缓存 ESM。entry-v5.js 一旦在进程里 import 过，
 * 改它内容也不会重新求值——每次 host 代码变更，新建 entry-v<N+1>.js 并指过去。
 *
 * v6（2026-10-30，round 7 体验强化）：时长显示职责归客户端——
 *   · status 透出 hatchAt（running 中=epoch ms，其它=null）作为权威锚点；
 *   · running note 变**稳定文案**（不再内嵌时长），避免 8s 轮询让时长一跳一跳；
 *   · elapsedLabel 纯函数删除（工作箱 client 自己每秒渲染，见 dsh-workbench
 *     client.js 的 runningElapsed）。
 * 阻塞语义、caller 结算、身份守卫与 v5 相同。
 *
 * @module dsh-dual-agent/entry-v6
 */
export * from './index.js?v=da-12';
