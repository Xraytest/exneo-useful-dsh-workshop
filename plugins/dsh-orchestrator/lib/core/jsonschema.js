const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null'];
const ALL_TYPES = [...SCALAR_TYPES, 'object', 'array'];
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Structural check of a schema node (not of data). */
export function validateSchemaNode(node, path = '$') {
    if (!isRecord(node))
        return [{ path, message: 'schema node must be an object' }];
    const issues = [];
    const type = node['type'];
    if (typeof type !== 'string' || !ALL_TYPES.includes(type)) {
        issues.push({ path, message: `unsupported or missing "type" (expected one of ${ALL_TYPES.join(', ')})` });
        return issues;
    }
    if (type === 'object') {
        if (typeof node['additionalProperties'] !== 'boolean') {
            issues.push({ path, message: 'object nodes must declare additionalProperties as a boolean' });
        }
        const properties = node['properties'];
        if (properties !== undefined && !isRecord(properties)) {
            issues.push({ path, message: '"properties" must be an object' });
        }
        else if (isRecord(properties)) {
            for (const [key, child] of Object.entries(properties)) {
                issues.push(...validateSchemaNode(child, `${path}.${key}`));
            }
        }
        const required = node['required'];
        if (required !== undefined) {
            if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
                issues.push({ path, message: '"required" must be an array of strings' });
            }
            else if (isRecord(properties)) {
                for (const key of required) {
                    if (!(key in properties))
                        issues.push({ path, message: `required key "${key}" has no property schema` });
                }
            }
        }
    }
    if (type === 'array') {
        if (node['items'] === undefined)
            issues.push({ path, message: 'array nodes must declare "items"' });
        else
            issues.push(...validateSchemaNode(node['items'], `${path}[]`));
    }
    if (node['enum'] !== undefined) {
        if (!Array.isArray(node['enum']) || node['enum'].length === 0) {
            issues.push({ path, message: '"enum" must be a non-empty array' });
        }
        else {
            for (const entry of node['enum']) {
                if (typeOfJson(entry) !== type && !(type === 'integer' && typeOfJson(entry) === 'number')) {
                    issues.push({ path, message: `enum entry ${JSON.stringify(entry)} does not match type "${type}"` });
                }
            }
        }
    }
    if (node['oneOf'] !== undefined) {
        if (!Array.isArray(node['oneOf']) || node['oneOf'].length < 2) {
            issues.push({ path, message: '"oneOf" must list at least two branches' });
        }
        else {
            for (const [index, branch] of node['oneOf'].entries()) {
                issues.push(...validateSchemaNode(branch, `${path}|${index}`));
            }
        }
    }
    return issues;
}
/**
 * Keywords the harness accepts on a structured-output schema. Anything else is
 * dropped by {@link projectToHarnessSubset}; local validation stays stricter.
 */
const HARNESS_KEYWORDS = new Set([
    'type',
    'oneOf',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'description',
    'title',
    'default',
    'examples',
]);
/**
 * Project a schema onto the harness's enforced subset
 * (`type/oneOf/properties/required/additionalProperties/items/enum/const` plus annotations).
 * Bounds such as `minimum` or `minLength` are kept for local validation only.
 */
