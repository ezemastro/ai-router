import { ProviderHttpError, BODY_SNIPPET_LIMIT } from '../providers/openai-compatible';
import { type AIService, serviceId } from '../types';

/**
 * Latency-aware scheduler with per-provider circuit breaking.
 *
 * Ordering is driven by time-to-first-token (TTFT), not throughput: for a
 * streaming proxy TTFT is what a caller actually perceives as "fast". Tokens
 * per second is tracked too, but purely for observability — it deliberately
 * does NOT influence candidate order.
 *
 * Failures come in two flavours. A *model-level* failure (404 / 410) condemns
 * one model ID, not the provider: free-tier catalogues rotate constantly, and
 * a provider listing four models should not be knocked out by one dead ID.
 * Everything else (401/402/403/429/5xx/network/timeout) is *provider-level*
 * and feeds the cooldown table below.
 */

const TTFT_ALPHA = 0.3;
const THROUGHPUT_ALPHA = 0.3;

const AUTH_COOLDOWN_MS = 30 * 60 * 1000; // 401 / 403 — a bad key will stay bad.
const PAYMENT_COOLDOWN_MS = 60 * 60 * 1000; // 402 — out of credit.
const NOT_FOUND_COOLDOWN_MS = 30 * 60 * 1000; // 404 / 410 — model ID deprecated or gone.
const RATE_LIMIT_BASE_MS = 60 * 1000;
const RATE_LIMIT_MAX_MS = 15 * 60 * 1000;
const TRANSIENT_BASE_MS = 5 * 1000;
const TRANSIENT_MAX_MS = 5 * 60 * 1000;

/**
 * Hard ceiling on how many models of one provider a single request may try.
 * The provider's own list length is the usual bound, but OpenRouter's `:free`
 * discovery can return dozens of IDs and each attempt costs a full first-token
 * timeout, so the walk is clamped.
 */
export const MAX_MODEL_ATTEMPTS_PER_PROVIDER = 4;

/** 404/410 mean "this model is gone", not "this provider is down". */
export function isModelLevelFailure(status: number | undefined): boolean {
  return status === 404 || status === 410;
}

export interface FailureInfo {
  /** HTTP status when the failure came from the provider; omitted for network/timeouts. */
  status?: number;
  /** Short, already-sanitized reason. Never a raw provider body. */
  reason: string;
  retryAfterMs?: number;
  /** Model this failure belongs to: drives the dead-model set and the 404/410 log. */
  model?: string;
}

interface ProviderState {
  ttftMs?: number;
  tokensPerSec?: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastError?: string;
  /** Model IDs that answered 404/410. Survives provider recovery. */
  deadModels: Set<string>;
  /** Last model of this provider that produced a first token. */
  activeModel?: string;
  /** Signature of the model list the two fields above were learned from. */
  modelsSignature?: string;
}

const states = new Map<string, ProviderState>();

function stateOf(id: string): ProviderState {
  let state = states.get(id);
  if (!state) {
    state = { consecutiveFailures: 0, cooldownUntil: 0, deadModels: new Set() };
    states.set(id, state);
  }
  return state;
}

function ewma(previous: number | undefined, sample: number, alpha: number): number {
  return previous === undefined ? sample : alpha * sample + (1 - alpha) * previous;
}

function backoff(base: number, max: number, streak: number): number {
  const exponent = Math.max(0, streak - 1);
  return Math.min(max, base * 2 ** Math.min(exponent, 20));
}

/** Test seam: wipes every measurement and cooldown. */
export function resetScheduler(): void {
  states.clear();
}

/**
 * A first token arrived: the provider is healthy again.
 *
 * `model` is remembered as the provider's last-good model so the next request
 * starts there instead of re-walking a dead prefix. The dead-model set is NOT
 * cleared — one working model does not resurrect the others — but the model
 * that just worked is removed from it.
 */
