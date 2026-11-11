/**
 * WebSocket 帧编解码与连接管理自测（纯协议层，不起真实 socket）。
 *
 * 运行：node --test test/ws-test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  CLOSE_CODE,
  FrameParser,
  MAX_FRAME_BYTES,
  OPCODE,
  WsConnection,
  computeAcceptKey,
  encodeFrame,
  unmask,
} from '../lib/ws.js?v=1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 假 socket：把「客户端→服务端」和「服务端→客户端」两条方向分开。
 *
 * 直接用 PassThrough 会把它自己 write 出去的数据当成入站数据读回来
 * （自环），心跳永远「有响应」。所以这里显式分两个方向。
 */
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    /** 客户端写入这里，服务端从 'data' 事件读到 */
    this.inbound = new PassThrough();
    /** 服务端 write 的所有字节 */
    this.written = [];
    this.destroyed = false;
    this.writableLength = 0;
    this.remoteAddress = '127.0.0.1';
  }

  on(event, listener) {
    super.on(event, listener);
    // 只有 'data' 需要桥接到 inbound；其余事件由测试手动触发
    if (event === 'data') this.inbound.on('data', listener);
    return this;
  }

  removeAllListeners(event) {
    if (event === 'data') this.inbound.removeAllListeners('data');
    return super.removeAllListeners(event);
  }

  write(chunk) {
    this.written.push(Buffer.from(chunk));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }

  /** 测试辅助：模拟客户端发来的字节。 */
  clientSend(buffer) {
    this.inbound.write(buffer);
  }

  /** 测试辅助：服务端发出的全部字节拼起来。 */
  get outbound() {
    return Buffer.concat(this.written);
  }
}

/** 构造一个带掩码的客户端帧。 */
function clientFrame(opcode, payload, fin = true) {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.from(payload);
  unmask(masked, mask);
  return Buffer.concat([
    Buffer.from([(fin ? 0x80 : 0x00) | opcode, 0x80 | masked.length]),
    mask,
    masked,
  ]);
}

/** 把服务端写出的字节解析成帧数组（只用于断言）。 */
function parseOutbound(socket) {
  return new FrameParser({ maxFrameBytes: 8 * 1024 * 1024 }).push(socket.outbound);
}

/** 服务端写出的最后一帧。 */
function lastFrame(socket) {
  const frames = parseOutbound(socket);
  assert.ok(frames.length > 0, '服务端没有写出任何帧');
  return frames[frames.length - 1];
}

test('握手 accept key 与 RFC 6455 示例一致', () => {
  // RFC 6455 §1.3 给出的官方示例
  assert.equal(computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodeFrame 小负载用 2 字节头', () => {
  const frame = encodeFrame(OPCODE.TEXT, 'hi');
  assert.equal(frame.length, 4);
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], 2);
  assert.equal(frame.toString('utf8', 2), 'hi');
});

test('encodeFrame 中等负载用 16 位扩展长度', () => {
  const payload = 'x'.repeat(200);
  const frame = encodeFrame(OPCODE.TEXT, payload);
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], 126);
  assert.equal(frame.readUInt16BE(2), 200);
  assert.equal(frame.length, 4 + 200);
});

test('encodeFrame 大负载用 64 位扩展长度', () => {
  const payload = Buffer.alloc(70000, 0x61);
  const frame = encodeFrame(OPCODE.TEXT, payload);
  assert.equal(frame[1], 127);
  assert.equal(frame.readBigUInt64BE(2), 70000n);
  assert.equal(frame.length, 10 + 70000);
});

test('unmask 按 4 字节循环异或', () => {
  const payload = Buffer.from('hello');
  const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  unmask(payload, mask);
  // 逆运算必须还原
  unmask(payload, mask);
  assert.equal(payload.toString('utf8'), 'hello');
});

test('FrameParser 解析带掩码的单帧', () => {
  const parser = new FrameParser();
  const payload = Buffer.from('你好');
  const mask = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const masked = Buffer.from(payload);
  unmask(masked, mask);
  const frame = Buffer.concat([
    Buffer.from([0x81, 0x80 | masked.length]),
    mask,
    masked,
  ]);
  const [out] = parser.push(frame);
  assert.equal(out.opcode, OPCODE.TEXT);
  assert.equal(out.fin, true);
  assert.equal(out.payload.toString('utf8'), '你好');
  assert.equal(parser.buffered, 0);
});

test('FrameParser 处理跨 TCP 边界的半帧', () => {
  const parser = new FrameParser();
  const payload = Buffer.from('split-across-chunks');
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  unmask(masked, mask);
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | masked.length]), mask, masked]);
  assert.deepEqual(parser.push(frame.subarray(0, 5)), []);
  assert.deepEqual(parser.push(frame.subarray(5, 9)), []);
  const out = parser.push(frame.subarray(9));
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.toString('utf8'), 'split-across-chunks');
});

