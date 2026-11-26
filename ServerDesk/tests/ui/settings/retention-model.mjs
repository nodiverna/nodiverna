// The pure rules of the page Settings → Data retention (ui/settings/retention-model.ts): the order and presence
// of the area rows, the "Kept for" and "Set by" texts for every source, sizes with their share of the database and
// the estimated entries (missing values as "—" without a meter), the last run from the newest finished run, and the
// numbers of the KPI row.
import assert from 'node:assert/strict';
import '../../support/register.mjs';

const {retentionRows,storageKpis,newestFinishedRun,deletedRows}=await import('../../../ui/settings/retention-model.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {EMPTY_VALUE,formatBytes}=await import('../../../lib/i18n/format.ts');

let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const en=(key,params)=>translate('en',key,params),de=(key,params)=>translate('de',key,params);
const MiB=1024*1024;
const tables=(overrides={})=>({audit:{bytes:40*MiB,rows:120_000},jobs:{bytes:8*MiB,rows:900},job_outputs:{bytes:24*MiB,rows:850},device_software_changes:{bytes:2*MiB,rows:3000},alerts:{bytes:MiB,rows:400},
 notification_events:{bytes:MiB,rows:250},notification_deliveries:{bytes:MiB,rows:500},agent_integrity_events:{bytes:MiB/2,rows:60},transfers:{bytes:MiB/4,rows:12},transfer_chunks:{bytes:MiB/4,rows:40},...overrides});
const result=(extra={})=>({retention:{auditDays:30,jobDays:30},audit:{deleted:12,more:false},customerAudit:[{customerId:'c-1',auditDays:7,deleted:3,more:true},{customerId:'c-2',auditDays:400,deleted:2,more:false}],
 jobs:{deleted:4,more:false},jobOutputs:{deleted:2,more:false},assistantScripts:{cleared:9,more:false},softwareChanges:{deleted:6,more:false},alerts:{deleted:1,more:false},notifications:{deleted:5,more:false},
 integrityEvents:{deleted:7,more:false},transfers:{cleared:5,failed:1,more:false},usageReport:{status:'sent'},...extra});
const run=(id,extra={})=>({id,startedAt:1000+id,finishedAt:2000+id,status:'succeeded',trigger:'schedule',requestedBy:null,error:null,result:result(),...extra});
const viewOf=(overrides={})=>({
 settings:{auditDays:30,jobDays:60,runAt:'03:00',timeZone:'UTC',revision:1,source:{auditDays:'stored',jobDays:'stored'},...overrides.settings},
 envInvalid:{auditDays:false,jobDays:false,...overrides.envInvalid},
 status:{lastRun:null,lastSuccessAt:null,running:false,nextRunAt:null,stale:false},
 history:overrides.history??[run(1)],
 storage:{databaseBytes:200*MiB,tables:tables(),transferObjectBytes:3*MiB,...overrides.storage},
 areaRetention:{softwareDays:{days:365,source:'default',envInvalid:false},alertDays:{days:90,source:'default',envInvalid:false},assistantScriptDays:7,integrityDays:90,...overrides.areaRetention},
 customerRetention:{count:0,minDays:null,maxDays:null,...overrides.customerRetention},
});
const rowsOf=(view,t=en,locale='en')=>retentionRows(view,t,locale);
const byId=rows=>Object.fromEntries(rows.map(row=>[row.id,row]));

// ---- Order and presence ------------------------------------------------------------
{
 check(rowsOf(viewOf()).map(row=>row.id),['audit','jobs','jobOutputs','assistantScripts','softwareChanges','alerts','notifications','integrityEvents','transfers'],'nine rows without customers of their own retention');
 check(rowsOf(viewOf({customerRetention:{count:2,minDays:7,maxDays:400}})).map(row=>row.id),['audit','customerAudit','jobs','jobOutputs','assistantScripts','softwareChanges','alerts','notifications','integrityEvents','transfers'],'the customer row after audit when a customer keeps its own retention');
 check(rowsOf(viewOf({customerRetention:{count:2,minDays:7,maxDays:400}})).map(row=>row.label),['Audit entries','Customer audit entries','Jobs','Job output','Assistant scripts','Software changes','Closed alarms','Notifications','Agent service events','File transfers'],'the area labels');
}

// ---- Kept for ---------------------------------------------------------------------------
{
 const rows=byId(rowsOf(viewOf({settings:{auditDays:1},customerRetention:{count:2,minDays:7,maxDays:400}})));
 check([rows.audit.keptFor,rows.customerAudit.keptFor,rows.jobs.keptFor,rows.jobOutputs.keptFor,rows.assistantScripts.keptFor,rows.softwareChanges.keptFor,rows.alerts.keptFor,rows.notifications.keptFor,rows.integrityEvents.keptFor,rows.transfers.keptFor],
  ['1 day','7–400 days','60 days','60 days','7 days','365 days','90 days','90 days','90 days','Until they expire'],'days with plurals, a range, and "Until they expire"');
 check(byId(rowsOf(viewOf({customerRetention:{count:1,minDays:14,maxDays:14}}))).customerAudit.keptFor,'14 days','one value for every customer: no range');
 const german=byId(rowsOf(viewOf({settings:{auditDays:1},customerRetention:{count:2,minDays:7,maxDays:400}}),de,'de'));
 check([german.audit.keptFor,german.customerAudit.keptFor,german.transfers.keptFor],['1 Tag','7–400 Tage','Bis sie ablaufen'],'German');
 check(byId(rowsOf(viewOf({settings:{auditDays:null},envInvalid:{auditDays:true},areaRetention:{alertDays:{days:null,source:'env',envInvalid:true}}}))).audit.keptFor,EMPTY_VALUE,'an invalid start value keeps nothing visible');
 check(byId(rowsOf(viewOf({areaRetention:{alertDays:{days:null,source:'env',envInvalid:true}}}))).notifications.keptFor,EMPTY_VALUE,'an invalid alarm variable');
}

// ---- Set by --------------------------------------------------------------------------------
{
 const setBy=(view,id)=>{const row=byId(rowsOf(view))[id];return [row.setBy,row.setByText];};
 check(setBy(viewOf(),'audit'),[{key:'maintenancePage.setBy.page'},'This page'],'stored: this page');
 check(setBy(viewOf({settings:{source:{auditDays:'env',jobDays:'stored'}}}),'audit'),[{key:'maintenancePage.setBy.startValue',variable:'AUDIT_RETENTION_DAYS'},'Start value from AUDIT_RETENTION_DAYS'],'env: the start value');
 check(setBy(viewOf({settings:{source:{auditDays:'stored',jobDays:'default'}}}),'jobs'),[{key:'maintenancePage.setBy.defaultHere'},'Default, changeable here'],'default: changeable here');
 check(setBy(viewOf({settings:{jobDays:null,source:{auditDays:'stored',jobDays:'env'}},envInvalid:{jobDays:true}}),'jobOutputs'),[{key:'maintenancePage.setBy.invalid',variable:'JOB_RETENTION_DAYS'},'Invalid value in JOB_RETENTION_DAYS'],'invalid start value; job output follows jobs');
 check(setBy(viewOf({areaRetention:{softwareDays:{days:120,source:'env',envInvalid:false}}}),'softwareChanges'),[{key:'maintenancePage.setBy.env',variable:'SOFTWARE_CHANGE_RETENTION_DAYS'},'Environment variable SOFTWARE_CHANGE_RETENTION_DAYS'],'env-only from the variable');
 check(setBy(viewOf(),'alerts'),[{key:'maintenancePage.setBy.defaultEnv',variable:'ALERT_RETENTION_DAYS'},'Default, change with ALERT_RETENTION_DAYS'],'env-only default');
 check(setBy(viewOf(),'notifications'),[{key:'maintenancePage.setBy.defaultEnv',variable:'ALERT_RETENTION_DAYS'},'Default, change with ALERT_RETENTION_DAYS'],'notifications use the alarm variable');
 check(setBy(viewOf({areaRetention:{alertDays:{days:null,source:'env',envInvalid:true}}}),'alerts'),[{key:'maintenancePage.setBy.invalid',variable:'ALERT_RETENTION_DAYS'},'Invalid value in ALERT_RETENTION_DAYS'],'env-only invalid');
 for(const id of ['assistantScripts','integrityEvents','transfers'])check(setBy(viewOf(),id),[{key:'maintenancePage.setBy.fixed'},'Fixed'],`${id}: fixed`);
 check(setBy(viewOf({customerRetention:{count:1,minDays:7,maxDays:7}}),'customerAudit'),[{key:'maintenancePage.setBy.customers'},'Per customer, in Customers'],'per customer, with the Customers page name');
}

// ---- Size, share and entries ----------------------------------------------------------------
{
 const rows=byId(rowsOf(viewOf({customerRetention:{count:1,minDays:7,maxDays:7}})));
 check([rows.audit.bytes,rows.audit.size,rows.audit.share,rows.audit.shareLabel,rows.audit.entries],[40*MiB,formatBytes('en',40*MiB),20,'20% of the database','120,000'],'audit: size, share of the database and estimated entries');
 check([rows.notifications.bytes,rows.notifications.entries],[2*MiB,'250'],'notifications: events plus deliveries, entries of the events');
 check([rows.transfers.bytes,rows.transfers.entries],[MiB/2,'12'],'transfers: transfers plus chunks, entries of the transfers');
 check([rows.jobOutputs.bytes,rows.softwareChanges.bytes,rows.alerts.bytes,rows.integrityEvents.bytes],[24*MiB,2*MiB,MiB,MiB/2],'one table each');
 for(const id of ['customerAudit','assistantScripts'])check([rows[id].bytes,rows[id].size,rows[id].share,rows[id].shareLabel,rows[id].entries],[null,EMPTY_VALUE,null,null,EMPTY_VALUE],`${id}: no own size, no meter`);
 const missing=byId(rowsOf(viewOf({storage:{databaseBytes:null,tables:tables({audit:{bytes:null,rows:null},notification_deliveries:{bytes:null,rows:5}})}})));
 check([missing.audit.size,missing.audit.share,missing.audit.entries],[EMPTY_VALUE,null,EMPTY_VALUE],'null statistics: "—" and no meter');
 check([missing.notifications.bytes,missing.notifications.entries],[null,'250'],'a missing part of a sum gives no size');
 check([missing.jobs.size,missing.jobs.share],[formatBytes('en',8*MiB),null],'without the database size: the size without a meter');
 check(byId(rowsOf(viewOf(),de,'de')).audit.shareLabel,'20 % der Datenbank','German share label');
}

// ---- Last run --------------------------------------------------------------------------------
{
 const running={...run(9),finishedAt:null,status:'running',result:null};
 const rows=byId(rowsOf(viewOf({history:[running,run(1)],customerRetention:{count:2,minDays:7,maxDays:400}})));
 check(newestFinishedRun([running,run(1)]).id,1,'a running run is skipped');
 check([rows.audit.lastRun,rows.customerAudit.lastRun,rows.jobs.lastRun,rows.jobOutputs.lastRun,rows.assistantScripts.lastRun,rows.softwareChanges.lastRun,rows.alerts.lastRun,rows.notifications.lastRun,rows.integrityEvents.lastRun,rows.transfers.lastRun],
  ['12 deleted','5 deleted, more follow in the next run','4 deleted','2 deleted','9 cleared','6 deleted','1 deleted','5 deleted','7 deleted','5 cleared, 1 could not be cleared'],'the result of the newest finished run per area');
 const old=byId(rowsOf(viewOf({history:[run(1,{result:{audit:{deleted:3,more:false},jobs:{deleted:1,more:false},transfers:{cleared:2,failed:0,more:false}}})]})));
 check([old.audit.lastRun,old.softwareChanges.lastRun,old.integrityEvents.lastRun,old.assistantScripts.lastRun,old.transfers.lastRun],['3 deleted',EMPTY_VALUE,EMPTY_VALUE,EMPTY_VALUE,'2 cleared'],'an area without a value in an older run shows "—"');
 check(rowsOf(viewOf({history:[]})).every(row=>row.lastRun===EMPTY_VALUE),true,'no run: "—" everywhere');
 check(rowsOf(viewOf({history:[running]})).every(row=>row.lastRun===EMPTY_VALUE),true,'only a running run: "—" everywhere');
 check(byId(rowsOf(viewOf({history:[run(1,{status:'failed',error:'serverMessage.maintenance.lockLost',result:null})]}))).audit.lastRun,EMPTY_VALUE,'a failed run without a result');
}

// ---- KPI numbers -----------------------------------------------------------------------------
{
 check(deletedRows(result()),12+3+2+4+2+6+1+5+7+5,'deleted rows: audit, customer passes, jobs, job output, software, alarms, notifications, agent service events and cleared transfers; assistant scripts excluded');
 check([deletedRows(null),deletedRows({})],[null,0],'null without a result; 0 for an empty result');
 const running={...run(9),finishedAt:null,status:'running',result:null};
 const kpis=storageKpis(viewOf({history:[running,run(1)]}));
 check(kpis,{databaseBytes:200*MiB,areaBytes:40*MiB+8*MiB+24*MiB+2*MiB+MiB+MiB+MiB+MiB/2+MiB/4+MiB/4,transferObjectBytes:3*MiB,lastRun:{deleted:47,finishedAt:2001,failed:false}},'the KPI numbers from the newest finished run');
 check(storageKpis(viewOf({history:[run(2,{status:'failed',error:'x'}),run(1)]})).lastRun.failed,true,'a failed last run marks the tile');
 check(storageKpis(viewOf({history:[]})).lastRun,null,'no finished run: no tile');
 check(storageKpis(viewOf({history:[running]})).lastRun,null,'only a running run: no tile');
 check(storageKpis(viewOf({history:[run(1,{result:null,status:'failed'})]})).lastRun,null,'a finished run without a result: no tile');
 const empty=storageKpis(viewOf({storage:{databaseBytes:null,tables:Object.fromEntries(Object.keys(tables()).map(name=>[name,{bytes:null,rows:null}])),transferObjectBytes:null}}));
 check([empty.databaseBytes,empty.areaBytes,empty.transferObjectBytes],[null,null,null],'unreadable statistics: null values, so KpiRow leaves the tiles out');
}
console.log(`PASS ${checks} retention model checks: row order and presence, kept-for texts, set-by for every source, sizes with share and entries, last run from the newest finished run, KPI numbers.`);
