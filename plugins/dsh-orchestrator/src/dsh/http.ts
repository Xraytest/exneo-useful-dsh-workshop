/**
 * Minimal HTTP route helpers shared by the workbench-facing routes:
 * same-origin guard, JSON replies, and a bounded body reader. Mirrors the
 * conventions used by dsh-workbench / dsh-dual-agent owners.
 * @module dsh-orchestrator/dsh/http
 */

export interface JsonReply {
  (status: number, value: unknown): void
}

export interface RouteHandler {
  (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, json: JsonReply): Promise<void> | void
}

export interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void }): () => void
  readonly port?: number
}

export function sameOrigin(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const origin = req.headers['origin']
  if (typeof origin !== 'string' || origin === '') return true
  if (origin === 'null') return false
  try {
    return new URL(origin).host === req.headers['host']
  } catch {
    return false
  }
}

export function jsonOf(res: import('node:http').ServerResponse): JsonReply {
  return (status, value) => {
    if (res.headersSent) return
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
}

export function readBody(req: import('node:http').IncomingMessage, limit = 1 << 20): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise((settle) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (value: { ok: true; text: string } | { ok: false; error: string }) => {
      if (!done) {
        done = true
        settle(value)
      }
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        finish({ ok: false, error: '请求体过大' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', (cause) => finish({ ok: false, error: String((cause as Error).message) }))
  })
}

export const queryOf = (req: { url?: string | undefined }, key: string): string => {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams.get(key) ?? ''
  } catch {
    return ''
  }
}