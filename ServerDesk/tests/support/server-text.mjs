// The text of a server message key as the API sends it in `error` (and in the
// message fields): the defaultLocale catalog text (lib/server/errors/failure.ts). An
// assertion on serverText('apiError.x') checks that the server chose that key;
// the German catalog text is checked in tests/lib/i18n-server.mjs.
import './register.mjs';

const {translate} = await import('../../lib/i18n/translate.ts');
const {defaultLocale} = await import('../../lib/i18n/locale.ts');

export const serverText = (key, params) => translate(defaultLocale, key, params);
