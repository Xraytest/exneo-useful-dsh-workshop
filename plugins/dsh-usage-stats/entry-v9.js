/**
 * entry-v9.js —— 用量统计 · 缓存占比（逐项 · 实测口径 + 覆盖度）
 *
 * 为什么要有这个文件（而不是直接改 index.js）：Cordis 的 loader 按 **specifier**
 * 缓存模块，运行中的实例改磁盘上的 index.js 不会重新求值。
 *
 * 注意 `?v=` 是**模块缓存键**，不是版本选择器：`./index.js?v=任意值` 读的都是**磁盘上
 * 当前的** index.js。所以本目录只保留**一个**入口（就是这个文件）；以前那串
 * entry-v2..v7 既不构成真正的历史回滚点，也不是「冻住旧实现」的手段，只会让人以为
 * 存在多版实现——2026-10-09 已清理（需要新入口时由
 * dsh-model-groups/stats-integration.mjs --live 重新生成，或照本文件复制一份换 TAG）。
 * 真正要「回到旧实现」只能从 git 历史取旧源码。本文件以
 * `?v=cache-share-4` 重新求值 index.js，而**整张图**的下游 import 都带同一个
 * `?v=cache-share-4`（index.js → fold.js / store.js / rawlog.js，store.js → fold.js），
 * 保证新图里不混入旧模块实例；组合行只改 `name`（**保持同一行 id**），
 * loader 走 dispose→start，实测热生效（改完 /dsh-usage/status 立刻变）。
 *
 * v7 相对 v6 的改动（v6 的口径把「不上报缓存的流量」按未命中摊进了分母）：
 *   1. 缓存占比改为**实测口径**：分母只算带 cacheReadTokens/cacheWriteTokens 的事实；
 *      另给 cacheCoverage（覆盖了百分之多少的计费输入）与 cacheUnknownInput。
 *      动机（对抗验证抓到的真实缺陷）：某会话真实命中率 96.4%，按旧分母被稀释成 25.9%。
 *   2. 去掉 dilution：total = 计费输入 + 输出（token 口径），它恒等于「输出占比」，
 *      与缓存定价无关，是误导性指标。
 *   3. CSV 两列真正**追加在末尾**（cacheShare / cacheCoverage），前 10 列与历史导出逐列一致。
 *   4. 修 UI：卡片在 data=null 时不再渲染 NaN%；悬停明细对无数据显示「无缓存数据」；
 *      明细表与逐项横条走同一条取值路径；覆盖度不足时标「覆盖 N%」。
 *   5. 清理死代码（旧 CacheBar 的 CSS、fold.js 的死赋值）与失真注释。
 *   6. v8：status 负载里把 groups 块挪回 facts 之后（dsh-model-groups 的
 *      stats-integration.mjs 以「facts 紧跟 groups」为锚点，挪开会让该工具的
 *      --check 误报未接入）；键顺序变化，语义不变。
 *   7. v9（第二轮对抗验证抓到的残留）：hover 明细不再对无数据行多嘴「覆盖 0.00%」；
 *      cacheMetrics 去掉不可达分支与失真注释；status.cache.known 更名 hasFacts
 *      （它只表示「折叠到过事实」，与缓存数据无关）；补 3 条变异法可杀的断言
 *      （cacheKnown 优先守卫 / 覆盖度提示边界）并把 CacheBars 纳入 CSS 覆盖测试。
 */
export * from './index.js?v=cache-share-4';
