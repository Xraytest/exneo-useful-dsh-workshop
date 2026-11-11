# WorkSpacePlus

以**项目**为单位理解 DeepSeek Harness 的工作区：一个项目 = **一个主路径（primary）+ 多个次要路径（secondary）**。
当某个会话的工作目录落在某项目的任一归属路径内时，该项目即成为该会话的"活动项目"，其完整路径集合会注入到模型的运行时上下文中，让智能体把跨目录的多个目录当成**同一个项目**来读写；项目通过一组模型工具管理。

设计参考了 `zai-org/ZCode` 的项目模型（`ProjectRoot { rootPath, isPrimary }`、`VirtualProject { roots }`，以及会话解析出的 `{ workspacePath, additionalDirectories }`），并按 DSH 的插件/服务边界落地。

## 它解决什么

DSH 原生模型里，每个会话只有**一个**工作目录（cwd）：`workingDirectory.get(session)` 返回单一绝对目录，相对路径都相对它解析；`resolveWorkspacePath(cwd, path)` 对绝对路径原样返回。跨多个目录协作（例如 `D:\WorkSpace` 主仓 + `mathbook` + `live2d_project`）时，模型只"看得见"cwd，需要你反复用绝对路径指点其它目录。

WorkSpacePlus 在这一层之上加了一个**项目层**：把若干目录归为一个项目，告诉模型"这些目录是一个项目"，从而让模型自然地跨主/次要路径工作。

## 数据模型

项目记录（持久化在 `~/.dsh/workspace-plus/projects.json`，即 `$DSH_HOME` 下）：

```jsonc
{
  "version": 1,
  "projects": [
    {
      "id": "uuid",
      "name": "WorkSpace",
      "primaryPath": "D:\\WorkSpace",          // 唯一主路径（锚点）
      "secondaryPaths": ["D:\\WorkSpace\\mathbook", "D:\\WorkSpace\\live2d_project"],
      "pinned": false,
      "createdAt": 1730000000000,
      "updatedAt": 1730000000000
    }
  ]
}
```

- **主路径**：项目的锚点，也是默认 cwd 归属判定的首选。
- **次要路径**：同项目的其它目录，可增删；不得与主路径相同（去重、大小写/斜杠归一后在 Windows 下视为同一路径）。
- **活动项目判定**（`activeFor(cwd)`：纯函数、无需额外会话状态）：遍历所有项目，若某项目的任一归属路径"包含"cwd 即命中；优先主路径包含，其次按最长匹配取最具体者。因此会话无需显式"加入"项目——把工作目录设进项目路径内即可。

## 架构（Host-only）

`index.js` 导出 `apply(ctx)` 与 `inject = ["tools", "systemPrompt", "workingDirectory"]`，在激活时：

1. **读取/持久化**：从 `$DSH_HOME/workspace-plus/projects.json` 同步载入内存；每次变更后经串行写链原子落盘（临时文件 + rename）。插件自有数据**不写入任何新的会话事件类型**，因此 fork / resume / replay 不受影响（遵循 `practices.md`："keep plugin-owned data in a storage service"——此处用自管的 JSON 文件，避免依赖可选的后端装配）。
2. **系统提示上下文**：注册 `systemPrompt.context({ name: "workspace-plus:project", order: 105 })`，其 `text(context)` 在每次组装时求值：取 `context.agent.session` 的 cwd → `activeFor` → 非空则渲染一段"活动项目 + 主路径 + 次要路径 + 使用说明"。order=105 紧随 `WORKING_DIRECTORY`(100)、`SANDBOX_POLICY`(110)，与 cwd 信息相邻。这与核心服务 `working-directory`、`sandbox-policy` 注入运行时上下文的方式一致。
3. **模型工具**：以 registry 原生 raw JSON-Schema 形式手写 `ToolDefinition` 并 `ctx.tools.register(...)`（见下"为何不 import `@deepseek-ai/*`"）。

### 工具（对模型）

