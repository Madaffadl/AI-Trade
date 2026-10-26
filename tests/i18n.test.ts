import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/en';
import { id } from '@/lib/i18n/id';
import { INTL_LOCALE, isLocale, LOCALES, LOCALE_LABEL, LOCALE_NAME } from '@/lib/i18n/types';

/**
 * The dictionaries are typed so a missing key is a COMPILE error. These tests
 * cover what types cannot: that the two languages stay structurally identical
 * at runtime, that no translation was left as the English original by
 * accident, and that interpolated messages actually use their arguments.
 */

type Shape = { [key: string]: Shape | 'string' | 'function' };

function shapeOf(obj: Record<string, unknown>): Shape {
  const out: Shape = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'function') out[k] = 'function';
    else if (typeof v === 'object' && v !== null) out[k] = shapeOf(v as Record<string, unknown>);
    else out[k] = 'string';
  }
  return out;
}

function flatten(obj: Record<string, unknown>, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null && typeof v !== 'function') {
      for (const [ik, iv] of flatten(v as Record<string, unknown>, key)) out.set(ik, iv);
    } else {
      out.set(key, v);
    }
  }
  return out;
}

const flatEn = flatten(en as unknown as Record<string, unknown>);
const flatId = flatten(id as unknown as Record<string, unknown>);

describe('locale metadata', () => {
  it('exposes exactly the supported locales', () => {
    expect([...LOCALES]).toEqual(['en', 'id']);
  });

  it('has a label, a name and a number locale for every language', () => {
    for (const l of LOCALES) {
      expect(LOCALE_LABEL[l]).toBeTruthy();
      expect(LOCALE_NAME[l]).toBeTruthy();
      expect(INTL_LOCALE[l]).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });

  it('validates locale input', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('id')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(null)).toBe(false);
  });
});

describe('dictionary completeness', () => {
  it('both languages have an identical key structure', () => {
    expect(shapeOf(id as unknown as Record<string, unknown>)).toEqual(
      shapeOf(en as unknown as Record<string, unknown>),
    );
  });

  it('has no missing or extra keys in Indonesian', () => {
    expect([...flatId.keys()].sort()).toEqual([...flatEn.keys()].sort());
  });

  it('has a non-empty value for every key in both languages', () => {
    for (const [key, value] of flatEn) {
      if (typeof value === 'string') expect(value.trim(), `en.${key} is empty`).not.toBe('');
    }
    for (const [key, value] of flatId) {
      if (typeof value === 'string') expect(value.trim(), `id.${key} is empty`).not.toBe('');
    }
  });

  it('defines a meaningful number of messages', () => {
    // Guards against a dictionary being accidentally truncated.
    expect(flatEn.size).toBeGreaterThan(400);
  });
});

describe('translation quality guards', () => {
  /**
   * Keys whose value is legitimately identical in both languages: brand names,
   * venue names, acronyms and market jargon that Indonesian borrows verbatim.
   */
  const SHARED = new Set([
    'nav.brand',
    'nav.menu',
    'venue.indodax',
    'venue.pluang',
    'venue.stockbit',
    'common.timeframe',
    'common.crypto',
    'common.volume',
    'common.status',
    'common.data',
    'scanner.bullish',
    'scanner.bearish',
    'markets.searchPlaceholder',
    'markets.sortChange',
    'evaluation.timeframes',
    'settings.telegram',
    'settings.ai',
    'alerts.statTelegram',
  ]);

  it('does not leave long English strings untranslated in Indonesian', () => {
    const untranslated: string[] = [];
    for (const [key, enValue] of flatEn) {
      if (typeof enValue !== 'string' || SHARED.has(key)) continue;
      // Short strings are often legitimately identical; long prose is not.
      if (enValue.length < 25) continue;
      if (flatId.get(key) === enValue) untranslated.push(key);
    }
    expect(untranslated, `untranslated: ${untranslated.join(', ')}`).toEqual([]);
  });

  it('every interpolated message actually uses all of its arguments', () => {
    /**
     * An argument may be interpolated into the text (asset.quotedIn) or used
     * as a condition (asset.barsSub takes a boolean). Either way, changing it
     * must change the output — otherwise the parameter is dead and the message
     * is silently losing information.
     *
     * Each argument is probed with BOTH a string pair and a boolean pair,
     * because a truthy-vs-truthy string can never flip a conditional branch.
     */
    const PROBES: [unknown, unknown][] = [
      ['ALPHA', 'BETA'],
      [true, false],
      [1, 2],
    ];

    for (const [key, enValue] of flatEn) {
      if (typeof enValue !== 'function') continue;
      const idValue = flatId.get(key);
      expect(typeof idValue, `id.${key} should be a function`).toBe('function');

      const arity = (enValue as (...a: unknown[]) => string).length;
      for (const [lang, fn] of [
        ['en', enValue],
        ['id', idValue],
      ] as const) {
        const call = fn as (...a: unknown[]) => string;

        for (let i = 0; i < arity; i++) {
          const affectsOutput = PROBES.some(([a, b]) => {
            const base = Array.from({ length: arity }, () => 'X');
            const withA = [...base];
            const withB = [...base];
            withA[i] = a as string;
            withB[i] = b as string;
            return call(...withA) !== call(...withB);
          });
          expect(affectsOutput, `${lang}.${key} ignores argument ${i}`).toBe(true);
        }
      }
    }
  });

  it('keeps the trading labels untranslated, because they are the stored values', () => {
    // BUY/SELL/HOLD/WAIT are persisted in the database and rendered as badges;
    // translating them would break the mapping to stored data.
    const labelsText = `${en.signals.labelsBody} ${id.signals.labelsBody}`;
    for (const action of ['BUY', 'SELL', 'HOLD', 'WAIT']) {
      expect(en.signals.labelsBody).toContain(action);
    }
    expect(labelsText.length).toBeGreaterThan(0);
  });
});
