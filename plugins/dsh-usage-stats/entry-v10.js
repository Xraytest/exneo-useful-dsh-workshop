/**
 * entry-v10.js —— 用量统计 · 设备网格镜像的来源边界（只记本机发出的请求）
 *
 * 为什么要有这个文件（而不是直接改 index.js）：Cordis 的 loader 按 **specifier**
 * 缓存模块，运行中的实例改磁盘上的 index.js 不会重新求值。
 *
 * 注意 `?v=` 是**模块缓存键**，不是版本选择器：`./index.js?v=任意值` 读的都是**磁盘上
 * 当前的** index.js。所以本目录只保留**一个**入口（就是这个文件）；以前那串
 * entry-v2..v9 既不构成真正的历史回滚点，也不是「冻住旧实现」的手段，只会让人以为
 * 存在多版实现——需要新入口时由 dsh-model-groups/stats-integration.mjs --live 重新生成，
 * 或照本文件复制一份换 TAG。真正要「回到旧实现」只能从 git 历史取旧源码。
 * 本文件以 `?v=mirror-origin-1` 重新求值 index.js，而**整张图**的下游 import 都带同一个
 * `?v=mirror-origin-1`（index.js → fold.js / store.js / rawlog.js / mesh-mirror.js，
 * store.js → fold.js），保证新图里不混入旧模块实例；组合行只改 `name`（**保持同一行 id**），
 * loader 走 dispose→start，实测热生效（改完 /dsh-usage/status 立刻变）。
 *
 * v10 相对 v9 的改动：
 *   1. **只记「从当前设备发出的请求」**：执行端 sessions/ 里的对端会话历史副本
 *      （dsh-device-mesh §12.9 sessionSync 落盘）不再计入本机账本——那些 usage 是对端
 *      设备发出的请求，原先会把同一笔用量在两台设备上各记一次。
 *   2. 边界取接收端镜像索引 `$DSH_HOME/device-mesh/session-replica/index.json` 的
 *      `syncedSeq ?? lastSeq`；`seq <= 边界` 的事实排除并计入 `remoteSkipped` 观测，
 *      `边界之后`（本机接手/续跑）照常计。边界记在账本条目 `remoteBelow` 上。
 *   3. 方向只认接收端：本机推给对端的会话（sender 游标 session-mirror.json）不受影响。
 *   4. 新模块 mesh-mirror.js（纯 node，可离线复用）；prewarm / preview 走同一口径。
 *   5. `/dsh-usage/status` 新增 `mirrored` 块（副本数 / 来源设备 / 被排除的会话、调用与
 *      token）；设置页状态行显示「网格镜像排除 N 会话（M 次调用 / T tokens）」。
 *   6. `config.excludeMirroredSessions=false` 可关闭排除（回退旧行为）；索引缺失/损坏
 *      安全退化为不排除，并在 status 里如实报错。
 *   7. selftest 新增 F 段（10 项）钉住上述口径；48 项 → 58 项。
 */
export * from './index.js?v=mirror-origin-1';
