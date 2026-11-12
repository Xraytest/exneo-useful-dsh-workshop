# Custom providers (`dsh-provider-alias`)

Declare your own model providers on the Models page (**设置 → 模型**, 「自定义供应商」): endpoint, protocol, models, own API key — plus an optional **spec**, the wire behaviour an endpoint demands beyond its URL. The shipped spec is `opencode-go` (`x-opencode-session: <sessionId>` per request).

```yaml
# $DSH_HOME/cordis.patch.yml, or the profile's patch file
plugins:
  - id: provider-alias
    config:
      aliases:
        opencode-go-2:
          displayName: "OpenCode Go (pool 2)"
          api: openai-completions          # | openai-responses | anthropic-messages | google-generative-ai
          baseURL: https://opencode.ai/zen/go/v1
          # a gateway that serves another protocol at its own path:
          endpoints:
            google-generative-ai: https://opencode.ai/zen/go/v1beta
          spec: opencode-go                # optional
          apiKeyEnv: "OPENCODE_GO_2_API_KEY"
          models:
            - id: claude-haiku-5-5
              name: Claude Haiku 5.5
              contextWindow: 100000
              maxTokens: 128000
              input: [text, image]
            - id: gemini-4-argon-contributor
              api: google-generative-ai    # inherits the endpoint above
```

Each dict key is a route id — lowercase-hyphenated, starting with a letter, not colliding with a catalog provider. `opencode-go` is itself one of those installed ids (pi-ai ships a catalog entry for that gateway, already split by protocol), which is why the example above is named `opencode-go-2`; a colliding id is refused with copy that names both ways out — pick another id, or configure that provider on its own page. Each route is an independent provider with its own display name, base URL, protocol, and credential (two routes ⇒ two quota pools).

## Protocol endpoints

`api` + `baseURL` are the route's defaults; `endpoints` adds one endpoint per **other** wire protocol, and `models[].api` names the protocol a model speaks. A model that names no protocol follows the route default.

This exists because a gateway is one identity (one key, one quota pool, one provider row) that may still serve different wire APIs at different paths — and those paths are not interchangeable. Google's protocol is the clear case: the model id lives in the path, streaming goes to `:streamGenerateContent?alt=sse`, the key travels in `x-goog-api-key`, the base URL carries the API version (`…/v1beta`), and discovery is a paged `models` list. None of that can be expressed by pointing an OpenAI-shaped route at a Google endpoint.

Resolution order for one model's base URL: `models[].baseURL` → `endpoints[models[].api]` → route `baseURL` (only when the model speaks the route's own `api`). A model naming a protocol with no declared endpoint is refused with copy that says which of the two fixes to apply — never silently sent to the wrong path.

```yaml
api: openai-completions
baseURL: https://gateway.example/v1
endpoints:
  anthropic-messages: https://gateway.example/anthropic
  google-generative-ai: https://gateway.example/v1beta
models:
  - id: gpt-5                     # route default
  - id: claude-5
    api: anthropic-messages
  - id: gemini-4
    api: google-generative-ai     # or baseURL: … to override just this model
```

`endpoints` keys must be protocols this build serves and must not repeat the route's own `api` (that is what `baseURL` is for); values must be an `http(s)` URL *a request path can be appended to*. That rule is one function, shared by the card, the save path, the runtime resolver and the discovery probe, so the four cannot disagree: the value is parsed with `new URL`, its protocol must be `http:`/`https:`, and the raw string must carry no `user:password@`, no `?` and no `#`. The last three are not style — every family builds its request URL by concatenating a path onto this address, so credentials make `new Request` throw outright, a `?` swallows the appended path into a query (even a bare `…/v1?` leaves `search` empty and is still fatal), and a `#` hides it in a fragment. A value that is merely not a URL is refused with the plain "not a requestable http(s) URL" sentence; a value that *is* a URL but cannot be followed by a path gets the same sentence plus a clause naming the part to remove and where that part belongs instead (the key goes in the API-key field; a query the gateway insists on has to be carried by the route's `headers`, which the card does not edit). What fetch can actually do stays accepted: a trailing `/` (each family already normalizes it) and a single-slash spelling such as `http:/host/v1` (parsed, then normalized) both pass, so nothing is refused over a difference the transport does not see. Every declared address is trimmed before use, and a relative value is refused up front instead of failing later, inside fetch. The route's `baseURL` and a model's own `baseURL` follow exactly the same rules — the refusal names whichever field holds the offending address.

