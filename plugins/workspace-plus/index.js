/**
 * WorkSpacePlus 閳?reimagine the DeepSeek Harness workspace as projects.
 *
 * A project groups directories into one logical workspace: exactly one
 * PRIMARY path plus zero or more SECONDARY paths. A session "belongs to" a
 * project when its working directory lives inside one of the project's paths
 * (the primary path is the anchor). The active project's full path set is
 * surfaced to the model through a runtime system-prompt context, so the agent
 * understands the workspace as one project spanning several directories, and
 * is managed through model-facing tools.
 *
 * Design mirrors the proven model in zai-org/ZCode (`ProjectRoot { rootPath,
 * isPrimary }`, `VirtualProject { roots }`, and a session resolving to
 * `{ workspacePath, additionalDirectories }`), adapted to the Harness plugin
 * surface. Plugin-owned data lives in a durable JSON file under the Harness
 * home (`~/.dsh/workspace-plus/projects.json`); it is never written as new
 * session event types, so fork/resume/replay stay intact.
 *
 * This module intentionally imports no `@deepseek-ai/*` package: a
 * profile-installed bundle resolves bare specifiers by walking up from its own
 * directory, which cannot see the Harness installation's node_modules. Every
 * capability is reached through the injected `ctx` services and Node builtins,
 * and tool definitions are hand-built in the registry's raw JSON-Schema form
 * (exactly what `defineTool` would have produced).
 *
 * @module @local/workspace-plus
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

/** Host services this plugin consumes; all are core and always present. */
export const inject = ["tools", "systemPrompt", "workingDirectory"];

/** Sort order of the runtime context line, placed just after the working directory (100). */
const CONTEXT_ORDER = 105;

/** Durable data location under the resolved Harness home. */
const DSH_HOME = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || resolve(homedir(), ".dsh");
const DATA_DIR = resolve(DSH_HOME, "workspace-plus");
const DATA_FILE = resolve(DATA_DIR, "projects.json");

/** Stable machine error code carried back to tool callers. */
class OpError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "OpError";
    this.code = code;
  }
}

