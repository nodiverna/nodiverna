// The branding routes (app/api/branding/**, lib/server/branding.ts, docs/branding.md) against an isolated PostgreSQL
// test database; only the request environment (session, origin check) is replaced. GET /api/branding is public and
// shows the portal slots; PUT and DELETE need the same origin, a live viewer and a global Owner, cap the raw body at
// the slot limit, run the checks of lib/server/branding-image.ts and write the row and one audit row in one batch
// (the same bytes and an empty slot write nothing); the asset GETs send the headers of docs/branding.md, 304 on
// If-None-Match (without a read of the bytes) and immutable only with the current version; the favicon falls back to /favicon.svg; customer logos
// need a customer other than the default customer and are only shown to accounts that see that customer and to the
// Owner; GET /api/branding/manage is Owner-only; ConsoleData.branding holds only visible customers.
// Backgrounds and the scheme: the slots signin and console (8 MiB, 320 to 7680 px, the upload becomes the choice and its
// removal resets a shown choice, portal only), POST setBackground, setScheme and clearScheme with their checks and
// audit rows, the public view with the sign-in background only, the console view with the console background and the
// scheme, and the brand stylesheet GET /api/branding/scheme with its headers and 304.
// The console background measurement: POST measureBackground stores the four values only for the current
// version of the console upload, behind the Owner (403) and with a valid body (400), writes nothing for a stale
// version, the same values or no upload, and writes no audit row; a new console upload clears the values and the same
// bytes keep them; the console view (GET /api/console) carries the scrims and measured (fallback, then measured), the
// manage view carries measured and scrim, and GET /api/branding does not change.
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

const defaultCustomer='00000000-0000-4000-8000-000000000100',origin='https://portal.test';
const {backdropScrims,fallbackBackdropMeasure}=sourceLoader()('lib/backdrop.ts');
const {brandingBackgrounds}=sourceLoader()('lib/branding.ts');
const bundledScrim=id=>backdropScrims(brandingBackgrounds.find(background=>background.id===id).measure,null);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const keyed=async response=>{const sent=await response.json();return [response.status,sent.messageKey];};

const u32be=value=>[value>>>24&255,value>>>16&255,value>>>8&255,value&255];
const chunk=(type,data=[])=>[...u32be(data.length),...[...type].map(char=>char.charCodeAt(0)),...data,0,0,0,0];
const png=(width,height,seed=0)=>Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,...chunk('IHDR',[...u32be(width),...u32be(height),8,6,0,0,0]),...chunk('IDAT',[seed]),...chunk('IEND')]);
const svgFile=text=>new TextEncoder().encode(text);
/** A PNG of exactly `total` bytes: the IHDR of the size, one IDAT chunk of zeros, IEND (no CRC is checked). */
function pngOfSize(width,height,total){
 const head=png(width,height).slice(0,33),tail=Uint8Array.from(chunk('IEND')),out=new Uint8Array(total);
 out.set(head,0);out.set(u32be(total-head.length-tail.length-12),33);out.set([...'IDAT'].map(char=>char.charCodeAt(0)),37);out.set(tail,total-tail.length);
 return out;
}

