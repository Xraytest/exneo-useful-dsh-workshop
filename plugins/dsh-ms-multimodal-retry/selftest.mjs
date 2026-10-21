/**
 * dsh-ms-multimodal-retry 的离线自检（不启动 dsh、不碰线上会话）。
 *
 * 用一个最小 session 替身驱动插件的 agent/request-error 监听器，验证：
 *   1. 命中模型 + 命中错误特征 → 剔除最早图像 → 返回 {kind:'retry'}；
 *   2. 剔除严格从最旧节点开始，且先落 compaction/prune 影子计价、后落替换事件；
 *   3. 模型不匹配 / 错误不匹配 / 已无图像 / 预算耗尽 → 一律 next() 交回下游；
 *   4. 取消信号 → 不重试；
 *   5. 多次命中按预算逐次再剔（第 2 次剔第 2 早的图），耗尽后交回。
 *
 * 运行： node plugins/dsh-ms-multimodal-retry/selftest.mjs
 */

import assert from 'node:assert/strict';
import { apply } from './index.js';

/** 最小 session 替身：只实现插件真正用到的接口。 */
function makeSession(fixtures, model = 'deepseek-ai/DeepSeek-V4.1-Flash') {
  const log = [];
  const nodes = new Map(fixtures.map((fixture) => [fixture.seq, fixture]));
  const surface = { nodes: fixtures.map((fixture) => fixture.seq) };
  return {
    surface,
    log,
    eventAt(seq) {
      return nodes.get(seq);
    },
    /** 真实 API 在 session 上（dsh-model-retry 同款读法）。 */
    requestHeader() {
      return { config: { model } };
    },
    append(type, data, opts) {
      const seq = 900 + log.length;
      const entry = { type, seq, data, opts };
      log.push(entry);
      // 复刻真实语义：replace 之后，面里的旧 seq 换成新 seq。
      if (opts?.surfaceOp?.op === 'replace') {
        const index = surface.nodes.indexOf(opts.surfaceOp.startSeq);
        if (index >= 0) surface.nodes[index] = seq;
        nodes.set(seq, { type, seq, data });
        nodes.delete(opts.surfaceOp.startSeq);
      }
      return { seq };
    },
  };
}

function imageNode(seq, attachment, extra = {}) {
  return {
    type: 'user/message',
    seq,
    appends: 0,
    data: {
      role: 'user',
      content: [
        { type: 'text', text: `head-${seq}` },
        { type: 'image', attachment },
        { type: 'text', text: `tail-${seq}` },
        ...(extra.nested
          ? [{ type: 'tool-result', toolCallId: `c${seq}`, content: [{ type: 'image', attachment: extra.nested }] }]
          : []),
      ],
    },
  };
}

function textNode(seq) {
  return {
    type: 'user/message',
    seq,
    appends: 0,
    data: { role: 'user', content: [{ type: 'text', text: `plain-${seq}` }] },
  };
}

function makeCtx(listeners) {
  const logger = {
    info: (message) => listeners.info.push(message),
    warn: (message) => listeners.warn.push(message),
  };
  return {
    logger,
    on(event, handler) {
      listeners[event] = handler;
      return () => delete listeners[event];
    },
    get(service) {
      if (service !== 'tokenMeter') throw new Error(`unexpected service ${service}`);
      return { estimateMessage: () => 42 };
    },
    effect(factory) {
      listeners.disposers.push(factory());
      return factory();
    },
  };
}

const A = { attachmentId: 'sha256:aaaa1111bbbb2222', name: 'a.png', width: 1920, height: 1061, bytes: 98429 };
const B = { attachmentId: 'sha256:cccc3333dddd4444', name: 'b.png', width: 1920, height: 1061, bytes: 98429 };
const C = { attachmentId: 'sha256:eeee5555ffff6666', name: 'c.png', width: 1920, height: 1080, bytes: 130000 };

const MS_FAILURE = {
  code: 'INVALID_REQUEST',
  status: 400,
  message: '400: {"message":"<400> ***.***.InvalidParameter: Download multimodal file timed out","type":"invalid_request_error","param":"","code":"invalid_parameter_error"}',
};

function boot(config, model = 'deepseek-ai/DeepSeek-V4.1-Flash') {
  const listeners = { info: [], warn: [], disposers: [] };
  const session = makeSession([textNode(1), imageNode(2, A), imageNode(3, B, { nested: C }), textNode(4)], model);
  const ctx = makeCtx(listeners);
  apply(ctx, config);
  return { listeners, session, ctx };
}

async function fire(harness, { failure = MS_FAILURE, model = 'deepseek-ai/DeepSeek-V4.1-Flash', provider = 'localhost', turn = 3, step = 16, signal } = {}) {
  const next = async () => ({ kind: 'downstream' });
  const agent = { session: harness.session };
  const payload = { agent, turn, step, provider, failure, signal };
  return harness.listeners['agent/request-error'](payload, next);
}

function imagesIn(session) {
  const walk = (blocks) => {
    let total = 0;
    for (const block of blocks ?? []) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'image') total += 1;
      else if (block.type === 'tool-result') total += walk(block.content);
    }
    return total;
  };
  let total = 0;
  for (const seq of session.surface.nodes) total += walk(session.eventAt(seq)?.data?.content);
  return total;
}

let passed = 0;
function check(name, fn) {
  return fn().then(
    () => {
      passed += 1;
      console.log(`  ok  ${name}`);
    },
    (error) => {
      console.error(`  FAIL ${name}\n      ${error?.stack ?? error}`);
      process.exitCode = 1;
    },
  );
}

