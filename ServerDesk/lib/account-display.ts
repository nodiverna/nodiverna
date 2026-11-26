// The one rule that decides which value names an account where a person reads
// it. Accounts are stored under internal values (lib/server/identity/entra/sign-in.ts and
// lib/server/identity/account-admin.ts): the auth email <oid>@<tid>.entra.serverdesk.invalid or
// <uuid>@local.serverdesk.invalid, the principal entra:<tid>:<oid> or
// local:/private:<auth email>, and the Entra username entra.<oid>. These are how
// the system finds an account, not names people recognize, so the UI never
// shows them. Client-safe: no server imports. lib/server/identity/account-names.ts holds the
// same rule as SQL for the server joins.

const entraUsername=/^entra\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a stored internal account value: a *.serverdesk.invalid address, an entra: or local: principal, or an entra.<GUID> username. */
export function isInternalAccountValue(value:string|null|undefined):boolean{
 const text=(value??'').trim(),lower=text.toLowerCase();
 if(!text)return false;
 return lower.endsWith('.serverdesk.invalid')||lower.startsWith('entra:')||lower.startsWith('local:')||entraUsername.test(text);
}

export type AccountNameParts={displayName?:string|null;username?:string|null;email?:string|null};

/** The name of an account: the first non-empty value that is not internal, in the order display name, email, username; else ''. */
export function accountName({displayName,username,email}:AccountNameParts):string{
 for(const value of [displayName,email,username]){const text=(value??'').trim();if(text&&!isInternalAccountValue(text))return text;}
 return '';
}

/** The second line under an account's name: the email of an Entra account (or ''), the username of a local one. */
export function accountDetail({identitySource,username,email}:{identitySource?:'local'|'entra'|string|null;username?:string|null;email?:string|null}):string{
 if(identitySource==='entra'){const text=(email??'').trim();return text&&!isInternalAccountValue(text)?text:'';}
 return username??'';
}

/** The name parts of a signed-in viewer: an Entra viewer's email is its entra.email. */
export const viewerNameParts=(viewer:{displayName?:string;username?:string;entra?:{email:string}}):AccountNameParts=>({displayName:viewer.displayName,username:viewer.username,email:viewer.entra?.email});

/**
 * A stored actor value that no account matches, for display: null when it is
 * internal, a private:<email> principal as its email, any other value (System,
 * CLI names) unchanged.
 */
export function storedActorName(value:string|null|undefined):string|null{
 if(value===null||value===undefined)return null;
 const text=value.startsWith('private:')?value.slice(8):value;
 return isInternalAccountValue(text)?null:text;
}
