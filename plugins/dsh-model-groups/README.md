# dsh-model-groups —— 模型分组

把 `(provider, model)` 路由编成**命名组**（成员可跨多个供应商），分组同时驱动两件事：

1. **用量统计**（`dsh-usage-stats`）：多一个「分组」维度，按组看用量；
2. **重试策略**（`dsh-model-retry`）：规则可以按组命中，一条规则给整组模型下同一套策略。

管理入口：设置页 **「模型分组」** 一节（`settings.section`，order 25，位于
「模型能力」20 与「重试策略」30 之间）；每张分组卡**最左侧**有一个无杆箭头（`›`，
展开时转 90° 朝下）用于**收起 / 展开**：收起后这张卡压成一行，**只显示该组的展示
名称**，不给任何修改入口（要改先展开）。折叠状态按组 id 落盘
（`$DSH_HOME/model-groups-ui.json`），刷新/重启/换浏览器后照旧 —— 见 §4.1。

---

## 1. 语义（冻结口径）

| 规则 | 说明 |
| --- | --- |
| **互斥** | 每个 `(provider, model)` **最多归属一个组** |
| **解析次序** | 启用组按「`priority` 升序 → 同级按声明顺序」排；**第一个命中的组胜出** |
| **未命中** | 归入统计口径的「未分组」桶（key `__ungrouped__`，label「未分组」） |
| **成员匹配** | `provider` / `model` 都是**通配式**：`*`（或只由 `*` 组成，如 `**`）=任意、`?`=单字符；默认**区分大小写**，组可选 `ignoreCase` |
| **命中报告** | 报告组内**最具体**的那个成员（含通配符的式子比字面更泛：字面 > 通配 > 全星号） |

**为什么互斥**：这样分组行天然可加——各分组行之和**恰好等于**总量（可对账、不重复计入），
而且重试匹配永远无歧义（同一路由恒定落同一组，`policyKey` 不会在重试之间抖动，
不会把预算折叠打乱成重试风暴）。

大小写变体（目录里同时存在 `deepseek-ai/DeepSeek-V4.1-Flash` 与
`deepseek-ai/deepseek-v4.1-flash`）默认算两个不同路由——这是刻意的：统计事实本来就是
按请求名记的。想收拢就给该组打开 **忽略大小写**。

## 2. 配置

落盘 `$DSH_HOME/model-groups.json`（缺省 `~/.dsh/model-groups.json`），原子写（tmp + rename）：

```json
{
  "schema": 1,
  "revision": 3,
  "updatedAt": 1760000000000,
  "groups": [
    {
      "id": "free-lane",
      "name": "免费车道",
      "description": "免 Key 的几条车道",
      "enabled": true,
      "priority": 10,
      "ignoreCase": false,
      "members": [
        { "provider": "our-free-model", "model": "*" },
        { "provider": "localhost", "model": "qwen/*" }
      ]
    }
  ]
}
```

- 折叠状态（设置页视图偏好）**不在这个文件里**：它是另一个文件
  `model-groups-ui.json`（`config.uiFile` 可改，缺省与分组文件同目录），
  详见 §4.1。

- `id`：`^[a-z0-9][a-z0-9._-]*$`，**上限 64 字符**（超长确定性截断并在 `warnings` 里说明；
  截断后仍保证唯一）；重试规则用 `group: <id>` 引用它——**改名不改 id**。
- `priority`：默认 100，范围 0..9999；数值小者先解析。这是**唯一**影响归属的排序杠杆。
- 上限：64 组 × 64 成员；其余字段长度上限见 `/dsh-model-groups/state` 的 `limits`。
- `schema`：可省（按 1 收）；写 `1`，或任何 `Number()` 能转成 1 的写法（`"1"`、`"1.0"`、
  `"0x1"`、`"1e0"`、`"+1"`）都认；其余（`"2"`/`2`/`true`/对象/`null`）按 **坏文件**
  处理——宁可拒绝，也不猜未来格式。（早期文档只写了 `"1"`，实测是 `Number()` 强转，
  口径以本节为准。）
- **外部改文件 1 秒内自动热生效**（`cacheTtlMs`）：TTL 窗口内零 I/O；到期先比
  `(mtime,size)`，即使两者都没变（同尺寸改写、`cp -p`/`utimes` 保留时间戳）也会
  **至多每秒一次**把几 KB 的文件读出来比对内容，因此不会出现「改了却永远读旧归属」。
- **坏文件**（JSON 语法错、根不是对象、`groups` 不是数组、schema 不认识）一律
  **保留上次可用快照 + 在 `warnings` 里说明原因**；绝不把分组静默清空。
  写入侧同样拒绝这类提交（400），避免一次手抖把文件清空。

## 3. 服务面（给其它插件用）

`apply` 期间发布服务 **`modelGroups`**（`ctx.provide`）：

