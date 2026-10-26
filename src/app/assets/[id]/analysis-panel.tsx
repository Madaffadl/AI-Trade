'use client';

import { useState } from 'react';
import { fill, type AiPanelLabels } from '@/lib/i18n/client-labels';

interface AiAnalysis {
  technicalSummary: string;
  bullishArguments: string[];
  bearishArguments: string[];
  newsInterpretation: string | null;
  assumptions: string[];
  potentialCatalysts: string[];
  invalidationCommentary: string;
  finalAssessment: string;
  limitations: string[];
  citations: string[];
}

interface AnalysisResponse {
  aiStatus: string;
  aiProvider: string;
  aiModel: string | null;
  aiError: string | null;
  ai: AiAnalysis | null;
}

/**
 * AI commentary is requested explicitly, never on render. That keeps page
 * navigation free of provider cost.
 */
export function AnalysisPanel({
  assetId,
  timeframe,
  aiEnabled,
  initial,
  t,
}: {
  assetId: string;
  timeframe: string;
  aiEnabled: boolean;
  initial: AnalysisResponse;
  t: AiPanelLabels;
}) {
  const [state, setState] = useState<AnalysisResponse>(initial);
  const [busy, setBusy] = useState(false);

  async function generate(force: boolean) {
    setBusy(true);
    try {
      const res = await fetch('/api/analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId, timeframe, allowAiCall: true, force }),
      });
      const body = (await res.json()) as AnalysisResponse & { error?: string };
      if (res.ok) setState(body);
      else setState({ ...state, aiStatus: 'error', aiError: body.error ?? t.requestFailed });
    } catch {
      setState({ ...state, aiStatus: 'error', aiError: t.networkError });
    } finally {
      setBusy(false);
    }
  }

  const ai = state.ai;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => generate(false)}
          disabled={busy || !aiEnabled}
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-40"
          title={aiEnabled ? t.callsProvider : t.aiNotConfigured}
        >
          {busy ? t.generating : t.generate}
        </button>
        {ai && (
          <button
            onClick={() => generate(true)}
            disabled={busy || !aiEnabled}
            className="rounded border border-line px-3 py-1.5 text-xs text-ink-muted disabled:opacity-40"
          >
            {t.regenerate}
          </button>
        )}
        {state.aiStatus !== 'skipped' && (
          <span className="text-2xs text-ink-faint">
            {fill(t.statusTemplate, { status: state.aiStatus })}
            {state.aiModel ? ` · ${state.aiProvider}/${state.aiModel}` : ''}
          </span>
        )}
      </div>

      {state.aiError && (
        <div className="rounded border border-line-strong bg-bg-inset px-3 py-2 text-2xs text-ink-muted">
          {state.aiError}
        </div>
      )}

      {!ai ? (
        <p className="text-2xs text-ink-faint">
          {t.noCommentary}
        </p>
      ) : (
        <div className="space-y-4">
          <Section title={t.technicalSummary}>
            <p className="text-2xs leading-relaxed text-ink-muted">{ai.technicalSummary}</p>
          </Section>

          <div className="grid gap-4 sm:grid-cols-2">
            <Section title={t.bullish}>
              <List items={ai.bullishArguments} tone="text-up" emptyLabel={t.noneItem} />
            </Section>
            <Section title={t.bearish}>
              <List items={ai.bearishArguments} tone="text-down" emptyLabel={t.noneItem} />
            </Section>
          </div>

          {ai.newsInterpretation && (
            <Section title={t.newsContext}>
              <p className="text-2xs leading-relaxed text-ink-muted">{ai.newsInterpretation}</p>
            </Section>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Section title={t.assumptions}>
              <List items={ai.assumptions} emptyLabel={t.noneItem} />
            </Section>
            <Section title={t.catalysts}>
              <List items={ai.potentialCatalysts} emptyLabel={t.noneItem} />
            </Section>
          </div>

          <Section title={t.whatInvalidates}>
            <p className="text-2xs leading-relaxed text-ink-muted">{ai.invalidationCommentary}</p>
          </Section>

          <Section title={t.finalAssessment}>
            <p className="text-2xs leading-relaxed text-ink">{ai.finalAssessment}</p>
          </Section>

          <Section title={t.limitations}>
            <List items={ai.limitations} tone="text-warn" emptyLabel={t.noneItem} />
          </Section>

          {ai.citations.length > 0 && (
            <Section title={t.sources}>
              <ul className="space-y-0.5">
                {ai.citations.map((c) => (
                  <li key={c}>
                    <a
                      href={c}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="inline-flex min-h-[24px] items-center text-2xs text-accent hover:underline"
                    >
                      {c}
                    </a>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-2xs text-ink-faint">
                {t.sourcesNote}
              </p>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">{title}</h3>
      {children}
    </div>
  );
}

function List({
  items,
  tone = 'text-ink-muted',
  emptyLabel,
}: {
  items: string[];
  tone?: string;
  emptyLabel: string;
}) {
  if (items.length === 0) return <p className="text-2xs text-ink-faint">{emptyLabel}</p>;
  return (
    <ul className="space-y-1">
      {items.map((item, i) => (
        <li key={i} className={`text-2xs leading-relaxed ${tone}`}>
          • {item}
        </li>
      ))}
    </ul>
  );
}
