import { LoginForm } from './login-form';
import { getMessages } from '@/lib/i18n';

export const metadata = { title: 'Sign in — AI Trade' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const t = await getMessages();
  const params = await searchParams;
  const configured = (process.env.AUTH_PASSWORD ?? '') !== '';

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center">
      <h1 className="text-lg font-semibold text-ink">AI Trade</h1>
      <p className="mt-1 text-2xs text-ink-muted">{t.login.subtitle}</p>

      {configured ? (
        <LoginForm next={params.next ?? '/'} labels={t.login} />
      ) : (
        <div className="mt-5 rounded border border-warn/30 bg-warn-dim/40 px-3 py-3 text-2xs text-warn">
          {t.login.noPassword}
        </div>
      )}
    </div>
  );
}
