import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderHttpError } from '../providers/openai-compatible';
import {
  describeFailure,
  isAvailable,
  orderCandidates,
  recordFailure,
  recordFirstToken,
  recordThroughput,
  resetScheduler,
  snapshot,
} from '../router/scheduler';
import type { AIService } from '../types';

function svc(id: string, speedRank: number): AIService {
  return {
    id,
    name: id.toUpperCase(),
    models: [`${id}-model`],
    requiresAuth: false,
    speedRank,
    chat: async () => (async function* () {})(),
  };
}

const MINUTE = 60 * 1000;

describe('scheduler cooldowns', () => {
  beforeEach(() => {
    resetScheduler();
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  const now = 1_000_000;

  it.each([
    [401, 30 * MINUTE],
    [403, 30 * MINUTE],
    [402, 60 * MINUTE],
    [404, 30 * MINUTE],
  ])('status %i cools down for %i ms', (status, expected) => {
    const service = svc('p', 1);
    recordFailure(service, { status, reason: 'x' }, now);
    expect(snapshot([service], now)[0]!.cooldownUntil).toBe(new Date(now + expected).toISOString());
  });

  it('honours Retry-After on 429 and backs off on repeats up to 15 min', () => {
    const service = svc('p', 1);
    recordFailure(service, { status: 429, reason: 'slow down', retryAfterMs: 10_000 }, now);
    expect(isAvailable(service, now + 9_000)).toBe(false);
    expect(isAvailable(service, now + 11_000)).toBe(true);

    recordFailure(service, { status: 429, reason: 'slow down', retryAfterMs: 10_000 }, now);
    expect(isAvailable(service, now + 19_000)).toBe(false);

    for (let i = 0; i < 20; i++) recordFailure(service, { status: 429, reason: 'slow' }, now);
    expect(isAvailable(service, now + 15 * MINUTE + 1)).toBe(true);
  });

  it('429 without Retry-After falls back to 60s', () => {
    const service = svc('p', 1);
    recordFailure(service, { status: 429, reason: 'slow' }, now);
    expect(isAvailable(service, now + 59_000)).toBe(false);
    expect(isAvailable(service, now + 61_000)).toBe(true);
  });

  it('transient failures back off from 5s and cap at 5 min', () => {
    const service = svc('p', 1);
    recordFailure(service, { reason: 'ECONNRESET' }, now);
    expect(isAvailable(service, now + 4_000)).toBe(false);
    expect(isAvailable(service, now + 6_000)).toBe(true);

    for (let i = 0; i < 20; i++) recordFailure(service, { reason: 'ECONNRESET' }, now);
    expect(isAvailable(service, now + 5 * MINUTE + 1)).toBe(true);
  });

  it('logs loudly and names the model on 404', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    recordFailure(svc('groq', 1), { status: 404, reason: 'not found', model: 'llama-3.3-70b-versatile' }, now);
    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).toContain('GROQ');
    expect(logged).toContain('llama-3.3-70b-versatile');
    expect(logged).toContain('deprecated');
  });

  it('a first token clears the cooldown and the failure streak', () => {
    const service = svc('p', 1);
    recordFailure(service, { status: 402, reason: 'no credit' }, now);
    expect(isAvailable(service, now)).toBe(false);

    recordFirstToken('p', 120);
    expect(isAvailable(service, now)).toBe(true);
    const view = snapshot([service], now)[0]!;
    expect(view.consecutiveFailures).toBe(0);
    expect(view.lastError).toBeNull();
  });
});

describe('scheduler ordering', () => {
  beforeEach(() => {
    resetScheduler();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('falls back to speedRank while nothing is measured', () => {
    const services = [svc('slow', 5), svc('fast', 1)];
    expect(orderCandidates(services).map((s) => s.id)).toEqual(['fast', 'slow']);
  });

  it('prefers the lower measured TTFT over the seed rank', () => {
    const services = [svc('a', 1), svc('b', 9)];
    recordFirstToken('a', 900);
    recordFirstToken('b', 120);
    expect(orderCandidates(services).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('gives unmeasured providers the best measured score so they are not starved', () => {
    const services = [svc('measured', 1), svc('unmeasured', 2)];
    recordFirstToken('measured', 400);
    // Scored equal to the best measurement, then speedRank breaks the tie.
    expect(orderCandidates(services).map((s) => s.id)).toEqual(['measured', 'unmeasured']);

    resetScheduler();
    recordFirstToken('measured', 400);
    const flipped = [svc('measured', 5), svc('unmeasured', 1)];
    expect(orderCandidates(flipped).map((s) => s.id)).toEqual(['unmeasured', 'measured']);
  });

  it('drops providers that are in cooldown', () => {
    const services = [svc('a', 1), svc('b', 2)];
    recordFailure(services[0]!, { status: 402, reason: 'no credit' }, Date.now());
    expect(orderCandidates(services).map((s) => s.id)).toEqual(['b']);
  });

  it('smooths TTFT with an EWMA instead of jumping to the last sample', () => {
    const service = svc('p', 1);
    recordFirstToken('p', 100);
    recordFirstToken('p', 1100);
    // alpha 0.3 -> 0.3*1100 + 0.7*100 = 400
    expect(snapshot([service])[0]!.ttftMs).toBe(400);
  });
});

describe('scheduler observability', () => {
  beforeEach(() => {
    resetScheduler();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('tracks tokens/sec without letting it affect ordering', () => {
    const services = [svc('a', 1), svc('b', 2)];
    recordFirstToken('a', 500);
    recordFirstToken('b', 600);
    recordThroughput('a', 10);
    recordThroughput('b', 900);
    expect(snapshot(services).map((s) => s.tokensPerSec)).toEqual([10, 900]);
    // b is far faster in tokens/sec yet a still wins on TTFT.
    expect(orderCandidates(services).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('sanitizes the recorded error and keeps it short', () => {
    const service = svc('p', 1);
    recordFailure(service, { status: 500, reason: 'y'.repeat(1000) });
    const lastError = snapshot([service])[0]!.lastError!;
    expect(lastError.length).toBeLessThanOrEqual(300);
    expect(lastError.startsWith('500 ')).toBe(true);
  });

  it('describeFailure maps a ProviderHttpError onto the recorded shape', () => {
    const info = describeFailure(
      new ProviderHttpError({
        status: 402,
        providerId: 'cerebras',
        bodySnippet: 'Payment required',
        retryAfterMs: 5000,
      }),
      'gpt-oss-120b',
    );
    expect(info).toEqual({
      status: 402,
      reason: 'Payment required',
      retryAfterMs: 5000,
      model: 'gpt-oss-120b',
    });
  });

  it('describeFailure handles plain errors without a status', () => {
    expect(describeFailure(new Error('fetch failed'))).toEqual({
      reason: 'fetch failed',
      model: undefined,
    });
  });
});
