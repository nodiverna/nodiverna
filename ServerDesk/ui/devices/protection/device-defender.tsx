'use client';
// The device area Management → Defender (docs/device-health-signals.md,
// "Microsoft Defender"): status, scans, detections and exclusions of Microsoft
// Defender from the last report of agent 4.14.0, and the actions of agent
// 4.15.0 (quick scan, full scan, signature update, clean all active detections).
// Detections and exclusions need defender.read on the device; the console
// answer strips them without it, and this view shows the lock instead. Every
// action needs defender.control and is blocked with the reason of
// defenderActionBlock (ui/devices/protection/defender-model.ts); the server checks the same
// Defender state through defenderStateBlock (lib/defender.ts).
// Exclusions stay read-only.
// Self-contained (no imports from other management panels), so a later device
// view can move it to another tab with one line.
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {AlertTriangle,Bug,FileClock,Lock,RefreshCw,ScanLine,ScanSearch,ShieldAlert,ShieldCheck,ShieldOff,ShieldX} from 'lucide-react';
import type {DefenderAvailable,Job,Viewer} from '@/lib/types';
import {DEFENDER_REFRESH_EVERY_MS,DEFENDER_REFRESH_FOR_MS,defenderJobTransition,type DefenderJobKind,defenderAreaState,defenderCoveringName,defenderDetectionTone,defenderLastScanKind,defenderModeKeys,defenderNotice,defenderSeverityKeys,defenderSeverityRank,defenderSeverityTone,defenderStatus,defenderStatusKeys,defenderStatusTone,defenderThreatStatusKeys,scanAgeThreshold,sortedDetections,type DefenderTone} from '@/lib/defender';
import {defenderActionBlock,defenderBlockText} from '@/ui/devices/protection/defender-model';
import type {DefenderDetection} from '@/lib/types';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {sortTableRows,type RowSort} from '@/ui/base/table-sort';
import {permitted,type Device} from '@/ui/base/api';
import {Btn,Card,Empty,Facts,Kpi,KpiRow,Menu,Notice,PanelUnavailable,SectionHead,StatusPill,exactTime,relativeTime,type KpiTone,type StatusKind} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import type {Confirmation} from '@/ui/base/confirmation';
import {defenderActionKeys,defenderConfirmation} from '@/ui/devices/protection/defender-actions';
import {useLocale,useT} from '@/ui/base/locale';
import {EMPTY_VALUE} from '@/lib/i18n/format';

const pillKind:Record<DefenderTone,StatusKind>={ok:'success',warning:'warning',critical:'critical',neutral:'neutral'};
const kpiTone:Record<DefenderTone,KpiTone>={ok:'success',warning:'warning',critical:'critical',neutral:'neutral'};
const statusIcons={active:ShieldCheck,passive:ShieldCheck,'edr-block':ShieldAlert,off:ShieldOff,'not-running':ShieldX} as const;

type Props={server:Device;viewer:Viewer;
 /** Demo mode blocks every action with kit.unavailable.demo. */
 demo:boolean;now:number;
 /** An action is being saved: the actions wait. */
 saving:boolean;
 /** The console's jobs: when a Defender job of this device ends, the area refreshes for a while. */
 jobs:Job[];
 onConfirm:(confirmation:Confirmation)=>void};
/** What an action button needs: its blocked reason and its confirmation. */
type Act={blocked:(kind:DefenderJobKind)=>string|undefined;confirm:(kind:DefenderJobKind)=>void};

/**
 * When a Defender job of the device ends, ask for a console refresh every 10 s
 * for 2 min, so the new scan time, signature version or detection list shows
 * without a manual reload. Afterwards the 30 s poll applies again.
 */
function useDefenderJobRefresh(serverId:string,jobs:readonly Job[]){
 const states=useRef<Map<string,string>>(new Map()),[until,setUntil]=useState(0);
 useEffect(()=>{const next=defenderJobTransition(states.current,jobs,serverId);states.current=next.states;if(next.ended)queueMicrotask(()=>setUntil(Date.now()+DEFENDER_REFRESH_FOR_MS));},[jobs,serverId]);
 useEffect(()=>{
  if(!until)return;
  const timer=setInterval(()=>{if(Date.now()>until){clearInterval(timer);return;}window.dispatchEvent(new Event('serverdesk:refresh'));},DEFENDER_REFRESH_EVERY_MS);
  return ()=>clearInterval(timer);
 },[until]);
}

