/**
 * 最小 WebSocket（RFC 6455）实现：不依赖任何第三方库。
 *
 * 只实现本桥接需要的那一部分：
 *   · 帧**解析**（客户端→服务端，带掩码；支持分片与 64 位扩展长度）；
 *   · 帧**构造**（服务端→客户端，不带掩码；text / close / ping / pong）；
 *   · 握手 accept key（SHA-1 + base64）；
 *   · 连接管理：心跳、背压计数、优雅关闭。
 *
 * 明确不做：permessage-deflate、扩展协商、二进制消息语义、子协议。
 *
 * @module prts-omni-bridge/lib/ws
 */

import { createHash } from 'node:crypto';

/** RFC 6455 握手用的 GUID。 */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 操作码。 */
export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

/** 单帧payload 上限：1 MiB。超过就按协议错误关闭，防止内存被打爆。 */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** 关闭码。 */
export const CLOSE_CODE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL: 1002,
  TOO_LARGE: 1009,
  INTERNAL: 1011,
  TRY_AGAIN: 1013,
};

/**
 * 计算握手的 `Sec-WebSocket-Accept`。
 * @param {string} clientKey
 * @returns {string}
 */
export function computeAcceptKey(clientKey) {
  return createHash('sha1').update(`${clientKey}${WS_GUID}`, 'utf8').digest('base64');
}

/**
 * 构造一个服务端→客户端帧（不掩码）。
 * @param {number} opcode
 * @param {Buffer | string} payload
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, data]);
}

/**
 * 按 RFC 6455 解除掩码（就地修改并返回同一缓冲区）。
 * @param {Buffer} payload
 * @param {Buffer} mask 4 字节
 * @returns {Buffer}
 */
export function unmask(payload, mask) {
  for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
  return payload;
}

/**
 * 增量帧解析器：把任意切分的 TCP 块喂进来，吐出完整的消息/控制帧。
 *
 * 设计成纯函数式状态机，方便单测：`push(chunk)` 返回本次从 chunk 中
 * 完整解出的帧数组，剩余不完整的字节留在内部缓冲里等下一次 push。
 */
export class FrameParser {
  /** @param {{ maxFrameBytes?: number }} [options] */
  constructor(options = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
    /** 分片中的消息操作码（首个非控制帧的 opcode）。 */
    this.fragmentOpcode = 0;
    /** @type {Buffer[]} */
    this.fragments = [];
    this.fragmentLength = 0;
  }

  /** 内部缓冲里待处理的字节数（测试与背压诊断用）。 */
  get buffered() {
    return this.buffer.length;
  }

