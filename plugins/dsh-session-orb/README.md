# dsh-session-orb · 会话悬浮球

屏幕右下角一颗**半透明黑色圆角小球**，会话跑完时在球**上方**弹出小气泡写着会话名称，
点一下跳回那个会话。球能拖、位置记住、透明度/大小/停留时长可调。

**v2 的关键变化：球不在页面里了。** 球是一个独立进程里的原生分层窗口
（`SessionOrb.exe`，Win32 `WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_NOACTIVATE`），
由 Host 现场编译并监督。所以 DSH 窗口缩到托盘、刷新页面、切走标签页、最小化，
球都照常在那儿；「置顶」是操作系统的扩展样式，不是页面里的 `z-index`。

| | |
|---|---|
| 挂载位置 | 只剩 `settings.section`（设置页，`order: 47`）；**不再有** `shell.overlay` |
| 插件类型 | bundle（`dsh.bundle.patch` + `dsh.client.platform: web`，`immediately: true`） |
| Host 半边 | 8 条 renderer 路由 + 1 条私有 bridge + 编译/监督原生助手 |
| 原生助手 | `native/SessionOrb.cs` → `csc` 编译为 `%LOCALAPPDATA%\dsh-session-orb\build\<hash>\SessionOrb.exe` |
| 安装形态 | profile `dependencies` 里 `link:` 到本目录，bundle 行 `id: session-orb` |

## 1. 架构：三个进程，两条 HTTP 面

```
DSH 桌面应用（Electron）
  Host 进程（Node）
    index.js      路由挂载 / Host 事件订阅 / 菜单动作语义
    hub.js        状态机：谁跑完了、要不要弹、排队与收回
    store.js      持久化 state.json（设置 / 位置 / 标题缓存）+ 日志
    transport.js  renderer 路由(8) + bridge(1)
    native.js     找 csc、按源码哈希编译、启动与重启助手
        │
        │ bridge: http://127.0.0.1:<临时端口>   header: x-orb-token
        ▼
  SessionOrb.exe（独立进程）
    分层窗口自绘圆球 / 气泡 / 右键菜单；自己校验命令行 token；
    父进程消失就自行退出（parent-gone）
```

renderer 与 Host 之间走 DSH 自己的 webServer 路由（本机当前端口 **10341**），
每条都要求 `x-dsh-orb: 1` 头。这个头能穿过 `dsh-app://` 这一跳（Electron 的
`forwardWebRequest` 只删 host/origin/cookie/sec-fetch-site），而普通导航和
跨站表单 POST 都造不出来 —— 这就是 CSRF 边界。

**为什么必须拆进程**：v1 的球是 `shell.overlay` 里的一层 DOM。窗口收进托盘时
整层 DOM 不再渲染，Chromium 还会把隐藏页面的定时器压到 1 次/秒（5 分钟后 1 次/分钟），
连「2.5 秒后复查是否真的停了」都会迟到几十秒。这不是 CSS 能修的，只能在进程边界上拆。

## 2. 行为

**球**：56×56 默认、圆角 17、填充 30%（`fill`）、整体不透明度 88%（`opacity`）。
纯色填充 + 1px 白色描边 + 中心光点，没有任何窗口边框（分层窗口用
`UpdateLayeredWindow`，`AC_SRC_ALPHA` + `SourceConstantAlpha`，**不设** `Form.Opacity`）。
有会话在跑时内侧一圈很淡的脉冲（`pulse` 可关），有未看提示时右上角红色计数（`badge` 可关）。

**置顶看护**：`WS_EX_TOPMOST` 只是一个样式位 —— 它把窗口放进置顶带，带内的先后仍是普通
z 序。任何后来被抬起的置顶程序（播放器、托盘溢出窗、硬件面板、QQ 悬浮条）都会压在球
上面，而球的样式位一个 bit 都没丢，所以「只重设样式位」的看护看不出问题（v2.0 就是这
么漏的）。现在每 500 ms 做一次**真正的 z 序检查**：沿 `GW_HWNDPREV` 往上找第一个
「可见、未 cloaked、不是本进程、与球矩形相交」的置顶窗口，命中就 `SetWindowPos(HWND_TOPMOST)`
把球重新插到置顶带队首，并把被谁压住写进 `orb.log`
（`topmost: ball raised above <class> pid=<n>`，60 秒最多一行，附 `+N more`）。
全屏应用 / 演示模式（`SHQueryUserNotificationState` 为 2/3/4/6）不抢；右键菜单展开时不抢；
显示器变更、会话解锁、DPI 与主题变更会立即补一次。

