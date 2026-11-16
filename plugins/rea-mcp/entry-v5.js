/**
 * 缓存键外壳（第 5 份）。Loader 按 specifier 缓存模块：改 index.js 后必须换
 * 缓存键（新 entry + ?v= +1）并把 cordis.patch.yml 里 `rea-mcp` 行指过来
 * （**保持 row id 不变**，loader 走 dispose→start）。只改 client.js 不需要：
 * 内容哈希供包，刷新页面即可。
 *
 * v5: 写入串行化 + 写前重读（并发保存不再整份覆盖别的会话的覆盖）；
 *     restrict 失败后 1s 退避重试（不再一直全量可见）；
 *     更高版本的状态文件只读、不降级回写。
 */
export * from './index.js?v=rea-host-5';
