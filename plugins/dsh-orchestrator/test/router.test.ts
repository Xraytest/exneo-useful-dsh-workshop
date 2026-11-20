import { describe, expect, it } from 'vitest'
import { EMPTY_ROUTING, mergeRoute, resolveRoute, routeLabel, wildcardMatch } from '../src/core/router.js'
import { task } from './helpers.js'

describe('wildcardMatch', () => {
  it('supports * and stays case-insensitive', () => {
    expect(wildcardMatch('co*', 'Coder')).toBe(true)
    expect(wildcardMatch('*', 'anything')).toBe(true)
    expect(wildcardMatch('co*', 'writer')).toBe(false)
  })
})

describe('resolveRoute', () => {
  it('puts explicit task route first', () => {
    const resolved = resolveRoute(
      task({ id: 'a', role: 'coder', route: { model: 'm-task' } }),
      { roles: { coder: { model: 'm-role' } }, rules: [{ match: { role: 'coder' }, route: { model: 'm-rule' } }] },
    )
    expect(resolved.source).toBe('task')
    expect(resolved.route).toEqual({ model: 'm-task' })
  })

  it('rule beats role, role beats default, default beats inherit', () => {
    const rules = [{ name: 'research', match: { taskId: 'res-*' }, route: { provider: 'p-rule' } }]
    expect(resolveRoute(task({ id: 'res-1', role: 'coder' }), { roles: { coder: { provider: 'p-role' } }, rules }).source).toBe('rule')
    expect(resolveRoute(task({ id: 'x', role: 'coder' }), { roles: { coder: { provider: 'p-role' } }, rules }).source).toBe('role')
    expect(resolveRoute(task({ id: 'x', role: 'writer' }), { roles: {}, rules, default: { provider: 'p-def' } }).source).toBe('default')
    expect(resolveRoute(task({ id: 'x', role: 'writer' }), EMPTY_ROUTING).source).toBe('inherit')
  })

  it('ignores rules whose match block is empty', () => {
    const resolved = resolveRoute(task({ id: 'x' }), { roles: {}, rules: [{ match: {}, route: { provider: 'p' } }] })
    expect(resolved.source).toBe('inherit')
  })
})

describe('mergeRoute', () => {
  it('overlays defined fields', () => {
    expect(mergeRoute({ provider: 'a', model: 'm1' }, { model: 'm2' })).toEqual({ provider: 'a', model: 'm2' })
    expect(mergeRoute(undefined, { model: 'm' })).toEqual({ model: 'm' })
    expect(mergeRoute({ model: 'm' }, undefined)).toEqual({ model: 'm' })
  })
})

describe('routeLabel', () => {
  it('renders provider/model@effort', () => {
    expect(routeLabel({ provider: 'p', model: 'm', reasoningEffort: 'high' })).toBe('p/m@high')
    expect(routeLabel(undefined)).toBe('inherit')
  })
})
