/**
 * dsh-admin-channel —— host 半边入口（v5）。
 *
 * v5：安全加固与关闭语义
 *   · broker.ps1 / launch.ps1 里的 powershell.exe / cmd.exe 全部改成
 *     %SystemRoot% 绝对路径（防止 cwd/PATH 里的同名程序被提权）；
 *   · broker 在连接等待与命令等待中轮询 cancel 文件：执行长命令期间关闭通道，
 *     broker 会杀掉整棵命令进程树并退出，不再拖到命令超时；
 *   · 关闭只在确认 broker 退出后才报 off；非提权 host 打不动高完整性进程时
 *     如实报 error，不谎报成功；
 *   · 移除诊断路由（减少本机未鉴权读面）；令牌注释修正为 256 位。
 * v4：可注入 launcher（沙盒测试）+ idleTimeoutMs 下限 5 秒。
 * v3：只读诊断路由（v5 已移除）。v2：标准 JSON Schema。
 *
 * 为什么要有 entry-vN.js：Loader / Node ESM 都按**完整 URL** 缓存模块，
 * 改过 index.js 或 lib/*.js 后必须让 import 图的 URL 变化，否则运行中的实例
 * 继续跑旧代码。每改一次：新写 entry-v<N+1>.js 并把 `?v=` 加一，再把
 * cordis.patch.yml 的 name 指过去（row id 不变），最后 remove → install。
 *
 * @module dsh-admin-channel/entry-v5
 */
export * from './index.js?v=ac-5';
