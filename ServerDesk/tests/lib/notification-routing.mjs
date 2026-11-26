// Routing of notification events (lib/server/notifications/notification-routing.ts) and the message
// builder (lib/server/notifications/notification-message.ts) without a database: levels and events,
// the origins All devices, customer (only with several customers) and nested groups, one
// delivery per channel for overlapping rules, disabled rules and channels, muted
// alarms, the customer maintenance window (inside, edge minutes, across midnight,
// the DST change in Europe/Berlin, another weekday), not-notified escalations
// and closes, no-rule, the content and bundling of messages, and the logo of the email HTML.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const routing=await import('../../lib/server/notifications/notification-routing.ts');
const message=await import('../../lib/server/notifications/notification-message.ts');
const {routeEvent,inMaintenanceWindow,matchingChannels}=routing;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const at=Date.UTC(2026,9,21,10,0);// Wednesday
const rule=(id,changes={})=>({id,scopeType:'all',scopeId:'*',channelId:'mail',levels:['warning','critical'],onOpen:true,onClose:true,onEscalate:true,enabled:true,channelEnabled:true,...changes});
const context=(changes={})=>({mutedUntil:null,maintenanceWindow:null,customerId:'cust-a',multipleCustomers:true,groupIds:['g-child','g-parent'],notifiedChannels:new Set(),...changes});
const event=(changes={})=>({kind:'open',level:'critical',occurredAt:at,...changes});

// ---- Levels, events and origins ----
{
 check(routeEvent(event(),[rule('r1')],context()),{status:'routed',channelIds:['mail']},'a matching All devices rule');
 check(routeEvent(event({level:'info'}),[rule('r1')],context()),{status:'suppressed',reason:'no-rule'},'the level is not chosen');
 check(routeEvent(event(),[rule('r1',{onOpen:false})],context()),{status:'suppressed',reason:'no-rule'},'the event is not chosen');
 const customer=rule('c',{scopeType:'customer',scopeId:'cust-a',channelId:'teams'});
 check(routeEvent(event(),[customer],context()),{status:'routed',channelIds:['teams']},'a rule of the device customer with several customers');
 check(routeEvent(event(),[customer],context({multipleCustomers:false})),{status:'suppressed',reason:'no-rule'},'customer rules apply only once a second customer exists');
 check(routeEvent(event(),[rule('c2',{scopeType:'customer',scopeId:'cust-b'})],context()),{status:'suppressed',reason:'no-rule'},'another customer');
 check(routeEvent(event(),[rule('g',{scopeType:'group',scopeId:'g-parent',channelId:'hook'})],context()),{status:'routed',channelIds:['hook']},'a rule of an ancestor group');
 check(routeEvent(event(),[rule('g',{scopeType:'group',scopeId:'g-other'})],context()),{status:'suppressed',reason:'no-rule'},'a group the device is not in');
 // Additive along the chain, one delivery per channel.
 const rules=[rule('a',{levels:['critical'],onClose:false}),rule('b',{scopeType:'group',scopeId:'g-child',levels:['info'],onOpen:false}),rule('c',{scopeType:'customer',scopeId:'cust-a',channelId:'teams'})];
 check(routeEvent(event(),rules,context()),{status:'routed',channelIds:['mail','teams']},'rules of all origins add up');
 check(matchingChannels(event({kind:'open',level:'critical'}),[rule('x'),rule('y',{scopeType:'group',scopeId:'g-child'})],context()),['mail'],'a channel matched twice gets one delivery');
 check(matchingChannels(event({kind:'close',level:'info'}),rules,context()),['mail'],'union of levels and events per channel');
 // Disabled.
 check(routeEvent(event(),[rule('r',{enabled:false})],context()),{status:'suppressed',reason:'no-rule'},'a disabled rule matches nothing');
 check(routeEvent(event(),[rule('r',{channelEnabled:false})],context()),{status:'suppressed',reason:'no-rule'},'a disabled channel matches nothing');
}

// ---- Mute, not-notified ----
{
 check(routeEvent(event(),[rule('r')],context({mutedUntil:at+60_000})),{status:'suppressed',reason:'muted'},'a muted alarm');
 check(routeEvent(event(),[rule('r')],context({mutedUntil:at})),{status:'routed',channelIds:['mail']},'a mute that ended at the event');
 check(routeEvent(event({kind:'close'}),[rule('r')],context()),{status:'suppressed',reason:'not-notified'},'a close of an alarm nobody was told about');
 check(routeEvent(event({kind:'escalate'}),[rule('r')],context({notifiedChannels:new Set(['teams'])})),{status:'suppressed',reason:'not-notified'},'an escalation only goes to channels that got the alarm');
 check(routeEvent(event({kind:'close'}),[rule('r'),rule('t',{channelId:'teams'})],context({notifiedChannels:new Set(['mail'])})),{status:'routed',channelIds:['mail']},'a close goes to the notified channel only');
 check(routeEvent(event({kind:'close'}),[],context({notifiedChannels:new Set(['mail'])})),{status:'suppressed',reason:'no-rule'},'a notified channel whose rule is gone');
}

