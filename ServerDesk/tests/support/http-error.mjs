// The real HttpError (lib/errors/http-error.ts) for tests that stub lib/server/context.ts
// in a hand-written require: keyed throws then carry the status of their code.
import './register.mjs';

export const {HttpError} = await import('../../lib/errors/http-error.ts');

const generic = new Set(['INVALID_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'GONE', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED', 'BAD_GATEWAY', 'SERVICE_UNAVAILABLE']);
/** A generic code per status (lib/errors/codes.ts): no client branches on it. Tests that compare whole bodies may leave it out. */
export const genericCode = code => generic.has(code);
