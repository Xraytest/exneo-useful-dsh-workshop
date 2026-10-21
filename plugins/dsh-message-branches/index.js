/**
 * 消息分支（dsh-message-branches）— 稳定包入口。
 *
 * 实现全在 ./entry-v4.js（host 半边）与 ./client.js（浏览器半边）。
 * 本 profile 未开模块热载：loader 按 specifier 缓存模块，改 host 实现要写
 * entry-v<N+1>.js 并把 cordis.patch.yml 里该行的 name 指过去（保持同一行 id）。
 *
 * v4 起分支＝我的消息的多个版本（不建会话）；v3 及以前的「真会话分叉」实现
 * 保留在 entry-v1/v2/v3.js 里仅供回溯，不再被组合行引用。
 */
export * from './entry-v4.js';
export { default } from './entry-v4.js';
