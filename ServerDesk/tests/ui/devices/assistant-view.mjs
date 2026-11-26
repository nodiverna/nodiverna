// The device assistant in the UI, rendered with React SSR: the header control
// "Ask assistant" (present with view, absent for revoked devices) and its drawer, the
// not-set-up states for Owners and other users, the suggestions, the blocked
// reasons of Ask, the pending row, answers with source chips and Copy, a failed
// question with Ask again, the source line per key, Settings › AI assistant
// (Owners only, the organization card, the customer card with its count,
// search and empty state), the personal card on the account page without any
// subscription option, the palette entries and the help topic. No server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {buttons,blockedReasons} from '../../support/blocked-buttons.mjs';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {default:DeviceView}=await import('../../../ui/devices/device/device.tsx');
const assistantModule=await import('../../../ui/devices/assistant/device-assistant.tsx');
const {default:DeviceAssistant,EarlierConversationList,sourceChips,sourceAreaRoute,askBlockedReason,assistantSourceLine,historyOf,assistantSuggestions,runProposal,proposalPill,commandBusy}=assistantModule;
const {runHandlersFor}=await import('../../../ui/devices/assistant/assistant-conversations.ts');
const {proposalBlockedReason,proposalConfirmation,runPayload,runOptions,needsConfirmation,pollDelay,trackAssistantJob,resultQuestion}=await import('../../../ui/devices/assistant/assistant-proposals.ts');
const {runConsoleAction}=await import('../../../ui/shell/console-action.ts');
const {confirmationOptions}=await import('../../../ui/base/confirmation.ts');
const {validAssistantQuestion}=await import('../../../lib/assistant-config.ts');
const {default:enCatalog}=await import('../../../lib/i18n/messages/en.ts');
const {default:deCatalog}=await import('../../../lib/i18n/messages/de.ts');
const settingsModule=await import('../../../ui/settings/assistant-settings-panel.tsx');
const {default:AssistantSettingsPanel,CustomerKeysCard,keyFormErrors,keyFormDirty,keyFormOf,customerSearchFrom,assistantLoadError}=settingsModule;
const {default:PersonalAssistantKey}=await import('../../../ui/account/personal-assistant-key.tsx');
const {canOpenAccessSection}=await import('../../../ui/base/access-capabilities.ts');
const {topicFor}=await import('../../../ui/shell/help-panel.tsx');
const {assistantToolNames}=await import('../../../lib/assistant-config.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
const t=(key,params)=>translate('en',key,params);
// The visible label of a button, without the sr-only reason of a blocked one.
const buttonText=button=>text(button.inner.replace(/<span[^>]*class="sr-only"[^>]*>[^<]*<\/span>/g,''));
const noop=()=>{};
const owner={id:'owner',label:'owner',userId:'owner',permissions:['*']},member={id:'member',label:'member',userId:'member',permissions:[]};
const {servers}=demoData();
const server={...servers[0],permissions:['view']};

// ---- The header control "Ask assistant" ----
const deviceProps=(extra={})=>({server,servers,viewer:member,demo:false,saving:false,now:Date.now(),section:'overview',onSection:noop,samples:[],historyLoading:false,jobs:[],audit:[],crumbs:[],onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onAssistantOpen:noop,alerts:h('div',null,'alerts'),permissions:h('div',null,'permissions'),canOffboard:false,...extra});
const tabLabels=html=>[...html.matchAll(/role="tab"[^>]*>([\s\S]*?)<\/(?:a|button)>/g)].map(match=>text(match[1]));
const askButtons=html=>buttons(html).filter(button=>buttonText(button)==='Ask assistant'||button.label==='Ask assistant');
let html=render(h(DeviceView,deviceProps()));
ok(askButtons(html).length===1,'"Ask assistant" is a header button for a viewer with view');
ok(/<svg[^>]*lucide-sparkles/.test(askButtons(html)[0].inner),'with the Sparkles icon');
ok(!tabLabels(html).some(label=>label.startsWith('Assistant')),'the Assistant is no area tab');
ok(askButtons(render(h(DeviceView,deviceProps({server:{...server,revoked:1}})))).length===0,'no Ask assistant on a revoked device');
ok(askButtons(render(h(DeviceView,deviceProps({server:{...server,permissions:[]}})))).length===0,'no Ask assistant without view');
// The drawer (kit Drawer modal={false}): its title names the device, the panel inside has no card head of its own.
{
 const source=readFileSync('ui/devices/device/device.tsx','utf8');
 ok(source.includes("<Drawer open={assistantShown} onClose={()=>onAssistantOpen?.(false)} modal={false} wide flush icon={Sparkles} returnFocus={askButton} title={t('assistant.title',{name:server.name})}\n   actions={<AssistantActions conversation={conversation}"),'a wide, flush, non-modal kit Drawer titled assistant.title with the conversation actions in its head, focus back to Ask assistant');
 ok(/<DeviceAssistant [^>]*inDrawer\/>/.test(source),'the assistant renders inside it');
 const inDrawer=render(h(DeviceAssistant,{server,viewer:member,demo:false,conversation:{messages:[],runs:{},pending:false,busy:false,ask:noop,retry:noop,reset:noop,dismiss:noop,sending:noop,refused:noop,started:noop},onOpenArea:noop,inDrawer:true,initialStatus:{available:true,source:'organization',provider:'anthropic',model:'m'}}));
 ok(!text(inDrawer).includes(`Ask about ${server.name}`)&&!inDrawer.includes('sdx-card-head')&&inDrawer.includes('sdx-assistant-panel'),'inside the drawer the content does not repeat the title');
 ok(!inDrawer.includes('sdx-drawer-scrim'),'no scrim');
}
// ---- Not set up ----
const conversation=(messages=[],extra={})=>({messages,runs:{},pending:messages.some(entry=>entry.status==='pending'),busy:messages.some(entry=>entry.status==='pending'),ask:noop,retry:noop,reset:noop,dismiss:noop,sending:noop,refused:noop,started:noop,...extra});
const panel=(extra={})=>render(h(DeviceAssistant,{server,viewer:member,demo:false,conversation:conversation(),onOpenArea:noop,onOpenSettings:noop,onOpenAccount:noop,initialStatus:{available:true,source:'organization',provider:'anthropic',model:'claude-opus-5-5'},...extra}));
const missing={available:false,source:null,provider:null,model:null};
html=panel({viewer:owner,initialStatus:missing});
ok(text(html).includes('The assistant is not set up')&&text(html).includes('To ask questions about this device, add an API key from Claude or OpenAI in Settings or in My account.')&&buttons(html).some(button=>buttonText(button)==='Open AI assistant settings'),'Owners: the Empty text names Settings and My account, with the settings action');
ok(text(render(h(DeviceAssistant,{server,viewer:owner,demo:false,conversation:conversation(),onOpenArea:noop,onOpenSettings:noop,onOpenAccount:noop,initialStatus:missing}),'de')).includes('Um Fragen zu diesem Gerät zu stellen, hinterlege einen API-Schlüssel von Claude oder OpenAI in den Einstellungen oder unter „Mein Konto“.'),'Owners: the German Empty text');
ok(html.includes('sdx-empty-icon'),'the empty state has its icon tile');
html=panel({initialStatus:missing});
ok(text(html).includes('To ask questions about this device, add your own API key from Claude or OpenAI in My account, or ask an Owner to add a key in Settings.')&&buttons(html).some(button=>buttonText(button)==='Open account')&&!text(html).includes('Open AI assistant settings'),'other users: the Empty text is assistant.notSetUp.member, with the account action');
ok(text(render(h(DeviceAssistant,{server,viewer:member,demo:false,conversation:conversation(),onOpenArea:noop,onOpenSettings:noop,onOpenAccount:noop,initialStatus:missing}),'de')).includes('Um Fragen zu diesem Gerät zu stellen, hinterlege unter „Mein Konto“ deinen eigenen API-Schlüssel von Claude oder OpenAI, oder lass einen Owner in den Einstellungen einen Schlüssel hinterlegen.'),'other users: the German Empty text');

// ---- The empty conversation ----
html=panel();
ok(text(html).includes('Ask a question about this device')&&text(html).includes('Ask about problems, updates or performance. The assistant answers from the data Nodiverna collects from this device and can suggest commands.'),'the empty state before the first question shows assistant.empty.text');
check(buttons(html).filter(button=>assistantSuggestions.map(key=>t(key)).includes(buttonText(button))).length,4,'four suggestions as buttons');
ok(/<label class="sdx-field" for="sdx-assistant-question"><span>Question<\/span><textarea[^>]*autofocus/i.test(html),'the textarea with its label and autofocus');
ok(!/<textarea[^>]*maxlength/i.test(html),'no maxlength, so a longer text gets the field error');
const ask=buttons(html).find(button=>buttonText(button)==='Ask');
check([ask.blocked,ask.description,/sdx-btn-primary/.test(ask.attributes)],[true,'Enter a question first.',true],'Ask is primary and blocked while empty');
ok(text(html).includes('Answers come from Claude (Anthropic) with the key for the whole portal. Nothing runs on the device until you select Run on device. Check important answers before you act on them.'),'the source line and assistant.readOnlyNote: nothing runs before Run on device');
ok(!text(html).includes('the portal has'),'the drawer with a key no longer says "the portal has"');
{
 const german=text(render(h(DeviceAssistant,{server,viewer:member,demo:false,conversation:conversation(),onOpenArea:noop,initialStatus:{available:true,source:'organization',provider:'anthropic',model:'m'}}),'de'));
 ok(german.includes('Frag nach Problemen, Updates oder Leistung.')&&german.includes('Auf dem Gerät läuft nichts, bevor du „Auf Gerät ausführen“ auswählst.')&&!/(?:das|die) das Portal hat/.test(german),'the German drawer shows the new texts and not "das Portal hat"');
}
html=panel({demo:true});
ok(blockedReasons(html).every(reason=>reason==='Not available for sample devices.')&&blockedReasons(html).length===6,'with sample devices the suggestions, Ask and Earlier conversations are blocked');
check(askBlockedReason({question:'x'.repeat(2001),demo:false,pending:false},t),'Shorten the question to 2,000 characters or fewer.','a question over 2,000 characters');
check(askBlockedReason({question:'Why?',demo:false,pending:true},t),'Wait for the current answer.','while an answer is pending');
check(askBlockedReason({question:'Why?',demo:false,pending:false},t),undefined,'a question can be sent');
check(askBlockedReason({question:'  ',demo:false,pending:false},t),'Enter a question first.','only spaces');

// ---- Pending, answered and failed ----
const now=Date.now();
html=panel({conversation:conversation([{id:'a',question:'Why is it slow?',status:'pending',askedAt:now-5000}])});
ok(/<div class="sdx-assistant-pending" role="status" aria-live="polite"><span class="sdx-assistant-pulse" aria-hidden="true"><\/span>Reading the device data and writing an answer…/.test(html),'the pending row with the pulse dot');
ok(text(html).includes('Why is it slow?')&&!html.includes('sdx-assistant-enter'),'the question shows; an old message does not replay the entrance');
check(buttons(html).find(button=>buttonText(button)==='Ask').description,'Wait for the current answer.','Ask waits for the answer');
ok(buttons(html).some(button=>button.label==='New conversation'),'New conversation once there is a message');
const answered={id:'b',question:'Updates?',status:'done',answer:'One update is **pending**.',sources:['device_updates','device_overview','device_metrics'],askedAt:now-9000,answeredAt:now-8000};
html=panel({conversation:conversation([answered])});
ok(html.includes('<strong>pending</strong>'),'the answer is rendered');
check([...html.matchAll(/class="sdx-assistant-chip" aria-label="([^"]+)"/g)].map(match=>match[1].replace(/&#x27;/g,"'")),['Open Management › Windows Update','Open Overview'],'one chip per area in first-use order');
ok(buttons(html).some(button=>button.label==='Copy answer'),'Copy answer');
ok(render(h(DeviceAssistant,{server,viewer:member,demo:false,conversation:conversation([{...answered,answeredAt:Date.now()}]),onOpenArea:noop,initialStatus:{available:true,source:'organization',provider:'anthropic',model:'m'}})).includes('sdx-assistant-reply sdx-assistant-enter'),'a new answer rises in');
html=panel({conversation:conversation([{id:'c',question:'Broken?',status:'failed',error:'Anthropic did not answer in time. Ask again in a moment.',askedAt:now-9000,answeredAt:now-8000}])});
ok(text(html).includes('Broken?')&&/sdx-notice-danger/.test(html)&&text(html).includes('Anthropic did not answer in time.')&&buttons(html).some(button=>buttonText(button)==='Ask again'),'a failed question keeps the question, shows the error and Ask again');
check(historyOf([answered,{id:'c',question:'x',status:'failed',askedAt:0},...Array.from({length:12},(_,index)=>({id:`h${index}`,question:`q${index}`,status:'done',answer:`a${index}`,askedAt:0}))]).map(pair=>pair.question),Array.from({length:10},(_,index)=>`q${index+2}`),'at most the last 10 answered pairs');

// ---- Sources and the source line ----
check(Object.fromEntries(assistantToolNames.map(name=>[name,sourceChips([name],t)[0].label])),{
 device_overview:'Overview',device_hardware:'Hardware',device_gpu_drivers:'Hardware › Graphics card',device_features:'Management › Roles & features',device_metrics:'Overview',device_services:'Management › Services',device_processes:'Diagnostics › Processes',device_events:'Diagnostics › Events',
 device_updates:'Management › Windows Update',device_storage:'Management › Disks',device_network:'Management › Network',device_security:'Management › Defender',device_software:'Software › Programs',
 device_drivers:'Software › Drivers',device_autostart:'Software › Autostart',device_tasks:'Management › Scheduled tasks',device_jobs:'History',device_audit:'History'},'each tool opens its area');
check(sourceChips(['device_unknown','device_jobs','device_audit'],t).map(chip=>chip.label),['History'],'unknown names are dropped, one chip per area');
// A chip click calls onOpenArea with its area; the device page opens it through onSection(section, subarea).
// Software chips open the Software area (#device/<id>/software[/…]); the tasks chip opens Management › Scheduled tasks.
check(sourceChips(['device_drivers','device_software','device_autostart','device_tasks'],t).map(chip=>[chip.label,sourceAreaRoute(chip.area)]),[
 ['Software › Drivers',['software','drivers']],['Software › Programs',['software','programs']],['Software › Autostart',['software','autostart']],['Management › Scheduled tasks',['management','tasks']],
],'the Software and Scheduled tasks chips');
check(sourceChips(['device_gpu_drivers','device_features','device_hardware','device_services'],t).map(chip=>[chip.label,chip.area,sourceAreaRoute(chip.area)]),[
 ['Hardware › Graphics card',{section:'hardware',detail:'gpu'},['hardware','gpu']],
 ['Management › Roles & features',{section:'management',detail:'features'},['management','features']],
 ['Hardware',{section:'hardware'},['hardware',undefined]],
 ['Management › Services',{section:'management',detail:'services'},['management','services']],
],'the graphics card and roles and features chips open their subareas; Hardware stays a chip of its own');
check(sourceChips(['device_gpu_drivers'],(key,params)=>translate('de',key,params))[0].label,'Hardware › Grafikkarte','the German chip label');
check([assistantSourceLine({source:'organization',provider:'openai'},t),assistantSourceLine({source:'personal',provider:'openai'},t),assistantSourceLine({source:'customer',provider:'anthropic',customerName:'Alpha GmbH'},t)],
 ['Answers come from OpenAI with the key for the whole portal.','Answers come from OpenAI with your personal key.','Answers come from Claude (Anthropic) with the key of Alpha GmbH.'],'the source line per key');
ok(text(panel({initialStatus:{available:true,source:'customer',provider:'anthropic',model:'m',customerName:'Alpha GmbH'}})).includes('Answers come from Claude (Anthropic) with the key of Alpha GmbH.'),'the customer variant in the panel');
ok(text(render(h(DeviceAssistant,{server,viewer:member,demo:false,conversation:conversation(),onOpenArea:noop,initialStatus:{available:true,source:'personal',provider:'openai',model:'gpt-5'}}),'de')).includes(`Fragen zu ${server.name}`),'the German panel');

// ---- Proposal cards (slice 2) ----
const managedSnapshot={...server.snapshot,mode:'Management',agentCapabilities:['restart-service','list-processes','kill-process','assistant-powershell']};
const operatorServer={...server,permissions:['view','diagnose','manage','terminal'],snapshot:managedSnapshot};
const base={reason:'The **spooler** stopped. <b>bold</b> [link](https://evil.example)',readOnly:false,disruptive:false,mfa:true};
const restart={...base,id:'p-restart',type:'action',kind:'restart-service',params:{name:'Spooler'},target:'Spooler'};
const processes={...base,id:'p-list',type:'action',kind:'list-processes',params:{limit:500,sampleMs:350},target:'',readOnly:true,mfa:false};
const kill={...base,id:'p-kill',type:'action',kind:'kill-process',params:{pid:100,startedAt:'2026-11-05T08:00:00Z',confirm:true},target:'PID 100',disruptive:true};
const script={...base,id:'p-ps',type:'powershell',kind:'assistant-powershell',params:{},target:'',readOnly:true,disruptive:true,script:'Get-WinEvent -LogName System -MaxEvents 5\nWrite-Output "<done>"\n',timeoutSeconds:120};
const withProposals=(proposals,runs={},extra={})=>panel({server:operatorServer,conversation:conversation([{id:'a1',question:'Fix the spooler?',status:'done',answer:'Here is what I propose.',sources:['device_services'],proposals,askedAt:now-9000,answeredAt:now-8000}],{runs,...extra}),...extra.props});
const cards=html=>[...html.matchAll(/<div class="sdx-assistant-proposal(?: [^"]*)?"[\s\S]*?(?=<div class="sdx-assistant-proposal[ "]|<div class="sdx-assistant-reply-foot")/g)].map(match=>match[0]);
html=withProposals([restart,processes,kill,script]);
const [restartCard,listCard,killCard,scriptCard]=cards(html);
ok(html.indexOf('sdx-assistant-proposals')>html.indexOf('Here is what I propose.')&&html.indexOf('sdx-assistant-proposals')<html.indexOf('sdx-assistant-sources'),'the cards sit under the answer text, before the Sources row');
check([/sdx-icon-tile-warning/.test(restartCard),/lucide-wrench/.test(restartCard),/sdx-icon-tile-accent/.test(listCard),/lucide-square-terminal/.test(scriptCard)],[true,true,true,true],'the icon tile: Wrench or SquareTerminal, warn for changing and accent for read-only');
ok(/<strong>Restart service<\/strong><span class="mono">Spooler<\/span>/.test(restartCard)&&/<strong>Query processes<\/strong>/.test(listCard)&&/<strong>PowerShell script<\/strong>/.test(scriptCard),'the title: the job label and the target in .mono, or PowerShell script');
check([restartCard,listCard,killCard,scriptCard].map(card=>card.match(/class="sdx-pill sdx-pill-(\w+)"><i aria-hidden="true"><\/i>([^<]+)/).slice(1)),[['warning','Changes the device'],['neutral','Only reads'],['critical','Can interrupt the device'],['critical','Can interrupt the device']],'the pill: Only reads, Changes the device or Can interrupt the device');
ok(restartCard.includes('<strong>spooler</strong>')&&restartCard.includes('&lt;b&gt;bold&lt;/b&gt;')&&!/<a\b/.test(restartCard),'the reason through the slice-1 renderer: no HTML, no link');
ok(/<dt>name<\/dt><dd><span class="mono">Spooler<\/span><\/dd>/.test(restartCard)&&/<dt>limit<\/dt><dd><span class="mono">500<\/span>/.test(listCard)&&/sdx-assistant-proposal-params/.test(restartCard),'the parameters of an action as Facts in .mono');
ok(scriptCard.includes('<pre tabindex="0" aria-label="PowerShell script"><code>Get-WinEvent -LogName System -MaxEvents 5\nWrite-Output &quot;&lt;done&gt;&quot;\n</code></pre>')&&text(scriptCard).includes('2 lines')&&text(scriptCard).includes('Runs as SYSTEM. Read the script before you run it.'),'the full script in a focusable pre, never cut, with the line count and the SYSTEM note');
ok(!/<dl/.test(scriptCard),'a script shows no Facts');
const cardButtons=card=>buttons(card).map(button=>[buttonText(button),button.blocked]);
check(cardButtons(restartCard),[['Run on device',false],['Don’t run',false]],'Run on device first, then Don’t run');
ok(/sdx-btn-primary/.test(buttons(restartCard)[0].attributes)&&/sdx-btn-ghost/.test(buttons(restartCard)[1].attributes),'a primary and a ghost button');

// Blocked reasons, never hidden.
const blocked=(proposal,extra={})=>proposalBlockedReason(proposal,{server:operatorServer,viewer:member,demo:false,online:true,busy:false,...extra},t);
check(blocked(restart,{demo:true}),'Not available for sample devices.','demo mode');
check(blocked(restart,{online:false}),'The device is offline. Run the command when the agent is connected again.','offline');
check(blocked(restart,{server:{...operatorServer,permissions:['view','diagnose']}}),'You need the permission “manage” on this device.','a missing base right');
check(blocked(script,{server:{...operatorServer,permissions:['view','diagnose','manage']}}),'You need the permission “terminal” on this device.','terminal for a script');
check(blocked(kill,{server:{...operatorServer,permissions:['view','manage']}}),'You need the permission “diagnose” on this device.','diagnose for a changing diagnosis');
check([blocked(restart,{server:{...operatorServer,snapshot:{...managedSnapshot,mode:'ReadOnly'}}}),blocked(processes,{server:{...operatorServer,snapshot:{...managedSnapshot,mode:'ReadOnly'}}})],['The agent runs in Read-only mode. Turn on Management mode on the device first.',undefined],'ReadOnly blocks a changing kind only');
check(blocked(script,{server:{...operatorServer,snapshot:{...managedSnapshot,agentCapabilities:['restart-service']}}}),'The agent is too old for this command. Update the agent first.','a missing capability');
check(blocked(restart,{busy:true}),'Wait until the running command has finished.','another command still running');
check(blocked(restart),undefined,'nothing blocks');
html=withProposals([restart],{},{busy:true});
check(buttons(cards(html)[0]).find(button=>buttonText(button)==='Run on device').description,'Wait until the running command has finished.','the card shows the busy reason on Run on device');
ok(blockedReasons(panel({server:operatorServer,demo:true,initialStatus:undefined,conversation:conversation([{id:'a1',question:'q',status:'done',answer:'a',proposals:[restart],askedAt:0,answeredAt:0}])})).includes('Not available for sample devices.'),'demo blocks Run on device');

// Run on device: read-only at once, a changing action and every script after a confirmation.
const spies=()=>{const calls={confirm:[],action:[],sending:[],refused:[],started:[]};return {calls,onConfirm:value=>calls.confirm.push(value),onAction:async(...args)=>{calls.action.push(args);},conversation:{runHandlers:()=>({sending:(id,value)=>calls.sending.push([id,value]),refused:(id,value)=>calls.refused.push([id,value]),started:(proposal,id)=>calls.started.push([proposal.id,id])})}};};
let spy=spies();
runProposal(processes,{server:operatorServer,t,locale:'en',...spy});
check([spy.calls.confirm.length,spy.calls.action.length],[0,1],'a read-only action posts at once, without a confirmation');
const [payload,settle,options]=spy.calls.action[0];
check([payload,options],[{action:'run',serverId:operatorServer.id,command:{type:'action',kind:'list-processes',params:{limit:500,sampleMs:350}},confirm:true},{endpoint:'/api/assistant',success:'Run started on the device.'}],'the run payload and the console send options with the toast');
check(spy.calls.sending,[['p-list',true]],'the button shows its loading state while the request is out');
settle({ok:true,id:'job-1'});settle({ok:false,code:'QUEUE_FULL',message:'20 jobs are already waiting for this server.'});
check([spy.calls.started,spy.calls.refused],[[['p-list','job-1']],[['p-list','20 jobs are already waiting for this server.']]],'the job ID starts the polling; a refusal keeps the card with its error');
// An outcome after the conversation was left (New conversation, an earlier one opened) changes nothing:
// the handlers are bound to the round in which Run on device started.
{
 const calls={sending:[],refused:[],started:[]};let round=1,settleRun,finish;
 const conversationAt=()=>({runHandlers:()=>{const start=round;return runHandlersFor(()=>round===start,{sending:(id,value)=>calls.sending.push([id,value]),refused:(id,value)=>calls.refused.push([id,value]),started:(proposal,id)=>calls.started.push([proposal.id,id])});}});
 const onAction=(_payload,settle)=>{settleRun=settle;return new Promise(resolve=>{finish=resolve;});};
 runProposal(processes,{server:operatorServer,t,locale:'en',conversation:conversationAt(),onAction});
 check(calls.sending,[['p-list',true]],'the run starts in the shown conversation');
 round=2;
 settleRun({ok:true,id:'job-late'});settleRun({ok:false,message:'Refused.'});finish();await Promise.resolve();await Promise.resolve();
 check(calls,{sending:[['p-list',true]],refused:[],started:[]},'a run that settles after the conversation was left starts no polling, no refusal and no sending change in the conversation shown now');
 let confirmed;
 runProposal(restart,{server:operatorServer,t,locale:'en',conversation:conversationAt(),onConfirm:value=>{confirmed=value;}});
 round=3;confirmed.onSettled({ok:true,id:'job-confirmed'});
 check(calls.started,[],'also after a confirmation');
 runProposal(restart,{server:operatorServer,t,locale:'en',conversation:conversationAt(),onConfirm:value=>{confirmed=value;}});
 confirmed.onSettled({ok:true,id:'job-now'});
 check(calls.started,[['p-restart','job-now']],'an outcome in the same conversation still starts the polling');
}
spy=spies();runProposal(restart,{server:operatorServer,t,locale:'en',...spy});
check(spy.calls.action.length,0,'a changing action sends nothing before the confirmation');
const restartConfirm=spy.calls.confirm[0];
check({...restartConfirm,onSettled:undefined},{title:`Run Restart service · Spooler on ${server.name}?`,description:'The assistant proposed this command. It runs with your permissions, and the job shows in the history of the device.',
 lines:[{label:'Device',value:server.name},{label:'Command',value:'Restart service · Spooler'}],confirmLabel:'Run on device',tone:'default',payload:runPayload(restart,operatorServer.id),endpoint:'/api/assistant',success:'Run started on the device.',onSettled:undefined},'the confirmation of a changing action');
spy=spies();runProposal(kill,{server:operatorServer,t,locale:'en',...spy});
check(spy.calls.confirm[0].tone,'danger','a disruptive action confirms with the danger tone');
spy=spies();runProposal(script,{server:operatorServer,t,locale:'en',...spy});
const scriptConfirm=spy.calls.confirm[0];
check([scriptConfirm.title,scriptConfirm.tone,scriptConfirm.description,scriptConfirm.lines[1].value,scriptConfirm.payload.command],[`Run PowerShell script on ${server.name}?`,'danger','The script runs as SYSTEM on the device. Run it only if you understand every line.','PowerShell script, 2 lines',{type:'powershell',script:script.script,timeoutSeconds:120}],'every script confirms with the danger tone and the line count');
ok(needsConfirmation({...script,readOnly:true})&&!needsConfirmation(processes),'also a script that only reads');
check([scriptConfirm.stepUpFirst,'stepUpFirst' in restartConfirm],[true,false],'a script opens the step-up dialog before it is sent (rule 5, as the terminal); an action does not');
// The confirmed script goes through the console action with stepUpFirst: the dialog first, then one send with the proof.
const scriptRun=async verify=>{
 const posts=[],outcomes=[];let retry=null;
 const deps={demo:false,canOffboard:()=>false,post:async(body,endpoint)=>{posts.push([body,endpoint]);return Response.json({id:'job-ps'});},openStepUp:next=>{retry=next;},toast:{success:noop,error:noop},onRemoved:noop,refresh:noop,setSaving:noop,locale:'en',onSettled:outcome=>outcomes.push(outcome)};
 const options=confirmationOptions(scriptConfirm);
 deps.action=next=>runConsoleAction(next,deps,options);
 await runConsoleAction(scriptConfirm.payload,deps,options);
 const before=posts.length;
 if(verify&&retry)await retry({managementToken:'fresh-proof'});
 return {before,posts,outcomes};
};
let scripted=await scriptRun(true);
check([scripted.before,scripted.posts.length,scripted.posts[0][0].managementToken,scripted.posts[0][1],scripted.outcomes],[0,1,'fresh-proof','/api/assistant',[{ok:true,id:'job-ps'}]],'nothing goes out before the step-up; then one run with the proof');
scripted=await scriptRun(false);
check([scripted.posts.length,scripted.outcomes],[0,[]],'a cancelled step-up sends no script and leaves the card');

// The MFA code opens the prompt and resends once; cancelling it leaves the card.
const mfaRun=async verify=>{
 const posts=[],toasts=[],outcomes=[];let retry=null;
 const replies=[Response.json({error:'MFA',code:'MFA_LOGIN_REQUIRED',messageKey:'apiError.mfa.loginRequired'},{status:403}),Response.json({id:'job-mfa'})];
 const deps={demo:false,canOffboard:()=>false,post:async(body,endpoint)=>{posts.push([body,endpoint]);return replies.shift();},openStepUp:next=>{retry=next;},toast:{success:value=>toasts.push(value),error:value=>toasts.push('error:'+value)},onRemoved:noop,refresh:noop,setSaving:noop,locale:'en',onSettled:outcome=>outcomes.push(outcome)};
 deps.action=next=>runConsoleAction(next,deps,runOptions(t));
 await runConsoleAction(runPayload(restart,operatorServer.id),deps,runOptions(t));
 if(verify&&retry)await retry({managementToken:'proof'});
 return {posts,toasts,outcomes,prompted:!!retry};
};
let mfa=await mfaRun(true);
check([mfa.prompted,mfa.posts.length,mfa.posts.map(([,endpoint])=>endpoint),mfa.outcomes,mfa.toasts.at(-1)],[true,2,['/api/assistant','/api/assistant'],[{ok:true,id:'job-mfa'}],'Run started on the device.'],'the MFA code opens the prompt, the same run goes out once more and the job ID reaches the card');
check(mfa.posts[0][0],mfa.posts[1][0],'the resend is the same run');
mfa=await mfaRun(false);
check([mfa.prompted,mfa.posts.length,mfa.outcomes],[true,1,[]],'a cancelled MFA prompt sends nothing more and leaves the card unchanged');

// After the run: the status row, the final pill, the result and the long wait.
const run=(status,extra={})=>cards(withProposals([restart],{'p-restart':{status,jobId:'job-1',...extra}}))[0];
let shown=run('queued');
ok(/<div class="sdx-assistant-pending" role="status" aria-live="polite"><span class="sdx-assistant-pulse" aria-hidden="true"><\/span>Waiting for the agent…/.test(shown)&&!buttons(shown).length,'queued: the buttons give way to the status row with the live pulse');
ok(text(run('running')).includes('Running on the device…'),'running');
shown=run('finished',{result:'Service restarted.'});
ok(/sdx-pill-success"><i aria-hidden="true"><\/i>Finished/.test(shown)&&text(shown).includes('Service restarted.')&&!shown.includes('sdx-assistant-pulse')&&/class="sdx-assistant-proposal-pill"/.test(shown),'finished: the pill says Finished and the result text shows');
ok(/sdx-pill-critical"><i aria-hidden="true"><\/i>Failed/.test(run('failed',{result:'Access is denied.'})),'failed: the pill says Failed');
ok(text(run('stale')).includes('This takes longer than usual. You see the progress under Jobs, and you can ask about the result later.'),'after 10 minutes: still running');
shown=run('open',{error:'You do not have the permission for this device: manage.'});
ok(/sdx-notice-danger/.test(shown)&&cardButtons(shown).length===2,'a refused run keeps the buttons and shows the error under them');
shown=run('dismissed');
ok(text(shown).includes('Restart service Spooler Not run.')&&!buttons(shown).length&&/is-dismissed/.test(shown),'Don’t run collapses the shown into one muted line without buttons');
check(proposalPill(restart,{status:'finished'},t).key===proposalPill(restart,undefined,t).key,false,'the pill gets a new key on the final state, so it cross-fades');

// The follow-up: the reading row, the history pair, the poll schedule.
html=panel({conversation:conversation([{id:'f1',question:'Result of Restart service · Spooler: Finished',followUp:{jobId:'job-1'},status:'pending',askedAt:now-1000}])});
ok(text(html).includes('Reading the result and writing an answer…')&&!html.includes('class="sdx-assistant-question'),'a follow-up shows the reading row and no question bubble');
const question=resultQuestion(restart,'succeeded',t,'en');
check([question,resultQuestion(script,'failed',t,'en'),resultQuestion(restart,'succeeded',(key,params)=>translate('de',key,params),'de')],['Result of Restart service · Spooler: Finished','Result of PowerShell script, 2 lines: Failed','Ergebnis von Dienst neu starten · Spooler: Abgeschlossen'],'the history question of a follow-up in the UI language');
ok(validAssistantQuestion(question),'a valid history question');
check(historyOf([{id:'a1',question:'Fix it?',status:'done',answer:'Restart it.',askedAt:0},{id:'f1',question,followUp:{jobId:'job-1'},status:'done',answer:'It runs again.',askedAt:0}]),[{question:'Fix it?',answer:'Restart it.'},{question,answer:'It runs again.'}],'the follow-up enters the history as a plain pair');
check([0,1999,29_999,30_000,599_999,600_000].map(pollDelay),[2000,2000,2000,5000,5000,null],'every 2 s for 30 s, then every 5 s, for at most 10 minutes');
const track=async(states,{endAfter=Infinity}={})=>{
 let clock=0,polls=0;const waits=[],updates=[];
 const outcome=await trackAssistantJob({now:()=>clock,wait:async ms=>{waits.push(ms);clock+=ms;return waits.length<=endAfter;},fetchJob:async()=>{const state=states[Math.min(polls++,states.length-1)];if(state==='error')throw new Error('offline');return {id:'job-1',kind:'refresh',state,result:null,resultCode:null,resultArgs:null,finished:['succeeded','failed','cancelled','expired'].includes(state)};},onUpdate:job=>updates.push(job.state)});
 return {outcome,waits,updates,clock};
};
let tracked=await track(['pending','error','running','succeeded','succeeded']);
check([tracked.outcome.state,tracked.updates,tracked.waits],['succeeded',['pending','running','succeeded'],[2000,2000,2000,2000]],'the poll stops at the first final state, once, and a failed poll is tried again');
tracked=await track(['pending']);
check([tracked.outcome,tracked.clock>=600_000,tracked.waits.filter(ms=>ms===2000).length],['stale',true,15],'without a final state the polling stops after 10 minutes');
check((await track(['pending'],{endAfter:2})).outcome,'ended','a new conversation ends the polling');
check(commandBusy({a:{status:'dismissed'},b:{status:'finished'}}),false,'finished and dismissed cards keep nothing busy');
check([commandBusy({a:{status:'queued'}}),commandBusy({a:{status:'open',sending:true}})],[true,true],'a queued or sending command is busy');

// The confirmations of the GPU driver, shutdown, power, page file, feature and disk kinds.
{
 const gpuDriver={...base,id:'p-gpu',type:'action',kind:'install-gpu-driver',params:{vendor:'nvidia',version:'566.36'},target:'NVIDIA 566.36',disruptive:true};
 const shutdown={...base,id:'p-off',type:'action',kind:'shutdown-computer',params:{delaySeconds:600,reason:'Maintenance'},target:'Maintenance',disruptive:true};
 const plannedOff={...base,id:'p-plan-off',type:'action',kind:'schedule-power',params:{operation:'shutdown',scheduledAt:'2026-12-01T22:00:00.000Z',reason:'Move'},target:'Herunterfahren / 2026-12-01T22:00:00.000Z',disruptive:true};
 const plannedRestart={...plannedOff,id:'p-plan-restart',params:{...plannedOff.params,operation:'restart'},target:'Neustart / 2026-12-01T22:00:00.000Z'};
 const feature={...base,id:'p-feature',type:'action',kind:'install-feature',params:{name:'Telnet-Client',includeManagementTools:true},target:'Telnet-Client'};
 const disks={...base,id:'p-disks',type:'action',kind:'storage-inspect',params:{},target:'Datenträgerinventar',readOnly:true,mfa:false};
 const confirmOf=proposal=>proposalConfirmation(proposal,operatorServer,t,'en',noop);
 const gpuConfirm=confirmOf(gpuDriver);
 check([gpuConfirm.title,gpuConfirm.tone,gpuConfirm.description,gpuConfirm.lines,gpuConfirm.confirmLabel],[`Run Update graphics driver · NVIDIA 566.36 on ${server.name}?`,'danger',`${t('assistant.confirm.text')}\n\n${t('hardware.gpuDriver.confirm.warning')}`,[{label:'Device',value:server.name},{label:'Command',value:'Update graphics driver · NVIDIA 566.36'}],'Run on device'],'the GPU driver: danger, with the console warning after an empty line');
 ok(gpuConfirm.description.includes('The screen goes dark for a few seconds'),'the same words as the console GPU dialog');
 for(const proposal of [shutdown,plannedOff]){
  const confirm=confirmOf(proposal);
  check([confirm.tone,confirm.description],['danger',`${t('assistant.confirm.text')}\n\n${t('assistant.confirm.shutdownWarning')}`],`${proposal.kind}: danger with the shutdown warning`);
 }
 const restartPlan=confirmOf(plannedRestart);
 check([restartPlan.tone,restartPlan.description],['danger',t('assistant.confirm.text')],'a planned restart: danger, without the shutdown warning');
 check([confirmOf(feature).tone,confirmOf(feature).description],['default',t('assistant.confirm.text')],'a feature: the existing confirmation');
 check(proposalConfirmation(gpuDriver,operatorServer,(key,params)=>translate('de',key,params),'de',noop).lines[1].value,'Grafiktreiber aktualisieren · NVIDIA 566.36','the German command line');
 const diskSpy=spies();runProposal(disks,{server:{...operatorServer,snapshot:{...managedSnapshot,agentCapabilities:['storage-inspect']}},t,locale:'en',...diskSpy});
 check([needsConfirmation(disks),diskSpy.calls.confirm.length,diskSpy.calls.action.length],[false,0,1],'storage-inspect runs on the click, without a confirmation');
 const gpuSpy=spies();runProposal(gpuDriver,{server:operatorServer,t,locale:'en',...gpuSpy});
 check([gpuSpy.calls.action.length,gpuSpy.calls.confirm[0]?.tone],[0,'danger'],'the GPU driver opens the danger confirmation through runProposal and sends nothing before it');
 ok(!proposalBlockedReason(gpuDriver,{server:{...operatorServer,snapshot:{...managedSnapshot,agentCapabilities:['install-gpu-driver']}},viewer:member,demo:false,online:true,busy:false},t),'a GPU proposal can run with manage, Management mode and the capability');
 check(proposalBlockedReason(gpuDriver,{server:operatorServer,viewer:member,demo:false,online:true,busy:false},t),t('assistant.proposal.blocked.agent'),'without the capability the card says why');
 ok(text(withProposals([gpuDriver])).includes('Update graphics driver NVIDIA 566.36'),'the card title is the existing label and the target');
}
for(const key of ['assistant.confirm.shutdownWarning','assistant.empty.text','help.assistant.tip3','hardware.gpuDriver.confirm.warning','device.gpu.card','device.area.features'])
 ok(Object.hasOwn(enCatalog,key)&&Object.hasOwn(deCatalog,key),`${key} is in both catalogs`);
check([t('assistant.confirm.shutdownWarning'),translate('de','assistant.confirm.shutdownWarning')],['The device stays off until someone starts it. Nodiverna cannot start it again.','Das Gerät bleibt aus, bis es jemand startet. Nodiverna kann es nicht wieder starten.'],'the shutdown warning in both languages');
check([t('help.assistant.tip3'),translate('de','assistant.empty.text')],['The assistant can propose commands, for example to restart a service or to update the graphics driver. A command runs only when you select “Run on device”, with your permissions and with MFA when the action needs it.','Frag nach Problemen, Updates oder Leistung. Der Assistent antwortet mit den Daten, die Nodiverna von diesem Gerät sammelt, und kann Befehle vorschlagen.'],'the changed texts that name the graphics driver update');

// The copy of slice 2.
for(const key of ['assistant.proposal.powershell','assistant.proposal.lines','assistant.proposal.reads','assistant.proposal.changes','assistant.proposal.disruptive','assistant.proposal.asSystem','assistant.proposal.run','assistant.proposal.dismiss','assistant.proposal.dismissed','assistant.proposal.sent','assistant.proposal.queued','assistant.proposal.running','assistant.proposal.finished','assistant.proposal.failed','assistant.proposal.reading','assistant.proposal.stillRunning','assistant.proposal.resultQuestion','assistant.proposal.blocked.offline','assistant.proposal.blocked.right','assistant.proposal.blocked.readOnly','assistant.proposal.blocked.agent','assistant.proposal.blocked.busy','assistant.confirm.title','assistant.confirm.device','assistant.confirm.command','assistant.confirm.text','assistant.confirm.powershellText','jobs.action.assistantPowershell'])
 ok(Object.hasOwn(enCatalog,key)&&Object.hasOwn(deCatalog,key),`${key} is in both catalogs`);
check([t('assistant.empty.text'),translate('de','assistant.proposal.run'),t('help.assistant.tip3').includes('Run on device')],['Ask about problems, updates or performance. The assistant answers from the data Nodiverna collects from this device and can suggest commands.','Auf Gerät ausführen',true],'the replaced slice-1 texts and one name for the action');

// ---- Earlier conversations ----
const headButtons=html=>buttons(html.slice(html.indexOf('sdx-card-actions'),html.indexOf('sdx-assistant-thread'))).map(button=>[button.label,button.blocked,button.description]);
check(headButtons(panel({conversation:conversation([answered])})),[['Earlier conversations',true,'There are no earlier conversations yet.'],['New conversation',false,null]],'the card head: Earlier conversations before New conversation, blocked while the list is empty');
check(headButtons(panel({demo:true})),[['Earlier conversations',true,'Not available for sample devices.']],'sample devices: blocked with the demo reason, never hidden');
const earlierRows=[
 {id:'c-new',serverId:server.id,device:server.name,title:'Why is the disk full?',questions:2,updatedAt:now-120_000,thisDevice:true},
 {id:'c-old',serverId:'other',device:'SRV-OTHER',title:'Which updates are missing?',questions:1,updatedAt:now-7_200_000,thisDevice:false},
];
check(headButtons(panel({earlier:earlierRows})),[['Earlier conversations',false,null]],'with kept conversations the button opens the drawer');
html=panel({earlier:earlierRows,conversation:conversation([answered])});
ok(/lucide-(?:history|rotate-ccw-clock)/.test(html.slice(html.indexOf('sdx-card-actions'),html.indexOf('New conversation'))),'with the History icon (lucide names it rotate-ccw-clock)');
html=render(h(EarlierConversationList,{rows:earlierRows,now,onOpen:noop}));
const rowButtons=buttons(html);
ok(/^<ul class="sdx-assistant-earlier" role="list" aria-label="Earlier conversations">/.test(html),'a labelled list of buttons');
check(rowButtons.map(button=>button.label),[`Open the conversation “Why is the disk full?” about ${server.name}`,'Open the conversation “Which updates are missing?” about SRV-OTHER'],'the accessible name of each row');
check(rowButtons.map(button=>text(button.inner)),[`Why is the disk full? ${server.name} · 2 questions · 2 min ago This device`,'Which updates are missing? SRV-OTHER · 1 question · 2 h ago'],'title, meta line with device, questions and time, and the This device tag');
ok(rowButtons.every(button=>/class="sdx-assistant-earlier-row sdx-lift"/.test(button.attributes)&&/type="button"/.test(button.attributes)),'each row is one button that lifts on hover');
ok(/sdx-icon-tile sdx-icon-tile-accent sdx-icon-tile-sm[\s\S]*?lucide-sparkles/.test(rowButtons[0].inner),'an accent Sparkles icon tile per row');
check((html.match(/class="sdx-tag"/g)??[]).length,1,'only the row of the open device carries the tag');
const german=render(h(EarlierConversationList,{rows:earlierRows,now,onOpen:noop}),'de');
check(buttons(german).map(button=>button.label),[`Gespräch „Why is the disk full?“ zu ${server.name} öffnen`,'Gespräch „Which updates are missing?“ zu SRV-OTHER öffnen'],'the German accessible names');
ok(text(german).includes('2 Fragen')&&text(german).includes('1 Frage')&&text(german).includes('Dieses Gerät')&&/aria-label="Frühere Gespräche"/.test(german),'the German meta line, tag and list name');
const assistantCss=readFileSync('ui/devices/assistant/assistant.css','utf8'),earlierCss=assistantCss.slice(assistantCss.indexOf('/* ---- Earlier conversations'),assistantCss.indexOf('/* ---- Key settings'));
ok(earlierCss.includes('-webkit-line-clamp: 2')&&!/#[0-9a-f]{3,8}|rgba?\(|@keyframes/i.test(earlierCss),'the title clamps to 2 lines; tokens only, no new keyframes');
ok(!/(?:10|14|18|6)px/.test(earlierCss.replace(/\/\*[\s\S]*?\*\//g,'')),'the 4px rhythm');
// A failed message after a closed conversation, and a card that is not followed any more.
html=panel({conversation:conversation([{id:'i1',question:'Still slow?',status:'failed',error:t('assistant.interrupted'),askedAt:now-9000}])});
ok(text(html).includes('This question got no answer before the conversation was closed. Select Ask again to get an answer.')&&buttons(html).some(button=>buttonText(button)==='Ask again')&&!html.includes('sdx-assistant-enter'),'an interrupted question shows Ask again and does not rise in');
shown=run('untracked');
ok(text(shown).includes('The assistant stopped following this command when the conversation was closed. You see its result under Jobs, and you can ask about it here.')&&/lucide-clock/.test(shown)&&!buttons(shown).length&&!shown.includes('sdx-assistant-pulse'),'untracked: the note with the Clock icon, no Run on device and no pulse');
check(commandBusy({a:{status:'untracked'}}),false,'an untracked card keeps nothing busy');
for(const key of ['assistant.earlier','assistant.earlier.description','assistant.earlier.blocked','assistant.earlier.meta','assistant.earlier.questions','assistant.earlier.thisDevice','assistant.earlier.open','assistant.kept','assistant.interrupted','assistant.proposal.untracked'])
 ok(Object.hasOwn(enCatalog,key)&&Object.hasOwn(deCatalog,key),`${key} is in both catalogs`);
check([translate('de','assistant.kept'),translate('de','assistant.earlier.blocked')],['Das Gespräch bleibt unter „Frühere Gespräche“ erhalten.','Es gibt noch keine früheren Gespräche.'],'the German toast and blocked reason');
const deviceSource=readFileSync('ui/devices/device/device.tsx','utf8');
ok(/useAssistantConversation\(server\.id,demo\?undefined:\{userId:viewer\.userId\?\?viewer\.id/.test(deviceSource),'sample devices keep nothing; the store is bound to the viewer');
ok(readFileSync('ui/shell/console.tsx','utf8').includes("onOpenDeviceAssistant={id=>{openServer(id);setAssistantDevice(id);}}"),'another device opens with its assistant drawer');

// ---- Settings › AI assistant ----
check([canOpenAccessSection(owner,'assistant'),canOpenAccessSection(member,'assistant'),canOpenAccessSection({permissions:['portal.users.manage']},'assistant')],[true,false,false],'only Owners open the page');
const consoleSource=readFileSync('ui/shell/console.tsx','utf8');
const {navNode:assistantNavNode}=await import('../../../ui/shell/nav-model.ts'),assistantPage=assistantNavNode('settings.assistant');
check([assistantPage.label,assistantPage.hint,assistantPage.icon,assistantPage.placement.group,assistantPage.section],['nav.settings.assistant','nav.settings.assistantHint','Sparkles','nav.settings.groupIntegrations','assistant'],'the page is a settings page of the navigation model under Integrations');
const key={provider:'anthropic',model:'claude-opus-5-5',keyHint:'AAAA',revision:0,updatedAt:now};
const settings=(view,extra={})=>render(h(AssistantSettingsPanel,{viewer:owner,demo:false,initialView:view,now,...extra}));
html=settings({personal:null,organization:null,customerKeys:{visible:false,customers:[]}});
ok(text(html).includes('Organization key')&&text(html).includes('Not set up')&&html.includes('sdx-icon-tile'),'the organization card with its status as the focal point');
ok(/<fieldset class="sdx-choice sdx-assistant-providers"><legend>Provider<\/legend>/.test(html)&&text(html).includes('Claude (Anthropic)')&&text(html).includes('OpenAI'),'the provider choice');
ok(/type="password" autoComplete="off"/i.test(html)&&html.includes('value="claude-opus-5-5"'),'the key field and the default model');
check(buttons(html).find(button=>buttonText(button)==='Save').description,'No changes.','Save is blocked until something changed');
ok(!buttons(html).some(button=>buttonText(button)==='Discard')&&!html.includes('sdx-danger-zone'),'no Discard and no removal without a change and without a key');
ok(!text(html).includes('Customer keys'),'no customer section with one customer');
html=settings({personal:null,organization:key,customerKeys:{visible:false,customers:[]}});
ok(text(html).includes('Set up')&&html.includes('placeholder="The saved key ends in AAAA. Enter a new key to replace it."'),'a saved key: Set up, the empty field names the hint');
ok(html.includes('sdx-danger-zone')&&text(html).includes('Remove organization key'),'the removal in the danger zone');
ok(buttons(html).some(button=>buttonText(button)==='Test key'),'Test key');
const sample=settings({personal:null,organization:key},{demo:true});
check(blockedReasons(sample).includes('Not available for sample devices.'),false,'with sample devices nothing is blocked: the page changes the real settings');
// The page on the kit: one SettingsPage, Field for API key and Model,
// FormActions with Test key as extra, the kit DangerZone, the drawer with dirty, useStepUp and no demo block.
{
 const panelSource=readFileSync('ui/settings/assistant-settings-panel.tsx','utf8');
 html=settings({personal:null,organization:key,customerKeys:{visible:false,customers:[]}});
 ok(html.startsWith('<div class="sdx-settings-page sdx-assistant-settings"><div class="sdx-settings">'),'one kit SettingsPage');
 ok(/<label class="sdx-field-label" for="sdx-assistant-organization-key">API key<\/label>/.test(html)&&/<label class="sdx-field-label" for="sdx-assistant-organization-model">Model<\/label>/.test(html),'API key and Model are kit Fields with bound labels');
 const actions=html.slice(html.indexOf('<div class="sdx-form-actions">'),html.indexOf('</div>',html.indexOf('<div class="sdx-form-actions">')));
 check(buttons(actions).map(buttonText),['Test key','Save'],'FormActions with Test key as extra, then Save');
 ok(/<section class="sdx-danger-zone" aria-labelledby="[^"]+"><div><strong id="[^"]+">Remove organization key<\/strong>/.test(html)&&/sdx-btn-danger/.test(html),'the removal is the kit DangerZone with a danger Btn');
 ok(!/<div className="sdx-danger-zone">/.test(panelSource)&&/<DangerZone /.test(panelSource),'no hand-built danger zone markup');
 ok(/<KeyDangerZone editor=\{editor\}/.test(panelSource)&&/loading=\{editor\.removing\} blocked=\{editor\.busy&&!editor\.removing\?t\('kit\.busy'\):undefined\}/.test(panelSource),'DangerZone loading while removing, blocked with kit.busy while another request of the card runs');
 ok(/<Drawer open onClose=\{onClose\} dirty=\{editor\.dirty\}/.test(panelSource)&&/<DrawerCancel\/>/.test(panelSource),'the customer drawer passes dirty and uses DrawerCancel');
 ok(/useStepUp<KeyPayload/.test(panelSource)&&!/pending=useRef|stepUpRetry\(|setStepUp\(/.test(panelSource),'the key changes run through useStepUp; no local pending or retry');
 ok(!/common\.demoBlocked|\bdemo\b|SettingsLoadState/.test(panelSource),'no demo block, no SettingsLoadState');
 html=settings(null);
 ok(html.includes('role="status"')&&html.includes('aria-label="AI assistant"'),'first load: the SettingsPage Skeleton with the page label');
 ok(!/sdx-loading|common\.reload/.test(panelSource+readFileSync('ui/account/personal-assistant-key.tsx','utf8')),'no classic loading or reload label');
 check(assistantLoadError(true,true,(k)=>translate('en',k)),'Nodiverna could not load the AI assistant settings. The last loaded state is shown.','the stale-data note after a failed reload');
 check(assistantLoadError(true,false,(k)=>translate('en',k)),'Nodiverna could not load the AI assistant settings.','the load error without data');
}


// ---- Customer keys ----
const customer=(name,keyed=false,disabled=false,index=0)=>({customerId:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,customerName:name,customerDisabled:disabled,key:keyed?{...key,keyHint:'CCCC'}:null});
const customers=[customer('Alpha GmbH',true,false,1),customer('Beta AG',false,true,2),customer('Gamma',false,false,3)];
html=settings({personal:null,organization:null,customerKeys:{visible:true,customers}});
ok(text(html).includes('Customer keys')&&/sdx-assistant-count[^>]*>Own key: 1 of 3/.test(html),'the customer card with its count');
{
 // Both intros are card descriptions; the count stays in the head actions.
 const heads=[...html.matchAll(/<header class="sdx-section-head sdx-card-head">([\s\S]*?)<\/header>/g)].map(match=>match[1]);
 const of=key=>heads.find(head=>head.includes(t(key).replace(/'/g,'&#x27;')));
 ok(of('assistantSettings.organization.text')?.includes(`<p>${t('assistantSettings.organization.text')}</p>`),'the organization intro is the description paragraph');
 const customerHead=of('assistantSettings.customers.text');
 ok(customerHead?.includes(`<p>${t('assistantSettings.customers.text').replace(/'/g,'&#x27;')}</p>`)&&!/sdx-section-head-meta/.test(customerHead),'the customer keys intro is the description paragraph, not meta');
 ok(/sdx-card-actions[\s\S]*sdx-assistant-count/.test(customerHead),'the customer count stays in the head actions');
}
check([...html.matchAll(/<th scope="col"[^>]*>([^<]*)/g)].map(match=>match[1]).slice(0,3),['Customer','Key','Updated'],'the columns');
ok(text(html).includes('Claude (Anthropic) · claude-opus-5-5 · ends in CCCC'),'provider, model and hint');
check(buttons(html).filter(button=>/Set key|Change key/.test(buttonText(button))).map(button=>buttonText(button)),['Change key','Set key','Set key'],'Change key or Set key per row');
ok(/Beta AG<span class="sdx-tag">Deactivated<\/span>/.test(html),'a disabled customer is marked');
ok(!html.includes('sdx-searchfield'),'no search below 10 customers');
const many=Array.from({length:customerSearchFrom},(_,index)=>customer(`Customer ${index}`,false,false,index+10));
const card=query=>render(h(CustomerKeysCard,{customers:many,demo:false,now,onSaved:noop,onStale:noop,initialQuery:query}));
ok(card('').includes('sdx-searchfield'),'the search from 10 customers on');
html=card('nothing');
ok(text(html).includes('No customer matches “nothing”')&&buttons(html).some(button=>buttonText(button)==='Clear search'),'no match: the empty state with Clear search');
check((card('Customer 3').match(/<tbody>[\s\S]*<\/tbody>/)[0].match(/<tr/g)??[]).length,1,'the search filters by name');
const panelSource=readFileSync('ui/settings/assistant-settings-panel.tsx','utf8');
ok(/blocked=\{!editor\.dirty\?t\('common\.noChanges'\)/.test(panelSource.match(/export function CustomerKeyDrawer[\s\S]*?\n}\n/)[0])&&/\{view&&<KeyDangerZone /.test(panelSource.match(/export function CustomerKeyDrawer[\s\S]*?\n}\n/)[0]),'the drawer: Save key blocked until dirty, the danger zone (kit DangerZone) only with a stored key');

// ---- The form rules ----
check(keyFormOf(null),{provider:'anthropic',key:'',model:'claude-opus-5-5'},'a new key starts with Claude and its default');
check(keyFormErrors({provider:'anthropic',key:'',model:'m'},null),{key:'assistantSettings.keyRequired'},'a new key needs the field');
check(keyFormErrors({provider:'openai',key:'',model:'gpt-5'},key),{key:'assistantSettings.newKeyForProvider'},'a provider change needs a new key');
check(keyFormErrors({provider:'anthropic',key:'',model:'claude-sonnet-5-5'},key),{},'a model-only change keeps the key');
check(keyFormErrors({provider:'anthropic',key:'sk-proj-000000000000000000000',model:'bad model'},key),{model:'assistantSettings.modelInvalid',key:'assistantSettings.keyInvalid.anthropic'},'wrong prefix and model');
check([keyFormDirty(keyFormOf(key),key),keyFormDirty({...keyFormOf(key),model:'x'},key),keyFormDirty({...keyFormOf(key),key:'sk-ant-…'},key)],[false,true,true],'dirty after a change');

// ---- The account page ----
html=render(h(PersonalAssistantKey,{viewer:member,demo:false,initialView:{personal:null}}));
ok(text(html).includes('AI assistant')&&text(html).includes('This key is only for your own questions.'),'the personal card');
// The intro is the card description (body text below the title), not the muted meta line.
{
 const head=html.match(/<header class="sdx-section-head sdx-card-head">([\s\S]*?)<\/header>/)[1];
 const intro=t('assistantSettings.personal.text').replace(/'/g,'&#x27;');
 ok(head.includes(`<p>${intro}</p>`),'the personal intro is the description paragraph of the card head');
 ok(!/sdx-section-head-meta/.test(head),'the personal card head has no meta line');
 ok(/sdx-card-actions"><span class="sdx-pill/.test(head),'the status pill stays in the head actions');
}
ok(!/subscription|abo\b|sign in with/i.test(text(html)),'API keys only, no subscription option');
ok(/\{view==='account'&&<AccountPanel\s[^]*?assistantKey=\{<PersonalAssistantKey key=\{user\.id\} viewer=\{user\}\/>\}\/>\}/.test(consoleSource),'the card sits on the account page');

// ---- Palette, help, no new shortcut, no license gate ----
ok(consoleSource.includes("label:t('assistant.palette.ask',{name:active.name})")&&consoleSource.includes("run:()=>setAssistantDevice(active.id)"),'the palette opens the drawer on the open device');
check(assistantPage.palette.keywordsKey,'assistantSettings.paletteKeywords','the settings page has its palette keywords');
for(const word of ['ai','ki','claude','anthropic','openai','chatgpt','api key','assistant','customer key','kundenschlüssel','kunde'])ok(t('assistantSettings.paletteKeywords').includes(word),`keyword ${word}`);
const topic=topicFor({view:'settings',page:'assistant'},'en');
check([topic.title,topic.tips.length,topic.docs.map(doc=>doc.file)],['Assistant',3,['docs/ai-assistant.md']],'the help topic of the settings page with three tips');
ok(topic.tips[1].startsWith('The line below the question field shows which API key answers your question.')&&!/comes first|then your/.test(topic.tips[1]),'tip 2 says where to see the key that answers, not a key order');
check(topicFor({view:'device',deviceId:'d1',deviceSection:'overview',assistant:true},'en').title,t('help.deviceOverview.title'),'the drawer has no route: the device keeps the topic of its area');
ok(!readFileSync('ui/shell/console-shortcuts.ts','utf8').includes('assistant'),'no new shortcut');
for(const file of ['ui/devices/assistant/device-assistant.tsx','ui/settings/assistant-settings-panel.tsx','ui/account/personal-assistant-key.tsx','app/api/assistant/route.ts','app/api/assistant/settings/route.ts','lib/server/devices/assistant.ts','lib/server/devices/assistant-tools.ts','lib/server/devices/assistant-provider.ts'])
 ok(!/requireWrite|license/i.test(readFileSync(file,'utf8').replace(/\/\/.*$/gm,'')),`${file} has no license gate`);
process.stdout.write(`PASS assistant view (${checks} assertions): the Ask assistant control and its drawer, not set up, suggestions, Ask reasons, pending, answers with sources, failure, source line, settings page with customer keys, personal card, palette, help.\n`);
