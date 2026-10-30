# dsh-workbench — 输入框工具行的「工作箱」

用户指令（2026-10-22）：把 Ultracode 的位置换成一个**工作箱图标**，点击后展开
**工作列表**（Ultracode、REA），**复选选中后才把相关上下文注入窗口**；对 REA，
不选中 = **零 REA 上下文**。

v2（2026-10-28，用户指令「启动按钮放到工具箱内」）：工作列表在开关条目之外
增加**动作条目**——点一下 = POST 一次，不在本插件落盘勾选。
第一个动作条目：**双主智能**（dsh-dual-agent）的三态按钮。

v2.1（2026-10-29，用户反馈「启动按钮 ui 错误」）：动作条目改为**三态驱动**。
属主回 `phase`（off/armed/running）为真值、`running` 布尔为兼容派生值；
按钮随阶段显示 `启动` / `取消待命` / `停止`，另有「待命中 / 运行中」徽标；
阶段说明（属主 note）单独一行，不覆盖功能说明。

v3（2026-10-29，用户指令「启动通道的 UI 也放在工具箱内」）：动作表新增
**管理员权限通道**（属主 dsh-admin-channel，`kind: 'switch'`）。拨开 = 属主
弹一次 UAC 并拉起常驻提权进程；勾选态/阶段/阶段说明/悬停提示全部来自
属主 `/dsh-admin-channel/status`，工作箱不复制任何提权逻辑。`/status` 探测
回包新增可选 `hint`（随阶段变化的悬停提示），client 优先使用它。

v3.4（2026-10-30，用户指令「主页面不要用已停止，用执行中」）：双主智能的阻塞
语义会把主 Agent 的任务回合 cancel 掉，内核据此记 `turn/end reason='aborted'`，
而 dsh-client-ui-chat 的 `message.stopped`（「已停止」）正是渲染给这种回合的
标签——于是用户每发一条任务，主页面就出现一个「已停止」，观感像坏了（活其实
正在后台执行者那里干）。client 在双主智能处于 **armed/running** 时把该标签
改写为「执行中」；回到 **off** 时还原（用户自己按停止键仍看到「已停止」）。
实现：宿主 locale 字典按引用查找，直接改 chat ns 里 entries 对象的
`message.stopped`；原始值快照在 dict 上只写一次，改写/还原不漂移；全程
try/catch，宿主内部结构若变则静默降级。`client-selftest-v3.mjs` 覆盖 14 项
（改写/还原/不漂移/结构异常不抛）。

## 界面

- 座位：`conversation.input.left`，**order 23**（正是原 Ultracode 胶囊的位置）。
  **原 ultracode 按钮已删除**（2026-10-22 用户指令「去掉原来的 ultracode 按钮」）：
  dsh-ultracode 的 client 不再注册任何槽位，点亮/熄灭的唯一入口就是工作箱列表
  里的 Ultracode 开关行；其 host 半边（状态机/家族/落盘/路由）零改动。
- 收起：一颗 28px 圆角胶囊（与权限选择器同高），内有一个「电源符号」图标
  （2026-10-22「改一下图标图案」；r=3.4 圆弧 + 顶杆），有勾选项时右上角亮一粒
  **圆点角标**（2026-10-22「圆点角标而不是方形」，数量在浮层头部与悬停 title 里）。
- 展开：浮层列出工作项——每行「**开关**（track+thumb，`role="switch"`）+ 名称 +
  一句描述」，**乐观翻转**：点下第一帧就翻过去，`POST /dsh-workbench/set`
  随后台发出，失败才回滚并在浮层给红字；下一次请求就是新上下文。
  点浮层外或 Esc 收起。（2026-10-22「换成开关样式」；浮层无入场动画——
  「点击秒开」。）
- **浮层底部没有常驻说明文字**（2026-10-30 用户指令「去掉工具箱插件页面底部的
  文本描述」）：原底注那段「拨动开关即时生效…」长文已删除，`.wb-note` 样式
  一并移除。说明只在悬停 title 与每行自己的描述里，浮层里不再有整段提示语。
