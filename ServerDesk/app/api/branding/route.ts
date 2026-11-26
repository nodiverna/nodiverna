import {failure} from '@/lib/server/context';
import {publicBranding} from '@/lib/server/branding';

// The public branding (docs/branding.md): the light and dark logo and the
// browser tab icon, each null or its metadata with a versioned URL, and the
// background of the sign-in page. Public, because the sign-in page shows them
// before any session exists; it carries no customer data and nothing about
// the console.
export async function GET(){try{return Response.json(await publicBranding(),{headers:{'Cache-Control':'no-store'}});}catch(e){return failure(e);}}
