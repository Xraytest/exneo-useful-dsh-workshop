# dsh-workbench — 输入框工具行的「工作箱」

用户指令（2026-10-22）：把 Ultracode 的位置换成一个**工作箱图标**，点击后展开
**工作列表**（Ultracode、REA），**复选选中后才把相关上下文注入窗口**；对 REA，
不选中 = **零 REA 上下文**。

v2（2026-10-28，用户指令「启动按钮放到工具箱内」）：工作列表在开关条目之外
增加**动作条目**——点一下 = POST 一次，不在本插件落盘勾选。
第一个动作条目：**双主智能**（dsh-dual-agent）的三态按钮。

v2.1（2026-10-29，用户反馈「启动按钮 ui 错误」）：动作条目改为**三态驱动**。
属主回 `phase`（off/armed/running）为真值、`running` 布尔为兼容派生值；
按钮随阶段显示 `启动` / `取消待命` / `停止`，另有「待命中 / 运行中」徽标；
阶段说明（属主 note）单独一行，不覆盖功能说明。

v3（2026-10-29，用户指令「启动通道的 UI 也放在工具箱内」）：动作表新增
**管理员权限通道**（属主 dsh-admin-channel，`kind: 'switch'`）。拨开 = 属主
弹一次 UAC 并拉起常驻提权进程；勾选态/阶段/阶段说明/悬停提示全部来自
属主 `/dsh-admin-channel/status`，工作箱不复制任何提权逻辑。`/status` 探测
回包新增可选 `hint`（随阶段变化的悬停提示），client 优先使用它。

v3.4（2026-10-30，用户指令「主页面不要用已停止，用执行中」）：双主智能的阻塞
语义会把主 Agent 的任务回合 cancel 掉，内核据此记 `turn/end reason='aborted'`，
而 dsh-client-ui-chat 的 `message.stopped`（「已停止」）正是渲染给这种回合的
标签——于是用户每发一条任务，主页面就出现一个「已停止」，观感像坏了（活其实
正在后台执行者那里干）。client 在双主智能处于 **armed/running** 时把该标签
改写为「执行中」；回到 **off** 时还原（用户自己按停止键仍看到「已停止」）。
实现：宿主 locale 字典按引用查找，直接改 chat ns 里 entries 对象的
`message.stopped`；原始值快照在 dict 上只写一次，改写/还原不漂移；全程
try/catch，宿主内部结构若变则静默降级。`client-selftest-v3.mjs` 覆盖 14 项
（改写/还原/不漂移/结构异常不抛）。

v3.5（2026-11-01，用户指令「将 UAC 插件授权时长改为无限」）：属主
dsh-admin-channel 的 `idleTimeoutMs` 改为 0（授权时长不限、不因空闲自动关闭），
工作箱里管理员权限通道的描述同步改为「授权时长不限，随会话结束或手动拨关关闭」。

## v9（2026-11-03）：可进入的二级菜单

用户指令：「在当前的工作箱 UI 内创建可进入的二级菜单（开关也保留）」——起因是
dsh-dual-agent 与 dsh-subagent-models 合并成「双智能指导」，需要一个地方选子代理
用的模型，而入口仍要在工具行的工作箱里。

分工（这次新增的关键设计）：

| 谁 | 做什么 |
|---|---|
| 属主插件（如双智能指导） | 出内容：`GET <menu.route>?sessionId=…` 回**声明式 spec**；`POST <menu.route>` 收 `{sessionId, op, …}` 并回**新 spec** |
| 工作箱 | 画通用件，不认识任何属主的语义；`heading / note / switch / select(支持 optgroup) / text / rows(带 chips+进度条+行内按钮) / form / buttons` 八种 |

为什么不是「属主插件往工作箱里注一个 React 组件」：那要跨插件 `require` 对方模块，
装载顺序与 HMR 都会咬人；而 HTTP JSON 契约跟其它条目一样，属主没起来就明说打不开，
工作箱不为任何一个属主特化一次代码。

行为约束（client 侧）：

