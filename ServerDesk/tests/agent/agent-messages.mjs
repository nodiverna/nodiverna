// Agent job message codes: agent/v3/AgentMessages.cs is the only
// registry (also of the PLUGIN_ codes of the agent plugins), the portal catalogs hold exactly its codes, the agent writes no job
// message as a bare literal, and lib/agent-messages.ts resolves the display text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {sourceLoader} from '../support/source-database.mjs';

const load=sourceLoader();
const en=load('lib/i18n/messages/en.ts').default,de=load('lib/i18n/messages/de.ts').default;
const {translate}=load('lib/i18n/translate.ts');
const {agentMessageText,agentMessageTextOr,agentResultFields,parseAgentArgs,validAgentArgs,AGENT_CODE_PATTERN}=load('lib/agent-messages.ts');
let checks=0;

// 1. The registry: one Define per line, unique codes in the code format.
const registrySource=fs.readFileSync('agent/v3/AgentMessages.cs','utf8');
const body=registrySource.slice(registrySource.indexOf('// agent-messages:start'),registrySource.indexOf('// agent-messages:end'));
const lines=body.split(/\r?\n/).filter(line=>line.includes('Define('));
const definition=/^\s*Define\("([^"\\]+)", "([^"\\]*)"(?:, "([^"\\]*)")?\);$/;
const registry=new Map();
for(const line of lines){
 const match=definition.exec(line);assert.ok(match,`one parsable Define per line: ${line.trim()}`);
 const [,code,one,other]=match;
 assert.match(code,/^(?:AGENT|PLUGIN)_[A-Z0-9_]{1,60}$/,`code format ${code}`);
 assert.ok(!registry.has(code),`${code} is defined once`);
 registry.set(code,other===undefined?one:{one,other});
}
assert.ok(registry.size>=150,'the registry covers the agent job messages');
assert.ok(registry.has('AGENT_FEATURE_NOT_FOUND')&&registry.has('AGENT_EVENT_CURSOR_INVALID')&&registry.has('AGENT_UPDATES_INSTALLED_NO_RESTART'),'the codes named in the spec exist');checks+=4;

// 2. Both catalogs: exactly the registry's codes, en equal to the C# template in the console's wording, same placeholders as de.
// The console calls an agent plugin an extension (docs/agent-plugins.md), the agent keeps its word: en is the template
// with "plugin" read as "extension" (and "a plugin" as "an extension").
// UI-Rework 15: the console says "username" (one word) where the agent says "user name".
const extensionWording=text=>text.replace(/\buser name/g,'username').replace(/\bUser name/g,'Username').replace(/plugin/g,'extension').replace(/Plugin/g,'Extension').replace(/\ba extension/g,'an extension').replace(/\bA extension/g,'An extension');
const consoleWording=template=>typeof template==='string'?extensionWording(template):{one:extensionWording(template.one),other:extensionWording(template.other)};
const agentKeys=catalog=>Object.keys(catalog).filter(key=>key.startsWith('agentMessage.')).sort();
const expectedKeys=[...registry.keys()].map(code=>`agentMessage.${code}`).sort();
assert.deepEqual(agentKeys(en),expectedKeys,'en has one agentMessage entry per registry code and no other');
assert.deepEqual(agentKeys(de),expectedKeys,'de has one agentMessage entry per registry code and no other');
const names=value=>[...new Set((typeof value==='string'?value:`${value.one} ${value.other}`).match(/\{\w+\}/g)??[])].sort();
for(const [code,template] of registry){
 assert.deepEqual(en[`agentMessage.${code}`],consoleWording(template),`en agentMessage.${code} is the C# template in the console's wording`);
 assert.deepEqual(names(de[`agentMessage.${code}`]),names(template),`de agentMessage.${code} has the same placeholders`);
 assert.equal(typeof de[`agentMessage.${code}`],typeof template,`de agentMessage.${code} has the same plural shape`);
 assert.ok(names(template).length<=8,`${code} has at most eight arguments`);
}
checks+=2+registry.size*4;

// 3. The agent sources use only registered codes, and every code is used.
const agentDirectory='agent/v3';
const sources=fs.readdirSync(agentDirectory).filter(name=>name.endsWith('.cs')&&!/Tests\.cs$/.test(name)&&name!=='AgentMessages.cs');
const used=new Set();
for(const name of sources){
 const text=fs.readFileSync(path.join(agentDirectory,name),'utf8');
 for(const [,code] of text.matchAll(/"(AGENT_[A-Z0-9_]+)"/g)){
  // Portal answer codes that the agent reads, not agent messages: the signing-key prefix and the uninstall confirmation;
  // AGENT_PLUGIN_ is the prefix the plugin report keeps for a damaged plugin.
  if(['AGENT_JOB_SIGNING_KEY','AGENT_UNINSTALL_CONFIRMED','AGENT_UNINSTALL_NOT_CONFIRMED','AGENT_PLUGIN_'].includes(code))continue;
  assert.ok(registry.has(code),`${name} uses the registered code ${code}`);used.add(code);
 }
}
// The plugins (agent/plugins/<name>) write their PLUGIN_ codes with the same English texts; the broker passes them through.
const pluginDirectory='agent/plugins';
for(const plugin of fs.readdirSync(pluginDirectory).filter(name=>name!=='shared'&&fs.statSync(path.join(pluginDirectory,name)).isDirectory())){
 for(const name of fs.readdirSync(path.join(pluginDirectory,plugin)).filter(name=>name.endsWith('.cs')&&!/Tests\.cs$/.test(name))){
  const text=fs.readFileSync(path.join(pluginDirectory,plugin,name),'utf8');
  for(const [,code,english] of text.matchAll(/\["(PLUGIN_[A-Z0-9_]+)"\] = "([^"\\]*)"/g)){
   assert.ok(registry.has(code),`${plugin}/${name} uses the registered code ${code}`);used.add(code);
   assert.equal(english,registry.get(code),`${code} has the registered English text in ${plugin}/${name}`);
  }
 }
}
assert.ok([...registry.keys()].filter(code=>code.startsWith('PLUGIN_')).every(code=>used.has(code)),'every PLUGIN_ code is a text of a plugin');
// NativeAccounts appends _PARAMETER to a code it passes to Check; AgentMessages.Fail writes AGENT_JOB_CANCELLED.
const reachable=code=>used.has(code)||code==='AGENT_JOB_CANCELLED'||code.endsWith('_PARAMETER')&&used.has(code.slice(0,-'_PARAMETER'.length));
assert.deepEqual([...registry.keys()].filter(code=>!reachable(code)),[],'every registered code is written somewhere');
assert.match(registrySource,/Of\("AGENT_JOB_CANCELLED"\)/,'cancellation has its code in the helper');checks+=3;

