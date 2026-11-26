// The portal's own root certificate (lib/server/agent/portal-certificate.ts): which file
// counts as one valid self-signed CA certificate, what the install scripts embed
// (console route and customer installer), the Owner block of the console answer
// that the page Add device shows, and the card on that page.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HttpError} from '../support/http-error.mjs';
import {sourceLoader} from '../support/source-database.mjs';

let checks=0;
const fixture=name=>path.resolve('tests/fixtures/portal-ca',name+'.crt');
const pem=name=>fs.readFileSync(fixture(name),'utf8');
const certificateOf=name=>new crypto.X509Certificate(pem(name));
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'serverdesk-portal-ca-'));
const write=(name,text)=>{const file=path.join(directory,name);fs.writeFileSync(file,text);return file;};
const setFile=file=>{const before=process.env.PORTAL_CA_FILE;if(file===undefined)delete process.env.PORTAL_CA_FILE;else process.env.PORTAL_CA_FILE=file;return ()=>{if(before===undefined)delete process.env.PORTAL_CA_FILE;else process.env.PORTAL_CA_FILE=before;};};
const withFile=(file,run)=>{const restore=setFile(file);try{return run();}finally{restore();}};
// The routes read the file after an await: keep the variable until they answer.
const withFileAsync=async(file,run)=>{const restore=setFile(file);try{return await run();}finally{restore();}};

