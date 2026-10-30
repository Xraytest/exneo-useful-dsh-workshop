# dsh-dual-agent — 双主智能

用户需求（历次修订合并）：

> 创建两条主智能：一个完成用户指令，另一个持续主张质量不符合要求、从用户要求里
> 找多个角度修正（第二个不负责判定真实质量，负责深化验证指标、发现更有表现力的指标）。
> 启动=武装待命，等用户键入初始指令；用户手动停止=等待补充；只有智能体主动停止才挑刺。
> 智能体 1 做成 subagent 形态；报告评估由智能体 2 在主上下文视角输出。
> UI 是开关，不是按钮。
> （2026-10-30）启用后主对话收到指令应**阻塞**——创建子代理后主页面不出现新的动作；
> 实测主窗口与子代理同时运转，要求沙箱完整验证双线路径。

## 两条智能的形态

| | 智能体 1（执行者） | 智能体 2（挑刺者） |
|---|---|---|
| 实现 | **真 subagent**：`subagents.startActivation`（spawn provider，continuable child，`delivery:'caller'`） | **主上下文人格**：常驻系统提示段（`dual-agent:critic`）+ 评估轮注入 |
| 会话 | 自己的 Session，零父上下文 | 就在主会话里 |
| 何时说话 | 后台干活；收尾产出**自足报告** | 只在执行者自然结算后评估；手动停止不吭声 |

## 双线路径的「阻塞」（v3 核心修正）

用户键入初始指令后，主对话**让位**给执行者，页面不出现新的动作。机制在内核回合时序里：

1. 主 Agent 回合的 preStep **认领**（claim）用户消息 → `step()` 内 append 该 `user/message`；
2. 插件的 `session/event` 同步观察者在这条 append 里判定「armed + 人类消息」→
   立即 `agent.cancel({kind:'hook'}, {keepInbox:true})`；
3. 内核在 `stream()` 创建之后、**消费之前**有 `signal.throwIfAborted()` 检查点 →
   回合以 `turn/end reason=aborted` 收场，**零条 assistant/message**（假流都没被消费）；
4. 消息已被认领不会重现 inbox → 无 re-wake 自旋；
5. 异步段里孵化执行者；跑完（`await activation.result`）→ 编排把
   **报告原文 + 评估指令**合成**恰一条**【挑刺者评估】plugin 消息注入主上下文 →
   主 Agent 以挑刺者人格输出评估（角度从用户要求原文里抽，点名未用过的）。

**为什么 `delivery:'caller'`**（v2 用 `'parent'` 的缺陷）：caller 模式结算不投递
settlement notice、不唤醒主 Agent——否则主 Agent 会先自由汇报一轮、评估再一轮，
正是「主窗口和子代理同时运转」的观感来源。报告由编排取回（`activation.result →
{output, stopReason}`），评估必须把报告**内嵌**进注入消息（主会话本来看不到它）。
手动停止/disarm 先清 `childId`：结算时孵化 IIFE 里的身份守卫吞掉评估——**不挑刺**。

## 状态机

```
off ──开关拨开──► armed ──用户键入初始指令──► running ──执行者自然结算──► armed
                   │                           │
                   └────开关拨关────► off ◄────┘（running 中拨关=中断执行者，不挑刺）
```

- **armed**：注入挑刺者+待命段，等下一条**人类**消息作为任务本体；消息的**全部
  内容块**（文本/图/文件）原样交给执行者。
- **running**：主上下文静默。用户补充由 `subagents.sendMessage` **转达执行者**
  （成功静默、失败才投【补充转达失败】）；补充回合同样被压制，主页面仍无新动作。
- **自然结算** → armed + 恰一条评估轮。角度池从用户要求原文里提取，用过不重复。

## 入口

- 工具箱（dsh-workbench）里是**开关**（与 Ultracode/REA 同款 track+thumb）：
  拨开=武装；徽标 `待命中/运行中`；拨关=解除（running 时先中断执行者，不挑刺）。
- **防「以为卡死」**：running 的 note 会解释「主对话已让位（保持安静是正常的）」，
  满 1 分钟起附「已工作 X 分 Y 秒」；status 同时返回 `hatchAt`（epoch ms），客户端
  可走自己的秒表。armed 的 note 在 `hatch.ready=false` 时**提前警告**没有可用
  provider，不等用户键入任务才撞上孵化失败。
- `GET /dsh-dual-agent/status?sessionId=…`：**只读**（不物化、不写盘、不装段）。
- `POST /dsh-dual-agent/action { sessionId, enabled? }`：开关语义按**目标状态**推进、
  幂等；不带 `enabled` 走旧式三态循环。会话不在线回 409。
- 可编程面 `ctx.provide('dualAgent', { status, transition, readiness })`：
  headless/SDK/E2E 不经 HTTP 直接驱动（`/action` 与它共用同一 `transition`）。
- 工作箱约定 `running:boolean`，status 同时给 `running`（phase!=='off'）与 `phase`。

## 关键实现细节（踩过的坑，别改回去）

