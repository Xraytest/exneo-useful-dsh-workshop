import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

// Point plugin storage at a throwaway home BEFORE importing the module
// (the module resolves DATA_FILE from process.env.DSH_HOME at import time).
const home = mkdtempSync(join(tmpdir(), "wsp-test-"));
process.env.DSH_HOME = home;

const mod = await import("./index.js");

const tools = new Map();
const contexts = [];
const routes = new Map();
const mockCtx = {
  logger: { warn: (...a) => console.log("  [warn]", ...a) },
  tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name); } },
  systemPrompt: { context: (c) => { contexts.push(c); return () => {}; } },
  workingDirectory: { get: (session) => session.cwd },
  // No workspaceRegistry / workspaceController / directoryPickerController in
  // this mock on purpose: the routes must degrade, not throw.
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
};

mod.apply(mockCtx);

const call = (name, args, session) => tools.get(name).execute(args, { agent: { session }, signal: new AbortController().signal });
const sess = (cwd) => ({ id: "s1", cwd });

// ---- HTTP route harness (mock req/res, real handler code) -----------------
const makeReq = ({ method = "GET", url = "/", body, headers = {} } = {}) => {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.pause = () => {};
  setTimeout(() => {
    if (body !== undefined) req.emit("data", Buffer.from(body, "utf8"));
    req.emit("end");
  }, 0);
  return req;
};
const makeRes = () => {
  const res = new EventEmitter();
  res.status = 0;
  res.headers = {};
  res.body = "";
  res.finished = false;
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers || {}; };
  res.end = (chunk) => {
    if (chunk !== undefined) res.body += String(chunk);
    res.finished = true;
    res.emit("finish");
  };
  return res;
};
const route = async (method, path, options = {}) => {
  const handler = routes.get(path.split("?")[0]);
  if (!handler) throw new Error(`no route for ${path}`);
  const req = makeReq({ method, url: path, body: options.body, headers: options.headers });
  const res = makeRes();
  const finished = new Promise((resolve) => { if (res.finished) resolve(); else res.once("finish", resolve); });
  handler(req, res);
  await finished;
  let json = null;
  try { json = res.body.length > 0 ? JSON.parse(res.body) : null; } catch { json = { raw: res.body }; }
  return { status: res.status, json };
};

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log("  ok  -", label); } else { fail++; console.log("  FAIL-", label); } };

console.log("== registered tools ==", [...tools.keys()].sort().join(", "));
console.log("== registered contexts ==", contexts.map((c) => c.name).join(", "));

// 1. create a project anchored at D:\WorkSpace with two secondary paths
const created = await call("project_create", {
  name: "WorkSpace",
  primary_path: "D:\\WorkSpace",
  secondary_paths: ["D:\\WorkSpace\\mathbook", "d:/workplace/live2d_project"], // mixed case + slash to test normalization
}, sess("D:\\WorkSpace\\_tmp"));
const id = created.project?.id;
console.log("CREATE_RAW=" + JSON.stringify(created));
check("create returns id", typeof id === "string" && id.length > 0);
check("primary normalized", created.project.primaryPath.endsWith("WorkSpace"));
check("secondary dedup/normalize (2)", created.project.secondaryPaths.length === 2);

// 2. active project derived from cwd inside primary
const active = await call("project_active", {}, sess("D:\\WorkSpace\\mathbook\\src"));
console.log("active ->", JSON.stringify(active));
check("active matches project by cwd", active.project && active.project.id === id);

// 3. active is null when cwd is outside every project
const none = await call("project_active", {}, sess("C:\\Windows"));
check("active null outside project", none.project === null);

// 4. add a relative secondary path (resolved against cwd)
const added = await call("project_add_path", { id, path: "glb_illustrator" }, sess("D:\\WorkSpace"));
check("add relative path resolved", added.project.secondaryPaths.some((p) => p.replace(/\\/g, "/").endsWith("/glb_illustrator")));

// 5. add duplicate secondary is idempotent
const dup = await call("project_add_path", { id, path: "D:\\WorkSpace\\mathbook" }, sess("D:\\WorkSpace"));
check("add duplicate idempotent", dup.project.secondaryPaths.filter((p) => p.replace(/\\/g, "/").endsWith("/mathbook")).length === 1);

// 6. add path equal to primary -> error
const eq = await call("project_add_path", { id, path: "D:\\WorkSpace" }, sess("D:\\WorkSpace"));
check("add primary-as-secondary rejected", eq.code === "already_primary");

