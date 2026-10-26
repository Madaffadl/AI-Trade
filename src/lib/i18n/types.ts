/**
 * Client-safe locale types.
 *
 * Kept separate from the server helpers so client components (the toggle, the
 * forms) can import the locale list without pulling in the database layer.
 */

export const LOCALES = ['en', 'id'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABEL: Record<Locale, string> = {
  en: 'EN',
  id: 'ID',
};

export const LOCALE_NAME: Record<Locale, string> = {
  en: 'English',
  id: 'Bahasa Indonesia',
};

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/** Number/date locale used for formatting under each language. */
export const INTL_LOCALE: Record<Locale, string> = {
  en: 'en-US',
  id: 'id-ID',
};