async function fixture(run){
 const d=await sourceDatabase();
 const env={SITE_ORIGIN:origin};
 let viewer=null;
 // The error class and the failure answer of the same loader as the routes, so a keyed error keeps its status.
 const load=sourceLoader(),{HttpError}=load('lib/errors/http-error.ts'),{classifyFailure}=load('lib/server/errors/failure.ts');
 const failure=error=>{const answer=classifyFailure(error);if(answer.status>=500)console.error(error);return Response.json(answer.body,{status:answer.status,headers:{'Cache-Control':'no-store'}});};
 const server={db:()=>d,now:()=>Date.now(),config:key=>env[key]??'',HttpError,failure,
  guid:value=>typeof value==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value),
  sameOrigin:request=>{if(request.headers.get('origin')!==env.SITE_ORIGIN)throw new HttpError('apiError.request.invalidOrigin');},
  requireViewer:async()=>{if(!viewer)throw new HttpError('apiError.auth.loginRequired');return viewer;},
  // The JSON body as lib/server/context.ts reads it: an object, else apiError.request.invalidJson.
  body:async request=>{try{const parsed=JSON.parse(await request.text());if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('object');return parsed;}catch{throw new HttpError('apiError.request.invalidJson');}}};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server};
 const routes={
  public:load('app/api/branding/route.ts',imports),manage:load('app/api/branding/manage/route.ts',imports),favicon:load('app/api/branding/favicon/route.ts',imports),
  portal:load('app/api/branding/portal/[slot]/route.ts',imports),customer:load('app/api/branding/customer/[id]/[slot]/route.ts',imports),
  scheme:load('app/api/branding/scheme/route.ts',imports),
 };
 const branding=load('lib/server/branding.ts',imports),customers=load('lib/server/identity/customers.ts',imports);
 const owner=(await sourceActor(d,'owner@branding.test',['*'])).actor;
 const tech=(await sourceActor(d,'tech@branding.test',['view'])).actor;
 const assigned=(await sourceActor(d,'assigned@branding.test',['view'])).actor;
 const as=actor=>{viewer=actor;};
 const request=(path,{method='GET',body,headers={}}={})=>new Request(origin+path,{method,body,headers:{...(method==='GET'?{}:{origin}),...headers}});
 const portal={
  get:(slot,options)=>routes.portal.GET(request(`/api/branding/portal/${slot}`+(options?.query??''),options),{params:Promise.resolve({slot})}),
  put:(slot,body,options={})=>routes.portal.PUT(request(`/api/branding/portal/${slot}`,{method:'PUT',body,...options}),{params:Promise.resolve({slot})}),
  delete:(slot,options={})=>routes.portal.DELETE(request(`/api/branding/portal/${slot}`,{method:'DELETE',...options}),{params:Promise.resolve({slot})}),
 };
 const customer={
  get:(id,slot,options)=>routes.customer.GET(request(`/api/branding/customer/${id}/${slot}`+(options?.query??''),options),{params:Promise.resolve({id,slot})}),
  put:(id,slot,body)=>routes.customer.PUT(request(`/api/branding/customer/${id}/${slot}`,{method:'PUT',body}),{params:Promise.resolve({id,slot})}),
  delete:(id,slot)=>routes.customer.DELETE(request(`/api/branding/customer/${id}/${slot}`,{method:'DELETE'}),{params:Promise.resolve({id,slot})}),
 };
 const post=(body,options={})=>routes.manage.POST(request('/api/branding/manage',{method:'POST',body:typeof body==='string'?body:JSON.stringify(body),headers:{'content-type':'application/json',...options.headers}}));
 const rows=async()=>(await d.query(sql`SELECT customer_id,slot,content_type,size,width,height,sha256,updated_by,encode(data,'hex') AS hex FROM branding_assets ORDER BY slot,customer_id NULLS FIRST`)).map(row=>({...row}));
 const audit=async()=>(await d.query(sql`SELECT actor,action,target,customer_id AS "customerId" FROM audit WHERE action LIKE 'branding.%' ORDER BY id`)).map(row=>({...row}));
 const addCustomer=async(name,status='active')=>{const id=crypto.randomUUID();await insertRow(d,'customers',{id,name,status,created_at:Date.now(),updated_at:Date.now()});return id;};
 const assign=async(customerId,actor)=>insertRow(d,'customer_assignments',{customer_id:customerId,principal_type:'user',principal_id:actor.id,created_at:Date.now(),created_by:'fixture'});
 try{return await run({d,routes,branding,customers,owner,tech,assigned,as,request,portal,customer,post,rows,audit,addCustomer,assign});}
 finally{await d.close();}
}

