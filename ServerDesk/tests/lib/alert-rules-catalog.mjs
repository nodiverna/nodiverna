// The alert rule catalog (lib/alert-rules.ts): the 41 rules (with the two Windows activation rules of agent 4.22.0, the two Defender rules of agent 4.14.0, the two DHCP rules, the DNS rule and the three agent rules of 4.18.0) with their defaults
// and ranges (incl. the limit kind and the units count and index), the minimum duration and recovery margin of the alarms, the resolution along the scope chain
// (default < All devices < customer < groups < device), the shared validation and
// the description sentences in both catalogs (lib/alert-rules-text.ts).
// No database.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const rules=await import('../../lib/alert-rules.ts');
const text=await import('../../lib/alert-rules-text.ts');
const {default:en}=await import('../../lib/i18n/messages/en.ts');
const {default:de}=await import('../../lib/i18n/messages/de.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

// ---- Catalog ----
check(rules.alertRules.map(rule=>rule.id),['cpu','memory','disk-free','disk-latency','pagefile','processor-queue','reboot-pending','firewall-off','defender-off','signatures-age','updates-pending','inventory-incomplete','crash-recent','os-support-end','os-support-unknown','windows-evaluation','windows-not-activated','bitlocker-system-unencrypted','bitlocker-suspended','bitlocker-no-recovery-password','device-problem','driver-unsigned','stability-low','app-crash-repeated','disk-health-failed','ssd-wear','disk-errors','battery-capacity','cert-expiring','cert-expiring-no-key','autostart-new','autostart-new-suspicious','threat-detected','scan-age','dhcp-scope-full','dhcp-service-stopped','dns-service-stopped','agent-stopped','agent-removed','agent-protection-changed','device-offline'],'41 rules in catalog order, the two Windows activation rules after os-support-unknown, the health signal 2 rules, the two Defender rules, the two DHCP rules, the DNS rule and the three agent rules before Device offline, which stays last');
const summary=Object.fromEntries(rules.alertRules.map(rule=>{const {enabled,warning,critical,level}=rule.defaults;return [rule.id,[rule.kind,rule.unit,rule.comparison,rule.live,{enabled,warning,critical,level},rule.range]];}));
check(summary,{
 cpu:['threshold','percent','at-least',true,{enabled:true,warning:80,critical:90,level:null},{min:1,max:100}],
 memory:['threshold','percent','at-least',true,{enabled:true,warning:80,critical:90,level:null},{min:1,max:100}],
 'disk-free':['threshold','percent','below',false,{enabled:true,warning:15,critical:5,level:null},{min:1,max:99}],
 'disk-latency':['threshold','ms','at-least',true,{enabled:true,warning:50,critical:100,level:null},{min:1,max:60000}],
 pagefile:['threshold','percent','at-least',true,{enabled:true,warning:80,critical:90,level:null},{min:1,max:100}],
 'processor-queue':['threshold','perProcessor','above',true,{enabled:true,warning:2,critical:null,level:null},{min:1,max:100}],
 'reboot-pending':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'warning'},null],
 'firewall-off':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'warning'},null],
 'defender-off':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'warning'},null],
 'signatures-age':['threshold','days','above',false,{enabled:true,warning:7,critical:null,level:null},{min:1,max:365}],
 'updates-pending':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'warning'},null],
 'inventory-incomplete':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'info'},null],
 'crash-recent':['threshold','days','within',false,{enabled:true,warning:30,critical:7,level:null},{min:1,max:30}],
 'os-support-end':['threshold','days','remaining-at-most',false,{enabled:true,warning:180,critical:0,level:null},{min:0,max:1825}],
 'os-support-unknown':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'info'},null],
 // Windows activation (agent 4.22.0): an evaluation warns from 180 days left and is critical from 14; not activated warns.
 'windows-evaluation':['threshold','days','remaining-at-most',false,{enabled:true,warning:180,critical:14,level:null},{min:0,max:365}],
 'windows-not-activated':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'warning'},null],
 'bitlocker-system-unencrypted':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'warning'},null],
 'bitlocker-suspended':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'warning'},null],
 'bitlocker-no-recovery-password':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'info'},null],
 'device-problem':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'warning'},null],
 'driver-unsigned':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'info'},null],
 'stability-low':['threshold','index','below',false,{enabled:true,warning:5,critical:null,level:null},{min:1,max:10}],
 'app-crash-repeated':['threshold','count','at-least',false,{enabled:true,warning:3,critical:null,level:null},{min:1,max:100}],
 'disk-health-failed':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'critical'},null],
 'ssd-wear':['threshold','percent','at-least',false,{enabled:true,warning:80,critical:95,level:null},{min:1,max:100}],
 'disk-errors':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'warning'},null],
 'battery-capacity':['limit','percent','below',false,{enabled:true,warning:60,critical:null,level:'info'},{min:1,max:99}],
 'cert-expiring':['threshold','days','remaining-at-most',false,{enabled:true,warning:30,critical:7,level:null},{min:0,max:365}],
 'cert-expiring-no-key':['threshold','days','remaining-at-most',false,{enabled:false,warning:30,critical:7,level:null},{min:0,max:365}],
 'autostart-new':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'info'},null],
 'autostart-new-suspicious':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'warning'},null],
 'threat-detected':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'critical'},null],
 'scan-age':['threshold','days','above',false,{enabled:true,warning:7,critical:null,level:null},{min:1,max:365}],
 // The DHCP plugin: a warning at 90 % with no critical step; the stopped service is critical.
 'dhcp-scope-full':['threshold','percent','at-least',false,{enabled:true,warning:90,critical:null,level:null},{min:1,max:100}],
 'dhcp-service-stopped':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'critical'},null],
 'dns-service-stopped':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'critical'},null],
 // Agent tamper protection (4.18.0): a stopped agent warns; a removed agent and a changed protection are critical.
 'agent-stopped':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'warning'},null],
 'agent-removed':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'critical'},null],
 'agent-protection-changed':['boolean',null,null,false,{enabled:true,warning:null,critical:null,level:'critical'},null],
 'device-offline':['threshold','minutes','at-least',false,{enabled:true,warning:null,critical:15,level:null},{min:3,max:10080}],
},'kinds, units, comparisons, live flags, defaults and ranges');
for(const rule of rules.alertRules){assert.ok(rule.metric,`${rule.id} names its metric`);assert.ok(Object.hasOwn(en,rule.name)&&Object.hasOwn(de,rule.name),`${rule.id} name in both catalogs`);for(const key of Object.values(rule.description))assert.ok(Object.hasOwn(en,key)&&Object.hasOwn(de,key),`${key} in both catalogs`);checks++;}