  /**
   * 喂入一段字节。
   * @param {Buffer} chunk
   * @returns {Array<{ opcode: number, payload: Buffer, fin: boolean }>}
   * @throws {Error} 协议错误（错误对象带 `code` 关闭码）
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    /** @type {Array<{ opcode: number, payload: Buffer, fin: boolean }>} */
    const frames = [];
    for (;;) {
      const frame = this.#readFrame();
      if (frame === undefined) break;
      frames.push(frame);
    }
    return frames;
  }

  /**
   * 尝试从内部缓冲解析一帧。
   * @returns {{ opcode: number, payload: Buffer, fin: boolean } | undefined}
   */
  #readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return undefined;
    const first = buf[0];
    const second = buf[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < offset + 2) return undefined;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return undefined;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw protocolError(CLOSE_CODE.TOO_LARGE, 'frame length is not a safe integer');
      length = Number(big);
      offset += 8;
    }
    if (length > this.maxFrameBytes) throw protocolError(CLOSE_CODE.TOO_LARGE, `frame exceeds ${this.maxFrameBytes} bytes`);

    const maskLength = masked ? 4 : 0;
    if (buf.length < offset + maskLength + length) return undefined;

    let payload = buf.subarray(offset + maskLength, offset + maskLength + length);
    if (masked) unmask(payload, buf.subarray(offset, offset + 4));
    // subarray 是视图，拷贝一份，避免调用方持有内部缓冲
    payload = Buffer.from(payload);
    this.buffer = buf.subarray(offset + maskLength + length);

    // RSV 位必须为 0（我们不协商任何扩展）
    if ((first & 0x70) !== 0) throw protocolError(CLOSE_CODE.PROTOCOL, 'reserved bits must be clear');
    // 控制帧不允许分片，且 payload 不得超过 125
    if (opcode >= 0x8) {
      if (!fin) throw protocolError(CLOSE_CODE.PROTOCOL, 'control frames must not be fragmented');
      if (length > 125) throw protocolError(CLOSE_CODE.PROTOCOL, 'control frame payload exceeds 125 bytes');
      return { opcode, payload, fin };
    }
    if (opcode !== OPCODE.CONTINUATION && opcode !== OPCODE.TEXT && opcode !== OPCODE.BINARY) {
      throw protocolError(CLOSE_CODE.PROTOCOL, `unknown opcode ${opcode}`);
    }
    if (opcode === OPCODE.CONTINUATION) {
      if (this.fragmentOpcode === 0) throw protocolError(CLOSE_CODE.PROTOCOL, 'continuation without a start frame');
    } else if (this.fragmentOpcode !== 0) {
      throw protocolError(CLOSE_CODE.PROTOCOL, 'new data frame while a fragmented message is open');
    } else {
      this.fragmentOpcode = opcode;
    }

    this.fragments.push(payload);
    this.fragmentLength += payload.length;
    if (this.fragmentLength > this.maxFrameBytes) throw protocolError(CLOSE_CODE.TOO_LARGE, `message exceeds ${this.maxFrameBytes} bytes`);
    if (!fin) return undefined;

    const message = Buffer.concat(this.fragments, this.fragmentLength);
    const messageOpcode = this.fragmentOpcode;
    this.fragments = [];
    this.fragmentLength = 0;
    this.fragmentOpcode = 0;
    return { opcode: messageOpcode, payload: message, fin: true };
  }
}

/**
 * 构造一个带 `code` 的协议错误。
 * @param {number} code
 * @param {string} message
 * @returns {Error & { code: number }}
 */
function protocolError(code, message) {
  return Object.assign(new Error(message), { code, wsProtocol: true });
}

/** 未确认消息上限：超过就断开，防止慢客户端把 Host 内存吃光。 */
export const MAX_BACKLOG = 1000;

/** 心跳间隔（毫秒）。 */
export const HEARTBEAT_MS = 2000;

/** 连续多少个心跳周期没有 pong 就判定连接已死。 */
export const HEARTBEAT_MISSES = 3;

/**
 * 一条已 Accepted 的 WebSocket 连接。
 *
 * 生命周期由调用方用 {@link WsConnection.close} 或 socket 的 `close` 事件结束；
 * 所有定时器都在 {@link WsConnection.dispose} 里清掉，可重复调用（幂等）。
 */
