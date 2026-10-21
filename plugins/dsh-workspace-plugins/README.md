# dsh-workspace-plugins —— 工作区插件容器

**一句话**：把**普通 Cordis 插件**挂到**指定工作区**的会话上——工作目录命中该工作区的
会话才装上它们，别的会话完全看不见；会话结束随之卸载，一行都不留。

```
声明一次  →  只有 /root/nas/ArkTower 的会话多出这几个工具 / 提示词段 / 钩子
             /root/other 的会话照旧，进程里其它 30 个会话照旧
```

---

## 为什么需要它

DSH 原有的两档能力都表达不了「只给某个工作区的会话加一个插件」：

| 想要的效果 | 原有手段 | 局限 |
| --- | --- | --- |
| 所有会话都要 | 组合行（`cordis.patch.yml` 的 `- insert:`） | **进程级**：一挂全挂，没法只作用于某个工作区 |
| 某场会话换一整套工具/提示词/技能 | agent preset | **整场会话级**：它是「换一套」，不是「加一个」；且与工作区无关 |
| **只给某个工作区的会话加插件** | **本插件** | —— |

典型用法：某个仓库需要额外的构建/部署工具；某个工作区需要一条常驻约定提示词；某个
项目要挂一个只在它里面开着的调试钩子。

---

## 机制（30 秒版）

1. 出厂给每个 agent 的上下文都带一个**作用域键**（`@deepseek-ai/dsh-scope`）。
2. 工具注册表、提示词注册表、以及带 agent 作用域载体的事件，都是**按作用域层投影**
   的注册表：装配期沿该 agent 的作用域链取层。
3. 本插件监听 `agent/created`，按 `session.header.cwd` 判定命中哪个工作区；命中就把
   该行的模块挂到**这个会话自己的 `agent.ctx`** 下。
4. 于是注册落进它自己的层：只有这个会话的模型看得见、调得到；`agent/disposed`、清单
   变更、插件卸载都会把它摘掉。

这与出厂 `dsh-agent-presets` 的 `mountPreset()` 是**同一套机制**（它也是把一份组合挂到
`agent.ctx` 下），差别只在时机与来源：

| | preset | 本插件 |
| --- | --- | --- |
| 挂载时机 | 会话**发布前**（`agents.create({setup})`） | `agent/created` **之后** |
| 来源 | 磁盘上的组合文件 | 组合行 `config.workspaces` + 状态文件 |
| 额外要求 | —— | 子插件模块必须**预导入**（apply 时就 `import`），否则第一轮请求可能在挂载完成前装配，模型看不到本该有的工具 |

---

## 快速开始

### 方式 A：设置页（推荐）

设置 →「工作区插件」（order 30）：

1. 「新建工作区声明」填一个**绝对路径**，选匹配方式（`精确`＝只有该目录，`子树`＝含所有
   子目录），点「添加」；
2. 在该工作区下「＋ 加一行插件」：填 `id`、模块标识（如
   `./plugins/dsh-your-plugin/index.js`），需要就填 `config` 与 `isolate`；点「探测」可先
   让 host 真的 import 一次，形态不对会当场告诉你；
3. 点「保存」——立即生效，**活着的会话按新清单重挂**（清单没变则不抖动）。

清单落在 `$DSH_HOME/workspace-plugins.json`（原子写）。

### 方式 B：组合行（部署方写死）

```yaml
- insert:
    - id: workspace-plugins
      name: ./plugins/dsh-workspace-plugins/entry-v3.js
      config:
        file: null                 # 状态文件位置；null = $DSH_HOME/workspace-plugins.json
        workspaces:
          - path: /root/nas/ArkTower
            match: subtree         # exact（缺省）| subtree
            label: ArkTower        # 可选，仅显示用
            plugins:
              - id: deploy-tools
                name: ./plugins/dsh-ark-deploy/index.js
                config: { dryRun: false }
              - id: debug-hook
                name: ./plugins/dsh-ark-debug/index.js
                isolate: { arkDebugState: true }   # 该行 provide 服务时才需要
```

组合声明的行在设置页里**只读展示**（带「组合配置」徽章）；可以停用，停用标记写状态
文件（`configDisabled`），**不改组合文件**。

### 30 秒验证

