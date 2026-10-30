# dsh-settings-nav —— 设置导航分组收纳

把设置页**左侧那一列设置项**编成命名分组（可折叠收纳），并按你想要的顺序排列。

- **分组收纳**：一行一个分组标题，点标题收起/展开；收起的分组在左列只占一行。
- **自由排序**：左列的行（含跨分组）与分组标题**任何时刻都能直接拖**，不需要先进「整理」模式；管理面里「未分组」池的每一项也能拖，空分组占位条可以直接落。也可以用 ↑ ↓ 按钮（任意层级）。
- **分组可嵌套（v4，真正的多级结构）**：分组里可以再放分组，最多 5 层。左列按层级缩进；折叠是子树级的；拖拽可以把**条目或整棵分组**放进任何分组（但绝不放进它自己的后代——成环）；管理页每个分组行都有「＋ 子分组」。
- **即时生效**：管理页动一下，左列当场变；导航里点标题折叠，也是当场变。
- **持久**：布局落盘 `$DSH_HOME/settings-nav.json`，刷新 / 重启 DSH 后照旧。
- 设置页新增「设置导航」一节（order 6，紧跟「通用」）作为管理面。

```
设置
├─ 通用
├─ 设置导航        ← 本插件（管理面）
├─ 模型
├─ 插件
├─ 工作区常驻上下文
├─ 模型分组
├─ 用量统计
└─ …（其余出厂设置项）
```

编好之后可能是这样：

```
设置
├─ 通用                          ← 独立项（不归组）
├─ 模型与路由                    ← 分组标题（折叠后只剩这一行）
│   ├─ 模型
│   ├─ 模型分组
│   │   └─ 模型能力              ← 子分组：分组里可以再放分组（最多 5 层）
├─ 设置导航                      ← 可以拖到任何位置，也可以塞进任何分组
├─ 会话与数据
│   ├─ 用量统计
│   └─ 会话导入
└─ 插件
```

---

## 1. 语义（冻结口径）

布局是一份**布局**，不是「注册表」。三条语义决定了它不会把设置项弄丢：

| 情况 | 行为 |
| --- | --- |
| 布局里**没提到**的设置项 | 按出厂 order 追加在最后。新装插件自动出现在末尾，不需要手工登记 |
| 布局里提到、但当前**不存在**的 id | **只跳过、不自动删除**。插件回来时自动复位；管理页把这批列成「失联项」，可手动清理 |
| 同一个 id 在布局里出现**两次** | 非法。归一化时保留先出现的那次并记 issue |

另外两条刻意的设计：

- **空分组仍然出标题**（数量显示 0）。成员全失联时分组静默消失会让人以为配置被清了；留着标题 + 管理页可查，比静默消失诚实。
- **折叠是子树级的**：收起一个分组，整棵子树（成员**和**子分组的标题）一起藏；收起子分组只藏它自己的成员。唯一例外是「当前分节所在的那条链」永远可见（否则「我在哪」的唯一指示会被一起藏掉）。
- **删除分组永远不删成员**（含嵌套）：子条目按原顺序就地摊回它所在的容器，子分组整棵保留。删掉一个父组只会丢「层级」，不会丢任何设置项。
- **删除分组不删除成员**，成员就地摊回顶层变成独立项。删一个分组永远不会让人丢掉设置项的可见性。
- **越界写不覆盖**：`POST /save` 的 `baseRevision` **可选**。带上时对不上返回 `409` + host 现状，客户端**采用** host 版本并提示——不静默盖掉别人的改动（导航内折叠、管理页编辑、直接改文件，这三条路都会写它）。**不带**（或不是数字）= 显式无条件覆盖，是留给本机 CLI 的便利口子；也正因为有这个口子，守卫必须自己站得住（见 4.4）。

### 文档 schema 2（v4 起分组可嵌套）

```json
{
  "schema": 2,
  "revision": 7,
  "updatedAt": 1791565812842,
  "order": [
    { "type": "item",  "id": "general" },
    { "type": "group", "id": "g-model", "name": "模型与路由",
      "collapsed": false,
      "items": [
        "models",
        { "type": "group", "id": "g-mg", "name": "模型分组",
          "collapsed": false, "items": ["model-groups", "model-capabilities"] }
      ] }
  ]
}
```

`order` 是**整个左列**的视觉顺序，逐项排列；`item` 是独立项，`group` 后面紧跟它的成员。
设置项的 id 就是它在 `settings.section` 槽位上的注册 id。

**schema 2 的唯一变化在 `group.items`**：里面既能放设置项 id **字符串**（老写法，继续接受），
也能放**子分组对象** `{type:'group', …}`——两种可以交错、顺序随意，最多嵌套 `maxDepth`(5) 层
（顶层分组为第 0 层）。顶层 `order` 的形状与 schema 1 完全一致，所以旧文件原样可读。

