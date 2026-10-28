import './_bootstrap';
import { db, migrate } from '../src/lib/db/driver';
import { refreshUniverse } from '../src/lib/indodax/universe';
import { buildCostModel, roundTripCostPercent } from '../src/lib/plan/costs';
import { getTradingSettings } from '../src/lib/settings/trading';

/** Refresh the Indodax scan universe and print what was selected, and why the rest was not. */
async function main() {
  await migrate();
  const settings = await getTradingSettings();
  const u = await refreshUniverse();
  const rp = (n: number | null) => (n === null ? '—' : `Rp${Math.round(n).toLocaleString('id-ID')}`);

  console.log(`Indodax universe @ ${new Date(u.generatedAtMs).toISOString()}${u.pairsMetaStale ? '  (pair rules STALE)' : ''}`);
  console.log(
    `Filters: 24h volume >= ${rp(u.filters.minVolumeIdr)}, spread <= ${u.filters.maxSpreadPercent}%, max ${u.filters.universeSize} pairs\n`,
  );
  console.log('SYMBOL       24h VOLUME (IDR)   SPREAD   FEE    ROUND-TRIP COST   MIN ORDER   QTY STEP');
  for (const p of u.pairs) {
    const cost = roundTripCostPercent(
      buildCostModel({
        takerFeePercent: p.takerFeePercent,
        spreadPercent: p.spreadPercent,
        sellTaxPercent: settings.sellTaxPercent,
        otherFeePercentPerSide: settings.otherFeePercentPerSide,
      }),
    );
    console.log(
      `${p.symbol.padEnd(12)} ${rp(p.volumeIdr).padStart(18)}   ${p.spreadPercent.toFixed(2).padStart(5)}%  ${p.takerFeePercent
        .toFixed(2)
        .padStart(4)}%   ${cost.toFixed(2).padStart(13)}%   ${rp(p.minOrderIdr).padStart(9)}   ${p.quantityIncrement ?? '—'}`,
    );
  }
  console.log(`\nIncluded: ${u.pairs.length}. Excluded by reason:`, u.excludedCounts);
  await (await db()).close();
}

main().catch((err) => {
  console.error('Universe scan failed:', err);
  process.exit(1);
});
