'use client';

import {startRegistration,startAuthentication,WebAuthnAbortService,type PublicKeyCredentialCreationOptionsJSON,type PublicKeyCredentialRequestOptionsJSON} from '@simplewebauthn/browser';
import {api,ApiError,message} from '@/ui/base/api';
import type {SessionTiming} from '@/ui/session/session-state';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';

export type PasskeyDevice='local'|'phone';
export type PasskeyRecord={id:string;name:string;device:PasskeyDevice;createdAt:number;lastUsedAt:number|null;backedUp:boolean;deviceType:string};
// authenticatorCount is absent in replies of older servers; callers then keep the
// authenticator-code UI.
export type PasskeyStatus={available:boolean;passkeys:PasskeyRecord[];count:number;canManage:boolean;authenticatorCount?:number};
// The reply sets the MFA session cookie; its body never carries a session token.
export type PasskeySessionReply=SessionTiming&{enabled:boolean;available:boolean;passkeyCount:number;idleTimeoutMs:number;serverTime:number;ok?:boolean;managementToken?:string;managementExpiresAt?:number};
export type PasskeySetupReply=PasskeySessionReply&{recoveryCodes:string[]};

export type PasskeySupportProblem='passkeys.support.checking'|'passkeys.support.https'|'passkeys.support.directTab'|'passkeys.support.browser';

/** Why this browser cannot use Passkeys here, as a message key, or null. */
export function passkeySupportProblem():PasskeySupportProblem|null{
  if(typeof window==='undefined')return 'passkeys.support.checking';
  if(!window.isSecureContext)return 'passkeys.support.https';
  if(window.top!==window.self)return 'passkeys.support.directTab';
  if(!window.PublicKeyCredential||!navigator.credentials)return 'passkeys.support.browser';
  return null;
}

export function passkeySupportError(locale:Locale=defaultLocale):string|null{
  const problem=passkeySupportProblem();
  return problem&&translate(locale,problem);
}

/** Thrown before a ceremony when the browser cannot use Passkeys; passkeyError translates it. */
class PasskeyUnsupported extends Error{
  constructor(readonly key:MessageKey){super(translate(defaultLocale,key));this.name='PasskeyUnsupported';}
}

export function passkeyError(error:unknown,locale:Locale=defaultLocale):string{
  if(error instanceof ApiError)return message(error);
  if(error instanceof PasskeyUnsupported)return translate(locale,error.key);
  const detail=error instanceof Error?error as Error&{code?:string;cause?:{name?:string}}:null;
  const name=detail?.cause?.name??detail?.name,code=detail?.code;
  if(name==='AbortError'||code==='ERROR_CEREMONY_ABORTED')return translate(locale,'passkeys.error.aborted');
  if(name==='NotAllowedError')return translate(locale,typeof window!=='undefined'&&window.top!==window.self?'passkeys.error.notAllowedFrame':'passkeys.error.notAllowed');
  if(name==='InvalidStateError'||code==='ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED')return translate(locale,'passkeys.error.registered');
  if(name==='SecurityError'||code==='ERROR_INVALID_DOMAIN'||code==='ERROR_INVALID_RP_ID')return translate(locale,'passkeys.error.domain');
  if(name==='NotSupportedError'||name==='ConstraintError'||code?.includes('MISSING_')||code==='ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG')return translate(locale,'passkeys.error.unsupported');
  if(error instanceof TypeError)return translate(locale,'passkeys.error.network');
  return translate(locale,'passkeys.error.failed');
}

export function cancelPasskey(){WebAuthnAbortService.cancelCeremony();}

function ensureReady(signal?:AbortSignal){
  signal?.throwIfAborted();
  const unsupported=passkeySupportProblem();
  if(unsupported)throw new PasskeyUnsupported(unsupported);
}

export async function registerPasskey(name:string,device:PasskeyDevice,signal?:AbortSignal,managementToken?:string){
  ensureReady(signal);
  const cancelled=()=>cancelPasskey();signal?.addEventListener('abort',cancelled,{once:true});
  try{
    const {challengeId,options}=await api<{challengeId:string;options:PublicKeyCredentialCreationOptionsJSON}>('/api/passkeys',{action:'registration-options',name:name.trim(),device,managementToken},signal);
    signal?.throwIfAborted();
    const response=await startRegistration({optionsJSON:options});
    signal?.throwIfAborted();
    return await api<{ok:boolean}>('/api/passkeys',{action:'registration-verify',challengeId,response},signal);
  }finally{signal?.removeEventListener('abort',cancelled);}
}

// First MFA enrollment with a passkey: the reply is a signed-in MFA session with
// new recovery codes.
export async function setupPasskey(device:PasskeyDevice,signal?:AbortSignal){
  ensureReady(signal);
  const cancelled=()=>cancelPasskey();signal?.addEventListener('abort',cancelled,{once:true});
  try{
    const {challengeId,options}=await api<{challengeId:string;options:PublicKeyCredentialCreationOptionsJSON}>('/api/passkeys',{action:'setup-options',device},signal);
    signal?.throwIfAborted();
    const response=await startRegistration({optionsJSON:options});
    signal?.throwIfAborted();
    return await api<PasskeySetupReply>('/api/passkeys',{action:'setup-verify',challengeId,response},signal);
  }finally{signal?.removeEventListener('abort',cancelled);}
}

export async function authenticatePasskey(device:PasskeyDevice|'any'='any',signal?:AbortSignal){
  ensureReady(signal);
  const cancelled=()=>cancelPasskey();signal?.addEventListener('abort',cancelled,{once:true});
  try{
    const {challengeId,options}=await api<{challengeId:string;options:PublicKeyCredentialRequestOptionsJSON}>('/api/passkeys',{action:'authentication-options',device},signal);
    signal?.throwIfAborted();
    const response=await startAuthentication({optionsJSON:options});
    signal?.throwIfAborted();
    return await api<PasskeySessionReply>('/api/passkeys',{action:'authentication-verify',challengeId,response},signal);
  }finally{signal?.removeEventListener('abort',cancelled);}
}
