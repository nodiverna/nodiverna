// The rules of the Branding page (ui/settings/branding-page.tsx, docs/branding.md). Pure: labels, facts,
// the client size check and the fallback that a removal leaves, from the manage state of the API.
import {productName} from '@/lib/brand';
import {brandingBackgrounds,brandingByteLimit,brandingFileFits,brandingTooLargeKey,bundledBackgroundUrl,isBrandingBackgroundSlot,type BrandingAssetView,type BrandingBackgroundChoice,type BrandingBackgroundSlot,type BrandingBackgroundState,type BrandingBackgroundView,type BrandingConsoleBackgroundState,type BrandingContentType,type BrandingLogoPair,type BrandingManageView,type BrandingSlot,type BrandSchemeColors} from '@/lib/branding';
import type {BackdropMeasure} from '@/lib/backdrop';
import {deriveBrandScheme,type BrandSchemeResult} from '@/lib/brand-scheme';
import {formatBytes,formatPercent,formatRatio} from '@/lib/i18n/format';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import type {Locale} from '@/lib/i18n/locale';
import {brandSuggestion} from '@/ui/settings/brand-colors-model';

/** The target of an upload or removal: the portal or one customer, and the slot. */
export type BrandingTarget={customerId:string|null;slot:BrandingSlot};
export const targetKey=({customerId,slot}:BrandingTarget)=>`${customerId??'portal'}:${slot}`;
export const targetPath=({customerId,slot}:BrandingTarget)=>customerId===null?`/api/branding/portal/${slot}`:`/api/branding/customer/${encodeURIComponent(customerId)}/${slot}`;

const formatNames:Record<BrandingContentType,string>={'image/png':'PNG','image/webp':'WebP','image/jpeg':'JPEG','image/svg+xml':'SVG'};
export const formatName=(type:BrandingContentType)=>formatNames[type];

/** The facts line of a stored image: format, pixel size and file size; SVG says scalable. */
export function brandingFacts(asset:BrandingAssetView,locale:Locale):string{
 const size=formatBytes(locale,asset.size);
 return asset.contentType==='image/svg+xml'?translate(locale,'branding.facts.vector',{size}):translate(locale,'branding.facts.raster',{format:formatName(asset.contentType),width:asset.width,height:asset.height,size});
}

const actionKeys:Record<BrandingSlot,{upload:MessageKey;replace:MessageKey;remove:MessageKey}>={
 light:{upload:'branding.uploadLight',replace:'branding.replaceLight',remove:'branding.removeLight'},
 dark:{upload:'branding.uploadDark',replace:'branding.replaceDark',remove:'branding.removeDark'},
 icon:{upload:'branding.uploadIcon',replace:'branding.replaceIcon',remove:'branding.removeIcon'},
 signin:{upload:'branding.uploadBackground',replace:'branding.replaceBackground',remove:'branding.removeBackground'},
 console:{upload:'branding.uploadBackground',replace:'branding.replaceBackground',remove:'branding.removeBackground'},
};
const slotLabels:Record<BrandingSlot,MessageKey>={light:'branding.slot.light',dark:'branding.slot.dark',icon:'branding.icon.title',signin:'branding.target.signin',console:'branding.target.console'};
/** "Upload light logo…" while the slot is empty, "Replace light logo…" once it is set. */
export const uploadLabelKey=(slot:BrandingSlot,set:boolean):MessageKey=>set?actionKeys[slot].replace:actionKeys[slot].upload;
export const removeLabelKey=(slot:BrandingSlot):MessageKey=>actionKeys[slot].remove;
export const slotLabelKey=(slot:BrandingSlot):MessageKey=>slotLabels[slot];

/**
 * The client check before an upload: null when the file fits the slot, else the text of the 413 key of the slot.
 * The server checks the same limit again and everything else.
 */