**降级语义（为什么选「混排」而不是新开一个 `children` 键）**：老版本插件（v3 及以前）读到
schema 2 文件时，会把 `items` 里的子分组对象当未知类型丢掉、普通 id 成员原样保留——丢的只是
层级，设置项一个不少；反过来新版本读旧文件零损失。若新开 `children` 键，老版本会把它当
未知键连同整棵子分组静默丢弃，同样的降级却更难排查。重复 id 的账（设置项与分组各一本）
在**整棵树**里共享，跨层级重复一样被丢弃并记 issue。

**revision 单调不减**：内容变了递增，内容没变也不回落。对外取 `max(文件字段, 进程内计数器)`。只报文件字段，外部把文件改小时会回落（同一个号指向两份内容，消费方误判「没变」）；只报进程计数器，重启后失真。写盘时**先算后写、写完再提交内存值**——落盘失败时绝不对外宣称一个从未落盘的号。

---

## 2. 配置

```yaml
- insert:
    - id: settings-nav
      name: ./plugins/dsh-settings-nav/entry-v5.js
      config:
        file: null        # 布局文件位置；null/省略 = $DSH_HOME/settings-nav.json
        enabled: true     # false = 不增强左列（保留管理页，便于排查）
```

---

## 3. HTTP 路由（同源守卫）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` / `HEAD` | `/dsh-settings-nav/state` | 文档 + revision + 路径 + warnings + limits + config + 诊断计数器 |
| `POST` | `/dsh-settings-nav/save` | body `{ baseRevision?, order }`；`baseRevision` 不匹配 → `409` + 当前文档；不带 = 无条件覆盖 |
| `POST` | `/dsh-settings-nav/reset` | body `{ baseRevision? }`；等价于 `save {order: []}` |

守卫口径（顺序即语义，见 4.4）：
1. `sec-fetch-site: cross-site` → 拒；
2. `Host` 必须是**本机 authority**（`localhost` / `dsh.local` / 环回 / 私网字面量，与 dsh-lanmode 的 `isTrustedLocalAuthority` 同口径）→ 否则拒；
3. 没有 `Origin` 头（curl / 本机 CLI）→ 放行；`Origin: null` → **按外部处理**（沙箱 iframe、`file://` 页面都会发 `null`，不能只靠「读者拿不到响应」兜底）；
4. 有 `Origin` → 其 host 必须等于 `Host`，且 scheme 必须与**实际传输**一致（明文连接只接受 `http:`）。

本地布局文件虽然不进 system prompt，但写路由仍是权限面，按严档处理。

其他边界：`/state` 之外非 POST → `405`（`/state` 接受 `GET`/`HEAD`）；body 不是合法 JSON → `400`；body 超过 256 KiB → `413`（**先读完再回**，立刻 `destroy` 会让客户端只看到 `ECONNRESET`）；body 声明了却一直不发 → `408`（15s 超时，见 4.6）；布局文件存在但读不动 → `/save` 与 `/reset` 一律 `503` 拒写（见 4.5）。

```bash
curl http://127.0.0.1:3080/dsh-settings-nav/state
curl -X POST http://127.0.0.1:3080/dsh-settings-nav/save \
  -H 'content-type: application/json' \
  -d '{"baseRevision":2,"order":[{"type":"item","id":"general"}]}'
```

---

## 4. 已踩过的坑（改代码时别拆掉）

### 4.1 不能顶掉出厂的设置壳 —— 只能在 DOM 上做

最初的设计是「注册 `sidebar.settings`（single 槽位）用更低 priority 顶掉出厂的 `SettingsRoot`，自己渲染整列导航」。读过 SlotCore 与渲染器的实现后确认这条路**能顶掉那个槽位，却永远渲染不出设置正文**：

1. `SlotCore.register` 对 single 槽位：**同一 priority 上已有人 → 直接 throw**
   （`single slot "X" already has a registration at priority 0 — register at a different priority to shadow it (lowest renders)`）。要顶掉出厂壳（priority 0）必须用更低优先级。
2. `renderSlot` 这个 prop **只发给「自己声明了 children」的注册**
   （渲染器：`if (entry.children !== void 0) kit.renderSlot = …`），而 `register()` 在 children 里出现**别人已声明**的槽位时**也会 throw**（`slot "X" is already declared (by Y)`）。
3. `settings.section` / `settings.trigger` / … 已被出厂壳的注册声明；只有**释放**那份注册才会解除声明，而别人的注册我们无权释放。

所以顶掉它在平台层面**是可行的**——`ctx.slots.register({ name: 'sidebar.settings', priority: -1 }, …)` 就会赢，因为渲染取 `entriesOfSlot(key)[0]`、而 core 按 priority 升序排（那条错误信息自己就在教这件事：「register at a different priority to shadow it (lowest renders)」）。但**没有意义**：新注册若重新声明 `settings.section` 等子槽位，会在第 2 条上 throw；不声明则拿不到 `renderSlot`（正是第 2 条的那句 `if (entry.children !== void 0)`），于是永远渲染不出任何注册进来的设置页。

结论：**能渲染 `settings.section` 正文的组件有且只有出厂的那个壳**，所以壳必须原样留着、只能在 DOM 上做增强。

