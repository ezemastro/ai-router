# server

Bun + TypeScript LLM proxy. Latency-ordered **failover cascade** over Groq, Google Gemini, Mistral, NVIDIA NIM, OpenRouter, Cerebras and DeepSeek, with SSE streaming, optional model pinning and bearer-token auth for paid providers.

See the [root README](../README.md) for the provider table, free-tier limits (verified 2026-09-20) and where to get keys.

## Install

```bash
bun install
```

## Run

```bash
bun run index.ts    # starts on http://localhost:3000 (PORT env overrides)
```

## Layout

```
index.ts                        dispatcher: routing, auth, SSE framing, failover cascade
types.ts                        ChatMessage / AIService contracts
providers/openai-compatible.ts  one fetch-based client for every provider (no vendor SDKs)
providers/registry.ts           declarative provider table, self-registers on key presence
providers/openrouter-discovery.ts  hourly, non-blocking `:free` model discovery
router/scheduler.ts             TTFT EWMA, candidate ordering, circuit breaker, snapshot
```

Every provider speaks the OpenAI `POST /chat/completions` streaming protocol — including Gemini through its compat endpoint — so there is exactly one client and no vendor SDK dependencies.

## Environment variables

**A provider is registered only when its API key env var is non-empty.** A keyless provider does not exist in the rotation; it is not a guaranteed failure slot.

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | No | Enables Groq (`https://api.groq.com/openai/v1`) |
| `GOOGLE_API_KEY` | No | Enables Gemini via its OpenAI-compatible endpoint |
| `MISTRAL_API_KEY` | No | Enables Mistral (`https://api.mistral.ai/v1`) |
| `NVIDIA_API_KEY` | No | Enables NVIDIA NIM (`https://integrate.api.nvidia.com/v1`) |
| `OPENROUTER_API_KEY` | No | Enables OpenRouter and its `:free` model discovery |
| `CEREBRAS_API_KEY` | No | Enables Cerebras — no longer free, $5 / 30-day trial |
| `DEEPSEEK_API_KEY` | No | Enables DeepSeek (paid, `requiresAuth`) |
| `API_TOKEN` | Only for paid models | Bearer token required to call `requiresAuth` providers; a missing token fails closed |
| `FIRST_TOKEN_TIMEOUT_MS` | No | Time a candidate gets to produce its first token before the router moves on. Default `8000` |
| `PORT` | No | HTTP port, defaults to `3000`; `compose.yml` sets `PORT: 3000` |
| `<PREFIX>_MODELS` | No | Comma-separated model list that replaces the built-in one — see below |
| `DEEPSEEK_MODEL` | No | Legacy single-model override for DeepSeek, defaults to `deepseek-chat` |

### The `MODELS` override convention

Model IDs live in `providers/registry.ts`, and each provider's list is overridable without touching code, which is what keeps a provider deprecation from being a code change:

```bash
GROQ_MODELS="openai/gpt-oss-120b,openai/gpt-oss-20b"
GOOGLE_MODELS="gemini-2.5-flash-lite,gemini-2.5-flash"
MISTRAL_MODELS="mistral-small-latest"
NVIDIA_MODELS="openai/gpt-oss-120b"
OPENROUTER_MODELS="z-ai/glm-4.5-air:free"
CEREBRAS_MODELS="gpt-oss-120b"
DEEPSEEK_MODELS="deepseek-chat"
```

The list is ordered — the first entry is the preferred model the automatic cascade uses.

OpenRouter additionally discovers its live `:free` catalogue from `GET https://openrouter.ai/api/v1/models` at startup, refreshed lazily at most once an hour. Discovery runs off the request path and any failure silently falls back to `OPENROUTER_MODELS` or the built-in default.

## Routing and failover