test('the public view, an upload by the Owner with its audit row, the same bytes again, and the refusals',async()=>fixture(async({routes,owner,tech,as,portal,rows,audit})=>{
 as(null);
 let response=await routes.public.GET();
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual(await response.json(),{portal:{light:null,dark:null,icon:null},signinBackground:null},'no session needed, three nulls and no sign-in background');
 const logo=png(240,60);
 // Refusals: nothing stored, no audit row.
 as(tech);
 assert.deepEqual(await keyed(await portal.put('light',logo)),[403,'apiError.settings.ownerOnly'],'a non-Owner');
 as(owner);
 assert.deepEqual(await keyed(await portal.put('light',logo,{headers:{origin:'https://evil.test'}})),[403,'apiError.request.invalidOrigin'],'another origin');
 assert.deepEqual(await keyed(await portal.put('banner',logo)),[404,'apiError.generic.notFound'],'an unknown slot');
 assert.deepEqual(await keyed(await portal.put('light',new Uint8Array(2*1024*1024+1))),[413,'apiError.branding.logoTooLarge'],'a stream over 2 MiB');
 assert.deepEqual(await keyed(await portal.put('light',logo,{headers:{'content-length':String(2*1024*1024+1)}})),[413,'apiError.branding.logoTooLarge'],'a Content-Length over 2 MiB');
 assert.deepEqual(await keyed(await portal.put('icon',new Uint8Array(256*1024+1))),[413,'apiError.branding.iconTooLarge'],'an icon over 256 KiB');
 for(const [body,key] of [
  [new Uint8Array([1,2,3,4]),'apiError.branding.format'],
  [Uint8Array.from([...png(240,60).slice(0,33),...chunk('acTL',[0,0,0,1,0,0,0,0]),...chunk('IEND')]),'apiError.branding.animated'],
  [png(15,15),'apiError.branding.logoDimensions'],
  [svgFile('<!DOCTYPE svg><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'),'apiError.branding.svgInvalid'],
  [svgFile('<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>'),'apiError.branding.svgEmpty'],
  [svgFile('<svg><path d="M0 0"/></svg>'),'apiError.branding.svgSize'],
 ])assert.deepEqual(await keyed(await portal.put('light',body)),[400,key],key);
 assert.deepEqual(await keyed(await portal.put('icon',png(64,32))),[400,'apiError.branding.iconDimensions'],'a non-square icon');
 assert.deepEqual([await rows(),await audit()],[[],[]],'nothing stored, no audit row');
 // The upload: one row, one audit row, the manage state as the answer.
 response=await portal.put('light',logo);
 assert.equal(response.status,200);
 const state=await response.json();
 assert.equal(state.portal.light.url,`/api/branding/portal/light?v=${sha(logo).slice(0,16)}`);
 assert.deepEqual([state.portal.light.contentType,state.portal.light.width,state.portal.light.height,state.portal.light.size,state.multipleCustomers,state.customers],['image/png',240,60,logo.length,false,[]]);
 const stored=await rows();
 assert.deepEqual(stored.map(row=>[row.customer_id,row.slot,row.content_type,row.size,row.width,row.height,row.sha256,row.updated_by,row.hex]),[[null,'light','image/png',logo.length,240,60,sha(logo),owner.principal,Buffer.from(logo).toString('hex')]]);
 assert.deepEqual(await audit(),[{actor:owner.label,action:'branding.portal.set',target:'light',customerId:null}]);
 // The same bytes again: no write, no audit row.
 assert.equal((await portal.put('light',logo)).status,200);
 assert.deepEqual([(await audit()).length,(await rows()).length],[1,1],'the same bytes write nothing');
 as(null);
 assert.equal((await (await routes.public.GET()).json()).portal.light.url,state.portal.light.url,'the public view has the URL with v');
 // SVG: the cleaned bytes are stored.
 as(owner);
 assert.equal((await portal.put('dark',svgFile('<svg viewBox="0 0 120 40"><script>alert(1)</script><path d="M0 0h10v10z"/></svg>'))).status,200);
 const dark=(await rows()).find(row=>row.slot==='dark');
 const text=Buffer.from(dark.hex,'hex').toString('utf8');
 assert.ok(!text.includes('<script')&&text.includes('<path d="M0 0h10v10z"/>'),text);
 assert.deepEqual([dark.content_type,dark.width,dark.height,dark.size],['image/svg+xml',120,40,Buffer.byteLength(text)]);
}));

test('asset responses: headers, 304, immutable only with the current version, 404 for empty and unknown slots; the favicon',async()=>fixture(async({routes,branding,owner,as,portal,request})=>{
 as(owner);
 const logo=png(240,60),hash=sha(logo);
 assert.deepEqual(await keyed(await portal.get('light')),[404,'apiError.generic.notFound'],'an empty slot');
 assert.deepEqual(await keyed(await portal.get('banner')),[404,'apiError.generic.notFound'],'an unknown slot');
 let response=await routes.favicon.GET(request('/api/branding/favicon'));
 assert.deepEqual([response.status,response.headers.get('location')],[307,'/favicon.svg'],'without an icon the Nodiverna icon');
 await portal.put('light',logo);
 as(null);
 response=await portal.get('light',{query:`?v=${hash.slice(0,16)}`});
 assert.equal(response.status,200);
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(logo),'the stored bytes');
 const headers=Object.fromEntries(['content-type','x-content-type-options','content-disposition','content-security-policy','etag','cache-control'].map(name=>[name,response.headers.get(name)]));
 assert.deepEqual(headers,{'content-type':'image/png','x-content-type-options':'nosniff','content-disposition':'inline; filename="light.png"','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox",etag:`"${hash}"`,'cache-control':'public, max-age=31536000, immutable'});
 assert.equal((await portal.get('light',{query:'?v=0000000000000000'})).headers.get('cache-control'),'no-cache','an old version revalidates');
 assert.equal((await portal.get('light')).headers.get('cache-control'),'no-cache','no version revalidates');
 response=await portal.get('light',{headers:{'if-none-match':`"${hash}"`}});
 assert.deepEqual([response.status,(await response.arrayBuffer()).byteLength],[304,0],'If-None-Match with the current ETag');
 response=await portal.get('light',{headers:{'if-none-match':`W/"${hash}"`}});
 assert.equal(response.status,304,'a weak ETag of the current bytes');
 response=await portal.get('light',{headers:{'if-none-match':`"${sha('old')}"`}});
 assert.deepEqual([response.status,Buffer.from(await response.arrayBuffer())],[200,Buffer.from(logo)],'an old ETag gets the bytes');
 // A matching If-None-Match reads only the metadata, not the bytes (a public revalidation costs no full read).
 const read=async ifNoneMatch=>(await branding.portalAsset('light',request('/api/branding/portal/light',{headers:ifNoneMatch?{'if-none-match':ifNoneMatch}:{}}))).data;
 assert.equal(await read(`"${hash}"`),null,'the current ETag');
 assert.equal(await read(`"${sha('old')}", W/"${hash}"`),null,'the current ETag in a list');
 assert.equal(await read('*'),null,'any ETag');
 assert.deepEqual(Buffer.from(await read(`"${sha('old')}"`)),Buffer.from(logo),'another ETag reads the bytes');
 assert.deepEqual(Buffer.from(await read(null)),Buffer.from(logo),'no If-None-Match reads the bytes');
 // The favicon: the icon bytes, always revalidated.
 as(owner);
 const icon=png(64,64);
 assert.equal((await portal.put('icon',icon)).status,200);
 as(null);
 response=await routes.favicon.GET(request('/api/branding/favicon?v=1'));
 assert.deepEqual([response.status,response.headers.get('content-type'),response.headers.get('cache-control'),response.headers.get('content-disposition')],[200,'image/png','no-cache','inline; filename="icon.png"']);
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(icon));
}));

