/**
 * dsh-device-mesh — 执行路由（纯逻辑，零 I/O，可单测）。
 *
 * ── 这个模块解决什么 ────────────────────────────────────────────────────────
 * 「会话在主机跑，命令发到子节点执行」需要回答一个唯一的问题：
 *
 *     这条命令 / 这次文件访问，到底属于哪台设备？
 *
 * 本模块只做这件事，而且**只按路径判定**，不猜语义：
 *
 *   · 会话的 `workdir`（或文件工具的目标路径）落在**本机**已知路径之下 → 本机执行；
 *   · 落在**某个子节点**的已知路径之下                        → 发到那台执行；
 *   · 谁都匹配不上                                            → 本机执行（安全缺省）。
 *
 * ── 为什么按路径而不是按会话 ────────────────────────────────────────────────
 * 路由依据来自 `ctx.shell` / `ctx.fs` 的**请求参数**（`ShellExecRequest.workdir`、
 * 文件目标路径）——这两个请求里**没有** agent/session 身份，服务层看不到调用方是谁。
 * 好在路径本身就是最准的信号：工作区账目已经把「一段路径属于哪台设备」记全了
 * （见 paths.js 的多工作路径模型），按路径判定既不需要新开关，也不会出现
 * 「会话身份和实际路径不一致」这种自相矛盾的状态。
 *
 * ── 最长前缀优先 ────────────────────────────────────────────────────────────
 * 一个工作区可以同时挂本机路径和别的设备的路径，甚至多台设备各挂一段。所以判定
 * 取**最长匹配前缀**，而不是「第一个匹配上的」——否则挂载顺序会悄悄改变执行位置。
 *
 * ── 边界安全 ────────────────────────────────────────────────────────────────
 * 前缀比较按**路径分段**，不是字符串前缀：`/srv/app` 不能匹配 `/srv/application`，
 * 否则一个精心构造的路径就能把命令骗到错误的设备上执行。
 *
 * @module dsh-device-mesh/routing
 */

/**
 * 一条「这段路径归这台设备」的权威记录。
 *
 * `prefer` 是**人工声明**的优先级：附加路径可以显式钉住「这段路径就该在这台设备上
 * 执行」。它存在的唯一理由是同长并列的裁决——见 {@link chooseOwner}。
 * @typedef {{deviceId: string, path: string, source: 'primary'|'member', workspaceId?: string, prefer?: boolean}} PathOwner
 */

/**
 * 一次路由判定的结果。
 * @typedef {{kind: 'local'}|{kind: 'remote', deviceId: string, root: string, source: string}} Route
 */

/**
 * 归一化一个绝对路径，用于前缀比较。
 *
 * 规则：反斜杠转正斜杠、折叠重复斜杠、去掉尾部斜杠（根路径除外）、解析 `.` 与 `..`。
 * **不**做 realpath（本机可能根本没有这段路径——它属于远端设备），也不解析符号链接：
 * 路由要在纯字符串层面可预测，符号链接层面的归属是远端那台自己的事。
 *
 * @param {unknown} value 待归一化的路径。
 * @returns {string|undefined} 归一化后的绝对路径；非绝对路径或非法输入返回 `undefined`。
 */
