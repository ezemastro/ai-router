/**
 * OpenRouter's `:free` catalogue churns constantly, so hardcoding it guarantees
 * a stale list. We discover it instead: refreshed at most once an hour, always
 * off the request path, and every failure falls back to the configured list.
 */
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

let discovered: string[] | null = null;
let lastAttemptAt = 0;
let inFlight: Promise<void> | null = null;

/** Discovery must never run during tests — it would mean a real network call. */
function discoveryDisabled(): boolean {
  return Boolean(process.env.VITEST) || process.env.AI_ROUTER_DISABLE_DISCOVERY === '1';
}

export function getDiscoveredFreeModels(): string[] | null {
  return discovered;
}

/** Test seam. */
export function resetOpenRouterDiscovery(): void {
  discovered = null;
  lastAttemptAt = 0;
  inFlight = null;
}

async function refresh(apiKey: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(MODELS_URL, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const free = (body.data ?? [])
      .map((entry) => entry?.id)
      .filter((id): id is string => typeof id === 'string' && id.endsWith(':free'));
    if (free.length > 0) {
      discovered = free;
      console.log(`[openrouter] discovered ${free.length} free models`);
    }
  } catch (err) {
    console.warn(
      `[openrouter] free-model discovery failed, keeping fallback list: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget refresh. Returns immediately; callers keep serving from the
 * previous list (or the configured fallback) while this runs.
 */
export function scheduleOpenRouterRefresh(apiKey: string): void {
  if (discoveryDisabled() || inFlight) return;
  const now = Date.now();
  if (lastAttemptAt !== 0 && now - lastAttemptAt < REFRESH_INTERVAL_MS) return;
  lastAttemptAt = now;
  inFlight = refresh(apiKey).finally(() => {
    inFlight = null;
  });
}
