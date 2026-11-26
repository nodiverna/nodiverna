import {brandingAuditActions} from '../audit-actions';
import {backdropScrims,fallbackBackdropMeasure,isBackdropMeasure,type BackdropMeasure,type BackdropScrims} from '../backdrop';
import {brandingBackgrounds,brandingByteLimit,brandingExtension,brandingTooLargeKey,bundledBackgroundUrl,isBrandingBackgroundChoice,isBrandingBackgroundSlot,isBrandingLogoSlot,isBrandingSlot,type BrandingAssetView,type BrandingBackgroundChoice,type BrandingBackgroundSlot,type BrandingBackgroundView,type BrandingConsoleBackgroundState,type BrandingContentType,type BrandingCustomerView,type BrandingLogoPair,type BrandingManageView,type BrandingPortalView,type BrandingPublicView,type BrandingSlot,type BrandSchemeColors,type ConsoleBackgroundView,type ConsoleBranding} from '../branding';
import {createHash} from 'node:crypto';
import {brandSchemeCss,deriveBrandScheme,isBrandSchemeHex} from '../brand-scheme';
import {defaultCustomerId} from '../default-customer';
import type {Viewer} from '../types';
import {auditAfterChange} from './audit';
import {checkBrandingImage,emailLogoUrl} from './branding-image';
import {config,guid,HttpError,now} from './context';
import {brandingAssetPolicy} from './csp';
import {db,sql,type Sql} from './db';
import {principal} from './identity/access';
import {visibleCustomers} from './identity/customers';
import {multipleCustomersSetting} from './identity/multiple-customers';
import {can,viewerCanSql} from './identity/policy/can';
import {commitWithAudit} from './security-commit';

// The branding images (docs/branding.md): the portal logo for the light and
// the dark appearance, the browser tab icon, the backgrounds of the sign-in
// page and the console, and a logo per customer other than the default
// customer; and the portal choices of branding_settings (the background of
// each area and the brand color scheme). All SQL of both tables is here; the
// upload checks are in branding-image.ts, the scheme in lib/brand-scheme.ts. Only a global Owner changes an
// image, without an MFA step-up (lib/step-up.ts: an image cannot run code,
// open access or weaken security); the write and its audit row commit in one
// batch behind the live Owner right. The portal images are public, because
// the sign-in page and the favicon show them before any session exists.
// The console background upload also holds its measurement (lib/backdrop.ts):
// the Owner's browser measures the blurred image and sends the range with the
// action measureBackground; the console scrims follow from it.

/** Where an image belongs: the portal (null) or a customer. */
export type BrandingOwner={customerId:string|null};
type AssetRow={customer_id:string|null;slot:string;content_type:string;size:number|string;width:number|string;height:number|string;sha256:string;updated_at:number|string;
 measure_light_low:string|null;measure_light_high:string|null;measure_dark_low:string|null;measure_dark_high:string|null};
/** A stored image; `data` is null when the request already holds these bytes (If-None-Match), so no read was needed. */
export type BrandingAsset={contentType:BrandingContentType;data:Uint8Array|null;sha256:string;slot:BrandingSlot};

const ownerKey=(customerId:string|null)=>customerId??'';
const version=(sha256:string)=>sha256.slice(0,16);
const notFound=()=>new HttpError('apiError.generic.notFound');
const metaColumns=sql`customer_id,slot,content_type,size,width,height,sha256,updated_at,measure_light_low,measure_light_high,measure_dark_low,measure_dark_high`;

function assetUrl(customerId:string|null,slot:BrandingSlot,sha256:string){
 return customerId===null?`/api/branding/portal/${slot}?v=${version(sha256)}`:`/api/branding/customer/${customerId}/${slot}?v=${version(sha256)}`;
}
function assetView(row:AssetRow|undefined):BrandingAssetView|null{
 if(!row)return null;
 return {url:assetUrl(row.customer_id,row.slot as BrandingSlot,row.sha256),contentType:row.content_type as BrandingContentType,width:Number(row.width),height:Number(row.height),size:Number(row.size),updatedAt:Number(row.updated_at)};
}
const slotOf=(rows:AssetRow[],slot:BrandingSlot)=>assetView(rows.find(row=>row.slot===slot));
const pairOf=(rows:AssetRow[]):BrandingLogoPair=>({light:slotOf(rows,'light'),dark:slotOf(rows,'dark')});

