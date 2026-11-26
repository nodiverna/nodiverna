import type { NextConfig } from "next";
import path from "node:path";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

export default function nextConfig(phase: string): NextConfig {
  const development = phase === PHASE_DEVELOPMENT_SERVER;
  return {
    output: "standalone",
    poweredByHeader: false,
    agentRules: false,
    devIndicators: { position: "bottom-right" },
    // The NAS proxy exposes the dev server at its configured HTTPS origin.
    // Permit only that hostname for Next's dev assets and HMR.
    allowedDevOrigins: development
      ? [new URL(process.env.SITE_ORIGIN ?? "https://localhost").hostname]
      : undefined,
    // runtime/*.mjs and scripts/selfhost.mjs import these outside the bundle; zod for the
    // release manifest schema (runtime/release-schema.mjs) of import-release.
    serverExternalPackages: ["postgres", "@azure/storage-blob", "@azure/identity", "nodemailer", "zod"],
    // Resolve the database/storage adapter contracts to the Node runtime.
    webpack(config, { webpack }) {
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(
        /^cloudflare:workers$/,
        path.resolve(process.cwd(), "runtime/env.mjs"),
      ));
      return config;
    },
    async headers() {
      return [
        { source: "/:path*", headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          { key: "Content-Security-Policy", value: "base-uri 'self'; object-src 'none'; frame-ancestors 'self'" },
        ] },
        { source: "/api/:path*", headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
        ] },
        // A header set here replaces the one the route sends, so the branding image
        // routes (lib/server/csp.ts isBrandingAssetPath) and the brand scheme stylesheet
        // (/api/branding/scheme, linked on every page) are left out: they set their own
        // Cache-Control (immutable for a versioned URL, otherwise no-cache), and their
        // error answers still get no-store from failure(). tests/api/next-config-headers.mjs
        // checks the rules with Next's own matcher.
        { source: "/api/:path((?!branding/(?:portal/|customer/|favicon$|scheme$)).*)", headers: [
          { key: "Cache-Control", value: "no-store" },
        ] },
        { source: "/downloads/:path*", headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ] },
      ];
    },
  };
}
