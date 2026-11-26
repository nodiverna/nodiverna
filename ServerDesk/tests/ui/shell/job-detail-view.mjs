// The job drawer (ui/shell/job-detail.tsx), run on hook cells: the head with the device and the object (never the
// raw target), the result block first, Ended and Duration only for a finished job, the input (script, fields with
// their catalog labels, loading, failure with retry, not kept), the output Disclosure (open for a failed job, stderr,
// exit code, truncated, redacted, a script removed after its retention), "Open {area}" and its route, Cancel job blocked
// with its reason (demo, saving, missing right; never native disabled), an unknown device without its raw id, no fetch in
// demo, and the console renders it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
const harness=panelHarness({hooked:['ui/shell/job-detail.tsx']});
const Drawer=harness.load('ui/shell/job-detail.tsx').default;
const now=1800000000000,owner={id:'owner',label:'Owner',permissions:['*']};
const device='5f3e1a2b-1111-4222-8333-444455556666',servers=[{id:device,name:'CT-DHCP01',revoked:0,permissions:['view','manage','dhcp.manage']}];
const job=extra=>({id:'j1',serverId:device,action:'plugin-job',target:'dhcp-scope-create',state:'failed',createdAt:now-120000,claimedAt:now-100000,lastProgress:now-40000,result:'Overlapping range',actor:'anna@example.test',object:'10.0.0.0',...extra});
const loads=[],navigated=[],opened=[];
let answer=()=>Promise.resolve({input:{fields:[{key:'scopeId',value:'10.0.0.0'},{key:'name',value:'Office'},{key:'activate',value:true}]},inputKept:true,output:{data:'{"error":"overlap"}',truncated:false},outputRedacted:false});
const props=extra=>({job:job(),open:true,servers,viewer:owner,demo:false,saving:false,now,refreshKey:0,onClose:()=>{},onCancel:()=>{},onOpenDevice:id=>opened.push(id),onNavigate:hash=>navigated.push(hash),load:(serverId,jobId)=>{loads.push([serverId,jobId]);return answer();},...extra});
const render=async extra=>{harness.tree(Drawer,props(extra));await harness.flush();return harness.html(Drawer,props(extra));};

// ---- head, result block, facts ----
harness.reset();let markup=harness.html(Drawer,props());
ok(text(markup).includes('CT-DHCP01 · 10.0.0.0')&&!text(markup).includes('dhcp-scope-create'),'the description is device · object, never the raw target');
ok(/<span class="sdx-icon-tile[^"]*"[^>]*><svg[^>]*lucide-activity/.test(markup),'the head IconTile is Activity');
ok(markup.indexOf('sdx-job-result')<markup.indexOf('sdx-facts'),'the result block comes first');
ok(/<div class="sdx-job-result" data-tone="danger">/.test(markup)&&text(markup).includes('Overlapping range'),'the result block: state and the agent message');
for(const fact of ['Gerät','Konto','Erstellt','Begonnen','Beendet','Dauer'])ok(text(markup).includes(fact),`a failed job shows ${fact}`);
ok(text(markup).includes('1 min 0 s'),'the duration is Ended − Started');
ok(!text(markup).includes(de('console.job.lastProgress')),'no last progress for a finished job');
ok(markup.includes('aria-label="'+de('console.job.loading')+'"')&&markup.includes('sdx-skeleton-facts'),'the input loads: the facts Skeleton with its label');
harness.reset();markup=harness.html(Drawer,props({job:job({state:'cancelled'})}));
ok(!text(markup).includes('Beendet')&&!text(markup).includes('Dauer'),'a cancelled job: no Ended and no Duration');
harness.reset();markup=harness.html(Drawer,props({job:job({state:'running',result:null,lastProgress:now-5000})}));
ok(text(markup).includes(de('console.job.noResult'))&&text(markup).includes(de('console.job.lastProgress')),'a running job: no result yet and its last progress');
harness.reset();markup=harness.html(Drawer,props({job:job({state:'expired'})}));
ok(text(markup).includes(de('console.job.uncertain')),'an uncertain state keeps its warning');
// The device fact opens the device; an unknown device is plain text and has no "Open {area}".
harness.reset();let tree=harness.tree(Drawer,props());
harness.find(tree,node=>Array.isArray(node.props?.items)&&node.props.items.some(item=>item.id==='device')).props.items.find(item=>item.id==='device').value.props.onClick();
check(opened,[device],'the device fact opens the device');

