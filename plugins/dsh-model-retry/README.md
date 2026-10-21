# dsh-model-retry —— 按模型 / 按分组的重试策略

接管出厂重试执行器（`dsh-llm-retry`，patch 行 `- id: llm-retry / disabled: true`），
在同一个 `agent/request-error` waterfall 上执行，并增加三件事：

1. 策略按 **`(provider, model)`** 匹配规则（出厂只能按 provider 配 `retryPolicy`）；
2. 触发条件除失败类别码外支持 **HTTP 状态码**（429/500/…），与类别码并集生效；
3. **规则可按「模型分组」命中**（v2，分组来自 `dsh-model-groups`）——一条规则给整组模型
   （成员可跨供应商）下同一套策略。

管理入口：设置页 **「重试策略」** 一节（order 30），含按组选择器、试算面板、逐卡「复制」。

## 规则与优先级（v2 冻结口径）

规则文件 `$DSH_HOME/model-retry-rules.json`，每次失败现读现用（改文件即热生效）：

```json
{ "rules": [
  { "provider": "*", "model": "*", "group": "free-lane", "mode": "always",
    "backoff": { "initialDelayMs": 300, "maxDelayMs": 5000, "jitterRatio": 0.1 } },
  { "provider": "localhost", "model": "deepseek-ai/deepseek-v4.1-flash", "mode": "always" }
] }
```

三个选择器 `provider` / `model` / `group` 是**与**关系（写了就必须命中）；命中后按
「选择器权重之和」打分，分高者胜，**同分取文件中靠前者**：

| 分数 | 组合 | 含义 |
| --- | --- | --- |
| 7 | group+provider+model | 组里某供应商的某模型 |
| 5 | group+provider / group+model | 组里某供应商 / 组里某模型 |
| 4 | provider+model | 单路由精确 |
| 3 | group | 仅按组 |
| 2 | provider 或 model | 单选择器 |
| 0 | 全通配 | 全局缺省覆盖 |

（权重：provider 字面 2 · model 字面 2 · group 命中 3）

语义要点：

- **只按组的规则 (3) 不会盖掉已有的单路由精确规则 (4)**：旧规则库升级后行为稳定；
- **只按组的规则 (3) 一定盖掉 provider/model 通配规则 (2)**：这才是「给整组下策略」的用途，
  且不受规则先后顺序影响；
- 组规则显式再钉 provider/model（5/7）＝更具体，会优先于单路由精确规则——设置页「试算」
  会在保存前把归属算给你看；
- `group` 规则只在 `dsh-model-groups` 在线、且该 `(provider, model)` 确实归属该组时命中；
  插件不在线或组被停用/删除 → 静默不命中（`GET /rules` 带 `warnings` 提示）；
- 分组归属是 `(provider, model)` 的函数、与重试次数无关，故 `policyKey` 在重试过程中稳定，
  `llmRetryModel` 投影的预算折叠不会被抖动打乱。

**与 v1 的等价性**：原始 v1 源码已不在磁盘上（`index.js` 现在只是再导出 `entry-v2.js`）。
`selftest.mjs` 里 700 组随机规则的对照，比对的是一份**按 v1 契约独立转写**的参考实现
（0/2/4 打分、同分取靠前、无 group 概念）——它证明的是「无 group 的规则集在 v2 下
选择结果不变」，而不是与已消失源码的逐字节对照。

## 上限（客户端与 host 同口径）

