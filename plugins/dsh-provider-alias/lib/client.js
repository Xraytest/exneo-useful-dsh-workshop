window.__ModuleLoader__.load({
	id: "dsh-provider-alias",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region stylesheet
		/**
		 * The card's stylesheet: the Models page's own card tokens and geometry,
		 * cloned so this card reads as part of that page, plus the few rules this
		 * card needs and the page does not have (an inline fetch panel, a wrapping
		 * endpoint line). Injected once per document with this plugin as its owner.
		 */
		const CSS = ".pva_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}.pva_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}.pva_notice{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}.pva_savedNotice{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}.pva_rows{flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none;display:flex}.pva_rowCard{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);flex-direction:column;gap:12px;padding:12px 14px;display:flex}.pva_rowHead{align-items:center;gap:10px;display:flex}.pva_rowIdentity{flex:1 1 auto;align-items:center;gap:6px;min-width:0;overflow:hidden;display:flex}.pva_rowName{color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:22px}.pva_rowTag{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);flex:none;padding:1px 6px;font-size:11px;line-height:16px}.pva_credentialDot{box-sizing:border-box;corner-shape:round;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block}.pva_credentialDotConfigured{background:var(--dsw-alias-state-success-primary)}.pva_credentialDotMissing{background:var(--dsw-alias-state-error-primary)}.pva_accountStatus{color:var(--dsw-alias-state-success-primary);flex:none;align-items:center;gap:6px;font-size:13px;line-height:20px;display:inline-flex}.pva_rowActions{flex:none;white-space:nowrap;align-items:center;gap:4px;margin-left:auto;display:inline-flex}.pva_primaryButton,.pva_secondaryButton,.pva_addButton{box-sizing:border-box;border-radius:var(--dsw-radius-md);height:36px;font:inherit;cursor:pointer;border:none;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.pva_primaryButton{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}@media (hover:hover){.pva_primaryButton:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}}.pva_secondaryButton,.pva_addButton{border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:0 0}@media (hover:hover){.pva_secondaryButton:hover:not(:disabled),.pva_addButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.pva_secondaryButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}}.pva_dangerButton{box-sizing:border-box;border-radius:var(--dsw-radius-md);height:36px;color:var(--dsw-alias-state-error-primary);font:inherit;cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}@media (hover:hover){.pva_dangerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}}.pva_rowActions .pva_secondaryButton,.pva_rowActions .pva_dangerButton{border-radius:var(--dsw-radius-sm);flex:none;white-space:nowrap;height:28px;padding:0 10px;font-size:12px;line-height:18px}.pva_primaryButton:disabled,.pva_secondaryButton:disabled,.pva_dangerButton:disabled,.pva_addButton:disabled,.pva_linkButton:disabled,.pva_addModelButton:disabled{opacity:.4;cursor:default}.pva_primaryButton:focus-visible,.pva_secondaryButton:focus-visible,.pva_dangerButton:focus-visible,.pva_addButton:focus-visible,.pva_linkButton:focus-visible,.pva_addModelButton:focus-visible,.pva_iconButton:focus-visible,.pva_customizedSummary:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}.pva_editor{border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);flex-direction:column;gap:14px;padding:14px 16px;display:flex}.pva_editorHeader{align-items:baseline;gap:8px;display:flex}.pva_editorTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}.pva_editorRoute{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.pva_field{flex-direction:column;gap:6px;display:flex}.pva_fieldLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}.pva_helpButton{border:.5px solid var(--dsw-alias-border-l3);corner-shape:round;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);font:inherit;text-align:center;cursor:help;background:0 0;border-radius:50%;padding:0;font-size:11px;line-height:15px}.pva_helpButton:focus-visible{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}@media (hover:hover){.pva_helpButton:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}}.pva_linkButton{box-sizing:border-box;border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:none;align-items:center;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}@media (hover:hover){.pva_linkButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}.pva_advancedHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}.pva_editorActions{justify-content:flex-end;gap:8px;display:flex}.pva_addBlock{flex-direction:column;gap:12px;display:flex}.pva_addActions{display:flex}.pva_addButton{border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);flex:1 1 0;gap:6px;min-width:180px;height:44px}.pva_addModes{flex-direction:column;align-items:flex-start;gap:8px;display:flex}.pva_addPanel{flex-direction:column;gap:14px;display:flex}.pva_addPanel[hidden]{display:none}.pva_addCard,.pva_setupCard{border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);flex-direction:column;gap:14px;padding:14px 16px;list-style:none;display:flex}.pva_addCard .pva_editor,.pva_setupCard .pva_editor{background:0 0;padding:0}.pva_customized{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px}.pva_customizedSummary{border-radius:var(--dsw-radius-sm);cursor:pointer;width:fit-content;color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;margin-left:-4px;padding:2px 4px;font-size:12px;font-weight:500;line-height:18px;list-style:none;display:flex}.pva_customizedSummary::-webkit-details-marker{display:none}.pva_customizedSummary:before{content:\"\";border-bottom:1.5px solid;border-right:1.5px solid;width:5px;height:5px;transition:transform .12s;transform:rotate(-45deg)translate(-1px,-1px)}.pva_customized[open]>.pva_customizedSummary:before{transform:rotate(45deg)translate(-1px,-1px)}@media (hover:hover){.pva_customizedSummary:hover{color:var(--dsw-alias-label-primary)}}.pva_customizedBody{flex-direction:column;gap:12px;padding-top:12px;display:flex}.pva_modelCatalog{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding-top:12px;display:flex;position:relative}.pva_modelCatalogHeading{flex-direction:column;gap:2px;display:flex}.pva_modelCatalogTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}.pva_modelCatalogMeta,.pva_modelEmpty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}.pva_modelList{flex-direction:column;gap:8px;display:flex}.pva_modelListHead{justify-content:space-between;align-items:flex-start;gap:12px;display:flex}.pva_modelEntry{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);padding:6px;position:relative;container:pva_model-row/inline-size}.pva_modelRow{grid-template-columns:auto minmax(0,1.4fr) minmax(0,1fr);align-items:end;gap:6px;display:grid}.pva_modelRow .pva_iconButton{align-self:end;margin-bottom:4px}@container pva_model-row (width<=440px){.pva_modelRow{grid-template-columns:auto minmax(0,1fr)}.pva_modelRow .pva_modelName{grid-column:1/-1}}.pva_modelDragHandle:not(:disabled){cursor:grab}.pva_modelEntry[data-dragging]{opacity:.5}.pva_modelEntry[data-drop-target]{z-index:1}.pva_modelDragPreview{background:var(--dsw-alias-bg-module-platform)}.pva_modelEntry:before,.pva_modelEntry:after{content:\"\";z-index:1;height:4px;position:absolute;left:0;right:0}.pva_modelEntry:before{top:-4px}.pva_modelEntry:after{bottom:-4px}.pva_modelEntry[data-drop-target=before]:before,.pva_modelEntry[data-drop-target=after]:after{background:linear-gradient(55deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat, linear-gradient(125deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat, linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;height:12px}.pva_modelEntry[data-drop-target=before]:before{top:-10px}.pva_modelEntry[data-drop-target=after]:after{bottom:-10px}.pva_iconButton{box-sizing:border-box;border-radius:var(--dsw-radius-sm);width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;display:inline-flex}@media (hover:hover){.pva_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}.pva_iconButton:disabled{cursor:default;opacity:.4}@media (hover:hover){.pva_iconButtonDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}}.pva_modelAdvanced{grid-column:1/-1;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:2px 4px;display:grid}.pva_modelField{flex-direction:column;gap:4px;min-width:0;display:flex}.pva_modelInputTypes{border:none;grid-column:1/-1;min-width:0;margin:0;padding:0}.pva_modelInputTypes legend{margin-bottom:4px;padding:0}.pva_modelInputChoices{flex-wrap:wrap;align-items:center;gap:16px;min-height:32px;display:flex}.pva_modelFieldLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.pva_modelReasoning{flex-direction:column;grid-column:1/-1;gap:6px;min-width:0;display:flex}.pva_modelReasoningLabel{align-items:center;gap:6px;display:inline-flex}.pva_modelReasoningHead{justify-content:space-between;align-items:center;gap:8px;display:flex}.pva_modelReasoningRow{grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;align-items:center;gap:6px;display:grid}.pva_modelReasoningRow .pva_selectInput{max-width:none}.pva_modelReasoningValueInput{font-family:var(--ds-font-family-code);font-size:13px}.pva_modelEmpty{border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);text-align:center;padding:12px}.pva_addModelButton{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;align-self:flex-start;align-items:center;gap:4px;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}@media (hover:hover){.pva_addModelButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}.pva_input{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px;font-size:14px;line-height:22px}select.pva_input{cursor:pointer;max-width:240px}.pva_input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}.pva_input::placeholder{color:var(--dsw-alias-label-dimmed)}.pva_input:disabled{opacity:.6;cursor:default}.pva_keyInput{position:relative}.pva_keyInputFilled{padding-right:40px}.pva_keyToggle{border-radius:var(--dsw-radius-md);width:32px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:0;display:inline-flex;position:absolute;inset:1px 1px 1px auto}@media (hover:hover){.pva_keyToggle:hover:not(:disabled){color:var(--dsw-alias-label-primary)}}.pva_keyToggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.pva_keyToggle:disabled{opacity:.6;cursor:default}.pva_selectInput{appearance:none;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px;padding-right:32px}.pva_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}.pva_deleteDialog{width:min(480px,100%)}.pva_deleteConfirm:not(:disabled){--dsh-button-outline-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}@media (hover:hover){.pva_deleteConfirm:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}}.pva_hiddenLabel{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}@media (prefers-reduced-motion:reduce){.pva_customizedSummary:before,.pva_switchThumb{transition:none}}.pva_fetchDialog{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);max-width:520px}.pva_candidateToolbar{align-items:center;gap:8px;margin-bottom:6px;display:flex}.pva_candidateSearch{flex:240px;min-width:0}.pva_candidateList{flex-direction:column;gap:2px;max-height:320px;margin:0;padding:0;list-style:none;display:flex;overflow-y:auto}.pva_candidate{border-radius:var(--dsw-radius-md)}.pva_candidateLabel{cursor:pointer;align-items:center;gap:8px;padding:6px 8px;display:flex}.pva_candidateId{min-width:0;font-family:var(--ds-font-family-code);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:13px;overflow:hidden}.pva_candidateEmpty{color:var(--dsw-alias-label-secondary);text-align:center;margin:24px 0;font-size:13px;line-height:20px}.pva_rowMeta{color:var(--dsw-alias-label-tertiary);align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0;margin:0;font-size:12px;line-height:18px;display:flex}.pva_urlHint{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);overflow-wrap:anywhere;font-size:12px;line-height:18px}.pva_inlinePanel{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);flex-direction:column;gap:10px;padding:10px 12px;display:flex}.pva_errorBlock{flex-direction:column;align-items:flex-start;gap:4px;display:flex}";
		/**
		 * The rules the protocol-endpoint editor adds: a row that pairs a protocol
		 * with its own address, and the fetch-family selector beside the model
		 * heading. Kept apart from the cloned page stylesheet so that clone stays a
		 * verbatim copy of the page's own card style.
		 */
		const CSS_ENDPOINTS = ".pva_endpoints{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding-top:12px;display:flex}.pva_endpointHead{align-items:center;gap:8px;display:flex;justify-content:space-between}.pva_endpointList{flex-direction:column;gap:8px;display:flex}.pva_endpointRow{grid-template-columns:minmax(0,190px) minmax(0,1fr) auto;align-items:center;gap:8px;display:grid}.pva_endpointUrl{min-width:0}.pva_modelListActions{align-items:center;gap:8px;display:flex}.pva_fetchFamily{width:auto;max-width:200px;min-width:150px}.pva_modelWide{grid-column:1/-1}";
		const CSS_TAG = "dsh-provider-alias/Card.module.css";
		/**
		 * The rules the thinking-level editor adds: one row per declared level, a
		 * ladder selector beside the wire value it sends. Kept apart from the cloned
		 * page stylesheet for the same reason as the endpoint rules above.
		 */
		const CSS_REASONING = ".pva_modelReasoning{grid-column:1/-1;border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:6px;padding-top:8px;display:flex}.pva_modelReasoningHead{align-items:center;gap:8px;display:flex;justify-content:space-between}.pva_modelReasoningRow{grid-template-columns:minmax(0,132px) minmax(0,1fr) auto;align-items:center;gap:8px;display:grid}.pva_modelReasoningRow .pva_iconButton{align-self:center;margin-bottom:0}.pva_modelReasoningValue{min-width:0}.pva_modelReasoning .pva_addModelButton{margin-top:2px}";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-provider-alias";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS + CSS_ENDPOINTS + CSS_REASONING;
			document.head.appendChild(tag);
		}
		/**
		 * One of this card's class names. The cloned stylesheet is written with the
		 * plugin's own prefix, so a name needs no lookup table — which is what keeps
		 * the clone honest: a class the stylesheet does not define simply renders
		 * unstyled instead of silently borrowing another plugin's rule.
		 * @param name - the class's local name.
		 * @returns the prefixed class name.
		 */
		function c(name) {
			return `pva_${name}`;
		}
		//#endregion
		//#region constants
		/**
		 * The settings namespace this card writes. It is also the namespace this
		 * plugin's host half registers its routes under, so both halves address one
		 * document section.
		 */
		const NS = "provider-alias";
		/**
		 * The route-id grammar, mirrored from the host so an invalid id is refused
		 * before a round trip. It is also the credential-record id grammar: a route
		 * that fails it could store no key.
		 */
		const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
		/**
		 * The wire protocols a route may name. Mirrored from the host's own table: a
		 * protocol this card offered but the host could not serve would hand back a
		 * provider that fails on its first request.
		 */
		const PROTOCOLS = [
			"openai-completions",
			"openai-responses",
			"anthropic-messages",
			"google-generative-ai"
		];
		/** The request specs a route may follow, most specific first. */
		const SPECS = ["opencode-go"];
		/** Copy keys for each protocol's display name. */
		const PROTOCOL_LABEL_KEYS = {
			"openai-completions": "protocolOpenAiCompletions",
			"openai-responses": "protocolOpenAiResponses",
			"anthropic-messages": "protocolAnthropicMessages",
			"google-generative-ai": "protocolGoogleGenerativeAi"
		};
		/** Copy keys for the base-URL placeholder each protocol expects. */
		const PROTOCOL_PLACEHOLDER_KEYS = {
			"openai-completions": "baseUrlPlaceholder",
			"openai-responses": "baseUrlPlaceholder",
			"anthropic-messages": "anthropicBaseUrlPlaceholder",
			"google-generative-ai": "googleBaseUrlPlaceholder"
		};
		/** Copy keys for the one-line note a protocol needs when its shape is not obvious. */
		const PROTOCOL_HINT_KEYS = { "google-generative-ai": "protocolHintGoogle" };
		/** Copy keys for each spec's display name. */
		const SPEC_LABEL_KEYS = { "opencode-go": "specOpencodeGo" };
		/** Copy keys for each spec's one-line explanation. */
		const SPEC_HINT_KEYS = { "opencode-go": "specHintOpencodeGo" };
		/**
		 * The thinking levels a model may declare, in escalating order. A model's
		 * `reasoningEfforts` is a map from one of these names to the value its wire
		 * protocol expects, so the host refuses a level outside this list when the
		 * document is saved — the card offers exactly these names and nothing else.
		 */
		const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		/**
		 * The levels each protocol's upstream accepts. Google is the narrow one:
		 * pi-ai throws while assembling a Google request whose level is not one of
		 * these four, so a Google row may not declare the rest — the refusal is
		 * reworded here rather than discovered as a failed message.
		 */
		const PROTOCOL_THINKING_LEVELS = { "google-generative-ai": ["off", "minimal", "low", "medium", "high"] };
		/** Copy keys for each thinking level's display name. */
		const REASONING_LEVEL_KEYS = {
			off: "reasoningLevelOff",
			minimal: "reasoningLevelMinimal",
			low: "reasoningLevelLow",
			medium: "reasoningLevelMedium",
			high: "reasoningLevelHigh",
			xhigh: "reasoningLevelXhigh",
			max: "reasoningLevelMax"
		};
		/** The levels a freshly enabled model starts with: Off plus the common trio. */
		const INITIAL_REASONING_LEVELS = ["off", "low", "medium", "high"];
		/**
		 * The specs whose gateway publishes no model listing on some protocol, and
		 * the prefix the host puts on that refusal.
		 *
		 * Both are a cross-file contract with the host half of this plugin
		 * (`lib/index.js` exports the same table and prefix as `internals`): the
		 * discovery RPC rethrows the host's error as a plain message, so the text is
		 * the only part of a refusal this card can see. A spec listed here has no
		 * listing to fetch at all — the button is not offered — and any family that
		 * answers with the prefix is retired for the rest of the session.
		 */
		const SPECS_WITHOUT_LISTING = { "opencode-go": ["google-generative-ai"] };
		const NO_LISTING_PREFIX = "no model list";
		/** Placeholder capacity hints, matching the host's route defaults. */
		const CAPACITY_HINT = {
			contextWindow: "1M",
			maxTokens: "128K"
		};
		/** Decimal multipliers a typed capacity may use. */
		const CAPACITY_SCALE = {
			k: 1e3,
			m: 1e6
		};
		/** A typed capacity: digits with an optional decimal part and K/M suffix. */
		const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/;
		/**
		 * Printable ASCII, space excluded — the charset a raw API key is expected to
		 * use. Mirrored from the host's `normalizeApiKey` so a key the form accepts is
		 * never refused for its bytes at request time.
		 */
		const LEGAL_API_KEY = /^[\x21-\x7E]+$/;
		/**
		 * A pasted `NAME=value` environment line, which is not a key. The name must
		 * be upper-case so `sk-` forms break at the hyphen, and the `=` must not be
		 * followed by another `=` so base64 padding is not mistaken for an assignment.
		 */
		const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/;
		/** The eye glyph and its struck-through twin, drawn once for the key toggle. */
		const EYE_CONTOUR = "M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z";
		const EYE_PATH = `${EYE_CONTOUR}M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z`;
		const EYE_OFF_PATH = `${EYE_CONTOUR}M2.5 2.5L13.5 13.5`;
		/** The React element factory, bound once. */
		const e = react.createElement;
		//#endregion
		//#region helpers
		/**
		 * Fill a copy template's `{name}` placeholders.
		 * @param template - the localized template.
		 * @param values - placeholder values by name.
		 * @returns the filled copy.
		 */
		function fmt(template, values) {
			let text = template;
			for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(value);
			return text;
		}
		/** Whether a value is wrapped in one matching pair of quotes. */
		function isQuoted(value) {
			const first = value[0];
			if (first !== "\"" && first !== "'" && first !== "`") return false;
			return value.length > 1 && value.endsWith(first);
		}
		/**
		 * Judge a typed API key.
		 * @param draft - the field's value.
		 * @returns a copy key naming the fault, or undefined when usable.
		 */
		function apiKeyFailure(draft) {
			if (draft.length === 0) return void 0;
			const value = draft.trim();
			if (value.length === 0) return "keyBlank";
			if (ENV_LINE.test(value) || isQuoted(value)) return "keyIllegalCharacters";
			if (!LEGAL_API_KEY.test(value)) return "keyIllegalCharacters";
			return void 0;
		}
		/**
		 * The credential reference a route's key is stored under when its profile
		 * names none — upper-cased, non-alphanumerics folded to `_`.
		 * @param route - the provider route.
		 * @returns the reference.
		 */
		function deriveKeyRef(route) {
			return `${route.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
		}
		/**
		 * Why a value cannot serve as an endpoint, if it cannot.
		 *
		 * The host appends the request path to this address as text and the vendor
		 * SDKs then parse the concatenation, which rules out two spellings a bare
		 * protocol test accepts: userinfo (no request can be constructed from it at
		 * all) and a raw `?` or `#` (the appended path lands inside the query or
		 * fragment). The card refuses them before the write so the host never has
		 * to, and the copy names the rule instead of hinting at a typo.
		 * @param value - the URL the field carries.
		 * @returns the fault, or undefined when the value is requestable.
		 */
		function endpointUrlFault(value) {
			let url;
			try {
				url = new URL(value);
			} catch {
				return "not-http";
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") return "not-http";
			if (url.username !== "" || url.password !== "") return "credentials";
			if (value.includes("?")) return "query";
			if (value.includes("#")) return "fragment";
			return void 0;
		}
		/** Whether a value can serve as an endpoint. */
		function isHttpUrl(value) {
			return endpointUrlFault(value) === void 0;
		}
		/**
		 * The copy key naming why an endpoint was refused.
		 *
		 * A value that is not a URL at all is a typo and keeps the field's own "enter
		 * an http(s) URL" line; a value that parses but cannot carry an appended
		 * request path is a different mistake and says so, because retyping the same
		 * address with the same scheme would not fix it.
		 * @param fault - what endpointUrlFault reported for the value.
		 * @param invalidKey - the key used for a value that is not a URL at all.
		 * @returns the copy key for that fault.
		 */
		function endpointFaultKey(fault, invalidKey) {
			return fault === void 0 || fault === "not-http" ? invalidKey : "urlNotRequestable";
		}
		/**
		 * A row's identity inside the card.
		 *
		 * Rows are edited in place and can be removed from the middle of the list, so
		 * a row needs a name that neither a keystroke nor a neighbour's removal
		 * changes: React keys the element by it, and the capacity field keeps
		 * unparsed text in row-local state that must never migrate to another model.
		 * The marker is stripped before the document is written.
		 */
		let rowSequence = 0;
		/** Mint an identity for one drafted row. */
		function mintRowId() {
			rowSequence += 1;
			return `row-${String(rowSequence)}`;
		}
		/** Give a drafted row the identity the list needs, leaving a named row alone. */
		function withRowId(model) {
			return typeof model.__row === "string" ? model : { ...model, __row: mintRowId() };
		}
		/**
		 * Parse a typed capacity, accepting a K/M suffix.
		 * @param text - the field's value.
		 * @returns the count, undefined for an empty field, or NaN when unusable.
		 */
		function parseCapacity(text) {
			const trimmed = text.trim();
			if (trimmed.length === 0) return void 0;
			const match = CAPACITY_PATTERN.exec(trimmed);
			if (match === null) return NaN;
			const suffix = match[2]?.toLowerCase();
			const scale = suffix === "k" || suffix === "m" ? CAPACITY_SCALE[suffix] : 1;
			const scaled = Number(match[1]) * scale;
			const rounded = Math.round(scaled);
			return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled;
		}
		/**
		 * Spell a stored count in the shortest form that survives a round trip.
		 * @param value - the stored count.
		 * @returns the field text.
		 */
		function formatCapacity(value) {
			if (!Number.isInteger(value) || value <= 0) return String(value);
			if (value % CAPACITY_SCALE.m === 0) return `${String(value / CAPACITY_SCALE.m)}M`;
			if (value % CAPACITY_SCALE.k === 0) return `${String(value / CAPACITY_SCALE.k)}K`;
			return String(value);
		}
		/** A protocol's display name, falling back to its identifier. */
		function protocolLabel(t, protocol) {
			const key = PROTOCOL_LABEL_KEYS[protocol];
			return key === void 0 ? protocol : t(key);
		}
		/**
		 * The placeholder a protocol's endpoint field shows. Google addresses its
		 * API version in the base URL, so offering the OpenAI shape there would
		 * produce a URL that answers 404 on the first request.
		 * @param t - the bound copy function.
		 * @param protocol - the selected protocol.
		 * @returns the localized placeholder.
		 */
		function protocolPlaceholder(t, protocol) {
			return t(PROTOCOL_PLACEHOLDER_KEYS[protocol] ?? "baseUrlPlaceholder");
		}
		/**
		 * The one-line note a protocol needs, for the protocols whose shape is not
		 * the default. Most protocols say nothing extra.
		 * @param t - the bound copy function.
		 * @param protocol - the selected protocol.
		 * @returns the localized note, or undefined when the protocol needs none.
		 */
		function protocolHint(t, protocol) {
			const key = PROTOCOL_HINT_KEYS[protocol];
			return key === void 0 ? void 0 : t(key);
		}
		/** A spec's display name, falling back to its identifier. */
		function specLabel(t, spec) {
			const key = SPEC_LABEL_KEYS[spec];
			return key === void 0 ? spec : t(key);
		}
		/** A spec's one-line explanation. */
		function specHint(t, spec) {
			const key = SPEC_HINT_KEYS[spec];
			return key === void 0 ? t("specHintNone") : t(key);
		}
		//#region reasoning
		/**
		 * The thinking levels a model on this protocol may declare.
		 * @param api - the protocol the row is served under, undefined until known.
		 * @returns the levels, escalating; every level when the protocol is unconstrained.
		 */
		function reasoningLevels(api) {
			return PROTOCOL_THINKING_LEVELS[api] ?? THINKING_LEVELS;
		}
		/**
		 * A level's display name, falling back to the identifier so a hand-written
		 * level still reads as itself.
		 * @param t - the bound copy function.
		 * @param level - the level's name.
		 * @returns the localized name.
		 */
		function reasoningLevelLabel(t, level) {
			const key = REASONING_LEVEL_KEYS[level];
			return key === void 0 ? level : t(key);
		}
		/**
		 * The wire value a level sends unless its own row says otherwise.
		 * @param level - one of {@link THINKING_LEVELS}.
		 * @returns the level's own name, or `null` for `off`, which sends nothing.
		 */
		function defaultReasoningValue(level) {
			return level === "off" ? null : level;
		}
		/**
		 * Whether the host will resolve a stored value: a nonempty string, or
		 * nothing at all for `off` — a `null` on any other level is a declaration
		 * this card cannot mean.
		 * @param level - the declared level.
		 * @param value - the value stored for it.
		 * @returns whether the adapter accepts the entry.
		 */
		function acceptedReasoningValue(level, value) {
			return typeof value === "string" ? value.length > 0 : value === null && level === "off";
		}
		/**
		 * Read a model's declared levels.
		 *
		 * The stored order is replaced by ladder order so the editor always reads
		 * top-down, but a hand-written level this build does not know is kept at the
		 * end instead of being dropped: showing it is what lets the user remove it,
		 * and a silent drop would rewrite the document behind their back. A value the
		 * host refuses outright (`null`, an array, a primitive) reads as an empty
		 * declaration, which the editor can switch off or repair.
		 * @param model - the drafted row.
		 * @returns the `[level, value]` entries, or undefined when the field is absent
		 *   or `false`, which both mean "this model declares no levels".
		 */
		function reasoningEntries(model) {
			const value = model.reasoningEfforts;
			if (value === void 0 || value === false) return void 0;
			if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
			const known = THINKING_LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(value, level)).map((level) => [level, value[level]]);
			const unknown = Object.keys(value).filter((level) => !THINKING_LEVELS.includes(level)).map((level) => [level, value[level]]);
			return known.concat(unknown);
		}
		/**
		 * Replace a row's declared levels, preserving every other field.
		 * @param model - the drafted row.
		 * @param entries - the entries to write in ladder order, or undefined to drop
		 *   the field entirely (the model then declares no thinking levels).
		 * @returns the replacement row.
		 */
		function withReasoningEntries(model, entries) {
			const next = { ...model };
			if (entries === void 0) Reflect.deleteProperty(next, "reasoningEfforts");
			else next.reasoningEfforts = Object.fromEntries(entries);
			return next;
		}
		/**
		 * The copy key naming why the host would refuse these declarations, mirroring
		 * its checks so the card names the row instead of failing the save.
		 * @param entries - the declared entries.
		 * @param api - the protocol the row is served under.
		 * @returns the copy key, or undefined when the host accepts the declaration.
		 */
		function reasoningFault(entries, api) {
			const allowed = reasoningLevels(api);
			for (const [level, value] of entries) {
				if (!THINKING_LEVELS.includes(level)) return "modelReasoningLevelUnknown";
				if (!allowed.includes(level)) return "modelReasoningLevelUnsupported";
				if (!acceptedReasoningValue(level, value)) return "modelReasoningValueRequired";
			}
			if (!entries.some(([level]) => level !== "off")) return "modelReasoningNeedsLevel";
			return void 0;
		}
		//#endregion
		/**
		 * Validate the model rows the way the host will.
		 * @param models - the drafted rows.
		 * @param families - the protocols this route can serve: its own, plus every
		 *   declared protocol endpoint. A row naming any other protocol is refused
		 *   here unless the row pins its own endpoint, which is the one shape the
		 *   host serves without a family — refused here rather than at save time,
		 *   where the host would reject the whole document.
		 * @returns the first invalid row and the copy key naming the fault.
		 */
		function validateModels(models, families) {
			const seen = /* @__PURE__ */ new Set();
			for (let index = 0; index < models.length; index++) {
				const model = models[index];
				const id = typeof model.id === "string" ? model.id.trim() : "";
				if (id.length === 0) return {
					index,
					key: "modelIdRequired"
				};
				if (seen.has(id)) return {
					index,
					key: "modelIdDuplicate"
				};
				seen.add(id);
				for (const field of ["contextWindow", "maxTokens"]) {
					const value = model[field];
					if (value !== void 0 && (!Number.isSafeInteger(value) || value <= 0)) return {
						index,
						key: "modelCapacityInvalid"
					};
				}
				const baseURL = typeof model.baseURL === "string" ? model.baseURL.trim() : "";
				if (baseURL.length > 0) {
					const baseURLFault = endpointUrlFault(baseURL);
					if (baseURLFault !== void 0) return {
						index,
						key: endpointFaultKey(baseURLFault, "modelBaseUrlInvalid")
					};
				}
				const api = model.api;
				/**
				 * A protocol outside the table is refused whatever the row pins: no
				 * endpoint can make this build speak a wire protocol it has no
				 * implementation for, and the host refuses the same row.
				 */
				if (typeof api === "string" && api.length > 0 && !PROTOCOLS.includes(api)) return {
					index,
					key: "modelProtocolUnsupported"
				};
				if (typeof api === "string" && api.length > 0 && families !== void 0 && !families.includes(api) && baseURL.length === 0) return {
					index,
					key: "modelProtocolUndeclared"
				};
				/**
				 * The thinking-level declaration, checked only when the row makes one: a
				 * row with no `reasoningEfforts` (or `false`) asks for no thinking and has
				 * nothing to refuse.
				 */
				const reasoning = reasoningEntries(model);
				if (reasoning !== void 0) {
					const reasoningFaultKey = reasoningFault(reasoning, typeof api === "string" && api.length > 0 ? api : families === void 0 ? void 0 : families[0]);
					if (reasoningFaultKey !== void 0) return {
						index,
						key: reasoningFaultKey
					};
				}
			}
			return void 0;
		}
		/**
		 * The minimal path ops carrying `after` over `before`.
		 *
		 * Profile edits are path-addressed rather than rebuilt from the card's
		 * fields: the card sees a fraction of a profile (a deployment may set
		 * `headers`, `reasoning`, or a retry policy in `cordis.patch.yml`), so a
		 * whole-subtree write would silently drop every field the card cannot show.
		 * @param base - the path of the edited subtree inside the user section.
		 * @param before - the subtree as stored.
		 * @param after - the subtree as edited.
		 * @returns ordered set/unset ops; empty when nothing changed.
		 */
		function pathOps(base, before, after) {
			const previous = typeof before === "object" && before !== null && !Array.isArray(before) ? before : {};
			const ops = [];
			for (const [key, value] of Object.entries(after)) {
				if (JSON.stringify(previous[key]) === JSON.stringify(value)) continue;
				ops.push({
					op: "set",
					path: [...base, key],
					value
				});
			}
			for (const key of Object.keys(previous)) if (!(key in after)) ops.push({
				op: "unset",
				path: [...base, key]
			});
			return ops;
		}
		/** Read a profile's credential reference, falling back to the derived one. */
		function apiKeyEnvOf(profile, route) {
			const named = typeof profile === "object" && profile !== null ? profile.apiKeyEnv : void 0;
			return typeof named === "string" && named.length > 0 ? named : deriveKeyRef(route);
		}
		/**
		 * Read a profile's declared protocol endpoints as editable rows.
		 *
		 * The document stores a protocol→URL map, which is the shape the host wants;
		 * the card edits an ordered list, because a map gives the user no stable row
		 * to edit or remove. Malformed values are dropped rather than shown as rows
		 * the host would reject.
		 * @param profile - the stored route profile.
		 * @returns one row per declared protocol, in declaration order.
		 */
		function endpointsOf(profile) {
			const declared = typeof profile === "object" && profile !== null ? profile.endpoints : void 0;
			if (typeof declared !== "object" || declared === null || Array.isArray(declared)) return [];
			return Object.entries(declared).filter(([, baseURL]) => typeof baseURL === "string").map(([api, baseURL]) => ({ api, baseURL }));
		}
		/**
		 * Hide the remote service behind bound callbacks. Each returns a failure
		 * message or a typed outcome rather than a transport error, so a component
		 * never has to know the wire shape of a refusal.
		 * @param ctx - client root context.
		 * @returns the write faces the card uses.
		 */
		function createOperations(ctx) {
			return {
				storeCredential: async (ref, value) => {
					const response = await ctx.remote.credentials.set(ref, value);
					return response.ok ? void 0 : response.error.message;
				},
				removeCredential: async (ref) => {
					const response = await ctx.remote.credentials.unset(ref);
					return response.ok ? void 0 : response.error.message;
				},
				writeSettings: async (ns, ops, expectedRevision) => {
					const response = await ctx.remote.settings.mutate(ns, ops, expectedRevision);
					if (response.ok) return {
						kind: "written",
						view: response.value
					};
					const { code, message } = response.error;
					return code === "settings/conflict" ? {
						kind: "conflict",
						message
					} : {
						kind: "refused",
						message
					};
				},
				discoverModels: async (settingsNs, request) => {
					const response = await ctx.remote.llm.discoverModels(settingsNs, request);
					return response.ok ? {
						kind: "found",
						models: response.value
					} : {
						kind: "refused",
						message: response.error.message
					};
				}
			};
		}
		//#endregion
		//#region store
		/**
		 * The card's data: the routes stored in this plugin's settings section, the
		 * document revision every write must match, and whether each route's
		 * credential is stored.
		 *
		 * Rows are read straight out of the settings describe answer rather than
		 * joined from the provider directory: these routes exist only as this
		 * section's dict entries, and the stored profile is exactly what the editor
		 * has to diff against.
		 */
		var AliasStore = class {
			constructor(ctx, ns, t) {
				this.ctx = ctx;
				this.ns = ns;
				this.t = t;
				this.listeners = /* @__PURE__ */ new Set();
				this.pending = void 0;
				this.disposed = false;
				this.state = {
					status: "idle",
					rows: [],
					revision: 0,
					writable: false,
					error: null,
					credentialError: null
				};
				/** Read the snapshot; the identity changes only when it publishes. */
				this.getSnapshot = () => this.state;
				/**
				 * Observe the snapshot, loading on the first observer. A page that never
				 * opens the Models section therefore never reads the settings document.
				 * @param listener - called after each publish.
				 * @returns the unsubscribe function.
				 */
				this.subscribe = (listener) => {
					this.listeners.add(listener);
					if (this.state.status === "idle") void this.load();
					return () => {
						this.listeners.delete(listener);
					};
				};
			}
			/** Publish one snapshot, replacing it rather than mutating it. */
			publish(patch) {
				if (this.disposed) return;
				this.state = {
					...this.state,
					...patch
				};
				for (const listener of [...this.listeners]) listener();
			}
			/** Stop accepting publishes and drop every observer. */
			dispose() {
				this.disposed = true;
				this.listeners.clear();
			}
			/**
			 * Refresh the whole snapshot. Concurrent callers share the read in flight,
			 * so a burst of pushed invalidations costs one round trip.
			 * @returns resolution after the snapshot is published.
			 */
			load() {
				if (this.pending !== void 0) return this.pending;
				this.pending = this.read().finally(() => {
					this.pending = void 0;
				});
				return this.pending;
			}
			/** Read the settings section, then the credentials its routes name. */
			async read() {
				this.publish({
					status: "loading",
					error: null
				});
				const described = await this.ctx.remote.settings.describe();
				if (!described.ok) {
					this.publish({
						status: "error",
						error: described.error.message
					});
					return;
				}
				const view = described.value;
				const namespace = view.namespaces.find((entry) => entry.ns === this.ns);
				if (namespace === void 0) {
					this.publish({
						status: "error",
						error: this.t("namespaceMissing")
					});
					return;
				}
				const aliases = typeof namespace.value?.aliases === "object" && namespace.value.aliases !== null ? namespace.value.aliases : {};
				const stored = typeof namespace.user?.aliases === "object" && namespace.user.aliases !== null ? namespace.user.aliases : {};
				const rows = Object.entries(aliases).filter(([, profile]) => typeof profile === "object" && profile !== null).map(([route, profile]) => ({
					route,
					profile,
					stored: stored[route],
					displayName: typeof profile.displayName === "string" && profile.displayName.length > 0 ? profile.displayName : route,
					api: typeof profile.api === "string" ? profile.api : PROTOCOLS[0],
					baseURL: typeof profile.baseURL === "string" ? profile.baseURL : "",
					endpoints: endpointsOf(profile),
					spec: typeof profile.spec === "string" && profile.spec.length > 0 ? profile.spec : void 0,
					modelCount: Array.isArray(profile.models) ? profile.models.length : 0,
					apiKeyEnv: apiKeyEnvOf(profile, route),
					credential: void 0
				}));
				const refs = [...new Set(rows.map((row) => row.apiKeyEnv))];
				const credentials = {};
				let credentialError = null;
				for (let index = 0; index < refs.length; index += 64) {
					const response = await this.ctx.remote.credentials.describe(refs.slice(index, index + 64));
					if (response.ok) Object.assign(credentials, response.value);
					else {
						credentialError = response.error.message;
						break;
					}
				}
				this.publish({
					status: "ready",
					error: null,
					credentialError,
					writable: view.writable,
					revision: namespace.revision,
					rows: rows.map((row) => credentials[row.apiKeyEnv] === void 0 ? row : {
						...row,
						credential: credentials[row.apiKeyEnv]
					})
				});
			}
		};
		//#endregion
		//#region ApiKeyInput
		/** Write-only credential input with the same reveal behaviour as masked conversation text. */
		function ApiKeyInput({ value, t, ...props }) {
			const [revealedValue, setRevealedValue] = react.useState();
			const revealed = value.length > 0 && revealedValue === value;
			return e("div", { className: c("keyInput") }, e("input", {
				...props,
				className: `${c("input")} ${value.length > 0 ? c("keyInputFilled") : ""}`,
				type: revealed ? "text" : "password",
				autoComplete: "new-password",
				value,
				onChange: (event) => {
					setRevealedValue(void 0);
					props.onChange?.(event);
				}
			}), value.length === 0 ? null : e("button", {
				type: "button",
				className: c("keyToggle"),
				"aria-label": t(revealed ? "keyHide" : "keyReveal"),
				"aria-pressed": revealed,
				disabled: props.disabled,
				onClick: () => {
					setRevealedValue(revealed ? void 0 : value);
				}
			}, e("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				"aria-hidden": "true"
			}, e("path", { d: revealed ? EYE_OFF_PATH : EYE_PATH }))));
		}
		//#endregion
		//#region EditorFooter
		/** One card's action row. */
		function EditorFooter(props) {
			const { t } = props;
			return e("div", { className: c("editorActions") }, e("button", {
				type: "button",
				className: c("secondaryButton"),
				disabled: props.busy,
				onClick: props.onCancel
			}, t(props.cancelLabelKey ?? "cancel")), e("button", {
				type: "button",
				className: c("primaryButton"),
				disabled: props.submitDisabled,
				onClick: props.onSubmit
			}, props.busy ? t(props.submitBusyLabelKey) : t(props.submitLabelKey)));
		}
		//#endregion
		//#region ModelRow
		/** One model entry: its identity on the first line, its capacities beneath. */
		function ModelRow(props) {
			const { model, index, disabled, t, onChange, onRemove, families } = props;
			const [editing, setEditing] = react.useState(() => /* @__PURE__ */ new Map());
			const selected = Array.isArray(model.input) && model.input.length > 0 ? model.input : ["text"];
			/** Replace one field, dropping it when cleared so it stays absent. */
			const update = (field, value) => {
				const next = { ...model };
				if (value === void 0) Reflect.deleteProperty(next, field);
				else next[field] = value;
				onChange(next);
			};
			/** The capacity text: live keystrokes, else the stored count spelled short. */
			const capacityText = (field) => {
				const typed = editing.get(field);
				if (typed !== void 0) return typed;
				const value = model[field];
				return typeof value === "number" ? formatCapacity(value) : "";
			};
			/** Record keystrokes and commit whatever they parse to. */
			const editCapacity = (field, text) => {
				setEditing((current) => {
					const next = new Map(current);
					next.set(field, text);
					return next;
				});
				const parsed = parseCapacity(text);
				update(field, parsed === void 0 || Number.isNaN(parsed) ? void 0 : parsed);
			};
			/** Drop the keystroke text once it parses, so the field shows the stored form. */
			const settleCapacity = (field) => {
				setEditing((current) => {
					const typed = current.get(field);
					if (typed === void 0) return current;
					const parsed = parseCapacity(typed);
					if (parsed !== void 0 && Number.isNaN(parsed)) return current;
					const next = new Map(current);
					next.delete(field);
					return next;
				});
			};
			/** Add or remove one modality, keeping a nonempty set. */
			const toggleInput = (modality, on) => {
				update("input", ["text", "image"].filter((value) => value === modality ? on : selected.includes(value)));
			};
			const capacityField = (field) => e("div", { className: c("modelField") }, e("span", { className: c("modelFieldLabel") }, t(field)), e("input", {
				className: c("input"),
				type: "text",
				inputMode: "numeric",
				value: capacityText(field),
				placeholder: CAPACITY_HINT[field],
				"aria-label": `${t(field)} ${String(index + 1)}`,
				disabled,
				onChange: (event) => {
					editCapacity(field, event.target.value);
				},
				onBlur: () => {
					settleCapacity(field);
				}
			}));
			const removeButton = e("button", {
				type: "button",
				className: `${c("iconButton")} ${c("iconButtonDanger")}`,
				"aria-label": t("removeModel"),
				title: t("removeModel"),
				disabled,
				onClick: onRemove
			}, e(dsh_client_ui_primitives.IconTrashOutlineRegular, { size: 14 }));
			const idInput = e("input", {
				className: c("input"),
				type: "text",
				value: typeof model.id === "string" ? model.id : "",
				placeholder: "model-id",
				"aria-label": `${t("modelId")} ${String(index + 1)}`,
				disabled,
				onChange: (event) => {
					update("id", event.target.value);
				},
				onBlur: (event) => {
					const trimmed = event.target.value.trim();
					if (trimmed !== event.target.value) update("id", trimmed);
				}
			});
			const nameInput = e("input", {
				className: c("input"),
				type: "text",
				value: typeof model.name === "string" ? model.name : "",
				placeholder: t("modelName"),
				"aria-label": `${t("modelName")} ${String(index + 1)}`,
				disabled,
				onChange: (event) => {
					update("name", event.target.value.length === 0 ? void 0 : event.target.value);
				}
			});
			const idField = e("div", { className: c("modelField") }, e("span", { className: c("modelFieldLabel") }, t("modelId")), idInput);
			const nameField = e("div", { className: `${c("modelField")} ${c("modelName")}` }, e("span", { className: c("modelFieldLabel") }, t("modelName")), nameInput);
			const identity = e("div", { className: c("modelRow") }, removeButton, idField, nameField);
			const staleProtocol = typeof model.api === "string" && model.api.length > 0 && families !== void 0 && !families.includes(model.api) ? model.api : void 0;
			/**
			 * The per-model endpoint. It is the escape hatch for a row that cannot
			 * name a declared protocol — the host serves such a row from its own
			 * `baseURL` — and it is shown wherever a route offers more than one
			 * protocol, because that is where pinning one row elsewhere is useful. A
			 * row whose protocol is no longer declared keeps the field too, because the
			 * refusal it carries tells the user to give that row its own endpoint.
			 * An ordinary single-protocol route stays as terse as before.
			 */
			const showEndpoint = model.baseURL !== void 0 || families !== void 0 && families.length > 1 || staleProtocol !== void 0;
			const endpointField = showEndpoint ? e("div", { className: `${c("modelField")} ${c("modelWide")}` }, e("span", { className: c("modelFieldLabel") }, t("modelBaseUrl")), e("input", {
				className: c("input"),
				type: "text",
				value: typeof model.baseURL === "string" ? model.baseURL : "",
				placeholder: protocolPlaceholder(t, typeof model.api === "string" ? model.api : void 0),
				"aria-label": `${t("modelBaseUrl")} ${String(index + 1)}`,
				disabled,
				onChange: (event) => {
					update("baseURL", event.target.value.length === 0 ? void 0 : event.target.value);
				},
				onBlur: (event) => {
					const trimmed = event.target.value.trim();
					if (trimmed !== event.target.value) update("baseURL", trimmed.length === 0 ? void 0 : trimmed);
				}
			})) : null;
			const choices = ["text", "image"].map((modality) => e(dsh_client_ui_primitives.Checkbox, {
				key: modality,
				label: t(modality === "text" ? "modelInputText" : "modelInputImage"),
				checked: selected.includes(modality),
				disabled: disabled || selected.length === 1 && selected.includes(modality),
				onChange: (on) => {
					toggleInput(modality, on);
				}
			}));
			const inputTypes = e("fieldset", {
				className: c("modelInputTypes"),
				"aria-label": `${t("modelInputTypes")} ${String(index + 1)}`
			}, e("legend", { className: c("modelFieldLabel") }, t("modelInputTypes")), e("div", { className: c("modelInputChoices") }, choices));
			/**
			 * The protocol override. It appears only once the route declares more than
			 * one protocol: at that point a row has to be able to name the family it
			 * belongs to, and a row that names none follows the route's default. A row
			 * holding a protocol that is no longer declared keeps it in the list, so
			 * the control shows what the row actually says instead of going blank; a
			 * protocol this build cannot serve at all is labelled as such.
			 */
			const familyChoices = families === void 0 ? void 0 : staleProtocol === void 0 ? families : families.concat([staleProtocol]);
			const familyField = familyChoices === void 0 || familyChoices.length <= 1 ? null : e("div", { className: c("modelField") }, e("span", { className: c("modelFieldLabel") }, t("modelProtocol")), e("select", {
				className: `${c("input")} ${c("selectInput")}`,
				value: typeof model.api === "string" ? model.api : "",
				"aria-label": `${t("modelProtocol")} ${String(index + 1)}`,
				disabled,
				onChange: (event) => {
					update("api", event.target.value.length === 0 ? void 0 : event.target.value);
				}
			}, [e("option", {
				value: "",
				key: ""
			}, t("modelProtocolInherit"))].concat(familyChoices.map((choice) => e("option", {
				value: choice,
				key: choice
			}, PROTOCOLS.includes(choice) ? protocolLabel(t, choice) : fmt(t("protocolUnsupported"), { protocol: choice }))))));
			// The declared thinking levels, edited in the host's own vocabulary.
			const [reasoningTyping, setReasoningTyping] = react.useState();
			/**
			 * Where the row sends its thinking-level declaration.
			 *
			 * A model's level map is the only way to say how this route's gateway
			 * spells a level — the protocol alone cannot express it — so the editor
			 * pairs each level with the value that goes on the wire. It only offers
			 * levels the host resolves and the selected protocol can send: a level the
			 * host does not know would make the document unsaveable, and a level the
			 * protocol cannot send would fail on the first message instead of here.
			 */
			const reasoning = reasoningEntries(model);
			const reasoningApi = typeof model.api === "string" && model.api.length > 0 ? model.api : families?.[0];
			const reasoningChoices = reasoningLevels(reasoningApi);
			const reasoningUsed = reasoning === void 0 ? [] : reasoning.map(([level]) => level);
			const reasoningFaultKey = reasoning === void 0 ? void 0 : reasoningFault(reasoning, reasoningApi);
			/** Rewrite the whole declaration, one entry per row. */
			const writeReasoning = (entries) => {
				onChange(withReasoningEntries(model, entries));
			};
			/** Replace one row's entry in place. */
			const replaceReasoning = (entries, at, entry) => {
				writeReasoning(entries.map((existing, index) => index === at ? entry : existing));
			};
			/**
			 * Move a row to another level, keeping its wire value only when that value
			 * was the row's own spelling of its own level: a spelling typed for one
			 * level says nothing about the next.
			 */
			const changeReasoningLevel = (entries, at, from, value, to) => {
				const keep = typeof value === "string" && value.length > 0 && value !== from && from !== "off" && to !== "off";
				replaceReasoning(entries, at, [to, keep ? value : defaultReasoningValue(to)]);
			};
			/**
			 * Record keystrokes into the document, trimmed, while the field shows the
			 * raw text — so the value the card saves is the one the gateway will read.
			 */
			const editReasoningValue = (entries, at, level, text) => {
				setReasoningTyping({
					level,
					text
				});
				const trimmed = text.trim();
				replaceReasoning(entries, at, [level, trimmed.length === 0 ? defaultReasoningValue(level) : trimmed]);
			};
			/** Drop the keystroke text, repairing a value the host would refuse. */
			const settleReasoningValue = (entries, at, level, value) => {
				setReasoningTyping(void 0);
				if (!acceptedReasoningValue(level, value)) replaceReasoning(entries, at, [level, defaultReasoningValue(level)]);
			};
			/**
			 * What a row's selector offers: its own level first even when this protocol
			 * does not allow it — hiding it would misreport what the document says and
			 * leave no way to correct it — then every allowed level nobody has taken.
			 */
			const reasoningChoicesFor = (level) => [...reasoningChoices.includes(level) ? [] : [level], ...reasoningChoices.filter((choice) => choice === level || !reasoningUsed.includes(choice))];
			/** Add the lowest unused level above the highest one already declared. */
			const addReasoningLevel = (entries) => {
				const used = entries.map(([level]) => level);
				const highest = Math.max(-1, ...used.map((level) => reasoningChoices.indexOf(level)));
				const level = reasoningChoices.find((candidate, index) => index > highest && !used.includes(candidate)) ?? reasoningChoices.find((candidate) => !used.includes(candidate));
				if (level === void 0) return;
				writeReasoning(entries.concat([[level, defaultReasoningValue(level)]]));
			};
			const reasoningHeaderRow = reasoning === void 0 || reasoning.length === 0 ? null : e("div", { className: c("modelReasoningRow"), "aria-hidden": "true" }, e("span", { className: c("modelFieldLabel") }, t("modelReasoningLevel")), e("span", { className: c("modelFieldLabel") }, t("modelReasoningValue")));
			const reasoningRows = reasoning === void 0 ? [] : reasoning.map(([level, wire], at) => e("div", { className: c("modelReasoningRow"), key: level }, e("select", {
				className: `${c("input")} ${c("selectInput")}`,
				value: level,
				"aria-label": `${t("modelReasoningLevel")} ${String(at + 1)}`,
				disabled,
				onChange: (event) => {
					changeReasoningLevel(reasoning, at, level, wire, event.target.value);
				}
			}, reasoningChoicesFor(level).map((choice) => e("option", {
				value: choice,
				key: choice
			}, reasoningLevelLabel(t, choice)))), e("input", {
				className: `${c("input")} ${c("modelReasoningValue")}`,
				type: "text",
				value: reasoningTyping !== void 0 && reasoningTyping.level === level ? reasoningTyping.text : typeof wire === "string" ? wire : "",
				placeholder: level === "off" ? t("modelReasoningOffValuePlaceholder") : level,
				"aria-label": `${reasoningLevelLabel(t, level)} ${t("modelReasoningValue")}`,
				"aria-invalid": !acceptedReasoningValue(level, wire),
				disabled: disabled || level === "off",
				onChange: (event) => {
					editReasoningValue(reasoning, at, level, event.target.value);
				},
				onBlur: () => {
					settleReasoningValue(reasoning, at, level, wire);
				}
			}), e("button", {
				type: "button",
				className: `${c("iconButton")} ${c("iconButtonDanger")}`,
				"aria-label": `${t("modelReasoningRemove")} ${reasoningLevelLabel(t, level)}`,
				title: t("modelReasoningRemove"),
				disabled,
				onClick: () => {
					writeReasoning(reasoning.filter((_entry, index) => index !== at));
				}
			}, e(dsh_client_ui_primitives.IconTrashOutlineRegular, { size: 14 }))));
			const reasoningError = reasoningFaultKey === void 0 ? null : e("p", { className: c("error") }, t(reasoningFaultKey));
			const reasoningAdd = e("button", {
				type: "button",
				className: c("addModelButton"),
				disabled: disabled || reasoningChoices.every((level) => reasoningUsed.includes(level)),
				onClick: () => {
					if (reasoning !== void 0) addReasoningLevel(reasoning);
				}
			}, e(dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 14 }), t("modelReasoningAdd"));
			const reasoningBlock = e("div", {
				className: c("modelReasoning"),
				role: "group",
				"aria-label": t("modelReasoning")
			}, e("div", { className: c("modelReasoningHead") }, e("span", { className: c("modelFieldLabel") }, t("modelReasoning")), e(dsh_client_ui_primitives.Switch, {
				checked: reasoning !== void 0,
				label: t("modelReasoning"),
				disabled,
				onChange: (on) => {
					writeReasoning(on ? reasoningChoices.filter((level) => INITIAL_REASONING_LEVELS.includes(level)).map((level) => [level, defaultReasoningValue(level)]) : void 0);
				}
			})), reasoning === void 0 ? null : e("p", { className: c("advancedHint") }, reasoningApi === "google-generative-ai" ? `${t("modelReasoningHelp")} ${t("modelReasoningGoogleHelp")}` : t("modelReasoningHelp")), reasoningHeaderRow, ...reasoningRows, reasoning === void 0 ? null : reasoningError, reasoning === void 0 ? null : reasoningAdd);
			const capacities = e("div", { className: c("modelAdvanced") }, capacityField("contextWindow"), capacityField("maxTokens"), inputTypes, familyField, reasoningBlock, endpointField);
			return e("div", { className: c("modelEntry") }, identity, capacities);
		}
		//#endregion
		//#region CandidatePanel
		/**
		 * The endpoint's advertised models, offered inline: picking one proposes
		 * configuration, it never writes behind the user's back.
		 */
		function CandidatePanel(props) {
			const { candidates, checked, onCheck, onCancel, onAdopt, t } = props;
			const [search, setSearch] = react.useState("");
			const needle = search.trim().toLowerCase();
			const shown = candidates.filter((candidate) => needle.length === 0 || candidate.id.toLowerCase().includes(needle) || (candidate.name ?? "").toLowerCase().includes(needle));
			const row = (candidate) => e("li", { className: c("candidate"), key: candidate.id }, e("label", { className: c("candidateLabel") }, e("input", {
				type: "checkbox",
				checked: checked.has(candidate.id),
				onChange: () => {
					onCheck(candidate.id, !checked.has(candidate.id));
				}
			}), e("span", {
				className: c("candidateId"),
				title: candidate.name ?? candidate.id
			}, candidate.id)));
			const heading = e("div", { className: c("modelCatalogHeading") }, e("span", { className: c("modelCatalogTitle") }, t("fetchTitle")), e("span", { className: c("modelCatalogMeta") }, fmt(t("modelCount"), { count: String(candidates.length) })));
			const searchInput = e("input", {
				className: `${c("input")} ${c("candidateSearch")}`,
				type: "text",
				value: search,
				placeholder: t("fetchSearch"),
				"aria-label": t("fetchSearch"),
				onChange: (event) => {
					setSearch(event.target.value);
				}
			});
			const selectAll = e("button", {
				type: "button",
				className: c("linkButton"),
				onClick: () => {
					for (const candidate of shown) onCheck(candidate.id, true);
				}
			}, t("fetchSelectAll"));
			const deselectAll = e("button", {
				type: "button",
				className: c("linkButton"),
				onClick: () => {
					for (const candidate of shown) onCheck(candidate.id, false);
				}
			}, t("fetchDeselectAll"));
			const list = shown.length === 0 ? e("p", { className: c("candidateEmpty") }, t("fetchNoMatches")) : e("ul", { className: c("candidateList") }, shown.map(row));
			const actions = e("div", { className: c("editorActions") }, e("button", {
				type: "button",
				className: c("secondaryButton"),
				onClick: onCancel
			}, t("cancel")), e("button", {
				type: "button",
				className: c("primaryButton"),
				disabled: checked.size === 0,
				onClick: onAdopt
			}, t("fetchAdopt")));
			return e("div", { className: c("inlinePanel") }, heading, e("div", { className: c("candidateToolbar") }, searchInput, selectAll, deselectAll), list, actions);
		}
		//#endregion
		//#region ModelListEditor
		/**
		 * The model rows of one route, plus the action that asks the endpoint what it
		 * serves.
		 *
		 * Every capacity a catalog route would inherit is written on the row here, so a
		 * blank capacity field means the route default rather than "unknown"; the
		 * placeholders show that default in the same K/M vocabulary the field accepts.
		 * The probe interrogates the endpoint the form currently shows — including a
		 * key typed but not yet saved.
		 */
		function ModelListEditor(props) {
			const { models, onChange, disabled, t, probe, operations } = props;
			const [fetching, setFetching] = react.useState(false);
			const [candidates, setCandidates] = react.useState();
			const [checked, setChecked] = react.useState(() => /* @__PURE__ */ new Set());
			const [fetchFailure, setFetchFailure] = react.useState();
			/**
			 * Which family the probe interrogates. A single-protocol route has exactly
			 * one, so the selector does not appear at all; a gateway route fetches each
			 * family from its own endpoint, because the Google side lists different
			 * models at a different path than the OpenAI side.
			 */
			const families = probe.families;
			const [fetchApi, setFetchApi] = react.useState(families[0]?.api);
			/**
			 * The protocol the open candidate list was actually fetched for. It is
			 * remembered separately from the selector because editing the protocol
			 * endpoints can retarget or remove the fetched family while the panel is
			 * open; adopting must then still stamp the listing's own protocol rather
			 * than whatever the selector now points at.
			 */
			const [fetchedApi, setFetchedApi] = react.useState();
			const family = families.find((entry) => entry.api === fetchApi) ?? families[0];
			/**
			 * Whether asking this family for its model list is a question it answers.
			 *
			 * A gateway spec whose protocol surface publishes no listing is known from
			 * the table above, and a family that already refused with the host's
			 * no-listing prefix is known from that refusal — the two halves of one
			 * cross-file contract. Either way the action is not offered: a control that
			 * can only ever reproduce the same failure is a trap, and hand entry below
			 * is the way. The listing itself is unobservable, not merely unavailable —
			 * asking the Google surface for a model it does not serve answers the same
			 * missing-session error as a model it does serve, so a fetched list could
			 * not be trusted even if one were returned.
			 */
			const noListing = SPECS_WITHOUT_LISTING[probe.spec]?.includes(family.api) === true || fetchFailure !== void 0 && fetchFailure.startsWith(NO_LISTING_PREFIX);
			/**
			 * A candidate list outlives its family only by accident. When the family
			 * it came from stops being declared, the offer is withdrawn: its models
			 * cannot be served where they came from, and there is no endpoint left to
			 * stamp them with.
			 */
			react.useEffect(() => {
				if (candidates === void 0 || fetchedApi === void 0) return;
				if (families.some((entry) => entry.api === fetchedApi)) return;
				setCandidates(void 0);
				setChecked(/* @__PURE__ */ new Set());
				setFetchedApi(void 0);
			}, [candidates, families, fetchedApi]);
			/** Interrogate the drafted endpoint and offer what it advertises. */
			const fetchModels = async () => {
				setFetchFailure(void 0);
				setFetching(true);
				try {
					const outcome = await operations.discoverModels(probe.settingsNs, {
						...family.baseURL.length === 0 ? {} : { baseURL: family.baseURL },
						api: family.api,
						/**
						 * The route this probe belongs to, so the host can apply what the
						 * profile already holds — its `headers` and its stored credential —
						 * instead of the card re-implementing either. A draft route is not
						 * stored yet, and then the request carries its own key or nothing.
						 */
						...probe.provider === void 0 ? {} : { provider: probe.provider },
						...probe.apiKey === void 0 ? {} : { apiKey: probe.apiKey }
					});
					if (outcome.kind !== "found") {
						setFetchFailure(outcome.message);
						return;
					}
					const configured = new Set(models.map((model) => model.id));
					setFetchedApi(family.api);
					setCandidates(outcome.models);
					/**
					 * A route that lists nothing yet has nothing to overwrite, so the
					 * reply is offered already checked — that is the common "this
					 * endpoint serves these models" case, one click to accept. A route
					 * that does list models keeps only its own checked, so a reply can
					 * never silently replace a hand-tuned row.
					 */
					setChecked(new Set(models.length === 0 ? outcome.models.map((candidate) => candidate.id) : outcome.models.filter((candidate) => configured.has(candidate.id)).map((candidate) => candidate.id)));
				} finally {
					setFetching(false);
				}
			};
			/** Adopt the checked candidates, keeping configured rows the reply omits. */
			const adopt = () => {
				const byId = new Map(models.map((model) => [model.id, model]));
				const listed = new Set(candidates.map((candidate) => candidate.id));
				const kept = models.filter((model) => !listed.has(model.id));
				const adopted = candidates.filter((candidate) => checked.has(candidate.id)).map((candidate) => {
					const existing = byId.get(candidate.id);
					const name = existing?.name ?? candidate.name;
					const contextWindow = existing?.contextWindow ?? candidate.contextWindow;
					const maxTokens = existing?.maxTokens ?? candidate.maxTokens;
					const input = existing?.input ?? candidate.inputModalities;
					const record = {
						...existing === void 0 ? {} : { ...existing },
						__row: existing?.__row ?? mintRowId(),
						id: candidate.id,
						...name === void 0 ? {} : { name },
						...contextWindow === void 0 ? {} : { contextWindow },
						...maxTokens === void 0 ? {} : { maxTokens },
						...input === void 0 ? {} : { input: [...input] }
					};
					/**
					 * The protocol is stamped from the family that was fetched, not left to
					 * the route default: a model adopted from the Google listing must keep
					 * speaking Google after the form is saved. A model from the default
					 * family carries no `api` at all, which is the inherited case.
					 */
					const stamped = fetchedApi ?? family.api;
					if (stamped === probe.defaultApi) Reflect.deleteProperty(record, "api");
					else record.api = stamped;
					/**
					 * A row that changes protocol also loses the endpoint it pinned for the
					 * other protocol: keeping it would send an OpenAI-shaped model to the
					 * Google address it used to speak to. The row then follows the endpoint
					 * of the protocol it was just adopted under.
					 */
					if (existing !== void 0 && typeof existing.api === "string" && existing.api.length > 0 && existing.api !== stamped) Reflect.deleteProperty(record, "baseURL");
					return record;
				});
				onChange([...kept, ...adopted]);
				setCandidates(void 0);
				setFetchedApi(void 0);
			};
			const familySelect = families.length <= 1 ? null : e("select", {
				className: `${c("input")} ${c("selectInput")} ${c("fetchFamily")}`,
				value: family.api,
				"aria-label": t("fetchFamily"),
				disabled: disabled || fetching,
				onChange: (event) => {
					setFetchApi(event.target.value);
					setCandidates(void 0);
					setFetchedApi(void 0);
					setFetchFailure(void 0);
				}
			}, families.map((entry) => e("option", {
				value: entry.api,
				key: entry.api
			}, protocolLabel(t, entry.api))));
			const heading = e("div", { className: c("modelListHead") }, e("div", { className: c("modelCatalogHeading") }, e("span", { className: c("modelCatalogTitle") }, t("models")), e("span", { className: c("modelCatalogMeta") }, fmt(t("modelCount"), { count: String(models.length) }))), e("div", {
				className: c("modelListActions")
			}, familySelect, noListing ? null : e("button", {
				type: "button",
				className: c("linkButton"),
				disabled: disabled || fetching || family.blocked !== void 0,
				onClick: () => {
					fetchModels();
				}
			}, fetching ? t("fetching") : t("fetchModels"))));
			const rows = models.map((model, index) => e(ModelRow, {
				/**
				 * Keyed by the row's own identity, not by its position or its id: a
				 * position key would hand a removed row's typed-but-unparsed capacity text
				 * to its neighbour, and an id key would remount the row (dropping focus)
				 * once per keystroke. The marker never reaches the document.
				 */
				key: model.__row ?? String(index),
				model,
				index,
				disabled,
				t,
				families: families.map((entry) => entry.api),
				onChange: (next) => {
					onChange(models.map((entry, at) => at === index ? next : { ...entry }));
				},
				onRemove: () => {
					onChange(models.filter((_entry, at) => at !== index).map((entry) => ({ ...entry })));
				}
			}));
			const list = models.length === 0 ? e("p", { className: c("modelEmpty") }, t(noListing ? "modelsEmptyManual" : "modelsEmpty")) : e("div", { className: c("modelList") }, rows);
			const addModel = e("button", {
				type: "button",
				className: c("addModelButton"),
				disabled,
				onClick: () => {
					onChange([...models.map((model) => ({ ...model })), { id: "", __row: mintRowId() }]);
				}
			}, e(dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 14 }), t("addModel"));
			const noListingHint = noListing ? e("p", { className: c("advancedHint") }, t("noModelListing")) : null;
			const blocked = family.blocked !== void 0 && candidates === void 0 ? e("p", { className: c("advancedHint") }, t(family.blocked)) : null;
			/**
			 * A no-listing refusal is not a failure to report: the hint above already
			 * says this endpoint publishes no list, and the action that produced the
			 * refusal is gone with it.
			 */
			const failure = fetchFailure === void 0 || noListing ? null : e("p", { className: c("error") }, fetchFailure);
			const panel = candidates === void 0 ? null : e(CandidatePanel, {
				candidates,
				checked,
				t,
				onCheck: (id, on) => {
					setChecked((current) => {
						const next = new Set(current);
						if (on) next.add(id);
						else next.delete(id);
						return next;
					});
				},
				onCancel: () => {
					setCandidates(void 0);
					setFetchedApi(void 0);
				},
				onAdopt: adopt
			});
			return e("section", { className: c("modelCatalog"), "aria-label": t("models") }, heading, list, addModel, noListingHint, blocked, failure, panel);
		}
		//#endregion
		//#region Editor
		/**
		 * One route's form: the create card and the edit card, which share every field
		 * but the route id — chosen on create, fixed afterwards because it is the
		 * record's address.
		 *
		 * The spec selector is the field this card exists for. A route's protocol and
		 * endpoint say where requests go and in what dialect; a spec says what the
		 * endpoint additionally demands of each request, which no URL can express.
		 */
		function Editor(props) {
			const { initial, edit, taken, revision, operations, t, ns, readOnly, onClose } = props;
			const [route, setRoute] = react.useState(initial.route);
			const [displayName, setDisplayName] = react.useState(initial.displayName);
			const [baseURL, setBaseURL] = react.useState(initial.baseURL);
			const [protocol, setProtocol] = react.useState(initial.api);
			const [spec, setSpec] = react.useState(initial.spec ?? "");
			const [keyDraft, setKeyDraft] = react.useState("");
			const [models, setModels] = react.useState(() => initial.models.map(withRowId));
			const [endpoints, setEndpoints] = react.useState(() => (initial.endpoints ?? []).map((entry) => ({ ...entry })));
			const [busy, setBusy] = react.useState(false);
			const [failure, setFailure] = react.useState();
			const [committed, setCommitted] = react.useState(false);
			const editorRef = react.useRef(null);
			/**
			 * The editor opens below the section's add control, which on a long
			 * models page can sit under the fold. Bring it into view once, without
			 * stealing focus from anything the user already started typing in.
			 */
			react.useEffect(() => {
				const node = editorRef.current;
				if (node === null) return;
				node.scrollIntoView({ block: "nearest", behavior: "smooth" });
			}, []);
			const disabled = readOnly || busy;
			/** Everything but the key stops being editable once the profile exists. */
			const profileDisabled = disabled || committed;
			const routeInvalid = route.length > 0 && !ROUTE_PATTERN.test(route);
			const routeTaken = edit ? false : taken.includes(route);
			const normalizedBaseURL = baseURL.trim();
			const baseUrlFault = baseURL.length > 0 ? endpointUrlFault(normalizedBaseURL) : void 0;
			const baseUrlInvalid = baseUrlFault !== void 0;
			/** The declared protocol endpoints, with their URLs trimmed for saving. */
			const endpointEntries = endpoints.map((entry) => ({ api: entry.api, baseURL: entry.baseURL.trim() }));
			/**
			 * Why the declared protocol endpoints cannot be saved, if they cannot: the
			 * route's own protocol already has its endpoint, so it may not be declared
			 * twice, and every row needs an http(s) URL. Checked before the save so a
			 * rejected write never has to be discovered as a failure message.
			 */
			const endpointFailure = (() => {
				const seen = new Set([protocol]);
				for (const entry of endpointEntries) {
					if (!PROTOCOLS.includes(entry.api)) return "endpointProtocolUnsupported";
					if (seen.has(entry.api)) return "endpointDuplicateProtocol";
					seen.add(entry.api);
					if (entry.baseURL.length === 0) return "endpointUrlRequired";
					const entryFault = endpointUrlFault(entry.baseURL);
					if (entryFault !== void 0) return endpointFaultKey(entryFault, "endpointUrlInvalid");
				}
				return void 0;
			})();
			/** Every protocol this route can serve a model under. */
			const families = [protocol].concat(endpointEntries.map((entry) => entry.api));
			const modelFailure = validateModels(models, families);
			const keyFailure = apiKeyFailure(keyDraft);
			const keyValue = keyDraft.trim();
			const storesKey = keyValue.length > 0;
			const keyRef = edit ? initial.apiKeyEnv ?? deriveKeyRef(initial.route) : deriveKeyRef(route);
			const ready = route.length > 0 && !routeInvalid && !routeTaken && normalizedBaseURL.length > 0 && !baseUrlInvalid && models.length > 0 && modelFailure === void 0 && keyFailure === void 0 && endpointFailure === void 0;
			let hint;
			if (ready || failure !== void 0 || keyFailure !== void 0 || endpointFailure !== void 0 || route.length === 0 || routeInvalid || routeTaken || baseUrlInvalid) hint = void 0;
			else if (normalizedBaseURL.length === 0) hint = t("needsBaseUrl");
			else if (modelFailure !== void 0) hint = `${t("model")} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`;
			else hint = t("needsModels");
			/** The profile this form describes, carrying over fields the card cannot show. */
			const profileAfter = () => {
				const trimmedName = displayName.trim();
				const cleanModels = models.map((model) => {
					const copy = { ...model };
					Reflect.deleteProperty(copy, "__row");
					/**
					 * A row that follows the route's own protocol carries no `api` at all:
					 * the saved document then says "the route default" rather than pinning a
					 * value that would have to be edited if the default ever changes.
					 */
					if (copy.api === protocol || typeof copy.api !== "string" || copy.api.length === 0) Reflect.deleteProperty(copy, "api");
					const ownBaseUrl = typeof copy.baseURL === "string" ? copy.baseURL.trim() : copy.baseURL;
					if (ownBaseUrl === void 0 || ownBaseUrl.length === 0) Reflect.deleteProperty(copy, "baseURL");
					else copy.baseURL = ownBaseUrl;
					return copy;
				});
				const endpointMap = endpointEntries.length === 0 ? void 0 : Object.fromEntries(endpointEntries.map((entry) => [entry.api, entry.baseURL]));
				if (!edit) return {
					...trimmedName.length === 0 ? {} : { displayName: trimmedName },
					...storesKey ? { apiKeyEnv: keyRef } : {},
					api: protocol,
					baseURL: normalizedBaseURL,
					...endpointMap === void 0 ? {} : { endpoints: endpointMap },
					...spec.length === 0 ? {} : { spec },
					models: cleanModels
				};
				const after = { ...initial.stored };
				const setOrDrop = (key, value) => {
					if (value === void 0) Reflect.deleteProperty(after, key);
					else after[key] = value;
				};
				setOrDrop("displayName", trimmedName.length === 0 ? void 0 : trimmedName);
				setOrDrop("api", protocol);
				setOrDrop("baseURL", normalizedBaseURL);
				setOrDrop("endpoints", endpointMap);
				setOrDrop("spec", spec.length === 0 ? void 0 : spec);
				setOrDrop("models", cleanModels);
				if (initial.apiKeyEnv === void 0 && storesKey) after.apiKeyEnv = keyRef;
				return after;
			};
			/** Perform the write, returning a failure message or undefined. */
			const commitOnce = async () => {
				if (!committed) {
					const after = profileAfter();
					const ops = edit ? pathOps(["aliases", initial.route], initial.stored, after) : [{
						op: "set",
						path: ["aliases", route],
						value: after
					}];
					if (ops.length > 0) {
						const written = await operations.writeSettings(ns, ops, revision);
						if (written.kind !== "written") return written.kind === "conflict" ? t("conflict") : written.message;
					}
					setCommitted(true);
				}
				if (storesKey) {
					const stored = await operations.storeCredential(keyRef, keyValue);
					if (stored !== void 0) return stored;
				}
				return void 0;
			};
			const submit = async () => {
				setBusy(true);
				setFailure(void 0);
				try {
					const outcome = await commitOnce();
					if (outcome !== void 0) {
						setFailure(outcome);
						return;
					}
					onClose(true);
				} finally {
					setBusy(false);
				}
			};
			const field = (label, key, input) => e("div", { className: c("field"), key }, e("span", { className: c("fieldLabel") }, label), input);
			const header = e("div", { className: c("editorHeader") }, e("span", { className: c("editorTitle") }, edit ? t("editProvider") : t("createProvider")), edit ? e("span", { className: c("editorRoute") }, initial.route) : null);
			const routeField = field(t("route"), "route", e("input", {
				className: c("input"),
				type: "text",
				value: route,
				placeholder: "opencode-go-2",
				"aria-label": t("route"),
				"aria-invalid": routeInvalid || routeTaken,
				disabled: profileDisabled,
				onChange: (event) => {
					setRoute(event.target.value);
				}
			}));
			const routeMessage = routeInvalid || routeTaken ? e("p", {
				className: c("error"),
				key: "route-error"
			}, t(routeInvalid ? "routeInvalid" : "routeTaken")) : e("p", {
				className: c("advancedHint"),
				key: "route-hint"
			}, t("routeHint"));
			const nameField = field(t("displayName"), "displayName", e("input", {
				className: c("input"),
				type: "text",
				value: displayName,
				placeholder: route.length === 0 ? t("displayName") : route,
				"aria-label": t("displayName"),
				disabled: profileDisabled,
				onChange: (event) => {
					setDisplayName(event.target.value);
				}
			}));
			const baseURLField = field(t("baseUrl"), "baseUrl", e("input", {
				className: c("input"),
				type: "text",
				value: baseURL,
				placeholder: protocolPlaceholder(t, protocol),
				"aria-label": t("baseUrl"),
				"aria-invalid": baseUrlInvalid,
				disabled: profileDisabled,
				onChange: (event) => {
					setBaseURL(event.target.value);
				}
			}));
			const baseURLError = baseUrlInvalid ? e("p", { className: c("error"), key: "baseurl-error" }, t(endpointFaultKey(baseUrlFault, "baseUrlInvalid"))) : null;
			const protocolOptions = PROTOCOLS.map((choice) => e("option", {
				value: choice,
				key: choice
			}, protocolLabel(t, choice)));
			const protocolField = field(t("api"), "api", e("select", {
				className: `${c("input")} ${c("selectInput")}`,
				value: protocol,
				"aria-label": t("api"),
				disabled: profileDisabled,
				onChange: (event) => {
					setProtocol(event.target.value);
				}
			}, protocolOptions));
			const protocolHintValue = protocolHint(t, protocol);
			const protocolHintLine = protocolHintValue === void 0 ? null : e("p", { className: c("advancedHint"), key: "protocol-hint" }, protocolHintValue);
			/**
			 * The protocol-endpoint editor, for a gateway that serves more than one wire
			 * API at a different path for each. A row pins one protocol to its own
			 * endpoint; the model rows then choose among the declared protocols. An
			 * empty list is the ordinary single-protocol route, so the block stays and
			 * explains itself instead of disappearing with a hidden feature.
			 */
			const unusedProtocols = PROTOCOLS.filter((choice) => !families.includes(choice));
			/**
			 * The options one endpoint row may choose. The row's own value is always
			 * offered, even when this build does not serve it: a stored document can
			 * name anything, and a select whose value matches no option shows nothing
			 * while the row is still about to be saved. The unsupported value is
			 * labelled as such and the row is refused, so the fault is visible before
			 * the write rather than after it.
			 */
			const endpointProtocolOptions = (value) => {
				const options = PROTOCOLS.filter((choice) => choice === value || !families.includes(choice)).map((choice) => e("option", {
					value: choice,
					key: choice
				}, protocolLabel(t, choice)));
				if (!PROTOCOLS.includes(value)) options.unshift(e("option", {
					value,
					key: value
				}, fmt(t("protocolUnsupported"), { protocol: value })));
				return options;
			};
			const endpointRows = endpointEntries.map((entry, index) => e("div", {
				className: c("endpointRow"),
				key: String(index)
			}, e("select", {
				className: `${c("input")} ${c("selectInput")}`,
				value: entry.api,
				"aria-label": t("endpointProtocol"),
				disabled: profileDisabled,
				onChange: (event) => {
					const value = event.target.value;
					setEndpoints((current) => current.map((row, at) => at === index ? {
						...row,
						api: value
					} : row));
				}
			}, endpointProtocolOptions(entry.api)), e("input", {
				className: `${c("input")} ${c("endpointUrl")}`,
				type: "text",
				value: endpoints[index].baseURL,
				placeholder: protocolPlaceholder(t, entry.api),
				"aria-label": t("endpointUrl"),
				disabled: profileDisabled,
				onChange: (event) => {
					const value = event.target.value;
					setEndpoints((current) => current.map((row, at) => at === index ? {
						...row,
						baseURL: value
					} : row));
				}
			}), e("button", {
				type: "button",
				className: c("linkButton"),
				disabled: profileDisabled,
				onClick: () => {
					setEndpoints((current) => current.filter((_row, at) => at !== index));
				}
			}, t("removeEndpoint"))));
			const addEndpoint = e("button", {
				type: "button",
				className: c("linkButton"),
				disabled: profileDisabled || unusedProtocols.length === 0,
				onClick: () => {
					const next = unusedProtocols[0];
					if (next === void 0) return;
					setEndpoints((current) => [...current, {
						api: next,
						baseURL: ""
					}]);
				}
			}, `+ ${t("addEndpoint")}`);
			const endpointError = endpointFailure === void 0 ? null : e("p", { className: c("error") }, t(endpointFailure));
			const endpointsBlock = e("div", {
				className: c("endpoints"),
				key: "endpoints"
			}, e("div", { className: c("endpointHead") }, e("span", { className: c("fieldLabel") }, t("endpoints")), addEndpoint), endpointRows.length === 0 ? null : e("div", { className: c("endpointList") }, endpointRows), e("p", { className: c("advancedHint") }, t("endpointsHint")), endpointError);
			const specOptions = [e("option", {
				value: "",
				key: ""
			}, t("specNone"))].concat(SPECS.map((choice) => e("option", {
				value: choice,
				key: choice
			}, specLabel(t, choice))));
			const specField = field(t("spec"), "spec", e("select", {
				className: `${c("input")} ${c("selectInput")}`,
				value: spec,
				"aria-label": t("spec"),
				disabled: profileDisabled,
				onChange: (event) => {
					setSpec(event.target.value);
				}
			}, specOptions));
			const specHintLine = e("p", { className: c("advancedHint"), key: "spec-hint" }, specHint(t, spec));
			const keyField = field(t("keyInput"), "key", e(ApiKeyInput, {
				t,
				value: keyDraft,
				placeholder: t(edit && initial.keyConfigured ? "keyPlaceholderSaved" : "keyPlaceholder"),
				"aria-label": t("keyInput"),
				disabled,
				onChange: (event) => {
					setKeyDraft(event.target.value);
				}
			}));
			const keyError = keyFailure === void 0 ? null : e("p", { className: c("error"), key: "key-error" }, t(keyFailure === "keyBlank" ? "keyBlankNew" : keyFailure));
			const keyHint = e("p", { className: c("advancedHint"), key: "key-hint" }, t(edit && initial.keyConfigured ? "keyHelpSaved" : "keyHelp"));
			const probeBlocked = baseUrlInvalid ? endpointFaultKey(baseUrlFault, "baseUrlInvalid") : keyFailure === "keyBlank" ? "keyBlankNew" : keyFailure;
			const modelsEditor = e(ModelListEditor, {
				key: "models",
				models,
				onChange: setModels,
				operations,
				t,
				disabled: profileDisabled,
				probe: {
					settingsNs: ns,
					defaultApi: protocol,
					/**
					 * The spec the draft follows, so the editor can tell a family whose
					 * gateway publishes no listing from one that simply failed: the spec
					 * is what the host keys that knowledge on.
					 */
					...spec.length === 0 ? {} : { spec },
					families: [{
						api: protocol,
						baseURL: normalizedBaseURL,
						blocked: probeBlocked
					}].concat(endpointEntries.map((entry) => {
						const entryFault = endpointUrlFault(entry.baseURL);
						return {
							api: entry.api,
							baseURL: entry.baseURL,
							blocked: entryFault === void 0 ? probeBlocked : endpointFaultKey(entryFault, "endpointUrlInvalid")
						};
					})),
					...keyValue.length === 0 ? {} : { apiKey: keyValue },
					...edit ? { provider: initial.route } : {}
				}
			});
			const failureLine = failure === void 0 ? null : e("p", { className: c("error"), key: "failure" }, failure);
			const hintLine = hint === void 0 ? null : e("p", { className: c("advancedHint"), key: "hint" }, hint);
			const footer = e(EditorFooter, {
				key: "footer",
				t,
				busy,
				submitDisabled: disabled || !ready,
				submitLabelKey: edit ? "save" : "create",
				submitBusyLabelKey: edit ? "saving" : "creating",
				onCancel: () => {
					onClose(committed);
				},
				onSubmit: () => {
					submit();
				}
			});
			return e("div", { className: c("editor"), ref: editorRef }, header, edit ? null : routeField, edit ? null : routeMessage, nameField, baseURLField, baseURLError, protocolField, protocolHintLine, endpointsBlock, specField, specHintLine, keyField, keyError, keyHint, modelsEditor, failureLine, hintLine, footer);
		}
		//#endregion
		//#region RowCard
		/** One stored route as a settings row: identity tags, credential state, and its actions. */
		function RowCard(props) {
			const { row, t, disabled, onEdit, onRemove } = props;
			const configured = row.credential?.configured === true;
			/**
			 * The head line stays scarce: name, the spec it follows, and whether a key
			 * is stored. Route, protocol and model count belong to the meta line, where
			 * a long name cannot push the actions into a second column.
			 */
			const identity = e("div", { className: c("rowIdentity") }, e("span", { className: c("rowName") }, row.displayName), row.spec === void 0 ? null : e("span", { className: c("rowTag") }, specLabel(t, row.spec)), e("span", {
				className: `${c("credentialDot")} ${configured ? c("credentialDotConfigured") : c("credentialDotMissing")}`,
				title: t(configured ? "credentialConfigured" : "credentialMissing"),
				"aria-label": t(configured ? "credentialConfigured" : "credentialMissing")
			}));
			const actions = e("span", { className: c("rowActions") }, e("button", {
				type: "button",
				className: c("secondaryButton"),
				disabled,
				onClick: onEdit
			}, t("edit")), e("button", {
				type: "button",
				className: c("dangerButton"),
				disabled,
				onClick: onRemove
			}, t("remove")));
			/**
			 * The meta line names every protocol the route serves, not only its default:
			 * a gateway whose Google side lives at another path must be recognizable as
			 * such at a glance, without opening the editor.
			 */
			const familyLabel = row.endpoints.length === 0 ? protocolLabel(t, row.api) : fmt(t("protocolPlus"), {
				protocol: protocolLabel(t, row.api),
				count: String(row.endpoints.length)
			});
			const facts = [row.route, familyLabel, fmt(t("modelCount"), { count: String(row.modelCount) })].join(" · ");
			const urls = [row.baseURL].concat(row.endpoints.map((entry) => entry.baseURL));
			const meta = e("p", { className: c("rowMeta") }, facts, e("span", { className: c("urlHint") }, urls.join(" · ")));
			return e("li", { className: c("rowCard") }, e("div", { className: c("rowHead") }, identity, actions), meta);
		}
		//#endregion
		//#region Card
		/**
		 * The card this plugin contributes below the Models page's own providers: the
		 * routes declared here, the form that declares one, and the removal flow.
		 *
		 * It lives in the section's footer slot rather than as a provider-card
		 * override: that page's cards address catalog providers by a settings path this
		 * plugin does not own, and its create flow cannot express a spec.
		 */
		function ProviderAliasCard(props) {
			const { controller, operations, t, ns } = props;
			const state = react.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
			const [editing, setEditing] = react.useState();
			const [removeTarget, setRemoveTarget] = react.useState();
			const [removing, setRemoving] = react.useState(false);
			const [removeFailure, setRemoveFailure] = react.useState();
			const [saved, setSaved] = react.useState(false);
			react.useEffect(() => {
				if (!saved) return void 0;
				const timer = setTimeout(() => {
					setSaved(false);
				}, 4e3);
				return () => {
					clearTimeout(timer);
				};
			}, [saved]);
			const readOnly = state.status === "ready" && !state.writable;
			const rows = state.rows;
			const taken = rows.map((row) => row.route);
			const closeEditor = (changed) => {
				setEditing(void 0);
				if (changed) {
					setSaved(true);
					void controller.load();
				}
			};
			const confirmRemove = async () => {
				if (removeTarget === void 0) return;
				setRemoving(true);
				setRemoveFailure(void 0);
				try {
					const written = await operations.writeSettings(ns, [{
						op: "unset",
						path: ["aliases", removeTarget]
					}], state.revision);
					if (written.kind !== "written") {
						setRemoveFailure(written.kind === "conflict" ? t("conflict") : written.message);
						return;
					}
					setRemoveTarget(void 0);
					void controller.load();
				} finally {
					setRemoving(false);
				}
			};
			const blank = {
				route: "",
				displayName: "",
				baseURL: "",
				api: PROTOCOLS[0],
				endpoints: [],
				spec: void 0,
				models: [],
				stored: {},
				apiKeyEnv: void 0,
				keyConfigured: false
			};
			const initialFor = (row) => ({
				route: row.route,
				displayName: row.displayName,
				baseURL: row.baseURL,
				api: row.api,
				endpoints: row.endpoints.map((entry) => ({ ...entry })),
				spec: row.spec,
				models: Array.isArray(row.profile.models) ? row.profile.models.map((model) => ({ ...model })) : [],
				stored: row.stored ?? {},
				apiKeyEnv: row.profile.apiKeyEnv,
				keyConfigured: row.credential?.configured === true
			});
			const editingRow = editing === void 0 ? void 0 : rows.find((row) => row.route === editing);
			const removeRow = removeTarget === void 0 ? void 0 : rows.find((row) => row.route === removeTarget);
			const title = e("h3", { className: c("title") }, t("title"));
			const notice = readOnly ? e("p", { className: c("notice") }, t("readOnly")) : null;
			const savedNotice = saved ? e("p", { className: c("savedNotice") }, t("savedProvider")) : null;
			const error = state.status === "error" ? e("div", { className: c("errorBlock") }, e("p", { className: c("error") }, state.error ?? t("loadFailed")), e("button", {
				type: "button",
				className: c("linkButton"),
				onClick: () => {
					void controller.load();
				}
			}, t("retry"))) : null;
			const credentialNotice = state.credentialError === null ? null : e("p", { className: c("notice") }, state.credentialError);
			const emptyHint = state.status === "ready" && rows.length === 0 ? e("p", { className: c("advancedHint") }, t("rowsEmpty")) : null;
			const rowCards = rows.map((row) => e(RowCard, {
				key: row.route,
				row,
				t,
				disabled: readOnly || editing !== void 0 || removeTarget !== void 0,
				onEdit: () => {
					setRemoveTarget(void 0);
					setEditing(row.route);
				},
				onRemove: () => {
					setEditing(void 0);
					setRemoveTarget(row.route);
					setRemoveFailure(void 0);
				}
			}));
			const list = rows.length === 0 ? null : e("ul", { className: c("rows") }, rowCards);
			const addButton = e("button", {
				type: "button",
				className: c("addButton"),
				disabled: readOnly || state.status !== "ready" || removeTarget !== void 0,
				onClick: () => {
					setRemoveTarget(void 0);
					setEditing("");
				}
			}, e(dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 14 }), t("add"));
			const addBlock = editing === void 0 ? e("div", { className: c("addActions") }, addButton) : null;
			const editorCard = editing === void 0 ? null : e("div", { className: c("addCard") }, e(Editor, {
				key: editingRow === void 0 ? "create" : editingRow.route,
				initial: editingRow === void 0 ? blank : initialFor(editingRow),
				edit: editingRow !== void 0,
				taken,
				revision: state.revision,
				operations,
				t,
				ns,
				readOnly,
				onClose: closeEditor
			}));
			const editorBlock = editorCard === null ? null : e("div", { className: c("addBlock") }, editorCard);
			const removeFailureLine = removeFailure === void 0 ? null : e("p", { className: c("error") }, removeFailure);
			const removeActions = e("div", { className: c("editorActions") }, e("button", {
				type: "button",
				className: c("secondaryButton"),
				disabled: removing,
				onClick: () => {
					setRemoveTarget(void 0);
				}
			}, t("cancel")), e("button", {
				type: "button",
				className: c("dangerButton"),
				disabled: removing,
				onClick: () => {
					confirmRemove();
				}
			}, removing ? t("deleting") : t("deleteConfirm")));
			const removePanel = removeRow === void 0 ? null : e("div", { className: c("editor") }, e("div", { className: c("editorHeader") }, e("span", { className: c("editorTitle") }, fmt(t("deleteTitle"), { provider: removeRow.displayName }))), e("p", { className: c("advancedHint") }, fmt(t("deleteDescription"), { provider: removeRow.route })), removeFailureLine, removeActions);
			return e("section", { className: c("section"), "aria-label": t("title") }, title, notice, savedNotice, error, credentialNotice, emptyHint, list, addBlock, editorBlock, removePanel);
		}
		//#endregion
		//#region locales
		/** English copy (the key-set source of truth for this pair). */
		const en = {
			title: "Custom providers",
			add: "Add provider",
			edit: "Edit",
			remove: "Remove",
			cancel: "Cancel",
			create: "Create",
			creating: "Creating…",
			save: "Save",
			saving: "Saving…",
			deleteTitle: "Remove {provider}",
			deleteDescription: "Removes {provider} and its models. The stored key is kept.",
			deleteConfirm: "Remove",
			deleting: "Removing…",
			retry: "Retry",
			loadFailed: "Could not read this configuration.",
			namespaceMissing: "The provider-alias settings section is not registered — the host half of this plugin is not loaded.",
			readOnly: "This configuration is read-only.",
			rowsEmpty: "No custom provider is declared yet.",
			savedProvider: "Saved.",
			conflict: "This configuration changed elsewhere. Retry to pick up the new revision.",
			route: "Route id",
			routeHint: "Lowercase letters, digits, hyphens; starts with a letter. Also used as the credential id.",
			routeInvalid: "A route id may only use lowercase letters, digits, and hyphens, and must start with a letter.",
			routeTaken: "Another provider already uses this route id.",
			displayName: "Display name",
			editProvider: "Edit provider",
			createProvider: "Declare a provider",
			baseUrl: "Base URL",
			baseUrlPlaceholder: "https://gateway.example/v1",
			anthropicBaseUrlPlaceholder: "https://gateway.example/api",
			baseUrlInvalid: "Enter an http:// or https:// URL.",
			urlNotRequestable: "A request path is appended to this URL, so it cannot carry credentials, a ? query or a # fragment.",
			api: "API protocol",
			spec: "Spec",
			specNone: "None",
			specOpencodeGo: "OpenCode Go",
			specHintNone: "No headers beyond the protocol's own.",
			specHintOpencodeGo: "Adds x-opencode-session (from the session id) to each request; your own header wins.",
			keyInput: "API key",
			keyPlaceholder: "Paste the key",
			keyPlaceholderSaved: "Paste a replacement key",
			keyHelp: "Stored under this route's credential. Blank means the protocol refuses the request — unless its headers already carry authorization.",
			keyHelpSaved: "Key stored; leave blank to keep it.",
			keyReveal: "Show key",
			keyHide: "Hide key",
			keyBlank: "The key is blank.",
			keyBlankNew: "The key is only whitespace.",
			keyIllegalCharacters: "The key contains characters no HTTP header can carry. Paste the raw key only.",
			credentialConfigured: "Key stored",
			credentialMissing: "No key stored",
			model: "Model",
			models: "Models",
			modelsEmpty: "No model yet. Add one, or fetch the endpoint's list.",
			modelCount: "{count} models",
			addModel: "Add model",
			removeModel: "Remove model",
			modelId: "Model id",
			modelName: "Model name",
			modelIdRequired: "A model id is required.",
			modelIdDuplicate: "This model id is listed twice.",
			modelCapacityInvalid: "Capacity must be a positive integer.",
			contextWindow: "Context window",
			maxTokens: "Max output",
			modelInputTypes: "Input types",
			modelInputText: "Text",
			modelInputImage: "Image",
			fetchModels: "Fetch from endpoint",
			fetching: "Fetching…",
			fetchTitle: "Models the endpoint advertises",
			fetchSearch: "Search",
			fetchSelectAll: "Select all",
			fetchDeselectAll: "Clear",
			fetchAdopt: "Adopt selected",
			fetchNoMatches: "No matching model.",
			needsBaseUrl: "Enter the endpoint's base URL.",
			needsModels: "Add at least one model.",
			protocolOpenAiCompletions: "OpenAI Chat Completions",
			protocolOpenAiResponses: "OpenAI Responses",
			protocolAnthropicMessages: "Anthropic Messages",
			protocolGoogleGenerativeAi: "Google Generative AI",
			googleBaseUrlPlaceholder: "https://generativelanguage.googleapis.com/v1beta",
			protocolHintGoogle: "Google's own protocol: the model is addressed in the path, the key travels in x-goog-api-key, and the base URL carries the API version (…/v1beta).",
			endpoints: "Protocol endpoints",
			endpointsHint: "For a gateway that serves several protocols at one address: pin each protocol to its own endpoint. A model whose protocol is not the route default must name a protocol declared here.",
			addEndpoint: "Add protocol endpoint",
			removeEndpoint: "Remove",
			endpointProtocol: "Protocol",
			endpointUrl: "Endpoint",
			endpointUrlRequired: "Every protocol endpoint needs an address.",
			endpointUrlInvalid: "Protocol endpoints must be http:// or https:// URLs.",
			endpointDuplicateProtocol: "Each protocol can be declared once.",
			modelProtocol: "Protocol",
			modelProtocolInherit: "Route default",
			modelProtocolUndeclared: "This model names a protocol with no declared endpoint; pick a declared protocol, or give this model its own endpoint.",
			modelProtocolUnsupported: "This model names a protocol this build cannot serve; pick a protocol the route declares.",
			modelBaseUrl: "Endpoint override",
			modelBaseUrlInvalid: "A model's own endpoint must be an http:// or https:// URL.",
			endpointProtocolUnsupported: "One protocol endpoint names a protocol this build cannot serve; pick a served protocol, or remove the row.",
			protocolUnsupported: "{protocol} (unsupported)",
			modelReasoning: "Thinking levels",
			modelReasoningHelp: "Each level names the value this route sends for it. Off sends nothing, so its value is fixed.",
			modelReasoningGoogleHelp: "Google accepts only Off, Minimal, Low, Medium and High.",
			reasoningLevelOff: "Off",
			reasoningLevelMinimal: "Minimal",
			reasoningLevelLow: "Low",
			reasoningLevelMedium: "Medium",
			reasoningLevelHigh: "High",
			reasoningLevelXhigh: "Extra high",
			reasoningLevelMax: "Max",
			modelReasoningLevel: "Level",
			modelReasoningValue: "Value",
			modelReasoningOffValuePlaceholder: "Sends nothing",
			modelReasoningRemove: "Remove level",
			modelReasoningAdd: "Add level",
			modelReasoningValueRequired: "Every level needs a non-empty value.",
			modelReasoningNeedsLevel: "Declare at least one level besides Off.",
			modelReasoningLevelUnknown: "This build does not know this level; remove it or pick a known one.",
			modelReasoningLevelUnsupported: "This protocol cannot send this level; remove it or pick another.",
			noModelListing: "This endpoint publishes no model list, so models must be entered by hand.",
			modelsEmptyManual: "No model yet. Add one by hand.",
			fetchFamily: "Protocol",
			protocolPlus: "{protocol} +{count}"
		};
		/** Chinese copy, key for key with {@link en}. */
		const zh = {
			title: "自定义供应商",
			add: "添加供应商",
			edit: "编辑",
			remove: "删除",
			cancel: "取消",
			create: "创建",
			creating: "创建中…",
			save: "保存",
			saving: "保存中…",
			deleteTitle: "删除 {provider}",
			deleteDescription: "删除 {provider} 及其模型，已保存的密钥保留。",
			deleteConfirm: "删除",
			deleting: "删除中…",
			retry: "重试",
			loadFailed: "读取该配置失败。",
			namespaceMissing: "未注册 provider-alias 设置分区——本插件的 host 部分未加载。",
			readOnly: "当前配置为只读。",
			rowsEmpty: "尚未声明自定义供应商。",
			savedProvider: "已保存。",
			conflict: "配置已被其他窗口修改，请重试以获取最新修订号。",
			route: "路由标识",
			routeHint: "小写字母、数字与连字符，以字母开头，同时用作凭据 id。",
			routeInvalid: "路由标识只能包含小写字母、数字与连字符，且必须以字母开头。",
			routeTaken: "已有其他供应商使用了该路由标识。",
			displayName: "显示名称",
			editProvider: "编辑供应商",
			createProvider: "声明供应商",
			baseUrl: "接口地址",
			baseUrlPlaceholder: "https://gateway.example/v1",
			anthropicBaseUrlPlaceholder: "https://gateway.example/api",
			baseUrlInvalid: "请输入 http:// 或 https:// 开头的地址。",
			urlNotRequestable: "请求路径会直接拼在这个地址后面，因此它不能带凭据、? 查询串或 # 片段。",
			api: "API 协议",
			spec: "规范",
			specNone: "无",
			specOpencodeGo: "OpenCode Go",
			specHintNone: "不附加协议自身要求之外的请求头。",
			specHintOpencodeGo: "每个请求携带 x-opencode-session 头（取自会话 id）；自行配置的同名头优先。",
			keyInput: "API 密钥",
			keyPlaceholder: "粘贴密钥",
			keyPlaceholderSaved: "粘贴新的密钥",
			keyHelp: "保存在该路由的凭据下；留空时协议会拒绝请求，除非该路由已自带 authorization 头。",
			keyHelpSaved: "已保存密钥，留空即保留。",
			keyReveal: "显示密钥",
			keyHide: "隐藏密钥",
			keyBlank: "密钥为空。",
			keyBlankNew: "密钥只有空白字符。",
			keyIllegalCharacters: "密钥含有 HTTP 头无法携带的字符，请只粘贴密钥本身。",
			credentialConfigured: "密钥已保存",
			credentialMissing: "未保存密钥",
			model: "模型",
			models: "模型",
			modelsEmpty: "还没有模型。可以手动添加，或从端点获取。",
			modelCount: "{count} 个模型",
			addModel: "添加模型",
			removeModel: "移除模型",
			modelId: "模型 ID",
			modelName: "模型名称",
			modelIdRequired: "请填写模型 ID。",
			modelIdDuplicate: "该模型 ID 重复。",
			modelCapacityInvalid: "容量必须是正整数。",
			contextWindow: "上下文窗口",
			maxTokens: "最大输出",
			modelInputTypes: "输入类型",
			modelInputText: "文本",
			modelInputImage: "图像",
			fetchModels: "从端点获取",
			fetching: "获取中…",
			fetchTitle: "端点公布的模型",
			fetchSearch: "搜索",
			fetchSelectAll: "全选",
			fetchDeselectAll: "清空",
			fetchAdopt: "采用所选",
			fetchNoMatches: "没有匹配的模型。",
			needsBaseUrl: "请填写接口地址。",
			needsModels: "至少添加一个模型。",
			protocolOpenAiCompletions: "OpenAI Chat Completions",
			protocolOpenAiResponses: "OpenAI Responses",
			protocolAnthropicMessages: "Anthropic Messages",
			protocolGoogleGenerativeAi: "Google Generative AI",
			googleBaseUrlPlaceholder: "https://generativelanguage.googleapis.com/v1beta",
			protocolHintGoogle: "Google 自有协议：模型写在路径里，密钥走 x-goog-api-key，接口地址需自带版本段（如 …/v1beta）。",
			endpoints: "协议端点",
			endpointsHint: "适用于在同一地址上提供多种协议的网关：为每个协议指定各自的端点。协议不是路由默认值的模型，必须在此选择已声明的协议。",
			addEndpoint: "添加协议端点",
			removeEndpoint: "移除",
			endpointProtocol: "协议",
			endpointUrl: "端点地址",
			endpointUrlRequired: "每个协议端点都需要地址。",
			endpointUrlInvalid: "协议端点必须是 http:// 或 https:// 开头的地址。",
			endpointDuplicateProtocol: "同一协议只能声明一次。",
			modelProtocol: "协议",
			modelProtocolInherit: "跟随路由默认",
			modelProtocolUndeclared: "该模型指定的协议没有已声明的端点；请改选已声明的协议，或为该模型单独指定端点。",
			modelProtocolUnsupported: "该模型指定的协议本版本无法提供；请改选路由已声明的协议。",
			modelBaseUrl: "单独端点",
			modelBaseUrlInvalid: "模型自己的端点必须是 http:// 或 https:// 开头的地址。",
			endpointProtocolUnsupported: "某个协议端点指定的协议本版本无法提供；请改选可用的协议，或移除该行。",
			protocolUnsupported: "{protocol}（不支持）",
			modelReasoning: "思考强度",
			modelReasoningHelp: "每个强度对应发给该路由的一个取值；「关闭」不发送任何取值，因此固定为空。",
			modelReasoningGoogleHelp: "Google 只接受「关闭、最小、低、中、高」五档。",
			reasoningLevelOff: "关闭",
			reasoningLevelMinimal: "最小",
			reasoningLevelLow: "低",
			reasoningLevelMedium: "中",
			reasoningLevelHigh: "高",
			reasoningLevelXhigh: "极高",
			reasoningLevelMax: "最高",
			modelReasoningLevel: "强度",
			modelReasoningValue: "取值",
			modelReasoningOffValuePlaceholder: "不发送",
			modelReasoningRemove: "移除强度",
			modelReasoningAdd: "添加强度",
			modelReasoningValueRequired: "每个强度都需要非空取值。",
			modelReasoningNeedsLevel: "除了「关闭」，至少再声明一个强度。",
			modelReasoningLevelUnknown: "本版本无法识别该强度；请移除它或改选可识别的强度。",
			modelReasoningLevelUnsupported: "当前协议无法发送该强度；请移除它或改选其他强度。",
			noModelListing: "该端点不公布模型列表，请手动填写模型。",
			modelsEmptyManual: "还没有模型，请手动添加。",
			fetchFamily: "协议",
			protocolPlus: "{protocol} +{count}"
		};
		//#endregion
		/**
		 * Services this card needs (cordis fiber inject). The target slot is declared
		 * by the Models page and this card's activation order relative to it is not
		 * constrained, so registration goes through `slots.inject`.
		 */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.settings",
			"remote.credentials",
			"remote.llm"
		];
		/**
		 * Register the card once the Models page has declared its footer slot, and
		 * keep its data fresh on every pushed invalidation that can change a route or
		 * its credential.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "provider-alias: copy dictionaries");
			const t = ctx.locale.bind(NS);
			const operations = createOperations(ctx);
			const controller = new AliasStore(ctx, NS, t);
			ctx.effect(() => {
				const refresh = () => {
					if (controller.getSnapshot().status === "idle") return;
					void controller.load();
				};
				const disposers = [
					ctx.remote.$on("settings/document-updated", refresh),
					ctx.remote.$on("credentials/reference-updated", refresh),
					ctx.remote.$on("credentials/record-updated", refresh),
					ctx.remote.$on("llm/adapters-updated", refresh),
					ctx.on("connection/reset", refresh)
				];
				return () => {
					controller.dispose();
					for (const dispose of disposers) dispose();
				};
			}, "provider-alias: pushed invalidations");
			ctx.slots.inject("settings.models.footer", () => ctx.slots.register({
				name: "settings.models.footer",
				id: "provider-alias",
				order: 0,
				inject: () => ({
					controller,
					operations,
					t,
					ns: NS
				})
			}, ProviderAliasCard));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
