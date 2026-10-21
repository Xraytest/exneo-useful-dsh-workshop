window.__ModuleLoader__.load({
  id: "dsh-model-capabilities",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const h = react.createElement;

    const NS = "llm-pi-ai";
    const VERSION = "persistent-2";
    const MODALITY_LABELS = { text: "文本", image: "图片" };
    const LEVEL_LABELS = { off: "关闭", low: "低", high: "高", max: "最大" };
    const LEVEL_ORDER = ["off", "low", "high", "max"];

    const NOTICE_TEXT = {
      "write-failed": "设置写入失败（可能有并发修改），请刷新页面后重试",
      "not-declarable": "该模型不在渠道设置的 models 列表中，无法写入声明（仅展示）",
    };

    const PAGE_CSS = [
      ".mcap-page { padding: 4px 2px 24px; display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); font-size: 13px; }",
      ".mcap-title-row { display: flex; align-items: center; gap: 8px; }",
      ".mcap-title { font-size: 15px; font-weight: 600; }",
      ".mcap-spacer { flex: 1; }",
      ".mcap-desc { font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }",
      ".mcap-tools { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }",
      ".mcap-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 4px 10px; font-size: 12px; line-height: 1.4; cursor: pointer; }",
      ".mcap-btn:disabled { opacity: 0.5; cursor: default; }",
      ".mcap-mini { padding: 1px 8px; font-size: 11px; }",
      ".mcap-danger { color: var(--dsw-alias-state-error-primary); }",
      ".mcap-status, .mcap-error, .mcap-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); }",
      ".mcap-error { color: var(--dsw-alias-state-error-primary); font-weight: 600; }",
      ".mcap-notice { font-size: 12px; color: var(--dsw-alias-state-warn-primary); }",
      ".mcap-fail { border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 6px; padding: 8px 10px; color: var(--dsw-alias-state-error-primary); font-size: 12px; font-weight: 600; }",
      ".mcap-provider { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }",
      ".mcap-provider-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; cursor: pointer; user-select: none; }",
      ".mcap-provider-head:hover { background: var(--dsw-alias-bg-layer-2); }",
      ".mcap-provider.open .mcap-provider-head { border-bottom: 1px solid var(--dsw-alias-border-l1); }",
      ".mcap-caret { font-size: 10px; color: var(--dsw-alias-label-secondary); width: 12px; flex-shrink: 0; text-align: center; }",
      ".mcap-provider-name { font-size: 13px; font-weight: 600; }",
      ".mcap-provider-summary { font-size: 11px; color: var(--dsw-alias-label-secondary); font-weight: 400; margin-left: auto; }",
      ".mcap-model { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); }",
      ".mcap-model:last-child { border-bottom: none; }",
      ".mcap-model-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
      ".mcap-model-name { font-weight: 600; }",
      ".mcap-model-id { font-size: 11px; color: var(--dsw-alias-label-secondary); font-family: monospace; }",
      ".mcap-model-declared { font-size: 11px; color: var(--dsw-alias-label-secondary); }",
      ".mcap-tag { font-size: 11px; border-radius: 4px; padding: 0 6px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }",
      ".mcap-tag-managed { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }",
      ".mcap-tag-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }",
      ".mcap-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }",
      ".mcap-label { font-size: 12px; color: var(--dsw-alias-label-secondary); min-width: 64px; }",
      ".mcap-chip { border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; }",
      ".mcap-chip.mcap-on { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }",
    ].join("\n");

    function injectStyles() {
      if (typeof document === "undefined") return;
      const tagId = "dsh-model-capabilities/page.css";
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + "]") !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-model-capabilities";
      tag.dataset.pluginCss = tagId;
      tag.textContent = PAGE_CSS;
      (document.head || document.documentElement).appendChild(tag);
    }

    function levelLabel(id) {
      return LEVEL_LABELS[id] || id;
    }

    function failureMessage(failure) {
      if (failure === null || failure === undefined) return "未知错误";
      if (typeof failure === "string") return failure;
      if (typeof failure.message === "string" && failure.message !== "") return failure.message;
      return String(failure);
    }

    function levelsFromUser(reasoningEfforts) {
      if (reasoningEfforts === false) return [];
      if (reasoningEfforts && typeof reasoningEfforts === "object") return Object.keys(reasoningEfforts);
      return null;
    }

    function effortsToUser(levels) {
      const thinking = levels.filter((level) => level !== "off");
      if (thinking.length === 0) return false;
      const map = {};
      if (levels.indexOf("off") >= 0) map.off = null;
      for (const level of thinking) map[level] = level;
      return map;
    }

    function isManaged(userEntry) {
      return userEntry !== null && userEntry !== undefined
        && (userEntry.reasoningEfforts !== undefined || userEntry.input !== undefined);
    }

    function effectiveOf(model) {
      const userEntry = model.userEntry || null;
      const declared = model.declared || {};
      const modalities = userEntry && userEntry.input ? userEntry.input.slice()
        : (declared.modalities ? declared.modalities.slice() : null);
      const declaredLevels = declared.efforts ? declared.efforts.map((effort) => effort.id) : null;
      const levels = userEntry && userEntry.reasoningEfforts !== undefined
        ? levelsFromUser(userEntry.reasoningEfforts)
        : (declaredLevels || null);
      return { modalities: modalities, levels: levels };
    }

    function declaredSummary(model) {
      const declared = model.declared || {};
      const parts = [];
      parts.push("输入模态 " + (declared.modalities ? declared.modalities.map((item) => MODALITY_LABELS[item] || item).join("、") : "未声明（缺省含文本）"));
      if (declared.efforts && declared.efforts.length > 0) {
        parts.push("思考 " + declared.efforts.map((effort) => levelLabel(effort.id)).join("、"));
      } else {
        parts.push("思考 未声明");
      }
      return "适配器声明：" + parts.join(" · ");
    }

    function ModelRow(props) {
      const model = props.model;
      const effective = effectiveOf(model);
      const managed = isManaged(model.userEntry);
      const declarable = model.declarable !== false;
      const declared = model.declared || {};
      const declaredLevelIds = declared.efforts ? declared.efforts.map((effort) => effort.id) : [];

      const universe = LEVEL_ORDER.slice();
      const addUnique = (id) => { if (universe.indexOf(id) < 0) universe.push(id); };
      declaredLevelIds.forEach(addUnique);
      if (effective.levels) effective.levels.forEach(addUnique);

      const modalityChip = (id, key) => {
        const isText = id === "text";
        // 2026-10-08 用户指令：所有模型默认支持文本模态。文本是每种协议的保底输入
        //（pi-ai 对未声明模型缺省即 ["text"]，本页写入路径也恒含 text），
        // 因此「文本」一律按已选中样式展示，不可关闭。
        const active = isText || (effective.modalities !== null && effective.modalities.indexOf(id) >= 0);
        const adapterDeclared = declared.modalities && declared.modalities.indexOf(id) >= 0;
        return h("button", {
          key,
          className: "mcap-chip" + (active ? " mcap-on" : ""),
          disabled: isText,
          title: isText ? "文本输入始终启用（所有模型默认支持文本模态）" : (adapterDeclared ? "适配器已声明" : "适配器未声明"),
          onClick: isText ? undefined : () => {
            const base = effective.modalities || ["text"];
            const next = base.indexOf(id) >= 0 ? base.filter((item) => item !== id) : base.concat([id]);
            // 写入值恒含 text：勾空回填 text、缺 text 补上（默认文本始终在列）。
            props.applyManaged(model, { modalities: next.indexOf("text") < 0 ? ["text"].concat(next) : next });
          },
        }, MODALITY_LABELS[id]);
      };

      const levelChip = (id, key) => {
        const active = effective.levels !== null && effective.levels.indexOf(id) >= 0;
        const adapterDeclared = declaredLevelIds.indexOf(id) >= 0;
        return h("button", {
          key,
          className: "mcap-chip" + (active ? " mcap-on" : ""),
          title: adapterDeclared ? "适配器已声明" : "适配器未声明",
          onClick: () => {
            const base = effective.levels || [];
            let next = base.indexOf(id) >= 0 ? base.filter((item) => item !== id) : base.concat([id]);
            if (next.filter((item) => item !== "off").length === 0) next = [];
            props.applyManaged(model, { efforts: next });
          },
        }, levelLabel(id));
      };

      return h("div", { className: "mcap-model" },
        h("div", { className: "mcap-model-head" },
          h("span", { className: "mcap-model-name" }, model.name || model.id),
          h("span", { className: "mcap-model-id" }, model.id),
          managed ? h("span", { className: "mcap-tag mcap-tag-managed" }, "已管理") : null,
          !declarable ? h("span", { className: "mcap-tag mcap-tag-warn" }, "仅展示") : null,
          managed ? h("button", {
            className: "mcap-btn mcap-mini",
            onClick: () => props.resetModel(model),
          }, "恢复适配器声明") : null,
        ),
        h("div", { className: "mcap-model-declared" }, declaredSummary(model)),
        h("div", { className: "mcap-row" },
          h("span", { className: "mcap-label" }, "输入模态"),
          modalityChip("text"),
          modalityChip("image"),
        ),
        h("div", { className: "mcap-row" },
          h("span", { className: "mcap-label" }, "思考强度"),
          universe.map((id) => levelChip(id, "lv-" + id)),
          h("button", {
            className: "mcap-chip",
            title: "声明该模型不支持思考（reasoningEfforts: false）",
            onClick: () => props.applyManaged(model, { efforts: [] }),
          }, "无思考"),
        ),
      );
    }

    function ModelCapabilitiesPage(props) {
      const viewState = react.useState(null);
      const view = viewState[0];
      const setView = viewState[1];
      const errorState = react.useState(null);
      const error = errorState[0];
      const setError = errorState[1];
      const failState = react.useState(null);
      const fail = failState[0];
      const setFail = failState[1];
      const noticeState = react.useState(null);
      const notice = noticeState[0];
      const setNotice = noticeState[1];
      const busyState = react.useState(false);
      const busy = busyState[0];
      const setBusy = busyState[1];

      const buildRows = (catalog, namespaceView) => {
        const userProviders = (namespaceView.user && namespaceView.user.providers) || {};
        const valueProviders = (namespaceView.value && namespaceView.value.providers) || {};
        const userModelsOf = {};
        const valueModelsOf = {};
        const routes = [];
        for (const route of Object.keys(userProviders)) if (routes.indexOf(route) < 0) routes.push(route);
        for (const route of Object.keys(valueProviders)) if (routes.indexOf(route) < 0) routes.push(route);
        for (const route of routes) {
          const userModels = userProviders[route] && Array.isArray(userProviders[route].models) ? userProviders[route].models : [];
          const valueModels = valueProviders[route] && Array.isArray(valueProviders[route].models) ? valueProviders[route].models : [];
          const byId = {};
          for (const entry of userModels) if (entry && typeof entry.id === "string") byId[entry.id] = entry;
          userModelsOf[route] = byId;
          const valueById = {};
          for (const entry of valueModels) if (entry && typeof entry.id === "string") valueById[entry.id] = entry;
          valueModelsOf[route] = valueById;
        }
        const rows = [];
        for (const group of catalog.groups || []) {
          for (const model of group.models || []) {
            const route = group.id;
            const userEntry = userModelsOf[route] && userModelsOf[route][model.id] ? userModelsOf[route][model.id] : null;
            const valueEntry = valueModelsOf[route] && valueModelsOf[route][model.id] ? valueModelsOf[route][model.id] : null;
            const declaredModalities = valueEntry && Array.isArray(valueEntry.input) ? valueEntry.input.slice() : null;
            const declaredEfforts = model.reasoning && Array.isArray(model.reasoning.efforts)
              ? model.reasoning.efforts.map((effort) => ({ id: effort.id, name: effort.name }))
              : null;
            rows.push({
              provider: route,
              id: model.id,
              name: model.name || model.id,
              declared: { modalities: declaredModalities, efforts: declaredEfforts },
              userEntry: userEntry,
              declarable: userEntry !== null,
            });
          }
        }
        return rows;
      };

      const load = () => {
        setBusy(true);
        Promise.all([
          props.remote.session.modelCatalog(),
          props.remote.settings.describe(),
        ]).then((responses) => {
          const catalogResponse = responses[0];
          const describeResponse = responses[1];
          if (!catalogResponse.ok) throw new Error(catalogResponse.error.code + ": " + catalogResponse.error.message);
          if (!describeResponse.ok) throw new Error(describeResponse.error.code + ": " + describeResponse.error.message);
          const namespaces = describeResponse.value.namespaces || [];
          let namespaceView = null;
          for (const candidate of namespaces) if (candidate && candidate.ns === NS) namespaceView = candidate;
          if (namespaceView === null) throw new Error("未找到 " + NS + " 设置命名空间");
          setView({ catalog: catalogResponse.value, namespace: namespaceView, rows: buildRows(catalogResponse.value, namespaceView), writable: describeResponse.value.writable === true });
          setError(null);
          setBusy(false);
        }, (failure) => {
          setError(failureMessage(failure));
          setBusy(false);
        });
      };
      react.useEffect(load, []);

      react.useEffect(() => {
        if (!props.remote || typeof props.remote.$on !== "function") return undefined;
        return props.remote.$on("settings/document-updated", () => { load(); });
      }, []);

      const writeModel = (row, patch) => {
        if (view === null) return;
        setBusy(true);
        setFail(null);
        const attempt = (namespaceView) => {
          const user = (namespaceView.user && typeof namespaceView.user === "object") ? namespaceView.user : {};
          const providers = (user.providers && typeof user.providers === "object") ? user.providers : {};
          const routeProfile = providers[row.provider];
          const models = routeProfile && Array.isArray(routeProfile.models) ? routeProfile.models : null;
          if (models === null) return Promise.resolve({ ok: false, reason: "not-declarable" });
          const index = models.findIndex((item) => item && item.id === row.id);
          if (index < 0) return Promise.resolve({ ok: false, reason: "not-declarable" });
          const nextModels = models.slice();
          const entry = Object.assign({}, nextModels[index]);
          if ("modalities" in patch) {
            if (patch.modalities === null || patch.modalities === undefined) delete entry.input;
            else entry.input = patch.modalities.slice();
          }
          if ("efforts" in patch) {
            if (patch.efforts === null || patch.efforts === undefined) delete entry.reasoningEfforts;
            else entry.reasoningEfforts = effortsToUser(patch.efforts);
          }
          nextModels[index] = entry;
          const nextProviders = Object.assign({}, providers);
          nextProviders[row.provider] = Object.assign({}, routeProfile || {});
          nextProviders[row.provider].models = nextModels;
          return props.remote.settings.update(NS, { providers: nextProviders }, namespaceView.revision).then((response) => {
            if (response.ok) return { ok: true, view: response.value };
            return { ok: false, reason: "write-failed" };
          }, () => ({ ok: false, reason: "write-failed" }));
        };
        attempt(view.namespace).then((outcome) => {
          if (outcome.ok === true) {
            setNotice("已写入渠道设置（llm-pi-ai）；模型选择器随之更新，若未变请刷新页面");
            load();
            return;
          }
          if (outcome.reason === "write-failed") {
            props.remote.settings.describe().then((fresh) => {
              if (!fresh.ok) { setFail("声明未写入：设置写入失败"); setBusy(false); return; }
              const namespaces = fresh.value.namespaces || [];
              let namespaceView = null;
              for (const candidate of namespaces) if (candidate && candidate.ns === NS) namespaceView = candidate;
              if (namespaceView === null) { setFail("声明未写入：未找到 llm-pi-ai 设置命名空间"); setBusy(false); return; }
              return attempt(namespaceView).then((retry) => {
                if (retry.ok === true) {
                  setNotice("已写入渠道设置（llm-pi-ai）；模型选择器随之更新，若未变请刷新页面");
                  load();
                } else {
                  setFail("声明未写入：" + (NOTICE_TEXT[retry.reason] || String(retry.reason || "未知原因")));
                  setBusy(false);
                }
              });
            }, () => { setFail("声明未写入：设置写入失败"); setBusy(false); });
            return;
          }
          setFail("声明未写入：" + (NOTICE_TEXT[outcome.reason] || String(outcome.reason || "未知原因")));
          setBusy(false);
        });
      };

      const applyManaged = (model, patch) => {
        writeModel(model, patch);
      };

      const resetModel = (model) => {
        writeModel(model, { modalities: null, efforts: null });
      };

      // 供应商折叠：默认全部收起；展开状态在加载刷新间保持。
      const [expanded, setExpanded] = react.useState({});
      const toggleRoute = (route) => setExpanded((prev) => Object.assign({}, prev, { [route]: !prev[route] }));

      // 按 provider 分组（需在头部之前算好：「全部展开」要枚举渠道）。
      const byRoute = view === null ? {} : (() => {
        const map = {};
        for (const row of view.rows) {
          if (!map[row.provider]) map[row.provider] = [];
          map[row.provider].push(row);
        }
        return map;
      })();

      const children = [];
      const isManagedRow = (row) => isManaged(row.userEntry) === true;
      children.push(h("div", { key: "head", className: "mcap-head" },
        h("div", { className: "mcap-title-row" },
          h("span", { className: "mcap-title" }, "模型能力管理"),
          h("span", { className: "mcap-model-id" }, VERSION),
          h("span", { className: "mcap-spacer" }),
          view !== null ? h("span", { className: "mcap-title-row" },
            h("button", { className: "mcap-btn mcap-mini", onClick: () => {
              const next = {};
              for (const route of Object.keys(byRoute)) next[route] = true;
              setExpanded(next);
            } }, "全部展开"),
            h("button", { className: "mcap-btn mcap-mini", onClick: () => setExpanded({}) }, "全部收起"),
          ) : null,
          h("button", { className: "mcap-btn", disabled: busy, onClick: load }, "刷新"),
          props.close ? h("button", { className: "mcap-btn", disabled: busy, onClick: () => props.close() }, "关闭") : null,
        ),
        h("div", { className: "mcap-desc" }, "按模型管理输入模态与思考强度。文本是所有模型默认启用的保底模态（始终选中、不可关闭）；「图片」按模型开关——关闭后该模型在会话中将被拒绝读图（read_image）与上传图片，历史里已有的图片会自动转为文字描述而不再发给上游。思考强度允许值为 关闭 / 低 / 高 / 最大 四档。管理值写入渠道设置（llm-pi-ai 命名空间的 models 条目）成为真实能力声明：对话界面模型选择器随之出现思考强度菜单，所选档位按线上拼写发送给提供商（关闭 = 请求不带思考参数）。设置写入 settings.yaml，重启后仍生效；渠道设置中不存在的模型仅展示。注意：内核代码层的能力收口修改需重启 dsh 后生效。"),
      ));
      if (fail !== null) children.push(h("div", { key: "fail", className: "mcap-fail" }, fail));
      if (error !== null) children.push(h("div", { key: "error", className: "mcap-error" }, error));
      if (notice !== null) children.push(h("div", { key: "notice", className: "mcap-notice" }, notice));

      if (view === null) {
        children.push(h("div", { key: "status", className: "mcap-status" }, busy ? "加载中…" : "暂无数据"));
        return h("div", { className: "mcap-page" }, children);
      }

      const catalogGroups = (view.catalog && view.catalog.groups) || [];
      const names = {};
      for (const group of catalogGroups) names[group.id] = group.name;
      const routeIds = [];
      for (const route of Object.keys(byRoute)) if (routeIds.indexOf(route) < 0) routeIds.push(route);
      if (routeIds.length === 0) {
        children.push(h("div", { key: "empty", className: "mcap-empty" }, "当前没有已注册的模型渠道。"));
      }
      for (const route of routeIds) {
        const rows = byRoute[route];
        const open = expanded[route] === true;
        const managedCount = rows.filter(isManagedRow).length;
        const summary = rows.length + " 个模型" + (managedCount > 0 ? " · " + managedCount + " 已管理" : "");
        const providerBlock = [
          h("div", {
            key: "head",
            className: "mcap-provider-head",
            title: open ? "收起" : "展开",
            onClick: () => toggleRoute(route),
          },
            h("span", { className: "mcap-caret" }, open ? "▾" : "▸"),
            h("span", { className: "mcap-provider-name" }, (names[route] || route) + " · " + route),
            h("span", { className: "mcap-provider-summary" }, summary),
          ),
        ];
        if (open) {
          providerBlock.push(rows.length === 0
            ? h("div", { key: "empty", className: "mcap-empty" }, "该渠道暂无模型目录")
            : rows.map((row) => h(ModelRow, {
                key: "m-" + row.id,
                model: row,
                applyManaged: applyManaged,
                resetModel: resetModel,
              })));
        }
        children.push(h("div", { key: "p-" + route, className: "mcap-provider" + (open ? " open" : "") }, providerBlock));
      }
      return h("div", { className: "mcap-page" }, children);
    }

    const inject = ["slots", "remote", "remote.session", "remote.settings"];

    function apply(ctx) {
      injectStyles();
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "model-capabilities",
        order: 20,
        label: "模型能力",
      }, (ownerProps) => h(ModelCapabilitiesPage, {
        close: ownerProps && ownerProps.close,
        remote: ctx.remote,
      })));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
