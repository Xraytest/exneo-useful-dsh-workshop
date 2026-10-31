# dsh-usage-stats — DSH 用量统计（含历史回填）

按 **模型 / 供应商 / 分组 / 会话 / 每日 / 每周** 六个角度统计 token 用量，并单独给一个
**速率区**（平均 TTFT / TPS）。模型维度按 **「供应商 × 模型」**分桶：同一个模型挂在多家
供应商下时**各成一行**，用量与速率都按渠道分开算，不会互相污染。
核心不是「从今天开始记账」，而是
**能把插件上线之前的用量算出来**：所有事实都来自折叠既有会话日志，实时记账与历史回填调用同一个
`fold.js::foldEvents`，因此上线前后的数字天然可加、可对账（同一条日志折两次结果完全相同）。

```
plugins/dsh-usage-stats/
├── entry-v13.js       热挂入口（?v=rate-model-dim-3；loader 按 specifier 缓存，改实现后靠它重挂）
├── index.js           host 半边：实时折叠 / 回填 / 存储 / HTTP 路由 / 模型别名 / 缓存占比 / 网格镜像口径
├── client.js          浏览器半边：设置页「用量统计」（六页签 + 三种图表 + 命中率总表 + **速率区**）
├── fold.js            纯折叠 + 六维聚合 + 复合模型键 + 速率样本（无 I/O，host 与工具共用）
├── store.js           账本持久化（原子写、每会话游标幂等）
├── mesh-mirror.js     设备网格镜像索引 → 会话来源边界（纯 node，运行时/离线共用）
├── rawlog.js          zstd 逐帧解码 / 极简 zip 读取 / sessions 目录遍历
├── charts-harness.mjs 无头渲染工具（自检与预览共用：假 window 装载 + 元素树 → HTML）
├── client-race-selftest.mjs  浏览器半边「过期响应」回归 9 项（切页签闪红字，见八点五）
├── selftest.mjs       自检 58 项（A 合成 14 / B 真实语料对账 5 / C zip 1 / D 假环境全链路 9 /
│                      E 浏览器半边 19 / F 网格镜像 10；本机 python3 不可用 → 跳过 C 段，跑满 57 项）
├── prewarm.mjs        离线重建账本（可脱离 DSH 单跑）
└── preview.mjs        把账本渲染成单文件 HTML 预览（离线可看，含图表与别名）
```

## 一、事实口径（唯一来源 = 会话日志折叠）

| 日志事件 | 折叠为 | 说明 |
| --- | --- | --- |
| `assistant/message.data.usage` | `step` | 主口径；无 usage 的（被打断）只进缺口计数 |
| `assistant/attempt` 流内末尾 usage chunk | `attempt` | 失败/重试的调用同样计费 |
| `compaction/summary.data.{provider,model,usage}` | `compaction` | 自带路由，不跟随当前会话路由 |
| `request/header.data.header.config` | — | 更新「当前路由」；同一会话可中途换模型/供应商 |
| `step/start` / `llm/retry-started` | — | 记「本次请求起始时刻」`state.start`（速率端点，见一·平均速率） |
| `session/title` | — | 记录标题，供会话维度显示 |

每条 `usage` 事实另记 `cacheKnown`（该条 usage 里是否真有缓存字段），供缓存占比区分「命中 0 次」与「无缓存数据」。
带 `stream` 时间戳的事实另记 `r = {f, g, o}`（TTFT / 生成时长 / 参与 TPS 的输出 tokens），供速率统计。

token 总数与 `dsh-model-pool` 同口径：`totalTokens` 存在就用它，否则 `输入+输出+缓存读+缓存写`。

### 模型维度：按「供应商 × 模型」分桶

统计键是 `provider + U+241F + model` 复合键（`fold.js::compositeModelKey`），行上再拆回
`provider` / `model` / `modelProviders`。同一个模型挂在多家供应商下时**各成一行**，两家的
用量、单价、速率都各算各的，不合并——本机实测 `deepseek-v4.1-flash` 同时在
opencode-go（2.1 万次）与 trae（2.3 千次）下出现，合并成一行会抹平差异。
分组、会话、日、周维度不受影响（仍按各自口径分桶）。

**展示名是否注明供应商，看「展示名会不会撞车」**（`index.js` 两遍扫描 → 行上 `sharedLabel`）：

| 情况 | 例 | label |
| --- | --- | --- |
| 展示名在当前视图里**唯一** | `spark-x2.6` 只有 loomy 在用 | `Spark-X2.6 正式版(限时免费) · x0.0` |
| 同一请求名**跨渠道** | `step-5-preview` 在 insidegate 与 local-gateway | `Step-5-Preview · x0.48 @ insideGate` |
| **不同请求名解析出同一展示名** | 三个 `deepseek…v4.1-flash` 写法都叫 `DeepSeek V4.1 Flash` | `DeepSeek V4.1 Flash @ local-gateway` |

只按「请求名是否跨渠道」判是不够的——第三种情况会让四行里三行带 `@`、一行不带，
看上去像混在一起（用户实测抓到的）。**分桶始终按 (供应商, 请求名)，标注只影响显示**：
CSV 的 `provider` / `model` 两列、接口上的 `provider` / `model` / `sharedModel` / `sharedLabel` /
`modelProviders` 永远给全，不因是否标注而丢信息。

### 平均速率（TTFT / TPS）

速率与用量**完全分区**：用量只在用量区（明细表、命中率总表、弹窗、图表副行），
速率只在「速率区」（默认开，工具条可关，排在整块用量之后）。速率的分组口径与用量
**完全一致**——同一批「供应商×模型」条目、同一套标注规则，逐条各算自己的速率。

