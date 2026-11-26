// GPU driver updates: the vendor providers of lib/server/devices/gpu-drivers/catalog.ts
// against recorded NVIDIA and AMD answers (tests/fixtures/gpu-drivers/), with
// fetch stubbed: model and OS matching, the
// host allow list (redirects included), the time and size limits, the cache and
// the 5-minute refresh limit, the global budget of forced lookups and the
// GPU name length limit. No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {sourceLoader} from '../support/source-database.mjs';
const {acceptedGpuDriverDownload,allowedGpuDriverUrl,amdDriverPage,amdDriverPages,amdProductKey,amdRecommendedDriver,amdSupportedModel,createGpuDriverCatalog,gpuDriverCacheKey,gpuDriverDownloadHosts,gpuDriverFailureTtlMs,gpuDriverForcedLookupLimit,gpuDriverMaxNameLength,gpuDriverLookupHosts,gpuDriverMaxResponseBytes,gpuDriverRefreshIntervalMs,gpuDriverReleaseDate,gpuDriverRequestTimeoutMs,gpuDriverResultTtlMs,gpuOsFamily,nvidiaLookupValues}=sourceLoader()('lib/server/devices/gpu-drivers/catalog.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const fixture=name=>fs.readFileSync('tests/fixtures/gpu-drivers/'+name,'utf8');
const nvidiaGeForce='https://us.download.nvidia.com/Windows/621.01/621.01-desktop-win10-win11-64bit-international-dch-whql.exe';
const nvidiaRtx='https://us.download.nvidia.com/Windows/Quadro_Certified/597.30/597.30-quadro-rtx-desktop-notebook-win10-win11-64bit-international-dch-whql.exe';
const amdFull='https://drivers.amd.com/drivers/whql-amd-software-adrenalin-edition-26.10.1-win11-b.exe',amdRdna2='https://drivers.amd.com/drivers/whql-amd-software-adrenalin-edition-26.10.1-win11-a.exe';
const amdIndex='https://www.amd.com/en/support/download/drivers.html',amdPages='https://www.amd.com/en/support/downloads/drivers.html/graphics/radeon-rx/';
const amd7900=amdPages+'radeon-rx-7000-series/amd-radeon-rx-7900-xtx.html',amd5700=amdPages+'radeon-rx-5000-series/amd-radeon-rx-5700-xt.html';

// ---- The limits and host lists of the spec ----
check([gpuDriverRequestTimeoutMs,gpuDriverMaxResponseBytes,gpuDriverResultTtlMs,gpuDriverFailureTtlMs,gpuDriverRefreshIntervalMs],[15_000,2*1024*1024,6*3_600_000,15*60_000,5*60_000],'15 s, 2 MiB, 6 h, 15 min, 5 min');
check(gpuDriverDownloadHosts,{nvidia:['us.download.nvidia.com','international.download.nvidia.com'],amd:['drivers.amd.com']},'download hosts');
check(gpuDriverLookupHosts,{nvidia:['www.nvidia.com','gfwsl.geforce.com'],amd:['www.amd.com']},'lookup hosts');
for(const [url,ok] of [[nvidiaGeForce,true],['https://international.download.nvidia.com/x.exe',true],['http://us.download.nvidia.com/x.exe',false],['https://user:pw@us.download.nvidia.com/x.exe',false],['https://us.download.nvidia.com:8443/x.exe',false],['https://evil.example/x.exe',false],['https://us.download.nvidia.com.evil.example/x.exe',false],['not a url',false],[42,false]])
 check(acceptedGpuDriverDownload('nvidia',url),ok,`NVIDIA download ${url}`);
check(acceptedGpuDriverDownload('amd',amdFull),true,'AMD download');
check(acceptedGpuDriverDownload('amd',nvidiaGeForce),false,'an NVIDIA host is no AMD host');
check(allowedGpuDriverUrl('https://www.nvidia.com/x',['www.nvidia.com']),true,'lookup host');

// ---- OS family and parsers ----
check(gpuOsFamily({os:'Microsoft Windows 11 Pro',osInfo:{editionId:'Professional',installationType:'Client'}}),'windows-client','Windows 11');
check(gpuOsFamily({os:'Microsoft Windows 10 Enterprise'}),'windows-client','Windows 10 by name');
check(gpuOsFamily({os:'Microsoft Windows Server 2025 Datacenter',osInfo:{editionId:'ServerDatacenter',installationType:'Server'}}),'windows-server','Windows Server');
check(gpuOsFamily({os:'Microsoft Windows Server 2022',osInfo:{installationType:'Server Core'}}),'windows-server','Server Core');
check(gpuOsFamily({os:'Linux'}),null,'unknown OS');
check(gpuDriverReleaseDate('Wed Oct 21, 2026'),'2026-10-21','NVIDIA date');
check(gpuDriverReleaseDate('October 14, 2026'),'2026-10-14','long date');
check(gpuDriverReleaseDate('2026-10-14T16:00:00Z'),'2026-10-14','ISO date');
for(const value of ['Feb 30, 2026','yesterday','',null])check(gpuDriverReleaseDate(value),null,`no date from ${value}`);
check(nvidiaLookupValues('<LookupValue ParentID="1"><Name>A &amp; B</Name><Value>7</Value></LookupValue>'),[{parent:'1',name:'A & B',value:'7'}],'XML rows with entities');
// AMD: the recorded driver index and two recorded driver pages.
const pages=amdDriverPages(fixture('amd-drivers-index.html'));
check(pages.size,62,'the 62 Radeon RX driver pages of the index; Radeon PRO and older cards are left out');
check([amdDriverPage(pages,amdProductKey('AMD Radeon RX 7900 XTX')),amdDriverPage(pages,amdProductKey('AMD Radeon(TM) RX 5700 XT')),amdDriverPage(pages,amdProductKey('Radeon RX 7800 XT'))],[amd7900,amd5700,amdPages+'radeon-rx-7000-series/amd-radeon-rx-7800-xt.html'],'a card name finds its page, with and without "AMD" and trademarks');
check(amdDriverPage(pages,amdProductKey('AMD Radeon RX 6600 XT (OEM)')),amdPages+'radeon-rx-6000-series/amd-radeon-rx-6600-xt.html','an OEM suffix finds the longest listed name');
check(amdDriverPage(pages,amdProductKey('AMD Radeon RX 7990 XTXX')),null,'a name without a page');
check(amdDriverPages('&#34;url&#34;:&#34;https://evil.example/en/support/downloads/drivers.html/graphics/radeon-rx/x.html&#34;,&#34;title&#34;:&#34;AMD Radeon RX 7900 XTX&#34;').size,0,'a page off www.amd.com is never used');
check(amdRecommendedDriver(fixture('amd-driver-rx-7900-xtx.html')),{version:'26.10.1',releasedAt:'2026-10-20',downloadUrl:amdFull},'RX 7900 XTX page: the Recommended WHQL release, not the newer Optional one');
check(amdRecommendedDriver(fixture('amd-driver-rx-5700-xt.html')),{version:'26.10.1',releasedAt:'2026-10-20',downloadUrl:amdRdna2},'RX 5700 XT page: the installer of its own family');
check(amdRecommendedDriver(fixture('amd-driver-rx-7900-xtx.html').replace(/WHQL \(Recommended\)/g,'WHQL (Optional)')),null,'a page without a Recommended release');
check(amdRecommendedDriver('<p>maintenance</p>'),null,'a page without driver sections');
for(const [name,device,ok] of [['AMD Radeon RX 7900 XTX',0x744c,true],['AMD Radeon(TM) RX 5700 XT',0x731f,true],['AMD Radeon RX 9070 XT',null,true],['AMD Radeon RX 6600M',null,true],['Radeon RX 580 Series',null,false],['AMD Radeon RX 5700 XT',0x67df,false],['AMD Radeon PRO W7900',0x7448,false],['AMD Radeon Pro RX 5700',null,false],['AMD Radeon(TM) Graphics',0x1681,false],['AMD Radeon 780M',null,false]])
 check(amdSupportedModel(name,device),ok,`AMD model ${name}`);

// ---- A stubbed vendor web ----
function vendorWeb(overrides={}){
 const requests=[];
 const routes={
  'https://www.nvidia.com/Download/API/lookupValueSearch.aspx?TypeID=2':()=>fixture('nvidia-series.xml'),
  'https://www.nvidia.com/Download/API/lookupValueSearch.aspx?TypeID=3':()=>fixture('nvidia-products.xml'),
  'https://www.nvidia.com/Download/API/lookupValueSearch.aspx?TypeID=4&ParentID=127':()=>fixture('nvidia-os-127.xml'),
  'https://www.nvidia.com/Download/API/lookupValueSearch.aspx?TypeID=4&ParentID=122':()=>fixture('nvidia-os-122.xml'),
  // The notebook and Quadro RTX series list the same systems as their desktop series.
  'https://www.nvidia.com/Download/API/lookupValueSearch.aspx?TypeID=4&ParentID=129':()=>fixture('nvidia-os-127.xml'),
  'https://www.nvidia.com/Download/API/lookupValueSearch.aspx?TypeID=4&ParentID=109':()=>fixture('nvidia-os-122.xml'),
  [amdIndex]:()=>fixture('amd-drivers-index.html'),
  [amd7900]:()=>fixture('amd-driver-rx-7900-xtx.html'),
  [amd5700]:()=>fixture('amd-driver-rx-5700-xt.html'),
  ...overrides,
 };
 const fetch=async(url,init={})=>{
  requests.push({url,method:init.method??'GET',headers:init.headers??{},redirect:init.redirect});
  const parsed=new URL(url);
  let route=routes[url];
  if(!route&&parsed.hostname==='gfwsl.geforce.com')route=routes.driver??(()=>fixture(['127','129','131'].includes(parsed.searchParams.get('psid'))?'nvidia-driver-geforce.json':'nvidia-driver-rtx.json'));
  // The package size: a range request for the first byte on a download host.
  if(!route&&/download\.nvidia\.com$|^drivers\.amd\.com$/.test(parsed.hostname))route=routes.download??(()=>new Response(null,{status:206,headers:{'content-range':'bytes 0-0/1037190000'}}));
  if(!route)return new Response('missing',{status:404});
  const value=await route(url,init);
  return value instanceof Response?value:new Response(value,{status:200});
 };
 return {fetch,requests};
}
const nvidia=(name,osFamily='windows-client')=>({vendor:'nvidia',name,deviceId:null,osFamily});
const amd=(name,deviceId,osFamily='windows-client')=>({vendor:'amd',name,deviceId,osFamily});
const hostsOf=requests=>[...new Set(requests.map(request=>new URL(request.url).hostname))].sort();

{
 const web=vendorWeb(),catalog=createGpuDriverCatalog({fetch:web.fetch,now:()=>1000});
 const geforce=await catalog.lookup(nvidia('NVIDIA GeForce RTX 4070'));
 check(geforce,{result:{ok:true,version:'621.01',releasedAt:'2026-10-21',downloadUrl:nvidiaGeForce,sizeBytes:1037190000},checkedAt:1000},'GeForce: the Game Ready driver');
 const driverRequest=new URL(web.requests.find(request=>request.url.includes('DriverManualLookup')).url);
 check([driverRequest.searchParams.get('psid'),driverRequest.searchParams.get('pfid'),driverRequest.searchParams.get('osID'),driverRequest.searchParams.get('isWHQL'),driverRequest.searchParams.get('upCRD')],['127','1015','135','1','0'],'the GeForce series, product, Windows 11, WHQL, no Studio');
 check(web.requests.every(request=>request.redirect==='manual'),true,'redirects are followed by hand');
 check((await catalog.lookup(nvidia('NVIDIA GeForce RTX 4070 Laptop GPU'))).result.ok,true,'a laptop GPU name of the notebook series');
 const rtx=await catalog.lookup(nvidia('NVIDIA RTX A2000'));
 check(rtx.result,{ok:true,version:'597.30',releasedAt:'2026-10-22',downloadUrl:nvidiaRtx,sizeBytes:1037190000},'NVIDIA RTX: the newest certified Enterprise driver');
 const quadro=await catalog.lookup(nvidia('Quadro RTX 4000'));
 check(quadro.result.ok,true,'a Quadro RTX card has the RTX Enterprise driver');
 const server=await catalog.lookup(nvidia('NVIDIA RTX A2000','windows-server'));
 check(server.result.version,'597.30','RTX on Windows Server');
 check(new URL(web.requests.filter(request=>request.url.includes('DriverManualLookup')).at(-1).url).searchParams.get('osID'),'153','the newest Windows Server of the series (2025)');
 check((await catalog.lookup(nvidia('NVIDIA GeForce RTX 4070','windows-server'))).result,{ok:false,reason:'unsupported-os'},'GeForce has no Windows Server driver');
 check((await catalog.lookup(nvidia('NVIDIA RTX PRO 6000 Blackwell Server Edition'))).result,{ok:false,reason:'unsupported-model'},'a data center card is not supported');
 check((await catalog.lookup(nvidia('NVIDIA Imaginary 9000'))).result,{ok:false,reason:'unsupported-model'},'an unknown name is not supported');
 check((await catalog.lookup(nvidia('NVIDIA GeForce RTX 4070',null))).result,{ok:false,reason:'unsupported-os'},'an unknown OS');
 const radeon=await catalog.lookup(amd('AMD Radeon RX 7900 XTX',0x744c));
 check(radeon.result,{ok:true,version:'26.10.1',releasedAt:'2026-10-20',downloadUrl:amdFull,sizeBytes:1037190000},'AMD RX 7000: the Recommended Adrenalin release of its driver page');
 const size=web.requests.find(request=>request.url===amdFull);
 check([size?.method,size?.headers.referer,size?.headers.range,size?.headers['accept-encoding']],['GET','https://www.amd.com/','bytes=0-0','identity'],'the size comes from a one-byte range request with the AMD site as Referer');
 check((await catalog.lookup(amd('AMD Radeon RX 5700 XT',0x731f))).result.downloadUrl,amdRdna2,'RX 5700 XT gets the installer of its own family');
 check((await catalog.lookup(amd('AMD Radeon RX 7990 XTX',0x744c))).result,{ok:false,reason:'unsupported-model'},'a card without a driver page');
 const before=web.requests.length;
 check((await catalog.lookup(amd('Radeon RX 580 Series',0x67df))).result,{ok:false,reason:'unsupported-model'},'older Radeon');
 check((await catalog.lookup(amd('AMD Radeon PRO W7900',0x7448))).result,{ok:false,reason:'unsupported-model'},'Radeon PRO');
 check((await catalog.lookup(amd('AMD Radeon RX 7900 XTX',0x744c,'windows-server'))).result,{ok:false,reason:'unsupported-os'},'AMD on Windows Server');
 check(web.requests.length,before,'unsupported AMD models and Windows Server need no request');
 check(hostsOf(web.requests),['drivers.amd.com','gfwsl.geforce.com','us.download.nvidia.com','www.amd.com','www.nvidia.com'],'only the fixed hosts are contacted');
}

// ---- Download URLs and redirects off the allow list give lookup-failed ----
const driverWith=url=>()=>{const answer=JSON.parse(fixture('nvidia-driver-geforce.json'));for(const item of answer.IDS)item.downloadInfo.DownloadURL=url;return JSON.stringify(answer);};
for(const url of ['https://evil.example/621.01.exe','http://us.download.nvidia.com/Windows/621.01/x.exe','https://user:pw@us.download.nvidia.com/Windows/621.01/x.exe','https://us.download.nvidia.com:444/x.exe']){
 const web=vendorWeb({driver:driverWith(url)}),catalog=createGpuDriverCatalog({fetch:web.fetch});
 check((await catalog.lookup(nvidia('NVIDIA GeForce RTX 4070'))).result,{ok:false,reason:'lookup-failed'},`a download URL outside the allow list: ${url}`);
 check(web.requests.some(request=>request.url===url),false,`no request to ${url}`);
}
{
 const web=vendorWeb({'https://www.nvidia.com/Download/API/lookupValueSearch.aspx?TypeID=2':()=>new Response(null,{status:302,headers:{location:'https://evil.example/series.xml'}})});
 check((await createGpuDriverCatalog({fetch:web.fetch}).lookup(nvidia('NVIDIA GeForce RTX 4070'))).result,{ok:false,reason:'lookup-failed'},'a lookup redirect off the allow list');
 check(web.requests.some(request=>request.url.startsWith('https://evil.example')),false,'the redirect target is never requested');
}
{
 const moved='https://international.download.nvidia.com/Windows/621.01/621.01.exe';
 const web=vendorWeb({download:url=>url===nvidiaGeForce?new Response(null,{status:301,headers:{location:moved}}):new Response(null,{status:200,headers:{'content-length':'1000'}})});
 check((await createGpuDriverCatalog({fetch:web.fetch}).lookup(nvidia('NVIDIA GeForce RTX 4070'))).result.sizeBytes,1000,'a redirect between the NVIDIA download hosts is followed');
 const off=vendorWeb({download:()=>new Response(null,{status:302,headers:{location:'https://cdn.example/x.exe'}})});
 check((await createGpuDriverCatalog({fetch:off.fetch}).lookup(nvidia('NVIDIA GeForce RTX 4070'))).result,{ok:false,reason:'lookup-failed'},'a download redirect off the allow list');
 const loop=vendorWeb({download:()=>new Response(null,{status:302,headers:{location:nvidiaGeForce}})});
 check((await createGpuDriverCatalog({fetch:loop.fetch}).lookup(nvidia('NVIDIA GeForce RTX 4070'))).result,{ok:false,reason:'lookup-failed'},'more than three redirects');
 for(const [label,answer] of [['no length',()=>new Response(null,{status:200})],['zero',()=>new Response(null,{status:200,headers:{'content-length':'0'}})],['over 3 GiB',()=>new Response(null,{status:206,headers:{'content-range':'bytes 0-0/3221225473'}})],['not a number',()=>new Response(null,{status:200,headers:{'content-length':'abc'}})],['a compressed length (the AMD HEAD answer)',()=>new Response(null,{status:200,headers:{'content-encoding':'gzip','content-length':'20'}})],['an unknown total',()=>new Response(null,{status:206,headers:{'content-range':'bytes 0-0/*'}})]]){
  const web2=vendorWeb({download:answer});
  check((await createGpuDriverCatalog({fetch:web2.fetch}).lookup(nvidia('NVIDIA GeForce RTX 4070'))).result,{ok:false,reason:'lookup-failed'},`a package size is refused: ${label}`);
 }
 {const web3=vendorWeb({download:()=>new Response(null,{status:200,headers:{'content-length':'1000'}})});check((await createGpuDriverCatalog({fetch:web3.fetch}).lookup(nvidia('NVIDIA GeForce RTX 4070'))).result.sizeBytes,1000,'a host that ignores the range gives its uncompressed length');}
}

// ---- Time limit and 2 MiB cap ----
{
 const hanging=vendorWeb({[amdIndex]:(_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason)))});
 // AbortSignal.timeout does not keep the process alive; this timer does, while the request hangs.
 const alive=setTimeout(()=>{},5000),started=Date.now(),result=await createGpuDriverCatalog({fetch:hanging.fetch,timeoutMs:40}).lookup(amd('AMD Radeon RX 7900 XTX',0x744c));clearTimeout(alive);
 check(result.result,{ok:false,reason:'lookup-failed'},'a request without an answer times out');
 assert.ok(Date.now()-started<2000,'the time limit stops the request');checks++;
 const huge='x'.repeat(gpuDriverMaxResponseBytes+1);
 const declared=vendorWeb({[amdIndex]:()=>new Response(huge,{status:200,headers:{'content-length':String(huge.length)}})});
 check((await createGpuDriverCatalog({fetch:declared.fetch}).lookup(amd('AMD Radeon RX 7900 XTX',0x744c))).result,{ok:false,reason:'lookup-failed'},'an answer that declares more than 2 MiB');
 const streamed=vendorWeb({[amdIndex]:()=>new Response(new ReadableStream({start(controller){for(let i=0;i<3;i++)controller.enqueue(new TextEncoder().encode('y'.repeat(1024*1024)));controller.close();}}),{status:200})});
 check((await createGpuDriverCatalog({fetch:streamed.fetch}).lookup(amd('AMD Radeon RX 7900 XTX',0x744c))).result,{ok:false,reason:'lookup-failed'},'a streamed answer past 2 MiB');
 const exact=vendorWeb({[amdIndex]:()=>fixture('amd-drivers-index.html')+' '.repeat(gpuDriverMaxResponseBytes-Buffer.byteLength(fixture('amd-drivers-index.html')))});
 check((await createGpuDriverCatalog({fetch:exact.fetch}).lookup(amd('AMD Radeon RX 7900 XTX',0x744c))).result.ok,true,'exactly 2 MiB is read');
}