export class WsConnection {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{
   *   heartbeatMs?: number,
   *   maxBacklog?: number,
   *   maxFrameBytes?: number,
   *   onMessage?: (text: string, connection: WsConnection) => void,
   *   onClose?: (connection: WsConnection) => void,
   * }} [options]
   */
  constructor(socket, options = {}) {
    this.socket = socket;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.maxBacklog = options.maxBacklog ?? MAX_BACKLOG;
    this.onMessage = options.onMessage;
    this.onClose = options.onClose;

    /** @type {FrameParser} */
    this.parser = new FrameParser({ maxFrameBytes: options.maxFrameBytes });
    /** 已发送但未被客户端 ack 的消息数。 */
    this.pending = 0;
    /** 已推送消息的最高序号（ack 用）。 */
    this.lastSeq = 0;
    /** 最近一次收到 pong（或任何入站帧）的时间。 */
    this.lastPongAt = Date.now();
    /** 连接建立时间。 */
    this.openedAt = Date.now();
    this.closed = false;
    /** @type {NodeJS.Timeout | undefined} */
    this.timer = undefined;
    /** 对端是否回了至少一帧（用于判定「从未响应」）。 */
    this.everResponded = false;

    /**
     * 该连接订阅的会话 → 已推送到的下一个 seq。
     * 由桥接层（lib/http.js）维护，放在这里只是为了让 dispose/close 能顺手清理。
     * @type {Map<string, number> | undefined}
     */
    this.subscribed = undefined;

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', () => this.dispose());
    socket.on('close', () => this.dispose());
    socket.on('end', () => this.dispose());
  }

  /** 远端地址（仅用于日志，不含令牌）。 */
  get remote() {
    return this.socket.remoteAddress ?? '';
  }

  /**
   * 启动心跳。幂等。
   * @returns {() => void} 停止心跳的函数
   */
  startHeartbeat() {
    if (this.timer !== undefined) return () => this.stopHeartbeat();
    this.timer = setInterval(() => this.#beat(), this.heartbeatMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return () => this.stopHeartbeat();
  }

  /** 停止心跳。幂等。 */
  stopHeartbeat() {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** @returns {boolean} 是否已关闭。 */
  get isClosed() {
    return this.closed || this.socket.destroyed;
  }

  /**
   * 发送一条**控制**消息（hello / subscribed / pong / error …）。
   * 控制消息不计入未确认背压——它们不是会话内容，客户端不需要 ack。
   * @param {string} text
   * @returns {boolean} 是否真的写出去了
   */
  send(text) {
    if (this.isClosed) return false;
    try {
      this.socket.write(encodeFrame(OPCODE.TEXT, text));
      return true;
    } catch {
      this.dispose();
      return false;
    }
  }

  /**
   * 发送一个 JSON 控制消息。
   * @param {unknown} value
   * @returns {boolean}
   */
  sendJson(value) {
    try {
      return this.send(JSON.stringify(value));
    } catch {
      return false;
    }
  }

  /**
   * 发送一条**被跟踪**的消息：占用一个消息序号，写进 payload 的 `msgSeq`，
   * 并计入未确认背压。客户端回 `{"type":"ack","seq":n}` 表示「n 及之前都收到了」。
   *
   * @param {Record<string, unknown>} payload 会被浅拷贝后附加 `msgSeq`
   * @returns {number | null} 分配到的消息序号；没发出去时返回 null
   */
  sendTracked(payload) {
    if (this.isClosed) return null;
    if (this.pending >= this.maxBacklog) {
      this.close(CLOSE_CODE.TRY_AGAIN, 'unacknowledged backlog exceeded');
      return null;
    }
    // socket 层背压：内核缓冲涨太高也直接断开，避免无限堆积
    if (this.socket.writableLength > 4 * 1024 * 1024) {
      this.close(CLOSE_CODE.TRY_AGAIN, 'socket backpressure');
      return null;
    }
    this.lastSeq += 1;
    this.pending += 1;
    const seq = this.lastSeq;
    let text;
    try {
      text = JSON.stringify({ ...payload, msgSeq: seq });
    } catch {
      this.pending -= 1;
      this.lastSeq -= 1;
      return null;
    }
    try {
      this.socket.write(encodeFrame(OPCODE.TEXT, text));
      return seq;
    } catch {
      this.pending -= 1;
      this.lastSeq -= 1;
      this.dispose();
      return null;
    }
  }

  /**
   * 客户端确认收到序号 `seq` 及之前的全部消息（水位线模型）。
   * @param {number} seq
   */
  ack(seq) {
    if (!Number.isFinite(seq)) return;
    const target = Math.max(0, Math.floor(Number(seq)));
    // 只认水位线：未来的序号不作数，避免客户端伪造把计数压成负数
    if (target > this.lastSeq) return;
    this.pending = Math.max(0, this.lastSeq - target);
  }

  /**
   * 主动关闭连接（发 close 帧后销毁 socket）。
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code = CLOSE_CODE.NORMAL, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      if (!this.socket.destroyed) {
        // 先建 2 字节的关闭码，再按需拼 reason。
        // 以前 reason 为空时 body 是 0 长度 Buffer，随后的 writeUInt16BE 直接
        // 越界抛 ERR_BUFFER_OUT_OF_BOUNDS，被外层 catch 吞掉 —— 整个 close 帧
        // 都发不出去，关闭码彻底丢失（空 reason 的关闭变成裸 TCP 断开）。
        const head = Buffer.alloc(2);
        head.writeUInt16BE(code, 0);
        const body = reason === '' ? head : Buffer.concat([head, Buffer.from(reason, 'utf8')]);
        this.socket.write(encodeFrame(OPCODE.CLOSE, body));
      }
    } catch {
      /* 对端可能已经消失 */
    }
    this.dispose();
  }

  /** 清理：停心跳、摘监听、销毁 socket。幂等。 */
  dispose() {
    this.stopHeartbeat();
    // 无条件销毁 socket。以前这里是 `if (!this.closed) { destroy }`，而 close()
    // 会先把 this.closed 置 true 再调 dispose()，于是主动关闭之后 socket 永远
    // 不销毁，上层 bridge.stop() 只能干等 2000 ms 兜底 setTimeout。
    // Node 的 destroy() 本身幂等，重复调用无副作用。
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* 已销毁 */
    }
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
    this.socket.removeAllListeners('end');
    if (this.onClose !== undefined) {
      const callback = this.onClose;
      this.onClose = undefined;
      try {
        callback(this);
      } catch {
        /* 关闭回调失败不影响清理 */
      }
    }
  }

  /** @param {Buffer} chunk */
  #onData(chunk) {
    if (this.closed) return;
    this.lastPongAt = Date.now();
    this.everResponded = true;
    /** @type {Array<{ opcode: number, payload: Buffer, fin: boolean }>} */
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (error) {
      const code = typeof /** @type {any} */ (error)?.code === 'number' ? /** @type {any} */ (error).code : CLOSE_CODE.PROTOCOL;
      this.close(code, error instanceof Error ? error.message : 'protocol error');
      return;
    }
    for (const frame of frames) {
      switch (frame.opcode) {
        case OPCODE.TEXT:
        case OPCODE.BINARY: {
          if (this.onMessage !== undefined) {
            try {
              this.onMessage(frame.payload.toString('utf8'), this);
            } catch (error) {
              this.close(CLOSE_CODE.INTERNAL, error instanceof Error ? error.message : 'handler error');
              return;
            }
          }
          break;
        }
        case OPCODE.PING: {
          try {
            this.socket.write(encodeFrame(OPCODE.PONG, frame.payload));
          } catch {
            this.dispose();
          }
          break;
        }
        case OPCODE.PONG:
          this.lastPongAt = Date.now();
          break;
        case OPCODE.CLOSE: {
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : CLOSE_CODE.NORMAL;
          try {
            if (!this.socket.destroyed) {
              const body = Buffer.alloc(2);
              body.writeUInt16BE(code, 0);
              this.socket.write(encodeFrame(OPCODE.CLOSE, body));
            }
          } catch {
            /* 对端已消失 */
          }
          this.dispose();
          return;
        }
        default:
          break;
      }
    }
  }

  /** 心跳：发 ping，超时未响应就断开。 */
  #beat() {
    if (this.isClosed) return;
    if (Date.now() - this.lastPongAt > this.heartbeatMs * HEARTBEAT_MISSES) {
      this.close(CLOSE_CODE.GOING_AWAY, 'heartbeat timed out');
      return;
    }
    try {
      this.socket.write(encodeFrame(OPCODE.PING));
    } catch {
      this.dispose();
    }
  }
}