顺带一条同源的平台限制：`ctx.slots.register` 对 **list** 槽位在同一 priority + 同一 id 上也会 throw，所以本插件**不覆盖任何出厂槽位**，只新增自己的 `settings-nav` 一节。

**因此增强手段只能是这几样**（都不用替换 React 节点，所以与 React 的重渲染天然共存）：

- **视觉顺序**：给导航列表的**直接子** `<button>` 设内联 `style.order`。列表容器是 `display:flex; flex-direction:column`，`order` 就是视觉位置。出厂壳渲染每个行时**不设 `style` prop**（读过源码确认：只有 `type` / `className` / `aria-current` / `onClick` / `children`），React 只更新它自己给过的属性，所以内联样式不会被重渲染抹掉。
- **折叠**：折叠组内的行设内联 `display:none`。
- **分组标题**：我们 `createElement` 的 `<div>` 插进同一个 flex 容器，同样用 `order` 定位。React 不认识这些「外来节点」，既不会删它也不会给它排序（插入新节点时用的参照物永远来自它自己的 fiber 树）。
- **定位不依赖构建期哈希类名**（`VOzbGW_navList` 这种名字每次打包都会变）。判据只有结构：`[role="dialog"][aria-modal="true"]` → 后代 `nav` → 直接子 `div` 且其直接子里有 `button`。出厂模态里只有这一个 `nav`，标题 div 不含 button，所以判据唯一。
- **行 ↔ 账本按位置对应**：出厂壳用 `rows.map(row => <button key={row.id}>…)` 渲染，keyed 列表的 DOM 顺序恒等于它那次渲染用的账本顺序。我们再用**标签文本逐位比对**校验（`button.textContent` 恰好等于 `row.label`——图标是 SVG，不含文本；已读源码确认），对不上就跳过这一帧等下一次重渲染；连续 5 帧对不上才退回「只按位置」并记诊断，宁可顺序可能错位也不要静默失效。

### 4.2 坏文件 ≠ 空文档

「JSON 合法但形状非法」（例如 `{"order": null}`、根是 `null`、`order` 是字符串）必须与语法错**同等**处理：保留上一次可用快照 + 回报原因。否则一次手抖的编辑就会静默顶掉全部布局、把用户辛苦编的分组全清空。区分口径：

- **形状级错误**（根不是对象 / `order` 不是数组 / 条目数超上限）→ 按坏文件处理，保留上次快照。
- **单项级错误**（未知 `type`、id 非法或重复、名字为空、`items` 不是数组）→ 就地丢弃或纠正，记进 `issues` 回显（回显条数夹到 20 条，逐条回显会让一个请求换回数 MB 响应）。

### 4.3 出厂导航**会**滚动 —— 我们只需补 sticky 标题

（这一节曾经写反过，留在下面当教训。）出厂设置壳的 CSS 是这样的：

```
.VOzbGW_panel   { display:flex; height:min(800px, 100vh - 48px); overflow:hidden }
.VOzbGW_nav     { display:flex; flex-direction:column; flex:none; width:188px; padding:22px 12px 0 }
.VOzbGW_navList { display:flex; flex-direction:column; gap:4px; overflow-y:auto }
```

`nav` 是面板（行向 flex，默认 `align-items:stretch`）的子项，所以它的高度被拉到面板的**确定**高度；`navList` 又是 `nav` 的 flex 项，而**带非 `visible` overflow 的 flex 项自动最小尺寸是 0**，于是它自己就能收缩并滚动。**出厂就滚得动，末行永远够得着**，不需要我们接管 `overflow` / `flex` / `min-height`。

早先那版判定「出厂没设 overflow、末行会被裁掉」，据此硬把 `flex:1 1 auto` + `min-height:0` + `overflow-y:auto` 内联上去，还按 16 行算了一套「第几组开始溢出」的预算。那条诊断来自一次**被管道截断的 grep**（`grep -oE '…navList…\{[^}]*\}'` 的输出被截掉了尾巴，而我没再核对一次）。现在自测里**直接读出厂 CSS 文件**核对 `overflow-y:auto` 确实在里面，前提一垮就失败，不必再靠猜。

分组标题仍然必须补：出厂没有 sticky，一滚就分不清「现在在哪一组」。做法是 `position:sticky; top:0; z-index:2`，背景用面板同款 `--dsw-alias-bg-layer-2` 挡住滚过去的行，6px 间隔做进盒子的 `padding-top` 而**不是** `margin-top`（margin 不属于 sticky 盒子，会在它上方留一条能看见行滚过去的缝）。另外给列表补 `padding-bottom:12px`，滚到底时末行不贴面板圆角。

卸载时这条内联样式要还原——注意**必须归一成 `''` 而不是 `undefined`**：真实浏览器里给 CSSStyleDeclaration 赋 `undefined` 会被串成非法值并被**忽略**，值就留在元素上了。

### 4.4 只比较 `Origin` 与 `Host` 是**同义反复** —— 挡不住 DNS rebinding

