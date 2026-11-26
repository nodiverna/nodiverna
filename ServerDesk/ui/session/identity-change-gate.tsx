'use client';
import {Info} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import PortalRecheck from '@/ui/session/portal-recheck';
import type {IdentityReply} from '@/ui/session/portal-identity';
import {useT} from '@/ui/base/locale';
import {Notice} from '@/ui/kit/kit';
import {SessionCard} from '@/ui/session/session-card';

// Shown when the account or its rights changed during the session: the user
// checks the sign-in again before the portal continues.
export default function IdentityChangeGate({viewer,reason,onVerified,onIdentityChange}:{viewer:Viewer;reason:string;onVerified:(reply:IdentityReply,signal:AbortSignal)=>void|Promise<void>;onIdentityChange:()=>void}){
 const t=useT();
 return <SessionCard id="identity-change-title" title={t('session.identityChangeTitle')}>
  <Notice tone="info" icon={Info}>{reason}</Notice>
  <PortalRecheck expected={viewer} onVerified={onVerified} onIdentityChange={onIdentityChange}/>
 </SessionCard>;
}