- **动作条目**（v2.2）：与开关条目同款的**开关**（track+thumb，`role="switch"`），
  不再是一颗按钮。开关表示「该动作是否启用」，勾选态由属主 status 折算：
  - `checked` = 属主 `running`（即 `phase !== 'off'`）；行尾状态点同款（开=绿/关=灰）
  - 徽标依 `phase`：`armed` → 「待命中」，`running` → 「运行中」
  - 点击上送**目标状态** `{ sessionId, actionId, enabled }`，属主按目标推进，
    不再由属主猜「下一次点击该进哪一态」（消除 8s 轮询滞后导致的错态执行）
  - 行内常驻功能说明 + 单独一行阶段说明；属主缺席→禁用并说明原因；
    请求在飞时禁用（防连点竞态）

## 语义

| 项 | 类型 | 行为 |
|---|---|---|
| Ultracode | 开关 | 勾选转发 `/dsh-ultracode/set {active:true}`——装配期直注 Ultracode 段并改写 `tool:workflow` 段；未勾选转发 `{active:false}`——注入收口段 |
| REA | 开关 | 勾选经 `/dsh-rea-mcp/workbench {on:true}` 打开 `masterEnabled`；未勾选 → rea-mcp 用 `tools.restrict()` 摘除全部 `mcp__rea__*` + 本插件在 `system-prompt/assemble` 瀑布里删掉 `mcp:rea` 提示段 |
| 双主智能 | **开关** | 拨开转发 `/dsh-dual-agent/action { sessionId, enabled:true }` → 武装待命（键入初始指令才孵化执行者）；拨关转发 `{ enabled:false }` → 中断执行者（不挑刺）并解除。语义全在 dsh-dual-agent，本插件只画开关 |
| 管理员权限通道 | **开关** | 拨开转发 `/dsh-admin-channel/action { sessionId, enabled:true }` → 属主弹一次 UAC 并拉起常驻提权进程；拨关 → `{ enabled:false }` 结束提权进程。勾选态/阶段/说明/悬停提示全来自属主 `/dsh-admin-channel/status`；本插件不实现提权 |

「零上下文」的两件事缺一不可，这就是为什么 REA 的摘除分两处：
工具 schema 在 rea-mcp（它持有 `tools.restrict` 的白名单状态），
说明文字段在 workbench（`dsh-mcp-client` 把 instructions 注册成全局
systemPrompt section 且没有开关，只能由装配瀑布最后一手删）。

## 状态

- 开关条目：每个会话（按 **ultracode 同款家族谱系**）一份勾选，落盘
  `$DSH_HOME/workbench.json`（0600、原子写、跨进程合并；家谱只读
  `ultracode.json` 的 families 表——家谱事实的唯一写者仍是 dsh-ultracode，
  本插件绝不重复记）。分支上勾选 = 全家族一起勾选。
- 动作条目：**不落盘**——running 真值每次 status 轮询时向属主插件现问
  （`GET <属主路由前缀>/status?sessionId=…`）。

## 路由（同源守卫）

```
GET  /dsh-workbench/status?sessionId=…  → 勾选状态 + 条目 + 动作实况 + REA/ultracode 实况
POST /dsh-workbench/set                 ← { sessionId, checked: [id…] }
POST /dsh-workbench/reset               ← { sessionId }   （清空勾选并 reset ultracode）
POST /dsh-workbench/action              ← { sessionId, actionId }   （v2：转发属主插件）
```

## 自测

```
node plugins/dsh-workbench/host-selftest.mjs          # 21 项：路由/家族/摘段/恢复/开关契约
node plugins/dsh-workbench/client-selftest.mjs        # 44 项：渲染/开合/乐观翻转/回滚/圆点角标
node plugins/dsh-workbench/client-selftest-v2.mjs    # 40 项：开关渲染/乐观翻转/目标态上送/真值合并/失败回滚/旧 host 兜底
```

## 维护

- `client.js`：内容哈希供包，改完**刷新页面**。
- `index.js`：Loader 按 specifier 缓存——新写 `entry-v<N+1>.js`（`?v=` +1），
  把 `cordis.patch.yml` 里 `workbench` 行的 name 指过去（**row id 不变**），
  再 remove → install 本 bundle。当前：**entry-v3.js / ?v=wb-5**。

## 相关插件

- `dsh-ultracode`（胶囊让位 order 90，逻辑不动）
- `rea-mcp`（+`/dsh-rea-mcp/workbench` 直连路由，只翻 `masterEnabled`）
- `dsh-dual-agent`（v2 动作条目的第一个属主：双主智能启动/停止）
- `dsh-plugin-autoupdate`（设置页「插件更新」，本插件的新版本同样会被它监看）

