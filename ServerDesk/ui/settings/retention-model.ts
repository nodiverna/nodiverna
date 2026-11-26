import type {MaintenanceArea,MaintenanceResult,MaintenanceRun,MaintenanceSource,MaintenanceView,EnvironmentRetention,RetainedTable} from '@/lib/server/maintenance';
import {EMPTY_VALUE,formatBytes,formatNumber,formatPercent} from '@/lib/i18n/format';
import type {Locale} from '@/lib/i18n/locale';
import type {MessageKey} from '@/lib/i18n/translate';
import {maintenanceSetNeedsStepUp} from '@/lib/step-up';

// The pure rules of the page Settings → Data retention (ui/settings/maintenance-panel.tsx): one row per area
// that the maintenance cleans, with its retention, where that retention is set, its size and the result of the
// newest finished run, and the numbers of the KPI row. Sizes and entries are estimates from the database
// statistics (lib/server/maintenance-storage.ts).

type Tr=(key:MessageKey,params?:Record<string,string|number>)=>string;

export type RetentionAreaId='audit'|'customerAudit'|'jobs'|'jobOutputs'|'assistantScripts'|'softwareChanges'|'alerts'|'notifications'|'integrityEvents'|'transfers';
/**
 * Where an area's retention is set: a catalog text with the placeholders {variable} (an environment variable,
 * shown in .mono) and {customers} (the link to Settings → Customers), and the variable it names.
 */
export type RetentionSetBy={key:MessageKey;variable?:string};
export type RetentionAreaRow={
 id:RetentionAreaId;label:string;
 /** "30 days", "7–400 days", "Until they expire", or EMPTY_VALUE for an invalid value. */
 keptFor:string;
 setBy:RetentionSetBy;
 /** setBy as plain text (screen reader and tests); the view renders the parts. */
 setByText:string;
 /** null: no own size (rows in another table) or the statistics could not be read. */
 bytes:number|null;size:string;
 /** The share of the database in percent, with its label; null without a size. */
 share:number|null;shareLabel:string|null;
 entries:string;
 /** What the newest finished run deleted or cleared here; EMPTY_VALUE without a value. */
 lastRun:string;
};

/** The environment variables of the retention settings (runtime/maintenance.mjs). */
export const retentionVariables={auditDays:'AUDIT_RETENTION_DAYS',jobDays:'JOB_RETENTION_DAYS',softwareDays:'SOFTWARE_CHANGE_RETENTION_DAYS',alertDays:'ALERT_RETENTION_DAYS'} as const;

/** The newest run that is not running any more (history is newest first); null without one. */
export function newestFinishedRun(history:readonly MaintenanceRun[]):MaintenanceRun|null{
 return history.find(run=>run.status!=='running')??null;
}

const count=(value:number|undefined,locale:Locale)=>formatNumber(locale,Number(value??0));
/** "{count} deleted" or "{count} deleted, more follow in the next run". */
export function deletedText(area:MaintenanceArea,t:Tr,locale:Locale):string{
 return t(area.more?'maintenancePage.result.deletedMore':'maintenancePage.result.deleted',{count:count(area.deleted,locale)});
}
/** "{count} cleared" or "{count} cleared, {failed} could not be cleared". */
export function clearedText(area:{cleared:number;failed?:number},t:Tr,locale:Locale):string{
 return area.failed?t('maintenancePage.result.clearedFailed',{count:count(area.cleared,locale),failed:count(area.failed,locale)}):t('maintenancePage.result.cleared',{count:count(area.cleared,locale)});
}
/** The customer passes of a run as one area: the sum of their deletions, "more" when any pass has more. */
function customerPasses(result:MaintenanceResult):MaintenanceArea|null{
 const passes=result.customerAudit;
 if(!Array.isArray(passes))return null;
 return {deleted:passes.reduce((sum,pass)=>sum+Number(pass.deleted??0),0),more:passes.some(pass=>pass.more)};
}

/**
 * The rows deleted by a run: audit (and every customer pass), jobs, job output, software changes, closed alarms,
 * notifications and agent service events, plus the cleared transfers. Cleared assistant scripts change a job, they
 * delete no row. null without a result.
 */