**拖动**：按住球拖动，位移 ≤3px 算点击。松手时把物理像素坐标 `{x,y}` 报给 Host
写进 `state.json`（坐标钳制在 Win32 有符号 16 位范围内，多屏可以合法为负）。
没拖过的球永远贴右下角。

**气泡**：贴在球上方（球离顶部太近时翻到下方），显示「会话完成 + 会话名称（最多两行）+
还有 N 条」。点气泡 → 让 DSH 打开该会话；点 × → 只收起这一条。每条停留 `bubbleMs`
（默认 8 秒）后自动接上下一条，最多排 4 条。提示框浓度是 `bubbleAlpha`（默认 92%）。

**点球**：有提示就收起当前这条（露出下一条）；没提示就把 DSH 窗口叫到前面。

**右键菜单**（5 行 + 2 条分隔线，坐标在 DPI 1.5 下按物理像素算）：

| 行 | 作用 |
|---|---|
| 打开 DSH | 还原并前置 DSH 主窗口 |
| 打开最近会话 | 给 renderer 排一条 `open-session` 命令；**没有待看提示时灰显不可点** |
| — 分隔线 — | |
| 隐藏悬浮球 | `visible=false`，和设置页开关同一条路径；下方小字提示「要再显示请回设置页」 |
| 复位到右下角 | 忘掉记住的位置 |
| — 分隔线 — | |
| `版本 · 语言 · 150%` | 只读信息行，恒禁用（点击穿透） |

菜单窗口也是 `WS_EX_NOACTIVATE`：它不抢焦点，靠 `SetCapture` 收点击，
手势结束（button-up）会让 WinForms 自动释放 capture，所以有 900 ms 宽限 +
`BeginInvoke` 重捕（`menu: re-took capture=True`）。超过 900 ms 再点就会丢 capture 关掉菜单。

## 3. 显示开关

设置页「行为」组里的 **显示悬浮球**。关掉 = **软静音**：进程和 bridge 连接都留着
（`native.state` 仍是 `running`，SSE `clients:1`），只是 helper 把窗口藏起来，
Host 照常累计待看提示。这样再打开时是瞬间回来，不用重编译/重启。

因为隐藏后的球点不到、右键菜单也一起消失，**回到设置页把开关打开是唯一入口** ——
设置页为此把说明写成了提示文案，`status.visible` 会显示「已隐藏（设置里可再打开）」。

## 4. 设置页（设置 → 会话悬浮球）

页面顶部是**静态预览**（用同样的颜色/圆角/浓度画一颗球 + 一条气泡），
说明文字也写清了「真正的球在屏幕上，不在这张页面里」。下面三组：

| 分组 | 项目 | 默认 | 范围 |
|---|---|---|---|
| 运行状态 | 原生窗口 / 可见性 / 置顶 / DSH 隐藏时 / 位置 / 待看提示 / 指令通道 / 助手程序 | — | 只读 |
| 外观 | 球体填充浓度 `fill` | 30% | 8%–90% |
| 外观 | 整体不透明度 `opacity` | 88% | 25%–100% |
| 外观 | 球体大小 `size` | 56 | 40–80 |
| 外观 | 圆角 `radius` | 17 | 4–40（且 ≤ 大小/2） |
| 外观 | 提示框不透明度 `bubbleAlpha` | 92% | 50%–100% |
| 行为 | 显示悬浮球 `visible` | 开 | 开关 |
| 行为 | 提示停留时长 `bubbleMs` | 8s | 2–30s |
| 行为 | 完成确认窗口 `confirmMs` | 2.5s | 0–15s（0 = 立即弹，容易误报） |
| 行为 | 有会话在跑时脉冲 `pulse` | 开 | 开关 |
| 行为 | 球角显示待看条数 `badge` | 开 | 开关 |

按钮：**弹一条测试提示**（不等真会话，直接验气泡链路）、**复位到右下角**、
**恢复默认外观**、**重启悬浮球**（`revive-native`，只在助手挂了时有用）、**诊断**
（展开 Host 返回的 `native` / `bridge` / `hub.summary()` / 日志尾部原文）。

所有设置存在 `%LOCALAPPDATA%\dsh-session-orb\state.json`，**按设备记**，由 Host、
原生窗口、设置页三方共享（不是 `localStorage`）。v1 存在浏览器里的
`dsh.sessionOrb.settings.v1` / `.position.v1` 会**只迁移一次**（标记键
`dsh.sessionOrb.migrated.v2`），且只在「Host 侧位置为空**且**设置全等于默认值」时才搬，
避免覆盖已经在原生的值。滑杆改动 120 ms 防抖后 PATCH 回 Host，即时生效、不用刷新。