```bash
# 1) 容器在不在（返回 JSON 即组合行已加载）
curl -s http://127.0.0.1:3080/dsh-workspace-plugins/status | head -c 300

# 2) 挂上示例探针（示例模块不是框架的一部分，仅用于冒烟）
curl -s -X POST http://127.0.0.1:3080/dsh-workspace-plugins/save \
  -H 'content-type: application/json' \
  -d '{"workspaces":[{"path":"/root/DSHpluginWorkSpace","plugins":[
       {"id":"probe","name":"./plugins/dsh-workspace-plugins/examples/probe-tool.js"}]}]}'

# 3) 看它是否挂到了活会话上
curl -s http://127.0.0.1:3080/dsh-workspace-plugins/state | python3 -m json.tool | head -40

# 4) 该工作区的会话里会多出一个工具 workspace_plugin_probe，问一句就能看到它回报自己的
#    sessionId / cwd；别的目录的会话看不到这个工具。

# 4b) 带浏览器头的请求必须带令牌（DNS rebinding 防护）；纯 curl 不需要：
curl -s -H 'Origin: http://evil.example:3080' -H 'Host: evil.example:3080' \
     -H 'Sec-Fetch-Site: same-origin' http://127.0.0.1:3080/dsh-workspace-plugins/status   # -> 403

# 5) 清空（卸载）
curl -s -X POST http://127.0.0.1:3080/dsh-workspace-plugins/save \
  -H 'content-type: application/json' -d '{"workspaces":[]}'
```

---

## 配置参考

### 行（`plugins[]`）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✓ | 同一工作区内唯一（`[A-Za-z0-9][A-Za-z0-9._-]*`）。同 id 与组合声明冲突时，组合那条生效，本地那条标 `conflict` 且不挂载 |
| `name` | ✓ | 模块标识，见下表 |
| `config` | | JSON 对象，原样传给子插件的 `apply(ctx, config)` |
| `isolate` | | `{ 服务名: true }`＝**每个会话一个独立服务域**（两个会话各自 `provide` 同名服务不撞车）；`{ 服务名: "标签" }`＝同名标签的会话共享一个域 |
| `disabled` | | `true`＝不预导入、不挂载（设置页一键切换） |

### `name` 支持的形式（与组合行同口径）

| 形式 | 例 | 解析基准 |
| --- | --- | --- |
| 相对路径 | `./plugins/x/index.js` | **组合文件所在目录**（本 profile 的 `plugins/`） |
| 绝对路径 / `file:` | `/opt/foo/plugin.js` | 原样 |
| 裸包名 | `@deepseek-ai/dsh-tools` | Node 规则（从 profile 向上找 `node_modules`） |
| 内建 | `cordis:group`、`cordis:include` | loader 的 `builtins` 表（不是 URL） |
| 带缓存键 | `./plugins/x/index.js?v=2` | 见下文「改子插件代码怎么生效」 |

模块的导出形态三种都吃，口径与 loader 一致（`unwrapExports`）：`export const
apply/inject/name`、`export function apply`、`export default plugin`。

### 工作区（`workspaces[]`）

| 字段 | 说明 |
| --- | --- |
| `path` | 绝对路径（或以 `~/` 开头），realpath 口径；不存在也允许声明 |
| `match` | `exact`（缺省，**只有该目录**）｜`subtree`（含所有子目录）。嵌套声明时：精确优先于子树，同为子树取**最长**（最近祖先） |
| `label` | 可选显示名 |

判定只看会话的 `session.header.cwd`，不看会话来源、不问父子关系。

### 顶层

| 字段 | 说明 |
| --- | --- |
| `file` | 状态文件位置；`null`/省略 = `$DSH_HOME/workspace-plugins.json` |

---

## 设置页

| 区块 | 内容 |
| --- | --- |
| 头部 | 状态文件路径与读取错误、模块解析基准、活会话数、已挂载会话数、`client vN` / `host wsp-N` 版本徽章、保存/撤回/重新加载/重挂活会话 |
| 工作区（N） | 每个工作区：路径、匹配方式、来源（组合配置/设置页/两处）、活会话数、每一行的**实时状态**（`3/3 会话生效`、`1 失败`、`等待服务`、`已停用`、`与组合冲突`）与失败原因；设置页那份可直接编辑（加行/停用/删除/上下移/探测） |
| 新建工作区声明 | 路径 + 匹配方式 + 添加 |
| 命中测试 | 填一个目录 → 按当前清单算出它会挂什么（「为什么这个会话没挂上」最快的答案；支持未创建的目录） |
| 活会话挂载 | 每个已挂载会话：命中工作区、匹配方式、sessionId、cwd、它每一行的结果 |
| 诊断（可展开） | 模块预导入结果（每个 specifier 的导入状态与插件形态）、刷新/判定/路由错误计数、最近错误、候选本地模块清单 |

