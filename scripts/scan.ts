import './_bootstrap';
import { db, migrate } from '../src/lib/db/driver';
import { runRefresh } from '../src/lib/jobs/refresh';
import { listSimTrades } from '../src/lib/sim/repo';
import { simAccount } from '../src/lib/sim/service';

/**
 * One full Indodax scan, printed: the decision, the best plan in full, the
 * other candidates, and why every other pair produced nothing.
 */
const rp = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `Rp${Math.round(n).toLocaleString('id-ID')}`;
const price = (n: number) => (n >= 100 ? rp(n) : `Rp${n.toPrecision(6)}`);
const wib = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ') + ' WIB';

async function main() {
  await migrate();
  // Waits for the worker's one-minute live check if it is mid-run.
  const cycle = await runRefresh({ waitMs: 30_000 });
  const r = cycle.scan!;
  const s = r.summary;
  console.log(`\n=== KEPUTUSAN: ${cycle.decision ?? r.decision} ===  (scan ${(s.durationMs / 1000).toFixed(0)}s, ${r.universe?.pairs.length ?? 0} pair)`);
  console.log(
    `Modal pakai ${rp(s.usableCapitalIdr)} · kas ${rp(s.cashAvailableIdr)} · posisi ${s.openPositions}/${s.maxOpenPositions} · rugi hari ini ${s.dailyLossPercent.toFixed(2)}%/${s.maxDailyLossPercent}%`,
  );
  if (r.error) console.log(`Error: ${r.error}`);
  console.log('State counts:', s.stateCounts);

  for (const [i, setup] of r.ranked.slice(0, 5).entries()) {
    const p = setup.plan;
    console.log(`\n#${i + 1} ${setup.state} (${setup.state_reason}) — ${p.symbol} ${p.timeframe} · ${p.strategyId} · skor ${setup.score.toFixed(3)} · ${setup.validation}`);
    if (p.trigger) console.log(`   Pemicu: candle ${p.timeframe} ditutup di atas ${price(p.trigger.price)}${p.trigger.requiresVolume ? ' dengan volume ≥1,5x' : ''}`);
    console.log(`   Entry ${price(p.entry.planned)} (maks ${price(p.entry.max)}) · Stop ${price(p.stopLoss)} (-${p.outcome.stopDistancePercent.toFixed(2)}%) · TP1 ${price(p.takeProfit1)} (+${p.outcome.tp1DistancePercent.toFixed(2)}%)${p.takeProfit2 ? ` · TP2 ${price(p.takeProfit2)}` : ''}`);
    console.log(`   Beli ${p.sizing.quantity} unit ≈ ${rp(p.sizing.notionalIdr)} (dibatasi: ${p.sizing.limitedBy}) · rugi jika stop ${rp(p.sizing.lossAtStopIdr)} (${p.sizing.effectiveRiskPercent.toFixed(2)}% modal) · untung bersih TP1 ${rp(p.outcome.netProfitTp1Idr)}`);
    console.log(`   R:R bersih ${p.outcome.netRiskReward.toFixed(2)} (kotor ${p.outcome.grossRiskReward.toFixed(2)}) · biaya bolak-balik ${p.costs.roundTripPercent.toFixed(2)}% · tahan maks ${p.holding.horizonBars} bar (${(p.holding.horizonMs / 3_600_000).toFixed(0)} jam) · berlaku s/d ${wib(p.expiresAtMs)}`);
    console.log(`   Tren ${p.contextTimeframe}: ${p.context.up ? 'naik' : 'tidak naik'} (kekuatan ${p.context.strength.toFixed(2)})`);
  }

  const notEligible = (await (await db()).all<{ plan_json: string; state_reason: string }>(
    `SELECT plan_json, state_reason FROM trade_setups WHERE last_scan_id = ? AND state = 'NOT_ELIGIBLE'`,
    [r.scanId],
  )).map((row) => JSON.parse(row.plan_json));
  if (notEligible.length) {
    console.log(`\nSetup terdeteksi tapi TIDAK LAYAK (${notEligible.length}):`);
    for (const p of notEligible) {
      console.log(
        `   ${p.symbol} ${p.timeframe} ${p.strategyId} [${p.kind}]: ${p.eligibility.failures.join(', ')} · R:R bersih ${p.outcome.netRiskReward.toFixed(2)} · TP1 +${p.outcome.tp1DistancePercent.toFixed(2)}% vs biaya ${p.costs.roundTripPercent.toFixed(2)}% · tren ${p.contextTimeframe} ${p.context.up ? 'naik' : 'tidak naik'}`,
      );
    }
  }

  const acct = await simAccount();
  const active = await listSimTrades(['pending_entry', 'open']);
  console.log(
    `\nSimulasi: ekuitas ${rp(acct.equityIdr)} (modal awal ${rp(acct.startCapitalIdr)}) · terealisasi ${rp(acct.realizedIdr)} · ` +
      `${acct.openCount} terbuka, ${acct.pendingCount} menunggu · diperbarui ${cycle.simUpdated}, dibuka otomatis ${cycle.simOpened}`,
  );
  for (const t of active) console.log(`   ${t.symbol} ${t.timeframe} [${t.mode}/${t.entry_kind}] ${t.status} entry ${t.entry_price ?? '—'} stop ${t.stop_loss} tp1 ${t.take_profit_1}`);
  console.log(`Notifikasi baru: ${cycle.alertsCreated}`);

  const noSetup = s.pairs.filter((p) => p.status !== 'setup');
  console.log(`\nTanpa setup / tanpa data (${noSetup.length} pair x timeframe):`);
  for (const p of noSetup.slice(0, 12)) console.log(`   ${p.symbol} ${p.timeframe} [${p.status}] ${p.detail.slice(0, 170)}`);
  if (noSetup.length > 12) console.log(`   ... dan ${noSetup.length - 12} lainnya`);
  await (await db()).close();
}

main().catch((err) => {
  console.error('Scan failed:', err);
  process.exit(1);
});
