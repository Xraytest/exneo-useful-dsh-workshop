/**
 * dsh-dual-agent —— host 半边 v21 入口（换 entry 文件名 = 换 specifier = 强制热更）。
 *
 * v21（2026-11-05，用户需求「设置跨会话持久、按会话家族隔离、新会话继承」）：
 * 运行时设置从「全局一份」改为「模板 + 家族快照」双层：
 *   · 模板（template）= 原全局 settings：继续充当「最近保存的偏好」，落盘
 *     doc.settings，供新家族初始化时继承；settingsView() 无参 / dualAgent.settings
 *     仍回模板视图（既有键名与形状不变）。
 *   · 家族快照（family snapshot）= 按根会话（沿 parentSession 上溯，等价 dg-chain
 *     的 lineageRoot）各自保存一份完整 settings，落盘 doc.families[rootId]
 *     = { settings, since }（STATE_VERSION 保持 3，纯增量；上限 200 按 since 淘汰）。
 *   · 家族初始化（initFamily，幂等）只在**武装时刻**调用：transition 的 arm、
 *     ensureRun 的恢复分支、adoptChild 接管、autoArmForNewSessions，以及 apply()
 *     时对落盘里已有 armed/running 会话的升级遍历——a. 无快照从模板深拷贝落盘；
 *     b. 无自己的链且存在链模板 → chain.setChain 复制给它（计数天然归零）。
 *   · 链模板（chain template）= 最近一次**经二级菜单**配置的链，落盘
 *     doc.chainTemplate = { candidates, countAuxiliary, countTowardPool } | null；
 *     clear-chain → null；reset-counters 不动模板；程序化 chain.set 不碰模板。
 *   · 读取口径 settingsFor(sessionId)：家族有快照回快照、无回模板，**只读不物化**
 *     （/status 每 8s 轮询绝不写盘）。所有原读闭包 settings.xxx 的消费点
 *     （chain gate、enforce deps、shapeSections、hatchExecutor、runVerify、
 *     orchestrate 门、delegation 核验门、statusOf、transition 日志）全部按会话取。
 *   · setSetting(id, value, sessionId?)：带 sessionId → 写该家族快照 + 同步模板 +
 *     只对该会话定点重装 enforce/段；不带（程序化/e2e 沙箱兼容口径）→ 旧语义：
 *     写模板 + 所有家族快照 + 全部 runs 重装。
 * 用户价值：某会话（家族）里改设置不再影响其它会话已生效的策略；重启后偏好仍在；
 * 新会话武装时自动继承最近保存的偏好与最近配置的模型链。
 *
 * @module dsh-dual-agent/entry-v21
 */
export * from './index.js?v=dg-2';