// ---- Maintenance window ----
{
 const window={days:[3],start:'09:30',durationMinutes:60,timeZone:'UTC'};
 check([inMaintenanceWindow(window,Date.UTC(2026,9,21,9,30)),inMaintenanceWindow(window,Date.UTC(2026,9,21,10,29)),inMaintenanceWindow(window,Date.UTC(2026,9,21,10,30)),inMaintenanceWindow(window,Date.UTC(2026,9,21,9,29))],[true,true,false,false],'the start minute is inside, the end minute is not');
 check(inMaintenanceWindow(window,Date.UTC(2026,9,22,9,45)),false,'another weekday');
 check(routeEvent(event(),[rule('r')],context({maintenanceWindow:window})),{status:'suppressed',reason:'maintenance-window'},'an event in the window');
 const night={days:[7],start:'22:00',durationMinutes:240,timeZone:'Europe/Berlin'};
 // Sunday 2026-10-18 22:00 CEST = 20:00 UTC; the window reaches Monday 02:00 local.
 check([inMaintenanceWindow(night,Date.UTC(2026,9,18,20,0)),inMaintenanceWindow(night,Date.UTC(2026,9,18,23,30)),inMaintenanceWindow(night,Date.UTC(2026,9,18,23,59)),inMaintenanceWindow(night,Date.UTC(2026,9,19,0,0))],[true,true,true,false],'a window across midnight in the customer zone');
 check(inMaintenanceWindow(night,Date.UTC(2026,9,19,20,30)),false,'Monday night is not in a Sunday window');
 // DST end in Europe/Berlin: Sunday 2026-10-25, 03:00 CEST becomes 02:00 CET.
 const dst={days:[7],start:'01:00',durationMinutes:180,timeZone:'Europe/Berlin'};
 // 01:00 CEST = 23:00 UTC Saturday; 180 real minutes end at 02:00 UTC (03:00 CET).
 check([inMaintenanceWindow(dst,Date.UTC(2026,9,24,23,0)),inMaintenanceWindow(dst,Date.UTC(2026,9,25,1,59)),inMaintenanceWindow(dst,Date.UTC(2026,9,25,2,0)),inMaintenanceWindow(dst,Date.UTC(2026,9,24,22,59))],[true,true,false,false],'the DST end keeps the window at its real length');
 // DST start: Sunday 2026-03-29, 02:00 CET becomes 03:00 CEST.
 const spring={days:[7],start:'01:30',durationMinutes:60,timeZone:'Europe/Berlin'};
 check([inMaintenanceWindow(spring,Date.UTC(2026,2,29,0,30)),inMaintenanceWindow(spring,Date.UTC(2026,2,29,1,29)),inMaintenanceWindow(spring,Date.UTC(2026,2,29,1,30))],[true,true,false],'the DST start: 01:30 CET plus 60 minutes');
 check(inMaintenanceWindow({...window,timeZone:'Nowhere/Unknown'},Date.UTC(2026,9,21,9,45)),false,'an unknown zone never matches');
 check(inMaintenanceWindow(null,at),false,'no window');
}

