import IdentityEntry from '@/ui/session/identity-entry';
export const dynamic='force-dynamic';
// A client bootstrap reads the session through the API. The session tokens
// travel only in HttpOnly cookies, so the page never holds one.
export default function Page(){return <IdentityEntry/>;}
