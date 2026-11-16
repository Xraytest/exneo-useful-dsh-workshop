# 标题插件「有时检测不到上下文」检修报告

- 日期：2026-11-02
- 对象：`dsh-session-title-context`（profile `desktop`，host 半边）
- 结论先行：**上下文构造代码没有 bug**。重放 5 个真实会话日志，`buildTitleContext()`
  在包括 4 个失败会话在内的所有用例上都返回了完整可用的上下文。真正的断点在下游，
  根因是 `readConfig()` 把组合行里的 `cadence: all-prompts` 静默吞成了 `first-prompt`。

---

## 1. 证据：先把真实日志重放一遍

用 asar 解包器取出 `@deepseek-ai/dsh-session` / `dsh-llm` 等包，在 Node 里重建真实
`Session`，直接调用插件导出的 `buildTitleContext()`：

| 会话 | 事件数 | 人类消息 | 重放结果 |
|---|---|---|---|
| session-92455857（fallback-only） | 619 | 1 | messages=1, seqs=[8] ✅ |
| session-9f258a6b（fallback-only） | 18 | 1 | messages=1, seqs=[8] ✅ |
| session-bdf6fe52（fallback-only） | 732 | 1 | messages=1, seqs=[8] ✅ |
| session-5761e3dd（fallback-only） | 19 | 1 | messages=1, seqs=[9] ✅ |
| session-27428b24（对照组，成功） | 537 | 1 | messages=1, seqs=[9] ✅ |

**四个失败会话的上下文都是好的。** 所以问题不在"检测上下文"这一环。

## 2. 全局量化

扫描 `~/.dsh/sessions/` 全部 429 个会话目录、解压 412 个含人类消息的会话日志：

| 指标 | 数值 |
|---|---|
| 有 `session/title` 事件的会话 | 412 |
| 标题来源为 `fallback` 的事件 | 412 |
| 标题来源为 `provider` 的事件 | 166 |
| **拿到过 provider 标题的会话** | **98** |
| **从未拿到 provider 标题的会话** | **314** |
| 子代理会话（有 parentSession） | 291，其中只有 4 个拿到过 provider 标题 |
| 顶级会话 | 121，其中 94 个拿到过 |

按路由交叉：

| 路由 | 顶级会话数 | 拿到 provider 标题 |
|---|---|---|
| insidegate/step-5-preview | 59 | 51 |
| opencode-go/deepseek-v4.1-flash | 26 | 21 |
| **zcode/GLM-5.3-Flash** | 9 | **0** |
| deepseek-account/deepseek-flash | 6 | 6 |
| 其余各路 | ~20 | 大多成功 |

## 3. 根因

### ① `cadence: all-prompts` 被静默吞掉（主因）

`readConfig()` 原来是：

```js
cadence: value.cadence === 'first-prompt' ? 'first-prompt' : DEFAULT_CONFIG.cadence,
```

`DEFAULT_CONFIG.cadence` 本身就是 `'first-prompt'`，所以配置里写的 `'all-prompts'`
走到 else 分支、又落回 `'first-prompt'`。上面的校验明明接受了 `'all-prompts'`，
这里却把它丢掉——典型的"校验过、没用上"。

实证（`node` 直接跑 `readConfig`）：

```
cadence: all-prompts (profile config) -> cadence=first-prompt   ← bug
cadence: first-prompt                  -> cadence=first-prompt
cadence omitted                        -> cadence=first-prompt
cadence: garbage                       -> THREW
```

后果落到 `dsh-session-title` 服务的排程条件上：

```js
if (registration.provider.automatic === "all-prompts"
    || session.header.parentSession === void 0 && count === 1 && this.get(session) === void 0) {
  state.pending = { ... };
}
```

`automatic` 实际是 `'first-prompt'`，于是：

- **子代理会话**（`parentSession` 有值）永远不排标题任务。
  时间线证据：插件文件最后写入时间是 2026-10-24 14:25:41；4 个拿到过自动标题的
  子代理会话全部创建于**该时刻之前**（01:27 / 01:35 / 02:18 / 02:44）。之后 287 个
  子代理会话，0 个有标题。
- **顶级会话**只剩"第一条消息"这唯一一次机会。那次请求一旦失败，就再也没有重试，
  标题永远停在确定性 fallback（= 首条消息截断）上。用户看到的就是
  "标题检测不到上下文 / 标题不反映对话"。

这就是"**有时**"的来源：第一次请求成功就正常，失败就永久停在 fallback。

### ② 第一次请求为什么有时会失败

从 `~/.dsh/usage-stats/facts/*.json` 的 `auxFacts`（`u: "session-title"`）统计
93 个发起过标题调用的会话、182 次调用：

| 结果 | 次数 |
|---|---|
| 正常（有 usage） | 141 |
| 零用量（it=0/ot=0/tt=0） | 38 |
| **ot 正好 = 2048（= maxOutputTokens）** | 3 |

其中 12 个会话**每次调用都失败**。

- **max-tokens 截断**：`ot` 恰好等于配置的 `maxOutputTokens: 2048`。标题请求带
  `submit_session_title` 工具，推理模型（step-5-preview）把 2048 个输出 token 全烧在
  reasoning 上，工具调用还没发出就被截断。而 `BlockAssembler` 在 `max-tokens` 时会
  **主动丢掉 tool-call 块**，所以原代码直接抛错、这次修订彻底没有标题。
