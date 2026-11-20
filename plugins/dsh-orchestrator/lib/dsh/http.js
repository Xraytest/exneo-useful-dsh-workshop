/**
 * Minimal HTTP route helpers shared by the workbench-facing routes:
 * same-origin guard, JSON replies, and a bounded body reader. Mirrors the
 * conventions used by dsh-workbench / dsh-dual-agent owners.
 * @module dsh-orchestrator/dsh/http
 */
export function sameOrigin(req) {
    const origin = req.headers['origin'];
    if (typeof origin !== 'string' || origin === '')
        return true;
    if (origin === 'null')
        return false;
    try {
        return new URL(origin).host === req.headers['host'];
    }
    catch {
        return false;
    }
}
export function jsonOf(res) {
    return (status, value) => {
        if (res.headersSent)
            return;
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(value));
    };
}
export function readBody(req, limit = 1 << 20) {
    return new Promise((settle) => {
        const chunks = [];
        let size = 0;
        let done = false;
        const finish = (value) => {
            if (!done) {
                done = true;
                settle(value);
            }
        };
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                finish({ ok: false, error: '请求体过大' });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
        req.on('error', (cause) => finish({ ok: false, error: String(cause.message) }));
    });
}
export const queryOf = (req, key) => {
    try {
        return new URL(req.url ?? '/', 'http://localhost').searchParams.get(key) ?? '';
    }
    catch {
        return '';
    }
};
