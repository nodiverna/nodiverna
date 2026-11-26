// Pinned devices (app/api/account/pinned-devices/route.ts, lib/server/pinned-devices.ts, docs/device-workspace.md)
// against an isolated PostgreSQL test database: pin and unpin with the answer and GET /api/console
// preferences.pinnedDeviceIds; a repeat changes nothing; the 21st pin gives pinLimit with max 20; a device outside
// the customer boundary gives its not-found error and an invalid id device.invalid; a bad body, another origin and
// no viewer are refused; an account sees and changes only its own pins; a device or account delete cascades; a pin
// of a device the viewer can no longer see is left out of the list and shows again with the access; no audit row.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

const origin='https://portal.test';
const keyed=async response=>{const sent=await response.json();return [response.status,sent.messageKey,sent.params];};

test('pinned devices: own rows, the limit, the device checks, the console answer and the cascades',async()=>{
 const d=await sourceDatabase();
 try{
  let viewer=null,clock=Date.now();
  const load=sourceLoader(),{HttpError}=load('lib/errors/http-error.ts'),{classifyFailure}=load('lib/server/errors/failure.ts');
  const failure=error=>{const answer=classifyFailure(error);if(answer.status>=500)console.error(error);return Response.json(answer.body,{status:answer.status,headers:{'Cache-Control':'no-store'}});};
  const server={db:()=>d,now:()=>++clock,config:name=>({SITE_ORIGIN:origin,SESSION_SECRET:'s',SESSION_SECRET_PREVIOUS:''})[name]??'',HttpError,failure,
   sameOrigin:request=>{if(request.headers.get('origin')!==origin)throw new HttpError('apiError.request.invalidOrigin');},
   requireViewer:async()=>{if(!viewer)throw new HttpError('apiError.auth.loginRequired');return viewer;},
   body:async request=>{try{const parsed=JSON.parse(await request.text());if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('object');return parsed;}catch{throw new HttpError('apiError.request.invalidJson');}},
   random:()=>'r',hash:async value=>value,log:async()=>{},guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x)};
  const imports={'./context':server,'../context':server,'@/lib/server/context':server};
  const route=load('app/api/account/pinned-devices/route.ts',imports),pins=load('lib/server/pinned-devices.ts',imports);
  const withUser=actor=>({...actor,userId:actor.id});
  const anna=withUser((await sourceActor(d,'anna@pins.test',['view'])).actor),ben=withUser((await sourceActor(d,'ben@pins.test',['view'])).actor);
  const time=Date.now(),uuid=()=>crypto.randomUUID();
  const addDevice=async(name,customer='00000000-0000-4000-8000-000000000100')=>{const id=uuid();await insertRow(d,'servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:time,management:1,customer_id:customer});return id;};
  const devices=[];for(let index=1;index<=22;index++)devices.push(await addDevice('Server '+String(index).padStart(2,'0')));
  const put=(body,headers={origin})=>route.PUT(new Request(origin+'/api/account/pinned-devices',{method:'PUT',body:typeof body==='string'?body:JSON.stringify(body),headers:{'content-type':'application/json',...headers}}));
  const pin=async(deviceId,pinned=true)=>{const response=await put({deviceId,pinned});assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('cache-control'),'no-store');return (await response.json()).pinnedDeviceIds;};
  const stored=async()=>(await d.query(sql`SELECT user_id,device_id FROM account_pinned_devices ORDER BY created_at,device_id`)).map(row=>[row.user_id,row.device_id]);
  const [a,b,c]=devices;

  // Refusals.
  assert.deepEqual(await keyed(await put({deviceId:a,pinned:true})),[401,'apiError.auth.loginRequired',undefined],'no viewer');
  viewer=anna;
  assert.deepEqual((await keyed(await put({deviceId:a,pinned:true},{origin:'https://evil.test'}))).slice(0,2),[403,'apiError.request.invalidOrigin'],'another origin');
  for(const body of [{deviceId:a,pinned:'yes'},{deviceId:a},{pinned:true},{deviceId:a,pinned:true,userId:ben.id},{deviceId:7,pinned:true},'not json','[1]'])
   assert.deepEqual((await keyed(await put(body))).slice(0,2),[400,'apiError.request.invalid'],JSON.stringify(body));
  assert.deepEqual((await keyed(await put({deviceId:'not-a-guid',pinned:true}))).slice(0,2),[400,'apiError.device.invalid'],'an invalid id');
  assert.deepEqual((await keyed(await put({deviceId:uuid(),pinned:true}))).slice(0,2),[404,'apiError.device.notFound'],'an unknown device');
  assert.deepEqual(await stored(),[],'nothing stored');

  // Pin, repeat, unpin: the answer lists the pins oldest first.
  assert.deepEqual(await pin(b),[b]);
  assert.deepEqual(await pin(a),[b,a],'oldest first');
  assert.deepEqual(await pin(a),[b,a],'a repeat changes nothing');
  assert.deepEqual(await pin(c,false),[b,a],'unpinning a device that is not pinned changes nothing');
  assert.deepEqual(await pin(b,false),[a],'unpinned');
  assert.deepEqual(await stored(),[[anna.id,a]],'only the viewer row');

  // Another account: its own list, and it cannot change the pins of anna.
  viewer=ben;
  assert.deepEqual(await pin(c),[c],'ben sees only his own pin');
  assert.deepEqual(await pin(a,false),[c],'unpinning a device that only anna pinned changes nothing');
  assert.deepEqual([await pins.pinnedDeviceIds(anna),await pins.pinnedDeviceIds(ben)],[[a],[c]]);

  // The limit: 20 pins, the 21st is refused in the same statement; a repeat at the limit still answers.
  viewer=anna;
  for(const device of devices.slice(1,20))await pin(device);
  assert.equal((await pins.pinnedDeviceIds(anna)).length,20);
  assert.deepEqual(await keyed(await put({deviceId:devices[20],pinned:true})),[400,'apiError.account.pinLimit',{max:20}],'the 21st pin');
  assert.equal((await pin(a)).length,20,'a repeat at the limit is no error');
  assert.equal((await pins.pinnedDeviceIds(anna)).length,20,'still 20');

  // GET /api/console carries the visible pins.
  const consoleAnswer=async who=>{
   const stubs={
    '@/lib/server/context':{...server,requireViewer:async()=>who},
    '@/lib/server/identity/policy/can':{can:async(actor,right)=>right==='instance.owner'&&actor.permissions.includes('*'),requireCan:async()=>{},viewerCanSql:()=>'TRUE'},
    '@/lib/server/identity/access':{allowedDeviceIds:async()=>[],effectivePermissions:async()=>new Map(),principal:()=>'p',requireDevice:async()=>{},requireGroup:async()=>{}},
    '@/lib/server/devices/device-lifecycle':{offboardingStatus:async()=>[],removeDevice:async()=>{},removeDevices:async()=>{},requestAgentUninstall:async()=>{},sweepRemovedTransfers:async()=>{},validateDeviceRemoval:()=>{}},
    '@/lib/server/devices/rdp':{sweepRdp:async()=>{}},
    '@/lib/server/audit-scope':{deviceAuditGuard:()=>'',portalAuditGuard:()=>''},
    '@/lib/server/devices/device-group-catalog':{deviceGroupCatalog:async()=>[],devicePermissionTargets:async()=>[]},
    '@/lib/server/extensions/plugin-releases':{latestPluginReleases:async()=>[]},
    '@/lib/server/identity/customers':{visibleCustomers:async()=>[]},
    '@/lib/server/branding':{consoleBranding:async()=>({portal:{light:null,dark:null,icon:null},customers:{},consoleBackground:null,scheme:null})},
    '@/lib/server/account-preferences':{accountPreferences:async()=>({consoleBackground:true})},
    '@/lib/server/pinned-devices':pins,
    // The Dashboard layout of the answer has its own test (tests/api/dashboard-api.mjs); here it is left out.
    '@/lib/server/dashboard-data':{dashboardPreference:async()=>undefined},
    '@/lib/server/identity/security-alarms':{consoleEmergencyAlarms:async()=>({open:0,latest:null})},
    '@/lib/server/agent/portal-certificate':{portalCertificateView:()=>null,portalRootCertificate:()=>null},
    '@/lib/server/console-data':{cancelPendingJob:async()=>{},consoleMaintenance:async()=>null,consolePreviousSecretRemovable:async()=>false,consoleAudit:async()=>[],consoleDevices:async()=>[],consoleJobs:async()=>[],consoleRunbookJobs:async()=>({runs:[],steps:[]}),enrollDevice:async()=>({}),enrollmentTarget:async()=>({}),jobById:async()=>null,multipleCustomers:async()=>false,pendingAgentUpdates:async()=>[]},
   };
   const answer=await sourceLoader()('app/api/console/route.ts',stubs).GET(new Request(origin+'/api/console'));
   assert.equal(answer.status,200,await answer.clone().text());
   return (await answer.json()).preferences;
  };
  assert.deepEqual(await consoleAnswer(ben),{consoleBackground:true,pinnedDeviceIds:[c]},'the console shows the pins');
  assert.deepEqual((await consoleAnswer(anna)).pinnedDeviceIds,devices.slice(0,20),'in pin order');

  // Unpin frees a place again.
  assert.equal((await pin(devices[19],false)).length,19);
  assert.equal((await pin(devices[20])).length,20,'a free place takes a new pin');

  // A device outside the customer boundary answers as unknown; a pin of a device that the viewer can no longer
  // see is left out and does not count, and it shows again when the access returns.
  const customerB=uuid();
  await insertRow(d,'customers',{id:customerB,name:'Kunde B',created_at:time,updated_at:time});
  const outside=await addDevice('Server B',customerB);
  assert.deepEqual(await keyed(await put({deviceId:outside,pinned:true})),[404,'apiError.device.notFound',undefined],'outside the boundary');
  assert.deepEqual(await pins.pinnedDeviceIds(anna),[],'no customer assignment: no visible pin');
  assert.equal(Number((await d.one(sql`SELECT count(*) AS n FROM account_pinned_devices WHERE user_id=${anna.id}`)).n),20,'the rows stay');
  await insertRow(d,'customer_assignments',{customer_id:'00000000-0000-4000-8000-000000000100',principal_type:'user',principal_id:anna.id,created_at:time,created_by:'fixture'});
  assert.equal((await pins.pinnedDeviceIds(anna)).length,20,'the access returns, the pins show again');
  await insertRow(d,'customer_assignments',{customer_id:customerB,principal_type:'user',principal_id:anna.id,created_at:time,created_by:'fixture'});
  assert.deepEqual(await keyed(await put({deviceId:outside,pinned:true})),[400,'apiError.account.pinLimit',{max:20}],'assigned now, but at the limit');
  await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${devices[0]}`);
  assert.equal((await pins.pinnedDeviceIds(anna)).length,19,'a revoked device is left out');
  assert.deepEqual((await pin(outside)).at(-1),outside,'and its place is free');

  // Deleting a device or an account removes its rows.
  await d.exec(sql`DELETE FROM servers WHERE id=${c}`);
  assert.deepEqual(await pins.pinnedDeviceIds(ben),[],'the device FK cascades');
  await d.exec(sql`DELETE FROM role_assignments WHERE principal_id=${anna.id}`);
  await d.exec(sql`DELETE FROM customer_assignments WHERE principal_id=${anna.id}`);
  await d.exec(sql`DELETE FROM local_users WHERE id=${anna.id}`);
  assert.deepEqual(await stored(),[],'the account FK cascades');
  assert.equal(Number((await d.one(sql`SELECT count(*) AS n FROM audit`)).n),0,'no audit row');
 }finally{await d.close();}
});
