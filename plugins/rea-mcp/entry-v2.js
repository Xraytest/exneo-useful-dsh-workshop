/**
 * 缓存键外壳（第 2 代）。
 *
 * Cordis 的 Loader 按 specifier 缓存模块：改 `index.js` 后即使 dispose→start，
 * 运行实例仍然跑内存里那份旧模块。本 profile 的既有做法就是留一个只做转发的
 * entry 文件，用 `?v=N` 查询串换掉缓存键——**保持 patch 里的 row id 不变**
 * （`rea-mcp`），loader 才会走 dispose→start 而不是重复注册路由。
 *
 * 维护：改动 index.js（或它 import 的任何本地模块）后，把下面的 `?v=` 加一，
 * 然后重装本 bundle（`plugin_manager remove_bundle` → `install_bundle`）；
 * 只改 client.js 不需要这么做——它由内容哈希供包，刷新页面即可。
 */
export * from './index.js?v=rea-host-2';
