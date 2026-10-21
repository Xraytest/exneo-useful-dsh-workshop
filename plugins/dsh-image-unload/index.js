/**
 * Image context unload — a host-plane Cordis plugin for the DeepSeek Harness.
 *
 * It gives the model one tool, `unload_images`, that removes the images still in
 * the model-visible context from every LATER model request: user attachments and
 * images returned by `read_image`. Images are re-resolved on every request, so
 * each one keeps costing tokens until it is unloaded; this tool is the model's
 * explicit, recommended way to release that cost.
 *
 * Mechanism: each affected surface node (`user/message` / `tool/result`) is
 * shadowed by a replacement event whose image blocks became a short text
 * placeholder. The session's append-only log keeps the originals, so the human
 * transcript is unchanged; only the model-visible surface loses the images.
 *
 * Every replacement is preceded by a `compaction/prune` shadow-price event,
 * which is the same adjacency contract `toolResultPruner` follows: the token
 * fold prices a replacement from the metering event immediately before it, and
 * an unpriced replacement would make the context pressure projection drift.
 *
 * The row publishes no service — it only consumes the host `tools`,
 * `tokenMeter` and `attachments` registries — so it needs no isolate realm and
 * sits loose in the profile's patch layer, which makes the tool available to
 * every session regardless of which agent preset it runs.
 *
 * WHEN-to-use guidance is NOT baked into the system prompt here: it lives in
 * the `image-context-unload` skill, which every preset's `skill-filesystem`
 * scanner discovers from the user skill root and which the model is required to
 * consult after reading images.
 *
 * @module dsh-image-unload
 */

const TOOL_NAME = 'unload_images';
const DIGEST_PREFIX = 'sha256:';
const REPORT_LIMIT = 40;

/** Tool description: the recommendation the model reads when it decides to call. */
const TOOL_DESCRIPTION = [
  'Unload the images currently in this conversation\u2019s model context so later model requests stop resending them.',
  'Every image still in context — user attachments and images returned by read_image — is resent on every model request, so it keeps costing tokens until it is unloaded. This tool is the recommended way to release that cost: unloading is active and explicit (nothing is dropped unless you call it), so call it yourself as soon as you finish examining images and always before a long text-only stretch, instead of waiting for the harness to drop images under request limits.',
  'Each unloaded image is replaced by a short text placeholder that keeps its identity and how to recover it; call read_image on the same path to bring an image back when you need it. The user-visible transcript still shows the original images.',
  'Pass keep_last to leave the N most recent image occurrences in context. The trigger for calling it is the `image-context-unload` skill: load that skill immediately after reading images and follow it.',
].join(' ');

/** Plain-JSON-object guard for untouched block walking. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把一条工具结果消息归一成「真正的内容块数组 + 用新块数组重建消息的函数」。
 *
 * 两代形状不同：
 *   · 0.1：`role:'user'`，content = [一枚 `tool-result` 包装块]，真块在它的 `.content` 里；
 *   · 0.2：一等 `role:'tool'` 消息，content **就是**真块，callId/isError 挪到消息顶层。
 * 只认旧形状（读 `content[0].content`）会让 0.2 上工具返回的图片被静默跳过——
 * 计数为 0 → 不进 targets → 永远不会被卸载。回写方向同理：沿用旧包装块会在 0.2
 * 上写出非法消息。
 *
 * @param {object} message 工具结果消息。
 * @returns {{blocks: unknown[], rebuild: (blocks: unknown[]) => object}|undefined} 归一视图。
 */
function toolResultView(message) {
  const content = message === null || message === undefined ? undefined : message.content;
  if (!Array.isArray(content)) return undefined;
  const first = isRecord(content[0]) ? content[0] : undefined;
  if (first !== undefined && first.type === 'tool-result' && Array.isArray(first.content)) {
    return {
      blocks: first.content,
      rebuild: (blocks) => ({ ...message, content: [{ ...first, content: blocks }] }),
    };
  }
  return {
    blocks: content,
    rebuild: (blocks) => ({ ...message, content: blocks }),
  };
}

/** Count image occurrences in one content array, including nested tool results. */
function countImages(blocks) {
  if (!Array.isArray(blocks)) return 0;
  let count = 0;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === 'image') count += 1;
    else if (block.type === 'tool-result') count += countImages(block.content);
  }
  return count;
}

