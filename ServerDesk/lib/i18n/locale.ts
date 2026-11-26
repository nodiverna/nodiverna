// Console language. Like the theme (lib/theme.ts), the choice lives in
// a plain browser cookie: the server reads it in app/layout.tsx and renders
// <html lang> and the first text in the right language, without an inline
// script (the CSP forbids one). The cookie is not HttpOnly because the switch in
// ui/base/locale.tsx writes it in the browser, and sign-out keeps it.
// Without a cookie the server takes the browser's Accept-Language header
// (negotiateLocale) and writes no cookie.
export const locales = ['en', 'de'] as const;
export type Locale = (typeof locales)[number];
/** The only place that decides the default language. */
export const defaultLocale: Locale = 'en';
export const localeCookieName = 'serverdesk-locale';

const oneYear = 31536000;

/** The stored value if it is a known locale, otherwise the default. */
export function parseLocale(value: unknown): Locale {
  return (locales as readonly unknown[]).includes(value) ? (value as Locale) : defaultLocale;
}

/** At most this many Accept-Language entries are read. */
const maxLanguageRanges = 20;

/**
 * The page language for a request: a valid cookie value wins; otherwise the
 * supported language with the highest q in Accept-Language (primary subtag,
 * without regard to case; ties keep the header order; q=0 and * do not count);
 * otherwise defaultLocale. Pure, never throws, reads at most 20 entries.
 */
export function negotiateLocale(cookieValue: unknown, acceptLanguage: unknown): Locale {
  if ((locales as readonly unknown[]).includes(cookieValue)) return cookieValue as Locale;
  if (typeof acceptLanguage !== 'string' || !acceptLanguage) return defaultLocale;
  let best: Locale | null = null;
  let bestQ = 0;
  for (const range of acceptLanguage.slice(0, 4096).split(',', maxLanguageRanges)) {
    const [tag = '', ...parameters] = range.split(';');
    const primary = tag.trim().split('-')[0].toLowerCase();
    const locale = locales.find((value) => value === primary);
    if (!locale) continue;
    const qParameter = parameters.map((part) => part.trim()).find((part) => /^q=/i.test(part));
    const q = qParameter === undefined ? 1 : /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.test(qParameter) ? Number(qParameter.slice(2)) : 0;
    if (q > bestQ) {
      best = locale;
      bestQ = q;
    }
  }
  return best ?? defaultLocale;
}

/** Cookie string for document.cookie. Never HttpOnly: the browser writes it. */
export function localeCookie(locale: Locale, secure: boolean): string {
  return `${localeCookieName}=${locale}; Path=/; Max-Age=${oneYear}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * The language of the current page: <html lang>, which app/layout.tsx renders and
 * the language switch updates. Outside a browser it is the default. Only for deep
 * client fallbacks (request errors) that no component passes a locale to.
 */
export function documentLocale(): Locale {
  return typeof document === 'undefined' ? defaultLocale : parseLocale(document.documentElement?.lang);
}
