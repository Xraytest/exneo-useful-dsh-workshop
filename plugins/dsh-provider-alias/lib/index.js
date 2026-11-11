import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { INVALID_CREDENTIAL_CODE, LlmError, RetryPolicySchema, assertUsableApiKey, attributionHeaders, normalizeApiKey, resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { deepEqualJson } from "@deepseek-ai/dsh-util-values";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import z from "@deepseek-ai/schemastery";
import { credentialKey, credentialKeyId, credentialKeyScope, credentialRef, isCredentialKeySegment, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinProviders, getAllBuiltinModels, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { homedir } from "node:os";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
/**
 * Custom provider routes declared in the settings document, each optionally
 * following a named **request spec** — a small, named bundle of wire behaviour
 * an endpoint requires beyond "here is a key and a base URL".
 *
 * A route here is a complete provider declaration: the protocol its endpoint
 * speaks, the endpoint itself, its models, and its own credential. It is not a
 * copy of an installed catalog route; every field the catalog would have
 * supplied is written down, which is what makes a gateway pi-ai has never
 * heard of work exactly as declared.
 *
 * The `spec` field is the one piece of behaviour a URL and a protocol cannot
 * express. `opencode-go` is the motivating case: that gateway attributes a turn
 * to an opencode session and refuses a request that does not name the session it
 * belongs to, so the route must carry `x-opencode-session` derived from the
 * session id on every request. A spec is applied where the request headers are
 * built — before the adapter's original attribution headers, after the route's
 * own configured headers — so a deployment can override any header a spec sets
 * by naming it in `headers`, exactly as pi-ai's own opencode providers do.
 *
 * @module dsh-provider-alias
 */
const name = "provider-alias";
const inject = ["llm"];
const NS = "provider-alias";
/** Record scope holding a route's own credential, mirroring llm-pi-ai. */
const RECORD_SCOPE = "provider-alias";
/** The route-key grammar, which is also a credential record id. */
const ROUTE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/**
 * Why a value cannot serve as an endpoint, if it cannot.
 *
 * Every protocol this build speaks treats its base URL as a prefix: the request
 * path is appended to it as text (`{base}/models/{id}:streamGenerateContent`,
 * `{base}/chat/completions`, `{base}/messages`) and the three vendor SDKs then
 * hand the concatenation to `new URL`. That makes two spellings a parsed-URL
 * test alone would pass permanently unrequestable:
 *
 * - credentials: `new Request()` refuses a URL carrying userinfo, so a host
 *   fetch never happens at all;
 * - a raw `?` or `#`: anything after it is swallowed into the query or fragment
 *   of the concatenated string, so the appended path becomes data. `http://h/v1?`
 *   plus `/models` parses as path `/v1` and query `/models`.
 *
 * A trailing slash, an empty path, or the single-slash spellings (`http:/host`,
 * `http:///host`) normalize at parse time and are all accepted. The test is
 * therefore on the raw string, not on the parsed `search`/`hash`, and it matches
 * the settings card (`isHttpUrl` there) so a document one side writes the other
 * side accepts.
 * @param value - the URL a declaration carries.
 * @returns the fault, or undefined when the value is a requestable endpoint.
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
/**
 * Whether a value can serve as an endpoint.
 * @param value - the URL a declaration carries.
 * @returns whether it addresses an http(s) endpoint with a request path appended.
 */
function isHttpUrl(value) {
	return endpointUrlFault(value) === void 0;
}
/**
 * The user-facing clause naming a rejected endpoint's fault, appended to the
 * message that says the field is not usable.
 * @param fault - the result of {@link endpointUrlFault}.
 * @returns the clause, or an empty string when the value is merely not a URL.
 */
function endpointFaultHint(fault) {
	switch (fault) {
		case "credentials": return " — remove the `user:password@` part and put the key in the API-key field, because a request path is appended to this address and a URL carrying credentials cannot be requested at all";
		case "query": return " — remove the query string, because a request path is appended to this address and a `?` would turn that path into a query";
		case "fragment": return " — remove the `#` fragment, because a request path is appended to this address and the fragment would hide it";
		default: return "";
	}
}
/** Default maximum idle interval while a route's stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048;
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024;
/** Context capacity assumed for a model the configuration does not size. */
const DEFAULT_CONTEXT_WINDOW = 1e6;
/** Output capability assumed for a model the configuration does not size. */
const DEFAULT_MAX_TOKENS = 128e3;
/**
 * Modalities assumed for a model the configuration does not declare. Text is
 * the floor every supported protocol certainly carries; under-claiming refuses
 * an image before it is attached, over-claiming admits one the endpoint then
 * rejects mid-turn after the message is durable.
 */
const DEFAULT_INPUT = ["text"];
/** Every pi-ai thinking level a route or model may declare, in escalation order. */
const THINKING_LEVELS = Object.keys({
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true
});
/** Every request modality a model entry may declare. */
const MODALITIES = Object.keys({
	text: true,
	image: true
});
/**
 * Pricing for a model this plugin does not price. The harness never reads
 * pi-ai's cost metadata — replay zeroes it and no consumer reports spend — so
 * this is the absence of a fact, not a configurable rate.
 */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const thinkingBudgets = z.object({
	minimal: z.number(),
	low: z.number(),
	medium: z.number(),
	high: z.number()
});
/**
 * One model entry's reasoning levels: keys are the offered levels, values their
 * wire spellings, and a valueless key (`off:`) means "supported, send nothing".
 * Only resolution decides which levels may leave the value empty.
 */
const reasoningEfforts = z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS));
/**
 * Wire protocols a custom route may name, mapped to pi-ai's lazily loaded
 * implementations. Each entry is the factory pi-ai's own provider factory uses,
 * so a hand-declared route reaches exactly the implementation a catalog route
 * would. The table is deliberately narrow: the protocols a route an operator
 * describes with a key, an endpoint, and headers actually reads. Bedrock signs
 * with SigV4, Vertex needs a project and application-default credentials, Azure
 * needs provider environment plus an api-version, and Codex authenticates
 * through OAuth — none of which this configuration shape can express, so
 * offering them would hand back a provider that cannot authenticate.
 *
 * Google is a protocol here in its own right, not a dialect of the OpenAI
 * shapes: its endpoint addresses the model in the path, speaks
 * `streamGenerateContent` over SSE, authenticates with `x-goog-api-key` rather
 * than `authorization`, and lists models under a different shape and at a
 * different path. A gateway such as opencode-go fronts that native API beside
 * its OpenAI and Anthropic paths, which is why a route may now pin a protocol
 * per model and an endpoint per protocol.
 */
