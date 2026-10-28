import 'server-only';
import { z } from 'zod';

/**
 * Server-only environment configuration.
 *
 * Nothing in this module may be imported from a client component. No value
 * here is ever serialised into a client payload, and no key is exposed through
 * a NEXT_PUBLIC_ variable.
 */

const num = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : Number(v)))
    .pipe(z.number().finite());

const str = (d = '') =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? d : v.trim()));

const list = (d: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? d
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

export const AI_PROVIDER_IDS = ['anthropic', 'openai', 'openrouter', 'gemini', 'groq', 'ollama'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/**
 * AI_PROVIDER is an ordered fallback chain, e.g. "gemini,groq,ollama": the
 * first provider is tried first and each later one only when every earlier one
 * failed. "none" (or empty) disables AI. Free tiers change without notice, so
 * a chain keeps commentary working when one quota runs out.
 */
const aiProviderChain = z
  .string()
  .optional()
  .transform((v) => [
    ...new Set(
      (v ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s !== '' && s !== 'none'),
    ),
  ])
  .pipe(z.array(z.enum(AI_PROVIDER_IDS)));

const schema = z.object({
  DATABASE_URL: str(''),
  SQLITE_PATH: str('./data/ai-trade.db'),
  DATA_MODE: z.enum(['real', 'offline']).default('real'),

  AUTH_PASSWORD: str(''),
  AUTH_SESSION_SECRET: str(''),
  AUTH_SESSION_HOURS: num(72),
  CRON_SECRET: str(''),



  NEWS_FEEDS: list(['fed_monetary', 'coindesk']),
  NEWS_EXTRA_FEEDS: str(''),

  AI_PROVIDER: aiProviderChain,
  // Each provider names its own model(s), because a chain mixes vendors and one
  // shared model id cannot be valid for all of them. A comma list is tried in
  // order: free tiers overload and run out per MODEL, so a second model from
  // the same vendor is often still answering when the first is not.
  // OpenAI and OpenRouter have no default: their catalogues change too often
  // to hard-code a safe choice.
  ANTHROPIC_API_KEY: str(''),
  ANTHROPIC_MODEL: list(['claude-opus-5-5']),
  OPENAI_API_KEY: str(''),
  OPENAI_MODEL: list([]),
  OPENROUTER_API_KEY: str(''),
  OPENROUTER_MODEL: list([]),
  GEMINI_API_KEY: str(''),
  GEMINI_MODEL: list(['gemini-3.8-flash', 'gemini-3.5-flash']),
  GROQ_API_KEY: str(''),
  GROQ_MODEL: list(['qwen/qwen3.8-27b']),
  OLLAMA_BASE_URL: str('http://localhost:11434'),
  OLLAMA_MODEL: list(['qwen3.8:27b']),
  AI_CACHE_MINUTES: num(180),
  AI_MAX_CALLS_PER_DAY: num(50),

  TELEGRAM_BOT_TOKEN: str(''),
  TELEGRAM_CHAT_ID: str(''),

});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Reset the memoised env. Test-only. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * Feature availability derived from configuration. Safe to send to the client:
 * it contains booleans and provider names only, never secrets.
 */
export type FeatureFlags = {
  dataMode: 'real' | 'offline';
  aiEnabled: boolean;
  aiProvider: string;
  aiModel: string;
  newsEnabled: boolean;
  newsFeeds: string[];
  telegramEnabled: boolean;
  authEnabled: boolean;
};

/** The model ids configured for a provider, in the order they are tried. */
export function aiModelsFor(id: AiProviderId, e: Env = env()): string[] {
  switch (id) {
    case 'anthropic':
      return e.ANTHROPIC_MODEL;
    case 'openai':
      return e.OPENAI_MODEL;
    case 'openrouter':
      return e.OPENROUTER_MODEL;
    case 'gemini':
      return e.GEMINI_MODEL;
    case 'groq':
      return e.GROQ_MODEL;
    case 'ollama':
      return e.OLLAMA_MODEL;
  }
}

/**
 * What a provider is still missing before it can be called, or null when it
 * is ready. Ollama needs no key, only a reachable local server.
 */
export function aiProviderMissing(id: AiProviderId, e: Env = env()): string | null {
  const key: Record<Exclude<AiProviderId, 'ollama'>, [string, string]> = {
    anthropic: ['ANTHROPIC_API_KEY', e.ANTHROPIC_API_KEY],
    openai: ['OPENAI_API_KEY', e.OPENAI_API_KEY],
    openrouter: ['OPENROUTER_API_KEY', e.OPENROUTER_API_KEY],
    gemini: ['GEMINI_API_KEY', e.GEMINI_API_KEY],
    groq: ['GROQ_API_KEY', e.GROQ_API_KEY],
  };
  if (id === 'ollama') {
    if (e.OLLAMA_BASE_URL === '') return 'OLLAMA_BASE_URL is not set';
  } else if (key[id][1] === '') {
    return `${key[id][0]} is not set`;
  }
  if (aiModelsFor(id, e).length === 0) return `${id.toUpperCase()}_MODEL is not set`;
  return null;
}

export function features(): FeatureFlags {
  const e = env();
  const ready = e.AI_PROVIDER.filter((id) => aiProviderMissing(id, e) === null);
  return {
    dataMode: e.DATA_MODE,
    aiEnabled: ready.length > 0 && e.AI_MAX_CALLS_PER_DAY > 0,
    aiProvider: ready.join(' → '),
    aiModel: ready.flatMap((id) => aiModelsFor(id, e)).join(' → '),
    newsEnabled: e.NEWS_FEEDS.length > 0,
    newsFeeds: e.NEWS_FEEDS,
    telegramEnabled: e.TELEGRAM_BOT_TOKEN !== '' && e.TELEGRAM_CHAT_ID !== '',
    authEnabled: e.AUTH_PASSWORD !== '',
  };
}
