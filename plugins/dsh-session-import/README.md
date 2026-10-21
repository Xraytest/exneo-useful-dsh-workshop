# dsh-session-import — 会话导入

把 **`/export` 导出的会话归档**导回本机会话库，**导入时选择归属的工作区**（既有工作区，或就地新建一个）。

---

## 它补的是哪个缺口

DSH 出厂的会话导出是**单向**的：

- Session Header 的更多操作里有「Download session log」；
- 会话里敲 `/export` 是同一个动作。

两者都把会话树（本条会话 + 全部子代理 + 引用的附件）打成一个 ZIP 交给浏览器下载
（`GET /api/session.export?sessionId=…&includeDescendants=true`，文件名
`dsh-session-<id>.zip`）。**但出厂没有任何导入入口**——归档一旦离机就是死数据，
既不能续聊，也不会出现在侧边栏。

本插件补上回程。

---

## 怎么用

1. 打开**设置 → 会话导入**（这一节由本插件的浏览器半边注入，order 910）。
2. **选归档**：点击或拖入 `.zip`。
3. **解析归档（只读）**：这一步不写任何东西，只回一份概览——源会话 ID、创建时间、
   原工作目录、Agent 预设、根会话事件数、子代理条数、附件数量。
4. **选归属工作区**：
   - *导入到既有工作区*：下拉选一个（显示标题 / 路径 / 已有会话数 / 目录是否还在）；
   - *新建工作区*：填一个**绝对路径**，可用「浏览」逐级挑目录或就地在父目录下新建一级目录，
     显示名留空则取目录名。
5. **开始导入** → 成功后出现「打开会话」，直接切到新导入的会话。

导入完成后，该会话就出现在所选工作区的侧边栏里，可以照常继续对话。

**导入跑起来之后，不必守着这一页。** 任务活在模块级任务仓里，不绑组件生命周期：
直接关掉设置、切去别的会话、切去别的页面，导入照常跑完——**不需要刷新网页**；
回到「设置 → 会话导入」即接回同一份进度与结果（进行中 / 已完成 / 失败都会照实显示）。
这是刻意设计：大归档落库要几秒到几十秒，逼用户停在设置页等不合理。

**拖入 `.zip` 只会走这一条路。** 会话侧边栏的附件区也监听拖放，而且它不看落点——
出厂行为是「任何拖进窗口的文件都当会话附件上传」。本插件在 **window 捕获阶段**拦下
落在本节拖放区内的事件（`preventDefault` + `stopPropagation`），所以往这里拖归档
**不会**同时触发会话上传，也不会在会话侧亮起「可放置」提示。

### 两个选项

| 选项 | 默认 | 含义 |
|---|---|---|
| 重新分配会话 id | 开 | 每次导入都产生全新会话。**同一归档可反复导入，绝不覆盖既有会话。** 关掉则保留原 id，若该 id 已存在会直接报 409。 |
| 同时导入子代理会话 | 开 | 归档里 `subagents/<id>/` 的会话一并导入，`parentSession` 重映射到本次导入的新根会话。子代理**不单独记入工作区账目**（随父会话呈现）——这是本部署的出厂惯例，实测 438 条 `origin:'subagent'` 会话无一在工作区账目内。 |

---

## 落库走的是哪条路

全部用出厂公开 API，**不手工写磁盘格式**：

```
归档字节 ──readZip──▶ 条目表
         ──classifyArchiveEntries──▶ 根日志 / 子代理日志 / 图片 / 文件
         ──parseSessionLog──▶ { header, events }        ← 按存储代选三条通道（见下节）
         ──planArchiveImport──▶ 新 id、新头、父引用重映射
         ──prevalidateSession──▶ 全计划逐条过持久化层真实校验器（**写前**）
         ──sessionPersistence.create(header)──▶ handle
         ──handle.append(events) ──▶ handle.flush() ──▶ handle.close()
         ──workspace.attachSession(rootId)──▶ 记入工作区账目
```

由 JSONL 后端自己决定落盘目录（由 `header.cwd` 派生）与压缩帧——实测落点为
`<sessions root>/--root-nas-ArkTower--/<sessionId>/session.v3.jsonl.zstd`。

### 工作区归属：只有一条路

`Workspace.sessionIds` 的成员判定是**两条同时成立**（`dsh-workspace` 的
`WorkspaceEntity`：持久账目 ∩ 头 cwd 索引）：

1. 该会话 id 在工作区的持久账目数组里；
2. 该会话头里的**规范 cwd 等于工作区路径**。