| 工具 | 作用 |
| --- | --- |
| `project_list` | 列出全部项目（置顶优先），含 id/name/primaryPath/secondaryPaths/pinned |
| `project_active` | 返回当前会话（按 cwd 派生）的活动项目，或 null |
| `project_create` | 创建项目：`name`、`primary_path`、可选 `secondary_paths[]` |
| `project_add_path` | 追加次要路径（拒绝与主路径重复；重复添加幂等） |
| `project_remove_path` | 移除次要路径 |
| `project_set_primary` | 把某路径提升为主路径，旧主路径降为次要路径 |
| `project_set_pinned` | 置顶/取消置顶 |
| `project_rename` | 改项目名（自由文本；**不改目录名**，也不动任何路径） |
| `project_delete` | 删除项目分组（不触碰磁盘文件） |

参数里的路径可传绝对路径或相对当前工作目录的路径（相对路径按会话 cwd 解析）。返回值为 JSON；可预期错误以 `{ code, message }` 返回（如 `project_not_found`、`already_primary`、`path_not_found`、`invalid_path`、`invalid_name`）。

## 为何不 import `@deepseek-ai/*`

profile 安装的 bundle 是一个被 link 到 `D:\WorkSpace\plugins\workspace-plus` 的目录；Node 对该目录内 `index.js` 的裸标识符解析只会向上走 `D:\WorkSpace\...`，**看不到** app.asar 内 Harness 安装的 `node_modules`。首版 `import { defineTool } from "@deepseek-ai/dsh-tools"` 因此激活失败（`ERR_MODULE_NOT_FOUND`）。故本插件：

- 只用 `node:` 内建模块；
- 不声明 `Config`（那会需要 `@deepseek-ai/schemastery`）；
- 工具定义按 `dsh-tools` 的 `ToolDefinition` **成品形状**手写（`parameters` 为 raw JSON-Schema：根 `{type:"object", properties, required[]}`，属性不再带 `required:true`；`output:{schema:{type:"object",additionalProperties:true}, render}`），直接 `ctx.tools.register`——这正是 `defineTool` 产出的形态，故无需引入它。

## 边界与限制（如实说明）

- **写入边界**：读取不受限；但在 `workspace-write` 文件策略下，DSH 的沙箱写边界是**会话的 `header.cwd`**（`sandboxPolicy.resolve().workspaceRoot`），次要路径在其外，默认**不可写**。本插件不改动核心沙箱策略；需要跨次要路径写入时，需 `danger-full-access` 策略或后续扩展沙箱根。系统提示文案已如实告知模型这一点。
- **活动项目是派生的**：不写会话状态，重启/回放均能复原；副作用是"改 cwd 才会换活动项目"。
- **无 UI（v1.0）**：v1.0 为 Host-only；v1.1 起有客户端 UI，见下节。
- **单文件存储**：并发写经串行链串行化；极小 JSON，同步载入 + 异步原子落盘。

## 客户端 UI（v1.1）

浏览器半在 `client.js`，由 `package.json` 的 `dsh.client`（`platform: "web"`）+ `exports["./client"]` 声明，随包发布。两个入口写同一份 Host 数据：

1. **工作区行的「⋯」菜单 → 工作区设置**（主入口）。浮层里改**工作区名称**与**支持的目录**（次要路径，可增删、可调原生目录选择器）。
2. **设置面板 → 工作区**（`settings.section`，order 920）。逐行列出全部工作区与"尚未归入任何工作区的项目"，可就地展开编辑。

两条入口都只写三样东西：原生工作区标题（侧栏显示名）、项目名（模型可见）、次要路径集合。**主路径的文件夹名永远不变**——`workspaceController.rename` 只 `setTitle`，Host 侧也从不 rename / 移动任何目录。

### 为什么菜单项是 DOM 注入

`sidebar.workspaces` 是 `single` slot 且被官方实现占据（`replaceRisk: "shadows-shipped-ui"`），替换它会顶掉整棵会话树；而官方**没有**给"工作区行的菜单项"留 slot（只有会话行的 `sidebar.workspaces.session.menu.item`）。所以这条菜单项只能走 DOM 增补：

