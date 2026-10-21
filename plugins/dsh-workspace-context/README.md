# dsh-workspace-context —— 工作区常驻上下文

给**每个工作区**一份长期提示词：它常驻在该工作区会话的 system prompt 装配里，
每个请求都在场。**人可以直接编辑磁盘文件或走设置页，模型可以用工具改。**

## 它解决什么

出厂的 `AGENTS.md`/`CLAUDE.md`（`dsh-agent-instructions`）把工作区指令**作为一条
durable 用户消息**注入，且文件必须落在仓库里。本插件补的是另一半：

| | AGENTS.md（出厂） | dsh-workspace-context（本插件） |
|---|---|---|
| 落盘 | 仓库内（会进 git） | `$DSH_HOME/workspace-context/`（本机私有，不进仓库） |
| 注入 | 一次性 durable 用户消息，压实后可能被摘要遮蔽 | **每个请求的 system prompt 装配**，不受压实影响 |
| 生效 | 下一次 `read/write/edit` 触碰或恢复会话时 | 改文件约 **1 秒内**、下一次请求即生效 |
| 修改 | 人工 | 人工（文件 / 设置页）+ **模型工具** |
| 生效范围 | 项目链（根→cwd） | 精确命中会话 cwd，可选继承最近祖先工作区 |

两者不冲突：AGENTS.md 管「仓库级规范」，本插件管「这台机器上这个工作区的长期准则」。

## 存储：一工作区一文件，绑定写在文件头

```
$DSH_HOME/workspace-context/
  contexts/
    root-nas-ArkTower--563967fe.md      ← 可读 slug + 路径 sha1 前 8 位
    stronghold--a1b2c3d4.md
  trash/                                 ← 「回收站」动作移进来的文件（从不硬删）
```

文件格式（头部是权威绑定，**不进模型上下文**）：

```markdown
<!-- dsh-workspace-context
workspace: /root/nas/ArkTower
title: ArkTower
enabled: true
updated: 2026-10-09T09:02:11.000Z
by: tool
-->

正文从这里开始——原样注入。
```

- **单一事实源**：绑定与正文在同一个文件里，没有 index.json 与正文互相背离的可能。
- **人是第一公民**：`vim` 改正文（甚至手写整个文件）都会被热读；改头部即改绑定。
- **不猜不删**：头缺失/写坏/重复绑定的文件进「未绑定文件」列表（正文不会注入），
  由设置页或工具显式 `bind` 收编；删除永远是「移入 trash/」。

## 三个入口

1. **模型工具 `workspace_context`**
   `list` / `read` / `write` / `append` / `clear` / `set_enabled`；不传 `path` 时
   默认作用于**本会话自己的工作目录**。工具注册在 host `tools` 注册表上，
   所以**与本会话跑哪个 agent 预设无关**（除非某 scope 用 `tools.restrict` 挡掉）。
   只有 `list`/`read` 是只读的；`clear` 清空正文但保留条目（不删文件）。
2. **设置页「工作区常驻上下文」**（order 20）
   工作区清单（已配置 + 来自 workspaceRegistry / 见过的会话 cwd 的已知工作区）、
   正文编辑器（防抖 1200ms 自动保存 + 保存按钮 + Ctrl/Cmd+S）、启用位、回收站、
   未绑定文件收编、以及诊断（装配/注入/跳过计数、最近一次注入的工作区与字节数）。
3. **直接编辑磁盘文件**：设置页会把每条的文件路径显示出来；改完约 1 秒内热生效。

## 注入语义

- **时机**：`system-prompt/assemble` 瀑布（`{prepend:true}`），装配期直插 section
  `workspace:context`，位置紧跟 `deployment:persona-prefix`（没有人设段则插在第一个
  `tool:` 段之前）。不走会话日志，因此不产生可见消息、不受压实摘要影响。
- **命中**：按 `session.header.cwd` 精确匹配条目（realpath 口径）；未命中且
  `inheritFromAncestor: true` 时取**最近的祖先工作区**条目（例：会话开在
  `ark-tower/` 时继承仓库根 `/root/nas/ArkTower` 的条目）。
  子代理会话继承父会话 cwd，因此同样命中。
- **定位**：外框前的固定话术写明这是工作区负责人维护的长期准则、**不覆盖 system /
  developer / 用户的直接指令**。
