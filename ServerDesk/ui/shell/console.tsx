'use client';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {AlertTriangle,Gpu,Sparkles,Building2,ChevronRight,CircleHelp,Globe,FlaskConical,FolderInput,FolderKey,FolderPlus,Inbox,KeyRound,Package,Pencil,PencilLine,Pin,PinOff,Plus,RefreshCw,Search,Router,SlidersHorizontal,Users,X,PanelsTopLeft} from 'lucide-react';
import {Toaster,toast} from 'sonner';
import type {ConsoleData,Job,Server,Viewer} from '@/lib/types';
import {demoData} from '@/ui/shell/demo';
import {currentJob,jobCounts} from '@/lib/job-display';
import {deviceHasIssues} from '@/ui/base/ui-device';
import {connectionKind} from '@/lib/device-connection';
import {primaryDeviceAddress} from '@/ui/devices/device/device-network';
import {fleetHeaderLines} from '@/ui/devices/fleet/fleet-header';
import {detectTargets} from '@/lib/extensions';
import {signOutPortal} from '@/ui/session/session-gate';
import {consoleRouteHash,deviceDetailRoute,deviceMainSection,isAutomationPage,isSettingsPage,pageTabOf,pageTabsOf,parseConsoleRoute,startHash,type AutomationPage,type ConsoleRoute,type ConsoleView,type DeviceDetailRoute,type DeviceSection,type SettingsPage} from '@/lib/console-route';
import {areaCrumbOf,areaOf,areaNodeOf,firstSettingsPage,navNode,navigatorPages,paletteHint,paletteKeywords,palettePages,routeNode,settingsGroups,settingsSection,scopeTabHref,shownScopeTab,deviceKeyAreas,visibleDeviceAreas,visibleRail,type Area,type NavContext,type NavNode} from '@/ui/shell/nav-model';
import {navIcons} from '@/ui/shell/nav-icons';
import {topbarLogo} from '@/ui/shell/brand-logo-model';
import {defaultCustomerId} from '@/lib/default-customer';
import {useConsoleShortcuts} from '@/ui/shell/console-shortcuts';
import type {PaletteItem} from '@/ui/shell/command-palette';
import {HelpHost,PaletteHost} from '@/ui/shell/overlay-hosts';
import {overlayStore} from '@/ui/shell/overlay-store';
import {consoleClock,useClockValue} from '@/ui/base/clock-store';
import {useStableCallback} from '@/ui/base/stable-callback';
import AutomationWorkspace from '@/ui/automation/automation-workspace';
import AccessWorkspace from '@/ui/settings/access-workspace';
import {CustomerDrawerHost,type CustomerDrawerRequest} from '@/ui/settings/customer-drawers';
import {customerFolderActions,customerFolders,ungroupedNodes,type CustomerFolderAction} from '@/ui/devices/fleet/customer-folders';
import {customerViewAvailable,scopeDevices,scopeTabs,type FleetScope} from '@/ui/devices/fleet/fleet-scope';
import {ScopedPermissionEditor} from '@/ui/devices/configuration/permissions-tab';
import type {PermissionPrefill} from '@/ui/settings/rbac-model';
import {AccountPanel} from '@/ui/account/account-panel';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import PersonalAssistantKey from '@/ui/account/personal-assistant-key';
import {canManageCustomers,canManageDeviceGroups,canManageGroup,canManageInstanceSettings,canManageNotifications,canManageRoleAssignments,hasRootGroupRight,isOwner} from '@/ui/base/access-capabilities';
import UsageConsentDialog from '@/ui/settings/usage-data';
import {canRemoveDevices,stepUpRejected,stepUpRetry,UninstallSwitch,type RemovalContext,type StepUpProof} from '@/ui/devices/device/device-removal';
import OffboardingDrawer from '@/ui/devices/device/offboarding';
import {AGENT_UNINSTALL_KIND,uninstallOpen,type OffboardingEntry} from '@/lib/offboarding';
import {runConsoleAction,type ConsoleActionOptions} from '@/ui/shell/console-action';
import {pluginReady,snapshotPlugin} from '@/lib/plugin-catalog';
import {requestDhcpForm} from '@/ui/devices/extensions/device-dhcp';
import {requestDnsForm} from '@/ui/devices/extensions/device-dns';
import {PluginAdSignInHost,ServerSignInsCard,requestAdSignIn} from '@/ui/devices/extensions/plugin-ad';
import {adIdentityReady} from '@/lib/plugin-ad';
import {gpuDriverPosition} from '@/lib/gpu-drivers/installed';
import {isDeviceRemovalAction} from '@/lib/step-up';
import type {InventoryAction,InventoryTarget} from '@/ui/devices/fleet/inventory-navigation';
import type {Confirmation} from '@/ui/base/confirmation';
import {confirmationOptions,confirmedView} from '@/ui/base/confirmation';
import {jobActionLabel,canCancelJob} from '@/ui/shell/console-jobs';
import {credentialFetch,message,readApiJson,type Device} from '@/ui/base/api';
import {ApiError} from '@/ui/base/http';
import {Btn,IconBtn,Menu,Notice,Skeleton,type MenuEntry} from '@/ui/kit/kit';
import {RetryAction} from '@/ui/kit/analysis-tab';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import MaintenanceNotice from '@/ui/shell/maintenance-notice';
import PreviousSecretNotice from '@/ui/shell/previous-secret-notice';
import {DeviceNameDrawer} from '@/ui/devices/device/device-name';
import EmergencyAlarmNotice from '@/ui/shell/emergency-alarm-notice';
import {GroupCreateDrawer,GroupDeleteDrawer,GroupSettings,MoveDevicesDrawer,AssignDevicesDrawer,deviceGroupId,useAccessChange} from '@/ui/devices/fleet/groups';
import {CustomerMoveDrawer} from '@/ui/devices/fleet/customer-move-drawer';
import {Navigator,NavGroups,NavList,PageHeader,Rail,Topbar,type Crumb,type NavEntry,type RailItem} from '@/ui/shell/shell';
import InventoryTree from '@/ui/devices/fleet/inventory-tree';
import FleetView,{type FleetTab} from '@/ui/devices/fleet/fleet';
import DeviceView,{assistantAvailable,shownDeviceSection} from '@/ui/devices/device/device';
import AlertRulesPanel,{type AlertOriginTarget} from '@/ui/devices/monitoring/alert-rules';
import NotificationRulesPanel,{type NotificationOriginTarget} from '@/ui/devices/monitoring/notification-rules';
import MonitoringSummaryRow from '@/ui/devices/monitoring/monitoring-summary';
import TagsPanel from '@/ui/devices/configuration/tags';
import AddDevicePage from '@/ui/devices/add-device/add-device';
import DashboardView from '@/ui/devices/dashboard/dashboard-view';
import {sameDashboardPreference,type DashboardPreference} from '@/lib/dashboard-layout';
import {submitEnrollment,type EnrollInput} from '@/ui/devices/add-device/enroll-action';
import {registrationDeviceId,registrationFileName,type AddDeviceChoice,type Registration} from '@/ui/devices/add-device/add-device-model';
import AgentReleasesPage from '@/ui/settings/agent-releases-page';
import ExtensionsPage from '@/ui/settings/extension-releases';
import AgentTroubleshootingPage from '@/ui/settings/troubleshooting';
import type {PageFrame} from '@/ui/shell/page-frame';
import type {MessageKey} from '@/lib/i18n/translate';
import {JobDock,JobSheet} from '@/ui/shell/jobs';
import JobDetailDrawer from '@/ui/shell/job-detail';
import {useNarrowLayout,useOverlayLayout} from '@/ui/base/narrow-layout';
import {useConsoleData,useDeviceHistory} from '@/ui/shell/use-console-data';
import {applyTheme,currentTheme,themePaletteItems} from '@/ui/shell/theme';
import {applyDensity,currentDensity,densityPaletteItems} from '@/ui/shell/density';
import {pinToggle} from '@/ui/shell/pin-toggle';
import {deviceType,deviceTypeIcons} from '@/ui/devices/device/device-type-model';
import {effectiveMode,schemePaletteItems} from '@/ui/shell/color-scheme';
import {ConsoleBackdrop,consoleBackdrop,consoleBackdropStyle,saveConsoleBackground,useBackdropAllowed} from '@/ui/shell/console-backdrop';
import {languagePaletteItems,useLocale,useT} from '@/ui/base/locale';
import {readStartPage,startPagePaletteItems} from '@/ui/shell/start-page';
import {apiErrorText} from '@/ui/base/api-error-text';
import {formatClock} from '@/lib/i18n/format';
import {documentLocale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';
import '@/ui/styles/classic-forms.css';
import '@/ui/styles/classic-console.css';
import '@/ui/styles/classic-panels.css';
import '@/ui/styles/console.css';
import '@/ui/devices/inventory/health-signals.css';
import '@/ui/devices/protection/defender.css';
import '@/ui/devices/extensions/extensions.css';
import '@/ui/devices/extensions/dhcp.css';
import '@/ui/devices/monitoring/alarms.css';

// Icons of the customer folder actions; the tree uses the same ones (customerFolderActions).

// Shared empty lists, so a prop without data keeps its identity across renders.
const noJobs:Job[]=[],noAudit:NonNullable<ConsoleData['deviceAudit']>=[];
const customerActionIcons:Record<CustomerFolderAction,typeof FolderPlus>={'create-group':FolderPlus,'manage-customer':Pencil,'customer-access':Users,'customer-installers':Package};

/** Replaces the address with a hash without a new history entry: canonical forms of old links and every fallback of a link the viewer cannot open. */
const replaceHash=(hash:string)=>window.history.replaceState(null,'',window.location.pathname+window.location.search+hash);

/** Redesigned console: rail, navigator, workspace and docked jobs (at 900px or narrower: bottom bar, navigator overlay and the Jobs sheet). */
export default function RedesignConsole({viewer:initialViewer}:{viewer:Viewer}){
 const [locale,setLocale]=useLocale(),t=useT();
 // 900px or narrower: the navigator is an overlay and Jobs open as a sheet from the bottom bar; 760px or narrower: the compact scope header.
 const overlay=useOverlayLayout(),narrow=useNarrowLayout();
 // A navigator entry of a page node of the navigation model (ui/shell/nav-model.ts): one line, the page hint is the page subtitle.
 const navEntry=(node:NavNode):NavEntry=>({id:node.id,label:t(node.label),icon:navIcons[node.icon],href:consoleRouteHash(node.route)});
 // The console holds no clock: the 1 s clock is an external store (clock-store.ts). The console reads its few
 // clock-derived values through selectors and renders again only when one of them changes; every view that shows
 // the time reads the store itself.
 const [demo,setDemo]=useState(false),[fixture,setFixture]=useState<ReturnType<typeof demoData>|null>(null);
 const {data,error,loading,checkedAt,refresh}=useConsoleData(demo);
 // The account's console background switch (My account, the palette): shown at once, kept as the server stored it,
 // dropped when the request fails (the Switch rolls back and toasts). The console data loads again afterwards.
 const [backdropPreference,setBackdropPreference]=useState<boolean|null>(null);
 const consoleBackgroundOn=backdropPreference??data?.preferences?.consoleBackground??true;
 const backdrop=consoleBackdrop(data?.branding,consoleBackgroundOn,useBackdropAllowed());
 // The scrims as custom properties on .sdx, only while the backdrop shows; the same values keep the same object.
 const backdropScrimKey=backdrop?JSON.stringify(backdrop.scrim):'';
 // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the serialized scrims, so a refresh with equal values keeps the style
 const backdropStyle=useMemo(()=>consoleBackdropStyle(backdrop),[backdropScrimKey]);
 const changeConsoleBackground=async(next:boolean)=>{
  setBackdropPreference(next);
  try{setBackdropPreference(await saveConsoleBackground(next));void refresh(true);}
  catch(failure){setBackdropPreference(null);throw failure;}
 };
 const [view,setView]=useState<ConsoleView>('devices'),[selected,setSelected]=useState(''),[deviceSection,setDeviceSection]=useState<DeviceSection>('overview'),[deviceDetail,setDeviceDetail]=useState<DeviceDetailRoute>({}),[groupFilter,setGroupFilter]=useState('all'),[customerFilter,setCustomerFilter]=useState(''),[routeReady,setRouteReady]=useState(false);
 const [fleetTab,setFleetTab]=useState<FleetTab>('devices');
 // The page of the Automation and the Settings view, and the tab of the open page ('' for its first tab).
 const [automationPage,setAutomationPage]=useState<AutomationPage>('runbooks'),[settingsPage,setSettingsPage]=useState<SettingsPage>('accounts'),[frameTab,setFrameTab]=useState('');
 // The add-device page (#devices/add[/installer][/customer/<id>][/group/<id>]): its tab (installer) and the customer and group that preselect its forms.
 const [agentGroupId,setAgentGroupId]=useState(''),[addInstaller,setAddInstaller]=useState(false),[addCustomerId,setAddCustomerId]=useState('');
 // The last Settings page of this session, the agent pages included: the Settings rail item opens it again.
 const [lastSettingsPage,setLastSettingsPage]=useState<SettingsPage>('accounts');
 // Counts the refreshes of the top bar, R and the palette; a framed page loads again on each (PageFrame.refresh).
 const [frameRefresh,setFrameRefresh]=useState(0);
 const [runbookFocus,setRunbookFocus]=useState<{runId:string;serverId:string;revision:number}|null>(null);
 const [saving,setSaving]=useState(false),[confirmation,setConfirmation]=useState<Confirmation|null>(null),[mfaOpen,setMfaOpen]=useState(false);
 // The removal dialog's uninstall switch starts as the confirmation suggests; the offboarding drawer lists the devices of a removal with uninstall.
 const [uninstallOn,setUninstallOn]=useState(false),[offboardingIds,setOffboardingIds]=useState<string[]>([]);
 const openConfirmation=useCallback((next:Confirmation)=>{setUninstallOn(next.uninstall?.checked??false);setConfirmation(next);},[]);const mfaRetry=useRef<((proof:StepUpProof)=>Promise<void>|void)|null>(null);
 const [jobsOpen,setJobsOpen]=useState(false),[jobId,setJobId]=useState(''),[recentFinished,setRecentFinished]=useState<{id:string;until:number}|null>(null);const previousActive=useRef<string[]>([]);
 // The palette and Help keep their open state in a store outside this component (overlay-store.ts): opening or closing
 // them re-renders their hosts only, not the console body.
 const [overlays]=useState(overlayStore),[collapsed,setCollapsed]=useState(false),[drawerOpen,setDrawerOpen]=useState(false),[treeFilter,setTreeFilter]=useState('');
 const [createParent,setCreateParent]=useState<string|null|undefined>(undefined),[deleteGroupId,setDeleteGroupId]=useState(''),[moveIds,setMoveIds]=useState<string[]>([]),[assignGroupId,setAssignGroupId]=useState('');
 // The device whose non-modal "Ask assistant" drawer is open, or ''. Drawers have no route: switching areas keeps it, opening another device closes it.
 const [assistantDevice,setAssistantDevice]=useState('');
 // The rename drawer: the device, whether it is open, and a count that mounts a fresh drawer on every opening (its close still animates).
 const [rename,setRename]=useState<{id:string;open:boolean;count:number}|null>(null);
 const openRename=(id:string)=>setRename(previous=>({id,open:true,count:(previous?.count??0)+1}));
 // A customer drawer requested from the customer folder menu: CustomerDrawerHost opens it over the current page (no route).
 const [createCustomer,setCreateCustomer]=useState(''),[customerDrawer,setCustomerDrawer]=useState<CustomerDrawerRequest|null>(null);
 // "Assign role" from Accounts: the All devices Permissions tab opens its assignment drawer once with this account. Any other
 // page, scope or tab drops it (also Back and Forward).
 const [permissionPrefill,setPermissionPrefill]=useState<PermissionPrefill|null>(null);
 if(permissionPrefill&&!(view==='devices'&&groupFilter==='all'&&!customerFilter&&fleetTab==='permissions'))setPermissionPrefill(null);
 // The tree entry "Rename": the group whose General page puts the focus into its name field once.
 const [renameGroup,setRenameGroup]=useState<{id:string;count:number}|null>(null);

 // Lets shared dialogs and selects adopt the new console style (see ui/styles/console.css).
 useEffect(()=>{const root=document.documentElement;root.dataset.ui='redesign';return()=>{delete root.dataset.ui;};},[]);
 useEffect(()=>{queueMicrotask(()=>{setFixture(demoData());try{setCollapsed(localStorage.getItem('serverdesk.redesign.navigator')==='collapsed');}catch{}});},[]);

 // The page state of the add-device, automation and settings routes; the rail remembers the last Settings page.
 const pageState=useCallback((route:ConsoleRoute)=>{
  if(route.view==='add-device'){setAgentGroupId(route.groupId??'');setAddInstaller(!!route.installer);setAddCustomerId(route.customerId??'');}
  if(route.view==='automation'){setAutomationPage(isAutomationPage(route.page)?route.page:'runbooks');setFrameTab(route.tab??'');}
  if(route.view==='settings'){const page=isSettingsPage(route.page)?route.page:'accounts';setSettingsPage(page);setFrameTab(route.tab??'');setLastSettingsPage(page);}
 },[]);
 // Reads a hash (console-route.ts). An older or non-canonical hash is replaced in place by its canonical form, so it adds no history entry and Back steps over it.
 const applyRoute=useCallback((hash:string)=>{
  const route=parseConsoleRoute(hash),canonical=consoleRouteHash(route);
  if(canonical!==hash)replaceHash(canonical);
  setView(route.view);setSelected(route.deviceId??'');
  setDeviceSection(route.deviceSection??'overview');setDeviceDetail(deviceDetailRoute(route.deviceSection,route.deviceDetail,route.gpu,route.zone));
  setAssistantDevice(current=>route.view!=='device'||!route.deviceId?'':route.assistant||current===route.deviceId?route.deviceId:'');
  setGroupFilter(route.groupId??'all');setCustomerFilter(route.view==='devices'?route.customerId??'':'');setRunbookFocus(null);
  pageState(route);
  if(route.view==='devices')setFleetTab((route.tab??'devices') as FleetTab);
  // A route change (Back, Forward, a link) closes the navigator overlay, as a choice inside it does.
  setDrawerOpen(false);
 },[pageState]);
 // The first read applies the stored start page to a link without a hash, in place, so no history entry is added.
 useEffect(()=>{
  const read=()=>applyRoute(window.location.hash);
  queueMicrotask(()=>{const hash=startHash(window.location.hash,readStartPage());if(hash!==window.location.hash)replaceHash(hash);applyRoute(hash);setRouteReady(true);});
  window.addEventListener('popstate',read);window.addEventListener('hashchange',read);
  return()=>{window.removeEventListener('popstate',read);window.removeEventListener('hashchange',read);};
 },[applyRoute]);
 // The route of the console state; every state change writes its hash with a history entry.
 const route:ConsoleRoute=view==='device'?{view,deviceId:selected,deviceSection,...deviceDetail}
  :view==='devices'?{view,groupId:groupFilter,customerId:customerFilter,tab:fleetTab}
  :view==='add-device'?{view,installer:addInstaller,customerId:addCustomerId,groupId:agentGroupId}
  :view==='automation'?{view,page:automationPage,...(frameTab?{tab:frameTab}:{})}
  :view==='settings'?{view,page:settingsPage,...(frameTab?{tab:frameTab}:{})}:{view};
 const routeHash=consoleRouteHash(route);
 useEffect(()=>{
  if(!routeReady||window.location.hash===routeHash)return;
  const url=window.location.pathname+window.location.search+routeHash;
  if(window.location.hash)window.history.pushState(null,'',url);else window.history.replaceState(null,'',url);
 },[routeHash,routeReady]);
 useEffect(()=>{if(routeReady)document.getElementById('console-content')?.scrollTo({top:0});},[view,selected,deviceSection,groupFilter,customerFilter,routeReady]);

 const user=data?.viewer??initialViewer,isAdmin=isOwner(user),canOffboard=canRemoveDevices(user);
 const offboardAllowed=useRef(canOffboard);useLayoutEffect(()=>{offboardAllowed.current=canOffboard;},[canOffboard]);
 useEffect(()=>{if(canOffboard)return;queueMicrotask(()=>{setConfirmation(current=>isDeviceRemovalAction(current?.payload.action)?null:current);mfaRetry.current=null;setMfaOpen(false);});},[canOffboard]);
 // Deleting a group needs the root group right: losing it (or demo mode) closes an open delete drawer until the next delete action.
 const canDeleteGroups=!demo&&hasRootGroupRight(user);
 useEffect(()=>{if(canDeleteGroups)return;queueMicrotask(()=>setDeleteGroupId(''));},[canDeleteGroups]);
 const servers=useMemo(()=>(demo?fixture?.servers??[]:data?.servers??[]) as Device[],[data,demo,fixture]);
 // The account's pinned devices (docs/device-workspace.md, "Pinned devices"), like the console background: a toggle
 // shows the new set at once (pinOverride), then the server's answer replaces it; a failure restores the set from
 // before (ui/shell/pin-toggle.ts). The override belongs to the console data it was made on: the next load shows the
 // stored list again. Sample devices have no pins.
 const [pinOverride,setPinOverride]=useState<{base:ConsoleData['preferences'];ids:readonly string[]}|null>(null);
 const loadedPins=data?.preferences?.pinnedDeviceIds;
 const pinnedIds=demo?undefined:pinOverride&&pinOverride.base===data?.preferences?pinOverride.ids:loadedPins;
 const pinState=useRef({preferences:data?.preferences,ids:pinnedIds});
 useLayoutEffect(()=>{pinState.current={preferences:data?.preferences,ids:pinnedIds};});
 const pins=useRef<ReturnType<typeof pinToggle>|null>(null);
 /** Pins or unpins one device of the console (not in demo mode, not a permission-only device). */
 const togglePin=useStableCallback((id:string)=>{
  if(demo||!servers.some(server=>server.id===id))return;
  pins.current??=pinToggle({
   read:()=>pinState.current.ids??[],
   write:ids=>{pinState.current={...pinState.current,ids};setPinOverride({base:pinState.current.preferences,ids});},
   done:pinned=>toast.success(translate(documentLocale(),pinned?'pins.pinned':'pins.unpinned')),
   failed:failure=>toast.error(message(failure)),
  });
  void pins.current.toggle(id);
 });
 // The account's Dashboard layout (docs/dashboard.md): a saved layout shows at once and stays until a console load
 // carries the same; a load that still carries another layout (it started before the save) is waited out once, the
 // next one wins. Sample devices use the built-in layout.
 const [dashboardOverride,setDashboardOverride]=useState<{value:DashboardPreference;seen:ConsoleData['preferences'];loads:number}|null>(null);
 const loadedPreferences=data?.preferences;
 if(dashboardOverride&&dashboardOverride.seen!==loadedPreferences){
  const settled=sameDashboardPreference(loadedPreferences?.dashboard,dashboardOverride.value)||dashboardOverride.loads>=1;
  setDashboardOverride(settled?null:{...dashboardOverride,seen:loadedPreferences,loads:dashboardOverride.loads+1});
 }
 const dashboardPreference=demo?undefined:dashboardOverride?.value??loadedPreferences?.dashboard;
 const keepDashboardPreference=(value:DashboardPreference)=>{setDashboardOverride({value,seen:loadedPreferences,loads:0});void refresh(true);};
 // The palette action "Customize dashboard": each new count turns on the edit mode of the Dashboard.
 const [customizeDashboard,setCustomizeDashboard]=useState(0);
 const orderedServers=useMemo(()=>[...servers].sort((a,b)=>a.name.localeCompare(b.name,'de',{numeric:true})),[servers]);
 const active=servers.find(server=>server.id===selected),jobs=useMemo(()=>demo?noJobs:data?.jobs??noJobs,[demo,data]),job=jobs.find(item=>item.id===jobId);
 const renameServer=rename?servers.find(server=>server.id===rename.id&&server.revoked===0):undefined;
 // Devices with an open uninstall job: their removal dialog keeps the switch off. The set follows the clock (a pending
 // job expires); the dialog reads the clock's time when it is built, so the context keeps its identity in between.
 const uninstallPending=useClockValue(now=>jobs.filter(item=>item.action===AGENT_UNINSTALL_KIND&&uninstallOpen(item,now)).map(item=>item.serverId).join('\n'));
 const removalContext=useMemo<RemovalContext>(()=>({get now(){return consoleClock.now();},pending:new Set(uninstallPending?uninstallPending.split('\n'):[])}),[uninstallPending]);
 const confirmed=confirmation?confirmedView(confirmation,uninstallOn):null,removalPending=isDeviceRemovalAction(confirmation?.payload.action);
 const history=useDeviceHistory(active?.id,!demo&&view==='device');
 const deviceGroups=demo?undefined:data?.deviceGroups,permissionDevices=demo?undefined:data?.permissionDevices;
 const groups=useMemo(()=>deviceGroups?.map(group=>[group.id,group.name] as const)??[...new Map(servers.flatMap(server=>server.groups?.map(group=>[group.id,group.name] as const)??(server.groupId?[[server.groupId,server.groupName??server.groupId] as const]:[]))).entries()],[deviceGroups,servers]);
 const currentGroup=deviceGroups?.find(group=>group.id===groupFilter);
 const enrollGroupCustomers=useMemo(()=>Object.fromEntries((deviceGroups??[]).map(group=>[group.id,group.customerId])),[deviceGroups]);
 useEffect(()=>{if(!data&&!demo)queueMicrotask(()=>setJobId(''));},[data,demo]);
 // The customer view and its Ungrouped scope exist only for a visible customer while the tree shows customer folders (fleet-scope.ts).
 // Once data is there, any other customer id falls back to "All devices" without a new history entry.
 const customers=demo?undefined:data?.customers;
 const customerAvailable=customerViewAvailable(customers,customerFilter);
 useEffect(()=>{if(!customerFilter||customerAvailable||!data&&!demo)return;const hash=consoleRouteHash({view:'devices'});replaceHash(hash);queueMicrotask(()=>applyRoute(hash));},[customerFilter,customerAvailable,data,demo,applyRoute]);
 // A link the viewer or device cannot have shows a place it can, and the address becomes that link without a new history
 // entry, once the data is there: Configuration (Permissions) without portal.roleAssignments.manage shows Monitoring › Alert
 // rules (the bare Configuration link used to be the alert rules link); a DHCP or DNS link on a device without that role
 // shows the Extensions Overview. A link never grants access.
 const configurationFallback=deviceSection==='configuration'&&!canManageRoleAssignments(user);
 const detailFallback=view==='device'&&!!active&&(!!data||demo)
  ?configurationFallback?consoleRouteHash({view:'device',deviceId:active.id,deviceSection:'monitoring',deviceDetail:'alert-rules'})
   :deviceSection==='extensions'&&(deviceDetail.deviceDetail==='dhcp'||deviceDetail.deviceDetail==='dns')&&visibleDeviceAreas(active).some(node=>node.deviceSection==='extensions')&&!detectTargets(active).some(role=>role.id===deviceDetail.deviceDetail)
    ?consoleRouteHash({view:'device',deviceId:active.id,deviceSection}):''
  :'';
 useEffect(()=>{
  if(!detailFallback)return;
  replaceHash(detailFallback);
  const next=parseConsoleRoute(detailFallback),section=next.deviceSection??'overview';
  queueMicrotask(()=>{setDeviceSection(section);setDeviceDetail(deviceDetailRoute(section,next.deviceDetail));});
 },[detailFallback]);
 const currentCustomer=view==='devices'&&customerAvailable?customers?.find(customer=>customer.id===customerFilter):undefined;
 // #devices/customer/<id>/ungrouped: the devices of the customer without a group.
 const customerUngrouped=!!currentCustomer&&groupFilter==='unassigned';

 // Remember which job just finished so the dock can show its result briefly.
 useEffect(()=>{
  const finished=jobs.filter(item=>previousActive.current.includes(item.id)&&!['pending','running'].includes(item.state)).sort((a,b)=>(b.claimedAt??b.createdAt)-(a.claimedAt??a.createdAt))[0];
  if(finished)queueMicrotask(()=>setRecentFinished({id:finished.id,until:Date.now()+12000}));
  previousActive.current=jobs.filter(item=>['pending','running'].includes(item.state)).map(item=>item.id);
 },[jobs]);

 const context=useRef({user,servers,deviceGroups,permissionDevices,customers,demo});useLayoutEffect(()=>{context.current={user,servers,deviceGroups,permissionDevices,customers,demo};},[user,servers,deviceGroups,permissionDevices,customers,demo]);
 const groupTarget=useMemo<InventoryTarget>(()=>groupFilter!=='all'&&groupFilter!=='unassigned'?{type:'group',id:groupFilter,name:groups.find(([id])=>id===groupFilter)?.[1]??t('console.groupFallback')}:{type:'global',name:t('nav.allDevices')},[groupFilter,groups,t]);
 const targetAvailable=groupTarget.type!=='group'||currentGroup!==undefined;
 const canManageCurrentGroup=canManageGroup(user,currentGroup)&&!demo;

 // Opens the route of a page node (navigator, palette, shortcuts, links between pages) with a history entry.
 const go=useCallback((next:ConsoleRoute)=>{
  setRunbookFocus(null);setView(next.view);setCustomerFilter('');setDrawerOpen(false);
  if(next.view==='devices'){setSelected('');setJobId('');setGroupFilter(next.groupId??'all');setCustomerFilter(next.customerId??'');setFleetTab((next.tab??'devices') as FleetTab);}
  pageState(next);
 },[pageState]);
 // "Assign role" from Accounts (one history entry): All devices › Configuration › Permissions with the account prefilled.
 const assignRole=(userId:string)=>{go({view:'devices',tab:'permissions'});setPermissionPrefill({subjectType:'user',subjectId:userId});};
 const openServer=useCallback((id:string,section:DeviceSection='overview',detail?:string)=>{setRunbookFocus(null);setAssistantDevice(current=>current===id?current:'');setCustomerFilter('');setSelected(id);setDeviceSection(section);setDeviceDetail(deviceDetailRoute(section,detail));setView('device');setJobId('');setDrawerOpen(false);},[]);
 const openFleet=useCallback((groupId='all')=>{setRunbookFocus(null);setSelected('');setView('devices');setGroupFilter(groupId);setCustomerFilter('');setJobId('');setDrawerOpen(false);},[]);
 // A customer deleted from the manage drawer of its folder (CustomerDrawerHost): a route in its scope (the customer, its
 // Ungrouped scope or one of its groups) has nothing left to show, so the console goes to All devices.
 const leaveDeletedCustomer=useStableCallback((customerId:string)=>{
  if(view!=='devices')return;
  const groupCustomer=groupFilter!=='all'&&groupFilter!=='unassigned'?context.current.deviceGroups?.find(group=>group.id===groupFilter)?.customerId:undefined;
  if(customerFilter===customerId||groupCustomer===customerId)go({view:'devices'});
 });
 /** Opens a customer scope, or with ungrouped its "Ungrouped" scope (#devices/customer/<id>/ungrouped). */
 const openCustomer=useCallback((customerId:string,ungrouped=false)=>{setRunbookFocus(null);setSelected('');setView('devices');setGroupFilter(ungrouped?'unassigned':'all');setCustomerFilter(customerId);setJobId('');setDrawerOpen(false);},[]);
 // The console's handlers keep their identity (useStableCallback): the memoized FleetView, InventoryTree and their rows
 // do not render again because the console did.
 const inventoryAction=useStableCallback((action:InventoryAction,target:InventoryTarget)=>{
  const current=context.current;
  // A choice in the tree closes the navigator overlay (900px or narrower), also one that opens a modal drawer (create,
  // delete, assign): the overlay paints above the page layers and must not stay usable next to the modal.
  setDrawerOpen(false);
  // Customer folder actions: the right and the customer are checked again; the customer drawers open over Devices.
  if(target.type==='customer'){
   const customer=current.demo?undefined:current.customers?.find(item=>item.id===target.id);
   if(!customer)return;
   // "Add device" of a customer folder or its "Ungrouped" node: the add-device page with the customer.
   if(action==='provision'){if(isOwner(current.user))go({view:'add-device',customerId:customer.id});return;}
   // "Installers": the tab Several devices of the add-device page with the customer; the tree stays visible.
   if(action==='customer-installers'){if(canManageCustomers(current.user))go({view:'add-device',installer:true,customerId:customer.id});return;}
   if(action==='create-group'){if(hasRootGroupRight(current.user)){setCreateCustomer(customer.id);setCreateParent(null);}return;}
   const drawer=action==='manage-customer'?'manage':action==='customer-access'?'access':null;
   if(!drawer||!canManageCustomers(current.user))return;
   // The hash, the view, the tree selection and the scope stay; the host loads the customers and opens the drawer.
   setCustomerDrawer({customerId:customer.id,customerName:customer.name,drawer});
   return;
  }
  const device=target.type==='device'?current.servers.find(server=>server.id===target.id)??current.permissionDevices?.find(item=>item.id===target.id):undefined,group=target.type==='group'?current.deviceGroups?.find(item=>item.id===target.id):undefined;
  if(target.type==='device'&&!device||target.type==='group'&&!group)return;
  if(action==='pin'||action==='unpin'){if(device&&(action==='pin')!==!!pinState.current.ids?.includes(device.id))togglePin(device.id);return;}
  if(action==='provision'){if(current.demo)return;go({view:'add-device',...(group?{groupId:group.id}:{})});return;}
  if(action==='permissions'){
   if(!canManageRoleAssignments(current.user))return;
   if(device){if(current.servers.some(server=>server.id===device.id)){openServer(device.id,'configuration','permissions');}else{openFleet('all');setFleetTab('permissions');}}
   else{openFleet(group?.id??'all');setFleetTab('permissions');}
   return;
  }
  if(current.demo)return;
  if(action==='create-group'){if(hasRootGroupRight(current.user)&&!device&&(!group||group.depth<4)){setCreateCustomer('');setCreateParent(group?.id??null);}return;}
  if(!group||!canManageGroup(current.user,group))return;
  if(action==='manage-group'){openFleet(group.id);setFleetTab('devices');setAssignGroupId(group.id);return;}
  if(action==='rename-group'){openFleet(group.id);setFleetTab('settings');setRenameGroup(previous=>({id:group.id,count:(previous?.count??0)+1}));return;}
  if(action==='delete-group'&&hasRootGroupRight(current.user)&&!current.deviceGroups?.some(child=>child.parentId===group.id))setDeleteGroupId(group.id);
 });
 const refreshNow=useCallback(()=>refresh(true),[refresh]);
 const access=useAccessChange(refreshNow),runAccess=useStableCallback(access.run);
 const moveDevices=useStableCallback(async(ids:string[],groupId:string|null)=>{
  const current=context.current;if(current.demo){toast.info(t('console.demoChanges'));return false;}
  const devices=current.servers.filter(server=>ids.includes(server.id));
  const moving=devices.filter(server=>deviceGroupId(server)!==groupId);
  if(!moving.length){toast.info(groupId?t('console.alreadyInGroup'):t('console.alreadyNoGroup'));return false;}
  const group=groupId?current.deviceGroups?.find(item=>item.id===groupId)?.name??t('console.theGroup'):'';
  const done=moving.length===1?(groupId?t('console.movedOne',{name:moving[0].name,group}):t('console.movedOneUngrouped',{name:moving[0].name})):(groupId?t('console.movedMany',{count:moving.length,group}):t('console.movedManyUngrouped',{count:moving.length}));
  const result=await access.run({action:'assign-device',serverIds:moving.map(server=>server.id),groupId},done);
  return !!result;
 });
 const moveFromTree=useCallback((ids:string[],groupId:string|null)=>void moveDevices(ids,groupId),[moveDevices]);
 // "Move to another customer…" (ui/devices/fleet/customer-move-drawer.tsx): the devices of the open drawer, and the
 // resolver of the entry that opened it (true after a move, false when the drawer closes without one). After a move the
 // console data refreshes, so the device shows under the target customer.
 const [customerMoveIds,setCustomerMoveIds]=useState<string[]>([]),customerMoveDone=useRef<((moved:boolean)=>void)|null>(null);
 const openCustomerMove=useStableCallback((ids:string[])=>new Promise<boolean>(resolve=>{customerMoveDone.current?.(false);customerMoveDone.current=resolve;setCustomerMoveIds(ids);}));
 const finishCustomerMove=(moved:boolean)=>{const done=customerMoveDone.current;customerMoveDone.current=null;setCustomerMoveIds([]);done?.(moved);if(moved)void refresh(true);};
 const customerMove=useMemo(()=>({customers:data?.customers??[],multipleCustomers:data?.multipleCustomers===true,onMove:openCustomerMove}),[data?.customers,data?.multipleCustomers,openCustomerMove]);
 const removeFromGroup=async(ids:string[],groupId:string)=>{
  if(context.current.demo)return false;
  const name=context.current.deviceGroups?.find(group=>group.id===groupId)?.name??t('console.ofTheGroup');
  return !!await access.run({action:'set-device-memberships',serverIds:ids,groupId,assigned:false},t('console.removedFromGroup',{count:ids.length,group:name}));
 };
 // The bulk bar's "Remove from group" and the empty group's "Move devices here…" of the open group.
 const removeFromCurrentGroup=useStableCallback((ids:string[])=>currentGroup?removeFromGroup(ids,currentGroup.id):Promise.resolve(false));
 const assignToCurrentGroup=useStableCallback(()=>{if(currentGroup)setAssignGroupId(currentGroup.id);});
 // "Show all devices" of an empty Ungrouped scope: the scope above it (the customer or All devices).
 const showScopeAbove=useStableCallback(()=>{if(currentCustomer)openCustomer(currentCustomer.id);else openFleet('all');});

 // An origin link of the alert rules opens that scope's Monitoring › Alert rules.
 const openAlertOrigin=useCallback((target:AlertOriginTarget)=>{if(target.type==='customer')openCustomer(target.id);else openFleet(target.type==='group'?target.id:'all');setFleetTab('alerts');},[openCustomer,openFleet]);
 // The origin of an inherited ESU date: the group or the customer on its OS support tab.
 const openEsuGroup=useCallback((groupId:string)=>{openFleet(groupId);setFleetTab('os-support');},[openFleet]);
 const openEsuCustomer=useCallback((customerId:string)=>{openCustomer(customerId);setFleetTab('os-support');},[openCustomer]);
 // A customer origin (alert rules, ESU) links only where the viewer has that customer's view (or sees sample devices).
 const customerOpens=useCallback((customerId:string|null|undefined)=>demo||customerViewAvailable(customers,customerId??undefined),[demo,customers]);
 const openTagOrigin=useCallback((groupId:string)=>{openFleet(groupId);setFleetTab('tags');},[openFleet]);
 const openNotificationOrigin=useCallback((target:NotificationOriginTarget)=>{if(target.type==='customer')openCustomer(target.id);else openFleet(target.type==='group'?target.id:'all');setFleetTab('notifications');},[openCustomer,openFleet]);
 // The tree's "All devices" and "Ungrouped" nodes.
 const openAll=useCallback(()=>openFleet('all'),[openFleet]);
 const openUngrouped=useCallback((customerId?:string)=>{if(customerId)openCustomer(customerId,true);else openFleet('unassigned');},[openCustomer,openFleet]);
 // The head links of Monitoring › Notification rules: Settings › Notification channels and its Delivery log.
 const openChannels=useCallback(()=>go({view:'settings',page:'notification-channels'}),[go]),openDeliveryLog=useCallback(()=>go({view:'settings',page:'notification-channels',tab:'log'}),[go]);
 // The one action of a device that no notification rule reaches: Monitoring › Notification rules of its nearest group the
 // viewer may open (the deepest of its groups in the visible group list), else of All devices.
 const deviceRulesPlace=(device:Device)=>{
  const references=device.groups??(device.groupId?[{id:device.groupId}]:[]);
  const group=references.flatMap(reference=>deviceGroups?.filter(item=>item.id===reference.id)??[]).sort((a,b)=>b.depth-a.depth||a.name.localeCompare(b.name))[0];
  return group?{name:group.name,onOpen:()=>openNotificationOrigin({type:'group',id:group.id})}:{name:t('tree.allDevices'),onOpen:()=>openNotificationOrigin({type:'all'})};
 };
 const selectJob=useCallback((selectedJob:Job)=>{
  if(selectedJob.action==='runbook-run'&&selectedJob.metadata?.runbookRunId){const runId=selectedJob.metadata.runbookRunId;setRunbookFocus(previous=>({runId,serverId:selectedJob.serverId,revision:(previous?.revision??0)+1}));setCustomerFilter('');setView('automation');setAutomationPage('runbooks');setFrameTab('runs');setJobsOpen(false);setJobId('');}
  else setJobId(selectedJob.id);
 },[]);
 const toggleNavigator=()=>{
  if(overlay){setDrawerOpen(open=>!open);return;}
  setCollapsed(previous=>{const next=!previous;try{localStorage.setItem('serverdesk.redesign.navigator',next?'collapsed':'open');}catch{}return next;});
 };

 // Removal, jobs and cancelling jobs (console-action.ts). A successful removal
 // leaves a removed device's page and clears the job and runbook focus.
 const action=(payload:Record<string,unknown>,onSettled?:Confirmation['onSettled'],options:ConsoleActionOptions={}):Promise<void>=>runConsoleAction(payload,{
  demo,canOffboard:()=>offboardAllowed.current,
  post:(body,endpoint)=>credentialFetch(endpoint??'/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
  openStepUp:retry=>{mfaRetry.current=retry;setMfaOpen(true);},
  // PLUGIN_AD_SIGN_IN_REQUIRED: the AD sign-in for the named device, then the same request once more (docs/plugin-ad-sign-in.md).
  openAdSignIn:(serverId,plugin,retry)=>void requestAdSignIn(serverId,plugin).then(ok=>{if(ok)void retry();}),
  toast,onRemoved:removed=>{if(removed.includes(selected)){setSelected('');setView('devices');}setJobId('');setRunbookFocus(null);},
  onUninstallRequested:ids=>setOffboardingIds(current=>current.length?[...new Set([...current,...ids])]:ids),
  refresh:()=>refresh(true),setSaving,action:next=>action(next,onSettled,options),locale,onSettled,
 },options);
 const cancelJob=useStableCallback((item:Job)=>{
  if(!canCancelJob(item,servers,user))return;
  openConfirmation({title:t('console.cancelJob.title'),description:t('console.cancelJob.description',{device:servers.find(server=>server.id===item.serverId)?.name??item.serverId,action:jobActionLabel(item.action,locale,item.target),target:item.target}),confirmLabel:t('jobs.cancel'),payload:{action:'cancel-job',id:item.id}});
 });
 // A personal registration needs a fresh step-up proof (lib/step-up.ts). The
 // server answers MFA_STEP_UP_REQUIRED after validation; the dialog then resends
 // the same input once with managementToken. Cancelling keeps the page's form.
 // With several customers the input names a customer; if a second customer
 // was created while the page was open, the server answers
 // ENROLL_CUSTOMER_REQUIRED: the form keeps its input and the reload adds the field.
 // On success the browser saves the file and the page learns the device id from it.
 const enroll=async(input:EnrollInput&{managementToken?:string},registered:(registration:Registration)=>void):Promise<void>=>{
  const current=context.current;if(current.demo||!isOwner(current.user)||current.user.id!==user.id)return;
  if(input.groupId&&!current.deviceGroups?.some(group=>group.id===input.groupId)){toast.error(t('console.groupGone'));return;}
  setSaving(true);
  try{
   await submitEnrollment(input,{
    post:body=>credentialFetch('/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
    failure:async response=>{const result=await readApiJson<{error?:string;code?:string}>(response);return new ApiError(apiErrorText(locale,result,t('console.registrationFailed')),response.status,result.code);},
    created:async response=>{
     const blob=await response.blob(),fileName=registrationFileName(input.name),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=fileName;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
     registered({name:input.name,fileName,deviceId:registrationDeviceId(await blob.text())});
     toast.success(t('console.registrationDownloaded'));await refresh(true);
    },
    stepUp:failure=>{if(!stepUpRejected(failure))return false;mfaRetry.current=stepUpRetry(input,payload=>enroll(payload,registered),toast.error,locale);setMfaOpen(true);return true;},
    error:message=>{toast.error(message);},
    refresh:()=>refresh(true),
    fallback:t('console.registrationFailed'),
   });
  }finally{setSaving(false);}
 };

 // The drawer's rows that left the portal: leave their page and reload the device list.
 const offboarded=(ids:string[])=>{if(ids.includes(selected)){setSelected('');setView('devices');}void refresh(true);};
 const loadOffboarding=useCallback(async(ids:string[])=>{
  const response=await credentialFetch('/api/console?offboarding='+ids.join(','),{cache:'no-store'});
  const result=await readApiJson<{devices?:OffboardingEntry[];error?:string;code?:string}>(response);
  if(!response.ok)throw new ApiError(apiErrorText(documentLocale(),result,t('console.offboarding.loadFailed')),response.status,result.code);
  return result.devices??[];
 },[t]);
 const area:Area=areaOf(route),page=routeNode(route);
 const currentCustomerId=currentCustomer?.id;
 const scope=useMemo<FleetScope>(()=>currentCustomerId?(customerUngrouped?{type:'unassigned',customerId:currentCustomerId}:{type:'customer',id:currentCustomerId}):groupFilter==='all'?{type:'all'}:groupFilter==='unassigned'?{type:'unassigned'}:{type:'group',id:groupFilter},[currentCustomerId,customerUngrouped,groupFilter]);
 // What the visibility rules of the navigation model look at.
 const navContext:NavContext={viewer:user,scope,group:currentGroup,customers,multipleCustomers:data?.multipleCustomers===true};
 // A settings page the viewer may not open (its node rule: the section right, the Owner for the agent pages
 // and for Customers) falls back to All devices without a history entry, once the data is there.
 const settingsAllowed=view==='settings'&&!!page&&page.visible(navContext),settingsBlocked=view==='settings'&&!settingsAllowed&&(!!data||demo);
 useEffect(()=>{if(!settingsBlocked)return;const hash=consoleRouteHash({view:'devices'});replaceHash(hash);queueMicrotask(()=>applyRoute(hash));},[settingsBlocked,applyRoute]);
 // The section AccessWorkspace renders; the agent pages (Agent releases, Extensions, Agent troubleshooting) have none and render their own parts.
 const accessSection=settingsAllowed?settingsSection({page:settingsPage,tab:frameTab}):null;
 const adminEntry=firstSettingsPage(navContext);
 const scoped=useMemo(()=>scopeDevices(servers,scope),[servers,scope]);
 // The "Ungrouped" nodes of the tree (customer-folders.ts): the palette lists the same ones.
 const ungroupedTreeNodes=useMemo(()=>{
  const known=new Set((deviceGroups??[]).map(group=>group.id)),roots=(deviceGroups??[]).filter(group=>!group.parentId||!known.has(group.parentId));
  const loose=servers.filter(server=>!(server.groups?.length||server.groupId));
  return ungroupedNodes(customerFolders(customers,roots.map(group=>({id:group.id,customerId:group.customerId})),loose,servers),roots.length,loose.map(server=>server.id));
 },[deviceGroups,servers,customers]);
 // The dock's job: the running or due job (the open device's first), else for 12 s the job that just finished. A
 // selector of the clock: it changes when a pending job becomes due or the 12 s end.
 const recentId=recentFinished?.id,recentUntil=recentFinished?.until??0,preferredDevice=view==='device'?selected:undefined;
 const summaryJobId=useClockValue(now=>currentJob(jobs,now,preferredDevice,recentId&&now<recentUntil?recentId:undefined)?.id);
 const summaryJob=summaryJobId===undefined?undefined:jobs.find(item=>item.id===summaryJobId);
 // The crumb helpers of the scope header, the device page and Add device. They change with the groups, the customers
 // and the language only, so the memoized scope header keeps its identity across clock ticks and unchanged refreshes.
 const {groupPath,customerCrumbs,groupCustomer,rootCrumb}=useMemo(()=>{
  // The groups from the root group down to a group.
  const groupChain=(id:string|null|undefined)=>{const chain:NonNullable<typeof deviceGroups>[number][]=[],seen=new Set<string>();let current=deviceGroups?.find(group=>group.id===id);while(current&&!seen.has(current.id)){seen.add(current.id);chain.unshift(current);current=current.parentId?deviceGroups?.find(group=>group.id===current!.parentId):undefined;}return chain;};
  const groupPath=(id:string|null|undefined):Crumb[]=>{
   const path:Crumb[]=groupChain(id).map(group=>({label:group.name,href:consoleRouteHash({view:'devices',groupId:group.id}),onSelect:()=>openFleet(group.id)}));
   if(!path.length&&id){
    const name=groups.find(([groupId])=>groupId===id)?.[1];
    if(name)path.push({label:name,href:consoleRouteHash({view:'devices',groupId:id}),onSelect:()=>openFleet(id)});
   }
   return path;
  };
  // The customer crumb (L3): the customer of a group (its root group's customer), a device or Add device, only while the
  // tree shows that customer as a folder (customerViewAvailable), so the crumbs match the tree.
  const customerCrumbs=(customerId:string|null|undefined):Crumb[]=>{const customer=customerId&&customerViewAvailable(customers,customerId)?customers?.find(item=>item.id===customerId):undefined;return customer?[{label:customer.name,href:consoleRouteHash({view:'devices',customerId:customer.id}),onSelect:()=>openCustomer(customer.id)}]:[];};
  const groupCustomer=(id:string|null|undefined)=>groupChain(id)[0]?.customerId;
  const rootCrumb:Crumb={label:t('nav.allDevices'),href:consoleRouteHash({view:'devices'}),onSelect:()=>openFleet('all')};
  return {groupPath,customerCrumbs,groupCustomer,rootCrumb};
 },[deviceGroups,groups,customers,openFleet,openCustomer,t]);
 const step=(direction:1|-1)=>{if(view!=='device'||!active||orderedServers.length<2)return;const at=orderedServers.findIndex(server=>server.id===active.id);openServer(orderedServers[(at+direction+orderedServers.length)%orderedServers.length].id,deviceMainSection(deviceSection));};
 const startDemo=useCallback((on:boolean)=>{setDemo(on);setView('devices');setSelected('');setGroupFilter('all');setCustomerFilter('');},[]);
 const showDemo=useCallback(()=>startDemo(true),[startDemo]);
 // The refresh of the top bar, R and the palette: the console data, and the open framed page through PageFrame.refresh.
 const reload=()=>{setFrameRefresh(count=>count+1);void refresh();};

 // One palette item per device, the largest part of the palette's list (250 devices: 250 items). Built when the
 // palette opens and kept for the next opening while the device list (its identity: a refresh that changes a device,
 // a rename included, gives a new list) and the language stay; openServer keeps its identity.
 const deviceItemsCache=useRef<{servers:Server[];t:typeof t;items:PaletteItem[]}|null>(null);
 const paletteDeviceItems=():PaletteItem[]=>{
  const cached=deviceItemsCache.current;
  if(cached&&cached.servers===orderedServers&&cached.t===t)return cached.items;
  const items=orderedServers.map((server):PaletteItem=>{
   const address=primaryDeviceAddress(server);
   return {
    id:'device-'+server.id,group:t('palette.group.devices'),label:server.name,
    hint:[address,server.groupName].filter(Boolean).join(' · ')||server.snapshot?.os.replace('Microsoft ',''),
    keywords:`${server.snapshot?.os??''} ${server.snapshot?.domain??''} ${(server.previousNames??[]).join(' ')}`,Icon:deviceTypeIcons[deviceType(server)],
    run:()=>openServer(server.id),
   };
  });
  deviceItemsCache.current={servers:orderedServers,t,items};
  return items;
 };
 const paletteItems=():PaletteItem[]=>{
  const items:PaletteItem[]=[];
  // The pinned devices come first, in the group Pinned and by name, and not again under Devices.
  const pinnedSet=new Set(pinnedIds??[]),deviceItems=paletteDeviceItems();
  if(pinnedSet.size)items.push(...orderedServers.filter(server=>pinnedSet.has(server.id)).sort((a,b)=>a.name.localeCompare(b.name,locale,{numeric:true}))
   .map(server=>({...deviceItems.find(item=>item.id==='device-'+server.id)!,group:t('pins.title')})));
  // Pin or unpin the open device.
  if(view==='device'&&active&&!demo){const pinned=pinnedSet.has(active.id);items.push({
   id:'device-pin',group:active.name,label:t(pinned?'pins.unpin':'pins.pin'),keywords:t('pins.keywords'),Icon:pinned?PinOff:Pin,
   run:()=>togglePin(active.id),
  });}
  // The edit mode of the open Dashboard; sample devices keep the built-in layout.
  if(view==='dashboard'&&!demo)items.push({
   id:'action-customize-dashboard',group:t('rail.dashboard'),label:t('palette.action.customizeDashboard'),keywords:t('dashboard.paletteKeywords'),Icon:SlidersHorizontal,
   run:()=>setCustomizeDashboard(count=>count+1),
  });
  // GPU driver updates: Hardware → GPU of the first NVIDIA or AMD graphics card of the open device.
  const driverGpu=view==='device'&&active?gpuDriverPosition(active.snapshot):0;
  if(active&&driverGpu)items.push({
   id:'device-gpu-driver',group:active.name,label:t('palette.action.updateGpuDriver'),hint:t('device.section.hardware'),
   keywords:'gpu graphics driver nvidia amd grafiktreiber',Icon:Gpu,
   run:()=>{openServer(active.id,'hardware','gpu');setDeviceDetail(deviceDetailRoute('hardware','gpu',driverGpu));},
  });
  // The areas of the open device from the navigation model, in tab order; Extensions only when the device has a
  // detected role or product, with the search words of its former names (node.keywords).
  // The assistant of the open device opens its non-modal drawer; the route stays as it is (drawers have no link).
  if(view==='device'&&active&&active.revoked===0)items.push({
   id:'device-rename',group:active.name,label:t('device.name.rename'),
   keywords:t('device.name.paletteKeywords'),Icon:PencilLine,
   run:()=>openRename(active.id),
  });
  if(view==='device'&&active&&assistantAvailable(active,user))items.push({
   id:'device-assistant',group:active.name,label:t('assistant.palette.ask',{name:active.name}),
   keywords:'ai ki assistant assistent claude openai chatgpt',Icon:Sparkles,
   run:()=>setAssistantDevice(active.id),
  });
  const areas=view==='device'&&active?visibleDeviceAreas(active,user):[],extensions=areas.some(node=>node.deviceSection==='extensions');
  if(view==='device'&&active)for(const node of areas){
   const section=node.deviceSection!;
   items.push({
    id:'section-'+section,group:active.name,label:t(node.label),hint:t('palette.hint.area'),
    keywords:node.keywords,Icon:ChevronRight,
    run:()=>openServer(active.id,section),
   });
  }
  // The DHCP server of a device whose DHCP extension is installed (ui/devices/extensions/device-dhcp.tsx).
  if(view==='device'&&active&&snapshotPlugin(active.snapshot,'dhcp')?.state==='ready'&&extensions)items.push({
   id:'device-dhcp',group:active.name,label:t('palette.device.dhcp'),hint:t('palette.hint.area'),
   keywords:'dhcp scope lease reservation failover',Icon:Router,
   run:()=>openServer(active.id,'extensions','dhcp'),
  });
  // DHCP extension 1.1.0: a new scope opens the DHCP view with the scope form.
  if(view==='device'&&active&&pluginReady(active.snapshot,'dhcp','dhcp-scope-create')&&extensions)items.push({
   id:'device-dhcp-new-scope',group:active.name,label:t('palette.device.dhcpNewScope'),hint:t('palette.hint.area'),
   keywords:'dhcp scope create',Icon:Router,
   run:()=>{openServer(active.id,'extensions','dhcp');requestDhcpForm(active.id);},
  });
  // DNS extension 1.0.0: a new zone opens the DNS view with the zone form.
  if(view==='device'&&active&&pluginReady(active.snapshot,'dns','dns-zone-create')&&extensions)items.push({
   id:'device-dns-new-zone',group:active.name,label:t('palette.device.dnsNewZone'),hint:t('palette.hint.area'),
   keywords:'dns zone create',Icon:Globe,
   run:()=>{openServer(active.id,'extensions','dns');requestDnsForm(active.id);},
  });
  // The AD sign-in for plugin changes on a device whose DHCP plugin is ready and whose agent runs changes as the account (4.19.0).
  if(view==='device'&&active&&!demo&&snapshotPlugin(active.snapshot,'dhcp')?.state==='ready'&&adIdentityReady(active.snapshot))items.push({
   id:'device-ad-sign-in',group:active.name,label:t('palette.pluginAdSignIn'),hint:t('dhcp.title'),
   keywords:'ad sign in account domain',Icon:KeyRound,
   run:()=>void requestAdSignIn(active.id,'dhcp'),
  });
  items.push(...(pinnedSet.size?deviceItems.filter(item=>!pinnedSet.has(item.id.slice('device-'.length))):deviceItems));
  for(const customer of customers??[])if(customerViewAvailable(customers,customer.id))items.push({
   id:'customer-'+customer.id,group:t('palette.group.customers'),label:customer.name,hint:t('palette.hint.customer'),
   Icon:Building2,
   run:()=>openCustomer(customer.id),
  });
  for(const [id,name] of groups)items.push({
   id:'group-'+id,group:t('palette.group.groups'),label:name,hint:t('palette.hint.deviceGroup'),
   Icon:FolderKey,
   run:()=>openFleet(id),
  });
  // The "Ungrouped" nodes the tree shows, with their parent as hint.
  for(const node of ungroupedTreeNodes){
   const customer=node.customerId?customers?.find(item=>item.id===node.customerId):undefined;const customerId=customer?.id;
   items.push({
    id:'ungrouped-'+(customerId??'all'),group:t('palette.group.groups'),label:t('console.ungrouped'),hint:customer?.name??t('nav.allDevices'),
    Icon:Inbox,
    run:()=>{if(customerId)openCustomer(customerId,true);else openFleet('unassigned');},
   });
  }
  // The pages of the navigation model (ui/shell/nav-model.ts) the viewer may open, each once, with its exact label and its parent path as
  // the hint; the scope tabs are those of All devices. Add device opens in demo mode too, where the page blocks its actions.
  // A page tab (Runs, Delivery log) follows its page and opens the page on that tab.
  for(const node of palettePages)if(node.visible({...navContext,scope:{type:'all'},group:undefined})){
   const palette=node.palette!,hint=paletteHint(node,t);
   items.push({
    id:palette.id,group:t('palette.group.pages'),label:t(palette.label??node.label),...(hint?{hint}:{}),
    keywords:paletteKeywords(node,t),Icon:navIcons[palette.icon??node.icon],
    run:()=>go(node.route),
   });
  }
  items.push(
   {id:'action-refresh',group:t('palette.group.actions'),label:t('palette.action.refresh'),Icon:RefreshCw,run:()=>reload()},
   {id:'action-demo',group:t('palette.group.actions'),label:t(demo?'palette.action.hideDemo':'palette.action.showDemo'),keywords:'demo',Icon:FlaskConical,run:()=>startDemo(!demo)},
   {id:'action-help',group:t('palette.group.actions'),label:t('palette.action.help'),keywords:'shortcuts dokumentation',Icon:CircleHelp,run:()=>toggleHelp(true)},
   ...themePaletteItems(applyTheme,locale),...schemePaletteItems(effectiveMode(currentTheme()),locale,undefined,data?.branding?.scheme!=null),
   ...languagePaletteItems(locale,setLocale),...startPagePaletteItems(locale,()=>toast.success(t('startPage.saved'))),
   // The density of this browser (ui/shell/density.tsx): one action for the other density.
   ...densityPaletteItems(currentDensity(),applyDensity,locale),
  );
  // The account's console background, offered while the portal has one; the same effect as the switch in My account.
  if(data?.branding?.consoleBackground)items.push({id:'action-console-background',group:t('palette.group.actions'),
   label:t(consoleBackgroundOn?'palette.action.consoleBackgroundOff':'palette.action.consoleBackgroundOn'),keywords:'background hintergrund branding',Icon:PanelsTopLeft,
   run:()=>{void changeConsoleBackground(!consoleBackgroundOn).catch(failure=>toast.error(message(failure)));}});
  return items;
 };
 // The palette closes Help; Help closes the palette. The palette, Help, the Jobs sheet and the fleet search field also
 // close the navigator overlay (900px or narrower): it sits above the page layers, and its scrim leaves the top bar
 // tappable, so a layer opened from there would open underneath it.
 // The navigator overlay is console state: it closes only when it is open, so opening a layer with it closed
 // changes no console state and the console does not render again.
 const openPalette=()=>{if(drawerOpen)setDrawerOpen(false);overlays.openPalette();};
 const toggleHelp=(open?:boolean)=>{if(drawerOpen)setDrawerOpen(false);overlays.toggleHelp(open);};
 // The palette reads its items once per opening through a getItems that keeps its identity, so the memoized palette
 // host does not render again with the console (its clock, a data refresh). The ref follows the latest paletteItems.
 const paletteItemsRef=useRef(paletteItems);
 useLayoutEffect(()=>{paletteItemsRef.current=paletteItems;});
 const getPaletteItems=useCallback(()=>paletteItemsRef.current(),[]);
 // A new device list prepares the palette's device items when the browser is idle, so the next opening does not build
 // them in its key event (250 devices: about 8 ms of the opening key at 4× CPU). Without requestIdleCallback the opening
 // builds them, as before.
 const paletteDeviceItemsRef=useRef(paletteDeviceItems);
 useLayoutEffect(()=>{paletteDeviceItemsRef.current=paletteDeviceItems;});
 useEffect(()=>{
  if(typeof requestIdleCallback!=='function')return;
  const id=requestIdleCallback(()=>paletteDeviceItemsRef.current(),{timeout:2000});
  return ()=>cancelIdleCallback(id);
 },[orderedServers,t]);
 const toggleJobs=()=>{setDrawerOpen(false);setJobsOpen(open=>!open);};
 useConsoleShortcuts({
  palette:openPalette,
  help:()=>toggleHelp(),
  search:()=>{const field=document.getElementById('sdx-fleet-search');if(view==='devices'&&field){setDrawerOpen(false);field.focus();}else openPalette();},
  refresh:()=>reload(),
  jobs:toggleJobs,
  go:node=>{if(node.id==='devices')openFleet('all');else if(node.id==='settings'){if(adminEntry)go({view:'settings',page:adminEntry});}else if(node.route.view==='add-device'){if(isAdmin&&!demo)inventoryAction('provision',{type:'global',name:t('nav.allDevices')});}else go(node.route);},
  // 1–9: the key areas of the model (Configuration has none); 9 does nothing on a device without Extensions.
  section:index=>{const section=active?deviceKeyAreas(active)[index]?.deviceSection:undefined;if(view==='device'&&active&&section)openServer(active.id,section);},
  step,
 });

 // The rail items of the navigation model. Devices returns to the scope of a device or Add device; Automation and Settings
 // return to their last page, Settings to the first page the viewer may open when the last one is not allowed.
 const openArea=(next:Area)=>{
  if(next==='dashboard')go({view:'dashboard'});
  else if(next==='devices'){if(area==='devices'&&view!=='devices')openFleet(groupFilter);else openFleet('all');}
  else if(next==='automation')go({view:'automation',page:automationPage});
  else if(next==='settings'){const target=routeNode({view:'settings',page:lastSettingsPage})?.visible(navContext)?lastSettingsPage:adminEntry;if(target)go({view:'settings',page:target});}
 };
 // At 900px or narrower the active item of an area with a navigator (Devices, Automation, Settings) toggles the navigator
 // overlay and reports it with aria-expanded; an inactive item navigates as wider.
 const railItems:RailItem[]=visibleRail(navContext).map(node=>{
  const id=node.placement.area,toggles=overlay&&id===area&&(id==='devices'||id==='automation'||id==='settings');
  return {id,label:t(node.label),icon:navIcons[node.icon],shortcut:node.shortcut?.keys??'',...(node.placement.end?{placement:'end' as const}:{}),...(toggles?{expanded:drawerOpen}:{}),onSelect:()=>{if(toggles)setDrawerOpen(open=>!open);else openArea(id);}};
 });
 // The Jobs item of the bottom bar (900px or narrower): the dock badge count; the sheet gives focus back to it.
 const jobsItem=useRef<HTMLButtonElement>(null),jobBadge=useClockValue(now=>{const counts=jobCounts(jobs,now);return counts.running+counts.waiting;});
 const showAllJobs=()=>{openFleet('all');setFleetTab('jobs');setJobsOpen(false);};

 const canCreateGroup=!demo&&hasRootGroupRight(user);
 // The header counts: selectors of the clock, so a tick renders the console only when a device of the scope goes online
 // or offline or its issues show or hide.
 const online=useClockValue(now=>scoped.filter(server=>connectionKind(server,now)==='online').length),flagged=useClockValue(now=>scoped.filter(server=>deviceHasIssues(server,now)).length);
 const fleetTitle=customerUngrouped?t('console.ungrouped'):currentCustomer?currentCustomer.name:groupFilter==='all'?t('nav.allDevices'):groupFilter==='unassigned'?t('console.ungrouped'):groups.find(([id])=>id===groupFilter)?.[1]??t('console.groupFallback');
 // The group description is its own line; the subtitle holds the counts only (ui/devices/fleet/fleet-header.ts).
 const fleetLines=fleetHeaderLines({description:currentGroup?.description,count:scoped.length,online,flagged},locale);
 // "Add device" on every scope for the Owner: the add-device page with the scope's group or customer (an Ungrouped scope keeps its customer).
 const addDeviceRoute:ConsoleRoute=scope.type==='group'?{view:'add-device',groupId:scope.id}:scope.type==='customer'?{view:'add-device',customerId:scope.id}:scope.type==='unassigned'&&scope.customerId?{view:'add-device',customerId:scope.customerId}:{view:'add-device'};
 const addDevice=useStableCallback(()=>{if(!context.current.demo&&isOwner(context.current.user))go(addDeviceRoute);});
 // The scope header and the Configuration contents are memoized elements: FleetView is memoized, and a console render
 // that changes nothing they show (a clock-derived value elsewhere, an unchanged refresh) hands it the same props.
 // The group whose header offers "Move devices here…" (a group the viewer may manage).
 const moveHereGroupId=currentGroup&&canManageGroup(user,currentGroup)?currentGroup.id:undefined;
 const fleetHeader=useMemo(()=>{
  // Root: secondary actions in the menu. Groups: everything lives in the tabs, so there is no menu.
  const rootMenu:MenuEntry[]=[
   ...(canCreateGroup?[{id:'create',label:t('console.createGroup'),icon:FolderPlus,onSelect:()=>inventoryAction('create-group',{type:'global',name:t('nav.allDevices')})}]:[]),
   {id:'demo',label:t(demo?'palette.action.hideDemo':'palette.action.showDemo'),icon:FlaskConical,onSelect:()=>startDemo(!demo)},
  ];
  // Customer view: the same entries as the folder menu in the tree, no primary action.
  const customerMenu:MenuEntry[]=currentCustomer&&!customerUngrouped&&!demo?customerFolderActions({canCreateRootGroup:hasRootGroupRight(user),canManageCustomers:canManageCustomers(user)}).map(({action,label})=>({id:action,label:t(label),icon:customerActionIcons[action],onSelect:()=>inventoryAction(action,{type:'customer',id:currentCustomer.id,name:currentCustomer.name})})):[];
  // "Move devices here…" on a group the viewer may manage: today's drawer that brings devices into the group.
  // At 760px or narrower the scope header is one line (PageHeader compact): the actions become icon buttons with the same names.
  const moveHere=moveHereGroupId?narrow
   ?<IconBtn icon={FolderInput} label={t('console.moveDevicesHere')} blocked={demo?t('kit.unavailable.demo'):undefined} onClick={()=>setAssignGroupId(moveHereGroupId)}/>
   :<Btn icon={FolderInput} blocked={demo?t('kit.unavailable.demo'):undefined} onClick={()=>setAssignGroupId(moveHereGroupId)}>{t('console.moveDevicesHere')}</Btn>:undefined;
  return <PageHeader
   crumbs={customerUngrouped&&currentCustomer
    ?[rootCrumb,{label:currentCustomer.name,href:consoleRouteHash({view:'devices',customerId:currentCustomer.id}),onSelect:()=>openCustomer(currentCustomer.id)},{label:t('console.ungrouped')}]
    :currentCustomer?[rootCrumb,{label:currentCustomer.name}]
    :groupFilter==='all'?undefined
    :[rootCrumb,...(groupFilter==='unassigned'?[{label:t('console.ungrouped')}]:[...customerCrumbs(groupCustomer(groupFilter)),...groupPath(groupFilter)])]}
   title={fleetTitle}
   description={fleetLines.description?<p className="sdx-page-description">{fleetLines.description}</p>:undefined}
   subtitle={fleetLines.subtitle}
   actions={customerUngrouped?undefined:currentCustomer?customerMenu.length?<Menu label={t('console.moreActions')} entries={customerMenu}/>:undefined:groupFilter==='all'?<Menu label={t('console.moreActions')} entries={rootMenu}/>:moveHere}
   compact={narrow}
   primary={isAdmin&&(narrow
    ?<IconBtn variant="primary" icon={Plus} label={t('console.addDevice')} blocked={demo?t('kit.unavailable.demo'):undefined} onClick={addDevice}/>
    :<Btn variant="primary" icon={Plus} blocked={demo?t('kit.unavailable.demo'):undefined} onClick={addDevice}>{t('console.addDevice')}</Btn>)}/>;
 },[canCreateGroup,t,inventoryAction,demo,startDemo,currentCustomer,customerUngrouped,user,moveHereGroupId,narrow,rootCrumb,openCustomer,groupFilter,customerCrumbs,groupCustomer,groupPath,fleetTitle,fleetLines.description,fleetLines.subtitle,isAdmin,addDevice]);
 const fleetPermissions=useMemo(()=>canManageRoleAssignments(user)&&!currentCustomer&&groupFilter!=='unassigned'&&targetAvailable?<div className="sdx-embedded">
  <ScopedPermissionEditor key={groupFilter} viewer={user} demo={demo} onRefresh={()=>refresh(true)} refreshKey={frameRefresh}
   prefill={groupFilter==='all'?permissionPrefill??undefined:undefined} onPrefillDone={()=>setPermissionPrefill(null)}
   scope={groupTarget.type==='group'?{type:'group',id:groupTarget.id}:{type:'global'}} scopeName={groupTarget.name}
   onOpenScope={target=>inventoryAction('permissions',target)}/>
 </div>:undefined,[user,currentCustomer,groupFilter,targetAvailable,demo,refresh,frameRefresh,permissionPrefill,groupTarget,inventoryAction]);
 // Every viewer of the scope reads its alert rules; the server decides who may change them. A customer is a level of its
 // own between All devices and its groups (docs/alert-rules.md).
 const alertScope=useMemo(()=>scopeTabs(scope.type).some(tab=>tab.id==='alerts')&&targetAvailable?(scope.type==='customer'?{type:'customer' as const,id:scope.id}:groupTarget.type==='group'&&groupTarget.id?{type:'group' as const,id:groupTarget.id}:{type:'global' as const,id:'*'}):null,[scope,targetAvailable,groupTarget]);
 const alertCustomerView=customerOpens(scope.type==='customer'?scope.id:currentGroup?.customerId);
 const fleetAlerts=useMemo(()=>alertScope?<div className="sdx-embedded">
  <AlertRulesPanel key={alertScope.type+':'+alertScope.id} scope={alertScope} scopeName={scope.type==='customer'?currentCustomer?.name??'':groupTarget.name} customerView={alertCustomerView}
   demo={demo} onRefresh={()=>refresh(true)} onOpenOrigin={openAlertOrigin}/>
 </div>:undefined,[alertScope,scope.type,currentCustomer,groupTarget.name,alertCustomerView,demo,refresh,openAlertOrigin]);
 // Notification rules on All devices, a group and (once a second customer exists) a customer; the server decides who may change them.
 const multipleCustomers=data?.multipleCustomers===true;
 const notificationScope=useMemo(()=>scope.type==='customer'&&currentCustomer
  ?(multipleCustomers||demo?{type:'customer' as const,id:currentCustomer.id,name:currentCustomer.name}:null)
  :scope.type==='all'?{type:'all' as const,id:'*',name:t('nav.allDevices')}
  :scope.type==='group'&&groupTarget.type==='group'&&groupTarget.id&&targetAvailable?{type:'group' as const,id:groupTarget.id,name:groupTarget.name}:null,
 [scope.type,currentCustomer,multipleCustomers,demo,t,groupTarget,targetAvailable]);
 const fleetNotifications=useMemo(()=>notificationScope&&scopeTabs(scope.type).some(tab=>tab.id==='notifications')?<div className="sdx-embedded">
  <NotificationRulesPanel key={notificationScope.type+':'+notificationScope.id} scope={{type:notificationScope.type,id:notificationScope.id}} scopeName={notificationScope.name}
   demo={demo} canManageChannels={canManageNotifications(user)}
   onOpenOrigin={openNotificationOrigin} onOpenSettings={openChannels} onOpenLog={openDeliveryLog} onHideDemo={()=>startDemo(false)}/>
 </div>:undefined,[notificationScope,scope.type,demo,user,openNotificationOrigin,openChannels,openDeliveryLog,startDemo]);
 // The focal point of Monitoring › By device: what is watched (the alert rules of the subtab) and who is told (its
 // notification rules). A scope without a rules subtab (Ungrouped) has none.
 const fleetSummary=useMemo(()=>fleetAlerts||fleetNotifications?<MonitoringSummaryRow alertScope={fleetAlerts?alertScope:null}
  notificationScope={fleetNotifications&&notificationScope?{type:notificationScope.type,id:notificationScope.id}:null} demo={demo}
  onOpenAlertRules={()=>setFleetTab('alerts')} onOpenNotificationRules={()=>setFleetTab('notifications')}/>:undefined,[fleetAlerts,fleetNotifications,alertScope,notificationScope,demo]);
 // Tags belong to device groups (not All devices, Ungrouped or a customer); every viewer of the group reads them.
 const fleetTags=useMemo(()=>scope.type==='group'&&groupTarget.type==='group'&&groupTarget.id&&targetAvailable?<div className="sdx-embedded">
  <TagsPanel key={groupFilter} scope={{type:'group',id:groupTarget.id}} scopeName={groupTarget.name} demo={demo} onRefresh={()=>refresh(true)} onOpenOrigin={openTagOrigin}/>
 </div>:undefined,[scope.type,groupTarget,targetAvailable,groupFilter,demo,refresh,openTagOrigin]);
 const accessBusy=access.busy;
 const fleetSettings=useMemo(()=>{
  const group=deviceGroups?.find(item=>item.id===groupFilter);
  return group&&canManageCurrentGroup?<GroupSettings key={group.id+':'+group.name+':'+group.description} group={group} groups={deviceGroups??[]} viewer={user} busy={accessBusy} demo={demo}
   focusName={renameGroup?.id===group.id?renameGroup.count:undefined} onNameFocused={()=>setRenameGroup(null)}
   onUpdate={input=>runAccess({action:'update-group',id:group.id,...input},t('console.groupSaved'))}
   onCreateChild={()=>inventoryAction('create-group',{type:'group',id:group.id,name:group.name})}
   onDelete={()=>inventoryAction('delete-group',{type:'group',id:group.id,name:group.name})}/>:undefined;
 },[deviceGroups,groupFilter,canManageCurrentGroup,user,accessBusy,demo,renameGroup,runAccess,t,inventoryAction]);
 // A Monitoring rules or Configuration link the viewer cannot have (Permissions without portal.roleAssignments.manage, General
 // without canManageGroup, demo mode) or whose content is missing (Notification rules of a customer while only one customer exists)
 // shows the scope's Devices tab: once the data is there, the address becomes the scope hash without a new history entry.
 const configurationContent:Partial<Record<FleetTab,ReactNode>>={alerts:fleetAlerts,notifications:fleetNotifications,tags:fleetTags,permissions:fleetPermissions,settings:fleetSettings};
 const fleetTabBlocked=view==='devices'&&(!!data||demo)&&fleetTab in configurationContent&&!configurationContent[fleetTab],scopeHash=scopeTabHref(scope,'devices');
 useEffect(()=>{
  if(!fleetTabBlocked)return;
  replaceHash(scopeHash);
  queueMicrotask(()=>setFleetTab('devices'));
 },[fleetTabBlocked,scopeHash]);

 // The navigator of Automation and Settings: the pages of the area node. Devices (Add device included) shows the device tree.
 const navigatorArea=area==='automation'||area==='settings'?area:null,navigatorTitle=navigatorArea?t(areaNodeOf(navigatorArea)!.title!):'';
 const openPage=(id:string)=>{const node=navNode(id);if(node)go(node.route);};
 const navigatorContent=area==='devices'?{
   title:t('rail.devices'),
   actions:canCreateGroup?<IconBtn icon={FolderPlus} label={t('console.createGroup')} onClick={()=>inventoryAction('create-group',{type:'global',name:t('nav.allDevices')})}/>:undefined,
   body:<>
    <label className="sdx-searchfield sdx-tree-filter">
     <Search size={14} aria-hidden/>
     <input type="search" aria-label={t('console.treeFilter')} placeholder={t('console.filter')} value={treeFilter} onChange={event=>setTreeFilter(event.target.value)}/>
     {treeFilter&&<button type="button" aria-label={t('console.clearFilter')} onClick={()=>setTreeFilter('')}><X size={13}/></button>}
    </label>
    <InventoryTree servers={servers} permissionDevices={permissionDevices} deviceGroups={deviceGroups} customers={demo?undefined:data?.customers}
     selectedServerId={view==='device'?selected:undefined} selectedGroupId={view==='devices'&&!currentCustomer?groupFilter:undefined}
     selectedCustomerId={currentCustomer?.id} selectedUngrouped={view==='devices'&&groupFilter==='unassigned'} filter={treeFilter}
     onAll={openAll} onGroup={openFleet} onDevice={openServer} onCustomer={openCustomer}
     onUngrouped={openUngrouped} onAction={demo?undefined:inventoryAction}
     canManageGroups={canManageDeviceGroups(user)} canCreateRootGroup={hasRootGroupRight(user)} canManagePermissions={canManageRoleAssignments(user)}
     canProvision={isAdmin} canManageCustomers={canManageCustomers(user)}
     onMoveDevices={!demo&&canManageDeviceGroups(user)?moveFromTree:undefined} canMoveToRoot={hasRootGroupRight(user)}
     pinnedIds={pinnedIds} customerLogos={demo?undefined:data?.branding?.customers}/>
   </>,
  }
  :navigatorArea?{title:navigatorTitle,body:navigatorArea==='settings'
   ?<NavGroups label={navigatorTitle} groups={settingsGroups(navContext).map(({group,pages})=>({label:t(group),items:pages.map(navEntry)}))} value={page?.id??''} onSelect={openPage}/>
   :<NavList label={navigatorTitle} items={navigatorPages(navigatorArea,navContext).map(navEntry)} value={page?.id??''} onSelect={openPage}/>}
  :null;

 const header=(title:string,subtitle?:string,crumbs?:Crumb[],primary?:ReactNode)=><PageHeader title={title} subtitle={subtitle} crumbs={crumbs} primary={primary}/>;
 // The page header of a page node: its label and its subtitle or hint (or the given subtitle). Crumbs only where a hierarchy
 // can be climbed (Add device); a navigator page (Automation, Settings) has the crumb button instead, which opens the
 // navigator overlay at 900px or narrower.
 const pageHeader=(node:NavNode,crumbs?:Crumb[],primary?:ReactNode,subtitle?:MessageKey)=>{
  const areaCrumb=areaCrumbOf(node),text=subtitle??node.subtitle??node.hint;
  return <PageHeader title={t(node.label)} subtitle={text&&t(text)} crumbs={crumbs} primary={primary}
   areaCrumb={areaCrumb?{label:t(areaCrumb),expanded:drawerOpen,onSelect:()=>setDrawerOpen(open=>!open)}:undefined}/>;
 };
 const agentTab=settingsAllowed?page?.agentTab:undefined;
 // The frame of every Settings page, every Automation page and My account (ui/shell/page-frame.ts): the page renders the header
 // of its node once with its one primary, loads again on a console refresh and reads its tab from the link. My account
 // names an Entra sign-in in its subtitle. Opening a tab writes the hash once (the default tab without a segment) and
 // clears the runbook run focus.
 const accountSubtitle:MessageKey=user.identitySource==='entra'?'nav.account.subtitleEntra':'nav.account.subtitle';
 const openTab=(next:string)=>{const tabs=pageTabsOf(route);setRunbookFocus(null);setFrameTab(tabs.includes(next)&&next!==tabs[0]?next:'');};
 const pageFrame:PageFrame|undefined=(view==='settings'||view==='automation'||view==='account')&&page?{
  header:primary=>pageHeader(page,undefined,primary,view==='account'?accountSubtitle:undefined),
  refresh:frameRefresh,tab:pageTabOf(route),onTab:openTab,
 }:undefined;
 // The help topic: the model node of the route the console shows (a tab without its content shows Devices, an Extensions link without a detection the Overview).
 const shownRoute:ConsoleRoute=view==='devices'?{...route,tab:shownScopeTab(fleetTab,{permissions:!!fleetPermissions,settings:!!fleetSettings,alerts:!!fleetAlerts,notifications:!!fleetNotifications,tags:!!fleetTags})}
  :view==='device'&&active?{...route,...(configurationFallback?{deviceSection:'monitoring',deviceDetail:'alert-rules'}:{deviceSection:shownDeviceSection(active,deviceSection)})}:route;
 // The top bar logo (ui/shell/brand-logo-model.ts): the customer of the shown scope, group or device, then the single
 // customer of the viewer, then the portal logo. Sample devices show only the portal logo.
 const contextCustomerId=view==='devices'?currentCustomer?.id??(groupFilter!=='all'&&groupFilter!=='unassigned'?currentGroup?.customerId:undefined):view==='device'?active?.customerId:undefined;
 const logo=useMemo(()=>topbarLogo({branding:data?.branding,multipleCustomers:!demo&&data?.multipleCustomers===true,contextCustomerId:demo?null:contextCustomerId,visibleCustomerIds:demo?[]:(customers??[]).map(customer=>customer.id),defaultCustomerId}),[data?.branding,data?.multipleCustomers,demo,contextCustomerId,customers]);
 // The freshness of the data; in demo mode the top bar shows the demo pill in its place.
 const status=demo?'':checkedAt?t('shell.freshness.updated',{time:formatClock(locale,checkedAt)}):loading?t('shell.freshness.loading'):'';

 return <div className="sd-console sdx" data-navigator={navigatorContent&&!collapsed?'open':'closed'} data-area={area} data-backdrop={backdrop?'':undefined} style={backdropStyle}>
  {/* Toasts sit above the dock bar, and at 900px or narrower above the bottom bar (62px and the safe area). */}
  <Toaster richColors position="bottom-right" offset={{bottom:overlay?'calc(70px + env(safe-area-inset-bottom))':64,right:16}}
   mobileOffset={{bottom:'calc(70px + env(safe-area-inset-bottom))',left:16,right:16}}/>
  {canManageInstanceSettings(user)&&<UsageConsentDialog key={user.id} viewer={user}/>}
  <PaletteHost overlays={overlays} getItems={getPaletteItems}/>
  <a href="#console-content" className="sdx-skip" onClick={event=>{event.preventDefault();document.getElementById('console-content')?.focus();}}>{t('console.skip')}</a>
  <Topbar viewer={user} saving={saving} overlay={overlay} logo={logo}
   navigatorOpen={overlay?drawerOpen:!!navigatorContent&&!collapsed} canToggleNavigator={!!navigatorContent} onToggleNavigator={toggleNavigator}
   onSearch={openPalette} demo={demo} onEndDemo={()=>startDemo(false)} onRefresh={()=>reload()} loading={loading} status={status}
   onHelp={()=>toggleHelp(true)} onAccount={()=>go({view:'account'})}
   onSignOut={()=>void signOutPortal().catch(failure=>toast.error(failure instanceof Error?failure.message:t('console.signOutFailed')))}/>
  <div className="sdx-body">
   <ConsoleBackdrop background={backdrop}/>
   <Rail items={railItems} area={area} jobs={{count:jobBadge,open:jobsOpen&&overlay,onSelect:toggleJobs}} jobsRef={jobsItem}/>
   {navigatorContent&&<Navigator title={navigatorContent.title} actions={'actions' in navigatorContent?navigatorContent.actions:undefined}
    open={drawerOpen} overlay={overlay} onClose={()=>setDrawerOpen(false)}>{navigatorContent.body}</Navigator>}
   <div className="sdx-workspace">
    <main id="console-content" className="sdx-main" tabIndex={-1}>
     {error&&<Notice tone="danger" icon={AlertTriangle} action={<RetryAction onRetry={()=>void refresh()}/>}>{error}{data?' '+t('console.staleData'):''}</Notice>}
     {!demo&&<MaintenanceNotice status={data?.maintenance}/>}
     {!demo&&<PreviousSecretNotice removable={data?.previousSecretRemovable}/>}
     {!demo&&<EmergencyAlarmNotice alarms={data?.emergencyAlarms} onAcknowledged={()=>void refresh(true)}/>}
     {!data&&!demo&&!error&&view!=='account'?<Skeleton variant={view==='dashboard'?'cards':'table'} label={t('console.loadingDevices')} after={15000} action={<RetryAction onRetry={()=>void refresh()}/>}/>:<>
      {/* The Dashboard: its header is the page header of its node, with the page's own actions. */}
      {view==='dashboard'&&page&&<DashboardView
       header={(actions,primary)=><PageHeader title={t(page.label)} subtitle={page.hint&&t(page.hint)} actions={actions} primary={primary} compact={narrow}/>}
       servers={servers} jobs={jobs} viewer={user} demo={demo} saving={saving} narrow={narrow} owner={isAdmin}
       pinnedIds={pinnedIds} customers={demo?undefined:data?.customers} audit={demo?undefined:data?.audit} deviceAudit={demo?undefined:data?.deviceAudit}
       preference={dashboardPreference} onPreference={keepDashboardPreference} refreshKey={frameRefresh} customizeRequest={customizeDashboard}
       onNavigate={applyRoute} onAddDevice={()=>{if(isAdmin&&!demo)go({view:'add-device'});}} onSelectJob={selectJob} onCancelJob={cancelJob}/>}
      {view==='devices'&&<FleetView
       key={currentCustomer?'customer:'+currentCustomer.id+(customerUngrouped?':ungrouped':''):groupFilter}
       header={fleetHeader} servers={servers} scoped={scoped} pinnedIds={pinnedIds} onPin={togglePin}
       groupEmpty={!!currentGroup&&scoped.length===0} customerEmpty={!!currentCustomer&&!customerUngrouped&&scoped.length===0} ungroupedEmpty={scope.type==='unassigned'&&scoped.length===0}
       onShowAll={showScopeAbove}
       viewer={user} demo={demo} saving={saving} pluginReleases={demo?fixture?.pluginReleases:data?.pluginReleases} jobs={jobs} audit={data?.deviceAudit??noAudit} updatedAt={checkedAt}
       tab={fleetTab} onTab={setFleetTab} group={currentGroup}
       permissions={fleetPermissions} settings={fleetSettings} alerts={fleetAlerts} notifications={fleetNotifications} tags={fleetTags} monitoringSummary={fleetSummary}
       canMove={!demo&&canManageDeviceGroups(user)} onMove={setMoveIds} customerMove={customerMove}
       onRemoveFromGroup={currentGroup&&canManageCurrentGroup?removeFromCurrentGroup:undefined}
       onAssign={currentGroup&&canManageCurrentGroup?assignToCurrentGroup:undefined}
       canOffboard={canOffboard} onOpen={openServer} onConfirm={openConfirmation} removalContext={removalContext}
       onSelectJob={selectJob} onCancelJob={cancelJob} onUpdated={refreshNow}
       onProvision={isAdmin&&!demo?addDevice:undefined} onDemo={showDemo}
       customerColumn={!demo&&data?.multipleCustomers===true} scope={scope} onOpenEsuGroup={openEsuGroup} onOpenEsuCustomer={customerOpens(scope.type==='customer'?scope.id:currentGroup?.customerId)?openEsuCustomer:undefined}/>}
      {view==='device'&&(active?<DeviceView
       key={(demo?'demo:':'live:')+active.id} server={active} servers={servers} viewer={user} demo={demo} saving={saving}
       pluginReleases={demo?fixture?.pluginReleases:data?.pluginReleases}
       section={deviceSection} onSection={setDeviceSection} detail={deviceDetail} onDetail={setDeviceDetail}
       samples={demo?fixture?.samples??[]:history.samples} historyLoading={history.loading} jobs={jobs} audit={demo?[]:data?.deviceAudit??[]}
       crumbs={[rootCrumb,...customerCrumbs(active.customerId||groupCustomer(deviceGroupId(active))),...groupPath(deviceGroupId(active)),{label:active.name}]}
       onConfirm={openConfirmation} removalContext={removalContext} onShowOffboarding={canOffboard&&!demo?()=>setOffboardingIds([active.id]):undefined}
       onSelectJob={selectJob} onCancelJob={cancelJob} onStep={orderedServers.length>1?step:undefined}
       assistantOpen={assistantDevice===active.id} onAssistantOpen={open=>setAssistantDevice(open?active.id:'')}
       permissions={canManageRoleAssignments(user)?<div className="sdx-embedded">
        <ScopedPermissionEditor key={active.id} viewer={user} demo={demo} onRefresh={()=>refresh(true)} refreshKey={frameRefresh}
         scope={{type:'device',id:active.id}} scopeName={active.name} onOpenScope={target=>inventoryAction('permissions',target)}/>
       </div>:undefined}
       alerts={<div className="sdx-embedded">
        <AlertRulesPanel key={active.id} scope={{type:'device',id:active.id}} scopeName={active.name} customerView={customerOpens(active.customerId)} demo={demo} onRefresh={()=>refresh(true)} onOpenOrigin={openAlertOrigin}/>
       </div>}
       notifications={<div className="sdx-embedded">
        <NotificationRulesPanel key={active.id} scope={{type:'device',id:active.id}} scopeName={active.name} demo={demo} canManageChannels={canManageNotifications(user)}
         onOpenOrigin={openNotificationOrigin} onOpenSettings={openChannels} onOpenLog={openDeliveryLog} onHideDemo={()=>startDemo(false)} deviceEmpty={deviceRulesPlace(active)}/>
       </div>}
       onRefresh={()=>refresh(true)} onMove={!demo&&canManageDeviceGroups(user)?()=>setMoveIds([active.id]):undefined} customerMove={customerMove} onRename={()=>openRename(active.id)}
       pinned={!!pinnedIds?.includes(active.id)} onPin={()=>togglePin(active.id)}
       canOffboard={canOffboard} onOpenEsuGroup={openEsuGroup} onOpenEsuCustomer={customerOpens(active.customerId)?openEsuCustomer:undefined} onOpenTagOrigin={openTagOrigin}
       onOpenAssistantSettings={()=>go({view:'settings',page:'assistant'})} onOpenAccount={()=>go({view:'account'})}
       onAction={action} onOpenDeviceAssistant={id=>{openServer(id);setAssistantDevice(id);}}/>
       :<>
        {header(t('console.notFound.title'),undefined,[rootCrumb])}
        <Notice tone="warning" icon={AlertTriangle} action={<Btn size="sm" onClick={()=>openFleet('all')}>{t('console.notFound.back')}</Btn>}>{t('console.notFound.text')}</Notice>
       </>)}
      {view==='automation'&&page&&<AutomationWorkspace
       key={automationPage} page={automationPage} frame={pageFrame}
       servers={servers} viewer={user} demo={demo} runFocus={runbookFocus} onOpenDevice={openServer}/>}
      {view==='add-device'&&page&&<>
       {pageHeader(page,[rootCrumb,...customerCrumbs(addCustomerId),{label:t(page.label)}])}
       <AddDevicePage installer={addInstaller} routeCustomerId={addCustomerId} routeGroupId={agentGroupId}
        groups={groups} groupCustomers={enrollGroupCustomers} customers={data?.customers??[]} multipleCustomers={data?.multipleCustomers===true}
        servers={servers} demo={demo} owner={isAdmin} saving={saving} certificate={data?data.portalCertificate??null:undefined}
        onTab={(installer:boolean,choice:AddDeviceChoice)=>go({view:'add-device',installer,customerId:choice.customerId,groupId:choice.groupId})}
        onEnroll={(input,registered)=>void enroll(input,registered)} onRefresh={()=>void refresh(true)} onOpenDevice={id=>openServer(id)}/>
      </>}
      {agentTab==='agent-releases'&&page&&<AgentReleasesPage viewer={user} frame={pageFrame}/>}
      {agentTab==='extensions'&&page&&<ExtensionsPage
       servers={servers} viewer={user} demo={demo} onConfirm={openConfirmation} frame={pageFrame}/>}
      {agentTab==='agent-troubleshooting'&&page&&<AgentTroubleshootingPage
       servers={servers} onOpenDevice={openServer} frame={pageFrame}/>}
      {accessSection&&page&&<div className="sdx-embedded">
       <AccessWorkspace section={accessSection}
        viewer={user} servers={servers} entries={data?.audit??[]} auditLoading={loading&&!data} multipleCustomers={data?.multipleCustomers===true} demo={demo} onRefresh={refresh} onAssignRole={assignRole} frame={pageFrame}
        consoleBackgroundOn={consoleBackgroundOn}/>
      </div>}
      {view==='account'&&<AccountPanel
       key={user.id} viewer={user} frame={pageFrame}
       preferences={{brandScheme:data?.branding?.scheme!=null,consoleBackground:{available:!!data?.branding?.consoleBackground,checked:consoleBackgroundOn,onChange:changeConsoleBackground}}}
       serverSignIns={<ServerSignInsCard demo={demo}/>} assistantKey={<PersonalAssistantKey key={user.id} viewer={user}/>}/>}
     </>}
    </main>
   </div>
   <JobDock jobs={jobs} current={summaryJob} servers={servers} viewer={user} demo={demo} loaded={!!data} saving={saving}
    open={jobsOpen} onOpenChange={setJobsOpen} onSelect={selectJob} onCancel={cancelJob} onShowAll={showAllJobs}/>
  </div>
  {/* 900px or narrower: the Jobs sheet of the bottom bar in place of the dock (jobsOpen drives both forms). Choosing a job closes it. */}
  <JobSheet open={jobsOpen&&overlay} jobs={jobs} servers={servers} viewer={user} demo={demo} saving={saving}
   onClose={()=>setJobsOpen(false)} onSelect={item=>{setJobsOpen(false);selectJob(item);}} onCancel={cancelJob} onShowAll={showAllJobs} returnFocus={jobsItem}/>
  {/* After the body: Help (HelpHost) remembers its opener in a layout effect, which must run after the Navigator's (F1 on a
      tree item closes the overlay, and the Navigator first hands focus to the overlay's opener). */}
  <HelpHost overlays={overlays} route={shownRoute}/>

  <JobDetailDrawer job={job} open={!!job&&!confirmation&&!mfaOpen} servers={servers} viewer={user} demo={demo} saving={saving}
   refreshKey={frameRefresh} onClose={()=>setJobId('')} onCancel={cancelJob}
   onOpenDevice={id=>openServer(id)} onNavigate={hash=>{setJobId('');applyRoute(hash);}}/>
  <GroupCreateDrawer open={createParent!==undefined&&!demo} parent={createParent?deviceGroups?.find(group=>group.id===createParent)??null:null}
   customers={data?.customers} customerId={createParent===null&&createCustomer?createCustomer:undefined}
   groups={(deviceGroups??[]).filter(group=>hasRootGroupRight(user)||group.permissions.includes('groups.manage'))} busy={access.busy}
   onClose={()=>{setCreateParent(undefined);setCreateCustomer('');}}
   onCreate={input=>void access.run({action:'create-group',...input},t('console.groupCreated')).then(result=>{if(!result)return;setCreateParent(undefined);if(result.id)openFleet(result.id);})}/>
  <GroupDeleteDrawer group={canDeleteGroups?deviceGroups?.find(group=>group.id===deleteGroupId)??null:null} busy={access.busy} onClose={()=>setDeleteGroupId('')}
   onDelete={()=>{
    const id=deleteGroupId,current=context.current;if(current.demo||!hasRootGroupRight(current.user))return;
    // An empty group deletes without MFA; one with a device or an assignment asks first (stepUpOnDelete).
    const stepUpOnDelete=deviceGroups?.find(group=>group.id===id)?.stepUpOnDelete;
    void access.run({action:'delete-group',id,confirm:true},t('console.groupDeleted'),{stepUpOnDelete}).then(result=>{if(!result)return;setDeleteGroupId('');setGroupFilter(current=>current===id?'all':current);});
   }}/>
  {renameServer&&<DeviceNameDrawer key={rename?.count} open={!!rename?.open} server={renameServer} viewer={user} demo={demo}
   onClose={()=>setRename(previous=>previous&&{...previous,open:false})} onRefresh={()=>refresh(true)}/>}
  <MoveDevicesDrawer open={moveIds.length>0&&!demo} devices={servers.filter(server=>moveIds.includes(server.id))} groups={deviceGroups??[]} viewer={user} busy={access.busy}
   onClose={()=>setMoveIds([])} onMove={groupId=>void moveDevices(moveIds,groupId).then(done=>{if(done)setMoveIds([]);})}/>
  <CustomerMoveDrawer open={customerMoveIds.length>0&&!demo} devices={servers.filter(server=>customerMoveIds.includes(server.id))} customers={data?.customers??[]} groups={deviceGroups??[]} viewer={user}
   logos={data?.branding?.customers} onClose={()=>finishCustomerMove(false)} onMoved={()=>finishCustomerMove(true)}/>
  <AssignDevicesDrawer group={!demo?deviceGroups?.find(group=>group.id===assignGroupId)??null:null} servers={servers} busy={access.busy}
   onClose={()=>setAssignGroupId('')} onAssign={ids=>void moveDevices(ids,assignGroupId).then(done=>{if(done)setAssignGroupId('');})}/>
  {access.prompt}
  <CustomerDrawerHost request={customerDrawer} closeKey={routeHash} onSaved={()=>void refresh(true)} onDeleted={leaveDeletedCustomer} onDone={()=>setCustomerDrawer(null)}/>
  {offboardingIds.length>0&&<OffboardingDrawer key={offboardingIds.join(',')} ids={offboardingIds} open={!confirmation&&!mfaOpen}
   servers={servers} demo={demo} saving={saving} load={loadOffboarding} onAction={action} onRemoved={offboarded} onClose={()=>setOffboardingIds([])}/>}
  {/* Every Confirmation: the verb of the confirmation (required, the trigger's action), danger for removals, blocked in
      demo mode and for a removal without the Owner right. */}
  <ConfirmDialog open={!!confirmation&&!mfaOpen} onOpenChange={open=>{if(!open)setConfirmation(null);}}
   title={confirmed?.title} lines={confirmed?.lines} body={confirmed?.description}
   confirmLabel={confirmed?.confirmLabel??''} tone={confirmed?.tone??(removalPending?'danger':'default')} busy={saving}
   blocked={demo?t('kit.unavailable.demo'):removalPending&&!canOffboard?t('console.removal.ownerOnly'):undefined}
   onConfirm={()=>{if(confirmed)void action(confirmed.payload,confirmation?.onSettled,confirmationOptions(confirmation));setConfirmation(null);}}>
   {confirmation?.uninstall&&<UninstallSwitch choice={confirmation.uninstall} checked={uninstallOn} onChange={setUninstallOn}/>}
  </ConfirmDialog>
  <MfaStepUp open={mfaOpen} onClose={()=>{setMfaOpen(false);mfaRetry.current=null;}}
   onVerified={proof=>{const retry=mfaRetry.current;mfaRetry.current=null;void retry?.(proof);}}/>
  {!mfaOpen&&<PluginAdSignInHost servers={servers} demo={demo}/>}
 </div>;
}
