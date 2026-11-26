import {failure} from '@/lib/server/context';
import {brandSchemeResponse} from '@/lib/server/branding';

// The brand color scheme as a stylesheet (docs/branding.md, "Color scheme"):
// only --brand-<mode>-<name> declarations, or a comment without a stored
// scheme. Public, because app/layout.tsx links it on every page, the sign-in
// page included; revalidated with its ETag (next.config.ts leaves the path
// out of the no-store rule).
export async function GET(request:Request){try{return await brandSchemeResponse(request);}catch(e){return failure(e);}}