// The minimum duration and recovery margin: only the alarm threshold rules, null for boolean rules, Device offline and the age and date rules.
check(Object.fromEntries(rules.alertRules.filter(rule=>rule.defaults.durationMinutes!==null||rule.defaults.recovery!==null).map(rule=>[rule.id,[rule.defaults.durationMinutes,rule.defaults.recovery]])),
 {cpu:[5,5],memory:[5,5],'disk-free':[0,2],'disk-latency':[5,10],pagefile:[5,5],'processor-queue':[5,0],'signatures-age':[0,0],'stability-low':[0,0],'app-crash-repeated':[0,0],'ssd-wear':[0,0],'scan-age':[0,0],'dhcp-scope-full':[0,5]},'duration and recovery defaults');
check(rules.alertRules.filter(rules.alarmSettingsApply).map(rule=>rule.id),['cpu','memory','disk-free','disk-latency','pagefile','processor-queue','signatures-age','stability-low','app-crash-repeated','ssd-wear','scan-age','dhcp-scope-full'],'the rules with alarm settings');

// ---- Resolution ----
const parent='10000000-0000-4000-8000-000000000001',child='10000000-0000-4000-8000-000000000002',grandchild='10000000-0000-4000-8000-000000000003',deviceId='20000000-0000-4000-8000-000000000001';
const override=(ruleId,scopeType,scopeId,settings,updatedAt=1)=>({ruleId,scopeType,scopeId,enabled:true,warning:null,critical:null,level:null,durationMinutes:null,recovery:null,...settings,updatedAt});
const chain=rules.deviceAlertChain(deviceId,[{id:grandchild,depth:2},{id:parent,depth:0},{id:child,depth:1}]);
check(chain,[{type:'global',id:'*'},{type:'group',id:parent},{type:'group',id:child},{type:'group',id:grandchild},{type:'device',id:deviceId}],'the device chain sorts its groups from the outermost');
check(rules.deviceAlertChain(deviceId),[{type:'global',id:'*'},{type:'device',id:deviceId}],'a device without group: default, global, device');
check(rules.resolveAlertRules([],chain).cpu,{settings:{enabled:true,warning:80,critical:90,level:null,durationMinutes:5,recovery:5},origin:{type:'default'}},'default only');
const overrides=[override('cpu','global','*',{warning:70,critical:85,durationMinutes:2,recovery:3})];
check(rules.resolveAlertRules(overrides,chain).cpu,{settings:{enabled:true,warning:70,critical:85,level:null,durationMinutes:2,recovery:3},origin:{type:'global',id:'*'}},'global wins over default');
overrides.push(override('cpu','group',parent,{warning:60,critical:95}),override('cpu','group',child,{enabled:false,warning:50,critical:null}));
check(rules.resolveAlertRules(overrides,chain).cpu,{settings:{enabled:false,warning:50,critical:null,level:null,durationMinutes:null,recovery:null},origin:{type:'group',id:child}},'the innermost of three group levels wins as a whole');
overrides.push(override('cpu','group',grandchild,{warning:40,critical:45}));
check(rules.resolveAlertRules(overrides,chain).cpu.origin,{type:'group',id:grandchild},'the grandchild group wins');
overrides.push(override('cpu','device',deviceId,{warning:30,critical:null}));
check(rules.resolveAlertRules(overrides,chain).cpu,{settings:{enabled:true,warning:30,critical:null,level:null,durationMinutes:null,recovery:null},origin:{type:'device',id:deviceId}},'the device wins');
check(rules.resolveAlertRules(overrides,chain.slice(0,3)).cpu.origin,{type:'group',id:child},'a group view ends its chain at that group');
check(rules.resolveAlertRules(overrides,[{type:'global',id:'*'}]).cpu.origin,{type:'global',id:'*'},'All devices ends its chain at global');
check(rules.resolveAlertRules(overrides,rules.deviceAlertChain(deviceId)).cpu.origin,{type:'device',id:deviceId},'a device without group still sees its own override');
check(rules.resolveAlertRules(overrides.filter(row=>row.scopeType!=='device'),rules.deviceAlertChain(deviceId)).cpu.origin,{type:'global',id:'*'},'a device without group inherits from global');
check(rules.resolveAlertRules(overrides,chain).memory.origin,{type:'default'},'other rules stay at their default');
check(rules.effectiveAlertSettings(rules.resolveAlertRules(overrides,chain)).cpu,{enabled:true,warning:30,critical:null,level:null,durationMinutes:null,recovery:null},'effective settings per rule');