```js
const service = ctx.get('modelGroups')          // 惰性取，不要写进 inject
service.schema                                   // 1
service.path                                     // 配置文件绝对路径
service.revision()                               // 修订号：**单调不减**（内容一变就 +1，不会回落）
service.list()                                   // 归一化后的组（含 order，深拷贝）
service.ids()                                    // 参与解析的组 id（按解析次序）
service.resolve(provider, model)                 // → {groupId,groupName,order,priority,fileIndex,member} | null
service.explain(provider, model)                 // → {winner, candidates:[{...,shadowed}]}
service.members(groupId)                         // → [{provider, model}]
service.refresh()                                // 强制重读文件，返回新 revision
```

- **`resolve` 是同步快路径**：TTL 窗口内**零 I/O**（快照 + 路由记忆表），统计逐事实、
  重试逐失败调用它都不会读盘；每次 POST 保存后强制重载，改动即时可见。
- `resolve` 与 `explain` 对同一参数**永远给同一个组**（含成员里带 `U+0000` 之类的
  病态输入：复合键做了不可碰撞编码，NUL 在归一化时被剥除并记 `issues`）。
- 消费方**一律用 `ctx.get('modelGroups')`**（不是 `inject`）：插件缺席时自己优雅降级，
  不会因为少了这一行而挂在 waiting。
- 服务名在本 realm 已被占用时插件**不让整行失败**（记警告、降级为无服务、路由照常注册）
  ——`apply` 抛错会让 loader 回滚整层更新，连累同层其它行。

## 4. HTTP 路由（同源守卫，仅 loopback / 同源页面可写）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-model-groups/state` | `{ok,schema,build,impl,path,exists,revision,groups,warnings,limits,ui}`（groups 带 `order`，0=不参与解析；`impl` = `index.js?v=…`，**判断线上跑的是哪张图看它**——`build` 只是 index.js 文件里的常量，分不清 entry / `?v` 标记；`ui` 内联折叠状态，见下） |
| POST | `/dsh-model-groups/groups` | body `{groups:[...]}`；归一化 → 致命错误 400 → 原子写 → revision+1 |
| POST | `/dsh-model-groups/resolve` | `{provider,model}` 或 `{routes:[…≤200]}` → 归属 + 被遮蔽候选 |
| GET | `/dsh-model-groups/audit[?fresh=1]` | 用**真实模型目录**核算每组的命中/被遮蔽/空组、未归组、重叠（60s 缓存） |
| GET | `/dsh-model-groups/ui` | 折叠状态：`{ok,schema,build,impl,path,exists,revision,collapsed,issues,issueCount,warning}`；`revision` = `max(文件字段, 进程内计数器)`，**单调不减**（外部改写/删文件都不会让它回落，H8 口径与分组本体一致） |
| POST | `/dsh-model-groups/ui` | body `{collapsed:[组 id…]}`（**必须带 collapsed**，清空就提交 `[]`）；归一化 → 原子写 → revision+1，回包带归一化结果与 `issues`（只回前 20 条 + `issueCount`：5000 个坏项的请求体曾换回 2.5 MB 回包）；**写失败不消耗 revision**（先落盘再提交进程计数器） |

写路由的守卫与限额：同源校验按 `host` 比对，**`Origin: null` 按外部处理（403）**，
无 `Origin` 头（curl / 本机 CLI）放行；请求体上限 256 KiB，超限**先完整回 413 JSON**
再收尾（不会 reset 连接）；`GET /groups` 等错方法回 405（`/ui` 同理）。

### 4.1 折叠状态（设置页视图偏好，独立文件）

设置页的每张分组卡可以**收起 / 展开**，开关是卡片**最左侧**的无杆箭头
（chevron `›`：收起时朝右 = 可展开，展开时原地转 90° 朝下；`aria-expanded` 同步）。

- **展开态**：完整编辑面（编号 / 名称 / id / 优先级 / 启用 / 忽略大小写 / ↑↓ / 复制 /
  删除 + 描述行 + 统计徽标 + 成员编辑区），与改版前完全一致。
- **收起态**：这张卡只剩一行——箭头 + **该组的展示名称**（`name`；没有名称时退到
  `id`，都没有则显示「（未命名）」）。**不给任何修改入口**：没有输入框、没有启停/忽略
  大小写开关、没有 ↑↓ / 复制 / 删除，也不显示统计徽标（长列表里要的就是这一行「占位符」）。
  id 挂在标题的 `title` 上，鼠标悬停仍看得到。

长列表编辑时把不关心的组压成一行，改完再展开；折叠本身不影响任何分组语义。

**落盘口径**（2026-10-09 起）：折叠集合以 **组 id** 为键写
`$DSH_HOME/model-groups-ui.json`（`config.uiFile` 可覆盖，缺省与分组文件同目录）：

```json
{ "schema": 1, "revision": 3, "updatedAt": 1760000000000, "collapsed": ["modelscope", "nvidia"] }
```

