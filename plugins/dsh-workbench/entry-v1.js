/**
 * 版本化 entry（第 1 代）。Loader 按 specifier 缓存模块——改 index.js（或它
 * import 的本地模块）后要新写 entry-v<N+1>.js（?v= 同步 +1）并把
 * cordis.patch.yml 里 `workbench` 行的 name 指过去（**保持 row id 不变**，
 * loader 走 dispose→start）。只改 client.js 不需要：内容哈希供包，刷新页面即可。
 */
export * from './index.js?v=wb-host-1';