await check('命中：剔除最早 1 张图并重试', async () => {
  const h = boot({ models: ['deepseek-ai/DeepSeek-V4.1-Flash'] });
  const action = await fire(h);
  assert.deepEqual(action, { kind: 'retry' });
  assert.equal(imagesIn(h.session), 2, '应剩 2 张图（A 被剔，B 与被嵌套的 C 仍在）');
  // 影子计价必须先于替换事件（token 折叠的邻接契约）。
  const pruneIndex = h.session.log.findIndex((event) => event.type === 'compaction/prune');
  const replaceIndex = h.session.log.findIndex((event) => event.opts?.surfaceOp?.op === 'replace');
  assert.ok(pruneIndex >= 0 && replaceIndex >= 0 && pruneIndex < replaceIndex, 'prune 必须紧邻替换之前');
  const replace = h.session.log[replaceIndex];
  assert.equal(replace.opts.surfaceOp.startSeq, 2);
  assert.equal(replace.opts.surfaceOp.endSeq, 2);
  assert.deepEqual(replace.opts.sourceEventSeqs, [2]);
  const content = replace.data.content;
  assert.equal(content.filter((block) => block.type === 'image').length, 0, '被替换节点内不应再有图像');
  assert.ok(content.some((block) => block.type === 'text' && block.text.includes('dsh-ms-multimodal-retry')));
  assert.ok(h.session.log[pruneIndex].data.shadowedTokenCount === 42, '影子计价走了 tokenMeter.estimateMessage');
  assert.ok(h.listeners.info.some((line) => line.includes('命中')), '应记录 info 日志');
});

await check('类型不同：命中超时但模型未选区 → 交回下游', async () => {
  const h = boot({ models: ['deepseek-ai/DeepSeek-V4.1-Flash'] }, 'step-5-preview');
  assert.deepEqual(await fire(h), { kind: 'downstream' });
  assert.equal(imagesIn(h.session), 3, '不匹配时一张图都不该动');
  assert.equal(h.session.log.length, 0, '不应写任何事件');
});

await check('错误特征不匹配（非多模态下载超时）→ 交回下游', async () => {
  const h = boot({ models: ['*'] });
  const failure = { code: 'INVALID_REQUEST', status: 400, message: '400: some other invalid parameter' };
  assert.deepEqual(await fire(h, { failure }), { kind: 'downstream' });
  assert.equal(imagesIn(h.session), 3);
});

await check('HTTP 状态码不匹配 → 交回下游', async () => {
  const h = boot({ models: ['*'] });
  const failure = { ...MS_FAILURE, status: 401, message: 'Download multimodal file timed out' };
  assert.deepEqual(await fire(h, { failure }), { kind: 'downstream' });
});

await check('上下文已无图像 → 交回下游', async () => {
  const listeners = { info: [], warn: [], disposers: [] };
  const session = makeSession([textNode(1), textNode(2)]);
  const ctx = makeCtx(listeners);
  apply(ctx, { models: ['*'] });
  const h = { listeners, session };
  assert.deepEqual(await fire(h), { kind: 'downstream' });
  assert.equal(session.log.length, 0);
  assert.ok(listeners.info.some((line) => line.includes('已无图像')));
});

await check('预算：同一步内逐次再剔，耗尽后交回', async () => {
  const h = boot({ models: ['*'], maxRetries: 2, delayMs: 0 });
  assert.deepEqual(await fire(h, { turn: 3, step: 16 }), { kind: 'retry' });
  assert.equal(imagesIn(h.session), 2);
  assert.deepEqual(await fire(h, { turn: 3, step: 16 }), { kind: 'retry' });
  assert.equal(imagesIn(h.session), 1);
  assert.deepEqual(await fire(h, { turn: 3, step: 16 }), { kind: 'downstream' }, '第 3 次应超预算交回');
  assert.equal(imagesIn(h.session), 1, '交回时不得再动图像');
  assert.ok(h.listeners.warn.some((line) => line.includes('预算')));
});

await check('取消信号：不剔除也不重试', async () => {
  const h = boot({ models: ['*'] });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await fire(h, { signal: controller.signal }), { kind: 'downstream' });
  assert.equal(imagesIn(h.session), 3);
  assert.equal(h.session.log.length, 0);
});

await check('agent/status idle 归零预算；跨 turn 不串味', async () => {
  const h = boot({ models: ['*'], maxRetries: 1, delayMs: 0 });
  assert.deepEqual(await fire(h, { turn: 3, step: 16 }), { kind: 'retry' });
  assert.deepEqual(await fire(h, { turn: 3, step: 16 }), { kind: 'downstream' });
  h.listeners['agent/status']({ agent: { session: h.session }, status: 'idle' });
  assert.deepEqual(await fire(h, { turn: 3, step: 16 }), { kind: 'retry' }, '空闲后预算应归零');
});

await check('配置兜底：空 models = 空转；错误配置不抛异常', async () => {
  const h = boot({});
  assert.deepEqual(await fire(h), { kind: 'downstream' });
  assert.equal(imagesIn(h.session), 3);
  const junk = boot({ models: ['*'], drop: -5, maxRetries: 'many', delayMs: null, errorStatus: ['abc', 700, 400], errorPatterns: [] });
  const action = await fire(junk);
  assert.deepEqual(action, { kind: 'retry' }, '错误配置下仍应自愈（回落缺省）');
  assert.equal(imagesIn(junk.session), 2);
});

await check('释放：dispose 后监听器与预算清空', async () => {
  const h = boot({ models: ['*'] });
  assert.equal(h.listeners.disposers.length, 1, 'effect 已注册');
  const dispose = h.listeners.disposers[0];
  assert.equal(typeof dispose, 'function');
  await dispose();
  assert.equal(h.listeners['agent/request-error'], undefined, '监听器应被摘除');
  assert.equal(h.listeners['agent/status'], undefined, 'status 监听器应被摘除');
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`);
