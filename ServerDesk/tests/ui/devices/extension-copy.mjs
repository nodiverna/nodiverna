// The copy and file rules of the Extensions UI (docs/extensions.md): the console calls an agent plugin an
// extension, so no catalog value says "plugin"; the old Server roles keys, routes and file names are gone; the docs
// link docs/extensions.md and name the three links. Static checks; no browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const catalogs={};
for(const name of ['en','de','en-server','de-server'])catalogs[name]=(await import(`../../../lib/i18n/messages/${name}.ts`)).default;
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const forms=value=>typeof value==='string'?[value]:Object.values(value);

// ---- no value names a plugin or the old Server roles area, plain and plural forms, in all four catalogs ----
for(const [name,catalog] of Object.entries(catalogs)){
 check(Object.entries(catalog).filter(([,value])=>forms(value).some(form=>/plugin/i.test(form))).map(([key])=>key),[],`${name}: no value contains "plugin"`);
 check(Object.entries(catalog).filter(([,value])=>forms(value).some(form=>['Server roles','Serverrollen','Server roles area','Bereich Serverrollen'].includes(form))).map(([key])=>key),[],`${name}: no value is a Server roles label`);
}
// German uses the feminine "Erweiterung": no neuter article in front of it.
check(Object.entries(catalogs.de).filter(([,value])=>forms(value).some(form=>/\b(?:das|Das|dem|des|ein|kein|dieses|jedes)\s+(?:[\wäöü-]+-)?Erweiterung\b/.test(form))).map(([key])=>key),[],'de: "Erweiterung" is feminine (die, der, eine, diese)');
check(Object.entries(catalogs['de-server']).filter(([,value])=>forms(value).some(form=>/\b(?:das|Das|dem|des|ein|kein|dieses)\s+(?:[\wäöü-]+-)?Erweiterung\b/.test(form))).map(([key])=>key),[],'de-server: "Erweiterung" is feminine');

// ---- the key rules and equal key sets ----
const {en,de}=catalogs;
const keys=Object.keys(en);
check(keys.filter(key=>key.startsWith('serverRoles.')&&!key.startsWith('serverRoles.role.')&&!key.startsWith('serverRoles.software.')),[],'only the detection names stay under serverRoles.');
check(keys.filter(key=>/^(?:plugins\.|help\.serverRoles\.|help\.deviceRoles\.)/.test(key)),[],'no plugins.*, help.serverRoles.* or help.deviceRoles.* key');
check(['help.doc.serverRoles','rbac.category.serverRoles','device.serverRolesArea','device.section.roles','releaseSource.pluginTag'].filter(key=>Object.hasOwn(en,key)||Object.hasOwn(de,key)),[],'the renamed single keys are gone');
check(['help.doc.extensions','rbac.category.extensions','device.extensionsArea','device.section.extensions','releaseSource.extensionTag','extensions.tab','help.extensions.title','help.deviceExtensions.title','help.extensionReleases.title','nav.settings.extensions']
 .filter(key=>!Object.hasOwn(en,key)||!Object.hasOwn(de,key)),[],'their replacements exist in both catalogs');
check(Object.keys(de).sort(),[...keys].sort(),'en and de have the same keys');
check(Object.keys(catalogs['de-server']).sort(),Object.keys(catalogs['en-server']).sort(),'en-server and de-server have the same keys');
// The detection names stay: lib/extensions.ts references them.
ok(fs.readFileSync('lib/extensions.ts','utf8').includes("'serverRoles.role.dhcp'")&&Object.hasOwn(en,'serverRoles.role.dhcp'),'the detection names keep their keys');
// The fixed copy of the spec.
check([en['permission.plugins.manage'],de['permission.plugins.manage'],en['jobs.kind.pluginJob'],de['jobs.kind.pluginJob'],en['agentIntegrity.target.folderPlugins'],de['agentIntegrity.target.folderPlugins']],
 ['Manage extensions','Erweiterungen installieren und entfernen','Extension job','Erweiterungsauftrag','extension folder permissions','Berechtigungen des Erweiterungsordners'],'the fixed cases');
check([en['apiError.plugin.notInstalled'],de['apiError.plugin.notInstalled']],['{name} does not have this extension. Install it in the Extensions area of {name}.','{name} hat diese Erweiterung nicht. Installiere sie im Bereich Erweiterungen von {name}.'],'apiError.plugin.notInstalled names the Extensions area');

// ---- no file name and no hash of the old area ----
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name).split(path.sep).join('/')]);
const appFiles=[...walk('app'),...walk('ui')];
check(appFiles.filter(file=>/server-roles|device-roles|plugin-releases/.test(path.basename(file))),[],'no file under app/ has server-roles, device-roles or plugin-releases in its name');
check([...appFiles,...walk('lib').filter(file=>/\.tsx?$/.test(file))].filter(file=>/\.(?:tsx?|css)$/.test(file)&&/['"`/]server-roles\b/.test(fs.readFileSync(file,'utf8'))),[],'no code writes a server-roles hash or imports a server-roles file');
const nav=fs.readFileSync('ui/shell/nav-model.ts','utf8');
ok(!/'device-roles'|\|'roles'\|/.test(nav.slice(nav.indexOf('export type HelpTopic'),nav.indexOf('/** What a visibility rule'))),'HelpTopic has no roles or device-roles');

// ---- the docs ----
ok(!fs.existsSync('docs/server-roles.md')&&fs.existsSync('docs/extensions.md'),'docs/server-roles.md is renamed to docs/extensions.md');
const docs=fs.readdirSync('docs').filter(name=>name.endsWith('.md')),docText=Object.fromEntries(docs.map(name=>[name,fs.readFileSync(path.join('docs',name),'utf8')]));
check(docs.filter(name=>docText[name].includes('server-roles.md')),[],'no doc links server-roles.md');
check(docs.filter(name=>/#devices?\/[^\s`)]*server-roles/.test(docText[name])),[],'no doc names a server-roles link');
const extensionsDoc=docText['extensions.md'];
for(const link of ['#device/<id>/extensions','#devices/inventory/extensions','#settings/extensions'])ok(extensionsDoc.includes(link),`docs/extensions.md names ${link}`);
ok(/^# Extensions$/m.test(extensionsDoc),'docs/extensions.md has the title Extensions');
ok(/the UI calls (?:a|the) plugin an extension|the portal calls (?:a|the) plugin an extension/i.test(docText['agent-plugins.md']),'docs/agent-plugins.md says once that the UI calls a plugin an extension');
check([...appFiles,...walk('lib')].filter(file=>/\.(?:tsx?|mjs)$/.test(file)&&fs.readFileSync(file,'utf8').includes('server-roles.md')),[],'no code comment links server-roles.md');

console.log(`PASS extension copy (${checks} checks): no catalog value names a plugin or the Server roles area (feminine "Erweiterung" in German), the key rules and equal key sets, no old file name or server-roles hash, and the docs on docs/extensions.md with its three links.`);