// 4. Job result messages go through the helper or the exception type, never as a bare literal.
const jobFiles=['JobRunner.cs','FileBrowser.cs','NativeStorage.cs','NativeDesiredState.cs','DesiredStateJobs.cs','NativeManagement.cs','NativeAccounts.cs','NativeFeatures.cs','NativePowerSchedule.cs','NativeRdpAvailability.cs','NativeWindowsUpdates.cs','NativeDiagnostics.cs'];
for(const name of jobFiles){
 const text=fs.readFileSync(path.join(agentDirectory,name),'utf8');
 assert.doesNotMatch(text,/result\["message"\]/,`${name} writes no result message directly`);
 assert.doesNotMatch(text,/\["message"\]\s*=\s*\$?@?"/,`${name} writes no message literal`);
 assert.match(text,/AgentMessageException\("AGENT_|AgentMessages\.(?:Of|Write)\(/,`${name} writes coded messages`);
}
const runner=fs.readFileSync(path.join(agentDirectory,'JobRunner.cs'),'utf8');
assert.match(runner,/catch \(Exception e\) \{ AgentMessages\.Fail\(result, e\); \}/,'the job runner keeps raw OS texts and codes agent failures');
const management=fs.readFileSync(path.join(agentDirectory,'NativeManagement.cs'),'utf8');
assert.match(management,/AgentMessages\.Write\(result, message, SecretValues\(secrets\)\)/,'management success messages are masked');
assert.match(management,/AgentMessages\.Fail\(result, e, SecretValues\(secrets\)\)/,'management failures and their arguments are masked');
assert.match(registrySource,/SecretMask\.Apply\(pair\.Value, secrets\)/,'masking covers every argument value');checks+=jobFiles.length*3+4;

// 5. The resolver.
const t=locale=>(key,params)=>translate(locale,key,params);
const coded={result:'Role or feature not found.',resultCode:'AGENT_FEATURE_NOT_FOUND',resultArgs:null};
assert.equal(agentMessageText(coded,t('de')),'Rolle oder Feature nicht gefunden.','German UI shows the German catalog text');
assert.equal(agentMessageText(coded,t('en')),'Role or feature not found.','English UI shows the English catalog text');
const tcp={result:'TCP connection succeeded: srv:443',resultCode:'AGENT_TCP_CONNECTED',resultArgs:{host:'srv',port:'443'}};
assert.equal(agentMessageText(tcp,t('de')),'TCP-Verbindung erfolgreich: srv:443','arguments fill the placeholders');
assert.equal(agentMessageText({result:'Rolle / Feature geändert. Neustart erforderlich: True.',resultCode:null,resultArgs:null},t('en')),'Rolle / Feature geändert. Neustart erforderlich: True.','a 4.7 result without a code keeps its stored text');
assert.equal(agentMessageText({result:'Stored text.'},t('de')),'Stored text.','a job without code fields keeps its text');
assert.equal(agentMessageText({result:'Newer agent text.',resultCode:'AGENT_FROM_A_NEWER_AGENT',resultArgs:null},t('de')),'Newer agent text.','an unknown code keeps the stored text');
assert.equal(agentMessageText({result:'TCP connection succeeded: srv:443',resultCode:'AGENT_TCP_CONNECTED',resultArgs:{host:'srv'}},t('de')),'TCP connection succeeded: srv:443','a missing argument keeps the stored text');
assert.equal(agentMessageText({result:'x',resultCode:'not a code',resultArgs:null},t('de')),'x','a malformed code keeps the stored text');
const installed=count=>({result:'English fallback',resultCode:'AGENT_UPDATES_INSTALLED',resultArgs:{count:String(count)}});
assert.equal(agentMessageText(installed(1),t('de')),'1 Update installiert. Starte das Gerät neu, um abzuschließen. Der Agent hat es nicht neu gestartet.','the singular form for one update');
assert.equal(agentMessageText(installed(3),t('de')),'3 Updates installiert. Starte das Gerät neu, um abzuschließen. Der Agent hat es nicht neu gestartet.','the plural form for three updates');
assert.equal(agentMessageText(installed(3),t('en')),'3 updates installed. Restart the device to finish. The agent did not restart it.','the English plural form');
assert.equal(agentMessageText({result:null,resultCode:null},t('de')),null,'no result stays empty');checks+=12;

// 6. Stored arguments.
assert.deepEqual(parseAgentArgs('{"host":"srv","port":"443"}'),{host:'srv',port:'443'});
for(const bad of [null,'','not json','[]','{"port":443}','{"Bad":"x"}',JSON.stringify(Object.fromEntries(Array.from({length:9},(_,i)=>[`a${i}`,'x']))),JSON.stringify({detail:'x'.repeat(1001)})])assert.equal(parseAgentArgs(bad),null,`malformed arguments are ignored: ${String(bad).slice(0,40)}`);
assert.equal(validAgentArgs({detail:'x'.repeat(1000)}),true,'a value of 1000 characters is allowed');
assert.deepEqual(agentResultFields({result_code:'AGENT_TCP_CONNECTED',result_args:'{"host":"srv","port":"443"}'}),{resultCode:'AGENT_TCP_CONNECTED',resultArgs:{host:'srv',port:'443'}});
assert.deepEqual(agentResultFields({result_code:null,result_args:null}),{resultCode:null,resultArgs:null},'an old agent row has neither');
assert.deepEqual(agentResultFields({result_code:'lower',result_args:'{}'}),{resultCode:null,resultArgs:null},'a malformed stored code is dropped');
assert.match('AGENT_FEATURE_NOT_FOUND',AGENT_CODE_PATTERN);checks+=13;
// A plugin code is a stored code like an agent code; an unknown one keeps the plugin's English text.
assert.deepEqual(agentResultFields({result_code:'PLUGIN_DHCP_READ_COMPLETED',result_args:'{"scopes":"3","leases":"20"}'}),{resultCode:'PLUGIN_DHCP_READ_COMPLETED',resultArgs:{scopes:'3',leases:'20'}},'a plugin code is kept');
assert.equal(agentMessageText({result:'The DHCP server was read: 3 scopes, 20 leases.',resultCode:'PLUGIN_DHCP_READ_COMPLETED',resultArgs:{scopes:'3',leases:'20'}},t('de')),'Der DHCP-Server wurde gelesen: 3 Bereiche, 20 Leases.','a plugin code shows its German catalog text');
assert.equal(agentMessageText({result:'A newer plugin text.',resultCode:'PLUGIN_DNS_FROM_A_NEWER_PLUGIN',resultArgs:null},t('de')),'A newer plugin text.','an unknown plugin code keeps the English message');checks+=3;

// 7. The two codes of a failed plugin job, and the toast text that never shows raw agent text.
for(const code of ['AGENT_PLUGIN_UPLOAD_FAILED','AGENT_PLUGIN_FAILED'])assert.ok(registry.has(code)&&Object.hasOwn(en,`agentMessage.${code}`)&&Object.hasOwn(de,`agentMessage.${code}`),`${code} is registered in the agent and both catalogs`);
assert.equal(en['agentMessage.AGENT_PLUGIN_UPLOAD_FAILED'],'The extension read the data, but the agent could not send them to the portal. Try again.');
assert.equal(de['agentMessage.AGENT_PLUGIN_FAILED'],'Der Agent konnte die Erweiterung nicht ausführen. Versuche es erneut. Wenn es wieder fehlschlägt, prüfe das Agent-Protokoll auf dem Gerät.');
assert.equal(agentMessageTextOr({result:'The plugin read the data, but the agent could not send them to the portal. Try again.',resultCode:'AGENT_PLUGIN_UPLOAD_FAILED',resultArgs:null},t('de'),'dns.error.read'),'Die Erweiterung hat die Daten gelesen, aber der Agent konnte sie nicht an das Portal senden. Versuche es erneut.','a known code shows its catalog text');
assert.equal(agentMessageTextOr({result:'The DNS server refused access to the plugin. Check the DnsAdmins group.',resultCode:'PLUGIN_DNS_ACCESS_DENIED',resultArgs:null},t('en'),'dns.error.read'),'The DNS server refused access to the extension. Check the DnsAdmins group.','a known plugin code shows its catalog text');
assert.equal(agentMessageTextOr({result:'serverMessage.job.unsupported',resultCode:null,resultArgs:null},t('en'),'dns.error.read'),translate('en','serverMessage.job.unsupported'),'a stored serverMessage key shows its catalog text');
assert.equal(agentMessageTextOr({result:'apiError.console.queueChanged',resultCode:null,resultArgs:null},t('de'),'dns.error.read'),translate('de','apiError.console.queueChanged'),'a stored apiError key shows its catalog text');
assert.equal(agentMessageTextOr({result:'apiError.internalError',resultCode:null,resultArgs:null},t('de'),'dns.error.read'),'Der DNS-Server konnte nicht gelesen werden. Versuche es erneut.','an apiError key whose placeholder has no value: the fallback');
for(const raw of ['The node already has a parent.','Der Knoten hat bereits ein übergeordnetes Element.'])for(const locale of ['en','de'])assert.equal(agentMessageTextOr({result:raw,resultCode:null,resultArgs:null},t(locale),'dns.error.read'),translate(locale,'dns.error.read'),`raw agent text is never shown (${locale}): ${raw}`);
assert.equal(agentMessageTextOr({result:'Newer agent text.',resultCode:'AGENT_FROM_A_NEWER_AGENT',resultArgs:null},t('en'),'dhcp.error.read'),'The DHCP server could not be read. Try again.','an unknown code gives the fallback');
assert.equal(agentMessageTextOr({result:'TCP connection succeeded: srv:443',resultCode:'AGENT_TCP_CONNECTED',resultArgs:{host:'srv'}},t('en'),'dns.error.read'),'The DNS server could not be read. Try again.','a missing argument gives the fallback');
assert.equal(agentMessageTextOr({result:null},t('en'),'dns.error.read'),'The DNS server could not be read. Try again.','no result gives the fallback');
assert.equal(agentMessageText({result:'The node already has a parent.',resultCode:null,resultArgs:null},t('en')),'The node already has a parent.','agentMessageText keeps the stored text for the job dock');
checks+=15;

console.log(`PASS agent messages: ${registry.size} registered codes, catalogs in step, no bare job message literals and the resolver (${checks} checks).`);
