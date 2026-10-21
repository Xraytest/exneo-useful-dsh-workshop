# 工厂补丁说明（dsh-client-ui-workspace / @goodandready/dsh-lanmode）

本插件有两处**出厂代码补丁**（node_modules 内，非本插件文件）。都是最小增量，
未改动出厂任何既有行为；升级 DSH / 插件后会丢失，需要按本文件重打。

## 1. `dsh-client-ui-workspace/lib/client.js` —— 侧边栏「远程工作区」槽位

**为什么**：出厂 `sidebar.workspaces` 是 **single 槽**，且 `renderOutletContent`
对 single 槽只渲染 `entriesOfSlot(...)[0]`（优先级最低者）。插件无法往里加第二家
—— 注册会抛 `single slot already has a registration`，换优先级注册则是**顶掉**
出厂浏览器而不是并列。所以「远程工作区进主界面侧边栏」必须由工厂开一个槽。

**补丁内容**（两处，均在本机 0.1.5-rc.3 与 rpi 0.2.0-rc.2 两份文件上分别打过，
锚点不同、语义相同）：

1. `WorkspaceBrowser` 所属 entry 的 `children` 声明里增加：

   ```js
   "sidebar.workspaces.remote": { kind: "list", scope: "root" }
   ```

2. 把槽位渲染在**会话列表容器内部**（`section.sessions` 那份 `role="tree"` 的滚动
   列表）末尾 —— 也就是「工作区行下面那块真正的会话选择区」，而不是 `listArea`
   之后的位置。两个列表组件（分组树 `SessionTree`、平铺 `FlatList`）各一处：

   0.1.5-rc.3（本机，列表容器是裸 `div`）：

   ```js
   // SessionTree 的 children 数组末尾（...groups.map(...) 之后）
   renderSlot("sidebar.workspaces.remote", { wide: true })
   ```

   并把 `renderSlot` 通过形参/调用点传进 `SessionTree` 与 `FlatList`（0.2.0-rc.2
   的这两个组件本来就带 `renderSlot` 形参，无需改签名）。

   0.2.0-rc.2（rpi，列表容器是 `AnimatedRows`）：

   ```js
   children: [groups.length === 0 && jsx(EmptySessions, {...}), groupRows,
              renderSlot("sidebar.workspaces.remote", { wide: true })]
   ```

**为什么不能放在 `listArea` 之后**（踩过的坑）：`listArea` 只是外层列容器
（`overflow:visible; flex:1`），真正滚动的是它内部的 `.list`（`flex:1;
overflow-y:auto`）。槽位挂在 `listArea` 之后 = 被钉在滚动区**下方**，既不跟随
会话滚动，视觉上也是「第二块区域」——看起来不像会话选择区的一部分。放进
`.list` 的 `children` 里，远程工作区才和出厂工作区分组同处一份滚动列表。

**未打补丁时的行为**：槽不存在 → 本插件 client 的 `ctx.slots.inject(...)` 永远等不到
声明，静默不渲染，不报错（`verify-sidebar-section.mjs` 的 degradation 用例钉住）。

**备份**：
- 本机：`/tmp/workspace-client-local.bak`（另见插件目录 git 外的部署记录）
- rpi：`/home/xray4668/workspace-client-0.2.0.bak`；
  `client.js.bak-<日期时间>`（本次「进会话选择区」改动前的备份）

**验证**：
- `node verify-session-area-placement.mjs`（工作区内）—— 直接读工厂文件，断言：
  槽位调用点共 2 处、**每一处都落在 `t("section.sessions")` 那个列表的 `children`
  数组内部**（括号配对判定）、旧的 `listArea` 之后渲染点已删除、两个列表组件都拿到
  `renderSlot`。用 `--factory <路径>` 可校验对端文件或**服务中的 bundle**
  （从 `/plugins/events` 取 rev，再取 combo URL）。
- `node verify-sidebar-section.mjs`（`--offline` 可跑断连态）—— 用真实 client.js +
  真实 `/tree` 数据 + mock react/slots，断言：注册进 `sidebar.workspaces.remote`、
  远程设备名、工作区标题、网络标示紧跟工作区名称、会话行（含复制 id 的 tooltip）、
  `⇄设备` 会话标示、断连时的「（未连接）」升级。

## 2. `@goodandready/dsh-lanmode/lib/{bridge,bridge-ws,dsh-auth-cookie}.js` —— rpi 持续重连

**现象**：浏览器访问 rpi 的 DSH（`http://192.168.1.3:3088`）无限「重新连接」，
`/api/remote.mux` 的 WebSocket 升级恒 401。

**根因**：lanmode 把每个上游请求的 Host 改写成 loopback（`127.0.0.1:3080`），
而出厂 BrowserAuth 的 cookie 是**按 authority 绑定**的（cookie 名 = authority 的
哈希，payload.authority 必须等于请求 authority）。0.8.40 的 `prepareClientHeaders`
给浏览器发的 cookie 却按**浏览器的公网 authority**（`192.168.1.3:3088`）铸造；
HTTP 路径还靠 `mergeDshAuthCookie` 把 loopback pair 补进上游请求（且它保留
「第一个 dsh-auth cookie」，陈错的 LAN cookie 会顶掉 loopback pair），而 **WS 升级
路径干脆原样转发浏览器的 cookie** —— 核心只认 loopback authority，于是 401。
（本机 0.8.5 没有 `prepareClientHeaders`，浏览器只会有核心自己颁发的 loopback
cookie，所以本机 LAN 访问一直是好的。）

**补丁内容**：

- `dsh-auth-cookie.js`：新增 `replaceCoreAuthCookie(cookieHeader, pair)` ——
  丢掉所有异 authority 的 `dsh-auth-*` cookie，强制换上 loopback pair
  （非 dsh-auth cookie 如设备令牌原样保留）。
- `bridge.js`：
  - `prepareClientHeaders` 的查找与铸造都改用 bridge 的 `authority`（loopback），
    不再用 `req.headers.host`；
  - 上游请求的 cookie 合并从 `mergeDshAuthCookie` 换成 `replaceCoreAuthCookie`；
  - `handleUpgrade` 的 options 增加 `coreAuthCookie` getter（与 HTTP 路径同一份
    pair 来源）。
- `bridge-ws.js`：升级前对 `upgradeHeaders.cookie` 应用同一个替换。

**备份**：`/home/xray4668/lanmode-bak-20261011/`（bridge.js / bridge-ws.js /
dsh-auth-cookie.js 三个原件）。

**验证**：`GET /` 200 且 set-cookie 为 loopback 名；带该 cookie 的
`/api/remote.mux` 升级 → **101 Switching Protocols**；带陈错 LAN cookie 同样 101；
rpi DSH 稳态 CPU 从 ~104%（生命周期均值）降到 ~11%。

## 3. `dsh-agent-instructions/lib/index.js` —— 跨设备 cwd 的 project-root 向上探测（仅 rpi）

**现象**：rpi 上任何会话（cwd 为 `/root/...`，真实工作树在 orangepi5）续跑时，
`turn/start` 后立刻 `turn/end {kind:"error"}`：
`EACCES: permission denied, realpath '/root/.git'`。

**根因**：出厂的 `findProjectRoot` 从 cwd 逐级向上 realpath 找 `.git`
（`DEFAULT_PROJECT_ROOT_MARKERS`）。`/root/DSHpluginWorkSpace/.git` 经设备网格路由到
orangepi5（ENOENT → 正常跳过），再上一级的 `/root/.git` 落在任何已登记路径之外 →
本机 realpath → `/root` 对 `xray4668` 不可穿越 → EACCES；`existsAsMarker` 只把
`FS_NOT_FOUND` 当「不是标记」，其余错误**直接抛** → 整轮失败。

**补丁**：`findProjectRoot` 对每个标记的探测包 try/catch；探测**答不出来**时
（EACCES / 网格不可用 / …）就地在**当前层**停下，把最深的可读目录当 project root，
而不是让整轮失败。语义上等价于「看不见更上一层，就认为这里就是根」。

**备份**：`/home/xray4668/agent-instructions-index.js.bak`

**验证**：补丁后同一会话的 `turn/end` 不再是 error（`blocked` 只出现在**已归档**
会话上，那是出厂设计：归档会话的 pre-step 会被拒）。

## 4. rpi 部署侧修正：工作区路径必须在本机可 realpath

**现象**：`迁移过去的对话处于错误地未分组状态` —— rpi 的侧边栏里 DSHpluginWorkSpace
的会话全部落进「未归入工作区」。

**根因**（实测 `/tree` 之外还要看 `workspace/follow` 的 baseline）：
`dsh-workspace` 的 `indexHeader()` 用 **`node:fs/promises` 的 realpath + stat**
（不走设备网格的 `ctx.fs`）为每个会话计算「canonical cwd」，再由
`WorkspaceEntity.sessionIds` 过滤：

```js
get sessionIds() { return this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path) }
```

rpi 上 `/root` 是 `drwx------ root root`，`/root/DSHpluginWorkSpace` 也不存在 →
每个会话的 cwd realpath 失败 → `sessionPaths` 为空 → 账目被过滤成 0 条 →
侧边栏全部未分组。同一启动期里账目表还被写坏过一次（只剩 1 条），已按
orangepi5 的权威账目（10 条 − 同步后新建的 db8fec3f）恢复成 9 条。

**修正**（需要 root，rpi 上 `xray4668` 可用 docker）：

