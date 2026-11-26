// The health of a device from its open alarms (ui/base/health-score.ts), pure: the
// weights, deviceHealth with the examples of the spec, acknowledged and muted
// alarms, the clamp at 0, per-key counting and no data, the tooltip in English
// and German, the rows of the Problems tab with their order and reasons, the
// counts, the device area of every alert rule, and the weights in the docs.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const health=await import('../../../ui/base/health-score.ts');
const {alertRuleIds}=await import('../../../lib/alert-rules.ts');
const {deviceDetails,isDeviceSection}=await import('../../../lib/console-route.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const minute=60000,now=Date.UTC(2026,10,3,10,0,0);
let sequence=0;
const alert=(ruleId,level,minutesAgo=10,extra={})=>({id:'a'+(++sequence),ruleId,key:extra.key??ruleId,level,peakLevel:level,peakValue:null,threshold:null,params:{},startedAt:now-minutesAgo*minute,openedAt:now-minutesAgo*minute,acknowledged:null,muted:null,...extra});
const device=(id,name,alerts,lastSeen=now-10000)=>({id,name,alerts,lastSeen});

// ---- Weights and deviceHealth ----
check(health.healthWeights,{critical:40,warning:15,info:5},'the weights');
const of=alerts=>health.deviceHealth({alerts,lastSeen:now});
check(of([]),{state:'good',score:100,counts:{critical:0,warning:0,info:0}},'no alarms: good 100');
check(of([alert('cpu','warning')]),{state:'warning',score:85,counts:{critical:0,warning:1,info:0}},'one warning: warning 85');
check(of([alert('memory','critical'),alert('cpu','warning')]),{state:'critical',score:45,counts:{critical:1,warning:1,info:0}},'one critical and one warning: critical 45');
check(of([alert('inventory-incomplete','info'),alert('reboot-pending','info')]),{state:'good',score:90,counts:{critical:0,warning:0,info:2}},'two info: good 90, info keeps the state');
check(of([alert('cpu','critical'),alert('memory','critical'),alert('disk-free','critical')]),{state:'critical',score:0,counts:{critical:3,warning:0,info:0}},'three critical: clamped at 0');
check(of([alert('cpu','warning'),alert('memory','warning'),alert('disk-free','warning')]).state,'warning','three warnings (55) stay warning');
check(of([alert('cpu','warning',5,{acknowledged:{at:now,by:'anna'}}),alert('memory','warning',5,{muted:{until:now+minute,by:'anna'}})]),{state:'warning',score:70,counts:{critical:0,warning:2,info:0}},'acknowledged and muted alarms count');
check(of([alert('disk-free','warning',5,{key:'disk-C:'}),alert('disk-free','warning',5,{key:'disk-D:'})]).counts.warning,2,'two volumes with disk-free count twice');
check(health.deviceHealth({alerts:[],lastSeen:null}),{state:'unknown',score:null,counts:{critical:0,warning:0,info:0}},'no Heartbeat and no alarms: no data');
check(health.deviceHealth({lastSeen:null}).state,'unknown','no alerts field and no Heartbeat: no data');
check(health.deviceHealth({alerts:[alert('device-offline','critical')],lastSeen:null}).state,'critical','an alarm wins over a missing Heartbeat');

// ---- healthText ----
const sample=of([alert('memory','critical'),alert('cpu','warning'),alert('reboot-pending','info')]);
for(const locale of ['en','de']){
 const text=health.healthText(sample,locale);
 ok(text.tooltip.includes(String(sample.score)),`${locale}: the tooltip names the score`);
 for(const weight of Object.values(health.healthWeights))ok(text.tooltip.includes(String(weight)),`${locale}: weight ${weight}`);
}
check(health.healthText(sample,'en'),{label:'Critical',tooltip:'Health 40 of 100. Each open alarm lowers the score: critical by 40, warning by 15, info by 5. Open alarms: 1 critical, 1 warning, 1 info.'},'English label and tooltip with the counts');
check(health.healthText(sample,'de'),{label:'Kritisch',tooltip:'Gesundheit 40 von 100. Jeder offene Alarm senkt den Wert: kritisch um 40, Warnung um 15, Info um 5. Offene Alarme: 1 kritisch, 1 Warnung, 1 Info.'},'German label and tooltip');
check(health.healthText(health.deviceHealth({alerts:[],lastSeen:null}),'en'),{label:'No data',tooltip:'No data yet. The health score appears after the first Heartbeat.'},'no data has its own sentence');
check([health.healthText(of([]),'de').label,health.healthText(of([alert('cpu','warning')]),'de').label],['Gut','Warnung'],'German labels');

// ---- problemRows ----
const infoOnly=device('d-info','INFO-01',[alert('inventory-incomplete','info',500)]);
const quiet=device('d-quiet','QUIET',[]);
const warnOld=device('d-warn-old','WARN-2',[alert('reboot-pending','warning',300),alert('inventory-incomplete','info',900)]);
const warnNew=device('d-warn-new','WARN-1',[alert('cpu','warning',20)]);
const critNew=device('d-crit-new','CRIT-NEW',[alert('memory','critical',10),alert('cpu','warning',400)]);
const critOld=device('d-crit-old','CRIT-OLD',[alert('disk-free','critical',60,{key:'disk-D:'}),alert('disk-free','critical',60,{key:'disk-C:'}),alert('reboot-pending','info',30),alert('cpu','warning',30)]);
// Same since and the same state: the lower score first, then the name (numeric) and id.
const tieA=device('d-tie-a','PC-10',[alert('updates-pending','warning',100)]);
const tieB=device('d-tie-b','PC-9',[alert('updates-pending','warning',100)]);
const tieLow=device('d-tie-low','PC-99',[alert('updates-pending','warning',100),alert('reboot-pending','warning',50)]);
const rows=health.problemRows([quiet,infoOnly,warnNew,tieA,critNew,warnOld,tieB,critOld,tieLow]);
check(rows.map(row=>row.device.id),['d-crit-old','d-crit-new','d-warn-old','d-tie-low','d-tie-b','d-tie-a','d-warn-new'],'critical first, then the longest open at the worst level, then score, then name');
ok(!rows.some(row=>row.device.id==='d-info'||row.device.id==='d-quiet'),'info-only and quiet devices are not in the list');
check(rows.find(row=>row.device.id==='d-crit-new').since,now-10*minute,'since is the earliest start at the worst level, not the older warning');
check(rows.find(row=>row.device.id==='d-crit-old').reasons.map(item=>[item.level,item.key]),[['critical','disk-C:'],['critical','disk-D:'],['warning','cpu'],['info','reboot-pending']],'reasons: level, then oldest start, then rule id and key');
check(rows.find(row=>row.device.id==='d-warn-old').reasons.map(item=>item.level),['warning','info'],'every open alarm is a reason, info last');
check(rows[0].health,health.deviceHealth(critOld),'the row holds the device health');
check(health.problemCounts(rows),{all:7,critical:2,warning:5},'problem counts');
check(health.problemCounts([]),{all:0,critical:0,warning:0},'no rows');

// ---- alarmTarget ----
const table={
 'diagnostics/processes':['cpu','memory','processor-queue'],
 'hardware/memory':['pagefile'],
 'management/storage':['disk-free','disk-latency','disk-health-failed','ssd-wear','disk-errors','bitlocker-system-unencrypted','bitlocker-suspended','bitlocker-no-recovery-password'],
 'management/updates':['reboot-pending','updates-pending'],
 // The driver, certificate and autostart rules open the Software area (slice 6).
 'software/drivers':['device-problem','driver-unsigned'],
 'diagnostics/events':['crash-recent','stability-low','app-crash-repeated'],
 'software/certificates':['cert-expiring','cert-expiring-no-key'],
 'software/autostart':['autostart-new','autostart-new-suspicious'],
 'hardware/overview':['battery-capacity'],
 // The two DHCP rules open the DHCP server view of the Extensions area.
 'extensions/dhcp':['dhcp-scope-full','dhcp-service-stopped'],
 // The DNS rule opens the DNS server view of the Extensions area.
 'extensions/dns':['dns-service-stopped'],
 // The four Defender rules open the Defender area (agent 4.14.0).
 'management/defender':['threat-detected','scan-age','defender-off','signatures-age'],
 // The three agent rules of 4.18.0 open the Overview: the health line names the change.
 overview:['agent-stopped','agent-removed','agent-protection-changed','firewall-off','os-support-end','os-support-unknown','inventory-incomplete','device-offline'],
};
check(Object.values(table).flat().sort(),[...alertRuleIds].sort(),'the table covers every rule exactly once');
for(const [target,ids] of Object.entries(table))for(const id of ids){
 const [section,detail]=target.split('/');
 check(health.alarmTarget(id,{},{snapshot:null}),detail?{section,detail}:{section},`${id} → ${target}`);
}
for(const id of alertRuleIds){
 const target=health.alarmTarget(id,{},{snapshot:null});
 ok(isDeviceSection(target.section),`${id}: a device section`);
 if(target.detail!==undefined)ok(deviceDetails[target.section]?.includes(target.detail),`${id}: ${target.detail} is a subarea of ${target.section}`);
}
check(health.alarmTarget('no-such-rule',{},{snapshot:null}),{section:'overview'},'an unknown rule opens the overview');
check(health.alarmTarget('cpu'),{section:'diagnostics',detail:'processes'},'params and server are optional');

// ---- Docs ----
const docs=readFileSync('docs/alert-rules.md','utf8');
const section=docs.slice(docs.indexOf('## Health and the Monitoring tab'));
ok(section.length>100,'the docs have the health section');
for(const [level,weight] of Object.entries(health.healthWeights))ok(new RegExp(`\\| ${level[0].toUpperCase()+level.slice(1)} \\| ${weight} \\|`).test(section),`the docs list the ${level} weight ${weight}`);

console.log(`PASS health score (${checks} checks): weights, states and scores, acknowledged and muted alarms, the clamp, per-key counts, no data, the tooltip in English and German, the alarms-by-device rows with their order, reasons and counts, the area of every alert rule and the weights in the docs.`);
