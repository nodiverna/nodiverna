// Runs RedesignConsole (ui/shell/console.tsx) with deterministic fake hooks:
// useLayoutEffect runs during render(), effects and microtasks run in settle().
// useConsoleData is mocked, so a test sets data (including data.viewer) itself.
// Child components are not executed; a test inspects the props the console
// gives them. credentialFetch and api record every POST, sonner records the
// toasts, and the fake window.history records every pushState and replaceState.
// Used by tests/ui/shell/console-rights-loss.mjs, tests/ui/shell/customer-view.mjs, tests/ui/shell/overlay-performance.mjs and
// tests/ui/shell/workspace-render-performance.mjs (renders, tick(), advance()). media lists the media queries that match
// (window.matchMedia): ['(max-width: 900px)'] runs the console at phone width (navigator overlay, Jobs sheet).
// The console clock (ui/base/clock-store.ts) runs on the harness hooks with a fake time: Date.now() of the
// loaded files is the harness time, which only tick() and advance() move; useSyncExternalStore subscribes for real,
// so a clock change renders the console only when one of its selectors changes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {i18nStubs} from './i18n-stubs.mjs';

const real={
 'lib/step-up':await import('../../lib/step-up.ts'),
 'ui/devices/fleet/groups-model':await import('../../ui/devices/fleet/groups-model.ts'),
 // The Server roles detection: a DHCP or DNS link on a device without that role falls back to the Server roles Overview.
 'lib/extensions':await import('../../lib/extensions.ts'),
 'lib/offboarding':await import('../../lib/offboarding.ts'),
 'ui/base/confirmation':await import('../../ui/base/confirmation.ts'),
 'lib/errors/codes':await import('../../lib/errors/codes.ts'),
 'ui/base/api-error-text':await import('../../ui/base/api-error-text.ts'),
 'lib/server-messages':await import('../../lib/server-messages.ts'),
 'lib/i18n/locale':i18nStubs['@/lib/i18n/locale'],
 'ui/base/ui-device':await import('../../ui/base/ui-device.ts'),
 'lib/device-connection':await import('../../lib/device-connection.ts'),
 'ui/devices/fleet/fleet-header':await import('../../ui/devices/fleet/fleet-header.ts'),
 'lib/gpu-drivers/installed':await import('../../lib/gpu-drivers/installed.ts'),
 'lib/job-display':await import('../../lib/job-display.ts'),
 'lib/plugin-catalog':await import('../../lib/plugin-catalog.ts'),
 'lib/plugin-ad':await import('../../lib/plugin-ad.ts'),
 'lib/console-route':await import('../../lib/console-route.ts'),
 // The navigation model runs for real: the rail, navigator, palette pages and crumbs come from it.
 'ui/shell/nav-model':await import('../../ui/shell/nav-model.ts'),
 'ui/base/access-capabilities':await import('../../ui/base/access-capabilities.ts'),
 // The top bar logo rule (docs/branding.md) and the default customer it skips.
 'ui/shell/brand-logo-model':await import('../../ui/shell/brand-logo-model.ts'),
 'lib/default-customer':await import('../../lib/default-customer.ts'),
 'ui/devices/fleet/customer-choice':await import('../../ui/devices/fleet/customer-choice.ts'),
 'ui/devices/fleet/customer-folders':await import('../../ui/devices/fleet/customer-folders.ts'),
 'ui/devices/fleet/fleet-scope':await import('../../ui/devices/fleet/fleet-scope.ts'),
 'ui/devices/device/device-removal':await import('../../ui/devices/device/device-removal.tsx'),
 'ui/base/http':await import('../../ui/base/http.ts'),
 // The console's POST action runs for real; it reaches the network only through the harness's credentialFetch.
 'ui/shell/console-action':await import('../../ui/shell/console-action.ts'),
 'ui/devices/add-device/enroll-action':await import('../../ui/devices/add-device/enroll-action.ts'),
 // The open state of the palette and Help (the hosts below read it).
 'ui/shell/overlay-store':await import('../../ui/shell/overlay-store.ts'),
 // The pure rules of the page Add device: the registration file name and the device id of the JSON.
 'ui/devices/add-device/add-device-model':await import('../../ui/devices/add-device/add-device-model.ts'),
 // The device type of a palette device item (its glyph).
 'ui/devices/device/device-type-model':await import('../../ui/devices/device/device-type-model.ts'),
 // The Dashboard layout rules: the console keeps a saved layout until a load carries the same.
 'lib/dashboard-layout':await import('../../lib/dashboard-layout.ts'),
};
const {readApiJson}=real['ui/base/http'];