export function deletedRows(result:MaintenanceResult|null|undefined):number|null{
 if(!result)return null;
 const areas=[result.audit,customerPasses(result),result.jobs,result.jobOutputs,result.softwareChanges,result.alerts,result.notifications,result.integrityEvents];
 return areas.reduce((sum,area)=>sum+Number(area?.deleted??0),0)+Number(result.transfers?.cleared??0);
}

export type StorageKpis={
 databaseBytes:number|null;
 /** The sum of the area sizes below (every retained table); null when no table size is known. */
 areaBytes:number|null;
 transferObjectBytes:number|null;
 /** The newest finished run: the deleted rows, its end and whether it failed; null without such a run or result. */
 lastRun:{deleted:number;finishedAt:number;failed:boolean}|null;
};
/** The numbers of the KPI row. */
export function storageKpis(view:MaintenanceView):StorageKpis{
 const tables=Object.values(view.storage.tables).map(table=>table.bytes).filter((bytes):bytes is number=>bytes!==null);
 const run=newestFinishedRun(view.history),deleted=deletedRows(run?.result);
 return {
  databaseBytes:view.storage.databaseBytes,
  areaBytes:tables.length?tables.reduce((sum,bytes)=>sum+bytes,0):null,
  transferObjectBytes:view.storage.transferObjectBytes,
  lastRun:run&&deleted!==null&&run.finishedAt!==null?{deleted,finishedAt:run.finishedAt,failed:run.status==='failed'}:null,
 };
}

const daysText=(days:number|null,t:Tr)=>days===null?EMPTY_VALUE:t('maintenancePage.kept.days',{count:days});
/** Set by of a value the page changes (audit, jobs): this page, a start value, the default, or an invalid start value. */
function editableSetBy(source:MaintenanceSource,invalid:boolean,variable:string):RetentionSetBy{
 if(invalid)return {key:'maintenancePage.setBy.invalid',variable};
 if(source==='stored')return {key:'maintenancePage.setBy.page'};
 if(source==='env')return {key:'maintenancePage.setBy.startValue',variable};
 return {key:'maintenancePage.setBy.defaultHere'};
}
/** Set by of a value only the environment sets (software changes, alarms): the variable, the default, or an invalid value. */
function environmentSetBy(retention:EnvironmentRetention,variable:string):RetentionSetBy{
 if(retention.envInvalid)return {key:'maintenancePage.setBy.invalid',variable};
 return retention.source==='env'?{key:'maintenancePage.setBy.env',variable}:{key:'maintenancePage.setBy.defaultEnv',variable};
}