/**
 * Replace the first `budget.count` image occurrences with placeholder text.
 * Never mutates the frozen durable blocks; returns the original array when
 * nothing was dropped, so an unchanged node is never rewritten.
 */
function stripImages(blocks, budget, onDrop) {
  if (!Array.isArray(blocks)) return { blocks, used: 0 };
  let used = 0;
  let next;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (isRecord(block) && block.type === 'image') {
      if (used >= budget.count) {
        if (next !== undefined) next.push(block);
        continue;
      }
      next ??= blocks.slice(0, index);
      next.push({ type: 'text', text: onDrop(block.attachment) });
      used += 1;
      continue;
    }
    if (isRecord(block) && block.type === 'tool-result') {
      const nested = stripImages(block.content, { count: budget.count - used }, onDrop);
      if (nested.used > 0) {
        next ??= blocks.slice(0, index);
        next.push({ ...block, content: nested.blocks });
        used += nested.used;
        continue;
      }
    }
    if (next !== undefined) next.push(block);
  }
  return { blocks: next === undefined ? blocks : next, used };
}

/** Attachment digest, matching the `sha256:<hex>` identity the store brands. */
function imageId(ref) {
  const raw = typeof ref.attachmentId === 'string' ? ref.attachmentId : String(ref.attachmentId);
  return raw.startsWith(DIGEST_PREFIX) ? raw.slice(DIGEST_PREFIX.length, DIGEST_PREFIX.length + 8) : raw.slice(0, 8);
}

/** One-line identity of an image occurrence for reports and placeholders. */
function describeImage(ref) {
  const digest = imageId(ref);
  const name = typeof ref.name === 'string' && ref.name.length > 0 ? `"${ref.name}"` : `sha256:${digest}`;
  const dims = typeof ref.width === 'number' && typeof ref.height === 'number' ? `, ${ref.width}x${ref.height}px` : '';
  const bytes = typeof ref.bytes === 'number' ? `, ${ref.bytes} bytes` : '';
  return `${name} (${digest}${dims}${bytes})`;
}

/** Placeholder text left in the model-visible surface where an image was. */
function placeholderText(ref, origin, hostPath) {
  const recovery = hostPath === undefined
    ? 'It is no longer sent with model requests.'
    : `Normalized read-only copy: ${JSON.stringify(hostPath)}. Call read_image on that path when you need it again.`;
  const where = origin === 'tool-result' ? 'returned by a tool call' : 'attached by the user';
  return `[image unloaded from the model context at your request: ${describeImage(ref)}, ${where}. ${recovery}]`;
}

/** Compact per-image record for the tool result. */
function imageRecord(ref, origin, hostPath) {
  const record = {
    origin,
    digest: imageId(ref),
    attachmentId: typeof ref.attachmentId === 'string' ? ref.attachmentId : String(ref.attachmentId),
  };
  if (typeof ref.name === 'string' && ref.name.length > 0) record.name = ref.name;
  if (typeof ref.width === 'number') record.width = ref.width;
  if (typeof ref.height === 'number') record.height = ref.height;
  if (typeof ref.bytes === 'number') record.bytes = ref.bytes;
  if (hostPath !== undefined) record.hostPath = hostPath;
  return record;
}

/**
 * Every current surface node that still carries an image, oldest first.
 * `assistant/message` cannot carry `sourceEventSeqs` and therefore can never be
 * a replacement target; node 0 is the system prompt, which this walk never
 * touches because it only collects user and tool-result nodes.
 */
function collectTargets(session) {
  const targets = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (event.type === 'user/message') {
      const count = countImages(event.data.content);
      if (count === 0) continue;
      targets.push({
        type: 'user/message',
        seq,
        origin: 'attachment',
        count,
        blocks: event.data.content,
        price: event.data,
        replacement(blocks) {
          return { ...event.data, content: blocks };
        },
      });
      continue;
    }
    if (event.type === 'tool/result') {
      const view = toolResultView(event.data.message);
      if (view === undefined) continue;
      const count = countImages(view.blocks);
      if (count === 0) continue;
      targets.push({
        type: 'tool/result',
        seq,
        origin: 'tool-result',
        count,
        blocks: view.blocks,
        price: event.data.message,
        replacement(blocks) {
          return { ...event.data, message: view.rebuild(blocks) };
        },
      });
    }
  }
  return targets;
}

