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
  it('defaults to DISABLED for new sessions (0.2.0)', () => {
    const state = new SessionState(makeFile())
    expect(state.stateOf('s1')).toEqual({ enabled: false, hasOverride: false })
  })

  it('persists the switch in BOTH directions and reloads it', () => {
    const file = makeFile()
    const state = new SessionState(file)
    state.setEnabled('s1', true)
    expect(state.stateOf('s1')).toEqual({ enabled: true, hasOverride: true })
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions['s1']).toEqual({ enabled: true })
    state.setEnabled('s1', false)
    expect(state.stateOf('s1')).toEqual({ enabled: false, hasOverride: true })
    // round-trip through a fresh instance
    const reloaded = new SessionState(file)
    expect(reloaded.stateOf('s1').enabled).toBe(false)
    reloaded.setEnabled('s1', true)
    expect(new SessionState(file).stateOf('s1').enabled).toBe(true)
  })

  it('keeps subagent overrides alongside the switch', () => {
    const file = makeFile()
    const state = new SessionState(file)
    state.setEnabled('s1', true)
    state.setRoute('s1', { provider: 'glm', model: 'glm-5.3' })
    state.setReasoningEffort('s1', 'high')
    state.setBackend('s1', 'fork')
    expect(state.stateOf('s1')).toEqual({
      enabled: true,
      backend: 'fork',
      route: { provider: 'glm', model: 'glm-5.3' },
      reasoningEffort: 'high',
      hasOverride: true,
    })
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    expect(persisted.sessions['s1']).toEqual({
      enabled: true,
      backend: 'fork',
      route: { provider: 'glm', model: 'glm-5.3' },
      reasoningEffort: 'high',
    })
  })

  it('entries without an explicit switch read as disabled (0.2.0 semantics)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-sessions-'))
    dirs.push(dir)
    const file = join(dir, 'sessions.json')
    writeFileSync(file, JSON.stringify({
      version: 1,
      sessions: { s1: { route: { provider: 'p', model: 'm' } } },
    }), 'utf8')
    const state = new SessionState(file)
    // 无显式开关布尔 → 读作关（子代理路由等设置保留，开关按默认关）
    expect(state.stateOf('s1')).toMatchObject({ enabled: false, route: { provider: 'p', model: 'm' } })
    expect(state.stateOf('s2').enabled).toBe(false)
  })

  it('clear() returns the session to the disabled default and keeps others intact', () => {
    const file = makeFile()
    const state = new SessionState(file)
    state.setEnabled('s1', true)
    state.setBackend('s2', 'fork')
    state.clear('s1')
    expect(state.stateOf('s1')).toEqual({ enabled: false, hasOverride: false })
    expect(state.stateOf('s2')).toMatchObject({ enabled: false, backend: 'fork' })
  })

  it('removing a route returns to defaults without stale keys', () => {
    const file = makeFile()
    const state = new SessionState(file)
    state.setRoute('s1', { provider: 'p', model: 'm' })
    state.setRoute('s1', undefined)
    expect(state.stateOf('s1')).toEqual({ enabled: false, hasOverride: false })
  })

  it('survives a corrupt file without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-sessions-'))
    dirs.push(dir)
    const file = join(dir, 'sessions.json')
    writeFileSync(file, 'not json at all', 'utf8')
    const state = new SessionState(file)
    expect(state.stateOf('s1').enabled).toBe(false)
    expect(state.error).toContain('读取失败')
    state.setEnabled('s2', true)
    const reloaded = new SessionState(file)
    expect(reloaded.stateOf('s2').enabled).toBe(true)
  })
})