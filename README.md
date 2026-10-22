# exneo-useful-dsh-workshop

[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）插件市场：把自研/整理的插件打包成符合 DSH bundle 规范的 Cordis 插件包。每个包自带 `cordis.patch.yml` 与 `dsh.bundle` 声明，可用插件管理器按本地路径安装，装好后在 Web UI 设置页/侧边栏出现入口。

## 市场源（已部署）

DSH Desktop 设置 → 插件市场 → 添加数据源，粘贴官方市场索引（format 1，`@deepseek-ai/dsh-plugin-market` 校验）：

```
https://exneo-useful-dsh-workshop.pages.dev/dsh-index.json
```

- 托管在 Cloudflare Pages（连接本仓库自动部署）；条目为 GitHub 安装（pinned commit + 子目录），无需发布 npm。
- 插件更新后重新推送，再运行 `gen-dsh-index.mjs` 以新 commit 重新生成 `dsh-index.json` 并再次推送，新版本才会进市场。
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

> **rowId 冲突**：loader 按行 id 去重。若 profile 的 `cordis.patch.yml` 已有同 rowId 的手工行（如旧文档里的 `./plugins/xxx/index.js`），先删除，否则报 `duplicate loader entry id`。各插件 rowId 见 [marketplace.json](marketplace.json)。

## 插件一览

市场源现收录 22 个插件：

| 插件 | rowId | 分类 | 说明 |
|---|---|---|---|
| [dsh-archived-sessions](plugins/dsh-archived-sessions) | `archived-sessions` | 会话 | 恢复被归档隐藏的会话（出厂只归档、不提供恢复） |
| [dsh-device-mesh](plugins/dsh-device-mesh) | `device-mesh` | 多设备 | 多台 DSH 互接（令牌 + HMAC 签名），会话按设备→工作区→会话汇总，支持工作区多路径与跨设备执行 |
| [dsh-image-unload](plugins/dsh-image-unload) | `image-unload` | 工具 | `unload_images`：把图片从后续模型请求中卸下，省上下文 |
| [dsh-message-branches](plugins/dsh-message-branches) | `message-branches` | 会话 | 消息分支：同一条消息的多个版本，不新建会话，用导航条切换 |
| [dsh-model-capabilities](plugins/dsh-model-capabilities) | `model-capabilities` | 模型 | 按模型配置输入模态与思考强度（关/低/高/最大），写入 llm-pi-ai 渠道设置 |
| [dsh-model-groups](plugins/dsh-model-groups) | `model-groups` | 模型 | 把 (provider, model) 编成命名分组，跨供应商可用，供统计与重试消费 |
| [dsh-model-pool](plugins/dsh-model-pool) | `model-pool` | 模型 | 会话级模型供应池：按会话启停、调整用量上限与重置计数，SessionId 隔离 |
| [dsh-model-retry](plugins/dsh-model-retry) | `model-retry` | 模型 | 按 provider:model 配置重试次数、状态码、失败类别与退避，落盘热生效 |
| [dsh-ms-multimodal-retry](plugins/dsh-ms-multimodal-retry) | `ms-multimodal-retry-v1` | 模型 | ModelScope 多模态下载超时时丢弃最早一张图后重试 |
| [dsh-safefull](plugins/dsh-safefull) | `safefull-audit` | 安全 | 完整权限 + 每次工具调用先过静态安全审计（deny 硬拒，ask 视为拒绝） |
| [dsh-cordis-define-schema-fix](plugins/dsh-schema-fix) | `cordis-define-schema-fix` | 工具 | 扁平化 oneOf 工具参数，让转换器交出嵌套对象而非字符串 |
| [dsh-session-done-notify](plugins/dsh-session-done-notify) | `session-done-notify` | 通知 | 回合完成时弹系统通知（Windows / Android） |
| [dsh-session-import](plugins/dsh-session-import) | `session-import` | 会话 | 把 /export 的会话 ZIP 导回本机库，可选归属工作区（含新建） |
| [dsh-session-title-context](plugins/dsh-session-title-context) | `session-title-context` | 模型 | 用完整上下文（去图片）生成会话标题，兼容推理模型与 /title 指定模型 |
| [dsh-settings-nav](plugins/dsh-settings-nav) | `settings-nav` | 界面 | 设置项分组收纳（可折叠、嵌套 5 层）、自由排序，热生效 |
| [dsh-subagent-models](plugins/dsh-subagent-models) | `subagent-models` | 模型 | 会话级子代理模型链：多模型排序、逐模型限额，耗尽或失败自动回退 |
| [dsh-ultracode](plugins/dsh-ultracode) | `ultracode` | 界面 | 还原 Claude Code 的 ultracode 思考强度，会话开关开启即注入对应提示段 |
| [dsh-usage-stats](plugins/dsh-usage-stats) | `usage-stats` | 统计 | 按模型/供应商/分组/会话/日/周统计 token，可从历史日志与导出 ZIP 回填 |
| [dsh-user-keep-compaction](plugins/dsh-user-keep-compaction) | `user-keep-compaction` | 界面 | 压缩时 user 消息逐字保留，只摘要其间的助手/工具内容 |
| [dsh-workspace-context](plugins/dsh-workspace-context) | `workspace-context` | 工作区 | 每个工作区一份常驻提示词，注入该工作区会话的 system prompt，可读写 |
| [dsh-workspace-plugins](plugins/dsh-workspace-plugins) | `workspace-plugins` | 工作区 | 按工作区挂载普通 Cordis 插件，仅该工作区会话生效，会话结束卸载 |
| [dsh-zcode-cli-proxy](plugins/dsh-zcode-cli-proxy) | `dsh-zcode-cli-proxy` | 模型 | ZCode 额度反代（GLM 系列，真流式、图片输入），含设置页。**AGPL-3.0** fork |

## 目录结构

```
exneo-useful-dsh-workshop/
├── marketplace.json          # 机器可读索引（元数据、rowId、分类、依赖）
├── dsh-index.json            # 官方市场数据源（format 1，已部署）
├── index-source.json         # community-market 源 manifest（已部署）
├── v1/plugins                # community-market 目录端点
├── _headers                  # JSON Content-Type 配置
├── README.md
├── LICENSE                   # 仓库整体 LGPL-3.0
└── plugins/
    ├── dsh-archived-sessions/    # 每个插件 = 一个独立可安装 bundle
    │   ├── package.json          #   dsh.bundle.patch + dsh.client 声明
    │   ├── cordis.patch.yml      #   bundle 补丁（insert 行，name = 包名）
    │   ├── index.js              #   host 半边入口
    │   ├── client.js             #   浏览器半边（可选）
    │   └── ...
    └── ...（共 22 个在市场中）
```

## 开发与自测

```bash
cd plugins/dsh-device-mesh && node selftest.mjs   # 116 项
cd plugins/dsh-settings-nav && node selftest.mjs  # 222 项
cd plugins/dsh-usage-stats && node selftest.mjs   # 58 项（--quick 抽样）
```

各插件 README 记录了设计动机、边界与维护约定（热挂入口的 `entry-vN.js` 只是 specifier 别名，实现始终在 `index.js`）。

## 外部推荐（不在本仓库）

| 插件 | 来源 | 说明 |
|---|---|---|
| `@goodandready/dsh-lanmode` | npm | 局域网/反向代理访问 DSH Web UI |
| `dsh-free-search` | npm | 免费网页搜索：24 个引擎 + 智能路由 + 多源合并 + 时间过滤 |

```bash
dsh plugin --profile <profile> add @goodandready/dsh-lanmode
dsh plugin --profile <profile> add dsh-free-search
```

## 许可

仓库整体 **LGPL-3.0**（全文见 [LICENSE](LICENSE)），插件署名 **ExNeo**。
例外：`dsh-zcode-cli-proxy` 为 AGPL-3.0 fork（上游 [kyle123740/dsh-zcode-cli-proxy](https://github.com/kyle123740/dsh-zcode-cli-proxy) + 本机改动），见其目录内 LICENSE。
