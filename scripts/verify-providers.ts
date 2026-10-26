import './_bootstrap';
import { db } from '../src/lib/db/driver';
import { ProviderError } from '../src/lib/providers/http';
import { allProviders } from '../src/lib/providers/registry';
import { newsProviders, resolveFeeds } from '../src/lib/providers/news/feeds';
import { aiProvider } from '../src/lib/providers/ai';
import { telegramSelfTest } from '../src/lib/notifications/telegram';
import { features, resetEnvCache } from '../src/lib/config/env';

/**
 * Makes one real request per configured provider and reports exactly what came
 * back. This is how a claim like "the integration works" is substantiated:
 * nothing in the docs should say "verified" unless this script says so on your
 * machine, with your keys.
 */

/**
 * One or more probe symbols per provider. Twelve Data and Yahoo are probed with
 * an IDX symbol specifically, because "does my plan / my network actually
 * return Indonesian data?" is the open question this script exists to answer.
 */
const SAMPLES: Record<string, { symbol: string; timeframe: '1h' | '1d'; label?: string }[]> = {
  binance: [{ symbol: 'BTCUSDT', timeframe: '1h' }],
  coinbase: [{ symbol: 'BTC-USD', timeframe: '1h' }],
  // Indodax is used in production for the IDR pairs on the watchlist, so it
  // must be verifiable. It had no sample, which reported as "skip" and made a
  // live dependency look untested.
  indodax: [{ symbol: 'BTCIDR', timeframe: '1h' }],
  nasdaq: [{ symbol: 'AAPL', timeframe: '1d' }],
  alphavantage: [{ symbol: 'IBM', timeframe: '1d' }],
  twelvedata: [
    { symbol: 'AAPL', timeframe: '1d', label: 'US' },
    { symbol: 'BBCA:IDX', timeframe: '1d', label: 'IDX' },
  ],
  yahoo: [{ symbol: 'BBCA.JK', timeframe: '1d', label: 'IDX' }],
};

/**
 * Call a disabled provider by temporarily setting the flag that gates it, so
 * `--probe` reports what the live API actually returns rather than the
 * configuration refusal.
 */
async function probeFetch(
  p: ReturnType<typeof allProviders>[number],
  sample: { symbol: string; timeframe: '1h' | '1d' },
) {
  const previous = process.env.ENABLE_YAHOO_PROVIDER;
  if (p.id === 'yahoo') process.env.ENABLE_YAHOO_PROVIDER = 'true';
  resetEnvCache();
  try {
    return await p.fetchCandles({ symbol: sample.symbol, timeframe: sample.timeframe, limit: 20 });
  } finally {
    if (p.id === 'yahoo') {
      if (previous === undefined) delete process.env.ENABLE_YAHOO_PROVIDER;
      else process.env.ENABLE_YAHOO_PROVIDER = previous;
    }
    resetEnvCache();
  }
}

function line(status: string, name: string, detail: string) {
  const icon = status === 'ok' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`[${icon}] ${name.padEnd(16)} ${detail}`);
}

async function main() {
  // `--probe <id>` tests a provider that is implemented but disabled, without
  // permanently enabling it. This matters most for Yahoo: its rate limiting is
  // per IP, so it can fail from one network and work from another. Testing it
  // is the fastest way to find out whether IDX data is available to you.
  const probeArg = process.argv.indexOf('--probe');
  const probe = probeArg !== -1 ? process.argv[probeArg + 1] : undefined;
  if (probe) console.log(`(probing disabled provider "${probe}" on request)\n`);

  console.log('=== MARKET DATA PROVIDERS ===');
  for (const p of allProviders()) {
    const samples = SAMPLES[p.id];
    const probing = probe === p.id;
    if (!p.isConfigured() && !probing) {
      line('skip', p.id, p.requiresKey ? 'no API key configured' : `disabled in configuration (test it with: npm run providers:verify -- --probe ${p.id})`);
      continue;
    }
    if (probing && p.requiresKey && !p.isConfigured()) {
      line('skip', p.id, 'cannot probe: this provider requires an API key');
      continue;
    }
    if (!samples) {
      line('skip', p.id, 'no sample symbol defined');
      continue;
    }

    for (const sample of samples) {
      const name = sample.label ? `${p.id}[${sample.label}]` : p.id;
      try {
        const started = Date.now();
        // A probed provider is bypassed at the config gate, so call it directly.
        const series =
          probing && !p.isConfigured()
            ? await probeFetch(p, sample)
            : await p.fetchCandles({ symbol: sample.symbol, timeframe: sample.timeframe, limit: 20 });
        const closed = series.candles.filter((c) => !c.isPartial);
        const latest = closed.at(-1);
        line(
          'ok',
          name,
          `${sample.symbol} ${sample.timeframe}: ${series.candles.length} bars in ${Date.now() - started}ms · ` +
            `last closed ${latest ? new Date(latest.openTimeMs).toISOString() : 'n/a'} close=${latest?.close ?? 'n/a'} ` +
            `volume=${latest?.volume === null ? 'NOT PROVIDED' : latest?.volume}`,
        );
        for (const note of series.notes) console.log(`       note: ${note}`);
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError(String(err), 'network');
        line('fail', name, `${pe.kind}: ${pe.message}`);
      }
    }
  }

  console.log('\n=== NEWS FEEDS ===');
  for (const f of resolveFeeds()) {
    if (!f.available) line('skip', f.feed.id, f.reason ?? 'unavailable');
  }
  for (const provider of newsProviders()) {
    try {
      const items = await provider.fetchLatest(5);
      const first = items[0];
      line(
        'ok',
        provider.id,
        `${items.length} items · latest "${first?.headline.slice(0, 60) ?? 'none'}" published ${
          first?.publishedAtMs ? new Date(first.publishedAtMs).toISOString() : 'unknown'
        }`,
      );
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), 'network');
      line('fail', provider.id, `${pe.kind}: ${pe.message}`);
    }
  }

  console.log('\n=== AI PROVIDER ===');
  const ai = aiProvider();
  if (!ai) {
    line('skip', 'ai', 'AI_PROVIDER=none — deterministic analysis only');
  } else if (!ai.isConfigured()) {
    line('skip', ai.id, 'no API key configured');
  } else {
    try {
      const res = await ai.complete({
        systemPrompt: 'Reply with a single JSON object and nothing else.',
        userPrompt: 'Return exactly: {"ok":true}',
        maxTokens: 50,
      });
      line('ok', ai.id, `model ${res.model} responded with ${res.text.trim().slice(0, 60)}`);
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), 'network');
      line('fail', ai.id, `${pe.kind}: ${pe.message}`);
    }
  }

  console.log('\n=== NOTIFICATIONS ===');
  if (!features().telegramEnabled) {
    line('skip', 'telegram', 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured');
  } else {
    const result = await telegramSelfTest();
    line(result.ok ? 'ok' : 'fail', 'telegram', result.detail);
  }

  console.log(
    '\nPASS means a real request succeeded just now. SKIP means not configured. FAIL means the integration is NOT working.',
  );
  if (!probe) {
    console.log(
      'To test a disabled provider without enabling it (e.g. Yahoo for IDX data):\n' +
        '  npm run providers:verify -- --probe yahoo',
    );
  }
  await (await db()).close();
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