- **零用量**：`it=0/ot=0/tt=0`。注意 `tt` 在 usage-stats 里是 `mixedTotal(usage)`
  （总 token 数）不是耗时。zcode-cli 那两个 0/0/0 的会话其实成功了（该 provider
  不上报用量），但 insidegate / opencode-go 的 0/0/0 就是真的空完成——同一会话里
  成功的调用都有正常的 it/ot。
- **zcode/GLM-5.3-Flash 路由 9 战 0 胜**：该 provider 已于 2026-10-26 卸载
  （见 profile 注释），相关会话的标题请求全部失败。

### ③ 已排除的疑点

- `ctx.llm.stream()` 的 `purpose` / `sessionId` 选项：`dsh-llm` 的
  `GenerateOptions` 确实声明了这两个字段，`purpose: 'session-title'` 是合法值，
  运行时不消费、只作归属标记。不是问题。
- `isAgentLoopRequest`：用 WeakSet 标记 agent-loop 装配的请求对象，插件自己的标题
  请求不在其中，`onMainRequest` 会正确跳过——不会自我触发。
- `dsh-model-pool` / `dsh-subagent-models` / `dsh-usage-stats` 的 `llm/stream`
  监听器都是纯透传记账，不改写 chunk。
- `session.surface.nodes` / `eventAt()` / `deriveEventMessage()`：与
  `@deepseek-ai/dsh-session@0.2.1-rc.5` 的真实签名逐一核对一致。
- `createToolResultMessage` 返回 `role:'tool'` 带顶层 `toolCallId`，fold/unfold 的
  协议代判断正确。
- 插件自带 selftest 24 项全部通过（含压实遮蔽、工具配对、图片占位等边界）。

## 4. 修复（`session-title.v2.js`）

没有覆盖原文件：新建 `session-title.v2.js`，profile 组合行的 `name` 指向它。
原 `session-title.js` 原样保留，可随时回退。

| # | 修复 | 位置 |
|---|---|---|
| ① | `cadence` 透传：`value.cadence === undefined ? DEFAULT_CONFIG.cadence : value.cadence` | `readConfig` |
| ② | `max-tokens` 时先从已落地文本抢救标题，抢救不到再抛错，且错误信息点明"推理模型可能把预算全用在思考上" | `dispatch` |
| ③ | 路由解析补一级回退：`request.route` 缺失时用 `session.requestContext()`（最近一条 `request/context` 的路由） | `resolveRoute` |
| ④ | 标题请求默认按路由声明的**最低**思考强度发（对齐出厂 `first-prompt-llm` 的做法），配置显式写 `reasoningEffort` 时以配置为准 | `lowestReasoningEffort` |

④ 的缓存按 provider 实例给，不放在模块级：同一进程里改过渠道配置后重新 apply 会
拿到新表，模块级缓存会一直留着旧档位。

修复①之后，"每条用户消息都重算"会让一次瞬态失败在下一条消息时自愈，不再永久停在
fallback；子代理会话也会开始有标题。

## 5. 验证

```
SELFTEST PASS (24 checks)   ← 插件自带 selftest，原样通过
V2 FIXES PASS (11 checks)   ← 本次新增的 4 处修复专项测试
```

新增测试覆盖：all-prompts 透传 / first-prompt 不回归 / 非法值仍报错 /
max-tokens 抢救成功与抢救不到 / request/context 回退 / 完全无路由时明确报错 /
最低思考强度生效 / 配置优先 / 目录列不出时不炸也不传 / 上下文构造回归。

`node --check` 通过。

## 6. 尚未生效 —— 需要重启 DSH

已实测：`GET /dsh-session-title/state?sessionId=...` 仍返回
`"cadence":"first-prompt"`，说明运行中的 host 还是旧模块。

本 profile 未开 HMR 模块热载，改 `cordis.patch.yml` 不会自动重新 import 模块；
`recomposeProfile` 只能由进程内触发，而 `cordis_define` 工具不在当前会话可用。
**请重启 DSH**（或在设置页触发一次 profile 重载），重启后同一条路由应返回
`"cadence":"all-prompts"`。

重启后建议观察：新会话的 `session/title` 事件 `source.kind` 应为 `provider`；
子代理会话也应开始出现 provider 标题。

## 7. 遗留与建议

- `maxOutputTokens: 2048` 对推理模型偏小。修复②④已能显著缓解，但如果仍见到
  max-tokens 失败，可把它调到 4096~8192。
- 纯图片/纯文件的首条消息仍然不会触发标题：出厂服务层的
  `sessionTitleUserMessageOf()` 要求规范化后文本非空，`titleInput.lastSeq` 为
  null 时 `refresh()` 直接走 fallback 分支。这是服务层设计，不是本插件的问题；
  若需要支持，得在服务层放开，或在插件侧对无文本会话走独立路径。
- 失败原因目前只进 host 日志（`ctx.logger.warn`）。标题栏面板已经能显示
  "上次失败"，但自动失败的细节建议临时把 `logRequests: true` 打开抓一轮。
