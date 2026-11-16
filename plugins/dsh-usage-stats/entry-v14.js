/**
 * entry-v14.js —— 用量统计 · 最近一小时供应商总吞吐 + 页面描述精简
 *
 * 为什么再来一次（v10 → … → v13 → v14）：Cordis 的 loader 按 **specifier** 缓存模块，
 * 运行中的实例改磁盘上的 index.js / fold.js 不会重新求值。本文件以
 * `?v=throughput-hourly-1` 重新求值 index.js，整张图的下游 import 都带同一 TAG
 * （index.js → fold.js / store.js / rawlog.js / mesh-mirror.js，store.js → fold.js），
 * 于是新图里没有一个是旧实例。
 * 回滚：把 patch 行 name 指回 entry-v13.js，或重启 dsh（磁盘源码本身就是对的）。
 *
 * v14 相对 v13 的改动（两条都是用户提的）：
 *   1. **新增「最近一小时 · 供应商总吞吐」区**（工具条开关「最近一小时」，默认开，
 *      排在速率区之后、截断提示之前）。一张表按供应商给出**四个口径**，因为它们的分母
 *      不同、数字**必然有出入**——这正是本区存在的理由：
 *        - 单发 TPS  = Σ输出 / Σ生成时长        （与速率区 tpsAvg 同口径、同样本集）
 *        - 并发 TPS  = Σ输出 / 并流生成区间并集  （并行多条流时的有效吞吐）
 *        - 墙钟 TPS  = Σ输出 / 首末生成跨度      （含队列等待与空闲间隙）
 *        - tokens/h  = 总 tokens / 窗口小时数     （总吞吐，窗口内全部用量）
 *      区间刻意**不含 TTFT**：排队/首包延迟不是解码占用，含进来会让单条调用的
 *      「并发」反而低于「单发」。合计的并发分母取**全体**区间并集（多家同时在跑，
 *      不能把各家占用时间相加）。阈值与上界裁剪完全沿用速率区，两个区的 TPS 可直接对照。
 *      数据走独立路由 `/dsh-usage/hourly?windowMs=3600000`（10 分钟~7 天可调），
 *      **不跟着 by/range 走**（窗口是时间不是维度），所以浏览器半边单独取数、单独做过期
 *      响应守卫，并每 30s 自刷——「最近一小时」的数字必须跟着时间走。
 *   2. **精简页面内描述**：页头副标题从 4 句压到 1 句、速率区底部口径说明砍掉实测细节、
 *      状态行去掉「无用量可恢复 / 由对端设备发出」等重复解释、命中率弹窗底部口径说明
 *      压缩、维度不符红字去掉 stats-integration.mjs 的旧提示、速率区两张合计卡的悬停
 *      去掉与底部说明重复的阈值文案。工具条 title 保留必要信息但去冗。
 *   3. selftest 新增 2 项（fold 层 hourlyThroughput 口径 + `/dsh-usage/hourly` 路由），
 *      既有断言按新开关白名单（showHourly）更新；client-race-selftest 增加 R10
 *      （吞吐区自刷的过期响应与卸载清理），并把 mount() 改成收集 effect 清理函数
 *      ——定时自刷 effect 按 React 契约本就该返回清理函数。
 *
 * v14 之后的对抗验证（独立复算 + 证伪）抓出 4 个「同口径」没兑现的缺陷，已修：
 *   a. `tpsMeasurable` 多加了 TTFT 上界这道闸 → `singleTps` 样本集是速率区 `tpsAvg`
 *      的真子集。改为只按生成时长裁，与 addRate 逐条对齐（selftest 用 aggregate().tpsAvg 对账）。
 *   b. `samples` 原先数「带 r 字段的事实」，把不可测的短回复也算成样本 → 改为只数真正
 *      进 TPS 的样本（与 tpsSamples 同义）。
 *   c. `excluded` 把「低于下界」也记成「被上界裁掉」→ 改为只记生成时长超 5 分钟的。
 *   d. 生成区间没按窗口左边界裁剪（10 分钟窗口下 activeMs 可超出窗口 19%，且被
 *      activeShare 的 Math.min(1,…) 悄悄夹掉不报警）→ 要求生成区间完整落在窗口内
 *      （token/调用数仍按结束时刻计入），并给窗口加右边界挡住「未来」事实。
 *   另加固 shortNum（NaN 会渲染成 "NaN"）与 hourText（负数原样画出）两处界面防线，
 *   token 累加改走 hourlyNum，脏字段折成 0 而不是 NaN。
 */
export * from './index.js?v=throughput-hourly-1';
