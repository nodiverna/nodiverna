// The one enforced Content-Security-Policy. proxy.ts sends it
// with a fresh nonce on every production response it handles; next.config.ts
// keeps only the baseline for the build assets that bypass the proxy.
// The first three directives repeat that baseline, so this string is the
// complete policy for every proxied response.
const baseline = "base-uri 'self'; object-src 'none'; frame-ancestors 'self'";

// Violations go to app/api/csp-report. report-to uses the Reporting API group
// named in the Reporting-Endpoints page header; browsers without it (Firefox)
// fall back to report-uri. The relative URL resolves against the public origin.
const reportPath = '/api/csp-report';
const reportGroup = 'csp-endpoint';
const reporting = `report-uri ${reportPath}; report-to ${reportGroup}`;
export const reportingEndpoints = `${reportGroup}="${reportPath}"`;

const scriptDirectives = (nonce: string) => `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; connect-src 'self'`;

// script-src and connect-src stay explicit, otherwise default-src would also
// act as their fallback.
// style-src has 'unsafe-inline' and no nonce: server-rendered style= attributes
// cannot carry a nonce, and sonner, xterm and radix insert <style> elements
// without one. A nonce would also switch 'unsafe-inline' off. img-src,
// font-src, connect-src and default-src allow only the own origin (and data:),
// so injected CSS cannot send data elsewhere.
const fetchDirectives = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src 'self'; worker-src 'self'; form-action 'self'";

// upgrade-insecure-requests only behind HTTPS: on a plain http://localhost
// install the browser would request every own sub-resource over HTTPS and
// break the page. runtime/env.mjs already validates SITE_ORIGIN.
const upgrade = (siteOrigin?: string) => siteOrigin?.startsWith('https:') ? 'upgrade-insecure-requests; ' : '';

// Remote Desktop (paused) would additionally need 'wasm-unsafe-eval' and
// connect-src data: for its IronRDP client; tests/lib/csp-policy.mjs guards that.
export function contentSecurityPolicy(nonce: string, siteOrigin?: string): string {
  return `${baseline}; ${scriptDirectives(nonce)}; ${fetchDirectives}; ${upgrade(siteOrigin)}${reporting}`;
}

// 16 random bytes as standard base64, the alphabet Next's nonce parser accepts.
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

// A branding image (lib/server/branding.ts, docs/branding.md) opened directly
// renders sandboxed: it loads nothing and runs nothing. The image routes send
// this policy, and proxy.ts keeps it for their paths instead of the page policy.
export const brandingAssetPolicy = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
export const isBrandingAssetPath = (pathname: string) => /^\/api\/branding\/(?:portal\/|customer\/|favicon$)/.test(pathname);
