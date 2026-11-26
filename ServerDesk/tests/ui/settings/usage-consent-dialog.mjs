// The question "Data for product improvement" at the first setup (UsageConsentDialog in ui/settings/usage-data.tsx) on the
// kit Dialog: who is asked, the three values, no switch and nothing preselected, two equal buttons ("Don't send" first,
// where the focus starts), their request bodies, the loading and blocked pair, closing without saving, a failure that
// keeps it open and a 409 that loads the view again. While usage data is off (view.enabled false) it never opens, also
// for an undecided installation. Runs on the hook cells of tests/support/panel-harness.mjs with the real kit. No server
// or browser is touched.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
const owner={id:'owner',label:'owner@example.test',permissions:['*']};
const view=(extra={})=>({enabled:true,consent:null,decidedAt:null,revision:0,server:'none',lastAttemptAt:null,lastSuccessAt:null,lastError:null,payload:{schema:2,instanceId:'0123456789abcdef0123456789abcdef',version:'0.1.0',deviceCount:3},...extra});
let calls=[],get=async()=>view(),post=async body=>view({consent:body.enabled,revision:1,decidedAt:1});
const shared={ApiError,message:failure=>failure.message,api:async(url,body)=>{calls.push({url,body});assert.equal(url,'/api/usage-data');return body?post(body):get();}};
const harness=panelHarness({hooked:['ui/settings/usage-data.tsx'],stubs:{'@/ui/base/api':shared}});
const usage=harness.load('ui/settings/usage-data.tsx'),Dialog=usage.default,{shouldAskUsageConsent}=usage;
const confirm=harness.load('ui/kit/confirm-dialog.tsx'),kit=harness.load('ui/kit/kit.tsx');

let tree=null;
const render=(viewer=owner)=>{tree=harness.tree(Dialog,{viewer});return tree;};
const settle=async()=>{for(let round=0;round<4;round++){await harness.flush();render();}};
async function start({getter=async()=>view(),poster=async body=>view({consent:body.enabled,revision:1,decidedAt:1})}={}){harness.reset();calls=[];get=getter;post=poster;render();await settle();}
const dialog=()=>tree.props;
const buttons=()=>harness.walk(dialog().footer).filter(node=>node.type===kit.Btn);
const toasts=()=>harness.toasts.splice(0);

// 1. Who is asked: only while usage data is on, Owners only, and only while nobody decided.
check([false,null,undefined,'true',1].map(enabled=>shouldAskUsageConsent(owner,view({enabled}))),[false,false,false,false,false],'off (or no boolean true): nobody is asked');
check([shouldAskUsageConsent(owner,view()),shouldAskUsageConsent(owner,view({consent:true})),shouldAskUsageConsent(owner,view({consent:false})),shouldAskUsageConsent(owner,null)],[true,false,false,false]);
check([shouldAskUsageConsent({...owner,permissions:['portal.roles.manage','portal.roleAssignments.manage']},view()),shouldAskUsageConsent({id:'plain',label:'plain'},view())],[false,false],'IAM administrators and plain viewers are not asked');

