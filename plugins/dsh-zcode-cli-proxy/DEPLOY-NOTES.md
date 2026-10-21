# 本机部署说明（dsh-zcode-cli-proxy @ xray4668）

上游：<https://github.com/kyle123740/dsh-zcode-cli-proxy> 提交 `826a3c8`（v0.3.1，AGPL-3.0）
装配方式：**目录式**（放在本 profile 的 `plugins/` 下，由 `cordis.patch.yml` 的行插入）。
本包未发布到 npm（`npm view dsh-zcode-cli-proxy` → 404），所以走不了「装进 node_modules +
按包名装配」这条路。

## 文件

- `lib/` `test/` `package.json` `README.md` `LICENSE` `cordis.patch.yml` —— 上游内容，
  其中 `lib/app-server.js` 与 `lib/index.js` 各有一处**本机改动**（见下）
- `entry-v5.js` —— **本机新增的入口**（上游没有这一层）：转发上游插件 + 挂设置页的宿主半边。
  **改代码时换这个文件名**（v6、v7…），原因见下面「改完代码怎么生效」
- `local/host-panel.js` —— **本机新增**：设置页的宿主半边（状态采集 + 登录 + 通道测试路由）
- `client.js` —— **本机新增**：设置页的浏览器半边（`window.__ModuleLoader__.load` 形态）
- `verify-e2e.mjs` —— 本机新增（上游的 `test/appserver-startplan.mjs` 写死了 Windows 路径，直接跑必失败）
- `DEPLOY-NOTES.md` —— 本文件
- 未随包：`scripts/`（作者的逆向探测脚本，本机不需要）

## 本机改动 1：修上游在 Linux/macOS 上定位不到 ZCode 运行时（**必须**）

`lib/app-server.js` 的 `resolveBuiltinRuntime()` 拼平台目录名时，只在 Windows 分支做了
arch 映射：

```js
// 上游（非 Windows 分支漏了映射）
const platformDir = process.platform === 'win32'
  ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
  : `${process.platform}-${process.arch}`        // linux/aarch64 → "linux-arm64" ✗
```

而 ZCode 自己的口径（`zcode.cjs` 里的 `resolvePlatformDir`）是：

```js
`${process.platform === 'win32' ? 'windows' : process.platform}-${
   process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}`
```

于是本机算出 `linux-arm64`，而真实目录是 `~/.zcode/v2/runtime/provider/linux-aarch64/…`
（x64 Linux 同理应是 `linux-x86_64`，macOS 是 `darwin-aarch64`）。后果是**连锁的**：

1. `readdirSync` 抛错 → `builtin` 判为 undefined；
2. spawn 时不设 `ZCODE_APP_VERSION` / `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` /
   `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` / `ZCODE_BASE_URL`；
3. `zcode app-server` 直接起不来，stderr 明说
   `无法定位 CLI ZCode Built-in Provider Config：…/agents/glm/provider/zcode-builtin.json`
   （服务端 bundle 的布局里没有那个文件，所以必须由插件把路径喂进去）；
4. 即使绕过，Start Plan 注入与鉴权也会整体失效。

已按 ZCode 的口径改回映射（改动只在这一处，`process.arch` 非 arm64/x64 时保持原样）。
**上游升级后必须重新贴这处修复。**

## 本机改动 2：让改动能在不重启 dsh 的情况下生效（`?v=2`）

本 profile 未开模块热载，且 loader 与 Node ESM 都按**完整 URL** 缓存模块。所以：

- patch 行的 `name` 用**绝对 file:// URL + 查询串**：
  `'file:///home/xray4668/.dsh/profiles/web/plugins/dsh-zcode-cli-proxy/lib/index.js?v=2'`
  （相对路径写法不行：loader 会把 `?v=2` 百分号编码成 `%3Fv=2` 当文件名的一部分，导入直接失败——
  已实测 `file:///…/lib/index.js%3Fv=2`）；
- 查询串**不会随相对解析传播**（`new URL('./app-server.js', '…?v=2')` 会丢掉 `?v=2`），所以
  `lib/index.js` 里对 `./app-server.js` 的导入也写了 `?v=2`。**入口与这里必须一起递增。**