const portalRows=()=>db().query<AssetRow>(sql`SELECT ${metaColumns} FROM branding_assets WHERE customer_id IS NULL`);
const portalOf=(rows:AssetRow[]):BrandingPortalView=>({...pairOf(rows),icon:slotOf(rows,'icon')});
/** The portal logos and the tab icon. */
export async function portalBranding():Promise<BrandingPortalView>{return portalOf(await portalRows());}

/** The stored choices: the background of each area and the brand scheme; the defaults without a row. */
export type BrandingSettings={signin:BrandingBackgroundChoice;console:BrandingBackgroundChoice;scheme:BrandSchemeColors|null};
type SettingsRow={signin_background:string;console_background:string;scheme_primary:string|null;scheme_secondary:string|null};
const choiceOf=(value:string|undefined):BrandingBackgroundChoice=>isBrandingBackgroundChoice(value)?value:'none';
export async function brandingSettings():Promise<BrandingSettings>{
 const row=await db().one<SettingsRow>(sql`SELECT signin_background,console_background,scheme_primary,scheme_secondary FROM branding_settings WHERE id=1`);
 const primary=row?.scheme_primary,secondary=row?.scheme_secondary;
 return {signin:choiceOf(row?.signin_background),console:choiceOf(row?.console_background),scheme:isBrandSchemeHex(primary)&&isBrandSchemeHex(secondary)?{primary,secondary}:null};
}
/** What an area shows: null for none, and for an upload choice without a stored image. */
function backgroundView(choice:BrandingBackgroundChoice,upload:BrandingAssetView|null):BrandingBackgroundView|null{
 if(choice==='none')return null;
 if(choice==='upload')return upload?{kind:'upload',url:upload.url,width:upload.width,height:upload.height}:null;
 const bundled=brandingBackgrounds.find(background=>background.id===choice);
 return bundled?{kind:'builtin',id:bundled.id,url:bundledBackgroundUrl(bundled.id)}:null;
}

/** The stored measurement of a console upload, or null while it has none. */
function storedMeasure(row:AssetRow|undefined):BackdropMeasure|null{
 if(!row)return null;
 const measure={light:{low:row.measure_light_low,high:row.measure_light_high},dark:{low:row.measure_dark_low,high:row.measure_dark_high}};
 return isBackdropMeasure(measure)?measure:null;
}
/**
 * The measurement behind the console scrims of a choice: the bundled value, the stored upload measurement, or the
 * fallback for any image (measured false); null for none and for an upload choice without its image.
 */
function consoleMeasure(choice:BrandingBackgroundChoice,rows:AssetRow[]):{measure:BackdropMeasure;measured:boolean}|null{
 if(choice==='none')return null;
 if(choice==='upload'){
  const row=rows.find(item=>item.slot==='console');
  if(!row)return null;
  const stored=storedMeasure(row);
  return stored?{measure:stored,measured:true}:{measure:fallbackBackdropMeasure,measured:false};
 }
 const bundled=brandingBackgrounds.find(background=>background.id===choice);
 return bundled?{measure:bundled.measure,measured:true}:null;
}
function consoleScrims(choice:BrandingBackgroundChoice,rows:AssetRow[],scheme:BrandSchemeColors|null):{scrim:BackdropScrims;measured:boolean}|null{
 const found=consoleMeasure(choice,rows);
 return found?{scrim:backdropScrims(found.measure,scheme),measured:found.measured}:null;
}
/** The console background of the console view: the image with the scrims of each mode and region. */
function consoleBackgroundView(settings:BrandingSettings,rows:AssetRow[]):ConsoleBackgroundView|null{
 const view=backgroundView(settings.console,slotOf(rows,'console')),scrims=consoleScrims(settings.console,rows,settings.scheme);
 return view&&scrims?{...view,...scrims}:null;
}
/** The Console background card: the choice, the upload, whether the upload is measured, and the scrims of the choice. */
function consoleBackgroundState(settings:BrandingSettings,rows:AssetRow[]):BrandingConsoleBackgroundState{
 const upload=rows.find(row=>row.slot==='console');
 return {choice:settings.console,upload:assetView(upload),measured:!!storedMeasure(upload),scrim:consoleScrims(settings.console,rows,settings.scheme)?.scrim??null};
}

