import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionState } from '../src/dsh/session-state.js'

const dirs: string[] = []
const makeFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-sessions-'))
  dirs.push(dir)
  return join(dir, 'sessions.json')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SessionState', () => {
  it('defaults to enabled with no override', () => {
    const state = new SessionState(makeFile())
    expect(state.stateOf('s1')).toEqual({ enabled: true, hasOverride: false })
  })

  it('persists explicit overrides and folds them into resolved settings', () => {
    const file = makeFile()
    const state = new SessionState(file)
    state.setEnabled('s1', false)
    state.setRoute('s1', { provider: 'glm', model: 'glm-5.3' })
    state.setReasoningEffort('s1', 'high')
    state.setBackend('s1', 'fork')
    expect(state.stateOf('s1')).toEqual({
      enabled: false,
      backend: 'fork',
      route: { provider: 'glm', model: 'glm-5.3' },
      reasoningEffort: 'high',
      hasOverride: true,
    })
    // round-trip through a fresh instance
    const reloaded = new SessionState(file)
    expect(reloaded.stateOf('s1')).toEqual(state.stateOf('s1'))
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    expect(persisted.sessions['s1']).toEqual({
      enabled: false,
      backend: 'fork',
      route: { provider: 'glm', model: 'glm-5.3' },
      reasoningEffort: 'high',
    })
  })

  it('clearing a value returns the session to defaults without stale keys', () => {
    const file = makeFile()
    const state = new SessionState(file)
    state.setEnabled('s1', false)
    state.setEnabled('s1', true)
    expect(state.stateOf('s1')).toEqual({ enabled: true, hasOverride: false })
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions['s1']).toBeUndefined()
    state.setRoute('s1', { provider: 'p', model: 'm' })
    state.setRoute('s1', undefined)
    expect(state.stateOf('s1')).toEqual({ enabled: true, hasOverride: false })
  })

  it('clear() removes the whole entry and keeps other sessions intact', () => {
    const file = makeFile()
    const state = new SessionState(file)
    state.setBackend('s1', 'fork')
    state.setEnabled('s2', false)
    state.clear('s1')
    expect(state.stateOf('s1')).toEqual({ enabled: true, hasOverride: false })
    expect(state.stateOf('s2').enabled).toBe(false)
  })

  it('survives a corrupt file without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-sessions-'))
    dirs.push(dir)
    const file = join(dir, 'sessions.json')
    writeFileSync(file, 'not json at all', 'utf8')
    const state = new SessionState(file)
    expect(state.stateOf('s1').enabled).toBe(true)
    expect(state.error).toContain('读取失败')
    state.setEnabled('s2', false)
    const reloaded = new SessionState(file)
    expect(reloaded.stateOf('s2').enabled).toBe(false)
  })
})