// ---- The customer level: default < global < customer < groups < device ----
const customerId='30000000-0000-4000-8000-000000000001',otherCustomer='30000000-0000-4000-8000-000000000002';
check(rules.alertScopeTypes,['global','customer','group','device'],'the scope types list customer after global');
check([rules.isAlertScopeType('customer'),rules.isAlertScopeType('tenant')],[true,false],'customer is a scope type');
const customerChain=rules.deviceAlertChain(deviceId,[{id:child,depth:1},{id:parent,depth:0}],customerId);
check(customerChain,[{type:'global',id:'*'},{type:'customer',id:customerId},{type:'group',id:parent},{type:'group',id:child},{type:'device',id:deviceId}],'with a customer id: global, customer, groups from the outermost, device');
check(rules.deviceAlertChain(deviceId,[{id:child,depth:1},{id:parent,depth:0}]),[{type:'global',id:'*'},{type:'group',id:parent},{type:'group',id:child},{type:'device',id:deviceId}],'without a customer id the chain is unchanged');
check([rules.deviceAlertChain(deviceId,[],null),rules.deviceAlertChain(deviceId,[],customerId)],[[{type:'global',id:'*'},{type:'device',id:deviceId}],[{type:'global',id:'*'},{type:'customer',id:customerId},{type:'device',id:deviceId}]],'a device without group, with and without a customer');
const levels=[override('memory','global','*',{warning:70,critical:80}),override('memory','customer',customerId,{warning:60,critical:75})];
check(rules.resolveAlertRules(levels,customerChain).memory,{settings:{enabled:true,warning:60,critical:75,level:null,durationMinutes:null,recovery:null},origin:{type:'customer',id:customerId}},'the customer wins over global; its origin is the customer');
check(rules.resolveAlertRules(levels,rules.deviceAlertChain(deviceId,[{id:parent,depth:0}])).memory.origin,{type:'global',id:'*'},'a chain without the customer ignores its override');
check(rules.resolveAlertRules([...levels,override('memory','group',parent,{warning:50,critical:65})],customerChain).memory.origin,{type:'group',id:parent},'a group of the customer wins over the customer');
check(rules.resolveAlertRules([...levels,override('memory','device',deviceId,{warning:40,critical:55})],customerChain).memory.origin,{type:'device',id:deviceId},'the device wins over the customer');
check(rules.resolveAlertRules([override('memory','global','*',{warning:70,critical:80}),override('memory','customer',otherCustomer,{warning:10,critical:20})],customerChain).memory.origin,{type:'global',id:'*'},'the override of another customer is ignored');
check(rules.resolveAlertRules(levels,customerChain.slice(0,2)).memory.origin,{type:'customer',id:customerId},'a customer view ends its chain at the customer');

