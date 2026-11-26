'use client';
// Settings › Accounts on the kit (nodiverna-ui §4 "Settings page"): the page header with "Create account", one
// SettingsPage with the account table (name and status as the focal point), a row Menu per account, the create and
// edit Drawer, the confirmations and the one-time link Dialog. Every change runs through useRbacData (step-up first,
// toasts, the generation guards), the confirmations through useRbacConfirm and the body states through rbacBody.
// "Assign role…" and the toast action after a create hand the account to the console, which opens All devices ›
// Configuration › Permissions with the assignment drawer prefilled (onAssignRole).
import {useEffect,useState,type FormEvent} from 'react';
import {toast} from 'sonner';
import {KeyRound,Pencil,ShieldCheck,UserCheck,UserPlus,UserX,Users} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {canManageAccounts,canManageRoleAssignments} from '@/ui/base/access-capabilities';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {Btn,CopyValue,Drawer,DrawerCancel,Facts,Menu,Notice,SettingsPage,StatusPill,exactTime,type MenuEntry} from '@/ui/kit/kit';
import {ResetAction} from '@/ui/kit/analysis-tab';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {ConfirmDialog,Dialog,type ConfirmLine} from '@/ui/kit/confirm-dialog';
import {Field} from '@/ui/kit/field';
import {useLocale,useT} from '@/ui/base/locale';
import {rbacAccountLines,rbacAccountName,rbacAccountParam} from '@/ui/settings/rbac-account-text';
import {rbacBody} from '@/ui/settings/rbac-body';
import {useGenerationState,useRbacConfirm,useRbacData} from '@/ui/settings/rbac-data';
import {statusKind,statusLabel,validUsername,type RbacUser} from '@/ui/settings/rbac-model';

/** The id of the create and edit form in its drawer. */
const accountFormId='sdx-rbac-account-form';
type AccountForm={user?:RbacUser;username:string;name:string;email:string};
/** reset-link: the name the link dialog shows. */
type LinkLabel={linkLabel?:string};
/** The one-time link; created: it belongs to a new account, so closing it offers "Assign role". */
type Invitation={url:string;expiresAt:number;label:string;created:boolean;userId?:string};