| 量 | 口径 | 单位 |
| --- | --- | --- |
| `ttftAvg` | `首个内容时刻 − 请求起始时刻` 的算术均值 | 秒 |
| `ttftMedian` / `ttftMin` / `ttftMax` | 同批样本的中位数 / 界内极值 | 秒 |
| `tpsAvg` | `Σ输出tokens / Σ生成时长`（聚合式，按耗时加权） | tokens/秒 |
| `tpsMean` / `tpsMedian` | 逐条 tok/s 的算术均值 / 中位数（对照用） | tokens/秒 |
| `ttftSamples` / `tpsSamples` | 实际进统计的调用条数 | 次 |
| `ttftExcluded` / `tpsExcluded` | 被上界裁掉的条数 | 次 |

端点来源：`assistant/message.data.stream` 里的记录时间戳（`{"type":"chunk","time":T}` 与
`{"type":"text-chunks","time0":T,"dt":[...]}`），起点取 `step/start`（重试时取最后一条
`llm/retry-started`——失败尝试的耗时不算进这一次的 TTFT）。本机实测 45,861 / 46,002 条
assistant/message 带可用时间戳。

- **阈值**：`生成时长 ≥ 500 ms` 且 `输出 ≥ 32 tokens` 才进 TPS 样本（短回复的 tok/s 是噪声，
  一条 60 ms / 12 tok 的调用能算出 200 tok/s）。TTFT 不设下界。
- **上界裁剪**：`TTFT / 生成时长 > 5 分钟` 的点不进均值——本机实测最长一条 3 小时
  （会话挂起/接手留下的污染），裸平均会被极少数点整体拉飞。被剔除的条数在
  `ttftExcluded` / `tpsExcluded` 里如实透出，不静默丢数据；同时给中位数（对长尾天然免疫）。
- **缺失语义**：没有样本时一律 `null` → 界面显示「—」、CSV 留空，**不当 0**（0 tok/s 是
  「慢到不动」，与「没有可测数据」是两件事）。
- **老账本兼容**：改版前写入的事实没有 `r` 字段，这些条目不进速率统计，但 token 总量与
  调用次数完全不受影响。`/dsh-usage/status` 的 `rateCoverage` 如实报覆盖度
  （`factsWithSamples / factsTotal / share`），点「重建全部」重折一次即可补齐。
  `aux`（实时补记）事实永远拿不回 `r`——与 `cacheKnown` 同样的既有边界。
- **增量 == 全量**：`state.start` 随账本持久化（`store.js` 序列化），断点续折与一次折完的
  速率样本逐位一致（selftest 有断言）。

### 缓存占比（v7，2026-10-09）

**逐项计算**（每个模型 / 供应商 / 分组 / 会话 / 日 / 周各自算自己的），不拿总量一刀切——
总量会被大用户稀释，掩盖单项的真实命中情况。分母也**只算有上报缓存的流量**，理由见下。

| 量 | 口径 | 说明 |
| --- | --- | --- |
| 计费输入 `billedInput` | `input + cacheRead + cacheWrite` | DSH 的 usage 里 `inputTokens` 与 `cacheReadTokens` **互斥**（未命中/命中缓存的输入各自单独计，见 `dsh-llm` 的 `TokenUsage` 注释） |
| 可测输入 `measuredInput` | 只累加带缓存字段的事实 | 有些路由/渠道根本不上报缓存字段，它们不进分母 |
| **缓存占比 `cacheShare`** | `(cacheRead + cacheWrite) / measuredInput` | 实测命中率，每一项各自算 |
| **覆盖度 `cacheCoverage`** | `measuredInput / billedInput` | 这个占比覆盖了该项多少流量；`0` = 该项完全不上报缓存 |
| 未上报输入 `cacheUnknownInput` | `billedInput − measuredInput` | token 数，便于判断要不要补数据 |
| 缓存读/写 | 原样透出 | 单价不同，故不合并展示 |

**为什么不把「没上报」当「没命中」**：早期（v6）用全量计费输入当分母，等于假设没上报的流量
一次缓存都没命中。实测某会话的 50 条上报事实命中率 **96.4%**，但另有 55 条事实（占计费输入
73.2%）来自不上报缓存的渠道，两者一平均就被稀释成 **25.9%** —— 报告值比真实值低了 70 个百分点。
现在这类流量不进分母，而是用「覆盖 N%」如实标出（界面上就是 `96.4% · 覆盖 26.8%`）。
这是对抗验证（独立复算 + 证伪）抓到的缺陷，v7 修正。

**「无缓存数据」≠ 0%**：事实层每条记录 `cacheKnown`（`usage` 里真有 `cacheReadTokens`/`cacheWriteTokens` 键，
哪怕值都是 0）。`measuredInput` 为 0 时占比是 `null`，界面显示「无缓存数据」，
绝不当成 0% —— 否则等于断言「一次都没命中过缓存」。**命中 0 次**（有字段、值为 0）显示真实的 `0.0%`。
此时覆盖度是 `0`（全部流量都不可测），但界面**不会**再补一句「覆盖 0.00%」——那是同一件事说两遍；
只有 `0 < 覆盖度 < 100%` 才标「覆盖 N%」。

**本机为什么几乎看不到「命中 0 次」这一档（重要，别误读）**：对抗验证查过 token 归一化链路，
dsh-llm-pi-ai 走 openai-completions 时用 `usage.cacheRead > 0 ? {cacheReadTokens} : {}` 过滤，
**0 值字段会被整个丢掉**（实测这些 usage 的 `totalTokens` 恰好等于 `input + output`，没有藏着命中量）。
所以在这套部署里「没有缓存字段」大概率等价于「这一跳真的没命中」，界面写「无缓存数据」是**保守**口径，
不是事实错误。插件本身是通用的：别的供应商可能既不上报又有命中，账本层分不出来，
所以宁可标「不可测」并用覆盖度如实交代，也不把「没字段」当成 0% 命中。

