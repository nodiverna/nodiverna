import {createPrivateKey,createPublicKey,sign,type KeyObject} from 'node:crypto';
import {HttpError} from '../../errors/http-error';

// The agent's SYSTEM broker executes only work that carries this portal's
// ECDSA P-256 signature. Its public key is pinned in the device's protected
// configuration at installation, separately from the release publisher key.
// The unprivileged worker forwards these envelopes unchanged; the broker
// verifies the exact payload bytes, so no canonical JSON form is needed.
// plugin-policy (agent 4.16.0): the plugin operations the broker runs on its own schedule (docs/agent-plugins.md).
export type DispatchKind='job'|'transfer'|'drift-policy'|'terminal'|'plugin-policy';
export type SignedDispatch={payload:string;signature:string};
export const DISPATCH_LIFETIME_SECONDS=15*60,TERMINAL_LEASE_SECONDS=60;

/** The 503 AGENT_JOB_SIGNING_KEY_INVALID for a failed dispatchSigner() call. */
export function signingKeyFailure(error:unknown):HttpError{return error instanceof HttpError?error:new HttpError('apiError.signing.keyUnreadable');}

export type DispatchSigner={publicKey:string;sign(deviceId:string,kind:DispatchKind,body:Record<string,unknown>,lifetimeSeconds:number,time:number):SignedDispatch};
let cached:{source:string;signer:DispatchSigner}|null=null;

// Accepts a PKCS#8 PEM, or the same key as single-line base64 DER for
// environment files that cannot hold multi-line values.
export function dispatchSigner(source:string):DispatchSigner|null{
 const value=source.trim();if(!value)return null;
 if(cached?.source===value)return cached.signer;
 let key:KeyObject;
 try{key=value.includes('-----BEGIN')?createPrivateKey(value):createPrivateKey({key:Buffer.from(value,'base64'),format:'der',type:'pkcs8'});}
 catch{throw new HttpError('apiError.signing.keyUnreadable');}
 if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw new HttpError('apiError.signing.keyType');
 const publicKey=createPublicKey(key).export({type:'spki',format:'der'}).toString('base64');
 const signer:DispatchSigner={publicKey,sign(deviceId,kind,body,lifetimeSeconds,time){
  const iat=Math.floor(time/1000);
  const payload=JSON.stringify({...body,v:1,kind,deviceId,iat,exp:iat+lifetimeSeconds});
  return {payload,signature:sign('sha256',Buffer.from(payload,'utf8'),{key,dsaEncoding:'ieee-p1363'}).toString('base64')};
 }};
 cached={source:value,signer};return signer;
}
