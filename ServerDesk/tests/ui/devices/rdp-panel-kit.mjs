// Remote access → Remote Desktop on the kit (ui/devices/remote/rdp-panel.tsx): the head with "Prüfen" and
// "Remote Desktop einschalten", the start card with the primary "Remote Desktop öffnen" blocked with the
// shown reason, the admin disconnect through ConfirmDialog with the unchanged close payload, and the
// error Notice whose retry repeats the discovery. The panel runs on hook cells
// (tests/support/panel-harness.mjs), in German; the iframe and the bridge stay as they are.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {panelHarness} from '../../support/panel-harness.mjs';

const now=Date.now();
let reads=0,posts=[],failRead=null,metadata=null,checks=0;
const harness=panelHarness({hooked:['ui/devices/remote/rdp-panel.tsx'],stubs:{'@/ui/base/api':api=>({...api.load('ui/base/api.tsx'),
 api:async(url,body)=>{if(body){posts.push(body);return {ok:true};}reads++;if(failRead)throw new Error(failRead);return metadata;},
 credentialFetch:async()=>new Response('{}')})}});
globalThis.window??={addEventListener(){},removeEventListener(){},location:{origin:'https://portal.test'}};
const {EnabledRdpPanel,default:RdpPanel}=harness.load('ui/devices/remote/rdp-panel.tsx');
const viewer={id:'owner',label:'owner@test.example',permissions:['*']};
const server={id:'srv-1',name:'WIN-RDP',management:1,lastSeen:now,revoked:0,permissions:['view','rdp','manage'],snapshot:{protocolVersion:3,mode:'Management',agentCapabilities:['rdp-browser','set-rdp']}};
let confirmations=[];
const base={server,viewer,demo:false,saving:false,onConfirm:value=>confirmations.push(value)};
const availability=(changes={})=>({available:true,featureStatus:'available',online:true,capable:true,management:true,enabled:false,nla:true,port:3389,policyBlocked:false,reason:{key:'serverMessage.rdp.disabledOnWindows'},...changes});
async function open(props={},meta={availability:availability(),activeSessions:[]}){
 harness.reset();reads=0;posts=[];failRead=null;metadata=meta;confirmations=[];
 harness.tree(EnabledRdpPanel,{...base,...props});await harness.flush();return harness.tree(EnabledRdpPanel,{...base,...props});
}
const byLabel=(tree,label)=>harness.find(tree,item=>item.props.onClick&&harness.text(item).trim()===label);

