/**
 * The Orchestrator side of the dsh-workbench secondary menu contract:
 * build a declarative panel spec from this session's settings, and fold
 * incoming ops back into the session store. dsh-workbench renders the
 * generic widgets (heading/note/switch/select/text/rows/form/buttons); every
 * piece of Orchestrator semantics stays here. HTTP is mounted by src/index.ts.
 *
 *   GET  /dsh-orchestrator/menu?sessionId=…        → spec
 *   POST /dsh-orchestrator/menu {sessionId, op, …}  → new spec (errors carry menuStatus)
 *
 * v2（2026-11-21，用户任务「截断/档位不全/极长等待/并发/备选/UI 优化」）：
 *   - 思考档位不再写死 low/medium/high，改按所选模型的实际元数据动态出选项；
 *   - 新增：并发上限（maxParallel）、运行等待（waitMode）、备选子代理链
 *     （fallbacks，rows+form 维护，重试时按顺序回退）；
 *   - 文案全面收紧，避免窄浮层里长段落把控件顶出可视区（截断感的来源）。
 * @module dsh-orchestrator/dsh/workbench-menu
 */
import type { SessionRoute, SessionState } from './session-state.js'

const REFRESH_MS = 3000
const ROUTE_SEP = '::'

export interface ModelCatalog {
  readonly groups: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly models: ReadonlyArray<{ readonly id: string; readonly name?: string }>
  }>
  readonly error?: string
}

export interface ModelEffortInfo {
  /** Effort ids the selected model supports; null when metadata is unavailable. */
  readonly efforts: string[] | null
}

export interface WorkbenchMenuHub {
  readonly state: SessionState
  /** Provider/model catalog (from the llm service); may carry an error. */
  catalog(): Promise<ModelCatalog>
  /** Reasoning efforts supported by one model; null when unknown. */
  modelInfo(provider: string, model: string): Promise<ModelEffortInfo>
  /** Locally registered subagent backends, e.g. ['spawn', 'fork']. */
  backends(): string[]
}

export const splitRoute = (value: string): SessionRoute | undefined => {
  const text = String(value ?? '')
  const at = text.indexOf(ROUTE_SEP)
  if (at <= 0) return undefined
  const provider = text.slice(0, at).trim()
  const model = text.slice(at + ROUTE_SEP.length).trim()
  return provider !== '' && model !== '' ? { provider, model } : undefined
}

export function menuError(message: string, status = 400): Error & { menuStatus: number } {
  const error = new Error(message) as Error & { menuStatus: number }
  error.menuStatus = status
  return error
}

const routeLabel = (route: SessionRoute | undefined): string =>
  route === undefined ? '' : route.provider + ROUTE_SEP + route.model

const catalogOptions = (catalog: ModelCatalog): Array<{ value: string; label: string; group?: string }> => {
  const options: Array<{ value: string; label: string; group?: string }> = []
  for (const group of catalog.groups) {
    for (const model of group.models) {
      if (model.id === '') continue
      options.push({
        value: group.id + ROUTE_SEP + model.id,
        label:
          model.name !== undefined && model.name !== '' && model.name !== model.id
            ? group.name + ' / ' + model.name + '（' + model.id + '）'
            : group.name + ' / ' + model.id,
        group: group.name,
      })
    }
  }
  return options
}

/** 状态行：一行说清当前生效的关键值，代替旧版两段长文。 */
const statusLine = (settings: { enabled: boolean; route?: SessionRoute; maxParallel?: number; waitMode?: 'await' | 'background'; fallbacks?: SessionRoute[] }): string => {
  const parts: string[] = [settings.enabled ? '已启用' : '已关闭（新会话默认关）']
  if (settings.enabled && settings.route !== undefined) parts.push('子代理 ' + settings.route.provider + ' / ' + settings.route.model)
  if (settings.enabled && settings.route === undefined) parts.push('子代理沿用插件配置路由')
  if (settings.maxParallel !== undefined) parts.push('并发 ' + String(settings.maxParallel))
  if (settings.waitMode !== undefined) parts.push(settings.waitMode === 'background' ? '后台运行' : '前台等待')
  if (settings.fallbacks !== undefined) parts.push('备选 ' + String(settings.fallbacks.length) + ' 条')
  return parts.join(' · ')
}

