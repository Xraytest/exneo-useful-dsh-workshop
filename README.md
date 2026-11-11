# exneo-useful-dsh-workshop

[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）插件市场：把自研/整理的插件打包成符合 DSH bundle 规范的 Cordis 插件包。每个包自带 `cordis.patch.yml` 与 `dsh.bundle` 声明，可用插件管理器按本地路径安装，装好后在 Web UI 设置页/侧边栏出现入口。

## 市场源

DSH Desktop 设置 → 插件市场 → 添加数据源，粘贴官方市场索引（format 1，`@deepseek-ai/dsh-plugin-market` 校验）：

```
https://raw.githubusercontent.com/Xraytest/exneo-useful-dsh-workshop/main/dsh-index.json
```

> **仓库当前为 private**：`git clone` 与 `raw.githubusercontent.com` 匿名拉取都要自带 token —— 市场能读到元数据，但**匿名安装会在拉取源码时失败**。要让市场真正对外可用，先把仓库转成 public。
>
> Cloudflare Pages 那套源是**独立部署、匿名可读**的，内容与本仓库同一次构建逐字节一致：`https://exneo-useful-dsh-workshop.pages.dev/marketplace.json`（format 1 索引）、`/dsh-index.json`（DSH Desktop 市场源）、`/index-source.json` + `/v1/plugins`（dsh-community-market 源）。

- 索引托管在 Cloudflare Pages（直传项目，无 Git 集成）：`wrangler pages deploy <目录> --project-name exneo-useful-dsh-workshop --branch main`，需要带 `pages:write` 的凭据。该站点只发 JSON，访问根路径返回 404 属正常。
- 条目本身走 GitHub 安装（pinned commit + 子目录），不发 npm。
- 刷新顺序：改插件 → 推送到本仓库 → 重新生成 `marketplace.json` / `dsh-index.json` / `v1/plugins` 三个索引（`index-source.json` 与 `_headers` 通常不动）→ 一起 `wrangler pages deploy`，新版本才会进市场。索引生成脚本不进仓库，按 `dsh-index.json` 的 format 1 结构自行生成。
- 另部署有一套 [dsh-community-market](https://github.com/anywhere-labs/dsh-desktop) 标准源：manifest [`index-source.json`](index-source.json) + 目录端点 [`v1/plugins`](v1/plugins)，[`_headers`](_headers) 为两者固定 `application/json`。

## 环境要求

- DSH `>= 0.2.0-rc.1`（开发基于 `0.2.0-rc.2`）
- Node.js `>= 22`
- pnpm（DSH profile 自带）

## 安装

```bash
git clone https://github.com/Xraytest/exneo-useful-dsh-workshop.git
cd exneo-useful-dsh-workshop
```

**插件管理器（推荐）**：Web 侧边栏「插件」页或 `plugin_manager` 的 `install_bundle`，传插件绝对路径：

```
/绝对路径/exneo-useful-dsh-workshop/plugins/dsh-device-mesh
```

管理器会校验 bundle 声明 → `pnpm add` → 写入 `dsh.profile.bundles` → 应用补丁，失败自动回滚。

**手工安装**：

```bash
dsh plugin --profile <profile> add ./plugins/dsh-image-unload
# 再把包名加入 profile package.json 的 dsh.profile.bundles
dsh plugin --profile <profile> install
```

**移除**：`remove_bundle`，或从 `dsh.profile.bundles` 删掉包名后重装。

> **`link:` 与 `file:` 的区别（跨设备同步必读）**：`link:<目录>` 是符号链接，改源目录即刻生效；`file:<目录>` pnpm 会在 profile 的 `node_modules/` 里放**独立副本**——只改源目录不生效，必须两处都改或重装。eac-design-world 这类带大体积素材的插件尤其容易踩到（实测：改 vendor 无效果，postinstall 是在 node_modules 副本里跑的）。多设备同步时优先 `link:`。

> **rowId 冲突**：loader 按行 id 去重。若 profile 的 `cordis.patch.yml` 已有同 rowId 的手工行（如旧文档里的 `./plugins/xxx/index.js`），先删除，否则报 `duplicate loader entry id`。各插件 rowId 见 [marketplace.json](marketplace.json)。

## 插件一览

市场源现收录 36 个插件（`plugins/` 下另有 `dsh-ofm-compat` 宿主垫片，随 `dsh-our-free-model` 一起加载，不单独安装）：

| 插件 | rowId | 分类 | 说明 |
|---|---|---|---|
| [eac-design-world](plugins/eac-design-world) | `eac-design-world` | 创作 | EAC design world：本地视频制作与设计工作室（录制/时间线/配音字幕/渲染质检/设计成品）。**AGPL-3.0-or-later**，Ebony-Vinyl/EAC-design-world 的本地修改版，出处见 [MARKETPLACE-PROVENANCE.md](plugins/eac-design-world/MARKETPLACE-PROVENANCE.md) |
| [dsh-admin-channel](plugins/dsh-admin-channel) | `admin-channel` | 工具 | 会话级管理员权限通道：工作箱开关（一次 UAC）后，本会话的提权命令交给常驻提权进程执行，不再逐次确认 |
| [dsh-archived-sessions](plugins/dsh-archived-sessions) | `archived-sessions` | 会话 | 恢复被归档隐藏的会话（出厂只归档、不提供恢复） |
| [dsh-bilibili](plugins/dsh-bilibili) | `bilibili-tools` | 工具 | Bilibili 搜索与读取：搜视频/专栏、读完整视频信息（简介/标签/分P）、读专栏正文（Quill Delta → 文本/Markdown）、读评论；自带 WBI 签名与 buvid 引导 |
| [dsh-cordis-define-schema-fix](plugins/dsh-schema-fix) | `cordis-define-schema-fix` | 工具 | 扁平化 oneOf 工具参数，让转换器交出嵌套对象而非字符串 |
| [dsh-device-mesh](plugins/dsh-device-mesh) | `device-mesh` | 多设备 | 多台 DSH 互接（令牌 + HMAC 签名），会话按设备→工作区→会话汇总，支持工作区多路径与跨设备执行 |
| [dsh-dual-agent](plugins/dsh-dual-agent) | `dual-agent` | 模型 | 双主智能：主上下文当挑刺者、执行者作真 subagent 干活，任务期间主上下文静默，结算后只注入一条「报告+评估」 |
| [dsh-free-search](plugins/dsh-free-search) | `web-search-free` | 工具 | 免费网页搜索：多引擎并行 + 智能路由 + 多源合并去重 + 时间过滤 + 页面全文抓取，免 API Key。**MIT**，上游 DDDMUC/dsh-free-search 的镜像收录，差异见 [UPSTREAM.md](plugins/dsh-free-search/UPSTREAM.md) |
| [dsh-image-unload](plugins/dsh-image-unload) | `image-unload` | 工具 | `unload_images`：把图片从后续模型请求中卸下，省上下文 |
| [dsh-message-branches](plugins/dsh-message-branches) | `message-branches` | 会话 | 消息分支：同一条消息的多个版本，不新建会话，用导航条切换 |
| [dsh-mobile-fullscreen](plugins/dsh-mobile-fullscreen) | `mobile-fullscreen` | 界面 | 移动端全屏按钮：侧边栏 lanmode 二维码按钮右侧的全屏切换（仅窄屏触摸设备） |
| [dsh-model-capabilities](plugins/dsh-model-capabilities) | `model-capabilities` | 模型 | 按模型配置输入模态与思考强度（关/低/高/最大），写入 llm-pi-ai 渠道设置 |
| [dsh-model-groups](plugins/dsh-model-groups) | `model-groups` | 模型 | 把 (provider, model) 编成命名分组，跨供应商可用，供统计与重试消费 |
| [dsh-model-pool](plugins/dsh-model-pool) | `model-pool` | 模型 | 会话级模型供应池：按会话启停、调整用量上限与重置计数，SessionId 隔离 |
| [dsh-model-retry](plugins/dsh-model-retry) | `model-retry` | 模型 | 按 provider:model 配置重试次数、状态码、失败类别与退避，落盘热生效 |
| [dsh-ms-multimodal-retry](plugins/dsh-ms-multimodal-retry) | `ms-multimodal-retry-v1` | 模型 | ModelScope 多模态下载超时时丢弃最早一张图后重试 |
| [dsh-our-free-model](plugins/dsh-our-free-model) | `our-free-model` | 模型 | Our Free Model：装上即用前沿模型（免登录/免 key），带账号池、积分领取、本地 OpenAI 网关与局域网转发、数据看板，六页毛玻璃界面 |
| [dsh-plugin-autoupdate](plugins/dsh-plugin-autoupdate) | `plugin-autoupdate` | 工具 | 插件源自动更新：定时对比源版本，经 pluginManager 更新，设置页可视化管理 |
| [dsh-provider-alias](plugins/dsh-provider-alias) | `provider-alias` | 模型 | 自定义模型供应商：声明 endpoint / 协议 / 模型 / 自有 Key，并按协议配各自的端点路径（内置 opencode-go 的 per-request session header 规格） |
| [dsh-safefull](plugins/dsh-safefull) | `safefull-audit` | 安全 | 完整权限 + 每次工具调用先过静态安全审计（deny 硬拒，ask 视为拒绝） |
| [dsh-session-done-notify](plugins/dsh-session-done-notify) | `session-done-notify` | 通知 | 回合完成时弹系统通知（Windows / Android） |
| [dsh-session-import](plugins/dsh-session-import) | `session-import` | 会话 | 把 /export 的会话 ZIP 导回本机库，可选归属工作区（含新建） |
| [dsh-session-orb](plugins/dsh-session-orb) | `session-orb` | 界面 | 会话悬浮球：可拖动的半透明黑球，任何会话跑完在球上方弹出会话名，点一下跳回；透明度/尺寸/停留时长在设置页调 |
| [dsh-session-title-context](plugins/dsh-session-title-context) | `session-title-context` | 模型 | 用完整上下文（去图片）生成会话标题，兼容推理模型与 /title 指定模型 |
| [dsh-settings-nav](plugins/dsh-settings-nav) | `settings-nav` | 界面 | 设置项分组收纳（可折叠、嵌套 5 层）、自由排序，热生效 |
| [dsh-subagent-models](plugins/dsh-subagent-models) | `subagent-models` | 模型 | 会话级子代理模型链：多模型排序、逐模型限额，耗尽或失败自动回退 |
| [dsh-ultracode](plugins/dsh-ultracode) | `ultracode` | 界面 | 还原 Claude Code 的 ultracode 思考强度，会话开关开启即注入对应提示段 |
| [dsh-usage-stats](plugins/dsh-usage-stats) | `usage-stats` | 统计 | 按模型（区分供应商）/供应商/分组/会话/日/周统计 token 与平均速率（TTFT / TPS），可从历史日志与导出 ZIP 回填 |
| [dsh-user-keep-compaction](plugins/dsh-user-keep-compaction) | `user-keep-compaction` | 界面 | 压缩时 user 消息逐字保留，只摘要其间的助手/工具内容 |
| [dsh-workbench](plugins/dsh-workbench) | `workbench` | 界面 | 输入框工具行「工作箱」：勾选才注入对应上下文（Ultracode / REA），未选零注入 |
| [dsh-workspace-context](plugins/dsh-workspace-context) | `workspace-context` | 工作区 | 每个工作区一份常驻提示词，注入该工作区会话的 system prompt，可读写 |
| [dsh-workspace-plugins](plugins/dsh-workspace-plugins) | `workspace-plugins` | 工作区 | 按工作区挂载普通 Cordis 插件，仅该工作区会话生效，会话结束卸载 |
| [prts-omni-bridge](plugins/prts-omni-bridge) | `prts-omni-bridge` | 多设备 | 让 PRTS Omni Android 客户端经带令牌校验的本机 HTTP + WebSocket 桥接访问 DSH 的会话、智能体与工具，并注册工具 `prts_omni` |
| [@dsh-external/dsh-blender-plugin](plugins/dsh-blender-plugin) | `dsh-blender-plugin` | 创作 | DSH × Blender 直连：15 个模型工具 + 34 family / 228 op 契约层（视口/持久内核/无头会话/作业/事务/装配/白模/QC/导出）。**BSD-3-Clause**，上游 sixtysevenlf/dsh-blender-plugin 的本地修改版，出处见 [UPSTREAM.md](plugins/dsh-blender-plugin/UPSTREAM.md) |
| [@local/rea-mcp](plugins/rea-mcp) | `rea-mcp` | 工具 | REA 自包含接入：MCP 桥 + 设置页工具选择器 + 工作箱直连路由 |
| [@local/workspace-plus](plugins/workspace-plus) | `workspace-plus` | 工作区 | 把工作区当项目：一个主路径 + 多个次要路径，活动项目的完整路径集合注入会话上下文让模型跨目录读写；配项目工具与侧边栏/设置页面板 |

## 目录结构

```
exneo-useful-dsh-workshop/
├── marketplace.json          # 机器可读索引（元数据、rowId、分类、依赖）
├── dsh-index.json            # 官方市场数据源（format 1）
├── index-source.json         # community-market 源 manifest
├── v1/plugins                # community-market 目录端点
├── _headers                  # JSON Content-Type 配置
├── README.md
├── LICENSE                   # 仓库整体 LGPL-3.0（插件各自另有许可，见「许可」）
├── packs/                    # 非 DSH bundle 的收录物（ZCode 插件包等）
│   └── ultracode-pack/       #   ultracode 新版实现（skills+commands+bash 状态机）
└── plugins/
    ├── dsh-archived-sessions/    # 每个插件 = 一个独立可安装 bundle
    │   ├── package.json          #   dsh.bundle.patch + dsh.client 声明
    │   ├── cordis.patch.yml      #   bundle 补丁（insert 行，name = 包名）
    │   ├── index.js              #   host 半边入口
    │   ├── client.js             #   浏览器半边（可选）
    │   └── ...
    └── ...（共 37 个目录：36 个市场条目 + 1 个 ofm 宿主垫片）
```

## ultracode 的新版实现

[packs/ultracode-pack](packs/ultracode-pack) 是 ultracode 的**新版实现**（ZCode /
Claude Code 插件包形态：`skills/` + `commands/` + 纯 bash 状态机，逆向自
claude-code 2.1.286），比 [plugins/dsh-ultracode](plugins/dsh-ultracode)（DSH
bundle、提示词注入形态，逆向自 2.1.287）更完整。它不是 DSH Cordis bundle，因此
不进入 `dsh-index.json` 安装索引，按 `packs/ultracode-pack/REPO-NOTE.md` 的说明
在 ZCode 侧使用。

## 开发与自测

```bash
cd plugins/dsh-device-mesh && node selftest.mjs   # 116 项
cd plugins/dsh-settings-nav && node selftest.mjs  # 222 项
cd plugins/dsh-usage-stats && node selftest.mjs   # 57 项（--quick 抽样；C 段 zip 需 python3）
```

各插件 README 记录了设计动机、边界与维护约定（热挂入口的 `entry-vN.js` 只是 specifier 别名，实现始终在 `index.js`）。

## 外部推荐（不在本仓库）

| 插件 | 来源 | 说明 |
|---|---|---|
| `@goodandready/dsh-lanmode` | npm | 局域网/反向代理访问 DSH Web UI |

```bash
dsh plugin --profile <profile> add @goodandready/dsh-lanmode
```

## 许可

仓库整体 **LGPL-3.0**（全文见 [LICENSE](LICENSE)），插件署名 **ExNeo**。

各插件按自己 `package.json` 的 `license` 授权，`marketplace.json` / `v1/plugins` 逐条记录：

- 多数自研插件为 **MIT**；
- `@dsh-external/dsh-blender-plugin` 为上游 **BSD-3-Clause**（[sixtysevenlf/dsh-blender-plugin](https://github.com/sixtysevenlf/dsh-blender-plugin)），本地修改版，出处见 [UPSTREAM.md](plugins/dsh-blender-plugin/UPSTREAM.md)；
- `dsh-free-search` 为上游 **MIT**（[DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search)），镜像收录，出处见 [UPSTREAM.md](plugins/dsh-free-search/UPSTREAM.md)；
- `eac-design-world` 为 **AGPL-3.0-or-later**（上游 [Ebony-Vinyl/EAC-design-world](https://github.com/Ebony-Vinyl/EAC-design-world)），见其目录内 LICENSE。
