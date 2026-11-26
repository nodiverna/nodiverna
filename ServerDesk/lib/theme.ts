// Console appearance. The choice lives in a plain browser cookie, not
// in the database: the server reads it in app/layout.tsx and renders
// <html data-theme>, so the first paint already has the right colors without an
// inline script (the CSP forbids one). The cookie is not HttpOnly because the
// switch in ui/shell/theme.tsx writes it in the browser, and sign-out keeps it.
export const themes = ['light', 'dark', 'system'] as const;
export type Theme = (typeof themes)[number];
export const themeCookieName = 'serverdesk-theme';

const oneYear = 31536000;

/** The stored value if it is a known theme, otherwise the default "system": the console follows the operating system until the user picks a mode. */
export function parseTheme(value: unknown): Theme {
  return (themes as readonly unknown[]).includes(value) ? (value as Theme) : 'system';
}

/** Cookie string for document.cookie. Never HttpOnly: the browser writes it. */
export function themeCookie(theme: Theme, secure: boolean): string {
  return `${themeCookieName}=${theme}; Path=/; Max-Age=${oneYear}; SameSite=Lax${secure ? '; Secure' : ''}`;
}
