// Settings → Agent releases on the kit: the real page ui/settings/agent-releases-page.tsx with the real release source
// card (ui/settings/release-source.tsx), the real useStepUp and useFrameRefresh, on deterministic hooks; kit parts stay
// named nodes. Covered: one SettingsPage with its loading and error look, the page primary "Check now" in the
// frame header with its blocked reason and polling, the refresh of the console, the release source card (state
// pill and failure notice first, Last check and Source as Facts, the imports DataTable with the reason text of a
// failed row, and no token form, confirmation or step-up dialog in the card since the repository is public), the agent releases DataTable (columns, sorting, Latest tag, sizes), the row
// menu with its blocked entries and both confirmations sent through useStepUp, the details Drawer, the empty
// state, the switch "Import dev builds" (only with the Owner's source, optimistic through useStepUp, rolled back on a
// failure) and the neutral "Dev build" tag of dev builds (table, drawer, imports; never "Latest"), and source guards
// (no window.confirm, DetailDrawer, shadcn, ErrorNote, KPI style or English literals).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {de,i18nRequire,formatModule,translateModule} from '../../support/i18n-stubs.mjs';
const {translate}=translateModule;

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
const stepUpRules=await import('../../../lib/step-up.ts'),codes=await import('../../../lib/errors/codes.ts'),tableSort=await import('../../../ui/base/table-sort.ts');
const releaseVersion=await import('../../../runtime/release-version.mjs');

const releases=[
 {id:'latest',version:'4.9.0',sha256:'a'.repeat(64),size:5*1048576,createdAt:10,active:true,latest:true,changelog:null},
 {id:'older',version:'4.8.0',sha256:'b'.repeat(64),size:100,createdAt:5,active:true,latest:false,changelog:{features:['Neue Funktion'],fixes:[]}},
 {id:'disabled',version:'4.10.0-rc',sha256:'c'.repeat(64),size:2048,createdAt:1,active:false,latest:false,changelog:null},
];
const view=(overrides={})=>({repository:'nodiverna/nodiverna',state:'idle',lastStartedAt:1000,lastFinishedAt:2000,lastError:null,devBuilds:false,imports:[],...overrides});

