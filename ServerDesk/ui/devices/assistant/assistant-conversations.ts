// The kept conversations of the device assistant (docs/ai-assistant.md): the
// conversations of this browser tab, for all devices, in sessionStorage. Pure
// functions for the shape, the checks, the normalization and the list, plus a
// thin adapter for the storage. Nothing here goes to the server: the server
// stays stateless, and a kept proposal runs through the same checked
// /api/assistant run path as any request.
import {assistantPowerShellKind,isAssistantCommandKind,isAssistantToolName,validAssistantScript,validAssistantTimeout,type AssistantProposal,type AssistantToolName} from '@/lib/assistant-config';

/** A question, or the follow-up after a command (followUp): its question is the result line in the UI language. */
export type AssistantMessage={id:string;question:string;status:'pending'|'done'|'failed';answer?:string;sources?:AssistantToolName[];proposals?:AssistantProposal[];followUp?:{jobId:string};error?:string;askedAt:number;answeredAt?:number};
/**
 * The state of one proposal card: open (with sending while the run request
 * is out and the error of a refused run), dismissed ("Don't run"), queued and
 * running (polling), finished or failed with the result text, stale after
 * 10 minutes without a final state, or untracked when the conversation was
 * closed while the job was queued or running.
 */
export type ProposalRun={status:'open'|'dismissed'|'queued'|'running'|'finished'|'failed'|'stale'|'untracked';sending?:boolean;error?:string;jobId?:string;result?:string|null;changedAt?:number};
/** One kept conversation of one device. */
export type StoredConversation={id:string;serverId:string;serverName:string;startedAt:number;updatedAt:number;messages:AssistantMessage[];runs:Record<string,ProposalRun>};
/** The stored value: the conversations of one viewer and the conversation each device shows (active). */
export type ConversationStore={version:1;userId:string;conversations:StoredConversation[];active:Record<string,string>};
/** The part of Storage this module uses (sessionStorage in the browser, a fake in the tests). */
export type ConversationStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;

export const conversationsKey='serverdesk.assistant.conversations';
/** At most this many conversations are kept; the oldest earlier one goes first. */
export const conversationLimit=20;

export const emptyStore=(userId:string):ConversationStore=>({version:1,userId,conversations:[],active:{}});

// ---- Checks ----

const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const text=(value:unknown):value is string=>typeof value==='string';
const time=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const optional=<T,>(value:unknown,check:(entry:unknown)=>entry is T)=>value===undefined||check(value);
const flag=(value:unknown):value is boolean=>typeof value==='boolean';
const runStatuses:readonly ProposalRun['status'][]=['open','dismissed','queued','running','finished','failed','stale','untracked'];
const messageStatuses:readonly AssistantMessage['status'][]=['pending','done','failed'];