// ---- the loaded input and output ----
harness.reset();markup=await render();
check(loads,[[device,'j1']],'one read of the opened job');
ok(text(markup).includes('DHCP-Bereich')&&text(markup).includes('10.0.0.0')&&text(markup).includes('Office')&&text(markup).includes('Ja'),'the fields with their jobs.input labels');
ok(/<details class="sdx-disclosure" open="">/.test(markup)&&markup.includes('{&quot;error&quot;:&quot;overlap&quot;}'),'a failed job opens the output by itself');
harness.reset();markup=await render({job:job({state:'succeeded',result:null})});
ok(/<details class="sdx-disclosure">/.test(markup),'a succeeded job keeps the output closed');
answer=()=>Promise.resolve({input:{script:'Write-Output "a"\nWrite-Error "b"',fields:[{key:'timeoutSeconds',value:120}]},inputKept:true,output:{text:'a',stderr:'b',exitCode:1,truncated:true},outputRedacted:false});
harness.reset();markup=await render({job:job({action:'assistant-powershell',target:'Write-Output "a" / 0123456789ab',object:'Write-Output "a"'})});
ok(/<div class="sdx-command"><span class="sdx-command-label">Skript<\/span><div class="sdx-command-box"><pre class="sdx-command-tall"/.test(markup),'a script in a tall CommandBlock labelled Script');
ok(text(markup).includes(de('jobs.input.timeoutSeconds'))&&text(markup).includes('120'),'the timeout as a fact');
ok(text(markup).includes('Fehlerausgabe')&&text(markup).includes('Exitcode')&&text(markup).includes(de('console.job.outputTruncated')),'stderr, exit code and the truncated line');
ok(/<pre class="sdx-output" tabindex="0" aria-label="[^"]+">a<\/pre>/.test(markup),'the output pre is focusable and labelled');
ok(text(markup).includes('Assistent öffnen'),'the assistant script leads to the assistant');
harness.reset();tree=harness.tree(Drawer,props({job:job({action:'assistant-powershell',target:'x / 0123456789ab'})}));
harness.find(tree,node=>node.props?.onClick&&harness.text(node).trim()==='Assistent öffnen').props.onClick();
check(navigated.at(-1),`#device/${device}/assistant`,'the assistant route');
answer=()=>Promise.resolve({input:{fields:[]},inputKept:false,output:null,outputRedacted:true});
harness.reset();markup=await render();
ok(text(markup).includes(de('console.job.inputMissing'))&&text(markup).includes(de('console.job.redacted')),'input not kept; the redacted notice');
answer=()=>Promise.resolve({input:{fields:[]},inputKept:true,output:null,outputRedacted:false});
harness.reset();markup=await render();
ok(text(markup).includes(de('console.job.noInput'))&&text(markup).includes(de('console.job.noOutput')),'no input; no output');
// A failed read: LoadFailed with the retry, which reads again.
answer=()=>Promise.reject(new Error('down'));loads.length=0;
harness.reset();markup=await render();
ok(text(markup).includes(de('console.job.loadFailed'))&&text(markup).includes('Erneut versuchen'),'a failed read shows LoadFailed');
answer=()=>Promise.resolve({input:{fields:[{key:'name',value:'Office'}]},inputKept:true,output:null,outputRedacted:false});
tree=harness.tree(Drawer,props());harness.find(tree,node=>node.props?.onRetry).props.onRetry();
harness.tree(Drawer,props());await harness.flush();markup=harness.html(Drawer,props());
check(loads.length,2,'the retry repeats the read');ok(text(markup).includes('Office'),'and shows the input');
// A refresh reads again; the same job without a refresh does not.
harness.tree(Drawer,props({refreshKey:1}));await harness.flush();check(loads.length,3,'a console refresh reads again');
harness.tree(Drawer,props({refreshKey:1}));await harness.flush();check(loads.length,3,'no other read');

// ---- Open {area} ----
harness.reset();tree=harness.tree(Drawer,props());
const areaButton=harness.find(tree,node=>node.props?.onClick&&/öffnen$/.test(harness.text(node).trim())&&harness.text(node).includes('DHCP'));
ok(areaButton,'"DHCP-Server öffnen" for a DHCP scope create');
areaButton.props.onClick();check(navigated.at(-1),`#device/${device}/extensions/dhcp`,'its route');
harness.reset();markup=harness.html(Drawer,props({servers:[]}));
ok(!text(markup).includes('öffnen'),'no area button for an unknown device');
// The cancel button stays for a pending job.
harness.reset();markup=harness.html(Drawer,props({job:job({state:'pending',claimedAt:null,result:null})}));
ok(text(markup).includes(de('jobs.cancel')),'the cancel button of a pending job');