const PROTOCOLS = {
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
	"anthropic-messages": anthropicMessagesApi,
	"google-generative-ai": googleGenerativeAIApi
};
/** Every wire protocol a custom route may name, most-reached first. */
const PROTOCOL_IDS = Object.keys(PROTOCOLS);
/**
 * One model a custom route serves. Every capacity the catalog would supply is
 * written here. `api` and `baseURL` are the per-model escape from the route's
 * own protocol and endpoint: a gateway that fronts several wire APIs is one
 * provider with one key, so the model entry — not a second route — is what
 * names the family it belongs to.
 */
const modelProfile = z.object({
	id: z.string().required(),
	name: z.string(),
	api: z.union(PROTOCOL_IDS),
	baseURL: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	input: z.array(z.union(MODALITIES)),
	reasoningEfforts: z.union([z.const(false), reasoningEfforts])
});
/**
 * The request specs a route may follow: named wire behaviour an endpoint
 * requires on top of its protocol. A spec only ever *adds* to a request, and
 * only where the route has not already decided that header itself, so a
 * deployment can always take back control through `headers`.
 */
const REQUEST_SPECS = {
	/**
	 * OpenCode Go: the gateway routes a turn by conversation and rejects a
	 * request that does not name one. Mirrors pi-ai's own opencode providers,
	 * which add the header before API dispatch and skip it when the caller
	 * already supplied one.
	 * @param request - the frozen request facts the adapter built.
	 * @param headers - the headers being assembled for this request.
	 */
	"opencode-go": {
		prepare(request, headers) {
			if (request.sessionId === void 0) return;
			if (headers.has("x-opencode-session")) return;
			headers.set("x-opencode-session", request.sessionId);
		}
	}
};
/** The spec identifiers a route may name. */
const SPEC_IDS = Object.keys(REQUEST_SPECS);
/**
 * One custom provider route. Unlike a catalog route it spells out the protocol,
 * the endpoint, and the models, because nothing installed describes them; and
 * unlike the shipped adapter's profile it adds `spec`, the named request
 * behaviour this plugin exists to offer, and `endpoints`, the per-protocol
 * endpoints a gateway serving more than one wire API needs.
 */
const aliasProfile = z.object({
	displayName: z.string(),
	apiKeyEnv: z.string().role("credential-ref"),
	api: z.union(PROTOCOL_IDS).required(),
	baseURL: z.string().required(),
	endpoints: z.dict(z.string()),
	spec: z.union(SPEC_IDS),
	models: z.array(modelProfile),
	headers: z.dict(z.string()),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
	defaultInput: z.array(z.union(MODALITIES)).default([...DEFAULT_INPUT]),
	reasoning: z.union(THINKING_LEVELS),
	thinkingBudgets,
	cacheRetention: z.union([
		"none",
		"short",
		"long"
	]),
	transport: z.union([
		"sse",
		"websocket",
		"websocket-cached",
		"auto"
	]),
	timeoutMs: z.natural(),
	websocketConnectTimeoutMs: z.natural(),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
	maxRequestImages: z.number().step(1).min(1).default(50),
	imageOffloadCountQuantum: z.number().step(1).min(1),
	requestImagePixelBudget: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET),
	requestImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES),
	retryPolicy: RetryPolicySchema
});
/** Runtime schema for {@link Config}. */
const Config = z.object({ aliases: z.dict(aliasProfile).default({}).volatile() });
let catalogIndex;
/**
 * The installed catalog providers this plugin must not shadow: exactly the set
 * the llm-pi-ai adapter itself serves (chat-bearing, or model-less).
 * @returns the catalog provider index, built once, keyed by provider id.
 */
function catalogProviders() {
	catalogIndex ??= new Map(builtinProviders().filter((provider) => getBuiltinModels(provider.id).length > 0 || getAllBuiltinModels(provider.id).length === 0).map((provider) => [provider.id, provider]));
	return catalogIndex;
}
/** Report a route the configuration cannot serve, naming the route at fault. */
function invalid(provider, detail) {
	throw new Error(`provider-alias: provider "${provider}" ${detail}`);
}
/** Reject a route header that Fetch cannot put on a request. */
function assertValidHeaders(provider, headers) {
	for (const [name, value] of Object.entries(headers ?? {})) try {
		new Headers([[name, value]]);
	} catch {
		throw new Error(`provider-alias: provider "${provider}" header "${name}" is not valid for Fetch; use a valid HTTP field name and a single-line value representable as bytes`);
	}
}
/**
 * One entry's modality list, or `undefined` when it states no answer. Absent
 * and empty mean the same thing — `[]` describes a model that accepts nothing
 * and could serve no request — which is what makes an entry keep the route's
 * `defaultInput`, since the config schema materializes `[]` for an absent array.
 * @param configured - the list the entry supplied.
 * @returns the declared modalities, or `undefined` to ask the next level.
 */
function declaredInput(configured) {
	return configured === void 0 || configured.length === 0 ? void 0 : [...configured];
}
/**
 * Resolve one model's reasoning capability from its declared efforts.
 *
 * A declared dict translates to pi-ai's `thinkingLevelMap` with every level
 * decided explicitly: declared levels carry their wire spelling, undeclared
 * levels are pinned to `null` (unsupported). Pinning matters because pi-ai's own
 * defaulting is asymmetric — an absent key means "supported" for the five base
 * levels but "unsupported" for `xhigh`/`max` — and a route author should not
 * need to know that. A declared `off` with no value is the one exception: it
 * stays absent from the map, which pi-ai reads as "supported, send nothing".
 * @param provider - provider route key, for diagnostics.
 * @param entry - the configured model entry.
 * @returns the reasoning fields the materialized model carries.
 */
