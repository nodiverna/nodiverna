'use client';
// Device group management of the redesigned console: create, edit, delete and
// move devices. Every change goes through /api/access, exactly like the classic
// access panel. Organizing devices relies on the MFA login session; deleting a
// group needs a fresh MFA proof first only while it has a device or a role
// assignment (stepUpOnDelete, deviceGroupDeleteNeedsStepUp in lib/step-up.ts).
import {useEffect,useMemo,useRef,useState,type KeyboardEvent,type MouseEvent} from 'react';
import {Folder,FolderInput,FolderPlus,FolderTree,Layers,Server as ServerIcon,Settings2,Trash2} from 'lucide-react';
import {toast} from 'sonner';
import type {DeviceGroup,Viewer} from '@/lib/types';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {api,type Device} from '@/ui/base/api';
import {useStepUp} from '@/ui/session/step-up-retry';
import {accessRequestNeedsStepUp} from '@/ui/devices/fleet/groups-model';
import {canManageGroup,hasRootGroupRight} from '@/ui/base/access-capabilities';
import {Btn,Card,DangerZone,Drawer,DrawerCancel,Empty,PickCheckRow,PickList,PickRow} from '@/ui/kit/kit';
import {Field,FormActions,Select} from '@/ui/kit/field';
import {AnalysisTab} from '@/ui/kit/analysis-tab';
import {NameConfirmDrawer} from '@/ui/kit/name-confirm-drawer';
import {chooseRootGroupCustomer,rootGroupCustomerHint,rootGroupCustomerId,type CustomerOption} from '@/ui/devices/fleet/customer-choice';

import {useLocale,useT} from '@/ui/base/locale';
/** Direct group of a device. The console keeps one group per device; older data may still list several, then the deepest wins. */
export const deviceGroupId=(device:Pick<Device,'groupId'|'groups'>)=>device.groupId??[...(device.groups??[])].filter(group=>group.direct).sort((a,b)=>b.depth-a.depth)[0]?.id??null;

type AccessResult={id?:string;ok?:boolean};
/** stepUpOnDelete: the group's flag from the console data, for delete-group only. */
type AccessRequest={body:Record<string,unknown>;success:string;managementToken?:string;stepUpOnDelete?:boolean};

/**
 * Runs one access change on useStepUp. Routine changes are sent at once; a critical one opens
 * the MFA step-up dialog first (accessRequestNeedsStepUp; a group delete passes its stepUpOnDelete). A reply that asks for a proof opens the dialog and resends the
 * same change once with the new proof. When a request that already carried a proof is refused,
 * the reopened dialog shows the server's reason. Resolves with the API result, or null when
 * cancelled or failed.
 */
export function useAccessChange(onDone:()=>Promise<void>|void){
 const [locale]=useLocale();
 const change=useStepUp<AccessRequest,AccessResult>({locale,
  needsStepUp:accessRequestNeedsStepUp,
  send:async({body,success,managementToken})=>{const result=await api<AccessResult>('/api/access',managementToken?{...body,managementToken}:body);toast.success(success);await onDone();return result;},
 });
 const run=(body:Record<string,unknown>,success:string,{stepUpOnDelete}:{stepUpOnDelete?:boolean}={})=>change.run({body,success,...(stepUpOnDelete===undefined?{}:{stepUpOnDelete})});
 return {run,busy:change.busy,prompt:<MfaStepUp {...change.dialog}/>};
}

type GroupNode={group:DeviceGroup;level:number;path:string};
/** Groups in tree order with their indentation and full path. */
export function groupTree(groups:DeviceGroup[]):GroupNode[]{
 const byParent=new Map<string|null,DeviceGroup[]>(),ids=new Set(groups.map(group=>group.id));
 for(const group of groups){const parent=group.parentId&&ids.has(group.parentId)?group.parentId:null;byParent.set(parent,[...(byParent.get(parent)??[]),group]);}
 const result:GroupNode[]=[],seen=new Set<string>();
 const walk=(parent:string|null,level:number,path:string)=>{for(const group of [...(byParent.get(parent)??[])].sort((a,b)=>a.name.localeCompare(b.name,'de',{numeric:true}))){if(seen.has(group.id))continue;seen.add(group.id);const full=path?`${path} / ${group.name}`:group.name;result.push({group,level,path:full});walk(group.id,level+1,full);}};
 walk(null,0,'');
 return result;
}

