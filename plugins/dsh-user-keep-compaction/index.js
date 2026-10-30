/**
 * 「用户消息完全保留」压缩规则（dsh-user-keep-compaction）— 稳定包入口。
 *
 * 实现已前移到同目录的 `./entry-v3.js`（v3 = 阈值/保留预算与出厂 compaction-basic
 * 同口径：min(窗口×0.8, 窗口−预留输出−headroom) 与 (窗口−预留输出)×0.16。
 * v2 只算 窗口×0.8，阈值系统性偏高，真实长会话里会被出厂引擎抢先压掉 user 消息）。
 * 更早的代次：entry-v2.js（半截事务兜底 end{error}、溢出恢复 prepend、配额按
 * sessionId 记账并在 idle 还清、agent 作用域取裁剪器、状态存储重读合并、
 * 状态路由补 diagnosics 字段）。
 * 之所以换文件名而不是原地改：组合层 loader 按 specifier 缓存模块，原地改
 * 已加载文件不会重新求值；换 name（保持同一行 id）才会走 dispose→start 热更新。
 *
 * 本文件只做再导出，任何按包入口 / 包名解析的引用（含三个自测脚本）继续有效。
 * 浏览器半边不受影响（client.js 由 dsh-client-hmr 就地热换，无需换名）。
 *
 * @module dsh-user-keep-compaction
 */

export * from './entry-v3.js';