// ---- Cache, TTLs and the refresh limit ----
{
 let clock=0;const web=vendorWeb(),catalog=createGpuDriverCatalog({fetch:web.fetch,now:()=>clock});
 const first=await catalog.lookup(nvidia('NVIDIA GeForce RTX 4070')),count=web.requests.length;
 clock=gpuDriverResultTtlMs-1;
 check(await catalog.lookup(nvidia('NVIDIA  GeForce   RTX 4070')),first,'a cache hit within 6 hours, with the same product key');
 check(web.requests.length,count,'a cache hit makes no request');
 check((await catalog.lookup(nvidia('NVIDIA GeForce RTX 4070'),{force:true})).checkedAt,gpuDriverResultTtlMs-1,'force skips the cache');
 clock=2*gpuDriverResultTtlMs;
 check((await catalog.lookup(nvidia('NVIDIA GeForce RTX 4070'))).checkedAt,clock,'after 6 hours the lookup runs again');
 check((await catalog.lookup(nvidia('NVIDIA GeForce RTX 4070','windows-server'))).result.reason,'unsupported-os','another OS family is another cache entry');

 let failing=true;clock=0;
 const flaky=vendorWeb({[amdIndex]:()=>failing?new Response('down',{status:503}):fixture('amd-drivers-index.html')});
 const amdCatalog=createGpuDriverCatalog({fetch:flaky.fetch,now:()=>clock});
 check((await amdCatalog.lookup(amd('AMD Radeon RX 7900 XTX',0x744c))).result,{ok:false,reason:'lookup-failed'},'a vendor outage fails');
 failing=false;clock=gpuDriverFailureTtlMs-1;
 check((await amdCatalog.lookup(amd('AMD Radeon RX 7900 XTX',0x744c))).result,{ok:false,reason:'lookup-failed'},'the failure is cached for 15 minutes');
 clock=gpuDriverFailureTtlMs;
 check((await amdCatalog.lookup(amd('AMD Radeon RX 7900 XTX',0x744c))).result.ok,true,'after 15 minutes the lookup runs again');

 clock=0;
 check(catalog.claimRefresh('device-a'),true,'the first refresh is allowed');
 clock=gpuDriverRefreshIntervalMs-1;
 check([catalog.claimRefresh('device-a'),catalog.claimRefresh('device-b')],[false,true],'a second refresh within 5 minutes is refused, per device');
 clock=gpuDriverRefreshIntervalMs;
 check(catalog.claimRefresh('device-a'),true,'after 5 minutes the refresh is allowed again');
}