```sh
docker run --rm -v /:/host alpine sh -c '
  mkdir -p /host/root/DSHpluginWorkSpace /host/root/nas/ArkTower \
           /host/root/code/Stronghold-Protocol-NetworkUnion /host/root/code/rustdesk_server
  chmod 711 /host/root                      # 只给穿越权，不给列目录权
  chmod 755 /host/root/DSHpluginWorkSpace /host/root/nas /host/root/nas/ArkTower \
            /host/root/code /host/root/code/Stronghold-Protocol-NetworkUnion /host/root/code/rustdesk_server'
```

四个目录是**空壳**：真实内容经设备网格路由到 orangepi5（附加路径 `prefer: true`
保证同长并列时走 orangepi5），空壳只服务于出厂的 `node:fs` 检查（工作区账目、
新会话创建）。**不要把 `.git`、文件或数据放进这些空壳**。

**验证**：`workspace/follow` baseline 报 9 / 50 / 2 / 2；可见顶层会话 20 条中 19 条
归入工作区（唯一 1 条是 cwd=`/root/code` 的会话，本机同样如此）；重启后账目稳定。

## 5. rpi DSH 日志落盘（诊断用，保留）

`~/.config/systemd/user/dsh.service` 增加：

```ini
StandardOutput=append:/home/xray4668/dsh.log
StandardError=append:/home/xray4668/dsh.log
```

原来进程 stdout/stderr 是一个 socket，**读不到任何日志**（本会话排查时因此反复摸黑）。
备份：`/home/xray4668/dsh.service.bak-20261011`。日志只追加、无轮转；不需要时
删掉两行并 `systemctl --user daemon-reload` 即可。

## 6. rpi 会话加载核查（2026-10-11）

`rpi-session-tools.mjs loadcheck [--visible|--subagents|--all]` 按 GUI 的打开路径
逐条探：`session/follow` 的开局帧 + 用开局帧的 address/throughSeq 拉一次
`session/page`。

- 顶层会话（DSHpluginWorkSpace 10 条）全部 ok。
- **子代理会话**用普通会话地址打开必然失败：
  `session/agent-busy: subagent Sessions require their durable parent address`
  —— 出厂的 `validateAddress()` 规定 `origin === 'subagent'` 的会话只能用
  `{kind:'subagent', parentSessionId, childSessionId, mode}` 打开，且父会话日志里
  必须有对应的 `subagent/catalog` descriptor。这不是日志损坏；`loadcheck`
  对子代理改用父地址（mode `'unknown'`）即可打开。
- 因此侧边栏的远程工作区**不列**子代理会话与已归档会话（与出厂
  `sessionVisible()` 一致）：列出来却点不开比不列更糟。

## 7. `dsh-session-format-v3-to-v4/lib/index.js` —— 放行「完整消息表」形式的标题请求（仅 rpi）

**现象**：部分旧会话在 rpi 上**整条打不开**：
`failed to observe session "…": Session migration from v3 to v4 refuses the transformed
artifact: session/title-llm-request messages do not represent messageSeqs`。

**根因**：本 profile 的标题插件 `dsh-session-title-context` 把**完整请求消息表**记进
`session/title-llm-request`（它的 `logRequests` 就是为了「看清这次请求到底发了什么」），
而出厂标题插件写的是单条合成消息（role user / source.kind `dsh-session-title-llm` /
单块 text）。v4 的**读取**路径两种形状都收（本机正在跑的 v4 会话日志里就是完整形式，
加载正常），只有这条**迁移校验**要求合成形状 —— 结果凡是用过标题请求的旧会话在
0.2.0 上全打不开。全量体检（`session-log-repair.mjs`）：1754 个 v3 日志里 14 个受影响，
其中 13 个是这一条。

**补丁**：`titleSources()` 里把「messages 不止一条、但每条都是合法消息对象」当作
**合法遗留形状**放行（仍要求 messageSeqs 非空），其余形状照旧严格。

**备份**：`/home/xray4668/session-format-v3-to-v4.js.bak-20261011`

**注意**：这是出厂包（进程内缓存），改完**必须重启 dsh** 才生效。

## 8. 会话日志修复工具 `session-log-repair.mjs`（工作区里的维护脚本）

迁移器还有一条**更早**的拒绝：v3 的工具结果包装
（`content: [{type:"tool-result",…}]`）一旦嵌在 `session/title-llm-request` 的
messages 里，就会 `must not contain a released tool-result wrapper` —— 迁移器只对
`tool/result` 行做了解包，漏了这一处。全量体检里 14 个受影响文件中**有 1 个**是它
（`session-6396d7c9…`，ArkTower），而且它同时中了 §7 那条。

工具按迁移器自己的规则把这些消息就地解包（`role: "tool"` + `toolCallId` + 纯内容块），
**逐帧**重压（只重压内容变了的帧、带校验 —— 整份重压成一帧会把会话彻底弄坏，第一版
就是这么翻车的），原文件备份为 `*.pre-repair-*.bak`。

```sh
node session-log-repair.mjs              # 只读体检
node session-log-repair.mjs --fix        # 就地修复（先备份）
```

结果：该会话修复后**能正常加载**（`session/follow` 出开局帧）。

## 9. 侧边栏去重 + 网络标示（2026-10-11 续作，仅 orangepi5 已部署）

**要解决的问题**：工作区账目是**按设备克隆**的 —— 同一个工作区（同 id、同路径）在两台
机器上都有账目，于是侧边栏把同一份工作区、同一批会话各列一遍（用户原话：「依然是同
一个工作区有的产出两份」）。

**做法**（去重的判据必须在 host，客户端拿不到出厂 `workspaceRegistry`）：

1. **host：给远端清单打重合标记**（`entry-v20.js` 的 `annotateLocalOverlap`）
   读一次本机 `workspaceRegistry.list()`，按 `id` 与 `path` 两种口径判重合，随 `/tree`
   下发：工作区级 `localMatch:{workspaceId,title,path}`，会话级 `presentLocally:true`
   （本机账目里已有这个 session id）。远端 `scope=direct`（推给对端的镜像）不打标记。
2. **client：三分类渲染**
   - 无 `localMatch` → 真·远端独有工作区，照旧列（网络图标 + `· 设备名`）；
   - 有 `localMatch` 且会话本机全都有 → **一个字都不列**（侧边栏已有本机那一行）；
   - 有 `localMatch` 但有本机没有的会话 → 只列这些会话，行上带「本机没有的 N 条」。
   同时新增 `sidebar.workspaces.row.mark` 槽位：把网络标示标在**本机那一行**上
   （否则去重之后再也看不出哪个工作区是转发执行的）。
3. **工厂补丁（第 3 处，本机 0.1.5-rc.3 的
   `dsh-client-ui-workspace/lib/client.js`）**：声明
   `"sidebar.workspaces.row.mark": { kind: "list", scope: "root" }`，把 `renderSlot`
   穿进 `ProjectRowItem`，在 `.title` 里跟在工作区名之后渲染。
   备份 `/tmp/ws-local.bak-mark`。

**踩到的坑（已修）**：`sidebar.workspaces.row.mark` 的注册一开始写成
`register({ name, component })` —— 出厂 `SlotCore.register(options, component)` 的组件是
**第二个位置参数**（`dsh-client-ui-slots/lib/index.js:64`），`options.component` 根本
不会被读；而且 `kind:"list"` 的槽位**必须有 `options.id`**（同文件 `:83`），否则 register
直接抛。症状是「补丁打了、槽位声明了，网络标示却永远不出现」。正确写法见
`client.js` 里紧邻的两处 inject（`(options, component)` 两参 + `id`）。

**部署步骤（host 半边改完必须换版本号才生效）**：

```sh
cd /root/.dsh/profiles/web/plugins/dsh-device-mesh
node bump-version.mjs          # entry-v19.js → entry-v20.js，全图标记 mesh-19 → mesh-20
# 再把 cordis.patch.yml 里 device-mesh 行的 name 指到 ./plugins/dsh-device-mesh/entry-v20.js
# （**保持同一行 id**）。改完 loader 会自动按同 id 走 dispose→start，无需重启 dsh：
curl -s http://127.0.0.1:3080/dsh-device-mesh/status   # importTag 应变成 mesh-20
```

**验证**：

- `curl -s http://127.0.0.1:3080/dsh-device-mesh/tree`：远端工作区应带 `localMatch`，
  重合会话带 `presentLocally`。
- `node verify-sidebar-section.mjs`（工作区内，`--offline` 亦可）：18 项全绿，含 7 项
  新增去重断言（全量重合不重复列出 / 部分重合只列缺的会话 / 标题不重复 /
  row.mark 槽位注册 / 本机行拿到网络标示 / 无关工作区不加标示）。
- `node selftest.mjs`：134 项 PASS。

**未做**：rpi（0.2.0-rc.2）侧**还没同步这套改动** —— 它的 `entry-v20.js` 有
`session-pull`（拉回历史）但没有 `annotateLocalOverlap`，`client.js` 没有去重/标示，
工厂 `client.js` 只打了 `sidebar.workspaces.remote`、没有 `sidebar.workspaces.row.mark`。

## 10. 跨设备「会话状态」不一致（只诊断，未修）

现象（用户原话：「会话状态没有在设备之间正确同步」、「DSHpluginWorkSpace 甚至没同步」）：
**同一个 session id 在两台机器上是两份历史**。

以 `session-8ee27c35-3606-4679-b4ca-3704776940f2` 为例（`/root/DSHpluginWorkSpace`）：

| 位置 | 内容 |
| --- | --- |
| opi 本机会话目录 `sessions/--root-DSHpluginWorkSpace--/<id>/session.v3.jsonl.zstd` | 855 行，止于 `seq 853 session/end-seed`（**旧**） |
| opi 的 rpi 会话副本 `device-mesh/session-replica/bf7e92cf…/<id>.jsonl` | 1322 行，止于 `seq 1321 turn/end turn=9 TIMEOUT`（**就是 rpi 的新历史**） |
| rpi 原始 `session.v4.jsonl.zstd` | 1323 行，同样的 `seq 1321` 结尾（**权威**） |

