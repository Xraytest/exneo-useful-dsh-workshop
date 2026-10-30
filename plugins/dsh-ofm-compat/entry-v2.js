/**
 * ofm-compat（v2）—— dsh-our-free-model 在本机内核线（dsh 0.1.5-rc.3）上的两处兼容垫片。
 *
 * 维护须知（重要）
 * ----------------
 * 本 profile 没开模块热载（hmr 只监视 patch 文件），而 cordis 的 loader 按
 * specifier 缓存模块；实测结论：
 *   - 行名带 `?query` → 行挂不上（loader 不做 URL 查询串解析）；
 *   - 行名指向**新文件** → 会重新导入并重新 apply（旧文件可删）。
 * 所以要改这里的实现：把实现写进 `entry-v<N+1>.js`，删掉旧文件，再把
 * profiles/web/cordis.patch.yml 里 ofm-compat 那行的 name 指过去即可热生效。
 *
 * 桥 1：connection.admit（准入围栏）
 * ---------------------------------
 * 插件 v1.4.6 的围栏只认 `connection.admit(req) → { rejection?: number }`，
 * 而本版内核的 connection 服务暴露的是 `requestRejection(req) → 403|401|undefined`。
 * 调用不存在的 admit 会抛异常，被 rejectionFor 一律记成 503 admission-error，
 * 于是 /api/our-free-model/*（设置页、公告、看板、升级）每个请求都 503。
 * 这里补一个语义完全相同的方法：用的就是内核自己那道准入判定，放行回 undefined，
 * 拒绝原样透传状态码。围栏强度不变（实测：带 cookie 200 / 无 cookie 401 / 跨域 403）。
 *
 * 桥 2：profileContext（EAC 协付渠道的宿主闸门）
 * ----------------------------------------------
 * EAC 协付渠道（六个旗舰：DeepSeek V4.1 Flash / Kimi K3 / Kimi K2.6 / GLM-5.3 /
 * GLM-5.3 Flash / GPT-OSS 20B）的宿主闸门读 `ctx.get('profileContext')?.name`
 * （vault.js:detectSealedHost）——它接受内核声明的 `web` / `web-desktop` 档案
 * （插件 v1.4.6 的 issues #58/#59 明确把 dsh web 纳入）。但本版内核**没有**
 * 这个服务（全内核包 grep 命中 0），于是 profileName 为 undefined → 闸门判 null
 * → 渠道整体黑暗（/summary 里 laneAvailable=false）。
 * 这里不伪造、不猜测：读**本进程自己那条 dsh 启动参数**里的 `--profile <名>`
 * ——那正是"内核声明的档案"本身，任何非 dsh 进程都拿不到这一行；闸门要挡住的
 * "没有 DSH 内核的进程"因此照样挡得住。内核日后自带该服务时本桥自动让位。
 *
 * 两桥都不发布别的服务、不写盘、不联网。
 */
export const name = 'ofm-compat';

/** 从本进程的启动参数里取内核自己声明的 profile 名（`--profile x` / `--profile=x`）。 */
function profileFromArgv(argv) {
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = String(list[i] ?? '');
    if (arg === '--profile') {
      const next = String(list[i + 1] ?? '').trim();
      if (next !== '' && !next.startsWith('-')) return next;
    } else if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length).trim();
      if (value !== '') return value;
    }
  }
  return undefined;
}

export function apply(ctx) {
  const logger = ctx.logger ?? {};

  // ── 桥 1：connection.admit ────────────────────────────────────────────────
  ctx.inject(['connection'], scope => {
    const connection = scope.connection;
    scope.effect(() => {
      if (connection === undefined || connection === null) return () => {};
      if (typeof connection.admit === 'function') return () => {};
      if (typeof connection.requestRejection !== 'function') return () => {};
      const bridge = req => {
        const status = connection.requestRejection(req);
        return status === undefined ? undefined : { rejection: status };
      };
      Object.defineProperty(connection, 'admit', { value: bridge, configurable: true, writable: true });
      logger.info?.('ofm-compat: connection.admit 垫片已装（requestRejection → {rejection}）');
      return () => {
        try { delete connection.admit; } catch { /* 服务已随 fiber 一起走 */ }
      };
    }, 'ofm-compat: connection.admit 垫片');
  });

  // ── 桥 2：profileContext ─────────────────────────────────────────────────
  const declared = profileFromArgv(process.argv);
  const existing = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
  if (existing !== undefined) {
    logger.info?.('ofm-compat: 内核已自带 profileContext，垫片跳过');
  } else if (declared === undefined) {
    logger.warn?.('ofm-compat: 启动参数里没有 --profile，未提供 profileContext（EAC 保持关闭）');
  } else {
    try {
      ctx.provide('profileContext', { name: declared });
      logger.info?.(`ofm-compat: profileContext 垫片已装（内核启动参数声明 profile=${declared}）`);
    } catch (error) {
      logger.warn?.(`ofm-compat: profileContext 垫片安装失败：${error?.message ?? error}`);
    }
  }
}