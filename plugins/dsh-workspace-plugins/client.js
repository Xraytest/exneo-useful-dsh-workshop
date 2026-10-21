/**
 * dsh-workspace-plugins —— 浏览器半边。
 *
 * 设置页新增「工作区插件」一节（order 30），管的是**哪个工作区挂哪些插件**：
 *   - 工作区清单：路径 / 匹配方式（精确或子树）/ 来源（组合配置 or 设置页）/
 *     当前活会话的挂载实况（几个会话生效、几个失败、失败原因）；
 *   - 行编辑：加行（模块标识 + config + isolate + 探测）、停用/启用、删除、
 *     上移下移；「探测」会先让 host 真的 import 一次，形态不对当场拦下，不用等
 *     保存后才发现模块名写错；
 *   - 组合声明的行只读展示，可停用（停用标记写状态文件，不动 profile 的组合文件）；
 *   - 命中测试：填一个目录（可再填会话 id），host 按当前清单算出它会挂什么、凭什么
 *     命中——这是「为什么这个会话没挂上」最快的答案；
 *   - **网络工作区**：接入了设备网格（dsh-device-mesh）时，每张工作区卡片会显示
 *     它的设备归属、本机参与匹配的路径（主路径 + 本机附加路径 mirror/scratch）、
 *     以及远端副本在哪台设备上。声明可以按「工作区 id」绑定（跨设备一致），也可以
 *     按路径绑定（老口径）；本机没有路径的网络工作区会被明确标成「本机无路径」，
 *     本机缺失的路径类子插件行标成「本机没有」而不是「失败」。
 *   - 诊断：状态文件路径与读取错误、模块预导入结果、每个活会话的挂载明细。
 *
 * 数据全部走本插件 host 半边的同源路由（静态插件没有动态包的 host.call）：
 *   GET  /dsh-workspace-plugins/state[?cwd=…] · /status
 *   POST /dsh-workspace-plugins/{save,reload,probe,remount}
 *
 * 由 package.json 的 dsh.client 声明装载（exports["./client"]）。
 *
 * @module dsh-workspace-plugins/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-plugins',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/dsh-workspace-plugins';
    /** client.js 改了就 +1：设置页头部会显示它，用来确认页面加载的是新代码。 */
    const CLIENT_VERSION = 6;

    const PAGE_CSS = [
      '.wsp-root { display: flex; flex-direction: column; gap: 12px; font-size: 13px; color: var(--dsw-alias-label-primary); }',
      '.wsp-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }',
      '.wsp-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.7; }',
      '.wsp-code { font-family: monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }',
      '.wsp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.wsp-list { display: flex; flex-direction: column; gap: 8px; }',
      '.wsp-entry { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }',
      '.wsp-entry.hit { border-color: var(--dsw-alias-brand-primary); }',
      '.wsp-path { font-family: monospace; font-size: 12px; font-weight: 600; word-break: break-all; }',
      '.wsp-sub { font-size: 12px; font-weight: 600; }',
      '.wsp-plugin { border-top: 1px dashed var(--dsw-alias-border-l1); padding-top: 6px; display: flex; flex-direction: column; gap: 4px; }',
      '.wsp-plugin:first-child { border-top: none; padding-top: 0; }',
      '.wsp-name { font-family: monospace; font-size: 11px; word-break: break-all; color: var(--dsw-alias-label-secondary); }',
      '.wsp-dim { opacity: .72; }',
      '.wsp-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; }',
      '.wsp-btn:hover { border-color: var(--dsw-alias-brand-primary); }',
      '.wsp-btn.primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }',
      '.wsp-btn.danger { color: var(--dsw-alias-label-secondary); }',
      '.wsp-btn:disabled { opacity: .45; cursor: default; }',
      '.wsp-input { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 4px 8px; font-size: 12px; flex: 1 1 260px; min-width: 160px; }',
      '.wsp-input.short { flex: 0 1 150px; }',
      '.wsp-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
      '.wsp-text { width: 100%; min-height: 54px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 6px 8px; font-size: 12px; font-family: monospace; resize: vertical; box-sizing: border-box; }',
      '.wsp-text:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
      '.wsp-select { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 4px 6px; font-size: 12px; }',
      '.wsp-badge { border-radius: 999px; padding: 1px 8px; font-size: 11px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }',
      '.wsp-badge.on { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }',
      '.wsp-badge.bad { color: #d9534f; border-color: #d9534f; }',
      '.wsp-badge.warn { color: #d99000; border-color: #d99000; }',
      '.wsp-error { color: #d9534f; font-size: 12px; line-height: 1.6; white-space: pre-wrap; }',
      '.wsp-notice { color: var(--dsw-alias-brand-primary); font-size: 12px; white-space: pre-wrap; line-height: 1.6; }',
      '.wsp-spacer { flex: 1; }',
      '.wsp-diag { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.8; white-space: pre-wrap; }',
    ];

    function injectStyles() {
      if (typeof document === 'undefined') return () => {};
      const tagId = 'dsh-workspace-plugins/page.css';
      let tag = document.querySelector('style[data-plugin-css="' + tagId + '"]');
      if (tag === null || tag === undefined) {
        tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-workspace-plugins';
        tag.dataset.pluginCss = tagId;
        tag.textContent = PAGE_CSS;
        (document.head || document.documentElement).appendChild(tag);
      }
      return () => {
        if (tag !== null && tag !== undefined && tag.parentNode !== null && tag.parentNode !== undefined) {
          tag.parentNode.removeChild(tag);
        }
      };
    }

    /* ---------------------------------------------------------------- API ---- */

    /**
     * 访问令牌：host 半边经 `webserver/index-inject` 注入到已鉴权的 index HTML 里
     * （`globalThis.__DSH_WORKSPACE_PLUGINS__.token`）。写路由要求带它——只靠
     * Origin/Host 一致挡不住 DNS rebinding。页面若是插件更新前打开的，取不到令牌，
     * host 会回 403 并让我们提示「刷新页面」。
     */
    function token() {
      const injected = globalThis.__DSH_WORKSPACE_PLUGINS__;
      return injected !== null && injected !== undefined && typeof injected.token === 'string' ? injected.token : '';
    }

    function withToken(options) {
      const headers = Object.assign({}, (options && options.headers) || {});
      const value = token();
      if (value !== '') headers['x-workspace-plugins-token'] = value;
      return Object.assign({}, options || {}, { headers, credentials: 'same-origin' });
    }

    async function fetchJson(url, options) {
      const response = await fetch(url, withToken(options));
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) throw new Error((body && body.error) || (response.status + ' ' + response.statusText));
      return body;
    }

    const post = (suffix, payload) => fetchJson(ROUTE + '/' + suffix, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload === undefined ? {} : payload),
    });

    /** host 路由封装（自测里可整体替换）。 */
    const api = {
      state: (cwd) => fetchJson(ROUTE + '/state' + (typeof cwd === 'string' && cwd !== '' ? '?cwd=' + encodeURIComponent(cwd) : '')),
      status: () => fetchJson(ROUTE + '/status'),
      save: (payload) => post('save', payload),
      reload: () => post('reload'),
      probe: (specifier) => post('probe', { specifier }),
      remount: (sessionId) => post('remount', sessionId === undefined ? {} : { sessionId }),
    };

    /* ------------------------------------------------------------ 纯函数 ---- */

    const STATE_TEXT = {
      active: '生效',
      pending: '挂载中',
      waiting: '等待服务',
      failed: '失败',
      skipped: '未挂载',
      unavailable: '本机没有',
    };

    /** 行的实时状态文案 + 徽章档位。 */
    function rowStateText(row) {
      const live = row.live;
      if (row.conflict === true) return { text: '与组合冲突，未挂载', tone: 'bad' };
      if (row.disabled === true) return { text: '已停用', tone: '' };
      if (live === null || live === undefined) return { text: '无命中会话', tone: '' };
      const total = live.total || 0;
      const active = live.active || 0;
      const failed = live.failed || 0;
      const waiting = live.waiting || 0;
      const pending = live.pending || 0;
      const unavailable = live.unavailable || 0;
      const parts = [String(active) + '/' + String(total) + ' 会话生效'];
      if (failed > 0) parts.push(String(failed) + ' 失败');
      // 「本机没有」单独一档：它多半是网络工作区上的路径类子插件（文件在另一台设备上），
      // 不是坏行，但本机也挂不上——用 warn 而不是 bad，并且不并进「失败」里。
      if (unavailable > 0) parts.push(String(unavailable) + ' 本机没有（网络工作区）');
      if (waiting > 0) parts.push(String(waiting) + ' 等待服务');
      if (pending > 0) parts.push(String(pending) + ' 挂载中');
      // 泄漏不在这里判：探针窗口是按时间切的（一次 sweep 里多个会话会互相污染），
      // 逐行断言会给出错误的行号。它上浮成会话级明细 + 页首横幅。
      return {
        text: parts.join(' · '),
        tone: failed > 0 ? 'bad' : unavailable > 0 || waiting > 0 || pending > 0 ? 'warn' : active > 0 ? 'on' : '',
      };
    }

    /** 匹配方式文案。 */
    function matchText(match) {
      return match === 'subtree' ? '子树（含子目录）' : '精确（仅该目录）';
    }

    /** 来源文案。 */
    function sourceText(source) {
      if (source === 'config') return '组合配置';
      if (source === 'file') return '设置页';
      return '组合配置 + 设置页';
    }

    /**
     * 一份声明的**稳定键**，与 host 的 store.workspaceKeyOf 同一口径：
     * 有工作区 id 就是 `ws:<id>`（跨设备一致），否则 `path:<本机路径>`。
     * 设置页用它把「host 视图里的工作区」与「草稿里的工作区」对上（路径可能为空）。
     */
    function workspaceKeyOf(workspace) {
      const id = workspace !== null && workspace !== undefined && typeof workspace.workspaceId === 'string' ? workspace.workspaceId.trim() : '';
      if (id !== '') return 'ws:' + id;
      return 'path:' + String(workspace !== null && workspace !== undefined && workspace.path ? workspace.path : '');
    }

    /**
     * `configDisabled` 的工作区键，与 host 的 store.disableKeyOf 同一口径：
     * 路径声明保持 v6 的裸路径（既有状态文件不用迁移），身份绑定用 `ws:<id>`。
     */
    function disableKeyOf(workspace) {
      const id = workspace !== null && workspace !== undefined && typeof workspace.workspaceId === 'string' ? workspace.workspaceId.trim() : '';
      if (id !== '') return 'ws:' + id;
      return workspace !== null && workspace !== undefined && typeof workspace.path === 'string' ? workspace.path : '';
    }

    /** 工作区的显示名：本机路径 → 工作区标题 → id；本机无路径时明说。 */
    function workspaceTitleOf(workspace) {
      if (workspace === null || workspace === undefined) return '(未知工作区)';
      if (typeof workspace.path === 'string' && workspace.path !== '') return workspace.path;
      if (typeof workspace.registryPath === 'string' && workspace.registryPath !== '') return workspace.registryPath;
      if (workspace.workspaceId !== undefined && workspace.workspaceId !== null) return '工作区 ' + String(workspace.workspaceId) + '（本机无路径）';
      return '(没有路径也没有工作区 id)';
    }

    /**
     * 设备归属文案（网络工作区）。没有网格信息的单机部署返回 null，页面就不显示这一行。
     */
    function deviceText(workspace) {
      const net = workspace !== null && workspace !== undefined ? workspace.network : null;
      if (net === null || net === undefined) return null;
      const remote = Array.isArray(net.remoteDevices) ? net.remoteDevices : [];
      const parts = [];
      if (net.homeLocal === false) parts.push('主路径在 ' + String(net.homeDeviceName || net.homeDeviceId || '另一台设备'));
      else parts.push('本机为主');
      if (remote.length > 0) parts.push('远端副本：' + remote.join('、'));
      else if (net.available !== true) parts.push('（设备网格不可用）');
      return parts.join(' · ');
    }

    /**
     * 顶部设备/网格摘要：本机是哪台、接入了谁、账目里有多少远端副本、本机注册表可不可用。
     * 单机部署也要说清「没有网格」——不然用户会以为「网络工作区」这块坏了。
     */
    function meshLine(state) {
      const mesh = state !== null && state !== undefined ? state.mesh : null;
      const registry = state !== null && state !== undefined ? state.registry : null;
      const bits = [];
      if (mesh === null || mesh === undefined || mesh.available !== true) {
        const why = mesh !== null && mesh !== undefined && mesh.error ? '：' + String(mesh.error) : '';
        bits.push('设备：单机（设备网格不可用' + why + '）');
      } else {
        const self = mesh.self || {};
        const peers = Array.isArray(mesh.peers) ? mesh.peers : [];
        const peerText = peers.map((device) => String(device.name || device.deviceId || '?') + (device.liveness !== undefined && device.liveness !== null ? '/' + String(device.liveness) : '')).join('、');
        bits.push('设备：本机 ' + String(self.name || self.deviceId || '?') + '　接入 ' + String(peers.length) + ' 台' + (peers.length > 0 ? '（' + peerText + '）' : ''));
        bits.push('工作区账目 ' + String(mesh.groups === undefined ? 0 : mesh.groups) + ' 组、远端副本 ' + String(mesh.remoteMembers === undefined ? 0 : mesh.remoteMembers) + ' 条');
      }
      const hasRegistry = registry !== null && registry !== undefined && registry.available === true;
      const list = hasRegistry && Array.isArray(registry.workspaces) ? registry.workspaces : [];
      bits.push('本机注册表：' + (hasRegistry ? String(list.length) + ' 个工作区（可按 id 绑定）' : '不可用' + (registry !== null && registry !== undefined && registry.error ? '（' + String(registry.error) + '）' : '')));
      return bits.join('　·　');
    }

    /** 模块预导入状态文案。 */
    function moduleText(record) {
      if (record.state === 'ok') {
        const shape = record.pluginShape;
        const applyText = shape !== undefined && shape.apply !== undefined ? 'apply 就绪' : '无 apply';
        const injectText = shape !== undefined && Array.isArray(shape.inject) && shape.inject.length > 0 ? '，inject: ' + shape.inject.join(', ') : '';
        const nameText = shape !== undefined && typeof shape.name === 'string' ? ' · ' + shape.name : '';
        return '已导入（' + applyText + injectText + nameText + '）';
      }
      if (record.state === 'loading') return '导入中';
      return '导入失败：' + String(record.error);
    }

    function sessionLine(mount) {
      const bits = [];
      for (const row of mount.rows) {
        const text = STATE_TEXT[row.state] || row.state;
        bits.push(row.id + '=' + text + (row.state === 'failed' || row.state === 'unavailable' ? '（' + String(row.error) + '）' : row.state === 'waiting' ? '（缺 ' + (row.waitingFor || []).join(', ') + '）' : ''));
      }
      return bits.join('　');
    }

    /** 一个新行的空模板（id 与模块标识留空，由用户填）。 */
    function emptyRow() {
      return { id: '', name: '', disabled: false, configText: '{}', isolateText: '' };
    }

    /** 界面上的一行 → 状态文件里的一行（解析 config/isolate 文本，返回错误列表）。 */
    function rowToState(row, where) {
      const errors = [];
      const out = { id: String(row.id || '').trim(), name: String(row.name || '').trim() };
      if (out.id === '') errors.push(where + '：id 不能为空');
      else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out.id)) errors.push(where + '：id 只能包含字母数字与 . _ -');
      if (out.name === '') errors.push(where + '：模块标识不能为空');
      if (row.disabled === true) out.disabled = true;
      const configText = String(row.configText === undefined ? '' : row.configText).trim();
      if (configText !== '') {
        try {
          const parsed = JSON.parse(configText);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) errors.push(where + '：config 必须是 JSON 对象');
          else if (Object.keys(parsed).length > 0) out.config = parsed; // 空对象不写进状态文件（省得每行都带一个 config: {}）
        } catch (error) {
          errors.push(where + '：config 不是合法 JSON（' + String(error.message) + '）');
        }
      }
      const isolateText = String(row.isolateText === undefined ? '' : row.isolateText).trim();
      if (isolateText !== '') {
        // 语法：`服务名` 或 `服务名=标签`，多个用逗号分隔；不带 `=标签` 即每次挂载一个独立域。
        const isolate = {};
        for (const piece of isolateText.split(',')) {
          const item = piece.trim();
          if (item === '') continue;
          const at = item.indexOf('=');
          const service = (at === -1 ? item : item.slice(0, at)).trim();
          const label = at === -1 ? '' : item.slice(at + 1).trim();
          if (service === '') {
            errors.push(where + '：isolate 里的服务名不能为空');
            continue;
          }
          isolate[service] = label === '' ? true : label;
        }
        if (Object.keys(isolate).length > 0) out.isolate = isolate;
      }
      return { row: out, errors };
    }

    /** 界面草稿 → 状态文件载荷。 */
    function draftToState(draft) {
      const errors = [];
      // config 不可序列化的行不允许经本页保存：视图里那份是占位文本，写回去就把真
      // config 弄丢了（host 侧同样会拒，这里是让用户在页面上直接看到原因）。
      const unsafe = [];
      for (const workspace of Array.isArray(draft) ? draft : []) {
        for (const row of Array.isArray(workspace.plugins) ? workspace.plugins : []) {
          if (row.configUnsafe === true) unsafe.push(workspaceTitleOf(workspace) + '#' + String(row.id || ''));
        }
      }
      if (unsafe.length > 0) {
        return { errors: ['这些行的 config 含无法序列化的值，本页拒绝保存（会丢 config）：' + unsafe.join('、')], state: null };
      }
      const workspaces = [];
      (Array.isArray(draft) ? draft : []).forEach((workspace, index) => {
        const where = '第 ' + String(index + 1) + ' 个工作区';
        const path = String(workspace.path || '').trim();
        // 工作区 id 是跨设备一致的绑定方式（网络工作区的正解）：只给 id 或 id+路径都行。
        const workspaceId = String(workspace.workspaceId || '').trim();
        if (path === '' && workspaceId === '') errors.push(where + '：至少要给路径或工作区 id 之一');
        else if (path !== '' && !/^(\/|[A-Za-z]:[\\/]|~\/)/.test(path)) errors.push(where + '：路径必须是绝对路径（或以 ~/ 开头）：' + path);
        if (workspaceId !== '' && !/^[A-Za-z0-9][A-Za-z0-9._:-]{3,79}$/.test(workspaceId)) {
          errors.push(where + '：工作区 id 形如 863de1b8-a5f4-4560-beb7-fda46cf99189（4–80 个字母/数字/. _ : -）：' + workspaceId);
        }
        const rows = [];
        const seen = new Set();
        (Array.isArray(workspace.plugins) ? workspace.plugins : []).forEach((row, rowIndex) => {
          const converted = rowToState(row, where + ' 第 ' + String(rowIndex + 1) + ' 行');
          errors.push(...converted.errors);
          if (seen.has(converted.row.id)) errors.push(where + '：行 id 重复：' + converted.row.id);
          seen.add(converted.row.id);
          rows.push(converted.row);
        });
        if (rows.length === 0) errors.push(where + '：至少要有 1 行（没有任何插件的工作区声明没有意义）');
        const decl = { match: workspace.match === 'subtree' ? 'subtree' : 'exact', plugins: rows };
        if (path !== '') decl.path = path;
        if (workspaceId !== '') decl.workspace = workspaceId;
        // 只有明确关掉时才写进文件：默认（含本机附加路径）保持文件干净。
        if (workspace.includeMembers === false) decl.includeMembers = false;
        workspaces.push(decl);
      });
      return { workspaces, errors };
    }

    /** 状态文件里的行 → 界面草稿行。 */
    function stateToRow(row) {
      return {
        id: row.id,
        name: row.name,
        disabled: row.disabled === true,
        // 带上这个标记：草稿一路传到保存校验，避免把占位文本写回状态文件。
        configUnsafe: row.configUnsafe === true,
        configText: row.config === undefined || row.config === null ? '{}' : JSON.stringify(row.config, null, 0),
        isolateText: row.isolate === undefined || row.isolate === null
          ? ''
          : Object.keys(row.isolate).map((service) => (row.isolate[service] === true ? service : service + '=' + String(row.isolate[service]))).join(', '),
      };
    }

    /** 状态文件的 workspaces → 可编辑草稿（只含状态文件里的那份，组合声明不进来）。 */
    function fileToDraft(fileState) {
      const workspaces = fileState !== null && fileState !== undefined && Array.isArray(fileState.workspaces) ? fileState.workspaces : [];
      return workspaces.map((workspace) => ({
        // path 可能为空（只按工作区 id 绑定的声明）——草稿里用空串表示，保存时按 id 写回。
        path: typeof workspace.path === 'string' ? workspace.path : '',
        // 状态文件里的拼写是 `workspace`（save 时按这个写），host 读的时候两种都认；
        // 这里也必须两种都认，否则「按 id 绑定」的声明在设置页会退化成空绑定。
        workspaceId: typeof workspace.workspace === 'string' && workspace.workspace !== ''
          ? workspace.workspace
          : typeof workspace.workspaceId === 'string' ? workspace.workspaceId : '',
        includeMembers: workspace.includeMembers !== false,
        match: workspace.match === 'subtree' ? 'subtree' : 'exact',
        plugins: (Array.isArray(workspace.plugins) ? workspace.plugins : []).map(stateToRow),
      }));
    }

    /** 状态文件里可用的候选模块标识（给输入框做提示）。 */
    function catalogText(state) {
      const list = state !== null && state !== undefined && Array.isArray(state.catalog) ? state.catalog : [];
      return list.join('\n');
    }

    /* ------------------------------------------------------------- 组件 ---- */

    const btn = (label, onClick, tone) => {
      const disabled = tone === 'disabled';
      const classes = 'wsp-btn' + (tone !== undefined && tone !== '' && !disabled ? ' ' + tone : '');
      return h('button', disabled ? { className: classes, onClick, type: 'button', disabled: true } : { className: classes, onClick, type: 'button' }, label);
    };
    const badge = (text, tone) => h('span', { className: 'wsp-badge' + (tone !== undefined && tone !== '' ? ' ' + tone : '') }, text);

    function WorkspacePluginsPage() {
      const [state, setState] = React.useState(null);
      const [draft, setDraft] = React.useState([]);
      const [configDisabled, setConfigDisabled] = React.useState([]);
      const [dirty, setDirty] = React.useState(false);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [probes, setProbes] = React.useState({});
      const [matchPath, setMatchPath] = React.useState('');
      const [matchInfo, setMatchInfo] = React.useState(null);
      const [customPath, setCustomPath] = React.useState('');
      const [customMatch, setCustomMatch] = React.useState('exact');
      const [showDiag, setShowDiag] = React.useState(false);
      // 追加在末尾：渲染自测按位置喂 hook，新加的必须排在老位置之后（老调用点不用改）。
      const [customWorkspaceId, setCustomWorkspaceId] = React.useState('');
      const [customIncludeMembers, setCustomIncludeMembers] = React.useState(true);

      const errorText = (value) => (value instanceof Error ? value.message : String(value));

      const adopt = React.useCallback((body) => {
        setState(body);
        setDraft(fileToDraft(body.fileState));
        setConfigDisabled(Array.isArray(body.fileState.configDisabled) ? body.fileState.configDisabled.slice() : []);
        setDirty(false);
      }, []);

      const load = React.useCallback(async () => {
        try {
          const body = await api.state();
          adopt(body);
          setError('');
        } catch (loadError) {
          setError(errorText(loadError));
        }
      }, [adopt]);

      React.useEffect(() => {
        let alive = true;
        api.state().then((body) => {
          if (alive) {
            adopt(body);
            setError('');
          }
        }).catch((loadError) => {
          if (alive) setError(errorText(loadError));
        });
        return () => {
          alive = false;
        };
      }, [adopt]);

      const mutate = (next) => {
        setDraft(next);
        setDirty(true);
        setNotice('');
      };

      const updateRow = (workspaceIndex, rowIndex, patch) => {
        const next = draft.slice();
        const workspace = Object.assign({}, next[workspaceIndex]);
        const rows = workspace.plugins.slice();
        rows[rowIndex] = Object.assign({}, rows[rowIndex], patch);
        workspace.plugins = rows;
        next[workspaceIndex] = workspace;
        mutate(next);
      };

      const addRow = (workspaceIndex) => {
        const next = draft.slice();
        const workspace = Object.assign({}, next[workspaceIndex]);
        workspace.plugins = workspace.plugins.concat([emptyRow()]);
        next[workspaceIndex] = workspace;
        mutate(next);
      };

      const removeRow = (workspaceIndex, rowIndex) => {
        const next = draft.slice();
        const workspace = Object.assign({}, next[workspaceIndex]);
        workspace.plugins = workspace.plugins.filter((_row, index) => index !== rowIndex);
        next[workspaceIndex] = workspace;
        mutate(next);
      };

      const moveRow = (workspaceIndex, rowIndex, delta) => {
        const target = rowIndex + delta;
        const workspace = draft[workspaceIndex];
        if (target < 0 || target >= workspace.plugins.length) return;
        const next = draft.slice();
        const rows = workspace.plugins.slice();
        const moved = rows.splice(rowIndex, 1)[0];
        rows.splice(target, 0, moved);
        next[workspaceIndex] = Object.assign({}, workspace, { plugins: rows });
        mutate(next);
      };

      const setWorkspaceField = (workspaceIndex, patch) => {
        const next = draft.slice();
        next[workspaceIndex] = Object.assign({}, next[workspaceIndex], patch);
        mutate(next);
      };

      const addWorkspace = () => {
        const path = String(customPath || '').trim();
        const workspaceId = String(customWorkspaceId || '').trim();
        if (path === '' && workspaceId === '') {
          setError('先填一个绝对路径，或从下拉里挑一个本机工作区（按工作区 id 绑定，跨设备一致）');
          return;
        }
        const key = workspaceKeyOf({ workspaceId, path });
        if (draft.some((workspace) => workspaceKeyOf(workspace) === key)) {
          setError('这个工作区已经在清单里了');
          return;
        }
        mutate(draft.concat([{
          path,
          workspaceId,
          includeMembers: customIncludeMembers !== false,
          match: customMatch === 'subtree' ? 'subtree' : 'exact',
          plugins: [emptyRow()],
        }]));
        setCustomPath('');
        setCustomWorkspaceId('');
        setError('');
      };

      const removeWorkspace = (workspaceIndex) => {
        mutate(draft.filter((_workspace, index) => index !== workspaceIndex));
      };

      const save = async () => {
        const payload = draftToState(draft);
        if (payload.errors.length > 0) {
          setError(payload.errors.join('\n'));
          setNotice('');
          return;
        }
        setBusy(true);
        try {
          const body = await api.save({ workspaces: payload.workspaces, configDisabled });
          adopt(body);
          setError('');
          setNotice('已保存并立即生效（活着的会话已按新清单重挂）');
        } catch (saveError) {
          setError(errorText(saveError));
        } finally {
          setBusy(false);
        }
      };

      const reload = async () => {
        setBusy(true);
        try {
          const body = await api.reload();
          adopt(body.state);
          setError('');
          setNotice('已重新读取状态文件并重新挂载');
        } catch (reloadError) {
          setError(errorText(reloadError));
        } finally {
          setBusy(false);
        }
      };

      const remount = async () => {
        setBusy(true);
        try {
          const body = await api.remount();
          const result = body.result || {};
          const body2 = await api.state();
          adopt(body2);
          setError('');
          setNotice('重挂完成：保留 ' + String(result.kept || 0) + '、重挂 ' + String(result.remounted || 0) + '、新挂 ' + String(result.mounted || 0));
        } catch (remountError) {
          setError(errorText(remountError));
        } finally {
          setBusy(false);
        }
      };

      const probe = async (key, specifier) => {
        const name = String(specifier || '').trim();
        if (name === '') {
          setProbes(Object.assign({}, probes, { [key]: { ok: false, error: '先填模块标识' } }));
          return;
        }
        try {
          const result = await api.probe(name);
          setProbes(Object.assign({}, probes, { [key]: result }));
        } catch (probeError) {
          setProbes(Object.assign({}, probes, { [key]: { ok: false, error: errorText(probeError) } }));
        }
      };

      const testMatch = async () => {
        const path = matchPath.trim();
        if (path === '') {
          setMatchInfo(null);
          return;
        }
        try {
          const body = await api.state(path);
          setMatchInfo(body.diagnostics.matched);
        } catch (matchError) {
          setError(errorText(matchError));
        }
      };

      /** 组合行的停用开关：写 configDisabled（不动 profile 的组合文件）。 */
      const toggleConfigRow = (workspacePath, rowId) => {
        const key = workspacePath + '#' + rowId;
        const next = configDisabled.includes(key) ? configDisabled.filter((item) => item !== key) : configDisabled.concat([key]);
        setConfigDisabled(next);
        setDirty(true);
        setNotice('');
      };

      if (state === null) {

      return h('div', { className: 'wsp-root' },
          h('div', { className: 'wsp-card' }, h('div', { className: 'wsp-meta' }, '正在读取工作区插件状态…')),
          error !== '' ? h('div', { className: 'wsp-card' }, h('div', { className: 'wsp-error' }, error), btn('重试', load)) : null);
      }

      // host 少字段时的容错：页面退化成「能显示多少显示多少」，而不是整节白屏。
      const file = state.file ?? { exists: false, bytes: 0, errors: [], warnings: [] };
      const config = state.config ?? { errors: [], declared: [] };
      const diagnostics = state.diagnostics ?? {};
      const catalog = Array.isArray(state.catalog) ? state.catalog : [];
      const workspaces = Array.isArray(state.workspaces) ? state.workspaces : [];
      const leaked = state.live !== null && state.live !== undefined && Array.isArray(state.live.leaked) ? state.live.leaked : [];
      const unsafeRows = workspaces.flatMap((workspace) => (Array.isArray(workspace.plugins) ? workspace.plugins : [])
        .filter((row) => row.configUnsafe === true)
        .map((row) => workspace.path + '#' + row.id));
      const modules = Array.isArray(state.modules) ? state.modules : [];
      const mesh = state.mesh ?? { available: false, error: '（host 未上报）', self: {}, peers: [], devices: [], groups: 0, remoteMembers: 0 };
      const registry = state.registry ?? { available: false, error: '（host 未上报）', workspaces: [] };
      const registryWorkspaces = Array.isArray(registry.workspaces) ? registry.workspaces : [];
      const mounts = Array.isArray(state.mounts) ? state.mounts : [];
      const live = state.live || { agents: 0, mountedSessions: 0 };

      /** 按「工作区稳定键 + 行 id」取该行的实时汇总（来自 host 的 /state）。 */
      const liveOf = (workspaceKey, rowId) => {
        const workspace = (Array.isArray(state.workspaces) ? state.workspaces : [])
          .find((item) => (item.key !== undefined && item.key !== null ? item.key : workspaceKeyOf(item)) === workspaceKey);
        const entry = workspace === undefined ? undefined : (Array.isArray(workspace.plugins) ? workspace.plugins : []).find((item) => item.id === rowId);
        return entry === undefined ? undefined : entry.live;
      };

      /**
       * 一行的实时状态块：徽章 + 失败原文 + 等待服务 + 疑似全局泄漏。
       *
       * 编辑区（设置页声明的行）与只读区（组合配置的行）共用它——早先只有只读区显示
       * 状态，于是「自己刚加的行为什么没生效」在页面上看不见，只能翻活会话明细。
       * @param live - host 汇总的该行实时状态，未保存的新行传 undefined。
       * @returns 元素数组；无状态时为空数组。
       */
      const renderLiveDetails = (row) => {
        // 口径与 rowStateText 一致：传「行」（带 live），不是 live 本身——传错会
        // 一律显示「无命中会话」（渲染自测抓到过这个错位）。
        const live = row === undefined || row === null ? undefined : row.live;
        if (live === undefined || live === null) return [];
        // 三种提示各自按**数据**出现，不看徽章档位：一行可以同时「在等待服务」和
        // 「疑似泄漏」，用 tone 做开关会让后一种把前一种吞掉（渲染自测抓到过）。
        const errors = Array.isArray(live.errors) ? live.errors : [];
        const waitingFor = Array.isArray(live.waitingFor) ? live.waitingFor : [];
        return [
          errors.length > 0 ? h('div', { className: 'wsp-error', key: 'err' }, errors.join('\n')) : null,
          waitingFor.length > 0
            ? h('div', { className: 'wsp-meta', key: 'wait' }, '等待的服务：' + waitingFor.join(', ') + '（agent 作用域里解析不到，确认该服务是否只在 host 平面提供）')
            : null,
        ].filter((item) => item !== null);
      };

      const renderFileRow = (workspaceIndex, row, rowIndex) => {
        const key = 'draft-' + String(workspaceIndex) + '-' + String(rowIndex);
        const probeResult = probes[key];
        return h('div', { className: 'wsp-plugin', key },
          h('div', { className: 'wsp-row' },
            h('input', { className: 'wsp-input short', value: row.id, placeholder: 'id（唯一，如 probe）', onChange: (event) => updateRow(workspaceIndex, rowIndex, { id: event.target.value }) }),
            h('input', { className: 'wsp-input', value: row.name, placeholder: '模块标识：./plugins/xxx/index.js 或包名', onChange: (event) => updateRow(workspaceIndex, rowIndex, { name: event.target.value }) }),
            btn('探测', () => probe(key, row.name)),
            btn(row.disabled === true ? '启用' : '停用', () => updateRow(workspaceIndex, rowIndex, { disabled: row.disabled !== true })),
            btn('↑', () => moveRow(workspaceIndex, rowIndex, -1)),
            btn('↓', () => moveRow(workspaceIndex, rowIndex, 1)),
            btn('删除', () => removeRow(workspaceIndex, rowIndex), 'danger')),
          h('div', { className: 'wsp-row' },
            h('input', { className: 'wsp-input short', value: row.isolateText, placeholder: 'isolate：服务名[=标签]，逗号分隔（可为空）', onChange: (event) => updateRow(workspaceIndex, rowIndex, { isolateText: event.target.value }) })),
          h('textarea', { className: 'wsp-text', value: row.configText, spellCheck: false, placeholder: 'config（JSON 对象，可留空）', onChange: (event) => updateRow(workspaceIndex, rowIndex, { configText: event.target.value }) }),
          // 保存后这一行的实时状态（未保存的新行 liveOf 取不到，自然不显示）
          ...renderLiveDetails({ live: liveOf(workspaceKeyOf(draft[workspaceIndex]), row.id) }),
          probeResult !== undefined
            ? h('div', { className: probeResult.ok === true ? 'wsp-notice' : 'wsp-error' }, probeResult.ok === true
              ? '可挂载：apply=' + String(probeResult.pluginShape !== undefined && probeResult.pluginShape.apply !== undefined ? probeResult.pluginShape.apply : '无') + (probeResult.pluginShape !== undefined && Array.isArray(probeResult.pluginShape.inject) ? '　inject: ' + probeResult.pluginShape.inject.join(', ') : '')
              : '探测失败：' + String(probeResult.error))
            : null,
          row.configUnsafe === true ? h('div', { className: 'wsp-error' }, '该行的 config 含无法序列化的值，本页不编辑/不保存它（请直接改状态文件）。') : null,
          row.disabled === true ? h('div', { className: 'wsp-meta' }, '已停用：保存后该行不再参与预导入与挂载。') : null);
      };

      const renderConfigRow = (workspace, row) => {
        const key = 'config-' + (workspace.key !== undefined && workspace.key !== null ? workspace.key : workspaceKeyOf(workspace)) + '#' + row.id;
        const liveText = rowStateText(row);
        const disabled = row.disabled === true;
        return h('div', { className: 'wsp-plugin', key },
          h('div', { className: 'wsp-row' },
            h('span', { className: 'wsp-sub' }, row.id),
            badge('组合配置', ''),
            row.conflict === true ? badge('与另一处声明冲突', 'bad') : null,
            badge(liveText.text, liveText.tone),
            h('span', { className: 'wsp-spacer' }),
            // ↑ 徽章仍在行首（这里要看得到冲突/停用），实时细节（失败原文/等待服务/泄漏）在下面
            btn(disabled ? '启用' : '停用', () => toggleConfigRow(disableKeyOf(workspace), row.id))),
          h('div', { className: 'wsp-name' }, row.name),
          row.isolate !== null && row.isolate !== undefined ? h('div', { className: 'wsp-meta' }, 'isolate：' + JSON.stringify(row.isolate)) : null,
          row.config !== null && row.config !== undefined && Object.keys(row.config).length > 0 ? h('div', { className: 'wsp-code' }, JSON.stringify(row.config)) : null,
          ...renderLiveDetails(row));
      };

      /** 一个已挂载会话：命中工作区 + 该会话每一行的结果。 */
      const renderMountRow = (mount) => h('div', { className: 'wsp-entry', key: mount.sessionId },
        h('div', { className: 'wsp-row' },
          h('span', { className: 'wsp-path' }, mount.workspace),
          badge(matchText(mount.mode), ''),
          // 凭什么命中：注册表的会话归属（身份）还是路径（精确/子树），以及命中哪条路径
          // （主路径 or 本机附加路径）——网络工作区下这两个问题的答案不一样。
          badge(mount.matchedBy === 'session' ? '身份命中（注册表）' : mount.matchedKind === 'member' ? '本机附加路径' : '主路径', mount.matchedBy === 'session' ? 'on' : ''),
          h('span', { className: 'wsp-name' }, mount.sessionId),
          h('span', { className: 'wsp-spacer' }),
          badge(String(mount.cwd), '')),
        h('div', { className: 'wsp-code' }, sessionLine(mount)));

      /** 诊断区：模块预导入结果 + 计数。默认收起。 */
      const renderDiagnostics = () => h('div', {},
        h('div', { className: 'wsp-sub' }, '模块预导入（' + String(modules.length) + '）'),
        modules.length === 0
          ? h('div', { className: 'wsp-meta' }, '清单里还没有启用中的行，或还没开始预导入。')
          : h('div', { className: 'wsp-list' }, modules.map((record) => h('div', { className: 'wsp-plugin', key: record.specifier },
            h('div', { className: 'wsp-row' },
              h('span', { className: 'wsp-name' }, record.specifier),
              h('span', { className: 'wsp-spacer' }),
              badge(record.state === 'ok' ? '已导入' : record.state === 'loading' ? '导入中' : '失败', record.state === 'ok' ? 'on' : 'bad')),
            h('div', { className: record.state === 'ok' ? 'wsp-meta' : 'wsp-error' }, moduleText(record))))),
        h('div', { className: 'wsp-sub' }, '诊断'),
        h('div', { className: 'wsp-diag' }, [
          '刷新次数：' + String(diagnostics.refreshes) + '　最近：' + String(diagnostics.lastRefreshReason) + ' @ ' + String(diagnostics.lastRefreshAt),
          '挂载判定次数：' + String(diagnostics.mountDecisions) + '　路由错误：' + String(diagnostics.routeErrors),
          '设置页路由：' + String(state.routes === undefined ? '（host 未上报）' : state.routes),
          '本机工作区注册表：' + (registry.available === true ? String(registry.workspaces.length) + ' 个工作区' : '不可用（' + String(registry.error) + '）'),
          '设备网格：' + (mesh.available === true
            ? '本机 ' + String(mesh.self.name || mesh.self.deviceId) + '，接入 ' + String((mesh.peers || []).length) + ' 台（' + (mesh.peers || []).map((device) => String(device.name)).join('、') + '），工作区账目 ' + String(mesh.groups) + ' 组、远端副本 ' + String(mesh.remoteMembers) + ' 条'
            : '不可用（' + String(mesh.error) + '）'),
          '最近错误：' + String(diagnostics.lastError),
          '启动时间：' + String(diagnostics.startedAt),
          '候选本地模块（loader 里已在用的本地行）：\n' + catalogText({ catalog }),
        ].join('\n')));

      return h('div', { className: 'wsp-root' },
        // ① 头部：位置与实况

        leaked.length > 0
          ? h('div', { className: 'wsp-card' },
            h('div', { className: 'wsp-error' }, '疑似有子插件把注册落到了进程全局层：' + leaked.join(', ')),
            h('div', { className: 'wsp-meta' }, '那等于对所有会话生效，而本容器唯一的承诺就是不会发生这件事。上面这些名字是「某次会话挂载窗口内全局层多出来的工具名」——窗口按时间切，同时挂载的多个会话会互相算进来，所以不定位到具体的行；要定位就单独开一个只含一个工作区的会话复现。检查这些子插件是否绕开 agent 作用域、直接挂到了根上下文（ctx.root）。'))
          : null,
        unsafeRows.length > 0
          ? h('div', { className: 'wsp-card' },
            h('div', { className: 'wsp-error' }, '这些行的 config 含无法序列化的值（活对象/循环引用）：' + unsafeRows.join('、')),
            h('div', { className: 'wsp-meta' }, '本页不能编辑或保存它们（写回去会把真 config 换成占位文本）。请直接改状态文件，或用组合行声明。'))
          : null,
        h('div', { className: 'wsp-card' },
          h('div', { className: 'wsp-row' },
            h('span', { className: 'wsp-sub' }, '工作区插件'),
            badge('client v' + String(CLIENT_VERSION), ''),
            badge('host ' + String(state.build), ''),
            badge('活会话 ' + String(live.agents), ''),
            badge('已挂载会话 ' + String(live.mountedSessions), live.mountedSessions > 0 ? 'on' : ''),
            h('span', { className: 'wsp-spacer' }),
            dirty ? badge('有未保存改动', 'warn') : null,
            btn('保存', save, busy ? 'disabled' : 'primary'),
            btn('撤回改动', load),
            btn('重新加载', reload),
            btn('重挂活会话', remount)),
          h('div', { className: 'wsp-meta' }, '把普通插件挂进「指定工作区」的会话：命中该工作区的会话才装上这些插件（工具/提示词段/agent 作用域事件只对它可见），会话结束随之卸载，其它工作区完全不受影响。判定按会话归属（出厂注册表的账）与会话工作目录，精确或子树匹配；接入了设备网格时，工作区的本机附加路径（mirror/scratch）也参与匹配。'),
          h('div', { className: 'wsp-meta' }, meshLine({ mesh, registry })),
          state.routes !== undefined && state.routes !== 'registered'
            ? h('div', { className: 'wsp-error' }, '设置页路由状态异常：' + String(state.routes) + '（host 半边的 webServer 还没就绪或注册失败——数据可能读不到，看一眼 dsh 日志里的 [workspace-plugins]。）')
            : null,
          h('div', { className: 'wsp-code' }, '状态文件：' + String(state.statePath) + (file.exists ? '（' + String(file.bytes) + ' 字节）' : '（尚未创建，首次保存时写入）')),
          h('div', { className: 'wsp-code' }, '模块解析基准：' + String(state.baseUrl)),
          file.errors.length > 0 ? h('div', { className: 'wsp-error' }, '状态文件有 ' + String(file.errors.length) + ' 处问题：\n' + file.errors.join('\n')) : null,
          config.errors.length > 0 ? h('div', { className: 'wsp-error' }, '组合 config 有 ' + String(config.errors.length) + ' 处问题：\n' + config.errors.join('\n')) : null,
          error !== '' ? h('div', { className: 'wsp-error' }, error) : null,
          notice !== '' ? h('div', { className: 'wsp-notice' }, notice) : null),

        // ② 工作区（组合声明 + 设置页）
        h('div', { className: 'wsp-card' },
          h('div', { className: 'wsp-sub' }, '工作区（' + String(workspaces.length) + '）'),
          workspaces.length === 0
            ? h('div', { className: 'wsp-meta' }, '还没有任何工作区声明。下面填一个绝对路径即可开始；也可以直接在 profile 的 cordis.patch.yml 里写 config.workspaces（那样会在上面标成「组合配置」）。')
            : h('div', { className: 'wsp-list' }, workspaces.map((workspace) => {
              const key = workspace.key !== undefined && workspace.key !== null ? workspace.key : workspaceKeyOf(workspace);
              const draftIndex = draft.findIndex((item) => workspaceKeyOf(item) === key);
              const isMatch = matchInfo !== null && matchInfo !== undefined && matchInfo.hit === true && (matchInfo.key === key || (matchInfo.workspace !== null && matchInfo.workspace !== undefined && matchInfo.workspace === workspace.path));
              const net = workspace.network ?? null;
              const remoteDevices = net !== null && Array.isArray(net.remoteDevices) ? net.remoteDevices : [];
              const matchPaths = Array.isArray(workspace.matchPaths) ? workspace.matchPaths : [];
              const hints = Array.isArray(workspace.hints) ? workspace.hints : [];
              const localMembers = net !== null && Array.isArray(net.localMembers) ? net.localMembers : [];
              const mounted = mounts.filter((mount) => (mount.key !== undefined && mount.key !== null ? mount.key : 'path:' + String(mount.workspace || '')) === key).length;
              return h('div', { className: 'wsp-entry' + (isMatch ? ' hit' : ''), key },
                h('div', { className: 'wsp-row' },
                  h('span', { className: 'wsp-path' }, workspaceTitleOf(workspace)),
                  workspace.workspaceId !== undefined && workspace.workspaceId !== null ? badge('id ' + String(workspace.workspaceId).slice(0, 8), '') : null,
                  workspace.label !== undefined && workspace.label !== null ? badge(String(workspace.label), '') : null,
                  badge(matchText(workspace.match), ''),
                  badge(sourceText(workspace.source), workspace.source === 'config' ? '' : 'on'),
                  remoteDevices.length > 0 ? badge('网络 · ' + remoteDevices.join('、'), 'warn') : null,
                  workspace.remoteOnly === true ? badge('本机无路径', 'bad') : null,
                  workspace.includeMembers === false ? badge('不含附加路径', '') : null,
                  badge('活会话 ' + String(mounted), ''),
                  h('span', { className: 'wsp-spacer' }),
                  draftIndex >= 0 ? btn('删除本工作区', () => removeWorkspace(draftIndex), 'danger') : null),
                workspace.title !== undefined && workspace.title !== null && workspace.title !== workspace.path ? h('div', { className: 'wsp-meta' }, '工作区标题：' + String(workspace.title)) : null,
                net !== null ? h('div', { className: 'wsp-meta' }, '设备：' + String(deviceText(workspace)) + (localMembers.length > 0 ? '（本机附加路径 ' + String(localMembers.length) + ' 条）' : '')) : null,
                matchPaths.length > 0
                  ? h('div', { className: 'wsp-code' }, '本机匹配路径：\n' + matchPaths.map((entry) => '· ' + String(entry.path) + '（'
                    + (entry.kind === 'member' ? '附加路径 ' + String(entry.role === null || entry.role === undefined ? '' : entry.role) + (entry.prefer === true ? '，优先' : '') : '主路径')
                    + (entry.exists === false ? '，目录不存在' : '')
                    + '）').join('\n'))
                  : h('div', { className: 'wsp-meta' }, '本机没有参与匹配的路径——本机不会有会话命中它。'),
                hints.length > 0 ? h('div', { className: 'wsp-notice' }, hints.join('\n')) : null,
                workspace.plugins.length === 0 ? h('div', { className: 'wsp-meta' }, '（组合声明没有行；下面加的行属于设置页那份）') : null,
                workspace.plugins.map((row) => (row.source === 'file' && draftIndex >= 0
                  ? renderFileRow(draftIndex, draft[draftIndex].plugins[workspace.plugins.filter((item) => item.source === 'file').indexOf(row)] || emptyRow(), workspace.plugins.filter((item) => item.source === 'file').indexOf(row))
                  : renderConfigRow(workspace, row))),
                draftIndex >= 0 ? btn('＋ 加一行插件', () => addRow(draftIndex)) : null);
            }))),

        // ③ 新建工作区
        h('div', { className: 'wsp-card' },
          h('div', { className: 'wsp-sub' }, '新建工作区声明'),
          registryWorkspaces.length > 0
            ? h('div', { className: 'wsp-row' },
              h('select', {
                className: 'wsp-select',
                value: String(customWorkspaceId || ''),
                onChange: (event) => {
                  const id = event.target.value;
                  setCustomWorkspaceId(id);
                  const hit = registryWorkspaces.find((item) => item.id === id);
                  if (hit !== undefined && typeof hit.path === 'string') setCustomPath(hit.path);
                },
              },
                h('option', { value: '' }, '（按路径绑定：只用下面的绝对路径）'),
                registryWorkspaces.map((item) => h('option', { key: item.id, value: item.id }, String(item.title || item.path) + '　' + String(item.path)))))
            : null,
          h('div', { className: 'wsp-row' },
            h('input', { className: 'wsp-input', value: customPath, placeholder: '绝对路径（已存在的目录），如 /root/nas/ArkTower', onChange: (event) => setCustomPath(event.target.value) }),
            h('select', { className: 'wsp-select', value: customMatch, onChange: (event) => setCustomMatch(event.target.value) },
              h('option', { value: 'exact' }, '精确：仅该目录'),
              h('option', { value: 'subtree' }, '子树：含所有子目录')),
            btn('添加', addWorkspace, 'primary')),
          registryWorkspaces.length > 0
            ? h('label', { className: 'wsp-meta' },
              h('input', { type: 'checkbox', checked: customIncludeMembers !== false, onChange: (event) => setCustomIncludeMembers(event.target.checked) }),
              ' 同时匹配该工作区在**本机**的附加路径（mirror/scratch 工作副本，来自设备网格账目）')
            : null,
          h('div', { className: 'wsp-meta' }, '精确是默认档：一个目录上的声明不会意外作用到它的子目录上；要让子目录会话也生效再选子树（嵌套声明时取最近的祖先）。'),
          h('div', { className: 'wsp-meta' }, '按**工作区 id** 绑定（下拉里挑一个）时，声明写的是身份而不是路径：同一个工作区在别的设备上路径不同也照样对得上，那份声明可以原样贴到对端 profile。')),

        // ④ 命中测试
        h('div', { className: 'wsp-card' },
          h('div', { className: 'wsp-sub' }, '命中测试'),
          h('div', { className: 'wsp-row' },
            h('input', { className: 'wsp-input', value: matchPath, placeholder: '某个会话的工作目录，如 /root/DSHpluginWorkSpace', onChange: (event) => setMatchPath(event.target.value) }),
            btn('测试', testMatch)),
          matchInfo === null || matchInfo === undefined
            ? h('div', { className: 'wsp-meta' }, '填一个目录，按当前清单算出它会挂上什么、凭什么命中——「为什么这个会话没挂上」最快的答案。')
            : matchInfo.hit === true
              ? h('div', {},
                h('div', { className: 'wsp-notice' }, '命中 ' + String(matchInfo.workspace) + '（' + matchText(matchInfo.mode) + '｜'
                  + (matchInfo.by === 'session' ? '按注册表的会话归属命中' : matchInfo.kind === 'member' ? '按本机附加路径命中' : '按主路径命中')
                  + (matchInfo.matchedPath ? '：' + String(matchInfo.matchedPath) : '') + '）'),
                matchInfo.workspaceId !== undefined && matchInfo.workspaceId !== null ? h('div', { className: 'wsp-code' }, '工作区 id：' + String(matchInfo.workspaceId) + '（想让它跨设备一致就按这个 id 绑定）') : null,
                h('div', { className: 'wsp-code' }, (matchInfo.plugins || []).length === 0 ? '（该工作区没有启用中的行）' : '会挂上：\n' + matchInfo.plugins.join('\n')))
              : h('div', {},
                h('div', { className: 'wsp-meta' }, '未命中任何工作区——该目录的会话一行都不会挂。'),
                Array.isArray(matchInfo.hints) && matchInfo.hints.length > 0 ? h('div', { className: 'wsp-notice' }, matchInfo.hints.join('\n')) : null)),

        // ⑤ 活会话挂载明细
        h('div', { className: 'wsp-card' },
          h('div', { className: 'wsp-row' },
            h('span', { className: 'wsp-sub' }, '活会话挂载（' + String(mounts.length) + '）'),
            h('span', { className: 'wsp-spacer' }),
            btn(showDiag ? '收起诊断' : '展开诊断', () => setShowDiag(!showDiag))),
          mounts.length === 0
            ? h('div', { className: 'wsp-meta' }, '当前没有已挂载的会话。新会话命中的瞬间就会挂上（列表随刷新更新）。')
            : h('div', { className: 'wsp-list' }, mounts.map(renderMountRow)),
          showDiag ? renderDiagnostics() : null));
    }

    const inject = ['slots'];

    function apply(ctx) {
      ctx.effect(() => injectStyles(), 'dsh-workspace-plugins: page css');
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'workspace-plugins', order: 30, label: '工作区插件' },
        () => h(WorkspacePluginsPage, {}),
      ));
    }

    exports.inject = inject;
    exports.apply = apply;

    // 供 client-selftest.mjs 无头驱动：纯函数与组件直接可用。
    exports.__ui = {
      css: PAGE_CSS,
      api,
      CLIENT_VERSION,
      withToken,
      STATE_TEXT,
      rowStateText,
      workspaceKeyOf,
      disableKeyOf,
      workspaceTitleOf,
      deviceText,
      meshLine,
      matchText,
      sourceText,
      moduleText,
      sessionLine,
      emptyRow,
      rowToState,
      draftToState,
      stateToRow,
      fileToDraft,
      catalogText,
      hookLayout: ['state', 'draft', 'configDisabled', 'dirty', 'error', 'notice', 'busy', 'probes', 'matchPath', 'matchInfo', 'customPath', 'customMatch', 'showDiag', 'customWorkspaceId', 'customIncludeMembers'],
      Page: WorkspacePluginsPage,
    };
    return module.exports;
  },
});
