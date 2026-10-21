# dsh-device-mesh — 冻结契约（v1）

本文件是**浏览器半边与外部实现的唯一依据**。host 半边的实现必须与服务这张表，
client.js 只允许依赖这张表。

所有响应都是 JSON，且带回 `ok: true|false`。
失败响应形状恒为 `{ ok: false, error: string, code: string }`（`code` 取自 `protocol.js` 的 `CODE`）。

---

## 0. 概念

| 概念 | 含义 |
| --- | --- |
| **节点 / 设备（device）** | 一个装了本插件的 DSH 进程。稳定 `deviceId`（32 位 hex），存在 `identity.json`。 |
| **接入点（hub）** | 一台开了入站接入的设备。本机可以 join 它，把清单推过去。 |
| **接入本机的节点** | 别的设备 join 了本机。本机保存它的清单快照。 |
| **镜像（mirror）** | 本机从接入点拉回来的「对方一跳总览」，用来看见「接入点的接入点」。 |
| **工作路径（path）** | 一个「设备 + 绝对路径」二元组。 |
| **主路径（primary）** | 工作区在**它的所属设备**上的那个规范路径 —— 出厂 `workspaceRegistry` 的 `workspace.path`，**不可改**。所有出厂行为默认在主路径上工作。 |
| **附加路径（member）** | 人工给某个工作区挂上的额外工作路径，可以落在**另一台设备**上。 |

三级结构：**设备 → 工作区 → 会话**。

---

## 1. 出站连接器会调用的入站 API

前缀 `/dsh-device-mesh/api`。**全部只接受 POST**（除 `hello` 为 GET）。
认证：`x-dsh-mesh-*` 系列头 + HMAC 签名（见 `protocol.js`）。
**带 query string 的请求一律 400 `bad-request`**（签名覆盖 pathname，不允许两种读法）。

### `GET /dsh-device-mesh/api/hello`
唯一无需认证的路由。`allowInbound=false` 时返回 403 `inbound-disabled`。

```jsonc
{
  "ok": true,
  "protocol": 1,
  "meshVersion": 1,
  "authRequired": true,
  "serverTimeMs": 1790000000000,
  "hub": { /* 公开设备描述，不含 hostname/memoryGb/cpuCount */ }
}
```

### `POST /dsh-device-mesh/api/join`
body: `{ protocol, device, inventory? , probe?, nodeId? }`
`device.deviceId` **必须**等于签名头里的设备标识，否则 400 `bad-request`。
幂等：同 `deviceId` 重复 join 保留原有 `trust` / `note` / `joinedAt`。

```jsonc
{
  "ok": true, "protocol": 1, "nodeId": "a1b2c3d4",
  "inventoryStored": true,          // body 里带了 inventory 且不是 probe
  "serverTimeMs": 1790000000000,
  "pushIntervalMs": 30000, "heartbeatMs": 20000,
  "hub": { /* 完整设备描述 */ }
}
```

### `POST /dsh-device-mesh/api/report`
body: `{ protocol, nodeId, inventory }` → 节点未 join 过 → 404 `unknown-node`。

```jsonc
{ "ok": true, "protocol": 1, "acceptedAt": "ISO", "revision": 12,
  "workspaceCount": 3, "sessionCount": 88, "lastInventoryAt": "ISO" }
```

### `POST /dsh-device-mesh/api/heartbeat`
body: `{ protocol, nodeId, summary? }` → `{ ok: true, protocol, acceptedAt, nextInMs }`

### `POST /dsh-device-mesh/api/leave`
body: `{ protocol, nodeId }` → `{ ok: true, protocol, removed: true }`

### `POST /dsh-device-mesh/api/tree`
body: `{ protocol, nodeId, depth }` → 本接入点的**一跳总览**。

```jsonc
{ "ok": true, "protocol": 1, "tree": { /* 见 §3，scope 恒为 "direct" */ } }
```

