# dsh-device-mesh（设备网格）

把**装了本插件的其它 DSH** 接入当前设备，并把会话按 **设备 → 工作区 → 会话** 三级汇总展示；
在此之上允许工作区拥有多个工作路径（可位于别的设备），并支持**跨设备执行命令**。

一个静态插件（profile patch 的一行），host 半边 + 浏览器半边。
host 半边只消费出厂服务（`webServer` / `workspaceRegistry` / `sessionQuery` /
`sessionProjectionCache` / `tools`），**不修改任何出厂数据** —— 工作区归属、
主路径、会话账目全部只读。

自测：`node selftest.mjs`（117 项，两个节点真跑 HTTP 互接）。当前实现：`entry-v10.js`。

> **第一次装上之后要刷新一次浏览器页面。** 浏览器半边的 boot 图是在页面加载时注入
> `index.html` 的，新加的客户端包不会自己出现在已经打开的页面里。
> 刷新后侧边栏会出现「设备网格」按钮。判断它到底有没有进图，看
> `GET /dsh-device-mesh/status` 的 `clientModules` 字段：
> `{"available": true, "inGraph": true, "bundle": ".../client.js"}` 就是已经在图里了。

---

## 1. 概念与拓扑

装了本插件的每一台 DSH 都是一个**节点**。节点可以同时扮演两个角色：

| 角色 | 含义 |
| --- | --- |
| **接入点（inbound）** | 开放 `/dsh-device-mesh/api/*`，让别的节点带令牌接入，接收它们上报的清单 |
| **接入方（outbound）** | 主动 join 别的接入点，把自己的清单推过去 |

两边都开就是一张**对等网格**：A 接 B、B 接 C 之后，A 的界面上也能看见 C。

「能看见 C」靠的是**一跳镜像**：本机向接入点 join 成功后，会顺带拉一次对方的
「一跳总览」（`POST /api/tree`），把对方自己 + 对方接入的节点一起拿回来。

**一跳是硬边界**：`/api/tree` 只返回「自己 + 自己接入的节点」，**不返回**它从别处镜像来的
设备。这条规则同时挡住两件事 —— 网格成环时的无限递归，以及设备数按跳数指数膨胀。
响应里的 `scope: 'direct'` 就是这个承诺的名字。

方向语义（容易写反，自测里两边都钉住了）：

- hub 看 joiner 是 `via.kind = 'inbound'`（「接入本机」）
- joiner 看 hub 是 `via.kind = 'outbound'`（「经接入点 X」）
- 同一台设备通过多条路径可见时，保留最直接的一条，其余如实记进 `alsoVia`
  —— 不静默去重，否则会让人以为网格里少了一台设备

---

## 2. 三级视图

```
设备（本机 / 接入本机的节点 / 经接入点镜像来的设备）
└─ 工作区（出厂 workspaceRegistry 的 path + title + header 校验过的会话账目）
   └─ 会话（sessionQuery 的完整逻辑语料：live + 持久化合并）
```

工作区归属判定与出厂语义逐条对齐，另外补了一条：

1. 会话 id 在某工作区的 `sessionIds` 里 → 该工作区（**权威**，`inferred: false`）
2. 否则 `cwd` 精确等于某工作区 path → 该工作区（`inferred: true`）
3. 否则 `cwd` 落在某工作区路径**之下**（最长前缀）→ 该工作区（`inferred: true`）
4. 都不命中 → `unassigned`，按 cwd 分组交给 UI 兜底

第 3 条是本插件加的：出厂只认精确相等，于是「在工作区子目录里开的会话」在侧边栏是散着的；
跨设备总览里散着没法看。推断来的归属一律标 `inferred`，UI 画成弱化行，
**权威归属永不被覆盖**（第 1 条优先）。

### 工作区归到**属主**那台，不归报告它的那台

「会话的 cwd 落在某个工作区路径上」会让**本机注册表**把这个工作区记成*本机的* —— 互联
会话正是这种情形（会话在会话端跑、文件在属主那台）。于是设备网格面板里，会话端名下会
冒出几个其实属于属主的工作区，用户实测指出这是**错误归类**。

归属的权威是配置声明 `workspaceRoles[path].owner`（§4.1），不是「谁先登记」：

- host 给**每台设备**清单里的工作区打上 `ownerDeviceId` / `ownerDeviceName` / `ownerDeclared`
  —— **只在该工作区声明了 `mesh: true`、且声明的属主是另一台设备时才出现**（属主就是本机、
  或没声明 mesh 的纯本地工作区都不加字段，UI 的缺省就是「这台自己的」）；名字解析不出来时
  **不猜**（宁可不标也不标错）；
- 面板里：属主在别处的工作区**不再列在报告设备名下**（只留一行「属主是 X」的说明），
  它们出现在**属主**那条下面；
- **会话合并**：同一个工作区的会话来自两台（会话端 1194 条 + 属主 1456 条，实测数据），
  合并到属主那条里按 session id 去重，每条带「是哪台在跑」的标签 —— 否则把工作区挪走后，
  会话端那些会话就整个看不见了。

标注在 `scope: 'direct'`（推给对端的镜像）上也带 —— 否则对端面板同样会错误归类。

标题读取按成本逐级降级：

| 级别 | 手段 | 成本 |
| --- | --- | --- |
| 1 | `sessionProjectionCache.cachedSnapshot(header, 0)` | 纯内存零 I/O |
| 2 | `sessionQuery.readTitleSnapshots(ids)` | 整份解码会话日志，**很贵** |
| 3 | 拿不到 → `title: null` | UI 显示 `(无标题)`，**绝不拿 id 冒充标题** |

级别 2 只对缓存未命中的、且数量不超过 `titleFoldBudget` 的才走，并受
`titleFoldBudgetMs` 时间预算约束。实测（本机 1745 会话）：缓存命中 1378 条、
零次日志折叠、40 条折叠后确认「日志里本来就没有标题事件」（子代理会话常见）、
327 条被预算挡下。`/status` 的 `inventory.degraded.titleSources` 把这四类分开计数 ——
把「没试」和「试了但没有」都算成 missing，会让人误以为折叠路径坏了。

**一次冷采集实测约 3.3 s**（1700+ 会话的 `listSessions` + 标题折叠的时间预算）。
所以 `/tree` 走「先返回旧快照、后台刷新」（stale-while-revalidate）：
只有第一次（还没有任何快照）才等，之后每次都是毫秒级（实测 3.1 s → 0.02 s）。
`inventoryTtlMs` 实际决定的是**后台刷新频率**。

---

## 3. 工作区多工作路径

出厂 `workspaceRegistry` 里一个工作区**恰好**绑定一个规范路径（`fs.realpath` 过的、
不可改写）。这个语义是侧边栏、会话归属、新建会话 cwd 的共同基础，**不能也不该**被插件改掉。

但「同一个项目在别的设备上还有一份工作目录」是真实需求。所以本插件**只记录额外路径**：

| | 含义 |
| --- | --- |
| **主路径（primary）** | 出厂权威路径。本插件只读派生、**结构上不可能改坏**，也不存在「主路径指向了别的设备」这种状态 |
| **附加路径（member）** | 人工挂上的 `(设备, 绝对路径)` 二元组，可落在任意已知设备上；角色分 `mirror`（另一份副本）/ `scratch`（临时目录） |

于是「默认在主工作区工作」不是一条需要遵守的约定，而是**没有别的可能**：
一切出厂路径只认主路径，附加路径只由显式动作进入（UI 里选目标、或模型工具
`mesh_exec` 指定）。

