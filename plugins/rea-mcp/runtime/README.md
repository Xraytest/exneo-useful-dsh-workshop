# runtime/

REA 本体（npm 包 `rea-agents`）固定安装在这里：

```bash
npm install --omit=optional --prefix "$(dirname "$0")"
```

`--omit=optional` 必须保留（optional 依赖 frida 本机下载极慢且插件用不到）。
node_modules 体积 136 MB，仓库不提交；安装 rea-mcp 后按上面命令补装即可。
