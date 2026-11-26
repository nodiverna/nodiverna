// The AD sign-in for plugin changes without a database (lib/plugin-ad.ts,
// docs/plugin-ad-sign-in.md): the account forms per directory, the session
// match by directory SID, the lifetime, which operations need the account,
// the actAs shape, the Entra ID mapping, the client codes, the blocked
// reasons of the account chip and the job requirements of ad-sign-in.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const ad=await import('../../lib/plugin-ad.ts');
const {pluginOperations,DHCP_CHANGE_OPERATIONS}=await import('../../lib/plugin-catalog.ts');
const {jobRequirements,jobParametersFromTarget,jobViewRequirements}=await import('../../lib/jobs/requirements.ts');
const {pluginJobLabelKey}=await import('../../lib/job-display.ts');
const {opensAdSignIn,opensMfaPrompt,errorCatalog}=await import('../../lib/errors/codes.ts');
const {apiErrorCodes}=await import('../../lib/errors/api-error-keys.ts');
const {translate}=await import('../../lib/i18n/translate.ts');
const {telemetry}=await import('../../lib/server/agent/telemetry.ts');
const {parseAdAccount,adSessionFor,adSessionExpiry,pluginOperationNeedsAccount,adActAs,entraAdIdentity,pluginAccountBlocked,deviceDirectory,AD_SESSION_LIFETIME_MS}=ad;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const domain={kind:'domain',name:'corp.example',netbiosName:'CORP',sid:'S-1-5-21-1000-2000-3000'};
const local={kind:'local',name:'WG1',netbiosName:'WG1',sid:'S-1-5-21-4000-5000-6000'};

// ---- parseAdAccount -------------------------------------------------------------------------
check(parseAdAccount('CORP\\anna',domain,'SRV-DC01'),{ok:true,account:'CORP\\anna',domain:'CORP',user:'anna',upn:false},'DOMAIN\\name');
check(parseAdAccount('  anna@corp.example ',domain,'SRV-DC01'),{ok:true,account:'anna@corp.example',domain:null,user:'anna@corp.example',upn:true},'a UPN, trimmed');
check(parseAdAccount('anna',domain,'SRV-DC01'),{ok:true,account:'CORP\\anna',domain:'CORP',user:'anna',upn:false},'a plain name becomes NETBIOS\\name');
check(parseAdAccount('admin',local,'WG1'),{ok:true,account:'WG1\\admin',domain:'WG1',user:'admin',upn:false},'a plain name on a workgroup server');
check(parseAdAccount('.\\admin',local,'WG1'),{ok:true,account:'WG1\\admin',domain:'WG1',user:'admin',upn:false},'.\\name on a workgroup server');
check(parseAdAccount('wg1\\admin',local,'WG1').ok,true,'COMPUTER\\name on a workgroup server, case-insensitive');
check(parseAdAccount('CORP\\anna',local,'WG1'),{ok:false,code:'invalid'},'another domain on a workgroup server');
check(parseAdAccount('anna@corp.example',local,'WG1'),{ok:false,code:'invalid'},'a UPN on a workgroup server');
check(parseAdAccount('.\\admin',domain,'SRV-DC01'),{ok:false,code:'localOnDomain'},'.\\name on a domain server');
check(parseAdAccount('srv-dc01\\admin',domain,'SRV-DC01'),{ok:false,code:'localOnDomain'},'the computer name as DOMAIN on a domain server');
check(parseAdAccount('a'.repeat(257),domain),{ok:false,code:'tooLong'},'more than 256 characters: tooLong');
check(parseAdAccount('CORP\\'+'a'.repeat(300)+'\u0007',domain),{ok:false,code:'tooLong'},'a long input is tooLong before any other check');
check(parseAdAccount('a'.repeat(256),domain).ok,true,'256 characters');
check(parseAdAccount('  '+'a'.repeat(256)+'  ',domain).ok,true,'256 characters with spaces around them');
check([ad.adAccountTooLong('a'.repeat(257)),ad.adAccountTooLong(' '+'a'.repeat(257)+' '),ad.adAccountTooLong('a'.repeat(256)),ad.adAccountTooLong('  '+'a'.repeat(256)+'  '),ad.adAccountTooLong(''),ad.adAccountTooLong(null)],[true,true,false,false,false,false],'adAccountTooLong: more than 256 characters once trimmed');
check([ad.adSignInField(undefined,'apiError.pluginAd.accountTooLong'),ad.adSignInField(undefined,'apiError.pluginAd.signInRunning'),ad.adSignInField(undefined,'apiError.pluginAd.tooManyAttempts')],['account','notice','notice'],'adSignInField: too long under Account, a running sign-in and the rate limit as a notice');
check(parseAdAccount('CORP\\an\u0007na',domain),{ok:false,code:'invalid'},'a control character');
check(parseAdAccount('CORP\\an\nna',domain),{ok:false,code:'invalid'},'a line break');
for(const bad of ['','   ','CORP\\','\\anna','anna@','@corp.example','CORP\\an\\na','an@na@corp.example',42,null])check(parseAdAccount(bad,domain).ok,false,`refused: ${JSON.stringify(bad)}`);