function resolveModelReasoning(provider, entry) {
	const efforts = entry.reasoningEfforts;
	if (efforts === void 0) return { reasoning: false };
	if (efforts === false) return { reasoning: false };
	if (efforts === null || Object.keys(efforts).length === 0) invalid(provider, `model "${entry.id}" has an empty reasoningEfforts; declare the offered levels, set false for a non-reasoning model, or omit the field`);
	const declared = THINKING_LEVELS.flatMap((level) => {
		const wire = efforts[level];
		return wire === void 0 ? [] : [[level, wire]];
	});
	for (const [level, wire] of declared) if (wire === null) {
		if (level !== "off") invalid(provider, `model "${entry.id}" reasoningEfforts.${level} needs the wire value dispatch should send; only "off" may leave it empty`);
	} else if (wire.length === 0) invalid(provider, `model "${entry.id}" reasoningEfforts.${level} must not be an empty string`);
	if (!declared.some(([level]) => level !== "off")) invalid(provider, `model "${entry.id}" reasoningEfforts offers no level beyond "off"; declare a thinking level, or set reasoningEfforts to false for a non-reasoning model`);
	const map = {};
	for (const level of THINKING_LEVELS) {
		const wire = efforts[level];
		if (wire === void 0) map[level] = null;
		else if (wire !== null) map[level] = wire;
	}
	return {
		reasoning: true,
		thinkingLevelMap: map
	};
}
/**
 * Resolve the per-protocol endpoints a route declares. Each entry names a wire
 * protocol and the endpoint that protocol is served at; the route's own `api`
 * and `baseURL` remain the default for model entries that name neither.
 * Declaring the route's own protocol again would give one family two answers,
 * so it is refused rather than silently letting one win.
 * @param provider - route key, for diagnostics.
 * @param api - the route's own protocol, when it states one.
 * @param endpoints - the configured protocol-to-endpoint map.
 * @returns the validated map, in configuration order.
 */
function resolveEndpoints(provider, api, endpoints) {
	const declared = {};
	for (const [name, endpoint] of Object.entries(endpoints ?? {})) {
		if (!Object.hasOwn(PROTOCOLS, name)) throw new Error(`provider-alias: provider "${provider}" declares an endpoint for "${name}", which is not a wire protocol this build serves; supported protocols are ${PROTOCOL_IDS.join(", ")}`);
		if (name === api) throw new Error(`provider-alias: provider "${provider}" declares an endpoint for "${name}" beside the route's own api; the route-level baseURL is already that protocol's endpoint — put it there, or drop one of the two`);
		const trimmed = typeof endpoint === "string" ? endpoint.trim() : endpoint;
		if (typeof trimmed !== "string" || trimmed.length === 0) throw new Error(`provider-alias: provider "${provider}" declares an empty endpoint for "${name}"`);
		const fault = endpointUrlFault(trimmed);
		if (fault !== void 0) throw new Error(`provider-alias: provider "${provider}" declares an endpoint for "${name}" that is not a requestable http(s) URL${endpointFaultHint(fault)}`);
		declared[name] = trimmed;
	}
	return declared;
}
/**
 * Materialize one route's models from its configuration. Nothing is inherited:
 * a route this plugin serves is by definition one no installed catalog
 * describes, so every capacity comes from the entry or from the route's stated
 * defaults, and a missing entry field is answered rather than guessed. The one
 * thing that *is* inherited is the wire protocol and its endpoint: an entry
 * naming neither takes the route's own, so a single-protocol route stays as
 * terse as before, while a gateway entry names the family it speaks and is
 * served at that family's endpoint.
 * @param request - the route-level facts every entry inherits, including `endpoints`.
 * @returns the materialized models and the explicitly configured request caps.
 * @throws Error naming the route and entry that cannot be served.
 */
function resolveRouteModels(request) {
	const { provider } = request;
	const entries = request.models ?? [];
	if (entries.length === 0) invalid(provider, "resolves no models; a custom route must list the models its endpoint serves");
	const endpoints = request.endpoints ?? {};
	const seen = new Set();
	const configuredMaxTokens = new Map();
	const models = entries.map((entry) => {
		if (entry.id.length === 0) invalid(provider, "has a model with an empty id");
		if (seen.has(entry.id)) invalid(provider, `lists model "${entry.id}" more than once`);
		seen.add(entry.id);
		const api = entry.api ?? request.api;
		if (typeof api !== "string" || !Object.hasOwn(PROTOCOLS, api)) invalid(provider, `has model "${entry.id}" naming api "${String(api)}", which this build cannot serve; supported protocols are ${PROTOCOL_IDS.join(", ")}`);
		const ownBaseUrl = typeof entry.baseURL === "string" ? entry.baseURL.trim() : entry.baseURL;
		if (ownBaseUrl !== void 0 && ownBaseUrl.length > 0) {
			const ownFault = endpointUrlFault(ownBaseUrl);
			if (ownFault !== void 0) invalid(provider, `model "${entry.id}" has a baseURL that is not a requestable http(s) URL${endpointFaultHint(ownFault)}`);
		}
		const baseUrl = ownBaseUrl !== void 0 && ownBaseUrl.length > 0 ? ownBaseUrl : endpoints[api] ?? (api === request.api ? request.baseURL : void 0);
		if (typeof baseUrl !== "string" || baseUrl.length === 0) invalid(provider, `has model "${entry.id}" speaking "${api}" but declares no endpoint for that protocol; add it to the route's endpoints (a gateway serves its Google side at its own path) or set this model's baseURL`);
		const contextWindow = entry.contextWindow ?? request.defaultContextWindow;
		if (!Number.isInteger(contextWindow) || contextWindow <= 0) invalid(provider, `model "${entry.id}" contextWindow must be a positive integer`);
		const maxTokens = entry.maxTokens ?? request.defaultMaxTokens;
		if (!Number.isInteger(maxTokens) || maxTokens <= 0) invalid(provider, `model "${entry.id}" maxTokens must be a positive integer`);
		if (entry.maxTokens !== void 0) configuredMaxTokens.set(entry.id, entry.maxTokens);
		return {
			id: entry.id,
			name: entry.name ?? entry.id,
			api,
			provider,
			baseUrl,
			input: declaredInput(entry.input) ?? [...request.defaultInput],
			cost: NO_COST,
			contextWindow,
			maxTokens,
			...resolveModelReasoning(provider, entry)
		};
	});
	return {
		models,
		configuredMaxTokens
	};
}
/** The api-key auth a route the harness authenticates itself resolves through. */
function harnessApiKeyAuth(displayName) {
	return {
		name: displayName,
		resolve: ({ credential }) => Promise.resolve({
			auth: credential?.key === void 0 ? {} : { apiKey: credential.key },
			source: displayName
		})
	};
}
/**
 * The static pi-ai provider a declared route is built as — the same
 * construction the stock adapter applies to a route no installed catalog
 * describes. Model dispatch stays with the protocol implementation, so a
 * declared route reaches exactly the code a catalog route would. A route that
 * serves more than one wire protocol supplies one implementation per protocol
 * and each model names its own; a single-protocol route supplies one and every
 * model falls back to it.
 * @param input - provider identity, models, authentication, and protocol implementations by api.
 * @returns a provider that delegates each operation to the model's protocol.
 */
