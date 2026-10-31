/**
 * entry-v11.js —— 用量统计 · 模型维按「供应商×模型」分桶 + 平均速率（TTFT / TPS）
 *
 * 为什么要有这个文件（而不是直接改 index.js）：Cordis 的 loader 按 **specifier**
 * 缓存模块，运行中的实例改磁盘上的 index.js 不会重新求值。本文件以
 * `?v=rate-model-dim-1` 重新求值 index.js，而**整张图**的下游 import 都带同一个
 * TAG（index.js → fold.js / store.js / rawlog.js / mesh-mirror.js，store.js → fold.js），
 * 保证新图里不混入旧模块实例；组合行只改 `name`（**保持同一行 id**）。
 * 回滚：把 patch 行 name 指回 entry-v10.js（或重启 dsh，磁盘源码本身就是对的）。
 *
 * v11 相对 v10 的改动：
 *   1. **模型维分开同名模型的不同供应商**：by=model 的分桶键从「请求名」改成
 *      「供应商␟请求名」复合键（fold.js::compositeModelKey，分隔符 U+241F）。
 *      本机实测 `deepseek-v4.1-flash` 同时挂在 opencode-go（2.1 万次，聚合 127 tok/s）
 *      与 trae（2.3 千次，81 tok/s）下——原先合成一行，速率与单价差异被抹平。
 *      拆开后模型维 16 行 → 22 行；行上另给 provider / model / providerLabel 拆分值，
 *      标签解析链（别名 > 模型设置展示名 > 内置表 > 兜底美化）仍按**请求名**查，
 *      label 形如「DeepSeek-V4.1-Flash @ NewAPIGate」。
 *   2. **平均速率统计**（所有维度都有，逐项各自算）：
 *      TTFT = 首个内容时刻 − 请求起始时刻（step/start；重试取最后一条 retry-started）；
 *      TPS = Σ输出tokens / Σ生成时长（聚合口径，按耗时加权；另给逐条算术均值与中位数）。
 *      时间戳来自日志里 assistant/message 的 data.stream（本机实测 45,861/46,002 条可测）。
 *      诚实口径：TPS 阈值「生成 ≥ 500 ms 且输出 ≥ 32 tokens」（短回复的 tok/s 是噪声）；
 *      上界裁剪「> 5 分钟不进均值」（实测最长 3 小时 = 会话挂起/接手的污染点），
 *      被剔除的条数在 ttftExcluded / tpsExcluded 里如实透出，绝不当 0。
 *      事实层新增可选字段 `r = {f, g, o}`，折叠游标新增 `state.start`（随账本持久化，
 *      保证增量折叠与一次折完结果一致）。
 *   3. 账本读取向后兼容：改版前写入的事实没有 `r` 字段 → 该项速率不可测（显示「—」）；
 *      `/dsh-usage/status` 的 `rateCoverage` 如实报覆盖度，点「重建全部」补齐。
 *   4. CSV 新增 13 列**一律追加在末尾**（前 12 列逐列不变，位置解析器不受影响）：
 *      provider / model / ttftAvgSec / ttftMedianSec / ttftMinSec / ttftMaxSec /
 *      ttftSamples / ttftExcluded / tpsAvg / tpsMean / tpsMedian / tpsSamples / tpsExcluded。
 *   5. 界面：模型页签改为「模型（按供应商）」；新增**速率总表**（默认开，排在数值表后、
 *      明细表前，与命中率总表并列可开关）；明细表加「平均TTFT」「平均TPS」两列；
 *      顶部卡片加合计 TTFT / TPS；点名称的弹窗扩成「命中率与速率」（含中位数、样本数、
 *      剔除数、供应商与统计键）；视图偏好新增 `showRate` 一并持久化。
 *   6. selftest 57 项（新增「速率」1 项 30+ 断言；别名测试改钉新契约：同名跨供应商
 *      不合并；B 段「缺 time」断言口径修正为「带 seq 的可折叠事件必须带 time」，
 *      旧格式流分块行无 seq、不参与折叠，改记为观测行）。
 */
export * from './index.js?v=rate-model-dim-1';
