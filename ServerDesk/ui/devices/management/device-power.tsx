'use client';
// The shared power flow of a device (Restart… and Shut down…): the device menu, the fleet row menu and the two buttons
// of the System card open the same drawer "Prepare restart" or "Prepare shutdown" with the lead time and the reason.
// "Review change" opens the console confirmation ("Restart server?" / "Shut down server?"), whose verb names the
// action again; confirming queues the restart-computer or shutdown-computer job. Every step checks the blocked reason
// of the live device again (systemActionReason), so a device that went offline or lost the right meanwhile queues nothing.
import {useRef,useState,type FormEvent,type RefObject} from 'react';
import type {Viewer} from '@/lib/types';
import {deviceConnection} from '@/ui/base/ui-device';
import {confirmationDevice} from '@/ui/devices/management/management-actions';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';
import {permitted,type Device} from '@/ui/base/api';
import type {Confirmation} from '@/ui/base/confirmation';
import {Btn,Drawer} from '@/ui/kit/kit';
import {Field} from '@/ui/kit/field';
import {useLocale,useT} from '@/ui/base/locale';
import {consoleClock,useClockNow} from '@/ui/base/clock-store';
import '@/ui/devices/management/device-system.css';

export type PowerKind='restart-computer'|'shutdown-computer';
/** The device and the operation the drawer is open for; null closes it. */
export type PowerTarget={serverId:string;kind:PowerKind};
type ReasonInput={server:Device;viewer:Viewer;demo:boolean;saving:boolean;now:number};
const scheduleActions=['schedule-power','cancel-power-schedule'];

/** Why a system action is blocked, as a full sentence, or ''. The order is fixed: sample device, saving, revoked, right, offline, Read-only mode, agent. */
export function systemActionReason(props:ReasonInput,kind:string,locale:Locale=defaultLocale){
 const {server,viewer,demo,saving,now}=props,snapshot=server.snapshot;
 if(demo)return translate(locale,'kit.unavailable.demo');
 if(saving)return translate(locale,'services.blocked.saving');
 if(server.revoked)return translate(locale,'kit.unavailable.revoked');
 if(!permitted(server,viewer,kind==='refresh'?'diagnose':'manage'))return kind==='refresh'?translate(locale,'management.blocked.diagnose'):translate(locale,'management.blocked.manage');
 if(deviceConnection(server,now).kind!=='online')return translate(locale,'management.blocked.offline');
 if(kind!=='refresh'&&(server.management!==1||snapshot?.mode!=='Management'))return translate(locale,'management.blocked.readOnly');
 if(!snapshot?.agentCapabilities?.includes(kind))return scheduleActions.includes(kind)?translate(locale,'system.blocked.scheduleUpdate'):translate(locale,'management.blocked.unsupported');
 return '';
}

/** The lead time (60–3600 seconds) and the reason (1–200 characters, no control characters) of a restart or shutdown, or null when one is invalid. */
export function powerInput(delaySeconds:string,reason:string):{delaySeconds:number;reason:string}|null{
 const seconds=Number(delaySeconds),text=reason.trim();
 return Number.isInteger(seconds)&&seconds>=60&&seconds<=3600&&text&&text.length<=200&&!/[\u0000-\u001f]/.test(text)?{delaySeconds:seconds,reason:text}:null;
}

/** The confirmation of a restart or shutdown: the question, the device line, the verb of the action and the job. Shutting down is the danger tone. */
export function powerConfirmation(server:Pick<Device,'id'|'name'>,kind:PowerKind,input:{delaySeconds:number;reason:string},locale:Locale=defaultLocale):Confirmation{
 const restart=kind==='restart-computer';
 return {
  title:translate(locale,restart?'system.power.restartTitle':'system.power.shutdownTitle'),
  description:translate(locale,restart?'system.power.restartDescription':'system.power.shutdownDescription',{delaySeconds:input.delaySeconds,reason:input.reason}),
  lines:confirmationDevice(server.name,locale),
  confirmLabel:translate(locale,restart?'management.power.restart':'management.power.shutdown'),
  ...(restart?{}:{tone:'danger' as const}),
  payload:{action:'job',id:server.id,kind,params:{delaySeconds:input.delaySeconds,reason:input.reason},confirm:true},
 };
}

