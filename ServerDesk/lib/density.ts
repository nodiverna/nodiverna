// Console density (docs/device-workspace.md, "Density"). Like the theme
// (lib/theme.ts) the choice lives in a plain browser cookie: the server reads it
// in app/layout.tsx and renders <html data-density>, so the first paint has the
// right row heights without an inline script. The right density depends on the
// screen, so it follows the browser, not the account. The cookie is not
// HttpOnly because ui/shell/density.tsx writes it, and sign-out keeps it.
// app/globals.css applies "compact" only above 900px with a fine pointer.
export const densities = ['comfortable', 'compact'] as const;
export type Density = (typeof densities)[number];
export const densityCookieName = 'serverdesk-density';

const oneYear = 31536000;

/** The stored value if it is a known density, otherwise the default "comfortable". */
export function parseDensity(value: unknown): Density {
  return (densities as readonly unknown[]).includes(value) ? (value as Density) : 'comfortable';
}

/** Cookie string for document.cookie. Never HttpOnly: the browser writes it. */
export function densityCookie(density: Density, secure: boolean): string {
  return `${densityCookieName}=${density}; Path=/; Max-Age=${oneYear}; SameSite=Lax${secure ? '; Secure' : ''}`;
}
