'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowRight,CheckCircle2,Download,PackageOpen,RotateCcw,Wrench} from 'lucide-react';
import type {PortalCertificateView} from '@/lib/server/agent/portal-certificate';
import {consoleRouteHash} from '@/lib/console-route';
import {agentInstallCommand,agentRepairCommand} from '@/ui/devices/add-device/agent-guide';
import {api,type Device} from '@/ui/base/api';
import {addDevicePhase,addDeviceStepIds,addDeviceStepStates,addDeviceStepTitles,addDeviceTabHref,chooseEnrollCustomer,enrollBlockedKey,enrollGroupChoices,enrollGroupMissing,enrollStartChoice,waitingRefreshActive,waitingRefreshMs,type AddDeviceChoice,type AddDevicePhase,type AgentMode,type EnrollCustomers,type Registration} from '@/ui/devices/add-device/add-device-model';
import type {EnrollInput} from '@/ui/devices/add-device/enroll-action';
import {Btn,Card,CommandBlock,Disclosure,IconTile,Notice,Skeleton,StatusPill,Steps,claimEntrance,cx} from '@/ui/kit/kit';
import {Field,Select} from '@/ui/kit/field';
import {Tabs,tabId} from '@/ui/kit/tabs';
import {PortalCertificateCard} from '@/ui/devices/add-device/portal-certificate-card';
import {AgentModePick} from '@/ui/devices/add-device/agent-mode-pick';
import AddDeviceInstallers from '@/ui/devices/add-device/add-device-installers';
import {useT} from '@/ui/base/locale';
import {useClockNow} from '@/ui/base/clock-store';
import '@/ui/devices/add-device/add-device.css';

// The page Add device (#devices/add[/installer][/customer/<id>][/group/<id>]) inside Devices, beside the
// device tree: "One device" registers one device in four steps and waits for its first report; "Several
// devices" lists, creates and revokes the customer installers. The pure rules live in ui/devices/add-device/add-device-model.ts.
export const addDevicePanelId='sdx-add-device-panel';
const agentReleasesHash=consoleRouteHash({view:'settings',page:'agent-releases'}),troubleshootingHash=consoleRouteHash({view:'settings',page:'agent-troubleshooting'});

type EnrollForm={name:string;mode:AgentMode};
const emptyForm:EnrollForm={name:'',mode:'ReadOnly'};

export type AddDevicePageProps={
 /** The tab of the route: Several devices (/installer) or One device. */
 installer:boolean;
 /** The customer and group segments of the route; they preselect the forms. */
 routeCustomerId:string;routeGroupId:string;
 /** The groups of the console data as [id, name] and the customer of each group. */
 groups:ReadonlyArray<readonly [string,string]>;groupCustomers:EnrollCustomers['groupCustomers'];
 /** The visible customers of the console data. */
 customers:EnrollCustomers['customers'];
 /** ConsoleData.multipleCustomers: the customer comes first (One device) and is chosen (Several devices). */
 multipleCustomers:boolean;
 servers:readonly Device[];
 /** Pins the time (tests); without it the page follows the console clock every second. */
 now?:number;demo:boolean;
 /** The viewer is an Owner (the page node's rule; the actions check it again). */
 owner:boolean;
 /** A registration request of the console runs. */
 saving:boolean;
 /** ConsoleData.portalCertificate: undefined until the console data arrives. */
 certificate:PortalCertificateView|null|undefined;
 /** Opens the other tab with the current choice, with a history entry. */
 onTab:(installer:boolean,choice:AddDeviceChoice)=>void;
 /** Sends the registration (step-up and errors in the console); created runs once the file is downloaded. */
 onEnroll:(input:EnrollInput,created:(registration:Registration)=>void)=>void;
 /** Asks the console for fresh data (refresh(true)). */
 onRefresh:()=>void;
 onOpenDevice:(id:string)=>void;
};

export default function AddDevicePage(pinned:AddDevicePageProps){
 const props={...pinned,now:useClockNow(pinned.now)};
 const {installer,routeCustomerId,routeGroupId,groups,groupCustomers,customers,multipleCustomers,onTab}=props;
 const t=useT();
 // The choice starts from the route; a new route (another customer or group link) starts it again. Changing a field
 // does not change the hash: the tab links carry the current choice.
 const start=()=>enrollStartChoice({routeCustomer:routeCustomerId,routeGroup:routeGroupId,groups,multipleCustomers,customers,groupCustomers});
 const [choice,setChoice]=useState<AddDeviceChoice>(start),[form,setForm]=useState<EnrollForm>(emptyForm),[registration,setRegistration]=useState<Registration|null>(null);
 const routeKey=routeCustomerId+'\n'+routeGroupId,[seenRoute,setSeenRoute]=useState(routeKey);
 if(seenRoute!==routeKey){setSeenRoute(routeKey);if(routeKey!==choice.customerId+'\n'+choice.groupId)setChoice(start());}
 const reset=()=>{setForm(emptyForm);setChoice(start());setRegistration(null);};
 const tab=installer?'several':'one';
 return <div className="sdx-add-device-page">
  <Tabs label={t('nav.devices.add')} variant="underline" panelId={addDevicePanelId} value={tab} onChange={id=>onTab(id==='several',choice)}
   items={[{id:'one',label:t('addDevice.tab.one'),href:addDeviceTabHref(false,choice)},{id:'several',label:t('addDevice.tab.several'),href:addDeviceTabHref(true,choice)}]}/>
  <div id={addDevicePanelId} role="tabpanel" aria-labelledby={tabId(addDevicePanelId,tab)} className="sdx-add-device-panel">
   {installer
    ?<AddDeviceInstallers chosenCustomer={choice.customerId} routeGroupId={choice.groupId} multipleCustomers={multipleCustomers} demo={props.demo} certificate={props.certificate}
      onChooseCustomer={id=>setChoice(current=>chooseEnrollCustomer(current,id,groupCustomers))}/>
    :<OneDevice {...props} choice={choice} onChoice={setChoice} form={form} onForm={setForm} registration={registration} onRegistered={setRegistration} onReset={reset}/>}
  </div>
 </div>;
}