export function recordFirstToken(id: string, ttftMs: number, model?: string): void {
  const state = stateOf(id);
  state.ttftMs = ewma(state.ttftMs, ttftMs, TTFT_ALPHA);
  state.consecutiveFailures = 0;
  state.cooldownUntil = 0;
  state.lastError = undefined;
  if (model) {
    state.activeModel = model;
    state.deadModels.delete(model);
  }
}

/**
 * Forgets the per-model memory when the resolved model list changes, so an
 * env override or a fresh OpenRouter discovery starts from a clean slate.
 */
function syncModels(id: string, models: string[]): ProviderState {
  const state = stateOf(id);
  const signature = models.join('\u0000');
  if (state.modelsSignature !== signature) {
    state.modelsSignature = signature;
    state.deadModels.clear();
    state.activeModel = undefined;
  }
  return state;
}

/**
 * Order in which one provider's models should be tried for a single request:
 * the last-good model first, then never-failed models in list order, then the
 * known-dead ones last. Dead IDs are demoted rather than dropped so a provider
 * that resurrects a model can recover without a restart, and the whole walk is
 * clamped by `MAX_MODEL_ATTEMPTS_PER_PROVIDER`.
 */
export function planModelAttempts(service: AIService, models: string[]): string[] {
  const state = syncModels(serviceId(service), models);
  const unique = [...new Set(models.filter(Boolean))];
  const active = state.activeModel && unique.includes(state.activeModel) ? state.activeModel : undefined;
  const rest = unique.filter((model) => model !== active);
  const ordered = [
    ...(active ? [active] : []),
    ...rest.filter((model) => !state.deadModels.has(model)),
    ...rest.filter((model) => state.deadModels.has(model)),
  ];
  return ordered.slice(0, MAX_MODEL_ATTEMPTS_PER_PROVIDER);
}

/**
 * One model of a provider is gone (404/410). This is deliberately quiet and
 * costs no cooldown: the caller moves on to the provider's next model, and
 * only an exhausted provider reaches `recordFailure`.
 */
export function recordDeadModel(service: AIService, model: string | undefined, info: FailureInfo): void {
  if (!model) return;
  const state = stateOf(serviceId(service));
  state.deadModels.add(model);
  if (state.activeModel === model) state.activeModel = undefined;
  console.warn(
    `[scheduler] ${service.name} model "${model}" is gone (${info.status ?? '-'}); ` +
      `trying the provider's next model`,
  );
}

/** Observability only — never used for ordering. */
export function recordThroughput(id: string, tokensPerSec: number): void {
  if (!Number.isFinite(tokensPerSec) || tokensPerSec <= 0) return;
  const state = stateOf(id);
  state.tokensPerSec = ewma(state.tokensPerSec, tokensPerSec, THROUGHPUT_ALPHA);
}

function cooldownFor(status: number | undefined, info: FailureInfo, streak: number): number {
  if (status === 401 || status === 403) return AUTH_COOLDOWN_MS;
  if (status === 402) return PAYMENT_COOLDOWN_MS;
  // 410 shares the 404 cooldown: a provider exhausted of models must not be
  // re-walked on a 5s transient backoff, paying a round-trip per dead model
  // on every request.
  if (status === 404 || status === 410) return NOT_FOUND_COOLDOWN_MS;
  if (status === 429) {
    const base = info.retryAfterMs && info.retryAfterMs > 0 ? info.retryAfterMs : RATE_LIMIT_BASE_MS;
    return backoff(base, RATE_LIMIT_MAX_MS, streak);
  }
  // 5xx, network errors and first-token timeouts.
  return backoff(TRANSIENT_BASE_MS, TRANSIENT_MAX_MS, streak);
}