两种 group 的主路径来源不同（读代码时别混淆）：本机 group **实时**读
`workspaceRegistry`（永不过期；工作区被删掉时 group 变 orphan，保留并标注，
以免连带丢掉用户挂的附加路径）；其它设备的 group 用**快照**（标 `primaryStale`，
因为本机无从实时核验远端工作区）。

---

## 4. 跨设备执行

这是整个插件里权限最高的一段代码，受理侧刻意做成**失败关闭**，四道门全过才执行：

| # | 门 | 不过时 |
| --- | --- | --- |
| 1 | `allowRemoteExec`（缺省 **false**） | 403 `exec-disabled` |
| 2 | `execTrust`：节点 `trust === 'exec'`，或本机设为 `any-authenticated` | 403 `exec-denied` |
| 3 | **会话权限**（`read-only` / `workspace-write` / `danger-full-access`，随请求带来） | 403 `session-read-only` / `session-workspace-write` |
| 3′ | 请求**没带**权限（老 peer、`mesh_exec` 这类显式动作）→ 退回旧门：路径在有效导出根内（`exportRoots` ∪ 本机工作区路径） | 403 `path-not-exported` |
| 4 | 路径存在且是目录（**判定顺序：先权限、再存在**） | 404 `path-missing`（「不存在」） |

见 §4.1「权限边界」：**会话自己的权限预设才是权威**，属主的导出根只对不带权限的请求生效。

- **令牌只回答「你是谁」，不等于「你可以在这台机器上跑命令」。**
  执行权必须在「设备」页单独授予（缺省新接入的设备只有 `inventory` = 看清单）。
- 第 3′ 道门的路径判定用 realpath 后的 `path.relative`，不是朴素字符串前缀：
  `/srv/app2` 不算 `/srv/app` 之内，`/srv/link → /` 这种符号链接绕过也会被挡住。
  自测里有这两条对应用例；`workspace-write` 的写范围判定同样是分段比较（`/a/b` 不匹配 `/a/bc`）。
- 命令以**本进程的身份**（同一用户、同一份环境变量）在目标目录下运行 ——
  与本地 bash 工具调用完全同级。本插件不提供降权：要更强的隔离，应当把这个 DSH
  本身跑在受限用户/容器里，而不是指望插件替它做沙箱。
- **输出超限后继续读并丢弃**，而不是停止读取 —— 停止读取会让子进程的管道写满而
  永久阻塞，那就从「输出被截断」变成「命令挂死」了。
- 超时先 SIGTERM，2 秒后 SIGKILL：一个忽略 SIGTERM 的子进程不该把这次执行钉住。

### 只走一跳（硬边界）

目标设备必须是**本机自己**，或本机**直连的接入点**（本机 join 过它、有链接）。
「接入点的接入点」在本机只是镜像里的一行数据：能看到它的会话，但**不能**在它上面执行
—— 中继会让「谁真正执行了这条命令」变得含糊。拒绝时给的是可行动的说明
（去加一条指向它的接入点），不是一个空错误。

### 审计

**每一次尝试都写审计，包括被四道门拒绝的** —— 失败审计比成功审计更有价值。
追加式 JSONL：`$DSH_HOME/device-mesh/exec-audit.jsonl`（0600，超 8 MB 轮转一份 `.1`）。
两侧各留一条：受理侧 `direction: 'in'`，发起侧 `direction: 'out'`，
**沿用同一个 `auditId`**，于是两端日志可以按 id 对上（「我发的这条，对端记的那条，是同一次」）。
`direction` 描述命令往哪走，`actor` 描述谁按的按钮（`tool` / `browser` / `remote` / `service`）。

审计写失败**绝不**让执行失败：审计坏了就让功能停摆的话，运维第一反应会是关掉审计，
那才是真的失去追责能力。写失败只记 `lastError` 并由 `/status` 报告。

## 4.1 互联会话与纯本地会话的完全分离（工作区 `mesh` 开关）

**问题**：路由原本**只按路径**判定，而「谁都匹配不上」的路径回落到**本机执行**（对纯本地
部署是安全缺省）。但互联会话的 agent 在会话端、文件在属主那台 —— 回落到本机就是**静默
读到会话端自己的文件系统**。实测报过这条：会话端（xray4668）的互联会话读工作区之外的
路径（如 `/etc/hosts`），读到的是会话端本机的文件，看起来却像「成功读到了项目的文件」。

**修法**：给工作区加一个显式开关 —— `workspaceRoles[path].mesh`（**是否作为互联会话**）。
判定时先用**会话的 cwd** 归属到工作区（出厂 `dsh-tool-fs` 传的 `cwd` 就是
`exec.agent.session.header.cwd`；目标路径不参与反推，否则会自证循环），再按开关分流：

| 会话所属工作区 | 目标路径 | 判定 |
| --- | --- | --- |
| `mesh: true`（互联会话） | 工作区内 | 发到属主设备（命中归属，同旧行为） |
| `mesh: true` | 工作区之外（`/etc`、`/tmp`、别的工作区…） | **仍然发到属主设备**，并按**会话权限**落地（§4.1 权限边界）。**绝不回落本机** |
| `mesh: true`，属主解析不出来 | 任意 | **拒绝执行**（denied）并说明原因。绝不回落本机 |
| `mesh: true`，本机就是属主 | 任意 | 本机执行（文件与命令本来就在这台，这是对的） |
| 未声明 / `mesh: false`（纯本地） | 任意 | **一律本机**，即使命中远端主路径也不转发 |
| 任一模式 | 命中**显式附加路径（member）** | 发到那条附加路径所属设备（人钉的意图比开关更具体） |
| cwd 不在**任何**工作区（账目里也没有） | 任意 | 沿用旧的按路径判定（老部署行为不变） |

策略表由「配置声明」与「路径账目」合成：**账目里出现过的每个工作区都会进表**，未声明的按
纯本地记。否则「未声明 = 纯本地」这条缺省落不了地 —— cwd 归属不到条目就会掉回旧的按路径
判定，反向保证形同虚设。

要点与边界：

- **缺省是纯本地**：互联会带来跨设备副作用，必须显式声明。反过来（缺省互联）会让没配过的
  部署在升级后突然把命令发到别的机器上。
- 一个开关同时管**路由**与**界面标识**（§12.7）：界面标了「远端执行」，命令就一定发到属主。
- 判定是纯函数（`routing.js` 的 `routePathWithPolicy`），可单测；`routePath`（旧接口）逐字
  不变，`mesh_exec` 这类**显式**动作仍按路径路由 —— 那是人主动指定设备，不受开关约束。
- 排查：`POST /dsh-device-mesh/route` 支持可选的 `cwd`，能直接回答「这条路径 + 这个会话会在
  哪台落地、凭什么」；不传 `cwd` 时无法归属会话，只能看旧的按路径判定。
- **残留缺口**：shell 的 `workdir` 是唯一的会话线索，而模型可以显式传一个工作区之外的绝对
  `workdir`（如 `/tmp`）—— 那种请求归属不到会话，仍按旧的按路径判定（可能在本机跑）。
  要彻底堵住得让出厂 shell 请求带上会话身份（协议改动），本期没做。

### 权限边界：**会话的权限 = 属主上实际执行的权限**（2026-10-17 起）

**互联会话的权限由会话自己的权限预设决定**（`read-only` / `workspace-write` /
`danger-full-access`），转发时随请求带给属主（字段 `sessionMode` + `workspaceRoot`），
属主**照它执行** —— 不再看属主的导出根。

| 会话权限 | 读 | 写 | 命令（exec）的 cwd |
| --- | --- | --- | --- |
| `read-only` | 放行 | 403 `session-read-only` | 按「写」算 → 403 |
| `workspace-write` | 放行 | 仅 `workspaceRoot`（= 会话的工作区路径）之下，**分段判边界** | 必须在根内 |
| `danger-full-access` | 放行 | 放行 | 放行（任意 cwd） |

