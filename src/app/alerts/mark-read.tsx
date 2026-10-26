'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function MarkReadButtons({
  unread,
  label,
  busyLabel,
}: {
  unread: number;
  label: string;
  busyLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function markAll() {
    setBusy(true);
    try {
      await fetch('/api/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={markAll}
      disabled={busy || unread === 0}
      className="rounded border border-line px-3 py-1.5 text-2xs text-ink-muted hover:text-ink disabled:opacity-40"
    >
      {busy ? busyLabel : `${label}${unread > 0 ? ` (${unread})` : ''}`}
    </button>
  );
}