- 行上的**开关照旧**，「进入」小按钮 `stopPropagation`——点它绝不误拨开关；
- 只有属主 status 回了 `menu.route`（或 ACTIONS 里静态声明）才画这颗按钮；
- 进入后列表整块让位；`‹ 返回` 与 Esc 第一段都回列表，再 Esc 才收起浮层；
  点浮层外或再点胶囊 → 一并清空子视图（下次打开从列表开始）；
- 子视图按 spec 的 `refreshMs` 轮询（下限 1500ms），op 在飞时禁用交互；
- op 失败**显示属主原文**（400/409 的校验话术就是给用户看的），并顺带刷一次工作箱状态；
- 遇到不认识的 `kind` 明说「工作箱不识别的条目类型：X」，不静默丢条目。

host 侧改动：ACTIONS 的 dual-agent 行随属主更名「双主智能」→「双智能指导」并加
`menu` 声明；`/status` 的 actionStates 白名单加 `menu` 一项（不加就透不出去）。
**row id、route、开关语义全部不变**——属主改名字不动我们的转发。

自测：`node plugins/dsh-workbench/client-selftest-v4.mjs`（二级菜单专项）；
原有 `host-selftest.mjs` / `client-selftest{,-v2,-v3}.mjs` 全部照旧跑。

## 界面

- 座位：`conversation.input.left`，**order 23**（正是原 Ultracode 胶囊的位置）。
  **原 ultracode 按钮已删除**（2026-10-22 用户指令「去掉原来的 ultracode 按钮」）：
  dsh-ultracode 的 client 不再注册任何槽位，点亮/熄灭的唯一入口就是工作箱列表
  里的 Ultracode 开关行；其 host 半边（状态机/家族/落盘/路由）零改动。
- 收起：一颗 28px 圆角胶囊（与权限选择器同高），内有一个「电源符号」图标
  （2026-10-22「改一下图标图案」；r=3.4 圆弧 + 顶杆），有勾选项时右上角亮一粒
  **圆点角标**（2026-10-22「圆点角标而不是方形」，数量在浮层头部与悬停 title 里）。
- 展开：浮层列出工作项——每行「**开关**（track+thumb，`role="switch"`）+ 名称 +
  一句描述」，**乐观翻转**：点下第一帧就翻过去，`POST /dsh-workbench/set`
  随后台发出，失败才回滚并在浮层给红字；下一次请求就是新上下文。
  点浮层外或 Esc 收起。（2026-10-22「换成开关样式」；浮层无入场动画——
  「点击秒开」。）
- **浮层底部没有常驻说明文字**（2026-10-30 用户指令「去掉工具箱插件页面底部的
  文本描述」）：原底注那段「拨动开关即时生效…」长文已删除，`.wb-note` 样式
  一并移除。说明只在悬停 title 与每行自己的描述里，浮层里不再有整段提示语。
- **动作条目**（v2.2）：与开关条目同款的**开关**（track+thumb，`role="switch"`），
  不再是一颗按钮。开关表示「该动作是否启用」，勾选态由属主 status 折算：
  - `checked` = 属主 `running`（即 `phase !== 'off'`）；行尾状态点同款（开=绿/关=灰）
  - 徽标依 `phase`：`armed` → 「待命中」，`running` → 「运行中」
  - 点击上送**目标状态** `{ sessionId, actionId, enabled }`，属主按目标推进，
    不再由属主猜「下一次点击该进哪一态」（消除 8s 轮询滞后导致的错态执行）
  - 行内常驻功能说明 + 单独一行阶段说明；属主缺席→禁用并说明原因；
    请求在飞时禁用（防连点竞态）

## 语义

