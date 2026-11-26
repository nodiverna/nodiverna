// The latest driver that NVIDIA or AMD offers for a GPU (docs/gpu-driver-updates.md).
// One provider per vendor. A provider fetches only from its fixed HTTPS lookup
// hosts, redirects included, with a 15 s time limit and at most 2 MiB per
// answer. A download URL counts only on the vendor's download hosts; its size
// comes from a HEAD request on that host. Every parse or network failure gives
// lookup-failed. Results stay in memory: 6 hours, a lookup failure 15 minutes.
// "Check again" skips the cache at most once every 5 minutes per device, and
// each portal process makes at most 30 forced lookups per vendor in 5 minutes.
// A GPU name longer than 96 characters is an unsupported model.
import {compareGpuDriverVersions,validGpuDriverVersion,type GpuDriverVendor} from '../../../gpu-drivers/installed';

export type GpuOsFamily='windows-client'|'windows-server';
export type GpuDriverQuery={vendor:GpuDriverVendor;name:string;deviceId:number|null;osFamily:GpuOsFamily|null};
export type GpuDriverOffer={version:string;releasedAt:string|null;downloadUrl:string;sizeBytes:number};
export type GpuDriverFailure='unsupported-model'|'unsupported-os'|'lookup-failed';
export type GpuDriverLookup=({ok:true}&GpuDriverOffer)|{ok:false;reason:GpuDriverFailure};
/** limited: the lookup was forced, but the vendor's budget of forced lookups was used up, so it acted as a normal lookup. */
export type GpuDriverCheck={result:GpuDriverLookup;checkedAt:number;limited?:true};
type Fetch=(input:string,init?:RequestInit)=>Promise<Response>;

export const gpuDriverRequestTimeoutMs=15_000;
export const gpuDriverMaxResponseBytes=2*1024*1024;
export const gpuDriverResultTtlMs=6*3_600_000;
export const gpuDriverFailureTtlMs=15*60_000;
export const gpuDriverRefreshIntervalMs=5*60_000;
/** Forced lookups per vendor and portal process in any window of gpuDriverRefreshIntervalMs. */
export const gpuDriverForcedLookupLimit=30;
/** The longest cleaned GPU name that is looked up; a longer name is an unsupported model. */
export const gpuDriverMaxNameLength=96;
/** The largest package the portal and the agent accept (3 GiB). */
export const gpuDriverMaxPackageBytes=3*1024*1024*1024;
const maxRedirects=3,maxCacheEntries=1000;

/** The hosts each provider reads its lookup data from. */
export const gpuDriverLookupHosts:Record<GpuDriverVendor,readonly string[]>={nvidia:['www.nvidia.com','gfwsl.geforce.com'],amd:['www.amd.com']};
/** The hosts a download URL may name. The agent has the same list as its own constant. */
export const gpuDriverDownloadHosts:Record<GpuDriverVendor,readonly string[]>={nvidia:['us.download.nvidia.com','international.download.nvidia.com'],amd:['drivers.amd.com']};

/** True for an https URL without user info and without a port on one of the hosts. */
export function allowedGpuDriverUrl(value:unknown,hosts:readonly string[]):value is string{
 if(typeof value!=='string'||value.length>2048)return false;
 let url:URL;try{url=new URL(value);}catch{return false;}
 return url.protocol==='https:'&&!url.username&&!url.password&&url.port===''&&hosts.includes(url.hostname);
}
/** True when a download URL may be stored in a job for this vendor. */
export const acceptedGpuDriverDownload=(vendor:GpuDriverVendor,value:unknown):value is string=>allowedGpuDriverUrl(value,gpuDriverDownloadHosts[vendor]);

type SnapshotOs={os?:unknown;osInfo?:{editionId?:unknown;installationType?:unknown}|null}|null|undefined;
/** Windows 10/11 or Windows Server, from the snapshot's edition and product name; null when neither is clear. */
export function gpuOsFamily(snapshot:SnapshotOs):GpuOsFamily|null{
 const installation=String(snapshot?.osInfo?.installationType??'').toLowerCase(),edition=String(snapshot?.osInfo?.editionId??''),name=String(snapshot?.os??'');
 if(installation==='server'||installation==='server core'||edition.startsWith('Server')||/\bWindows Server\b/i.test(name))return 'windows-server';
 if(/\bWindows (?:10|11)\b/i.test(name)||installation==='client')return 'windows-client';
 return null;
}

