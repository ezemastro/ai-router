# AI Router

Round-robin proxy that distributes chat requests across multiple LLM providers. Each call to `/chat` rotates to the next service automatically — no client-side logic needed.

**Base URL:** `https://ai-router.mastropietro.work.gd`

## Quickstart

```bash
curl -X POST https://ai-router.mastropietro.work.gd/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Explain round-robin load balancing in 2 sentences"}
    ]
  }'
```

The response is a **Server-Sent Events (SSE)** stream. Each chunk arrives as a line starting with `data: `.

## API Reference

### `GET /health`

Returns the service status.

```bash
curl https://ai-router.mastropietro.work.gd/health
```

**Response:**
```json
{ "status": "ok" }
```

### `POST /chat`

Sends a conversation to the next provider in the round-robin and streams back the response.

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

**Response:** SSE stream (`text/event-stream`) with the model's tokens.

## Current Providers

Requests are distributed round-robin across these backends:

| Provider | Model | Latency |
|----------|-------|---------|
| Groq | `llama-3.3-70b-versatile` | Fast |
| Cerebras | `llama3.1-8b` | Fast |

> OpenRouter is disabled due to high latency. Uncomment it in `server/index.ts` and `server/services/openrouter.ts` if you want to re-enable it.

## Architecture

```
Client  --->  /chat (Bun server)  --->  Round-robin dispatcher
                                          ├── Groq
                                          └── Cerebras
```

- Built with **Bun** and TypeScript.
- Each provider is an isolated module in `server/services/`.
- The router picks the next service on every request — no external load balancer needed.

## Local Development

```bash
cd server
bun install
bun run index.ts    # starts on http://localhost:3000
```

### Required environment variables

```bash
export GROQ_API_KEY="gsk_..."
export CEREBRAS_API_KEY="csk_..."
# export OPENROUTER_API_KEY="sk-or-..."   # not needed while commented out
```

### Run tests

```bash
cd server
bun test
```

## Deploy (Docker)

```bash
cd server
docker build -t ai-router .
docker run -p 3001:3001 -e GROQ_API_KEY -e CEREBRAS_API_KEY ai-router
```