/** "One device": the four steps and, below them, the repair command. */
function OneDevice({groups,groupCustomers,customers,multipleCustomers:activated,servers,now,demo,owner,saving,certificate,onEnroll,onRefresh,onOpenDevice,choice,onChoice,form,onForm,registration,onRegistered,onReset}:AddDevicePageProps&{now:number;
 choice:AddDeviceChoice;onChoice:(next:AddDeviceChoice)=>void;form:EnrollForm;onForm:(next:EnrollForm)=>void;registration:Registration|null;onRegistered:(registration:Registration)=>void;onReset:()=>void}){
 const t=useT(),[entrance]=useState(()=>claimEntrance('add-device-steps'));
 // The customer field only with several customers and while the console shows real devices.
 const multipleCustomers=activated&&!demo;
 const phase=addDevicePhase(registration,servers,now),states=addDeviceStepStates(phase);
 // Step 4 asks the console for fresh data every 10 seconds while it waits on this tab; never in demo mode.
 // The console passes a new callback on every render (its clock ticks each second), so the timer reads the latest one.
 const refreshing=waitingRefreshActive({phase,shown:true,demo}),refreshRef=useRef(onRefresh);
 useEffect(()=>{refreshRef.current=onRefresh;});
 useEffect(()=>{if(!refreshing)return;const timer=setInterval(()=>refreshRef.current(),waitingRefreshMs);return ()=>clearInterval(timer);},[refreshing]);
 const fileName=registration?.fileName??t('agents.install.registrationFile');
 const bodies={
  register:registration
   ?<div className="sdx-add-device-done"><p>{t('addDevice.done',{name:registration.name})}</p><Btn icon={RotateCcw} onClick={onReset}>{t('addDevice.another')}</Btn></div>
   :<RegisterForm groups={groups} groupCustomers={groupCustomers} customers={customers} multipleCustomers={multipleCustomers} demo={demo} owner={owner} saving={saving} choice={choice} onChoice={onChoice} form={form} onForm={onForm}
     onSubmit={input=>onEnroll(input,onRegistered)}/>,
  download:<><p>{t('agents.install.requirements')}</p><AgentDownload/></>,
  install:<>
   <p>{t('addDevice.installText')}</p>
   <CommandBlock label={t('addDevice.commandLabel')} command={agentInstallCommand(fileName)}/>
   <p>{t('addDevice.afterCommand')}</p>
   <PortalCertificateCard certificate={certificate} use="one"/>
  </>,
  wait:<WaitStep phase={phase} registration={registration} onOpenDevice={onOpenDevice}/>,
 };
 return <div className="sdx-add-device">
  <Card className={cx('sdx-add-device-steps',entrance&&'sdx-enter')}>
   <Steps label={t('addDevice.steps')} items={addDeviceStepIds.map(id=>({id,title:t(addDeviceStepTitles[id]),state:states[id],children:bodies[id]}))}/>
  </Card>
  <Disclosure icon={Wrench} title={t('agents.install.update')}>
   <div className="sdx-add-device-repair"><p>{t('agents.install.updateHint')}</p><CommandBlock command={agentRepairCommand}/></div>
  </Disclosure>
 </div>;
}

