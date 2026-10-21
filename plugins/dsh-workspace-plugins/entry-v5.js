/**
 * 工作区插件容器（dsh-workspace-plugins）热挂入口 v5。
 *
 * entry-v* 只是 specifier 别名、**不是代码快照**：实现永远在 ./index.js。这里的
 * `?v=` 是**模块缓存键**（Node ESM 按完整 URL 缓存，查询串不同即从磁盘重读），
 * index.js 里对 ./store.js、./mount.js 的相对导入带着同一个标记——三者必须一致，
 * 否则只有一半模块被重读。改实现时：①三个 `?v=` 标记一起 +1，②index.js 的 BUILD
 * 一起 +1，③新写 entry-v<N+1>.js 并改 patch 行的 name。
 *
 * v5（2026-10-09，对抗性评审后的一轮）：
 *   · 模块协议白名单——`data:`/`http:`/`node:` 这类标识一律拒绝（此前会被当包名交给
 *     import，等于写路由能让 host 执行任意代码）。
 *   · 访问令牌——浏览器请求必须带 `x-workspace-plugins-token`（经受鉴权的 index 注入），
 *     堵住 Origin/Host 自洽的 DNS rebinding；纯本机 curl 仍可直接用。
 *   · 响应序列化安全——先 stringify 再 writeHead；apiError 二次写有守卫（此前一个循环
 *     引用就能顺着「二次 writeHead → 未处理 rejection → fail-loud」把进程带走）；视图里
 *     的 config 统一过 jsonSafe 并标 configUnsafe。
 *   · agents.list() 读失败不再当成「没有活会话」（此前一次抖动会卸掉所有活会话）。
 *   · 失败/等待中的行会在刷新时**就地重试**（此前签名没变就永远不重试，只能强制重挂）。
 *   · 状态文件读坏时沿用上一份清单，不当成空。
 *   · 4xx 不再污染 lastError（`/status.ok` 不再被一次 403 卡成 false）。
 *   · 泄漏探针改为**会话级**（窗口按时间切，逐行归因会冤枉干净的行）。
 *
 * @module dsh-workspace-plugins/entry-v5
 */

export * from './index.js?v=wsp-5';
