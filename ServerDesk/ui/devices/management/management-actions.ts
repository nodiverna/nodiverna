// The rules of the management actions (ui/devices/management/device-accounts.tsx: Accounts; ui/devices/management/roles-features.tsx:
// Roles & features; ui/devices/management/device-system.tsx: Computer & domain, Firewall rules and Scheduled tasks): why
// an action is blocked, the review lines of its confirmation, the device line of every confirmation
// of the management panels and the label of a management job (operationLabel, for the job dock).
// Pure, so the panels and the tests share one copy.
import type {ServerSnapshot} from '@/lib/types';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {EMPTY_VALUE} from '@/lib/i18n/format';

/** Actions that read the device; they need the diagnose right and no Management mode. */
export const MANAGEMENT_READ_ACTIONS=['scan-updates','test-connection','refresh'];
/** Actions that a domain controller refuses (identity and local accounts). */
export const DOMAIN_CONTROLLER_PROTECTED=['join-domain','leave-domain','rename-computer','create-local-user','set-local-user','reset-local-password','delete-local-user','local-group-add','local-group-remove'];

export type ManagementActionInput={
 demo:boolean;
 /** The manage right on this device. */
 canOperate:boolean;
 /** The diagnose right; without it, read actions fall back to canOperate. */
 canDiagnose?:boolean;
 offline:boolean;
 /** The agent capabilities of the last snapshot. */
 capabilities?:readonly string[]|null;
 /** Win32_ComputerSystem.DomainRole of the last snapshot; 4 and 5 are domain controllers. */
 domainRole?:number|null;
 /** Management mode: the snapshot's mode when reported, else the device flag. */
 management:boolean;
};

/**
 * The message key of the first reason that blocks the action, or null. The order is fixed: sample
 * device, right, connection, agent capability, domain-controller protection, Management mode.
 */
export function managementActionReasonKey(input:ManagementActionInput,kind:string):MessageKey|null{
 const read=MANAGEMENT_READ_ACTIONS.includes(kind);
 if(input.demo)return 'kit.unavailable.demo';
 if(!(read?input.canDiagnose??input.canOperate:input.canOperate))return read?'management.blocked.diagnose':'management.blocked.manage';
 if(input.offline)return 'management.blocked.offline';
 if(!input.capabilities?.includes(kind))return 'management.blocked.unsupported';
 if((input.domainRole??0)>=4&&DOMAIN_CONTROLLER_PROTECTED.includes(kind))return 'management.blocked.domainController';
 if(!input.management&&!read)return 'management.blocked.readOnly';
 return null;
}
/** The full-sentence reason that blocks the action, or '' when it is available. */
export function managementActionReason(input:ManagementActionInput,kind:string,locale:Locale=defaultLocale):string{
 const key=managementActionReasonKey(input,kind);
 return key?translate(locale,key):'';
}
/** Management mode as the management actions read it: the reported mode, else the device flag. */
export const managementMode=(server:{management?:number|boolean|null;snapshot?:{mode?:string}|null})=>server.snapshot?.mode?server.snapshot.mode==='Management':!!server.management;

/** The device of a confirmation as its first line ("Device: SRV-01"), never a line in the description. */
export const confirmationDevice=(name:string,locale:Locale=defaultLocale)=>[{label:translate(locale,'management.confirm.device'),value:name}];

const parameterLabels:Record<string,MessageKey>={name:'common.name',domain:'management.param.domain',workgroup:'management.param.workgroup',ouPath:'management.param.ouPath',username:'management.param.username',interfaceIndex:'management.param.interfaceIndex',dhcp:'management.param.dhcp',address:'management.param.address',prefixLength:'management.param.prefixLength',gateway:'management.param.gateway',automatic:'management.param.automatic',servers:'management.param.servers',drive:'management.param.drive',initialMb:'management.param.initialMb',maximumMb:'management.param.maximumMb',enabled:'management.param.enabled',fullName:'management.param.fullName',description:'common.description',passwordNeverExpires:'management.param.passwordNeverExpires',groupSid:'management.param.groupSid',delaySeconds:'management.param.delaySeconds',reason:'management.param.reason',direction:'management.param.direction',action:'management.param.action',protocol:'management.param.protocol',port:'management.param.port',remoteAddress:'management.param.remoteAddress',path:'management.param.path',includeManagementTools:'management.param.includeManagementTools',host:'management.param.host',updateIds:'management.param.updateIds'};
/** A parameter value as review text: lists joined, booleans as yes/no. */
export const reviewValue=(value:unknown,locale:Locale=defaultLocale)=>Array.isArray(value)?value.join(', '):typeof value==='boolean'?translate(locale,value?'management.yes':'management.no'):String(value??EMPTY_VALUE);
/** One "Label: value" line per filled parameter; passwords and secrets never show. */
export function reviewParameters(params:Record<string,unknown>,locale:Locale=defaultLocale){
 return Object.entries(params).filter(([key,value])=>!['password','secrets'].includes(key)&&value!==''&&value!=null).map(([key,value])=>translate(locale,'management.reviewLine',{label:Object.hasOwn(parameterLabels,key)?translate(locale,parameterLabels[key]):key,value:reviewValue(value,locale)})).join('\n');
}

