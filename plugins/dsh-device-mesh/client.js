/**
 * 设备网格（dsh-device-mesh）— 浏览器半边。
 *
 * 这个文件只依赖 `CONTRACT.md` 里冻结的 HTTP 面，不 import 任何 host 代码
 * （浏览器半边与 host 半边是两套模块系统：这里是 __ModuleLoader__ 的 factory，
 * host 那边是 ESM）。
 *
 * ── 两个注册点，它们的键必须一致 ──────────────────────────────────────────────
 *   `sidebar.panellist` 的 `id`  侧边栏把它渲染成一个面板按钮，点击 =
 *                                `ctx.layout.selectPanel(id)`
 *   `main` 的 `key`              主列按这个键渲染对应面板
 * 出厂侧边栏就是拿 `sidebar.panellist` 的条目 id 去 `selectPanel` 的
 * （dsh-client-ui-sidebar 的 `syncPanels`），所以两处**必须逐字相同**。
 * 写错其中一个的症状是「按钮点了没反应」，而且没有任何报错 —— 记住这一点。
 *
 * ── 数据都是不可信的 ─────────────────────────────────────────────────────────
 * 面板的输入不只是本机：远端设备上报的清单会原样渲染。所以每个字段都当可选值处理，
 * 每台设备外面套一层错误边界 —— 一台对端发来畸形数据，不该把整个面板刷白。
 *
 * ── 为什么远端会话不能点开（但可以「接管」）─────────────────────────────────
 * 会话属于它所在的设备：日志、附件、agent 都在那边。本机没有打开它的能力，
 * 所以点击只复制 id（给「去那台机器上找」用），**不做**假的打开动作。
 *
 * 要看进度、要在这里接着跑，走的是显式动作：本机镜像里有这条会话的实时事件历史，
 * 「接管」把它落成**本机的**会话（host 在线时按字节拉回、离线时用镜像重压），
 * 之后它就出现在本机会话列表里、可以打开续跑。看见 ≠ 能接手，这两件事分开做。
 *
 * 另外，**每次会话跑完一轮**（镜像里出现 `turn/end`）host 会自动同步一次：把上下文
 * 重压落地到本机 `sessions/`。所以执行端平时就持有控制端的历史（本机离线时它还在），
 * 进度行上的「已留在本机」说的就是这件事；「接管」留给「本机那份落后了 / 还没同步过」
 * 的情形 —— 那时它同时是「拉回最新」的动作。
 *
 * @module dsh-device-mesh/client
 */

