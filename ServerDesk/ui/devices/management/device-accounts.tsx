'use client';
// Management → Accounts on the console kit: a SectionHead without a visible title, the KPI row
// (local users, the Deactivated filter tile, Administrators and local groups), the local users with
// one row Menu each, the local groups with Add/Remove member, and the kit Drawer forms. Every action
// is confirmed with the review lines of ui/devices/management/management-actions.ts; the parameters come from
// ui/devices/management/local-accounts.ts, so they stay the ones the classic panel sent.
import {useState,type FormEvent} from 'react';
import {KeyRound,Pencil,Plus,ShieldCheck,Trash2,UserMinus,UserPlus,Users,UsersRound,UserX} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {deviceConnection} from '@/ui/base/ui-device';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {confirmationDevice,managementActionReason,managementMode,managementReview} from '@/ui/devices/management/management-actions';
import {ACCOUNT_LIMITS,accountMatches,accountMissing,accountParams,accountSubtitle,administratorCount,type AccountForm,type AccountKind,type LocalGroup,type LocalUser} from '@/ui/devices/management/local-accounts';
import type {MessageKey} from '@/lib/i18n/translate';
import type {Confirmation} from '@/ui/base/confirmation';
import {permitted,type Device} from '@/ui/base/api';
import {Btn,Card,Drawer,Kpi,KpiRow,Menu,PanelUnavailable,SectionHead,StatusPill,type MenuEntry} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {Field,Select} from '@/ui/kit/field';
import {useLocale,useT} from '@/ui/base/locale';
import '@/ui/devices/management/device-accounts.css';

type Props={server:Device;viewer:Viewer;demo:boolean;saving:boolean;onConfirm:(confirmation:Confirmation)=>void;now:number};
type FormKind=Exclude<AccountKind,'delete-local-user'>;
type OpenForm={serverId:string;kind:FormKind;values:AccountForm};
const blank:AccountForm={name:'',fullName:'',description:'',password:'',enabled:true,passwordNeverExpires:false,groupSid:''};
/** The name of each action: drawer title and confirm button. */
const actionLabels:Record<AccountKind,MessageKey>={'create-local-user':'accounts.confirm.create','set-local-user':'accounts.confirm.edit','reset-local-password':'accounts.confirm.password','delete-local-user':'accounts.confirm.delete','local-group-add':'accounts.confirm.addMember','local-group-remove':'accounts.confirm.removeMember'};
const actionTitles:Record<AccountKind,MessageKey>={'create-local-user':'accounts.title.create','set-local-user':'accounts.title.edit','reset-local-password':'accounts.title.password','delete-local-user':'accounts.title.delete','local-group-add':'accounts.title.addMember','local-group-remove':'accounts.title.removeMember'};
const descriptions:Record<AccountKind,MessageKey>={'create-local-user':'management.users.createDescription','set-local-user':'management.users.editDescription','reset-local-password':'management.users.resetDescription','delete-local-user':'management.users.deleteDescription','local-group-add':'management.groups.addDescription','local-group-remove':'management.groups.removeDescription'};
const dangerous:readonly AccountKind[]=['delete-local-user','local-group-remove'];