| 规则 | 说明 |
| --- | --- |
| **为什么独立文件** | 折叠是设置页的视图偏好，不是分组语义：统计/重试消费的 `schema 1` 契约、`/state` 的 `groups`、服务面 `list()` 都不该多出一个字段。两份文件各删各的，互不牵连 |
| **为什么按 id 不按 uid** | 浏览器侧的 `uid` 每次加载重新生成（它只为「改 id 时不重挂载卡片」而存在），落盘没有意义；`id` 才是分组的稳定标识——把一张卡改名/改 id 后再收起，落盘集合记的是新 id（收起态不给编辑入口，所以路径是「展开→改→再收起」，自测按这条路径验） |
| **只写合法 id** | 正在输入的半截/非法 id（`Bad ID`、空串）不落盘，否则文件里会留下永远匹配不上任何分组的项；改回合法 id 后自动补上 |
| **写盘时机** | 收起/展开后 **200ms 防抖**（`POST /ui` 覆盖写整份集合）。离开路径各有兜底：**刷新 / 关标签页** → `pagehide` 的 `navigator.sendBeacon`；**切标签页 / 手机切后台** → `visibilitychange`→`hidden`（`pagehide` 在这种情形不保证触发）；**关设置弹层 / 切到别的设置分节**（组件卸载、页面没卸载）→ 卸载时用普通 `fetch` 补发。三条都覆盖「防抖没到点就离开」 |
| **卸载补发** | 组件卸载时若 `wanted ≠ saved`，先补发再清定时器——这条曾经真的会丢：收起后 200ms 内关弹层 → 文件仍是旧集合、页面也没有任何提示（真浏览器实测）。分组的 900ms 自动保存同样补齐（改完优先级立刻关弹层不再丢编辑），`pagehide` 时也用 beacon 冲一笔 |
| **beacon 结果** | `sendBeacon` 队列满/被策略拒绝会返回 `false` 且**不发请求**：此时不把本地基线标记成「已落盘」，下次隐藏还会再冲一次。**折叠与分组编辑两条 beacon 同一规矩**（分组那条后来才发现只对了一半：beacon 被拒也照样清了待发登记，等于白丢一笔） |
| **不可落盘时冻结** | 本地分组校验不通过（id 缺失 / 非法 / 重复）时分组本体本来就不会落盘；折叠写盘**与它同闸门**——那一版的 id 还不是「已落盘的 id」，按它记折叠会把收起意图挂到别的组上（两张卡同 id 时尤其明显）。分组改回合法后自动补写。自测里的坏 id 特意落在**另一张**卡上：被折叠那张自己的 id 若非法，键里会把它丢掉，反而看不出冻结有没有生效 |
| **id 尺子同源** | 客户端与 host 用同一把尺子：`resolve.js` 的 `ID_RE` + `LIMITS.maxIdChars`（64）。客户端先拦下超长/非法项（否则 host 会丢、客户端却以为写成功，于是每次离开页面都白冲一次 beacon）；两端的正则与长度上限由自检里的跨端一致性断言锁住 |
| **串行写** | 同一时刻至多一个在途 POST；在途期间又改了会在收尾时再写一次，保证最后一次改动落盘（不会出现两个请求乱序、文件停在中间态） |
| **读** | `GET /state` 内联 `ui.collapsed`：页面加载一次请求就把「分组 + 折叠」还原成上次看到的样子。加载时不回写 |
| **坏文件** | JSON 语法错 / 根不是对象 / `collapsed` 不是数组 → 按**全部展开**降级并把原因放进 `issues` / `warning`（`GET /ui` 与 `/state.ui` **都**带，设置页只读 `/state`，所以坏文件的原因在页面上以「折叠状态文件不可用，已按『全部展开』显示：…」呈现，而不是静默全展开）；写一次就自愈。**绝不**影响分组本体（与分组文件的「保留上次可用快照」策略刻意不同：UI 偏好没有值得保护的语义，重启后也没有「上一份权威快照」可留） |
| **元素级宽松** | 非字符串、非法 id、超长项逐条丢弃并记 `issues`；只对形状（根不是对象 / 缺 `collapsed` / `collapsed` 不是数组）回 400——手抖的坏项不该让整批折叠状态写不进去 |
| **上限** | 折叠项 ≤ 64（= 分组数上限），超出截断并记 `issues` |
| **失败降级** | 宿主没有这半边（没有 `/ui` 路由或 `/state` 无 `ui` 字段，例如 profile 回退到未含本功能的插件副本）或写盘失败：界面里的折叠照旧生效，页面明确提示「折叠状态未能保存：…」，**不自动重试**（下一次改动会把整份集合一起带上去）。缺 `ui` 字段时按全展开处理，加载不报错。host 回 200 但丢了项（`issues`）时同样提示「折叠状态有 N 项未被接受」，不假装已保存 |
| **加载不回写** | 基线取**界面能表达的集合**（真有对应卡片、且 id 合法的那部分），而不是文件原文。文件里可能留着「当前不存在的组 id」（另一标签页删过组/改过名、有人手改过文件）：基线若取原文，**只是打开设置页**就会触发一次写盘，抹掉孤儿项并吃掉一个 revision——纯加载产生写入在「后写者胜」下会与真正在编辑的那一方打架。孤儿项留着不动，下一次真实改动自然把整份集合写成界面真值 |
| **多标签页 / 多设备** | 覆盖写、**后写者胜**（写的是「本页面知道的集合」，没有 `expectedRevision` / 409 协商）：一个没刷新的旧页面收起别的组时，会把别处已落盘的项一并覆盖掉。视图偏好按这个语义取舍；要跨窗口实时一致就得加读-改-写或版本协商（当前**不做**） |
| **写权限边界** | 路由只有同源守卫（无 cookie 校验，本机 `curl` 无 `Origin` 头也放行）。GUI 若经 `dsh-lanmode` 桥暴露到 LAN，LAN 侧同源页面同样能写这份文件——与 `POST /groups` 完全同一姿态，部署侧自行决定是否暴露 |
| **配置护栏** | `uiFile` 与 `file` 配成同一路径时**拒绝生效**：告警 + 退回缺省派生路径（`dirname(file)/model-groups-ui.json`）。否则一次 `POST /ui` 就把分组本体覆盖成 UI 偏好文档——运行中靠「坏文件保留快照」侥幸活着，重启后分组静默全空 |
| **目录创建有界** | 写盘前的建目录用逐级非递归 `mkdirSync`（`ensureDirSync`），**不要**换回 `mkdirSync(dir,{recursive:true})`：Node v22.23.3 对 procfs 这类路径会**永不返回**，同步调用占死唯一的 JS 线程，整个 DSH（GUI + 会话）冻结、无日志只能重启（`selftest.mjs` 用子进程 + 超时把这条钉死）；`rename` 失败时会清掉自己写的 `.tmp-*` |

