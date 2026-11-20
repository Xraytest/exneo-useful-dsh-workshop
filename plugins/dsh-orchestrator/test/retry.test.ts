import { describe, expect, it } from 'vitest'
import { DEFAULT_RETRY, backoffDelay, isRetryable } from '../src/core/retry.js'

describe('isRetryable', () => {
  it('retries transient failures only', () => {
    expect(isRetryable('timeout')).toBe(true)
    expect(isRetryable('critic-rejected')).toBe(true)
    expect(isRetryable('schema-invalid')).toBe(true)
    expect(isRetryable('start-failed')).toBe(true)
    expect(isRetryable('aborted')).toBe(false)
    expect(isRetryable('refusal')).toBe(false)
    expect(isRetryable('budget')).toBe(false)
    expect(isRetryable('dependency')).toBe(false)
    expect(isRetryable('infra')).toBe(false)
  })
})

describe('backoffDelay', () => {
  it('grows exponentially and clamps at maxDelayMs', () => {
    expect(backoffDelay(1, DEFAULT_RETRY, () => 0.5)).toBe(500)
    expect(backoffDelay(2, DEFAULT_RETRY, () => 0.5)).toBe(1000)
    expect(backoffDelay(8, DEFAULT_RETRY, () => 0.5)).toBe(8000)
    expect(backoffDelay(12, DEFAULT_RETRY, () => 0.5)).toBe(8000)
  })

  it('applies symmetric jitter', () => {
    const low = backoffDelay(1, DEFAULT_RETRY, () => 0)
    const high = backoffDelay(1, DEFAULT_RETRY, () => 1)
    expect(low).toBe(400)
    expect(high).toBe(600)
  })
})