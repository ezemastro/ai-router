import { createHash, timingSafeEqual } from "node:crypto";
import { buildProviders } from "./providers/registry";
import {
  type FailureInfo,
  describeFailure,
  isModelLevelFailure,
  orderCandidates,
  planModelAttempts,
  recordDeadModel,
  recordFailure,
  recordFirstToken,
  recordThroughput,
  resetScheduler,
  snapshot,
} from "./router/scheduler";
import { type AIService, type ChatMessage, serviceId } from "./types";

const port = Number(process.env.PORT ?? 3000);

const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 8000;

/** Read live so deployments (and tests) can retune without a rebuild. */
function firstTokenTimeoutMs(): number {
  const raw = Number(process.env.FIRST_TOKEN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function withCors(res: Response): Response {
  for (const [key, value] of Object.entries(corsHeaders)) {
    res.headers.set(key, value);
  }
  return res;
}

function jsonResponse(body: unknown, status: number): Response {
  return withCors(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

function getContentType(path: string) {
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

/**
 * Providers self-register from the environment: a provider with no API key
 * simply does not exist, instead of becoming a guaranteed failure slot.
 */
let services: AIService[] = buildProviders();

/** Injection point for tests — replaces the registry and clears latency state. */
export function setServices(newServices: AIService[]) {
  services = newServices;
  resetScheduler();
}

export function getServices(): AIService[] {
  return services;
}

function isAuthorized(req: Request): boolean {
  // env read live so tests can set API_TOKEN after import
  const expected = process.env.API_TOKEN || "";
  if (!expected) return false;
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(token).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * SSE framing is load-bearing for downstream clients: `data: <raw token>\n\n`
 * per chunk (plain text, never per-chunk JSON) and `data: [DONE]\n\n` at the end.
 */
function toSSEStream(
  service: AIService,
  iterator: AsyncIterator<string>,
  options: {
    bufferedFirst?: string;
    firstTokenAt?: number;
    startedAt: number;
    model?: string;
  },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = serviceId(service);
  let chunkCount = 0;
  let firstTokenAt = options.firstTokenAt;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (options.bufferedFirst !== undefined) {
          // The token consumed while deciding the winner must not be dropped.
          chunkCount += 1;
          controller.enqueue(encoder.encode(`data: ${options.bufferedFirst}\n\n`));
        }
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          const chunk = next.value;
          if (!chunk) continue;
          if (firstTokenAt === undefined) {
            firstTokenAt = Date.now();
            recordFirstToken(id, firstTokenAt - options.startedAt, options.model);
          }
          chunkCount += 1;
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        }
        if (firstTokenAt !== undefined && chunkCount > 1) {
          const seconds = (Date.now() - firstTokenAt) / 1000;
          // Chunks approximate tokens closely enough for an observability gauge.
          if (seconds > 0) recordThroughput(id, (chunkCount - 1) / seconds);
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err: any) {
        // Headers are already sent, so failing over is no longer possible.
        console.error(`[/chat] stream error: ${err?.message ?? err}`);
        const sanitized = JSON.stringify({ error: String(err?.message ?? "error").slice(0, 500) }).replace(/[\r\n]/g, " ");
        controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
        controller.close();
      }
    },
    async cancel() {
      try {
        await iterator.return?.();
      } catch {
        // consumer cancelled mid-stream; nothing else to clean up
      }
    },
  });
}

function streamHeaders(service: AIService): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Provider": service.name,
  };
}

interface Attempt {
  provider: string;
  /** Model this attempt used; null when the provider has no model list. */
  model: string | null;
  status: number | null;
  reason: string;
}

type CandidateResult =
  | {
      ok: true;
      first: string;
      iterator: AsyncIterator<string>;
      startedAt: number;
      firstTokenAt: number;
    }
  | { ok: false; attempt: Attempt; info: FailureInfo };

/** Drains empty deltas until the first real token, or the stream ends. */
async function pullFirstToken(iterator: AsyncIterator<string>): Promise<string | null> {
  while (true) {
    const next = await iterator.next();
    if (next.done) return null;
    if (next.value) return next.value;
  }
}

