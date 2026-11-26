// The rules of Management → Accounts (ui/devices/management/device-accounts.tsx): the subtitle of a local user, the
// Administrators count, the search, and the job parameters of the six account actions. Pure, so the
// panel and the tests share one copy. The parameters are the ones the classic panel sent: text is
// trimmed, passwords pass unchanged, and the fields keep their length limits.
import type {ServerSnapshot} from '@/lib/types';

export type LocalUser=NonNullable<ServerSnapshot['localUsers']>[number];
export type LocalGroup=NonNullable<ServerSnapshot['localGroups']>[number];

/** The well-known SID of the local Administrators group (its name is localized, for example "Administratoren"). */
export const ADMINISTRATORS_SID='S-1-5-32-544';

/** The line below a user name: the non-empty, trimmed full name and description joined with " · "; '' when both are empty. */
export function accountSubtitle(fullName:string|null|undefined,description:string|null|undefined):string{
 return [fullName,description].map(part=>(part??'').trim()).filter(Boolean).join(' · ');
}

/** The member count of the local Administrators group, or null when the inventory has no such group. */
export function administratorCount(groups:readonly Pick<LocalGroup,'sid'|'members'>[]|null|undefined):number|null{
 const group=groups?.find(item=>item.sid.toUpperCase()===ADMINISTRATORS_SID);
 return group?group.members.length:null;
}

/** Whether a user matches the search: name, full name or description contain the text (case-insensitive). */
export function accountMatches(user:Pick<LocalUser,'name'|'fullName'|'description'>,query:string):boolean{
 const text=query.trim().toLowerCase();
 return !text||`${user.name} ${user.fullName} ${user.description}`.toLowerCase().includes(text);
}

export type AccountKind='create-local-user'|'set-local-user'|'reset-local-password'|'delete-local-user'|'local-group-add'|'local-group-remove';
export const ACCOUNT_KINDS:readonly AccountKind[]=['create-local-user','set-local-user','reset-local-password','delete-local-user','local-group-add','local-group-remove'];
/** The values of an account form. name is the user (the row's user for change, reset and delete; the chosen user for groups). */
export type AccountForm={name:string;fullName:string;description:string;password:string;enabled:boolean;passwordNeverExpires:boolean;groupSid:string};
/** The maxLength of the text fields, as the classic panel had them. */
export const ACCOUNT_LIMITS={name:20,fullName:256,description:48,password:127} as const;

/** The fields a form needs before it can be reviewed. */
export function accountRequired(kind:AccountKind):(keyof AccountForm)[]{
 if(kind==='create-local-user')return ['name','password'];
 if(kind==='reset-local-password')return ['password'];
 if(kind==='local-group-add'||kind==='local-group-remove')return ['name','groupSid'];
 return [];
}
/** The first required field that is empty (text after trimming, a password as given), or null. */
export function accountMissing(kind:AccountKind,form:AccountForm):keyof AccountForm|null{
 return accountRequired(kind).find(key=>key==='password'?!form.password:!String(form[key]).trim())??null;
}

/** The job parameters of an account action, in the order the classic panel sent them. */
export function accountParams(kind:AccountKind,form:AccountForm):Record<string,unknown>{
 const text=(value:string)=>value.trim();
 if(kind==='create-local-user')return {name:text(form.name),fullName:text(form.fullName),description:text(form.description),password:form.password,passwordNeverExpires:form.passwordNeverExpires};
 if(kind==='set-local-user')return {name:form.name,enabled:form.enabled,fullName:text(form.fullName),description:text(form.description),passwordNeverExpires:form.passwordNeverExpires};
 if(kind==='reset-local-password')return {name:form.name,password:form.password};
 if(kind==='delete-local-user')return {name:form.name};
 return {name:text(form.name),groupSid:text(form.groupSid)};
}