结论：新历史**已经拉到 opi 了**（session-replica 里就是它），但 opi 的会话存储/侧边栏
读的是自己那份旧的 v3 日志 —— 副本是**只存储、不落地成会话**（`entry-v20.js` 里那处
注释：写进 `session-replica/`，不创建会话、不跑 agent、不进会话账目）。

`session-pull`（把对端历史拉回**本机会话**）只在 rpi 的 `entry-v20.js` 上实现
（`route:session-pull` → `UI.sessionPull` POST），opi 侧没有。

### 10.1 已按「opi 权威」执行重新派生（2026-10-11 23:03，仅 rpi）

用户在 2026-10-11 明确策略：**opi 的权威，rpi 上的是 opi 转换来的**；分叉时以 opi 为准
（明知 rpi 那份多出的续跑会被丢弃）。

**影响面**（脚本 `/tmp/sync-impact.py`，只比文件大小/世代，不读内容）：

| 分类 | 数量 | 含义 |
| --- | --- | --- |
| in-sync | 1179 | 两边同世代同大小 |
| **rpi-extra** | **13** | rpi 多出一个 v4（迁移/续跑出来的）—— 唯一的冲突面 |
| only-opi | 273 | rpi 整份没有（opi 当日新建的子代理会话等），rpi 经镜像仍可见 |
| only-rpi | 1 | rpi 自建，opi 不拥有，不动 |

**操作**（脚本 `/tmp/rederive-sessions.py`，缺省 dry-run，`--apply` 才动手；逐条先整目录备份）：

1. 把 opi 的 `session.v3.jsonl.zstd` 覆盖到 rpi（2 条大小不同的：`session-48bf355a` 从
   417 B 补成 4 249 352 B、`session-6e107355` 从 4 550 459 B 补成 6 332 099 B）；
2. 删掉 rpi 那个分叉的 `session.v4.jsonl.zstd`，让 rpi 下次观察时**按权威 v3 重新迁移**。

备份：`rpi:/home/xray4668/.dsh-session-authority-bak-20261011-230311/<sessionId>/`

**验证**：

- 重跑影响面脚本：`in-sync 1192 / rpi-has-v4 0`（当时的判定口径）。
- `node rpi-session-tools.mjs loadcheck`（在 opi 上驱动 rpi 的
  `POST /api/session/follow` + `session/page`）：10 条可见会话 **10 ok / 0 failed**。
- rpi 上已重新生成 v4：`session-8ee27c35` v3 1 033 098 → v4 678 100（旧的分叉 v4 1 127 695
  已移除）；`session-48bf355a` v4 2 697 608（此前 rpi 只有 417 B 的空桩）。

**⚠ 判定口径的坑（2026-10-12 修正）**：rpi 是 0.2.0，**观察到一条 v3 会话就会生成 v4**
（迁移），所以「rpi 上有 v4」本身**不是**分叉信号 —— 重启 / 打开会话都会造出 v4。
`sync-impact.py` 里那一桶因此从 `rpi-extra` 改名为 **`rpi-has-v4`**，并在输出里写明要再用
`check-v4-fidelity.py` 逐帧判。该脚本的判据是「rpi 的 v4 尾帧 seq == opi 权威 v3 尾帧 seq」：

- 9 条有 v4 的会话里 **4 条完全相等**（忠实迁移）；
- **4 条只多 1 帧**，那一帧是 `session/end-seed`（打开会话时补的观察标记，时间戳正是
  我做 loadcheck 的时刻），前一条真实帧与 opi **逐字节相同** —— 也是忠实迁移；
- 1 条（`session-c0c74ddc`）opi 侧没有 v3，是 rpi 自建会话，不归权威管。

结论：**没有真分叉**；权威策略生效后 rpi 的 v4 都是 opi v3 的忠实迁移。


## 11. orangepi5 升级到 0.2.0-rc.2（2026-10-12）

**目标**：opi 从 0.1.5-rc.3 升到与 rpi/本机一致的 0.2.0-rc.2（npm `latest`），
让两台在网格里跑同一套插件与同一版前端。

**备份（可离线完整回滚）**：`/root/.dsh-upgrade-backups-20261012-054707/`
`dsh-install-0.1.5-rc.3.tgz`(56MB) / `dsh-profile-web.tgz`（含插件、patch、package.json、
profile node_modules）/ `dsh-home-config.tgz` / `device-mesh-state.tgz`（身份与令牌）/
`systemd-dsh-web.tgz` / `BEFORE.txt`（版本、插件清单、工厂文件 md5 基线）。
回滚脚本：`/root/opi-rollback.sh <备份目录>`（解 tarball + 起服务）。

**顺序**（服务全程停着，最后才起）：

1. `node session-log-repair.mjs --fix`：2026 个会话文件体检出 `affectedFiles:13 /
   titleShape:14 / unreadable:0`，实际**只需修 1 个**（v3 里嵌 tool-result 包装的那个），
   另 14 个属于「完整消息表标题」形状 —— 那由 §7 的出厂补丁放行，不是这套工具修的。
2. `npm install -g @deepseek-ai/dsh@0.2.0-rc.2`（node22 的 npm；304MB → 换掉全局安装）。
3. profile 外部依赖跟着升：`@goodandready/dsh-lanmode ^0.8.5 → ^0.8.40`、
   `dsh-free-search ^0.4.39 → ^0.8.4`，再 `dsh plugin --profile web install`。
   **这一步不是可选项**：0.2.0 会按 peerDependencies 拒收旧版插件并「skipping profile
   bundle」，lanmode 被跳过 = 3088 局域网入口整个消失（本流程在旁路前缀里实测到过这条告警）。
4. 出厂补丁 3 处（都在新装的包里）：
   - `@goodandready/dsh-lanmode/lib/{bridge,bridge-ws,dsh-auth-cookie}.js` —— §2 的 cookie
     authority 修正。**先 md5 校验新装原件与 rpi 记录的 `orig/` 一致**（三个都一致），
     再覆盖 rpi 的 patched 版 —— 等价于重打同一条补丁，而不是「拷一个不知道对不对的文件」。
   - `dsh-client-ui-workspace/lib/client.js` —— `sidebar.workspaces.remote` +
     `sidebar.workspaces.row.mark` 两个槽位（与 rpi 的 patched 版逐字节相同；原件 md5 也一致）。
   - `dsh-session-format-v3-to-v4/lib/index.js` —— §7 放行完整消息表标题形状（opi 的
     titleShape 有 14 个，这条必须打）。
5. 插件差异文件（两台的插件目录 452 个文件本来就逐字节相同，只差这几处）：
   `dsh-device-mesh/{entry-v21.js,client.js,protocol.js,README.md,client-sidebar-selftest.mjs}`、
   `dsh-settings-nav/{entry-v2.js,index.js,README.md}`（opi 向 rpi 拉）。
6. patch 行（**同一行 id**）：`entry-v20.js → entry-v21.js`、`settings-nav/entry-v1.js → entry-v2.js`。
7. `dsh --profile web --dump-config` 先组装校验（1462 行、device-mesh 在内、无报错）再起服务。

**验证（2026-10-12）**

| 项 | 结果 |
| --- | --- |
| `/dsh-device-mesh/status` | `ok=true importTag=mesh-20 device=orangepi5` |
| 局域网入口 | `GET :3088/ → 303`；发下的 cookie 名与 loopback(3080) **同名**（`dsh-auth-VPhEEcLK…`） |
| WebSocket `/api/remote.mux` | 正常 cookie → **101**；**陈错 authority 的 LAN cookie → 也是 101**（§2 那个 bug 不在） |
| 网格 | 两个方向都 `state=joined`；另一台 `/tree` 里 opi `liveness=online` 且远端工作区带 `localMatch` |
| 会话可加载 | `session/follow`+`session/page` 走 GUI 路径：**11/11 ok**（含 `session-48bf355a`） |
| 侧边栏 harness / 插件自测 | **18/18**（0 FAIL）/ **selftest 134 PASS** |
| 启动日志 | 无 `skipping profile bundle` / 无兼容性告警（只剩 MODULE_TYPELESS 与 SQLite experimental 两条既有警告） |

**已知未变**：opi 的 `agent-instructions` 没打 rpi 那条 `findProjectRoot` 补丁 ——
rpi 需要它是因为它的 cwd 是 `/root/...` 而本机没有 `/root`；opi 自己就是 root，不适用。

## 12. 互联插件工作区样式收尾（2026-10-12，两台同改）

**怎么「看」到页面的**（这次新加的验证手段，值得留着）：
`firefox --headless --no-remote --profile <dir> --window-size=1600,1100 --screenshot out.png URL`。
一次性截图会在**顶层文档 load 事件**时抓，这时 SPA 还没连上 WS、侧边栏是空的。所以加一个
「会等」的顶层页面：本地小 HTTP 服务（`shot-server.py`）返回一个把 GUI 放进 `<iframe>` 的
HTML，并挂一个故意拖 20 秒的 `<img>` —— load 被推后 20 秒，期间 iframe 里的 GUI 已经渲染完。
opi 上自带 firefox-esr，所以不需要装任何东西。

**截图看到并已修的问题**（都是「展开某个远端 extras 行」才暴露的）：

1. 提示语在 ~270px 侧边栏里折成 3 行（左缩进 40px 只剩 ~210px）。
   → 文案缩短为「本机没有的会话；日志与 agent 在 <设备>，点击复制 id。」，
   左缩进改成跟会话行同一条公式 `calc(8px + var(--dsh-workspace-indent,0px) + 16px)`。