- **不带权限的请求**（老 peer、`mesh_exec` / 面板浏览器 exec/browse 这类拿不到会话 cwd 的
  显式动作）→ 退回**旧的导出根门**。这是刻意的向后兼容，不是遗漏。
- 「谁能连」照旧：令牌 + 每请求签名 + join + `allowRemoteExec` + `execTrust` —— 那是**授权**，
  与**权限范围**是两件事。
- **路径不存在就回答「不存在」**（404 `path-missing` / `info.exists !== true`），不再报一句
  误导性的「不在导出范围内」；判定顺序是**先权限、再存在**。
- 属主本机沙箱**跟随请求权限**（写类操作按请求的 mode/root 构造一次性策略）。
  2026-10-17 实机验证：`danger-full-access` 写属主 `/tmp` 返回 200。
- **命令内部写哪里，网格层管不了**（一条命令能写到它够得着的任何地方）。要更强的隔离，
  把属主的 DSH 跑在受限用户/容器里 —— 与本插件「不做降权」的既有边界一致。
- 要收紧到「一条会话只能碰自己的工作区」：把那条会话的权限设成 `workspace-write`；
  要完全关掉跨设备执行：`allowRemoteExec: false`（看清单不受影响）。

---

## 5. 认证模型

对称密钥 + **请求级 HMAC 签名** + 时间窗 + nonce 防重放：

```
canonical = method \n path \n timestamp \n nonce \n sha256hex(body)
signature = base64url(HMAC-SHA256(secret, canonical))
```

- 为什么不是明文 Bearer：明文 token 一旦落到沿途日志/代理里就能**无限重放**；
  签名让每个请求都不同，截获单个请求不足以冒充节点。
- 签名覆盖 `path` 与 `body`：不同路由之间不能互相搬运签名，改一个字节就失效。
- 入站 API **不接受 query string**（400）—— 否则「签名覆盖了什么」会出现两种读法。
- 认证失败按来源限流（`authFailMax` / `authFailWindowMs`），防暴力猜令牌。
- 已保存的 secret **永不回浏览器**：`/tokens` 与 `/links` 的列表接口全部脱敏，
  创建令牌的那一次响应是唯一一次明文。

`hello` 是唯一无需认证的路由，返回的公开设备描述刻意不含 `hostname` / 内存 / CPU
—— 那些是「认证之后才该知道」的资产信息。`allowInbound: false` 时**连 hello 也拒绝**：
一台关闭接入的设备不该继续向整个网段宣告自己。

---

## 6. 怎么把两台设备接起来

在两台设备上都装好本插件（profile patch 里加同一行）之后：

**在 A（作为接入点）**

1. 打开侧边栏「设备网格」→「令牌」→ 新建令牌，填一个标签（如「给B」），
   得到 `令牌 id` 和一个**只显示一次**的密钥。复制走。

**在 B（作为接入方）**

2. 「接入点」→ 填 A 的地址（`http://<A的IP>:3080`）、令牌 id、密钥 → 添加。
   - 如果 A 只监听回环，需要先用 `dsh-lanmode` 之类的桥把 A 暴露到局域网。
3. 点「测试」：先探 `hello`（地址通不通），再用令牌探一次 `join`（密钥对不对）。
   两种失败会分开报。
4. 点「同步」：B join A 并把清单推过去，同时把 A 的一跳总览拉回来。

**回到 A**

5. 「总览」里出现 B（`via.kind = inbound`），展开即可看到 B 的工作区与会话。
   「设备」页里可以给 B 改备注名、授予执行权或拉黑。

反向（A 也接 B）就对称地再做一遍，得到对等网格。

---

## 7. 模型工具

注册在 **host 的 `tools` 注册表**上（不是某个 agent 预设里），所以无论会话跑哪个预设都能用
—— 与同 profile 的 `image-unload` 行同一套路。用 `ctx.inject(['tools'], ...)` 等
`tools` 出现再注册，而不是 `export const inject = ['tools']`（后者会让整行在 `tools`
缺席时进入 waiting，把网格的其它功能一起拖住）。

### `mesh_exec`
参数：`command`（必填）、`path?`、`workspace?`、`device?`、`timeoutMs?`

目标解析顺序：
1. 给了 `path` → 先在附加路径账目里按「设备 + 路径」反查；再在各设备主路径里精确匹配；
   还没命中就看有没有给 `device`（按 `(device, path)` 走），没有就当本机路径
2. 只给 `workspace`（**id 或标题**）→ 用它**主路径**所在的设备与目录
3. 只给 `device` → 用该设备第一个有会话的工作区主路径

> 限定 `device` 时，第 1 步的每一小步都**只在该设备内**找。早期版本的主路径匹配扫了全部
> 设备，于是「(设备C, 恰好是B主路径的路径)」会被静默解释成「在 B 上执行」——
> 在一台用户没打算碰的机器上跑命令，而且看起来完全成功。自测里钉住了这一条。

### `mesh_workspace_paths`
参数：`action`（`list` / `add` / `remove`）、`workspaceId?`（id **或标题**）、
`deviceId?`、`path?`、`role?`、`label?`、`id?`

`list` 的输出**必须打出 workspaceId 与 deviceId**：人只看得见标题，
「看得见标题、猜不到 id」会让 `add` 变成猜谜 —— 实测确实因此把附加路径挂到了另一个工作区上。

---

## 8. 路由

完整契约（含每个响应的字段与错误码）见 **[CONTRACT.md](./CONTRACT.md)**。
两份路由的能力集刻意**不重叠**：

- **入站 API**（`/dsh-device-mesh/api/*`）：调用方是远端进程，本来就没有 Origin，
  所以**不走同源守卫**，它的门是签名 + 令牌 + 时间窗 + nonce + 限流。
- **浏览器侧**（`/dsh-device-mesh/*`）：同源守卫，不接受签名，
  也不提供任何「代替远端节点说话」的能力。

| 类别 | 路由 |
| --- | --- |
| 入站 | `GET hello`、`POST join`、`report`、`heartbeat`、`leave`、`tree`、`paths`、`fs/list`、`exec` |
| 浏览器 | `GET tree`、`status`、`audit`；`GET/POST config`、`links`、`tokens`、`nodes`、`paths`；`POST links/test`、`links/sync`、`exec`、`browse` |

---

## 9. 配置

