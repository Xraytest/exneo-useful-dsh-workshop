/**
 * DSH 服务适配层自测：用假 ctx 驱动，验证 session 映射、事件分页、
 * 发送 / 中断的身份解析与失败关闭语义。
 *
 * 运行：node --test test/sessions-test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentsService,
  createSession,
  describeSession,
  interruptSession,
  listSessions,
  listTools,
  readEvents,
  readMessages,
  resolveSenderAgent,
  sendMessage,
  sessionsService,
  subagentsService,
} from '../lib/sessions.js?v=1';

/**
 * 造一个假 Session。
 * @param {string} id
 * @param {Record<string, unknown>} [header]
 * @param {Array<Record<string, unknown>>} [events]
 */
function fakeSession(id, header = {}, events = []) {
  const log = events.map((event, index) => ({ ...event, seq: event.seq ?? index, time: event.time ?? 1000 + index }));
  return {
    id,
    header: { version: 4, id, createdAt: 1700000000000, isSeeded: false, ...header },
    seq: log.length,
    inheritedEventCount: 0,
    log,
    snapshotEvents(from = 0, to = this.seq) {
      return Object.freeze(this.log.slice(from, to));
    },
    deriveMessages() {
      return this.log
        .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
        .map((event) => ({ id: `m-${event.seq}`, role: event.type === 'user/message' ? 'user' : 'assistant', content: [] }));
    },
  };
}

/**
 * 造一个假 ctx。
 * @param {{ sessions?: any[], agents?: any[] }} [input]
 */
function fakeCtx(input = {}) {
  const sessions = new Map((input.sessions ?? []).map((session) => [session.id, session]));
  const agents = new Map((input.agents ?? []).map((agent) => [agent.id, agent]));
  /** @type {Array<Record<string, unknown>>} */
  const sent = [];
  /** @type {Array<Record<string, unknown>>} */
  const interrupted = [];
  const titles = new Map();
  const store = {
    get: (key) => {
      if (key === 'sessions') return {
        list: () => [...sessions.values()],
        get: (id) => sessions.get(id),
        create: (id, options) => {
          const newId = id ?? `session-${sessions.size + 1}`;
          const session = fakeSession(newId, options?.meta ?? {});
          sessions.set(newId, session);
          return session;
        },
      };
      if (key === 'agents') return {
        list: () => [...agents.values()],
        get: (id) => agents.get(id),
        roots: () => [...agents.values()].filter((agent) => agent.root === true),
      };
      if (key === 'subagents') return {
        sendMessage: async (sender, targetId, content) => {
          if (agents.get(sender.id) !== sender) throw new Error('message delivery requires the exact live sender agent');
          if (!sessions.has(targetId)) throw new Error(`unknown target ${targetId}`);
          sent.push({ sender: sender.id, targetId, content });
          return `msg-${sent.length}`;
        },
        interrupt: (targetId, authority) => {
          interrupted.push({ targetId, authority });
        },
      };
      if (key === 'sessionTitle') return {
        get: (session) => (titles.has(session.id) ? { title: titles.get(session.id) } : undefined),
        rename: (session, title) => { titles.set(session.id, title); },
      };
      return undefined;
    },
  };
  return { ctx: store, sessions, agents, sent, interrupted, titles };
}

test('listSessions 对非法 limit 不限制而非退化成 1 条', () => {
  const { ctx } = fakeCtx({
    sessions: [fakeSession('a'), fakeSession('b'), fakeSession('c')],
  });
  // ?limit= 为空 → Number('') === 0，不应把结果压成 1 条
  assert.equal(listSessions(ctx, { limit: 0 }).sessions.length, 3);
  assert.equal(listSessions(ctx, { limit: Number.NaN }).sessions.length, 3);
  assert.equal(listSessions(ctx, {}).sessions.length, 3);
  assert.equal(listSessions(ctx, { limit: 2 }).sessions.length, 2);
});

test('describeSession 输出纯 JSON 摘要', () => {
  const session = fakeSession('s1', { cwd: 'D:\\WorkSpace', parentSession: 'root', agentPreset: 'default', origin: 'subagent', delegationDepth: 1 });
  const summary = describeSession(session, undefined);
  assert.equal(summary.id, 's1');
  assert.equal(summary.cwd, 'D:\\WorkSpace');
  assert.equal(summary.parentSession, 'root');
  assert.equal(summary.agentPreset, 'default');
  assert.equal(summary.origin, 'subagent');
  assert.equal(summary.delegationDepth, 1);
  assert.equal(summary.formatVersion, 4);
  assert.equal(summary.title, '');
});

test('describeSession 读取标题服务', () => {
  const session = fakeSession('s1');
  const titleService = { get: () => ({ title: '我的会话' }) };
  assert.equal(describeSession(session, titleService).title, '我的会话');
});

