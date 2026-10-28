import 'server-only';
import { AI_JSON_SCHEMA } from '@/lib/analysis/schema';
import { aiModelsFor, aiProviderMissing, env, type AiProviderId } from '@/lib/config/env';
import { postJson, ProviderError } from '@/lib/providers/http';
import type { AiAnalysisProvider, AiRequest, AiResponse } from './types';

/**
 * Configurable LLM adapters.
 *
 * All speak JSON-only; the caller validates the result against a Zod schema
 * and discards anything that does not conform. No adapter is a hard
 * dependency: with AI_PROVIDER=none the platform runs fully on deterministic
 * analysis. AI_PROVIDER may list several providers, tried in order - see
 * `aiProviderChain`.
 *
 * NOTE ON VERIFICATION: an adapter is only "working" once
 * `npm run providers:verify` has made a real call through it with your key.
 */

/** Shared identity: one instance per (provider, model) in the chain. */
abstract class BaseProvider {
  abstract readonly id: AiProviderId;

  constructor(readonly model: string) {}

  /** Cooldowns and health are tracked per model, e.g. "gemini/gemini-3.8-flash". */
  get key(): string {
    return `${this.id}/${this.model}`;
  }

  isConfigured(): boolean {
    return aiProviderMissing(this.id) === null && this.model !== '';
  }

  protected assertConfigured(): void {
    const missing = aiProviderMissing(this.id) ?? (this.model === '' ? `${this.id.toUpperCase()}_MODEL is not set` : null);
    if (missing) throw new ProviderError(`${missing}.`, 'not_configured');
  }
}

class AnthropicProvider extends BaseProvider implements AiAnalysisProvider {
  readonly id = 'anthropic';
  readonly label = 'Anthropic Claude';

  async complete(req: AiRequest): Promise<AiResponse> {
    this.assertConfigured();
    const e = env();
    const model = this.model;
    const body = {
      model,
      max_tokens: req.maxTokens,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userPrompt }],
    };
    const res = await postJson<{ content: { type: string; text?: string }[] }>(
      'https://api.anthropic.com/v1/messages',
      body,
      {
        headers: {
          'x-api-key': e.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        timeoutMs: 120_000,
      },
    );
    const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
    if (!text) throw new ProviderError('Anthropic returned no text content.', 'bad_payload');
    return { text, model, provider: this.id };
  }
}

interface CompatibleConfig {
  id: Exclude<AiProviderId, 'anthropic' | 'ollama'>;
  label: string;
  url: string;
  apiKey: () => string;
  /** OpenAI and Groq renamed `max_tokens`; Gemini and OpenRouter still use it. */
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  /** Provider-side ceiling on output tokens, applied on top of the caller's budget. */
  maxTokensCap?: number;
  timeoutMs?: number;
  /** Request fields specific to this provider; overrides the defaults below. */
  extraBody?: Record<string, unknown>;
}

/**
 * Any endpoint that speaks the OpenAI chat-completions shape. Gemini and Groq
 * both publish one, so four vendors share this adapter.
 */
class OpenAiCompatibleProvider extends BaseProvider implements AiAnalysisProvider {
  readonly id: CompatibleConfig['id'];
  readonly label: string;

  constructor(
    private readonly cfg: CompatibleConfig,
    model: string,
  ) {
    super(model);
    this.id = cfg.id;
    this.label = cfg.label;
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    this.assertConfigured();
    const model = this.model;
    const res = await postJson<{
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
    }>(
      this.cfg.url,
      {
        model,
        [this.cfg.tokenParam]: Math.min(req.maxTokens, this.cfg.maxTokensCap ?? Infinity),
        response_format: { type: 'json_object' },
        ...this.cfg.extraBody,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
      },
      { headers: { Authorization: `Bearer ${this.cfg.apiKey()}` }, timeoutMs: this.cfg.timeoutMs },
    );
    const choice = res.choices?.[0];
    const text = choice?.message?.content ?? '';
    if (!text) {
      const why = choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : '';
      throw new ProviderError(`${this.label} returned no content${why}.`, 'bad_payload');
    }
    return { text, model, provider: this.id };
  }
}

/** Local models via Ollama - zero marginal cost, no data leaves the machine. */
class OllamaProvider extends BaseProvider implements AiAnalysisProvider {
  readonly id = 'ollama';
  readonly label = 'Ollama (local)';

  async complete(req: AiRequest): Promise<AiResponse> {
    this.assertConfigured();
    const e = env();
    const model = this.model;
    const res = await postJson<{ message?: { content: string } }>(
      `${e.OLLAMA_BASE_URL.replace(/\/$/, '')}/api/chat`,
      {
        model,
        stream: false,
        format: 'json',
        options: { num_predict: req.maxTokens },
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
      },
      // Ollama is local by design; this header opts the URL past the
      // private-host guard, which still blocks every other local target. A
      // ~27B model on a laptop needs minutes, not seconds, for a full answer.
      { headers: { 'x-allow-local': '1' }, timeoutMs: 300_000 },
    );
    const text = res.message?.content ?? '';
    if (!text) throw new ProviderError('Ollama returned no content.', 'bad_payload');
    return { text, model, provider: this.id };
  }
}

