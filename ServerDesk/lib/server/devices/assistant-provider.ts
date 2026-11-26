// The provider layer of the device assistant (docs/ai-assistant.md): one
// client per provider (Anthropic Messages API, OpenAI Chat Completions) behind
// one adapter shape, and the tool loop that both share. Every call goes
// through the notification transport (lib/server/notifications/notify/transport.ts) to a fixed host,
// so the target check, DNS pinning, the refusal of redirects and the limits
// apply; no URL comes from a user. The tools are given by the caller as specs
// plus one runner, so a later version adds tools without a change here.
// Every failure is one AssistantProviderError with a reason; its catalog key
// is apiError.assistant.<reason>. No error, log line or result carries the key
// or a provider error body.
import {httpsRequest,type HttpResult,type TransportOptions} from '../notifications/notify/transport';
import type {AssistantProvider} from '../../assistant-config';

export type AssistantFailureReason='keyRejected'|'modelNotFound'|'quotaExceeded'|'providerRateLimited'|'providerUnavailable'|'requestRejected'|'refused';
export const assistantFailureReasons:readonly AssistantFailureReason[]=['keyRejected','modelNotFound','quotaExceeded','providerRateLimited','providerUnavailable','requestRejected','refused'];
export type AssistantErrorKey=`apiError.assistant.${AssistantFailureReason}`;
export const assistantErrorKey=(reason:AssistantFailureReason):AssistantErrorKey=>`apiError.assistant.${reason}`;
/** A failed provider call. The message is the catalog key; nothing in it comes from the provider. */
export class AssistantProviderError extends Error{
 readonly reason:AssistantFailureReason;
 constructor(reason:AssistantFailureReason){super(assistantErrorKey(reason));this.name='AssistantProviderError';this.reason=reason;}
}

export const assistantProviderHosts:Readonly<Record<AssistantProvider,string>>={anthropic:'api.anthropic.com',openai:'api.openai.com'};
/** 120 s per call, 10 s to connect, 1 MiB per answer, 8 MiB per request, 16,000 output tokens, 8 tool rounds. */
export const assistantProviderLimits={totalMs:120_000,connectMs:10_000,responseBytes:1024*1024,requestBytes:8*1024*1024,maxTokens:16_000,toolRounds:8};
export const anthropicVersion='2023-06-01';
const userAgent='Nodiverna-Assistant';

let override:TransportOptions|null=null;
/** Tests only: transport options for every provider call (fake hosts, trusted test certificates). */
export function useAssistantTransportOptions(options:TransportOptions|null){override=options;}
const transportOptions=():TransportOptions=>({connectMs:assistantProviderLimits.connectMs,totalMs:assistantProviderLimits.totalMs,responseBytes:assistantProviderLimits.responseBytes,...override});

export type ProviderCredentials={provider:AssistantProvider;model:string;key:string};
/** A tool as the model sees it: a name, one description and a JSON schema of its input. */
export type ToolSpec={name:string;description:string;inputSchema:Record<string,unknown>};
/** The outcome of one tool call: JSON text for the model; isError marks a refused name or input. */
export type ToolOutcome={content:string;isError:boolean};
/** Runs one tool call. It validates the name and the input itself and never throws for either. */
export type ToolRunner=(name:string,input:unknown)=>Promise<ToolOutcome>;
export type HistoryPair={question:string;answer:string};
export type AskInput={system:string;history:readonly HistoryPair[];question:string;tools:readonly ToolSpec[];run:ToolRunner};
/** The answer text and every tool call that ran without an error, in call order. */
export type AskResult={answer:string;calls:string[]};

// ---- HTTPS -------------------------------------------------------------------------

async function call(credentials:ProviderCredentials,method:'GET'|'POST',path:string,headers:Record<string,string>,body?:unknown):Promise<{status:number;json:unknown}>{
 let result:HttpResult;
 const text=body===undefined?undefined:JSON.stringify(body);
 try{
  result=await httpsRequest({url:`https://${assistantProviderHosts[credentials.provider]}${path}`,method,body:text,headers:{...headers,Accept:'application/json',...(text===undefined?{}:{'Content-Type':'application/json'})},maxBodyBytes:assistantProviderLimits.requestBytes,readBody:true,userAgent},transportOptions());
 }catch{
  // DNS, connect, TLS, timeout, redirect, a refused target and an oversized request (NotifyError).
  throw new AssistantProviderError('providerUnavailable');
 }
 let json:unknown=null;
 if(!result.truncated){try{json=JSON.parse(result.body??'');}catch{json=null;}}
 if(result.status>=200&&result.status<300&&(json===null||typeof json!=='object'))throw new AssistantProviderError('providerUnavailable');
 return {status:result.status,json};
}
const field=(value:unknown,...path:string[]):unknown=>path.reduce<unknown>((current,key)=>current!==null&&typeof current==='object'?(current as Record<string,unknown>)[key]:undefined,value);
const textOf=(value:unknown)=>typeof value==='string'?value:'';