export function recordFailure(service: AIService, info: FailureInfo, now = Date.now()): void {
  const id = serviceId(service);
  const state = stateOf(id);
  state.consecutiveFailures += 1;
  state.lastError = `${info.status ? `${info.status} ` : ''}${info.reason}`.slice(
    0,
    BODY_SNIPPET_LIMIT,
  );
  state.cooldownUntil = now + cooldownFor(info.status, info, state.consecutiveFailures);

  if (isModelLevelFailure(info.status)) {
    // Reached only once the provider has no model left to try, so this stays a
    // one-per-provider alarm instead of one line per model attempt.
    console.error(
      `[scheduler] ${service.name} ran out of working models — the last attempt ` +
        `("${info.model ?? 'unknown'}") returned ${info.status}, so the model ID is ` +
        `probably deprecated. Update the built-in list or set the provider's ` +
        `*_MODELS env override. Cooling down until ${new Date(state.cooldownUntil).toISOString()}.`,
    );
  } else {
    console.warn(
      `[scheduler] ${service.name} failed (${state.lastError}); ` +
        `cooldown until ${new Date(state.cooldownUntil).toISOString()}`,
    );
  }
}

/** Turns any thrown value into the sanitized shape the scheduler records. */
export function describeFailure(err: unknown, model?: string): FailureInfo {
  if (err instanceof ProviderHttpError) {
    return {
      status: err.status,
      reason: err.bodySnippet || `HTTP ${err.status}`,
      retryAfterMs: err.retryAfterMs,
      model,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { reason: message.slice(0, BODY_SNIPPET_LIMIT) || 'unknown error', model };
}

export function isAvailable(service: AIService, now = Date.now()): boolean {
  return stateOf(serviceId(service)).cooldownUntil <= now;
}

/**
 * Healthy providers ordered by measured TTFT ascending.
 *
 * Providers without a measurement are scored at the best measured TTFT rather
 * than at infinity, so they get a fair first shot instead of starving behind
 * whoever happened to be measured first; `speedRank` breaks the resulting tie.
 */
export function orderCandidates(services: AIService[], now = Date.now()): AIService[] {
  const healthy = services.filter((service) => isAvailable(service, now));
  const measured = healthy
    .map((service) => stateOf(serviceId(service)).ttftMs)
    .filter((ttft): ttft is number => ttft !== undefined);
  const bestMeasured = measured.length > 0 ? Math.min(...measured) : 0;

  return healthy
    .map((service, index) => {
      const state = stateOf(serviceId(service));
      return {
        service,
        index,
        score: state.ttftMs ?? bestMeasured,
        rank: service.speedRank ?? Number.MAX_SAFE_INTEGER,
      };
    })
    .sort((a, b) => a.score - b.score || a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.service);
}

export interface ProviderSnapshot {
  id: string;
  label: string;
  models: string[];
  requiresAuth: boolean;
  configured: boolean;
  speedRank: number | null;
  inCooldown: boolean;
  cooldownUntil: string | null;
  ttftMs: number | null;
  tokensPerSec: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  /** Model IDs that answered 404/410 — the dead ones, in the order they died. */
  deadModels: string[];
  /** Model that last produced a first token, tried first on the next request. */
  activeModel: string | null;
}

/**
 * Per-provider health/latency view. Contains no key material and no raw
 * provider body beyond the already-truncated snippet.
 */
export function snapshot(services: AIService[], now = Date.now()): ProviderSnapshot[] {
  return services.map((service) => {
    const models = service.models;
    // Keeps the reported dead/active models honest after a list change.
    const state = syncModels(serviceId(service), models);
    return {
      id: serviceId(service),
      label: service.name,
      models,
      requiresAuth: Boolean(service.requiresAuth),
      // Registered at all means the key was present when the registry was built.
      configured: true,
      speedRank: service.speedRank ?? null,
      inCooldown: state.cooldownUntil > now,
      cooldownUntil: state.cooldownUntil > now ? new Date(state.cooldownUntil).toISOString() : null,
      ttftMs: state.ttftMs === undefined ? null : Math.round(state.ttftMs),
      tokensPerSec: state.tokensPerSec === undefined ? null : Math.round(state.tokensPerSec * 10) / 10,
      consecutiveFailures: state.consecutiveFailures,
      lastError: state.lastError ?? null,
      deadModels: [...state.deadModels],
      activeModel: state.activeModel ?? null,
    };
  });
}
