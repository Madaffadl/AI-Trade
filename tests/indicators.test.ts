import { describe, expect, it } from 'vitest';
import {
  atr,
  bollinger,
  donchian,
  ema,
  last,
  macd,
  pctChange,
  rsi,
  sma,
  swingLevels,
  trueRange,
  volumeAnalysis,
} from '@/lib/indicators';

/**
 * Reference dataset from Wilder's RSI worked example as published by
 * StockCharts. It is the standard fixture used to validate RSI(14)
 * implementations, so it catches the usual error of applying simple averaging
 * instead of Wilder's smoothing.
 */
const WILDER_CLOSES = [
  44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328,
  45.614, 46.282, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515,
  45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5668, 43.4219, 42.6628, 43.1314,
];

describe('sma', () => {
  it('matches a brute-force mean over the trailing window', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = sma(values, 3);
    for (let i = 0; i < values.length; i++) {
      if (i < 2) {
        expect(result[i]).toBeNull();
      } else {
        const expected = (values[i]! + values[i - 1]! + values[i - 2]!) / 3;
        expect(result[i]).toBeCloseTo(expected, 12);
      }
    }
  });

  it('returns all nulls when there is less data than the period', () => {
    expect(sma([1, 2], 5).every((v) => v === null)).toBe(true);
  });

  it('rejects a non-positive period', () => {
    expect(() => sma([1, 2, 3], 0)).toThrow(/positive integer/);
  });

  it('does not mutate its input', () => {
    const input = [1, 2, 3, 4];
    const copy = [...input];
    sma(input, 2);
    expect(input).toEqual(copy);
  });
});

describe('ema', () => {
  it('seeds with the SMA of the first period values', () => {
    const values = [1, 2, 3, 4, 5, 6];
    const result = ema(values, 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBeCloseTo(2, 12); // (1+2+3)/3
    // k = 2/(3+1) = 0.5 -> 4*0.5 + 2*0.5 = 3
    expect(result[3]).toBeCloseTo(3, 12);
    expect(result[4]).toBeCloseTo(4, 12);
  });

  it('converges towards a constant series', () => {
    const flat = new Array(100).fill(42);
    expect(last(ema(flat, 10))).toBeCloseTo(42, 10);
  });
});

describe('rsi', () => {
  it('reproduces the published Wilder RSI(14) values', () => {
    const result = rsi(WILDER_CLOSES, 14);
    // First computable value sits at index 14 and is ~70.53 in the reference.
    expect(result[13]).toBeNull();
    expect(result[14]).toBeCloseTo(70.53, 1);
    expect(result[15]).toBeCloseTo(66.32, 1);
    expect(result[16]).toBeCloseTo(66.55, 1);
  });

  it('is 100 when the window contains no losses', () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(last(rsi(rising, 14))).toBeCloseTo(100, 6);
  });

  it('is 0 when the window contains no gains', () => {
    const falling = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(last(rsi(falling, 14))).toBeCloseTo(0, 6);
  });

  it('stays within 0..100 for noisy input', () => {
    const noisy = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i) * 5 + (i % 7));
    for (const v of rsi(noisy, 14)) {
      if (v !== null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('macd', () => {
  it('equals fast EMA minus slow EMA', () => {
    const values = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const { macd: line, signal, histogram } = macd(values, 12, 26, 9);
    const fast = ema(values, 12);
    const slow = ema(values, 26);
    for (let i = 0; i < values.length; i++) {
      const f = fast[i];
      const s = slow[i];
      if (f === null || f === undefined || s === null || s === undefined) expect(line[i]).toBeNull();
      else expect(line[i]).toBeCloseTo(f - s, 10);
    }
    // histogram = macd - signal wherever both are defined
    for (let i = 0; i < values.length; i++) {
      const m = line[i];
      const s = signal[i];
      if (m !== null && m !== undefined && s !== null && s !== undefined) {
        expect(histogram[i]).toBeCloseTo(m - s, 10);
      } else {
        expect(histogram[i]).toBeNull();
      }
    }
  });

  it('produces no signal line before the macd line has 9 values', () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + i);
    const { signal } = macd(values, 12, 26, 9);
    // macd first defined at index 25; signal needs 9 more -> index 33 > length
    expect(signal.every((v) => v === null)).toBe(true);
  });
});

describe('trueRange and atr', () => {
  const bars = [
    { high: 10, low: 8, close: 9 },
    { high: 11, low: 9, close: 10.5 },
    { high: 10.6, low: 9.5, close: 10 },
    { high: 14, low: 13, close: 13.5 }, // gap up: TR must use the previous close
  ];

  it('uses the previous close for gaps', () => {
    const tr = trueRange(bars);
    expect(tr[0]).toBeNull();
    expect(tr[1]).toBeCloseTo(2, 10); // max(11-9=2, |11-9|=2, |9-9|=0)
    // Gap: high-low = 1, but |14 - 10| = 4 dominates
    expect(tr[3]).toBeCloseTo(4, 10);
  });

  it('is null until the period has elapsed and positive afterwards', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      high: 100 + i + 1,
      low: 100 + i - 1,
      close: 100 + i,
    }));
    const a = atr(many, 14);
    expect(a[13]).toBeNull();
    expect(a[14]).not.toBeNull();
    expect(a[14]!).toBeGreaterThan(0);
  });
});