- **两个必须保留的防护**（改代码时别拆）：
  1. 正文里的 `{{…}}` 会被出厂 `renderPrompt` 的**严格**插值处理——未知或畸形引用
     直接 throw，等于让用户正文里一句 `{{name}}` 打挂该工作区的每个请求。
     `store.js` 的 `neutralizeTemplateRefs` 在注入前把 `{{` 拆开（中间插 U+200B，
     模型侧不可见）；`selftest.mjs` 用真实 `renderPrompt` 交叉验证这一点。
  2. 正文里的 `</workspace-context>` 会被转义，免得正文提前闭合本插件的外框。
- **字节上限**：`maxBytes`（缺省 32768）约束**整段注入文本**；超限按 UTF-8 字符边界
  截断并附可见提示（提示本身也计入预算）。

## 配置

```yaml
- insert:
    - id: workspace-context
      name: ./plugins/dsh-workspace-context/index.js
      config:
        ttlMs: 1000               # 外部改文件后多久内被读到
        maxBytes: 32768           # 单条注入字节上限
        inheritFromAncestor: true # cwd 未精确命中时继承最近祖先条目
        # dir: /path/to/other     # 可选：换存储根（缺省 $DSH_HOME/workspace-context）
        # enabled: false          # 可选：整体停用注入（工具与设置页仍在）
        # sectionName: workspace:context
```

## 浏览器 API（同源守卫；静态插件没有动态包的 host.call）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-workspace-context/state[?cwd=…]` | 全量状态（条目含正文）+ 命中回显 + 诊断 + 工作区清单 |
| POST | `/dsh-workspace-context/save` | `{path, text, title?, enabled?, cwd?}` 写入（`updatedBy: human`） |
| POST | `/dsh-workspace-context/enabled` | `{path, enabled}` 只改启用位 |
| POST | `/dsh-workspace-context/bind` | `{file, path, title?, overwrite?}` 收编未绑定文件 |
| POST | `/dsh-workspace-context/trash` | `{path}` 移入回收站（回显 `trashed` 路径） |
| POST | `/dsh-workspace-context/reload` | 强制重扫（清缓存） |

跨域一律 403；非 JSON body 400；方法不符 405。

**守卫口径（比多数同族插件更严，2026-10-09 收紧）**：`sec-fetch-site: cross-site` 一律拒；
带 `Origin` 时必须与 `Host` 同源；**`Origin: null` 按跨站拒**（沙箱 iframe / `data:` /
`file:` 页面正是发 `null` 的那一类）；无 `Origin` 头（本机 curl、CLI、同源 GET 导航）放行。
理由：本插件的写路由会把正文写进**系统提示词**，等价于一条可持久的 prompt 注入面——
不能沿用「读者拿不到响应」的兜底假设。（`dsh-ultracode` 那版守卫放行 `null`，此处刻意不照抄。）

## 自测

```bash
node plugins/dsh-workspace-context/selftest.mjs          # host：146 项
node plugins/dsh-workspace-context/client-selftest.mjs   # 浏览器半边：69 项
```

host 自测含与出厂 `@deepseek-ai/dsh-system-prompt` 的**交叉验证**：先证明未中和的
`{{name}}` 确实会让 `renderPrompt` 抛错，再证明中和后的注入文本能安全装配。
浏览器自测自带极小 hooks 运行时（带依赖比较），因此真的会重渲染并驱动
保存/停用/收编/错误路径，而不是只断言树的形状。

## 活体验收记录（2026-10-09，NasHost 上的运行实例）

| 断言 | 怎么验的 | 结果 |
|---|---|---|
| 装配期注入真的发生 | `GET /state` 的 `diag`：`assemblies` / `injected` / `lastInjection`（`via: exact`） | ✅ 逐次递增，`injectedAt` 指向真实会话 |
| 新会话真的看到正文 | 另起一个子代理会话，让它复述上下文里的 nonce 与花括号探针 | ✅ 原样复述 `ARKWCTX-NONCE-7F3A9C21` 与字面 `{{…}}` |
| 用户自己也能看到 | 本会话的系统提示里出现完整 `<workspace-context …>` 段（含随后人手追加的那一行） | ✅ 自我观察 |
| 手改文件热生效 | 直接 `printf >> <contexts/*.md>`，约 1s 后 `/state` 的 `revision`/`textBytes` 变化，且该行出现在下一轮系统提示 | ✅ |
| 祖先继承 | `GET /state?cwd=/root/nas/ArkTower/ark-tower`（未配条目） | ✅ `via: ancestor` 指回仓库根条目 |
| 模型工具可用（跨预设） | 本会话与子代理会话的工具表里都有 `workspace_context`；`read` / `list` 实调 | ✅ |
| 工具规范值 lossless | 实调 `read` 时曾报 `INVALID_TOOL_OUTPUT: value is not lossless JSON`（`inheritedFrom: undefined`）→ 修 → 复验 | ✅ 修复后 `read` 正常 |
| 花括号不炸装配 | 正文里故意留 `{{this_would_throw_without_escape}}`，注入照常、模型看到字面花括号 | ✅ 中和在真实 `renderPrompt` 上成立 |
| 写路由守卫 | 裸 `Origin: null` / `sec-fetch-site: cross-site` / 跨站 `Origin` 各打一次 `/state` 与 `/save` | ✅ 均 403；无 `Origin` 的 curl 200 |
| 浏览器半边真的下发 | 取认证后的启动载荷：`{"id":"dsh-workspace-context","url":"/plugins/??dsh-workspace-context/client.js&rev=…","inject":[…]}`，再取该 URL | ✅ 200 / 24 KB / 含 `settings.section` 与页面类名 |

