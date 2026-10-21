/**
 * 设备网格（dsh-device-mesh）— host 包入口（stable entry）。
 *
 * 实现全在 `./entry-v32.js`（v10 的能力 + 命令路由）。这里只做一层再导出：
 * **loader 按 specifier 缓存模块**——要让改过的 host 实现在运行中的 dsh 里热生效，
 * patch 行必须指向一个**新路径**。把「随版本改动的实现」与「包入口」分开后：
 *
 *   - `entry-v<N>.js` 当前实现（再改 → 写 `entry-v<N+1>.js` 并把 patch 行的 name
 *     指过去，**保持同一行 id**，loader 走 dispose→start 的同 id 路径）；
 *   - `index.js`      包入口（package.json 的 main/exports 指这里），
 *                     任何按包路径装载的用法都不因改名失效。
 *
 * **换 entry 路径还不够**：entry 里的**相对导入**也必须带 `?v=N` 查询串。
 * Node ESM 按完整 URL 缓存，查询串不同即视为另一个模块、会从磁盘重读。
 * 不带查询串的子模块会命中缓存、继续跑旧代码。改版时把这一组 `?v=N` 一起 +1
 * （`node bump-version.mjs` 会做一致性检查并统一重打）。
 *
 * @module dsh-device-mesh
 */

export * from './entry-v32.js';
