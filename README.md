# AI Router

Latency-aware proxy that fans a chat request out over several LLM providers. Every call to `/chat` is tried against the fastest healthy provider first and **fails over** — first to that provider's next model if the model ID is dead, then to the next provider if the provider itself errors, rate-limits, or does not produce a first token in time. You can also pin a specific model per request.

**Base URL:** `https://ai-router.becode.com.ar`

## Quickstart

```bash
curl -X POST https://ai-router.becode.com.ar/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Explain latency-aware routing in 2 sentences"}
    ]
  }'
```

The response is a **Server-Sent Events (SSE)** stream. Each chunk arrives as a `data: ` line carrying raw token text (not JSON), and the stream ends with `data: [DONE]`.

## How routing works

1. Only providers whose API key is configured exist at all. A keyless provider is not a failure slot in the rotation — it is simply absent.
2. Candidates are ordered by measured **time-to-first-token** (TTFT, an EWMA with alpha 0.3). TTFT is what a caller of a streaming API actually perceives as "fast". Tokens/sec is measured too, but only for observability — it never influences the order.
3. A provider with no measurement yet is scored at the current best measured TTFT, so it gets a fair first shot instead of starving behind whoever was measured first. `speedRank` breaks the tie.
4. Each candidate is started and the router **waits for its first content token before committing the HTTP response**. Only a provider that actually produced a token wins the `200 text/event-stream`. The buffered first token is emitted first, nothing is lost.
5. A **model-level** failure (`404` / `410`: that model ID is gone) does not cost the provider its slot. The router retries the **same provider with its next model** until one produces a first token or the list is exhausted. Only an exhausted provider is cooled down and handed over to the next candidate.
6. Any other failure — error, closed without a token, or exceeding `FIRST_TOKEN_TIMEOUT_MS` (default `8000`) — is **provider-level**: it is recorded, the provider is cooled down, and the next candidate is tried.
7. If the stream dies *after* the first token, headers are already sent so failover is impossible: the server emits `data: {"error": "..."}` and closes.
8. If every candidate fails, the answer is `502` **JSON** (`Content-Type: application/json`, never `text/event-stream`) with an `attempts` array.

### Model-level vs provider-level failure

Free-tier model IDs rot fast, and a provider that lists four models should not be knocked out by one dead ID. That is exactly what happened on 2026-09-21: Google and NVIDIA were both reported as down when only their *default* model was gone.

- `404` / `410` → **the model is dead, the provider may not be.** The ID goes into that provider's dead-model set and the router immediately tries its next model, in list order.
- Everything else (`401`, `402`, `403`, `429`, `5xx`, network, timeout) → **the provider is down.** No other model is tried; the cooldown table below applies.
- The provider's **last-good model is tried first** on the following request, so a healthy provider never re-walks its dead prefix. Dead IDs are demoted to the end of the walk rather than dropped, so a resurrected model recovers without a restart.
- The walk is bounded: at most one attempt per model, capped at **4 model attempts per provider per request** (OpenRouter's discovered `:free` list can hold dozens), and each attempt keeps its own `FIRST_TOKEN_TIMEOUT_MS` budget.
- A **pinned** `model` never walks the list. The caller asked for that exact model, so a `404` on it is simply a `502`.
- The loud "model ID is probably deprecated" log fires **once per exhausted provider**, not once per model attempt.

### Circuit breaker

Provider-level failures put a provider in cooldown, keyed by provider:

| Failure | Cooldown |
|---------|----------|
| `401` / `403` | 30 min — a bad or missing key will stay bad |
| `402` | 60 min — out of credit (the current Cerebras case) |
| `404` | 30 min, plus a loud log naming the provider and the last model tried — applied only once every model of that provider is gone |
| `429` | honours `Retry-After`, else 60s, doubling on repeats up to 15 min |
| `410` / `5xx` / network / timeout | exponential backoff from 5s up to 5 min |

A successful first token resets that provider's failure streak, clears its cooldown and records the model that worked. It does **not** clear the dead-model set: one working model does not resurrect the others.

## API Reference

### `GET /health`

```bash
curl https://ai-router.becode.com.ar/health
```

```json
{ "status": "ok" }
```

### `GET /providers`

Health, latency and routing snapshot. No secrets, no raw provider bodies. This is what makes the "routes to the fastest" claim verifiable.

```bash
curl https://ai-router.becode.com.ar/providers
```

```json
{
  "firstTokenTimeoutMs": 8000,
  "preferred": "groq",
  "candidateOrder": ["groq", "google", "nvidia"],
  "providers": [
    {
      "id": "groq",
      "label": "Groq",
      "models": ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
      "requiresAuth": false,
      "configured": true,
      "speedRank": 1,
      "inCooldown": false,
      "cooldownUntil": null,
      "ttftMs": 210,
      "tokensPerSec": 471.3,
      "consecutiveFailures": 0,
      "lastError": null,
      "deadModels": [],
      "activeModel": "openai/gpt-oss-120b"
    }
  ]
}
```

`candidateOrder` and `preferred` cover the free providers only — the same list the automatic cascade walks.

| Field | Meaning |
|-------|---------|
| `deadModels` | Model IDs of this provider that answered `404`/`410`, in the order they died. This is the list to paste into `<PREFIX>_MODELS` minus the dead entries — or to fix in `registry.ts`. Cleared when the resolved model list changes. |
| `activeModel` | The model that last produced a first token, and therefore the one the next request tries first. `null` when the provider has not served anything yet. |

### `POST /chat`

**Request body:**

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant" },
    { "role": "user", "content": "What is the capital of France?" }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messages` | `ChatMessage[]` | Yes | Conversation history. Each message has `role` (`"user"`, `"assistant"`, `"system"`) and `content` (string). |
| `model` | `string` | No | Pin a specific model (e.g. `deepseek-chat`). When omitted, the request cascades over the free providers, fastest first. |

**Model selection rules:**
- No `model` field → latency-ordered failover cascade over providers with `requiresAuth: false`.
- `model` matches a provider's `models` list or its name (case-insensitive) → that provider handles the request, and **no failover happens**: a pinned model means the caller wants that model.
- Unknown model → `400` with `{ "error": "Modelo no soportado" }`.

**Auth (paid models):** providers marked `requiresAuth: true` (currently only DeepSeek) require a bearer token:

```bash
curl -X POST https://ai-router.becode.com.ar/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{
    "messages": [{"role": "user", "content": "hi"}],
    "model": "deepseek-chat"
  }'
