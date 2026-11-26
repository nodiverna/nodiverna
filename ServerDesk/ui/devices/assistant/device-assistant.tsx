'use client';
import {Fragment,useCallback,useEffect,useId,useLayoutEffect,useRef,useState,type FormEvent,type KeyboardEvent,type ReactNode} from 'react';
import {AlertTriangle,Check,ChevronRight,Clock,Copy,History,KeyRound,MessageSquarePlus,Play,RotateCcw,Send,Settings,ShieldAlert,Sparkles,SquareTerminal,UserRound,Wrench} from 'lucide-react';
import {toast} from 'sonner';
import type {Server,Viewer} from '@/lib/types';
import type {AssistantStatus,AssistantAnswer} from '@/lib/server/devices/assistant';
import {answerTokens,type AnswerInline} from '@/lib/assistant-answer';
import {assistantLimits,assistantSourceAreas,isAssistantToolName,scriptLineCount,type AssistantProposal,type AssistantSourceArea} from '@/lib/assistant-config';
import {agentMessageText} from '@/lib/agent-messages';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import type {Confirmation,ConfirmationOutcome} from '@/ui/base/confirmation';
import type {ConsoleActionOptions} from '@/ui/shell/console-action';
import {deviceSectionLabels} from '@/lib/console-route';
import {canManageInstanceSettings} from '@/ui/base/access-capabilities';
import {providerLabel} from '@/ui/settings/assistant-settings-panel';
import {api,message} from '@/ui/base/api';
import {Btn,Card,Drawer,Empty,EntranceList,Facts,IconBtn,IconTile,Notice,Skeleton,StatusPill,cx,relativeTime,type StatusKind} from '@/ui/kit/kit';
import {RetryAction} from '@/ui/kit/analysis-tab';
import {useLocale,useT,type Translate} from '@/ui/base/locale';
import {finalStateWord,needsConfirmation,proposalBlockedReason,proposalConfirmation,proposalLabel,resultQuestion,runOptions,runPayload,trackAssistantJob,type PolledJob} from '@/ui/devices/assistant/assistant-proposals';
import {activeConversation,changeSessionStore,keepConversation,nextMessageNumber,normalizeConversation,openStoredConversation,readSessionStore,runHandlersFor,showConversation,startNewConversation,type RunHandlers,type AssistantMessage,type ConversationStore,type EarlierConversation,type ProposalRun,type StoredConversation} from '@/ui/devices/assistant/assistant-conversations';
import '@/ui/devices/assistant/assistant.css';

// The device assistant (docs/ai-assistant.md): a conversation about one
// device. The answers come from a language model that reads the data the
// portal stores for the device, with the viewer's rights. It can propose
// commands; a command runs only when the user clicks Run on device, through
// the console's job checks, and its result comes back as a follow-up answer.
// The conversation, the cards and their polling live in DeviceView (keyed per
// device): they survive tab switches and closing the panel. The conversations
// are kept in the browser tab's sessionStorage (assistant-conversations.ts)
// until the tab closes or the user signs out: a reload or a device change
// shows the device's conversation again, and "New conversation" keeps the old
// one under "Earlier conversations", for all devices. Leaving a conversation
// ends its open answer and the following of a command; queued jobs keep
// running. Nothing is stored on the server.

// ---- The answer renderer ----

function Inlines({inlines}:{inlines:AnswerInline[]}){
 return <>{inlines.map((inline,index)=>inline.type==='break'?<br key={index}/>:inline.type==='bold'?<strong key={index}>{inline.text}</strong>:inline.type==='code'?<code key={index}>{inline.text}</code>:<Fragment key={index}>{inline.text}</Fragment>)}</>;
}
/** The tokens of lib/assistant-answer.ts as React elements: text is always escaped, no link and no image is ever made. */
export function AnswerView({text}:{text:string}){
 return <div className="sdx-assistant-answer-text">{answerTokens(text).map((block,index)=>{
  if(block.type==='code')return <pre key={index}><code>{block.text}</code></pre>;
  if(block.type==='list'){const items=block.items.map((item,itemIndex)=><li key={itemIndex}><Inlines inlines={item}/></li>);return block.ordered?<ol key={index} start={block.start===1?undefined:block.start}>{items}</ol>:<ul key={index}>{items}</ul>;}
  if(block.type==='heading')return <p key={index} className="sdx-assistant-heading"><strong><Inlines inlines={block.inlines}/></strong></p>;
  return <p key={index}><Inlines inlines={block.inlines}/></p>;
 })}</div>;
}

// ---- Sources ----

