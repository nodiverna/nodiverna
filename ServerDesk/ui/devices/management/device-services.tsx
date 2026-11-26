'use client';
// Management → Services on the console kit: a SectionHead without a visible title, the services
// DataTable with the four focus filters as a Segmented in its toolbar and the service Drawer with its actions. Every action is confirmed
// through ui/devices/management/service-view.ts, which also names why an action is blocked.
import {useState,useRef} from 'react';
import {Play,Settings2,Square,RotateCw} from 'lucide-react';
import type {Service,Viewer} from '@/lib/types';
import {deviceConnection} from '@/ui/base/ui-device';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import type {Device} from '@/ui/base/api';
import type {Confirmation} from '@/ui/base/confirmation';
import {permitted,stamp} from '@/ui/base/api';
import {serviceView,serviceInventory,serviceStatusLabel,serviceStatusTone,serviceStartup,serviceStartupLabel,currentService,serviceActionReason,serviceConfirmation,SERVICE_PAGE_SIZE,type ServiceFilters,type ServiceFocus,type ServiceSelection,type ServiceSort,type ServiceStartup} from '@/ui/devices/management/service-view';
import {Btn,Card,Drawer,Facts,Notice,PanelUnavailable,SectionHead,Segmented,Skeleton,StatusPill,relativeTime,type SegmentItem,type StatusKind} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {Field,Select} from '@/ui/kit/field';
import '@/ui/devices/management/device-services.css';

import {useLocale,useT} from '@/ui/base/locale';
import {type MessageKey} from '@/lib/i18n/translate';
import {EMPTY_VALUE} from '@/lib/i18n/format';
type Props={server:Device;viewer:Viewer;demo:boolean;saving:boolean;onConfirm:(confirmation:Confirmation)=>void;now:number};
const defaults=():ServiceFilters=>({query:'',focus:'all',status:'all',startup:'all',sort:'name',direction:'asc',page:1});
const statusKinds:Record<ReturnType<typeof serviceStatusTone>,StatusKind>={running:'success',changing:'warning',stopped:'neutral',unknown:'neutral'};
function Status({status}:{status:string}){const [locale]=useLocale();return <StatusPill kind={statusKinds[serviceStatusTone(status)]}>{serviceStatusLabel(status,locale)}</StatusPill>;}
const actions:{kind:string;label:MessageKey;icon:typeof Play}[]=[{kind:'start-service',label:'services.action.start',icon:Play},{kind:'stop-service',label:'services.action.stop',icon:Square},{kind:'restart-service',label:'services.action.restart',icon:RotateCw}];

