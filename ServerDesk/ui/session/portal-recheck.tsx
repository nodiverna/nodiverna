'use client';
import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {AlertTriangle,RefreshCw} from 'lucide-react';
import {Btn,Notice} from '@/ui/kit/kit';
import {api,message} from '@/ui/base/api';
import {captureServerClock} from '@/ui/base/http';
import {readIdentityReply,samePortalIdentity,type ExpectedIdentity,type IdentityReply} from '@/ui/session/portal-identity';
import {useLocale,useT} from '@/ui/base/locale';

export default function PortalRecheck({expected,onVerified,onIdentityChange,label}:{expected?:ExpectedIdentity;onVerified?:(reply:IdentityReply,signal:AbortSignal)=>void|Promise<void>;onIdentityChange?:()=>void;label?:string}){
 const t=useT(),[locale]=useLocale(),router=useRouter(),[busy,setBusy]=useState(false),[error,setError]=useState(''),mounted=useRef(false),inFlight=useRef(false),generation=useRef(0),controller=useRef<AbortController|null>(null);
 const identityKey=JSON.stringify(expected);
 // eslint-disable-next-line react-hooks/exhaustive-deps -- generation is a generation counter, not DOM refs; the cleanup increments it so that late responses are dropped.
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;controller.current?.abort();};},[]);
 useEffect(()=>{generation.current++;controller.current?.abort();inFlight.current=false;setBusy(false);setError('');},[identityKey]);
 const recheck=async()=>{
  if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');
  const at=++generation.current,abort=new AbortController();controller.current=abort;
  let timedOut=false,timer:ReturnType<typeof setTimeout>|undefined;
  try{
   timer=setTimeout(()=>{timedOut=true;abort.abort();},8000);
   const reply=readIdentityReply(await api('/api/identity',undefined,abort.signal),locale);
   if(!mounted.current||at!==generation.current||abort.signal.aborted)return;
   if(expected&&!samePortalIdentity(expected,reply.viewer)){onIdentityChange?.();router.refresh();return;}
   captureServerClock('/api/mfa',undefined,reply.session);
   if(onVerified)await onVerified(reply,abort.signal);else router.refresh();
  }catch(cause){if(mounted.current&&at===generation.current){
    setError(timedOut?t('session.recheckTimeoutShort'):message(cause));
  }}
  finally{if(timer!==undefined)clearTimeout(timer);if(mounted.current&&at===generation.current){inFlight.current=false;setBusy(false);controller.current=null;}}
 };
 return <>{error&&<Notice tone="danger" icon={AlertTriangle}>{error}</Notice>}<Btn variant="primary" className="sd-session-primary" icon={RefreshCw} loading={busy} onClick={()=>void recheck()}>{label??t('session.recheckConnection')}</Btn></>;
}
