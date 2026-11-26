// "Open {area}" of the job drawer (ui/shell/job-area.ts), pure: one kind per group leads to its device area or subarea
// with that area's label, the assistant script to the assistant link (deviceAssistantHash, the only builder of that hash
// in ui/ and lib/), anything else to the device Overview.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
const {jobAreaRoute}=await import('../../../ui/shell/job-area.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {managementDetailLabels:m,diagnosticsDetailLabels:d,extensionsDetailLabels:r,deviceAssistantHash}=await import('../../../lib/console-route.ts');
const fs=await import('node:fs'),path=await import('node:path');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const id='5f3e1a2b-1111-4222-8333-444455556666',base=`#device/${id}`;
const area=(action,target='')=>{const result=jobAreaRoute({serverId:id,action,target});return [result.kind,result.hash,result.kind==='area'?translate('de',result.areaKey):null];};
check(area('stop-service','Spooler'),['area',`${base}/management`,'Dienste'],'services (the default subarea is not written)');
check(area('install-updates'),['area',`${base}/management/updates`,'Windows Update'],'updates');
check(area('storage-format'),['area',`${base}/management/storage`,translate('de',m.storage)],'storage');
check(area('set-dns'),['area',`${base}/management/network`,translate('de',m.network)],'network');
check(area('add-firewall-rule'),['area',`${base}/management/network`,translate('de',m.network)],'firewall rules live in Network');
check(area('local-group-add'),['area',`${base}/management/accounts`,translate('de',m.accounts)],'local users and groups');
check(area('install-feature'),['area',`${base}/management/features`,translate('de',m.features)],'roles and features');
check(area('set-task'),['area',`${base}/management/tasks`,translate('de',m.tasks)],'scheduled tasks');
check(area('defender-quick-scan'),['area',`${base}/management/defender`,translate('de',m.defender)],'Defender');
check(area('rename-computer'),['area',`${base}/management/system`,translate('de',m.system)],'restart, shutdown and rename');
check(area('kill-process'),['area',`${base}/diagnostics`,translate('de',d.processes)],'process diagnostics');
check(area('logoff-session'),['area',`${base}/diagnostics/sessions`,translate('de',d.sessions)],'session diagnostics');
check(area('export-events'),['area',`${base}/diagnostics/events`,translate('de',d.events)],'event diagnostics');
check(area('network-diagnostics'),['area',`${base}/diagnostics/connections`,translate('de',d.connections)],'connection diagnostics');
check(area('delete-file'),['area',`${base}/remote`,translate('de','device.section.files')],'files');
check(area('plugin-job','dhcp-scope-create'),['area',`${base}/extensions/dhcp`,translate('de',r.dhcp)],'DHCP plugin operations: the subarea label of console-route.ts');
check(area('plugin-job','dns-zone-create'),['area',`${base}/extensions/dns`,translate('de',r.dns)],'DNS plugin operations');
check(area('plugin-install'),['area',`${base}/extensions`,translate('de','device.section.extensions')],'extension install and remove open Extensions');
check(area('plugin-remove'),['area',`${base}/extensions`,'Erweiterungen'],'the German area name Erweiterungen');
check(area('desired-state-apply'),['area',`${base}/automation/desired`,translate('de','device.section.desired')],'desired state');
check(area('assistant-powershell'),['assistant',`${base}/assistant`,null],'the assistant script opens the assistant');
check(jobAreaRoute({serverId:'a/b c',action:'assistant-powershell'}).hash,deviceAssistantHash('a/b c'),'the assistant hash comes from deviceAssistantHash, also for an id that needs encoding');
// Only lib/console-route.ts knows the hash grammar: no other file of ui/ or lib/ builds an assistant hash by hand.
const sources=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?sources(path.join(dir,entry.name)):/\.(ts|tsx)$/.test(entry.name)?[path.join(dir,entry.name).replaceAll('\\','/')]:[]);
const handBuilt=[...sources('ui'),...sources('lib')].filter(file=>file!=='lib/console-route.ts'&&/`[^`\n]*#[^`\n]*\/assistant[^`\n]*`/.test(fs.readFileSync(file,'utf8')));
check(handBuilt,[],'no hand-built /assistant hash template outside lib/console-route.ts');
check(area('refresh'),['device',base,null],'anything else: the device Overview');
check(area('plugin-job','unknown-op'),['device',base,null],'an unknown plugin operation: the Overview');
check(translate('de','console.job.openArea',{area:translate('de',r.dhcp)}),'DHCP-Server öffnen','"DHCP-Server öffnen"');
console.log(`PASS job area (${checks} checks): the device area or subarea of each job group with its label, the assistant link and the Overview fallback.`);
