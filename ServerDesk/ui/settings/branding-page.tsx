'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Building2,Image as ImageIcon,Info,Trash2,Upload} from 'lucide-react';
import {toast} from 'sonner';
import {productName} from '@/lib/brand';
import {brandingAccept,isBrandingBackgroundSlot,type BrandingAssetView,type BrandingBackgroundChoice,type BrandingBackgroundSlot,type BrandingCustomerView,type BrandingManageView,type BrandingPortalView,type BrandSchemeColors} from '@/lib/branding';
import type {MessageKey} from '@/lib/i18n/translate';
import {consoleRouteHash} from '@/lib/console-route';
import {useLocale,useT} from '@/ui/base/locale';
import {api,credentialFetch,message,readApiJson} from '@/ui/base/api';
import {sortTableRows} from '@/ui/base/table-sort';
import {BrandMark} from '@/ui/kit/brand-mark';
import {Btn,Card,EntranceList,Menu,Notice,SettingsPage,StatusPill,type MenuEntry} from '@/ui/kit/kit';
import {DataTable,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {useEffectiveMode} from '@/ui/shell/color-scheme';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {backgroundChangedKey,backgroundKey,brandingFileProblem,brandingRulesText,consoleOwnOff,customerMenuItems,customerRulesText,emailNoticeFormat,faviconHref,measureBody,pendingMeasurement,portalRowLabelKey,previewIconUrl,previewSurfaceFor,removalFallback,removeLabelKey,runMeasurement,schemePick,schemeSelection,schemeStylesheetHref,shownLogo,slotLabelKey,slotStateText,targetAsset,targetKey,targetPath,uploadLabelKey,type BrandingTarget,type MeasurementState,type PreviewAppearance,type PreviewSurface,type SchemePick} from '@/ui/settings/branding-model';
import {BackgroundCard,readBackdropMeasure} from '@/ui/settings/branding-backgrounds';
import {BrandingPreview} from '@/ui/settings/branding-preview';
import {BrandingStateTag} from '@/ui/settings/branding-state-tag';
import {BrandSchemeCard,readLogoColors,type LogoColorsState} from '@/ui/settings/brand-scheme-card';
import '@/ui/kit/brand-logo.css';
import '@/ui/settings/branding.css';

// Settings › Branding (docs/branding.md). Global Owners only (the console's node rule).
// The focal point is the card Preview (branding-preview.tsx), the aside of the page: one browser window in miniature
// that shows the sign-in page or the console with every choice of the page, so the Owner sees what people will see.
// The cards follow in the order of what they affect, each with one plain description and a state tag (Default or
// Custom):
// - Logo and icon: one row per image (the logo for the light and for the dark appearance, the browser tab icon). A row
//   shows the image on the surface of its appearance, or what the portal shows in its place, the facts of a stored
//   image or the sentence of an empty slot, the limits, and Upload, or Replace and Remove.
// - Colors (brand-scheme-card.tsx): colors read from the logo in the browser, a sample of the derived scheme, Apply,
//   and Reset to default colors. The page holds the selection, so the preview shows it before Apply.
// - Sign-in page and Console (branding-backgrounds.tsx): the background of each area.
// - Customer logos, while Multiple customers is on: the table of the customers inside the card.
// One upload, removal, choice or color request runs at a time, and the other actions say why they wait. A failed
// upload to a portal slot says why in the row or card of that slot, until the next upload or removal. After a change
// the console data loads again, so the top bar shows the new logo at once; an icon change points the tab icon at its
// new version, and a color change the brand stylesheet link of app/layout.tsx.
// A console background upload without a measurement (after an upload, or one from before measurements existed) is
// measured in the browser and the result is sent with measureBackground (useConsoleMeasurement); the console then
// loads its new scrims.
const route='/api/branding/manage';
type CustomerColumn='name';
type PortalSlot='light'|'dark'|'icon';
/** The one branding request that runs: its key (a target, an area choice, or the scheme) and kind. */
type BusyAction={key:string;kind:'upload'|'remove'|'choice'|'scheme'|'clearScheme'};
/** Why the last upload to a portal slot failed: the key of its target and the message. */
export type UploadError={key:string;message:string}|null;

export type BrandingPageView={view:BrandingManageView|null;loadError:string;loading:boolean;
 /** The colors of the portal logo (BrandSchemeCard); "none" without a logo. */
 colors?:LogoColorsState;
 /** The viewer's own console background preference (the card Console notes when it is off). */
 consoleBackgroundOn?:boolean;
 /** The measurement of the console upload: running or failed; null shows nothing. */
 measurement?:MeasurementState;
 uploadError?:UploadError};
type Actions={busy:BusyAction|null;onUpload:(target:BrandingTarget)=>void;onRemove:(target:BrandingTarget)=>void;
 onChoose?:(area:BrandingBackgroundSlot,choice:BrandingBackgroundChoice)=>void;
 onApplyScheme?:(colors:BrandSchemeColors)=>void;onRemoveScheme?:()=>void;onRetryColors?:()=>void;onRetryMeasurement?:()=>void};
const noop=()=>{};

/** A preview image: a new image remounts (keyed by its URL) and fades in. */
const previewImage=(asset:BrandingAssetView,{className}:{className:string})=><img key={asset.url} className={`sdx-branding-fade ${className}`} src={asset.url} alt="" decoding="async" width={asset.width} height={asset.height}/>;

/** What an appearance shows at the top bar size on its own surface: its logo, else the other logo, else the Nodiverna mark and name. */
function LogoFrame({appearance,portal}:{appearance:PreviewAppearance;portal:BrandingPortalView}){
 const shown=shownLogo(portal,appearance);
 return <div className={`sdx-branding-frame sdx-branding-frame-${appearance}`} aria-hidden="true">
  {shown?previewImage(shown,{className:'sdx-branding-frame-logo'}):<span className="sdx-branding-placeholder sdx-branding-fade"><BrandMark size={16}/><span>{productName}</span></span>}
 </div>;
}
/** The tab icon at 32 and 16 px on the panel: the uploaded icon, else the Nodiverna icon. */
function IconFrame({icon}:{icon:BrandingAssetView|null}){
 const url=previewIconUrl(icon);
 return <div className="sdx-branding-frame sdx-branding-frame-icon" aria-hidden="true">
  <img key={`32:${url}`} className="sdx-branding-fade sdx-branding-icon-32" src={url} alt="" decoding="async" width={32} height={32}/>
  <img key={`16:${url}`} className="sdx-branding-fade sdx-branding-icon-16" src={url} alt="" decoding="async" width={16} height={16}/>
 </div>;
}

/**
 * One row of the card Logo and icon: the frame, the label with its state tag, the state line (the facts of the stored
 * image, or what shows in its place), the limits, Upload or Replace and Remove, and the error of a failed upload.
 */
function PortalRow({portal,slot,actions,error}:{portal:BrandingPortalView;slot:PortalSlot;actions:Actions;error?:string}){
 const t=useT(),[locale]=useLocale(),target:BrandingTarget={customerId:null,slot},key=targetKey(target),asset=portal[slot];
 const runs=(kind:BusyAction['kind'])=>actions.busy?.key===key&&actions.busy.kind===kind;
 const waiting=(kind:BusyAction['kind'])=>actions.busy&&!runs(kind)?t('branding.busy'):undefined;
 const headingId=`sdx-branding-portal-${slot}`,state=slotStateText(portal,slot,locale);
 return <li className="sdx-brand-row">
  {slot==='icon'?<IconFrame icon={portal.icon}/>:<LogoFrame appearance={slot} portal={portal}/>}
  <div className="sdx-brand-row-main">
   <div className="sdx-brand-row-text">
    <div className="sdx-brand-row-head"><h3 id={headingId} className="sdx-brand-label">{t(portalRowLabelKey(slot))}</h3><BrandingStateTag custom={!!asset}/></div>
    <p key={state} className="sdx-branding-facts sdx-branding-fade">{state}</p>
    <p className="sdx-brand-rules">{brandingRulesText(slot,locale)}</p>
   </div>
   <div className="sdx-branding-slot-actions">
    <Btn size="sm" icon={Upload} loading={runs('upload')} blocked={waiting('upload')} onClick={()=>actions.onUpload(target)}>{t(uploadLabelKey(slot,!!asset))}</Btn>
    {asset&&<Btn size="sm" variant="ghost" icon={Trash2} loading={runs('remove')} blocked={waiting('remove')} onClick={()=>actions.onRemove(target)}>{t(removeLabelKey(slot))}</Btn>}
   </div>
   {error&&<p className="sdx-field-error" role="alert">{error}</p>}
  </div>
 </li>;
}

/** A thumbnail of a customer logo (max 24 px high), or the muted "Portal logo" while the slot is empty. */
function CustomerThumb({asset}:{asset:BrandingAssetView|null}){
 const t=useT();
 return asset?previewImage(asset,{className:'sdx-branding-thumb'}):<span className="sdx-branding-uses-portal">{t('branding.customers.usesPortal')}</span>;
}

/** The view of the page for a given state (rendered by BrandingPage, and by the tests with stubbed state). */
export function BrandingPageBody({state,actions,onRetry,retrying=false}:{state:BrandingPageView;actions:Actions;onRetry:()=>void;retrying?:boolean}){
 const t=useT(),[locale]=useLocale(),mode=useEffectiveMode();
 const [sort,setSort]=useState<TableSort<CustomerColumn>|null>(null);
 // The preview: the shown page, the appearance (the console's own until the Owner switches) and the picked color.
 const [surface,setSurface]=useState<PreviewSurface>('signin'),[chosenAppearance,setAppearance]=useState<PreviewAppearance|null>(null),[pick,setPick]=useState<SchemePick>(null);
 const view=state.view,failed=view?'':state.loadError;
 const colors:LogoColorsState=state.colors??{status:view&&(view.portal.light||view.portal.dark)?'reading':'none'};
 const selection=schemeSelection(colors.status==='done'?colors.candidates:[],pick,view?.scheme??null);
 const errorOf=(slot:BrandingTarget['slot'])=>state.uploadError?.key===targetKey({customerId:null,slot})?state.uploadError.message:undefined;
 // A background change shows its page in the preview before the request starts; logos, the icon and colors show on both.
 const showPage=(target:BrandingTarget)=>{const next=target.customerId===null?previewSurfaceFor(target.slot):null;if(next)setSurface(next);};
 const backgroundActions={busy:actions.busy,
  onChoose:(area:BrandingBackgroundSlot,choice:BrandingBackgroundChoice)=>{setSurface(area);(actions.onChoose??noop)(area,choice);},
  onUpload:(target:BrandingTarget)=>{showPage(target);actions.onUpload(target);},
  onRemove:(target:BrandingTarget)=>{showPage(target);actions.onRemove(target);}};
 function customerTable(customers:BrandingCustomerView[]){
  const rows=sortTableRows(customers,sort,{name:customer=>customer.name});
  const menu=(customer:BrandingCustomerView):MenuEntry[]=>customerMenuItems(customer,!!actions.busy,locale).map(item=>'separator' in item?item
   :{id:item.id,label:item.label,icon:item.action==='upload'?Upload:Trash2,danger:item.danger,blocked:item.blocked,onSelect:()=>(item.action==='upload'?actions.onUpload:actions.onRemove)({customerId:customer.id,slot:item.slot})});
  const columns:DataColumn<BrandingCustomerView>[]=[
   {id:'name',label:t('branding.customers.column.customer'),primary:true,sort:{first:'asc'},cell:customer=><span className="sdx-branding-customer"><strong>{customer.name}</strong>
    {customer.status==='disabled'&&<StatusPill kind="neutral" size="sm">{t('fleet.disabled')}</StatusPill>}</span>},
   {id:'light',label:t('branding.slot.light'),cell:customer=><CustomerThumb asset={customer.light}/>},
   {id:'dark',label:t('branding.slot.dark'),cell:customer=><CustomerThumb asset={customer.dark}/>},
   {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:customer=><Menu label={t('customers.menu.label',{name:customer.name})}
    entries={()=>menu(customer)}/>},
  ];
  return <DataTable<BrandingCustomerView> columns={columns} rows={rows} rowKey={customer=>customer.id} label={t('branding.customers.title')} cards variant="flush" entranceId="settings-branding-customers"
   sort={sort} onSort={next=>setSort(next as TableSort<CustomerColumn>)} foot={t('branding.customers.foot',{count:customers.length})}
   empty={{icon:Building2,title:t('branding.customers.emptyTitle'),children:t('branding.customers.emptyText'),action:<Btn size="sm" icon={Building2} onClick={()=>{window.location.hash=consoleRouteHash({view:'settings',page:'customers'});}}>{t('branding.customers.open')}</Btn>}}/>;
 }
 const email=view?emailNoticeFormat(view.portal):null;
 const preview=view&&<EntranceList id="settings-branding-preview">
  <div key="preview"><BrandingPreview view={view} surface={surface} appearance={chosenAppearance??mode} onSurface={setSurface} onAppearance={setAppearance} selection={selection}/></div>
 </EntranceList>;
 return <SettingsPage label={t('nav.settings.branding')} loading={state.loading&&!view&&!failed} loadError={failed||undefined} onRetry={onRetry} retrying={retrying} aside={preview}>
  {view&&<EntranceList id="settings-branding" className="sdx-branding-cards">
   <Card title={t('branding.portal.title')} description={t('branding.portal.description',{product:productName})} icon={ImageIcon} iconTone="accent" id="sdx-branding-portal">
    {email&&<Notice tone="info" icon={Info}>{t('branding.emailNotice',{format:email})}</Notice>}
    <ul className="sdx-brand-rows">
     {(['light','dark','icon'] as const).map(slot=><PortalRow key={slot} portal={view.portal} slot={slot} actions={actions} error={errorOf(slot)}/>)}
    </ul>
   </Card>
   <BrandSchemeCard colors={colors} scheme={view.scheme} selection={selection} onPick={index=>setPick(schemePick(selection,index))}
    actions={{busy:actions.busy,onUploadLight:()=>actions.onUpload({customerId:null,slot:'light'}),onRetryColors:actions.onRetryColors??noop,onApply:actions.onApplyScheme??noop,onRemove:actions.onRemoveScheme??noop}}/>
   <BackgroundCard area="signin" state={view.backgrounds.signin} actions={backgroundActions} error={errorOf('signin')}/>
   <BackgroundCard area="console" state={view.backgrounds.console} actions={backgroundActions} error={errorOf('console')} ownOff={consoleOwnOff(view,state.consoleBackgroundOn??true)}
    measurement={state.measurement??null} onRetryMeasurement={actions.onRetryMeasurement}/>
   {view.multipleCustomers&&<Card flush title={t('branding.customers.title')} description={t('branding.customers.description')} meta={customerRulesText(locale)} icon={Building2} iconTone="accent" id="sdx-branding-customers">
    {customerTable(view.customers)}
   </Card>}
  </EntranceList>}
 </SettingsPage>;
}

/** Points every tab icon link of the page at the favicon route with a new version, so the open tab changes at once. */
function refreshFavicon(icon:BrandingAssetView|null){
 const href=faviconHref(icon,Date.now());
 for(const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))link.href=href;
}