// A removed script: the note with the days in place of the CommandBlock, then the Timeout fact.
answer=()=>Promise.resolve({input:{fields:[{key:'timeoutSeconds',value:60}]},inputKept:true,scriptRemovedAfterDays:7,output:{text:'ok',truncated:false},outputRedacted:false});
harness.reset();markup=await render({job:job({action:'assistant-powershell',state:'succeeded',target:'Get-Date / 0123456789ab',object:'Get-Date'})});
ok(markup.includes(`<p class="sdx-detail-note">${de('console.job.scriptRemoved',{count:7})}</p>`),'a removed script: the note with 7 days');
ok(!markup.includes('sdx-command-tall')&&!markup.includes('<div class="sdx-command">'),'a removed script: no CommandBlock');
ok(text(markup).includes(de('jobs.input.timeoutSeconds'))&&text(markup).includes('60'),'a removed script: the Timeout fact stays');
ok(markup.indexOf(de('console.job.scriptRemoved',{count:7}))<markup.indexOf(de('jobs.input.timeoutSeconds')),'the note comes before the Timeout fact');
ok(!text(markup).includes(de('console.job.noInput')),'a removed script is not "no input"');

// ---- Cancel job says why ----
const pendingJob=job({state:'pending',claimedAt:null,result:null});
const cancelButton=tree=>harness.find(tree,node=>harness.text(node).trim()===de('jobs.cancel')&&('blocked' in (node.props??{})||node.props?.onClick));
for(const [extra,reason,label] of [[{demo:true},'kit.unavailable.demo','demo'],[{saving:true},'kit.busy','while saving'],[{servers:servers.map(server=>({...server,permissions:['view']})),viewer:{id:'reader',label:'Reader',permissions:[]}},'jobs.cancel.blockedPermission','without the right']]){
 const cancelled=[];harness.reset();tree=harness.tree(Drawer,props({job:pendingJob,onCancel:item=>cancelled.push(item.id),...extra}));
 const button=cancelButton(tree);
 check([button?.props.blocked,button?.props.disabled],[de(reason),undefined],`${label}: the drawer cancel is blocked with its reason, never disabled`);
 markup=harness.html(Drawer,props({job:pendingJob,...extra}));
 const attributes=new RegExp(`<button([^>]*)><span>${de('jobs.cancel')}</span>`).exec(markup)?.[1]??'';
 ok(attributes.includes('aria-disabled="true"')&&!attributes.includes(' disabled=""'),`${label}: aria-disabled, no native disabled`);
 check(cancelled,[],`${label}: nothing is cancelled`);
}
{
 const cancelled=[];harness.reset();tree=harness.tree(Drawer,props({job:pendingJob,onCancel:item=>cancelled.push(item.id)}));
 const button=cancelButton(tree);button.props.onClick();
 check([button.props.blocked,cancelled],[undefined,['j1']],'with the right, not demo and not saving: the cancel calls onCancel');
}

// ---- an unknown device ----
harness.reset();tree=harness.tree(Drawer,props({servers:[]}));markup=harness.html(Drawer,props({servers:[]}));
check(harness.find(tree,node=>Array.isArray(node.props?.items)&&node.props.items.some(item=>item.id==='device')).props.items.find(item=>item.id==='device').value,'—','an unknown device: the Device fact is EMPTY_VALUE');
ok(!markup.includes(device)&&!text(markup).includes(device.slice(0,8)),'an unknown device: the raw serverId appears nowhere');
check(harness.find(tree,node=>node.props?.title!==undefined&&'description' in node.props&&node.props.footer!==undefined)?.props.description,'10.0.0.0','an unknown device: the description is the object alone');
harness.reset();tree=harness.tree(Drawer,props({servers:[],job:job({object:null})}));
check(harness.find(tree,node=>node.props?.title!==undefined&&'description' in node.props&&node.props.footer!==undefined)?.props.description,undefined,'an unknown device without an object: no description');

// ---- demo ----
loads.length=0;harness.reset();markup=await render({demo:true});
check(loads.length,0,'demo: no fetch');
ok(text(markup).includes(de('console.job.inputMissing'))&&text(markup).includes(de('console.job.noOutput')),'demo: input not kept, no output');

// ---- the console renders the drawer ----
const consoleSource=fs.readFileSync('ui/shell/console.tsx','utf8');
ok(!consoleSource.includes('sdx-job-detail')&&/<JobDetailDrawer job=\{job\} open=\{!!job&&!confirmation&&!mfaOpen\}/.test(consoleSource),'console.tsx renders JobDetailDrawer with the same open condition and no own markup');

console.log(`PASS job detail view (${checks} checks): the head, the result block first, the facts, the input and output sections with their states, "Open {area}", demo and the console element.`);
