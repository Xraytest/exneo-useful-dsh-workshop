const REFRESH_MS = 3000;
const ROUTE_SEP = '::';
const EFFORTS = ['low', 'medium', 'high'];
export const splitRoute = (value) => {
    const text = String(value ?? '');
    const at = text.indexOf(ROUTE_SEP);
    if (at <= 0)
        return undefined;
    const provider = text.slice(0, at).trim();
    const model = text.slice(at + ROUTE_SEP.length).trim();
    return provider !== '' && model !== '' ? { provider, model } : undefined;
};
export function menuError(message, status = 400) {
    const error = new Error(message);
    error.menuStatus = status;
    return error;
}
const routeLabel = (route) => route === undefined ? '' : route.provider + ROUTE_SEP + route.model;
const catalogOptions = (catalog) => {
    const options = [];
    for (const group of catalog.groups) {
        for (const model of group.models) {
            if (model.id === '')
                continue;
            options.push({
                value: group.id + ROUTE_SEP + model.id,
                label: model.name !== undefined && model.name !== '' && model.name !== model.id
                    ? group.name + ' / ' + model.name + '（' + model.id + '）'
                    : group.name + ' / ' + model.id,
                group: group.name,
            });
        }
    }
    return options;
};
export function attachWorkbenchMenu(hub) {
    const title = 'Orchestrator';
    async function buildSpec(sessionId) {
        const settings = hub.state.stateOf(sessionId);
        const catalog = await hub.catalog();
        const backends = hub.backends();
        const items = [];
        items.push({
            kind: 'note',
            tone: settings.enabled ? 'ok' : 'warn',
            text: settings.enabled
                ? '已启用：本会话的模型可以调用 orch_run 编排多代理任务。'
                    + (settings.route !== undefined ? ' 子代理默认走 ' + settings.route.provider + ' / ' + settings.route.model + '。' : '')
                : '总开关关着：orch_run 对本会话隐藏、触发器停用（orch_status / orch_cancel 仍可用）。菜单里的设置可预先配置，拨开开关即生效。',
        });
        items.push({ kind: 'heading', text: '本会话子代理' });
        items.push({
            kind: 'switch',
            id: 'route-on',
            label: '子代理走指定模型',
            hint: '开启后所选模型成为本会话的默认路由（插件配置里的显式角色/规则仍优先）；关闭则沿用插件配置。',
            value: settings.route !== undefined,
        });
        items.push({
            kind: 'select',
            id: 'route',
            label: '模型',
            hint: settings.route === undefined
                ? '当前沿用插件配置路由。选择一个模型即成为本会话子代理的默认模型。'
                : '本会话子代理的默认模型。',
            value: routeLabel(settings.route),
            options: [{ value: '', label: '（沿用插件配置）' }, ...catalogOptions(catalog)],
            placeholder: catalog.error ?? '选择 provider / 模型',
        });
        items.push({
            kind: 'select',
            id: 'effort',
            label: '思考力度',
            hint: '随上面选定的模型生效；部分模型不支持时会按模型默认档回落。',
            value: settings.reasoningEffort ?? '',
            options: [{ value: '', label: '模型默认' }, ...EFFORTS.map((effort) => ({ value: effort, label: effort }))],
        });
        items.push({
            kind: 'select',
            id: 'backend',
            label: '子代理后端',
            hint: 'spawn = 全新会话的本地子代理；fork = 继承主会话已完成回合的本地子代理。',
            value: settings.backend ?? '',
            options: [{ value: '', label: '（跟随插件配置）' }, ...backends.map((backend) => ({ value: backend, label: backend }))],
        });
        items.push({
            kind: 'note',
            tone: 'info',
            text: '以上设置只作用于本会话（每个会话独立），落盘于 $DSH_HOME/dsh-orchestrator/sessions.json；会话中途也可随时更改。',
        });
        items.push({
            kind: 'buttons',
            buttons: [
                { op: 'reset', label: '恢复本会话默认', tone: 'danger' },
                { op: 'refresh', label: '刷新' },
            ],
        });
        return {
            title,
            sessionId,
            phase: settings.enabled ? 'running' : 'off',
            refreshMs: REFRESH_MS,
            items,
            generatedAt: Date.now(),
        };
    }
    async function applyOp(body = {}) {
        const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : '';
        if (sessionId === '')
            throw menuError('sessionId 必填', 400);
        const op = String(body['op'] ?? '');
        if (op === 'set') {
            const id = String(body['id'] ?? '');
            const value = body['value'];
            if (id === 'enabled') {
                hub.state.setEnabled(sessionId, value === true);
                return buildSpec(sessionId);
            }
            if (id === 'route') {
                const text = String(value ?? '');
                const route = text === '' ? undefined : splitRoute(text);
                if (text !== '' && route === undefined)
                    throw menuError('模型值必须是 provider::model', 400);
                hub.state.setRoute(sessionId, route);
                return buildSpec(sessionId);
            }
            if (id === 'effort') {
                const effort = String(value ?? '');
                if (effort !== '' && !EFFORTS.includes(effort)) {
                    throw menuError('不认识的思考力度：' + effort);
                }
                hub.state.setReasoningEffort(sessionId, effort === '' ? undefined : effort);
                return buildSpec(sessionId);
            }
            if (id === 'backend') {
                const backend = String(value ?? '');
                if (backend !== '' && !hub.backends().includes(backend)) {
                    throw menuError('不可用的子代理后端：' + (backend === '' ? '(空)' : backend), 400);
                }
                hub.state.setBackend(sessionId, backend === '' ? undefined : backend);
                return buildSpec(sessionId);
            }
            if (id === 'route-on') {
                if (value === true && hub.state.stateOf(sessionId).route === undefined) {
                    throw menuError('请先在「模型」里选择一个 provider / 模型', 409);
                }
                // The route select writes the route; this switch only reports state.
                return buildSpec(sessionId);
            }
            throw menuError('不认识的设置项：' + (id === '' ? '(空)' : id), 400);
        }
        if (op === 'reset') {
            hub.state.clear(sessionId);
            return buildSpec(sessionId);
        }
        if (op === 'refresh')
            return buildSpec(sessionId);
        throw menuError('不认识的 op：' + (op === '' ? '(空)' : op), 400);
    }
    return { buildSpec, applyOp };
}