| 项 | 类型 | 行为 |
|---|---|---|
| Ultracode | 开关 | 勾选转发 `/dsh-ultracode/set {active:true}`——装配期直注 Ultracode 段并改写 `tool:workflow` 段；未勾选转发 `{active:false}`——注入收口段 |
| REA | 开关 | **按会话**：勾选经 `/dsh-rea-mcp/workbench {sessionId, on:true}` 打开**本会话**的 `masterEnabled`；未勾选 → rea-mcp 用 `tools.restrict()` 摘除全部 `mcp__rea__*` + 本插件在 `system-prompt/assemble` 瀑布里删掉 `mcp:rea` 提示段。只影响这一箱，别处的会话不受影响 |
| 双智能指导 | **开关 + 二级菜单** | 拨开转发 `/dsh-dual-agent/action { sessionId, enabled:true }` → 使能（主智能只判断、下一条消息交给后台执行者）；拨关 `{ enabled:false }` → 中断执行者（不挑刺）并解除。行尾「子代理模型与规则 ▸」进二级菜单（选子代理模型链、限额、约束力度、核验开关）。语义全在 dsh-dual-agent，本插件只画开关与通用件 |
| 管理员权限通道 | **开关** | 拨开转发 `/dsh-admin-channel/action { sessionId, enabled:true }` → 属主弹一次 UAC 并拉起常驻提权进程；拨关 → `{ enabled:false }` 结束提权进程。授权时长不限（属主 `idleTimeoutMs=0`，无空闲自动关闭）。勾选态/阶段/说明/悬停提示全来自属主 `/dsh-admin-channel/status`；本插件不实现提权 |

「零上下文」的两件事缺一不可，这就是为什么 REA 的摘除分两处：
工具 schema 在 rea-mcp（它持有 `tools.restrict` 的白名单状态），
说明文字段在 workbench（`dsh-mcp-client` 把 instructions 注册成全局
systemPrompt section 且没有开关，只能由装配瀑布最后一手删）。

## 状态

- 开关条目：每个会话（按 **ultracode 同款家族谱系**）一份勾选，落盘
  `$DSH_HOME/workbench.json`（0600、原子写、跨进程合并；家谱只读
  `ultracode.json` 的 families 表——家谱事实的唯一写者仍是 dsh-ultracode，
  本插件绝不重复记）。分支上勾选 = 全家族一起勾选。
- REA 条目：**本插件不落盘**。真值每次 status 时向 rea-mcp 现问（同步读它的状态文件），
  读到的也是**本会话**（家族根）那一份：有覆盖读覆盖，没有就继承 `defaults`。
  写入只经 `/dsh-rea-mcp/workbench {sessionId, on}`——REA 状态的唯一写者仍是 rea-mcp。
- 动作条目：**不落盘**——running 真值每次 status 轮询时向属主插件现问
  （`GET <属主路由前缀>/status?sessionId=…`）。

## 路由（同源守卫）

```
GET  /dsh-workbench/status?sessionId=…  → 勾选状态 + 条目 + 动作实况 + REA/ultracode 实况
POST /dsh-workbench/set                 ← { sessionId, checked: [id…] }
POST /dsh-workbench/reset               ← { sessionId }   （清空勾选并 reset ultracode + 本会话 REA 覆盖）
POST /dsh-workbench/action              ← { sessionId, actionId }   （v2：转发属主插件）
```

`status.entries[rea].checked` 与 `status.rea = { masterEnabled, source:'session'|'defaults', connected }`
都来自 rea-mcp 的**本会话**状态；`/set` 只在本会话的 REA 状态**需要变化**时才回写，
`/reset` 会连本会话的 REA 覆盖一起清掉。

## 自测

```
node plugins/dsh-workbench/host-selftest.mjs          # 21 项：路由/家族/摘段/恢复/开关契约
node plugins/dsh-workbench/client-selftest.mjs        # 44 项：渲染/开合/乐观翻转/回滚/圆点角标
node plugins/dsh-workbench/client-selftest-v2.mjs    # 40 项：开关渲染/乐观翻转/目标态上送/真值合并/失败回滚/旧 host 兜底
```

## 维护

- `client.js`：内容哈希供包，改完**刷新页面**。
- `index.js`：Loader 按 specifier 缓存——新写 `entry-v<N+1>.js`（`?v=` +1），
  把 `cordis.patch.yml` 里 `workbench` 行的 name 指过去（**row id 不变**），
  再 remove → install 本 bundle。当前：**entry-v10.js / ?v=wb-12**。
  ⚠️ 只改 `cordis.patch.yml` 不保证运行中的实例换代码；如果 `/status` 里看不到新字段，
  就走一次 `plugin_manager remove_bundle` → `install_bundle`。