```

The token is configured server-side via `API_TOKEN` and compared in constant time. Missing or wrong token → `401` with `{ "error": "No autorizado" }`; a missing `API_TOKEN` fails closed. Free models do not require auth.

**Response:** SSE stream (`text/event-stream`):

```
data: token1

data: token2

data: [DONE]
```

**Total failure:** every candidate failed → `502` with `Content-Type: application/json`. When more than one provider was involved the message blames the fleet, not whoever happened to be last in the cascade, and `provider` is `null`:

```json
{
  "error": "Todos los proveedores gratuitos fallaron",
  "provider": null,
  "attempts": [
    { "provider": "Groq", "model": "openai/gpt-oss-120b", "status": 404, "reason": "model decommissioned" },
    { "provider": "Groq", "model": "openai/gpt-oss-20b", "status": 404, "reason": "model decommissioned" },
    { "provider": "Cerebras", "model": "gpt-oss-120b", "status": 402, "reason": "Payment required" },
    { "provider": "OpenRouter", "model": "z-ai/glm-4.5-air:free", "status": null, "reason": "no first token within 8000ms" }
  ]
}
```

One `attempts` entry per *model* attempt, so a provider that walked its list appears more than once. When exactly one provider was involved the message still names it:

```json
{
  "error": "Proveedor Groq falló",
  "provider": "Groq",
  "attempts": [{ "provider": "Groq", "model": "openai/gpt-oss-120b", "status": 500, "reason": "internal error" }]
}
```

A **pinned** model that fails answers the same `"Proveedor <name> falló"` with `provider`, and no `attempts` — there was only ever one.

> **Behind Cloudflare, the 502 body never reaches the client.** Cloudflare
> replaces an origin `502` with its own `error code: 502` plain-text page, so
> the JSON detail (`error`, `attempts`) is lost and `content-type` comes back as
> `text/plain`. A client can still detect total failure from the status code,
> but not read which providers were tried — use `GET /providers` for that, or
> set the DNS record to DNS-only (grey cloud) to get the body through.

Raw provider bodies are never echoed beyond a sanitized snippet capped at 300 characters, and API keys never appear in a response or a log.

## Providers

Free-tier facts **verified 2026-09-21**. Check them before trusting this table — **free-tier model IDs rot fast**, and that is exactly how the previous version of this service broke. When one rots, `<PREFIX>_MODELS` is the escape hatch: it replaces the built-in list without a code change or a deploy, and `/providers` → `deadModels` tells you which IDs to drop.

| Provider | Default model(s) | Free tier (verified 2026-09-21) | Key |
|----------|------------------|----------------------------------|-----|
| **Groq** | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `openai/gpt-oss-safeguard-20b`, `qwen/qwen3.8-27b` | Free. 30 RPM / 1K RPD / 8K TPM / 200K TPD | [console.groq.com](https://console.groq.com) |
| **Google Gemini** | `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.5-flash` | Free tier covers Flash and Flash-Lite only (Pro left it 2026-04-01) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **Mistral** | `mistral-small-latest` | Free "Experiment" tier: 1 req/s, 500K TPM, ~1B tokens/month | [console.mistral.ai](https://console.mistral.ai) |
| **NVIDIA NIM** | `openai/gpt-oss-20b`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `nvidia/nemotron-nano-3-30b-a3b` | Free, no credit card, ~40 RPM | [build.nvidia.com](https://build.nvidia.com) |
| **OpenRouter** | discovered `:free` models (fallback `z-ai/glm-4.5-air:free`) | 20 RPM; 50 RPD unfunded, 1000 RPD after a one-time $10 credit purchase | [openrouter.ai/keys](https://openrouter.ai/keys) |
| **Cerebras** | `gpt-oss-120b`, `qwen-3.8-27b` | **No longer free** — $5 / 30-day trial, credit card required. Trial limits 5 RPM / 1M TPD | [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| **DeepSeek** | `deepseek-chat` | Paid. Gated behind `API_TOKEN` on this API | [platform.deepseek.com](https://platform.deepseek.com) |

Known deprecations that motivated this design:
- Groq shut down `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` on **2026-08-16** (`404`). The official replacement is `openai/gpt-oss-120b`.
- Avoid `qwen/qwen3.6-27b` and `groq/compound*` — shutting down 2026-09-14 and 2026-09-21.
- Google retired `gemini-2.5-flash-lite` for new users: the API answers `404` *"no longer available to new users ... use models/gemini-3.5-flash-lite"* (observed **2026-09-21**). The replacement ID came straight out of that error message.
- NVIDIA's `openai/gpt-oss-120b` reached **end of life on 2026-09-03** and now answers `410 Gone`. `openai/gpt-oss-20b` and the two Nemotron IDs are present in the live unauthenticated catalogue (`GET https://integrate.api.nvidia.com/v1/models`, 82 models, checked 2026-09-21).
- Cerebras' free tier ended; the live deployment was returning `402`.

