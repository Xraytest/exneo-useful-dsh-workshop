/**
 * 示例子插件：一个「只在该工作区的会话里存在」的模型工具。
 *
 * 这不是框架的一部分，是本插件自带的**最小可挂载示例**，也当作自测与线上冒烟
 * 的探针：
 *   · 它是一个完全普通的 Cordis 插件（`name` / `inject` / `apply`），与组合行里
 *     的插件写法一致；
 *   · 它注册的 `workspace_plugin_probe` 工具会出现在**挂着它的那些会话**的模型
 *     工具表里；其它工作区的会话既看不到、也调不到（工具是作用域注册表，投影按
 *     agent 作用域算）；
 *   · 返回值里的 sessionId / cwd / calls 用来证明：每个会话拿到的是自己的那份
 *     实例（计数器不共享），并且确实运行在该会话里。
 *
 * 挂上它（任选其一）：
 *   ① profile 的 cordis.patch.yml：
 *        - insert:
 *            - id: workspace-plugins
 *              name: ./plugins/dsh-workspace-plugins/index.js
 *              config:
 *                workspaces:
 *                  - path: /root/DSHpluginWorkSpace
 *                    plugins:
 *                      - id: probe
 *                        name: ./plugins/dsh-workspace-plugins/examples/probe-tool.js
 *   ② 设置 →「工作区插件」→ 给某个工作区加一行，模块标识填上面对应的 name。
 *
 * @module dsh-workspace-plugins/examples/probe-tool
 */

export const name = 'workspace-plugin-probe';

/** 工具注册表由 host 平面提供；在 agent 作用域里同样解析得到。 */
export const inject = ['tools'];

/**
 * @param ctx - 本子插件的 fiber 上下文（父级是挂着它的那个会话的 agent.ctx）。
 * @param config - 行 config，可给 `label` 起一个显示名（诊断用）。
 */
export function apply(ctx, config = {}) {
  const label = typeof config.label === 'string' && config.label !== '' ? config.label : 'probe';
  let calls = 0;

  ctx.tools.register({
    name: 'workspace_plugin_probe',
    description: [
      'Report that this workspace-scoped plugin is live in THIS session.',
      'The tool exists only in sessions whose working directory matches the workspace the plugin was attached to;',
      'a session outside that workspace does not see it at all. Its output echoes the calling session id and cwd',
      'so the scope can be confirmed from the transcript.',
    ].join(' '),
    parameters: {
      note: { type: 'string', description: 'Optional free-text note echoed back (proves arguments arrive intact).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const lines = [
          `workspace plugin "${String(value.plugin)}" is active in this session`,
          `session: ${String(value.sessionId)}`,
          `cwd: ${String(value.cwd)}`,
          `calls in this session: ${String(value.calls)}`,
        ];
        if (value.note !== undefined) lines.push(`note: ${String(value.note)}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      calls += 1;
      const agent = exec === undefined ? undefined : exec.agent;
      const input = args !== null && typeof args === 'object' ? args : {};
      return {
        ok: true,
        plugin: label,
        sessionId: agent?.id ?? null,
        cwd: agent?.session?.header?.cwd ?? null,
        calls,
        note: input.note,
        mountedAt: new Date().toISOString(),
      };
    },
  });
}