function createProvider(input) {
	/**
	 * The protocol implementation one model dispatches to.
	 * @param model - the pi-ai model handed back by `getModels`.
	 * @returns the implementation serving that model's api.
	 */
	const implementation = (model) => {
		const api = input.apis?.[model.api] ?? input.api;
		if (api === void 0) throw new Error(`provider-alias: provider "${input.id}" has no implementation for model "${model.id}" naming api "${String(model.api)}"`);
		return api;
	};
	return {
		id: input.id,
		name: input.name,
		...input.baseUrl === void 0 ? {} : { baseUrl: input.baseUrl },
		auth: input.auth,
		getModels: () => input.models,
		stream: (model, context, options) => implementation(model).stream(model, context, options),
		streamSimple: (model, context, options) => implementation(model).streamSimple(model, context, options)
	};
}
/**
 * Build the pi-ai provider for one declared route.
 * @param spec - the resolved route facts, including its per-protocol endpoints.
 * @returns the provider to register in the adapter's `Models` collection.
 * @throws Error when the route names a wire protocol this build cannot serve.
 */
function buildCustomProvider(spec) {
	const apis = {};
	const named = [
		...spec.api === void 0 ? [] : [spec.api],
		...Object.keys(spec.endpoints ?? {}),
		...spec.models.map((model) => model.api)
	];
	for (const name of new Set(named)) {
		const factory = PROTOCOLS[name];
		if (factory === void 0) throw new Error(`provider-alias: provider "${spec.provider}" names api "${String(name)}", which this build cannot serve; supported protocols are ${PROTOCOL_IDS.join(", ")}`);
		apis[name] = factory();
	}
	return createProvider({
		id: spec.provider,
		name: spec.displayName,
		baseUrl: spec.baseURL,
		auth: { apiKey: harnessApiKeyAuth(spec.displayName) },
		models: spec.models,
		apis
	});
}
/**
 * Resolve configured routes into adapter profiles — the same shape the
 * llm-pi-ai adapter resolves its own routes into, which is what lets the stock
 * PiAiAdapter serve them unchanged.
 * @param aliases - the raw route dict.
 * @param mode - `strict` rejects every bad row (writes); `runtime` keeps the
 *   serviceable rows and reports each skipped one to `onWarn` (activation).
 * @param onWarn - the sink for rows skipped in runtime mode.
 * @returns the resolved profiles in configuration order.
 */
