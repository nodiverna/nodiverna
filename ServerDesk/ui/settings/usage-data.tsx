'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ChartColumn} from 'lucide-react';
import {toast} from 'sonner';
import type {Viewer} from '@/lib/types';
import type {UsageDataView} from '@/lib/server/usage-data';
import {formatDate} from '@/lib/i18n/format';
import {translate} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {canManageInstanceSettings} from '@/ui/base/access-capabilities';
import {api,ApiError,message} from '@/ui/base/api';
import {Btn,Card,Facts} from '@/ui/kit/kit';
import {Switch} from '@/ui/kit/field';
import {Dialog} from '@/ui/kit/confirm-dialog';
import {useLocale,useT} from '@/ui/base/locale';
import '@/ui/settings/usage-data.css';
// Usage data for product improvement (docs/usage-data.md): the question at the first setup and the card on the page
// Usage data. Both belong to the installation, so they also appear with demo devices.
// Withdrawing must be as easy as agreeing: no MFA, two equal answers, and "Don't send" always possible.
// Whether the function is on comes only from the server as view.enabled (the one switch is in runtime/usage-report.mjs).
export type {UsageDataView};
const route='/api/usage-data';
// A day as dd.mm.yyyy in the locale.
const usageDate=(ms:number,locale:Locale)=>formatDate(locale,ms,{day:'2-digit',month:'2-digit',year:'numeric'});

/** The question opens only while usage data is on, for Owners only, and only while nobody has decided yet. */
export function shouldAskUsageConsent(viewer:Viewer,view:Pick<UsageDataView,'enabled'|'consent'>|null|undefined){return view?.enabled===true&&canManageInstanceSettings(viewer)&&view.consent===null;}

export function usageErrorText(code:string|null|undefined,locale:Locale=defaultLocale){
 const http=/^http-(\d{3})$/.exec(code??'');
 if(http)return translate(locale,'usage.error.http',{value:http[1]});
 if(code==='timeout')return translate(locale,'usage.error.timeout');
 if(code==='network')return translate(locale,'usage.error.network');
 return translate(locale,'usage.error.unknown');
}

export function usageStatusText(view:Pick<UsageDataView,'consent'|'server'|'lastAttemptAt'|'lastSuccessAt'|'lastError'>,locale:Locale=defaultLocale){
 if(view.consent!==true)return view.consent===null?translate(locale,'usage.status.undecided'):translate(locale,'usage.status.off');
 if(view.server==='none')return translate(locale,'usage.status.noServer');
 if(view.server==='invalid')return translate(locale,'usage.status.invalidServer');
 if(view.lastError&&view.lastAttemptAt!==null&&(view.lastSuccessAt===null||view.lastAttemptAt>view.lastSuccessAt))return translate(locale,'usage.status.failed',{usageDate:usageDate(view.lastAttemptAt,locale),usageErrorText:usageErrorText(view.lastError,locale)});
 if(view.lastSuccessAt!==null)return translate(locale,'usage.status.sent',{usageDate:usageDate(view.lastSuccessAt,locale)});
 return translate(locale,'usage.status.notSent');
}
/** Why the switch cannot change while no usable usage data server is set; null with a configured server. */
export function usageServerBlock(view:Pick<UsageDataView,'server'>,locale:Locale=defaultLocale):string|null{
 return view.server==='none'?translate(locale,'usage.status.noServer'):view.server==='invalid'?translate(locale,'usage.status.invalidServer'):null;
}

/** The three values that are sent, with their catalog labels, exactly as in the payload. */
export function UsageValues({payload}:{payload:UsageDataView['payload']}){
 const t=useT();
 return <Facts className="sdx-usage-values" items={[
  {id:'instance',label:t('usage.instanceId'),value:payload.instanceId,mono:true},
  {id:'version',label:t('usage.version'),value:payload.version},
  {id:'devices',label:t('usage.devices'),value:payload.deviceCount},
 ]}/>;
}

/** GET /api/usage-data once on mount; load() asks again (a refresh keeps the shown view). */
export function useUsageData(){
 const [view,setView]=useState<UsageDataView|null>(null),[loadError,setLoadError]=useState('');
 const mounted=useRef(false);
 const load=useCallback(async()=>{
  try{const result=await api<UsageDataView>(route);if(mounted.current){setView(result);setLoadError('');}}
  catch(e){if(mounted.current)setLoadError(message(e));}
 },[]);
 useEffect(()=>{mounted.current=true;void Promise.resolve().then(load);return ()=>{mounted.current=false;};},[load]);
 return {view,setView,loadError,load,mounted};
}
/** Saves a decision; a 409 (decided elsewhere meanwhile) loads the view again before the failure goes on. */
async function saveDecision(enabled:boolean,view:UsageDataView,reload:()=>Promise<void>):Promise<UsageDataView>{
 try{return await api<UsageDataView>(route,{action:'set',enabled,revision:view.revision});}
 catch(e){if(e instanceof ApiError&&e.status===409)await reload();throw e;}
}