写在 profile patch 的那一行 `config` 里，可运行期改的项在 UI「配置」页也能改。

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `deviceName` | `''` | 设备显示名；空 = 用 `identity.json` 里的名字（首次取 `os.hostname()`） |
| `workspaceRoles` | `{}` | 按工作区声明角色：`{ [路径]: { owner, session, mesh } }`。`owner` = 属主/执行侧（文件与命令真正跑在那台），`session` = 会话侧（在那台驱动会话），`mesh` = **是否作为互联会话**（缺省 `false` = 纯本地，一律本机落地）。语义与判定表见 §4.1；界面标识与路由共用 `mesh` 这一个开关 |
| `allowInbound` | `true` | 是否接受其它设备接入 |
| `requireToken` | `true` | 入站是否必须带令牌 + 签名 |
| `allowRemoteExec` | **`false`** | 跨设备执行总开关 |
| `execTrust` | `'grant-required'` | 谁可以执行：`grant-required` \| `any-authenticated` |
| `exportRoots` | `[]` | 额外导出的绝对路径 |
| `exportWorkspacePaths` | `true` | 自动把本机工作区路径加进导出根 |
| `execTimeoutMs` | `120000` | 单条命令最大时长（调用方只能要更短） |
| `execCommandLimit` | `32768` | 单条命令正文的字符上限 |
| `listLimit` | `500` | 目录列举的条目上限 |
| `requestSkewMs` | `300000` | 签名时间戳允许的偏差 |
| `replayCacheMax` | `8192` | nonce 防重放缓存容量 |
| `execOutputLimitBytes` | `262144` | stdout / stderr 各自上限 |
| `execMaxConcurrent` | `4` | 并发执行数上限 |
| `execAudit` | `true` | 审计是否落盘（关掉只留内存最近 200 条） |
| `inventoryTtlMs` | `5000`（本 profile 配 `20000`） | 清单快照 TTL；**实际决定后台刷新频率** |
| `pushIntervalMs` / `heartbeatMs` | `30000` / `20000` | 推送与心跳间隔 |
| `mirrorIntervalMs` | `60000` | 拉一跳总览的间隔 |
| `titleFoldBudget` / `titleFoldBudgetMs` | `40` / `2500` | 标题日志折叠的条数与时间预算 |
| `maxSessionsPerWorkspace` | `500` | 单工作区列出上限（超出截断并标注） |
| `maxDevices` | `64` | 接入设备数上限 |
| `includeSubagents` / `includeArchived` | `true` / `false` | 清单是否含子代理 / 已归档会话 |
| `nodeStaleMs` / `nodeOfflineMs` | `90000` / `600000` | 活跃度阈值 |
| `authFailMax` / `authFailWindowMs` | `40` / `60000` | 认证失败限流 |
| `storeDir` | `''` | 数据目录；空 = `$DSH_HOME/device-mesh` |

### 数据目录

```
$DSH_HOME/device-mesh/
  identity.json          设备身份（deviceId 稳定；改名不会换 id）
  tokens.json            入站令牌（**含明文 secret**，0600）
  links.json             出站接入点（**含明文 secret**，0600）
  nodes.json             已接入节点 + 它们上报的清单快照
  workspace-paths.json   工作区附加路径账目
  exec-audit.jsonl       执行审计（追加式，超 8 MB 轮转 .1）
```

全部 0600 / 目录 0700，原子写（同目录临时文件 + fsync + rename）。
读失败**不猜不删**：保留原文件、回落默认值、把原因写进 `/status` 的 `problems`。

> secret 为什么是明文：HMAC 是对称的，**验签方必须持有密钥本身**，只存哈希就退化成
> 「明文 token 比对」了（失去防重放）。要「接入点也不知道密钥」得换成非对称签名，
> 那是另一个协议版本。

---

## 10. 安全姿态，以及怎么收紧

本 profile 的 patch 里现在配的是：

```yaml
allowRemoteExec: true
execTrust: any-authenticated     # 任何持有有效令牌的节点都能在本机导出根内执行命令
exportRoots: []                  # 只导出本机工作区路径
exportWorkspacePaths: true
```

这对应「理论上通过认证可以随便接」：**令牌是唯一的门**。要收紧：

1. `execTrust: grant-required` —— 认证只给「看清单」，执行权逐台授予。
   然后到「设备」页给可信设备点「授予执行权」。
2. `allowRemoteExec: false` —— 完全关掉跨设备执行（网格的看清单功能不受影响）。
3. `exportWorkspacePaths: false` + 显式 `exportRoots` —— 只暴露指定目录，
   而不是全部工作区。
4. UI「配置」页里前两项可以运行期切换，状态变更会记 `warn` 级日志，
   让「谁在什么时候把执行打开了」有迹可循。

---

## 11. 维护

### 换版本（**必须整张 import 图一起换**）

loader 按 **specifier** 缓存模块，而 `?v=` 只是缓存键：

```
entry-vN.js → protocol.js?v=X
            → inventory-cache.js?v=X → inventory.js?v=X
            → caller.js?v=X → exec.js?v=X → protocol.js?v=X
```

只换入口那一层的标记**不够**，而且失败方式极其隐蔽：换了的模块确实重读了，
但它内部仍 `import './inventory.js?v=旧'`，于是真正改动的文件还是旧实例 ——
表现是「`/status` 的版本号变了、行为没变」。本项目实际踩过这个坑
（`inventory.js` 的标题折叠修正没生效），所以把它做成了脚本：

```sh
node bump-version.mjs      # 整张图统一换标记 + 生成新入口 + 更新 index.js
```

之后把 `cordis.patch.yml` 里那一行的 `name` 指到新入口（**保持同一行 id**，
loader 走 dispose→start 让整张图按新 URL 重新求值），删掉旧入口即可。

脚本会先做**一致性检查**：任何文件里的说明符标记与入口不一致就直接退出，
而不是把不一致扩散到新版本。它同时维护 `IMPORT_TAG`（`/status` 的版本自报值）——
那个字段曾经在换版时被漏掉，于是一个专门用来判断版本的字段长期报着旧版本号。

> 为什么不直接改文件让运行实例生效：改 `client.js` **是**可以热换的
> （`dsh-client-hmr` 每 500 ms stat-poll，改完刷新页面即见）；
> 但 host 半边的模块缓存没法在运行期失效，只能换版本或重启 dsh。

### 三种改动，三种生效方式

| 改了什么 | 怎么生效 |
| --- | --- |
| host 半边的任何 `.js`（含 lib） | `node bump-version.mjs` + 把 patch 行的 `name` 指到新入口，**再重启 dsh**（见下面那条实测） |
| `client.js` 的内容 | `dsh-client-hmr` 每 500 ms stat-poll 就地热换，**刷新页面即见**（boot 图的 URL 带 `&rev=<hash>`，刷新就会拿到新的） |
| `package.json` 的 `dsh.client` 元数据 | **必须重启 dsh**：client-modules 按 Loader specifier 缓存包元数据（含「不是客户端包」的否定结论）直到重启 |
| 已经在跑的插件的 config | 若 profile 真的挂了 host 半边热载插件才成立；本部署**没有**，所以也是重启（见下） |

> **2026-10-13 实测更正**：本 profile 的 `package.json` 写着 `dsh.profile.patchReload: live`，
> 但**改 patch 并不会热载** —— 把 device-mesh 行的 `name` 从 `entry-v26.js` 改成
> `entry-v27.js` 之后，等了 2 分钟 `/status` 的 `importTag` 仍是旧值、新路由 404，
> journal 里没有任何 patch 相关行。原因：`patchReload: live` 要由 host 半边的热载插件
> （`@deepseek-ai/dsh-hmr` / `dsh-config-editor`）来兑现，而**本 profile 的 patch 里没有
> 挂它们**（boot 图里只有浏览器半边的 `@deepseek-ai/dsh-client-hmr`，它只管前端 bundle）。
> 这台机器的历史部署也都是重启：`journalctl -u dsh-web.service` 里 05:48、09:26 两次
> `Stopping → Started`，第二次就在入口文件写盘后 2 秒。所以：**换入口 = 重启服务**
> （`systemctl restart dsh-web`，会带走这台机器上在跑的会话）。

**新加一个客户端包**（本插件第一次装上就是这种情况）除了 host 行挂载成功之外，
还需要**刷新浏览器页面** —— boot 图只在页面加载时注入。一个很隐蔽的症状是：
host 半边一切正常（`/status` 全绿、路由都通、`clientModules.inGraph = true`），
但侧边栏里就是没有那个按钮，浏览器控制台也什么都不报。所以 `/status` 里专门放了
`clientModules` 这一格，用来区分「没进图」和「进了图但页面没刷新」。

---

## 12. 自测

```sh
node selftest.mjs          # 117 项
```

纯 node、零第三方依赖、无外部副作用（顶部就把 `DSH_HOME` 指到临时目录并清理）。
设计原则是「**每条断言都必须会失败**」：