2. extras 行展开后还跟着「另有 688 条未列出（超过单设备上限）」—— 那是**远端工作区整份
   清单**被截断的提示，和「本机没有的那几条会话」是两件事，放在一起会让人读错。
   → 该提示只在 `sameAsLocal !== true`（整行远端工作区）时出现。
3. 远端会话行的缩进比出厂会话行浅：出厂 `.projectRow/.sessionRow` 用
   `padding-inline-start: calc(8px + var(--dsh-workspace-indent,0px))`，远端行只写死 `padding: 0 8px`。
   → `.dmesh-rw-row` 改用同一条公式，并在 `.dmesh-rw-sessions` 上给出厂那一档
   `--dsh-workspace-indent: 12px`（现在是「项目行的图标」与「会话行的圆点」对齐）。

**一次误判（记下来免得再犯）**：我先把 `.dmesh-rw-dev` 改成可收缩（`flex: 0 1 auto`），
想让标题少截一点 —— 截图显示结果是 `DSHpluginW… ⇄ · xray…  ＋1`：标题本来就截不全，
再把设备名也截掉，这一行的可辨识信息就归零了。一行里四样东西（标题/网络标/设备名/计数）
在窄侧边栏里必然有一样要截，优先级应是**计数 > 设备名 > 标题**（标题在上一行已经完整写了）。
已回退，设备名恢复 `flex:none`。

**验证**：harness **18/18**、selftest **134 PASS**、两台 `client.js` md5 一致
（`b6f9aee41068bbeba0f9e81d1588f767`）；折叠态截图与改动前**逐像素相同**（改动只在展开态可见）。

**没修的（如实说）**：远端会话行常常显示 `(session-…)` 而不是标题 —— 那是 inventory 的
标题折叠有 `titleFoldBudget` 预算，超出预算的会话 `title: null`，UI 按设计**不拿 id 冒充标题**。
要让它好看得改预算或换标题来源，属于功能取舍，这次没动。

**顺带说明**：rpi 的 `client.js` **本来就有**一份更早的、客户端判据的去重
（用本机清单 `droppedSessions`/`localById` 自行判重合，见文件里「── 去重：同一个工作区
不许在列表里出现两遍 ──」那段）。所以 rpi 侧不是「没有去重」，而是「判据在客户端」；
opi 这套把判据挪到 host(`localMatch`) 并加了本机行的网络标示。要不要把 rpi 升级成
host 判据的版本，是独立的取舍。

### 10.2 rpi 侧也升到 host 判据（2026-10-12，三个文件）

用户选择「两个都做」后，把 opi 那套搬到 rpi：

| 文件 | 改动 | 备份 |
| --- | --- | --- |
| `profiles/web/plugins/dsh-device-mesh/entry-v21.js` | = `entry-v20.js` + `annotateLocalOverlap`（含文档注释）+ `buildTree` 里的调用。**没换 `?v=mesh-N` 标记**：只改入口、lib 一字节没动，新入口路径本身就够让 loader 重新求值 | `/home/xray4668/.dsh-backups-20261012-071003/` |
| `profiles/web/plugins/dsh-device-mesh/client.js` | 搬入 `/tree` 共享存储 + `useMeshTree` + `WorkspaceNetworkMark` + `row.mark` 注册（正确签名）；去重改为 **host 的 `localMatch`/`presentLocally` 优先**，缺省退回原有客户端判据 | `client.js.bak-hostdedup-20261012-120814` |
| `dsh-client-ui-workspace/lib/client.js` | 工厂第 3 处补丁：`ProjectRowItem` 加 `renderSlot` 形参、`.title` 里跟在工作区名后渲染、调用点穿参、children 表声明 `sidebar.workspaces.row.mark`（kind:list, scope:root） | `~/workspace-client-rowmark-bak-20261012-120921.js` |
| `profiles/web/cordis.patch.yml` | device-mesh 行 `name` → `entry-v21.js`（同一行 id） | `.dsh-backups-20261012-071003/cordis.patch.yml` |

**踩到的坑（已修，值得记）**：第一版把 rpi 原有的 `droppedSessions > 0 → continue`
也搬进了 host 判据分支。后果是**整个远端区块不渲染**（`rows.length === 0` → 组件返回
null）：两台的 DSHpluginWorkSpace 清单都恰好顶到 500 条上限，于是每个工作区都被当成
「清单被截断、无法判断」整行跳过。`presentLocally` 是 host 按本机账目**逐条**判的，
远端清单截断不影响结论 —— 这个护栏属于客户端判据，不该带进 host 分支。
（是`verify-sidebar-section.mjs` 的 `FAIL: no workspace row rendered` 抓到的。）

**激活方式与 opi 不同**：rpi 的 DSH **不热读** `cordis.patch.yml`（opi 会）。改完
host 半边必须 `systemctl --user restart dsh`（`XDG_RUNTIME_DIR=/run/user/1000`）；
client 半边与工厂补丁由浏览器刷新即可（服务端 bundle 已带 `rev` 校验）。重启前确认
`rpi-session-tools.mjs list` 的 `running` 为 0，别打断在跑的会话。

**验证（2026-10-12）**：
- `python3 tree-summary.py`：rpi 的远端(opi)工作区全部带 `localMatch`。
- `node ~/.dsh-remote-tools/verify-sidebar-section-rpi.mjs`：**18/18 全绿**
  （同一份 harness，只换了 CLIENT 路径与对端设备名断言；`＋N` 徽标与 opi 的
  「本机没有的 N 条」是同一件事，断言两种写法都接受）。
- `node selftest.mjs`：**134 PASS**。
- 服务端 bundle 回读：`dsh-client-ui-workspace`（rev `4370b2277597`）与
  `dsh-device-mesh`（rev `0c7290d5fdd9`）都含 `sidebar.workspaces.row.mark`。

### 10.3 供应商列表：补上 opi 后加的 `muse-spark-1.3`（2026-10-12）

2026-10-11 的迁移只搬了当时那 6 个模型；opi 之后又加了 `muse-spark-1.3`
（并且把 **opi 自己**的 `agent-default-model` 换成了它）。rpi 侧已补进
`llm-pi-ai.providers.localhost.models`（现在 7 个，与 opi 一致），
rpi 的 `agent-default-model` **保持 `step-5-preview` 不动**。

验证：`curl -s -X POST http://127.0.0.1:3088/api/session/modelCatalog -H 'content-type: application/json'
--data-binary '{"type":"client-request","rpcId":"...","method":"session/modelCatalog","payload":{"args":{}}}'`
→ `default={"provider":"localhost","model":"step-5-preview"}`，目录里含 `muse-spark-1.3`。
备份：`cordis.patch.yml.bak-musespark-20261012-121305`。




## 13. 多机会话列表权威（P1 方向标注 + P2 状态面与动作鉴权，2026-10-13）

**用户确认的模型**：工作区有「属主/执行侧」(owner) 与「会话侧」(session)。以
`DSHpluginWorkSpace` 为例：**owner = opi（文件与命令真正跑在那台，也是会话行为的
权威）**，**session = rpi（在那台驱动会话）**。规则是
**所有会话行为先送权威判定，结果回来后才由会话侧应用**。

### P1：角色 + 方向标注

| 改动 | 位置 |
| --- | --- |
| `sessionAuthority: orangepi5`（空 = 本机即权威） | `cordis.patch.yml` 网格行 config |
| `workspaceRoles`：4 个工作区 `{ owner: orangepi5, session: xray4668 }` | 同上 |
| `/tree` 出参带 `tree.authority = {deviceId, name, isSelf, configured}` | 宿主 `entry-vNN.js` |
| 标注**只在副本侧渲染**（`authority.isSelf !== false` 直接返回 null），文案改为「副本工作区：属主/执行侧是 X；本机的会话行为先送属主判定，结果回来后才应用」 | 出厂 `dsh-client-ui-workspace/lib/client.js` |

**为什么**：原判据「远端某台报了同 id 的 localMatch」对**两台都成立**，于是 opi
自己的工作区也被画上 ⇄ 并写着「转发执行工作区」—— 而 opi 是那台的属主，用户指出
这是错标。方向必须来自权威关系。

验证：opi `isSelf=true`（不标）／rpi `isSelf=false`（标副本）；harness 加了
「属主侧不画 / 副本侧画」两条断言。

### P2：状态面 + 动作鉴权 + 同步 + 拉取补洞

**状态面**：权威维护 `$DSH_HOME/device-mesh/session-state.json`
`{ version, sessions: {<id>: {archived, at, by}}, log[] }`（审计环形 200 条）。

**三条路由**：

| 路由 | 侧 | 语义 |
| --- | --- | --- |
| `POST /dsh-device-mesh/session-state/propose` | 浏览器同源 | 权威 → 直接应用 + 版本 +1 + 审计；副本 → **先** `caller.request` 转发权威，**拿回执才**本地应用 |
| `POST /api/session-state/action` | 设备 API | 权威接收动作；`requireNode` + `executor.checkAuthority` + 传输层令牌/签名 + 审计记 ts/nonce |
| `GET /api/session-state` | 设备 API | 副本拉权威全量状态（状态面小，不做增量切片） |
| `GET /dsh-device-mesh/session-state` | 浏览器同源 | 角色/版本/归档集/审计尾（自检用） |

**唯一写路径**：`registry.setState({...state, archivedSessionIds})` —— 与
`dsh-archived-sessions` 的恢复同款，只改归档集、不碰域记录其它字段。

