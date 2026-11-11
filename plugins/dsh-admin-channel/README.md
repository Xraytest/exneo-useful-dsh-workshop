# dsh-admin-channel — 管理员权限通道（启动授权 + 会话挂载）

用户指令（2026-10-29）：给智能体一个管理员权限通道，避免每次执行缺乏权限的任务都要
用户在场同意 UAC；启动通道的 UI 放在**工具箱**（输入框工具行的「工作箱」）内，并在
**单个会话内持久化**。

用户指令（2026-11-07，v11）：**制作一个插件允许在 dsh 启动时请求管理员权限提供给会话，
可选开启权限时不需要再弹窗**。实现口径（用户在选择里确认「DSH 每次启动弹一次」）：
DSH 一起来就弹**一次** UAC，建立**常驻提权授权**；之后任何会话拨开关都只是挂载到
那个进程上，**零弹窗**。不做计划任务/开机常驻——提权进程不可能比 DSH 宿主活得更久。

## 用户怎么用

**v11 默认（startupConsent: true）**

1. 启动 DSH → Windows 弹出**一次** UAC，点「是」（不想弹可以直接点「否」，本进程内
   不再自动追问，回到下面旧流程）；
2. 在输入框工具行点开「工作箱」（电源图标）；
3. 拨开 **管理员权限通道** —— **不弹窗**，状态直接变「已开启（挂载常驻提权授权）」；
4. 智能体调用 `admin_exec` 执行提权命令；会话拨关或销毁只是**摘挂载**，常驻进程继续
   给其它会话服务；
5. 关闭 DSH（或插件卸载）→ 管道断开 → 常驻提权进程自行退出。

**startupConsent: false（回到 v10 语义）**

1. 在输入框工具行点开「工作箱」（电源图标）；
2. 拨开 **管理员权限通道** —— Windows 弹出**一次** UAC，点「是」；
3. 之后本会话里智能体调用 `admin_exec` 执行提权命令，**不再逐次弹 UAC**；
4. 关闭开关 / 会话结束 / 插件卸载 → 提权进程退出（**不设空闲超时**，见下）。

工作箱里的那一行由 `dsh-workbench` 的 ACTIONS 表登记，指向本插件的
`/dsh-admin-channel/action`；开关状态、阶段说明与悬停提示全部来自
`/dsh-admin-channel/status`。本插件**不注册任何自己的 UI 座位**。

> 启动授权不提供 UI 开关：它是配置项（`cordis.patch.yml` 的 `startupConsent`）。
> 原因见「安全边界」——本插件的路由只接受 host 内部回环，**不能**开一条浏览器可
> 触达的「拉起 UAC」路由，否则网页脚本就能靠它做弹窗骚扰/抢占。改配置需要 Loader
> 重启插件，成本比多一条路由低，风险却小得多。

> **「一次」的准确范围**：UAC 发生在 **DSH 启动** 和 **本插件每次被重新加载**（安装/
> 升级/重载插件包、改 patch 让 Loader 重启它）时。重载时旧授权必须被 `disposeAll()`
> 关掉（否则提权进程无人看管），重载完再请求一次——这是「提权进程绝不脱离宿主」
> 换来的必要代价，不是漏掉的优化。日常对话、切会话、页面刷新都**不会**再弹。

## 架构