**老账本兼容**：v7 之前写入的 `facts/*.json` 没有 `cacheKnown` 字段，聚合时退回「有非零缓存值即视为有数据」
（`fold.js::factCacheKnown`），否则整本历史账会被误判成无缓存。`重建全部` 只重折**日志事实**，
实时补记的 aux 事实按设计保留（旧 aux 事实拿不回原始 usage 键，继续走该回退），所以不要指望
「重建一次就全部收敛」。

**没有 dilution（v6 曾有过，v7 删除）**：`total` 是 token 数而非金额，`1 − 计费输入/total` 恒等于
「输出占比」（实测 1497 行全部逐位相等），与缓存定价无关，是个误导性指标。

实测（本机 2026-10-09，4.39 B tokens / 3.54 万次调用）：合计 **94.1%（覆盖 81.5%）**；
`step-5-preview` 98.1%（覆盖 96.7%）、`mimo-v2.6-flash-free` 96.2%、`deepseek-ai/deepseek-v4.1-flash`
91.8%（覆盖 96.5%）；而 `deepseek-ai/DeepSeek-V4.1-Flash`（ModelScope 渠道）**整个语料 1891 条
usage 全都不带缓存字段**，覆盖度 0%、如实显示「无缓存数据」——这正是逐项口径要暴露的差异。
**fork 子会话**：继承前缀里的事件只用于承接路由与标题，不产生事实（那部分用量已记在父会话日志上）。
切点优先取服务的 `inheritedEventCount`，离线通道取日志里最后一个 `{inherited:true}` 的 `session/end-seed` 标记。

### 设备网格镜像：只记「从当前设备发出的请求」（2026-10-19）

口径：本机账本只记**从当前设备发出的请求**——LLM 调用由本机 agent 发起，工作目录在本机还是
远端工作区都算（后者只是命令转发到执行端，请求仍是本机发的）。反过来，**执行端**（按路径
路由跑命令的那台）的 `sessions/` 里会有 dsh-device-mesh 同步来的**对端会话历史副本**
（`sessionSync` 把副本重压进本机 `sessions/`，见网格 README §12.9），副本里的 usage 是
**对端设备发出的请求**，不能计入本机账本——否则同一笔用量会在两台设备上各记一次。

- **边界**：取接收端镜像索引 `$DSH_HOME/device-mesh/session-replica/index.json` 的
  `syncedSeq ?? lastSeq`（= 本机那份日志已追平镜像的最后一条事件 seq）。`seq <= 边界` 的事件
  照常推进游标、承接路由与标题，但**不产生事实**；**边界之后**的事件（本机接手/续跑）照常计。
  边界落在账本条目的 `remoteBelow` 上（普通会话不落该字段）。
- **方向只认接收端**：本机作为会话端推给对端的会话（`device-mesh/session-mirror.json` 的
  sender 游标）**不受影响**——它们的请求就是本机发出的，必须照常计。
- **变化即重折**：网格又同步一轮（边界前移）会让该会话强制重折；`重建全部` 按同一规则收敛。
- **安全退化**：索引不存在/损坏 = 没有镜像（或网格插件没装）→ 照旧全部计入，并把错误如实
  写进 `/dsh-usage/status` 的 `mirrored.error`；老索引条目拿不到边界时按「不排除」处理并在
  `mirrored.unknownBoundary` 计数（宁可多记，也不整块丢掉本机接手后的真实用量）；
  `config.excludeMirroredSessions=false` 可整体回退。
- **观测**：`/dsh-usage/status` 的 `mirrored` 块给出副本数 / 来源设备 / 被排除的会话数、
  调用次数与 token（`excludedFacts` / `excludedTokens`，只留痕、不进任何聚合）；设置页状态行
  显示一行「网格镜像排除 N 会话（M 次调用 / T tokens，由对端设备发出）」。
- **aux 不参与排除**：实时补记（`session-title`）只在本机真发出请求时才会产生，按定义是本机用量，
  不套来源边界。
- **已知边界**：显式「接管」走 pull 路径时拉回的是源设备**原始日志**，可能比镜像边界新一点点；
  边界之后的那几条会被当作本机发出（接管 = 所有权转移，属显式动作）。`extraSessionRoots` /
  `zipImportDirs` 是显式导入通道，同一会话若在本机也是镜像副本，仍按来源边界排除。

## 二、恢复历史用量的三条通道

1. **会话语料**（默认，覆盖最全）：`ctx.sessionQuery.readSession(id)`，会话列表来自 `listSessions()`。
   归档只是把会话从侧边栏隐藏（`workspaceRegistry.archivedSessionIds`），日志仍在列表里，因此**归档会话同样被回填**。
2. **`config.extraSessionRoots`**：别的 DSH home / 备份树里的 `sessions` 根目录，用 `rawlog.js` 直接解码
   （多帧 zstd 必须逐帧扫 magic `28 b5 2f fd`——整块 `zstdDecompressSync` 只会解出第一帧）。
3. **`config.zipImportDirs`**：`/export` 导出的归档 zip（内含 `session.vN.jsonl`，deflate / store 都支持）。

**语料读取失败时自动回退原始日志**：已见本机故障——`sessionQuery.readSession()` 对 seeded 会话抛
`seeded session constructor seed must equal its inherited prefix`，若直接跳过会整块漏账
（实测 3 个有账单的子代理会话 ≈ 53.7M tokens）。现在这类会话改由 `rawlog` 直接读日志折叠，
同一份 `fold.js`、同一口径，并在 `/dsh-usage/status` 的 `backfill.recovered` / `backfill.notes` 里留痕。

同一会话按**来源等级**只计一次：语料(2) > 备份根(1) > 归档 zip(0)。语料升格时重折而不叠加。

## 三、实时补记与已知缺口