/** The page with fake hooks; get answers GET /api/releases, post the POSTs. */
function harness({get=async()=>({releases,source:view()}),post=async()=>({ok:true})}={}){
 const cells=[],effects=[],calls=[],intervals=new Map(),toasts=[];let cursor=0,dirty=false,tree;
 const changed=(old,deps)=>!old||!deps||deps.some((value,index)=>!Object.is(value,old.deps?.[index]));
 const hooks={
  useState(initial){const index=cursor++;cells[index]??={value:typeof initial==='function'?initial():initial};return [cells[index].value,next=>{const value=typeof next==='function'?next(cells[index].value):next;if(!Object.is(value,cells[index].value)){cells[index].value=value;dirty=true;}}];},
  useRef(initial){const index=cursor++;cells[index]??={value:{current:initial}};return cells[index].value;},
  useCallback(fn,deps){const index=cursor++,old=cells[index];if(changed(old,deps))cells[index]={deps,value:fn};return cells[index].value;},
  useEffect(fn,deps){const index=cursor++,old=cells[index];if(changed(old,deps))effects.push(()=>{old?.cleanup?.();cells[index]={deps,cleanup:fn()};});},
 };
 const jsx=(type,props)=>typeof type==='function'?type(props??{}):({type,props:props??{}});
 const toast={success:text=>toasts.push(['success',text]),error:text=>toasts.push(['error',text])};
 const api=async(url,payload)=>{calls.push({url,payload});return payload?post(payload):get();};
 const kit={Btn:'Btn',Card:'Card',CopyValue:'CopyValue',Drawer:'Drawer',Facts:'Facts',IconTile:'IconTile',Menu:'Menu',Notice:'Notice',SettingsPage:'SettingsPage',StatusPill:'StatusPill',
  exactTime:value=>'exact:'+value,relativeTime:(value,now)=>'ago:'+(now-value)};
 const modules={};
 const load=(file,extra={})=>{
  if(modules[file])return modules[file];
  const mod={exports:{}};modules[file]=mod.exports;
  const require=id=>{
   const stub=extra[id]??i18nRequire(id);if(stub)return stub;
   if(id==='react')return hooks;if(id==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};
   if(id==='lucide-react')return new Proxy({}, {get:(_target,key)=>String(key)});if(id.endsWith('.css'))return {};
   const shared={'sonner':{toast},'@/ui/base/clock-store':{useClockNow:pinned=>pinned??Date.now(),consoleClock:{now:()=>Date.now()}},'@/ui/base/api':{api,ApiError,message:error=>error.message},'@/ui/session/mfa-step-up':{MfaStepUp:'MfaStepUp'},'@/ui/kit/kit':kit,
    '@/ui/kit/confirm-dialog':{ConfirmDialog:'ConfirmDialog'},'@/ui/kit/data-table':{DataTable:'DataTable'},'@/ui/kit/field':{Field:'Field',Switch:'Switch'},'@/lib/agent-update-state':{isDevVersion:releaseVersion.isDevVersion},
    '@/lib/step-up':stepUpRules,'@/lib/errors/codes':codes,'@/ui/base/table-sort':tableSort,'@/lib/i18n/format':formatModule,
    '@/ui/session/step-up-retry':()=>load('ui/session/step-up-retry.ts',{'@/ui/base/api':{message:error=>error.message}}),'@/ui/shell/page-frame':()=>load('ui/shell/page-frame.ts'),'@/ui/settings/release-source':()=>load('ui/settings/release-source.tsx')};
   const found=shared[id];if(found)return typeof found==='function'?found():found;
   throw Error('Unexpected import '+id);
  };
  new Function('require','module','exports','setInterval','clearInterval',compile(path.resolve(file)))(require,mod,mod.exports,(fn,ms)=>{const id=Math.random();intervals.set(id,{fn,ms});return id;},id=>intervals.delete(id));
  modules[file]=mod.exports;return mod.exports;
 };
 const page=load('ui/settings/agent-releases-page.tsx');
 const headers=[];
 const props={servers:[],viewer:{id:'owner',permissions:['*']},demo:false,now:9000,onConfirm(){},frame:{header:primary=>{headers.push(primary);return {type:'PageHeader',props:{primary}};},refresh:0}};
 function nodes(node){if(arguments.length===0)node=tree;if(!node||typeof node!=='object')return [];if(Array.isArray(node))return node.flatMap(item=>nodes(item));return [node,...[node.props?.children,node.props?.actions,node.props?.wide,node.props?.primary].flat(Infinity).flatMap(child=>nodes(child))];}
 const text=node=>!node||typeof node!=='object'?(typeof node==='string'||typeof node==='number'?String(node):''):Array.isArray(node)?node.map(text).join(''):[node.props?.title,node.props?.children,(node.props?.items??[]).map(item=>[item.label,item.value,item.hint])].flat(Infinity).map(child=>typeof child==='string'||typeof child==='number'?child:text(child)).join(' ');
 function render(){let limit=0;do{cursor=0;dirty=false;headers.length=0;tree=page.default(props);for(const effect of effects.splice(0))effect();if(limit++>10)throw Error('Unstable render');}while(dirty);}
 async function settle(){for(let n=0;n<20;n++){await new Promise(resolve=>setImmediate(resolve));if(dirty||effects.length)render();}}
 const find=predicate=>nodes().find(predicate);
 render();
 return {props,calls,toasts,intervals,page,render,settle,find,nodes,text:node=>text(node??tree),
  posts:()=>calls.filter(call=>call.payload).map(call=>call.payload),gets:()=>calls.filter(call=>!call.payload).length,
  primary:()=>headers.at(-1),settings:()=>find(node=>node.type==='SettingsPage'),
  table:()=>find(node=>node.type==='DataTable'&&node.props.label===de('releases.title')),
  imports:()=>find(node=>node.type==='DataTable'&&node.props.label===de('releaseSource.importsCaption')),
  confirm:()=>find(node=>node.type==='ConfirmDialog'&&node.props.open),dialogs:()=>nodes().filter(node=>node.type==='MfaStepUp'),
  openDialog:()=>nodes().find(node=>node.type==='MfaStepUp'&&node.props.open),
  periods:()=>[...intervals.values()].map(entry=>entry.ms)};
}