function resolveAliasProfiles(aliases, mode = "strict", onWarn = () => {}) {
	if (Array.isArray(aliases)) throw new Error("provider-alias: aliases is a dict keyed by provider route, not an array of profiles");
	const resolved = /* @__PURE__ */ new Map();
	for (const [provider, source] of Object.entries(aliases ?? {})) {
		try {
			if (!ROUTE_ID.test(provider) || !isCredentialKeySegment(provider)) throw new Error(`provider-alias: provider "${provider}" is not a lowercase hyphenated route key (it must also be addressable as a credential record id)`);
			if (catalogProviders().has(provider)) throw new Error(`provider-alias: provider "${provider}" is the id of an installed pi-ai catalog provider; a custom route must not shadow a built-in route — pick another id, or configure that provider on its own page`);
			if (source.api === void 0) throw new Error(`provider-alias: provider "${provider}" does not name an api; a custom route must state the wire protocol its endpoint speaks (one of ${PROTOCOL_IDS.join(", ")})`);
			if (!Object.hasOwn(PROTOCOLS, source.api)) throw new Error(`provider-alias: provider "${provider}" names api "${source.api}", which this build cannot serve; supported protocols are ${PROTOCOL_IDS.join(", ")}`);
			const baseURL = typeof source.baseURL === "string" ? source.baseURL.trim() : source.baseURL;
			if (baseURL === void 0 || baseURL.length === 0) throw new Error(`provider-alias: provider "${provider}" has an empty baseURL; a custom route is nothing but its endpoint, so this is required`);
			const baseURLFault = endpointUrlFault(baseURL);
			if (baseURLFault !== void 0) throw new Error(`provider-alias: provider "${provider}" has a baseURL that is not a requestable http(s) URL${endpointFaultHint(baseURLFault)}; a custom route is nothing but its endpoint`);
			if (source.displayName !== void 0 && source.displayName.length === 0) throw new Error(`provider-alias: provider "${provider}" has an empty displayName`);
			assertValidHeaders(provider, source.headers);
			const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
			if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`provider-alias: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
			const maxRequestImageBytes = source.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES;
			if (!Number.isInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) throw new Error(`provider-alias: provider "${provider}" maxRequestImageBytes must be a positive integer`);
			const maxRequestImages = source.maxRequestImages ?? 50;
			if (!Number.isSafeInteger(maxRequestImages) || maxRequestImages <= 0) throw new Error(`provider-alias: provider "${provider}" maxRequestImages must be a positive safe integer`);
			const imageOffloadCountQuantum = source.imageOffloadCountQuantum ?? Math.min(10, maxRequestImages);
			if (!Number.isSafeInteger(imageOffloadCountQuantum) || imageOffloadCountQuantum <= 0 || imageOffloadCountQuantum > maxRequestImages) throw new Error(`provider-alias: provider "${provider}" imageOffloadCountQuantum must be a positive safe integer no greater than maxRequestImages`);
			const requestImagePixelBudget = source.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET;
			if (!Number.isSafeInteger(requestImagePixelBudget) || requestImagePixelBudget <= 0) throw new Error(`provider-alias: provider "${provider}" requestImagePixelBudget must be a positive safe integer`);
			const requestImageMaxBytes = source.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES;
			if (!Number.isSafeInteger(requestImageMaxBytes) || requestImageMaxBytes <= 0) throw new Error(`provider-alias: provider "${provider}" requestImageMaxBytes must be a positive safe integer`);
			const defaultInput = [...source.defaultInput ?? DEFAULT_INPUT];
			if (defaultInput.length === 0) throw new Error(`provider-alias: provider "${provider}" defaultInput must name at least one modality`);
			const displayName = source.displayName ?? provider;
			const endpoints = resolveEndpoints(provider, source.api, source.endpoints);
			const catalog = resolveRouteModels({
				provider,
				api: source.api,
				baseURL,
				endpoints,
				models: source.models,
				defaultInput,
				defaultContextWindow: source.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
				defaultMaxTokens: source.defaultMaxTokens ?? DEFAULT_MAX_TOKENS
			});
			const { apiKeyEnv, retryPolicy, models: _models, displayName: _displayName, ...rest } = source;
			resolved.set(provider, {
				...rest,
				provider,
				displayName,
				baseURL,
				endpoints,
				...apiKeyEnv === void 0 ? {} : { apiKeyEnv: credentialRef(apiKeyEnv) },
				streamIdleTimeoutMs,
				maxRequestImageBytes,
				maxRequestImages,
				imageOffloadCountQuantum,
				requestImagePixelBudget,
				requestImageMaxBytes,
				retryPolicy: resolveRetryPolicy(retryPolicy, `provider-alias: provider "${provider}" retryPolicy`),
				...rest.headers === void 0 ? {} : { headers: { ...rest.headers } },
				...rest.thinkingBudgets === void 0 ? {} : { thinkingBudgets: { ...rest.thinkingBudgets } },
				configuredMaxTokens: catalog.configuredMaxTokens,
				modelErrors: /* @__PURE__ */ new Map(),
				piProvider: buildCustomProvider({
					provider,
					displayName,
					api: source.api,
					baseURL,
					endpoints,
					models: catalog.models
				})
			});
		} catch (error) {
			if (mode === "strict") throw error;
			onWarn(error instanceof Error ? error.message : String(error));
		}
	}
	return resolved;
}
/**
 * Reject new or changed routes that cannot be served. Unchanged stored rows may
 * need repair after an upgrade and do not block edits to another route.
 * @param aliases - the candidate route dict.
 * @param previous - the current stored route dict; omission checks every row.
 */
function assertServiceableAliases(aliases, previous) {
	resolveAliasProfiles(Object.fromEntries(Object.entries(aliases ?? {}).filter(([provider, source]) => !deepEqualJson(source, previous?.[provider]))), "strict");
}
/** The scoped credential key one route's stored record lives under. */
function recordKeyFor(providerId) {
	return credentialKey(RECORD_SCOPE, providerId);
}
/** The JSON image of a grant payload — verbatim llm-pi-ai semantics. */
function jsonImage(value) {
	if (Array.isArray(value)) return value.map((entry) => entry === void 0 ? null : jsonImage(entry));
	if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
		const image = {};
		for (const [key, member] of Object.entries(value)) if (member !== void 0) image[key] = jsonImage(member);
		return image;
	}
	return value;
}
/** Translate a stored record into the credential pi-ai expects. */
function toPiCredential(record) {
	if (record === void 0) return void 0;
	if (record.kind === "api-key") return {
		type: "api_key",
		...record.key === void 0 ? {} : { key: record.key },
		...record.env === void 0 ? {} : { env: { ...record.env } }
	};
	return record.payload;
}
/** Translate a pi-ai credential into the record to store. */
function toRecord(credential) {
	if (credential.type === "api_key") return {
		kind: "api-key",
		...credential.key === void 0 ? {} : { key: credential.key },
		...credential.env === void 0 ? {} : { env: { ...credential.env } }
	};
	return {
		kind: "grant",
		payload: jsonImage(credential)
	};
}
/** The credential service, or the failure that names what is missing. */
function writableStore(ctx) {
	const credentials = ctx.get("credentials");
	if (credentials === void 0) throw new LlmError("provider-alias: this deployment mounts no credential provider, so a route's stored credential cannot be read or written; store the key in the route's apiKeyEnv instead", "MISSING_CREDENTIAL");
	return credentials;
}
/**
 * A pi-ai `CredentialStore` over the harness credential records, scoped to
 * `provider-alias` — a route's stored credential never reads or writes the
 * record of any other route or of any catalog provider.
 * @param ctx - the plugin context carrying the optional `ctx.credentials`.
 * @returns the store to hand the adapter's auth bundle.
 */
function credentialStoreFrom(ctx) {
	return {
		async read(providerId) {
			const credentials = ctx.get("credentials");
			if (credentials === void 0) return void 0;
			if (!isCredentialKeySegment(providerId)) return void 0;
			return toPiCredential(await credentials.readRecord(recordKeyFor(providerId)));
		},
		async list() {
			const stored = await ctx.get("credentials")?.listRecords() ?? [];
			const mine = [];
			for (const entry of stored) {
				if (credentialKeyScope(entry.key) !== RECORD_SCOPE) continue;
				mine.push({
					providerId: credentialKeyId(entry.key),
					type: entry.kind === "api-key" ? "api_key" : "oauth"
				});
			}
			return mine;
		},
		async modify(providerId, mutate) {
			if (!isCredentialKeySegment(providerId)) throw new LlmError(`provider-alias: route "${providerId}" cannot address a stored credential record (a route is a lowercase hyphenated identifier); authenticate this route through apiKeyEnv instead of a stored credential`, "UNSTORABLE_PROVIDER_ID");
			return toPiCredential(await writableStore(ctx).modifyRecord(recordKeyFor(providerId), async (current) => {
				const next = await mutate(toPiCredential(current));
				return next === void 0 ? void 0 : toRecord(next);
			}));
		},
		async delete(providerId) {
			if (!isCredentialKeySegment(providerId)) return;
			await writableStore(ctx).deleteRecord(recordKeyFor(providerId));
		}
	};
}
/** A pi-ai `AuthContext` over the harness credential plane and host filesystem. */
function authContextFrom(ctx) {
	return {
		async env(envName) {
			if (isCredentialRefName(envName)) {
				const hit = await ctx.get("credentials")?.resolve(credentialRef(envName));
				if (hit !== void 0) return hit.value;
			}
			return launchEnvironmentOf(ctx).get(envName)?.value;
		},
		async fileExists(path) {
			const expanded = path.startsWith("~/") || path === "~" ? resolve(homedir(), path.slice(1).replace(/^\//, "")) : path;
			try {
				await access(expanded);
				return true;
			} catch {
				return false;
			}
		}
	};
}
/**
 * The per-route credential resolution handed to the adapter: the route's own
 * reference, resolved through the credential seam first and the launch
 * environment beside it. A route that names no reference resolves to nothing,
 * which is documented as "this endpoint needs no key" rather than as a failure.
 * @param ctx - the plugin context.
 * @returns the resolveApiKey the adapter calls per request.
 */
function aliasResolveApiKey(ctx) {
	return async (provider, profile) => {
		const ref = profile.apiKeyEnv;
		if (ref === void 0) return void 0;
		const credentials = ctx.get("credentials");
		const hit = credentials !== void 0 ? (await credentials.resolve(ref))?.value : launchEnvironmentOf(ctx).get(ref)?.value;
		if (hit !== void 0 && hit.length > 0) return assertUsableApiKey(hit, RECORD_SCOPE, ref);
		throw new LlmError(`provider-alias: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not set — store ${ref} through the credentials service (the Models page writes it) or export it, and remove apiKeyEnv only if this endpoint needs no key`, "MISSING_CREDENTIAL");
	};
}
/**
 * The configurable-provider directory this plugin owns: every live route.
 * Catalog ids stay out — llm-pi-ai already declares those — and a route's
 * settings address is its own dict slot.
 * @param profiles - the currently resolved profiles.
 * @param settingsNs - the settings namespace routes are stored under.
 * @returns the directory entries in configuration order.
 */
function directoryEntries(profiles, settingsNs) {
	return [...profiles.entries()].map(([provider, profile]) => ({
		provider,
		displayName: profile.displayName,
		settingsNs,
		settingsPath: ["aliases", provider],
		declared: true
	}));
}
/** The per-route facts the adapter registry captures; a change re-registers. */
function registrationFacts(profiles) {
	return [...profiles.entries()].map(([provider, profile]) => ({
		provider,
		displayName: profile.displayName,
		retryPolicy: profile.retryPolicy
	})).sort((left, right) => left.provider.localeCompare(right.provider));
}
/** Protocols whose model listing this module can read, mirroring llm-pi-ai's discovery. */
const LISTABLE_PROTOCOLS = /* @__PURE__ */ new Set([
	"anthropic-messages",
	"google-generative-ai",
	"openai-completions",
	"openai-responses"
]);
/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = "2023-06-01";
/** Largest model-list page accepted by Anthropic's public endpoint. */
const ANTHROPIC_MODEL_LIMIT = 1e3;
/**
 * The Google Generative AI key header, which is what the official SDK sends:
 * that API takes its key from `x-goog-api-key`, not from `authorization`, so a
 * discovery probe borrowing the OpenAI shape would be answered with 401.
 */
const GOOGLE_API_KEY_HEADER = "x-goog-api-key";
/** Most models Google's ListModels returns in one page. */
const GOOGLE_MODEL_PAGE_SIZE = 1e3;
/** Pages followed before a listing is declared too long to enumerate. */
const GOOGLE_MODEL_PAGE_LIMIT = 10;
/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims; a truncated listing is not parseable, so
 * overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates) {
	for (const candidate of candidates) if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) return candidate;
}
/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates) {
	for (const candidate of candidates) if (typeof candidate === "string" && candidate.length > 0) return candidate;
}
/**
 * Join the endpoint base with the protocol's listing path. The base is treated
 * as a prefix rather than a URL to resolve against, so a deployment path such as
 * `https://gateway.example/openai/v1` keeps its segments. OpenAI protocols list
 * at `{baseURL}/models`; Anthropic lists at `{root}/v1/models`, where the root is
 * the base without trailing slashes and without one trailing `/v1` segment;
 * Google lists at `{baseURL}/models` — its baseURL already carries the API
 * version (`…/v1beta`, or a gateway's own prefix), because that is what the
 * generated endpoint needs for `:streamGenerateContent` too.
 * Only this listing URL normalizes Anthropic's segment; model requests receive
 * the configured endpoint unchanged.
 *
 * The path is moved through `URL`, not pasted onto the string. Appending to the
 * raw text would turn a stored `?` or `#` into a query or fragment that swallows
 * the appended segment (`/v1?x=1` + `/models` becomes query `/models`), and a
 * `pageToken` or `limit` composed by hand would then collide with whatever the
 * stored query already held. Assignment drops any fragment and keeps a single
 * query string that the caller owns.
 * @param baseURL - the configured endpoint.
 * @param api - the endpoint's protocol.
 * @param pageToken - Google's continuation token, when reading a later page.
 * @returns the model-listing URL.
 */
function listingUrl(baseURL, api, pageToken) {
	const url = new URL(baseURL);
	url.hash = "";
	url.search = "";
	const path = url.pathname.replace(/\/+$/, "");
	if (api === "anthropic-messages") {
		url.pathname = `${path.endsWith("/v1") ? path.slice(0, -3) : path}/v1/models`;
		url.searchParams.set("limit", String(ANTHROPIC_MODEL_LIMIT));
	} else {
		url.pathname = `${path}/models`;
		if (api === "google-generative-ai") {
			url.searchParams.set("pageSize", String(GOOGLE_MODEL_PAGE_SIZE));
			if (pageToken !== void 0) url.searchParams.set("pageToken", pageToken);
		}
	}
	return url.toString();
}
/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound.
 * @param response - the endpoint reply.
 * @param url - the probed URL, for diagnostics.
 * @returns the decoded body.
 */
async function readBounded(response, url) {
	const oversized = () => new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, "DISCOVERY_FAILED");
	const declared = Number(response.headers.get("content-length") ?? NaN);
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
		await response.body?.cancel();
		throw oversized();
	}
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) throw oversized();
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}
/**
 * Read one supported model-listing reply. The standard `data` array takes
 * precedence; an enriched `models` map uses each property key as the
 * endpoint-facing id, with its nested `id` only a fallback for an empty key.
 * Entries without a usable id are skipped rather than failing the whole
 * interrogation, and a missing name falls back to the adopted id.
 * @param body - the parsed reply.
 * @returns the advertised models in endpoint order.
 */
function readListing(body) {
	const listing = body;
	const data = listing?.data;
	let listed;
	if (Array.isArray(data)) listed = data.map((raw) => ({ raw }));
	else {
		const models = listing?.models;
		if (models === null || typeof models !== "object" || Array.isArray(models)) throw new LlmError("the endpoint's model listing has neither a \"data\" array nor a \"models\" object; enter this provider's models by hand", "DISCOVERY_FAILED");
		listed = Object.entries(models).filter(([, raw]) => raw !== null && typeof raw === "object" && !Array.isArray(raw)).map(([key, raw]) => ({
			key,
			raw
		}));
	}
	const models = [];
	for (const { key, raw } of listed) {
		const entry = raw;
		const id = label(key, entry?.id);
		if (id === void 0) continue;
		const name = label(entry?.name, entry?.display_name, entry?.displayName) ?? id;
		const contextWindow = capacity(entry?.contextWindow, entry?.context_window, entry?.context_length, entry?.max_input_tokens, entry?.limit?.context);
		const maxTokens = capacity(entry?.maxOutputTokens, entry?.max_output_tokens, entry?.maxTokens, entry?.max_tokens, entry?.limit?.output, entry?.top_provider?.max_completion_tokens);
		models.push({
			id,
			name,
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens }
		});
	}
	return models;
}
/**
 * Read one Google ListModels reply. That endpoint answers with a `models` array
 * rather than a `data` array, names each model `models/<id>` (a path, not an
 * id), sizes it with `inputTokenLimit`/`outputTokenLimit`, and states what it
 * may be used for. An entry that cannot `generateContent` is an embedding or
 * tuning model rather than a chat model, so it is skipped instead of offered;
 * an entry with no usable methods list is kept, because the field is what
 * Google adds and its absence is not a refusal.
 * @param body - the parsed reply.
 * @returns the advertised models and the token for the next page, when present.
 */
