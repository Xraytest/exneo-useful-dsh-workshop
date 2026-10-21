/**
 * 「ZCode 反代」设置页（浏览器半边，本机新增 v2）。
 *
 * 设计目标：简洁易懂 ——
 *   · 账号列表（表格）：每个账号一行，标平台徽章（Z.AI / BigModel）、用户名、订阅计划
 *   · 账号余额：一键刷新，展示套餐 + 额度余量
 *   · 登录：两个平台各一个按钮
 *   · 通道：注入的 provider 与平台是否匹配（一行）
 *   · 通道测试：真跑一轮
 * 不再堆大段说明文字；细节看 DEPLOY-NOTES.md。
 *
 * 模块形态跟本 profile 其它 client 半边一致：window.__ModuleLoader__.load({id, factory})。
 */
window.__ModuleLoader__.load({
  id: 'dsh-zcode-cli-proxy',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const h = react.createElement
    const { useCallback, useEffect, useRef, useState } = react

    const API = '/dsh-zcode-cli-proxy'

    const CSS = [
      '.zcp-page{padding:4px 2px 24px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;max-width:760px;}',
      '.zcp-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.zcp-title{font-size:15px;font-weight:600;}',
      '.zcp-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);}',
      '.zcp-spacer{flex:1;}',
      '.zcp-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.zcp-card-head{display:flex;align-items:center;gap:8px;}',
      '.zcp-card-title{font-size:13px;font-weight:600;}',
      '.zcp-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;}',
      '.zcp-ok{background:var(--dsw-alias-state-success-primary);}',
      '.zcp-bad{background:var(--dsw-alias-state-error-primary);}',
      '.zcp-warn{background:var(--dsw-alias-state-warn-primary);}',
      '.zcp-idle{background:var(--dsw-alias-label-tertiary);}',
      '.zcp-table{width:100%;border-collapse:collapse;font-size:12px;}',
      '.zcp-table th{text-align:left;color:var(--dsw-alias-label-secondary);font-weight:500;padding:4px 8px 4px 0;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.zcp-table td{padding:6px 8px 6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;}',
      '.zcp-table tr:last-child td{border-bottom:none;}',
      '.zcp-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;line-height:1.6;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);white-space:nowrap;}',
      '.zcp-badge-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
      '.zcp-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;}',
      '.zcp-k{color:var(--dsw-alias-label-secondary);font-size:12px;}',
      '.zcp-v{font-size:12px;word-break:break-all;}',
      '.zcp-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;font-size:12px;line-height:1.5;cursor:pointer;}',
      '.zcp-btn:disabled{opacity:.5;cursor:default;}',
      '.zcp-btn-primary{border-color:var(--dsw-alias-state-business-primary);}',
      '.zcp-url{font-size:12px;font-family:var(--ds-font-family-code,monospace);word-break:break-all;background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:8px;border:1px dashed var(--dsw-alias-border-l1);}',
      '.zcp-err{color:var(--dsw-alias-state-error-primary);font-size:12px;}',
      '.zcp-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
    ].join('')

    function injectStyles() {
      if (typeof document === 'undefined') return
      const tagId = 'dsh-zcode-cli-proxy/page.css'
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-zcode-cli-proxy'
      style.dataset.pluginCss = tagId
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function call(path, options) {
      const response = await fetch(API + path, { credentials: 'same-origin', ...options })
      let body
      try {
        body = await response.json()
      } catch {
        body = { error: `HTTP ${response.status}` }
      }
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    const dot = (kind) => h('span', { className: 'zcp-dot ' + kind })

    function Card({ title, status, right, children }) {
      return h('div', { className: 'zcp-card' },
        h('div', { className: 'zcp-card-head' },
          status === undefined ? null : dot(status),
          h('div', { className: 'zcp-card-title' }, title),
          h('div', { className: 'zcp-spacer' }),
          right ?? null),
        children)
    }

    const PLATFORM_LABEL = { zai: 'Z.AI', bigmodel: 'BigModel' }
    const PLAN_LABEL = {
      'individual-coding-plan': '标准订阅',
      'start-plan': 'Start Plan',
      'team-coding-plan': '团队订阅',
    }

    // ── 账号列表 + 余额 ─────────────────────────────────────────────────────
    function AccountsCard({ status, refresh }) {
      const accounts = status?.account?.accounts ?? []
      const [balance, setBalance] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      const loadBalance = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          setBalance(await call('/balance'))
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { loadBalance() }, [loadBalance, status?.account?.updatedAt])

      const quotaCell = (platform) => {
        const item = (balance?.items ?? []).find((entry) => entry.platform === platform)
        if (balance === null) return h('span', { className: 'zcp-muted' }, '查询中…')
        if (item === undefined) return '—'
        if (item.error !== null && item.subscription === null && item.quota === null) {
          return h('span', { className: 'zcp-muted' }, item.error)
        }
        const rows = []
        if (item.quota !== null && item.quota.length > 0) {
          for (const q of item.quota) {
            const reset = q.nextResetTime ? `（重置 ${q.nextResetTime.slice(5, 16).replace('T', ' ')}）` : ''
            if (q.remaining !== null || q.remaining === 0) {
              rows.push(`${q.type ?? '额度'}：剩余 ${q.remaining ?? '?'} / ${q.unit ?? '?'}${reset}`)
            } else if (Array.isArray(q.models)) {
              rows.push(`${q.models.join('/') ?? q.type}：剩余 ${q.remaining ?? '?'} / ${q.unit ?? '?'}${reset}`)
            }
          }
        } else {
          rows.push('（无额度记录）')
        }
        const subs = (item.subscription ?? []).map((s) => s.productName).join('、')
        return h('div', null,
          subs ? h('div', { className: 'zcp-v' }, subs) : null,
          ...rows.map((line, i) => h('div', { className: 'zcp-v', key: i }, line)),
          item.error ? h('div', { className: 'zcp-muted' }, item.error) : null)
      }

      return h(Card, {
        title: '账号',
        status: accounts.length > 0 ? 'ok' : 'bad',
        right: h('button', { className: 'zcp-btn', onClick: loadBalance, disabled: busy }, busy ? '查询中…' : '刷新余额'),
      },
      accounts.length === 0
        ? h('div', { className: 'zcp-muted' }, '没有已登录账号（用下面的按钮登录）')
        : h('table', { className: 'zcp-table' },
          h('thead', null, h('tr', null,
            h('th', null, '平台'),
            h('th', null, '账号'),
            h('th', null, '订阅'),
            h('th', null, '余额'))),
          h('tbody', null, ...accounts.map((account, i) => h('tr', { key: i },
            h('td', null,
              h('span', { className: 'zcp-badge' + (account.active ? ' zcp-badge-on' : '') },
                PLATFORM_LABEL[account.platform] ?? account.platform),
              account.active ? h('span', { className: 'zcp-muted' }, ' 当前') : null),
            h('td', null, account.username ?? account.accountId ?? '—'),
            h('td', null, account.plans.length === 0
              ? '—'
              : account.plans.map((plan, j) => PLAN_LABEL[plan.mode] ?? plan.mode ?? '—')
                .filter((v, idx, arr) => arr.indexOf(v) === idx).join('、')),
            h('td', null, quotaCell(account.platform)))))),
      error ? h('div', { className: 'zcp-err' }, error) : null)
    }

    // ── 登录（两个平台）──────────────────────────────────────────────────────
    function LoginCard({ status, refresh }) {
      const zai = status?.login ?? {}
      const bm = status?.loginBigmodel ?? {}
      const [zaiState, setZaiState] = useState(zai)
      const [bmState, setBmState] = useState(bm)
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState(null)
      const timer = useRef()

      const poll = useCallback(async () => {
        try {
          const [z, b] = await Promise.all([call('/login/state'), call('/login/bigmodel/state')])
          setZaiState(z)
          setBmState(b)
          if (!z.running && !b.active) {
            if (timer.current) clearInterval(timer.current)
            timer.current = undefined
            await refresh()
          }
        } catch (cause) {
          setError(String(cause?.message ?? cause))
          if (timer.current) clearInterval(timer.current)
          timer.current = undefined
        }
      }, [refresh])

      useEffect(() => {
        if ((zaiState?.running || bmState?.active) && timer.current === undefined) {
          timer.current = setInterval(poll, 2000)
        }
        return () => {
          if (timer.current) clearInterval(timer.current)
          timer.current = undefined
        }
      }, [zaiState?.running, bmState?.active, poll])

      const start = async (platform) => {
        setBusy(platform)
        setError(null)
        try {
          if (platform === 'zai') setZaiState(await call('/login/start', { method: 'POST' }))
          else setBmState(await call('/login/bigmodel/start', { method: 'POST' }))
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(null)
        }
      }
      const cancel = async (platform) => {
        try {
          if (platform === 'zai') setZaiState(await call('/login/cancel', { method: 'POST' }))
          else setBmState(await call('/login/bigmodel/cancel', { method: 'POST' }))
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }

      const flowUrl = zaiState?.url ?? bmState?.url
      const flowRunning = zaiState?.running || bmState?.active
      const flowPlatform = bmState?.active ? 'bigmodel' : 'zai'

      return h(Card, { title: '登录账号', status: flowRunning ? 'warn' : 'idle',
        right: h('div', null,
          h('button', { className: 'zcp-btn', style: { marginRight: 6 }, onClick: () => start('zai'), disabled: busy !== null || flowRunning }, '登录 Z.AI'),
          h('button', { className: 'zcp-btn', onClick: () => start('bigmodel'), disabled: busy !== null || flowRunning }, '登录 BigModel')),
      },
      flowUrl
        ? h('div', null,
          h('div', { className: 'zcp-hint' }, `在浏览器打开链接完成 ${PLATFORM_LABEL[flowPlatform]} 授权（10 分钟内有效）：`),
          h('div', { className: 'zcp-url' },
            h('a', { href: flowUrl, target: '_blank', rel: 'noreferrer noopener' }, flowUrl)),
          h('div', { style: { marginTop: 6 } },
            h('button', { className: 'zcp-btn', onClick: () => cancel(flowPlatform) }, '取消')))
        : h('div', { className: 'zcp-muted' }, 'Z.AI = chat.z.ai 国际站（Start Plan）；BigModel = bigmodel.cn 中国站（标准订阅 GLM Coding）'),
      error ? h('div', { className: 'zcp-err' }, error) : null)
    }

    // ── 通道匹配 ────────────────────────────────────────────────────────────
    function ChannelCard({ status }) {
      const channel = status?.channel ?? {}
      const ok = channel.familyMatches === true
      const accountFamily = channel.accountFamily
      return h(Card, { title: '通道（模型选择器标注对应关系）', status: ok ? 'ok' : channel.familyMatches === false ? 'bad' : 'idle' },
        h('table', { className: 'zcp-table' },
          h('tbody', null,
            h('tr', null, h('td', { className: 'zcp-k' }, '注入渠道'), h('td', null,
              `${channel.injectedPlanLabel ?? '—'} · ${channel.injectedProviderId ?? '—'}（${PLATFORM_LABEL[channel.injectedFamily] ?? channel.injectedFamily ?? '?'}）`)),
            h('tr', null, h('td', { className: 'zcp-k' }, '可用模型'), h('td', null, (channel.injectedModels ?? []).join(' / '))),
            h('tr', null, h('td', { className: 'zcp-k' }, '账号平台'), h('td', null, accountFamily ? PLATFORM_LABEL[accountFamily] ?? accountFamily : '未登录')),
            h('tr', null, h('td', { className: 'zcp-k' }, '匹配'), h('td', null,
              ok ? '匹配' : channel.familyMatches === false ? h('span', { className: 'zcp-err' }, '不匹配') : '未知'))),
          channel.familyMatches === false
            ? h('tr', null, h('td', { colSpan: 2 }, h('span', { className: 'zcp-hint' }, channel.hint)))
            : null))
    }

    // ── 通道测试 ────────────────────────────────────────────────────────────
    function TestCard() {
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      const run = async () => {
        setBusy(true)
        setError(null)
        setResult(null)
        try {
          setResult(await call('/test', { method: 'POST' }))
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }
      return h(Card, { title: '通道测试', status: result ? (result.ok ? 'ok' : 'bad') : 'idle',
        right: h('button', { className: 'zcp-btn zcp-btn-primary', onClick: run, disabled: busy }, busy ? '测试中…' : '跑一轮'),
      },
      h('div', { className: 'zcp-muted' }, '真发一次模型请求，消耗少量额度'),
      result
        ? h('div', null,
          h('div', { className: 'zcp-v' }, `${result.ok ? '成功' : '失败'}（${result.elapsedMs} ms）${result.channel ? ` · 渠道 ${result.channel.providerId ?? '?'}` : ''}`),
          result.text ? h('div', { className: 'zcp-v' }, `答复：${JSON.stringify(result.text.slice(0, 60))}`) : null,
          result.error ? h('div', { className: 'zcp-err' }, result.error) : null)
        : null,
      error ? h('div', { className: 'zcp-err' }, error) : null)
    }

    // ── 页面 ────────────────────────────────────────────────────────────────
    function Page() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      const refresh = useCallback(async () => {
        setBusy(true)
        try {
          setStatus(await call('/status'))
          setError(null)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { refresh() }, [refresh])

      const runtime = status?.runtime ?? {}

      return h('div', { className: 'zcp-page' },
        h('div', { className: 'zcp-head' },
          h('div', { className: 'zcp-title' }, 'ZCode 反代'),
          h('div', { className: 'zcp-sub' }, '模型请求经本机 ZCode 客户端执行'),
          h('div', { className: 'zcp-spacer' }),
          h('button', { className: 'zcp-btn', onClick: refresh, disabled: busy }, busy ? '刷新中…' : '刷新')),
        error ? h('div', { className: 'zcp-err' }, error) : null,
        status === null
          ? h('div', { className: 'zcp-muted' }, '读取中…')
          : h('div', { className: 'zcp-page', style: { gap: 12, padding: 0 } },
            h(AccountsCard, { status, refresh }),
            h(LoginCard, { status, refresh }),
            h(ChannelCard, { status }),
            h(TestCard),
            status?.lastFailure
              ? h(Card, { title: '最近一次上游错误', status: 'bad' },
                h('div', { className: 'zcp-v' },
                  `${status.lastFailure.at ?? ''} · ${status.lastFailure.providerId ?? '?'} · ${status.lastFailure.statusCode ?? '—'} · ${status.lastFailure.message ?? ''}`))
              : null,
            h('div', { className: 'zcp-muted' },
              `运行时 ${runtime.builtinVersion ?? '未找到'} · ${runtime.cliExists ? 'CLI 正常' : 'CLI 缺失'} · 数据 ${status.at ?? '—'}`)))
    }

    const inject = ['slots']

    function apply(ctx) {
      injectStyles()
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'zcode-cli-proxy',
        order: 30,
        label: 'ZCode 反代',
      }, () => h(Page, null)))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