## 5. 与重试插件（`dsh-model-retry` v2）的集成

规则新增可选选择器 `group`（与 `provider` / `model` 是**与**关系）。打分口径
`provider 字面 2 · model 字面 2 · group 命中 3`，分高者胜、同分取靠前者：

| 分数 | 选择器组合 |
| --- | --- |
| 7 | group + provider + model |
| 5 | group + provider / group + model |
| 4 | provider + model（单路由精确） |
| 3 | group（仅按组） |
| 2 | provider 或 model |
| 0 | 全通配 |

要点：

- **只按组的规则（3）不会盖掉已有的单路由精确规则（4）**——旧规则升级后行为稳定；
- **只按组的规则（3）一定盖掉 provider/model 通配规则（2）**——不受文件先后顺序影响；
- 组规则再钉 provider/model（5/7）视为「更具体」，会优先于单路由精确规则；
- 分组插件不在线 / 组被停用或删除 → group 规则**静默不命中**，`GET /rules` 带 `warnings`；
- 设置页「重试策略」有 **试算**（`POST /dsh-model-retry/preview`），用 host 的真实匹配
  逻辑算出某条路由落到哪条规则、解析到哪个组、逐条打分——不必猜优先级。

## 6. 与统计插件（`dsh-usage-stats`）的集成

统计插件新增 `by=group` 维度（页签「分组」）。**分组在查询时解析**，事实里从不写组名：

- 改组 / 改名 / 停用后，历史用量**立刻**按新口径重排，不需要重扫语料；
- 各分组行之和恒等于总量（`totals` 的 tokens 字段逐项相等）；未命中进「未分组」行；
  行副标题列出组内供应商；组名缺失时退回 id；
- 统计插件缺席 → 该列/该页签不可用，本插件设置页会自动隐藏「用量」列并给出提示。

> 注：`totals.sessions` 是 `fold.js` 既有语义——**整份语料的去重会话数**，不随
> `range` 变化、也不等于各分组行 `sessions` 之和（同一会话可以跨多个组）。这是
> v1 就有的定义，本次接入没有改动它。

补丁由 **`stats-integration.mjs`** 施加（锚点唯一匹配、**逐文件原子**、自动备份、语法校验）：

```bash
node plugins/dsh-model-groups/stats-integration.mjs                    # 只检查（核对标记/入口；若别人换过标记，先按 §9 末条同步工具头部 TAG/ENTRY）
node plugins/dsh-model-groups/stats-integration.mjs --copy /tmp/x --apply   # 副本演练
node plugins/dsh-model-groups/stats-integration.mjs --apply            # 落盘（源码口径）
node plugins/dsh-model-groups/stats-integration.mjs --live --apply     # 热挂（按工具头部 ENTRY/TAG 写入口 + 改 patch 行 name）
node plugins/dsh-model-groups/stats-integration.mjs --unlive --apply   # 热挂回滚（name 退回 index.js）
node plugins/dsh-model-groups/stats-integration.mjs --revert --apply   # 撤销全部补丁（回滚首选）
node plugins/dsh-model-groups/stats-integration-verify.mjs <统计插件目录>   # 维度行为验证（9 项）
```

行为保证（2026-10-08 第三轮独立验证后又补了四处）：

- **逐文件原子**：同一文件的补丁要么一起生效、要么一处不落；锚点对不上就拒绝该文件
  （绝不改错地方）。**混合态只补缺的**——曾经遍历整表重打，而 4 处补丁的锚点是其替换串的
  子串（anchor 打完仍在文件里），于是已接入的内容被复制一份且工具还报成功（fold.js 会直接
  语法坏）；现在只遍历 `missing`，并在写盘后**立刻** `node --check`，坏了就从刚做的备份回滚；