type DrawerProps=Omit<ReasonInput,'server'|'now'>&{
 /** Pins the time (tests); without it the open drawer follows the console clock. */
 now?:number;
 target:PowerTarget|null;
 /** The devices the target may name; the drawer reads the target device from them on every step. */
 servers:readonly Device[];
 onConfirm:(confirmation:Confirmation)=>void;onClose:()=>void;
 /** The control that opened the drawer (a menu trigger); focus goes back to it on close. */
 returnFocus?:RefObject<HTMLElement|null>;
};
type Draft={target:PowerTarget|null;delaySeconds:string;reason:string;error:boolean};

/** The drawer "Prepare restart" or "Prepare shutdown": lead time, reason, then "Review change". */
export function PowerDrawer(props:DrawerProps){
 const {target,servers,viewer,demo,saving,onClose,returnFocus}=props;
 const t=useT(),[locale]=useLocale(),live=useRef(props);live.current=props;
 // The clock while a target is open (its reason says when the device is offline); a closed drawer does not follow it.
 const now=useClockNow(props.now,time=>target?time:0);
 // A new target starts a fresh form (the default lead time of five minutes, no reason).
 const [state,setState]=useState<Draft>({target:null,delaySeconds:'300',reason:'',error:false});
 const draft=state.target===target?state:{target,delaySeconds:'300',reason:'',error:false};
 const change=(values:Partial<Draft>)=>setState({...draft,error:false,...values});
 const server=target?servers.find(item=>item.id===target.serverId):undefined;
 const reason=target&&server?systemActionReason({server,viewer,demo,saving,now},target.kind,locale):'';
 const submit=(event:FormEvent)=>{
  event.preventDefault();
  const current=live.current,chosen=current.target,device=chosen?current.servers.find(item=>item.id===chosen.serverId):undefined;
  if(!chosen||!device||chosen!==draft.target||systemActionReason({...current,now:current.now??consoleClock.now(),server:device},chosen.kind,locale))return;
  const input=powerInput(draft.delaySeconds,draft.reason);
  if(!input){change({error:true});return;}
  current.onConfirm(powerConfirmation(device,chosen.kind,input,locale));
  current.onClose();
 };
 const restart=target?.kind!=='shutdown-computer';
 return <Drawer open={!!target&&!!server} onClose={onClose} returnFocus={returnFocus} title={t(restart?'system.prepareRestart':'system.prepareShutdown')} description={server?.name}
  footer={<><Btn onClick={onClose}>{t('common.cancel')}</Btn><Btn type="submit" form="sdx-power-editor" variant="primary" blocked={reason||undefined}>{t('management.reviewChange')}</Btn></>}>
  {target&&server&&<form id="sdx-power-editor" className="sdx-system-editor" onSubmit={submit}>
   <Field label={t('system.leadTime')}><input name="delaySeconds" type="number" min={60} max={3600} required value={draft.delaySeconds} autoFocus onChange={event=>change({delaySeconds:event.target.value})}/></Field>
   <Field label={t('management.power.reason')}><input name="powerReason" required maxLength={200} value={draft.reason} onChange={event=>change({reason:event.target.value})}/></Field>
   <p className="sdx-system-muted">{t('system.countdownHint')}</p>
   {draft.error&&<p className="sdx-field-error" role="alert">{t('system.powerInvalid')}</p>}
  </form>}
 </Drawer>;
}

/** The two menu entries of the device menu and the Restart… entry of the fleet row: blocked with the reason of systemActionReason. */
export function powerMenuEntry(kind:PowerKind,input:ReasonInput,onOpen:(target:PowerTarget)=>void,locale:Locale=defaultLocale){
 const blocked=systemActionReason(input,kind,locale)||undefined;
 return {blocked,onSelect:()=>{if(!blocked)onOpen({serverId:input.server.id,kind});}};
}
