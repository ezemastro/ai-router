# AI Router

Latency-aware proxy that fans a chat request out over several LLM providers. Every call to `/chat` is tried against the fastest healthy provider first and **fails over** to the next one if that provider errors, rate-limits, or does not produce a first token in time. You can also pin a specific model per request.

**Base URL:** `https://ai-router.mastropietro.work.gd`

## Quickstart

```bash
curl -X POST https://ai-router.mastropietro.work.gd/chat \
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
5. If the candidate errors, closes without a token, or exceeds `FIRST_TOKEN_TIMEOUT_MS` (default `8000`), the failure is recorded and the next candidate is tried.
6. If the stream dies *after* the first token, headers are already sent so failover is impossible: the server emits `data: {"error": "..."}` and closes.
7. If every candidate fails, the answer is `502` **JSON** (`Content-Type: application/json`, never `text/event-stream`) with an `attempts` array.

### Circuit breaker

Failures put a provider in cooldown, keyed by provider:

| Failure | Cooldown |
|---------|----------|
| `401` / `403` | 30 min — a bad or missing key will stay bad |
| `402` | 60 min — out of credit (the current Cerebras case) |
| `404` | 30 min, plus a loud log naming the provider and model — the model ID is probably deprecated |
| `429` | honours `Retry-After`, else 60s, doubling on repeats up to 15 min |
| `5xx` / network / timeout | exponential backoff from 5s up to 5 min |

A successful first token resets that provider's failure streak and clears its cooldown.

## API Reference

### `GET /health`

```bash
curl https://ai-router.mastropietro.work.gd/health
```

```json
{ "status": "ok" }
```

### `GET /providers`

Health, latency and routing snapshot. No secrets, no raw provider bodies. This is what makes the "routes to the fastest" claim verifiable.

```bash
curl https://ai-router.mastropietro.work.gd/providers
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
      "lastError": null
    }
  ]
}
```

`candidateOrder` and `preferred` cover the free providers only — the same list the automatic cascade walks.

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
curl -X POST https://ai-router.mastropietro.work.gd/chat \
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

**Total failure:** every candidate failed → `502` with `Content-Type: application/json`:

```json
{
  "error": "Proveedor OpenRouter falló",
  "provider": "OpenRouter",
  "attempts": [
    { "provider": "Groq", "status": 404, "reason": "model decommissioned" },
    { "provider": "Cerebras", "status": 402, "reason": "Payment required" },
    { "provider": "OpenRouter", "status": null, "reason": "no first token within 8000ms" }
  ]
}
```

Raw provider bodies are never echoed beyond a sanitized snippet capped at 300 characters, and API keys never appear in a response or a log.

## Providers

Free-tier facts **verified 2026-09-20**. Check them before trusting this table — provider free tiers churn fast, and that is exactly how the previous version of this service broke.

| Provider | Default model(s) | Free tier (verified 2026-09-20) | Key |
|----------|------------------|----------------------------------|-----|
| **Groq** | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `openai/gpt-oss-safeguard-20b`, `qwen/qwen3.8-27b` | Free. 30 RPM / 1K RPD / 8K TPM / 200K TPD | [console.groq.com](https://console.groq.com) |
| **Google Gemini** | `gemini-2.5-flash-lite`, `gemini-2.5-flash` | Free tier covers Flash and Flash-Lite only (Pro left it 2026-04-01) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **Mistral** | `mistral-small-latest` | Free "Experiment" tier: 1 req/s, 500K TPM, ~1B tokens/month | [console.mistral.ai](https://console.mistral.ai) |
| **NVIDIA NIM** | `openai/gpt-oss-120b` | Free, no credit card, ~40 RPM | [build.nvidia.com](https://build.nvidia.com) |
| **OpenRouter** | discovered `:free` models (fallback `z-ai/glm-4.5-air:free`) | 20 RPM; 50 RPD unfunded, 1000 RPD after a one-time $10 credit purchase | [openrouter.ai/keys](https://openrouter.ai/keys) |
| **Cerebras** | `gpt-oss-120b`, `qwen-3.8-27b` | **No longer free** — $5 / 30-day trial, credit card required. Trial limits 5 RPM / 1M TPD | [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| **DeepSeek** | `deepseek-chat` | Paid. Gated behind `API_TOKEN` on this API | [platform.deepseek.com](https://platform.deepseek.com) |

Known deprecations that motivated this design:
- Groq shut down `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` on **2026-08-16** (`404`). The official replacement is `openai/gpt-oss-120b`.
- Avoid `qwen/qwen3.6-27b` and `groq/compound*` — shutting down 2026-09-14 and 2026-09-21.
- Cerebras' free tier ended; the live deployment was returning `402`.

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
                             ├─ try #1: await first token ── ok ──> 200 text/event-stream
                             ├─ try #2: await first token ── ok ──> 200 text/event-stream
                             └─ all failed ───────────────────────> 502 application/json + attempts
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

Model IDs live in `server/providers/registry.ts`, and each provider's list is overridable with a comma-separated `<PREFIX>_MODELS` env var. This is the direct fix for "a provider deprecation used to be a code change":

```bash
export GROQ_MODELS="openai/gpt-oss-120b,openai/gpt-oss-20b"
export GOOGLE_MODELS="gemini-2.5-flash-lite"
export NVIDIA_MODELS="openai/gpt-oss-120b"
export MISTRAL_MODELS="mistral-small-latest"
export OPENROUTER_MODELS="z-ai/glm-4.5-air:free"
export CEREBRAS_MODELS="gpt-oss-120b"
export DEEPSEEK_MODELS="deepseek-chat"
```

The list is ordered: the first entry is the preferred/fastest model and is what the automatic cascade uses. The legacy `DEEPSEEK_MODEL` (singular) still works and is what `compose.yml` sets.

**OpenRouter is special:** its `:free` catalogue churns constantly, so the router fetches `GET https://openrouter.ai/api/v1/models` at startup and refreshes at most once an hour, keeping the IDs that end in `:free`. Discovery never blocks a request and never breaks one — any failure falls back to `OPENROUTER_MODELS` or the built-in default.

### Run tests

```bash
cd server
npx vitest run     # or: bun run test
```

## Deploy (Docker)

The container listens on port **3000** (internal). It is **not** mapped to the host — Caddy reaches it through the Docker network (`reverse_proxy api-service:3000`), so no host port has to be free.

```bash
cd server
docker build -t ai-router .
docker compose up -d   # production: no host port mapping, Caddy proxies via proxy-network
```

**Local development** (you need direct access from the host):

```bash
cd server
docker compose -f compose.yml -f compose.dev.yml up -d   # maps 3000:3000
```

### Deploying via Coolify

The compose file is the source of truth: paste `compose.yml` into Coolify and manage the image via `npm run deploy` (build + push to Docker Hub).

- Use `${VAR}` interpolation for secrets (`GROQ_API_KEY`, `GOOGLE_API_KEY`, `API_TOKEN`, ...) — Coolify detects them and makes them editable in its UI.
- Use **literal values** for fixed config like `DEEPSEEK_MODEL: deepseek-chat` and `FIRST_TOKEN_TIMEOUT_MS: 8000`. A self-referencing `${DEEPSEEK_MODEL:-}` gets flagged "Managed by Docker Compose" and locked (not editable in the UI).
- The container listens on internal port `3000`, no host mapping needed — assign a domain in Coolify's UI (its proxy reaches the container by name), or use the `proxy-network` with an external Caddy.
- Healthcheck hits `GET /health` so Coolify shows healthy/unhealthy.
