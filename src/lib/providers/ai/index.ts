import 'server-only';
import { env } from '@/lib/config/env';
import { postJson, ProviderError } from '@/lib/providers/http';
import type { AiAnalysisProvider, AiRequest, AiResponse } from './types';

/**
 * Configurable LLM adapters.
 *
 * All four speak JSON-only; the caller validates the result against a Zod
 * schema and discards anything that does not conform. No adapter is a hard
 * dependency: with AI_PROVIDER=none the platform runs fully on deterministic
 * analysis.
 *
 * NOTE ON VERIFICATION: these adapters are implemented against each vendor's
 * documented request shape but have NOT been exercised against a live endpoint
 * in this repository, because no API key is configured. See
 * docs/DATA_PROVIDER_EVALUATION.md.
 */

class AnthropicProvider implements AiAnalysisProvider {
  readonly id = 'anthropic';
  readonly label = 'Anthropic Claude';

  isConfigured(): boolean {
    return env().ANTHROPIC_API_KEY !== '';
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const e = env();
    if (!this.isConfigured()) throw new ProviderError('ANTHROPIC_API_KEY is not set.', 'not_configured');
    const body = {
      model: e.AI_MODEL,
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
      },
    );
    const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
    if (!text) throw new ProviderError('Anthropic returned no text content.', 'bad_payload');
    return { text, model: e.AI_MODEL, provider: this.id };
  }
}

class OpenAiProvider implements AiAnalysisProvider {
  readonly id = 'openai';
  readonly label = 'OpenAI';

  isConfigured(): boolean {
    return env().OPENAI_API_KEY !== '';
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const e = env();
    if (!this.isConfigured()) throw new ProviderError('OPENAI_API_KEY is not set.', 'not_configured');
    const res = await postJson<{ choices: { message: { content: string } }[] }>(
      'https://api.openai.com/v1/chat/completions',
      {
        model: e.AI_MODEL,
        max_completion_tokens: req.maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
      },
      { headers: { Authorization: `Bearer ${e.OPENAI_API_KEY}` } },
    );
    const text = res.choices?.[0]?.message?.content ?? '';
    if (!text) throw new ProviderError('OpenAI returned no content.', 'bad_payload');
    return { text, model: e.AI_MODEL, provider: this.id };
  }
}

class OpenRouterProvider implements AiAnalysisProvider {
  readonly id = 'openrouter';
  readonly label = 'OpenRouter';

  isConfigured(): boolean {
    return env().OPENROUTER_API_KEY !== '';
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const e = env();
    if (!this.isConfigured()) throw new ProviderError('OPENROUTER_API_KEY is not set.', 'not_configured');
    const res = await postJson<{ choices: { message: { content: string } }[] }>(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: e.AI_MODEL,
        max_tokens: req.maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
      },
      { headers: { Authorization: `Bearer ${e.OPENROUTER_API_KEY}` } },
    );
    const text = res.choices?.[0]?.message?.content ?? '';
    if (!text) throw new ProviderError('OpenRouter returned no content.', 'bad_payload');
    return { text, model: e.AI_MODEL, provider: this.id };
  }
}

/** Local models via Ollama - zero marginal cost, no data leaves the machine. */
class OllamaProvider implements AiAnalysisProvider {
  readonly id = 'ollama';
  readonly label = 'Ollama (local)';

  isConfigured(): boolean {
    return env().OLLAMA_BASE_URL !== '';
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const e = env();
    const res = await postJson<{ message?: { content: string } }>(
      `${e.OLLAMA_BASE_URL.replace(/\/$/, '')}/api/chat`,
      {
        model: e.AI_MODEL,
        stream: false,
        format: 'json',
        options: { num_predict: req.maxTokens },
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
      },
      // Ollama is local by design; this header opts the URL past the
      // private-host guard, which still blocks every other local target.
      { headers: { 'x-allow-local': '1' }, timeoutMs: 120_000 },
    );
    const text = res.message?.content ?? '';
    if (!text) throw new ProviderError('Ollama returned no content.', 'bad_payload');
    return { text, model: e.AI_MODEL, provider: this.id };
  }
}

export function aiProvider(): AiAnalysisProvider | null {
  switch (env().AI_PROVIDER) {
    case 'anthropic':
      return new AnthropicProvider();
    case 'openai':
      return new OpenAiProvider();
    case 'openrouter':
      return new OpenRouterProvider();
    case 'ollama':
      return new OllamaProvider();
    default:
      return null;
  }
}

export type { AiAnalysisProvider, AiRequest, AiResponse };
