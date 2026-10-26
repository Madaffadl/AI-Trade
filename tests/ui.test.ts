import { describe, expect, it } from 'vitest';
import { directionGlyph, formatIndicator, formatPercentSigned } from '@/lib/format';

/**
 * Presentation rules that carry accessibility weight.
 *
 * The up/down palette was measured at deuteranopia ΔE 8.2 — above the ≥8
 * target, but these tests pin the rule that colour is never the ONLY cue, so a
 * future refactor cannot quietly drop the glyph and leave colourblind readers
 * with no signal.
 */

describe('direction is encoded without colour', () => {
  it('marks a rise and a fall with distinct glyphs', () => {
    expect(directionGlyph(1.2)).toBe('▲');
    expect(directionGlyph(-1.2)).toBe('▼');
  });

  it('emits no glyph for zero or missing values', () => {
    expect(directionGlyph(0)).toBe('');
    expect(directionGlyph(null)).toBe('');
    expect(directionGlyph(undefined)).toBe('');
    expect(directionGlyph(Number.NaN)).toBe('');
  });

  it('carries BOTH a glyph and a sign, so neither alone is load-bearing', () => {
    expect(formatPercentSigned(1.32)).toBe('▲ +1.32%');
    expect(formatPercentSigned(-2.08)).toBe('▼ -2.08%');
  });

  it('still renders a missing value as an em dash rather than a bare glyph', () => {
    expect(formatPercentSigned(null)).toBe('—');
  });

  it('shows zero without implying a direction', () => {
    expect(formatPercentSigned(0)).toBe('+0.00%');
  });
});

describe('indicator precision follows magnitude', () => {
  it('drops decimals on large values instead of printing noise', () => {
    // An IDR ATR in the millions does not need four decimal places.
    expect(formatIndicator(32_511_503.3871)).toBe('32,511,503');
  });

  it('keeps precision on small values instead of erasing them', () => {
    expect(formatIndicator(-0.0042)).toBe('-0.0042');
    expect(formatIndicator(0.000123)).toBe('0.000123');
  });

  it('uses a middle precision for ordinary magnitudes', () => {
    expect(formatIndicator(60.04)).toBe('60.04');
    // Trailing zeros are dropped - precision is capped, not padded.
    expect(formatIndicator(2.5)).toBe('2.5');
  });

  it('returns an em dash for missing or non-finite values', () => {
    expect(formatIndicator(null)).toBe('—');
    expect(formatIndicator(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
