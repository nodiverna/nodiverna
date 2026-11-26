// Runs in the browser before the console's own modules (the Next.js client
// instrumentation hook). The enforced CSP (lib/server/csp.ts) has no
// 'unsafe-eval', so zod can never compile its object schemas with Function
// there. Without jitless, zod still probes with Function("") when it builds an
// object schema; zod catches the error, but the browser reports the probe as a
// CSP violation on every page. zod reads the setting when a schema is built,
// so it must be set before the first module with a schema runs, which this
// hook does. The server keeps the compiled schemas.
// tests/lib/zod-csp-probe.mjs checks it.
import {z} from 'zod';

z.config({jitless: true});
