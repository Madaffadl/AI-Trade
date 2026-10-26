import 'server-only';
import { env } from '@/lib/config/env';
import { timingSafeEqual } from './session';

/**
 * Cron endpoints are called by an external scheduler, so they cannot use the
 * session cookie. They authenticate with a bearer token instead.
 *
 * When CRON_SECRET is unset the endpoint is restricted to localhost, which
 * keeps local development usable without leaving a public trigger open.
 */
export function authorizeCron(request: Request): { ok: true } | { ok: false; status: number; error: string } {
  const secret = env().CRON_SECRET;
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (secret === '') {
    const host = request.headers.get('host')?.split(':')[0]?.toLowerCase() ?? '';
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return { ok: true };
    return {
      ok: false,
      status: 403,
      error: 'CRON_SECRET is not configured, so this endpoint only accepts local requests.',
    };
  }
  if (!token || !timingSafeEqual(token, secret)) {
    return { ok: false, status: 401, error: 'Invalid or missing cron bearer token.' };
  }
  return { ok: true };
}