export default function AccountsPage({viewer,demo,onRefresh,frame,onAssignRole}:{viewer:Viewer;demo:boolean;onRefresh:()=>Promise<void>|void;
 /** The console frame: the page header at the top and the refresh count. */
 frame?:PageFrame;
 /** Opens the All devices role assignment with this account chosen (the console's prefill). */
 onAssignRole?:(userId:string)=>void}){
 const t=useT(),[locale]=useLocale();
 const rbac=useRbacData({viewer,demo,scopeKey:'accounts',endpoint:'/api/rbac',onRefresh});
 useFrameRefresh(frame,rbac.load);
 const [query,setQuery]=useState('');
 // A drawer or dialog of another generation (viewer change, session lock) is closed.
 const [form,setForm]=useGenerationState<AccountForm>(rbac.generation),[invitation,setInvitation]=useGenerationState<Invitation>(rbac.generation);
 // "Create password link" opens the one-time link dialog with the reply.
 const confirm=useRbacConfirm<LinkLabel>(rbac,{onDone:(reply,request)=>{if(reply?.invitationUrl&&reply.expiresAt)setInvitation({url:reply.invitationUrl,expiresAt:reply.expiresAt,label:request.linkLabel??'',created:false});}});
 // The link dialog closes by itself when the link expires.
 useEffect(()=>{if(!invitation)return;const timer=setTimeout(()=>setInvitation(null),Math.min(Math.max(0,invitation.expiresAt-Date.now()),2147483647));return ()=>clearTimeout(timer);},[invitation,setInvitation]);
 const data=rbac.data,title=t('nav.settings.accounts');
 const self=(user:RbacUser)=>user.id===viewer.id||user.id===viewer.userId;
 const saving=rbac.busy?t('fleet.menu.saving'):undefined;
 const manages=canManageAccounts(viewer),manageReason=!data?.canManageUsers?t('rbac.blocked.right'):saving;
 const canAssign=!!onAssignRole&&canManageRoleAssignments(viewer)&&!demo;

 // ---- Create and edit ----
 const openCreate=()=>setForm({username:'',name:'',email:''});
 const createBlocked=!data?t('rbac.blocked.loading'):!data.canManageUsers?t('rbac.blocked.right'):saving;
 const createButton=(variant:'primary'|'secondary')=><Btn variant={variant} icon={UserPlus} blocked={createBlocked} onClick={openCreate}>{t('rbac.createAccount')}</Btn>;
 const unchanged=!!form?.user&&form.name.trim()===form.user.displayName&&form.email.trim()===(form.user.email??'');
 const formBlocked=!form?undefined:!form.user&&!validUsername(form.username)?t('rbac.blocked.usernameInvalid'):!form.name.trim()?t('rbac.blocked.nameMissing'):unchanged?t('common.noChanges'):undefined;
 const formDirty=!!form&&(form.user?form.name!==form.user.displayName||form.email!==(form.user.email??''):!!(form.username||form.name||form.email));
 const announce=(userId?:string)=>toast.success(t('rbac.toast.userCreated'),canAssign&&userId?{duration:10000,action:{label:t('rbac.assignRole'),onClick:()=>onAssignRole?.(userId)}}:undefined);
 const submit=async(event:FormEvent)=>{
  // The submit repeats the button's check, so Enter in a field cannot send an incomplete form.
  event.preventDefault();if(!form||formBlocked||rbac.busy)return;
  const username=form.username.trim().toLowerCase();
  const body=form.user?{action:'update-user',userId:form.user.id,displayName:form.name.trim(),email:form.email.trim()}:{action:'create-user',username,displayName:form.name.trim(),email:form.email.trim()||undefined};
  const reply=await rbac.change({endpoint:'/api/auth',body,success:form.user?t('rbac.toast.userSaved'):undefined});
  if(!reply)return;
  setForm(null);
  if(form.user)return;
  if(reply.invitationUrl&&reply.expiresAt)setInvitation({url:reply.invitationUrl,expiresAt:reply.expiresAt,label:username,created:true,userId:reply.user?.id});
  else announce(reply.user?.id);
 };
 // Closing the link of a new account offers the next step for 10 s: "Assign role".
 const closeLink=()=>{const shown=invitation;setInvitation(null);if(shown?.created)announce(shown.userId);};

 // ---- Confirmations ----
 const ask=confirm.ask;
 const accountLine=(user:RbacUser):ConfirmLine[]=>[{label:t('rbac.account'),value:rbacAccountName(user)}];
 const toggle=(user:RbacUser)=>{
  const off=user.status!=='disabled';
  ask({title:t(off?'rbac.disableAccount.title':'rbac.enableAccount.title'),body:t(off?'rbac.disableAccount.description':'rbac.enableAccount.description',{username:rbacAccountParam(user)}),lines:accountLine(user),
   confirmLabel:t(off?'rbac.disableAccount.confirm':'rbac.enableAccount.confirm'),tone:off?'danger':'default',change:{endpoint:'/api/auth',body:{action:'disable-user',userId:user.id,disabled:off},success:t(off?'rbac.toast.accountDisabled':'rbac.toast.accountEnabled')}});
 };
 const passwordLink=(user:RbacUser)=>ask({title:t('rbac.passwordLink.title'),body:t('rbac.passwordLink.description',{username:rbacAccountParam(user)}),lines:accountLine(user),confirmLabel:t('rbac.passwordLink.confirm'),tone:'default',
  change:{endpoint:'/api/auth',body:{action:'reset-link',userId:user.id},success:t('rbac.passwordLink.created')},linkLabel:rbacAccountParam(user)});

 // ---- Table ----
 const entries=(user:RbacUser):MenuEntry[]=>{
  // Name, email and password of an Entra account come from Entra, so edit and password link never apply.
  const local=user.identitySource!=='entra',off=user.status==='disabled',list:MenuEntry[]=[];
  if(manages&&local)list.push({id:'edit',label:t('rbac.menu.editAccount'),icon:Pencil,blocked:manageReason,onSelect:()=>setForm({user,username:user.username,name:user.displayName,email:user.email??''})});
  if(onAssignRole)list.push({id:'assign',label:t('rbac.menu.assignRole'),icon:ShieldCheck,blocked:!canManageRoleAssignments(viewer)?t('rbac.blocked.assignRight'):demo?t('rbac.blocked.assignDemo'):off?t('rbac.blocked.assignDisabled'):undefined,onSelect:()=>onAssignRole(user.id)});
  if(manages&&local)list.push({id:'link',label:t('rbac.menu.passwordLink'),icon:KeyRound,blocked:off?t('rbac.blocked.passwordLinkDisabled'):manageReason,onSelect:()=>passwordLink(user)});
  if(manages)list.push({id:'separator',separator:true},off?{id:'enable',label:t('rbac.menu.enableAccount'),icon:UserCheck,blocked:manageReason,onSelect:()=>toggle(user)}
   :{id:'disable',label:t('rbac.menu.disableAccount'),icon:UserX,danger:true,blocked:self(user)?t('rbac.blocked.ownAccount'):manageReason,onSelect:()=>toggle(user)});
  return list;
 };
 const security=(user:RbacUser)=>user.identitySource==='entra'?<span className="sdx-tag">{t('rbac.entraAccount')}</span>
  :<span className="sdx-cell-stack"><span>{user.mfaEnabled===undefined?t('rbac.mfaPersonal'):user.mfaEnabled?t('rbac.mfaEnabled'):t('rbac.mfaRequired')}</span>{user.passwordSet===false&&<small>{t('rbac.noPassword')}</small>}</span>;
 const columns:DataColumn<RbacUser>[]=[
  {id:'account',label:t('rbac.account'),primary:true,wrap:true,cell:user=><span className="sdx-cell-stack"><strong>{rbacAccountName(user)}</strong>{rbacAccountLines(user,self(user),t).map((line,index)=><small key={index}>{line}</small>)}</span>},
  {id:'status',label:t('management.status'),cell:user=><StatusPill kind={statusKind(user.status)}>{statusLabel(user.status,locale)}</StatusPill>},
  {id:'security',label:t('rbac.signInSecurity'),wrap:true,cell:security},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:user=><Menu label={t('tree.actionsForName',{name:rbacAccountName(user)})} entries={entries(user)}/>},
 ];
 const normalized=query.trim().toLowerCase();
 const users=data?.users.filter(user=>`${user.username} ${user.displayName} ${user.email??''} ${statusLabel(user.status,locale)}`.toLowerCase().includes(normalized))??[];
 const empty=normalized?{icon:Users,title:t('rbac.accounts.noMatch'),action:<ResetAction label={t('history.search.clear')} onReset={()=>setQuery('')}/>}
  :{icon:Users,title:t('rbac.accounts.none'),action:manages?createButton('secondary'):undefined};
 const body=rbacBody(rbac,t,loaded=><DataTable<RbacUser> label={title} columns={columns} rows={users} rowKey={user=>user.id} cards entranceId="rbac-accounts" busy={rbac.loading} empty={empty}
  toolbar={<Toolbar search={{value:query,onChange:setQuery,label:t('rbac.search.accounts'),placeholder:t('rbac.placeholder.accounts')}}/>}
  foot={t('rbac.foot.accounts',{shown:users.length,count:loaded.users.length})}/>);
 return <>
  {frameHeader(frame,manages?createButton('primary'):undefined)}
  <SettingsPage label={title} wide={body}/>
  <Drawer open={!!form} onClose={()=>setForm(null)} dirty={formDirty} icon={form?.user?Pencil:UserPlus} title={form?.user?t('rbac.dialog.editAccount'):t('rbac.createAccount')} description={t('rbac.dialog.accountHint')}
   footer={<><DrawerCancel/><Btn variant="primary" type="submit" form={accountFormId} loading={rbac.sending} blocked={formBlocked??saving}>{form?.user?t('common.save'):t('rbac.createAccount')}</Btn></>}>
   {form&&<form id={accountFormId} className="sdx-form-grid" onSubmit={event=>void submit(event)}>
    {form.user?<Facts items={[{label:t('management.users.username'),value:form.user.username,mono:true}]}/>
     :<Field label={t('management.users.username')}><input autoFocus value={form.username} autoComplete="off" spellCheck={false} maxLength={64} onChange={event=>setForm(current=>current&&{...current,username:event.target.value})}/></Field>}
    <Field label={t('services.displayName')}><input autoFocus={!!form.user} value={form.name} maxLength={120} onChange={event=>setForm(current=>current&&{...current,name:event.target.value})}/></Field>
    <Field label={<>{t('rbac.email')} <small>{t('common.optional')}</small></>}><input type="email" value={form.email} autoComplete="off" maxLength={254} onChange={event=>setForm(current=>current&&{...current,email:event.target.value})}/></Field>
    {!form.user&&<Notice tone="info" icon={ShieldCheck}>{t('rbac.accountRightsHint')}</Notice>}
   </form>}
  </Drawer>
  <ConfirmDialog {...confirm.dialog}/>
  <Dialog open={!!invitation} onOpenChange={next=>{if(!next)closeLink();}} title={t('rbac.link.title')} description={invitation?t('rbac.link.description',{label:invitation.label}):undefined}
   footer={<Btn variant="primary" onClick={closeLink}>{t('common.close')}</Btn>}>
   {invitation&&<>
    <CopyValue value={invitation.url} label={t('rbac.link.copy')} success={t('rbac.link.copied')}/>
    <div className="sdx-confirm-body"><p>{t('rbac.link.validUntil',{stamp:exactTime(invitation.expiresAt,locale)})}</p></div>
   </>}
  </Dialog>
  <MfaStepUp {...rbac.dialog}/>
 </>;
}