**一跳是硬边界**：返回的 `devices` 只含「接入点自己 + 直接接入它的节点」，
**不含**它从别处镜像来的设备。这条规则挡住成环时的无限递归与按跳数指数膨胀。

### `POST /dsh-device-mesh/api/paths`
body: `{ protocol, nodeId }` → 本接入点的工作区多路径账目（供对端解析远端路径）。

```jsonc
{ "ok": true, "protocol": 1, "deviceId": "…", "generatedAt": "ISO",
  "workspaces": [ { "workspaceId": "…", "title": "ArkTower",
                    "primaryPath": "/root/nas/ArkTower",
                    "members": [ { "id": "…", "deviceId": "…", "path": "/srv/x", "role": "mirror", "label": "" } ] } ] }
```

### `POST /dsh-device-mesh/api/fs/list`
body: `{ protocol, nodeId, path }` → 列出**被导出**的目录（有界）。
越界 → 403 `path-not-exported`；不存在 → 404 `path-missing`。

```jsonc
{ "ok": true, "protocol": 1, "path": "/srv", "parent": "/", "truncated": false,
  "entries": [ { "name": "app", "path": "/srv/app", "dir": true } ] }
```

### `POST /dsh-device-mesh/api/exec`  ← 跨设备执行
body: `{ protocol, nodeId, path, command, timeoutMs? }`

门（任一不过即拒，**失败也写审计**）：
1. `allowRemoteExec` 为 false → 403 `exec-disabled`
2. 节点 `trust !== 'exec'` 且 `execTrust !== 'any-authenticated'` → 403 `exec-denied`
3. `path` 不在有效导出根内 → 403 `path-not-exported`
4. `path` 不存在 / 不是目录 → 404 `path-missing`
5. 并发已满 → 429 `exec-busy`

```jsonc
{ "ok": true, "protocol": 1,
  "deviceId": "…", "cwd": "/srv/app", "command": "ls",
  "exitCode": 0, "signal": null, "timedOut": false,
  "stdout": "…", "stderr": "", "stdoutTruncated": false, "stderrTruncated": false,
  "durationMs": 42, "startedAt": "ISO", "finishedAt": "ISO" }
```

失败响应（`ok:false`）额外带 `deviceId` / `cwd` / `auditId` 便于对账。

---

## 2. 浏览器侧 API

前缀 `/dsh-device-mesh`。**同源守卫**（`sec-fetch-site: cross-site` 一律 403；
带 `Origin` 时必须与 `Host` 同源；无 `Origin` 放行）。
不接受签名认证，也不提供任何「代替远端节点说话」的能力。

### `GET /dsh-device-mesh/tree`
```jsonc
{ "ok": true, "problems": ["…"],
  "tree": {
    "schema": 1, "scope": "full", "generatedAt": "ISO", "protocol": 1, "meshVersion": 1,
    "selfDeviceId": "…",
    "devices": [ DeviceNode ],
    "summary": { "devices": 2, "online": 2, "stale": 0, "offline": 0,
                 "workspaces": 5, "sessions": 140, "sessionsListed": 140,
                 "links": 1, "hostedNodes": 1, "inboundEnabled": true, "authRequired": true }
  } }
```

**DeviceNode**
```jsonc
{
  "deviceId": "…", "name": "笔记本", "self": false,
  "trust": "allowed" | "inventory" | "exec" | "denied",
  "note": "",
  "via": Via, "alsoVia": [Via],
  "liveness": "online" | "stale" | "offline" | "unknown",
  "lastSeenAt": "ISO|null", "joinedAt": "ISO|null",
  "device": DeviceDescription|null,
  "inventory": Inventory|null,        // null = 还没有清单（不是「没有会话」）
  "inventoryStale": false,
  "paths": [ WorkspacePathView ]      // 见 §2 paths；本机设备才有完整集合
}
```

