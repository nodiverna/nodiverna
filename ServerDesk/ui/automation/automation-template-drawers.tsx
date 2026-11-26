'use client';
// The two forms of the Automation pages, as kit Drawers: "Create template" (drift: a reference device and its scan;
// Desired State: a version and the check interval; Runbooks: a version, its parameters, "Run regularly" and the
// devices at the same time) and "Assign template" (template, scope type, a target from a searchable pick list, the
// pause switch, the impact and the approval). Each drawer mounts fresh per opening (the page passes a key), holds its
// own input and hands the request body to onSubmit; the page sends it through useStepUp, so a cancelled step-up keeps
// the input. The request bodies are the classic ones.
import {useEffect,useState} from 'react';
import {FileCode2,Folder,GitBranch,Search,Server} from 'lucide-react';
import {Btn,Drawer,DrawerCancel,Empty,Facts,Notice,PickList,PickRow,Segmented,Skeleton} from '@/ui/kit/kit';
import {Field,Select,Switch} from '@/ui/kit/field';
import {automationGroupPath,type AutomationGroup,type AutomationTemplate} from '@/ui/automation/automation-data';
import {catalogOwnerChoices,catalogOwnerFieldLabel,catalogOwnerHints,catalogOwnerLabel,catalogOwnerRequest,defaultCatalogOwner,fitsCatalogOwner,showCatalogOwner,type CatalogOwnership} from '@/ui/base/catalog-owner';
import type {AutomationKind} from '@/lib/automation-resolution';
import {api,message,type Device} from '@/ui/base/api';
import {useLocale,useT} from '@/ui/base/locale';

type Parameter={name:string;type:string;required:boolean;secret:boolean;default?:string|number|boolean};
type Catalog={id:string;name:string;customerId?:string|null;versions:{id:string;version:number;definition?:{parameters:Parameter[]}}[]};
type CatalogReply={runbooks?:Catalog[];configs?:Catalog[];versions?:{id:string;configId:string;version:number}[]};
const createFormId='automation-create-template',assignFormId='automation-assign-template';

/** The versions a template can pin: runbooks with their parameters, or Desired State configurations. */
export function templateCatalog(kind:AutomationKind,reply:CatalogReply):Catalog[]{
 return kind==='runbook'?reply.runbooks??[]:(reply.configs??[]).map(c=>({...c,versions:c.versions??(reply.versions??[]).filter(v=>v.configId===c.id)}));
}

