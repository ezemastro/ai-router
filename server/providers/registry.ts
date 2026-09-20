import type { AIService, ChatMessage, MaxTokensField } from '../types';
import { createChatStream } from './openai-compatible';
import { getDiscoveredFreeModels, scheduleOpenRouterRefresh } from './openrouter-discovery';

/**
 * Declarative description of one upstream provider.
 *
 * Model IDs live here, not inside a client module, and every list is
 * overridable with `<PREFIX>_MODELS` (comma-separated) so a provider
 * deprecation is a config change rather than a code change.
 *
 * Free-tier facts verified 2026-09-20 — see README for the limits table.
 */
export interface ProviderDescriptor {
  id: string;
  label: string;
  baseUrl: string;
  apiKeyEnv: string;
  /** Env var that replaces `models` wholesale, comma-separated. */
  modelsEnv: string;
  /** Built-in default list, preferred/fastest first. */
  models: string[];
  /** true = requires a bearer token on OUR API. Only DeepSeek is paid. */
  requiresAuth: boolean;
  maxTokensField: MaxTokensField;
  /** Seed priority before any latency measurement exists. Lower = faster. */
  speedRank: number;
  extraHeaders?: Record<string, string>;
}

export const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    modelsEnv: 'GROQ_MODELS',
    // llama-3.3-70b-versatile and llama-3.1-8b-instant were shut down 2026-08-16.
    models: [
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-safeguard-20b',
      'qwen/qwen3.8-27b',
    ],
    requiresAuth: false,
    maxTokensField: 'max_completion_tokens',
    speedRank: 1,
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    modelsEnv: 'CEREBRAS_MODELS',
    // No longer free: $5 / 30-day trial, card required. Participates only when
    // a key is configured, and 402 puts it in a long cooldown.
    models: ['gpt-oss-120b', 'qwen-3.8-27b'],
    requiresAuth: false,
    maxTokensField: 'max_completion_tokens',
    speedRank: 2,
  },
  {
    id: 'google',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GOOGLE_API_KEY',
    modelsEnv: 'GOOGLE_MODELS',
    // Free tier covers Flash and Flash-Lite only; Pro left it on 2026-04-01.
    models: ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
    requiresAuth: false,
    maxTokensField: 'max_tokens',
    speedRank: 3,
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    modelsEnv: 'MISTRAL_MODELS',
    models: ['mistral-small-latest'],
    requiresAuth: false,
    maxTokensField: 'max_tokens',
    speedRank: 4,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    modelsEnv: 'NVIDIA_MODELS',
    models: ['openai/gpt-oss-120b'],
    requiresAuth: false,
    maxTokensField: 'max_completion_tokens',
    speedRank: 5,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    modelsEnv: 'OPENROUTER_MODELS',
    // Fallback only: the live list comes from `:free` discovery at runtime.
    models: ['z-ai/glm-4.5-air:free'],
    requiresAuth: false,
    maxTokensField: 'max_tokens',
    speedRank: 6,
    extraHeaders: {
      'HTTP-Referer': 'https://ai-router.mastropietro.work.gd',
      'X-Title': 'AI Router',
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    modelsEnv: 'DEEPSEEK_MODELS',
    models: ['deepseek-chat'],
    requiresAuth: true,
    maxTokensField: 'max_tokens',
    speedRank: 7,
  },
];

type Env = Record<string, string | undefined>;

function parseModelList(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const models = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return models.length > 0 ? models : null;
}

/** Built-in list, overridden by `<PREFIX>_MODELS`, plus the legacy `DEEPSEEK_MODEL`. */
export function resolveModels(descriptor: ProviderDescriptor, env: Env): string[] {
  const override = parseModelList(env[descriptor.modelsEnv]);
  if (override) return override;
  if (descriptor.id === 'deepseek') {
    const legacy = env.DEEPSEEK_MODEL?.trim();
    if (legacy) return [legacy];
  }
  return descriptor.models;
}

export function isConfigured(descriptor: ProviderDescriptor, env: Env): boolean {
  return Boolean(env[descriptor.apiKeyEnv]?.trim());
}

function buildService(descriptor: ProviderDescriptor, env: Env): AIService {
  const apiKey = env[descriptor.apiKeyEnv]?.trim() ?? '';
  const configuredModels = resolveModels(descriptor, env);
  const isOpenRouter = descriptor.id === 'openrouter';

  const currentModels = (): string[] => {
    if (!isOpenRouter) return configuredModels;
    // Reading the list is the lazy refresh trigger; it never blocks, and an
    // absent/failed discovery simply keeps the configured fallback.
    scheduleOpenRouterRefresh(apiKey);
    return getDiscoveredFreeModels() ?? configuredModels;
  };

  return {
    id: descriptor.id,
    name: descriptor.label,
    requiresAuth: descriptor.requiresAuth,
    speedRank: descriptor.speedRank,
    get models(): string[] {
      return currentModels();
    },
    async chat(messages: ChatMessage[], model?: string, signal?: AbortSignal) {
      const models = currentModels();
      const requested = model?.toLowerCase();
      const resolved =
        (requested && models.find((m) => m.toLowerCase() === requested)) ?? models[0];
      if (!resolved) {
        throw new Error(`${descriptor.label} has no configured models`);
      }
      return createChatStream(
        {
          providerId: descriptor.id,
          baseUrl: descriptor.baseUrl,
          apiKey,
          maxTokensField: descriptor.maxTokensField,
          extraHeaders: descriptor.extraHeaders,
        },
        { model: resolved, messages, signal },
      );
    },
  };
}

/**
 * A provider exists only when its API key is present. A keyless provider is not
 * a failure slot in the rotation — it simply is not in the rotation.
 */
export function buildProviders(env: Env = process.env): AIService[] {
  const services: AIService[] = [];
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    if (!isConfigured(descriptor, env)) continue;
    services.push(buildService(descriptor, env));
    if (descriptor.id === 'openrouter') {
      // Warm the free-model list at startup so the first request already has it.
      scheduleOpenRouterRefresh(env[descriptor.apiKeyEnv]?.trim() ?? '');
    }
  }
  return services;
}