**副本周期同步**：`stateSyncIntervalMs`（默认 30s）拉权威状态并覆盖本地分叉；
本地比权威**多**的归档（权威掉线期间的降级本地应用）会被撤掉 —— **权威赢**。

**出厂客户端**：`archiveSession` / `unarchiveSession` 先 POST propose，
settle 后再走原本地路径（归档是集合写、幂等；提示与本地语义不丢；权威不可达
也降级本地应用不卡用户）。

**拉取补洞**：`session-pull` 之前只在**清单**里找目标会话，而归档会话不进清单
（`includeArchived=false`）→ 404。改为：显式指定设备时允许清单未命中；并从对端
日志文件路径反推 slug（`/\/sessions\/([^/]+)\//`），落到正确的工作区目录。

### 实测（2026-10-13，两台）

| 场景 | 结果 |
| --- | --- |
| 副本发起归档 | rpi propose → 转发 opi（审计记 `by=xray4668` + ts/nonce）→ 回执 v2 → rpi 本地应用（47 条） |
| 副本发起恢复 | 回执 v3 → 两边恢复（46 条）；测试会话还原为「未归档」 |
| 权威发起归档 | opi v4；**40 秒内** rpi 同步为 v4/47 条并落注册表（log: `{kind:"sync", from:"orangepi5", version:4}`） |
| 权威发起恢复 | opi v5；rpi 跟随 v5/46 条 |
| 拉取归档会话（原先 404） | HTTP 200，**3,936,333 字节 / 22 块**，落在 `--root-DSHpluginWorkSpace--` 正确 slug ✅ |
| 回归 | harness **22 ok / 0 FAIL**、插件自测 **134 PASS**（两台）；`/tree`、`/session-state` 正常 |

### 备份与还原

所有改动都带 `*.bak-p1-*` / `*.bak-p2-*` 备份（宿主入口、`protocol.js`、`client.js`、
出厂 `client.js`）。入口版本：opi `entry-v26` / rpi `entry-v25`（编号各自独立，
下次改动会自然收敛）。

### 尚未覆盖

- **其它会话行为**（改名 / 删除 / 固定）仍走本地：状态面目前只有 `archived` 一维，
  扩展方式是往 `session-state.json` 的每会话对象加字段 + 动作枚举加值，路由与鉴权
  不需要改。
- **非归档会话的拉取**：现在靠清单命中，归档会话靠显式设备兜底；若要做「一键把
  对端所有本机没有的会话拉全」，需要一个遍历对端 store 的清单路由。

## 14. 执行端标识：远端会话驱动检测（2026-10-13）

**用户提出的问题**：在**会话端** rpi（192.168.1.3:3088）跑会话、**执行端** opi
（192.168.1.19:3088）看界面时，opi 的侧边栏工作区上**没有任何标识**说明「这个工作区
的会话正在远端执行、可能把命令发到本机」。

**根因**：§13 P1 为了修掉「属主侧被误标成转发执行工作区」，把属主/执行侧的标注
整个 `return null` 掉了（`WorkspaceNetworkMark`）。错误标注确实消失，但执行端从此
一条标识都没有 —— 方向要对，标识也不能没有。

### 改动

| 文件 | 改动 |
| --- | --- |
| `drivers.js`（新） | `computeDrivers()`：判定哪些工作区的**会话侧不是本机**、有哪些运行时证据；`readAuditTail()` 有界读审计尾部；`findDriver()` 按 id/路径查询 |
| `entry-v27.js`（opi）/ `entry-v26.js`（rpi） | `driverInput()` 组装输入；`/tree` 内嵌 `tree.drivers`（与独立路由**同源**）；新增 `GET /dsh-device-mesh/drivers` |
| `protocol.js` | `UI.drivers` |
| `client.js` | 属主侧工作区行 `DriverMark`（⇄ + 琥珀色，与「转发执行」的地球图标区分）；`RemoteWorkspacesSection` 行内标示三态；`RemoteSessionRow`/面板会话行复用 `DriverSessionTag`；`drivers` 缺失时与改动前完全一致 |
| `drivers-selftest.mjs`（新） | 70 条断言（含畸形输入、原型污染、审计尾部边界） |
| `client-sidebar-selftest.mjs` | 52 条断言（新增 35 条；对「文案反向 / drivers 缺失仍画 / 副本侧被改 / 去掉警示类 / 去掉（未连接）」逐条做过变异测试） |

判据、数据形状与文案见 [README.md](./README.md) §12.7。

### 实测（两台，2026-10-13）

| 项 | 结果 |
| --- | --- |
| opi `/drivers` | 4 个工作区全部 `remote=true`（owner=orangepi5 isSelf=true / session=xray4668 isSelf=false）；DSHpluginWorkSpace `mirror=7 inbound=93`、ArkTower `mirror=1 inbound=0` |
| rpi `/drivers` | 4 个工作区全部 `remote=false`（session=xray4668 isSelf=true）→ **不标**（方向不反） |
| 证据会话 | opi 10 条（稀疏：只放有镜像/入站证据的，不是 1454 条清单副本） |
| payload 代价 | `drivers` ≈ **7.4 KB**（`/tree` 本身 757 KB），计算 **8 ms** |
| 键对齐 | `drivers.workspaces[].workspaceId` 与工厂行传的 `row.workspaceId`（本机注册表 id）**4/4 逐条相等** → 侧边栏标识查得到判定 |
| 自测 | `drivers-selftest` 70 PASS；整包 `selftest.mjs` 134 PASS；`client-sidebar-selftest` PASS（两台都跑过） |
| bundle | 两台 index.html 的 `&rev=` 已变，抓下来含 `dmesh-driver-mark` / `远端执行会话` / `命令与文件在本机执行`，且副本侧文案未变 |

### 部署（**换入口必须重启服务**）

opi：`entry-v26.js → entry-v27.js`（标记 `mesh-25 → mesh-26`），
`systemctl restart dsh-web.service`。
rpi：`entry-v25.js → entry-v26.js`（标记 `mesh-24 → mesh-25`），
`XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart dsh.service`。
备份：`/root/.dsh-backups-driver-*`（opi）、`/home/xray4668/.dsh-backups-driver-*`（rpi），
各含整份 `plugin/` 与 `cordis.patch.yml`；patch 另有一份 `cordis.patch.yml.bak-driver-*`。
**回退**：把 patch 行的 `name` 指回 `entry-v26.js`（opi）/ `entry-v25.js`（rpi）并重启。

> **更正 §11「三种改动」里的一条**：本 profile 的 `patchReload: live` **实际不生效**。
> 实测：把 patch 行的 `name` 改成新入口后等 2 分钟，`/status` 的 `importTag` 仍是旧值、
> 新路由 404、journal 里没有任何 patch 相关行。原因是 host 半边的热载插件
> （`@deepseek-ai/dsh-hmr` / `dsh-config-editor`）**没有挂进本 profile 的 patch**，
> boot 图里只有浏览器半边的 `@deepseek-ai/dsh-client-hmr`（它只管前端 bundle）。
> 这台机器的历史部署也都是重启（journal 里 05:48、09:26 两次 `Stopping → Started`，
> 后者就在入口文件写盘后 2 秒）。所以**换入口 = 重启服务**，`bump-version.mjs` 打印的
> 「下一步把 name 指过去」只对了一半。

### 尚未覆盖 / 已知边界

- **会话级的入站归属是尽力而为**：`exec` 请求体里**没有 sessionId**（只有
  `command/path/timeoutMs/jobId`），所以「这条会话把命令发到过本机」只能从命令原文里
  捞 `session-<uuid>`（镜像/回填类命令带 id，agent 的普通命令通常不带）。工作区级次数
  是精确的，会话级只会少不会多。要精确归属得给 `exec` 协议加可选的 `sessionId`。
- **rpi 的出厂侧边栏没有 `sidebar.workspaces.row.mark` 槽**（§9 的补丁只在 opi 部署），
  所以 rpi 上属主侧工作区行的标识不会出现；不过 rpi 的判定本来就是 `remote=false`
  （它是会话端），不影响本次需求。
- 面板会话行 `.dmesh-sess` 不是固定行高，18px 小标签会让该行约 +2px；侧边栏 34/32px
  固定行高不受影响。

## 15. 互联会话与纯本地会话的完全分离（2026-10-17）

**用户报的缺陷**：「互联会话读到本地路径了」。根因是路由的**安全缺省**：`routePath()`
对「谁都匹配不上」的路径回落到**本机执行** —— 对纯本地部署合理，但互联会话的 agent 在
会话端、文件在属主那台，回落到本机就是**静默读到会话端自己的文件系统**。实测复现：
会话端（xray4668）的互联会话读 `/etc/hosts`，读到的是**会话端本机**的 `/etc/hosts`，
看起来却像「成功读到了文件」。

**用户确认的模型**：给工作区加一个显式开关 `workspaceRoles[path].mesh`
（**是否作为互联会话**），并据此**完全分离**两个方向：

| 会话所属工作区 | 目标路径 | 判定 |
| --- | --- | --- |
| `mesh: true` | 工作区内 | 发到属主设备（命中归属，同旧行为） |
| `mesh: true` | 工作区之外 | **仍然发到属主设备**，由属主的导出根闸门决定能不能碰；**绝不回落本机** |
| `mesh: true`，属主不明 | 任意 | **拒绝执行**（denied）；绝不回落本机 |
| `mesh: true`，本机就是属主 | 任意 | 本机执行（文件与命令本来就在这台） |
| 未声明 / `mesh: false`（纯本地） | 任意 | **一律本机**，即使命中远端主路径也不转发 |
| 任一模式 | 命中**显式附加路径（member）** | 发到那条附加路径所属设备（人钉的意图比开关更具体） |
| cwd 不在任何工作区 | 任意 | 沿用旧的按路径判定（老部署行为不变） |

