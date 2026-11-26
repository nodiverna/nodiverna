'use client';
// The Permissions view of a scope (All devices, a group: Configuration › Permissions) and of a device (Configuration ›
// Permissions), on the scope subtab pattern (nodiverna-ui §4, checkpoint F4) and the Direct/Inherited cards (§7):
// the AnalysisTab head with "Add assignment" as its one secondary action, one kit Toolbar search, the Direct card with
// the assignments of this scope and a row Menu "Remove assignment…", then the Inherited card with the read-only rows,
// their origin and a row Menu "Open origin". "Add assignment" opens a Drawer with kit Selects; Accounts can open it
// prefilled with an account (prefill). Loads and changes run through useRbacData (step-up first, toasts, the
// generation guards), the removal through useRbacConfirm and the body states through rbacBody; the console's refresh
// count reloads the view (refreshKey) without a skeleton.
import {useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {ArrowUpRight,KeyRound,Plus,ShieldPlus,Trash2} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {canManageRoleAssignments} from '@/ui/base/access-capabilities';
import {accessPermissionName} from '@/ui/settings/access-model';
import {fitsCatalogOwner} from '@/ui/base/catalog-owner';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {useRefreshCount} from '@/ui/shell/page-frame';
import {rbacAccountOption} from '@/ui/settings/rbac-account-text';
import {rbacBody} from '@/ui/settings/rbac-body';
import {useGenerationState,useRbacConfirm,useRbacData} from '@/ui/settings/rbac-data';
import {rbacEndpoint,roleDescription,roleName,rolePrivilegedLocked,scopeLabel,subjectKind,subjectLabel,wireScope,type PermissionOrigin,type PermissionPrefill,type PermissionScope,type RbacAssignment,type RbacData,type RbacInherited,type RbacRole} from '@/ui/settings/rbac-model';
import {Btn,Card,Drawer,DrawerCancel,Facts,Menu,Unavailable,cx} from '@/ui/kit/kit';
import {AnalysisTab,ResetAction} from '@/ui/kit/analysis-tab';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {Field,Select} from '@/ui/kit/field';
import {InheritedNotEffective,InheritedOrigin} from '@/ui/kit/inheritance';
import {useLocale,useT} from '@/ui/base/locale';

export type ScopedPermissionEditorProps={viewer:Viewer;demo:boolean;onRefresh:()=>Promise<void>|void;scope:PermissionScope;scopeName:string;
 /** Opens the origin of an inherited assignment (All devices or a group) on its Permissions tab. */
 onOpenScope?:(target:PermissionOrigin)=>void;
 /** "Assign role" from Accounts: once the data has loaded, the add drawer opens once with this account chosen. */
 prefill?:PermissionPrefill;onPrefillDone?:()=>void;
 /** The console's refresh count: each change after mount loads again and keeps the cards visible. */
 refreshKey?:number};
/** The id of the add-assignment form in its drawer. */
const assignmentFormId='sd-rbac-assignment-form';
type AssignmentForm={subjectType:'user'|'group';subjectId:string;roleId:string;
 /** The account the drawer opened with (prefill), '' otherwise: the form is dirty once it differs. */
 initialSubject:string;prefilled:boolean};
/** The assignment a removal confirmation names: confirming checks it is still a direct assignment of this scope. */
type RemoveTarget={assignment:RbacAssignment};
type InheritedRow={assignment:RbacAssignment;entry:RbacInherited};

export function ScopedPermissionEditor({viewer,demo,onRefresh,scope,scopeName,onOpenScope,prefill,onPrefillDone,refreshKey}:ScopedPermissionEditorProps){
 const t=useT(),[locale]=useLocale();
 const resourceScope=wireScope(scope),scopedObject=resourceScope?.type==='device'||resourceScope?.type==='devicegroup';
 // Sample devices have no access management: the view shows Unavailable and sends nothing.
 const rbac=useRbacData({viewer,demo,scopeKey:JSON.stringify(['assignments',resourceScope?.type,resourceScope?.id]),endpoint:rbacEndpoint(resourceScope),enabled:!demo,onRefresh});
 useRefreshCount(refreshKey??0,rbac.load);
 const [query,setQuery]=useState(''),[prefillTaken,setPrefillTaken]=useState<PermissionPrefill|null>(null);
 // A drawer or dialog of another generation (viewer or scope change, session lock) is closed.
 const [form,setForm]=useGenerationState<AssignmentForm>(rbac.generation);
 const data=rbac.data;
 const assignmentScopeValid=!!resourceScope&&(resourceScope.type==='global'||(resourceScope.type==='devicegroup'?data?.deviceGroups:data?.devices)?.some(item=>item.id===resourceScope.id)===true);
 const inScope=(assignment:RbacAssignment)=>!!resourceScope&&assignment.scopeType===resourceScope.type&&assignment.scopeId===resourceScope.id;
 // Library roles everywhere; a customer role only on groups and devices of its customer, never globally. Roles with
 // portal rights only on All devices; privileged roles only for Owners.
 const scopeCustomer=resourceScope?.type==='devicegroup'?data?.deviceGroups.find(group=>group.id===resourceScope.id)?.customerId:resourceScope?.type==='device'?data?.devices.find(device=>device.id===resourceScope.id)?.customerId:undefined;
 const canAssignRole=(role:RbacRole)=>!!resourceScope&&!!data&&(resourceScope.type==='global'||!role.permissions.some(permission=>permission.startsWith('portal.')))&&fitsCatalogOwner(role.customerId,scopeCustomer)&&!rolePrivilegedLocked(role,data);
 const assignableRoles=data?.roles.filter(canAssignRole)??[];
 const canAdd=!!data?.canManageAssignments&&assignmentScopeValid;
 const lockReason=demo?t('kit.unavailable.demo'):rbac.busy?t('fleet.menu.saving'):undefined;

 // ---- Add ----
 const openAdd=(subject?:PermissionPrefill)=>{
  // An account that is not in the data (or deactivated) opens the drawer with no account chosen.
  const subjectId=subject&&data?.users.some(user=>user.id===subject.subjectId&&user.status!=='disabled')?subject.subjectId:'';
  setForm({subjectType:'user',subjectId,roleId:'',initialSubject:subjectId,prefilled:!!subject});
 };
 // The prefill opens the drawer once, when the data has loaded; the console then drops it (onPrefillDone).
 if(prefill&&data&&prefillTaken!==prefill){setPrefillTaken(prefill);if(canAdd)openAdd(prefill);}
 const reported=useRef<PermissionPrefill|null>(null),done=useRef(onPrefillDone);
 useEffect(()=>{done.current=onPrefillDone;});
 useEffect(()=>{if(prefillTaken&&reported.current!==prefillTaken){reported.current=prefillTaken;done.current?.();}},[prefillTaken]);
 const formValid=!!form&&!!form.subjectId&&!!form.roleId&&assignmentScopeValid&&assignableRoles.some(role=>role.id===form.roleId);
 const formDirty=!!form&&(form.subjectType!=='user'||form.subjectId!==form.initialSubject||!!form.roleId);
 const submit=async(event:FormEvent)=>{
  // formValid repeats the button's check, so Enter cannot send an incomplete form; the scope comes from the view, never from a field.
  event.preventDefault();if(!form||!data||!resourceScope||!formValid||!data.canManageAssignments||demo||rbac.busy)return;
  const body={action:'add-assignment',subjectType:form.subjectType,subjectId:form.subjectId,roleId:form.roleId,scopeType:resourceScope.type,scopeId:resourceScope.id};
  if(await rbac.change({endpoint:'/api/rbac',body,success:t('rbac.toast.assignmentSaved')}))setForm(null);
 };
 const addButton=<Btn icon={Plus} blocked={lockReason} onClick={()=>openAdd()}>{t('rbac.addAssignment')}</Btn>;

 // ---- Remove ----
 // Only a direct assignment of this scope can be removed here: a confirm whose assignment is gone or no longer in scope sends nothing.
 const confirm=useRbacConfirm<RemoveTarget>(rbac,{accept:({assignment})=>!!data?.canManageAssignments&&data.assignments.some(item=>item.id===assignment.id&&inScope(item))});
 const askRemove=(assignment:RbacAssignment,source:RbacData)=>confirm.ask({assignment,title:t('rbac.removeAssignment.title'),body:t('rbac.removeAssignment.body'),confirmLabel:t('rbac.removeAssignment.confirm'),tone:'danger',
  lines:[{label:t('rbac.line.subject'),value:subjectLabel(assignment,source,locale)},{label:t('rbac.role'),value:roleName(assignment,source,locale)},{label:t('rbac.scopeColumn'),value:scopeLabel(assignment,source,locale)}],
  change:{endpoint:'/api/rbac',body:{action:'delete-assignment',id:assignment.id},success:t('rbac.toast.assignmentRemoved')}});

 // ---- Tables ----
 const normalized=query.trim().toLowerCase();
 const matches=(assignment:RbacAssignment)=>!!data&&`${subjectLabel(assignment,data,locale)} ${roleName(assignment,data,locale)} ${scopeLabel(assignment,data,locale)}`.toLowerCase().includes(normalized);
 const assignments=data?.assignments.filter(assignment=>inScope(assignment)&&matches(assignment))??[];
 // Server order; only entries whose assignment the same answer lists. Read-only: confirmRemove accepts direct assignments only.
 const inheritedAll:InheritedRow[]=scopedObject&&data?(data.inherited??[]).flatMap(entry=>data.assignments.filter(assignment=>assignment.id===entry.assignmentId).map(assignment=>({assignment,entry}))):[];
 const inherited=inheritedAll.filter(row=>matches(row.assignment));
 const originTarget=(assignment:RbacAssignment):PermissionOrigin|null=>assignment.scopeType==='global'?{type:'global',name:t('tree.allDevices')}:assignment.scopeType==='devicegroup'?{type:'group',id:assignment.scopeId,name:data?.deviceGroups.find(group=>group.id===assignment.scopeId)?.name??assignment.scopeId}:null;
 const subjectCell=(assignment:RbacAssignment,source:RbacData)=><span className="sdx-cell-stack"><strong>{subjectLabel(assignment,source,locale)}</strong><small>{subjectKind(assignment,source,locale)}</small></span>;
 const removeEntry=(assignment:RbacAssignment,source:RbacData)=>({id:'remove',label:t('rbac.menu.removeAssignment'),icon:Trash2,danger:true,blocked:assignment.source==='entra'?t('rbac.entraAssignmentBlocked'):lockReason,onSelect:()=>askRemove(assignment,source)});
 const directColumns:DataColumn<RbacAssignment>[]=data?[
  {id:'subject',label:t('rbac.subjectColumn'),primary:true,wrap:true,cell:assignment=>subjectCell(assignment,data)},
  {id:'role',label:t('rbac.role'),cell:assignment=>assignment.source==='entra'?<>{roleName(assignment,data,locale)} <span className="sdx-tag">{t('rbac.fromEntra')}</span></>:roleName(assignment,data,locale)},
  ...(data.canManageAssignments?[{id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:(assignment:RbacAssignment)=><Menu label={t('tree.actionsForName',{name:subjectLabel(assignment,data,locale)})} entries={[removeEntry(assignment,data)]}/>}]:[]),
 ]:[];
 // A non-effective inherited entry gives nobody rights here: its subject and role are muted. An origin of All devices or a
 // group gets the row Menu "Open origin" next to the origin link.
 const muted=(row:InheritedRow,node:ReactNode)=><span className={cx('sdx-cell-stack',row.entry.effective===false&&'sdx-inherited-ineffective')}>{node}</span>;
 const inheritedColumns:DataColumn<InheritedRow>[]=data?[
  {id:'subject',label:t('rbac.subjectColumn'),primary:true,wrap:true,cell:row=>muted(row,<><strong>{subjectLabel(row.assignment,data,locale)}</strong><small>{subjectKind(row.assignment,data,locale)}</small>{row.entry.effective===false&&row.entry.reason&&<InheritedNotEffective reason={row.entry.reason}/>}</>)},
  {id:'role',label:t('rbac.role'),cell:row=>muted(row,roleName(row.assignment,data,locale))},
  {id:'origin',label:t('rbac.origin'),wrap:true,cell:row=>{const target=originTarget(row.assignment);return <InheritedOrigin label={scopeLabel(row.assignment,data,locale)} onOpen={onOpenScope&&target?()=>onOpenScope(target):undefined}/>;}},
  ...(onOpenScope?[{id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:(row:InheritedRow)=>{const target=originTarget(row.assignment);return target?<Menu label={t('tree.actionsForName',{name:subjectLabel(row.assignment,data,locale)})} entries={[{id:'origin',label:t('rbac.menu.openOrigin'),icon:ArrowUpRight,onSelect:()=>onOpenScope(target)}]}/>:null;}}]:[]),
 ]:[];
 const showAdd=demo?canManageRoleAssignments(viewer):canAdd;
 // The cause of an empty Direct table: a search without match, inherited rows below, or nothing at all. Like Tags and
 // Notification rules, the Empty keeps the creating action next to the head's (nodiverna-ui §5 Empty): it is the same
 // "Add assignment" control (label, icon, blocked reason) and shows under the same condition, showAdd.
 const clearSearch=<ResetAction label={t('history.search.clear')} onReset={()=>setQuery('')}/>,emptyAction=showAdd?addButton:undefined;
 const directEmpty=normalized?{icon:KeyRound,title:scopedObject&&inherited.length?t('rbac.assignments.noDirectMatch'):t('rbac.assignments.noMatch'),action:clearSearch}
  :!scopedObject?{icon:KeyRound,title:t('rbac.assignments.none'),children:t('rbac.assignments.noneHint'),action:emptyAction}
  :inheritedAll.length?{icon:KeyRound,title:t('rbac.assignments.noDirect'),children:t('rbac.assignments.noDirectHint'),action:emptyAction}
  :{icon:KeyRound,title:t('rbac.assignments.noneHere'),children:t('rbac.assignments.noneHereHint'),action:emptyAction};
 const description=t(resourceScope?.type==='global'?'rbac.assignments.description.global':resourceScope?.type==='devicegroup'?'rbac.assignments.description.group':'rbac.assignments.description.device');
 const chosenRole=form?data?.roles.find(role=>role.id===form.roleId):undefined;
 return <AnalysisTab title={t('tree.permissions')} headingId="sd-rbac-permissions-title" description={description} busy={rbac.loading} className="sdx-panel-stack" actions={showAdd?addButton:undefined}>
  {demo?<Unavailable reason="demo">{t('rbac.demo')}</Unavailable>
   :rbacBody(rbac,t,()=><>
    <Toolbar search={{value:query,onChange:setQuery,label:t('rbac.search.permissions'),placeholder:t('rbac.placeholder.permissions')}}/>
    <Card title={t('rbac.direct')} icon={KeyRound} iconTone="accent" flush>
     <DataTable<RbacAssignment> label={t('rbac.directTable')} variant="flush" cards entranceId="rbac-direct" busy={rbac.loading} columns={directColumns} rows={assignments} rowKey={assignment=>assignment.id} empty={directEmpty}/>
    </Card>
    {inherited.length>0&&<Card title={t('rbac.inherited')} icon={ArrowUpRight} iconTone="neutral" flush>
     <DataTable<InheritedRow> label={t('rbac.inheritedTable')} variant="flush" cards busy={rbac.loading} columns={inheritedColumns} rows={inherited} rowKey={row=>row.assignment.id} empty={{icon:ArrowUpRight,title:t('rbac.assignments.noMatch')}}/>
    </Card>}
   </>)}
  <ConfirmDialog {...confirm.dialog}/>
  <Drawer open={!!form} onClose={()=>setForm(null)} dirty={formDirty} icon={ShieldPlus} title={t('rbac.dialog.addAssignment')} description={t('rbac.dialog.assignmentFor',{scope:scopeName||t('rbac.dialog.thisScope')})}
   footer={<><DrawerCancel/><Btn variant="primary" type="submit" form={assignmentFormId} loading={rbac.sending} blocked={!formValid?t('rbac.blocked.incomplete'):lockReason}>{t('rbac.assignRole')}</Btn></>}>
   {form&&data&&<form id={assignmentFormId} className="sdx-form-grid" onSubmit={event=>void submit(event)}>
    <Field label={t('files.type')}><Select autoFocus={!form.prefilled} value={form.subjectType} onChange={event=>setForm(current=>current&&{...current,subjectType:event.target.value==='group'?'group':'user',subjectId:''})}>
     <option value="user">{t('rbac.account')}</option><option value="group">{t('rbac.userGroup')}</option>
    </Select></Field>
    <Field label={form.subjectType==='user'?t('rbac.account'):t('rbac.userGroup')}><Select autoFocus={form.prefilled&&!form.subjectId} value={form.subjectId} onChange={event=>setForm(current=>current&&{...current,subjectId:event.target.value})}>
     <option value="">{t('management.updates.select')}</option>
     {form.subjectType==='user'?data.users.filter(user=>user.status!=='disabled').map(user=><option key={user.id} value={user.id}>{rbacAccountOption(user)}</option>):data.userGroups.filter(group=>group.enabled).map(group=><option key={group.id} value={group.id}>{group.name}</option>)}
    </Select></Field>
    <Field label={t('rbac.role')} hint={chosenRole?roleDescription(chosenRole,t)||chosenRole.permissions.map(id=>accessPermissionName(id,data.permissions,t)).join(', '):undefined}>
     <Select autoFocus={form.prefilled&&!!form.subjectId} value={form.roleId} onChange={event=>setForm(current=>current&&{...current,roleId:event.target.value})}>
      <option value="">{t('rbac.chooseRole')}</option>{assignableRoles.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}
     </Select>
    </Field>
    <Facts items={[{label:t('rbac.scopeColumn'),value:scopeName||t('rbac.dialog.thisScope')}]}/>
   </form>}
  </Drawer>
  <MfaStepUp {...rbac.dialog}/>
 </AnalysisTab>;
}