test('listSessions 按 id 排序并受 limit 限制', () => {
  const { ctx } = fakeCtx({
    sessions: [fakeSession('b'), fakeSession('a'), fakeSession('c')],
  });
  const all = listSessions(ctx, {});
  assert.deepEqual(all.sessions.map((s) => s.id), ['a', 'b', 'c']);
  assert.equal(all.total, 3);
  assert.equal(all.truncated, false);

  const limited = listSessions(ctx, { limit: 2 });
  assert.deepEqual(limited.sessions.map((s) => s.id), ['a', 'b']);
  assert.equal(limited.truncated, true);
});

test('readEvents 分页与 since 语义', () => {
  const { ctx } = fakeCtx({
    sessions: [fakeSession('s1', {}, [
      { type: 'user/message', data: {} },
      { type: 'tool/call', data: {} },
      { type: 'tool/result', data: {} },
      { type: 'assistant/message', data: {} },
    ])],
  });
  const first = readEvents(ctx, 's1', { since: 0, limit: 2 });
  assert.equal(first.fromSeq, 0);
  assert.equal(first.toSeqExclusive, 2);
  assert.equal(first.nextSeq, 2);
  assert.equal(first.events.length, 2);
  assert.equal(first.total, 4);

  const rest = readEvents(ctx, 's1', { since: 2, limit: 100 });
  assert.equal(rest.events.length, 2);
  assert.equal(rest.nextSeq, 4);

  const beyond = readEvents(ctx, 's1', { since: 99 });
  assert.deepEqual(beyond.events, []);
  assert.equal(beyond.nextSeq, 4);
});

test('readEvents 对不存在的会话返回 404 错误', () => {
  const { ctx } = fakeCtx({ sessions: [] });
  assert.throws(() => readEvents(ctx, 'nope'), (error) => error.status === 404);
});

test('readEvents 把超大事件降级为截断标记', () => {
  const huge = 'x'.repeat(300 * 1024);
  const { ctx } = fakeCtx({ sessions: [fakeSession('s1', {}, [{ type: 'user/message', data: { text: huge } }])] });
  const page = readEvents(ctx, 's1', { since: 0, limit: 10 });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].truncated, true);
  assert.ok(page.events[0].originalBytes > 256 * 1024);
});

test('readMessages 只取派生消息且默认取尾部', () => {
  const { ctx } = fakeCtx({
    sessions: [fakeSession('s1', {}, [
      { type: 'user/message', data: {} },
      { type: 'tool/call', data: {} },
      { type: 'assistant/message', data: {} },
    ])],
  });
  const page = readMessages(ctx, 's1', { limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].role, 'assistant');
});

test('resolveSenderAgent 优先目标会话的父 Agent', () => {
  const parent = { id: 'parent-session', root: false };
  const root = { id: 'root-session', root: true };
  const { ctx } = fakeCtx({
    sessions: [fakeSession('child', { parentSession: 'parent-session' })],
    agents: [parent, root],
  });
  assert.equal(resolveSenderAgent(ctx, 'child').id, 'parent-session');
});

test('resolveSenderAgent 在没有父 Agent 时退回 root', () => {
  const root = { id: 'root-session', root: true };
  const other = { id: 'other', root: false };
  const { ctx } = fakeCtx({
    sessions: [fakeSession('orphan')],
    agents: [other, root],
  });
  assert.equal(resolveSenderAgent(ctx, 'orphan').id, 'root-session');
});

test('resolveSenderAgent 没有任何 Agent 时报 503', () => {
  const { ctx } = fakeCtx({ sessions: [fakeSession('s1')], agents: [] });
  assert.throws(() => resolveSenderAgent(ctx, 's1'), (error) => error.status === 503);
});

test('sendMessage 走 subagents.sendMessage 并带回执', async () => {
  const root = { id: 'root-session', root: true };
  const { ctx, sent } = fakeCtx({
    sessions: [fakeSession('root-session'), fakeSession('child', { parentSession: 'root-session' })],
    agents: [root],
  });
  const result = await sendMessage(ctx, 'child', '你好');
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'child');
  assert.equal(result.senderAgentId, 'root-session');
  assert.equal(result.messageId, 'msg-1');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].content, [{ type: 'text', text: '你好' }]);
});

test('sendMessage 对不存在的会话返回 404', async () => {
  const { ctx } = fakeCtx({ sessions: [fakeSession('root-session')], agents: [{ id: 'root-session', root: true }] });
  await assert.rejects(() => sendMessage(ctx, 'nope'), (error) => error.status === 404);
});

