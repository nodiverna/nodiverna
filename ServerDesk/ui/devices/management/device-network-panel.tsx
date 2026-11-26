'use client';
// Management → Network on the console kit: a SectionHead without a visible title (copy, export,
// refresh), the KPI row, one card per adapter with its IPv4 and DNS editors in the kit Drawer, the
// network diagnostics card and, last, the Firewall rules card (device-firewall.tsx). Every adapter
// change is confirmed through ui/devices/management/network-panel.ts.
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Network,Copy,Check,Download,ArrowUpRight,Pencil,Activity,RefreshCw,Router,Server as ServerIcon,AlertTriangle,Cable} from 'lucide-react';
import {toast} from 'sonner';
import type {Viewer} from '@/lib/types';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {networkAdapters,networkIdentity,networkFingerprint,currentNetworkAdapter,networkActionReason,networkConfirmation,ipv4Subnet,adapterStatus,type NetworkAdapter,type NetworkSelection} from '@/ui/devices/management/network-panel';
import {confirmationDevice} from '@/ui/devices/management/management-actions';
import {operations} from '@/lib/management';
import {diagnosticDefinitions} from '@/lib/diagnostics';
import {createDiagnosisClient,diagnosisRunning,diagnosisQueryState,type DiagnosisJob,type DiagnosisSubmission} from '@/ui/devices/diagnostics/diagnosis-client';
import {api,ApiError,message,stamp,permitted,downloadText,type Device} from '@/ui/base/api';
import type {Confirmation} from '@/ui/base/confirmation';
import {agentMessageText} from '@/lib/agent-messages';
import {Btn,Card,Drawer,Empty,Facts,IconBtn,Kpi,KpiRow,Notice,PanelUnavailable,SectionHead,Skeleton,StatusPill,Unavailable} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {Field,Select} from '@/ui/kit/field';
import FirewallRulesCard from '@/ui/devices/management/device-firewall';
import '@/ui/devices/management/device-network-panel.css';

import {useLocale,useT} from '@/ui/base/locale';
import type {Locale} from '@/lib/i18n/locale';
import {EMPTY_VALUE,formatDuration,formatNumber} from '@/lib/i18n/format';
export type DeviceNetworkProps={server:Device;viewer:Viewer;demo:boolean;saving:boolean;onConfirm:(confirmation:Confirmation)=>void;now:number;onOpenConnections?:()=>void};
type Editor={target:NetworkSelection;kind:'set-network'|'set-dns';dhcp:boolean;address:string;prefix:string;gateway:string;automatic:boolean;dns:string};
type DiagnosisState={scope:string;jobs:DiagnosisJob[];error:string;errorSource:'read'|'submit'|null;loading:boolean;busy:boolean;submitted:DiagnosisSubmission|null};
type Row=Record<string,unknown>;
type ResultRow={key:string;row:Row};
/** How long a copy button shows its check after a successful copy (ms). */
const copiedFor=1200;
const row=(value:unknown):Row=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const rows=(value:unknown):Row[]=>Array.isArray(value)?value.map(row):[];
const strings=(value:unknown):string[]=>Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];
const text=(value:unknown)=>value===undefined||value===null||value===''?EMPTY_VALUE:String(value);
const number=(locale:Locale,value:unknown)=>typeof value==='number'&&Number.isFinite(value)?formatNumber(locale,value):EMPTY_VALUE;
const selection=(server:Device,adapter:NetworkAdapter):NetworkSelection=>({serverId:server.id,interfaceIndex:adapter.interfaceIndex,fingerprint:networkFingerprint(adapter)});
const report=(server:Device)=>({device:server.name,inventoryAt:server.lastSeen?new Date(server.lastSeen).toISOString():null,adapters:networkAdapters(server),networkInventory:server.snapshot?.networks??[]});
const canRead=(props:DeviceNetworkProps)=>!props.server.revoked&&permitted(props.server,props.viewer,'view');
const diagnosticEnabled=(props:DeviceNetworkProps)=>canRead(props)&&!props.demo&&props.server.snapshot?.protocolVersion===3&&permitted(props.server,props.viewer,'diagnose');
const scopeKey=(props:DeviceNetworkProps)=>JSON.stringify([props.server.id,props.viewer.id,props.viewer.label,diagnosticEnabled(props)]);
const blankDiagnosis=(scope:string):DiagnosisState=>({scope,jobs:[],error:'',errorSource:null,loading:true,busy:false,submitted:null});
const presets=[{name:'HTTPS',port:'443'},{name:'DNS',port:'53'},{name:'SMB',port:'445'},{name:'RDP',port:'3389'}];

