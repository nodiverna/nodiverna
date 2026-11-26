// Settings → Notifications (ui/settings/notifications-panel.tsx) and the Notifications
// tab (ui/devices/monitoring/notification-rules.tsx) rendered with React SSR: the channel
// table, the drawer fields per type (Discord included) with the stored-secret placeholder, the
// one-time signing secret, the text of a failed test, the delivery log states,
// the rules tab on All devices, a group and a customer with direct and inherited
// sections, the device rules with their description line and no notice on sample devices,
// the place of the RulesTable doc comment, blocked reasons, empty states, demo blocking, and the wiring into
// the settings navigator, the scope tabs, the palette and the help, the email
// Sign-in pick list with the fields of each sign-in, Save blocked
// from the first render while a drawer is invalid, and the tables that scroll
// inside their wrap on narrow screens. No browser, no server.
import {mock} from '../../support/register.mjs';
// The real package; the mock below only renders dialogs in place, because
// React's static renderer leaves portals empty and the Drawer uses one.
import * as radix from 'radix-ui';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {buttons} from '../../support/blocked-buttons.mjs';
const h=React.createElement;
mock('radix-ui',{...radix,Dialog:{...radix.Dialog,Portal:({children})=>children}});
const panel=await import('../../../ui/settings/notifications-panel.tsx');
const rules=await import('../../../ui/devices/monitoring/notification-rules.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {ApiError}=await import('../../../ui/base/http.ts');
const {message}=await import('../../../ui/base/api.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
const capabilities=await import('../../../ui/base/access-capabilities.ts');
const route=await import('../../../lib/console-route.ts');
const navModel=await import('../../../ui/shell/nav-model.ts');
const scopeTabs=await import('../../../ui/devices/fleet/fleet-scope.ts');
const help=await import('../../../ui/shell/help-panel.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const noop=()=>{};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=value=>value.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const rowsOf=html=>[...html.matchAll(/<tbody>(.*?)<\/tbody>/gs)].flatMap(match=>[...match[1].matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map(row=>row[1]));
const cellsOf=row=>[...row.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map(match=>text(match[1]));
const t=locale=>(key,params)=>translate(locale,key,params);
const escapeRegExp=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// The kit Field: the texts a control names through aria-describedby (its hint and its error).
const describedText=(html,id)=>{
 const control=html.match(new RegExp(`<(?:input|textarea|select)[^>]*id="${escapeRegExp(id)}"[^>]*>`))?.[0]??'';
 const refs=(control.match(/aria-describedby="([^"]+)"/)?.[1]??'').split(' ').filter(Boolean);
 return refs.map(ref=>text(html.match(new RegExp(`<(small|p) id="${escapeRegExp(ref)}"[^>]*>(.*?)</\\1>`))?.[2]??'')).join(' ');
};

// ---- Channel table ----
const smtp={id:'c1',type:'smtp',name:'Ops mail',enabled:true,language:'en',config:{auth:'password',host:'smtp.example.test',port:587,tls:'starttls',from:'alerts@example.com',recipients:['a@example.com','b@example.com'],username:'mailer'},secretSet:true,targetHint:'2 recipients via smtp.example.test:587',revision:3,ruleCount:2,lastDelivery:{at:Date.UTC(2026,9,21,9,0),status:'sent'}};
const hook={id:'c2',type:'webhook',name:'Ops hook',enabled:false,language:'de',config:{},secretSet:false,targetHint:'https://hooks.example.test/…',revision:0,ruleCount:0,lastDelivery:null};
const discord={id:'c4',type:'discord',name:'Ops Discord',enabled:true,language:'en',config:{},secretSet:false,targetHint:'https://discord.com/…',revision:2,ruleCount:1,lastDelivery:null};
const teams={id:'c3',type:'teams',name:'Ops Teams',enabled:true,language:'en',config:{},secretSet:false,targetHint:'https://contoso.webhook.office.com/…',revision:1,ruleCount:0,lastDelivery:{at:Date.UTC(2026,9,21,8,0),status:'failed'}};
const heads=html=>[...html.matchAll(/<th scope="col"[^>]*>(?:<button[^>]*>)?(?:<span class="sr-only">)?([^<]*)</g)].map(match=>text(match[1]));
{
 const menu=()=>[{id:'test',label:'Send test message',onSelect:noop},{id:'edit',label:'Edit',onSelect:noop}];
 const html=render(h(panel.ChannelsTable,{channels:[smtp,teams,hook],loadedAt:Date.UTC(2026,9,21,10,0),menu}));
 ok(/^<div class="sdx-table-wrap sdx-notification-channels" role="region" aria-label="Notification channels"[^>]*><table class="sdx-table sdx-data-table">/.test(html),'a kit DataTable labelled nav.settings.notificationChannels');
 check(heads(html),['Name','Type','Target','Status','Last delivery','Actions'],'the columns, the menu column with a hidden label');
 check([...html.matchAll(/aria-label="(\w[\w ]*): sort (?:ascending|descending)"/g)].map(match=>match[1]),['Name','Type','Status','Last delivery'],'Name, Type, Status and Last delivery sort');
 ok(/<th scope="col" aria-sort="ascending"><button type="button" class="sdx-sort active" aria-label="Name: sort descending">/.test(html),'the default sort is Name ascending');
 const rows=rowsOf(html).map(cellsOf);
 check(rows.map(row=>row.slice(0,5)),[
  ['Ops hook','Webhook','https://hooks.example.test/…','Off','None yet'],
  ['Ops mail','Email (SMTP)','2 recipients via smtp.example.test:587','On','Sent 1 h ago'],
  ['Ops Teams','Microsoft Teams','https://contoso.webhook.office.com/…','On','Failed 2 h ago'],
 ],'name, type, masked target, status and last delivery, sorted by name');
 ok(/<span class="mono">2 recipients via smtp.example.test:587<\/span>/.test(html),'the target is .mono');
 check(panel.sortChannels([smtp,teams,hook],{column:'status',direction:'asc'},t('en')).map(channel=>channel.id),['c1','c3','c2'],'Status ascending: On first, ties keep their order');
 check(panel.sortChannels([hook,smtp,teams],{column:'lastDelivery',direction:'desc'},t('en')).map(channel=>channel.id),['c1','c3','c2'],'Last delivery descending: newest first, never last');
 check(panel.sortChannels([smtp,hook,teams],{column:'type',direction:'asc'},t('en')).map(channel=>channel.id),['c1','c3','c2'],'Type by its label');
 const german=render(h(panel.ChannelsTable,{channels:[smtp],loadedAt:Date.UTC(2026,9,21,10,0),menu}),'de');
 check(cellsOf(rowsOf(german)[0]).slice(1,4),['E-Mail (SMTP)','2 Empfänger über smtp.example.test:587','Ein'],'German row');
 ok(html.includes('aria-label="Actions for Ops mail"'),'the row menu names the channel');
 const empty=render(h(panel.ChannelsTable,{channels:[],loadedAt:0,menu,onAdd:noop}));
 ok(text(empty).includes('No channels yet')&&text(empty).includes('Add a channel to send alarms by email, Teams, Discord or webhook.'),'the empty state');
 ok(/<tr class="sdx-table-empty">.*<button[^>]*>.*<span>Add channel<\/span><\/button>/.test(empty),'the empty row is Empty with the action Add channel');
 const withDiscord=render(h(panel.ChannelsTable,{channels:[discord],loadedAt:Date.UTC(2026,9,21,10,0),menu}));
 check(cellsOf(rowsOf(withDiscord)[0]).slice(0,3),['Ops Discord','Discord','https://discord.com/…'],'a Discord row with its type name');
 ok(/<span class="sdx-notification-type"><svg[^>]*lucide-message-circle[^>]*>/.test(withDiscord),'the Discord type shows the MessageCircle icon');
 const {MessageCircle}=await import('lucide-react');
 check([panel.channelTypeIcons.discord===MessageCircle,panel.channelTypeKeys.discord,[...panel.channelTypeOrder]],[true,'notifications.type.discord',['smtp','teams','discord','webhook']],'the Discord icon, key and place');
 const source=readFileSync('ui/settings/notifications-panel.tsx','utf8');
 ok(/cards entranceId="notification-channels"/.test(source),'cards and an entranceId');
 ok(/\{id:'test',label:t\('notifications\.menu\.test'\)[\s\S]*\{id:'edit'[\s\S]*\{id:'enable'[\s\S]*\{id:'rotate'[\s\S]*\{id:'separator',separator:true\},\n  \{id:'delete',[^\n]*danger:true/.test(source),'the row menu keeps its entries and order: test, edit, on/off, rotate (webhook), separator, delete (danger)');
}

// ---- Drawer fields per type ----
{
 // The drawer owns the form state (useChannelDraft); a small host gives the form its own.
 const FormHost=({channel,start})=>h(panel.ChannelForm,{formId:'f',channel,busy:false,onSubmit:noop,form:panel.useChannelDraft(channel,start)});
 const form=(channel,start)=>render(h(FormHost,{channel,start}));
 const created=form(null);
 ok(/role="radiogroup"/.test(created)&&['Email (SMTP)','Microsoft Teams','Discord','Webhook'].every(label=>created.includes(label)),'create offers the type pick list');
 const pickList=/<div class="sdx-pick-list" role="radiogroup"[^>]*>(.*?)<\/div><\/div>/s.exec(created)?.[1]??'';
 check([...pickList.matchAll(/role="radio"/g)].length,4,'four pick rows');
 check(['Email (SMTP)','Microsoft Teams','Discord','Webhook'].map(label=>pickList.indexOf(label)).every((position,index,all)=>position>=0&&(index===0||position>all[index-1])),true,'the order: Email, Teams, Discord, Webhook');
 for(const label of ['Name','SMTP server','Port','Encryption','Sender','Recipients','Username','Password','Language of messages','On'])ok(text(created).includes(label),`SMTP field ${label}`);
 ok(created.includes('None (no sign-in possible)')&&created.includes('Separate up to 20 addresses with commas.'),'encryption options and the recipient hint');
 ok(/type="checkbox" role="switch"/.test(created),'the switch On');
 const editSmtp=form(smtp);
 ok(!/aria-labelledby="f-type"/.test(editSmtp),'edit has no type pick list');
 ok(/type="password"[^>]*placeholder="A value is saved. Leave the field empty to keep it."/.test(editSmtp),'a stored password shows the placeholder');
 ok(editSmtp.includes('value="smtp.example.test"')&&editSmtp.includes('>a@example.com, b@example.com</textarea>'),'the stored settings');
 ok(!editSmtp.includes('value="secret'),'no password value');
 const editHook=form(hook);
 ok(/Webhook URL/.test(editHook)&&/placeholder="A value is saved. Leave the field empty to keep it."/.test(editHook)&&/value=""/.test(editHook),'a stored URL is never shown');
 ok(editHook.includes('Nodiverna signs every request with the signing secret.'),'the webhook hint');
 const editTeams=form(teams);
 ok(editTeams.includes('Workflow URL')&&editTeams.includes('Copy the URL from the Teams workflow “When a Teams webhook request is received”.'),'the Teams field and hint');
 const newDiscord=form(null,{draft:{type:'discord'}});
 ok(newDiscord.includes('Webhook URL')&&newDiscord.includes('In Discord, open Server Settings → Integrations → Webhooks and choose Copy Webhook URL.')&&newDiscord.includes('placeholder="https://discord.com/api/webhooks/…"'),'the Discord field, hint and placeholder');
 const newDiscordDe=render(h(FormHost,{channel:null,start:{draft:{type:'discord'}}}),'de');
 ok(newDiscordDe.includes('Webhook-URL')&&newDiscordDe.includes('Öffne in Discord Servereinstellungen → Integrationen → Webhooks und wähle „Webhook-URL kopieren“.'),'the German Discord field and hint');
 const editDiscord=form(discord);
 ok(/placeholder="A value is saved. Leave the field empty to keep it."/.test(editDiscord)&&/value=""/.test(editDiscord)&&editDiscord.includes('In Discord, open Server Settings'),'a stored Discord URL shows the placeholder');
 const badDiscord=form(null,{draft:{type:'discord',name:'D',url:'https://example.com/x'},shown:['url']});
 ok(/class="sdx-field-error"[^>]*>Enter a Discord webhook URL, for example https:\/\/discord.com\/api\/webhooks\/…\./.test(badDiscord)&&/aria-invalid="true"/.test(badDiscord),'a wrong Discord URL shows its error under the field');
 const wrongType=form(null,{draft:{type:'webhook',name:'W',url:'https://discord.com/api/webhooks/1/x'},shown:['url']});
 ok(/class="sdx-field-error"[^>]*>This is a Discord webhook URL. Add a channel of the type Discord for it\./.test(wrongType),'a Discord URL in a webhook shows the hint to the Discord type');
 const errors=form(null,{submitted:true});
 ok(/class="sdx-field-error"[^>]*>Enter a name with 1 to 80 characters\./.test(errors)&&/aria-invalid="true"/.test(errors),'field errors after the first submit');
 ok(!/sdx-field-error|aria-invalid/.test(created),'a new form shows no field error on open');
 const base={type:'smtp',name:'X',enabled:true,language:'en',auth:'password',host:'smtp.example.test',port:'587',tls:'none',from:'a@example.com',recipients:'b@example.com',username:'user',password:'',tenantId:'',clientId:'',clientSecret:'',serviceAccountKey:'',url:''};
 check(panel.channelDraftErrors(base,{url:false}),{username:'notifications.error.username'},'no credentials without encryption');
 check(panel.channelDraftErrors({...base,tls:'starttls',recipients:Array.from({length:21},(_,i)=>`r${i}@example.com`).join(',')},{url:false}),{recipients:'notifications.error.recipients'},'at most 20 recipients');
 check(panel.channelDraftErrors({...base,type:'webhook',url:'http://example.com'},{url:false}),{url:'notifications.error.url'},'https only');
 check(panel.channelDraftErrors({...base,type:'webhook',url:''},{url:true}),{},'an empty URL keeps the stored one');
 check(panel.channelBody({...base,tls:'starttls'},smtp),{action:'update',id:'c1',revision:3,name:'X',enabled:true,language:'en',auth:'password',host:'smtp.example.test',port:587,tls:'starttls',from:'a@example.com',recipients:['b@example.com'],username:'user'},'an empty password is left out of the update');
 check(panel.channelBody({...base,type:'teams',url:''},teams),{action:'update',id:'c3',revision:1,name:'X',enabled:true,language:'en'},'an empty URL is left out');
 // Discord: the shared URL rule (lib/discord-webhook-url.ts), the same as the server.
 const discordDraft={...base,type:'discord',url:'https://discord.com/api/webhooks/123/tok_en-1'};
 check(panel.channelDraftErrors(discordDraft,{url:false}),{},'a valid Discord URL');
 check(panel.channelDraftErrors({...discordDraft,url:'https://example.com/x'},{url:false}),{url:'notifications.error.discordUrl'},'a URL that is no Discord webhook');
 for(const url of ['https://discord.com:8443/api/webhooks/1/x',' https://discord.com:443/api/webhooks/1/x','https://discord.com/api/webhooks/1/x/slack','https://example.com/api/webhooks/1/x'])check(panel.channelDraftErrors({...discordDraft,url},{url:false}),{url:'notifications.error.discordUrl'},`the client refuses ${url}`);
 check(panel.channelDraftErrors({...discordDraft,url:''},{url:true}),{},'an empty Discord URL keeps the stored one');
 check(panel.channelDraftErrors({...discordDraft,url:''},{url:false}),{url:'notifications.error.discordUrl'},'a new Discord channel needs a URL');
 for(const type of ['webhook','teams'])check(panel.channelDraftErrors({...discordDraft,type},{url:false}),{url:'notifications.error.discordUrlWrongType'},`a ${type} with a Discord URL`);
 check(panel.channelDraftErrors({...discordDraft,type:'webhook',url:'https://hooks.example.test/in'},{url:false}),{},'another webhook URL stays valid');
 check(panel.channelBody(discordDraft,null),{action:'create',type:'discord',name:'X',enabled:true,language:'en',url:'https://discord.com/api/webhooks/123/tok_en-1'},'create sends type and URL');
 const source=readFileSync('ui/settings/notifications-panel.tsx','utf8'),server=readFileSync('lib/server/notifications/notification-channels.ts','utf8');
 ok(source.includes("from '@/lib/discord-webhook-url'")&&server.includes("from '../../discord-webhook-url'"),'client and server import the one URL rule');
 ok(/^'use client';\r?\n\/\/ The page Settings → Notification channels[^\n]*\n(?:\/\/[^\n]*\n){0,3}\/\/[^\n]*Discord/.test(source),'the file header names Discord');
}

// ---- Save blocked while invalid, from the first render ----
// A blocked Save stays focusable (aria-disabled, no native disabled) and names its reason through aria-describedby.
const saveOf=html=>{const button=buttons(html).find(entry=>/type="submit"/.test(entry.attributes));return {blocked:!!button?.blocked&&!button.disabled,reason:button?.description??null};};
const fieldErrors=html=>[...html.matchAll(/class="sdx-field-error"[^>]*>([^<]*)</g)].map(match=>match[1]);
{
 const drawer=(channel,start)=>render(h(panel.ChannelDrawer,{channel,busy:false,onClose:noop,onSave:noop,start}));
 const created=drawer(null);
 check([saveOf(created),fieldErrors(created),/aria-invalid/.test(created)],[{blocked:true,reason:'Fill in the required fields first.'},[],false],'Add channel: Save blocked at once, no field error yet');
 const createdDe=render(h(panel.ChannelDrawer,{channel:null,busy:false,onClose:noop,onSave:noop}),'de');
 check(saveOf(createdDe).reason,'Fülle zuerst die Pflichtfelder aus.','the German reason');
 const nameLeft=drawer(smtp,{draft:{name:''},shown:['name']});
 check([saveOf(nameLeft),fieldErrors(nameLeft)],[{blocked:true,reason:'Correct the marked fields first.'},['Enter a name with 1 to 80 characters.']],'the name changed to empty and left: its error shows and the reason changes');
 const errorId=nameLeft.match(/<p id="([^"]+)" class="sdx-field-error">Enter a name/)?.[1];
 ok(errorId&&new RegExp(`<input[^>]*maxLength="80"[^>]*aria-describedby="${errorId}"[^>]*aria-invalid="true"`).test(nameLeft),'the kit Field marks the input and describes it by its error');
 const onlyName=drawer(null,{draft:{name:''},shown:['name']});
 check([fieldErrors(onlyName),saveOf(onlyName).reason],[['Enter a name with 1 to 80 characters.'],'Correct the marked fields first.'],'only the left field shows its error; untouched fields stay quiet');
 check(saveOf(drawer(smtp,{draft:{name:'Ops mail 2'},shown:['name']})),{blocked:false,reason:null},'the error goes away when the field is valid');
 check([saveOf(drawer(smtp)),saveOf(drawer(hook)),saveOf(drawer(teams)),fieldErrors(drawer(smtp))],[{blocked:false,reason:null},{blocked:false,reason:null},{blocked:false,reason:null},[]],'a valid stored channel opens with Save active (stored secrets count as set)');
 const broken=drawer(smtp,{draft:{port:'0'},shown:['port']});
 check([saveOf(broken).blocked,fieldErrors(broken).length],[true,1],'a value that becomes invalid blocks Save');
 check(saveOf(drawer(null,{submitted:true})).reason,'Correct the marked fields first.','after a submit every error shows');
 // The marks: an error shows once the field was changed and then left.
 const none={changed:new Set(),shown:new Set()};
 check([...panel.markLeft(none,'name').shown],[],'leaving an untouched field shows nothing');
 const typed=panel.markChanged(none,['name']);
 check([[...typed.changed],[...typed.shown]],[['name'],[]],'a change alone shows nothing yet');
 const left=panel.markLeft(typed,'name');
 check([[...left.shown],panel.markLeft(left,'name')===left,panel.markChanged(left,['name'])===left],[['name'],true,true],'change, then blur: the error shows and stays on');
 check([...panel.markShown(none,['username','password']).shown],['username','password'],'a choice can show dependent fields at once');
 check(panel.shownErrors({name:'notifications.error.name',host:'notifications.error.host'},new Set(['name']),false),{name:'notifications.error.name'},'only shown fields');
 check(panel.shownErrors({name:'notifications.error.name',host:'notifications.error.host'},new Set(),true),{name:'notifications.error.name',host:'notifications.error.host'},'all after a submit');
 check([panel.saveBlockedKey({},{}),panel.saveBlockedKey({name:'notifications.error.name'},{}),panel.saveBlockedKey({name:'notifications.error.name'},{name:'notifications.error.name'})],[null,'notifications.blocked.incomplete','alertRules.blocked.invalid'],'the reason of the blocked Save');
 // The drawer form never sends while invalid, also with Enter (the submit handler checks).
 const source=readFileSync('ui/settings/notifications-panel.tsx','utf8');
 ok(/const submit=\(event:FormEvent\)=>\{event\.preventDefault\(\);form\.submit\(\);if\(!form\.invalid&&!busy\)onSubmit/.test(source)&&/onBlur:\(\)=>form\.leave\(name\)/.test(source),'the form refuses an invalid submit and marks a field on blur');
}

// ---- Email sign-in: Password, Microsoft 365, Google Workspace ----
{
 const FormHost=({channel,start})=>h(panel.ChannelForm,{formId:'f',channel,busy:false,onSubmit:noop,form:panel.useChannelDraft(channel,start)});
 const form=(channel,start,locale)=>render(h(FormHost,{channel,start}),locale);
 const signInOf=html=>/<span class="sdx-field-label" id="f-auth">[^<]*<\/span><div class="sdx-pick-list" role="radiogroup" aria-labelledby="f-auth">(.*?)<\/div><\/div>/s.exec(html)?.[1]??'';
 const radios=html=>[...signInOf(html).matchAll(/<button type="button" role="radio" aria-checked="(true|false)"[^>]*>(.*?)<\/button>/gs)].map(match=>({checked:match[1]==='true',text:text(match[2])}));
 const created=form(null);
 check(radios(created),[
  {checked:true,text:'Password Sign in with a username and password, or with an app password. This works with any SMTP server.'},
  {checked:false,text:'Microsoft 365 Nodiverna sends through Microsoft Graph with an app registration. You need no password.'},
  {checked:false,text:'Google Workspace Nodiverna sends through Gmail with a service account. You need no password.'},
 ],'three Sign-in radios in order with hints, Password selected on create');
 const nameAt=created.indexOf('id="f-name"'),signInAt=created.indexOf('id="f-auth"'),hostAt=created.indexOf('id="f-host"');
 check([nameAt>0,signInAt>nameAt,hostAt>signInAt],[true,true,true],'Sign-in sits right after Name, before the server fields');
 check([...signInOf(created).matchAll(/class="sdx-pick-icon"><svg[^>]*lucide-([a-z0-9-]+)/g)].map(match=>match[1]),['key-round','layout-grid','file-key'],'one icon per sign-in: KeyRound, LayoutGrid, FileKey, in this order');
 const {KeyRound,LayoutGrid,FileKey}=await import('lucide-react');
 check([new Set(Object.values(panel.smtpAuthIcons)).size,panel.smtpAuthIcons.password===KeyRound,panel.smtpAuthIcons.microsoft365===LayoutGrid,panel.smtpAuthIcons.google===FileKey],[3,true,true,true],'smtpAuthIcons holds three different icons');
 ok(describedText(created,'f-password').startsWith('If the account uses multifactor authentication')&&created.includes('If the account uses multifactor authentication, enter an app password, or choose Microsoft 365 or Google Workspace.'),'the password field has the app password hint');
 ok(!/sdx-notification-mode-enter/.test(created),'no fade on the first render');
 ok(!/role="radiogroup" aria-labelledby="f-auth"/.test(form(null,{draft:{type:'webhook'}})),'other types have no Sign-in');
 const german=form(null,undefined,'de');
 ok(german.includes('Anmeldung')&&radios(german).map(radio=>radio.text.split(' ')[0]).join(',')==='Passwort,Microsoft,Google','the German Sign-in');
 // Microsoft 365.
 const ms=form(null,{draft:{auth:'microsoft365'}});
 check(radios(ms).map(radio=>radio.checked),[false,true,false],'Microsoft 365 selected');
 for(const id of ['host','port','tls','username','password'])ok(!ms.includes(`id="f-${id}"`),`Microsoft 365 hides ${id}`);
 ok(ms.includes('Copy the values from the app registration in Microsoft Entra ID. The app needs the application permission Mail.Send with admin consent.'),'the Microsoft 365 block hint');
 ok(describedText(ms,'f-from')==='Enter an existing mailbox of your organization. The messages come from this address.'&&ms.includes('Enter an existing mailbox of your organization. The messages come from this address.'),'the sender mailbox hint');
 ok(/<div class="sdx-notification-pair sdx-notification-pair-even">.*?Tenant ID.*?Application \(client\) ID.*?<\/div>/s.test(ms),'Tenant ID and Application (client) ID as a pair');
 ok(/<input id="f-clientSecret"[^>]*type="password"[^>]*autoComplete="new-password"/i.test(ms)&&!/id="f-clientSecret"[^>]*placeholder=/.test(ms),'Client secret is a password field without the stored placeholder on create');
 check([ms.indexOf('id="f-from"')<ms.indexOf('id="f-recipients"'),ms.indexOf('id="f-recipients"')<ms.indexOf('id="f-tenantId"'),ms.indexOf('id="f-clientId"')<ms.indexOf('id="f-clientSecret"')],[true,true,true],'the order: Sender, Recipients, the pair, Client secret');
 // Google Workspace.
 const google=form(null,{draft:{auth:'google'}});
 for(const id of ['host','port','tls','username','password','tenantId','clientSecret'])ok(!google.includes(`id="f-${id}"`),`Google hides ${id}`);
 ok(/<textarea id="f-serviceAccountKey"[^>]*class="mono"/.test(google)&&google.includes('Service account key (JSON)'),'the key is a .mono textarea');
 ok(/<button[^>]*type="button"[^>]*>.*?lucide-file-key.*?Choose key file(?:<\/span>)?<\/button>/s.test(google),'Choose key file is a button with the FileKey icon');
 // The key field and its button form one block; the button is a sibling of the label, never inside it.
 const keyBlock=/<div class="sdx-notification-key">(<div class="sdx-field"><label class="sdx-field-label" for="f-serviceAccountKey">.*?<\/div>)<div class="sdx-notification-keyfile">(.*?)<\/div><\/div>/s.exec(google);
 ok(keyBlock&&/<button[^>]*>.*?Choose key file.*?<\/button>/s.test(keyBlock[2])&&!/<button/.test(keyBlock[1]),'the key Field and the Choose key file row share one wrapper, the button outside the Field');
 ok(/<div class="sdx-notification-key"><div class="sdx-field"><label class="sdx-field-label" for="f-serviceAccountKey">[^]*?class="sdx-field-error"[^]*?<\/div><div class="sdx-notification-keyfile">/.test(form(null,{draft:{auth:'google',serviceAccountKey:'{'},shown:['serviceAccountKey']})),'the key error stays inside its Field, above the button');
 ok(/<input type="file" accept=".json,application\/json" hidden="" tabindex="-1" aria-hidden="true"\/>/i.test(google),'the hidden JSON file input');
 ok(google.includes('Paste the JSON key of a service account with domain-wide delegation for the scope https://mail.google.com/.'),'the Google block hint');
 // Edit: the stored sign-in is preselected; the stored placeholder and the stored account.
 const msChannel={id:'c5',type:'smtp',name:'M365',enabled:true,language:'en',config:{auth:'microsoft365',from:'alerts@contoso.com',recipients:['ops@contoso.com'],tenantId:'contoso.onmicrosoft.com',clientId:'3f2504e0-4f89-11d3-9a0c-0305e82c3301'},secretSet:true,targetHint:'1 recipient via Microsoft 365',revision:2,ruleCount:0,lastDelivery:null};
 const googleChannel={id:'c6',type:'smtp',name:'Workspace',enabled:true,language:'en',config:{auth:'google',from:'alerts@example.com',recipients:['ops@example.com'],serviceAccount:'mailer@project-1.iam.gserviceaccount.com'},secretSet:true,targetHint:'1 recipient via Google Workspace',revision:1,ruleCount:0,lastDelivery:null};
 const editMs=form(msChannel);
 check(radios(editMs).map(radio=>radio.checked),[false,true,false],'edit preselects the stored sign-in');
 ok(/role="radiogroup" aria-labelledby="f-auth"/.test(editMs)&&!/aria-labelledby="f-type"/.test(editMs),'the Sign-in can change on edit, the type cannot');
 ok(/id="f-clientSecret"[^>]*placeholder="A value is saved. Leave the field empty to keep it."/.test(editMs)&&editMs.includes('value="contoso.onmicrosoft.com"'),'the stored client secret shows the placeholder');
 ok(!/placeholder="A value is saved. Leave the field empty to keep it."/.test(form(msChannel,{draft:{auth:'password'}})),'after a change of the sign-in nothing shows as stored');
 const editGoogle=form(googleChannel);
 ok(editGoogle.includes('The key of mailer@project-1.iam.gserviceaccount.com is saved. Leave the field empty to keep it.')&&describedText(editGoogle,'f-serviceAccountKey')==='The key of mailer@project-1.iam.gserviceaccount.com is saved. Leave the field empty to keep it.','the stored key names its service account');
 ok(form(googleChannel,undefined,'de').includes('Der Schlüssel von mailer@project-1.iam.gserviceaccount.com ist gespeichert. Lass das Feld leer, um ihn zu behalten.'),'and in German');
 // The drawer: Save state per sign-in.
 const drawer=(channel,start)=>render(h(panel.ChannelDrawer,{channel,busy:false,onClose:noop,onSave:noop,start}));
 check([saveOf(drawer(msChannel)),saveOf(drawer(googleChannel))],[{blocked:false,reason:null},{blocked:false,reason:null}],'stored modern channels open with Save active');
 check(saveOf(drawer(msChannel,{draft:{auth:'google'}})).reason,'Fill in the required fields first.','a new sign-in needs its secret first');
 const msErrors=drawer(null,{draft:{auth:'microsoft365',name:'M',from:'a@contoso.com',recipients:'b@contoso.com',tenantId:'contoso',clientId:'x'},shown:['tenantId','clientId']});
 check(fieldErrors(msErrors),['Enter the tenant ID (a GUID) or the primary domain, for example contoso.onmicrosoft.com.','Enter the application (client) ID, a GUID such as 3f2504e0-4f89-11d3-9a0c-0305e82c3301.'],'the Microsoft 365 field errors after change and leave');
 check(fieldErrors(drawer(null,{draft:{auth:'google',serviceAccountKey:'{"type":"user"}'},shown:['serviceAccountKey']})).map(text),['Paste the JSON key of a service account. It contains "type": "service_account", client_email and private_key.'],'the key error');
 // channelDraftErrors with the server rules.
 const draft={type:'smtp',name:'X',enabled:true,language:'en',auth:'microsoft365',host:'',port:'587',tls:'starttls',from:'a@contoso.com',recipients:'b@contoso.com',username:'',password:'',tenantId:'contoso.onmicrosoft.com',clientId:'3f2504e0-4f89-11d3-9a0c-0305e82c3301',clientSecret:'s3cret',serviceAccountKey:'',url:''};
 check(panel.channelDraftErrors(draft,{url:false}),{},'a complete Microsoft 365 draft');
 check(panel.channelDraftErrors({...draft,tenantId:'72f988bf-86f1-41af-91ab-2d7cd011db47'},{url:false}),{},'a GUID tenant');
 for(const tenantId of ['','contoso','contoso.com.','a b.com'])check(panel.channelDraftErrors({...draft,tenantId},{url:false}),{tenantId:'notifications.error.tenantId'},`tenant ${JSON.stringify(tenantId)}`);
 for(const clientId of ['','3f2504e0','contoso.onmicrosoft.com'])check(panel.channelDraftErrors({...draft,clientId},{url:false}),{clientId:'notifications.error.clientId'},`client ID ${JSON.stringify(clientId)}`);
 check([panel.channelDraftErrors({...draft,clientSecret:''},{url:false}),panel.channelDraftErrors({...draft,clientSecret:''},{url:false,secretAuth:'microsoft365'}),panel.channelDraftErrors({...draft,clientSecret:''},{url:false,secretAuth:'password'})],[{clientSecret:'notifications.error.clientSecret'},{},{clientSecret:'notifications.error.clientSecret'}],'the client secret: needed on create and after a change of the sign-in, kept otherwise');
 check(panel.channelDraftErrors({...draft,clientSecret:'x'.repeat(513)},{url:false,secretAuth:'microsoft365'}),{clientSecret:'notifications.error.clientSecret'},'at most 512 characters');
 const pemLabel='PRIVATE'+' KEY';
 const keyText=JSON.stringify({type:'service_account',client_email:'mailer@project-1.iam.gserviceaccount.com',private_key_id:'abc',private_key:`-----BEGIN ${pemLabel}-----\nMIIE\n-----END ${pemLabel}-----\n`});
 const googleDraft={...draft,auth:'google',tenantId:'',clientId:'',clientSecret:'',serviceAccountKey:keyText};
 check(panel.channelDraftErrors(googleDraft,{url:false}),{},'a Google draft with a key');
 for(const [label,serviceAccountKey] of [['not JSON','{'],['another type',keyText.replace('service_account','authorized_user')],['no client_email',JSON.stringify({type:'service_account',private_key:`-----BEGIN ${pemLabel}-----`})],['no private_key',JSON.stringify({type:'service_account',client_email:'a@b.com'})],['over 16 KiB',JSON.stringify({...JSON.parse(keyText),padding:'x'.repeat(16*1024)})]])
  check(panel.channelDraftErrors({...googleDraft,serviceAccountKey},{url:false}),{serviceAccountKey:'notifications.error.serviceAccountKey'},`the key: ${label}`);
 check([panel.channelDraftErrors({...googleDraft,serviceAccountKey:''},{url:false}),panel.channelDraftErrors({...googleDraft,serviceAccountKey:''},{url:false,secretAuth:'google'}),panel.channelDraftErrors({...googleDraft,serviceAccountKey:''},{url:false,secretAuth:'microsoft365'})],[{serviceAccountKey:'notifications.error.serviceAccountKey'},{},{serviceAccountKey:'notifications.error.serviceAccountKey'}],'the key: needed on create and after a change of the sign-in, kept otherwise');
 check(panel.channelDraftErrors({...googleDraft,from:'x',recipients:''},{url:false}),{from:'notifications.error.from',recipients:'notifications.error.recipients',},'sender and recipients for every sign-in');
 // channelBody: only the fields of the chosen sign-in, an empty secret left out.
 check(panel.channelBody({...draft,host:'smtp.example.test',username:'u',password:'p'},null),{action:'create',type:'smtp',name:'X',enabled:true,language:'en',auth:'microsoft365',from:'a@contoso.com',recipients:['b@contoso.com'],tenantId:'contoso.onmicrosoft.com',clientId:'3f2504e0-4f89-11d3-9a0c-0305e82c3301',clientSecret:'s3cret'},'Microsoft 365: only its fields');
 check(panel.channelBody({...draft,clientSecret:''},msChannel),{action:'update',id:'c5',revision:2,name:'X',enabled:true,language:'en',auth:'microsoft365',from:'a@contoso.com',recipients:['b@contoso.com'],tenantId:'contoso.onmicrosoft.com',clientId:'3f2504e0-4f89-11d3-9a0c-0305e82c3301'},'an empty client secret is left out');
 check(panel.channelBody(googleDraft,null),{action:'create',type:'smtp',name:'X',enabled:true,language:'en',auth:'google',from:'a@contoso.com',recipients:['b@contoso.com'],serviceAccountKey:keyText},'Google: only its fields');
 check(panel.channelBody({...googleDraft,serviceAccountKey:'  '},googleChannel),{action:'update',id:'c6',revision:1,name:'X',enabled:true,language:'en',auth:'google',from:'a@contoso.com',recipients:['b@contoso.com']},'an empty key is left out');
 check(panel.channelBody({...draft,auth:'password',host:'smtp.example.test',username:'u',password:''},null),{action:'create',type:'smtp',name:'X',enabled:true,language:'en',auth:'password',from:'a@contoso.com',recipients:['b@contoso.com'],host:'smtp.example.test',port:587,tls:'starttls',username:'u'},'Password: only its fields, an empty password left out');
 // The table target and the log text.
 const menu=()=>[];
 const table=locale=>rowsOf(render(h(panel.ChannelsTable,{channels:[msChannel,{...googleChannel,config:{...googleChannel.config,recipients:['a@example.com','b@example.com']}}],loadedAt:0,menu}),locale)).map(row=>cellsOf(row)[2]);
 check([table('en'),table('de')],[['1 recipient via Microsoft 365','2 recipients via Google Workspace'],['1 Empfänger über Microsoft 365','2 Empfänger über Google Workspace']],'the target of Microsoft 365 and Google in English and German');
 const logRow={id:'d9',eventId:'e9',time:Date.UTC(2026,9,21,9,0),event:'test',level:null,device:null,ruleId:null,channel:{name:'Ops mail',type:'smtp'},targetHint:'1 recipient via smtp.office365.com:587',status:'failed',reason:null,attempts:1,errorKey:'apiError.notify.authMfaRequired',errorParams:null};
 check(cellsOf(rowsOf(render(h(panel.LogTable,{rows:[logRow],filter:'all',next:null,loading:false,onMore:noop})))[0])[6],'Failed The account uses multi-factor authentication, so the server refuses the password. Use an app password, or choose the sign-in Microsoft 365 or Google Workspace.','the log row text of authMfaRequired');
 check(panel.deliveryErrorText('apiError.notify.googleDelegationMissing',null,t('de')),'Google hat das Senden als Absender abgelehnt. Erlaube in der Google Admin-Konsole die domänenweite Delegierung für die Client-ID des Dienstkontos mit dem Bereich https://mail.google.com/.','a new reason in German');
 // The fade: the shared keyframe, the duration token, off with reduced motion, no new keyframes or colors.
 const css=readFileSync('ui/settings/notifications-panel.css','utf8'),source=readFileSync('ui/settings/notifications-panel.tsx','utf8');
 ok(/\.sdx-notification-mode-enter \{ animation: sdx-fade var\(--sd-dur\) var\(--sd-ease-out\); \}/.test(css)&&/prefers-reduced-motion: reduce\) \{\s*\.sdx-notification-mode-enter \{ animation: none; \}/.test(css),'the fields fade in with sdx-fade (--sd-dur), not under reduced motion');
 ok(!/@keyframes/.test(css)&&!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(css),'no new keyframes or colors');
 ok(/const chooseAuth=\(auth:SmtpAuth\)=>\{if\(auth===draft\.auth\)return;setSwitched\(true\);/.test(source)&&/key="microsoft365" className=\{modeClass\}/.test(source),'only a change of the sign-in starts the fade, and each sign-in block mounts anew');
 ok(/file\.size>serviceAccountKeyBytes/.test(source)&&/toast\.error\(t\('notifications\.keyFile\.failed'\)\)/.test(source),'the key file is read on the client, at most 16 KiB, with an error toast');
 // Field pairs: each pair is a div with exactly two labels, and a hint or an error stays in its own label.
 const pairsOf=html=>[...html.matchAll(/<div class="(sdx-notification-pair[^"]*)">((?:<div class="sdx-field">.*?<\/div>)+)<\/div>/gs)].map(([,className,inner])=>{
  const cells=[...inner.matchAll(/<div class="sdx-field"><label class="sdx-field-label" for="([^"]+)">(.*?)<\/div>/gs)];
  return {className,ids:cells.map(cell=>cell[1]),cells:Object.fromEntries(cells.map(cell=>[cell[1],cell[2]])),whole:cells.map(cell=>cell[0]).join('')===inner};
 });
 for(const [label,html] of [['create',created],['edit',form(smtp)]]){
  const pairs=pairsOf(html);
  check(pairs.map(pair=>[pair.className,pair.ids,pair.whole]),[['sdx-notification-pair',['f-host','f-port'],true],['sdx-notification-pair',['f-username','f-password'],true]],`Password (${label}): two pairs of exactly two Fields`);
  ok(/<small id="[^"]+">If the account uses/.test(pairs[1].cells['f-password'])&&!/<small/.test(pairs[1].cells['f-username']),`Password (${label}): the app password hint sits in the Password Field only`);
 }
 const serverErrors=pairsOf(form(null,{draft:{host:'',port:'x'},shown:['host','port']}))[0];
 ok(serverErrors.whole&&/class="sdx-field-error"/.test(serverErrors.cells['f-host'])&&/class="sdx-field-error"/.test(serverErrors.cells['f-port']),'each server error sits in its own Field');
 check(pairsOf(ms).map(pair=>[pair.className,pair.ids,pair.whole]),[['sdx-notification-pair sdx-notification-pair-even',['f-tenantId','f-clientId'],true]],'Microsoft 365: one even pair of exactly two Fields');
 const tenantError=pairsOf(form(null,{draft:{auth:'microsoft365',tenantId:'contoso'},shown:['tenantId']}))[0];
 ok(tenantError.whole&&tenantError.ids.length===2&&/class="sdx-field-error"/.test(tenantError.cells['f-tenantId'])&&describedText(tenantError.cells['f-tenantId'],'f-tenantId').startsWith('Enter the tenant ID')&&!/sdx-field-error/.test(tenantError.cells['f-clientId']),'a Tenant ID error stays in the Tenant ID Field, and the pair keeps two cells');
 // Pair CSS: top-aligned cells (the default stretch would move the input of the
 // cell without a hint down), the column widths, and one column with the form's 16px on a phone.
 const narrow=/@media \(max-width: 560px\) \{\n([\s\S]*?)\n\}/g;
 const rulesOf=sheet=>[...sheet.matchAll(/^[ \t]*([^{}\n@/][^{}\n]*?)\s*\{([^}]*)\}/gm)].map(match=>({selectors:match[1].split(/,\s*(?![^(]*\))/).map(part=>part.trim()),body:match[2].trim()}));
 const declarations=(rules,selector)=>rules.filter(rule=>rule.selectors.includes(selector)).map(rule=>rule.body).join(' ');
 const top=rulesOf(css.replace(/@media[^{]*\{[\s\S]*?\n\}/g,'')),phone=[...css.matchAll(narrow)].flatMap(match=>rulesOf(match[1]));
 const declares=(body,declaration)=>new RegExp(`(?:^|[;{]\\s*)${declaration.replace(/[()]/g,'\\$&')};`).test(body);
 const pairBase=declarations(top,'.sdx-notification-pair');
 ok(declares(pairBase,'align-items: start'),'the cells of a pair align to the top');
 ok(declares(pairBase,'grid-template-columns: minmax(0, 1fr) minmax(0, 140px)')&&(declares(pairBase,'gap: 12px')||declares(pairBase,'column-gap: 12px')),'server and port: a flexible column and at most 140px, 12px apart');
 for(const variant of ['.sdx-notification-pair:has(input[type="password"])','.sdx-notification-pair-even'])ok(declares(declarations(top,variant),'grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)'),`${variant}: two equal columns`);
 for(const variant of ['.sdx-notification-pair','.sdx-notification-pair:has(input[type="password"])','.sdx-notification-pair-even']){
  const body=declarations(phone,variant);
  ok(declares(body,'grid-template-columns: minmax(0, 1fr)')&&declares(body,'row-gap: 16px'),`${variant}: one column with a 16px row gap at 560px or narrower`);
 }
 ok(!/margin[a-z-]*:[^;}]*(?:^|\s|:)-\d/.test(css),'no negative margin');
 const keyRule=declarations(top,'.sdx-notification-key');
 ok(declares(keyRule,'display: grid')&&declares(keyRule,'gap: 8px'),'the key block is a grid with an 8px gap');
}

// ---- Narrow screens: the tables scroll inside their wrap, the page never sideways ----
{
 const css=readFileSync('ui/settings/notifications-panel.css','utf8');
 ok(/:is\(\.sdx-notification-channels, \.sdx-notification-log\) > \.sdx-table \{ min-width: 680px; \}/.test(css),'the two settings tables keep their min-width inside their wrap (the rules are kit DataTables in flush cards)');
 ok(/\.sdx-notifications \{ display: grid; grid-template-columns: minmax\(0, 1fr\);[^}]*min-width: 0;/.test(css),'the settings grid has one column that never grows with the table');
 ok(/\.sdx-notification-rules \{ gap: 16px; \}/.test(css)&&!/sdx-notification-rules-head|sdx-notification-empty-row|sdx-notification-rules-table/.test(css),'the rules tab: 16px between its cards; the old head, empty row and table rules are gone');
 ok(/\.sdx-table-wrap \{[^}]*overflow: auto/.test(readFileSync('ui/styles/console.css','utf8')),'the wrap scrolls');
 const sources=readFileSync('ui/settings/notifications-panel.tsx','utf8')+readFileSync('ui/devices/monitoring/notification-rules.tsx','utf8');
 ok(!readFileSync('ui/devices/monitoring/notification-rules.tsx','utf8').includes('<table'),'the rules tab builds no table of its own (DataTable)');
 for(const table of ['sdx-notification-channels','sdx-notification-log'])ok(sources.includes(`className="${table}"`)&&!sources.includes(`<table className="sdx-table ${table}">`),`${table} is a kit DataTable (its wrap carries the class)`);
 ok(!/#[0-9a-f]{3,8}|rgba?\(/i.test(css),'tokens only');
}

// ---- One-time secret, failed test text ----
{
 const html=render(h(panel.SecretContent,{value:'abc123-signing'}));
 ok(html.includes('Copy this secret now, because it is not shown again. Receivers use it to check the X-Nodiverna-Signature header.'),'the note');
  ok(/<div class="sdx-copy-value"><code class="mono">abc123-signing<\/code><button[^>]*aria-label="Copy signing secret"/.test(html),'the secret in the kit CopyValue with its copy button');
 ok(!/<input|readOnly/.test(html),'no read-only input');
 const secretSource=readFileSync('ui/settings/notifications-panel.tsx','utf8');
 ok(/<CopyValue value=\{value\} label=\{t\('notifications\.secret\.copy'\)\} success=\{t\('notifications\.secret\.copied'\)\}\/>/.test(secretSource)&&!/navigator\.clipboard/.test(secretSource),'CopyValue with the copy label and success text; no local copy code');
 const failure=new ApiError('The target did not answer in time. Try again later.',422,'NOTIFY_SEND_FAILED',undefined,'apiError.notify.timeout');
 const failureDe=Object.assign(new ApiError('x',422,'NOTIFY_SEND_FAILED'),{messageKey:'apiError.notify.timeout'});
 check(message(failureDe,'de'),'Das Ziel hat nicht rechtzeitig geantwortet. Versuche es später erneut.','the failed test toast in German');
 check(message(Object.assign(new ApiError('x',422,'NOTIFY_SEND_FAILED'),{messageKey:'apiError.notify.httpStatus',params:{status:500}}),'en'),'The target answered with status 500. Check the URL.','with the status');
 const rejectedText='The target refused the message (status 400). Check that the channel type fits the target: a Discord webhook needs the type Discord.';
 check(message(Object.assign(new ApiError('x',422,'NOTIFY_SEND_FAILED'),{messageKey:'apiError.notify.httpRejected',params:{status:400}}),'en'),rejectedText,'the toast of a refused test message');
 check([panel.deliveryErrorText('apiError.notify.httpRejected',{status:400},t('en')),panel.deliveryErrorText('apiError.notify.httpRejected',{status:422},t('de'))],[rejectedText,'Das Ziel hat die Nachricht abgelehnt (Status 422). Prüfe, ob der Kanaltyp zum Ziel passt: Ein Discord-Webhook braucht den Typ Discord.'],'the log text of httpRejected in both languages');
 void failure;
}

// ---- Delivery log ----
{
 const rows=[
  {id:'d1',eventId:'e1',time:Date.UTC(2026,9,21,9,0),event:'open',level:'critical',device:{id:'s1',name:'WEB01'},ruleId:'cpu',channel:{name:'Ops hook',type:'webhook'},targetHint:'https://hooks.example.test/…',status:'sent',reason:null,attempts:1,errorKey:null,errorParams:null},
  {id:'d2',eventId:'e2',time:Date.UTC(2026,9,21,8,0),event:'close',level:'warning',device:{id:'s1',name:'WEB01'},ruleId:'disk-free',channel:{name:'Ops mail',type:'smtp'},targetHint:'1 recipient via smtp.example.test:587',status:'failed',reason:null,attempts:3,errorKey:'apiError.notify.authFailed',errorParams:null},
  {id:'e3',eventId:'e3',time:Date.UTC(2026,9,21,7,0),event:'escalate',level:'critical',device:{id:'s2',name:'DB01'},ruleId:'memory',channel:null,targetHint:null,status:'suppressed',reason:'maintenance-window',attempts:0,errorKey:null,errorParams:null},
  {id:'d4',eventId:'e4',time:Date.UTC(2026,9,21,6,0),event:'test',level:null,device:null,ruleId:null,channel:{name:'Ops hook',type:'webhook'},targetHint:'https://hooks.example.test/…',status:'pending',reason:null,attempts:1,errorKey:'apiError.notify.timeout',errorParams:null},
  {id:'d5',eventId:'e5',time:Date.UTC(2026,9,21,5,0),event:'test',level:null,device:null,ruleId:null,channel:{name:'Ops Discord',type:'discord'},targetHint:'https://discord.com/…',status:'failed',reason:null,attempts:1,errorKey:'apiError.notify.httpRejected',errorParams:{status:400}},
 ];
 const html=render(h(panel.LogTable,{rows,filter:'all',next:'1:x',loading:false,onMore:noop}));
 check([...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map(match=>text(match[1])),['Time','Event','Device','Alarm','Channel','Target','Status','Attempts'],'the log columns');
 const cells=rowsOf(html).map(cellsOf);
 check(cells.map(row=>row.slice(1)),[
  ['Opened Critical','WEB01','CPU usage','Ops hook','https://hooks.example.test/…','Sent','1'],
  ['Closed Warning','WEB01','Free disk space','Ops mail','1 recipient via smtp.example.test:587','Failed The sign-in was refused. Check the username and password. If the account uses multi-factor authentication, use an app password.','3'],
  ['Escalated Critical','DB01','RAM usage','—','—','Suppressed: maintenance window','—'],
  ['Test message','—','—','Ops hook','https://hooks.example.test/…','Pending The target did not answer in time. Try again later.','1'],
  ['Test message','—','—','Ops Discord','https://discord.com/…','Failed The target refused the message (status 400). Check that the channel type fits the target: a Discord webhook needs the type Discord.','1'],
 ],'events, device, rule, channel, target, status with reason and error text, attempts');
 ok(text(html).includes('Load more'),'Load more while there is a next page');
 const de=render(h(panel.LogTable,{rows:rows.slice(2,3),filter:'all',next:null,loading:false,onMore:noop}),'de');
 ok(text(de).includes('Unterdrückt: Wartungsfenster')&&!text(de).includes('Mehr laden'),'German status, no Load more at the end');
 check(['muted','not-notified','no-rule'].map(reason=>panel.logStatusText({status:'suppressed',reason},t('en'))),['Suppressed: alarm muted','Suppressed: opening was not sent','No matching rule'],'every suppression reason');
 const empty=render(h(panel.LogTable,{rows:[],filter:'all',next:null,loading:false,onMore:noop}));
 ok(text(empty).includes('No notifications sent yet')&&text(empty).includes('Messages appear here once a rule sends an alarm or you send a test message.'),'the empty log');
 ok(text(render(h(panel.LogTable,{rows:[],filter:'failed',next:null,loading:false,onMore:noop}))).includes('No entries with this status'),'the empty filter');
 // a kit DataTable with cards, the filter Segmented size sm in its Toolbar, Load more in the foot,
 // and "All" in the empty state of a filter, which resets it.
 ok(/^<div class="sdx-toolbar"><div class="sdx-toolbar-filters"><div class="sdx-segmented sdx-segmented-sm" role="group" aria-label="Delivery status">/.test(html),'the status filter is a Segmented size sm in the Toolbar');
 ok(/<div class="sdx-table-wrap sdx-notification-log" role="region" aria-label="Delivery log"/.test(html),'a DataTable labelled notifications.tab.log');
 ok(/<div class="sdx-table-foot"><p><button[^>]*>.*?<span>Load more<\/span><\/button><\/p><\/div><\/div>$/.test(html),'Load more sits in the table foot');
 const filters=[];
 const filtered=render(h(panel.LogTable,{rows:[],filter:'failed',next:null,loading:false,onMore:noop,onFilter:value=>filters.push(value)}));
 ok(/<tr class="sdx-table-empty">.*No entries with this status.*<button[^>]*>.*?<span>Show all<\/span><\/button>/.test(filtered),'the empty filter offers Show all');
 ok(!/<tr class="sdx-table-empty">.*<span>All<\/span>/.test(empty),'nothing sent yet: no reset action');
 const logSource=readFileSync('ui/settings/notifications-panel.tsx','utf8');
 ok(/action:onFilter&&<Btn size="sm" onClick=\{\(\)=>onFilter\('all'\)\}>\{t\('fleet\.analysis\.showAll'\)\}<\/Btn>/.test(logSource)&&/rows=\{rows\} rowKey=\{row=>row\.id\} label=\{t\('notifications\.tab\.log'\)\} cards/.test(logSource),'Show all resets the status switch; the log table has cards');
 void filters;
}

// ---- The page: routed tabs, the header primary, the kit states, demo, confirmations ----
{
 const viewer={id:'u',label:'u',permissions:['portal.notifications.manage']};
 const tabs=[];
 // frame.tab is the resolved tab of the route (ui/shell/page-frame.ts): channels or log, never ''.
 const frame=(tab='channels')=>({header:primary=>h('header',{className:'test-header'},primary),refresh:0,tab,onTab:next=>tabs.push(next)});
 const source=readFileSync('ui/settings/notifications-panel.tsx','utf8');
 for(const [tab,label] of [['channels','Channels'],['log','Delivery log']]){
  const html=render(h(panel.default,{viewer,frame:frame(tab)}));
  ok(/^<div class="sdx-notifications-page"><header class="test-header"><button[^>]*class="sdx-btn sdx-btn-primary[^"]*"[^>]*><svg[^>]*lucide-plus[^>]*>.*?<span>Add channel<\/span><\/button><\/header>/.test(html),`${label}: the page primary Add channel (Plus) in the frame header`);
  ok(/<nav class="[^"]*sdx-tabbar[^"]*"[^>]*aria-label="Notification channel views"/.test(html)||/aria-label="Notification channel views"/.test(html),`${label}: the kit Tabs named notifications.tabsLabel`);
  check([...html.matchAll(/<a [^>]*role="tab"[^>]*>/g)].map(link=>[link[0].match(/href="([^"]+)"/)?.[1],link[0].match(/aria-selected="(true|false)"/)?.[1],link[0].match(/aria-controls="([^"]+)"/)?.[1]??null]),
   [['#settings/notification-channels',String(tab==='channels'),tab==='channels'?'sdx-notifications-panel':null],['#settings/notification-channels/log',String(tab==='log'),tab==='log'?'sdx-notifications-panel':null]],`${label}: two link tabs with the route hashes; the active one controls the panel`);
  ok(new RegExp(`<div id="sdx-notifications-panel" role="tabpanel" aria-labelledby="sdx-notifications-panel-tab-${tab}"`).test(html),`${label}: the tab panel is labelled by its tab`);
  ok(!/role="group"[^>]*aria-label="Notification view"/.test(html)&&!/sdx-segmented/.test(html.slice(0,html.indexOf('sdx-notifications-panel'))),`${label}: no Segmented as navigation`);
  ok(/<div class="sdx-skeleton-set sdx-skeleton-facts" role="status" aria-label="Notification channels">/.test(html),`${label}: the kit Skeleton with the page label before the first answer`);
 }
 ok(!/Segmented label=\{t\('notifications\.segmentLabel'\)/.test(source)&&/<Tabs items=\{tabs\} value=\{tab\} onChange=\{id=>frame\?\.onTab\(id\)\} label=\{t\('notifications\.tabsLabel'\)\} panelId=\{panelId\}\/>/.test(source),'the Tabs pass the tab id to frame.onTab (channels or log; the console writes no segment for channels)');
 // The tab items come from the page's tab nodes in the nav model; the panel keeps no label or link list of its own.
 ok(/const tabs=pageTabNodes\(\{view:'settings',page:'notification-channels'\}\)\.map\(node=>\(\{id:node\.tab\?\?'',label:t\(node\.label\),href:consoleRouteHash\(node\.route\)\}\)\);/.test(source),'the tab items from pageTabNodes');
 ok(!/notificationTabHref|export const notificationTab\b|'notifications\.tab\.channels'/.test(source),'no local tab label or link list');
 check(navModel.pageTabNodes(route.parseConsoleRoute('#settings/notification-channels/log')).map(node=>[node.tab,translate('en',node.label),route.consoleRouteHash(node.route)]),[['channels','Channels','#settings/notification-channels'],['log','Delivery log','#settings/notification-channels/log']],'the tab nodes: ids, labels and links unchanged');
 // An unknown frame tab shows Channels.
 ok(/aria-labelledby="sdx-notifications-panel-tab-channels"/.test(render(h(panel.default,{viewer,frame:frame('other')}))),'an unknown tab shows Channels');
 ok(/\{creating&&<ChannelDrawer key="new" channel=\{null\} busy=\{data\.busy\} onClose=\{\(\)=>setCreating\(false\)\} onSave=\{create\}\/>\}/.test(source)&&/toast\.success\(t\('notifications\.saved'\)\);setCreating\(false\);/.test(source)&&/const run=async\(body:Record<string,unknown>\)=>\{const result=await change\.run\(body\);if\(result\)void load\(\);return result;\};/.test(source),'the create drawer opens over either tab; a success closes it, toasts notifications.saved and reloads the table; the tab stays');
 // no demo: the page loads the real channels and log and blocks nothing.
 ok(!/\bdemo\b|common\.demoBlocked/.test(source),'no demo branch and no demo reason in the page');
 // the channel changes run through useStepUp without a dialog first (lib/step-up.ts: no notification change asks);
 // a reply that asks for a proof still opens it. The local pending logic is gone.
 ok(/useStepUp<Record<string,unknown>,ChangeResult>\(\{locale,needsStepUp:\(\)=>false,/.test(source)&&!/notificationChannel\w*StepUp/.test(source)&&!/function useChannelChange|pending=useRef|stepUpRetry\(/.test(source)&&/<MfaStepUp \{\.\.\.data\.dialog\}\/>/.test(source),'useStepUp with <MfaStepUp {...dialog}/>, no useChannelChange');
 // Delete confirms in the kit ConfirmDialog; no shadcn AlertDialog.
 ok(!/components\/ui\/alert-dialog|AlertDialog/.test(source),'no shadcn AlertDialog');
 ok(/<ConfirmDialog open=\{!!deleting\}[^\n]*tone="danger" title=\{t\('notifications\.delete\.title',\{name:deleting\?\.name\?\?''\}\)\}\n\s*body=\{deleting\?\.ruleCount\?t\('notifications\.delete\.rules',\{count:deleting\.ruleCount\}\):t\('notifications\.delete\.noRules'\)\} confirmLabel=\{t\('notifications\.delete\.confirm'\)\}/.test(source),'a danger ConfirmDialog with the title, the rule-count body and "Delete channel"');
 check([t('en')('notifications.delete.confirm'),t('de')('notifications.delete.confirm')],['Delete channel','Kanal löschen'],'the verb in both languages');
 // "Generate new signing secret" asks first; only Confirm sends rotate-secret.
 ok(/\{id:'rotate',label:t\('notifications\.menu\.rotate'\),icon:KeyRound,blocked,onSelect:\(\)=>setRotating\(channel\)\}/.test(source),'the menu entry only opens the confirmation (sends nothing)');
 ok(/<ConfirmDialog open=\{!!rotating\}[^\n]*tone="danger" title=\{t\('notifications\.rotate\.title',\{name:rotating\?\.name\?\?''\}\)\}\n\s*body=\{t\('notifications\.rotate\.body'\)\} confirmLabel=\{t\('notifications\.menu\.rotate'\)\} onConfirm=\{\(\)=>\{if\(rotating\)void rotate\(rotating\);\}\}\/>/.test(source),'a danger ConfirmDialog; Confirm runs the rotation, Cancel only closes it');
 ok(/const rotate=async\(channel:ChannelView\)=>\{setRotating\(null\);const result=await data\.run\(\{action:'rotate-secret',id:channel\.id,revision:channel\.revision\}\);if\(result\?\.signingSecret\)\{toast\.success\(t\('notifications\.rotated'\)\);onSecret/.test(source),'rotate-secret (with step-up), the toast notifications.rotated, then the secret drawer');
 check([t('en')('notifications.rotate.title',{name:'Ops hook'}),t('de')('notifications.rotate.body')],['Generate a new signing secret for “Ops hook”?','Der aktuelle Schlüssel funktioniert ab sofort nicht mehr. Empfänger lehnen Nachrichten ab, bis du dort den neuen Schlüssel einträgst.'],'the rotation texts');
 // the drawer on the kit.
 ok(/<Drawer open onClose=\{onClose\} dirty=\{form\.dirty\}/.test(source)&&/\{busy\?<Btn blocked=\{t\('kit\.busy'\)\}>\{t\('common\.cancel'\)\}<\/Btn>:<DrawerCancel\/>\}<Btn variant="primary" type="submit" form=\{formId\} loading=\{busy\} blocked=\{form\.blocked\?t\(form\.blocked\):undefined\}>/.test(source),'dirty, Cancel (DrawerCancel, or blocked with kit.busy while saving) and Save blocked with the saveBlockedKey reason');
 const FormHost=({channel,start})=>h(panel.ChannelForm,{formId:'f',channel,busy:false,onSubmit:noop,form:panel.useChannelDraft(channel,start)});
 const formHtml=render(h(FormHost,{channel:null}));
 ok(/<div class="sdx-field"><label class="sdx-field-label" for="f-tls">Encryption<\/label><select[^>]*class="sdx-select"/.test(formHtml)&&/<label class="sdx-field-label" for="f-language">Language of messages<\/label><select[^>]*class="sdx-select"/.test(formHtml),'TLS mode and Language are the kit Select in a Field');
 ok(/<div class="sdx-switch-field"><label><input[^>]*type="checkbox" role="switch" checked=""/.test(formHtml),'Enabled is the kit Switch');
 ok(!/<label class="sdx-field" for=/.test(formHtml)&&(formHtml.match(/<div class="sdx-field"><label class="sdx-field-label"/g)??[]).length>=8,'every text field is a kit Field');
 const draftState=(channel,start)=>{let state;render(h(()=>{state=panel.useChannelDraft(channel,start);return null;}));return state;};
 check([draftState(null).dirty,draftState(null,{draft:{name:'X'}}).dirty,draftState(smtp).dirty,draftState(smtp,{draft:{port:'25'}}).dirty],[false,true,false,true],'dirty: the draft differs from its start');
 // busy blocks the row menu with kit.busy, never with native disabled.
 ok(/const blocked=data\.busy\?t\('kit\.busy'\):undefined;/.test(source)&&!/disabled=\{busy\}>|<Btn[^>]*disabled=/.test(source),'a running change blocks the other actions with kit.busy; no Btn is natively disabled');
}

// ---- Rules tab ----
{
 const channel=(id,name,type='webhook',enabled=true)=>({id,name,type,enabled});
 const rule=(id,name,changes={})=>({id,scope:{type:'group',id:'g1'},channel:channel('c-'+id,name),levels:['warning','critical'],events:{open:true,close:true,escalate:false},enabled:true,revision:0,...changes});
 const view={scope:{type:'group',id:'g1',name:'Berlin Web'},canEdit:true,reason:null,channels:[channel('c-a','Ops hook'),channel('c-b','Ops mail','smtp',false)],
  direct:[rule('a','Ops hook')],
  inherited:[{...rule('b','Ops mail',{channel:channel('c-b','Ops mail','smtp',false),levels:['critical'],enabled:false}),origin:{type:'group',id:'g0',name:'Berlin',visible:true}},{...rule('c','Ops hook',{events:{open:true,close:false,escalate:true}}),origin:{type:'customer',id:'cu',name:'Contoso',visible:true}},{...rule('d','Ops hook'),origin:{type:'all',id:'*',name:'',visible:true}}]};
 const calls=[];
 const emptyOf=(value,{demo=false,canManageChannels=true,addBlocked}={},locale='en')=>rules.directRulesEmpty({view:value,demo,canManageChannels,addBlocked,t:t(locale),onAdd:()=>calls.push('add'),onOpenSettings:()=>calls.push('settings'),onHideDemo:()=>calls.push('hideDemo')});
 const table=(value,locale='en',options={})=>render(h(rules.RulesTable,{view:value,directEmpty:emptyOf(value,options,locale),onEdit:noop,onToggle:noop,onDelete:noop,onOpenOrigin:noop}),locale);
 /** The cards of the tab: the card title, the DataTable label, its heads and its rows (cell texts). */
 const cardsOf=html=>[...html.matchAll(/<section class="sdx-card sdx-card-flush">(.*?)<\/section>/gs)].map(match=>({title:text(match[1].match(/<h2[^>]*>(.*?)<\/h2>/s)[1]),tile:/sdx-icon-tile/.test(match[1].match(/<h2[^>]*>(.*?)<\/h2>/s)[1]),label:match[1].match(/role="region" aria-label="([^"]+)"/)?.[1],heads:[...match[1].matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map(head=>text(head[1])),rows:rowsOf(match[1]).map(cellsOf)}));
 const html=table(view);
 const cards=cardsOf(html);
 check(cards.map(card=>[card.title,card.tile,card.label]),[['Direct',true,'Direct notification rules'],['Inherited',true,'Inherited notification rules']],'two flush cards with an icon tile: Direct, then Inherited, each with its DataTable');
 check(cards[0].heads,['Channel','Levels','Events','Status','Actions'],'Direct: no Origin column');
 check(cards[1].heads,['Channel','Levels','Events','Status','Origin','Actions'],'Inherited: the Origin column');
 check(cards[0].rows.map(row=>row.slice(0,4)),[['Webhook: Ops hook','Warning Critical','Opened Closed','On']],'the direct rule; "Direct" is never repeated in a row');
 check(cards[1].rows.map(row=>row.slice(0,5)),[
  ['Email (SMTP): Ops mail Off','Critical','Opened Closed','Off','Inherited Device group: Berlin Change it at Device group: Berlin.'],
  ['Webhook: Ops hook','Warning Critical','Opened Escalated to a higher level','On','Inherited Customer: Contoso Change it at Customer: Contoso.'],
  ['Webhook: Ops hook','Warning Critical','Opened Closed','On','Inherited All devices Change it at All devices.'],
 ],'inherited rules in the server order (nearest first) with tag, origin and hint; a disabled channel is marked');
 ok(html.indexOf('Direct notification rules')<html.indexOf('Inherited notification rules'),'the Direct card comes first');
 ok(!/sdx-table-section|colgroup/.test(html),'no section rows');
 const inherited=rules.inheritedRuleMenu(view.inherited[0],t('en'),{onOpenOrigin:noop});
 check(inherited.map(entry=>[entry.id,entry.blocked??null]),[['origin',null],['edit','Change it at Device group: Berlin.']],'inherited rows are read-only: Open origin first, then the blocked Edit');
 const blockedMenu=rules.directRuleMenu(view.direct[0],t('en'),{blocked:'You need the permission “Manage alert rules and alarms” for this level.',onEdit:noop,onToggle:noop,onDelete:noop,onOpenOrigin:noop});
 check(blockedMenu.filter(entry=>entry.label).map(entry=>[entry.label,entry.blocked]),[['Edit','You need the permission “Manage alert rules and alarms” for this level.'],['Turn off','You need the permission “Manage alert rules and alarms” for this level.'],['Delete','You need the permission “Manage alert rules and alarms” for this level.']],'missing alerts.manage keeps the actions visible and blocked');
 // The Direct empty row: one Empty with its cause and one action.
 const none=table({...view,direct:[],inherited:[]});
 ok(text(none).includes('No rules apply here')&&text(none).includes('Add a rule to send the alarms here to a channel.')&&/<button[^>]*class="sdx-btn sdx-btn-secondary"[^>]*>.*?<span>Add notification rule<\/span>/.test(none)&&cardsOf(none).length===1,'nothing applies: one Direct card with "Add notification rule", no Inherited card');
 ok(/<tr class="sdx-table-empty">/.test(none)&&cardsOf(none)[0].heads.length===5,'the table keeps its head and shows the Empty as its one row');
 const onlyInherited=table({...view,direct:[]});
 ok(text(onlyInherited).includes('No direct rules')&&text(onlyInherited).includes('The rules below come from higher levels.')&&text(onlyInherited).includes('Add notification rule')&&cardsOf(onlyInherited).length===2,'no direct rules with the Inherited card below');
 const blockedAdd=buttons(table({...view,direct:[],inherited:[],canEdit:false,reason:'right'},'en',{addBlocked:t('en')('notificationRules.blocked.right')})).find(button=>button.inner.includes('<span>Add notification rule</span>'));
 check([blockedAdd?.blocked,blockedAdd?.description],[true,t('en')('notificationRules.blocked.right')],'the empty action is blocked with its reason');
 const german=table(view,'de');
 ok(text(german).includes('Geerbt')&&text(german).includes('Änderbar bei Kunde: Contoso.')&&text(german).includes('Direkt')&&german.includes('aria-label="Direkte Benachrichtigungsregeln"')&&german.includes('aria-label="Geerbte Benachrichtigungsregeln"'),'German cards, tables and hint');
 // No channel yet: an editor with the channel right gets the way there, an editor without it the sentence only.
 const editorView={scope:{type:'all',id:'*',name:''},direct:[],inherited:[],channels:[],canEdit:true,reason:null};
 let empty=emptyOf(editorView);
 check([empty.title,empty.children,empty.action?.props.children],['No channels yet','Set up a channel first. You can add a rule here after that.','Open notification settings'],'an editor with the channel right: "Open notification settings"');
 empty.action.props.onClick();
 empty=emptyOf(editorView,{canManageChannels:false});
 check([empty.title,empty.children,empty.action],['No channels yet','Ask an administrator to set up a channel.',undefined],'without the channel right: no action (the viewer can never get it here)');
 // Sample devices: their own empty state, never "No channels yet"; Hide sample devices is the one action.
 empty=emptyOf(rules.emptyRulesView({type:'all',id:'*'},'All devices'),{demo:true,addBlocked:'Not available for sample devices.'});
 check([empty.title,empty.children,empty.action?.props.children],['No notification rules for sample devices','Notification rules work only for your own devices. Hide the sample devices to set them up.','Hide sample devices'],'demo: the demo state with "Hide sample devices"');
 empty.action.props.onClick();
 check(calls,['settings','hideDemo'],'the actions call their callbacks');
 ok(emptyOf(editorView,{},'de').title==='Noch keine Kanäle'&&emptyOf(rules.emptyRulesView({type:'all',id:'*'},''),{demo:true},'de').action.props.children==='Beispielgeräte ausblenden','German texts');
 // A viewer gets channels: [] from the server: "No rules apply here", never "No channels yet".
 const noRules={scope:{type:'all',id:'*',name:''},direct:[],inherited:[],channels:[]};
 const right=t('en')('notificationRules.blocked.right'),boundaryText=t('en')('notificationRules.blocked.boundary');
 for(const [reason,locked] of [['right',right],['customer-boundary',boundaryText]]){
  const value={...noRules,canEdit:false,reason};
  const markup=table(value,'en',{addBlocked:rules.addRuleBlocked(value,locked,t('en'))});
  check([rules.showsNoChannels(value,false),text(markup).includes('No rules apply here'),text(markup).includes('No channels yet'),rules.addRuleBlocked(value,locked,t('en'))],[false,true,false,locked],`a viewer (${reason}) without channels: the rules table, and Add blocked with the right or boundary`);
 }
 check([rules.showsNoChannels(editorView,false),rules.addRuleBlocked(editorView,undefined,t('en')),rules.showsNoChannels({...editorView,direct:[view.direct[0]]},false),rules.addRuleBlocked({...editorView,channels:view.channels},undefined,t('en'))],[true,'No channels yet',false,undefined],'an editor without channels and rules: No channels yet; with channels Add is free');
 check([rules.showsNoChannels(rules.emptyRulesView({type:'all',id:'*'},'All devices'),true),rules.showsNoChannels({...editorView},true)],[false,false],'sample devices never show "No channels yet" (no channel data)');
 // The drawer.
 const RuleHost=({rule,start})=>h(rules.RuleForm,{formId:'r',rule,view,busy:false,onSubmit:noop,form:rules.useRuleDraft(rule,start)});
 const form=render(h(RuleHost,{rule:null}));
 ok(form.includes('Choose a channel')&&form.includes('Ops mail · Email (SMTP) · Off')&&!form.includes('>Ops hook · Webhook<'),'the channel select offers channels without a rule here');
 ok(['Info','Warning','Critical','Opened','Closed','Escalated to a higher level'].every(label=>text(form).includes(label))&&/role="switch"/.test(form),'level and event checkboxes and the switch');
 const invalid=render(h(RuleHost,{rule:null,start:{submitted:true}}));
 ok(text(invalid).includes('Choose a channel.'),'field error after the first submit');
 // Save blocked while invalid, from the first render.
 const ruleDrawer=(rule,start)=>render(h(rules.RuleDrawer,{rule,view,scopeName:'Berlin Web',busy:false,onClose:noop,onSave:noop,start}));
 const newRule=ruleDrawer(null);
 check([saveOf(newRule),fieldErrors(newRule)],[{blocked:true,reason:'Fill in the required fields first.'},[]],'a new rule without a channel: Save blocked at once, no error yet');
 const noLevels=ruleDrawer(view.direct[0],{draft:{levels:[]},shown:['levels']});
 check([saveOf(noLevels),fieldErrors(noLevels)],[{blocked:true,reason:'Correct the marked fields first.'},['Choose at least one level.']],'levels cleared: the error shows after the change');
 ok(/<fieldset[^>]*aria-invalid="true"[^>]*aria-describedby="[^"]*-levels-error"/.test(noLevels),'the fieldset is marked');
 const noEvents=ruleDrawer(view.direct[0],{draft:{events:{open:false,close:false,escalate:false}},shown:['events']});
 check(fieldErrors(noEvents),['Choose at least one event.'],'events cleared: the error shows');
 const pickedNone=ruleDrawer(null,{shown:['channel']});
 check([fieldErrors(pickedNone),saveOf(pickedNone).reason],[['Choose a channel.'],'Correct the marked fields first.'],'the channel select back to none shows its error');
 check([saveOf(ruleDrawer(view.direct[0])),saveOf(ruleDrawer(null,{draft:{channelId:'c-b'},shown:['channel']}))],[{blocked:false,reason:null},{blocked:false,reason:null}],'a stored rule and a complete new rule have Save active');
 check(rules.ruleDraftErrors({channelId:'c',levels:[],events:{open:false,close:false,escalate:false},enabled:true}),{levels:'notificationRules.error.levels',events:'notificationRules.error.events'},'levels and events');
 // The panel: one head without a second primary, demo, loading.
 const props={scope:{type:'all',id:'*'},scopeName:'All devices',demo:true,canManageChannels:true,onOpenOrigin:noop,onOpenSettings:noop,onHideDemo:noop};
 const demo=render(h(rules.default,props));
 ok(text(demo).includes('No notification rules for sample devices')&&text(demo).includes('Hide sample devices')&&!text(demo).includes('No channels yet'),'demo: the demo empty state, not "No channels yet"');
 const demoAdd=buttons(demo).filter(button=>button.inner.includes('<span>Add notification rule</span>'));
 ok(demoAdd.length===1&&demoAdd[0].blocked&&demoAdd[0].description==='Not available for sample devices.','demo: "Add notification rule" in the head stays blocked with its reason');
 ok(/<section class="sdx-health-tab sdx-notification-rules" aria-labelledby="([^"]+)"><header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="\1" class="sr-only">Notification rules<\/h2><p>Choose which alarm levels and events go to which channels\./.test(demo),'one SectionHead: the sr-only h2 names the section, the meta is the visible description');
 ok(/<div class="sdx-section-head-actions"><button[^>]*class="sdx-btn sdx-btn-secondary"[^>]*><svg[^>]*lucide-plus/.test(demo)&&!demo.includes('sdx-btn-primary'),'"Add notification rule" is a secondary Btn with Plus in the head actions; no primary');
 ok(!/sdx-notification-rules-head|sdx-icon-tile[^"]*"[^>]*>(?:(?!<\/header>).)*<\/header>/s.test(demo.slice(0,demo.indexOf('</header>')+9)),'no own head class and no icon tile in the head');
 const loading=render(h(rules.default,{...props,demo:false,scope:{type:'customer',id:'cu'},scopeName:'Contoso'}));
 ok(/<div class="sdx-skeleton-set sdx-skeleton-table" role="status" aria-label="Loading notification rules">/.test(loading)&&!loading.includes('sdx-loading')&&loading.includes('Add notification rule'),'the kit Skeleton and the head action on a customer');
 const panelSource=readFileSync('ui/devices/monitoring/notification-rules.tsx','utf8');
 ok(!panelSource.includes('@/components/ui/alert-dialog')&&panelSource.includes("import {ConfirmDialog} from '@/ui/kit/confirm-dialog';"),'the delete confirmation is the kit ConfirmDialog, not the shadcn AlertDialog');
 check(rules.ruleOriginLabel({type:'customer',name:'Contoso'},t('de')),'Kunde: Contoso','the customer origin in German');
}

// ---- The head links to Settings › Notification channels and its Delivery log ----
{
 const base={scope:{type:'group',id:'g1'},scopeName:'Berlin',demo:true,onOpenOrigin:noop,onHideDemo:noop};
 const opened=[];
 const links=html=>buttons(html).filter(button=>/Open notification channels|Open delivery log/.test(button.inner)).map(button=>[text(button.inner),/sdx-btn-sm/.test(button.attributes),/sdx-btn-secondary/.test(button.attributes)]);
 const withRight=render(h(rules.default,{...base,canManageChannels:true,onOpenSettings:()=>opened.push('channels'),onOpenLog:()=>opened.push('log')}));
 check(links(withRight),[['Open notification channels',true,true],['Open delivery log',true,true]],'with the channel right: two small secondary buttons in the head');
 ok(withRight.indexOf('Open notification channels')<withRight.indexOf('</header>')&&withRight.indexOf('Open delivery log')<withRight.indexOf('Add notification rule'),'in the head actions, before "Add notification rule"');
 check(links(render(h(rules.default,{...base,canManageChannels:false,onOpenSettings:noop,onOpenLog:noop}))),[],'without the channel right: no settings links');
 check([translate('de','monitoringTab.openChannels'),translate('de','monitoringTab.openLog')],['Benachrichtigungskanäle öffnen','Zustellprotokoll öffnen'],'German link labels');
}

// ---- The notification rules of a device: read-only, one card, no Add ----
{
 const {panelHarness}=await import('../../support/panel-harness.mjs');
 const channel=(id,name,enabled=true)=>({id,name,type:'webhook',enabled});
 const rule=(id,name,origin,changes={})=>({id,scope:{type:origin.type,id:origin.id},channel:channel('c-'+id,name),levels:['warning','critical'],events:{open:true,close:true,escalate:false},enabled:true,revision:0,origin,...changes});
 const sub={type:'group',id:'g2',name:'Berlin Web',visible:true},parent={type:'group',id:'g1',name:'Berlin',visible:false},customer={type:'customer',id:'cu',name:'Contoso',visible:true},all={type:'all',id:'*',name:'',visible:true};
 const inherited=[rule('a','Web hook',sub,{enabled:false}),rule('b','City hook',parent),rule('c','Customer hook',customer),rule('d','Ops mail',all,{channel:channel('c-d','Ops mail',false)})];
 let view={scope:{type:'device',id:'d1',name:'WEB01'},direct:[],inherited,channels:[],canEdit:false,reason:null};
 const posts=[];
 const api=async(url,body)=>{posts.push({url,body});return view;};
 const harness=panelHarness({hooked:['ui/devices/monitoring/notification-rules.tsx'],stubs:{'@/ui/base/api':{api,ApiError,message:failure=>failure.message}},locale:'en'});
 const Panel=harness.load('ui/devices/monitoring/notification-rules.tsx').default;
 const opened=[];
 const props={scope:{type:'device',id:'d1'},scopeName:'WEB01',demo:false,canManageChannels:true,onOpenOrigin:target=>opened.push(target),onOpenSettings:()=>opened.push('channels'),onOpenLog:()=>opened.push('log'),onHideDemo:noop,deviceEmpty:{name:'Berlin Web',onOpen:()=>opened.push('empty')}};
 harness.reset();harness.tree(Panel,props);await harness.flush();
 const html=harness.html(Panel,props);
 check(posts.map(post=>post.url),['/api/notifications/rules?scope=device%3Ad1'],'one load of the rules that reach the device');
 ok(/role="status"[^>]*>.*?You set notification rules on device groups, customers and All devices\. These rules apply to this device\./s.test(html),'one info Notice first');
 // The head carries the description line (SectionHead description), before the Notice.
 const deviceMeta='<div class="sdx-section-head-text"><h2 id="[^"]+" class="sr-only">Notification rules</h2><p>See which alarm levels and events of this device go to which channels\.</p></div>';
 const headAt=markup=>markup.search(new RegExp(deviceMeta));
 ok(headAt(html)>=0&&headAt(html)<html.indexOf('role="status"'),'the device head: the description line before the info Notice');
 check((html.match(/role="status"/g)??[]).length,1,'a real device with rules: the info Notice stays');
 check(translate('de','notificationRules.device.meta'),'Sieh, welche Alarmstufen und Ereignisse dieses Geräts an welche Kanäle gehen.','German device description');
 const cards=[...html.matchAll(/<section class="sdx-card sdx-card-flush">(.*?)<\/section>/gs)].map(match=>({title:text(match[1].match(/<h2[^>]*>(.*?)<\/h2>/s)[1]),tile:/lucide-send/.test(match[1].match(/<h2[^>]*>(.*?)<\/h2>/s)[1]),heads:[...match[1].matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map(head=>text(head[1])),rows:rowsOf(match[1]).map(cellsOf)}));
 check(cards.map(card=>[card.title,card.tile]),[['Rules for this device',true]],'one flush card "Rules for this device" with the Send tile; no Direct card');
 check(cards[0].heads,['Channel','Levels','Events','Status','Origin','Actions'],'the columns of an inherited table');
 check(cards[0].rows.map(row=>[row[0],row[3],row[4]]),[
  ['Webhook: Web hook','Off','Inherited Device group: Berlin Web Change it at Device group: Berlin Web.'],
  ['Webhook: City hook','On','Inherited Device group: Berlin Change it at Device group: Berlin.'],
  ['Webhook: Customer hook','On','Inherited Customer: Contoso Change it at Customer: Contoso.'],
  ['Webhook: Ops mail Off','On','Inherited All devices Change it at All devices.'],
 ],'nearest origin first (the server order); a disabled rule and a disabled channel are marked in text');
 ok(!html.includes('Add notification rule')&&!html.includes('Direct'),'no "Add notification rule" and no Direct card');
 ok(html.includes('Open notification channels')&&html.includes('Open delivery log'),'the head links under the channel right');
 ok(!harness.html(Panel,{...props,canManageChannels:false}).includes('Open delivery log'),'no head links without the right');
 const linkPart=harness.find(harness.tree(Panel,props),item=>typeof item.props?.onOpenLog==='function'&&'canManageChannels' in item.props);
 linkPart.props.onOpenSettings();linkPart.props.onOpenLog();
 check(opened.splice(0),['channels','log'],'the head links call their callbacks');
 // The row menu: Open origin (blocked when the viewer may not open the origin), then the blocked changes.
 const menu=rules.deviceRuleMenu(inherited[0],t('en'),{onOpenOrigin:target=>opened.push(target)});
 check(menu.map(entry=>[entry.id,entry.label??null,entry.blocked??null]),[['origin','Open origin',null],['edit','Edit','Change it at Device group: Berlin Web.'],['toggle','Turn on','Change it at Device group: Berlin Web.'],['separator',null,null],['delete','Delete','Change it at Device group: Berlin Web.']],'Open origin, then Edit, Turn on and Delete blocked with "Change it at"');
 menu[0].onSelect();menu[1].onSelect();
 const hidden=rules.deviceRuleMenu(inherited[1],t('en'),{onOpenOrigin:target=>opened.push(target)});
 check([hidden[0].blocked,hidden[2].label],['You cannot open Device group: Berlin.','Turn off'],'an origin the viewer may not open: Open origin blocked with its reason');
 hidden[0].onSelect();
 check(opened,[sub],'only the visible origin opens; blocked entries do nothing');
 check(rules.deviceRuleMenu(inherited[1],t('de'),{onOpenOrigin:noop})[0].blocked,'Gerätegruppe: Berlin kannst du nicht öffnen.','German reason');
 // No rule reaches the device: the Empty with the one action to the nearest group the viewer may open.
 view={...view,inherited:[]};harness.reset();harness.tree(Panel,props);await harness.flush();
 const empty=harness.html(Panel,props);
 ok(headAt(empty)>=0&&text(empty).includes('You set notification rules on device groups, customers and All devices. These rules apply to this device.')&&(empty.match(/role="status"/g)??[]).length===1,'a real device without rules: description and info Notice stay above the empty card');
 ok(text(empty).includes('No notification rule reaches this device')&&text(empty).includes('Nobody gets a message about alarms of this device. Add a rule to its group or to All devices.')&&/lucide-send/.test(empty.slice(empty.indexOf('sdx-empty'))),'the empty card: Send icon, title and sentence');
 const action=buttons(empty).filter(button=>/Open notification rules of/.test(button.inner));
 check(action.map(button=>text(button.inner)),['Open notification rules of Berlin Web'],'one action naming the group');
 const emptyButton=harness.button(harness.tree(Panel,props),'Open notification rules of Berlin Web');
 emptyButton.props.onClick();
 check(opened.at(-1),'empty','the action opens the place of the rules');
 // Sample devices: the existing demo empty state with "Hide sample devices"; nothing is loaded.
 const demo=render(h(rules.default,{...props,demo:true}));
 ok(text(demo).includes('No notification rules for sample devices')&&text(demo).includes('Hide sample devices')&&text(demo).includes('Rules for this device')&&!demo.includes('Add notification rule'),'sample devices: the demo state in the device card');
 ok(headAt(demo)>=0,'sample devices: the description line in the head');
 ok(!demo.includes('Notification rules are set on device groups')&&!/role="status"/.test(demo),'sample devices: no device Notice');
 // The doc comments sit directly above their functions.
 const source=readFileSync('ui/devices/monitoring/notification-rules.tsx','utf8');
 ok(/directEmpty is the cause-specific empty row of the Direct card\.\s*\*\/\s*export function RulesTable\(/.test(source),'the "Two cards" comment sits directly above RulesTable');
 ok(/\/\*\* The row menu column of a rule table\. \*\/\s*function actionsColumn</.test(source),'actionsColumn keeps its own comment');
 ok(/\/\*\* The columns of an inherited rule table:[^\n]*\*\/\nfunction inheritedColumns\(/.test(source),'inheritedColumns keeps its own comment');
 check([translate('de','notificationRules.device.cardTitle'),translate('de','notificationRules.device.empty.action',{name:'Alle Geräte'})],['Regeln für dieses Gerät','Benachrichtigungsregeln von Alle Geräte öffnen'],'German device texts');
}

// ---- Rules tab with hooks: load, delete through ConfirmDialog with the same payload, retry ----
{
 const {panelHarness}=await import('../../support/panel-harness.mjs');
 const posts=[];let fail=false;
 const channel={id:'c-a',name:'Ops hook',type:'webhook',enabled:true};
 const view={scope:{type:'group',id:'g1',name:'Berlin Web'},canEdit:true,reason:null,channels:[channel],direct:[{id:'r1',scope:{type:'group',id:'g1'},channel,levels:['critical'],events:{open:true,close:true,escalate:false},enabled:true,revision:4}],inherited:[]};
 const api=async(url,body)=>{posts.push({url,body});if(fail)throw new Error('offline');return body?{ok:true}:view;};
 const harness=panelHarness({hooked:['ui/devices/monitoring/notification-rules.tsx'],stubs:{'@/ui/base/api':{api,ApiError,message:failure=>failure.message}},locale:'en'});
 const Panel=harness.load('ui/devices/monitoring/notification-rules.tsx').default;
 const props={scope:{type:'group',id:'g1'},scopeName:'Berlin Web',demo:false,canManageChannels:true,onOpenOrigin:noop,onOpenSettings:noop,onHideDemo:noop};
 harness.reset();
 let tree=harness.tree(Panel,props);await harness.flush();tree=harness.tree(Panel,props);
 check(posts.map(post=>[post.url,post.body]),[['/api/notifications/rules?scope=group%3Ag1',undefined]],'one load of the rules of the scope');
 const table=harness.find(tree,item=>typeof item.props?.onDelete==='function');
 table.props.onDelete(view.direct[0]);
 tree=harness.tree(Panel,props);
 const dialog=harness.find(tree,item=>item.props?.confirmLabel!==undefined);
 check([dialog.props.open,dialog.props.title,dialog.props.body,dialog.props.confirmLabel,dialog.props.tone],[true,'Delete the notification rule for “Ops hook”?','Alarms of Berlin Web no longer go to this channel through this rule.','Delete rule','danger'],'Delete opens the ConfirmDialog: question, consequence, "Delete rule", danger');
 posts.length=0;
 dialog.props.onConfirm();await harness.settle();
 check(posts[0],{url:'/api/notifications/rules',body:{action:'delete',id:'r1',revision:4,scope:'group:g1'}},'the delete payload is unchanged');
 check(harness.find(harness.tree(Panel,props),item=>item.props?.confirmLabel!==undefined).props.open,false,'the dialog closes');
 // A failed load: the danger Notice with "Try again", which repeats the same request.
 harness.reset();fail=true;posts.length=0;
 tree=harness.tree(Panel,props);await harness.flush();tree=harness.tree(Panel,props);
 const failed=harness.find(tree,item=>typeof item.props?.onRetry==='function'&&item.props.text!==undefined);
 const markup=harness.html(Panel,props);
 ok(failed&&markup.includes('Nodiverna could not load the notification rules.')&&/role="alert"/.test(markup)&&markup.includes('<span>Try again</span>'),'the load error: a danger Notice with "Try again"');
 fail=false;failed.props.onRetry();await harness.settle();
 check(posts.map(post=>post.url),['/api/notifications/rules?scope=group%3Ag1','/api/notifications/rules?scope=group%3Ag1'],'"Try again" repeats the same request');
}

// ---- Wiring: right, navigator, route, scope tab, palette, help, step-up ----
{
 check([capabilities.canOpenAccessSection({permissions:['portal.notifications.manage']},'notification-channels'),capabilities.canOpenAccessSection({permissions:['*']},'notification-channels'),capabilities.canOpenAccessSection({permissions:['portal.users.manage']},'notification-channels')],[true,true,false],'the section needs the portal right');
 check(route.parseConsoleRoute('#settings/notification-channels'),{view:'settings',page:'notification-channels'},'the route');check(route.parseConsoleRoute('#administration/notifications'),{view:'settings',page:'notification-channels'},'the old link');
 check(route.consoleRouteHash({view:'settings',page:'notification-channels'}),'#settings/notification-channels','the hash');
 check(scopeTabs.fleetScopeTabs.find(tab=>tab.id==='notifications'),{id:'notifications',label:'fleet.config.notificationRules',group:'monitoring',scopes:['all','group','customer']},'the Monitoring subtab after Alert rules');
 check(['all','group','customer','unassigned'].map(type=>scopeTabs.scopeTabs(type).some(tab=>tab.id==='notifications')),[true,true,true,false],'on All devices, groups and customers');
 check([route.consoleRouteHash({view:'devices',tab:'notifications'}),route.consoleRouteHash({view:'devices',groupId:'g1',tab:'notifications'}),route.consoleRouteHash({view:'devices',customerId:'c1',tab:'notifications'})],['#devices/monitoring/notification-rules','#devices/group/g1/monitoring/notification-rules','#devices/customer/c1/monitoring/notification-rules'],'the tab is part of every scope link');
 const consoleSource=readFileSync('ui/shell/console.tsx','utf8'),page=navModel.navNode('settings.notification-channels');
 check([page.label,page.hint,page.icon,page.placement.group,page.section],['nav.settings.notificationChannels','nav.settings.notificationChannelsHint','Send','nav.settings.groupIntegrations','notification-channels'],'the navigator entry Notification channels in the Integrations group with the Send icon');
 check(page.palette.keywordsKey,'notifications.paletteKeywords','palette keywords');
 ok(/const multipleCustomers=data\?\.multipleCustomers===true;/.test(consoleSource)&&/\(multipleCustomers\|\|demo\?\{type:'customer'/.test(consoleSource),'the customer tab only once a second customer exists');
 check(translate('en','nav.settings.notificationChannelsHint'),'Send alarms by email, Microsoft Teams, Discord or webhook. Notification rules decide which alarms go to which channel.','the navigator hint');
 const topic=help.topicFor({view:'settings',page:'notification-channels'},'en');
 check([topic.title,topic.tips.length,topic.docs[0].file],['Notifications',4,'docs/notifications.md'],'the help topic of the page');
 check([topic.tips[0],topic.tips[3]],[translate('en','help.notifications.tip1'),'If your mailbox uses multi-factor authentication, choose the sign-in “Microsoft 365” or “Google Workspace”, or use an app password.'],'tip 1 stays, tip 4 names the modern sign-ins');
 check(help.topicFor({view:'devices',tab:'notifications'},'de').title,'Benachrichtigungen','and of the tab');
 ok(!/notificationChannel\w*StepUp|from '@\/lib\/step-up'/.test(readFileSync('ui/settings/notifications-panel.tsx','utf8')),'the page keeps no step-up list: no channel change asks for MFA first');
}

console.log(`PASS notifications view (${checks} checks): channel table, drawer fields per type with the stored-secret placeholder, one-time secret, failed test text, delivery log states, rules tab with direct and inherited rules, blocked reasons, empty states, demo, navigator, route, scope tab, palette and help, Save blocked while invalid from the first render, errors after change and blur, email Sign-in (Password, Microsoft 365, Google Workspace) with fields, errors, body and targets, viewers without the channel picker, tables that scroll inside their wrap.`);