所以「导入到某个工作区」在数据上就是两步：**把新头的 `cwd` 写成该工作区路径**，
再 **`attachSession(rootId)`**。没有第三条路——改不了已有会话的 cwd，也没法把
「不属于这个目录」的会话塞进它的账目。

新建工作区走 `workspaceRegistry.create(path, title)`，它对路径做 `fs.realpath`，
因此**目标目录必须已存在**（这是出厂语义，不是本插件的限制）。需要新目录时，
前端先调 `/mkdir` 在既有父目录下建一级目录。

### 为什么用 `validation: 'transformed'`

日志还原刻意与 `dsh-session-persistence-jsonl` 读冷会话时**逐字对齐**：

```js
sessionFormatCatalog.createRestore(headerValue, { recovery: 'strict', validation: 'transformed' })
```

**不能**用 `validation: 'current'`。实测它会把本部署**真实存在**的日志判为非法：

```
turn/start 3 does not open expected turn 2
```

原因是进程崩过一轮的会话最后一条 turn 只有 `turn/start` 没有 `turn/end`——DSH 的
设计是事后补一条 interrupted 收尾（`session-query` 冷读时合成），而不是判日志非法。
**persistence 自己读得进去的日志，导入器就不能读不进去。** 事件的词汇表校验由
`append` 时的 `validateStoredEvents` 负责，那才是它该待的地方。

---

## 存储代：更新代的归档也能进（三条通道）

会话日志头里有一个 `version`（**存储代**）。本部署的格式目录 `currentVersion = 3`，
随包只有 v0→v1、v1→v2、v2→v3 三个迁移包，**没有 v4 编解码器**。所以按归档声明的代选路：

| 归档的存储代 | 通道 | 行为 |
|---|---|---|
| v0 / v1 / v2 / v3 | **目录通道** | `sessionFormatCatalog.createRestore` 跨代迁移 + 完整校验（上一节那条链）。 |
| 比本进程新（如 v4） | **前向通道** | 事件**逐字保留**，不翻译语义；由持久化层真实校验器逐条裁决。 |
| 目录装载失败 | **朴素通道** | 只接受当前代。 |

### 前向通道为什么不猜语义

「理解这一代」不是导入的必要条件。把事件原样交给持久化层，它才是权威裁决者——
`validateStoredEvents` 对**未知事件类型**的规则是：

- 写入方标了 `ignorable: true` → **跳过**（这正是 `SessionEvent.ignorable` 信封契约的用途）；
- 没标 → **整包拒绝**，原话是 *"...unknown to this harness and not marked ignorable;
  refusing to interpret the log — it was likely written by a newer harness"*。

**这是出厂为「更新代日志」设计的闸**，本插件只负责把日志送到闸前，不自己发明策略：
放行即导入成立，拒绝就把校验器的原话照实回显（HTTP 400）。绝不猜测未知事件的语义，
也绝不因为「代更新」就直接放弃——那正是修复前 `stored Session uses newer format v4;
this build writes v3` 一堵到底的成因。

判定用格式目录的 `readHeader(headerValue)`——**只读探测，返回结构化结论而不抛异常**
（`{status:'unsupported', storedVersion, targetVersion, reason}`），不拿异常做控制流。

界面上会明确显示这条路径：概览里的「经 …」写**更新代前向通道**，并附一段说明讲清
「哪些会被跳过、哪些会让整包失败」。

### 写前预校验：不合格的归档不留残会话

`create()` **一落盘就写下了头记录**。如果随后的 `append()` 因词汇表/结构问题被拒，
磁盘上就留下一个只有头、没有事件的残会话；而且导入是逐条进行的，第 N 条不合格会
连累前面已经写好的。

所以整个导入计划在**写任何东西之前**先逐条过一遍持久化层的真实校验器
（`loadPersistenceContract()` 动态装载，**同一包实例**，与持久化服务同源，不会出现
「我这里放行、它那里拒绝」的错位）：

```
materializeCreateHeader → materializeAppendBatch → validateStoredEvents → assertContiguous(id, batch, 0)
```

全过才开始写。任一条不合格就整批中止、一条会话都不写（HTTP 400），磁盘无残留。
契约包装载不到时退化为「不预校验」，真正的把关仍在 `append` —— 只是失去「不留残会话」
这层保护，并会记一条警告。

---

## 路由

