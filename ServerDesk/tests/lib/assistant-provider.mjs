// The provider layer of the device assistant against a fake HTTPS server for
// the fixed hosts api.anthropic.com and api.openai.com: the request headers and
// bodies of both providers (no sampling fields, adaptive thinking, medium
// effort, the tool list), the tool round trips with the Anthropic assistant
// content (thinking blocks included) sent back unchanged, the stop after 8
// tool rounds with one final call that forbids tools, error results for an
// unknown tool or broken input, the mapping of statuses and bodies to every
// reason, the timeout, the model check of "Test key", and that the key never
// shows in an error or a log line. No database.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {fakeAssistantProviders,assistantOptions} from '../support/fake-assistant-providers.mjs';
const provider=await import('../../lib/server/devices/assistant-provider.ts');
const {assistantToolNames}=await import('../../lib/assistant-config.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const fake=await fakeAssistantProviders();
provider.useAssistantTransportOptions(assistantOptions(fake.port));
const anthropicKey='sk-ant-api03-SECRETanthropic0000000000KEY1',openaiKey='sk-proj-SECRETopenai00000000000000KEY2';
const anthropic={provider:'anthropic',model:'claude-opus-5-5',key:anthropicKey},openai={provider:'openai',model:'gpt-5',key:openaiKey};
const tools=[{name:'device_overview',description:'Summary.',inputSchema:{type:'object',properties:{},additionalProperties:false}},{name:'device_services',description:'Services.',inputSchema:{type:'object',properties:{filter:{type:'string'}},additionalProperties:false}}];
const ran=[];
const run=async(name,input)=>{ran.push([name,input]);return assistantToolNames.includes(name)?{content:JSON.stringify({name,ok:true}),isError:false}:{content:JSON.stringify({error:'unknownTool'}),isError:true};};
const input=(extra={})=>({system:'Rules.',history:[{question:'Earlier?',answer:'Earlier answer.'}],question:'Why is it slow?',tools,run,...extra});
const logged=[];
for(const method of ['log','warn','error','info'])console[method]=(...args)=>{logged.push(args.map(String).join(' '));};
const reason=async(promise)=>{try{await promise;return 'resolved';}catch(error){
 const text=`${error.message} ${error.stack} ${JSON.stringify(error)}`;
 assert.ok(!text.includes(anthropicKey)&&!text.includes(openaiKey),'the key is never in an error');checks++;
 return error instanceof provider.AssistantProviderError?error.reason:`other:${error.message}`;}};
const text=value=>({id:'msg',type:'message',role:'assistant',content:[{type:'text',text:value}],stop_reason:'end_turn'});
const openaiText=value=>({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:value,refusal:null}}]});

