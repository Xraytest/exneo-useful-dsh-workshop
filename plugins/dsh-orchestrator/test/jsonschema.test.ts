import { describe, expect, it } from 'vitest'
import { assertObjectSchema, extractJsonObject, isPlainJson, projectToHarnessSubset, validateJson, validateSchemaNode } from '../src/core/jsonschema.js'

describe('validateSchemaNode', () => {
  it('accepts a well-formed object schema', () => {
    const issues = validateSchemaNode({
      type: 'object',
      additionalProperties: false,
      properties: { items: { type: 'array', items: { type: 'string' } } },
      required: ['items'],
    })
    expect(issues).toEqual([])
  })

  it('rejects bad type, missing items, undeclared required keys', () => {
    const issues = validateSchemaNode({ type: 'object', properties: { a: { type: 'nope' } }, required: ['b'] })
    expect(issues.map((i) => i.path)).toEqual(['$', '$.a', '$'])
  })
})

describe('assertObjectSchema', () => {
  it('enforces object roots', () => {
    expect(assertObjectSchema({ type: 'string' }).ok).toBe(false)
    expect(assertObjectSchema({ type: 'object', additionalProperties: true, properties: {} }).ok).toBe(true)
  })
})

describe('validateJson', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      n: { type: 'integer', minimum: 2 },
      s: { type: 'string', minLength: 3 },
      list: { type: 'array', items: { type: 'string' }, minItems: 1 },
      mode: { type: 'string', enum: ['fast', 'slow'] },
    },
    required: ['n', 's'],
  }

  it('passes valid data', () => {
    expect(validateJson({ n: 4, s: 'yes', list: ['x'], mode: 'fast' }, schema)).toEqual([])
  })

  it('reports every violation with paths', () => {
    const violations = validateJson({ n: 1, s: 'no', list: [], mode: 'other', extra: 1 }, schema)
    expect(violations).toEqual([
      '$.n: below minimum 2',
      '$.s: shorter than minLength 3',
      '$.list: fewer than minItems 1',
      '$.mode: value is not one of the declared enum entries',
      '$: unexpected key "extra"',
    ])
  })

  it('requires required keys', () => {
    expect(validateJson({}, schema)).toContain('$: missing required key "n"')
  })
})

describe('projectToHarnessSubset', () => {
  it('keeps harness annotation keywords default and examples', () => {
    const projected = projectToHarnessSubset({
      type: 'object',
      additionalProperties: true,
      default: {},
      examples: [{ a: 1 }],
      properties: { n: { type: 'integer', default: 3, examples: [7] } },
    })
    expect(projected).toEqual({
      type: 'object',
      additionalProperties: true,
      default: {},
      examples: [{ a: 1 }],
      properties: { n: { type: 'integer', default: 3, examples: [7] } },
    })
  })

  it('drops unsupported keywords but keeps bounds for local checks', () => {
    const projected = projectToHarnessSubset({
      type: 'object',
      additionalProperties: false,
      minimum: 1,
      properties: { n: { type: 'integer', minLength: 2, description: 'kept' } },
    })
    expect(projected).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { n: { type: 'integer', description: 'kept' } },
    })
  })
})

describe('extractJsonObject', () => {
  it('prefers fenced JSON', () => {
    const fence = String.fromCharCode(96)
    const text = 'intro' + fence + fence + fence + 'json' + String.fromCharCode(10) + '{"a":1}' + String.fromCharCode(10) + fence + fence + fence + 'outro'
    expect(extractJsonObject(text)).toEqual({ a: 1 })
  })

  it('falls back to the first balanced object and respects strings', () => {
    expect(extractJsonObject('noise {"a":{"b":"c}"}} tail')).toEqual({ a: { b: 'c}' } })
    expect(extractJsonObject('no object here')).toBeUndefined()
  })
})

describe('isPlainJson', () => {
  it('rejects cycles and exotic values', () => {
    expect(isPlainJson({ a: [1, true, null] })).toBe(true)
    expect(isPlainJson(Infinity)).toBe(false)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(isPlainJson(cycle)).toBe(false)
    expect(isPlainJson(new Date())).toBe(false)
  })
})