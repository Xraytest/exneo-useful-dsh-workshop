/**
 * dsh-mobile-fullscreen — 浏览器半边（v4：仅侧边栏入口，图标 + 悬停提示）。
 *
 * 在侧边栏底部放一个把页面切换到全屏模式的按钮（Fullscreen API）。
 * 演进教训：
 *   v1 跟随 lanmode 浮动汉堡按钮 → FAB 自身在出厂 DOM 下恒隐藏，陪葬。
 *   v2/v3 补浮动按钮 → 用户反馈出现两个按钮，悬浮那个多余。
 *   v4：只保留侧边栏入口，删掉全部浮动按钮逻辑。
 *
 *   · 唯一入口：sidebar.footer.action 槽位注册一项，order 96，落在
 *     dsh-lanmode 二维码按钮（同槽位 order 95）**右侧**。
 *   · 外观：纯图标按钮（与 lanmode 那颗 32px 透明底风格一致），无常驻
 *     文字；悬停提示由 title / aria-label 承担（「全屏」/「退出全屏」）。
 *   · 硬性排除：全屏 API 不可用（document.fullscreenEnabled === false，
 *     明文 HTTP 被浏览器禁用 / iPhone Safari 无元素全屏）→ 不显示；
 *     sessionStorage 'dsh_force_desktop' === '1' → 不显示。
 *   · 行为：点击切换进出全屏；fullscreenchange 同步图标、aria-pressed
 *     与悬停提示语；请求被拒时抖动提示。
 *
 * 样式只用主题 token（--dsw-alias-*）；不 import 任何 Harness Client 包。
 */

window.__ModuleLoader__.load({
  id: 'dsh-mobile-fullscreen',
  factory: (require) => {
    // ── 硬性排除（仅两个）──────────────────────────────────────────────────
    function forcedDesktop() {
      try { return sessionStorage.getItem('dsh_force_desktop') === '1' } catch (err) { /* bestEffort */ void err }
      return false
    }

    function isChinese() {
      try {
        var langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || '']
        return langs.some(function (l) { return String(l).toLowerCase().indexOf('zh') === 0 })
      } catch (err) { return false }
    }

    // ── 全屏 API（含前缀回退）──────────────────────────────────────────────
    function fullscreenElement() {
      if (typeof document === 'undefined') return null
      return document.fullscreenElement || document.webkitFullscreenElement || null
    }

    function fullscreenApiAvailable() {
      if (typeof document === 'undefined' || !document.documentElement) return false
      var doc = document
      var el = doc.documentElement
      var enabled = doc.fullscreenEnabled
      if (enabled === false) return false
      if (enabled === true) return true
      return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function'
    }

    function enterFullscreen() {
      var el = document.documentElement
      var fn = el.requestFullscreen || el.webkitRequestFullscreen
      if (typeof fn !== 'function') return Promise.reject(new Error('fullscreen api unavailable'))
      return Promise.resolve(fn.call(el))
    }

    function exitFullscreen() {
      var fn = document.exitFullscreen || document.webkitExitFullscreen
      if (typeof fn !== 'function') return Promise.reject(new Error('fullscreen api unavailable'))
      return Promise.resolve(fn.call(document))
    }

    // ── 图标（stroke 风格，与 lanmode 图标一致）────────────────────────────
    var ICON_EXPAND = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>'
    var ICON_COLLAPSE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h3a2 2 0 0 0 2-2V3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/></svg>'

    // ── 样式：与 lanmode 侧边栏按钮同规格（32px 透明底，悬停浮起）──────────
    var CSS = [
      '.mfs-btn { appearance: none; display: inline-flex; align-items: center; justify-content: center;',
      '  width: 32px; height: 32px; border-radius: 8px; border: none; background: transparent;',
      '  color: var(--dsw-alias-label-secondary); cursor: pointer;',
      '  transition: background-color .12s, color .12s; }',
      '.mfs-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
      '.mfs-btn:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }',
      '.mfs-btn:active { transform: scale(0.95); }',
      // 全屏请求被拒：抖一下提示
      '@keyframes mfs-shake { 0%,100% { transform: translateX(0) } 25% { transform: translateX(-3px) } 75% { transform: translateX(3px) } }',
      '.mfs-btn.mfs-denied { animation: mfs-shake .18s ease-in-out 2; color: var(--dsw-alias-state-error-primary); }',
      // 触控设备最小目标 44px（lanmode 的全局规则之外显式兜一层）
      '@media (pointer: coarse) { .mfs-btn { width: 44px; height: 44px; } }',
    ].join('\n')

    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-mobile-fullscreen-styles')) return
      var tag = document.createElement('style')
      tag.id = 'dsh-mobile-fullscreen-styles'
      tag.setAttribute('data-plugin', 'dsh-mobile-fullscreen')
      tag.textContent = CSS
      ;(document.head || document.documentElement).appendChild(tag)
    }

    function toggleFullscreen(onDenied) {
      try {
        var p = fullscreenElement() ? exitFullscreen() : enterFullscreen()
        Promise.resolve(p).catch(function () { if (onDenied) onDenied() })
      } catch (err) {
        if (onDenied) onDenied()
      }
    }

    function label(zh, active) {
      if (zh) return active ? '退出全屏' : '全屏'
      return active ? 'Exit fullscreen' : 'Fullscreen'
    }

    var module = { exports: {} }
    module.exports.inject = ['slots']
    module.exports.apply = function apply(ctx) {
      injectStyles()
      if (typeof window === 'undefined') return undefined
      var React = require('react')
      var h = React.createElement
      var zh = isChinese()

      /** 侧边栏底部的全屏按钮：纯图标，悬停提示「全屏/退出全屏」。 */
      function FullscreenIconButton(props) {
        var state = React.useState(function () { return Boolean(fullscreenElement()) })
        var active = state[0]
        var setActive = state[1]
        var denied = React.useState(false)
        var setDenied = denied[1]

        React.useEffect(function () {
          var onChange = function () { setActive(Boolean(fullscreenElement())) }
          document.addEventListener('fullscreenchange', onChange)
          document.addEventListener('webkitfullscreenchange', onChange)
          return function () {
            document.removeEventListener('fullscreenchange', onChange)
            document.removeEventListener('webkitfullscreenchange', onChange)
          }
        }, [])

        // 全屏 API 不可用 / 强制桌面模式：不渲染（侧边栏不出现空位）
        if (!fullscreenApiAvailable() || forcedDesktop()) return null
        void props

        var text = label(zh, active)
        return h('button', {
          type: 'button',
          className: 'mfs-btn' + (denied[0] ? ' mfs-denied' : ''),
          // 悬停提示与可访问名：全屏状态切换时随之更新
          title: text,
          'aria-label': text,
          'aria-pressed': active ? 'true' : 'false',
          onClick: function () {
            setDenied(false)
            toggleFullscreen(function () {
              setDenied(true)
              setTimeout(function () { setDenied(false) }, 800)
            })
          },
        },
          // 纯图标，无常驻文字
          h('span', { style: { display: 'inline-flex' }, dangerouslySetInnerHTML: { __html: active ? ICON_COLLAPSE : ICON_EXPAND } }),
        )
      }

      return ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'dsh-mobile-fullscreen',
            // dsh-lanmode 的二维码按钮是 order 95；96 让本按钮落在它右边。
            order: 96,
          },
          FullscreenIconButton,
        )
      })
    }
    return module.exports
  },
})