- **备份名永不复用**：同一次运行的第一个备份才是真正的回滚点（旧版本曾用秒级时间戳，
  同秒内多次备份会互相覆盖）；
- **回滚不依赖备份，且用往返校验自证**：`--revert` 按补丁表反向替换；结果核对除 token 扫描外，
  会把补丁表按原样重打到撤销结果上，要求**逐字节复现撤销前的文本**（可重复、不依赖备份；
  以前拿「最老的备份」当真凭据，而那份备份本身可能是中途态 → 干净回滚被误报 FAIL）；
- **参数失败即拒绝**：只认 `--check/--apply/--copy/--live/--unlive/--revert`，且 `--copy`
  支持 `--copy <dir>` 与 `--copy=<dir>` 两种写法；**任何不认识的参数一律 exit 2**。
  以前只认独立的 `--copy` token，`--copy=/tmp/x`（最容易手滑）会被静默忽略 → 落回真实 profile，
  `--apply` 就写生产了（第三轮独立验证报出的 high）；
- **写盘失败不抛栈**：只读目录 / 同名目录 / 磁盘满 → 友好报错 + 该文件保持原样（不留半成品）；
- **语法校验排在 `--live` 切换之前**：门禁只看此刻累计的问题，「补丁就位 + 某核心文件本来就语法坏」
  不会再先把 patch 行切到热挂入口；
- **不说假话**：`--revert` 明确写「磁盘已回滚，运行实例需重启」（loader 按 specifier 缓存，
  指回 `./index.js` 后 start 的是进程启动时那份）；补丁计划有问题时**不**做 `--live` 的切换；
- `--copy` 演练**禁止** `--live`（真实 patch 行只能由真实 profile 的操作改写）。

落地 **18 处**补丁 = **14 处语义改动 + 4 处热挂版本标记**（`node stats-integration.mjs` 会逐条列出）：

| 文件 | 语义 | 标记 | 内容 |
| --- | --- | --- | --- |
| `fold.js` | 5 | — | opts 声明 `groupOf`/未分组桶、`by=group` 分桶、sessions 去重计入、行输出（label/ungrouped/providers）、opts 文档补 group |
| `index.js` | 4 | 3 | `BY` 白名单 + 未分组常量、`groupService()`/`groupResolver()`、summary 传 `groupOf`、status 回报；标记给 `fold.js`/`store.js`/`rawlog.js` 三个 import |
| `client.js` | 5 | — | 页签、维度名、表头、行副标题、能力自检提示 |
| `store.js` | — | 1 | `store→fold` 导入的 `?v=` 标记（与 index.js 共用同一个 fold 实例） |
| **合计** | **14** | **4** | **18** |

（另有 `rawlog.js`：只参与「撤销后残留核对」，没有它自己的补丁。）

**热挂原理**：本 profile 未开模块热载，loader 按 specifier 缓存模块，原地改
`index.js`/`fold.js`/`store.js`/`rawlog.js` **不会**重新求值。`--live` 因此写一个入口文件
（**具体 ENTRY/TAG 以工具头部常量与 patch 行的 `name` 为准**——二者由
`node stats-integration.mjs` 的 CHECK 核对；写这段正文时的线上值是
`entry-v9.js` + `?v=cache-share-4`），并把 patch 行的 `name` 指过去
（**保持同一行 id** → loader 走 dispose→start，不会重复注册路由），同时给
`index.js` 的 import 打上同一版本标记，让整张图换新实例。
回滚只需 `--revert --apply`。

> `?v=` 是**模块缓存键，不是版本选择器**：`./index.js?v=任意值` 读的都是磁盘上当前的
> `index.js`；`entry-v*.js` 只是 specifier 别名，**不构成代码快照/回滚点**（真回滚要从
> git 历史或备份取旧源码）。`dsh-usage-stats` 目录 2026-10-09 已按这个口径清成单入口。

## 7. 自检

```bash
node plugins/dsh-model-groups/selftest.mjs            # host：解析核心 + 插件主体 + 契约 + 缺陷回归 H1-H10 + 折叠状态存储与可靠性 H11-H18（52 项）
node plugins/dsh-model-groups/client-selftest.mjs     # 设置页无头渲染 + 交互 + C1/C2/C3 回归 + 折叠状态持久化与边界（53 项）
node plugins/dsh-model-retry/selftest.mjs             # 重试：打分/优先级 + 与 v1 口径等价 + 端到端 + 坏输入/请求体加固（32 项）
node plugins/dsh-model-retry/client-selftest.mjs      # 重试设置页（27 项）
node plugins/dsh-model-groups/stats-integration-verify.mjs plugins/dsh-usage-stats   # 统计维度（9 项）
node plugins/dsh-usage-stats/selftest.mjs --quick     # 统计插件自身回归（末行 SELFTEST PASS 即全过；项数随版本变化）
```

折叠状态那几组（2026-10-09 新增，ui-2 加固 + 箭头改版后共 host 15 项 / 客户端 23 项）**逐行对应
§4.1 的规则表**，不在这里再抄一份口径。要点：