The 2026-09-21 outage is the whole argument for intra-provider model failover: six providers were reported down, but Google and NVIDIA were only *misconfigured* — one dead default model each, with working alternatives sitting unused in the same list.

### Where to get free API keys

- **Groq** → <https://console.groq.com> (free, no card)
- **Google AI Studio** → <https://aistudio.google.com/apikey> (free, no card)
- **NVIDIA** → <https://build.nvidia.com> (free, no card)
- **Mistral** → <https://console.mistral.ai> (free "Experiment" tier)
- **OpenRouter** → <https://openrouter.ai/keys> (free `:free` models; $10 one-time purchase raises the daily cap)
- **Cerebras** → <https://cloud.cerebras.ai> (**no longer free**: $5 / 30-day trial, credit card required)

## Architecture

```
Client ──> POST /chat ──> latency-ordered candidate list (scheduler)
                             │
                             ├─ provider #1 ─┬─ model A: await first token ─ ok ──> 200 text/event-stream
                             │               ├─ model B (only on 404/410) ─── ok ──> 200 text/event-stream
                             │               └─ out of models ──> cooldown, next provider
                             ├─ provider #2 ─── (same model walk)
                             └─ all failed ────────────────────────────────────────> 502 application/json + attempts
```

```
server/
  index.ts                        dispatcher: routing, auth, SSE framing, failover cascade
  types.ts                        ChatMessage / AIService contracts
  providers/
    openai-compatible.ts          one fetch-based client for every provider (no vendor SDKs)
    registry.ts                   declarative provider table, self-registers on key presence
    openrouter-discovery.ts       hourly, non-blocking `:free` model discovery
  router/
    scheduler.ts                  TTFT EWMA, candidate ordering, circuit breaker, snapshot
```

- Built with **Bun** and TypeScript, tested with **vitest**.
- Every provider — Groq, Cerebras, NVIDIA, Mistral, OpenRouter, DeepSeek and Gemini through its OpenAI-compatible endpoint — speaks the same `POST /chat/completions` streaming protocol, so there is exactly one client and **zero vendor SDK dependencies**.
- The output-length cap field is a per-provider flag in the registry (`max_tokens` for DeepSeek, Mistral, Gemini and OpenRouter; `max_completion_tokens` for Groq, Cerebras and NVIDIA), not an if-chain in the client.
- OpenRouter's `HTTP-Referer` / `X-Title` headers come from the registry's optional `extraHeaders`.