归档字节直接作为 POST 请求体（不套 base64），目标选择放查询串。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-session-import/status` | 只读自检：能力探测、配置回显、计数、上一处错误 |
| GET | `/dsh-session-import/workspaces` | 工作区清单（`id`/`title`/`path`/`sessionCount`/`status`） |
| GET | `/dsh-session-import/browse?path=<绝对路径>` | 列下一级目录（缺省 home），给「新建工作区」选路径 |
| POST | `/dsh-session-import/mkdir` | JSON `{parent, name}`，在既有父目录下建一级目录 |
| POST | `/dsh-session-import/inspect` | 解析归档回概览，**不写任何东西** |
| POST | `/dsh-session-import/import` | 真正导入 |

`/import` 的查询参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `workspaceId` | 二选一 | 导入到既有工作区 |
| `newPath` | 二选一 | 新建工作区（绝对路径，目录须已存在） |
| `newTitle` | 否 | 新工作区的显示名，缺省取目录名 |
| `includeSubagents` | 否 | 默认 `1` |
| `attachSubagents` | 否 | 默认 `0`（子代理不记入工作区账目） |
| `assignNewIds` | 否 | 默认取配置（`1`） |

写路由都过同源守卫（`sec-fetch-site: cross-site` 一律拒；带 `Origin` 时必须与
`Host` 同源）。归档 CRC 校验失败、结构非法、非 ZIP、超限分别回 400/413；未知
工作区 404；会话 id 已存在 409；服务缺席 503。

### 导入结果

```jsonc
{
  "ok": true,
  "sessionId": "session-…",          // 新根会话 id
  "workspace": { "id": "…", "title": "…", "path": "…", "created": false },
  "sessions": [ { "id": "…", "role": "root|subagent", "originalId": "…", "events": 3101 } ],
  "attached": ["session-…"],          // 已记入工作区账目的会话
  "attachments": { "files": 2, "images": 1, "failed": [] },
  "summary": { /* 与 /inspect 同一份口径 */ },
  "warnings": ["…"]
}
```

**导入不是原子的**：写会话逐条进行，中途失败会在错误信息里如实列出**已成功写入**
的会话 id，而不是假装全部回滚（会话日志是只增的，出厂没有删除 API）。

---

## 附件

归档里的附件是**内容寻址**的，路径本身即索引：

- 图片 `media/<attachmentId>.<ext>`
- 文件 `files/<摘要前两位>/<摘要>/<name>`

回灌走 `attachments.saveImage` / `saveFile`：字节一致则拿回的 id 与日志里引用的
一致，历史里的图片/文件引用不会变成悬空指针；文件回灌后还会比对摘要并告警。
**全程 best-effort**——附件服务缺席或某一条失败只记 `warnings`，绝不阻塞会话导入
（上下文是主产物，附件是增值项）。可用 `rehydrateAttachments: false` 整个关掉。

---

## 文件

| 文件 | 作用 |
|---|---|
| `entry-v2.js` | host 半边：六条路由、归档校验、代际通道、写前预校验、落库、记账 |
| `entry-v1.js` | 上一版（v4 前向通道与写前预校验之前），保留作回滚点 |
| `index.js` | 包入口（`export * from './entry-v1.js'`）——见下「维护」 |
| `client.js` | 浏览器半边：设置页「会话导入」一节 |
| `zipread.js` | 极简 ZIP 读取器（store + deflate、CRC 校验、zip-slip 防护）；只用 `node:zlib`，**不引第三方** |
| `sessionlog.js` | 纯逻辑：日志解析、归档归类、头规范化、导入规划、概览汇总 |
| `zstdframes.js` | 多帧 Zstandard 解码——**只给校验/测试用**，导入路径不碰它 |
| `selftest.mjs` | 75 项自测 |

`zstdframes.js` 存在的原因：JSONL 后端**按帧追加**，一个 2.6 MB 的日志实测有
**1757 个独立帧**，而 Node 的 `zstdDecompressSync` 与 `createZstdDecompress()` **都
只解第一个帧**——不做帧扫描就会得到「解压成功但只剩头记录」。扫描算法逐行对齐
`dsh-session-persistence-jsonl` 的 `scanZstdFrames`（读帧头描述符 + 块头链），
而不是去扫 `28 B5 2F FD` 魔数（压缩数据里完全可能出现同样的四字节）。

---

## 自测

```sh
node plugins/dsh-session-import/selftest.mjs
node plugins/dsh-session-import/selftest.mjs --quick   # 跳过真实语料那一段
```

六段，末行 `SELFTEST PASS` 才算过：

- **A. zipread**（10 项）：store/deflate 混排往返、目录条目跳过、CRC 不符、
  声明长度不符、非 ZIP（短体与够长体两条路径）、ZIP64 哨兵、zip-slip、
  路径规范化。
- **B. sessionlog**（15 项）：规范名识别（拒 `.v0`/前导零/压缩后缀）、归档归类、
  坏 JSON 拒绝、头规范化（丢未知字段、强制独立会话语义、子代理保留 origin/深度/父引用）、
  导入规划（嵌套子代理父引用重映射、归档外父引用回落并告警、保留原 id、跳过子代理）、
  概览汇总、配置归一化。
- **C. routes**（24 项）：用假 ctx / 假服务**真跑 `apply()`**，驱动全部路由——
  注册与 dispose、能力探测、同源/跨站守卫、405、目录浏览与 mkdir、只读 `inspect`
  真的不写、导入到既有/新建工作区、头 cwd 改写、flush/close 真的走过、账目成员判定、
  子代理记账两种口径、404/400/409/413/503、重复导入两种语义、附件回灌三种情形。
- **D. real**（3 项）：从磁盘上一条**真实**会话日志造出与 `/export` 同形的归档，
  断言帧扫描覆盖全部帧、3101 条事件 seq 从 0 严格连续、再走完整导入链路并逐条
  比对落库内容与源一致（本机没有该样例会话时本段跳过）。
- **E. 对抗**（16 项）：fflate 流式写入器（`/export` 的实际写入器，置 ZIP 标志位 3）
  产出的归档可读、符号链接路径 realpath、尾斜杠/`..`、目录不存在、源 cwd 不存在、
  只有头的归档、末尾无换行、两条根日志、非 ASCII 名、两万事件、中途写入失败如实上报、
  `append` 抛错仍关句柄。
- **F. 更新代与前向通道**（10 项）：v4 经 `readHeader` 走前向通道而不抛错、`/inspect`
  如实报告代际、全是已知事件时可导入且保真、未知且未标 `ignorable` 时**整包被拒且
  一条会话都没写**、标了 `ignorable` 时放行且标记原样保留、seq 不连续在 `create`
  之前被拒、整个计划先全过再写（第 2 条不合格时第 1 条也不落盘）、契约缺席时退化放行、
  目录通道 `degraded` 为 `null`。

---

## 维护

**本 profile 未开模块热载**，loader 按 specifier 缓存模块：

- 改 host 实现 → 写 `entry-v<N+1>.js`，把 `cordis.patch.yml` 那一行的 `name` 指过去，
  **保持同一行 id `session-import`**。本行不发布任何人无我有的全局唯一资源，只注册
  六条路由（自带重复占用重试），重挂是安全的。
- **`entry-vN.js` 里的相对导入必须带 `?v=N` 查询串**（`./sessionlog.js?v=2`）。
  只换 entry 路径**不够**：loader 与 Node ESM 都按 specifier 缓存模块，子模块不带
  查询串就会命中缓存、继续跑旧代码。查询串在 Node ESM 里是独立模块 URL，会从磁盘
  重读。改版时把这一组 `?v=N` 连同文件名里的 N 一起 +1。
- 改 `client.js` → 由 `dsh-client-modules` 按**内容哈希**供包，内容一变 revision 即变，
  **浏览器刷新即见**（复本号可从 `clientModules` 图里读，无 rev 的请求一律 404）。
- 新增 `dsh.client` 声明 → 需要浏览器重新拉取一次。

判定是否真的生效：`curl -s 127.0.0.1:3080/dsh-session-import/status` 看 `version`
与 `counters`。

改动 `client.js` 后确认线上产物确实是新的：从图里取 revision 再取包，直接 grep 新符号——

```sh
curl -s "http://127.0.0.1:3080/plugins/??dsh-session-import/client.js&rev=<rev>" | grep -c installDropGuard
```

无 rev 的请求返回 **404**（版本化代码不可变，不会拿新字节顶旧复本号）。

### 客户端装载是怎么被发现的

`dsh-client-modules` 扫描 loader 的每一行：行名是路径式（`./plugins/…`）→ 沿该模块
向上找最近的 `package.json` → 若 `dsh.client.platform === 'web'` 且 `exports["./client"]`
存在，就把该文件当作浏览器半边，编进 `/plugins/??<id>/client.js&rev=…` 的启动图。
所以 `package.json` 里那两处声明缺一不可。