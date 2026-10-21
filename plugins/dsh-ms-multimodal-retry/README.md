# dsh-ms-multimodal-retry

DeepSeek Harness 的**静态 host 插件**：命中「特定模型 + ModelScope 多模态下载超时」时，
**剔除模型可见面里最早的图像并重试该步**。装入 profile 的 `cordis.patch.yml` 后
**启动 dsh 即持续运行**，不依赖任何 agent 预设 / skill / 动态插件，刷新与重启都不丢。

## 解决什么问题

```
<400> InternalError.Algo.InvalidParameter: Download multimodal file timed out
```

- 链路：DSH（provider `localhost`）→ new-api → **ModelScope**（api-inference.modelscope.cn，
  渠道 #22/#24）→ `deepseek-ai/DeepSeek-V4.1-Flash` 等模型。
- DSH 把 400 归一成失败类别 `INVALID_REQUEST`，而出厂 normal 重试策略只覆盖
  `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`；new-api 也只对
  429/5xx 换渠道。于是轮次**直接失败**，用户看到的就是那句 400。
- 本插件补这一格：命中后剔图、退避、`{kind:'retry'}`，让 agent loop 在同一 turn 内
  重跑该步（请求从持久表面重建，图已不在，请求体随之变小）。

实测背景（2026-10-05，本机）：该错误 8 天内共 10 次，**全部落在 ModelScope 渠道**；
失败请求耗时 1m1.9s / 1m2.0s，同体量请求实测最快 11s、最慢 63.7s——本就贴在多模态
ingest 的约 60s 预算上，压线即报错。

## 配置（`cordis.patch.yml` 的 insert 行内 `config:`）

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `models` | `[]` | **生效的模型 id 列表**（通配符 `*` / `?`，精确优先）。空 = 插件空转。 |
| `providers` | `['*']` | DSH provider 名匹配（本机网关是 `localhost`）。 |
| `errorStatus` | `[400]` | 命中的 HTTP 状态码。 |
| `errorPatterns` | `['Download multimodal file timed out', 'multimodal file timed out']` | 错误文本特征（大小写不敏感）。 |
| `drop` | `1` | 每次重试剔除最早几张图。 |
| `maxRetries` | `3` | 单个 `(session, turn, step)` 的最大自愈次数，也是剔图预算。 |
| `delayMs` | `500` | 重试前退避。 |

当前 registrations（本机实际生效的一份）：

```yaml
- insert:
    - id: ms-multimodal-retry-v1
      name: ./plugins/dsh-ms-multimodal-retry/index.js
      config:
        models: ['deepseek-ai/DeepSeek-V4.1-Flash']
        providers: ['*']
        errorStatus: [400]
        errorPatterns: ['Download multimodal file timed out', 'multimodal file timed out']
        drop: 1
        maxRetries: 3
        delayMs: 500
```

想对所有模型都开（例如又接了 `Qwen/Qwen3.8-Flash-Next`）：把 `models` 改成 `['*']`。

## 行为细节

- **剔除机制与出厂 `unload_images` / `compaction-tool-result-pruner` 逐项对齐**：
  被替换的面节点先落一条 `compaction/prune` 影子计价（token 折叠从紧邻其前的计量事件取价），
  再用 `surfaceOp:{op:'replace'}` + `sourceEventSeqs` 落替换事件。会话日志只增，
  **人工转录不变**；只有后续请求不再重发那张 base64 图。
- 占位文本保留身份（名称 / sha256 前 8 位 / 尺寸 / 字节）与恢复方式
  （"Call read_image on the same path when you need it again"）。
- **预算**：`(session, turn, step)` 维度计数，`agent/status` 转 `idle` 归零；耗尽即
  `next()` 交回原始错误，不会无限重试。
- 已无图像可剔 / 取消信号 / 配置敲错 → 一律交回下游，绝不把轮次搞垮。
- 任何自身异常都记 warn 后 `next()`（与 `dsh-model-retry` 同款责任边界）。

## 与既有插件的关系（行序有意义）

必须排在 `dsh-model-retry` **之后**：可重试类别先走它的规则与预算，未命中才下传到本插件。
若日后给该模型加了 `statusCodes:[400]` 的重试规则，`model-retry` 会先单纯重试（不剔图），
本插件随之不再触发——想保留自愈就别加那条规则。

## 自检

```bash
node /root/.dsh/profiles/web/plugins/dsh-ms-multimodal-retry/selftest.mjs
```

覆盖 10 项：命中剔图并重试、模型/错误特征/状态码不匹配一律交回、已无图像、预算逐次
再剔后交回、取消信号、idle 归零、错误配置兜底、dispose 清理。另可用
`dsh --profile web --dump-config` 校验组合树里本行与 config 是否成形（不启动）。

## 文件

- `index.js` —— 插件本体（零第三方依赖，纯 host 半边）。
- `selftest.mjs` —— 离线自检（session 替身驱动，不启动 dsh、不碰线上会话）。
