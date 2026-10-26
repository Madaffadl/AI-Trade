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
  readonly id: string;
  readonly label: string;
  isConfigured(): boolean;
  complete(req: AiRequest): Promise<AiResponse>;
}