const compiled=new Map();
const compile=file=>{if(!compiled.has(file))compiled.set(file,ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText);return compiled.get(file);};
// Import specifiers become repository paths without extension ('@/ui/base/api' → 'ui/base/api'; a relative one from the importer's folder).
const moduleKey=(id,from)=>id.startsWith('.')?path.posix.join(path.posix.dirname(from),id):id.startsWith('@/')?id.slice(2):id;
const named=new Proxy({},{get:(_target,key)=>String(key)});
const asDefault=value=>({__esModule:true,default:value});
export const isElement=value=>!!value&&typeof value==='object'&&'type' in value&&'props' in value;
// Every element in the tree, including elements passed as props (FleetView permissions, header, …).
// The overlay hosts (ui/shell/overlay-hosts.tsx) read the open state from the console's overlay store; each also
// stands for the element it renders, with the props it gives it at this moment: PaletteHost a CommandPalette, HelpHost
// a HelpPanel. So a test reads the palette and Help as before, and a store change shows without a console render.
const hosted=node=>node.type==='PaletteHost'?[{type:'CommandPalette',props:{open:node.props.overlays.get().palette,opening:node.props.overlays.get().paletteOpening,onOpenChange:node.props.overlays.setPalette,getItems:node.props.getItems},key:null}]
 :node.type==='HelpHost'?[{type:'HelpPanel',props:{open:node.props.overlays.get().help,onOpenChange:node.props.overlays.setHelp,route:node.props.route},key:null}]:[];
export const nodes=node=>Array.isArray(node)?node.flatMap(nodes):!isElement(node)?[]:[node,...hosted(node),...Object.values(node.props).flatMap(value=>Array.isArray(value)?value.flat(Infinity).flatMap(nodes):nodes(value))];
export const ok=()=>Response.json({ok:true});

/**
 * Starts the console for one viewer at one hash. base is the default console
 * data of the test file; data overrides single fields of it. startPage is the
 * stored start page that readStartPage returns.
 */
