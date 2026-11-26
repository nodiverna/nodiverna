// Agent job result messages. Plain module without server imports:
// API routes, client components and tests use it. Agent 4.8.0 and later send
// a message code and arguments next to the English text; the portal shows the
// catalog text agentMessage.<code> in the user's language. A result without a
// code (older agent), an unknown code (newer agent) or a missing argument shows
// the stored text, through storedMessageText (lib/server-messages.ts): a stored
// serverMessage key shows its catalog text, anything else stays as it is.
import en from './i18n/messages/en';
import type {MessageKey,MessageParams} from './i18n/translate';
import {storedMessageText} from './server-messages';

/**
 * Code format, the same as in agent/v3/AgentMessages.cs: AGENT_ for the agent's
 * own messages, PLUGIN_ for the messages of an agent plugin, which the broker
 * passes through unchanged (docs/agent-plugins.md).
 */
export const AGENT_CODE_PATTERN=/^(?:AGENT|PLUGIN)_[A-Z0-9_]{1,60}$/;
/** Argument names: start with a lowercase letter, letters and digits only. */
export const AGENT_ARG_NAME_PATTERN=/^[a-z][A-Za-z0-9]{0,31}$/;
export const AGENT_MAX_ARGS=8;
export const AGENT_MAX_ARG_LENGTH=1000;

export type AgentMessageArgs=Readonly<Record<string,string>>;
/** The part of a job or runbook step that the resolver reads. */
export type AgentResult={result:string|null;resultCode?:string|null;resultArgs?:AgentMessageArgs|null};
export type AgentTranslate=(key:MessageKey,params?:MessageParams)=>string;

const catalog:Readonly<Record<string,string|{one:string;other:string}>>=en;
const placeholders=(text:string)=>[...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]);

/** True for a plain object with at most eight valid names and string values of at most 1000 characters. */
export function validAgentArgs(value:unknown):value is AgentMessageArgs{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const entries=Object.entries(value);
 return entries.length<=AGENT_MAX_ARGS&&entries.every(([name,text])=>AGENT_ARG_NAME_PATTERN.test(name)&&typeof text==='string'&&text.length<=AGENT_MAX_ARG_LENGTH);
}

/** The stored result_args column as an object, or null when it is empty or malformed. */
export function parseAgentArgs(text:unknown):AgentMessageArgs|null{
 if(typeof text!=='string'||!text)return null;
 try{const value:unknown=JSON.parse(text);return validAgentArgs(value)?value:null;}catch{return null;}
}

/** resultCode and resultArgs of a job row with the columns result_code and result_args. */
export function agentResultFields(row:{result_code?:unknown;result_args?:unknown}):{resultCode:string|null;resultArgs:AgentMessageArgs|null}{
 const code=typeof row.result_code==='string'&&AGENT_CODE_PATTERN.test(row.result_code)?row.result_code:null;
 return {resultCode:code,resultArgs:code?parseAgentArgs(row.result_args):null};
}

/**
 * The text to show for a job result. With a known code and a value for every
 * placeholder it is the translated catalog text; otherwise the stored result,
 * with a stored serverMessage key resolved.
 */
export function agentMessageText(job:AgentResult,t:AgentTranslate):string|null{
 return codedText(job,t)??storedMessageText(job.result,t);
}

/**
 * The text of a failed job in a toast that must never show raw agent text: the
 * catalog text of a known code, else the catalog text of a stored
 * serverMessage.* or apiError.* key, else the catalog text of `fallback`. A
 * stored result that is plain text (an older agent's exception text, such as
 * "The node already has a parent.") is never shown.
 */
export function agentMessageTextOr(job:AgentResult,t:AgentTranslate,fallback:MessageKey):string{
 const coded=codedText(job,t);if(coded!==null)return coded;
 const stored=storedMessageText(job.result,t);
 return typeof stored==='string'&&stored!==job.result?stored:t(fallback);
}

/** The translated catalog text of a known code with a value for every placeholder, else null. */
function codedText(job:AgentResult,t:AgentTranslate):string|null{
 const {resultCode:code,resultArgs:args}=job;
 if(!code||!AGENT_CODE_PATTERN.test(code))return null;
 const key=`agentMessage.${code}`;
 if(!Object.hasOwn(catalog,key))return null;
 const message=catalog[key],forms=typeof message==='string'?[message]:[message.one,message.other];
 const values=args??{};
 if(forms.flatMap(placeholders).some(name=>!Object.hasOwn(values,name)))return null;
 return t(key as MessageKey,values);
}