export default function DeviceDefender({server,viewer,demo,now,saving,jobs,onConfirm}:Props){
 const t=useT(),[locale]=useLocale(),state=defenderAreaState(server);
 useDefenderJobRefresh(server.id,jobs);
 if(state.kind==='no-snapshot')return null;
 if(state.kind==='old-agent')return <Card title={t('defender.title')} icon={ShieldCheck}><Empty icon={ShieldCheck} title={t('defender.notReportedTitle')}>{t('defender.notReported')}</Empty></Card>;
 if(state.kind==='not-reported')return <Card title={t('defender.title')} icon={ShieldCheck}><Empty icon={ShieldCheck} title={t('defender.waitingTitle')}>{t('defender.notReportedYet')}</Empty></Card>;
 if(state.kind==='not-installed')return <Card title={t('defender.title')} icon={ShieldCheck}><Empty icon={ShieldOff} title={t('defender.notInstalled')}>{t('defender.notInstalledHint')}</Empty></Card>;
 if(state.kind==='error')return <Notice tone="warning" icon={AlertTriangle}>{t('defender.notice.error')}</Notice>;
 const act:Act={
  blocked:kind=>defenderBlockText(defenderActionBlock(server,viewer,kind,{demo,saving,now}),locale),
  confirm:kind=>{if(!act.blocked(kind))onConfirm(defenderConfirmation({id:server.id,name:server.name,activeCount:state.defender.activeCount},kind,locale));}
 };
 // nodiverna-ui §4 "Device section": the hidden title, one panel notice for the blocked actions, then the report.
 const notice=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'defender.control'),reported:true,supported:true});
 return <div className="sdx-defender-panel">
  <SectionHead hideTitle title={t('defender.title')} description={t('defender.description')} meta={t('defender.lastReport',{time:exactTime(state.defender.collectedAt,locale)})}/>
  <PanelUnavailable reason={notice} readOnly={t('defender.readOnly')}/>
  <DefenderReport defender={state.defender} server={server} canRead={permitted(server,viewer,'defender.read')} now={now} act={act}/>
 </div>;
}

