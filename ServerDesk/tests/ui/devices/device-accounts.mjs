// Management → Accounts on the kit (ui/devices/management/device-accounts.tsx), run on hook cells
// (tests/support/panel-harness.mjs): cell 0 holds the search and the Deactivated filter, cell 1 the
// open form, cell 2 the field error. German SSR plus one English render: the sr-only head, the KPI
// tiles with the Deactivated filter, the focusable table regions, the subtitle without a leading
// dot, one row Menu per user and no per-row buttons, the blocked reasons (demo, domain controller,
// saving), the Drawer forms with Fields, and the confirmations of all six actions with the payloads
// the classic ManagementPanel sent.
import assert from 'node:assert/strict';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
const harness=panelHarness({hooked:['ui/devices/management/device-accounts.tsx']});
const {load,walk}=harness;
const Accounts=load('ui/devices/management/device-accounts.tsx').default;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();

const now=1800000000000,viewer={id:'owner',label:'Owner',permissions:['*']};
const kinds=['create-local-user','set-local-user','reset-local-password','delete-local-user','local-group-add','local-group-remove'];
const users=[
 {name:'Administrator',sid:'S-1-5-21-1-500',enabled:true,fullName:'',description:'Built-in account for administering the computer',passwordExpires:false,lastLogon:null},
 {name:'Gast',sid:'S-1-5-21-1-501',enabled:false,fullName:'',description:'Integriertes Gastkonto',passwordExpires:false,lastLogon:null},
 {name:'ops',sid:'S-1-5-21-1-1001',enabled:true,fullName:'Ops Team',description:'',passwordExpires:true,lastLogon:null},
];
const groups=[{name:'Administratoren',sid:'S-1-5-32-544',members:['Administrator','ops']},{name:'Benutzer',sid:'S-1-5-32-545',members:[]}];
const server={id:'device',name:'WINDOWS-SRV',lastSeen:now-1000,management:1,revoked:0,snapshot:{mode:'Management',localUsers:users,localGroups:groups,agentCapabilities:kinds,security:{domainRole:3}}};
let confirmations=[];
const props={server,viewer,demo:false,saving:false,now,onConfirm:value=>confirmations.push(value)};
const reset=(states)=>{harness.reset(states);confirmations=[];};
const tree=(overrides={})=>harness.tree(Accounts,{...props,...overrides});
const html=(overrides={})=>harness.html(Accounts,{...props,...overrides});
const kpi=(element,label)=>walk(element).find(item=>item.props.label===label&&'value' in item.props);
const menus=element=>walk(element).filter(item=>Array.isArray(item.props.entries));
const form=element=>walk(element).find(item=>item.type==='form');
// The kit Select (forwardRef) counts as a select.
const input=(element,name)=>walk(element).find(item=>(item.type==='input'||item.type==='select'||item.type?.render?.name==='Select')&&item.props.name===name);
const submit=element=>form(element).props.onSubmit({preventDefault(){}});
const btn=(element,label)=>walk(element).find(item=>item.props.onClick&&harness.text(item).trim()===label);

