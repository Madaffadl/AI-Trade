'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function LoginForm({
  next,
  labels,
}: {
  next: string;
  labels: { password: string; signIn: string; signingIn: string; failed: string };
}) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // Only same-origin paths are accepted, so a crafted ?next= cannot
        // redirect elsewhere.
        router.push(next.startsWith('/') ? next : '/');
        router.refresh();
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? labels.failed);
      }
    } catch {
      setError(labels.failed);
    } finally {
      setPending(false);
      setPassword('');
    }
  }

  return (
    <form onSubmit={submit} className="mt-5 space-y-3">
      <div>
        <label htmlFor="password" className="block text-2xs text-ink-muted">
          {labels.password}
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded border border-line bg-bg-inset px-3 py-2 min-h-[44px] text-sm text-ink focus:border-accent"
          required
        />
      </div>
      {error && <p className="text-2xs text-down">{error}</p>}
      <button
        type="submit"
        disabled={pending || password.length === 0}
        className="w-full rounded bg-accent px-3 py-2 text-sm font-medium text-bg disabled:opacity-50"
      >
        {pending ? labels.signingIn : labels.signIn}
      </button>
    </form>
  );
}