/** Points the brand stylesheet link (app/layout.tsx) at a new version, so the open page repaints in the new colors. */
function refreshSchemeStylesheet(){
 for(const link of document.querySelectorAll<HTMLLinkElement>('link[data-brand-scheme]'))link.href=schemeStylesheetHref(Date.now());
}
const postJson=(body:unknown)=>credentialFetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'});
/** The success toast of an upload or a removal, by slot. */
function assetToast(slot:BrandingTarget['slot'],kind:'upload'|'remove'):MessageKey{
 if(slot==='icon')return kind==='upload'?'branding.iconUploaded':'branding.iconRemoved';
 if(isBrandingBackgroundSlot(slot))return kind==='upload'?'branding.background.uploaded':'branding.background.removed';
 return kind==='upload'?'branding.uploaded':'branding.removed';
}

/** The colors of the portal logo (light, else dark), read in the browser; a retry reads again. */
function useLogoColors(url:string|null):{colors:LogoColorsState;retry:()=>void}{
 const [attempt,setAttempt]=useState(0),[read,setRead]=useState<{url:string;attempt:number;colors:LogoColorsState}|null>(null);
 useEffect(()=>{
  if(!url)return;
  let live=true;
  void readLogoColors(url).then(candidates=>{if(live)setRead({url,attempt,colors:{status:'done',candidates}});},()=>{if(live)setRead({url,attempt,colors:{status:'failed'}});});
  return ()=>{live=false;};
 },[url,attempt]);
 const colors:LogoColorsState=!url?{status:'none'}:read&&read.url===url&&read.attempt===attempt?read.colors:{status:'reading'};
 return {colors,retry:()=>setAttempt(value=>value+1)};
}