test('FrameParser 重组分片消息', () => {
  const parser = new FrameParser();
  const mask = Buffer.from([9, 9, 9, 9]);
  const part = (text, opcode, fin) => {
    const payload = Buffer.from(text);
    const masked = Buffer.from(payload);
    unmask(masked, mask);
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0x00) | opcode, 0x80 | masked.length]), mask, masked]);
  };
  parser.push(part('Hello ', OPCODE.TEXT, false));
  parser.push(part(' fragmented ', OPCODE.CONTINUATION, false));
  const out = parser.push(part('world', OPCODE.CONTINUATION, true));
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.toString('utf8'), 'Hello  fragmented world');
});

test('FrameParser 拒绝超大帧', () => {
  const parser = new FrameParser({ maxFrameBytes: 16 });
  const header = Buffer.from([0x81, 127, 0, 0, 0, 0, 0, 0, 0, 64]); // 64 字节 > 16
  assert.throws(() => parser.push(header), (error) => error.code === CLOSE_CODE.TOO_LARGE);
});

test('FrameParser 拒绝 RSV 位非零与控制帧分片', () => {
  const rsv = new FrameParser();
  assert.throws(() => rsv.push(Buffer.from([0xC1, 0x00])), (error) => error.code === CLOSE_CODE.PROTOCOL);

  const fragmentedControl = new FrameParser();
  assert.throws(
    () => fragmentedControl.push(Buffer.from([0x09, 0x80 | 1, 1, 2, 3, 4, 65])),
    (error) => error.code === CLOSE_CODE.PROTOCOL,
  );
});

test('FrameParser 拒绝没有起始帧的 continuation', () => {
  const parser = new FrameParser();
  assert.throws(() => parser.push(Buffer.from([0x80, 0x00])), (error) => error.code === CLOSE_CODE.PROTOCOL);
});

test('WsConnection：msgSeq / ack 水位线 / ping-pong', async () => {
  const socket = new FakeSocket();
  /** @type {string[]} */
  const received = [];
  const connection = new WsConnection(socket, { heartbeatMs: 10_000 });
  connection.onMessage = (text) => received.push(text);

  // 控制消息不计背压
  connection.sendJson({ type: 'hello' });
  assert.equal(connection.pending, 0);

  // 被跟踪的消息带 msgSeq，并且计入背压
  assert.equal(connection.sendTracked({ type: 'session/event', seq: 0 }), 1);
  assert.equal(connection.sendTracked({ type: 'session/event', seq: 1 }), 2);
  assert.equal(connection.pending, 2);
  assert.equal(connection.lastSeq, 2);

  const frames = parseOutbound(socket);
  assert.equal(frames.length, 3);
  const tracked = JSON.parse(frames[1].payload.toString('utf8'));
  assert.equal(tracked.msgSeq, 1);
  assert.equal(tracked.type, 'session/event');

  // ack 是水位线：确认到 1 → 还剩 1 条未确认
  connection.ack(1);
  assert.equal(connection.pending, 1);
  // 确认全部
  connection.ack(2);
  assert.equal(connection.pending, 0);
  // 未来的序号不作数
  connection.ack(999);
  assert.equal(connection.pending, 0);

  // 客户端 ping → 服务端必须回 pong
  socket.clientSend(clientFrame(OPCODE.PING, 'ping-body'));
  await sleep(30);
  assert.ok(received.length >= 0);
  const pong = lastFrame(socket);
  assert.equal(pong.opcode, OPCODE.PONG);
  assert.equal(pong.payload.toString('utf8'), 'ping-body');
});

test('WsConnection：客户端文本消息进入 onMessage', async () => {
  const socket = new FakeSocket();
  /** @type {string[]} */
  const received = [];
  const connection = new WsConnection(socket, { heartbeatMs: 10_000 });
  connection.onMessage = (text) => received.push(text);
  socket.clientSend(clientFrame(OPCODE.TEXT, '{"type":"subscribe"}'));
  await sleep(20);
  assert.deepEqual(received, ['{"type":"subscribe"}']);
  connection.dispose();
});

test('WsConnection：未确认积压超限即断开', () => {
  const socket = new FakeSocket();
  let closedWith;
  const connection = new WsConnection(socket, {
    heartbeatMs: 10_000,
    maxBacklog: 3,
    onClose: (c) => { closedWith = c; },
  });
  connection.sendTracked({ n: 1 });
  connection.sendTracked({ n: 2 });
  connection.sendTracked({ n: 3 });
  assert.equal(connection.pending, 3);
  assert.equal(connection.sendTracked({ n: 4 }), null);
  assert.equal(connection.isClosed, true);
  assert.equal(closedWith, connection);
  const close = lastFrame(socket);
  assert.equal(close.opcode, OPCODE.CLOSE);
  assert.equal(close.payload.readUInt16BE(0), CLOSE_CODE.TRY_AGAIN);
});

test('WsConnection：心跳超时会话被关闭', async () => {
  const socket = new FakeSocket();
  let closedWith;
  const connection = new WsConnection(socket, {
    heartbeatMs: 20,
    onClose: (c) => { closedWith = c; },
  });
  connection.startHeartbeat();
  // 客户端从不响应：3 个周期后应被判定死亡
  await sleep(140);
  assert.equal(connection.isClosed, true);
  assert.equal(closedWith, connection);
  const close = lastFrame(socket);
  assert.equal(close.opcode, OPCODE.CLOSE);
  assert.equal(close.payload.readUInt16BE(0), CLOSE_CODE.GOING_AWAY);
});