- host（F 段 + G 段）：缺省/显式 `uiFile` 路径、归一化、无文件与坏文件降级、`POST /ui` 的
  400/403/405 与跨源、原子落盘 + revision 单调、并发覆盖写、`/state.ui` 内联；
  **H11** 有界建目录（子进程 + 超时：procfs 路径必须毫秒级抛错，不能冻住进程）、
  **H12** `uiFile===file` 护栏（分组文件逐字节不变）、**H13** revision 外部改写/删文件后
  仍单调、**H14** 写失败 500 且不留 `.tmp-*`、**H15** 回包 issues 截断（5000 坏项 → <4 KiB）、
  **H16** `/state.ui` 带 warning/issues、**H17** `/state.impl`、**H18** 写失败不消耗 revision；
- 客户端：加载还原且不回写（含**孤儿 id 不触发回写**）、收起 → 防抖 POST 的是组 id 而非 uid、
  展开清空、被收起的卡改 id 跟着走、分组不可落盘时**冻结**折叠写盘、改名/改优先级/排序
  不触发折叠写盘、写失败提示但不回滚界面、缺 `ui` 字段时降级、`pagehide` beacon、
  `visibilitychange` 冲刷、**卸载补发**（折叠 200ms 与分组 900ms 两条）、beacon 被拒不标记
  已落盘（**折叠与分组各一条**）、host 丢项（issues）提示、**跨端 id 尺子一致**（正则 + 64 上限）、
  **折叠交互形态**（无杆箭头 `›` 在最左侧、展开转 90°、收起态只剩展示名称且零修改入口、
  名称缺失退到 id）。

变异矩阵（每条新行为各敲掉一处，自测必须红）随本轮验收一起跑，脚本留在
`/root/dsh-verify/`：`mutate-client.py`（客户端 11 个变异体，含 M11 分组 beacon）、
`mutate-host.py`（host 8 个变异体；原地改写 `index.js`，`finally` 里还原并复核 sha256）、
`model-groups-e2e.mjs`（真浏览器 43 项验收：还有箭头形态 / 收起态零修改入口 / 换设备 /
卸载补发 / 坏文件降级；收尾把折叠状态文件还原到测试前内容）。

自测桩件本身也按真实 React 语义实现（依赖浅比较决定 effect 是否重跑、`useCallback`
记忆化、真 `clearTimeout`、`unmount()` 跑清理）——旧桩忽略依赖数组，实测「把折叠落盘
effect 的 deps 改成 `[]`（功能全死）」照样 40 项全过，等于没有安全网。

第 3 项的随机等价对照请连同其**口径**一起看：原始 v1 源码已不在磁盘上（`index.js`
现在只是再导出），对照的是一份按 v1 契约独立转写的参考实现——它证明的是
「无 group 的规则集在 v2 打分下选择结果不变」，不是与已消失源码的逐字节对照。

## 8. 缺陷修复记录（2026-10-08，独立对抗验证后）

一轮独立对抗验证（6 路攻击 + 逐条复核）报出的问题已修并各带回归测试：

| 编号 | 缺陷 | 修法 |
| --- | --- | --- |
| H1 | `{"groups":null}` / 根为 `null` 的配置文件会顶掉上次可用快照，根 `null` 时连告警都没有 | 形状非法与语法错同等处理：保留快照 + 告警；写入侧 400 |
| H2 | `(mtime,size)` 短路 + 文件系统时间戳粒度 ~4ms → 同尺寸改写永远读旧归属 | TTL 到期后至多每秒读一次内容比对；TTL 内仍零 I/O |
| H3 | 合法但超长的 id 绕过 `maxIdChars`（300 字符 id 能落盘） | 归一化里确定性截断到 64 + `issues` |
| H4 | 写路由放行 `Origin: null` | 按外部处理（403）；无 `Origin` 头仍放行 |
| H5 | 请求体超限先 `destroy()` → 客户端只见 ECONNRESET | 先完整回 413 JSON 再收尾 |
| H6 | `U+0000` 复合键碰撞 → `resolve` 与 `explain` 自相矛盾、成员被误去重 | 不可碰撞编码 + 归一化剥离 NUL |
| H7 | 全星号（`**`/`***`）被当成「更具体」，且 `**/*` 的遮蔽告警漏报 | 全星号一律按「任意」计；遮蔽告警按语义比较 |
| C1 | **分组 id 输入框每敲一个字符就整卡重挂载（只能输入一个字符）** | 每卡稳定 `uid` 作 React key，`uid` 不进 payload |
| C2 | 重复 id 无提示、host 静默改名而界面仍显示「已保存」 | 本地重复检测 + 阻止 POST + 显示与落盘对齐 |
| C3 | 非法 id 时自动保存仍会发 POST | 与 C2 同闸门：非法/重复一律不发 |
| H8 | `revision` 非单调：内容变→6，随后仅 touch→回落到文件里的 5，同一值指向两份内容 | 改成**单调不减**（`max(文件值, 快照+1)`）；自测 E 段有「内容变 / 仅 touch / 字段回退 / GET /state 幂等」四步回归（回退该逻辑即 FAIL） |
| H9 | `readBody` 逐块 `body += chunk`（Buffer）→ 跨 TCP 分块的多字节字符被插 U+FFFD，静默损坏 name/description；上限按 UTF-16 码元计 | `req.setEncoding('utf8')`（StringDecoder 拼接跨界字节），上限口径与字符数一致；自测 E 段按**真实跨界切分**回归 |
| H10 | 413 后无限 `drain`：持续投喂的客户端能一直占住 socket（`requestTimeout` 是空闲计时器，会被数据重置） | drain 加预算（>4×上限即 `destroy`）；自测 E 段持续投喂断言「有限块数内断开」+「413 仍可读」 |
| — | 「线上跑的是哪一版」无从判断（本项目踩过：标记只打了一半，线上静默跑旧代码） | `/state` 回报 `build` 标记 |