```
DSH 启动（apply）
   │  bootstrapAuthority() → spawnBrokerRecord(AUTHORITY_KEY)     ← 非提权
   ▼
launch.ps1 ── Start-Process -Verb RunAs ──► UAC（整个进程生命周期唯一一次）
   │
   ▼
broker.ps1（管理员令牌，隐藏窗口）＝「常驻提权授权」
   │  命名管道 \\.\pipe\dsh-admin-channel-<nonce>
   │  创建时即带显式 DACL（当前用户 / SYSTEM / Administrators）
   │  校验：随机 256 位令牌 + GetNamedPipeClientProcessId == host PID
   │  只接受 1 个管道客户端；host 断开 → ReadLine 返回 null → 立即退出
   ▲
   │  attach（零 UAC）
工作箱开关（用户点击）
   │  POST /dsh-admin-channel/action {sessionId, enabled:true}
   ▼
host 插件 start(sessionId) → 授权可用/正在等 → attached.set(sessionId, AUTHORITY_KEY)
   │  （授权不可用才回落：为这个会话单独 spawn → 本会话弹一次 UAC）
   ▼
admin_exec 工具（lib/channel.js 串行转发；审计按**发起会话**记录）
```

每次启动使用新的管道名、新的令牌、新的临时目录；spec 文件 0600。令牌不落盘、
不跨进程恢复：host 退出 → 管道断开 → broker 自行退出（残留的空等进程也会在
`connectTimeoutMs` 后退出）。

> 实测记录（2026-10-29，本机）：第一次 UAC 成功后暴露了一个 bug——用默认安全
> 描述符创建管道时，非提权 host 连接被拒（`EPERM`）；改为在
> `NamedPipeServerStream` 构造时传入显式 `PipeSecurity` 后，host 连接成功，
> 工具返回 `Elevated=True` / `High Mandatory Level`，`net session` 也通过。

## 模型工具：`admin_exec`

| 参数 | 必填 | 说明 |
|---|---|---|
| `command` | 是 | 在提权进程中执行的 PowerShell 命令；每次一条新进程（`-NoProfile -NonInteractive`） |
| `cwd` | 否 | 工作目录；默认提权进程的用户主目录 |
| `timeout_ms` | 否 | **默认不给 = 不限时**（v9）。显式给正数才对这一条命令设硬上限；超时只杀该命令进程树，通道本身继续开着 |

返回：`exitCode / stdout / stderr / timedOut / durationMs / truncated / elevated`。
输出按 `maxOutputBytes`（默认 256 KiB）截断；UTF-8。报告的 `exitCode` 是 PowerShell
进程的退出码——需要让模型感知失败时，请在命令末尾显式 `exit N`（仅 `Write-Error`
不会改变退出码）。

**Schema 契约（v1.0.6 修复）**：`ctx.tools.register()` 会把 `parameters` **原样**
透传给模型供应商；GLM/zai 等 openai-completions 路由（`supportsStrictMode: true`）
会校验 `function.parameters` 必须是 `type:'object'` 的标准 JSON Schema。写成作者
方言（每个属性挂 `required:true`、顶层没有 `type:'object'`）会让供应商拒绝整个
请求：`Invalid schema for function 'admin_exec': schema must be a JSON Schema of
'type: "object"', got 'type: null'`。本插件的 `parameters` 因此必须是
`{ type:'object', properties:{…}, required:[…] }` 标准形态；`test/manager-test.mjs`
把这条契约固化成了断言。

**通道没开时工具会失败**并给出「请用户去工作箱拨开关」的提示。工具**不能**启动
通道——启动动作只接受工作箱（host 内部回环）的请求，浏览器页面发起的请求一律
403（`Origin` / `Sec-Fetch-*` 守卫）。

工具在每个会话都可见（模型需要知道「有这个能力」），但只有**开启通道的那个会话**
能执行；其它会话调用会得到「本会话没有开启」的错误。这既是会话级持久化的边界，
也避免一个会话的授权被另一个会话借用。

## 生命周期

