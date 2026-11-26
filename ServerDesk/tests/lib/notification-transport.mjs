// The one way out for notifications (lib/server/notifications/notify/transport.ts) without a
// database: the target check (loopback, link-local, metadata, IPv4-mapped forms,
// private ranges with and without NOTIFY_ALLOW_PRIVATE_TARGETS), a host with one
// public and one private address, DNS pinning against a second answer, no
// redirects, the timeout, the retry counts and waits with a fake clock, the body
// limit and the capped response read, the DNS time limit for HTTPS and SMTP,
// the documentation, benchmark, 6to4 and Teredo ranges, and a minimal DER serial
// in the test certificate; the password sign-in errors of SMTP (MFA, basic auth
// off), httpsPost with the answer body, the Microsoft 365 token, its cache and
// Graph sendMail with the 401 re-fetch and the error mapping, and the Google
// service account JWT, its token and XOAUTH2 over implicit TLS, with no secret
// or token in any error. A local HTTPS server with a test
// certificate made at runtime (tests/support/test-certificate.mjs) stands in for the target.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {certificateSerial,testCertificate,testTls} from '../support/test-certificate.mjs';
import https from 'node:https';
import {X509Certificate,verify} from 'node:crypto';
import {fakeSmtp} from '../support/fake-smtp.mjs';
import {fakeProviders,providerOptions,providerTls,serviceAccountKeyFile} from '../support/fake-providers.mjs';
const transport=await import('../../lib/server/notifications/notify/transport.ts');
const {smtpSend}=await import('../../lib/server/notifications/notify/smtp.ts');
const {isAllowedTarget,checkedTarget,httpsPost,withRetry,NotifyError,notifyLimits}=transport;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const tls={key:testTls.key,cert:testTls.cert},ca=testTls.cert;
const failureOf=async promise=>{try{await promise;return null;}catch(error){assert.ok(error instanceof NotifyError,`a NotifyError, got ${error}`);return {reason:error.reason,params:error.params,retryable:error.retryable};}};