class LookupFailure extends Error{}
const fail=(message:string):never=>{throw new LookupFailure(message);};

type HttpOptions={hosts:readonly string[];method?:'GET'|'HEAD';headers?:Record<string,string>};
type Http={text:(url:string,options:HttpOptions)=>Promise<string>;size:(url:string,options:HttpOptions)=>Promise<number>};
function createHttp(fetch:()=>Fetch,timeoutMs:number,maxBytes:number):Http{
 // Follows at most three redirects by hand: every hop must pass the host list.
 async function open(url:string,{hosts,method='GET',headers={}}:HttpOptions,signal:AbortSignal):Promise<Response>{
  let current=url;
  for(let hop=0;hop<=maxRedirects;hop++){
   if(!allowedGpuDriverUrl(current,hosts))fail('host not allowed');
   const response=await fetch()(current,{method,headers,redirect:'manual',signal,cache:'no-store'});
   if(response.status>=300&&response.status<400){
    const location=response.headers.get('location');
    await response.body?.cancel().catch(()=>undefined);
    if(!location)fail('redirect without location');
    current=new URL(location!,current).href;continue;
   }
   if(!response.ok){await response.body?.cancel().catch(()=>undefined);fail('status '+response.status);}
   return response;
  }
  return fail('too many redirects');
 }
 const signal=()=>AbortSignal.timeout(timeoutMs);
 return {
  async text(url,options){
   const deadline=signal(),response=await open(url,options,deadline);
   const declared=Number(response.headers.get('content-length'));
   if(Number.isFinite(declared)&&declared>maxBytes){await response.body?.cancel().catch(()=>undefined);fail('answer too large');}
   const reader=response.body?.getReader();if(!reader)return '';
   const chunks:Uint8Array[]=[];let size=0;
   for(;;){
    const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;
    if(size>maxBytes){await reader.cancel().catch(()=>undefined);fail('answer too large');}
    chunks.push(value);
   }
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   return new TextDecoder().decode(bytes);
  },
  // The size of a package: a GET of the first byte, whose Content-Range names
  // the total. A HEAD answer is not used: the AMD host compresses it, so its
  // Content-Length is not the package size. A host that ignores the range
  // answers 200 with the full, uncompressed length; the body is not read.
  async size(url,options){
   const response=await open(url,{...options,headers:{...options.headers,range:'bytes=0-0','accept-encoding':'identity'}},signal());
   await response.body?.cancel().catch(()=>undefined);
   const range=/^bytes 0-0\/(\d{1,13})$/.exec(response.headers.get('content-range')??'');
   const value=response.status===206&&range?Number(range[1]):response.status===200&&!response.headers.get('content-encoding')?Number(response.headers.get('content-length')):NaN;
   if(!Number.isSafeInteger(value)||value<1||value>gpuDriverMaxPackageBytes)fail('package size missing or out of range');
   return value;
  },
 };
}