/** A proposal as the panel renders and runs it; anything else is not a proposal. */
function validProposal(value:unknown):value is AssistantProposal{
 if(!record(value)||!text(value.id)||!text(value.reason)||!text(value.target)||!flag(value.readOnly)||!flag(value.disruptive)||!flag(value.mfa)||!record(value.params))return false;
 if(value.type==='action')return isAssistantCommandKind(value.kind);
 return value.type==='powershell'&&value.kind===assistantPowerShellKind&&validAssistantScript(value.script)&&validAssistantTimeout(value.timeoutSeconds);
}
/** One stored message, or null when its shape is wrong. */
export function parseMessage(value:unknown):AssistantMessage|null{
 if(!record(value)||!text(value.id)||!value.id||!text(value.question)||!messageStatuses.includes(value.status as AssistantMessage['status'])||!time(value.askedAt))return null;
 if(!optional(value.answer,text)||!optional(value.error,text)||!optional(value.answeredAt,time))return null;
 if(value.sources!==undefined&&!(Array.isArray(value.sources)&&value.sources.every(isAssistantToolName)))return null;
 if(value.proposals!==undefined&&!(Array.isArray(value.proposals)&&value.proposals.every(validProposal)))return null;
 if(value.followUp!==undefined&&!(record(value.followUp)&&text(value.followUp.jobId)))return null;
 const message:AssistantMessage={id:value.id,question:value.question,status:value.status as AssistantMessage['status'],askedAt:value.askedAt};
 if(value.answer!==undefined)message.answer=value.answer;
 if(value.sources!==undefined)message.sources=value.sources as AssistantToolName[];
 if(value.proposals!==undefined)message.proposals=value.proposals as AssistantProposal[];
 if(value.followUp!==undefined)message.followUp={jobId:(value.followUp as {jobId:string}).jobId};
 if(value.error!==undefined)message.error=value.error;
 if(value.answeredAt!==undefined)message.answeredAt=value.answeredAt;
 return message;
}
/** One stored card state, or null when its shape is wrong. */
export function parseRun(value:unknown):ProposalRun|null{
 if(!record(value)||!runStatuses.includes(value.status as ProposalRun['status']))return null;
 if(!optional(value.sending,flag)||!optional(value.error,text)||!optional(value.jobId,text)||!optional(value.changedAt,time))return null;
 if(value.result!==undefined&&value.result!==null&&!text(value.result))return null;
 const run:ProposalRun={status:value.status as ProposalRun['status']};
 if(value.sending!==undefined)run.sending=value.sending;
 if(value.error!==undefined)run.error=value.error;
 if(value.jobId!==undefined)run.jobId=value.jobId;
 if(value.result!==undefined)run.result=value.result as string|null;
 if(value.changedAt!==undefined)run.changedAt=value.changedAt;
 return run;
}
/** One stored conversation without its bad messages and cards, or null when its frame is wrong or no message is left. */
export function parseConversation(value:unknown):StoredConversation|null{
 if(!record(value)||!text(value.id)||!value.id||!text(value.serverId)||!value.serverId||!text(value.serverName)||!time(value.startedAt)||!time(value.updatedAt)||!Array.isArray(value.messages)||!record(value.runs))return null;
 const seen=new Set<string>(),messages:AssistantMessage[]=[];
 for(const entry of value.messages){const message=parseMessage(entry);if(message&&!seen.has(message.id)){seen.add(message.id);messages.push(message);}}
 if(!messages.length)return null;
 const runs:Record<string,ProposalRun>={};
 for(const [id,entry] of Object.entries(value.runs)){const run=parseRun(entry);if(run)runs[id]=run;}
 return {id:value.id,serverId:value.serverId,serverName:value.serverName,startedAt:value.startedAt,updatedAt:value.updatedAt,messages,runs};
}

// ---- Normalization ----

/**
 * A conversation that was left: no open work continues. A pending question
 * fails with the interrupted text (Ask again sends it once more), a card that
 * was sending is open again, and a card whose job was queued or running is
 * untracked. The same applies to a conversation read after a reload.
 */
export function normalizeConversation<T extends {messages:AssistantMessage[];runs:Record<string,ProposalRun>}>(conversation:T,interrupted:string):T{
 const messages=conversation.messages.map(entry=>entry.status==='pending'?{...entry,status:'failed' as const,error:interrupted}:entry);
 const runs:Record<string,ProposalRun>={};
 for(const [id,run] of Object.entries(conversation.runs)){
  const next:ProposalRun={...run};
  delete next.sending;
  if(next.status==='queued'||next.status==='running')next.status='untracked';
  runs[id]=next;
 }
 return {...conversation,messages,runs};
}

/**
 * The stored value read back: a broken JSON, another version, another viewer
 * or a wrong frame give an empty store; bad conversations, messages and cards
 * are dropped; every conversation is normalized; active entries point only
 * to kept conversations of their own device.
 */
export function parseStore(raw:string|null,userId:string,interrupted:string):ConversationStore{
 const empty=emptyStore(userId);
 if(!raw)return empty;
 let value:unknown;
 try{value=JSON.parse(raw);}catch{return empty;}
 if(!record(value)||value.version!==1||value.userId!==userId||!Array.isArray(value.conversations)||!record(value.active))return empty;
 const conversations:StoredConversation[]=[],ids=new Set<string>();
 for(const entry of value.conversations){const conversation=parseConversation(entry);if(conversation&&!ids.has(conversation.id)){ids.add(conversation.id);conversations.push(normalizeConversation(conversation,interrupted));}}
 const active:Record<string,string>={};
 for(const [serverId,id] of Object.entries(value.active))if(text(id)&&conversations.some(conversation=>conversation.id===id&&conversation.serverId===serverId))active[serverId]=id;
 return {version:1,userId,conversations,active};
}

// ---- Transitions ----