const TIMED_OUT = Symbol("first-token-timeout");

/**
 * Starts a request and waits for its first content token before committing
 * anything to the client. Only a provider that actually produced a token wins
 * the response.
 *
 * Failures are described but NOT recorded here: the caller decides whether a
 * failure condemns one model or the whole provider.
 */
async function tryCandidate(
  service: AIService,
  messages: ChatMessage[],
  model: string | undefined,
  timeoutMs: number,
): Promise<CandidateResult> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const failed = (info: FailureInfo): CandidateResult => ({
    ok: false,
    info,
    attempt: {
      provider: service.name,
      model: model ?? null,
      status: info.status ?? null,
      reason: info.reason,
    },
  });

  let iterable: AsyncIterable<string>;
  try {
    iterable = await service.chat(messages, model, controller.signal);
  } catch (err) {
    return failed(describeFailure(err, model));
  }

  const iterator = iterable[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });

  const pending = pullFirstToken(iterator);
  // If the timeout wins the race, the pull may still reject later.
  pending.catch(() => {});

  let outcome: string | null | typeof TIMED_OUT;
  try {
    outcome = await Promise.race([pending, timeout]);
  } catch (err) {
    clearTimeout(timer);
    controller.abort();
    return failed(describeFailure(err, model));
  }
  clearTimeout(timer);

  if (outcome === TIMED_OUT || outcome === null) {
    controller.abort();
    void Promise.resolve(iterator.return?.()).catch(() => {});
    const reason =
      outcome === TIMED_OUT
        ? `no first token within ${timeoutMs}ms`
        : "stream closed without emitting any token";
    return failed({ reason, model });
  }

  const firstTokenAt = Date.now();
  recordFirstToken(serviceId(service), firstTokenAt - startedAt, model);
  return { ok: true, first: outcome, iterator, startedAt, firstTokenAt };
}