| 事件 | 结果 |
|---|---|
| DSH 启动（`startupConsent: true`） | `bootstrapAuthority()` 弹**一次** UAC，建立常驻提权授权（记录键 `authority:dsh-admin-channel`） |
| 用户在 UAC 点「否」/ 启动失败 | 授权进入 `error` + `declined`，**本进程内不再自动追问**；会话可自建通道 |
| 会话拨开（授权可用**或正在等 UAC**） | 只挂载（`attach`），**零 spawn、零弹窗**；正在等时命令会得到「等启动那一次 UAC」的明确报错 |
| 会话拨开（授权不可用且 `startupConsent:false`） | 为该会话单独 spawn → 本会话一次 UAC（v10 旧行为） |
| 会话拨关 / 会话销毁（`agent/disposed`） | 只摘挂载（`detach`），常驻进程**继续为其它会话服务** |
| `maxChannels` 用尽而该会话可挂载 | 不占用额度：挂载不受 `maxChannels` 限制（它只数**自建**通道） |
| `idleTimeoutMs` 到点（需显式配正数） | 授权上**还有会话挂载 → 重新计时**；没人挂载 → 关闭常驻进程 |
| 授权进程崩掉 / 管道断开 | `markLost`：授权转 `error`，**所有挂载会话自动摘除**（回到 off，可重新拨开走自建） |
| 用户拨关 / 会话结束 | 会话自建通道：写 `cancel` 标记 → broker 杀掉在跑的命令树并退出 → 确认退出后清临时目录 |
| 插件卸载/重载（HMR） | `disposeAll()` 关闭全部会话通道**与常驻授权**（提权进程绝不比宿主长寿） |
| UAC 还在等 / broker 还没连上时拨关 | 杀掉非提权 launcher、清目录；之后才批下来的 broker 读不到 spec 或看到 `cancel`，启动阶段即退出 |
| **host 进程退出** | 管道断开 → broker 自行退出。**这是「启动授权」不会残留提权进程的根本原因** |
| broker 崩溃/被杀 | 状态转 `error`；开关显示失败原因，可重新拨开 |

> 授权记录与借用记录走的是**同一份** `spawnBrokerRecord()`：同一 `broker.ps1`、同一套
> 每次启动新令牌、同一 PID 校验、同一管道 ACL——没有第二套提权代码可以漂移。

关闭语义是「确认后才报 off」：非提权 host 的 `taskkill` 打不动高完整性进程，所以
如果 broker 因为不可中断的原因没退出，状态会停在 `error` 并提示稍后重试，
不会出现「界面显示已关闭、提权进程还在跑」的假象。

同一时间默认只允许 **1** 条**自建**通道（`maxChannels`）；在别的会话拨开关会返回冲突提示，
不会偷偷替换已有通道。挂载在授权上的会话不受此限。

## 安全边界（必须知情）

- 这是**有意**的提权桥：通道开启期间，以当前用户完整性级别运行的恶意程序如果
  能冒充 host 进程，就等价于拿到管理员权限。为此：
  - broker 只接受 **客户端 PID == host PID** 的连接（`GetNamedPipeClientProcessId`），
    其它同用户进程连上来会被拒绝；
  - 每个请求都要带本次启动的 256 位随机令牌；
  - 管道 ACL 在创建时显式授予当前用户 / Administrators / SYSTEM；
  - 提权侧只按 **`%SystemRoot%` 绝对路径**启动 `powershell.exe` / `cmd.exe`，
    不会从 cwd/PATH 解析同名程序（防止被投放的同名 exe 提权）；
  - 通道不落盘、不跨进程恢复，生命周期与会话/拨关/插件同寿（v9：无任何时间限制，
    UAC 等待、闲置、单命令超时默认都不掐表）；
  - 所有执行写入 `$DSH_HOME/admin-channel/audit.jsonl`（命令、退出码、耗时）。
    实际事件词汇（与 `lib/channel.js` 一致）：`start-request / start / stop /
    stop-timeout / exec / channel-lost / start-failed`，v11 新增 **`attach`**（会话
    挂载到常驻授权，带发起 `sessionId` 与授权侧 `brokerPid`）、**`detach`**（某会话
    摘挂载，带 `reason`）、**`detach-all`**（释放授权时批量摘除）、
    **`authority-release`**。插件重载/会话销毁不是独立事件，而是 `stop` 的
    `reason`（`plugin-dispose` / `session-disposed` / `user` / `idle` /
    `exec-failure`）。**命令审计始终按发起会话的 `sessionId` 记录**，借用不糊账——
    这条有断言保护。