## 相对上游默认值的本机配置差异（都写在 profile 的 patch 行里）

| 配置项 | 上游缺省 | 本机 | 为什么 |
|---|---|---|---|
| `zcodeCliPath` | 自动探测 `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs` 等 | `/home/xray4668/.zcode/server/agents/glm/zcode.cjs` | 候选列表是 Windows/macOS 取向的；Linux 上客户端自带的 CLI 在 `~/.zcode/server/agents/glm/`，不在候选里，不显式指定就**不会注册 provider** |
| `zcodeCliNode` | `node`（PATH 里第一个） | `/home/xray4668/.zcode/server/node` | 用客户端自带的 node v22.16.0，与官方包装脚本 `~/.zcode/server/agents/glm/zcode-agent` 完全一致，避开系统 node 版本差异 |
| `cliCwd` | 空 = 用户主目录 | `/home/xray4668/.zcode/dsh-bridge` | 本机 `$HOME` 是个很大的树（含 webdav/rclone 挂载），让 agent 拿它当工作区会卡死；用专用空目录 |
| `childEnvAllow` | `[]` | `HOME` `USER` `LOGNAME` `SHELL` | 上游子进程 env 白名单是 Windows 取向的，**Linux 上不给 `HOME`** —— agent 的 Bash 里 `~` 展开、git/npm 等都会缺家目录 |

其余全部走上游缺省（`injectStartPlanAccount: true`、`cliModels: [glm-5.3-flash]`、
`zcodeDataBaseDir: ''` = `~/.zcode/v2`、`appServerTimeoutMs: 120000`、`zcodeCliTimeoutMs: 900000`）。

## 怎么用

DSH 设置 → 模型 → 提供方 **ZCode Start Plan（客户端反代）** → 模型 `GLM-5.3-Flash (ZCode CLI)`。

## ⚠ 本机实测结论：通道打通了，但本机这个 ZCode 账号过不了上游鉴权

修完上面的 bug 后，通道**全链路验证通过**（`verify-e2e.mjs`，真跑一轮）：

- builtin 运行时定位到 `3.14.4` ✓
- app-server 常驻进程起来 ✓
- `provider/updateAccountConfig` 注入成功（`providerCount=1 status=received`）✓
- `session/setMode yolo` ✓、`session/setModel` ✓、`session/subscribe` ✓、`session/send accepted` ✓
- agent 回调 `interaction/requestProviderRuntimeHeaders`，插件回了鉴权 ✓
- 请求**真的到了上游**，并带回上游的错误 ✗

上游两条路都被拒（都不是插件的 bug）：

| 目标 provider | 执行渠道 | 上游结果 |
|---|---|---|
| `account:zai-start-plan`（插件硬编码的缺省） | `https://zcode.z.ai/api/v1/zcode-plan/anthropic` | `{"code":1005,"msg":"exceed quota limit"}`，`reason: invalid_request` |
| `account:bigmodel-individual-coding-plan`（试出来的本账号家族） | `https://open.bigmodel.cn/api/anthropic` | HTTP **401** `Provider authentication failed.`（`AI_APICallError: Unauthorized`） |

原因在于**账号家族不匹配**：本机 `~/.zcode/v2/credentials.json` 的
`oauth:active_provider` = `bigmodel`，凭证键也是
`account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:55341787985334995:api-key`；
而插件硬编码注入的是 `zai` 家族的 `account:zai-start-plan`（作者自己的账号是那个家族）。

额外还试出一层（在 /tmp 的临时副本里做的实验，**没有落进本部署**）：bigmodel 端点要求
**ClientRequestSigningV4**，签名凭证必须「恰好含一个分隔符」；`zcodejwttoken` 是 `a.b.c`
两段点，喂进去直接

```
ClientRequestSigningV4Error: Client signing credential must contain one separator.
```

把 apiKey 换成那个 49 字符、恰好一个点的 coding-plan api-key 后，签名错误消失，
但上游仍回 **401 Unauthorized** —— 说明该凭证本身不被 `open.bigmodel.cn` 接受
（过期/被轮换/计划已失效，本机凭证文件是 10-06/10-08 的）。

