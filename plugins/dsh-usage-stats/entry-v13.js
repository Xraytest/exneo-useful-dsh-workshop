/**
 * entry-v13.js —— 用量统计 · 用量与速率分区 + 供应商标注按「展示名唯一性」判定
 *
 * 为什么再来一次（v10 → v11/v12 → v13）：Cordis 的 loader 按 **specifier** 缓存模块，
 * 运行中的实例改磁盘上的 index.js / fold.js 不会重新求值。本文件以 `?v=rate-model-dim-3`
 * 重新求值 index.js，整张图的下游 import 都带同一 TAG（index.js → fold.js / store.js /
 * rawlog.js / mesh-mirror.js，store.js → fold.js），于是新图里没有一个是旧实例。
 * 回滚：把 patch 行 name 指回 entry-v12.js，或重启 dsh（磁盘源码本身就是对的）。
 *
 * v13 相对 v12 的改动（两条都是用户实测后提出的）：
 *   1. **用量与速率完全分区**：明细表回到「只有 token 数值 + 缓存占比」（COLS 9 列），
 *      命中率弹窗也退回纯命中率；速率独立成一个「速率区」（RatePanel）——合计两张卡 +
 *      一张只有速率列的表（RATE_COLS：调用/样本/平均TTFT/中位TTFT/最快最慢/平均TPS/
 *      逐条均值TPS/中位TPS/剔除），排在整个用量区之后，工具条「速率区」开关可关。
 *      理由：速率与用量混在同一张表里，横向比较时眼睛要跨 6 列跳，读不准。
 *   2. **供应商标注的判据改成「展示名会不会撞车」**（host 两遍扫描：先算 alias，
 *      再数同一 alias 出现几次 → 行上给 sharedLabel）。
 *      这条修的正是 v12 的实际缺陷：v12 只按「同一**请求名**是否跨渠道」判，但本机实测
 *      `deepseek-v4.1-flash` / `deepseek-ai/deepseek-v4.1-flash` /
 *      `deepseek-ai/DeepSeek-V4.1-Flash` 三个写法解析出**同一个展示名**
 *      「DeepSeek V4.1 Flash」——按 v12 判据，其中独占一个请求名的行不带渠道后缀，
 *      四行里三行有 `@` 一行没有，看上去就像「混在一起」。现在：
 *        - 展示名在当前视图里唯一 → 不标注渠道（独家模型加后缀是噪声）；
 *        - 展示名会撞车（同名多渠道，或多个请求名解析出同一展示名）→ 一律标注，
 *          用模型设置里的 provider displayName（未配置则退回 provider key）。
 *      分桶**始终**按 (供应商, 请求名) 走，行上永远保留 provider / model / modelProviders
 *      拆分值 —— 标注只影响显示，不影响口径与 CSV。
 *   3. 速率的分组口径与用量**完全一致**：同一个「供应商×模型」条目集合、同一套标注规则，
 *      逐条各算自己的 TTFT / TPS（不是另起一套按供应商的速率分组）。
 *   4. selftest 57 项（E 段新增分区断言：速率表不得出现用量列、独家模型不得出现渠道后缀、
 *      撞车条目必须出现「供应商 · 请求名」副行；标注名链补「同名多渠道两行都标注且量各自
 *      独立」的正面用例）。
 */
export * from './index.js?v=rate-model-dim-3';