// ---- Head, KPI row, tables ----
reset();let markup=html();
ok(/<h2 class="sr-only">Konten<\/h2>/.test(markup),'the subarea name is only the accessible heading');
check((markup.match(/>Konten</g)||[]).length,1,'no visible duplicate title');
ok(text(markup).includes(de('accounts.description'))&&text(markup).includes('3 Benutzer')&&text(markup).includes('2 Gruppen'),'description and the two meta items');
let root=tree();
check(['Lokale Benutzer','Deaktiviert','Administratoren','Lokale Gruppen'].map(label=>kpi(root,label)?.props.value),[3,1,2,2],'the KPI values: users, deactivated, Administrators by SID, groups');
ok(kpi(root,'Lokale Benutzer').props.detail==='2 aktiv','the active count');
ok(kpi(root,'Deaktiviert').props.pressed===false&&kpi(root,'Deaktiviert').props.hint===de('accounts.showDisabled'),'the Deactivated filter tile, not pressed');
ok(/aria-pressed="false"/.test(markup),'the filter tile is a toggle button');
kpi(root,'Deaktiviert').props.onSelect();root=tree();markup=html();
ok(/aria-pressed="true"/.test(markup)&&harness.table(root,'Lokale Benutzer').props.rows.map(user=>user.name).join()==='Gast','pressed: only the deactivated users');
kpi(root,'Deaktiviert').props.onSelect();root=tree();
check(harness.table(root,'Lokale Benutzer').props.rows.length,3,'pressed again: all users');
reset();markup=html();
ok(/role="region" aria-label="Lokale Benutzer" tabindex="0"/.test(markup)&&/role="region" aria-label="Lokale Gruppen" tabindex="0"/.test(markup),'both tables are labelled, focusable regions');
ok(!markup.includes('table-container')&&!markup.includes('count-chip')&&!markup.includes('class="panel'),'no shadcn table, no count chip, no classic panel');
ok(text(markup).includes('Integriertes Gastkonto')&&!/·\s*Integriertes Gastkonto/.test(text(markup)),'"Integriertes Gastkonto" without a leading dot');
ok(text(markup).includes('Ops Team')&&!text(markup).includes('Ops Team ·'),'a full name alone has no trailing dot');
ok(text(markup).includes('S-1-5-32-544')&&text(markup).includes(de('management.groups.noMembers')),'groups: the SID and "no members"');
ok(text(markup).includes('3 von 3 Benutzern'),'the foot');
ok(/<th scope="col" class="sdx-col-actions"><span class="sr-only">Aktionen<\/span><\/th>/.test(markup),'the actions column head is sr-only');

// ---- One row Menu per user, no per-row buttons ----
root=tree();
check(menus(root).map(menu=>menu.props.label),['Aktionen für Administrator','Aktionen für Gast','Aktionen für ops'],'one row Menu per user');
const body=markup.slice(markup.indexOf('<tbody'),markup.indexOf('</tbody>'));
check((body.match(/<button/g)||[]).length,3,'the only buttons in the rows are the three menu triggers');
check(harness.menu(root,'Aktionen für Gast').map(entry=>entry.label??'—'),['Benutzer ändern…','Passwort zurücksetzen…','—','Benutzer löschen…'],'the menu entries in order, with the separator');
ok(harness.menu(root,'Aktionen für Gast')[3].danger===true&&harness.menu(root,'Aktionen für Gast').every(entry=>!entry.blocked),'delete is the danger entry; all are available');