1. **编排消息 source 必须 `plugin:<name>`**。裸 `kind:'plugin'` 被 v4 codec 硬拒绝，
   会让会话 jsonl 整批落盘失败。`source-kind-test.mjs` 用真实 codec 守这条。
2. **压制点**：cancel 必须发生在 `user/message` append 的同步观察者里（preStep 已
   claim，不会再唤醒）；在 `turn/start` 时 cancel 太早（消息没落账），在 append 之后
   异步 cancel 太晚（主 Agent 已开始产出）。
3. **watcher 内投递分两种时机**：`user/message` append 的**发布窗口**里同步
   `followup` 会撞 `session append cannot reenter…` 被静默吞掉——推**微任务**即可
   （结算转达走这条）。但 `turn/end` 的观察点在**回合拆解窗口**里，微任务**仍不够**：
   实测投递能落进 inbox（事件流出现 `agent/inbox/spliced`）却唤不起新回合（没有
   后续 `turn/start`，消息躺死）——因为主循环「要不要起新回合」的判定已做过、唤醒
   被收尾中的旧回合吞掉。评估重试/兜底必须走 `idleThenDeliver`（await `agent.whenIdle()`
   再补一拍宏任务），确保拆解彻底结束。
4. **评估只走 `await activation.result` 一条路**。`delivery:'caller'` 下 `subagent/end`
   仍会触发——别再订阅它做评估（会双触发）。抑制评估用 childId 身份守卫，无需时间窗。
5. **provider 只接受非继承型 continuable**（`inheritsParentContext===false` 且有
   `prepareContinuable`）；静默退到 fork 会让执行者继承父历史（含挑刺者人格段）。
6. `systemPrompt.section` 的 `order` 必填；`ctx.effect` setup 必须**直接**注册再返回
   清理函数（`effect(() => () => {on(...)})` 永不注册）。
7. **`/status` 只读**；恢复只发生在显式动作路径与 `agent/created` 兜底。
8. **只用服务面真实方法**（14 个，见 `host-selftest.mjs` 静态守卫）；
   `queuePrompt` 不在面上，用了=生产静默死亡。
9. **webServer 是可选依赖**（`ctx.get('webServer')`）：headless composition 没有它，
   写死 inject 会让插件 pending。
10. **换实现必须换 entry 文件名**：宿主按**完整 URL** 缓存 ESM——改 `entry-vN.js`
    里的 `?v=` 没用（旧文件名 import 过就不会重新求值），必须新建
    `entry-v(N+1).js` 并把 patch 行指过去。当前 **entry-v17.js / `?v=da-23`**。
17. **零父上下文的执行者需要「评估结论史」才能闭环**：不带的话用户说「按第 2 点改」
    甚至「把前两个问题都修了」时，新执行者完全不知道指什么，多轮修正循环断掉。
    实现：捕获挑刺者每轮的**结论正文**（`assistant/message`，仅在 `criticPending`
    挂起期捕获以免混入主 Agent 其它发言），保留最近 **3** 条、每条截 2K，孵化时作为
    `⟦最近几轮挑刺者评估结论⟧` 块带进子 prompt。只带编排自己的评估结论（非主 Agent
    推理、不含报告原文），有界，不变回继承式 subagent。
16. **模型-facing 文案必须与实现一致**（round 21/23 连续抓到两处 stale）：prompt 里
    描述一个不存在的机制（settlement notice / 「已转达」回执）会直接误导主智能。
    改 prompt 时同步核对代码路径；host-selftest ㉔ 的源码契约把这些不变量锁住。
    补充转达的真实语义：**成功静默、失败才发【双主智能编排】说明**。
15. **执行者报告嵌入要截断**（`reportTextOf`，模块级纯函数、㉓ 覆盖）：真实任务的
    长报告若整体嵌进评估消息，每轮都往主会话上下文灌一遍——烧 token 且有爆上下文
    风险。截到 12K 字、保头尾（结论+收尾信息密度最高）、中段标注省略字数。
14. **`ctx.get('webServer')` 在 apply 时刻可能还是 undefined**（GUI profile 实测：
    webserver 条目后激活，探针插件 WSPROBE 证明 apply 时 undefined、1.5s 后 present）。
    同步取一次 = 路由永不注册 = **工作箱开关在真实 GUI 里 404 全失效**（fake ctx
    立即可见，所以自测抓不到——必须起真 GUI server 打 HTTP 才暴露）。路由注册必须
    懒：`whenWebServer()` 轮询等到服务出现再 register（≤60s 超时放弃，headless
    没有该服务时走程序化 `dualAgent` 服务面）。
13. **重启恢复必须「说人话」**：落盘 running 在新进程一律降级 armed（child 不跨
    进程），但只给通用待命文案会让用户以为任务还在跑。恢复时记
    `recoveredFrom:'running'` 并在 armed note 明说中断，用户发新任务即清除。
12. **status 是轮询热路径，绝不允许抛**。执行者活性探测（`childLive`/`childStatus`）
    全程 try/catch 吞异常回 null；`/status` 只读、不物化、不写盘、不装段。
