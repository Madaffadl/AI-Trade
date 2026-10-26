import 'server-only';
import { getSetting, setSetting } from '@/lib/db/repo';
import { en, type Messages } from './en';
import { id } from './id';
import { isLocale, type Locale } from './types';

/**
 * Server-side i18n.
 *
 * Deliberately not a library: one user, two locales, and a typed dictionary
 * where a missing translation is a compile error. A runtime i18n framework
 * would add a dependency and *weaken* that guarantee by falling back to the
 * key string instead of failing the build.
 */

const DICTIONARIES: Record<Locale, Messages> = { en, id };

export async function getLocale(): Promise<Locale> {
  const value = await getSetting<string>('display.locale', 'en');
  return isLocale(value) ? value : 'en';
}

export async function setLocale(locale: Locale): Promise<void> {
  await setSetting('display.locale', locale);
}

/** Messages for the stored locale. */
export async function getMessages(): Promise<Messages> {
  return DICTIONARIES[await getLocale()];
}

/** Locale plus messages, for pages that need both. */
export async function i18n(): Promise<{ locale: Locale; t: Messages }> {
  const locale = await getLocale();
  return { locale, t: DICTIONARIES[locale] };
}

export function messagesFor(locale: Locale): Messages {
  return DICTIONARIES[locale];
}

export type { Messages };
export { en, id };