// ---- Parallel lookups share one request ----
{
 const web=vendorWeb(),catalog=createGpuDriverCatalog({fetch:web.fetch});
 const [a,b]=await Promise.all([catalog.lookup(amd('AMD Radeon RX 7900 XTX',0x744c)),catalog.lookup(amd('AMD Radeon RX 7900 XTX',0x744c))]);
 check([a,web.requests.filter(request=>request.url===amdIndex).length,web.requests.filter(request=>request.url===amd7900).length],[b,1,1],'one index and one page request for two parallel lookups');
 await catalog.lookup(amd('AMD Radeon RX 5700 XT',0x731f));
 check(web.requests.filter(request=>request.url===amdIndex).length,1,'the driver index is shared by all cards for 6 hours');
}

// ---- The global budget of forced lookups (per vendor, rolling 5 minutes) ----
{
 check([gpuDriverForcedLookupLimit,gpuDriverMaxNameLength],[30,96],'30 forced lookups per vendor, names up to 96 characters');
 let clock=0;const web=vendorWeb(),catalog=createGpuDriverCatalog({fetch:web.fetch,now:()=>clock});
 const driverRequests=()=>web.requests.filter(request=>request.url.includes('DriverManualLookup')).length;
 const amdPageRequests=()=>web.requests.filter(request=>request.url===amd7900).length;
 const geforce=nvidia('NVIDIA GeForce RTX 4070');
 const forced=[];
 for(let i=0;i<30;i++){clock=i;forced.push(await catalog.lookup(geforce,{force:true}));}
 check([driverRequests(),forced.some(item=>'limited' in item)],[30,false],'30 forced NVIDIA lookups each contact the vendor and are not limited');
 clock=1000;const count=web.requests.length;
 const over=await catalog.lookup(geforce,{force:true});
 check([web.requests.length,over],[count,{...forced[29],limited:true}],'the 31st forced lookup within 5 minutes makes no request and returns the cached result, marked limited');
 check(await catalog.lookup(geforce),forced[29],'the limited mark is not stored in the cache');
 // The budget of AMD is its own.
 check([(await catalog.lookup(amd('AMD Radeon RX 7900 XTX',0x744c),{force:true})).limited,amdPageRequests()],[undefined,1],'a forced AMD lookup still contacts AMD');
 // Results of classify use no budget: forced unsupported-os lookups are never limited.
 {
  const tight=createGpuDriverCatalog({fetch:web.fetch,now:()=>clock,forcedLookupLimit:0}),before=web.requests.length;
  for(const osFamily of ['windows-server',null])for(let i=0;i<3;i++)
   check(await tight.lookup(amd('AMD Radeon RX 7900 XTX',0x744c,osFamily),{force:true}),{result:{ok:false,reason:'unsupported-os'},checkedAt:1000},`a forced AMD unsupported-os result (${osFamily}) needs no budget, is not limited and makes no request`);
  check(web.requests.length,before,'classify results make no request');
 }
 // A forced cache miss over the budget runs the normal lookup.
 const rtxBefore=driverRequests(),rtx=await catalog.lookup(nvidia('NVIDIA RTX A2000'),{force:true});
 check([rtx.result.version,rtx.limited,driverRequests()],['597.30',true,rtxBefore+1],'a forced cache miss over the budget runs a normal lookup, marked limited');
 // After the window the oldest forced lookups leave the budget.
 clock=gpuDriverRefreshIntervalMs;
 const again=await catalog.lookup(geforce,{force:true});
 check([again.limited,again.checkedAt,driverRequests()],[undefined,gpuDriverRefreshIntervalMs,rtxBefore+2],'after 5 minutes a forced lookup contacts the vendor again');
}
{
 const web=vendorWeb(),catalog=createGpuDriverCatalog({fetch:web.fetch,now:()=>0,forcedLookupLimit:1});
 const radeon=amd('AMD Radeon RX 7900 XTX',0x744c),pagesOf=()=>web.requests.filter(request=>request.url===amd7900).length;
 // Two forced lookups that run at once: the second joins the first and uses no budget.
 const [a,b]=await Promise.all([catalog.lookup(radeon,{force:true}),catalog.lookup(radeon,{force:true})]);
 check([a.limited,b.limited,pagesOf()],[undefined,undefined,1],'a forced lookup joined to one in flight shares its request and uses no budget');
 const limited=await catalog.lookup(radeon,{force:true});
 check([limited.limited,pagesOf()],[true,1],'with a budget of 1 the next forced AMD lookup is limited');
 check((await catalog.lookup(nvidia('NVIDIA GeForce RTX 4070'),{force:true})).limited,undefined,'the NVIDIA budget is not affected by AMD');
}