test('WsConnection：客户端持续回 pong 可以续命', async () => {
  const socket = new FakeSocket();
  const connection = new WsConnection(socket, { heartbeatMs: 30 });
  connection.startHeartbeat();
  // 阈值 = 30 * 3 = 90ms；每 40ms 回一次 pong，永远走在超时前面
  for (let i = 0; i < 6; i += 1) {
    await sleep(40);
    if (connection.isClosed) break;
    socket.clientSend(Buffer.from([0x8a, 0x80, 1, 2, 3, 4])); // 空 payload 的 pong
  }
  assert.equal(connection.isClosed, false);
  assert.equal(connection.everResponded, true);
  connection.dispose();
});

test('WsConnection：客户端 close 帧触发清理', async () => {
  const socket = new FakeSocket();
  let closedWith;
  const connection = new WsConnection(socket, { heartbeatMs: 10_000, onClose: (c) => { closedWith = c; } });
  socket.clientSend(Buffer.from([0x88, 0x80, 1, 2, 3, 4, 0x03, 0xe8]));
  await sleep(20);
  assert.equal(connection.isClosed, true);
  assert.equal(closedWith, connection);
});

test('WsConnection：协议错误以对应关闭码断开', async () => {
  const socket = new FakeSocket();
  const connection = new WsConnection(socket, { heartbeatMs: 10_000 });
  socket.clientSend(Buffer.from([0xC1, 0x00])); // RSV 位非零
  await sleep(20);
  assert.equal(connection.isClosed, true);
  const close = lastFrame(socket);
  assert.equal(close.payload.readUInt16BE(0), CLOSE_CODE.PROTOCOL);
});

test('WsConnection：dispose 幂等且清理定时器', async () => {
  const socket = new FakeSocket();
  let closeCalls = 0;
  const connection = new WsConnection(socket, {
    heartbeatMs: 10_000,
    onClose: () => { closeCalls += 1; },
  });
  const stop = connection.startHeartbeat();
  stop();
  stop();
  connection.dispose();
  connection.dispose();
  assert.equal(closeCalls, 1);
  assert.equal(connection.timer, undefined);
});

test('WsConnection：close() 带 reason 时关闭码与 reason 都在', () => {
  const socket = new FakeSocket();
  const connection = new WsConnection(socket, { heartbeatMs: 10_000 });
  connection.close(CLOSE_CODE.GOING_AWAY, 'heartbeat timed out');
  const close = lastFrame(socket);
  assert.equal(close.opcode, OPCODE.CLOSE);
  assert.equal(close.payload.length, 2 + 'heartbeat timed out'.length);
  assert.equal(close.payload.readUInt16BE(0), CLOSE_CODE.GOING_AWAY);
  assert.equal(close.payload.toString('utf8', 2), 'heartbeat timed out');
});

test('WsConnection：close() 空 reason 仍带 2 字节关闭码', () => {
  const socket = new FakeSocket();
  const connection = new WsConnection(socket, { heartbeatMs: 10_000 });
  // 以前 reason 为空时 body 是 0 长度 Buffer，writeUInt16BE 越界抛错被 catch 吞掉，
  // 整个 close 帧都发不出去 —— 关闭码彻底丢失。现在必须总是 2 字节码。
  connection.close(CLOSE_CODE.NORMAL, '');
  const close = lastFrame(socket);
  assert.equal(close.opcode, OPCODE.CLOSE);
  assert.equal(close.payload.length, 2);
  assert.equal(close.payload.readUInt16BE(0), CLOSE_CODE.NORMAL);
  assert.equal(connection.isClosed, true);
  assert.equal(socket.destroyed, true);
});

test('WsConnection：close() 之后 socket 一定被销毁', () => {
  const socket = new FakeSocket();
  const connection = new WsConnection(socket, { heartbeatMs: 10_000 });
  connection.close(CLOSE_CODE.GOING_AWAY, 'bye');
  // 以前 close() 先置 closed 再调 dispose()，而 dispose() 只在 !closed 时 destroy，
  // 于是主动关闭之后 socket 永远不销毁，上层 stop() 只能干等 2000ms 兜底。
  assert.equal(socket.destroyed, true);
  assert.equal(connection.isClosed, true);
  // 重复 close / dispose 都安全
  connection.close();
  connection.dispose();
  assert.equal(socket.destroyed, true);
});

test('WsConnection：socket error 事件也会销毁 socket', () => {
  const socket = new FakeSocket();
  const connection = new WsConnection(socket, { heartbeatMs: 10_000 });
  socket.emit('error', new Error('ECONNRESET'));
  assert.equal(socket.destroyed, true);
  assert.equal(connection.isClosed, true);
});

test('MAX_FRAME_BYTES 是 1 MiB', () => {
  assert.equal(MAX_FRAME_BYTES, 1024 * 1024);
});