// ---- adSessionFor and the lifetime ----------------------------------------------------------
const now=Date.UTC(2026,10,9,12);
const session=(extra={})=>({id:'s1',state:'active',directorySid:domain.sid,expiresAt:now+60_000,mfaLive:true,...extra});
check(adSessionFor([session()],domain,now)?.id,'s1','the same SID matches');
check(adSessionFor([session({directorySid:domain.sid.toLowerCase().replace('s-','s-')})],{sid:domain.sid.toLowerCase()},now)?.id,'s1','the SID compares case-insensitive');
check(adSessionFor([session({directorySid:'S-1-5-21-9-9-9'})],domain,now),null,'the same name with another SID does not match');
check(adSessionFor([session({expiresAt:now})],domain,now),null,'expired');
check(adSessionFor([session({state:'pending'})],domain,now),null,'pending');
check(adSessionFor([session({mfaLive:false})],domain,now),null,'a portal session that ended');
check(adSessionFor([session()],null,now),null,'a device without a directory');
check(adSessionExpiry(now,now+24*3600_000),now+AD_SESSION_LIFETIME_MS,'8 hours after the check');
check(adSessionExpiry(now,now+3600_000),now+3600_000,'or the end of the portal session');
check(AD_SESSION_LIFETIME_MS,8*3600_000,'8 hours');

// ---- Which operations need the account ------------------------------------------------------
for(const [operation,definition] of Object.entries(pluginOperations))check(pluginOperationNeedsAccount(operation),!definition.readOnly,`${operation}: ${definition.readOnly?'a read runs as SYSTEM':'a change needs the account'}`);
check(DHCP_CHANGE_OPERATIONS.every(pluginOperationNeedsAccount),true,'every DHCP change');
check([pluginOperationNeedsAccount('dhcp-read'),pluginOperationNeedsAccount('dns-write'),pluginOperationNeedsAccount(undefined)],[false,false,false],'a read and unknown operations');

// ---- actAs ----------------------------------------------------------------------------------
check(adActAs({id:'s1',userSid:domain.sid+'-1105',account:'CORP\\anna',upn:'anna@corp.example',directoryKind:'domain'}),{sessionId:'s1',userSid:domain.sid+'-1105',logonName:'anna@corp.example',account:'CORP\\anna',kind:'domain'},'actAs: the UPN as logon name');
check(adActAs({id:'s2',userSid:local.sid+'-500',account:'WG1\\admin',upn:null,directoryKind:'local'}).logonName,'WG1\\admin','without a UPN: DOMAIN\\name');