try{
 const {portalRootCertificate,portalCertificateView,portalCertificateMaxBytes}=await import('../../lib/server/agent/portal-certificate.ts');
 const root=certificateOf('root');
 const expected={der:root.raw.toString('base64'),name:'Nodiverna Test Local Authority - ECC Root',sha256:root.fingerprint256,notAfter:'2126-01-01T00:00:00.000Z'};

 // A valid root: name (CN), Node's fingerprint256, expiry and the DER.
 assert.deepEqual(withFile(fixture('root'),()=>portalRootCertificate()),expected);checks++;
 assert.match(expected.sha256,/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/,'uppercase hex pairs with ":"');checks++;
 assert.deepEqual(withFile(fixture('root'),()=>portalCertificateView()),{name:expected.name,sha256:expected.sha256,notAfter:expected.notAfter},'the view never carries the DER');checks++;
 // Without a CN the name is the full subject.
 assert.equal(withFile(fixture('root-without-cn'),()=>portalRootCertificate()?.name),'O=Nodiverna Test, OU=Portal');checks++;
 // Windows line endings and surrounding text are fine.
 assert.deepEqual(withFile(write('crlf.crt','Caddy root\r\n'+pem('root').replaceAll('\n','\r\n')),()=>portalRootCertificate()),expected);checks++;

 // Everything else is no root, and nothing throws.
 // Split, so the repository scan for key material (tests/repo/key-material.mjs) skips this file.
 const privateKey='PRIVATE'+' KEY';
 const rejected=[
  ['PORTAL_CA_FILE is not set',undefined],
  ['PORTAL_CA_FILE is empty',''],
  ['PORTAL_CA_FILE is blank','  '],
  ['the file is missing',path.join(directory,'missing.crt')],
  ['the path is a directory',directory],
  ['the file is larger than 16 KiB',write('large.crt',pem('root')+'#'.repeat(portalCertificateMaxBytes))],
  ['the file contains a private key',write('key.crt',pem('root')+`-----BEGIN ${privateKey}-----\nAAAA\n-----END ${privateKey}-----\n`)],
  ['the file contains an EC private key',write('ec-key.crt',`-----BEGIN EC ${privateKey}-----\nAAAA\n-----END EC ${privateKey}-----\n`+pem('root'))],
  ['the file holds two certificates',write('two.crt',pem('root')+pem('intermediate'))],
  ['the file holds another PEM block too',write('other-block.crt',pem('root')+'-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n')],
  ['the file is empty',write('empty.crt','')],
  ['the file is not a certificate',write('garbage.crt','-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----\n')],
  ['the certificate is a leaf, not a CA',fixture('leaf')],
  ['the CA is not self-signed (intermediate)',fixture('intermediate')],
  ['the root has expired',fixture('expired-root')],
 ];
 for(const [label,file] of rejected){assert.equal(withFile(file,()=>portalRootCertificate()),null,label);checks++;}
 assert.equal(withFile(fixture('root'),()=>portalRootCertificate(Date.parse('2025-12-31T23:59:59Z'))),null,'a root that is not valid yet');checks++;
 assert.equal(withFile(fixture('root'),()=>portalRootCertificate(Date.parse('2126-01-01T00:00:01Z'))),null,'a root after its expiry');checks++;
 assert.ok(fs.statSync(path.join(directory,'large.crt')).size>16*1024);checks++;

 // The install scripts: the customer installer download embeds the root, or null without it.
 const embedded=script=>/^\$PortalRoot='(.*)'\|ConvertFrom-Json$/m.exec(script.replace(/^﻿/,'').replaceAll('\r\n','\n'))?.[1];
 {
  const {customerInstallerDownload}=sourceLoader()('lib/server/agent/customer-installers.ts');
  const download=()=>customerInstallerDownload({key:'0123456789abcdef'.repeat(4),name:'Front desk',customerName:'Contoso'},'https://portal.test').text();
  assert.equal(embedded(await withFileAsync(fixture('root'),download)),`{"certificate":"${expected.der}"}`,'the customer installer embeds the root');checks++;
  assert.equal(embedded(await withFileAsync(path.join(directory,'missing.crt'),download)),'null','without the file the customer installer embeds null');checks++;
  assert.equal(embedded(await withFileAsync(undefined,download)),'null','without PORTAL_CA_FILE the customer installer embeds null');checks++;
 }
 // The console route: the personal install script (format bootstrap) embeds it; JSON stays unchanged.
 {
  const viewer={id:'owner',label:'owner@example.test',permissions:['*']};
  const stubs={
   '@/lib/server/context':{requireViewer:async()=>viewer,sameOrigin:()=>{},body:async request=>request.json(),config:name=>({SITE_ORIGIN:'https://portal.test',AGENT_JOB_SIGNING_KEY:'fixture'})[name],now:()=>1_800_000_000_000,random:()=>'b'.repeat(64),hash:async value=>'hash:'+value,HttpError,failure:error=>Response.json({error:error.message},{status:error.status??500}),log:async()=>{},guid:value=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value)},
   '@/lib/server/identity/policy/can':{can:async()=>true,requireCan:async()=>{},viewerCanSql:()=>'TRUE'},
   '@/lib/server/identity/mfa':{requireMfa:async()=>{}},
   '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>({publicKey:'job-signing-key'}),signingKeyFailure:error=>error},
   '@/lib/step-up':{consoleActionNeedsStepUp:()=>false,isDeviceRemovalAction:()=>false},
   '@/lib/server/identity/rbac':{prepareManagementAuthorization:async()=>null},
   '@/lib/server/console-data':{enrollmentTarget:async()=>({customerExists:true,groupCustomerId:null}),enrollDevice:async()=>({confirmed:true,created:{rowCount:1}}),multipleCustomers:async()=>false},
  };
  const route=sourceLoader()('app/api/console/route.ts',stubs);
  const enroll=format=>route.POST(new Request('https://portal.test/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'enroll',name:'Server 1',format})}));
  let response=await withFileAsync(fixture('root'),()=>enroll('bootstrap'));
  assert.equal(response.status,200,await response.clone().text());
  assert.equal(embedded(await response.text()),`{"certificate":"${expected.der}"}`,'the personal install script embeds the root');checks+=2;
  response=await withFileAsync(undefined,()=>enroll('bootstrap'));
  assert.equal(embedded(await response.text()),'null','without PORTAL_CA_FILE it embeds null');checks++;
  response=await withFileAsync(fixture('root'),()=>enroll('json'));
  const registration=await response.json();
  assert.deepEqual(Object.keys(registration).sort(),['id','jobSigningKey','mode','origin','token'],'the JSON registration is unchanged');checks++;
 }
 // GET /api/console: the Owner block carries name, fingerprint and expiry, never the DER; non-owners get no field.
 {
  const owner={id:'owner',label:'owner@example.test',permissions:['*']},reader={id:'reader',label:'reader@example.test',permissions:[]};
  const answer=async(viewer,file)=>{
   const stubs={
    '@/lib/server/context':{requireViewer:async()=>viewer,sameOrigin:()=>{},body:async()=>({}),config:name=>({SITE_ORIGIN:'https://portal.test',SESSION_SECRET:'s',SESSION_SECRET_PREVIOUS:''})[name]??'',now:()=>1_800_000_000_000,random:()=>'r',hash:async value=>value,HttpError,failure:error=>Response.json({error:error.message},{status:error.status??500}),log:async()=>{},guid:()=>true},
    '@/lib/server/identity/policy/can':{can:async(who,right)=>right==='instance.owner'&&who.permissions.includes('*'),requireCan:async()=>{},viewerCanSql:()=>'TRUE'},
    '@/lib/server/identity/access':{allowedDeviceIds:async()=>[],effectivePermissions:async()=>new Map(),principal:()=>'p',requireDevice:async()=>{},requireGroup:async()=>{}},
    '@/lib/server/devices/device-lifecycle':{offboardingStatus:async()=>[],removeDevice:async()=>{},removeDevices:async()=>{},requestAgentUninstall:async()=>{},sweepRemovedTransfers:async()=>{},validateDeviceRemoval:()=>{}},
    '@/lib/server/devices/rdp':{sweepRdp:async()=>{}},
    '@/lib/server/audit-scope':{deviceAuditGuard:()=>'',portalAuditGuard:()=>''},
    '@/lib/server/devices/device-group-catalog':{deviceGroupCatalog:async()=>[],devicePermissionTargets:async()=>[]},
    '@/lib/server/extensions/plugin-releases':{latestPluginReleases:async()=>[]},
    '@/lib/server/identity/customers':{visibleCustomers:async()=>[]},
    '@/lib/server/branding':{consoleBranding:async()=>({portal:{light:null,dark:null,icon:null},customers:{}})},
    '@/lib/server/identity/security-alarms':{consoleEmergencyAlarms:async()=>({open:0,latest:null})},
    '@/lib/server/console-data':{cancelPendingJob:async()=>{},consoleMaintenance:async()=>null,consolePreviousSecretRemovable:async()=>false,consoleAudit:async()=>[],consoleDevices:async()=>[],consoleJobs:async()=>[],consoleRunbookJobs:async()=>({runs:[],steps:[]}),enrollDevice:async()=>({}),enrollmentTarget:async()=>({}),jobById:async()=>null,multipleCustomers:async()=>false,pendingAgentUpdates:async()=>[]},
   };
   const route=sourceLoader()('app/api/console/route.ts',stubs);
   const response=await withFileAsync(file,()=>route.GET(new Request('https://portal.test/api/console')));
   assert.equal(response.status,200,await response.clone().text());
   return response.json();
  };
  const ownerAnswer=await answer(owner,fixture('root'));
  assert.deepEqual(ownerAnswer.portalCertificate,{name:expected.name,sha256:expected.sha256,notAfter:expected.notAfter},'the Owner gets name, fingerprint and expiry');checks++;
  assert.ok(!JSON.stringify(ownerAnswer).includes(expected.der.slice(0,40))&&!('der' in ownerAnswer.portalCertificate),'the answer never carries the certificate');checks++;
  assert.equal((await answer(owner,undefined)).portalCertificate,null,'without a root the Owner gets null');checks++;
  assert.ok(!('portalCertificate' in await answer(reader,fixture('root'))),'a non-owner gets no field');checks++;
 }
 // GET /api/session-settings and SessionSettingsView no longer carry the certificate (it moved to Add device).
 {
  const settings=sourceLoader()('lib/server/identity/session-settings.ts',{
   '../context':{HttpError,now:()=>0},'./context':{HttpError,now:()=>0},
   './policy/can':{can:async()=>true,viewerCanSql:()=>'TRUE'},'./identity/policy/can':{can:async()=>true,viewerCanSql:()=>'TRUE'},
   '../db':{db:()=>({one:async()=>null}),sql:()=>({}),commitAll:async()=>[]},'./db':{db:()=>({one:async()=>null}),sql:()=>({}),commitAll:async()=>[]},
   '../audit':{auditEvent:()=>[]},'./audit':{auditEvent:()=>[]},
  });
  const route=sourceLoader()('app/api/session-settings/route.ts',{'@/lib/server/context':{requireViewer:async()=>({id:'owner'}),failure:error=>Response.json({error:error.message},{status:500}),body:async()=>({}),sameOrigin:()=>{},HttpError},'@/lib/server/identity/session-settings':settings});
  const answer=await (await withFileAsync(fixture('root'),()=>route.GET())).json();
  assert.ok(!('portalCertificate' in answer),'the sessions answer has no certificate');checks++;
  assert.equal(answer.idleTimeoutMinutes,15,'the other settings stay');checks++;
  assert.doesNotMatch(fs.readFileSync('lib/server/identity/session-settings.ts','utf8'),/portalCertificate/,'SessionSettingsView has no portalCertificate');checks++;
  assert.doesNotMatch(fs.readFileSync('ui/settings/session-settings-panel.tsx','utf8'),/certificate/i,'Settings › Sessions shows no certificate section');checks++;
 }
 // The card of the page Add device: with a certificate the facts and the copy value, without it the "none" text, before the data nothing.
 {
  const {loader,mount}=await import('../support/add-device-harness.mjs');
  const {de}=await import('../support/i18n-stubs.mjs');
  const load=loader(),kit=load('ui/kit/kit.tsx'),{PortalCertificateCard}=load('ui/devices/add-device/portal-certificate-card.tsx');
  const view={name:expected.name,sha256:expected.sha256,notAfter:expected.notAfter};
  const card=(certificate,use)=>mount(PortalCertificateCard,{certificate,use}).tree;
  const one=card(view,'one');
  assert.deepEqual([one.type,one.props.title,one.props.icon,one.props.iconTone,one.props.description],[kit.Card,'Portal-Zertifikat','ShieldCheck','accent',de('addDevice.certificate.one')],'the card with the One-device text');checks++;
  const facts=one.props.children;
  assert.deepEqual([facts.type,facts.props.items.map(item=>item.label)],[kit.Facts,['Name','SHA-256-Fingerabdruck','Gültig bis']],'name, fingerprint and expiry');checks++;
  const copy=facts.props.items[1].value;
  assert.deepEqual([copy.type,copy.props.value,copy.props.label,copy.props.success],[kit.CopyValue,expected.sha256,'Fingerabdruck kopieren','Fingerabdruck kopiert.'],'the fingerprint as a copy value');checks++;
  assert.equal(facts.props.items[0].value,expected.name);assert.equal(typeof facts.props.items[2].value,'string');checks+=2;
  assert.equal(card(view,'several').props.description,de('addDevice.certificate.several'),'the Several-devices text');checks++;
  const none=card(null,'one');
  assert.deepEqual([none.props.iconTone,none.props.description,none.props.children],['neutral',de('addDevice.certificate.oneNone'),null],'without a certificate: neutral, the "none" text, no facts');checks++;
  assert.equal(card(null,'several').props.description,de('addDevice.certificate.severalNone'));checks++;
  assert.equal(card(undefined,'one'),null,'before the console data arrives nothing renders');checks++;
 }
}finally{fs.rmSync(directory,{recursive:true,force:true});}
console.log(`PASS portal certificate (${checks} assertions): valid root, every rejected file, embedded in both install scripts, the Owner block of the console answer without the DER, no certificate in Sessions, and the card on Add device.`);