// 7. set primary to a secondary; old primary becomes secondary
const sp = await call("project_set_primary", { id, path: "D:\\WorkSpace\\mathbook" }, sess("D:\\WorkSpace"));
check("set_primary swaps", sp.project.primaryPath.replace(/\\/g, "/").endsWith("/mathbook") && sp.project.secondaryPaths.some((p) => p.replace(/\\/g, "/").endsWith("/WorkSpace")));

// 8. remove a secondary path
const rm = await call("project_remove_path", { id, path: "D:\\WorkSpace\\mathbook\\nope" }, sess("D:\\WorkSpace"));
check("remove nonexistent secondary -> path_not_found", rm.code === "path_not_found");

// 9. list + pinned sort
await call("project_set_pinned", { id, pinned: true }, sess("D:\\WorkSpace"));
const list = await call("project_list", {}, sess("D:\\WorkSpace"));
check("list returns projects array", Array.isArray(list.projects) && list.projects.length === 1 && list.projects[0].pinned === true);

// 10. unknown id error
const nf = await call("project_add_path", { id: "nope", path: "D:\\x" }, sess("D:\\WorkSpace"));
check("unknown project -> project_not_found", nf.code === "project_not_found");

// 11. persistence file written and parseable
const dataFile = join(home, "workspace-plus", "projects.json");
check("persisted file exists", existsSync(dataFile));
const onDisk = JSON.parse(readFileSync(dataFile, "utf8"));
check("persisted has 1 project", onDisk.projects.length === 1 && onDisk.projects[0].name === "WorkSpace");

// 12. system-prompt context renders non-empty for a session inside the project
const ctxText = contexts[0].text({ agent: { session: sess("D:\\WorkSpace\\mathbook") } });
console.log("---- context text ----\n" + ctxText + "\n----------------------");
check("context renders project block", typeof ctxText === "string" && ctxText.includes("Active project") && ctxText.includes("Primary path"));
const ctxEmpty = contexts[0].text({ agent: { session: sess("C:\\Windows") } });
check("context empty outside project", ctxEmpty === "");

// 13. delete
const del = await call("project_delete", { id }, sess("D:\\WorkSpace"));
check("delete ok", del.deleted === true);
const list2 = await call("project_list", {}, sess("D:\\WorkSpace"));
check("list empty after delete", list2.projects.length === 0);

// ---- workspace settings surface -------------------------------------------

// 14. rename is a free-form label and never touches paths
const created2 = await call("project_create", { name: "old", primary_path: "D:\\WorkSpace" }, sess("D:\\WorkSpace"));
const renamed = await call("project_rename", { id: created2.project.id, name: "  鏁板璇剧▼  " }, sess("D:\\WorkSpace"));
check("rename trims and applies", renamed.project.name === "鏁板璇剧▼");
check("rename keeps primary path", renamed.project.primaryPath === created2.project.primaryPath);
check("rename keeps secondary paths", renamed.project.secondaryPaths.length === created2.project.secondaryPaths.length);
const blank = await call("project_rename", { id: created2.project.id, name: "   " }, sess("D:\\WorkSpace"));
check("rename blank -> invalid_name", blank.code === "invalid_name");
const renamedUnknown = await call("project_rename", { id: "nope", name: "x" }, sess("D:\\WorkSpace"));
check("rename unknown -> project_not_found", renamedUnknown.code === "project_not_found");

// 15. all four routes registered
check("routes registered", ["/workspace-plus/list", "/workspace-plus/workspace", "/workspace-plus/save", "/workspace-plus/pick"].every((p) => routes.has(p)));

// 16. GET /list degrades without a workspace registry
const listRes = await route("GET", "/workspace-plus/list");
check("list route 200", listRes.status === 200 && Array.isArray(listRes.json.projects));
check("list route workspaces null without registry", listRes.json.workspaces === null);
check("list route reports picker availability", listRes.json.picker === false);

// 17. same-origin gate
const cross = await route("GET", "/workspace-plus/list", { headers: { "sec-fetch-site": "cross-site" } });
check("cross-site -> 403", cross.status === 403);
const sameOriginRes = await route("GET", "/workspace-plus/list", { headers: { origin: "http://127.0.0.1:1", host: "127.0.0.1:1" } });
check("same-origin with matching host passes", sameOriginRes.status === 200);