// ---- Entra ID mapping -----------------------------------------------------------------------
check(entraAdIdentity({onPremisesSecurityIdentifier:'S-1-5-21-1000-2000-3000-1105',onPremisesDomainName:'corp.example',onPremisesSamAccountName:'anna',onPremisesUserPrincipalName:'anna@corp.example'}),
 {directory:{kind:'domain',name:'corp.example',netbiosName:'CORP',sid:'S-1-5-21-1000-2000-3000'},userSid:'S-1-5-21-1000-2000-3000-1105',account:'corp.example\\anna',upn:'anna@corp.example'},'the domain SID is the user SID without its RID');
check(entraAdIdentity({onPremisesDomainName:'corp.example',onPremisesSamAccountName:'anna'}),null,'no SID');
check(entraAdIdentity({onPremisesSecurityIdentifier:'S-1-5-21-1000-2000-3000-1105',onPremisesSamAccountName:'anna'}),null,'no domain');
check(entraAdIdentity({onPremisesSecurityIdentifier:'S-1-5-21-1000-2000-3000',onPremisesDomainName:'corp.example',onPremisesSamAccountName:'anna'}),null,'a domain SID is no user SID');
check(entraAdIdentity({onPremisesSecurityIdentifier:'S-1-5-21-1000-2000-3000-1105',onPremisesDomainName:'corp.example',onPremisesUserPrincipalName:'anna@corp.example'})?.account,'anna@corp.example','without a sam account name: the UPN');

// ---- Directory, client codes and the job ------------------------------------------------------
check(deviceDirectory({security:{directory:domain}}),domain,'the reported directory');
check([deviceDirectory({security:{}}),deviceDirectory(null),deviceDirectory({security:{directory:{...domain,sid:'S-1-5-18'}}})],[null,null,null],'no or a broken directory');
check([opensAdSignIn('PLUGIN_AD_SIGN_IN_REQUIRED'),opensAdSignIn('MFA_LOGIN_REQUIRED'),opensMfaPrompt('PLUGIN_AD_SIGN_IN_REQUIRED')],[true,false,false],'opensAdSignIn only for PLUGIN_AD_SIGN_IN_REQUIRED');
check([errorCatalog.PLUGIN_AD_SIGN_IN_REQUIRED.status,apiErrorCodes['apiError.pluginAd.signInRequired'],apiErrorCodes['apiError.pluginAd.tooManyAttempts']],[403,'PLUGIN_AD_SIGN_IN_REQUIRED','RATE_LIMITED'],'the error contract');
check(jobRequirements('ad-sign-in',{plugin:'dhcp'}),{known:true,permissions:['dhcp.manage'],managementMode:false,mfa:true,capabilities:['plugin-ad-identity'],privilegedPath:false,securityEvents:false},'ad-sign-in: the manage right of the plugin, MFA, any mode, plugin-ad-identity');
check(jobRequirements('ad-sign-in',{plugin:'wsus'}).known,false,'ad-sign-in of a plugin without changes is unknown');
check(jobParametersFromTarget('ad-sign-in','dhcp/CORP\\anna'),{plugin:'dhcp'},'the plugin comes back from the target');
check(jobViewRequirements('ad-sign-in',{},{target:'dhcp/CORP\\anna'}).permissions,['dhcp.manage'],'a finished sign-in keeps its right');
check([pluginJobLabelKey('ad-sign-in'),translate('en','jobs.kind.adSignIn'),translate('de','jobs.kind.adSignIn')],['jobs.kind.adSignIn','Check AD sign-in','AD-Anmeldung prüfen'],'the job label');