| 项 | 上限 |
| --- | --- |
| 规则条数 | 64 |
| `maxRetries` | 0..1000 的整数（`always` 模式不下发） |
| `provider`/`model`/`group` | 200 字符 |
| `retryableCodes` | 32 个，每个 80 字符 |
| `statusCodes` | 64 个，100..599 的整数 |
| 退避延迟 | `initialDelayMs`/`maxDelayMs` 为 **(0, 2147483647] ms**（写路由的下界是「大于 0」，实测 0.5 可存；消费方 `dsh-llm` 另要求 `initialDelayMs <= maxDelayMs`）；`jitterRatio` 0..1 |
| 请求体 | 256 KiB（超限回 413 JSON，不 reset 连接） |

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-model-retry/rules` | `{rules,error,defaults,knownCodes,groups,groupsAvailable,warnings}` |
| POST | `/dsh-model-retry/rules` | 校验（zod）→ 归一化（`*` 统一、去重、空 `group` 整字段丢弃）→ 原子写 |
| POST | `/dsh-model-retry/preview` | `{provider,model}` → `{groupId,groupName,ruleIndex,rule,policy,scores[],source}` |

`preview` 是设置页「试算」的后端：用**真实匹配逻辑**（同一个 `scoreOf`/`matchRule`）回报
每条规则对该路由的得分，前端不复刻打分规则——口径永远只有一份。

读路径的健壮性（2026-10-08 修复）：规则数组里的**非对象条目**（`null`/数字/字符串）
在读取出口就被剔除并逐条告警，`GET /rules`、`/preview`、匹配、排序只见对象；
**JSON 合法但形状坏**的文件（根不是对象、`rules` 不是数组）返回 `rules: []` 的同时带
`error`，设置页会显式显示「读取规则文件出错」，不会静默成「空配置」而被自动保存覆盖。
**读路径的限值净化（2026-10-08 第二轮）**：规则文件是「现读现用」的热配置，写路由
的 zod 上限拦不住手工编辑。越界/非数值的 `maxRetries`（如 `5000000`、`"abc"`）、含越界
成员的状态码数组、越界或全坏的 `backoff` 一律**摘掉该字段并逐条告警**（回落出厂缺省），
不会原样生效变成无上限重试（消费方 `dsh-llm` 本身允许 `maxRetries` 到 `MAX_SAFE_INTEGER`，
这里不拦就没有第二道闸）。逐条告警以 10 条为上限，超出部分折成一行
「另有 N 处越界限值已摘除」——**不会静默**（字段照摘，只是不再逐条列出）。

请求体读取用 `setEncoding('utf8')`（StringDecoder）：跨 TCP 分块的多字节字符不再被插
U+FFFD；413/400 之后的排空**有界**（超预算即断开），持续投喂的客户端不能无限占住 socket。

写路由同样拒绝 `Origin: null`（403），无 `Origin` 头（curl）放行。`GET /rules` 带
`build` 标记，用于确认线上跑的是哪一版实现。

## 机制（与出厂执行器逐项对齐）

- 每次重试先落 durable `llm/retry` 事件（含 `model`，投影以此识别本插件的重试），
  退避等待前写 `llm/retry-started`，返回 `{kind:'retry'}` 让 agent loop 在同一 open turn
  内重跑失败步；
- 预算经 `sessionProjections`（key `llmRetryModel`，`stateVersion: 1`）从会话日志折叠，
  `step/start` 与 `turn/end` 归零；
- **provider 的 `Retry-After` 优先**（适配器把 `retry-after` 头解析成
  `providerRetryAfterMs` 放进失败载荷，`entry-v2.js` 的恢复分支读它）：
  该值 > `policy.backoff.maxDelayMs` 时，**普通模式直接放弃本次重试**、
  **`always` 模式回落本地退避**；否则本次等待就等于该值（不再叠加指数与抖动）。
  没有该字段时一律走本地退避（`localDelay`：指数 + 抖动，钳到 `maxDelayMs`）。
- `always`（不限次）模式先问下游、忽略下游失败；
- 未匹配任何规则的模型完全按适配器自带 `retryPolicy` 执行（出厂缺省：普通 5 次、
  五类失败码、500ms→10s）。

## 文件与热更新

- `entry-v2.js`：实现本体（含分组、试算、读路径净化；`build` 标记 `fix-2`）。
- `entry-v4.js`：**当前挂载的热挂入口**（`export * from './entry-v2.js?v=fix-2'`）——
  本 profile 的 loader 按 specifier 缓存模块，原地改 `entry-v2.js` 不会重新求值，
  故换 specifier 重挂，**保持同一行 id**（loader 走 dispose→start，不会重复注册路由）。
- `entry-v3.js`：上一代热挂入口（`?v=fix-1`），**已成孤儿**（没有行引用它）。
  留着只为「回滚到上一版」时改 patch 行 name 用；确认不需要可删。
- `index.js`：稳定包入口，`export * from './entry-v2.js?v=fix-2'`（带标记，因而与
  `entry-v4.js` **指向同一个模块实例**，两条路径不会跑到不同版本上）。
- `client.js`：设置页「重试策略」；`dsh-client-hmr` 热替换，刷新浏览器即生效。

## 设置页行为（2026-10-08 修复）

- **模式往返不丢数据**：`normal → always → normal` 之后，用户填的 `maxRetries`、
  触发类别码、自定义状态码原样保留（切模式只影响下发的 payload）；
- **填写即校验**：`maxRetries` 等越界值给 inline 错误并**不发 POST**，不会让整批规则
  永久 400 连坐；规则条数超 64 也先拦下并说明；
- **保存失败说人话**：翻译 host（zod）的 `规则校验失败: rules.<i>.<字段>: …` 与
  `rules: Too big: …`（字段级 vs 整数组超限分得清），并给显式「重试保存」按钮，
  不静默重发；
- **稳定 key**：每张规则卡有独立 `uid` 作 React key（删除/复制规则后不受控输入不错位）；
- **加载失败有出路**：任何失败（非 JSON 4xx、网络错、响应体不是对象、`rules` 不是数组）
  都进 error 态并显示「重试」，绝不停在「加载中…」；host 200 但带 `error` 时把原因显示出来；
- 磁盘上手改出的越界状态码（如 `999`）在卡片上有可点掉的 `✕` 入口，不会把整页锁死；
- **越界的选择器有卡内提示**：`provider`/`model`/`group` 超过 200 字符时，规则卡里直接
  写明是哪个字段超长（原先只拦不发 POST，而页头提示「见规则卡内提示」——用户找不到原因）；
- **读取出错后不再自动保存**：host 报告「规则文件读不出来」时，页面显示的是兜底空集，
  任何自动保存都会覆盖用户文件；闸门对**同一实例的二次加载**同样有效，直到文件可正常
  读取（或用户显式保存成功）才解除。

## 自检

```bash
node plugins/dsh-model-retry/selftest.mjs          # 32 项：打分/优先级 + v1 口径等价 + 路由 + 恢复决策 + 坏输入/请求体加固 + 读路径限值净化 + 跨块 UTF-8 + 排空有界 + 告警上限汇总
node plugins/dsh-model-retry/client-selftest.mjs   # 27 项：设置页无头渲染（按组选择器 / 自动保存 / 试算 / 模式往返 / 真机 400 文案 / 越界 inline 提示 / 读取出错闸门）
```

自测全程把 `DSH_HOME` 指向临时目录，并在开跑前断言这一点——不会碰真实的规则文件。

## 已知限制（2026-10-08 独立验证报出，未改）

- **`llm/retry` 的 `model` 成员不在 released v2 格式的准入清单里**：本插件写 durable
  `llm/retry` 时多带一个 `model`（工厂执行器不带），而安装包自带的 v2→v3 迁移对
  `llm/retry` 只认 `retry/turn/step/retryId`（可选 `maxRetries`）——含本插件重试事件的
  **v2 格式会话**迁移时会硬失败（`SessionFormatUnsupportedMigrationError`）。
  当前潜伏：本机所有会话都是 v3，只有导入旧的 v2 存档或降级构建才会命中；但已落盘的
  这类事件有 2 万余条。修法在 DSH 侧（把 `model` 加进 released 准入清单）或本插件侧
  （不再写 `model`，改用别的可辨识字段——但准入清单里没有等价的合法字段）。
- **读取出口只净化已知字段**：规则里多余的未知键不会传下去——`policyFor()` 是逐字段
  重建策略对象（只带 `mode/maxRetries/retryableCodes/statusCodes/backoff`），所以手写的
  垃圾键进不了 `dsh-llm`；代价是它们也不会被报告（既不影响运行，也不值得为此报警）。
