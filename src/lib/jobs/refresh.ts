import 'server-only';
import { ensureDefaultWatchlist, finishJob, listWatchlist, startJob } from '@/lib/db/repo';
import { getSeries } from '@/lib/market/service';
import type { Timeframe, TradingStyle } from '@/lib/market/types';
import { STYLE_TIMEFRAMES } from '@/lib/market/types';
import { dispatchAlert } from '@/lib/notifications/dispatch';
import { runEngineForAsset } from '@/lib/signals/engine';
import { STRATEGIES } from '@/lib/strategies';
import { listActiveActionable, updateSignalStatus } from '@/lib/signals/repo';

/**
 * The scheduled refresh job.
 *
 * It deliberately refreshes ONLY what is needed: the assets on the watchlist,
 * at the single timeframe implied by each asset's configured trading style.
 * Refreshing every asset at every timeframe would multiply provider calls by
 * ~7 and exhaust free quotas within minutes.
 */

export interface RefreshSummary {
  jobId: string;
  startedAtMs: number;
  finishedAtMs: number;
  assetsProcessed: number;
  signalsCreated: number;
  alertsCreated: number;
  invalidations: number;
  errors: { symbol: string; timeframe: string; error: string }[];
  skipped: { symbol: string; timeframe: string; reason: string }[];
}

/**
 * The primary timeframe to refresh for a trading style.
 *
 * Prefers the SLOWEST timeframe the style allows - it needs the fewest provider
 * calls and is least likely to be suppressed as stale - but only among
 * timeframes that at least one enabled strategy can actually trade. Without
 * that filter a "position" asset would be refreshed at 1w, where no strategy
 * runs, and would silently never produce a signal.
 */
function primaryTimeframe(style: string): Timeframe {
  const tfs = STYLE_TIMEFRAMES[(style as TradingStyle) in STYLE_TIMEFRAMES ? (style as TradingStyle) : 'swing'];
  const supported = tfs.filter((tf) => STRATEGIES.some((s) => s.timeframes.includes(tf)));
  return supported.at(-1) ?? tfs.at(-1)!;
}

