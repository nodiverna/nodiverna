'use client';
// Whether this browser can run a passkey ceremony here, shared by the classic passkey choice
// (passkeys-panel.tsx: sign-in, first setup) and the kit step-up dialog (mfa-step-up.tsx).
import {useSyncExternalStore} from 'react';
import {passkeySupportProblem,type PasskeySupportProblem} from '@/ui/session/passkey-client';
import {useT} from '@/ui/base/locale';

const subscribeToSupport=()=>()=>{};
const supportPending=():PasskeySupportProblem=>'passkeys.support.checking';
/** The support problem as a message key (null when passkeys work); the caller translates it. */
export const usePasskeySupport=()=>useSyncExternalStore(subscribeToSupport,passkeySupportProblem,supportPending);

/** In an embedded frame WebAuthn needs the portal in its own tab: a link that opens the account page there. */
export function DirectTabLink({unsupported,className='download-link'}:{unsupported:PasskeySupportProblem|null;className?:string}){
  const t=useT();
  if(unsupported!=='passkeys.support.directTab'||typeof window==='undefined')return null;
  return <a className={className} href={window.location.origin+window.location.pathname+'#account'} target="_blank" rel="noopener noreferrer">{t('common.openOwnTab')}</a>;
}