/** Create a group or subgroup. customerId preselects the customer of a root group; rootGroupCustomerId still checks it against the list. */
type GroupCreateInput={name:string;description:string;parentId:string|null;customerId?:string};
/** What the create form holds; parentId '' is a root group. */
export type GroupCreateValues={name:string;description:string;parentId:string;customerId:string};
/** Whether the create form holds input to lose: a typed name or description, or a parent group or customer other than the initial one. */
export const groupCreateDirty=(values:GroupCreateValues,initial:Pick<GroupCreateValues,'parentId'|'customerId'>)=>values.name!==''||values.description!==''||values.parentId!==initial.parentId||values.customerId!==initial.customerId;
export function GroupCreateDrawer({open,parent,groups,customers=[],customerId,busy,onClose,onCreate}:{open:boolean;parent:DeviceGroup|null;groups:DeviceGroup[];customers?:CustomerOption[];customerId?:string;busy:boolean;onClose:()=>void;onCreate:(input:GroupCreateInput)=>void}){
 const t=useT(),formKey=open?(parent?.id??'root')+':'+(customerId??''):'';
 // A new form (opened again, or for another parent or customer) starts clean.
 const [dirty,setDirty]=useState(false),[shownForm,setShownForm]=useState(formKey);
 if(shownForm!==formKey){setShownForm(formKey);setDirty(false);}
 return <Drawer open={open} onClose={onClose} dirty={dirty} title={parent?t('tree.createSubgroup'):t('tree.createGroup')} description={parent?t('groups.create.childDescription',{name:parent.name}):t('groups.create.description')}
  footer={<><DrawerCancel/><Btn variant="primary" icon={FolderPlus} type="submit" form="sdx-group-create" loading={busy}>{t('tree.createGroup')}</Btn></>}>
  {open&&<GroupCreateForm key={formKey} parent={parent} groups={groups} customers={customers} initialCustomerId={customerId} busy={busy} onCreate={onCreate} onDirtyChange={setDirty}/>}
 </Drawer>;
}
function GroupCreateForm({parent,groups,customers,initialCustomerId,busy,onCreate,onDirtyChange}:{parent:DeviceGroup|null;groups:DeviceGroup[];customers:CustomerOption[];initialCustomerId?:string;busy:boolean;onCreate:(input:GroupCreateInput)=>void;onDirtyChange:(dirty:boolean)=>void}){
 const t=useT(),initial={parentId:parent?.id??'',customerId:initialCustomerId??''};
 const [values,setValues]=useState<GroupCreateValues>(()=>({name:'',description:'',...initial})),[touched,setTouched]=useState(false);
 const {name,description,parentId,customerId}=values;
 const update=(patch:Partial<GroupCreateValues>)=>{const next={...values,...patch};setValues(next);onDirtyChange(groupCreateDirty(next,initial));};
 const chooseCustomer=chooseRootGroupCustomer(customers,parentId),selectedCustomer=rootGroupCustomerId(customers,customerId);
 const options=groupTree(groups).filter(node=>node.group.depth<4);
 const error=touched&&!name.trim()?t('groups.nameRequired'):'';
 return <form id="sdx-group-create" className="sdx-form-grid" onSubmit={event=>{event.preventDefault();setTouched(true);if(name.trim()&&!busy)onCreate({name:name.trim(),description:description.trim(),parentId:parentId||null,...(chooseCustomer?{customerId:selectedCustomer}:{})});}}>
  <Field label={t('common.name')} error={error}><input autoFocus value={name} maxLength={80} placeholder={t('groups.namePlaceholder')} disabled={busy} onChange={event=>update({name:event.target.value})}/></Field>
  <Field label={t('groups.parent')} hint={t('groups.depthHint')}><Select value={parentId} disabled={busy} onChange={event=>update({parentId:event.target.value})}><option value="">{t('groups.parentNone')}</option>{options.map(node=><option key={node.group.id} value={node.group.id}>{node.path}</option>)}</Select></Field>
  {chooseCustomer&&<Field label={t('common.customer')} hint={t(rootGroupCustomerHint)}><Select value={selectedCustomer} disabled={busy} onChange={event=>update({customerId:event.target.value})}>{customers.map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}</Select></Field>}
  <Field label={<>{t('common.description')} <small>{t('common.optional')}</small></>}><textarea value={description} maxLength={500} disabled={busy} placeholder={t('groups.descriptionPlaceholder')} onChange={event=>update({description:event.target.value})}/></Field>
 </form>;
}

/**
 * Whether an event is an attempt to submit the form: a click on its submit button (also the click that
 * Enter in a field sends to it) or Enter/Space on that button. A blocked submit button cancels the
 * submission itself, so the form learns of the attempt only here and can show its field errors.
 */
export function submitAttempt(event:Pick<MouseEvent|KeyboardEvent,'target'|'type'>&{key?:string}):boolean{
 const target=event.target as Element|null,submit=target?.closest?.('button[type="submit"]');
 if(!submit)return false;
 return event.type==='click'||event.key==='Enter'||event.key===' ';
}

