'use client';
import {useEffect,useRef,useState} from 'react';
import {Check,Download,File,Loader2,Pause,Play,Upload,X} from 'lucide-react';
import {api,credentialFetch,message,permitted,online,v3,ApiError,type V3Props} from '@/ui/base/api';
import {Btn,Card,IconBtn,Unavailable} from '@/ui/kit/kit';
import {Field,Switch} from '@/ui/kit/field';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {confirmationDevice} from '@/ui/devices/management/management-actions';
import {formatBytes} from '@/lib/i18n/format';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {isOwner} from '@/ui/base/access-capabilities';
import FileBrowser,{joinRemotePath} from '@/ui/devices/remote/file-browser';
import {assertTransferCurrent,fileHash,FILE_CHUNK_SIZE,MAX_FILE_SIZE,runCreatedDownload,TRANSFER_TIMEOUT_MS,waitForCreatedTransfer,type BrowserTransfer,type TransferProgress} from '@/ui/devices/remote/file-transfer-flow';
import '@/ui/devices/remote/file-transfers.css';
import {useLocale,useT} from '@/ui/base/locale';
import {apiErrorText} from '@/ui/base/api-error-text';
import {documentLocale} from '@/lib/i18n/locale';
type PendingUpload={file:File;path:string;overwrite:boolean;id?:string;finished?:boolean};
type TransferNotice={scope:string;direction:'upload'|'download';name:string;phase:'waiting'|'streaming'|'verifying'|'completed'|'paused'|'failed'|'cancelled';done:number;total:number|null;label:string;error?:string};
export default function FilePanel({server,viewer,demo}:V3Props){
 const t=useT(),[locale]=useLocale();
 const scope=JSON.stringify([server.id,viewer.id,isOwner(viewer),server.management,server.permissions??[]]),scopeRef=useRef(scope);scopeRef.current=scope;
 const[busy,setBusy]=useState(false),[directory,setDirectory]=useState<string|null>(null),[localFiles,setLocalFiles]=useState<File[]>([]),[overwrite,setOverwrite]=useState(false),[paused,setPaused]=useState(false),[notice,setNotice]=useState<TransferNotice|null>(null),[refreshKey,setRefreshKey]=useState(0),[asking,setAsking]=useState(false);
 const controllerRef=useRef<AbortController|null>(null),pending=useRef<PendingUpload|null>(null),transferId=useRef<string|null>(null),input=useRef<HTMLInputElement|null>(null),mounted=useRef(true),operation=useRef(0),busyRef=useRef(false),cancelRequested=useRef(false),pendingDownload=useRef<{scope:string;path:string;id?:string}|null>(null);
 const reason=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'files.read')||permitted(server,viewer,'files.write'),reported:!!server.snapshot,supported:v3(server)}),canRead=permitted(server,viewer,'files.read'),canWrite=server.management===1&&permitted(server,viewer,'files.write'),connected=online(server);
 useEffect(()=>{operation.current++;controllerRef.current?.abort();pending.current=null;pendingDownload.current=null;transferId.current=null;busyRef.current=false;setDirectory(null);setLocalFiles([]);setNotice(null);setPaused(false);setBusy(false);},[scope]);
 // eslint-disable-next-line react-hooks/exhaustive-deps -- operation is a generation counter, not DOM refs; the cleanup increments it so that late responses are dropped.
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;operation.current++;controllerRef.current?.abort();};},[]);
 useEffect(()=>{if(notice?.phase!=='completed'||busy)return;const timer=setTimeout(()=>setNotice(previous=>previous===notice?null:previous),8000);return()=>clearTimeout(timer);},[notice,busy]);
 const current=(captured:string,generation:number)=>mounted.current&&scopeRef.current===captured&&operation.current===generation;
 const listTransfers=async(signal:AbortSignal,id=transferId.current)=>{const result=await api<{transfers:BrowserTransfer[]}>('/api/transfers?'+(id?'id='+encodeURIComponent(id):'serverId='+encodeURIComponent(server.id)),undefined,signal);return result.transfers;};
 const checkResponse=async(response:Response,fallback:string)=>{if(response.ok)return;const data=await response.json().catch(()=>null) as {error?:string;code?:string}|null;throw new ApiError(apiErrorText(documentLocale(),data,fallback),response.status,typeof data?.code==='string'?data.code:undefined);};
 const beginOperation=(direction:'upload'|'download',name:string,total:number|null)=>{
  controllerRef.current?.abort();const controller=new AbortController(),generation=++operation.current,captured=scope;
  controllerRef.current=controller;busyRef.current=true;cancelRequested.current=false;transferId.current=null;setBusy(true);setPaused(false);setNotice({scope:captured,direction,name,phase:'waiting',done:0,total,label:direction==='download'?t('files.download.preparing'):t('files.upload.preparing')});
  const guard={signal:controller.signal,isCurrent:()=>current(captured,generation)};
  const progress=(next:TransferProgress)=>{if(guard.isCurrent())setNotice(previous=>previous?{...previous,...next}:null);};
  return {controller,generation,captured,guard,progress};
 };
 const finishOperation=(captured:string,generation:number)=>{if(current(captured,generation)){busyRef.current=false;setBusy(false);}};
 const requestDownload=async(path:string,resumeId?:string)=>{
  if(busyRef.current||pending.current||!canRead||!connected)return;
  const existingId=pendingDownload.current?.scope===scope&&pendingDownload.current.path===path&&pendingDownload.current.id===resumeId?resumeId:undefined;
  pendingDownload.current={scope,path,...(existingId?{id:existingId}:{})};
  const {controller,generation,captured,guard,progress}=beginOperation('download',path.split(/[\\/]/).pop()||t('files.file'),null);
  try{
   const item=await runCreatedDownload({guard,onProgress:progress,onCreated:id=>{transferId.current=id;if(pendingDownload.current?.scope===captured)pendingDownload.current.id=id;},
    create:signal=>existingId?Promise.resolve({id:existingId}):api<{id:string}>('/api/transfers',{action:'create',serverId:server.id,direction:'download',path},signal),list:listTransfers,
    readChunk:async(id,index,signal)=>{const response=await credentialFetch(`/api/transfers?id=${encodeURIComponent(id)}&chunk=${index}`,{cache:'no-store',signal});await checkResponse(response,t('files.download.blockMissing'));return response.arrayBuffer();},
    save:(bytes,filePath)=>{assertTransferCurrent(guard);const url=URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>],{type:'application/octet-stream'}));try{const link=document.createElement('a');link.href=url;link.download=filePath.split(/[\\/]/).pop()||t('files.fallbackFileName');document.body.appendChild(link);link.click();link.remove();}finally{setTimeout(()=>URL.revokeObjectURL(url),10000);}},
   },locale);
   if(guard.isCurrent()){pendingDownload.current=null;transferId.current=null;setNotice({scope:captured,direction:'download',name:item.path.split(/[\\/]/).pop()||t('files.file'),phase:'completed',done:item.size??0,total:item.size,label:t('files.download.started')});}
  }catch(error){if(guard.isCurrent())setNotice(previous=>previous?{...previous,phase:controller.signal.aborted?'cancelled':'failed',label:controller.signal.aborted?t('files.download.cancelled'):t('files.download.failed'),error:controller.signal.aborted?undefined:message(error)}:null);}
  finally{finishOperation(captured,generation);}
 };
 const uploadOne=async(item:PendingUpload,guard:{signal:AbortSignal;isCurrent:()=>boolean},progress:(next:TransferProgress)=>void)=>{
  assertTransferCurrent(guard);if(item.file.size>MAX_FILE_SIZE)throw new Error(t('files.upload.tooLarge',{name:item.file.name}));
  if(item.id){transferId.current=item.id;const existing=(await listTransfers(guard.signal)).find(transfer=>transfer.id===item.id);assertTransferCurrent(guard);if(existing&&['ready','active','completed'].includes(existing.state))item.finished=true;else if(existing&&['failed','cancelled','expired'].includes(existing.state))throw new Error(existing.message||t('files.upload.cannotResume'));}
  if(!item.finished){
   progress({phase:'verifying',done:0,total:item.file.size,label:t('files.upload.hashing')});const buffer=await item.file.arrayBuffer();assertTransferCurrent(guard);const sha256=await fileHash(buffer);assertTransferCurrent(guard);
   if(!item.id){const result=await api<{id:string}>('/api/transfers',{action:'create',serverId:server.id,direction:'upload',path:item.path,size:item.file.size,sha256,overwrite:item.overwrite,confirm:true},guard.signal);assertTransferCurrent(guard);item.id=result.id;}
   transferId.current=item.id;
   for(let at=0,index=0;at<buffer.byteLength;at+=FILE_CHUNK_SIZE,index++){
    assertTransferCurrent(guard);progress({phase:'streaming',done:at,total:item.file.size,label:t('files.upload.uploading')});
    const response=await credentialFetch(`/api/transfers?id=${encodeURIComponent(item.id)}&chunk=${index}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:buffer.slice(at,Math.min(at+FILE_CHUNK_SIZE,buffer.byteLength)),signal:guard.signal});await checkResponse(response,t('files.upload.blockFailed'));assertTransferCurrent(guard);
   }
   await api('/api/transfers',{action:'finish',id:item.id,serverId:server.id},guard.signal);assertTransferCurrent(guard);item.finished=true;
  }
  transferId.current=item.id!;progress({phase:'waiting',done:item.file.size,total:item.file.size,label:t('files.transfer.agentAccepts')});
  await waitForCreatedTransfer({id:item.id!,direction:'upload',list:listTransfers,guard,onProgress:progress},locale);assertTransferCurrent(guard);
 };
 /** Uploads the chosen files. A new upload asks first (the ConfirmDialog below, confirmed=true from it); a resumed upload sends at once. */
 const upload=async(resume=false,confirmed=false)=>{
  if(busyRef.current||!canWrite||!connected||(!resume&&(pending.current||!directory||!localFiles.length)))return;
  const items=resume&&pending.current?[pending.current,...localFiles.filter(file=>file!==pending.current!.file).map(file=>({file,path:joinRemotePath(directory!,file.name),overwrite}))]:localFiles.map(file=>({file,path:joinRemotePath(directory!,file.name),overwrite}));
  if(!items.length)return;if(!resume&&!confirmed){setAsking(true);return;}
  const {controller,generation,captured,guard,progress}=beginOperation('upload',items[0].file.name,items[0].file.size);let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},TRANSFER_TIMEOUT_MS);
  try{
   for(const item of items){pending.current=item;setNotice({scope:captured,direction:'upload',name:item.file.name,phase:'waiting',done:0,total:item.file.size,label:t('files.upload.preparing')});await uploadOne(item,guard,progress);assertTransferCurrent(guard);pending.current=null;transferId.current=null;setLocalFiles(files=>files.filter(file=>file!==item.file));setRefreshKey(key=>key+1);}
   if(input.current)input.current.value='';setDirectory(null);setNotice({scope:captured,direction:'upload',name:items.length===1?items[0].file.name:t('files.upload.count',{count:items.length}),phase:'completed',done:1,total:1,label:t('files.upload.done')});
  }catch(error){if(guard.isCurrent()){
   const resumable=!!pending.current&&!cancelRequested.current;
   setPaused(resumable);setNotice(previous=>previous?{...previous,phase:cancelRequested.current?'cancelled':controller.signal.aborted&&!timedOut?'paused':'failed',label:cancelRequested.current?t('files.upload.cancelled'):controller.signal.aborted&&!timedOut?t('files.upload.paused'):t('files.upload.failed'),error:cancelRequested.current||controller.signal.aborted&&!timedOut?undefined:timedOut?t('files.upload.timeout'):message(error)}:null);
  }}finally{clearTimeout(timer);finishOperation(captured,generation);}
 };
 const cancel=async()=>{
  const id=transferId.current??pending.current?.id,captured=scope,generation=operation.current;cancelRequested.current=true;controllerRef.current?.abort();pending.current=null;pendingDownload.current=null;setPaused(false);
  if(current(captured,generation))setNotice(previous=>previous?{...previous,phase:'cancelled',label:t('files.transfer.cancelled'),error:undefined}:null);
  if(id)try{await api('/api/transfers',{action:'cancel',id,serverId:server.id});}catch(error){if(current(captured,generation))setNotice(previous=>previous?{...previous,error:message(error)}:null);}
 };
 const closeUpload=()=>{setDirectory(null);setLocalFiles([]);pending.current=null;setPaused(false);if(input.current)input.current.value='';};
 const visible=notice?.scope===scope?notice:null;
 if(reason)return <Unavailable reason={reason}>{reason==='right'?t('files.blocked.right'):undefined}</Unavailable>;
 // Reasons on the upload controls: the connection and a running or paused transfer.
 const offlineReason=connected?undefined:t('kit.unavailable.offline'),transferReason=busy||paused?t('files.blocked.transfer'):undefined;
 const addFiles=(files:FileList|File[])=>{if(busyRef.current||pending.current)return;setLocalFiles(Array.from(files));setPaused(false);pending.current=null;};
 return <div className="v3-form serverdesk-files">
 {canRead&&<FileBrowser server={server} viewer={viewer} demo={demo} onUpload={canWrite?path=>{if(busyRef.current||pending.current)return;setDirectory(path);input.current?.click();}:undefined} onDownload={canRead?path=>void requestDownload(path):undefined} transferBusy={busy||paused} refreshKey={refreshKey}/>}
 {canWrite&&<input type="file" multiple ref={input} style={{display:'none'}} onChange={event=>event.target.files&&addFiles(event.target.files)} disabled={busy||paused}/>}
 {!canRead&&canWrite&&directory===null&&<Btn icon={Upload} blocked={offlineReason??transferReason} onClick={()=>setDirectory('')}>{t('files.upload.title')}</Btn>}
 {directory!==null&&canWrite&&<Card className="transfer-upload" title={t('files.upload.title')} icon={Upload} iconTone="accent" actions={<IconBtn icon={X} label={t('files.upload.closePicker')} blocked={transferReason} onClick={closeUpload}/>}><div className="transfer-upload-body">
 {canRead?<div className="transfer-destination"><span>{t('files.upload.target',{name:server.name})}</span><strong className="mono">{directory}</strong></div>:<Field label={t('files.upload.target',{name:server.name})} className="transfer-destination"><input className="mono" placeholder="C:\\Temp" value={directory} onChange={event=>setDirectory(event.target.value)} disabled={busy||paused}/></Field>}
 <Btn className="transfer-file-choice" icon={Upload} blocked={transferReason} onClick={()=>input.current?.click()} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();if(!busy&&!paused)addFiles(event.dataTransfer.files);}}>{localFiles.length?t('files.upload.change'):t('files.upload.choose')}</Btn>
 {localFiles.length>0&&<div className="transfer-selected-files">{localFiles.map((file,index)=><span key={index}><File size={13}/><strong>{file.name}</strong><small>{formatBytes(locale,file.size)}</small></span>)}</div>}
 <Switch label={t('files.upload.overwrite')} checked={overwrite} blocked={transferReason} onChange={next=>{setOverwrite(next);}}/>
 <div className="transfer-upload-actions">{!paused&&<Btn size="sm" variant="primary" icon={Upload} loading={busy} blocked={offlineReason??(directory?undefined:t('files.blocked.noFolder'))??(localFiles.length?undefined:t('files.blocked.noFile'))} onClick={()=>void upload()}>{t('files.upload')}</Btn>}<span>{t('files.upload.max')}</span></div>
 </div></Card>}
 <ConfirmDialog open={asking} onOpenChange={open=>{if(!open)setAsking(false);}} title={t('files.upload.confirmTitle',{count:localFiles.length})}
  lines={[...confirmationDevice(server.name,locale),{label:t('files.folder'),value:directory??'',mono:true}]} body={overwrite?t('files.upload.overwriteHint'):undefined} confirmLabel={t('files.upload')}
  onConfirm={()=>{setAsking(false);void upload(false,true);}}/>
 {visible&&<section className={'transfer-notice transfer-'+visible.phase} aria-label={t('files.transfer.label')}><div className="transfer-notice-icon">{visible.phase==='completed'?<Check size={19}/>:busy?<Loader2 size={19} className="spin"/>:visible.direction==='download'?<Download size={19}/>:<Upload size={19}/>}</div><div className="transfer-notice-content"><strong>{visible.name}</strong><span role="status">{visible.label}{visible.phase==='streaming'&&visible.total!==null?' · '+Math.round(visible.total?visible.done/visible.total*100:100)+' %':''}</span>{busy&&<progress max={visible.total??undefined} value={visible.total!==null&&visible.phase==='streaming'?visible.done:undefined}/>} {visible.error&&<p role="alert">{visible.error}</p>}</div><div className="transfer-notice-actions">{busy&&pending.current&&<Btn size="sm" variant="ghost" icon={Pause} onClick={()=>controllerRef.current?.abort()}>{t('files.transfer.pause')}</Btn>}{!busy&&visible.phase==='failed'&&visible.direction==='download'&&pendingDownload.current?.id&&<Btn size="sm" icon={Play} blocked={offlineReason} onClick={()=>{const saved=pendingDownload.current;if(saved?.id)void requestDownload(saved.path,saved.id);}}>{t('files.transfer.resume')}</Btn>}{paused&&<Btn size="sm" icon={Play} disabled={busy} blocked={offlineReason} onClick={()=>void upload(true)}>{t('files.transfer.resume')}</Btn>}{(busy||paused)&&<Btn size="sm" variant="ghost" icon={X} onClick={()=>void cancel()} aria-label={t('files.transfer.cancel')}>{t('common.cancel')}</Btn>}{!busy&&!paused&&<IconBtn icon={X} label={t('files.transfer.closeStatus')} onClick={()=>setNotice(null)}/>}</div></section>}
 </div>;
}