test('DELETE removes the row with its audit row; a second DELETE writes nothing',async()=>fixture(async({owner,tech,as,portal,rows,audit})=>{
 as(owner);
 await portal.put('light',png(240,60));
 as(tech);
 assert.deepEqual(await keyed(await portal.delete('light')),[403,'apiError.settings.ownerOnly']);
 as(owner);
 assert.deepEqual(await keyed(await portal.delete('light',{headers:{origin:'https://evil.test'}})),[403,'apiError.request.invalidOrigin']);
 const response=await portal.delete('light');
 assert.equal(response.status,200);
 assert.equal((await response.json()).portal.light,null);
 assert.deepEqual(await rows(),[]);
 assert.deepEqual((await audit()).map(row=>[row.action,row.target]),[['branding.portal.set','light'],['branding.portal.remove','light']]);
 assert.equal((await portal.delete('light')).status,200);
 assert.equal((await audit()).length,2,'deleting an empty slot writes nothing');
}));

test('customer logos: the default customer, icon and unknown customers are refused; visibility of the logo; manage and console state',async()=>fixture(async({d,routes,branding,customers,owner,tech,assigned,as,customer,portal,rows,audit,addCustomer,assign})=>{
 as(tech);
 assert.deepEqual(await keyed(await routes.manage.GET()),[403,'apiError.settings.ownerOnly'],'manage is Owner-only');
 as(owner);
 const contoso=await addCustomer('Contoso'),fabrikam=await addCustomer('Fabrikam','disabled');
 await assign(contoso,assigned);
 const logo=png(200,50);
 assert.deepEqual(await keyed(await customer.put(defaultCustomer,'light',logo)),[400,'apiError.branding.defaultCustomer'],'the default customer uses the portal logo');
 assert.deepEqual(await keyed(await customer.put(contoso,'icon',png(64,64))),[404,'apiError.generic.notFound'],'no icon for a customer');
 assert.deepEqual(await keyed(await customer.put(crypto.randomUUID(),'light',logo)),[404,'apiError.customer.gone'],'an unknown customer');
 assert.deepEqual(await rows(),[]);
 // The upload: the audit row carries the customer.
 let response=await customer.put(contoso,'light',logo);
 assert.equal(response.status,200);
 const state=await response.json();
 assert.equal(state.multipleCustomers,true);
 assert.deepEqual(state.customers.map(row=>[row.id,row.name,row.status,row.light?.url??null,row.dark]),[[contoso,'Contoso','active',`/api/branding/customer/${contoso}/light?v=${sha(logo).slice(0,16)}`,null],[fabrikam,'Fabrikam','disabled',null,null]],'every customer but the default one, also a deactivated one');
 assert.deepEqual(await audit(),[{actor:owner.label,action:'branding.customer.set',target:'light',customerId:contoso}]);
 assert.equal((await customer.put(fabrikam,'dark',png(100,50))).status,200,'a deactivated customer can have a logo');
 // Who sees the logo: not an account without the customer, the assigned account and the Owner.
 as(tech);
 assert.deepEqual(await keyed(await customer.get(contoso,'light')),[404,'apiError.generic.notFound'],'an account without the customer');
 as(assigned);
 response=await customer.get(contoso,'light',{query:`?v=${sha(logo).slice(0,16)}`});
 assert.deepEqual([response.status,response.headers.get('cache-control')],[200,'private, max-age=31536000, immutable'],'the assigned account');
 assert.deepEqual(await keyed(await customer.get(contoso,'dark')),[404,'apiError.generic.notFound'],'an empty customer slot');
 assert.deepEqual(await keyed(await customer.get(fabrikam,'dark')),[404,'apiError.generic.notFound'],'a customer the account does not see');
 as(owner);
 assert.equal((await customer.get(contoso,'light')).status,200,'the Owner');
 assert.equal((await customer.get(fabrikam,'dark')).status,200,'the Owner sees a deactivated customer too');
 // ConsoleData.branding: only visible customers with a logo.
 await portal.put('light',png(240,60));
 const consoleView=async actor=>branding.consoleBranding({owner:actor===owner,visibleCustomerIds:(await customers.visibleCustomers(actor)).map(row=>row.id),multipleCustomers:true});
 assert.deepEqual(Object.keys((await consoleView(assigned)).customers),[contoso],'the assigned account sees its customer');
 assert.deepEqual((await consoleView(tech)).customers,{},'an account without customers');
 assert.deepEqual(Object.keys((await consoleView(owner)).customers).sort(),[contoso,fabrikam].sort(),'the Owner sees every customer logo');
 assert.ok((await consoleView(tech)).portal.light,'the portal logo for everyone');
 assert.deepEqual((await branding.consoleBranding({owner:true,visibleCustomerIds:[],multipleCustomers:false})).customers,{},'no customer logos without multiple customers');
 // Removal of a customer logo.
 assert.equal((await customer.delete(contoso,'light')).status,200);
 assert.deepEqual((await audit()).at(-1),{actor:owner.label,action:'branding.customer.remove',target:'light',customerId:contoso});
 assert.equal(Number((await d.one(sql`SELECT count(*) AS n FROM branding_assets WHERE customer_id=${contoso}`)).n),0);
}));

