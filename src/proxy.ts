import { NextResponse, type NextRequest } from 'next/server';
import { isLocalRequest, SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';

/**
 * Route protection (Next.js `proxy`, formerly `middleware`).
 *
 * Every page and API route is protected except the login page, the login API,
 * and static assets. Cron endpoints authenticate separately with a bearer
 * token, so they are excluded here and checked in their own handler.
 *
 * RUNTIME: Node.js. Next 16 renamed `middleware` to `proxy` and runs it on
 * the Node.js runtime; the Edge runtime is no longer available here, and
 * setting `runtime` in `config` throws. Session verification still uses Web
 * Crypto (`crypto.subtle`), which Node exposes globally, so the same code also
 * stays portable if this ever moves back to an edge host.
 *
 * This app defines no Server Functions, so the Next.js guidance not to rely
 * on proxy alone for those does not apply. Each protected Route Handler is
 * reached only through this gate.
 */

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/health'];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }
  // Cron routes carry their own bearer-token check.
  if (pathname.startsWith('/api/cron/')) return NextResponse.next();

  const password = process.env.AUTH_PASSWORD ?? '';
  const secret = process.env.AUTH_SESSION_SECRET ?? '';

  // No password configured: local development only. A remote request is
  // refused rather than silently served.
  if (password === '') {
    if (isLocalRequest(request.headers.get('host'))) return NextResponse.next();
    return new NextResponse(
      'This deployment has no AUTH_PASSWORD configured, so it only accepts local connections. ' +
        'Set AUTH_PASSWORD and AUTH_SESSION_SECRET before exposing it publicly.',
      { status: 403, headers: { 'content-type': 'text/plain' } },
    );
  }

  if (secret === '') {
    return new NextResponse('AUTH_SESSION_SECRET must be set when AUTH_PASSWORD is set.', { status: 500 });
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(secret, token)) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
