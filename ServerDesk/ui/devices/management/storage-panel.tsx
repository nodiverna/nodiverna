'use client';
// Management → Storage on the console kit. Without storage-inspect: the reason, the disk health card
// and the reported drives. With it: the "Disks & volumes" card with the inventory job, one card per
// disk with its partition map, a partition DataTable with a row Menu, and the edit forms in the kit
// Drawer. Every change is checked against lib/storage-operations.ts and confirmed before it runs.
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {AlertTriangle,ArrowRight,HardDrive,RefreshCw,ShieldCheck} from 'lucide-react';
import {toast} from 'sonner';
import {storageOperations,type StorageDisk,type StorageInventory,type StoragePartition} from '@/lib/storage-operations';
import {parseStorageSize,storageSizeBounds,storageSizeDefaultUnit,storageSizeInput,storageSizeMiB,STORAGE_MIB,STORAGE_SIZE_UNITS,type StorageSizeUnit} from '@/ui/devices/management/storage-size';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {confirmationDevice} from '@/ui/devices/management/management-actions';
import {api,ApiError,message,stamp,permitted,online,type V3Props} from '@/ui/base/api';
import type {Confirmation} from '@/ui/base/confirmation';
import {agentMessageText} from '@/lib/agent-messages';
import type {Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {EMPTY_VALUE,formatBytes} from '@/lib/i18n/format';
import {operationText} from '@/ui/base/operation-labels';
import '@/ui/devices/management/storage.css';
import {volumeBitlockerText,bitlockerVolume} from '@/ui/devices/inventory/health-signals';
import {Btn,Card,Drawer,Empty,Facts,Menu,Notice,PanelUnavailable,Skeleton,StatusPill,type MenuEntry,type StatusKind} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {Field,Select} from '@/ui/kit/field';
import {gibBytes} from '@/ui/devices/hardware/drive-list';
import {toneKind} from '@/ui/devices/inventory/os-support';
import {DiskHealthCard,DriveDiskHealth} from '@/ui/devices/hardware/disk-health';

import {useLocale,useT} from '@/ui/base/locale';
type StorageJob={id:string;kind:string;state:string;createdAt:number;result:string|null;data:{kind:string;at:string;data:StorageInventory}|null};
type Edit={kind:string;disk:StorageDisk;partition?:StoragePartition};
type ReportedDrive={name:string;label?:string;totalGb:number;freeGb:number};
type FormError={field:'size'|'erase'|null;text:string};
const states:Record<string,MessageKey>={pending:'storage.state.pending',running:'jobs.state.running',succeeded:'updates.terminal.succeeded',failed:'jobs.state.failed',expired:'storage.state.expired',cancelled:'jobs.state.cancelled'};
const stateKinds:Record<string,StatusKind>={pending:'waiting',running:'waiting',succeeded:'success',failed:'critical',expired:'warning',cancelled:'neutral'};
const letters=Array.from({length:23},(_,index)=>String.fromCharCode(68+index));
/** 16 MiB: the smallest volume Windows creates. */
const MIN_VOLUME=16*STORAGE_MIB;
const [GIB]=STORAGE_SIZE_UNITS;
const bytes=(locale:Locale,value:number|null|undefined)=>value==null||!Number.isFinite(value)?EMPTY_VALUE:formatBytes(locale,value);
const driveBytes=(locale:Locale,value:number)=>Number.isFinite(value)&&value>=0?formatBytes(locale,gibBytes(value)):EMPTY_VALUE;
function target(disk:StorageDisk,partition:StoragePartition|undefined,locale:Locale){return !partition?translate(locale,'storage.target.disk',{disk:disk.number}):partition.driveLetter?translate(locale,'storage.target.partitionLetter',{disk:disk.number,partition:partition.number,letter:partition.driveLetter}):translate(locale,'storage.target.partition',{disk:disk.number,partition:partition.number});}
function identity(disk:StorageDisk,partition?:StoragePartition):Record<string,unknown>{return {diskNumber:disk.number,diskUniqueId:disk.uniqueId,expectedDiskSizeBytes:disk.sizeBytes,confirm:true,...(partition?{partitionNumber:partition.number,expectedOffsetBytes:partition.offsetBytes,expectedSizeBytes:partition.sizeBytes}:{})};}
function sizeBoundsFor(edit:Edit){return edit.kind==='storage-resize'?storageSizeBounds({minBytes:edit.partition?.sizeMinBytes??NaN,maxBytes:edit.partition?.sizeMaxBytes??NaN,currentBytes:edit.partition?.sizeBytes,growOnly:edit.partition?.growOnly}):storageSizeBounds({minBytes:MIN_VOLUME,maxBytes:edit.disk.largestFreeExtentBytes});}
function focusLetter(value:string|undefined){const normalized=value?.trim().toUpperCase();return normalized&&/^[A-Z]:$/.test(normalized)?normalized:null;}
/** The rowKey of a partition in its disk's table. */
const partitionKey=(disk:StorageDisk,partition:StoragePartition)=>`${disk.number}:${partition.number}`;

export default function StoragePanel({server,viewer,demo,saving,onConfirm,focusDrive}:V3Props&{saving:boolean;onConfirm:(confirmation:Confirmation)=>void;focusDrive?:string}){
 const t=useT(),[locale]=useLocale();
 // The number to type sits inside the sentence, so the sentence is split at its placeholder.
 const [eraseBefore,eraseAfter]=t('storage.erase.prompt').split('{value}');
 const serverId=server.id,drives:ReportedDrive[]=server.snapshot?.disks??[],capable=server.snapshot?.agentCapabilities.includes('storage-inspect')===true;
 const enabled=!demo&&!server.revoked&&permitted(server,viewer,'diagnose')&&capable;
 const [data,setData]=useState<{serverId:string;jobs:StorageJob[];loaded:boolean}>({serverId,jobs:[],loaded:false}),[error,setError]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[edit,setEdit]=useState<Edit|null>(null);
 const [size,setSize]=useState(''),[sizeUnit,setSizeUnit]=useState<StorageSizeUnit>(GIB),[maximum,setMaximum]=useState(true),[letter,setLetter]=useState(''),[fileSystem,setFileSystem]=useState('NTFS'),[label,setLabel]=useState(''),[style,setStyle]=useState('GPT'),[erase,setErase]=useState('');
 const [formError,setFormError]=useState<FormError|null>(null);
 const sizeBounds=edit?sizeBoundsFor(edit):null;
 const generation=useRef(0),root=useRef<HTMLDivElement|null>(null);
 const current=useRef({serverId,enabled});current.current={serverId,enabled};
 const jobs=enabled&&data.serverId===serverId?data.jobs:[],latest=jobs[0],snapshotJob=jobs.find(job=>job.state==='succeeded'&&Array.isArray(job.data?.data?.disks)),inventory=snapshotJob?.data?.data;
 const focusedLetter=focusLetter(focusDrive),focusedDrive=drives.find(drive=>focusLetter(drive.name)===focusedLetter);
 const matches=focusedLetter?inventory?.disks.flatMap(disk=>disk.partitions.filter(partition=>focusLetter(partition.driveLetter+':')===focusedLetter).map(partition=>({disk,partition})))??[]:[];
 const focusedVolume=matches.length===1?matches[0]:null,focusedKey=focusedVolume?partitionKey(focusedVolume.disk,focusedVolume.partition):undefined;
 const focusCapacity=focusedDrive&&Number.isFinite(focusedDrive.totalGb)&&focusedDrive.totalGb>0&&Number.isFinite(focusedDrive.freeGb)&&focusedDrive.freeGb>=0&&focusedDrive.freeGb<=focusedDrive.totalGb?t('storage.focus.capacity',{capacityGb:driveBytes(locale,focusedDrive.freeGb),capacityGb2:driveBytes(locale,focusedDrive.totalGb)}):null;
 // The focus from the Overview: scroll to the matching partition row and focus it (DataTable highlightKey).
 const showFocused=()=>{if(!focusedKey)return;const row=root.current?.querySelector<HTMLElement>(`[data-row-key="${focusedKey}"]`);row?.scrollIntoView({block:'center',behavior:'auto'});row?.focus({preventScroll:true});};
 const focusContext=focusedLetter?<Card className="sdx-storage-focus" icon={HardDrive} iconTone="accent" title={<>{focusedLetter}{focusedDrive?.label&&<span className="sdx-storage-focus-label">{focusedDrive.label}</span>}</>}
  description={focusCapacity?t('storage.focus.inventory',{focusCapacity}):focusedDrive?t('storage.focus.noCapacity'):t('storage.focus.notCollected')}
  meta={focusedVolume?target(focusedVolume.disk,focusedVolume.partition,locale):!enabled?t('storage.focus.needsDiagnose'):!inventory?t('storage.focus.queryInventory'):matches.length>1?t('storage.focus.multiple'):t('storage.focus.unmapped')}
  actions={focusedVolume&&<Btn size="sm" icon={ArrowRight} onClick={showFocused}>{t('storage.focus.show')}</Btn>}><span className="sr-only">{t('storage.focus.label',{focusedLetter})}</span></Card>:null;
 const active=jobs.some(job=>['pending','running'].includes(job.state));
 const load=useCallback(async(signal?:AbortSignal)=>{
  if(!enabled)return;const sequence=++generation.current;
  try{const next=await api<{jobs:StorageJob[]}>('/api/storage?serverId='+encodeURIComponent(serverId),undefined,signal);if(signal?.aborted||sequence!==generation.current||current.current.serverId!==serverId||!current.current.enabled)return;setData({serverId,jobs:next.jobs,loaded:true});setError('');}
  catch(e){if(signal?.aborted||sequence!==generation.current||current.current.serverId!==serverId||!current.current.enabled)return;if(e instanceof ApiError&&[401,403].includes(e.status))setData({serverId,jobs:[],loaded:true});setError(message(e));}
 },[serverId,enabled]);
 // eslint-disable-next-line react-hooks/exhaustive-deps -- generation is a generation counter, not DOM refs; the cleanup increments it so that late responses are dropped.
 useEffect(()=>{const controller=new AbortController();setLoading(true);setEdit(null);void load(controller.signal).finally(()=>{if(!controller.signal.aborted)setLoading(false);});const timer=setInterval(()=>void load(controller.signal),3000);return()=>{generation.current++;controller.abort();clearInterval(timer);};},[load]);
 const protectedReason=(reasons:string[],plain:MessageKey,listed:MessageKey)=>reasons.length?t(listed,{reasons:reasons.join(', ')}):t(plain);
 const reason=(kind:string,disk?:StorageDisk,partition?:StoragePartition)=>demo?t('kit.unavailable.demo'):!permitted(server,viewer,kind==='storage-inspect'?'diagnose':'manage')?t(kind==='storage-inspect'?'management.blocked.diagnose':'management.blocked.manage'):!online(server)?t('management.blocked.offline'):!server.snapshot?.agentCapabilities.includes(kind)?t('management.blocked.unsupported'):kind!=='storage-inspect'&&(server.snapshot?.mode!=='Management'||!server.management)?t('management.blocked.readOnly'):disk?.protected&&!(kind==='storage-resize'&&partition?.growOnly)?protectedReason(disk.protectionReasons,'storage.blocked.protectedDisk','storage.blocked.protectedDiskReasons'):partition?.protected&&!(kind==='storage-resize'&&partition?.growOnly)?protectedReason(partition.protectionReasons,'storage.blocked.protectedPartition','storage.blocked.protectedPartitionReasons'):'';
 /** The reason plus the state of the panel and the disk: a running save or job, an offline or read-only disk. */
 const actionReason=(kind:string,disk:StorageDisk,partition?:StoragePartition)=>reason(kind,disk,partition)||(saving?t('services.blocked.saving'):active?t('storage.blocked.jobRunning'):'')||(kind!=='storage-set-disk'&&kind!=='storage-initialize'&&disk.offline?t('storage.blocked.diskOffline'):'')||(kind!=='storage-set-disk'&&kind!=='storage-initialize'&&disk.readOnly?t('storage.blocked.diskReadOnly'):'')||(kind==='storage-new-volume'&&disk.largestFreeExtentBytes<MIN_VOLUME?t('storage.blocked.noFreeSpace'):'')||(kind==='storage-resize'&&(partition?.sizeMinBytes==null||partition?.sizeMaxBytes==null)?t('storage.blocked.noSizeRange'):'');
 const inspectReason=reason('storage-inspect')||(saving?t('services.blocked.saving'):active?t('storage.blocked.jobRunning'):'');
 const queueInspect=async()=>{setBusy(true);try{await api('/api/console',{action:'job',id:serverId,kind:'storage-inspect',params:{}});await load();window.dispatchEvent(new Event('serverdesk:refresh'));}catch(e){toast.error(message(e));}finally{setBusy(false);}};
 const confirmLabel=(kind:string,setting?:string)=>kind==='storage-set-disk'&&setting?t(setting==='offline'?'storage.setDisk.offline':setting==='online'?'storage.setDisk.online':setting==='readOnly'?'storage.setDisk.readOnly':'storage.setDisk.writable'):operationText(kind,locale,storageOperations[kind].label);
 const review=(kind:string,disk:StorageDisk,partition:StoragePartition|undefined,params:Record<string,unknown>,details:string)=>{
  const blocked=reason(kind,disk,partition);if(blocked){setFormError({field:null,text:blocked});if(!edit)toast.error(blocked);return;}
  const validated=storageOperations[kind].schema.safeParse({...identity(disk,partition),...params});
  if(!validated.success){const text=validated.error.issues.map(issue=>issue.message).slice(0,3).join(' ');setFormError({field:null,text});if(!edit)toast.error(text);return;}
  onConfirm({title:t('storage.confirmTitle',{operation:operationText(kind,locale,storageOperations[kind].label)}),description:t('storage.confirm.description',{target:target(disk,partition,locale),units:bytes(locale,partition?.sizeBytes??disk.sizeBytes),details}),lines:confirmationDevice(server.name,locale),confirmLabel:confirmLabel(kind,typeof params.setting==='string'?params.setting:undefined),...(kind==='storage-format'||kind==='storage-delete-partition'?{tone:'danger' as const}:{}),payload:{action:'job',id:serverId,kind,params:validated.data,confirm:true}});setEdit(null);setFormError(null);
 };
 const applySize=(miB:number)=>{const unit=storageSizeDefaultUnit(miB);setSizeUnit(unit);setSize(storageSizeInput(miB,unit));};
 const start=(kind:string,disk:StorageDisk,partition?:StoragePartition)=>{setFormError(null);const next={kind,disk,partition};setEdit(next);const bounds=sizeBoundsFor(next);if(bounds)applySize(bounds.defaultMiB);else setSize('');setMaximum(true);setLetter(partition?.driveLetter??'');setFileSystem(partition?.fileSystem==='ReFS'?'ReFS':'NTFS');setLabel(partition?.label??'');setStyle('GPT');setErase('');};
 const setDisk=(disk:StorageDisk,setting:string)=>review('storage-set-disk',disk,undefined,{setting},setting==='offline'?t('storage.setDisk.offlineReview'):setting==='online'?t('storage.setDisk.onlineReview'):setting==='readOnly'?t('storage.setDisk.readOnlyReview'):t('storage.setDisk.writableReview'));
 const submit=(event:FormEvent)=>{
  event.preventDefault();if(!edit)return;const {kind,disk,partition}=edit;
  let chosenBytes=0;
  if(kind==='storage-resize'||kind==='storage-new-volume'&&!maximum){const chosen=parseStorageSize(size,sizeUnit,sizeBounds,locale);if(!chosen.ok){setFormError({field:'size',text:chosen.error});return;}chosenBytes=chosen.bytes;}
  if(kind==='storage-initialize')review(kind,disk,undefined,{partitionStyle:style},t('storage.initialize.review',{style}));
  if(kind==='storage-new-volume')review(kind,disk,undefined,{useMaximumSize:maximum,...(maximum?{}:{sizeBytes:chosenBytes}),...(letter?{driveLetter:letter}:{}),fileSystem,label},t(letter?'storage.newVolume.withLetter':'storage.newVolume.noLetter',{fileSystem,label:label||t('storage.newVolume.noLabel'),size:maximum?t('storage.newVolume.maximum'):bytes(locale,chosenBytes),letter}));
  if(kind==='storage-resize'&&partition?.growOnly&&chosenBytes<=partition.sizeBytes){setFormError({field:'size',text:t('storage.resize.growOnly')});return;}
  if(kind==='storage-resize')review(kind,disk,partition,{sizeBytes:chosenBytes},t('storage.resize.review',{units:bytes(locale,partition?.sizeBytes),units2:bytes(locale,chosenBytes)}));
  if(kind==='storage-drive-letter')review(kind,disk,partition,{remove:!letter,...(letter?{driveLetter:letter}:{})},t('storage.letter.review',{from:partition?.driveLetter?partition.driveLetter+':':t('storage.letter.none'),to:letter?letter+':':t('storage.letter.none')}));
  if(['storage-format','storage-delete-partition'].includes(kind)){
   if(erase!==`${disk.number}/${partition?.number}`){setFormError({field:'erase',text:t('storage.erase.confirmMismatch')});return;}
   review(kind,disk,partition,kind==='storage-format'?{fileSystem,label}:{},kind==='storage-format'?t('storage.format.review',{fileSystem,label:label||t('storage.format.noLabel')}):t('storage.delete.review'));
  }
 };
 const notice=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,enabled?'manage':'diagnose'),reported:true,supported:!server.snapshot||capable});
 const reportedColumns:DataColumn<ReportedDrive>[]=[
  {id:'drive',label:t('management.param.drive'),primary:true,cell:drive=><span className="sdx-cell-stack"><span className="mono">{drive.name}</span>{drive.label&&<small>{drive.label}</small>}</span>},
  {id:'capacity',label:t('storage.capacity'),align:'end',mono:true,cell:drive=>driveBytes(locale,drive.totalGb)},
  {id:'free',label:t('fleet.col.free'),align:'end',mono:true,cell:drive=>driveBytes(locale,drive.freeGb)},
  {id:'bitlocker',label:t('bitlocker.column'),cell:drive=><BitLockerCell server={server} drive={drive.name}/>},
  {id:'health',label:t('diskHealth.col.health'),cell:drive=><DriveDiskHealth server={server} drive={drive.name}/>},
 ];
 // The disk health card comes from the snapshot: it shows also without storage-inspect.
 if(!enabled)return <div className="sdx-storage" ref={root}>{focusContext}
  <PanelUnavailable reason={notice} readOnly={t('storage.readOnly')}/>
  <DiskHealthCard server={server}/>
  {drives.length>0&&<Card title={t('storage.reportedDrives')} icon={HardDrive} iconTone="neutral" flush>
   <DataTable variant="flush" cards label={t('storage.reportedDrives')} columns={reportedColumns} rows={drives} rowKey={drive=>drive.name} highlightKey={focusedDrive?.name} empty={{icon:HardDrive,title:t('storage.reportedDrives')}}/>
  </Card>}
 </div>;
 const partitionColumns=(disk:StorageDisk):DataColumn<StoragePartition>[]=>[
  {id:'volume',label:t('storage.col.volume'),primary:true,cell:partition=><span className="sdx-cell-stack"><span>{partition.driveLetter?partition.driveLetter+':':t('storage.noLetter')} {partition.label}</span><small>{t('storage.partitionHeading',{number:partition.number})}{partition.growOnly?<> · {t('storage.protectedGrow')}</>:partition.protected?<> · {t('storage.protectedShort')}</>:''}</small></span>},
  {id:'fs',label:t('storage.col.fileSystem'),cell:partition=><span className="sdx-cell-stack"><span>{partition.fileSystem||partition.type||EMPTY_VALUE}</span><small>{partition.health||partition.type}</small></span>},
  {id:'size',label:t('storage.col.size'),align:'end',mono:true,cell:partition=>bytes(locale,partition.sizeBytes)},
  {id:'free',label:t('fleet.col.free'),align:'end',mono:true,cell:partition=>bytes(locale,partition.freeBytes)},
  {id:'bitlocker',label:t('bitlocker.column'),cell:partition=>partition.driveLetter?<BitLockerCell server={server} drive={partition.driveLetter+':'}/>:EMPTY_VALUE},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:partition=>{
   const entry=(kind:string,text:string,danger=false):MenuEntry=>({id:kind,label:text,danger,blocked:actionReason(kind,disk,partition)||undefined,onSelect:()=>start(kind,disk,partition)});
   return <Menu label={t('storage.actionFor',{target:target(disk,partition,locale)})} entries={[entry('storage-resize',partition.growOnly?t('storage.extendWindows'):t('storage.resize')),entry('storage-drive-letter',t('storage.changeLetter')),{id:'separator',separator:true},entry('storage-format',t('storage.format'),true),entry('storage-delete-partition',t('storage.deletePartition'),true)]}/>;
  }},
 ];
 const editReason=edit?actionReason(edit.kind,edit.disk,edit.partition)||((edit.kind==='storage-resize'||edit.kind==='storage-new-volume'&&!maximum)&&!sizeBounds?t('storage.noRange'):''):'';
 const sizeHint=!sizeBounds?t('storage.noRange'):edit?.partition?.growOnly?t('storage.growOnlyHint'):t('storage.wholeMiB');
 return <div className="sdx-storage" ref={root}>
  {focusContext}
  <PanelUnavailable reason={notice} readOnly={t('storage.readOnly')}/>
  <DiskHealthCard server={server}/>
  <Card title={t('storage.title')} icon={HardDrive} iconTone="accent" meta={snapshotJob?t('storage.stateAt',{stamp:stamp(snapshotJob.data?.at,locale)}):t('storage.liveInventory')} className="sdx-storage-inventory"
   actions={<Btn size="sm" icon={RefreshCw} loading={busy||active} blocked={inspectReason||undefined} onClick={()=>void queueInspect()}>{t('storage.queryInventory')}</Btn>}>
   {latest&&<p className="sdx-storage-job" role="status"><StatusPill kind={stateKinds[latest.state]??'neutral'}>{Object.hasOwn(states,latest.state)?t(states[latest.state]):latest.state}</StatusPill><span>{operationText(latest.kind,locale,storageOperations[latest.kind]?.label??latest.kind)}</span>{latest.result&&<span className="sdx-storage-job-message">{agentMessageText(latest,t)}</span>}</p>}
   {error&&<Notice tone="danger" icon={AlertTriangle} action={<Btn size="sm" variant="ghost" onClick={()=>void load()}>{t('common.retry')}</Btn>}>{error}{inventory?<> {t('console.staleData')}</>:null}</Notice>}
   {!inventory&&(!error&&(loading||!data.loaded||active)?<Skeleton variant="table" rows={3} label={active?t('storage.collecting'):t('storage.loading')} after={15000} action={<Btn size="sm" variant="ghost" onClick={()=>void load()}>{t('common.retry')}</Btn>}/>
    :!error&&<Empty icon={HardDrive} title={t('storage.queryTitle')} action={<Btn size="sm" icon={RefreshCw} loading={busy||active} blocked={inspectReason||undefined} onClick={()=>void queueInspect()}>{t('storage.queryInventory')}</Btn>}>{t('storage.queryHint')}</Empty>)}
  </Card>
  {inventory?.truncated&&<Notice tone="warning" icon={AlertTriangle}>{t('storage.large')}</Notice>}
  {inventory?.warnings?.map(warning=><Notice key={warning} tone="warning" icon={AlertTriangle}>{warning}</Notice>)}
  {inventory?.disks.map(disk=>{
   const settings:MenuEntry[]=[
    {id:'state',label:disk.offline?t('storage.setDisk.online'):t('storage.setDisk.offline'),blocked:actionReason('storage-set-disk',disk)||undefined,onSelect:()=>setDisk(disk,disk.offline?'online':'offline')},
    {id:'write',label:disk.readOnly?t('storage.setDisk.writable'):t('storage.setDisk.readOnly'),blocked:actionReason('storage-set-disk',disk)||undefined,onSelect:()=>setDisk(disk,disk.readOnly?'writable':'readOnly')},
   ];
   const raw=disk.partitionStyle==='RAW',createKind=raw?'storage-initialize':'storage-new-volume';
   return <Card key={disk.uniqueId+':'+disk.number} flush className={focusedVolume?.disk===disk?'sdx-storage-disk sdx-storage-focused':'sdx-storage-disk'} icon={HardDrive} iconTone={disk.protected?'neutral':'accent'}
    title={<>{t('storage.diskHeading',{number:disk.number})}<span className="sdx-tag mono">{bytes(locale,disk.sizeBytes)}</span>{disk.protected&&<span className="sdx-storage-protected" title={t('storage.protected')}><ShieldCheck size={15} aria-hidden/><span className="sr-only">{t('storage.protected')}</span></span>}</>}
    meta={[disk.name,disk.busType,disk.partitionStyle,disk.offline?'Offline':'Online',...(disk.readOnly?[t('storage.readOnlyState')]:[]),disk.health].join(' · ')}
    actions={<><Btn size="sm" blocked={actionReason(createKind,disk)||undefined} onClick={()=>start(createKind,disk)}>{raw?t('storage.initialize'):t('storage.newVolume')}</Btn><Menu label={t('storage.diskSettings',{number:disk.number})} entries={settings}/></>}>
    {disk.protected&&disk.protectionReasons.length>0&&<p className="sdx-storage-protection"><ShieldCheck size={14} aria-hidden/>{disk.protectionReasons.join(' · ')}</p>}
    <div className="sdx-storage-map" role="img" aria-label={t('storage.partitionsOn',{number:disk.number})}>{disk.partitions.map(partition=><div className={(partition.protected?'protected':'volume')+(focusedVolume?.partition===partition?' focused':'')} key={partition.number} style={{flexGrow:Math.max(1,partition.sizeBytes/disk.sizeBytes*100)}} title={`${target(disk,partition,locale)} · ${bytes(locale,partition.sizeBytes)}`}><strong>{partition.driveLetter?partition.driveLetter+':':t('storage.partitionHeading',{number:partition.number})}</strong><small>{bytes(locale,partition.sizeBytes)}</small></div>)}{disk.largestFreeExtentBytes>0&&<div className="unallocated" style={{flexGrow:Math.max(1,disk.largestFreeExtentBytes/disk.sizeBytes*100)}}><strong>{t('storage.unallocated')}</strong><small>{bytes(locale,disk.largestFreeExtentBytes)}</small></div>}</div>
    {disk.partitions.length>0&&<DataTable variant="flush" cards label={t('storage.partitionsLabel',{number:disk.number})} columns={partitionColumns(disk)} rows={disk.partitions} rowKey={partition=>partitionKey(disk,partition)} highlightKey={focusedKey} empty={{icon:HardDrive,title:t('storage.partitionsLabel',{number:disk.number})}}/>}
   </Card>;
  })}
  <Drawer open={!!edit} onClose={()=>{setEdit(null);setFormError(null);}} title={edit?operationText(edit.kind,locale,storageOperations[edit.kind].label):''} description={edit?target(edit.disk,edit.partition,locale):undefined}
   footer={<><Btn onClick={()=>{setEdit(null);setFormError(null);}}>{t('common.cancel')}</Btn><Btn type="submit" form="sdx-storage-editor" variant="primary" icon={ArrowRight} blocked={editReason||undefined}>{t('management.reviewChange')}</Btn></>}>
   {edit&&<form id="sdx-storage-editor" className="sdx-storage-editor" onSubmit={submit}>
    {edit.kind==='storage-initialize'&&<Field label={t('storage.partitionTable')}><Select value={style} onChange={event=>setStyle(event.target.value)}><option value="GPT">GPT</option><option value="MBR" disabled={edit.disk.sizeBytes>2199023255552}>{t('storage.mbr')}</option></Select></Field>}
    {edit.kind==='storage-new-volume'&&<Field inline label={t('storage.useMaximum')}><input type="checkbox" role="switch" checked={maximum} onChange={event=>setMaximum(event.target.checked)}/></Field>}
    {(edit.kind==='storage-resize'||edit.kind==='storage-new-volume'&&!maximum)&&<div className="sdx-storage-size">
     <Facts columns={3} stacked items={[...(edit.partition?[{id:'current',label:t('storage.current'),value:bytes(locale,edit.partition.sizeBytes),mono:true}]:[]),{id:'minimum',label:t('storage.minimum'),value:bytes(locale,sizeBounds?sizeBounds.minMiB*STORAGE_MIB:null),mono:true},{id:'maximum',label:t('storage.maximum'),value:bytes(locale,sizeBounds?sizeBounds.maxMiB*STORAGE_MIB:null),mono:true}]}/>
     <div className="sdx-storage-size-input">
      <Field label={t('storage.newTotal')} hint={sizeHint} error={formError?.field==='size'?formError.text:undefined}><input name="size" type="number" value={size} min={sizeBounds?Number(storageSizeInput(sizeBounds.minMiB,sizeUnit)):undefined} max={sizeBounds?Number(storageSizeInput(sizeBounds.maxMiB,sizeUnit)):undefined} step={sizeUnit===GIB?1/1024:1} required disabled={!sizeBounds} autoFocus onChange={event=>{setSize(event.target.value);setFormError(null);}}/></Field>
      <Field label={t('storage.unitLabel')}><Select value={sizeUnit} onChange={event=>{const miB=storageSizeMiB(size,sizeUnit);if(miB===null){setFormError({field:'size',text:t('storage.unitInvalid')});return;}const unit=event.target.value as StorageSizeUnit;setSizeUnit(unit);setSize(storageSizeInput(miB,unit));setFormError(null);}}>{STORAGE_SIZE_UNITS.map(unit=><option key={unit} value={unit}>{unit}</option>)}</Select></Field>
      <Btn size="sm" variant="ghost" blocked={!sizeBounds?t('storage.noRange'):undefined} onClick={()=>{if(sizeBounds)applySize(sizeBounds.maxMiB);setFormError(null);}}>{t('storage.applyMaximum')}</Btn>
     </div>
    </div>}
    {['storage-new-volume','storage-drive-letter'].includes(edit.kind)&&<Field label={t('storage.letter')}><Select value={letter} onChange={event=>setLetter(event.target.value)}><option value="">{t('storage.letter.none')}</option>{letters.map(value=><option key={value} value={value} disabled={inventory?.disks.some(disk=>disk.partitions.some(partition=>partition.driveLetter===value&&!(disk.number===edit.disk.number&&partition.number===edit.partition?.number)))}>{value}:</option>)}</Select></Field>}
    {['storage-new-volume','storage-format'].includes(edit.kind)&&<><Field label={t('storage.fileSystem')}><Select value={fileSystem} onChange={event=>setFileSystem(event.target.value)}><option value="NTFS">NTFS</option><option value="ReFS">{t('storage.refs')}</option></Select></Field><Field label={t('storage.volumeLabel')}><input name="label" value={label} maxLength={32} onChange={event=>setLabel(event.target.value)}/></Field></>}
    {['storage-format','storage-delete-partition'].includes(edit.kind)&&<>
     <Notice tone="danger" icon={AlertTriangle}>{t('storage.erase.warning')}</Notice>
     <Field label={<>{eraseBefore}<span className="mono">{edit.disk.number}/{edit.partition?.number}</span>{eraseAfter}</>} error={formError?.field==='erase'?formError.text:undefined}><input name="erase" value={erase} onChange={event=>{setErase(event.target.value);setFormError(null);}} required autoComplete="off" placeholder={`${edit.disk.number}/${edit.partition?.number}`}/></Field>
    </>}
    {formError&&formError.field===null&&<p className="sdx-field-error" role="alert">{formError.text}</p>}
   </form>}
  </Drawer>
 </div>;
}

/** The BitLocker state of the volume with this drive letter (ui/devices/inventory/health-signals.ts), with its tone. */
function BitLockerCell({server,drive}:{server:V3Props['server'];drive:string}){
 const [locale]=useLocale(),state=server.snapshot?.bitlocker,cell=volumeBitlockerText(bitlockerVolume(state,drive),state,locale);
 return <StatusPill kind={toneKind[cell.tone]}>{cell.text}</StatusPill>;
}