// Source: kit parts only, no German literal, no inline confirmation.
const source=fs.readFileSync('ui/devices/remote/rdp-panel.tsx','utf8');
assert.doesNotMatch(source,/@\/components\/ui\/|<Button\b|data-slot="button"/,'no shadcn Button');
assert.doesNotMatch(source,/RDP aktivieren|RDP deaktivieren/,'no hard-coded German label');
assert.doesNotMatch(source,/sd-rdp-close-confirm|inline-note|className="panel/,'no inline confirmation, no inline-note, no panel class');
assert.doesNotMatch(fs.readFileSync('ui/devices/remote/rdp.css','utf8'),/sd-rdp-close-confirm|\.sd-rdp-panel \.inline-note/,'their CSS is gone');checks+=4;

// The head: "Prüfen" and "Remote Desktop einschalten" with the device line and the unchanged payload.
let tree=await open();
assert.equal(reads,1,'the discovery runs once');
const check=byLabel(tree,'Prüfen');assert.equal(check.props.variant,'ghost');assert.equal(check.props.blocked,undefined);assert.equal(check.props.loading,false);
const toggle=byLabel(tree,'Remote Desktop einschalten');assert.ok(toggle,'the head button names the action');assert.equal(toggle.props.blocked,undefined);
toggle.props.onClick();
assert.equal(confirmations.length,1);
const [confirmation]=confirmations;
assert.equal(confirmation.title,'Remote Desktop einschalten?');assert.equal(confirmation.confirmLabel,'Remote Desktop einschalten','the confirm verb is the button name');
assert.deepEqual(confirmation.lines,[{label:'Gerät',value:'WIN-RDP'}],'the device is a Facts line');
assert.doesNotMatch(confirmation.description,/WIN-RDP|Gerät:/,'the description no longer repeats the device');
assert.deepEqual(confirmation.payload,{action:'job',id:'srv-1',kind:'set-rdp',params:{enabled:true,confirm:true},confirm:true},'the payload is unchanged');checks+=11;
tree=await open({},{availability:availability({enabled:true,reason:null}),activeSessions:[]});
byLabel(tree,'Remote Desktop ausschalten').props.onClick();
assert.equal(confirmations[0].confirmLabel,'Remote Desktop ausschalten');assert.deepEqual(confirmations[0].payload.params,{enabled:false,confirm:true});checks+=2;
tree=await open({},{availability:availability({policyBlocked:true,reason:{key:'serverMessage.rdp.policyBlocked'}}),activeSessions:[]});
assert.match(byLabel(tree,'Remote Desktop einschalten').props.blocked,/Richtlinie/,'a Windows policy blocks the switch with its reason');checks++;
tree=await open({saving:true});assert.equal(byLabel(tree,'Remote Desktop einschalten').props.loading,true,'loading while the job is saved');checks++;

// The start card: the primary "Remote Desktop öffnen", blocked with the reason that the notice shows.
tree=await open();
const start=byLabel(tree,'Remote Desktop öffnen');
assert.equal(start.props.variant,'primary','the start card carries the primary');
assert.equal(start.props.blocked,'Remote Desktop ist auf Windows ausgeschaltet.','blocked with the shown reason');
const notice=harness.find(tree,item=>item.props.tone==='info'&&item.props.icon);assert.equal(harness.text(notice).trim(),'Remote Desktop ist auf Windows ausgeschaltet.','the same reason as a kit info Notice');
tree=await open({},{availability:availability({enabled:true,reason:null}),activeSessions:[]});
assert.equal(byLabel(tree,'Remote Desktop öffnen').props.blocked,undefined,'available: the primary opens the view');checks+=4;

// Demo: "Prüfen" blocked with the demo reason, the kit Unavailable with the panel sentence, nothing loaded.
tree=await open({demo:true});
assert.equal(reads,0,'no discovery for a sample device');
assert.equal(byLabel(tree,'Prüfen').props.blocked,'Bei Beispielgeräten nicht möglich.');
const unavailable=harness.find(tree,item=>item.props.reason==='demo');assert.ok(unavailable,'the kit Unavailable names the demo');assert.equal(harness.text(unavailable).trim(),'Remote Desktop ist in der Demo ausgeschaltet.');
assert.equal(byLabel(tree,'Remote Desktop öffnen').props.blocked,'Remote Desktop ist in der Demo ausgeschaltet.','the primary names the same reason');checks+=5;

// Another person's connection: "Trennen" opens the danger ConfirmDialog; confirming sends the unchanged close payload.
const sessions=[{id:'own-1',state:'open',isOwn:true,canClose:true},{id:'other-1',state:'open',owner:'Anna',isOwn:false,canClose:true}];
tree=await open({},{availability:availability({enabled:true,reason:null}),activeSessions:sessions});
let dialog=harness.find(tree,item=>item.props.confirmLabel!==undefined&&item.props.onConfirm);
assert.equal(dialog.props.open,false,'no dialog before the click');
const disconnects=harness.walk(tree).filter(item=>item.props.onClick&&harness.text(item).trim()==='Trennen');assert.equal(disconnects.length,2);
disconnects[1].props.onClick();tree=harness.tree(EnabledRdpPanel,base);
dialog=harness.find(tree,item=>item.props.confirmLabel!==undefined&&item.props.onConfirm);
assert.deepEqual([dialog.props.open,dialog.props.title,dialog.props.confirmLabel,dialog.props.tone],[true,'Verbindung von Anna trennen? Die Windows-Sitzung bleibt angemeldet.','Als Admin trennen','danger'],'the danger ConfirmDialog with the action name as verb');
assert.equal(posts.length,0,'nothing is sent before the confirmation');
dialog.props.onConfirm();await harness.settle();
assert.deepEqual(posts,[{action:'close',id:'other-1',confirm:true}],'the close payload is unchanged');checks+=6;
// The own connection disconnects at once, without a dialog.
tree=await open({},{availability:availability({enabled:true,reason:null}),activeSessions:sessions});
harness.walk(tree).filter(item=>item.props.onClick&&harness.text(item).trim()==='Trennen')[0].props.onClick();await harness.settle();
assert.deepEqual(posts,[{action:'close',id:'own-1'}],'the own connection closes directly');checks++;

// A failed discovery: the danger Notice with "Erneut versuchen" repeats the discovery.
harness.reset();reads=0;failRead='Der Agent hat nicht geantwortet.';metadata=null;
harness.tree(EnabledRdpPanel,base);await harness.flush();tree=harness.tree(EnabledRdpPanel,base);
const failed=harness.find(tree,item=>item.props.onRetry&&item.props.text);
assert.equal(failed.props.text,'Der Agent hat nicht geantwortet.');
const html=harness.html(EnabledRdpPanel,base);assert.match(html,/sdx-notice-danger/);assert.match(html,/Erneut versuchen/,'the retry says "Erneut versuchen"');
failRead=null;metadata={availability:availability(),activeSessions:[]};failed.props.onRetry();await harness.settle();
assert.equal(reads,2,'the retry repeats the discovery');checks+=4;

// While Remote Desktop is paused the subarea stays the one Empty with the terminal.
assert.match(harness.html(RdpPanel,{...base,onOpenTerminal:()=>{}}),/Remote Desktop ist pausiert/);checks++;
console.log(`PASS rdp panel kit (${checks} checks): Prüfen and Remote Desktop aktivieren in the head, the confirmation with its verb and device line, the primary blocked with the shown reason, the admin disconnect through ConfirmDialog with the unchanged payload, and the retry of a failed discovery.`);