function useNetworkDiagnosis(props:DeviceNetworkProps,live:{current:DeviceNetworkProps}){
  const [locale]=useLocale(),clientLocale=useRef(locale);
  // The client takes the language once; a switch applies to the next client, without a reload.
  useEffect(()=>{clientLocale.current=locale;},[locale]);
  const scope=scopeKey(props),enabled=diagnosticEnabled(props);
  const [state,setState]=useState<DiagnosisState>(()=>blankDiagnosis(scope));
  const client=useRef<{scope:string;value:ReturnType<typeof createDiagnosisClient>}|null>(null);
  useEffect(()=>{
    setState(blankDiagnosis(scope));if(!enabled)return;
    let disposed=false,pending=false,submittedId:string|null=null;
    const current=()=>!disposed&&scopeKey(live.current)===scope&&diagnosticEnabled(live.current);
    const update=(values:Partial<DiagnosisState>)=>{if(current())setState(previous=>({...previous,...values,scope}));};
    const value=createDiagnosisClient({
      isCurrent:current,canSubmit:kind=>kind==='network-diagnostics'&&!networkActionReason(live.current,kind,clientLocale.current),
      read:signal=>api<{jobs:DiagnosisJob[]}>('/api/diagnostics?serverId='+encodeURIComponent(props.server.id),undefined,signal),
      post:(kind,params,_confirm,signal)=>api<{id:string}>('/api/diagnostics',{serverId:props.server.id,kind,params},signal),
      onJobs:jobs=>{const submittedJob=submittedId?jobs.find(job=>job.id===submittedId):undefined,completed=!!submittedJob&&!diagnosisRunning(submittedJob);if(completed)submittedId=null;pending=jobs.some(job=>job.kind==='network-diagnostics'&&diagnosisRunning(job))||!!submittedId&&!jobs.some(job=>job.id===submittedId);if(current())setState(previous=>({...previous,jobs:jobs.filter(job=>job.kind==='network-diagnostics'),loading:false,...(completed?{submitted:null}:{}),...(previous.errorSource==='submit'?{}:{error:'',errorSource:null}),scope}));},
      // A failed read shows in the card with "Try again"; a failed check is an action error (toast).
      onError:(error,source)=>{if(error instanceof ApiError&&[401,403].includes(error.status)){pending=false;update({jobs:[]});}if(source==='submit'){if(current())toast.error(message(error));update({loading:false});return;}update({error:message(error),errorSource:source,loading:false});},
      onLoading:loading=>update({loading}),onBusy:kind=>update({busy:!!kind,...(kind?{error:'',errorSource:null as null}:{})}),onSubmitted:submitted=>{pending=true;submittedId=submitted.id;update({submitted});},
    },clientLocale.current);
    client.current={scope,value};void value.load();
    // Idle network inventory needs no continuous diagnostic requests. Only
    // pending jobs are polled, and hidden tabs remain quiet.
    const refresh=()=>{if(current()&&document.visibilityState!=='hidden'&&pending)void value.load();};
    const visible=()=>{if(current()&&document.visibilityState!=='hidden')void value.load();};
    const timer=setInterval(refresh,3000);document.addEventListener('visibilitychange',visible);
    return()=>{disposed=true;clearInterval(timer);document.removeEventListener('visibilitychange',visible);value.dispose();if(client.current?.value===value)client.current=null;};
  },[scope,enabled,live,props.server.id]);
  const current=enabled&&state.scope===scope?state:{...blankDiagnosis(scope),loading:false};
  const submit=(params:Row,expectedScope=scope)=>{
    const next=live.current;
    if(expectedScope!==scopeKey(next)||networkActionReason(next,'network-diagnostics',clientLocale.current)||client.current?.scope!==expectedScope)return Promise.resolve();
    return client.current.value.submit('network-diagnostics',params).then(()=>{}).catch(()=>{});
  };
  const reload=()=>{if(client.current?.scope===scope&&scopeKey(live.current)===scope)return client.current.value.load();};
  return {...current,enabled,submit,reload};
}

