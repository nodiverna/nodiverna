'use client';
// Settings › Roles on the kit (nodiverna-ui §4 "Settings page"): the page header with "Create role", one SettingsPage
// with the role table (role, type and permission count as the focal point), a row Menu per writable role and one wide
// Drawer per role: read-only for built-in and other locked roles (the permissions by group, each with its id), the
// editor for a writable role and for "Create role". Library and customer roles follow the catalog (catalog-owner.ts);
// roles with '*' or the cross-customer right belong to Owners (cross-customer.ts). Every change runs through
// useRbacData (step-up first, toasts, the generation guards), the confirmation through useRbacConfirm and the body states
// through rbacBody.
import {useState,type FormEvent} from 'react';
import {Pencil,ShieldCheck,ShieldPlus,Trash2} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {canManageRoles} from '@/ui/base/access-capabilities';
import {accessPermissionGroups,accessPermissionName,type AccessPermission} from '@/ui/settings/access-model';
import {catalogCreateLockReason,catalogOwnerChoices,catalogOwnerFieldLabel,catalogOwnerHints,catalogOwnerLabel,catalogOwnerRequest,defaultCatalogOwner,showCatalogOwner} from '@/ui/base/catalog-owner';
import {crossCustomerRight,privilegedRightLockReason,privilegedRoleLockReason} from '@/ui/base/cross-customer';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {Btn,Drawer,DrawerCancel,Facts,Menu,Notice,PickCheckRow,SectionHead,SettingsPage,type MenuEntry} from '@/ui/kit/kit';
import {ResetAction} from '@/ui/kit/analysis-tab';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {Field,Select} from '@/ui/kit/field';
import {useLocale,useT} from '@/ui/base/locale';
import {rbacBody} from '@/ui/settings/rbac-body';
import {useGenerationState,useRbacConfirm,useRbacData} from '@/ui/settings/rbac-data';
import {roleAssigned,roleDescription,rolePrivilegedLocked,roleWritable,type RbacRole} from '@/ui/settings/rbac-model';
import '@/ui/base/catalog-owner.css';

/** The id of the role form in its drawer. */
const roleFormId='sdx-rbac-role-form';
/** The open role drawer: view (read-only) or form (create or edit), with the form values. */
type RoleDrawer={mode:'view'|'form';role?:RbacRole;name:string;description:string;owner:string;permissions:string[]};
type RightGroup={id:string;label:string;permissions:readonly Pick<AccessPermission,'id'>[]};
const sameSet=(left:readonly string[],right:readonly string[])=>left.length===right.length&&left.every(id=>right.includes(id));