function readGoogleListing(body) {
	const listing = body;
	const models = listing?.models;
	if (models === void 0) return { models: [] };
	if (!Array.isArray(models)) throw new LlmError("the endpoint's model listing has no \"models\" array; enter this provider's models by hand", "DISCOVERY_FAILED");
	const listed = [];
	for (const raw of models) {
		const entry = raw;
		const name = label(entry?.name);
		if (name === void 0) continue;
		const methods = entry?.supportedGenerationMethods;
		if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
		const id = name.startsWith("models/") ? name.slice(7) : name.startsWith("tunedModels/") ? name.slice(12) : name;
		if (id.length === 0) continue;
		const contextWindow = capacity(entry?.inputTokenLimit);
		const maxTokens = capacity(entry?.outputTokenLimit);
		listed.push({
			id,
			name: label(entry?.displayName) ?? id,
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens }
		});
	}
	const token = label(listing?.nextPageToken);
	return {
		models: listed,
		...token === void 0 ? {} : { nextPageToken: token }
	};
}
/**
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that the catch reports
 * as `could not reach <url>` — blaming the network for a local fault.
 * @param raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
 */
function usableProbeKey(raw) {
	const checked = normalizeApiKey(raw);
	if (checked.ok) return checked.value;
	throw new LlmError(checked.reason === "empty" ? "this provider's API key is blank; enter it on the Models page, or clear it to probe unauthenticated" : "this provider's API key contains characters no HTTP header can carry; paste the raw key only", INVALID_CREDENTIAL_CODE);
}
/**
 * Interrogate one draft endpoint for the models it advertises. Nothing here is
 * stored: the request carries a draft the user is still editing, and the reply
 * is candidate metadata the surface offers for adoption.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @param storedProfile - Host-owned headers and lazy credential resolution for
 *   the named route. Read only on the path that reaches the network; the
 *   credential is resolved only when the draft carries none.
 * @returns the advertised models in endpoint order.
 * @throws LlmError when the protocol has no readable listing, the endpoint
 *   refuses or fails the request, or the reply is not a model listing.
 */
