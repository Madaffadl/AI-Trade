import './_bootstrap';
import { db } from '../src/lib/db/driver';
import { ProviderError } from '../src/lib/providers/http';
import { allProviders } from '../src/lib/providers/registry';
import { newsProviders, resolveFeeds } from '../src/lib/providers/news/feeds';
import { aiProviderChain } from '../src/lib/providers/ai';
import { telegramSelfTest } from '../src/lib/notifications/telegram';
import { aiProviderMissing, features } from '../src/lib/config/env';

/**
 * Makes one real request per configured provider and reports exactly what came
 * back. This is how a claim like "the integration works" is substantiated:
 * nothing in the docs should say "verified" unless this script says so on your
 * machine, with your keys.
 */

/** Probe symbol per provider (Indodax is the only market-data provider). */
const SAMPLES: Record<string, { symbol: string; timeframe: '1h' | '1d'; label?: string }[]> = {
  indodax: [{ symbol: 'BTCIDR', timeframe: '1h' }],
};

function line(status: string, name: string, detail: string) {
  const icon = status === 'ok' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`[${icon}] ${name.padEnd(16)} ${detail}`);
}

async function main() {
  console.log('=== MARKET DATA PROVIDERS ===');
  for (const p of allProviders()) {
    const samples = SAMPLES[p.id];
    if (!samples) {
      line('skip', p.id, 'no sample symbol defined');
      continue;
    }

    for (const sample of samples) {
      const name = sample.label ? `${p.id}[${sample.label}]` : p.id;
      try {
        const started = Date.now();
        const series = await p.fetchCandles({ symbol: sample.symbol, timeframe: sample.timeframe, limit: 20 });
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

  console.log('\n=== AI PROVIDERS (fallback order) ===');
  const chain = aiProviderChain();
  if (chain.length === 0) {
    line('skip', 'ai', 'AI_PROVIDER=none — deterministic analysis only');
  }
  for (const ai of chain) {
    const missing = aiProviderMissing(ai.id) ?? (ai.model === '' ? `${ai.id.toUpperCase()}_MODEL is not set` : null);
    if (missing) {
      line('skip', ai.key, missing);
      continue;
    }
    const started = Date.now();
    try {
      // Generous budget: reasoning models think before answering, and a
      // 50-token cap would end the reply before the JSON starts.
      const res = await ai.complete({
        systemPrompt: 'Reply with a single JSON object and nothing else.',
        userPrompt: 'Return exactly: {"ok":true}',
        maxTokens: 1_024,
      });
      line('ok', ai.key, `responded in ${Date.now() - started}ms with ${res.text.trim().slice(0, 60)}`);
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), 'network');
      line('fail', ai.key, `${pe.kind}: ${pe.message}`);
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
  await (await db()).close();
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
