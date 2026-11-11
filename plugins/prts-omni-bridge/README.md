# prts-omni-bridge

让 **PRTS Omni Android 客户端**通过一个带令牌校验的本机 HTTP + WebSocket 桥接，访问 DSH 的
**会话 / 智能体 / 工具**。

Host 半边：起独立的 `node:http` 服务 + 自建的最小 WebSocket 实现（**不依赖任何第三方库**），
并注册模型工具 `prts_omni`。

## 快速开始

```yaml
# cordis.patch.yml（本包已内置默认值）
- insert:
    - id: prts-omni-bridge
      name: 'prts-omni-bridge'
      config:
        enabled: true
        bindHost: 127.0.0.1
        port: 8787
        allowLan: false
        allowToolExecution: false
        maxSessions: 50
```

1. 安装并启用插件；
2. 看 Host 日志里的 `配对令牌已就绪` 一行（**日志里没有令牌本体**）；
3. 在本机读取令牌文件：
   - Windows / macOS / Linux：`~/.prts-omni-bridge/token.json`
   - 或直接请求 `GET http://127.0.0.1:8787/prts-omni/v1/auth/token`（**仅本机回环免令牌**）
4. 把令牌填进 PRTS Omni。

## 配置

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 关闭时 `apply` 直接返回：不起服务、不注册工具 |
| `bindHost` | string | `127.0.0.1` | 监听地址。设成 `0.0.0.0` / `::` 时必须同时 `allowLan: true` |
| `port` | integer 1024–65535 | `8787` | 监听端口 |
| `allowLan` | boolean | `false` | 是否允许局域网访问 |
| `allowToolExecution` | boolean | `false` | 是否开放 `/tools` 与 `/tools/:name` |
| `maxSessions` | integer 1–1000 | `50` | `GET /sessions` 单页上限 |

`bindHost` 为通配地址而 `allowLan` 为 `false` 时，插件**拒绝启动**并在日志里说明原因
（失败关闭，不会静默暴露到局域网）。

## HTTP 接口

统一前缀 `/prts-omni/v1`，全部返回 JSON（UTF-8，`cache-control: no-store`）。

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 回环免令牌 | 服务状态、连接数、订阅数 |
| GET | `/auth/token` | 回环免令牌 | 返回当前令牌，供本机配对 |
| GET | `/sessions` | Bearer | 会话列表（`limit` 可覆盖 `maxSessions`） |
| GET | `/sessions/:id` | Bearer | 单个会话摘要 |
| GET | `/sessions/:id/events?since=&limit=` | Bearer | 事件分页（`since` 含首，`limit` ≤ 500） |
| GET | `/sessions/:id/messages?limit=` | Bearer | 派生消息历史 |
| POST | `/sessions/:id/message` | Bearer | 发消息，body `{ text, interrupt? }` |
| POST | `/sessions/:id/interrupt` | Bearer | 中断当前回合 |
| POST | `/sessions` | Bearer | 创建会话，body `{ title, model, branch, goal }` |
| GET | `/tools` | Bearer | 工具 schema 列表（需 `allowToolExecution`） |
| POST | `/tools/:name` | Bearer | 执行工具（需 `allowToolExecution`） |

令牌两种带法：`Authorization: Bearer <t>` 或 `X-PRTS-Token: <t>`。

### 状态码

`400` 参数不合法 · `401` 令牌缺失或错误 · `403` 跨站请求或工具执行未开启 ·
`404` 会话/路由不存在 · `405` 方法不对 · `413` 请求体超过 64 KiB · `500` handler 内部异常 ·
`501` 当前 Host 版本没有 `sessions.create()`。

## WebSocket 事件流

`WS /prts-omni/v1/stream`

握手阶段除了请求头，还支持 `Sec-WebSocket-Protocol: <token>` 与 `?token=<t>` 查询参数
（浏览器无法给 WebSocket 设自定义头，原生客户端可以）。

客户端控制消息：