export function CreateTemplateDrawer({open,kind,devices,ownership,busy,onClose,onSubmit}:{open:boolean;kind:AutomationKind;
 /** The devices with the kind's manage right: the reference devices of a drift template. */
 devices:readonly Device[];ownership?:CatalogOwnership;
 /** A request of the page is out. */
 busy:boolean;onClose:()=>void;onSubmit:(body:Record<string,unknown>)=>void}){
 const t=useT(),[locale]=useLocale(),showOwner=showCatalogOwner(ownership);
 const [name,setName]=useState(''),[owner,setOwner]=useState(()=>defaultCatalogOwner(ownership)),[sourceId,setSourceId]=useState(devices[0]?.id??''),[includeBaseline,setIncludeBaseline]=useState(true);
 const [catalog,setCatalog]=useState<Catalog[]|null>(null),[catalogError,setCatalogError]=useState(''),[versionId,setVersionId]=useState(''),[interval,setIntervalSeconds]=useState(0),[parameters,setParameters]=useState<Record<string,string>>({});
 const [scheduled,setScheduled]=useState(false),[minutes,setMinutes]=useState(60),[concurrency,setConcurrency]=useState(2);
 // The versions load once per opening; a drift template needs none.
 useEffect(()=>{
  if(!open||kind==='drift')return;const controller=new AbortController();
  void api<CatalogReply>(kind==='runbook'?'/api/runbooks':'/api/desired-state',undefined,controller.signal).then(reply=>{if(!controller.signal.aborted)setCatalog(templateCatalog(kind,reply));}).catch(failure=>{if(!controller.signal.aborted)setCatalogError(message(failure));});
  return()=>controller.abort();
 },[open,kind]);
 const ownerCatalog=catalog?.filter(c=>kind!=='runbook'||!showOwner||fitsCatalogOwner(c.customerId,owner));
 const version=catalog?.flatMap(c=>c.versions).find(v=>v.id===versionId);
 const reason=!name.trim()?t('automation.blocked.name'):kind==='drift'?(!sourceId?t('automation.blocked.reference'):undefined):!versionId?t('automation.blocked.version'):undefined;
 const dirty=!!name.trim()||!!versionId||scheduled||Object.values(parameters).some(Boolean);
 const submit=()=>{
  if(reason||busy)return;
  const values:Record<string,string|number|boolean>={};
  for(const p of version?.definition?.parameters??[]){if(p.secret)continue;const value=parameters[p.name]??String(p.default??'');if(value==='')continue;values[p.name]=p.type==='number'?Number(value):p.type==='boolean'?value==='true':value;}
  onSubmit({action:'create-template',kind,name,sourceServerId:sourceId,includeBaseline,versionId,intervalSeconds:interval,parameters:values,recurrence:scheduled?{kind:'interval',minutes}:null,concurrency,...(kind==='drift'?{}:catalogOwnerRequest(ownership,owner))});
 };
 const versions=catalogError?<Notice tone="danger" icon={FileCode2}>{catalogError}</Notice>:!ownerCatalog?<Skeleton variant="facts" rows={2} label={t('automation.loadingVersions')}/>
  :<Field label={t('automation.version')}><Select value={versionId} onChange={event=>{setVersionId(event.target.value);setParameters({});}}><option value="">{t('automation.chooseVersion')}</option>{ownerCatalog.map(c=><optgroup key={c.id} label={c.name}>{c.versions.map(v=><option key={v.id} value={v.id}>{c.name} · v{v.version}</option>)}</optgroup>)}</Select></Field>;
 return <Drawer open={open} onClose={onClose} dirty={dirty} icon={FileCode2} title={t('automation.createTemplate')} description={kind==='drift'?t('automation.driftHint'):t('automation.templateHint')}
  footer={<><DrawerCancel/><Btn variant="primary" icon={FileCode2} type="submit" form={createFormId} loading={busy} blocked={busy?undefined:reason}>{t('automation.createTemplate')}</Btn></>}>
  <form id={createFormId} className="sdx-form-grid" onSubmit={event=>{event.preventDefault();submit();}}>
   <Field label={t('common.name')}><input autoFocus required maxLength={120} value={name} onChange={event=>setName(event.target.value)}/></Field>
   {kind==='drift'?<>
    <Field label={t('automation.referenceDevice')}><Select value={sourceId} onChange={event=>setSourceId(event.target.value)}><option value="">{t('automation.chooseDevice')}</option>{devices.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
    <Switch label={t('automation.useScan')} checked={includeBaseline} onChange={next=>setIncludeBaseline(next)}/>
    {showOwner&&<p className="sdx-muted-cell">{t(catalogOwnerHints.drift)}</p>}
   </>:<>
    {showOwner&&<Field label={t(catalogOwnerFieldLabel)} hint={t(catalogOwnerHints.template)}><Select value={owner} onChange={event=>{setOwner(event.target.value);setVersionId('');setParameters({});}}>{catalogOwnerChoices(ownership,locale).map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}</Select></Field>}
    {versions}
    {kind==='desired'?<Field label={t('automation.checkInterval')}><Select value={interval} onChange={event=>setIntervalSeconds(Number(event.target.value))}>{[{value:0,label:t('services.startup.manual')},{value:900,label:t('automation.every15')},{value:3600,label:t('desired.schedule.hourly')},{value:86400,label:t('customers.days.daily')}].map(entry=><option key={entry.value} value={entry.value}>{entry.label}</option>)}</Select></Field>
     :<>
      {version?.definition?.parameters.filter(p=>!p.secret).map(p=><Field key={p.name} label={p.name}><input required={p.required} type={p.type==='number'?'number':'text'} placeholder={String(p.default??'')} value={parameters[p.name]??''} onChange={event=>setParameters(previous=>({...previous,[p.name]:event.target.value}))}/></Field>)}
      <Switch label={t('automation.runRegularly')} checked={scheduled} onChange={next=>setScheduled(next)}/>
      {scheduled&&<Field label={t('automation.intervalMinutes')}><input type="number" min={5} max={10080} required value={minutes} onChange={event=>setMinutes(Number(event.target.value))}/></Field>}
      <Field label={t('automation.concurrent')}><input type="number" min={1} max={10} value={concurrency} onChange={event=>setConcurrency(Number(event.target.value))}/></Field>
     </>}
   </>}
  </form>
 </Drawer>;
}

/** The approval switch of an assignment: what it approves depends on the kind and, for Desired State, on the check interval. */
const approvalLabel=(kind:AutomationKind,template?:AutomationTemplate)=>kind==='runbook'?'automation.approveRun' as const:kind==='desired'&&Number(template?.payload.intervalSeconds)?'automation.approveSystem' as const:'automation.confirmAssignment' as const;

export function AssignTemplateDrawer({open,kind,templates,initialTemplateId,groups,devices,servers,showOwner,busy,onClose,onSubmit}:{open:boolean;kind:AutomationKind;templates:readonly AutomationTemplate[];
 /** The template of the row the drawer was opened from; else the first one. */
 initialTemplateId?:string;groups:readonly AutomationGroup[];
 /** The devices with the kind's manage right: the targets of a device assignment. */
 devices:readonly Device[];
 /** Every device: the affected count of a group. */
 servers:readonly Device[];showOwner:boolean;busy:boolean;onClose:()=>void;onSubmit:(body:Record<string,unknown>)=>void}){
 const t=useT(),[locale]=useLocale();
 const [templateId,setTemplateId]=useState(initialTemplateId||templates[0]?.id||''),[scopeType,setScopeType]=useState<'group'|'device'>(groups.length?'group':'device'),[scopeId,setScopeId]=useState('');
 const [disabled,setDisabled]=useState(false),[approved,setApproved]=useState(false),[query,setQuery]=useState('');
 const template=templates.find(entry=>entry.id===templateId),needle=query.trim().toLocaleLowerCase(locale);
 // A customer template fits only its customer's groups and devices.
 const scopeGroups=groups.filter(g=>fitsCatalogOwner(template?.customerId,g.customerId)).map(g=>({group:g,path:automationGroupPath(g,groups)})).filter(entry=>entry.path.toLocaleLowerCase(locale).includes(needle));
 const scopeDevices=devices.filter(s=>fitsCatalogOwner(template?.customerId,s.customerId)&&s.name.toLocaleLowerCase(locale).includes(needle));
 const target=scopeType==='group'?groups.find(g=>g.id===scopeId)?.name:devices.find(s=>s.id===scopeId)?.name;
 const affected=scopeType==='group'?servers.filter(s=>s.groups?.some(g=>g.id===scopeId)||s.groupId===scopeId):servers.filter(s=>s.id===scopeId);
 // A new template, scope or pause choice asks for the approval again.
 const choose=(next:()=>void)=>{next();setApproved(false);};
 const reason=!scopeId||!templateId?t('automation.blocked.noTarget'):!approved?t('automation.blocked.approval'):undefined;
 const empty=<Empty icon={query?Search:scopeType==='group'?Folder:Server} title={scopeType==='group'?query?t('groups.noMatch'):t('groups.noneAvailable'):query?t('automation.noDeviceMatch'):t('automation.noDeviceAvailable')}>{query?t('groups.adjustSearch'):undefined}</Empty>;
 return <Drawer open={open} onClose={onClose} dirty={!!scopeId||disabled||approved} icon={GitBranch} title={t('automation.assignTemplate')} description={t('automation.assignHint')}
  footer={<><DrawerCancel/><Btn variant="primary" icon={GitBranch} type="submit" form={assignFormId} loading={busy} blocked={busy?undefined:reason}>{t('automation.assignTemplate')}</Btn></>}>
  <form id={assignFormId} className="sdx-form-grid" onSubmit={event=>{event.preventDefault();if(!reason&&!busy)onSubmit({action:'assign',templateId,scopeType,scopeId,disabled,confirm:true});}}>
   <Field label={t('automation.line.template')}><Select autoFocus value={templateId} onChange={event=>choose(()=>{setTemplateId(event.target.value);setScopeId('');})}>{templates.map(entry=><option key={entry.id} value={entry.id}>{showOwner?`${entry.name} · ${catalogOwnerLabel(entry,locale)}`:entry.name}</option>)}</Select></Field>
   <Segmented<'group'|'device'> label={t('rbac.scopeColumn')} value={scopeType} onChange={next=>choose(()=>{setScopeType(next);setScopeId('');setQuery('');})} items={[{id:'group',label:t('automation.groupWithSubgroups'),icon:Folder},{id:'device',label:t('automation.singleDevice'),icon:Server}]}/>
   <PickList mode="radio" label={scopeType==='group'?t('fleet.col.group'):t('fleet.col.device')} empty={empty}
    search={{value:query,onChange:setQuery,label:scopeType==='group'?t('automation.searchGroups'):t('automation.searchDevicesPick'),placeholder:scopeType==='group'?t('automation.searchGroups'):t('automation.searchDevicesPick')}}>
    {scopeType==='group'
     ?scopeGroups.map(({group,path})=><PickRow key={group.id} selected={scopeId===group.id} icon={<Folder size={15} aria-hidden/>} label={query?path:group.name} hint={query||!group.parentId?undefined:path} level={query?0:group.depth} onSelect={()=>choose(()=>setScopeId(group.id))}/>)
     :scopeDevices.map(s=><PickRow key={s.id} selected={scopeId===s.id} icon={<Server size={15} aria-hidden/>} label={s.name} hint={s.groupName??t('groups.noGroup')} onSelect={()=>choose(()=>setScopeId(s.id))}/>)}
   </PickList>
   <Switch label={t('automation.pauseInherited')} checked={disabled} onChange={next=>choose(()=>setDisabled(next))}/>
   {scopeId&&target&&<Facts items={[
    {label:t('automation.line.scope'),value:target},
    {label:t('tree.devices'),value:t(scopeType==='group'?'automation.affectedInherit':'automation.affected',{count:affected.length})},
    {label:t('automation.line.template'),value:disabled?t('automation.templatePaused',{name:template?.name??''}):template?.name??''},
   ]}/>}
   <Switch label={t(approvalLabel(kind,template))} checked={approved} onChange={next=>setApproved(next)}/>
  </form>
 </Drawer>;
}