/** GET /api/branding: the portal logos, the tab icon and the sign-in background. Public: no customer data and nothing about the console. */
export async function publicBranding():Promise<BrandingPublicView>{
 const [rows,settings]=await Promise.all([portalRows(),brandingSettings()]);
 return {portal:portalOf(rows),signinBackground:backgroundView(settings.signin,slotOf(rows,'signin'))};
}

export async function requireBrandingOwner(viewer:Viewer,fresh=false){if(!await can(viewer,'instance.owner',{fresh}))throw new HttpError('apiError.settings.ownerOnly');}

/**
 * GET /api/branding/manage: the portal slots, the setting Multiple customers, every customer other than the default
 * customer with its logos, the choice and the upload of each background area, and the brand scheme. Global Owners only.
 */
export async function brandingManage(viewer:Viewer):Promise<BrandingManageView>{
 await requireBrandingOwner(viewer);
 const [portalAssets,settings,setting,customers,rows]=await Promise.all([
  portalRows(),
  brandingSettings(),
  multipleCustomersSetting(),
  db().query<{id:string;name:string;status:string}>(sql`SELECT customer.id,customer.name,customer.status FROM customers customer WHERE customer.id<>${defaultCustomerId} ORDER BY lower(customer.name),customer.id`),
  db().query<AssetRow>(sql`SELECT ${metaColumns} FROM branding_assets WHERE customer_id IS NOT NULL`),
 ]);
 const list:BrandingCustomerView[]=customers.map(customer=>({id:customer.id,name:customer.name,status:customer.status==='disabled'?'disabled':'active',...pairOf(rows.filter(row=>row.customer_id===customer.id))}));
 return {portal:portalOf(portalAssets),multipleCustomers:setting.enabled,customers:list,scheme:settings.scheme,
  backgrounds:{signin:{choice:settings.signin,upload:slotOf(portalAssets,'signin')},console:consoleBackgroundState(settings,portalAssets)}};
}

/**
 * ConsoleData.branding: the portal slots and the logos of the customers the
 * viewer sees (every customer for a global Owner), only those with a logo,
 * the console background with its scrims (lib/backdrop.ts) and the brand
 * scheme. Without multiple customers
 * there are no customer logos.
 */
export async function consoleBranding({owner,visibleCustomerIds,multipleCustomers}:{owner:boolean;visibleCustomerIds:readonly string[];multipleCustomers:boolean}):Promise<ConsoleBranding>{
 const [portalAssets,settings]=await Promise.all([portalRows(),brandingSettings()]);
 const shared={portal:portalOf(portalAssets),consoleBackground:consoleBackgroundView(settings,portalAssets),scheme:settings.scheme};
 if(!multipleCustomers||!owner&&!visibleCustomerIds.length)return {...shared,customers:{}};
 const scope=owner?sql`customer_id IS NOT NULL`:sql`customer_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(visibleCustomerIds)}::jsonb))`;
 const rows=await db().query<AssetRow>(sql`SELECT ${metaColumns} FROM branding_assets WHERE ${scope} AND slot IN ('light','dark')`);
 const customers:Record<string,BrandingLogoPair>={};
 for(const id of new Set(rows.map(row=>row.customer_id!)))customers[id]=pairOf(rows.filter(row=>row.customer_id===id));
 return {...shared,customers};
}

