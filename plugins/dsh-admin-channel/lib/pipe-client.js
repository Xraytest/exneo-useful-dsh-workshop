/**
 * 命名管道客户端：与提权 broker 之间按行 JSON 通信。
 *
 * 设计约束：
 *   · 只有 DSH host 进程会连这条管道（broker 侧还会用 GetNamedPipeClientProcessId
 *     校验客户端 PID），所以这里不带任何浏览器语义；
 *   · 每个请求带 id，响应按 id 关联；握手、pong 这类无 id 消息进入事件队列；
 *   · 连接失败（管道还没建好、UAC 还没批）必须快速失败，便于上层重试。
 *
 * @module dsh-admin-channel/lib/pipe-client
 */

import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

/** 连接超时（毫秒）：UAC 期间管道不存在，这里要快速失败后重试。 */
const CONNECT_TIMEOUT_MS = 1500;

/** 单行 JSON 上限：broker 已按 maxOutputBytes 截断，这里只防坏帧。 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export class PipeClient {
  /** @type {import('node:net').Socket | null} */
  #socket = null;
  #buffer = '';
  #pending = new Map();
  #events = [];
  #waiters = [];
  #closed = false;
  #closeError = null;
  #closeListeners = new Set();

  /** @returns {boolean} */
  get connected() {
    return this.#socket !== null && !this.#closed;
  }

  /** @returns {boolean} */
  get closed() {
    return this.#closed;
  }

  /**
   * 连到命名管道。失败会销毁 socket 并 reject（上层按“还没起来”重试）。
   * @param {string} pipePath 例如 `\\\\.\\pipe\\dsh-admin-channel-xxxx`
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  connect(pipePath, timeoutMs = CONNECT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const socket = createConnection(pipePath);
      let settled = false;
      const timer = setTimeout(() => finish(new Error('命名管道连接超时')), timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener('error', onError);
        socket.removeListener('connect', onConnect);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error !== undefined) {
          try { socket.destroy(); } catch { /* 已断开 */ }
          reject(error);
        } else {
          this.#socket = socket;
          this.#attach(socket);
          resolve();
        }
      };
      const onError = (error) => finish(error instanceof Error ? error : new Error(String(error)));
      const onConnect = () => finish(undefined);

      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  /**
   * 安装数据/关闭监听。连接阶段的一次性监听已摘除。
   * @param {import('node:net').Socket} socket
   */
  #attach(socket) {
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => this.#fail(error instanceof Error ? error : new Error(String(error))));
    socket.on('close', () => this.#fail(new Error('提权通道已关闭')));
  }

  /**
   * 按行切帧并分发。
   * @param {string} chunk
   */
  #onData(chunk) {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, 'utf8') > MAX_LINE_BYTES) {
      this.#fail(new Error('提权通道返回了过大的单帧'));
      return;
    }
    let index;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.#dispatch(message);
    }
  }

  /**
   * @param {any} message
   */
  #dispatch(message) {
    if (message === null || typeof message !== 'object') return;
    const id = typeof message.id === 'string' ? message.id : '';
    if (id !== '' && this.#pending.has(id)) {
      const entry = this.#pending.get(id);
      this.#pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(message);
      return;
    }
    this.#events.push(message);
    // 让所有等待者都有机会检查新事件。
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter.check();
  }

  /**
   * 发一条消息。未连上时抛错。
   * @param {any} message
   */
  send(message) {
    if (this.#socket === null || this.#closed) throw new Error('提权通道未连接');
    const line = `${JSON.stringify(message)}\n`;
    this.#socket.write(line, 'utf8');
  }

  /**
   * 等一条满足条件的**无 id** 消息（ready/pong/stopped/error）。
   * @param {(message: any) => boolean} predicate
   * @param {number} timeoutMs
   * @param {string} label
   * @returns {Promise<any>}
   */
  waitFor(predicate, timeoutMs, label = '消息') {
    const existing = this.#events.findIndex((message) => predicate(message));
    if (existing >= 0) {
      const [message] = this.#events.splice(existing, 1);
      return Promise.resolve(message);
    }
    if (this.#closed) return Promise.reject(this.#closeError ?? new Error('提权通道已关闭'));
    return new Promise((resolve, reject) => {
      const waiter = {
        check: () => {
          const index = this.#events.findIndex((message) => predicate(message));
          if (index < 0) {
            this.#waiters.push(waiter);
            return;
          }
          clearTimeout(timer);
          const [message] = this.#events.splice(index, 1);
          resolve(message);
        },
        fail: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((candidate) => candidate !== waiter);
        reject(new Error(`等待${label}超时`));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  /**
   * 发一个有 id 的请求并等对应响应。
   * @param {any} payload
   * @param {number} timeoutMs
   * @param {string} label
   * @returns {Promise<any>}
   */
  request(payload, timeoutMs, label = '请求') {
    if (this.#socket === null || this.#closed) return Promise.reject(new Error('提权通道未连接'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${label}超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.send({ ...payload, id });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * 关闭连接；所有在途请求立刻失败。
   * @param {Error} [reason]
   */
  close(reason) {
    this.#fail(reason ?? new Error('提权通道已关闭'));
    try { this.#socket?.destroy(); } catch { /* 已断开 */ }
  }

  /**
   * @param {Error} error
   */
  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = error;
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter.fail(error);
    for (const listener of this.#closeListeners) {
      try { listener(error); } catch { /* 单个监听器失败不影响其它 */ }
    }
    this.#closeListeners.clear();
  }

  /**
   * 监听连接关闭（只回调一次）。
   * @param {(error: Error) => void} listener
   * @returns {() => void}
   */
  onClose(listener) {
    if (this.#closed) {
      listener(this.#closeError ?? new Error('提权通道已关闭'));
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }
}