## 维护

- **本 profile 未开模块热载**，loader 按 specifier 缓存模块：改实现后要让运行实例
  生效，需改 `entry-vN.js` 里的缓存标记（`export * from './index.js?v=…'`）或新写
  `entry-v<N+1>.js`，并把 `cordis.patch.yml` 里该行的 `name` 指过去（**保持同一行
  id**，走 dispose→start）；只改 `config` 也是安全的。
- **`?query` 只能写在模块源码里，不能写在 patch 行的 `name` 里**：loader 对行名做
  `pathToFileURL(resolve(base, name))`，`?` 会被百分号编码成 `%3F`（本部署实测口径）。
  所以「换缓存标记」这一招只对 `entry-vN.js` 内部的再导出有效。
- `client.js` 由 `dsh-client-modules` 组合、`dsh-client-hmr` 每 500ms stat-poll 就地
  热换，刷新页面即见；新增 / 改动 `dsh.client` 声明后需让浏览器重新拉一次。
- **不发布任何服务**（只消费 host 的 `tools` / `webServer` / `workspaceRegistry`），
  故不需要 isolate realm，可以安全地待在 profile patch 的根列表里。
- **加行有整层回滚风险**：loader 的 `EntryGroup.update` 是「先 create 全部新 entry、
  成功后再 remove 旧的」，同层任何一行 apply 失败都会回滚整层。本行只注册路由与工具、
  不注册全局唯一资源，重挂是安全的；但改这一层时仍建议一次只动一行并立刻回读核验。
- 诊断第一现场：`curl -s '127.0.0.1:3080/dsh-workspace-context/state?cwd=<工作区>'`
  看 `diag`（`assemblies` / `injected` / `skipped.{noSession,noEntry,disabled,empty}` /
  `lastInjection` / `lastSkip`）。浏览器半边需要认证（`dsh web` 打印的 `?token=…`）。

## 已知边界

- **会话 cwd 必须存在**：`session.header.cwd` 指向的目录被移动/删除时 realpath 失败，
  该会话命中不到条目（不猜测、不降级到模糊匹配）。
- **不做模糊匹配**：只认 realpath 字符串相等或祖先关系；符号链接指向同一目录即同一条目。
- **不使用 workspaceRegistry 的 id 作为键**：键是规范路径（人的直觉单位），registry
  只用来给设置页补充显示名与候选工作区清单；不写 `$DSH_HOME/storages/workspace.json`
  （那是 WorkspaceRegistry 自己的域，启动时会做一致性校验）。
- **正文是逐字注入的指令文本**：`write` 会把正文放进 system prompt，因此与 `AGENTS.md`
  同级可信——不要把不可信来源的内容直接写进去；设置页与工具都不做「语义审查」。
- **`complete` 段会盖掉注入**：若某个 scope 注册了 `complete: true` 的 section，出厂会
  在瀑布之后用它恢复整段系统提示，本插件的 section 会被丢弃（不报错、只是不生效）。
  本部署当前没有 complete 段。
- **`read` 回显不截断**：工具会把文件全文交给模型，超过出厂 spill 阈值（本部署
  `maxInlineBytes: 50000`）时由 `dsh-spill-policy` 落盘给指针；`maxBytes` 只约束
  **注入**（超限截断并附提示），不约束 `read` 的回显。
- **存储不被 git 管**：文件在 `$DSH_HOME` 下，不进仓库，也没有历史版本；误删靠
  `trash/` 捞回（回收站只增不自动清理，需要时人工清）。