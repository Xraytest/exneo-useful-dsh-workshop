# 双主智能·沙箱测试计划与结果（已执行）

目标：在**独立沙箱**（新 DSH_HOME + 新 profile + 独立端口，绝不碰本机 profile）中
完整跑一遍双主智能，复现并修复用户观察到的缺陷。

## 用户观察到的缺陷

> 启用后主对话在收到用户指令后应该是**阻塞**的（创建子代理后主页面不会出现新的动作，
> 因为挑刺者只负责对结果处理）。但实际主窗口和子代理**同时运转**。

## 根因（已定位）

v2 用 `delivery:'parent'` 孵化执行者：执行者结算时内核投递 settlement notice
（`subagent-settled` 的 user 消息）到主会话，**唤醒主 Agent 自由汇报一轮**，随后
编排的挑刺评估又是一轮 → 主上下文出现 2 条 assistant，观感即「主窗口与子代理同时运转」。
早期还叠加「主回合未被压制」的问题；压制（孵化即在 `user/message` append 的同步观察点
`agent.cancel(keepInbox)`）已修，剩余的多轮来自 settlement 唤醒。

## 修复（主线 v3 起，当前 entry-v7 / da-13 / 插件 2.4.0）

执行者改用 `delivery:'caller'`：
- 内核 `notifySettlement` 对 caller 直接 return（源码核实），**不**投递 notice、
  不唤醒主 Agent；
- 编排 `await activation.result` 取回 `{output, stopReason}`，把**报告原文 + 评估指令**
  合成**恰一条**【挑刺者评估】plugin 消息注入主上下文 → 主 Agent 只跑这一轮；
- 手动停止 / disarm 先清 `childId`，结算时身份守卫吞掉评估（不挑刺）；
- 评估 prompt 内嵌报告文本（caller 下主会话本来看不到报告）。

后续体验轮次（v4→v7）：running note 讲清阻塞语义、`status.hatchAt` 时长锚点、
armed 就绪警告、评估轮失败自动重试一次+可读兜底（投递经 `idleThenDeliver` 等
whenIdle，绕开拆解窗口吞唤醒的坑）。

## 沙箱方案

- `DSH_HOME = D:\WorkSpace\_tmp\dual-agent-sandbox\home`
- 确定性离线 harness（不联网、不需凭据）：profile `e2e` = dsh-base + dsh-dual-agent
  + 驱动插件 dsh-dual-agent-e2e（同步注册假 LLM adapter `e2e-fake`）。一次进程内建
  真实父 Agent → `ctx.get('dualAgent').transition` 武装 → 人类 followup 任务 →
  订阅父会话事件流按时间线断言。
- 真实模型探针：profile `sandbox`（含 our-free-model）+ 驱动 config
  `realModel/realFull/realProvider/realModelId`，用 zcode 通道跑真 LLM。

## 测试矩阵与结果

### 确定性 E2E（假 adapter，真实内核）— 92 断言 ×2 连跑全绿（da-22）
- ① 任务阻塞主路径：任务回合 **0 条 assistant**、`turn/end reason=aborted`、
  **无 MAIN 模型调用**、执行者独立跑完、无 settlement 唤醒、评估恰 1 条、回 armed。
- ② 执行中补充：主页面静默、补充进**子会话**（直接读子会话消息核验）、
  释放后评估恰 1 条、running 时 `status.hatchAt` 是活 epoch（客户端时长锚点）、
  armed 时 `hatchAt=null`。
- ③ 执行中关闭：`off`、释放后**无**评估轮、无 MAIN 调用。
- ④ 连续多任务（平方→立方两轮）：每个任务回合 0 assistant 且 aborted、每轮恰 1
  评估、两次执行者、**全程无 MAIN**、两轮之间回到 armed（childId=null）。
- ⑤ 前缀防御：一条 `source.kind:'user'` 但文本以【挑刺者评估】开头的消息**不孵化**
  （停在 armed、无执行者）——评估注入绝不自我再触发。
- ⑥ 评估轮兜底（**本轮发现并修复的真实缺陷**）：让评估轮模型调用在零正文下抛错
  （`criticFailMode`），真实内核事件流证实——若重试只推**微任务**，投递会落进
  inbox（`agent/inbox/spliced` 出现）却**唤不起新回合**（其后无 `turn/start`）：
  turn/end 观察点在回合**拆解窗口**内，主循环「要不要起新回合」已判定过、唤醒被
  收尾中的旧回合吞掉，消息躺死。改为 `idleThenDeliver`（await `whenIdle()`+一拍
  宏任务）后：重试注入 2 次、兜底说明送达、无第三次（有界）、主回合全程静默。
