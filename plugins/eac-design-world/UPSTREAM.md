# 上游出处（Upstream）

本仓库是第三方开源项目的**本地修改版**，**不是原创作品**。

| 项 | 值 |
| :--- | :--- |
| 上游项目 | [Ebony-Vinyl/EAC-design-world](https://github.com/Ebony-Vinyl/EAC-design-world) |
| 上游作者 | Ebony-Vinyl |
| 上游许可 | AGPL-3.0（`LICENSE` 与 `THIRD_PARTY_NOTICES.md` 为上游原文，未改动） |
| 上游体量 | 约 1298 stars（2026-11-11 快照） |
| 基础版本 | v0.4.0 |

本地修改点、收录范围与许可边界详见 [`MARKETPLACE-PROVENANCE.md`](MARKETPLACE-PROVENANCE.md)。

## 本仓库不含两个上游 vendor 快照

`vendor/open-design/`（约 165 MB）与 `vendor/video-shotcraft/`（约 104 MB）**未**提交到本仓库。
这是本收录版自身的收录策略（见 `MARKETPLACE-PROVENANCE.md` 第 36–57 行），恢复方式：

```bash
npm pack eac-design-world@0.4.0 && tar xzf eac-design-world-0.4.0.tgz
# 把 package/vendor/open-design 与 package/vendor/video-shotcraft 拷入本仓库 vendor/
```

缺失时插件仍可正常启动，仅设计库/分镜库显示为空。

## 许可

AGPL-3.0-or-later。再分发（包括以网络服务形式提供）须遵守 AGPL 条款，并保留 `LICENSE`、`THIRD_PARTY_NOTICES.md` 与本文件。
