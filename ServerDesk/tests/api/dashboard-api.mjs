// The Dashboard routes (app/api/account/dashboard/route.ts, app/api/dashboard/route.ts,
// app/api/dashboard/default/route.ts, lib/server/dashboard-data.ts, docs/dashboard.md) against an isolated PostgreSQL test
// database. Own layout (the widgets on the board with their sizes): the upsert, the empty board, the reset with null,
// strict bodies (a body of the first Dashboard and a size outside the range included), another origin, no viewer, own
// row only, the console background of the row stays, no audit row. Default layout: only a global Owner, the stored
// row, the same value again writes nothing, null deletes the row, one audit row per change. GET /api/console carries
// preferences.dashboard with the lenient reader, which also reads a stored layout of the first Dashboard. Alarm week: the hourly counts of the visible devices, the edges of
// the window, pending alarms left out, closed alarms counted, devices outside the customer boundary left out, an
// account without a device.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

const origin='https://portal.test',hour=3_600_000;
const keyed=async response=>{const sent=await response.json();return [response.status,sent.messageKey];};
const w=(id,width,height)=>({id,w:width,h:height});
// A layout as the first Dashboard stored it: one {id, shown} entry per tile.
const former=(order,hidden=[])=>order.map(id=>({id,shown:!hidden.includes(id)}));

