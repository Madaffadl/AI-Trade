import 'server-only';

/**
 * Shared HTTP client for every outbound provider call.
 *
 * Responsibilities: timeouts, bounded retries with exponential backoff and
 * jitter, rate-limit awareness (Retry-After), response size caps, and typed
 * failures. Business logic never calls fetch() directly.
 */

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'timeout'
      | 'network'
      | 'rate_limited'
      | 'http_error'
      | 'bad_payload'
      | 'not_supported'
      | 'not_configured',
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** Whether a scheduled job should try this provider again soon. */
  get retryable(): boolean {
    return this.kind === 'timeout' || this.kind === 'network' || this.kind === 'rate_limited';
  }
}

export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Maximum response size accepted, in bytes. Guards against runaway feeds. */
  maxBytes?: number;
  signal?: AbortSignal;
}

const DEFAULTS = { timeoutMs: 12_000, retries: 2, maxBytes: 8 * 1024 * 1024 };

const USER_AGENT = 'ai-trade/0.1 (personal research tool)';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Exponential backoff with full jitter, capped. */
function backoffMs(attempt: number): number {
  const base = Math.min(8_000, 400 * 2 ** attempt);
  return Math.round(Math.random() * base);
}

/**
 * Only http(s) to a host is permitted. This blocks file://, data:, and
 * obvious SSRF targets if a URL ever originates from external content
 * (e.g. an RSS <link>) rather than from our own configuration.
 */
export function assertSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProviderError(`Malformed URL: ${raw.slice(0, 120)}`, 'bad_payload');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new ProviderError(`Blocked URL scheme: ${u.protocol}`, 'bad_payload');
  }
  const host = u.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '[::1]';
  if (blocked) {
    throw new ProviderError(`Blocked private/loopback host: ${host}`, 'bad_payload');
  }
  return u;
}

async function once(url: string, opts: Required<Pick<HttpOptions, 'timeoutMs' | 'maxBytes'>> & HttpOptions): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/xml, text/csv, */*', ...opts.headers },
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
    });

    if (res.status === 429 || res.status === 503) {
      const ra = res.headers.get('retry-after');
      const retryAfterMs = ra ? Number(ra) * 1000 : undefined;
      throw new ProviderError(
        `Provider rate-limited the request (HTTP ${res.status}).`,
        'rate_limited',
        res.status,
        Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      );
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new ProviderError(`HTTP ${res.status} from provider: ${body}`, 'http_error', res.status);
    }

    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > opts.maxBytes) {
      throw new ProviderError(`Response too large (${len} bytes).`, 'bad_payload');
    }
    const text = await res.text();
    if (text.length > opts.maxBytes) {
      throw new ProviderError(`Response too large (${text.length} bytes).`, 'bad_payload');
    }
    return text;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderError(`Request timed out after ${opts.timeoutMs}ms.`, 'timeout');
    }
    throw new ProviderError(err instanceof Error ? err.message : 'Unknown network failure', 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** GET returning raw text, with retries on transient failures. */
export async function httpText(url: string, options: HttpOptions = {}): Promise<string> {
  assertSafeUrl(url);
  const opts = { ...DEFAULTS, ...options };
  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await once(url, opts);
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), 'network');
      lastError = pe;
      if (!pe.retryable || attempt === opts.retries) break;
      await sleep(pe.retryAfterMs ?? backoffMs(attempt));
    }
  }
  throw lastError ?? new ProviderError('Request failed', 'network');
}

/** GET returning parsed JSON. */
export async function httpJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const text = await httpText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(`Provider returned non-JSON payload: ${text.slice(0, 120)}`, 'bad_payload');
  }
}

/** POST JSON, returning parsed JSON. Used by AI providers and Telegram. */
export async function postJson<T>(
  url: string,
  body: unknown,
  options: HttpOptions = {},
): Promise<T> {
  assertSafeUrlAllowingLocal(url, options);
  const opts = { ...DEFAULTS, ...options, timeoutMs: options.timeoutMs ?? 60_000 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, ...opts.headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    if (res.status === 429) {
      throw new ProviderError('Rate limited by provider.', 'rate_limited', 429);
    }
    if (!res.ok) {
      throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 300)}`, 'http_error', res.status);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderError(`Non-JSON response: ${text.slice(0, 120)}`, 'bad_payload');
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderError(`Request timed out after ${opts.timeoutMs}ms.`, 'timeout');
    }
    throw new ProviderError(err instanceof Error ? err.message : String(err), 'network');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ollama runs on localhost by design, so the private-host guard is relaxed for
 * explicitly configured POST targets only - never for URLs discovered in
 * external content.
 */
function assertSafeUrlAllowingLocal(raw: string, options: HttpOptions): void {
  try {
    assertSafeUrl(raw);
  } catch (err) {
    const u = new URL(raw);
    const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (!(isLocal && options.headers?.['x-allow-local'] === '1')) throw err;
  }
}