/**
 * The question at the first setup. The console mounts it for Owners only; it loads the decision once and opens while
 * it is still undecided. Two equal answers, nothing preselected, and the first focus on "Don't send", so Enter sends no
 * data. Esc or a scrim click close it without saving; it asks again with the next console load.
 */
export default function UsageConsentDialog({viewer}:{viewer:Viewer}){
 const t=useT();
 const {view,setView,load,mounted}=useUsageData();
 const [dismissed,setDismissed]=useState(false),[saving,setSaving]=useState<boolean|null>(null);
 const busyRef=useRef(false);
 const open=!dismissed&&shouldAskUsageConsent(viewer,view);
 const answer=async(enabled:boolean)=>{
  if(busyRef.current||!view)return;busyRef.current=true;setSaving(enabled);
  try{
   const result=await saveDecision(enabled,view,load);if(!mounted.current)return;
   setView(result);toast.success(t(enabled?'usage.saved.on':'usage.saved.off'));
  }catch(e){if(mounted.current)toast.error(message(e));}
  finally{busyRef.current=false;if(mounted.current)setSaving(null);}
 };
 const button=(enabled:boolean)=><Btn loading={saving===enabled} blocked={saving!==null&&saving!==enabled?t('kit.busy'):undefined} onClick={()=>void answer(enabled)}>{t(enabled?'usage.switch':'usage.consent.dontSend')}</Btn>;
 return <Dialog open={open} onOpenChange={next=>{if(!next&&!busyRef.current)setDismissed(true);}} className="sdx-usage-dialog" title={t('usage.title')} description={t('usage.consentText')}
  footer={<>{button(false)}{button(true)}</>}>
  {view&&<UsageValues payload={view.payload}/>}
  <p className="sdx-usage-hint">{t('usage.consentNo')}</p>
  {view&&view.server!=='configured'&&<p className="sdx-usage-hint">{t('usage.noServer')}</p>}
 </Dialog>;
}

/**
 * The card "Data for product improvement" on the page Usage data (ui/settings/usage-data-page.tsx). The switch saves at once
 * without MFA and rolls back with an error toast. Without a usable usage data server it is blocked with the reason and
 * shows Off; a stored "send" stays and "Don't send" withdraws it. While usage data is off (view.enabled false) the
 * switch is Off and blocked with the notice, and there is no kept choice and no "Don't send": the page shows the card
 * inert and blurred under the notice.
 */
export function UsageDataCard({view,onChange,reload}:{view:UsageDataView;onChange:(view:UsageDataView)=>void;reload:()=>Promise<void>}){
 const t=useT(),[locale]=useLocale();
 const [withdrawing,setWithdrawing]=useState(false);
 const block=view.enabled?usageServerBlock(view,locale):t('usage.disabled.notice'),kept=view.enabled&&!!block&&view.consent===true;
 const save=async(enabled:boolean)=>{
  const result=await saveDecision(enabled,view,reload);
  onChange(result);toast.success(t(enabled?'usage.saved.on':'usage.saved.off'));
 };
 const withdraw=async()=>{
  if(withdrawing)return;setWithdrawing(true);
  try{await save(false);}catch(e){toast.error(message(e));}finally{setWithdrawing(false);}
 };
 return <Card title={t('usage.title')} description={t('usage.sectionHint')} icon={ChartColumn} iconTone="accent" id="sdx-usage-data">
  <div className="sdx-usage-body">
   {/* The reason is said once: while blocked, the status line is left out. */}
   <Switch label={t('usage.switch')} checked={!block&&view.consent===true} hint={block?undefined:usageStatusText(view,locale)} blocked={block} busy={withdrawing} onChange={save}/>
   {kept&&<div className="sdx-usage-kept"><p>{t('usage.keptChoice')}</p><Btn size="sm" loading={withdrawing} onClick={()=>void withdraw()}>{t('usage.consent.dontSend')}</Btn></div>}
   <div className="sdx-usage-sent"><h3>{t('usage.whatIsSent')}</h3><UsageValues payload={view.payload}/></div>
  </div>
 </Card>;
}