// ---- Message content and bundling ----
{
 const entry=(index,changes={})=>({eventId:`e${String(index).padStart(3,'0')}`,kind:'open',alertId:`a${index}`,level:'warning',device:{id:`d${index%5}`,name:`WEB0${index%5}`},customer:{id:'c1',name:'Contoso',timeZone:'Europe/Berlin'},ruleId:'disk-free',key:'disk-C:',value:7,threshold:10,closeReason:null,occurredAt:at+index*1000,...changes});
 const single=message.notificationMessage([entry(1,{level:'critical'})],'en','https://portal.example.test');
 check([single.event,single.subject],['alert.open','[Critical] Free disk space on WEB01'],'a single message names level, rule and device');
 check(single.entries[0].facts,['Opened','Level: Critical','Device: WEB01','Customer: Contoso','Alarm: Free disk space','Value: 7 %','Threshold: 10 %','Time: 2026-10-21T10:00:01.000Z (Oct 21, 2026, 12:00 PM, Europe/Berlin)'],'the facts of an entry');
 check(single.entries[0].url,'https://portal.example.test/#device/d1/monitoring','the link to the alarms of the device (Monitoring › Alarms)');
 check([message.alarmHistoryUrl('https://portal.example.test/','a/b'),message.auditLogUrl('https://portal.example.test//')],['https://portal.example.test/#device/a%2Fb/monitoring','https://portal.example.test/#settings/audit'],'the alarm history opens Monitoring › Alarms of the device; the audit log is a settings page');
 const closed=message.notificationMessage([entry(2,{kind:'close',closeReason:'no-data',customer:null})],'de','https://portal.example.test');
 check([closed.event,closed.subject,closed.entries[0].facts[0],closed.entries[0].facts.some(fact=>fact.startsWith('Kunde'))],['alert.close','Warnung-Alarm auf WEB02 geschlossen: Freier Speicherplatz','Geschlossen: Keine Daten',false],'a close in German without customer');
 const boolean=message.notificationMessage([entry(3,{ruleId:'reboot-pending',key:'reboot',value:null,threshold:null})],'en','https://portal.example.test');
 check(boolean.entries[0].facts.filter(fact=>/^(Value|Threshold)/.test(fact)),[],'a boolean rule has no value and threshold');
 const many=Array.from({length:30},(_,index)=>entry(index+1,{level:index%7===0?'critical':'warning'}));
 const bundle=message.notificationMessage(many,'en','https://portal.example.test');
 check([bundle.event,bundle.subject,bundle.entries.length,bundle.more],['alert.bundle','30 alarm changes on 5 devices',25,5],'30 events: 25 entries and "and 5 more"');
 check(bundle.entries.slice(0,5).map(item=>item.json.level),['critical','critical','critical','critical','critical'],'the most severe first');
 check(message.mailText(bundle).includes('and 5 more'),true,'the text names the rest');
 check(message.notificationMessage([entry(5),entry(10)],'en','https://portal.example.test').subject,'2 alarm changes on WEB00','a bundle of one device names it');
 const json=message.webhookPayload(bundle,'delivery-1',at,'https://portal.example.test');
 check(Object.keys(json.entries[0]),['event','alertId','level','device','customer','rule','key','value','threshold','unit','closeReason','occurredAt','url'],'the webhook fields per entry');
 const card=message.teamsPayload(single);
 check([card.type,card.attachments[0].contentType,card.attachments[0].content.type],['message','application/vnd.microsoft.card.adaptive','AdaptiveCard'],'the Teams card shape');
 const html=message.mailHtml(message.notificationMessage([entry(4,{device:{id:'d4',name:'<b>x</b>'}})],'en','https://portal.example.test'));
 check(html.includes('<b>x</b>'),false,'the HTML part escapes names');
 // The email logo (docs/branding.md): an escaped <img alt=""> before the h1 with a logoUrl, no image without one; the text part stays.
 const plainContent=message.notificationMessage([entry(4)],'en','https://portal.example.test');
 const logoUrl='https://portal.example.test/api/branding/portal/light?v=0123456789abcdef&x="1"';
 const withLogo=message.mailHtml(plainContent,logoUrl),withoutLogo=message.mailHtml(plainContent);
 check(withLogo.includes('<img src="https://portal.example.test/api/branding/portal/light?v=0123456789abcdef&amp;x=&quot;1&quot;" alt="" height="32" style="display:block;height:32px;max-width:200px;border:0;margin:0 0 12px"><h1'),true,'the escaped logo right before the h1');
 check([withoutLogo.includes('<img'),message.mailHtml(plainContent,null).includes('<img')],[false,false],'no logo URL, no image');
 check(withLogo.replace(/<img [^>]*>/,''),withoutLogo,'the rest of the HTML is unchanged');
 check(message.mailText(plainContent).includes('<img'),false,'the text part has no logo');
 const test=message.testMessage('de','https://portal.example.test',at);
 check([test.event,test.subject,test.note],['test','Testnachricht von Nodiverna','Das ist ein Test. Benachrichtigungen von https://portal.example.test erreichen diesen Kanal. Zeit: 2026-10-21T10:00:00.000Z'],'the test message has no alarm data');
}

console.log(`PASS notification routing (${checks} checks): levels, events, origins incl. customer with several customers and nested groups, one delivery per channel, disabled rules and channels, mute, maintenance window incl. midnight and DST, not-notified, no-rule, message content and bundling.`);