**Via**
```jsonc
{ "kind": "self" | "inbound" | "outbound", "label": "本机",
  "tokenId": "…", "nodeId": "…",              // inbound
  "linkId": "…", "url": "http://…", "hubDeviceId": "…" }   // outbound
```

**Inventory**
```jsonc
{
  "schema": 1, "revision": 12, "generatedAt": "ISO",
  "device": DeviceDescription,
  "workspaces": [ { "id": "…", "title": "ArkTower", "path": "/root/nas/ArkTower",
                    "createdAt": "ISO|null", "updatedAt": "ISO|null",
                    "sessionCount": 12, "droppedSessions": 0, "liveCount": 1,
                    "sessions": [ SessionEntry ] } ],
  "unassigned": [ SessionEntry ], "unassignedDropped": 0,
  "totals": { "workspaces": 3, "sessions": 88, "listed": 88, "live": 2, "subagents": 5, "archived": 1 },
  "truncated": false, "degraded": object|null, "stale": false?
}
```

**SessionEntry**
```jsonc
{ "id": "…", "title": "修 webserver 路由|null", "cwd": "/root/nas/ArkTower|null",
  "createdAt": 1790000000000, "lastActivityAt": 1790000000000,
  "live": true, "persisted": true, "seeded": false,
  "origin": "subagent"|null, "parentSession": "…"|null, "depth": 0,
  "agentPresetId": "…"|null, "archived": false, "inferred": false }
```
`inferred: true` = 归属是按 cwd 前缀**推断**的，不是工作区账目的权威成员。

### `GET /dsh-device-mesh/status`
只读自检。含 `version` / `importTag` / `config` / `problems` / `capabilities` /
`inbound` / `inventory` / `egress` / `tokens` / `nodes` / `links` / `mirrors` / `counters` / `exec`。

### `GET|POST /dsh-device-mesh/config`
GET → `{ config, device, storeDir, defaults, editable }`。
POST 只接受运行期安全项：`deviceName`、`allowInbound`、`requireToken`、
`includeSubagents`、`includeArchived`、`maxSessionsPerWorkspace`、`allowRemoteExec`、`execTrust`。
→ `{ applied, config, device }`

### `GET|POST /dsh-device-mesh/links`
GET → `{ links: LinkView[], running }`。
LinkView：`{ id, label, url, tokenId, enabled, state, configured, secretPreview, createdAt, lastJoinAt, lastPushAt, lastError, hubDevice }`
`state ∈ 'idle'|'joined'|'error'|'disabled'|'unconfigured'`。**永不返回 secret 本体。**

POST body：`{ action: 'upsert'|'remove'|'enable'|'disable', … }`
`upsert` 省略 `secret` 时**保留原 secret**（UI 只有前缀，不能拿前缀覆盖）。

### `POST /dsh-device-mesh/links/test`
body `{ url, tokenId?, secret?, id? }` → `{ ok, stage: 'hello'|'join', hub?, authenticated?, error?, code? }`
不传 secret 时可给 `id`，用已保存的密钥探测。

### `POST /dsh-device-mesh/links/sync`
body `{ id? }` → `{ results: [{ linkId, ok, action, error?, code? }], links }`

### `GET|POST /dsh-device-mesh/tokens`
GET → `{ tokens: TokenView[], required }`。TokenView 不含 secret。
POST `{ action:'create', label?, ttlMs? }` → `{ token, secret, persisted, tokens }` —— **`secret` 只出现这一次**。
POST `{ action:'revoke'|'delete', id }` → `{ tokens }`

### `GET|POST /dsh-device-mesh/nodes`
GET → `{ nodes: NodeView[] }`，NodeView 含 `liveness` / 计数 / `trust` / `note`。
POST `{ action:'update'|'forget', deviceId, note?, trust? }`
`trust ∈ 'allowed' | 'inventory' | 'exec' | 'denied'`（`'exec'` = 授予跨设备执行权）。

