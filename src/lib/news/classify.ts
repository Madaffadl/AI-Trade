import type { AssetRef } from '@/lib/market/types';

/**
 * Deterministic news classification.
 *
 * Keyword rules, not a model. The output is labelled `sentiment_src = 'keyword'`
 * so the UI can show that it is a crude heuristic rather than analysis. AI may
 * later add commentary, but it never overwrites these deterministic fields.
 *
 * A bullish-sounding headline is explicitly NOT treated as a buy reason
 * anywhere in this app: news influences context and risk, never the signal
 * action.
 */

export type EventCategory =
  | 'monetary_policy'
  | 'inflation_employment'
  | 'earnings'
  | 'regulation'
  | 'etf'
  | 'corporate_action'
  | 'geopolitics'
  | 'security_incident'
  | 'crypto_ecosystem'
  | 'other';

/**
 * Ordered rules - the FIRST match wins, so the more specific categories are
 * listed before the broad ones. Without that ordering a headline like
 * "Irish central bank fines Coinbase" matches "central bank" and is filed as
 * monetary policy rather than as a regulatory action.
 */
const CATEGORY_RULES: { category: EventCategory; terms: string[]; impact: 'high' | 'medium' | 'low' }[] = [
  { category: 'security_incident', terms: ['hack', 'exploit', 'breach', 'stolen funds', 'halts withdrawals', 'insolvency', 'bankruptcy'], impact: 'high' },
  { category: 'regulation', terms: ['fines', 'fined', 'penalty', 'sec charges', 'enforcement', 'lawsuit', 'regulator', 'regulation', 'ojk', 'compliance order', 'sanctions against'], impact: 'high' },
  { category: 'earnings', terms: ['earnings', 'quarterly results', 'revenue beat', 'revenue miss', 'guidance', 'eps'], impact: 'high' },
  { category: 'monetary_policy', terms: ['fomc', 'interest rate', 'rate decision', 'federal funds', 'monetary policy', 'central bank', 'bank indonesia', 'bi rate'], impact: 'high' },
  { category: 'inflation_employment', terms: ['cpi', 'inflation', 'nonfarm', 'payroll', 'unemployment', 'jobs report', 'pce'], impact: 'high' },
  { category: 'etf', terms: ['etf', 'exchange-traded fund', 'spot etf', 'inflows', 'outflows'], impact: 'medium' },
  { category: 'corporate_action', terms: ['8-k', 'merger', 'acquisition', 'dividend', 'stock split', 'buyback', 'ipo', 'rights issue'], impact: 'medium' },
  { category: 'geopolitics', terms: ['sanction', 'tariff', 'war', 'conflict', 'election', 'shutdown'], impact: 'medium' },
  { category: 'crypto_ecosystem', terms: ['hard fork', 'upgrade', 'mainnet', 'halving', 'staking', 'airdrop', 'layer 2'], impact: 'medium' },
];

const BULLISH = ['beats', 'surge', 'rally', 'record high', 'approval', 'approved', 'upgrade', 'inflows', 'strong demand', 'cuts rates', 'rate cut'];
const BEARISH = ['misses', 'plunge', 'slump', 'record low', 'rejected', 'downgrade', 'outflows', 'weak demand', 'hike', 'lawsuit', 'hack', 'halts', 'bankruptcy', 'probe'];

export interface Classification {
  category: EventCategory;
  impact: 'high' | 'medium' | 'low' | 'unknown';
  sentiment: 'bullish' | 'bearish' | 'neutral' | 'unclear';
  matchedTerms: string[];
}

export function classifyArticle(headline: string, body: string | null, feedCategory?: string): Classification {
  const text = `${headline} ${body ?? ''}`.toLowerCase();
  const matchedTerms: string[] = [];

  let category: EventCategory = (feedCategory as EventCategory) ?? 'other';
  let impact: Classification['impact'] = 'unknown';

  for (const rule of CATEGORY_RULES) {
    const hit = rule.terms.find((t) => text.includes(t));
    if (hit) {
      category = rule.category;
      impact = rule.impact;
      matchedTerms.push(hit);
      break;
    }
  }

  const bull = BULLISH.filter((t) => text.includes(t));
  const bear = BEARISH.filter((t) => text.includes(t));
  matchedTerms.push(...bull, ...bear);

  let sentiment: Classification['sentiment'] = 'neutral';
  if (bull.length > 0 && bear.length > 0) sentiment = 'unclear';
  else if (bull.length > 0) sentiment = 'bullish';
  else if (bear.length > 0) sentiment = 'bearish';
  else sentiment = 'neutral';

  return { category, impact, sentiment, matchedTerms };
}

/**
 * Match an article to watchlist assets by explicit, auditable token rules.
 * Deliberately conservative: a vague match is no match, because a wrong
 * association would attach irrelevant "evidence" to a signal.
 */
const CRYPTO_ALIASES: Record<string, string[]> = {
  BTC: ['bitcoin', 'btc'],
  ETH: ['ethereum', 'ether', 'eth'],
  SOL: ['solana', 'sol'],
  XRP: ['ripple', 'xrp'],
  BNB: ['binance coin', 'bnb'],
  ADA: ['cardano', 'ada'],
  DOGE: ['dogecoin', 'doge'],
};

export interface AssetMatch {
  assetId: string;
  relevance: number;
  reason: string;
}

export function matchAssets(headline: string, body: string | null, assets: readonly AssetRef[]): AssetMatch[] {
  const text = `${headline} ${body ?? ''}`.toLowerCase();
  const matches: AssetMatch[] = [];

  for (const asset of assets) {
    if (asset.assetClass === 'crypto') {
      const base = asset.symbol.replace(/(USDT|USD|BUSD|USDC)$/i, '').toUpperCase();
      const aliases = CRYPTO_ALIASES[base] ?? [base.toLowerCase()];
      const hit = aliases.find((a) => new RegExp(`\\b${escapeRegExp(a)}\\b`, 'i').test(text));
      if (hit) matches.push({ assetId: asset.id, relevance: hit.length > 3 ? 0.9 : 0.6, reason: `mentions "${hit}"` });
      continue;
    }

    // Equities: match the ticker as a standalone token, or the company name
    // without its legal suffix.
    const ticker = asset.symbol.toUpperCase();
    if (new RegExp(`\\b${escapeRegExp(ticker)}\\b`).test(`${headline} ${body ?? ''}`)) {
      matches.push({ assetId: asset.id, relevance: 0.8, reason: `mentions ticker ${ticker}` });
      continue;
    }
    const name = asset.displayName
      .replace(/\b(inc|corp|corporation|tbk|plc|ltd|limited|company|co)\b\.?/gi, '')
      .trim()
      .toLowerCase();
    if (name.length >= 4 && text.includes(name)) {
      matches.push({ assetId: asset.id, relevance: 0.7, reason: `mentions "${name}"` });
    }
  }
  return matches;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
