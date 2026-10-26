import 'server-only';
import { createAlertIfNew, recordDelivery, type NewAlert } from './repo';
import { sendTelegramAlert, telegramConfigured } from './telegram';

/**
 * Create an alert and fan it out to enabled channels.
 *
 * Delivery only happens for a NEWLY created alert. If the dedupe key already
 * existed, nothing is sent - this is the single place that guarantees a
 * recalculated-but-unchanged signal cannot re-notify.
 */
export async function dispatchAlert(alert: NewAlert): Promise<{ created: boolean; delivered: string[] }> {
  const { created, alert: row } = await createAlertIfNew(alert);
  if (!created) return { created: false, delivered: [] };

  const delivered: string[] = [];
  await recordDelivery(row.id, 'in_app', 'sent');
  delivered.push('in_app');

  if (telegramConfigured()) {
    const result = await sendTelegramAlert(row);
    if (result.sent) delivered.push('telegram');
  }
  return { created: true, delivered };
}
