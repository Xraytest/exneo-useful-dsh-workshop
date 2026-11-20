import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionState } from '../src/dsh/session-state.js'
import { attachWorkbenchMenu, menuError, splitRoute } from '../src/dsh/workbench-menu.js'

const dirs: string[] = []
const makeState = (): SessionState => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-menu-'))
  dirs.push(dir)
  return new SessionState(join(dir, 'sessions.json'))
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const catalog = {
  groups: [
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }, { id: 'reasoner', name: 'R1' }] },
    { id: 'glm', name: 'GLM', models: [{ id: 'glm-5.3' }] },
  ],
}

const hubOf = (state: SessionState) => ({
  state,
  catalog: async () => catalog,
  backends: () => ['spawn', 'fork'],
})

describe('splitRoute', () => {
  it('parses provider::model pairs', () => {
    expect(splitRoute('glm::glm-5.3')).toEqual({ provider: 'glm', model: 'glm-5.3' })
    expect(splitRoute('no-sep')).toBeUndefined()
    expect(splitRoute('::m')).toBeUndefined()
  })
})

describe('workbench menu', () => {
  it('builds a spec with catalog options and default state', async () => {
    const menu = attachWorkbenchMenu(hubOf(makeState()))
    const spec = (await menu.buildSpec('s1')) as { items: Array<Record<string, unknown>>; phase: string }
    expect(spec.phase).toBe('running')
    const select = spec.items.find((item) => item['id'] === 'route') as { options: Array<{ value: string }> }
    expect(select.options.map((option) => option.value)).toEqual(['', 'deepseek::chat', 'deepseek::reasoner', 'glm::glm-5.3'])
    const backend = spec.items.find((item) => item['id'] === 'backend') as { options: Array<{ value: string }> }
    expect(backend.options.map((option) => option.value)).toEqual(['', 'spawn', 'fork'])
  })

  it('applies set ops and reflects them in a fresh spec', async () => {
    const state = makeState()
    const menu = attachWorkbenchMenu(hubOf(state))
    const after = (await menu.applyOp({ sessionId: 's1', op: 'set', id: 'route', value: 'glm::glm-5.3' })) as { items: Array<Record<string, unknown>> }
    const select = after.items.find((item) => item['id'] === 'route') as { value: string }
    expect(select.value).toBe('glm::glm-5.3')
    expect(state.stateOf('s1').route).toEqual({ provider: 'glm', model: 'glm-5.3' })
    const note = (after.items.find((item) => item['kind'] === 'note')) as { text: string }
    expect(note.text).toContain('glm / glm-5.3')
    await menu.applyOp({ sessionId: 's1', op: 'set', id: 'effort', value: 'high' })
    await menu.applyOp({ sessionId: 's1', op: 'set', id: 'backend', value: 'fork' })
    expect(state.stateOf('s1')).toMatchObject({ reasoningEffort: 'high', backend: 'fork' })
  })

  it('rejects invalid ops with menuStatus', async () => {
    const menu = attachWorkbenchMenu(hubOf(makeState()))
    await expect(menu.applyOp({ op: 'set', id: 'route', value: 'nope' })).rejects.toMatchObject({ menuStatus: 400 })
    await expect(menu.applyOp({ sessionId: 's1', op: 'set', id: 'effort', value: 'ultra' })).rejects.toMatchObject({ menuStatus: 400 })
    await expect(menu.applyOp({ sessionId: 's1', op: 'set', id: 'backend', value: 'acp' })).rejects.toMatchObject({ menuStatus: 400 })
    await expect(menu.applyOp({ sessionId: 's1', op: 'explode' })).rejects.toMatchObject({ menuStatus: 400 })
    await expect(menu.applyOp({ sessionId: 's1', op: 'set', id: 'route-on', value: true })).rejects.toMatchObject({ menuStatus: 409 })
  })

  it('reset clears the session override', async () => {
    const state = makeState()
    const menu = attachWorkbenchMenu(hubOf(state))
    await menu.applyOp({ sessionId: 's1', op: 'set', id: 'enabled', value: false })
    const spec = (await menu.applyOp({ sessionId: 's1', op: 'reset' })) as { phase: string }
    expect(spec.phase).toBe('running')
    expect(state.stateOf('s1')).toEqual({ enabled: true, hasOverride: false })
  })

  it('menuError carries a machine-readable status', () => {
    expect(menuError('x', 409).menuStatus).toBe(409)
    expect(menuError('x').menuStatus).toBe(400)
  })
})
