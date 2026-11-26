import type {Job} from '../../types';

type RunbookStep = {name?:string;kind?:string};
export type RunbookHistoryRow = {
 runId:string;serverId:string;name:string|null;definition:string|null;actor:string;
 state:string;runState:string;cancelRequested:number;stepIndex:number;createdAt:number;
 startedAt:number|null;finishedAt:number|null;runFinishedAt:number|null;jobId:string|null;
 currentJobState:string|null;
};
export type RunbookHistoryStep = {
 runId:string;serverId:string;stepIndex:number;state:string;claimedAt:number|null;
 lastProgress:number|null;completedAt:number|null;outputSecurity:number;
};
const terminalStates=new Set(['succeeded','failed','expired','cancelled','unknown']);
function definitionSteps(raw:string|null):RunbookStep[]{
 try{const value=JSON.parse(raw??'{}');return Array.isArray(value.steps)?value.steps:[];}catch{return [];}
}
/** One durable run/device row, never a concatenation of potentially scoped outputs. */
export function runbookHistoryJob(row:RunbookHistoryRow,steps:RunbookHistoryStep[],canReadOutputs:boolean):Job {
 const definition=definitionSteps(row.definition),total=definition.length;
 const completed=steps.filter(s=>terminalStates.has(s.state)).length;
 let state=row.state;
 if(!terminalStates.has(state)){
  const child=row.currentJobState;
  if(child==='expired'||row.jobId&&!child)state='unknown';
  else if(child&&terminalStates.has(child)&&child!=='succeeded')state=child;
  else if(total>0&&steps.filter(s=>s.state==='succeeded').length>=total)state='succeeded';
  else if(child==='running')state='running';
  else if(child==='pending')state='pending';
  else if(row.runState==='cancelled')state='cancelled';
  else if(!['queued','running'].includes(row.runState))state='unknown';
  else state=row.startedAt!==null?'running':'pending';
 }
 const currentStep=['pending','running'].includes(state)&&row.stepIndex<total?row.stepIndex+1:undefined;
 const scriptOutput=steps.some(s=>definition[s.stepIndex]?.kind!=='diagnosis');
 const outputRedacted=!canReadOutputs&&scriptOutput;
 const claims=steps.map(s=>s.claimedAt).filter((value):value is number=>value!==null);
 const progress=steps.flatMap(s=>[s.lastProgress,s.completedAt]).filter((value):value is number=>value!==null);
 const finishedAt=row.finishedAt??(terminalStates.has(state)?row.runFinishedAt:null);
 return {
  id:`runbook:${row.runId}:${row.serverId}`,serverId:row.serverId,action:'runbook-run',
  target:row.name??'Runbook',state,createdAt:row.createdAt,
  claimedAt:claims.length?Math.min(...claims):null,
  lastProgress:progress.length?Math.max(...progress):null,
  // Child results remain available only through the Runbook API's output checks.
  result:null,actor:row.actor,...(outputRedacted?{outputRedacted:true}:{}),
  metadata:{runbookRunId:row.runId,completedSteps:completed,totalSteps:total,
   ...(currentStep?{currentStep,currentStepName:definition[row.stepIndex]?.name}:{}),
   cancelRequested:!!row.cancelRequested,...(finishedAt!==null?{finishedAt}:{})}
 };
}
