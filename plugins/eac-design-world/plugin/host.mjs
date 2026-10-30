import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import net from 'node:net';
import { VERSION } from '../src/version.mjs';
import { selfReload } from '../src/maintenance-reload.mjs';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../src/catalog.mjs';
import { designContextFor } from '../src/engine.mjs';
import { toLosslessJson } from '../src/lossless-json.mjs';

export const name = 'eac-design-world';
export const version = VERSION;
export const inject = ['tools', 'systemPrompt'];

const reads = new Set(['status', 'project_get', 'job_status', 'template_read', 'library_read', 'library_list', 'library', 'design_state', 'composer_get']);

/**
 * 探测端口是否可绑定。
 *
 * 必须探测 **0.0.0.0**（和 startServer 实际 bind 的地址一致），不能只探 127.0.0.1：
 * Windows 上 Node 的 TCP server 默认带 SO_REUSEADDR，此时「已 bind 0.0.0.0:P」并不
 * 阻止再 bind 127.0.0.1:P —— 探针会误报「端口空闲」，紧接着 startServer 去 bind
 * 0.0.0.0:P 才以 EADDRINUSE 失败，而那时引擎已经建好、错误信息也只剩一句
 * "address already in use 0.0.0.0:4173"，看不出是被谁占的。
 */
async function assertPortAvailable(port) {
  await new Promise((accept, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '0.0.0.0', () => probe.close(accept));
  });
}

