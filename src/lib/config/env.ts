import 'server-only';
import { z } from 'zod';

/**
 * Server-only environment configuration.
 *
 * Nothing in this module may be imported from a client component. No value
 * here is ever serialised into a client payload, and no key is exposed through
 * a NEXT_PUBLIC_ variable.
 */

const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

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

const schema = z.object({
  DATABASE_URL: str(''),
  SQLITE_PATH: str('./data/ai-trade.db'),
  DATA_MODE: z.enum(['real', 'offline']).default('real'),

  AUTH_PASSWORD: str(''),
  AUTH_SESSION_SECRET: str(''),
  AUTH_SESSION_HOURS: num(72),
  CRON_SECRET: str(''),

  CRYPTO_PROVIDER: z.enum(['binance', 'coinbase']).default('binance'),
  BINANCE_BASE_URL: str('https://api.binance.com'),
  COINBASE_BASE_URL: str('https://api.coinbase.com'),

  // twelvedata is in the default order so that simply setting
  // TWELVEDATA_API_KEY is enough to unlock IDX - a provider with no key is
  // skipped automatically, so listing it costs nothing when it is unconfigured.
  STOCK_PROVIDERS: list(['nasdaq', 'alphavantage', 'twelvedata']),
  ALPHAVANTAGE_API_KEY: str(''),
  TWELVEDATA_API_KEY: str(''),
  ENABLE_YAHOO_PROVIDER: bool(false),

  NEWS_FEEDS: list(['fed_monetary', 'sec_8k', 'coindesk']),
  SEC_USER_AGENT: str(''),
  NEWS_EXTRA_FEEDS: str(''),

  AI_PROVIDER: z.enum(['none', 'anthropic', 'openai', 'openrouter', 'ollama']).default('none'),
  AI_MODEL: str('claude-sonnet-5'),
  ANTHROPIC_API_KEY: str(''),
  OPENAI_API_KEY: str(''),
  OPENROUTER_API_KEY: str(''),
  OLLAMA_BASE_URL: str('http://localhost:11434'),
  AI_CACHE_MINUTES: num(180),
  AI_MAX_CALLS_PER_DAY: num(50),

  TELEGRAM_BOT_TOKEN: str(''),
  TELEGRAM_CHAT_ID: str(''),

  RISK_ACCOUNT_EQUITY: num(10_000),
  RISK_PERCENT_PER_TRADE: num(1),
  RISK_MAX_OPEN_RISK_PERCENT: num(5),
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
  cryptoProvider: string;
  stockProviders: string[];
  aiEnabled: boolean;
  aiProvider: string;
  aiModel: string;
  newsEnabled: boolean;
  newsFeeds: string[];
  telegramEnabled: boolean;
  authEnabled: boolean;
  secUserAgentConfigured: boolean;
};

export function features(): FeatureFlags {
  const e = env();
  const aiKey =
    e.AI_PROVIDER === 'anthropic'
      ? e.ANTHROPIC_API_KEY
      : e.AI_PROVIDER === 'openai'
        ? e.OPENAI_API_KEY
        : e.AI_PROVIDER === 'openrouter'
          ? e.OPENROUTER_API_KEY
          : e.AI_PROVIDER === 'ollama'
            ? 'local'
            : '';
  return {
    dataMode: e.DATA_MODE,
    cryptoProvider: e.CRYPTO_PROVIDER,
    stockProviders: e.STOCK_PROVIDERS,
    aiEnabled: e.AI_PROVIDER !== 'none' && aiKey !== '' && e.AI_MAX_CALLS_PER_DAY > 0,
    aiProvider: e.AI_PROVIDER,
    aiModel: e.AI_MODEL,
    newsEnabled: e.NEWS_FEEDS.length > 0,
    newsFeeds: e.NEWS_FEEDS,
    telegramEnabled: e.TELEGRAM_BOT_TOKEN !== '' && e.TELEGRAM_CHAT_ID !== '',
    authEnabled: e.AUTH_PASSWORD !== '',
    secUserAgentConfigured: e.SEC_USER_AGENT !== '',
  };
}

export function riskDefaults() {
  const e = env();
  return {
    accountEquity: e.RISK_ACCOUNT_EQUITY,
    riskPercentPerTrade: e.RISK_PERCENT_PER_TRADE,
    maxOpenRiskPercent: e.RISK_MAX_OPEN_RISK_PERCENT,
  };
}
