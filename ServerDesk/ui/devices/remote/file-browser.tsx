'use client';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {AlertTriangle,ArrowLeft,ChevronRight,Download,File,Folder,FolderOpen,FolderPlus,FolderSearch,HardDrive,Loader2,Pencil,RefreshCw,Search,ShieldCheck,Trash2,Upload,X} from 'lucide-react';
import {toast} from 'sonner';
import {api,ApiError,message,online,permitted,stamp,v3,type Device,type V3Props} from '@/ui/base/api';
import {Btn,IconBtn,Menu,Meter,Notice,PanelUnavailable,SectionHead,Skeleton,Unavailable,type MenuEntry} from '@/ui/kit/kit';
import {Field} from '@/ui/kit/field';
import {DataTable,Toolbar,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {isOwner} from '@/ui/base/access-capabilities';
import type {Viewer} from '@/lib/types';
import {fileEditParameters,sortFileEntries,type FileEditTarget,type FileSortColumn} from '@/ui/devices/remote/file-browser-state';
import {confirmationDevice} from '@/ui/devices/management/management-actions';
import type {RowSort} from '@/ui/base/table-sort';
import {agentMessageText,type AgentTranslate} from '@/lib/agent-messages';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {EMPTY_VALUE,formatBytes,formatNumber} from '@/lib/i18n/format';
import '@/ui/devices/remote/file-browser.css';
import {useLocale,useT} from '@/ui/base/locale';
import {useNarrowLayout} from '@/ui/base/narrow-layout';
import {translate} from '@/lib/i18n/translate';
type Entry={name:string;path:string;kind:'directory'|'file';size?:number;modifiedAt?:string;attributes?:string;blocked?:boolean};
type Drive={name:string;label?:string;kind:string;freeBytes?:number;totalBytes?:number;ready:boolean};
type Listing={path:string|null;drives:Drive[];entries:Entry[];total:number;offset:number;hasMore:boolean;truncated?:boolean;listedAt?:string};
type Job={id:string;kind:string;state:string;result:string|null;resultCode?:string|null;resultArgs?:Record<string,string>|null;data:Listing|null};
export function joinRemotePath(directory:string,name:string){return directory.replace(/[\\/]+$/,'')+'\\'+name;}
export function parentRemotePath(path:string){const clean=path.replace(/\\+$/,'');return clean.length<=2?null:clean.substring(0,clean.lastIndexOf('\\')+1)||null;}
function wait(ms:number,signal:AbortSignal,locale:Locale=defaultLocale){return new Promise<void>((resolve,reject)=>{if(signal.aborted){reject(new DOMException(translate(locale,'jobs.state.cancelled'),'AbortError'));return;}const id=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms),abort=()=>{clearTimeout(id);reject(new DOMException(translate(locale,'jobs.state.cancelled'),'AbortError'));};signal.addEventListener('abort',abort,{once:true});});}
/** t translates a coded agent failure; without it the stored result text is shown. */
export async function fileJob(serverId:string,kind:string,params:Record<string,unknown>,signal:AbortSignal,confirm=false,t?:AgentTranslate,locale:Locale=defaultLocale){
 const {id}=await api<{id:string}>('/api/files',{serverId,kind,params,confirm},signal);if(typeof window!=='undefined')window.dispatchEvent(new Event('serverdesk:refresh'));
 const deadline=Date.now()+150000;
 while(Date.now()<deadline){const {job}=await api<{job:Job}>('/api/files?serverId='+encodeURIComponent(serverId)+'&jobId='+encodeURIComponent(id),undefined,signal);if(job.state==='succeeded'){if(!job.data)throw new Error(translate(locale,'files.job.gone'));return job.data;}if(!['pending','running'].includes(job.state))throw new Error((t?agentMessageText(job,t):job.result)||translate(locale,'files.job.failed'));await wait(700,signal,locale);}
 throw new Error(translate(locale,'files.job.noResult'));
}
type BrowserProps=V3Props&{pickerMode?:'file'|'folder'|'any';onSelect?:(path:string)=>void;onClose?:()=>void;initialPath?:string;onUpload?:(directory:string)=>void;onDownload?:(path:string)=>void;transferBusy?:boolean;refreshKey?:number};
/** The listing page size: the agent lists 200 entries per request (server offset). */
const PAGE_SIZE=200;
/**
 * The Files subarea (nodiverna-ui §4 "Device section") and the path picker of Drift. The path line and the
 * listing are the focal point: drives as cards with a used-space Meter, a folder as one DataTable with sort
 * heads (folders first), the kit Toolbar with search, Folder and Upload, and one row Menu per entry. Delete
 * asks through ConfirmDialog. In picker mode a row click selects the entry and the footer "Choose" returns it.
 */
