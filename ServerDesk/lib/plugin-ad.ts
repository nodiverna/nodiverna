import {isPluginOperation,pluginOperations} from './plugin-catalog';
import type {MessageKey} from './i18n/translate';
import type {ServerSnapshot} from './types';

// AD sign-in for plugin changes (docs/plugin-ad-sign-in.md). Pure: no
// database and no server bindings, so the portal, the client and the tests
// share it. A technician proves an AD account once per portal session and
// directory (the ad-sign-in job checks the password on a device of that
// directory). Every later plugin change carries the verified identity as
// actAs in its signed job, and the agent starts the plugin with an S4U token
// of that account. The portal never keeps a password.

/** The agent capability of agent 4.19.0: the ad-sign-in job and plugin changes that run as the account. */
export const PLUGIN_AD_IDENTITY='plugin-ad-identity';
/** The first agent version with PLUGIN_AD_IDENTITY. */
export const PLUGIN_AD_MIN_AGENT='4.19.0';
/** The job kind that checks an account and its password on one device. */
export const AD_SIGN_IN='ad-sign-in';
/** A sign-in lasts at most 8 hours, and never longer than its portal (MFA) session. */
export const AD_SESSION_LIFETIME_MS=8*60*60_000;
/** A pending sign-in waits at most 2 minutes for the device's result. */
export const AD_PENDING_LIFETIME_MS=2*60_000;
/** At most 5 failed sign-ins per portal principal in 15 minutes. */
export const AD_SIGN_IN_ATTEMPTS=5,AD_SIGN_IN_WINDOW_MS=15*60_000;
/** The maximum length of an account and of a password. */
export const AD_ACCOUNT_MAX=256,AD_PASSWORD_MAX=256;

export type AdDirectoryKind='domain'|'local';
/** The directory a device reports (security.directory of agent 4.19.0): the domain, or the computer of a workgroup server. */
export type AdDirectory={kind:AdDirectoryKind;name:string;netbiosName:string;sid:string};
/** A domain SID (or the machine SID of a workgroup server): S-1-5-21 and three sub-authorities. */
export const AD_DIRECTORY_SID=/^S-1-5-21(-\d+){3}$/;
/** An account SID: a directory SID and one RID. */
export const AD_USER_SID=/^S-1-5-21(-\d+){4}$/;

/** The reported directory of a device, or null (agents before 4.19.0, or a broken report). */
export function deviceDirectory(snapshot:Pick<ServerSnapshot,'security'>|null|undefined):AdDirectory|null{
 const value=snapshot?.security?.directory;
 if(!value||(value.kind!=='domain'&&value.kind!=='local')||!AD_DIRECTORY_SID.test(value.sid))return null;
 return value;
}
/** Whether the agent of this snapshot runs plugin changes as the account. */
export const adIdentityReady=(snapshot:Pick<ServerSnapshot,'agentCapabilities'>|null|undefined)=>snapshot?.agentCapabilities?.includes(PLUGIN_AD_IDENTITY)===true;
/** The display name of a directory: the DNS domain name, or the computer name of a workgroup server. */
export const directoryLabel=(directory:Pick<AdDirectory,'name'>)=>directory.name;

// ---- Accounts ------------------------------------------------------------------------------

export type ParsedAdAccount=
 /** account: the form the device signs in with and the portal shows (DOMAIN\name or name@suffix). */
 {ok:true;account:string;domain:string|null;user:string;upn:boolean}|
 {ok:false;code:'invalid'|'tooLong'|'localOnDomain'};
const control=/[\u0000-\u001f\u007f]/;
const part=(value:string)=>value.length>0&&!/[\\@/]/.test(value)&&value.trim()===value;
/** Whether a typed account has more than AD_ACCOUNT_MAX characters once trimmed (the dialog checks it before it sends). */
export const adAccountTooLong=(input:unknown)=>typeof input==='string'&&input.trim().length>AD_ACCOUNT_MAX;
/**
 * The account a technician types, for this directory. The input is
 * trimmed and has 1 to 256 characters (more gives tooLong) without control characters. A domain
 * device takes DOMAIN\name, name@suffix or a plain name (then NETBIOS\name).
 * A workgroup server takes name, .\name or COMPUTER\name (then COMPUTER\name).
 * A local account on a domain device (.\name or the computer name as DOMAIN)
 * is refused with localOnDomain. `computer` is the device's computer name.
 */