test('background uploads: 8 MiB and the pixel limits, the upload becomes the choice, its removal resets a shown choice, portal only',async()=>fixture(async({routes,owner,as,portal,customer,post,rows,audit,addCustomer})=>{
 as(owner);
 const limit=8*1024*1024;
 assert.deepEqual(await keyed(await portal.put('signin',new Uint8Array(limit+1))),[413,'apiError.branding.backgroundTooLarge'],'a stream over 8 MiB');
 assert.deepEqual(await keyed(await portal.put('console',png(1920,1080),{headers:{'content-length':String(limit+1)}})),[413,'apiError.branding.backgroundTooLarge'],'a Content-Length over 8 MiB');
 assert.deepEqual(await keyed(await portal.put('signin',png(319,1080))),[400,'apiError.branding.backgroundDimensions'],'319 px');
 assert.deepEqual(await keyed(await portal.put('console',png(1920,7681))),[400,'apiError.branding.backgroundDimensions'],'7681 px');
 assert.deepEqual(await keyed(await portal.put('signin',Uint8Array.from([...png(1920,1080).slice(0,33),...chunk('acTL',[0,0,0,1,0,0,0,0]),...chunk('IEND')]))),[400,'apiError.branding.animated'],'no animation');
 assert.deepEqual([await rows(),await audit()],[[],[]],'nothing stored');
 // Exactly 8 MiB passes; the upload becomes the choice of its area in the same batch.
 const big=pngOfSize(7680,320,limit);
 let response=await portal.put('signin',big);
 assert.equal(response.status,200);
 let state=await response.json();
 assert.deepEqual([state.backgrounds.signin.choice,state.backgrounds.signin.upload.size,state.backgrounds.signin.upload.width,state.backgrounds.console],['upload',limit,7680,{choice:'none',upload:null,measured:false,scrim:null}],'8 MiB stored and chosen; the console stays');
 assert.deepEqual(await audit(),[{actor:owner.label,action:'branding.portal.set',target:'signin',customerId:null}],'the slot is the audit target');
 // An SVG background has no pixel limit and is cleaned.
 response=await portal.put('console',svgFile('<svg viewBox="0 0 100 50"><script>alert(1)</script><rect width="100" height="50" fill="#123456"/></svg>'));
 state=await response.json();
 assert.deepEqual([response.status,state.backgrounds.console.choice,state.backgrounds.console.upload.contentType,state.backgrounds.console.upload.width],[200,'upload','image/svg+xml',100]);
 // Removing the upload while it is not the choice keeps the choice.
 assert.equal((await post({action:'setBackground',area:'signin',choice:'mist'})).status,200);
 state=await (await portal.delete('signin')).json();
 assert.deepEqual([state.backgrounds.signin.choice,state.backgrounds.signin.upload],['mist',null],'a stored upload goes, the choice stays');
 // Removing the upload while it is the choice sets none.
 state=await (await portal.delete('console')).json();
 assert.deepEqual([state.backgrounds.console.choice,state.backgrounds.console.upload],['none',null],'a shown upload goes and the area shows none');
 assert.deepEqual((await audit()).map(row=>[row.action,row.target]),[['branding.portal.set','signin'],['branding.portal.set','console'],['branding.background.set','signin'],['branding.portal.remove','signin'],['branding.portal.remove','console']]);
 // The public asset route serves a background like any portal image.
 await portal.put('console',png(1920,1080,3));
 as(null);
 response=await portal.get('console');
 assert.deepEqual([response.status,response.headers.get('content-type'),response.headers.get('cache-control')],[200,'image/png','no-cache']);
 // No background for a customer.
 as(owner);
 const contoso=await addCustomer('Contoso');
 for(const slot of ['signin','console']){
  assert.deepEqual(await keyed(await customer.put(contoso,slot,png(1920,1080))),[404,'apiError.generic.notFound'],`no ${slot} for a customer`);
  assert.deepEqual(await keyed(await customer.get(contoso,slot)),[404,'apiError.generic.notFound'],`no ${slot} GET for a customer`);
 }
 assert.equal((await routes.public.GET()).status,200);
}));