export default function FileBrowser({server,viewer,demo,pickerMode,onSelect,onClose,initialPath,onUpload,onDownload,transferBusy=false,refreshKey=0}:BrowserProps){
 const t=useT(),[locale]=useLocale(),localeRef=useRef(locale),translateRef=useRef(t),scope=JSON.stringify([server.id,viewer.id,isOwner(viewer),server.permissions??[]]),scopeRef=useRef(scope);scopeRef.current=scope;translateRef.current=t;
 // The list loader keeps a stable identity; it reads the current language here.
 useEffect(()=>{localeRef.current=locale;},[locale]);
 // A language switch changes only the shown text; it must not reload the listing.
 const agentT:AgentTranslate=(key,params)=>translateRef.current(key,params);
 const[path,setPath]=useState<string|null>(initialPath||null),[pathInput,setPathInput]=useState(initialPath||''),[listing,setListing]=useState<Listing|null>(null),[dataScope,setDataScope]=useState(''),[selected,setSelected]=useState<Entry|null>(null),[filter,setFilter]=useState(''),[sort,setSort]=useState<RowSort<FileSortColumn>|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[offset,setOffset]=useState(0),[revision,setRevision]=useState(0),[edit,setEdit]=useState<FileEditTarget|null>(null),[name,setName]=useState(''),[deleting,setDeleting]=useState<Entry|null>(null);
 const controller=useRef<AbortController|null>(null),generation=useRef(0),capable=server.snapshot?.agentCapabilities?.includes('list-files')===true,connected=online(server),
  // Without files.read, without the list-files capability or for a sample device the browser names the reason instead of a listing.
  reason=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'files.read'),reported:!!server.snapshot,supported:v3(server)&&capable}),enabled=reason===null,write=!pickerMode&&server.management===1&&permitted(server,viewer,'files.write'),includeSecurity=permitted(server,viewer,'security.events');
 useEffect(()=>{controller.current?.abort();generation.current++;setListing(null);setSelected(null);setDataScope('');setPath(initialPath||null);setPathInput(initialPath||'');setOffset(0);setEdit(null);setError('');setDeleting(null);},[scope,initialPath]);
 const navigate=useCallback((next:string|null,nextOffset=0)=>{next=next?next.replaceAll('/','\\').replace(/\\{2,}/g,'\\'):null;setPath(next);setPathInput(next||'');setOffset(nextOffset);setSelected(null);setFilter('');setEdit(null);setError('');setRevision(n=>n+1);},[]);
 useEffect(()=>{if(!enabled||!connected)return;controller.current?.abort();const abort=new AbortController();controller.current=abort;const current=++generation.current,captured=scope;setBusy(true);setError('');setSelected(null);void fileJob(server.id,'list-files',{...(path?{path}:{}),offset,limit:PAGE_SIZE,includeSecurity},abort.signal,false,agentT,localeRef.current).then(data=>{if(current!==generation.current||scopeRef.current!==captured)return;setListing(data);setDataScope(captured);}).catch(e=>{if(!abort.signal.aborted&&current===generation.current){if(e instanceof ApiError&&[401,403].includes(e.status)){setListing(null);setDataScope('');}setError(message(e));}}).finally(()=>{if(current===generation.current)setBusy(false);});return()=>abort.abort();},[server.id,enabled,scope,path,offset,revision,refreshKey,includeSecurity,connected]);
 useEffect(()=>()=>{controller.current?.abort();generation.current++;},[]);
 // At 760px or narrower the path form submits through an icon-only Open button that fits the row beside Back and Refresh.
 const narrow=useNarrowLayout();
 const sameDirectory=(a:string|null|undefined,b:string|null)=>a==null?b===null:typeof b==='string'&&a.replace(/\\+$/,'').toLowerCase()===b.replace(/\\+$/,'').toLowerCase();
 const visible=dataScope===scope&&sameDirectory(listing?.path,path)?listing:null;
 const selection=visible?.entries.find(entry=>entry.path===selected?.path&&!entry.blocked)??null;
 const rows=useMemo(()=>{const query=filter.trim().toLocaleLowerCase(locale);return sortFileEntries((visible?.entries??[]).filter(row=>!query||row.name.toLocaleLowerCase(locale).includes(query)),sort);},[visible,filter,sort,locale]);
 const mutate=async(kind:'create-directory'|'rename-file'|'delete-file',params:Record<string,unknown>)=>{if(!write||busy||dataScope!==scope)return;controller.current?.abort();const abort=new AbortController();controller.current=abort;const current=++generation.current,captured=scope;setBusy(true);setError('');try{await fileJob(server.id,kind,params,abort.signal,true,t,locale);if(current===generation.current&&scopeRef.current===captured){setEdit(null);setName('');setSelected(null);setRevision(n=>n+1);window.dispatchEvent(new Event('serverdesk:refresh'));}}catch(e){if(!abort.signal.aborted&&current===generation.current)toast.error(message(e));}finally{if(current===generation.current)setBusy(false);}};
 // Try again: the current folder (or the drive list) is listed again.
 const reload=()=>{setError('');setRevision(n=>n+1);};
 const retry=<Btn variant="ghost" size="sm" onClick={reload}>{t('common.retry')}</Btn>;
 if(reason)return <Unavailable reason={reason}>{reason==='right'?t('files.blocked.right'):reason==='agent'?t('files.needsUpdate'):undefined}</Unavailable>;
 const breadcrumbs=path?.split('\\').filter(Boolean)??[],canPick=pickerMode==='folder'?!!path&&(!selection||selection.kind==='directory'):pickerMode==='file'?selection?.kind==='file':!!selection||!!path;
 // Reasons the user can act on stay on the control (blocked, nodiverna-ui §5): the right, the mode, the connection, a running transfer, no open folder.
 const writeReason=!permitted(server,viewer,'files.write')?t('files.blocked.write'):server.management!==1?t('kit.unavailable.mode'):undefined;
 const offlineReason=connected?undefined:t('kit.unavailable.offline'),transferReason=transferBusy?t('files.blocked.transfer'):undefined,noFolder=t('files.blocked.noFolder');
 const busyReason=busy?t('files.running'):undefined;
 // Choose in the picker: a spinner while the agent works, else the reason it cannot return a path yet (no listing, nothing chosen).
 const chooseBlocked=busy?undefined:!visible?(path?t('files.loadingFolder'):t('files.loadingDrives')):canPick?undefined:pickerMode==='file'?t('files.blocked.noFile'):noFolder;
 const changeBlocked=writeReason??offlineReason??transferReason,folderBlocked=changeBlocked??(path?undefined:noFolder)??busyReason??(path&&!visible?t('files.loadingFolder'):undefined);
 // The one panel notice while writing is blocked; the reasons stay on each action as well.
 const writeNotice=pickerMode?null:unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'files.write'),reported:true,supported:true,management:server.management===1});
 const entries=(entry:Entry):MenuEntry[]=>{
  const protectedReason=entry.blocked?t('files.protected'):undefined,rowBusy=busyReason;
  const open:MenuEntry[]=entry.kind==='directory'?[{id:'open',label:t('common.open'),icon:FolderOpen,blocked:protectedReason??rowBusy,onSelect:()=>navigate(entry.path)}]:[];
  if(pickerMode)return open;
  return [...open,
   ...(entry.kind==='file'&&onDownload?[{id:'download',label:t('files.download'),icon:Download,blocked:protectedReason??offlineReason??transferReason??rowBusy,onSelect:()=>onDownload(entry.path)} as MenuEntry]:[]),
   {id:'rename',label:t('tree.rename'),icon:Pencil,blocked:protectedReason??changeBlocked??rowBusy,onSelect:()=>{setEdit({kind:'rename',path:entry.path,name:entry.name});setName(entry.name);}},
   {id:'separator',separator:true},
   {id:'delete',label:t('common.delete'),icon:Trash2,danger:true,blocked:protectedReason??changeBlocked??rowBusy,onSelect:()=>setDeleting(entry)},
  ];
 };
 const columns:DataColumn<Entry>[]=[
  {id:'name',label:t('common.name'),primary:true,sort:{first:'asc'},cell:entry=><span className={'file-entry'+(entry.blocked?' file-entry-blocked':'')} title={entry.blocked?t('files.protected'):entry.path}>{entry.kind==='directory'?<Folder size={16} aria-hidden/>:<File size={16} aria-hidden/>}<span>{entry.name}</span>{entry.blocked&&<ShieldCheck size={13} aria-label={t('files.protected')}/>}</span>},
  {id:'size',label:t('storage.col.size'),align:'end',mono:true,sort:{first:'desc'},cell:entry=>entry.kind==='directory'?EMPTY_VALUE:formatBytes(locale,entry.size)},
  {id:'modified',label:t('files.lastModified'),sort:{first:'desc'},hideBelow:900,cell:entry=>stamp(entry.modifiedAt,locale)},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:entry=><Menu label={t('tree.actionsForName',{name:entry.name})} entries={entries(entry)}/>},
 ];
 // A row click opens a folder; in picker mode it selects the entry (a file, or a folder for the folder picker).
 const openRow=(entry:Entry)=>{if(busy||entry.blocked)return;if(pickerMode){setSelected(entry);return;}if(entry.kind==='directory')navigate(entry.path);};
 const summary=visible?path?filter?t('files.entriesFiltered',{count:formatNumber(locale,visible.total),hits:rows.length}):t('files.entries',{count:formatNumber(locale,visible.total)}):t('files.drives',{count:visible.drives.length}):t('files.localFs');
 const footText=visible?.truncated?t('files.truncated',{summary}):summary;
 const toolbar=<Toolbar className="file-toolbar" search={{value:filter,onChange:setFilter,label:t('files.filterLabel'),placeholder:t('files.filterPlaceholder')}}
  actions={!pickerMode&&<><Btn size="sm" icon={FolderPlus} blocked={folderBlocked} onClick={()=>{if(path){setEdit({kind:'mkdir',path});setName('');}}}>{t('files.folder')}</Btn>{onUpload&&<Btn size="sm" icon={Upload} blocked={folderBlocked} onClick={()=>path&&onUpload(path)}>{t('files.upload')}</Btn>}</>}/>;
 const empty=filter?{icon:Search,title:t('files.noMatch'),action:<Btn size="sm" icon={X} onClick={()=>setFilter('')}>{t('fleet.empty.resetFilter')}</Btn>}:{icon:FolderSearch,title:t('files.empty')};
 const head=pickerMode
  ?<SectionHead level={3} title={t('files.pickPath')} actions={onClose&&<IconBtn icon={X} label={t('files.closePicker')} onClick={onClose}/>}/>
  :<><SectionHead hideTitle title={t('device.section.files')} description={t('files.description')}/><PanelUnavailable reason={writeNotice} readOnly={t('files.readOnly')}/></>;
 return <section className={'file-browser'+(pickerMode?' file-browser-picker':'')} aria-label={pickerMode?t('files.pickPath'):t('files.browser')}>
 {head}
 {error&&<Notice tone="danger" icon={AlertTriangle} action={<Btn size="sm" icon={RefreshCw} onClick={reload}>{t('common.retry')}</Btn>}><p>{error}</p>{visible&&<p>{t('console.staleData')}</p>}</Notice>}
 <div className="file-navigation"><IconBtn icon={ArrowLeft} className="sdx-icon-btn-framed" label={t('files.parent')} disabled={busy} blocked={path?undefined:noFolder} onClick={()=>navigate(path?parentRemotePath(path):null)}/><form className="file-path-form" onSubmit={event=>{event.preventDefault();navigate(pathInput.trim()||null);}}><Field label={t('files.windowsPath')} className="file-path-field"><input className="mono" placeholder={t('files.pathPlaceholder')} value={pathInput} onChange={event=>setPathInput(event.target.value)} disabled={busy}/></Field>{narrow?<IconBtn type="submit" icon={FolderOpen} className="sdx-icon-btn-framed" label={t('common.open')} disabled={busy}/>:<Btn type="submit" size="sm" disabled={busy}>{t('common.open')}</Btn>}</form><IconBtn icon={RefreshCw} className="sdx-icon-btn-framed" label={t('files.refresh')} loading={busy} blocked={offlineReason} onClick={()=>setRevision(n=>n+1)}/></div>
 <nav className="file-breadcrumb" aria-label={t('files.breadcrumb')}><Btn variant="ghost" size="sm" icon={HardDrive} disabled={busy} onClick={()=>navigate(null)}>{t('device.summary.drives')}</Btn>{breadcrumbs.map((part,index)=><span key={index}><ChevronRight size={12} aria-hidden/><Btn variant="ghost" size="sm" disabled={busy} onClick={()=>navigate(breadcrumbs.slice(0,index+1).join('\\')+'\\')}>{part}</Btn></span>)}</nav>
 {edit&&dataScope===scope&&<form className="file-inline-editor" onSubmit={event=>{event.preventDefault();if(name.trim())void mutate(edit.kind==='mkdir'?'create-directory':'rename-file',fileEditParameters(edit,name));}}><Field label={edit.kind==='mkdir'?t('files.newFolder'):t('files.newNameFor',{name:edit.name??''})} hint={<span className="mono">{edit.path}</span>}><input value={name} onChange={event=>setName(event.target.value)} autoFocus maxLength={255} disabled={busy}/></Field><Btn type="submit" size="sm" variant="primary" loading={busy}>{edit.kind==='mkdir'?t('files.create'):t('tree.rename')}</Btn><IconBtn icon={X} label={t('files.cancelEdit')} disabled={busy} onClick={()=>setEdit(null)}/></form>}
 {busy&&visible&&<div className="file-loading" role="status"><Loader2 className="sdx-spin" size={16} aria-hidden/>{t('files.running')}</div>}
 {!connected?<>{toolbar}<Unavailable reason="offline"/></>
  :!visible&&!error?<>{toolbar}<Skeleton variant={path?'table':'cards'} label={path?t('files.loadingFolder'):t('files.loadingDrives')} after={15000} action={retry}/></>
  :!path?<>{toolbar}<ul className="file-drives" aria-label={t('device.summary.drives')}>{visible?.drives.map(drive=>{const used=drive.ready&&drive.totalBytes?Math.round((drive.totalBytes-(drive.freeBytes??0))/drive.totalBytes*100):null,free=t('files.driveFree',{free:formatBytes(locale,drive.freeBytes),total:formatBytes(locale,drive.totalBytes)});return <li key={drive.name}><button type="button" className="file-drive sdx-lift" disabled={!drive.ready||busy} onClick={()=>navigate(drive.name)}><HardDrive size={22} aria-hidden/><span className="file-drive-text"><strong>{drive.name}{drive.label?' · '+drive.label:''}</strong><span>{drive.ready?free:t('files.noMedium')}</span>{used!==null&&<Meter size="sm" value={used} label={`${drive.name} ${free}`}/>}</span><ChevronRight size={16} aria-hidden/></button></li>;})}</ul></>
  :<DataTable label={t('files.browser')} cards entranceId="device-files" toolbar={toolbar} columns={columns} rows={rows} rowKey={entry=>entry.path} busy={busy}
    sort={sort} onSort={next=>setSort(next as TableSort<FileSortColumn>)} onOpen={openRow} openLabel={entry=>entry.kind==='directory'&&!pickerMode?`${t('common.open')}: ${entry.name}`:entry.name}
    highlightKey={pickerMode?selection?.path:undefined} empty={empty} foot={footText}
    pagination={visible?{page:Math.floor(offset/PAGE_SIZE)+1,pageSize:PAGE_SIZE,total:visible.total,onPage:page=>navigate(path,(page-1)*PAGE_SIZE)}:undefined}/>}
 {(!path||pickerMode)&&<footer className="file-footer">{!path&&<span>{footText}</span>}{pickerMode&&<Btn size="sm" variant="primary" loading={busy} blocked={chooseBlocked} onClick={()=>{const choice=selection?.path??path;if(choice)onSelect?.(choice);}}>{t('management.updates.select')}</Btn>}</footer>}
 <ConfirmDialog open={!!deleting} onOpenChange={open=>{if(!open)setDeleting(null);}} tone="danger" title={t('files.delete.title',{name:deleting?.name??''})}
  lines={deleting?[...confirmationDevice(server.name,locale),{label:t('diagnostics.path'),value:deleting.path,mono:true}]:undefined} body={t('files.delete.description')} confirmLabel={t('common.delete')}
  onConfirm={()=>{const target=deleting;setDeleting(null);if(target)void mutate('delete-file',{path:target.path});}}/>
 </section>;
}
export function FilePicker({server,viewer,demo=false,mode,onSelect,onClose,initialPath}:{server:Device;viewer:Viewer;demo?:boolean;mode:'file'|'folder'|'any';onSelect:(path:string)=>void;onClose?:()=>void;initialPath?:string}){return <FileBrowser server={server} viewer={viewer} demo={demo} pickerMode={mode} onSelect={onSelect} onClose={onClose} initialPath={initialPath}/>;}
