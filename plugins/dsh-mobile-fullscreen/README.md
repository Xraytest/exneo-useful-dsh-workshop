# dsh-mobile-fullscreen

移动端全屏按钮：在侧边栏底部 `sidebar.footer.action` 槽位注册一项（order 96），
落在 `dsh-lanmode` 二维码按钮（同槽位 order 95）**右侧**，把浏览器切进/切出全屏。

## 行为

- 唯一入口是侧边栏图标按钮，纯图标无文字，悬停提示由 `title` / `aria-label` 承担
  （「全屏」/「退出全屏」，随界面语言切换）。
- 点击切换全屏；`fullscreenchange` 同步图标、`aria-pressed` 与提示语；
  请求被拒时抖动提示。
- 硬性排除（满足任一即不渲染）：
  - `document.fullscreenEnabled === false`（明文 HTTP 被浏览器禁用 / iPhone Safari 无元素全屏）；
  - `sessionStorage 'dsh_force_desktop' === '1'`（用户强制桌面视图）。

## 实现要点

- host 半边（`index.js`）是纯客户端 UI 插件，仅为满足 Cordis 插件导出契约存在，
  不注册任何服务、工具或路由。
- 客户端半边经 `window.__ModuleLoader__.load` 加载，通过
  `dsh.client.inject` 声明对 `@deepseek-ai/dsh-client-ui-slots` 的依赖。
- 样式只用主题 token（`--dsw-alias-*`），不 import 任何 Harness Client 包。

## 安装

```bash
dsh plugin --profile <profile> install <repo>/plugins/dsh-mobile-fullscreen
```
