import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileJournal } from '../src/dsh/journal.js'
import type { RunRecord } from '../src/core/types.js'

const dirs: string[] = []
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-journal-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const record = (id: string): RunRecord => ({
  id,
  goal: 'goal ' + id,
  parentSessionId: 'sess',
  status: 'succeeded',
  createdAt: 1,
  startedAt: 1,
  endedAt: 5,
  tasks: {},
  budget: {
    limits: {},
    elapsedMs: 4,
    activations: 1,
    tasks: 1,
    outputChars: 9,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
  },
  replans: 0,
  trigger: { kind: 'tool' },
})

describe('FileJournal', () => {
  it('appends events as JSONL and finalizes one record', () => {
    const dir = makeDir()
    const journal = new FileJournal({ dir })
    journal.append({ type: 'run/created', runId: 'r1', goal: 'g', trigger: { kind: 'tool' }, time: 10 })
    journal.append({ type: 'task/started', runId: 'r1', taskId: 'a', attempt: 1, time: 11 })
    journal.append({ type: 'run/diagnostic', runId: 'r1', message: 'x'.repeat(9000), time: 12 })
    journal.finalize(record('r1'))
    const lines = readFileSync(join(dir, 'r1.events.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]).type).toBe('run/created')
    expect(JSON.parse(lines[2]).message.length).toBeLessThan(8200)
    const persisted = JSON.parse(readFileSync(join(dir, 'r1.record.json'), 'utf8'))
    expect(persisted.status).toBe('succeeded')
    expect(journal.read('r1')?.id).toBe('r1')
    expect(journal.list()[0]).toMatchObject({ id: 'r1', status: 'succeeded' })
  })

  it('ignores hostile run ids and never throws', () => {
    const dir = makeDir()
    const journal = new FileJournal({ dir })
    journal.append({ type: 'run/created', runId: '../evil', goal: 'g', trigger: { kind: 'tool' }, time: 1 })
    journal.finalize({ ...record('ok'), id: '../../escape' })
    expect(readdirSync(dir)).toEqual([])
    expect(journal.read('../evil')).toBeUndefined()
  })

  it('keeps working when the directory cannot be created', () => {
    const problems: string[] = []
    const journal = new FileJournal({ dir: 'Z:\\definitely-not\\a\\real\\path\\x' + String(Date.now()), log: (m) => problems.push(m) })
    expect(() => {
      journal.append({ type: 'run/created', runId: 'r2', goal: 'g', trigger: { kind: 'tool' }, time: 1 })
      journal.finalize(record('r2'))
    }).not.toThrow()
    expect(problems.length).toBeGreaterThan(0)
    expect(existsSync('Z:\\definitely-not\\a\\real\\path')).toBe(false)
  })
})