export function brandingFileProblem(slot:BrandingSlot,size:number,locale:Locale):string|null{
 return brandingFileFits(slot,size)?null:translate(locale,brandingTooLargeKey(slot) as MessageKey);
}
const rulesKeys:Record<BrandingSlot,MessageKey>={light:'branding.rules.logoLight',dark:'branding.rules.logo',icon:'branding.rules.icon',signin:'branding.rules.background',console:'branding.rules.background'};
/** The limits line of a slot in plain words: the formats and the size limit; the light logo also says that emails use it. */
export const brandingRulesText=(slot:BrandingSlot,locale:Locale)=>translate(locale,rulesKeys[slot],{max:formatBytes(locale,brandingByteLimit(slot))});
/** The limits line of a customer logo: the logo limits without the email sentence. */
export const customerRulesText=(locale:Locale)=>brandingRulesText('dark',locale);

/** The format of the light logo when emails cannot show it (WebP or SVG); null without a light logo or for PNG and JPEG. */
export function emailNoticeFormat(portal:BrandingLogoPair):string|null{
 const type=portal.light?.contentType;
 return type==='image/webp'||type==='image/svg+xml'?formatName(type):null;
}

const other=(slot:'light'|'dark')=>slot==='light'?'dark':'light';
/** The row label of a portal slot: "Logo for the light appearance", "Logo for the dark appearance", "Browser tab icon". */
export const portalRowLabelKey=(slot:'light'|'dark'|'icon'):MessageKey=>slot==='icon'?'branding.icon.title':slot==='light'?'branding.logo.light':'branding.logo.dark';
/** The logo an appearance shows: its own image, else the image of the other appearance, else null (the Nodiverna mark). */
export const shownLogo=(pair:BrandingLogoPair,appearance:'light'|'dark'):BrandingAssetView|null=>pair[appearance]??pair[other(appearance)];
/** The sentence of an empty portal slot: what shows in its place (the other logo, else the Nodiverna logo; the Nodiverna icon). */
export function emptySlotKey(portal:BrandingLogoPair,slot:'light'|'dark'|'icon'):MessageKey{
 if(slot==='icon')return 'branding.icon.showsProduct';
 if(!portal[other(slot)])return 'branding.logo.showsProduct';
 return slot==='light'?'branding.logo.showsDark':'branding.logo.showsLight';
}
/** The state line of a portal slot: the facts of its image, or the sentence of the empty slot. */
export function slotStateText(portal:BrandingLogoPair&{icon:BrandingAssetView|null},slot:'light'|'dark'|'icon',locale:Locale):string{
 const asset=portal[slot];
 return asset?brandingFacts(asset,locale):translate(locale,emptySlotKey(portal,slot),{product:productName});
}
/** The state tag of a setting: "Custom" while it differs from the default, else "Default". */
export const stateKey=(custom:boolean):MessageKey=>custom?'branding.state.custom':'branding.state.default';
/** An area is custom while it shows a background (its choice is not none). */
export const backgroundCustom=(state:Pick<BrandingBackgroundState,'choice'>)=>state.choice!=='none';
const hasLogo=(pair:BrandingLogoPair|undefined)=>!!pair&&(!!pair.light||!!pair.dark);
/**
 * What shows in place of an image after its removal: the other appearance of the same owner, for a customer the
 * portal logo, else the Nodiverna logo; for the icon the Nodiverna icon.
 */
export function removalFallback(view:Pick<BrandingManageView,'portal'|'customers'>&Partial<Pick<BrandingManageView,'backgrounds'>>,target:BrandingTarget,locale:Locale):string{
 if(target.slot==='icon')return translate(locale,'branding.confirm.iconText',{product:productName});
 // A background: shown now (the upload is the choice of its area), or only stored.
 if(isBrandingBackgroundSlot(target.slot))return translate(locale,view.backgrounds?.[target.slot].choice==='upload'?'branding.confirm.backgroundShownText':'branding.confirm.backgroundStoredText');
 const slot=target.slot,pair:BrandingLogoPair|undefined=target.customerId===null?view.portal:view.customers.find(customer=>customer.id===target.customerId);
 if(pair?.[other(slot)])return translate(locale,'branding.confirm.fallbackOther',{slot:translate(locale,other(slot)==='light'?'branding.slot.lightInline':'branding.slot.darkInline')});
 if(target.customerId!==null&&hasLogo(view.portal))return translate(locale,'branding.confirm.fallbackPortal');
 return translate(locale,'branding.confirm.fallbackProduct',{product:productName});
}

