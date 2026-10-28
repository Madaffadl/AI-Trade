import type { AiProviderId } from '@/lib/config/env';

export interface AiRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
}

export interface AiResponse {
  /** Raw text returned by the model. Parsed and validated by the caller. */
  text: string;
  model: string;
  provider: string;
}

export interface AiAnalysisProvider {
  readonly id: AiProviderId;
  readonly label: string;
  readonly model: string;
  /** "provider/model": the unit that health and cooldowns are tracked by. */
  readonly key: string;
  isConfigured(): boolean;
  complete(req: AiRequest): Promise<AiResponse>;
}
