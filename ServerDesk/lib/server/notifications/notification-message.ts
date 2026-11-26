// The content of a notification (docs/notifications.md): pure, no server
// imports, so the tests build it without a database. One entry is one alarm
// event; one entry gives a single message, two or more a bundle ("N alarm
// changes") that lists at most 25 entries (Discord: 10), most severe first, plus "and N more".
// The texts come from the server catalog (notifyMessage.* in en-server.ts and
// de-server.ts) in the language of the channel. A message carries only the
// fields below: never device tokens, secrets, snapshot data other than the
// value, IP addresses, the names of people who muted or acknowledged, or query strings.
// The one exception is the emergency message (emergencyMessage): it names the
// account that used the emergency access and the client address it came from,
// so the Owners can judge the sign-in. It never carries a password, token,
// session or factor.
import {consoleRouteHash} from '../../console-route';
import {alertRule,isAlertRuleId,type AlertLevel,type AlertRule} from '../../alert-rules';
import {formatAlertThreshold} from '../../alert-rules-text';
import {formatDateTime,formatNumber} from '../../i18n/format';
import type {Locale} from '../../i18n/locale';
import {translate,type MessageKey,type MessageParams} from '../../i18n/translate';

export type NotificationEventKind='open'|'escalate'|'close';
export type NotificationCloseReason='recovered'|'rule-off'|'no-data';
export type NotificationEntry={
 eventId:string;kind:NotificationEventKind;alertId:string;level:AlertLevel;
 device:{id:string;name:string};
 /** Only once a second customer exists; timeZone is the customer's zone if set. */
 customer:{id:string;name:string;timeZone:string|null}|null;
 ruleId:string;key:string;value:number|null;threshold:number|null;closeReason:NotificationCloseReason|null;occurredAt:number;
};
export type NotificationEvent='alert.open'|'alert.escalate'|'alert.close'|'alert.bundle'|'test'|'emergency';
/** One rendered entry: its heading, its fact lines, the link to the alarm history (the audit log for an emergency sign-in), its level, kind and ISO time. */
export type RenderedEntry={heading:string;facts:string[];url:string;level:AlertLevel;kind:NotificationEventKind|'emergency';occurredAt:string;json:Record<string,unknown>};
export type NotificationContent={
 event:NotificationEvent;
 /** Email subject and title of the Teams card. */
 subject:string;
 entries:RenderedEntry[];
 /** Entries that the bundle does not list. */
 more:number;
 /** The sentence of a test message; null for alarm messages. */
 note:string|null;
 locale:Locale;
};

/** At most this many entries in one bundle. */
export const bundleEntryLimit=25;
const rank:Record<AlertLevel,number>={info:0,warning:1,critical:2};
const levelKey:Record<AlertLevel,MessageKey>={info:'alertRules.level.info',warning:'alertRules.level.warning',critical:'alertRules.level.critical'};
const reasonKey:Record<NotificationCloseReason,MessageKey>={recovered:'alarms.reason.recovered','rule-off':'alarms.reason.ruleOff','no-data':'alarms.reason.noData'};
const ruleOf=(id:string):AlertRule|null=>isAlertRuleId(id)?alertRule(id):null;
const isoTime=(time:number)=>new Date(time).toISOString();
/** The link to the device's alarms, Monitoring › Alarms (#device/<id>/monitoring). */
export const alarmHistoryUrl=(origin:string,deviceId:string)=>`${origin.replace(/\/+$/,'')}/${consoleRouteHash({view:'device',deviceId,deviceSection:'monitoring'})}`;
const valueText=(rule:AlertRule|null,value:number,locale:Locale)=>rule&&rule.kind!=='boolean'?formatAlertThreshold(rule,value,locale):formatNumber(locale,value);

/** Most severe first, then the newest first, then by event ID. */
export function orderEntries(entries:readonly NotificationEntry[]):NotificationEntry[]{
 return [...entries].sort((a,b)=>rank[b.level]-rank[a.level]||b.occurredAt-a.occurredAt||(a.eventId<b.eventId?-1:a.eventId>b.eventId?1:0));
}