// ---- Blocked: demo, domain controller, saving ----
reset();root=tree({demo:true});markup=html({demo:true});
ok(menus(root).every(menu=>menu.props.entries.filter(entry=>'label' in entry).every(entry=>entry.blocked==='Bei Beispielgeräten nicht möglich.')),'demo: every entry is blocked with the demo sentence');
ok(text(markup).includes(`${de('kit.unavailable.demo')} ${de('accounts.readOnly')}`),'demo: one panel notice with the read-only sentence');
const create=walk(root).find(item=>item.props.blocked&&harness.text(item).trim()==='Benutzer erstellen');
ok(create&&create.props.variant==='primary','"Benutzer erstellen" is the primary kit Btn and blocked');
const createHtml=markup.match(/<button[^>]*>(?:(?!<\/button>).)*Benutzer erstellen(?:(?!<\/button>).)*<\/button>/)?.[0]??'';
ok(/aria-disabled="true"/.test(createHtml)&&/aria-describedby="/.test(createHtml)&&!/disabled=""/.test(createHtml),'Create user: aria-disabled with a description, no native disabled');
ok(!markup.includes('ServerDesk.Agent.exe --set-mode')&&!markup.includes(de('kit.unavailable.demo').replace('.',' ·')),'no classic banner and no --set-mode code');
const dc={...server,snapshot:{...server.snapshot,localUsers:[],security:{domainRole:5}}};
reset();root=tree({server:{...server,snapshot:{...server.snapshot,security:{domainRole:4}}}});
ok(menus(root).every(menu=>menu.props.entries.filter(entry=>'label' in entry).every(entry=>entry.blocked===de('management.blocked.domainController'))),'domain controller: the entries carry the DC reason');
reset();markup=html({server:dc});root=tree({server:dc});
ok(text(markup).includes(de('management.users.dcHint')),'domain controller without users: the DC hint as the empty state');
ok(walk(root).filter(item=>item.props.blocked&&['Mitglied hinzufügen','Mitglied entfernen'].includes(harness.text(item).trim())).every(item=>item.props.blocked===de('management.blocked.domainController')),'group actions blocked with the DC reason');
reset();root=tree({saving:true});
ok(harness.menu(root,'Aktionen für ops').filter(entry=>'label' in entry).every(entry=>entry.blocked===de('fleet.menu.saving')),'saving: the saving reason');
reset();root=tree({server:{...server,snapshot:{...server.snapshot,localUsers:undefined,localGroups:undefined}}});markup=html({server:{...server,snapshot:{...server.snapshot,localUsers:undefined,localGroups:undefined}}});
check(['Lokale Benutzer','Deaktiviert','Administratoren','Lokale Gruppen'].map(label=>kpi(root,label)?.props.value),[null,null,null,null],'no inventory: dashes');
ok(!kpi(root,'Deaktiviert').props.onSelect,'no inventory: the filter tile cannot be selected');
ok(text(markup).includes(de('management.users.noInventory'))&&text(markup).includes(de('management.groups.noInventory')),'no inventory: the empty states');
ok(walk(root).filter(item=>item.props.blocked===de('accounts.blocked.noUsersOrGroups')).length===2,'group actions blocked without users or groups');
reset();root=tree();
const toolbar=walk(root).find(item=>item.props.search);toolbar.props.search.onChange('zzz');root=tree();markup=html();
ok(text(markup).includes(de('accounts.noMatch'))&&text(markup).includes(de('accounts.clearSearch')),'no match: the empty state with "Clear search"');

// ---- Drawers and confirmations ----
const payload=(kind,params)=>({action:'job',id:'device',kind,params,confirm:true});
// Create
reset();root=tree();btn(root,'Benutzer erstellen').props.onClick();root=tree();markup=html();
ok(text(markup).includes(de('management.users.createDescription'))&&markup.includes('form="sdx-accounts-form"'),'create: the drawer with its description and the submit footer');
ok(walk(root).filter(item=>item.props.label&&item.props.children&&item.type?.name==='Field').length>=5,'create: the inputs sit in Fields');
ok(/type="password"[^>]*value=""|value=""[^>]*type="password"/.test(markup)&&/autoComplete="new-password"|autocomplete="new-password"/.test(markup)&&text(markup).includes(de('management.passwordNote')),'create: an empty password with new-password and the note as hint');
ok(/role="switch"/.test(markup),'create: the on/off field is a switch');
submit(root);root=tree();markup=html();
ok(confirmations.length===0&&text(markup).includes(de('system.fieldRequired'))&&/aria-invalid="true"/.test(markup),'create: a required field shows its error at the field');
input(root,'name').props.onChange({target:{value:'  sdtest '}});root=tree();
input(root,'fullName').props.onChange({target:{value:' Test User '}});root=tree();
input(root,'password').props.onChange({target:{value:' p@ss '}});root=tree();
submit(root);
check(confirmations[0].payload,payload('create-local-user',{name:'sdtest',fullName:'Test User',description:'',password:' p@ss ',passwordNeverExpires:false}),'create: the classic payload');
check([confirmations[0].title,confirmations[0].confirmLabel,confirmations[0].tone],['Benutzer sdtest erstellen?','Benutzer erstellen',undefined],'create: title, confirm label, no danger');
check(confirmations[0].lines,[{label:'Gerät',value:'WINDOWS-SRV'}],'create: the device line');
ok(!confirmations[0].description.includes('Server:')&&confirmations[0].description.endsWith('\n\n'+de('management.users.createDescription'))&&!confirmations[0].description.includes('p@ss'),'create: review + description, no server line, no password');
// Change
reset();root=tree();harness.menu(root,'Aktionen für ops')[0].onSelect();root=tree();
check(input(root,'fullName').props.value,'Ops Team','change: the current values');
input(root,'description').props.onChange({target:{value:' Operations '}});root=tree();submit(root);
check(confirmations[0].payload,payload('set-local-user',{name:'ops',enabled:true,fullName:'Ops Team',description:'Operations',passwordNeverExpires:false}),'change: the classic payload');
check([confirmations[0].title,confirmations[0].confirmLabel],['Benutzer ops ändern?','Benutzer ändern'],'change: title and confirm label');
// Reset password
reset();root=tree();harness.menu(root,'Aktionen für Gast')[1].onSelect();root=tree();markup=html();
ok(/value=""/.test(markup)&&text(markup).includes(de('management.passwordNote')),'reset: an empty password field');
input(root,'password').props.onChange({target:{value:'N3w!'}});root=tree();submit(root);
check(confirmations[0].payload,payload('reset-local-password',{name:'Gast',password:'N3w!'}),'reset: the classic payload');
check([confirmations[0].title,confirmations[0].confirmLabel],['Passwort von Gast zurücksetzen?','Passwort zurücksetzen'],'reset: title and confirm label');
// Delete: no form
reset();root=tree();harness.menu(root,'Aktionen für Gast')[3].onSelect();
check(confirmations[0].payload,payload('delete-local-user',{name:'Gast'}),'delete: straight to the confirmation with the classic payload');
check([confirmations[0].title,confirmations[0].confirmLabel,confirmations[0].tone],['Benutzer Gast löschen?','Benutzer löschen','danger'],'delete: danger');
// Group add / remove
reset();root=tree();btn(root,'Mitglied hinzufügen').props.onClick();root=tree();markup=html();
ok(/<select[^>]*name="name"[^>]*class="sdx-select"|<select[^>]*class="sdx-select"[^>]*name="name"/.test(markup),'group: the user is the kit Select');
input(root,'name').props.onChange({target:{value:'Gast'}});root=tree();input(root,'groupSid').props.onChange({target:{value:'S-1-5-32-545'}});root=tree();submit(root);
check(confirmations[0].payload,payload('local-group-add',{name:'Gast',groupSid:'S-1-5-32-545'}),'add member: the classic payload');
check([confirmations[0].title,confirmations[0].confirmLabel,confirmations[0].tone],['Gast zu Benutzer hinzufügen?','Mitglied hinzufügen',undefined],'add member: title and confirm label');
reset();root=tree();btn(root,'Mitglied entfernen').props.onClick();root=tree();submit(root);
check(confirmations[0].payload,payload('local-group-remove',{name:'Administrator',groupSid:'S-1-5-32-544'}),'remove member: the classic payload with the first user and group');
check([confirmations[0].title,confirmations[0].confirmLabel,confirmations[0].tone],['Administrator aus Administratoren entfernen?','Mitglied entfernen','danger'],'remove member: danger');
// The reason is checked again right before onConfirm.
reset();root=tree();harness.menu(root,'Aktionen für ops')[1].onSelect();root=tree();input(root,'password').props.onChange({target:{value:'x'}});
root=tree({demo:true});submit(root);
check(confirmations.length,0,'a reason that appears while the drawer is open blocks the confirmation');

// ---- English ----
const english=panelHarness({hooked:['ui/devices/management/device-accounts.tsx'],locale:'en'});
const EnglishAccounts=english.load('ui/devices/management/device-accounts.tsx').default;
english.reset();markup=english.html(EnglishAccounts,{...props,demo:true});
ok(/<h2 class="sr-only">Accounts<\/h2>/.test(markup)&&text(markup).includes('Create, change and delete local users on this device, and manage their group memberships.')&&text(markup).includes('3 users'),'English head');
const englishRoot=english.tree(EnglishAccounts,{...props,demo:true});
ok(english.menu(englishRoot,'Actions for Gast').filter(entry=>'label' in entry).every(entry=>entry.blocked==='Not available for sample devices.'),'English: the demo reason on every entry');

console.log(`PASS device accounts (${checks} checks): sr-only head, KPI tiles with the Deactivated filter, focusable regions, subtitle without a leading dot, one row Menu per user, blocked reasons (demo, DC, saving, no inventory), Drawer forms with Fields and empty passwords, and the classic payloads of all six actions.`);
