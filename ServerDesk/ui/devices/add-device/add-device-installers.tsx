'use client';
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {Building2,Package,Plus} from 'lucide-react';
import {toast} from 'sonner';
import type {PortalCertificateView} from '@/lib/server/agent/portal-certificate';
import type {CustomerInstaller} from '@/lib/server/agent/customer-installers';
import {sortTableRows} from '@/ui/base/table-sort';
import {formatDate} from '@/lib/i18n/format';
import {installerCreateBlocked,installerCopy,installerCreateBody,installerCustomer,installerDevicesText,installerFileName,installerGroupText,installerMaxDevices,installerStartForm,installerStatusKinds,installerStatusText,installerUsage,installerValidDays,newInstallerIds,type InstallerForm,type InstallersView} from '@/ui/devices/add-device/add-device-model';
import {agentModeLabel} from '@/ui/base/agent-mode';
import {api,credentialFetch,readApiJson} from '@/ui/base/api';
import {useStepUp} from '@/ui/session/step-up-retry';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {Btn,Drawer,DrawerCancel,LoadFailed,Meter,Menu,Notice,RetryAction,SectionHead,Skeleton,StatusPill} from '@/ui/kit/kit';
import {Field,Select} from '@/ui/kit/field';
import {DataTable,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {PortalCertificateCard} from '@/ui/devices/add-device/portal-certificate-card';
import {AgentModePick} from '@/ui/devices/add-device/agent-mode-pick';
import {useLocale,useT} from '@/ui/base/locale';

// "Several devices" on the page Add device: the installers of one customer (lib/server/agent/customer-installers.ts). Only
// Owners list, create and revoke them; every write
// asks for MFA first (lib/step-up.ts). Demo mode lists the real installers but blocks every write.
type Write={action:'create-installer';customerId:string;name:string;groupId:string|null;mode:InstallerForm['mode'];validDays:number;maxDevices:number|null;managementToken?:string}
 |{action:'revoke-installer';id:string;managementToken?:string};
type WriteResult={kind:'created'}|{kind:'revoked';view:InstallersView};
type SortColumn='name'|'validUntil';
type Load={state:'loading'}|{state:'failed'}|{state:'ready';view:InstallersView};

/** Saves the created installer script under the name of its Content-Disposition. */
async function saveInstaller(response:Response){
 const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');
 link.href=url;link.download=installerFileName(response.headers.get('Content-Disposition'));link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}

export default function AddDeviceInstallers({chosenCustomer,routeGroupId,multipleCustomers,demo,certificate,onChooseCustomer}:{
 /** The customer of the page's choice; preselects the list when it is in the answer. */
 chosenCustomer:string;
 /** The group of the page's choice; preselected in the create drawer when it belongs to the customer. */
 routeGroupId:string;
 multipleCustomers:boolean;demo:boolean;certificate:PortalCertificateView|null|undefined;
 onChooseCustomer:(id:string)=>void;
}){
 const t=useT(),[locale]=useLocale();
 const [load,setLoad]=useState<Load>({state:'loading'}),[retrying,setRetrying]=useState(false),[sort,setSort]=useState<TableSort<SortColumn>|null>(null),[highlight,setHighlight]=useState<string[]>([]);
 const [form,setForm]=useState<InstallerForm|null>(null),[submitted,setSubmitted]=useState(false),[revoking,setRevoking]=useState<CustomerInstaller|null>(null);
 const mounted=useRef(true),createButton=useRef<HTMLButtonElement>(null);
 useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
 // One GET per visit of the tab; a retry repeats exactly it.
 const fetchView=useCallback(async()=>{
  try{const view=await api<InstallersView>('/api/customers');if(mounted.current)setLoad({state:'ready',view});return view;}
  catch{if(mounted.current)setLoad(current=>current.state==='ready'?current:{state:'failed'});return null;}
 },[]);
 useEffect(()=>{void Promise.resolve().then(fetchView);},[fetchView]);
 const retry=()=>{setRetrying(true);void fetchView().finally(()=>{if(mounted.current)setRetrying(false);});};

 const writes=useStepUp<Write,WriteResult>({locale,needsStepUp:()=>true,send:async payload=>{
  if(payload.action==='revoke-installer')return {kind:'revoked',view:await api<InstallersView>('/api/customers',payload)};
  const response=await credentialFetch('/api/customers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store'});
  if(!response.ok)await readApiJson(response);
  await saveInstaller(response);
  return {kind:'created'};
 }});

 const view=load.state==='ready'?load.view:null,customers=view?.customers??[];
 const customer=view?installerCustomer(customers,{multipleCustomers,chosen:chosenCustomer}):null;
 // Before the list is there, Create installer waits for it (demo mode still names itself first).
 const blocked=view?installerCreateBlocked({demo,customer,locale}):demo?t('kit.unavailable.demo'):t(load.state==='failed'?'addDevice.installers.loadFailed':'addDevice.installers.loading');
 const rows=customer?sortTableRows((view?.installers??[]).filter(installer=>installer.customerId===customer.id),sort,{name:row=>row.name,validUntil:row=>row.expiresAt}):[];
 const groups=customer?(view?.deviceGroups??[]).filter(group=>group.customerId===customer.id):[];

 const openCreate=()=>{if(blocked||!customer)return;setSubmitted(false);setForm(installerStartForm(customer.id,routeGroupId,view?.deviceGroups??[]));};
 const start=customer?installerStartForm(customer.id,routeGroupId,view?.deviceGroups??[]):null;
 const dirty=!!form&&!!start&&JSON.stringify(form)!==JSON.stringify(start);
 const maxError=submitted&&form&&!installerMaxDevices(form.maxDevices).valid?t('addDevice.installers.maxError'):undefined;
 const create=async(event:FormEvent)=>{
  event.preventDefault();setSubmitted(true);
  if(!form||!customer||!form.name.trim()||blocked||writes.busy)return;
  const body=installerCreateBody(customer.id,form);if(!body)return;
  const before=view?.installers??[];
  const result=await writes.run(body);
  if(!result||!mounted.current)return;
  setForm(null);toast.success(t('addDevice.installers.created'));
  const after=await fetchView();
  if(after&&mounted.current)setHighlight(newInstallerIds(before,after.installers??[]));
 };
 const revoke=async()=>{
  const installer=revoking;setRevoking(null);
  if(!installer||demo)return;
  const result=await writes.run({action:'revoke-installer',id:installer.id});
  if(result?.kind!=='revoked'||!mounted.current)return;
  setLoad({state:'ready',view:result.view});setHighlight([]);toast.success(t('addDevice.installers.revoked'));
 };

 const createLabel=t('addDevice.installers.create'),copy=installerCopy(multipleCustomers,customer?.name??'',locale);
 const columns:DataColumn<CustomerInstaller>[]=[
  {id:'name',label:t('common.name'),primary:true,wrap:true,sort:{first:'asc'},cell:row=><strong>{row.name}</strong>},
  {id:'group',label:t('fleet.col.group'),hideBelow:1100,cell:row=>installerGroupText(row.groupId,row.groupName,locale)},
  {id:'mode',label:t('agents.enroll.mode'),cell:row=>agentModeLabel(row.mode,t)},
  {id:'validUntil',label:t('customers.validUntil'),sort:{first:'asc'},cell:row=>formatDate(locale,row.expiresAt)},
  {id:'devices',label:t('tree.devices'),cell:row=>{const text=installerDevicesText(row.enrollments,row.maxDevices,locale),usage=installerUsage(row.enrollments,row.maxDevices);
   return <span className="sdx-installer-devices"><span className="mono">{text}</span>{usage!==null&&<Meter size="sm" value={usage} label={text}/>}</span>;}},
  {id:'status',label:t('management.status'),cell:row=><StatusPill kind={installerStatusKinds[row.status]}>{installerStatusText(row.status,locale)}</StatusPill>},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:row=>row.revokedAt===null?<Menu label={t('addDevice.installers.rowMenu',{name:row.name})} entries={[
   {id:'revoke',label:t('addDevice.installers.revoke'),danger:true,blocked:demo?t('kit.unavailable.demo'):undefined,onSelect:()=>setRevoking(row)},
  ]}/>:null},
 ];

 const list=load.state==='loading'?<Skeleton variant="table" label={t('addDevice.installers.loading')} after={15000} action={<RetryAction onRetry={retry}/>}/>
  :load.state==='failed'?<LoadFailed text={t('addDevice.installers.loadFailed')} loading={retrying} onRetry={retry}/>
  :!customer?<Notice tone="info" icon={Building2}>{t('addDevice.installers.chooseCustomer')}</Notice>
  :<DataTable label={copy.table} entranceId="add-device-installers" cards columns={columns} rows={rows} rowKey={row=>row.id}
    sort={sort} onSort={next=>setSort(next as TableSort<SortColumn>)} highlightKey={highlight}
    empty={{icon:Package,title:copy.emptyTitle,children:t('addDevice.installers.emptyText'),action:<Btn icon={Plus} blocked={blocked??undefined} onClick={openCreate}>{createLabel}</Btn>}}
    foot={t('addDevice.installers.count',{count:rows.length})}/>;

 return <div className="sdx-add-device sdx-add-device-installers">
  <SectionHead hideTitle title={t('addDevice.tab.several')} description={copy.description}
   primary={<Btn ref={createButton} variant="primary" icon={Plus} blocked={blocked??undefined} onClick={openCreate}>{createLabel}</Btn>}/>
  {multipleCustomers&&view&&<Field className="sdx-add-device-customer" label={t('agents.enroll.customer')}><Select value={customer?.id??''} aria-required="true" onChange={event=>{setHighlight([]);onChooseCustomer(event.target.value);}}>
   <option value="">{t('agents.enroll.chooseCustomer')}</option>{customers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
  </Select></Field>}
  {list}
  <PortalCertificateCard certificate={certificate} use="several"/>

  <Drawer open={!!form&&!!customer} onClose={()=>setForm(null)} dirty={dirty} returnFocus={createButton} icon={Package}
   title={copy.drawerTitle} description={t('customers.secretHint')}
   footer={<><DrawerCancel/><Btn type="submit" form="sdx-installer-create" variant="primary" icon={Plus} loading={writes.sending} blocked={!form?.name.trim()?t('customers.installer.nameFirst'):undefined}>{createLabel}</Btn></>}>
   {form&&<form id="sdx-installer-create" className="sdx-form-grid" noValidate onSubmit={event=>void create(event)}>
    <Field label={t('common.name')}><input autoFocus value={form.name} maxLength={80} placeholder={t('customers.installerPlaceholder')} autoComplete="off" onChange={event=>setForm({...form,name:event.target.value})}/></Field>
    <Field label={t('tree.deviceGroup')}><Select value={form.groupId} onChange={event=>setForm({...form,groupId:event.target.value})}>
     <option value="">{t('groups.noGroup')}</option>{groups.map(group=><option key={group.id} value={group.id}>{group.name}</option>)}
    </Select></Field>
    <div className="sdx-field"><span className="sdx-field-label">{t('agents.enroll.mode')}</span><AgentModePick value={form.mode} onChange={mode=>setForm({...form,mode})}/></div>
    <Field label={t('customers.validFor')}><Select value={form.validDays} onChange={event=>setForm({...form,validDays:Number(event.target.value)})}>
     {installerValidDays.map(days=><option key={days} value={days}>{t('customers.days',{count:days})}</option>)}
    </Select></Field>
    <Field label={t('customers.maxDevices')} hint={t('addDevice.installers.maxHint')} error={maxError}><input type="number" inputMode="numeric" min={1} max={10000} step={1} value={form.maxDevices} placeholder={t('customers.unlimited')} onChange={event=>setForm({...form,maxDevices:event.target.value})}/></Field>
   </form>}
  </Drawer>
  <ConfirmDialog open={!!revoking} onOpenChange={open=>{if(!open)setRevoking(null);}} tone="danger" title={t('customers.revokeTitle')}
   lines={revoking?[{label:t('addDevice.installers.lineInstaller'),value:revoking.name},{label:t('addDevice.installers.lineCustomer'),value:customer?.name??''}]:undefined}
   body={t('customers.revokeDescription',{value:revoking?.name??''})} confirmLabel={t('addDevice.installers.revokeConfirm')} blocked={demo?t('kit.unavailable.demo'):undefined} onConfirm={()=>void revoke()}/>
  <MfaStepUp {...writes.dialog}/>
 </div>;
}