/** The rows of the card "Retention by area", in their fixed order; the customer row only when a customer keeps its own retention. */
export function retentionRows(view:MaintenanceView,t:Tr,locale:Locale):RetentionAreaRow[]{
 const {settings,envInvalid,storage,areaRetention,customerRetention}=view;
 const result=newestFinishedRun(view.history)?.result??null;
 const table=(name:RetainedTable)=>storage.tables[name]??{bytes:null,rows:null};
 const sum=(...values:(number|null)[])=>values.some(value=>value===null)?null:values.reduce<number>((total,value)=>total+(value??0),0);
 const area=(value:MaintenanceArea|null|undefined)=>value?deletedText(value,t,locale):EMPTY_VALUE;
 const fixed:RetentionSetBy={key:'maintenancePage.setBy.fixed'};
 const rows:{id:RetentionAreaId;label:MessageKey;keptFor:string;setBy:RetentionSetBy;bytes:number|null;rows:number|null;lastRun:string}[]=[];
 rows.push({id:'audit',label:'maintenancePage.area.audit',keptFor:daysText(settings.auditDays,t),setBy:editableSetBy(settings.source.auditDays,envInvalid.auditDays,retentionVariables.auditDays),bytes:table('audit').bytes,rows:table('audit').rows,lastRun:area(result?.audit)});
 if(customerRetention.count>0){
  const {minDays,maxDays}=customerRetention;
  const keptFor=minDays===null||maxDays===null?EMPTY_VALUE:minDays===maxDays?daysText(minDays,t):t('maintenancePage.kept.range',{min:minDays,max:maxDays});
  rows.push({id:'customerAudit',label:'maintenancePage.area.customerAuditAll',keptFor,setBy:{key:'maintenancePage.setBy.customers'},bytes:null,rows:null,lastRun:area(result?customerPasses(result):null)});
 }
 const jobs=editableSetBy(settings.source.jobDays,envInvalid.jobDays,retentionVariables.jobDays);
 rows.push({id:'jobs',label:'maintenancePage.area.jobs',keptFor:daysText(settings.jobDays,t),setBy:jobs,bytes:table('jobs').bytes,rows:table('jobs').rows,lastRun:area(result?.jobs)});
 rows.push({id:'jobOutputs',label:'maintenancePage.area.jobOutputs',keptFor:daysText(settings.jobDays,t),setBy:jobs,bytes:table('job_outputs').bytes,rows:table('job_outputs').rows,lastRun:area(result?.jobOutputs)});
 rows.push({id:'assistantScripts',label:'maintenancePage.area.assistantScripts',keptFor:daysText(areaRetention.assistantScriptDays,t),setBy:fixed,bytes:null,rows:null,lastRun:result?.assistantScripts?clearedText(result.assistantScripts,t,locale):EMPTY_VALUE});
 rows.push({id:'softwareChanges',label:'maintenancePage.area.softwareChanges',keptFor:daysText(areaRetention.softwareDays.days,t),setBy:environmentSetBy(areaRetention.softwareDays,retentionVariables.softwareDays),bytes:table('device_software_changes').bytes,rows:table('device_software_changes').rows,lastRun:area(result?.softwareChanges)});
 const alerts=environmentSetBy(areaRetention.alertDays,retentionVariables.alertDays),alertDays=daysText(areaRetention.alertDays.days,t);
 rows.push({id:'alerts',label:'maintenancePage.area.alerts',keptFor:alertDays,setBy:alerts,bytes:table('alerts').bytes,rows:table('alerts').rows,lastRun:area(result?.alerts)});
 rows.push({id:'notifications',label:'maintenancePage.area.notifications',keptFor:alertDays,setBy:alerts,bytes:sum(table('notification_events').bytes,table('notification_deliveries').bytes),rows:table('notification_events').rows,lastRun:area(result?.notifications)});
 rows.push({id:'integrityEvents',label:'maintenancePage.area.integrityEvents',keptFor:daysText(areaRetention.integrityDays,t),setBy:fixed,bytes:table('agent_integrity_events').bytes,rows:table('agent_integrity_events').rows,lastRun:area(result?.integrityEvents)});
 rows.push({id:'transfers',label:'maintenancePage.area.transfers',keptFor:t('maintenancePage.kept.untilExpired'),setBy:fixed,bytes:sum(table('transfers').bytes,table('transfer_chunks').bytes),rows:table('transfers').rows,lastRun:result?.transfers?clearedText(result.transfers,t,locale):EMPTY_VALUE});
 const database=storage.databaseBytes;
 return rows.map(row=>{
  const share=row.bytes!==null&&database!==null&&database>0?Math.min(100,row.bytes/database*100):null;
  return {
   id:row.id,label:t(row.label),keptFor:row.keptFor,setBy:row.setBy,
   setByText:t(row.setBy.key,{...(row.setBy.variable?{variable:row.setBy.variable}:{}),customers:t('nav.settings.customers')}),
   bytes:row.bytes,size:formatBytes(locale,row.bytes),
   share,shareLabel:share===null?null:t('maintenancePage.sizeShare',{share:formatPercent(locale,share)}),
   entries:row.rows===null?EMPTY_VALUE:formatNumber(locale,row.rows),
   lastRun:row.lastRun,
  };
 });
}

/**
 * Whether a maintenance save opens the MFA dialog before it is sent: the shared
 * rule (maintenanceSetNeedsStepUp) on the loaded retention and the payload's days.
 * Without loaded settings the save goes out at once and a 403 opens the dialog.
 */
export function maintenanceSaveNeedsStepUp(settings:Pick<MaintenanceView['settings'],'auditDays'|'jobDays'>|undefined,payload:Record<string,unknown>):boolean{
 if(!settings||payload.action!=='set')return false;
 const days=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:null;
 return maintenanceSetNeedsStepUp(settings,{auditDays:days(payload.auditDays),jobDays:days(payload.jobDays)});
}