export function parseAdAccount(input:unknown,directory:Pick<AdDirectory,'kind'|'name'|'netbiosName'>,computer?:string|null):ParsedAdAccount{
 if(typeof input!=='string')return {ok:false,code:'invalid'};
 const value=input.trim();
 if(adAccountTooLong(value))return {ok:false,code:'tooLong'};
 if(!value||control.test(value))return {ok:false,code:'invalid'};
 const same=(left:string,right:string|null|undefined)=>!!right&&left.toUpperCase()===right.toUpperCase();
 const slash=value.indexOf('\\');
 if(directory.kind==='local'){
  if(value.includes('@'))return {ok:false,code:'invalid'};
  const domain=slash<0?null:value.slice(0,slash),user=slash<0?value:value.slice(slash+1);
  if(!part(user)||(domain!==null&&domain!=='.'&&!same(domain,directory.name)&&!same(domain,computer)))return {ok:false,code:'invalid'};
  return {ok:true,account:`${directory.name}\\${user}`,domain:directory.name,user,upn:false};
 }
 if(slash>=0){
  const domain=value.slice(0,slash),user=value.slice(slash+1);
  if(domain==='.'||same(domain,computer)&&!same(domain,directory.netbiosName))return part(user)?{ok:false,code:'localOnDomain'}:{ok:false,code:'invalid'};
  if(!part(domain)||!part(user))return {ok:false,code:'invalid'};
  return {ok:true,account:`${domain}\\${user}`,domain,user,upn:false};
 }
 const at=value.indexOf('@');
 if(at>=0){
  const user=value.slice(0,at),suffix=value.slice(at+1);
  if(!part(user)||!part(suffix)||!suffix.includes('.')&&!same(suffix,directory.netbiosName))return {ok:false,code:'invalid'};
  return {ok:true,account:value,domain:null,user:value,upn:true};
 }
 if(!part(value))return {ok:false,code:'invalid'};
 return {ok:true,account:`${directory.netbiosName}\\${value}`,domain:directory.netbiosName,user:value,upn:false};
}

// ---- Sessions ------------------------------------------------------------------------------

/** One AD session as the portal matches it: its MFA session's liveness comes from the database. */
export type AdSessionMatch={id:string;state:'pending'|'active';directorySid:string;expiresAt:number|null;mfaLive:boolean};
/**
 * The session for a device of this directory: the same directory SID
 * (case-insensitive), active, unexpired and with a live MFA session. Names
 * never match: two customers with the same domain name have other SIDs.
 */
export function adSessionFor<T extends AdSessionMatch>(sessions:readonly T[],directory:Pick<AdDirectory,'sid'>|null|undefined,now:number):T|null{
 if(!directory)return null;
 const sid=directory.sid.toUpperCase();
 return sessions.find(session=>session.state==='active'&&session.mfaLive&&session.expiresAt!==null&&session.expiresAt>now&&session.directorySid.toUpperCase()===sid)??null;
}
/** The end of a sign-in: 8 hours after the check, or the absolute end of its portal session when that comes first. */
export const adSessionExpiry=(verifiedAt:number,mfaExpiresAt:number)=>Math.min(verifiedAt+AD_SESSION_LIFETIME_MS,mfaExpiresAt);

/** Whether a plugin operation needs the AD sign-in: every operation that is no read. */
export const pluginOperationNeedsAccount=(operation:unknown)=>isPluginOperation(operation)&&!pluginOperations[operation].readOnly;
/** The plugins that have at least one change, with the device right of their changes. */
export function pluginManagePermission(plugin:unknown){
 const entry=Object.values(pluginOperations).find(definition=>definition.plugin===plugin&&!definition.readOnly);
 return entry?.permission??null;
}

/** The identity a change job carries in its signed parameters. */
export type AdActAs={sessionId:string;userSid:string;logonName:string;account:string;kind:AdDirectoryKind};
export type AdIdentity={id:string;userSid:string;account:string;upn:string|null;directoryKind:AdDirectoryKind};
/** actAs of one verified session: the UPN is the logon name when known, else DOMAIN\name. */
export const adActAs=(session:AdIdentity):AdActAs=>({sessionId:session.id,userSid:session.userSid,logonName:session.upn||session.account,account:session.account,kind:session.directoryKind});

/** The verified identity an Entra ID sign-in carries for a hybrid user (the coming Entra sign-in). */
export type EntraOnPremises={onPremisesSecurityIdentifier?:string|null;onPremisesDomainName?:string|null;onPremisesSamAccountName?:string|null;onPremisesUserPrincipalName?:string|null};
export type EntraAdIdentity={directory:AdDirectory;userSid:string;account:string;upn:string|null};
/**
 * The AD identity of a hybrid Entra user, or null without its on-premises SID
 * or domain: the directory SID is the user SID without its last RID, the
 * account <domain>\<sam> (or the UPN without a sam account name).
 */
