# freectl

OpenAI-compatible router that merges the **free** models of several providers into one
provider, plus a fail-resistant `default` model that cascades from the strongest to the
weakest model until one answers.

No runtime dependencies: Node >= 23.6 runs the TypeScript directly.

```
FREECTL_TRAY.vbs             # tray icon (desktop shortcut); or start-freectl.bat / node src/index.ts
```

Listens on `http://127.0.0.1:8090/v1`, Bearer key `api_key` (default `test`).
UI at `http://127.0.0.1:8090/ui/`: Status, Ranking (drag-and-drop order, per-model Test,
hide failing, take failing out of `default`), Providers, Settings.

## Config — `config/freectl.json` (git-ignored, holds keys)

Copy `config/freectl.example.json`. A provider is any OpenAI-compatible endpoint:

```json
{ "name": "orcarouter", "baseUrl": "https://api.orcarouter.ai/v1", "apiKey": "env:ORCAROUTER_API_KEY" }
```

- `apiKey`: literal or `env:NAME`. `include` / `exclude`: extra / banned upstream ids; an
  included id is served even when the provider's `/models` does not list it (Z.ai's free
  `glm-*-flash` models: `"freePattern": "^$"` + `include`).
- A model is free when its upstream id matches the provider's `freePattern`, else the global
  `free_pattern` (default `free`). Providers whose free tier covers every model (Groq, Cohere
  trial keys) use `.*`.
- Non-chat models are dropped by `exclude_pattern` (guard, safety, whisper, tts, embed, ...)
  and `min_context` (default 8192).
- Exposed ids are `<provider>/<upstream id>`, e.g. `orcarouter/z-ai/glm-5.3-flash-free`.

## `default` cascade

Order: `priority` list first (exposed or upstream ids), then a heuristic score —
`log2(total params) + 0.5 * log2(active params)`, parsed from id/name/description
(`235b-a22b`, "284B total / 13B active"), family sizes for ids without numbers, −1 for
flash/mini/lite variants, self-routing meta models (`*/free`, `*/auto`) last — then
context window.

On any upstream error (network, non-2xx, error JSON, no first byte within
`first_byte_timeout_seconds`) the next model is tried; the failed one is skipped for
`cooldown_seconds`. Streams are held until their first event, so an error event still
falls back; once bytes reach the client the model is fixed. `max_attempts` caps a request.
A "too large" error (Groq 413 tokens-per-minute, OrcaRouter "prompt is longer than the free tier
allows", Cohere `TOO_MANY_TOKENS`, context overflows) sets no cooldown: the model only skips
requests at least that big (by body size) until a bigger one succeeds.
`cascade_exclude` keeps non-chat models (e.g. detectors) out of `default`. 401/403/404 cool a
model down for 30 min. With `prefer_different_providers` (default on), concurrent `default`
requests start on the providers with the fewest requests in flight, re-picked at every
fall-back step, so they don't share one provider's rate limit.

Response header `x-freectl-model` names the model that answered.

`swarm` is `default` for agent swarms: each conversation (identified by its first user message,
the same on every turn of one agent) is assigned the provider with the fewest live `swarm`
conversations and runs on that provider's best ready model, then falls back through the whole
cascade. Parallel sub-agents thus run one per provider, each sticking to its model across turns;
nothing is pinned, so paused or failing providers drop out and new ones join automatically.
Assignments expire after 10 min idle; `GET /freectl/status` shows `swarmLoad` per provider.

## Staying current

Every `refresh_minutes` (Node) or every 30 min (Workers cron) freectl re-lists all providers
and re-tests models whose last test or real request is older than `check_hours` (default 24;
oldest first, at most 30 per run, cooled-down models skipped). Logged in the UI's Changes panel
and kept across restarts (`config/freectl-state.json` / the Durable Object's storage):

- **new free** / **left free list** — a provider's listing gained or lost a free model.
- **became paid** — a billing error (HTTP 402, Z.ai 1113 "Insufficient balance", "requires more
  credits") from a test or real request hides the model; checks keep testing it and
  **free again** brings it back once it answers.
- A free-named model the provider lists with a price above zero is skipped (`(priced)` under
  filtered out); providers with their own `freePattern` (Groq) are exempt.
- OpenRouter's account-wide `free-models-per-day` quota cools down all its models until 00:00
  UTC, so `default` stops trying them for the rest of the day.

## Cloudflare Workers (free plan) — `worker/`

Same router on Workers: one Durable Object holds the config (in its storage, edited from the
UI), catalog and model health; static UI from `web/`. `/v1/*` takes the config's `api_key`,
the UI (`/freectl/*`) takes the `UI_PASSWORD` secret. Health and cooldowns reset when the
object goes idle; providers are re-listed on the first request after that.

```
cd worker
npx wrangler deploy
npx wrangler secret put UI_PASSWORD
curl -X PUT https://freectl.<sub>.workers.dev/freectl/config -H "authorization: Bearer <UI_PASSWORD>" \
     -H "content-type: application/json" --data-binary @../config/freectl.json   # seed once
```

Local: `npx wrangler dev` with `UI_PASSWORD=...` in `worker/.dev.vars`. Streams swap the
`model` field by text substitution (free plan CPU budget per request).

## API

| Route | |
|---|---|
| `GET /v1/models` | `default` + every free model (`context_length`, `meta.n_ctx`) |
| `POST /v1/chat/completions`, `/v1/completions` | `model`: `default` or an exposed id |
| `GET /freectl/status` | ranking, scores, ok/failed counts, cooldowns, provider errors |
| `POST /freectl/refresh` | re-list providers now (also every `refresh_minutes`) |

`default` reports the smallest context window of its cascade (a fall-back may land on any
model); set `default_context_length` to override.