const months:Record<string,number>={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
/** A release date as YYYY-MM-DD from "Wed Oct 21, 2026", "October 21, 2026" or an ISO date; else null. */
export function gpuDriverReleaseDate(value:unknown):string|null{
 if(typeof value!=='string')return null;
 const text=value.trim(),iso=/^(\d{4})-(\d{2})-(\d{2})/.exec(text),named=/^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
 const [year,month,day]=iso?[Number(iso[1]),Number(iso[2]),Number(iso[3])]:named?[Number(named[3]),months[named[1].slice(0,3).toLowerCase()],Number(named[2])]:[NaN,NaN,NaN];
 if(!year||!month||!day)return null;
 const date=new Date(Date.UTC(year,month-1,day));
 return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?date.toISOString().slice(0,10):null;
}

type Provider={
 /** The product key for the cache, or a result that needs no request. */
 classify:(query:GpuDriverQuery)=>{key:string}|{result:GpuDriverLookup};
 lookup:(query:GpuDriverQuery,key:string,http:Http,shared:SharedCache)=>Promise<GpuDriverLookup>;
};
type SharedCache=<T>(key:string,load:()=>Promise<T>)=>Promise<T>;
const unsupported=(reason:'unsupported-model'|'unsupported-os'):GpuDriverLookup=>({ok:false,reason});
const cleanName=(name:string)=>name.replace(/\((?:TM|R)\)|[™®]/gi,' ').replace(/\s+/g,' ').trim().toLowerCase();
const nameTooLong=(name:string)=>cleanName(name).length>gpuDriverMaxNameLength;

// ---- NVIDIA: the product tables of lookupValueSearch.aspx, then DriverManualLookup ----
const nvidiaLookupBase='https://www.nvidia.com/Download/API/lookupValueSearch.aspx';
const nvidiaDriverBase='https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php';
// Product types of the series table: GeForce gets the Game Ready branch, NVIDIA RTX / Quadro the RTX Enterprise driver.
const nvidiaBranches:Record<string,'game-ready'|'rtx-enterprise'>={'1':'game-ready','3':'rtx-enterprise'};
type LookupValue={parent:string;name:string;value:string};
const xmlText=(value:string)=>value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,code:string)=>String.fromCharCode(Number(code))).replace(/&amp;/g,'&');
export function nvidiaLookupValues(xml:string):LookupValue[]{
 const rows:LookupValue[]=[];
 for(const [,attributes,inner] of xml.matchAll(/<LookupValue\b([^>]*)>([\s\S]*?)<\/LookupValue>/g)){
  const parent=/\bParentID="(\d{1,6})"/.exec(attributes)?.[1]??'',name=/<Name>([^<]{1,256})<\/Name>/.exec(inner)?.[1],value=/<Value>(\d{1,6})<\/Value>/.exec(inner)?.[1];
  if(name&&value)rows.push({parent,name:xmlText(name).trim(),value});
 }
 return rows;
}
/** The product key of an NVIDIA name: without trademarks, spaces collapsed, without the leading "NVIDIA". */
export const nvidiaProductKey=(name:string)=>cleanName(name).replace(/^nvidia\s+/,'');
function pickNvidiaOs(systems:LookupValue[],family:GpuOsFamily):string|null{
 const named=(pattern:RegExp)=>systems.find(system=>pattern.test(system.name))?.value??null;
 if(family==='windows-client')return named(/^Windows 11$/i)??named(/^Windows 10 64-bit$/i);
 const servers=systems.map(system=>({value:system.value,year:Number(/^Windows Server (\d{4})\b/i.exec(system.name)?.[1])})).filter(system=>system.year>=2016).sort((a,b)=>b.year-a.year);
 return servers[0]?.value??null;
}
const decoded=(value:unknown)=>{if(typeof value!=='string')return '';try{return decodeURIComponent(value);}catch{return value;}};
const nvidia:Provider={
 classify:query=>{const key=nameTooLong(query.name)?'':nvidiaProductKey(query.name);return key?{key}:{result:unsupported('unsupported-model')};},
 async lookup(query,key,http,shared){
  const hosts=gpuDriverLookupHosts.nvidia;
  const [series,products]=await Promise.all([
   shared('nvidia-series',async()=>nvidiaLookupValues(await http.text(nvidiaLookupBase+'?TypeID=2',{hosts}))),
   shared('nvidia-products',async()=>nvidiaLookupValues(await http.text(nvidiaLookupBase+'?TypeID=3',{hosts}))),
  ]);
  if(!series.length||!products.length)fail('empty product tables');
  const typeOf=new Map(series.map(row=>[row.value,row.parent]));
  const product=products.find(row=>nvidiaProductKey(row.name)===key&&Object.hasOwn(nvidiaBranches,typeOf.get(row.parent)??''));
  if(!product)return unsupported('unsupported-model');
  const branch=nvidiaBranches[typeOf.get(product.parent)!];
  if(query.osFamily===null)return unsupported('unsupported-os');
  const systems=await shared('nvidia-os-'+product.parent,async()=>nvidiaLookupValues(await http.text(`${nvidiaLookupBase}?TypeID=4&ParentID=${product.parent}`,{hosts})));
  const os=pickNvidiaOs(systems,query.osFamily);
  if(!os)return unsupported('unsupported-os');
  const answer=JSON.parse(await http.text(`${nvidiaDriverBase}?func=DriverManualLookup&psid=${product.parent}&pfid=${product.value}&osID=${os}&languageCode=1033&beta=0&isWHQL=1&dltype=-1&dch=1&upCRD=0&qnf=0&sort1=1&numberOfResults=10`,{hosts})) as {Success?:unknown;IDS?:unknown};
  if(!(Number(answer.Success)>=1)||!Array.isArray(answer.IDS))fail('no driver list');
  // WHQL, not beta, no feature preview. GeForce: the Game Ready driver, not Studio.
  // RTX: the certified Enterprise driver; a release named "New Feature Branch" is left out.
  const candidates=(answer.IDS as {downloadInfo?:Record<string,unknown>}[]).map(item=>item?.downloadInfo).filter((info):info is Record<string,unknown>=>!!info&&typeof info==='object')
   .filter(info=>info.IsWHQL==='1'&&info.IsBeta!=='1'&&info.IsFeaturePreview!=='1'&&validGpuDriverVersion(info.Version))
   .filter(info=>branch==='game-ready'?info.IsCRD!=='1'&&/game ready/i.test(decoded(info.Name)):!/new feature/i.test(decoded(info.Name)));
  const newest=candidates.sort((a,b)=>compareGpuDriverVersions(String(b.Version),String(a.Version)))[0]??fail('no certified driver');
  const downloadUrl=newest.DownloadURL;
  if(!acceptedGpuDriverDownload('nvidia',downloadUrl))fail('download host not allowed');
  const sizeBytes=await http.size(downloadUrl as string,{hosts:gpuDriverDownloadHosts.nvidia});
  return {ok:true,version:String(newest.Version),releasedAt:gpuDriverReleaseDate(newest.ReleaseDateTime),downloadUrl:downloadUrl as string,sizeBytes};
 },
};