function renderEntry(entry:NotificationEntry,locale:Locale,origin:string):RenderedEntry{
 const t=(key:MessageKey,params?:MessageParams)=>translate(locale,key,params);
 const rule=ruleOf(entry.ruleId),ruleName=rule?t(rule.name):entry.ruleId,level=t(levelKey[entry.level]);
 const boolean=!rule||rule.kind==='boolean';
 const heading=entry.kind==='close'?t('notifyMessage.subject.closed',{level,device:entry.device.name,rule:ruleName}):t('notifyMessage.subject.single',{level,device:entry.device.name,rule:ruleName});
 const facts=[
  entry.kind==='close'?t('notifyMessage.event.close',{reason:t(reasonKey[entry.closeReason??'recovered'])}):t(entry.kind==='open'?'notifyMessage.event.open':'notifyMessage.event.escalate'),
  t('notifyMessage.level',{level}),
  t('notifyMessage.device',{device:entry.device.name}),
  ...(entry.customer?[t('notifyMessage.customer',{customer:entry.customer.name})]:[]),
  t('notifyMessage.rule',{rule:ruleName}),
  ...(!boolean&&entry.value!==null?[t('notifyMessage.value',{value:valueText(rule,entry.value,locale)})]:[]),
  ...(!boolean&&entry.threshold!==null?[t('notifyMessage.threshold',{threshold:valueText(rule,entry.threshold,locale)})]:[]),
  entry.customer?.timeZone?t('notifyMessage.timeZoned',{utc:isoTime(entry.occurredAt),local:formatDateTime(locale,entry.occurredAt,{timeZone:entry.customer.timeZone,dateStyle:'medium',timeStyle:'short'}),zone:entry.customer.timeZone}):t('notifyMessage.time',{utc:isoTime(entry.occurredAt)}),
 ];
 const url=alarmHistoryUrl(origin,entry.device.id);
 const unit=rule&&rule.kind!=='boolean'?rule.unit:null;
 return {heading,facts,url,level:entry.level,kind:entry.kind,occurredAt:isoTime(entry.occurredAt),json:{
  event:entry.kind,alertId:entry.alertId,level:entry.level,device:{id:entry.device.id,name:entry.device.name},
  customer:entry.customer?{id:entry.customer.id,name:entry.customer.name}:null,rule:{id:entry.ruleId,name:ruleName},key:entry.key,
  value:boolean?null:entry.value,threshold:boolean?null:entry.threshold,unit,closeReason:entry.closeReason,occurredAt:isoTime(entry.occurredAt),url,
 }};
}

/**
 * The message of the entries in the channel language: one entry is a single
 * message with its own subject ("[Critical] Disk space low on WEB01"), two or
 * more a bundle ("12 alarm changes on 5 devices") with at most `limit` entries,
 * most severe first.
 */
export function notificationMessage(entries:readonly NotificationEntry[],locale:Locale,origin:string,limit=bundleEntryLimit):NotificationContent{
 if(!entries.length)throw new Error('A notification needs at least one entry.');
 const ordered=orderEntries(entries),shown=ordered.slice(0,Math.max(1,limit)).map(entry=>renderEntry(entry,locale,origin));
 if(ordered.length===1){const entry=ordered[0];return {event:`alert.${entry.kind}`,subject:shown[0].heading,entries:shown,more:0,note:null,locale};}
 const devices=new Set(ordered.map(entry=>entry.device.id)).size;
 const subject=devices===1?translate(locale,'notifyMessage.subject.bundleOneDevice',{count:ordered.length,device:ordered[0].device.name}):translate(locale,'notifyMessage.subject.bundle',{count:ordered.length,devices});
 return {event:'alert.bundle',subject,entries:shown,more:ordered.length-shown.length,note:null,locale};
}
/** The test message: "Test message from Nodiverna", the portal and the time, no alarm data. */
export function testMessage(locale:Locale,portal:string,time:number):NotificationContent{
 return {event:'test',subject:translate(locale,'notifyMessage.test.title'),entries:[],more:0,note:`${translate(locale,'notifyMessage.test.body',{portal})} ${translate(locale,'notifyMessage.time',{utc:isoTime(time)})}`,locale};
}

