# rea-mcp — REA 的 DSH 插件（自带运行时 + 设置页工具选择器）

把 [morluto/rea](https://github.com/morluto/rea)（REA：Reverse Engineer Anything）
封装成一个**自包含**的 DSH 插件：

- 插件目录里自带 REA 运行时（`runtime/`），不依赖全局安装；
- 由 `@deepseek-ai/dsh-mcp-client` 以 stdio 接入 REA 的 MCP 服务器（207 个分析工具）；
- 设置页新增 **「REA 工具」**：作用范围（默认 / 单个会话）+ 总开关 + 逐工具勾选 + 搜索 + 分组 + 预设，保存立即生效。
  没勾选的工具不止是「不让调」，而是**连 schema 都不随请求下发**（省上下文）。
- **选择按会话隔离**（v2）：改某个会话的 REA 工具集，不会影响其它会话；没有单独设置的会话继承 `defaults`。

## 目录

| 路径 | 作用 |
|---|---|
| `index.js` | host 半边：读写选择（按会话）、按 Agent 挂/摘 `tools.restrict()`、五条同源路由 |
| `entry-v5.js` | 入口外壳（只 `export * from './index.js?v=…'`）：改过 host 代码就换一个新 `?v=`，
让 Loader 按新 specifier 重新 import，见「维护」。旧外壳 v2–v4 留在目录里但已不被引用 |
| `client.js` | 浏览器半边：设置页「REA 工具」页（主题 token、locale、无 Harness Client 依赖） |
| `cordis.patch.yml` | 两行：`rea-mcp`（本插件）+ `rea-mcp-server`（dsh-mcp-client 跑 `rea mcp`） |
| `package.json` | bundle 清单 + `dsh.client` 声明 |
| `runtime/` | REA 运行时：`rea-agents@6.7.0`（`npm install --omit=optional`） |
| `probe-mcp.mjs` | 维护用探针：绕过 DSH 直连 `rea mcp` 做握手 / 列工具 / 调一个工具 |

## 安装与状态

已安装到当前 profile（`link:` 到本目录）。注意「link 即生效」只对**新增/删除文件**成立：
host 侧改 `index.js` 需要新入口外壳 + remove → install 才会热换（见「维护」）：

```
plugin_manager install_bundle    target=link:D:/WorkSpace/plugins/rea-mcp
plugin_manager set_bundle        target=@local/rea-mcp  enabled=false   # 停用整个插件
plugin_manager remove_bundle     target=@local/rea-mcp                  # 卸载（runtime 不删）
```

重装同一个 link 目录时若报 `ambiguous-install`（包名已存在且版本没变，pnpm 认为没装新东西），
先 `remove_bundle` 再 `install_bundle` 即可。

## 设置页怎么用

侧边栏 → 设置 → **REA 工具**（order 45）。

**作用范围**（页面顶部第一张卡片）——决定「你在改谁的设置」：

- 选 **默认**：改的是 `defaults`，所有**没有单独设置过**的会话都继承它；
- 选某个会话（下拉里列出「有覆盖的 + 在线的」会话，带 `· 有覆盖 / · 在线` 标记）：
  改的是这个会话自己的覆盖，**其它会话和默认都不受影响**；
- 会话卡片下的说明文字会直说当前是「继承默认」还是「已有自己的设置」；
- 保存会让该会话**从默认脱钩**（覆盖 = 当时那份选中的完整快照），此后改默认它不跟；
- **清除本会话设置（回到默认）**：删掉这个会话的覆盖，回到继承。

在这个范围下：

- **总开关**：关掉 = 连接保留，但模型完全看不到 REA 工具；
- **勾选**：逐工具开关，可按组「全选分组」，也可搜索名字/描述；
- **预设**：全选 / 全不选 / 核心推荐（28 个最常用入口）；
- **保存**：落盘 + 立即重挂限制，下一轮请求就是新工具表；
- **恢复默认全选**（默认范围下）：把 `defaults` 回到 207 个全开。

「会话」的粒度是**家族根**：沿 `parentSession` 走到顶，同一家族的会话共用一份覆盖。
**只有子代理带 `parentSession`**（`dsh-subagent` 建 child agent 时写入），所以子代理跟着父会话走、
不必逐个重设；`/fork` 出来的分支**不带** `parentSession`（宿主只写 `cwd` / `isSeeded`），
它是**独立家族**——从 `defaults` 继承，之后和源会话互不影响。

选择状态在 `$DSH_HOME/rea-mcp/tools.json`（`stateFile: null` 时用这个默认路径，0600、原子写）。
页面顶部实时显示「已启用 N / 207 · 本轮 schema 体积」——全量约 775 KB，核心集约 36 KB。

语义：`masterEnabled=false` 隐藏全部；`mode='all'` 全放行（**未来新增工具自动可见**）；
`mode='custom'` 只放行勾选的（新增工具默认隐藏）。

### 状态文件形状（v2）

```jsonc
{
  "version": 2,
  "defaults": { "masterEnabled": false, "mode": "all", "enabled": ["mcp__rea__…"], "updatedAt": "…" },
  "sessions": { "<家族根 sessionId>": { "masterEnabled": true, "mode": "custom", "enabled": ["…"], "updatedAt": "…" } },
  "updatedAt": "…"
}
```

读盘时对 v1（顶层直接是选择对象）做一次性迁移：整个顶层折进 `defaults`、`sessions` 置空，
随即按 v2 回写；迁移幂等，写盘失败不会丢掉原文件（先写临时文件再 rename）。
`sessions` 里没有的会话 = 继承 `defaults`。比 `version` 更新的文件（比如 v3）按 v2 解读、
记一条 issue 提醒，**不会**被降级回写（防止旧插件抹掉新格式字段）。

⚠️ **手工编辑 `tools.json` 不会立刻生效**：插件内存里持有状态，磁盘只在写入和「每次保存前重读」时被读。
手改要么重启 dsh，要么在设置页随便保存一次触发重读；而**保存会把手改的其它会话覆盖连带持久化，
但下一次保存之前的路由读到的是内存旧值**——所以手改只当应急，改完重启最稳。

## 为什么这样做

`dsh-mcp-client` 没有 allowlist/裁剪配置项，207 个 tool schema 会整份进每轮请求。
Harness 唯一的官方裁剪口是 `ctx.tools.restrict()`，但它**只能挂在带作用域标签的
`agent.ctx`** 上（进程级限制会被框架直接拒绝），且 `deny` 里的名字必须是当前已注册的
全局工具。所以 host 半边：

1. `agent/created` 时给每个 Agent 挂 `restrict({ deny: 未选中的 mcp__rea__* })`；
2. 插件加载时对已存在的 Agent 补挂（本会话就是这样被接管的）；
3. 监听 `tools/change`（150ms 防抖）——REA 重连、换工具、限制变化都重新计算，
   deny 集合没变就跳过，避免自激；
4. 保存/停用/卸载时摘掉自己的限制，恢复原可见面；
5. `restrict()` 抛错时**自动重试**（1 秒后再全量重挂，连续失败满 5 次放弃并只记日志；
   `tools/change` 一来就清零重算），不留「本该隐藏却可见」的半挂状态。

不重写 MCP 客户端是刻意的：握手、重连、工具代际、图片与取消语义都由
`dsh-mcp-client` 负责，重写只会丢行为。

## 路由（同源，POST 校验 Origin/Host）

```
GET  /dsh-rea-mcp/state?sessionId=…      → { state, scope{…}, defaults, sessions[], directory[], tools[], groups[], presets[], stats, server{…}, issues[] }
GET  /dsh-rea-mcp/effective?sessionId=…  → { sessionId, root, source:'session'|'defaults', masterEnabled, mode, enabledCount }
POST /dsh-rea-mcp/save                   ← { masterEnabled, mode: 'all'|'custom', enabled: [mcp__rea__*], sessionId? }
POST /dsh-rea-mcp/reset                  ← { sessionId? }
POST /dsh-rea-mcp/workbench              ← { on: boolean, sessionId? }
```

**`sessionId` 决定写谁**：带 ⇒ 只写 `sessions[家族根]`（该会话的覆盖）；不带 ⇒ 写 `defaults`。
`/reset` 带 `sessionId` 只删这一个覆盖，不带则把 `defaults` 恢复成全选。
`/state` 返回的 `scope` 告诉你这个会话现在用的是哪一份（`source`）、有没有自己的覆盖（`hasOverride`），
`directory` 是下拉框的会话清单（有覆盖的 + 在线的）。

`server.notes` 是插件侧的最近诊断（限制挂载失败、状态文件读坏等），设置页会显示。

## 工作箱联动（dsh-workbench）

设置页的总开关与**工作箱**（输入框 order 23 的图标）是同一份状态，但**各自按会话**：
工作箱带 `sessionId` 调 `/dsh-rea-mcp/workbench`，只翻转**本会话**的 `masterEnabled`，
`mode` 与 `enabled` 白名单原样保留——在设置页精挑的工具集不会被工作箱破坏。

工作箱这边的两条防泄漏约定（改动别破坏）：

1. **必须带 `sessionId`**：不带就写到 `defaults`，等于把这一箱的开关扩散到所有没覆盖的会话（v2 之前的泄漏路径）；
2. **状态没变就不发**：勾别的条目时不会凭空给本会话建覆盖（建了就和 `defaults` 脱钩，之后改默认它不跟）。

工作箱的 `/reset` 也会带 `sessionId` 调本插件的 `/reset`，把这个会话的覆盖一并清掉。

「未勾选 = 零 REA 上下文」由**两处**共同完成：
① 本插件 `tools.restrict()` 把全部 `mcp__rea__*` 从工具面摘除（schema 不下发）；
② dsh-workbench 在系统提示装配期删掉 `mcp:rea` 说明段（dsh-mcp-client 没有
instructions 开关，只能由装配瀑布删）。

## 已验证（本机实测）

- 安装：`install_bundle` → `application: applied`，两行都在组合里（`dsh --profile web --dump-config`）。
- 连接：`GET /dsh-rea-mcp/state` → `connected: true`，207 个工具，全量 schema 774,814 B。
- 过滤：保存核心集（28 个）后，经 DSH 的 `Tool.listTools` 实测 **只看到 28 个**
  `mcp__rea__*`（其余 60 个原生工具不受影响），`server.applied=18`（18 个活 Agent 各挂一条）；
  全关时 `enabled=0 / applied=18`；恢复全选后 `applied=0`（限制已摘除），schema 回到 774,814 B。
- 真实调用：`mcp__rea__binary_session` 经 DSH 返回 `rea-agents 6.7.0` 自述。
- UI 结构：`Slots.listSubTree settings.section` 里有 `id: rea-tools, order: 45, active: true`。
- **按会话隔离（2026-11-12，HTTP 层实测）**：
  - 对会话 A `POST /save {sessionId: A}` → A 的 `scope.source=session, hasOverride=true`，
    顶层 `defaults` 纹丝不动（`master=false, enabled=207`），会话 B 仍是 `source=defaults`；
  - `POST /workbench {sessionId: B, on: true}` → B 从默认**复制**整份选择后翻转总开关（`mode=all, enabled=207`），A 不受影响；
  - `POST /reset {sessionId: A}` → 只删 `sessions[A]`，`sessions` 回到空、A 回到继承；
  - 工作箱勾一个**与 REA 无关**的条目不会再给该会话建覆盖（`/set` 只在状态变化时 POST）。
- **并发写不互抹（2026-11-12，v5 实测 `_tmp\toolbox-isolation\probe-concurrency.mjs`）**：
  8 个并发 `/workbench`（4 个会话各 2 次）全部落地，4 份会话覆盖**无一被并发竞争抹掉**；
  「会话覆盖 + defaults 保存」同时发生两者都保留；`/effective` 按会话读回与 `/state` 一致。
  靠的是 `mutate()` 的写链串行化 + **落盘前重读磁盘**（旧实现会基于请求进入时的旧快照整份回写）。
- **设置页（无浏览器渲染实测）**：用最小 React 替身把 `client.js` 的 Page 跑在**真实 host 快照**上，
  21 项断言全过：范围下拉框选项数 = 目录会话数 + 1、默认范围提示文案、切到会话范围后
  `GET /state?sessionId=` / `POST /save{sessionId}` / `POST /reset{sessionId}` 的归属都正确。

**未做的验证**：本机页面需要带令牌的 URL 才能打开，拿不到浏览器控制，
所以「设置页长什么样」没有截图级验证（client.js 的渲染逻辑用上面那个替身上测了）；
client.js 由内容哈希供包，**刷新一次页面**即可拿到当前版本。

## 更新 REA

```bash
npm install rea-agents@latest --omit=optional \
  --prefix "D:/WorkSpace/plugins/rea-mcp/runtime"
```

然后重启 dsh。`--omit=optional` 必须保留：optional 依赖 `frida` 本机下载极慢，
而本插件用不到它的运行时注入。Node 需 `^22.19 || ^24.11 || >=26`（本机 v24.18.0）。

## 维护（改代码之后）

- `client.js`：由内容哈希供包，改完**刷新页面**即可（没跑 `dev:web` 时不会自动热换）。
- `index.js` / 任何 host 侧本地模块：Loader 按 specifier 缓存模块，光 reload 行没用。
  新建一个 `entry-v<N+1>.js`（内容只有一行 `export * from './index.js?v=<新标记>';`），
  把 `cordis.patch.yml` 里 `rea-mcp` 行的 `name` 指过去（**保持 row id 不变**，loader 才会 dispose→start），
  然后 `plugin_manager remove_bundle` → `install_bundle`。
  ⚠️ **只改 `cordis.patch.yml` 不会热换运行中的实例**：patch 层会先显示新模块名，
  但活着的进程还在跑旧代码（症状：新路由 404 / 返回旧字段），必须走一次 remove → install。
- 只改 `cordis.patch.yml` 的 `config`：同样走一次 remove → install（或重启 dsh）。

## 本机能力边界

开箱可用：JS/Electron、.NET 静态、Go/Rust 元数据、PE 资源、plist/artifact 图、
Flutter/Dart、SQLite、pcap 摘要、浏览器观察（需自备 Chrome 家族浏览器）、
adb（`/usr/bin/adb` 在）、gdb 会话、证据/比较/重构校验类。

当前缺（工具会如实报 `provider_missing` / `unsupported_host`，不是插件坏了）：
Ghidra（未设 `GHIDRA_INSTALL_DIR` 且无 `java`）、Hopper、IDA、JDK/JADX、apktool、
binwalk/unblob、tshark、WABT、sigrok、JEB/Kuna；pwntools 离线 ELF 诊断、EVM 字节码、
Wakaru 恢复、macOS 工具链按上游只支持 x64/macOS（本机 arm64）。

补齐方式：给 `cordis.patch.yml` 的 `rea-mcp-server` 行加 `env:`（例如
`GHIDRA_INSTALL_DIR`、`REA_JADX_MCP_JAR`），并把外部工具装好——不需要改插件代码。

## 已知边界

- 只过滤**全局层**注册的 `mcp__rea__*`；若把 `rea-mcp-server` 行挪进某个 agent 预设
  （作用域层），本插件看不到也管不到（会写进 `server.notes`）。
- 工具全隐藏后模型无法自救——只能在设置页或 patch 里打开。
- 名字以 `mcp__rea__` 前缀识别；改 `serverName` 需要同步改 `serverPrefix` 配置。
- 子代理会话各自挂独立的限制，但**归属到父会话的家族根**：子代理不能有自己的一份 REA 选择
  （它会和父会话抢同一份覆盖）——这是刻意的，避免父子互相打架。
- 会话粒度是**家族根**：`parentSession` 链上的所有会话共用一个覆盖；`/fork` 分支**不带**
  `parentSession`，是独立家族（继承 `defaults`，与源会话互不影响）。同一会话重启后
  sessionId 变了，覆盖不会自动跟过去（旧根的覆盖会作为 `· 有覆盖 · 离线` 留在下拉里，可清除）。

## 许可

REA 是 MIT；本插件只做桥接与选择，不含上游代码的再分发声明变更。
第三方工具（IDA/Hopper/JEB 等）各自授权，插件不提供任何许可或密钥。
