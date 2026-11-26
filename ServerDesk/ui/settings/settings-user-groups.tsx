'use client';
// Settings › User groups on the kit (nodiverna-ui §4 "Settings page"): the page header with "Create user group", one
// SettingsPage with the group table (group, member count and status as the focal point), a row Menu per group, the
// group Drawer with its members and "Add member", the create and edit Drawer and the confirmations. A group with role
// assignments needs the assignment right for every change of its access (canChangeGroupAccess). Every change runs
// through useRbacData (step-up first, toasts, the generation guards), the confirmations through useRbacConfirm and the
// body states through rbacBody.
import {useState,type FormEvent} from 'react';
import {Pencil,Power,PowerOff,Trash2,UserMinus,UserPlus,Users} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {canManageUserGroups} from '@/ui/base/access-capabilities';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {Btn,Drawer,DrawerCancel,Empty,Menu,PickList,PickRow,SectionHead,SettingsPage,StatusPill,type MenuEntry} from '@/ui/kit/kit';
import {ResetAction} from '@/ui/kit/analysis-tab';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {ConfirmDialog,type ConfirmLine} from '@/ui/kit/confirm-dialog';
import {Field} from '@/ui/kit/field';
import {useLocale,useT} from '@/ui/base/locale';
import {rbacAccountName,rbacAccountOption,rbacAccountParam,rbacMemberLine} from '@/ui/settings/rbac-account-text';
import {rbacBody} from '@/ui/settings/rbac-body';
import {useGenerationState,useRbacConfirm,useRbacData} from '@/ui/settings/rbac-data';
import {canChangeGroupAccess,statusLabel,type RbacGroup,type RbacUser} from '@/ui/settings/rbac-model';

/** The id of the create and edit form in its drawer. */
const groupFormId='sdx-rbac-group-form';
type GroupForm={group?:RbacGroup;name:string;description:string};
/** The open group drawer: the group id (its data follows each reload), the picked account and the pick search. */
type GroupDetail={groupId:string;memberId:string;search:string};
type Member={id:string;user?:RbacUser};

