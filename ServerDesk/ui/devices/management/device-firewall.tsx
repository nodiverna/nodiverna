'use client';
// The card "Firewall rules" of Management → Network: the collected rules with search and paging, Enable or Disable per
// rule and "Create rule" in the kit Drawer. Every change is confirmed before it runs (device-management-confirm.ts).
import {useRef,useState,type FormEvent} from 'react';
import {Plus,Power,PowerOff,Shield} from 'lucide-react';
import type {ServerSnapshot} from '@/lib/types';
import type {MessageKey} from '@/lib/i18n/translate';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {confirmManagementAction,managementActionTitles,panelManageReason,type ManagementPanelProps} from '@/ui/devices/management/device-management-confirm';
import {Btn,Card,Drawer,Menu,StatusPill} from '@/ui/kit/kit';
import {DataTable,Toolbar,pageWindow,type DataColumn} from '@/ui/kit/data-table';
import {Field,Select} from '@/ui/kit/field';
import {useLocale,useT} from '@/ui/base/locale';
import '@/ui/devices/management/device-system.css';

type FirewallRule=NonNullable<ServerSnapshot['firewallRules']>[number];
type RuleForm={serverId:string;values:Record<string,string>;missing:string|null};
const LIST_PAGE_SIZE=25;
const blankRule=():Record<string,string>=>({name:'',direction:'Inbound',action:'Allow',protocol:'TCP',port:'',remoteAddress:'LocalSubnet'});
const requiredFields=['name','port','remoteAddress'];
/** The job parameters of a new rule, exactly as the classic management panel built them. */
export function firewallRuleParams(values:Record<string,string>):Record<string,unknown>{
 const trim=(key:string)=>String(values[key]??'').trim();
 return {name:trim('name'),direction:trim('direction'),action:trim('action'),protocol:trim('protocol'),port:trim('port'),remoteAddress:trim('remoteAddress')};
}