async function discoverModels(request, storedProfile) {
	if (request.baseURL === void 0 || request.baseURL.length === 0) throw new LlmError(`provider-alias: provider "${request.provider ?? ""}" has no baseURL to probe, and declared routes have no installed catalog to fall back on; set the endpoint, or enter this provider's models by hand`, "DISCOVERY_FAILED");
	/**
	 * The probe is a request, so the draft is held to the same rule the saved
	 * document is: a listing path is appended to this address, which rules out
	 * credentials and a raw `?` or `#`. Refusing here keeps an unreachable draft
	 * from reaching the network and reporting it as a transport failure, which
	 * would send the user looking at their network instead of at the field.
	 */
	const draftURL = typeof request.baseURL === "string" ? request.baseURL.trim() : String(request.baseURL);
	const draftFault = endpointUrlFault(draftURL);
	if (draftFault !== void 0) throw new LlmError(`provider-alias: cannot probe "${draftURL}", which is not a requestable http(s) URL${endpointFaultHint(draftFault)}`, "DISCOVERY_FAILED");
	const api = request.api ?? "openai-completions";
	if (!LISTABLE_PROTOCOLS.has(api)) throw new LlmError(`provider-alias: protocol "${api}" has no model listing this build can read; enter this provider's models by hand`, "DISCOVERY_UNSUPPORTED");
	const stored = storedProfile?.();
	const supplied = request.apiKey ?? await stored?.resolveApiKey();
	const apiKey = supplied === void 0 ? void 0 : usableProbeKey(supplied);
	/**
	 * Fetch and decode one listing page. Headers are rebuilt per request because
	 * Google's continuation call is a second round trip under the same credential.
	 * @param url - the page to read.
	 * @returns the parsed reply.
	 */
	const readPage = async (url) => {
		let response;
		try {
			const headers = new Headers(stored?.headers === void 0 ? void 0 : Object.entries(stored.headers));
			headers.set("accept", "application/json");
			if (api === "anthropic-messages") {
				headers.set("anthropic-version", ANTHROPIC_VERSION);
				if (apiKey !== void 0) headers.set("x-api-key", apiKey);
			} else if (api === "google-generative-ai") {
				if (apiKey !== void 0) headers.set(GOOGLE_API_KEY_HEADER, apiKey);
			} else if (apiKey !== void 0) headers.set("authorization", `Bearer ${apiKey}`);
			for (const [headerName, value] of Object.entries(attributionHeaders())) headers.set(headerName, value);
			response = await fetch(url, {
				method: "GET",
				headers,
				...request.signal === void 0 ? {} : { signal: request.signal }
			});
		} catch (error) {
			if (request.signal?.aborted) throw new LlmError("model discovery aborted by caller", "ABORTED", { cause: error });
			throw new LlmError(`could not reach ${url}`, "DISCOVERY_FAILED", { cause: error });
		}
		if (!response.ok) throw new LlmError(`${url} answered ${response.status}${response.status === 401 || response.status === 403 ? "; check the API key" : ""}`, "DISCOVERY_FAILED");
		let text;
		try {
			text = await readBounded(response, url);
		} catch (error) {
			if (request.signal?.aborted) throw new LlmError("model discovery aborted by caller", "ABORTED", { cause: error });
			throw error;
		}
		try {
			return JSON.parse(text);
		} catch (error) {
			throw new LlmError(`${url} did not answer with JSON`, "DISCOVERY_FAILED", { cause: error });
		}
	};
	if (api !== "google-generative-ai") return readListing(await readPage(listingUrl(draftURL, api)));
	const models = [];
	const seen = new Set();
	let pageToken;
	for (let page = 0; page < GOOGLE_MODEL_PAGE_LIMIT; page++) {
		const listing = readGoogleListing(await readPage(listingUrl(draftURL, api, pageToken)));
		for (const model of listing.models) {
			if (seen.has(model.id)) continue;
			seen.add(model.id);
			models.push(model);
		}
		const next = listing.nextPageToken;
		if (next === void 0 || next === pageToken) return models;
		pageToken = next;
	}
	return models;
}
/** Register the declared routes over the stock pi-ai adapter machinery. */
function apply(ctx, config) {
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});
	const settingsNs = ctx.fiber.entry?.options.id ?? NS;
	let lastRaw;
	let memoized;
	/**
	 * The resolved profiles for the current configuration, memoized by the raw
	 * snapshot's identity — which is also what keeps the adapter's own snapshot
	 * (and the Models collection built into it) stable across operations that
	 * observe no change. A row that cannot be served is dropped with a warning,
	 * never silently kept half-live.
	 */
	const profiles = () => {
		const raw = config.aliases.get();
		if (raw === lastRaw && memoized !== void 0) return memoized;
		const next = resolveAliasProfiles(structuredClone(raw), "runtime", (message) => ctx.logger.warn(message));
		lastRaw = raw;
		memoized = next;
		return next;
	};
	profiles();
	ctx.on("internal/config", (fiber, next) => {
		const raw = next();
		if (fiber !== ctx.fiber) return raw;
		const candidate = Config(raw);
		assertServiceableAliases(structuredClone(candidate.aliases.get()), structuredClone(config.aliases.get()));
		return raw;
	});
	const resolveApiKey = aliasResolveApiKey(ctx);
	const auth = {
		credentials: credentialStoreFrom(ctx),
		authContext: authContextFrom(ctx)
	};
	const adapter = new PiAiAdapter({
		profiles,
		resolveApiKey,
		auth,
		/**
		 * Apply the route's request spec, then let other plugins add headers on
		 * top. The spec only runs where the route has not already decided the
		 * header itself, so a `headers` entry always wins; attribution headers are
		 * set by the adapter after this returns and cannot be overridden here.
		 */
		prepareHeaders: (request, headers) => {
			const profile = request.provider === void 0 ? void 0 : profiles().get(request.provider);
			REQUEST_SPECS[profile?.spec]?.prepare(request, headers);
			return ctx.waterfall("provider-alias/request-headers", request, headers, () => headers);
		},
		resolveAttachments: () => ctx.get("attachments"),
		resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref),
		onReplayDegrade: ({ provider, model, reason }) => {
			ctx.logger.warn(`provider-alias: unusable replay state on assistant history for route "${provider}/${model}"; sending that message as provider-neutral content (${reason})`);
		}
	});
	let directory;
	let directoryFacts;
	const ensureDirectory = () => {
		const entries = directoryEntries(profiles(), settingsNs);
		if (deepEqualJson(entries, directoryFacts)) return;
		if (directory === void 0) {
			if (entries.length === 0) {
				directoryFacts = entries;
				return;
			}
			directory = ctx.llm.registerConfigurableProviders(entries);
		} else directory.replace(entries);
		directoryFacts = entries;
	};
	ensureDirectory();
	ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => {
		const stored = request.provider === void 0 ? void 0 : profiles().get(request.provider);
		/**
		 * A probe names the protocol it interrogates, so the fallback endpoint is
		 * that protocol's own: sending a Google probe to the route's OpenAI
		 * address would authenticate the wrong path with the wrong header. When the
		 * named protocol has no endpoint the request keeps none, and discovery
		 * reports what is missing rather than guessing an address.
		 */
		const endpointFor = (api) => stored === void 0 || api === void 0 ? void 0 : stored.endpoints?.[api] ?? (stored.api === api ? stored.baseURL : void 0);
		const api = request.api ?? stored?.api;
		const baseURL = request.baseURL ?? endpointFor(api);
		return discoverModels({
			...request,
			...baseURL === void 0 ? {} : { baseURL },
			...request.api === void 0 && stored !== void 0 ? { api: stored.api } : {},
			...signal === void 0 ? {} : { signal }
		}, () => stored === void 0 ? void 0 : {
			headers: stored.headers,
			resolveApiKey: () => resolveApiKey(request.provider, stored)
		});
	});
	let registration;
	let registeredFacts;
	const ensureRegistrationFacts = () => {
		const facts = registrationFacts(profiles());
		if (deepEqualJson(facts, registeredFacts)) return;
		const routes = [...profiles().keys()];
		if (registration === void 0) {
			if (routes.length === 0) {
				registeredFacts = facts;
				return;
			}
			registration = ctx.llm.registerAdapter(routes, adapter);
		} else registration.replace(routes);
		registeredFacts = facts;
	};
	ensureRegistrationFacts();
	ctx.on("loader/volatile-update", () => {
		try {
			ensureRegistrationFacts();
			ensureDirectory();
		} catch (error) {
			ctx.logger.error("provider-alias: provider configuration conflicts with an existing provider route");
			ctx.logger.error(error);
		}
	});
}
/**
 * The internals this plugin's smoke tests and diagnostics need. Exported as a
 * namespaced bag rather than as loose symbols: nothing in the composition
 * resolves these, and the public surface stays `Config/apply/inject/name`.
 */
const internals = {
	Config,
	aliasProfile,
	ROUTE_ID,
	NS,
	RECORD_SCOPE,
	PROTOCOL_IDS,
	SPEC_IDS,
	REQUEST_SPECS,
	catalogProviders,
	resolveAliasProfiles,
	resolveEndpoints,
	resolveRouteModels,
	assertServiceableAliases,
	buildCustomProvider,
	createProvider,
	discoverModels,
	listingUrl,
	readListing,
	readGoogleListing,
	credentialStoreFrom,
	authContextFrom,
	aliasResolveApiKey,
	directoryEntries,
	registrationFacts
};
export { Config, apply, inject, internals, name, recordKeyFor };