- `document` 捕获阶段同时监听 `pointerdown` 与 `click`：最近祖先 `[data-row-key]` 的前缀是 `workspace:`、且点击目标在 `button` 内 → 记下 workspaceId 并武装观察者。加 `click` 是为了键盘（Enter/Space 只发 `click`，不发 `pointerdown`）；会话行是工作区行的后代，所以取**最近**祖先，避免命中会话菜单。
- 武装后 `MutationObserver` 常驻扫 `body` 的新增节点（未武装时每次变更只做一次 null 判断），向上找 `[role="menu"]`；只在"恰好 2 个 `button[role=menuitem]`"（原生 `重命名` / `删除`）时动手。
- **原生菜单每项自带一层 `div.itemWrap`**：`div[role="presentation"]` 下并排两个 wrapper，而不是两个平铺的 button。所以克隆的是整层 wrapper、插到"删除"那层之前。早先的实现直接拿第 1 项的 button 对第 2 项做 `insertBefore`，引用节点不在同一父节点下 → 抛 `NotFoundError`，且抛在 MutationObserver 回调里（静默）——这条结构现在由 `uitest.mjs` 钉死。
- 克隆项改文案、换成官方 `IconSettingsOutlineRegular` 的两条 path（沿用模板 svg 的 16×16 / `fill:none` / `stroke-width:1`，视觉上与原生菜单项同款，不外带异形图标）、清掉 `aria-haspopup` / `aria-expanded` / `aria-current`。点击时先派发一次合成 `Escape` 关掉原生菜单（官方 Menu 在 `document` 捕获阶段监听 Escape，只拦 IME 组合态，没有 `isTrusted` 检查），再打开浮层。
- 任何一步不满足即静默放弃：原生菜单保持原样，`settings.section` 页仍可用。注入项带 `data-wsplus-item` 标记，React 重渲染把它冲掉时观察者会补回来。

代价如实记录：菜单 DOM 由官方实现决定，官方改版后注入可能失效（失效不报错、也不破坏原生菜单）。这**不是**官方扩展点，是已知妥协。

重载兜底：新模块实例 `apply` 时接管 `window.__dshWorkspacePlusRowMenuHook` 这个哨兵，先删掉旧实例注入的节点，旧实例的监听器在下一次事件时自己摘掉——避免"条目还在、但连的是已销毁的 store"。

### 客户端 → 宿主

本地插件没有 `host.call`，故走同源 HTTP：

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/workspace-plus/list` | GET | `{projects, workspaces\|null, picker}`；`workspaces` 来自 `workspaceRegistry`，缺失时为 null |
| `/workspace-plus/workspace?workspaceId=` 或 `?projectId=` | GET | 单个目标 + 对应项目 |
| `/workspace-plus/save` | POST | `{workspaceId?\|projectId?\|path?, title?\|name?, secondaryPaths[]}`；先改原生标题再写项目，改标题失败即中止 |
| `/workspace-plus/pick` | POST | 调原生目录选择器；无选择器时 501 |
| `/workspace-plus/diag` | GET | 自检：路由是否注册、客户端 bundle 是否进了 boot graph、哪些 Host 服务可用 |

全部路由带同源闸门（拒 `sec-fetch-site: cross-site`；带 `Origin` 时须与 `Host` 同源）与 64 KiB 体积上限。UI 与模型工具复用同一批操作（`rename` / `setPaths` / `saveForPath`），不存在两套实现。

### 生效条件（重要）

Host 半与客户端 graph 都可以**不重启**换新：`plugin_manager` 对 entry 做一次 disable → enable（两侧都要 `changed: true`），Host 半会从磁盘重新 import，`clientModules` 也会重扫 client graph。已实测：一次 disable→enable 后 `/workspace-plus/diag` 从 404 变 200、五条路由全 `ok: true`，graph 里出现 `@local/workspace-plus` 且 `clientError: null`。

**但已经打开的页面不会自己长出新行。** 页面的 `__DSH_BOOT__`（含 client graph 的 entry 列表）是在 HTML 渲染时注入的，`clientModules.onGraphChanged` 只是 Host 侧的拉模型监听、没有 SSE/WS 推送通道，所以新 entry 只能靠**重载一次页面**进到页面里。顺序是：改代码 → disable→enable（或重启）→ **刷新页面**。只刷新不重扫 graph，或只重扫不刷新，都会看到"改了却没有任何变化"。

按这个顺序验（前两条不通过就说明 Host 半没起来，后面的 UI 一律免谈）：

1. `node plugins/workspace-plus/_tmp/livegate.mjs` → `LIVE GATE: 21 passed, 0 failed`。它直连**正在跑的** Host，逐条核对：控制路由可达、五条路由注册、三个服务可取、graph 里有本 entry、**bundle 在 graph 自己公布的那个 URL 上真的 200**、`/list` 有真实工作区、改名落到 registry 而文件夹不动（测完自动还原）、支持目录增删可持久化。端口默认 `127.0.0.1:7039`，可 `node _tmp/livegate.mjs http://127.0.0.1:<port>` 覆盖。
2. 注意 bundle 只能从 **combo URL** 取：`/plugins/??@local/workspace-plus/client.js&rev=<entryRev>`。单包路径 `/plugins/@local/workspace-plus/client.js` 合法地 404，拿它当探针会得出完全错误的结论；graph 公布的 URL 从 `/workspace-plus/diag` 的 `clientEntry.url` 读。
3. 设置面板出现「工作区」一节，逐行列出工作区。
4. 鼠标点某工作区行的「⋯」→ 菜单里三项：重命名 / **工作区设置** / 删除工作区；键盘（Tab 到按钮后 Enter）打开也应有第三项。
5. 点「工作区设置」→ 浮层显示主路径、名称、支持目录；改名称保存后**侧边栏标题变了、文件夹名没变**（用资源管理器核对），支持目录增删后 `project_list` 能看到。
6. 再点一次「⋯」确认菜单没被残留状态弄脏（原生两项行为不变）。

