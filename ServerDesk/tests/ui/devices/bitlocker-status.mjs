// BitLocker (docs/device-health-signals.md): the strict telemetry schema, the
// three rules with not available and older agents, the per-volume issue keys,
// the storage and protection labels, the fleet filters and the counts of the
// encryption tab. No database.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
const {telemetry,bitlockerState}=await import('../../../lib/server/agent/telemetry.ts');
const {defaultAlertSettings,evaluateAlertRules}=await import('../../../lib/alert-rules.ts');
const {deviceIssues}=await import('../../../ui/base/ui-device.ts');
const {bitlockerStatus,volumeBitlockerText,bitlockerVolume,encryptionCounts,encryptionRow,suspendedDuration,protectorLabels}=await import('../../../ui/devices/inventory/health-signals.ts');
const {fleetFilterMatch}=await import('../../../ui/devices/fleet/fleet-filters.ts');
const {compareFleetDevices}=await import('../../../ui/devices/fleet/fleet-sort.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const now=Date.parse('2026-10-20T12:00:00.000Z'),day=86400000,iso=offset=>new Date(now-offset).toISOString();
const volume=(drive,volumeType,conversion,protection,protectors=['tpm','numerical-password'],extra={})=>({drive,volumeType,conversion,percent:conversion==='encrypted'?100:conversion==='decrypted'?0:40,protection,method:conversion==='decrypted'?'none':'xts-aes-256',protectors,suspendedSince:null,...extra});
const state=(volumes,extra={})=>({available:true,collectedAt:iso(0),volumes,...extra});
const base={hostname:'H',os:'Windows 11 Pro',build:'26100',manufacturer:'',model:'',domain:'',cores:4,memoryGb:16,cpu:5,memory:30,uptimeSeconds:10,rebootPending:false,management:false,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.10.0',mode:'ReadOnly',publicKey:{kty:'RSA',n:'a'.repeat(342),e:'AQAB'},agentCapabilities:[]};

// ---- Schema ----
const good=state([volume('C:','os','encrypted','on'),volume('D:','fixed','encrypting','on'),volume(null,'removable','decrypted','off',[])]);
check(telemetry.safeParse({...base,bitlocker:good}).success,true,'a valid state');
check(telemetry.safeParse({...base,bitlocker:{available:false,reason:'not-supported',collectedAt:iso(0),volumes:[]}}).success,true,'not available');
check(telemetry.safeParse(base).success,true,'an older agent without bitlocker');
for(const [label,value] of [
 ['a recovery password on a volume',state([{...volume('C:','os','encrypted','on'),recoveryPassword:'123456-654321'}])],
 ['a recovery password on the state',{...good,recoveryPassword:'123456-654321'}],
 ['protector IDs',state([{...volume('C:','os','encrypted','on'),protectorIds:['{ABC}']}])],
 ['an unknown protector',state([volume('C:','os','encrypted','on',['password'])])],
 ['duplicate protectors',state([volume('C:','os','encrypted','on',['tpm','tpm'])])],
 ['an unknown conversion',state([volume('C:','os','scrambled','on')])],
 ['a drive that is no letter',state([volume('C:\\','os','encrypted','on')])],
 ['a percentage above 100',state([volume('C:','os','encrypting','on',['tpm'],{percent:101})])],
 ['an unknown reason',{available:false,reason:'home',collectedAt:iso(0),volumes:[]}],
 ['more than 64 volumes',state(Array.from({length:65},()=>volume('C:','fixed','encrypted','on')))],
])check(telemetry.safeParse({...base,bitlocker:value}).success,false,`rejects ${label}`);
check(bitlockerState.safeParse(good).success,true,'the exported schema');

// ---- Rules ----
const issues=(bitlocker,settings=defaultAlertSettings())=>evaluateAlertRules({lastSeen:now,snapshot:{...base,bitlocker}},settings,now).filter(issue=>issue.ruleId.startsWith('bitlocker'));
const keys=bitlocker=>issues(bitlocker).map(issue=>`${issue.key}:${issue.level}`);
check(keys(good),[],'encrypted system drive with a recovery password: no issue');
check(keys(state([volume('C:','os','decrypted','off',[])])),['bitlocker-system:warning'],'system drive not encrypted: warning');
check(keys(state([volume('C:','os','decrypting','off',[])])),['bitlocker-system:warning'],'decrypting counts as not encrypted');
check(keys(state([volume('C:','os','paused-decrypting','off',[])])),['bitlocker-system:warning'],'paused decrypting counts as not encrypted');
check(keys(state([volume('C:','os','encrypted','suspended',['tpm','numerical-password'],{suspendedSince:iso(2*day)}),volume('D:','fixed','encrypted','suspended')])),['bitlocker-suspended-C::warning','bitlocker-suspended-D::warning'],'one suspended issue per volume');
check(issues(state([volume('C:','os','encrypted','suspended',['tpm','numerical-password'],{suspendedSince:iso(2*day)})]))[0].params,{drive:'C:',suspendedSince:iso(2*day)},'suspended params with the time');
check(keys(state([volume('C:','os','encrypted','on',['tpm']),volume('D:','fixed','encrypting','on',['tpm-pin']),volume('E:','removable','encrypted','on',['passphrase'])])),['bitlocker-recovery-C::info','bitlocker-recovery-D::info'],'no recovery password: info per OS or fixed volume, not removable');
check(keys(state([volume(null,'fixed','encrypted','on',['tpm'])])),['bitlocker-recovery-0:info'],'a volume without letter is keyed by its position');
check(keys({available:false,reason:'not-supported',collectedAt:iso(0),volumes:[]}),[],'not available: no issue');
check(keys(undefined),[],'an older agent: no issue');
check(issues(state([volume('C:','os','decrypted','off',[])]),{...defaultAlertSettings(),'bitlocker-system-unencrypted':{enabled:true,warning:null,critical:null,level:'critical'}})[0].level,'critical','an overridden level');
check(issues(state([volume('C:','os','decrypted','off',[])]),{...defaultAlertSettings(),'bitlocker-system-unencrypted':{enabled:false,warning:null,critical:null,level:'warning'}}),[],'a disabled rule');

// ---- Issue texts ----
const evaluated=bitlocker=>{const device={id:'d',name:'D',createdAt:0,revoked:0,management:0,lastSeen:now,snapshot:{...base,bitlocker}};return {...device,issues:evaluateAlertRules(device,defaultAlertSettings(),now)};};
const texts=(bitlocker,locale)=>deviceIssues(evaluated(bitlocker),now,locale).filter(item=>item.key.startsWith('bitlocker')).map(item=>[item.title,item.detail]);
check(texts(state([volume('C:','os','decrypted','off',[])]),'en'),[['System drive not encrypted','BitLocker is off on C:.']],'system text (en)');
check(texts(state([volume('C:','os','decrypted','off',[])]),'de'),[['Systemlaufwerk nicht verschlüsselt','BitLocker ist auf C: aus.']],'system text (de)');
const since=iso(2*day);
check(texts(state([volume('C:','os','encrypted','suspended',['tpm','numerical-password'],{suspendedSince:since})]),'en'),[['BitLocker protection suspended on C:',`Suspended since ${new Date(since).toLocaleString('en-US')} (2 days ago).`]],'suspended with time (en)');
check(texts(state([volume('C:','os','encrypted','suspended')]),'de'),[['BitLocker-Schutz auf C: angehalten','Angehalten.']],'suspended without time (de)');
check(texts(state([volume('D:','fixed','encrypted','on',['tpm'])]),'en'),[['No recovery password on D:','Add a recovery password so that you can unlock the drive after a hardware change.']],'recovery text (en)');
check(texts(state([volume('D:','fixed','encrypted','on',['tpm'])]),'de')[0][0],'Kein Wiederherstellungspasswort auf D:','recovery text (de)');

// ---- Storage and protection labels ----
const cell=(drive,bitlocker,locale='en')=>volumeBitlockerText(bitlockerVolume(bitlocker,drive),bitlocker,locale);
const mixed=state([volume('C:','os','encrypted','on'),volume('D:','fixed','encrypting','on',['tpm'],{percent:42}),volume('E:','fixed','decrypting','off',[],{percent:10}),volume('F:','fixed','decrypted','off',[]),volume('G:','fixed','encrypted','suspended')]);
check(['C:','D:','E:','F:','G:','H:','c:\\'].map(drive=>cell(drive,mixed)),[{text:'Encrypted',tone:'ok'},{text:'Encrypting 42%',tone:'neutral'},{text:'Decrypting 10%',tone:'warning'},{text:'Not encrypted',tone:'neutral'},{text:'Protection suspended',tone:'warning'},{text:'Not reported',tone:'neutral'},{text:'Encrypted',tone:'ok'}],'storage cells by drive letter (en)');
check(cell('D:',mixed,'de').text,'Wird verschlüsselt: 42 %','storage cell (de)');
check([cell('C:',{available:false,reason:'not-supported',collectedAt:iso(0),volumes:[]}).text,cell('C:',undefined).text],['Not available','Not reported'],'not available and not reported');
check(cell('C:',state([volume('C:','os','decrypted','off',[])])).tone,'warning','an unencrypted system drive is a warning');
check([bitlockerStatus(good),bitlockerStatus(state([volume('C:','os','encrypting','on')])),bitlockerStatus(state([volume('C:','os','decrypted','off',[])])),bitlockerStatus(state([volume('C:','os','encrypted','suspended')])),bitlockerStatus({available:false,collectedAt:iso(0),volumes:[]}),bitlockerStatus(undefined),bitlockerStatus(state([volume('D:','fixed','encrypted','on')]))],['encrypted','encrypting','not-encrypted','suspended','not-available','not-reported','not-reported'],'the device status of its system drive');
check([suspendedDuration(iso(3*day+3600000),now,'en'),suspendedDuration(iso(5*3600000),now,'de'),suspendedDuration(iso(60000),now,'en'),suspendedDuration(iso(day),now,'de')],['3 days','5 Stunden','less than an hour','1 Tag'],'suspension durations');
check(protectorLabels(['tpm','numerical-password','unknown'],'de'),['TPM','Wiederherstellungspasswort'],'protector labels skip unknown');

// ---- Fleet filters, sort and the encryption tab ----
const device=(id,bitlocker)=>({id,name:id,createdAt:0,revoked:0,management:0,lastSeen:now,snapshot:bitlocker===null?null:{...base,bitlocker}});
const fleet=[device('enc',good),device('susp',state([volume('C:','os','encrypted','suspended')])),device('plain',state([volume('C:','os','decrypted','off',[])])),device('na',{available:false,reason:'not-supported',collectedAt:iso(0),volumes:[]}),device('old',undefined),device('busy',state([volume('C:','os','encrypting','on')]))];
check(fleet.filter(item=>fleetFilterMatch(item,'not-encrypted',now)).map(item=>item.id),['plain'],'filter: system drive not encrypted (not available is no finding)');
check(fleet.filter(item=>fleetFilterMatch(item,'bitlocker-suspended',now)).map(item=>item.id),['susp'],'filter: BitLocker suspended');
check(fleet.filter(item=>fleetFilterMatch(item,'all',now)).length,6,'filter: all devices');
check([...fleet].sort((a,b)=>compareFleetDevices(a,b,'bitlocker:asc',now)).map(item=>item.id),['susp','plain','busy','enc','na','old'],'the BitLocker column sorts problems first, not reported last');
check([...fleet].sort((a,b)=>compareFleetDevices(a,b,'bitlocker:desc',now)).map(item=>item.id),['na','enc','busy','plain','susp','old'],'not reported stays last in both directions');
check(encryptionCounts(fleet),{all:6,encrypted:1,encrypting:1,'not-encrypted':1,suspended:1,'not-available':1,'not-reported':1},'encryption tab counts');
check(encryptionRow(fleet[0],'en'),{id:'enc',name:'enc',status:'encrypted',protection:'on',method:'XTS-AES 256',protectors:['TPM','Recovery password'],recoveryPassword:true,encrypted:1,volumes:3},'encryption tab row');
check(encryptionRow(fleet[3],'en'),{id:'na',name:'na',status:'not-available',protection:null,method:'—',protectors:[],recoveryPassword:null,encrypted:0,volumes:0},'a device without BitLocker');

console.log(`PASS bitlocker status (${checks} checks): strict schema, the three rules with not available and older agents, per-volume keys, issue texts, storage and protection labels, filters, sort and encryption tab counts.`);