/**
 * The group's Configuration › General page in the shared analysis frame: the General card (name and description) with
 * FormActions, the Subgroups card and the DangerZone. Save is quiet (secondary), because the page header's "Add device"
 * is the one primary of the view. focusName puts the focus into the name field (the tree entry "Rename"; its value
 * changes on every request), then onNameFocused clears it.
 */
export function GroupSettings({group,groups,viewer,busy,demo,focusName,onNameFocused,onUpdate,onCreateChild,onDelete}:{group:DeviceGroup;groups:DeviceGroup[];viewer:Viewer;busy:boolean;demo:boolean;focusName?:number;onNameFocused?:()=>void;onUpdate:(input:{name:string;description:string})=>Promise<unknown>;onCreateChild:()=>void;onDelete:()=>void}){
 const t=useT();
 const nameField=useRef<HTMLInputElement>(null);
 useEffect(()=>{if(!focusName)return;nameField.current?.focus();onNameFocused?.();},[focusName,onNameFocused]);
 const [name,setName]=useState(group.name),[description,setDescription]=useState(group.description),[submitted,setSubmitted]=useState(false);
 const children=groups.filter(item=>item.parentId===group.id),dirty=name.trim()!==group.name||description.trim()!==group.description;
 const deleteBlocked=!hasRootGroupRight(viewer)?t('groups.deleteNeedsRootRight'):children.length?t('groups.deleteChildrenFirst'):undefined;
 const nameError=submitted&&!name.trim()?t('groups.enterName'):undefined;
 const attempt=(event:MouseEvent|KeyboardEvent)=>{if(submitAttempt(event))setSubmitted(true);};
 return <AnalysisTab title={t('fleet.tabs.settings')} description={t('fleet.config.generalMeta')} className="sdx-settings">
  <Card title={t('groups.general')} description={t('groups.generalHint')} icon={Settings2} iconTone="accent">
   <form className="sdx-form-grid" noValidate onClickCapture={attempt} onKeyDownCapture={attempt} onSubmit={event=>{event.preventDefault();setSubmitted(true);if(dirty&&name.trim())void onUpdate({name:name.trim(),description:description.trim()});}}>
    <Field label={t('common.name')} error={nameError}><input ref={nameField} value={name} maxLength={80} disabled={busy||demo} onChange={event=>setName(event.target.value)}/></Field>
    <Field label={t('common.description')}><textarea value={description} maxLength={500} disabled={busy||demo} placeholder={t('groups.descriptionPlaceholder')} onChange={event=>setDescription(event.target.value)}/></Field>
    <FormActions quiet dirty={dirty} busy={busy} loading={busy} blocked={demo?t('kit.unavailable.demo'):!name.trim()?t('groups.enterName'):undefined} onDiscard={()=>{setName(group.name);setDescription(group.description);setSubmitted(false);}}/>
   </form>
  </Card>
  <Card title={t('groups.subgroups')} description={children.length?t('groups.subgroupCount',{count:children.length}):t('groups.noSubgroups')} icon={FolderTree} iconTone="neutral"
   actions={<Btn size="sm" icon={FolderPlus} blocked={demo?t('kit.unavailable.demo'):!hasRootGroupRight(viewer)?t('groups.needsRootRight'):group.depth>=4?t('groups.maxDepth'):undefined} onClick={onCreateChild}>{t('tree.createSubgroup')}</Btn>}>
   {children.length>0&&<ul className="sdx-plain-list">{children.map(child=><li key={child.id}><Folder size={15} aria-hidden/><span>{child.name}</span><small>{t('groups.deviceCount',{count:child.deviceCount})}</small></li>)}</ul>}
  </Card>
  <DangerZone title={t('tree.deleteGroup')} description={t('groups.deleteHint')} label={t('tree.deleteGroup')} icon={Trash2} blocked={demo?t('kit.unavailable.demo'):deleteBlocked??(busy?t('kit.busy'):undefined)} onClick={onDelete}/>
 </AnalysisTab>;
}

/** Confirm deletion by typing the group name (the kit NameConfirmDrawer): Cancel is usable while the deletion runs and clears the typed name. */
export function GroupDeleteDrawer({group,busy,onClose,onDelete}:{group:DeviceGroup|null;busy:boolean;onClose:()=>void;onDelete:()=>void}){
 const t=useT();
 return <NameConfirmDrawer open={!!group} name={group?.name??null} title={t('tree.deleteGroup')} description={group?t('groups.delete.description',{name:group.name}):undefined}
  fieldLabel={t('groups.delete.typeName')} confirmLabel={t('groups.delete.confirm')} enterNameFirst={t('groups.delete.enterNameFirst')} busy={busy} onClose={onClose} onConfirm={onDelete}/>;
}