export function entraAdIdentity(input:EntraOnPremises):EntraAdIdentity|null{
 const sid=typeof input.onPremisesSecurityIdentifier==='string'?input.onPremisesSecurityIdentifier.trim():'';
 const domain=typeof input.onPremisesDomainName==='string'?input.onPremisesDomainName.trim():'';
 if(!AD_USER_SID.test(sid)||!domain||domain.length>AD_ACCOUNT_MAX||control.test(domain))return null;
 const sam=typeof input.onPremisesSamAccountName==='string'?input.onPremisesSamAccountName.trim():'';
 const upn=typeof input.onPremisesUserPrincipalName==='string'&&input.onPremisesUserPrincipalName.trim()&&!control.test(input.onPremisesUserPrincipalName)?input.onPremisesUserPrincipalName.trim().slice(0,AD_ACCOUNT_MAX):null;
 const account=sam&&!control.test(sam)?`${domain}\\${sam}`.slice(0,AD_ACCOUNT_MAX):upn;
 if(!account)return null;
 return {directory:{kind:'domain',name:domain,netbiosName:domain.split('.')[0].toUpperCase(),sid:sid.slice(0,sid.lastIndexOf('-'))},userSid:sid,account,upn};
}

// ---- Client gates ----------------------------------------------------------------------------

/** A blocked reason of the client with its parameters. */
export type AdBlocked={key:MessageKey;params?:Record<string,string>};
type ChipDevice={name:string;lastSeen:number|null;permissions?:string[];snapshot:Pick<ServerSnapshot,'agentCapabilities'>|null;maintenance?:{state:string}|null};
/**
 * Why the sign-in of the account chip cannot start on this device,
 * in this order: demo, no manage right of the plugin, offline, an agent
 * without PLUGIN_AD_IDENTITY. `rightKey` is the plugin's own text for a
 * missing right (DHCP: dhcp.blocked.manageRight). `online` comes from
 * lib/device-connection.ts, so this module stays free of the clock rules.
 */
export function pluginAccountBlocked(device:ChipDevice,viewer:{permissions?:string[]},demo:boolean,online:boolean,gate:{permission:string;rightKey:MessageKey}):AdBlocked|null{
 if(demo)return {key:'kit.unavailable.demo'};
 // eslint-disable-next-line no-restricted-syntax -- a display gate of the client like permitted() in ui/base/api.tsx; POST /api/plugin-ad checks the right itself.
 if(!viewer.permissions?.includes('*')&&!device.permissions?.includes(gate.permission))return {key:gate.rightKey};
 if(!online)return {key:'extensions.blocked.offline'};
 if(!adIdentityReady(device.snapshot))return {key:'pluginAd.blocked.agent',params:{device:device.name}};
 return null;
}

// ---- Client: the sign-ins of this portal session -----------------------------------------------

/** One active sign-in as GET /api/plugin-ad lists it. */
export type AdSessionSummary={id:string;directory:{kind:AdDirectoryKind;name:string;sid:string};account:string;upn:string|null;source:'password'|'entra';verifiedAt:number;expiresAt:number};
/** The state of one sign-in job for the dialog's poll. */
export type AdSignInStatus={state:'pending'|'active'|'failed';code?:string;args?:Record<string,string>;session?:AdSessionSummary};
const matchable=(session:AdSessionSummary):AdSessionMatch&{summary:AdSessionSummary}=>({id:session.id,state:'active',directorySid:session.directory.sid,expiresAt:session.expiresAt,mfaLive:true,summary:session});
/** The listed sign-in that covers a device (by its reported directory SID), or null. The list holds only sessions of the live portal session. */
export function adSessionForDevice(sessions:readonly AdSessionSummary[],snapshot:Pick<ServerSnapshot,'security'>|null|undefined,now:number):AdSessionSummary|null{
 return adSessionFor(sessions.map(matchable),deviceDirectory(snapshot),now)?.summary??null;
}
/**
 * The devices of a plugin change that still need a sign-in before the
 * confirmation ("delay sign-in until needed"): one per directory, in
 * the given order. A device without PLUGIN_AD_IDENTITY or without a reported
 * directory is left out: the server names its reason itself.
 */
export function devicesWithoutAdSession<T extends {id:string;snapshot:Pick<ServerSnapshot,'security'|'agentCapabilities'>|null}>(devices:readonly T[],sessions:readonly AdSessionSummary[],now:number):T[]{
 const seen=new Set<string>(),missing:T[]=[];
 for(const device of devices){
  const directory=deviceDirectory(device.snapshot);
  if(!directory||!adIdentityReady(device.snapshot))continue;
  const sid=directory.sid.toUpperCase();
  if(seen.has(sid))continue;seen.add(sid);
  if(!adSessionForDevice(sessions,device.snapshot,now))missing.push(device);
 }
 return missing;
}
/** Where the dialog shows a failure: a wrong password under Password, an account the server or the device refused under Account, everything else as a notice. */
export function adSignInField(code?:string,messageKey?:string):'account'|'password'|'notice'{
 if(code==='AGENT_AD_SIGN_IN_FAILED'||messageKey==='apiError.pluginAd.passwordRequired')return 'password';
 if(code==='AGENT_AD_LOCAL_ACCOUNT'||messageKey==='apiError.pluginAd.accountInvalid'||messageKey==='apiError.pluginAd.accountTooLong'||messageKey==='apiError.pluginAd.accountInvalidLocal'||messageKey==='apiError.pluginAd.localOnDomain')return 'account';
 return 'notice';
}