- `session/created` → 折 `snapshotEvents()`（构造期 seed 不走 `session/event` 广播，必须显式采纳）；
  `session/event` → 逐事件增量折叠；`session/flush` → 落盘。
- **只在上线后可得**的辅助调用（日志里不写 usage）由 `llm/stream` waterfall 旁听补记，默认只记
  `session-title`。**`compaction` 必须排除**——它的用量已经落在 `compaction/summary` 里，否则双计。
  旁听不改变流内容（chunk 原样透传），统计异常绝不影响 LLM 调用。
- 无法恢复的缺口（只在 `/dsh-usage/status` 计数）：联网搜索 `web/deepseek-search-llm-request`
  （走原始 fetch，无 usage 字段）、被打断且未产生 usage 的 `assistant/message`。

## 四、存储与幂等

```
$DSH_HOME/usage-stats/
├── state.json               schema / 导入索引 / 上次回填统计 / 模型设置名称索引
└── facts/<sessionId>.json    游标 lastSeq、当前路由、标题、日志事实、实时补记事实
```

- 日志只追加 ⇒ `lastSeq` 就是幂等键；增量与全量重建结果一致（selftest 有断言）。
- 写入一律 `tmp + rename` 原子替换；`session/flush` 与定时器双保险落盘。
- `aux`（实时补记）事实单独存放：**重建全部只清日志事实，aux 永不丢**。
- 冷启动按 `sessionPersistence.list()` 的 `sizeBytes` 指纹跳过未变化会话（物理文件大小，append-only 可靠）。

## 五、配置（组合行 `config`）

分组维度由 `dsh-model-groups` 提供（未命中任何分组的落「未分组」桶；该插件不在线时
「分组」页签会说明原因，接口不报错）。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `timeZone` | `null`（跟随系统） | 日/周分桶所用 IANA 时区 |
| `weekStart` | `1` | 周起始：0=周日，1=周一 |
| `liveOnlyPurposes` | `['session-title']` | 实时补记白名单；**不要加 compaction** |
| `attributeSubagents` | `own` | `own`=子代理会话单列；`root`=按 `parentSession` 链归到根会话 |
| `modelAliases` | `{}` | 模型别名表：`{ "请求名": "显示名" }`，覆盖内置表；**只换显示，不改统计键** |
| `modelNamesTtlMs` | `30000` | 「模型设置」展示名索引的刷新间隔（请求驱动，最小 5000） |
| `extraSessionRoots` | `[]` | 追加的 sessions 根目录 |
| `zipImportDirs` | `[]` | 归档 zip 目录 |
| `flushIntervalMs` | `5000` | 落盘抖动间隔 |
| `autoBackfill` | `true` | 启动后自动增量回填 |
| `maxRows` | `500` | 单次查询返回上限 |
| `excludeMirroredSessions` | `true` | 设备网格镜像：执行端 `sessions/` 里对端会话副本不计入本机账本（见一·设备网格镜像）；`false` = 回退旧行为 |

## 六、HTTP 路由（同源；写操作带同源守卫）

```
GET  /dsh-usage/summary?by=model|provider|group|session|day|week
                        &range=all|1d|7d|30d&from=YYYY-MM-DD|epochMs&to=…
                        &tz=Asia/Shanghai&subagents=own|root&limit=500
GET  /dsh-usage/status        回填进度 / 事实数 / 缺口计数 / 配置回显 / 网格镜像排除量（mirrored）
POST /dsh-usage/rescan        {full:boolean} 增量或重建全部
GET  /dsh-usage/export.csv    与 summary 同参
```

`summary` 返回 `{by,timeZone,weekStart,from,to,facts,rows[],totals,truncated}`；行含
`key,calls,input,output,cacheRead,cacheWrite,reasoning,total,sessions,share,providers,kinds`
以及**缓存占比字段** `cacheShare`（逐项实测，`null` = 无缓存数据）/`cacheCoverage`/`cacheUnknownInput`/`cacheKnown`（+`cacheFacts`）
与**速率字段** `ttftAvg/ttftMedian/ttftMin/ttftMax/ttftSamples/ttftExcluded`
`tpsAvg/tpsMean/tpsMedian/tpsSamples/tpsExcluded`（口径见一·平均速率；`null` = 无数据，CSV 留空不当 0）；
会话维度另带 `title/cwd/createdAt/parentSession/origin/archived`；
`totals` 同样带上述两套字段（同口径的整体值，供概览卡片用）；
模型维度另带 `model`（原始请求名）、`provider` / `providerLabel`（拆分值与 displayName）、
`sharedModel`（同名请求是否跨渠道）、`sharedLabel`（展示名是否撞车，决定是否注明供应商）、
`modelProviders`、`alias`（写入 `label`）与 `settingsName`（模型设置展示名，未取到为 `null`）；
供应商维度的行带 `label` = 模型设置里的 provider displayName（未配置则等于 key）。
`export.csv` 表头 25 列：**前 12 列与历史导出逐列一致**，第 13/14 列是 `provider`/`model` 拆分值，
其后 13 列是速率（`ttftAvgSec/ttftMedianSec/ttftMinSec/ttftMaxSec/ttftSamples/ttftExcluded`
`tpsAvg/tpsMean/tpsMedian/tpsSamples/tpsExcluded`）——新列一律**追加在末尾**，
老的位置解析器（第 10 列 = sessions）不受影响；占比百分比两位小数，速率无样本留空而不是 0。
`status` 另含 `mirrored`（网格镜像：`enabled/available/source/error/sessions/synced/devices/
excludedSessions/excludedFacts/excludedTokens/note`——执行端对端会话副本按来源边界排除的量）、
`config.modelAliases`（生效的别名表）、`config.modelNamesTtlMs`、
`rate`（速率口径说明：`metric/note/minGenMs/minOutputTokens/maxPlausibleMs/modelKey/modelKeyNote`）、
`rateCoverage`（速率样本覆盖度：`factsWithSamples/factsTotal/share/note`——老账本缺 `r` 字段时
如实报差多少，并说明点「重建全部」补齐）、
`cache`（缓存占比口径说明：`metric`/`note`/`hasFacts` —— `hasFacts` 只表示「已折叠到任何事实」，
**不表示有缓存数据**）、`modelSettings`（`available/providers/models/names/updatedAt/error`——模型设置名称索引的
回显）与 `backfill.recovered/notes`（原始日志回退记录）。

