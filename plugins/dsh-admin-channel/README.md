# dsh-admin-channel — 会话级管理员权限通道

用户指令（2026-10-29）：给智能体一个管理员权限通道，避免每次执行缺乏权限的任务都要
用户在场同意 UAC；启动通道的 UI 放在**工具箱**（输入框工具行的「工作箱」）内，并在
**单个会话内持久化**。

## 用户怎么用

1. 在输入框工具行点开「工作箱」（电源图标）；
2. 拨开 **管理员权限通道** —— Windows 弹出**一次** UAC，点「是」；
3. 之后本会话里智能体调用 `admin_exec` 执行提权命令，**不再逐次弹 UAC**；
4. 关闭开关 / 会话结束 / 空闲 30 分钟 / 插件卸载 → 提权进程退出。

工作箱里的那一行由 `dsh-workbench` 的 ACTIONS 表登记，指向本插件的
`/dsh-admin-channel/action`；开关状态、阶段说明与悬停提示全部来自
`/dsh-admin-channel/status`。本插件**不注册任何自己的 UI 座位**。

## 架构

```
工作箱开关（用户点击）
   │  POST /dsh-admin-channel/action {sessionId, enabled:true}
   ▼
host 插件（index.js / lib/channel.js）
   │  spawn: powershell launch.ps1 -Spec <spec.json>      ← 非提权
   ▼
launch.ps1 ── Start-Process -Verb RunAs ──► UAC（唯一一次）
   │
   ▼
broker.ps1（管理员令牌，隐藏窗口）
   │  命名管道 \\.\pipe\dsh-admin-channel-<nonce>
   │  创建时即带显式 DACL（当前用户 / SYSTEM / Administrators）
   │  校验：随机 256 位令牌 + GetNamedPipeClientProcessId == host PID
   ▼
admin_exec 工具（lib/channel.js 串行转发）
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
| `timeout_ms` | 否 | 单条命令超时（默认 120000，上限 1800000）；超时会杀掉整棵进程树 |

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

## 生命周期（会话级持久化）

| 事件 | 结果 |
|---|---|
| 用户拨开 | 建立通道；同会话内的工具调用持续可用（页面刷新、切换对话视图都不影响） |
| 用户拨关 | 写 `cancel` 标记 → broker 杀掉在跑的命令树并退出 → 确认退出后清临时目录 |
| 会话销毁（`agent/disposed`） | 同上（`session-disposed`） |
| 空闲超时（默认 30 分钟，最后一次执行后计时） | 同上（`idle`） |
| 插件卸载/重载（HMR） | 关闭全部通道（`plugin-dispose`） |
| UAC 还在等 / broker 还没连上时拨关 | 杀掉非提权 launcher、清目录；之后才批下来的 broker 读不到 spec 或看到 `cancel`，启动阶段即退出 |
| host 进程退出 | 管道断开，broker 自行退出 |
| broker 崩溃/被杀 | 状态转 `error`；开关显示失败原因，可重新拨开 |

关闭语义是「确认后才报 off」：非提权 host 的 `taskkill` 打不动高完整性进程，所以
如果 broker 因为不可中断的原因没退出，状态会停在 `error` 并提示稍后重试，
不会出现「界面显示已关闭、提权进程还在跑」的假象。

同一时间默认只允许 **1** 条通道（`maxChannels`）；在别的会话拨开关会返回冲突提示，
不会偷偷替换已有通道。

## 安全边界（必须知情）

- 这是**有意**的提权桥：通道开启期间，以当前用户完整性级别运行的恶意程序如果
  能冒充 host 进程，就等价于拿到管理员权限。为此：
  - broker 只接受 **客户端 PID == host PID** 的连接（`GetNamedPipeClientProcessId`），
    其它同用户进程连上来会被拒绝；
  - 每个请求都要带本次启动的 256 位随机令牌；
  - 管道 ACL 在创建时显式授予当前用户 / Administrators / SYSTEM；
  - 提权侧只按 **`%SystemRoot%` 绝对路径**启动 `powershell.exe` / `cmd.exe`，
    不会从 cwd/PATH 解析同名程序（防止被投放的同名 exe 提权）；
  - 通道不落盘、不跨进程恢复，生命周期与会话/空闲/插件同寿；
  - 所有执行写入 `$DSH_HOME/admin-channel/audit.jsonl`（命令、退出码、耗时）。
- UAC 仍然需要用户**一次**在场确认——这是 Windows 的边界，不能被插件绕过；
  本插件只消除「每次命令都确认」。
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
  非浏览器进程仍可请求启动/关闭。启动一定会弹 UAC（用户可见），所以这不是静默
  提权，但可以造成 UAC 骚扰或关闭你正在用的通道。`/diagnostics` 已移除以减少读面。
- **提权进程的令牌差异**：UAC 提权令牌通常看不到普通进程映射的网络驱动器；需要
  访问网络共享时请在命令里用 UNC 路径或先 `net use`。

## 配置（cordis.patch.yml 的 config）

```yaml
- insert:
    - id: admin-channel
      name: './entry-v5.js'
      config:
        uacTimeoutMs: 120000      # UAC 等待上限
        idleTimeoutMs: 1800000    # 空闲自动关闭
        maxChannels: 1            # 全局并发通道数
        execTimeoutMs: 120000     # 默认单命令超时
        maxExecTimeoutMs: 1800000 # 单命令超时上限
        maxOutputBytes: 262144    # stdout/stderr 各自上限
```

## 自测

```
node test/self-test.mjs           # 15 项：非提权 broker 的握手/认证/执行/UTF-8/退出码/超时/停止/PID
node test/manager-test.mjs        # 18 项：工具 schema 契约、未开启时的报错、路由守卫、状态与关闭
node test/sandbox-lifecycle.mjs   # 20 项：无 UAC、无桌面的完整生命周期（含执行中关闭）
```

`test/sandbox-lifecycle.mjs` 是给「不要控制真机桌面」准备的：它用注入的 launcher
**直接起非提权 broker**，跑完整的 host 管理器路径——启动握手、`admin_exec`、
并发上限、关闭清理、空闲自动关闭、审计落盘，全程不弹 UAC、不动鼠标/窗口。
生产 launcher（UAC 那条）用同一套 `lib/channel.js`，只替换 launch 函数。

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