原先的守卫是 `new URL(origin).host === req.headers.host`。两个都是**请求方自己填的头**，所以任何能把两个头写成一致的调用方都能过——DNS rebinding 页面正是如此：它的 `Origin` 与发往本机的 `Host` 都是攻击者那个域名，自然相等。live 复现（无需任何桥）：

```bash
curl -X POST -H 'Host: evil.example' -H 'Origin: http://evil.example' \
     -d '{"baseRevision":5,"order":[]}' http://127.0.0.1:3080/dsh-settings-nav/save
# 修复前：409，而且是插件自己的冲突体 → 说明请求已经**过了**守卫
# 修复后：403
```

修复：守卫**先要求 `Host` 本身是本机 authority**（`localhost` / `dsh.local` / 环回 / 私网字面量，与 dsh-lanmode 的 `isTrustedLocalAuthority` 同一口径），再要求 `Origin` 的 host 与之相等、且 scheme 与**实际传输**一致（明文连接只接受 `http:`；顺便堵掉 `https://127.0.0.1:3080` 这种 scheme 被忽略的写法）。

这**不会**把 LAN 访问关掉：dsh-lanmode 的 bridge 会把每个上游请求的 Host 与 Origin **改写成环回 authority**（`bridge.js` 里 `const authority = '127.0.0.1:' + upstreamPort`，注释写着 "Every upstream request is host-rewritten to that authority"），所以经 LAN 进来的请求到插件手里仍然是本机 Host，照旧可写。

### 4.5 存在的文件读不动 ≠ 没有文件

`load()` 早期把非 `ENOENT` 的读失败也当成「没有文件」处理（错误分支只是往**初始空快照**上撒 `loadError`），于是 `state` 报 `{exists:false, revision:0, order:[]}`。紧接着一次 `baseRevision:0` 的保存刚好能过栅栏，`persist()` 用 rename 覆盖它（rename 只需要**目录**可写，不需要目标文件可写）——**用户的布局被静默清掉，盘上的 revision 还会从 4 退回 1**。

复现：把文件写成 `{"revision":4,"order":[{...seed}]}` 再 `chmod 000`（root 照样读得动，所以要用普通用户跑），`state` 报空 → 保存返回 200 → 文件变成 revision 1。

修复：非 `ENOENT` 的读失败记 `exists:true` + `unreadable:true`，`/save` 与 `/reset` 在这期间**拒绝**（`503` + 说明），永不覆盖。**特意不用 409**：客户端把 409 当作「采用 host 的文档」，那会用空文档把用户内存里的布局再清一遍，等于第二次丢数据。

### 4.6 声明了 body 却不发的请求会把连接挂住

`readBody` 原先只有 `data` / `end` / `error` 三个监听、没有任何超时：一个 `Content-Length: 100` 却一个字节都不发的 POST，插件这侧永远不会回响应，只有 Node 默认的 300s `requestTimeout` 兜底（dsh-host-webserver 用的是裸 `createServer`，没有另设）。N 个这样的连接就占着 N 个连接 5 分钟。现在 `readBody` 自带 15s 超时（`BODY_TIMEOUT_MS`，第三个参数可注入短值给单测）→ `408`；每个结案路径都会清掉定时器，双 settle 的防护照旧。

**这里有个只有真实走线才看得见的坑（踩过两次，都写下来）**：

1. **超时分支不能同步 `req.destroy()`**。`readBody` 一 reject，调用方是**下一个微任务**才去写 408 的，而 `destroy()` 是同步执行的——响应还没写就被连坐重置，客户端只看到 `socket hang up`，一个字的 408 都收不到。所以拆连接交给调用方、挂在 `res.once('finish')` 上（报文交给内核之后再关）：既不挂 300s，也不吞响应。
2. **状态映射要显式认 `error.statusCode`**。原先写成 `error.statusCode === 413 ? 413 : 400`，超时会被压成 **400**，文档说的 408 根本不存在。

这两条假 req/res 桩都测不出来（桩里 `destroy()` 只置一个布尔、响应也是立刻「写」完的），所以补了 `probe-http.mjs` 用真 socket 验——这个缺陷就是它抓到的。

---

## 5. 客户端行为细节

