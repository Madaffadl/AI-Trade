import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildUserPrompt, roundForPrompt } from '@/lib/analysis/prompt';
import { parseModelJson } from '@/lib/analysis/schema';
import { aiProviderMissing, env, features, resetEnvCache } from '@/lib/config/env';
import { aiCooldownMs, aiProviderById, aiProviderChain, providersToTry, type AiAnalysisProvider } from '@/lib/providers/ai';
import { ProviderError } from '@/lib/providers/http';

/**
 * AI provider configuration and request shapes, with no network access.
 * Whether a real key works is answered only by `npm run providers:verify`.
 */

const KEYS = [
  'AI_PROVIDER',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GROQ_API_KEY',
  'GROQ_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
] as const;

let saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
  resetEnvCache();
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
  vi.unstubAllGlobals();
});

describe('AI_PROVIDER fallback chain', () => {
  it('parses an ordered, de-duplicated, case-insensitive list', () => {
    setEnv({ AI_PROVIDER: ' Gemini, groq ,gemini,ollama' });
    expect(env().AI_PROVIDER).toEqual(['gemini', 'groq', 'ollama']);
    expect(aiProviderChain().map((p) => p.key)).toEqual([
      'gemini/gemini-3.8-flash',
      'gemini/gemini-3.5-flash',
      'groq/qwen/qwen3.8-27b',
      'ollama/qwen3.8:27b',
    ]);
  });

  it('tries each listed model of a provider in order', () => {
    setEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key-not-real', GEMINI_MODEL: 'gemini-3.5-flash, gemini-3.5-flash-lite' });
    expect(aiProviderChain().map((p) => p.model)).toEqual(['gemini-3.5-flash', 'gemini-3.5-flash-lite']);
    expect(features().aiModel).toBe('gemini-3.5-flash → gemini-3.5-flash-lite');
  });

  it('treats "none" and an empty value as AI disabled', () => {
    setEnv({ AI_PROVIDER: 'none' });
    expect(env().AI_PROVIDER).toEqual([]);
    expect(features().aiEnabled).toBe(false);
    setEnv({});
    expect(env().AI_PROVIDER).toEqual([]);
  });

  it('rejects an unknown provider instead of silently ignoring it', () => {
    setEnv({ AI_PROVIDER: 'gemini,chatgpt' });
    expect(() => env()).toThrow(/AI_PROVIDER/);
  });

  it('enables AI only for providers that have a key, and lists them in order', () => {
    setEnv({ AI_PROVIDER: 'gemini,groq', GROQ_API_KEY: 'test-key-not-real' });
    expect(aiProviderMissing('gemini')).toMatch(/GEMINI_API_KEY/);
    expect(aiProviderMissing('groq')).toBeNull();
    const f = features();
    expect(f.aiEnabled).toBe(true);
    expect(f.aiProvider).toBe('groq');
    expect(f.aiModel).toBe('qwen/qwen3.8-27b');
  });

  it('reports a missing model for providers with no safe default', () => {
    setEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key-not-real' });
    expect(aiProviderMissing('openai')).toMatch(/OPENAI_MODEL/);
    expect(features().aiEnabled).toBe(false);
  });
});

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function sentBody(fn: ReturnType<typeof stubFetch>): Record<string, unknown> {
  return JSON.parse(String(fn.mock.calls[0]![1]!.body)) as Record<string, unknown>;
}

const reply = { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] };
const req = { systemPrompt: 'sys', userPrompt: 'user', maxTokens: 8_192 };

