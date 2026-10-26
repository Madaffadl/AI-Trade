'use client';

import { useState } from 'react';

export interface GuideLabels {
  title: string;
  subtitle: string;
  hide: string;
  show: string;
  step1Title: string;
  step1Body: string;
  step2Title: string;
  step2Body: string;
  step3Title: string;
  step3Body: string;
  step4Title: string;
  step4Body: string;
  step5Title: string;
  step5Body: string;
  step6Title: string;
  step6Body: string;
  safetyTitle: string;
  safety1: string;
  safety2: string;
  safety3: string;
  tooltipHint: string;
}

const STORAGE_KEY = 'ai-trade.guide.hidden';

/**
 * First-run orientation.
 *
 * Collapsible and remembered in localStorage — a permanent banner becomes
 * noise, and a guide you cannot bring back is worse. Kept out of the database
 * because it is a per-browser display preference, not app state.
 */
export function BeginnerGuide({ labels }: { labels: GuideLabels }) {
  const [hidden, setHidden] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  });

  function toggle(next: boolean) {
    setHidden(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      // Private browsing can reject storage; the guide still toggles.
    }
  }

  if (hidden) {
    return (
      <button
        onClick={() => toggle(false)}
        className="rounded border border-line px-3 py-1.5 text-2xs text-ink-muted hover:text-ink"
      >
        {labels.show}
      </button>
    );
  }

  const steps = [
    { title: labels.step1Title, body: labels.step1Body },
    { title: labels.step2Title, body: labels.step2Body },
    { title: labels.step3Title, body: labels.step3Body },
    { title: labels.step4Title, body: labels.step4Body },
    { title: labels.step5Title, body: labels.step5Body },
    { title: labels.step6Title, body: labels.step6Body },
  ];

  return (
    <section className="rounded-lg border border-accent/25 bg-accent-dim/20">
      <header className="flex items-start justify-between gap-4 border-b border-accent/20 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{labels.title}</h2>
          <p className="mt-0.5 text-2xs text-ink-muted">{labels.subtitle}</p>
        </div>
        <button onClick={() => toggle(true)} className="inline-flex min-h-[24px] shrink-0 items-center rounded px-1.5 text-2xs text-ink-faint transition-colors hover:text-ink">
          {labels.hide}
        </button>
      </header>

      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map((s) => (
          <div key={s.title} className="rounded border border-line bg-bg-raised px-3 py-2.5">
            <p className="text-2xs font-semibold text-accent">{s.title}</p>
            <p className="mt-1 text-2xs leading-relaxed text-ink-muted">{s.body}</p>
          </div>
        ))}
      </div>

      <div className="border-t border-accent/20 px-4 py-3">
        <p className="text-2xs font-semibold text-warn">{labels.safetyTitle}</p>
        <ul className="mt-1 space-y-1">
          {[labels.safety1, labels.safety2, labels.safety3].map((s) => (
            <li key={s} className="text-2xs leading-relaxed text-ink-muted">
              · {s}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-2xs text-ink-faint">{labels.tooltipHint}</p>
      </div>
    </section>
  );
}