- **降级**：读不到 host（路由缺失 / dsh 没跑 / 剔除了 `webServer`）→ 管理页明确提示「只在当前页面有效」，改动仅存内存、**绝不**发写请求。导航增强在 `state.loaded !== true` 之前一行都不动（拿不到布局就不猜）。
- **写盘时机**：改动防抖 250 ms；切后台（`visibilitychange` → `hidden`）与关页面（`pagehide`）时补发未落盘的那一笔——防抖窗口内直接关标签页会丢掉最后一次拖动；插件被卸载时 `store.dispose()` 也会先尽力补发一次（清掉防抖计时器不等于可以把这次编辑扔掉）。注意**关设置弹层不算**这几种：弹层是出厂壳的组件，本插件的 store 挂在插件 fiber 上，开关弹层不会 dispose 它。
- **在途期间的编辑不会丢**：保存发出时记下「这一份是哪个 doc 引用」；回来时只有 `state.doc` 还是它才算「磁盘 == 内存」，否则保留 `dirty` 交给排水/防抖再写一次。曾经的版本在成功分支**无条件** `dirty: false`，于是一次「保存慢 + 用户又拖一下」就会让第二次编辑永不落盘，界面却显示「已保存」——刷新后改动没了。
- **冲突时保护更新的本地编辑**：`409` 且等待期间用户又改了 → **不采用** host 版本（采用就等于把那次刚做的编辑盖掉），只把基线挪到 host 的 revision，交给重投写上去。
- **写失败会自己重试**：指数退避（1.2s 起、上限 8s、最多 5 次），试满就把错误留在界面上等下一次编辑——不是一直卡在内存里等用户再动手。
- **语言进计划签名**：分组标题的「N 项」与工具条文案都来自 `t()`；切语言时账本、文档、revision 全都没变，只有文案变了，所以 `localeId` 必须进签名，否则要等用户碰一下布局才更新。
- **拖放残留清在 `detach()`**：`dragstart` 加的 `dsn-navdragging` 与落点标记（含 `dsn-drop-into`）只有 `dragend` 会清；拖到一半面板被关就再也没人清，所以 `detach()` 一并擦掉，层级缩进的内联样式也在卸载时归零。
- **隐式行也是合法落点**：账本里有、文档里没写过的设置项确实画在左列（当未分组项追加），拖到它身上时按「落到末尾」处理，不再静默不动（静默不动会让人以为拖放坏了）。
- **拖拽不需要「整理」模式**：`draggable` 与三个 `drag*` 监听对行 / 标题一律生效；`organize` 只影响虚线外框与工具条多出来的按钮。卸载时 `detach()` 照旧把 `draggable` 属性与拖拽残留类名擦干净（行属性必须归一成 `removeAttribute`，不是置空字符串）。
- **管理面的落点处理是共用的一份**：`dropProps()` 同时喂给可拖元素和「只作落点」的空分组占位条；`dragProps()` 只是 `draggable + onDragStart` 再 `Object.assign` 上它。别再各写一份，两边会漂。
- **分组标题是三段落点**（v4）：上 30% = 落到它前面、下 30% = 落到它后面、中间 40% = **放进这一组**（`ref: null`，追加成最后一个子条目；左列的标记是描边 `dsn-drop-into`，管理面是整行高亮）。设置项行只有前后两段。落到已收起的组会顺带把它展开——否则刚放进去的东西立刻藏起来，看着像没生效。
- **成环必拒**：分组拖进自己或自己的后代是空操作（文档原样返回）；两个半边（`applyDrop` 的祖先链检查 + 拖放锚点不给 `into`）各挡一道。
- **深度到顶不给「放进」**：第 4 层的分组标题不再提供 `into` 锚点（再放就要超 `maxDepth`，归一化会把整层悄悄削掉）——宁可不给落点，也不静默丢结构。
- **注册失败不拖垮页面**：`settings.section` 是同 priority 下 id 撞车就会 throw 的 list 槽位，而那个异常会穿到 `apply` 外面，让出厂壳的启动审计抛「web boot: N entries did not activate」——**整个 Web UI 起不来**。所以注册包了 `try/catch`：失败只记 warning + 留一条可查的原因，页面照常。
- **冲突**：`409` → 采用 host 的文档 + 页面顶部一条提示，不会把这次改动重试上去（重试就是覆盖别人的改动）。
- **`enabled: false`**：左列一字不改，并会把上一次留下的内联样式与自插节点擦干净。
- **失效即静默降级**：导航增强全程 `try/catch`，任何一步出错只记诊断、**绝不抛出**——设置页坏掉比「分组没生效」严重得多。定位不到导航就什么都不做，出厂行为一字不变。
- **即时生效是结构保证**：管理页与导航增强订阅**同一个**内存状态仓，管理页的所有改动都只有一种形式 `store.mutate(纯函数)`，改完立刻 emit → 增强器重刷 → 防抖落盘。中间没有事件桥，所以「管理页改了什么，左列立刻变」不依赖任何时序假设。
- **左列滚动**：见 4.3。出厂列表本来就滚（`overflow-y:auto`），我们只补 sticky 标题与底部留白，**不接管** overflow/flex。
- **当前分节不会被收起藏掉**：出厂壳把「你正在哪一节」的唯一标记（`aria-current="true"` + 一个哈希类名的背景）标在**行自己身上**，所以收起一个含当前分节的组会把「我在哪」一起藏掉——内容区在显示某一页，左列却一个字都不说。两条补救：当前那一行**永远不隐藏**（哪怕它所在的组是收起的），它所在的分组标题标上 `.dsn-navheader-active`（品牌色）。因此「当前分节」必须进计划签名，否则切分节时账本与文档都没变、签名不变，就会漏刷。

### 左列的整理模式

左列顶部有一条工具条（`order: -1000`，永远在最前）：