- **真跑 HTTP**：两个独立节点各自 `apply()` 到一个真的 `node:http` 服务器上，
  它们之间真的走 TCP、真的签名、真的验签。mock 掉传输的测试证明不了协议。
- 重放测试先断言**第一次真的 200**，否则「第二次 401」可能只是因为第一次就失败了
  —— 那种测试永远绿。
- 认证矩阵覆盖：缺头 / 未知令牌 / 撤销 / 过期 / 超窗 / **逐字重放** /
  换路径 / 换体 / 协议版本不匹配 / 带 query / 方法门 / join 时 deviceId 不一致 /
  未 join 就 report / 认证失败限流。
- 执行门逐条覆盖：`exec-disabled` / `exec-denied` / `path-not-exported`（含符号链接
  与「工作区路径 ≠ 自动可执行」）/ `path-missing` / `exec-busy` / 超时终止 /
  输出超限被截断且命令仍正常结束 / 非零退出码原样返回；
  以及「接入点的接入点可见但不可执行」和「granted 后即可执行、拉黑后立即拒绝」。
- 多路径账目：按标题挂载、同 `(设备,路径)` 重复被拒、相对路径被拒、
  「改主路径」这个动作**根本不存在**、附加路径出现在 `/tree` 的设备节点上、
  远端账目只读（POST `/api/paths` 无此路由）。
- 恶意输入清洗：未知键 / `__proto__` / 巨串 / `Infinity`-`NaN` / 10 万工作区 /
  10 万会话 / 非数组 / `null` 条目 → 白名单化、有界、标 `truncated`、不抛、
  原型未被污染、`nodes.json` 落盘后只含白名单字段。
- 清单降级：`sessionQuery` 抛错、服务缺失、`titleFoldBudget=0`、
  `includeSubagents=false`、截断标注。
- 存储层：原子写（0600、无临时残留）、坏文件回落且**不覆盖原文件**、
  身份幂等（配置改名不会换 id/名字）。
- 签名原语：规范串五段、字段含换行直接抛错、空体摘要、定长比较、
  时间戳字符集收紧。

---

## 12.5 远程工作区进主界面（侧边栏）

远程设备的工作区默认只在「设备网格」面板里可见。装了本插件并打了工厂补丁后
（见 [FACTORY-PATCH-NOTES.md](./FACTORY-PATCH-NOTES.md) §1），它们会**平铺**进
侧边栏那份**真正的会话选择区**——工作区行下面、`role="tree"` 的滚动会话列表内部，
排在出厂工作区分组之后，**跟着会话一起滚动**，而且行结构与出厂 Rows **逐条对齐**
（34/32px 行高、`0 8px` 内边距、8px 圆角、16×20 的 slot、悬停换箭头、标题 14/20、
时间 12/20）——图标直接内联出厂 artwork 的路径（folder open/close、triangle-right、
copy），所以远程工作区在侧边栏里看起来就是一条普通工作区。

**同一个工作区只在列表里出现一遍。** mesh 的 `workspaceId` 是跨设备共享的
（本机与 orangepi5 注册表里 DSHpluginWorkSpace 是同一条 id），所以「对端也报了这个
工作区」绝大多数情况不是「那台机器上另有一个工作区」，而是同一个工作区的另一份清单
快照。规则：

| 情况 | 侧边栏 |
| --- | --- |
| 对端工作区 id 本机也有，且本机那份清单**被截断**（`droppedSessions > 0`） | **不渲染**（两边都只报前 N 条，差异可能只是截断位置，猜不起） |
| 对端工作区 id 本机也有，两边清单**完全一致** | **不渲染**（纯重复） |
| 对端工作区 id 本机也有，本机清单完整且对端真有独有会话 | 一行：`标题 🌐 · 设备名 ＋N`，**行的标识用共享的 workspaceId**（默认 UI 里它归同一个工作区，不是第二个工作区） |
| 对端独有的工作区（本机没这个 id） | 照旧整行展示 |

区分只靠**两处标示**：

```
DSHpluginWorkSpace                         ← 本机执行
ArkTower
DSHpluginWorkSpace 🌐 · orangepi5 ＋1       ← 同一工作区，对端另有 1 条本机没有的会话
  ● 多设备插件修复与工作区迁移  ⇄orangepi5  ← 远端会话：行内设备标签
Stronghold 🌐 · orangepi5                   ← 对端独有的工作区（本机没这条 id）
```

- **本地执行 vs 转发执行**：工作区名称后紧跟一个**网络图标** = 这个工作区的命令与
  文件在**另一台设备**上执行（转发执行工作区）；没有图标 = 本机执行。图标与设备名
  都不参与标题截断，所以标题再长也看得见「在哪执行」。
- **`＋N` 徽标**只出现在「同一工作区、对端另有 N 条本机没有的会话」的行上；它不是
  第二个工作区，悬停有说明。
- **位置**：远程工作区渲染在 `section.sessions` 那个滚动会话列表**内部**（工作区行
  下面那块真的会话选择区），不是钉在列表下方的第二块区域；列表滚动时它们跟着走，
  与出厂分组之间保持同样的 4px 组间距。
- 设备名后缀跟在图标之后；设备**联不通**（`liveness !== 'online'`）时名称变为
  `标题 · 设备（未连接）` 并转警告色，展开后提示「下面是最后一次成功采集的清单快照」。
- 每条**远端会话**行带 `⇄设备名` 标签（小、可截断，落在标题与时间之间；
  悬停时不随「时间」一起隐藏），tooltip 说明日志与 agent 在对端。
- 点击远程会话复制 id（远端会话不能在本机打开，见 §13）—— 不做假的打开；
  悬停出现的复制按钮做同一件事。
- **只列「点得开」的会话**：与出厂侧边栏的可见性规则对齐 —— 子代理会话
  （`origin === 'subagent'`）挂在其父会话名下，用普通会话地址打开会被宿主机直接
  拒绝（`session/agent-busy: subagent Sessions require their durable parent
  address`），已归档会话也不在列表里。侧边栏里列出来却打不开，比不列更糟。
- 数据是 `GET /tree` 的清单快照，30 s 拉一次（与面板共用 inventoryTtlMs 的新鲜度）。
- 侧边栏收窄成 rail 时不渲染；没有可展示的行时整段不占位（去重后经常是空的）。
- `node client-sidebar-selftest.mjs` 用真实形状的 `/tree` 夹具钉住去重四条：
  截断跳过、完全一致跳过、独有会话出行且 key 用共享 id、aria-label 与 ＋N 文案。
- 工厂没打补丁时这段静默不出现（`ctx.slots.inject` 等不到槽位声明），不影响任何既有行为；
  `node verify-sidebar-section.mjs [--offline]`（工作区内）用真实 client + 真实 /tree
  数据钉住「无独立区域」「工作区名称带设备标识」「会话行结构与设备标签」
  「联不通时的名称标识」，以及工厂未打补丁时的降级路径；
  `node verify-session-area-placement.mjs [--factory <文件或服务中的 bundle>]` 钉住
  「槽位落在 `section.sessions` 列表内部、旧的列表下方渲染点已删除」。

## 12.6 会话历史镜像（会话端 → 执行端，执行端只存储）

工作树在执行端、会话（agent）在会话端时，两边各自都不完整：执行端只有文件、
没有「这些文件是怎么来的」。这一节把会话端每条会话的**完整事件历史**实时推到
执行端，执行端**只落盘存储**。

```
会话端（跑 agent）                       执行端（跑命令 / 文件在这）
ctx.on('session/event')  ──实时事件──▶   POST /dsh-device-mesh/api/session-mirror
  首次见到一条会话先做一次回填（读本地      → session-replica/<源设备>/<会话>.jsonl
  session.v4/v3.jsonl.zstd，逐帧解压）        + index.json（索引，0600）
```