## 七、浏览器半边（用量区 + 速率区）

设置页新增「用量统计」一节（`settings.section`，order 905）：六页签 + 时间范围 + 子代理归属切换 +
刷新 / 增量回填 / 重建全部 / 导出 CSV，顶部卡片显示总 token、**缓存占比（合计）**、调用次数、会话数、
已记账会话、实时补记条数，底部一行显示时区、周起始、已折叠会话、上次回填时间、速率样本覆盖度与已知缺口。
合计卡是**当前范围所有行的整体值**（悬停会标出它覆盖了多少计费输入），逐项数字看下面的区块。

**用量与速率完全分区**：`orderedPanels` 的版块顺序是
`图表 → 命中率总表(可选) → 用量明细表(可选) → 速率区(可选) → 截断提示`。
用量区只有 token 数值与缓存占比；速率区只有速率列，两区**互不混列**（selftest 有断言：
速率表不得出现「输入/输出/缓存读/缓存写/推理/总计/缓存占比/会话/占比」任何一列）。

**速率区（v13，默认开）**：合计两张卡（平均 TTFT / 平均 TPS，含中位数、样本数、剔除数悬停）+
一张只有速率列的明细表（调用/样本/平均TTFT/中位TTFT/最快最慢TTFT/平均TPS/逐条均值TPS/中位TPS/剔除）。
**分组口径与用量完全一致**：同一批「供应商×模型」条目、同一套标注规则（展示名撞车才注明渠道），
逐条各算自己的速率——不是另起一套按供应商的分组。工具条「速率区」开关可关，选择会被记住。

**单个模型的命中率 = 点名称弹窗（v10，2026-10-09）**：明细表与命中率总表里的
**项名是可点按钮**（键盘可达、悬停变色），点开一个覆盖层弹窗讲清楚**这一项**：
大字实测命中率 + 覆盖度、该项**可测**计费输入的构成条（未命中输入 / 缓存读 / 缓存写，
带 token 图例）、未上报流量单独说明并写清「不进分母」、再列出调用/会话/计费输入/可测输入/
未上报输入/未命中输入/缓存读/缓存写/输出/总计，模型维另附请求名 / 模型设置名 / 供应商
（会话维给工作目录 / 来源 / 归档 / 创建时间 / 父会话）。完全没有可测流量的项显示
「无缓存数据」并说明**命中率不可测（不当作 0%）**，且全弹窗不出现任何 `0.0%`。
关闭方式：右上角「关闭」、点背景、**Esc**；换页签/换范围会自动收起。
不再需要为了看一个模型而铺开整张表。

**命中率总表（可选面板）**：原来常驻的「缓存占比（<维度> 逐项）」卡改成**可选项**——
图表工具条上「**命中率总表**」开关与「明细表」并列，默认**关**（单项走上面的弹窗；
数字列里的「缓存占比」列始终在）。打开后面板落在
**数值表/图表之后、明细表之前**（`orderedPanels`：`图表 → 命中率总表 → 明细表 → 截断提示`），
开关与明细表互不影响。每一行展示该项自己的输入构成条（未命中输入 / 缓存读 / 缓存写，
三段互斥、按该项自己的计费输入摊开）与自己的**实测**占比，覆盖不足时补「覆盖 N%」
（悬停显示未上报的 token 数）；图例给出「有缓存数据 N / M 项」；完全没有可测流量的项
显示「无缓存数据」且不画构成条。明细表「缓存占比」列与逐项横条走**同一条取值路径**
（不会一个说有数据、一个说没有），时间维悬停明细也带上缓存占比
（无数据时显式写「无缓存数据」，不再静默留空）。

**视图偏好持久化（v10）**：页签（模型/供应商/分组/会话/每日/每周）、时间范围、子代理归属、
图表模式、**明细表开关**、**命中率总表开关**都写进
`localStorage['dsh-usage-stats.view.v1']`——刷新、dsh-client-hmr 热换组件、重开设置页都回到
上次的看处。存档**逐项校验白名单**（坏 JSON / 非法取值 / 数组 / `__proto__` 一律丢掉用默认值，
一个坏的 `by` 会让页面误报「host 没接入该维度」）；存储不可用（隐私模式/配额满）时静默降级、
页面照常工作。弹窗是瞬态状态，**不**持久化。

**图表**（纯手写 SVG/CSS，无第三方图表库）：

| 维度 | 图形 | 说明 |
| --- | --- | --- |
| 每日 / 每周 | 堆叠柱状图 | 每根柱按 输入 / 输出 / 缓存读 / 缓存写 堆叠；悬停任意一列显示该桶完整构成（含缓存占比） |
| 每日 / 每周 | 折线图 | 总量趋势 + 面积填充；悬停放大数据点 |
| 每日 / 每周 | 累计 | 累计总量曲线（末点 = 区间总量） |
| 模型 / 供应商 / 会话 | 横向条形图 | Top 20，条内同样按四类堆叠，副行给出调用次数 / 会话数 / 已归档 / 子代理 |
| 模型 / 供应商 / 会话 | 环形占比图 | Top 8 + 「其它」合流，中心显示总量，右侧图例带百分比与调用次数 |
| 全部维度 | 命中率总表 | 每项自己的可测输入构成与实测占比（含覆盖度，见上）；可选项，默认关，排在数值表后明细表前 |

