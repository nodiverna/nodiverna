// Notification channels against PostgreSQL through the real route and
// lib/server/notifications/notification-channels.ts: create, update and delete per type, validation,
// no password, URL path or query or signing key in any answer or audit row,
// answers through the real error serialization (classifyFailure of lib/server/context.ts failure()),
// the encrypted column with its context, an empty secret on update keeps it,
// revision 409, the right (403 for an Operator, before 400), no step-up proof but the live MFA session,
// one audit row per change and its rollback, rewrap-secrets, and test messages
// against a fake SMTP server (STARTTLS, implicit TLS, AUTH, a rejected recipient,
// no STARTTLS) and a fake HTTPS webhook (signature, Teams card, Discord embeds
// without X-Nodiverna headers, refused target, timeout, status 500, status 400
// as httpRejected), the Discord URL rule and the type check of the migration,
// and the rate limit, audit row and write guard of test; the sign-ins Microsoft
// 365 and Google Workspace (validation, secrets per sign-in, a change of the
// sign-in, the audit row, old configs without auth, secretSet, test messages
// through fake token, Graph and Gmail endpoints, the Graph body limit) and a
// refused MFA password.
import {HttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import {testTls} from '../support/test-certificate.mjs';
import {sourceDatabase,sourceLoader,sourceActor,insertRow,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {createKeyring,decryptWithKeyring,encryptWithKeyring} from '../../runtime/secret-keyring.mjs';
import {rewrapSecrets} from '../../scripts/selfhost.mjs';
import {fakeSmtp} from '../support/fake-smtp.mjs';
import {fakeProviders,providerOptions,providerTls,serviceAccountKeyFile} from '../support/fake-providers.mjs';
const {classifyFailure}=await import('../../lib/server/errors/failure.ts');

const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),uuid=()=>crypto.randomUUID(),day=86_400_000;
const secretOld='old-session-secret-for-notification-tests-0001',secretNew='new-session-secret-for-notification-tests-0002';
let ring=createKeyring({SESSION_SECRET:secretOld});
const ca=testTls.cert;
try{
 const load=sourceLoader();
 let viewer=null;
 const server={db:()=>d,now:()=>Date.now(),config:key=>key==='SITE_ORIGIN'?'https://portal.example.test':'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:async request=>request.json(),sameOrigin:()=>{},
  requireViewer:async()=>viewer,log:async()=>{throw new Error('log() is not used');},
  // The answer body of the real failure() (lib/server/context.ts): classifyFailure keeps only the params the client gets.
  failure:error=>{const answer=classifyFailure(error);return Response.json(answer.body,{status:answer.status,headers:{'Cache-Control':'no-store'}});}};
 const localAuth={primaryGuard:async(_request,actor)=>load('lib/server/identity/access.ts').viewerWriteGuard(actor)};
 // The session fence holds while the actor's MFA session row exists, so a test can end it.
 const mfa={requireLiveSessions:async(_request,who)=>{if(!await d.one(sql`SELECT 1 AS live FROM mfa_sessions WHERE token_hash=${sha(who.id+'mfa')} AND principal=${who.principal}`))throw new HttpError('apiError.mfa.sessionExpired');},requireMfa:async()=>{},isMfaEnabled:async()=>true,mfaSessionFence:async(_request,who)=>sql`EXISTS (SELECT 1 FROM mfa_sessions WHERE token_hash=${sha(who.id+'mfa')} AND principal=${who.principal})`,
  encryptSecret:(value,context)=>encryptWithKeyring(ring,value,context),
  decryptSecret:async(value,context)=>{try{return await decryptWithKeyring(ring,value,context);}catch{throw new HttpError('apiError.mfa.secretUndecryptable');}},
  // Like lib/server/identity/mfa.ts: a missing or expired proof is refused before the commit and checked again in it.
  readMfaManagementProof:async(_request,who,value)=>{
   const live=typeof value==='string'&&await d.one(sql`SELECT 1 AS live FROM mfa_management_proofs WHERE token_hash=${value} AND principal=${who.principal} AND expires_at>${Date.now()}`);
   if(!live)throw new HttpError('apiError.mfa.stepUpRequired');
   return {tokenHash:value,key:who.principal,sessionHash:sha(who.id+'mfa'),guard:sql`TRUE`};
  }};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'../identity/mfa':mfa,'./mfa':mfa,'@/lib/server/identity/mfa':mfa,'./local-auth':localAuth,'@/lib/server/identity/local-auth':localAuth};
 const access=load('lib/server/identity/access.ts',imports),send=load('lib/server/notifications/notify/send.ts',imports);
 const route=load('app/api/notifications/channels/route.ts',imports);
 // Targets: the test host names resolve to a public address; the socket opens the local fake server.
 const transportOptions={ca,resolver:async()=>[{address:'93.184.216.34',family:4}],routeAddress:()=>'127.0.0.1',sleep:async()=>{}};
 send.useTransportOptions(transportOptions);

 // ---- Fixture ----
 const time=Date.now();
 const actor=async(label,permissions)=>{const {actor:value}=await sourceActor(d,label,permissions);value.userId=value.id;
  await insertRow(d,'mfa_sessions',{token_hash:sha(value.id+'mfa'),principal:value.principal,created_at:time,last_activity:time,idle_expires_at:time+day,expires_at:time+day});return value;};
 const owner=await actor('owner@notify.test',['*']),notifier=await actor('notifier@notify.test',['portal.notifications.manage']),operator=await actor('operator@notify.test',[...access.rolePermissions.operator,'portal.operator']);
 const token=async(who=owner)=>{const value=uuid();await insertRow(d,'mfa_management_proofs',{token_hash:value,principal:who.principal,session_hash:sha(who.id+'mfa'),expires_at:Date.now()+300_000});return value;};
 const post=async(as,payload)=>{viewer=as;const response=await route.POST(new Request('https://portal.example.test/api/notifications/channels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));return {status:response.status,body:await response.json()};};
 const list=async as=>{viewer=as;const response=await route.GET();return {status:response.status,cache:response.headers.get('Cache-Control'),body:await response.json()};};
 const change=async(as,payload)=>post(as,{...payload,managementToken:await token(as)});
 const audits=()=>d.query(sql`SELECT action,target,scope,customer_id AS "customerId" FROM audit WHERE action LIKE 'notification-channel.%' ORDER BY id`);
 const stored=id=>d.one(sql`SELECT * FROM notification_channels WHERE id=${id}`);
 const secretOf=async id=>JSON.parse(await decryptWithKeyring(ring,(await stored(id)).secret,`notification-channel:${id}`));
 // The file sends more than 5 test messages; each section starts with a fresh window.
 const resetLimits=()=>d.exec(sql`DELETE FROM notification_test_limits`);
 const leaks=[];
 const noLeak=(value,label)=>{const text=JSON.stringify(value);for(const secret of leaks)assert.ok(!text.includes(secret),`${label} leaks ${secret.slice(0,12)}…`);checks++;};

 // ---- Right and session ----
 check((await list(operator)).status,403,'an Operator cannot list channels');
 check((await post(operator,{action:'create',type:'nothing'})).status,403,'the right comes before the body');
 check((await post(operator,{action:'create',type:'nothing'})).body.code,'FORBIDDEN','with the forbidden code');
 const smtpInput={action:'create',type:'smtp',name:'Ops mail',host:'smtp.example.test',port:2525,tls:'starttls',from:'alerts@example.com',recipients:['ops@example.com','oncall@example.com'],username:'mailer',password:'smtp-pass-7Hq',language:'de'};
 leaks.push('smtp-pass-7Hq');
 // No step-up proof (lib/step-up.ts), but the live MFA session: without it nothing changes and the session's own 401 answers.
 const session=await d.one(sql`SELECT * FROM mfa_sessions WHERE token_hash=${sha(notifier.id+'mfa')}`);
 await d.exec(sql`DELETE FROM mfa_sessions WHERE token_hash=${session.token_hash}`);
 const noSession=await post(notifier,smtpInput);
 check([noSession.status,noSession.body.code,(await audits()).length,Number((await d.one(sql`SELECT count(*) AS n FROM notification_channels`)).n)],[401,'SESSION_EXPIRED',0,0],'create without a live MFA session changes nothing and answers the session error');
 await insertRow(d,'mfa_sessions',session);

 // ---- Validation ----
 const invalid=async(payload,field,label)=>{const result=await change(notifier,{...smtpInput,...payload});check([result.status,result.body.code,result.body.params],[400,'NOTIFY_CHANNEL_INVALID',{field}],label);};
 await invalid({name:''},'name','an empty name');
 await invalid({name:'x'.repeat(81)},'name','a name over 80 characters');
 await invalid({host:'bad host'},'host','a host with a space');
 await invalid({port:0},'port','port 0');
 await invalid({port:70000},'port','port 70000');
 await invalid({tls:'ssl'},'tls','an unknown encryption');
 await invalid({from:'a@b@c'},'from','a bad sender');
 await invalid({recipients:[]},'recipients','no recipient');
 await invalid({recipients:Array.from({length:21},(_,i)=>`r${i}@example.com`)},'recipients','21 recipients');
 await invalid({recipients:['ok@example.com','bad\r\nBcc: x@example.com']},'recipients','header injection in a recipient');
 await invalid({tls:'none'},'username','no credentials over plain text');
 await invalid({tls:'none',username:'',password:'x'},'password','no password over plain text');
 await invalid({password:'x'.repeat(257)},'password','a password over 256 characters');
 check((await change(notifier,{action:'create',type:'teams',name:'T',url:'http://example.com/hook'})).body.params,{field:'url'},'Teams needs https');
 check((await change(notifier,{action:'create',type:'webhook',name:'W',url:'https://user:pw@example.com/hook'})).body.params,{field:'url'},'no user info');
 check((await change(notifier,{action:'create',type:'webhook',name:'W',url:'https://example.com/'+'x'.repeat(2048)})).body.params,{field:'url'},'at most 2048 characters');
 // Discord: only Discord webhook URLs, and no Discord URL for the other types.
 for(const url of ['https://example.com/api/webhooks/1/x','https://discord.com/api/webhooks/1/x/slack','https://discord.com:8443/api/webhooks/1/x','https://discord.com:443/api/webhooks/1/x',' https://discord.com:443/api/webhooks/1/x','http://discord.com/api/webhooks/1/x','https://discord.com/api/webhooks/abc/x','https://discord.com/api/webhooks/1/x.y','https://evil.discord.com.example/api/webhooks/1/x','https://user@discord.com/api/webhooks/1/x']){
  const refused=await change(notifier,{action:'create',type:'discord',name:'D',url});
  check([refused.status,refused.body.messageKey,refused.body.params],[400,'apiError.notify.channelInvalid',{field:'url'}],`Discord refuses ${url}`);
 }
 check((await change(notifier,{action:'create',type:'discord',name:'D'})).body.params,{field:'url'},'Discord needs a URL');
 for(const type of ['webhook','teams'])for(const url of ['https://discord.com/api/webhooks/123/tok_en-1','https://Canary.DiscordApp.com./api/v10/webhooks/1/x/?thread_id=5']){
  const wrong=await change(notifier,{action:'create',type,name:'W',url});
  check([wrong.status,wrong.body.code,wrong.body.messageKey,wrong.body.params],[400,'NOTIFY_CHANNEL_INVALID','apiError.notify.discordUrlWrongType',{field:'url'}],`${type} refuses the Discord URL ${url}`);
 }
 check((await audits()).length,0,'refused changes write no audit row');

 // ---- Create per type ----
 const createdSmtp=await change(notifier,smtpInput);
 check([createdSmtp.status,createdSmtp.body.revision,'signingSecret' in createdSmtp.body],[200,0,false],'an SMTP channel');
 const smtpId=createdSmtp.body.id;
 const teamsUrl='https://hooks.example.test/workflows/abc123/triggers/manual/paths/invoke?sig=TeamsSig987';
 leaks.push('/workflows/abc123','TeamsSig987');
 const createdTeams=await change(notifier,{action:'create',type:'teams',name:'Ops Teams',url:teamsUrl});
 const teamsId=createdTeams.body.id;
 const createdHook=await change(notifier,{action:'create',type:'webhook',name:'Ops hook',url:'https://hooks.example.test/in/hook-path-55?key=HookQuery66'});
 leaks.push('hook-path-55','HookQuery66');
 const hookId=createdHook.body.id,signing=createdHook.body.signingSecret;
 check([createdHook.status,typeof signing,signing.length,/^[A-Za-z0-9_-]+$/.test(signing)],[200,'string',43,true],'the webhook signing key is returned once, 32 random bytes in base64url');
 leaks.push(signing);
 check((await change(notifier,{...smtpInput,name:'OPS MAIL'})).body.code,'NOTIFY_CHANNEL_NAME_TAKEN','names are unique without regard to case');
 // Stored: config without the password, ciphertext with the context.
 const smtpRow=await stored(smtpId);
 check([JSON.parse(smtpRow.config),smtpRow.target_hint,smtpRow.language,Number(smtpRow.enabled)],[{host:'smtp.example.test',port:2525,tls:'starttls',from:'alerts@example.com',recipients:['ops@example.com','oncall@example.com'],username:'mailer'},'2 recipients via smtp.example.test:2525','de',1],'the stored SMTP settings');
 check(smtpRow.secret.startsWith('k1.'),true,'the secret is keyring ciphertext');
 check(await secretOf(smtpId),{password:'smtp-pass-7Hq'},'it decrypts with its context');
 await assert.rejects(decryptWithKeyring(ring,smtpRow.secret,`notification-channel:${hookId}`),'another context does not decrypt');checks++;
 check(await secretOf(hookId),{url:'https://hooks.example.test/in/hook-path-55?key=HookQuery66',signingKey:signing},'URL and signing key are one ciphertext');
 check((await stored(teamsId)).target_hint,'https://hooks.example.test/…','the masked target of a URL');
 noLeak(await d.query(sql`SELECT id,type,name,config,target_hint FROM notification_channels`),'the plain columns');

 // ---- GET ----
 const listed=await list(notifier);
 check([listed.status,listed.cache,listed.body.channels.map(channel=>[channel.name,channel.type,channel.secretSet,channel.enabled,channel.revision])],[200,'no-store',[['Ops hook','webhook',false,true,0],['Ops mail','smtp',true,true,0],['Ops Teams','teams',false,true,0]]],'the channels sorted by name');
 check(listed.body.channels.find(channel=>channel.id===smtpId).config,{auth:'password',host:'smtp.example.test',port:2525,tls:'starttls',from:'alerts@example.com',recipients:['ops@example.com','oncall@example.com'],username:'mailer'},'config without the password');
 noLeak(listed.body,'GET');
 check((await list(owner)).status,200,'Owners hold the right through *');

 // ---- Update ----
 const updated=await change(notifier,{action:'update',id:smtpId,revision:0,name:'Ops mail',host:'smtp2.example.test',port:587,tls:'starttls',from:'alerts@example.com',recipients:['ops@example.com'],username:'mailer',password:''});
 check([updated.status,updated.body.revision],[200,1],'update with an empty password');
 check(await secretOf(smtpId),{password:'smtp-pass-7Hq'},'the empty password keeps the stored one');
 const stale=await change(notifier,{...smtpInput,action:'update',id:smtpId,revision:0});
 check([stale.status,stale.body.code],[409,'NOTIFY_CHANNEL_CHANGED'],'a stale revision');
 const newUrl='https://hooks.example.test/workflows/def456/run?sig=NewSig321';leaks.push('def456','NewSig321');
 check((await change(notifier,{action:'update',id:teamsId,revision:0,name:'Ops Teams',url:newUrl})).body.revision,1,'a new Teams URL');
 check(await secretOf(teamsId),{url:newUrl},'the new URL replaces the stored one');
 check((await change(notifier,{action:'update',id:hookId,revision:0,name:'Ops hook',language:'de'})).body.revision,1,'an omitted URL keeps it');
 check(await secretOf(hookId),{url:'https://hooks.example.test/in/hook-path-55?key=HookQuery66',signingKey:signing},'URL and key stay');
 const nothing=await change(notifier,{action:'update',id:hookId,revision:1,name:'Ops hook',language:'de'});
 check([nothing.status,nothing.body.revision],[200,1],'an unchanged update writes nothing');
 // set-enabled and rotate-secret.
 check((await change(notifier,{action:'set-enabled',id:teamsId,revision:1,enabled:false})).body.revision,2,'turn off');
 check(Number((await stored(teamsId)).enabled),0,'stored off');
 const rotated=await change(notifier,{action:'rotate-secret',id:hookId,revision:1});
 check([rotated.status,rotated.body.revision,rotated.body.signingSecret!==signing,rotated.body.signingSecret.length],[200,2,true,43],'a new signing key, returned once');
 leaks.push(rotated.body.signingSecret);
 check((await secretOf(hookId)).signingKey,rotated.body.signingSecret,'the new key is stored');
 check((await change(notifier,{action:'rotate-secret',id:teamsId,revision:2})).body.params,{field:'type'},'only webhooks have a signing key');
 // rotate-secret asks for no proof: without one, a stale revision answers 409 and not MFA_STEP_UP_REQUIRED.
 check((await post(notifier,{action:'rotate-secret',id:hookId,revision:1})).body.code,'NOTIFY_CHANNEL_CHANGED','rotate-secret without a proof is not refused for MFA');

 // ---- Audit ----
 const rows=await audits();
 check(rows.map(row=>row.action),['notification-channel.create','notification-channel.create','notification-channel.create','notification-channel.update','notification-channel.update','notification-channel.update','notification-channel.disable','notification-channel.rotate-secret'],'one audit row per change');
 check(rows.every(row=>row.scope==='portal'&&row.customerId===null),true,'portal rows');
 check(JSON.parse(rows[0].target),{id:smtpId,name:'Ops mail',type:'smtp'},'create names the channel');
 check(JSON.parse(rows[3].target),{id:smtpId,name:'Ops mail',type:'smtp',changed:['host','port','recipients'],old:{host:'smtp.example.test',port:2525,recipients:['ops@example.com','oncall@example.com']},new:{host:'smtp2.example.test',port:587,recipients:['ops@example.com']}},'update lists the changed fields with old and new values');
 check(JSON.parse(rows[4].target).secretChanged,true,'a new URL is only "secretChanged"');
 check(JSON.parse(rows[7].target),{id:hookId,name:'Ops hook',type:'webhook',secretChanged:true},'rotate-secret');
 noLeak(rows,'the audit rows');
 // A failing audit insert rolls the change back.
 await createTrigger(d,'notify_audit_failure','audit','BEFORE INSERT',{message:'fixture-audit-failure'});
 try{
  const failed=await change(notifier,{action:'set-enabled',id:hookId,revision:2,enabled:false});
  check([failed.status,Number((await stored(hookId)).enabled),Number((await stored(hookId)).revision)],[500,1,2],'the change rolls back with its audit row');
 }finally{await dropTrigger(d,'notify_audit_failure','audit');}

 // ---- Delete: rules cascade, deliveries stay ----
 const ruleId=uuid(),eventId=uuid(),deliveryId=uuid();
 await insertRow(d,'notification_rules',{id:ruleId,scope_type:'all',scope_id:'*',channel_id:teamsId,levels:'["critical"]',on_open:1,on_close:1,on_escalate:1,enabled:1,revision:0,created_at:time,created_by:'fixture',updated_at:time,updated_by:'fixture'});
 await insertRow(d,'notification_events',{id:eventId,kind:'test',occurred_at:time,status:'routed'});
 await insertRow(d,'notification_deliveries',{id:deliveryId,event_id:eventId,channel_id:teamsId,channel_name:'Ops Teams',channel_type:'teams',target_hint:'https://hooks.example.test/…',status:'sent',attempts:1,sent_at:time,last_attempt_at:time,created_at:time});
 check((await list(notifier)).body.channels.find(channel=>channel.id===teamsId).ruleCount,1,'the rule count for the confirmation');
 check((await change(notifier,{action:'delete',id:teamsId,revision:2})).status,200,'delete');
 check([await stored(teamsId),await d.one(sql`SELECT id FROM notification_rules WHERE id=${ruleId}`),await d.one(sql`SELECT channel_id,channel_name,channel_type FROM notification_deliveries WHERE id=${deliveryId}`)],[null,null,{channel_id:null,channel_name:'Ops Teams',channel_type:'teams'}],'rules go with the channel, deliveries keep name and type');
 check((await audits()).at(-1).action,'notification-channel.delete','delete writes its row');

 // ---- Discord channel ----
 const discordUrl='https://discord.com/api/webhooks/123/tok_en-1';leaks.push('tok_en-1');
 const createdDiscord=await change(notifier,{action:'create',type:'discord',name:'Ops Discord',url:discordUrl});
 check([createdDiscord.status,createdDiscord.body.revision,'signingSecret' in createdDiscord.body],[200,0,false],'a Discord channel, without a signing secret');
 const discordId=createdDiscord.body.id,discordRow=await stored(discordId);
 check([discordRow.type,JSON.parse(discordRow.config),discordRow.target_hint,discordRow.secret.startsWith('k1.')],['discord',{},'https://discord.com/…',true],'stored: type, empty config, masked target, ciphertext');
 check(await secretOf(discordId),{url:discordUrl},'the secret is only the URL');
 for(const [index,url] of ['https://discord.com/api/webhooks/123/abc-_X','https://ptb.discord.com/api/v10/webhooks/9/x/','https://discordapp.com/api/webhooks/1/x?thread_id=42'].entries()){
  const accepted=await change(notifier,{action:'create',type:'discord',name:`Discord ${index}`,url});
  check(accepted.status,200,`Discord accepts ${url}`);
  check((await change(notifier,{action:'delete',id:accepted.body.id,revision:0})).status,200,'and deletes it again');
 }
 const rotateDiscord=await change(notifier,{action:'rotate-secret',id:discordId,revision:0});
 check([rotateDiscord.status,rotateDiscord.body.messageKey,rotateDiscord.body.params],[400,'apiError.notify.channelInvalid',{field:'type'}],'rotate-secret on Discord answers field type');
 check((await change(notifier,{action:'update',id:discordId,revision:0,type:'webhook',name:'Ops Discord'})).body.params,{field:'type'},'the type cannot change');
 check((await change(notifier,{action:'update',id:discordId,revision:0,name:'Ops Discord',url:'https://example.com/api/webhooks/1/x'})).body.params,{field:'url'},'an update checks a new URL');
 check((await change(notifier,{action:'update',id:discordId,revision:0,name:'Discord ops'})).body.revision,1,'an update without a URL keeps it');
 check(await secretOf(discordId),{url:discordUrl},'the URL stays');
 // A stored Discord URL in a webhook channel is not checked again on update.
 const older=await change(notifier,{action:'create',type:'webhook',name:'Older hook',url:'https://hooks.example.test/in/older'});
 const olderKey=(await secretOf(older.body.id)).signingKey;leaks.push(olderKey);
 await d.exec(sql`UPDATE notification_channels SET secret=${await encryptWithKeyring(ring,JSON.stringify({url:discordUrl,signingKey:olderKey}),`notification-channel:${older.body.id}`)} WHERE id=${older.body.id}`);
 check((await change(notifier,{action:'update',id:older.body.id,revision:0,name:'Older hook 2'})).status,200,'an existing webhook with a Discord URL keeps working');
 check((await change(notifier,{action:'delete',id:older.body.id,revision:1})).status,200,'and is deleted again');
 // The type checks of the migration: discord is allowed, slack is not.
 const typeEvent=uuid();
 await insertRow(d,'notification_events',{id:typeEvent,kind:'test',occurred_at:time,status:'routed'});
 await insertRow(d,'notification_deliveries',{id:uuid(),event_id:typeEvent,channel_id:discordId,channel_name:'Discord ops',channel_type:'discord',target_hint:'https://discord.com/…',status:'sent',attempts:1,sent_at:time,last_attempt_at:time,created_at:time});checks++;
 await assert.rejects(insertRow(d,'notification_deliveries',{id:uuid(),event_id:typeEvent,channel_id:null,channel_name:'S',channel_type:'slack',target_hint:'x',status:'sent',attempts:1,sent_at:time,last_attempt_at:time,created_at:time}),/notification_deliveries_type_check/);checks++;
 const channelRow=type=>({id:uuid(),type,name:`type ${type}`,enabled:1,language:'en',config:'{}',secret:null,target_hint:'x',revision:0,created_at:time,created_by:'fixture',updated_at:time,updated_by:'fixture'});
 await assert.rejects(insertRow(d,'notification_channels',channelRow('slack')),/notification_channels_type_check/);checks++;
 const plainDiscord=channelRow('discord');await insertRow(d,'notification_channels',plainDiscord);checks++;
 await d.exec(sql`DELETE FROM notification_channels WHERE id=${plainDiscord.id}`);
 await d.exec(sql`DELETE FROM notification_deliveries WHERE event_id=${typeEvent}`);await d.exec(sql`DELETE FROM notification_events WHERE id=${typeEvent}`);

 // ---- Test messages: SMTP ----
 await resetLimits();
 const smtp=await fakeSmtp({starttls:true,auth:{user:'mailer',pass:'smtp-pass-7Hq'}});
 try{
  const setPort=async(id,port,extra={})=>{const row=await stored(id),config={...JSON.parse(row.config),port,...extra};await d.exec(sql`UPDATE notification_channels SET config=${JSON.stringify(config)} WHERE id=${id}`);};
  await setPort(smtpId,smtp.port,{host:'smtp.example.test'});
  const sent=await post(notifier,{action:'test',id:smtpId});
  check([sent.status,sent.body],[200,{ok:true}],'a test message over STARTTLS with AUTH');
  check([smtp.messages.length,smtp.messages[0].secure,smtp.messages[0].user,smtp.messages[0].to],[1,true,'mailer',['ops@example.com']],'the server got one encrypted, signed-in message');
  const mail=smtp.messages[0].data;
  check([/Subject: Testnachricht von Nodiverna/.test(mail),/Content-Type: text\/plain; charset=utf-8/i.test(mail),/Content-Type: text\/html; charset=utf-8/i.test(mail)],[true,true,true],'subject in the channel language, text and HTML parts');
  noLeak(mail,'the mail');
  const logRow=await d.one(sql`SELECT e.kind,e.status AS event_status,d.status,d.channel_name,d.attempts,d.error_key FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id WHERE d.channel_id=${smtpId}`);
  check(logRow,{kind:'test',event_status:'routed',status:'sent',channel_name:'Ops mail',attempts:1,error_key:null},'the test is in the log');
  // A wrong password, a rejected recipient, no STARTTLS.
  await d.exec(sql`UPDATE notification_channels SET secret=${await encryptWithKeyring(ring,JSON.stringify({password:'wrong'}),`notification-channel:${smtpId}`)} WHERE id=${smtpId}`);
  const refused=await post(notifier,{action:'test',id:smtpId});
  check([refused.status,refused.body.code,refused.body.messageKey],[422,'NOTIFY_SEND_FAILED','apiError.notify.authFailed'],'a refused sign-in');
  await d.exec(sql`UPDATE notification_channels SET secret=${await encryptWithKeyring(ring,JSON.stringify({password:'smtp-pass-7Hq'}),`notification-channel:${smtpId}`)} WHERE id=${smtpId}`);
  const rejecting=await fakeSmtp({starttls:true,auth:{user:'mailer',pass:'smtp-pass-7Hq'},rejectRecipients:['ops@example.com']});
  try{await setPort(smtpId,rejecting.port);check((await post(notifier,{action:'test',id:smtpId})).body.messageKey,'apiError.notify.recipientRejected','a rejected recipient');}finally{await rejecting.close();}
  const plain=await fakeSmtp({starttls:false,auth:{user:'mailer',pass:'smtp-pass-7Hq'}});
  try{await setPort(smtpId,plain.port);check((await post(notifier,{action:'test',id:smtpId})).body.messageKey,'apiError.notify.starttlsMissing','no STARTTLS offered');check(plain.messages.length,0,'nothing was sent in plain text');}finally{await plain.close();}
  const implicit=await fakeSmtp({implicitTls:true,starttls:false,auth:{user:'mailer',pass:'smtp-pass-7Hq'}});
  try{await setPort(smtpId,implicit.port,{tls:'tls'});check((await post(notifier,{action:'test',id:smtpId})).status,200,'implicit TLS');check(implicit.messages.length,1,'one message');}finally{await implicit.close();}
  check((await d.query(sql`SELECT d.error_key FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id WHERE d.channel_id=${smtpId} ORDER BY d.created_at,d.last_attempt_at`)).map(row=>row.error_key),[null,'apiError.notify.authFailed','apiError.notify.recipientRejected','apiError.notify.starttlsMissing',null],'every test is logged with its key');
 }finally{await smtp.close();}

 // ---- Test messages: webhook and Teams ----
 await resetLimits();
 const received=[];let behaviour=(request,response)=>{response.writeHead(204);response.end();};
 const target=https.createServer({key:testTls.key,cert:testTls.cert},(request,response)=>{
  const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{received.push({path:request.url,headers:request.headers,body:Buffer.concat(chunks).toString()});behaviour(request,response);});
 });
 await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
 try{
  const port=target.address().port;
  const hookUrl=`https://hooks.example.test:${port}/in/hook-path-55?key=HookQuery66`;
  const key=(await secretOf(hookId)).signingKey;
  await d.exec(sql`UPDATE notification_channels SET secret=${await encryptWithKeyring(ring,JSON.stringify({url:hookUrl,signingKey:key}),`notification-channel:${hookId}`)} WHERE id=${hookId}`);
  check((await post(notifier,{action:'test',id:hookId})).status,200,'a webhook test');
  const request=received.at(-1),expected=`v1=${crypto.createHmac('sha256',key).update(`${request.headers['x-nodiverna-timestamp']}.${request.body}`).digest('hex')}`;
  check([request.path,request.headers['x-nodiverna-event'],request.headers['content-type'],/^\d{10}$/.test(request.headers['x-nodiverna-timestamp']),request.headers['x-nodiverna-signature']],['/in/hook-path-55?key=HookQuery66','test','application/json; charset=utf-8',true,expected],'the signature verifies with the returned key and the timestamp');
  check(request.headers['x-nodiverna-signature']===`v1=${crypto.createHmac('sha256','wrong-key').update(`${request.headers['x-nodiverna-timestamp']}.${request.body}`).digest('hex')}`,false,'a wrong key does not verify');
  check(Object.keys(JSON.parse(request.body)),['event','deliveryId','sentAt','portal','message','note'],'the test body');
  check(request.headers['x-nodiverna-delivery'],JSON.parse(request.body).deliveryId,'the delivery header is the message ID');
  // Teams.
  const teams=await change(notifier,{action:'create',type:'teams',name:'Teams 2',url:`https://hooks.example.test:${port}/workflows/zz9?sig=Teams2Sig`});
  leaks.push('Teams2Sig');
  check((await post(notifier,{action:'test',id:teams.body.id})).status,200,'a Teams test');
  const card=JSON.parse(received.at(-1).body);
  check([card.type,card.attachments.length,card.attachments[0].contentType,card.attachments[0].content.type,card.attachments[0].content.body[0].text],['message',1,'application/vnd.microsoft.card.adaptive','AdaptiveCard','Test message from Nodiverna'],'the Adaptive Card');
  // Discord: sent directly, since the test host is no Discord host.
  const discordSent=await send.sendNotification({type:'discord',config:{},secret:{url:`https://hooks.example.test:${port}/api/webhooks/1/x`}},{kind:'test'},{deliveryId:uuid(),time:Date.now(),portal:'https://portal.example.test',origin:'https://portal.example.test',locale:'en'});
  const discordRequest=received.at(-1),discordBody=JSON.parse(discordRequest.body);
  check([discordSent.ok,discordSent.attempts,discordRequest.path,discordRequest.headers['content-type'],Object.keys(discordRequest.headers).filter(name=>name.startsWith('x-nodiverna-'))],[true,1,'/api/webhooks/1/x','application/json; charset=utf-8',[]],'Discord: a 204 is sent, without X-Nodiverna headers');
  check([Object.keys(discordBody).sort(),discordBody.embeds[0].title,discordBody.allowed_mentions],[['allowed_mentions','embeds'],'Test message from Nodiverna',{parse:[]}],'Discord: embeds with mentions off');
  check((await send.sendNotification({type:'discord',config:{},secret:{}},{kind:'test'},{deliveryId:uuid(),time:Date.now(),portal:'p',origin:'o',locale:'en'})).error.reason,'secretUndecryptable','Discord without a stored URL');
  // Error keys: status 500 after the retries, a refused target, a timeout.
  await resetLimits();
  const before=received.length;
  behaviour=(request,response)=>{response.writeHead(500);response.end();};
  const failed=await post(notifier,{action:'test',id:hookId});
  check([failed.status,failed.body.messageKey,failed.body.params,received.length-before],[422,'apiError.notify.httpStatus',{status:500},3],'status 500 after three attempts');
  // Status 400: the target refused the format; one attempt, its own reason in the answer and the log.
  await resetLimits();
  const beforeRejected=received.length;
  behaviour=(request,response)=>{response.writeHead(400);response.end('{"message": "Cannot send an empty message"}');};
  const rejected=await post(notifier,{action:'test',id:hookId});
  check([rejected.status,rejected.body.code,rejected.body.messageKey,rejected.body.params,received.length-beforeRejected],[422,'NOTIFY_SEND_FAILED','apiError.notify.httpRejected',{status:400},1],'status 400: httpRejected after one attempt');
  check(await d.query(sql`SELECT status,attempts,error_key,error_params FROM notification_deliveries WHERE channel_id=${hookId} AND error_key='apiError.notify.httpRejected'`),[{status:'failed',attempts:1,error_key:'apiError.notify.httpRejected',error_params:'{"status":400}'}],'the delivery row of the test');
  await resetLimits();
  send.useTransportOptions({...transportOptions,resolver:async()=>[{address:'169.254.169.254',family:4}]});
  check((await post(notifier,{action:'test',id:hookId})).body.messageKey,'apiError.notify.targetBlocked','the metadata address is refused');
  send.useTransportOptions({...transportOptions,totalMs:300});
  behaviour=()=>{};
  check((await post(notifier,{action:'test',id:hookId})).body.messageKey,'apiError.notify.timeout','no answer in time');
  send.useTransportOptions(transportOptions);
  // The disabled channel can still be tested.
  behaviour=(request,response)=>{response.writeHead(200);response.end();};
  await d.exec(sql`UPDATE notification_channels SET enabled=0 WHERE id=${hookId}`);
  check((await post(notifier,{action:'test',id:hookId})).status,200,'a disabled channel can be tested');
  noLeak((await d.query(sql`SELECT * FROM notification_deliveries`)).map(row=>({...row})),'the delivery rows');

  // ---- test: rate limit ----
  behaviour=(request,response)=>{response.writeHead(204);response.end();};
  const counts=async()=>[
   Number((await d.one(sql`SELECT count(*) AS n FROM notification_events WHERE kind='test'`)).n),
   Number((await d.one(sql`SELECT count(*) AS n FROM notification_deliveries`)).n),
   Number((await d.one(sql`SELECT count(*) AS n FROM audit WHERE action='notification-channel.test'`)).n)];
  const attemptsOf=async who=>{const row=await d.one(sql`SELECT attempts FROM notification_test_limits WHERE principal=${who.principal}`);return row?Number(row.attempts):null;};
  await resetLimits();
  const start=await counts(),sentBefore=received.length;
  for(let index=1;index<=5;index++)check((await post(notifier,{action:'test',id:hookId})).status,200,`test ${index} of 5 in the window`);
  check([await counts(),received.length-sentBefore],[start.map(n=>n+5),5],'five tests: five events, deliveries and audit rows');
  const limited=await post(notifier,{action:'test',id:hookId});
  check([limited.status,limited.body.code,limited.body.messageKey],[429,'RATE_LIMITED','apiError.notify.testRateLimited'],'the sixth test in the window is refused');
  check((await post(notifier,{action:'test',id:teams.body.id})).status,429,'the limit holds across channels');
  check([await counts(),received.length-sentBefore,await attemptsOf(notifier)],[start.map(n=>n+5),5,7],'refused tests send nothing and write no row, and count as attempts');
  check((await post(notifier,{action:'test',id:uuid()})).status,404,'an unknown channel answers 404 before the limit');
  check((await post(notifier,{action:'test',id:'nope'})).status,400,'an invalid id answers 400 before the limit');
  check((await post(operator,{action:'test',id:hookId})).status,403,'the right comes first');
  await d.exec(sql`UPDATE notification_test_limits SET window_at=window_at-61000 WHERE principal=${notifier.principal}`);
  check([(await post(notifier,{action:'test',id:hookId})).status,await attemptsOf(notifier)],[200,1],'after the window a test passes again and a new window starts');
  // Two parallel tests at 4 attempts: the reservation is one atomic upsert, so only one passes.
  await d.exec(sql`UPDATE notification_test_limits SET attempts=4,window_at=${Date.now()} WHERE principal=${notifier.principal}`);
  const sentParallel=received.length;
  const parallel=await Promise.all([post(notifier,{action:'test',id:hookId}),post(notifier,{action:'test',id:hookId})]);
  check([parallel.map(result=>result.status).sort(),received.length-sentParallel,await attemptsOf(notifier)],[[200,429],1,6],'two parallel tests at 4 attempts: one passes');

  // ---- test: write guard at the reservation and at the commit ----
  const session=who=>insertRow(d,'mfa_sessions',{token_hash:sha(who.id+'mfa'),principal:who.principal,created_at:time,last_activity:time,idle_expires_at:time+day,expires_at:time+day});
  const endSession=who=>d.exec(sql`DELETE FROM mfa_sessions WHERE principal=${who.principal}`);
  const tester=await actor('tester@notify.test',['portal.notifications.manage']);
  const guardStart=await counts(),guardSent=received.length;
  await endSession(tester);
  const fenced=await post(tester,{action:'test',id:hookId});
  check([fenced.status,fenced.body.code,await counts(),received.length-guardSent,await attemptsOf(tester)],[403,'FORBIDDEN',guardStart,0,null],'an ended session: 403 at the reservation, nothing sent, no limit row');
  await session(tester);
  // The session ends while the target answers: the message went out, but no row commits.
  behaviour=(request,response)=>{void endSession(tester).then(()=>{response.writeHead(204);response.end();});};
  const ended=await post(tester,{action:'test',id:hookId});
  check([ended.status,ended.body.code,await counts(),received.length-guardSent,await attemptsOf(tester)],[403,'FORBIDDEN',guardStart,1,1],'the session ended during the send: 403 and no event, delivery or audit row');
  await session(tester);
  // The right is removed while the target answers.
  behaviour=(request,response)=>{void d.exec(sql`DELETE FROM role_assignments WHERE principal_type='user' AND principal_id=${tester.id}`).then(()=>{response.writeHead(204);response.end();});};
  const revoked=await post(tester,{action:'test',id:hookId});
  check([revoked.status,revoked.body.code,await counts(),received.length-guardSent],[403,'FORBIDDEN',guardStart,2],'the right removed during the send: 403 and no event, delivery or audit row');
  // A failing audit insert rolls back the event and the delivery.
  behaviour=(request,response)=>{response.writeHead(204);response.end();};
  await resetLimits();
  await createTrigger(d,'notify_test_audit_failure','audit','BEFORE INSERT',{message:'fixture-audit-failure'});
  try{
   const auditStart=await counts(),failed=await post(notifier,{action:'test',id:hookId});
   check([failed.status,await counts()],[500,auditStart],'a failing audit insert rolls back the event and the delivery');
  }finally{await dropTrigger(d,'notify_test_audit_failure','audit');}

  // ---- test: one audit row per test ----
  const testAudits=await d.query(sql`SELECT target,scope,customer_id AS "customerId" FROM audit WHERE action='notification-channel.test' ORDER BY id`);
  const routeTests=Number((await d.one(sql`SELECT count(*) AS n FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id WHERE e.kind='test' AND d.id<>${deliveryId}`)).n);
  check([testAudits.length,testAudits.every(row=>row.scope==='portal'&&row.customerId===null)],[routeTests,true],'exactly one portal audit row per logged test');
  const auditTargets=testAudits.map(row=>JSON.parse(row.target));
  check(auditTargets.slice(0,2),[{id:smtpId,name:'Ops mail',type:'smtp',status:'sent'},{id:smtpId,name:'Ops mail',type:'smtp',status:'failed',errorKey:'apiError.notify.authFailed'}],'the target names the channel and the result, a failure also its key');
  check(auditTargets.every(target=>JSON.stringify(Object.keys(target))===JSON.stringify(target.status==='failed'?['id','name','type','status','errorKey']:['id','name','type','status'])),true,'no other field in any test row');
  noLeak(testAudits,'the test audit rows');
 }finally{target.close();}


 // ---- Sign-in Microsoft 365 and Google Workspace ----
 const providers=await fakeProviders(),msTokens=[];
 providers.on('login.microsoftonline.com',()=>{const value=`ms-channel-token-${msTokens.length+1}`;msTokens.push(value);leaks.push(value);return [200,{token_type:'Bearer',expires_in:3600,access_token:value}];});
 let graphAnswer=[202,''];providers.on('graph.microsoft.com',()=>graphAnswer);
 providers.on('oauth2.googleapis.com',()=>[200,{access_token:'ya29.channel-token-77',expires_in:3599,token_type:'Bearer'}]);
 leaks.push('ya29.channel-token-77');
 const gmail=await fakeSmtp({implicitTls:true,starttls:false,oauth:{user:'alerts@example.com',token:'ya29.channel-token-77'},tls:{key:providerTls.key,cert:providerTls.cert}});
 const mfaSmtp=await fakeSmtp({starttls:true,auth:{user:'mfa-user',pass:'right'},authFailure:'535 5.7.139 Authentication unsuccessful, the request did not meet the criteria to be authenticated successfully. Contact your administrator.'});
 const oauth=load('lib/server/notifications/notify/oauth.ts',imports);
 send.useTransportOptions({...providerOptions({httpsPort:providers.port,smtpPort:gmail.port}),sleep:async()=>{}});
 let msId,googleId,mfaId;
 try{
  const auditCount=async()=>(await audits()).length;
  const refuse=async(payload,field,label)=>{const result=await change(notifier,payload);check([result.status,result.body.code,result.body.messageKey,result.body.params],[400,'NOTIFY_CHANNEL_INVALID','apiError.notify.channelInvalid',{field}],label);};
  // Microsoft 365: validation.
  const msSecret='Ms~Secret.Value_123';leaks.push(msSecret);
  const msInput={action:'create',type:'smtp',auth:'microsoft365',name:'M365 mail',from:'alerts@contoso.com',recipients:['ops@contoso.com'],tenantId:'contoso.onmicrosoft.com',clientId:'3f2504e0-4f89-11d3-9a0c-0305e82c3301',clientSecret:msSecret};
  const auditsBefore=await auditCount();
  await refuse({...msInput,auth:'oauth'},'auth','an unknown sign-in');
  for(const tenantId of ['','contoso','not a domain','contoso.com.',Array.from({length:5},()=>'a'.repeat(60)).join('.')+'.com','contoso.com/../x'])await refuse({...msInput,tenantId},'tenantId',`Microsoft 365 refuses the tenant ${JSON.stringify(tenantId.slice(0,24))}`);
  for(const clientId of [undefined,'','3f2504e0','3f2504e0-4f89-11d3-9a0c-0305e82c330g','contoso.onmicrosoft.com'])await refuse({...msInput,clientId},'clientId',`Microsoft 365 refuses the client ID ${JSON.stringify(clientId)}`);
  await refuse({...msInput,clientSecret:undefined},'clientSecret','create needs the client secret');
  await refuse({...msInput,clientSecret:''},'clientSecret','an empty client secret on create');
  await refuse({...msInput,clientSecret:'x'.repeat(513)},'clientSecret','a client secret over 512 characters');
  await refuse({...msInput,clientSecret:'a\nb'},'clientSecret','a client secret with a control character');
  for(const [field,value] of [['host','smtp.office365.com'],['port',587],['tls','starttls'],['username','mailer'],['password','p'],['serviceAccountKey','{}']])await refuse({...msInput,[field]:value},field,`Microsoft 365 refuses ${field}`);
  await refuse({...msInput,from:'not-an-address'},'from','Microsoft 365 needs a sender');
  await refuse({...msInput,recipients:[]},'recipients','Microsoft 365 needs recipients');
  // Google Workspace: validation.
  const pemLabel='PRIVATE'+' KEY',key=serviceAccountKeyFile({clientEmail:'mailer@project-1.iam.gserviceaccount.com'});
  leaks.push(key.privateKeyId,key.privateKey.split('\n')[1],key.privateKey.split('\n')[2]);
  const gInput={action:'create',type:'smtp',auth:'google',name:'Workspace mail',from:'alerts@example.com',recipients:['ops@example.com'],serviceAccountKey:key.text};
  const without=name=>{const file={...key.file};delete file[name];return JSON.stringify(file);};
  for(const [label,serviceAccountKey] of [['no key',undefined],['an empty key',''],['no JSON','not json'],['a JSON array','[]'],['another type',JSON.stringify({...key.file,type:'authorized_user'})],['no client_email',without('client_email')],['a bad client_email',JSON.stringify({...key.file,client_email:'mailer'})],
   ['no private_key_id',without('private_key_id')],['no private_key',without('private_key')],['a broken private_key',JSON.stringify({...key.file,private_key:`-----BEGIN ${pemLabel}-----\nAAAA\n-----END ${pemLabel}-----\n`})],
   ['an EC key',serviceAccountKeyFile({keyType:'ec'}).text],['a key over 16 KiB',JSON.stringify({...key.file,padding:'x'.repeat(16*1024)})],['a number',42]])
   await refuse({...gInput,serviceAccountKey},'serviceAccountKey',`Google refuses ${label}`);
  for(const [field,value] of [['host','smtp.gmail.com'],['port',465],['tls','tls'],['username','u'],['password','p'],['tenantId','contoso.onmicrosoft.com'],['clientId','3f2504e0-4f89-11d3-9a0c-0305e82c3301'],['clientSecret','x']])await refuse({...gInput,[field]:value},field,`Google refuses ${field}`);
  for(const [field,value] of [['tenantId','contoso.onmicrosoft.com'],['clientId','3f2504e0-4f89-11d3-9a0c-0305e82c3301'],['clientSecret','x'],['serviceAccountKey',key.text]])await refuse({...smtpInput,name:'Password mail',[field]:value},field,`Password refuses ${field}`);
  check(await auditCount(),auditsBefore,'refused sign-in settings write no audit row');

  // Create.
  const createdMs=await change(notifier,msInput);
  check([createdMs.status,createdMs.body.revision,'signingSecret' in createdMs.body],[200,0,false],'a Microsoft 365 channel');
  msId=createdMs.body.id;
  const msRow=await stored(msId);
  check([JSON.parse(msRow.config),msRow.target_hint,msRow.secret.startsWith('k1.')],[{auth:'microsoft365',from:'alerts@contoso.com',recipients:['ops@contoso.com'],tenantId:'contoso.onmicrosoft.com',clientId:'3f2504e0-4f89-11d3-9a0c-0305e82c3301'},'1 recipient via Microsoft 365',true],'stored: the Microsoft 365 config and ciphertext');
  check(await secretOf(msId),{clientSecret:msSecret},'the secret is the client secret, with the channel context');
  const createdGoogle=await change(notifier,gInput);
  check(createdGoogle.status,200,'a Google Workspace channel');
  googleId=createdGoogle.body.id;
  const googleRow=await stored(googleId);
  check([JSON.parse(googleRow.config),googleRow.target_hint],[{auth:'google',from:'alerts@example.com',recipients:['ops@example.com'],serviceAccount:'mailer@project-1.iam.gserviceaccount.com'},'1 recipient via Google Workspace'],'stored: the Google config with the service account, token_uri ignored');
  check(await secretOf(googleId),{privateKey:key.privateKey,privateKeyId:key.privateKeyId},'the secret is the private key and its ID');
  const guidTenant=await change(notifier,{...msInput,name:'M365 by GUID',tenantId:'72F988BF-86F1-41AF-91AB-2D7CD011DB47',recipients:['a@contoso.com','b@contoso.com']});
  check([guidTenant.status,(await stored(guidTenant.body.id)).target_hint],[200,'2 recipients via Microsoft 365'],'a GUID tenant, two recipients');
  check((await change(notifier,{action:'delete',id:guidTenant.body.id,revision:0})).status,200,'and is deleted again');
  // The list: secretSet, the sign-in and no secret.
  const modern=(await list(notifier)).body.channels;
  const msView=modern.find(channel=>channel.id===msId),googleView=modern.find(channel=>channel.id===googleId),passwordView=modern.find(channel=>channel.id===smtpId);
  check([msView.secretSet,msView.config,googleView.secretSet,googleView.config,passwordView.secretSet,passwordView.config.auth,modern.find(channel=>channel.type==='webhook').secretSet],
   [true,{auth:'microsoft365',from:'alerts@contoso.com',recipients:['ops@contoso.com'],tenantId:'contoso.onmicrosoft.com',clientId:'3f2504e0-4f89-11d3-9a0c-0305e82c3301'},true,{auth:'google',from:'alerts@example.com',recipients:['ops@example.com'],serviceAccount:'mailer@project-1.iam.gserviceaccount.com'},true,'password',false],'secretSet and the config of each sign-in, without secrets');
  noLeak(modern,'the list');

  // An old config without auth reads as a password channel; an update without changes writes nothing.
  const old=await stored(smtpId),oldConfig=JSON.parse(old.config);
  check(['auth' in oldConfig,passwordView.config],[false,{auth:'password',...oldConfig}],'the stored password config has no auth and lists as auth password');
  const unchangedStart=await auditCount(),oldRevision=Number(old.revision);
  const same={action:'update',id:smtpId,revision:oldRevision,name:old.name,language:old.language,...oldConfig};
  check([(await change(notifier,same)).body.revision,(await change(notifier,{...same,auth:'password'})).body.revision,await auditCount()],[oldRevision,oldRevision,unchangedStart],'an update without changes, with or without auth, writes no audit row');
  check((await change(notifier,{...same,auth:'password',port:2526})).body.revision,oldRevision+1,'the first real update');
  check([JSON.parse((await audits()).at(-1).target).changed,'auth' in JSON.parse((await stored(smtpId)).config)],[['port'],false],'it does not list auth, and auth stays out of the stored password config');
  await change(notifier,{...same,revision:oldRevision+1});

  // Update: an empty secret keeps it while the sign-in stays.
  const msUpdate={action:'update',id:msId,name:'M365 mail',auth:'microsoft365',from:'alerts@contoso.com',recipients:['ops@contoso.com','oncall@contoso.com'],tenantId:'contoso.onmicrosoft.com',clientId:'3f2504e0-4f89-11d3-9a0c-0305e82c3301'};
  check((await change(notifier,{...msUpdate,revision:0,clientSecret:''})).body.revision,1,'an empty client secret on update');
  check([await secretOf(msId),JSON.parse((await audits()).at(-1).target)],[{clientSecret:msSecret},{id:msId,name:'M365 mail',type:'smtp',changed:['recipients'],old:{recipients:['ops@contoso.com']},new:{recipients:['ops@contoso.com','oncall@contoso.com']}}],'the stored client secret stays, the audit row has no secretChanged');
  check((await change(notifier,{...msUpdate,revision:1,tenantId:'fabrikam.onmicrosoft.com'})).body.revision,2,'an omitted client secret keeps it too');
  check([await secretOf(msId),JSON.parse((await audits()).at(-1).target).old,JSON.parse((await audits()).at(-1).target).new],[{clientSecret:msSecret},{tenantId:'contoso.onmicrosoft.com'},{tenantId:'fabrikam.onmicrosoft.com'}],'the tenant change with old and new value');
  const newMsSecret='Ms~Rotated.Value_456';leaks.push(newMsSecret);
  check((await change(notifier,{...msUpdate,revision:2,tenantId:'fabrikam.onmicrosoft.com',clientSecret:newMsSecret})).body.revision,3,'a new client secret');
  check([await secretOf(msId),JSON.parse((await audits()).at(-1).target)],[{clientSecret:newMsSecret},{id:msId,name:'M365 mail',type:'smtp',changed:[],old:{},new:{},secretChanged:true}],'the new secret replaces the stored one and shows only as secretChanged');
  const keptKey=await change(notifier,{action:'update',id:googleId,revision:0,name:'Workspace mail 2',from:'alerts@example.com',recipients:['ops@example.com'],serviceAccountKey:''});
  check([keptKey.body.revision,await secretOf(googleId),JSON.parse((await stored(googleId)).config).serviceAccount,JSON.parse((await audits()).at(-1).target).changed],[1,{privateKey:key.privateKey,privateKeyId:key.privateKeyId},'mailer@project-1.iam.gserviceaccount.com',['name']],'an empty key keeps the stored key and service account; omitted auth keeps the sign-in');

  // A change of the sign-in needs the secret of the new sign-in and drops the old one.
  const toGoogle={action:'update',id:msId,name:'M365 mail',auth:'google',from:'alerts@example.com',recipients:['ops@example.com']};
  await refuse({...toGoogle,revision:3},'serviceAccountKey','Microsoft 365 to Google without a key');
  await refuse({...toGoogle,revision:3,serviceAccountKey:''},'serviceAccountKey','Microsoft 365 to Google with an empty key');
  const switchKey=serviceAccountKeyFile({clientEmail:'switch@project-2.iam.gserviceaccount.com'});leaks.push(switchKey.privateKeyId,switchKey.privateKey.split('\n')[1]);
  check((await change(notifier,{...toGoogle,revision:3,serviceAccountKey:switchKey.text})).body.revision,4,'Microsoft 365 to Google with a key');
  const switchAudit=JSON.parse((await audits()).at(-1).target);
  check([await secretOf(msId),JSON.parse((await stored(msId)).config),(await stored(msId)).target_hint],[{privateKey:switchKey.privateKey,privateKeyId:switchKey.privateKeyId},{auth:'google',from:'alerts@example.com',recipients:['ops@example.com'],serviceAccount:'switch@project-2.iam.gserviceaccount.com'},'1 recipient via Google Workspace'],'the old client secret is gone, the key is stored');
  check([switchAudit.changed.sort(),switchAudit.old.auth,switchAudit.new.auth,switchAudit.old.tenantId,switchAudit.new.tenantId,switchAudit.old.clientId,switchAudit.new.serviceAccount,switchAudit.old.serviceAccount,switchAudit.secretChanged],
   [['auth','clientId','from','recipients','serviceAccount','tenantId'],'microsoft365','google','fabrikam.onmicrosoft.com',null,'3f2504e0-4f89-11d3-9a0c-0305e82c3301','switch@project-2.iam.gserviceaccount.com',null,true],'the audit row lists auth, tenantId, clientId and serviceAccount with old and new values, the secret only as secretChanged');
  await refuse({...msUpdate,revision:4},'clientSecret','back to Microsoft 365 without a client secret: the old one was dropped');
  check((await change(notifier,{action:'update',id:msId,revision:4,name:'M365 mail',auth:'password',host:'smtp.example.test',port:mfaSmtp.port,tls:'starttls',from:'alerts@example.com',recipients:['ops@example.com']})).body.revision,5,'Google to password without a user name');
  check([(await stored(msId)).secret,JSON.parse((await stored(msId)).config),JSON.parse((await audits()).at(-1).target).secretChanged],[null,{host:'smtp.example.test',port:mfaSmtp.port,tls:'starttls',from:'alerts@example.com',recipients:['ops@example.com'],username:null},true],'the key is dropped, the password config is stored without auth');
  check((await change(notifier,{...msUpdate,revision:5,clientSecret:msSecret})).body.revision,6,'back to Microsoft 365 with a client secret');
  check(await secretOf(msId),{clientSecret:msSecret},'the client secret is stored again');

  // Test messages through the fake token, Graph and SMTP endpoints.
  await resetLimits();
  const msSent=await post(notifier,{action:'test',id:msId});
  const graphRequest=providers.of('graph.microsoft.com').at(-1),tokenRequest=providers.of('login.microsoftonline.com').at(-1);
  check([msSent.status,tokenRequest.path,tokenRequest.form.client_secret,graphRequest.path,graphRequest.headers.authorization],[200,'/contoso.onmicrosoft.com/oauth2/v2.0/token',msSecret,'/v1.0/users/alerts%40contoso.com/sendMail',`Bearer ${msTokens.at(-1)}`],'Microsoft 365: token, then Graph sendMail with the bearer token');
  const graphBody=JSON.parse(graphRequest.body);
  check([graphBody.message.subject,graphBody.message.body.contentType,graphBody.message.toRecipients,graphBody.saveToSentItems],['Test message from Nodiverna','HTML',[{emailAddress:{address:'ops@contoso.com'}},{emailAddress:{address:'oncall@contoso.com'}}],false],'the Graph message');
  graphAnswer=[403,{error:{code:'ErrorAccessDenied',message:'Access is denied. Check credentials and try again.'}}];
  const denied=await post(notifier,{action:'test',id:msId});
  check([denied.status,denied.body.code,denied.body.messageKey,denied.body.params],[422,'NOTIFY_SEND_FAILED','apiError.notify.microsoftPermissionMissing',undefined],'Graph 403: microsoftPermissionMissing');
  graphAnswer=[202,''];
  const googleSent=await post(notifier,{action:'test',id:googleId});
  check([googleSent.status,gmail.xoauth2.at(-1),gmail.messages.length,gmail.messages.at(-1).to],[200,'user=alerts@example.com\x01auth=Bearer ya29.channel-token-77\x01\x01',1,['ops@example.com']],'Google Workspace: XOAUTH2 at smtp.gmail.com:465 and one message');
  const assertion=providers.of('oauth2.googleapis.com').at(-1).form.assertion,[header,claims,signature]=assertion.split('.');
  check([JSON.parse(Buffer.from(header,'base64url')).kid,JSON.parse(Buffer.from(claims,'base64url')).iss,JSON.parse(Buffer.from(claims,'base64url')).sub,crypto.verify('sha256',Buffer.from(`${header}.${claims}`),key.publicKey,Buffer.from(signature,'base64url'))],[key.privateKeyId,'mailer@project-1.iam.gserviceaccount.com','alerts@example.com',true],'the assertion of the stored key');
  // A refused MFA password: 422 with the reason, also in the delivery log.
  const mfa=await change(notifier,{action:'create',type:'smtp',name:'MFA mail',host:'smtp.example.test',port:mfaSmtp.port,tls:'starttls',from:'alerts@example.com',recipients:['ops@example.com'],username:'mfa-user',password:'normal-password-1'});
  leaks.push('normal-password-1');mfaId=mfa.body.id;
  const refused=await post(notifier,{action:'test',id:mfaId});
  check([refused.status,refused.body.code,refused.body.messageKey,refused.body.error],[422,'NOTIFY_SEND_FAILED','apiError.notify.authMfaRequired','The account uses multi-factor authentication, so the server refuses the password. Use an app password, or choose the sign-in Microsoft 365 or Google Workspace.'],'a refused MFA password gives authMfaRequired');
  check(await d.query(sql`SELECT channel_id AS "channelId",status,attempts,error_key AS "errorKey" FROM notification_deliveries WHERE channel_id IN (${msId},${googleId},${mfaId}) ORDER BY created_at,last_attempt_at`),
   [{channelId:msId,status:'sent',attempts:1,errorKey:null},{channelId:msId,status:'failed',attempts:1,errorKey:'apiError.notify.microsoftPermissionMissing'},{channelId:googleId,status:'sent',attempts:1,errorKey:null},{channelId:mfaId,status:'failed',attempts:1,errorKey:'apiError.notify.authMfaRequired'}],'the delivery log has every test with its reason');
  // The Graph JSON is what the 64 KiB limit measures.
  const entries=Array.from({length:25},(_,index)=>({eventId:uuid(),kind:'open',alertId:uuid(),level:'critical',device:{id:`s${index}`,name:`WEB${index}-${'x'.repeat(200)}`},customer:null,ruleId:'cpu',key:'cpu',value:97,threshold:90,closeReason:null,occurredAt:time}));
  const many=Array.from({length:20},(_,index)=>`recipient-${index}-${'r'.repeat(40)}@example.com`);
  const meta={deliveryId:uuid(),time,portal:'https://portal.example.test',origin:'https://portal.example.test',locale:'en'};
  const graphFit=send.fittingMessage('smtp',{kind:'alarms',entries},meta,{auth:'microsoft365',from:'alerts@contoso.com',recipients:many,tenantId:'contoso.onmicrosoft.com',clientId:'3f2504e0-4f89-11d3-9a0c-0305e82c3301'});
  check([JSON.parse(graphFit.body).message.toRecipients.length,Buffer.byteLength(graphFit.body)<=64*1024,JSON.parse(graphFit.body).message.body.content,graphFit.mail.html],[20,true,graphFit.mail.html,graphFit.mail.html],'Microsoft 365: the measured body is the Graph JSON with the HTML part');
  const passwordFit=send.fittingMessage('smtp',{kind:'alarms',entries},meta,{auth:'password',host:'smtp.example.test',port:587,tls:'starttls',from:'a@example.com',recipients:many,username:null});
  check(passwordFit.body,passwordFit.mail.text+passwordFit.mail.html,'a password channel still measures text and HTML');
  const tiny=Array.from({length:25},(_,index)=>({...entries[0],eventId:uuid(),device:{id:`s${index}`,name:`WEB${index}-${'y'.repeat(4000)}`}}));
  const shortened=send.fittingMessage('smtp',{kind:'alarms',entries:tiny},meta,{auth:'microsoft365',from:'alerts@contoso.com',recipients:many,tenantId:'contoso.onmicrosoft.com',clientId:'3f2504e0-4f89-11d3-9a0c-0305e82c3301'});
  check([Buffer.byteLength(shortened.body)<=64*1024,shortened.content.entries.length<25],[true,true],'a large bundle shortens until the Graph JSON fits');
  // No secret or token in answers, audit rows, delivery rows or plain columns.
  noLeak(await d.query(sql`SELECT id,type,name,config,target_hint FROM notification_channels`),'the plain columns');
  noLeak((await d.query(sql`SELECT * FROM notification_deliveries`)).map(row=>({...row})),'the delivery rows');
  noLeak(await audits(),'the audit rows');
  noLeak([msSent.body,denied.body,googleSent.body,refused.body],'the test answers');
  check(oauth.tokenCache.size()>=1,true,'the tokens stay in the memory cache');
 }finally{send.useTransportOptions(transportOptions);await providers.close();await gmail.close();await mfaSmtp.close();}

 // ---- rewrap-secrets ----
 const before=await d.query(sql`SELECT id,secret FROM notification_channels WHERE secret IS NOT NULL ORDER BY id`);
 const summary=await rewrapSecrets(d,{env:{SESSION_SECRET:secretNew,SESSION_SECRET_PREVIOUS:secretOld}});
 check([summary.failed,summary.rewrapped>=before.length],[0,true],'rewrap-secrets re-encrypts every channel secret');
 ring=createKeyring({SESSION_SECRET:secretNew});
 for(const row of before){const after=await stored(row.id);assert.notEqual(after.secret,row.secret);JSON.parse(await decryptWithKeyring(ring,after.secret,`notification-channel:${row.id}`));checks++;}
 check((await list(notifier)).status,200,'the channels stay readable under the new secret');
 check([Object.keys(await secretOf(msId)),Object.keys(await secretOf(googleId))],[['clientSecret'],['privateKey','privateKeyId']],'rewrap-secrets keeps the client secret and the service account key');
}finally{await d.close();}

console.log(`PASS notification channels (${checks} checks): create, update, delete per type, validation, no secrets in answers, audit or columns, encrypted secrets with context, revision 409, right and live MFA session without step-up, audit rollback, rule cascade, SMTP over STARTTLS/TLS with AUTH and its failures, signed webhook, Teams card, Discord type, URL rule and embeds, error keys incl. httpRejected, test rate limit, test audit rows and write guard, Microsoft 365 and Google Workspace sign-ins, MFA error, rewrap-secrets.`);
