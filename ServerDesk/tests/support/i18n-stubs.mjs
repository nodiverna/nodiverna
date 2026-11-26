// Stubs for tests that run one app file with a hand-written require.
// The real catalog, translate() and format helpers are loaded through the
// shared TypeScript loader; the client hooks of ui/base/locale.tsx are
// replaced by versions without React that use German, as a German user sees
// the page. The real hooks fall back to defaultLocale (English) without a
// LocaleProvider; tests that check German output pin 'de' here.
import './register.mjs';
import {germanLocale} from './locale-de.mjs';
import {pureModule} from './pure-modules.mjs';

export const localeModule = await import('../../lib/i18n/locale.ts');
export const translateModule = await import('../../lib/i18n/translate.ts');
export const formatModule = await import('../../lib/i18n/format.ts');
export const operationsModule = await import('../../ui/base/operation-labels.ts');
export const apiErrorTextModule = await import('../../ui/base/api-error-text.ts');
export const serverMessagesModule = await import('../../lib/server-messages.ts');
const {translate} = translateModule;

/** German text for a message key, as a German user sees it. */
export const de = (key, params) => translate('de', key, params);

// One function instance, so effects that depend on t do not rerun on every render.
const defaultT = (key, params) => translate('de', key, params);
const setLocale = () => {};

export const localeHooks = {
  useLocale: () => ['de', setLocale],
  useT: () => defaultT,
  useStableT: () => defaultT,
  RichText: ({text, parts}) => text.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(parts, name) ? '' : match)),
  LanguageMenuGroup: 'LanguageMenuGroup',
};

/** require() stubs for every spelling the app and lib files use. */
export const i18nStubs = {
  '@/lib/i18n/locale': germanLocale,
  '@/lib/i18n/translate': translateModule,
  '@/lib/i18n/format': formatModule,
  '@/ui/base/operation-labels': operationsModule,
  './i18n/locale': germanLocale,
  '../../../i18n/locale': germanLocale,'../i18n/locale':germanLocale,'../../i18n/locale':germanLocale,
  '../../../i18n/translate': translateModule,'../i18n/translate':translateModule,'../../i18n/translate':translateModule,
  '@/ui/base/api-error-text': apiErrorTextModule,
  '@/lib/server-messages': serverMessagesModule,
  './i18n/translate': translateModule,
  './i18n/format': formatModule,'../../i18n/format':formatModule,
  '@/ui/base/locale': localeHooks,
};

/** The i18n stub for a require() id, then the real plain modules of lib/errors and lib/server-messages (pure-modules.mjs), else undefined. */
export const i18nRequire = id => (Object.hasOwn(i18nStubs, id) ? i18nStubs[id] : pureModule(id));

/** A settings page of the navigation model (ui/shell/nav-model.ts, passed as navModel) by its section id, with its texts in German, or undefined. */
export function navPage(navModel, id) {
  const node = navModel.navNodes.find(item => item.section === id);
  return node ? {id, label: de(node.label), description: de(node.hint), icon: node.icon, group: de(node.placement.group)} : undefined;
}