/**
 * The reason of an Anthropic answer that is no success: 401 and 403 keyRejected,
 * 404 modelNotFound, 400 with a credit balance message quotaExceeded, 429
 * providerRateLimited, 5xx and 529 providerUnavailable, any other status
 * requestRejected.
 */
export function anthropicFailure(status:number,body:unknown):AssistantProviderError{
 if(status===401||status===403)return new AssistantProviderError('keyRejected');
 if(status===404||field(body,'error','type')==='not_found_error')return new AssistantProviderError('modelNotFound');
 if(status===400&&/credit balance/i.test(textOf(field(body,'error','message'))))return new AssistantProviderError('quotaExceeded');
 if(status===429)return new AssistantProviderError('providerRateLimited');
 if(status>=500||status<200||status>=300&&status<400)return new AssistantProviderError('providerUnavailable');
 return new AssistantProviderError('requestRejected');
}
/**
 * The reason of an OpenAI answer that is no success: 401 and 403 keyRejected,
 * 404 or the code model_not_found modelNotFound, 429 with insufficient_quota
 * quotaExceeded, another 429 providerRateLimited, 5xx providerUnavailable, any
 * other status requestRejected.
 */
export function openaiFailure(status:number,body:unknown):AssistantProviderError{
 const code=field(body,'error','code'),type=field(body,'error','type');
 if(status===401||status===403)return new AssistantProviderError('keyRejected');
 if(status===404||code==='model_not_found')return new AssistantProviderError('modelNotFound');
 if(status===429&&(code==='insufficient_quota'||type==='insufficient_quota'))return new AssistantProviderError('quotaExceeded');
 if(status===429)return new AssistantProviderError('providerRateLimited');
 if(status>=500||status<200||status>=300&&status<400)return new AssistantProviderError('providerUnavailable');
 return new AssistantProviderError('requestRejected');
}
const failureOf=(provider:AssistantProvider,status:number,body:unknown)=>provider==='anthropic'?anthropicFailure(status,body):openaiFailure(status,body);

const anthropicHeaders=(key:string)=>({'x-api-key':key,'anthropic-version':anthropicVersion});
const openaiHeaders=(key:string)=>({Authorization:`Bearer ${key}`});

/**
 * "Test key": the model endpoint of the provider for the key and the model. It
 * uses no tokens and stores nothing. Resolves on 200; otherwise throws the
 * mapped reason.
 */
export async function checkProviderModel(credentials:ProviderCredentials):Promise<void>{
 const path=`/v1/models/${encodeURIComponent(credentials.model)}`;
 const {status,json}=await call(credentials,'GET',path,credentials.provider==='anthropic'?anthropicHeaders(credentials.key):openaiHeaders(credentials.key));
 if(status!==200)throw failureOf(credentials.provider,status,json);
}

// ---- Adapters ----------------------------------------------------------------------

type ToolCall={id:string;name:string;input:unknown;inputValid:boolean};
type Turn={kind:'final';text:string}|{kind:'tools';calls:ToolCall[];assistant:unknown};
type Adapter={
 /** One model call with the tools offered (auto) or held back (none). */
 send(withTools:boolean):Promise<Turn>;
 /** Appends the assistant turn and the outcomes of its tool calls, in call order. */
 append(assistant:unknown,results:{call:ToolCall;outcome:ToolOutcome}[]):void;
};