function DefenderReport({defender,server,canRead,now,act}:{defender:DefenderAvailable;server:Device;canRead:boolean;now:number;act:Act}){
 const t=useT(),[locale]=useLocale(),running=server.snapshot?.defenderScan;
 const status=defenderStatus(defender),tone=defenderStatusTone(defender),notice=defenderNotice(defender),covering=defenderCoveringName(defender);
 const scan=defenderLastScanKind(defender),signatureAt=defender.signatureAt?Date.parse(defender.signatureAt):null,threshold=scanAgeThreshold(server);
 const StatusIcon=statusIcons[status];
 return <div className="sdx-defender">
  {notice&&<Notice tone={notice.tone} icon={notice.tone==='danger'?ShieldOff:ShieldCheck}>{notice.name?t(notice.key,{name:notice.name}):t(notice.key)}</Notice>}
  <KpiRow label={t('defender.kpis')} entranceId="defender-kpis">
   <Kpi key="status" label={t('defender.kpi.status')} value={t(defenderStatusKeys[status])} icon={StatusIcon} tone={kpiTone[tone]} detail={tone==='neutral'&&covering?covering:undefined}/>
   <Kpi key="active" label={t('defender.kpi.active')} value={defender.activeCount} icon={Bug} tone={defender.activeCount>0?'critical':'success'} detail={t('defender.kpi.total',{count:defender.detectionCount})}/>
   <Kpi key="scan" label={t('defender.kpi.lastScan')} value={scan?relativeTime(Date.parse(scan.at),now,locale):t('defender.never')} icon={ScanSearch} tone={threshold!==null?'warning':'accent'} detail={running?t('defender.kpi.scanRunning'):scan?t(scan.kind==='quick'?'defender.scan.quick':'defender.scan.full'):undefined} detailTitle={scan?exactTime(scan.at,locale):undefined}/>
   <Kpi key="signatures" label={t('defender.kpi.signatures')} value={signatureAt!==null&&Number.isFinite(signatureAt)?relativeTime(signatureAt,now,locale):null} icon={FileClock} tone="accent" detail={defender.signatureVersion?t('defender.kpi.signatureVersion',{version:defender.signatureVersion}):undefined} detailTitle={defender.signatureAt?exactTime(defender.signatureAt,locale):undefined}/>
  </KpiRow>
  <div className="sdx-defender-pair">
   <Card title={t('defender.status.title')} icon={ShieldCheck} actions={<ActionBtn kind="defender-update-signatures" icon={RefreshCw} act={act}/>}>
    <Facts items={[
     {id:'mode',label:t('defender.fact.mode'),value:t(defenderModeKeys[defender.mode])},
     {id:'antivirus',label:t('defender.fact.antivirus'),value:<OnOff value={defender.antivirusEnabled}/>},
     {id:'realtime',label:t('defender.fact.realtime'),value:<OnOff value={defender.realTimeProtection}/>},
     {id:'tamper',label:t('defender.fact.tamper'),value:defender.tamperProtected===null?<span className="sdx-muted-cell">{t('defender.fact.notReported')}</span>:<OnOff value={defender.tamperProtected}/>},
     {id:'otherAv',label:t('defender.fact.otherAv'),value:defender.otherAntivirus===null?<span className="sdx-muted-cell">{t('defender.fact.otherAvServer')}</span>
      :!defender.otherAntivirus.length?<span className="sdx-muted-cell">{t('defender.fact.otherAvNone')}</span>
      :defender.otherAntivirus.map(product=>product.enabled?product.name:t('defender.fact.otherAvOff',{name:product.name})).join(', ')},
     {id:'product',label:t('defender.fact.productVersion'),value:defender.productVersion??EMPTY_VALUE,mono:true},
     {id:'signature',label:t('defender.fact.signatureVersion'),value:defender.signatureVersion??EMPTY_VALUE,mono:true},
    ]}/>
   </Card>
   <Card title={t('defender.scans.title')} icon={ScanSearch} actions={<>{threshold!==null&&!running&&<StatusPill kind="warning">{t('defender.scans.tooOld',{count:threshold})}</StatusPill>}
    <ActionBtn kind="defender-quick-scan" icon={ScanSearch} act={act}/>
    <Menu label={t('defender.action.moreScans')} entries={[{id:'full',label:t('defender.action.fullScan'),icon:ScanLine,blocked:act.blocked('defender-full-scan'),onSelect:()=>act.confirm('defender-full-scan')}]}/></>}>
    {running&&<p className="sdx-defender-running" role="status"><i className="sdx-live-dot" aria-hidden="true"/>{t(running.kind==='quick'?'defender.scan.runningQuick':'defender.scan.runningFull',{time:exactTime(running.startedAt,locale)})}</p>}
    <Facts items={[
     {id:'quick',label:t('defender.scans.quick'),value:<ScanTime at={defender.quickScanAt} now={now}/>},
     {id:'full',label:t('defender.scans.full'),value:<ScanTime at={defender.fullScanAt} now={now}/>},
    ]}/>
   </Card>
  </div>
  <Detections defender={defender} canRead={canRead} action={<ActionBtn kind="defender-clean-detections" icon={ShieldX} act={act} variant="danger"/>}/>
  <Exclusions defender={defender} canRead={canRead}/>
 </div>;
}

function ActionBtn({kind,icon,act,variant='secondary'}:{kind:DefenderJobKind;icon:typeof ShieldX;act:Act;variant?:'secondary'|'danger'}){
 const t=useT();
 return <Btn size="sm" variant={variant} icon={icon} blocked={act.blocked(kind)} onClick={()=>act.confirm(kind)}>{t(defenderActionKeys[kind])}</Btn>;
}

function OnOff({value}:{value:boolean}){const t=useT();return <StatusPill kind={value?'success':'critical'}>{t(value?'defender.on':'defender.off')}</StatusPill>;}
function ScanTime({at,now}:{at:string|null;now:number}){
 const t=useT(),[locale]=useLocale(),time=at?Date.parse(at):NaN;
 if(!Number.isFinite(time))return <span className="sdx-muted-cell">{t('defender.never')}</span>;
 return <><span className="sdx-nowrap">{exactTime(time,locale)}</span><span className="sdx-muted-cell">{relativeTime(time,now,locale)}</span></>;
}