const FACTORIES: Record<AiProviderId, (model: string) => AiAnalysisProvider> = {
  anthropic: (model) => new AnthropicProvider(model),
  openai: (model) =>
    new OpenAiCompatibleProvider(
      {
        id: 'openai',
        label: 'OpenAI',
        url: 'https://api.openai.com/v1/chat/completions',
        apiKey: () => env().OPENAI_API_KEY,
        tokenParam: 'max_completion_tokens',
      },
      model,
    ),
  openrouter: (model) =>
    new OpenAiCompatibleProvider(
      {
        id: 'openrouter',
        label: 'OpenRouter',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: () => env().OPENROUTER_API_KEY,
        tokenParam: 'max_tokens',
      },
      model,
    ),
  gemini: (model) =>
    new OpenAiCompatibleProvider(
      {
        id: 'gemini',
        label: 'Google Gemini',
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        apiKey: () => env().GEMINI_API_KEY,
        // Gemini 3.x always thinks, and thinking tokens count against this
        // limit, so the caller's budget must leave room for both.
        tokenParam: 'max_tokens',
        timeoutMs: 120_000,
        extraBody: { reasoning_effort: 'medium' },
      },
      model,
    ),
  groq: (model) =>
    new OpenAiCompatibleProvider(
      {
        id: 'groq',
        label: 'Groq',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        apiKey: () => env().GROQ_API_KEY,
        tokenParam: 'max_completion_tokens',
        // The free plan allows ~1,000 OUTPUT tokens per minute for
        // qwen3.8-27b, and refuses outright any request whose expected output
        // exceeds that (observed 2026-10-28: "OTPM: Limit 1000, Requested
        // 1398"). The cap keeps requests admissible; the prompt asks for a
        // concise answer that fits inside it.
        maxTokensCap: 1_000,
        // Strict schema decoding is supported by the models worth using here
        // (qwen3.8-27b, gpt-oss-120b); it guarantees the shape we validate.
        extraBody: {
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'market_analysis', strict: true, schema: AI_JSON_SCHEMA },
          },
        },
      },
      model,
    ),
  ollama: (model) => new OllamaProvider(model),
};

/** One provider instance; the model defaults to the first one configured. */
export function aiProviderById(id: AiProviderId, model = aiModelsFor(id)[0] ?? ''): AiAnalysisProvider {
  return FACTORIES[id](model);
}

/**
 * Every (provider, model) pair named in AI_PROVIDER and the *_MODEL lists, in
 * fallback order, whether configured or not. A provider with no model still
 * appears once, so the verify script can say what is missing.
 */
export function aiProviderChain(): AiAnalysisProvider[] {
  return env().AI_PROVIDER.flatMap((id) => {
    const models = aiModelsFor(id);
    return (models.length > 0 ? models : ['']).map((m) => aiProviderById(id, m));
  });
}

/**
 * Which ready providers to call now, in order. A provider that recently
 * reported overload, quota exhaustion or a timeout is skipped until its
 * cooldown ends, so one sick provider does not add its full timeout to every
 * analysis. If every provider is cooling down, all are tried anyway: a stale
 * cooldown must never switch AI off by itself.
 */
export function providersToTry(
  ready: readonly AiAnalysisProvider[],
  coolingUntil: ReadonlyMap<string, number>,
  now: number,
): { attempt: AiAnalysisProvider[]; skipped: { key: string; untilMs: number }[] } {
  const isCooling = (p: AiAnalysisProvider) => (coolingUntil.get(p.key) ?? 0) > now;
  const available = ready.filter((p) => !isCooling(p));
  if (available.length === 0) return { attempt: [...ready], skipped: [] };
  return {
    attempt: available,
    skipped: ready.filter(isCooling).map((p) => ({ key: p.key, untilMs: coolingUntil.get(p.key)! })),
  };
}

/**
 * How long to skip a provider after a failure, or undefined to not skip it.
 * The durations follow what the free tiers were observed doing:
 *  - 429 is usually a per-minute budget. Groq's free plan allows ~1,000 output
 *    tokens a minute for qwen3.8-27b and one analysis uses ~1,500, so it
 *    recovers within a minute or two.
 *  - 503 is an overloaded model; Gemini answered "high demand" for 10+ minutes.
 *  - A timeout already cost the caller its full wait, so it is avoided longest.
 * A Retry-After from the provider always wins when it is longer.
 */
export function aiCooldownMs(err: ProviderError): number | undefined {
  const base =
    err.kind === 'timeout'
      ? 10 * 60_000
      : err.kind === 'rate_limited'
        ? err.status === 503
          ? 5 * 60_000
          : 90_000
        : undefined;
  return base === undefined ? undefined : Math.max(err.retryAfterMs ?? 0, base);
}

export type { AiAnalysisProvider, AiRequest, AiResponse };
