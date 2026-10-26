import './_bootstrap';
import { db, migrate } from '../src/lib/db/driver';
import { addToWatchlist, ensureDefaultWatchlist, upsertAsset, upsertExchange } from '../src/lib/db/repo';
import { upsertStrategyDefinition } from '../src/lib/signals/repo';
import { STRATEGIES } from '../src/lib/strategies';

/**
 * Seeds reference data only: exchanges, a small starting watchlist, and the
 * strategy definitions. It seeds NO market data - prices are only ever written
 * by a real provider fetch.
 */
async function main() {
  await migrate();

  await upsertExchange({
    id: 'BINANCE',
    name: 'Binance Spot',
    asset_class: 'crypto',
    country: null,
    timezone: 'UTC',
    continuous: true,
  });
  await upsertExchange({
    id: 'COINBASE',
    name: 'Coinbase Advanced Trade',
    asset_class: 'crypto',
    country: 'US',
    timezone: 'UTC',
    continuous: true,
  });
  await upsertExchange({
    id: 'INDODAX',
    name: 'Indodax (Indonesian crypto exchange, IDR pairs)',
    asset_class: 'crypto',
    country: 'ID',
    timezone: 'Asia/Jakarta',
    continuous: true,
  });
  await upsertExchange({
    id: 'US',
    name: 'US equities (NASDAQ/NYSE/AMEX)',
    asset_class: 'stock',
    country: 'US',
    timezone: 'America/New_York',
    continuous: false,
  });
  await upsertExchange({
    id: 'IDX',
    name: 'Indonesia Stock Exchange (IDX/BEI)',
    asset_class: 'stock',
    country: 'ID',
    timezone: 'Asia/Jakarta',
    continuous: false,
  });

  const seeds = [
    { symbol: 'BTCUSDT', displayName: 'Bitcoin / Tether', assetClass: 'crypto' as const, exchangeId: 'BINANCE', currency: 'USDT', style: 'swing' },
    { symbol: 'ETHUSDT', displayName: 'Ethereum / Tether', assetClass: 'crypto' as const, exchangeId: 'BINANCE', currency: 'USDT', style: 'swing' },
    { symbol: 'SOLUSDT', displayName: 'Solana / Tether', assetClass: 'crypto' as const, exchangeId: 'BINANCE', currency: 'USDT', style: 'day' },
    { symbol: 'BTCIDR', displayName: 'Bitcoin / Rupiah (Indodax)', assetClass: 'crypto' as const, exchangeId: 'INDODAX', currency: 'IDR', style: 'swing' },
    { symbol: 'ETHIDR', displayName: 'Ethereum / Rupiah (Indodax)', assetClass: 'crypto' as const, exchangeId: 'INDODAX', currency: 'IDR', style: 'swing' },
    { symbol: 'AAPL', displayName: 'Apple Inc.', assetClass: 'stock' as const, exchangeId: 'US', currency: 'USD', style: 'swing' },
    { symbol: 'MSFT', displayName: 'Microsoft Corporation', assetClass: 'stock' as const, exchangeId: 'US', currency: 'USD', style: 'position' },
    { symbol: 'BBCA', displayName: 'Bank Central Asia Tbk', assetClass: 'stock' as const, exchangeId: 'IDX', currency: 'IDR', style: 'swing' },
  ];

  const watchlistId = await ensureDefaultWatchlist();
  for (const s of seeds) {
    const asset = await upsertAsset({
      symbol: s.symbol,
      displayName: s.displayName,
      assetClass: s.assetClass,
      exchangeId: s.exchangeId,
      currency: s.currency,
      tickSize: null,
      lotSize: null,
      minNotional: null,
    });
    await addToWatchlist(watchlistId, asset.id, s.style);
    console.log(`seeded ${s.exchangeId}:${s.symbol}`);
  }

  for (const strategy of STRATEGIES) {
    await upsertStrategyDefinition({
      id: strategy.id,
      version: strategy.version,
      name: strategy.name,
      description: strategy.description,
      assetClasses: strategy.assetClasses,
      timeframes: strategy.timeframes,
      parameters: strategy.parameters,
      warmupBars: strategy.warmupBars,
    });
    console.log(`registered strategy ${strategy.id}@${strategy.version}`);
  }

  console.log('\nSeed complete. Reference data only - no prices were written.');
  await (await db()).close();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
