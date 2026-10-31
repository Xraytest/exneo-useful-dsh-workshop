/**
 * entry-v12.js —— 用量统计 v11 的**第二个图代号**（同一份实现，只是缓存键换了）
 *
 * 为什么再来一次：v11 挂上后发现 store.js 的 `stats()` 漏了 `rateFacts` 返回值
 * （导致 status 的 rateCoverage.share 是 NaN→null）。修好磁盘上的 store.js 后，
 * 已缓存的模块图**不会**重新求值（loader 按 specifier 缓存），所以必须 bump TAG
 * 让整张图（index/store/fold/rawlog/mesh-mirror）以新实例重来一遍。
 *
 * 与 entry-v11 的差别只有 TAG（rate-model-dim-1 → rate-model-dim-2）；实现同源。
 * index.js / store.js 里所有下游 import 已同步改成 `?v=rate-model-dim-2`。
 *
 * v11/v12 的实现要点（相对 v10）：
 *   1. 模型维按「供应商␟模型」复合键分桶，同名模型跨供应商各成一行并标注供应商；
 *   2. 全维度平均速率：TTFT（首个内容时刻 − step/start）与 TPS（Σ输出 / Σ生成时长），
 *      含中位数、极值、样本数，以及上界裁剪（> 5 分钟不进均值，剔除条数如实透出）；
 *   3. 事实层新增可选 `r` 字段、游标新增 `state.start`（随账本持久化，保证增量==全量）；
 *   4. 老账本无 r 字段 → 速率显示「—」不当 0；status.rateCoverage 报覆盖度，
 *      「重建全部」补齐；
 *   5. 界面：速率总表（默认开）+ 明细表平均TTFT/平均TPS 两列 + 合计卡片两张 +
 *      弹窗扩为「命中率与速率」；CSV 末尾追加 13 列（前 12 列逐列不变）。
 */
export * from './index.js?v=rate-model-dim-2';
