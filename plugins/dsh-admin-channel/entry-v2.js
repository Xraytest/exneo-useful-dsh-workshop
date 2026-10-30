/**
 * dsh-admin-channel —— host 半边入口（v2）。
 *
 * v2：输出 schema 改为标准 JSON Schema（顶层 required 数组）。Loader 的
 * JsonSchema 校验不接受把 required 写进属性里（`schema.properties.x.required`），
 * v1 因此 activation failed；协议与行为不变。
 *
 * 为什么要有 entry-vN.js：Loader / Node ESM 都按**完整 URL** 缓存模块，
 * 改过 index.js 后必须让这张 import 图的 URL 变化，否则运行中的实例继续跑
 * 旧代码。每改一次 host 实现：新写 entry-v<N+1>.js 并把这里的 `?v=` 加一，
 * 再把 cordis.patch.yml 的 name 指过去（row id 不变），最后 remove → install。
 *
 * @module dsh-admin-channel/entry-v2
 */
export * from './index.js?v=ac-2';
