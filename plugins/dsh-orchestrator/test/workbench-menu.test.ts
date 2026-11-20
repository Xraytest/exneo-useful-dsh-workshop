import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionState } from '../src/dsh/session-state.js'
import { attachWorkbenchMenu, splitRoute, type ModelCatalog, type WorkbenchMenuHub } from '../src/dsh/workbench-menu.js'

const dirs: string[] = []
const makeState = (): SessionState => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-menu-'))
  dirs.push(dir)
  return new SessionState(join(dir, 'sessions.json'))
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CATALOG: ModelCatalog = {
  groups: [
    { id: 'glm', name: 'GLM', models: [{ id: 'glm-5.3', name: 'GLM 5.3' }] },
    { id: 'kimi', name: 'Kimi', models: [{ id: 'kimi-k2' }] },
  ],
}

const makeHub = (state: SessionState, efforts: string[] | null = ['low', 'medium', 'high', 'xhigh']): WorkbenchMenuHub => ({
  state,
  catalog: async () => CATALOG,
  modelInfo: async () => ({ efforts }),
  backends: () => ['spawn', 'fork'],
})

const findItem = (spec: Record<string, unknown>, kind: string, id?: string): Record<string, unknown> => {
  const items = spec['items'] as Array<Record<string, unknown>>
  const found = items.find((item) => item['kind'] === kind && (id === undefined || item['id'] === id))
  if (found === undefined) throw new Error('missing item ' + kind + '/' + String(id))
  return found
}

const textOf = (spec: Record<string, unknown>): string =>
  (spec['items'] as Array<Record<string, unknown>>)
    .filter((item) => item['kind'] === 'note')
    .map((item) => String(item['text'] ?? ''))
    .join('\n')

