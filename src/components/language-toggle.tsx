'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { LOCALES, LOCALE_LABEL, LOCALE_NAME, type Locale } from '@/lib/i18n/types';

/** Switches the interface language for the whole app. */
export function LanguageToggle({ current, title }: { current: Locale; title: string }) {
  const router = useRouter();
  const [value, setValue] = useState<Locale>(current);
  const [pending, startTransition] = useTransition();

  async function choose(next: Locale) {
    setValue(next);
    await fetch('/api/settings/locale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: next }),
    });
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex items-center rounded border border-line" title={title}>
      {LOCALES.map((l) => (
        <button
          key={l}
          onClick={() => choose(l)}
          disabled={pending}
          aria-label={LOCALE_NAME[l]}
          className={`min-h-[26px] min-w-[26px] px-1.5 py-1 text-2xs transition-colors first:rounded-l last:rounded-r ${
            value === l ? 'bg-accent-dim text-accent' : 'text-ink-faint hover:text-ink'
          }`}
        >
          {LOCALE_LABEL[l]}
        </button>
      ))}
    </div>
  );
}
