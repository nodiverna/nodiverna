import {z} from 'zod';
import {HttpError,now} from '../context';
import {releaseLease,type AgentDevice} from '../agent/agent-protocol';
import {resolvePrincipal,requireDevice} from '../identity/access';
import type {ServerSnapshot} from '../../types';
import {MAX_TERMINALS,TERMINAL_PRESENCE_GRACE_MS,sweepTerminalSessions,terminalWriteGuard,terminalIsActive,type TerminalSession} from './terminal-lifecycle';
import {commitAll,db,sql,type Step} from '../db';

const sequence=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const terminalReport=z.object({
 id:z.guid(),state:z.enum(['opening','open','closed','error']),inputAck:sequence,
 output:z.array(z.object({seq:sequence.refine(value=>value>0),data:z.string().max(32768)})).max(64).default([]),
 error:z.string().max(500).optional()
});

export type TerminalReport=z.infer<typeof terminalReport>;
type TerminalCommand={id:string;state:string;input:unknown[];outputAck:number;cols?:unknown;rows?:unknown;expiresAt?:string};
function closedTerminal(id:string,outputAck=0):TerminalCommand{return {id,state:'closed',input:[],outputAck};}

// The broad compatibility channel and dedicated low-latency channel share the
// same owner, permission, expiry and contiguous ACK rules. Only one transport
// may carry terminal reports for a given agent capability set.
export async function exchangeTerminals(d:AgentDevice,s:ServerSnapshot,reports:TerminalReport[],time=now()){
 const multi=s.agentCapabilities?.includes('terminal-multi')===true,reportById=new Map(reports.map(report=>[report.id,report]));
 // Each shell has its own owner, input/output sequences and browser-presence
 // lease. Channel traffic deliberately never renews browser presence.
 const sessions=await db().query<TerminalSession>(sql`SELECT * FROM terminal_sessions WHERE server_id=${d.id} AND state IN ('opening','open') ORDER BY created_at,id LIMIT ${multi?MAX_TERMINALS:1}`).then(results=>({results}));
 const terminalCommands:TerminalCommand[]=[];
 for(const terminal of sessions.results){
  let permitted=d.management===1&&s.mode==='Management'&&terminalIsActive(terminal,time);
  try{const v=await resolvePrincipal(String(terminal.principal));if(!v)permitted=false;else await requireDevice(v,d.id,'terminal');}catch{permitted=false;}
  if(!permitted){
   await db().exec(sql`UPDATE terminal_sessions SET state='closed',error='serverMessage.terminal.expired' WHERE id=${terminal.id} AND state IN ('opening','open')`);
   await releaseLease(String(terminal.id));terminalCommands.push(closedTerminal(String(terminal.id),Number(terminal.output_seq)));continue;
  }
  const outputGuard=terminalWriteGuard('t',time),stateGuard=terminalWriteGuard('terminal_sessions',time);
  const report=reportById.get(String(terminal.id));
  if(report){
   if(!['closed','error'].includes(report.state)&&(report.inputAck>Number(terminal.input_seq)||report.inputAck<Number(terminal.input_ack)))throw new HttpError('apiError.terminal.invalidInputAck');
   // A closing report can never reset the last accepted input ACK.
   const inputAck=Math.min(Number(terminal.input_seq),Math.max(Number(terminal.input_ack),report.inputAck));
   let outputSeq=Number(terminal.output_seq);const writes:Step[]=[];
   for(const frame of report.output){
    if(frame.seq<=outputSeq)continue;if(frame.seq!==outputSeq+1)throw new HttpError('apiError.terminal.outputGap');
    // Authorization above can precede an offboarding transaction. The write
    // itself must see a live device and shell before storing any late output.
    writes.push(sql`INSERT INTO terminal_frames (id,session_id,direction,seq,data,created_at) SELECT ${String(terminal.id)+':out:'+frame.seq},t.id,'out',${frame.seq},${frame.data},${time} FROM terminal_sessions t JOIN servers s ON s.id=t.server_id WHERE t.id=${terminal.id} AND t.server_id=${d.id} AND s.revoked=0 AND t.state IN ('opening','open') AND t.expires_at>${time} AND t.last_activity>=${time-TERMINAL_PRESENCE_GRACE_MS} AND ${outputGuard} ON CONFLICT DO NOTHING`);outputSeq=frame.seq;
   }
   writes.push(
    sql`UPDATE terminal_sessions SET state=${report.state},input_ack=${inputAck},output_seq=${outputSeq},error=${report.error??null} WHERE id=${terminal.id} AND state IN ('opening','open') AND ${stateGuard}`,
    sql`DELETE FROM terminal_frames WHERE session_id=${terminal.id} AND direction='in' AND seq<=${inputAck}`,
    sql`DELETE FROM terminal_frames WHERE session_id=${terminal.id} AND direction='out' AND seq<=${outputSeq-256}`
   );await commitAll(writes);
   terminal.input_ack=inputAck;terminal.output_seq=outputSeq;
  }
  // The browser/admin can close a shell while this request is processing other
  // reports. Re-read state and guarded input in one D1 transaction, including
  // when the agent did not submit a report for this session. Never dispatch
  // buffered commands using the earlier session selection's stale open state.
  const currentAt=now(),dispatchGuard=terminalWriteGuard('t',currentAt),[currentRows,inputRows]=await commitAll([
   sql`SELECT t.*,CASE WHEN ${dispatchGuard} THEN 1 ELSE 0 END AS is_live FROM terminal_sessions t WHERE t.id=${terminal.id} AND t.server_id=${d.id}`,
   sql`SELECT f.seq,f.data FROM terminal_frames f JOIN terminal_sessions t ON t.id=f.session_id JOIN servers s ON s.id=t.server_id WHERE t.id=${terminal.id} AND t.server_id=${d.id} AND s.revoked=0 AND t.state IN ('opening','open') AND t.expires_at>${currentAt} AND t.last_activity>=${currentAt-TERMINAL_PRESENCE_GRACE_MS} AND ${dispatchGuard} AND f.direction='in' AND f.seq>t.input_ack ORDER BY f.seq LIMIT 64`
  ]);
  const current=currentRows.rows[0] as (TerminalSession&{is_live:number})|undefined;
  if(!current||current.is_live!==1||!terminalIsActive(current,currentAt)){
   if(current&&['opening','open'].includes(current.state))await sweepTerminalSessions(d.id,currentAt);
   await releaseLease(String(terminal.id));terminalCommands.push({...closedTerminal(String(terminal.id),current?.output_seq??Number(terminal.output_seq)),state:current?.state==='error'?'error':'closed'});continue;
  }
  const input=inputRows.rows as {seq:number;data:string}[];
  terminalCommands.push({id:current.id,state:current.state,cols:current.cols,rows:current.rows,expiresAt:new Date(current.expires_at).toISOString(),input:input.map(frame=>({seq:frame.seq,...JSON.parse(frame.data)})),outputAck:current.output_seq});
 }
 // A browser close/expiry can happen while the agent is still reporting its
 // shell. Explicit closures plus an authoritative list release only that shell;
 // a never-known ID receives no buffered inputs and cannot recreate a session.
 terminalCommands.sort((a,b)=>Number(['opening','open'].includes(b.state))-Number(['opening','open'].includes(a.state)));
 for(const report of reports){
  if(terminalCommands.some(command=>command.id===report.id)||terminalCommands.length>=8)continue;
  const stored=await db().one<{output_seq:number}>(sql`SELECT output_seq FROM terminal_sessions WHERE id=${report.id} AND server_id=${d.id}`);
  terminalCommands.push(closedTerminal(report.id,stored?.output_seq??0));
 }

 return terminalCommands;
}