语义与判定表见 [README.md](./README.md) §4.1。

### 改动

| 文件 | 改动 |
| --- | --- |
| `routing.js` | 新增 `collectWorkspacePolicy(roles, groups)`（**账目里的每个工作区都进表**，未声明的按纯本地）、`workspaceForPath`、`collectDeviceNames`、`resolveOwnerToken`、`ownerDeviceForWorkspacePath`、`routePathWithPolicy`；`explainRoute` 认 `denied` 与两种新模式。`routePath`（旧接口）逐字不变 |
| `fs-bridge.js` | 收 `workspacePolicy` 提供者；`decide()` 走新判定并把 **cwd（= 会话 cwd）** 传进去；denied → 抛 `FsError(FS_PERMISSION_DENIED)`（刻意避开 `FS_SANDBOX_DENIED`：出厂会替换它的文案并给出错误的提权提示）；`stats().denied` |
| `shell-bridge.js` | 同一套；`resolve()` 上 denied → 同步抛；`stats().denied` |
| `entry-v32.js`（opi）/ `entry-v28.js`（rpi） | `workspacePolicy()` 提供者（策略 + 名字解析表，名字来自**节点表/接入点表**）；两条挂载都转交；`/tree` 的 drivers 与 `/route` 干跑带 `mesh` / `ownerVia`；`/route` 新增可选 `cwd` |
| `drivers.js` | `remote` 与 `mesh` 取交集：`remote = mesh && 会话侧不是本机`（界面标识与路由共用同一个开关） |
| `cordis.patch.yml`（两台） | 4 个工作区加 `mesh: true`（幂等脚本 `enable-mesh-roles.sh`） |
| 自测 | `routing-selftest` 26 → **30**、`drivers-selftest` 70 → **77**、`bridge-selftest` 21 → **34**、整包 `selftest.mjs` 仍 **134** |

### 部署与实测（两台，2026-10-17）

opi：`entry-v30 → entry-v32`（`mesh-29 → mesh-31`），`systemctl restart dsh-web.service`。
rpi：`entry-v26 → entry-v28`（`mesh-25 → mesh-27`，同时把落后三个版本的实现一起补齐），
`XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart dsh.service`。

| 项 | 结果 |
| --- | --- |
| 自测（两台都跑） | routing **30**、drivers **77 PASS**、bridge **34 checks**、整包 **134 checks** |
| opi（属主侧）干跑 | mesh 工作区的 4 条路径（工作区内 / `/etc/hosts` / `/tmp/x` / 无 cwd）**全部 local** —— 属主侧在本机落地是对的 |
| rpi（会话端）干跑 | 工作区内 → `remote (member)`；**`/etc/hosts` → `remote (mesh-owner)`**；**`/tmp/x` → `remote (mesh-owner)`** —— 缺陷消失（不再 local） |
| `/drivers` | 两台都是 `mesh=true`；opi `owner.isSelf=true`、rpi `owner.isSelf=false` |
| 反向保证 | 本部署 4 个工作区**全部**声明了 mesh，节点上没有「未声明 mesh 的工作区」可测 → 该条只能由单元测试覆盖（`routing-selftest` 有两条断言：未声明的账目工作区、`mesh:false` 的工作区都不转发） |

### 部署中踩到并修掉的两个问题

1. **声明里的属主名字解析不出来 → 互联会话被误判成「属主不明」而拒绝执行**（rpi 实测：
   `/etc/hosts` → `denied：owner「orangepi5」解析不到设备`）。根因：路由用的路径组是
   `buildPathGroups([])` 建的（**不带设备清单**），组里的 `deviceName` 是空的，于是名字表
   里根本没有对端。两处一起修：
   - 名字表改从**节点表/接入点表**取（那才是稳的来源）；
   - 名字仍解析不出来时，用**账目**兜底 —— 工作区路径上挂着谁就归谁
     （`ownerDeviceForWorkspacePath`）。名字是提示，账目才是权威。判定结果带
     `ownerVia: 'declared' | 'ledger'`，`/route` 干跑会打出来，便于发现名字表不全。
2. **rpi 的 `index.js` 指向了 opi 的入口名**（整棵树同步时把 opi 的 `index.js` 一起搬了
   过去，而 opi 的 `entry-v30.js` 不在上传集合里）→ `import('./index.js')` 直接
   `ERR_MODULE_NOT_FOUND`，整包自测跑不起来。修法：上传后先把它指回 rpi 自己的当前入口
   （`fix-pi-index.sh`），换版脚本随后会把它指到新入口。

### 一条**误判**（记下来免得下次白改工厂）

排查中一度认为「写/编辑类工具归属不到会话」：出厂 `dsh-tool-fs` 的
`sessionResolveOptions(exec, policyWorkspaceRoot)` 是 `policyWorkspaceRoot ?? sessionCwd(exec)`，
而写/编辑传的正是 `sandboxPolicy.workspaceRoot`（部署配置里是 `process.cwd()`）。**这是误判**：
`sandboxPolicy.resolve({session})` 里那一行是
`workspaceRoot: session?.header.cwd ?? this.workspaceRoot` —— **会话内**调用拿到的就是会话
cwd，部署默认根只对**无会话**调用生效（那种调用本来也没有会话可归属）。读类与写类都能
归属。**没有改任何工厂文件。**

### 尚未覆盖 / 已知边界

- **shell 的显式绝对 workdir**：模型可以传一个工作区之外的绝对 `workdir`（如 `/tmp`），
  而出厂 `resolveWorkdir()` 原样采用它 → `spec.workdir` 不落在任何工作区 → 归属判不出来
  → 退回旧语义（本机）。`bridge-selftest` 里有一条**明确标注「已知缺口」**的断言钉住现状。
  要修得把会话 cwd 带进 shell 请求（出厂请求里没有这个字段）。
- **无会话调用**（`cwd` 缺失、或 `cwd` 不在任何工作区）仍走旧的按路径判定 —— 那是刻意的
  向后兼容，不是遗漏。
- `workspacePolicy` 提供者一旦抛错，fs/shell 的**路由型访问全部拒绝**（响亮失败，不是静默
  降级）：读不到策略时唯一能确定的事实是「不知道这条路径该落在哪」，而互联会话下「不知道」
  等价于「可能读到会话端自己的文件」。

## 16. 工作区归到属主 + 权限口径（2026-10-17 续）

用户报了两件事，**一件要改代码、一件不用改**：

### 16.1 错误归类：xray4668 名下那 4 个工作区其实属于 orangepi5（**已修**）

**根因**：本机注册表会把「会话的 cwd 落在某个工作区路径上」记成**本机的工作区** —— 互联
会话正是这种情形（会话在会话端跑、文件在属主那台）。于是设备网格面板里 xray4668 名下
冒出 4 个其实属于 orangepi5 的工作区；`pathTable` 的 `homeDeviceId` 也被 `syncLocalGroups()`
写成会话端自己。归属的权威应该是配置声明 `workspaceRoles[path].owner`，不是「谁先登记」。

**改法（host）**：新增 `annotateWorkspaceOwners(devices)`（`buildTree` 里调用，**两种 scope
都跑**，否则对端面板同样错误归类）：给每台设备清单里的工作区打上
`ownerDeviceId` / `ownerDeviceName` / `ownerDeclared` —— **只在该工作区 `mesh: true` 且声明的
属主是另一台设备时**才加字段；属主是本机、或没声明 mesh 的纯本地工作区都不加（UI 缺省就是
「这台自己的」）；名字解析不出来时**不猜**（宁可不标也不标错）。与 `annotateLocalOverlap`
一样**不原地改缓存对象**（清单是共享快照，原地加字段会顺着镜像泄漏）。

**改法（客户端）**：见 16.3。

**实测（两台，2026-10-17）**：

| 节点 | xray4668 名下 | orangepi5 名下 |
| --- | --- | --- |
| opi（属主侧） | 4 条，全部标 `owner=orangepi5`（属主在别处） | 4 条，无 owner 字段（自己的） |
| rpi（会话端） | 4 条，全部标 `owner=orangepi5` | 4 条，无 owner 字段 |

### 16.2 「权限溢出」：用户确认口径 = **与在属主上直接运行一致**（**不改代码**）

用户先报「ArkTower 工作区的会话能访问全部工作区（rustdesk_server）」，随后确认口径是
**权限同在属主上直接运行**。核对结果：这正是属主侧**导出面**的直接结果，不是网格越权 ——

- 属主 opi 的 `exportWorkspacePaths: true` + `exportRoots: []` ⇒ `/status` 的
  `effectiveRoots` **实测就是那 4 个工作区路径**（`/root/DSHpluginWorkSpace`、
  `/root/nas/ArkTower`、`/root/code/Stronghold-Protocol-NetworkUnion`、
  `/root/code/rustdesk_server`），所以任何一条被转发过来的请求都能碰这 4 个目录；
- 命令与文件都在**属主那台、以属主的 DSH 进程身份**执行（同用户、同环境、同沙箱策略）
  ⇒ 与在属主上直接跑同一个会话**逐字一致**；
- 网格自己保证的那一半没变：互联会话的请求**永远不在会话端落地**（§15 修的缺陷）。

要收紧到「一条会话只能碰自己的工作区」，改**属主侧的导出面**即可，不需要动网格代码：
`exportWorkspacePaths: false` + 显式 `exportRoots: [...]`，或 `execTrust: grant-required`
（逐台授予执行权），或 `allowRemoteExec: false`（完全关掉跨设备执行，看清单不受影响）。
README §4.1 的「权限边界」小节把这套口径与四个开关写全了。