async function handleChat(req: Request): Promise<Response> {
  let body: { messages?: ChatMessage[]; model?: string };
  try {
    body = (await req.json()) as { messages?: ChatMessage[]; model?: string };
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  const messages = body.messages ?? [];

  // Pinned model: the caller asked for this exact model, so never fail over.
  if (body.model) {
    const normalized = body.model.toLowerCase();
    const service = services.find(
      (s) =>
        s.models.some((m) => m.toLowerCase() === normalized) ||
        s.name.toLowerCase() === normalized,
    );
    if (!service) {
      return jsonResponse({ error: "Modelo no soportado" }, 400);
    }
    if (service.requiresAuth && !isAuthorized(req)) {
      return jsonResponse({ error: "No autorizado" }, 401);
    }

    const startedAt = Date.now();
    try {
      const stream = await service.chat(messages, body.model);
      return withCors(new Response(
        toSSEStream(service, stream[Symbol.asyncIterator](), { startedAt, model: body.model }),
        { headers: streamHeaders(service) },
      ));
    } catch (err: any) {
      const info = describeFailure(err, body.model);
      // A pinned model never walks the list — the caller asked for this exact
      // model — but a dead ID is still worth remembering for /providers.
      if (isModelLevelFailure(info.status)) recordDeadModel(service, body.model, info);
      recordFailure(service, info);
      console.error(`[/chat] ${service.name} falló: ${err?.message ?? err}`);
      return jsonResponse(
        { error: `Proveedor ${service.name} falló`, provider: service.name },
        502,
      );
    }
  }

  // Automatic routing: latency-ordered cascade over the free providers.
  const free = services.filter((s) => !s.requiresAuth);
  if (free.length === 0) {
    return jsonResponse({ error: "No hay proveedores gratuitos configurados", attempts: [] }, 502);
  }

  const timeoutMs = firstTokenTimeoutMs();
  const candidates = orderCandidates(free);
  const attempts: Attempt[] = [];

  for (const candidate of candidates) {
    // A dead model ID must not cost the provider its slot, so the cascade walks
    // the provider's own list first — last-good model first, dead IDs last.
    const plan = planModelAttempts(candidate, candidate.models);
    // A provider with no model list still gets one attempt, so it reports its
    // own error instead of silently disappearing from the cascade.
    const planned: Array<string | undefined> = plan.length > 0 ? plan : [undefined];
    let exhaustedBy: FailureInfo | undefined;

    for (const model of planned) {
      const result = await tryCandidate(candidate, messages, model, timeoutMs);
      if (result.ok) {
        return withCors(new Response(
          toSSEStream(candidate, result.iterator, {
            bufferedFirst: result.first,
            firstTokenAt: result.firstTokenAt,
            startedAt: result.startedAt,
            model,
          }),
          { headers: streamHeaders(candidate) },
        ));
      }
      attempts.push(result.attempt);

      if (isModelLevelFailure(result.info.status)) {
        // The model is gone, the provider may not be: try its next model.
        recordDeadModel(candidate, model, result.info);
        exhaustedBy = result.info;
        continue;
      }

      // Provider-level: cool the whole provider down and move on.
      recordFailure(candidate, result.info);
      exhaustedBy = undefined;
      break;
    }

    // Every model of this provider is gone — now the provider itself cools down.
    if (exhaustedBy) recordFailure(candidate, exhaustedBy);
  }

  // Everything in cooldown is reported too, so a total failure stays diagnosable.
  const skipped = free.filter((s) => !candidates.includes(s));
  for (const service of skipped) {
    attempts.push({ provider: service.name, model: null, status: null, reason: "in cooldown, skipped" });
  }

  console.error(`[/chat] every free provider failed: ${attempts.map((a) => `${a.provider}=${a.status ?? "-"}`).join(", ")}`);

  // Naming the last provider in the cascade blames whoever happened to be last;
  // only a single-provider failure may be attributed to that provider.
  const involved = [...new Set(attempts.map((a) => a.provider))];
  const soleProvider = involved.length === 1 ? involved[0]! : null;
  // Total failure answers JSON, never text/event-stream — clients detect it by content-type.
  return jsonResponse(
    soleProvider
      ? { error: `Proveedor ${soleProvider} falló`, provider: soleProvider, attempts }
      : { error: "Todos los proveedores gratuitos fallaron", provider: null, attempts },
    502,
  );
}

export async function handleRequest(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  if (pathname === "/health") {
    return jsonResponse({ status: "ok" }, 200);
  }

  if (req.method === "GET" && pathname === "/providers") {
    const free = services.filter((s) => !s.requiresAuth);
    const order = orderCandidates(free);
    return jsonResponse({
      firstTokenTimeoutMs: firstTokenTimeoutMs(),
      preferred: order[0] ? serviceId(order[0]) : null,
      candidateOrder: order.map(serviceId),
      providers: snapshot(services),
    }, 200);
  }

  // Serve minimal static frontend from ./public when running under Bun
  if (req.method === "GET") {
    if (pathname === "/" || pathname.startsWith("/static/")) {
      if (typeof Bun !== "undefined") {
        const rel = pathname === "/" ? "/index.html" : pathname.replace(/^\/static/, "");
        const filePath = `./public${rel}`;
        try {
          return withCors(new Response(Bun.file(filePath), {
            headers: { "Content-Type": getContentType(filePath) },
          }));
        } catch (e) {
          return withCors(new Response("Not found", { status: 404 }));
        }
      }
    }
  }

  if (req.method === "POST" && pathname === "/chat") {
    return handleChat(req);
  }

  return withCors(new Response("Not found", { status: 404 }));
}

// Start server only when run as entrypoint, not when imported (e.g. by tests)
if (import.meta.main) {
  Bun.serve({
    port,
    fetch: handleRequest,
  });

  const registered = services.map((s) => `${s.name}[${s.models.join("|")}]`).join(", ") || "none";
  console.log(`Server listening on http://localhost:${port}`);
  console.log(`Registered providers: ${registered}`);
  console.log(`First-token timeout: ${firstTokenTimeoutMs()}ms`);
}