**为什么落网格数据目录、而不是 DSH 自己的 `sessions/`**：写进去会让执行端把它们
当成**自己的会话**（出现在侧边栏、被 sessionQuery 统计、被 workspace 账目认领），
那是一种「看起来像会话、其实没有 agent、也没人维护」的假状态。要拿镜像做恢复/
导入是**显式动作**，不是副作用。

要点（都是踩过的坑，别改回去）：

| 点 | 为什么 |
| --- | --- |
| 日志是**独立 zstd 帧拼接容器**，不是一条流 | `zlib.zstdDecompressSync(整份)` 只解出**第一帧**（实测 2 MB 的日志只读出 1 行）。必须逐帧走帧头+块头（`scanZstdFrames`）。 |
| v4 与 v3 同时存在时**只读 v4** | v4 是迁移后的当前代、把整份历史都写进去了；两代都读会把 0..N 叠一遍（实测 354+399 行只对应 398 个唯一 seq）。 |
| 回填的第一批带 `reset: true`，且**必须发全量** | 接收端收到 reset 会清空重写；按游标只补尾巴会让镜像剩下 10 行（实测）。 |
| 接收端按 `seq <= lastSeq` **逐条去重** | 网络重试/回填与实时重叠都会重投；只按「批范围」去重挡不住跨批重叠。 |
| 单事件上限 4 MB、单批字节预算 8 MB | 实测有 280–466 KB 的 assistant 消息；256 KB 的上限会**静默丢历史**，而 256 条 × 4 MB 又会撑爆入站 body 上限。 |
| 只镜像**转发执行**的会话 | 目标设备由路径路由决定（`routePath`）：本机执行的会话没有第二个家。 |

界面：侧边栏「设备网格 → 路径与执行」页脚显示「推送 X 事件/Y 会话 · 收到 Z 会话」，
旁边有「回填已有历史」按钮（一次性把静置会话的历史也补齐 —— 默认只镜像之后还在
动的会话，几百条会话的全量回填是几百 MB 量级的流量，不该是默认动作）。
只读接口 `GET /dsh-device-mesh/mirror`。

## 12.7 执行端标识（远端会话驱动检测）

工作区的「属主/执行侧」（文件与命令真正跑在那台）与「会话侧」（agent 跑在那台）
可以不是同一台机器。§12.5 解决的是**会话端**的视角（远端工作区在侧边栏里带设备标
识）；这一节解决**执行端**的视角 —— 执行端必须能看出「这个工作区的会话正在远端执行，
它的命令会发到本机」。这是安全相关的事实，不是导航信息。

**为什么曾经是空的**：P1（多机会话列表权威）发现「远端某台报了同 id 的 localMatch」
这个判据对两台都成立，于是属主侧的工作区被误标成「转发执行工作区」。修法是把属主/
执行侧的标注整个 `return null` 掉了 —— 错误标注确实消失了，但执行端从此**一条标识
都没有**。方向要对，标识也不能没有。

### 判据（运行时证据优先，配置声明兜底）

| # | 来源 | 含义 | 强度 |
| --- | --- | --- | --- |
| 1 | 会话镜像索引 `session-replica/index.json` | 该工作区的会话历史被推到了本机 | 硬：只有**转发执行**的会话才会被镜像（§12.6） |
| 2 | 入站执行审计 `exec-audit.jsonl`（`direction=in`） | 远端**真的把命令发到本机**跑过 | 最强：不是「可能」，是「已经发生」。`inboundExec` 含非零退出/超时/取消（跑失败同样是既成事实），被四道门拒绝的另计 `inboundDenied` |
| 3 | 对端清单里的 `localMatch` | 对端报了同一个工作区（同 id 或同路径） | 说明对端也在用这个工作区，单独不足以定方向 |
| 4 | `config.workspaceRoles[path] = {owner, session, mesh}` | 人工声明的角色 | 声明，不随运行时变化；对端离线时仍然有效。**`mesh` 是标识与路由共用的开关**（见 §4.1）：没声明 mesh 的工作区是纯本地，不标 |

方向由「会话侧是不是本机」决定：会话侧 = 本机 → 本机在跑 agent（命令可能发到别处），
**不标**；会话侧 = 远端 → 会话在远端执行、命令会到属主侧，执行端要标的就是它。
**再与 `mesh` 取交集**：`remote = mesh && 会话侧不是本机`，所以「界面标了远端执行」
与「命令真的会发到属主」永远一致（§4.1）。

### 数据面

判定由 host 算（`drivers.js`），浏览器不重算 —— 镜像索引与执行审计都是**本机文件**，
浏览器拿不到。结果挂两处，**同源**（同一个函数、同一份输入，不会两个路由两个结论）：

- `GET /dsh-device-mesh/tree` → `tree.drivers`
- `GET /dsh-device-mesh/drivers` → 同一份判定（单独一条路由是为了用 curl 就能核对）

```jsonc
{ "schema": 1, "selfDeviceId": "…", "selfName": "orangepi5",
  "workspaces": [{
    "workspaceId": "db264e09-…", "path": "/root/DSHpluginWorkSpace", "title": "DSHpluginWorkSpace",
    "owner":   { "deviceId": "a0d8…", "name": "orangepi5", "isSelf": true,  "online": true, "source": "roles" },
    "session": { "deviceId": "bf7e…", "name": "xray4668", "isSelf": false, "online": true, "source": "roles" },
    "remote": true,          // ← 执行端要标的就是它：会话侧不是本机
    "active": true,          // 有运行时证据
    "evidence": { "mirrorSessions": 18, "mirrorLastAt": "2026-10-13T04:20:41.807Z",
                  "inboundExec": 214, "inboundDenied": 3, "inboundTotal": 217,
                  "inboundLastAt": "2026-10-13T10:45:11.980Z",
                  "inboundLastCommand": "tail -c +3870721 … /session.v4.jsonl.zstd | head -c 184320 | base64 -w0",
                  "inboundDevices": ["xray4668"] },
    "remoteDevices": [ { "deviceId": "bf7e…", "deviceName": "xray4668", "online": true, "sessions": 1193 } ]
  }],
  "sessions": [ { "sessionId": "session-db8fec3f-…", "deviceId": "bf7e…", "deviceName": "xray4668",
                  "workspaceId": "db264e09-…", "workspacePath": "/root/DSHpluginWorkSpace",
                  "title": "", "live": false, "lastActivityAt": 1791900000000,
                  "mirror": true, "mirrorEvents": 1960, "mirrorLastAt": "2026-10-13T04:20:41.807Z",
                  "inbound": 1, "inboundLastAt": "2026-10-13T10:45:11.980Z",
                  "presentLocally": true, "source": "exec" } ],
  "truncated": false }
```

- `sessions[]` **只放有运行时证据的会话**（镜像到的 / 命令原文里点到名的），不是对端
  清单的副本 —— 那份清单本来就在 `tree.devices[].inventory` 里，抄一遍只会让每轮
  轮询（15 s）的响应体积翻倍（单节点实测 1454 条会话）。
- 审计按**尾部有界读**（默认 256 KB，不整份读）：审计文件上限 8 MB，整份读会把
  「看一眼有没有人来发命令」变成持续的垃圾 IO。审计关掉（`execAudit: false`）时回落
  到内存里的最近 200 条。

### 界面

