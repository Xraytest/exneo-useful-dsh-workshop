/**
 * host 半边冒烟自测：fake ctx 走完整 apply → 断言三条工作箱路由真的挂上并能应答。
 * 2026-11-21 修复的回归防线：此前 apply 时刻 webServer 未就绪导致路由静默不挂
 * （UI 灰、/dsh-orchestrator/* 404），而单测只覆盖纯函数、从未验证挂载链路。
 *
 * 运行：node host-selftest.mjs   （在 dsh-orchestrator 目录，需先 npm run build）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'orch-smoke-'))
process.env.DSH_HOME = home

const plugin = await import('./lib/index.js')

const routes = new Map()
const tools = new Map()
const logs = []
const ctx = {
  logger: { info(){}, warn(){}, error(){} },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  on() { return () => {} },
  get(key) { return key === 'sessions' ? { get: () => undefined } : undefined },
  webServer: {
    register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
  },
  tools: {
    register(def, opts) { tools.set(def.name, { def, opts }); return () => tools.delete(def.name) },
  },
}

await plugin.apply(ctx, { dataDir: join(home, 'runs') })

const failures = []
const check = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) failures.push(label) }

// ── 工具注册 ──
// cordis unwrapExports：有 default 导出时具名 inject/Config 会被丢弃（灰行事故根因）
check('模块无 default 导出（loader unwrap 陷阱）', plugin.default === undefined)
check('inject 声明含 webServer', JSON.stringify(plugin.inject).includes('webServer'))
check('orch_run 已注册', tools.has('orch_run'))
check('orch_status 已注册', tools.has('orch_status'))
check('orch_cancel 已注册', tools.has('orch_cancel'))
check('orch_run 带 when 门控', typeof tools.get('orch_run')?.opts?.when === 'function')

// ── 路由挂载（本次修复的核心断言）──
check('status 路由已挂载', routes.has('/dsh-orchestrator/status'))
check('action 路由已挂载', routes.has('/dsh-orchestrator/action'))
check('menu 路由已挂载', routes.has('/dsh-orchestrator/menu'))

const call = async (path, method = 'GET', body = null, headers = {}) => {
  const [routePath] = path.split('?')
  const handler = routes.get(routePath)
  if (handler === undefined) throw new Error('no route ' + routePath)
  const req = {
    method,
    url: path,
    headers: { origin: 'http://127.0.0.1:8173', host: '127.0.0.1:8173', ...headers },
    on(event, cb) {
      if (body === null) return
      const text = JSON.stringify(body)
      if (event === 'data') setImmediate(() => cb(Buffer.from(text)))
      if (event === 'end') setImmediate(() => cb())
    },
    destroy() {},
  }
  let status = null
  let payload = null
  let ended = false
  const res = {
    headersSent: false,
    writeHead(code) { this.headersSent = true; status = code },
    end(text) { payload = text; ended = true },
  }
  await handler(req, res)
  // 路由 wrapper 是 fire-and-forget：异步 handler 的写出在微任务/setImmediate 之后
  for (let i = 0; i < 100 && !ended; i++) await new Promise((settle) => setTimeout(settle, 2))
  if (!ended) throw new Error('handler did not settle within 200ms: ' + path)
  return { status, payload: payload === null ? null : JSON.parse(payload) }
}

// ── workbench 属主契约：GET /status ──
const st = await call('/dsh-orchestrator/status?sessionId=s1')
check('status 200', st.status === 200)
check('status.running=false（0.2.0 新会话默认关闭）', st.payload?.running === false)
check('status 带 menu 声明', st.payload?.menu?.route === '/dsh-orchestrator/menu')
check('status 带 phase', typeof st.payload?.phase === 'string')

// ── POST /action：拨开（存 true，按会话记住）──
const on = await call('/dsh-orchestrator/action', 'POST', { sessionId: 's1', enabled: true })
check('action 开 200', on.status === 200 && on.payload?.running === true)
const st2 = await call('/dsh-orchestrator/status?sessionId=s1')
check('开后 status.running=true', st2.payload?.running === true)

// ── 再拨关（双向持久化）──
const off = await call('/dsh-orchestrator/action', 'POST', { sessionId: 's1', enabled: false })
check('action 关 200', off.status === 200 && off.payload?.running === false)
const st3 = await call('/dsh-orchestrator/status?sessionId=s1')
check('关后 status.running=false', st3.payload?.running === false)

// ── 新会话仍是默认关 ──
const fresh = await call('/dsh-orchestrator/status?sessionId=brand-new')
check('新会话默认 running=false', fresh.payload?.running === false)

// ── 跨域拒绝 ──
const cross = await call('/dsh-orchestrator/action', 'POST', { sessionId: 's1', enabled: true }, { origin: 'http://evil.example' })
check('跨域 POST 403', cross.status === 403)

// ── GET /menu：声明式 spec ──
const menu = await call('/dsh-orchestrator/menu?sessionId=s1')
check('menu 200', menu.status === 200)
check('menu 通用件齐全', Array.isArray(menu.payload?.items) && menu.payload.items.length >= 5)
check('menu phase=off（本会话当前关）', menu.payload?.phase === 'off')
const badOp = await call('/dsh-orchestrator/menu', 'POST', { sessionId: 's1', op: 'nope' })
check('未知 op 400', badOp.status === 400)

rmSync(home, { recursive: true, force: true })
console.log(logs.length ? logs.join('\n') : '')
console.log(failures.length === 0 ? 'SELFTEST PASS' : 'SELFTEST FAIL (' + failures.length + ')')
process.exit(failures.length === 0 ? 0 : 1)