// ---- The frame: one SettingsPage, loading, error, the page primary and the refresh ----
{
 let ui=harness();
 check([ui.settings().props.loading,ui.settings().props.label,ui.settings().props.className],[true,de('nav.settings.agentReleases'),'sdx-agent-releases-page'],'first load: SettingsPage loading with the page label');
 await ui.settle();
 check([ui.gets(),ui.settings().props.loading,ui.settings().props.loadError],[1,false,undefined],'one GET, then the content');
 const wide=ui.settings().props.wide;
 check(ui.nodes(wide).filter(node=>['Card','PluginReleases','ExtensionReleases'].includes(node.type)).map(node=>node.type==='Card'?node.props.title:node.type),[de('releases.title')],'only the agent releases are the wide content: the extension releases have their own page');
 ok(!ui.text(wide).includes(de('extensions.releases.title')),'no extension release card on Agent releases');
 ok(ui.nodes(ui.settings().props.children).some(node=>node.type==='Card'&&node.props.title===de('releaseSource.title')),'the release source card is in the column');
 const primary=ui.primary();
 check([primary.type,primary.props.variant,primary.props.icon,primary.props.children,primary.props.blocked,primary.props.loading],['Btn','primary','RefreshCw',de('releaseSource.checkNow'),undefined,false],'the page primary Check now (RefreshCw) in the frame header');
 ok(!ui.nodes(ui.settings()).some(node=>node.type==='Btn'&&[node.props.children].flat().join('')===de('releaseSource.checkNow')),'the release source card head has no Check now');
 check(ui.periods(),[60000],'idle: the page asks every minute');
 ui.props.frame={...ui.props.frame,refresh:1};ui.render();await ui.settle();
 check(ui.gets(),2,'a console refresh runs the GET again');
 check(ui.settings().props.loading,false,'the loaded data stays visible');

 let state='idle';
 ui=harness({get:async()=>({releases,source:view({state})}),post:async payload=>{if(payload.action==='check'){state='queued';return {source:view({state:'queued'})};}throw Error('unexpected');}});await ui.settle();
 ui.primary().props.onClick();ui.render();
 check(ui.primary().props.loading,true,'Check now is loading while its request runs');
 await ui.settle();
 check([ui.posts(),ui.toasts],[[{action:'check'}],[['success',de('releaseSource.checkQueued')]]],'Check now posts check and confirms with releaseSource.checkQueued');
 check([ui.primary().props.blocked,ui.periods()],[de('releaseSource.blocked.running'),[5000]],'blocked while queued; the page asks every 5 seconds');
 ui=harness({get:async()=>({releases,source:view({state:'running'})})});await ui.settle();
 check([ui.primary().props.blocked,ui.find(node=>node.type==='StatusPill').props.kind,ui.find(node=>node.type==='StatusPill').props.size],[de('releaseSource.blocked.running'),'waiting','lg'],'running: blocked, the waiting pill in the large focal size');

 let fail=false;
 ui=harness({get:async()=>{if(fail)throw new ApiError('offline',503);return {releases,source:view()};}});await ui.settle();
 fail=true;[...ui.intervals.values()][0].fn();await ui.settle();
 check(ui.settings().props.loadError,`${de('releases.loadFailed')} ${de('notifications.staleData')}`,'a failed reload keeps the data and ends with the stale-data note');
 ok(!!ui.table(),'the table stays');
 ui=harness({get:async()=>{throw new ApiError('offline',503);}});await ui.settle();
 check([ui.settings().props.loading,ui.settings().props.loadError,ui.table()],[false,de('releases.loadFailed'),undefined],'a first failure shows releases.loadFailed');
 ui.settings().props.onRetry();await ui.settle();
 check(ui.gets(),2,'Try again repeats the GET');
}

