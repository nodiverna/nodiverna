'use client';
import {useCallback,useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {ShieldCheck} from 'lucide-react';
import {toast} from 'sonner';
import type {Viewer} from '@/lib/types';
import type {SessionSettingsView} from '@/lib/server/identity/session-settings';
import {sessionSettingsActionNeedsStepUp} from '@/lib/step-up';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {api} from '@/ui/base/api';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {useStepUp} from '@/ui/session/step-up-retry';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {Card,SettingsPage} from '@/ui/kit/kit';
import {Field,FormActions,Select,Switch} from '@/ui/kit/field';
import {useLocale,useT} from '@/ui/base/locale';
// Settings › Sessions (Owners only, docs/portal-sessions.md): the automatic sign-out after inactivity and the MFA after
// an automatic sign-out (on: every sign-in asks for MFA; off: the MFA grant of mfaGrantHours applies), in one card with one Save. It shows and changes the real settings also with demo devices,
// because they belong to the installation. Saving sends both values in one request with one fresh MFA proof
// (lib/step-up.ts, rule 6) through useStepUp.
export const sessionSettingsPaletteKeywords:MessageKey='sessionSettings.paletteKeywords';
export const sessionSettingsLoadError:MessageKey='sessionSettings.loadError';
export const idleTimeoutLabel=(minutes:number,defaultMinutes:number,locale:Locale=defaultLocale)=>minutes===defaultMinutes?translate(locale,'sessionSettings.minutesDefault',{minutes}):translate(locale,'sessionSettings.minutes',{minutes});
// A reply of an older server without the field counts as on, the secure default.
const idleRequiresMfaOf=(view:SessionSettingsView)=>view.idleRequiresMfa!==false;
type Draft={minutes:number;requireMfa:boolean};
const draftOf=(view:SessionSettingsView):Draft=>({minutes:view.idleTimeoutMinutes,requireMfa:idleRequiresMfaOf(view)});
const sameDraft=(a:Draft,b:Draft)=>a.minutes===b.minutes&&a.requireMfa===b.requireMfa;
const endpoint='/api/session-settings';

/** Settings › Sessions; the page header of the console frame at its top (ui/shell/page-frame.ts). */
export default function SessionSettingsPanel({viewer,frame}:{viewer:Viewer;frame?:PageFrame}){
 const t=useT(),[locale]=useLocale();
 const [settings,setSettings]=useState<SessionSettingsView|null>(null),[draft,setDraft]=useState<Draft|null>(null),[loadFailed,setLoadFailed]=useState(false),[loading,setLoading]=useState(true);
 const mounted=useRef(false),sequence=useRef(0),loaded=useRef<SessionSettingsView|null>(null);
 // A refresh keeps a changed draft; an unchanged one (and the first load) follows the answer.
 const load=useCallback(async()=>{
  const current=++sequence.current;setLoading(true);
  try{
   const result=await api<SessionSettingsView>(endpoint);
   if(!mounted.current||current!==sequence.current)return;
   const before=loaded.current;loaded.current=result;
   setSettings(result);setLoadFailed(false);setDraft(previous=>!previous||!before||sameDraft(previous,draftOf(before))?draftOf(result):previous);
  }catch{if(mounted.current&&current===sequence.current)setLoadFailed(true);}
  finally{if(mounted.current&&current===sequence.current)setLoading(false);}
 },[]);
 useEffect(()=>{mounted.current=true;void Promise.resolve().then(load);return ()=>{mounted.current=false;};},[load,viewer.id]);
 useFrameRefresh(frame,load);
 const save=useStepUp<Record<string,unknown>,SessionSettingsView>({locale,needsStepUp:payload=>sessionSettingsActionNeedsStepUp(payload.action),send:payload=>api<SessionSettingsView>(endpoint,payload)});
 const baseline=settings?draftOf(settings):null;
 const dirty=!!draft&&!!baseline&&!sameDraft(draft,baseline);
 const submit=async(event:FormEvent)=>{
  event.preventDefault();
  if(!draft||!dirty||save.busy)return;
  // One request with both values and one proof; cancelling the MFA dialog sends nothing and keeps the draft.
  const result=await save.run({action:'set',idleTimeoutMinutes:draft.minutes,idleRequiresMfa:draft.requireMfa});
  if(!result||!mounted.current)return;
  loaded.current=result;setSettings(result);setDraft(draftOf(result));
  toast.success(t('sessionSettings.savedAll'));
 };
 const page=(children:ReactNode)=><>{frameHeader(frame)}<SettingsPage label={t('nav.settings.sessions')} loading={!settings&&!loadFailed}
  loadError={loadFailed?t(sessionSettingsLoadError):undefined} onRetry={()=>void load()} retrying={loading}>{children}</SettingsPage></>;
 if(!settings||!draft)return page(null);
 const blocked=save.busy?t('kit.busy'):undefined;
 return page(<>
  <Card title={t('sessionSettings.card')} description={t('sessionSettings.cardText')} icon={ShieldCheck} iconTone="accent" id="sdx-session-rules">
   <form className="sdx-form-grid" onSubmit={event=>void submit(event)}>
    <Field label={t('sessionSettings.signOutAfter')} hint={t('sessionSettings.signOutHint')}>
     <Select fit value={draft.minutes} blocked={blocked} onChange={event=>setDraft(previous=>previous&&{...previous,minutes:Number(event.target.value)})}>
      {settings.options.map(minutes=><option key={minutes} value={minutes}>{idleTimeoutLabel(minutes,settings.defaultMinutes,locale)}</option>)}
     </Select>
    </Field>
    {/* A form field: the switch changes the draft only; Save sends it. */}
    <Switch label={t('settings.idleMfa.switch')} hint={t(draft.requireMfa?'settings.idleMfa.hintOn':'settings.idleMfa.hintOff',{count:settings.mfaGrantHours})} checked={draft.requireMfa} blocked={blocked}
     onChange={next=>setDraft(previous=>previous&&{...previous,requireMfa:next})}/>
    <FormActions dirty={dirty} busy={save.busy} loading={save.sending} onDiscard={()=>setDraft(baseline)}/>
   </form>
  </Card>
  <MfaStepUp {...save.dialog}/>
 </>);
}
