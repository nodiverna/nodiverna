import type {Viewer} from '@/lib/types';
import type {SessionTiming} from '@/ui/session/session-state';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';
export type ExpectedIdentity={id?:string;label:string};
export type RecoverySession=SessionTiming&{enabled:boolean;available:boolean;idleTimeoutMs:number;serverTime:number;passkeyCount?:number};
export type IdentityReply={viewer:Viewer;session:RecoverySession};
export function readIdentityReply(value:unknown,locale:Locale=defaultLocale):IdentityReply{
 const reply=value as Partial<IdentityReply>|null,viewer=reply?.viewer,session=reply?.session;
 if(!viewer||typeof viewer.id!=='string'||!viewer.id.trim()||typeof viewer.label!=='string'||!viewer.label.trim()||!session||typeof session.authenticated!=='boolean'||typeof session.enabled!=='boolean'||typeof session.available!=='boolean'||!Number.isFinite(session.serverTime)||!Number.isFinite(session.idleTimeoutMs))throw new Error(translate(locale,'identity.loginUnverified'));
 if(session.authenticated&&(!session.sessionId||!Number.isFinite(session.idleExpiresAt)||!Number.isFinite(session.sessionExpiresAt)||!Number.isFinite(session.lastActivityAt)||session.idleExpiresAt!<=session.serverTime||session.sessionExpiresAt!<=session.serverTime))throw new Error(translate(locale,'identity.sessionInvalid'));
 return reply as IdentityReply;
}
export function samePortalIdentity(expected:ExpectedIdentity,actual:Viewer){return (!expected.id||expected.id===actual.id)&&expected.label.trim().toLowerCase()===actual.label.trim().toLowerCase();}