/** Shadow-price event immediately before one surface replacement. */
function appendShadowPrice(session, seq, tokens) {
  session.append('compaction/prune', {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount: tokens,
  });
}

/** Model-facing text projection of the tool result. */
function renderReport(value) {
  const lines = [
    `Unloaded ${value.unloaded} image(s) from the model context; ${value.kept} image(s) still in context.`,
  ];
  if (value.images.length > 0) {
    lines.push('Unloaded images:');
    for (const image of value.images) {
      lines.push(`- ${describeImage(image)}${image.hostPath === undefined ? '' : ` -> ${image.hostPath}`}`);
    }
    if (value.images.length < value.unloaded) {
      lines.push(`(+${value.unloaded - value.images.length} more not listed)`);
    }
  }
  lines.push('The user-visible transcript is unchanged; read_image on a listed path brings an image back when needed.');
  return lines.join('\n');
}

/** Validate the optional keep budget. */
function normalizeKeep(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${TOOL_NAME}: keep_last must be a non-negative safe integer`);
  }
  return value;
}

export const name = 'image-unload';

export function apply(ctx) {
  const attachments = ctx.get('attachments');
  const tokenMeter = ctx.get('tokenMeter');

  /** Execution-world read path of one stored image, when this backend has one. */
  const hostPathOf = (ref) => {
    if (attachments === undefined) return undefined;
    try {
      const value = attachments.imageHostPath(ref);
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };

  /** Heuristic token price of the message being shadowed; 0 without a meter. */
  const priceOf = (message) => {
    if (tokenMeter === undefined) return 0;
    try {
      const value = tokenMeter.estimateMessage(message);
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  };

  // NOTE: registration must wait for the `tools` service. This build has no
  // 'ready' lifecycle event (nothing emits one) — `ctx.inject` is the
  // canonical wait-for-service form and works at boot and on live patch
  // reload; the callback returns the registration disposer for the fiber.
  ctx.inject(['tools'], (ctx) => {
  return ctx.tools.register({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    // Parameter root deliberately left open, exactly as the canonical
    // `defineTool` projection of the same DSL does: the supported schema subset
    // carries no numeric bounds, so `keep_last` cannot be constrained to a
    // non-negative integer at the schema level and the body validates it.
    parameters: {
      type: 'object',
      properties: {
        keep_last: {
          type: 'integer',
          description: 'How many of the most recent image occurrences in the model context to keep; 0 (default) unloads every image still present.',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: renderReport(value) }];
      },
    },
    execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new Error(`${TOOL_NAME} requires an Agent-backed session`);
      const session = agent.session;
      const keep = normalizeKeep(args?.keep_last);
      const targets = collectTargets(session);
      let total = 0;
      for (const target of targets) total += target.count;

      // Drop the oldest occurrences first: `keep` is a budget on the most
      // recent ones, so a partial node keeps its tail and loses its head.
      let dropBudget = Math.max(0, total - keep);
      let unloaded = 0;
      const images = [];
      for (const target of targets) {
        let drop = Math.min(target.count, dropBudget);
        dropBudget -= drop;
        if (drop <= 0) continue;
        const origin = target.origin;
        const onDrop = (ref) => {
          const hostPath = hostPathOf(ref);
          if (images.length < REPORT_LIMIT) images.push(imageRecord(ref, origin, hostPath));
          return placeholderText(ref, origin, hostPath);
        };
        const before = images.length;
        const stripped = stripImages(target.blocks, { count: drop }, onDrop);
        if (stripped.used !== drop) {
          images.length = before;
          continue;
        }
        appendShadowPrice(session, target.seq, priceOf(target.price));
        session.append(target.type, target.replacement(stripped.blocks), {
          surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
          sourceEventSeqs: [target.seq],
        });
        unloaded += stripped.used;
      }

      return {
        unloaded,
        kept: total - unloaded,
        contextImages: total - unloaded,
        images,
        shadowPriced: tokenMeter !== undefined,
      };
    },
    presentCall(args) {
      const keep = typeof args?.keep_last === 'number' ? ` (keeping ${args.keep_last})` : '';
      return { card: 'generic', kind: 'execute', title: `Unload images from model context${keep}` };
    },
  });
  });
}