### `GET|POST /dsh-device-mesh/paths`  ← 工作区多工作路径
GET → `{ groups: PathGroupView[], devices: DeviceOption[] }`

```jsonc
// PathGroupView
{ "id": "…", "homeDeviceId": "…", "workspaceId": "…", "workspaceTitle": "ArkTower",
  "primary": { "deviceId": "…", "deviceName": "NasHost", "path": "/root/nas/ArkTower",
               "exists": true, "local": true },
  "members": [ { "id": "…", "deviceId": "…", "deviceName": "笔记本", "path": "/srv/ArkTower",
                 "role": "mirror", "label": "", "createdAt": "ISO", "local": false,
                 "reachable": true } ] }
```
`role ∈ 'mirror' | 'scratch'`。`reachable=false` = 本机没有指向该设备的接入点（只能看，不能执行）。

POST body：
- `{ action:'add', workspaceId, deviceId, path, role?, label? }` → `{ group, groups }`
- `{ action:'remove', id }`（`id` = member id）→ `{ group, groups }`
- `{ action:'update', id, role?, label? }` → `{ group, groups }`

### `POST /dsh-device-mesh/exec`  ← 浏览器侧远端执行控制台
body `{ deviceId?, path, command, timeoutMs? }`
`deviceId` 省略 = 本机。返回形状与 `/api/exec` 相同（另加 `target: { deviceId, deviceName, path, local }`）。

### `POST /dsh-device-mesh/browse`
body `{ deviceId?, path }` → 与 `/api/fs/list` 同形。本机时列本机（受导出根约束）。

### `GET /dsh-device-mesh/audit`
query **不允许**（同 §1 的严格性不适用；此路由允许 `?limit=`）。
→ `{ entries: AuditEntry[], truncated }`

```jsonc
// AuditEntry
{ "id": "…", "at": "ISO", "deviceId": "…", "deviceName": "…", "direction": "in"|"out",
  "actor": "remote"|"local"|"browser"|"tool",
  "path": "/srv/app", "command": "ls -la", "outcome": "ok"|"denied"|"error"|"timeout",
  "code": "…"|null, "exitCode": 0|null, "durationMs": 42, "error": null }
```

---

## 3. 跨设备执行的语义（必须被 UI 如实表达）

- **默认在主工作区工作**：`primary` 永远是出厂 `workspace.path`，不可通过本插件修改。
  新会话、出厂侧边栏、所有出厂行为都只认主路径。附加路径是**显式**的额外选择。
- 执行目标解析：`path` → 在路径账目里查 `(deviceId, path)`；命中附加路径 → 目标就是那台设备；
  命中主路径 → 目标是工作区所属设备。
- **只走一跳**：目标设备必须是本机**直连**的接入点（本机 join 过它），或本机自己。
  「接入点的接入点」只能看清单，**不能**执行 —— UI 必须把这种目标的执行入口禁用并说明原因。
- 目标设备的 `capabilities` 里没有 `remote-exec` → 执行入口禁用。
- 每次执行（含被拒绝的）都进审计。

---

## 4. 模型工具（host 半边注册，与 agent 预设无关）

### `mesh_exec`
参数：`{ command: string(必填), path?: string, workspace?: string, device?: string, timeoutMs?: number }`
解析顺序：
1. `path` 给了 → 查路径账目得到 `(deviceId, path)`；查不到且 `device` 也给了 → 用 `(device, path)`；
   都没给 → 当作本机路径。
2. 只给 `workspace` → 用它的**主路径**与所属设备。
3. 只给 `device` → 用该设备**第一个有会话的工作区主路径**；没有则报错要求显式给 `path`。
返回：与 `/api/exec` 同形，外加 `target`。

### `mesh_paths`
参数：`{ action: 'list'|'add'|'remove', workspaceId?, deviceId?, path?, role?, id?, label? }`
- `list` → `{ groups, devices }`（同 §2 paths GET）
- `add` / `remove` → 同 §2 paths POST