test('setBackground: Owner, origin, body and choice checks, one audit row, nothing for the same choice; the public and console views',async()=>fixture(async({routes,branding,owner,tech,as,portal,post,audit})=>{
 as(tech);
 assert.deepEqual(await keyed(await post({action:'setBackground',area:'signin',choice:'mist'})),[403,'apiError.settings.ownerOnly'],'a non-Owner');
 as(owner);
 assert.deepEqual(await keyed(await post({action:'setBackground',area:'signin',choice:'mist'},{headers:{origin:'https://evil.test'}})),[403,'apiError.request.invalidOrigin'],'another origin');
 for(const body of [{action:'setBackground',area:'login',choice:'mist'},{action:'setBackground',choice:'mist'},{action:'setBackground',area:'signin',choice:3},{action:'nothing'},'not json',[1,2]])
  assert.deepEqual(await keyed(await post(body)),[400,'apiError.request.invalid'],JSON.stringify(body));
 for(const choice of ['forest','MIST','','upload'])assert.deepEqual(await keyed(await post({action:'setBackground',area:'console',choice})),[400,'apiError.branding.backgroundChoice'],`choice ${choice}`);
 assert.deepEqual(await audit(),[],'no audit row for a refusal');
 const response=await post({action:'setBackground',area:'console',choice:'dusk'});
 assert.equal(response.status,200);
 assert.deepEqual((await response.json()).backgrounds.console,{choice:'dusk',upload:null,measured:false,scrim:bundledScrim('dusk')});
 assert.deepEqual(await audit(),[{actor:owner.label,action:'branding.background.set',target:'console',customerId:null}],'one audit row, the area as target');
 assert.equal((await post({action:'setBackground',area:'console',choice:'dusk'})).status,200);
 assert.equal((await audit()).length,1,'the same choice again writes nothing');
 await post({action:'setBackground',area:'signin',choice:'dune'});
 // The public view names only the sign-in background.
 as(null);
 const publicView=await (await routes.public.GET()).json();
 assert.deepEqual(publicView.signinBackground,{kind:'builtin',id:'dune',url:'/backgrounds/dune.svg'});
 assert.ok(!JSON.stringify(publicView).includes('dusk')&&!('consoleBackground' in publicView),'nothing about the console');
 // The console view: the console background and the scheme.
 let consoleView=await branding.consoleBranding({owner:false,visibleCustomerIds:[],multipleCustomers:false});
 assert.deepEqual([consoleView.consoleBackground,consoleView.scheme],[{kind:'builtin',id:'dusk',url:'/backgrounds/dusk.svg',scrim:bundledScrim('dusk'),measured:true},null]);
 // An upload choice shows the stored image with its size; none shows nothing.
 as(owner);
 await portal.put('console',png(1920,1080));
 consoleView=await branding.consoleBranding({owner:true,visibleCustomerIds:[],multipleCustomers:false});
 assert.deepEqual([consoleView.consoleBackground.kind,consoleView.consoleBackground.width,consoleView.consoleBackground.height,/^\/api\/branding\/portal\/console\?v=[0-9a-f]{16}$/.test(consoleView.consoleBackground.url)],['upload',1920,1080,true]);
 assert.equal((await post({action:'setBackground',area:'console',choice:'none'})).status,200);
 assert.equal((await branding.consoleBranding({owner:true,visibleCustomerIds:[],multipleCustomers:false})).consoleBackground,null);
 assert.equal((await post({action:'setBackground',area:'console',choice:'upload'})).status,200,'upload with a stored image');
}));

