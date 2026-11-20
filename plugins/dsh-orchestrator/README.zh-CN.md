# dsh-orchestrator（DSH 编排器插件）

为 DeepSeek Harness 提供多子代理编排：把目标拆成任务 DAG → 并行派发全新子代理 → 按角色路由模型 → critic 校验 → 关键失败自动重规划 → 综合成一份最终报告。

```
目标 ─▶ 规划器 ─▶ [ 任务 ─▶ 工人 ─▶ 校验? ]×DAG ─▶ 综合 ─▶ 报告
                 └────── 重试 / 重规划 / 预算守卫 ──────┘
```

## 工具

| 工具 | 作用 |
|---|---|
| `orch_run` | 规划并执行一次编排。默认 `wait=await` 阻塞到运行结束返回完整报告；`wait=background` 立即返回 runId。 |
| `orch_status` | 不带 `runId`：列出运行中与最近的编排；带 `runId`：完整报告（计划、任务状态、失败原因、综合结论）。覆盖实时运行、内存历史与磁盘日志。 |
| `orch_cancel` | 取消一个运行中的编排；`runId=all` 取消全部。 |

工人是**全新子代理**（`spawn` 后端）：不共享当前会话记忆，因此规划器为每个任务生成自包含提示词。任务提示、验收标准、依赖产物、重试反馈全部经由 `src/core/prompts.ts` 的提示词构造器下发。

## orch_run 参数

`goal`（必填）· `context` · `plan`（调用方自带计划，JSON 文本，跳过规划器）· `runId` · `wait` · `maxParallel` · `maxActivations` · `maxTasks` · `timeoutMs` · `maxAttempts` · `maxReplans` · `verify` · `synthesize`。

自带计划格式：`{"tasks":[{id,title,role,prompt,dependsOn,acceptance,critical,verify,outputSchema}]}`；id 匹配 `^[a-z][a-z0-9_-]{0,31}$`；`outputSchema` 必须是 object 根 JSON Schema，仅允许 `type/oneOf/properties/required/additionalProperties/items/enum/const`（`minLength` 等本地校验关键字由引擎执行、投递宿主前自动投影剔除）。

## 配置

```yaml
- id: orchestrator
  name: dsh-orchestrator
  config:
    provider: spawn            # ctx.subagents 后端
    history: 20                # 内存中保留的已完成运行数
    defaults:                   # 单次运行默认值
      timeoutMs: 1200000        # 单次激活超时
      maxAttempts: 2
      verify: false             # 每个任务跑 critic
      maxParallel: 3
      maxReplans: 1
      maxPlanRepairs: 1
      synthesize: true
      dependencyContextChars: 4000
    limits:                     # 硬上限，全部可选（示例展示全部旋钮；出厂默认仅带 maxActivations: 40）
      maxActivations: 40
      maxTasks: 24
      maxWallMs: 3600000
      maxOutputChars: 2000000
      maxTokens: 4000000
    routing:                    # 角色 → 路由
      roles:
        coder: { provider: p2, model: m2 }
        reviewer: { reasoningEffort: high }
      rules:
        - name: heavy-research
          match: { role: researcher }
          route: { model: big-context }
      default: { provider: p1 }
```

路由优先级：任务显式 route → 首条匹配规则（支持通配）→ 角色表 → `default` → 继承父代理。路由映射为每个子代理的 `agentOptions` 覆盖。注意：只换 `provider`/`model` 不带 `reasoningEffort` 时，父级 effort 会被有意清空。


## 工具箱开关与本会话子代理菜单

dsh-workbench 工具箱里有 Orchestrator 的按会话开关：**新会话默认关闭**——`orch_run` 对该会话隐藏、会话事件触发器停用；在工具箱里拨开即对本会话启用。开关选择**双向按会话持久化**（拨开存开、拨关存关，`$DSH_HOME/dsh-orchestrator/sessions.json`），随时可以再改，不锁定。行内二级菜单「子代理设置」可指定本会话的子代理默认：模型（来自宿主 llm 目录）、思考力度、后端（spawn / fork）——同样按会话落盘、即时生效，所选模型成为本会话的默认路由（插件配置里的显式角色/规则仍优先）。

## 会话事件触发器（可选）

在插件配置里加 `triggers`，匹配到的用户消息会自动启动一次后台编排：

```yaml
    triggers:
      - name: nightly-digest
        textIncludes: /digest
        goal: 生成工作区夜间摘要并写入 docs/digest.md
        context: 基于当前工作区；总结变更文件与未完成事项。
        once: true          # 每个会话至多触发一次（默认）
      - name: scheduled-audit
        textIncludes: /audit
        source: [schedule]   # 也匹配定时任务投递的提示
        goal: 审计 terra_chat 部署
```

触发器只在该会话存在**存活 agent** 时生效（委派接缝要求精确存活的父代理）；匹配到但无存活代理的会话会记日志跳过。定时驱动的编排与 DSH 自带调度天然组合：定时投递的提示可直接调用 `orch_run`，或如上匹配 `source: [schedule]` 触发器。
## 日志与事件

- 每次运行在 `$DSH_HOME/dsh-orchestrator/runs` 落盘 `<runId>.events.jsonl` 事件流与 `<runId>.record.json` 最终记录（可用 `dataDir` 覆盖）。
- Cordis 事件：`orchestrator/run-start`、`orchestrator/run-end`、原始流 `orchestrator/event`（均为 emit 模式），供 UI 与观察者订阅。
- Token 记账：把每个子会话 `assistant/message` 的 usage 折入运行预算。

## 架构

```
src/core/   纯引擎，零 harness 依赖（types/graph/plan/router/budget/
           retry/jsonschema/prompts/engine/report）
src/dsh/    适配层（journal、config、runs、subagents 端口）
src/index.ts 插件入口：工具注册、配置、事件、usage 记账
test/       71 个 vitest 用例；引擎离线跑在脚本化假端口上
examples/offline-demo.ts   npm run demo —— 无需 harness 的全流程演示
```

引擎执行流：规划（带修复重试）→ 并行 DAG 波次（`maxParallel`）→ schema/stopReason 判定 → 可选 critic → 带退避的重试 → 依赖失败级联 → 重规划（保留已成功任务）→ 预算守卫 → 综合。失败类别：`timeout`、`aborted`、`child-error`、`schema-invalid`、`critic-rejected`、`start-failed`、`budget`、`dependency`、`infra`；仅前五类会重试。

## 安装

要求 DSH >= 0.2.0-rc.1（见 `engines.dsh`）。

```bash
npm install && npm run build
dsh plugin --profile desktop add <repo>/plugins/dsh-orchestrator
# 或 GUI：Plugins → Install → <repo>/plugins/dsh-orchestrator
```

随后重启 DSH（或等 HMR reconcile）。用 `plugin_manager list_plugins` 验证，并在会话里确认新增 `orch_run` 工具。

## 已知边界

- `spawn` 子代理到达宿主深度上限后不能再继续委派；需要更深时配置 `maxDepth`。
- critic 自身故障不会毁掉好结果：校验器不可用时任务以带告警的形态通过。
- `wait=background` 的运行不依赖工具调用存活，但结果不会自动推回父会话；用 `orch_status` 轮询。
- 每次激活的超时由引擎强制；`startActivation` 本身没有传输层超时。