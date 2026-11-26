import {HttpError} from '../../../errors/http-error';

// At most this many jobs may wait or run per device. The queue routes use it in
// their 429 pre-check and in the SQL guard of the INSERT.
export const MAX_QUEUED_JOBS=20;
/** The 429 of the pre-check. */
export const queueFullError=()=>new HttpError('apiError.console.queueFull',{count:MAX_QUEUED_JOBS});
