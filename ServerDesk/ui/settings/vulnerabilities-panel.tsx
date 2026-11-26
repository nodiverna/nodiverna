'use client';
import {useCallback,useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {AlertTriangle,ExternalLink,KeyRound,Package,RefreshCw,ShieldAlert} from 'lucide-react';
import {toast} from 'sonner';
import type {Viewer} from '@/lib/types';
import type {VulnerabilitySettingsView,VulnerabilitySyncState} from '@/lib/server/devices/vulnerabilities';
import {serverMessageText} from '@/lib/server-messages';
import {sortTableRows} from '@/ui/base/table-sort';
import {EMPTY_VALUE,formatDate,formatNumber} from '@/lib/i18n/format';
import type {MessageKey} from '@/lib/i18n/translate';
import {api,ApiError,credentialFetch,message,readApiJson} from '@/ui/base/api';
import {canManageInstanceSettings} from '@/ui/base/access-capabilities';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {Btn,Card,Facts,Notice,SettingsPage,StatusPill,exactTime,type StatusKind} from '@/ui/kit/kit';
import {DataTable,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {Field,FormActions,Switch} from '@/ui/kit/field';
import {useLocale,useT} from '@/ui/base/locale';
import '@/ui/devices/inventory/vulnerabilities.css';

// The page Settings → Vulnerability check (Owners only, docs/software-vulnerabilities.md):
// the switch, the switch of the CVE.org source and the optional NVD API key (draft
// values that save with Save), the state of the sync with Check now, and the
// products of the catalog. The CVE.org fact, column, failure notice and attribution
// show only while that source is on. The key is write-only: the page only learns
// whether one is saved. Sample devices change nothing here: the page shows and
// changes the real settings.
const endpoint='/api/vulnerabilities/settings';
const pollMs=10_000;
export const nvdApiKeyPattern=/^[A-Za-z0-9-]{20,64}$/;
export const nvdKeyRequestUrl='https://nvd.nist.gov/developers/request-an-api-key';
const stateKey:Record<VulnerabilitySyncState,MessageKey>={off:'vulnerabilities.state.off',idle:'vulnerabilities.state.idle',queued:'vulnerabilities.state.queued',running:'vulnerabilities.state.running',failed:'vulnerabilities.state.failed'};
const stateKind:Record<VulnerabilitySyncState,StatusKind>={off:'neutral',idle:'success',queued:'waiting',running:'waiting',failed:'critical'};
type Form={enabled:boolean;secondSource:boolean;apiKey:string;removeKey:boolean};
const formOf=(view:VulnerabilitySettingsView):Form=>({enabled:view.enabled,secondSource:view.secondSource.enabled,apiKey:'',removeKey:false});
type Product=VulnerabilitySettingsView['products'][number];
type ProductColumn='product'|'cves'|'secondSource'|'updated';

async function saveSettings(payload:Record<string,unknown>):Promise<VulnerabilitySettingsView>{
 const response=await credentialFetch(endpoint,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store'});
 return readApiJson<VulnerabilitySettingsView>(response);
}

export default function VulnerabilitiesPanel({viewer,initialView=null,initialLoadFailed=false,frame}:{viewer:Viewer;/** A view to show before the first load completes. */initialView?:VulnerabilitySettingsView|null;/** Tests: render a failed load. */initialLoadFailed?:boolean;frame?:PageFrame}){
 const t=useT(),[locale]=useLocale();
 const [view,setView]=useState<VulnerabilitySettingsView|null>(initialView),[loadFailed,setLoadFailed]=useState(initialLoadFailed),[loading,setLoading]=useState(true);
 const [form,setForm]=useState<Form|null>(null),[submitted,setSubmitted]=useState(false),[keyRejected,setKeyRejected]=useState(false),[saving,setSaving]=useState(false),[checking,setChecking]=useState(false);
 const [sort,setSort]=useState<TableSort<ProductColumn>|null>(null);
 const mounted=useRef(false),sequence=useRef(0);
 const load=useCallback(async(resetForm=false)=>{
  const current=++sequence.current;setLoading(true);
  try{
   const next=await api<VulnerabilitySettingsView>(endpoint);
   if(!mounted.current||current!==sequence.current)return;
   setView(next);setLoadFailed(false);setForm(previous=>resetForm||!previous?formOf(next):previous);
  }catch{if(mounted.current&&current===sequence.current)setLoadFailed(true);}
  finally{if(mounted.current&&current===sequence.current)setLoading(false);}
 },[]);
 useEffect(()=>{mounted.current=true;void Promise.resolve().then(()=>load(true));return()=>{mounted.current=false;};},[load,viewer.id]);
 useFrameRefresh(frame,()=>load());
 const busy=view?.sync.state==='queued'||view?.sync.state==='running';
 // While a check is queued or running the page asks again every 10 seconds.
 useEffect(()=>{
  if(!busy)return;
  const timer=setInterval(()=>{void load();},pollMs);
  return()=>clearInterval(timer);
 },[busy,load]);
 const page=(children:ReactNode)=><>{frameHeader(frame)}<SettingsPage className="sdx-vulnerabilities" label={t('nav.settings.vulnerabilities')} loading={!view&&!loadFailed}
  loadError={loadFailed?`${t('vulnerabilities.settings.loadFailed')}${view?' '+t('notifications.staleData'):''}`:undefined} onRetry={()=>void load(!view)} retrying={loading}>{children}</SettingsPage></>;
 if(!view)return page(null);

 const current=form??formOf(view),baseline=formOf(view);
 const dirty=current.enabled!==baseline.enabled||current.secondSource!==baseline.secondSource||current.apiKey!==''||current.removeKey;
 const keyInvalid=current.apiKey!==''&&!nvdApiKeyPattern.test(current.apiKey.trim());
 const keyError=(submitted&&keyInvalid)||keyRejected;
 const locked=!canManageInstanceSettings(viewer)?t('apiError.vulnerabilities.ownerOnly'):undefined;
 const change=(next:Partial<Form>)=>{setForm({...current,...next});if('apiKey' in next)setKeyRejected(false);};
 const submit=async(event:FormEvent)=>{
  event.preventDefault();
  if(locked||saving||!dirty)return;
  setSubmitted(true);
  if(keyInvalid)return;
  setSaving(true);
  try{
   const next=await saveSettings({enabled:current.enabled,secondSource:current.secondSource,apiKey:current.removeKey?null:current.apiKey.trim()||undefined,revision:view.revision});
   if(!mounted.current)return;
   setView(next);setForm(formOf(next));setSubmitted(false);
   toast.success(t('vulnerabilities.settings.saved'));
  }catch(failure){
   if(!mounted.current)return;
   if(failure instanceof ApiError&&failure.code==='VULNERABILITY_SETTINGS_INVALID'){setKeyRejected(true);return;}
   if(failure instanceof ApiError&&failure.code==='VULNERABILITY_SETTINGS_STALE'){toast.error(t('vulnerabilities.settings.stale'));await load(true);return;}
   toast.error(message(failure,locale));
  }finally{if(mounted.current)setSaving(false);}
 };
 const checkNow=async()=>{
  if(locked||checking||!view.enabled||busy)return;
  setChecking(true);
  try{
   const next=await api<VulnerabilitySettingsView>('/api/vulnerabilities/sync',{});
   if(!mounted.current)return;
   setView(next);toast.success(t('vulnerabilities.checkQueued'));
  }catch(failure){if(mounted.current)toast.error(message(failure,locale));}
  finally{if(mounted.current)setChecking(false);}
 };
 const checkBlocked=locked??(!view.enabled?t('vulnerabilities.blocked.off'):busy?t('vulnerabilities.blocked.running'):undefined);
 const sync=view.sync,secondSource=view.secondSource;
 const never=t('vulnerabilities.status.never');
 const nextCheck=sync.state==='off'||sync.state==='running'?EMPTY_VALUE:sync.state==='queued'?t('vulnerabilities.status.withinMinute'):sync.nextDueAt===null?EMPTY_VALUE:exactTime(sync.nextDueAt,locale);
 const products=sortTableRows(view.products,sort,{product:product=>product.label,cves:product=>product.cveCount,secondSource:product=>product.secondSourceCount,updated:product=>product.syncedAt});
 const columns:DataColumn<Product>[]=[
  {id:'product',label:t('vulnerabilities.products.col.product'),primary:true,sort:{first:'asc'},cell:product=>product.label},
  {id:'cves',label:t('vulnerabilities.products.col.cves'),mono:true,align:'end',sort:{first:'desc'},cell:product=>formatNumber(locale,product.cveCount)},
  ...(secondSource.enabled?[{id:'secondSource',label:t('vulnerabilities.products.col.secondSource'),mono:true,align:'end',sort:{first:'desc'},cell:(product:Product)=>formatNumber(locale,product.secondSourceCount)} satisfies DataColumn<Product>]:[]),
  {id:'updated',label:t('vulnerabilities.products.col.updated'),sort:{first:'desc'},cell:product=><span className="sdx-muted-cell">{product.syncedAt===null?never:exactTime(product.syncedAt,locale)}</span>},
 ];
 return page(<>
  <Card title={t('vulnerabilities.settings.title')} icon={ShieldAlert} iconTone="accent" meta={t('vulnerabilities.settings.lead')} id="sdx-vuln-settings">
   <form className="sdx-form-grid" noValidate onSubmit={event=>void submit(event)}>
    <Switch label={t('vulnerabilities.settings.enable')} hint={t('vulnerabilities.settings.enableHint')} checked={current.enabled} blocked={saving?t('kit.busy'):undefined} onChange={enabled=>change({enabled})}/>
    <Switch label={t('vulnerabilities.settings.secondSource')} hint={t('vulnerabilities.settings.secondSourceHint')} checked={current.secondSource} blocked={saving?t('kit.busy'):undefined} onChange={secondSource=>change({secondSource})}/>
    <Field label={t('vulnerabilities.settings.apiKey')} error={keyError?t('vulnerabilities.settings.apiKeyInvalid'):undefined}
     hint={<>{t('vulnerabilities.settings.apiKeyHint')} <a href={nvdKeyRequestUrl} target="_blank" rel="noopener noreferrer">{t('vulnerabilities.settings.apiKeyLink')}<ExternalLink size={11} aria-hidden/></a></>}>
     <input type="password" autoComplete="off" spellCheck={false} placeholder={t('vulnerabilities.settings.apiKeyPlaceholder')} value={current.apiKey} disabled={saving||current.removeKey} onChange={event=>change({apiKey:event.target.value})}/>
    </Field>
    {view.apiKeySet&&<p className="sdx-vuln-key-saved"><KeyRound size={14} aria-hidden/>{t(current.removeKey?'vulnerabilities.settings.apiKeyRemoving':'vulnerabilities.settings.apiKeySaved')}{!current.removeKey&&<Btn variant="ghost" size="sm" blocked={locked??(saving?t('kit.busy'):undefined)} onClick={()=>change({removeKey:true,apiKey:''})}>{t('vulnerabilities.settings.removeKey')}</Btn>}</p>}
    <p className="sdx-vuln-privacy">{t('vulnerabilities.settings.privacy')}</p>
    <FormActions dirty={dirty} busy={saving} loading={saving} blocked={locked} onDiscard={()=>{setForm(baseline);setSubmitted(false);setKeyRejected(false);}}/>
   </form>
  </Card>
  <Card title={t('vulnerabilities.status.title')} icon={RefreshCw} iconTone={sync.state==='failed'?'danger':'accent'} meta={t('vulnerabilities.status.meta')} id="sdx-vuln-status" flush
   actions={<Btn icon={RefreshCw} loading={checking} blocked={checkBlocked} onClick={()=>void checkNow()}>{t('vulnerabilities.checkNow')}</Btn>}>
   <div className="sdx-vuln-status">
    <div className="sdx-vuln-state" aria-live="polite"><StatusPill kind={stateKind[sync.state]} size="lg">{t(stateKey[sync.state])}</StatusPill></div>
    {sync.state==='failed'&&sync.lastError&&<Notice tone="danger" icon={AlertTriangle}>{serverMessageText(sync.lastError,t)}</Notice>}
    {secondSource.enabled&&secondSource.state==='failed'&&secondSource.lastError&&<Notice tone="danger" icon={AlertTriangle}>{serverMessageText(secondSource.lastError,t)}</Notice>}
    <Facts columns={2} items={[
     {id:'lastSuccess',label:t('vulnerabilities.status.lastSuccess'),value:sync.lastSuccessAt===null?never:exactTime(sync.lastSuccessAt,locale)},
     ...(secondSource.enabled?[{id:'secondSource',label:t('vulnerabilities.status.secondSourceSuccess'),value:secondSource.lastSuccessAt===null?never:exactTime(secondSource.lastSuccessAt,locale)}]:[]),
     {id:'nextCheck',label:t('vulnerabilities.status.nextCheck'),value:nextCheck},
     {id:'catalog',label:t('vulnerabilities.status.catalogChecked'),value:formatDate(locale,view.catalogCheckedAt+'T00:00:00Z',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'})},
    ]}/>
   </div>
   <DataTable<Product> columns={columns} rows={products} rowKey={product=>product.id} label={t('vulnerabilities.products.caption')} variant="flush" cards sort={sort} onSort={next=>setSort(next as TableSort<ProductColumn>)}
    empty={{icon:Package,title:t('vulnerabilities.products.caption')}}/>
   <div className="sdx-vuln-notice-foot"><p>{t('vulnerabilities.nvdNotice')}</p>{secondSource.enabled&&<p>{t('vulnerabilities.cveNotice')}</p>}</div>
  </Card>
 </>);
}