// ---- isAllowedTarget ----
{
 for(const address of ['127.0.0.1','127.8.9.1','::1','169.254.169.254','169.254.1.2','[::ffff:169.254.169.254]','::ffff:169.254.169.254','::ffff:a9fe:a9fe','::ffff:127.0.0.1','::169.254.169.254','64:ff9b::169.254.169.254','fd00:ec2::254','0.0.0.0','::','fe80::1','ff02::1','224.0.0.1','255.255.255.255','100.100.100.200','localhost','not-an-ip'])
  check(isAllowedTarget(address),false,`${address} is refused`);
 for(const address of ['127.0.0.1','::1','169.254.169.254','::ffff:169.254.169.254','fd00:ec2::254','0.0.0.0','100.100.100.200'])
  check(isAllowedTarget(address,true),false,`${address} stays refused with private targets allowed`);
 for(const address of ['10.0.0.1','172.16.5.5','172.31.255.255','192.168.1.10','100.64.0.1','fc00::1','fd12:3456::1','::ffff:10.0.0.1'])
  {check(isAllowedTarget(address),false,`${address} is private`);check(isAllowedTarget(address,true),true,`${address} with NOTIFY_ALLOW_PRIVATE_TARGETS`);}
 for(const address of ['93.184.216.34','203.0.114.10','172.32.0.1','2606:4700:4700::1111','::ffff:93.184.216.34'])check(isAllowedTarget(address),true,`${address} is public`);
 // Documentation, benchmarking, 6to4 and Teredo: the start, a sample inside and
 // the end of each range, IPv4 also in its mapped forms, with and without the variable.
 const v4Ranges={'192.0.2.0/24':['192.0.2.0','192.0.2.77','192.0.2.255'],'198.51.100.0/24':['198.51.100.0','198.51.100.9','198.51.100.255'],'203.0.113.0/24':['203.0.113.0','203.0.113.10','203.0.113.255'],
  '198.18.0.0/15':['198.18.0.0','198.19.12.34','198.19.255.255'],'192.88.99.0/24':['192.88.99.0','192.88.99.1','192.88.99.255']};
 const v6Ranges={'2001:db8::/32':['2001:db8::','2001:db8:1234::1','2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],'3fff::/20':['3fff::','3fff:abc:1::1','3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff'],
  '2002::/16':['2002::','2002:c000:204::1','2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],'2001::/32':['2001::','2001:0:4136:e378:8000:63bf:3fff:fdd2','2001:0:ffff:ffff:ffff:ffff:ffff:ffff']};
 for(const [range,addresses] of Object.entries(v4Ranges))for(const address of addresses.flatMap(item=>[item,`::ffff:${item}`,`[::ffff:${item}]`,`64:ff9b::${item}`]))
  {check(isAllowedTarget(address),false,`${address} (${range}) is refused`);check(isAllowedTarget(address,true),false,`${address} (${range}) stays refused with private targets allowed`);}
 for(const [range,addresses] of Object.entries(v6Ranges))for(const address of addresses)
  {check(isAllowedTarget(address),false,`${address} (${range}) is refused`);check(isAllowedTarget(address,true),false,`${address} (${range}) stays refused with private targets allowed`);}
 for(const address of ['198.17.255.255','198.20.0.0','203.0.114.1','203.0.112.255','192.0.3.1','192.88.100.1','198.51.101.1','2001:4860:4860::8888','2606:4700:4700::1111','2001:1::1','2001:db9::1','3fff:1000::1','2003::1','::ffff:198.20.0.0'])
  {check(isAllowedTarget(address),true,`${address} next to the ranges stays allowed`);check(isAllowedTarget(address,true),true,`${address} also with the variable`);}
}

// ---- checkedTarget ----
{
 const resolver=answers=>async()=>answers;
 check(await failureOf(checkedTarget('hooks.example.test',{resolver:resolver([{address:'93.184.216.34',family:4},{address:'10.0.0.5',family:4}])})),{reason:'targetBlocked',params:{},retryable:false},'one private address refuses the host');
 check(await checkedTarget('hooks.example.test',{resolver:resolver([{address:'93.184.216.34',family:4}])}),{address:'93.184.216.34',family:4},'a public host passes with its address');
 check(await checkedTarget('hooks.example.test',{allowPrivate:true,resolver:resolver([{address:'10.0.0.5',family:4}])}),{address:'10.0.0.5',family:4},'a private host with the variable');
 check((await failureOf(checkedTarget('LOCALHOST.',{resolver:resolver([{address:'93.184.216.34',family:4}])}))).reason,'targetBlocked','localhost by name');
 check((await failureOf(checkedTarget('metadata.google.internal',{resolver:resolver([{address:'93.184.216.34',family:4}])}))).reason,'targetBlocked','the metadata host by name');
 check((await failureOf(checkedTarget('127.0.0.1'))).reason,'targetBlocked','an IP literal is checked as it is');
 check((await failureOf(checkedTarget('[::ffff:169.254.169.254]'))).reason,'targetBlocked','a bracketed mapped literal');
 check((await failureOf(checkedTarget('missing.example.test',{resolver:async()=>{throw Object.assign(new Error('getaddrinfo ENOTFOUND'),{code:'ENOTFOUND'});}}))),{reason:'dnsFailed',params:{},retryable:true},'a failed lookup');
 check((await failureOf(checkedTarget('empty.example.test',{resolver:resolver([])}))).reason,'dnsFailed','no address');
 // The DNS time limit: a resolver that never answers fails as dnsFailed after
 // dnsMs, the timer is cleared, and a late answer changes nothing.
 const timers=()=>process.getActiveResourcesInfo().filter(type=>type==='Timeout').length,idle=timers();
 const started=Date.now(),hanging=await failureOf(checkedTarget('slow.example.test',{resolver:()=>new Promise(()=>{}),dnsMs:50}));
 check(hanging,{reason:'dnsFailed',params:{},retryable:true},'a resolver without an answer fails in time');
 assert.ok(Date.now()-started>=45&&Date.now()-started<2000,'it waits about dnsMs');checks++;
 check(timers(),idle,'the timer of the limit is cleared');
 let late=null;
 check((await failureOf(checkedTarget('late.example.test',{resolver:()=>new Promise(resolve=>{late=resolve;}),dnsMs:20}))).reason,'dnsFailed','a late resolver');
 late([{address:'93.184.216.34',family:4}]);
 const quick=await checkedTarget('quick.example.test',{resolver:resolver([{address:'93.184.216.34',family:4}]),dnsMs:50});
 check([quick,timers()],[{address:'93.184.216.34',family:4},idle],'an answer in time passes and clears the timer');
 check(await checkedTarget('93.184.216.34',{resolver:()=>{throw new Error('no lookup for a literal');},dnsMs:1}),{address:'93.184.216.34',family:4},'an IP literal skips the resolver');
 check((await failureOf(checkedTarget('localhost',{resolver:()=>{throw new Error('no lookup for a blocked name');},dnsMs:1}))).reason,'targetBlocked','a blocked name skips the resolver');
}

// ---- The test certificate: a positive, minimal DER serial ----
{
 const serialOf=pem=>{const der=Buffer.from(pem.replace(/-----[^-]+-----|\s/g,''),'base64');
  // Certificate SEQUENCE > tbsCertificate SEQUENCE > [0] version > INTEGER serial.
  let at=0;const skipHeader=()=>{at++;const first=der[at++];if(first&0x80)at+=first&0x7f;};
  skipHeader();skipHeader();at++;at+=1+der[at];assert.equal(der[at],0x02,'the serial is an INTEGER');at++;const length=der[at++];return der.subarray(at,at+length);};
 const minimal=serial=>serial.length>0&&(serial[0]&0x80)===0&&!(serial[0]===0&&serial.length>1&&(serial[1]&0x80)===0);
 let valid=0;
 for(let index=0;index<2000;index++){const serial=certificateSerial();if(minimal(serial)&&serial.length===8)valid++;}
 check(valid,2000,'2000 serials are positive minimal DER INTEGERs');
 check([...certificateSerial(Buffer.from([0x00,0x10,1,2,3,4,5,6]))],[0x01,0x10,1,2,3,4,5,6],'a zero first byte becomes 1');
 check([...certificateSerial(Buffer.from([0xff,0x80,1,2,3,4,5,6]))],[0x7f,0x80,1,2,3,4,5,6],'the top bit is cleared');
 // The bytes that broke 1 of 256 processes before (OpenSSL: ERR_OSSL_ASN1_ILLEGAL_PADDING) now give a valid certificate.
 for(const bytes of [[0x00,0x10,1,2,3,4,5,6],[0x00,0x00,0,0,0,0,0,0],[0x80,0x7f,1,2,3,4,5,6]]){
  const made=testCertificate(undefined,{serialBytes:Buffer.from(bytes)});
  new X509Certificate(made.cert);check(minimal(serialOf(made.cert)),true,`serial ${Buffer.from(bytes).toString('hex')} parses and is minimal`);
 }
 let parsed=0;
 for(let index=0;index<2000;index++){const made=testCertificate();new X509Certificate(made.cert);if(minimal(serialOf(made.cert)))parsed++;}
 check(parsed,2000,'2000 certificates parse with a minimal serial');
}

// ---- A local HTTPS target ----
const seen=[];let behaviour=()=>{};
const server=https.createServer(tls,(request,response)=>{
 const chunks=[];request.on('data',chunk=>chunks.push(chunk));
 request.on('end',()=>{seen.push({host:request.headers.host,servername:request.socket.servername,body:Buffer.concat(chunks).toString(),headers:request.headers});behaviour(request,response);});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port,url=`https://hooks.example.test:${port}/hook/secret-path?token=abc`;
const options=(extra={})=>({ca,resolver:async()=>[{address:'93.184.216.34',family:4}],routeAddress:()=>'127.0.0.1',...extra});
const post=(extra,body='{"a":1}')=>httpsPost({url,body,headers:{'Content-Type':'application/json'},maxBodyBytes:notifyLimits.bodyBytes},options(extra));
try{
 // DNS pinning: the second answer of the resolver would be private; the connection goes to the checked address.
 {
  let calls=0;const routed=[];
  behaviour=(request,response)=>{response.writeHead(204);response.end();};
  const result=await post({resolver:async()=>{calls++;return calls===1?[{address:'93.184.216.34',family:4}]:[{address:'10.0.0.1',family:4}];},routeAddress:address=>{routed.push(address);return '127.0.0.1';}});
  check(result,{status:204},'a 2xx is success');
  check([calls,routed],[1,['93.184.216.34']],'one lookup per attempt; the socket opens the checked address');
  check([seen.at(-1).host,seen.at(-1).servername],[`hooks.example.test:${port}`,'hooks.example.test'],'Host and SNI carry the host name');
  check(seen.at(-1).body,'{"a":1}','the body arrives');
 }
 // A host whose answer is not allowed never connects.
 {
  const before=seen.length;
  check((await failureOf(post({resolver:async()=>[{address:'169.254.169.254',family:4}]}))).reason,'targetBlocked','the metadata address');
  check(seen.length,before,'no request reached the server');
 }
 // Redirects are failures and never followed.
 {
  const before=seen.length;
  behaviour=(request,response)=>{response.writeHead(302,{Location:`https://hooks.example.test:${port}/elsewhere`});response.end();};
  check(await failureOf(post()),{reason:'redirect',params:{},retryable:false},'a 302 is the failure redirect');
  check(seen.length,before+1,'the location is not requested');
 }
 // Status, retry counts and waits with a fake clock.
 {
  // 400 and 422: the target refused the message format (httpRejected), never tried again.
  for(const [status,attempts,waits,retryable,reason] of [[500,3,[1000,4000],true,'httpStatus'],[400,1,[],false,'httpRejected'],[422,1,[],false,'httpRejected'],[429,3,[1000,4000],true,'httpStatus'],[408,3,[1000,4000],true,'httpStatus'],[404,1,[],false,'httpStatus']]){
   const before=seen.length,slept=[];
   behaviour=(request,response)=>{response.writeHead(status);response.end('no');};
   const outcome=await withRetry(()=>post(),{sleep:async ms=>{slept.push(ms);}});
   check([outcome.ok,outcome.attempts,outcome.error.reason,outcome.error.params,outcome.error.retryable,slept,seen.length-before],[false,attempts,reason,{status},retryable,waits,attempts],`status ${status}: ${reason}, ${attempts} attempts`);
  }
  check(transport.notifyFailureReasons.includes('httpRejected'),true,'httpRejected is a failure reason');
  let calls=0;const slept=[];
  behaviour=(request,response)=>{calls++;response.writeHead(calls<2?503:200);response.end();};
  const outcome=await withRetry(()=>post(),{sleep:async ms=>{slept.push(ms);}});
  check([outcome.ok,outcome.attempts,slept],[true,2,[1000]],'a later attempt can succeed');
  const blocked=await withRetry(()=>post({resolver:async()=>[{address:'127.0.0.1',family:4}]}),{sleep:async()=>{throw new Error('no wait');}});
  check([blocked.ok,blocked.attempts,blocked.error.reason],[false,1,'targetBlocked'],'a refused target is not retried');
 }
 // Timeout: the server never answers.
 {
  behaviour=()=>{};
  const started=Date.now(),failure=await failureOf(post({totalMs:300}));
  check(failure,{reason:'timeout',params:{},retryable:true},'no answer in time');
  assert.ok(Date.now()-started<3000,'the attempt ends at the total time');checks++;
 }
 // The body limit: a larger body is never sent.
 {
  const before=seen.length;
  check((await failureOf(httpsPost({url,body:'x'.repeat(30*1024),headers:{},maxBodyBytes:notifyLimits.teamsBodyBytes},options()))).reason,'tooLarge','a body over the limit');
  check(seen.length,before,'nothing was sent');
  check(notifyLimits,{dnsMs:3000,connectMs:5000,totalMs:10_000,bodyBytes:65536,teamsBodyBytes:24576,responseBytes:16384},'the limits');
 }
 // The response read is capped: an endless answer still ends the attempt.
 {
  let written=0;
  behaviour=(request,response)=>{response.writeHead(200);const chunk=Buffer.alloc(8192,97);const timer=setInterval(()=>{if(response.destroyed||written>2_000_000){clearInterval(timer);response.end();return;}written+=chunk.length;response.write(chunk);},2);response.on('close',()=>clearInterval(timer));};
  const started=Date.now(),result=await post({totalMs:5000});
  check(result,{status:200},'an endless answer is read only up to the cap');
  assert.ok(Date.now()-started<2000&&written<500_000,`the client stopped reading early (${written} bytes written)`);checks++;
 }
 // An untrusted certificate fails as tlsFailed; https: only and no user info.
 {
  check((await failureOf(post({ca:undefined}))).reason,'tlsFailed','a certificate outside the trust store');
  check((await failureOf(httpsPost({url:`http://hooks.example.test:${port}/`,body:'',headers:{},maxBodyBytes:100},options()))).reason,'targetBlocked','http: is refused');
  check((await failureOf(httpsPost({url:`https://user:pw@hooks.example.test:${port}/`,body:'',headers:{},maxBodyBytes:100},options()))).reason,'targetBlocked','user info is refused');
  check((await failureOf(httpsPost({url:'https://hooks.example.test:1/',body:'',headers:{},maxBodyBytes:100},options()))).reason,'connectFailed','a closed port');
 }
 // The DNS limit also holds for HTTPS and SMTP: no socket opens, and dnsFailed gets three attempts.
 {
  const before=seen.length,routed=[];
  const failure=await failureOf(post({resolver:()=>new Promise(()=>{}),dnsMs:30,routeAddress:address=>{routed.push(address);return '127.0.0.1';}}));
  check([failure,seen.length-before,routed],[{reason:'dnsFailed',params:{},retryable:true},0,[]],'HTTPS: a hanging lookup opens no socket');
  const slept=[];let lookups=0;
  const outcome=await withRetry(()=>post({resolver:()=>{lookups++;return new Promise(()=>{});},dnsMs:20}),{sleep:async ms=>{slept.push(ms);}});
  check([outcome.ok,outcome.attempts,outcome.error.reason,lookups,slept],[false,3,'dnsFailed',3,[1000,4000]],'dnsFailed gets three attempts with a lookup each');
  const mailRouted=[];
  const mail=await failureOf(smtpSend({host:'smtp.example.test',port:2525,tls:'starttls',from:'a@example.com',recipients:['b@example.com'],username:null,password:null},{subject:'s',text:'t',html:'<p>t</p>',messageId:'m'},{ca,resolver:()=>new Promise(()=>{}),dnsMs:30,routeAddress:address=>{mailRouted.push(address);return '127.0.0.1';}}));
  check([mail,mailRouted],[{reason:'dnsFailed',params:{},retryable:true},[]],'SMTP: a hanging lookup fails as dnsFailed and connects nowhere');
 }
 // Error texts never carry the URL, its path or its query.
 {
  behaviour=(request,response)=>{response.writeHead(500);response.end();};
  try{await post();}catch(error){check([error.message.includes('secret-path'),error.message.includes('token'),error.message],[false,false,'apiError.notify.httpStatus'],'the error message is the catalog key');}
 }
}finally{server.close();}

// ---- Password sign-in: the SMTP reply names MFA and basic auth ----
{
 const {smtpFailure}=await import('../../lib/server/notifications/notify/smtp.ts');
 const replies=[
  ['535 5.7.139 Authentication unsuccessful, basic authentication is disabled. [AM0PR02CA0001.eurprd02.prod.outlook.com]','authBasicDisabled'],
  ['535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.','authBasicDisabled'],
  ['535 5.7.139 Authentication unsuccessful, BASIC AUTHENTICATION IS DISABLED.','authBasicDisabled'],
  ['535 5.7.139 Authentication unsuccessful, the request did not meet the criteria to be authenticated successfully.','authMfaRequired'],
  ['535 5.7.139 Authentication unsuccessful, user is locked by your organization\'s security defaults policy.','authMfaRequired'],
  ['534-5.7.9 Application-specific password required. For more information, go to\n534 5.7.9  https://support.google.com/mail/?p=InvalidSecondFactor','authMfaRequired'],
  ['534-5.7.14 <https://accounts.google.com/signin/continue?sarp=1> Please log in with your web browser','authMfaRequired'],
  ['535 5.7.8 Username and Password not accepted.','authFailed'],
  ['535 5.7.3 Authentication unsuccessful','authFailed'],
  ['535 5.7.140 Something else','authFailed'],
 ];
 for(const [reply,reason] of replies){
  const failure=smtpFailure(Object.assign(new Error('Invalid login'),{code:'EAUTH',responseCode:Number(reply.slice(0,3)),response:reply}));
  check([failure.reason,failure.retryable,failure.params],[reason,false,{}],`${reply.slice(0,40)}… → ${reason}, not retryable`);
 }
 check(smtpFailure(Object.assign(new Error('Invalid login'),{code:'EAUTH'})).reason,'authFailed','EAUTH without a reply');
 check(smtpFailure(Object.assign(new Error('Invalid login'),{code:'EAUTH',response:'535 5.7.139 basic authentication is disabled'}),{oauth:true}).reason,'googleDelegationMissing','EAUTH with the Google sign-in');
 for(const reason of ['authMfaRequired','authBasicDisabled','microsoftSignInRefused','microsoftSecretExpired','microsoftPermissionMissing','googleSignInRefused','googleDelegationMissing','mailboxNotFound'])
  check([transport.notifyFailureReasons.includes(reason),new NotifyError(reason).retryable],[true,false],`${reason} is a reason and not retryable`);
 // Through a real SMTP server: the reply line arrives in the mapping.
 const refusing=await fakeSmtp({starttls:true,auth:{user:'mailer',pass:'right'},authFailure:'535 5.7.139 Authentication unsuccessful, basic authentication is disabled.'});
 try{
  const settings={host:'smtp.example.test',port:refusing.port,tls:'starttls',from:'a@example.com',recipients:['b@example.com'],username:'mailer',password:'wrong'};
  const mailOptions={ca,resolver:async()=>[{address:'93.184.216.34',family:4}],routeAddress:()=>'127.0.0.1'};
  check(await failureOf(smtpSend(settings,{subject:'s',text:'t',html:'<p>t</p>',messageId:'m'},mailOptions)),{reason:'authBasicDisabled',params:{},retryable:false},'a fake server that refuses basic auth');
 }finally{await refusing.close();}
}

// ---- httpsPost with the answer body ----
{
 const bodyServer=https.createServer(tls,(request,response)=>{
  const chunks=[];request.on('data',chunk=>chunks.push(chunk));
  request.on('end',()=>{
   const sent=Buffer.concat(chunks).toString(),type=request.headers['content-type'];
   if(request.url==='/big'){response.writeHead(200);response.end('é'.repeat(20*1024));return;}
   if(request.url==='/refused'){response.writeHead(400,{'Content-Type':'application/json'});response.end('{"error":"invalid_client"}');return;}
   if(request.url==='/moved'){response.writeHead(302,{Location:'https://hooks.example.test/elsewhere'});response.end();return;}
   response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({type,sent}));
  });
 });
 await new Promise(resolve=>bodyServer.listen(0,'127.0.0.1',resolve));
 try{
  const base=`https://hooks.example.test:${bodyServer.address().port}`,routed={ca,resolver:async()=>[{address:'93.184.216.34',family:4}],routeAddress:()=>'127.0.0.1'};
  const form=await httpsPost({url:`${base}/token`,body:'grant_type=client_credentials&a=b',headers:{'Content-Type':'application/x-www-form-urlencoded'},maxBodyBytes:1024,readBody:true},routed);
  check([form.status,JSON.parse(form.body)],[200,{type:'application/x-www-form-urlencoded',sent:'grant_type=client_credentials&a=b'}],'a form body goes out, and the answer body comes back');
  const big=await httpsPost({url:`${base}/big`,body:'',headers:{},maxBodyBytes:1024,readBody:true},routed);
  check([big.status,Buffer.byteLength(big.body)<=notifyLimits.responseBytes,big.body.startsWith('éé')],[200,true,true],'the body is capped at responseBytes');
  const small=await httpsPost({url:`${base}/big`,body:'',headers:{},maxBodyBytes:1024,readBody:true},{...routed,responseBytes:10});
  check(Buffer.from(small.body).length<=10,true,'a smaller responseBytes caps it too');
  check(await httpsPost({url:`${base}/refused`,body:'',headers:{},maxBodyBytes:1024,readBody:true},routed),{status:400,body:'{"error":"invalid_client"}'},'a 400 comes back with its body for the caller to map');
  check(await failureOf(httpsPost({url:`${base}/moved`,body:'',headers:{},maxBodyBytes:1024,readBody:true},routed)),{reason:'redirect',params:{},retryable:false},'a redirect stays a failure with readBody');
  const plain=await httpsPost({url:`${base}/token`,body:'{}',headers:{'Content-Type':'application/json'},maxBodyBytes:1024},routed);
  check([plain,Object.keys(plain)],[{status:200},['status']],'without readBody the result is only the status');
  check(await failureOf(httpsPost({url:`${base}/refused`,body:'',headers:{},maxBodyBytes:1024},routed)),{reason:'httpRejected',params:{status:400},retryable:false},'without readBody a 400 stays httpRejected');
 }finally{bodyServer.close();}
}

// ---- Microsoft 365: token, cache and Graph sendMail ----
const oauth=await import('../../lib/server/notifications/notify/oauth.ts');
const graph=await import('../../lib/server/notifications/notify/graph.ts');
const providers=await fakeProviders();
const secrets=[];
const noSecret=(error,label)=>{const text=JSON.stringify({message:error?.message,params:error?.params});for(const secret of secrets)assert.ok(!text.includes(secret),`${label} carries a secret`);checks++;};
const caught=async promise=>{try{await promise;return null;}catch(error){assert.ok(error instanceof NotifyError,`a NotifyError, got ${error}`);return error;}};
try{
 let now=Date.UTC(2026,10,4,9,0),tokenCount=0;
 const clock=()=>now;
 const options=providerOptions({httpsPort:providers.port,clock});
 const microsoft={tenantId:'contoso.onmicrosoft.com',clientId:'3f2504e0-4f89-11d3-9a0c-0305e82c3301',clientSecret:'Cs~7Qy.secret-value_1'};
 secrets.push(microsoft.clientSecret);
 const tokenAnswer=()=>{tokenCount++;const token=`ms-access-token-${tokenCount}`;secrets.push(token);return [200,{token_type:'Bearer',expires_in:3600,ext_expires_in:3600,access_token:token}];};
 providers.on('login.microsoftonline.com',tokenAnswer);
 oauth.tokenCache.clear();
 const first=await oauth.microsoftToken(microsoft,options);
 const request=providers.of('login.microsoftonline.com').at(-1);
 check([first.token,request.path,request.headers['content-type'],request.form],['ms-access-token-1','/contoso.onmicrosoft.com/oauth2/v2.0/token','application/x-www-form-urlencoded',{grant_type:'client_credentials',client_id:microsoft.clientId,client_secret:microsoft.clientSecret,scope:'https://graph.microsoft.com/.default'}],'the token request: path with the tenant, form fields and scope');
 await oauth.microsoftToken({...microsoft,tenantId:'a/b c'},options);
 check(providers.of('login.microsoftonline.com').at(-1).path,'/a%2Fb%20c/oauth2/v2.0/token','the tenant is URL-encoded');
 oauth.tokenCache.clear();tokenCount=0;
 const calls=()=>providers.of('login.microsoftonline.com').length,start=calls();
 check([(await oauth.microsoftToken(microsoft,options)).token,(await oauth.microsoftToken(microsoft,options)).token,calls()-start],['ms-access-token-1','ms-access-token-1',1],'a second send reuses the cached token');
 now+=3600_000-300_000-1;
 check([(await oauth.microsoftToken(microsoft,options)).token,calls()-start],['ms-access-token-1',1],'still reused while more than 5 minutes remain');
 now+=1;
 check([(await oauth.microsoftToken(microsoft,options)).token,calls()-start],['ms-access-token-2',2],'fetched again at expires_in − 5 min');
 check([(await oauth.microsoftToken({...microsoft,clientSecret:'another-secret-2'},options)).token,calls()-start],['ms-access-token-3',3],'a changed secret fetches a new token');
 secrets.push('another-secret-2');
 // The key: a SHA-256 hex string that holds no secret.
 const cacheKey=oauth.tokenCacheKey('microsoft',[microsoft.tenantId,microsoft.clientId,''],microsoft.clientSecret);
 check([/^[0-9a-f]{64}$/.test(cacheKey),cacheKey.includes(microsoft.clientSecret)],[true,false],'the cache key is a hash');
 // At most 100 entries, the oldest go first.
 oauth.tokenCache.clear();
 const keys=[];
 for(let index=0;index<101;index++)keys.push((await oauth.microsoftToken({...microsoft,clientSecret:`bulk-${index}`},options)).key);
 check([oauth.tokenCache.size(),oauth.tokenCache.has(keys[0]),oauth.tokenCache.has(keys[1]),oauth.tokenCache.has(keys[100])],[100,false,true,true],'the cache holds 100 entries and drops the oldest');
 oauth.tokenCache.clear();

 // Graph sendMail.
 const body=graph.graphRequestBody({subject:'[Critical] Disk\r\nBcc: x@example.com',html:'<p>Alarm</p>',recipients:['ops@contoso.com','oncall@contoso.com']});
 check(JSON.parse(body),{message:{subject:'[Critical] Disk Bcc: x@example.com',body:{contentType:'HTML',content:'<p>Alarm</p>'},toRecipients:[{emailAddress:{address:'ops@contoso.com'}},{emailAddress:{address:'oncall@contoso.com'}}]},saveToSentItems:false},'the sendMail body: one header line, HTML, recipients, no Sent Items copy');
 let graphAnswers=[];
 providers.on('graph.microsoft.com',()=>graphAnswers.shift()??[202,'']);
 const graphCalls=()=>providers.of('graph.microsoft.com').length;
 const before=graphCalls(),tokensBefore=calls();
 await graph.graphSend(microsoft,'alerts+ops@contoso.com',body,options);
 const sent=providers.of('graph.microsoft.com').at(-1);
 check([sent.path,sent.headers.authorization,sent.headers['content-type'],sent.body,graphCalls()-before,calls()-tokensBefore],['/v1.0/users/alerts%2Bops%40contoso.com/sendMail',`Bearer ms-access-token-${tokenCount}`,'application/json; charset=utf-8',body,1,1],'sendMail: path with the encoded sender, bearer token, the body, 202 = sent');
 // A 401 drops the token, fetches one new token and sends once more.
 graphAnswers=[[401,{error:{code:'InvalidAuthenticationToken'}}],[202,'']];
 const retryStart=[graphCalls(),calls()];
 await graph.graphSend(microsoft,'alerts@contoso.com',body,options);
 check([graphCalls()-retryStart[0],calls()-retryStart[1],providers.of('graph.microsoft.com').at(-1).headers.authorization],[2,1,`Bearer ms-access-token-${tokenCount}`],'401 then 202: one new token and success with it');
 graphAnswers=[[401,{}],[401,{}],[202,'']];
 const twiceStart=[graphCalls(),calls()];
 const twice=await caught(graph.graphSend(microsoft,'alerts@contoso.com',body,options));
 check([twice.reason,twice.retryable,graphCalls()-twiceStart[0],calls()-twiceStart[1]],['microsoftSignInRefused',false,2,1],'two 401s: microsoftSignInRefused after exactly one new token');
 noSecret(twice,'two 401s');
 graphAnswers=[];
 // Graph statuses.
 for(const [status,value,reason,retryable,params] of [[403,{error:{code:'ErrorAccessDenied',message:'Access is denied.'}},'microsoftPermissionMissing',false,{}],[404,{error:{code:'ErrorInvalidUser',message:'The requested user is invalid.'}},'mailboxNotFound',false,{}],[404,{error:{code:'MailboxNotEnabledForRESTAPI'}},'mailboxNotFound',false,{}],[400,{error:{code:'ErrorInvalidRecipients'}},'httpRejected',false,{status:400}],[422,{},'httpRejected',false,{status:422}],[503,{},'httpStatus',true,{status:503}],[429,{},'httpStatus',true,{status:429}]]){
  graphAnswers=[[status,value]];
  const failure=await caught(graph.graphSend(microsoft,'alerts@contoso.com',body,options));
  check([failure.reason,failure.retryable,failure.params],[reason,retryable,params],`Graph ${status} → ${reason}`);
  noSecret(failure,`Graph ${status}`);
 }
 graphAnswers=[];
 // Token endpoint errors.
 for(const [status,value,reason,retryable] of [
  [401,{error:'invalid_client',error_description:'AADSTS7000222: The provided client secret keys for app are expired.',error_codes:[7000222]},'microsoftSecretExpired',false],
  [401,{error:'invalid_client',error_description:'AADSTS7000215: Invalid client secret provided.',error_codes:[7000215]},'microsoftSignInRefused',false],
  [400,{error:'unauthorized_client',error_description:'AADSTS700016: Application not found in the directory.',error_codes:[700016]},'microsoftSignInRefused',false],
  [400,{error:'invalid_request',error_description:'AADSTS90002: Tenant not found.',error_codes:[90002]},'microsoftSignInRefused',false],
  [400,{error:'invalid_request',error_description:'AADSTS900023: Specified tenant identifier is neither a valid DNS name, nor a valid external domain.'},'microsoftSignInRefused',false],
  [401,'not json','microsoftSignInRefused',false],
  [200,{token_type:'Bearer'},'microsoftSignInRefused',false],
  [503,{},'httpStatus',true],
  [429,{},'httpStatus',true],
 ]){
  oauth.tokenCache.clear();
  providers.on('login.microsoftonline.com',()=>[status,value]);
  const failure=await caught(graph.graphSend(microsoft,'alerts@contoso.com',body,options));
  check([failure.reason,failure.retryable],[reason,retryable],`token ${status} ${typeof value==='string'?value:value.error??''} ${typeof value==='object'?value.error_codes??'':''} → ${reason}`);
  noSecret(failure,`token ${status}`);
 }
 providers.on('login.microsoftonline.com',tokenAnswer);
 // A token or network failure of either host stays retryable in the retry loop.
 oauth.tokenCache.clear();
 const slept=[];
 const outcome=await withRetry(()=>graph.graphSend(microsoft,'alerts@contoso.com',body,{...options,resolver:()=>new Promise(()=>{}),dnsMs:20}),{sleep:async ms=>{slept.push(ms);}});
 check([outcome.ok,outcome.attempts,outcome.error.reason,slept],[false,3,'dnsFailed',[1000,4000]],'a hanging lookup of the token host gets three attempts');

 // ---- Google Workspace: JWT, token and XOAUTH2 ----
 const key=serviceAccountKeyFile();
 const google={serviceAccount:key.clientEmail,privateKey:key.privateKey,privateKeyId:key.privateKeyId,subject:'alerts@example.com'};
 secrets.push(key.privateKey.split('\n')[1]);
 const assertion=oauth.googleAssertion(google,1_790_000_000);
 const [header,claims,signature]=assertion.split('.');
 check([JSON.parse(Buffer.from(header,'base64url')),JSON.parse(Buffer.from(claims,'base64url'))],[{alg:'RS256',typ:'JWT',kid:key.privateKeyId},{iss:key.clientEmail,sub:'alerts@example.com',scope:'https://mail.google.com/',aud:'https://oauth2.googleapis.com/token',iat:1_790_000_000,exp:1_790_003_600}],'the JWT header with kid and the claims');
 check(verify('sha256',Buffer.from(`${header}.${claims}`),key.publicKey,Buffer.from(signature,'base64url')),true,'the RS256 signature checks with the public key');
 check(verify('sha256',Buffer.from(`${header}.${claims}x`),key.publicKey,Buffer.from(signature,'base64url')),false,'a changed claim does not check');
 let googleCount=0;
 const googleAnswer=()=>{googleCount++;const token=`ya29.google-token-${googleCount}`;secrets.push(token);return [200,{access_token:token,expires_in:3599,token_type:'Bearer'}];};
 providers.on('oauth2.googleapis.com',googleAnswer);
 oauth.tokenCache.clear();
 const googleAccess=await oauth.googleToken(google,options);
 const tokenRequest=providers.of('oauth2.googleapis.com').at(-1);
 const [, sentClaims]=tokenRequest.form.assertion.split('.');
 check([googleAccess.token,tokenRequest.path,Object.keys(tokenRequest.form),tokenRequest.form.grant_type,JSON.parse(Buffer.from(sentClaims,'base64url')).iat],['ya29.google-token-1','/token',['grant_type','assertion'],'urn:ietf:params:oauth:grant-type:jwt-bearer',Math.floor(now/1000)],'the token form: jwt-bearer grant and the assertion, issued at the clock');
 check([(await oauth.googleToken(google,options)).token,providers.of('oauth2.googleapis.com').length],['ya29.google-token-1',1],'the Google token is cached too');
 // XOAUTH2 over implicit TLS at smtp.gmail.com:465.
 const gmail=await fakeSmtp({implicitTls:true,starttls:false,oauth:{user:'alerts@example.com',token:'ya29.google-token-1'},tls:{key:providerTls.key,cert:providerTls.cert}});
 try{
  const smtpOptions=providerOptions({httpsPort:providers.port,smtpPort:gmail.port,clock});
  const gmailSettings={host:'smtp.gmail.com',port:465,tls:'tls',from:'alerts@example.com',recipients:['ops@example.com'],username:null,password:null};
  await smtpSend({...gmailSettings,oauth:{user:'alerts@example.com',accessToken:googleAccess.token}},{subject:'s',text:'t',html:'<p>t</p>',messageId:'m'},smtpOptions);
  check([gmail.xoauth2,gmail.messages.length,gmail.messages[0].secure,gmail.messages[0].user],[['user=alerts@example.com\x01auth=Bearer ya29.google-token-1\x01\x01'],1,true,'alerts@example.com'],'XOAUTH2 with user and bearer token over implicit TLS');
  const refused=await caught(smtpSend({...gmailSettings,oauth:{user:'alerts@example.com',accessToken:'ya29.revoked'}},{subject:'s',text:'t',html:'<p>t</p>',messageId:'m'},smtpOptions));
  check([refused.reason,refused.retryable,gmail.messages.length],['googleDelegationMissing',false,1],'a refused XOAUTH2 sign-in is googleDelegationMissing');
  noSecret(refused,'XOAUTH2');
 }finally{await gmail.close();}
 // Google token errors.
 for(const [status,value,reason] of [
  [401,{error:'unauthorized_client',error_description:'Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.'},'googleDelegationMissing'],
  [400,{error:'invalid_grant',error_description:'Invalid email or User ID'},'mailboxNotFound'],
  [400,{error:'invalid_grant',error_description:'Invalid JWT Signature.'},'googleSignInRefused'],
  [401,{error:'invalid_client',error_description:'The OAuth client was not found.'},'googleSignInRefused'],
  [400,{error:'invalid_request'},'googleSignInRefused'],
  [503,{},'httpStatus'],
 ]){
  oauth.tokenCache.clear();
  providers.on('oauth2.googleapis.com',()=>[status,value]);
  const failure=await caught(oauth.googleToken(google,options));
  check([failure.reason,failure.retryable],[reason,status===503],`Google token ${status} ${value.error??''} → ${reason}`);
  noSecret(failure,`Google token ${status}`);
 }
 // The assertion and the private key never go anywhere but the token request.
 const others=providers.requests.filter(entry=>entry.host!=='oauth2.googleapis.com').map(entry=>JSON.stringify(entry));
 check(others.some(text=>text.includes(key.privateKeyId)||text.includes('BEGIN PRIVATE'+' KEY')),false,'no other request carries the key');
}finally{await providers.close();oauth.tokenCache.clear();}


console.log(`PASS notification transport (${checks} checks): target check incl. mapped and private forms, one private address refuses a host, DNS pinning with SNI and Host, no redirects, retries and waits (400/422 httpRejected once), timeout, body limit, capped response, TLS and URL rules, DNS time limit, documentation/benchmark/6to4/Teredo ranges, minimal DER serial, MFA and basic-auth replies, answer body, Microsoft 365 token cache and Graph sendMail, Google JWT and XOAUTH2.`);