const activeIds=(store:ConversationStore)=>new Set(Object.values(store.active));
/** The oldest conversation that no device shows, or undefined. */
function oldestEarlier(store:ConversationStore):StoredConversation|undefined{
 const shown=activeIds(store);
 return store.conversations.filter(conversation=>!shown.has(conversation.id)).sort((a,b)=>a.updatedAt-b.updatedAt)[0];
}
const without=(store:ConversationStore,id:string):ConversationStore=>({...store,conversations:store.conversations.filter(conversation=>conversation.id!==id)});
/** At most 20 conversations: the earlier ones with the oldest updatedAt go first, an active one never. */
export function limitStore(store:ConversationStore,limit=conversationLimit):ConversationStore{
 let next=store;
 while(next.conversations.length>limit){const oldest=oldestEarlier(next);if(!oldest)break;next=without(next,oldest.id);}
 return next;
}
/** Keeps a conversation (new or changed) without changing which conversation a device shows. An empty conversation is never kept. */
export function keepConversation(store:ConversationStore,conversation:StoredConversation):ConversationStore{
 if(!conversation.messages.length)return store;
 const at=store.conversations.findIndex(entry=>entry.id===conversation.id);
 const conversations=at<0?[...store.conversations,conversation]:store.conversations.map((entry,index)=>index===at?conversation:entry);
 return limitStore({...store,conversations});
}
/** The conversation a device shows now: kept and active for its device. */
export function showConversation(store:ConversationStore,conversation:StoredConversation):ConversationStore{
 if(!conversation.messages.length)return store;
 return keepConversation({...store,active:{...store.active,[conversation.serverId]:conversation.id}},conversation);
}
/** New conversation: the device shows no conversation until its first question; the old one stays as an earlier one. */
export function startNewConversation(store:ConversationStore,serverId:string):ConversationStore{
 if(!(serverId in store.active))return store;
 const active={...store.active};
 delete active[serverId];
 return limitStore({...store,active});
}
/** Opens a kept conversation on its device: the device shows it from now on. Another device keeps its own active conversation. */
export function openStoredConversation(store:ConversationStore,conversationId:string):ConversationStore{
 const conversation=store.conversations.find(entry=>entry.id===conversationId);
 if(!conversation)return store;
 return limitStore({...store,active:{...store.active,[conversation.serverId]:conversation.id}});
}
/** The conversation a device shows, normalized, or undefined. */
export function activeConversation(store:ConversationStore,serverId:string):StoredConversation|undefined{
 const id=store.active[serverId];
 return id?store.conversations.find(conversation=>conversation.id===id&&conversation.serverId===serverId):undefined;
}

// ---- The outcome of Run on device ----

/** What a card does with the outcome of Run on device: sending on and off, a refusal, or the queued job that the panel follows. */
export type RunHandlers={sending:(proposalId:string,value:boolean)=>void;refused:(proposalId:string,error:string)=>void;started:(proposal:AssistantProposal,jobId:string)=>void};
/**
 * The handlers of one Run on device, bound to the conversation that was shown
 * when the run started: once that conversation is left (isCurrent is false),
 * the outcome changes nothing, so no card state, polling or follow-up lands in
 * another conversation. The queued job keeps running and shows under Jobs.
 */
export function runHandlersFor(isCurrent:()=>boolean,handlers:RunHandlers):RunHandlers{
 return {
  sending:(proposalId,value)=>{if(isCurrent())handlers.sending(proposalId,value);},
  refused:(proposalId,error)=>{if(isCurrent())handlers.refused(proposalId,error);},
  started:(proposal,jobId)=>{if(isCurrent())handlers.started(proposal,jobId);},
 };
}

// ---- Message ids ----

/** The highest number of the ids q1, q2 … in these messages, or 0. */
export function highestMessageNumber(messages:readonly Pick<AssistantMessage,'id'>[]):number{
 let highest=0;
 for(const message of messages){const match=/^q(\d+)$/.exec(message.id);if(match)highest=Math.max(highest,Number(match[1]));}
 return highest;
}
/** The next id after the counter and after every restored id, so a new question never takes the id of a restored message. */
export const nextMessageNumber=(counter:number,messages:readonly Pick<AssistantMessage,'id'>[])=>Math.max(counter,highestMessageNumber(messages))+1;

// ---- The list of earlier conversations ----

