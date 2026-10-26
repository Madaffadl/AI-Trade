import 'server-only';
import { env } from '@/lib/config/env';
import { postJson, ProviderError } from '@/lib/providers/http';
import { recordDelivery, type AlertRow } from './repo';

/**
 * Optional Telegram delivery.
 *
 * Costs nothing (Telegram's Bot API is free) and is entirely opt-in: without
 * both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID the channel reports itself as
 * suppressed and the in-app notification is unaffected.
 *
 * The bot token is read from the environment on the server only; it is never
 * returned by an API route or rendered into a page.
 */

export function telegramConfigured(): boolean {
  const e = env();
  return e.TELEGRAM_BOT_TOKEN !== '' && e.TELEGRAM_CHAT_ID !== '';
}

/** Escape user/market text for Telegram's MarkdownV2 parser. */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}

export async function sendTelegramAlert(alert: AlertRow): Promise<{ sent: boolean; reason?: string }> {
  if (!telegramConfigured()) {
    await recordDelivery(alert.id, 'telegram', 'suppressed', 'Telegram credentials are not configured.');
    return { sent: false, reason: 'not_configured' };
  }

  const e = env();
  const text = [
    `*${escapeMarkdown(alert.title)}*`,
    '',
    escapeMarkdown(alert.body),
    '',
    escapeMarkdown(`Severity: ${alert.severity} · ${new Date(alert.created_at_ms).toISOString()}`),
    escapeMarkdown('Analysis only - this app never places orders.'),
  ].join('\n');

  try {
    await postJson(`https://api.telegram.org/bot${e.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: e.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    });
    await recordDelivery(alert.id, 'telegram', 'sent');
    return { sent: true };
  } catch (err) {
    // Never log the token; ProviderError messages contain only response bodies.
    const message = err instanceof ProviderError ? `${err.kind}: ${err.message}` : String(err);
    await recordDelivery(alert.id, 'telegram', 'failed', message);
    return { sent: false, reason: message };
  }
}

/** Verify credentials without sending a message. */
export async function telegramSelfTest(): Promise<{ ok: boolean; detail: string }> {
  if (!telegramConfigured()) return { ok: false, detail: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not both set.' };
  try {
    const res = await postJson<{ ok: boolean; result?: { username?: string } }>(
      `https://api.telegram.org/bot${env().TELEGRAM_BOT_TOKEN}/getMe`,
      {},
      { timeoutMs: 10_000 },
    );
    return res.ok
      ? { ok: true, detail: `Connected as @${res.result?.username ?? 'unknown'}.` }
      : { ok: false, detail: 'Telegram rejected the token.' };
  } catch (err) {
    return { ok: false, detail: err instanceof ProviderError ? err.message : String(err) };
  }
}
