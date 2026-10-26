import { describe, expect, it } from 'vitest';
import { bandOf, reasonCodes, scoreCandidate } from '@/lib/markets/recommend';

/**
 * Watchlist candidate ranking.
 *
 * The thing that matters most here is NOT the exact numbers — it is that the
 * ranking cannot become a disguised profit prediction. These tests pin that
 * property directly.
 */

describe('tradability score ignores price direction', () => {
  it('depends only on turnover and trade count', () => {
    // Same liquidity and activity, opposite price moves -> identical score.
    // The function has no parameter for price change at all, which is the
    // point: a future refactor cannot sneak one in without failing to compile.
    expect(scoreCandidate(10_000_000, 100_000)).toBe(scoreCandidate(10_000_000, 100_000));
  });

  it('rises with turnover', () => {
    expect(scoreCandidate(100_000_000, 50_000)).toBeGreaterThan(scoreCandidate(1_000_000, 50_000));
  });

  it('rises with trade count at equal turnover', () => {
    expect(scoreCandidate(10_000_000, 500_000)).toBeGreaterThan(scoreCandidate(10_000_000, 10));
  });

  it('stays inside 0..1 even for absurd inputs', () => {
    for (const v of [0, 1, 1e15]) {
      const s = scoreCandidate(v, 1e9);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('does not crash when the venue publishes no trade count', () => {
    expect(scoreCandidate(5_000_000, null)).toBeGreaterThan(0);
  });
});

describe('banding separates liquid from speculative', () => {
  it('calls a high-turnover, contained instrument liquid', () => {
    expect(bandOf(50_000_000, 4)).toBe('liquid');
  });

  it('calls a high-turnover, wide-ranging instrument active', () => {
    expect(bandOf(50_000_000, 25)).toBe('active');
  });

  it('calls a thinner but tradeable instrument speculative', () => {
    // This is the band the small, speculative names land in.
    expect(bandOf(400_000, 20)).toBe('speculative');
  });

  it('calls an illiquid instrument thin', () => {
    expect(bandOf(1_000, 50)).toBe('thin');
  });
});

describe('reason codes always explain the ranking', () => {
  it('reports a liquidity level for every instrument', () => {
    const liquidity = ['deepLiquidity', 'tradeableLiquidity', 'thinLiquidity'];
    for (const v of [10_000_000, 1_000_000, 100]) {
      expect(reasonCodes(v, 5, 1000).some((c) => liquidity.includes(c))).toBe(true);
    }
  });

  it('reports a range level for every instrument', () => {
    const range = ['wideRange', 'moderateRange', 'narrowRange'];
    for (const r of [30, 5, 0.1]) {
      expect(reasonCodes(1_000_000, r, 1000).some((c) => range.includes(c))).toBe(true);
    }
  });

  it('says so explicitly when the venue publishes no trade count', () => {
    // Indodax does not publish one; silently omitting it would overstate
    // how much is known about the instrument.
    expect(reasonCodes(1_000_000, 5, null)).toContain('tradeCountUnavailable');
  });

  it('flags genuinely thin liquidity rather than staying quiet', () => {
    expect(reasonCodes(1_000, 5, 10)).toContain('thinLiquidity');
  });
});