// ---- AMD: the driver pages of www.amd.com ----
// The driver index lists one page per graphics card. The page of a Radeon RX
// card has a section per Windows version, and each section names the
// "Recommended" WHQL release of AMD Software: Adrenalin Edition with version,
// release date and full installer. The installer differs per card family
// (for example -a for RX 5000/6000, -b for RX 7000/9000), so the page is read
// per card, never one release for all.
export const amdDriverIndex='https://www.amd.com/en/support/download/drivers.html';
const amdProductPrefix='https://www.amd.com/en/support/downloads/drivers.html/graphics/radeon-rx/';
/** The download host refuses requests without the AMD site as Referer. */
export const amdDownloadReferer='https://www.amd.com/';
// RDNA devices (Radeon RX 5000 and newer) have PCI device IDs from 0x7310.
const amdFirstRdnaDevice=0x7310;
/** The product key of an AMD name: without trademarks, spaces collapsed, without the leading "AMD". */
export const amdProductKey=(name:string)=>cleanName(name).replace(/^amd\s+/,'');
/** Radeon RX 5000 series and newer, not Radeon PRO; with a known device ID, an RDNA device. */
export function amdSupportedModel(name:string,deviceId:number|null):boolean{
 const clean=cleanName(name),series=/\bradeon\s+rx\s+(\d{4})[a-z]{0,3}\b/.exec(clean);
 return !!series&&Number(series[1])>=5000&&!/\bpro\b/.test(clean)&&(deviceId===null||deviceId>=amdFirstRdnaDevice);
}
const htmlText=(value:string)=>xmlText(value.replace(/&#34;/g,'"').replace(/&#39;/g,"'")).replace(/&nbsp;/g,' ');
/** The Radeon RX driver pages of the index: product key → page URL (only pages below the Radeon RX path on www.amd.com). */
export function amdDriverPages(html:string):Map<string,string>{
 const pages=new Map<string,string>();
 for(const [,url,title] of html.matchAll(/&#34;url&#34;:&#34;([^&"]{1,300})&#34;,&#34;title&#34;:&#34;([^&"]{1,120})&#34;/g)){
  if(!url.startsWith(amdProductPrefix)||!/^[a-z0-9/-]+\.html$/.test(url.slice(amdProductPrefix.length))||!allowedGpuDriverUrl(url,gpuDriverLookupHosts.amd))continue;
  const key=amdProductKey(htmlText(title));
  if(key&&!pages.has(key))pages.set(key,url);
 }
 return pages;
}
/** The page of a card: the exact name, else the longest listed name the card name starts with (an OEM suffix). */
export function amdDriverPage(pages:Map<string,string>,key:string):string|null{
 const exact=pages.get(key);if(exact)return exact;
 const prefix=[...pages.keys()].filter(name=>key.startsWith(name+' ')).sort((a,b)=>b.length-a.length)[0];
 return prefix?pages.get(prefix)!:null;
}
/**
 * The Recommended WHQL Adrenalin release of a driver page: from the Windows 11
 * section, else the Windows 10 section. Null when no section names one.
 */
export function amdRecommendedDriver(html:string):{version:string;releasedAt:string|null;downloadUrl:string}|null{
 const headings=[...html.matchAll(/Windows (1[01]) - 64-Bit Edition\s*<\/button>/g)].map(match=>({os:match[1],at:match.index}));
 for(const os of ['11','10']){
  const heading=headings.find(item=>item.os===os);if(!heading)continue;
  const next=headings.find(item=>item.at>heading.at)?.at??html.length,section=html.slice(heading.at,next);
  for(const [,article] of section.matchAll(/<article\b[^>]*driver-download-details[^>]*>([\s\S]*?)<\/article>/g)){
   if(!/<h4>\s*AMD Software: Adrenalin Edition\s*<\/h4>/.test(article))continue;
   const version=/<p>\s*Adrenalin (\d{1,2}\.\d{1,2}\.\d{1,2}) WHQL \(Recommended\)\s*<\/p>/.exec(article)?.[1];
   if(!version||!validGpuDriverVersion(version))continue;
   const escaped=version.replace(/\./g,'\\.');
   const downloadUrl=new RegExp(String.raw`href="(https://drivers\.amd\.com/drivers/whql-amd-software-adrenalin-edition-${escaped}-[A-Za-z0-9._-]{1,120}\.exe)"`).exec(article)?.[1];
   if(!downloadUrl||/minimal/i.test(downloadUrl))continue;
   const date=/Release Date<\/strong>\s*<p>\s*([^<]{8,40}?)\s*<\/p>/.exec(article)?.[1];
   return {version,releasedAt:gpuDriverReleaseDate(date),downloadUrl};
  }
 }
 return null;
}
const amd:Provider={
 classify:query=>nameTooLong(query.name)||!amdSupportedModel(query.name,query.deviceId)?{result:unsupported('unsupported-model')}:query.osFamily!=='windows-client'?{result:unsupported('unsupported-os')}:{key:amdProductKey(query.name)},
 async lookup(_query,key,http,shared){
  const hosts=gpuDriverLookupHosts.amd,headers={accept:'text/html'};
  const pages=await shared('amd-driver-pages',async()=>{const found=amdDriverPages(await http.text(amdDriverIndex,{hosts,headers}));if(!found.size)fail('driver index without Radeon RX pages');return found;});
  const page=amdDriverPage(pages,key);
  if(!page)return unsupported('unsupported-model');
  const release=amdRecommendedDriver(await http.text(page,{hosts,headers}))??fail('driver page without a Recommended WHQL release');
  if(!acceptedGpuDriverDownload('amd',release.downloadUrl))fail('download host not allowed');
  const sizeBytes=await http.size(release.downloadUrl,{hosts:gpuDriverDownloadHosts.amd,headers:{referer:amdDownloadReferer}});
  return {ok:true,...release,sizeBytes};
 },
};
const providers:Record<GpuDriverVendor,Provider>={nvidia,amd};

function cacheKey(query:GpuDriverQuery,classified:ReturnType<Provider['classify']>):string{
 // A classify result keeps the cleaned name, or no name when it is too long:
 // such a name is unsupported-model for both vendors, like an empty one.
 const name='key' in classified?classified.key:nameTooLong(query.name)?'':cleanName(query.name);
 return `${query.vendor}|${name}|${query.osFamily??'unknown'}`;
}
/** The cache key of a query: vendor, at most gpuDriverMaxNameLength name characters, OS family. */
export const gpuDriverCacheKey=(query:GpuDriverQuery)=>cacheKey(query,providers[query.vendor].classify(query));

export type GpuDriverCatalog={
 /** The latest driver for one GPU; force skips the cache. */
 lookup:(query:GpuDriverQuery,options?:{force?:boolean})=>Promise<GpuDriverCheck>;
 /** True when the device may skip the cache now (at most once every 5 minutes); records the refresh. */
 claimRefresh:(deviceId:string)=>boolean;
};
type CatalogDeps={fetch?:Fetch;now?:()=>number;timeoutMs?:number;maxBytes?:number;forcedLookupLimit?:number};
export function createGpuDriverCatalog({fetch,now=Date.now,timeoutMs=gpuDriverRequestTimeoutMs,maxBytes=gpuDriverMaxResponseBytes,forcedLookupLimit=gpuDriverForcedLookupLimit}:CatalogDeps={}):GpuDriverCatalog{
 const http=createHttp(()=>fetch??globalThis.fetch,timeoutMs,maxBytes);
 const results=new Map<string,{check:GpuDriverCheck;expires:number}>(),inflight=new Map<string,Promise<GpuDriverCheck>>();
 const shared=new Map<string,{value:unknown;expires:number}>(),refreshes=new Map<string,number>();
 const remember=<T,>(map:Map<string,T>,key:string,value:T)=>{map.delete(key);map.set(key,value);while(map.size>maxCacheEntries)map.delete(map.keys().next().value!);};
 const sharedCache:SharedCache=async<T,>(key:string,load:()=>Promise<T>)=>{
  const hit=shared.get(key);if(hit&&hit.expires>now())return hit.value as T;
  const value=await load();remember(shared,key,{value,expires:now()+gpuDriverResultTtlMs});return value;
 };
 // The times of the forced lookups per vendor within the last window, oldest first.
 const forced:Record<GpuDriverVendor,number[]>={nvidia:[],amd:[]};
 const takeForcedLookup=(vendor:GpuDriverVendor)=>{
  const time=now(),times=forced[vendor];
  while(times.length&&time-times[0]>=gpuDriverRefreshIntervalMs)times.shift();
  if(times.length>=forcedLookupLimit)return false;
  times.push(time);return true;
 };
 return {
  async lookup(query,{force=false}={}){
   const provider=providers[query.vendor],classified=provider.classify(query),key=cacheKey(query,classified);
   const hit=results.get(key),fresh=hit&&hit.expires>now()?hit.check:null;
   if(!force&&fresh)return fresh;
   // A joined lookup and a classify result make no own request, so they use no budget.
   const running=inflight.get(key);if(running)return running;
   // Over the vendor's budget a forced lookup acts as a normal one. The mark is
   // only on the returned copy, never in the cache.
   const limited=force&&'key' in classified&&!takeForcedLookup(query.vendor);
   if(limited&&fresh)return {...fresh,limited:true};
   const task=(async()=>{
    let result:GpuDriverLookup;
    if('result' in classified)result=classified.result;
    else try{result=await provider.lookup(query,classified.key,http,sharedCache);}catch{result={ok:false,reason:'lookup-failed'};}
    const checkedAt=now(),check={result,checkedAt};
    remember(results,key,{check,expires:checkedAt+(!result.ok&&result.reason==='lookup-failed'?gpuDriverFailureTtlMs:gpuDriverResultTtlMs)});
    return check;
   })();
   inflight.set(key,task);
   let check:GpuDriverCheck;
   try{check=await task;}finally{inflight.delete(key);}
   return limited?{...check,limited:true}:check;
  },
  claimRefresh(deviceId){
   const time=now(),last=refreshes.get(deviceId);
   if(last!==undefined&&time-last<gpuDriverRefreshIntervalMs)return false;
   remember(refreshes,deviceId,time);return true;
  },
 };
}

/** The portal's catalog: one per process, so several portal processes keep their own cache. */
export const gpuDriverCatalog=createGpuDriverCatalog();