export function attachWorkbenchMenu(hub: WorkbenchMenuHub) {
  const title = 'Orchestrator'

  async function buildSpec(sessionId: string): Promise<Record<string, unknown>> {
    const settings = hub.state.stateOf(sessionId)
    const catalog = await hub.catalog()
    const backends = hub.backends()

    // 思考档位：按所选模型的实际元数据出选项（拿不到就只留「模型默认」）。
    let efforts: string[] | null = null
    if (settings.route !== undefined) {
      const info = await hub.modelInfo(settings.route.provider, settings.route.model)
      efforts = info.efforts
    }
    const effortOptions = [{ value: '', label: '模型默认' }]
    for (const effort of efforts ?? []) effortOptions.push({ value: effort, label: effort })

    const items: Array<Record<string, unknown>> = []

    items.push({
      kind: 'note',
      tone: settings.enabled ? 'ok' : 'warn',
      text: statusLine(settings) + '。拨开工作箱开关即生效；全部选择按会话记住、随时可改。',
    })

    items.push({ kind: 'heading', text: '模型与思考' })
    items.push({
      kind: 'select',
      id: 'route',
      label: '子代理默认模型',
      hint: '重试与备选之外的默认路由；插件配置里的显式角色/规则仍优先。',
      value: routeLabel(settings.route),
      options: [{ value: '', label: '（沿用插件配置）' }, ...catalogOptions(catalog)],
      placeholder: catalog.error ?? '选择 provider / 模型',
    })
    items.push({
      kind: 'select',
      id: 'effort',
      label: '思考档位',
      hint: settings.route === undefined
        ? '先选模型，这里会列出它支持的档位。'
        : efforts === null
          ? '该模型的档位元数据不可用，留空走模型默认。'
          : '只列该模型实际支持的档位。',
      value: settings.reasoningEffort ?? '',
      options: effortOptions,
      ...(settings.route === undefined ? { disabled: true } : {}),
    })
    items.push({
      kind: 'select',
      id: 'backend',
      label: '子代理后端',
      hint: 'spawn＝全新会话；fork＝继承主会话已完成回合。',
      value: settings.backend ?? '',
      options: [{ value: '', label: '（跟随插件配置）' }, ...backends.map((backend) => ({ value: backend, label: backend }))],
    })

    items.push({ kind: 'heading', text: '并发与等待' })
    items.push({
      kind: 'select',
      id: 'maxParallel',
      label: '并发上限',
      hint: '本会话每次编排同时跑的子代理数；工具参数显式指定时以参数为准。',
      value: settings.maxParallel !== undefined ? String(settings.maxParallel) : '',
      options: [
        { value: '', label: '（跟随插件配置）' },
        ...[1, 2, 3, 4, 6, 8].map((n) => ({ value: String(n), label: String(n) })),
      ],
    })
    items.push({
      kind: 'select',
      id: 'waitMode',
      label: '运行等待',
      hint: '后台＝orch_run 立即返回 run id（前台极长等待的解法）；前台＝等全部完成。',
      value: settings.waitMode ?? '',
      options: [
        { value: '', label: '（每次由模型选择）' },
        { value: 'await', label: '前台等待' },
        { value: 'background', label: '后台即回' },
      ],
    })

    items.push({ kind: 'heading', text: '备选子代理（重试时按顺序回退）' })
    items.push({
      kind: 'rows',
      label: '回退链',
      empty: (settings.fallbacks ?? []).length === 0 ? '还没有备选。用下面的表单加一个。' : null,
      rows: (settings.fallbacks ?? []).map((fallback, index) => ({
        index,
        title: 'F' + (index + 1) + ' · ' + fallback.provider + ' / ' + fallback.model,
        buttons: [
          { op: 'fb-up', index, label: '↑', title: '往前' },
          { op: 'fb-down', index, label: '↓', title: '往后' },
          { op: 'fb-remove', index, label: '删除', tone: 'danger' },
        ],
      })),
    })
    items.push({
      kind: 'form',
      label: '添加备选',
      hint: (settings.fallbacks ?? []).length >= 6 ? '最多 6 条' : null,
      fields: [
        {
          name: 'route', label: '模型', kind: 'select', value: '',
          options: catalogOptions(catalog),
          placeholder: catalog.error ?? '选择 provider / 模型',
        },
      ],
      submit: { op: 'fb-add', label: '加入备选' },
    })

    items.push({
      kind: 'buttons',
      buttons: [
        { op: 'reset', label: '恢复本会话默认', tone: 'danger' },
        { op: 'refresh', label: '刷新' },
      ],
    })

    return {
      title,
      sessionId,
      phase: settings.enabled ? 'running' : 'off',
      refreshMs: REFRESH_MS,
      items,
      generatedAt: Date.now(),
    }
  }

  async function applyOp(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : ''
    if (sessionId === '') throw menuError('sessionId 必填', 400)
    const op = String(body['op'] ?? '')
    const state = hub.state

    if (op === 'set') {
      const id = String(body['id'] ?? '')
      const value = body['value']
      if (id === 'enabled') {
        state.setEnabled(sessionId, value === true)
        return buildSpec(sessionId)
      }
      if (id === 'route') {
        const text = String(value ?? '')
        const route = text === '' ? undefined : splitRoute(text)
        if (text !== '' && route === undefined) throw menuError('模型值必须是 provider::model')
        state.setRoute(sessionId, route)
        // 换模型后原档位多半不再适用：清掉，让面板按新模型重列。
        if (route === undefined || state.stateOf(sessionId).route?.model !== route.model) {
          if (state.stateOf(sessionId).reasoningEffort !== undefined) state.setReasoningEffort(sessionId, undefined)
        }
        return buildSpec(sessionId)
      }
      if (id === 'effort') {
        const effort = String(value ?? '')
        if (effort !== '' && !/^[a-z][a-z0-9-]{0,23}$/.test(effort)) throw menuError('不认识的思考档位：' + effort)
        state.setReasoningEffort(sessionId, effort === '' ? undefined : effort)
        return buildSpec(sessionId)
      }
      if (id === 'backend') {
        const backend = String(value ?? '')
        if (backend !== '' && !hub.backends().includes(backend)) {
          throw menuError('不可用的子代理后端：' + (backend === '' ? '(空)' : backend), 400)
        }
        state.setBackend(sessionId, backend === '' ? undefined : backend)
        return buildSpec(sessionId)
      }
      if (id === 'maxParallel') {
        const text = String(value ?? '')
        if (text === '') {
          state.setMaxParallel(sessionId, undefined)
          return buildSpec(sessionId)
        }
        const n = Number(text)
        if (!Number.isInteger(n) || n < 1 || n > 8) throw menuError('并发上限必须是 1..8')
        state.setMaxParallel(sessionId, n)
        return buildSpec(sessionId)
      }
      if (id === 'waitMode') {
        const mode = String(value ?? '')
        if (mode !== '' && mode !== 'await' && mode !== 'background') throw menuError('不认识的等待模式：' + mode)
        state.setWaitMode(sessionId, mode === '' ? undefined : (mode as 'await' | 'background'))
        return buildSpec(sessionId)
      }
      throw menuError('不认识的设置项：' + (id === '' ? '(空)' : id), 400)
    }

    if (op === 'fb-add') {
      const fields = (body['fields'] ?? {}) as Record<string, unknown>
      const route = splitRoute(String(fields['route'] ?? ''))
      if (route === undefined) throw menuError('请选择一个具体的 provider / 模型')
      const current = state.stateOf(sessionId).fallbacks ?? []
      if (current.length >= 6) throw menuError('最多 6 条备选', 400)
      if (current.some((entry) => entry.provider === route.provider && entry.model === route.model)) {
        throw menuError('该模型已在备选链里', 409)
      }
      state.setFallbacks(sessionId, [...current, route])
      return buildSpec(sessionId)
    }

    if (op === 'fb-remove' || op === 'fb-up' || op === 'fb-down') {
      const index = Number(body['index'])
      const current = [...(state.stateOf(sessionId).fallbacks ?? [])]
      if (!Number.isInteger(index) || index < 0 || index >= current.length) throw menuError('index 越界', 400)
      if (op === 'fb-remove') current.splice(index, 1)
      else {
        const to = op === 'fb-up' ? index - 1 : index + 1
        if (to >= 0 && to < current.length) {
          const [moved] = current.splice(index, 1)
          current.splice(to, 0, moved)
        }
      }
      state.setFallbacks(sessionId, current.length === 0 ? undefined : current)
      return buildSpec(sessionId)
    }

    if (op === 'reset') {
      state.clear(sessionId)
      return buildSpec(sessionId)
    }

    if (op === 'refresh') return buildSpec(sessionId)

    throw menuError('不认识的 op：' + (op === '' ? '(空)' : op), 400)
  }

  return { buildSpec, applyOp }
}