A model that pins its own `baseURL` is served from it even when it names a protocol this route declares no endpoint for: the host reads that endpoint first, so the row is self-sufficient. The card mirrors this — a row that pins an endpoint may name any protocol, a row that does not is held to the route's declared families, and the per-model endpoint field is where that exception is written (and removed, by emptying it).

Discovery (`fetch from endpoint`) probes one protocol per click and stamps the adopted models with it. The probe always names the protocol, sends `baseURL` only when the endpoint field is non-empty and `apiKey` only when the key field is, and adds `provider` when the editor is editing a stored route — never for a draft, which has no id yet. So a blank field always means "resolve it from the route", never "send an empty string". An edited route's `provider` is what lets the host apply that profile's own `headers` and stored credential instead of the card re-implementing either; a draft route sends only its own key. A named protocol with no address is resolved from that protocol's own endpoint and never from another protocol's; a draft address is trimmed and then held to the same requestable-URL rule before any request goes out, so an unreachable address is reported as `DISCOVERY_FAILED` against the field instead of as a transport error that sends the user looking at their network. The listing is remembered as belonging to the protocol it was fetched for, not to whatever the selector points at later: removing that protocol's endpoint withdraws the panel instead of letting its models be adopted under another protocol, and a row whose protocol is restamped by an adopt loses the endpoint it had pinned for the previous protocol.

## Spec

A spec is a named request discipline applied in the adapter's `prepareHeaders`, after protocol headers and before the route's own `headers`:

| Spec | Effect |
| --- | --- |
| *(absent)* | Nothing beyond the protocol's own headers. |
| `opencode-go` | `x-opencode-session: <request.sessionId>` when a session id exists; an already-present header is never overwritten; discovery probes never send it. |

Specs are code (`REQUEST_SPECS` in `lib/index.js`); the card only offers what the build ships. Stored as `spec` on the route, absent = none.

## Card

Rows show display name, route id, protocol (plus `+n` when the route declares more protocol endpoints), spec, model count, and every address it serves. 添加提供商 opens an inline editor (路由标识 → 显示名称 → 接口地址 → API 协议 → 协议端点 → 规范 → API 密钥 → 模型); the spec hint and key hint state the real rules (blank key ⇒ `No API key for provider: <id>` unless the route's headers already carry authorization). A route that declares protocol endpoints gains a protocol selector on every model row, and every row of such a route also offers a per-model endpoint override; a single-protocol route shows no protocol selector and only shows the override on a row that already pins one. A row holding a protocol that is no longer declared keeps rendering that protocol (marked as such where it is not served at all) so the value can be corrected instead of silently disappearing, and a stored endpoint naming an unserved protocol blocks the save with copy naming the fault. Keys are stored per-route in this plugin's credential scope. Models are entered by hand or fetched (`GET /models`, one protocol at a time). Removal asks first and keeps the stored key. Edit mode drops the route id (identity — renaming would orphan models).

## Constraints

- A key is effectively required (see `pi-ai/dist/api/openai-completions.js:34-40`); the card cannot edit `headers`.
- No OAuth/login flow — use the built-in catalog for those.
- No `compat` / `modelOverrides` knobs — a route here is a new endpoint, not a fork.
- Host-only profile fields (`headers`, `defaultContextWindow`, `transport`, …) survive edits; the card writes minimal path ops so unshown fields are never lost.
- A route must list ≥1 model: writes go through `strict` validation (whole save refused); activation uses `runtime` (bad row dropped with a warning). Beware schematomy injecting `meta.default = []` — predicates must use `length > 0`.
- Google's adapter refuses a custom `fetch` (`google-generative-ai.js`: `Custom fetch is not supported…`), so nothing on this path may promise transport overrides; the adapter passes none.
- Discovery is per protocol, and a probe that names a protocol but no address is resolved from that protocol's own endpoint (never from another protocol's): OpenAI `GET {base}/models`, Anthropic `GET {base-with-/v1}/models?limit=1000`, Google `GET {base}/models?pageSize=1000` (paged via `nextPageToken`, `models/` and `tunedModels/` prefixes stripped, entries declaring a capability list without `generateContent` skipped — an empty list declares nothing, so it is skipped too).