另外注意：本机 ZCode 客户端自己的 `provider_config.json` 里 `providerOrder` 是
`[InsiderGateway, LMStudio]`，也就是说客户端平时根本没用 Z.AI 的计划通道。
**要真正跑通，需要让 ZCode 客户端重新登录一个确实有额度、且家族与注入 provider 一致的计划账号。**
想换家族时，改 `lib/app-server.js` 的 `START_PLAN_PROVIDER_ID`（本机实测 bigmodel 家族对应
`account:bigmodel-individual-coding-plan`，其模型清单是 `GLM-5.3 / GLM-5.3-Flash`）。

## ⚠ 安全须知

这个「模型提供方」的真身是一个**以当前用户权限运行、带全套工具执行能力的 agent**：

- 插件建会话时把权限模式切到 `yolo`，并对每一次 `interaction/requestPermission` 自动回
  `{decision:'allow'}` —— agent 执行 Bash、读写文件、联网**不会弹任何确认**。
- agent 的输入是 DSH 拍平后的整段对话（含网页抓取、工具结果等**外部内容**）。这些内容里
  若被塞入注入指令，agent 可能据此执行命令。**只在可信场景使用**，不要把不可信网页内容
  喂进挂着本 provider 的会话。
- 鉴权 token 只经本机 stdio JSON-RPC 交给 agent 子进程，不发往任何第三方。
- 凭证解密用的是 ZCode 客户端自己的方案（AES-256-GCM，密钥 =
  `SHA-256(ZCODE_CREDENTIAL_SECRET ?? "zcode-credential-fallback:<platform>:<homedir>:<username>")`）。
  机器指纹是**可预测**的 —— 任何能读到 `~/.zcode/v2/credentials.json` 的本地进程本来也能解出
  token（这是客户端的设计，不是本插件引入的）。真实边界是文件权限 `0600`。
- 子进程 env 按白名单透传（不继承 DSH 宿主的全部 env），本机额外放行了 `HOME/USER/LOGNAME/SHELL`。


## 设置页「ZCode 反代」（本机新增，2026-10-19）

上游插件**没有任何界面**（package.json 里没有 `dsh.client`），所以它只在模型选择器里出现，
设置里看不到任何东西。本机给它补了一个独立设置页：

- 位置：设置 → **「ZCode 反代」**（`settings.section` 槽，id `zcode-cli-proxy`，order 30）
- 内容（全部只读，**绝不回传 token / api-key 明文，只给存在性/长度/分隔符数**）：
  1. **账号与登录**：凭证文件/更新时间、账号 id、用户名、账号家族、`zcodejwttoken` 形态、
     计划凭据（`account-provider:…:api-key` 的长度与分隔符数）
     + **「登录 Z.AI」按钮**：以最小 env 拉起客户端自带的 `zcode login --no-browser`，
       把 OAuth 链接显示在页面上（页面每 2s 轮询，实测 ~8s 后出现），可取消；
       在浏览器完成授权后凭证会写回 `~/.zcode/v2/credentials.json`，页面随即刷新
  2. **通道匹配**：插件注入的 provider 家族 vs 账号家族（当前：注入 `zai` / 账号 `bigmodel` → 不匹配，红字解释后果）
  3. **运行时**：builtin 版本与路径、CLI / node / 工作目录是否存在、数据目录
  4. **最近一次上游错误**：从 `~/.zcode/cli/log/` 最近的 jsonl 里提 providerId / 状态码 / 原因 / 上游消息
  5. **通道测试**：真跑一轮（**消耗额度**），显示答复/用量/实际渠道/错误
  6. **配置（只读）**：zcodeCliPath / zcodeCliNode / cliCwd / cliModels / 超时 / childEnvAllow

宿主路由（同源守卫：`sec-fetch-site: cross-site` 拒；带 Origin 必须与 Host 同源）：

```
GET  /dsh-zcode-cli-proxy/status
GET  /dsh-zcode-cli-proxy/login/state
POST /dsh-zcode-cli-proxy/login/start
POST /dsh-zcode-cli-proxy/login/cancel
POST /dsh-zcode-cli-proxy/test
```