## 自测

```bash
node plugins/workspace-plus/selftest.mjs        # 46 项：增删改查/派生/落库/系统提示/改名的自由文本语义/五个 HTTP 路由
node plugins/workspace-plus/uitest.mjs          # 12 项：侧栏菜单注入（离线 DOM 夹具）
node plugins/workspace-plus/_tmp/domtest.mjs    # 28 项：真实 Chromium 里的整条链路
WS_PLUS_LIVE=1 node plugins/workspace-plus/_tmp/domtest.mjs   # 同上，但跑 Host 真正服务出去的那份字节
node plugins/workspace-plus/_tmp/livegate.mjs   # 21 项：直连正在跑的 Host（写操作会自动还原）
```

`selftest.mjs` 以 mock `ctx` 驱动 `apply` 注册的工具、上下文与路由，指向临时 `$DSH_HOME`，不碰真实数据。路由部分用 mock `req`/`res` 真跑 handler（含跨站拒绝、405、坏 JSON、无选择器降级）。

`uitest.mjs` 用一份最小 DOM 复刻官方菜单的真实结构（`div[role=menu]` → `div[role=presentation]` → 两个 `div.itemWrap > button[role=menuitem]`），按浏览器的 `__ModuleLoader__.load` 方式载入 `client.js`，断言：不抛异常、插在"重命名"和"删除"之间、克隆项是整层 wrapper、文案/图标/aria 都换对、重复注入是空操作、非工作区菜单不动、点击会关原生菜单并按 workspaceId 打开浮层。其中一条专门断言夹具会拒掉旧写法（`insertBefore` 引用非同一父节点 → `NotFoundError`），把 B1 这类静默失败钉在测试里。

`_tmp/domtest.mjs` 把同一件事搬进**真实 Chromium**（Playwright，headless，零窗口、不联网）：真 UMD React 18 + 真官方菜单的 DOM 契约，断言菜单项落在 index 1 / 共 3 项、图标换成 16×16 描边齿轮、浮层被 portal 到 `<body>` 且压住 `z-index:71` 的抽屉侧栏（`elementFromPoint` 实证）、`aria-modal`、名称预填、`GET /workspace-plus/workspace`、Esc 关闭、零 page/console error。加 `WS_PLUS_LIVE=1` 时**不再读本地文件**，而是先查 `/workspace-plus/diag` 拿到 graph 公布的 combo URL、把那份字节抓下来注入页面——这样就闭合了"本地文件能跑 ≠ 服务出去的字节能跑"这个缺口，也顺带证明 graph 里那一行是真的能用的。

`_tmp/livegate.mjs` 是唯一碰真实数据的套件：它对运行中的 Host 做一次改名 + 一次支持目录增删，逐条核对"标题变了、路径没变、文件夹还在"，然后**无条件还原**原值（`finally` 里还原，中途断言失败也会还原）。它验的是组合与装配，不是源码，所以改完代码后先跑它，再去点 UI。

## DSH 沙盒端到端测试（真实运行时）