### 16.3 客户端：面板归到属主 + 会话合并

| 位置 | 改动 |
| --- | --- |
| 样式 | `.dmesh-foreign` / `.dmesh-foreign-row` / `.dmesh-merge-hint` |
| 共享层（新） | `declaredOwnerOf()`、`deviceNameOf()`、`mergeWorkspaceSessions()`、`ForeignWorkspacesNote()` |
| `DeviceBlock` | 按 `ownerDeviceId` 分流 own / foreign；头部「N 工作区」**只数自己的**，另给一枚「N 个属主在别处」徽标；body 只渲染 own + 一行说明 |
| `WorkspaceBlock` | 会话列表 / 计数 / 未列出数 / 活跃标记都走 `mergeWorkspaceSessions()` 的结果；带一句「这个工作区的会话来自 N 台设备（已合并）」 |
| 会话标签 | **复用既有** `dmesh-rw-devtag`（`⇄xray4668`）+ 命中入站证据时的 `dmesh-rw-devtagWarn`，没有第二套 |

最终文案：

- 说明行：`[属主在别处] 这台名下另有 N 个工作区的文件与命令在别的设备上，已归到那台`，
  逐属主一行：`ArkTower、DSHpluginWorkSpace → 属主 orangepi5（会话也合并在那台名下）`
- 头部徽标：`N 个属主在别处`
- 合并提示：`这个工作区的会话来自 N 台设备（已合并）；每条会话的标签标明 agent 在哪台跑。`

三条设计要点（都是踩过或想清楚才这么写的）：

1. **去重按 session id**：两台可能报同一批会话（实测 ArkTower 两边都报 486 条），
   不去重会列两遍。
2. **兜底：属主那台当前没上报时不移走**（离线 / 清单降级）。移走会让那些会话整段消失，
   所以这种工作区**留在本行**并打徽标 `属主 orangepi5 暂未上报`；只有「属主确实报了同一份
   账目」才挪。线上 4 个工作区两边都报，正常不走这个分支。
3. **语义消歧**（防「以为它在 orangepi5 上执行」）：每条跨设备会话带 `⇄xray4668`、
   合并提示明说标签标明 agent 在哪台跑、会话行仍按**记录它的那台**传 `deviceId`
   （所以「拉回历史 / 接管」打的是 xray4668，不会打错台）。

**降级**：`mergeWorkspaceSessions()` 返回 `null`（没有任何属主声明指向本设备）时走的还是
原来的单设备路径 —— 老 host / 纯本地部署与改动前**逐字一致**。

**自测**：新增 `client-panel-selftest.mjs`（三个用例：有声明 / 无声明=改动前一致 /
属主暂未上报），**37 条断言全绿**；变异测试 **6/6 全被杀**（own→全量、去掉合并、
去掉去重、无条件合并、头部计数用全量、去掉「属主暂未上报」兜底），每条失败信息都指向
对应用例。`client-sidebar-selftest.mjs` 仍全绿（§12.5 没被破坏）。

**部署**：`client.js` + `client-panel-selftest.mjs` 上传两台即可，**不需要重启**（浏览器
半边的 bundle 带 `&rev=`，刷新页面就拿到新代码）；换版只发生在 host 半边（16.4）。
实测两台 index.html 的 `&rev=` 都变了，抓下来的 bundle（167818 字节）含
`dmesh-foreign` / `属主在别处` / `已归到那台` / `会话也合并在那台名下` / `暂未上报`。

**一处已知的小落差**：`pathTable` 的 `homeDeviceId` 仍写着「报告设备」（我没改账目 —— 改它
要动持久化语义），所以面板里「工作区多路径」那一栏（`groupFor(workspace.id)`）现在挂在
报告设备名下、而工作区行挂在属主名下。当前部署的附加路径为空（`pathMembers: 0`），看不到
差别；将来真挂了附加路径，那一栏会不跟着工作区行走。要修的话是让 `syncLocalGroups()`
按声明属主写 `homeDeviceId`（并给已存在的 group 一条更新路径）。

### 16.4 部署与踩到的坑

opi：`entry-v32 → entry-v33`（`mesh-31 → mesh-32`），`systemctl restart dsh-web.service`；
rpi：`entry-v28 → entry-v29`（`mesh-27 → mesh-28`），
`XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart dsh.service`。
备份：`/root/.dsh-backups-owner-*`、`/home/xray4668/.dsh-backups-owner-*`。

- **重启后约 60 秒内，本机的清单可能是「0 个工作区」的空采集**（既有现象，不是本次引入：
  `selftest.mjs` 里就有这条「采残的快照」的断言）。我实测踩到过一次 —— 重启 25 秒后
  查 `/tree`，会话端自己的 4 个工作区一条都没有；等到下一轮采集（TTL 20 s + 采集 ~3 s）
  就正常了。**排查清单类问题时先等一轮再下结论。**
- 上传入口文件时用**绝对路径**读写：`.NET` 的 `[IO.File]` 相对路径解析基准与 PowerShell
  的当前目录不是一回事，我因此往 rpi 上传过一个 **0 字节的 entry**（幸好当时运行的实例
  已缓存旧模块，没炸）。现在上传后都会 `ls -l` + `node --check` 复核一次。

## 17. 会话权限模型：属主照**会话权限**执行（2026-10-17 深夜）

**用户口径**（原话）：运行命令应该给完全权限；会话端设置的会话权限是权威的，两边权限一致
统一；不存在应该返回不存在。

### 改动（8 文件）

| 文件 | 改动 |
| --- | --- |
| `exec.js` | `PERMISSION_MODES` / `readPermissionMode()` / `strictestMode()` / `sessionPermissionFromCandidates()` / `checkPermission()` / `allowedRootsFor()` / `checkExported()`；`checkPath` / `checkFsPath` 改成**先权限、再存在**（`checkPath` 新增 `{write}`：命令目录按写算、**目录列举是读**）；`list(target, permission)`；`run()` 审计记 `mode` |
| `entry-v34.js`（opi）/ `entry-v30.js`（rpi） | 入站 exec / fsGate 读权限 + 审计记 `mode`；`sessionPermission(cwd)`（agents → `sandboxPolicy.resolve({session})` → 纯函数，**多会话同 cwd 取最严**）；两处挂载传 `permissionFor`，`mountFsInbound` 传 `permissionOf` |
| `caller.js` | `withPermission()`；exec / request / list 三处并权限；计数 `forwardedWithMode` / `forwardedWithoutMode` |
| `fs-bridge.js` / `shell-bridge.js` | `resolvePermission()`；权限随目标（WeakMap）/随 spec 走到出网请求；计数 `permissionWithout` |
| `fs-inbound.js` | 写/改按请求 mode/root 传**一次性沙箱策略** |
| `selftest.mjs` / `bridge-selftest.mjs` | 权限组 8+8 条 / 7 条 check；旧导出根测试改名「不带会话权限（老 peer）」 |

**字段名偏离**：权限随请求走 `sessionMode`（不是 `mode`）—— `fsRead` 的 `mode` 早就是**读的
编码**（`text`/`bytes`），同名会当场冲掉读编码。受理侧两个名字都认，但只有取值是三种模式之一
时才把 `mode` 当权限；显式 `sessionMode` 非法 → **400**。

**新错误码/文案**：`session-read-only` 403「会话权限是 read-only，不允许写：<path>」；
`session-workspace-write` 403「会话权限是 workspace-write，只允许写 <root> 之下：<path>」；
不存在 = 404 `path-missing`「目录/路径不存在或不可访问：<path>」；非法权限 = 400。

### 实机验证（`probe-gate.mjs` 在会话端打属主的真实入站 API，**11/11 通过**）

| 用例 | 结果 |
| --- | --- |
| `danger-full-access` 读导出根之外（已存在） | 200 ✅（导出根门确实不在了） |
| `danger-full-access` 读**不存在**的路径 | 「不存在」（`info.exists≠true`），**不是**权限错误 ✅ |
| `read-only` 写 | 403 `session-read-only` ✅ |
| `workspace-write` 写根外 / 根内 / 边界 `ArkTowerX` | 403 / 200 / 403 ✅ |
| 不带权限（老 peer）写导出根之外 | 403 `path-not-exported`（旧门原样）✅ |
| `danger-full-access` 在 `/root` 执行命令 | 200 ✅（命令不再被导出根挡） |
| 非法 `sessionMode` | 400 ✅ |
| `danger-full-access` 写属主 `/tmp` | 200 ✅ → **属主本机沙箱确实跟随请求权限**（这一条原本只是「尽力而为」的猜测） |

另外实测：现有 4 条互联会话的日志里各有一条 `sandbox/mode` 事件，**都是
`danger-full-access`** —— 所以这次改动对当前部署是「命令与文件在属主上全面放开」，
不会把原本能做的事收紧。

### 部署

opi：`entry-v33 → entry-v34`（`mesh-32 → mesh-33`）；rpi：`entry-v29 → entry-v30`
（`mesh-28 → mesh-29`）。备份 `/root/.dsh-backups-perm*`、`/home/xray4668/.dsh-backups-perm*`。

### 这一轮踩到的四个坑

1. **`Select-Object -First N` 会把远端部署脚本 SIGPIPE 掉**：用它截断 `ssh ... deploy.sh` 的
   输出 → 管道提前关闭 → 远端 `set -e` 脚本在步骤 4 之后被杀 → **patch 行的入口没翻**、新入口
   装了但没生效（表面看「自测全绿、部署完成」）。改用 `-Last` 或不截断，并且**部署后必须独立
   核对 patch 行 + importTag**。
