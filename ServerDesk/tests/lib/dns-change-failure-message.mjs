// The message of a failed DNS change of plugin 1.0.4 in the portal
// (lib/agent-messages.ts, the agentMessage catalogs): PLUGIN_DNS_CHANGE_FAILED_DETAIL
// shows the error number and the Windows text in en and de when error and
// detail are present, else the stored result; PLUGIN_DNS_CHANGE_FAILED keeps
// its text with the extra result args; the 8 args of a failed change
// (error, call, hresult, provider, operation, detail, attempts, signature)
// are valid stored args.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const {agentMessageText,agentMessageTextOr,validAgentArgs,parseAgentArgs}=await import('../../lib/agent-messages.ts');
const {translate}=await import('../../lib/i18n/translate.ts');
let checks=0;
const t=locale=>(key,params)=>translate(locale,key,params);

const stored='The DNS server refused the change (error 9999). Windows reports: Die Zonendatei konnte nicht geschrieben werden. Check the values and try again.';
const args={
 error:'9999',
 call:'PS_DnsServerPrimaryZone ExecMethod AddByFileForwardLookupZone',
 hresult:'0x80041001',
 provider:'DnsServerPSProvider',
 operation:'ExecMethod',
 detail:'Die Zonendatei konnte nicht geschrieben werden.',
 attempts:'PS_DnsServerPrimaryZone ExecMethod AddByFileForwardLookupZone 0x80041001 9999; MicrosoftDNS_Zone ExecMethod CreateZone 0x80041001',
 signature:'AddByFileForwardLookupZone(ResponsiblePerson, DynamicUpdate, LoadExisting, ComputerName, Name, ZoneFile, VirtualizationInstance, PassThru)',
};
const detailed={result:stored,resultCode:'PLUGIN_DNS_CHANGE_FAILED_DETAIL',resultArgs:args};

// The catalog texts with both values.
assert.equal(agentMessageText(detailed,t('en')),'The DNS server refused the change (error 9999). Windows reports: Die Zonendatei konnte nicht geschrieben werden. Check the values and try again.','en shows the error and the Windows text');
assert.equal(agentMessageText(detailed,t('de')),'Der DNS-Server hat die Änderung abgelehnt (Fehler 9999). Windows meldet: Die Zonendatei konnte nicht geschrieben werden. Prüfe die Werte und versuche es erneut.','de shows the error and the Windows text');
assert.equal(agentMessageTextOr(detailed,t('de'),'dns.error.read'),'Der DNS-Server hat die Änderung abgelehnt (Fehler 9999). Windows meldet: Die Zonendatei konnte nicht geschrieben werden. Prüfe die Werte und versuche es erneut.','the failure toast shows the same catalog text');
checks+=3;

// Without detail the stored result stays (the catalog text needs every placeholder).
const withoutDetail=Object.fromEntries(Object.entries(args).filter(([name])=>name!=='detail'));
assert.equal(agentMessageText({result:stored,resultCode:'PLUGIN_DNS_CHANGE_FAILED_DETAIL',resultArgs:withoutDetail},t('de')),stored,'without detail the stored result is shown');
assert.equal(agentMessageText({result:stored,resultCode:'PLUGIN_DNS_CHANGE_FAILED_DETAIL',resultArgs:null},t('en')),stored,'without args the stored result is shown');
checks+=2;

// PLUGIN_DNS_CHANGE_FAILED with the extra args keeps its unchanged text.
const plain={result:'The DNS server refused the change (error 2147749889). Check the values and try again.',resultCode:'PLUGIN_DNS_CHANGE_FAILED',resultArgs:{...args,error:'2147749889',provider:'-',operation:'-',detail:'-'}};
assert.equal(agentMessageText(plain,t('en')),'The DNS server refused the change (error 2147749889). Check the values and try again.','PLUGIN_DNS_CHANGE_FAILED keeps its en text');
assert.equal(agentMessageText(plain,t('de')),'Der DNS-Server hat die Änderung abgelehnt (Fehler 2147749889). Prüfe die Werte und versuche es erneut.','PLUGIN_DNS_CHANGE_FAILED keeps its de text');
checks+=2;

// The 8 args of a failed change are valid stored args; a ninth is not.
assert.equal(Object.keys(args).length,8);
assert.equal(validAgentArgs(args),true,'the 8 args of a failed change are valid');
assert.deepEqual(parseAgentArgs(JSON.stringify(args)),args,'the stored args parse back');
assert.equal(validAgentArgs({...args,attempts:'x'.repeat(1000)}),true,'attempts of 1000 characters are valid');
assert.equal(validAgentArgs({...args,extra:'x'}),false,'a ninth arg is refused');
checks+=5;

console.log(`PASS DNS change failure message (${checks} checks): PLUGIN_DNS_CHANGE_FAILED_DETAIL in en and de with the Windows text, the stored result without detail, PLUGIN_DNS_CHANGE_FAILED unchanged, and the 8 result args.`);