export default function DeviceAccounts({server,viewer,demo,saving,onConfirm,now}:Props){
  const t=useT(),[locale]=useLocale();
  const [search,setSearch]=useState({serverId:server.id,query:'',disabledOnly:false});
  const [form,setForm]=useState<OpenForm|null>(null);
  const [error,setError]=useState<{field:keyof AccountForm;text:string}|null>(null);
  const snapshot=server.snapshot,users=snapshot?.localUsers,groups=snapshot?.localGroups;
  const userList=users??[],groupList=groups??[];
  const filters=search.serverId===server.id?search:{serverId:server.id,query:'',disabledOnly:false};
  const openForm=form?.serverId===server.id?form:null;
  const offline=deviceConnection(server,now,locale).kind!=='online';
  const actionReason=(kind:AccountKind)=>managementActionReason({demo,canOperate:permitted(server,viewer,'manage'),canDiagnose:permitted(server,viewer,'diagnose'),offline,capabilities:snapshot?.agentCapabilities,domainRole:snapshot?.security?.domainRole,management:managementMode(server)},kind,locale);
  const reason=(kind:AccountKind)=>actionReason(kind)||(saving?t('fleet.menu.saving'):'');
  const groupReason=(kind:AccountKind)=>reason(kind)||(!userList.length||!groupList.length?t('accounts.blocked.noUsersOrGroups'):'');
  // One panel notice (nodiverna-ui §5): offline and never-reported devices have the shared DeviceStateNotice.
  const notice=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'manage'),reported:true,supported:true,management:managementMode(server)});
  const change=(values:Partial<typeof filters>)=>setSearch({...filters,...values,serverId:server.id});
  const shown=userList.filter(user=>(!filters.disabledOnly||!user.enabled)&&accountMatches(user,filters.query));
  const active=userList.filter(user=>user.enabled).length,admins=administratorCount(groups);
  const groupName=(sid:string)=>groupList.find(group=>group.sid===sid)?.name??sid;

  const confirm=(kind:AccountKind,params:Record<string,unknown>)=>{
    if(reason(kind))return;
    const name=String(params.name??'');
    const title=kind==='local-group-add'||kind==='local-group-remove'?t(actionTitles[kind],{user:name,group:groupName(String(params.groupSid??''))}):t(actionTitles[kind],{name});
    onConfirm({title,description:`${managementReview(kind,params,snapshot,locale)}\n\n${t(descriptions[kind])}`,lines:confirmationDevice(server.name,locale),confirmLabel:t(actionLabels[kind]),...(dangerous.includes(kind)?{tone:'danger' as const}:{}),payload:{action:'job',id:server.id,kind,params,confirm:true}});
  };
  const begin=(kind:FormKind,values:Partial<AccountForm>={})=>{
    if(reason(kind)||(kind==='local-group-add'||kind==='local-group-remove')&&groupReason(kind))return;
    setError(null);setForm({serverId:server.id,kind,values:{...blank,...values}});
  };
  const close=()=>{setForm(null);setError(null);};
  const edit=(values:Partial<AccountForm>)=>setForm(previous=>previous?{...previous,values:{...previous.values,...values}}:previous);
  const submit=(event:FormEvent)=>{
    event.preventDefault();
    if(!openForm||reason(openForm.kind))return;
    const missing=accountMissing(openForm.kind,openForm.values);
    if(missing){setError({field:missing,text:t('system.fieldRequired')});return;}
    confirm(openForm.kind,accountParams(openForm.kind,openForm.values));
    close();
  };
  const userMenu=(user:LocalUser):MenuEntry[]=>[
    {id:'edit',label:t('accounts.menu.edit'),icon:Pencil,blocked:reason('set-local-user')||undefined,onSelect:()=>begin('set-local-user',{name:user.name,enabled:user.enabled,fullName:user.fullName,description:user.description,passwordNeverExpires:!user.passwordExpires})},
    {id:'password',label:t('accounts.menu.password'),icon:KeyRound,blocked:reason('reset-local-password')||undefined,onSelect:()=>begin('reset-local-password',{name:user.name})},
    {id:'separator',separator:true},
    {id:'delete',label:t('accounts.menu.delete'),icon:Trash2,danger:true,blocked:reason('delete-local-user')||undefined,onSelect:()=>confirm('delete-local-user',accountParams('delete-local-user',{...blank,name:user.name}))},
  ];
  const userColumns:DataColumn<LocalUser>[]=[
    {id:'user',label:t('management.users.user'),primary:true,wrap:true,cell:user=>{const subtitle=accountSubtitle(user.fullName,user.description);return <span className="sdx-cell-stack"><strong>{user.name}</strong>{subtitle&&<small>{subtitle}</small>}</span>;}},
    {id:'status',label:t('management.status'),cell:user=><StatusPill kind={user.enabled?'success':'neutral'}>{user.enabled?t('management.active'):t('fleet.disabled')}</StatusPill>},
    {id:'expiry',label:t('management.users.passwordExpiry'),cell:user=>user.passwordExpires?t('management.param.enabled'):t('management.users.noExpiry')},
    {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:user=><Menu label={t('accounts.rowActions',{name:user.name})} entries={userMenu(user)}/>},
  ];
  const groupColumns:DataColumn<LocalGroup>[]=[
    {id:'group',label:t('fleet.col.group'),primary:true,wrap:true,cell:group=><span className="sdx-cell-stack"><strong>{group.name}</strong><small className="mono">{group.sid}</small></span>},
    {id:'members',label:t('management.groups.members'),wrap:true,cell:group=>group.members.join(', ')||<span className="sdx-muted-cell">{t('management.groups.noMembers')}</span>},
  ];
  const domainController=(snapshot?.security?.domainRole??0)>=4;
  const clear=<Btn variant="ghost" size="sm" onClick={()=>change({query:'',disabledOnly:false})}>{t('accounts.clearSearch')}</Btn>;
  const userEmpty=domainController&&!userList.length?{icon:Users,title:t('management.users.dcHint')}
    :!userList.length?{icon:Users,title:t('management.users.noInventory')}
    :{icon:Users,title:t('accounts.noMatch'),action:clear};
  const tiles=users?[
    <Kpi key="users" label={t('accounts.kpi.users')} value={userList.length} icon={Users} detail={t('accounts.kpi.active',{count:active})}/>,
    <Kpi key="disabled" label={t('accounts.kpi.disabled')} value={userList.length-active} icon={UserX} tone="neutral" hint={t('accounts.showDisabled')} pressed={filters.disabledOnly} onSelect={()=>change({disabledOnly:!filters.disabledOnly})}/>,
  ]:[
    <Kpi key="users" label={t('accounts.kpi.users')} value={null} icon={Users} tone="neutral"/>,
    <Kpi key="disabled" label={t('accounts.kpi.disabled')} value={null} icon={UserX} tone="neutral"/>,
  ];
  const values=openForm?.values,fieldError=(key:keyof AccountForm)=>error?.field===key?error.text:undefined;
  const text=(key:'name'|'fullName'|'description',label:string,options:{required?:boolean;autoFocus?:boolean}={})=><Field label={label} error={fieldError(key)}><input name={key} value={values?.[key]??''} maxLength={ACCOUNT_LIMITS[key]} required={options.required} autoFocus={options.autoFocus} autoComplete="off" onChange={event=>edit({[key]:event.target.value})}/></Field>;
  const password=(label:string)=><Field label={label} hint={t('management.passwordNote')} error={fieldError('password')}><input name="password" type="password" value={values?.password??''} maxLength={ACCOUNT_LIMITS.password} required autoComplete="new-password" autoFocus={openForm?.kind==='reset-local-password'} onChange={event=>edit({password:event.target.value})}/></Field>;
  const toggle=(key:'enabled'|'passwordNeverExpires',label:string)=><Field inline label={label}><input name={key} type="checkbox" role="switch" checked={!!values?.[key]} onChange={event=>edit({[key]:event.target.checked})}/></Field>;
  const formReason=openForm?reason(openForm.kind):'';
  return <div className="sdx-accounts">
    <SectionHead hideTitle title={t('device.area.accounts')} description={t('accounts.description')}
      meta={users||groups?<><span>{t('accounts.metaUsers',{count:userList.length})}</span> · <span>{t('accounts.metaGroups',{count:groupList.length})}</span></>:undefined}
      primary={<Btn variant="primary" icon={Plus} blocked={reason('create-local-user')||undefined} onClick={()=>begin('create-local-user')}>{t('management.users.create')}</Btn>}/>
    <PanelUnavailable reason={notice} readOnly={t('accounts.readOnly')}/>
    <KpiRow label={t('device.area.accounts')} entranceId={'accounts-kpi:'+server.id}>
      {tiles}
      <Kpi key="admins" label={t('accounts.kpi.admins')} value={admins} icon={ShieldCheck} tone={admins===null?'neutral':'accent'} detail={t('accounts.kpi.adminsDetail')}/>
      <Kpi key="groups" label={t('accounts.kpi.groups')} value={groups?groupList.length:null} icon={UsersRound} tone={groups?'accent':'neutral'}/>
    </KpiRow>
    <Card title={t('management.users.title')} icon={Users} iconTone="accent" flush className="sdx-accounts-card">
      <DataTable variant="flush" cards label={t('management.users.title')} columns={userColumns} rows={shown} rowKey={user=>user.sid||user.name} entranceId={'accounts-users:'+server.id}
        toolbar={<Toolbar search={{value:filters.query,onChange:query=>change({query}),label:t('management.searchInventory'),placeholder:t('management.searchInventory')}}/>}
        empty={userEmpty} foot={t('accounts.foot',{shown:shown.length,count:userList.length})}/>
    </Card>
    <Card title={t('management.groups.title')} icon={UsersRound} iconTone="accent" flush className="sdx-accounts-card"
      actions={<>
        <Btn size="sm" icon={UserPlus} blocked={groupReason('local-group-add')||undefined} onClick={()=>begin('local-group-add',{name:userList[0]?.name??'',groupSid:groupList[0]?.sid??''})}>{t('management.groups.add')}</Btn>
        <Btn size="sm" variant="danger" icon={UserMinus} blocked={groupReason('local-group-remove')||undefined} onClick={()=>begin('local-group-remove',{name:userList[0]?.name??'',groupSid:groupList[0]?.sid??''})}>{t('management.groups.remove')}</Btn>
      </>}>
      <DataTable variant="flush" cards label={t('management.groups.title')} columns={groupColumns} rows={groupList} rowKey={group=>group.sid} entranceId={'accounts-groups:'+server.id}
        empty={{icon:UsersRound,title:t('management.groups.noInventory')}}/>
    </Card>
    <Drawer open={!!openForm} onClose={close} title={openForm?t(actionLabels[openForm.kind]):''} description={openForm?t(descriptions[openForm.kind]):undefined}
      footer={<><Btn onClick={close}>{t('common.cancel')}</Btn><Btn type="submit" form="sdx-accounts-form" variant="primary" blocked={formReason||undefined}>{t('management.reviewChange')}</Btn></>}>
      {openForm&&values&&<form id="sdx-accounts-form" className="sdx-accounts-form" onSubmit={submit} noValidate>
        {openForm.kind==='create-local-user'&&<>
          {text('name',t('management.users.username'),{required:true,autoFocus:true})}
          {text('fullName',t('management.param.fullName'))}
          {text('description',t('common.description'))}
          {password(t('management.field.password'))}
          {toggle('passwordNeverExpires',t('management.param.passwordNeverExpires'))}
        </>}
        {openForm.kind==='set-local-user'&&<>
          <p className="sdx-accounts-subject">{t('management.review.user',{name:values.name})}</p>
          {toggle('enabled',t('management.users.accountEnabled'))}
          {text('fullName',t('management.param.fullName'),{autoFocus:true})}
          {text('description',t('common.description'))}
          {toggle('passwordNeverExpires',t('management.param.passwordNeverExpires'))}
        </>}
        {openForm.kind==='reset-local-password'&&<>
          <p className="sdx-accounts-subject">{t('management.review.user',{name:values.name})}</p>
          {password(t('management.users.newPassword'))}
        </>}
        {(openForm.kind==='local-group-add'||openForm.kind==='local-group-remove')&&<>
          <Field label={t('management.localUser')} error={fieldError('name')}><Select name="name" value={values.name} required autoFocus onChange={event=>edit({name:event.target.value})}>{userList.map(user=><option key={user.sid||user.name} value={user.name}>{user.name}</option>)}</Select></Field>
          <Field label={t('management.localGroup')} error={fieldError('groupSid')}><Select name="groupSid" value={values.groupSid} required onChange={event=>edit({groupSid:event.target.value})}>{groupList.map(group=><option key={group.sid} value={group.sid}>{group.name}</option>)}</Select></Field>
        </>}
      </form>}
    </Drawer>
  </div>;
}
