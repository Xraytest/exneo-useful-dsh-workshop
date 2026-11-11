# dsh-session-orb · 会话悬浮球

界面右下角一颗**半透明黑色圆角小球**。任何会话跑完时，球**上方**弹出一个小会话框，
写着那个会话的名称；点一下跳回那个会话。球可以**拖动**，位置会记住；有多透明、多大、
提示停多久，都在 **设置 → 会话悬浮球** 里调。

| | |
|---|---|
| 挂载位置 | `shell.overlay`（球，`order: 620`）+ `settings.section`（设置页，`order: 47`） |
| 插件类型 | bundle（`dsh.bundle.patch` + `dsh.client.platform: web`，`immediately: true`） |
| Host 半边 | 只有两条未鉴权诊断路由，不参与功能 |
| 安装形态 | profile `dependencies` 里 `link:` 到本目录，`bundle` 行 `id: session-orb` |

## 行为

**球体**：尺寸 / 圆角 / 填充 / 整体不透明度全部由 CSS 变量驱动
（`--sorb-size` / `--sorb-radius` / `--sorb-fill` / `--sorb-opacity`），默认
56×56、`border-radius: 17px`、`background: rgba(0,0,0,.30)` + 背景模糊
（`backdrop-filter: blur(12px) saturate(150%)`）、静止 `opacity: .88`（悬停提到 1）,
外圈一道 1px 白色高光 + 落影。**实测**：压在深色页面上，球心 `rgb(16,16,18)`、周围
`rgb(21,21,23)`，折合有效浓度 ≈ **22%–24% 不透明**（旧版 `.55 × .9` ≈ 49.5%）——
就是一层薄纱，方块的形靠描边和中心光点读出来，压在浅色内容上会更明显。
有会话在跑时内侧一圈很淡的脉冲（可关）；有未看的完成提示时右上角出现红色计数（可关）。

**拖动**：按住球体任意位置拖动（`pointerdown` + `setPointerCapture`），位移 ≤3px 算点击。
球被夹在浮层可视区内，窗口缩放后自动夹回来，不会「拖丢」。松手时把
`{x, y}` 写进 `localStorage['dsh.sessionOrb.position.v1']`，下次打开还在原位。
没拖过的球永远贴右下角（窗口变了也跟着变）。

**会话框**：贴在球上方（球离顶部 <132px 时自动翻到下方），按球的水平位置选
左/右/居中锚点，`max-width: min(300px, calc(100vw - 28px))`，所以贴边也不会超出屏幕。
内容 = `会话完成` + 会话名称（最多两行）+ 「还有 N 条」。点会话框 → 打开该会话并收起提示；
右上角 × → 只收起提示。每条停留 `bubbleMs`（默认 8 秒）后自动收起并接上下一条，
最多排队 4 条；提示框底色浓度也是变量（`--sorb-bubble`，默认 `.92`）。

**点击球**：收起当前提示（露出下一条）。键盘可聚焦，Enter / Space 同效。

## 设置页（设置 → 会话悬浮球）

`settings.section` 里的一页，`id: dsh-session-orb`、`order: 47`（排在「插件自动更新」后面），
标题用 thunk 提供，所以切语言会跟着变。页面顶部是一条**实时预览**（直接用 `.sorb_ball` /
`.sorb_bubble` 的真实 class，套同一组 CSS 变量），下面两组滑杆 + 两个开关 + 三个按钮。

| 设置 | 变量 | 默认 | 范围 |
|---|---|---|---|
| 球体填充浓度 | `--sorb-fill` | 30% | 8%–90% |
| 整体不透明度 | `--sorb-opacity` | 88% | 25%–100% |
| 球体大小 | `--sorb-size` | 56px | 40–80px |
| 圆角 | `--sorb-radius` | 17px | 4–40px（且 ≤ 尺寸/2） |
| 提示框不透明度 | `--sorb-bubble` | 92% | 50%–100% |
| 提示停留时长 | — | 8s | 2–30s |
| 完成确认窗口 | — | 2.5s | 0–10s（0 = 立即弹，容易误报） |
| 运行时有呼吸脉冲 / 球角显示待看条数 | — | 开 / 开 | 开关 |

按钮：**弹一条测试提示**（不等真会话，直接验收提示框）、**复位到右下角**（忘掉记住的位置）、
**恢复默认外观**。

设置存在 `localStorage['dsh.sessionOrb.settings.v1']`，**按设备记**（不同窗口/浏览器各调各的，
不改插件配置、不写 profile）；拖动滑杆即时生效——`useSettings()` 让浮层和设置页订阅同一份
模块级快照，改一个数两边一起重渲染，不用刷新。

## 数据来源（都是 Client 侧既有公开面，没有猜 API）

- **完成检测**：`ctx.sessions.list`（`createSnapshotStore`）是唯一事实来源 —— 每轮比对
  每个会话的 `running`。**`true → false` 不等于完成**：带 goal 的会话（`goal.phase = active`、
  `maxGoalRounds` 还有余量）每轮自动续跑，轮与轮之间 `running` 会短暂变回 false；
  某些会话的 `running` 也会在 step 边界抖一下。所以一次 `true → false` 只算**候选**：
  挂起 `DONE_CONFIRM_MS` = **2500ms** 复查，仍然空闲才弹；期间又跑起来就静默丢弃，
  已经弹出的气泡也会**收回**（`retract`）。
  `running` 不是布尔值（投影未就绪）时视为**未知**，既不计数也不触发 —— 把 `undefined`
  当成「跑完了」是假完成的另一条来源。`origin === 'subagent'` 的行（子代理）不弹提示。
  列表订阅 + `ctx.remote.$on('api-session/status', ...)` 双通道，后者只当
  「去重读列表」的唤醒信号，不参与判定，避免两套状态打架。
