/**
 * 本机入口 v8（不属于上游）：转发上游插件，并额外挂上「ZCode 反代」设置页的宿主半边。
 *
 * 为什么单独一层（以及为什么是 vN 而不是 ?v=）：
 *   · lib/ 保持与上游逐行一致（只多 Linux 平台目录名修复 + 计划模型分家）；本机新增代码
 *     全在 local/ 与 client.js，这样上游升级时只需重贴那几处修复；
 *   · **改代码必须换这个文件名**（保持 patch 行的 id 不变）。本 profile 的 loader 按
 *     specifier 缓存模块，而「只改 patch 行里的 name」在本版只更新 include 配置、
 *     不会重挂已在跑的 fiber —— 可靠做法是换 entry 文件名 + 走一次 dispose→start
 *     （见 DEPLOY-NOTES.md）。
 *
 * v9（2026-10-21）：
 *   · 模型清单分家：Start Plan（GLM-5.3-Flash/5.2/5-Turbo）与标准订阅（GLM-5.3 /
 *     GLM-5.3-Flash / GLM-5.3-FlashX），模型名直接标注渠道
 *   · 注入的 builtinModelIds 随 provider 走（coding-plan ≠ start-plan）
 *   · 设置页重写：账号列表（平台徽章）+ 余额查询 + 简洁布局
 */

import base, { resolveOptions, ZcodeAppServerAdapter } from './lib/index.js?v=9'
import { START_PLAN_PROVIDER_ID, START_PLAN_MODELS, CODING_PLAN_MODELS, resolveBuiltinRuntime, resolveDefaultModelId } from './lib/app-server.js?v=9'
import { readCredentials, credentialsPath } from './lib/credentials.js'
import { registerHostPanel } from './local/host-panel.js?v=9'

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
    CODING_PLAN_MODELS,
    resolveDefaultModelId,
    resolveBuiltinRuntime,
    readCredentials,
    credentialsPath,
    logger: ctx.logger,
  })
}

export default { name, inject, Config, apply }