// ---- Validation ----
// The threshold checks below give an alarm rule a valid minimum duration and margin unless the input names them.
const withAlarm=(ruleId,input)=>rules.isAlertRuleId(ruleId)&&rules.alarmSettingsApply(rules.alertRule(ruleId))&&!('durationMinutes' in input)&&!('recovery' in input)?{durationMinutes:0,recovery:0,...input}:input;
const valid=(ruleId,input)=>rules.validateAlertRuleSettings(ruleId,withAlarm(ruleId,input));
const codes=(ruleId,input)=>{const result=valid(ruleId,input);return result.ok?[]:result.errors.map(error=>`${error.field}:${error.code}`);};
check(valid('cpu',{enabled:true,warning:80,critical:90}),{ok:true,ruleId:'cpu',settings:{enabled:true,warning:80,critical:90,level:null,durationMinutes:0,recovery:0}},'defaults are valid');
check(codes('nope',{enabled:true}),['ruleId:unknown-rule'],'unknown rule');
check(codes('cpu',{enabled:true,warning:0,critical:90}),['warning:range'],'below range');
check(codes('cpu',{enabled:true,warning:80,critical:101}),['critical:range'],'above range');
check(codes('disk-free',{enabled:true,warning:100,critical:5}),['warning:range'],'disk-free up to 99');
check(codes('disk-latency',{enabled:true,warning:60001}),['warning:range'],'latency up to 60000 ms');
check(codes('signatures-age',{enabled:true,warning:366}),['warning:range'],'signatures up to 365 days');
check(codes('processor-queue',{enabled:true,warning:101}),['warning:range'],'queue up to 100');
check(codes('cpu',{enabled:true,warning:80.5,critical:90}),['warning:range'],'non-integer');
check(codes('cpu',{enabled:true,warning:'80',critical:90}),['warning:range'],'a string is no number');
check(codes('cpu',{enabled:true,warning:90,critical:80}),['critical:order'],'warning after critical for ≥ rules');
check(codes('cpu',{enabled:true,warning:85,critical:85}),['critical:order'],'equal values for ≥ rules');
check(codes('disk-free',{enabled:true,warning:5,critical:15}),['critical:orderBelow'],'warning after critical for disk-free');
check(codes('disk-free',{enabled:true,warning:10,critical:10}),['critical:orderBelow'],'equal values for disk-free');
check(valid('disk-free',{enabled:true,warning:20,critical:10}).ok,true,'disk-free warning above critical');
check(codes('cpu',{enabled:true,warning:null,critical:null}),['warning:required'],'no threshold on an enabled rule');
// The two new comparisons: an age within (crash-recent) and days remaining (os-support-end) need warning > critical.
check(codes('crash-recent',{enabled:true,warning:7,critical:30}),['critical:orderBelow'],'crash-recent: warning after critical');
check(codes('crash-recent',{enabled:true,warning:7,critical:7}),['critical:orderBelow'],'crash-recent: equal values');
check(codes('crash-recent',{enabled:true,warning:31,critical:7}),['warning:range'],'crash-recent up to 30 days');
check(codes('crash-recent',{enabled:true,warning:30,critical:0}),['critical:range'],'crash-recent from 1 day');
check(valid('crash-recent',{enabled:true,warning:14,critical:3}).ok,true,'crash-recent warning above critical');
check(valid('os-support-end',{enabled:true,warning:180,critical:0}),{ok:true,ruleId:'os-support-end',settings:{enabled:true,warning:180,critical:0,level:null,durationMinutes:null,recovery:null}},'os-support-end accepts 0 days (ended)');
check(codes('os-support-end',{enabled:true,warning:0,critical:30}),['critical:orderBelow'],'os-support-end: warning after critical');
check(codes('os-support-end',{enabled:true,warning:0,critical:0}),['critical:orderBelow'],'os-support-end: equal values');
check(codes('os-support-end',{enabled:true,warning:1826}),['warning:range'],'os-support-end up to 1825 days');
check(codes('os-support-end',{enabled:true,warning:-1}),['warning:range'],'os-support-end from 0 days');
check(valid('os-support-end',{enabled:true,warning:null,critical:0}).ok,true,'os-support-end critical only');
check(valid('cpu',{enabled:false,warning:null,critical:null}),{ok:true,ruleId:'cpu',settings:{enabled:false,warning:null,critical:null,level:null,durationMinutes:0,recovery:0}},'a disabled rule needs no threshold');
check(valid('cpu',{enabled:false,warning:70,critical:95}).settings,{enabled:false,warning:70,critical:95,level:null,durationMinutes:0,recovery:0},'a disabled rule keeps its values');
check(codes('cpu',{enabled:false,warning:95,critical:70}),['critical:order'],'kept values are still validated');
check(valid('processor-queue',{enabled:true,warning:null,critical:4}).ok,true,'only the critical step');
check(codes('cpu',{enabled:true,warning:80,critical:90,level:'warning'}),['level:not-allowed'],'level on a threshold rule');
check(codes('reboot-pending',{enabled:true,level:'critical',warning:5}),['warning:not-allowed'],'thresholds on a boolean rule');
check(codes('reboot-pending',{enabled:true,level:'severe'}),['level:level'],'unknown level');
check(codes('reboot-pending',{enabled:true}),['level:level'],'missing level');
check(valid('reboot-pending',{enabled:true,level:'info'}),{ok:true,ruleId:'reboot-pending',settings:{enabled:true,warning:null,critical:null,level:'info',durationMinutes:null,recovery:null}},'boolean rule with level');
check(codes('cpu',{enabled:'yes',warning:80,critical:90}),['enabled:enabled'],'enabled must be boolean');
check(codes('cpu',{warning:80,critical:90}),['enabled:enabled'],'enabled is required');
// The limit kind (battery-capacity): one threshold in warning, critical not allowed, a level required.
check(valid('battery-capacity',{enabled:true,warning:60,critical:null,level:'info'}),{ok:true,ruleId:'battery-capacity',settings:{enabled:true,warning:60,critical:null,level:'info',durationMinutes:null,recovery:null}},'limit: threshold and level');
check(codes('battery-capacity',{enabled:true,warning:null,level:'info'}),['warning:required'],'limit: threshold required when enabled');
check(codes('battery-capacity',{enabled:true,warning:0,level:'info'}),['warning:range'],'limit: from 1 %');
check(codes('battery-capacity',{enabled:true,warning:100,level:'info'}),['warning:range'],'limit: up to 99 %');
check(codes('battery-capacity',{enabled:true,warning:59.5,level:'info'}),['warning:range'],'limit: whole numbers only');
check(codes('battery-capacity',{enabled:true,warning:60,critical:30,level:'info'}),['critical:not-allowed'],'limit: no critical step');
check(codes('battery-capacity',{enabled:true,warning:60}),['level:level'],'limit: level required');
check(codes('battery-capacity',{enabled:true,warning:60,level:'severe'}),['level:level'],'limit: unknown level');
check(valid('battery-capacity',{enabled:false,warning:null,level:'critical'}).ok,true,'limit: a disabled rule needs no threshold');
// The new threshold rules use the shared ranges and orders.
check(codes('stability-low',{enabled:true,warning:11}),['warning:range'],'stability index up to 10');
check(codes('stability-low',{enabled:true,warning:3,critical:5}),['critical:orderBelow'],'stability: warning above critical');
check(codes('app-crash-repeated',{enabled:true,warning:101}),['warning:range'],'crashes up to 100');
check(codes('cert-expiring',{enabled:true,warning:366,critical:7}),['warning:range'],'certificates up to 365 days');
check(codes('cert-expiring',{enabled:true,warning:7,critical:30}),['critical:orderBelow'],'certificates: warning above critical');
check(valid('cert-expiring',{enabled:true,warning:30,critical:0}).ok,true,'certificates: critical 0 days (expired) is allowed');
// Minimum duration and recovery margin.
const alarm=(ruleId,input)=>{const result=rules.validateAlertRuleSettings(ruleId,input);return result.ok?result.settings:result.errors.map(error=>`${error.field}:${error.code}`);};
check(alarm('cpu',{enabled:true,warning:80,critical:90,durationMinutes:5,recovery:5}),{enabled:true,warning:80,critical:90,level:null,durationMinutes:5,recovery:5},'the defaults of an alarm rule are valid');
check(alarm('cpu',{enabled:true,warning:80,critical:90}),['durationMinutes:required','recovery:required'],'both are required');
check(alarm('cpu',{enabled:true,warning:80,critical:90,durationMinutes:1441,recovery:-1}),['durationMinutes:range','recovery:range'],'duration up to 1440 minutes, margin from 0');
check(alarm('cpu',{enabled:true,warning:80,critical:90,durationMinutes:1.5,recovery:'5'}),['durationMinutes:range','recovery:range'],'whole numbers only');
check(alarm('disk-latency',{enabled:true,warning:50,critical:60000,durationMinutes:1440,recovery:60001}),['recovery:range'],'the margin up to the range max of the rule');
check(alarm('cpu',{enabled:true,warning:80,critical:90,durationMinutes:0,recovery:80}),['recovery:recovery'],'at-least: the margin must be below the warning threshold');
check(alarm('cpu',{enabled:true,warning:null,critical:90,durationMinutes:0,recovery:89}).recovery,89,'without a warning step the critical threshold opens');
check(alarm('processor-queue',{enabled:true,warning:2,critical:null,durationMinutes:0,recovery:2}),['recovery:recovery'],'above: the margin must be below the threshold');
check(alarm('disk-free',{enabled:true,warning:95,critical:5,durationMinutes:0,recovery:6}),['recovery:recoverySum'],'disk-free: threshold plus margin above 100 %');
check(alarm('disk-free',{enabled:true,warning:95,critical:5,durationMinutes:0,recovery:5}).recovery,5,'disk-free: exactly 100 % is allowed');
check(alarm('cpu',{enabled:false,warning:null,critical:null,durationMinutes:3,recovery:50}).durationMinutes,3,'a disabled rule without thresholds keeps its alarm values');
check(alarm('reboot-pending',{enabled:true,level:'warning',durationMinutes:0,recovery:0}),['durationMinutes:not-allowed','recovery:not-allowed'],'a boolean rule rejects both fields');
check(alarm('device-offline',{enabled:true,warning:null,critical:15,durationMinutes:0}),['durationMinutes:not-allowed'],'Device offline rejects the duration');
check(alarm('crash-recent',{enabled:true,warning:30,critical:7,recovery:1}),['recovery:not-allowed'],'the age rules reject the margin');
check(alarm('device-offline',{enabled:true,warning:10,critical:15}),{enabled:true,warning:10,critical:15,level:null,durationMinutes:null,recovery:null},'Device offline with both steps');
check([alarm('device-offline',{enabled:true,critical:2}),alarm('device-offline',{enabled:true,critical:10081}),alarm('device-offline',{enabled:true,warning:20,critical:15})],[['critical:range'],['critical:range'],['critical:order']],'Device offline: 3 to 10080 minutes, warning before critical');