export default function DeviceNetworkPanel(props:DeviceNetworkProps){
  const t=useT(),[locale]=useLocale();
  const {server,viewer,demo,now,onOpenConnections}=props;
  const live=useRef(props);live.current=props;
  const [filters,setFilters]=useState({serverId:server.id,query:'',status:'all'});
  const [editor,setEditor]=useState<Editor|null>(null),[editorError,setEditorError]=useState('');
  const editorRef=useRef(editor);editorRef.current=editor;
  const [copy,setCopy]=useState({serverId:server.id,key:''});
  const [target,setTarget]=useState({serverId:server.id,host:'',port:'443'});
  const targetRef=useRef(target);targetRef.current=target;
  const copyTimer=useRef<ReturnType<typeof setTimeout>|null>(null),lastCheck=useRef<Row|null>(null);
  const diagnosis=useNetworkDiagnosis(props,live),scope=scopeKey(props);
  const adapters=networkAdapters(server),known=Array.isArray(server.snapshot?.networkConfig),allowed=canRead(props);
  const filter=filters.serverId===server.id?filters:{serverId:server.id,query:'',status:'all'},draft=target.serverId===server.id?target:{serverId:server.id,host:'',port:'443'};
  const activeEditor=editor?.target.serverId===server.id?editor:null,chosen=activeEditor?currentNetworkAdapter(server,activeEditor.target):null;
  const matching=adapters.filter(adapter=>(filter.status==='all'||filter.status==='up'&&adapter.status==='Up'||filter.status==='other'&&adapter.status!=='Up')&&[adapter.alias,adapter.interfaceIndex,...adapter.addresses.map(ip=>ip.address),...adapter.gateway,...adapter.dns].join(' ').toLowerCase().includes(filter.query.trim().toLowerCase()));
  const gateways=[...new Set(adapters.flatMap(adapter=>adapter.gateway))],dnsServers=[...new Set(adapters.flatMap(adapter=>adapter.dns))],up=adapters.filter(adapter=>adapter.status==='Up').length;
  const refreshReason=networkActionReason(props,'refresh',locale),diagReason=networkActionReason(props,'network-diagnostics',locale);
  // One panel notice (nodiverna-ui §5): offline and never-reported devices have the shared DeviceStateNotice.
  const notice=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'manage'),reported:true,supported:true,management:!server.snapshot||server.management===1&&server.snapshot.mode==='Management'});
  const copied=(key:string)=>copy.serverId===server.id&&copy.key===key;
  const changeFilter=(values:Partial<typeof filter>)=>setFilters({...filter,...values});
  const changeTarget=(values:Partial<typeof draft>)=>{const next={...draft,...values};targetRef.current=next;setTarget(next);};
  const updateEditor=(values:Partial<Editor>)=>{const existing=editorRef.current;if(!existing||existing.target.serverId!==live.current.server.id)return;const next={...existing,...values};editorRef.current=next;setEditor(next);setEditorError('');};
  const openEditor=(chosenTarget:NetworkSelection,kind:Editor['kind'])=>{
    const current=live.current,adapter=currentNetworkAdapter(current.server,chosenTarget);if(!adapter||networkActionReason(current,kind,locale))return;
    const ip=adapter.addresses.find(item=>!item.address.includes(':'));
    const next:Editor={target:chosenTarget,kind,dhcp:adapter.dhcp,address:ip?.address??'',prefix:String(ip?.prefixLength??24),gateway:adapter.gateway.find(value=>!value.includes(':'))??'',automatic:false,dns:adapter.dns.join(', ')};
    editorRef.current=next;setEditor(next);setEditorError('');
  };
  const closeEditor=()=>{editorRef.current=null;setEditor(null);setEditorError('');};
  const confirm=(event:FormEvent)=>{
    event.preventDefault();const current=live.current,value=editorRef.current;
    if(!value||!currentNetworkAdapter(current.server,value.target)||networkActionReason(current,value.kind,locale))return;
    const params=value.kind==='set-network'?{interfaceIndex:value.target.interfaceIndex,dhcp:value.dhcp,...(!value.dhcp?{address:value.address.trim(),prefixLength:Number(value.prefix),...(value.gateway.trim()?{gateway:value.gateway.trim()}:{})}:{})}:{interfaceIndex:value.target.interfaceIndex,automatic:value.automatic,servers:value.automatic?[]:value.dns.split(',').map(item=>item.trim()).filter(Boolean)};
    const validation=operations[value.kind].schema.safeParse(params);
    if(!validation.success){setEditorError(value.kind==='set-network'?t('network.editor.invalidIpv4'):t('network.editor.invalidDns'));return;}
    const confirmation=networkConfirmation(current,value.target,value.kind,params,locale);
    if(confirmation){closeEditor();current.onConfirm(confirmation);}
  };
  const copyValue=async(expectedServerId:string,key:string,build:(current:Device)=>string|null)=>{
    const current=live.current;if(current.server.id!==expectedServerId||!canRead(current))return;
    const value=build(current.server);if(!value)return;
    try{
      await navigator.clipboard.writeText(value);
      if(live.current.server.id!==expectedServerId)return;
      if(copyTimer.current)clearTimeout(copyTimer.current);
      setCopy({serverId:expectedServerId,key});
      copyTimer.current=setTimeout(()=>{copyTimer.current=null;setCopy({serverId:expectedServerId,key:''});},copiedFor);
    }catch{if(live.current.server.id===expectedServerId)toast.error(t('network.copyUnavailable'));}
  };
  const copyAdapter=(chosenTarget:NetworkSelection,kind:'ip'|'dns')=>void copyValue(chosenTarget.serverId,`${chosenTarget.interfaceIndex}-${kind}`,current=>{const adapter=currentNetworkAdapter(current,chosenTarget);return adapter?(kind==='ip'?adapter.addresses.filter(ip=>!ip.address.includes(':')).map(ip=>ip.address):adapter.dns).join(', '):null;});
  const exportReport=(expectedServerId:string)=>{const current=live.current;if(current.server.id!==expectedServerId||!canRead(current)||!current.server.snapshot)return;downloadText(t('network.reportFileName',{name:current.server.name.replace(/[^a-zA-Z0-9_-]/g,'_')}),JSON.stringify(report(current.server),null,2));toast.success(t('network.exported'));};
  const refresh=()=>{const current=live.current;if(current.server.id===server.id&&!networkActionReason(current,'refresh',locale))current.onConfirm({title:t('network.refreshTitle'),description:t('network.refreshDescription'),lines:confirmationDevice(current.server.name,locale),confirmLabel:t('management.action.refresh'),payload:{action:'job',id:current.server.id,kind:'refresh',params:{},confirm:true}});};
  const check=(params:Row)=>{lastCheck.current=params;void diagnosis.submit(params,scope);};
  const submitDiagnostic=(event:FormEvent)=>{event.preventDefault();const current=live.current,value=targetRef.current;if(value.serverId!==current.server.id||scope!==scopeKey(current))return;const params={...(value.host.trim()?{host:value.host.trim()}:{}),port:Number(value.port)};if(diagnosticDefinitions['network-diagnostics'].schema.safeParse(params).success)check(params);};
  const query=diagnosisQueryState(diagnosis.jobs,'network-diagnostics',diagnosis.submitted,now),pending=diagnosis.busy||query.pending;
  const latest=diagnosis.jobs[0],successful=diagnosis.jobs.find(job=>job.state==='succeeded'&&job.data),network=successful?.data?.data,tcp=row(network?.tcp);
  const diagValid=diagnosticDefinitions['network-diagnostics'].schema.safeParse({...(draft.host.trim()?{host:draft.host.trim()}:{}),port:Number(draft.port)}).success;
  const tuneTarget=(chosenTarget:NetworkSelection,host:string)=>{const current=live.current,adapter=currentNetworkAdapter(current.server,chosenTarget);if(!adapter||scopeKey(current)!==scope||!adapter.dns.includes(host)||networkActionReason(current,'network-diagnostics',locale))return;changeTarget({host,port:'53'});};
  const downloadResult=()=>{if(scopeKey(live.current)!==scope||!diagnosticEnabled(live.current)||!successful?.data)return;downloadText(t('network.diagnosisFileName'),JSON.stringify(successful?.data,null,2));toast.success(t('network.resultExported'));};
  const retrySlow=()=>{if(lastCheck.current&&scopeKey(live.current)===scope)check(lastCheck.current);else void diagnosis.reload();};
  if(!allowed)return <div className="sdx-network"><Unavailable reason={server.revoked?'revoked':'right'}>{t('network.accessChanged')}</Unavailable></div>;
  const noInventory=!server.snapshot?t('network.noInventory'):undefined,filtered=!!filter.query||filter.status!=='all';
  const routeColumns:DataColumn<ResultRow>[]=[
    {id:'destination',label:t('network.destination'),primary:true,mono:true,cell:item=>text(item.row.DestinationPrefix)},
    {id:'hop',label:t('network.nextHop'),mono:true,cell:item=>text(item.row.NextHop)},
    {id:'adapter',label:t('network.col.adapter'),cell:item=>text(item.row.InterfaceIndex)},
    {id:'metric',label:t('network.metric'),align:'end',mono:true,cell:item=>text(item.row.RouteMetric)},
  ];
  const listenerColumns:DataColumn<ResultRow>[]=[
    {id:'address',label:t('network.localAddress'),primary:true,mono:true,cell:item=>text(item.row.LocalAddress)},
    {id:'port',label:t('management.param.port'),mono:true,cell:item=>text(item.row.LocalPort)},
    {id:'process',label:t('network.processId'),align:'end',mono:true,cell:item=>text(item.row.OwningProcess)},
  ];
  const resultRows=(value:unknown):ResultRow[]=>rows(value).map((item,index)=>({key:String(index),row:item}));
  const editorReason=activeEditor?networkActionReason(props,activeEditor.kind,locale):'';
  return <div className="sdx-network">
    <SectionHead hideTitle title={t('management.category.network')} description={t('network.subtitle',{name:server.name})} meta={t('network.inventoryAt',{stamp:stamp(server.lastSeen,locale)})}
      actions={<>
        <IconBtn icon={copied('configuration')?Check:Copy} label={t('network.copyConfig')} blocked={noInventory} onClick={()=>void copyValue(server.id,'configuration',current=>JSON.stringify(report(current),null,2))}/>
        <IconBtn icon={Download} label={t('network.exportReport')} blocked={noInventory} onClick={()=>exportReport(server.id)}/>
        <Btn icon={RefreshCw} blocked={refreshReason||undefined} onClick={refresh}>{t('management.action.refresh')}</Btn>
      </>}/>
    <PanelUnavailable reason={notice} readOnly={t('network.readOnly')}/>
    <KpiRow label={t('network.overview')} entranceId={'network-kpi:'+server.id}>
      <Kpi key="adapters" label={t('network.ipv4Adapters')} value={known?adapters.length:null} icon={Network} tone="accent"/>
      <Kpi key="up" label={t('network.status.up')} value={known?up:null} total={known?adapters.length:undefined} icon={Cable} tone={known&&adapters.length>0&&up===0?'warning':known?'success':'neutral'} detail={known?t('network.upOf',{up,total:adapters.length}):undefined}/>
      <Kpi key="gateways" label={t('network.gateways')} value={known?gateways.length:null} icon={Router} tone="accent"/>
      <Kpi key="dns" label={t('management.dnsServers')} value={known?dnsServers.length:null} icon={ServerIcon} tone="accent"/>
    </KpiRow>
    <Toolbar className="sdx-network-toolbar" search={{value:filter.query,onChange:value=>changeFilter({query:value}),label:t('network.searchAdapters'),placeholder:t('network.searchPlaceholder')}}
      filters={<>
        <Select size="sm" aria-label={t('network.filterStatus')} value={filter.status} onChange={event=>changeFilter({status:event.target.value})}><option value="all">{t('network.allAdapters')}</option><option value="up">{t('network.status.up')}</option><option value="other">{t('network.otherStatus')}</option></Select>
        {filtered&&<Btn variant="ghost" size="sm" onClick={()=>changeFilter({query:'',status:'all'})}>{t('fleet.empty.resetFilter')}</Btn>}
      </>}/>
    {matching.length?<div className="sdx-network-adapters">{matching.map(adapter=>{
      const chosenTarget=selection(server,adapter),identity=networkIdentity(server,adapter),addresses=adapter.addresses.filter(ip=>!ip.address.includes(':'));
      const setReason=networkActionReason(props,'set-network',locale),dnsReason=networkActionReason(props,'set-dns',locale);
      return <Card key={adapter.interfaceIndex} className="sdx-network-adapter" icon={Network} iconTone={adapter.status==='Up'?'accent':'neutral'} title={adapter.alias||t('network.adapter',{interfaceIndex:adapter.interfaceIndex})} meta={t('network.adapterMeta',{index:adapter.interfaceIndex,mode:adapter.dhcp?'DHCP':t('management.static')})}
        actions={<StatusPill kind={adapter.status==='Up'?'online':'neutral'}>{adapterStatus(adapter.status,locale)}</StatusPill>}>
        <div className="sdx-network-body">
          <section className="sdx-network-block">
            <div className="sdx-network-label"><span>{t('network.ipv4Addresses')}</span>{addresses.length>0&&<IconBtn icon={copied(`${adapter.interfaceIndex}-ip`)?Check:Copy} label={t('network.copyIpv4',{alias:adapter.alias})} onClick={()=>copyAdapter(chosenTarget,'ip')}/>}</div>
            {addresses.length?addresses.map(ip=>{const subnet=ipv4Subnet(ip.address,ip.prefixLength);return <div className="sdx-network-address" key={`${ip.address}/${ip.prefixLength}`}><strong className="mono">{ip.address}<small>/{ip.prefixLength}</small></strong>{subnet&&<span className="mono">{t('network.subnet',{network:subnet.network,mask:subnet.mask})}</span>}</div>;}):<span className="sdx-muted-cell">{t('network.noIpv4')}</span>}
          </section>
          <div className="sdx-network-endpoints">
            <section className="sdx-network-block"><div className="sdx-network-label"><span>{t('management.gateway')}</span></div>{adapter.gateway.length?adapter.gateway.map(address=><span className="mono" key={address}>{address}</span>):<span className="sdx-muted-cell">{t('network.noGateway')}</span>}</section>
            <section className="sdx-network-block"><div className="sdx-network-label"><span>{t('network.dns')}</span>{adapter.dns.length>0&&<IconBtn icon={copied(`${adapter.interfaceIndex}-dns`)?Check:Copy} label={t('network.copyDns',{alias:adapter.alias})} onClick={()=>copyAdapter(chosenTarget,'dns')}/>}</div>
              {adapter.dns.length?adapter.dns.map(address=><div className="sdx-network-dns" key={address}><span className="mono">{address}</span><IconBtn icon={Activity} label={t('network.testDns',{address})} blocked={diagReason||undefined} onClick={()=>tuneTarget(chosenTarget,address)}/></div>):<span className="sdx-muted-cell">{t('network.noDns')}</span>}
            </section>
          </div>
          {identity&&<details className="sdx-network-details"><summary>{t('network.adapterDetails')}</summary><Facts items={[
            {id:'name',label:t('common.description'),value:identity.name},
            {id:'mac',label:t('network.mac'),value:identity.mac||EMPTY_VALUE,mono:true},
            {id:'speed',label:t('network.linkSpeed'),value:identity.speedMbps>0?t('network.speed',{speed:number(locale,identity.speedMbps)}):EMPTY_VALUE},
            ...(identity.addresses.some(address=>address.includes(':'))?[{id:'ipv6',label:t('network.ipv6'),value:identity.addresses.filter(address=>address.includes(':')).join(', '),mono:true}]:[]),
          ]}/></details>}
          <div className="sdx-network-actions"><Btn size="sm" icon={Pencil} blocked={setReason||undefined} onClick={()=>openEditor(chosenTarget,'set-network')}>{t('management.network.change')}</Btn><Btn size="sm" icon={Pencil} blocked={dnsReason||undefined} onClick={()=>openEditor(chosenTarget,'set-dns')}>{t('management.dns.change')}</Btn></div>
        </div>
      </Card>;
    })}</div>
    :<div className="sdx-network-empty"><Empty icon={Network} title={!known?t('network.inventoryPending'):adapters.length?t('network.noMatch'):t('network.noConfigs')} action={known&&adapters.length&&filtered?<Btn variant="ghost" size="sm" onClick={()=>changeFilter({query:'',status:'all'})}>{t('fleet.empty.resetFilter')}</Btn>:undefined}>{!known?t('network.noConfigsHint'):adapters.length?t('fleet.empty.filterHint'):t('network.noConfigsInventory')}</Empty></div>}
    <Card title={t('network.diagnostics')} icon={Activity} iconTone="accent" description={t('network.diagnosticsHint')} className="sdx-network-diagnostics"
      actions={onOpenConnections&&<Btn variant="ghost" size="sm" icon={ArrowUpRight} blocked={!diagnosis.enabled?diagReason||t('management.blocked.unsupported'):undefined} onClick={()=>{const current=live.current;if(current.server.id===server.id&&diagnosticEnabled(current))current.onOpenConnections?.();}}>{t('device.area.connections')}</Btn>}>
      <form className="sdx-network-check" onSubmit={submitDiagnostic}>
        <div className="sdx-network-check-fields">
          <Field label={t('network.targetHost')}><input name="host" value={draft.host} maxLength={253} placeholder={t('network.targetPlaceholder')} onChange={event=>changeTarget({host:event.target.value})}/></Field>
          <Field label={t('network.tcpPort')}><input name="port" type="number" min={1} max={65535} value={draft.port} onChange={event=>changeTarget({port:event.target.value})}/></Field>
        </div>
        <div className="sdx-network-presets">{presets.map(preset=><Btn key={preset.port} variant="ghost" size="sm" aria-pressed={draft.port===preset.port} onClick={()=>changeTarget({port:preset.port})}>{`${preset.name} ${preset.port}`}</Btn>)}</div>
        <div className="sdx-network-check-actions">
          <Btn type="submit" variant="primary" icon={Activity} loading={pending} blocked={diagReason||(!diagValid?t('network.targetInvalid'):undefined)}>{t('network.check')}</Btn>
          <Btn variant="ghost" icon={Router} blocked={diagReason||(pending?t('network.blocked.running'):undefined)} onClick={()=>{if(scopeKey(live.current)===scope)check({port:443});}}>{t('network.queryRoutes')}</Btn>
        </div>
      </form>
      <div className="sdx-network-result">
        {diagnosis.error&&diagnosis.errorSource==='read'&&<Notice tone="danger" icon={AlertTriangle} action={<Btn size="sm" variant="ghost" onClick={()=>void diagnosis.reload()}>{t('common.retry')}</Btn>}>{diagnosis.error}</Notice>}
        {query.timedOut&&<Notice tone="warning" icon={AlertTriangle} action={<Btn size="sm" variant="ghost" onClick={retrySlow}>{t('common.retry')}</Btn>}>{t('network.slow')}</Notice>}
        {latest&&['failed','cancelled'].includes(latest.state)&&<Notice tone="warning" icon={AlertTriangle}>{t(latest.state==='failed'?'network.lastFailed':'network.lastCancelled',{result:agentMessageText(latest,t)||t('network.noMessage')})}</Notice>}
        {!diagnosis.error&&diagnosis.loading&&!diagnosis.jobs.length?<Skeleton variant="facts" rows={3} label={t('network.loadingResults')} after={15000}/>
        :network?<div className="sdx-network-outcome">
          <div className="sdx-network-outcome-head"><strong>{Object.keys(tcp).length?t('network.tcpResult'):t('network.localState')}</strong><span>{latest?.id!==successful?.id?t('network.lastCompleted',{time:stamp(successful?.data?.at,locale)}):stamp(successful?.data?.at,locale)}</span><IconBtn icon={Download} label={t('network.downloadResult')} onClick={downloadResult}/></div>
          {Object.keys(tcp).length>0&&<div className="sdx-network-tcp"><span className="mono">{text(tcp.host)}:{text(tcp.port)}</span><StatusPill kind={tcp.connected===true?'success':tcp.connected===false?'critical':'neutral'}>{tcp.connected===true?t('network.reachable'):tcp.connected===false?t('network.unreachable'):t('services.unknown')}</StatusPill><span className="mono">{formatDuration(locale,typeof tcp.durationMs==='number'?tcp.durationMs:null)}</span>{tcp.error!=null&&<p>{text(tcp.error)}</p>}</div>}
          {network.dnsError!=null&&<Notice tone="warning" icon={AlertTriangle}>{t('network.dnsError',{text:text(network.dnsError)})}</Notice>}
          {strings(network.dns).length>0&&<Facts items={[{id:'dns',label:t('network.dnsResolution'),value:strings(network.dns).join(', '),mono:true}]}/>}
          <details className="sdx-network-disclosure"><summary>{t('network.routes')} <span className="sdx-tag">{rows(network.routes).length}</span></summary><DataTable variant="flush" label={t('network.routes')} columns={routeColumns} rows={resultRows(network.routes)} rowKey={item=>item.key} empty={{icon:Router,title:t('network.noRoutes')}}/></details>
          <details className="sdx-network-disclosure"><summary>{t('network.listeners')} <span className="sdx-tag">{rows(network.listeners).length}</span></summary><DataTable variant="flush" label={t('network.listeners')} columns={listenerColumns} rows={resultRows(network.listeners)} rowKey={item=>item.key} empty={{icon:Network,title:t('network.noListeners')}}/></details>
          <details className="sdx-network-disclosure"><summary>{t('network.winhttpProxy')}</summary><pre className="mono">{text(network.proxy)}</pre></details>
        </div>
        :!pending&&!diagnosis.loading&&!diagnosis.error&&<p className="sdx-network-hint">{t('network.chooseTarget')}</p>}
      </div>
    </Card>
    <FirewallRulesCard server={server} viewer={viewer} demo={demo} saving={props.saving} now={now} onConfirm={props.onConfirm}/>
    <Drawer open={!!activeEditor} onClose={closeEditor} title={activeEditor?.kind==='set-network'?t('management.action.setNetwork'):t('management.action.setDns')} description={chosen?chosen.alias:undefined}
      footer={activeEditor&&chosen?<><Btn onClick={closeEditor}>{t('common.cancel')}</Btn><Btn type="submit" form="sdx-network-editor" variant="primary" blocked={editorReason||undefined}>{t('management.reviewChange')}</Btn></>:<Btn onClick={closeEditor}>{t('common.close')}</Btn>}>
      {activeEditor&&chosen?<form id="sdx-network-editor" className="sdx-network-editor" onSubmit={confirm}>
        {activeEditor.kind==='set-network'?<>
          <Field inline label={t('management.network.dhcp')}><input name="dhcp" type="checkbox" role="switch" checked={activeEditor.dhcp} onChange={event=>updateEditor({dhcp:event.target.checked})}/></Field>
          {!activeEditor.dhcp&&<>
            <Field label={t('management.param.address')} error={editorError}><input name="address" value={activeEditor.address} onChange={event=>updateEditor({address:event.target.value})} required maxLength={15} autoFocus/></Field>
            <Field label={t('management.param.prefixLength')}><input name="prefix" type="number" min={1} max={32} value={activeEditor.prefix} onChange={event=>updateEditor({prefix:event.target.value})} required/></Field>
            <Field label={t('network.editor.gateway')}><input name="gateway" value={activeEditor.gateway} onChange={event=>updateEditor({gateway:event.target.value})} maxLength={15}/></Field>
          </>}
          {activeEditor.dhcp&&editorError&&<p className="sdx-field-error" role="alert">{editorError}</p>}
        </>:<>
          <Field inline label={t('network.editor.dnsAutomatic')}><input name="automatic" type="checkbox" role="switch" checked={activeEditor.automatic} onChange={event=>updateEditor({automatic:event.target.checked})}/></Field>
          {!activeEditor.automatic&&<Field label={t('management.dnsServers')} hint={t('network.editor.dnsHelp')} error={editorError}><input name="dns" value={activeEditor.dns} onChange={event=>updateEditor({dns:event.target.value})} required maxLength={400} autoFocus/></Field>}
          {activeEditor.automatic&&editorError&&<p className="sdx-field-error" role="alert">{editorError}</p>}
        </>}
        <Notice tone="warning" icon={AlertTriangle}>{t('network.editor.warning')}</Notice>
      </form>:<Notice tone="warning" icon={AlertTriangle}>{t('network.editor.changed')}</Notice>}
    </Drawer>
  </div>;
}
