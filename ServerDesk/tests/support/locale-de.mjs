// The locale module of lib/i18n/locale.ts with defaultLocale 'de', for tests
// that load app files with a hand-written require and check the German page.
// Hooks without a LocaleProvider and helpers without a locale argument then
// use German, as a German user sees them. The real default is English.
import './register.mjs';
import path from 'node:path';

const real = await import('../../lib/i18n/locale.ts');

export const germanLocalePath = path.resolve('lib/i18n/locale.ts');
export const germanLocale = {...real, defaultLocale: 'de', documentLocale: () => 'de', parseLocale: value => (real.locales.includes(value) ? value : 'de')};
