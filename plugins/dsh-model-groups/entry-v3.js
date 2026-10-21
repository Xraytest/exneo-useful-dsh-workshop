/**
 * 模型分组热挂入口 v3（fix-2：revision 单调化、请求体跨块 UTF-8、413 drain 有界、build 标记）。
 * 换文件名 = 换 specifier，loader 才会重新求值该模块（同 id 换 name 走 dispose→start）。
 */
export * from './index.js?v=fix-2';