---

## 路由（浏览器半边用，也可直接 curl）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-workspace-plugins/state[?cwd=…]` | 全量视图（清单/挂载/模块/诊断；带 `cwd` 时附「这个目录会命中什么」） |
| GET | `/dsh-workspace-plugins/status` | 精简自检（能力、计数、每会话每行状态、版本） |
| POST | `/dsh-workspace-plugins/save` | 覆盖写状态文件并热重挂（校验失败**不落盘**） |
| POST | `/dsh-workspace-plugins/reload` | 重读状态文件 + 重新预导入 + 强制重挂 |
| POST | `/dsh-workspace-plugins/probe` | 只 import 一个模块看形态，不挂载 |
| POST | `/dsh-workspace-plugins/remount` | 强制重挂（可只给某个 `sessionId`） |

**守卫**（写路由等于「让 host 加载并执行你指定的模块」，是本插件权限面最大的一处）：

| 关卡 | 规则 |
| --- | --- |
| 跨站 | `sec-fetch-site: cross-site` 一律 403（带令牌也拒——令牌不该出现在跨站请求里） |
| 令牌 | 带任何浏览器头（`Origin` 或 `Sec-Fetch-*`）的请求必须带 `x-workspace-plugins-token`，值来自壳层注入的 `globalThis.__DSH_WORKSPACE_PLUGINS__.token`；不匹配即 403。**为什么不能只比 Origin/Host**：两者都是请求方给的，DNS rebinding 下页面从 `http://evil.example:3080`（解析到 127.0.0.1）发出请求时 `Origin` 与 `Host` 恰好一致，「同源」判定会放行。令牌只出现在**受鉴权的** index HTML 里，跨站页面拿不到 |
| 本机调用 | 完全不带浏览器头的 `curl`/脚本照常放行——那种调用方本来就能直接读写同一个状态文件 |
| 模块协议 | 只接受相对路径、绝对路径、`file:`、`cordis:` 内建、裸包名（可用 `?v=` 缓存键）。`data:` / `http:` / `node:` / `blob:` 一律拒绝——`data:` 会被 Node 直接求值 |
| 其它 | 非 GET/POST 一律 405，请求体上限 1 MB；`/save` 必须显式给出 `workspaces` 字段（清空请传 `[]`，防止「只改 configDisabled」把工作区悄悄抹掉） |

> 更新本插件（换 entry）后**设置页需要刷新一次页面**：令牌是随 index HTML 注入的，旧页面
> 拿的是旧令牌，请求会被 403 并提示刷新。刷新后一切照旧；之后再改 `client.js` 由
> `dsh-client-hmr` 热换，不需要刷新。

---

## 边界与已知限制（必读）

1. **只保证注册表层面的隔离**：工具、提示词段、带 agent 作用域载体的事件。出厂里
   **没有作用域载体**的进程级事件（如 `llm/stream` 这类）本来就是全局派发的——挂在那类
   事件上的监听器对所有会话都会触发。要在那种钩子里做「只对本工作区」，得子插件自己
   按会话判断。
2. **`provide()` 服务必须声明 `isolate`**：第二个会话挂载同一服务会撞名，该行会记成
   `failed`（设置页会显示原始错误，不是静默半挂）。这是出厂 preset 审计拦下的同一类问题。
3. **模块在进程内按 specifier 缓存**：改**子插件**的实现后，光改文件不生效。三种处置：
   ①在设置页把那行的 `name` 改成 `./plugins/x/index.js?v=2`（`?v=` 是模块缓存键，实测
   有效）；②重启 dsh；③改**本容器**的实现则要走 entry 版本约定（见文末「维护」）。
4. **判定只看 `cwd`**：`exact` 不含子目录（这是默认档，防止声明意外下沉）；要用子目录
   就选 `subtree`。会话 cwd 缺失时不挂（记 `no-cwd` 诊断）。
5. **子代理会话各自判定**：子会话的 cwd 通常继承父会话，因此同一工作区里的子代理会**各挂
   一份自己的实例**（状态不共享、计数器独立）。这是「按工作区」而非「按会话树」的必然
   结果；不需要给子代理挂的行，现阶段只能靠工作区划分。
6. **插件启动时会给已经活着的会话补挂**（sweep `agents.list()`），所以“先开会话、后装
   插件”也能生效；反过来，删掉声明会立刻从活会话上摘掉。