- UAC 仍然需要用户**一次**在场确认——这是 Windows 的边界，不能被插件绕过；
  本插件只消除「每次命令都确认」。
- **同意不被稀释**（v11 的关键设计点）：常驻授权就绪**不等于**某个会话有权用它。
  挂载只由用户在工作箱里拨开关这一**明确动作**触发；没拨开关的会话调用 `admin_exec`
  仍然得到「本会话没有开启」的错误。`test/authority-test.mjs` 把这条固化成断言。
- **提权进程不可能比 DSH 宿主活得更久**：broker 只接受 1 个管道客户端，客户端断开
  → `ReadLine` 返回 null → 立即退出；因此「启动时那一次授权」的作用域恰好等于
  DSH 进程的生命周期，不需要计划任务、不需要开机常驻，也不会留下没人看的提权进程。
- 若当前账户不是管理员，UAC 会要求输入管理员密码，提权进程将属于另一个账户；
  此时管道 ACL 已同时授权 host 用户，但仍建议在管理员账户下使用。
- 提权进程执行的是**用户/智能体给的命令**，没有额外命令白名单；请只在自己信任的
  会话里开启，用完即关。

### 已知残余风险（本插件不解决，需要知情）

- **插件目录是用户可写的**：`broker.ps1` 在 `D:\WorkSpace\plugins\...` 下，任何
  同用户进程都能改它。提权运行时执行的就是这份代码——与「以管理员身份运行一个
  用户目录里的脚本」同级信任。只启用你信任的插件；不要把它装到共享/可被他人写入
  的位置。彻底解决需要管理员 ACL 的安装目录或签名，超出本插件范围。
- **管道抢占（本地同用户）**：spec 文件（含管道名与令牌）在用户临时目录里，同用户
  恶意进程若在 UAC 等待窗口内抢先创建同名管道，可能冒充 broker 收发命令。host 目前
  只能校验「客户端 = host」，不能证明「服务端 = 真正的提权进程」；要彻底解决需要
  一个独立的提权证明（例如 HKLM 写入挑战值）或安装器级信任锚。
- **本机未鉴权的控制路由**：`/dsh-admin-channel/action` 只拒绝浏览器来源；本机
  非浏览器进程仍可请求启动/关闭。会话 id 必须是**本进程内活跃的 Agent**
  （`agentOnline` 失败关闭），所以外来进程只能冒充**已有会话**，不能凭空造一个。
  `/diagnostics` 已移除以减少读面。
  ⚠ **v11 让这条风险变严重了**（修正下面这句旧结论）：在 v10 及之前，本机进程发起
  「开启」必然弹出 UAC，用户看得见，所以那只是弹窗骚扰；**常驻授权就绪后，同一请求
  变成零弹窗挂载**——本机同权限的恶意进程可以在用户不在场时，把某个活跃会话接上
  提权执行。可观测的补救：每次挂载都会写审计 `attach`（带发起 `sessionId` 与授权
  `brokerPid`），且工作箱里那一行会显示为已开启；不接受这个暴露就把
  `startupConsent` 设为 `false`（任何挂载请求都会退化成一次可见的 UAC）。
  彻底修复需要「请求方进程 == host 进程」的证明（TCP 回环侧取客户端 PID，等价于
  broker 已经在做的 `GetNamedPipeClientProcessId`），那是跨语言改动，未在本插件内实现。
  v11 **刻意没有**新增「启动授权」的浏览器可触达开关路由：否则网页脚本就能靠它
  反复拉起 UAC（弹窗骚扰）或在授权窗口里抢占管道。