export function projectToHarnessSubset(node) {
    if (!isRecord(node))
        return null;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
        if (!HARNESS_KEYWORDS.has(key))
            continue;
        if (key === 'properties' && isRecord(value)) {
            const properties = {};
            for (const [name, child] of Object.entries(value))
                properties[name] = projectToHarnessSubset(child);
            out[key] = properties;
        }
        else if (key === 'items') {
            out[key] = projectToHarnessSubset(value);
        }
        else if (key === 'oneOf' && Array.isArray(value)) {
            out[key] = value.map((branch) => projectToHarnessSubset(branch));
        }
        else if (isPlainJson(value)) {
            out[key] = value;
        }
    }
    return out;
}
/** The harness only accepts object-rooted schemas for structured output. */
export function assertObjectSchema(node) {
    const issues = validateSchemaNode(node);
    if (issues.length === 0 && (!isRecord(node) || node['type'] !== 'object')) {
        issues.push({ path: '$', message: 'structured output schema must be object-rooted' });
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true, schema: node };
}
function typeOfJson(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return 'array';
    return typeof value;
}
/** Validate data against the supported subset; returns path-qualified violations. */
export function validateJson(value, schema, path = '$') {
    if (!isRecord(schema))
        return [`${path}: invalid schema node`];
    const type = schema['type'];
    const actual = typeOfJson(value);
    const matches = actual === type || (type === 'integer' && actual === 'number' && Number.isInteger(value));
    if (!matches)
        return [`${path}: expected ${String(type)}, got ${actual}`];
    const violations = [];
    if (Array.isArray(schema['oneOf'])) {
        const matches = schema['oneOf'].filter((branch) => validateJson(value, branch, path).length === 0);
        if (matches.length !== 1)
            violations.push(`${path}: matched ${matches.length} oneOf branches, expected exactly 1`);
    }
    if (schema['enum'] !== undefined && Array.isArray(schema['enum'])) {
        if (!schema['enum'].some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
            violations.push(`${path}: value is not one of the declared enum entries`);
        }
    }
    if (schema['const'] !== undefined && JSON.stringify(schema['const']) !== JSON.stringify(value)) {
        violations.push(`${path}: value does not equal the declared const`);
    }
    if (type === 'string' && typeof value === 'string') {
        const min = schema['minLength'];
        const max = schema['maxLength'];
        if (typeof min === 'number' && value.length < min)
            violations.push(`${path}: shorter than minLength ${min}`);
        if (typeof max === 'number' && value.length > max)
            violations.push(`${path}: longer than maxLength ${max}`);
    }
    if ((type === 'number' || type === 'integer') && typeof value === 'number') {
        const min = schema['minimum'];
        const max = schema['maximum'];
        if (typeof min === 'number' && value < min)
            violations.push(`${path}: below minimum ${min}`);
        if (typeof max === 'number' && value > max)
            violations.push(`${path}: above maximum ${max}`);
    }
    if (type === 'array' && Array.isArray(value)) {
        const min = schema['minItems'];
        const max = schema['maxItems'];
        if (typeof min === 'number' && value.length < min)
            violations.push(`${path}: fewer than minItems ${min}`);
        if (typeof max === 'number' && value.length > max)
            violations.push(`${path}: more than maxItems ${max}`);
        for (const [index, item] of value.entries()) {
            violations.push(...validateJson(item, schema['items'], `${path}[${index}]`));
        }
    }
    if (type === 'object' && isRecord(value)) {
        const properties = isRecord(schema['properties']) ? schema['properties'] : {};
        const required = Array.isArray(schema['required']) ? schema['required'] : [];
        for (const key of required) {
            if (!(key in value))
                violations.push(`${path}: missing required key "${key}"`);
        }
        for (const [key, entry] of Object.entries(value)) {
            const child = properties[key];
            if (child === undefined) {
                if (schema['additionalProperties'] === false)
                    violations.push(`${path}: unexpected key "${key}"`);
            }
            else {
                violations.push(...validateJson(entry, child, `${path}.${key}`));
            }
        }
    }
    return violations;
}
/** Lossless-JSON check: no undefined, NaN, Infinity, cycles, or non-plain objects. */
export function isPlainJson(value, seen = new Set()) {
    if (value === null)
        return true;
    const kind = typeof value;
    if (kind === 'string' || kind === 'boolean')
        return true;
    if (kind === 'number')
        return Number.isFinite(value);
    if (kind !== 'object')
        return false;
    const object = value;
    if (seen.has(object))
        return false;
    seen.add(object);
    if (Array.isArray(value))
        return value.every((entry) => isPlainJson(entry, seen));
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null)
        return false;
    return Object.values(value).every((entry) => isPlainJson(entry, seen));
}
/** Extract the first JSON object from a worker's prose (```json fence, else first balanced object). */
export function extractJsonObject(text) {
    const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
    for (const match of text.matchAll(fence)) {
        const parsed = tryParse(match[1]?.trim() ?? '');
        if (parsed !== undefined)
            return parsed;
    }
    const start = text.indexOf('{');
    if (start < 0)
        return undefined;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"')
            inString = true;
        else if (char === '{')
            depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0)
                return tryParse(text.slice(start, index + 1));
        }
    }
    return undefined;
}
function tryParse(text) {
    if (!text)
        return undefined;
    try {
        const parsed = JSON.parse(text);
        return isPlainJson(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