/** Whether a path is absolute in POSIX or Windows spelling. */
function isAbs(p) {
  return /^([A-Za-z]:)?[\\/]/.test(p) || p.startsWith("\\\\");
}
/** Resolve a user/tool-supplied path to an absolute, normalized path. */
function normalizePath(input, cwd) {
  return resolve(cwd && !isAbs(input) ? cwd : process.cwd(), input);
}
/** Comparison key: normalized + case-folded on Windows so `D:\A` == `d:/a`. */
function pathKey(p) {
  const n = normalizePath(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n.toLowerCase() : n;
}
/** Whether `child` is `parent` itself or lives beneath it. */
function isInside(parent, child) {
  const p = pathKey(parent);
  const c = pathKey(child);
  if (p === c) return true;
  return c.startsWith(p + (process.platform === "win32" ? "\\" : "/"));
}

function isValidProject(p) {
  return (
    !!p &&
    typeof p === "object" &&
    typeof p.id === "string" &&
    p.id.length > 0 &&
    typeof p.name === "string" &&
    typeof p.primaryPath === "string" &&
    p.primaryPath.length > 0
  );
}
function normalizeProject(p) {
  const secondary = Array.isArray(p.secondaryPaths) ? p.secondaryPaths.filter((x) => typeof x === "string" && x.length > 0) : [];
  const primary = normalizePath(p.primaryPath);
  const seen = new Set([pathKey(primary)]);
  const secondaryPaths = [];
  for (const raw of secondary) {
    const key = pathKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    secondaryPaths.push(normalizePath(raw));
  }
  return {
    id: String(p.id),
    name: String(p.name),
    primaryPath: primary,
    secondaryPaths,
    pinned: Boolean(p.pinned),
    createdAt: Number.isFinite(p.createdAt) ? p.createdAt : 0,
    updatedAt: Number.isFinite(p.updatedAt) ? p.updatedAt : 0,
  };
}
function cloneProject(p) {
  return { ...p, secondaryPaths: [...p.secondaryPaths] };
}

/** The project whose paths contain `cwd`, preferring the primary path and the most specific match. */
function activeFor(projects, cwd) {
  if (!cwd) return void 0;
  let best;
  let bestScore = -1;
  for (const project of projects) {
    const paths = [project.primaryPath, ...project.secondaryPaths];
    for (let i = 0; i < paths.length; i++) {
      if (!isInside(paths[i], cwd)) continue;
      const score = (i === 0 ? 1e15 : 0) + pathKey(paths[i]).length;
      if (score > bestScore) {
        best = project;
        bestScore = score;
      }
    }
  }
  return best;
}

/** Model-facing rendering of the active project. */
function renderProjectContext(project) {
  const lines = [];
  lines.push(`Active project ${JSON.stringify(project.name)} (WorkSpacePlus).`);
  lines.push(`Primary path: ${project.primaryPath}`);
  if (project.secondaryPaths.length > 0) {
    lines.push("Additional paths that belong to this same project:");
    for (const p of project.secondaryPaths) lines.push(`- ${p}`);
  }
  lines.push(
    "These directories form ONE project. Resolve relative paths against the primary path by default and address the additional paths by their absolute paths. Reading across them is unrestricted; writing outside the session workspace depends on the current DSH file policy (see the sandbox policy line).",
  );
  return lines.join("\n");
}

/** Folder-name part of an absolute path, used as the fallback project name. */
function baseName(p) {
  const parts = String(p).split(/[\\/]+/).filter((part) => part.length > 0);
  const last = parts.length > 0 ? parts[parts.length - 1] : "";
  return last.length > 0 ? last : String(p);
}

// ---- browser transport helpers (same-origin routes, no framework) ----------

/** Cap on an accepted request body; the settings payload is tiny. */
const MAX_BODY_BYTES = 65536;

/** Write a JSON response with no caching. */
function sendJson(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

/**
 * Read a JSON request body, counting bytes (multi-byte characters can split
 * across chunks when a string decoder is used).
 * @returns {Promise<string>} the raw body text.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (typeof req.pause === "function") req.pause();
      reject(error);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error("request body too large");
        error.code = "BODY_TOO_LARGE";
        fail(error);
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => fail(error));
    req.on("aborted", () => fail(new Error("request aborted")));
  });
}

/** Parse a JSON body, tolerating an empty body. */
async function readJson(req) {
  const text = await readBody(req);
  if (text.trim().length === 0) return {};
  const value = JSON.parse(text);
  return value && typeof value === "object" ? value : {};
}

/**
 * Same-origin gate for browser-facing routes: reject `sec-fetch-site:
 * cross-site`, and when an Origin header is present require it to match the
 * request Host. Requests without Origin (same-origin fetch, local tooling) pass.
 */
function sameOrigin(req) {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Raw JSON-Schema output contract shared by every tool (unconstrained object). */
const OUTPUT_SCHEMA = { type: "object", additionalProperties: true, description: "JSON result value." };
const render = (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }];

/**
 * Host entry point: build the durable project registry, expose the active
 * project to the model, and register the management tools.
 * @param ctx - plugin context carrying `tools`, `systemPrompt`, `workingDirectory`.
 */
export function apply(ctx) {
  // ---- durable state (in-memory authoritative, JSON persisted) -------------
  let projects = [];
  try {
    const raw = readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.projects)) projects = parsed.projects.filter(isValidProject).map(normalizeProject);
  } catch (error) {
    if (error && error.code !== "ENOENT") ctx.logger?.warn?.(`workspace-plus: could not read ${DATA_FILE}: ${String(error)}`);
  }

  let writeChain = Promise.resolve();
  function persist() {
    const snapshot = JSON.stringify({ version: 1, projects }, null, 2);
    writeChain = writeChain
      .then(() => {
        mkdirSync(DATA_DIR, { recursive: true });
        const tmp = `${DATA_FILE}.tmp`;
        writeFileSync(tmp, snapshot, "utf8");
        renameSync(tmp, DATA_FILE);
      })
      .catch((error) => {
        ctx.logger?.warn?.(`workspace-plus: failed to persist projects: ${String(error)}`);
      });
    return writeChain;
  }

  const sortProjects = () =>
    [...projects].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  const requireProject = (id) => {
    const project = projects.find((p) => p.id === id);
    if (!project) throw new OpError("project_not_found", `no project with id ${JSON.stringify(id)}.`);
    return project;
  };
  /** The project anchored at a given primary path, if any (case-insensitive on win32). */
  const projectForPath = (p) => projects.find((project) => pathKey(project.primaryPath) === pathKey(p));
  /** Normalize, de-duplicate, and drop any entry that repeats the primary path. */
  const collectSecondary = (list, primary, cwd) => {
    const seen = new Set([pathKey(primary)]);
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      if (typeof raw !== "string" || raw.trim().length === 0) continue;
      const resolved = normalizePath(raw.trim(), cwd);
      const key = pathKey(resolved);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(resolved);
    }
    return out;
  };

  // ---- operations (single owner of project state) --------------------------
  const ops = {
    list() {
      return { projects: sortProjects().map(cloneProject) };
    },
    active(cwd) {
      const project = activeFor(projects, cwd);
      return { cwd: cwd ?? null, project: project ? cloneProject(project) : null };
    },
    create({ name, primaryPath, secondaryPaths, cwd }) {
      const cleanName = typeof name === "string" ? name.trim() : "";
      if (cleanName.length === 0) throw new OpError("invalid_name", "name is required and must be non-empty.");
      if (typeof primaryPath !== "string" || primaryPath.trim().length === 0) throw new OpError("invalid_path", "primary_path is required.");
      const primary = normalizePath(primaryPath.trim(), cwd);
      const seen = new Set([pathKey(primary)]);
      const secondary = [];
      for (const raw of Array.isArray(secondaryPaths) ? secondaryPaths : []) {
        if (typeof raw !== "string" || raw.trim().length === 0) continue;
        const key = pathKey(raw.trim());
        if (seen.has(key)) continue;
        seen.add(key);
        secondary.push(normalizePath(raw.trim(), cwd));
      }
      const now = Date.now();
      const project = { id: randomUUID(), name: cleanName, primaryPath: primary, secondaryPaths: secondary, pinned: false, createdAt: now, updatedAt: now };
      projects.push(project);
      void persist();
      return { project: cloneProject(project) };
    },
    addPath({ id, path, cwd }) {
      const project = requireProject(id);
      if (typeof path !== "string" || path.trim().length === 0) throw new OpError("invalid_path", "path is required.");
      const target = normalizePath(path.trim(), cwd);
      const key = pathKey(target);
      if (key === pathKey(project.primaryPath)) throw new OpError("already_primary", "path is already the primary path.");
      if (project.secondaryPaths.some((p) => pathKey(p) === key)) return { project: cloneProject(project) };
      project.secondaryPaths.push(target);
      project.updatedAt = Date.now();
      void persist();
      return { project: cloneProject(project) };
    },
    removePath({ id, path, cwd }) {
      const project = requireProject(id);
      const key = pathKey(normalizePath(String(path ?? "").trim(), cwd));
      const before = project.secondaryPaths.length;
      project.secondaryPaths = project.secondaryPaths.filter((p) => pathKey(p) !== key);
      if (project.secondaryPaths.length === before) throw new OpError("path_not_found", "path is not a secondary path of this project.");
      project.updatedAt = Date.now();
      void persist();
      return { project: cloneProject(project) };
    },
    setPrimary({ id, path, cwd }) {
      const project = requireProject(id);
      if (typeof path !== "string" || path.trim().length === 0) throw new OpError("invalid_path", "path is required.");
      const target = normalizePath(path.trim(), cwd);
      const key = pathKey(target);
      if (key === pathKey(project.primaryPath)) return { project: cloneProject(project) };
      const idx = project.secondaryPaths.findIndex((p) => pathKey(p) === key);
      if (idx < 0) throw new OpError("path_not_found", "path is neither the primary nor a secondary path of this project.");
      const oldPrimary = project.primaryPath;
      project.secondaryPaths.splice(idx, 1);
      project.secondaryPaths.push(oldPrimary);
      project.primaryPath = target;
      project.updatedAt = Date.now();
      void persist();
      return { project: cloneProject(project) };
    },
    setPinned({ id, pinned }) {
      const project = requireProject(id);
      project.pinned = Boolean(pinned);
      project.updatedAt = Date.now();
      void persist();
      return { project: cloneProject(project) };
    },
    remove({ id }) {
      const idx = projects.findIndex((p) => p.id === id);
      if (idx < 0) return { id, deleted: false };
      projects.splice(idx, 1);
      void persist();
      return { id, deleted: true };
    },
    /**
     * Rename a project. The name is a free-form label: it never touches the
     * primary folder, whose on-disk name is not ours to change.
     */
    rename({ id, name }) {
      const project = requireProject(id);
      const cleanName = typeof name === "string" ? name.trim() : "";
      if (cleanName.length === 0) throw new OpError("invalid_name", "name is required and must be non-empty.");
      if (cleanName !== project.name) {
        project.name = cleanName;
        project.updatedAt = Date.now();
        void persist();
      }
      return { project: cloneProject(project) };
    },
    /** Replace the whole supported-directory set in one write. */
    setPaths({ id, secondaryPaths, cwd }) {
      const project = requireProject(id);
      project.secondaryPaths = collectSecondary(secondaryPaths, project.primaryPath, cwd);
      project.updatedAt = Date.now();
      void persist();
      return { project: cloneProject(project) };
    },
    /**
     * Create-or-update the project anchored at `path` (one atomic write).
     * Used by the workspace settings dialog, whose subject is a native
     * Workspace identified by its path, not a project id.
     */
    saveForPath({ path, name, secondaryPaths, cwd }) {
      if (typeof path !== "string" || path.trim().length === 0) throw new OpError("invalid_path", "path is required.");
      const primary = normalizePath(path.trim(), cwd);
      const cleanName = (typeof name === "string" ? name.trim() : "") || baseName(primary);
      const wanted = collectSecondary(secondaryPaths, primary, cwd);
      let project = projectForPath(primary);
      const created = project === undefined;
      if (created) {
        const now = Date.now();
        project = { id: randomUUID(), name: cleanName, primaryPath: primary, secondaryPaths: wanted, pinned: false, createdAt: now, updatedAt: now };
        projects.push(project);
      } else {
        project.name = cleanName;
        project.secondaryPaths = wanted;
        project.updatedAt = Date.now();
      }
      void persist();
      return { project: cloneProject(project), created };
    },
  };

  // ---- system-prompt runtime context ---------------------------------------
  ctx.systemPrompt.context({
    name: "workspace-plus:project",
    order: CONTEXT_ORDER,
    required: false,
    text: (context) => {
      try {
        const session = context.agent?.session;
        if (!session) return "";
        const cwd = ctx.workingDirectory.get(session);
        const project = activeFor(projects, cwd);
        return project ? renderProjectContext(project) : "";
      } catch (error) {
        ctx.logger?.warn?.(`workspace-plus: context render failed: ${String(error)}`);
        return "";
      }
    },
  });

  // ---- model-facing tools ---------------------------------------------------
  const cwdOf = (agent) => {
    if (!agent) return void 0;
    try {
      return ctx.workingDirectory.get(agent.session);
    } catch {
      return void 0;
    }
  };
  const guard = (fn) => async (args, exec) => {
    try {
      return await fn(args, exec);
    } catch (error) {
      if (error instanceof OpError) return { code: error.code, message: error.message };
      return { code: "internal_error", message: `WorkSpacePlus operation failed: ${String(error?.message ?? error)}` };
    }
  };
  const register = (def) => ctx.tools.register({ ...def, output: { schema: OUTPUT_SCHEMA, render } });

  register({
    name: "project_list",
    description:
      "List WorkSpacePlus projects. Each project has one primary path and zero or more secondary paths that together form one logical workspace. Returns id, name, primaryPath, secondaryPaths, and pinned for each project, pinned first.",
    parameters: { type: "object", properties: {} },
    execute: guard(async () => ops.list()),
  });

  register({
    name: "project_active",
    description:
      "Show the WorkSpacePlus project active for the current session, derived from the session's working directory. Returns the matching project (with its primary and secondary paths), or a null project when the working directory is not inside any project.",
    parameters: { type: "object", properties: {} },
    execute: guard(async (_args, exec) => ops.active(cwdOf(exec.agent))),
  });

  register({
    name: "project_create",
    description:
      "Create a WorkSpacePlus project with one primary path and optional secondary paths. Paths may be absolute or relative to the current working directory. Returns the created project.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable project name." },
        primary_path: { type: "string", description: "Absolute or cwd-relative primary directory path." },
        secondary_paths: { type: "array", items: { type: "string" }, description: "Optional additional directories that belong to the same project." },
      },
      required: ["name", "primary_path"],
    },
    execute: guard(async (args, exec) =>
      ops.create({ name: args.name, primaryPath: args.primary_path, secondaryPaths: args.secondary_paths, cwd: cwdOf(exec.agent) })),
  });

  register({
    name: "project_add_path",
    description: "Add a secondary path to an existing WorkSpacePlus project. The path must not already be the primary path. Returns the updated project.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Project id from project_list." },
        path: { type: "string", description: "Absolute or cwd-relative directory path to add." },
      },
      required: ["id", "path"],
    },
    execute: guard(async (args, exec) => ops.addPath({ ...args, cwd: cwdOf(exec.agent) })),
  });

  register({
    name: "project_remove_path",
    description: "Remove a secondary path from a WorkSpacePlus project. The primary path cannot be removed (use project_set_primary first). Returns the updated project.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Project id from project_list." },
        path: { type: "string", description: "Secondary directory path to remove." },
      },
      required: ["id", "path"],
    },
    execute: guard(async (args, exec) => ops.removePath({ ...args, cwd: cwdOf(exec.agent) })),
  });

  register({
    name: "project_set_primary",
    description:
      "Change a project's primary path. The path must already be the primary or one of the secondary paths; the previous primary path becomes a secondary path. Returns the updated project.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Project id from project_list." },
        path: { type: "string", description: "Existing primary or secondary path to promote." },
      },
      required: ["id", "path"],
    },
    execute: guard(async (args, exec) => ops.setPrimary({ ...args, cwd: cwdOf(exec.agent) })),
  });

  register({
    name: "project_set_pinned",
    description: "Pin or unpin a WorkSpacePlus project. Pinned projects sort first in project_list. Returns the updated project.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Project id from project_list." },
        pinned: { type: "boolean", description: "Whether the project is pinned." },
      },
      required: ["id", "pinned"],
    },
    execute: guard(async (args) => ops.setPinned(args)),
  });

  register({
    name: "project_rename",
    description:
      "Rename a WorkSpacePlus project. The name is a free-form label for the model-visible project; it never renames or relocates the primary folder on disk. Returns the updated project.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Project id from project_list." },
        name: { type: "string", description: "New non-empty project name." },
      },
      required: ["id", "name"],
    },
    execute: guard(async (args) => ops.rename({ id: args.id, name: args.name })),
  });

  register({
    name: "project_delete",
    description: "Delete a WorkSpacePlus project by id. Deleting only removes the project grouping; it never touches files on disk. Returns { id, deleted }.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Project id from project_list." } },
      required: ["id"],
    },
    execute: guard(async (args) => ops.remove(args)),
  });

  // ---- native Workspace bridge --------------------------------------------
  //
  // The sidebar lists native Workspaces (id + path + title), which are not
  // projects: a project is this plugin's grouping of one primary path plus
  // supported directories. The settings dialog therefore speaks "workspace",
  // and this section maps it onto both sides:
  //   璺?title  閳?the native Workspace title (free-form label; the folder name
  //              is never touched 閳?`workspaceController.rename` only calls
  //              `setTitle`, and the Host never renames a directory);
  //   璺?name / supported directories 閳?the project anchored at that path,
  //              created on first save.
  //
  // Services are read lazily: `workspaceRegistry` / `workspaceController` /
  // `directoryPickerController` only exist in a browser Host, and the project
  // tools must keep working without them.
  //
  // A bare `ctx[name]` cannot see these: cordis resolves an undeclared service
  // by walking the fiber's *ancestor* chain (reflect.ts, the context get trap),
  // and every one of them is provided by a sibling plugin fiber, so the walk
  // ends in a throw that used to be swallowed into `undefined`. `ctx.inject`
  // creates a real child fiber with the dependency committed, which is the only
  // supported way to read a sibling-provided service.
  const serviceCache = Object.create(null);
  const trackService = (name) => {
    if (typeof ctx.inject !== "function") return;
    try {
      const fiber = ctx.inject([name], (host) => {
        let value;
        try {
          value = host && typeof host.get === "function" ? host.get(name) : host ? host[name] : void 0;
        } catch {
          value = void 0;
        }
        if (value === void 0 || value === null) return;
        serviceCache[name] = value;
        if (typeof host.effect === "function") {
          host.effect(() => () => {
            if (serviceCache[name] === value) serviceCache[name] = void 0;
          }, `workspace-plus: ${name}`);
        }
      });
      if (fiber && typeof fiber.dispose === "function") {
        ctx.effect(() => () => void fiber.dispose(), `workspace-plus: track ${name}`);
      }
    } catch (error) {
      ctx.logger?.warn?.(`workspace-plus: cannot track service ${name}: ${String(error)}`);
    }
  };
  for (const name of ["workspaceRegistry", "workspaceController", "directoryPickerController", "clientModules", "webServer"]) {
    trackService(name);
  }
  const svc = (name) => {
    const cached = serviceCache[name];
    if (cached !== void 0 && cached !== null) return cached;
    try {
      return ctx[name] ?? void 0;
    } catch {
      return void 0;
    }
  };
  const nativeList = () => {
    const registry = svc("workspaceRegistry");
    if (!registry || typeof registry.list !== "function") return null;
    try {
      return registry.list().map((workspace) => ({ workspaceId: workspace.id, path: workspace.path, title: workspace.title }));
    } catch (error) {
      ctx.logger?.warn?.(`workspace-plus: workspace registry list failed: ${String(error)}`);
      return null;
    }
  };
  const nativeGet = (id) => {
    const list = nativeList();
    return list === null ? null : list.find((workspace) => workspace.workspaceId === id) ?? null;
  };
  const renameNative = async (workspaceId, title) => {
    const controller = svc("workspaceController");
    if (!controller || typeof controller.rename !== "function") {
      throw new OpError("workspace_unavailable", "this Host has no workspace controller to rename through.");
    }
    try {
      await controller.rename({ workspaceId, title });
    } catch (error) {
      // A blank or already-taken title is a user mistake, not a Host fault.
      throw new OpError("workspace_rename_failed", String(error && error.message ? error.message : error));
    }
  };
  const describeWorkspace = (workspace) => {
    const project = projectForPath(workspace.path);
    return { ...workspace, projectId: project ? project.id : null };
  };
  const pickerAvailable = () => {
    const controller = svc("directoryPickerController");
    return Boolean(controller && typeof controller.pick === "function");
  };

  const ROUTE_BASE = "/workspace-plus";
  const routeTrace = [];
  // The desktop host creates `webServer` after the plugin tree applies, so a plain
  // property read at apply time always sees nothing. A setTimeout poll only papers
  // over that for as long as its window lasts: miss the window and every route is
  // dropped for the life of the process while the entry still reports "active".
  // `ctx.inject` is the reactive form — it runs the callback when the service
  // appears (immediately when it is already there) and disposes it with the scope.
  const withWebServer = (callback) => {
    if (typeof ctx.inject === "function") {
      ctx.inject(["webServer"], (webCtx) => {
        const webServer = typeof webCtx.get === "function" ? webCtx.get("webServer") : webCtx.webServer;
        callback(webServer, webCtx);
      });
      return;
    }
    // Older runtimes without ctx.inject: keep the polling fallback.
    const install = () => {
      let disposed = false;
      let timer = null;
      const attempt = (remaining) => {
        if (disposed) return;
        const webServer = svc("webServer");
        if (!webServer || typeof webServer.register !== "function") {
          if (remaining > 0) {
            timer = setTimeout(() => attempt(remaining - 1), 250);
            return;
          }
          return;
        }
        callback(webServer, ctx);
      };
      attempt(20);
      return () => {
        disposed = true;
        if (timer !== null) clearTimeout(timer);
      };
    };
    try {
      if (typeof ctx.effect === "function") ctx.effect(install, "workspace-plus: webServer");
      else install();
    } catch (error) {
      routeTrace.push({ path: "*", ok: false, error: `inject: ${String(error && error.message ? error.message : error)}` });
    }
  };

  const registerRoute = (label, path, handler) => {
    withWebServer((webServer, host) => {
      if (!webServer || typeof webServer.register !== "function") {
        routeTrace.push({ path, ok: false, error: "webServer unavailable" });
        return;
      }
      const install = () => {
        let disposed = false;
        let unregister = null;
        let timer = null;
        const attempt = (remaining) => {
          if (disposed) return;
          try {
            unregister = webServer.register({ kind: "exact", path, handler });
            routeTrace.push({ path, ok: true });
          } catch (error) {
            const message = String(error && error.message ? error.message : error);
            // A live patch reload builds the new entry before disposing the old
            // one, so the path is briefly still taken; retry on the next tick.
            if (remaining > 0 && /duplicate .*route/i.test(message)) {
              timer = setTimeout(() => attempt(remaining - 1), 250);
              return;
            }
            routeTrace.push({ path, ok: false, error: message });
            ctx.logger?.warn?.(`workspace-plus: route ${path} registration failed: ${message}`);
          }
        };
        attempt(20);
        return () => {
          disposed = true;
          if (timer !== null) clearTimeout(timer);
          if (unregister !== null) unregister();
        };
      };
      const scope = host && typeof host.effect === "function" ? host : ctx;
      try {
        if (typeof scope.effect === "function") scope.effect(install, label);
        else install();
      } catch (error) {
        routeTrace.push({ path, ok: false, error: `effect: ${String(error && error.message ? error.message : error)}` });
      }
    });
  };
  const guardRoute = (handler) => (req, res) => {
    try {
      handler(req, res);
    } catch (error) {
      sendJson(res, 500, { error: "internal_error", message: String(error && error.message ? error.message : error) });
    }
  };

  registerRoute("workspace-plus: list", `${ROUTE_BASE}/list`, guardRoute((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method_not_allowed" });
    if (!sameOrigin(req)) return sendJson(res, 403, { error: "forbidden" });
    const workspaces = nativeList();
    sendJson(res, 200, {
      projects: sortProjects().map(cloneProject),
      workspaces: workspaces === null ? null : workspaces.map(describeWorkspace),
      picker: pickerAvailable(),
    });
  }));

  registerRoute("workspace-plus: workspace", `${ROUTE_BASE}/workspace`, guardRoute((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method_not_allowed" });
    if (!sameOrigin(req)) return sendJson(res, 403, { error: "forbidden" });
    const url = new URL(req.url ?? `${ROUTE_BASE}/workspace`, "http://localhost");
    const workspaceId = url.searchParams.get("workspaceId") ?? "";
    const projectId = url.searchParams.get("projectId") ?? "";
    if (workspaceId) {
      const workspace = nativeGet(workspaceId);
      if (!workspace) return sendJson(res, 404, { error: "workspace_not_found", workspaceId });
      const project = projectForPath(workspace.path);
      return sendJson(res, 200, {
        workspace: describeWorkspace(workspace),
        project: project ? cloneProject(project) : null,
        picker: pickerAvailable(),
      });
    }
    if (projectId) {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) return sendJson(res, 404, { error: "project_not_found", projectId });
      return sendJson(res, 200, { workspace: null, project: cloneProject(project), picker: pickerAvailable() });
    }
    sendJson(res, 400, { error: "missing_target", message: "workspaceId or projectId is required." });
  }));

  registerRoute("workspace-plus: save", `${ROUTE_BASE}/save`, guardRoute((req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
    if (!sameOrigin(req)) return sendJson(res, 403, { error: "forbidden" });
    readJson(req)
      .then(async (body) => {
        const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
        const projectId = typeof body.projectId === "string" ? body.projectId : "";
        const title = typeof body.title === "string" ? body.title.trim() : "";
        const bodyName = typeof body.name === "string" ? body.name.trim() : "";
        const secondaryPaths = Array.isArray(body.secondaryPaths) ? body.secondaryPaths : [];
        let workspace = null;
        if (workspaceId) {
          workspace = nativeGet(workspaceId);
          if (!workspace) return sendJson(res, 404, { error: "workspace_not_found", workspaceId });
        }
        // The native title is the sidebar label, so it is written first and the
        // project name follows it; a failed rename aborts before any write.
        if (workspace && title && title !== workspace.title) {
          await renameNative(workspace.workspaceId, title);
          workspace = nativeGet(workspaceId) ?? { ...workspace, title };
        }
        const name = title || bodyName;
        let saved;
        if (workspace) {
          saved = ops.saveForPath({ path: workspace.path, name, secondaryPaths });
        } else if (projectId) {
          const project = requireProject(projectId);
          ops.setPaths({ id: projectId, secondaryPaths });
          const renamed = name ? ops.rename({ id: projectId, name }) : { project: cloneProject(project) };
          saved = { project: renamed.project, created: false };
        } else if (typeof body.path === "string" && body.path.trim().length > 0) {
          // Path-only targeting: create-or-update the project anchored there.
          saved = ops.saveForPath({ path: body.path, name, secondaryPaths });
        } else {
          return sendJson(res, 400, { error: "missing_target", message: "workspaceId, projectId or path is required." });
        }
        sendJson(res, 200, {
          workspace: workspace ? describeWorkspace(workspace) : null,
          project: saved.project,
          created: saved.created === true,
          projects: sortProjects().map(cloneProject),
        });
      })
      .catch((error) => {
        if (error instanceof OpError) return sendJson(res, 400, { error: error.code, message: error.message });
        sendJson(res, 500, { error: "internal_error", message: String(error && error.message ? error.message : error) });
      });
  }));

  registerRoute("workspace-plus: pick", `${ROUTE_BASE}/pick`, guardRoute((req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
    if (!sameOrigin(req)) return sendJson(res, 403, { error: "forbidden" });
    readJson(req)
      .catch(() => ({}))
      .then(async () => {
        const controller = svc("directoryPickerController");
        if (!controller || typeof controller.pick !== "function") {
          return sendJson(res, 501, { error: "picker_unavailable", message: "this Host has no native directory picker." });
        }
        try {
          const picked = await controller.pick(new AbortController().signal);
          sendJson(res, 200, { path: typeof picked === "string" ? picked : null });
        } catch (error) {
          sendJson(res, 200, { path: null, error: String(error && error.message ? error.message : error) });
        }
      });
  }));

  // Read-only self report: which Host faces this profile actually exposes, and
  // whether the Web half of this very package made it into the boot graph. It
  // exists because "the menu entry is missing" has several unrelated causes
  // (no client bundle in the graph, no picker, no registry) that look
  // identical from inside the browser.
  registerRoute("workspace-plus: diag", `${ROUTE_BASE}/diag`, guardRoute((req, res) => {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
    if (!sameOrigin(req)) return sendJson(res, 403, { error: "forbidden" });
    let clientEntry = null;
    let clientError = null;
    let clientIds = null;
    let clientRev = null;
    try {
      const clientModules = svc("clientModules");
      const graph = clientModules && typeof clientModules.graph === "function" ? clientModules.graph() : null;
      const entries = graph && Array.isArray(graph.entries) ? graph.entries : [];
      clientIds = entries.map((candidate) => candidate.id);
      clientRev = graph && typeof graph.rev === "string" ? graph.rev : null;
      const entry = entries.find((candidate) => /workspace-plus$/.test(String(candidate.id)));
      clientEntry = entry ? { id: entry.id, url: entry.url, inject: entry.inject ?? null, immediately: entry.immediately ?? null } : null;
    } catch (error) {
      clientError = String(error && error.message ? error.message : error);
    }
    sendJson(res, 200, {
      version: "1.1.0",
      routes: routeTrace,
      webServerRegister: typeof (svc("webServer") || {}).register,
      effect: typeof ctx.effect,
      clientEntry,
      clientError,
      clientIds,
      clientRev,
      workspaceRegistry: Boolean(svc("workspaceRegistry")),
      workspaceController: Boolean(svc("workspaceController")),
      directoryPickerController: Boolean(svc("directoryPickerController")),
      projects: sortProjects().length,
    });
  }));
}