/** The ETags an If-None-Match header names, without the weak prefix. */
const requestTags=(request:Request|undefined)=>(request?.headers.get('if-none-match')??'').split(',').map(value=>value.trim().replace(/^W\//,'')).filter(Boolean);

/**
 * One stored image. The bytes (up to 8 MiB) are read only when the request
 * does not already hold them: a matching If-None-Match gets the metadata
 * alone, so a revalidation of a public image costs no full read.
 */
async function readAsset(customerId:string|null,slot:BrandingSlot,request?:Request):Promise<BrandingAsset|null>{
 const tags=requestTags(request),hashes=tags.filter(tag=>/^"[0-9a-f]{64}"$/.test(tag)).map(tag=>tag.slice(1,-1));
 const row=await db().one<{content_type:string;sha256:string;hex:string|null}>(sql`SELECT content_type,sha256,CASE WHEN ${tags.includes('*')}::boolean OR sha256 IN (SELECT jsonb_array_elements_text(${JSON.stringify(hashes)}::jsonb)) THEN NULL ELSE encode(data,'hex') END AS hex FROM branding_assets WHERE COALESCE(customer_id,'')=${ownerKey(customerId)} AND slot=${slot}`);
 return row?{contentType:row.content_type as BrandingContentType,data:row.hex===null?null:new Uint8Array(Buffer.from(row.hex,'hex')),sha256:row.sha256,slot}:null;
}

/** A portal image (public). An unknown slot is answered like an empty one. */
export async function portalAsset(slot:unknown,request?:Request):Promise<BrandingAsset|null>{
 if(!isBrandingSlot(slot))return null;
 return readAsset(null,slot,request);
}

/**
 * A customer logo for a live viewer: the customer is one the viewer sees, or
 * the viewer is a global Owner (any customer, also a deactivated one). Any
 * other case is 404, so the answer does not show that the customer exists.
 */
export async function customerAsset(viewer:Viewer,customerId:unknown,slot:unknown,request?:Request):Promise<BrandingAsset>{
 if(typeof customerId!=='string'||!isBrandingLogoSlot(slot))throw notFound();
 const allowed=await can(viewer,'instance.owner')||(await visibleCustomers(viewer)).some(customer=>customer.id===customerId);
 const asset=allowed?await readAsset(customerId,slot,request):null;
 if(!asset)throw notFound();
 return asset;
}

/**
 * The response of an image. ETag is the sha256; a request with ?v= of the
 * current hash may keep it for a year (`visibility` public or private), any
 * other request revalidates. If-None-Match with the current ETag gives 304.
 * The own CSP sandboxes the file when a browser opens it directly.
 */
export function assetResponse(request:Request,asset:BrandingAsset,{visibility,revalidate=false}:{visibility:'public'|'private';revalidate?:boolean}):Response{
 const etag=`"${asset.sha256}"`,current=!revalidate&&new URL(request.url).searchParams.get('v')===version(asset.sha256);
 const headers:Record<string,string>={
  'Content-Type':asset.contentType,
  'X-Content-Type-Options':'nosniff',
  'Content-Disposition':`inline; filename="${asset.slot}.${brandingExtension[asset.contentType]}"`,
  'Content-Security-Policy':brandingAssetPolicy,
  ETag:etag,
  'Cache-Control':current?`${visibility}, max-age=31536000, immutable`:'no-cache',
 };
 const match=requestTags(request);
 if(!asset.data||match.includes(etag)||match.includes('*'))return new Response(null,{status:304,headers});
 return new Response(new Blob([asset.data as Uint8Array<ArrayBuffer>]),{headers});
}

/** The slot of a write: light, dark or icon for the portal, light or dark for a customer; anything else is 404. */
function writeSlot(owner:BrandingOwner,slot:unknown):BrandingSlot{
 if(owner.customerId===null?!isBrandingSlot(slot):!isBrandingLogoSlot(slot))throw notFound();
 return slot as BrandingSlot;
}
/** A customer that can have a logo: it exists (404) and is not the default customer (400). */
async function requireBrandableCustomer(customerId:string){
 if(customerId===defaultCustomerId)throw new HttpError('apiError.branding.defaultCustomer');
 const row=guid(customerId)?await db().one(sql`SELECT 1 AS present FROM customers WHERE id=${customerId}`):null;
 if(!row)throw new HttpError('apiError.customer.gone');
}
/** The guard of a write: the live Owner right and, for a customer, its row (not the default customer). */
function writeGuard(viewer:Viewer,owner:BrandingOwner):Sql{
 const right=viewerCanSql(viewer,'instance.owner');
 return owner.customerId===null?sql`(${right})`:sql`(${right}) AND EXISTS (SELECT 1 FROM customers brand_customer WHERE brand_customer.id=${owner.customerId} AND brand_customer.id<>${defaultCustomerId})`;
}
/** Origin, viewer, Owner, slot and customer of a write, in this order. */
export async function prepareBrandingWrite(viewer:Viewer,owner:BrandingOwner,slot:unknown):Promise<BrandingSlot>{
 await requireBrandingOwner(viewer);
 const checked=writeSlot(owner,slot);
 if(owner.customerId!==null)await requireBrandableCustomer(owner.customerId);
 return checked;
}

/**
 * The raw request body, at most the slot limit: a larger Content-Length or
 * stream gives the 413 key of the slot before more is read.
 */
export async function readBrandingBody(request:Request,slot:BrandingSlot):Promise<Uint8Array>{
 const limit=brandingByteLimit(slot),tooLarge=()=>new HttpError(brandingTooLargeKey(slot));
 const declared=request.headers.get('content-length');
 if(declared!==null&&!(Number(declared)<=limit))throw tooLarge();
 const chunks:Uint8Array[]=[],reader=request.body?.getReader();let length=0;
 if(reader){
  try{
   for(;;){
    const chunk=await reader.read();if(chunk.done)break;
    length+=chunk.value.byteLength;
    if(length>limit){await reader.cancel();throw tooLarge();}
    chunks.push(chunk.value);
   }
  }finally{reader.releaseLock();}
 }
 const bytes=new Uint8Array(length);let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return bytes;
}

const audit=(owner:BrandingOwner,set:boolean)=>owner.customerId===null?set?brandingAuditActions.portalSet:brandingAuditActions.portalRemove:set?brandingAuditActions.customerSet:brandingAuditActions.customerRemove;

/**
 * PUT: checks the file (branding-image.ts) and stores it in the slot, with one
 * audit row in the same batch. New bytes clear the measurement of the slot in
 * the same statement; the same bytes as stored write nothing. The answer is the
 * manage state.
 */
export async function setBrandingAsset(viewer:Viewer,owner:BrandingOwner,slot:BrandingSlot,bytes:Uint8Array):Promise<BrandingManageView>{
 const image=checkBrandingImage(slot,bytes);
 const current=await db().one<{sha256:string}>(sql`SELECT sha256 FROM branding_assets WHERE COALESCE(customer_id,'')=${ownerKey(owner.customerId)} AND slot=${slot}`);
 if(current?.sha256===image.sha256)return brandingManage(viewer);
 const hex=Buffer.from(image.data).toString('hex');
 // A background upload also becomes the choice of its area, in the same batch.
 const choice=owner.customerId===null&&isBrandingBackgroundSlot(slot)?[upsertChoice(viewer,slot,'upload')]:[];
 const {results:[stored]}=await commitWithAudit([
  sql`INSERT INTO branding_assets(customer_id,slot,content_type,data,size,width,height,sha256,updated_at,updated_by)
   SELECT ${owner.customerId}::text,${slot},${image.contentType},decode(${hex},'hex'),${image.size},${image.width},${image.height},${image.sha256},${now()}::bigint,${principal(viewer)} WHERE ${writeGuard(viewer,owner)}
   ON CONFLICT ((COALESCE(customer_id,'')),slot) DO UPDATE SET content_type=excluded.content_type,data=excluded.data,size=excluded.size,width=excluded.width,height=excluded.height,sha256=excluded.sha256,updated_at=excluded.updated_at,updated_by=excluded.updated_by,
    measure_light_low=NULL,measure_light_high=NULL,measure_dark_low=NULL,measure_dark_high=NULL`,
  ...choice,
 ],{audit:{actor:viewer.label,action:audit(owner,true),target:slot,customerId:owner.customerId},guard:auditAfterChange,at:1});
 if(!stored.rowCount)await refusedWrite(viewer,owner);
 return brandingManage(viewer);
}

/**
 * DELETE: removes the image of the slot with one audit row in the same batch. An empty slot writes nothing. Removing
 * a background image while it is the choice of its area sets that choice to none in the same batch.
 */
export async function removeBrandingAsset(viewer:Viewer,owner:BrandingOwner,slot:BrandingSlot):Promise<BrandingManageView>{
 const where=sql`COALESCE(customer_id,'')=${ownerKey(owner.customerId)} AND slot=${slot}`;
 if(!await db().one(sql`SELECT 1 AS present FROM branding_assets WHERE ${where}`))return brandingManage(viewer);
 const reset=owner.customerId===null&&isBrandingBackgroundSlot(slot)
  ?[sql`UPDATE branding_settings SET ${choiceColumn(slot)}='none',updated_at=${now()}::bigint,updated_by=${principal(viewer)} WHERE id=1 AND ${choiceColumn(slot)}='upload' AND (${viewerCanSql(viewer,'instance.owner')})`]:[];
 const {results:[removed]}=await commitWithAudit([
  sql`DELETE FROM branding_assets WHERE ${where} AND ${writeGuard(viewer,owner)}`,
  ...reset,
 ],{audit:{actor:viewer.label,action:audit(owner,false),target:slot,customerId:owner.customerId},guard:auditAfterChange,at:1});
 if(!removed.rowCount)await refusedWrite(viewer,owner);
 return brandingManage(viewer);
}
const choiceColumn=(area:BrandingBackgroundSlot)=>area==='signin'?sql`signin_background`:sql`console_background`;
/** Upserts the choice of an area behind the live Owner right; for an upload choice also behind the stored image (`requireUpload`). */
function upsertChoice(viewer:Viewer,area:BrandingBackgroundSlot,choice:BrandingBackgroundChoice,requireUpload=false):Sql{
 const column=choiceColumn(area);
 const upload=requireUpload?sql` AND EXISTS (SELECT 1 FROM branding_assets WHERE customer_id IS NULL AND slot=${area})`:sql``;
 return sql`INSERT INTO branding_settings(id,${column},updated_at,updated_by) SELECT 1,${choice},${now()}::bigint,${principal(viewer)} WHERE (${viewerCanSql(viewer,'instance.owner')})${upload}
  ON CONFLICT (id) DO UPDATE SET ${column}=excluded.${column},updated_at=excluded.updated_at,updated_by=excluded.updated_by`;
}

/** A body of POST /api/branding/manage. */
export type BrandingManageAction={action:'setBackground';area:BrandingBackgroundSlot;choice:string}|{action:'setScheme';primary:unknown;secondary:unknown}|{action:'clearScheme'}
 |{action:'measureBackground';version:string;measure:BackdropMeasure};
/** The version of an upload: the first 16 hex digits of its sha256, as in its URL (?v=). */
const isVersion=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{16}$/.test(value);
/** Reads the body of POST /api/branding/manage: an unknown action or area, or a malformed body, is apiError.request.invalid. */
export function brandingManageAction(input:Record<string,unknown>):BrandingManageAction{
 const invalid=()=>new HttpError('apiError.request.invalid');
 if(input.action==='setBackground'){
  if(!isBrandingBackgroundSlot(input.area)||typeof input.choice!=='string')throw invalid();
  return {action:'setBackground',area:input.area,choice:input.choice};
 }
 if(input.action==='setScheme')return {action:'setScheme',primary:input.primary,secondary:input.secondary};
 if(input.action==='clearScheme')return {action:'clearScheme'};
 if(input.action==='measureBackground'){
  if(!isVersion(input.version)||!isBackdropMeasure(input.measure))throw invalid();
  const {light,dark}=input.measure;
  return {action:'measureBackground',version:input.version,measure:{light:{low:light.low,high:light.high},dark:{low:dark.low,high:dark.high}}};
 }
 throw invalid();
}
/** Runs one POST action of the Branding page and answers the manage state. */
export function runBrandingManageAction(viewer:Viewer,action:BrandingManageAction):Promise<BrandingManageView>{
 if(action.action==='setBackground')return setBrandingBackground(viewer,action.area,action.choice);
 if(action.action==='setScheme')return setBrandingScheme(viewer,action.primary,action.secondary);
 if(action.action==='measureBackground')return measureBrandingBackground(viewer,action.version,action.measure);
 return clearBrandingScheme(viewer);
}

/**
 * setBackground: the choice of an area (none, upload or a bundled background) and one audit row
 * branding.background.set (target: the area) in one batch. An unknown choice, or upload without a stored image of the
 * area, is apiError.branding.backgroundChoice. The same choice again writes nothing.
 */
export async function setBrandingBackground(viewer:Viewer,area:BrandingBackgroundSlot,choice:string):Promise<BrandingManageView>{
 await requireBrandingOwner(viewer);
 const refused=()=>new HttpError('apiError.branding.backgroundChoice');
 if(!isBrandingBackgroundChoice(choice))throw refused();
 const hasUpload=async()=>!!await db().one(sql`SELECT 1 AS present FROM branding_assets WHERE customer_id IS NULL AND slot=${area}`);
 if(choice==='upload'&&!await hasUpload())throw refused();
 if((await brandingSettings())[area]===choice)return brandingManage(viewer);
 const {results:[stored]}=await commitWithAudit([upsertChoice(viewer,area,choice,choice==='upload')],
  {audit:{actor:viewer.label,action:brandingAuditActions.backgroundSet,target:area,customerId:null},guard:auditAfterChange,at:1});
 if(!stored.rowCount){
  await requireBrandingOwner(viewer,true);
  throw refused();
 }
 return brandingManage(viewer);
}

/**
 * setScheme: two lowercase #rrggbb colors from the logo. The server derives and checks the scheme again
 * (lib/brand-scheme.ts); a value outside the pattern or a scheme that does not pass is apiError.branding.schemeColor.
 * One audit row branding.scheme.set (target "scheme") in the same batch; the same colors again write nothing.
 */
export async function setBrandingScheme(viewer:Viewer,primary:unknown,secondary:unknown):Promise<BrandingManageView>{
 await requireBrandingOwner(viewer);
 if(!isBrandSchemeHex(primary)||!isBrandSchemeHex(secondary)||!deriveBrandScheme({primary,secondary}).ok)throw new HttpError('apiError.branding.schemeColor');
 const current=(await brandingSettings()).scheme;
 if(current?.primary===primary&&current.secondary===secondary)return brandingManage(viewer);
 const {results:[stored]}=await commitWithAudit([
  sql`INSERT INTO branding_settings(id,scheme_primary,scheme_secondary,updated_at,updated_by) SELECT 1,${primary},${secondary},${now()}::bigint,${principal(viewer)} WHERE (${viewerCanSql(viewer,'instance.owner')})
   ON CONFLICT (id) DO UPDATE SET scheme_primary=excluded.scheme_primary,scheme_secondary=excluded.scheme_secondary,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
 ],{audit:{actor:viewer.label,action:brandingAuditActions.schemeSet,target:'scheme',customerId:null},guard:auditAfterChange,at:1});
 if(!stored.rowCount)await requireBrandingOwner(viewer,true);
 return brandingManage(viewer);
}

/** clearScheme: no brand scheme, with one audit row branding.scheme.remove. Clearing an empty scheme writes nothing. */
export async function clearBrandingScheme(viewer:Viewer):Promise<BrandingManageView>{
 await requireBrandingOwner(viewer);
 if(!(await brandingSettings()).scheme)return brandingManage(viewer);
 const {results:[cleared]}=await commitWithAudit([
  sql`UPDATE branding_settings SET scheme_primary=NULL,scheme_secondary=NULL,updated_at=${now()}::bigint,updated_by=${principal(viewer)} WHERE id=1 AND scheme_primary IS NOT NULL AND (${viewerCanSql(viewer,'instance.owner')})`,
 ],{audit:{actor:viewer.label,action:brandingAuditActions.schemeRemove,target:'scheme',customerId:null},guard:auditAfterChange,at:1});
 if(!cleared.rowCount)await requireBrandingOwner(viewer,true);
 return brandingManage(viewer);
}

/**
 * measureBackground: stores the measurement of the console upload (lib/backdrop.ts) that the Owner's browser read. It
 * writes only to the console row whose sha256 starts with `version`, behind the live Owner right, in one statement; a
 * stale version, a missing upload or the same values write nothing. No audit row: the values are derived from the
 * audited upload and change no setting.
 */
export async function measureBrandingBackground(viewer:Viewer,version:string,measure:BackdropMeasure):Promise<BrandingManageView>{
 await requireBrandingOwner(viewer);
 const {light,dark}=measure;
 const {rowCount}=await db().exec(sql`UPDATE branding_assets SET measure_light_low=${light.low},measure_light_high=${light.high},measure_dark_low=${dark.low},measure_dark_high=${dark.high}
  WHERE customer_id IS NULL AND slot='console' AND left(sha256,16)=${version} AND (${viewerCanSql(viewer,'instance.owner')})
   AND (measure_light_low IS DISTINCT FROM ${light.low} OR measure_light_high IS DISTINCT FROM ${light.high} OR measure_dark_low IS DISTINCT FROM ${dark.low} OR measure_dark_high IS DISTINCT FROM ${dark.high})`);
 // Nothing written: a stale version, no upload, the same values, or the Owner right went away meanwhile (403).
 if(!rowCount)await requireBrandingOwner(viewer,true);
 return brandingManage(viewer);
}

/**
 * GET /api/branding/scheme (public): the stylesheet of the stored brand scheme (brandSchemeCss), or a sheet with a
 * comment only without one. Linked from app/layout.tsx on every page, so it revalidates (no-cache) and answers 304
 * when If-None-Match names the sha256 of the current body.
 */
export async function brandSchemeResponse(request:Request):Promise<Response>{
 const scheme=(await brandingSettings()).scheme,result=scheme?deriveBrandScheme(scheme):null;
 const body=result?.ok?brandSchemeCss(result):'/* No brand color scheme. */\n';
 const etag=`"${createHash('sha256').update(body).digest('hex')}"`;
 const headers={'Content-Type':'text/css; charset=utf-8','X-Content-Type-Options':'nosniff',ETag:etag,'Cache-Control':'no-cache'};
 const match=requestTags(request);
 if(match.includes(etag)||match.includes('*'))return new Response(null,{status:304,headers});
 return new Response(body,{headers});
}

/** A write whose guard refused it: the Owner right or the customer went away meanwhile. */
async function refusedWrite(viewer:Viewer,owner:BrandingOwner){
 await requireBrandingOwner(viewer,true);
 if(owner.customerId!==null)await requireBrandableCustomer(owner.customerId);
}

/**
 * The logo of the notification emails: {SITE_ORIGIN}/api/branding/portal/light?v=<hash>
 * when SITE_ORIGIN is set and the portal light logo is PNG or JPEG, else null.
 */
export async function portalEmailLogoUrl():Promise<string|null>{
 const row=await db().one<{content_type:string;sha256:string}>(sql`SELECT content_type,sha256 FROM branding_assets WHERE customer_id IS NULL AND slot='light'`);
 return emailLogoUrl(config('SITE_ORIGIN'),row?{contentType:row.content_type,sha256:row.sha256}:null);
}