| 位置 | 标记 |
| --- | --- |
| 执行端的**本机工作区行** | `⇄`（琥珀色）+ tooltip「远端执行会话：agent 在 xray4668 上运行，命令与文件在本机执行」以及证据行（本机已收到 N 次执行请求 / 最近一条命令 / 已镜像 N 条历史） |
| 会话端的本机工作区行 | 不变（副本工作区标注，见 §12.5） |
| 侧边栏「远程工作区」段里**属主是本机**的那些行 | 从「转发执行：命令与文件在 X 上执行」（方向错）改为「远端会话：agent 在 X，命令与文件在本机执行」 |
| 每条**远端会话行** | `⇄设备名` 保留；tooltip 写清命令在本机执行；命中运行时证据的会话追加「本机已收到它发来的 N 次执行（最近 …）」并转警示色 |

`tree.drivers` 不存在时（对端还是旧版 host）客户端行为与改动前**完全一致**，不凭空画标记。

## 12.8 执行端的进度与接管

§12.6 的镜像原本**只落盘、不显示** —— 执行端因此是瞎子：会话在别处跑，本机什么也
看不到。这一节补上两件事，**都不动 §12.6 的边界**（镜像仍然不创建会话、不进会话列表）：

```
本机（执行端）                                    界面
session-replica/…jsonl ──▶ index.json 里的摘要 ──▶ GET /replica-progress
   每批落盘时记「最近一条有信息量的事件」              侧边栏远程会话行：● 进度 · seq · 时间
   + 会话头（对端随镜像送来）                         面板会话行：同一份数据

用户点「接管」 ──▶ POST /takeover ──▶ 本机 sessions/<slug>/<会话>/session.v<世代>.jsonl.zstd
   在线：从源设备按字节拉回（同 /session-pull）
   离线：本机镜像重压（buildSessionLogBytes）
```

**进度**（`GET /dsh-device-mesh/replica-progress`，只读）：每条镜像会话给
`{ summary, lastEventType, lastSeq, updatedAt, live, remoteLive, canTakeover, … }`。

| 点 | 为什么 |
| --- | --- |
| 摘要在**接收端每批落盘时**算，不是发送端送 | 摘要是给人看的，要基于这一批**真的落盘**的内容 |
| 只有 `SUMMARY_TYPES`（turn/tool/user/assistant/command/title）会**更新**摘要 | `step/start|end` 这类高频事件会把摘要刷成「步骤结束」，看不出在干什么 |
| `live`（镜像最近还在收到事件）与 `remoteLive`（对端清单说 agent 在跑）**分开** | 「数据新鲜」不等于「有人在干活」；会话等用户输入时前者会转 false |
| 单独一条路由，不塞进 `/tree` | `/tree` 是 700 KB 量级（含对端整份清单），进度每 15 s 刷一次，塞进去等于每轮重传清单 |

**接管**（`POST /dsh-device-mesh/takeover`，显式动作）：把一条在别处执行的会话变成
**本机的**会话 —— 之后它出现在本机会话列表里、可打开、可续跑，命令也在本机执行
（本机是属主）。两条路径落到同一处：

| 路径 | 通道 | 何时 |
| --- | --- | --- |
| 在线 | 复用 `/session-pull`（按字节拉对端日志，世代由对端日志决定） | 源设备可达 |
| 离线 | `buildSessionLogBytes`：镜像事件重压成「头行 + 每行一个独立 zstd 帧」 | 源设备不可达 |

离线路径必须有：最需要接管的时刻恰恰是源设备关机/掉线的时候（那台不在了，会话却要接着跑）。

落地时几个**不能想当然**的点（每一条都对应一次实测或出厂源码事实）：

| 点 | 为什么 |
| --- | --- |
| 头行只写**出厂允许的键**（`type/version/id/createdAt/isSeeded/delegationDepth/cwd/parentSession/origin/agentPreset`） | 出厂 `isHeaderLine` 要求键集**恰好**落在允许集内：多一个（会话对象上常见的 `title`）就判成「第一行不是会话头」，整条会话打不开 |
| 文件名世代 = 头行 `version`，且两者必须一致 | 出厂按文件名选世代（`session.v<N>.jsonl[.zstd]`），按头行版本解析内容 |
| 落地后把**更高世代**的旧日志挪走 | 出厂选「目录里数值最高的世代」—— 本机那份旧 v4 会把刚落地的 v3 整个盖住（拉取看起来成功、打开还是旧历史） |
| 事件带上 `surfaceOp` / `sourceEventSeqs` | 它们是出厂日志行的顶层字段（`replace` 语义、分叉继承前缀）；裁掉就与原件**不等价**（实测一份 5263 行日志里 2035 行带 surfaceOp、1020 行带 sourceEventSeqs） |
| 分叉（`isSeeded`）会话**照常落地**（`parentSession` 原样写回） | 曾经这里拒绝，理由是「种子头还要一个继承事件数」—— 那是把**写**路径（`toHeaderLine` 要 cut 参数）当成了**读**路径的约束。实测（设备上拿真分叉会话的镜像喂出厂恢复器）带 `isSeeded: true` 的头出厂照收，那个数不在物理头里 |
| 覆盖前先备份到 `<meshDir>/session-takeover-backups/` | 会话目录只留出厂认识的文件；备份在网格数据目录下 |
| 活会话（本机 agent 在跑）一律拒绝 | 覆盖活会话的日志会直接弄坏它 |

**界面**：侧边栏「远程工作区」里那条远端会话行在有进度时变成两行（标题 + 进度），
悬停显示「接管」按钮；本机已有旧历史时按钮文案是「更新并接管」，点击需**二次确认**。
没有镜像数据时（旧版 host / 这条会话从不「动」）一个字的接管都不出现，行高也维持出厂的 32px。
接管审计落在 `<meshDir>/session-takeover.jsonl`（追加，读侧只读尾部）。

验证（前两个只读脚本在工作区的 `.mesh-live/verify/`，`node_modules` 联接指向提取出来的
出厂运行时，所以能真的调用 `createRestore`）：

| 脚本 | 钉住什么 |
| --- | --- |
| `verify-materialize.mjs` | 拿本机一份真实 v4 日志当素材走「镜像接收 → 落地重压 → **出厂恢复器逐行读**」，并逐条比对与素材一致（跳过出厂恢复器的检查都不算数） |
| `verify-takeover-offline.mjs` | 在**设备上**用真实镜像文件走「旧索引无头 → 合成头 + 按事件形状推断世代 → 出厂恢复器读」（实测 18 份镜像：15 份通过、3 份纯对话无版本标记按设计拒绝） |
| `mirror-selftest.mjs` | 摘要取值、世代推断、落地字节的头行/帧形状、两代命名查找 |
| `client-sidebar-selftest.mjs` | 进度行内容与配色、两段式接管按钮（含覆盖确认）、两代 id 匹配、**没有进度时逐字不改** |

## 12.9 会话数据同步（每次运行结束后把上下文留在执行端）

需求：**每次会话完成一次运行后**，执行端要有控制端（会话侧）的上下文**留在本地** ——
不是「能看见进度」而已，而是这份历史在本机就是一份完整的、可打开的会话：本机离线时它
还在，要接手时不用再等对端。§12.6 的镜像只落网格数据目录（那条边界不动），同步是在镜像
**之上**多走一步：把镜像重压成出厂可读的日志，写进本机 `sessions/`。

```
会话端（3）                        执行端（19）
turn/end ──镜像批──▶ 索引记 syncWanted
                      └─▶ 同步工人（去抖 5 s / 每会话最小间隔 30 s）
                            └─▶ buildSessionLogBytes(镜像) ──▶ sessions/<slug>/<会话>/session.v<世代>.jsonl.zstd
                                                              └─▶ 索引记 syncedAt/syncedSeq（追平镜像 = synced）
```