图表模式用「图表」一行页签切换，「命中率总表」「明细表」两个页签分别控制两块面板显隐
（在数值表之后、明细表之前依次排布）；网格线/坐标轴/文字走主题 token
（`--dsw-alias-border-l1` / `--dsw-alias-label-secondary`），折线与面积走 `--dsw-alias-brand-primary`，
序列色是固定的中调色（浅色/深色主题下都可读）。

**模型标注名（2026-10-08 起优先用「模型设置」展示名）**：模型行显示
**DSH 自带「模型设置」里配置的模型展示名**（Settings → Models 那张表，即
settings.yaml 的 `llm-pi-ai.providers.*.models[].name`，运行时经 `llm.listProviders ×
listModels` 枚举——两个同名模型在设置里各有展示名时按行内 `providers` 精确匹配）。
解析顺序：`config.modelAliases` > **模型设置展示名** > 内置表 > 兜底美化
（取最后一段、`:free` → `（免费）`、词元大小写修正：`openai/gpt-5.2-turbo` → `GPT 5.2 Turbo`）。
llm-pi-ai 对未配置 name 的模型回退 `name=id`，索引把 **`name=id` 视为未配置**，
让标签落到内置表/兜底美化，绝不把展示名退化成原始请求名。**原始请求名在悬停提示
与副行里始终露出**。统计行的 `key` 永远是请求名，因此**不同写法不会被合并**
（`deepseek-ai/deepseek-v4.1-flash` 与 `deepseek-ai/DeepSeek-V4.1-Flash` 仍是两行、
别名各按设置取，悬停即可分辨），CSV 与接口也都保留原样请求名。

**供应商行同理**：`by=provider` 的行 `label` 用模型设置里的 provider displayName
（如 `localhost` → `NewAPIGate`），未配置则保持原 key。

**名称索引的来源与生命周期**：请求驱动（summary / export.csv / status 路由先
`ensureModelNames()`，最多等 3s），按 `modelNamesTtlMs`（默认 30s）惰性刷新、单飞；
llm 服务不可用或抛错时安全退化为旧链（status 里 `modelSettings.available=false`
如实报告）。刷新成功后**持久化到 `state.json` 的 `modelSettingsNames`**，
离线 `preview.mjs` 读同一份，两边展示名一致（账本还没写入前 preview 自动回退内置表）。

## 八、生效方式与本环境的注意事项

组合行（`~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- insert:
    - id: usage-stats
      name: ./plugins/dsh-usage-stats/entry-v10.js
      config: { timeZone: Asia/Shanghai, weekStart: 1, … }
```

- 本 profile 未开模块热载：改 `index.js` 后要让**已挂载**的实例更新，需换行 `id`（或重启 dsh）；
  `client.js` 由 dsh-client-hmr 直供，改动可热换，但**首次新增 `dsh.client` 声明后浏览器要刷新一次**。
- **2026-10-08 实测记录**：本 profile 的 `patchReload: live` 当前**不可用**——任何 patch 文件改动都会触发
  整棵 include 重建，而其中的 `our-free-model-v3` 行重挂时抛
  `an adapter for provider "our-free-model" is already registered`，导致整次更新回滚（新行被建又拆）。
  证据：`~/.dsh/patch-probe.jsonl` 的 4 条 `hmr-failure`（含本次 2026-10-08T04:56:24Z）。
  **2026-10-08 12:05 用户重启 dsh 后本行已正常挂载**（`/dsh-usage/*` 全部 200）。
- 此后改动 `index.js`（host 半边）**不会被运行实例感知**（实测：touch 后 status 里没有新增字段），
  需再重启一次；`client.js` 走 client-modules 的 bundle 重建 + HMR，刷新页面即可拿到新版。

## 八点五、修复记录：切页签时闪出的那行红字（2026-10-08）

用户实测：设置页点开「分组」页签会闪出一行红字「统计插件返回的维度是「model」而不是「group」……」
随即消失，功能最终正确。两处根因都在浏览器半边 `client.js` 的取数逻辑（**不是** host 缺维度）：

1. `load()` 没有丢弃**过期响应**——切页签/换范围/改子代理归属时会同时有多个在飞请求，
   原来是「谁后到谁写状态」。旧维度的响应会覆盖新维度：页面显示上一个维度的数字，
   甚至能把新维度的结果永久顶掉。
2. 加载期间界面仍持有上一个维度的 `data`，而维度自检那行比的是 `data.by !== by`，
   于是**点击瞬间**就成立 → 红字出现；新响应到达后又不成立 → 红字消失（闪现）。

修法（都在 `load()` 里，不动 host 与统计口径）：

```js
const loadSeq = React.useRef(0);
const load = React.useCallback(async () => {
  const seq = ++loadSeq.current;      // 只让最新一次请求写状态
  setLoading(true); setError(null);
  setData(null);                      // 不拿上一个维度的结果跟新页签比对
  try {
    const summary = await fetchJson('/dsh-usage/summary?' + query);
    const state = await fetchJson('/dsh-usage/status');
    if (seq !== loadSeq.current) return;          // 过期响应：丢弃（错误路径同样判）
    setData(summary); setStatus(state); setHoverIndex(null);
  } catch (err) {
    if (seq !== loadSeq.current) return;
    setError(errorText(err));
  } finally {
    if (seq === loadSeq.current) setLoading(false);
  }
}, [query]);
```

第二轮（对抗性验证发现两处「同类但未修」+ 一处结构性弱点，已全部修掉）：

