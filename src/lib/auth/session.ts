/**
 * Single-user authentication.
 *
 * Model: one password (AUTH_PASSWORD) protects the whole app. On success a
 * signed, HttpOnly cookie is issued. The cookie contains only an expiry and an
 * HMAC - never the password, never a key.
 *
 * If AUTH_PASSWORD is empty the app refuses connections that do not originate
 * from localhost. That makes local development frictionless while ensuring a
 * public deployment without a password is not silently left open: "a private
 * URL" is explicitly NOT treated as access control.
 *
 * Uses Web Crypto so the same code runs in the proxy (Node.js runtime since Next 16) and in
 * Node route handlers.
 */

export const SESSION_COOKIE = 'ai_trade_session';

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toBase64Url(new Uint8Array(sig));
}

/** Constant-time comparison; avoids leaking match position through timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(secret: string, ttlHours: number): Promise<string> {
  const expiresAt = Date.now() + ttlHours * 3_600_000;
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ exp: expiresAt })));
  const signature = await hmac(secret, payload);
  return `${payload}.${signature}`;
}

export async function verifySessionToken(secret: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(signature, expected)) return false;

  try {
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { exp?: number };
    return typeof decoded.exp === 'number' && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

/** Hosts treated as local for the no-password development mode. */
export function isLocalRequest(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.split(':')[0]!.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}
