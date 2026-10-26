/**
 * Client-safe position types.
 *
 * Kept separate from repo.ts, which imports `server-only`: the position forms
 * are client components and need the venue list, but must never pull the
 * database layer into the browser bundle.
 */

export const VENUES = ['indodax', 'pluang', 'stockbit', 'other'] as const;
export type Venue = (typeof VENUES)[number];

/** Display names for the venues the user actually trades on. */
export const VENUE_LABEL: Record<Venue | string, string> = {
  indodax: 'Indodax',
  pluang: 'Pluang',
  stockbit: 'Stockbit',
  other: 'Lainnya',
};