// ---- GPU names longer than 96 characters ----
{
 const web=vendorWeb(),catalog=createGpuDriverCatalog({fetch:web.fetch});
 const pad=length=>'x'.repeat(length);
 const nvidia96='NVIDIA GeForce RTX 4070 '+pad(96-'nvidia geforce rtx 4070 '.length),nvidia97=nvidia96+'y';
 const amd96='AMD Radeon RX 7900 XTX '+pad(96-'amd radeon rx 7900 xtx '.length),amd97=amd96+'y';
 check([nvidia96,nvidia97,amd96,amd97].map(name=>name.length),[96,97,96,97],'the test names');
 const before=web.requests.length;
 check((await catalog.lookup(nvidia(nvidia97),{force:true})).result,{ok:false,reason:'unsupported-model'},'a 97-character NVIDIA name is an unsupported model');
 check((await catalog.lookup(amd(amd97,0x744c),{force:true})).result,{ok:false,reason:'unsupported-model'},'a 97-character AMD name is an unsupported model');
 check(web.requests.length,before,'a too long name makes no request');
 // Trademarks are removed before the length is measured.
 check((await catalog.lookup(nvidia('NVIDIA(R) GeForce(TM) RTX 4070 '+pad(96-'nvidia geforce rtx 4070 '.length)))).result.ok,false,'the cleaned name counts: 96 characters after the trademarks go is the normal path');
 check(web.requests.length>before,true,'a 96-character name takes the normal lookup path');
 check((await catalog.lookup(amd(amd96,0x744c))).result.downloadUrl,amdFull,'a 96-character AMD name is looked up and finds the page of the name it starts with');
 check(web.requests.some(request=>request.url===amdIndex),true,'the AMD driver index was read for the 96-character name');
 const prefix=query=>`${query.vendor}|`.length+`|${query.osFamily??'unknown'}`.length;
 const long='NVIDIA GeForce RTX 4070 '+pad(5000);
 for(const query of [nvidia(long),nvidia(long,null),nvidia(long,'windows-server'),amd('AMD Radeon RX 7900 XTX '+pad(5000),0x744c),amd('AMD Radeon RX 7900 XTX '+pad(5000),0x744c,'windows-server'),amd(pad(5000),null,null),nvidia(nvidia96),amd(amd96,0x744c),amd(amd96,0x744c,'windows-server'),amd('Radeon '+pad(200),null)])
  check(gpuDriverCacheKey(query).length<=prefix(query)+96,true,`the cache key of a ${query.name.length}-character ${query.vendor} name has at most 96 name characters`);
 check(gpuDriverCacheKey(nvidia(nvidia96)),'nvidia|'+nvidia96.toLowerCase().replace(/^nvidia /,'')+'|windows-client','a 96-character name keeps its full product key');
}

console.log(`PASS: ${checks} GPU driver catalog checks.`);
