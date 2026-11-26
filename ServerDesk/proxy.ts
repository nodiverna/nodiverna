import { NextRequest, NextResponse } from 'next/server';
import { isIP } from 'node:net';
import { brandingAssetPolicy, contentSecurityPolicy, createNonce, isBrandingAssetPath, reportingEndpoints } from '@/lib/server/csp';

const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(prefix + '/');

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  // Next takes the script nonce from the request CSP headers. Any unknown path
  // renders the HTML 404 page, so a client-supplied policy must never reach
  // the renderer on any path, not only on the page routes.
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');
  if (under(request.nextUrl.pathname, '/api')) setClientAddress(headers);
  // Development keeps HMR free of any script policy; only the next.config.ts
  // baseline applies there.
  if (process.env.NODE_ENV !== 'production') return NextResponse.next({ request: { headers } });
  // One enforced policy for every proxied response: the proxy cannot know in
  // advance which request ends in an HTML 404 or error page. For JSON, files
  // and downloads it changes nothing. The response header replaces the
  // next.config.ts baseline; Next also copies it onto the request and reads
  // the nonce from there.
  // SITE_ORIGIN is read per request, not at build time: one image serves every
  // origin, and only an https: origin gets upgrade-insecure-requests.
  const policy = contentSecurityPolicy(createNonce(), process.env.SITE_ORIGIN);
  headers.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers } });
  // A branding image keeps its own sandbox policy (lib/server/branding.ts): opened directly, it runs nothing.
  response.headers.set('Content-Security-Policy', isBrandingAssetPath(request.nextUrl.pathname) ? brandingAssetPolicy : policy);
  // Names the report-to group of the policy (app/api/csp-report).
  response.headers.set('Reporting-Endpoints', reportingEndpoints);
  return response;
}

// The internal header X-ServerDesk-Client-IP carries the client address to the
// login lockout and the report limits. A browser must never supply it: the
// incoming value is always deleted, and only the trusted ingress header
// (TRUSTED_CLIENT_IP_HEADER) sets it again. Enable that only when the origin is
// private and the ingress overwrites the header (NAS Caddy does). Otherwise all
// clients share the conservative IP bucket.
function setClientAddress(headers: Headers) {
  const trustedHeader = process.env.TRUSTED_CLIENT_IP_HEADER?.toLowerCase();
  const address = trustedHeader ? headers.get(trustedHeader)?.trim() : undefined;
  headers.delete('x-serverdesk-client-ip');
  if (address && isIP(address)) headers.set('X-ServerDesk-Client-IP', address);
}

// Every path, including public files, /api, /downloads and unknown /_next
// paths (each of them can end in the HTML 404 page). Only build assets, whose
// misses are plain text, bypass the proxy and keep the next.config.ts
// baseline. The development HMR socket (/_next/hmr) is answered before any
// routing and never reaches the proxy.
export const config = { matcher: ['/((?!_next/static/).*)'] };
