# rea-mcp — REA 的 DSH 插件（自带运行时 + 设置页工具选择器）

把 [morluto/rea](https://github.com/morluto/rea)（REA：Reverse Engineer Anything）
封装成一个**自包含**的 DSH 插件：

- 插件目录里自带 REA 运行时（`runtime/`），不依赖全局安装；
- 由 `@deepseek-ai/dsh-mcp-client` 以 stdio 接入 REA 的 MCP 服务器（207 个分析工具）；
- 设置页新增 **「REA 工具」**：总开关 + 逐工具勾选 + 搜索 + 分组 + 预设，保存立即生效。
  没勾选的工具不止是「不让调」，而是**连 schema 都不随请求下发**（省上下文）。

## 目录

| 路径 | 作用 |
|---|---|
| `index.js` | host 半边：读写选择、按 Agent 挂/摘 `tools.restrict()`、三条同源路由 |
| `client.js` | 浏览器半边：设置页「REA 工具」页（主题 token、locale、无 Harness Client 依赖） |
| `cordis.patch.yml` | 两行：`rea-mcp`（本插件）+ `rea-mcp-server`（dsh-mcp-client 跑 `rea mcp`） |
| `package.json` | bundle 清单 + `dsh.client` 声明 |
| `runtime/` | REA 运行时：`rea-agents@6.7.0`（`npm install --omit=optional`） |
| `probe-mcp.mjs` | 维护用探针：绕过 DSH 直连 `rea mcp` 做握手 / 列工具 / 调一个工具 |

## 安装与状态

已安装到 `web` profile（`link:` 到本目录，改动即生效，无需重新安装）：

```
plugin_manager install_bundle    target=/home/xray4668/Documents/AgentsWorkspace/plugins/rea-mcp
plugin_manager set_bundle        target=@local/rea-mcp  enabled=false   # 停用整个插件
plugin_manager remove_bundle     target=@local/rea-mcp                  # 卸载（runtime 不删）
```

重装同一个 link 目录时若报 `ambiguous-install`（包名已存在且版本没变，pnpm 认为没装新东西），
先 `remove_bundle` 再 `install_bundle` 即可。

## 设置页怎么用

侧边栏 → 设置 → **REA 工具**（order 45）。

- **总开关**：关掉 = 连接保留，但模型完全看不到 REA 工具；
- **勾选**：逐工具开关，可按组「全选分组」，也可搜索名字/描述；
- **预设**：全选 / 全不选 / 核心推荐（28 个最常用入口）；
- **保存**：落盘 + 立即重挂限制，下一轮请求就是新工具表；
- **恢复全选**：回到默认（207 个全开）。

选择状态在 `$DSH_HOME/rea-mcp/tools.json`（`stateFile: null` 时用这个默认路径，0600、原子写）。
页面顶部实时显示「已启用 N / 207 · 本轮 schema 体积」——全量约 775 KB，核心集约 36 KB。

语义：`masterEnabled=false` 隐藏全部；`mode='all'` 全放行（**未来新增工具自动可见**）；
`mode='custom'` 只放行勾选的（新增工具默认隐藏）。

## 为什么这样做

`dsh-mcp-client` 没有 allowlist/裁剪配置项，207 个 tool schema 会整份进每轮请求。
Harness 唯一的官方裁剪口是 `ctx.tools.restrict()`，但它**只能挂在带作用域标签的
`agent.ctx`** 上（进程级限制会被框架直接拒绝），且 `deny` 里的名字必须是当前已注册的
全局工具。所以 host 半边：

1. `agent/created` 时给每个 Agent 挂 `restrict({ deny: 未选中的 mcp__rea__* })`；
2. 插件加载时对已存在的 Agent 补挂（本会话就是这样被接管的）；
3. 监听 `tools/change`（150ms 防抖）——REA 重连、换工具、限制变化都重新计算，
   deny 集合没变就跳过，避免自激；
4. 保存/停用/卸载时摘掉自己的限制，恢复原可见面。

不重写 MCP 客户端是刻意的：握手、重连、工具代际、图片与取消语义都由
`dsh-mcp-client` 负责，重写只会丢行为。

## 路由（同源，POST 校验 Origin/Host）

```
GET  /dsh-rea-mcp/state      → { state, tools[], groups[], presets[], stats, server{...} }
POST /dsh-rea-mcp/save       ← { masterEnabled, mode: 'all'|'custom', enabled: [mcp__rea__*] }
POST /dsh-rea-mcp/reset      → 回默认全选
POST /dsh-rea-mcp/workbench  ← { on: boolean }   （工作箱联动，见下）
```

`server.notes` 是插件侧的最近诊断（限制挂载失败、状态文件读坏等），设置页会显示。

## 工作箱联动（dsh-workbench）

设置页的总开关与**工作箱**（输入框 order 23 的图标）是同一份 `masterEnabled`：
工作箱经 `/dsh-rea-mcp/workbench` 只翻转 `masterEnabled`，`mode` 与 `enabled`
白名单原样保留——在设置页精挑的工具集不会被工作箱破坏。

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

**未做的验证**：本机页面需要 `dsh web` 打印的带令牌 URL 才能打开，拿不到浏览器控制，
所以「设置页长什么样、点了会不会报错」没有截图级验证；client.js 由内容哈希供包，
**刷新一次页面**即可拿到当前版本（改过文案与多语言 thunk）。

## 更新 REA

```bash
npm install rea-agents@latest --omit=optional \
  --prefix /home/xray4668/Documents/AgentsWorkspace/plugins/rea-mcp/runtime
```

然后重启 dsh。`--omit=optional` 必须保留：optional 依赖 `frida` 本机下载极慢，
而本插件用不到它的运行时注入。Node 需 `^22.19 || ^24.11 || >=26`（本机 v24.18.0）。

## 维护（改代码之后）

- `client.js`：由内容哈希供包，改完**刷新页面**即可（没跑 `dev:web` 时不会自动热换）。
- `index.js` / 任何 host 侧本地模块：Loader 按 specifier 缓存模块，光 reload 行没用。
  复制 `entry-v2.js` 为 `entry-v3.js`（里面 `?v=` 加一），把 `cordis.patch.yml` 里
  `rea-mcp` 行的 `name` 指过去（**保持 row id 不变**，loader 才会 dispose→start），
  然后 `plugin_manager remove_bundle` → `install_bundle`。
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
- 子代理会话各自挂独立的限制（同一策略，状态不共享）。

## 许可

REA 是 MIT；本插件只做桥接与选择，不含上游代码的再分发声明变更。
第三方工具（IDA/Hopper/JEB 等）各自授权，插件不提供任何许可或密钥。
