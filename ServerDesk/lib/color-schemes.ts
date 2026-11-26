// Color schemes. This is the only list of schemes. The colors live only
// in app/globals.css: one block per scheme and mode sets the scheme variables
// (--scheme-light-* / --scheme-dark-*) that the tokens read. The choice is kept per
// mode in a plain browser cookie, like the theme (lib/theme.ts): app/layout.tsx
// reads it and renders <html data-scheme-light data-scheme-dark>, so the first
// paint already has the scheme colors without an inline script. The cookie is not
// HttpOnly because ui/shell/color-scheme.tsx writes it in the browser.
// The scheme "brand" holds the colors the Owner derives from the portal logo
// (lib/brand-scheme.ts, docs/branding.md): its blocks read the --brand-* values
// of the stylesheet /api/branding/scheme and fall back to Aurora without one.
// It is the default for every account without its own choice.
import type {MessageKey} from './i18n/translate';

export type SchemeMode = 'light' | 'dark';
export const schemeModes: readonly SchemeMode[] = ['light', 'dark'];

export const colorSchemes = [
  {id: 'brand', name: 'scheme.brand', modes: ['light', 'dark']},
  {id: 'aurora', name: 'scheme.aurora', modes: ['light', 'dark']},
  {id: 'cyber-teal', name: 'scheme.cyberTeal', modes: ['light', 'dark']},
  {id: 'inkberry', name: 'scheme.inkberry', modes: ['light', 'dark']},
  {id: 'electric-violet', name: 'scheme.electricViolet', modes: ['light', 'dark']},
  {id: 'ember', name: 'scheme.ember', modes: ['light']},
  {id: 'prompt-blue', name: 'scheme.promptBlue', modes: ['dark']},
] as const satisfies readonly {id: string; name: MessageKey; modes: readonly SchemeMode[]}[];

export type ColorScheme = (typeof colorSchemes)[number];
export type SchemeId = ColorScheme['id'];
export type SchemeChoice = {light: SchemeId; dark: SchemeId};

/** The scheme of an account without its own choice: the brand colors, which look like Aurora until the Owner applies a brand scheme. */
export const defaultScheme: SchemeId = 'brand';
export const schemeCookieName = 'serverdesk-scheme';
const defaultChoice: SchemeChoice = {light: defaultScheme, dark: defaultScheme};
const oneYear = 31536000;

const byId = (id: unknown) => colorSchemes.find(scheme => scheme.id === id);

/** True if `id` is a known scheme that is offered in `mode`. */
export function isOffered(id: unknown, mode: SchemeMode): id is SchemeId {
  return (byId(id)?.modes as readonly SchemeMode[] | undefined)?.includes(mode) ?? false;
}

/**
 * The schemes offered in a mode, in list order. A list for people passes `brand: false` while the portal has no brand
 * scheme: then "brand" looks exactly like Aurora and is left out (ui/shell/color-scheme.tsx shows it as Aurora).
 */
export function schemesFor(mode: SchemeMode, {brand = true}: {brand?: boolean} = {}): ColorScheme[] {
  return colorSchemes.filter(scheme => isOffered(scheme.id, mode) && (brand || scheme.id !== 'brand'));
}

/** Reads "<lightId>.<darkId>". A part that is unknown or not offered in its mode falls back to the default. */
export function parseSchemeChoice(value: unknown): SchemeChoice {
  if (typeof value !== 'string') return {...defaultChoice};
  const parts = value.split('.');
  if (parts.length !== 2) return {...defaultChoice};
  const [light, dark] = parts;
  return {light: isOffered(light, 'light') ? light : defaultScheme, dark: isOffered(dark, 'dark') ? dark : defaultScheme};
}

/** The cookie value "<lightId>.<darkId>". */
export function formatSchemeChoice(choice: SchemeChoice): string {
  return `${choice.light}.${choice.dark}`;
}

/** Cookie string for document.cookie. Never HttpOnly: the browser writes it. */
export function schemeCookie(choice: SchemeChoice, secure: boolean): string {
  return `${schemeCookieName}=${formatSchemeChoice(choice)}; Path=/; Max-Age=${oneYear}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Picks `id` for `mode`, and for the other mode too if it is offered there. An id not offered in `mode` changes nothing. */
export function chooseScheme(choice: SchemeChoice, id: SchemeId, mode: SchemeMode): SchemeChoice {
  if (!isOffered(id, mode)) return choice;
  const other: SchemeMode = mode === 'light' ? 'dark' : 'light';
  const next = {...choice, [mode]: id};
  if (isOffered(id, other)) next[other] = id;
  return next;
}