/** One row of "Earlier conversations". */
export type EarlierConversation={id:string;serverId:string;device:string;title:string;questions:number;updatedAt:number;thisDevice:boolean};
/** The title of a conversation: its first question that is not a follow-up. */
export const conversationTitle=(conversation:Pick<StoredConversation,'messages'>)=>(conversation.messages.find(entry=>!entry.followUp)??conversation.messages[0])?.question??'';
/**
 * The earlier conversations of all devices, newest first, without the
 * conversation the panel shows now. A conversation lists only when its device
 * is in the viewer's servers and the Assistant panel is available for it; the
 * others stay in the store.
 */
export function earlierConversations<Device extends {id:string;name:string}>(conversations:readonly StoredConversation[],{shownId,serverId,servers,available}:{shownId?:string;serverId:string;servers:readonly Device[];available:(device:Device)=>boolean}):EarlierConversation[]{
 const devices=new Map(servers.map(device=>[device.id,device]));
 return conversations
  .filter(conversation=>conversation.id!==shownId&&conversation.messages.length>0)
  .flatMap(conversation=>{
   const device=devices.get(conversation.serverId);
   if(!device||!available(device))return [];
   return [{id:conversation.id,serverId:conversation.serverId,device:device.name||conversation.serverName,title:conversationTitle(conversation),questions:conversation.messages.filter(entry=>!entry.followUp).length,updatedAt:conversation.updatedAt,thisDevice:conversation.serverId===serverId}];
  })
  .sort((a,b)=>b.updatedAt-a.updatedAt);
}

// ---- Storage adapter ----

/** The tab's sessionStorage, or null where it is missing or blocked. */
export function sessionConversationStorage():ConversationStorage|null{
 try{return typeof window!=='undefined'&&window.sessionStorage?window.sessionStorage:null;}catch{return null;}
}
/** Reads the store; a missing or throwing storage gives an empty store. */
export function loadStore(storage:ConversationStorage|null,userId:string,interrupted:string):ConversationStore{
 if(!storage)return emptyStore(userId);
 let raw:string|null;
 try{raw=storage.getItem(conversationsKey);}catch{return emptyStore(userId);}
 return parseStore(raw,userId,interrupted);
}
/**
 * Writes the store. When the write fails (quota), the oldest earlier
 * conversation is dropped and the write tried again, until it fits; with no
 * earlier conversation left, the write is skipped. Returns the store that was
 * written, or null when nothing was written.
 */
export function saveStore(storage:ConversationStorage|null,store:ConversationStore):ConversationStore|null{
 if(!storage)return null;
 let next=limitStore(store);
 for(;;){
  try{storage.setItem(conversationsKey,JSON.stringify(next));return next;}
  catch{const oldest=oldestEarlier(next);if(!oldest)return null;next=without(next,oldest.id);}
 }
}
/** Removes the stored conversations (sign-out). */
export function clearAssistantConversations(storage:ConversationStorage|null=sessionConversationStorage()){
 sessionCache=null;
 try{storage?.removeItem(conversationsKey);}catch{/* A blocked storage holds nothing to remove. */}
}

// ---- The store of this page load ----

// The store of this page load: read once from the storage, then the storage
// is its copy. Without a usable storage, or when a write is skipped, the
// conversations live here only.
let sessionCache:ConversationStore|null=null;
/** The store of this viewer: from memory, else from the storage. Another viewer's store gives an empty one. */
export function readSessionStore(userId:string,interrupted:string,storage:ConversationStorage|null=sessionConversationStorage()):ConversationStore{
 if(sessionCache?.userId===userId)return sessionCache;
 sessionCache=loadStore(storage,userId,interrupted);
 return sessionCache;
}
/** Writes the store to memory and to the storage; returns the store as kept (the quota can drop old conversations). */
export function writeSessionStore(store:ConversationStore,storage:ConversationStorage|null=sessionConversationStorage()):ConversationStore{
 const limited=limitStore(store);
 sessionCache=saveStore(storage,limited)??limited;
 return sessionCache;
}
/** Applies a change to the store of this viewer and writes it. */
export function changeSessionStore(userId:string,interrupted:string,change:(store:ConversationStore)=>ConversationStore,storage:ConversationStorage|null=sessionConversationStorage()):ConversationStore{
 return writeSessionStore(change(readSessionStore(userId,interrupted,storage)),storage);
}
