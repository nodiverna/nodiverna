// The real plain modules that server and client files import since the server messages moved into the catalog: the
// locale, the catalogs, translate(), the error contract and the server messages; also the agent integrity
// contract that lib/server/agent/telemetry.ts and lib/alert-rules.ts import, lib/server/agent/portal-certificate.ts and the account name rule
// lib/account-display.ts.
// For tests that compile project files with a hand-written require: put
// pureModule(id) before the fallback, and every spelling of these imports gets
// the real module, so HttpError, failure() and the catalog stay one instance.
import './register.mjs';

const modules = {
  'i18n/locale': await import('../../lib/i18n/locale.ts'),
  'i18n/translate': await import('../../lib/i18n/translate.ts'),
  'i18n/messages/en': await import('../../lib/i18n/messages/en.ts'),
  'i18n/messages/de': await import('../../lib/i18n/messages/de.ts'),
  'errors/codes': await import('../../lib/errors/codes.ts'),
  'errors/api-error-keys': await import('../../lib/errors/api-error-keys.ts'),
  'errors/http-error': await import('../../lib/errors/http-error.ts'),
  'errors/failure': await import('../../lib/server/errors/failure.ts'),
  'errors/db-codes': await import('../../lib/server/errors/db-codes.ts'),
  'errors/issues': await import('../../lib/server/errors/issues.ts'),
  // The client error texts, a model of ui/base/ since the lib/server/ move.
  'api-error-text': await import('../../ui/base/api-error-text.ts'),
  'server-messages': await import('../../lib/server-messages.ts'),
  'agent-integrity-contract': await import('../../lib/agent-integrity-contract.ts'),
  // Imported by lib/server/identity/session-settings.ts; a plain require('../agent/portal-certificate') from tests/ would fail.
  'agent/portal-certificate': await import('../../lib/server/agent/portal-certificate.ts'),
  // The account name rule that app/ and lib/ files import for every shown account name.
  'account-display': await import('../../lib/account-display.ts'),
  // The audit action constants and the display-safe job input: the writers and every INSERT INTO jobs import them.
  'audit-actions': await import('../../lib/audit-actions.ts'),
  'job-input': await import('../../lib/job-input.ts'),
};
// Marked as ES modules, so the default import of CommonJS output (__importDefault) finds the default export.
for (const name of Object.keys(modules)) modules[name] = {...modules[name], __esModule: true};
// Inside lib/server/agent/ the certificate module is a sibling ('./portal-certificate').
modules['portal-certificate'] = modules['agent/portal-certificate'];
const names = Object.keys(modules);

/** The real module for an import of lib/i18n/*, lib/errors/*, lib/server/errors/*, ui/base/api-error-text, lib/server-messages, lib/agent-integrity-contract, lib/server/agent/portal-certificate, lib/account-display, lib/audit-actions or lib/job-input, else undefined. */
export function pureModule(id) {
  if (typeof id !== 'string') return undefined;
  // The text after @/lib/server/, @/lib/, @/ui/base/ or the leading ../ steps: errors/failure, i18n/locale, agent/portal-certificate.
  const bare = id.replace(/^@\/(?:lib\/(?:server\/)?|ui\/base\/)/, '').replace(/^(?:\.\.?\/)+(?:lib\/)?/, '');
  if (Object.hasOwn(modules, bare)) return modules[bare];
  // Imports inside lib/errors/ and lib/server/errors/ name their siblings ('./codes', './db-codes'). './locale' stays out: it means lib/i18n/locale.ts only inside lib/i18n/.
  const sibling = names.find(name => name.startsWith('errors/') && name.endsWith('/' + bare));
  return sibling && /^\.\.?\//.test(id) ? modules[sibling] : undefined;
}