// ---- Description sentences and table values ----
const rule=id=>rules.alertRule(id);
const say=(id,settings,locale='en')=>text.alertRuleDescription(rule(id),{enabled:true,warning:null,critical:null,level:null,...settings},locale);
check(say('disk-free',{warning:15,critical:5}),'Warning when a volume has less than 15 % free space, critical below 5 %.','both thresholds');
check(say('disk-free',{warning:15,critical:5},'de'),'Warnung, wenn ein Datenträger weniger als 15 % frei hat, kritisch unter 5 %.','both thresholds (de)');
check(say('cpu',{warning:80}),'Warning when the CPU usage is 80 % or higher.','warning only');
check(say('cpu',{critical:90},'de'),'Kritisch, wenn die CPU-Auslastung 90 % oder mehr beträgt.','critical only (de)');
check(say('disk-latency',{warning:1500,critical:3000}),'Warning when the disk latency is 1,500 ms or higher, critical from 3,000 ms.','ms with grouping');
check(say('disk-latency',{warning:1500,critical:3000},'de'),'Warnung, wenn die Datenträgerlatenz 1.500 ms oder mehr beträgt, kritisch ab 3.000 ms.','ms with grouping (de)');
check(say('processor-queue',{warning:2}),'Warning when the processor queue has more than 2 threads per processor.','threads per processor');
check(say('signatures-age',{warning:7}),'Warning when the Defender signatures are older than 7 days.','days');
check(say('signatures-age',{warning:1,critical:30},'de'),'Warnung, wenn die Defender-Signaturen älter als 1 Tag sind, kritisch, wenn sie älter als 30 Tage sind.','days with plural (de)');
check(say('reboot-pending',{level:'info'}),'Info when Windows reports a pending restart.','boolean info');
check(say('firewall-off',{level:'warning'},'de'),'Warnung, wenn ein Profil der Windows-Firewall ausgeschaltet ist.','boolean warning (de)');
check(say('inventory-incomplete',{level:'critical'}),'Critical when the agent could not collect part of the inventory.','boolean critical');
check(say('crash-recent',{warning:30,critical:7}),'Warning when the device crashed in the last 30 days, critical when it crashed in the last 7 days.','crash-recent both');
check(say('crash-recent',{warning:30,critical:7},'de'),'Warnung, wenn das Gerät in den letzten 30 Tagen abgestürzt ist, kritisch, wenn es in den letzten 7 Tagen abgestürzt ist.','crash-recent both in the dative (de)');
check(say('os-support-end',{warning:180,critical:30},'de'),'Warnung, wenn der Sicherheitssupport des Betriebssystems in 180 Tagen oder weniger endet, kritisch, wenn noch 30 Tage oder weniger bleiben.','os-support-end: dative warning, nominative critical (de)');
check(say('crash-recent',{warning:1},'de'),'Warnung, wenn das Gerät in den letzten 1 Tag abgestürzt ist.','crash-recent warning only (de)');
check(say('os-support-end',{warning:180,critical:0}),'Warning when the security support of the operating system ends in 180 days or less, critical once it has ended.','os-support-end bothEnded');
check(say('os-support-end',{warning:180,critical:0},'de'),'Warnung, wenn der Sicherheitssupport des Betriebssystems in 180 Tagen oder weniger endet, kritisch, sobald er beendet ist.','os-support-end bothEnded (de)');
check(say('os-support-end',{warning:180,critical:30}),'Warning when the security support of the operating system ends in 180 days or less, critical when 30 days or less remain.','os-support-end both');
check(say('os-support-end',{critical:0}),'Critical once the security support of the operating system has ended.','os-support-end criticalOnlyEnded');
check(say('os-support-end',{critical:30}),'Critical when 30 days or less of security support remain.','os-support-end criticalOnly');
check(say('os-support-end',{warning:90}),'Warning when the security support of the operating system ends in 90 days or less.','os-support-end warning only');
check(say('bitlocker-system-unencrypted',{level:'warning'}),'Warning when the system drive is not encrypted with BitLocker.','bitlocker system');
check(say('bitlocker-suspended',{level:'warning'},'de'),'Warnung, wenn der BitLocker-Schutz auf einem Laufwerk angehalten ist.','bitlocker suspended (de)');
check(say('bitlocker-no-recovery-password',{level:'info'}),'Info when an encrypted drive has no recovery password.','bitlocker recovery');
// The twelve health signal 2 rules.
check(say('device-problem',{level:'warning'}),'Warning when a device in Device Manager reports an error.','device-problem');
check(say('driver-unsigned',{level:'info'},'de'),'Info, wenn ein Treiber nicht signiert ist.','driver-unsigned (de)');
check(say('stability-low',{warning:5}),'Warning when the stability index is below 5.','stability warning only');
check(say('stability-low',{warning:5,critical:3},'de'),'Warnung, wenn der Stabilitätsindex unter 5 liegt, kritisch unter 3.','stability both (de)');
check(say('app-crash-repeated',{warning:3}),'Warning when a program crashes 3 times or more in 7 days.','app crashes');
check(say('app-crash-repeated',{critical:5},'de'),'Kritisch, wenn ein Programm in 7 Tagen 5-mal oder öfter abstürzt.','app crashes critical only (de)');
check(say('ssd-wear',{warning:80,critical:95}),'Warning when a disk is 80 % or more worn, critical at 95 % or more.','ssd wear');
check(say('ssd-wear',{warning:80,critical:95},'de'),'Warnung, wenn ein Datenträger zu 80 % oder mehr verschlissen ist, kritisch ab 95 %.','ssd wear (de)');
check(say('disk-health-failed',{level:'critical'}),'Critical when a disk reports an error state.','disk health');
check(say('disk-errors',{level:'warning'},'de'),'Warnung, wenn das System-Ereignisprotokoll Datenträgerfehler der letzten 30 Tage enthält.','disk errors (de)');
check([say('battery-capacity',{warning:60,level:'info'}),say('battery-capacity',{warning:60,level:'warning'}),say('battery-capacity',{warning:50,level:'critical'})],['Info when a battery has less than 60 % of its design capacity.','Warning when a battery has less than 60 % of its design capacity.','Critical when a battery has less than 50 % of its design capacity.'],'limit: one sentence per level');
check(say('battery-capacity',{warning:60,level:'info'},'de'),'Info, wenn ein Akku weniger als 60 % seiner Designkapazität hat.','limit (de)');
check(say('cert-expiring',{warning:30,critical:7}),'Warning when a certificate with a private key expires in 30 days or less, critical when 7 days or less remain or it has expired.','cert both');
check(say('cert-expiring-no-key',{warning:30,critical:7},'de'),'Warnung, wenn ein Zertifikat ohne privaten Schlüssel in 30 Tagen oder weniger abläuft, kritisch, wenn noch 7 Tage oder weniger bleiben oder es abgelaufen ist.','cert without key both (de)');
check(say('cert-expiring',{warning:30}),'Warning when a certificate with a private key expires in 30 days or less.','cert warning only');
check(say('autostart-new',{level:'info'}),'Info when a new autostart entry is not confirmed.','autostart new');
check(say('autostart-new-suspicious',{level:'warning'},'de'),'Warnung, wenn ein neuer unsignierter Autostart-Eintrag oder einer aus einem Benutzerordner nicht bestätigt ist.','autostart suspicious (de)');
check(text.alertRuleDescription(rule('cert-expiring-no-key'),rule('cert-expiring-no-key').defaults,'en'),'This rule is turned off. It produces no issues.','cert-expiring-no-key is off by default');
check([text.formatAlertThreshold(rule('stability-low'),5,'en'),text.formatAlertThreshold(rule('app-crash-repeated'),3,'en'),text.formatAlertThreshold(rule('app-crash-repeated'),1500,'de'),text.formatAlertThreshold(rule('battery-capacity'),60,'en')],['5','3','1.500','60 %'],'index and count are plain numbers');
check(say('os-support-unknown',{level:'info'},'de'),'Info, wenn Nodiverna das Supportende des Betriebssystems nicht kennt.','os support unknown (de)');
check(text.alertRuleDescription(rule('cpu'),{enabled:false,warning:80,critical:90,level:null},'en'),'This rule is turned off. It produces no issues.','disabled');
check(text.alertRuleDescription(rule('cpu'),{enabled:false,warning:80,critical:90,level:null},'de'),'Diese Regel ist ausgeschaltet. Sie erzeugt keine Hinweise.','disabled (de)');
check([text.formatAlertThreshold(rule('cpu'),80,'en'),text.formatAlertThreshold(rule('disk-latency'),50,'en'),text.formatAlertThreshold(rule('signatures-age'),7,'en'),text.formatAlertThreshold(rule('processor-queue'),2,'en'),text.formatAlertThreshold(rule('device-offline'),1,'en'),text.formatAlertThreshold(rule('device-offline'),15,'de')],['80 %','50 ms','7 days','2 threads per processor','1 minute','15 Minuten'],'threshold cells with unit');
// Device offline sentences.
check(say('device-offline',{critical:15}),'Critical when the device has sent no Heartbeat for 15 minutes or longer.','offline critical only');
check(say('device-offline',{warning:10,critical:60},'de'),'Warnung, wenn das Gerät seit 10 Minuten keinen Heartbeat gesendet hat, kritisch ab 60 Minuten.','offline both (de)');
check(say('device-offline',{warning:5}),'Warning when the device has sent no Heartbeat for 5 minutes or longer.','offline warning only');
// The column Alarm: minimum duration and recovery margin.
const alarmText=(id,durationMinutes,recovery,locale='en')=>text.alertAlarmSummary(rule(id),{enabled:true,warning:80,critical:90,level:null,durationMinutes,recovery},locale);
check([alarmText('cpu',5,5),alarmText('cpu',5,0),alarmText('disk-free',0,2),alarmText('cpu',0,0),alarmText('disk-latency',1,10)],['After 5 minutes, recovery 5 %','After 5 minutes','Immediately, recovery 2 %','Immediately','After 1 minute, recovery 10 ms'],'Alarm summaries');
check([alarmText('cpu',5,5,'de'),alarmText('processor-queue',5,0,'de'),alarmText('disk-free',0,2,'de'),alarmText('cpu',0,0,'de')],['Nach 5 Minuten, Erholung 5 %','Nach 5 Minuten','Sofort, Erholung 2 %','Sofort'],'Alarm summaries (de)');
check([text.alertAlarmSummary(rule('reboot-pending'),rule('reboot-pending').defaults,'en'),text.alertAlarmSummary(rule('device-offline'),rule('device-offline').defaults,'en'),text.alertAlarmSummary(rule('crash-recent'),rule('crash-recent').defaults,'en')],[null,null,null],'no Alarm summary for boolean rules, Device offline and the age rules');
check(text.alertSettingsSummary(rule('cpu'),{enabled:true,warning:80,critical:90,level:null},'en'),'Warning 80 %, critical 90 %','summary');
check(text.alertSettingsSummary(rule('defender-off'),{enabled:true,warning:null,critical:null,level:'critical'},'de'),'Kritisch','boolean summary');
check(text.alertSettingsSummary(rule('cpu'),{enabled:false,warning:80,critical:90,level:null},'en'),'Off','disabled summary');
// Every rule's default description renders without a placeholder left.
for(const item of rules.alertRules)for(const locale of ['en','de']){const sentence=text.alertRuleDescription(item,item.defaults,locale);assert.doesNotMatch(sentence,/\{\w+\}/,`${item.id} ${locale}`);assert.match(sentence,/\.$/,`${item.id} ${locale} is a full sentence`);checks++;}
// ---- Microsoft Defender rules of agent 4.14.0 ----
check(say('threat-detected',{level:'critical'}),'Critical when Defender reports an active threat.','threat-detected (en)');
check(say('threat-detected',{level:'warning'},'de'),'Warnung, wenn Defender eine aktive Bedrohung meldet.','threat-detected (de)');
check(say('scan-age',{warning:7}),'Warning when the last Defender scan is older than 7 days.','scan-age warning only (en)');
check(say('scan-age',{warning:7,critical:30},'de'),'Warnung, wenn der letzte Defender-Scan älter als 7 Tage ist, kritisch, wenn er älter als 30 Tage ist.','scan-age both (de)');
check(say('scan-age',{critical:14}),'Critical when the last Defender scan is older than 14 days.','scan-age critical only (en)');
check(say('defender-off',{level:'warning'}),'Warning when Defender antivirus or real-time protection is turned off. A passive Defender next to another antivirus does not count.','the changed defender-off (en)');
check(say('defender-off',{level:'info'},'de'),'Info, wenn der Defender-Virenschutz oder der Echtzeitschutz ausgeschaltet ist. Ein passiver Defender neben einem anderen Virenschutz zählt nicht.','the changed defender-off (de)');
for(const level of ['info','warning','critical'])for(const catalog of [en,de])assert.ok(/passive|passiver/i.test(catalog['alertRules.rule.defenderOff.'+level]),`defender-off ${level} names the passive case`);
check([0,1,365,366].map(warning=>rules.validateAlertRuleSettings('scan-age',{enabled:true,warning,critical:null,durationMinutes:0,recovery:0}).ok),[false,true,true,false],'scan-age accepts 1–365 days');
// ---- Windows activation rules of agent 4.22.0 ----
check([rule('windows-evaluation').defaults.durationMinutes,rule('windows-evaluation').defaults.recovery,rules.alarmSettingsApply(rule('windows-evaluation'))],[null,null,false],'windows-evaluation has no alarm settings');
check(rule('windows-evaluation').dative,['warning'],'windows-evaluation uses the dative for the warning step');
const evaluationInput=(warning,critical)=>({enabled:true,warning,critical});
check(rules.validateAlertRuleSettings('windows-evaluation',evaluationInput(180,14)),{ok:true,ruleId:'windows-evaluation',settings:{enabled:true,warning:180,critical:14,level:null,durationMinutes:null,recovery:null}},'windows-evaluation accepts warning above critical');
check(rules.validateAlertRuleSettings('windows-evaluation',evaluationInput(14,180)),{ok:false,errors:[{field:'critical',code:'orderBelow'}]},'warning 14, critical 180 is refused');
check(rules.validateAlertRuleSettings('windows-evaluation',evaluationInput(14,14)).ok,false,'warning equal to critical is refused');
check(rules.validateAlertRuleSettings('windows-evaluation',evaluationInput(366,14)),{ok:false,errors:[{field:'warning',code:'range'}]},'366 days is out of range');
check([0,365].map(critical=>rules.validateAlertRuleSettings('windows-evaluation',{enabled:true,warning:null,critical}).ok),[true,true],'0 and 365 are in range');
check(rules.validateAlertRuleSettings('windows-evaluation',{enabled:true,warning:180,critical:14,durationMinutes:5}),{ok:false,errors:[{field:'durationMinutes',code:'not-allowed'}]},'no minimum duration');
check(rules.validateAlertRuleSettings('windows-not-activated',{enabled:true,level:'critical'}).ok,true,'windows-not-activated takes a level');
check(say('windows-evaluation',{warning:180,critical:14}),'Warning when the Windows evaluation ends in 180 days or less, critical when 14 days or less remain.','windows-evaluation both (en)');
check(say('windows-evaluation',{warning:180,critical:14},'de'),'Warnung, wenn die Windows-Evaluierung in 180 Tagen oder weniger endet, kritisch, wenn noch 14 Tage oder weniger bleiben.','windows-evaluation both: dative warning, nominative critical (de)');
check(say('windows-evaluation',{warning:180,critical:0}),'Warning when the Windows evaluation ends in 180 days or less, critical once it has ended.','windows-evaluation bothEnded (en)');
check(say('windows-evaluation',{warning:180,critical:0},'de'),'Warnung, wenn die Windows-Evaluierung in 180 Tagen oder weniger endet, kritisch, sobald sie beendet ist.','windows-evaluation bothEnded (de)');
check(say('windows-evaluation',{warning:30}),'Warning when the Windows evaluation ends in 30 days or less.','windows-evaluation warning only (en)');
check(say('windows-evaluation',{warning:1},'de'),'Warnung, wenn die Windows-Evaluierung in 1 Tag oder weniger endet.','windows-evaluation warning only, singular (de)');
check(say('windows-evaluation',{critical:14}),'Critical when 14 days or less of the Windows evaluation remain.','windows-evaluation critical only (en)');
check(say('windows-evaluation',{critical:14},'de'),'Kritisch, wenn von der Windows-Evaluierung noch 14 Tage oder weniger bleiben.','windows-evaluation critical only (de)');
check([say('windows-evaluation',{critical:0}),say('windows-evaluation',{critical:0},'de')],['Critical once the Windows evaluation has ended.','Kritisch, sobald die Windows-Evaluierung beendet ist.'],'windows-evaluation criticalOnlyEnded');
check(['info','warning','critical'].map(level=>say('windows-not-activated',{level})),['Info when Windows is not activated.','Warning when Windows is not activated.','Critical when Windows is not activated.'],'windows-not-activated levels (en)');
check(['info','warning','critical'].map(level=>say('windows-not-activated',{level},'de')),['Info, wenn Windows nicht aktiviert ist.','Warnung, wenn Windows nicht aktiviert ist.','Kritisch, wenn Windows nicht aktiviert ist.'],'windows-not-activated levels (de)');
check([text.alertRuleName('windows-evaluation','en'),text.alertRuleName('windows-evaluation','de'),text.alertRuleName('windows-not-activated','en'),text.alertRuleName('windows-not-activated','de')],['Evaluation edition','Evaluierungsversion','Windows not activated','Windows nicht aktiviert'],'the two rule names');
console.log(`PASS alert rule catalog (${checks} checks): 41 rules with defaults and ranges, the limit kind, the units count and index, minimum duration and recovery margin, resolution over global, three group levels and device, validation, and description sentences with units in English and German.`);
