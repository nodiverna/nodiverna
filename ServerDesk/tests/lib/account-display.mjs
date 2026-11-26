// Account names where people read them: the shared rule of
// lib/account-display.ts (and its SQL twin lib/server/identity/account-names.ts) never shows
// the internal values of an account (entra.<oid>, <oid>@<tid>.entra.serverdesk.invalid,
// entra:<tid>:<oid>, <uuid>@local.serverdesk.invalid, local:<uuid>). Unit
// tests of the rule; React SSR of the account menu, the Entra account page,
// the Entra session gate, the Microsoft sign-in only card and the account
// texts of Settings → Accounts and groups, the maintenance trigger and the
// access panel fallback; then the server side on an isolated PostgreSQL
// database: the SQL twin agrees with the rule, the owner names of terminal
// and RDP sessions, the maintenance history and the audit view.
import {mock} from '../support/register.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as radix from 'radix-ui';
import {entraFixture,tenant} from '../support/entra-fixture.mjs';
import {sql} from '../../runtime/database.mjs';

mock('radix-ui',{...radix,DropdownMenu:{...radix.DropdownMenu,Portal:({children})=>children}});
const h=React.createElement;
const {isInternalAccountValue,accountName,accountDetail,storedActorName}=await import('../../lib/account-display.ts');
const {LocaleProvider}=await import('../../ui/base/locale.tsx');
const {translate}=await import('../../lib/i18n/translate.ts');
const shell=await import('../../ui/shell/shell.tsx');
const {EntraProfileCard}=await import('../../ui/account/account-panel.tsx');
const {default:SessionGate,SessionAccountLine}=await import('../../ui/session/session-gate.tsx');
const entraPanel=await import('../../ui/settings/entra-settings-panel.tsx');
const rbacText=await import('../../ui/settings/rbac-account-text.ts');
const {triggerLabel}=await import('../../ui/settings/maintenance-panel.tsx');
const {subjectLabel}=await import('../../ui/settings/rbac-model.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const t=(key,params)=>translate('en',key,params),de=(key,params)=>translate('de',key,params);
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const menu=(viewer,locale='en')=>render(h(shell.AccountMenu,{viewer,saving:false,onAccount:()=>{},onSignOut:()=>{},open:true}),locale);

const oid='f3edb82d-2a35-4f00-b324-0012d5fa6699';
const internal={username:'entra.'+oid,label:`${oid}@${tenant}.entra.serverdesk.invalid`,principal:`entra:${tenant}:${oid}`};
/** Markup that names the account never carries one of its internal values. */
const clean=(html,label)=>{for(const needle of ['entra.'+oid,'.serverdesk.invalid','entra:'+tenant])ok(!html.includes(needle),`${label}: no ${needle}`);};
const entraViewer=(email='ada@contoso.example',extra={})=>({id:'u1',userId:'u1',...internal,displayName:'Ada Lovelace',identitySource:'entra',entra:{tenantId:tenant,objectId:oid,email},...extra});
const localViewer={id:'u2',userId:'u2',label:'9b1c@local.serverdesk.invalid',username:'anna',displayName:'Anna Admin',principal:'local:9b1c',identitySource:'local'};

// ---- The rule ------------------------------------------------------------------------------------
{
 for(const value of [`${oid}@${tenant}.entra.serverdesk.invalid`,'9B1C@LOCAL.SERVERDESK.INVALID','entra:'+tenant+':'+oid,'local:9b1c','private:9b1c@local.serverdesk.invalid','entra.'+oid,'ENTRA.'+oid.toUpperCase(),' entra.'+oid+' '])
  check(isInternalAccountValue(value),true,`internal: ${value}`);
 for(const value of ['','  ','ada@contoso.example','anna','entra.anna','entra.','private:ada@contoso.example','System','cli',null,undefined])
  check(isInternalAccountValue(value),false,`not internal: ${String(value)}`);
 check(accountName({displayName:'Ada Lovelace',username:internal.username,email:'ada@contoso.example'}),'Ada Lovelace','display name first');
 check(accountName({displayName:'  Ada  ',username:internal.username,email:''}),'Ada','the display name trimmed');
 check(accountName({displayName:'   ',username:internal.username,email:'ada@contoso.example'}),'ada@contoso.example','a blank display name falls back to the email');
 check(accountName({displayName:'',username:internal.username,email:''}),'','an Entra account without display name and email has no name');
 check(accountName({displayName:internal.label,username:internal.username,email:internal.label}),'','internal values are never a name');
 check(accountName({displayName:'',username:'anna',email:''}),'anna','a local account falls back to its username');
 check(accountName({displayName:'Anna Admin',username:'anna',email:'anna@example.test'}),'Anna Admin','a local account leads with its display name');
 check(accountName({}),'','nothing given');
 check(accountDetail({identitySource:'entra',username:internal.username,email:'ada@contoso.example'}),'ada@contoso.example','Entra detail: the email');
 check(accountDetail({identitySource:'entra',username:internal.username,email:''}),'','Entra detail without an email: nothing');
 check(accountDetail({identitySource:'entra',username:internal.username,email:null}),'','Entra detail with a null email: nothing');
 check(accountDetail({identitySource:'local',username:'anna',email:'anna@example.test'}),'anna','local detail: the username, as before');
 check(accountDetail({username:'anna'}),'anna','no identity source: the username');
 check([storedActorName('private:ada@contoso.example'),storedActorName('System'),storedActorName('cli'),storedActorName(internal.label),storedActorName(internal.principal),storedActorName('private:9b1c@local.serverdesk.invalid'),storedActorName(null),storedActorName('')],
  ['ada@contoso.example','System','cli',null,null,null,null,''],'stored values without an account: private: as the email, internal as null, others unchanged');
}

// ---- Account menu --------------------------------------------------------------------------------
{
 const withEmail=menu(entraViewer());clean(withEmail,'menu, Entra with email');
 const roleLine=html=>html.match(/<small class="sdx-account-roles">([^<]*)<\/small>/)?.[1];
 ok(withEmail.includes('<strong>Ada Lovelace</strong>')&&withEmail.includes('<small>ada@contoso.example</small>')&&roleLine(withEmail)===t('shell.role.none'),'Entra with email: the name, the email and the role line');
 const noEmail=menu(entraViewer('',{roles:['Owner']}));clean(noEmail,'menu, Entra without email');
 ok(!/<small>[^<]*@/.test(noEmail)&&roleLine(noEmail)==='Owner','Entra without email: the role line only');
 const german=menu(entraViewer(''),'de');clean(german,'menu, German');
 ok(roleLine(german)===de('shell.role.none')&&de('shell.role.none')==='Keine Rolle','German: "Keine Rolle"');
 const local=menu({...localViewer,roles:['Operators','Owner']});clean(local,'menu, local');
 ok(local.includes('<strong>Anna Admin</strong>')&&local.includes('<small>anna</small>')&&roleLine(local)==='Operators, Owner','local: the username line and the role names');
 check(shell.displayNameOf(entraViewer('',{displayName:''})),'','no display name and no email: no name, never entra.<oid>');
 check(shell.displayNameOf(entraViewer('ada@contoso.example',{displayName:''})),'ada@contoso.example','no display name: the email');
 check(shell.displayNameOf({...localViewer,displayName:''}),'anna','local without display name: the username');
 const nameless=menu(entraViewer('',{displayName:''}));clean(nameless,'menu, nameless');
 ok(nameless.includes('>SD<')&&!nameless.includes('<strong>'),'nameless: initials SD and no name line');
 const topbar=render(h(shell.Topbar,{viewer:entraViewer(),saving:false,navigatorOpen:false,canToggleNavigator:false,onToggleNavigator:()=>{},onSearch:()=>{},onRefresh:()=>{},loading:false,status:'',onHelp:()=>{},onAccount:()=>{},onSignOut:()=>{}}));
 clean(topbar,'top bar');
 ok(topbar.includes(`aria-label="${t('shell.accountLabel',{name:'Ada Lovelace'})}"`)&&topbar.includes('title="Ada Lovelace"')&&topbar.includes('>AL<'),'avatar button: name in aria-label and title, initials AL');
 const anonymous=render(h(shell.Topbar,{viewer:entraViewer('',{displayName:''}),saving:false,navigatorOpen:false,canToggleNavigator:false,onToggleNavigator:()=>{},onSearch:()=>{},onRefresh:()=>{},loading:false,status:'',onHelp:()=>{},onAccount:()=>{},onSignOut:()=>{}}));
 clean(anonymous,'top bar, nameless');
 ok(anonymous.includes(`aria-label="${t('shell.myAccount')}"`)&&!/class="sdx-avatar-btn"[^>]*title=/.test(anonymous)&&anonymous.includes('>SD<'),'nameless avatar button: "My account", no title, initials SD');
}

// ---- My account and the session gate -------------------------------------------------------------
{
 for(const locale of ['en','de']){
  const page=render(h(EntraProfileCard,{viewer:entraViewer()}),locale);clean(page,`account page ${locale}`);
  ok(page.includes('<dd>Ada Lovelace</dd>')&&page.includes('<dd>ada@contoso.example</dd>')&&page.includes('>AL<'),`account page ${locale}: name, email fact and initials`);
  ok(text(page).includes(oid)&&text(page).includes(tenant),`account page ${locale}: the labelled Tenant ID and Object ID facts stay`);
 }
 const noEmail=render(h(EntraProfileCard,{viewer:entraViewer('')}));clean(noEmail,'account page without email');
 ok(noEmail.includes('<dd>Ada Lovelace</dd>')&&noEmail.includes(`<dt>${t('account.profile.email')}</dt><dd>—</dd>`),'account page without email: the email fact shows the dash');
 // The session card shows while the session check runs (every console load); after the session ended the sign-in card follows.
 for(const locale of ['en','de']){
  const loading=render(h(SessionGate,{viewer:entraViewer()},h('main',null,'console')),locale);clean(loading,`session card while checking ${locale}`);
  ok(/<p class="sd-session-account" title="ada@contoso.example">Ada Lovelace · ada@contoso.example<\/p>/.test(loading)&&!loading.includes('>console<'),`session card while checking ${locale}: name · email, the email as title`);
 }
 const line=viewer=>render(h(SessionAccountLine,{viewer}));
 const noEmailLine=line(entraViewer(''));clean(noEmailLine,'session card without email');
 check(noEmailLine,'<p class="sd-session-account">Ada Lovelace</p>','session card without email: the name only, no title');
 const emailName=line(entraViewer('ada@contoso.example',{displayName:''}));clean(emailName,'session card, email as name');
 check(emailName,'<p class="sd-session-account" title="ada@contoso.example">ada@contoso.example</p>','session card: the email is not repeated when it is the name');
 check(line(entraViewer('',{displayName:''})),'<p class="sd-session-account">—</p>','session card, nameless: the empty value');
 check(line(localViewer),'<p class="sd-session-account" title="anna">Anna Admin · anna</p>','local session card: display name · username, title username, as before');
 check(line({...localViewer,displayName:'anna'}),'<p class="sd-session-account" title="anna">anna</p>','local session card: no repeat when the display name is the username');
}

// ---- Microsoft sign-in only card -----------------------------------------------------------------
{
 const view={tenantId:tenant,clientId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',credentialKind:'secret',secretSaved:true,privateKeySaved:false,certificate:null,enabled:true,configured:true,redirectUri:'https://portal.example/api/auth/entra/callback',applicationIdUri:null,apiScope:'access_as_user',revision:3,lastTest:{at:1,result:'ok',current:true},mappings:[],accounts:1,lastSignInAt:null,roles:[],deviceGroups:[],
  directoryCheck:{state:'off',result:null,lastRunAt:null,lastOkAt:null,nextRunAt:null,checked:0,locked:0,groupChanges:0,remaining:0,keptOwners:[]},graphPermissions:[],
  entraOnly:{enabled:true,since:Date.now()-86_400_000,by:'Ada Lovelace',lockedAccounts:2},emergency:{account:{id:'e',username:'emergency',displayName:'Emergency',authenticator:true,passkeys:0},candidates:[],lastSignInAt:null,openAlarms:0},switchChecks:{signIn:true,emergency:true,viewerEntraOwner:true,mailChannel:true}};
 const only=by=>render(h(entraPanel.EntraOnlyCard,{view:{...view,entraOnly:{...view.entraOnly,by}},demo:false,now:Date.now(),change:{busy:null,dispatch:()=>{},dialog:null,locked:undefined}}));
 const named=only('Ada Lovelace');clean(named,'sign-in only card');
 ok(text(named).includes(`${t('entra.only.by')} Ada Lovelace`),'the By fact shows the display name');
 ok(text(only(null)).includes(`${t('entra.only.by')} —`),'no name: the By fact shows —');
}

// ---- Accounts and groups -------------------------------------------------------------------------
{
 const entra={username:internal.username,email:'ada@contoso.example',displayName:'Ada Lovelace',identitySource:'entra'};
 const entraNoEmail={...entra,email:''},local={username:'anna',email:'anna@example.test',displayName:'Anna Admin',identitySource:'local'},localNoEmail={...local,email:null};
 const all=[];
 const lines=(user,self)=>{const value=rbacText.rbacAccountLines(user,self,t);all.push(...value);return value;};
 check(lines(entra,false),['ada@contoso.example'],'Entra row: the email once, no username line');
 check(lines(entra,true),[t('rbac.currentAccount',{username:'ada@contoso.example'})],'own Entra row: "<email> · current account", the email not repeated');
 check(lines(entraNoEmail,true),[t('rbac.currentAccountNoDetail')],'own Entra row without email: "Current account"');
 check([t('rbac.currentAccountNoDetail'),de('rbac.currentAccountNoDetail')],['Current account','Aktuelles Konto'],'the new key in both catalogs');
 check(lines(entraNoEmail,false),[],'Entra row without email: no second line');
 check(lines(local,false),['anna','anna@example.test'],'local row: username and email, as before');
 check(lines(local,true),[t('rbac.currentAccount',{username:'anna'}),'anna@example.test'],'own local row: as before');
 check(lines(localNoEmail,false),['anna'],'local row without email: the username');
 const options=[rbacText.rbacAccountOption(entra),rbacText.rbacAccountOption(entraNoEmail),rbacText.rbacAccountOption(local)];all.push(...options);
 check(options,['Ada Lovelace · ada@contoso.example','Ada Lovelace','Anna Admin · anna'],'select options: <name> · <email>, <name> alone, local unchanged');
 const members=[rbacText.rbacMemberLine(entra,'Active'),rbacText.rbacMemberLine(entraNoEmail,'Active'),rbacText.rbacMemberLine(local,'Active')];all.push(...members);
 check(members,['ada@contoso.example · Active','Active','anna · Active'],'member lines: <email> · <status>, <status> alone, local unchanged');
 const params=[rbacText.rbacAccountParam(entra),rbacText.rbacAccountParam({...entra,displayName:''}),rbacText.rbacAccountParam(local)];all.push(...params);
 check(params,['Ada Lovelace','ada@contoso.example','anna'],'sentence parameters: the Entra name, the local username');
 check([rbacText.rbacAccountName(entra),rbacText.rbacAccountName({...entraNoEmail,displayName:''}),rbacText.rbacAccountName(local),rbacText.rbacAccountName({...local,displayName:''})],['Ada Lovelace','—','Anna Admin','anna'],'row names');
 clean(all.join('\n'),'account texts');
 const source=readFileSync('ui/settings/settings-accounts.tsx','utf8');
 ok(!source.includes("{principalLabel(user)} · {user.username}")&&!source.includes('`${user.username} · ${statusLabel')&&!source.includes("{value:user?.username??id")&&!source.includes("{username:user.username}):t('rbac.disableAccount"),'the account list no longer prints the username of Entra accounts');
 ok(source.includes("`${user.username} ${user.displayName} ${user.email??''} ${statusLabel(user.status,locale)}`"),'search still matches the username');
}

// ---- Maintenance trigger and the missing-subject fallback -------------------------------------------
{
 check(triggerLabel({trigger:'manual',requestedBy:null},t),t('maintenancePage.trigger.manual',{name:'—'}),'Run now without a name: —');
 check(triggerLabel({trigger:'manual',requestedBy:'Ada Lovelace'},t),t('maintenancePage.trigger.manual',{name:'Ada Lovelace'}),'Run now by the name');
 // A role assignment of an account or user group that no longer exists names that fact (the classic group panel with
 // its own principal fallback is deleted).
 check(subjectLabel({subjectType:'user',subjectId:'local:9b1c'},{users:[],userGroups:[]},'en'),t('rbac.subject.accountGone'),'a missing account: Account that no longer exists');
 check(subjectLabel({subjectType:'group',subjectId:'g'},{users:[],userGroups:[]},'en'),t('rbac.subject.groupGone'),'a missing user group');
 check(existsSync('app/access-panel.tsx'),false,'app/access-panel.tsx does not exist');
}

// ---- Server: the SQL twin, sessions, maintenance and audit ---------------------------------------
const f=await entraFixture(),{d}=f;
try{
 const names=f.load('lib/server/identity/account-names.ts'),auditScope=f.load('lib/server/audit-scope.ts');
 const at=Date.now();
 const user=row=>d.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at,identity_source,entra_tenant_id,entra_object_id) VALUES(${row.id},${row.username},${row.email},${row.display_name},${row.auth_principal},${row.auth_email},'active',1,${at},${at},${row.identity_source},${row.entra_tenant_id??null},${row.entra_object_id??null})`);
 const ada={id:crypto.randomUUID(),username:internal.username,email:'ada@contoso.example',display_name:'Ada Lovelace',auth_principal:internal.principal,auth_email:internal.label,identity_source:'entra',entra_tenant_id:tenant,entra_object_id:oid};
 const otherOid='0d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5e';
 const grace={id:crypto.randomUUID(),username:'entra.'+otherOid,email:'grace@contoso.example',display_name:'',auth_principal:`entra:${tenant}:${otherOid}`,auth_email:`${otherOid}@${tenant}.entra.serverdesk.invalid`,identity_source:'entra',entra_tenant_id:tenant,entra_object_id:'0d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5e'};
 const localId=crypto.randomUUID(),anna={id:localId,username:'anna',email:'',display_name:'Anna Admin',auth_principal:'local:'+localId,auth_email:localId+'@local.serverdesk.invalid',identity_source:'local'};
 for(const row of [ada,grace,anna])await user(row);
 const unknown=`entra:${tenant}:11111111-0000-4000-8000-000000000000`;

 // The SQL twin agrees with the rule for every value of the unit tests.
 const values=[`${oid}@${tenant}.entra.serverdesk.invalid`,'9B1C@LOCAL.SERVERDESK.INVALID','entra:x','LOCAL:x','entra.'+oid,'ENTRA.'+oid.toUpperCase(),' entra.'+oid+' ','','  ','ada@contoso.example','anna','entra.anna','private:ada@contoso.example','private:9b1c@local.serverdesk.invalid','System'];
 for(const value of values){
  const row=await d.one(sql`SELECT ${names.internalAccountSql(sql`${value}::text`)} AS internal,${names.storedActorNameSql(sql`${value}::text`)} AS stored`);
  check([row.internal,row.stored],[isInternalAccountValue(value),storedActorName(value)],`SQL twin agrees: ${JSON.stringify(value)}`);
 }

 // Terminal and RDP sessions name their owner through accountNamesOf.
 const owners=await names.accountNamesOf([ada.auth_principal,grace.auth_principal,anna.auth_principal,unknown,'private:old@example.test',ada.auth_principal]);
 check([owners.get(ada.auth_principal),owners.get(grace.auth_principal),owners.get(anna.auth_principal),owners.get(unknown),owners.get('private:old@example.test'),owners.size],
  ['Ada Lovelace','grace@contoso.example','Anna Admin',null,'old@example.test',5],'session owners: display name, else email, the local display name, null for an unknown entra: principal, the legacy private: email');
 check((await names.accountNamesOf([ada.auth_email,ada.id])).get(ada.id),'Ada Lovelace','an account is also found by its auth email and its ID');
 check((await names.accountNamesOf([])).size,0,'no values: no query');
 const terminal=readFileSync('lib/server/devices/terminal-sessions.ts','utf8'),rdp=readFileSync('lib/server/devices/rdp.ts','utf8');
 ok(terminal.includes('owners=await accountNamesOf(active.results.map(s=>s.principal))')&&terminal.includes('owner:owners.get(s.principal)??null')&&!terminal.includes("owner:s.principal.startsWith('private:')"),'the terminal session list takes its owners from accountNamesOf');
 ok(rdp.includes('owners=await accountNamesOf(rows.results.map(r=>r.principal))')&&rdp.includes('owner:owners.get(s.principal)??null')&&!rdp.includes("owner:s.principal.startsWith('private:')"),'the RDP metadata takes its owners from accountNamesOf');

 // The audit view: an empty display name falls back to the email, never to entra.<oid>.
 await d.exec(sql`INSERT INTO audit(at,actor,action,target) VALUES(${at},${grace.auth_email},'account-display-test','a'),(${at},${ada.auth_principal},'account-display-test','b'),(${at},${unknown},'account-display-test','c'),(${at},'System','account-display-test','d'),(${at},${anna.id},'account-display-test','e')`);
 const audit=await d.query(sql`${auditScope.auditSelect} WHERE a.action='account-display-test' ORDER BY a.target`);
 check(audit.map(row=>row.actor),['grace@contoso.example','Ada Lovelace','','System','Anna Admin'],'audit actors: email for an empty display name, the name, empty for an unknown internal actor, System unchanged');
 clean(JSON.stringify(audit),'audit view');
 const stored=await d.query(sql`SELECT actor FROM audit WHERE action='account-display-test' ORDER BY target`);
 check(stored.map(row=>row.actor),[grace.auth_email,ada.auth_principal,unknown,'System',anna.id],'the stored audit actors stay');

 // The maintenance history names the account that started a run.
 const owner=await f.localAccount('maintenance-owner@local.test',['*']);
 await d.exec(sql`UPDATE role_assignments SET role_id='builtin-owner' WHERE id=${owner.assignmentId}`);
 const maintenance=f.load('lib/server/maintenance.ts');
 await d.exec(sql`INSERT INTO maintenance_runs(started_at,finished_at,status,trigger,requested_by) VALUES(${at-3000},${at-2000},'succeeded','manual',${ada.auth_email}),(${at-2000},${at-1000},'succeeded','manual',${`99999999-0000-4000-8000-000000000000@${tenant}.entra.serverdesk.invalid`}),(${at-1000},${at},'succeeded','schedule',NULL)`);
 const view=await maintenance.maintenanceView(owner.actor);
 check(view.history.slice(0,3).map(run=>[run.trigger,run.requestedBy]),[['schedule',null],['manual',null],['manual','Ada Lovelace']],'maintenance history: the display name, null for an unknown internal label');
 clean(JSON.stringify(view),'maintenance view');
 check((await d.query(sql`SELECT requested_by FROM maintenance_runs WHERE trigger='manual' ORDER BY started_at`)).map(row=>row.requested_by),[ada.auth_email,`99999999-0000-4000-8000-000000000000@${tenant}.entra.serverdesk.invalid`],'the stored requested_by stays');
}finally{await d.close();}

console.log(`PASS account display (${checks} checks): the shared rule and its SQL twin, the account menu, My account, the Entra session gate, the Microsoft sign-in only card, the account texts of Accounts and groups, the maintenance trigger, the access panel fallback, session owners, the maintenance history and the audit view never show an internal account value.`);
