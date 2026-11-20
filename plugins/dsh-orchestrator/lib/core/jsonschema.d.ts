/**
 * A dependency-free validator for the JSON Schema subset the harness accepts for
 * structured subagent output. The dsh adapter additionally runs the harness's own
 * `assertObjectJsonSchema`; this copy keeps `src/core` harness-free and lets the
 * engine reject a worker result before it is recorded as success.
 * @module dsh-orchestrator/core/jsonschema
 */
import type { JsonObject, JsonValue } from './types.js';
export interface SchemaIssue {
    readonly path: string;
    readonly message: string;
}
/** Structural check of a schema node (not of data). */
export declare function validateSchemaNode(node: unknown, path?: string): SchemaIssue[];
/**
 * Project a schema onto the harness's enforced subset
 * (`type/oneOf/properties/required/additionalProperties/items/enum/const` plus annotations).
 * Bounds such as `minimum` or `minLength` are kept for local validation only.
 */
export declare function projectToHarnessSubset(node: unknown): JsonValue;
/** The harness only accepts object-rooted schemas for structured output. */
export declare function assertObjectSchema(node: unknown): {
    ok: true;
    schema: JsonObject;
} | {
    ok: false;
    issues: SchemaIssue[];
};
/** Validate data against the supported subset; returns path-qualified violations. */
export declare function validateJson(value: unknown, schema: unknown, path?: string): string[];
/** Lossless-JSON check: no undefined, NaN, Infinity, cycles, or non-plain objects. */
export declare function isPlainJson(value: unknown, seen?: Set<object>): value is JsonValue;
/** Extract the first JSON object from a worker's prose (```json fence, else first balanced object). */
export declare function extractJsonObject(text: string): JsonValue | undefined;
