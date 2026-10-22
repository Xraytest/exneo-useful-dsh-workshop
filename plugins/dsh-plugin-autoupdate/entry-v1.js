/**
 * 版本化 entry（第 1 代）。改 index.js 后新写 entry-v<N+1>.js（?v= +1）并把
 * cordis.patch.yml 里 `plugin-autoupdate` 行指过去（row id 不变）。
 * 只改 client.js 不需要：内容哈希供包，刷新页面即可。
 */
export * from './index.js?v=pau-host-1';