const detailLabels:Readonly<Record<string,MessageKey>>={processes:'device.area.processes',events:'device.area.events',services:'device.area.services',updates:'device.area.updates',storage:'device.area.storage',network:'device.area.network',defender:'device.area.defender',programs:'device.area.programs',drivers:'drivers.title',autostart:'autostart.title',features:'device.area.features',tasks:'management.tasks.title',gpu:'device.gpu.card'};
/** "Management › Updates" or "Software › Drivers": the area names of the device page. */
export function sourceAreaLabel(area:AssistantSourceArea,t:Translate):string{
 const section=t(deviceSectionLabels[area.section]);
 return 'detail' in area?`${section} › ${t(detailLabels[area.detail])}`:section;
}
/** The section and the subarea that a source chip opens on the device page (onSection), for example ['hardware','gpu']. */
export const sourceAreaRoute=(area:AssistantSourceArea):[AssistantSourceArea['section'],string|undefined]=>[area.section,'detail' in area?area.detail:undefined];
export type SourceChip={key:string;area:AssistantSourceArea;label:string};
/** One chip per area the assistant read, in first-use order; two tools of one area give one chip. */
export function sourceChips(sources:readonly string[],t:Translate):SourceChip[]{
 const chips:SourceChip[]=[];
 for(const name of sources){
  if(!isAssistantToolName(name))continue;
  const area=assistantSourceAreas[name],key='detail' in area?`${area.section}:${area.detail}`:area.section;
  if(!chips.some(chip=>chip.key===key))chips.push({key,area,label:sourceAreaLabel(area,t)});
 }
 return chips;
}

// ---- The conversation ----

