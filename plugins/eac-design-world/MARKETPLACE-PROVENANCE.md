# 市场收录说明（Provenance / 出处与修改）

本目录是 **Ebony-Vinyl/EAC-design-world** 的**本地修改版**收录，不是原版仓库的镜像。

## 出处

| 项 | 值 |
| :--- | :--- |
| 上游项目 | [Ebony-Vinyl/EAC-design-world](https://github.com/Ebony-Vinyl/EAC-design-world) |
| 上游作者 | Ebony-Vinyl |
| 基础版本 | v0.4.0（与 npm `eac-design-world@0.4.0`、上游 v0.4.0 发布一致） |
| 上游许可 | AGPL-3.0-or-later（本目录保留其 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`，未改动） |
| 本收录版维护 | Xraytest（DSH 用户 ID `xray4668`） |
| 版本号 | 仍为 `0.4.0`（未跟随上游发版，改动为本地修改，见下） |

## 本地修改点（相对上游 v0.4.0）

以下改动由 Xraytest 在本机进行，尚未回馈上游；如上游已修复相同问题，请以上游为准：

1. **`plugin/client.js`**
   - Composer 控件、选片 iframe 与缩略图改为访问「与 GUI 同主机」的 EAC 服务：
     本地打开走 loopback，经局域网打开时用当前 hostname（服务本身监听所有接口），
     不再硬编码 `http://127.0.0.1:4173`。
   - 选区同步（selection sync）增加重试：插件热重载会短暂关闭本地服务，重挂载的
     composer 重新同步时那一次丢失的写入会留下只能刷新页面才能清除的错误横幅；
     现对网络错误与 5xx 做至多 3 次指数退避重试，4xx 仍直接失败。
   - 模板 ID 增加安全模式校验后才发送。
2. **`src/server.mjs`**
   - 服务监听所有接口（原来仅 loopback 可用），信任 loopback 与私有网段
     （10./172.16-31./192.168.）来源；公网 host 永远不会被信任。
3. **`vendor/motion-promo-film/templates/fonts/`**
   - 补齐上游未随 npm 包分发的 5 个 woff2 字体与 `nscs` 目录。
4. **`package-lock.json`**
   - 本机依赖锁定文件（上游发布物不含）。

## 未随本市场镜像的大体积库快照

以下两个上游 vendor 快照**未包含**在本市场目录中（合计约 268 MB / 7400+ 文件）：

- `vendor/open-design/`（约 165 MB，6697 文件）——OpenDesign 设计体系/模板索引，
  运行时经 `src/open-design-library.mjs` 读取；缺失时插件正常启动，设计库显示为空。
- `vendor/video-shotcraft/`（约 104 MB，767 文件）——Shotcraft 镜头快照与预览媒体。

需要完整设计库时，任选其一：

```bash
# 1) 从 npm 包恢复（官方完整资产通道，tarball 约 176 MB）
npm pack eac-design-world@0.4.0 && tar xzf eac-design-world-0.4.0.tgz
# 将 package/vendor 下的 open-design、video-shotcraft 拷入本目录 vendor/

# 2) 从上游仓库获取
git clone https://github.com/Ebony-Vinyl/EAC-design-world.git
```

> 排除原因：GitHub Git Data API 每小时 5000 次请求上限装不下 7400+ 个文件的一次性
> 建仓，且完整快照会使市场仓库膨胀约 268 MB，拖慢每一次市场安装时的仓库克隆。
> 插件本体（录制、时间线、配音、字幕、渲染、设计成品）不依赖这两个快照。

## 许可边界

- 本目录整体沿用上游 **AGPL-3.0-or-later**，与市场仓库总仓的 LGPL-3.0 是
  「同一 monorepo 内各自独立许可」的关系，以目录内 `LICENSE` 为准。
- `THIRD_PARTY_NOTICES.md` 中列明的第三方素材（mg-styles-15、Motion Web、
  Onetake、motion-promo-film 技能等）保留其各自上游许可；其中 Motion Web /
  Onetake 为可选本地导入源，商业使用需相应上游授权。
- 将本目录再分发时，请同时保留本文件、`LICENSE` 与 `THIRD_PARTY_NOTICES.md`。
