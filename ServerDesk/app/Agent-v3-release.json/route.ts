import {bootstrapLatestRelease} from '@/lib/server/agent/releases';
import {failure,HttpError} from '@/lib/server/context';

// The bootstrap needs public publisher metadata, never a browser MFA session.
// No request field or uploaded record can select what is signed: the answer is
// always the exact signed path-form envelope of the latest release of the
// catalog (lib/server/agent/releases.ts). A query such as form=path is ignored; agents and
// scripts before 4.12.0 cannot verify the path form and are not supported.
// The signed manifest is UTF-8 text; the charset tells every client so. The
// route is unauthenticated, so it reads the latest release through a 30 s
// in-process cache (bootstrapLatestRelease): a new import shows within 30 s.
export async function GET(){try{
 const release=await bootstrapLatestRelease();if(!release)throw new HttpError('apiError.release.noneAvailable');
 return Response.json({manifest:release.manifest,signature:release.signature},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Type':'application/json; charset=utf-8'}});
}catch(e){return failure(e);}}