/** Step 1: name, customer (several customers), group and agent mode, then "Download registration". */
function RegisterForm({groups,groupCustomers,customers,multipleCustomers,demo,owner,saving,choice,onChoice,form,onForm,onSubmit}:Pick<AddDevicePageProps,'groups'|'groupCustomers'|'customers'|'demo'|'owner'|'saving'>&{multipleCustomers:boolean;choice:AddDeviceChoice;onChoice:(next:AddDeviceChoice)=>void;form:EnrollForm;onForm:(next:EnrollForm)=>void;onSubmit:(input:EnrollInput)=>void}){
 const t=useT();
 const missing=enrollGroupMissing(choice.groupId,groups),options=enrollGroupChoices(groups,choice.customerId,{multipleCustomers,groupCustomers});
 const reason=enrollBlockedKey({demo,owner,name:form.name,multipleCustomers,customerId:choice.customerId,groupMissing:missing});
 const submit=(event:FormEvent)=>{event.preventDefault();if(reason||saving)return;onSubmit({name:form.name.trim(),mode:form.mode,groupId:choice.groupId,...(multipleCustomers?{customerId:choice.customerId}:{})});};
 return <form className="sdx-form-grid sdx-add-device-form" onSubmit={submit}>
  <Field label={t('agents.enroll.deviceName')} hint={t('agents.enroll.deviceNameHint')}><input value={form.name} maxLength={64} placeholder="SRV-APP01" autoComplete="off" spellCheck={false} onChange={event=>onForm({...form,name:event.target.value})}/></Field>
  {multipleCustomers&&<Field label={t('agents.enroll.customer')} hint={t('addDevice.customerHint')}><Select value={choice.customerId} aria-required="true" onChange={event=>onChoice(chooseEnrollCustomer(choice,event.target.value,groupCustomers))}>
   <option value="">{t('agents.enroll.chooseCustomer')}</option>{customers.map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}
  </Select></Field>}
  <Field label={t('tree.deviceGroup')}><Select value={choice.groupId} onChange={event=>onChoice({...choice,groupId:event.target.value})}>
   <option value="">{t('groups.noGroup')}</option>{missing&&<option value={choice.groupId}>{t('agents.enroll.groupGone')}</option>}{options.map(([id,label])=><option key={id} value={id}>{label}</option>)}
  </Select></Field>
  <div className="sdx-field"><span className="sdx-field-label">{t('agents.enroll.mode')}</span>
   <AgentModePick value={form.mode} onChange={mode=>onForm({...form,mode})}/>
  </div>
  <p className="sdx-add-device-note">{t('addDevice.validity')}</p>
  <div className="sdx-form-actions"><Btn type="submit" variant="primary" icon={Download} loading={saving} blocked={reason?t(reason):undefined}>{t('agents.enroll.download')}</Btn></div>
 </form>;
}

type LatestRelease={state:'loading'}|{state:'ready';version:string|null}|{state:'failed'};
/**
 * Step 2: the protected agent download is the browser's native streaming link (the HttpOnly session cookies
 * authenticate it; no script fetches or buffers it). The catalog is read once for the version of the latest
 * release, or a notice while no release exists. The EXE holds no secret, so demo mode shows it too.
 */
export function AgentDownload(){
 const t=useT(),[latest,setLatest]=useState<LatestRelease>({state:'loading'});
 useEffect(()=>{
  const controller=new AbortController();
  api<{releases:{version:string;latest:boolean}[]}>('/api/releases',undefined,controller.signal).then(
   value=>{if(!controller.signal.aborted)setLatest({state:'ready',version:value.releases.find(release=>release.latest)?.version??null});},
   ()=>{if(!controller.signal.aborted)setLatest({state:'failed'});});
  return ()=>controller.abort();
 },[]);
 if(latest.state==='loading')return <Skeleton variant="facts" rows={1} label={t('agents.download.loading')}/>;
 if(latest.state==='ready'&&latest.version===null)return <Notice tone="info" icon={PackageOpen} action={<a className="sdx-btn sdx-btn-ghost sdx-btn-sm" href={agentReleasesHash}><span>{t('addDevice.openReleases')}</span></a>}>{t('agents.download.none')}</Notice>;
 return <div className="sdx-add-device-download">
  <a className="sdx-btn sdx-btn-secondary" href="/api/agent/download" download="ServerDesk.Agent.exe"><Download size={15} aria-hidden/><span>{t('agents.download.button')}</span></a>
  {latest.state==='ready'&&<span className="mono">{t('agents.download.version',{version:latest.version??''})}</span>}
 </div>;
}

/** Step 4: before a registration a sentence; while waiting the live pill; after the first report the success state with "Open device". */
function WaitStep({phase,registration,onOpenDevice}:{phase:AddDevicePhase;registration:Registration|null;onOpenDevice:(id:string)=>void}){
 const t=useT(),name=registration?.name??'',deviceId=registration?.deviceId;
 return <div className="sdx-add-device-wait" aria-live="polite">
  {phase==='form'?<p>{t('addDevice.waitBefore')}</p>
   :phase==='waiting'?<div key="waiting" className="sdx-add-device-state">
    <span className="sdx-live"><StatusPill kind="neutral">{t('addDevice.waiting',{name})}</StatusPill></span>
    <p>{t('addDevice.waitingHint')}</p>
    <p>{t('addDevice.noReport')} <a href={troubleshootingHash}>{t('addDevice.openTroubleshooting')}</a></p>
   </div>
   :<div key="reported" className="sdx-add-device-state sdx-add-device-online">
    <IconTile icon={CheckCircle2} tone="success"/>
    <div><strong>{t(phase==='online'?'addDevice.online':'addDevice.reported',{name})}</strong><p>{t('addDevice.onlineHint')}</p></div>
    {deviceId&&<Btn variant="primary" icon={ArrowRight} onClick={()=>onOpenDevice(deviceId)}>{t('addDevice.openDevice')}</Btn>}
   </div>}
 </div>;
}
