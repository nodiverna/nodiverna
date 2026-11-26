// The account texts of Settings → Accounts and User groups (ui/settings/settings-accounts.tsx, ui/settings/settings-user-groups.tsx).
// Local accounts show their username as before. Entra accounts never show
// their internal username entra.<oid>: their name follows accountName and
// their second line is the email (lib/account-display.ts).
import {accountDetail,accountName} from '@/lib/account-display';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import type {MessageKey} from '@/lib/i18n/translate';

type Translate=(key:MessageKey,params?:Record<string,string|number>)=>string;
export type RbacAccount={username:string;email:string|null;displayName:string;identitySource?:'local'|'entra'};

const entra=(user:RbacAccount)=>user.identitySource==='entra';
const entraEmail=(user:RbacAccount)=>accountDetail({identitySource:'entra',email:user.email});

/** The account's name: display name, else username for a local account; accountName for an Entra account. */
export function rbacAccountName(user:RbacAccount):string{
 return entra(user)?accountName(user)||EMPTY_VALUE:user.displayName||user.username;
}

/** The value that names the account in sentences (disable, enable, remove member): the username of a local account, the name of an Entra account. */
export function rbacAccountParam(user:RbacAccount):string{
 return entra(user)?rbacAccountName(user):user.username;
}

/**
 * The small lines under the name in the account list. Local: the username
 * (with "current account" on the viewer's own row), then the email. Entra:
 * the email once, on the viewer's own row as "<email> · current account" or
 * "Current account" without an email.
 */
export function rbacAccountLines(user:RbacAccount,self:boolean,t:Translate):string[]{
 if(!entra(user))return [self?t('rbac.currentAccount',{username:user.username}):user.username,...user.email?[user.email]:[]];
 const email=entraEmail(user);
 if(self)return [email?t('rbac.currentAccount',{username:email}):t('rbac.currentAccountNoDetail')];
 return email?[email]:[];
}

/** An account in a select: "<name> · <username>" for a local account, "<name> · <email>" or "<name>" for an Entra account. */
export function rbacAccountOption(user:RbacAccount):string{
 const detail=accountDetail({identitySource:user.identitySource,username:user.username,email:user.email});
 return detail?`${rbacAccountName(user)} · ${detail}`:rbacAccountName(user);
}

/** A group member's line: "<username> · <status>" for a local account, "<email> · <status>" or "<status>" for an Entra account. */
export function rbacMemberLine(user:RbacAccount,status:string):string{
 const detail=accountDetail({identitySource:user.identitySource,username:user.username,email:user.email});
 return detail?`${detail} · ${status}`:status;
}