export default function UserGroupsPage({viewer,demo,onRefresh,frame}:{viewer:Viewer;demo:boolean;onRefresh:()=>Promise<void>|void;
 /** The console frame: the page header at the top and the refresh count. */
 frame?:PageFrame}){
 const t=useT(),[locale]=useLocale();
 const rbac=useRbacData({viewer,demo,scopeKey:'usergroups',endpoint:'/api/rbac',onRefresh});
 useFrameRefresh(frame,rbac.load);
 const [query,setQuery]=useState('');
 // A drawer or dialog of another generation (viewer change, session lock) is closed.
 const [form,setForm]=useGenerationState<GroupForm>(rbac.generation),[detail,setDetail]=useGenerationState<GroupDetail>(rbac.generation),confirm=useRbacConfirm(rbac);
 const data=rbac.data,title=t('nav.settings.userGroups'),manages=canManageUserGroups(viewer);
 const opened=detail?data?.userGroups.find(group=>group.id===detail.groupId):undefined;
 const saving=rbac.busy?t('fleet.menu.saving'):undefined;
 // Changes of a group with role assignments also need the assignment right; the server says whether the viewer has it.
 const accessReason=(group:RbacGroup)=>!data?.canManageUserGroups?t('rbac.blocked.right'):!canChangeGroupAccess(group,data)?t('rbac.group.assignmentRight'):saving;

 // ---- Create and edit ----
 const openCreate=()=>setForm({name:'',description:''});
 const createBlocked=!data?t('rbac.blocked.loading'):!data.canManageUserGroups?t('rbac.blocked.right'):saving;
 const createButton=(variant:'primary'|'secondary')=><Btn variant={variant} icon={Users} blocked={createBlocked} onClick={openCreate}>{t('rbac.createGroup')}</Btn>;
 const unchanged=!!form?.group&&form.name.trim()===form.group.name&&form.description.trim()===form.group.description;
 const formBlocked=!form?undefined:!form.name.trim()?t('rbac.blocked.nameMissing'):unchanged?t('common.noChanges'):undefined;
 const formDirty=!!form&&(form.group?form.name!==form.group.name||form.description!==form.group.description:!!(form.name||form.description));
 const submit=async(event:FormEvent)=>{
  event.preventDefault();if(!form||formBlocked||rbac.busy)return;
  const fields={name:form.name.trim(),description:form.description.trim()};
  const body=form.group?{action:'update-group',id:form.group.id,enabled:form.group.enabled,...fields}:{action:'create-group',...fields};
  if(await rbac.change({endpoint:'/api/rbac',body,success:t(form.group?'rbac.toast.groupSaved':'rbac.toast.groupCreated')}))setForm(null);
 };

 // ---- Confirmations ----
 const ask=confirm.ask;
 const groupLine=(group:RbacGroup):ConfirmLine=>({label:t('rbac.userGroup'),value:group.name});
 const toggle=(group:RbacGroup)=>{
  const off=group.enabled;
  ask({title:t(off?'rbac.group.disable.title':'rbac.group.enable.title'),body:t(off?'rbac.group.disable.description':'rbac.group.enable.description',{name:group.name}),lines:[groupLine(group)],confirmLabel:t(off?'rbac.group.disable.confirm':'rbac.group.enable.confirm'),tone:off?'danger':'default',
   change:{endpoint:'/api/rbac',body:{action:'update-group',id:group.id,name:group.name,description:group.description,enabled:!off},success:t(off?'rbac.toast.groupDisabled':'rbac.toast.groupEnabled')}});
 };
 const remove=(group:RbacGroup)=>ask({title:t('rbac.group.delete.title'),body:t('rbac.group.delete.description',{name:group.name}),lines:[groupLine(group)],confirmLabel:t('rbac.group.delete.confirm'),tone:'danger',
  change:{endpoint:'/api/rbac',body:{action:'delete-group',id:group.id},success:t('rbac.toast.groupDeleted')}});
 const removeMember=(group:RbacGroup,member:Member)=>{
  const value=member.user?rbacAccountParam(member.user):member.id;
  ask({title:t('rbac.member.remove.title'),body:t('rbac.member.remove.description',{value,name:group.name}),lines:[{label:t('rbac.account'),value:member.user?rbacAccountName(member.user):member.id},groupLine(group)],confirmLabel:t('rbac.member.remove.confirm'),tone:'danger',
   change:{endpoint:'/api/rbac',body:{action:'remove-member',groupId:group.id,userId:member.id},success:t('rbac.toast.memberRemoved')}});
 };
 // The drawer stays open with the new member list; the pick and its search start again.
 const addMember=async(group:RbacGroup,memberId:string)=>{
  if(!memberId||rbac.busy||accessReason(group))return;
  if(await rbac.change({endpoint:'/api/rbac',body:{action:'add-member',groupId:group.id,userId:memberId},success:t('rbac.toast.memberAdded')}))setDetail(current=>current&&{...current,memberId:'',search:''});
 };

 // ---- Table ----
 const entries=(group:RbacGroup):MenuEntry[]=>[
  {id:'edit',label:t('rbac.menu.editGroup'),icon:Pencil,blocked:!data?.canManageUserGroups?t('rbac.blocked.right'):saving,onSelect:()=>setForm({group,name:group.name,description:group.description})},
  group.enabled?{id:'disable',label:t('rbac.menu.disableGroup'),icon:PowerOff,blocked:accessReason(group),onSelect:()=>toggle(group)}:{id:'enable',label:t('rbac.menu.enableGroup'),icon:Power,blocked:accessReason(group),onSelect:()=>toggle(group)},
  {id:'separator',separator:true},
  {id:'delete',label:t('rbac.menu.deleteGroup'),icon:Trash2,danger:true,blocked:accessReason(group),onSelect:()=>remove(group)},
 ];
 const columns:DataColumn<RbacGroup>[]=[
  {id:'group',label:t('rbac.userGroup'),primary:true,wrap:true,cell:group=><span className="sdx-cell-stack"><strong>{group.name}</strong>{group.description&&<small>{group.description}</small>}</span>},
  {id:'members',label:t('rbac.col.members'),tabular:true,cell:group=>t('rbac.members',{count:group.userIds.length})},
  {id:'status',label:t('management.status'),cell:group=><StatusPill kind={group.enabled?'success':'neutral'}>{group.enabled?t('management.active'):t('fleet.disabled')}</StatusPill>},
  ...(manages?[{id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:(group:RbacGroup)=><Menu label={t('tree.actionsForName',{name:group.name})} entries={entries(group)}/>}]:[]),
 ];
 const normalized=query.trim().toLowerCase();
 const groups=data?.userGroups.filter(group=>`${group.name} ${group.description}`.toLowerCase().includes(normalized))??[];
 const empty=normalized?{icon:Users,title:t('rbac.groups.noMatch'),action:<ResetAction label={t('history.search.clear')} onReset={()=>setQuery('')}/>}
  :{icon:Users,title:t('rbac.groups.none'),children:t('rbac.groups.noneHint'),action:manages?createButton('secondary'):undefined};
 const body=rbacBody(rbac,t,loaded=><DataTable<RbacGroup> label={title} columns={columns} rows={groups} rowKey={group=>group.id} cards entranceId="rbac-groups" busy={rbac.loading} empty={empty}
  onOpen={group=>setDetail({groupId:group.id,memberId:'',search:''})} openLabel={group=>t('rbac.openGroup',{name:group.name})}
  toolbar={<Toolbar search={{value:query,onChange:setQuery,label:t('rbac.search.groups'),placeholder:t('rbac.placeholder.groups')}}/>}
  foot={t('rbac.foot.groups',{shown:groups.length,count:loaded.userGroups.length})}/>);

 // ---- The group drawer: members and "Add member" ----
 const members:Member[]=opened&&data?opened.userIds.map(id=>({id,user:data.users.find(user=>user.id===id)})):[];
 const memberColumns:DataColumn<Member>[]=opened?[
  {id:'account',label:t('rbac.account'),primary:true,wrap:true,cell:member=><span className="sdx-cell-stack"><strong>{member.user?rbacAccountName(member.user):t('rbac.subject.accountGone')}</strong><small>{member.user?rbacMemberLine(member.user,statusLabel(member.user.status,locale)):member.id}</small></span>},
  ...(manages?[{id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:(member:Member)=><Menu label={t('tree.actionsForName',{name:member.user?rbacAccountName(member.user):member.id})} entries={[{id:'remove',label:t('rbac.menu.removeMember'),icon:UserMinus,danger:true,blocked:accessReason(opened),onSelect:()=>removeMember(opened,member)}]}/>}]:[]),
 ]:[];
 // Active and invited accounts that are not members; one at a time, because every change needs its own proof.
 const candidates=opened&&data?data.users.filter(user=>user.status!=='disabled'&&!opened.userIds.includes(user.id)):[];
 const pickSearch=detail?.search.trim().toLowerCase()??'';
 const shownCandidates=candidates.filter(user=>`${user.username} ${user.displayName} ${user.email??''}`.toLowerCase().includes(pickSearch));
 const addReason=opened?accessReason(opened)??(!detail?.memberId?t('rbac.group.chooseAccount'):undefined):undefined;
 const groupDrawer=<Drawer open={!!opened} onClose={()=>setDetail(null)} icon={Users} title={opened?.name??''} description={opened?(opened.enabled?t('rbac.group.rightsHint'):t('rbac.group.disabledHint')):undefined}
  footer={<DrawerCancel label={t('common.close')}/>}>
  {opened&&detail&&<div className="sdx-form-grid">
   {opened.description&&<p className="sdx-muted-cell">{opened.description}</p>}
   <section className="sdx-form-grid" aria-labelledby="sdx-rbac-members-title">
    <SectionHead id="sdx-rbac-members-title" level={3} title={t('rbac.group.membersTitle')}/>
    <DataTable<Member> label={t('rbac.group.membersTitle')} variant="flush" cards columns={memberColumns} rows={members} rowKey={member=>member.id} empty={{icon:Users,title:t('rbac.group.noMembers')}}/>
   </section>
   {manages&&<section className="sdx-form-grid" aria-labelledby="sdx-rbac-add-title">
    <SectionHead id="sdx-rbac-add-title" level={3} title={t('rbac.group.addTitle')}/>
    <PickList mode="radio" label={t('rbac.group.pickLabel')} search={candidates.length?{value:detail.search,onChange:search=>setDetail(current=>current&&{...current,search}),label:t('rbac.search.accounts'),placeholder:t('rbac.placeholder.accounts')}:undefined}
     empty={<Empty icon={UserPlus} title={candidates.length?t('rbac.accounts.noMatch'):t('rbac.group.noCandidates')}/>}>
     {shownCandidates.map(user=><PickRow key={user.id} selected={detail.memberId===user.id} icon={<UserPlus size={15} aria-hidden/>} label={rbacAccountOption(user)} hint={statusLabel(user.status,locale)} onSelect={()=>setDetail(current=>current&&{...current,memberId:user.id})}/>)}
    </PickList>
    <div><Btn icon={UserPlus} loading={rbac.sending&&!!detail.memberId} blocked={addReason} onClick={()=>void addMember(opened,detail.memberId)}>{t('management.groups.add')}</Btn></div>
   </section>}
  </div>}
 </Drawer>;

 return <>
  {frameHeader(frame,manages?createButton('primary'):undefined)}
  <SettingsPage label={title} wide={body}/>
  {groupDrawer}
  <Drawer open={!!form} onClose={()=>setForm(null)} dirty={formDirty} icon={form?.group?Pencil:Users} title={form?.group?t('rbac.dialog.editGroup'):t('rbac.createGroup')} description={t('rbac.dialog.groupHint')}
   footer={<><DrawerCancel/><Btn variant="primary" type="submit" form={groupFormId} loading={rbac.sending} blocked={formBlocked??saving}>{form?.group?t('common.save'):t('rbac.createGroup')}</Btn></>}>
   {form&&<form id={groupFormId} className="sdx-form-grid" onSubmit={event=>void submit(event)}>
    <Field label={t('common.name')}><input autoFocus value={form.name} maxLength={80} onChange={event=>setForm(current=>current&&{...current,name:event.target.value})}/></Field>
    <Field label={<>{t('common.description')} <small>{t('common.optional')}</small></>}><textarea value={form.description} maxLength={500} onChange={event=>setForm(current=>current&&{...current,description:event.target.value})}/></Field>
   </form>}
  </Drawer>
  <ConfirmDialog {...confirm.dialog}/>
  <MfaStepUp {...rbac.dialog}/>
 </>;
}