3. **红字仍会被提交进 DOM（只是没被画出来）**：`setData(null)` 写在 `load()` 里，而
   `load()` 由 effect 触发——真实浏览器实测（React 18.3.1 + Chromium，`createRoot`）红字在
   **点击时刻 +0ms** 仍进过一次 DOM，只是 React 对离散事件会在绘制前冲刷被动 effect，所以
   0/341 次采样都看不到它。换成定时器/过渡更新触发 `by` 变更就会露出来。改法：换维度/范围/
   子代理归属时**在同一次状态更新里**清旧结果（`changeQuery()`，包住 4 个按钮的 onClick），
   并跳过「点的就是当前项」的无效点击（query 不变就不会重新取数，清了只会让表格一直空着）。
4. **回填轮询的 `setStatus` 是同一类竞态**：`/dsh-usage/status` 往返超过 900ms 时两次 tick
   同时在飞，旧响应会把状态行「已折叠 / 事实」的数字顶回旧值（验证者已复现：99/999 被 1/10 覆盖）。
   改法：轮询也用 `pollSeq` 序号，只让最新那次写状态行（完成判定保持在后，不受影响）。

### 回归套件（`client-race-selftest.mjs`，9 项）

| 项 | 断言 | 修复前 |
| --- | --- | --- |
| R1 | 点开分组页签瞬间无红字、无旧维度的行 | 挂 |
| R2 | 旧维度响应后到不写状态 | 挂 |
| R3 | 旧响应**晚于**新响应落地仍显示新维度 | 挂 |
| R4 | 旧请求失败不覆盖新请求的成功 | 挂 |
| R5 | 宿主**真的**不支持该维度时红字照常出现（过修守卫） | 过（设计内） |
| R6 | 快切三页签乱序回包只认最后一个 | 挂 |
| R7 | 点击当次提交就不含红字（结构性，不依赖 effect 时序） | 挂 |
| R8 | 回填轮询旧响应不覆盖新数字 | 挂 |
| R9 | 点当前项（无效点击）不清空表格、不多发请求 | 过 |

三轮 A/B（同一套件指向不同版本）：

```
原始版本             SELFTEST FAIL (2 passed, 7 failed)
第一轮修复后（loadSeq）SELFTEST FAIL (7 passed, 2 failed)   ← R7/R8 正是第二轮才修的
第二轮修复后          SELFTEST PASS (9 checks client-race)
```

无头桩的局限（务必知道）：`useEffect` 桩不实现依赖数组、setState 不自动重渲染，所以它**测不出**
「红字是否被提交进 DOM 又被绘制前冲刷」这类时序差；R7 用「点击后不跑 effect 直接渲染」把这条
结构性性质单独钉住。真实浏览器验证（含线上包 rev 采样）由 `/tmp/adv-race/browser/` 那套
（Chromium + `createRoot` + 1ms 采样 + MutationObserver；注意 headless 虚拟时间下 **rAF 不可靠**）
完成，属一次性验证物，不入库。

## 八点六、v10 交互改造的验证记录（2026-10-09）

改「点名称弹窗 + 可选总表 + 视图偏好持久化」时，用 22 处**变异测试**逐条证明新增断言不是
恒真的，抓出的问题都出在**测试与接线**上，值得记下来：

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 三条弹窗断言「变异后仍通过」 | 断言用 `includes('覆盖 90.0%')` / `includes('请求名')` / `includes('命中率不可测')`，被**同一份弹窗里的别处文案**喂饱（未上报说明、`hoverTitle` 副标题） | 改成**结构化**断言：按 class 找 `.ust-ccover` 节点比内容、按 `props.key` 列键值项、hero 文案取 `.ust-modal-ratek` 节点 |
| `client-race-selftest` 首列文本从 `model-row` 变成 `p` | 表格键列写成 `h(KeyCell, …)`，两个无头套件**都不展开函数组件**，`rowLabels` 只好退回副标题读（`providers: ['p']`） | 表格与总表里 `KeyCell` 一律**直接调用**（本文件既有约定），并加源码级断言禁止 `h(KeyCell` |
| 弹窗在刷新/回填后显示旧数字 | `detail` 存的是**行对象快照** | 改存行**键**，每次渲染用 `rowByKey(rows, key)` 重新取；行不在当前视图就自动收起（`rowByKey` 可无头断言） |
| `Donut` 画出 `NaN%` | `total = reduce(...) || 1`——`NaN` 是 truthy，`NaN \|\| 1` 仍是 `NaN` | 扇形值入口统一折成有限数 |
| `TimeChart` 在缺 `key` 的行上抛错 | 轴标签直接读 `r.key.length` | `String(r.key \|\| '')`（渲染里抛错会把整页带塌） |
| 空行渲染出「模型 · undefined · 缓存命中率」 | `r.label \|\| r.key` 没有兜底 | `displayName()` 统一兜底 `(未命名)`，五处调用点共用 |
| `UsageStats` 内部接线零覆盖 | hooks 组件无法无头渲染（无 `require` 得到的 React） | 加一条**源码级接线自检**（两处入口 / 三种关闭 / 落盘 / 初值恢复 / 扁平树约定），明确标注它的代价是重构这些行时要同步改断言 |

顺带把 `client-race-selftest.mjs`（9 项）纳入本轮回归：它测的是「切页签闪红字」那套过期响应
竞态，**改任何 `UsageStats` 接线后都必须重跑**（这次就是它先抓出首列文本跑偏的）。


## 九、自检与运维

```bash
cd ~/.dsh/profiles/web/plugins/dsh-usage-stats

node selftest.mjs            # 58 项：合成 / 全语料对账 / zip 往返 / 假环境全链路 / 图表结构 / 命中率弹窗与面板顺序 / 速率口径与分区 / 视图偏好持久化 / 别名 / 模型设置名称链 / 网格镜像来源边界（F 段恒跑）
node selftest.mjs --quick    # 只抽样 12 会话（~1.6s）
node selftest.mjs --limit 200 # 只抽样 200 会话跑 B~E 段（语料大时的省内存全链路）
node client-race-selftest.mjs  # 9 项：浏览器半边「过期响应」回归（切页签不闪红字、不显示旧维度、轮询不乱序）

node prewarm.mjs --dry-run             # 只统计不写盘
node prewarm.mjs --tz Asia/Shanghai    # 离线重建账本（幂等，可随时重跑）
node prewarm.mjs --root /backup/sessions --zip ~/exports   # 并入其它 home / 归档 zip
node prewarm.mjs --replace             # 丢弃日志事实重建（aux 保留）

node preview.mjs                       # 账本 → 单文件 HTML 预览（图表 + 别名 + 明细，离线可看）
node preview.mjs --source corpus       # 不读账本，直接折 sessions 目录
```