/** The review text of a management action: what changes, from the current snapshot to the new parameters. */
export function managementReview(kind:string,params:Record<string,unknown>,snapshot:ServerSnapshot|null|undefined,locale:Locale=defaultLocale):string{
 const t=(key:MessageKey,values?:Record<string,string|number>)=>translate(locale,key,values);
 const change=(label:string,current:unknown,next:unknown)=>t('management.change',{label,current:reviewValue(current,locale)||EMPTY_VALUE,next:reviewValue(next,locale)||EMPTY_VALUE});
 const adapter=snapshot?.networkConfig?.find(item=>item.interfaceIndex===Number(params.interfaceIndex));
 const currentUser=snapshot?.localUsers?.find(item=>item.name===params.name);
 if(kind==='set-network')return [`Adapter: ${adapter?.alias??params.interfaceIndex}`,change('IPv4',adapter?(adapter.dhcp?'DHCP':t('management.static')):EMPTY_VALUE,params.dhcp?'DHCP':t('management.static')),...(params.dhcp?[]:[change(t('management.address'),adapter?.addresses.filter(ip=>!ip.address.includes(':')).map(ip=>`${ip.address}/${ip.prefixLength}`),`${params.address}/${params.prefixLength}`),change(t('management.gateway'),adapter?.gateway,params.gateway??t('management.noGateway'))])].join('\n');
 if(kind==='set-dns')return [`Adapter: ${adapter?.alias??params.interfaceIndex}`,change('DNS-Server',adapter?.dns,params.automatic?t('management.automatic'):params.servers)].join('\n');
 if(kind==='set-pagefile')return change(t('management.pagefileTitle'),snapshot?.pagefile?(snapshot.pagefile.automatic?t('management.automatic'):snapshot.pagefile.files.map(file=>`${file.name}: ${file.initialMb}–${file.maximumMb} MB`)):EMPTY_VALUE,params.automatic?t('management.automatic'):t('management.review.pagefile',{drive:String(params.drive),initialMb:String(params.initialMb),maximumMb:String(params.maximumMb)}));
 if(kind==='rename-computer')return change(t('management.computerName'),snapshot?.hostname,params.name)+(params.username?t('management.review.domainAccount',{username:String(params.username)}):'');
 if(kind==='join-domain'||kind==='leave-domain')return change(t('management.domainOrWorkgroup'),snapshot?.domain,params.domain??params.workgroup)+'\n'+reviewParameters(Object.fromEntries(Object.entries(params).filter(([key])=>!['domain','workgroup'].includes(key))),locale);
 if(kind==='set-local-user'&&currentUser)return [t('management.review.user',{name:currentUser.name}),change(t('management.param.enabled'),currentUser.enabled,params.enabled),change(t('management.param.fullName'),currentUser.fullName,params.fullName),change(t('common.description'),currentUser.description,params.description),change(t('management.param.passwordNeverExpires'),!currentUser.passwordExpires,params.passwordNeverExpires)].join('\n');
 if(kind==='set-firewall-rule'){const rule=snapshot?.firewallRules?.find(item=>item.name===params.name);return t('management.review.rule',{name:String(rule?.displayName??params.name)})+change(t('management.param.enabled'),rule?.enabled,params.enabled);}
 if(kind==='set-task'){const task=snapshot?.tasks?.find(item=>item.name===params.name&&item.path===params.path);return t('management.review.task',{path:String(params.path),name:String(params.name)})+change(t('management.param.enabled'),task?task.state!=='Disabled':undefined,params.enabled);}
 if(kind==='install-feature'||kind==='remove-feature'){const feature=snapshot?.features?.find(item=>item.name===params.name);return t('management.review.feature',{value:String(feature?.displayName??params.name)})+change(t('management.status'),feature?feature.installed?t('management.installed'):t('management.notInstalled'):undefined,kind==='install-feature'?t('management.installed'):t('management.removed'))+'\n'+reviewParameters(Object.fromEntries(Object.entries(params).filter(([key])=>key!=='name')),locale);}
 return reviewParameters(params,locale);
}

// The labels of the management jobs, as message keys (the job dock names a job by them).
const actionNames:Record<string,MessageKey>={'install-feature':'management.action.installFeature','remove-feature':'management.action.removeFeature','set-network':'management.action.setNetwork','set-dns':'management.action.setDns','join-domain':'management.action.joinDomain','leave-domain':'management.action.leaveDomain','rename-computer':'management.action.renameComputer','set-pagefile':'management.action.setPagefile','create-local-user':'management.action.createLocalUser','set-local-user':'management.action.setLocalUser','reset-local-password':'management.action.resetLocalPassword','delete-local-user':'management.action.deleteLocalUser','local-group-add':'management.action.localGroupAdd','local-group-remove':'management.action.localGroupRemove','restart-computer':'management.action.restartComputer','shutdown-computer':'management.action.shutdownComputer','scan-updates':'management.action.scanUpdates','install-updates':'management.action.installUpdates','install-gpu-driver':'operation.installGpuDriver','set-firewall-rule':'management.action.setFirewallRule','add-firewall-rule':'management.action.addFirewallRule','set-task':'management.action.setTask','test-connection':'management.action.testConnection'};
const otherNames:Record<string,MessageKey>={'refresh':'management.action.refresh','start-service':'management.action.startService','stop-service':'management.action.stopService','restart-service':'management.action.restartService','set-service-startup':'management.action.setServiceStartup'};
/** The label of a management job kind; an unknown kind reads as itself. */
export const operationLabel=(kind:string,locale:Locale=defaultLocale)=>Object.hasOwn(actionNames,kind)?translate(locale,actionNames[kind]):Object.hasOwn(otherNames,kind)?translate(locale,otherNames[kind]):kind;
