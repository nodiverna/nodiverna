// The pure rules of Management → Accounts (ui/devices/management/local-accounts.ts): the subtitle of a local user
// (only non-empty, trimmed parts joined with " · "), the Administrators count by the well-known SID,
// the search, the required fields and the job parameters of the six account actions in the order
// and trimming the classic panel sent them. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
const {accountSubtitle,administratorCount,accountMatches,accountMissing,accountParams,ACCOUNT_KINDS,ACCOUNT_LIMITS,ADMINISTRATORS_SID}=await import('../../../ui/devices/management/local-accounts.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

// ---- Subtitle ----
check(accountSubtitle('','Built-in guest account'),'Built-in guest account','no full name: the description alone, without a leading dot');
check(accountSubtitle('Max',''),'Max','no description: the full name alone');
check(accountSubtitle('Max','Ops'),'Max · Ops','both parts');
check(accountSubtitle('  ','  Ops  '),'Ops','whitespace-only parts are dropped, the rest is trimmed');
check(accountSubtitle('',''),'','both empty: no subtitle');
check(accountSubtitle(null,undefined),'','missing parts: no subtitle');

// ---- Administrators by SID (the group name is localized) ----
check(ADMINISTRATORS_SID,'S-1-5-32-544','the well-known SID');
check(administratorCount([{sid:'S-1-5-32-545',members:['a','b','c']},{sid:'S-1-5-32-544',members:['Administrator','ops']}]),2,'the members of the group with SID S-1-5-32-544');
check(administratorCount([{sid:'s-1-5-32-544',members:['x']}]),1,'the SID compares case-insensitively');
check(administratorCount([{sid:'S-1-5-32-545',members:['a']}]),null,'no Administrators group: null');
check(administratorCount(undefined),null,'no inventory: null');

// ---- Search ----
const user={name:'Gast',fullName:'',description:'Integriertes Gastkonto'};
check([accountMatches(user,''),accountMatches(user,'gast'),accountMatches(user,'GASTKONTO'),accountMatches(user,'ops')],[true,true,true,false],'name, full name and description, case-insensitive');

// ---- Required fields ----
const blank={name:'',fullName:'',description:'',password:'',enabled:true,passwordNeverExpires:false,groupSid:''};
check(accountMissing('create-local-user',blank),'name','create needs a name first');
check(accountMissing('create-local-user',{...blank,name:'  sdtest '}),'password','then a password');
check(accountMissing('create-local-user',{...blank,name:'sdtest',password:' '}),null,'a password passes as given, also a space');
check(accountMissing('reset-local-password',{...blank,name:'Gast'}),'password','reset needs a password');
check(accountMissing('local-group-add',{...blank,name:'Gast'}),'groupSid','group actions need a user and a group');
check([accountMissing('set-local-user',blank),accountMissing('delete-local-user',blank)],[null,null],'change and delete have no required field');

// ---- Parameters: the classic panel's keys, order and trimming ----
const form={name:'  sdtest ',fullName:' Test User ',description:' Ops ',password:' p@ss ',enabled:false,passwordNeverExpires:true,groupSid:' S-1-5-32-545 '};
const params=kind=>accountParams(kind,form);
check(Object.entries(params('create-local-user')),[['name','sdtest'],['fullName','Test User'],['description','Ops'],['password',' p@ss '],['passwordNeverExpires',true]],'create: trimmed text, the password unchanged');
check(Object.entries(params('set-local-user')),[['name','  sdtest '],['enabled',false],['fullName','Test User'],['description','Ops'],['passwordNeverExpires',true]],'change: the row name as reported, then the fields');
check(Object.entries(params('reset-local-password')),[['name','  sdtest '],['password',' p@ss ']],'reset: name and password');
check(Object.entries(params('delete-local-user')),[['name','  sdtest ']],'delete: the name only');
check(Object.entries(params('local-group-add')),[['name','sdtest'],['groupSid','S-1-5-32-545']],'add member: trimmed user and group');
check(params('local-group-remove'),params('local-group-add'),'remove member: the same parameters');
check(ACCOUNT_KINDS.length,6,'six account actions');
check(ACCOUNT_LIMITS,{name:20,fullName:256,description:48,password:127},'the classic length limits');

console.log(`PASS local accounts (${checks} checks): subtitle without empty parts, Administrators by SID, search, required fields and the classic job parameters of all six actions.`);