/** The image of a target in the manage state, or null. */
export function targetAsset(view:BrandingManageView,target:BrandingTarget):BrandingAssetView|null{
 const slot=target.slot;
 if(isBrandingBackgroundSlot(slot))return target.customerId===null?view.backgrounds[slot].upload:null;
 if(target.customerId===null)return view.portal[slot];
 if(slot==='icon')return null;
 return view.customers.find(customer=>customer.id===target.customerId)?.[slot]??null;
}

/** After an icon change: every icon link of the page points at the favicon route with a new version, so the open tab changes at once. */
export function faviconHref(icon:BrandingAssetView|null,now:number):string{
 const version=icon?/[?&]v=([0-9a-f]+)/.exec(icon.url)?.[1]??String(now):String(now);
 return `/api/branding/favicon?v=${version}`;
}

/** One entry of a customer row menu: upload or replace per appearance, a separator, then the removals (blocked while empty or busy). */
export type CustomerMenuItem={id:string;action:'upload'|'remove';slot:'light'|'dark';label:string;danger:boolean;blocked?:string}|{id:'separator';separator:true};
export function customerMenuItems(customer:Pick<BrandingLogoPair,'light'|'dark'>,busy:boolean,locale:Locale):CustomerMenuItem[]{
 const waiting=busy?translate(locale,'branding.busy'):undefined;
 const upload=(slot:'light'|'dark'):CustomerMenuItem=>({id:'upload-'+slot,action:'upload',slot,label:translate(locale,uploadLabelKey(slot,!!customer[slot])),danger:false,blocked:waiting});
 const remove=(slot:'light'|'dark'):CustomerMenuItem=>({id:'remove-'+slot,action:'remove',slot,label:translate(locale,removeLabelKey(slot)),danger:true,blocked:!customer[slot]?translate(locale,'branding.customers.noLogo'):waiting});
 return [upload('light'),upload('dark'),{id:'separator',separator:true},remove('light'),remove('dark')];
}

// ---- Backgrounds ----

/** One tile of a background picker: None, a bundled background, or Own image (with its stored upload, if any). */
export type BackgroundTile={choice:BrandingBackgroundChoice;label:MessageKey;url:string|null};
/** The tiles of an area in picker order: None, the six bundled backgrounds, Own image. */
export function backgroundTiles(state:BrandingBackgroundState):BackgroundTile[]{
 return [
  {choice:'none',label:'branding.background.none',url:null},
  ...brandingBackgrounds.map((background):BackgroundTile=>({choice:background.id,label:background.label,url:bundledBackgroundUrl(background.id)})),
  {choice:'upload',label:'branding.background.upload',url:state.upload?.url??null},
 ];
}
/** What the area shows for its choice, as the card preview draws it: null for none and for an upload choice without its image. */
export function shownBackground(state:BrandingBackgroundState):BrandingBackgroundView|null{
 if(state.choice==='none')return null;
 if(state.choice==='upload')return state.upload?{kind:'upload',url:state.upload.url,width:state.upload.width,height:state.upload.height}:null;
 return {kind:'builtin',id:state.choice,url:bundledBackgroundUrl(state.choice)};
}
/** What choosing a tile does: nothing for the current choice, the file picker for Own image without an upload, else a save. */
export const tileAction=(state:BrandingBackgroundState,choice:BrandingBackgroundChoice):'select'|'upload'|'none'=>
 choice===state.choice?'none':choice==='upload'&&!state.upload?'upload':'select';