/**
 * Measures the console upload while it has no measurement and sends the result (runMeasurement in branding-model.ts).
 * A newer upload or closing the page cancels a running measurement: its result is not sent. A retry measures again.
 */
function useConsoleMeasurement(view:BrandingManageView|null,apply:(next:BrandingManageView)=>void,onChanged:(()=>Promise<void>|void)|undefined):{state:MeasurementState;retry:()=>void}{
 const pending=view?pendingMeasurement(view.backgrounds.console):null;
 const [attempt,setAttempt]=useState(0),[failed,setFailed]=useState<{version:string;attempt:number}|null>(null);
 const changed=useRef(onChanged),applied=useRef(apply);
 useEffect(()=>{changed.current=onChanged;applied.current=apply;});
 const version=pending?.version??null,url=pending?.url??null,width=pending?.width??0,height=pending?.height??0;
 useEffect(()=>{
  if(!version||!url)return;
  let live=true;
  void runMeasurement({version,current:()=>live,read:()=>readBackdropMeasure(url,width,height),
   send:async measure=>readApiJson<BrandingManageView>(await postJson(measureBody(version,measure)))})
   .then(outcome=>{if(outcome.status==='sent'){applied.current(outcome.result);void changed.current?.();}},
    ()=>{if(live)setFailed({version,attempt});});
  return ()=>{live=false;};
 },[version,url,width,height,attempt]);
 const state:MeasurementState=version?{version,status:failed?.version===version&&failed.attempt===attempt?'failed':'running'}:null;
 return {state,retry:()=>setAttempt(value=>value+1)};
}