- **v11 换来的代价（用户已选择的权衡）**：授权就绪后，**任意**会话拨开关都零弹窗，
  意味着「一次 UAC」被摊薄成「一次 UAC + 之后每次开关无需再确认」。因此
  ① 智能体说服用户拨开关 = 拿到提权执行，不再有第二次确认的机会；
  ② 提权进程的存活期从「某个会话开启通道期间」变成「整个 DSH 进程生命周期」，
  与插件目录可写、管道抢占这两条风险的暴露窗口一起变长。
  不接受这个权衡就把 `startupConsent` 设成 `false`（回到逐会话一次 UAC）。
- **提权进程的令牌差异**：UAC 提权令牌通常看不到普通进程映射的网络驱动器；需要
  访问网络共享时请在命令里用 UNC 路径或先 `net use`。

## 配置（cordis.patch.yml 的 config）

v9 起每一项时长都支持 **0（或负值）= 不限时**，且**默认全部为 0**（用户指令
2026-11-07「去除隧道提权时间限制」）。想恢复某个上限，把它改回正数即可。

```yaml
- insert:
    - id: admin-channel
      name: './entry-v11.js'
      config:
        startupConsent: true       # v11：DSH 启动时弹一次 UAC 建立常驻授权；false = 回到逐会话一次 UAC
        uacTimeoutMs: 0            # UAC 等待上限；0 = 一直等用户点「是」（默认）
        idleTimeoutMs: 0           # 空闲自动关闭；0 = 不因闲置过期（默认）
        maxChannels: 1             # 全局并发**自建**通道数（挂载不占额度）
        execTimeoutMs: 0           # 单条命令默认超时；0 = 命令可跑任意久（默认）
        maxExecTimeoutMs: 0        # 模型显式传 timeout_ms 时的上限；0 = 不设上限（默认）
        maxOutputBytes: 262144     # stdout/stderr 各自上限（字节，不是时间限制）
```

`startupConsent` 的解析口径：`raw.startupConsent !== false` → **默认开**；只有显式
写 `false` 才关（写 `"false"`、`0`、留空都算「开」）。这条**故意朝保守方向失效**：
误配的结果是多弹一次可见的 UAC，而不是少弹——不会出现「以为关了其实还开着」的静默授权。
`resolveDuration()` 的口径：缺省 / 空串 / 非法值 → 回落 0（不限时）；显式正数才
生效，并被夹在各自 [min, max] 内（`uacTimeoutMs` 10s..10min、`idleTimeoutMs`
5s..24h、`execTimeoutMs` 1s..24h、`maxExecTimeoutMs` 1s..24h）。
`statusOf()` 回包里的 `idleTimeoutMs` 即当前生效值（0 = 不限时）。

> **超大 `timeout_ms` 当作不限时。** Node 的 `setTimeout` 对 > 2^31-1 ms 的值会
> 静默夹成 **1ms**（`TimeoutOverflowWarning`）。若照原样透传，一条「想要很长超时」
> 的请求会秒退，并被 `exec-failure` 分支连带关掉整条通道。所以 host 与 broker 都
> 把超过 24h 的正数按 0（不限时）处理，broker 对正数的夹取区间也是 [1s, 24h]。

> **不限时 ≠ 无边界。** 提权进程的退出仍然由四条确定性通道保证：host 写 `cancel`
> 文件、spec 被删除、`ownerPid`（host 进程）消失、命名管道断开——broker 在等连接
> 和跑命令两个循环里都会逐 200ms 检查这些条件。旧的「时间到点自动收摊」被移除后，
> 这些检查就是唯一的生命周期边界，因此 `manager-test` / `self-test` /
> `sandbox-lifecycle` 都保留了对应用例（含「不限时等待可被拨关取消」「执行中关闭
> 杀掉命令树」）。