### 8.1 变更记录（2026-10-09：设置页允许折叠分组 + 折叠状态持久化）

- 需求：编辑分组时允许把分组卡收起/展开，并且**折叠状态要持久化**（刷新页面、重启
  DSH、换浏览器都还在）。
- 实现：客户端每卡稳定 `uid` 记账 + 按**组 id** 派生落盘集合；host 新增
  `$DSH_HOME/model-groups-ui.json` 存储、`GET/POST /dsh-model-groups/ui` 路由、
  `/state` 内联 `ui.collapsed`；写盘 200ms 防抖 + 串行 + `pagehide` beacon 兜底；
  host 缺失/写失败时降级为「仅本次会话」并提示。详见 §4.1。
- 验收：跑 §7 的三条命令（host / 客户端 / 统计维度），末行 `SELFTEST PASS` 才算过；
  线上以 `GET /state` 的 `impl: "index.js?v=…"` + `build` 为准（热挂不改 `dsh-web` 进程，
  不影响正在运行的会话）。
- **ui-2（同日，5 路独立对抗验证后）**：报告 36 条，代码侧修 16 条并各带回归
  （见 §4.1 的「卸载补发 / beacon 结果 / 不可落盘时冻结 / id 尺子同源 / 加载不回写 /
  多标签页 / 写权限边界 / 配置护栏 / 目录创建有界」与 §7 的 H11-H18）；
  自测桩件修 2 条（effect 依赖语义 + 真 `clearTimeout`）；文档侧修 3 条
  （§9 的回滚指令、`build` 的证明力、§6 的过期热挂值）。第 16 条是同族缺口补完：
  分组编辑的 `pagehide` beacon 被拒时仍清掉了待发登记（与折叠那条不一致），
  现已同规矩 + 自测（变异体 M11 证明这条测试真的会红）。
  其余为**已记录不修**的设计取舍：多窗口后写者胜、写路由只靠同源守卫（LAN 桥可写）、
  `entry-v*` 别名保留。

### 8.2 变更记录（2026-10-09 晚：折叠交互改版 —— 最左侧无杆箭头 + 收起只剩展示名称）

- 需求（用户原话）：「改成在最左侧添加一个向右的无杆箭头，点击后收拢的更彻底一些，
  只显示当前分组的展示名称且折叠时不需要提供修改能力」。
- 改法：折叠开关从右上角的「收起 / 展开」文字按钮，换成卡片**最左侧**的 chevron
  （`›`，无杆；展开时 `transform: rotate(90deg)` 朝下，`aria-expanded` 同步）；收起态
  从「只隐藏成员区」改成**整卡压成一行**：箭头 + 展示名称（`name` → `id` →「（未命名）」），
  零输入框 / 零开关 / 零 ↑↓·复制·删除 / 无统计徽标。分组语义、落盘口径、三条离开路径
  兜底全部不变（折叠集合仍按组 id 落 `$DSH_HOME/model-groups-ui.json`）。
- 连带改的自测前提：旧用例里有三处「收起状态下改 id / 改名称 / 改优先级」，在新交互下
  不可能发生，已改写成新路径（展开→改→再收起、坏 id 落在另一张卡上等）；新增 1 条
  形态回归（箭头无杆 / 在最左侧 / 展开转 90° / 收起态只剩名称且唯一按钮是箭头）。
- 验收：客户端自测 53 项全过；真浏览器 43 项 `E2E PASS`；客户端变异矩阵扩到 16 个
  （新增 M12 箭头不转、M13 收起态照旧渲染完整头部、M14 标题用 id、M15/M16 箭头不在最左侧），
  **16/16 全部被测试杀死**。host 侧未改动（8/8 变异体照旧全杀）。

## 9. 维护

