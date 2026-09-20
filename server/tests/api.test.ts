import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest, setServices } from '../index';
import { ProviderHttpError } from '../providers/openai-compatible';
import { buildProviders, PROVIDER_DESCRIPTORS, resolveModels } from '../providers/registry';
import { recordFirstToken, resetScheduler } from '../router/scheduler';
import type { AIService, ChatMessage } from '../types';

function mockService(
  name: string,
  models: string[],
  requiresAuth: boolean,
  chunks: string[],
  extra: Partial<AIService> = {},
): AIService {
  return {
    id: name.toLowerCase(),
    name,
    models,
    requiresAuth,
    chat: async (_messages: ChatMessage[], _model?: string) => {
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
    ...extra,
  };
}

/** Fails at request time, the way a 402/404 from a real provider does. */
function failingService(name: string, models: string[], status: number, body = 'nope'): AIService {
  return {
    id: name.toLowerCase(),
    name,
    models,
    requiresAuth: false,
    chat: async () => {
      throw new ProviderHttpError({ status, providerId: name.toLowerCase(), bodySnippet: body });
    },
  };
}

/** Accepts the request, then never emits a token. */
function silentService(name: string, models: string[]): AIService {
  return {
    id: name.toLowerCase(),
    name,
    models,
    requiresAuth: false,
    chat: async () =>
      (async function* () {
        await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
        yield 'too late';
      })(),
  };
}

function trackingService(
  name: string,
  models: string[],
  requiresAuth = false,
  chunks: string[] = ['x'],
): { service: AIService; calls: string[] } {
  const calls: string[] = [];
  const service: AIService = {
    id: name.toLowerCase(),
    name,
    models,
    requiresAuth,
    chat: async (_messages: ChatMessage[], _model?: string) => {
      calls.push(name);
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
  return { service, calls };
}

function chatRequest(body: object, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('API', () => {
  beforeEach(() => {
    resetScheduler();
  });

  afterEach(() => {
    delete process.env.API_TOKEN;
    delete process.env.FIRST_TOKEN_TIMEOUT_MS;
    setServices([]);
  });

  it('GET /health devuelve status ok', async () => {
    const res = await handleRequest(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const json = await res.json();
    expect(json).toEqual({ status: 'ok' });
  });

  it('OPTIONS responde 204 con CORS', async () => {
    const res = await handleRequest(new Request('http://localhost/chat', { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('POST /chat emite SSE con framing exacto', async () => {
    setServices([mockService('Mock', ['mock-model'], false, ['chunk1', 'chunk2'])]);

    const res = await handleRequest(chatRequest({
      messages: [{ role: 'user', content: 'hi' }],
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toBe('data: chunk1\n\ndata: chunk2\n\ndata: [DONE]\n\n');
  });

  it('POST /chat con JSON inválido devuelve 400', async () => {
    const res = await handleRequest(new Request('http://localhost/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'no-json',
    }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('JSON inválido');
  });

  it('modelo pagado exige token API válido', async () => {
    setServices([
      mockService('Free', ['free-model'], false, ['free']),
      mockService('Paid', ['paid-model'], true, ['ok']),
    ]);
    process.env.API_TOKEN = 'secret-token';

    const noAuth = await handleRequest(chatRequest({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'paid-model',
    }));
    expect(noAuth.status).toBe(401);
    expect(((await noAuth.json()) as { error: string }).error).toBe('No autorizado');

    const wrongAuth = await handleRequest(chatRequest({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'paid-model',
    }, { Authorization: 'Bearer wrong' }));
    expect(wrongAuth.status).toBe(401);

    const correctAuth = await handleRequest(chatRequest({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'paid-model',
    }, { Authorization: 'Bearer secret-token' }));
    expect(correctAuth.status).toBe(200);
    expect(await correctAuth.text()).toBe('data: ok\n\ndata: [DONE]\n\n');
  });

  it('el token API falla cerrado cuando no hay API_TOKEN configurado', async () => {
    setServices([mockService('Paid', ['paid-model'], true, ['ok'])]);
    const res = await handleRequest(chatRequest({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'paid-model',
    }, { Authorization: 'Bearer anything' }));
    expect(res.status).toBe(401);
  });

  it('el despacho automático omite proveedores con requiresAuth', async () => {
    const free = trackingService('Free1', ['free-model-1']);
    const paid = trackingService('Paid', ['paid-model'], true);
    setServices([free.service, paid.service]);

    for (let i = 0; i < 3; i++) {
      const res = await handleRequest(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }));
      await res.text();
    }

    expect(free.calls).toEqual(['Free1', 'Free1', 'Free1']);
    expect(paid.calls).toEqual([]);
  });

  it('modelo desconocido devuelve 400', async () => {
    setServices([mockService('Free', ['free-model'], false, [])]);

    const res = await handleRequest(chatRequest({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'no-existe',
    }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('Modelo no soportado');
  });

  it('sin proveedores gratuitos configurados devuelve 502 JSON', async () => {
    setServices([mockService('Paid', ['paid-model'], true, ['ok'])]);
    const res = await handleRequest(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(res.status).toBe(502);
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });
});

describe('failover', () => {
  beforeEach(() => {
    resetScheduler();
  });

  afterEach(() => {
    delete process.env.FIRST_TOKEN_TIMEOUT_MS;
    setServices([]);
  });

  it('cae al siguiente proveedor cuando el primero falla', async () => {
    const good = trackingService('Good', ['good-model'], false, ['alpha', 'beta']);
    setServices([failingService('Broken', ['broken-model'], 500), good.service]);

    const res = await handleRequest(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: alpha\n\ndata: beta\n\ndata: [DONE]\n\n');
    expect(good.calls).toEqual(['Good']);
  });

  it('abandona un proveedor que nunca emite el primer token', async () => {
    process.env.FIRST_TOKEN_TIMEOUT_MS = '50';
    setServices([
      silentService('Silent', ['silent-model']),
      mockService('Backup', ['backup-model'], false, ['ok']),
    ]);

    const res = await handleRequest(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('data: ok\n\ndata: [DONE]\n\n');
  });

  it('el primer token consumido no se pierde ni se duplica', async () => {
    setServices([
      failingService('Broken', ['broken-model'], 500),
      mockService('Good', ['good-model'], false, ['A', 'B', 'C']),
    ]);

    const res = await handleRequest(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }));
    const text = await res.text();
    expect(text).toBe('data: A\n\ndata: B\n\ndata: C\n\ndata: [DONE]\n\n');
    expect(text.match(/data: A\n\n/g)).toHaveLength(1);
  });

  it('un proveedor que cierra sin emitir tokens no gana la respuesta', async () => {
    setServices([
      mockService('Empty', ['empty-model'], false, []),
      mockService('Good', ['good-model'], false, ['ok']),
    ]);

    const res = await handleRequest(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('data: ok\n\ndata: [DONE]\n\n');
  });

  it('un fallo posterior al primer token NO hace failover y emite el frame de error', async () => {
    const backup = trackingService('Backup', ['backup-model']);
    const flaky: AIService = {
      id: 'flaky',
      name: 'Flaky',
      models: ['flaky-model'],
      requiresAuth: false,
      speedRank: 1,
      chat: async () =>
        (async function* () {
          yield 'primero';
          throw new Error('la conexión se cortó');
        })(),
    };
    setServices([flaky, backup.service]);

    const res = await handleRequest(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toBe('data: primero\n\ndata: {"error":"la conexión se cortó"}\n\n');
    // Headers were already sent, so the backup must never be reached.
    expect(backup.calls).toEqual([]);
  });

  it('si fallan todos los gratuitos devuelve 502 JSON con attempts', async () => {
    setServices([
      failingService('A', ['a-model'], 500, 'boom-a'),
      failingService('B', ['b-model'], 503, 'boom-b'),
    ]);

    const res = await handleRequest(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(res.status).toBe(502);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const json = (await res.json()) as {
      error: string;
      attempts: Array<{ provider: string; status: number | null; reason: string }>;
    };
    expect(json.error).toBe('Proveedor B falló');
    expect(json.attempts).toHaveLength(2);
    expect(json.attempts.map((a) => a.provider)).toEqual(['A', 'B']);
    expect(json.attempts.map((a) => a.status)).toEqual([500, 503]);
  });

  it('ordena por TTFT medido: el más rápido se intenta primero', async () => {
    const slow = trackingService('A', ['a-model']);
    const fast = trackingService('B', ['b-model']);
    setServices([slow.service, fast.service]);

    recordFirstToken('a', 900);
    recordFirstToken('b', 120);

    const res = await handleRequest(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }));
    await res.text();

    expect(fast.calls).toEqual(['B']);
    expect(slow.calls).toEqual([]);
  });

  it('un proveedor que devolvió 402 se omite en la petición siguiente', async () => {
    let brokenCalls = 0;
    const broken: AIService = {
      id: 'cerebras',
      name: 'Cerebras',
      models: ['gpt-oss-120b'],
      requiresAuth: false,
      chat: async () => {
        brokenCalls += 1;
        throw new ProviderHttpError({
          status: 402,
          providerId: 'cerebras',
          bodySnippet: 'Payment required',
        });
      },
    };
    const good = trackingService('Groq', ['openai/gpt-oss-120b']);
    setServices([broken, good.service]);

    const first = await handleRequest(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }));
    await first.text();
    expect(brokenCalls).toBe(1);
    expect(good.calls).toEqual(['Groq']);

    // The 60-minute payment cooldown must keep it out of the next rotation.
    const second = await handleRequest(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }));
    await second.text();
    expect(brokenCalls).toBe(1);
    expect(good.calls).toEqual(['Groq', 'Groq']);

    const providers = (await (
      await handleRequest(new Request('http://localhost/providers'))
    ).json()) as { candidateOrder: string[]; providers: Array<{ id: string; inCooldown: boolean }> };
    expect(providers.candidateOrder).toEqual(['groq']);
    expect(providers.providers.find((p) => p.id === 'cerebras')?.inCooldown).toBe(true);
  });

  it('un modelo fijado NO hace failover', async () => {
    const backup = trackingService('Backup', ['backup-model']);
    setServices([failingService('Pinned', ['pinned-model'], 500, 'down'), backup.service]);

    const res = await handleRequest(chatRequest({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'pinned-model',
    }));
    expect(res.status).toBe(502);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const json = (await res.json()) as { error: string; provider: string };
    expect(json.error).toBe('Proveedor Pinned falló');
    expect(backup.calls).toEqual([]);
  });
});

describe('GET /providers', () => {
  beforeEach(() => {
    resetScheduler();
  });

  afterEach(() => {
    setServices([]);
  });

  it('devuelve el snapshot sin filtrar material de claves', async () => {
    setServices([
      mockService('Groq', ['openai/gpt-oss-120b'], false, ['x'], { speedRank: 1 }),
      mockService('DeepSeek', ['deepseek-chat'], true, ['x'], { speedRank: 7 }),
    ]);

    const res = await handleRequest(new Request('http://localhost/providers'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const body = (await res.text());
    expect(body).not.toMatch(/api[_-]?key/i);
    expect(body).not.toMatch(/sk-|gsk_|csk_/);

    const json = JSON.parse(body) as {
      preferred: string | null;
      candidateOrder: string[];
      firstTokenTimeoutMs: number;
      providers: Array<Record<string, unknown>>;
    };
    expect(json.preferred).toBe('groq');
    expect(json.candidateOrder).toEqual(['groq']);
    expect(json.firstTokenTimeoutMs).toBe(8000);
    expect(json.providers).toHaveLength(2);
    expect(json.providers[0]).toMatchObject({
      id: 'groq',
      label: 'Groq',
      models: ['openai/gpt-oss-120b'],
      configured: true,
      inCooldown: false,
      consecutiveFailures: 0,
    });
  });
});

describe('registry', () => {
  it('solo registra proveedores con API key presente', () => {
    const services = buildProviders({ GROQ_API_KEY: 'k', MISTRAL_API_KEY: '  ' });
    expect(services.map((s) => s.id)).toEqual(['groq']);
  });

  it('no registra nada sin claves', () => {
    expect(buildProviders({})).toEqual([]);
  });

  it('permite sobrescribir la lista de modelos por env', () => {
    const groq = PROVIDER_DESCRIPTORS.find((d) => d.id === 'groq')!;
    expect(resolveModels(groq, { GROQ_MODELS: 'a , b,, c' })).toEqual(['a', 'b', 'c']);
    expect(resolveModels(groq, {})).toEqual(groq.models);
  });

  it('respeta el DEEPSEEK_MODEL heredado', () => {
    const deepseek = PROVIDER_DESCRIPTORS.find((d) => d.id === 'deepseek')!;
    expect(resolveModels(deepseek, { DEEPSEEK_MODEL: 'deepseek-reasoner' })).toEqual(['deepseek-reasoner']);
  });

  it('DeepSeek es el único proveedor que exige token', () => {
    expect(PROVIDER_DESCRIPTORS.filter((d) => d.requiresAuth).map((d) => d.id)).toEqual(['deepseek']);
  });
});

describe('registry wired end to end', () => {
  beforeEach(() => {
    resetScheduler();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setServices([]);
  });

  function sseResponse(contents: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const content of contents) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
          );
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  it('cae de un 404 de Groq a Gemini usando el cliente real', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (url.includes('api.groq.com')) {
        return new Response('model has been decommissioned', { status: 404 });
      }
      return sseResponse(['Hola', ' mundo']);
    });

    setServices(buildProviders({ GROQ_API_KEY: 'gsk_test', GOOGLE_API_KEY: 'goog_test' }));

    const res = await handleRequest(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(res.status).toBe(200);
    // The leading space of the second token must survive the framing verbatim.
    expect(await res.text()).toBe('data: Hola\n\ndata:  mundo\n\ndata: [DONE]\n\n');
    expect(calls).toEqual([
      'https://api.groq.com/openai/v1/chat/completions',
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    ]);

    const snapshotBody = (await (
      await handleRequest(new Request('http://localhost/providers'))
    ).json()) as { providers: Array<{ id: string; inCooldown: boolean; lastError: string | null }> };
    const groq = snapshotBody.providers.find((p) => p.id === 'groq')!;
    expect(groq.inCooldown).toBe(true);
    expect(groq.lastError).toContain('404');
    expect(JSON.stringify(snapshotBody)).not.toContain('gsk_test');
  });
});