自检（不需要开浏览器）：

```sh
curl -s http://127.0.0.1:3080/dsh-zcode-cli-proxy/status | head -c 400
curl -s -X POST http://127.0.0.1:3080/dsh-zcode-cli-proxy/login/start   # 8 秒后再看 login/state 里的 url
```

### 为什么「登录 Z.AI」可能就是解药

`zcode login` 走的是 **chat.z.ai**（Z.AI 国际站 = `zai` 家族），而插件注入的正是
`account:zai-start-plan`。当前凭证是 **bigmodel** 家族（中国站）—— 这就是上游回
`1005 exceed quota limit` / `401` 的根因。用这个按钮重新登录一个 zai 账号后，
「通道匹配」应该变绿，再点一次「通道测试」就能验证是不是真的能出字。

## ⚠ 改完代码怎么生效（**实测踩到的坑，务必先读**）

本 profile 的 loader 与 Node ESM 都按 **specifier 缓存模块**，而且——

> **只改 patch 行里的 `name` 不会重挂已经在跑的 fiber。** 实测：把 name 从 A 指到 B 之后，
> `dsh-hmr` 确实 reconcile 了（Include 配置里的 name 变成了 B），但运行中的 fiber 继续跑 A
> 的那个模块实例，B 从未被 import（我用「模块顶层写标记文件」验证过：文件没出现）。

可靠做法（两条，任选）：

1. **换 entry 文件名 + 走一次 dispose→start**（不用重启 dsh）：
   把 `entry-v5.js` 复制成 `entry-v6.js`（同时把它 import 的
   `./lib/index.js?v=N` / `./lib/app-server.js?v=N` / `./local/host-panel.js?v=N` 一起 +1），
   改 patch 行的 name 指到 v6，然后在 patch 末尾临时追加

   ```yaml
   - id: dsh-zcode-cli-proxy
     disabled: true
   ```

   等约 8 秒（fiber 被 dispose），再把这三行删掉（再等约 10 秒重新 start）。
   实测这套动作后 `entry-v6` 立刻被 import、路由 200。
   **注意：改 patch 文件要用「原地截断写」或追加（`>` / `>>`），不要用 `sed -i`** ——
   `sed -i` 会换 inode，chokidar 那次就没触发 reconcile（本次排查里复现过）。
2. 或者直接**重启 dsh**（永远有效）。

浏览器半边（`client.js`）由 `dsh-client-modules` 按内容哈希供包，改完**刷新页面**即可；
但**新增/删除 `dsh.client` 声明**（改 package.json）需要页面重新拉取一次 boot manifest，
必要时重启 dsh。

## 自检

```sh
# 21 项回合锁回归（撞锁自愈/串行化/中止补刀/重启作废/会话失效重放/退出快败/分叉重建）
# 跑假 app-server，不需要真 ZCode 客户端、不耗额度
node plugins/dsh-zcode-cli-proxy/test/turn-lock.mjs

# 真跑一轮 Start Plan 调用（消耗少量额度），验证通道在本机打通
node plugins/dsh-zcode-cli-proxy/verify-e2e.mjs

# 装配自检：本机的行是否解析成真实模块（不启动服务）
dsh --profile web --dump-config | grep -A3 'id: dsh-zcode-cli-proxy'
```

## 维护 / 更新

更新上游版本：重新拉取仓库覆盖 `lib/ test/ README.md LICENSE cordis.patch.yml`，
然后**必须重新贴上面两处本机改动**（`resolveBuiltinRuntime` 的 arch 映射；`lib/index.js`
里 `./app-server.js?v=N`），并把两处 `?v=N` 一起 +1 让运行中的实例换代码。
（重启 dsh 永远有效；忘记 bump 就只会重跑旧代码。）

## 回滚

patch 里这一行改 `disabled: true` 或整行删除，然后重启 dsh；删掉
`plugins/dsh-zcode-cli-proxy/` 目录即彻底清除。插件不写自己的持久状态
（只有 `~/.zcode/dsh-bridge/` 这个空工作目录与 ZCode 侧的会话记录）。