/** Settings › Branding; the page header of the console frame at its top (ui/shell/page-frame.ts). */
export default function BrandingPage({frame,onChanged,consoleBackgroundOn=true}:{frame?:PageFrame;onChanged?:()=>Promise<void>|void;consoleBackgroundOn?:boolean}){
 const t=useT(),[locale]=useLocale();
 const [view,setView]=useState<BrandingManageView|null>(null),[loadError,setLoadError]=useState(''),[retrying,setRetrying]=useState(false);
 const [busy,setBusy]=useState<BusyAction|null>(null),[removal,setRemoval]=useState<BrandingTarget|null>(null),[schemeRemoval,setSchemeRemoval]=useState(false);
 const [uploadError,setUploadError]=useState<UploadError>(null);
 const logo=view?view.portal.light??view.portal.dark:null,{colors,retry:retryColors}=useLogoColors(logo?.url??null);
 const input=useRef<HTMLInputElement>(null),chosenTarget=useRef<BrandingTarget|null>(null),running=useRef(false),mounted=useRef(false);
 const load=useCallback(async()=>{
  try{const next=await api<BrandingManageView>(route);if(mounted.current){setView(next);setLoadError('');}}
  catch(e){if(mounted.current)setLoadError(message(e));}
 },[]);
 const measurement=useConsoleMeasurement(view,next=>{if(mounted.current)setView(next);},onChanged);
 useEffect(()=>{mounted.current=true;void Promise.resolve().then(load);return ()=>{mounted.current=false;};},[load]);
 useFrameRefresh(frame,()=>{void load();});
 const retry=async()=>{setRetrying(true);try{await load();}finally{if(mounted.current)setRetrying(false);}};
 // One request at a time: the state of its answer, the toast, then the tab icon, the stylesheet and the console data.
 // A failure is a toast, unless the caller shows it in place (a portal upload).
 const request=async(action:BusyAction,send:()=>Promise<Response>,success:MessageKey,after?:(next:BrandingManageView)=>void,onFailure:(text:string)=>void=text=>{toast.error(text);})=>{
  if(running.current)return;running.current=true;setBusy(action);
  try{
   const next=await readApiJson<BrandingManageView>(await send());
   if(mounted.current)setView(next);
   toast.success(t(success));
   after?.(next);
   void onChanged?.();
  }catch(e){onFailure(message(e));}
  finally{running.current=false;if(mounted.current)setBusy(null);}
 };
 // A portal upload says why it failed in its row or card; the message goes when the next portal upload or removal starts.
 const failInPlace=(target:BrandingTarget)=>(text:string)=>{if(mounted.current)setUploadError({key:targetKey(target),message:text});};
 const run=(target:BrandingTarget,kind:'upload'|'remove',send:()=>Promise<Response>)=>{
  const portal=target.customerId===null;
  if(portal&&!running.current)setUploadError(null);
  return request({key:targetKey(target),kind},send,assetToast(target.slot,kind),next=>{if(target.slot==='icon')refreshFavicon(next.portal.icon);},portal&&kind==='upload'?failInPlace(target):undefined);
 };
 const choose=(area:BrandingBackgroundSlot,choice:BrandingBackgroundChoice)=>void request({key:backgroundKey(area,choice),kind:'choice'},()=>postJson({action:'setBackground',area,choice}),backgroundChangedKey(choice));
 const applyScheme=(colors:BrandSchemeColors)=>void request({key:'scheme',kind:'scheme'},()=>postJson({action:'setScheme',...colors}),'branding.scheme.applied',refreshSchemeStylesheet);
 const confirmSchemeRemoval=()=>{setSchemeRemoval(false);void request({key:'scheme',kind:'clearScheme'},()=>postJson({action:'clearScheme'}),'branding.scheme.removed',refreshSchemeStylesheet);};
 const pickFile=(target:BrandingTarget)=>{if(running.current)return;chosenTarget.current=target;input.current?.click();};
 const picked=(file:File|undefined)=>{
  const target=chosenTarget.current;chosenTarget.current=null;
  // The same file can be chosen again.
  if(input.current)input.current.value='';
  if(!file||!target)return;
  const problem=brandingFileProblem(target.slot,file.size,locale);
  if(problem){if(target.customerId===null)failInPlace(target)(problem);else toast.error(problem);return;}
  void run(target,'upload',()=>credentialFetch(targetPath(target),{method:'PUT',headers:{'Content-Type':file.type||'application/octet-stream'},body:file,cache:'no-store'}));
 };
 const confirmRemoval=()=>{const target=removal;setRemoval(null);if(target)void run(target,'remove',()=>credentialFetch(targetPath(target),{method:'DELETE',cache:'no-store'}));};
 const customer=removal?.customerId?view?.customers.find(item=>item.id===removal.customerId):undefined;
 const background=removal?isBrandingBackgroundSlot(removal.slot):false;
 const lines=removal&&!background?[{label:t('branding.confirm.slot'),value:t(slotLabelKey(removal.slot))},...(customer?[{label:t('branding.confirm.customer'),value:customer.name}]:[])]:[];
 const removalTitle:MessageKey=removal?.slot==='icon'?'branding.confirm.removeIconTitle':background?'branding.confirm.removeBackgroundTitle':'branding.confirm.removeLogoTitle';
 const removalVerb:MessageKey=removal?.slot==='icon'?'branding.confirm.removeIcon':background?'branding.confirm.removeImage':'branding.confirm.removeLogo';
 return <>{frameHeader(frame)}
  <BrandingPageBody state={{view,loadError,loading:!view,colors,consoleBackgroundOn,measurement:measurement.state,uploadError}} onRetry={()=>void retry()} retrying={retrying}
   actions={{busy,onUpload:pickFile,onRemove:target=>{if(view&&targetAsset(view,target))setRemoval(target);},onChoose:choose,onApplyScheme:applyScheme,
    onRemoveScheme:()=>{if(view?.scheme)setSchemeRemoval(true);},onRetryColors:retryColors,onRetryMeasurement:measurement.retry}}/>
  <input ref={input} type="file" accept={brandingAccept} hidden tabIndex={-1} aria-hidden="true" onChange={event=>picked(event.target.files?.[0])}/>
  <ConfirmDialog open={!!removal} onOpenChange={next=>{if(!next)setRemoval(null);}} tone="danger"
   title={t(removalTitle)} lines={lines}
   body={removal&&view?removalFallback(view,removal,locale):undefined}
   confirmLabel={t(removalVerb)} onConfirm={confirmRemoval}/>
  <ConfirmDialog open={schemeRemoval} onOpenChange={next=>{if(!next)setSchemeRemoval(false);}}
   title={t('branding.confirm.removeSchemeTitle')} body={t('branding.confirm.schemeText')}
   confirmLabel={t('branding.confirm.removeScheme')} onConfirm={confirmSchemeRemoval}/>
 </>;
}