```jsonc
{ "type": "subscribe",   "sessionIds": ["session-1"] }
{ "type": "unsubscribe", "sessionIds": ["session-1"] }
{ "type": "ping" }
{ "type": "ack", "seq": 42 }   // 确认收到 msgSeq ≤ 42 的全部消息
```

服务端推送：

```jsonc
{ "type": "hello", "heartbeatMs": 2000, "maxBacklog": 1000 }
{ "type": "subscribed", "sessionIds": ["session-1"] }
{ "type": "session/event", "sessionId": "session-1", "seq": 7, "msgSeq": 12, "event": { … } }
{ "type": "pong", "time": 1760000000000 }
{ "type": "error", "error": "…" }
```

- 事件通过轮询 `Session.snapshotEvents(cursor)` 增量拉取（默认 400ms，无订阅者时跳过）；
- 心跳 2s 一个 WS ping 帧，连续 3 个周期没有 pong 就断开；
- **背压**：未确认（未 ack）消息超过 1000 条，或 socket 缓冲超过 4 MiB，直接以 1013 断开；
- 单连接最多订阅 64 个会话。

## 模型工具 `prts_omni`

| action | 参数 | 说明 |
| --- | --- | --- |
| `list_sessions` | — | 列出会话（id / 标题 / cwd / 父会话） |
| `send` | `sessionId`, `text`, `interrupt?` | 发消息；`interrupt: true` 时先中断 |
| `interrupt` | `sessionId` | 中断当前回合 |
| `spawn` | `title?`, `branch?`, `goal?`, `model?` | 创建会话 |

`exec.agent` 缺失时工具明确报错，不静默失败。

## 安全边界

- **令牌**：256 位随机，落盘 `~/.prts-omni-bridge/token.json`（尽量 0600），恒定时间比较；
  不写 info 日志、不出现在非回环响应体里。文件损坏则重新生成（旧令牌失效，需重新配对）。
- **回环优先**：默认只绑 `127.0.0.1`；只有 `/health` 与 `/auth/token` 允许本机回环免令牌，
  其余一律要令牌。WebSocket 升级**没有**免令牌路径。
- **先认证后路由**：`/prts-omni/v1` 下的未认证请求**一律 401**，令牌校验发生在路由解析
  之前 —— 不会先用 404/405 把路由表泄露给未认证客户端。认证通过之后 404/405/403 才会
  各自区分。
- **拒绝跨站**：带 `Origin` / `Sec-Fetch-*` 的请求一律 403（防 DNS rebinding）。
- **请求体上限** 64 KiB（413），超限时先写响应再断连，客户端拿到的是 413 而不是 socket 错误。
- **不崩服务**：每个 handler 的异常都捕获并转成 500（缺服务的依赖是 503）；路由内部错误
  不会带崩 `node:http`。坏百分号转义（`%ZZ` 等）按 400 处理，不会变成 500。
- **工具执行默认关闭**：`/tools` 能让远端执行任意 Host 工具，必须显式 `allowToolExecution: true`。
- **会话销毁**：`agent/disposed` 时清掉该会话的全部 WS 订阅。
- **卸载/重载**：关 server、关 WS、清定时器，全部幂等；`agent/disposed` 监听器在
  `bridge.start()` 成功之后才注册，其 disposer 由 effect 纳管，start() 失败不会留僵尸监听器。

## 已知限制

1. **`model` 无法在创建会话时设置**。它属于 `request/header`（一次请求的属性），不是
   `SessionHeader` 的字段；`sessions.create()` 只接受 `meta.cwd` / `meta.parentSession` /
   `meta.origin` / `meta.delegationDepth` / `meta.agentPreset`。传入 `model` 会在响应的
   `warnings` 里显式说明，不静默丢弃。
2. **`sendMessage` 的授权模型**。DSH 要求 sender 是「确切的在线 Agent」，且目标必须是它的
   **直接子会话**（或它自己的直接父会话）。桥接按 `目标会话的父 Agent → 第一个 root Agent →
   任意在线 Agent` 的顺序解析 sender；DSH 拒绝时会原样透出错误（例如 `UNAUTHORIZED`），
   不重试、不吞。