- No `model` → free providers ordered by measured time-to-first-token (EWMA, alpha 0.3); unmeasured providers are scored at the current best TTFT so they are not starved, with `speedRank` as the tiebreaker. Tokens/sec is tracked for observability only and never affects the order.
- Each candidate must produce its first content token before the HTTP response is committed. Error, empty stream, or exceeding `FIRST_TOKEN_TIMEOUT_MS` → recorded as a failure, next candidate. The buffered first token is emitted first, never dropped.
- After the first token the headers are already sent, so failover is impossible: a mid-stream failure emits `data: {"error": "..."}` and closes.
- Cooldowns: `401`/`403` 30 min, `402` 60 min, `404` 30 min plus a loud log naming the provider and model, `429` honours `Retry-After` (else 60s, doubling up to 15 min), `5xx`/network/timeout 5s doubling up to 5 min. A first token clears the cooldown and the failure streak.
- Pinned `model` → resolved against provider `models` and names (case-insensitive) and served without failover.

## API

- `GET /health` — `{ "status": "ok" }`
- `GET /providers` — scheduler snapshot (`providers[]` with `ttftMs`, `tokensPerSec`, `inCooldown`, `cooldownUntil`, `consecutiveFailures`, `lastError`), plus `preferred`, `candidateOrder` and `firstTokenTimeoutMs`. No key material, no raw provider bodies.
- `POST /chat` — body `{ messages, model? }`, returns an SSE stream:
  - `data: <chunk>\n\n` per token (raw text, never per-chunk JSON), ending with `data: [DONE]\n\n`
  - mid-stream failures emit `data: {"error": "..."}` and close
  - no `model` → latency-ordered failover cascade over free providers only
  - `model` present → matched against provider `models`/`name` (case-insensitive), unknown → `400 {"error": "Modelo no soportado"}`, and no failover
  - paid provider without a valid `Authorization: Bearer <API_TOKEN>` → `401 {"error": "No autorizado"}`
  - malformed body → `400 {"error": "JSON inválido"}`
  - every candidate failed → `502` with `Content-Type: application/json` (never `text/event-stream`) and `{ "error": "Proveedor <name> falló", "provider": <name>, "attempts": [{ provider, status, reason }] }`
- `OPTIONS *` → `204`. Every response, errors included, carries `Access-Control-Allow-Origin: *`.

Raw provider response bodies are never echoed beyond a sanitized snippet capped at 300 characters.

## Tests

```bash
npx vitest run     # or: bun run test
```

Tests import `handleRequest` directly (the server only starts when `index.ts` is the entrypoint, so tests never bind a port) and inject fake providers through `setServices`, so the suite makes zero network calls.

## Docker

`compose.yml` is the Coolify deployment file: it builds the image from this
directory, exposes `3000` to the proxy and maps no host port.

```bash
# local, reachable from the host
docker compose -f compose.yml -f compose.dev.yml up -d --build
```

### Coolify

Create a **Docker Compose** application from the git repository with Base
Directory `/server`, Docker Compose Location `/server/compose.yml`, and the
domain mapped to the `app` service. Coolify builds the image, terminates TLS and
routes to the container — there is no external reverse proxy to configure.

- Secrets (`GROQ_API_KEY`, `GOOGLE_API_KEY`, `NVIDIA_API_KEY`, `MISTRAL_API_KEY`,
  `OPENROUTER_API_KEY`, `API_TOKEN`, ...) use `${VAR}` interpolation so Coolify
  shows them as editable variables. An unset key drops that provider entirely.
- Fixed config uses literal values (`DEEPSEEK_MODEL: deepseek-chat`,
  `FIRST_TOKEN_TIMEOUT_MS: 8000`). A self-referencing `${DEEPSEEK_MODEL:-}` gets
  locked as "Managed by Docker Compose" and cannot be edited in the UI.
- `expose: "3000"` is required — Coolify reads the domain's target port from it.
- Never add `ports:` or a `networks:` block: a published port bypasses the proxy
  and TLS, and an external network Coolify does not manage fails the deploy.
- The healthcheck hits `GET /health`, so Coolify reports healthy/unhealthy.