## Local Development

```bash
cd server
bun install
bun run index.ts    # starts on http://localhost:3000
```

### Environment variables

Every provider is optional: **a provider is registered only when its API key env var is non-empty.** Configure the ones you have and the rest simply do not exist.

```bash
export GROQ_API_KEY="gsk_..."
export GOOGLE_API_KEY="..."
export NVIDIA_API_KEY="nvapi-..."
export MISTRAL_API_KEY="..."
export OPENROUTER_API_KEY="sk-or-..."
export CEREBRAS_API_KEY="csk_..."        # optional, no longer free
export DEEPSEEK_API_KEY="sk-..."         # paid, gated behind API_TOKEN
export API_TOKEN="..."                   # required only for paid providers
export FIRST_TOKEN_TIMEOUT_MS="8000"     # optional, default 8000
```

### Overriding model lists without a code change

Model IDs live in `server/providers/registry.ts`, and each provider's list is overridable with a comma-separated `<PREFIX>_MODELS` env var. This is the direct fix for "a provider deprecation used to be a code change", and the fastest way to recover from a dead ID without a deploy:

```bash
export GROQ_MODELS="openai/gpt-oss-120b,openai/gpt-oss-20b"
export GOOGLE_MODELS="gemini-3.5-flash-lite,gemini-3.1-flash-lite"
export NVIDIA_MODELS="openai/gpt-oss-20b,nvidia/nemotron-nano-3-30b-a3b"
export MISTRAL_MODELS="mistral-small-latest"
export OPENROUTER_MODELS="z-ai/glm-4.5-air:free"
export CEREBRAS_MODELS="gpt-oss-120b"
export DEEPSEEK_MODELS="deepseek-chat"
```

The list is ordered: the first entry is the preferred/fastest model. The automatic cascade walks the whole list on `404`/`410` (last-good model first, at most 4 attempts per request), so listing a second and third model is real redundancy, not documentation. Changing the list resets that provider's `deadModels` and `activeModel`. The legacy `DEEPSEEK_MODEL` (singular) still works and is what `compose.yml` sets.

**OpenRouter is special:** its `:free` catalogue churns constantly, so the router fetches `GET https://openrouter.ai/api/v1/models` at startup and refreshes at most once an hour, keeping the IDs that end in `:free`. Discovery never blocks a request and never breaks one — any failure falls back to `OPENROUTER_MODELS` or the built-in default.

### Run tests

```bash
cd server
npx vitest run     # or: bun run test
```

## Deploy (Coolify)

Coolify is the only deployment target. It builds the image from this repository,
owns the reverse proxy, TLS and the domain, so `server/compose.yml` publishes no
host port and declares no external network.

Create a **Docker Compose** application from the git repository and set:

| Setting | Value |
|---------|-------|
| Base Directory | `/server` |
| Docker Compose Location | `/compose.yml` |
| Domain | mapped to the `app` service |

Then fill the API keys in Coolify's environment variables tab and deploy.

> **Coolify concatenates Base Directory and Docker Compose Location.** With
> base `/server`, the location must be `/compose.yml`, not `/server/compose.yml`
> — the latter makes it look for `/server/server/compose.yml` and the deploy
> fails with "Docker Compose file not found".

An application created from a public repository has no GitHub App behind it,
so `git push` triggers nothing. Redeploy from the UI or wire up a webhook.

- Secrets use `${VAR}` interpolation so Coolify lists them as editable variables.
  Leave a provider's key blank to drop it from the rotation entirely.
- Fixed config uses **literal values** (`DEEPSEEK_MODEL: deepseek-chat`,
  `FIRST_TOKEN_TIMEOUT_MS: 8000`). A self-referencing `${DEEPSEEK_MODEL:-}` gets
  flagged "Managed by Docker Compose" and locked out of the UI.
- `expose: "3000"` is **required**: Coolify reads the domain's target port from
  it. Without `expose` the proxy has no port to route to.
- Do **not** add `ports:` or a `networks:` block. Publishing a host port bypasses
  the proxy and TLS, and declaring an external network Coolify does not manage
  fails the deployment outright.
- The healthcheck hits `GET /health`, so Coolify reports healthy/unhealthy.

**Local run** (when you want the container reachable from the host):

```bash
cd server
docker compose -f compose.yml -f compose.dev.yml up -d --build   # maps 3000:3000
```
