/**
 * 本机部署自检：真跑一轮 Start Plan 调用，验证 app-server 通道在本机能打通。
 *
 *   node plugins/dsh-zcode-cli-proxy/verify-e2e.mjs
 *
 * 与上游 test/appserver-startplan.mjs 等价，区别是参数取「本机实际部署」的值而不是写死的
 * Windows 路径（上游那份是作者 Mac/Windows 上的探测脚本，直接跑必失败）。
 * 可用环境变量覆盖：
 *   ZCODE_CLI_PATH   zcode.cjs 路径（缺省 ~/.zcode/server/agents/glm/zcode.cjs）
 *   ZCODE_CLI_NODE   跑 zcode.cjs 的 node（缺省客户端自带的 ~/.zcode/server/node）
 *   ZCODE_BRIDGE_CWD app-server 会话工作目录（缺省 ~/.zcode/dsh-bridge）
 *
 * ⚠ 会真实消耗一点 ZCode Start Plan 额度（一次极短问答）。
 * ⚠ 通道会把会话权限模式切到 yolo 并自动放行全部工具调用 —— 这是插件的设计（DSH 委派
 *   场景没有人工批准面），跑之前请知情。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ZcodeAppServerAdapter } from './lib/app-server.js'

const home = os.homedir()
const cliPath = process.env.ZCODE_CLI_PATH || path.join(home, '.zcode', 'server', 'agents', 'glm', 'zcode.cjs')
const cliNode = process.env.ZCODE_CLI_NODE || path.join(home, '.zcode', 'server', 'node')
const cliCwd = process.env.ZCODE_BRIDGE_CWD || path.join(home, '.zcode', 'dsh-bridge')

for (const [label, file] of [['zcode.cjs', cliPath], ['node', cliNode]]) {
  if (!fs.existsSync(file)) {
    console.error(`✗ 找不到 ${label}：${file}`)
    process.exit(2)
  }
}
fs.mkdirSync(cliCwd, { recursive: true })

const logger = {
  info: (m) => console.log('[info]', m),
  warn: (m) => console.log('[warn]', m),
  error: (m) => console.error('[error]', m),
  debug: () => {},
}

const options = () => ({
  zcodeCliPath: cliPath,
  zcodeCliNode: cliNode,
  cliCwd,
  cliModels: [
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash (ZCode CLI)', contextWindow: 200000, maxTokens: 64000, inputModalities: ['text', 'image'] },
  ],
  defaultContextWindow: 200000,
  maxTokens: 32768,
  appServerTimeoutMs: 120000,
  zcodeCliTimeoutMs: 300000,
  retryPolicy: {},
  injectStartPlanAccount: true,
  zcodeDataBaseDir: '',
  childEnvAllow: ['HOME', 'USER', 'LOGNAME', 'SHELL'],
})

console.log('=== dsh-zcode-cli-proxy 端到端自检 ===')
console.log('cli    :', cliPath)
console.log('node   :', cliNode)
console.log('cwd    :', cliCwd)
console.log('home   :', home)
console.log('')

const adapter = new ZcodeAppServerAdapter({ options, logger })
let text = ''
let usage
let finish
let channel
try {
  for await (const chunk of adapter.stream({
    provider: 'zcode-cli',
    model: 'glm-5.3-flash',
    sessionId: `verify-${Date.now()}`,
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：就绪' }] }],
  })) {
    if (chunk.type === 'text-delta') {
      process.stdout.write(chunk.text)
      text += chunk.text
    }
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') {
      finish = chunk.reason
      channel = chunk.replayState?.channel
    }
  }
} catch (error) {
  console.error('\n✗ 失败：', error?.message ?? error)
  adapter.dispose()
  process.exit(1)
}
adapter.dispose()

console.log('\n')
console.log('答复  :', JSON.stringify(text.slice(0, 120)))
console.log('用量  :', JSON.stringify(usage))
console.log('渠道  :', JSON.stringify(channel))
console.log('结束  :', JSON.stringify(finish))
if (finish?.kind === 'error') {
  console.error('\n✗ 回合以错误结束')
  process.exit(1)
}
if (text.trim() === '') {
  console.error('\n✗ 没有任何文本输出')
  process.exit(1)
}
console.log('\n✓ 通道打通（真流式 + Start Plan 鉴权 + 额度调用成功）')
