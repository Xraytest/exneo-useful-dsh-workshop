# 上游出处（Upstream）

本仓库是第三方开源项目的**镜像副本**，**不是原创作品**。

| 项 | 值 |
| :--- | :--- |
| 上游项目 | [DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search) |
| 上游作者 | DDDMUC |
| 上游许可 | MIT（`LICENSE` 为上游原文，未改动） |
| 上游体量 | 约 1064 stars（2026-11-11 快照） |
| 本仓库基线 | 上游提交 `c93c2e6`（2026-10-31，`chore: keep the launcher script's local edits and backups out of the repo`） |
| 本仓库版本 | v0.9.23 |
| 上游当前版本 | v0.9.42（`ff0a700`，release 0.9.42） |

## 说明

- 本仓库内容为本机 DSH 安装副本，其工作树与上游 `c93c2e6` 一致（`git status` 干净）；上游此后已前进 **63 个提交**，本仓库未跟随。
- `tools/assert-bridge-access.mjs`、`tools/assert-result-ranking.mjs` 里出现的 `192.168.x.x` 是**上游自带的测试样例地址**，不是任何真实网络地址。
- `tools/` 下的 `assert-*.mjs` / `live-*.mjs` 等自测脚本同为上游内容，原样保留。
- 如需最新版本、问题反馈或贡献，请使用上游仓库；再分发时请保留 `LICENSE` 与版权声明（版权归 DDDMUC）。
