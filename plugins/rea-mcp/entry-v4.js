/**
 * 缓存键外壳（第 4 份）。Loader 按 specifier 缓存模块：改 index.js 后必须换
 * 缓存键（新 entry + ?v= +1）并把 cordis.patch.yml 里 `rea-mcp` 行指过来
 * （**保持 row id 不变**，loader 走 dispose→start）。只改 client.js 不需要：
 * 内容哈希供包，刷新页面即可。
 *
 * v4: 状态改为按会话隔离（version 2：defaults + sessions 覆盖表），
 *     新增 /dsh-rea-mcp/effective 查询；/workbench、/save、/reset 接受 sessionId。
 */
export * from './index.js?v=rea-host-4';