## 相关插件

- `dsh-ultracode`（胶囊让位 order 90，逻辑不动）
- `rea-mcp`（`/dsh-rea-mcp/workbench` 直连路由，**带 sessionId**、只翻本会话的 `masterEnabled`）
- `dsh-dual-agent`（v2 动作条目的第一个属主：双主智能启动/停止）
- `dsh-plugin-autoupdate`（设置页「插件更新」，本插件的新版本同样会被它监看）


## v10（2026-11-03）：行内描述不再随状态改写 + 浮层高度封顶

两条用户指令：

1. **启用后不要更改底下的描述**：动作行原先会在描述下面多渲染一行「阶段说明」
   （属主 note + 运行时长），启用/执行中就会把描述区顶掉。现在这一行**不再渲染**，
   阶段说明只进悬停 `title`（`title = hint；note+elapsed`）。行内始终只剩属主给的
   那一句静态描述，徽标（待命中/运行中）仍在标签行右侧。
2. **二级菜单顶出屏幕**：浮层原本没有任何高度上限，只有内部 `.wb-sub-body` 在滚
   （64vh），内容一多就整块长出屏幕。现在浮层 `max-height: min(calc(100vh - 220px),
   420px)`，子视图 `max-height: calc(100vh - 260px)` 且 `flex:1 1 auto; min-height:0`；
   列表态整层可滚（`[data-pop-scroll]`）。540–900px 视口下推演均不出屏。

## v11（2026-11-12）：REA 开关按会话隔离

**症状**：在任何会话里动 REA 工具，别的上下文一起变——包括在**设置页**精挑的工具集。

**根因**：REA 的选择过去是 `tools.json` 里**唯一一份**，本插件拨总开关也只发
`{ on: boolean }`（不带会话），写的自然是那份全局状态。工作台的勾选本身是按家族谱系
存的，但它的「真值」来自那份全局状态，于是看着像工作台也串了。

**改法**（rea-mcp 那次改动的对侧，两边必须成对看）：

1. `readReaState()` 同步读 v2 状态文件（v1 形状按「整个顶层 = defaults」兜底），
   `reaBucketOf` 里先按 `parentSession` 走到**家族根**再查 `sessions[root]`，
   查不到就用 `defaults`；两个插件用同一条走法（≤64 层、成环不炸）。
2. `statusOf(sessionId)` 新增 `rea: { masterEnabled, source:'session'|'defaults', connected }`，
   下拉里的 REA 勾选 = **本会话**的有效状态（不看全局）。
3. `/set` 带上 `sessionId`，并且**只在本会话状态确实要变时**才 POST `/dsh-rea-mcp/workbench`。
   这一条很关键：无脑每次都发，会让「勾了别的条目」也顺手给本会话建一份覆盖，
   从此和 `defaults` 脱钩，之后改默认它不跟（实测第 07 步专门验了这个）。
4. `/reset` 除了清勾选、reset ultracode，再带 `sessionId` 调 rea-mcp 的 `/reset`，
   把这个会话的 REA 覆盖一起清掉，回到继承。

**兼容**：对面还是旧 rea-mcp 时，`readReaState()` 读到 v1 也照常工作（全体走 `defaults`），
`/workbench` 多带的 `sessionId` 被旧实现忽略——退化成 v10 的老行为，不会报错。

**实测**（`_tmp/toolbox-isolation/probe-workbench.ps1`，每一步都打真接口）：

```
01 defaults: master=False enabled=207 sessions=[]
02 wb set A=[rea]        → A: master=True source=session
03 REA A                 → source=session hasOverride=True
04 REA B                 → source=defaults hasOverride=False        ← 隔离
05 WB status B           → rea.master=False checked=False          ← 工作台也跟着隔离
06 defaults after A      → master=False enabled=207 sessions=[A]    ← 默认没被改
07 wb set C=[]（无关项）  → C 未被建覆盖                             ← 不发多余写
08 REA reset A           → sessions=[] A 回到继承
09 WB status A           → rea.master=False source=defaults
10 defaults final        → master=False mode=all enabled=207 sessions=[]
```