11. **角度抽取的质量边界**（`extractAngles`，已导出为纯函数、⑲ 覆盖）：
    - 暗示词**不能用单字**——'要' 命中「会议**要**点/重**要**」、'需' 命中「所**需**」，
      会把任务复述误判成「用户明确要求」。用 '要求'/'需要'/'必须' 等多字形式；
    - 不含暗示词且 **>8 字**的片段不当角度——它几乎总是整句任务复述，点名它等于
      把任务原样打回，对「深化验证指标」零信息量；短名词短语（≤8 字）仍收；
    - 用户原文抽不出维度时走 `FALLBACK_ANGLES`（10 条可验证维度，按序消耗不重复）。
12. **running 时长由客户端每秒渲染**（dsh-workbench client 的 `runningElapsed`），
    服务端 note 保持**稳定文案**——8s 轮询里内嵌时长会一跳一跳，还和客户端重复。
    锚点是 status 的 `hatchAt`（running=epoch ms，其它=null）；workbench host 把它
    原样透传给 client。别把格式化搬回服务端。

## 验证（一键复跑）

```powershell
node D:\WorkSpace\_tmp\dual-agent-sandbox\run-checks.mjs   # 4 项全跑，退出码即判定
```
基线：headless 92 断言 + GUI 组成 92 断言（全 10 场景）+ GUI HTTP 链路
（arm/status/disarm 全 200）+ 真模型探针 13 断言，**4/4 全过**；摘要落
`<sandbox>/check-summary.json`。

- 离线自测：`node host-selftest.mjs`（状态机/压制/转达/附件/开关/守卫/恢复/活性）
  + `node source-kind-test.mjs`（真实 v4 codec）。

- 离线自测：`node host-selftest.mjs`（状态机/压制/转达/附件/开关/守卫）
  + `node source-kind-test.mjs`（真实 v4 codec）。
- **真实内核沙箱 E2E**（`_tmp/dual-agent-sandbox`，不碰本机 profile、不联网——
  假 LLM adapter `e2e-fake` 同步注册）：驱动插件用 `agents.create` +
  `dualAgent.transition` + 人类 followup 走完整内核事件流，**8 场景 79 断言
  ×3 连跑全绿**：
  - ①任务阻塞：任务回合 0 assistant、`turn/end aborted`、无主 Agent 模型调用、
    执行者独立跑完、无 settlement 唤醒、评估恰 1 条、回 armed；
  - ②执行中补充：主页面静默、补充进**子会话**（直接读子会话消息核验）、
    `status.hatchAt` 是活 epoch、armed 时 `hatchAt=null`；
  - ③执行中关闭：`off`、释放后**无**评估轮、无 MAIN 调用；
  - ④连续多任务：每轮 0 assistant + aborted、各恰 1 评估、全程无 MAIN；
  - ⑤前缀防御：`【挑刺者评估】` 开头的人类消息**不孵化**（评估注入不自触发）；
  - ⑥评估轮兜底：评估流零正文抛错 → 自动重试一次 → 可读兜底，投递经
    `idleThenDeliver` 等 whenIdle（拆解窗口吞唤醒的坑，见坑 #3）；
  - ⑦跨窗口隔离：两个武装父会话并发，各 0 assistant、**报告不跨窗口**
    （A 的评估注入只含 A 的报告 token、绝不含 B 的）；
  - ⑧多轮角度轮换：同会话连发 12 任务，**前 10 轮角度互不重复**、第 11/12 轮按
    LRU 回收最早角度（r11==r1、r12==r2）、阻塞每轮不失守；
  - ⑨长报告截断：执行者 40K+ 字报告 → 嵌入评估消息的截到 12K 内、标注省略量、
    保头尾、阻塞仍成立（防长报告每轮灌爆主会话上下文）；
  - ⑩多轮修正闭环：二轮执行者 prompt 头一块带**最近几轮挑刺者评估结论**（深度 3、
    每条 2K）——零父上下文的执行者否则看不懂「按第 2 点改」，多轮循环会断；
  - 报告落 `<sandbox home>/dual-agent-e2e-report.json`，exit code 即结果。
- **GUI 组成完整回路**（`sandbox` profile = base + web-app + webserver + workbench
  + our-free-model）：**全部 8 场景 79 断言**全绿——人格段在真实 GUI 会话的 agent
  上装得上、压制/转达/关闭/兜底/跨窗口隔离/多轮角度轮换全部成立（与 headless 同等
  覆盖，证明这些行为不依赖组成）。
- **GUI HTTP 链路**（同一起真 web server）：经**工作箱开关**
  `POST /dsh-workbench/action {actionId:'dual-agent',enabled:true}` 驱动属主，
  验证 arm→`phase:armed`、status 一致、disarm→`phase:off` 全 200（这条链路
  曾因 apply 时取不到 webServer 而全 404，见坑 #14）。

## 依赖

`subagents`（spawn provider）与会话持久化；webServer 可选。缺依赖以
「孵化失败→回待命」提示暴露，不留半成品状态。

## 相关插件

`dsh-workbench`：工具箱开关行（本插件 UI 宿主）。