describe('OpenAI-compatible adapters', () => {
  it('sends Gemini requests to its OpenAI endpoint with room for thinking', async () => {
    setEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key-not-real' });
    const fetch = stubFetch(200, reply);
    const res = await aiProviderById('gemini').complete(req);

    expect(fetch.mock.calls[0]![0]).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    const body = sentBody(fetch);
    expect(body.model).toBe('gemini-3.8-flash');
    expect(body.max_tokens).toBe(8_192);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(res).toEqual({ text: '{"ok":true}', model: 'gemini-3.8-flash', provider: 'gemini' });
  });

  it('caps Groq output under its free-tier output-token rate and enforces the schema', async () => {
    setEnv({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'test-key-not-real' });
    const fetch = stubFetch(200, reply);
    await aiProviderById('groq').complete(req);

    const body = sentBody(fetch);
    expect(body.max_completion_tokens).toBe(1_000);
    const format = body.response_format as { type: string; json_schema: { strict: boolean; schema: object } };
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema).toHaveProperty('required');
  });

  it('surfaces a quota error as rate_limited, so the chain moves on', async () => {
    setEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key-not-real' });
    stubFetch(429, { error: { message: 'quota exceeded' } });
    await expect(aiProviderById('gemini').complete(req)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('treats an empty answer as a failure and names the finish reason', async () => {
    setEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key-not-real' });
    stubFetch(200, { choices: [{ message: { content: null }, finish_reason: 'length' }] });
    const err = await aiProviderById('gemini').complete(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('bad_payload');
    expect((err as ProviderError).message).toMatch(/length/);
  });

  it('refuses to call a provider without a key, without touching the network', async () => {
    setEnv({ AI_PROVIDER: 'groq' });
    const fetch = stubFetch(200, reply);
    await expect(aiProviderById('groq').complete(req)).rejects.toMatchObject({ kind: 'not_configured' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('fallback order under cooldown', () => {
  const p = (key: string) => ({ key }) as AiAnalysisProvider;
  const chain = [p('gemini/gemini-3.8-flash'), p('gemini/gemini-3.5-flash'), p('groq/qwen/qwen3.8-27b')];
  const keys = (r: { attempt: AiAnalysisProvider[] }) => r.attempt.map((x) => x.key);
  const now = 1_000_000;

  it('skips only the overloaded model, keeping the order of the rest', () => {
    const r = providersToTry(chain, new Map([['gemini/gemini-3.8-flash', now + 60_000]]), now);
    expect(keys(r)).toEqual(['gemini/gemini-3.5-flash', 'groq/qwen/qwen3.8-27b']);
    expect(r.skipped).toEqual([{ key: 'gemini/gemini-3.8-flash', untilMs: now + 60_000 }]);
  });

  it('tries a model again once its cooldown has passed', () => {
    const r = providersToTry(chain, new Map([['gemini/gemini-3.8-flash', now - 1]]), now);
    expect(keys(r)).toEqual(['gemini/gemini-3.8-flash', 'gemini/gemini-3.5-flash', 'groq/qwen/qwen3.8-27b']);
  });

  it('tries everything rather than nothing when every model is cooling down', () => {
    const all = new Map(chain.map((x) => [x.key, now + 60_000] as const));
    expect(keys(providersToTry(chain, all, now))).toEqual(chain.map((x) => x.key));
  });

  it('cools down briefly for per-minute limits, longer for overload and timeouts', () => {
    expect(aiCooldownMs(new ProviderError('otpm', 'rate_limited', 429))).toBe(90_000);
    expect(aiCooldownMs(new ProviderError('busy', 'rate_limited', 503))).toBe(5 * 60_000);
    expect(aiCooldownMs(new ProviderError('slow', 'timeout'))).toBe(10 * 60_000);
    expect(aiCooldownMs(new ProviderError('wait', 'rate_limited', 429, 15 * 60_000))).toBe(15 * 60_000);
    expect(aiCooldownMs(new ProviderError('bad key', 'http_error', 401))).toBeUndefined();
  });

  it('treats an overloaded model (503) as transient and keeps Retry-After', async () => {
    setEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key-not-real' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"message":"high demand"}}', { status: 503, headers: { 'retry-after': '30' } })),
    );
    await expect(aiProviderById('gemini').complete(req)).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 30_000,
    });
  });
});

describe('prompt construction', () => {
  const ctx = {
    language: 'id' as const,
    symbol: 'BTCIDR',
    displayName: 'Bitcoin / Rupiah',
    exchangeId: 'INDODAX',
    currency: 'IDR',
    timeframe: '1d' as const,
    tradingStyle: 'swing',
    regime: 'uptrend' as const,
    regimeExplanation: 'EMA20 above EMA50',
    analysisTimeMs: Date.UTC(2026, 9, 28),
    latestCandleMs: Date.UTC(2026, 9, 27),
    dataFetchedMs: Date.UTC(2026, 9, 28),
    dataQuality: 'ok',
    providerNotes: [],
    indicators: { rsi14: 48.28188132738288, ema20: 1473000991.2804286, bbPercentB: 0.3594445592694231, support: null },
    strategyOutputs: [],
    articles: [],
  };

  it('rounds indicator values so unreadable floats never reach the commentary', () => {
    const { prompt } = buildUserPrompt(ctx);
    expect(prompt).toContain('rsi14: 48.28');
    expect(prompt).toContain('ema20: 1473000991');
    expect(prompt).toContain('bbPercentB: 0.3594');
    expect(prompt).not.toMatch(/48\.2818|1473000991\.28/);
  });

  it('asks for the interface language and states the dates are real', () => {
    expect(buildUserPrompt(ctx).prompt).toContain('Write every string value in Bahasa Indonesia');
    expect(buildUserPrompt({ ...ctx, language: 'en' }).prompt).toContain('Write every string value in English');
    expect(buildUserPrompt(ctx).prompt).toMatch(/real present, not hypothetical/);
    expect(buildUserPrompt(ctx).prompt).toMatch(/at most 3 items/);
  });

  it('hands the model the plan it must explain, and asks for simulation-only on an experimental strategy', () => {
    const plan = {
      state: 'WAIT_FOR_ENTRY',
      strategy: 'trend_momentum@1.0.0',
      timeframe: '4h',
      contextTimeframe: '1d',
      contextUp: true,
      trigger: { price: 0.09033, requiresVolume: false },
      entryPlanned: 0.09033,
      entryMax: 0.0908844,
      stopLoss: 0.0831926,
      stopDistancePercent: 7.9,
      takeProfit1: 0.104605,
      tp1DistancePercent: 15.8,
      takeProfit2: 0.118879,
      netRiskReward: 1.6712,
      roundTripCostPercent: 0.96,
      amountIdr: 45400.4,
      lossAtStopIdr: 4000,
      netProfitTp1Idr: 6699.2,
      holdHours: 120,
      validation: 'experimental' as const,
      outOfSample: { trades: 79, expectancyPct: 0.2598, profitFactor: 1.0556 },
    };
    const withPlan = buildUserPrompt({ ...ctx, plan }).prompt;
    expect(withPlan).toContain('TRADE PLAN');
    expect(withPlan).toContain('a 4h candle CLOSES above 0.09033');
    expect(withPlan).toContain('maximum entry: 0.09088');
    expect(withPlan).toContain('net reward:risk after Indodax costs: 1.671');
    expect(withPlan).toContain('EXPERIMENTAL');
    expect(withPlan).toContain('79 trades, net expectancy 0.2598% per trade, profit factor 1.056');
    expect(withPlan).toMatch(/should only be simulated/);
    expect(buildUserPrompt({ ...ctx, plan: { ...plan, validation: 'validated' } }).prompt).not.toMatch(/should only be simulated/);
    expect(buildUserPrompt(ctx).prompt).not.toContain('TRADE PLAN');
  });

  it('keeps significant digits for micro-priced assets', () => {
    expect(roundForPrompt(0.000012346)).toBe('0.00001235');
    expect(roundForPrompt(0.1234567)).toBe('0.1235');
    expect(roundForPrompt(12.3456)).toBe('12.35');
    expect(roundForPrompt(-4421024.9)).toBe('-4421025');
    expect(roundForPrompt(0)).toBe('0');
  });
});

describe('parseModelJson', () => {
  it('parses a bare object', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('strips reasoning blocks, fences and preamble', () => {
    expect(parseModelJson('<think>weighing it up {not json}</think>\n{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseModelJson('Here is the analysis:\n{"a":{"b":2}}\nHope it helps.')).toEqual({
      ok: true,
      value: { a: { b: 2 } },
    });
  });

  it('still fails on a truncated object rather than guessing', () => {
    expect(parseModelJson('{"technicalSummary": "cut off mid').ok).toBe(false);
    expect(parseModelJson('no json here').ok).toBe(false);
  });
});
