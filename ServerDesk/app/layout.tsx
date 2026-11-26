import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { parseTheme, themeCookieName } from "@/lib/theme";
import { densityCookieName, parseDensity } from "@/lib/density";
import { localeCookieName, negotiateLocale } from "@/lib/i18n/locale";
import { translate } from "@/lib/i18n/translate";
import { parseSchemeChoice, schemeCookieName } from "@/lib/color-schemes";
import { LocaleProvider } from "@/ui/base/locale";
import "./globals.css";

// Render every page per request, including Next's built-in 404 page
// (/_not-found shares this layout). A prerendered page would carry inline
// scripts without the per-request nonce that the enforced CSP requires.
export const dynamic = "force-dynamic";

/** The language from the locale cookie, else from Accept-Language (lib/i18n/locale.ts). No cookie is written. */
async function requestLocale() {
  return negotiateLocale((await cookies()).get(localeCookieName)?.value, (await headers()).get("accept-language"));
}

// The page title and description, in the request's language.
export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  return {
    title: translate(locale, "meta.title"),
    description: translate(locale, "meta.description"),
    // The uploaded browser tab icon, or a redirect to /favicon.svg (app/api/branding/favicon).
    icons: {
      icon: "/api/branding/favicon",
      shortcut: "/api/branding/favicon",
    },
  };
}

// The appearance comes from the theme cookie (lib/theme.ts), the density from the density cookie (lib/density.ts), the color scheme per
// mode from the scheme cookie (lib/color-schemes.ts; without one the brand colors), the language from the locale
// cookie or the browser's Accept-Language header (lib/i18n/locale.ts). Setting them here on the server paints the right
// colors and text at once, with no inline script.
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const store = await cookies();
  const theme = parseTheme(store.get(themeCookieName)?.value);
  const locale = await requestLocale();
  const scheme = parseSchemeChoice(store.get(schemeCookieName)?.value);
  const density = parseDensity(store.get(densityCookieName)?.value);
  return (
    <html lang={locale} data-theme={theme} data-density={density} data-scheme-light={scheme.light} data-scheme-dark={scheme.dark}>
      <head>
        {/* The brand color scheme (docs/branding.md): --brand-* values for the scheme "brand", the default of every
            account without its own choice. A render-blocking stylesheet, so the sign-in page and the console paint
            the brand colors at once; without a stored scheme the sheet is empty and "brand" looks like Aurora.
            The Branding page sets a new ?v= on this link after Apply or Remove. */}
        <link rel="stylesheet" href="/api/branding/scheme" data-brand-scheme="" />
      </head>
      <body className="antialiased">
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
