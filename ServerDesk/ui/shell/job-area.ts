// "Open {area}" of the job drawer (ui/shell/job-detail.tsx): the device area or subarea a job belongs to, as a
// link and the label of that area. Pure: the links come from consoleRouteHash (the assistant link from deviceAssistantHash), the labels from the area and subarea
// lists of console-route.ts, so a renamed area renames the button.
import type {MessageKey} from '@/lib/i18n/translate';
import {PLUGIN_INSTALL,PLUGIN_JOB,PLUGIN_REMOVE,isPluginOperation,pluginOperations} from '@/lib/plugin-catalog';
import {assistantPowerShellKind} from '@/lib/assistant-config';
import {fileDefinitions} from '@/lib/file-operations';
import {storageOperations} from '@/lib/storage-operations';
import {consoleRouteHash,deviceAssistantHash,deviceSectionLabels,diagnosticsDetailLabels,hardwareDetailLabels,managementDetailLabels,extensionsDetailLabels,type ConsoleRoute,type DiagnosticsDetail,type ManagementDetail} from '@/lib/console-route';

/**
 * Where a job leads: area (Open {area} with the area's label), assistant (Open assistant, #device/<id>/assistant) or
 * device (the device Overview, labelled fleet.openDevice with the device name).
 */
export type JobArea={kind:'area';hash:string;route:ConsoleRoute;areaKey:MessageKey}|{kind:'assistant';hash:string;route:ConsoleRoute}|{kind:'device';hash:string;route:ConsoleRoute};

const management:Readonly<Record<string,ManagementDetail>>={
 'start-service':'services','stop-service':'services','restart-service':'services','set-service-startup':'services',
 'scan-updates':'updates','install-updates':'updates',
 'set-network':'network','set-dns':'network','set-firewall-rule':'network','add-firewall-rule':'network',
 'create-local-user':'accounts','set-local-user':'accounts','reset-local-password':'accounts','delete-local-user':'accounts','local-group-add':'accounts','local-group-remove':'accounts',
 'install-feature':'features','remove-feature':'features',
 'set-task':'tasks',
 'defender-quick-scan':'defender','defender-full-scan':'defender','defender-update-signatures':'defender','defender-clean-detections':'defender',
 'restart-computer':'system','shutdown-computer':'system','rename-computer':'system','schedule-power':'system','cancel-power-schedule':'system',
 'join-domain':'system','leave-domain':'system','set-rdp':'system','set-pagefile':'system',
 ...Object.fromEntries(Object.keys(storageOperations).map(kind=>[kind,'storage' as const])),
};
const diagnostics:Readonly<Record<string,DiagnosticsDetail>>={
 'list-processes':'processes','kill-process':'processes',
 'list-sessions':'sessions','message-session':'sessions','disconnect-session':'sessions','logoff-session':'sessions',
 'query-events':'events','export-events':'events',
 'list-connections':'connections','network-diagnostics':'connections',
};

/** The area of a job on its device: the route, its hash and the label of the area or subarea. */
export function jobAreaRoute(job:{serverId:string;action:string;target?:string|null}):JobArea{
 const deviceId=job.serverId,kind=job.action,area=(route:Omit<ConsoleRoute,'view'|'deviceId'>,areaKey:MessageKey):JobArea=>{const full:ConsoleRoute={view:'device',deviceId,...route};return {kind:'area',hash:consoleRouteHash(full),route:full,areaKey};};
 if(Object.hasOwn(management,kind)){const detail=management[kind];return area({deviceSection:'management',deviceDetail:detail},managementDetailLabels[detail]);}
 if(Object.hasOwn(diagnostics,kind)){const detail=diagnostics[kind];return area({deviceSection:'diagnostics',deviceDetail:detail},diagnosticsDetailLabels[detail]);}
 if(Object.hasOwn(fileDefinitions,kind))return area({deviceSection:'files'},deviceSectionLabels.files);
 if(kind==='install-gpu-driver')return area({deviceSection:'hardware',deviceDetail:'gpu'},hardwareDetailLabels.gpu);
 if(kind==='desired-state-test'||kind==='desired-state-apply')return area({deviceSection:'desired'},deviceSectionLabels.desired);
 if(kind===PLUGIN_JOB&&isPluginOperation(job.target)){const plugin=pluginOperations[job.target].plugin;if(plugin==='dhcp'||plugin==='dns')return area({deviceSection:'extensions',deviceDetail:plugin},extensionsDetailLabels[plugin]);}
 if(kind===PLUGIN_INSTALL||kind===PLUGIN_REMOVE)return area({deviceSection:'extensions'},deviceSectionLabels.extensions);
 if(kind===assistantPowerShellKind)return {kind:'assistant',hash:deviceAssistantHash(deviceId),route:{view:'device',deviceId,deviceSection:'overview',assistant:true}};
 const route:ConsoleRoute={view:'device',deviceId};
 return {kind:'device',hash:consoleRouteHash(route),route};
}