// ---- The release source card ----
{
 let ui=harness({get:async()=>({releases,source:view({imports:[{tag:'agent-v4.12.1',version:'4.12.1',source:'github',status:'failed',reason:'serverMessage.releaseImport.signatureInvalid',releaseId:null,attemptedAt:1500}]})})});await ui.settle();
 const card=ui.find(node=>node.type==='Card'&&node.props.title===de('releaseSource.title'));
 const body=ui.nodes(card),order=body.filter(node=>['StatusPill','Notice','Facts','form','DataTable'].includes(node.type)).map(node=>node.type);
 check(order,['StatusPill','Facts','DataTable'],'idle: the state pill leads, then the facts and the imports');
 check(body.filter(node=>['Field','form','ConfirmDialog','MfaStepUp','input'].includes(node.type)).map(node=>node.type),[],'no token Field, form, input, ConfirmDialog or MfaStepUp in the card');
 check(ui.nodes().filter(node=>node.type==='Btn'&&/token/i.test([node.props.children].flat().join(''))).length,0,'no Save token or Remove token button');
 check(ui.dialogs().length,2,'the page keeps one MfaStepUp for the retire flow of the release table and one for the dev builds switch');
 const facts=body.find(node=>node.type==='Facts');
 check(facts.props.items.map(item=>[item.id,item.mono??false]),[['lastCheck',false],['source',true]],'Last check and Source (mono) as Facts');
 const last=facts.props.items[0];
 check([last.value.type,/^ago:\d+$/.test(last.value.props.children),last.value.props.dateTime,last.hint],['time',true,new Date(2000).toISOString(),'exact:2000'],'Last check: the relative time (to the load), the exact time as hint');
 const imports=ui.imports();
 check([imports.props.cards,imports.props.empty.title,imports.props.rows.length],[true,de('releaseSource.emptyTitle'),1],'the imports are a DataTable with cards and the existing empty state');
 ok(String(imports.props.columns.find(column=>column.id==='details').cell(imports.props.rows[0])).includes(de('serverMessage.releaseImport.signatureInvalid')),'an import row shows its reason text');
 ok(ui.text(card).includes(de('releaseSource.noRollout')),'the no-rollout note');
 // An extension import row carries the tag Extension (releaseSource.extensionTag), never Plugin.
 {
  const row={tag:'plugin-dhcp-v1.1.0',kind:'plugin',version:'1.1.0',status:'imported',source:'github',reason:null,attemptedAt:1000};
  const cell=imports.props.columns.find(column=>column.id==='version').cell(row);
  check([ui.text(cell).replace(/\s+/g,' ').trim(),translate('en','releaseSource.extensionTag'),de('releaseSource.extensionTag')],['plugin-dhcp-v1.1.0 '+de('releaseSource.extensionTag'),'Extension','Erweiterung'],'the extension row tag');
 }
 ui=harness({get:async()=>({releases,source:view({state:'failed',lastError:'serverMessage.releaseImport.notFound'})})});await ui.settle();
 const failed=ui.nodes(ui.find(node=>node.type==='Card'&&node.props.title===de('releaseSource.title'))).filter(node=>['StatusPill','Notice','Facts'].includes(node.type));
 check([failed.map(node=>node.type),failed[0].props.kind,failed[1].props.tone],[['StatusPill','Notice','Facts'],'critical','danger'],'V7: failed: the pill and the danger notice lead the card');
 ok(ui.text(failed[1]).includes(de('serverMessage.releaseImport.notFound')),'the failure reason');
 check(ui.nodes(ui.find(node=>node.type==='Card'&&node.props.title===de('releaseSource.title'))).filter(node=>['StatusPill','Notice','Facts','DataTable'].includes(node.type)).map(node=>node.type),['StatusPill','Notice','Facts','DataTable'],'failed: pill, notice, facts, imports');
 // A list that GitHub rate limited: the notice says what happened and when it recovers.
 ui=harness({get:async()=>({releases,source:view({state:'failed',lastError:'serverMessage.releaseImport.rateLimited',imports:[{tag:'agent-v4.13.0',version:'4.13.0',source:'github',status:'failed',reason:'serverMessage.releaseImport.rateLimited',releaseId:null,attemptedAt:1500}]})})});await ui.settle();
 ok(ui.text(ui.find(node=>node.type==='Notice')).includes(de('serverMessage.releaseImport.rateLimited')),'the rate-limit notice');
 const limited=ui.imports();
 check(limited.props.columns.find(column=>column.id==='details').cell(limited.props.rows[0]),de('serverMessage.releaseImport.rateLimited'),'a rate-limited import row shows the German rateLimited text in Details');
 check(de('serverMessage.releaseImport.rateLimited'),'GitHub begrenzt die Anfragen dieses Portals gerade. Das Limit wird innerhalb einer Stunde zurückgesetzt, und die nächste Prüfung versucht es erneut.','the German rateLimited text');
 check(limited.props.columns.find(column=>column.id==='details').cell({...limited.props.rows[0],status:'imported',reason:null}),'—','a row without a reason shows —');
 ui=harness({get:async()=>({releases,source:view({lastStartedAt:null,lastFinishedAt:null})})});await ui.settle();
 check(ui.find(node=>node.type==='Facts').props.items[0].value,de('releaseSource.never'),'Never without a check');
}
// ---- Import dev builds: the switch of the Owner's source card and the "Dev build" tags ----
{
 let ui=harness({get:async()=>({releases})});await ui.settle();
 check(ui.nodes().filter(node=>node.type==='Switch').length,0,'no switch without the source (only the Owner gets it)');
 let devBuilds=false;
 ui=harness({get:async()=>({releases,source:view({devBuilds})}),post:async payload=>{if(payload.action==='devBuilds'){devBuilds=payload.enabled;return {source:view({devBuilds})};}throw Error('unexpected');}});await ui.settle();
 const card=ui.find(node=>node.type==='Card'&&node.props.title===de('releaseSource.title'));
 const switches=ui.nodes(card).filter(node=>node.type==='Switch');
 check(switches.map(node=>[node.props.label,node.props.hint,node.props.checked,node.props.busy]),[[de('releaseSource.devBuilds.label'),de('releaseSource.devBuilds.hint'),false,false]],'one Switch with its label and hint, off');
 check(ui.nodes(card).filter(node=>['StatusPill','Facts','Switch','p'].includes(node.type)).map(node=>node.type),['StatusPill','Facts','Switch','p'],'below the facts, above the no-rollout note');
 check([translate('en','releaseSource.devBuilds.label'),de('releaseSource.devBuilds.label')],['Import dev builds','Dev-Builds importieren'],'the label in both catalogs');
 const pending=switches[0].props.onChange(true);ui.render();
 check(ui.find(node=>node.type==='Switch').props.busy,true,'busy while the request runs');
 check(await pending,true,'the switch keeps the new state');
 await ui.settle();
 check([ui.posts(),ui.toasts.at(-1),ui.find(node=>node.type==='Switch').props.checked,ui.find(node=>node.type==='Switch').props.busy],[[{action:'devBuilds',enabled:true}],['success',de('releaseSource.devBuilds.onToast')],true,false],'the request, the toast and the new state');
 check(await ui.find(node=>node.type==='Switch').props.onChange(false),true,'turned off again');await ui.settle();
 check(ui.toasts.at(-1),['success',de('releaseSource.devBuilds.offToast')],'the off toast');
 // A running check does not block the switch.
 ui=harness({get:async()=>({releases,source:view({state:'running'})})});await ui.settle();
 check(ui.find(node=>node.type==='Switch').props.blocked,undefined,'not blocked by a running check');
 // A failure rolls back (false) with toast.error(message(failure)).
 ui=harness({get:async()=>({releases,source:view()}),post:async()=>{throw new ApiError('Nicht erlaubt.',403,'RELEASE_SOURCE_OWNER_ONLY');}});await ui.settle();
 check(await ui.find(node=>node.type==='Switch').props.onChange(true),false,'a refused change rolls back');
 check([ui.toasts,ui.find(node=>node.type==='Switch').props.checked],[[['error','Nicht erlaubt.']],false],'the error toast; the source stays off');
 // The Dev build tag: table (never Latest), drawer description, import rows.
 const dev={id:'dev',version:'4.10.0-dev.abc1234',sha256:'d'.repeat(64),size:300,createdAt:20,active:true,latest:false,dev:true,changelog:{features:['Dev build from commit abc1234.'],fixes:[]}};
 const imported={tag:'agent-v4.10.0-dev.abc1234',kind:'agent',version:'4.10.0-dev.abc1234',status:'imported',source:'github',reason:null,attemptedAt:1000};
 const pluginDev={tag:'plugin-dns-v1.0.4-dev.abc1234',kind:'plugin',version:'1.0.4-dev.abc1234',status:'imported',source:'github',reason:null,attemptedAt:1000};
 ui=harness({get:async()=>({releases:[dev,...releases],source:view({devBuilds:true,imports:[imported,pluginDev]})})});await ui.settle();
 const table=ui.table(),version=row=>ui.text(table.props.columns.find(column=>column.id==='version').cell(row)).replace(/\s+/g,' ').trim();
 check([version(dev),version(releases[0]),version(releases[1])],[`4.10.0-dev.abc1234 ${de('releases.devBuild')}`,`4.9.0 ${de('releases.latest')}`,'4.8.0'],'the Dev build tag after the version; Latest stays on the release');
 const tags=ui.nodes(table.props.columns.find(column=>column.id==='version').cell(dev)).filter(node=>node.type==='span'&&String(node.props.className).includes('sdx-tag'));
 check(tags.map(node=>node.props.className),['sdx-tag'],'a neutral tag, not the accent sdx-tag-changed');
 check([translate('en','releases.devBuild'),de('releases.devBuild')],['Dev build','Dev-Build'],'the tag in both catalogs');
 table.props.onOpen(dev);ui.render();
 check(ui.text(ui.find(node=>node.type==='Drawer').props.description).trim(),de('releases.devBuild'),'the drawer description is the Dev build tag');
 const importCell=row=>ui.text(ui.imports().props.columns.find(column=>column.id==='version').cell(row)).replace(/\s+/g,' ').trim();
 check([importCell(imported),importCell(pluginDev)],[`4.10.0-dev.abc1234 ${de('releases.devBuild')}`,`plugin-dns-v1.0.4-dev.abc1234 ${de('releaseSource.extensionTag')} ${de('releases.devBuild')}`],'the import rows of dev builds carry the tag');
 check(importCell({...imported,version:'4.10.0',tag:'agent-v4.10.0'}),'4.10.0','a release import row has no tag');
}