## 5. 完成检测（事件优先，轮询兜底）

Host 订阅这 6 个事件：
`api-session/added` / `removed` / `status` / `activity` / `error`、`agent/status`。
其中前三个携带数据，直接喂给 hub：

- `added` → `hub.noteAdded(summary)`：学标题、`origin`、`cwd`，建立 `running` 基线；
- `removed` → `hub.noteRemoved(id)`：清掉状态，不弹；
- `status` → `hub.noteStatus(id, running)`：**这是主判定源**；
- 其余只是「列表动了，去看一眼」的唤醒信号。

**为什么要 baseline**：插件启动前就在跑的会话不能算「刚跑完」，否则一装上就弹一堆。
`start()` 里置 `baseline = true`。

**为什么要额外 seed 一次**：事件是增量，Host 晚于会话启动时只能靠一次快照对齐。
`seed()` 先试 `provider.listState.list(null)`（门面上那个内部 `ApiSessionList`），
拿不到再试 `provider.list()`，并两种形状都解（`{items}` / 数组 / `{sessions}`）。
两条来源共用同一个 `previousRunning`，所以不会重复记账。`listState` 是内部实现，
所以 seed 失败只 `warn` 一次、不影响后续事件驱动。

**哪些不算完成**：

- `running` 不是布尔值（投影未就绪）→ 视为**未知**，既不计数也不弹；
- `origin === 'subagent'` 的子代理行不弹，只有顶层会话弹；
- `true → false` 只是**候选**：挂 `confirmMs`（默认 2500ms）复查，期间又跑起来就静默丢弃
  （`suppressed`）；已经弹出去的气泡也会**收回**（`retract`）。

**会话名称**：Host 的 `SessionSummary` 不带 `title`，所以标题按顺序取 ——
① 事件行上的 `title`/`displayTitle`（学到就缓存进 `state.json`）；
② renderer 每 4 秒把 `ctx.sessions.list` 里最近 60 个标题 POST 到 `/session-orb/titles`；
③ 会话的工作目录名（`fallbackTitle` 取 `basename(cwd)`）。
三条都没有时 helper 显示「未命名会话」。

**指令通道**：原生窗口在 Electron 进程之外，没法自己调 `uiWorkspace.openSession()`，
所以「点气泡 / 菜单里的打开最近会话」都由 Host 排队（`open-session`，**TTL 60 秒**，
最多 8 条），renderer 轮询 `GET /session-orb/commands` 取走执行。页面可见时 700 ms 一次，
隐藏时 10 s 一次；隐藏时的轮询只是兜底，真正的唤醒是 helper 先把 DSH 窗口显示并聚焦
（`RevealDsh`），页面收到 `visibilitychange`/`focus`/`pointerdown` 会立刻补一次。

**叫回窗口（v4）**：Chromium 的可见性是它自己的 widget/compositor 状态，只有它
自己的窗口过程能改；单靠 `SC_RESTORE` 会让页面停在 `hidden`（冻屏），单靠第二实例
在真机上又不可靠。v4 的组合与并发保护：

0. **并发锁**（`Interlocked.CompareExchange`）：球点击、气泡点击、菜单两行都会触发
   reveal；没有这把锁时狂点会让多个 reveal 并发，每个都 ShellExecute 第二实例、
   各自卡在 WaitShown —— 这正是 v3.1 把窗口拖进"最小化且唤不起"的回归根因。
1. `PostMessage(hwnd, WM_SYSCOMMAND, SC_RESTORE)` **先行**：走 Chromium 窗口过程，
   从最小化和托盘隐藏两种状态都能可靠把窗口映射到屏幕（窗口一定会出现，绝不"死球"）。
2. 紧接着**恰好一次**第二实例（`ShellExecute` 本体路径）→ `focusPrimaryWindow()` →
   `BrowserWindow.show()`，页面收到 visibilitychange、合成器恢复出帧。沙盒复刻版
   （Electron 44.7.0，同窗口参数/同 guard）实测此序列 `vis=True → page=visible`。
3. 仍未显示再试 `dsh://open` 协议（同一条 focusPrimaryWindow 链的另一投递路径）。

> 诚实边界：第二实例的 `show()` 解冻只在沙盒复刻上被证明；真机上"通知是否送达第一
> 实例"仍是未证实项（每次 reveal 只发一个第二实例，绝不刷屏）。若真机仍冻屏，
> `FreezeSentinel.exe` 会在冻结瞬间抓帧哈希 + renderer CPU + 单次唤醒结果，用于定位。