export default function DeviceServices(props:Props){
  const t=useT(),[locale]=useLocale();
  const {server,viewer,demo,saving,now}=props;
  const live=useRef(props);live.current=props;
  const [state,setState]=useState({serverId:server.id,filters:defaults()});
  const [selection,setSelection]=useState<ServiceSelection|null>(null);
  const [draft,setDraft]=useState<{serverId:string;name:string;from:string;to:ServiceStartup}|null>(null);
  const filters=state.serverId===server.id?state.filters:defaults(),inventory=serviceInventory(server),view=serviceView(inventory,filters,locale);
  const context={server,viewer,demo,saving,now},hasInventory=Array.isArray(server.snapshot?.services);
  const chosen=selection?.serverId===server.id?selection:null,selected=currentService(server,chosen);
  const draftCurrent=!!selected&&draft?.serverId===server.id&&draft.name===selected.name&&draft.from===selected.startMode;
  const desired=draftCurrent?draft!.to:selected?serviceStartup(selected.startMode)??'unknown':'unknown';
  // One panel notice (nodiverna-ui §5): offline and never-reported devices have the shared DeviceStateNotice.
  const notice=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'manage'),reported:true,supported:true,management:!server.snapshot||server.management===1&&server.snapshot.mode!=='ReadOnly'});
  const change=(values:Partial<ServiceFilters>)=>setState(previous=>({serverId:server.id,filters:{...(previous.serverId===server.id?previous.filters:defaults()),...values,...(values.page===undefined?{page:1}:{})}}));
  const filtered=!!filters.query||filters.focus!=='all'||filters.status!=='all'||filters.startup!=='all';
  const resetFilters=()=>change({query:'',focus:'all',status:'all',startup:'all'});
  const open=(service:Service)=>{setSelection({serverId:server.id,name:service.name});setDraft(null);};
  const request=(target:ServiceSelection,kind:string,startup?:string,expectedMode?:string)=>{
    const current=live.current,confirmation=serviceConfirmation(current,target,kind,startup,expectedMode,locale);
    if(confirmation)current.onConfirm(confirmation);
  };
  // The focus filters with their counts; "Automatic · stopped" warns only while it has services.
  const focusItems:SegmentItem<ServiceFocus>[]=[
    {id:'all',label:t('fleet.status.all'),count:view.counts.all},
    {id:'running',label:t('services.focus.running'),count:view.counts.running},
    {id:'auto-stopped',label:t('services.focus.autoStopped'),count:view.counts.autoStopped,...(view.counts.autoStopped>0?{tone:'warning' as const}:{})},
    {id:'disabled',label:t('fleet.disabled'),count:view.counts.disabled},
  ];
  const columns:DataColumn<Service>[]=[
    {id:'name',label:t('services.service'),primary:true,sort:{first:'asc'},wrap:true,cell:service=><span className="sdx-cell-stack"><span>{service.displayName||service.name}</span><small className="mono">{service.name}</small></span>},
    {id:'status',label:t('management.status'),sort:{first:'asc'},cell:service=><Status status={service.status}/>},
    {id:'startup',label:t('services.startupType'),sort:{first:'asc'},cell:service=>serviceStartupLabel(service.startMode,locale)},
  ];
  const loading=!demo&&!hasInventory&&deviceConnection(server,now,locale).kind==='online';
  const empty=!hasInventory?{icon:Settings2,title:t('services.inventoryPending'),children:t('services.noneReported')}
    :inventory.length?{icon:Settings2,title:t('services.noMatch'),children:t('services.adjust'),action:<Btn variant="ghost" size="sm" onClick={resetFilters}>{t('fleet.empty.resetFilter')}</Btn>}
    :{icon:Settings2,title:t('services.noneInInventory'),children:t('services.emptyInventory')};
  const startupReason=chosen?serviceActionReason(context,chosen,'set-service-startup',locale):'';
  return <div className="sdx-services">
    <SectionHead hideTitle title={t('device.area.services')} description={t('services.subtitle')} meta={hasInventory?t('services.meta',{value:view.total,time:relativeTime(server.lastSeen,now,locale)}):undefined}/>
    <PanelUnavailable reason={notice} readOnly={t('services.readOnly')}/>
    <Card flush className="sdx-services-card">
      {loading?<Skeleton variant="table" label={t('services.loading')} after={15000}/>
        :<DataTable variant="flush" cards label={t('device.area.services')} columns={columns} rows={view.items} rowKey={service=>service.name} entranceId={'services-table:'+server.id}
          sort={{column:filters.sort,direction:filters.direction}} onSort={next=>change({sort:next.column as ServiceSort,direction:next.direction})}
          onOpen={open} openLabel={service=>t('services.open',{name:service.displayName||service.name})} empty={empty}
          foot={t('services.foot',{count:view.total,filtered:view.filteredCount})}
          pagination={{page:view.page,pageSize:SERVICE_PAGE_SIZE,total:view.filteredCount,onPage:page=>change({page})}}
          toolbar={<Toolbar search={{value:filters.query,onChange:query=>change({query}),label:t('services.search'),placeholder:t('services.searchPlaceholder')}}
            filters={<>
              {hasInventory&&<Segmented<ServiceFocus> label={t('services.groups')} size="sm" value={filters.focus} onChange={focus=>change({focus,status:'all',startup:'all'})} items={focusItems}/>}
              <Select size="sm" aria-label={t('services.filterStatus')} value={filters.status} onChange={event=>change({status:event.target.value})}><option value="all">{t('services.allStatus')}</option><option value="Running">{t('jobs.state.running')}</option><option value="Stopped">{t('services.status.stopped')}</option><option value="Paused">{t('services.status.paused')}</option><option value="changing">{t('services.status.transition')}</option><option value="unknown">{t('services.status.other')}</option></Select>
              <Select size="sm" aria-label={t('services.filterStartup')} value={filters.startup} onChange={event=>change({startup:event.target.value})}><option value="all">{t('services.allStartup')}</option><option value="Automatic">{t('management.automatic')}</option><option value="Manual">{t('services.startup.manual')}</option><option value="Disabled">{t('fleet.disabled')}</option><option value="system">{t('services.startup.bootSystem')}</option><option value="unknown">{t('services.unknown')}</option></Select>
              {filtered&&<Btn variant="ghost" size="sm" onClick={resetFilters}>{t('fleet.empty.resetFilter')}</Btn>}
            </>}/>}/>}
    </Card>
    <Drawer open={!!chosen} onClose={()=>{setSelection(null);setDraft(null);}} title={selected?.displayName||chosen?.name||t('services.service')} description={selected?selected.name:undefined}>
      {selected&&chosen?<div className="sdx-services-detail">
        <Facts items={[
          {id:'status',label:t('management.status'),value:<Status status={selected.status}/>},
          {id:'startup',label:t('services.startupType'),value:serviceStartupLabel(selected.startMode,locale)},
          {id:'name',label:t('services.serviceName'),value:selected.name,mono:true},
          {id:'display',label:t('services.displayName'),value:selected.displayName||EMPTY_VALUE},
          {id:'inventory',label:t('fleet.inventoryState'),value:stamp(server.lastSeen,locale)},
          ...(!serviceStartup(selected.startMode)?[{id:'reported',label:t('services.reportedStartup'),value:selected.startMode||t('services.unknown')}]:[]),
        ]}/>
        <section className="sdx-services-section" aria-labelledby="services-control">
          <h3 id="services-control">{t('services.control')}</h3><p>{t('services.controlHint')}</p>
          <div className="sdx-services-actions">{actions.map(action=><Btn key={action.kind} icon={action.icon} blocked={serviceActionReason(context,chosen,action.kind,locale)||undefined} onClick={()=>request(chosen,action.kind)}>{t(action.label)}</Btn>)}</div>
        </section>
        <section className="sdx-services-section" aria-labelledby="services-startup">
          <h3 id="services-startup">{t('services.changeStartup')}</h3><p>{t('services.changeStartupHint')}</p>
          <div className="sdx-services-startup">
            <Field label={t('services.newStartupFor',{name:selected.name})}><Select value={desired} onChange={event=>{if(['Automatic','Manual','Disabled'].includes(event.target.value))setDraft({serverId:server.id,name:selected.name,from:selected.startMode,to:event.target.value as ServiceStartup});}}>{!serviceStartup(selected.startMode)&&<option value="unknown" disabled>{serviceStartupLabel(selected.startMode,locale)} · {selected.startMode||EMPTY_VALUE}</option>}<option value="Automatic">{t('management.automatic')}</option><option value="Manual">{t('services.startup.manual')}</option><option value="Disabled">{t('fleet.disabled')}</option></Select></Field>
            <Btn blocked={startupReason||(!draftCurrent||desired===serviceStartup(selected.startMode)?t('services.blocked.sameStartup'):undefined)} onClick={()=>draftCurrent&&request(chosen,'set-service-startup',draft!.to,draft!.from)}>{t('services.changeStartup')}</Btn>
          </div>
        </section>
      </div>:<Notice tone="info" icon={Settings2}>{t('services.gone')}</Notice>}
    </Drawer>
  </div>;
}
