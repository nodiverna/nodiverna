// The support status of a device's operating system: the lifecycle catalog
// (lib/os-lifecycle.json, a data file with Microsoft dates), one mapper per
// operating system family from the snapshot to a catalog entry, the ESU date
// per customer, group or device and the resulting status. Pure: the console route, the
// demo data and the tests use the same functions. docs/device-health-signals.md
// describes the rules.
import * as catalogModule from './os-lifecycle.json';
import {osSupportDaysLeft,type AlertRuleSettingsMap} from './alert-rules';
import type {OsSupport,OsSupportChannel,Server,ServerSnapshot} from './types';

export type OsFamily='windows';
export type OsLifecycleEntry={id:string;family:OsFamily;product:string;version:string;build:{min:number;max:number};channel:OsSupportChannel;editions?:string[];start:string;generalEnd:string;securityEnd:string;source:string;checkedAt:string};
export type OsLifecycleCatalog={schemaVersion:1;asOf:string;entries:OsLifecycleEntry[]};
// The bundler and the test loaders differ in how a JSON module looks: a default export or the object itself.
const catalogFile:unknown='default' in catalogModule?(catalogModule as {default:unknown}).default:catalogModule;
export const osLifecycleCatalog=catalogFile as OsLifecycleCatalog;
/** The default warning step of the rule os-support-end: support ends in 180 days or less. */
export const defaultOsSupportWarningDays=180;

const buildOf=(snapshot:ServerSnapshot)=>{const value=Number.parseInt(snapshot.osInfo?.currentBuild??snapshot.build??'',10);return Number.isInteger(value)&&value>0?value:null;};
/** The Windows servicing channel of an edition and installation type, or null for an unknown edition. */
export function windowsChannel(editionId:string|null,installationType:string|null):OsSupportChannel|null{
 const edition=editionId??'',installation=(installationType??'').toLowerCase();
 if(installation==='server'||installation==='server core'||edition.startsWith('Server'))return 'server';
 if(['EnterpriseS','EnterpriseSN','IoTEnterpriseS'].includes(edition))return 'ltsc';
 if(edition.startsWith('Enterprise')||edition.startsWith('Education')||edition==='IoTEnterprise')return 'enterprise-education';
 if(edition.startsWith('Core')||edition.startsWith('Professional'))return 'home-pro';
 return null;
}
function windowsEntry(snapshot:ServerSnapshot,entries:readonly OsLifecycleEntry[]):OsLifecycleEntry|null{
 const info=snapshot.osInfo;if(!info)return null;
 const channel=windowsChannel(info.editionId,info.installationType),build=buildOf(snapshot);
 if(!channel||build===null)return null;
 // Client builds from 22000 are Windows 11; the build ranges of the catalog keep the products apart.
 const product=channel==='server'?'Windows Server':build>=22000?'Windows 11':'Windows 10';
 const candidates=entries.filter(entry=>entry.family==='windows'&&entry.channel===channel&&entry.product.startsWith(product)&&build>=entry.build.min&&build<=entry.build.max&&(!entry.editions||entry.editions.includes(info.editionId??'')));
 // An entry with a matching edition list (for example IoT LTSC) wins over one without.
 return candidates.find(entry=>entry.editions)??candidates[0]??null;
}
/** One mapper per family. Another family needs only a mapper here and its catalog entries. */
export const osSupportMappers:Record<OsFamily,(snapshot:ServerSnapshot,entries:readonly OsLifecycleEntry[])=>OsLifecycleEntry|null>={windows:windowsEntry};
/** The catalog entry of a snapshot, or null when no mapper finds one. */
export function osLifecycleEntry(snapshot:ServerSnapshot|null|undefined,catalog:OsLifecycleCatalog=osLifecycleCatalog):OsLifecycleEntry|null{
 if(!snapshot?.osInfo)return null;
 for(const mapper of Object.values(osSupportMappers)){const entry=mapper(snapshot,catalog.entries);if(entry)return entry;}
 return null;
}