- **拖动**：行与分组标题**任何时刻都可拖**（不点「整理」也行）——HTML5 拖拽不影响点击导航，工具条在普通态下的 tooltip 就是这句提示。
- **整理 / 完成**：进入整理模式只多两件事——行 / 标题加虚线外框提示，工具条多出「＋新建分组 / 全部收起 / 全部展开」。**它不再是拖拽的开关**（2026-10-17 之前是：那时 `onDragStart/onDragOver/onDrop` 都先判 `organize === true`，属性 `draggable` 也只在整理态才设）。
- 拖放到某行的**上半区**=插到它前面，**下半区**=插到它后面；拖到分组标题上=按标题的上/下半区落成分组前后的位置（拖的是分组就落在分组之间，拖的是设置项就落成该分组前后的独立项）。
- 落点锚点用「**容器路径 + 参照物 + 前后**」表达（v4 起 `container` 是祖先分组 id 链，`ref: null` 表示「放进这一组」），**不用数组下标**——被拖的项已经先从树上摘掉，下标会漂，参照物不会。
- 折叠不只在管理页：导航里直接点分组标题就能收起/展开（即时 + 落盘）。

### 管理面（设置页「设置导航」一节）

布局列表（分组 / 成员 / 独立项，可拖拽，带 ↑ ↓；**子树整棵渲染、层级用缩进表达**）、重命名、删除分组（子分组整棵保留、摊回上级）、折叠开关、成员/子分组「移出分组」、每个分组行都有**「＋ 子分组」**、未分组池（**每一项都可拖**——拖进分组、拖到布局里任意位置，也可以一键「加入分组…」或「放到末尾」；下拉选项按层级缩进）、**空分组占位条是落点**（把项追加成该组第一个成员，嵌套分组也有占位条）、新建分组、全部收起/展开（含嵌套）、**预置方案**（按名字猜一套分组：模型与路由 / 会话与数据 / 工作区与上下文 / 插件与扩展 / 其它；只做关键词匹配，不硬编码任何插件名，猜错改一下即可）、恢复出厂顺序、失联项清理、诊断（文件路径、revision、持久化状态、host/client 构建标记、左列增强器计数与最近异常）。

---

## 6. 维护

loader **按 specifier 缓存模块**。0.2.0-rc.2 上实测的口径（别照抄更早版本的印象）：

- 改 **host**（`index.js`）后**必须重启 dsh 才生效**。`dsh-hmr` 确实在 watch `cordis.patch.yml` 并会 reconcile——插件管理器里能看到 `include:settings-nav` 已经指向新 entry、`fiberPhase=active`——但**运行中的 fiber 仍在跑缓存里的旧模块**，改 `name` 只更新了 Include 配置。2026-10-11 实测：补完 `inject`、把 `name` 指到 `entry-v2.js` 之后，客户端半边照常工作、`GET /dsh-settings-nav/state` 依旧 404，而且新代码里加的文件探针**一行都没写出来**（证明 `apply` 从未用新模块重跑）。
- 换 `entry-v<N+1>.js`（只做 `export * from './index.js?v=nav-<N+1>'`）仍然是**对**的做法：重启后才会重新求值，且**保持同一行 id** 能避免重复注册路由（`webServer.register` 对重复的 `(kind, path)` 会 `throw`）。只是它单独不足以让运行实例换代码。
- 2026-10-13 又实测了一次同一件事（把 `name` 改指 `entry-v3.js`）：dsh-hmr 照旧 reconcile，而 `GET /dsh-settings-nav/state` 仍然自报 `impl: index.js?v=nav-2`、`build: nav-2`，GUI 全程正常——**老模块继续跑，没有重复注册路由的报错**。所以「改 patch 行」这一步是安全的（现场可核对 `impl`）。
- **2026-10-20 的口径变了（当前 DSH 版本）**：把 patch 行改指 `entry-v5.js` 后，几秒内 `GET /dsh-settings-nav/state` 就自报 `build: nav-5`、`impl: index.js?v=nav-5`，三条路由照旧、无重复注册报错——这一版 `dsh-hmr` **真的把 host fiber 换掉了**，不需要重启。所以上面两条「必须重启」只对 0.2.0-rc.2 那个旧版本成立。判据仍然是 `impl`，改完直接查一次即可；如果 `impl` 没变，再按旧流程重启。
- 当前谱系：`index.js` 的 `BUILD = 'nav-5'` ↔ patch 行 `entry-v5.js`（`index.js?v=nav-5`）。改 host 后建议同时升 `BUILD` 与 entry 标记，让 `impl` 能一眼看出线上跑的是哪张图。
- 客户端半边自带一个独立标记 `client.js` 里的 `BUILD`（管理面状态行显示成「host / client」，现为 `nav-5 / nav-4`）。它只是给人看的诊断标，**不参与加载**：client.js 由 `dsh-client-modules` 按 fs 元数据算 rev 供 URL，改完**刷新页面**即生效。2026-10-17 那轮把它从 `nav-1` 升到 `nav-2`（可拖范围扩大）；2026-10-18 升到 `nav-3`（schema 2 嵌套）；2026-10-20 升到 `nav-4`（保存失败文案不再重复前缀）。
- profile `package.json` 里的 `dsh.profile.patchReload` 在 0.2.0-rc.2 里**没有任何代码读**（整棵安装树 grep 无命中），是惰性键。
- 改 **client**（`client.js`）后：`dsh-client-modules` 按内容 sha1 供 URL，刷新页面即生效，**不用**重启。
- **回滚的正确姿势**：`entry-v*` 只是 specifier 别名、**不是代码快照**——把 patch 行的 `name` 指回旧 entry 不会退回旧代码（`index.js?v=…` 标记一变就是新代码）。要真正回滚，先用备份覆盖 `index.js`，再写一个新标记的 entry 并把 `name` 指过去（当前版本会热换；若 `impl` 没变再重启）。