// 2. The kit Dialog with the three values and two equal answers.
{
 for(const consent of [null,true,false]){
  await start({getter:async()=>view({enabled:false,consent})});
  check([tree.type,dialog().open,calls],[confirm.Dialog,false,[{url:'/api/usage-data',body:undefined}]],`off, consent ${consent}: one GET, the question stays closed`);
 }
 await start({getter:async()=>view({consent:true})});
 check([tree.type,dialog().open,calls],[confirm.Dialog,false,[{url:'/api/usage-data',body:undefined}]],'a decided installation shows no question');
 await start();
 check([dialog().open,dialog().title,dialog().description],[true,de('usage.title'),de('usage.consentText')],'the title and what is sent');
 const values=harness.find(tree,node=>node.type===usage.UsageValues),facts=values.type(values.props);
 check(facts.props.items.map(item=>[item.label,item.value]),[[de('usage.instanceId'),'0123456789abcdef0123456789abcdef'],[de('usage.version'),'0.1.0'],[de('usage.devices'),3]],'the three values as Facts, no Edition row');
 ok(harness.walk(tree).some(node=>node.type==='p'&&harness.text(node)===de('usage.consentNo'))&&harness.walk(tree).some(node=>node.type==='p'&&harness.text(node)===de('usage.noServer')),'what is not sent, and the note without a usage data server');
 ok(!harness.walk(tree).some(node=>node.props?.role==='switch'||String(node.type?.name)==='Switch'),'no switch: nothing is preselected');
 check(buttons().map(button=>[harness.text(button),button.props.variant,button.props.size,button.props.loading,button.props.blocked]),[[de('usage.consent.dontSend'),undefined,undefined,false,undefined],[de('usage.switch'),undefined,undefined,false,undefined]],'two secondary buttons of the same size, "Don\'t send" first, no primary');
 ok(fs.readFileSync('ui/kit/confirm-dialog.tsx','utf8').includes('onOpenAutoFocus={event=>openFocus(event,returner,null)}')&&!/autoFocus/.test(fs.readFileSync('ui/settings/usage-data.tsx','utf8')),'the kit Dialog leaves the first focus to radix: the first button, "Don\'t send"');
 // Send usage data: loading on the clicked button, the other blocked; Esc does not close while it saves.
 let release;post=body=>new Promise(resolve=>{release=()=>resolve(view({consent:body.enabled,revision:1,decidedAt:1}));});
 buttons()[1].props.onClick();render();
 check(buttons().map(button=>[button.props.loading,button.props.blocked]),[[false,de('kit.busy')],[true,undefined]],'the clicked button shows loading, the other is blocked');
 dialog().onOpenChange(false);render();check(dialog().open,true,'no close while saving');
 release();await settle();
 check([calls.at(-1).body,dialog().open,toasts()],[{action:'set',enabled:true,revision:0},false,[de('usage.saved.on')]],'Send usage data saves enabled:true and closes');
 await start({getter:async()=>view({revision:2})});
 buttons()[0].props.onClick();await settle();
 check([calls.at(-1).body,dialog().open,toasts()],[{action:'set',enabled:false,revision:2},false,[de('usage.saved.off')]],'Don\'t send saves enabled:false and closes');
}

// 3. Closing without an answer saves nothing and asks again on the next console load.
{
 await start();
 dialog().onOpenChange(false);await settle();
 check([dialog().open,calls.length,toasts()],[false,1,[]],'nothing is sent');
 await start();check(dialog().open,true,'a new console load asks again');
 for(const [server,shown] of [['configured',false],['invalid',true],['none',true]]){
  await start({getter:async()=>view({server})});
  check(harness.walk(tree).some(node=>node.type==='p'&&harness.text(node)===de('usage.noServer')),shown,server);
 }
}

// 4. A failure keeps the question open; a 409 loads the view again, which closes it when someone decided elsewhere.
{
 await start({poster:async()=>{throw new ApiError('Diese Einstellung sieht und ändert nur ein Owner.',403);}});
 buttons()[0].props.onClick();await settle();
 check([dialog().open,toasts(),buttons().map(button=>button.props.loading),calls.length],[true,['error:Diese Einstellung sieht und ändert nur ein Owner.'],[false,false],2],'error: a toast, the dialog stays, no reload');
 let reads=0;
 await start({getter:async()=>view(reads++?{consent:false,revision:1,decidedAt:1}:{}),poster:async()=>{throw new ApiError('Die Einstellung wurde inzwischen geändert.',409);}});
 buttons()[1].props.onClick();await settle();
 check([calls.map(call=>call.body?.action??'GET'),dialog().open],[['GET','set','GET'],false],'a conflict reloads; decided elsewhere, the question closes');
 await start({getter:async()=>{throw new ApiError('Nicht erreichbar.',503);}});
 check(dialog().open,false,'a failed load asks nothing');
}

// 5. The console mounts it for Owners only, and it is kit only.
const consoleSource=fs.readFileSync('ui/shell/console.tsx','utf8');
ok(/\{canManageInstanceSettings\(user\)&&<UsageConsentDialog key=\{user\.id\} viewer=\{user\}\/>\}/.test(consoleSource)&&consoleSource.match(/<UsageConsentDialog\b/g).length===1,'the console mounts it once, for Owners');
const usageSource=fs.readFileSync('ui/settings/usage-data.tsx','utf8');
ok(!/@\/components\/ui\/|ErrorNote|role="switch"|common\.continue/.test(usageSource),'kit Dialog, no switch, no Continue');
check(usageSource.match(/'\/api\/usage-data'/g).length,1,'one route constant');

console.log(`${checks} usage consent dialog checks passed.`);