test('interruptSession 以 user 权限中断并带上父会话', () => {
  const { ctx, interrupted } = fakeCtx({
    sessions: [fakeSession('child', { parentSession: 'root-session' })],
  });
  const result = interruptSession(ctx, 'child');
  assert.equal(result.interrupted, true);
  assert.equal(interrupted.length, 1);
  assert.deepEqual(interrupted[0], {
    targetId: 'child',
    authority: { kind: 'user', parentSessionId: 'root-session' },
  });
});

test('interruptSession 对无父会话的目标改用 ancestor 权限', () => {
  // 根会话没有 parentSession：契约要求 {kind:'user'} 必须带 parentSessionId，
  // 缺了 Host 无法授权。必须退回 {kind:'ancestor', agent}。
  const root = { id: 'root-session', root: true };
  const { ctx, interrupted } = fakeCtx({
    sessions: [fakeSession('root-session')],
    agents: [root],
  });
  const result = interruptSession(ctx, 'root-session');
  assert.equal(result.interrupted, true);
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].targetId, 'root-session');
  const authority = interrupted[0].authority;
  assert.equal(authority.kind, 'ancestor');
  assert.equal(authority.agent, root);
  // 绝不能发出缺少 parentSessionId 的 user 权限
  assert.notEqual(authority.kind, 'user');
  assert.equal(authority.parentSessionId, undefined);
});

test('interruptSession 无父会话且无 root Agent 时退回任意在线 Agent', () => {
  const only = { id: 'not-a-root', root: false };
  const { ctx, interrupted } = fakeCtx({
    sessions: [fakeSession('orphan')],
    agents: [only],
  });
  interruptSession(ctx, 'orphan');
  assert.equal(interrupted[0].authority.kind, 'ancestor');
  assert.equal(interrupted[0].authority.agent, only);
});

test('interruptSession 无父会话且没有任何在线 Agent 时报 503', () => {
  const { ctx } = fakeCtx({ sessions: [fakeSession('orphan')], agents: [] });
  assert.throws(() => interruptSession(ctx, 'orphan'), (error) => error.status === 503);
});

test('interruptSession 对空字符串 parentSession 也走 ancestor 分支', () => {
  const root = { id: 'root-session', root: true };
  const { ctx, interrupted } = fakeCtx({
    sessions: [fakeSession('weird', { parentSession: '' })],
    agents: [root],
  });
  interruptSession(ctx, 'weird');
  assert.equal(interrupted[0].authority.kind, 'ancestor');
});

test('服务缺失时报 503 而不是无 status 的 500', () => {
  const ctx = { get: () => undefined };
  // service() 抛的错必须带 status=503，否则 http 层会按 500 处理
  assert.throws(() => sessionsService(ctx), (error) => error.status === 503);
  assert.throws(() => agentsService(ctx), (error) => error.status === 503);
  assert.throws(() => subagentsService(ctx), (error) => error.status === 503);
  assert.throws(() => listSessions(ctx), (error) => error.status === 503);
  assert.throws(() => listTools(ctx), (error) => error.status === 503);
});

test('createSession 派生新会话、设置标题并投递 goal', async () => {
  const root = { id: 'root-session', root: true };
  const { ctx, sessions, sent, titles } = fakeCtx({
    sessions: [fakeSession('root-session')],
    agents: [root],
  });
  const result = await createSession(ctx, { title: '新会话', branch: 'root-session', goal: '开始吧', model: 'deepseek-v3' });
  assert.equal(result.created, true);
  assert.equal(result.title, '新会话');
  assert.equal(result.parentSession, 'root-session');
  assert.equal(titles.get(result.id), '新会话');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].content, [{ type: 'text', text: '开始吧' }]);
  // model 无法在创建时设置，必须显式告警而不是静默丢弃
  assert.ok(result.warnings.some((warning) => warning.includes('model')));
  assert.ok(sessions.has(result.id));
});

test('createSession 的 branch 不存在时报 400', async () => {
  const { ctx } = fakeCtx({ sessions: [] });
  await assert.rejects(() => createSession(ctx, { branch: 'ghost' }), (error) => error.status === 400);
});

test('createSession 在 sessions 服务没有 create() 时报 501', async () => {
  const ctx = {
    get: (key) => {
      if (key === 'sessions') return { list: () => [], get: () => undefined };
      return undefined;
    },
  };
  await assert.rejects(() => createSession(ctx, {}), (error) => error.status === 501);
});

test('createSession 对过长 title/goal 报 400', async () => {
  const { ctx } = fakeCtx({ sessions: [] });
  await assert.rejects(() => createSession(ctx, { title: 'x'.repeat(201) }), (error) => error.status === 400);
  await assert.rejects(() => createSession(ctx, { goal: 'x'.repeat(20001) }), (error) => error.status === 400);
});