- ⑦ 跨窗口隔离（**用户原话「我在另一个窗口使用时发现主窗口和子代理同时运转」的
  架构面复现**）：同一插件实例、两个武装父会话 A/B 并发跑各自任务。断言两个任务
  回合都 0 assistant + aborted（两条阻塞同时成立）、各恰一条评估注入、**报告不跨
  窗口**（读评估注入全文：A 的 ⟦执行者报告⟧ 只含「为窗口甲生成季度总结」、
  B 的只含「为窗口乙生成季度总结」，childId 亦不同）、全程无 MAIN、各自回 armed。
- ⑧ 角度抽取质量（host-selftest ⑲ 纯函数覆盖）：实测发现单字暗示词 '要' 会把
  「会议**要**点」误判成用户明确要求、'需' 把「所**需**资源」误判，导致整句任务
  复述被当成角度点名（等于把任务原样打回，对深化验证指标零信息量）。修为多字
  暗示词 + 长片段（>8 字）不当角度 + 内置维度角度扩到 10 条。
- ⑨ 多轮角度轮换（用户核心诉求「从多个角度修正」的机制验证）：同一 armed 会话
  连发 **12** 个任务，断言每轮任务回合 0 assistant + aborted（阻塞 12 轮不失守）、
  **前 10 轮点名角度互不重复**（用户原文无要求暗示词 → 正确落到内置维度池：
  隐含期望→逐字对齐→边界覆盖→指标明确→表现力→可复现性→过度声称→颗粒度→…）、
  **第 11/12 轮按 LRU 回收最早两个角度**（r11==r1、r12==r2，实测证据），
  全程无 MAIN、每轮结束都回 armed。角度重复即挑刺者失去「多角度」意义；
  池耗尽的回收路径（`nextAngle` 的 recycle 分支）由此覆盖。
- ⑩ 长报告截断（真实内核）：执行者吐出 40K+ 字报告 → 嵌进评估消息的被截到
  **12,329 字**、标注「省略 53207 字」、头尾（结论+收尾）保留、阻塞仍成立。
  防止长报告每轮往主会话上下文里整体灌一遍（烧 token + 爆上下文风险）。
- ⑪ 多轮修正闭环（真实内核）：二轮任务的执行者 prompt **头一块就是挑刺者评估结论史**
  （实测 secondHead 命中 `⟦最近几轮挑刺者评估结论 开始⟧`，且带的是挑刺者的**结论正文**
  `【挑刺者】评估：完整性角度仍有差距…`，不是带报告原文的注入消息）。没有它，零父
  上下文的执行者看不懂「按第 2 点改」甚至「把前两个问题都修了」，多轮循环断掉。
  带的只是编排自己的评估结论（非主 Agent 推理、不含报告原文），深度 3、每条 2K 有界。

- ⑩ 执行者活性（running 中「安静 ≠ 卡死」的可分辨性）：真实内核下 running 时
  `status.childLive=true` 且有 `childStatus`、busy 时不附加告警后缀；host-selftest
  ⑳ 另覆盖 idle（note 说「等待编排结算」）与 child 消失（note 说「已不在本进程」）
  两条分支，armed/off 时字段为 null。探测只读、异常全吞（status 是 8s 轮询热路径，
  绝不允许抛）。工作箱 host/client 同步透传并在离开 running 时清除这两个字段。

### GUI 组成完整回路（web-app composition，假 adapter）— 84/84 全过
`sandbox` profile（base + **web-app** + webserver + workbench + our-free-model +
dual-agent）里跑**全部 9 个场景**（与 headless 同等覆盖）：84 断言全绿——任务阻塞
0 assistant/aborted、执行者独立跑完、补充转达、关闭不挑刺、连续多任务、前缀防自
孵化、评估轮兜底、跨窗口报告不泄漏、12 轮角度轮换+LRU 回收、长报告截断。证明人格段
在**真实 GUI 会话的 agent** 上装得上、压制/转达/关闭/兜底/隔离全部成立——不只是
headless 组成成立。

### GUI HTTP 链路（真 web server，工作箱开关唯一路径）— 全 200
起 `sandbox` profile 真 GUI server，经 `POST /dsh-workbench/action
{actionId:'dual-agent',enabled:true/false}` 驱动属主（驱动先在同一进程用
`agents.create` 建活会话，ID 经 report.realSessionId 透出）：
- arm → 200 `phase:"armed"`（agentLive:true、hatch.ready、spawn）；
- `GET /dsh-dual-agent/status` → 200 一致；
- disarm → 200 `phase:"off"`。
**本轮据此抓到并修复一个真 bug**：探针插件 WSPROBE 实测 GUI profile 里
apply() 时刻 `ctx.get('webServer')` 为 **undefined**（webserver 条目后激活，
1.5s 后才 present）——旧代码同步取一次导致 `/dsh-dual-agent/*` 全部 404，
**工作箱开关在真实 GUI 里完全失效**（fake ctx 的 webServer 一直立即可见，
所以离线自测抓不到；必须起真 GUI server 打 HTTP 才暴露）。修为
`whenWebServer()` 懒注册（轮询等服务出现再 register，≤60s 超时；headless
无该服务则放弃，程序化 dualAgent 服务面不受影响）。修复后同上链路全 200。