/** An emergency sign-in (docs/entra-id.md): the account as it was at the sign-in, its time and client address ('unknown' without one). */
export type EmergencySignIn={account:string;occurredAt:number;address:string};
/** The link to the audit log of the portal (#settings/audit). */
export const auditLogUrl=(origin:string)=>`${origin.replace(/\/+$/,'')}/${consoleRouteHash({view:'settings',page:'audit'})}`;
/**
 * The emergency message: "Emergency access was used in <portal>", the account,
 * the exact time (UTC), the client address, what to do, and the link to the
 * audit log. One critical entry; it is never bundled with alarms.
 */
export function emergencyMessage(locale:Locale,portal:string,origin:string,signIn:EmergencySignIn):NotificationContent{
 const t=(key:MessageKey,params?:MessageParams)=>translate(locale,key,params);
 const heading=t('notification.emergency.heading',{portal}),url=auditLogUrl(origin),occurredAt=isoTime(signIn.occurredAt);
 const facts=[t('notification.emergency.account',{name:signIn.account}),t('notification.emergency.time',{time:occurredAt}),t('notification.emergency.address',{address:signIn.address}),t('notification.emergency.action')];
 return {event:'emergency',subject:heading,entries:[{heading,facts,url,level:'critical',kind:'emergency',occurredAt,json:{event:'emergency',level:'critical',account:signIn.account,address:signIn.address,occurredAt,url}}],more:0,note:null,locale};
}

// ---- Channel formats -----------------------------------------------------------