7. **清单没变就不重挂**：按签名比对，避免每次保存都抖动活会话、丢掉子插件自己的运行时
   状态。要强制重挂用「重新加载」/`/remount`。
8. **没有作用域标签的上下文一律拒绝挂载**（记 `unscoped` 诊断）：那种情况下注册会落到
   进程全局层，等于对所有会话生效——宁可什么都不挂也不能泄漏。另有「疑似全局泄漏」探针：
   一次 sweep 挂一个会话的**全部行之前**记一次全局层工具名，全部结算后再看一次，凭空多
   出来的名字记在该**会话**的挂载记录与页首横幅上。两个诚实的说明：①探针只覆盖**工具名**
   （提示词段、服务、进程级事件监听器不在内）；②窗口按时间切，同一批挂载的多个会话会互相
   算进来，所以它**不定位到具体的行**——要定位就单独开一个只含一个工作区的会话复现。
9. **状态文件与组合声明的优先级**：组合声明优先（同 id 冲突时本地行让位）；组合行可用
   `configDisabled` 停用；状态文件写坏时**不覆盖**，并把错误显示在设置页；若上一份清单
   还有效就**沿用它**（诊断里注明「沿用上一份」），而不是当成空——后者会把活会话上的子插件
   全部卸掉。
10. **子插件自己的 config 校验失败/apply 抛错**只影响该行该会话，兄弟行与其它会话不受
    影响（自测里有专门一项覆盖）。
11. **config 每个会话一份深拷贝**：子插件拿到的 config 不是清单里那个对象，它 `config.x = …`
    不会串到别的会话、也不会被下一次「保存」写回状态文件。反过来，组合声明里若含**无法
    序列化**的值（`!!js` 求值出的活对象/循环引用），设置页会把这些行标红并**拒绝保存该页**
    （视图里那份是占位文本，保存会丢 config）；这类行请直接改状态文件或组合行。
12. **失败/等待中的行可重试**：一次「保存」/「重新加载」会就地重试这些行（签名没变也重试），
    不必先删行再加回来；正在 `active` 的行不会被无谓抖动。
13. **读不到会话列表时不清扫**：`agents.list()` 瞬时失败时本轮不做「活着/已消失」比对，
    已有挂载一个都不动（否则一次抖动会卸掉全部活会话）。

---

## 排错

| 症状 | 多半是 | 处置 |
| --- | --- | --- |
| 设置页整节不见 | 组合行没加载（YAML 写坏 / 模块 import 失败） | `curl /dsh-workspace-plugins/status`；404 就查 profile 启动日志与 `cordis.patch.yml` |
| 会话里看不到工具 | 该行状态不是「生效」 | 设置页看该行徽章与失败原因；`命中测试` 填该会话 cwd 确认命中 |
| 行显示「等待服务」 | 子插件 `inject` 的服务在 agent 作用域里解析不到 | 确认该服务是否只在 host 平面提供；这类行不该挂到会话作用域 |
| 行显示「失败」且提到 registered/provide | 两个会话抢同一个服务名 | 给该行加 `isolate: { 服务名: true }` |
| 改了子插件代码没变化 | 模块缓存 | 行 `name` 加 `?v=2`，或重启 dsh |
| 命中测试说没命中 | 路径不同源（软链接/尾斜杠）或匹配方式是 `exact` | 用 realpath 后的路径；要含子目录就改 `subtree` |
| 保存按钮报错 | 清单校验失败（相对路径、空行、id 重复、config 不是对象） | 报错逐条列在页面上；修正后再保存（校验失败不会写盘） |
| 页面提示「缺少访问令牌，请刷新」 | 本插件更新过（换了 entry），旧页面拿的是旧令牌 | **刷新一次页面**；之后改 `client.js` 由 HMR 热换，无需再刷 |
| 诊断里出现「沿用上一份」 | 状态文件被写坏（手改/半截写） | 修好 JSON 或删掉文件后点「重新加载」；期间清单按上一份有效内容继续工作 |

---

## 文件与自测

