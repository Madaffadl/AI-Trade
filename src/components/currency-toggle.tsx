'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/** Switches the display currency for every price in the app. */
export function CurrencyToggle({
  current,
  title,
  nativeLabel,
}: {
  current: string;
  title: string;
  nativeLabel: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(current);
  const [pending, startTransition] = useTransition();

  async function choose(next: string) {
    setValue(next);
    await fetch('/api/settings/currency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency: next }),
    });
    startTransition(() => router.refresh());
  }

  const options = [
    { value: 'native', label: nativeLabel },
    { value: 'USD', label: 'USD' },
    { value: 'IDR', label: 'IDR' },
  ];

  return (
    <div className="flex items-center rounded border border-line" title={title}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => choose(o.value)}
          disabled={pending}
          className={`min-h-[26px] min-w-[26px] px-1.5 py-1 text-2xs transition-colors first:rounded-l last:rounded-r ${
            value === o.value ? 'bg-accent-dim text-accent' : 'text-ink-faint hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