// ---- The blocked reasons of the account chip, in order ------------------------------------------
const gate={permission:'dhcp.manage',rightKey:'dhcp.blocked.manageRight'};
const device={name:'SRV-DC01',lastSeen:now,permissions:['dhcp.manage'],snapshot:{agentCapabilities:['plugin-ad-identity']}};
const viewer={permissions:[]};
check(pluginAccountBlocked({...device,permissions:[],snapshot:{agentCapabilities:[]}},viewer,true,false,gate),{key:'kit.unavailable.demo'},'1. demo first');
check(pluginAccountBlocked({...device,permissions:[],snapshot:{agentCapabilities:[]}},viewer,false,false,gate),{key:'dhcp.blocked.manageRight'},'2. no manage right');
check(pluginAccountBlocked({...device,snapshot:{agentCapabilities:[]}},viewer,false,false,gate),{key:'extensions.blocked.offline'},'3. offline');
check(pluginAccountBlocked({...device,snapshot:{agentCapabilities:[]}},viewer,false,true,gate),{key:'pluginAd.blocked.agent',params:{device:'SRV-DC01'}},'4. an agent without plugin-ad-identity');
check(pluginAccountBlocked(device,viewer,false,true,gate),null,'ready');
check(pluginAccountBlocked({...device,permissions:[]},{permissions:['*']},false,true,gate),null,'an Owner holds every right');
// ---- Parity with the agent: the account vectors of agent/v3/PluginSelfTests.cs ------------------------
// The C# self-test runs the same vectors through PluginIdentity.ParseAccount (domain corp.example/CORP on SRV1, workgroup WG1).
{
 const source=fs.readFileSync('agent/v3/PluginSelfTests.cs','utf8');
 const vectors=[...source.matchAll(/^\s*\(@"([^"]*)", "(domain|local)", @"([^"]*)"\),$/gm)].map(match=>match.slice(1));
 assert.ok(vectors.length>=15,'the agent self-test lists the account vectors');
 for(const [input,kind,expected] of vectors){
  const parsed=kind==='domain'?parseAdAccount(input,domain,'SRV1'):parseAdAccount(input,local,'WG1');
  check(parsed.ok?parsed.account:'!'+parsed.code,expected,`the agent vector ${JSON.stringify(input)} (${kind})`);
 }
}

// ---- security.directory in the telemetry (agent 4.19.0) ------------------------------------------------
{
 const base={hostname:'SRV1',os:'Windows Server 2025 Standard',build:'26100',manufacturer:'',model:'',domain:'corp.example',cores:4,memoryGb:16,cpu:5,memory:30,uptimeSeconds:10,rebootPending:false,management:true,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.19.0',mode:'Management',publicKey:{kty:'RSA',n:'a'.repeat(342),e:'AQAB'},agentCapabilities:['plugin-ad-identity']};
 const security=directory=>({...base,security:{domainJoined:true,domainRole:3,rdpEnabled:false,firewall:[],defender:{available:true,enabled:true,signatureAt:'',realTimeProtection:true},lastBoot:'',...(directory===undefined?{}:{directory})}});
 const parsed=value=>telemetry.safeParse(value);
 check(parsed(security(domain)).success,true,'a domain directory');
 check(parsed(security(local)).success,true,'a workgroup directory');
 check(parsed(security(undefined)).success,true,'an agent before 4.19.0 leaves the directory out');
 check(deviceDirectory(parsed(security(domain)).data),domain,'deviceDirectory reads the reported directory');
 for(const [label,directory] of [['another kind',{...domain,kind:'forest'}],['a user SID',{...domain,sid:'S-1-5-21-1-2-3-1105'}],['a well-known SID',{...domain,sid:'S-1-5-32'}],['a long name',{...domain,name:'a'.repeat(257)}],['an empty NetBIOS name',{...domain,netbiosName:''}],['an extra key',{...domain,guid:'x'}],['a missing SID',{kind:'domain',name:'corp.example',netbiosName:'CORP'}]])
  check(parsed(security(directory)).success,false,`security.directory refuses ${label}`);
}
console.log(`PASS plugin AD (${checks} checks): account forms per directory (also the agent's vectors) and the length limit, security.directory, the session match by SID, the lifetime, the operations that need the account, actAs, the Entra mapping, the client codes, the job requirements and the chip gate.`);