export default function RolesPage({viewer,demo,onRefresh,frame}:{viewer:Viewer;demo:boolean;onRefresh:()=>Promise<void>|void;
 /** The console frame: the page header at the top and the refresh count. */
 frame?:PageFrame}){
 const t=useT(),[locale]=useLocale();
 const rbac=useRbacData({viewer,demo,scopeKey:'roles',endpoint:'/api/rbac',onRefresh});
 useFrameRefresh(frame,rbac.load);
 const [query,setQuery]=useState('');
 // A drawer or dialog of another generation (viewer change, session lock) is closed.
 const [drawer,setDrawer]=useGenerationState<RoleDrawer>(rbac.generation),confirm=useRbacConfirm(rbac);
 const data=rbac.data,title=t('nav.settings.roles'),manages=canManageRoles(viewer),showOwner=showCatalogOwner(data?.catalog);
 const saving=rbac.busy?t('fleet.menu.saving'):undefined;
 const lockText=(role:RbacRole)=>data&&rolePrivilegedLocked(role,data)?t(privilegedRoleLockReason):undefined;
 // The editor opens for a custom role the catalog and the Owner rule let this viewer change; every other role opens read-only.
 const editable=(role:RbacRole)=>manages&&!!data?.canManageRoles&&roleWritable(role,data)&&!lockText(role);
 const permissionName=(id:string)=>accessPermissionName(id,data?.permissions,t);
 const typeLabel=(role:RbacRole)=>role.builtIn?t('rbac.role.builtIn'):t('rbac.role.custom');

 // ---- Create, edit and view ----
 const open=(role:RbacRole)=>setDrawer({mode:editable(role)?'form':'view',role,name:role.name,description:role.description,owner:'',permissions:[...role.permissions]});
 const openCreate=()=>setDrawer({mode:'form',name:'',description:'',owner:defaultCatalogOwner(data?.catalog),permissions:[]});
 const createBlocked=!data?t('rbac.blocked.loading'):!data.canManageRoles?t('rbac.blocked.right'):catalogCreateLockReason(data.catalog,locale)||saving;
 const createButton=(variant:'primary'|'secondary')=><Btn variant={variant} icon={ShieldPlus} blocked={createBlocked} onClick={openCreate}>{t('rbac.createRole')}</Btn>;
 const form=drawer?.mode==='form'?drawer:null,viewed=drawer?.mode==='view'?drawer.role:undefined;
 // An assigned role changes its permissions only with the assignment right; name and description stay editable.
 const permissionsLocked=!!form?.role&&!!data&&roleAssigned(form.role,data)&&!data.canManageAssignments;
 const unchanged=!!form?.role&&form.name.trim()===form.role.name&&form.description.trim()===form.role.description&&sameSet(form.permissions,form.role.permissions);
 const formBlocked=!form?undefined:!form.name.trim()?t('rbac.blocked.nameMissing'):!form.permissions.length?t('rbac.blocked.noPermission'):unchanged?t('common.noChanges'):undefined;
 const formDirty=!!form&&(form.role?!unchanged:!!(form.name||form.description||form.permissions.length)||form.owner!==defaultCatalogOwner(data?.catalog));
 const submit=async(event:FormEvent)=>{
  event.preventDefault();if(!form||!data||formBlocked||rbac.busy)return;
  const body={action:form.role?'update-role':'create-role',...(form.role?{id:form.role.id}:catalogOwnerRequest(data.catalog,form.owner)),name:form.name.trim(),description:form.description.trim(),permissions:[...form.permissions]};
  if(await rbac.change({endpoint:'/api/rbac',body,success:t(form.role?'rbac.toast.roleSaved':'rbac.toast.roleCreated')}))setDrawer(null);
 };
 // A customer role holds device rights only: the editor hides the portal rights for it. The cross-customer right exists only once separated.
 const editedCustomer=form?form.role?form.role.customerId??null:showOwner&&form.owner?form.owner:null:null;
 const definitions=data?.permissions??[];
 const portalRights=editedCustomer?[]:definitions.filter(permission=>permission.id.startsWith('portal.')&&(permission.id!==crossCustomerRight||data?.catalog?.separated===true));
 const rightGroups:RightGroup[]=[{id:'portal',label:t('rbac.portalManagement'),permissions:portalRights},...accessPermissionGroups(definitions.filter(permission=>!permission.id.startsWith('portal.'))).map(group=>({...group,label:t(group.label)}))].filter(group=>group.permissions.length>0);
 const rightLock=(id:string)=>id===crossCustomerRight&&data?.privilegedWritable===false?t(privilegedRightLockReason):undefined;
 const setOwner=(owner:string)=>setDrawer(current=>current&&{...current,owner,permissions:owner?current.permissions.filter(id=>id!=='*'&&!id.startsWith('portal.')):current.permissions});
 const toggleRight=(id:string,checked:boolean)=>setDrawer(current=>current&&{...current,permissions:checked?[...current.permissions,id]:current.permissions.filter(entry=>entry!==id)});
 // The read-only permissions of a role by group; an id the catalog does not know shows as itself under "More permissions".
 const roleGroups=(role:RbacRole):RightGroup[]=>{
  const known=accessPermissionGroups(definitions.filter(permission=>role.permissions.includes(permission.id))).map(group=>({...group,label:t(group.label)}));
  const unknown=role.permissions.filter(id=>!definitions.some(permission=>permission.id===id)).map(id=>({id}));
  return unknown.length?[...known,{id:'unknown',label:t('rbac.category.other'),permissions:unknown}]:known;
 };
 const rightsList=(groups:RightGroup[])=>groups.map(group=><section key={group.id} className="sdx-form-grid" aria-labelledby={`sdx-rbac-rights-${group.id}`}>
  <SectionHead id={`sdx-rbac-rights-${group.id}`} level={3} title={group.label}/>
  <Facts items={group.permissions.map(permission=>({id:permission.id,label:permissionName(permission.id),value:permission.id,mono:true}))}/>
 </section>);

 // ---- Confirmation ----
 const remove=(role:RbacRole)=>confirm.ask({title:t('rbac.role.delete.title'),body:t('rbac.role.delete.description',{name:role.name}),lines:[{label:t('rbac.role'),value:role.name}],confirmLabel:t('rbac.role.delete.confirm'),tone:'danger',
  change:{endpoint:'/api/rbac',body:{action:'delete-role',id:role.id},success:t('rbac.toast.roleDeleted')}});

 // ---- Table ----
 const entries=(role:RbacRole):MenuEntry[]=>[
  {id:'edit',label:t('rbac.menu.editRole'),icon:Pencil,blocked:lockText(role)??saving,onSelect:()=>open(role)},
  {id:'separator',separator:true},
  {id:'delete',label:t('rbac.menu.deleteRole'),icon:Trash2,danger:true,blocked:lockText(role)??(data&&roleAssigned(role,data)?t('rbac.role.removeAssignmentsFirst'):saving),onSelect:()=>remove(role)},
 ];
 // The menu belongs to the roles the viewer may write; a privileged custom role stays in it, locked with the Owner reason.
 const hasMenu=(role:RbacRole)=>manages&&!!data?.canManageRoles&&(roleWritable(role,data)||!role.builtIn&&!!lockText(role));
 const columns:DataColumn<RbacRole>[]=[
  {id:'role',label:t('rbac.role'),primary:true,wrap:true,cell:role=><span className="sdx-cell-stack"><strong>{role.name}</strong>{roleDescription(role,t)&&<small>{roleDescription(role,t)}</small>}</span>},
  {id:'type',label:t('rbac.col.type'),cell:typeLabel},
  {id:'permissions',label:t('rbac.col.permissions'),tabular:true,cell:role=>role.permissions.includes('*')?t('rbac.role.allRights'):t('rbac.role.rightCount',{count:role.permissions.length})},
  ...(showOwner?[{id:'owner',label:t(catalogOwnerFieldLabel),cell:(role:RbacRole)=><span className="sd-catalog-owner" data-owner={role.customerId?'customer':'library'}>{catalogOwnerLabel(role,locale)}</span>}]:[]),
  ...(manages?[{id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:(role:RbacRole)=>hasMenu(role)?<Menu label={t('tree.actionsForName',{name:role.name})} entries={entries(role)}/>:null}]:[]),
 ];
 const normalized=query.trim().toLowerCase();
 const roles=data?.roles.filter(role=>`${role.name} ${roleDescription(role,t)} ${role.permissions.join(' ')}`.toLowerCase().includes(normalized))??[];
 // The built-in roles always exist, so only a search leaves the table empty.
 const empty={icon:ShieldCheck,title:t('rbac.roles.noMatch'),action:<ResetAction label={t('history.search.clear')} onReset={()=>setQuery('')}/>};
 const body=rbacBody(rbac,t,loaded=><DataTable<RbacRole> label={title} columns={columns} rows={roles} rowKey={role=>role.id} cards entranceId="rbac-roles" busy={rbac.loading} empty={empty}
  onOpen={open} openLabel={role=>t('rbac.openRole',{name:role.name})}
  toolbar={<Toolbar search={{value:query,onChange:setQuery,label:t('rbac.search.roles'),placeholder:t('rbac.placeholder.roles')}}/>}
  foot={t('rbac.foot.roles',{shown:roles.length,count:loaded.roles.length})}/>);

 const formBody=form&&data&&<form id={roleFormId} className="sdx-form-grid" onSubmit={event=>void submit(event)}>
  <Field label={t('common.name')}><input autoFocus value={form.name} maxLength={80} onChange={event=>setDrawer(current=>current&&{...current,name:event.target.value})}/></Field>
  <Field label={<>{t('common.description')} <small>{t('common.optional')}</small></>}><textarea value={form.description} maxLength={500} onChange={event=>setDrawer(current=>current&&{...current,description:event.target.value})}/></Field>
  {showOwner&&!form.role&&<Field label={t(catalogOwnerFieldLabel)} hint={t(catalogOwnerHints.role)}><Select value={form.owner} onChange={event=>setOwner(event.target.value)}>{catalogOwnerChoices(data.catalog,locale).map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}</Select></Field>}
  {showOwner&&form.role&&<Facts items={[{label:t(catalogOwnerFieldLabel),value:catalogOwnerLabel(form.role,locale)}]}/>}
  {permissionsLocked&&form.role?<>
   <Notice tone="info" icon={ShieldCheck}>{t('rbac.role.assignedHint')}</Notice>
   {rightsList(roleGroups(form.role))}
  </>:rightGroups.map(group=><fieldset key={group.id} className="sdx-pick-fieldset">
   <legend>{group.label}</legend>
   {group.permissions.map(permission=><PickCheckRow key={permission.id} checked={form.permissions.includes(permission.id)} label={permissionName(permission.id)} hint={permission.id} mono blocked={rightLock(permission.id)} onChange={checked=>toggleRight(permission.id,checked)}/>)}
  </fieldset>)}
 </form>;
 const viewBody=viewed&&<div className="sdx-form-grid">
  <Notice tone="info" icon={ShieldCheck}>{lockText(viewed)??t('rbac.role.readOnly')}</Notice>
  {roleDescription(viewed,t)&&<p>{roleDescription(viewed,t)}</p>}
  {showOwner&&<Facts items={[{label:t(catalogOwnerFieldLabel),value:catalogOwnerLabel(viewed,locale)}]}/>}
  {viewed.permissions.includes('*')?<p>{t('rbac.role.allPortalDevice')}</p>:rightsList(roleGroups(viewed))}
 </div>;
 return <>
  {frameHeader(frame,manages?createButton('primary'):undefined)}
  <SettingsPage label={title} wide={body}/>
  <Drawer open={!!drawer} onClose={()=>setDrawer(null)} wide dirty={formDirty} icon={form?(form.role?Pencil:ShieldPlus):ShieldCheck}
   title={form?form.role?t('rbac.dialog.editRole'):t('rbac.createRole'):viewed?.name??''} description={form?t('rbac.dialog.roleHint'):viewed?typeLabel(viewed):undefined}
   footer={form?<><DrawerCancel/><Btn variant="primary" type="submit" form={roleFormId} loading={rbac.sending} blocked={formBlocked??saving}>{form.role?t('common.save'):t('rbac.createRole')}</Btn></>:<DrawerCancel label={t('common.close')}/>}>
   {formBody||viewBody}
  </Drawer>
  <ConfirmDialog {...confirm.dialog}/>
  <MfaStepUp {...rbac.dialog}/>
 </>;
}