window.__ModuleLoader__.load({
  id: "dsh-device-mesh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useCallback, useRef, useMemo } = react;

    // ── 路由表：必须与 CONTRACT.md 逐字一致 ──────────────────────────────────
    const R = {
      tree: "/dsh-device-mesh/tree",
      status: "/dsh-device-mesh/status",
      config: "/dsh-device-mesh/config",
      links: "/dsh-device-mesh/links",
      linkTest: "/dsh-device-mesh/links/test",
      linkSync: "/dsh-device-mesh/links/sync",
      tokens: "/dsh-device-mesh/tokens",
      nodes: "/dsh-device-mesh/nodes",
      paths: "/dsh-device-mesh/paths",
      exec: "/dsh-device-mesh/exec",
      browse: "/dsh-device-mesh/browse",
      audit: "/dsh-device-mesh/audit",
      mirror: "/dsh-device-mesh/mirror",
      mirrorBackfill: "/dsh-device-mesh/mirror/backfill",
      sessionPull: "/dsh-device-mesh/session-pull",
      sessionMode: "/dsh-device-mesh/session-mode",
      replicaProgress: "/dsh-device-mesh/replica-progress",
      takeover: "/dsh-device-mesh/takeover",
    };

    const REFRESH_MS = 15000;

    // ── HTTP ────────────────────────────────────────────────────────────────
    /**
     * 调一次本插件自己的同源路由。
     *
     * 失败一律抛出带 `code` 的错误，**不**静默返回空对象：面板上「没数据」和
     * 「请求失败了」是两件事，混在一起会让人以为网格是空的。
     */
    async function api(path, body, method) {
      const init = {
        method: method !== undefined ? method : (body === undefined ? "GET" : "POST"),
        credentials: "same-origin",
        headers: {},
      };
      if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      let res;
      try {
        res = await fetch(path, init);
      } catch (error) {
        const failure = new Error("无法连接到本机插件路由：" + String(error && error.message ? error.message : error));
        failure.code = "network";
        throw failure;
      }
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (!res.ok || (json !== null && json.ok === false)) {
        const failure = new Error(
          json !== null && typeof json.error === "string" ? json.error : "HTTP " + res.status,
        );
        failure.code = json !== null && typeof json.code === "string" ? json.code : null;
        failure.status = res.status;
        // 执行类失败带的上下文（审计编号等）原样带上，面板会显示出来。
        if (json !== null && typeof json === "object") {
          for (const key of ["auditId", "deviceId", "cwd"]) {
            if (json[key] !== undefined) failure[key] = json[key];
          }
        }
        throw failure;
      }
      return json === null ? {} : json;
    }

    // ── 展示小工具 ──────────────────────────────────────────────────────────
    /** 相对时间；坏值回 ""，绝不渲染 "NaN 秒前"。 */
    function relTime(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        if (typeof value === "string") {
          const parsed = Date.parse(value);
          if (Number.isNaN(parsed)) return "";
          return relTime(parsed);
        }
        return "";
      }
      const delta = Date.now() - value;
      if (delta < 0) return "刚刚";
      const sec = Math.floor(delta / 1000);
      if (sec < 60) return sec + " 秒前";
      const min = Math.floor(sec / 60);
      if (min < 60) return min + " 分钟前";
      const hour = Math.floor(min / 60);
      if (hour < 24) return hour + " 小时前";
      const day = Math.floor(hour / 24);
      if (day < 30) return day + " 天前";
      return new Date(value).toLocaleDateString();
    }

    /** 会话的兜底标题：短 id 前缀，**不**显示 "null"。 */
    function sessionTitle(session) {
      if (typeof session.title === "string" && session.title !== "") return session.title;
      const id = typeof session.id === "string" ? session.id : "";
      return id === "" ? "(无标题)" : "(" + id.slice(0, 8) + "…)";
    }

    /** 取路径最后一段做简短显示。 */
    function shortPath(value) {
      if (typeof value !== "string" || value === "") return "";
      const parts = value.split("/").filter((part) => part !== "");
      return parts.length === 0 ? value : parts[parts.length - 1];
    }

    const livenessLabel = { online: "在线", stale: "迟缓", offline: "离线", unknown: "未知" };

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 只用同 profile 其它插件已经用过的主题令牌（--dsw-alias-*），
    // 不发明新名字：写错的令牌不会报错，只会静默变成无效值。
    const CSS = [
      ".dmesh-page { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); font-size: 13px; }",
      ".dmesh-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }",
      ".dmesh-title { font-size: 15px; font-weight: 600; }",
      ".dmesh-sum { font-size: 12px; color: var(--dsw-alias-label-secondary); }",
      ".dmesh-spacer { flex: 1; }",
      ".dmesh-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 9px; font-size: 12px; cursor: pointer; white-space: nowrap; }",
      ".dmesh-btn-sm { padding: 1px 7px; font-size: 11px; }",
      ".dmesh-btn:disabled { opacity: .5; cursor: default; }",
      ".dmesh-ok-block { border: 1px solid var(--dsw-alias-state-success-primary); border-radius: 6px; padding: 7px 10px; margin: 6px 11px 10px; font-size: 12px; color: var(--dsw-alias-state-success-primary); white-space: pre-wrap; }",
      ".dmesh-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }",
      ".dmesh-btn:disabled { opacity: 0.45; cursor: default; }",
      ".dmesh-btn-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }",
      ".dmesh-btn-danger { color: var(--dsw-alias-state-error-primary); }",
      ".dmesh-tabs { display: flex; gap: 4px; padding: 8px 14px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }",
      ".dmesh-tab { border: none; background: transparent; color: var(--dsw-alias-label-secondary); padding: 6px 12px; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; }",
      ".dmesh-tab.on { color: var(--dsw-alias-brand-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }",
      ".dmesh-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 14px 28px; }",
      ".dmesh-search { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 5px 9px; font-size: 12px; margin-bottom: 10px; }",
      ".dmesh-dev { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); margin-bottom: 8px; overflow: hidden; }",
      ".dmesh-dev.denied { opacity: 0.55; }",
      ".dmesh-row { display: flex; align-items: center; gap: 7px; padding: 8px 11px; cursor: pointer; user-select: none; }",
      ".dmesh-row:hover { background: var(--dsw-alias-bg-layer-2); }",
      ".dmesh-caret { width: 11px; flex-shrink: 0; text-align: center; font-size: 10px; color: var(--dsw-alias-label-secondary); }",
      ".dmesh-name { font-weight: 600; }",
      ".dmesh-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }",
      ".dmesh-badge { font-size: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; padding: 0 5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }",
      ".dmesh-badge-brand { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }",
      ".dmesh-badge-warn { color: var(--dsw-alias-state-warning-primary); border-color: var(--dsw-alias-state-warning-primary); }",
      ".dmesh-badge-err { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }",
      ".dmesh-badge-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }",
      ".dmesh-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--dsw-alias-label-secondary); }",
      ".dmesh-dot.online { background: var(--dsw-alias-state-success-primary); }",
      ".dmesh-dot.stale { background: var(--dsw-alias-state-warning-primary); }",
      ".dmesh-dot.offline { background: var(--dsw-alias-state-error-primary); }",
      ".dmesh-ws { border-top: 1px solid var(--dsw-alias-border-l1); }",
      ".dmesh-ws-head { display: flex; align-items: center; gap: 7px; padding: 6px 11px 6px 24px; cursor: pointer; user-select: none; }",
      ".dmesh-ws-head:hover { background: var(--dsw-alias-bg-layer-2); }",
      ".dmesh-sess { display: flex; align-items: center; gap: 7px; padding: 4px 11px 4px 46px; cursor: pointer; }",
      ".dmesh-sess:hover { background: var(--dsw-alias-bg-layer-2); }",
      ".dmesh-sess-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46%; }",
      // 会话权限：标签用 `dmesh-badge` 那套（read-only 走 warn），选择器是一个极简的原生
      // select —— 面板里为它造一套弹层组件不值当，而原生控件在窄侧边栏里也不会跑位。
      ".dmesh-modesel-wrap { display: inline-flex; align-items: center; gap: 4px; flex: none; }",
      ".dmesh-mode-select { font-size: 10px; padding: 0 2px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); max-width: 130px; }",
      ".dmesh-mode-select:hover { border-color: var(--dsw-alias-brand-primary); }",
      ".dmesh-path { font-family: monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".dmesh-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 8px 11px 10px 24px; }",
      // 「属主在别处」的工作区说明块：不渲染成这台的工作区，但必须留下痕迹 ——
      // 直接隐藏会让人以为这些工作区凭空消失了（它们明明刚在另一台名下出现过）。
      ".dmesh-foreign { border-top: 1px dashed var(--dsw-alias-border-l1); padding: 7px 11px 9px 24px; font-size: 12px; color: var(--dsw-alias-label-secondary); }",
      ".dmesh-foreign-row { display: flex; align-items: baseline; gap: 6px; padding: 2px 0 0 14px; font-size: 11px; }",
      ".dmesh-foreign-row .dmesh-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 52%; }",
      // 合并提示：会话来自多台设备时说明一句（否则「属主那台下挂着别台的会话」看着突兀）。
      ".dmesh-merge-hint { padding: 8px 11px 4px 46px; }",
      ".dmesh-err { border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 6px; padding: 7px 10px; margin: 6px 11px 10px; font-size: 12px; color: var(--dsw-alias-state-error-primary); }",
      ".dmesh-note { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.65; margin: 0 0 9px; }",
      ".dmesh-table { width: 100%; border-collapse: collapse; font-size: 12px; }",
      ".dmesh-table th { text-align: left; font-weight: 600; color: var(--dsw-alias-label-secondary); padding: 5px 7px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 11px; }",
      ".dmesh-table td { padding: 5px 7px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: middle; }",
      ".dmesh-form { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0 14px; padding: 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }",
      ".dmesh-in { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 5px; padding: 4px 7px; font-size: 12px; min-width: 110px; }",
      ".dmesh-in-wide { flex: 1; min-width: 220px; }",
      ".dmesh-in-mono { font-family: monospace; }",
      ".dmesh-out { border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-base); padding: 7px 9px; margin-top: 7px; font-family: monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto; }",
      ".dmesh-out-err { color: var(--dsw-alias-state-error-primary); }",
      ".dmesh-ok { color: var(--dsw-alias-state-success-primary); font-size: 12px; }",
      ".dmesh-secret { font-family: monospace; font-size: 11px; word-break: break-all; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-brand-primary); border-radius: 6px; padding: 7px 9px; margin: 6px 0; }",
      ".dmesh-warnbox { border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 6px; padding: 7px 10px; margin-bottom: 10px; font-size: 12px; color: var(--dsw-alias-state-error-primary); }",
      ".dmesh-group { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); padding: 9px 11px; margin-bottom: 8px; }",
      ".dmesh-grow { flex: 1; }",
      ".dmesh-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-left: 6px; }",
      // ── 侧边栏「远程工作区」段 ────────────────────────────────────────────
      // 逐条照抄出厂 Rows 的度量（projectRow/sessionRow/slot/title/time/rowActions）
      // 只换前缀：远程工作区在侧边栏里必须和本机工作区**长得一样**，
      // 区分只靠两处标示 —— 工作区名称后的 `· 设备名`，以及每条远端会话上的
      // `⇄设备名` 小标签。
      // 这一块渲染在**出厂会话列表内部**（role="tree" / aria-label=section.sessions）
      // —— 也就是「工作区下面那块真的会话选择区」，所以它要跟着列表一起滚动，
      // 并与出厂分组保持同样的 4px 组间距。
      ".dmesh-rw-list { display: flex; flex-direction: column; margin-top: 4px; }",
      ".dmesh-rw-group { display: flex; flex-direction: column; }",
      ".dmesh-rw-row { cursor: pointer; user-select: none; color: var(--dsw-alias-label-primary); border-radius: 8px; align-items: center; gap: 6px; padding: 0 8px; padding-inline-start: calc(8px + var(--dsh-workspace-indent, 0px)); display: flex; }",
      ".dmesh-rw-row:hover { background: var(--dsw-alias-interactive-bg-hover); }",
      ".dmesh-rw-project { box-sizing: border-box; height: 34px; }",
      ".dmesh-rw-session { height: 32px; gap: 0; }",
      ".dmesh-rw-session .dmesh-rw-title { flex: 1; margin: 0 6px 0 4px; }",
      ".dmesh-rw-slot { width: 16px; height: 20px; color: var(--dsw-alias-label-tertiary); flex: none; justify-content: center; align-items: center; display: inline-flex; }",
      ".dmesh-rw-project .dmesh-rw-chevron { display: none; }",
      ".dmesh-rw-project:hover .dmesh-rw-chevron { display: inline-flex; }",
      ".dmesh-rw-project:hover .dmesh-rw-folder { display: none; }",
      ".dmesh-rw-folderActive { color: var(--dsw-alias-state-business-primary); }",
      ".dmesh-rw-arrow { transition: transform .15s var(--ds-ease-in-out); }",
      ".dmesh-rw-arrowOpen { transform: rotate(90deg); }",
      ".dmesh-rw-projectText { flex-direction: column; flex: 1; gap: 2px; min-width: 0; display: flex; }",
      ".dmesh-rw-titleline { display: flex; align-items: center; gap: 4px; min-width: 0; }",
      ".dmesh-rw-title { text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-size: 14px; line-height: 20px; overflow: hidden; }",
      // 转发执行标示与设备名都不参与截断：标题再长也要看得见「在哪执行」。
      ".dmesh-rw-net { flex: none; display: inline-flex; align-items: center; color: var(--dsw-alias-brand-primary); }",
      ".dmesh-rw-dev { flex: none; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }",
      ".dmesh-rw-extra { flex: none; font-size: 10px; line-height: 16px; padding: 0 4px; margin-left: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; color: var(--dsw-alias-label-tertiary); }",
      ".dmesh-rw-off { color: var(--dsw-alias-state-warning-primary); }",
      // 远端会话标示：小、可截断，落在标题与时间之间；悬停时不随时间去隐藏。
      ".dmesh-rw-devtag { flex: none; max-width: 38%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; line-height: 16px; padding: 0 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; color: var(--dsw-alias-label-tertiary); }",
      ".dmesh-rw-time { color: var(--dsw-alias-label-tertiary); flex: none; font-size: 12px; line-height: 20px; }",
      ".dmesh-rw-session:hover .dmesh-rw-time { display: none; }",
      ".dmesh-rw-rowActions { flex: none; align-items: center; gap: 12px; display: none; }",
      ".dmesh-rw-row:hover .dmesh-rw-rowActions { display: inline-flex; }",
      ".dmesh-rw-iconButton { cursor: pointer; width: 16px; height: 16px; color: var(--dsw-alias-label-tertiary); background: 0 0; border: none; border-radius: 4px; flex: none; justify-content: center; align-items: center; padding: 0; display: inline-flex; }",
      ".dmesh-rw-iconButton:hover { color: var(--dsw-alias-label-primary); }",
      ".dmesh-rw-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }",
      ".dmesh-rw-dot.on { background: var(--dsw-alias-state-success-primary); }",
      ".dmesh-rw-count { flex: none; font-size: 11px; line-height: 20px; color: var(--dsw-alias-state-success-primary); }",
      ".dmesh-rw-sessions { --dsh-workspace-indent: 12px; display: flex; flex-direction: column; }",
      ".dmesh-rw-sessions > * + * { margin-top: 2px; }",
      ".dmesh-rw-note { color: var(--dsw-alias-label-tertiary); padding: 2px 12px 4px calc(8px + var(--dsh-workspace-indent, 0px) + 16px); font-size: 12px; line-height: 18px; }",
      ".dmesh-remote-err { font-size: 11px; color: var(--dsw-alias-state-error-primary); padding: 4px 8px; }",
      // ── 执行端标示（本机是属主/执行侧）────────────────────────────────────
      // 说的是**反方向**的事：会话（agent）在远端那台跑，命令与文件落在本机执行。
      // 因此它必须与 `.dmesh-rw-net`（转发执行：文件/命令在别处）一眼可分：
      //   · 独立 class + 独立 ⇄ 图标，不共用地球图标；
      //   · 琥珀/警示色 —— 这是「随时可能有命令落到本机」的安全提示，不是导航信息。
      // 尺寸只占标题行里的一格（flex:none），不参与截断、不改变行高/内边距/字号。
      ".dmesh-driver-mark { flex: none; display: inline-flex; align-items: center; color: var(--dsw-alias-state-warning-primary); }",
      ".dmesh-driver-mark svg { display: block; }",
      // 会话小标签的警示态：这条远端会话已经在往本机发命令了（不是「可能」）。
      ".dmesh-rw-devtagWarn { color: var(--dsw-alias-state-warning-primary); border-color: var(--dsw-alias-state-warning-primary); }",
      // ── 镜像进度（执行端视角）──────────────────────────────────────────────
      // 会话在别处跑，本机只看到镜像。进度行就是「那台在干什么」的唯一线索，所以它
      // 独占一行、不参与截断（标题行该截还是截）。两种「在动」分开配色：
      //   · on（绿）  = 对端清单说 agent 正在跑（真有人在干活）；
      //   · warm（琥珀）= 镜像最近还在收到事件（数据新鲜，但 agent 可能在等输入）。
      ".dmesh-prog { display: flex; align-items: center; gap: 5px; min-width: 0; }",
      ".dmesh-prog-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary); }",
      ".dmesh-prog-dot.on { background: var(--dsw-alias-state-success-primary); }",
      ".dmesh-prog-dot.warm { background: var(--dsw-alias-state-warning-primary); }",
      ".dmesh-prog-text { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      // 侧边栏那条远端会话行：有进度时两行（标题 + 进度），没有进度时维持出厂的 32px。
      ".dmesh-rw-sessionTall { height: auto; min-height: 32px; padding-top: 4px; padding-bottom: 4px; }",
      ".dmesh-rw-sessBody { flex: 1; min-width: 0; margin: 0 6px 0 4px; display: flex; flex-direction: column; gap: 1px; }",
      ".dmesh-rw-sessLine { display: flex; align-items: center; gap: 6px; min-width: 0; }",
      ".dmesh-rw-sessLine .dmesh-rw-title { margin: 0; }",
      // 面板里那条会话：进度行缩进到与标题同一条线（与侧边栏同一套度量）。
      ".dmesh-sess-wrap { display: flex; flex-direction: column; }",
      ".dmesh-sess-prog { padding: 0 11px 4px 46px; }",
      // 接管按钮 + 就地回执（不占标题行、不改变行高）。
      ".dmesh-takeover { flex: none; display: inline-flex; align-items: center; gap: 6px; }",
      ".dmesh-ok-inline { color: var(--dsw-alias-state-success-primary); font-size: 11px; }",
      ".dmesh-err-inline { color: var(--dsw-alias-state-error-primary); font-size: 11px; }",
    ].join("\n");

    function injectStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById("dsh-device-mesh/css") !== null) return;
      const tag = document.createElement("style");
      tag.id = "dsh-device-mesh/css";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── 图标（内联 SVG，不引第三方图标库）──────────────────────────────────
    function MeshGlyph(props) {
      const size = typeof props.size === "number" ? props.size : 18;
      const color = props.active ? "var(--dsw-alias-brand-primary)" : "currentColor";
      return h("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: color, strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true",
      }, [
        h("circle", { key: "a", cx: 12, cy: 5, r: 2.6 }),
        h("circle", { key: "b", cx: 5, cy: 18, r: 2.6 }),
        h("circle", { key: "c", cx: 19, cy: 18, r: 2.6 }),
        h("path", { key: "d", d: "M12 7.6v3.4M12 11l-5.4 4.6M12 11l5.4 4.6" }),
      ]);
    }

    function DeviceGlyph(props) {
      const kind = props.kind === "desktop" || props.kind === "server" ? props.kind : "unknown";
      const size = 14;
      if (kind === "desktop") {
        return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 },
          [h("rect", { key: "r", x: 3, y: 5, width: 18, height: 11, rx: 1.5 }), h("path", { key: "s", d: "M9 20h6M12 16v4" })]);
      }
      if (kind === "server") {
        return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 },
          [h("rect", { key: "r1", x: 3, y: 4, width: 18, height: 6, rx: 1.5 }), h("rect", { key: "r2", x: 3, y: 14, width: 18, height: 6, rx: 1.5 })]);
      }
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 },
        [h("circle", { key: "c", cx: 12, cy: 12, r: 8 })]);
    }

    // ── 侧边栏行图标（与出厂 @deepseek-ai/dsh-client-ui-primitives 同形）──────
    // 侧边栏的远程工作区要和本机工作区**长得一模一样**，所以这些图标直接内联出厂
    // 的 artwork 路径（16×16 viewBox，currentColor），而不是另画一套近似的：
    // 颜色/尺寸由外层 .dmesh-rw-slot / .dmesh-rw-iconButton 控制，和出厂一致。
    function FolderCloseIcon() {
      return h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", strokeWidth: 1 },
        [h("path", { key: "a", d: "M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z", stroke: "currentColor" }),
          h("path", { key: "b", d: "M3.63501 7.66614H12.3647", stroke: "currentColor" })]);
    }
    function FolderOpenIcon() {
      return h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", strokeWidth: 1 },
        [h("path", { key: "a", d: "M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z", fill: "currentColor", opacity: "0.16" }),
          h("path", { key: "b", d: "M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z", fill: "currentColor" }),
          h("path", { key: "c", d: "M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z", fill: "currentColor" })]);
    }
    function TriangleRightIcon(props) {
      return h("svg", {
        width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true",
        className: props && props.className ? props.className : undefined,
      }, h("path", { d: "M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z", fill: "currentColor" }));
    }
    /** 「转发执行」标示：命令与文件在另一台设备上执行的工作区。 */
    function NetworkIcon() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", strokeWidth: 1 },
        [h("circle", { key: "c", cx: 8, cy: 8, r: 5.9, stroke: "currentColor" }),
          h("ellipse", { key: "e", cx: 8, cy: 8, rx: 2.7, ry: 5.9, stroke: "currentColor" }),
          h("path", { key: "l1", d: "M2.35 6H13.65", stroke: "currentColor" }),
          h("path", { key: "l2", d: "M2.35 10H13.65", stroke: "currentColor" })]);
    }
    /**
     * 「命令进来」标示：⇄ —— 与 `NetworkIcon` 方向相反。
     * 为什么不用地球图标：地球说的是「这个工作区在网络上、文件在别处」；这里说的是
     * 「agent 在别处、命令会落到本机」。两张图必须一眼分得开，否则用户按错方向理解。
     */
    function DriverIcon() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", strokeWidth: 1 },
        [h("path", { key: "a", d: "M1.75 5.25H12.25M9.75 2.75L12.25 5.25L9.75 7.75", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" }),
          h("path", { key: "b", d: "M14.25 10.75H3.75M6.25 8.25L3.75 10.75L6.25 13.25", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" })]);
    }
    function CopyIcon() {
      return h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", strokeWidth: 1 },
        [h("rect", { key: "a", x: 5.75, y: 5.75, width: 8.5, height: 8.5, rx: 1.5, stroke: "currentColor" }),
          h("path", { key: "b", d: "M10.25 3.75V3.5C10.25 2.67157 9.57843 2 8.75 2H3.5C2.67157 2 2 2.67157 2 3.5V8.75C2 9.57843 2.67157 10.25 3.5 10.25H3.75", stroke: "currentColor" })]);
    }

    // ── 错误边界 ────────────────────────────────────────────────────────────
    /**
     * 一台设备外面套一层：远端清单是不可信输入，一条畸形数据不该把整个面板刷白。
     * 用类组件是因为 React 只有 `getDerivedStateFromError` 这一个错误边界协议，
     * 没有 hook 版本。
     */
    const Component = react.Component;
    const Boundary = typeof Component === "function"
      ? class extends Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }

        static getDerivedStateFromError(error) {
          return { error };
        }

        render() {
          if (this.state.error !== null) {
            return h("div", { className: "dmesh-err" },
              "这台设备的数据无法渲染：" + String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error));
          }
          return this.props.children;
        }
      }
      // React 的错误边界只有类组件这一条协议。万一宿主给的 React 命名空间里没有
      // Component，宁可退化成「不做隔离」也不要让整个面板因为找不到基类而崩掉 ——
      // 隔离是加固，不是主功能。
      : (props) => (props && props.children !== undefined ? props.children : null);

    // ── 通用小组件 ──────────────────────────────────────────────────────────
    const Badge = (props) => h("span", { className: "dmesh-badge" + (props.kind ? " dmesh-badge-" + props.kind : "") }, props.children);
    const Dot = (props) => h("span", { className: "dmesh-dot " + (livenessLabel[props.liveness] ? props.liveness : "unknown"), title: livenessLabel[props.liveness] || "未知" });
    const Row = (props) => h("div", { className: props.className || "dmesh-row", onClick: props.onClick, title: props.title }, props.children);

    /** 标题行 + 可折叠主体。 */
    function Collapsible(props) {
      const caret = props.open ? "▾" : "▸";
      return h("div", { className: props.className }, [
        h("div", { key: "head", className: props.headClass, onClick: props.onToggle },
          [h("span", { key: "c", className: "dmesh-caret" }, caret)].concat(props.head)),
        props.open ? props.children : null,
      ]);
    }

    // ── 工作区归属：属主在别处的工作区不记在这台名下 ──────────────────────────
    //
    // 互联会话的 cwd 落在**属主那台**的路径上，于是会话端本机注册表也把这些工作区记了
    // 一份（xray4668 报的那 4 个就是）。host 会给这类条目打上 `ownerDeviceId`
    // （声明的属主是另一台设备）；面板据此把工作区归到属主名下、把会话**合并**过去。
    // 没有这个字段 = 老 host 或本机就是属主 —— 两种都按「这台自己的」处理，
    // 所以没有声明的部署行为与改动前逐字一致。

    /**
     * 一条工作区条目声明的属主设备 id（空串 = 归报告它的那台）。
     * @param {object} workspace 工作区条目。
     * @returns {string} 属主设备 id。
     */
    function declaredOwnerOf(workspace) {
      return workspace !== null && workspace !== undefined && typeof workspace.ownerDeviceId === "string"
        ? workspace.ownerDeviceId
        : "";
    }

    /**
     * 设备 id → 显示名（树里查不到就退回 id 本身）。
     * @param {object} tree /tree 的内层树。
     * @param {string} deviceId 设备 id。
     * @returns {string} 显示名。
     */
    function deviceNameOf(tree, deviceId) {
      const devices = Array.isArray(tree?.devices) ? tree.devices : [];
      const hit = devices.find((device) => device !== null && device !== undefined && device.deviceId === deviceId);
      if (hit !== undefined && typeof hit.name === "string" && hit.name !== "") return hit.name;
      return typeof deviceId === "string" ? deviceId : "";
    }

    /**
     * 合并同一个工作区在**所有设备**上的会话账目。
     *
     * 为什么必须合并：工作区归到属主名下之后，会话端那份账目如果没有跟过去，
     * 「xray4668 的 1194 条会话」就会因为工作区被挪走而整段消失 —— 用户看到的是
     * 工作区还在、里面的会话凭空少了一半。
     *
     * **只在确实有属主声明指向本设备时才合并**：没有声明（老 host / 纯本地部署）时返回
     * `null`，调用方走原来的单设备账目，渲染结果与改动前逐字一致。
     *
     * 去重按 **session id**：同一台机器可能既在本机账目里、又在驱动端账目里出现
     * （`presentLocally` 那种），只留先出现的那份（树顺序里本机在前）。
     *
     * @param {object} tree /tree 的内层树。
     * @param {object} workspace 本设备清单里的这条工作区。
     * @param {string} deviceId 本设备 id。
     * @returns {{rows: {session: object, deviceId: string, deviceName: string, self: boolean}[], deviceCount: number, dropped: number, live: number}|null} 合并结果；不需要合并时为 null。
     */
    function mergeWorkspaceSessions(tree, workspace, deviceId) {
      const devices = Array.isArray(tree?.devices) ? tree.devices : [];
      if (devices.length === 0) return null;
      const wantedId = typeof workspace?.id === "string" ? workspace.id : "";
      const wantedPath = typeof workspace?.path === "string" ? workspace.path : "";
      if (wantedId === "" && wantedPath === "") return null;
      /** 同一个工作区：先按 id 认，认不出来再按路径（对端另建了工作区指向同一目录）。 */
      const sameWorkspace = (entry) => entry !== null && entry !== undefined
        && ((wantedId !== "" && entry.id === wantedId) || (wantedPath !== "" && entry.path === wantedPath));
      const contributors = [];
      for (const device of devices) {
        const list = Array.isArray(device?.inventory?.workspaces) ? device.inventory.workspaces : [];
        const entry = list.find(sameWorkspace);
        if (entry !== undefined) contributors.push({ device, entry });
      }
      // 没有任何一条把属主指向本设备 → 这不是「属主那一行」，不合并（老行为）。
      const claimed = contributors.some((item) => declaredOwnerOf(item.entry) === deviceId);
      if (!claimed) return null;
      const seen = new Set();
      const rows = [];
      let dropped = 0;
      let live = 0;
      for (const item of contributors) {
        dropped += Math.max(0, Number(item.entry.droppedSessions) || 0);
        live += Math.max(0, Number(item.entry.liveCount) || 0);
        for (const session of Array.isArray(item.entry.sessions) ? item.entry.sessions : []) {
          const id = typeof session?.id === "string" ? session.id : "";
          if (id === "" || seen.has(id)) continue;
          seen.add(id);
          rows.push({
            session,
            deviceId: typeof item.device.deviceId === "string" ? item.device.deviceId : "",
            deviceName: typeof item.device.name === "string" && item.device.name !== "" ? item.device.name : "(未命名设备)",
            self: item.device.self === true,
          });
        }
      }
      return { rows, deviceCount: contributors.length, dropped, live };
    }

    /**
     * 「属主在别处」的工作区说明行（按属主分组，一台一行）。
     *
     * 为什么不直接隐藏：隐藏之后用户会以为这些工作区不存在（它们明明刚在别的名下出现过），
     * 也会怀疑「我刚看到的那几个工作区去哪了」。所以显式说明它们归谁、去哪找。
     * @param {{workspaces: object[], tree: object}} props 参数。
     * @returns {object|null} 元素。
     */
    function ForeignWorkspacesNote(props) {
      const list = Array.isArray(props.workspaces) ? props.workspaces : [];
      if (list.length === 0) return null;
      const byOwner = new Map();
      for (const workspace of list) {
        const ownerId = declaredOwnerOf(workspace);
        const declaredName = typeof workspace.ownerDeviceName === "string" && workspace.ownerDeviceName !== ""
          ? workspace.ownerDeviceName
          : "";
        const name = declaredName !== "" ? declaredName : (deviceNameOf(props.tree, ownerId) || "(未知设备)");
        if (!byOwner.has(ownerId)) byOwner.set(ownerId, { name, titles: [] });
        byOwner.get(ownerId).titles.push(typeof workspace.title === "string" && workspace.title !== "" ? workspace.title : "(未命名工作区)");
      }
      return h("div", { key: "foreign", className: "dmesh-foreign" }, [
        h("div", { key: "head" }, [
          h(Badge, { key: "b", kind: "warn" }, "属主在别处"),
          h("span", { key: "t" }, " 这台名下另有 " + list.length + " 个工作区的文件与命令在别的设备上，已归到那台"),
        ]),
      ].concat([...byOwner.entries()].map(([ownerId, entry], index) => h("div", {
        key: ownerId || "owner-" + index,
        className: "dmesh-foreign-row",
      }, [
        h("span", { key: "n", className: "dmesh-name", title: entry.titles.join("、") }, entry.titles.join("、")),
        h("span", { key: "a" }, " → 属主 " + entry.name + "（会话也合并在那台名下）"),
      ]))));
    }

    // ── 总览：设备 → 工作区 → 会话 ──────────────────────────────────────────
    /** 会话权限的三种取值（与出厂 `dsh-sandbox-policy` 逐字一致）。 */
    const MESH_MODES = ["read-only", "workspace-write", "danger-full-access"];
    /** 给人看的一句话（标签上仍显示原始取值，精确、且与配置同一套词）。 */
    const MODE_HINT = {
      "read-only": "只读：读放行，写一律拒绝",
      "workspace-write": "限工作区：写只允许在会话自己的工作区之内",
      "danger-full-access": "完全访问：属主上任意路径",
    };

    /**
     * 一条会话的权限标签。
     *
     * **读不到 `mode` 就什么都不画**：显示一个猜出来的权限比不显示更糟（老 host 也没有
     * 这个字段）。`read-only` 用警示色 —— 它是唯一会拒绝写入的档。
     */
    function ModeTag(props) {
      const mode = typeof props.mode === "string" && MESH_MODES.indexOf(props.mode) >= 0 ? props.mode : "";
      if (mode === "") return null;
      return h("span", {
        // `dmesh-mode-tag` 是**给自测与样式用的稳定钩子**：`dmesh-badge` 那套是通用外观，
        // 但「这条会话有权限标签」这件事必须能被精确地数出来（别的徽标也在用 badge）。
        className: "dmesh-badge dmesh-mode-tag" + (mode === "read-only" ? " dmesh-badge-warn" : ""),
        title: "会话权限：" + (MODE_HINT[mode] || mode) + "\n改完立刻生效：下一次转发的请求就带新权限（属主照它执行）",
      }, mode);
    }

    /**
     * 会话权限的三选一。
     *
     * 为什么要给控件：权限的**权威在会话所在这台**，但两边都该能改 —— 属主侧看到的是
     * 「别人正在我这里以什么权限跑」，会话端看到的是「我自己这条会话」。提交走
     * `POST /dsh-device-mesh/session-mode`：host 先看会话在不在本机（就地改），否则**一跳**
     * 转发到会话所在的那台。失败时把**对端的原话**显示出来，不吞。
     */
    function ModeSelect(props) {
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const mode = typeof props.mode === "string" && MESH_MODES.indexOf(props.mode) >= 0 ? props.mode : "";
      const change = async (next) => {
        if (busy || next === mode) return;
        setBusy(true);
        setError(null);
        try {
          const result = await api(R.sessionMode, {
            sessionId: props.sessionId,
            mode: next,
            deviceId: props.deviceId,
            path: props.path,
          }, "POST");
          props.onChanged(typeof result?.mode === "string" ? result.mode : next);
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };
      return h("span", { className: "dmesh-modesel-wrap" }, [
        h("select", {
          key: "sel",
          className: "dmesh-mode-select",
          value: mode,
          disabled: busy,
          title: error !== null ? error : "改这条会话的权限（会话端是权威，两边显示与执行都会跟着变）",
          onClick: (event) => { event.stopPropagation(); },
          onChange: (event) => { event.stopPropagation(); void change(event.target.value); },
        }, MESH_MODES.map((one) => h("option", { key: one, value: one }, one))),
        error !== null ? h("span", { key: "err", className: "dmesh-err-inline", title: error }, "改权限失败") : null,
      ]);
    }

    function SessionLine(props) {
      const session = props.session || {};
      const [copied, setCopied] = useState(false);
      // 把对端这条会话的历史拉回本机（填本机空桩）。
      // 为什么值得一个按钮：真实日志在对端的会话，本机那份只有一个会话头 —— 出厂
      // composer 的「上下文占用」按钮要的 request/context 与 usage 都在日志里，没有
      // 日志它就永远不渲染。拉回来之后本机会话完整、可打开，按钮随投影一起出现。
      const [pulling, setPulling] = useState(false);
      const [pulled, setPulled] = useState(null);
      const remote = props.deviceId !== undefined && props.deviceId !== null && props.deviceId !== "" && props.self !== true;
      const pull = async () => {
        const id = typeof session.id === "string" ? session.id : "";
        if (id === "" || pulling) return;
        setPulling(true);
        setPulled(null);
        try {
          const result = await api(R.sessionPull, { sessionId: id, deviceId: props.deviceId }, "POST");
          setPulled(result);
        } catch (failure) {
          setPulled({ error: failure.message || String(failure) });
        } finally {
          setPulling(false);
        }
      };
      const copy = () => {
        const id = typeof session.id === "string" ? session.id : "";
        if (id === "") return;
        // 远端会话在本机打不开（日志、附件、agent 都在对端），所以只复制 id，
        // 让用户拿去那台机器上找 —— 做一个「点了没反应」的假打开更糟。
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) void navigator.clipboard.writeText(id);
          else {
            const area = document.createElement("textarea");
            area.value = id;
            document.body.appendChild(area);
            area.select();
            document.execCommand("copy");
            document.body.removeChild(area);
          }
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          setCopied(false);
        }
      };
      // 执行端标示：这条会话所在的设备就是网格里的某台对端，行为上是谁在执行由
      // driverSessionTag 判方向（与侧边栏复用同一套文案/class）。
      const deviceName = typeof props.deviceName === "string" && props.deviceName !== ""
        ? props.deviceName
        : (typeof props.deviceLabel === "string" ? props.deviceLabel : "");
      const tag = driverSessionTag(props.tree, session, deviceName, props.localOwner === true);
      const badges = [];
      if (session.origin === "subagent") badges.push(h(Badge, { key: "sub" }, "子代理"));
      if (session.archived === true) badges.push(h(Badge, { key: "arch" }, "已归档"));
      if (session.seeded === true) badges.push(h(Badge, { key: "seed" }, "分叉"));
      if (session.inferred === true) {
        badges.push(h(Badge, {
          key: "inf",
          kind: "warn",
        }, "推断归属"));
      }
      // 本机镜像里的进度（执行端视角）：这条会话在别处跑，本机只看到镜像。
      const { rows: progressRows } = useReplicaProgress();
      const progress = progressFor(progressRows, typeof session.id === "string" ? session.id : "");
      // ── 会话权限：显示 + 必要时可改 ────────────────────────────────────────
      // 显示用清单里的 `mode`（读不到就没有这个字段 → 不画）。改过之后先用本地回显顶着，
      // 直到清单刷新到新值（否则轮询的下一拍会把刚改的值闪回旧的）。
      const listedMode = typeof session.mode === "string" && MESH_MODES.indexOf(session.mode) >= 0 ? session.mode : "";
      const [modeEcho, setModeEcho] = useState(null);
      const shownMode = modeEcho !== null && modeEcho.mode !== listedMode ? modeEcho.mode : listedMode;
      const sessionId = typeof session.id === "string" ? session.id : "";
      const deviceOnline = (() => {
        const devices = Array.isArray(props.tree?.devices) ? props.tree.devices : [];
        const hit = devices.find((device) => device.deviceId === props.deviceId);
        return hit === undefined ? null : hit.liveness === "online";
      })();
      // 能改的两种情况：这条会话就跑在本机（agent 在这台、且活着），或它在直连的对端且那台在线。
      // 其余一律不给控件 —— 摆一个注定失败的按钮比不摆更糟。
      const canChangeMode = sessionId !== "" && shownMode !== "" && (
        props.self === true ? session.live === true : deviceOnline === true
      );
      return h("div", { key: "sess-wrap", className: "dmesh-sess-wrap" }, [
        h(Row, {
          key: "row",
          className: "dmesh-sess",
          onClick: copy,
          title: [
            typeof session.id === "string" ? session.id : "",
            session.inferred === true ? "归属是按 cwd 前缀推断的（不是工作区账目的权威成员）" : "",
            "点击复制会话 id",
          ].filter(Boolean).join("\n"),
        }, [
          session.live === true ? h(Dot, { key: "d", liveness: "online" }) : h("span", { key: "d", className: "dmesh-dot", style: { opacity: 0.25 } }),
          h("span", { key: "t", className: "dmesh-sess-title" }, sessionTitle(session)),
          // 与侧边栏同一个会话标示组件/class：面板里这条会话是「谁在执行」也要看得见。
          tag === null ? null : h(DriverSessionTag, { key: "driver", tag }),
          h("span", { key: "time", className: "dmesh-meta" }, relTime(session.lastActivityAt ?? session.createdAt)),
          h("span", { key: "grow", className: "dmesh-grow" }),
          badges,
          // 权限：标签永远画（读得到才画）；选择器只在「确实改得动」时出现。
          h(ModeTag, { key: "mode", mode: shownMode }),
          canChangeMode
            ? h(ModeSelect, {
              key: "modesel",
              mode: shownMode,
              sessionId,
              deviceId: props.deviceId,
              path: typeof session.cwd === "string" ? session.cwd : "",
              onChanged: (next) => setModeEcho({ mode: next, at: Date.now() }),
            })
            : null,
          copied ? h("span", { key: "copied", className: "dmesh-ok" }, "已复制") : null,
          // 能接管时给「接管」（它同时把历史落到本机，见 TakeoverButton）；已经自动同步到
          // 本机的会话不再摆它（上下文已经在本地了）；旧版 host 没有接管路由时保留原来的
          // 「拉回历史」。
          remote && progress !== null && progress.canTakeover === true && progress.synced !== true
            ? h(TakeoverButton, {
              key: "take",
              row: progress,
              sessionId: typeof session.id === "string" ? session.id : "",
              deviceId: props.deviceId,
            })
            : remote
              ? h("button", {
                key: "pull",
                type: "button",
                className: "dmesh-btn dmesh-btn-sm",
                disabled: pulling,
                title: "把这条会话的完整历史从该设备拉回本机（填掉本机空桩）。拉回来后重新打开会话，就能看到历史与「上下文占用」按钮。",
                onClick: (event) => { event.stopPropagation(); void pull(); },
              }, pulling ? "拉取中…" : "拉回历史")
              : null,
          typeof session.cwd === "string" && session.cwd !== ""
            ? h("span", { key: "cwd", className: "dmesh-path", title: session.cwd }, shortPath(session.cwd))
            : null,
        ].concat(
          pulled === null ? [] : [
            h("div", {
              key: "pulled",
              className: pulled.error !== undefined ? "dmesh-err" : "dmesh-ok-block",
            }, pulled.error !== undefined
              ? "拉取失败：" + pulled.error
              : `已拉回 ${pulled.bytes} 字节（${pulled.chunks} 块，${pulled.version}）→ ${pulled.path}。重新打开该会话即可看到完整历史。`),
          ],
        )),
        // 进度行独占一行：它是「最近在干什么」，塞进标题行只会把标题挤没。
        progressParts(progress).length === 0
          ? null
          : h("div", { key: "prog", className: "dmesh-sess-prog" }, h(ProgressLine, { row: progress })),
      ]);
    }

    /** 工作区：标题行 + 附加路径 + 会话列表。 */
    function WorkspaceBlock(props) {
      const workspace = props.workspace || {};
      const group = props.group || null;
      const deviceId = props.deviceId;
      const self = props.self === true;
      const deviceName = typeof props.deviceName === "string" ? props.deviceName : "";
      const ownSessions = Array.isArray(workspace.sessions) ? workspace.sessions : [];
      // 会话合并（见 mergeWorkspaceSessions）：属主那一行要把**所有设备**为同一个工作区
      // 报的会话都列出来，否则工作区挪到属主名下之后，会话端那一批会话会整段消失。
      // 返回 null = 没有属主声明 → 走原来的单设备账目（与改动前逐字一致）。
      const merged = mergeWorkspaceSessions(props.tree, workspace, deviceId);
      const sessions = merged !== null ? merged.rows.map((row) => row.session) : ownSessions;
      const dropped = merged !== null ? merged.dropped : (Number(workspace.droppedSessions) || 0);
      const liveCount = merged !== null ? merged.live : workspace.liveCount;
      const members = group !== null && Array.isArray(group.members) ? group.members : [];
      // 本机属主：本机自己的设备块当然算，或 drivers 判出 owner 是本机。
      // 两者都说明这个工作区里的会话可能是从别处驱动、命令落到本机。
      const localOwner = self || workspaceOwnerIsSelf(props.tree, workspace);
      const execMark = driverWorkspaceMark(props.tree, { workspaceId: workspace.id, path: workspace.path });
      // 「属主在别处、但属主那台当前没上报」——这种工作区**留在本行**（挪走会让会话整段
      // 消失），但必须标明它到底归谁、以及为什么还在这儿。
      const keptOwnerId = declaredOwnerOf(workspace);
      const keptByForeignOwner = keptOwnerId !== "" && keptOwnerId !== deviceId;
      const keptOwnerName = keptByForeignOwner ? deviceNameOf(props.tree, keptOwnerId) : "";
      return h(Collapsible, {
        className: "dmesh-ws",
        open: props.open,
        onToggle: props.onToggle,
        headClass: "dmesh-ws-head",
        head: [
          h("span", { key: "t", className: "dmesh-name" }, typeof workspace.title === "string" && workspace.title !== "" ? workspace.title : "(未命名工作区)"),
          // 执行端标示紧跟工作区名：面板里标题不会截断，这一格不会丢。
          h(DriverMark, { key: "driver", mark: execMark }),
          keptByForeignOwner
            ? h(Badge, {
              key: "ownerelsewhere",
              kind: "warn",
              title: "这个工作区的属主是 " + keptOwnerName + "，但那台当前没有上报它 —— 先列在这里，不把会话藏起来",
            }, "属主 " + keptOwnerName + " 暂未上报")
            : null,
          h("span", { key: "c", className: "dmesh-meta" }, sessions.length + " 会话"),
          liveCount > 0 ? h(Badge, { key: "live", kind: "ok" }, liveCount + " 活跃") : null,
          dropped > 0 ? h(Badge, { key: "drop", kind: "warn" }, "另有 " + dropped + " 条未列出") : null,
          h("span", { key: "grow", className: "dmesh-grow" }),
          typeof workspace.path === "string" && workspace.path !== ""
            ? h("span", { key: "p", className: "dmesh-path", title: workspace.path }, workspace.path)
            : null,
        ],
      }, [
        // 附加路径：主路径永远是可执行的目标；附加路径可能落在别的设备上。
        members.length > 0
          ? h("div", { key: "members", className: "dmesh-empty" },
            members.map((member, index) => h("div", { key: member.id || index, className: "dmesh-meta" }, [
              h(Badge, { key: "b", kind: "brand" }, "附加路径"),
              h("span", { key: "d" }, " " + String(member.deviceName || member.deviceId || "?" ) + " "),
              h("span", { key: "p", className: "dmesh-path" }, String(member.path || "")),
              h("span", { key: "r" }, "  " + (member.role === "scratch" ? "临时" : "镜像")),
              member.reachable === false ? h(Badge, { key: "nr", kind: "err" }, "不可达") : null,
            ])))
          : null,
        sessions.length === 0
          ? h("div", { key: "none", className: "dmesh-empty" }, "这个工作区没有会话")
          : h("div", { key: "list" }, [
            // 合并了多台设备的账目时说明一句：属主那台下挂着别台的会话，不解释会显得突兀。
            merged !== null && merged.deviceCount > 1
              ? h("div", { key: "mergehint", className: "dmesh-empty dmesh-merge-hint" },
                "这个工作区的会话来自 " + merged.deviceCount + " 台设备（已合并）；每条会话的标签标明 agent 在哪台跑。")
              : null,
          ].concat(merged !== null
            ? merged.rows.map((row, index) => h(SessionLine, {
              key: row.session.id || index,
              session: row.session,
              // 会话行上的「哪台」必须按**记录它的那台**说，不能按正在渲染的设备块 ——
              // 否则 xray4668 的会话会顶着 orangepi5 的名字，看起来像在属主那台执行。
              deviceId: row.deviceId,
              self: row.self === true,
              tree: props.tree,
              localOwner,
              deviceName: row.deviceId === deviceId ? "" : row.deviceName,
            }))
            : ownSessions.map((session, index) => h(SessionLine, {
              key: session.id || index,
              session,
              deviceId,
              self,
              tree: props.tree,
              localOwner,
              deviceName,
            })))),
      ]);
    }

    /** 未归入工作区的会话：按 cwd 分组。 */
    function UnassignedBlock(props) {
      const sessions = props.sessions || [];
      const deviceId = props.deviceId;
      const self = props.self === true;
      const groups = useMemo(() => {
        const map = new Map();
        for (const session of sessions) {
          const key = typeof session.cwd === "string" && session.cwd !== "" ? session.cwd : "";
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(session);
        }
        return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
      }, [sessions]);
      if (sessions.length === 0) return null;
      return h("div", { className: "dmesh-ws" }, [
        h("div", { key: "h", className: "dmesh-ws-head" }, [
          h("span", { key: "c", className: "dmesh-caret" }, ""),
          h("span", { key: "t", className: "dmesh-name" }, "未归入工作区"),
          h("span", { key: "n", className: "dmesh-meta" }, sessions.length + " 会话"),
        ]),
        h("div", { key: "groups" }, groups.map(([cwd, list], index) => h(Collapsible, {
          key: cwd || "none-" + index,
          open: props.openSet.has(cwd),
          onToggle: () => props.onToggle(cwd),
          headClass: "dmesh-ws-head",
          head: [
            h("span", { key: "t", className: "dmesh-name" }, cwd === "" ? "(无工作目录)" : cwd),
            h("span", { key: "n", className: "dmesh-meta" }, list.length + " 会话"),
          ],
        }, list.map((session, s) => h(SessionLine, {
          key: session.id || s,
          session,
          deviceId,
          self,
          tree: props.tree,
          // 未归入工作区的会话没有账目可查，只能按 cwd 试一次属主判定；
          // 判不出来就退回驱动端的证据（有入站执行才换方向）。
          localOwner: self || workspaceOwnerIsSelf(props.tree, { path: cwd }),
          deviceName: props.deviceName,
        }))))),
        props.dropped > 0 ? h("div", { key: "drop", className: "dmesh-empty" }, "另有 " + props.dropped + " 条未列出（超过单设备上限）") : null,
      ]);
    }

    /** 一台设备。 */
    function DeviceBlock(props) {
      const device = props.device || {};
      const inventory = device.inventory;
      const deviceName = typeof device.name === "string" && device.name !== "" ? device.name : "(未命名设备)";
      const workspaces = inventory !== null && inventory !== undefined && Array.isArray(inventory.workspaces) ? inventory.workspaces : [];
      const devices = Array.isArray(props.tree?.devices) ? props.tree.devices : [];
      /**
       * 属主那台**确实报了**同一个工作区吗（同 id 或同路径）。
       *
       * 这一条决定「能不能把工作区从这台挪走」：挪走的前提是会话能在属主那行列出来。
       * 属主当前没上报（离线、清单降级、或那台的注册表里没有它）时不能挪 —— 挪了就
       * 连会话一起消失，而用户什么都看不到。
       * @param {object} candidate 本设备清单里的工作区。
       * @returns {boolean} 属主那台有没有同一份账目。
       */
      const ownerReports = (candidate) => {
        const ownerId = declaredOwnerOf(candidate);
        if (ownerId === "" || ownerId === device.deviceId) return false;
        const owner = devices.find((entry) => entry !== null && entry !== undefined && entry.deviceId === ownerId);
        const list = owner !== undefined && Array.isArray(owner.inventory?.workspaces) ? owner.inventory.workspaces : [];
        return list.some((entry) => entry !== null && entry !== undefined
          && ((candidate.id !== undefined && entry.id === candidate.id)
            || (typeof candidate.path === "string" && candidate.path !== "" && entry.path === candidate.path)));
      };
      // 属主在别处的工作区**不记在这台名下**（会话也跟着合并到属主那条，见
      // mergeWorkspaceSessions）。没有 ownerDeviceId 的条目（老 host / 本机就是属主）
      // 一律算自己的，所以没有声明的部署行为与改动前逐字一致。
      const ownWorkspaces = workspaces.filter((workspace) => {
        const owner = declaredOwnerOf(workspace);
        return owner === "" || owner === device.deviceId || !ownerReports(workspace);
      });
      const foreignWorkspaces = workspaces.filter((workspace) => {
        const owner = declaredOwnerOf(workspace);
        return owner !== "" && owner !== device.deviceId && ownerReports(workspace);
      });
      const unassigned = inventory !== null && inventory !== undefined && Array.isArray(inventory.unassigned) ? inventory.unassigned : [];
      const groups = Array.isArray(device.paths) ? device.paths : [];
      const groupFor = (workspaceId) => groups.find((entry) => entry !== null && entry !== undefined && entry.workspaceId === workspaceId) || null;
      const via = device.via || {};
      const viaLabel = via.kind === "self" ? "本机" : (typeof via.label === "string" && via.label !== "" ? via.label : String(via.kind || ""));
      const sessions = typeof inventory?.totals?.sessions === "number" ? inventory.totals.sessions : null;
      // 归属在别处的工作区，它们的会话也不该算在这台头上 —— 计数只减不猜：
      // 拿不到 sessionCount 就用已列出的条数，最后夹到 0（清单被截断时可能对不上）。
      const foreignSessions = foreignWorkspaces.reduce((sum, workspace) => {
        const count = Number(workspace.sessionCount);
        const listed = Array.isArray(workspace.sessions) ? workspace.sessions.length : 0;
        return sum + Math.max(0, Number.isFinite(count) ? count : listed);
      }, 0);
      const ownSessions = sessions === null ? null : Math.max(0, sessions - foreignSessions);
      return h("div", { className: "dmesh-dev" + (device.trust === "denied" ? " denied" : "") }, [
        h(Row, {
          key: "head",
          onClick: props.onToggle,
          title: typeof device.deviceId === "string" ? device.deviceId : "",
        }, [
          h("span", { key: "c", className: "dmesh-caret" }, props.open ? "▾" : "▸"),
          h("span", { key: "i", className: "dmesh-meta" }, h(DeviceGlyph, { kind: device.device?.icon })),
          h(Dot, { key: "d", liveness: device.liveness }),
          h("span", { key: "n", className: "dmesh-name" }, typeof device.name === "string" && device.name !== "" ? device.name : "(未命名设备)"),
          device.self === true ? h(Badge, { key: "self", kind: "brand" }, "本机") : null,
          h(Badge, { key: "via" }, viaLabel),
          device.trust === "exec" ? h(Badge, { key: "tr", kind: "ok" }, "可执行") : null,
          device.trust === "denied" ? h(Badge, { key: "td", kind: "err" }, "已拉黑") : null,
          device.alsoVia && device.alsoVia.length > 0 ? h(Badge, { key: "also" }, "另有 " + device.alsoVia.length + " 条路径") : null,
          h("span", { key: "grow", className: "dmesh-grow" }),
          // 属主在别处时头部计数不能继续算上它们（标题撒谎比没有标题更糟），
          // 单独给一枚「另有 N 个属主在别处」说明它们去哪了。
          foreignWorkspaces.length > 0
            ? h(Badge, {
              key: "foreign",
              kind: "warn",
              title: "这些工作区的属主是别的设备，已归到那台（会话也合并在那台名下）",
            }, foreignWorkspaces.length + " 个属主在别处")
            : null,
          h("span", { key: "m", className: "dmesh-meta" },
            (inventory === null || inventory === undefined)
              ? "尚无清单"
              : ownWorkspaces.length + " 工作区 · " + (ownSessions === null ? "?" : ownSessions) + " 会话"),
          h("span", { key: "t", className: "dmesh-meta" }, relTime(device.lastSeenAt)),
        ]),
        props.open ? h("div", { key: "body" }, [
          (inventory === null || inventory === undefined)
            // 「还没有清单」与「这台设备没有会话」必须长得不一样：前者是尚未上报，
            // 后者是真的空。混在一起会让人以为对端没数据。
            ? h("div", { key: "nil", className: "dmesh-empty" },
              typeof device.deviceId === "string" ? "尚未收到这台设备的清单上报。" : "设备数据不完整。")
            : null,
          workspaces.length === 0 && inventory !== null && inventory !== undefined
            ? h("div", { key: "nows", className: "dmesh-empty" }, "这台设备没有已登记的工作区。")
            : null,
          ownWorkspaces.map((workspace, index) => {
            const key = (device.deviceId || "dev") + "/" + (workspace.id || index);
            return h(WorkspaceBlock, {
              key,
              workspace,
              deviceId: device.deviceId,
              deviceName,
              self: device.self === true,
              tree: props.tree,
              group: groupFor(workspace.id),
              open: props.openWorkspaces.has(key),
              onToggle: () => props.onToggleWorkspace(key),
            });
          }),
          // 归到别处的工作区**如实留一行痕迹**，而不是静默消失：不说的话用户会以为
          // 这些工作区不见了，也看不懂头部计数为什么变小了。
          h(ForeignWorkspacesNote, { key: "foreign", workspaces: foreignWorkspaces, tree: props.tree }),
          h(UnassignedBlock, {
            key: "unassigned",
            deviceId: device.deviceId,
            deviceName,
            self: device.self === true,
            tree: props.tree,
            sessions: unassigned,
            dropped: typeof inventory?.unassignedDropped === "number" ? inventory.unassignedDropped : 0,
            openSet: props.openUnassigned,
            onToggle: props.onToggleUnassigned,
          }),
          inventory !== null && inventory !== undefined && inventory.stale === true
            ? h("div", { key: "stale", className: "dmesh-empty" }, "这份清单是上一次成功采集的快照（最近一次采集失败）。")
            : null,
          inventory !== null && inventory !== undefined && inventory.truncated === true
            ? h("div", { key: "trunc", className: "dmesh-empty" }, "清单被截断：单设备会话数超过本机配置的上限。")
            : null,
        ]) : null,
      ]);
    }

    function OverviewTab(props) {
      const tree = props.tree || {};
      const devices = Array.isArray(tree.devices) ? tree.devices : [];
      const [filter, setFilter] = useState("");
      const [openDevices, setOpenDevices] = useState(() => new Set());
      const [openWorkspaces, setOpenWorkspaces] = useState(() => new Set());
      const [openUnassigned, setOpenUnassigned] = useState(() => new Set());
      const firstRender = useRef(true);

      // 首次拿到数据时自动展开本机 —— 打开面板立刻能看到东西，而不用先点两下。
      useEffect(() => {
        if (!firstRender.current || devices.length === 0) return;
        const self = devices.find((entry) => entry.self === true);
        if (self !== undefined) setOpenDevices(new Set([self.deviceId]));
        firstRender.current = false;
      }, [devices]);

      const toggle = (setter, key) => setter((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });

      const needle = filter.trim().toLowerCase();
      const matchDevice = (device) => {
        if (needle === "") return true;
        if (String(device.name || "").toLowerCase().includes(needle)) return true;
        if (String(device.deviceId || "").toLowerCase().includes(needle)) return true;
        return false;
      };
      const matchWorkspace = (workspace) => {
        if (needle === "") return true;
        if (String(workspace.title || "").toLowerCase().includes(needle)) return true;
        if (String(workspace.path || "").toLowerCase().includes(needle)) return true;
        return false;
      };
      const matchSession = (session) => {
        if (needle === "") return true;
        return String(session.title || "").toLowerCase().includes(needle)
          || String(session.id || "").toLowerCase().includes(needle)
          || String(session.cwd || "").toLowerCase().includes(needle);
      };

      const visible = [];
      for (const device of devices) {
        const workspaceList = Array.isArray(device.inventory?.workspaces) ? device.inventory.workspaces : [];
        const unassigned = Array.isArray(device.inventory?.unassigned) ? device.inventory.unassigned : [];
        if (needle === "") {
          visible.push({ device, workspaceList, unassigned });
          continue;
        }
        // 过滤模式下把命中的祖先自动展开，否则用户看不到命中项。
        const filteredWorkspaces = workspaceList
          .map((workspace) => {
            if (matchWorkspace(workspace)) return workspace;
            const sessions = (Array.isArray(workspace.sessions) ? workspace.sessions : []).filter(matchSession);
            return sessions.length === 0 ? null : { ...workspace, sessions };
          })
          .filter((workspace) => workspace !== null);
        const filteredUnassigned = unassigned.filter(matchSession);
        if (matchDevice(device) || filteredWorkspaces.length > 0 || filteredUnassigned.length > 0) {
          visible.push({
            device,
            workspaceList: matchDevice(device) ? workspaceList : filteredWorkspaces,
            unassigned: matchDevice(device) ? unassigned : filteredUnassigned,
          });
        }
      }

      const filtering = needle !== "";
      return h("div", null, [
        h("input", {
          key: "search",
          className: "dmesh-search",
          placeholder: "搜索设备 / 工作区 / 会话标题 / 会话 id / 路径",
          value: filter,
          onChange: (event) => setFilter(event.target.value),
        }),
        h("div", { key: "tools", className: "dmesh-form" }, [
          h("button", {
            key: "expand",
            className: "dmesh-btn",
            onClick: () => {
              setOpenDevices(new Set(devices.map((entry) => entry.deviceId)));
              const allWs = new Set();
              const allUn = new Set();
              for (const device of devices) {
                for (const workspace of (device.inventory?.workspaces ?? [])) allWs.add((device.deviceId || "dev") + "/" + workspace.id);
                for (const session of (device.inventory?.unassigned ?? [])) allUn.add(session.cwd || "");
              }
              setOpenWorkspaces(allWs);
              setOpenUnassigned(allUn);
            },
          }, "全部展开"),
          h("button", {
            key: "collapse",
            className: "dmesh-btn",
            onClick: () => {
              setOpenDevices(new Set());
              setOpenWorkspaces(new Set());
              setOpenUnassigned(new Set());
            },
          }, "全部收起"),
          h("span", { key: "grow", className: "dmesh-grow" }),
          h("span", { key: "count", className: "dmesh-meta" }, visible.length + " / " + devices.length + " 台设备"),
        ]),
        devices.length === 0
          ? h("div", { className: "dmesh-empty" }, "网格里还没有设备。到「接入点」页加一条指向对端的链接，或在「令牌」页建一个令牌让对方接进来。")
          : null,
        visible.length === 0 && devices.length > 0
          ? h("div", { className: "dmesh-empty" }, "没有匹配的设备、工作区或会话。")
          : null,
        visible.map((entry) => h(Boundary, { key: entry.device.deviceId || entry.device.name },
          h(DeviceBlock, {
            device: { ...entry.device, inventory: entry.device.inventory === null || entry.device.inventory === undefined
              ? entry.device.inventory
              : { ...entry.device.inventory, workspaces: entry.workspaceList, unassigned: entry.unassigned } },
            // drivers 随 tree 一起往下传：工作区行与会话行的执行端标示都要它，
            // 而且必须是**同一份**判定（两个组件各查一次容易得出两个结论）。
            tree,
            open: filtering || openDevices.has(entry.device.deviceId),
            onToggle: () => toggle(setOpenDevices, entry.device.deviceId),
            openWorkspaces: filtering ? new Set(entry.workspaceList.map((w) => (entry.device.deviceId || "dev") + "/" + w.id)) : openWorkspaces,
            onToggleWorkspace: (key) => toggle(setOpenWorkspaces, key),
            openUnassigned: filtering ? new Set(entry.unassigned.map((s) => s.cwd || "")) : openUnassigned,
            onToggleUnassigned: (key) => toggle(setOpenUnassigned, key),
          }))),
      ]);
    }

    // ── 接入点 ──────────────────────────────────────────────────────────────
    function LinksTab(props) {
      const [links, setLinks] = useState([]);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [form, setForm] = useState({ id: "", label: "", url: "", tokenId: "", secret: "", enabled: true });

      const load = useCallback(async () => {
        setError(null);
        try {
          const data = await api(R.links);
          setLinks(Array.isArray(data.links) ? data.links : []);
        } catch (failure) {
          setError(failure);
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      const run = async (fn) => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          await fn();
        } catch (failure) {
          setError(failure);
        } finally {
          setBusy(false);
        }
      };

      const save = () => run(async () => {
        const payload = {
          action: "upsert",
          url: form.url,
          label: form.label,
          tokenId: form.tokenId,
          enabled: form.enabled,
        };
        if (form.id !== "") payload.id = form.id;
        // 关键：留空表示「沿用已保存的密钥」。UI 只有 secret 前缀，不能拿它覆盖。
        if (form.secret !== "") payload.secret = form.secret;
        const data = await api(R.links, payload);
        setLinks(Array.isArray(data.links) ? data.links : []);
        setForm({ id: "", label: "", url: "", tokenId: "", secret: "", enabled: true });
        setNotice("已保存");
      });

      return h("div", null, [
        error !== null ? h("div", { key: "e", className: "dmesh-warnbox" }, error.message + (error.code ? "（" + error.code + "）" : "")) : null,
        notice !== null ? h("div", { key: "n", className: "dmesh-ok", style: { marginBottom: "8px" } }, notice) : null,
        props.authRequired === false
          ? h("div", { key: "open", className: "dmesh-warnbox" }, "警告：本机 requireToken=false，入站接入不需要认证 —— 任何能访问本端口的进程都能接入。建议在「配置」里打开令牌认证。")
          : null,
        h("p", { key: "note", className: "dmesh-note" },
          "接入点 = 一台你主动把清单推过去的对端。加上它之后，对端的设备会出现在「总览」里；"
          + "跨设备执行也只走这一条直连（「接入点的接入点」能看见、不能执行）。"),
        h("div", { key: "form", className: "dmesh-form" }, [
          h("input", { key: "l", className: "dmesh-in", placeholder: "名称", value: form.label, onChange: (e) => setForm({ ...form, label: e.target.value }) }),
          h("input", { key: "u", className: "dmesh-in dmesh-in-wide", placeholder: "http://192.168.1.9:3080", value: form.url, onChange: (e) => setForm({ ...form, url: e.target.value }) }),
          h("input", { key: "t", className: "dmesh-in dmesh-in-mono", placeholder: "令牌 id", value: form.tokenId, onChange: (e) => setForm({ ...form, tokenId: e.target.value }) }),
          h("input", {
            key: "s",
            className: "dmesh-in dmesh-in-mono",
            placeholder: form.id === "" ? "令牌密钥" : "留空 = 沿用已保存的密钥",
            value: form.secret,
            onChange: (e) => setForm({ ...form, secret: e.target.value }),
          }),
          h("button", { key: "save", className: "dmesh-btn dmesh-btn-primary", disabled: busy, onClick: save }, form.id === "" ? "添加" : "保存"),
          form.id !== "" ? h("button", { key: "cancel", className: "dmesh-btn", onClick: () => setForm({ id: "", label: "", url: "", tokenId: "", secret: "", enabled: true }) }, "取消") : null,
        ]),
        h("table", { key: "table", className: "dmesh-table" }, [
          h("thead", { key: "h" }, h("tr", null, ["名称", "地址", "状态", "密钥", "上次推送", "错误", "操作"].map((label) => h("th", { key: label }, label)))),
          h("tbody", { key: "b" }, links.length === 0
            ? h("tr", null, h("td", { colSpan: 7, className: "dmesh-meta" }, "还没有接入点。"))
            : links.map((link) => h("tr", { key: link.id }, [
              h("td", { key: "l" }, link.label),
              h("td", { key: "u", className: "dmesh-path" }, link.url),
              h("td", { key: "s" }, h(Badge, {
                kind: link.state === "joined" ? "ok" : (link.state === "error" ? "err" : (link.state === "unconfigured" ? "warn" : undefined)),
              }, String(link.state))),
              h("td", { key: "k", className: "dmesh-path" }, link.secretPreview || "—"),
              h("td", { key: "p", className: "dmesh-meta" }, relTime(link.lastPushAt) || "—"),
              h("td", { key: "e", className: "dmesh-meta", title: link.lastError || "" }, link.lastError ? String(link.lastError).slice(0, 40) : "—"),
              h("td", { key: "a" }, h("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap" } }, [
                h("button", { key: "edit", className: "dmesh-btn", disabled: busy, onClick: () => setForm({ id: link.id, label: link.label || "", url: link.url, tokenId: link.tokenId || "", secret: "", enabled: link.enabled !== false }) }, "编辑"),
                h("button", {
                  key: "test", className: "dmesh-btn", disabled: busy,
                  onClick: () => run(async () => {
                    const data = await api(R.linkTest, { id: link.id, url: link.url });
                    setNotice((data.authenticated === true ? "认证通过：" : "地址可达（未认证）：") + link.url);
                  }),
                }, "测试"),
                h("button", {
                  key: "sync", className: "dmesh-btn", disabled: busy,
                  onClick: () => run(async () => {
                    const data = await api(R.linkSync, { id: link.id });
                    const first = Array.isArray(data.results) ? data.results[0] : null;
                    setNotice(first && first.ok === false ? "同步失败：" + String(first.error) : "已同步");
                    await load();
                  }),
                }, "同步"),
                h("button", {
                  key: "toggle", className: "dmesh-btn", disabled: busy,
                  onClick: () => run(async () => {
                    await api(R.links, { action: link.enabled === false ? "enable" : "disable", id: link.id });
                    await load();
                  }),
                }, link.enabled === false ? "启用" : "停用"),
                h("button", {
                  key: "del", className: "dmesh-btn dmesh-btn-danger", disabled: busy,
                  onClick: () => run(async () => {
                    if (!window.confirm("删除接入点「" + link.label + "」？不会影响对端。")) return;
                    await api(R.links, { action: "remove", id: link.id });
                    await load();
                  }),
                }, "删除"),
              ])),
            ]))),
        ]),
      ]);
    }

    // ── 令牌 ────────────────────────────────────────────────────────────────
    function TokensTab(props) {
      const [tokens, setTokens] = useState([]);
      const [secret, setSecret] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [label, setLabel] = useState("");
      const [ttlHours, setTtlHours] = useState("");

      const load = useCallback(async () => {
        setError(null);
        try {
          const data = await api(R.tokens);
          setTokens(Array.isArray(data.tokens) ? data.tokens : []);
        } catch (failure) {
          setError(failure);
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      const run = async (fn) => {
        setBusy(true);
        setError(null);
        try {
          await fn();
        } catch (failure) {
          setError(failure);
        } finally {
          setBusy(false);
        }
      };

      return h("div", null, [
        error !== null ? h("div", { key: "e", className: "dmesh-warnbox" }, error.message + (error.code ? "（" + error.code + "）" : "")) : null,
        props.required === false
          ? h("div", { key: "w", className: "dmesh-warnbox" }, "本机当前不要求令牌（requireToken=false），下面的令牌暂时不参与准入判定。")
          : null,
        h("p", { key: "note", className: "dmesh-note" },
          "令牌 = 允许别的设备接入本机的凭据。每台接入设备用一个令牌，方便单独撤销。"
          + "密钥只在创建时显示一次；本机只存它用于验签，之后任何页面都读不回来。"),
        h("div", { key: "form", className: "dmesh-form" }, [
          h("input", { key: "l", className: "dmesh-in", placeholder: "标签（给谁用）", value: label, onChange: (e) => setLabel(e.target.value) }),
          h("input", {
            key: "t", className: "dmesh-in", placeholder: "有效期小时数（留空=永久）", value: ttlHours,
            onChange: (e) => setTtlHours(e.target.value.replace(/[^0-9]/g, "")),
          }),
          h("button", {
            key: "create", className: "dmesh-btn dmesh-btn-primary", disabled: busy,
            onClick: () => run(async () => {
              const payload = { action: "create", label };
              const hours = Number(ttlHours);
              if (Number.isFinite(hours) && hours > 0) payload.ttlMs = hours * 3600 * 1000;
              const data = await api(R.tokens, payload);
              setSecret({ value: data.secret, id: data.token && data.token.id, persisted: data.persisted !== false });
              setTokens(Array.isArray(data.tokens) ? data.tokens : []);
              setLabel("");
              setTtlHours("");
            }),
          }, "新建令牌"),
        ]),
        secret !== null
          ? h("div", { key: "secret" }, [
            h("div", { key: "h", className: "dmesh-note" }, "请立刻复制这个密钥 —— 关闭后本页再也读不到它。"),
            h("div", { key: "v", className: "dmesh-secret" }, String(secret.value)),
            h("div", { key: "a", style: { display: "flex", gap: "6px", marginBottom: "10px" } }, [
              h("button", {
                key: "copy", className: "dmesh-btn dmesh-btn-primary",
                onClick: () => {
                  try {
                    if (navigator.clipboard && navigator.clipboard.writeText) void navigator.clipboard.writeText(String(secret.value));
                  } catch {
                    // 复制失败不影响展示：用户还可以手选。
                  }
                },
              }, "复制密钥"),
              h("button", { key: "close", className: "dmesh-btn", onClick: () => setSecret(null) }, "我已保存，关闭"),
            ]),
            secret.persisted === false
              ? h("div", { key: "np", className: "dmesh-warnbox" }, "注意：这个令牌没能写进磁盘（数据目录不可写），重启后会失效。")
              : null,
          ])
          : null,
        h("table", { key: "table", className: "dmesh-table" }, [
          h("thead", { key: "h" }, h("tr", null, ["标签", "id", "创建", "有效期", "使用", "状态", "操作"].map((value) => h("th", { key: value }, value)))),
          h("tbody", { key: "b" }, tokens.length === 0
            ? h("tr", null, h("td", { colSpan: 7, className: "dmesh-meta" }, "还没有令牌。"))
            : tokens.map((token) => h("tr", { key: token.id }, [
              h("td", { key: "l" }, token.label),
              h("td", { key: "i", className: "dmesh-path" }, token.id),
              h("td", { key: "c", className: "dmesh-meta" }, relTime(Date.parse(token.createdAt))),
              h("td", { key: "e", className: "dmesh-meta" }, token.expiresAt ? relTime(Date.parse(token.expiresAt)) : "永久"),
              h("td", { key: "u", className: "dmesh-meta" }, (token.useCount || 0) + " 次" + (token.lastUsedAt ? " · " + relTime(Date.parse(token.lastUsedAt)) : "")),
              h("td", { key: "s" }, token.revoked === true
                ? h(Badge, { kind: "err" }, "已撤销")
                : (token.expired === true ? h(Badge, { kind: "warn" }, "已过期") : h(Badge, { kind: "ok" }, "有效"))),
              h("td", { key: "a" }, h("div", { style: { display: "flex", gap: "4px" } }, [
                token.revoked !== true
                  ? h("button", {
                    key: "r", className: "dmesh-btn dmesh-btn-danger", disabled: busy,
                    onClick: () => run(async () => {
                      await api(R.tokens, { action: "revoke", id: token.id });
                      await load();
                    }),
                  }, "撤销")
                  : null,
                h("button", {
                  key: "d", className: "dmesh-btn dmesh-btn-danger", disabled: busy,
                  onClick: () => run(async () => {
                    if (!window.confirm("彻底删除令牌「" + token.label + "」的记录？使用它的设备会立刻失去接入。")) return;
                    await api(R.tokens, { action: "delete", id: token.id });
                    await load();
                  }),
                }, "删除"),
              ])),
            ]))),
        ]),
      ]);
    }

    // ── 路径 + 跨设备执行 ───────────────────────────────────────────────────
    function PathsTab(props) {
      const [groups, setGroups] = useState([]);
      const [devices, setDevices] = useState([]);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [form, setForm] = useState({ workspaceId: "", deviceId: "", path: "", role: "mirror", label: "" });
      const [exec, setExec] = useState({});
      const [output, setOutput] = useState({});

      const load = useCallback(async () => {
        setError(null);
        try {
          const data = await api(R.paths);
          setGroups(Array.isArray(data.groups) ? data.groups : []);
          setDevices(Array.isArray(data.devices) ? data.devices : []);
        } catch (failure) {
          setError(failure);
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      const run = async (fn) => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          await fn();
        } catch (failure) {
          setError(failure);
        } finally {
          setBusy(false);
        }
      };

      const runExec = (group, target) => run(async () => {
        const key = group.id + "/" + (target.memberId || "primary");
        const formState = exec[key] || {};
        if (typeof formState.command !== "string" || formState.command.trim() === "") {
          throw new Error("请先填写要执行的命令");
        }
        const data = await api(R.exec, {
          deviceId: target.deviceId,
          path: target.path,
          command: formState.command,
        });
        setOutput((previous) => ({ ...previous, [key]: { ok: true, data } }));
      });

      const execKey = (group, target) => group.id + "/" + (target.memberId || "primary");

      const targetsOf = (group) => {
        const list = [{
          memberId: null,
          deviceId: group.primary.deviceId,
          deviceName: group.primary.deviceName,
          path: group.primary.path,
          role: "primary",
          reachable: true,
          primary: true,
        }];
        for (const member of group.members || []) list.push({ ...member, primary: false });
        return list;
      };

      const deviceById = (deviceId) => devices.find((entry) => entry.deviceId === deviceId) || null;
      const workspaceOptions = [];
      for (const group of groups) workspaceOptions.push({ id: group.workspaceId, title: group.workspaceTitle });

      return h("div", null, [
        error !== null ? h("div", { key: "e", className: "dmesh-warnbox" }, error.message + (error.code ? "（" + error.code + "）" : "")) : null,
        notice !== null ? h("div", { key: "n", className: "dmesh-ok", style: { marginBottom: "8px" } }, notice) : null,
        h("p", { key: "note", className: "dmesh-note" },
          "新会话与出厂行为始终在**主路径**上工作；附加路径是显式选择的额外工作目录，可以位于其它设备。"
          + "跨设备执行只走一跳：目标必须是本机，或本机直连的接入点。" ),
        groups.length === 0
          ? h("div", { key: "none", className: "dmesh-empty" }, "还没有工作区路径账目。先在本机建一个工作区，或到「总览」看看对端有没有上报工作区。")
          : null,
        groups.map((group) => h("div", { key: group.id, className: "dmesh-group" }, [
          h("div", { key: "h", style: { display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" } }, [
            h("span", { key: "t", className: "dmesh-name" }, group.workspaceTitle),
            group.orphan === true ? h(Badge, { key: "o", kind: "warn" }, "工作区已不在本机注册表") : null,
            h("span", { key: "grow", className: "dmesh-grow" }),
            h("span", { key: "id", className: "dmesh-meta" }, group.workspaceId),
          ]),
          h("div", { key: "primary", className: "dmesh-meta", style: { margin: "6px 0" } }, [
            h(Badge, { key: "b", kind: "brand" }, "主路径"),
            h("span", { key: "d" }, " " + group.primary.deviceName + " "),
            h("span", { key: "p", className: "dmesh-path" }, group.primary.path || "(未知)"),
            group.primary.stale === true ? h(Badge, { key: "s", kind: "warn" }, "快照") : null,
            h("span", { key: "n", className: "dmesh-hint" }, "不可修改；默认工作位置"),
          ]),
          (group.members || []).map((member) => h("div", { key: member.id, className: "dmesh-meta", style: { margin: "4px 0" } }, [
            h(Badge, { key: "b" }, "附加路径"),
            h("span", { key: "d" }, " " + member.deviceName + " "),
            h("span", { key: "p", className: "dmesh-path" }, member.path),
            h("span", { key: "r" }, "  " + (member.role === "scratch" ? "临时" : "镜像")),
            member.label ? h("span", { key: "l", className: "dmesh-hint" }, member.label) : null,
            member.reachable === false ? h(Badge, { key: "nr", kind: "err" }, "不可达") : null,
            h("button", {
              key: "rm", className: "dmesh-btn dmesh-btn-danger", style: { marginLeft: "6px" }, disabled: busy,
              onClick: () => run(async () => {
                const data = await api(R.paths, { action: "remove", id: member.id });
                setGroups(Array.isArray(data.groups) ? data.groups : []);
                setNotice("已移除附加路径");
              }),
            }, "移除"),
          ])),
          h("div", { key: "execs" }, targetsOf(group).map((target) => {
            const key = execKey(group, target);
            const device = deviceById(target.deviceId);
            const canExec = target.deviceId === props.selfDeviceId
              ? true
              : (target.reachable === true && (device === null || device.canExec !== false));
            const state = exec[key] || { command: "" };
            const result = output[key];
            return h("div", { key, style: { marginTop: "8px", borderTop: "1px solid var(--dsw-alias-border-l1)", paddingTop: "7px" } }, [
              h("div", { key: "row", style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } }, [
                h("span", { key: "t", className: "dmesh-meta" }, (target.primary ? "主路径" : "附加") + " · " + (target.deviceName || "?")),
                h("input", {
                  key: "cmd",
                  className: "dmesh-in dmesh-in-wide dmesh-in-mono",
                  placeholder: canExec ? "在此目录执行命令…" : "该目标不可执行",
                  disabled: !canExec,
                  value: state.command || "",
                  onChange: (event) => setExec((previous) => ({ ...previous, [key]: { command: event.target.value } })),
                }),
                h("button", {
                  key: "go", className: "dmesh-btn dmesh-btn-primary", disabled: !canExec || busy,
                  title: canExec ? "" : "本机没有指向该设备的接入点，或对端没开启跨设备执行",
                  onClick: () => { void runExec(group, target); },
                }, "执行"),
                canExec ? null : h("span", { key: "why", className: "dmesh-hint" }, "不可达或对端未开启执行"),
              ]),
              result && result.ok === true
                ? h("div", { key: "out" }, [
                  h("div", { key: "meta", className: "dmesh-meta" },
                    "退出码 " + String(result.data.exitCode) + " · " + String(result.data.durationMs) + " ms"
                    + (result.data.timedOut === true ? " · 已超时终止" : "")
                    + (result.data.auditId ? " · 审计 " + String(result.data.auditId) : "")),
                  result.data.stdout ? h("div", { key: "o", className: "dmesh-out" }, String(result.data.stdout)) : null,
                  result.data.stderr ? h("div", { key: "e", className: "dmesh-out dmesh-out-err" }, String(result.data.stderr)) : null,
                ])
                : null,
            ]);
          })),
        ])),
        h("div", { key: "addform", className: "dmesh-form", style: { marginTop: "14px" } }, [
          h("span", { key: "t", className: "dmesh-meta" }, "添加附加路径"),
          h("select", {
            key: "w", className: "dmesh-in",
            value: form.workspaceId,
            onChange: (event) => setForm({ ...form, workspaceId: event.target.value }),
          }, [h("option", { key: "", value: "" }, "选择工作区")].concat(workspaceOptions.map((option) => h("option", { key: option.id, value: option.id }, option.title)))),
          h("select", {
            key: "d", className: "dmesh-in",
            value: form.deviceId,
            onChange: (event) => setForm({ ...form, deviceId: event.target.value }),
          }, [h("option", { key: "", value: "" }, "本机")].concat(devices.filter((entry) => entry.self !== true).map((entry) => h("option", { key: entry.deviceId, value: entry.deviceId }, entry.name + (entry.reachable === true ? "" : "（不可达）"))))),
          h("input", {
            key: "p", className: "dmesh-in dmesh-in-wide dmesh-in-mono", placeholder: "/绝对/路径",
            value: form.path, onChange: (event) => setForm({ ...form, path: event.target.value }),
          }),
          h("select", {
            key: "r", className: "dmesh-in", value: form.role,
            onChange: (event) => setForm({ ...form, role: event.target.value }),
          }, [h("option", { key: "mirror", value: "mirror" }, "镜像"), h("option", { key: "scratch", value: "scratch" }, "临时")]),
          h("input", {
            key: "l", className: "dmesh-in", placeholder: "备注",
            value: form.label, onChange: (event) => setForm({ ...form, label: event.target.value }),
          }),
          h("button", {
            key: "add", className: "dmesh-btn dmesh-btn-primary", disabled: busy,
            onClick: () => run(async () => {
              if (form.workspaceId === "") throw new Error("请选择工作区");
              if (form.path.trim() === "") throw new Error("请填写绝对路径");
              const data = await api(R.paths, {
                action: "add",
                workspaceId: form.workspaceId,
                deviceId: form.deviceId === "" ? undefined : form.deviceId,
                path: form.path,
                role: form.role,
                label: form.label,
              });
              setGroups(Array.isArray(data.groups) ? data.groups : []);
              setForm({ workspaceId: "", deviceId: "", path: "", role: "mirror", label: "" });
              setNotice("已添加附加路径");
            }),
          }, "添加"),
        ]),
      ]);
    }

    // ── 设备（已接入本机的节点）─────────────────────────────────────────────
    function NodesTab(props) {
      const [nodes, setNodes] = useState([]);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);

      const load = useCallback(async () => {
        setError(null);
        try {
          const data = await api(R.nodes);
          setNodes(Array.isArray(data.nodes) ? data.nodes : []);
        } catch (failure) {
          setError(failure);
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      const run = async (fn) => {
        setBusy(true);
        setError(null);
        try {
          await fn();
          await load();
        } catch (failure) {
          setError(failure);
        } finally {
          setBusy(false);
        }
      };

      return h("div", null, [
        error !== null ? h("div", { key: "e", className: "dmesh-warnbox" }, error.message + (error.code ? "（" + error.code + "）" : "")) : null,
        h("p", { key: "note", className: "dmesh-note" },
          "接入本机的设备。信任级别决定它们能做什么：只看清单（inventory）、额外允许在本机执行命令（exec）、拉黑（denied）。"
          + "令牌只证明「它是谁」，不等于「它可以执行」—— 执行权必须在这里单独授予。"),
        h("table", { key: "t", className: "dmesh-table" }, [
          h("thead", { key: "h" }, h("tr", null, ["名称", "设备 id", "状态", "信任", "工作区/会话", "最后心跳", "备注", "操作"].map((value) => h("th", { key: value }, value)))),
          h("tbody", { key: "b" }, nodes.length === 0
            ? h("tr", null, h("td", { colSpan: 8, className: "dmesh-meta" }, "还没有设备接入本机。到「令牌」页建一个令牌给对方。"))
            : nodes.map((node) => h("tr", { key: node.deviceId }, [
              h("td", { key: "n" }, [h(Dot, { key: "d", liveness: node.liveness }), " " + node.name]),
              h("td", { key: "i", className: "dmesh-path" }, node.deviceId),
              h("td", { key: "s", className: "dmesh-meta" }, livenessLabel[node.liveness] || node.liveness),
              h("td", { key: "t" }, h(Badge, {
                kind: node.trust === "exec" ? "ok" : (node.trust === "denied" ? "err" : undefined),
              }, node.trust === "exec" ? "可执行" : (node.trust === "denied" ? "已拉黑" : "只看清单"))),
              h("td", { key: "c", className: "dmesh-meta" }, (node.workspaceCount || 0) + " / " + (node.sessionCount || 0)),
              h("td", { key: "h", className: "dmesh-meta" }, relTime(Date.parse(node.lastSeenAt))),
              h("td", { key: "note" }, node.note || "—"),
              h("td", { key: "a" }, h("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap" } }, [
                h("button", {
                  key: "exec", className: "dmesh-btn", disabled: busy,
                  onClick: () => run(async () => {
                    await api(R.nodes, { action: "update", deviceId: node.deviceId, trust: node.trust === "exec" ? "inventory" : "exec" });
                  }),
                }, node.trust === "exec" ? "收回执行权" : "授予执行权"),
                h("button", {
                  key: "deny", className: "dmesh-btn dmesh-btn-danger", disabled: busy,
                  onClick: () => run(async () => {
                    await api(R.nodes, { action: "update", deviceId: node.deviceId, trust: node.trust === "denied" ? "inventory" : "denied" });
                  }),
                }, node.trust === "denied" ? "解除拉黑" : "拉黑"),
                h("button", {
                  key: "note", className: "dmesh-btn", disabled: busy,
                  onClick: () => {
                    const next = window.prompt("给这台设备一个备注名（显示在总览里）", node.note || "");
                    if (next === null) return;
                    void run(async () => {
                      await api(R.nodes, { action: "update", deviceId: node.deviceId, note: next });
                    });
                  },
                }, "备注"),
                h("button", {
                  key: "forget", className: "dmesh-btn dmesh-btn-danger", disabled: busy,
                  onClick: () => run(async () => {
                    if (!window.confirm("移除「" + node.name + "」的接入记录？对端下次心跳会重新接入（除非同时撤销它的令牌）。")) return;
                    await api(R.nodes, { action: "forget", deviceId: node.deviceId });
                  }),
                }, "移除"),
              ])),
            ]))),
        ]),
      ]);
    }

    // ── 配置 ────────────────────────────────────────────────────────────────
    function ConfigTab(props) {
      const [config, setConfig] = useState(null);
      const [device, setDevice] = useState(null);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(false);
      const [name, setName] = useState("");

      const load = useCallback(async () => {
        setError(null);
        try {
          const data = await api(R.config);
          setConfig(data.config || null);
          setDevice(data.device || null);
          setName((data.device && data.device.name) || "");
        } catch (failure) {
          setError(failure);
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      const patch = async (payload) => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          const data = await api(R.config, payload);
          setConfig(data.config || null);
          setDevice(data.device || null);
          if (typeof data.applied?.deviceName === "string") setName(data.applied.deviceName);
          setNotice("已生效");
        } catch (failure) {
          setError(failure);
        } finally {
          setBusy(false);
        }
      };

      if (config === null) {
        return h("div", null, [
          error !== null ? h("div", { key: "e", className: "dmesh-warnbox" }, error.message) : h("div", { key: "l", className: "dmesh-meta" }, "加载中…"),
        ]);
      }

      const toggleRow = (label, key, hint) => h("div", { key, className: "dmesh-form" }, [
        h("span", { key: "l", style: { minWidth: "150px" } }, label),
        h("button", {
          key: "b", className: "dmesh-btn" + (config[key] === true ? " dmesh-btn-primary" : ""), disabled: busy,
          onClick: () => { void patch({ [key]: config[key] !== true }); },
        }, config[key] === true ? "已开启" : "已关闭"),
        hint ? h("span", { key: "h", className: "dmesh-hint" }, hint) : null,
      ]);

      return h("div", null, [
        error !== null ? h("div", { key: "e", className: "dmesh-warnbox" }, error.message) : null,
        notice !== null ? h("div", { key: "n", className: "dmesh-ok", style: { marginBottom: "8px" } }, notice) : null,
        h("div", { key: "dev", className: "dmesh-group" }, [
          h("div", { key: "t", className: "dmesh-name" }, "本机身份"),
          h("div", { key: "id", className: "dmesh-meta" }, "设备 id：" + String(device?.deviceId || "")),
          h("div", { key: "os", className: "dmesh-meta" }, [device?.os, device?.arch, device?.dshVersion ? "DSH " + device.dshVersion : null].filter(Boolean).join(" · ")),
          h("div", { key: "cap", className: "dmesh-meta" }, "能力：" + ((device?.capabilities || []).join(", ") || "—")),
          h("div", { key: "form", className: "dmesh-form" }, [
            h("input", { key: "n", className: "dmesh-in dmesh-in-wide", value: name, onChange: (e) => setName(e.target.value), placeholder: "设备显示名" }),
            h("button", { key: "s", className: "dmesh-btn dmesh-btn-primary", disabled: busy, onClick: () => { void patch({ deviceName: name }); } }, "改名"),
          ]),
        ]),
        h("div", { key: "behavior", className: "dmesh-group" }, [
          h("div", { key: "t", className: "dmesh-name" }, "接入"),
          toggleRow("允许其它设备接入本机", "allowInbound", "关掉后入站 API 全部拒绝，本机变成只出不进"),
          toggleRow("入站要求令牌认证", "requireToken", config.requireToken !== true ? "强烈建议保持开启" : "关掉即任何人可接入（仅限完全可信内网）"),
        ]),
        h("div", { key: "exec", className: "dmesh-group" }, [
          h("div", { key: "t", className: "dmesh-name" }, "跨设备执行"),
          h("p", { key: "p", className: "dmesh-note" },
            "开启后，被授予执行权的对端可以在本机的**导出根**内运行命令。缺省关闭，且缺省只授予「看清单」。"),
          toggleRow("允许远端在本机执行命令", "allowRemoteExec", config.allowRemoteExec !== true ? "开启前请确认导出根范围" : "已开启，可在「设备」页逐个授权"),
          h("div", { key: "trust", className: "dmesh-form" }, [
            h("span", { key: "l", style: { minWidth: "150px" } }, "谁可以执行"),
            h("select", {
              key: "s", className: "dmesh-in", value: config.execTrust || "grant-required", disabled: busy,
              onChange: (event) => { void patch({ execTrust: event.target.value }); },
            }, [
              h("option", { key: "g", value: "grant-required" }, "仅被授予 exec 的设备"),
              h("option", { key: "a", value: "any-authenticated" }, "任何通过认证的设备"),
            ]),
            h("span", { key: "h", className: "dmesh-hint" }, config.execTrust === "any-authenticated" ? "任何持有有效令牌的节点都能在本机执行命令" : "推荐"),
          ]),
          h("div", { key: "roots", className: "dmesh-note" },
            "导出根：" + ((config.exportRoots || []).join(", ") || "（未显式配置）")
            + (config.exportWorkspacePaths === true ? " ＋ 本机工作区路径" : "（不含本机工作区路径）")),
        ]),
        h("div", { key: "list", className: "dmesh-group" }, [
          h("div", { key: "t", className: "dmesh-name" }, "清单内容"),
          toggleRow("包含子代理会话", "includeSubagents", null),
          toggleRow("包含已归档会话", "includeArchived", null),
        ]),
        h("p", { key: "note", className: "dmesh-note" },
          "端口、数据目录、推送间隔、导出根等需要改 profile patch 里的 config 并重启 dsh —— "
          + "这里只列出可以立刻生效的开关，不假装能改其它的。"),
      ]);
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────
    function MeshPanel() {
      const [tab, setTab] = useState("overview");
      const [tree, setTree] = useState(null);
      const [status, setStatus] = useState(null);
      const [mirror, setMirror] = useState(null);
      const [backfilling, setBackfilling] = useState(false);
      const [problems, setProblems] = useState([]);
      const [error, setError] = useState(null);
      const [auto, setAuto] = useState(true);
      const [loading, setLoading] = useState(false);
      const busy = useRef(false);

      const refresh = useCallback(async () => {
        if (busy.current) return; // 上一次还没回来就不要再堆一个
        busy.current = true;
        setLoading(true);
        try {
          const data = await api(R.tree);
          setTree(data.tree || null);
          setProblems(Array.isArray(data.problems) ? data.problems : []);
          setError(null);
        } catch (failure) {
          setError(failure);
        } finally {
          busy.current = false;
          setLoading(false);
        }
      }, []);

      const refreshStatus = useCallback(async () => {
        try {
          setStatus(await api(R.status));
        } catch {
          // 自检失败只影响诊断区，不打断主流程。
        }
        try {
          setMirror(await api(R.mirror));
        } catch {
          setMirror(null);
        }
      }, []);

      useEffect(() => {
        void refresh();
        void refreshStatus();
      }, [refresh, refreshStatus]);

      useEffect(() => {
        if (!auto) return undefined;
        const timer = window.setInterval(() => { void refresh(); }, REFRESH_MS);
        return () => window.clearInterval(timer);
      }, [auto, refresh]);

      const summary = tree?.summary || {};
      const selfDeviceId = tree?.selfDeviceId || null;
      const tabs = [
        { id: "overview", label: "总览" },
        { id: "paths", label: "路径与执行" },
        { id: "links", label: "接入点" },
        { id: "tokens", label: "令牌" },
        { id: "nodes", label: "设备" },
        { id: "config", label: "配置" },
      ];

      return h("div", { className: "dmesh-page" }, [
        h("div", { key: "head", className: "dmesh-head" }, [
          h("span", { key: "t", className: "dmesh-title" }, "设备网格"),
          h("span", { key: "s", className: "dmesh-sum" },
            summary.devices
              ? summary.devices + " 台设备（在线 " + (summary.online || 0) + "） · "
                + (summary.workspaces || 0) + " 工作区 · " + (summary.sessions || 0) + " 会话"
              : (tree === null ? "加载中…" : "网格里还没有设备")),
          h("span", { key: "grow", className: "dmesh-spacer" }),
          h("button", {
            key: "auto", className: "dmesh-btn" + (auto ? " dmesh-btn-primary" : ""),
            onClick: () => setAuto(!auto),
            title: "每 15 秒自动刷新",
          }, auto ? "自动刷新：开" : "自动刷新：关"),
          h("button", { key: "r", className: "dmesh-btn", disabled: loading, onClick: () => { void refresh(); void refreshStatus(); } }, loading ? "刷新中…" : "刷新"),
        ]),
        h("div", { key: "tabs", className: "dmesh-tabs" },
          tabs.map((entry) => h("button", {
            key: entry.id,
            className: "dmesh-tab" + (tab === entry.id ? " on" : ""),
            onClick: () => setTab(entry.id),
          }, entry.label))),
        error !== null
          ? h("div", { key: "err", className: "dmesh-warnbox", style: { margin: "10px 14px 0" } },
            "读取失败：" + error.message + (error.code ? "（" + error.code + "）" : ""))
          : null,
        problems.length > 0
          ? h("div", { key: "problems", className: "dmesh-warnbox", style: { margin: "10px 14px 0" } },
            "数据层报告了 " + problems.length + " 个问题：" + problems.slice(0, 3).join("；"))
          : null,
        h("div", { key: "body", className: "dmesh-body" },
          tab === "overview"
            ? (tree === null && error === null
              ? h("div", { className: "dmesh-empty" }, "加载中…")
              : h(OverviewTab, { tree: tree || { devices: [] } }))
            : tab === "paths" ? h(PathsTab, { selfDeviceId })
              : tab === "links" ? h(LinksTab, { authRequired: summary.authRequired })
                : tab === "tokens" ? h(TokensTab, { required: summary.authRequired })
                  : tab === "nodes" ? h(NodesTab)
                    : h(ConfigTab)),
        status !== null
          ? h("div", { key: "foot", className: "dmesh-meta", style: { padding: "0 14px 6px" } },
            "协议 v" + String(status.protocol) + " · 实现 " + String(status.version) + "/" + String(status.importTag)
            + " · 数据目录 " + String(status.meshDir || "")
            + (status.exec ? " · 执行上限 " + String(status.exec.limits.execMaxConcurrent) + " 并发 / " + String(status.exec.limits.timeoutMs) + " ms" : ""))
          : null,
        // 会话历史镜像：本机推了多少（作为会话端）、收了多少（作为执行端）。
        // 「执行端仅存储」是这条功能的全部语义，所以这里只报告计数与「回填」入口。
        mirror !== null
          ? h("div", { key: "mirror", className: "dmesh-meta", style: { padding: "0 14px 14px" } }, [
            "会话镜像：" + (mirror.configured ? "开" : "关"),
            " · 推送 " + String((mirror.sender && mirror.sender.counters && mirror.sender.counters.events) || 0) + " 事件"
            + "/" + String((mirror.sender && mirror.sender.sessions) || 0) + " 会话",
            " · 收到 " + String((mirror.replicas && mirror.replicas.totalSessions) || 0) + " 会话"
            + "/" + String((mirror.replicas && mirror.replicas.received) || 0) + " 事件",
            mirror.sender && mirror.sender.lastError ? " · 最近失败：" + String(mirror.sender.lastError).slice(0, 60) : "",
            h("button", {
              key: "backfill",
              className: "dmesh-btn",
              style: { marginLeft: "8px" },
              disabled: backfilling || !mirror.configured,
              title: "把本机已有会话的完整历史一次性推给执行端（默认只镜像之后还在动的会话）",
              onClick: async () => {
                setBackfilling(true);
                try {
                  await api(R.mirrorBackfill, { limit: 50 }, "POST");
                  await refreshStatus();
                } catch {
                  // 失败只体现在状态行（lastError），不弹窗。
                } finally {
                  setBackfilling(false);
                }
              },
            }, backfilling ? "回填中…" : "回填已有历史"),
          ])
          : null,
      ]);
    }

    // ── 远程工作区（主界面侧边栏）────────────────────────────────────────────
    // 出厂侧边栏只列本机 workspaceRegistry 的工作区。本组件把远程设备的工作区
    // **平铺**进同一份工作区列表，不另开区域重复展示网格面板已有的
    // 「设备→工作区」结构；区分靠**名称**：`标题 · 设备名`，设备联不通时名称带
    // 「（未连接）」。
    //
    // 位置：工厂把 `sidebar.workspaces.remote` 槽位渲染在**会话列表容器内部**
    // （`role="tree"` + `aria-label=section.sessions`，即工作区行下面那块真正的
    // 会话选择区），排在出厂工作区分组之后 —— 因此远程工作区与会话一起滚动，
    // 而不是被钉在列表下方成为第二块区域。
    //
    // 边界（与面板一致，不假装）：远端会话不能在本机打开 —— 日志、附件、agent
    // 都在对端，点击只复制 id。数据是清单快照，新鲜度由 mesh 的 inventoryTtlMs
    // 决定；本组件 30s 拉一次 /tree（stale-while-revalidate，命中缓存是毫秒级）。
    // ── /tree 共享存储 ───────────────────────────────────────────────────────
    // 侧边栏里有两个消费者都要这份数据：「远程工作区」区块（列远端独有工作区）和
    // 每个本机工作区行上的「网络标示」（标记这台工作区同时存在于别的设备）。
    // 各自拉一份会变成 N+1 个请求、N+1 个计时器，所以这里收成一个模块级存储：
    // 一个 30s 轮询 + 订阅通知，组件只在数据真变了时重渲染。
    const meshTreeStore = (() => {
      let data = null;
      let error = null;
      let inFlight = false;
      let timer = 0;
      const listeners = new Set();
      const notify = () => { for (const listener of [...listeners]) listener(); };
      const pull = async () => {
        if (inFlight) return;
        inFlight = true;
        try {
          const next = await api(R.tree);
          data = next.tree || null;
          error = null;
        } catch (failure) {
          error = failure;
        } finally {
          inFlight = false;
          notify();
        }
      };
      return {
        get() { return { tree: data, error }; },
        subscribe(listener) {
          listeners.add(listener);
          if (timer === 0) {
            void pull();
            timer = window.setInterval(() => { void pull(); }, 30000);
          }
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0 && timer !== 0) {
              window.clearInterval(timer);
              timer = 0;
            }
          };
        },
      };
    })();

    /** 订阅 /tree 存储；返回 { tree, error }，数据变化时重渲染。 */
    function useMeshTree() {
      const [snapshot, setSnapshot] = useState(() => meshTreeStore.get());
      useEffect(() => meshTreeStore.subscribe(() => setSnapshot(meshTreeStore.get())), []);
      return snapshot;
    }

    // ── 镜像进度共享存储 ─────────────────────────────────────────────────────
    // 执行端看得见的「这条会话最近在干什么」来自本机镜像（host 的 `/replica-progress`）。
    // 侧边栏的远程会话行与面板里的会话行都要这份数据，各自拉一份会变成 N+1 个请求 +
    // N+1 个计时器，所以与 /tree 同一个套路：一个模块级存储 + 订阅通知。
    //
    // 旧版 host 没有这条路由（404）：当成「没有进度」静默降级，而不是每次轮询都抛错 ——
    // 与「工厂没打槽位补丁时静默不渲染」同一条原则。
    const progressStore = (() => {
      let rows = null;
      let error = null;
      let inFlight = false;
      let timer = 0;
      const listeners = new Set();
      const notify = () => { for (const listener of [...listeners]) listener(); };
      const pull = async () => {
        if (inFlight) return;
        inFlight = true;
        try {
          const next = await api(R.replicaProgress);
          rows = Array.isArray(next.sessions) ? next.sessions : [];
          error = null;
        } catch (failure) {
          if (failure !== null && failure !== undefined && failure.status === 404) {
            rows = [];
            error = null;
          } else {
            error = failure;
          }
        } finally {
          inFlight = false;
          notify();
        }
      };
      return {
        get() { return { rows, error }; },
        subscribe(listener) {
          listeners.add(listener);
          if (timer === 0) {
            void pull();
            timer = window.setInterval(() => { void pull(); }, REFRESH_MS);
          }
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0 && timer !== 0) {
              window.clearInterval(timer);
              timer = 0;
            }
          };
        },
      };
    })();

    /** 订阅镜像进度存储。 */
    function useReplicaProgress() {
      const [snapshot, setSnapshot] = useState(() => progressStore.get());
      useEffect(() => progressStore.subscribe(() => setSnapshot(progressStore.get())), []);
      return snapshot;
    }

    /**
     * 按会话 id 找一行进度。
     *
     * 两代命名都认（`session-<uuid>` 与 `<uuid>`）：镜像目录里两种并存，判据必须与
     * host 的 `SessionReplicaStore.find` 同口径，否则「有进度」与「能接管」会对不上。
     * @param {object[]|null} rows 进度行。
     * @param {string} sessionId 会话 id。
     * @returns {object|null} 进度行。
     */
    function progressFor(rows, sessionId) {
      if (!Array.isArray(rows) || typeof sessionId !== "string" || sessionId === "") return null;
      const bare = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
      for (const row of rows) {
        const id = row !== null && row !== undefined && typeof row.sessionId === "string" ? row.sessionId : "";
        if (id === sessionId) return row;
        const rowBare = id.startsWith("session-") ? id.slice("session-".length) : id;
        if (bare !== "" && rowBare === bare) return row;
      }
      return null;
    }

    /** 进度行的悬停说明：把判定依据摊开（哪些是镜像事实、哪些是对端清单事实）。 */
    function progressTitle(row) {
      if (row === null || row === undefined) return "";
      const lines = [];
      if (typeof row.sessionId === "string") lines.push(row.sessionId);
      if (typeof row.sourceDeviceName === "string" && row.sourceDeviceName !== "") lines.push("源设备：" + row.sourceDeviceName);
      if (typeof row.lastEventType === "string" && row.lastEventType !== "") lines.push("最近事件：" + row.lastEventType);
      if (typeof row.summary === "string" && row.summary !== "") lines.push("最近进度：" + row.summary);
      if (typeof row.lastSeq === "number") lines.push("镜像 seq：" + row.firstSeq + " → " + row.lastSeq + "（" + row.events + " 条，" + row.bytes + " 字节）");
      if (typeof row.updatedAt === "string") lines.push("镜像更新：" + row.updatedAt);
      // 本机那份上下文（每次运行结束后自动同步过来的历史）。
      if (typeof row.syncedAt === "string") {
        lines.push("本机上下文：" + row.syncedAt
          + (row.syncedVersion ? "（" + row.syncedVersion + "，" + row.syncedBytes + " 字节，追到 seq " + row.syncedSeq + "）" : ""));
        if (row.synced !== true && typeof row.lastSeq === "number") {
          lines.push("注意：本机那份落后于镜像（镜像已到 seq " + row.lastSeq + "）");
        }
      } else {
        lines.push("本机上下文：还没有同步过（等这条会话跑完一轮，或手动接管）");
      }
      if (typeof row.syncSkipped === "string" && row.syncSkipped !== "") lines.push("上次未自动同步：" + row.syncSkipped);
      if (typeof row.syncError === "string" && row.syncError !== "") lines.push("上次同步失败：" + row.syncError);
      lines.push(row.remoteLive === true ? "对端清单：这条会话的 agent 正在跑" : "对端清单：agent 当前不在跑");
      if (row.truncated === true) lines.push("镜像已到单会话上限，后续事件不再入镜像");
      if (typeof row.takenOverAt === "string") lines.push("本机曾接管：" + row.takenOverAt);
      return lines.join("\n");
    }

    /**
     * 进度行要显示的文字片段（**空数组 = 没什么可说的**）。
     *
     * 为什么单独一个函数：渲染决定要用它 —— `h(ProgressLine, …)` 永远是「非 null 元素」，
     * 拿它当「有没有进度」的判据会让一条**没有内容**的进度行也把行撑高、加粗样式。
     *
     * 两种「在动」分开说：`remoteLive`（对端清单说 agent 在跑）与 `live`（镜像最近还在
     * 收到事件）是两件事 —— 前者是「有人在干活」，后者只说明「数据还新鲜」。
     * @param {object|null} row 进度行。
     * @returns {string[]} 片段。
     */
    function progressParts(row) {
      if (row === null || row === undefined) return [];
      const parts = [];
      if (typeof row.summary === "string" && row.summary !== "") parts.push(row.summary);
      else if (typeof row.lastEventType === "string" && row.lastEventType !== "") parts.push(row.lastEventType);
      if (row.remoteLive === true) parts.push("正在跑");
      else if (row.live === true) parts.push("刚有动静");
      if (typeof row.lastSeq === "number") parts.push("seq " + row.lastSeq);
      // 本机那份上下文的状态：这是执行端最该知道的一件事（本机离线时它还在不在）。
      if (row.synced === true) parts.push("已留在本机");
      else if (typeof row.syncedAt === "string") parts.push("本机副本落后");
      else if (typeof row.syncError === "string" && row.syncError !== "") parts.push("同步失败");
      else if (typeof row.syncSkipped === "string" && row.syncSkipped !== "") parts.push("未自动同步");
      const when = relTime(typeof row.updatedAt === "string" ? row.updatedAt : row.lastEventTime);
      if (when !== "") parts.push(when);
      return parts;
    }

    /**
     * 进度行：`● 调用工具 bash · 正在跑 · seq 4210 · 12 秒前`。
     * @param {object} props `{ row, parts }`。
     * @returns {object|null} 节点（没内容返回 null）。
     */
    function ProgressLine(props) {
      const row = props.row;
      const parts = Array.isArray(props.parts) ? props.parts : progressParts(row);
      if (row === null || row === undefined || parts.length === 0) return null;
      return h("span", { className: "dmesh-prog", title: progressTitle(row) }, [
        h("span", {
          key: "d",
          className: "dmesh-prog-dot" + (row.remoteLive === true ? " on" : row.live === true ? " warm" : ""),
        }),
        h("span", { key: "t", className: "dmesh-prog-text" }, parts.join(" · ")),
      ]);
    }

    /**
     * 「接管」按钮：把这条**在别处执行**的会话变成本机会话。
     *
     * 为什么需要它：进度看得见，但看得见不等于能接手 —— 源设备关机/掉线时，会话要接着
     * 跑就只能在本机落地（host 在线时按字节拉回，离线时用镜像重压）。落地之后它才出现在
     * 本机的会话列表里、可以打开续跑，命令也在本机执行（本机是属主）。
     *
     * 为什么要二次确认：本机可能**已有**这条会话的旧历史，接管会以对端为准覆盖它
     * （host 覆盖前会先备份到网格数据目录）。所以第一次点击只是「武装」，第二次才真的动手，
     * 并把会覆盖这件事写在按钮上。
     * @param {object} props `{ row, sessionId, deviceId }`。
     * @returns {object} 节点。
     */
    function TakeoverButton(props) {
      const row = props.row;
      const [armed, setArmed] = useState(false);
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);
      const overwrites = row !== null && row !== undefined && row.localHasEvents === true;
      const run = async () => {
        setBusy(true);
        setResult(null);
        try {
          const done = await api(R.takeover, { sessionId: props.sessionId, deviceId: props.deviceId }, "POST");
          setResult({
            ok: true,
            message: (done.mode === "replica" ? "已用本机镜像接管" : "已从 " + (done.deviceName || "对端") + " 拉回")
              + "（" + done.version + "，" + done.bytes + " 字节）。重新打开这条会话即可继续。",
          });
        } catch (failure) {
          setResult({ error: failure !== null && failure !== undefined && failure.message ? failure.message : String(failure) });
        } finally {
          setBusy(false);
          setArmed(false);
        }
      };
      const label = busy
        ? "接管中…"
        : armed
          ? (overwrites ? "确认覆盖并接管" : "确认接管")
          : (overwrites ? "更新并接管" : "接管");
      return h("span", { className: "dmesh-takeover" }, [
        h("button", {
          key: "b",
          type: "button",
          className: "dmesh-btn dmesh-btn-sm" + (armed ? " dmesh-btn-danger" : ""),
          disabled: busy,
          title: (overwrites
            ? "本机已有这条会话的旧历史；接管会以对端为准覆盖它（覆盖前先备份到网格数据目录）"
            : "把这条会话在本机落地：之后它出现在本机会话列表里，可打开、可续跑，命令在本机执行")
            + "\n源设备在线时按字节拉回；不可达时用本机镜像重压落地。",
          onClick: (event) => {
            event.stopPropagation();
            if (armed) void run();
            else setArmed(true);
          },
        }, label),
        result === null
          ? null
          : h("span", {
            key: "r",
            className: result.error !== undefined ? "dmesh-err-inline" : "dmesh-ok-inline",
          }, result.error !== undefined ? "接管失败：" + result.error : result.message),
      ]);
    }

    function RemoteWorkspacesSection(props) {
      const wide = props.wide === true;
      const [tree, setTree] = useState(null);
      const [error, setError] = useState(null);
      const [openWorkspaces, setOpenWorkspaces] = useState(() => new Set());
      const busy = useRef(false);

      const refresh = useCallback(async () => {
        if (busy.current) return;
        busy.current = true;
        try {
          const data = await api(R.tree);
          setTree(data.tree || null);
          setError(null);
        } catch (failure) {
          setError(failure);
        } finally {
          busy.current = false;
        }
      }, []);

      useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => { void refresh(); }, 30000);
        return () => window.clearInterval(timer);
      }, [refresh]);

      const devices = Array.isArray(tree?.devices) ? tree.devices : [];
      const remote = devices.filter((entry) => entry.self !== true);
      // 旧版 host 不下发 drivers：判不出方向时一切保持改动前（转发执行的画法）。
      const driversKnown = tree !== null && tree !== undefined
        && tree.drivers !== null && tree.drivers !== undefined && typeof tree.drivers === "object";

      const toggle = (setter, key) => setter((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });

      // 侧边栏收窄成 rail 时不渲染（那一侧本来就不展示工作区树）。
      if (!wide) return null;

      // ── 去重：同一个工作区不许在列表里出现两遍 ────────────────────────────
      // 设备网格的 workspaceId 是**跨设备共享**的（rpi 与本机注册表里
      // DSHpluginWorkSpace 是同一条 db264e09…）。所以「远端设备也报了这个工作区」
      // 99% 的情况不是「那台机器上另有一个工作区」，而是**同一个工作区的另一份
      // 清单快照** —— 把它平铺进侧边栏，用户看到的就是同一行工作区出现两遍，
      // 连它下面的会话也照抄一遍。
      //
      // 规则：
      //   1. 远端工作区的 id 在本机清单里也有 → 同一个工作区，**不再开第二行**；
      //      只把「本机清单里没有的会话」补在这一行上，且**行的标识用共享的
      //      workspaceId**（不是 `设备/工作区` 这种设备私钥）—— 默认 UI 里这条
      //      网络会话因此归到**同一个工作区**名下，而不是第二个工作区。
      //   2. 本机那份清单被截断过（droppedSessions > 0）时**无法判断**哪些会话
      //      真的只存在于对端：两边都只报了前 500 条，差异可能只是截断位置不同。
      //      这种工作区整行跳过（要看全量去「设备网格」面板的总览）。
      //   3. 本机清单完整（droppedSessions === 0）时，多出来的会话才是真的
      //      「只存在于对端」的会话，值得单独一行。
      //   4. 对端独有的工作区（本机没这个 id）照旧整行展示 —— 那不是重复。
      const localDevice = devices.find((entry) => entry.self === true);
      const localInventory = localDevice !== undefined && localDevice !== null ? localDevice.inventory : null;
      const localWorkspaces = localInventory !== null && localInventory !== undefined && Array.isArray(localInventory.workspaces)
        ? localInventory.workspaces
        : [];
      const localById = new Map();
      for (const workspace of localWorkspaces) {
        if (workspace !== null && workspace !== undefined && workspace.id !== undefined) localById.set(workspace.id, workspace);
      }
      const localSessionIds = (workspace) => {
        const ids = new Set();
        const sessions = workspace !== null && workspace !== undefined && Array.isArray(workspace.sessions) ? workspace.sessions : [];
        for (const session of sessions) if (session !== null && session !== undefined && session.id !== undefined) ids.add(session.id);
        return ids;
      };

      const rows = [];
      const usedKeys = new Set();
      for (const device of remote) {
        const inventory = device.inventory;
        const workspaces = inventory !== null && inventory !== undefined && Array.isArray(inventory.workspaces) ? inventory.workspaces : [];
        const deviceKey = device.deviceId || device.name || "dev";
        const deviceName = typeof device.name === "string" && device.name !== "" ? device.name : "(未命名设备)";
        const disconnected = device.liveness !== "online";
        for (const workspace of workspaces) {
          // 与出厂侧边栏的可见性规则对齐（sessionVisible）：子代理会话挂在父会话
          // 名下、**不能**用普通会话地址打开（宿主机直接拒：session/agent-busy
          // "subagent Sessions require their durable parent address"），已归档会话
          // 也不在本机列表里出现。侧边栏只列「点得开」的那批。
          const all = (Array.isArray(workspace.sessions) ? workspace.sessions : [])
            .filter((session) => session !== null && session !== undefined
              && session.origin !== "subagent" && session.archived !== true);
          // host 判据优先：`localMatch` 是 host 直接读**本机 workspaceRegistry** 得出的
          // 结论，比客户端拿 /tree 里的自身清单快照判更准 —— 刚开机、或自身清单被截断时，
          // 客户端判据会把同一个工作区再列一遍（实测重启后 self inventory 的 workspaces=0）。
          // host 没给结论（旧版 host）才退回下面的客户端判据。
          // 注意：这里**不**看 droppedSessions。`presentLocally` 是 host 按本机
          // workspaceRegistry 逐条判出来的，远端清单被截断不影响结论；反而把
          // `droppedSessions > 0` 当「无法判断」会让**每一个**被截断的工作区整行消失
          // （实测：清单上限 500，两台的 DSHpluginWorkSpace 都恰好 500 条）。
          if (workspace.localMatch !== null && workspace.localMatch !== undefined) {
            // 空会话壳（建了没用过、出厂显示成「New Session」的那种）**不算**
            // 「本机没有的会话」：它天生单边（从不「动」→ 永远不进会话镜像），
            // 拿它点亮一行 extras 只会让同一个工作区在侧边栏出现两遍。
            const only = all.filter((session) => session.presentLocally !== true && session.blank !== true);
            if (only.length === 0) continue;
            rows.push({
              device, inventory, deviceKey, deviceName, disconnected, workspace,
              sessions: only, sameAsLocal: true,
            });
            continue;
          }
          const same = localById.get(workspace.id);
          if (same !== undefined) {
            // 同一个工作区：本机清单被截断就整行跳过（差异可能只是截断位置）。
            if ((same.droppedSessions || 0) > 0) continue;
            const known = localSessionIds(same);
            const extra = all.filter((session) => !known.has(session.id));
            if (extra.length === 0) continue;
            rows.push({
              device, inventory, deviceKey, deviceName, disconnected, workspace,
              sessions: extra, sameAsLocal: true,
            });
            continue;
          }
          rows.push({
            device, inventory, deviceKey, deviceName, disconnected, workspace,
            sessions: all, sameAsLocal: false,
          });
        }
      }
      if (rows.length === 0) return null;

      // role=group：它就在出厂的 role="tree" 会话列表里，组内每行都是 treeitem。
      return h("div", { className: "dmesh-rw-list", key: "remote-ws", role: "group", "aria-label": "网络会话工作区" }, [
        error !== null
          ? h("div", { key: "err", className: "dmesh-remote-err" },
            "远程工作区读取失败：" + error.message + (error.code ? "（" + error.code + "）" : ""))
          : null,
        rows.map((row, index) => {
          const { deviceKey, deviceName, disconnected, workspace, sessions, sameAsLocal } = row;
          // 方向判据：drivers 说本机是属主，或 host 直接给了「本机也有这个工作区」
          // 的结论（localMatch）时，这一行是「会话在远端、命令发到本机」，
          // 不能再画成「命令与文件在别处」。
          // 但 localMatch 本身**不区分方向**：副本侧看对端清单时同样处处是 localMatch，
          // 所以副本侧（authority.isSelf === false）只认 drivers 的 owner 判定 ——
          // 否则副本侧的行会被整片翻成反方向（要防的正是这个）。
          const copySide = tree !== null && tree !== undefined
            && tree.authority !== null && tree.authority !== undefined && tree.authority.isSelf === false;
          const localOwner = workspaceOwnerIsSelf(tree, workspace)
            || (!copySide && workspace.localMatch !== null && workspace.localMatch !== undefined);
          const execMark = driverWorkspaceMark(tree, { workspaceId: workspace.id, path: workspace.path });
          // 行的标识：与本机同 id 的工作区用**共享的 workspaceId**（默认 UI 里它
          // 就是同一个工作区，不是第二个）；对端独有的工作区才带设备后缀，避免两台
          // 设备报同一个 id 时 React key 相撞。
          let wsKey = sameAsLocal === true ? String(workspace.id || index) : String(workspace.id || index) + "@" + deviceKey;
          while (usedKeys.has(wsKey)) wsKey = wsKey + "+";
          usedKeys.add(wsKey);
          const title = typeof workspace.title === "string" && workspace.title !== "" ? workspace.title : "(未命名工作区)";
          const expanded = openWorkspaces.has(wsKey);
          // 行结构与 CSS 逐条对齐出厂 Rows（projectRow / sessionRow）：
          // 34px/32px 高、0 8px 内边距、8px 圆角、16×20 的 slot、
          // 悬停换箭头、标题 14/20、时间 12/20 —— 远程工作区在侧边栏里看起来
          // 就是一条普通工作区，只有名称后缀指明它来自哪台设备。
          return h("div", { key: wsKey, className: "dmesh-rw-group" }, [
            h("div", {
              key: "row",
              className: "dmesh-rw-row dmesh-rw-project",
              role: "treeitem",
              "aria-expanded": expanded,
              onClick: () => toggle(setOpenWorkspaces, wsKey),
              title: (sameAsLocal === true
                ? "同一工作区在 " + deviceName + " 上的其它会话（本机清单里没有的 " + sessions.length + " 条）"
                : disconnected
                  ? "远程工作区（" + deviceName + "，当前未连接）：显示的是最后一次清单快照"
                  : "远程工作区（" + deviceName + "）：会话账目来自该设备的清单快照，不在本机")
                + "\n" + (workspace.path || ""),
            }, [
              h("span", { key: "folder", className: "dmesh-rw-slot dmesh-rw-folder" + (expanded ? " dmesh-rw-folderActive" : "") },
                expanded ? h(FolderOpenIcon) : h(FolderCloseIcon)),
              h("span", { key: "chevron", className: "dmesh-rw-slot dmesh-rw-chevron" },
                h(TriangleRightIcon, { className: "dmesh-rw-arrow" + (expanded ? " dmesh-rw-arrowOpen" : "") })),
              h("span", { key: "text", className: "dmesh-rw-projectText" }, [
                h("span", { key: "line", className: "dmesh-rw-titleline" }, [
                  h("span", { key: "title", className: "dmesh-rw-title" }, title),
                  // 这一格回答「这个工作区到底在哪台机器上执行」，两个方向：
                  //   · 本机是属主 → 会话在远端跑、命令会落到本机（⇄，琥珀色，执行端标示）；
                  //   · 否则 → 文件与命令在远端（地球，转发执行工作区）。
                  // drivers 在旧版 host 上不存在：那时判不出方向，保持改动前的画法。
                  execMark !== null
                    ? h(DriverMark, { key: "net", mark: execMark })
                    : (localOwner && driversKnown)
                      // 方向已确定是「本机属主」时不许再画「命令在别处」——
                      // 宁可不画，也不画一个反的（这正是 P1 之前那个错标的来源）。
                      ? null
                      : h("span", {
                        key: "net",
                        className: "dmesh-rw-net",
                        title: disconnected
                          ? "转发执行：命令与文件在 " + deviceName + " 上执行（该设备当前未连接）"
                          : "转发执行：命令与文件在 " + deviceName + " 上执行",
                      }, h(NetworkIcon)),
                  h("span", { key: "dev", className: "dmesh-rw-dev" + (disconnected ? " dmesh-rw-off" : "") },
                    " · " + deviceName + (disconnected ? "（未连接）" : "")),
                  // 同一工作区的补充行：点名「这是本机没有的那几条」，别被看成第二个工作区。
                  sameAsLocal === true
                    ? h("span", { key: "extra", className: "dmesh-rw-extra", title: "本机清单里没有的会话；相同 id 的工作区在上面那一行，不重复开工作区" },
                      "＋" + sessions.length)
                    : null,
                ]),
              ]),
              h("span", { key: "actions", className: "dmesh-rw-rowActions" },
                !disconnected && sessions.some((session) => session.live === true)
                  ? h("span", { key: "live", className: "dmesh-rw-count" }, "活跃")
                  : null),
            ]),
            expanded
              ? h("div", { key: "body", className: "dmesh-rw-sessions" }, [
                disconnected
                  ? h("div", { key: "off", className: "dmesh-rw-note" }, "设备未连接，下面是最后一次成功采集的清单快照。")
                  : null,
                sessions.length === 0
                  ? h("div", { key: "none", className: "dmesh-rw-note" },
                    sameAsLocal === true ? "没有只存在于该设备的会话" : "这个工作区没有会话")
                  : h("div", { key: "list" }, [
                    sameAsLocal === true
                      ? h("div", { key: "hint", className: "dmesh-rw-note" },
                        "本机没有的会话；日志与 agent 在 " + deviceName + "。跑完一轮会自动同步到本机，也可「接管」。")
                      : null,
                    sessions.map((session, s) =>
                      h(RemoteSessionRow, {
                        key: session.id || s,
                        session,
                        deviceName,
                        deviceId: deviceKey,
                        disconnected,
                        tree,
                        localOwner,
                      })),
                  ]),
                // 截断提示属于「远端工作区的整份清单」，不该跟着 extras 行（那是
                // 「本机没有的会话」）一起出现 —— 两件事，混在一起只会让人读错。
                sameAsLocal !== true && workspace.droppedSessions > 0
                  ? h("div", { key: "drop", className: "dmesh-rw-note" },
                    "另有 " + workspace.droppedSessions + " 条未列出（超过单设备上限）")
                  : null,
              ])
              : null,
          ]);
        }),
      ]);
    }

    // ── 执行端标示（本机是属主/执行侧）──────────────────────────────────────
    // 方向由 host 的 `drivers.js` 判定（随 /tree 下发在**内层** `tree.drivers`）：
    // 只有「会话侧不是本机」时才画 —— 那正是「agent 在别处跑、命令会发到本机」这件事。
    //
    // 判据一律**运行时证据优先、配置声明兜底**，且 `tree.drivers` 缺失时全部静默退化成
    // 改动前的样子（旧版 host 不下发这个字段，浏览器只会当它不存在）。

    /**
     * 按 id / 路径查一条工作区判定（与 host `drivers.js` 的 `findDriver` 同口径）。
     * 为什么要与 host 一致：同一个工作区在两边可能分别以 id 和路径出现，UI 两处拿到的
     * 形态不一样（侧边栏行给 id、面板给 workspace 对象），口径分叉会得出两个结论。
     * @param {object|undefined} drivers `tree.drivers`。
     * @param {{workspaceId?: string, path?: string}} query 查询。
     * @returns {object|null} 命中的判定。
     */
    function driverHit(drivers, query) {
      const workspaces = drivers !== null && drivers !== undefined && Array.isArray(drivers.workspaces) ? drivers.workspaces : [];
      const id = query !== null && query !== undefined && typeof query.workspaceId === "string" ? query.workspaceId : "";
      const raw = query !== null && query !== undefined && typeof query.path === "string" ? query.path : "";
      const path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
      if (id !== "") {
        const byId = workspaces.find((item) => item !== null && item !== undefined && item.workspaceId === id);
        if (byId !== undefined) return byId;
      }
      if (path !== "" && path !== "/") {
        const byPath = workspaces.find((item) => {
          if (item === null || item === undefined || typeof item.path !== "string") return false;
          const root = item.path.replace(/\/+$/, "");
          return root === path || path.startsWith(root + "/");
        });
        if (byPath !== undefined) return byPath;
      }
      return null;
    }

    /**
     * 本地时间（分钟级）。坏值回 ""：宁可少写一句，也不渲染 "Invalid Date"。
     * @param {unknown} value ISO 字符串或时间戳。
     * @returns {string} 形如 `2026-10-13 18:45` 的本机时间。
     */
    function clockTime(value) {
      if (typeof value !== "string" && typeof value !== "number") return "";
      const at = typeof value === "number" ? value : Date.parse(value);
      if (typeof at !== "number" || !Number.isFinite(at)) return "";
      const date = new Date(at);
      if (Number.isNaN(date.getTime())) return "";
      const pad = (n) => (n < 10 ? "0" + n : String(n));
      return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
        + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    }

    /**
     * 工作区级的执行端判定：**本机是属主/执行侧、会话在远端** → 要标的就是它。
     * 返回 null 表示「不该画」，三种原因都走这条路（drivers 缺失 / 会话侧就是本机 /
     * 本机不是属主）—— 没有证据就不要编造方向。
     * @param {object|null} tree /tree 的内层树。
     * @param {{workspaceId?: string, path?: string}} query 本行的标识。
     * @returns {{workspaceId: string, path: string, session: object, evidence: object}|null} 判定。
     */
    function driverWorkspaceMark(tree, query) {
      const drivers = tree !== null && tree !== undefined ? tree.drivers : undefined;
      if (drivers === null || drivers === undefined || typeof drivers !== "object") return null;
      const hit = driverHit(drivers, query);
      if (hit === null) return null;
      // 只标「会话在远端」：会话侧是本机时命令是**发出去**的，方向反过来，不归这里。
      if (hit.remote !== true) return null;
      const session = hit.session;
      if (session === null || session === undefined || session.isSelf !== false) return null;
      // 本机必须是属主，否则文案里的「命令与文件在本机执行」就是假话 —— 那属于
      // 「转发执行工作区」（另一种方向，另有标示）。
      if (hit.owner === null || hit.owner === undefined || hit.owner.isSelf !== true) return null;
      return {
        workspaceId: typeof hit.workspaceId === "string" ? hit.workspaceId : "",
        path: typeof hit.path === "string" ? hit.path : "",
        session,
        evidence: hit.evidence !== null && hit.evidence !== undefined ? hit.evidence : {},
      };
    }

    /**
     * 一条工作区账目是不是「本机属主」。只看 drivers：旧版 host 没这个字段 → false
     * （调用方据此保持改动前的画法）。
     * @param {object|null} tree /tree 的内层树。
     * @param {object} workspace 工作区账目。
     * @returns {boolean} 是否本机属主。
     */
    function workspaceOwnerIsSelf(tree, workspace) {
      const hit = driverHit(tree !== null && tree !== undefined ? tree.drivers : undefined, {
        workspaceId: workspace !== null && workspace !== undefined && typeof workspace.id === "string" ? workspace.id : "",
        path: workspace !== null && workspace !== undefined && typeof workspace.path === "string" ? workspace.path : "",
      });
      return hit !== null && hit.owner !== null && hit.owner !== undefined && hit.owner.isSelf === true;
    }

    /**
     * 执行端标记的 tooltip。只写**有证据**的行，缺证据的行一个字都不编。
     * @param {object} mark `driverWorkspaceMark` 的返回值。
     * @returns {string} 多行文案。
     */
    function driverMarkText(mark) {
      const session = mark.session !== null && mark.session !== undefined ? mark.session : {};
      const evidence = mark.evidence !== null && mark.evidence !== undefined ? mark.evidence : {};
      const name = (typeof session.name === "string" && session.name !== "" ? session.name : "某台远端设备")
        + (session.unresolved === true ? "（未连接）" : "");
      const lines = ["远端执行会话：agent 在 " + name + " 上运行，命令与文件在本机执行"];
      const total = Number(evidence.inboundTotal) || 0;
      const mirror = Number(evidence.mirrorSessions) || 0;
      if (total === 0) {
        // 「还没观察到」与「观察到 0 次」是两件事，这里是前者 —— 不假装知道。
        lines.push("（尚未观察到发往本机的命令）");
      } else {
        const devices = Array.isArray(evidence.inboundDevices)
          ? evidence.inboundDevices.filter((item) => typeof item === "string" && item !== "")
          : [];
        const at = clockTime(evidence.inboundLastAt);
        const parts = [];
        if (at !== "") parts.push("最近 " + at);
        if (devices.length > 0) parts.push("来自 " + devices.join("、"));
        lines.push("可能将命令发到本机：本机已收到 " + total + " 次执行请求"
          + (parts.length === 0 ? "" : "（" + parts.join("，") + "）"));
        if (typeof evidence.inboundLastCommand === "string" && evidence.inboundLastCommand !== "") {
          lines.push("最近一条命令：" + evidence.inboundLastCommand);
        }
      }
      if (mirror > 0) lines.push("另有 " + mirror + " 条会话的历史已镜像到本机");
      return lines.join("\n");
    }

    /**
     * 工作区行上的执行端标记（`⇄` + 琥珀色）。文案与 class 只有这一处，
     * 侧边栏「远程工作区」行、本机工作区行、设备网格面板的工作区行共用。
     * `mark` 为 null 时渲染 null —— 调用方不必自己判方向。
     * @param {{mark: object|null, tagKey?: string}} props 判定。
     * @returns {object|null} 元素。
     */
    function DriverMark(props) {
      const mark = props !== null && props !== undefined && props.mark !== undefined && props.mark !== null ? props.mark : null;
      if (mark === null) return null;
      return h("span", {
        key: typeof props.tagKey === "string" ? props.tagKey : "driver",
        className: "dmesh-driver-mark",
        title: driverMarkText(mark),
      }, h(DriverIcon));
    }

    /**
     * 远端会话行的执行端小标签（`⇄设备名`）。基准文案与警示样式只有这一处。
     * @param {object} tag `driverSessionTag` 的返回值。
     * @returns {object|null} 元素。
     */
    function DriverSessionTag(props) {
      const tag = props !== null && props !== undefined && props.tag !== undefined && props.tag !== null ? props.tag : null;
      if (tag === null || typeof tag.deviceName !== "string" || tag.deviceName === "") return null;
      return h("span", {
        key: "dev",
        className: "dmesh-rw-devtag" + (tag.warn === true ? " dmesh-rw-devtagWarn" : ""),
        title: tag.title,
      }, "⇄" + tag.deviceName);
    }

    /**
     * 一条远端会话的 `⇄设备名` 标签文案。
     *
     * 方向：`localOwner`（所属工作区是本机属主）或**本机真的收到过它发来的命令**
     * 时，说法是「命令与文件在本机执行」；否则保持改动前的说法
     * （「日志与 agent 在别处」），一个字都不改 —— 副本侧走的正是这条路。
     *
     * 只认「有入站执行」而不认「driver 里有条目」：镜像索引在会话侧也可能存在，
     * 拿它定方向会把副本侧也翻过来（实测要防的正是这个）。
     * @param {object|null} tree /tree 的内层树。
     * @param {object} session 会话账目。
     * @param {string} deviceName 会话侧设备名的兜底值（行上已有的那个）。
     * @param {boolean} localOwner 所属工作区是否本机属主。
     * @returns {{deviceName: string, warn: boolean, title: string}|null} 标签。
     */
    function driverSessionTag(tree, session, deviceName, localOwner) {
      const id = session !== null && session !== undefined && typeof session.id === "string" ? session.id : "";
      const drivers = tree !== null && tree !== undefined ? tree.drivers : undefined;
      const list = drivers !== null && drivers !== undefined && Array.isArray(drivers.sessions) ? drivers.sessions : [];
      const hit = id === "" ? undefined : list.find((item) => item !== null && item !== undefined && item.sessionId === id);
      const inbound = hit !== undefined ? Number(hit.inbound) || 0 : 0;
      // 设备名优先用 drivers 给的会话侧名称：面板里这一行的所属设备可能是**本机**
      // （本机属主、会话在远端），拿本机名当「会话在哪台」就反了。
      const shown = hit !== undefined && typeof hit.deviceName === "string" && hit.deviceName !== ""
        ? hit.deviceName
        : deviceName;
      if (typeof shown !== "string" || shown === "") return null;
      const executionSide = localOwner === true || inbound > 0;
      if (!executionSide) {
        return { deviceName: shown, warn: false, title: "远端会话：日志与 agent 在 " + shown + "，本机只能复制它的 id" };
      }
      const lines = ["远端会话：agent 在 " + shown + "，命令与文件在本机执行 —— 可能将命令发到本机"];
      if (inbound > 0) {
        const at = clockTime(hit.inboundLastAt);
        lines.push("本机已收到它发来的 " + inbound + " 次执行" + (at === "" ? "" : "（最近 " + at + "）"));
      }
      if (hit !== undefined && hit.mirror === true) {
        const events = Number(hit.mirrorEvents) || 0;
        lines.push("历史已镜像到本机" + (events > 0 ? "（" + events + " 事件）" : ""));
      }
      return { deviceName: shown, warn: inbound > 0, title: lines.join("\n") };
    }

    /**
     * 本机工作区行上的「网络标示」。
     *
     * 为什么标在**本机那一行**上：同一个工作区（同 id / 同路径）在两台机器上都有一份
     * 账目，侧边栏只会保留本机那一行（远端不再列第二遍）。「这个工作区的命令与文件
     * 其实在另一台设备上执行 / 它的会话正在别处续跑」这件事必须落在仅剩的那一行上，
     * 否则去重之后侧边栏就再也看不出哪个是转发执行工作区。
     *
     * 两个方向，判据不同、画法也不同：
     *   · **副本侧**（本机不是会话行为权威）：属主/执行侧在别处，画地球图标；
     *   · **属主/执行侧**：会话在远端跑、命令会落到本机，画 ⇄（执行端标示）。
     *     这是 P1 那个 `return null` 砍掉、但执行端必须有的一枚。
     */
    function WorkspaceNetworkMark(props) {
      const { tree } = useMeshTree();
      const workspaceId = typeof props.workspaceId === "string" ? props.workspaceId : "";
      const path = typeof props.path === "string" ? props.path : "";
      if (workspaceId === "" && path === "") return null;
      const authority = tree !== null && tree !== undefined ? tree.authority : undefined;
      // P1：只有**副本侧**（本机不是权威）才画「属主在别处」的标示，否则属主自己的工作区
      // 会被误标成转发执行工作区（opi 的 DSHpluginWorkSpace 就是）。
      if (authority !== undefined && authority.isSelf === false) {
        if (workspaceId === "") return null;
        const devices = Array.isArray(tree?.devices) ? tree.devices : [];
        const sharers = [];
        for (const device of devices) {
          if (device.self === true) continue
          const workspaces = device.inventory !== null && device.inventory !== undefined && Array.isArray(device.inventory.workspaces) ? device.inventory.workspaces : [];
          const deviceName = typeof device.name === "string" && device.name !== "" ? device.name : "(未命名设备)";
          const hit = workspaces.find((workspace) => workspace !== null && workspace !== undefined
            && workspace.localMatch !== null && workspace.localMatch !== undefined
            && workspace.localMatch.workspaceId === workspaceId);
          if (hit !== undefined) sharers.push({ deviceName, disconnected: device.liveness !== "online" });
        }
        if (sharers.length === 0) return null;
        const names = sharers.map((entry) => entry.deviceName + (entry.disconnected ? "（未连接）" : "")).join("、");
        return h("span", {
          key: "net",
          className: "dmesh-rw-net",
          title: "副本工作区：属主/执行侧是 " + names + "；本机的会话行为先送属主判定，结果回来后才应用",
        }, h(NetworkIcon));
      }
      // ── 属主/执行侧 ──
      // 只有权威就是本机时才有「命令会发到本机」这回事。authority 缺失 = 旧版 host
      // （那时连 drivers 都没有），行为与改动前逐字一致：什么都不画。
      if (authority === undefined || authority.isSelf !== true) return null;
      return h(DriverMark, { mark: driverWorkspaceMark(tree, { workspaceId, path }), tagKey: "net" });
    }

    /**
     * 一条远程会话行：结构与出厂 sessionRow 一致（slot + 标题 + 时间 + 悬停操作），
     * 只是点击动作是**复制会话 id** —— 远端会话不能在本机打开，不做假的打开。
     */
    function RemoteSessionRow(props) {
      const session = props.session || {};
      const deviceName = typeof props.deviceName === "string" && props.deviceName !== "" ? props.deviceName : "";
      const [copied, setCopied] = useState(false);
      // 会话标示的方向：所属工作区是本机属主、或 drivers 里这条会话有运行时证据时，
      // 说法是「命令与文件在本机执行」；否则保持改动前的「日志与 agent 在别处」。
      const tag = driverSessionTag(props.tree, session, deviceName, props.localOwner === true);
      // 本机镜像里的进度：会话在别处跑，本机只能看到镜像 —— 这正是「执行端不该是瞎子」
      // 的那部分。没有镜像（对端没开镜像、或这条会话从不「动」）时静默不渲染。
      const { rows } = useReplicaProgress();
      const progress = progressFor(rows, typeof session.id === "string" ? session.id : "");
      const copy = () => {
        const id = typeof session.id === "string" ? session.id : "";
        if (id === "") return;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) void navigator.clipboard.writeText(id);
          else {
            const area = document.createElement("textarea");
            area.value = id;
            document.body.appendChild(area);
            area.select();
            document.execCommand("copy");
            document.body.removeChild(area);
          }
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          setCopied(false);
        }
      };
      const progressNode = progressParts(progress).length === 0 ? null : h(ProgressLine, { key: "prog", row: progress });
      return h("div", {
        className: "dmesh-rw-row dmesh-rw-session" + (progressNode === null ? "" : " dmesh-rw-sessionTall"),
        role: "treeitem",
        onClick: copy,
        title: (typeof session.id === "string" ? session.id : "")
          + "\n点击复制会话 id（远端会话不能在本机打开；要在这里继续请用「接管」）"
          + (progress === null ? "" : "\n" + progressTitle(progress)),
      }, [
        h("span", { key: "s", className: "dmesh-rw-slot" },
          h("span", { className: "dmesh-rw-dot" + (session.live === true || (progress !== null && progress.remoteLive === true) ? " on" : "") })),
        h("span", { key: "body", className: "dmesh-rw-sessBody" }, [
          h("span", { key: "line", className: "dmesh-rw-sessLine" }, [
            h("span", { key: "t", className: "dmesh-rw-title" }, sessionTitle(session)),
            // 远端会话标示：`⇄设备名`。本机会话与远端会话的行结构与度量完全一致，
            // 这一格就是让人一眼分出「这条在别的机器上」的东西。方向文案与告警样式
            // 统一由 driverSessionTag 给（本机属主时说法反过来、有入站证据时转警示色）。
            h(DriverSessionTag, { key: "dev", tag }),
            h("span", { key: "time", className: "dmesh-rw-time" }, relTime(session.lastActivityAt ?? session.createdAt)),
          ]),
          progressNode,
        ]),
        h("span", { key: "a", className: "dmesh-rw-rowActions" }, [
          // 已经同步到本机（上下文就在本地）时不再摆接管按钮：那件事已经自动做完了。
          progress !== null && progress.canTakeover === true && progress.synced !== true
            ? h(TakeoverButton, {
              key: "take",
              row: progress,
              sessionId: typeof session.id === "string" ? session.id : "",
              deviceId: typeof props.deviceId === "string" ? props.deviceId : undefined,
            })
            : null,
          h("button", {
            key: "copy",
            type: "button",
            className: "dmesh-rw-iconButton",
            "aria-label": "复制会话 id",
            title: copied ? "已复制" : "复制会话 id",
            onClick: (event) => {
              event.stopPropagation();
              copy();
            },
          }, h(CopyIcon)),
        ]),
      ]);
    }

    // ── 注册 ────────────────────────────────────────────────────────────────
    const inject = ["slots"];

    function apply(ctx) {
      injectStyles();

      // 侧边栏面板按钮。id 与 main 的 key 必须逐字相同（见文件头注释）。
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
        name: "sidebar.panellist",
        id: "dsh-device-mesh",
        order: 30,
        label: "设备网格",
      }, (ownerProps) => h(MeshGlyph, {
        size: ownerProps && typeof ownerProps.size === "number" ? ownerProps.size : 18,
        active: !!(ownerProps && ownerProps.active),
      })));

      // 主列面板。
      ctx.slots.inject("main", () => ctx.slots.register({
        name: "main",
        key: "dsh-device-mesh",
      }, () => h(MeshPanel)));

      // 侧边栏工作区列表之后的「远程工作区」段。
      // 槽位由出厂 dsh-client-ui-workspace 声明（本 profile 已给工厂打上声明 +
      // 渲染补丁，见 plugins/dsh-device-mesh/FACTORY-PATCH-NOTES.md）。工厂没打
      // 补丁时这个 inject 永远等不到声明，静默不渲染 —— 不会因此报错。
      // 本机工作区行上的网络标示：槽位由工厂补丁声明（FACTORY-PATCH-NOTES.md §9）。
      // register 的签名是 (options, component)：组件是**第二个位置参数**，放进
      // options 里会被忽略；list 槽还必须有 options.id，否则 register 直接抛。
      // 工厂没打补丁时这个 inject 等不到声明，静默不渲染 —— 不会因此报错。
      ctx.slots.inject("sidebar.workspaces.row.mark", () => ctx.slots.register({
        name: "sidebar.workspaces.row.mark",
        id: "dsh-device-mesh-workspace-mark",
        order: 10,
      }, (ownerProps) => h(WorkspaceNetworkMark, ownerProps || {})));
      ctx.slots.inject("sidebar.workspaces.remote", () => ctx.slots.register({
        name: "sidebar.workspaces.remote",
        id: "dsh-device-mesh-remote-workspaces",
        order: 10,
      }, (ownerProps) => h(RemoteWorkspacesSection, {
        wide: !!(ownerProps && ownerProps.wide),
      })));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