- 改 host 实现：写新文件 `entry-v<N+1>.js`，把 patch 行的 `name` 指过去，
  **保持同一行 id**（换 id 不会先 dispose，会出现重复路由 → `hmr-failure` → 整层回滚）；
  若改动落在被 import 的模块里（如 `resolve.js`），记得给那个 import 打上
  `?v=<tag>` 并在新 entry 里用同一标记，否则新图仍会拿到缓存里的旧模块。
  **整张图的每一层 import 都要打标记**——`dsh-usage-stats` 就吃过这个亏：v2 只标了
  `index.js`/`fold.js`，同事随后改的 `index.js`+`store.js` 被旧缓存实例永久挡住，
  线上静默跑旧代码（v3 起给 `store.js`/`rawlog.js`/`store→fold` 全部打上同一标记）。
  **判断线上跑的是哪张图**：`GET /dsh-model-groups/state` 的 `impl`（= `index.js?v=<tag>`，
  带 query 的真实模块身份）。`build` 只是 index.js **文件内**的常量——三份 entry 都
  `export * from './index.js?<tag>'` 指向同一个物理文件，所以 `build` 分不清 entry 与
  `?v` 标记，**回滚没生效时它照样报新版**（假阳性）。
  **当前线上**：`entry-v5.js` + `?v=ui-2` + `build=ui-2`（折叠状态落盘 + ui-2 加固）。
- **回滚怎么做（`entry-v*` 不是快照！）**：把 patch 行的 `name` 指回 `entry-v4.js` 并**不会**
  退回旧行为（它 `export *` 的还是磁盘上当前的 `index.js`；本进程里若还留着
  `index.js?v=ui-1` 的旧模块实例，会「此刻看似生效、重启后静默变回新版」）。正确三步：
  ① 用备份覆盖现文件（`index.js.bak-uistate-20261009-012606`，必要时带上
  `client.js.bak-*`/`resolve.js.bak-*`）；② 新写一个入口，**必须换新标记**
  （如 `entry-v6.js` = `export * from './index.js?v=rollback-ui';`，旧标记在进程里可能还命中缓存）；
  ③ 把 `id: model-groups` 那行的 `name` 指到新入口（同一行 id），等几秒用 `impl` 核对。
- **只改 `client.js` 不必换 entry**：它由 `/plugins/??…&rev=<sha1>` 直接送浏览器，
  内容一变 rev 就变，**刷新页面**即拿到新代码（`dsh-client-hmr` 还会在 500ms 轮询里
  热替换）。`index.js` / `resolve.js` 这类 host 模块才需要「新 entry + 新 `?v=` 标记」。
- **折叠交互改版（§8.2）怎么退回**：host 侧本次**没动**（`index.js`/`resolve.js` 与
  ui-2 相同，`impl` 仍是 `index.js?v=ui-2`）；`client.js` 侧只有两处——CSS 里
  `.mgrp-card.collapsed` / `.mgrp-chevron*` / `.mgrp-card-title` 五条样式，以及渲染里
  的 `chevron` 变量 + `if (isCollapsed) { … return … }` 早返回（展开态头部那行 `chevron,`）。
  把这两处改回「右上角 `收起/展开` 文字按钮 + 收起只隐藏成员区」即可，**不用换 entry**
  （client.js 由 `/plugins/??…&rev=` 直送浏览器，改完刷新页面就是新版）。
  `client-selftest.mjs.bak-chevron-*` / `README.md.bak-chevron-*` 是改版前的副本；
  client.js 没单独留副本，因为它就是上面这两处（真旧版则用
  `client.js.bak-uistate-20261009-012606`，退到 ui-2 之前）。
- `entry-v2/v3/v4.js` 仍留在目录里，但**只是 specifier 别名**（都指向同一个 `index.js`），
  不要把它们当回滚点或「旧实现」来引用；真旧源码只在 `*.bak-uistate-*` / git 历史里。
  （`dsh-usage-stats` 2026-10-09 已把同类文件清成单入口，本插件暂留以保守。）
- 2026-10-08 之后 `/root/.dsh/patch-probe.jsonl` **已过期**（探针插件不在当前进程里，
  12:01 之后再无写入）：不要再拿「文件里没有 hmr-failure」当证据，用行为探针
  （403/413/build 标记/重复路由是否 404）替代。
- **下游文件（`dsh-usage-stats`）又被改过时要重新热挂**：loader 按 specifier 缓存，
  同事后续对 `index.js`/`store.js` 的编辑不会进运行实例（本项目实测两次：16:41 与 21:15）。
  重新热挂 = 换标记 + 换入口文件名，保持同一行 id：
  ```bash
  # 1) 四处 import 的标记一起换（index.js ×3、store.js ×1）
  sed -i 's/?v=<旧标记>/?v=<新标记>/g' plugins/dsh-usage-stats/index.js plugins/dsh-usage-stats/store.js
  # 2) 新入口（内容就是 export * from './index.js?v=<新标记>'）
  # 3) patch 行的 name 指向新入口（同一 id），改完等几秒再看 /dsh-usage/status
  node plugins/dsh-model-groups/stats-integration.mjs --live   # CHECK 会核对标记与入口
  ```
  然后把本工具头部的 `TAG`/`ENTRY` 常量同步到新标记（否则 CHECK 会报「锚点不匹配」）。
- 改 `client.js`：`dsh-client-hmr` 500ms 轮询热替换，浏览器刷新页面即可看到。
- 加新文件后建议先跑 `node --check`，再跑上面 6 个自检。
