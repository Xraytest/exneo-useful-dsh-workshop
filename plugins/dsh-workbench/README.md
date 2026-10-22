# dsh-workbench — 输入框工具行的「工作箱」

用户指令（2026-10-22）：把 Ultracode 的位置换成一个**工作箱图标**，点击后展开
**工作列表**（Ultracode、REA），**复选选中后才把相关上下文注入窗口**；对 REA，
不选中 = **零 REA 上下文**。

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

## 语义

| 项 | 勾选 | 未勾选 |
|---|---|---|
| Ultracode | 转发 `/dsh-ultracode/set {active:true}`——装配期直注 Ultracode 段并改写 `tool:workflow` 段（dsh-ultracode 既有逻辑，家族级、落盘） | 转发 `{active:false}`——注入收口段，一个字不多 |
| REA | 经 `/dsh-rea-mcp/workbench {on:true}` 打开 `masterEnabled`（保留用户在设置页精挑的工具白名单）；`mcp:rea` 提示段保留 | `masterEnabled=false` → rea-mcp 用 `tools.restrict()` 把全部 207 个 `mcp__rea__*` 从每个 Agent 的工具面摘除（schema 不下发、调用报 UNKNOWN_TOOL）；**并且**本插件在 `system-prompt/assemble` 瀑布里删掉 `mcp:rea` 提示段——两条加起来才是「零 REA 上下文」 |

「零上下文」的两件事缺一不可，这就是为什么 REA 的摘除分两处：
工具 schema 在 rea-mcp（它持有 `tools.restrict` 的白名单状态），
说明文字段在 workbench（`dsh-mcp-client` 把 instructions 注册成全局
systemPrompt section 且没有开关，只能由装配瀑布最后一手删）。

## 状态

- 每个会话（按 **ultracode 同款家族谱系**）一份勾选，落盘 `$DSH_HOME/workbench.json`
  （0600、原子写、跨进程合并；家谱只读 `ultracode.json` 的 families 表——
  家谱事实的唯一写者仍是 dsh-ultracode，本插件绝不重复记）。
- 分支上勾选 = 全家族一起勾选（与 ultracode 家族行为对齐）。

## 路由（同源守卫）

```
GET  /dsh-workbench/status?sessionId=…  → 勾选状态 + 条目 + REA/ultracode 实况
POST /dsh-workbench/set                 ← { sessionId, checked: [id…] }
POST /dsh-workbench/reset               ← { sessionId }   （清空勾选并 reset ultracode）
```

## 自测

```
node plugins/dsh-workbench/host-selftest.mjs     # 14 项：路由/家族/摘段/恢复
node plugins/dsh-workbench/client-selftest.mjs   # 44 项：渲染/开合/乐观翻转/回滚/圆点角标
```

## 维护

- `client.js`：内容哈希供包，改完**刷新页面**。
- `index.js`：Loader 按 specifier 缓存——新写 `entry-v<N+1>.js`（`?v=` +1），
  把 `cordis.patch.yml` 里 `workbench` 行的 name 指过去（**row id 不变**），
  再 remove → install 本 bundle。

## 相关插件

- `dsh-ultracode`（胶囊让位 order 90，逻辑不动）
- `rea-mcp`（+`/dsh-rea-mcp/workbench` 直连路由，只翻 `masterEnabled`）
- `dsh-plugin-autoupdate`（设置页「插件更新」，本插件的新版本同样会被它监看）
