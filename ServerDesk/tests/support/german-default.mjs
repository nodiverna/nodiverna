// Makes German the default language for this test process: lib/i18n/locale.ts is
// replaced by a copy whose defaultLocale is 'de'. For tests that import UI
// helpers and check the German text a German user sees; helpers without a
// locale argument and hooks without a LocaleProvider then use German. The real
// default is English. Import it before the first import of a module
// that reads the locale. The copy cannot import the real file (mock() replaces
// every import of it), so it repeats its small exports.
import {mock} from './register.mjs';

const locales = ['en', 'de'];
const parseLocale = value => (locales.includes(value) ? value : 'de');

mock('lib/i18n/locale.ts', {
  locales,
  defaultLocale: 'de',
  localeCookieName: 'serverdesk-locale',
  parseLocale,
  negotiateLocale: cookieValue => parseLocale(cookieValue),
  localeCookie: (locale, secure) => `serverdesk-locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`,
  documentLocale: () => (typeof document === 'undefined' ? 'de' : parseLocale(document.documentElement?.lang)),
});