type DetectionSort=RowSort<'threat'|'severity'|'detected'>;
const detectionValues={threat:(row:DefenderDetection)=>row.name,severity:(row:DefenderDetection)=>defenderSeverityRank[row.severity],detected:(row:DefenderDetection)=>row.at?Date.parse(row.at):null};
// The clean action shows in every state of the card: the count comes from the summary, also without defender.read.
// The panel head carries the report time, so the card has no meta of its own.
function Detections({defender,canRead,action}:{defender:DefenderAvailable;canRead:boolean;action:ReactNode}){
 const t=useT(),[locale]=useLocale(),detections=defender.detections,[sort,setSort]=useState<DetectionSort|null>(null);
 if(!canRead||!detections)return <Card title={t('defender.detections.title')} icon={Bug} actions={action}><Empty icon={Lock} title={t('defender.detections.hidden')}>{t('defender.detections.hiddenHint')}</Empty></Card>;
 if(!detections.length)return <Card title={t('defender.detections.title')} icon={Bug} actions={action}><Empty icon={ShieldCheck} title={t('defender.detections.empty')}>{t('defender.detections.emptyHint')}</Empty></Card>;
 const columns:DataColumn<DefenderDetection>[]=[
  // An active detection keeps its mark: the threat name in the strong weight.
  {id:'threat',label:t('defender.col.threat'),primary:true,sort:{first:'asc'},cell:detection=>{const name=detection.name??<span className="sdx-muted-cell">{t('defender.unnamedThreat')}</span>;return detection.active?<strong>{name}</strong>:name;}},
  {id:'severity',label:t('defender.col.severity'),sort:{first:'desc'},cell:detection=><StatusPill kind={pillKind[defenderSeverityTone(detection.severity)]}>{t(defenderSeverityKeys[detection.severity])}</StatusPill>},
  {id:'status',label:t('defender.col.status'),cell:detection=><StatusPill kind={pillKind[defenderDetectionTone(detection)]}>{t(defenderThreatStatusKeys[detection.status])}</StatusPill>},
  {id:'path',label:t('defender.col.path'),wrap:true,cell:detection=><span className="sdx-cell-stack"><span className="mono" title={detection.path??undefined}>{detection.path??EMPTY_VALUE}</span>{detection.resourceCount>1&&<small>{t('defender.moreFiles',{count:detection.resourceCount-1})}</small>}</span>},
  {id:'user',label:t('defender.col.user'),cell:detection=>detection.user??<span className="sdx-muted-cell">{EMPTY_VALUE}</span>},
  {id:'detected',label:t('defender.col.detected'),sort:{first:'desc'},cell:detection=><span className="sdx-nowrap">{detection.at?exactTime(detection.at,locale):EMPTY_VALUE}</span>},
 ];
 const rows=sortTableRows(sortedDetections(detections),sort,detectionValues);
 return <Card title={t('defender.detections.title')} icon={Bug} actions={action} className="sdx-device-software" flush>
  <DataTable variant="flush" cards label={t('defender.detections.title')} entranceId="defender-detections" columns={columns} rows={rows} rowKey={detection=>detection.id}
   sort={sort} onSort={next=>setSort(next as DetectionSort)} empty={{icon:ShieldCheck,title:t('defender.detections.empty')}}
   foot={defender.truncated?t('defender.detections.truncated',{shown:detections.length,count:defender.detectionCount}):undefined}/>
 </Card>;
}

function Exclusions({defender,canRead}:{defender:DefenderAvailable;canRead:boolean}){
 const t=useT(),exclusions=defender.exclusions;
 const card=(body:ReactNode)=><Card title={t('defender.exclusions.title')} icon={ShieldAlert} meta={t('defender.exclusions.meta')}>{body}</Card>;
 if(!canRead||exclusions===undefined)return card(<Empty icon={Lock} title={t('defender.exclusions.hidden')}>{t('defender.exclusions.hiddenHint')}</Empty>);
 if(exclusions===null)return card(<Empty icon={AlertTriangle} title={t('defender.exclusions.unreadable')}/>);
 const groups=[{id:'paths',label:t('defender.exclusions.paths'),items:exclusions.paths},{id:'extensions',label:t('defender.exclusions.extensions'),items:exclusions.extensions},{id:'processes',label:t('defender.exclusions.processes'),items:exclusions.processes}];
 if(groups.every(group=>!group.items.length))return card(<Empty icon={ShieldCheck} title={t('defender.exclusions.empty')}>{t('defender.exclusions.emptyHint')}</Empty>);
 return card(<div className="sdx-defender-exclusions">{groups.map(group=><section key={group.id} aria-label={group.label}>
  <h3>{group.label}<span className="mono">{group.items.length}</span></h3>
  {group.items.length?<ul className="mono">{group.items.map((item,index)=><li key={index+':'+item}>{item}</li>)}</ul>:<p>{t('defender.exclusions.none')}</p>}
 </section>)}</div>);
}