/** Pick the target group for one or more devices. A device belongs to exactly one group. */
export function MoveDevicesDrawer({open,devices,groups,viewer,busy,onClose,onMove}:{open:boolean;devices:Device[];groups:DeviceGroup[];viewer:Viewer;busy:boolean;onClose:()=>void;onMove:(groupId:string|null)=>void}){
 const t=useT(),[locale]=useLocale();
 const [target,setTarget]=useState<string|null|undefined>(undefined),[query,setQuery]=useState('');
 const current=new Set(devices.map(device=>deviceGroupId(device)??'')),same=target!==undefined&&current.size===1&&current.has(target??'');
 const nodes=groupTree(groups).filter(node=>canManageGroup(viewer,node.group)&&node.path.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale)));
 const root=hasRootGroupRight(viewer);
 const close=()=>{setTarget(undefined);setQuery('');onClose();};
 const title=devices.length===1?t('groups.move.titleOne',{name:devices[0].name}):t('groups.move.titleMany',{count:devices.length});
 return <Drawer open={open} onClose={close} title={title} description={t('groups.move.description')}
  footer={<><DrawerCancel/><Btn variant="primary" icon={FolderInput} loading={busy} blocked={target===undefined?t('groups.move.pickTarget'):same?t('groups.move.alreadyThere'):undefined} onClick={()=>{if(target!==undefined)onMove(target);}}>{t('groups.move.submit')}</Btn></>}>
  <PickList mode="radio" label={t('groups.move.target')} search={{value:query,onChange:setQuery,label:t('groups.filter'),placeholder:t('groups.searchPlaceholder')}}
   empty={<Empty icon={Folder} title={query?t('groups.noMatch'):t('groups.noneAvailable')}>{query?t('groups.adjustSearch'):t('groups.move.noRights')}</Empty>}>
   {root&&!query&&<PickRow selected={target===null} icon={<Layers size={15} aria-hidden/>} label={t('groups.noGroup')} hint={t('groups.noGroupHint')} onSelect={()=>setTarget(null)}/>}
   {nodes.map(node=><PickRow key={node.group.id} selected={target===node.group.id} level={query?0:node.level} icon={<Folder size={15} aria-hidden/>} label={query?node.path:node.group.name} hint={current.size===1&&current.has(node.group.id)?t('groups.deviceCountCurrent',{count:node.group.deviceCount}):t('groups.deviceCount',{count:node.group.deviceCount})} onSelect={()=>setTarget(node.group.id)}/>)}
  </PickList>
 </Drawer>;
}
/** Pick devices that should move into a group. */
export function AssignDevicesDrawer({group,servers,busy,onClose,onAssign}:{group:DeviceGroup|null;servers:Device[];busy:boolean;onClose:()=>void;onAssign:(ids:string[])=>void}){
 const t=useT(),[locale]=useLocale();
 const [selection,setSelection]=useState<string[]>([]),[query,setQuery]=useState('');
 const candidates=useMemo(()=>servers.filter(server=>deviceGroupId(server)!==group?.id).sort((a,b)=>a.name.localeCompare(b.name,'de',{numeric:true})),[servers,group]);
 const visible=candidates.filter(server=>[server.name,server.groupName].filter(Boolean).join(' ').toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale)));
 const close=()=>{setSelection([]);setQuery('');onClose();};
 return <Drawer open={!!group} onClose={close} title={group?t('groups.assign.title',{name:group.name}):t('console.moveDevicesHere')} description={t('groups.assign.description')}
  footer={<><span className="sdx-drawer-foot-start sdx-muted-cell">{selection.length?t('groups.assign.selected',{length:selection.length}):''}</span><DrawerCancel/><Btn variant="primary" icon={FolderInput} loading={busy} blocked={selection.length?undefined:t('groups.assign.pickOne')} onClick={()=>onAssign(selection)}>{t('groups.move.submit')}</Btn></>}>
  <PickList mode="checkbox" label={t('tree.devices')} search={{value:query,onChange:setQuery,label:t('groups.assign.filter'),placeholder:t('groups.assign.searchPlaceholder')}}
   empty={<Empty icon={ServerIcon} title={candidates.length?t('groups.assign.noMatch'):t('groups.assign.allThere')}>{candidates.length?t('groups.adjustSearch'):undefined}</Empty>}>
   {visible.map(server=><PickCheckRow key={server.id} checked={selection.includes(server.id)} icon={<ServerIcon size={15} aria-hidden/>} label={server.name} hint={server.groupName??t('groups.noGroup')} onChange={checked=>setSelection(previous=>checked?[...previous,server.id]:previous.filter(id=>id!==server.id))}/>)}
  </PickList>
 </Drawer>;
}
