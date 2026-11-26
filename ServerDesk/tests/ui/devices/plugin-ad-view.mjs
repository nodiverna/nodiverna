// The AD sign-in UI for plugin changes (ui/devices/extensions/plugin-ad.tsx, docs/plugin-ad-sign-in.md),
// rendered with React SSR in English and German: the dialog (fields, autofocus, hints, the local
// variant, errors under the right field, the waiting state, demo), the poll with its 60 s limit,
// the flow (one dialog per directory before the confirmation, the resend once after
// PLUGIN_AD_SIGN_IN_REQUIRED, MFA first), the confirmation lines, the head chip and the
// "Server sign-ins" card (rows, empty, loading, error, demo). No network, no DOM.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const ad=await import('../../../ui/devices/extensions/plugin-ad.tsx');
const {runConsoleAction}=await import('../../../ui/shell/console-action.ts');
const forms=await import('../../../ui/devices/extensions/dhcp-forms.tsx');
const {devicesWithoutAdSession,adSessionForDevice}=await import('../../../lib/plugin-ad.ts');
const {demoDhcpSnapshot}=await import('../../../ui/shell/demo-dhcp.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const t=(key,params)=>translate('en',key,params),noop=()=>{};
const now=Date.UTC(2026,10,9,10);

const corp={kind:'domain',name:'corp.example',netbiosName:'CORP',sid:'S-1-5-21-1000-2000-3000'};
const other={kind:'domain',name:'corp.example',netbiosName:'CORP',sid:'S-1-5-21-7000-8000-9000'};
const wg={kind:'local',name:'WG1',netbiosName:'WG1',sid:'S-1-5-21-4000-5000-6000'};
const snapshot=directory=>({mode:'Management',agentCapabilities:['plugin-host','plugin-secrets','plugin-ad-identity'],security:{directory},plugins:[{name:'dhcp',target:'dhcp',version:'1.1.0',capabilities:['dhcp-read','dhcp-scope-create'],state:'ready',networkBlocked:true}]});
const device=(id,name,directory,extra={})=>({id,name,lastSeen:now-10_000,management:1,permissions:['dhcp.read','dhcp.manage'],snapshot:snapshot(directory),...extra});
const dc01=device('dc01','SRV-DC01',corp),dc02=device('dc02','SRV-DC02',corp),foreign=device('fx01','SRV-FX01',other),wg1=device('wg1','WG1',wg);
const session=(directory,account='CORP\\anna',extra={})=>({id:crypto.randomUUID(),directory:{kind:directory.kind,name:directory.name,sid:directory.sid},account,upn:null,source:'password',verifiedAt:now-60_000,expiresAt:now+3_600_000,...extra});

// ---- The dialog ----------------------------------------------------------------------------------
const form=(props={},locale='en')=>render(h(ad.PluginAdSignInForm,{device:dc01,directory:corp,plugin:'dhcp',demo:false,onDone:noop,onCancel:noop,...props}),locale);
let html=form(),shown=text(html);
ok(html.includes('<h2 class="sdx-confirm-title">Sign in to corp.example</h2>')&&html.includes('sdx-icon-tile'),'the icon tile and the title with the domain');
ok(shown.includes('Changes you make through an extension run with your AD account, so the server applies your AD rights and logs your name.')&&shown.includes('every server in corp.example'),'the body sentence names the benefit and the domain');
const account=html.match(/<input[^>]*name="account"[^>]*>/)?.[0]??'',password=html.match(/<input[^>]*name="password"[^>]*>/)?.[0]??'';
ok(/autofocus=""/i.test(account)&&/autocomplete="off"/i.test(account)&&/spellcheck="false"/i.test(account)&&!/maxlength/i.test(account),'Account: autofocus, no autocomplete, no spell check, no maxlength that cuts the input');
ok(/maxlength="256"/i.test(password),'Password: keeps its own maxlength');
ok(shown.includes('Account')&&shown.includes('DOMAIN\\name or name@corp.example'),'the account hint with the format');
ok(/type="password"/.test(password)&&/autocomplete="off"/i.test(password)&&/value=""/.test(password),'Password: masked, no autocomplete, never pre-filled');
ok(shown.includes('Wrong passwords count toward the lockout of this account.'),'the lockout line');
ok(/>Cancel</.test(html)&&/type="submit"[^>]*>(?:<[^>]+>)*<span>Sign in<\/span>/.test(html),'the footer: Cancel and the primary Sign in');
html=form({initial:{account:'CORP\\anna'}});
ok(/<input[^>]*name="account" value="CORP\\anna"/.test(html),'the account of this tab pre-fills the field');
html=form({device:wg1,directory:wg});shown=text(html);
ok(shown.includes('Sign in to WG1')&&shown.includes('WG1 is not in an AD domain, so changes you make through an extension run with a local Windows account of this server.')&&shown.includes('A local account of WG1, for example admin'),'the workgroup variant: the device, its sentence and its hint');
// Waiting: loading with "Checking on {device}…".
html=form({initial:{account:'anna',busy:true}});
ok(/aria-busy="true"/.test(html)&&text(html).includes('Checking on SRV-DC01…')&&/<input[^>]*readOnly=""[^>]*name="account"/i.test(html),'while it waits: the spinner, "Checking on SRV-DC01…" and read-only fields');
// Errors: under the field they belong to, the rest as a danger notice.
const wrong=ad.adSignInFailure({code:'AGENT_AD_SIGN_IN_FAILED'},t);
check(wrong,{field:'password',text:'The account or password is wrong. Check both and try again.'},'a wrong password goes under Password');
html=form({initial:{account:'CORP\\anna',failure:wrong}});
ok(/<input[^>]*aria-invalid="true"[^>]*name="password"/.test(html)&&/<p id="[^"]+" class="sdx-field-error">The account or password is wrong/.test(html)&&!/<input[^>]*aria-invalid[^>]*name="account"/.test(html),'the password field carries the error');
check(ad.adSignInFailure({messageKey:'apiError.pluginAd.accountInvalid',text:'Enter the account as DOMAIN\\name or name@domain.'},t).field,'account','a format error goes under Account');
check(ad.adSignInFailure({messageKey:'apiError.pluginAd.localOnDomain',text:'x'},t).field,'account','a local account on a domain server: Account');
check(ad.adSignInFailure({code:'AGENT_AD_LOCAL_ACCOUNT'},t),{field:'account',text:'This is a local account of the server. Use an account of the domain.'},'the device found a local account: Account');
check(ad.adSignInFailure({messageKey:'apiError.pluginAd.passwordRequired',text:'Enter the password.'},t).field,'password','no password: Password');
const locked=ad.adSignInFailure({code:'AGENT_AD_ACCOUNT_RESTRICTED',args:{account:'CORP\\anna'}},t);
check(locked,{field:'notice',text:'CORP\\anna cannot sign in now. It is disabled, locked, expired or outside its logon hours. Ask your AD administrator.'},'a restricted account is a notice with the account');
check(ad.adSignInFailure({code:'serverMessage.job.adSignInEnded'},t),{field:'notice',text:'The job was not sent because its AD sign-in has ended. Sign in again and repeat the change.'},'a stored server message');
html=form({initial:{account:'CORP\\anna',failure:locked}});
ok(/class="sdx-notice sdx-notice-danger" role="alert"/.test(html)&&text(html).includes('cannot sign in now'),'other failures: a danger notice in the dialog');
html=form({initial:{account:'x',failure:{field:'notice',text:t('pluginAd.error.timeout',{device:'SRV-DC01'})}}});
ok(text(html).includes('SRV-DC01 did not answer in time. It may be busy with another job. Try again in a moment.'),'the timeout text');
// An account over 256 characters: the client check stops the submit and the text shows under Account.
const tooLong=ad.adAccountPrecheck('a'.repeat(257),t);
check(tooLong,{field:'account',text:'The account can have at most 256 characters. Shorten it and try again.'},'the client check: 257 characters fail under Account');
check([ad.adAccountPrecheck('a'.repeat(256),t),ad.adAccountPrecheck('  '+'a'.repeat(256)+'  ',t),ad.adAccountPrecheck('CORP\\anna',t)],[null,null,null],'the client check: 256 characters (also with spaces around them) pass');
check(ad.adSignInFailure({messageKey:'apiError.pluginAd.accountTooLong',text:'x'},t).field,'account','the server answer accountTooLong: Account');
check(ad.adSignInFailure({messageKey:'apiError.pluginAd.signInRunning',text:'x'},t).field,'notice','the server answer signInRunning: the danger notice');
html=form({initial:{account:'a'.repeat(257),failure:tooLong}});
ok(/<input[^>]*aria-invalid="true"[^>]*name="account"/.test(html)&&/<p id="[^"]+" class="sdx-field-error">The account can have at most 256 characters\. Shorten it and try again\.<\/p>/.test(html)&&!/<input[^>]*aria-invalid[^>]*name="password"/.test(html)&&!/sdx-notice-danger/.test(html),'too long: the field error under Account, aria-invalid on Account only');
ok(new RegExp(`<input[^>]*name="account" value="${'a'.repeat(257)}"`).test(html),'too long: the typed account stays in full');
html=form({initial:{account:'a'.repeat(257),failure:ad.adAccountPrecheck('a'.repeat(257),(key,params)=>translate('de',key,params))}},'de');
ok(text(html).includes('Das Konto darf höchstens 256 Zeichen haben. Kürze es und versuche es erneut.')&&/<input[^>]*aria-invalid="true"[^>]*name="account"/.test(html),'too long in German');
// Demo: the submit stays visible and says why.
html=form({demo:true});
ok(/type="submit"[^>]*aria-disabled="true"/.test(html)&&text(html).includes('Not available for sample devices.'),'demo: the submit is blocked with its reason');
// German.
shown=text(form({},'de'));
ok(shown.includes('Bei corp.example anmelden')&&shown.includes('Konto')&&shown.includes('Passwort')&&shown.includes('Falsche Passwörter zählen für die Sperre dieses Kontos.')&&shown.includes('Anmelden'),'German dialog');

// ---- The poll ---------------------------------------------------------------------------------
{
 let clock=0,calls=0;
 const deps={sleep:async ms=>{clock+=ms;},clock:()=>clock};
 const active=await ad.pollAdSignIn('job',{...deps,get:async()=>(++calls<3?{state:'pending'}:{state:'active',session:session(corp)})});
 check([active.state,calls,clock],['active',3,3000],'every second until the job is no longer pending');
 clock=0;calls=0;
 const late=await ad.pollAdSignIn('job',{...deps,get:async()=>{calls++;return {state:'pending'};}});
 check([late.state,calls,clock],['timeout',60,60_000],'at most 60 s, then timeout');
 clock=0;
 check((await ad.pollAdSignIn('job',{...deps,get:async()=>({state:'failed',code:'AGENT_AD_SIGN_IN_FAILED'})})).code,'AGENT_AD_SIGN_IN_FAILED','a failure ends the poll with its code');
 check((await ad.pollAdSignIn('job',{...deps,alive:()=>false,get:async()=>{throw new Error('not called');}})).state,'timeout','a closed dialog stops polling');
}

// ---- The flow: one dialog per directory before the confirmation -----------------------------
check(devicesWithoutAdSession([dc01,dc02],[],now).map(item=>item.id),['dc01'],'two servers of one domain need one sign-in');
check(devicesWithoutAdSession([dc01,foreign],[],now).map(item=>item.id),['dc01','fx01'],'a partner with the same domain name but another SID needs its own');
check(devicesWithoutAdSession([dc01,foreign],[session(corp)],now).map(item=>item.id),['fx01'],'a sign-in covers its directory only');
check(devicesWithoutAdSession([dc01],[session(corp,'CORP\\anna',{expiresAt:now-1})],now).map(item=>item.id),['dc01'],'an ended sign-in does not count');
check(devicesWithoutAdSession([{...dc01,snapshot:{...dc01.snapshot,agentCapabilities:['plugin-host']}}],[],now),[],'an agent before 4.19.0 gets no dialog: the server names the reason');
check(adSessionForDevice([session({...corp,sid:corp.sid.toLowerCase()})],{security:{directory:corp}},now)?.account,'CORP\\anna','the SID matches case-insensitively');
{
 ad.primeAdSessions([]);
 const flow=ad.ensureAdSessions([dc01,foreign],'dhcp',now);
 await Promise.resolve();
 check(ad.currentAdSignIn(),{serverId:'dc01',plugin:'dhcp'},'the first dialog opens for the device');
 ad.finishRequest(true);await new Promise(resolve=>setTimeout(resolve,0));
 check(ad.currentAdSignIn(),{serverId:'fx01',plugin:'dhcp'},'then for the partner in the other directory');
 ad.finishRequest(true);
 check(await flow,true,'both signed in: the confirmation opens');
 const cancelled=ad.ensureAdSessions([dc01],'dhcp',now);await Promise.resolve();
 ad.finishRequest(false);
 check([await cancelled,ad.currentAdSignIn()],[false,null],'Cancel: no confirmation, nothing sent');
 ad.primeAdSessions([session(corp)]);
 check(await ad.ensureAdSessions([dc01,dc02],'dhcp',now),true,'with a sign-in the confirmation opens at once');
 check(ad.currentAdSignIn(),null,'and no dialog');
}

// ---- The resend after PLUGIN_AD_SIGN_IN_REQUIRED -----------------------------------------------
{
 const refusal=(code,params)=>new Response(JSON.stringify({error:'x',code,messageKey:code==='PLUGIN_AD_SIGN_IN_REQUIRED'?'apiError.pluginAd.signInRequired':'apiError.mfa.stepUpRequired',params}),{status:403,headers:{'Content-Type':'application/json'}});
 const run=async answers=>{
  const sent=[],opened=[],stepUps=[],errors=[],settled=[];
  const deps={demo:false,canOffboard:()=>true,post:async payload=>{sent.push(payload);return answers.shift()??new Response(JSON.stringify({id:'job'}),{status:200,headers:{'Content-Type':'application/json'}});},
   openStepUp:retry=>stepUps.push(retry),openAdSignIn:(serverId,plugin,retry)=>opened.push({serverId,plugin,retry}),toast:{success:noop,error:message=>errors.push(message)},onRemoved:noop,refresh:noop,setSaving:noop,locale:'en',onSettled:outcome=>settled.push(outcome)};
  deps.action=payload=>runConsoleAction(payload,deps,{endpoint:'/api/dhcp',plugin:'dhcp'});
  await deps.action({action:'change',serverId:'dc01',operation:'dhcp-scope-create',parameters:{},confirm:true});
  return {sent,opened,stepUps,errors,settled};
 };
 let result=await run([refusal('PLUGIN_AD_SIGN_IN_REQUIRED',{domain:'corp.example',serverId:'fx01'})]);
 check([result.sent.length,result.opened.map(item=>[item.serverId,item.plugin]),result.settled],[1,[['fx01','dhcp']],[]],'the dialog opens for the named device; the form stays');
 await result.opened[0].retry();
 check([result.sent.length,result.sent[1].operation,result.settled.map(item=>item.ok)],[2,'dhcp-scope-create',[true]],'after the sign-in the same request goes once more');
 result=await run([refusal('PLUGIN_AD_SIGN_IN_REQUIRED',{domain:'corp.example',serverId:'fx01'}),refusal('PLUGIN_AD_SIGN_IN_REQUIRED',{domain:'corp.example',serverId:'fx01'})]);
 await result.opened[0].retry();
 check([result.sent.length,result.opened.length,result.settled.map(item=>item.code)],[2,1,['PLUGIN_AD_SIGN_IN_REQUIRED']],'a second refusal shows its error and does not loop');
 result=await run([refusal('MFA_STEP_UP_REQUIRED',{})]);
 check([result.stepUps.length,result.opened.length],[1,0],'the MFA prompt keeps priority');
}

// ---- The confirmation names the account ------------------------------------------------------
{
 const dhcp=demoDhcpSnapshot(now);
 const context={device:{id:'dc01',name:'SRV-DC01'},snapshot:dhcp,collectedAt:now,partners:[],time:()=>'now',t};
 const change={operation:'dhcp-scope-create',parameters:{name:'Lab',startRange:'10.9.0.10',endRange:'10.9.0.200',subnetMask:'255.255.255.0'},label:'dhcp.op.scopeCreate'};
 let lines=forms.dhcpConfirmation(change,{...context,adAccounts:{device:'CORP\\anna'}},noop).lines;
 check(lines.at(-1),{label:'AD account',value:'CORP\\anna',mono:true},'the line "AD account" in the mono face');
 const relation=dhcp.ipv4.failover[0];
 const mirrored={operation:'dhcp-failover-remove',parameters:{name:relation.name,deletePartnerScopes:true},label:'dhcp.op.failoverRemove'};
 const partners=[{id:'fx01',name:'SRV-FX01',serverName:relation.partner,addresses:[]}];
 check(forms.dhcpChangePartner(mirrored.operation,mirrored.parameters,dhcp,partners).device?.id,'fx01','the partner device of a failover change');
 lines=forms.dhcpConfirmation(mirrored,{...context,partners,adAccounts:{device:'CORP\\anna',partner:'OTHER\\anna'}},noop).lines;
 check(lines.slice(-2),[{label:'AD account',value:'CORP\\anna',mono:true},{label:'AD account on SRV-FX01',value:'OTHER\\anna',mono:true}],'a partner in another directory adds its account');
 check(forms.dhcpConfirmation(change,context,noop).plugin,'dhcp','the confirmation names its plugin for the sign-in');
}

// ---- The head chip ------------------------------------------------------------------------------
{
 const viewer={id:'v',label:'v@example.test',permissions:[]};
 const gate={permission:'dhcp.manage',rightKey:'dhcp.blocked.manageRight'};
 const chip=(props={},locale='en')=>render(h(ad.PluginAccountChip,{server:dc01,viewer,demo:false,now,plugin:'dhcp',gate,devices:[dc01],...props}),locale);
 ad.primeAdSessions([]);
 html=chip();
 ok(/class="sdx-btn sdx-btn-ghost"/.test(html)&&text(html).includes('Sign in with AD account')&&!/aria-disabled/.test(html),'not signed in: the ghost button names the method');
 ok(text(chip({demo:true})).includes('Not available for sample devices.'),'1. demo');
 const noRight={...dc01,permissions:['dhcp.read']};
 ok(text(chip({server:noRight,devices:[noRight,dc02]})).includes('You need the permission Manage DHCP on this device.'),'2. the right, when the viewer manages DHCP elsewhere');
 check(chip({server:noRight,devices:[noRight]}),'','hidden for a viewer who manages DHCP nowhere');
 ok(text(chip({server:{...dc01,lastSeen:now-3_600_000}})).includes('is offline')||/aria-disabled="true"/.test(chip({server:{...dc01,lastSeen:now-3_600_000}})),'3. offline');
 ok(text(chip({server:{...dc01,snapshot:{...dc01.snapshot,agentCapabilities:['plugin-host']}}})).includes('To change this server through an extension, update the agent on SRV-DC01 to 4.19.0 or later.'),'4. an agent without plugin-ad-identity');
 ad.primeAdSessions([session(corp,'CORP\\anna',{expiresAt:Date.UTC(2026,10,9,14,30)})]);
 html=chip();shown=text(html);
 ok(/class="sdx-btn sdx-btn-ghost sdx-ad-chip-trigger"/.test(html)&&/<span class="mono">CORP\\anna<\/span>/.test(html)&&/until \d{1,2}:30/.test(shown)&&/aria-label="AD account: CORP\\anna, until [^"]+"/.test(html),'signed in: the menu trigger with the account and its end');
 ok(/until \d{1,2}:30|bis \d{1,2}:30/.test(text(chip({},'de')))&&text(chip({},'de')).includes('bis'),'German chip');
 ok(fs.readFileSync('ui/devices/extensions/plugin-ad.css','utf8').includes('animation: sdx-fade var(--sd-dur)'),'the states cross-fade with the shared keyframe');
}

// ---- The account card ---------------------------------------------------------------------------
{
 const card=(props={},locale='en')=>render(h(ad.ServerSignInsCard,{demo:false,now,...props}),locale);
 ad.primeAdSessions([session(corp,'CORP\\anna',{expiresAt:Date.UTC(2026,10,9,14,30)}),session(wg,'WG1\\admin',{source:'entra'}),session(corp,'CORP\\old',{expiresAt:now-1})]);
 html=card();shown=text(html);
 ok(shown.includes('Server sign-ins')&&shown.includes('Changes you make to a server through an extension, such as DHCP or DNS, run with your AD account. If you are not signed in for that server yet, Nodiverna asks you to sign in. Here you see your current sign-ins and can end them. Each sign-in ends when you sign out of Nodiverna, or after 8 hours at the latest.'),'the card head');
 const head=html.match(/<div class="sdx-section-head-text">.*?<\/div>/)?.[0]??'';
 ok(head.includes(`<p>${t('pluginAd.account.description')}</p>`)&&!/sdx-section-head-meta/.test(head),'the card head shows pluginAd.account.description as its description');
 ok(/<strong class="mono">CORP\\anna<\/strong>/.test(html)&&/corp\.example · until \d{1,2}:30/.test(shown)&&shown.includes('Password')&&shown.includes('Entra ID'),'rows: account, domain, end and source');
 ok(!shown.includes('CORP\\old'),'an ended sign-in is not listed');
 ok(/aria-label="Sign out of corp\.example as CORP\\anna"/.test(html),'each row has its sign-out button');
 ok(fs.readFileSync('ui/devices/extensions/plugin-ad.css','utf8').includes('.sdx-ad-row-leaving { grid-template-rows: 0fr; opacity: 0;'),'a signed-out row fades and collapses');
 ad.primeAdSessions([]);
 ok(text(card()).includes('No server sign-ins')&&text(card()).includes('Nodiverna asks for your AD account the first time you change a server through an extension.'),'the empty state');
 ok(text(card({demo:true})).includes('No server sign-ins'),'demo: the empty state');
 ad.primeAdSessions(null,{loading:true});
 ok(/role="status"/.test(card())&&card().includes('sdx-skeleton'),'loading: the skeleton');
 ad.primeAdSessions(null,{error:'boom'});
 html=card();
 ok(text(html).includes('The server sign-ins could not be loaded. Try again.')&&text(html).includes('Try again'),'a failure: the danger notice with Try again');
 ad.primeAdSessions([session(corp)]);
 ok(text(card({},'de')).includes('Server-Anmeldungen')&&text(card({},'de')).includes('Passwort'),'German card');
}

// ---- Help and palette -------------------------------------------------------------------------
ok(/tips:\['help\.dhcp\.tip1','help\.dhcp\.tip2','help\.dhcp\.tip3'\]/.test(fs.readFileSync('ui/shell/help-panel.tsx','utf8')),'the DHCP help topic has tip 3');
ok(/id:'device-ad-sign-in'[^\n]*label:t\('palette\.pluginAdSignIn'\)[^\n]*\n\s*keywords:'ad sign in account domain'/.test(fs.readFileSync('ui/shell/console.tsx','utf8')),'the palette item');

console.log(`PASS plugin AD view (${checks} checks): the sign-in dialog (fields, hints, local variant, errors per field, waiting, timeout, demo, German), the poll, the flow before the confirmation and the resend once, the confirmation lines, the head chip and the account card.`);
