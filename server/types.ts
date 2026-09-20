export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** Which JSON field the provider expects for the output-length cap. */
export type MaxTokensField = 'max_tokens' | 'max_completion_tokens';

/**
 * A registered provider. Everything the dispatcher and the scheduler need to
 * route, order and report on a provider lives here, so tests can inject fakes
 * without touching the network.
 */
export interface AIService {
  /** Stable key used by the scheduler. Falls back to `name` when omitted. */
  id?: string;
  /** Human-facing label; also what the Spanish error strings interpolate. */
  name: string;
  /** Model IDs this provider serves, preferred/fastest first. */
  models: string[];
  /** true = needs a bearer token on OUR API (paid models). */
  requiresAuth?: boolean;
  /** Seed priority used before any latency measurement exists. Lower = faster. */
  speedRank?: number;
  /**
   * Performs the request and resolves once the provider accepted it.
   * Transport/HTTP errors reject here; streaming errors surface while iterating.
   */
  chat: (
    messages: ChatMessage[],
    model?: string,
    signal?: AbortSignal,
  ) => Promise<AsyncIterable<string>>;
}

export function serviceId(service: AIService): string {
  return service.id ?? service.name;
}