生效判据：`curl http://127.0.0.1:3080/dsh-settings-nav/state` 的 `build` 与 `impl` 字段（`impl` 是 `index.js?v=nav-N`，带缓存标记，才是「线上跑的是哪张图」的证据）。注意 `build` 单独**不能**区分版本——它是文件里的常量，v1 的备份文件里也可能已经是 `nav-2`；只有 `impl`（模块自报的 specifier）能区分。

**本谱系没有可用的 pre-v2 快照**：`index.js.bak-20261011-113525-is-actually-v2.js` 与当时的 `index.js` **逐字节相同**（名字里写清 `is-actually-v2` 就是为了不再被骗），所以它无法把代码退回 v1。真要回滚，必须在改动**之前**自己留一份备份（这也正是上面那条流程的写法），或者直接按 v1/v2 的差异手工改回（v2 相对 v1 只多了 `export const inject = ['webServer']` 并把 `BUILD` 改成 `nav-2`）。

### 6.1 `inject = ['webServer']` 是「硬依赖」写法（不是唯一写法）

`webServer` 的服务契约把访问方式写成两种：**optional**（`ctx.get('webServer')`，**必须判 undefined**）和 **hardDependency**（`inject: ['webServer']`，之后直接 `ctx.webServer`）。本插件用后者，所以 `index.js` 里那段 `ctx.get('webServer')` + warn 只是防御性残留——`inject` 声明到位后它其实不可达。

**选硬依赖的机制理由**：cordis 只对 inject 声明过的 fiber 做等待（`if (!(name in fiber.inject)) continue`），不声明就可能在服务就绪前跑 `apply`。

但有两件事要说清楚，别当成普遍规律：

- 兄弟插件里用硬依赖的是 **`dsh-model-groups` / `dsh-model-pool` / `dsh-subagent-models` / `dsh-usage-stats` 这四个**；`dsh-workspace-context`（完全没有 inject）与 `dsh-workspace-plugins`（`inject = []`）走的是 optional + 判 undefined，**同样是对的**。所以「每个注册路由的兄弟插件都用硬依赖」是错的。
- 「v1 漏了 inject 导致三条路由静默不注册」是当时的**叙述，不是可核实的证据**：本谱系没有 pre-v2 快照（见 6 节），而 `index.js.bak-*` 与 v2 逐字节相同。**机制成立，具体那次事故无法复现**，别再当史实引用。

## 6.2 Windows 落盘必失败：`EINVAL: invalid argument, mkdir 'C:\:'`（nav-5 已修）

**症状**：Windows 上任何一次保存（管理页改动、`POST /save`、`POST /reset`）都 500，`GET /state` 的 `diag.lastError` 为 `EINVAL: invalid argument, mkdir 'C:\:'`；管理面显示的文案还是双前缀：`布局写入失败：布局写入失败：EINVAL …`。

**根因**：`ensureDirSync` 把「绝对路径的根」写死成 `sep`，用 `absolute.slice(1).split(sep)` 逐级切。这在 POSIX 上成立（`/usr/local` → `usr`、`local`），但 Windows 绝对路径是 `C:\Users\…`：`slice(1)` 之后第一段就是盘符里的 `:`，于是拼出 `C:\:` 去 `mkdirSync`，必然 `EINVAL`。**与布局文件是否已存在无关**——第一段永远非法，所以 Windows 上从第一次保存起就没成功过。UNC（`\\server\share\…`）同理。