describe('bollinger', () => {
  it('uses the population standard deviation', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const { middle, upper, lower } = bollinger(values, 8, 2);
    // Classic textbook set: mean 5, population sd 2.
    expect(middle[7]).toBeCloseTo(5, 10);
    expect(upper[7]).toBeCloseTo(9, 10);
    expect(lower[7]).toBeCloseTo(1, 10);
  });

  it('reports percentB of 1 at the upper band and 0 at the lower band', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const { percentB, upper, lower } = bollinger(values, 8, 2);
    expect(percentB[7]).toBeCloseTo((9 - lower[7]!) / (upper[7]! - lower[7]!), 10);
  });

  it('collapses to the mean for a constant series', () => {
    const flat = new Array(30).fill(10);
    const { upper, lower, bandwidth } = bollinger(flat, 20, 2);
    expect(upper[29]).toBeCloseTo(10, 10);
    expect(lower[29]).toBeCloseTo(10, 10);
    expect(bandwidth[29]).toBeCloseTo(0, 10);
  });
});

describe('volumeAnalysis', () => {
  it('reports unavailable when the provider supplies no volume', () => {
    const result = volumeAnalysis(new Array(50).fill(null), 20);
    expect(result.unavailable).toBe(true);
    expect(result.relativeVolume.every((v) => v === null)).toBe(true);
  });

  it('never treats a missing volume as zero', () => {
    const volumes: (number | null)[] = new Array(40).fill(1000);
    volumes[39] = null;
    const result = volumeAnalysis(volumes, 20);
    expect(result.unavailable).toBe(false);
    expect(result.relativeVolume[39]).toBeNull();
  });

  it('computes relative volume against the trailing average', () => {
    const volumes: (number | null)[] = new Array(40).fill(100);
    volumes[39] = 300;
    const result = volumeAnalysis(volumes, 20);
    expect(result.relativeVolume[39]).toBeGreaterThan(2);
  });
});

describe('swingLevels', () => {
  it('never confirms a pivot inside the trailing lookback window', () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({ high: 100 + i, low: 90 + i }));
    const { highs } = swingLevels(bars, 5);
    for (const p of highs) {
      expect(p.index).toBeLessThanOrEqual(bars.length - 1 - 5);
    }
  });

  it('finds a clear peak and trough', () => {
    const base = Array.from({ length: 21 }, () => ({ high: 100, low: 95 }));
    base[10] = { high: 120, low: 95 };
    const { highs, resistance } = swingLevels(base, 5, 100);
    expect(highs.map((h) => h.index)).toContain(10);
    expect(resistance).toBe(120);
  });
});

describe('donchian', () => {
  it('excludes the current bar from the channel', () => {
    const bars = Array.from({ length: 10 }, (_, i) => ({ high: 10 + i, low: i }));
    const { upper } = donchian(bars, 3);
    // At index 5 the channel covers bars 2,3,4 -> highs 12,13,14
    expect(upper[5]).toBe(14);
  });
});

describe('pctChange', () => {
  it('guards against a zero base', () => {
    expect(pctChange(0, 10)).toBeNull();
    expect(pctChange(100, 110)).toBeCloseTo(10, 10);
    expect(pctChange(100, 90)).toBeCloseTo(-10, 10);
  });
});