export function normalizeRoutePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  let path = value.trim().replace(/\\/gu, '/');
  if (!path.startsWith('/')) return undefined;
  const segments = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // 越过根就不再上溯（与 POSIX 一致），避免 `/../../x` 逃出比较域。
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`
    // 仅当整串就是根时才保留单斜杠；其余情况上面已经拼成无尾斜杠形式。
    .replace(/\/{2,}/gu, '/');
}

/**
 * 判断 `child` 是否落在 `parent` 之内（或与之相等）。
 *
 * 按**路径分段**比较，不是字符串前缀——这是安全边界，不是格式化细节。
 *
 * @param {string} parent 已归一化的父路径。
 * @param {string} child 已归一化的候选子路径。
 * @returns {boolean} 属于（含相等）时为 true。
 */
export function isWithinRoute(parent, child) {
  if (parent === child) return true;
  if (parent === '/') return child.startsWith('/');
  return child.startsWith(`${parent}/`);
}

/**
 * 把一份「路径组」视图摊平成待匹配的归属列表。
 *
 * 输入就是 `entry-v10.js` 的 `buildPathGroups()` 输出（本机 group 的主路径来自
 * workspaceRegistry 实时读取，远端 group 用账目快照）。空路径、非绝对路径一律跳过：
 * 宁可判不出来（退回本机）也不要拿半截数据去路由。
 *
 * @param {object[]} groups `buildPathGroups()` 的返回值。
 * @returns {PathOwner[]} 归属列表（未排序）。
 */
export function collectPathOwners(groups) {
  const owners = [];
  if (!Array.isArray(groups)) return owners;
  for (const group of groups) {
    if (group === null || typeof group !== 'object') continue;
    const workspaceId = typeof group.workspaceId === 'string' ? group.workspaceId : undefined;
    const primary = group.primary;
    if (primary !== null && typeof primary === 'object') {
      const path = normalizeRoutePath(primary.path);
      const deviceId = typeof primary.deviceId === 'string' ? primary.deviceId : '';
      if (path !== undefined && deviceId !== '') owners.push({ deviceId, path, source: 'primary', workspaceId });
    }
    const members = Array.isArray(group.members) ? group.members : [];
    for (const member of members) {
      if (member === null || typeof member !== 'object') continue;
      const path = normalizeRoutePath(member.path);
      const deviceId = typeof member.deviceId === 'string' ? member.deviceId : '';
      if (path !== undefined && deviceId !== '') owners.push({ deviceId, path, source: 'member', workspaceId, prefer: member.prefer === true });
    }
  }
  return owners;
}

/**
 * 两个归属谁更该负责这条路径。逐级比较，前者优先：
 *
 *   1. **更长的匹配前缀** —— 挂载顺序不该改变执行位置（见模块头）。
 *   2. **显式 `prefer`** —— 同长并列时由人声明的意图裁决。
 *   3. **deviceId 字典序** —— 兜底的确定性。
 *
 * 第 2 级为什么必须存在：把「工作路径定位到另一台机器」的常见做法，就是给一个工作区
 * 挂一条**与被定位路径字符串完全相同**的附加路径（本机 `/root/app` ↔ 对端 `/root/app`）。
 * 那种情况下前两级完全并列，裁决全落在第 3 级——而 deviceId 是随机生成的：重建一次
 * `identity.json` 就可能让命令翻到路径根本不存在的那台去执行。同路径并列必须由人
 * 显式声明，不能靠 id 大小碰运气。
 *
 * `prefer` 缺省 false，所以没有显式声明的既有部署行为**逐字不变**（仍走第 3 级）。
 *
 * @param {PathOwner} a 候选。
 * @param {PathOwner} b 当前最优。
 * @returns {boolean} a 严格优于 b 时为 true；并列（含同设备同路径）返回 false，
 *   即先到者保留——同样的输入永远给同样的答案。
 */
export function betterOwner(a, b) {
  if (a.path.length !== b.path.length) return a.path.length > b.path.length;
  const ap = a.prefer === true ? 1 : 0;
  const bp = b.prefer === true ? 1 : 0;
  if (ap !== bp) return ap > bp;
  return a.deviceId < b.deviceId;
}

/**
 * 在一份归属列表里找出 `path` 的最长匹配前缀。
 *
 * 排序在内部完成（见 {@link betterOwner}），调用方不必预处理。
 *
 * @param {string} path 已归一化的目标路径。
 * @param {PathOwner[]} owners 归属列表。
 * @returns {PathOwner|undefined} 命中的归属；无人认领时 `undefined`。
 */
export function matchOwner(path, owners) {
  let best;
  for (const owner of owners) {
    if (!isWithinRoute(owner.path, path)) continue;
    if (best === undefined || betterOwner(owner, best)) best = owner;
  }
  return best;
}

/**
 * 列出**这一条路径上所有并列的属主**，按 {@link betterOwner} 从优到劣排序。
 *
 * 存在的理由是可解释性：路由判定平时只暴露"最后去了哪台"，而排查时的第一个问题
 * 永远是"当时有哪几个候选、凭什么赢了它"。`/route` 干跑接口与 `/status` 用它把
 * 并列情形如实摊开——尤其是**同长并列**（那才是会因 deviceId 变化而翻面的情形）。
 *
 * @param {unknown} rawPath 目标路径。
 * @param {PathOwner[]} owners 归属列表。
 * @returns {{normalized: string|undefined, contenders: PathOwner[]}} 归一化路径与候选（含胜者，位于首位）。
 */
export function ownersForPath(rawPath, owners) {
  const normalized = normalizeRoutePath(rawPath);
  if (normalized === undefined) return { normalized: undefined, contenders: [] };
  const contenders = (Array.isArray(owners) ? owners : [])
    .filter((owner) => owner !== null && typeof owner === 'object' && isWithinRoute(owner.path, normalized));
  contenders.sort((a, b) => (betterOwner(a, b) ? -1 : betterOwner(b, a) ? 1 : 0));
  return { normalized, contenders };
}

/**
 * 判定一条路径该在哪台设备上执行。
 *
 * @param {unknown} rawPath 目标路径（会话 workdir、文件工具的目标、…）。
 * @param {{owners: PathOwner[], selfDeviceId: string}} options 归属列表与本机设备 id。
 * @returns {{route: Route, owner?: PathOwner, normalized?: string}} 判定结果；`owner` 是命中的归属（便于审计）。
 */
export function routePath(rawPath, options) {
  const selfDeviceId = typeof options?.selfDeviceId === 'string' ? options.selfDeviceId : '';
  const owners = Array.isArray(options?.owners) ? options.owners : [];
  const normalized = normalizeRoutePath(rawPath);
  if (normalized === undefined) return { route: { kind: 'local' } };
  const owner = matchOwner(normalized, owners);
  if (owner === undefined) return { route: { kind: 'local' }, normalized };
  if (owner.deviceId === selfDeviceId) return { route: { kind: 'local' }, owner, normalized };
  return {
    route: { kind: 'remote', deviceId: owner.deviceId, root: owner.path, source: owner.source },
    owner,
    normalized,
  };
}

/**
 * 把 `config.workspaceRoles` 摊平成**工作区策略表**。
 *
 * `workspaceRoles[path] = { owner, session, mesh }`：
 *
 *   · `mesh: true` —— 这个工作区**作为互联会话**：它的会话（无论跑在哪台）只允许在
 *     声明的属主设备上落地文件与命令，**永不落到会话端本地**；
 *   · `mesh` 缺省/false —— **纯本地**工作区：本机会话的一切文件与命令都在本机落地，
 *     即使某条路径命中远端属主也不转发（唯一例外是显式附加路径 member，见
 *     {@link routePathWithPolicy}）。
 *
 * 为什么缺省是「纯本地」而不是「互联」：互联会带来跨设备副作用，必须是**显式声明**。
 * 反过来（缺省互联）会让没配过的部署在升级后突然把命令发到别的机器上。
 *
 * 传了 `groups` 时，**账目里出现过的每个工作区都会进表**（未声明的按纯本地记）——
 * 否则「未声明 = 纯本地」这条缺省落不了地：会话的 cwd 归属不到任何条目，就会掉回
 * 旧的按路径判定，反向保证形同虚设。
 *
 * @param {unknown} roles 配置里的 `workspaceRoles`。
 * @param {object[]} [groups] `buildPathGroups()` 的输出（可选）。
 * @returns {{entries: {path: string, mesh: boolean, owner: string, workspaceId?: string}[]}} 策略表。
 */
export function collectWorkspacePolicy(roles, groups) {
  const entries = [];
  const seen = new Map();
  const push = (entry) => {
    const key = entry.path;
    const existing = seen.get(key);
    if (existing !== undefined) {
      // 声明优先：账目先建的那条（mesh:false）被声明覆盖。
      if (entry.declared === true) {
        existing.mesh = entry.mesh;
        existing.owner = entry.owner;
        existing.workspaceId = entry.workspaceId ?? existing.workspaceId;
      } else if (existing.workspaceId === undefined) {
        existing.workspaceId = entry.workspaceId;
      }
      return;
    }
    seen.set(key, entry);
    entries.push(entry);
  };

  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (group === null || typeof group !== 'object') continue;
      const primary = group.primary;
      if (primary === null || typeof primary !== 'object') continue;
      const path = normalizeRoutePath(primary.path);
      if (path === undefined) continue;
      const workspaceId = typeof group.workspaceId === 'string' ? group.workspaceId : undefined;
      push({ path, mesh: false, owner: '', workspaceId, declared: false });
    }
  }

  if (roles !== null && typeof roles === 'object' && !Array.isArray(roles)) {
    for (const [rawPath, rawRole] of Object.entries(roles)) {
      const path = normalizeRoutePath(rawPath);
      if (path === undefined) continue;
      const role = rawRole !== null && typeof rawRole === 'object' && !Array.isArray(rawRole) ? rawRole : {};
      push({
        path,
        mesh: role.mesh === true,
        owner: typeof role.owner === 'string' ? role.owner.trim() : '',
        workspaceId: undefined,
        declared: true,
      });
    }
  }

  // 最长前缀优先：与 matchOwner 同一套裁决，避免「声明顺序改变执行位置」。
  entries.sort((a, b) => b.path.length - a.path.length);
  for (const entry of entries) delete entry.declared;
  return { entries };
}

/**
 * 一条路径属于哪个**已声明**的工作区（最长前缀）。
 *
 * 判定会话归属时传的是**会话的 cwd**（`exec.agent.session.header.cwd`），不是目标路径：
 * 目标路径正是要判定的东西，拿它反推归属会自证循环（「路径在远端 → 所以是互联会话 →
 * 所以发到远端」）。
 *
 * @param {unknown} rawPath 候选路径（通常是会话 cwd）。
 * @param {{entries: object[]}} policy 策略表。
 * @returns {object|undefined} 命中的声明。
 */
export function workspaceForPath(rawPath, policy) {
  const normalized = normalizeRoutePath(rawPath);
  if (normalized === undefined) return undefined;
  const entries = Array.isArray(policy?.entries) ? policy.entries : [];
  for (const entry of entries) {
    if (isWithinRoute(entry.path, normalized)) return entry;
  }
  return undefined;
}

/**
 * 收集「设备名 → deviceId」解析表。
 *
 * 声明里写的是**名字**（`owner: orangepi5`），而归属记录里只有 deviceId；两边对不上
 * 就会「声明了属主但判不出来」。所以这张表要尽量全 —— 三个来源都要收：
 *
 *   1. 本机身份；
 *   2. 路径组里的 `deviceName`（**注意**：路由用的路径组是 `buildPathGroups([])` 建的，
 *      不带设备清单，组里的名字是空的 —— 实测踩过，见 `ownerDeviceForWorkspacePath`）；
 *   3. `devices` 参数：调用方从**节点表/接入点表**里取的名字（那才是稳的来源）。
 *
 * @param {object[]} groups `buildPathGroups()` 的输出。
 * @param {{deviceId?: string, name?: string}} [self] 本机身份。
 * @param {{deviceId?: string, name?: string}[]} [devices] 额外候选（节点表/接入点表）。
 * @returns {Map<string, string>} 小写名字 → deviceId。
 */
export function collectDeviceNames(groups, self, devices) {
  const table = new Map();
  const put = (name, deviceId) => {
    if (typeof name !== 'string' || name.trim() === '') return;
    if (typeof deviceId !== 'string' || deviceId === '') return;
    const key = name.trim().toLowerCase();
    if (!table.has(key)) table.set(key, deviceId);
  };
  put(self?.name, self?.deviceId);
  put(self?.deviceId, self?.deviceId);
  if (Array.isArray(devices)) {
    for (const device of devices) {
      if (device === null || typeof device !== 'object') continue;
      put(device.name, device.deviceId);
      put(device.deviceId, device.deviceId);
    }
  }
  if (!Array.isArray(groups)) return table;
  for (const group of groups) {
    if (group === null || typeof group !== 'object') continue;
    const primary = group.primary;
    if (primary !== null && typeof primary === 'object') {
      put(primary.deviceName, primary.deviceId);
      put(primary.deviceId, primary.deviceId);
    }
    for (const member of Array.isArray(group.members) ? group.members : []) {
      if (member === null || typeof member !== 'object') continue;
      put(member.deviceName, member.deviceId);
      put(member.deviceId, member.deviceId);
    }
  }
  return table;
}

/**
 * 把声明里的属主写法（名字或 deviceId，大小写任意）解析成 deviceId。
 *
 * 单拎出来是为了**只有一处**做大小写与去空白：`collectDeviceNames()` 的表键是小写的，
 * 调用方直接 `get()` 会在「配置里写 Orangepi5」时静默拿不到 —— 那种失败看起来像
 * 「声明了属主但解析不出来」，很容易被误判成设备离线。
 *
 * @param {Map<string, string>} names `collectDeviceNames()` 的表。
 * @param {unknown} token 声明里的属主。
 * @returns {string|undefined} deviceId；解析不出来时 `undefined`。
 */
export function resolveOwnerToken(names, token) {
  if (typeof token !== 'string') return undefined;
  const key = token.trim().toLowerCase();
  if (key === '') return undefined;
  if (!(names instanceof Map)) return undefined;
  return names.get(key);
}

/**
 * 在账目里找**这条工作区路径自己的**属主设备（非本机）。
 *
 * 为什么需要它：声明里写的是**名字**（`owner: orangepi5`），而名字能不能解析成
 * deviceId 取决于「这台机器是否见过那台设备的名字」。实测踩过：会话端上路由用的
 * 路径组是 `buildPathGroups([])` 建的（**不带设备清单**），组里的 `deviceName` 是空的，
 * 于是名字解析不出来，判定退化成 `denied` —— 一个本来完全正常的互联会话突然读不了
 * 工作区之外的任何东西。
 *
 * 而账目本身**已经**回答了「这条路径归谁」：工作区路径上就挂着对端（同路径并列时
 * 它是 member，见 {@link betterOwner}）。所以名字解析不出来时，用**账目**兜底，
 * 而不是把请求拒掉 —— 名字是提示，账目才是权威。
 *
 * @param {string} workspacePath 工作区路径（已归一化）。
 * @param {PathOwner[]} owners 归属列表。
 * @param {string} selfDeviceId 本机设备 id。
 * @returns {PathOwner|undefined} 命中的非本机属主。
 */
export function ownerDeviceForWorkspacePath(workspacePath, owners, selfDeviceId) {
  const normalized = normalizeRoutePath(workspacePath);
  if (normalized === undefined) return undefined;
  const candidates = (Array.isArray(owners) ? owners : []).filter((owner) => (
    owner !== null
    && typeof owner === 'object'
    && owner.deviceId !== selfDeviceId
    && typeof owner.path === 'string'
    && isWithinRoute(owner.path, normalized)
  ));
  if (candidates.length === 0) return undefined;
  // 确定性：更长的前缀优先（更具体），同长按 deviceId —— 与 betterOwner 同一套口味。
  candidates.sort((a, b) => (a.path.length !== b.path.length
    ? b.path.length - a.path.length
    : (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0)));
  return candidates[0];
}

/**
 * 带**工作区策略**的路由判定（互联会话与纯本地会话的分离点）。
 *
 * 与 {@link routePath} 的区别只有一件事：`routePath` 对「谁都匹配不上」的路径回落到
 * **本机执行**（对纯本地部署是安全缺省），而互联会话恰恰不能这样 —— 会话的 agent 在
 * 这台、文件在属主那台，回落到本机就是**静默读到会话端自己的文件系统**。所以：
 *
 * | 会话所属工作区 | 判定 |
 * | --- | --- |
 * | 未声明（无法归属） | 沿用 {@link routePath}（不引入回归） |
 * | `mesh: true` | 一律在**声明的属主设备**上落地：命中归属就按归属，未命中就按属主；属主就是本机时本机执行；属主解析不出来 → **denied**（绝不回落本机） |
 * | 其它（纯本地） | 一律本机；只有命中**显式附加路径（member）**才允许出本机 |
 *
 * 显式附加路径在两种情形下都优先：它是人手工钉的「这段路径就该在那台」，比工作区
 * 的 mesh 开关更具体（`prefer` 的语义见 {@link betterOwner}）。
 *
 * @param {unknown} rawPath 目标路径。
 * @param {{owners: PathOwner[], selfDeviceId: string, policy?: object, cwd?: string, resolveOwner?: (token: string) => string|undefined}} options 归属、本机 id、策略表、会话 cwd、名字解析器。
 * @returns {{route: Route|{kind:'denied', reason: string}, owner?: PathOwner, normalized?: string, workspace?: object, reason?: string}} 判定。
 */
export function routePathWithPolicy(rawPath, options) {
  const owners = Array.isArray(options?.owners) ? options.owners : [];
  const selfDeviceId = typeof options?.selfDeviceId === 'string' ? options.selfDeviceId : '';
  const policy = options?.policy;
  const normalized = normalizeRoutePath(rawPath);
  if (normalized === undefined) return { route: { kind: 'local' } };
  // 会话归属优先用 cwd；调用方没给 cwd 时退化成目标路径（至少不改变既有行为）。
  const workspace = workspaceForPath(options?.cwd ?? normalized, policy);
  if (workspace === undefined) return routePath(normalized, { owners, selfDeviceId });

  const matched = matchOwner(normalized, owners);
  // 显式附加路径：两种模式都放行（人钉的意图比开关更具体）。
  if (matched !== undefined && matched.source === 'member' && matched.deviceId !== selfDeviceId) {
    return {
      route: { kind: 'remote', deviceId: matched.deviceId, root: matched.path, source: 'member' },
      owner: matched,
      normalized,
      workspace,
    };
  }

  if (workspace.mesh !== true) {
    // 纯本地工作区：不因为路径命中远端主路径就转发。
    return {
      route: { kind: 'local' },
      owner: matched !== undefined && matched.deviceId === selfDeviceId ? matched : undefined,
      normalized,
      workspace,
      reason: matched === undefined
        ? '纯本地工作区：路径不属于任何已登记设备'
        : '纯本地工作区：强制本机执行（不按路径转发）',
    };
  }

  // 属主设备：先按**声明**解析名字，解析不出来再用**账目**兜底（见
  // ownerDeviceForWorkspacePath 的说明：名字是提示，账目才是权威）。
  let ownerDeviceId = typeof options?.resolveOwner === 'function' ? options.resolveOwner(workspace.owner) : undefined;
  let ownerVia = 'declared';
  if (ownerDeviceId === undefined || ownerDeviceId === '') {
    const onPath = ownerDeviceForWorkspacePath(workspace.path, owners, selfDeviceId);
    if (onPath !== undefined) {
      ownerDeviceId = onPath.deviceId;
      ownerVia = 'ledger';
    }
  }
  if (ownerDeviceId === undefined || ownerDeviceId === '') {
    return {
      route: {
        kind: 'denied',
        reason: workspace.owner === ''
          ? `互联会话工作区 ${workspace.path} 没有声明 owner，账目里也没有它的属主，拒绝在本机落地`
          : `互联会话工作区 ${workspace.path} 声明的 owner「${workspace.owner}」解析不到设备，账目里也没有它的属主，拒绝在本机落地`,
      },
      normalized,
      workspace,
      reason: '互联会话无法确定属主设备',
    };
  }
  if (ownerDeviceId === selfDeviceId) {
    // 本机就是属主 —— 互联会话在这里执行是**正确**的（文件与命令都在这台）。
    return { route: { kind: 'local' }, owner: matched, normalized, workspace, reason: '本机即属主' };
  }
  return {
    route: {
      kind: 'remote',
      deviceId: ownerDeviceId,
      root: matched !== undefined ? matched.path : workspace.path,
      source: matched !== undefined ? matched.source : 'mesh-owner',
    },
    owner: matched,
    normalized,
    workspace,
    // 属主是**怎么**定出来的：`declared` = 声明里的名字解析成功；`ledger` = 名字没解析
    // 出来、用账目兜底。排查时这两者的区别很关键（后者说明设备名表不全）。
    ownerVia,
  };
}

/**
 * 路由判定的可读解释（给 UI、审计日志和工具输出用）。
 *
 * 刻意返回中文字符串而不是枚举值：它要直接出现在给人看的审计记录里。
 *
 * @param {{route: Route, owner?: PathOwner, normalized?: string}} decision `routePath()` 的返回值。
 * @param {(deviceId: string) => string} [nameOf] 设备 id → 显示名。
 * @returns {string} 一行说明。
 */
export function explainRoute(decision, nameOf) {
  const name = (deviceId) => (typeof nameOf === 'function' ? nameOf(deviceId) : deviceId);
  const { route, owner, normalized, workspace } = decision ?? {};
  if (route === undefined) return '路由未判定';
  if (route.kind === 'denied') {
    return `拒绝执行（${route.reason}）`;
  }
  if (route.kind === 'local') {
    if (workspace !== undefined && workspace.mesh !== true) {
      return owner === undefined
        ? `本地执行（纯本地工作区 ${workspace.path}）`
        : `本地执行（纯本地工作区 ${workspace.path}，不按路径转发）`;
    }
    if (workspace !== undefined && workspace.mesh === true) {
      return `本地执行（互联会话 ${workspace.path} 的属主就是本机）`;
    }
    return owner === undefined
      ? `本地执行（${normalized ?? '路径不明'} 不属于任何已登记的设备路径）`
      : `本地执行（命中本机路径 ${owner.path}）`;
  }
  const prefer = owner?.prefer === true ? '，显式偏好' : '';
  if (route.source === 'mesh-owner') {
    return `路由到 ${name(route.deviceId)}（互联会话 ${workspace?.path ?? route.root} 的属主；目标 ${normalized ?? '?'} 不在任何已登记路径内）`;
  }
  return `路由到 ${name(route.deviceId)}（命中${route.source === 'primary' ? '主' : '附加'}路径 ${route.root}${prefer}）`;
}
