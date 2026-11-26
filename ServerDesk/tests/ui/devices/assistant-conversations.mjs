// The kept conversations of the device assistant (ui/devices/assistant/assistant-conversations.ts):
// the stored shape in sessionStorage and its round trip, the checks of a
// stored value (broken JSON, version, shape, single bad messages and cards),
// a storage that throws, the binding to the viewer, the limit of 20, quota
// failures, the message ids after a restore, the normalization of a left
// conversation, the list of earlier conversations and the transitions of New
// conversation and of opening a conversation. A fake Storage, no browser.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const conversations=await import('../../../ui/devices/assistant/assistant-conversations.ts');
const {runHandlersFor,conversationsKey,conversationLimit,emptyStore,parseStore,loadStore,saveStore,limitStore,keepConversation,showConversation,startNewConversation,openStoredConversation,activeConversation,normalizeConversation,nextMessageNumber,highestMessageNumber,earlierConversations,conversationTitle,readSessionStore,writeSessionStore,changeSessionStore,clearAssistantConversations}=conversations;
const {commandBusy}=await import('../../../ui/devices/assistant/device-assistant.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

/** A Storage with an optional size limit (quota) and switches that make it throw. */
class FakeStorage{
 constructor({limit=Infinity}={}){this.items=new Map();this.limit=limit;this.throwGet=false;this.throwSet=false;this.writes=0;}
 getItem(key){if(this.throwGet)throw new Error('SecurityError');return this.items.has(key)?this.items.get(key):null;}
 setItem(key,value){this.writes++;if(this.throwSet)throw new Error('SecurityError');if(String(value).length>this.limit){const error=new Error('QuotaExceededError');error.name='QuotaExceededError';throw error;}this.items.set(key,String(value));}
 removeItem(key){this.items.delete(key);}
}
const interrupted=translate('en','assistant.interrupted');
const proposal={id:'p1',type:'action',kind:'restart-service',params:{name:'Spooler'},target:'Spooler',reason:'The spooler hangs.',readOnly:false,disruptive:false,mfa:false};
const script={id:'p2',type:'powershell',kind:'assistant-powershell',params:{},script:'Get-Service',timeoutSeconds:120,target:'Get-Service',reason:'Reads the services.',readOnly:false,disruptive:false,mfa:false};
const message=(id,extra={})=>({id,question:`Question ${id}`,status:'done',answer:`Answer ${id}`,sources:['device_services'],proposals:[],askedAt:1000,answeredAt:1100,...extra});
const conversation=(id,serverId,updatedAt,extra={})=>({id,serverId,serverName:`Device ${serverId}`,startedAt:updatedAt-10,updatedAt,messages:[message('q1')],runs:{},...extra});

// ---- The stored shape and its round trip ----
check(conversationsKey,'serverdesk.assistant.conversations','the key');
let storage=new FakeStorage();
const store={version:1,userId:'u1',conversations:[conversation('c1','s1',2000,{messages:[message('q1',{proposals:[proposal,script]}),message('q2',{followUp:{jobId:'j1'},question:'The job ended.'})],runs:{p1:{status:'finished',jobId:'j1',result:'Done.',changedAt:1500},p2:{status:'dismissed',changedAt:1600}}})],active:{s1:'c1'}};
ok(saveStore(storage,store),'the store is written');
const raw=JSON.parse(storage.getItem(conversationsKey));
check(Object.keys(raw).sort(),['active','conversations','userId','version'],'version, userId, conversations and active');
check(Object.keys(raw.conversations[0]).sort(),['id','messages','runs','serverId','serverName','startedAt','updatedAt'],'a conversation keeps id, device, times, messages and cards');
check(loadStore(storage,'u1',interrupted),store,'the round trip gives the same store');
const source=readFileSync(new URL('../../../ui/devices/assistant/assistant-conversations.ts',import.meta.url),'utf8');
ok(!/\bfetch\(|\bapi\(|\/api\//.test(source.replace(/\/\/.*$/gm,'')),'the module sends nothing to the server');

// ---- Empty conversations are never stored ----
const empty=conversation('c9','s9',3000,{messages:[]});
check(keepConversation(emptyStore('u1'),empty),emptyStore('u1'),'keep skips an empty conversation');
check(showConversation(emptyStore('u1'),empty),emptyStore('u1'),'show skips an empty conversation and sets no active entry');
check(parseStore(JSON.stringify({version:1,userId:'u1',conversations:[empty],active:{s9:'c9'}}),'u1',interrupted),emptyStore('u1'),'a stored empty conversation is dropped with its active entry');
check(earlierConversations([empty],{serverId:'s1',servers:[{id:'s9',name:'n'}],available:()=>true}),[],'an empty conversation is never listed');

// ---- Checks of the stored value ----
check(parseStore('{broken',"u1",interrupted),emptyStore('u1'),'broken JSON');
check(parseStore(JSON.stringify({...raw,version:2}),'u1',interrupted),emptyStore('u1'),'another version');
check(parseStore(JSON.stringify({...raw,conversations:{}}),'u1',interrupted),emptyStore('u1'),'conversations is not a list');
check(parseStore(JSON.stringify({...raw,active:[]}),'u1',interrupted),emptyStore('u1'),'active is not a map');
check(parseStore(JSON.stringify([1,2]),'u1',interrupted),emptyStore('u1'),'not an object');
check(parseStore(null,'u1',interrupted),emptyStore('u1'),'nothing stored');
const mixed={...raw.conversations[0],messages:[
 message('q1'),
 {id:'q2',question:42,status:'done',askedAt:1},
 message('q3',{status:'thinking'}),
 message('q4',{sources:['rm -rf']}),
 message('q5',{proposals:[{...proposal,params:null}]}),
 message('q6',{proposals:[{...proposal,kind:'format-disk'}]}),
 message('q7',{proposals:[{...script,script:''}]}),
 message('q8',{followUp:{jobId:7}}),
 message('q1'),
 message('q9',{proposals:[script]}),
],runs:{p1:{status:'finished'},p2:{status:'exploded'},p3:{status:'open',sending:'yes'},p4:{status:'failed',result:null}}};
const cleaned=parseStore(JSON.stringify({version:1,userId:'u1',conversations:[mixed,{id:'c2'},'x'],active:{s1:'c1',s2:'c2',s3:5}}),'u1',interrupted);
check(cleaned.conversations.length,1,'a conversation with a wrong frame is dropped');
check(cleaned.conversations[0].messages.map(entry=>entry.id),['q1','q9'],'messages with a wrong shape or a repeated id are dropped');
check(Object.keys(cleaned.conversations[0].runs),['p1','p4'],'cards with a wrong shape are dropped');
check(cleaned.active,{s1:'c1'},'active entries point only to kept conversations of their device');
check(parseStore(JSON.stringify({version:1,userId:'u1',conversations:[{...raw.conversations[0]}],active:{s2:'c1'}}),'u1',interrupted).active,{},'an active entry of another device is dropped');
storage=new FakeStorage();storage.throwGet=true;storage.throwSet=true;
check(loadStore(storage,'u1',interrupted),emptyStore('u1'),'a storage that throws on getItem gives an empty store');
check(saveStore(storage,store),null,'a storage that throws on setItem: no write, no exception');
check(loadStore(null,'u1',interrupted),emptyStore('u1'),'no storage gives an empty store');
check(saveStore(null,store),null,'no storage: no write');
assert.doesNotThrow(()=>clearAssistantConversations({removeItem(){throw new Error('blocked');}}),'removing from a blocked storage does not throw');checks++;
// Without a storage the conversations live in memory only, for this page load.
clearAssistantConversations(null);
writeSessionStore(store,null);
check(readSessionStore('u1',interrupted,null),store,'without a storage the store stays in memory');
check(readSessionStore('u2',interrupted,null),emptyStore('u2'),'the memory store of another viewer is not shown');
clearAssistantConversations(null);

// ---- Bound to the viewer ----
storage=new FakeStorage();
saveStore(storage,store);
check(loadStore(storage,'u2',interrupted),emptyStore('u2'),'another viewer restores nothing');
clearAssistantConversations(storage);
check(readSessionStore('u2',interrupted,storage),emptyStore('u2'),'the session store of another viewer is empty');
changeSessionStore('u2',interrupted,next=>showConversation(next,conversation('c5','s5',5000)),storage);
check(JSON.parse(storage.getItem(conversationsKey)).userId,'u2','the next write replaces the stored value');
check(JSON.parse(storage.getItem(conversationsKey)).conversations.map(entry=>entry.id),['c5'],'without the other viewer\'s conversations');
clearAssistantConversations(storage);
check(storage.getItem(conversationsKey),null,'sign-out removes the key');

// ---- Sign-out ----
const gate=readFileSync(new URL('../../../ui/session/session-gate.tsx',import.meta.url),'utf8');
const signOut=gate.slice(gate.indexOf('export async function signOutPortal'),gate.indexOf('export default function SessionGate'));
ok(signOut.includes('clearAssistantConversations()')&&signOut.indexOf('clearAssistantConversations()')<signOut.indexOf("window.location.assign('/')"),'signOutPortal removes the key before it redirects');
ok(/try\{await api\('\/api\/auth',\{action:'logout'\}\);\}\s*finally\{clearAssistantConversations\(\);\}/.test(signOut),'also when the logout request fails');

// ---- The limit of 20 and the quota ----
check(conversationLimit,20,'20 conversations at most');
const many=Array.from({length:20},(_,index)=>conversation(`c${index}`,`s${index%3}`,1000+index));
let full={version:1,userId:'u1',conversations:many,active:{s0:'c0'}};
full=keepConversation(full,conversation('c20','s1',5000));
check(full.conversations.length,20,'a 21st conversation drops one');
ok(!full.conversations.some(entry=>entry.id==='c1')&&full.conversations.some(entry=>entry.id==='c0'),'the oldest earlier conversation goes, the older active one stays');
check(limitStore({...full,active:Object.fromEntries(full.conversations.map(entry=>[entry.id,entry.id]))},3).conversations.length,20,'active conversations are never dropped, even over the limit');
const one=JSON.stringify({version:1,userId:'u1',conversations:[conversation('c0','s0',1000)],active:{s0:'c0'}}).length;
storage=new FakeStorage({limit:one*3});
const quota={version:1,userId:'u1',conversations:[conversation('c1','s1',1001),conversation('c0','s0',1000),conversation('c2','s1',1002),conversation('c3','s3',1003),conversation('c4','s4',1004)],active:{s0:'c0'}};
const written=saveStore(storage,quota);
check(written.conversations.map(entry=>entry.id),['c0','c3','c4'],'quota: the oldest earlier conversations go one by one until the write fits');
check(JSON.parse(storage.getItem(conversationsKey)),written,'the store that fitted is written');
storage=new FakeStorage({limit:10});
check(saveStore(storage,{version:1,userId:'u1',conversations:[conversation('c0','s0',1000)],active:{s0:'c0'}}),null,'no earlier conversation left: the write is skipped');
check(storage.getItem(conversationsKey),null,'nothing was written');
// The session store keeps the dropped state in memory.
clearAssistantConversations(null);
storage=new FakeStorage({limit:one*3});
check(writeSessionStore(quota,storage).conversations.length,3,'the session store follows the store that was written');
check(readSessionStore('u1',interrupted,storage).conversations.length,3,'and reads it back from memory');
clearAssistantConversations(storage);

// ---- The outcome of Run on device stays in its conversation ----
{
 let current=true;const calls=[];
 const handlers=runHandlersFor(()=>current,{sending:(id,value)=>calls.push(['sending',id,value]),refused:(id,error)=>calls.push(['refused',id,error]),started:(proposal,id)=>calls.push(['started',proposal.id,id])});
 handlers.sending('p1',true);handlers.refused('p1','No.');handlers.started(proposal,'j1');
 check(calls,[['sending','p1',true],['refused','p1','No.'],['started','p1','j1']],'in the conversation of the run, every outcome applies');
 current=false;calls.length=0;
 handlers.sending('p1',false);handlers.refused('p1','No.');handlers.started(proposal,'j2');
 check(calls,[],'after the conversation was left, no outcome applies');
}

// ---- Message ids after a restore ----
const restored=[message('q1'),message('q7'),message('q3'),message('x9')];
check(highestMessageNumber(restored),7,'the highest restored number');
check(nextMessageNumber(0,restored),8,'a new question after a reload continues after the highest restored id');
check(nextMessageNumber(12,restored),13,'the counter of this page load counts when it is higher');
ok(!restored.some(entry=>entry.id===`q${nextMessageNumber(2,restored)}`),'a new id is never one of the restored ids');

// ---- Normalization of a left conversation ----
const open={messages:[message('q1'),message('q2',{status:'pending',answeredAt:undefined}),message('q3',{status:'pending',followUp:{jobId:'j2'},answeredAt:undefined})],runs:{a:{status:'open',sending:true},b:{status:'queued',jobId:'j1'},c:{status:'running',jobId:'j2'},d:{status:'stale'},e:{status:'finished',result:'ok'},f:{status:'dismissed'},g:{status:'open',error:'Refused.'}}};
const normalized=normalizeConversation(open,interrupted);
check(normalized.messages.map(entry=>[entry.id,entry.status,entry.error??null]),[['q1','done',null],['q2','failed',interrupted],['q3','failed',interrupted]],'pending becomes failed with the interrupted text');
check(normalized.messages[2].followUp,{jobId:'j2'},'an interrupted follow-up keeps its job, so Ask again sends the same follow-up');
check(normalized.messages[1].answeredAt,undefined,'no answer time, so the failed row does not rise in');
check(Object.fromEntries(Object.entries(normalized.runs).map(([id,run])=>[id,run.status])),{a:'open',b:'untracked',c:'untracked',d:'stale',e:'finished',f:'dismissed',g:'open'},'queued and running become untracked, the other states stay');
check(normalized.runs.a.sending,undefined,'sending ends');
check(normalized.runs.g.error,'Refused.','a refused run keeps its error');
check(interrupted,'This question got no answer before the conversation was closed. Select Ask again to get an answer.','the interrupted text in English');
check(translate('de','assistant.interrupted'),'Diese Frage hat keine Antwort bekommen, bevor das Gespräch geschlossen wurde. Wähle „Erneut fragen“, um eine Antwort zu bekommen.','and in German');
check(commandBusy(normalized.runs),false,'commandBusy does not count an untracked run');
check(commandBusy({x:{status:'running'}}),true,'a running run still counts');
const reloaded=parseStore(JSON.stringify({version:1,userId:'u1',conversations:[{...conversation('c1','s1',2000),...open}],active:{s1:'c1'}}),'u1',interrupted);
check(reloaded.conversations[0].messages.filter(entry=>entry.status==='pending').length,0,'a conversation read after a reload shows no pending row');
check(Object.values(reloaded.conversations[0].runs).filter(run=>run.status==='queued'||run.status==='running'||run.sending).length,0,'and no card that polls');

// ---- The list of earlier conversations ----
const servers=[{id:'s1',name:'SRV-01',revoked:0,permissions:['view']},{id:'s2',name:'SRV-02 renamed',revoked:0,permissions:['view']},{id:'s3',name:'SRV-03',revoked:1,permissions:['view']},{id:'s4',name:'SRV-04',revoked:0,permissions:[]}];
const listed=[
 conversation('shown','s1',9000),
 conversation('old','s1',1000,{messages:[message('q1',{followUp:{jobId:'j'},question:'The job ended.'}),message('q2',{question:'Why is the disk full?'}),message('q3',{question:'And the logs?'})]}),
 conversation('other','s2',5000,{serverName:'SRV-02'}),
 conversation('revoked','s3',6000),
 conversation('noview','s4',7000),
 conversation('gone','s9',8000),
];
const rows=earlierConversations(listed,{shownId:'shown',serverId:'s1',servers,available:device=>device.revoked===0&&device.permissions.includes('view')});
check(rows.map(row=>row.id),['other','old'],'all devices, newest first, without the shown conversation and without devices that are gone, revoked or have no view');
check(rows[0],{id:'other',serverId:'s2',device:'SRV-02 renamed',title:'Question q1',questions:1,updatedAt:5000,thisDevice:false},'the current device name from servers');
check([rows[1].title,rows[1].questions,rows[1].thisDevice],['Why is the disk full?',2,true],'the first question that is not a follow-up, the count without follow-ups, the tag of this device');
check(conversationTitle({messages:[message('q1',{followUp:{jobId:'j'},question:'Result'})]}),'Result','a conversation of follow-ups only takes the first one');
check(earlierConversations(listed,{serverId:'s1',servers:[{id:'s2',name:''}],available:()=>true})[0].device,'SRV-02','the stored name when the current one is empty');

// ---- New conversation and opening a conversation ----
const session={version:1,userId:'u1',conversations:[conversation('a','s1',1000),conversation('b','s1',2000),conversation('x','s2',3000)],active:{s1:'b',s2:'x'}};
let next=startNewConversation(session,'s1');
check(next.active,{s2:'x'},'New conversation: the device points to no conversation until the first question');
check(next.conversations.map(entry=>entry.id),['a','b','x'],'the old conversation stays as an earlier one');
next=showConversation(next,conversation('c','s1',4000));
check(next.active,{s2:'x',s1:'c'},'the first question makes the new conversation active');
next=openStoredConversation(next,'a');
check(next.active,{s2:'x',s1:'a'},'opening a conversation of this device shows it here');
check(activeConversation(next,'s1').id,'a','the device shows it');
next=openStoredConversation(next,'x');
check(next.active,{s2:'x',s1:'a'},'opening a conversation of another device sets that device and keeps the old device\'s conversation');
next=openStoredConversation(session,'b');
check(next.active,session.active,'opening the shown conversation changes nothing');
check(openStoredConversation(session,'missing'),session,'an unknown conversation changes nothing');
next=keepConversation(session,normalizeConversation({...conversation('b','s1',2000),messages:[message('q1',{status:'pending'})]},interrupted));
check([next.active,next.conversations.find(entry=>entry.id==='b').messages[0].status],[session.active,'failed'],'keeping a left conversation keeps active and stores its normalized copy');

console.log(`${checks} assistant conversation checks passed.`);