export default function FirewallRulesCard(props:ManagementPanelProps){
 const t=useT(),[locale]=useLocale(),live=useRef(props);live.current=props;
 const {server}=props,snapshot=server.snapshot;
 const [list,setList]=useState({serverId:server.id,query:'',page:1}),[form,setForm]=useState<RuleForm|null>(null);
 const current=list.serverId===server.id?list:{serverId:server.id,query:'',page:1},open=form?.serverId===server.id?form:null;
 const reasonOf=(kind:string)=>panelManageReason(props,kind,locale);
 const rules=snapshot?.firewallRules??[],query=current.query.toLowerCase();
 const matches=rules.filter(rule=>(rule.name+' '+rule.displayName+' '+rule.port).toLowerCase().includes(query));
 const pageView=pageWindow(current.page,LIST_PAGE_SIZE,matches.length),rows=matches.slice(pageView.start?pageView.start-1:0,pageView.end);
 const translated=(value:string,keys:Record<string,MessageKey>)=>Object.hasOwn(keys,value)?t(keys[value]):value;
 const toggle=(rule:FirewallRule)=>confirmManagementAction(live.current,server.id,'set-firewall-rule',{name:rule.name,enabled:!rule.enabled},t(rule.enabled?'management.firewall.disableDescription':'management.firewall.enableDescription',{name:rule.displayName}),rule.enabled?t('management.disable'):t('management.enable'),locale);
 const columns:DataColumn<FirewallRule>[]=[
  {id:'rule',label:t('management.firewall.rule'),primary:true,wrap:true,cell:rule=><span className="sdx-cell-stack"><span>{rule.displayName}</span><small className="mono">{rule.name}</small></span>},
  {id:'direction',label:t('management.firewall.directionAction'),cell:rule=>`${translated(rule.direction,{Inbound:'management.firewall.inbound',Outbound:'management.firewall.outbound'})} · ${translated(rule.action,{Allow:'management.firewall.allow',Block:'management.firewall.block'})}`},
  {id:'ports',label:t('management.firewall.portsSource'),cell:rule=><span className="sdx-cell-stack"><span className="mono">{rule.protocol} / {rule.port}</span><small>{rule.remoteAddress}</small></span>},
  {id:'status',label:t('management.status'),cell:rule=><StatusPill kind={rule.enabled?'success':'neutral'}>{rule.enabled?t('management.active'):t('fleet.disabled')}</StatusPill>},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:rule=><Menu label={t('tree.actionsForName',{name:rule.displayName})} entries={[{id:'toggle',label:rule.enabled?t('management.disable'):t('management.enable'),icon:rule.enabled?PowerOff:Power,blocked:reasonOf('set-firewall-rule')||undefined,onSelect:()=>toggle(rule)}]}/>},
 ];
 const openForm=()=>{if(!reasonOf('add-firewall-rule'))setForm({serverId:server.id,values:blankRule(),missing:null});};
 const close=()=>setForm(null);
 const change=(key:string,value:string)=>setForm(previous=>previous?{...previous,values:{...previous.values,[key]:value},missing:null}:previous);
 const submit=(event:FormEvent)=>{
  event.preventDefault();if(!open)return;
  const missing=requiredFields.find(key=>!String(open.values[key]??'').trim());
  if(missing){setForm({...open,missing});return;}
  confirmManagementAction(live.current,open.serverId,'add-firewall-rule',firewallRuleParams(open.values),t('management.firewall.createDescription'),t('management.firewall.create'),locale);
  close();
 };
 const field=(key:string,label:string,options:{hint?:string;maxLength?:number;autoFocus?:boolean}={})=><Field label={label} hint={options.hint} error={open?.missing===key?t('system.fieldRequired'):undefined}><input name={key} value={open?.values[key]??''} maxLength={options.maxLength} autoFocus={options.autoFocus} autoComplete="off" required={requiredFields.includes(key)} onChange={event=>change(key,event.target.value)}/></Field>;
 const select=(key:string,label:string,choices:{value:string;label:string}[])=><Field label={label}><Select name={key} value={open?.values[key]??''} onChange={event=>change(key,event.target.value)}>{choices.map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}</Select></Field>;
 return <>
  <Card title={t('management.firewall.title')} icon={Shield} iconTone="accent" description={t('management.firewall.hint')} meta={t('management.collected',{value:snapshot?.firewallRules?rules.length:EMPTY_VALUE})} flush className="sdx-system-list sdx-firewall-rules"
   actions={<Btn size="sm" icon={Plus} blocked={reasonOf('add-firewall-rule')||undefined} onClick={openForm}>{t('management.firewall.create')}</Btn>}>
   <DataTable variant="flush" cards label={t('management.firewall.title')} columns={columns} rows={rows} rowKey={rule=>rule.name} entranceId={'firewall-rules:'+server.id}
    toolbar={<Toolbar search={{value:current.query,onChange:value=>setList({...current,query:value,page:1}),label:t('system.firewall.search'),placeholder:t('management.searchInventory')}}/>}
    empty={!rules.length?{icon:Shield,title:t('management.firewall.noInventory')}:{icon:Shield,title:t('system.firewall.noMatch'),children:t('services.adjust')}}
    foot={t('system.firewall.foot',{count:rules.length,filtered:matches.length})}
    pagination={{page:pageView.page,pageSize:LIST_PAGE_SIZE,total:matches.length,onPage:value=>setList({...current,page:value})}}/>
  </Card>
  <Drawer open={!!open} onClose={close} title={t(managementActionTitles['add-firewall-rule'])} description={t('management.firewall.createDescription')}
   footer={<><Btn onClick={close}>{t('common.cancel')}</Btn><Btn type="submit" form="sdx-firewall-rule" variant="primary" blocked={open?reasonOf('add-firewall-rule')||undefined:undefined}>{t('management.reviewChange')}</Btn></>}>
   {open&&<form id="sdx-firewall-rule" className="sdx-system-editor" onSubmit={submit}>
    {field('name',t('management.firewall.ruleName'),{maxLength:120,autoFocus:true})}
    {select('direction',t('management.param.direction'),[{value:'Inbound',label:t('management.firewall.inbound')},{value:'Outbound',label:t('management.firewall.outbound')}])}
    {select('action',t('management.firewall.action'),[{value:'Allow',label:t('management.firewall.allow')},{value:'Block',label:t('management.firewall.block')}])}
    {select('protocol',t('management.param.protocol'),[{value:'TCP',label:t('management.firewall.protocolTcp')},{value:'UDP',label:t('management.firewall.protocolUdp')}])}
    {field('port',t('management.firewall.localPorts'),{hint:t('management.firewall.portsHelp'),maxLength:100})}
    {field('remoteAddress',t('management.param.remoteAddress'),{hint:t('management.firewall.remoteHelp'),maxLength:500})}
   </form>}
  </Drawer>
 </>;
}
