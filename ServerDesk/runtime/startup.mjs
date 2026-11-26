import { validateEnvironment } from './env.mjs';
validateEnvironment();
// The reminder to remove SESSION_SECRET_PREVIOUS (runtime/previous-secret.mjs).
// Not awaited and never rejecting: the start never waits for the database.
import('./previous-secret.mjs').then(({ checkPreviousSecretAtStartup }) => checkPreviousSecretAtStartup()).catch(() => {});