export function createRemoteEngine(url, request = fetch) {
  async function call(path, { method = 'GET', args, signal } = {}) {
    const response = await request(`${url}${path}`, {
      method, signal: signal ?? AbortSignal.timeout(65_000),
      ...(args === undefined ? {} : {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(args),
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(typeof result.error === 'string' ? result.error : `EAC HTTP ${response.status}`);
      error.code = 'EAC_REMOTE_ERROR';
      throw error;
    }
    return result;
  }
  return {
    state: () => call('/api/state'),
    library: () => call('/api/library'),
    close() {},
    handle(name, args = {}) {
      const project = `/api/projects/${encodeURIComponent(args.projectId ?? '')}`;
      const job = `/api/jobs/${encodeURIComponent(args.jobId ?? '')}`;
      const routes = {
        status: ['/api/state', 'GET'],
        project_create: ['/api/projects', 'POST'],
        project_get: [project, 'GET'],
        asset_import: [`${project}/assets`, 'POST'],
        timeline_plan: [`${project}/plan`, 'POST'],
        timeline_update: [`${project}/timeline`, 'PUT'],
        job_submit: ['/api/jobs', 'POST'],
        job_status: [job, 'GET'],
        job_cancel: [`${job}/cancel`, 'POST'],
        template_read: ['/api/tools/template_read', 'POST'],
        library_read: ['/api/tools/library_read', 'POST'],
        library_list: ['/api/tools/library_list', 'POST'],
        library: ['/api/library', 'GET'],
        design_project_create: ['/api/design/projects', 'POST'],
        design_artifact_save: ['/api/design/artifacts', 'POST'],
        design_state: [`/api/design/state${args.sessionId ? `?sessionId=${encodeURIComponent(args.sessionId)}` : ''}`, 'GET'],
        composer_get: [`/api/composer${args.sessionId ? `?sessionId=${encodeURIComponent(args.sessionId)}` : ''}`, 'GET'],
        composer_update: ['/api/composer', 'PUT'],
      };
      const route = routes[name];
      if (!route) throw new Error(`Unknown EAC tool: ${name}`);
      return call(route[0], { method: route[1], args: route[1] === 'GET' ? undefined : args });
    },
  };
}

// The registry accepts raw JSON Schema definitions as well as defineTool's compiled output.
// Keep the shared schemas intact; the authoring DSL cannot express minLength/minimum.
export function createToolRegistrations(engine, definitions) {
  const validator = new AjvJsonSchemaValidator();
  return definitions.map(({ name: toolName, description, inputSchema }) => {
    const engineName = toolName.replace(/^eac_/, '');
    const validate = validator.getValidator(inputSchema);
    return {
      name: `eac_${engineName}`,
      description,
      parameters: structuredClone(inputSchema),
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => reads.has(engineName),
      async execute(args, execution) {
        execution?.signal?.throwIfAborted();
        const validation = validate(args);
        if (!validation.valid) {
          const error = new TypeError(`Invalid EAC tool arguments: ${validation.errorMessage}`);
          error.code = 'INVALID_ARGS';
          throw error;
        }
        // The Harness host requires every tool result to be lossless JSON. Engine
        // results can carry optional fields left as `undefined` (which JSON would
        // silently drop) and, in principle, other non-JSON leaves; normalize here,
        // at the single host boundary, without swallowing genuine engine errors.
        const result = await engine.handle(engineName, args);
        try {
          return toLosslessJson(result);
        } catch (error) {
          if (error?.code !== 'EAC_LOSSLESS_JSON') throw error;
          const failure = new Error(`EAC tool ${engineName} returned invalid output: ${error.message}`);
          failure.code = 'EAC_INVALID_OUTPUT';
          throw failure;
        }
      },
    };
  });
}

export function activate(ctx, config = {}, dependencies = {}) {
  const port = config.port ?? 4173;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('EAC port must be an integer between 1 and 65535.');
  }
  let engine;
  let server;
  let disposed = false;
  let closing;
  let startup;
  const registrations = [];
  const release = async () => {
    try {
      for (const remove of registrations.splice(0).reverse()) remove();
    } finally {
      const currentServer = server;
      const currentEngine = engine;
      server = undefined;
      engine = undefined;
      try { await currentServer?.close(); } finally { await currentEngine?.close(); }
    }
  };
  const close = () => {
    disposed = true;
    return closing ??= Promise.resolve(startup).catch(() => {}).then(release);
  };
  // Register teardown before asynchronous startup so unloading cannot leak its server.
  if (typeof ctx.effect === 'function') ctx.effect(() => close);
  else ctx.on('dispose', close);
  startup = (async () => {
    // 启动分多段做，每段都能单独失败：端口被占、引擎初始化、起服务、注册工具。
    // 旧实现是「一处失败就 release + throw」，而 apply() 只是 await 它 —— 于是一次
    // 瞬时失败（典型：上一个进程的 EAC 服务还没退干净，占着 4173，撞上
    // EAC_STALE_RUNTIME / EADDRINUSE）就会让宿主半边永久死掉：工具全没了、服务也不听
    // 端口，而浏览器半边还挂在输入框上，用户只看到「选择同步失败，请重试或刷新页面」。
    // 现在改成：前台重试若干次，仍失败就转后台继续重试并保留错误，插件自行恢复。
    const attempt = async () => {
      const { createEngine } = dependencies.createEngine ? dependencies : await import('../src/engine.mjs');
      const { startServer } = dependencies.startServer ? dependencies : await import('../src/server.mjs');
      const { toolDefinitions, productionInstructions = '' } = dependencies.toolDefinitions
        ? dependencies : await import('../src/tools.mjs');
      let existing = false;
      try {
        await (dependencies.assertPortAvailable ?? assertPortAvailable)(port);
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
        const response = await (dependencies.request ?? fetch)(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(2500),
        });
        const health = await response.json();
        if (!response.ok || health.ok !== true || health.name !== 'EAC design world'
          || typeof health.version !== 'string') throw error;
        if (health.version !== VERSION) {
          const stale = new Error(`EAC 服务仍运行 ${health.version}，当前插件源码为 ${VERSION}。请先在旧服务所属进程停止服务，再重新加载插件；不能把旧接口当成新插件继续使用。`);
          stale.code = 'EAC_STALE_RUNTIME';
          throw stale;
        }
        existing = true;
      }
      if (disposed) return;
      if (existing) {
        engine = createRemoteEngine(`http://127.0.0.1:${port}`, dependencies.request);
      } else {
        engine = await createEngine(config.dataDir ? { dataDir: config.dataDir } : {});
        if (disposed) return;
        const loader = typeof ctx.get === 'function' ? ctx.get('loader') : ctx.loader;
        const reloadAvailable = Boolean(loader && ctx.registry && ctx.fiber?.runtime?.callback);
        const maintenanceOptions = reloadAvailable ? { mode: 'harness', runningVersion: VERSION, reload: ({ expectedVersion } = {}) => selfReload(ctx, {
          packageUrl: `${pathToFileURL(ROOT).href}/`, entryUrl: new URL('./host.mjs', import.meta.url).href, expectedVersion,
        }) } : undefined;
        server = await startServer({ engine, port, dev: config.dev ?? false, ...(maintenanceOptions ? { maintenanceOptions } : {}) });
      }
      if (disposed) return;
      for (const definition of createToolRegistrations(engine, toolDefinitions)) {
        registrations.push(ctx.tools.register(definition));
      }
      const handles = new Set(toolDefinitions.map(tool => tool.name.replace(/^eac_/, '')));
      registrations.push(ctx.systemPrompt.section({
        name: 'eac-design-world:production',
        order: 8500,
        interpolate: false,
        text: productionInstructions.replace(/\b[a-z_]+\b/g, word => handles.has(word) ? `eac_${word}` : word),
      }));
      // Per-assembly design context: resolved for the exact agent/session of this turn only,
      // so a design-mode selection never leaks into other conversations. Section text providers
      // are synchronous, so the backend read happens in an async assembly-waterfall listener that
      // appends one section keyed on the assembly's own agent id (the session id).
      registrations.push(ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        const resolved = await next();
        const sessionId = context?.agent?.id;
        if (!sessionId) return resolved;
        let record;
        try {
          record = await engine.handle('composer_get', { sessionId });
        } catch { return resolved; }
        const hint = designContextFor(record);
        if (!hint) return resolved;
        const text = hint.replace(/\b[a-z_]+\b/g, word => handles.has(word) ? `eac_${word}` : word);
        return { ...resolved, sections: [...resolved.sections, { name: 'eac-design-world:composer', text, interpolate: false }] };
      }));
      return { engine, server, close };
    };
    // 前台重试：端口被上个进程占用时，旧服务通常几秒内就退干净了，重试一次就能起来。
    const foregroundAttempts = 4;
    let lastError;
    for (let round = 0; round < foregroundAttempts; round += 1) {
      if (disposed) return;
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
        // 已经成功注册过又失败的（理论上不会走到），先收干净再重来。
        await release().catch(() => {});
        ctx.logger?.warn?.(`eac-design-world: 启动失败（第 ${round + 1}/${foregroundAttempts} 次，端口 ${port}）：${error?.code ? `${error.code} ` : ''}${error?.message ?? error}`);
        if (round < foregroundAttempts - 1 && !disposed) {
          await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** round));
        }
      }
    }
    // 后台自愈：不 reject（否则宿主半边彻底死掉、工具全消失），继续按退避间隔重试，
    // 直到端口空出来或插件被 dispose。错误保留在 lastError 上便于排查。
    // 日志按次数抽稀：前 5 次每次都说，之后每 10 次一条，避免长期占端口时刷屏。
    ctx.logger?.error?.(`eac-design-world: ${foregroundAttempts} 次启动均失败（端口 ${port}），转入后台重试。最后一次错误：${lastError?.code ? `${lastError.code} ` : ''}${lastError?.message ?? lastError}`);
    let backgroundRound = 0;
    while (!disposed) {
      await new Promise(resolve => setTimeout(resolve, 15000));
      if (disposed) break;
      backgroundRound += 1;
      try {
        await attempt();
        ctx.logger?.info?.(`eac-design-world: 后台第 ${backgroundRound} 次重试启动成功（端口 ${port}）`);
        return;
      } catch (error) {
        lastError = error;
        await release().catch(() => {});
        if (backgroundRound <= 5 || backgroundRound % 10 === 0) {
          ctx.logger?.warn?.(`eac-design-world: 后台第 ${backgroundRound} 次重试仍失败（端口 ${port}）：${error?.code ? `${error.code} ` : ''}${error?.message ?? error}`);
        }
      }
    }
  })();
  return startup;
}

export async function apply(ctx, config) {
  await activate(ctx, config);
}

