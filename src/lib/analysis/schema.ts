import { z } from 'zod';

/**
 * Schema for AI-generated commentary.
 *
 * Note what is ABSENT by design: no price, no indicator value, no probability,
 * no numeric target. The model is asked to interpret and explain the
 * deterministic facts it is given; every number shown in the UI comes from
 * src/lib/indicators and src/lib/signals, never from the model.
 *
 * `citations` may only reference URLs that were supplied in the prompt. The
 * validator enforces that, so a hallucinated source URL is rejected rather
 * than rendered.
 */
export const AiAnalysisSchema = z.object({
  technicalSummary: z
    .string()
    .min(20)
    .max(1200)
    .describe('Plain-language reading of the supplied indicator values.'),
  bullishArguments: z.array(z.string().min(5).max(400)).min(1).max(6),
  bearishArguments: z.array(z.string().min(5).max(400)).min(1).max(6),
  newsInterpretation: z.string().max(1200).nullable(),
  assumptions: z.array(z.string().min(5).max(300)).max(6),
  potentialCatalysts: z.array(z.string().min(5).max(300)).max(6),
  invalidationCommentary: z.string().max(800),
  finalAssessment: z
    .string()
    .min(20)
    .max(900)
    .describe('Balanced closing view. Must not promise profit or state a probability.'),
  limitations: z.array(z.string().min(5).max(300)).min(1).max(6),
  citations: z.array(z.string().url()).max(10),
});

export type AiAnalysis = z.infer<typeof AiAnalysisSchema>;

/** Phrases that must never appear in AI commentary for a trading tool. */
const FORBIDDEN = [
  /guaranteed?\s+(profit|return|win)/i,
  /\bcan'?t\s+lose\b/i,
  /\brisk[- ]free\b/i,
  /\b\d{2,3}\s*%\s*(chance|probability|certain)/i,
  /\bsure\s+thing\b/i,
];

export interface ValidationResult {
  ok: boolean;
  analysis: AiAnalysis | null;
  errors: string[];
}

/**
 * Validate a model response.
 * `allowedUrls` is the exact set supplied in the prompt; any other citation is
 * treated as fabricated and the response is rejected.
 */
export function validateAiAnalysis(raw: unknown, allowedUrls: readonly string[]): ValidationResult {
  const parsed = AiAnalysisSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      analysis: null,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }

  const errors: string[] = [];
  const allowed = new Set(allowedUrls);
  const invented = parsed.data.citations.filter((c) => !allowed.has(c));
  if (invented.length > 0) {
    errors.push(`Response cited ${invented.length} URL(s) that were not supplied in the prompt: ${invented.join(', ')}`);
  }

  const allText = [
    parsed.data.technicalSummary,
    parsed.data.finalAssessment,
    parsed.data.newsInterpretation ?? '',
    ...parsed.data.bullishArguments,
    ...parsed.data.bearishArguments,
  ].join(' ');
  for (const rule of FORBIDDEN) {
    if (rule.test(allText)) errors.push(`Response contains a prohibited claim matching ${rule}.`);
  }

  return errors.length > 0 ? { ok: false, analysis: null, errors } : { ok: true, analysis: parsed.data, errors: [] };
}

/** JSON Schema handed to providers that support structured output. */
export const AI_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'technicalSummary',
    'bullishArguments',
    'bearishArguments',
    'newsInterpretation',
    'assumptions',
    'potentialCatalysts',
    'invalidationCommentary',
    'finalAssessment',
    'limitations',
    'citations',
  ],
  properties: {
    technicalSummary: { type: 'string' },
    bullishArguments: { type: 'array', items: { type: 'string' } },
    bearishArguments: { type: 'array', items: { type: 'string' } },
    newsInterpretation: { type: ['string', 'null'] },
    assumptions: { type: 'array', items: { type: 'string' } },
    potentialCatalysts: { type: 'array', items: { type: 'string' } },
    invalidationCommentary: { type: 'string' },
    finalAssessment: { type: 'string' },
    limitations: { type: 'array', items: { type: 'string' } },
    citations: { type: 'array', items: { type: 'string' } },
  },
} as const;