/** The toast after a choice: "Background turned off." for None, else "Background changed.". */
export const backgroundChangedKey=(choice:BrandingBackgroundChoice):MessageKey=>choice==='none'?'branding.background.turnedOff':'branding.background.changed';
/** The busy key of a choice request of an area. */
export const backgroundKey=(area:BrandingBackgroundSlot,choice:BrandingBackgroundChoice)=>`background:${area}:${choice}`;
/** The Console background card notes it when the portal shows a console background and the viewer turned it off. */
export const consoleOwnOff=(view:Pick<BrandingManageView,'backgrounds'>,ownOn:boolean)=>!ownOn&&shownBackground(view.backgrounds.console)!==null;

/**
 * The tile a key moves focus to in a manual-activation radiogroup: the arrows move (wrapping), Home and End jump; null
 * for any other key. Enter and Space select (the caller), because each selection saves.
 */
export function tileFocusStep(key:string,index:number,count:number):number|null{
 if(key==='ArrowRight'||key==='ArrowDown')return (index+1)%count;
 if(key==='ArrowLeft'||key==='ArrowUp')return (index-1+count)%count;
 if(key==='Home')return 0;
 if(key==='End')return count-1;
 return null;
}

// ---- Color scheme ----

/** The candidate preselected in the lead radiogroup: the applied primary when it is a candidate, else the first. */
export const preselectedCandidate=(candidates:readonly string[],scheme:BrandSchemeColors|null)=>Math.max(0,scheme?candidates.indexOf(scheme.primary):0);
/** The facts line of a derived scheme: the lowest ratio of the buttons, links and icons over both appearances. */
export function schemeContrastText(result:Extract<BrandSchemeResult,{ok:true}>,locale:Locale):string{
 const lowest=(key:'button'|'link'|'icon')=>formatRatio(locale,Math.min(result.light.contrast[key],result.dark.contrast[key]));
 return translate(locale,'branding.scheme.contrast',{button:lowest('button'),link:lowest('link'),icon:lowest('icon')});
}
/** The lines that say how far the lead color was adjusted for contrast, per appearance; none without an adjustment. */
export function schemeAdjustedLines(result:Extract<BrandSchemeResult,{ok:true}>,locale:Locale):string[]{
 return [
  ...(result.light.leadShift>0?[translate(locale,'branding.scheme.adjustedLight',{percent:formatPercent(locale,result.light.leadShift)})]:[]),
  ...(result.dark.leadShift>0?[translate(locale,'branding.scheme.adjustedDark',{percent:formatPercent(locale,result.dark.leadShift)})]:[]),
 ];
}
/** Whether a selection equals the stored scheme (Apply is blocked then). */
export const schemeApplied=(selection:BrandSchemeColors|null,stored:BrandSchemeColors|null)=>!!selection&&!!stored&&selection.primary===stored.primary&&selection.secondary===stored.secondary;
/** The custom properties of one preview frame: the derived --brand-<mode>-* values of its appearance, set on the frame only. */
export function previewProperties(result:Extract<BrandSchemeResult,{ok:true}>,mode:'light'|'dark'):Record<string,string>{
 const out:Record<string,string>={};
 for(const [name,value] of Object.entries(result[mode].values))if(value)out[`--brand-${mode}-${name}`]=value;
 return out;
}
/**
 * The candidate the Owner picked: the candidate list and the stored scheme it was picked for, and its index. A new
 * list, Apply and Reset drop the pick, so the selection goes back to the stored primary (or the first candidate).
 */
export type SchemePick={list:string;stored:string;index:number}|null;
/** The color selection of the page: the candidates, the selected one, its derived scheme, and whether it is stored or still a preview. */
export type SchemeSelection={candidates:readonly string[];
 /** The keys of the candidate list and of the stored scheme, for the next pick (schemePick). */
 listKey:string;storedKey:string;
 selected:number;suggestion:BrandSchemeColors|null;result:BrandSchemeResult|null;
 /** The selection equals the stored scheme (Apply is blocked). */
 applied:boolean;
 /** The Owner picked a candidate whose scheme is valid and not stored: the preview shows it before Apply. */
 pending:boolean};
const schemeKey=(scheme:BrandSchemeColors|null)=>scheme?`${scheme.primary}:${scheme.secondary}`:'';
/**
 * The selection for the candidates of the logo, the pick of the Owner and the stored scheme. Derived again on each
 * call (a few milliseconds), and always the same result as the server's check.
 */
