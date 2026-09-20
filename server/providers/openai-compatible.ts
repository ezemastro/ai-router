import type { ChatMessage, MaxTokensField } from '../types';

/** Longest provider body fragment we are ever willing to surface or log. */
export const BODY_SNIPPET_LIMIT = 300;

/**
 * A non-2xx answer from an upstream provider. Carries just enough to let the
 * scheduler pick a cooldown, and never more of the body than the snippet limit.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly providerId: string;
  readonly bodySnippet: string;
  readonly retryAfterMs?: number;

  constructor(init: {
    status: number;
    providerId: string;
    bodySnippet: string;
    retryAfterMs?: number;
  }) {
    super(`${init.providerId} returned ${init.status}: ${init.bodySnippet}`);
    this.name = 'ProviderHttpError';
    this.status = init.status;
    this.providerId = init.providerId;
    this.bodySnippet = init.bodySnippet;
    this.retryAfterMs = init.retryAfterMs;
  }
}

export interface OpenAICompatibleConfig {
  providerId: string;
  /** Base URL up to (but excluding) `/chat/completions`. */
  baseUrl: string;
  apiKey: string;
  maxTokensField: MaxTokensField;
  /** Extra request headers, e.g. OpenRouter's `HTTP-Referer` / `X-Title`. */
  extraHeaders?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

function truncate(text: string, limit = BODY_SNIPPET_LIMIT): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/**
 * `Retry-After` is either delta-seconds or an HTTP date. Anything else is
 * treated as absent rather than guessed at.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - now);
  return undefined;
}

/** Pulls `choices[0].delta.content` out of one SSE `data:` payload. */
function contentOf(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string | null } }>;
    };
    const content = parsed.choices?.[0]?.delta?.content;
    return typeof content === 'string' && content.length > 0 ? content : undefined;
  } catch {
    // A malformed frame is not worth killing a live stream over.
    return undefined;
  }
}

/**
 * Minimal SSE reader: yields only non-empty content deltas and stops at
 * `data: [DONE]`. We parse this ourselves so no vendor SDK is needed.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        if (!payload) continue;
        const content = contentOf(payload);
        if (content !== undefined) yield content;
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        const content = contentOf(payload);
        if (content !== undefined) yield content;
      }
    }
  } finally {
    await reader.cancel().catch(() => {
      // The consumer walked away; nothing left to clean up.
    });
  }
}

/**
 * Issues one streaming chat completion. Resolves once the provider accepted
 * the request (so HTTP-level failures are catchable before any byte is sent to
 * our own client) and returns the token stream.
 */
export async function createChatStream(
  config: OpenAICompatibleConfig,
  request: ChatRequest,
): Promise<AsyncIterable<string>> {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const payload: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
    temperature: config.temperature ?? 0.6,
  };
  payload[config.maxTokensField] = config.maxTokens ?? 2048;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      ...config.extraHeaders,
    },
    body: JSON.stringify(payload),
    signal: request.signal,
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    throw new ProviderHttpError({
      status: response.status,
      providerId: config.providerId,
      bodySnippet: truncate(raw),
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    });
  }

  if (!response.body) {
    throw new ProviderHttpError({
      status: response.status,
      providerId: config.providerId,
      bodySnippet: 'empty response body',
    });
  }

  return parseSSE(response.body);
}
