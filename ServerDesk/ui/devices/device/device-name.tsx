'use client';
// The rename drawer of a device ("More actions" → "Rename device", and the
// command palette): the name follows the computer name that the agent reports,
// or it is a custom name. The server checks the rule again and stores only
// what it accepts (POST /api/device-name, lib/server/devices/device-name-store.ts).
import {useId,useState,type FormEvent} from 'react';
import {toast} from 'sonner';
import {Monitor,PencilLine} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {deviceNameMax,reportedHostname,sameDeviceName,validDeviceName,type DeviceNameSource} from '@/lib/device-name';
import {api,message,permitted,type Device} from '@/ui/base/api';
import {Btn,Drawer,Facts,PickRow} from '@/ui/kit/kit';
import {Field} from '@/ui/kit/field';
import {useT,type Translate} from '@/ui/base/locale';

type Choice='hostname'|'custom';

/** Why the name cannot be changed here, or undefined. The right is Manage device groups and permissions (groups.manage), like the description. */
export function deviceNameBlocked(server:Device,viewer:Viewer,demo:boolean,t:Translate):string|undefined{
 if(demo)return t('kit.unavailable.demo');
 if(!permitted(server,viewer,'groups.manage'))return t('device.metadata.noRight');
 return undefined;
}

/**
 * The choice the drawer opens with: the stored name source; a personal
 * registration before its first heartbeat (pending) counts as the computer
 * name when its name equals the reported one.
 */
export function initialNameChoice(server:Pick<Device,'name'|'nameSource'|'snapshot'>):Choice{
 const source:DeviceNameSource=server.nameSource??'hostname';
 if(source!=='pending')return source;
 const reported=reportedHostname(server.snapshot);
 return reported!==null&&sameDeviceName(reported,server.name)?'hostname':'custom';
}

/** Whether the drawer would change something: another choice, or another custom name. */
export function nameDraftChanged(server:Pick<Device,'name'|'nameSource'|'snapshot'>,choice:Choice,draft:string):boolean{
 if(choice!==initialNameChoice(server))return true;
 return choice==='custom'&&draft.trim()!==server.name;
}

/** The rename drawer. Its state starts from `server` on mount; the console mounts it again for every opening. */
export function DeviceNameDrawer({open,server,viewer,demo,onClose,onRefresh}:{open:boolean;server:Device;viewer:Viewer;demo:boolean;onClose:()=>void;onRefresh:()=>Promise<void>|void}){
 const t=useT(),formId=useId();
 const [choice,setChoice]=useState<Choice>(()=>initialNameChoice(server)),[draft,setDraft]=useState(server.name);
 const [submitted,setSubmitted]=useState(false),[busy,setBusy]=useState(false),[focusField,setFocusField]=useState(choice==='custom');
 const reported=reportedHostname(server.snapshot),previous=server.previousNames??[];
 const invalid=choice==='custom'&&validDeviceName(draft)===null;
 const blocked=deviceNameBlocked(server,viewer,demo,t)??(nameDraftChanged(server,choice,draft)?undefined:t('common.noChanges'));
 const close=()=>{if(!busy)onClose();};
 const pick=(next:Choice)=>{setChoice(next);if(next==='custom')setFocusField(true);};
 const submit=async(event:FormEvent)=>{
  event.preventDefault();
  if(blocked||busy)return;
  setSubmitted(true);
  if(invalid)return;
  setBusy(true);
  try{
   await api('/api/device-name',{serverId:server.id,source:choice,...(choice==='custom'?{name:draft.trim()}:{}),expected:server.name});
   toast.success(t('device.name.renamed'));
   await onRefresh();
   onClose();
  }catch(failure){toast.error(message(failure));}
  finally{setBusy(false);}
 };
 return <Drawer open={open} onClose={close} icon={PencilLine} title={t('device.name.title')} description={t('device.name.intro')}
  footer={<><Btn onClick={close} disabled={busy}>{t('common.cancel')}</Btn><Btn variant="primary" type="submit" form={formId} loading={busy} blocked={blocked}>{t('device.name.submit')}</Btn></>}>
  <form id={formId} className="sdx-form-grid sdx-device-name-form" noValidate onSubmit={event=>void submit(event)}>
   <div className="sdx-pick-list" role="radiogroup" aria-label={t('device.name.choice')}>
    <PickRow selected={choice==='hostname'} icon={<Monitor size={15} aria-hidden/>} label={t('device.name.useHostname')} hint={reported!==null?t('device.name.useHostnameHint',{hostname:reported}):t('device.name.noHostnameHint')} onSelect={()=>pick('hostname')}/>
    <PickRow selected={choice==='custom'} icon={<PencilLine size={15} aria-hidden/>} label={t('device.name.useCustom')} hint={t('device.name.useCustomHint')} onSelect={()=>pick('custom')}/>
   </div>
   {choice==='custom'&&<Field label={t('device.name.field')} hint={t('device.name.fieldHint')} error={submitted&&invalid?t('device.name.fieldError'):undefined}>
    <input type="text" autoFocus={focusField} maxLength={deviceNameMax} autoComplete="off" spellCheck={false} value={draft} disabled={busy} onChange={event=>setDraft(event.target.value)}/>
   </Field>}
   {previous.length>0&&<Facts items={[{id:'previous',label:t('device.name.previous'),value:previous.join(', ')}]}/>}
  </form>
 </Drawer>;
}