test('measureBackground: the current version only, Owner and body checks, no audit row; a new upload clears it; the console and manage views',async()=>fixture(async({d,routes,branding,owner,tech,as,portal,post,audit})=>{
 const measure={light:{low:'#203040',high:'#8090a0'},dark:{low:'#1c2b3a',high:'#738290'}};
 const stored=async()=>(await d.query(sql`SELECT measure_light_low AS a,measure_light_high AS b,measure_dark_low AS c,measure_dark_high AS e FROM branding_assets WHERE slot='console'`)).map(row=>[row.a,row.b,row.c,row.e]);
 const consoleView=()=>branding.consoleBranding({owner:true,visibleCustomerIds:[],multipleCustomers:false});
 as(owner);
 // No upload yet: nothing to write.
 let response=await post({action:'measureBackground',version:'0123456789abcdef',measure});
 assert.equal(response.status,200,'no upload: nothing written, the manage view');
 assert.deepEqual((await response.json()).backgrounds.console,{choice:'none',upload:null,measured:false,scrim:null});
 await portal.put('console',png(1920,1080,1));
 const version=(await consoleView()).consoleBackground.url.split('v=')[1];
 // Not measured yet: the fallback scrims.
 assert.deepEqual([(await consoleView()).consoleBackground.measured,(await consoleView()).consoleBackground.scrim],[false,backdropScrims(fallbackBackdropMeasure,null)],'an unmeasured upload: the fallback');
 let manage=(await (await routes.manage.GET()).json()).backgrounds.console;
 assert.deepEqual([manage.measured,manage.scrim],[false,backdropScrims(fallbackBackdropMeasure,null)],'the manage view: not measured, the fallback scrims');
 const auditBefore=(await audit()).length;
 // Refusals: a non-Owner, another origin, malformed bodies.
 as(tech);
 assert.deepEqual(await keyed(await post({action:'measureBackground',version,measure})),[403,'apiError.settings.ownerOnly'],'a non-Owner');
 as(owner);
 assert.deepEqual(await keyed(await post({action:'measureBackground',version,measure},{headers:{origin:'https://evil.test'}})),[403,'apiError.request.invalidOrigin'],'another origin');
 const swapped={...measure,light:{low:'#8090a0',high:'#203040'}},oneChannel={...measure,dark:{low:'#1c2b3a',high:'#1c2b39'}};
 for(const body of [{action:'measureBackground',version:version.toUpperCase(),measure},{action:'measureBackground',version:version.slice(1),measure},{action:'measureBackground',measure},
  {action:'measureBackground',version,measure:{...measure,light:{low:'#20304G',high:'#8090a0'}}},{action:'measureBackground',version,measure:{...measure,dark:{low:'#1C2B3A',high:'#738290'}}},
  {action:'measureBackground',version,measure:{light:measure.light}},{action:'measureBackground',version,measure:'#000000'},{action:'measureBackground',version,measure:swapped},{action:'measureBackground',version,measure:oneChannel}])
  assert.deepEqual(await keyed(await post(body)),[400,'apiError.request.invalid'],JSON.stringify(body));
 assert.deepEqual(await stored(),[[null,null,null,null]],'nothing stored after the refusals');
 // A stale version writes nothing.
 assert.equal((await post({action:'measureBackground',version:'ffffffffffffffff',measure})).status,200);
 assert.deepEqual(await stored(),[[null,null,null,null]],'a stale version writes nothing');
 // The current version stores the four values; no audit row.
 response=await post({action:'measureBackground',version,measure});
 assert.equal(response.status,200);
 manage=(await response.json()).backgrounds.console;
 assert.deepEqual([manage.measured,manage.scrim],[true,backdropScrims(measure,null)],'the manage view: measured, the measured scrims');
 assert.deepEqual(await stored(),[['#203040','#8090a0','#1c2b3a','#738290']],'the four values');
 const view=(await consoleView()).consoleBackground;
 assert.deepEqual([view.measured,view.scrim],[true,backdropScrims(measure,null)],'the console view: measured, the measured scrims');
 assert.equal((await audit()).length,auditBefore,'no audit row');
 // The same values again: nothing changes.
 assert.equal((await post({action:'measureBackground',version,measure})).status,200);
 assert.deepEqual(await stored(),[['#203040','#8090a0','#1c2b3a','#738290']]);
 // The same bytes keep the measurement; new bytes clear it in the same statement.
 assert.equal((await portal.put('console',png(1920,1080,1))).status,200);
 assert.deepEqual(await stored(),[['#203040','#8090a0','#1c2b3a','#738290']],'the same bytes keep the values');
 assert.equal((await portal.put('console',png(1920,1080,2))).status,200);
 assert.deepEqual(await stored(),[[null,null,null,null]],'a new upload clears the values');
 assert.deepEqual([(await consoleView()).consoleBackground.measured,(await consoleView()).consoleBackground.scrim],[false,backdropScrims(fallbackBackdropMeasure,null)],'and the console is back on the fallback');
 // The old version is stale now.
 assert.equal((await post({action:'measureBackground',version,measure})).status,200);
 assert.deepEqual(await stored(),[[null,null,null,null]],'the old version writes nothing');
 // A bundled choice uses its bundled measure; the upload measurement stays per upload.
 await post({action:'setBackground',area:'console',choice:'slate'});
 manage=(await (await routes.manage.GET()).json()).backgrounds.console;
 assert.deepEqual([manage.choice,manage.measured,manage.scrim],['slate',false,bundledScrim('slate')],'a bundled choice: its scrims; measured tells about the upload');
 // The public view does not change.
 as(null);
 assert.deepEqual(Object.keys(await (await routes.public.GET()).json()).sort(),['portal','signinBackground'],'GET /api/branding is unchanged');
}));