用真实 `dsh` CLI（`resources\runtime\cli\bin\dsh.cmd`）建一个**隔离的 headless 沙盒 profile**，把插件装进去，确认它在最小化、受限（`sandbox-policy = workspace-write`）的组合里正常组合与执行：

```bash
DSH="$LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
# 1) 建隔离沙盒 profile（headless 模板），并确认插件已组合进去
"$DSH" wspsandbox --from-default-profile headless --dump-config   # 见 "# == @local/workspace-plus"
# 2) 把插件加入沙盒 profile
"$DSH" plugin --profile wspsandbox add D:/WorkSpace/plugins/workspace-plus
# 3) 逻辑自测（用 dsh 自带 node，隔离 home）
"$LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/bin/node" \
  D:/WorkSpace/plugins/workspace-plus/selftest.mjs
```

- 组合验证：`--dump-config` 显示 `workspace-plus` 行进入 `wspsandbox` 树。
- 真实执行：headless 模板禁用了账号/凭据，需模型密钥才能跑 agent；因此在**已登录的 live 组合**里起一个真实 subagent（持有 `project_*` 工具）、cwd 指向隔离沙盒工作区，跑完整 create→active→list→add→(错误用例)→set_primary→active→remove→delete→list  round-trip。实测 **10/10 PASS**，且全程不改磁盘文件、实时落库到 `~/.dsh/workspace-plus/projects.json`（测后该项目已删除，存储为空）。
- 复用/清理：`wspsandbox` 是可复用的 WorkSpacePlus 沙盒；删除它 = 删 `%USERPROFILE%\.dsh\profiles\wspsandbox` 目录。

> 注意：本机另有一个用户自建的 `sandbox` profile（device-mesh 执行器模式，insidegate/step-5-preview），与 WorkSpacePlus 无关，请勿混用或删除。

## 安装 / 卸载

**当前发布源（release source）= GitHub 仓库**，已从本地 `link:` 切换为 git 源并装入本机 DSH（desktop profile）：

- 仓库：https://github.com/Xraytest/dsh-workspace-plus （**private**，MIT）
- profile 依赖记录：`"@local/workspace-plus": "git+https://github.com/Xraytest/dsh-workspace-plus.git"`
- 安装产物：`~/.dsh/profiles/desktop/node_modules/@local/workspace-plus`（git 检出副本，非 junction）

发布/更新流程（开发副本 `D:\WorkSpace\plugins\workspace-plus` 即 git 工作区）：

```bash
# 1) 本地改动 → 提交并推送（必要时先升 package.json 版本号）
git -C "D:/WorkSpace/plugins/workspace-plus" add -A
git -C "D:/WorkSpace/plugins/workspace-plus" commit -m "..."
git -C "D:/WorkSpace/plugins/workspace-plus" push

# 2) 让本机 DSH 从 git 源重装（remove→install 才会加载新模块代）
#    经 plugin_manager：remove_bundle @local/workspace-plus → install_bundle github:Xraytest/dsh-workspace-plus
```

- `dsh-plugin-autoupdate` 会把该 bundle 识别为 **git 源**（显示远端 HEAD；git 源默认只报告、手动单个「更新」）。
- 若重装报 `ERR_PNPM_EPERM ... rename ... -> node_modules\@local\workspace-plus`：是先存留的 `link:` junction 挡住了 rename，先 `cmd /c rmdir "%DSH_PROFILE_DIR%\node_modules\@local\workspace-plus"` 删掉这个 junction（不动源目录）再装。
- github.com 在本机可能间歇性 `Connection was reset`；`git ls-remote` 重试即可，`gh auth setup-git` 已把 gh 凭据配给 git（私有仓库可克隆）。

**离线热补丁（临时手段）**：安装产物是 git 检出副本，不是 junction。GitHub 不可达时，可以先把开发副本的 `index.js` / `client.js` / `package.json` 直接覆盖进 `~/.dsh/profiles/desktop/node_modules/@local/workspace-plus/`，重启应用即可生效；但这只是本机补丁——**任何 `pnpm install`（包括 `plugin_manager` 装/卸别的 bundle）都会把它覆盖回 git 提交**，正式发布仍须推送到仓库再重装。

卸载：`plugin_manager remove_bundle @local/workspace-plus`。