## Files

| Path | Role |
| --- | --- |
| `lib/index.js` | Host plugin: schema, `REQUEST_SPECS`, adapter, credentials, `apply()`. |
| `lib/client.js` | Web client: Models-page section and styles. |
| `cordis.patch.yml` | Declaration with empty `aliases`. |
| `locale/{en,zh}.json` | Settings-entry title/description. |
| `icon.svg` | Settings-entry icon. |

## Install / remove

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-provider-alias" `
  -Target "<workspace>\plugins\dsh-provider-alias"
```

Enable the entry in the Loader patch and restart it — the client bundle is read at Loader start, not by a live page. Removing the entry unregisters the routes in the same reload; stored keys stay.

## Verified

- DSH 0.2.2-rc.1 with pi-ai's lazy API modules, imported via the composition's module loader.
- End-to-end (2026-11-09): mock endpoint recorded `x-opencode-session` + `authorization` on both title and completion requests; UI streamed the reply; the route appeared in the model picker as a real provider.
- Mixed-protocol behaviour (2026-11-10, harness under `_tmp/alias-test`): 21 host assertions (resolution order, endpoint refusals, per-model dispatch to four protocol factories, Google discovery paging/auth/filtering, an empty listing, an unlistable protocol, other protocols' URLs and auth) and 11 client assertions (endpoint editor, per-model protocol override, save round trip including unset-on-empty, validation, row copy) pass against the real `lib/*.js` with stubbed peers. An adversarial round added 28 host and 11 client assertions (override precedence, whitespace/relative addresses, empty capability lists, a cycling `pageToken`, auth-header isolation, a probe that names a protocol without an address, stale protocol values, trimming), and an effect-aware probe covers what a stub-`useEffect` harness cannot: the fetched listing is stamped with its own protocol, its panel is withdrawn when that protocol leaves the form, and a row's vanished protocol stays visible in its selector. A third round targets the requestable-URL rule itself: six host checks over a query, a bare `?`, a fragment, a bare `#`, and userinfo with and without a password (each must name the part to remove, including through a route endpoint and a per-model `baseURL`), a trailing slash that must stay accepted, four values that are merely not URLs (where no part-to-remove clause may leak in), and the runtime mode dropping exactly the three unfetchable routes while warning about each — 34 host and 17 client assertions, plus a 13-case card/host/probe matrix and a 26-case divergence pass over the two copies. All pass; the one assertion class that still fails is the pre-fix expectation of each defect, kept deliberately as a regression marker.

## Field notes

- **Empty-key trap**: pi-ai's `getClientApiKey` returns the key, else `"unused"` if `authorization`/`cf-aig-authorization` headers exist, else throws. A card route has a key or nothing — the hint states this.
- **schematomy default**: `array` schemas resolve to `[]` when unwritten, hence `declaredInput` reads model `input` through `length` semantics (`lib/index.js:222`).
- **Google is not OpenAI with a different URL**: the path carries the model, the key has its own header, the base URL carries the API version, and the list endpoint is paged — this is why it is a separate protocol with its own endpoint declaration rather than a route-level `baseURL`.