function anthropicAdapter(credentials:ProviderCredentials,input:AskInput):Adapter{
 const messages:unknown[]=[...input.history.flatMap(pair=>[{role:'user',content:pair.question},{role:'assistant',content:pair.answer}]),{role:'user',content:input.question}];
 const tools=input.tools.map(tool=>({name:tool.name,description:tool.description,input_schema:tool.inputSchema}));
 return {
  async send(withTools){
   // The final call keeps the tool list, because the history holds tool_use
   // blocks, and forbids new calls with tool_choice none.
   const body={model:credentials.model,max_tokens:assistantProviderLimits.maxTokens,system:input.system,tools,tool_choice:{type:withTools?'auto':'none'},thinking:{type:'adaptive'},output_config:{effort:'medium'},messages};
   const {status,json}=await call(credentials,'POST','/v1/messages',anthropicHeaders(credentials.key),body);
   if(status!==200)throw anthropicFailure(status,json);
   if(field(json,'stop_reason')==='refusal')throw new AssistantProviderError('refused');
   const content=field(json,'content');
   if(!Array.isArray(content))throw new AssistantProviderError('providerUnavailable');
   const uses=content.filter(block=>field(block,'type')==='tool_use');
   if(field(json,'stop_reason')==='tool_use'&&uses.length&&withTools)return {kind:'tools',assistant:content,calls:uses.map(block=>({id:textOf(field(block,'id')),name:textOf(field(block,'name')),input:field(block,'input'),inputValid:true}))};
   return {kind:'final',text:content.filter(block=>field(block,'type')==='text').map(block=>textOf(field(block,'text'))).join('\n\n').trim()};
  },
  append(assistant,results){
   // The assistant content goes back exactly as it came, thinking blocks included.
   messages.push({role:'assistant',content:assistant},{role:'user',content:results.map(({call,outcome})=>({type:'tool_result',tool_use_id:call.id,content:outcome.content,...(outcome.isError?{is_error:true}:{})}))});
  },
 };
}

function openaiAdapter(credentials:ProviderCredentials,input:AskInput):Adapter{
 const messages:unknown[]=[{role:'system',content:input.system},...input.history.flatMap(pair=>[{role:'user',content:pair.question},{role:'assistant',content:pair.answer}]),{role:'user',content:input.question}];
 const tools=input.tools.map(tool=>({type:'function',function:{name:tool.name,description:tool.description,parameters:tool.inputSchema}}));
 return {
  async send(withTools){
   const body={model:credentials.model,messages,tools,tool_choice:withTools?'auto':'none',max_completion_tokens:assistantProviderLimits.maxTokens};
   const {status,json}=await call(credentials,'POST','/v1/chat/completions',openaiHeaders(credentials.key),body);
   if(status!==200)throw openaiFailure(status,json);
   const message=field(json,'choices','0','message');
   if(!message||typeof message!=='object')throw new AssistantProviderError('providerUnavailable');
   if(textOf(field(message,'refusal')))throw new AssistantProviderError('refused');
   const calls=field(message,'tool_calls');
   if(withTools&&Array.isArray(calls)&&calls.length)return {kind:'tools',assistant:message,calls:calls.map(entry=>{
    const text=textOf(field(entry,'function','arguments'));let parsed:unknown,inputValid=true;
    try{parsed=text?JSON.parse(text):{};}catch{parsed=undefined;inputValid=false;}
    return {id:textOf(field(entry,'id')),name:textOf(field(entry,'function','name')),input:parsed,inputValid};
   })};
   return {kind:'final',text:textOf(field(message,'content')).trim()};
  },
  append(assistant,results){
   messages.push(assistant,...results.map(({call,outcome})=>({role:'tool',tool_call_id:call.id,content:outcome.isError?JSON.stringify({error:true,...safeJson(outcome.content)}):outcome.content})));
  },
 };
}
const safeJson=(text:string):Record<string,unknown>=>{try{const value:unknown=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{message:text};}catch{return {message:text};}};
const invalidInput:ToolOutcome={content:JSON.stringify({error:'invalidInput',message:'The tool input is not valid JSON.'}),isError:true};

/**
 * The tool loop: at most 8 rounds in which the model may call tools, then one
 * more call that forbids tools and asks for the final answer. A tool call with
 * an unknown name or an invalid input gets an error result from the runner
 * and the loop goes on. Throws AssistantProviderError.
 */
export async function askProvider(credentials:ProviderCredentials,input:AskInput):Promise<AskResult>{
 const adapter=credentials.provider==='anthropic'?anthropicAdapter(credentials,input):openaiAdapter(credentials,input);
 const calls:string[]=[];
 for(let round=0;round<assistantProviderLimits.toolRounds;round++){
  const turn=await adapter.send(true);
  if(turn.kind==='final')return {answer:turn.text,calls};
  const results=[];
  for(const toolCall of turn.calls){
   const outcome=toolCall.inputValid?await input.run(toolCall.name,toolCall.input):invalidInput;
   if(!outcome.isError)calls.push(toolCall.name);
   results.push({call:toolCall,outcome});
  }
  adapter.append(turn.assistant,results);
 }
 const last=await adapter.send(false);
 return {answer:last.kind==='final'?last.text:'',calls};
}
