import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createChatStream,
  parseRetryAfter,
  parseSSE,
  ProviderHttpError,
} from '../providers/openai-compatible';

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

function delta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/** Narrows a rejected createChatStream call to the typed provider error. */
async function expectProviderHttpError(promise: Promise<unknown>): Promise<ProviderHttpError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ProviderHttpError) return err;
    throw err;
  }
  throw new Error('expected the request to reject with a ProviderHttpError');
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

describe('parseSSE', () => {
  it('yields content deltas and stops at [DONE]', async () => {
    const stream = sseBody([delta('Hola'), delta(' mundo'), 'data: [DONE]\n\n', delta('ignored')]);
    expect(await collect(parseSSE(stream))).toEqual(['Hola', ' mundo']);
  });

  it('skips empty deltas, keepalives and malformed frames', async () => {
    const stream = sseBody([
      ': keepalive\n\n',
      delta(''),
      'data: {not json}\n\n',
      `data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`,
      delta('ok'),
      'data: [DONE]\n\n',
    ]);
    expect(await collect(parseSSE(stream))).toEqual(['ok']);
  });

  it('reassembles frames split across chunk boundaries', async () => {
    const full = delta('partido');
    const stream = sseBody([full.slice(0, 10), full.slice(10), 'data: [DONE]\n\n']);
    expect(await collect(parseSSE(stream))).toEqual(['partido']);
  });

  it('handles CRLF line endings and a stream that ends without [DONE]', async () => {
    const payload = JSON.stringify({ choices: [{ delta: { content: 'x' } }] });
    const stream = sseBody([`data: ${payload}\r\n\r\n`]);
    expect(await collect(parseSSE(stream))).toEqual(['x']);
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
  });

  it('reads an HTTP date', () => {
    const now = Date.parse('2026-09-20T12:00:00Z');
    expect(parseRetryAfter('Sun, 20 Sep 2026 12:00:45 GMT', now)).toBe(45_000);
  });

  it('returns undefined for absent or unparseable values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('createChatStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: Response) {
    const spy = vi.fn(async () => response);
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('sends the per-provider max-tokens field and extra headers', async () => {
    const spy = stubFetch(
      new Response(sseBody([delta('hi'), 'data: [DONE]\n\n']), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const stream = await createChatStream(
      {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1/',
        apiKey: 'secret',
        maxTokensField: 'max_tokens',
        extraHeaders: { 'HTTP-Referer': 'https://example.test', 'X-Title': 'AI Router' },
      },
      { model: 'some/model:free', messages: [{ role: 'user', content: 'hi' }] },
    );
    expect(await collect(stream)).toEqual(['hi']);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
    expect(headers['HTTP-Referer']).toBe('https://example.test');
    expect(headers['X-Title']).toBe('AI Router');
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload.max_tokens).toBe(2048);
    expect(payload.max_completion_tokens).toBeUndefined();
    expect(payload.stream).toBe(true);
    expect(payload.model).toBe('some/model:free');
  });

  it('uses max_completion_tokens when the provider is flagged that way', async () => {
    const spy = stubFetch(new Response(sseBody(['data: [DONE]\n\n']), { status: 200 }));
    await createChatStream(
      {
        providerId: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: 'k',
        maxTokensField: 'max_completion_tokens',
      },
      { model: 'openai/gpt-oss-120b', messages: [] },
    );
    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1];
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload.max_completion_tokens).toBe(2048);
    expect(payload.max_tokens).toBeUndefined();
  });

  it('throws a typed error carrying status, provider, snippet and Retry-After', async () => {
    stubFetch(
      new Response('rate limited: slow down', {
        status: 429,
        headers: { 'Retry-After': '12' },
      }),
    );

    const attempt = createChatStream(
      {
        providerId: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: 'k',
        maxTokensField: 'max_completion_tokens',
      },
      { model: 'openai/gpt-oss-120b', messages: [] },
    );

    await expect(attempt).rejects.toBeInstanceOf(ProviderHttpError);
    const err = await expectProviderHttpError(attempt);
    expect(err.status).toBe(429);
    expect(err.providerId).toBe('groq');
    expect(err.bodySnippet).toBe('rate limited: slow down');
    expect(err.retryAfterMs).toBe(12_000);
  });

  it('truncates the error body snippet to 300 characters', async () => {
    stubFetch(new Response('x'.repeat(5000), { status: 500 }));
    const err = await expectProviderHttpError(
      createChatStream(
        {
          providerId: 'nvidia',
          baseUrl: 'https://integrate.api.nvidia.com/v1',
          apiKey: 'k',
          maxTokensField: 'max_completion_tokens',
        },
        { model: 'openai/gpt-oss-120b', messages: [] },
      ),
    );
    expect(err.bodySnippet).toHaveLength(301); // 300 chars + the ellipsis marker
    expect(err.bodySnippet.startsWith('x'.repeat(300))).toBe(true);
    expect(err.message).not.toContain('k');
  });
});