test('setScheme and clearScheme: the color checks, one audit row each, nothing for a repeat; the brand stylesheet with its headers and 304',async()=>fixture(async({routes,branding,owner,tech,as,post,audit,request})=>{
 const sheet=async headers=>routes.scheme.GET(request('/api/branding/scheme',{headers}));
 as(null);
 let response=await sheet();
 let body=await response.text();
 assert.equal(response.status,200);
 assert.deepEqual([response.headers.get('content-type'),response.headers.get('x-content-type-options'),response.headers.get('cache-control')],['text/css; charset=utf-8','nosniff','no-cache']);
 assert.equal(body,'/* No brand color scheme. */\n','an empty sheet without a scheme');
 assert.equal(response.headers.get('etag'),`"${sha(body)}"`,'the ETag is the sha256 of the body');
 as(tech);
 assert.deepEqual(await keyed(await post({action:'setScheme',primary:'#1e5adc',secondary:'#f07814'})),[403,'apiError.settings.ownerOnly']);
 as(owner);
 for(const [primary,secondary] of [['red','#f07814'],['#1E5ADC','#f07814'],['#fff','#f07814'],['#1e5adc',null],['#1e5adc;}x{','#f07814'],[undefined,undefined]])
  assert.deepEqual(await keyed(await post({action:'setScheme',primary,secondary})),[400,'apiError.branding.schemeColor'],`${primary}/${secondary}`);
 assert.deepEqual(await keyed(await post({action:'clearScheme'})),[200,undefined],'clearing an empty scheme answers the state');
 assert.deepEqual(await audit(),[],'no audit row for refusals or an empty clear');
 response=await post({action:'setScheme',primary:'#1e5adc',secondary:'#f07814'});
 assert.equal(response.status,200);
 assert.deepEqual((await response.json()).scheme,{primary:'#1e5adc',secondary:'#f07814'});
 assert.deepEqual(await audit(),[{actor:owner.label,action:'branding.scheme.set',target:'scheme',customerId:null}]);
 await post({action:'setScheme',primary:'#1e5adc',secondary:'#f07814'});
 assert.equal((await audit()).length,1,'the same colors again write nothing');
 assert.deepEqual((await branding.consoleBranding({owner:false,visibleCustomerIds:[],multipleCustomers:false})).scheme,{primary:'#1e5adc',secondary:'#f07814'},'the console view has the scheme');
 // The stylesheet: only --brand-* declarations with #rrggbb; the ETag answers 304.
 as(null);
 response=await sheet();
 body=await response.text();
 assert.match(body,/^:root\{(?:--brand-(?:light|dark)-[a-z-]+:#[0-9a-f]{6};)+--brand-dark-panel:#[0-9a-f]{6}\}\n$/,body);
 assert.equal(body.match(/--brand-/g).length,15,'every derived variable');
 const etag=response.headers.get('etag');
 assert.equal(etag,`"${sha(body)}"`);
 response=await sheet({'if-none-match':etag});
 assert.deepEqual([response.status,(await response.text()).length,response.headers.get('etag')],[304,0,etag],'304 for the current ETag');
 assert.equal((await sheet({'if-none-match':'"old"'})).status,200,'another ETag gets the body');
 // clearScheme: one audit row, the empty sheet again.
 as(owner);
 response=await post({action:'clearScheme'});
 assert.equal((await response.json()).scheme,null);
 assert.deepEqual((await audit()).map(row=>[row.action,row.target]),[['branding.scheme.set','scheme'],['branding.scheme.remove','scheme']]);
 await post({action:'clearScheme'});
 assert.equal((await audit()).length,2,'clearing again writes nothing');
 as(null);
 assert.equal(await (await sheet()).text(),'/* No brand color scheme. */\n');
}));