// ---- The agent releases table, the row menu, the confirmations and the drawer ----
{
 let ui=harness();await ui.settle();
 const table=ui.table();
 check([table.props.label,table.props.cards,table.props.entranceId,table.props.rows.map(row=>row.id)],[de('releases.title'),true,'agent-releases',['latest','older','disabled']],'a DataTable with cards and an entranceId, in the server order');
 check(table.props.columns.map(column=>[column.id,column.label,!!column.sort]),[['version',de('releases.col.version'),true],['status',de('releases.col.status'),false],['size',de('releases.col.size'),false],['registered',de('releases.registered'),true],['actions',de('fleet.col.actions'),false]],'Version and Registered sort');
 const cell=(id,row)=>table.props.columns.find(column=>column.id===id).cell(row);
 check(ui.text(cell('version',releases[0])).replace(/\s+/g,' ').trim(),`4.9.0 ${de('releases.latest')}`,'the Latest tag');
 check([cell('status',releases[0]).props.kind,ui.text(cell('status',releases[0])).trim(),cell('status',releases[2]).props.kind,ui.text(cell('status',releases[2])).trim()],['success',de('releases.available'),'neutral',de('releases.disabled')],'the status pills');
 check([cell('size',releases[0]),cell('size',releases[1])],[formatModule.formatBytes('de',5*1048576),formatModule.formatBytes('de',100)],'formatBytes (IEC units)');
 const registered=cell('registered',releases[0]);check([registered.type,registered.props.title,registered.props.dateTime],['time','exact:10',new Date(10).toISOString()],'the relative time with the exact time as hint');
 table.props.onSort({column:'version',direction:'asc'});ui.render();
 check(ui.table().props.rows.map(row=>row.version),['4.8.0','4.9.0','4.10.0-rc'],'the version sorts numerically');
 const menu=cell('actions',releases[1]);
 check([menu.type,menu.props.label],['Menu',de('releases.actionsFor',{version:'4.8.0'})],'the row Menu');
 // the entries and their blocked reasons.
 const t=(key,params)=>de(key,params),entries=release=>ui.page.releaseMenu(release,{busy:false,t,onDetails(){},onRetire(){}});
 check(entries(releases[1]).map(entry=>entry.id),['details','disable','separator','delete'],'Show details, Disable…, a separator, Delete…');
 check(entries(releases[1]).filter(entry=>entry.label).map(entry=>[entry.label,entry.danger??false,entry.blocked]),[[de('releases.menu.details'),false,undefined],[de('releases.menu.disable'),false,undefined],[de('releases.menu.delete'),true,undefined]],'the labels; Delete is danger');
 check(entries(releases[2]).map(entry=>entry.id),['details','separator','delete'],'Disable only while active');
 check(entries(releases[0]).filter(entry=>entry.blocked).map(entry=>[entry.id,entry.blocked]),[['disable',de('releases.latestBlocked')],['delete',de('releases.latestBlocked')]],'the latest release: Disable and Delete blocked with releases.latestBlocked');
 check(ui.page.releaseMenu(releases[1],{busy:true,t,onDetails(){},onRetire(){}}).filter(entry=>entry.blocked).map(entry=>entry.blocked),[de('kit.busy'),de('kit.busy')],'blocked with kit.busy while a request runs');
 // Disable: the default-tone confirmation, then the request, the toast and a reload.
 ui=harness({get:async()=>({releases,source:view()}),post:async()=>({ok:true})});await ui.settle();
 ui.table().props.columns.find(column=>column.id==='actions').cell(releases[1]).props.entries.find(entry=>entry.id==='disable').onSelect();ui.render();
 let confirm=ui.confirm();
 check([confirm.props.tone,confirm.props.title,confirm.props.body,confirm.props.confirmLabel,ui.posts().length],['default',de('releases.disable.title',{version:'4.8.0'}),de('releases.disable.body'),de('releases.disable.confirm'),0],'Disable asks first, default tone');
 confirm.props.onConfirm();ui.render();await ui.settle();
 check([ui.posts(),ui.toasts.at(-1),ui.gets()],[[{action:'disable',releaseId:'older',confirm:true}],['success',de('releases.disabled.toast',{version:'4.8.0'})],2],'the request, the toast and the reload');
 // Delete: danger; a server that asks for a new proof opens MfaStepUp, and the proof resends once.
 const proof=false;
 ui=harness({get:async()=>({releases,source:view()}),post:async payload=>{if(!payload.managementToken&&!proof)throw new ApiError('MFA erforderlich',403,'MFA_STEP_UP_REQUIRED');return {ok:true};}});await ui.settle();
 ui.table().props.columns.find(column=>column.id==='actions').cell(releases[1]).props.entries.find(entry=>entry.id==='delete').onSelect();ui.render();
 confirm=ui.confirm();
 check([confirm.props.tone,confirm.props.title,confirm.props.body,confirm.props.confirmLabel],['danger',de('releases.delete.title',{version:'4.8.0'}),de('releases.delete.body'),de('releases.delete.confirm')],'Delete asks first, danger tone');
 confirm.props.onConfirm();ui.render();await ui.settle();
 check([!!ui.openDialog(),ui.posts()],[true,[{action:'delete',releaseId:'older',confirm:true}]],'an answer that asks for a proof opens MfaStepUp');
 ui.openDialog().props.onVerified({managementToken:'fresh'});ui.render();await ui.settle();
 check([ui.posts().at(-1),ui.toasts.at(-1)],[{action:'delete',releaseId:'older',confirm:true,managementToken:'fresh'},['success',de('releases.deleted.toast',{version:'4.8.0'})]],'the same request once more with the proof, then the toast');
 // Show details (or a row click) opens the kit Drawer.
 ui=harness();await ui.settle();
 ui.table().props.onOpen(releases[1]);ui.render();
 const drawer=ui.find(node=>node.type==='Drawer');
 check([drawer.props.open,drawer.props.title],[true,de('agentUpdates.agentVersion',{version:'4.8.0'})],'the Drawer with agentUpdates.agentVersion');
 const details=ui.nodes(drawer),facts=details.find(node=>node.type==='Facts');
 check(facts.props.items.map(item=>item.label),[de('releases.col.status'),de('releases.signature'),de('releases.col.size'),de('releases.col.platform'),de('releases.registered')],'Status, Signature, Size, Platform, Registered');
 check([ui.text(facts.props.items[1].value).trim(),facts.props.items[3].value,facts.props.items[4].hint],[de('releases.signed'),de('releases.platform'),'exact:5'],'Signed, Windows x64, the exact time as hint');
 ok(ui.text(drawer).includes(de('agentUpdates.notice.features'))&&ui.text(drawer).includes('Neue Funktion')&&ui.text(drawer).includes(de('releases.noBugfixes')),'the changelog sections with their empty texts');
 check(details.filter(node=>node.type==='CopyValue').map(node=>[node.props.value,node.props.label]),[['b'.repeat(64),de('releases.copySha')]],'the SHA-256 in CopyValue');
 ui.table().props.onOpen(releases[0]);ui.render();
 ok(ui.text(ui.find(node=>node.type==='Drawer')).includes(de('releases.noChangelog')),'without a changelog: releases.noChangelog');
 // The empty catalog.
 ui=harness({get:async()=>({releases:[],source:view()})});await ui.settle();
 check([ui.table().props.rows,ui.table().props.empty.icon,ui.table().props.empty.title,ui.table().props.empty.children],[[],'PackageOpen',de('releases.emptyTitle'),de('releases.emptyOwner')],'the empty state releases.emptyTitle and releases.emptyOwner');
}