- **会话名称**：`row.title ?? row.displayTitle`；排队中的标题还会随列表刷新
  （标题可能比回合晚到）。
- **跳转**：`ctx.get('uiWorkspace')?.openSession({ sessionId })`，取不到就只收起提示。
- **文案**：`ctx.locale.register('dsh-session-orb', {zh, en})` + `ctx.locale.bind`，
  兜底用 `document.documentElement.lang` 选静态表。
- **样式**：一段 `<style data-plugin-css="dsh-session-orb/orb.css">` 注入 `document.head`，
  幂等（已有同名标签就跳过）。球是「作品」，颜色用字面值而不是主题 token —— 深浅主题
  下它都是同一颗黑玻璃球。

## 诊断

Host 半边提供两条**未鉴权**本机路由（只读写内存，不接命令、不改状态）：

```bash
# 浏览器半边最近一次自报（挂载、坐标、完成、拖动）
curl http://127.0.0.1:9999/session-orb/selfcheck
```

返回 `{ ok, plugin, version, reports, last, recent[] }`。`last.event` 会是：

- `apply` —— 插件已加载，附带 `list/subscribe/status` 能力探测、会话条数、`storage`
  （`localStorage` 读写自检：`ok` / `readback-mismatch` / `error:<Name>`）、`confirmMs` /
  `bubbleMs`（当前生效值）和整份 `settings`；
- `mounted` —— 组件已挂进浮层，附量到的浮层尺寸 `box`、**复原后**的落点 `pos`，
  以及读到的 `stored`（上次记住的坐标，没记过是 `null`）—— 这一项就是「位置有没有记住」的证据；
- `complete` —— 复查通过、真的空闲了，附 `sessionId` / `title` / `delayMs`（距触发边缘多少毫秒）
  / `origin` / 还压着几条；
- `suppress` —— 候选被丢弃，附 `reason`：`resumed`（复查时又在跑）、`resumed-before-confirm`
  （复查前就又开始跑）、`unknown`、`row-gone` —— **误报就是被这一步吃掉的**；
- `retract` —— 气泡已弹出后会话又跑起来，提示被收回；
- `settings` —— 设置页改了值，附整份 `settings`（滑杆→存储→渲染这条链的证据）；
- `reset-position` —— 点了「复位到右下角」；
- `drag` —— 拖动落点；`dispose` —— 卸载（带 `confirmed/suppressed/retracted` 三个计数与当前 `settings`）。

`POST /session-orb/report` 是浏览器侧写入入口，校验 `Origin`（无 Origin 的本地请求放行，
跨站页面发来的 POST 返回 403）。

## 文件

```
index.js           Host 半边：两条诊断路由 + 环形缓冲（inject: ['webServer']）
client.js          全部功能：浮层条目、拖动、透明度/尺寸变量、完成检测、会话框、设置页
cordis.patch.yml   insert 一行 { id: session-orb, name: dsh-session-orb }
locale/{zh,en}.json  插件卡片文案（meta.title / meta.description）
icon.svg           插件图标（黑玻璃球 + 上方小会话框）
package.json       bundle 清单：dsh.bundle.patch + dsh.client + engines.dsh
```

## 移植 / 卸载

- 换机器：把整个目录拷到目标 profile 的 `plugins/`，在插件管理里安装本目录（写进
  `dependencies`（`link:`）和 `dsh.profile.bundles`），刷新页面。
- 卸载：插件管理里停用/移除即可；`localStorage` 里那两条记录（位置 `dsh.sessionOrb.position.v1`、
  外观 `dsh.sessionOrb.settings.v1`）留着无副作用，想清就删。

## 已知边界

- 只在质点页（Web UI）里有意义：Electron 主进程不渲染 DOM，`shell.overlay` 不存在时
  组件不会挂载。
- 页面刚刷新时已经结束的会话不会被补报（只有「本次页面存活期间发生的 running→idle」
  才弹）；尚未完成的会话在页面加载时作为基线，不会误报。
- 「完成」= **这次真的闲下来了**（默认 2500ms 复查窗，设置页可调）。因此一轮结束、2.5 秒内
  又开始下一轮（goal 自动续跑、排队消息、你又追问了一句）不会弹；代价是真正的完成也会
  晚这么久弹出。带 goal 但轮间停顿超过窗口的会话仍会先弹一下，等它续跑时自动收回（`retract`）。
  想更严就把「完成确认窗口」调大，想更快就调小（0 = 立即弹，实测会误报）。
- 子代理（`origin: 'subagent'`）完成不弹提示，只有顶层会话弹。
- 该页面需要登录，因此无法用无头截图做像素级验收；本插件用 `selfcheck` 的
  `mounted.box` / `mounted.pos` 自报证明挂载与坐标系，用 `PrintWindow` + 像素剖面量透明度。
  设置页是**渲染过、截过图**的（四个滑杆组 + 开关 + 按钮都在），但「滑杆拖起来爽不爽」
  仍需人眼/人手过一遍。
- 每个窗口一颗球、各存各的设置：同时开着 Electron 窗口和浏览器窗口时，会看到两颗。