// 18. POST /save creates a project anchored at a path
const saved1 = await route("POST", "/workspace-plus/save", {
  body: JSON.stringify({
    path: "D:\\WorkSpace\\mathbook",
    name: "鏁板璇剧▼",
    secondaryPaths: ["D:\\WorkSpace\\mathbook\\src", "D:\\WorkSpace\\mathbook", "d:/workplace/live2d_project/"],
  }),
});
check("save route 200 + created", saved1.status === 200 && saved1.json.created === true);
check("save drops primary from supported dirs", saved1.json.project.secondaryPaths.length === 2);
check("save keeps the workspace path as primary", saved1.json.project.primaryPath.replace(/\\/g, "/").endsWith("/mathbook"));
check("save route returns the full list", Array.isArray(saved1.json.projects) && saved1.json.projects.length === 2);

// 19. POST /save updates in place on a case/slash variant of the same path
const saved2 = await route("POST", "/workspace-plus/save", {
  body: JSON.stringify({ path: "d:/workspace/mathbook", name: "鏁板璇剧▼ v2", secondaryPaths: [] }),
});
check("save updates instead of duplicating", saved2.json.created === false && saved2.json.project.id === saved1.json.project.id);
check("save replaces the supported-dir set", saved2.json.project.secondaryPaths.length === 0 && saved2.json.project.name === "鏁板璇剧▼ v2");

// 20. GET /workspace resolves both target kinds
const unknownWorkspace = await route("GET", "/workspace-plus/workspace?workspaceId=w1");
check("unknown workspace -> 404", unknownWorkspace.status === 404 && unknownWorkspace.json.error === "workspace_not_found");
const byProject = await route("GET", `/workspace-plus/workspace?projectId=${saved1.json.project.id}`);
check("workspace route by projectId", byProject.status === 200 && byProject.json.project.name === "鏁板璇剧▼ v2");
const missingTarget = await route("GET", "/workspace-plus/workspace");
check("workspace route without target -> 400", missingTarget.status === 400 && missingTarget.json.error === "missing_target");

// 21. POST /pick degrades without a native picker
const pick = await route("POST", "/workspace-plus/pick", { body: "{}" });
check("pick without controller -> 501", pick.status === 501 && pick.json.error === "picker_unavailable");

// 22. method + bad-body handling
const wrongMethod = await route("GET", "/workspace-plus/save");
check("save GET -> 405", wrongMethod.status === 405);
const badBody = await route("POST", "/workspace-plus/save", { body: "{not json" });
check("bad body -> 500 with message", badBody.status === 500 && typeof badBody.json.message === "string");

// 23. the rename made it to disk
const onDisk2 = JSON.parse(readFileSync(dataFile, "utf8"));
check("persisted rename", onDisk2.projects.some((p) => p.name === "鏁板璇剧▼ v2"));

// 24. regression: routes must survive a webServer that appears AFTER apply.
// The desktop host creates `webServer` once the plugin tree has applied, so a
// bare svc('webServer') read at apply time sees nothing and — with a polling
// window that expires first — silently drops every route for the life of the
// process while the entry still reports fiberPhase "active". This is the shape
// that produced live 404s on /workspace-plus/diag next to a healthy
// /dsh-admin-channel/status (that plugin uses ctx.inject).
const lateRoutes = new Map();
const webServerCallbacks = [];
const lateCtx = {
  logger: { warn: (...a) => console.log("  [warn]", ...a) },
  tools: { register: () => () => {} },
  systemPrompt: { context: () => () => {} },
  workingDirectory: { get: (session) => session.cwd },
  effect: (callback) => { const d = callback(); return typeof d === "function" ? d : () => {}; },
  on: () => () => {},
  // cordis reactive injection: one callback per ctx.inject call, each run only
  // once the service exists.
  inject: (deps, callback) => { if (deps.includes("webServer")) webServerCallbacks.push(callback); },
  // deliberately no webServer: exactly the desktop-host ordering
};
mod.apply(lateCtx);
check("no routes are registered before webServer exists", lateRoutes.size === 0);
check("apply subscribes to webServer reactively", webServerCallbacks.length > 0);
if (webServerCallbacks.length > 0) {
  const lateServer = {
    register: (r) => { lateRoutes.set(r.path, r.handler); return () => lateRoutes.delete(r.path); },
  };
  for (const callback of webServerCallbacks) {
    callback({
      get: (name) => (name === "webServer" ? lateServer : undefined),
      effect: (cb) => { const d = cb(); return typeof d === "function" ? d : () => {}; },
    });
  }
}
check("a late webServer still receives all five routes", lateRoutes.size === 5);
check("the late-registered diag route is callable", typeof lateRoutes.get("/workspace-plus/diag") === "function");

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