export async function runRefresh(options: { force?: boolean } = {}): Promise<RefreshSummary> {
  const jobId = await startJob('refresh');
  const startedAtMs = Date.now();
  const summary: RefreshSummary = {
    jobId,
    startedAtMs,
    finishedAtMs: 0,
    assetsProcessed: 0,
    signalsCreated: 0,
    alertsCreated: 0,
    invalidations: 0,
    errors: [],
    skipped: [],
  };

  try {
    const watchlistId = await ensureDefaultWatchlist();
    const entries = await listWatchlist(watchlistId);

    for (const entry of entries) {
      const timeframe = primaryTimeframe(entry.tradingStyle);
      try {
        const result = await runEngineForAsset(entry, timeframe, { force: options.force });
        summary.assetsProcessed++;

        if (result.skipped && result.skipReason) {
          summary.skipped.push({ symbol: entry.symbol, timeframe, reason: result.skipReason });
        }

        for (const inv of result.invalidated) {
          summary.invalidations++;
          const sent = await dispatchAlert({
            dedupeKey: `signal_invalidated:${inv.signalId}`,
            kind: 'signal_invalidated',
            severity: 'warning',
            title: `${entry.symbol} signal invalidated`,
            body: inv.reason,
            assetId: entry.id,
            signalId: inv.signalId,
          });
          if (sent.created) summary.alertsCreated++;
        }

        for (const outcome of result.outcomes) {
          if (!outcome.created || !outcome.signalId) continue;
          summary.signalsCreated++;
          const sent = await dispatchAlert({
            dedupeKey: `new_signal:${outcome.signalId}`,
            kind: 'new_signal',
            severity: outcome.action === 'BUY' ? 'info' : 'warning',
            title: `${outcome.action} ${entry.symbol} (${timeframe}) - ${outcome.strength} setup`,
            body: `${outcome.summary}\nStrategy ${outcome.strategyId}@${outcome.strategyVersion}. Regime: ${result.regime}.`,
            assetId: entry.id,
            signalId: outcome.signalId,
            payload: { strategyId: outcome.strategyId, action: outcome.action, timeframe },
          });
          if (sent.created) summary.alertsCreated++;
        }
      } catch (err) {
        summary.errors.push({
          symbol: entry.symbol,
          timeframe,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    summary.alertsCreated += await reviewOpenPositions();
    summary.alertsCreated += await checkPriceThresholds();
    summary.invalidations += await expireStaleSignals();

    summary.finishedAtMs = Date.now();
    await finishJob(jobId, summary.errors.length === 0 ? 'ok' : 'partial', summary);
    return summary;
  } catch (err) {
    summary.finishedAtMs = Date.now();
    await finishJob(jobId, 'error', summary, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Review every real holding and alert when the plan says to act.
 *
 * Positions are NEVER closed automatically: the app cannot know whether the
 * user executed the sale at their venue. It alerts, and the user records the
 * actual fill.
 */
async function reviewOpenPositions(): Promise<number> {
  const { listPositions } = await import('@/lib/positions/repo');
  const { buildPositionPlan } = await import('@/lib/positions/plan');

  let created = 0;
  for (const position of await listPositions('open')) {
    try {
      const plan = await buildPositionPlan(position);

      if (plan.stopBreached) {
        const sent = await dispatchAlert({
          // Keyed to the position and the breaching bar, so a stop that stays
          // breached across refreshes alerts once, not every cycle.
          dedupeKey: `position_stop:${position.id}:${plan.latestCandleMs ?? 0}`,
          kind: 'new_signal',
          severity: 'critical',
          title: `STOP HIT — ${position.symbol} (${position.venue})`,
          body:
            `A closed bar fell below your stop-loss ${position.stop_loss}.\n` +
            `Your entry ${position.entry_price}, current ${plan.currentPrice}, ` +
            `unrealised ${plan.unrealizedPnl?.toFixed(2) ?? 'n/a'} ${position.currency}.\n` +
            `Sell at ${position.venue} if you are following the plan, then record the fill in AI Trade.`,
          assetId: position.asset_id,
          payload: { positionId: position.id, kind: 'stop_breached' },
        });
        if (sent.created) created++;
        continue;
      }

      if (plan.action === 'SELL') {
        const sent = await dispatchAlert({
          dedupeKey: `position_sell:${position.id}:${plan.latestCandleMs ?? 0}`,
          kind: 'new_signal',
          severity: 'warning',
          title: `SELL signal — ${position.symbol} (${position.venue})`,
          body:
            `${plan.actionReason}\n` +
            `Entry ${position.entry_price}, current ${plan.currentPrice}, ` +
            `unrealised ${plan.unrealizedPnl?.toFixed(2) ?? 'n/a'} ${position.currency} ` +
            `(${plan.unrealizedPnlPct?.toFixed(2) ?? 'n/a'}%).\n` +
            `This is an exit signal for a holding you own — not a short-selling signal.`,
          assetId: position.asset_id,
          payload: { positionId: position.id, kind: 'exit_signal' },
        });
        if (sent.created) created++;
        continue;
      }

      if (plan.targetReached) {
        const sent = await dispatchAlert({
          dedupeKey: `position_target:${position.id}:${plan.latestCandleMs ?? 0}`,
          kind: 'new_signal',
          severity: 'info',
          title: `Target reached — ${position.symbol} (${position.venue})`,
          body:
            `Price touched your first target ${position.take_profit_1}. ` +
            `Unrealised ${plan.unrealizedPnl?.toFixed(2) ?? 'n/a'} ${position.currency}. ` +
            `Decide whether to take profit or let it run toward ${position.take_profit_2 ?? 'your second target'}.`,
          assetId: position.asset_id,
          payload: { positionId: position.id, kind: 'target_reached' },
        });
        if (sent.created) created++;
      }
    } catch {
      // One bad position must never abort the whole refresh.
      continue;
    }
  }
  return created;
}

/** Fire configured price-threshold alerts, once per crossing. */
async function checkPriceThresholds(): Promise<number> {
  const { db } = await import('@/lib/db/driver');
  const { getAssetById } = await import('@/lib/db/repo');
  const d = await db();
  const rows = await d.all<{ id: string; asset_id: string; direction: string; price: number }>(
    'SELECT id, asset_id, direction, price FROM price_thresholds WHERE active = 1 AND triggered_at_ms IS NULL',
  );

  let created = 0;
  for (const t of rows) {
    const asset = await getAssetById(t.asset_id);
    if (!asset) continue;
    const series = await getSeries(asset, '1h', { limit: 5, minBars: 1 });
    const price = series.series?.candles.at(-1)?.close;
    if (price === undefined) continue;

    const hit = t.direction === 'above' ? price >= t.price : price <= t.price;
    if (!hit) continue;

    await d.run('UPDATE price_thresholds SET triggered_at_ms = ?, active = 0 WHERE id = ?', [Date.now(), t.id]);
    const sent = await dispatchAlert({
      dedupeKey: `price_threshold:${t.id}`,
      kind: 'price_threshold',
      severity: 'info',
      title: `${asset.symbol} crossed ${t.direction} ${t.price}`,
      body: `Latest price ${price} ${asset.currency} crossed the configured threshold. Data quality: ${series.quality}.`,
      assetId: asset.id,
    });
    if (sent.created) created++;
  }
  return created;
}

/**
 * Expire active signals whose evaluation horizon has long passed, so the feed
 * does not accumulate stale "active" setups forever.
 */
async function expireStaleSignals(): Promise<number> {
  const { STRATEGIES } = await import('@/lib/strategies');
  const { TIMEFRAME_MS } = await import('@/lib/market/types');
  const active = await listActiveActionable();
  let expired = 0;
  const now = Date.now();

  for (const s of active) {
    const strategy = STRATEGIES.find((x) => x.id === s.strategy_id);
    if (!strategy) continue;
    const horizonMs = strategy.evaluationHorizonBars * TIMEFRAME_MS[s.timeframe];
    // 3x the horizon is a generous ceiling: well past the point where the
    // original thesis could still be live.
    if (now - s.generated_at_ms > horizonMs * 3) {
      await updateSignalStatus(s.id, 'expired');
      expired++;
    }
  }
  return expired;
}
