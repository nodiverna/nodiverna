// The personal display preferences (app/api/account/preferences/route.ts, lib/server/account-preferences.ts,
// docs/branding.md) against an isolated PostgreSQL test database: the console background is on without a row; PUT
// false needs the same origin and a live viewer, takes exactly {consoleBackground:boolean}, writes only the viewer's own
// row (no audit row) and shows in GET /api/console as `preferences`; another account keeps its default; deleting an
// account removes its row (FK cascade).
import assert from 'node:assert/strict';
import test from 'node:test';
import {sourceDatabase,sourceLoader,sourceActor} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

const origin='https://portal.test';
const keyed=async response=>{const sent=await response.json();return [response.status,sent.messageKey];};

test('the console background preference: default on, own row only, checks, the console answer and the cascade',async()=>{
 const d=await sourceDatabase();
 try{
  let viewer=null;
  const load=sourceLoader(),{HttpError}=load('lib/errors/http-error.ts'),{classifyFailure}=load('lib/server/errors/failure.ts');
  const failure=error=>{const answer=classifyFailure(error);if(answer.status>=500)console.error(error);return Response.json(answer.body,{status:answer.status,headers:{'Cache-Control':'no-store'}});};
  const server={db:()=>d,now:()=>Date.now(),config:name=>({SITE_ORIGIN:origin,SESSION_SECRET:'s',SESSION_SECRET_PREVIOUS:''})[name]??'',HttpError,failure,
   sameOrigin:request=>{if(request.headers.get('origin')!==origin)throw new HttpError('apiError.request.invalidOrigin');},
   requireViewer:async()=>{if(!viewer)throw new HttpError('apiError.auth.loginRequired');return viewer;},
   body:async request=>{try{const parsed=JSON.parse(await request.text());if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('object');return parsed;}catch{throw new HttpError('apiError.request.invalidJson');}},
   random:()=>'r',hash:async value=>value,log:async()=>{},guid:()=>true};
  const imports={'./context':server,'@/lib/server/context':server};
  const route=load('app/api/account/preferences/route.ts',imports),preferences=load('lib/server/account-preferences.ts',imports);
  const withUser=actor=>({...actor,userId:actor.id});
  const anna=withUser((await sourceActor(d,'anna@preferences.test',['view'])).actor),ben=withUser((await sourceActor(d,'ben@preferences.test',['*'])).actor);
  const put=(body,headers={origin})=>route.PUT(new Request(origin+'/api/account/preferences',{method:'PUT',body:typeof body==='string'?body:JSON.stringify(body),headers:{'content-type':'application/json',...headers}}));
  const stored=async()=>(await d.query(sql`SELECT user_id,console_background FROM account_preferences ORDER BY user_id`)).map(row=>[row.user_id,row.console_background]);

  // Default on, without a row.
  assert.deepEqual([await preferences.accountPreferences(anna),await preferences.accountPreferences(ben)],[{consoleBackground:true},{consoleBackground:true}]);
  // Refusals.
  assert.deepEqual(await keyed(await put({consoleBackground:false})),[401,'apiError.auth.loginRequired'],'no viewer');
  viewer=anna;
  assert.deepEqual(await keyed(await put({consoleBackground:false},{origin:'https://evil.test'})),[403,'apiError.request.invalidOrigin'],'another origin');
  for(const body of [{consoleBackground:'no'},{},{consoleBackground:false,userId:ben.id},{console_background:false},'not json','[false]'])
   assert.deepEqual(await keyed(await put(body)),[400,'apiError.request.invalid'],JSON.stringify(body));
  assert.deepEqual(await stored(),[],'nothing stored');
  // PUT false: the viewer's own row, the answer, no audit row; the other account keeps its default.
  let response=await put({consoleBackground:false});
  assert.deepEqual([response.status,await response.json()],[200,{consoleBackground:false}]);
  assert.deepEqual(await stored(),[[anna.id,false]],'only the viewer row');
  assert.deepEqual([await preferences.accountPreferences(anna),await preferences.accountPreferences(ben)],[{consoleBackground:false},{consoleBackground:true}]);
  assert.equal(Number((await d.one(sql`SELECT count(*) AS n FROM audit`)).n),0,'no audit row');
  response=await put({consoleBackground:true});
  assert.deepEqual(await response.json(),{consoleBackground:true},'and on again');
  await put({consoleBackground:false});

  // GET /api/console carries the viewer's preferences.
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
    '@/lib/server/account-preferences':preferences,
    '@/lib/server/pinned-devices':{pinnedDeviceIds:async()=>[]},
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
  assert.deepEqual(await consoleAnswer(anna),{consoleBackground:false,pinnedDeviceIds:[]},'the console shows the stored value');
  assert.deepEqual(await consoleAnswer(ben),{consoleBackground:true,pinnedDeviceIds:[]},'another account keeps the default');

  // Deleting the account removes its row.
  await d.exec(sql`DELETE FROM role_assignments WHERE principal_id=${anna.id}`);
  await d.exec(sql`DELETE FROM local_users WHERE id=${anna.id}`);
  assert.deepEqual(await stored(),[],'the FK cascades');
 }finally{await d.close();}
});
