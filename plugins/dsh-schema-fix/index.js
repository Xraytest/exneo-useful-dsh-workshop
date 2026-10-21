/**
 * model-facing schema fix — a host-plane Cordis plugin for the DeepSeek Harness.
 *
 * Two independent repairs are applied to the tool schemas the model is about to
 * see, both inside the `system-prompt/assemble` waterfall and both on COPIES:
 * nothing about the durable tool catalog, header, dispatch, or replay changes.
 *
 * REPAIR 1 — union (`oneOf`) parameters.
 * This deployment's model tool-call path only JSON-parses a tool parameter when
 * that parameter's JSON Schema declares a TOP-LEVEL `type` (`object` / `array`).
 * `cordis_define`'s `plugin` parameter is a `oneOf` of two object branches with
 * no top-level `type`, so the nested object the model writes is delivered to the
 * tool as a STRING and the tool's own validation rejects it:
 *
 *     invalid arguments: "plugin" must match exactly one oneOf branch (matched 0)
 *
 * Flatten every such union into ONE top-level typed object schema: properties
 * merged across branches (differing `const` discriminators become an `enum`),
 * `required` set to the intersection. The REAL registry definition still
 * validates the arguments against the original `oneOf` at dispatch.
 *
 * REPAIR 2 — unconstrained parameters.
 * The author-facing `json` node compiles to an ANNOTATION-ONLY schema (no
 * `type`), i.e. "any JSON value". Strict upstreams reject that: ModelRun folds
 * the request grammar and refuses a parameter whose emitted value has more than
 * one JSON reading, failing the whole request before generation:
 *
 *     400 failed to translate request: folding the request grammar: tool
 *     "cordis_inspect_query" parameter schema: parameter "input": more than one
 *     JSON reading of the same emitted value
 *
 * The only such parameter in the whole catalog is `cordis_inspect_query.input`
 * (an inspect query payload), which is consumed as a JSON object. Constrain
 * every annotation-only parameter to `type: "object"` so the value has exactly
 * one JSON reading and the platform's converter hands the tool a real object.
 *
 * The row publishes no service — it only listens on the host
 * `system-prompt/assemble` waterfall — so it needs no isolate realm and sits
 * loose in the profile's patch layer, available to every session regardless of
 * which agent preset it runs.
 *
 * @module dsh-model-facing-schema-fix
 */

export const name = 'cordis-define-schema-fix';

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Flatten one `oneOf`-of-object-branches parameter spec into a single typed
 * object spec. Specs that are not a union of at least two object branches are
 * returned untouched.
 *
 * @param spec - the declared parameter schema.
 * @returns the flattened schema, or `spec` itself when nothing is safe to merge.
 */
function flattenUnionParameter(spec) {
  if (!isPlainObject(spec) || !Array.isArray(spec.oneOf)) return spec;
  const branches = spec.oneOf.filter((branch) => isPlainObject(branch)
    && branch.type === 'object' && isPlainObject(branch.properties));
  if (branches.length < 2) return spec;

  const properties = {};
  let required;
  for (const branch of branches) {
    const branchProperties = branch.properties;
    for (const key of Object.keys(branchProperties)) {
      const incoming = branchProperties[key];
      const existing = properties[key];
      if (existing === undefined) {
        properties[key] = incoming;
        continue;
      }
      if (JSON.stringify(existing) === JSON.stringify(incoming)) continue;
      // Differing discriminators (const) merge into one enum so the model can
      // still name every branch; otherwise the first branch's spec stands.
      const consts = [existing.const, incoming.const].filter((value) => value !== undefined);
      if (consts.length === 2 && existing.type === 'string' && incoming.type === 'string') {
        properties[key] = {
          type: 'string',
          enum: consts,
          ...existing.description !== undefined ? { description: existing.description } : {},
        };
      }
    }
    const branchRequired = Array.isArray(branch.required) ? [...branch.required] : [];
    required = required === undefined
      ? branchRequired
      : required.filter((key) => branchRequired.includes(key));
  }

  const flattened = {
    type: 'object',
    properties,
    required: required === undefined ? [] : required,
    additionalProperties: false,
  };
  if (typeof spec.description === 'string') flattened.description = spec.description;
  return flattened;
}

/**
 * Constrain one annotation-only parameter spec (no `type`, no union, no
 * `enum`/`const`) to an object schema, so a strict upstream sees exactly one
 * JSON reading for its emitted value. Any spec that already declares a shape is
 * returned untouched.
 *
 * @param spec - the declared parameter schema.
 * @returns the constrained schema, or `spec` itself when it already declares one.
 */
function constrainUnconstrainedParameter(spec) {
  if (!isPlainObject(spec)) return spec;
  if (spec.type !== undefined || spec.oneOf !== undefined || spec.anyOf !== undefined
    || spec.enum !== undefined || spec.const !== undefined) {
    return spec;
  }
  return { ...spec, type: 'object', additionalProperties: true };
}

/**
 * Project one model-facing tool schema with its parameters repaired.
 *
 * @param tool - one entry of the assembly's `tools` array.
 * @returns a repaired copy, or `tool` itself when every parameter is already safe.
 */
function repairToolSchema(tool) {
  if (!isPlainObject(tool) || !isPlainObject(tool.parameters) || !isPlainObject(tool.parameters.properties)) {
    return tool;
  }
  const properties = tool.parameters.properties;
  let changed = false;
  const repaired = {};
  for (const key of Object.keys(properties)) {
    const original = properties[key];
    const flattened = constrainUnconstrainedParameter(flattenUnionParameter(original));
    if (flattened !== original) changed = true;
    repaired[key] = flattened;
  }
  if (changed !== true) return tool;
  return {
    ...tool,
    parameters: { ...tool.parameters, properties: repaired },
  };
}

export function apply(ctx) {
  // The expert waterfall over the assembled sections, contexts, tools, and
  // variables: repair what the model is about to see, then hand the chain on.
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const result = await next();
    if (!isPlainObject(result) || !Array.isArray(result.tools)) return result;
    let changed = false;
    const tools = result.tools.map((tool) => {
      const repaired = repairToolSchema(tool);
      if (repaired !== tool) changed = true;
      return repaired;
    });
    return changed === true ? { ...result, tools } : result;
  });
}