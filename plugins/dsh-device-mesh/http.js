/**
 * dsh-device-mesh — 出站 HTTP/HTTPS JSON 客户端。
 *
 * 用 `node:http` / `node:https` 而不是全局 `fetch`：本插件要活在一个可能被沙箱、
 * 被 worker、被老版本 Node 承载的宿主里，全局 fetch 不保证存在；而且这里需要
 * **精确控制超时与响应体上限**，那两件事在 fetch 里要靠 AbortController + 手写
 * 流式读取绕一圈，反而更长。
 *
 * 三条硬纪律：
 *   · 不跟随重定向（3xx 直接当失败）—— 签名覆盖 path，跟随重定向会让请求打到
 *     一个签名没覆盖过的地方，是标准的签名绕过面。
 *   · 响应体有上限（默认 4 MiB），超限即断开 —— 对端被换成恶意服务时不能把
 *     本机内存读爆。
 *   · 超时同时约束「拿到响应头」与「读完响应体」两段，任一段超时都断开。
 *
 * @module dsh-device-mesh/http
 */

import http from 'node:http'
import https from 'node:https'

/**
 * 一次 JSON 请求的结果。
 * @typedef {{ok: true, status: number, json: unknown, headers: Record<string, string|string[]|undefined>}
 *   | {ok: false, status: number|null, error: string, json: unknown}} HttpResult
 */

/**
 * 发起一次 JSON 请求。
 * @param {string} baseUrl 接入点根 URL（已归一化，无尾斜杠）。
 * @param {{path: string, method?: string, body?: string|null, headers?: Record<string,string>, timeoutMs?: number, maxBytes?: number, signal?: AbortSignal}} options 请求参数。
 * @returns {Promise<HttpResult>} 结果（网络层失败也 resolve，用 ok:false 表达）。
 */
export function requestJson(baseUrl, options) {
  return new Promise((resolvePromise) => {
    let url
    try {
      url = new URL(`${baseUrl}${options.path}`)
    } catch (error) {
      resolvePromise({ ok: false, status: null, error: `接入点地址非法：${error?.message ?? error}`, json: null })
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      resolvePromise({ ok: false, status: null, error: `不支持的协议 ${url.protocol}`, json: null })
      return
    }

    const transport = url.protocol === 'https:' ? https : http
    const body = typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : null
    const maxBytes = options.maxBytes ?? 4 * 1024 * 1024
    const timeoutMs = options.timeoutMs ?? 15000
    const headers = {
      accept: 'application/json',
      'user-agent': 'dsh-device-mesh',
      ...(options.headers ?? {}),
    }
    if (body !== null) {
      headers['content-type'] = 'application/json; charset=utf-8'
      headers['content-length'] = String(body.length)
    }

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      resolvePromise(value)
    }

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? undefined : url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers,
      },
      (res) => {
        const status = res.statusCode ?? 0
        const chunks = []
        let size = 0
        let overflow = false
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > maxBytes) {
            overflow = true
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        res.on('error', (error) => {
          finish({ ok: false, status, error: `读取响应失败：${error?.message ?? error}`, json: null })
        })
        res.on('end', () => {
          if (overflow) {
            finish({ ok: false, status, error: `响应体超过 ${maxBytes} 字节上限`, json: null })
            return
          }
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = null
          if (text !== '') {
            try {
              parsed = JSON.parse(text)
            } catch {
              finish({ ok: false, status, error: `响应不是合法 JSON（HTTP ${status}）`, json: null })
              return
            }
          }
          if (status < 200 || status >= 300) {
            const detail = parsed !== null && typeof parsed === 'object' && typeof parsed.error === 'string'
              ? parsed.error
              : `HTTP ${status}`
            finish({ ok: false, status, error: detail, json: parsed })
            return
          }
          finish({ ok: true, status, json: parsed, headers: res.headers })
        })
      },
    )

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${timeoutMs} ms）`))
    })
    req.on('error', (error) => {
      // abort 与网络失败分开报：前者是「我们主动取消」，不该被记成对端故障。
      const aborted = options.signal?.aborted === true
      finish({ ok: false, status: null, error: aborted ? '请求已取消' : `网络错误：${error?.message ?? error}`, json: null })
    })

    const onAbort = () => req.destroy(new Error('aborted'))
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        finish({ ok: false, status: null, error: '请求已取消', json: null })
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    if (body !== null) req.write(body)
    req.end()
  })
}