export function consoleHarness({viewer,hash='#devices',base={},data:initialData={},startPage='devices',media=[]}){
 const cells=[],pending=new Map(),posts=[],toasts=[],refreshes=[],history=[],listeners=new Map(),downloads=[],intervals=[];let cursor=0,dirty=false,tree,shortcutHandlers,renders=0;
 // The harness time: Date.now() of every file the harness loads (the console, the clock store).
 let time=Date.now();
 const RealDate=Date;
 class HarnessDate extends RealDate{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}}
 const state={data:{viewer,...base,...initialData},reply:ok};
 const changed=(old,deps)=>!old||!deps||deps.length!==old.deps.length||deps.some((value,index)=>!Object.is(value,old.deps[index]));
 const hooks={
  useState(initial){const index=cursor++;if(!cells[index]){const cell={value:typeof initial==='function'?initial():initial};cell.set=value=>{const next=typeof value==='function'?value(cell.value):value;if(!Object.is(next,cell.value)){cell.value=next;dirty=true;}};cells[index]=cell;}return [cells[index].value,cells[index].set];},
  useRef(initial){const index=cursor++;cells[index]??={current:initial};return cells[index];},
  useMemo(fn,deps){const index=cursor++;if(changed(cells[index],deps))cells[index]={deps,value:fn()};return cells[index].value;},
  useCallback(fn,deps){return hooks.useMemo(()=>fn,deps);},
  // Effects wait for settle(); only the latest render's effect per slot runs.
  useEffect(fn,deps){const index=cursor++;if(changed(cells[index],deps))pending.set(index,{fn,deps});else pending.delete(index);},
  // The clock tick is a transition; here it runs at once.
  startTransition(fn){fn();},
  useLayoutEffect(fn,deps){const index=cursor++,old=cells[index];if(changed(old,deps)){old?.cleanup?.();cells[index]={deps,cleanup:fn()};}},
  // Subscribes on the first render, like React: a store change marks the console dirty only when the snapshot of the
  // latest render's getSnapshot changed.
  useSyncExternalStore(subscribe,getSnapshot){
   const index=cursor++;let cell=cells[index];
   if(!cell){cell=cells[index]={};cell.unsubscribe=subscribe(()=>{if(!Object.is(cell.get(),cell.value))dirty=true;});}
   cell.get=getSnapshot;cell.value=getSnapshot();return cell.value;
  },
  memo:type=>type,
 };
 const jsx=(type,props,key)=>({type,props:props??{},key});
 const toast={success:message=>toasts.push(message),error:message=>toasts.push('error:'+message),info:message=>toasts.push('info:'+message)};
 const record=(url,body)=>{posts.push({url,body});return Promise.resolve(state.reply(url,body));};
 const credentialFetch=(url,init)=>record(url,JSON.parse(init.body));
 const api=async(url,body)=>{assert.ok(body,'the console sends no GET through api');return readApiJson(await record(url,body));};
 const location={pathname:'/',search:'',hash};
 const go=url=>{location.hash=url.slice(url.indexOf('#'));};
 const scope={
  window:{location,history:{replaceState:(_state,_title,url)=>{history.push(['replace',url.slice(url.indexOf('#'))]);go(url);},pushState:(_state,_title,url)=>{history.push(['push',url.slice(url.indexOf('#'))]);go(url);}},addEventListener(type,listener){listeners.set(type,[...(listeners.get(type)??[]),listener]);},removeEventListener(type,listener){listeners.set(type,(listeners.get(type)??[]).filter(item=>item!==listener));},matchMedia:query=>({matches:media.includes(query),addEventListener(){},removeEventListener(){}})},
  // createElement: the anchor of a downloaded registration; downloads records each click.
  document:{documentElement:{dataset:{}},getElementById:()=>null,createElement:()=>({href:'',download:'',click(){downloads.push(this.download);}})},
  localStorage:{getItem:()=>null,setItem(){}},
  // The console's 1 s clock: tick() runs the callbacks (no timer runs on its own).
  setInterval:callback=>{intervals.push(callback);return intervals.length;},clearInterval(){},
  Date:HarnessDate,
 };
 const shared={
  'react':hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'Fragment'},'lucide-react':named,'ui/shell/nav-icons':{navIcons:named},'sonner':{Toaster:'Toaster',toast},
  'ui/shell/demo':{demoData:()=>({servers:[],samples:[]})},'ui/devices/device/device-network':{primaryDeviceAddress:()=>undefined},
  'lib/i18n/format':i18nStubs['@/lib/i18n/format'],'ui/base/locale':{languagePaletteItems:()=>[],...i18nStubs['@/ui/base/locale']},
  'ui/session/session-gate':{signOutPortal:async()=>{}},'ui/shell/console-shortcuts':{useConsoleShortcuts(handlers){shortcutHandlers=handlers;}},
  'ui/shell/command-palette':asDefault('CommandPalette'),'ui/shell/help-panel':asDefault('HelpPanel'),'ui/shell/overlay-hosts':{PaletteHost:'PaletteHost',HelpHost:'HelpHost'},'ui/automation/automation-workspace':asDefault('AutomationWorkspace'),'ui/settings/access-workspace':asDefault('AccessWorkspace'),'ui/settings/usage-data':asDefault('UsageConsentDialog'),
  'ui/settings/session-settings-panel':{sessionSettingsPaletteKeywords:''},'ui/settings/entra-settings-panel':{entraPaletteKeywords:'entra.paletteKeywords'},'ui/settings/customers-panel':{customersPaletteKeywords:''},
  // The customer drawers over Devices stay a boundary: a test reads the request, closeKey and onSaved of the host.
  'ui/settings/customer-drawers':{CustomerDrawerHost:'CustomerDrawerHost'},
  'ui/devices/configuration/permissions-tab':{ScopedPermissionEditor:'ScopedPermissionEditor'},'ui/account/account-panel':{AccountPanel:'AccountPanel'},'ui/session/mfa-step-up':{MfaStepUp:'MfaStepUp'},
  'ui/shell/console-jobs':{jobActionLabel:String,canCancelJob:()=>false,cancelJobVisible:()=>false},
  'lib/agent-messages':{agentMessageText:job=>job.result},'ui/devices/device/offboarding':asDefault('OffboardingDrawer'),
  'ui/base/api':{credentialFetch,readApiJson,api,ApiError:real['ui/base/http'].ApiError,message:failure=>failure instanceof Error?failure.message:'Fehler'},
  'ui/kit/kit':{Btn:'Btn',Card:'Card',Drawer:'Drawer',Empty:'Empty',IconBtn:'IconBtn',Menu:'Menu',Notice:'Notice',Skeleton:'Skeleton',exactTime:String,cx:(...names)=>names.filter(Boolean).join(' ')},
  'ui/kit/field':{Field:'Field'},
  'ui/kit/analysis-tab':{RetryAction:'RetryAction'},
  // The typed-name delete drawer of groups.tsx (GroupDeleteDrawer itself is a stub below).
  'ui/kit/name-confirm-drawer':{NameConfirmDrawer:'NameConfirmDrawer'},
  'ui/kit/confirm-dialog':{ConfirmDialog:'ConfirmDialog'},
  'ui/account/personal-assistant-key':asDefault('PersonalAssistantKey'),
  'ui/shell/maintenance-notice':asDefault('MaintenanceNotice'),
  'ui/shell/previous-secret-notice':asDefault('PreviousSecretNotice'),
  'ui/shell/emergency-alarm-notice':asDefault('EmergencyAlarmNotice'),
  'ui/shell/shell':{Navigator:'Navigator',NavGroups:'NavGroups',NavList:'NavList',PageHeader:'PageHeader',Rail:'Rail',Topbar:'Topbar'},
  // The rename drawer of a device stays a boundary (ui/devices/device/device-name.tsx).
  'ui/devices/device/device-name':{DeviceNameDrawer:'DeviceNameDrawer'},
  'ui/devices/monitoring/alert-rules':asDefault('AlertRulesPanel'),
  'ui/devices/monitoring/notification-rules':asDefault('NotificationRulesPanel'),
  // The Monitoring summary row (ui/devices/monitoring/monitoring-summary.tsx) stays a boundary: a test reads its props (scopes, demo, the tile actions).
  'ui/devices/monitoring/monitoring-summary':asDefault('MonitoringSummaryRow'),
  'ui/devices/configuration/tags':{...asDefault('TagsPanel'),demoTagView:()=>null},
  // The palette item New DHCP scope asks the DHCP view to open its form (ui/devices/extensions/device-dhcp.tsx).
  'ui/devices/extensions/device-dhcp':{requestDhcpForm(){}},
  // The palette item New DNS zone asks the DNS view to open its form (ui/devices/extensions/device-dns.tsx).
  'ui/devices/extensions/device-dns':{requestDnsForm(){}},
  // The AD sign-in of plugin changes (ui/devices/extensions/plugin-ad.tsx): the dialog host stays a boundary; a request answers Cancel.
  'ui/devices/extensions/plugin-ad':{PluginAdSignInHost:'PluginAdSignInHost',ServerSignInsCard:'ServerSignInsCard',requestAdSignIn:()=>Promise.resolve(false)},
  'ui/devices/fleet/inventory-tree':asDefault('InventoryTree'),'ui/devices/fleet/fleet':asDefault('FleetView'),'ui/devices/device/device':{...asDefault('DeviceView'),deviceTabs:[],visibleDeviceTabs:()=>[],shownDeviceSection:(_server,section)=>section,assistantAvailable:server=>server.revoked===0},
  'ui/devices/add-device/add-device':asDefault('AddDevicePage'),
  // The customer move drawer stays a boundary: a test reads its props (open, devices, onMoved).
  'ui/devices/fleet/customer-move-drawer':{CustomerMoveDrawer:'CustomerMoveDrawer'},
  // The Dashboard stays a boundary: a test reads its props (preference, owner, onNavigate, customizeRequest).
  'ui/devices/dashboard/dashboard-view':asDefault('DashboardView'),
  // The agent settings pages stay boundaries: a test reads their props (frame, servers).
  'ui/settings/agent-releases-page':asDefault('AgentReleasesPage'),'ui/settings/extension-releases':asDefault('ExtensionsPage'),'ui/settings/troubleshooting':asDefault('AgentTroubleshootingPage'),'ui/shell/jobs':{JobDock:'JobDock',JobSheet:'JobSheet',JobState:'JobState'},
  // The job drawer (ui/shell/job-detail.tsx) stays a boundary: a test reads its props (job, open, onNavigate).
  'ui/shell/job-detail':asDefault('JobDetailDrawer'),
  'ui/shell/use-console-data':{useConsoleData:()=>({data:state.data,error:'',loading:false,checkedAt:0,refresh:(...args)=>{refreshes.push(args);return Promise.resolve();}}),useDeviceHistory:()=>({samples:[],loading:false})},
  'ui/shell/theme':{applyTheme(){},currentTheme:()=>'system',themePaletteItems:()=>[]},'ui/shell/density':{applyDensity(){},currentDensity:()=>'comfortable',densityPaletteItems:()=>[]},'ui/shell/start-page':{readStartPage:()=>startPage,startPagePaletteItems:()=>[]},'ui/shell/color-scheme':{effectiveMode:()=>'light',schemePaletteItems:()=>[]},
  // The console background (ui/shell/console-backdrop.tsx) stays a boundary: a test reads its background prop.
  'ui/shell/console-backdrop':{ConsoleBackdrop:'ConsoleBackdrop',consoleBackdrop:(branding,on,allowed=true)=>on&&allowed?branding?.consoleBackground??null:null,consoleBackdropStyle:()=>undefined,useBackdropAllowed:()=>true,saveConsoleBackground:async next=>next},
  ...real,
 };
 const load=(file,overrides={})=>{
  const mod={exports:{}},from=file.replace(/\.tsx?$/,'');
  const require=id=>{const key=moduleKey(id,from);if(key.endsWith('.css'))return {};const found=overrides[key]??shared[key];if(!found)throw Error(`Unexpected import ${id} in ${file}`);return found;};
  new Function('require','module','exports',...Object.keys(scope),compile(file))(require,mod,mod.exports,...Object.values(scope));
  return mod.exports;
 };
 // The real step-up flow (useStepUp) under useAccessChange, on the harness hooks.
 shared['lib/i18n/translate']??=i18nStubs['@/lib/i18n/translate'];
 shared['ui/session/step-up-retry']=load('ui/session/step-up-retry.ts');
 // The real useAccessChange and group rules; its MFA prompt gets its own element type, the drawers stay boundaries.
 const groupsModule=load('ui/devices/fleet/groups.tsx',{'ui/session/mfa-step-up':{MfaStepUp:'AccessMfaStepUp'}});
 shared['ui/devices/fleet/groups']={...groupsModule,GroupCreateDrawer:'GroupCreateDrawer',GroupDeleteDrawer:'GroupDeleteDrawer',GroupSettings:'GroupSettings',MoveDevicesDrawer:'MoveDevicesDrawer',AssignDevicesDrawer:'AssignDevicesDrawer'};
 // The width hooks run for real on the harness hooks and window.matchMedia (media).
 shared['ui/base/narrow-layout']=load('ui/base/narrow-layout.ts');
 // The console clock and the stable handlers run for real on the harness hooks, the fake time and setInterval.
 const clockModule=load('ui/base/clock-store.ts');
 shared['ui/base/clock-store']=clockModule;
 shared['ui/base/stable-callback']=load('ui/base/stable-callback.ts');
 // The pin toggle runs for real (ui/shell/pin-toggle.ts): its PUT goes through the harness's credentialFetch.
 shared['ui/shell/pin-toggle']=load('ui/shell/pin-toggle.ts');
 const Console=load('ui/shell/console.tsx').default;
 const render=()=>{dirty=false;cursor=0;renders++;tree=Console({viewer});return tree;};
 async function settle(){
  for(let round=0;round<40;round++){
   for(const [index,{fn,deps}] of [...pending].sort(([a],[b])=>a-b)){pending.delete(index);cells[index]?.cleanup?.();cells[index]={deps,cleanup:fn()};}
   await new Promise(resolve=>setImmediate(resolve));
   if(dirty)render();else if(!pending.size)return;
  }
  throw Error('The console does not settle');
 }
 const all=type=>nodes(tree).filter(node=>node.type===type),find=type=>all(type)[0];
 const ui={
  posts,toasts,refreshes,location,history,downloads,render,settle,all,find,state,
  /** The handlers the console gave useConsoleShortcuts in the last render (go, help, palette, …). */
  shortcuts:()=>shortcutHandlers,
  get tree(){return tree;},
  /** How often the console has rendered; settle() renders only after a state change. */
  get renders(){return renders;},
  /** Whether a console state changed since the last render. */
  get dirty(){return dirty;},
  /** One tick of the console's clock (the time moves 1 s), then the renders it causes. */
  async tick(){await ui.advance(1000);},
  /** Moves the harness time by ms and runs the clock's interval once, then the renders it causes. */
  async advance(ms){time+=ms;for(const callback of intervals)callback();await ui.settle();},
  /** The harness time (Date.now() of the console and its clock). */
  get now(){return time;},
  /** The console's clock store. */
  clock:clockModule.consoleClock,
  setViewer(next){state.data={...state.data,viewer:next};render();},
  setData(change){state.data={...state.data,...change};render();},
  /** The browser moves to another history entry (Back, Forward) or the hash changes. */
  async navigateTo(next,type='popstate'){location.hash=next;for(const listener of listeners.get(type)??[])listener();render();await ui.settle();},
  fleet:()=>find('FleetView'),device:()=>find('DeviceView'),inventory:()=>find('InventoryTree'),drawer:()=>find('GroupDeleteDrawer'),
  alert:()=>find('ConfirmDialog'),mfa:()=>find('MfaStepUp'),accessMfa:()=>find('AccessMfaStepUp'),
  editors:()=>all('ScopedPermissionEditor'),
  errors:()=>toasts.filter(message=>message.startsWith('error:')),
 };
 render();
 return ui;
}