外部直接 `ShowWindow(SW_RESTORE/SW_SHOW)` 从始至终被禁止：它只把 HWND 映射出来，
Chromium 仍认为窗口是隐藏的，画面停在最后一帧（连最小化/还原、改尺寸都救不回来）。
都不奏效就记一条 `reveal:` 日志并放弃 —— 叫不回来远好过冻屏。
helper 全程不弹任何对话框（`SetErrorMode(SEM_NOGPFAULTERRORBOX|…)`），错误只走 bridge/stderr。

**最小化窗口也要能被找到**：最小化时 `GetWindowRect` 给的是 `-32000,-32000` 的 237x39 残桩，
`FindDshWindow` 的 ≥200x200 守卫会把它当成「不是 DSH」丢掉（于是球连窗口都找不到）。
现在 `IsIconic` 为真时跳过该守卫。

## 6. HTTP 面

### bridge（只给 helper，`x-orb-token`，`timingSafeEqual` 比较）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/orb/stream`（`/orb/config` 同义） | SSE：先 `event: hello` 再 `event: state`，15 s 发一次 `: hb` 心跳 |
| GET | `/orb/ping` | 取当前状态文档 |
| POST | `/orb/event` | helper → Host 事件：`ready` `ball-click` `bubble-click` `bubble-close` `drag-end` `menu` `log` `error` `fatal` `bye` |
| POST | `/orb/shutdown` | helper 退出前的告别 |

token 是 `randomBytes(24).toString('hex')`，只通过命令行传给 helper，
**永远不出现在任何 renderer 能看到的对象里**（`runtimeStatus().spawn` 是脱敏视图）。

### renderer 路由（在 DSH webServer 上，全部要求 `x-dsh-orb: 1`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/session-orb/selfcheck` | 一屏全量诊断：`native` / `hub.summary()` / `runtime` / `store` / `log.tail(12)` |
| GET | `/session-orb/state` | 设置、位置、语言、文案、当前提示、摘要、`native.status()`、`bridge` 健康 |
| POST | `/session-orb/settings` | `body.patch ?? body`，钳制后写盘并推流 |
| POST | `/session-orb/position` | `{x,y}` → `store.setPosition` + 推流 |
| POST | `/session-orb/titles` | 合并标题缓存（最多 400 条） |
| POST | `/session-orb/report` | renderer 自报：`visible` / `lang` / `url` / 窗口矩形 / 备注 |
| GET | `/session-orb/commands` | 取走指令（取即出队） |
| POST | `/session-orb/action` | `reset-position` `test-notice` `dismiss` `revive-native` `open-latest` |

缺 `x-dsh-orb: 1` → `403`；方法不对 → `405`；body > 64 KiB → `400`。

## 7. 诊断

```bash
# 当前 DSH Web UI 端口是 10341
curl -s -H "x-dsh-orb: 1" http://127.0.0.1:10341/session-orb/selfcheck
curl -s -H "x-dsh-orb: 1" http://127.0.0.1:10341/session-orb/state
```

`selfcheck.native` 里值得看的字段：

- `state`：`idle` / `compiling` / `running` / `restarting` / `failed` / `unsupported`；
- `reason`：自由文本的失败原文，实际出现过的有
  `the native orb helper targets Windows; this Host runs on <platform>`、
  `refusing to start the helper without a bridge token`、
  `native source is missing: <path>`、
  `no in-box C# compiler (csc.exe) found under %WINDIR%\Microsoft.NET`、
  `csc timed out after 120000 ms`、
  `helper exited with code <n>`、
  `helper exited <n> times in under 10 minutes; giving up. See orb.log.`；
- `pid` / `exe` / `compiledAt` / `restarts` / `platform` / `source`；
- 注意 `status()` **不返回**退出原因 —— `parent-gone` / `shutdown` / `host-unreachable`
  只出现在日志 `orb: helper exited code=… (parent-gone)` 那一行里；
- `hub.summary()`：`running`（当前在跑的会话数）、`runningIds`、`queue`、
  `counters{confirmed,suppressed,retracted,skipped}`、`degraded`（检测退化原因，正常为 `null`）、
  `provider`、`events`（已收到的事件名计数）。

`bridge.clients` 必须是 1（helper 连着 SSE）、`bridge.lastEventType` 反映 helper 最近动作。
**`clients:0` 说明 helper 没连上**，此时球在屏幕上也是死的（它会自己 `parent-gone` 退出）。

