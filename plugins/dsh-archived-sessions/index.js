/**
 * 归档会话浏览器（dsh-archived-sessions）— host 包入口（stable entry）。
 *
 * 实现全在 `./entry-v6.js`。这里只做一层再导出，原因只有一个：
 * **loader 按 specifier 缓存模块，不认 ?query**——要让改过的 host 实现在
 * 运行中的 dsh 里生效，patch 行必须指向一个**新路径**
 * （`cordis.patch.yml` 里当前是 `./plugins/dsh-archived-sessions/entry-v6.js`）。
 * 于是把「随版本改动的实现」与「包入口」分开：
 *
 *   - `entry-v6.js` 当前实现（再改 → 写 `entry-v7.js` 并把 patch 行的 name 指过去）；
 *   - `index.js`    包入口（package.json 的 main/exports 指这里），
 *                   任何按包路径装载的用法都仍然可用，不会因改名而失效。
 *
 * 该拆分与 dsh-ofm-compat 的 `entry-v<N>.js` 是同一套路，只是这里用一层
 * 再导出把入口固定下来，避免入口文件本身进入「改名循环」。
 *
 * @module dsh-archived-sessions
 */

export * from './entry-v6.js';