// ---- Source guards ----
{
 const files=['ui/settings/agent-releases-page.tsx','ui/settings/release-source.tsx','ui/settings/extension-releases.tsx'],sources=files.map(file=>fs.readFileSync(file,'utf8'));
 const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):/\.tsx?$/.test(entry.name)?[path.join(dir,entry.name)]:[]);
 // The settings pages of this slice ask through the kit ConfirmDialog; the device views keep theirs until their slice.
 check([...walk('app'),...walk('ui')].filter(file=>fs.readFileSync(file,'utf8').includes('window.confirm')).map(file=>file.split(path.sep).join('/')).filter(file=>!['ui/devices/device/agent-update-notice.tsx','ui/devices/remote/file-browser.tsx','ui/devices/remote/file-panel.tsx'].includes(file)),[],'no window.confirm in the release pages or any other page of app/ beyond the three known device places');
 for(const [index,source] of sources.entries()){
  ok(!/components\/ui\/|DetailDrawer|ErrorNote|sdx-loading|common\.reload|common\.demoBlocked/.test(source),`${files[index]}: no shadcn, DetailDrawer, ErrorNote, classic loading, reload label or demo block`);
  ok(!/'Version'|>Version<|'Latest'|>Latest<|'Changelog'|>Changelog<|Windows x64|MiB/.test(source),`${files[index]}: no English literals Version, Latest, Changelog, Windows x64, MiB`);
 }
 ok(!/needRight|emptyViewer|canInspect/.test(sources[0]),'the non-owner branch is gone');
 for(const file of walk('ui'))ok(!/githubTokenPattern|set-token|remove-token|sdx-release-token|releaseSource\.token/.test(fs.readFileSync(file,'utf8')),`${file}: no release token code, class or key`);
 ok(!/releaseActionNeedsStepUp|releaseStepUpActions/.test(sources[0]+sources[1]),'the release pages use no release step-up set');
 const css=fs.readFileSync('ui/settings/release-management.css','utf8');
 ok(!/--sd-text-kpi|sdx-release-source-when|\.sd-release-/.test(css),'no KPI-size text and no classic release rules');
 ok(!/\.sdx-pill \{[^}]*height|\.sdx-tag \{[^}]*height/.test(css),'no page-local pill or tag size: the focal pill is StatusPill size="lg", the Latest tag the kit tag');
}
console.log(`PASS release management view (${checks} checks): one SettingsPage with loading and error, Check now as the page primary with its blocked reason, polling and the console refresh; the release source card with the state first, the failure notice, Facts and the imports with their reasons, without a token form; the releases DataTable, its row menu and both confirmations with step-up; the details Drawer; the empty catalog; the source guards.`);