export function schemeSelection(candidates:readonly string[],pick:SchemePick,stored:BrandSchemeColors|null):SchemeSelection{
 const listKey=candidates.join(','),storedKey=schemeKey(stored);
 const picked=!!pick&&pick.list===listKey&&pick.stored===storedKey&&pick.index>=0&&pick.index<candidates.length;
 const selected=picked&&pick?pick.index:preselectedCandidate(candidates,stored);
 const suggestion=brandSuggestion(candidates,selected),result=suggestion?deriveBrandScheme(suggestion):null,applied=schemeApplied(suggestion,stored);
 return {candidates,listKey,storedKey,selected,suggestion,result,applied,pending:picked&&!!result?.ok&&!applied};
}
/** The pick of a candidate of the current selection. */
export const schemePick=(selection:Pick<SchemeSelection,'listKey'|'storedKey'>,index:number):SchemePick=>({list:selection.listKey,stored:selection.storedKey,index});
/** The custom properties of the preview window for an unapplied selection: the derived --brand-* values of both appearances; none otherwise. */
export function pendingSchemeProperties(selection:Pick<SchemeSelection,'result'|'pending'>|null):Record<string,string>|undefined{
 const result=selection?.pending?selection.result:null;
 return result?.ok?{...previewProperties(result,'light'),...previewProperties(result,'dark')}:undefined;
}
/** The href of the brand stylesheet link (app/layout.tsx) with a new version, so the open page repaints after Apply or Reset. */
export const schemeStylesheetHref=(now:number)=>`/api/branding/scheme?v=${now}`;

// ---- Console background measurement ----

/** The version of a stored image: the ?v= of its URL (the first 16 hex digits of its sha256), or null. */
export const assetVersion=(asset:Pick<BrandingAssetView,'url'>|null):string|null=>asset?/[?&]v=([0-9a-f]{16})\b/.exec(asset.url)?.[1]??null:null;
/**
 * The console upload the page still has to measure (docs/branding.md): its URL, size and version while an upload
 * exists without a measurement, else null.
 */
export function pendingMeasurement(state:Pick<BrandingConsoleBackgroundState,'upload'|'measured'>):{url:string;width:number;height:number;version:string}|null{
 const upload=state.upload,version=assetVersion(upload);
 return upload&&version&&!state.measured?{url:upload.url,width:upload.width,height:upload.height,version}:null;
}
/** The state of the measurement feedback in the Console background card: running, failed, or nothing to show. */
export type MeasurementState={version:string;status:'running'|'failed'}|null;
/**
 * One measurement: reads the image, then sends the result only while `current(version)` still holds (no newer
 * upload, the page still open). Resolves with "sent", or "stale" when the result was dropped; rejects when reading or
 * sending fails.
 */
export async function runMeasurement<T>({version,read,send,current}:{version:string;read:()=>Promise<BackdropMeasure>;send:(measure:BackdropMeasure)=>Promise<T>;current:(version:string)=>boolean}):Promise<{status:'sent';result:T}|{status:'stale'}>{
 const measure=await read();
 if(!current(version))return {status:'stale'};
 const result=await send(measure);
 return current(version)?{status:'sent',result}:{status:'stale'};
}
/** The POST body of the action measureBackground. */
export const measureBody=(version:string,measure:BackdropMeasure)=>({action:'measureBackground',version,measure});

// ---- Preview ----

/** The page the preview shows: the sign-in page or the console. */
export type PreviewSurface=BrandingBackgroundSlot;
export type PreviewAppearance='light'|'dark';
/** The page a change of a slot belongs to: its own area for a background; null for the logos and the icon, which show on both. */
export const previewSurfaceFor=(slot:BrandingSlot):PreviewSurface|null=>isBrandingBackgroundSlot(slot)?slot:null;
/** The tab icon of the preview: the uploaded icon, else the Nodiverna icon. */
export const previewIconUrl=(icon:BrandingAssetView|null)=>icon?.url??'/favicon.svg';
