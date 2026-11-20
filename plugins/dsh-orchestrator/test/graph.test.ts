import { describe, expect, it } from 'vitest'
import { dependentsOf, readyTasks, topologicalWaves, validateGraph } from '../src/core/graph.js'
import { task } from './helpers.js'

describe('validateGraph', () => {
  it('flags an empty task list', () => {
    expect(validateGraph([])).toEqual([{ code: 'empty', message: 'plan contains no tasks', taskIds: [] }])
  })
  it('flags duplicate ids, unknown deps, and self deps', () => {
    const issues = validateGraph([
      task({ id: 'a' }),
      task({ id: 'a' }),
      task({ id: 'b', dependsOn: ['nope'] }),
      task({ id: 'c', dependsOn: ['c'] }),
    ])
    expect(issues.map((i) => i.code)).toEqual(['duplicate-id', 'unknown-dependency', 'self-dependency'])
  })
  it('reports a real cycle witness', () => {
    const issues = validateGraph([
      task({ id: 'a', dependsOn: ['b'] }),
      task({ id: 'b', dependsOn: ['a'] }),
      task({ id: 'c' }),
    ])
    const cycle = issues.find((i) => i.code === 'cycle')
    expect(cycle?.taskIds).toEqual(['a', 'b', 'a'])
  })
})

describe('topologicalWaves', () => {
  it('groups independent layers', () => {
    const waves = topologicalWaves([
      task({ id: 'c', dependsOn: ['a', 'b'] }),
      task({ id: 'a' }),
      task({ id: 'b', dependsOn: ['a'] }),
    ])
    expect(waves).toEqual([['a'], ['b'], ['c']])
  })
})

describe('readyTasks', () => {
  it('only returns pending tasks whose deps all succeeded', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b', dependsOn: ['a'] }), task({ id: 'c' })]
    const statusOf = (id: string) => (id === 'a' ? 'succeeded' : id === 'b' ? 'pending' : 'skipped')
    expect(readyTasks(tasks, statusOf).map((t) => t.id)).toEqual(['b'])
  })
})

describe('dependentsOf', () => {
  it('walks transitively and excludes the seeds', () => {
    const tasks = [
      task({ id: 'a' }),
      task({ id: 'b', dependsOn: ['a'] }),
      task({ id: 'c', dependsOn: ['b'] }),
      task({ id: 'd' }),
    ]
    expect([...dependentsOf(tasks, ['a'])].sort()).toEqual(['b', 'c'])
  })
})