try{
 // ---- Anthropic request shape ----
 fake.on('api.anthropic.com',()=>[200,text('The device is fine.')]);
 const plain=await provider.askProvider(anthropic,input());
 check(plain,{answer:'The device is fine.',calls:[]},'a final answer without tools');
 const [first]=fake.of('api.anthropic.com');
 check([first.method,first.path,first.headers['x-api-key'],first.headers['anthropic-version'],first.headers['content-type'],first.headers.host],['POST','/v1/messages',anthropicKey,'2023-06-01','application/json','api.anthropic.com'],'Anthropic headers');
 check(Object.keys(first.json).sort(),['max_tokens','messages','model','output_config','system','thinking','tool_choice','tools'],'Anthropic body fields, no sampling fields');
 check([first.json.model,first.json.max_tokens,first.json.system,first.json.thinking,first.json.output_config,first.json.tool_choice],['claude-opus-5-5',16000,'Rules.',{type:'adaptive'},{effort:'medium'},{type:'auto'}],'model, tokens, system, adaptive thinking, medium effort, tool_choice auto');
 check(first.json.tools.map(tool=>[tool.name,tool.input_schema.type]),[['device_overview','object'],['device_services','object']],'the tools are listed');
 check(first.json.messages,[{role:'user',content:'Earlier?'},{role:'assistant',content:'Earlier answer.'},{role:'user',content:'Why is it slow?'}],'earlier turns as plain text, then the question');
 ok(!('temperature' in first.json)&&!('top_p' in first.json)&&!('top_k' in first.json),'no temperature, top_p or top_k');

 // ---- Anthropic tool round trip with thinking blocks ----
 fake.reset();ran.length=0;
 const thinking={type:'thinking',thinking:'',signature:'EqQBCkYIBhgCKkD+sig/with==chars'};
 const toolContent=[thinking,{type:'text',text:'I read the overview.'},{type:'tool_use',id:'toolu_1',name:'device_overview',input:{}},{type:'tool_use',id:'toolu_2',name:'device_nothing',input:{}}];
 fake.on('api.anthropic.com',(_entry,count)=>count===1?[200,{id:'m1',type:'message',role:'assistant',content:toolContent,stop_reason:'tool_use'}]:[200,text('Answer after tools.')]);
 const looped=await provider.askProvider(anthropic,input());
 check(looped,{answer:'Answer after tools.',calls:['device_overview']},'the answer and the tool that ran');
 check(ran,[['device_overview',{}],['device_nothing',{}]],'both calls reach the runner');
 const second=fake.of('api.anthropic.com')[1].json;
 check(second.messages.at(-2),{role:'assistant',content:toolContent},'the assistant content goes back unchanged');
 check(JSON.stringify(second.messages.at(-2).content[0]),JSON.stringify(thinking),'the thinking block is byte-identical');
 check(second.messages.at(-1),{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_1',content:JSON.stringify({name:'device_overview',ok:true})},{type:'tool_result',tool_use_id:'toolu_2',content:JSON.stringify({error:'unknownTool'}),is_error:true}]},'all tool results in one user message; the unknown tool is an is_error result');
 check(second.tool_choice,{type:'auto'},'tools stay offered in the loop');

 // ---- 8 rounds, then one final call without tools ----
 fake.reset();ran.length=0;
 fake.on('api.anthropic.com',entry=>entry.json.tool_choice.type==='none'?[200,text('Final without tools.')]:[200,{id:'m',type:'message',role:'assistant',content:[{type:'tool_use',id:`toolu_${Math.random()}`,name:'device_services',input:{filter:'sql'}}],stop_reason:'tool_use'}]);
 const capped=await provider.askProvider(anthropic,input());
 const calls=fake.of('api.anthropic.com');
 check([calls.length,calls.slice(0,8).every(call=>call.json.tool_choice.type==='auto'),calls[8].json.tool_choice,capped.answer,ran.length],[9,true,{type:'none'},'Final without tools.',8],'8 tool rounds, then a ninth call with tool_choice none');

 // ---- Anthropic refusal and error mapping ----
 fake.on('api.anthropic.com',()=>[200,{id:'m',type:'message',role:'assistant',content:[],stop_reason:'refusal'}]);
 check(await reason(provider.askProvider(anthropic,input())),'refused','stop_reason refusal');
 const anthropicCases=[[401,{type:'error',error:{type:'authentication_error',message:'invalid x-api-key'}},'keyRejected'],[403,{type:'error',error:{type:'permission_error'}},'keyRejected'],[404,{type:'error',error:{type:'not_found_error',message:'model: x'}},'modelNotFound'],
  [400,{type:'error',error:{type:'invalid_request_error',message:'Your credit balance is too low to access the Anthropic API.'}},'quotaExceeded'],[429,{type:'error',error:{type:'rate_limit_error'}},'providerRateLimited'],[500,{type:'error',error:{type:'api_error'}},'providerUnavailable'],
  [529,{type:'error',error:{type:'overloaded_error'}},'providerUnavailable'],[400,{type:'error',error:{type:'invalid_request_error',message:'thinking is not supported'}},'requestRejected'],[302,'moved','providerUnavailable'],[200,'not json','providerUnavailable']];
 for(const [status,body,expected] of anthropicCases){fake.on('api.anthropic.com',()=>[status,body]);check(await reason(provider.askProvider(anthropic,input())),expected,`Anthropic ${status} ${JSON.stringify(body).slice(0,40)} → ${expected}`);}

 // ---- OpenAI request shape and tool calls ----
 fake.reset();ran.length=0;
 fake.on('api.openai.com',(_entry,count)=>count===1?[200,{choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,refusal:null,tool_calls:[{id:'call_1',type:'function',function:{name:'device_services',arguments:'{"filter":"spool"}'}},{id:'call_2',type:'function',function:{name:'device_overview',arguments:'{broken'}}]}}]}]:[200,openaiText('OpenAI answer.')]);
 const openaiResult=await provider.askProvider(openai,input());
 check(openaiResult,{answer:'OpenAI answer.',calls:['device_services']},'the OpenAI answer and the tool that ran');
 check(ran,[['device_services',{filter:'spool'}]],'broken JSON arguments never reach the runner');
 const [o1,o2]=fake.of('api.openai.com');
 check([o1.method,o1.path,o1.headers.authorization,o1.headers['x-api-key']],['POST','/v1/chat/completions',`Bearer ${openaiKey}`,undefined],'OpenAI headers');
 check(Object.keys(o1.json).sort(),['max_completion_tokens','messages','model','tool_choice','tools'],'OpenAI body fields');
 check([o1.json.model,o1.json.max_completion_tokens,o1.json.tool_choice,o1.json.messages[0],o1.json.messages.at(-1)],['gpt-5',16000,'auto',{role:'system',content:'Rules.'},{role:'user',content:'Why is it slow?'}],'model, tokens, tool_choice, system and question');
 check(o1.json.tools.map(tool=>[tool.type,tool.function.name,tool.function.parameters.type]),[['function','device_overview','object'],['function','device_services','object']],'tools of type function');
 check(o2.json.messages.slice(-3).map(message=>[message.role,message.tool_call_id??null,!!message.tool_calls]),[['assistant',null,true],['tool','call_1',false],['tool','call_2',false]],'the assistant message with tool_calls, then one tool message per call');
 ok(JSON.parse(o2.json.messages.at(-1).content).error,'the broken call gets an error tool message');
 fake.reset();
 fake.on('api.openai.com',entry=>entry.json.tool_choice==='none'?[200,openaiText('Final.')]:[200,{choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'c',type:'function',function:{name:'device_overview',arguments:'{}'}}]}}]}]);
 await provider.askProvider(openai,input());
 check(fake.of('api.openai.com').length,9,'OpenAI stops after 8 rounds too');
 fake.on('api.openai.com',()=>[200,{choices:[{message:{role:'assistant',content:null,refusal:'I cannot help with that.'}}]}]);
 check(await reason(provider.askProvider(openai,input())),'refused','an OpenAI refusal');
 const openaiCases=[[401,{error:{code:'invalid_api_key'}},'keyRejected'],[403,{error:{}},'keyRejected'],[404,{error:{code:'model_not_found'}},'modelNotFound'],[400,{error:{code:'model_not_found'}},'modelNotFound'],
  [429,{error:{code:'insufficient_quota',type:'insufficient_quota'}},'quotaExceeded'],[429,{error:{code:'rate_limit_exceeded'}},'providerRateLimited'],[503,{error:{}},'providerUnavailable'],[400,{error:{code:'invalid_value'}},'requestRejected']];
 for(const [status,body,expected] of openaiCases){fake.on('api.openai.com',()=>[status,body]);check(await reason(provider.askProvider(openai,input())),expected,`OpenAI ${status} ${JSON.stringify(body)} → ${expected}`);}

 // ---- Timeout, DNS and connect failures ----
 fake.on('api.anthropic.com',()=>'hang');
 provider.useAssistantTransportOptions(assistantOptions(fake.port,{totalMs:300}));
 check(await reason(provider.askProvider(anthropic,input())),'providerUnavailable','a timeout');
 provider.useAssistantTransportOptions(assistantOptions(fake.port,{resolver:async()=>{throw new Error('ENOTFOUND');}}));
 check(await reason(provider.askProvider(anthropic,input())),'providerUnavailable','a DNS failure');
 provider.useAssistantTransportOptions(assistantOptions(1));
 check(await reason(provider.askProvider(anthropic,input())),'providerUnavailable','a connect failure');
 provider.useAssistantTransportOptions(assistantOptions(fake.port));

 // ---- The model check of "Test key" ----
 fake.reset();
 fake.on('api.anthropic.com',entry=>entry.path==='/v1/models/claude-opus-5-5'?[200,{id:'claude-opus-5-5',type:'model'}]:[404,{type:'error',error:{type:'not_found_error'}}]);
 check(await reason(provider.checkProviderModel(anthropic)),'resolved','the Anthropic model exists');
 const model=fake.of('api.anthropic.com')[0];
 check([model.method,model.path,model.headers['x-api-key'],model.headers['anthropic-version'],model.body,model.headers['content-length']],['GET','/v1/models/claude-opus-5-5',anthropicKey,'2023-06-01','',undefined],'GET with x-api-key and the version, no body');
 check(await reason(provider.checkProviderModel({...anthropic,model:'claude-none'})),'modelNotFound','an unknown Anthropic model');
 fake.on('api.openai.com',entry=>entry.headers.authorization!==`Bearer ${openaiKey}`?[401,{error:{code:'invalid_api_key'}}]:entry.path==='/v1/models/gpt-5'?[200,{id:'gpt-5',object:'model'}]:[404,{error:{code:'model_not_found'}}]);
 check(await reason(provider.checkProviderModel(openai)),'resolved','the OpenAI model exists');
 check(fake.of('api.openai.com').at(-1).headers.authorization,`Bearer ${openaiKey}`,'OpenAI model check with the bearer key');
 check(await reason(provider.checkProviderModel({...openai,model:'ft:gpt-5:org::abc'})),'modelNotFound','an unknown OpenAI model');
 check(fake.of('api.openai.com').at(-1).path,'/v1/models/ft%3Agpt-5%3Aorg%3A%3Aabc','the model is URL-encoded');
 check(await reason(provider.checkProviderModel({...openai,key:'sk-wrong-key-0000000000000'})),'keyRejected','a rejected key');

 check(logged.filter(line=>line.includes(anthropicKey)||line.includes(openaiKey)),[],'no log line carries a key');
 check(provider.assistantFailureReasons.map(provider.assistantErrorKey),['apiError.assistant.keyRejected','apiError.assistant.modelNotFound','apiError.assistant.quotaExceeded','apiError.assistant.providerRateLimited','apiError.assistant.providerUnavailable','apiError.assistant.requestRejected','apiError.assistant.refused'],'every reason has its catalog key');
}finally{await fake.close();}
process.stdout.write(`PASS assistant provider (${checks} assertions): request shapes, tool loop with unchanged thinking blocks, 8-round stop, error mapping, timeout, model check, no key in errors or logs.\n`);