test('dashboard: the own layout, the default layout, the console answer and the alarm week',async()=>{
 const d=await sourceDatabase();
 try{
  let viewer=null,time=Date.UTC(2026,10,18,14,20);
  const load=sourceLoader(),{HttpError}=load('lib/errors/http-error.ts'),{classifyFailure}=load('lib/server/errors/failure.ts');
  const failure=error=>{const answer=classifyFailure(error);if(answer.status>=500)console.error(error);return Response.json(answer.body,{status:answer.status,headers:{'Cache-Control':'no-store'}});};
  const server={db:()=>d,now:()=>time,config:name=>({SITE_ORIGIN:origin,SESSION_SECRET:'s',SESSION_SECRET_PREVIOUS:''})[name]??'',HttpError,failure,
   sameOrigin:request=>{if(request.headers.get('origin')!==origin)throw new HttpError('apiError.request.invalidOrigin');},
   requireViewer:async()=>{if(!viewer)throw new HttpError('apiError.auth.loginRequired');return viewer;},
   body:async request=>{try{const parsed=JSON.parse(await request.text());if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('object');return parsed;}catch{throw new HttpError('apiError.request.invalidJson');}},
   random:()=>'r',hash:async value=>value,log:async()=>{},guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x)};
  const imports={'./context':server,'../context':server,'../../context':server,'@/lib/server/context':server};
  const own=load('app/api/account/dashboard/route.ts',imports),fallback=load('app/api/dashboard/default/route.ts',imports),data=load('app/api/dashboard/route.ts',imports);
  const {builtInDashboardLayout:builtIn}=load('lib/dashboard-layout.ts');
  const dashboard=load('lib/server/dashboard-data.ts',imports),preferences=load('lib/server/account-preferences.ts',imports),access=load('lib/server/identity/access.ts',imports);
  const withUser=actor=>({...actor,userId:actor.id});
  const anna=withUser((await sourceActor(d,'anna@dashboard.test',['view'])).actor),ben=withUser((await sourceActor(d,'ben@dashboard.test',['view'])).actor);
  const owner=withUser((await sourceActor(d,'owner@dashboard.test',['*'])).actor),nobody=withUser((await sourceActor(d,'nobody@dashboard.test',[])).actor);
  const put=(route,body,headers={origin})=>route.PUT(new Request(origin+'/api/x',{method:'PUT',body:typeof body==='string'?body:JSON.stringify(body),headers:{'content-type':'application/json',...headers}}));
  const saved=async(route,value)=>{const response=await put(route,{layout:value});assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('cache-control'),'no-store');return (await response.json()).dashboard;};
  const ownRows=async()=>(await d.query(sql`SELECT user_id,console_background,dashboard_layout FROM account_preferences ORDER BY user_id`)).map(row=>[row.user_id,row.console_background,row.dashboard_layout&&JSON.parse(row.dashboard_layout).widgets]);
  const defaultRows=async()=>(await d.query(sql`SELECT id,default_layout,updated_by FROM dashboard_settings`)).map(row=>[Number(row.id),JSON.parse(row.default_layout).widgets,row.updated_by]);
  const audit=async()=>(await d.query(sql`SELECT actor,action,target,customer_id FROM audit ORDER BY id`)).map(row=>[row.actor,row.action,row.target,row.customer_id]);
  const custom=[w('jobs',4,3),w('alarms',2,2),w('alarm-week',2,2),w('offline',1,1)];

  // ---- PUT /api/account/dashboard: refusals ----
  assert.deepEqual(await keyed(await put(own,{layout:custom})),[401,'apiError.auth.loginRequired'],'no viewer');
  viewer=anna;
  assert.deepEqual(await keyed(await put(own,{layout:custom},{origin:'https://evil.test'})),[403,'apiError.request.invalidOrigin'],'another origin');
  for(const body of [{},{layout:custom,userId:ben.id},{widgets:custom},{layout:'alarms'},{layout:[...custom,w('weather',1,1)]},{layout:[...custom,custom[0]]},{layout:custom.map(item=>({...item,x:0}))},{layout:custom.map(item=>({id:item.id,w:item.w}))},
   {layout:former(['alarms','offline','updates','jobs','alarm-week'])},{layout:[w('jobs',5,1)]},{layout:[w('jobs',1,0)]},{layout:[w('jobs',1.5,1)]},{layout:[w('alarm-week',1,1)]},{layout:undefined},'not json','[1]'])
   assert.deepEqual(await keyed(await put(own,body)),[400,'apiError.request.invalid'],JSON.stringify(body));
  assert.deepEqual([await ownRows(),await defaultRows()],[[],[]],'nothing stored');

  // ---- the own layout: upsert, read, reset; only the viewer's row ----
  assert.deepEqual(await dashboard.dashboardPreference(anna),{own:null,default:builtIn},'no row: no own layout, the built-in default');
  assert.deepEqual(await saved(own,custom),{own:custom,default:builtIn},'the answer carries the stored layout');
  assert.deepEqual(await ownRows(),[[anna.id,true,custom]],'one row of the viewer; the console background keeps its default');
  const moved=[w('alarm-week',3,2),w('jobs',2,1)];
  assert.deepEqual(await saved(own,moved),{own:moved,default:builtIn},'a second save replaces the layout');
  await preferences.saveAccountPreferences(anna,{consoleBackground:false});
  assert.deepEqual(await ownRows(),[[anna.id,false,moved]],'saving the console background keeps the layout');
  viewer=ben;
  assert.deepEqual(await saved(own,custom),{own:custom,default:builtIn},'another account has its own layout');
  assert.deepEqual([await dashboard.dashboardPreference(anna),await dashboard.dashboardPreference(ben)],[{own:moved,default:builtIn},{own:custom,default:builtIn}],'each account reads only its own layout');
  viewer=anna;
  assert.deepEqual(await saved(own,null),{own:null,default:builtIn},'null: the account follows the default again');
  assert.deepEqual((await ownRows()).find(([id])=>id===anna.id),[anna.id,false,null],'the column is cleared and the console background stays');
  assert.deepEqual(await preferences.accountPreferences(anna),{consoleBackground:false},'the preferences keep their shape');
  assert.deepEqual(await audit(),[],'a personal layout writes no audit row');
  assert.deepEqual(await keyed(await put(own,{layout:custom})).then(([status])=>status),200,'a save after the reset');
  assert.deepEqual(await saved(own,[]),{own:[],default:builtIn},'an empty board is an own layout, not a reset');
  assert.deepEqual((await ownRows()).find(([id])=>id===anna.id),[anna.id,false,[]],'stored as an empty list');
  assert.deepEqual((await d.query(sql`SELECT dashboard_layout FROM account_preferences WHERE user_id=${anna.id}`))[0].dashboard_layout,'{"version":2,"widgets":[]}','the stored form is {version, widgets}');
  await saved(own,null);

  // ---- PUT /api/dashboard/default: Owner only ----
  const portalDefault=[w('offline',2,2),w('alarms',2,2),w('status',1,1)];
  assert.deepEqual(await keyed(await put(fallback,{layout:portalDefault})),[403,'apiError.settings.ownerOnly'],'an account that is no Owner');
  assert.deepEqual(await keyed(await put(fallback,'not json')),[403,'apiError.settings.ownerOnly'],'the right is checked before the body');
  viewer=null;
  assert.deepEqual(await keyed(await put(fallback,{layout:portalDefault})),[401,'apiError.auth.loginRequired'],'no viewer');
  viewer=owner;
  assert.deepEqual(await keyed(await put(fallback,{layout:portalDefault},{origin:'https://evil.test'})),[403,'apiError.request.invalidOrigin'],'another origin');
  for(const body of [{},{layout:[...portalDefault,w('weather',1,1)]},{layout:former(['alarms','jobs'])},{layout:portalDefault,all:true},'[1]'])assert.deepEqual(await keyed(await put(fallback,body)),[400,'apiError.request.invalid'],JSON.stringify(body));
  assert.deepEqual([await defaultRows(),await audit()],[[],[]],'nothing stored, nothing audited');
  assert.deepEqual(await saved(fallback,null),{own:null,default:builtIn},'null without a stored default writes nothing');
  assert.deepEqual(await audit(),[],'and no audit row');
  assert.deepEqual(await saved(fallback,portalDefault),{own:null,default:portalDefault},'the Owner stores the default');
  assert.deepEqual(await defaultRows(),[[1,portalDefault,owner.principal]],'one row with id 1');
  assert.deepEqual(await audit(),[[owner.label,'dashboard.default.set','layout',null]],'one audit row: the action, the target layout, no customer');
  assert.deepEqual(await saved(fallback,portalDefault),{own:null,default:portalDefault},'the same value again');
  assert.equal((await audit()).length,1,'writes no second audit row');
  assert.deepEqual([await dashboard.dashboardPreference(anna),await dashboard.dashboardPreference(ben)],[{own:null,default:portalDefault},{own:custom,default:portalDefault}],'an account without its own layout gets the default, an own layout stays');
  const second=[w('alarms',4,2),w('health',1,2)];
  assert.deepEqual((await saved(fallback,second)).default,second,'a changed default');
  assert.deepEqual([(await defaultRows()).length,(await audit()).map(row=>row[1])],[1,['dashboard.default.set','dashboard.default.set']],'still one row, a second audit row');
  // The built-in layout as an explicit default is stored like any other.
  assert.deepEqual((await saved(fallback,builtIn)).default,builtIn);
  assert.equal((await defaultRows()).length,1,'the built-in layout as an explicit default keeps the row');
  assert.deepEqual(await saved(fallback,null),{own:null,default:builtIn},'null: back to the built-in layout');
  assert.deepEqual([await defaultRows(),(await audit()).map(row=>row[1]).slice(-2)],[[],['dashboard.default.set','dashboard.default.remove']],'the row is gone, with the remove audit row');
  // A stored default that a later release cannot read fully: the lenient reader.
  await d.exec(sql`INSERT INTO dashboard_settings(id,default_layout,updated_at,updated_by) VALUES(1,${JSON.stringify({version:2,widgets:[w('jobs',9,9),w('weather',1,1),{id:'status'}]})},${time},'fixture')`);
  assert.deepEqual(await dashboard.dashboardDefaultLayout(),[w('jobs',4,3),w('status',1,1)],'unknown widgets are dropped and sizes come into the range');
  // A stored default of the first Dashboard that migration 0046 did not rewrite: read as its shown tiles.
  await d.exec(sql`UPDATE dashboard_settings SET default_layout=${JSON.stringify([{id:'jobs',shown:false},{id:'weather',shown:true},{id:'updates',shown:true}])}`);
  assert.deepEqual(await dashboard.dashboardDefaultLayout(),[w('updates',1,2),w('alarms',2,2),w('offline',1,2),w('alarm-week',2,2)],'a layout of the first Dashboard: hidden tiles are not on the board, missing ones are appended, each in its default size');
  await d.exec(sql`UPDATE dashboard_settings SET default_layout='{broken'`);
  assert.deepEqual(await dashboard.dashboardDefaultLayout(),builtIn,'an unreadable default acts as the built-in layout');
  await d.exec(sql`UPDATE account_preferences SET dashboard_layout='{broken' WHERE user_id=${ben.id}`);
  assert.deepEqual((await dashboard.dashboardPreference(ben)).own,null,'an unreadable own layout acts as none');
  await assert.rejects(d.exec(sql`INSERT INTO dashboard_settings(id,default_layout,updated_at,updated_by) VALUES(2,'[]',${time},'fixture')`),error=>error.code==='23514','only the row with id 1 exists');
  await d.exec(sql`DELETE FROM dashboard_settings`);
  await d.exec(sql`UPDATE account_preferences SET dashboard_layout=${JSON.stringify({version:2,widgets:custom})} WHERE user_id=${ben.id}`);

  // ---- GET /api/console carries preferences.dashboard ----
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
    '@/lib/server/dashboard-data':dashboard,
    '@/lib/server/identity/security-alarms':{consoleEmergencyAlarms:async()=>({open:0,latest:null})},
    '@/lib/server/agent/portal-certificate':{portalCertificateView:()=>null,portalRootCertificate:()=>null},
    '@/lib/server/console-data':{cancelPendingJob:async()=>{},consoleMaintenance:async()=>null,consolePreviousSecretRemovable:async()=>false,consoleAudit:async()=>[],consoleDevices:async()=>[],consoleJobs:async()=>[],consoleRunbookJobs:async()=>({runs:[],steps:[]}),enrollDevice:async()=>({}),enrollmentTarget:async()=>({}),jobById:async()=>null,multipleCustomers:async()=>false,pendingAgentUpdates:async()=>[]},
   };
   const answer=await sourceLoader()('app/api/console/route.ts',stubs).GET(new Request(origin+'/api/console'));
   assert.equal(answer.status,200,await answer.clone().text());
   return (await answer.json()).preferences;
  };
  assert.deepEqual(await consoleAnswer(ben),{consoleBackground:true,pinnedDeviceIds:[],dashboard:{own:custom,default:builtIn}},'the console carries the own layout and the default');
  assert.deepEqual((await consoleAnswer(anna)).dashboard,{own:null,default:builtIn},'an account without its own layout');
  assert.deepEqual(await dashboard.dashboardPreference({id:'token',label:'token',permissions:[]}),{own:null,default:builtIn},'a viewer without an account gets the built-in layout');

  // ---- GET /api/dashboard: the alarm week ----
  const start=Math.floor(time/hour)*hour-191*hour,uuid=()=>crypto.randomUUID();
  const defaultCustomer='00000000-0000-4000-8000-000000000100',customerB=uuid();
  const addDevice=async(name,customer=defaultCustomer)=>{const id=uuid();await insertRow(d,'servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:time,management:1,customer_id:customer});return id;};
  let alarm=0;
  const addAlarm=(serverId,openedAt,state='open')=>insertRow(d,'alerts',{id:uuid(),server_id:serverId,rule_id:'cpu-usage',key:'k'+(++alarm),state,level:'warning',peak_level:'warning',peak_value:null,threshold:null,params:'{}',
   started_at:openedAt??time-hour,opened_at:state==='pending'?null:openedAt,closed_at:state==='closed'?openedAt+60_000:null,close_reason:state==='closed'?'recovered':null});
  const weekOf=async who=>{viewer=who;const response=await data.GET();assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('cache-control'),'no-store');return (await response.json()).alarmWeek;};
  const filled=week=>Object.fromEntries(week.hours.map((count,index)=>[index,count]).filter(([,count])=>count));
  viewer=null;
  assert.deepEqual(await keyed(await data.GET()),[401,'apiError.auth.loginRequired'],'no viewer');
  let week=await weekOf(anna);
  assert.deepEqual([week.start,week.hours.length,filled(week)],[start,192,{}],'no device: 192 zeros from the full hour 191 hours before the current one');
  const a=await addDevice('Server A'),b=await addDevice('Server B');
  await addAlarm(a,start);await addAlarm(a,start+hour-1);await addAlarm(a,start+hour);
  await addAlarm(b,time);await addAlarm(b,start+191*hour,'closed');await addAlarm(a,start+5*hour+1234,'closed');
  await addAlarm(a,start-1);await addAlarm(a,start+192*hour);await addAlarm(a,null,'pending');
  week=await weekOf(anna);
  assert.deepEqual(filled(week),{0:2,1:1,5:1,191:2},'alarms count in the hour they opened: the first and the last hour, closed alarms too; before the window, after it and pending alarms do not');
  assert.equal(week.hours.reduce((sum,count)=>sum+count,0),6);
  assert.deepEqual(filled(await weekOf(owner)),{0:2,1:1,5:1,191:2},'the Owner sees the same devices');
  assert.deepEqual(filled(await weekOf(nobody)),{},'an account without a visible device gets zeros');
  // A later hour moves the window.
  time+=2*hour;
  week=await weekOf(anna);
  assert.deepEqual([week.start,filled(week)],[start+2*hour,{3:1,189:2,190:1}],'two hours later the window starts two hours later and takes in the alarm that lay after it');
  time-=2*hour;
  // Outside the customer boundary: the alarms of a device the viewer cannot see are not counted.
  await insertRow(d,'customers',{id:customerB,name:'Kunde B',created_at:time,updated_at:time});
  const outside=await addDevice('Server C',customerB);
  await addAlarm(outside,start+7*hour);await addAlarm(outside,time);
  await insertRow(d,'customer_assignments',{customer_id:defaultCustomer,principal_type:'user',principal_id:anna.id,created_at:time,created_by:'fixture'});
  assert.deepEqual([(await access.allowedDeviceIds(anna)).sort(),filled(await weekOf(anna))],[[a,b].sort(),{0:2,1:1,5:1,191:2}],'a device of another customer is not visible and its alarms are not counted');
  await insertRow(d,'customer_assignments',{customer_id:customerB,principal_type:'user',principal_id:anna.id,created_at:time,created_by:'fixture'});
  assert.deepEqual(filled(await weekOf(anna)),{0:2,1:1,5:1,7:1,191:3},'with the customer assignment they count');
  await d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${b}`);
  assert.deepEqual([(await access.allowedDeviceIds(anna)).includes(b),filled(await weekOf(anna))[191]],[false,1],'a removed device leaves the counts');

  // Deleting the account removes its row.
  await d.exec(sql`DELETE FROM role_assignments WHERE principal_id=${ben.id}`);
  await d.exec(sql`DELETE FROM local_users WHERE id=${ben.id}`);
  assert.equal((await ownRows()).some(([id])=>id===ben.id),false,'the account FK cascades');
 }finally{await d.close();}
});