| 文件 | 作用 |
| --- | --- |
| `index.js` | host 插件入口：config 归一、清单刷新、`agent/created`·`agent/disposed` 挂钩、路由、诊断 |
| `mount.js` | 挂载运行时：模块解析（内建/相对/绝对/裸包名 + `unwrapExports`）、按会话挂载/卸载、isolate、泄漏探针 |
| `store.js` | 纯逻辑：路径归一、清单校验、两处来源合并、匹配、状态文件读写 |
| `client.js` | 浏览器半边：设置页「工作区插件」（order 30） |
| `entry-v6.js` | 当前热挂入口（specifier 别名 + `?v=` 缓存键），**实现永远在 `index.js`**；v2–v5 保留用于回滚 |
| `examples/probe-tool.js` | 示例子插件：一个「只在该工作区会话里存在」的模型工具（冒烟/演示用） |
| `selftest.mjs` | **34 项**：纯逻辑 + 真 Cordis + 真 tools 注册表 + 假会话（含协议白名单、令牌、序列化安全、会话级泄漏探针、失败重试、读坏文件、config 深拷贝、`/status`↔`/state` 一致性、只 flush 微任务的同步性） |
| `client-selftest.mjs` | **18 项**：无头装载 client.js，验槽位注册、草稿↔状态文件转换与校验、令牌头、以及**真渲染一遍**（加载中/已加载/诊断展开/字段残缺四种形状都不许抛错） |

```bash
node plugins/dsh-workspace-plugins/selftest.mjs          # 末行 SELFTEST PASS 才算过
node plugins/dsh-workspace-plugins/client-selftest.mjs   # CLIENT SELFTEST PASS
```

`selftest.mjs` 里值得单独一提的几项（它们才是这个插件的立身之本）：

- 命中会话的 `tools.schemas(scope)` 里**有**子插件工具，未命中会话**没有**，
  且 `tools.schemas(undefined)`（进程全局层）**也没有**——最后一条才是「没有泄漏到所有
  会话」的判据；
- 同一子插件在两个会话里是**两份实例**（计数器独立）；
- `isolate` 有/无两种语义（第二个会话撞名时如实 `failed`）；
- `agent/disposed`、清单变更（`/save`）、插件卸载（`handle.dispose()`）三条路径都摘干净；
- 没有作用域标签的 agent 上下文被**拒绝**，且全局层不出现任何注册；
- 默认导出 / 插件函数 / `cordis:内建` 三种形态都能挂（与 loader 同口径）；
- 坏子插件只坏自己：该行 `failed` 且错误原文可见，兄弟行照常 `active`；
- 路由守卫（跨站 403 / 方法 405 / 坏清单不落盘 / 无令牌的浏览器请求 403 / `data:` 等协议被拒）；
- 只 flush 微任务（不放时钟）之后工具就已可见——「第一轮请求就装配得上」的同步契约；
- 老会话不再命中工作区时被摘干净（工具消失、全局层不留、挂载记录消失）；
- 泄漏探针**正面**用例：一个故意 `ctx.root.tools.register(...)` 的夹具被报出来，而不同批次的
  干净会话不被冤枉；

---

## 维护：改实现怎么生效

本 profile **没有模块热载**，loader 与 Node ESM 都按 specifier/URL 缓存模块。约定：

1. 改 `index.js` / `mount.js` / `store.js`；
2. 把 `index.js` 里两处相对导入的 `?v=wsp-N` 与 `const BUILD = 'wsp-N'` 一起 +1；
3. 新写 `entry-v<N+1>.js`：`export * from './index.js?v=wsp-<N+1>';`（只做别名，不复制代码）；
4. 把组合行的 `name` 指到新 entry（**保持同一行 `id`**，走 dispose→start）；
5. 确认生效：`curl /dsh-workspace-plugins/status` 里的 `build` 字段，设置页头部也显示
   `host wsp-N` / `client vN`；
6. 换了 entry 之后**提示使用者刷新一次页面**（令牌随 index 注入，旧页面 403 并自带提示）。

只改 `config`、状态文件、或行内容**不需要**动 entry。改 `client.js` 也不需要（`dsh-client-hmr`
每 500 ms stat-poll 该文件，内容一变即算出新 rev 并经 `/plugins/events` 推 rebuilt 帧；
实测：改完 `client.js` 后 `/plugins/events` 里的 rev 变化、按新 URL 取到的字节即新内容）。

**版本历史**：v1 初版 → v2 状态文件/路由 → v3 内建与默认导出形态 → v4 预导入窗口竞态 →
v5 对抗性评审后加固（协议白名单、访问令牌、序列化安全、`agents.list` 失败不清扫、失败行
就地重试、读坏文件沿用上一份、泄漏探针降到会话级）→ v6 `/status` 与 `/state` 形状统一。