describe('workbench menu v2', () => {
  it('defaults to disabled with a compact status line', async () => {
    const state = makeState()
    const menu = attachWorkbenchMenu(makeHub(state))
    const spec = (await menu.buildSpec('s1')) as Record<string, unknown>
    expect(spec['phase']).toBe('off')
    const note = textOf(spec)
    expect(note).toContain('已关闭')
    expect(note.length).toBeLessThan(120)
  })

  it('lists only efforts the selected model actually supports', async () => {
    const state = makeState()
    state.setEnabled('s1', true)
    state.setRoute('s1', { provider: 'glm', model: 'glm-5.3' })
    const menu = attachWorkbenchMenu(makeHub(state, ['off', 'low', 'high', 'xhigh']))
    const spec = (await menu.buildSpec('s1')) as Record<string, unknown>
    const effort = findItem(spec, 'select', 'effort')
    const options = effort['options'] as Array<{ value: string }>
    expect(options.map((option) => option.value)).toEqual(['', 'off', 'low', 'high', 'xhigh'])
    const concurrency = findItem(spec, 'select', 'maxParallel')
    expect(concurrency['value']).toBe('')
  })

  it('disables the effort picker before a model is chosen', async () => {
    const state = makeState()
    const menu = attachWorkbenchMenu(makeHub(state, null))
    const spec = (await menu.buildSpec('s1')) as Record<string, unknown>
    const effort = findItem(spec, 'select', 'effort')
    expect(effort['disabled']).toBe(true)
  })

  it('applies set ops: route, effort, maxParallel, waitMode, backend', async () => {
    const state = makeState()
    const menu = attachWorkbenchMenu(makeHub(state))
    await menu.applyOp({ sessionId: 's1', op: 'set', id: 'route', value: 'glm::glm-5.3' })
    expect(state.stateOf('s1').route).toEqual({ provider: 'glm', model: 'glm-5.3' })
    // 换模型后旧档位被清掉
    expect(state.stateOf('s1').reasoningEffort).toBeUndefined()
    await menu.applyOp({ sessionId: 's1', op: 'set', id: 'effort', value: 'xhigh' })
    await menu.applyOp({ sessionId: 's1', op: 'set', id: 'maxParallel', value: '4' })
    await menu.applyOp({ sessionId: 's1', op: 'set', id: 'waitMode', value: 'background' })
    await menu.applyOp({ sessionId: 's1', op: 'set', id: 'backend', value: 'fork' })
    expect(state.stateOf('s1')).toMatchObject({
      reasoningEffort: 'xhigh',
      maxParallel: 4,
      waitMode: 'background',
      backend: 'fork',
    })
    const afterOn = (await menu.applyOp({ sessionId: 's1', op: 'set', id: 'enabled', value: true })) as Record<string, unknown>
    const note = textOf(afterOn)
    expect(note).toContain('并发 4')
    expect(note).toContain('后台运行')
    expect(note).toContain('glm / glm-5.3')
    // out-of-range values are rejected
    await expect(menu.applyOp({ sessionId: 's1', op: 'set', id: 'maxParallel', value: '9' })).rejects.toThrow()
  })

  it('manages the fallback chain: add, dedupe, move, remove', async () => {
    const state = makeState()
    const menu = attachWorkbenchMenu(makeHub(state))
    await menu.applyOp({ sessionId: 's1', op: 'fb-add', fields: { route: 'kimi::kimi-k2' } })
    await menu.applyOp({ sessionId: 's1', op: 'fb-add', fields: { route: 'glm::glm-5.3' } })
    expect(state.stateOf('s1').fallbacks).toEqual([
      { provider: 'kimi', model: 'kimi-k2' },
      { provider: 'glm', model: 'glm-5.3' },
    ])
    // duplicate rejected
    await expect(menu.applyOp({ sessionId: 's1', op: 'fb-add', fields: { route: 'kimi::kimi-k2' } })).rejects.toThrow()
    // move glm to the front
    await menu.applyOp({ sessionId: 's1', op: 'fb-up', index: 1 })
    expect(state.stateOf('s1').fallbacks?.[0]).toEqual({ provider: 'glm', model: 'glm-5.3' })
    // remove it
    await menu.applyOp({ sessionId: 's1', op: 'fb-remove', index: 0 })
    expect(state.stateOf('s1').fallbacks).toEqual([{ provider: 'kimi', model: 'kimi-k2' }])
    // removing the last entry clears the key
    await menu.applyOp({ sessionId: 's1', op: 'fb-remove', index: 0 })
    expect(state.stateOf('s1').fallbacks).toBeUndefined()
    // out-of-range index rejected
    await expect(menu.applyOp({ sessionId: 's1', op: 'fb-remove', index: 0 })).rejects.toThrow()
  })

  it('reset() returns the session to the disabled default', async () => {
    const state = makeState()
    const menu = attachWorkbenchMenu(makeHub(state))
    await menu.applyOp({ sessionId: 's1', op: 'set', id: 'enabled', value: true })
    await menu.applyOp({ sessionId: 's1', op: 'set', id: 'maxParallel', value: '2' })
    await menu.applyOp({ sessionId: 's1', op: 'fb-add', fields: { route: 'glm::glm-5.3' } })
    const spec = (await menu.applyOp({ sessionId: 's1', op: 'reset' })) as Record<string, unknown>
    expect(spec['phase']).toBe('off')
    expect(state.stateOf('s1')).toEqual({ enabled: false, hasOverride: false })
  })

  it('rejects unknown ops and items with menuStatus', async () => {
    const state = makeState()
    const menu = attachWorkbenchMenu(makeHub(state))
    await expect(menu.applyOp({ sessionId: 's1', op: 'nope' })).rejects.toThrow()
    await expect(menu.applyOp({ sessionId: 's1', op: 'set', id: 'nope', value: '1' })).rejects.toThrow()
    await expect(menu.applyOp({ op: 'set', id: 'route' })).rejects.toThrow()
  })

  it('splitRoute parses and rejects malformed values', () => {
    expect(splitRoute('glm::glm-5.3')).toEqual({ provider: 'glm', model: 'glm-5.3' })
    expect(splitRoute('::glm')).toBeUndefined()
    expect(splitRoute('glm')).toBeUndefined()
    expect(splitRoute('')).toBeUndefined()
  })
})