### 真实模型探针（zcode GLM-5.3-Flash）— 13/13 全过
- `[real]` 8/8 全过：arm→armed、hatch-ready(spawn)、主回合 0 assistant（**真模型下阻塞成立**）、
  主回合 aborted、执行者孵化(running+child)、disarm→off、手动关闭不挑刺。
- `[real-full]` 5/5 全过（断言按**设计契约**覆盖两种终局）：任务回合主静默、评估注入≥1、
  「评估出正文」或「可读兜底」二选一成立、无无界重试（≤2 次注入）、回 armed。
- **本轮真模型新证据**：执行者以 `stopReason:'error'` 结算（`zcode: 账号在 GLM-5.3-Flash
  额度已用尽`，上游 200 空内容）后，会话事件流完整录下兜底链路：
  `turn#1 任务(aborted, 0 assistant)` → `turn#2 评估注入 → turn/end error` →
  `turn#3 自动重试注入 → turn/end error` → `turn#4 【双主智能编排】可读兜底 → turn/end error`
  → 状态回 armed。即 round-8 的「评估轮失败重试一次 + 可读兜底」在**真实内核 + 真实
  模型错误响应**下端到端成立（消息确实送达并成回合，不是躺死在 inbox）。
- 仍缺的样本：健康模型下「评估轮产出正文」一步（配额耗尽无法产出；已由假 adapter
  的 68 断言覆盖）。补跑需换有额度的模型/通道。

## 环境限制（如实记录）

- 免费通道 Spark-X2.6(loomy) 当前 region-blocked/throttled（egress CN，availability.json）；
- zcode 通道 GLM-5.3-Flash 探针执行期间额度耗尽 → 真模型「完整自然结算出评估正文」一步
  未拿到成功样本（阻塞、压制、评估注入本身都有真模型证据）。补跑需换有额度的模型/通道。

## Spark-X2.6 作为测试者（用户指定）—— 受阻于登录态，如实记录

- 通道包里确有 `spark-x`（loomy/讯飞，"Spark X2.5 · x0.1"）硬编码条目，但：
  - 它不在同步 feed / catalog（catalog 只有 8 个 *-free 模型，无 spark）；
  - loomy 登录方式是 `browser+sms`（微信扫码 / 短信），沙箱与本机都没有可用的
    loomy 会话凭证（session-map.json 里全是 our-free-model 会话）；
  - availability.json 里全部免费通道 region-blocked / throttled（egress CN）。
- 因此改用**沙箱里唯一可用的真实通道 zcode/GLM-5.3-Flash** 跑真模型探针；
  确定性的「评估轮真的产出正文」一步由假 adapter（e2e-fake）覆盖。
  补跑真模型完整回路需换有额度/已登录的模型（如 Spark-X2.6 扫码登录后）。

## 提示质量修正（round 21，da-19）

- **挑刺者「表现力指标」指令强化**（对应用户原始诉求「发现更多的具有表现力的
  指标」）：CRITIC_PROMPT 增加「指标的表现力是核心追求」段——逐轮找更有表现力的
  指标（更接近用户真实意图、更不易被虚假达标蒙混、更易一句话判定）、已用过的
  不原样重复、钝指标换锋利表述；评估注入 prompt 同步要求「在 X 输入下必须返回 Y」
  式可判定表述。
- **修掉 RUNNING_PROMPT 的 stale 机制描述**：v2 `delivery:'parent'` 时代写的
  「带 settlement 通知的那个孩子」在 caller 模式下是**假的**（没有 settlement
  notice，报告由编排取回后注入）——模型-facing 文案说错机制会直接误导主智能。
  改为「由编排把报告取回并送入本会话」。
- host-selftest ㉔ 用源码契约锁住这 5 条（防回退）。

## 提示与实现对齐审计（round 23，da-20）

延续 round 21 的「模型-facing 文案 vs 实现」审计，又抓到一处：
- **RUNNING_PROMPT 承诺了不存在的「已转达」回执**：原文要求主智能「如实转述编排给出
  的『已转达/转达失败』结论」，但 `relaySupplement` 的真实语义是**成功静默**（只写
  logger）、只有失败才 deliver【双主智能编排】失败说明。承诺不存在的回执会误导模型
  自己声明「已转达」。已改为明说成功静默、失败才有说明。
