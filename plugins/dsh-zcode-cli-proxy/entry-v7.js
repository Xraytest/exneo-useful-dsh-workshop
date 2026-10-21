/**
 * 本机入口 v7（不属于上游）：转发上游插件，并额外挂上「ZCode 反代（CLI）」设置页的宿主半边。
 *
 * 为什么单独一层（以及为什么是 vN 而不是 ?v=）：
 *   · lib/ 保持与上游逐行一致（只多一处 Linux 平台目录名的修复）；本机新增代码全在
 *     local/ 与 client.js，这样上游升级时只需重贴那一处修复；
 *   · **改代码必须换这个文件名**（保持 patch 行的 id 不变）。本 profile 的 loader 按
 *     specifier 缓存模块，而「只改 patch 行里的 name」在本版只更新 include 配置、
 *     不会重挂已在跑的 fiber —— 实测：name 指到新文件后运行中的实例仍跑旧模块。
 *     可靠做法是换 entry 文件名 + 走一次 dispose→start（见 DEPLOY-NOTES.md）。
 */

import base, { resolveOptions, ZcodeAppServerAdapter } from './lib/index.js?v=7'
import { START_PLAN_PROVIDER_ID, START_PLAN_MODELS, resolveBuiltinRuntime } from './lib/app-server.js?v=7'
import { readCredentials, credentialsPath } from './lib/credentials.js'
import { registerHostPanel } from './local/host-panel.js?v=7'

export const name = base.name
export const inject = base.inject
export const Config = base.Config

export function apply(ctx, config) {
  base.apply(ctx, config)
  registerHostPanel(ctx, {
    options: () => resolveOptions(config),
    ZcodeAppServerAdapter,
    START_PLAN_PROVIDER_ID,
    START_PLAN_MODELS,
    resolveBuiltinRuntime,
    readCredentials,
    credentialsPath,
    logger: ctx.logger,
  })
}

export default { name, inject, Config, apply }
