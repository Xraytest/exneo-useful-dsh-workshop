# 收录说明

本目录是 ultracode 的**新版实现**（ZCode / Claude Code 插件包形态：skills +
commands + 纯 bash 状态机），相对本仓库 `plugins/dsh-ultracode`（DSH bundle、
提示词注入形态）是更晚、更完整的实现，逆向自 claude-code 2.1.286 原生二进制。

- 形态不同：本包是 ZCode 插件（`.zcode-plugin/plugin.json` + `skills/` +
  `commands/` + `scripts/`），不是 DSH Cordis bundle，因此**不进入**
  `dsh-index.json` 市场安装索引，也不能用 DSH 插件管理器安装。
- 使用方式：把本目录放入 ZCode 的插件目录（或按 `.zcode-plugin/plugin.json`
  的声明注册），随后 `ultracode <任务>` 关键字触发、`/ultracode on|off|status`
  管理常驻模式。
- 原版文件未作改动；本文件仅说明其在本市场的收录定位。