> **一处需要知情的安全权衡**：`uacTimeoutMs: 0` 让 UAC 等待窗口不再封顶，而
> 「管道抢占」残余风险的窗口就跟着变长（见上文「已知残余风险」）。若你在不可信
> 环境里使用，把它配回正数（例如 120000）来限制未授权启动能挂多久。

## 自测

```
node test/self-test.mjs           # 20 项：非提权 broker 的握手/认证/执行/UTF-8/退出码/超时/timeoutMs=0 不限时/极端 timeoutMs 不崩/停止/PID
node test/manager-test.mjs        # 25 项：默认时长全部为 0（不限时）、工具 schema 契约、未开启时的报错、路由守卫、状态与关闭
node test/sandbox-lifecycle.mjs   # 37 项：无 UAC、无桌面的完整生命周期（含执行中关闭、不限时等待可取消、超大 timeout_ms 不溢出）
node test/authority-test.mjs      # 34 项：v11 启动授权（挂载零 spawn、拨关不杀共享进程、审计按发起会话、幂等、回落自建、startupConsent:false、失败 declined、未拨开关不得借用）
```

> `test/manager-test.mjs` 调 `plugin.apply()` 时**必须**传 `startupConsent: false`：
> `apply()` 现在会调用 `bootstrapAuthority()`，而该测试没有注入 fake launcher，
> 放过去就是在测试机上真弹一次 UAC。授权本身的逻辑全部走 `authority-test.mjs`
> 的注入桩。

`test/sandbox-lifecycle.mjs` 是给「不要控制真机桌面」准备的：它用注入的 launcher
**直接起非提权 broker**，跑完整的 host 管理器路径——启动握手、`admin_exec`、
并发上限、关闭清理、空闲自动关闭、审计落盘，全程不弹 UAC、不动鼠标/窗口。
生产 launcher（UAC 那条）用同一套 `lib/channel.js`，只替换 launch 函数。
`test/authority-test.mjs` 同理，只是多了一个 `spawns` 计数器：断言的是「用户被弹了
几次」（= launcher 被调用几次），而不是 UAC 的结果。

提权后的端到端路径（launch.ps1 → UAC → broker）只能在真实桌面由用户点一次「是」
验证；自测证明**未提权**的 broker 会被 host 拒绝（`ready.elevated === false`）。

实测（2026-10-29）：

- 第一次 UAC 授权成功，但默认管道 DACL 拒绝非提权 host（`connect EPERM`）→ 已修复
  （显式 `PipeSecurity` 传给构造器）；修复后 15 项自测重跑通过。
- 第二次 UAC：通道 4 秒内就绪（`elevated:true`，broker pid 30168）。
- `admin_exec` 返回 `Elevated=True`、`Mandatory Label\High Mandatory Level`；
  `net session` 通过（普通权限下是 `Access is denied`）。
- 停止后：状态 `off`、broker 进程消失、临时目录清空；审计日志 7 条（start/exec/stop）。

## 维护

- 改 host 实现：新写 `entry-v<N+1>.js`，把其中 `./index.js?v=` 加一，**同时**把
  `index.js` 里 `./lib/channel.js?v=` 的版本号改成同一个（三层链必须一起换，漏一层
  就是「新 index 用旧 channel」）；再把 `cordis.patch.yml` 的 name 指过去
  （row id 不变），然后 remove → install。
- **工具 schema 是标准 JSON Schema**（顶层 `type:'object'` + `properties` +
  顶层 `required` 数组）——不要改回作者方言，strict 供应商会拒绝整条请求。
- `broker.ps1` / `launch.ps1` 必须保持 **ASCII**（Windows PowerShell 5.1 会把无 BOM
  的脚本按 ANSI 读）；用户命令由 broker 写成带 BOM 的 UTF-8 临时脚本再执行。
- 工作箱那一行在 `dsh-workbench` 的 `ACTIONS` 表里；本插件只提供
  `/dsh-admin-channel/status` 与 `/dsh-admin-channel/action` 两个同源路由。
