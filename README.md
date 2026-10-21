# exneo-useful-dsh-workshop

[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）插件市场：22 个自研/整理插件的 monorepo。
每个插件都是符合 DSH bundle 规范的 Cordis 插件包——自带 `cordis.patch.yml` 与 `dsh.bundle` 声明，
可用插件管理器按本地路径直接安装，安装后即在 Web UI 的设置页/侧边栏出现对应入口。

## 环境要求

- DeepSeek Harness `>= 0.2.0-rc.1`（开发与测试基于 `0.2.0-rc.2`）
- Node.js `>= 22`
- pnpm（DSH profile 自带）

## 快速开始

```bash
git clone https://github.com/<你的账号>/exneo-useful-dsh-workshop.git
cd exneo-useful-dsh-workshop

# 方式一：插件管理器工具 / CLI（推荐）
dsh plugin --profile <你的profile> add ./plugins/dsh-image-unload
#   然后用插件管理器把 dsh-image-unload 加入 dsh.profile.bundles（安装向导会自动做这一步）

# 方式二：手动写进 profile 的 package.json
#   "dependencies": { "dsh-image-unload": "link:/绝对路径/exneo-useful-dsh-workshop/plugins/dsh-image-unload" }
#   "dsh": { "profile": { "bundles": [..., "dsh-image-unload"] } }
#   然后 dsh plugin --profile <你的profile> install
```

> **注意行 id 冲突**：DSH 的 loader 按行 id 去重。如果你的 profile 的 `cordis.patch.yml`
> 里已经有同 rowId 的手工挂载行（例如从旧版本文档复制的 `./plugins/xxx/index.js` 行），
> 安装 bundle 前请先删除那些行，否则会报 `duplicate loader entry id`。
> 各插件的 rowId 见 [marketplace.json](marketplace.json)。

## 作为 DSH Desktop 插件市场索引源（方式三）

[DSH Desktop](https://www.dshdesktop.cn/)（Anywhere Labs 增强版）内置插件市场，支持添加自定义数据源。
本仓库自带索引文件，可直接注册为源：

| 文件 | 作用 |
|---|---|
| [`index-source.json`](index-source.json) | 源 manifest——你在桌面设置里粘贴的入口 URL |
| [`v1/plugins`](v1/plugins) | 目录端点：22 条 GitHub 安装条目（pinned commit + 子目录） |

桌面设置 → 插件市场 → 添加数据源，粘贴：

```
https://<你的托管域名>/index-source.json
```

### 托管要求（重要）

市场的 HTTP 客户端对源有严格校验：

- manifest 与端点必须**同源**（同一个 HTTPS origin，标准 443 端口，无凭据/片段）；
- 端点路径必须以 `/v1/plugins` 结尾；
- 两端文件都必须以 **`Content-Type: application/json`** 返回——GitHub Pages 对无扩展名的
  `v1/plugins` 文件返回 `application/octet-stream`，**会被市场拒绝**。

因此任选其一托管（均已含配置，连接仓库即用）：

1. **Cloudflare Pages**（推荐）：Pages → 连接 GitHub 仓库，构建命令留空、输出目录 `/`，
   [`_headers`](_headers) 会自动为 `/v1/plugins` 指定 `application/json`。
   部署后得到 `https://<项目名>.pages.dev`，把 manifest 里的 `transport.endpoint` 改成
   `https://<项目名>.pages.dev/v1/plugins`，再粘贴 `https://<项目名>.pages.dev/index-source.json` 添加源。
2. **Netlify**：同上连接仓库，[`_headers`](_headers) 同样生效。
3. 自己的静态服务器：按上表两条规则自行配置 Content-Type。

### 安装路径说明

源里的每条记录走 **GitHub 安装**（非 npm）：市场先按 pinned commit 从
`raw.githubusercontent.com` 校验插件 `package.json`（包名合法、版本为精确稳定 semver、
`dsh.bundle.patch` 合法），再以 `github:Xraytest/exneo-useful-dsh-workshop#<commit>&path:/plugins/<插件目录>`
交给官方插件管理器安装——**插件不需要发布到 npm**。

索引中的 `installSource.commit` 是固定的提交哈希。插件源码更新后，重新生成
`v1/plugins`（用新 commit 哈希）并推送，新版本才会进入市场。

## 插件一览

| 插件 | rowId | 分类 | 说明 |
|---|---|---|---|
| [dsh-archived-sessions](plugins/dsh-archived-sessions) | `archived-sessions` | 会话 | 归档会话恢复：设置页列出被归档隐藏的会话并可一键恢复（出厂只提供单向归档，无恢复入口） |
| [dsh-device-mesh](plugins/dsh-device-mesh) | `device-mesh` | 多设备 | 设备网格：多台 DSH 互相接入（令牌 + 每请求 HMAC 签名），会话按「设备 → 工作区 → 会话」三级汇总，支持工作区多工作路径与跨设备执行命令 |
| [dsh-image-unload](plugins/dsh-image-unload) | `image-unload` | 工具 | `unload_images` 模型工具：把 agent 上下文里的图片从后续模型请求中卸下，压上下文占用 |
| [dsh-message-branches](plugins/dsh-message-branches) | `message-branches` | 会话 | 消息分支（v4）：分支＝我发出的某条消息的多个版本，**不创建任何会话记录**；每条我的消息下面带分支导航条，点笔改写即建分支 |
| [dsh-model-capabilities](plugins/dsh-model-capabilities) | `model-capabilities` | 模型 | 模型能力管理：按模型管理输入模态与思考强度（关闭/低/高/最大四档），写入 llm-pi-ai 渠道设置成为真实能力声明 |
| [dsh-model-groups](plugins/dsh-model-groups) | `model-groups` | 模型 | 模型分组：把 (provider, model) 路由编成命名组（成员可跨供应商）；分组供用量统计（by=group）与重试策略消费 |
| [dsh-model-pool](plugins/dsh-model-pool) | `model-pool` | 模型 | 会话级模型供应池：会话头部「供应池」工具按会话启用/停用，动态调整各级用量上限与重置计数；按 SessionId 严格隔离 |
| [dsh-model-retry](plugins/dsh-model-retry) | `model-retry` | 模型 | 按模型的重试策略：为指定 provider:model 配置重试次数、触发重试的状态码与失败类别、退避；规则落盘热生效 |
| [dsh-ms-multimodal-retry](plugins/dsh-ms-multimodal-retry) | `ms-multimodal-retry-v1` | 模型 | ModelScope 多模态下载超时时丢弃最早的一张图并重试失败步骤 |
| [dsh-safefull](plugins/dsh-safefull) | `safefull-audit` | 安全 | 权限等级「安全审计后完整权限」（audited-full-access）的审计闸：完整权限 + 每次工具调用先过静态安全审计（命中 deny 硬拒、命中 ask 视同拒绝） |
| [dsh-cordis-define-schema-fix](plugins/dsh-schema-fix) | `cordis-define-schema-fix` | 工具 | 扁平化 union 类型（oneOf）工具参数，让平台工具调用转换器交出嵌套对象而不是字符串 |
| [dsh-session-done-notify](plugins/dsh-session-done-notify) | `session-done-notify` | 通知 | 会话回合完成时弹出系统通知（Windows / Android） |
| [dsh-session-import](plugins/dsh-session-import) | `session-import` | 会话 | 会话导入：把 /export 导出的会话归档 ZIP 导回本机会话库，导入时选择归属工作区（含新建） |
| [dsh-session-title-context](plugins/dsh-session-title-context) | `session-title-context` | 模型 | 会话标题生成：完整上下文（去图片）、工具调用取标题（兼容推理模型）、支持 /title 一次性指定模型 |
| [dsh-settings-nav](plugins/dsh-settings-nav) | `settings-nav` | 界面 | 设置导航分组收纳：设置页左侧设置项编成命名分组（可折叠、可嵌套 5 层）、自由排序；布局落盘热生效 |
| [dsh-subagent-models](plugins/dsh-subagent-models) | `subagent-models` | 模型 | 会话级子代理模型链：指定子代理可用模型（多个、按序）与每模型用量限额，耗尽或失败自动回退下一模型 |
| [dsh-ultracode](plugins/dsh-ultracode) | `ultracode` | 界面 | Claude Code「ultracode / ultra 思考强度」静态还原（逆向自 claude-code 2.1.287）：会话级开关，开启即在系统提示装配期直注 Ultracode 段 |
| [dsh-usage-stats](plugins/dsh-usage-stats) | `usage-stats` | 统计 | 用量统计：按 模型/供应商/分组/会话/每日/每周 统计 token 用量，可从既有会话日志与导出归档 zip 回填历史用量 |
| [dsh-user-keep-compaction](plugins/dsh-user-keep-compaction) | `user-keep-compaction` | 界面 | 「用户消息完全保留」压缩规则：user 消息逐字留在可见面，只摘要用户消息之间的助手/工具内容；新会话创建时可开启 |
| [dsh-workspace-context](plugins/dsh-workspace-context) | `workspace-context` | 工作区 | 工作区常驻上下文：每个工作区一份长期提示词，常驻该工作区会话的 system prompt 装配里；人可编辑，模型可用工具读写 |
| [dsh-workspace-plugins](plugins/dsh-workspace-plugins) | `workspace-plugins` | 工作区 | 工作区插件容器：把普通 Cordis 插件按「工作区」挂进会话自己的 agent 作用域——只对该工作区的会话生效，会话结束随之卸载 |
| [dsh-zcode-cli-proxy](plugins/dsh-zcode-cli-proxy) | `dsh-zcode-cli-proxy` | 模型 | dsh-zcode CLI 反代：把 DSH 的模型请求经 ZCode 客户端 app-server 转接到 ZCode Start Plan 额度（GLM 系列，真流式、图片输入）；本机部署版含设置页。**AGPL-3.0**（上游 [kyle123740/dsh-zcode-cli-proxy](https://github.com/kyle123740/dsh-zcode-cli-proxy) + 本机改动） |

## 目录结构

```
exneo-useful-dsh-workshop/
├── marketplace.json          # 机器可读索引（插件元数据、rowId、分类、依赖）
├── README.md                 # 本文件
├── LICENSE                   # MIT（zcode 插件为 AGPL-3.0，见其目录）
└── plugins/
    ├── dsh-archived-sessions/    # 每个插件 = 一个独立可安装的 bundle 包
    │   ├── package.json          #   dsh.bundle.patch 声明 + dsh.client 半边声明
    │   ├── cordis.patch.yml      #   bundle 补丁（insert 行，name = 包名）
    │   ├── index.js              #   host 半边入口（main）
    │   ├── client.js             #   浏览器半边（可选）
    │   └── ...
    └── ...（共 22 个）
```

## 安装细节

### 通过插件管理器（Web UI / Agent 工具）

Web 侧边栏「插件」页或 `plugin_manager` 工具的 `install_bundle` 接受**绝对路径**：

```
target: /绝对路径/exneo-useful-dsh-workshop/plugins/dsh-device-mesh
```

安装流程（插件管理器自动完成）：读 package.json 校验 bundle 声明与 DSH 版本兼容 →
`pnpm add` 本地路径 → 把包名加入 profile 的 `dsh.profile.bundles` → 应用补丁层。
失败会还原 package.json 与 lockfile。

### 手工方式

```bash
# 1. link 进 profile
dsh plugin --profile <profile> add /绝对路径/.../plugins/dsh-device-mesh
# 2. 编辑 ~/.dsh/profiles/<profile>/package.json：
#    "dsh": { "profile": { "bundles": [..., "dsh-device-mesh"] } }
# 3. 重载（patchReload=live 的 profile 即时生效，否则重启 dsh）
```

### 移除

插件管理器 `remove_bundle`，或从 `dsh.profile.bundles` 删掉包名后
`dsh plugin --profile <profile> install`。

## 开发与自测

多数插件带纯 Node 自测（无副作用）：

```bash
cd plugins/dsh-device-mesh && node selftest.mjs        # 116 项
cd plugins/dsh-settings-nav && node selftest.mjs       # 222 项
cd plugins/dsh-usage-stats && node selftest.mjs        # 58 项（--quick 抽样）
```

各插件 README 与文件头注释记录了设计动机、边界与维护约定（热挂入口的 `entry-vN.js`
只是 specifier 别名，实现永远在 `index.js`）。

## 外部推荐（不在本仓库）

| 插件 | 来源 | 说明 |
|---|---|---|
| `@goodandready/dsh-lanmode` | npm | LAN 与反向代理访问 DSH Web UI（非 localhost 页面返回设置服务、补齐浏览器在纯 HTTP 下扣留的 Web API） |
| `dsh-free-search` | npm | 免费网页搜索：24 个引擎（Bing/DuckDuckGo/Exa/Tavily/Perplexity…）+ 智能路由 + 多源合并 + 时间过滤 |

```bash
dsh plugin --profile <profile> add @goodandready/dsh-lanmode
dsh plugin --profile <profile> add dsh-free-search
```

## 许可

仓库整体 **LGPL-3.0**（GNU Lesser General Public License v3.0，全文见 [LICENSE](LICENSE)）。
所有插件署名 **ExNeo**。例外：`dsh-zcode-cli-proxy` 为 vendored 的 AGPL-3.0 fork
（上游 [kyle123740/dsh-zcode-cli-proxy](https://github.com/kyle123740/dsh-zcode-cli-proxy) + 本机部署改动，
署名 ExNeo (fork of kyle123740/dsh-zcode-cli-proxy)，见其目录内 LICENSE）。