export type {AssistantMessage,ProposalRun};
/** The earlier pairs a question sends: the last 10 answered ones. */
export const historyOf=(messages:readonly AssistantMessage[],exceptId?:string)=>messages.filter(entry=>entry.status==='done'&&entry.id!==exceptId).slice(-assistantLimits.historyPairs).map(entry=>({question:entry.question,answer:entry.answer??''}));
/** Whether a command of this conversation is being sent or still runs; an untracked card is not followed any more. */
export const commandBusy=(runs:Readonly<Record<string,ProposalRun>>)=>Object.values(runs).some(run=>run.sending||run.status==='queued'||run.status==='running');
const statusOfJob=(state:string):ProposalRun['status']=>state==='running'?'running':state==='pending'?'queued':state==='succeeded'?'finished':'failed';
let messageCounter=0;
const noConversations:readonly StoredConversation[]=[];
const newConversationId=()=>'c-'+(globalThis.crypto?.randomUUID?.()??`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
type ConversationMeta={id:string;startedAt:number;updatedAt:number};
type ShownConversation={meta:ConversationMeta;messages:AssistantMessage[];runs:Record<string,ProposalRun>};
const freshConversation=():ShownConversation=>({meta:{id:newConversationId(),startedAt:0,updatedAt:0},messages:[],runs:{}});
const shownOf=(stored:StoredConversation|undefined,interrupted:string):ShownConversation|undefined=>{
 if(!stored)return undefined;
 const conversation=normalizeConversation(stored,interrupted);
 return {meta:{id:conversation.id,startedAt:conversation.startedAt,updatedAt:conversation.updatedAt},messages:conversation.messages,runs:conversation.runs};
};
/** Where the conversation is kept: the viewer it belongs to and the device name for the list. Without keep (sample devices, tests) it lives in React state only. */
export type ConversationKeep={userId:string;serverName:string};
/**
 * The conversation of one device. A question shows at once (pending); its
 * answer replaces the pending state. A proposal that ran is polled until its
 * job is final; then the follow-up is sent once. With keep, the conversation
 * is kept in the tab's sessionStorage (assistant-conversations.ts): the device
 * shows its active conversation again after a reload or a device change, and
 * "New conversation" or opening an earlier one keeps the shown one as an
 * earlier conversation. Leaving a conversation (New conversation, opening
 * another one, an unmount) drops a pending answer and ends the polling, so
 * nothing lands in another conversation; the kept copy is normalized (a
 * pending question fails as interrupted, a followed job is untracked).
 */
export function useAssistantConversation(serverId:string,keep?:ConversationKeep){
 const [locale]=useLocale();
 const userId=keep?.userId,serverName=keep?.serverName??'',interrupted=translate(locale,'assistant.interrupted');
 const [initial]=useState<ShownConversation>(()=>(userId?shownOf(activeConversation(readSessionStore(userId,interrupted),serverId),interrupted):undefined)??freshConversation());
 // The kept conversations of all devices for "Earlier conversations". The list leaves out the shown conversation,
 // so only leaving a conversation and opening one change it; both set it here.
 const [stored,setStored]=useState<readonly StoredConversation[]>(()=>userId?readSessionStore(userId,interrupted).conversations:noConversations);
 const [meta,setMeta]=useState(initial.meta),[messages,setMessages]=useState<AssistantMessage[]>(initial.messages),[runs,setRuns]=useState<Record<string,ProposalRun>>(initial.runs);
 const current=useRef(messages),generation=useRef(0),mounted=useRef(true);
 // The shown conversation as the unmount and the event handlers keep it.
 const latest=useRef({meta,messages,runs,serverName,interrupted});
 useLayoutEffect(()=>{current.current=messages;latest.current={meta,messages,runs,serverName,interrupted};},[meta,messages,runs,serverName,interrupted]);
 /** The shown conversation as stored, or undefined while it has no message. */
 const snapshot=useCallback(():StoredConversation|undefined=>{
  const shown=latest.current;
  return shown.messages.length?{id:shown.meta.id,serverId,serverName:shown.serverName,startedAt:shown.meta.startedAt||shown.messages[0].askedAt,updatedAt:shown.meta.updatedAt||shown.messages[0].askedAt,messages:shown.messages,runs:shown.runs}:undefined;
 },[serverId]);
 /** Ends the open work of the shown conversation and keeps its normalized copy as an earlier conversation. */
 const leave=useCallback((change?:(store:ConversationStore)=>ConversationStore)=>{
  generation.current++;
  if(!userId)return;
  const kept=snapshot(),text=latest.current.interrupted;
  setStored(changeSessionStore(userId,text,store=>{const next=kept?keepConversation(store,normalizeConversation(kept,text)):store;return change?change(next):next;}).conversations);
 },[userId,snapshot]);
 useEffect(()=>{
  mounted.current=true;
  const rounds=generation,leaving=leave;
  // An unmount (a device change, a reload) drops a pending answer and ends the polling: a later answer belongs to no conversation.
  return()=>{mounted.current=false;rounds.current++;leaving();};
 },[leave]);
 // Each change of the shown conversation is written, so a reload or a device change shows it again.
 useEffect(()=>{
  if(!userId||!messages.length)return;
  const shown=snapshot();
  if(shown)changeSessionStore(userId,interrupted,store=>showConversation(store,shown));
 },[userId,interrupted,snapshot,meta,messages,runs]);
 const alive=useCallback((round:number)=>mounted.current&&round===generation.current,[]);
 const touch=useCallback(()=>{const now=Date.now();setMeta(previous=>({...previous,startedAt:previous.startedAt||now,updatedAt:now}));},[]);
 const send=useCallback(async(question:string,retryId?:string,followUp?:{jobId:string})=>{
  if(!retryId)messageCounter=nextMessageNumber(messageCounter,current.current);
  const id=retryId??`q${messageCounter}`,round=generation.current,history=historyOf(current.current,id);
  setMessages(previous=>retryId?previous.map(entry=>entry.id===id?{...entry,status:'pending',error:undefined}:entry):[...previous,{id,question,status:'pending',askedAt:Date.now(),...(followUp?{followUp}:{})}]);
  touch();
  try{
   const result=await api<AssistantAnswer>('/api/assistant',{action:'ask',serverId,history,locale,...(followUp?{followUp}:{question})});
   if(!alive(round))return;
   setMessages(previous=>previous.map(entry=>entry.id===id?{...entry,status:'done',answer:result.answer,sources:result.sources,proposals:result.proposals??[],answeredAt:Date.now()}:entry));
   touch();
  }catch(failure){
   if(!alive(round))return;
   setMessages(previous=>previous.map(entry=>entry.id===id?{...entry,status:'failed',error:message(failure,locale),answeredAt:Date.now()}:entry));
   touch();
  }
 },[serverId,locale,alive,touch]);
 const ask=useCallback((question:string)=>{void send(question.trim());},[send]);
 // Ask again sends the same question, or the same follow-up once more, with the history of this conversation.
 const retry=useCallback((id:string)=>{const entry=current.current.find(item=>item.id===id);if(entry&&entry.status==='failed')void send(entry.question,id,entry.followUp);},[send]);
 const show=useCallback((next:ShownConversation)=>{current.current=next.messages;setMeta(next.meta);setMessages(next.messages);setRuns(next.runs);},[]);
 /** New conversation: the shown one stays as an earlier conversation; the device shows none until the first question. */
 const reset=useCallback(()=>{leave(store=>startNewConversation(store,serverId));show(freshConversation());},[leave,show,serverId]);
 /** Shows a kept conversation of this device here; the shown one stays as an earlier conversation. */
 const open=useCallback((conversationId:string)=>{
  if(!userId||conversationId===latest.current.meta.id)return;
  const text=latest.current.interrupted;
  if(!readSessionStore(userId,text).conversations.some(entry=>entry.id===conversationId&&entry.serverId===serverId))return;
  leave(store=>openStoredConversation(store,conversationId));
  show(shownOf(activeConversation(readSessionStore(userId,text),serverId),text)??freshConversation());
 },[userId,leave,show,serverId]);
 /** Makes a kept conversation of another device its shown one; the console then opens that device (this panel unmounts and keeps its own). */
 const openElsewhere=useCallback((conversationId:string)=>{
  if(!userId)return false;
  const store=changeSessionStore(userId,latest.current.interrupted,next=>openStoredConversation(next,conversationId));
  setStored(store.conversations);
  return Object.values(store.active).includes(conversationId);
 },[userId]);
 const update=useCallback((proposalId:string,patch:Partial<ProposalRun>)=>setRuns(previous=>({...previous,[proposalId]:{...(previous[proposalId]??{status:'open'}),...patch}})),[]);
 const dismiss=useCallback((proposalId:string)=>update(proposalId,{status:'dismissed',error:undefined,changedAt:Date.now()}),[update]);
 const sending=useCallback((proposalId:string,value:boolean)=>update(proposalId,value?{sending:true,error:undefined}:{sending:false}),[update]);
 const refused=useCallback((proposalId:string,error:string)=>update(proposalId,{error,sending:false}),[update]);
 /** The run was queued: poll the job (2 s, then 5 s, at most 10 minutes), then send the follow-up once. */
 const started=useCallback((proposal:AssistantProposal,jobId:string)=>{
  const round=generation.current,tr:Translate=(key,params)=>translate(locale,key,params);
  update(proposal.id,{status:'queued',jobId,sending:false,error:undefined,changedAt:Date.now()});
  void trackAssistantJob({
   fetchJob:async()=>(await api<{job:PolledJob}>(`/api/assistant?serverId=${encodeURIComponent(serverId)}&jobId=${encodeURIComponent(jobId)}`)).job,
   wait:ms=>new Promise(resolve=>setTimeout(()=>resolve(alive(round)),ms)),
   now:()=>Date.now(),
   onUpdate:job=>{if(alive(round)&&!job.finished)update(proposal.id,{status:statusOfJob(job.state)});},
  }).then(outcome=>{
   if(!alive(round)||outcome==='ended')return;
   if(outcome==='stale'){update(proposal.id,{status:'stale',changedAt:Date.now()});return;}
   update(proposal.id,{status:statusOfJob(outcome.state),result:agentMessageText(outcome,tr),changedAt:Date.now()});
   void send(resultQuestion(proposal,outcome.state,tr,locale),undefined,{jobId:outcome.id});
  });
 },[serverId,locale,alive,update,send]);
 /** The handlers of one Run on device, taken when the run starts: an outcome after the conversation was left changes nothing. */
 const runHandlers=useCallback(():RunHandlers=>{const round=generation.current;return runHandlersFor(()=>alive(round),{sending,refused,started});},[alive,sending,refused,started]);
 const pending=messages.some(entry=>entry.status==='pending');
 return {id:meta.id,messages,runs,stored,pending,busy:pending||commandBusy(runs),ask,retry,reset,open,openElsewhere,dismiss,sending,refused,started,runHandlers};
}
export type AssistantConversation=ReturnType<typeof useAssistantConversation>;

/** Why Ask cannot send now, or undefined. */
export function askBlockedReason({question,demo,pending}:{question:string;demo:boolean;pending:boolean},t:Translate):string|undefined{
 if(demo)return t('kit.unavailable.demo');
 if(pending)return t('assistant.askBlocked.pending');
 if(!question.trim())return t('assistant.askBlocked.empty');
 if(question.trim().length>assistantLimits.questionChars)return t('assistant.questionTooLong');
 return undefined;
}
/** The source sentence under the field. */
export function assistantSourceLine(status:Pick<AssistantStatus,'source'|'provider'|'customerName'>,t:Translate):string|null{
 if(!status.source||!status.provider)return null;
 const provider=providerLabel(status.provider,t);
 if(status.source==='customer')return t('assistant.source.customer',{provider,customer:status.customerName??''});
 return t(status.source==='personal'?'assistant.source.personal':'assistant.source.organization',{provider});
}
export const assistantSuggestions:readonly MessageKey[]=['assistant.suggestion.slow','assistant.suggestion.updates','assistant.suggestion.problems','assistant.suggestion.services'];
/** A message that was asked or answered in the last 600 ms rises in; a remount or a refresh shows it at once. */
const entering=(at:number|undefined)=>typeof at==='number'&&Date.now()-at<600;

function CopyAnswer({text}:{text:string}){
 const t=useT(),[copied,setCopied]=useState(false);
 useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),1200);return()=>clearTimeout(timer);},[copied]);
 const copy=async()=>{
  try{await navigator.clipboard.writeText(text);setCopied(true);toast.success(t('assistant.copied'));}
  catch{toast.error(t('assistant.copyFailed'));}
 };
 return <IconBtn icon={copied?Check:Copy} label={t('assistant.copy')} className={cx('sdx-assistant-copy',copied&&'is-copied')} onClick={()=>void copy()}/>;
}

// ---- Proposal cards ----

/** The pill of a card: the risk before the run, Finished or Failed after it. */
export function proposalPill(proposal:AssistantProposal,run:ProposalRun|undefined,t:Translate):{kind:StatusKind;text:string;key:string}{
 if(run?.status==='finished'||run?.status==='failed')return {kind:run.status==='finished'?'success':'critical',text:finalStateWord(run.status==='finished'?'succeeded':'failed',t),key:run.status};
 if(proposal.disruptive)return {kind:'critical',text:t('assistant.proposal.disruptive'),key:'risk'};
 return proposal.readOnly?{kind:'neutral',text:t('assistant.proposal.reads'),key:'risk'}:{kind:'warning',text:t('assistant.proposal.changes'),key:'risk'};
}
const factValue=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value);
/** What the cards of one answer need from the panel. */
export type ProposalContext={server:Pick<Server,'id'|'name'|'permissions'|'snapshot'>;viewer:Viewer;demo:boolean;online:boolean;busy:boolean;runs:Readonly<Record<string,ProposalRun>>;onRun:(proposal:AssistantProposal)=>void;onDismiss:(proposal:AssistantProposal)=>void};

/** One proposed command: the exact command, its risk, the model's reason, Run on device and Don't run, then its job state. */
export function ProposalCard({proposal,context}:{proposal:AssistantProposal;context:ProposalContext}){
 const t=useT(),[locale]=useLocale(),titleId=useId(),run=context.runs[proposal.id];
 const label=proposalLabel(proposal,t,locale),script=proposal.type==='powershell';
 if(run?.status==='dismissed')return <div className="sdx-assistant-proposal is-dismissed" role="group" aria-labelledby={titleId}>
  <span id={titleId}>{label}{proposal.target&&<> <span className="mono">{proposal.target}</span></>}</span><span>{t('assistant.proposal.dismissed')}</span>
 </div>;
 const pill=proposalPill(proposal,run,t),open=!run||run.status==='open';
 const reason=proposalBlockedReason(proposal,context,t),params=Object.entries(proposal.params);
 return <div className={cx('sdx-assistant-proposal',!open&&'is-started')} role="group" aria-labelledby={titleId} data-proposal={proposal.id}>
  <div className="sdx-assistant-proposal-head">
   <IconTile icon={script?SquareTerminal:Wrench} tone={proposal.readOnly?'accent':'warning'} size="sm"/>
   <p className="sdx-assistant-proposal-title" id={titleId}><strong>{label}</strong>{proposal.target&&<span className="mono">{proposal.target}</span>}</p>
   <span key={pill.key} className="sdx-assistant-proposal-pill"><StatusPill kind={pill.kind}>{pill.text}</StatusPill></span>
  </div>
  <AnswerView text={proposal.reason}/>
  {!script&&params.length>0&&<Facts className="sdx-assistant-proposal-params" columns={params.length>2?2:1} items={params.map(([key,value])=>({id:key,label:key,value:factValue(value),mono:true}))}/>}
  {proposal.type==='powershell'&&<div className="sdx-assistant-proposal-script">
   <p className="sdx-assistant-proposal-note"><ShieldAlert size={14} aria-hidden/><span>{t('assistant.proposal.asSystem')}</span><span className="sdx-assistant-proposal-lines">{t('assistant.proposal.lines',{count:scriptLineCount(proposal.script)})}</span></p>
   <pre tabIndex={0} aria-label={t('assistant.proposal.powershell')}><code>{proposal.script}</code></pre>
  </div>}
  {open&&<>
   <div className="sdx-assistant-proposal-actions">
    <Btn variant="primary" icon={Play} loading={run?.sending} blocked={reason} onClick={()=>context.onRun(proposal)}>{t('assistant.proposal.run')}</Btn>
    <Btn variant="ghost" blocked={run?.sending?t('assistant.proposal.blocked.busy'):undefined} onClick={()=>context.onDismiss(proposal)}>{t('assistant.proposal.dismiss')}</Btn>
   </div>
   {run?.error&&<Notice tone="danger" icon={AlertTriangle}>{run.error}</Notice>}
  </>}
  {(run?.status==='queued'||run?.status==='running')&&<div className="sdx-assistant-pending" role="status" aria-live="polite"><span className="sdx-assistant-pulse" aria-hidden/>{t(run.status==='queued'?'assistant.proposal.queued':'assistant.proposal.running')}</div>}
  {(run?.status==='finished'||run?.status==='failed')&&run.result&&<p className="sdx-assistant-proposal-result" role="status">{run.result}</p>}
  {run?.status==='stale'&&<p className="sdx-assistant-proposal-result is-muted" role="status"><Clock size={14} aria-hidden/>{t('assistant.proposal.stillRunning')}</p>}
  {run?.status==='untracked'&&<p className="sdx-assistant-proposal-result is-muted" role="status"><Clock size={14} aria-hidden/>{t('assistant.proposal.untracked')}</p>}
 </div>;
}

function MessageView({entry,onOpenArea,onRetry,demo,proposals}:{entry:AssistantMessage;onOpenArea:(area:AssistantSourceArea)=>void;onRetry:(id:string)=>void;demo:boolean;proposals:ProposalContext}){
 const t=useT(),chips=sourceChips(entry.sources??[],t);
 return <li className="sdx-assistant-turn">
  {!entry.followUp&&<div className={cx('sdx-assistant-question',entering(entry.askedAt)&&'sdx-assistant-enter')}><span className="sr-only">{t('assistant.you')}: </span>{entry.question}</div>}
  {entry.status==='pending'&&<div className="sdx-assistant-pending" role="status" aria-live="polite"><span className="sdx-assistant-pulse" aria-hidden/>{t(entry.followUp?'assistant.proposal.reading':'assistant.pending')}</div>}
  {entry.status==='done'&&<article className={cx('sdx-assistant-reply',entering(entry.answeredAt)&&'sdx-assistant-enter')} aria-label={t('assistant.answer')}>
   <span className="sdx-assistant-avatar" aria-hidden><Sparkles size={14}/></span>
   <div className="sdx-assistant-reply-body">
    <AnswerView text={entry.answer??''}/>
    {!!entry.proposals?.length&&<div className="sdx-assistant-proposals">{entry.proposals.map(proposal=><ProposalCard key={proposal.id} proposal={proposal} context={proposals}/>)}</div>}
    <div className="sdx-assistant-reply-foot">
     {chips.length>0&&<div className="sdx-assistant-sources" role="group" aria-label={t('assistant.sources')}>
      <span className="sdx-assistant-sources-label">{t('assistant.sources')}</span>
      {chips.map(chip=><button key={chip.key} type="button" className="sdx-assistant-chip" aria-label={t('assistant.openSource',{area:chip.label})} onClick={()=>onOpenArea(chip.area)}>{chip.label}<ChevronRight size={12} aria-hidden/></button>)}
     </div>}
     <CopyAnswer text={entry.answer??''}/>
    </div>
   </div>
  </article>}
  {entry.status==='failed'&&<div className={cx('sdx-assistant-failed',entering(entry.answeredAt)&&'sdx-assistant-enter')}>
   <Notice tone="danger" icon={AlertTriangle} action={<Btn size="sm" icon={RotateCcw} blocked={demo?t('kit.unavailable.demo'):undefined} onClick={()=>onRetry(entry.id)}>{t('assistant.askAgain')}</Btn>}>{entry.error}</Notice>
  </div>}
 </li>;
}

/** The console action (ui/shell/console-action.ts): sends a payload, toasts, opens the MFA prompt on its code and resends once. */
export type AssistantAction=(payload:Record<string,unknown>,onSettled?:(outcome:ConfirmationOutcome)=>void,options?:ConsoleActionOptions)=>Promise<void>;
/**
 * Run on device: a read-only action goes out at once, a changing action and
 * every script open a confirmation first. Both go through the console action,
 * so the MFA prompt and its single resend work as in the console. The card
 * changes only on the outcome: a cancelled confirmation or MFA prompt leaves
 * it as it was. The handlers are taken when the run starts, so an outcome that
 * comes back after the user left the conversation changes nothing there or in
 * the conversation shown now.
 */
export function runProposal(proposal:AssistantProposal,{server,t,locale,conversation,onConfirm,onAction}:{server:Pick<Server,'id'|'name'>;t:Translate;locale:Parameters<typeof proposalConfirmation>[3];conversation:Pick<AssistantConversation,'runHandlers'>;onConfirm?:(confirmation:Confirmation)=>void;onAction?:AssistantAction}){
 const run=conversation.runHandlers();
 const settle=(outcome:ConfirmationOutcome)=>{
  if(outcome.ok){if(outcome.id)run.started(proposal,outcome.id);else run.sending(proposal.id,false);}
  else run.refused(proposal.id,outcome.message??t('console.actionFailed'));
 };
 if(needsConfirmation(proposal)){onConfirm?.(proposalConfirmation(proposal,server,t,locale,settle));return;}
 if(!onAction)return;
 run.sending(proposal.id,true);
 void onAction(runPayload(proposal,server.id),settle,runOptions(t)).finally(()=>run.sending(proposal.id,false));
}

// ---- Earlier conversations ----

/**
 * The list of "Earlier conversations": one button per kept conversation,
 * newest first. The title is the first question (2 lines), the meta line
 * names the device, the number of questions and the last change; the rows of
 * the open device carry "This device". The first 8 rows rise in once per page
 * load (EntranceList), so opening the drawer again shows them at once.
 */
export function EarlierConversationList({rows,now,onOpen}:{rows:readonly EarlierConversation[];now:number;onOpen:(row:EarlierConversation)=>void}){
 const t=useT(),[locale]=useLocale();
 return <EntranceList id="assistant-earlier" as="ul" className="sdx-assistant-earlier" role="list" label={t('assistant.earlier')}>
  {rows.map(row=><li key={row.id}>
   <button type="button" className="sdx-assistant-earlier-row sdx-lift" data-conversation={row.id} aria-label={t('assistant.earlier.open',{title:row.title,device:row.device})} onClick={()=>onOpen(row)}>
    <IconTile icon={Sparkles} tone="accent" size="sm"/>
    <span className="sdx-assistant-earlier-body">
     <span className="sdx-assistant-earlier-title">{row.title}</span>
     <span className="sdx-assistant-earlier-meta">{t('assistant.earlier.meta',{device:row.device,questions:t('assistant.earlier.questions',{count:row.questions}),time:relativeTime(row.updatedAt,now,locale)})}</span>
    </span>
    {row.thisDevice&&<span className="sdx-tag">{t('assistant.earlier.thisDevice')}</span>}
   </button>
  </li>)}
 </EntranceList>;
}

type Props={
 server:Pick<Server,'id'|'name'>&Partial<Pick<Server,'permissions'|'snapshot'>>;viewer:Viewer;demo:boolean;conversation:AssistantConversation;
 /** The rows of "Earlier conversations" (earlierConversations in assistant-conversations.ts); empty blocks the button. */
 earlier?:readonly EarlierConversation[];
 /** Opens a row: here on this device, or on its own device through the console. */
 onOpenEarlier?:(row:EarlierConversation)=>void;
 /** Opens a device area from a source chip (DeviceView, the onSection path). */
 onOpenArea:(area:AssistantSourceArea)=>void;
 onOpenSettings?:()=>void;onOpenAccount?:()=>void;
 /** Whether the agent is connected now; Run on device needs it. */
 online?:boolean;
 /** The console confirmation and action that a command runs through. */
 onConfirm?:(confirmation:Confirmation)=>void;onAction?:AssistantAction;
 /** A status to show before or instead of the request (tests, sample devices). */
 initialStatus?:AssistantStatus|null;
 /** Rendered inside the "Ask assistant" drawer: the drawer title names the device, so the panel shows no card head of its own. */
 inDrawer?:boolean;
};
const demoStatus:AssistantStatus={available:true,source:null,provider:null,model:null};

/**
 * The conversation actions: "Earlier conversations" (with its drawer) and "New conversation". The card head of the
 * assistant holds them; in the "Ask assistant" drawer the device page puts them into the drawer head.
 */
export function AssistantActions({conversation,earlier=[],demo,onOpenEarlier}:{conversation:Pick<AssistantConversation,'messages'|'reset'>;earlier?:readonly EarlierConversation[];demo:boolean;onOpenEarlier?:(row:EarlierConversation)=>void}){
 const t=useT();
 // "Earlier conversations": the drawer and the time its relative times are counted from.
 const [earlierAt,setEarlierAt]=useState<number|null>(null),earlierButton=useRef<HTMLButtonElement>(null);
 // New conversation keeps the shown one under "Earlier conversations"; the toast says where it went.
 const startNew=()=>{conversation.reset();if(!demo)toast.success(t('assistant.kept'));};
 return <>
  <IconBtn ref={earlierButton} icon={History} label={t('assistant.earlier')} blocked={demo?t('kit.unavailable.demo'):earlier.length?undefined:t('assistant.earlier.blocked')} onClick={()=>setEarlierAt(Date.now())}/>
  {conversation.messages.length>0&&<IconBtn icon={MessageSquarePlus} label={t('assistant.newConversation')} onClick={startNew}/>}
  <Drawer open={earlierAt!==null} onClose={()=>setEarlierAt(null)} title={t('assistant.earlier')} description={t('assistant.earlier.description')} returnFocus={earlierButton}
   footer={<Btn onClick={()=>setEarlierAt(null)}>{t('common.close')}</Btn>}>
   <EarlierConversationList rows={earlier} now={earlierAt??0} onOpen={row=>{setEarlierAt(null);onOpenEarlier?.(row);}}/>
  </Drawer>
 </>;
}

/**
 * The assistant of a device ("Ask assistant"): the conversation as the focal point, the question field and the source
 * line at the bottom. inDrawer: the content of the flush "Ask assistant" drawer, whose head holds the title and the
 * conversation actions; otherwise a card with both.
 */
export default function DeviceAssistant({server,viewer,demo,conversation,earlier=[],onOpenEarlier,onOpenArea,onOpenSettings,onOpenAccount,online=true,onConfirm,onAction,initialStatus=null,inDrawer=false}:Props){
 const t=useT(),[locale]=useLocale();
 const [status,setStatus]=useState<AssistantStatus|null>(demo?demoStatus:initialStatus),[loadFailed,setLoadFailed]=useState(false),[loading,setLoading]=useState(!demo&&!initialStatus);
 const [question,setQuestion]=useState(''),[submitted,setSubmitted]=useState(false);
 const thread=useRef<HTMLDivElement>(null),mounted=useRef(false);
 const load=useCallback(async()=>{
  if(demo)return;
  setLoading(true);
  try{const next=await api<AssistantStatus>(`/api/assistant?serverId=${encodeURIComponent(server.id)}`);if(mounted.current){setStatus(next);setLoadFailed(false);}}
  catch{if(mounted.current)setLoadFailed(true);}
  finally{if(mounted.current)setLoading(false);}
 },[demo,server.id]);
 // The status is read each time the panel opens: a key saved meanwhile counts at once.
 useEffect(()=>{mounted.current=true;if(!initialStatus)void Promise.resolve().then(load);return()=>{mounted.current=false;};},[load,initialStatus]);
 const {messages,pending,ask,retry}=conversation;
 // A new question or answer scrolls the thread to the end, unless the user scrolled up to read.
 const lastCount=useRef(messages.length);
 useEffect(()=>{
  const element=thread.current;if(!element)return;
  const added=messages.length>lastCount.current;lastCount.current=messages.length;
  const near=element.scrollHeight-element.scrollTop-element.clientHeight<120;
  if(added||near)element.scrollTo({top:element.scrollHeight,behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
 },[messages]);
 const reason=askBlockedReason({question,demo,pending},t),tooLong=question.trim().length>assistantLimits.questionChars;
 const submit=(event?:FormEvent)=>{
  event?.preventDefault();setSubmitted(true);
  if(reason)return;
  ask(question);setQuestion('');setSubmitted(false);
 };
 const onKeyDown=(event:KeyboardEvent<HTMLTextAreaElement>)=>{
  // Enter sends, Shift+Enter inserts a new line; nothing while an input method composes.
  if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();submit();}
 };
 const suggest=(key:MessageKey)=>{if(!askBlockedReason({question:t(key),demo,pending},t))ask(t(key));};
 const proposals:ProposalContext={server:{id:server.id,name:server.name,permissions:server.permissions,snapshot:server.snapshot??null},viewer,demo,online,busy:conversation.busy,runs:conversation.runs,
  onRun:proposal=>runProposal(proposal,{server,t,locale,conversation,onConfirm,onAction}),onDismiss:proposal=>conversation.dismiss(proposal.id)};
 const title=t('assistant.title',{name:server.name}),owner=canManageInstanceSettings(viewer);
 // The frame: a card with the title on a page, or (in the drawer, whose head has the title and the actions) a plain column.
 const frame=(children:ReactNode,{flush=false,actions}:{flush?:boolean;actions?:ReactNode}={})=>inDrawer
  ?<div className={cx('sdx-assistant','sdx-assistant-panel',!flush&&'sdx-assistant-panel-padded')}>{children}</div>
  :<Card className="sdx-assistant" title={title} icon={Sparkles} iconTone="accent" id="sdx-assistant-title" flush={flush} actions={actions}>{children}</Card>;
 if(!status)return frame(loadFailed?<Notice tone="danger" icon={AlertTriangle} action={<RetryAction loading={loading} onRetry={()=>void load()}/>}>{t('assistant.loadError')}</Notice>:<Skeleton variant="facts" rows={2} label={t('assistant.loading')}/>);
 if(!status.available)return frame(<Empty icon={KeyRound} title={t('assistant.notSetUp.title')}
   action={owner?<Btn variant="primary" icon={Settings} onClick={onOpenSettings}>{t('assistant.openSettings')}</Btn>:<Btn variant="primary" icon={UserRound} onClick={onOpenAccount}>{t('assistant.openAccount')}</Btn>}>
   {t(owner?'assistant.notSetUp.owner':'assistant.notSetUp.member')}
  </Empty>);
 const sourceLine=assistantSourceLine(status,t),fieldId='sdx-assistant-question';
 return frame(<>
  <div className="sdx-assistant-thread" ref={thread} role="log" aria-label={t('assistant.thread')}>
   {messages.length?<ol key={conversation.id} className="sdx-assistant-turns">{messages.map(entry=><MessageView key={entry.id} entry={entry} demo={demo} onOpenArea={onOpenArea} onRetry={retry} proposals={proposals}/>)}</ol>
    :<Empty icon={Sparkles} title={t('assistant.empty.title')} action={<div className="sdx-assistant-suggestions" role="group" aria-label={t('assistant.suggestions')}>
     {assistantSuggestions.map(key=><Btn key={key} size="sm" blocked={demo?t('kit.unavailable.demo'):pending?t('assistant.askBlocked.pending'):undefined} onClick={()=>suggest(key)}>{t(key)}</Btn>)}
    </div>}>{t('assistant.empty.text')}</Empty>}
  </div>
  <form className="sdx-assistant-composer" noValidate onSubmit={submit}>
   <label className="sdx-field" htmlFor={fieldId}><span>{t('assistant.question')}</span>
    <textarea id={fieldId} rows={2} autoFocus value={question} placeholder={t('assistant.placeholder')} aria-invalid={tooLong||undefined} aria-describedby={`${fieldId}-note${tooLong?` ${fieldId}-error`:''}`}
     onChange={event=>setQuestion(event.target.value)} onKeyDown={onKeyDown}/>
    {(tooLong||submitted&&reason===t('assistant.questionTooLong'))&&<span className="sdx-field-error" id={`${fieldId}-error`}>{t('assistant.questionTooLong')}</span>}
   </label>
   <div className="sdx-assistant-composer-foot">
    <p className="sdx-assistant-note" id={`${fieldId}-note`}>{sourceLine&&<>{sourceLine} </>}{t('assistant.readOnlyNote')}</p>
    <Btn type="submit" variant="primary" icon={Send} blocked={reason}>{t('assistant.ask')}</Btn>
   </div>
  </form>
 </>,{flush:true,actions:<AssistantActions conversation={conversation} earlier={earlier} demo={demo} onOpenEarlier={onOpenEarlier}/>});
}