3. **`POST /sessions` 依赖 `sessions.create()`**。这是从 Host 安装包里核实到的真实 API
   （`SessionStore.create(id, { seed, meta, inheritedEventCount, eventState })`），但不在最初
   确认的服务契约清单里，因此做了特性探测：缺失时返回 501 并说明原因。
4. **事件流是轮询的**。确认的契约里没有事件订阅入口，所以用 `snapshotEvents` 增量拉取
   （400ms）。会话非常多时会有可观测的延迟。
5. **WebSocket 是最小实现**：只有 text / close / ping / pong，没有 permessage-deflate、
   扩展协商和子协议。二进制帧会被当作文本尝试解析。
6. **`sessions.create()` 创建的会话归插件 fiber 所有**。这是 Host 的契约语义：通过桥接
   `POST /sessions` 建出来的会话挂在插件的 Cordis fiber 下，插件**重载或卸载时会从
   store 里移除**（连同它派生的子会话）。需要跨重载存活的会话请在客户端界面创建，
   不要走桥接的创建接口。
7. **`presentCall` 拿不到 agentId**。Host 契约是 `presentCall?(args)`，只传参数不传执行
   上下文，所以工具调用卡片上的 `agentId` 只在实际传了 `exec` 的 Host 版本上才会出现；
   取不到时该字段被省略，不会报错。
8. **`interrupt` 对根会话改用 `ancestor` 权威**。`{kind:'user'}` 要求必填
   `parentSessionId`，根会话没有父会话可声明，因此退回
   `{kind:'ancestor', agent}`（依次取 `agents.roots()[0]`、`agents.list()[0]`）；
   本进程一个在线 Agent 都没有时返回 503。

## 自测

```bash
node --test test/*.mjs
```

不需要 `--test-force-exit`：修好 `plugin-test.mjs` 的服务器泄漏（`apply()` 注册的
effect disposer 以前从不执行，每个用例都漏一个 LISTEN socket）之后，测试进程能
自己干净退出。http 测试也全面改用 `node:http` 客户端而不是全局 `fetch`，
顺带绕开了 undici 的坏端口黑名单（动态端口 1024–15000 里含 19 个 badPorts，
随机命中时 `fetch` 会抛 `bad port`）。

桥接本身在 `stop()` 之后，监听 handle 在**紧随其后的一个事件循环 tick** 释放
（`server.close()` 的回程里 handle 还没消失，要再跑几个 tick 才清空），
之后 `process.getActiveResourcesInfo()` 里不再有 `TCPServerWrap`。
如果哪天又出现测试挂住不退出，先查是不是又有没被纳管的 server / WS 连接，
不要用 `--test-force-exit` 掩盖。

| 文件 | 覆盖 |
| --- | --- |
| `test/ws-test.mjs` | 帧编解码、分片重组、掩码、RFC 6455 官方握手向量、协议错误关闭码、心跳超时与续命、背压断开、dispose 幂等、关闭码（含空 reason）、`close()` 后 socket 必被销毁 |
| `test/token-test.mjs` | 令牌生成 / 复用 / 0600 / 损坏重建 / 恒定时间比较 / 环境变量覆盖 |
| `test/sessions-test.mjs` | session 映射、事件分页、超大事件降级、sender 解析、send / interrupt（含无父会话的 ancestor 分支）/ create 的成败路径、服务缺失 503 |
| `test/http-test.mjs` | 路由分发、令牌校验（未认证统一 401，不泄露路由表）、坏百分号转义 400、回环地址归一化、`limit` 夹取、413、404/405、跨站拒绝、工具开关与 `callId`/`signal` 契约、503 不崩服务、WS 全流程（含 `sec-websocket-protocol` 回写与升级拒绝码）、停止后可重启、无残留 handle |
| `test/plugin-test.mjs` | Config schema、工具 schema 形状、四个动作、LAN 守卫、端口占用、`agent/disposed` 真实路径、配置夹取告警、effect disposer 清理 |