**修法**：以 `path.parse(absolute).root` 为根（POSIX 是 `/`，Windows 是 `C:\`，UNC 是 `\\server\share\`），从 `absolute.slice(root.length)` 开始逐级切；root 自带尾部分隔符时直接拼接。保持「逐级非递归」不变（recursive mkdir 在 procfs 上会挂死 JS 线程，见函数注释）。

**客户端文案**：host 的路由出口本来就会给 5xx 拼一次 `布局写入失败：`，客户端 `flush()` 又拼一次。现在 `saveFailure()` 只在 host 文案没有该前缀时补前缀，两边各自独立也能看。

**回归**：`selftest.mjs` 的 `ensureDirSync` 用例在 Windows 上会**先用盘符绝对路径**建多层目录（旧代码在这里直接抛 `EINVAL`）；v5 另用「`$DSH_HOME` 指向不存在的深层目录」跑了一遍默认路径的真实落盘（revision 1→2、文件内容正确）。2026-10-20 本机实测：`node selftest.mjs` 204 项全过（「文件不可读冻结」在 Windows 上按既有逻辑跳过）；live `/state` 自报 `build: nav-5`、`impl: index.js?v=nav-5`、`lastError: null`。

**同类隐患**：`dsh-model-groups/index.js` 与 `dsh-ultracode/inject-v3.js`、`inject-v4.js` 里各有一份相同的 `ensureDirSync` 抄本，同样会在 Windows 上失败；这两处目前没有实际落盘需求（相关文件都还不存在），所以尚未暴露，本次没有改动它们。将来要修就照 v5 的写法改，别只改一处。

## 7. 自检

```bash
node plugins/dsh-settings-nav/selftest.mjs          # host：204 项（假 req/res 桩，逐分支）
node plugins/dsh-settings-nav/client-selftest.mjs   # 浏览器半边：399 项
node plugins/dsh-settings-nav/probe-http.mjs        # host：真实走线（临时端口，不碰在跑的 dsh）
```

`probe-http.mjs` 是 `selftest.mjs` 的补充而不是重复：单元自测伪造了请求头，而 4.4 那个漏洞**恰恰是「头本身不可信」**，所以那条修复值得用真正的 `http.request` 再验一遍端点事实。它挂在临时端口 + 临时目录上，跑完即删，不碰正在运行的 dsh、不碰 `$DSH_HOME/settings-nav.json`。**别用 root 跑**：`chmod 000` 挡不住 root，B 段会有一条明确的前置条件断言失败，那是提醒「现在验的没意义」。**Windows 上同样如此**：`chmod 000` 只去掉写权限、读照样成功，所以 B 段的前置断言必失败，连带「unreadable / warnings / save 503 / reset 503」四条一起失败（`/reset` 还会因目标只读而 500）——这是检测环境的限制，不是插件回归；要验不可读冻结，得在 POSIX 或用 ACL 真正拒绝读。

`selftest.mjs`：归一化（形状错 vs 单项错的分界、重复 id、未知 type、名字回落、上限、**超长名字/id 的截断要记进 `issues` 而不是静默丢**、**v4 起递归嵌套：三层结构原样保留 / 深度上限整棵丢并点明位置 / `items` 里的杂物只丢自己 / id 账全树共享**）、真实临时目录落盘与原子写、revision 单调不减、坏文件/形状非法保留上次快照、**外部改写后立刻可见（没有 TTL 缓存窗口）**、写盘失败（父路径被文件占住）→ 500 且 **advertised revision 不前进、目标文件逐字节未变**、冲突 409 **且盘上内容逐字节未变**、三条路由的方法 / 同源守卫（可信 authority 与不可信 authority / scheme 与实际传输 / IPv6 回环 / **没有 Host** / `Origin: null` / 跨站）/ 413 / **读超时 408（含"readBody 不自己 destroy"与 413→408→400 的状态映射）** / bad JSON / 无 `webServer` 降级、**文件存在但读不动 → `unreadable:true` + `/save`、`/reset` 都 503 且逐字节未变、权限恢复后自动解冻**、dispose 后重挂不重复注册路由、`cacheTtlMs` 不再是配置项。

`client-selftest.mjs`：自带极小 hooks 运行时（组件真的重渲染）与一台够用的假 DOM（Element / classList / style / closest / 事件冒泡 / `getBoundingClientRect` / `querySelector(All)`），因此导航增强器是**真的**在定位、插标题、设 order/display、收事件、算落点；假 host 让 `/state` 与 `/save` 真实往返（含 409 冲突、500、断网三条异常）。断言集中在用户实际要的两件事：**分组收纳**（标题出现、折叠后成员真的不显示；v4 起含**嵌套**——子树级折叠、祖先收起时子分组标题连带隐藏、「N 项」数整棵子树、层级缩进、`＋ 子分组` 真的挂在父组里）与**即时改排序**（管理页动一下，左列 DOM 的 `order` 当场变）；另有一组专门守住**在途保存与排队编辑**（保存慢时又改一次，那次编辑必须真的落盘——曾经被 `dirty:false` 吞掉）、409 时保护更新的本地编辑、写失败后的有界重试、卸载时补发最后一次编辑、**切语言要重刷**（账本/文档/revision 都没变）、**拆卸后残留的帧不能把增强器复活**、拖放残留清理（先造出残留再断言它被擦掉，否则是空话）、拖到「账本有、文档没写」的隐式行上必须真的动、**未分组池的项可拖且空分组占位条可落**、**不点「整理」也能拖左列**（这三处都做过变异测试：把实现改回去，断言立刻失败，所以它们不是恒真的）、以及**注册撞车不能把整个页面拖垮**。4.3 那节的前提由一条**读出厂 CSS 文件**的检查钉住（`overflow-y:auto` 一旦消失就会失败，提醒接手的人重新考虑是否要接管滚动）。