日志：`%LOCALAPPDATA%\dsh-session-orb\orb.log`（**不轮转**，长期使用需手动清）。
时间戳是 **UTC**，本机要 +08 才对齐。关键行：

```
orb: 8 renderer route(s) mounted
orb: bridge ready on 127.0.0.1:<port>
orb: compiling helper with <csc> -> <exe>      # 首次/源码变了才有
orb: helper compiled in <n> ms
orb: reusing cached helper <exe>                # 命中缓存
orb: helper ready (pid <pid>, dpi 1.5)
orb: notice for <sessionId> — <title>           # 真正弹了气泡
orb hidden (settings.visible=false)             # 软静音
```

## 8. 文件

```
index.js            Host 入口：inject webServer、挂路由、订阅事件、菜单动作语义、生命周期
client.js           renderer 半边：设置页 + 指令轮询 + 标题/可见性上报（不含球）
host/hub.js         检测状态机：baseline、确认窗、排队、收回、指令队列、SSE 推送节流
host/native.js      找 csc、按源码哈希编译、启动/重启/裁剪构建目录、状态机
host/store.js       state.json 读写、钳制、标题缓存、日志
host/transport.js   OrbBridge（helper 专用）+ createRendererRoutes（8 条）
native/SessionOrb.cs  原生分层窗口：自绘、拖动、气泡、右键菜单、token 校验、父进程看护
locale/{zh,en}.json   插件卡片文案（meta.title / meta.description）
cordis.patch.yml    insert 一行 { id: session-orb, name: dsh-session-orb }
icon.svg            插件图标
package.json        bundle 清单：dsh.bundle.patch + dsh.client + engines.dsh
docs/deep-review.md 深度评审：逐项验收、根因、风险清单
```

数据目录 `%LOCALAPPDATA%\dsh-session-orb\`：`state.json`、`orb.log`、`build\<hash>\SessionOrb.exe`。
构建目录按源码 SHA-1 前 12 位分目录，命中就复用；换源后旧目录会被裁掉（正在用的那个除外）。

## 9. 移植 / 卸载

- 换机器：整个目录拷到目标 profile 的 `plugins/`，在插件管理里安装本目录（写进
  `dependencies`（`link:`）和 `dsh.profile.bundles`），刷新页面。首次会自动编译 helper，
  **需要目标机有 Windows 自带的 .NET Framework `csc.exe`**（`%WINDIR%\Microsoft.NET\Framework64\v4*`）。
- 卸载：插件管理里停用/移除即可。`%LOCALAPPDATA%\dsh-session-orb\` 整个目录可删
  （含编译产物与日志）；`localStorage` 里 v1 的两个键留着无副作用，想清就删。

## 10. 已知边界

- **只在 Windows 上有球**。其它平台 `native.js` 直接报 `unsupported`，日志写明
  「the native helper is Windows-only」，设置页仍可打开、只是没有窗口。
- 依赖系统自带的 `csc.exe`；机器上如果连 .NET Framework 4.x 都没有，
  状态会停在 `failed` / `reason: csc-missing`，设置页会显示原文。
- 编译发生在**首次加载**（本机实测 591 / 696 / 1308 ms，日志里有
  `orb: helper compiled in <n> ms`），此后命中缓存直接起进程。源码一改哈希就变，
  会重编译并写到新目录。
- `confirmMs` 的代价是双向的：调大更不容易误报，但真正的完成也会晚这么久才弹。
  带 goal 的会话每轮之间 `running` 会短暂变 false，靠这个窗口和 `retract` 兜住。
- 标题可能比回合晚到（renderer 4 秒同步一次），气泡里的名字偶尔先是 fallback，
  下一次刷新才对上。
- 指令 TTL 60 秒：DSH 页面长时间不可见又没有任何唤醒时，「打开最近会话」可能过期失效 ——
  这是刻意的，宁可失效也不要在几十分钟后突然跳走。
- 只有**一颗球**（单实例）：设置、位置、待看队列都是全局的，不按窗口/会话分。
- helper 崩溃会自动重启（最多 5 次 / 10 分钟，退避 400/900/1800/3500/7000 ms）；
  连续失败就停在 `failed` 等「重启悬浮球」手动拉起。
- `orb.log` 不轮转，长期挂着会一直长。
- 置顶靠 500 ms 一次的 z 序看护：被别的置顶程序压住后最迟约 2 秒回到最前面；
  全屏独占应用（游戏、演示模式）期间刻意不抢，退出后自动补回。真·独占全屏与 UAC
  安全桌面下看不到球，这是 Windows 的语义，不是插件能改的。