- **删除死代码 RUNNING_TAIL**（v2 `delivery:'parent'` 遗留，零引用）。
- ㉔ 契约扩到 7 条（含「不得承诺已转达回执」+ 死代码守卫）。

> 方法论：连续两轮（21/23）都在这类「prompt 描述了一个不存在的机制」上抓到真问题。
  机制变更（parent→caller）后必须回头核对所有模型-facing 文案。

## 提示审计第三轮（round 24，da-21）

- **CHILD_TASK_TAIL 删掉「中途结论也可以提前用文字小结」**：caller 模式下内核不给
  child 追加 continuable return guidance，child 没有中途回传通道——该表述会诱导
  它产出没人看得见的中间文本。改为只要求「收尾消息里给出自足的最终报告」。
- **停止情形人话化**（stopReasonLabel）：error/max-tokens/refusal 等不再说「已完成
  任务（停止原因：error）」这种自相表述，改为「因错误中止（未完成）」等。沙箱真模型
  实测过 stopReason:'error' 这条路（额度耗尽），挑刺者确实会收到这条。
- **orphan note 去重**：正文已说清「会话不在本进程」，后缀又重复一遍。
- ㉔ 契约扩到 12 条。

## 结算自愈（round 27 / v18，2026-10-30）

**报障**：后台子代理结束，前台仍显示「执行中」。

**实测取证**（本机 GUI profile，同一进程，未重启）：

| 会话 | 现象 | 结论 |
|---|---|---|
| `session-19c360e9` | 17:46 孵化 `12ac7695`；执行者 21:20 `completed`；主会话自 17:46 起零事件；`/status` 一直 `running` | 幽灵 running：结算回调随插件实例消失 |
| `session-ff511d07` | 执行者 19:16 正常结算并评估；之后 20:13/20:16/21:16 三条用户消息**没有孵化**（主 Agent 自己做了），20:43 才又孵化 | 重载后 `watchedSessions` 为空 → 不再认会话 |

**根因**：`runs` 与 `await activation.result` 都是插件实例私产；profile 重载
（`plugin_manager` 装/更任意 bundle 都会重建实例）把它们一起丢掉，落盘 `running`
从此无人收尾。

**修复**：`childId` 一次性结算令牌 + `reconcileSession` 三态收敛（接管活执行者 /
读回已结束执行者的报告 / 幽灵 running 收回待命）+ `/status` 真值化 + 会话事件
`session.id` 兜底懒恢复。

**验证**：

- `host-selftest.mjs` 扩到 **144 断言**，新增 ㉖～㉚ 共 18 条：
  - ㉖ 幽灵 running：status 立即 `armed`、落盘纠正、只投一条「报告未取回」、重复
    轮询不重复投；
  - ㉗ 幽灵 + `sessionQuery` 可读：报告读回并按正常结算评估，**不**另发丢失说明，
    observation 租约被 dispose；
  - ㉘ 重载 + 活执行者：保持 `running` 并接管，执行者 idle 两拍后带自身报告结算；
  - ㉙ 重载 + armed：不依赖 `agent/created`，第一条会话事件即恢复并孵化；
  - ㉚ 两个实例同时发现同一幽灵：只结算一次（令牌互斥）。
- **真实宿主验收**（21:57）：重载到 `entry-v18` 后，`session-19c360e9` 首次
  `/status` 即 `armed`（`build:3.5.0+reconcile`）；落盘 `running+childId` → `armed`；
  执行者会话里的收尾报告被读回，21:57:44 以【挑刺者评估】注入该主会话 turn 4，
  且只注入一次。
- **已知边界**：`used`/`critiqueHistory` 仍是内存态，重载后归零（失忆但不再卡死）。

## 一键复跑

```powershell
node D:\WorkSpace\_tmp\dual-agent-sandbox\run-checks.mjs              # 全部（4 项）
node D:\WorkSpace\_tmp\dual-agent-sandbox\run-checks.mjs --headless   # 只要确定性 E2E
node D:\WorkSpace\_tmp\dual-agent-sandbox\run-checks.mjs --gui        # GUI 组成 + HTTP 链路
node D:\WorkSpace\_tmp\dual-agent-sandbox\run-checks.mjs --real       # 真模型探针（需额度）
```

脚本自动：切 profile 驱动模式 → 起**新进程/新端口** → 抓 `E2E_RESULT`/报告 → 跑完
**还原配置**（`finally`，绝不遗留手改）→ 汇总写 `<sandbox>/check-summary.json`，
退出码即总判定。当前基线：**4/4 全过**（headless 84 + GUI 组成 84（全 9 场景）+
GUI HTTP 链路 arm/status/disarm 全 200 + 真模型 13）。
