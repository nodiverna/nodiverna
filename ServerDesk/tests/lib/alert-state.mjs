// The alarm state machine (lib/server/devices/alert-state.ts) and the readings
// (alertReadings in lib/alert-rules.ts) without a database: open and close of
// threshold and boolean rules, per-volume keys, the minimum duration, the
// recovery band against flapping, the above and below boundaries, the peak,
// escalation, rule-off and no-data, Device offline and unchanged evaluations.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const rules=await import('../../lib/alert-rules.ts');
const state=await import('../../lib/server/devices/alert-state.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const minute=60000,t0=Date.UTC(2026,9,1,8,0,0);
const settingsWith=(changes={})=>{const map=rules.defaultAlertSettings();for(const [id,value] of Object.entries(changes))map[id]={...map[id],...value};return map;};
const snapshot=(values={})=>({hostname:'H',os:'Microsoft Windows Server 2025',cores:4,cpu:10,memory:10,disks:[],collectionErrors:[],processes:[],rebootPending:false,...values});

/** Applies the transitions to an in-memory alarm list, like lib/server/devices/alerts.ts does in SQL. */
function apply(alerts,transitions,now){
 let next=alerts.filter(alert=>!transitions.deletes.includes(alert.id));
 const closes=new Map(transitions.closes.map(close=>[close.id,close.reason]));
 const closed=next.filter(alert=>closes.has(alert.id)).map(alert=>({...alert,state:'closed',closedAt:now,closeReason:closes.get(alert.id)}));
 next=next.filter(alert=>!closes.has(alert.id)).map(alert=>{
  const update=transitions.updates.find(item=>item.id===alert.id);
  if(!update)return alert;
  const {clearAcknowledgement,...values}=update;
  return {...alert,...values,acknowledgedAt:clearAcknowledgement?null:alert.acknowledgedAt};
 });
 let counter=alerts.length+closedHistory.length;
 for(const insert of transitions.inserts)next.push({...insert,id:`a${++counter}`,acknowledgedAt:null});
 closedHistory.push(...closed);
 return next;
}
let closedHistory=[];
/** One device run: evaluates at each step and keeps the alarms that are not closed. */
function run(steps,{settings=settingsWith(),start=[]}={}){
 closedHistory=[];
 let alerts=start;const outputs=[];
 for(const step of steps){
  const server={snapshot:'snapshot' in step?step.snapshot:snapshot(step.values),lastSeen:step.lastSeen??step.now,maintenance:step.maintenance??null,osSupport:null};
  const issues=rules.evaluateAlertRules(server,step.settings??settings,step.now),readings=rules.alertReadings(server,step.now);
  const transitions=state.alertTransitions({server,alerts,issues,readings,settings:step.settings??settings,now:step.now});
  outputs.push(transitions);
  alerts=apply(alerts,transitions,step.now);
 }
 return {alerts,outputs,closed:closedHistory};
}
const brief=alert=>({ruleId:alert.ruleId,key:alert.key,state:alert.state,level:alert.level});

// ---- Readings ----
{
 const server={snapshot:snapshot({cpu:91,memory:42,disks:[{name:'C:',label:'',totalGb:200,freeGb:20},{name:'D:',label:'',totalGb:0,freeGb:0}],performance:{diskLatencyMs:12,pagefilePercent:33,processorQueue:10},security:{defender:{available:true,enabled:true,realTimeProtection:true,signatureAt:new Date(t0-3*86400000).toISOString()}}}),lastSeen:t0-17*minute-5000,osSupport:null};
 check(rules.alertReadings(server,t0),[
  {ruleId:'device-offline',key:'offline',value:17},{ruleId:'cpu',key:'cpu',value:91},{ruleId:'memory',key:'memory',value:42},{ruleId:'disk-free',key:'disk-C:',value:10},
  {ruleId:'disk-latency',key:'latency',value:12},{ruleId:'pagefile',key:'pagefile',value:33},{ruleId:'processor-queue',key:'queue',value:2.5},{ruleId:'signatures-age',key:'signatures',value:3},
 ],'readings per rule and key in the rule unit, also when no rule fires; a volume without size has none');
 check(rules.alertReadings({snapshot:null,lastSeen:null,osSupport:null},t0),[],'no snapshot and no Heartbeat: no readings');
}

// ---- Threshold rule: open and close; boolean rule ----
{
 const settings=settingsWith({cpu:{durationMinutes:0,recovery:0}});
 const result=run([
  {now:t0,values:{cpu:95,rebootPending:true}},
  {now:t0+minute,values:{cpu:85,rebootPending:true}},
  {now:t0+2*minute,values:{cpu:50,rebootPending:false}},
 ],{settings});
 check(result.outputs[0].inserts.map(insert=>[insert.ruleId,insert.state,insert.level,insert.peakValue,insert.threshold,insert.startedAt,insert.openedAt]),[['cpu','open','critical',95,90,t0,t0],['reboot-pending','open','warning',null,null,t0,t0]],'duration 0 opens at once; a boolean alarm has no peak value');
 check(result.outputs[1].updates.map(update=>[update.level,update.peakLevel,update.peakValue,update.threshold]),[['warning','critical',95,90]],'the level follows the firing level, the peak stays');
 check(result.closed.map(alert=>[alert.ruleId,alert.closeReason]).sort(),[['cpu','recovered'],['reboot-pending','recovered']],'both close when the rule stops firing (recovery 0)');
 check(result.alerts,[],'nothing left open');
}

// ---- Per-volume keys ----
{
 const disks=(c,d)=>({disks:[{name:'C:',label:'',totalGb:100,freeGb:c},{name:'D:',label:'',totalGb:100,freeGb:d}]});
 const result=run([{now:t0,values:disks(10,50)},{now:t0+minute,values:disks(10,4)},{now:t0+2*minute,values:disks(30,30)}]);
 check(result.outputs[0].inserts.map(brief),[{ruleId:'disk-free',key:'disk-C:',state:'open',level:'warning'}],'disk-free opens per volume, duration 0 by default');
 check(result.outputs[1].inserts.map(brief),[{ruleId:'disk-free',key:'disk-D:',state:'open',level:'critical'}],'a second volume gets its own alarm');
 check(result.closed.map(alert=>alert.key).sort(),['disk-C:','disk-D:'],'each volume closes on its own (30 % ≥ 15 + 2)');
}

// ---- Minimum duration ----
{
 const settings=settingsWith({cpu:{durationMinutes:5,recovery:5}});
 let result=run([{now:t0,values:{cpu:85}},{now:t0+4*minute+59999,values:{cpu:86}},{now:t0+5*minute,values:{cpu:84}}],{settings});
 check(result.outputs[0].inserts.map(insert=>[insert.state,insert.openedAt]),[['pending',null]],'a pending alarm while the duration runs');
 check(result.outputs[1].updates.map(update=>[update.state,update.peakValue]),[['pending',86]],'still pending just before the duration; the peak moves');
 check(result.outputs[2].updates.map(update=>[update.state,update.openedAt,update.peakValue]),[['open',t0+5*minute,86]],'opens exactly at the duration');
 result=run([{now:t0,values:{cpu:85}},{now:t0+2*minute,values:{cpu:60}},{now:t0+3*minute,values:{cpu:85}}],{settings});
 check([result.outputs[1].deletes.length,result.closed.length,result.outputs[2].inserts.map(insert=>[insert.state,insert.startedAt])],[1,0,[['pending',t0+3*minute]]],'a dip deletes the pending row without history; a new rise starts again');
}

// ---- Flapping: one alarm inside the recovery band ----
{
 const settings=settingsWith({cpu:{warning:90,critical:null,durationMinutes:0,recovery:5}});
 const series=[91,88,92,86,91].map((cpu,index)=>({now:t0+index*minute,values:{cpu}}));
 let result=run(series,{settings});
 check([result.alerts.length,result.closed.length,result.outputs.reduce((sum,output)=>sum+output.inserts.length,0)],[1,0,1],'91, 88, 92, 86, 91 with T=90 and r=5 keep one alarm');
 check([result.alerts[0].level,result.alerts[0].peakValue],['warning',92],'the alarm keeps its level, the peak is the worst reading');
 result=run([...series,{now:t0+5*minute,values:{cpu:85}},{now:t0+6*minute,values:{cpu:84.9}},{now:t0+7*minute,values:{cpu:93}}],{settings});
 check(result.outputs[5],{inserts:[],updates:[],closes:[],deletes:[]},'exactly at T − r (85) it stays open: at-least closes below T − r');
 check(result.closed.map(alert=>alert.closeReason),['recovered'],'below 85 it closes');
 check(result.outputs[7].inserts.map(insert=>[insert.state,insert.peakValue]),[['open',93]],'a new rise opens a new alarm');
}

// ---- above and below boundaries ----
{
 // processor-queue: above, T=2 threads per processor, r=1 → closes at ≤ 1.
 const settings=settingsWith({'processor-queue':{durationMinutes:0,recovery:1}});
 const queue=threads=>({cores:4,performance:{processorQueue:threads}});
 let result=run([{now:t0,values:queue(12)},{now:t0+minute,values:queue(5)},{now:t0+2*minute,values:queue(4)}],{settings});
 check([result.outputs[0].inserts.length,result.outputs[1],result.closed.map(alert=>alert.closeReason)],[1,{inserts:[],updates:[],closes:[],deletes:[]},['recovered']],'above: 1.25 per processor stays open, exactly T − r (1) closes');
 // disk-free: below, T=15 %, r=2 → closes at ≥ 17 %.
 const disk=free=>({disks:[{name:'C:',label:'',totalGb:100,freeGb:free}]});
 result=run([{now:t0,values:disk(10)},{now:t0+minute,values:disk(16.9)},{now:t0+2*minute,values:disk(17)}]);
 check([result.outputs[1].closes.length,result.closed.map(alert=>alert.closeReason)],[0,['recovered']],'below: 16.9 % stays open, exactly T + r (17 %) closes');
}

// ---- Peak level, threshold of the peak, escalation clears the acknowledgement ----
{
 const settings=settingsWith({memory:{durationMinutes:0,recovery:5}});
 let result=run([{now:t0,values:{memory:82}}],{settings});
 const acknowledged=[{...result.alerts[0],acknowledgedAt:t0+1000}];
 result=run([{now:t0+minute,values:{memory:84}}],{settings,start:acknowledged});
 check(result.outputs[0].updates.map(update=>update.clearAcknowledgement),[false],'the same level keeps the acknowledgement');
 result=run([{now:t0+minute,values:{memory:95}},{now:t0+2*minute,values:{memory:83}}],{settings,start:acknowledged});
 check(result.outputs[0].updates.map(update=>[update.level,update.peakLevel,update.threshold,update.peakValue,update.clearAcknowledgement]),[['critical','critical',90,95,true]],'warning → critical: peak level and its threshold, the acknowledgement is cleared');
 check([result.alerts[0].level,result.alerts[0].peakLevel,result.alerts[0].threshold,result.alerts[0].peakValue],['warning','critical',90,95],'back to warning: the peak stays');
}

// ---- rule-off and no-data ----
{
 const settings=settingsWith({cpu:{durationMinutes:0,recovery:5}});
 let result=run([{now:t0,values:{cpu:95,rebootPending:true}},{now:t0+minute,values:{cpu:95,rebootPending:true},settings:settingsWith({cpu:{enabled:false},'reboot-pending':{enabled:false}})}],{settings});
 check(result.closed.map(alert=>[alert.ruleId,alert.closeReason]).sort(),[['cpu','rule-off'],['reboot-pending','rule-off']],'a turned-off rule closes with rule-off');
 result=run([{now:t0,values:{cpu:95,rebootPending:true}},{now:t0+3*minute,lastSeen:t0,values:{cpu:95,rebootPending:true}}],{settings});
 check(result.closed.map(alert=>[alert.ruleId,alert.closeReason]),[['cpu','no-data']],'a live rule on an offline device closes with no-data; a non-live alarm stays');
 result=run([{now:t0,values:{rebootPending:true}},{now:t0+minute,snapshot:null}]);
 check(result.closed.map(alert=>[alert.ruleId,alert.closeReason]),[['reboot-pending','no-data']],'without a snapshot it closes with no-data');
 const pendingSettings=settingsWith({cpu:{durationMinutes:5,recovery:5}});
 result=run([{now:t0,values:{cpu:95}},{now:t0+3*minute,lastSeen:t0,values:{cpu:95}}],{settings:pendingSettings});
 check([result.outputs[1].deletes.length,result.closed.length],[1,0],'a pending live alarm of an offline device is deleted');
}

// ---- Device offline ----
{
 const updating={state:'updating',version:'4.10.0',notBefore:0};
 let result=run([{now:t0+60*minute,lastSeen:null,values:{}}]);
 check(result.alerts,[],'waiting for the first Heartbeat: no alarm');
 result=run([{now:t0+30*minute,lastSeen:t0,maintenance:updating,values:{}}]);
 check(result.alerts,[],'an agent update runs: no alarm');
 result=run([{now:t0+14*minute+59999,lastSeen:t0,values:{}},{now:t0+15*minute,lastSeen:t0,values:{}}]);
 check(result.outputs[0].inserts,[],'not at 14 minutes');
 check(result.outputs[1].inserts.map(insert=>[insert.ruleId,insert.key,insert.state,insert.level,insert.peakValue,insert.threshold,insert.params]),[['device-offline','offline','open','critical',15,15,{lastSeen:t0,minutes:15}]],'opens at 15 minutes, critical, without a minimum duration');
 const open=result.alerts;
 result=run([{now:t0+16*minute,lastSeen:t0,maintenance:updating,values:{}}],{start:open});
 check(result.outputs[0],{inserts:[],updates:[],closes:[],deletes:[]},'while an agent update runs it neither opens nor closes');
 result=run([{now:t0+20*minute,lastSeen:t0+20*minute,values:{}}],{start:open});
 check(result.closed.map(alert=>[alert.ruleId,alert.closeReason]),[['device-offline','recovered']],'closes with recovered once the device is online');
 result=run([{now:t0+15*minute,lastSeen:t0,snapshot:null}]);
 check(result.alerts.map(brief),[{ruleId:'device-offline',key:'offline',state:'open',level:'critical'}],'also a device without a snapshot');
}

// ---- Unchanged evaluations write nothing ----
{
 const settings=settingsWith({cpu:{durationMinutes:0,recovery:5}});
 const result=run([{now:t0,values:{cpu:95,rebootPending:true,rebootReasons:['windows-update']}},{now:t0+30000,values:{cpu:95,rebootPending:true,rebootReasons:['windows-update']}}],{settings});
 check(result.outputs[1],{inserts:[],updates:[],closes:[],deletes:[]},'the same values: no write');
 check(state.noTransitions(result.outputs[1]),true,'noTransitions');
}

// ---- Notification events (alertEvents) ----
{
 const base={ruleId:'cpu',key:'cpu',peakValue:91,threshold:90,params:{},startedAt:t0,acknowledgedAt:null};
 const open=(id,level,extra={})=>({...base,id,state:'open',level,peakLevel:level,openedAt:t0,...extra});
 const pending=(id,level)=>({...base,id,state:'pending',level,peakLevel:level,openedAt:null});
 const update=(id,level,state='open',extra={})=>({id,state,level,peakLevel:level,peakValue:95,threshold:95,params:{},openedAt:t0,clearAcknowledgement:false,...extra});
 const insert=(state,level)=>({ruleId:'cpu',key:'cpu',state,level,peakLevel:level,peakValue:93,threshold:90,params:{},startedAt:t0,openedAt:state==='open'?t0:null});
 const none={inserts:[],updates:[],closes:[],deletes:[]};
 const kinds=list=>list.map(event=>[event.kind,event.alertId,event.insert,event.level]);
 check(kinds(state.alertEvents([],{...none,inserts:[insert('open','warning')]})),[['open',null,0,'warning']],'an insert that opens at once');
 check(state.alertEvents([],{...none,inserts:[insert('open','warning')]},[{ruleId:'cpu',key:'cpu',value:92}])[0].value,92,'the value is the reading at the event');
 check(state.alertEvents([],{...none,inserts:[insert('open','warning')]})[0].value,93,'without a reading the peak');
 check(kinds(state.alertEvents([pending('p','warning')],{...none,updates:[update('p','warning')]})),[['open','p',null,'warning']],'pending to open');
 check(kinds(state.alertEvents([open('o','warning')],{...none,updates:[update('o','critical')]})),[['escalate','o',null,'critical']],'warning to critical');
 check(kinds(state.alertEvents([open('o','info')],{...none,updates:[update('o','warning')]})),[['escalate','o',null,'warning']],'info to warning');
 check(kinds(state.alertEvents([open('o','info')],{...none,updates:[update('o','critical')]})),[['escalate','o',null,'critical']],'info to critical');
 check(state.alertEvents([open('o','critical')],{...none,updates:[update('o','warning',undefined,{peakLevel:'critical'})]}),[],'a level drop gives no event');
 check(state.alertEvents([open('o','warning')],{...none,updates:[update('o','warning',undefined,{peakValue:99})]}),[],'a peak or params update gives no event');
 const closed=state.alertEvents([open('o','critical',{peakValue:97,threshold:95})],{...none,closes:[{id:'o',reason:'no-data'}]});
 check(closed.map(event=>[event.kind,event.alertId,event.level,event.value,event.threshold,event.closeReason]),[['close','o','critical',97,95,'no-data']],'a close carries the peak level, peak value and reason');
 for(const reason of ['recovered','rule-off'])check(state.alertEvents([open('o','warning')],{...none,closes:[{id:'o',reason}]})[0].closeReason,reason,`close reason ${reason}`);
 check(state.alertEvents([],{...none,inserts:[insert('pending','warning')]}),[],'a pending insert gives no event');
 check(state.alertEvents([pending('p','warning')],{...none,deletes:['p']}),[],'a pending delete gives no event');
 check(state.alertEvents([pending('p','warning')],{...none,updates:[update('p','critical','pending',{openedAt:null})]}),[],'a pending alarm that stays pending gives no event');
}

console.log(`PASS alarm state (${checks} checks): readings, open and close, volumes, minimum duration, recovery band, above and below boundaries, peak and escalation, rule-off and no-data, Device offline, no writes when nothing changes, notification events.`);