| 点 | 为什么 |
| --- | --- |
| 触发是 **`turn/end`**，不是「收到任何事件」 | 跑到一半同步过去只会得到半截历史，而它下一批就变 |
| 排的是**定时器**，不在入站请求里重压 | 几 MB 的 zstd 重压不该卡住对端的推送（入站请求是别人在等回执） |
| 两道节流：去抖 5 s + 每会话最小间隔 30 s，都是**推迟不丢弃** | 一分钟跑五轮不必把同一份日志重压五遍；但最后一轮的数据照样会落地，只是晚一点 |
| 覆盖**不备份** | 镜像本身就是那份备份（完整历史一直在 `session-replica/` 里）；每轮备份会让 SD 卡堆出几百 MB 重复内容。手动接管仍备份（那是用户显式动作） |
| 落地复用与接管**同一套**函数 | 世代命名、头行白名单、世代遮蔽清理只有一份实现，两条路径不会各自漂移 |

不去动的情况（都记进索引，`/replica-progress` 与 UI 看得到原因）：

| 跳过原因 | 为什么 |
| --- | --- |
| 本机正在跑这条会话（活 agent） | 覆盖活会话的日志会直接弄坏它 |
| 本机**已接管**过它（接管审计里有） | 那之后本机是这条会话的主人，对端的旧历史不该再往回盖 —— 否则「本机接管后又在对端跑一轮」会把本机的新历史悄悄冲掉 |
| 子代理会话（`origin === 'subagent'`） | 出厂要求用父会话地址打开，落成本机会话只会多出一个打不开的条目 |
| 重压不出来（缺头 / 世代判不出来） | 记 `syncError`，UI 显示「同步失败」并给出原因，而不是静默失败 |

观测：`GET /dsh-device-mesh/replica-progress` 每条会话带 `syncedAt / syncedSeq / syncedBytes /
syncedVersion / synced / syncSkipped / syncError`（`synced` = 本机那份已追平镜像的最后一条事件）；
`GET /dsh-device-mesh/status` 带 `sync: { enabled, scheduled, synced, skipped, failed, lastError }`；
侧边栏进度行在同步完成后显示「已留在本机」，落后时显示「本机副本落后」并把「接管」按钮给回来
（那时它同时是「拉回最新」）。配置：`sessionSync`（默认 true）、`sessionSyncDebounceMs`、
`sessionSyncMinIntervalMs`、`sessionSyncMaxBytes`（单会话自动同步上限，超过留给手动接管 ——
同步是全量重写，峰值内存约是镜像明文的 1.5～2 倍，无人值守的动作不该在小内存机器上顶住进程）。

验证：`node mirror-selftest.mjs` 钉住「只有新接受的 `turn/end` 才算一次运行结束」「synced 只在
追平镜像时为真」「跳过/失败不清掉上一次成功」；`node client-sidebar-selftest.mjs` 钉住
「已同步时收走接管按钮」「落后时给回按钮」。

## 13. 已知边界

- **跨设备执行只走一跳。** 「接入点的接入点」能看见、不能执行（原因见 §4）。
- **本插件不做降权。** 命令以 DSH 进程的身份运行，与本地 bash 工具同级。
- **远端会话不能在本机打开。** 日志、附件、agent 都在对端，所以 UI 点击只复制会话 id；
  要在这里继续得走**显式**的「接管」（§12.8），它会写本机的会话目录。
- **接管之后没有租约。** 本机接管了会话，源设备并不知道：它那边再续跑同一条会话就会
  出现两份历史（各写各的日志）。当前只做到「接管时源设备不在跑就允许」，以及在源设备
  不可达时用镜像兜底；真正的防分脑需要一个跨设备的会话租约（会话行为先送权威判定），
  那是独立的一块。离线接管还额外继承了**镜像可能落后于源设备最后几条事件**这一点
  （响应里如实回 `sourceUnreachable` 与 `lastSeq`）。
- **自动同步（§12.9）也是全量重写。** 每轮结束都把整份历史重压一遍写进本机，所以
  极长会话（几十 MB）+ 高频轮次会反复写盘；节流按「每会话最小间隔」压住频率，但没有
  增量追加（增量追加要求本机那份与镜像**同世代同布局**，而镜像只存事件行、不存出厂
  的分帧细节，得不偿失）。本机**已接管**的会话不再被自动覆盖，代价是它在源设备上的
  后续进展不会再自动同步到本机 —— 那是分叉，不是同步。
- **本机 group 的工作区被删掉后**，账目会变成 orphan（保留并标注）——
  保留是为了不连带丢掉用户挂的附加路径。
- **`unassigned` 的 cwd 兜底分组**在浏览器侧做（按 cwd 字符串），
  所以同一目录的不同拼法（尾斜杠、`..`）会分成两组。
- **清单是快照**，不是实时订阅：`inventoryTtlMs` 决定新鲜度；
  远端节点的活跃度由心跳决定，不是它的会话在不在跑。
- **`/api/tree` 的 `depth` 参数目前只接受 1**（协议里留着，但没有更深的一跳）。
- **`/tree` 是全量的**：它把每个工作区的会话（最多 `maxSessionsPerWorkspace` 条）
  一次发给浏览器，本机 4 工作区 / 1010 条会话实测约 360 KB。回环与局域网够用，
  但它是**每次轮询都全量**（15 s 一次 ≈ 24 KB/s）。要接几百台设备时应当改成
  按设备懒加载（面板展开某台设备才拉它的清单）；现在没做，是因为在单机/小规模下
  多一次往返反而更慢，而且会引入「展开时才出现的空窗态」。
- **远端节点的清单是快照**，本机不做增量 diff：对端每轮 `report` 推全量
  （仅在清单 revision 变化或超过 `pushIntervalMs` 时才真的发）。
- **目录里存在「纯空白文件名」时，`fs/read-dir` 会整体失败**（不是本插件的 bug，
  是出厂 `dsh-fs-local` 的限制，2026-10-10 实测）：`listDirectory` 逐个子项走
  `resolveLocalTarget(cwd, name)`，而它开头就 `if (path.trim().length === 0) throw`，
  于是名为 `"\t"` / 一串空格的文件或目录会让**整个目录列举**抛
  `FsError("file_path must be a non-empty string", "FS_NOT_FOUND")`；
  `listingIoError` 对已是 FsError 的错误做**原样透传**，所以不会被包装成
  `cannot list …`，看起来像是「路径根本没传」——排查时容易误判到参数管道上。
  同一个调用也是浏览器侧工作区文件浏览（`dsh-api-workspace-files`）走的路，
  所以该目录在本机 UI 里同样列不出来。空目录与正常目录不受影响（实测 101 项、
  6 项均正常）。绕过办法是把这类条目改名，而不是在本插件里加特例。
- **执行端标识的会话级归属是「尽力而为」**：入站执行审计里**没有 sessionId 字段**
  （`exec` 请求体本来就只有 `command/path/timeoutMs/jobId`），所以「这一条会话把命令
  发到过本机」只能从命令原文里捞 `session-<uuid>`（镜像/回填那类命令确实带 id，agent
  自己发的普通命令通常不带）。因此：**工作区级**的入站次数是精确的，**会话级**的次数
  只会少不会多。要做到精确归属，得给 `exec` 协议加一个可选的 `sessionId`（会话端在
  shell 桥里带上），那是协议改动，本期没做。
- **侧边栏「本机工作区行」上的标识需要工厂补丁**（`sidebar.workspaces.row.mark` 槽，
  见 FACTORY-PATCH-NOTES.md §9）。工厂没打这个补丁的节点上，执行端标识只在
  「远程工作区」段与会话行上出现（那两条不依赖工厂补丁）；不会报错，也不会半画。
- **远端会话仍然不能在本机打开**（§13 上一条）：标识只回答「它会不会把命令发到
  本机」，不把镜像变成可打开的本地会话 —— 那正是 §12.6 刻意避免的假状态。
