export type SessionTiming={
 authenticated:boolean;sessionId:string|null;lastActivityAt:number|null;
 verifiedUntil:number|null;idleExpiresAt:number|null;sessionExpiresAt:number|null;
};
export function sessionExpired(status:SessionTiming|null,time:number){
 return !!status?.authenticated&&((status.idleExpiresAt??0)<=time||(status.sessionExpiresAt??0)<=time);
}
export function mergeSessionStatus<T extends SessionTiming>(previous:T|null,next:T):T{
 // A slow status read may arrive after a successful activity update. Keep the
 // newer deadline only for the same authenticated session, never across logout,
 // revocation, a fresh login, or a shorter hard session/trust deadline.
 if(previous?.authenticated&&next.authenticated&&previous.sessionId&&previous.sessionId===next.sessionId&&(next.lastActivityAt??0)<(previous.lastActivityAt??0)){
  const hard=next.sessionExpiresAt??0,idle=Math.min(hard,previous.idleExpiresAt??0);
  return {...next,lastActivityAt:previous.lastActivityAt,idleExpiresAt:idle,verifiedUntil:Math.min(hard,idle)};
 }
 return next;
}
