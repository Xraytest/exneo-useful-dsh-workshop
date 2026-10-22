/**
 * 缓存键外壳（第 3 代）。Loader 按 specifier 缓存模块：改 index.js 后必须换
 * 缓存键（新 entry + ?v= +1）并把 cordis.patch.yml 里 `rea-mcp` 行指过来
 * （**保持 row id 不变**，loader 走 dispose→start）。只改 client.js 不需要：
 * 内容哈希供包，刷新页面即可。
 *
 * v3：+ /dsh-rea-mcp/workbench 直连路由（工作箱联动：只翻 masterEnabled）。
 */
export * from './index.js?v=rea-host-3';