`prewarm.mjs` 与运行时用**同一个** `fold.js` / `store.js`，所以离线出的账和插件挂载后接着记的账是同一本；
它的 `会话 N（有账单 M）` 下面会多一行「网格镜像：K 条对端会话副本，按来源边界排除 X 次调用 / Y tokens」，
与运行时 `/dsh-usage/status` 的 `mirrored` 同口径，可用来在不重启插件的情况下预演排除量。

**内存注意（2026-10-19 实测）**：B~E 段的语料桩把**全部会话的事件**常驻内存（`loadCorpus`），
本机 1840 会话时峰值 >4.5 GB —— 7 GB 的机器跑全量 `node selftest.mjs` 会打到 swap。
要么用 `--quick` / `--limit N`，要么把 `DSH_HOME` 指到一个只放抽样会话的临时 home 跑全量。
F 段是合成语料，任何情况下都跑。同目录里两代日志（v3+v4，实测 95 处）按**最高世代**去重
（原先同一条会话会被语料桩算两次，D 段两条断言因此假失败——已修）。

## 十、实测基线（2026-10-08 12:40，本机）

- 语料：229 个日志文件 / 133.4 MB（压缩态）/ 0 解析错误；有账单会话 225。
- 折叠事实：20,129 条；总计 3.43 B tokens；供应商 localhost 3.32 B、our-free-model 114 M。
- 模型前列：`deepseek-ai/deepseek-v4.1-flash` 1.41 B、`step-5-preview` 1.22 B、
  `deepseek-ai/DeepSeek-V4.1-Flash` 688 M、`mimo-v2.6-flash-free` 109 M。
- 日期跨度 2026-09-26 … 2026-10-08（11 天 / 3 周，Asia/Shanghai 分桶）。
- 运行实例（12:05 启动）启动回填：扫描 223 · 折叠 35 · **跳过 185**（sizeBytes 指纹命中）· 导入 0；
  实时补记 aux 17 条；缺口 noUsageMessages 23、titleRequests 14。
- selftest 全量 **58/58** 通过（含缓存占比 4 项：逐项实测口径与覆盖度、混合项不稀释、
  分组维度同口径、UI 逐项构成条与「无缓存数据」不落到有数据的行）。

## 十一、实测基线（2026-10-31，v13 模型分桶 + 平均速率）

- 语料：277 个日志文件 / 303.4 MB（压缩态）/ 0 解析错误；280 会话入账。
- 折叠事实 46,962 条（log 46,803 + aux 159），总计 10.21 B tokens、46,974 次调用。
- **模型条目 23 条**（v10 口径 16 条——16 → 23 就是被拆开的同名跨渠道模型）：
  `opencode-go/deepseek-v4.1-flash` 3.68 B / 21.4 k 次、`insidegate/step-5-preview` 3.28 B /
  12.8 k 次、`loomy/spark-x2.6` 0.98 B、`zcode/GLM-5.3-Flash` 0.65 B、
  `deepseek-account/deepseek-flash` 0.44 B、`trae/deepseek-v4.1-flash` 0.41 B。
- **撞车组（展示名相同 → 一律注明渠道）**：
  `DeepSeek V4.1 Flash` × 4（opencode-go / local-gateway / Our Free Model / local-gateway，
  由 3 种不同请求名解析而来）、`GLM-5.3 · x0.78` × 3（trae / zai-coding-cn / zcode-cli）、
  `Step-5-Preview · x0.48` × 2、`Qwen3.8-Flash · 免费` × 2。
- **速率覆盖**：45,256 / 46,974 次调用（96.4%）带 stream 时间戳；
  合计平均 TTFT 8.67 s（中位 4.37 s）、TPS 93.4 tok/s（逐条算术均值 137.5）；
  剔除 20 条超 5 分钟的污染点（最长一条 3 小时）。
  逐条示例：`opencode-go/deepseek-v4.1-flash` TTFT 8.33 s / TPS 126.7；
  `insidegate/step-5-preview` TTFT 8.34 s / TPS 81.9；`loomy/spark-x2.6` TTFT 13.08 s / TPS 112.9。
  `deepseek-official/deepseek-v4-pro` 141 次调用**全程无 stream 时间戳**（该渠道日志不记流内
  时刻）→ 速率如实显示「无数据」，token 数字不受影响。
- `sharedLabel` 交叉验证：按 live 接口 23 行逐行重算「展示名计数>1 或 sharedModel」，
  与接口返回值 **0 处不一致**。
- 回归：`node selftest.mjs` 全量 **57/57 通过**（本机 python3 不可用，C 段 1 项跳过）；
  `client-race-selftest.mjs` **9/9 通过**；`prewarm.mjs --dry-run` 与 `preview.mjs` 离线通路正常。
- 本次自检顺手修正了一条**基线就存在**的假失败：B 段「每条用量事件都带 time」把旧格式的
  顶层流分块行（`text-chunks` 等，只有 `seq0/time0`、没有 `seq`，折叠本来就会跳过）也数进去了，
  某会话 5,171 行导致恒红。改为「带 `seq` 的可折叠事件必须带 time」+ 点名断言速率端点
  那几类事件必须有 time，旧格式行改为记入 notes 观测。