const escapeHtml=(text:string)=>text.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]!);
// Adaptive Card text is Markdown; device and rule names stay literal.
const escapeMarkdown=(text:string)=>text.replace(/([\\`*_[\]()#+\-!>~|])/g,'\\$1');

/** The plain text body of an email. */
export function mailText(content:NotificationContent):string{
 const t=(key:MessageKey,params?:MessageParams)=>translate(content.locale,key,params);
 const blocks=content.entries.map(entry=>[entry.heading,...entry.facts,`${t('notifyMessage.openLink')}: ${entry.url}`].join('\n'));
 if(content.more)blocks.push(t('notifyMessage.more',{count:content.more}));
 return [content.subject,'',...(content.note?[content.note]:[]),blocks.join('\n\n')].join('\n').trim()+'\n';
}
/** The HTML part of an email: the same content, escaped. */
/**
 * The email HTML. logoUrl (the portal light logo, portalEmailLogoUrl in lib/server/branding.ts) puts the logo above
 * the heading; without it the message has no image.
 */
export function mailHtml(content:NotificationContent,logoUrl:string|null=null):string{
 const t=(key:MessageKey,params?:MessageParams)=>translate(content.locale,key,params);
 const entries=content.entries.map(entry=>`<h2 style="font-size:15px;margin:16px 0 4px">${escapeHtml(entry.heading)}</h2><p style="margin:0">${entry.facts.map(escapeHtml).join('<br>')}<br><a href="${escapeHtml(entry.url)}">${escapeHtml(t('notifyMessage.openLink'))}</a></p>`).join('');
 return `<!doctype html><html lang="${content.locale}"><body style="font-family:sans-serif;font-size:14px">${logoUrl?`<img src="${escapeHtml(logoUrl)}" alt="" height="32" style="display:block;height:32px;max-width:200px;border:0;margin:0 0 12px">`:''}<h1 style="font-size:17px">${escapeHtml(content.subject)}</h1>${content.note?`<p>${escapeHtml(content.note)}</p>`:''}${entries}${content.more?`<p>${escapeHtml(t('notifyMessage.more',{count:content.more}))}</p>`:''}</body></html>`;
}
/** The Teams Workflow payload: one Adaptive Card. */
export function teamsPayload(content:NotificationContent):Record<string,unknown>{
 const t=(key:MessageKey,params?:MessageParams)=>translate(content.locale,key,params);
 const body:Record<string,unknown>[]=[{type:'TextBlock',text:escapeMarkdown(content.subject),weight:'Bolder',size:'Medium',wrap:true}];
 if(content.note)body.push({type:'TextBlock',text:escapeMarkdown(content.note),wrap:true});
 for(const entry of content.entries){
  body.push({type:'TextBlock',text:escapeMarkdown(entry.heading),weight:'Bolder',wrap:true,separator:true,spacing:'Medium'});
  body.push({type:'TextBlock',text:entry.facts.map(escapeMarkdown).join('\n\n'),wrap:true,spacing:'Small'});
  body.push({type:'ActionSet',actions:[{type:'Action.OpenUrl',title:t('notifyMessage.openLink'),url:entry.url}]});
 }
 if(content.more)body.push({type:'TextBlock',text:escapeMarkdown(t('notifyMessage.more',{count:content.more})),isSubtle:true,wrap:true});
 return {type:'message',attachments:[{contentType:'application/vnd.microsoft.card.adaptive',contentUrl:null,content:{$schema:'http://adaptivecards.io/schemas/adaptive-card.json',type:'AdaptiveCard',version:'1.4',body}}]};
}
/** The webhook JSON body. */
export function webhookPayload(content:NotificationContent,deliveryId:string,time:number,portal:string):Record<string,unknown>{
 if(content.event==='test')return {event:'test',deliveryId,sentAt:isoTime(time),portal,message:content.subject,note:content.note};
 return {event:content.event,deliveryId,sentAt:isoTime(time),portal,title:content.subject,entries:content.entries.map(entry=>entry.json),more:content.more};
}

// ---- Discord -------------------------------------------------------------------

/**
 * The limits of one Discord webhook message: at most 10 embeds, a title of 256
 * and a description of 4096 characters, a content of 2000 characters, and 6000
 * characters over all embed titles and descriptions together.
 */
export const discordLimits={embeds:10,title:256,description:4096,content:2000,embedTotal:6000} as const;
/**
 * The embed colors: the dark-mode values of --sd-danger, --sd-warn and
 * --sd-success and the accent, because Discord shows a dark theme by default.
 * They are message data, not UI styling.
 */
export const discordColors={accent:0x5B5CF6,critical:0xFF7A6E,warning:0xE7B553,info:0x5B5CF6,closed:0x4CCF96} as const;
export type DiscordEmbed={title:string;description:string;color:number;url?:string;timestamp?:string};
export type DiscordPayload={content?:string;embeds:DiscordEmbed[];allowed_mentions:{parse:string[]}};
// Discord Markdown: device, customer and rule names stay literal.
const escapeDiscord=(text:string)=>text.replace(/([\\*_~`|>#\-[\]()])/g,'\\$1');
/** Cuts an escaped text to `max` characters ending with "…", without a broken escape or surrogate pair. */
export function cutText(text:string,max:number):string{
 if(text.length<=max)return text;
 let cut=text.slice(0,max-1);
 if(/[\uD800-\uDBFF]$/.test(cut))cut=cut.slice(0,-1);
 if((/\\*$/.exec(cut)?.[0].length??0)%2)cut=cut.slice(0,-1);
 return cut+'…';
}
const embedColor=(entry:RenderedEntry)=>entry.kind==='close'?discordColors.closed:discordColors[entry.level];
/**
 * The Discord webhook body: embeds, mentions turned off (an @everyone in a
 * device name pings no one), no user name and no avatar. A test message and a
 * single alarm are one embed without content; a bundle has the subject (and
 * "and N more") as content and one embed per shown entry, in the bundle order.
 */
export function discordPayload(content:NotificationContent):DiscordPayload{
 const allowed_mentions={parse:[] as string[]};
 const title=(text:string)=>cutText(escapeDiscord(text),discordLimits.title);
 const description=(text:string)=>cutText(escapeDiscord(text),discordLimits.description);
 if(content.event==='test')return {embeds:[{title:title(content.subject),description:description(content.note??''),color:discordColors.accent}],allowed_mentions};
 const embeds=content.entries.slice(0,discordLimits.embeds).map(entry=>({title:title(entry.heading),url:entry.url,description:description(entry.facts.join('\n')),color:embedColor(entry),timestamp:entry.occurredAt}));
 if(content.event!=='alert.bundle')return {embeds,allowed_mentions};
 const more=content.more?`\n${escapeDiscord(translate(content.locale,'notifyMessage.more',{count:content.more}))}`:'';
 return {content:cutText(escapeDiscord(content.subject),discordLimits.content-more.length)+more,embeds,allowed_mentions};
}
/** The characters of all embed titles and descriptions together (Discord allows 6000). */
export const discordEmbedLength=(payload:DiscordPayload)=>payload.embeds.reduce((sum,embed)=>sum+embed.title.length+embed.description.length,0);