/** A stored ESU date (a row of os_esu_overrides). */
export type EsuScopeType='customer'|'group'|'device';
export type EsuOverride={scopeType:EsuScopeType;scopeId:string;until:string;updatedAt:number};
export type ResolvedEsu={until:string;origin:{type:EsuScopeType;id:string;name:string}};
/**
 * The ESU date of a device: its own row, else the closest group along its group
 * path (innermost first, `groups` with the depth from the root), else the row
 * of its customer (when given); none → null. The customer origin has no name
 * here: the console shows the customer name of the device row.
 */
export function resolveEsu(deviceId:string,groups:readonly {id:string;name?:string;depth:number}[],rows:readonly EsuOverride[],customerId?:string|null):ResolvedEsu|null{
 const own=rows.find(row=>row.scopeType==='device'&&row.scopeId===deviceId);
 if(own)return {until:own.until,origin:{type:'device',id:deviceId,name:''}};
 const byGroup=new Map(rows.filter(row=>row.scopeType==='group').map(row=>[row.scopeId,row]));
 for(const group of [...groups].sort((a,b)=>b.depth-a.depth)){const row=byGroup.get(group.id);if(row)return {until:row.until,origin:{type:'group',id:group.id,name:group.name??''}};}
 const customer=customerId?rows.find(row=>row.scopeType==='customer'&&row.scopeId===customerId):undefined;
 if(customer)return {until:customer.until,origin:{type:'customer',id:customer.scopeId,name:''}};
 return null;
}
/** The later of the catalog's security end and the ESU date. */
export const effectiveSupportEnd=(securityEnd:string,esu:string|null|undefined)=>esu&&esu>securityEnd?esu:securityEnd;

/**
 * The status of one device at `now`: supported (more than warningDays left),
 * ending (1 … warningDays left), ended (on or after the effective end) or
 * unknown (no-entry: osInfo without a catalog match; not-reported: no osInfo).
 */
export function osSupportStatus(snapshot:ServerSnapshot|null|undefined,entry:OsLifecycleEntry|null,esu:ResolvedEsu|null,now:number,warningDays:number=defaultOsSupportWarningDays):OsSupport{
 const withEsu=esu?{esu}:{};
 if(!snapshot?.osInfo)return {status:'unknown',reason:'not-reported',...withEsu};
 if(!entry)return {status:'unknown',reason:'no-entry',...withEsu};
 const effectiveEnd=effectiveSupportEnd(entry.securityEnd,esu?.until),daysLeft=osSupportDaysLeft(effectiveEnd,now);
 const status=daysLeft===0?'ended':daysLeft<=warningDays?'ending':'supported';
 return {status,entry:{id:entry.id,product:entry.product,version:entry.version,channel:entry.channel,generalEnd:entry.generalEnd,securityEnd:entry.securityEnd,source:entry.source},effectiveEnd,daysLeft,...withEsu};
}
/** The warning step of the device's effective os-support-end rule, 180 when the rule is off or has no warning step. */
export function osSupportWarningDays(settings:AlertRuleSettingsMap|null|undefined):number{
 const rule=settings?.['os-support-end'];
 return rule?.enabled&&rule.warning!==null?rule.warning:defaultOsSupportWarningDays;
}
/**
 * The console's osSupport of one device: catalog entry, ESU from the rows (its
 * own, its groups', its customer's) and the warning step of its rules. A
 * customer origin carries the device's customerName ('' while it has none).
 */
export function deviceOsSupport(server:Pick<Server,'id'|'snapshot'|'groups'|'customerId'|'customerName'>,rows:readonly EsuOverride[],settings:AlertRuleSettingsMap|null,now:number):OsSupport{
 const esu=resolveEsu(server.id,server.groups??[],rows,server.customerId);
 const named=esu?.origin.type==='customer'?{...esu,origin:{...esu.origin,name:server.customerName??''}}:esu;
 return osSupportStatus(server.snapshot,osLifecycleEntry(server.snapshot),named,now,osSupportWarningDays(settings));
}