2. `bridge-selftest.mjs` 一条 check 残留 `opts.runRemote`（从 builder 复制来的，但那条 check 没有
   `opts` 形参）→ 节点上整包自测 `ReferenceError`。
3. `list()` 沿用了 `checkPath` 的写语义 → `workspace-write` 下连列目录都被拒；目录列举是**读**。
4. 一条符号链接测试的**夹具与断言相反**（断言说「指向范围外的链接该被过滤」，夹具却把链接指向
   了范围**内**）—— 这类「测试自己写错」只能靠「夹具能否让断言失败」发现。

### 尚未覆盖

- **`mesh_exec`、面板浏览器 exec/browse、`caller.list` 的本机分支**仍走旧导出根门（这些调用点
  拿不到会话 cwd）。要不要也接上会话权限，等用户定。
- **权限的「显示同步」还没做**：现在两边**执行**用的是同一个权限（随请求走），但两边 UI 还看不到
  这条会话的权限，也还不能从属主侧改。形状已经有了：会话端 `setSandboxMode` 就是
  `session.append('sandbox/mode', {mode})`，而镜像会把该事件带到属主 —— 剩下的是「属主侧改 →
  转发会话端应用」的一条路由 + 面板上一个选择器。
- **命令内部的写不受网格约束**（一条命令能写到它够得着的地方）；要更强隔离得把属主的 DSH 跑在
  受限用户/容器里。

## 18. 权限的显示 + 哪边改都同步（2026-10-18）

**显示**：`inventory.js` 每条会话新增 `mode`（可缺省），来源 = **已加载会话**的
`sandboxPolicy.resolve({session}).mode`（与会话端转发请求时**同一个函数**，所以显示与执行不可能
不一致）；`sanitizeInventory` 白名单放行它（跨设备互通全靠这条）。UI：面板会话行权限标签
（`dmesh-mode-tag`，`read-only` 警示色），**读不到就不画**。

**改（双向，只走一跳）**：设备 API `POST /dsh-device-mesh/api/session-mode {sessionId,mode}`
（`requireNode` + `checkAuthority`；非法 mode→400、找不到已加载会话→400「不在这台机器上」、
成功 = `session.append('sandbox/mode',{mode})` + 审计）；浏览器 `POST /dsh-device-mesh/session-mode`
（本机已加载就地改，否则按 deviceId 一跳转发）。UI：三选一 select，**只在改得动时出现**，失败显示
对端原话。

**验证**：两台 `importTag` = `mesh-34` / `mesh-30`，`problems: []`；节点上 `selftest.mjs` **152 PASS**、
bridge 41、panel 51、routing 30、drivers 77；两条新路由在两台都实测挂上（非法 mode → 400、
不存在的会话 → 400 带「不在这台机器上，也没能从清单里找到」）；同步系统 A（`session-state`
role=authority/replica，两边 version=24、archived=64 一致）/ B（镜像 23 → 23 会话）仍正确；
两台插件代码指纹（忽略 `?v=` 后）完全一致。

**四条如实说明**：
1. **静置会话不显示权限**：投影缓存这条路**走不通** —— `sandboxMode` 注册时没有 `wire`，
   而 `viewCheckpoint()` 对 `def.wire === undefined` 直接 `continue`；且 `cachedSnapshot(header, 0)`
   的第二个参数是**键数组**，`new Set(0)` 会抛。所以只有**正在跑（已加载）**的会话带 `mode` ——
   权威口径也支持这一点（权限的权威就是那条会话本身）。要让静置会话也显示，得改出厂
   `dsh-sandbox-policy` 给 `sandboxMode` 加 `wire`，属工厂改动。
2. **顺带发现一个既有 bug（未修）**：`inventory.js` 的 `cachedTitles()` 调
   `cachedSnapshot(header, 0)` → `new Set(0)` 抛 TypeError（被 try/catch 吞掉）→「零 I/O 读缓存
   标题」**从未生效**，标题一直靠日志折叠（这也是冷采集 3.7–7.6 s 的原因）。一行可修
   （`cachedSnapshot(header)`），但会改变标题来源，需要单独确认。
3. **转发成功路径没有自动化覆盖**（需要真配对）：只验证了两条路由的校验与错误分支；
   要端到端确认，需在属主上对一条**正在 .3 上跑**的会话发一次 `session-mode`（会真的改那条会话的
   权限，建议改完改回）。
4. **`.3` 重启后清单可能长时间是「0 工作区」**（`degraded: true`、`workspaceCount: 0`、
   `sessionCount` 正常）—— 这是既有现象：工作区注册表要等**浏览器挂载侧边栏**才填满，
   所以「重启后没打开过 .3 的界面」时，对端看到的就是 0 工作区。打开/刷新 .3 的 GUI 即可恢复。
   排查清单类问题时先确认这一条，别误判成新引入的 bug。



## 19. 恢复「隐藏已归档」出厂默认（2026-10-19，rpi/192.168.1.3 = 本机）

**用户报的缺陷**：「192.168.1.3 的 dsh 存在归档依然显示在工作区」。

**定位**：192.168.1.3 就是本机（rpi；从 orangepi5 `ssh pi` 连回的 machine-id/uptime/
dsh 进程 PID 与本机完全一致）。归档会话留在 workspace 的 `sessionIds` 槽位是出厂设计
（`dsh-workspace`：归档不碰记账，恢复时还原位置；`workspaceRegistry.archivedSessionIds`
是全局归档集，UI 各分组面自行过滤）。真正原因是 2026-10-12 的一处本地工厂补丁把
`dsh-client-ui-workspace/lib/client.js` 的视图 store 默认
`archivedFilter: "default"` 改成了 `"show"`（注释「默认显示已归档：原来默认隐藏，
老会话因此"没有入口"」；备份 `client.js.bak-showarchived-20261012-231714`），
此后所有浏览器默认显示归档行（本机归档集 69 条，其中 66 条仍挂在各工作区槽位）。

**改法**：同一行改回 `archivedFilter: "default"`（带说明注释），备份
`client.js.bak-archivedfilter-default-20261019`。`node --check` 通过。

**生效**：`dsh-client-hmr` 每 500 ms stat-poll 该文件，改完无需重启——刷新页面后
index.html 的 combo `&rev=` 从 `c017dd2dc91c` 变为 `387b1aaeafc0`，抓下的 bundle
`archivedFilter: "default"` 已验证。

**注意（localStorage 覆盖链）**：视图 store 持久化在 `dsh.workspace.view.v5`
（`defineStore` 的 rehydrate 是整值 JSON 覆盖 init 默认值）。**曾点过「全部对话/仅显示
已归档」或经历过 10-12~10-19 期间 store 首次持久化的浏览器**，localStorage 里已存
`"show"`，改默认值对它们**不生效**——这类浏览器需在侧边栏「视图选项」菜单里手动选回
「隐藏已归档」一次（或清除该 localStorage 键）；新浏览器/清除后自动用新默认。
`dsh-archived-sessions` 插件不写该 store（已核实），无其它 writer。

## 20. 通用设置新增「归档会话显示」行（2026-10-19）

**用户要求**：在通用设置里增加选项调节归档会话的显示（承接 §19 恢复出厂默认）。

**改法（工厂补丁，`dsh-client-ui-workspace/lib/client.js` 三处，备份
`client.js.bak-archivedfilter-default-20261019` 已含 §19 前状态）**：

1. **组件 `ArchivedFilterRow`**（插在 `ViewOptionsMenu` 与 `sessionDragOrder` 之间）：
   `PreferenceRow` 同款布局（标题/描述 + 右侧下拉选择器），`Menu` 三选一
   （隐藏已归档 / 显示已归档 / 仅显示已归档），图标与侧边栏「视图选项」菜单一致
   （ArchiveOff/Queue/ArchiveCheck）。选择前 `focus({preventScroll:true})` 还焦点。
2. **注册**（`apply` 尾部）：`settings.general.item` 槽，`id: "archived-filter"`、
   `order: 14`（transcript-view 12 与 developer-tools 15 之间）、**`store: viewStore`**——
   与 `sidebar.workspaces`/`shell.overlay` 同一个视图 store handle，root scope 复挂
   仅增计数（`handleScopes` 只拒跨 scope），`resolveStore` 按 handle 缓存返回**同一实例**，
   所以设置页与侧边栏**双向即时同步**，持久化走 view store 自己的
   localStorage 键（`dsh.workspace.view.v5`），不引入第二个存储。
   组件从渲染器合成的 `useStore`/`actions` props 读写，无需 inject。
3. **字典**（zh/en 各 6 键）：`settings.archivedFilter.{title,description,default,show,only}`；
   菜单三项直接复用既有 `viewOptions.{hideArchived,showArchived,onlyArchived}`。

**边界**：写入口有白名单（只接受 default/show/only，防伪造 union）；读侧
`s.archivedFilter ?? "default"` 兜底旧持久化缺字段。settings-nav 插件对布局里
没提到的新行按 order 追加在「未分组」末尾——用户可在设置导航管理面里自行编组。

**验证（无浏览器控制，按 verification.md 口径如实说明）**：
- `node --check` 通过；HMR 热换实测：页面 `&rev=` 变 `eab7089bbb9a`，抓取的
  combo bundle 含组件、注册、双语键，17/17 结构断言通过（/tmp/verify2.mjs）；
  `Menu` props 对照 primitives 源码逐项核对（items/selectedId/onSelect/align/portal/anchor）；
  服务端 dsh.log 无 SlotAssembly/crash。
- **浏览器内实际渲染未经自动化验证**：需人工刷新设置页确认「通用」分节出现
  「归档会话显示」行，且切换时侧边栏即时生效（两处共享同一 store 实例，理论上必然）。
