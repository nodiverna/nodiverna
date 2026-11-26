import {failure} from '@/lib/server/context';
import {startEntraSignIn,startRedirect} from '@/lib/server/identity/entra/sign-in';

// Starts a sign-in with Microsoft Entra ID (docs/entra-id.md): 302 to the
// authorize endpoint of the tenant, or to /#entra=<code> when it cannot start.
export async function GET(request:Request){try{return startRedirect(await startEntraSignIn(request));}catch(e){return failure(e);}}
