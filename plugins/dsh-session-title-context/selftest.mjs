/**
 * dsh-session-title-context 自测（不需要跑整个 harness）：
 *
 *   node /root/.dsh/profiles/web/plugins/dsh-session-title-context/selftest.mjs
 *
 * 覆盖：上下文构造（去图片/去 reasoning/丢未完成消息/工具配对/边界截断）、
 * 工具调用取标题、文本兜底、一次性模型指定、以及真正发给 llm.stream 的
 * 请求形状（purpose / tools / 无图片块）。
 */

import assert from 'node:assert/strict';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import {
  ToolCallId,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';
import { buildTitleContext, createTitleProvider, readConfig, titleFromBlocks } from './session-title.js';

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok   ${label}\n`);
}
async function checkAsync(label, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`ok   ${label}\n`);
}

// ------------------------------------------------------------------ 构造真会话
function buildSession() {
  const session = Session.create(SessionId('session-selftest'));
  const append = (type, data, opts) => session.append(type, data, opts ?? { surfaceOp: 'append' });
  const image = (name) => ({
    type: 'image',
    attachment: { attachmentId: `sha256:${name}`, mediaType: 'image/png', bytes: 1234, width: 800, height: 600, name },
  });

  const h1 = createUserMessage({
    content: [{ type: 'text', text: '把龙门场景从设计图重建出来' }, image('ref.png')],
    source: { kind: 'user' },
  });
  append('system/message', { turn: 1, step: 1, message: createSystemMessage('HARNESS SYSTEM PROMPT（不该进标题上下文）', 'test') });
  const h1Event = append('user/message', h1);

  const a1 = createAssistantMessage({
    content: [
      { type: 'reasoning', text: '内部推理：先看设计图再建白模，这段不该进标题上下文' },
      { type: 'text', text: '我先看一下 designs 目录里的设计图。' },
      { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{"command":"ls designs"}' },
    ],
    source: { provider: 'test-provider', model: 'test-model' },
  });
  append('assistant/message', { turn: 1, step: 1, message: a1, stream: [] });

  append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [{ type: 'text', text: `long-output:${'x'.repeat(4000)}` }],
      isError: false,
    }),
  });

  // 孤儿结果：没有对应的 tool-call，必须被丢掉。
  append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('call-orphan'),
      content: [{ type: 'text', text: '不该出现的孤儿工具结果' }],
      isError: false,
    }),
  });

  // 只有未配对 tool-call 的 assistant 消息：整条消息应当消失。
  const aBad = createAssistantMessage({
    content: [{ type: 'tool-call', id: ToolCallId('call-unpaired'), name: 'bash', arguments: '{}' }],
    source: { provider: 'test-provider', model: 'test-model' },
  });
  append('assistant/message', { turn: 1, step: 1, message: aBad, stream: [] });

  // 未完整生成的消息（被取消的中间前缀，落在修订边界之内）：必须被忽略。
  const interrupted = createAssistantMessage({
    content: [{ type: 'text', text: '我正在写一段永远没有写完的回复' }],
    source: { provider: 'test-provider', model: 'test-model' },
  });
  append('assistant/message', { turn: 2, step: 2, message: interrupted, stream: [], interrupted: true });

  const h2 = createUserMessage({
    content: [{ type: 'text', text: '顺便把接缝设计也补上' }, image('seam.jpg')],
    source: { kind: 'user' },
  });
  const h2Event = append('user/message', h2);

  // 边界之后的消息：本次修订不该看到（等价于“对话正在运行时尚未生成完的部分”）。
  const a2 = createAssistantMessage({
    content: [{ type: 'text', text: '边界之后的回复' }],
    source: { provider: 'test-provider', model: 'test-model' },
  });
  append('assistant/message', { turn: 3, step: 1, message: a2, stream: [] });

  const h3 = createUserMessage({ content: [{ type: 'text', text: '超出本次修订边界的消息' }], source: { kind: 'user' } });
  const h3Event = append('user/message', h3);

  return { session, h1Seq: h1Event.seq, h2Seq: h2Event.seq, h3Seq: h3Event.seq };
}

const { session, h1Seq, h2Seq, h3Seq } = buildSession();
const config = readConfig({ toolResultMaxBytes: 1200, maxInputBytes: 65536 });

// --------------------------------------------------------------- 上下文构造
const context = buildTitleContext(session, { throughSeq: h2Seq, config, reservedBytes: 0 });

check('边界之内只保留完整、文本、成对的消息', () => {
  assert.equal(context.messages.length, 4, `期望 4 条上下文，实际 ${context.messages.length}`);
  assert.deepEqual(context.seqs, [h1Seq, h2Seq]);
  assert.ok(!context.seqs.includes(h3Seq), '超过修订边界的消息不能进上下文');
});

check('图片换成占位文本（字节绝不进上下文）', () => {
  const flat = JSON.stringify(context.messages);
  assert.equal(flat.includes('"type":"image"'), false);
  assert.equal(context.stats.images, 2);
  assert.ok(flat.includes('图片已省略'), '占位文本应保留“图片已省略”');
  assert.ok(flat.includes('ref.png'), '占位文本应保留文件名');
});

check('reasoning 块被丢弃', () => {
  const flat = JSON.stringify(context.messages);
  assert.equal(flat.includes('"type":"reasoning"'), false);
  assert.equal(context.stats.reasoning, 1);
});

check('未完整生成的消息被忽略', () => {
  const flat = JSON.stringify(context.messages);
  assert.equal(flat.includes('永远没有写完'), false);
  assert.equal(flat.includes('边界之后的回复'), false);
  assert.equal(context.stats.interrupted, 1);
});

check('工具调用/结果成对保留，孤儿块被清掉', () => {
  const flat = JSON.stringify(context.messages);
  assert.ok(flat.includes('"id":"call-1"'), '成对的 tool-call 应保留');
  assert.ok(flat.includes('long-output'), '成对的 tool-result 应保留');
  assert.equal(flat.includes('孤儿工具结果'), false);
  assert.equal(flat.includes('call-unpaired'), false);
  assert.equal(context.stats.orphanResults, 1);
  assert.equal(context.stats.orphanCalls, 1);
});

check('system prompt 默认不进标题上下文', () => {
  assert.equal(context.stats.systemDropped, 1);
  assert.equal(JSON.stringify(context.messages).includes('HARNESS SYSTEM PROMPT'), false);
});

check('工具结果按 toolResultMaxBytes 截断', () => {
  const flat = JSON.stringify(context.messages);
  assert.ok(flat.includes('已截断'), '超长工具结果应带截断标记');
  assert.ok(!flat.includes('x'.repeat(2000)), '超长工具结果不应原样带入');
});

// ------------------------------------------------------------------ 假 ctx
function makeCtx(scripts) {
  const calls = [];
  let index = 0;
  return {
    calls,
    logger: { info() {}, warn() {}, error() {} },
    llm: {
      stream(options) {
        calls.push(options);
        const script = scripts[index] ?? [];
        index += 1;
        return (async function* generate() {
          for (const chunk of script) yield chunk;
        })();
      },
      listProviders() {
        return [
          { id: 'session-provider', name: 'Session Provider' },
          { id: 'other-provider', name: 'Other Provider' },
        ];
      },
      async listModels(provider) {
        return [{ provider, id: 'session-model', name: 'Session Model' }];
      },
    },
  };
}

const reasoningThenToolCall = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: '推理：这段思考内容不该被当成标题' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: '推理：这段思考内容不该被当成标题' } },
  { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 1, id: 'call-tool', name: 'submit_session_title', argumentsDelta: '{"title":"' },
  { type: 'tool-call-delta', index: 1, id: 'call-tool', name: 'submit_session_title', argumentsDelta: '龙门场景重建与接缝"}' },
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-tool', name: 'submit_session_title', arguments: '{"title":"龙门场景重建与接缝"}' } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
];

const textOnly = [
  { type: 'text-delta', index: 0, text: '好的，标题如下：' },
  { type: 'text-delta', index: 0, text: '\n会话标题：龙门场景重建与接缝' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '好的，标题如下：\n会话标题：龙门场景重建与接缝' } },
  { type: 'finish', reason: { kind: 'stop' } },
];

const request = (overrides = {}) => ({
  session,
  messages: [
    { seq: h1Seq, text: '把龙门场景从设计图重建出来' },
    { seq: h2Seq, text: '顺便把接缝设计也补上' },
  ],
  route: { provider: 'session-provider', model: 'session-model' },
  signal: new AbortController().signal,
  ...overrides,
});

await checkAsync('推理模型：标题从 tool-call 参数取出，reasoning 被忽略', async () => {
  const ctx = makeCtx([reasoningThenToolCall]);
  const provider = createTitleProvider({ ctx, config, overrides: new Map() });
  assert.equal(provider.automatic, 'all-prompts');
  const result = await provider.generate(request());
  assert.equal(result.title, '龙门场景重建与接缝');
  assert.deepEqual(result.messageSeqs, [h1Seq, h2Seq]);
  assert.deepEqual(result.model, { provider: 'session-provider', model: 'session-model' });

  const options = ctx.calls[0];
  assert.equal(options.purpose, 'session-title', '必须标记为辅助请求');
  assert.equal(options.provider, 'session-provider', '默认用当前会话模型');
  assert.equal(options.model, 'session-model');
  assert.equal(options.tools.length, 1);
  assert.equal(options.tools[0].name, 'submit_session_title');
  assert.equal(options.maxTokens, config.maxOutputTokens);
  assert.equal(options.sessionId, session.id);
  assert.equal(options.messages.at(-1).content[0].text.includes('submit_session_title'), true, '收尾消息应点名工具');
  const flat = JSON.stringify(options.messages);
  assert.equal(flat.includes('"type":"image"'), false, '请求里不能有图片块');
  assert.equal(flat.includes('x'.repeat(2000)), false);
});

await checkAsync('一次性指定模型只作用于紧接着的那一次生成', async () => {
  const ctx = makeCtx([reasoningThenToolCall, reasoningThenToolCall]);
  const overrides = new Map();
  const provider = createTitleProvider({ ctx, config, overrides });
  overrides.set(session.id, { provider: 'other-provider', model: 'other-model', at: Date.now() });
  const result = await provider.generate(request());
  assert.deepEqual(result.model, { provider: 'other-provider', model: 'other-model' });
  assert.equal(ctx.calls[0].provider, 'other-provider');
  assert.equal(overrides.size, 0, '一次性指定应被消费掉');

  const second = await provider.generate(request());
  assert.deepEqual(second.model, { provider: 'session-provider', model: 'session-model' }, '下一次回到会话模型');
  assert.equal(ctx.calls[1].provider, 'session-provider');
});

await checkAsync('过期的一次性指定不生效', async () => {
  const ctx = makeCtx([reasoningThenToolCall]);
  const overrides = new Map();
  const provider = createTitleProvider({ ctx, config, overrides });
  overrides.set(session.id, { provider: 'other-provider', model: 'other-model', at: Date.now() - 3600_000 });
  const result = await provider.generate(request());
  assert.deepEqual(result.model, { provider: 'session-provider', model: 'session-model' });
});

await checkAsync('模型只回文本时用文本兜底', async () => {
  const ctx = makeCtx([textOnly]);
  const provider = createTitleProvider({ ctx, config, overrides: new Map() });
  const result = await provider.generate(request());
  assert.equal(result.title, '龙门场景重建与接缝');
  assert.equal(ctx.calls.length, 1);
});

await checkAsync('工具通道失败时自动退回无工具请求（textFallback）', async () => {
  const toolFailure = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'tools unsupported', code: 'BAD_REQUEST' } } }];
  const ctx = makeCtx([toolFailure, textOnly]);
  const provider = createTitleProvider({ ctx, config, overrides: new Map() });
  const result = await provider.generate(request());
  assert.equal(result.title, '龙门场景重建与接缝');
  assert.equal(ctx.calls.length, 2);
  assert.ok(ctx.calls[0].tools !== undefined);
  assert.equal(ctx.calls[1].tools, undefined, '兜底请求不应再带工具');
});

await checkAsync('textFallback=false 时工具失败就是失败', async () => {
  const toolFailure = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'tools unsupported', code: 'BAD_REQUEST' } } }];
  const ctx = makeCtx([toolFailure]);
  const strict = readConfig({ textFallback: false });
  const provider = createTitleProvider({ ctx, config: strict, overrides: new Map() });
  await assert.rejects(() => provider.generate(request()));
  assert.equal(ctx.calls.length, 1);
});

await checkAsync('配置固定的 provider/model 覆盖会话路由', async () => {
  const ctx = makeCtx([reasoningThenToolCall]);
  const pinned = readConfig({ provider: 'other-provider', model: 'other-model' });
  const provider = createTitleProvider({ ctx, config: pinned, overrides: new Map() });
  const result = await provider.generate(request());
  assert.deepEqual(result.model, { provider: 'other-provider', model: 'other-model' });
});

await checkAsync('reachable 之外没有路由时明确报错', async () => {
  const ctx = makeCtx([reasoningThenToolCall]);
  const provider = createTitleProvider({ ctx, config, overrides: new Map() });
  await assert.rejects(() => provider.generate({ session, messages: [{ seq: h1Seq, text: 'x' }], signal: new AbortController().signal }), /没有模型路由/);
});

await checkAsync('取消信号立刻生效（不发起请求）', async () => {
  const ctx = makeCtx([reasoningThenToolCall]);
  const provider = createTitleProvider({ ctx, config, overrides: new Map() });
  const controller = new AbortController();
  controller.abort(new Error('superseded'));
  await assert.rejects(() => provider.generate(request({ signal: controller.signal })));
  assert.equal(ctx.calls.length, 0);
});

// -------------------------------------------------------------------- 纯函数
check('titleFromBlocks：只有 reasoning 时取不到标题', () => {
  assert.equal(titleFromBlocks([{ type: 'reasoning', text: '标题：不该用推理内容' }]), undefined);
});

check('titleFromBlocks：工具参数里的引号/前缀会被清洗', () => {
  const picked = titleFromBlocks([
    { type: 'tool-call', id: 'c', name: 'submit_session_title', arguments: '{"title":"“会话标题： 龙门 场景  重建。”"}' },
  ]);
  assert.equal(picked.title, '龙门 场景 重建');
  assert.equal(picked.via, 'tool-call');
});

check('titleFromBlocks：别的工具调用不算标题', () => {
  assert.equal(titleFromBlocks([{ type: 'tool-call', id: 'c', name: 'bash', arguments: '{"title":"x"}' }]), undefined);
});

check('readConfig：非法配置直接报错，缺省值可用', () => {
  assert.throws(() => readConfig({ provider: 'x' }), /成对/);
  assert.throws(() => readConfig({ cadence: 'sometimes' }), /cadence/);
  assert.throws(() => readConfig({ timeoutMs: 0 }), /正整数/);
  const defaults = readConfig({});
  assert.equal(defaults.cadence, 'all-prompts');
  assert.equal(defaults.textFallback, true);
  assert.equal(defaults.includeSystemPrompt, false);
});

// ------------------------------------------------- 压实（compaction）后的可见面
{
  const summarySession = Session.create(SessionId('session-summary'));
  const append2 = (type, data, opts) => summarySession.append(type, data, opts ?? { surfaceOp: 'append' });
  const append = append2;

  append('system/message', { turn: 1, step: 1, message: createSystemMessage('旧系统提示（被压实遮蔽）', 'test') });
  const hOld = createUserMessage({ content: [{ type: 'text', text: '旧的人类消息（被压实遮蔽）' }], source: { kind: 'user' } });
  const hOldEvent = append('user/message', hOld);
  const aOld = createAssistantMessage({ content: [{ type: 'text', text: '旧的助手回复' }], source: { provider: 'p', model: 'm' } });
  append('assistant/message', { turn: 1, step: 1, message: aOld, stream: [] });

  // 压缩摘要：把 0..2 整段遮蔽，只留摘要 + 注入行 + 新的人类消息。
  const summaryEvent = append(
    'user/message',
    {
      id: 'summary-msg',
      role: 'user',
      source: { kind: 'plugin', plugin: 'compact', compactionId: 'comp-1' },
      content: [{ type: 'text', text: '## 压缩摘要\n旧目标：把龙门场景从设计图重建出来；后来讨论接缝设计。' }],
    },
    { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] },
  );
  append(
    'user/message',
    {
      id: 'inj-instructions',
      role: 'user',
      source: { kind: 'agent-instructions', form: 'instructions', baseline: true },
      content: [{ type: 'text', text: 'AGENTS.md 内容噪音，不该进标题上下文'.repeat(50) }],
    },
  );
  append(
    'user/message',
    {
      id: 'inj-snapshot',
      role: 'user',
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [] },
      content: [{ type: 'text', text: '运行时快照噪音' }],
    },
  );
  const hNew = createUserMessage({ content: [{ type: 'text', text: '再补上接缝设计' }], source: { kind: 'user' } });
  const hNewEvent = append('user/message', hNew);

  const ctx2 = buildTitleContext(summarySession, {
    throughSeq: hNewEvent.seq,
    config,
    reservedBytes: 0,
  });
  check('压实后：可见面 = 摘要 + 新对话，注入行被丢弃', () => {
    const flat = JSON.stringify(ctx2.messages);
    assert.equal(ctx2.messages.length, 2, `期望 2 条，实际 ${ctx2.messages.length}`);
    assert.ok(flat.includes('压缩摘要'), '压缩摘要必须保留（它是会话的既有背景）');
    assert.equal(flat.includes('AGENTS.md 内容噪音'), false, 'form=instructions 注入行应被丢弃');
    assert.equal(flat.includes('运行时快照噪音'), false, 'form=snapshot 注入行应被丢弃');
    assert.equal(ctx2.stats.injectedDropped, 2);
    assert.equal(ctx2.stats.wholeSurface, false, '上界仍在可见面内时不应走全量兜底');
    assert.equal(ctx2.seqs.length, 1, '摘要不是 human 消息，不计入 messageSeqs');
    assert.deepEqual(ctx2.seqs, [hNewEvent.seq]);
  });

  const shadowed = buildTitleContext(summarySession, {
    throughSeq: hOldEvent.seq,
    config,
    reservedBytes: 0,
  });
  check('上界被压实遮蔽时：退回当前可见面全量', () => {
    assert.equal(shadowed.stats.wholeSurface, true, '应触发全量可见面兜底');
    assert.equal(shadowed.messages.length, 2);
    assert.ok(JSON.stringify(shadowed.messages).includes('压缩摘要'));
    assert.deepEqual(shadowed.seqs, [hNewEvent.seq]);
  });

  await checkAsync('遮蔽上界且面内无 human：messageSeqs 退回修订覆盖的 human seqs', async () => {
    const ctxStub = makeCtx([reasoningThenToolCall]);
    const provider = createTitleProvider({ ctx: ctxStub, config, overrides: new Map() });
    const result = await provider.generate({
      session: summarySession,
      messages: [{ seq: hOldEvent.seq, text: '旧的人类消息（被压实遮蔽）' }],
      route: { provider: 'session-provider', model: 'session-model' },
      signal: new AbortController().signal,
    });
    assert.equal(result.title, '龙门场景重建与接缝');
    assert.deepEqual(result.messageSeqs, [hOldEvent.seq], 'messageSeqs 必须取自 request.messages');
  });

  await checkAsync('includeInjectedContext=true 时注入行保留', async () => {
    const wide = buildTitleContext(summarySession, {
      throughSeq: hNewEvent.seq,
      config: readConfig({ includeInjectedContext: true }),
      reservedBytes: 0,
    });
    const flat = JSON.stringify(wide.messages);
    assert.ok(flat.includes('AGENTS.md 内容噪音'), '显式打开时应保留注入行');
    assert.ok(flat.includes('运行时快照噪音'));
    assert.equal(wide.stats.injectedDropped, 0);
  });
}

process.stdout.write(`\nSELFTEST PASS (${passed} checks)\n`);
