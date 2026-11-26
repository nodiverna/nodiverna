import assert from 'node:assert/strict';
import test from 'node:test';
import {readdirSync,readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import {z} from 'zod';
import {sourceDatabase,sourceLoader,inTransaction,createTrigger,dbModule} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {enableMultipleCustomers} from '../support/customer-separation.mjs';

// The error contract: the client-safe catalog lib/errors/codes.ts,
// the trigger and constraint registries lib/server/errors/db-codes.ts and failure() in lib/server/context.ts.
const read=file=>readFileSync(file,'utf8');
const {errorCatalog,opensMfaPrompt,customerDisabledMessage,customerMismatchMessage,deviceGroupMemberMissingMessage,customerMissingMessage,customerUnavailableMessage}=sourceLoader()('lib/errors/codes.ts');
const {dbTriggerCodes,dbTriggerCode,dbFailure,dbConstraintCodes,dbConstraintKey}=sourceLoader()('lib/server/errors/db-codes.ts');
const {translate}=sourceLoader()('lib/i18n/translate.ts');
const {apiErrorCodes}=sourceLoader()('lib/errors/api-error-keys.ts');
// The German text of a code's default key, the server's defaultLocale (English) text of a key.
const deText=code=>translate('de',errorCatalog[code].key),enText=key=>translate('en',key);
const failureFor=(code,key=errorCatalog[code].key)=>({status:errorCatalog[code].status,code,key,message:enText(key)});
// The exported constants hold the defaultLocale text of their key, for the text form of HttpError.
for(const [value,key] of [[customerDisabledMessage,'apiError.customer.disabled'],[customerMismatchMessage,'apiError.customer.mismatch'],[deviceGroupMemberMissingMessage,'apiError.group.memberMissing']])assert.equal(value,translate('en',key));
const firstCustomer='00000000-0000-4000-8000-000000000100';
// Fake driver errors shaped like postgres.js errors: SQLSTATE, severity and, for constraints, the name.
const driverError=(message,code='P0001',constraint)=>Object.assign(new Error(message),{code,severity:'ERROR',...(constraint?{constraint_name:constraint}:{})});
const err=literal=>driverError(literal);
const unique=constraint=>driverError(`duplicate key value violates unique constraint "${constraint}"`,'23505',constraint);
const checkFailed=constraint=>driverError(`new row violates check constraint "${constraint}"`,'23514',constraint);
// Errors that carry a registered literal but are no database constraint error.
const notDatabaseErrors=()=>[new Error('customer-disabled'),new Error('P0001: customer-disabled'),new TypeError('bad input customer-disabled'),Object.assign(new Error('customer-disabled'),{code:'P0001'})];

// The literals that a migration raises and that still exist after all migrations:
// a literal raised only in trigger functions that a later migration drops
// (migration 0038) is gone.
const raisedIn=text=>[...text.matchAll(/RAISE\s+EXCEPTION\s+'((?:[^']|'')*)'/gi)].map(match=>match[1].replaceAll("''","'"));
function migrationLiterals(){
 const texts=readdirSync('drizzle').filter(file=>/^\d{4}_.+\.sql$/.test(file)).sort().map(name=>read(path.join('drizzle',name)));
 const dropped=new Set(texts.flatMap(text=>[...text.matchAll(/DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?\s*\(/gi)].map(match=>match[1])));
 const all=texts.flatMap(raisedIn);
 const inDropped=texts.flatMap(text=>[...text.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?(\w+)"?\s*\([^)]*\)[^$]*\$\$([\s\S]*?)\$\$/gi)].filter(match=>dropped.has(match[1])).flatMap(match=>raisedIn(match[2])));
 const count=(list,literal)=>list.filter(entry=>entry===literal).length;
 return new Set(all.filter(literal=>count(all,literal)>count(inDropped,literal)));
}

test('every RAISE EXCEPTION literal of the migrations has exactly one registry entry and the registry nothing else',()=>{
 const literals=migrationLiterals(),registered=Object.keys(dbTriggerCodes);
 assert.equal(literals.size,29,'27 kebab-case codes plus the two RDP sentences');
 for(const literal of ['edition-license-protected','edition-trial-immutable','edition-clock-monotonic'])assert.equal(literals.has(literal),false,literal+' is gone with its dropped trigger function');
 for(const literal of literals)assert.ok(Object.hasOwn(dbTriggerCodes,literal),`registry entry for ${literal}`);
 for(const key of registered)assert.ok(literals.has(key),`some migration raises ${key}`);
 assert.equal(registered.length,literals.size);
});

test('the registry splits conflicts and invariants as specified',()=>{
 const invariants=['removed-customer-immutable','customer-id-removed','customer-settings-protected','audit-customer-immutable','customer-installer-immutable','customer-installer-revoked','usage-data-protected','usage-instance-immutable','Direct WebRTC sessions cannot store stream payloads','Direct WebRTC sessions cannot store stream receipts'];
 const expected={
  'customer-disabled':[409,'CUSTOMER_DISABLED','Der Kunde ist deaktiviert und nimmt keine neuen Geräte oder Gruppen auf. Aktiviere ihn unter Einstellungen → Kunden.'],
  'customer-mismatch':[409,'CUSTOMER_MISMATCH','Gerät und Gerätegruppe gehören zu verschiedenen Kunden. Wähle eine Gruppe desselben Kunden.'],
  'device-group-member-missing':[409,'DEVICE_GROUP_MEMBER_MISSING','Das Gerät oder die Gerätegruppe gibt es nicht mehr. Lade die Seite neu.'],
  'customer-missing':[404,'CUSTOMER_MISSING','Den Kunden gibt es nicht oder er ist dir nicht zugewiesen. Lade die Seite neu.'],
  'customer-role-permissions':[400,'CUSTOMER_ROLE_PERMISSIONS','Rollen eines Kunden können nur Geräteberechtigungen enthalten.'],
  'customer-role-scope':[400,'CUSTOMER_ROLE_SCOPE','Eine Rolle eines Kunden gilt nur für Gerätegruppen und Geräte dieses Kunden.'],
  'customer-catalog-mismatch':[400,'CUSTOMER_CATALOG_MISMATCH','Eine Vorlage eines Kunden lässt sich nur Gruppen und Geräten dieses Kunden zuweisen.'],
  'customer-catalog-immutable':[400,'CUSTOMER_CATALOG_IMMUTABLE','Ob ein Eintrag zur MSP-Bibliothek oder zu einem Kunden gehört, lässt sich nachträglich nicht ändern.'],
  'customer-default-protected':[409,'CUSTOMER_DEFAULT_PROTECTED','Den ersten Kunden kannst du nicht deaktivieren. Er nimmt alle Geräte und Gruppen ohne eigenen Kunden auf.'],
  'customer-installer-group-mismatch':[400,'CUSTOMER_INSTALLER_GROUP_MISMATCH','Wähle eine Gerätegruppe dieses Kunden oder „Ohne Gruppe“.'],
  'multiple-customers-off':[409,'MULTIPLE_CUSTOMERS_OFF','„Mehrere Kunden“ ist ausgeschaltet. Schalte es unter Einstellungen → Kunden ein und erstelle den Kunden dann.'],
  'multiple-customers-in-use':[409,'MULTIPLE_CUSTOMERS_IN_USE','„Mehrere Kunden“ bleibt eingeschaltet, solange andere Kunden existieren. Lösche die anderen Kunden und schalte es erneut aus.'],
  // A customer delete (deleteCustomer) while data was added to the customer since its counts.
  'customer-in-use':[409,'CUSTOMER_IN_USE','Der Kunde hat noch Geräte, Gerätegruppen, Runbooks, Automationsvorlagen oder Rollen. Entferne oder lösche sie zuerst und lösche dann den Kunden.'],
  'customer-assignment-subject-missing':[409,'CUSTOMER_ASSIGNMENT_SUBJECT_MISSING','Ein ausgewähltes Konto oder eine Benutzergruppe gibt es nicht mehr. Lade die Seite neu und wähle Konten und Benutzergruppen erneut.'],
  'device-group-cycle':[409,'DEVICE_GROUP_CYCLE','Eine Gruppe kann nicht in ihre eigenen Untergruppen verschoben werden.'],
  'device-group-depth-limit':[409,'DEVICE_GROUP_DEPTH_LIMIT','Eine Gerätegruppe kann höchstens vier Ebenen von Untergruppen haben.'],
  'device-group-has-children':[409,'DEVICE_GROUP_HAS_CHILDREN','Diese Gruppe hat noch Untergruppen. Lösche oder verschiebe die Untergruppen und versuche es erneut.'],
  'device-group-membership-path-conflict':[409,'DEVICE_GROUP_MEMBERSHIP_PATH_CONFLICT','Ein Gerät kann innerhalb eines Gruppenpfads nur einmal direkt zugeordnet sein. Bereinige die Zuordnungen vor dem Verschieben.'],
  'device-group-parent-missing':[409,'DEVICE_GROUP_PARENT_MISSING','Die übergeordnete Gruppe existiert nicht mehr.'],
 };
 assert.deepEqual(Object.keys(dbTriggerCodes).sort(),[...Object.keys(expected),...invariants].sort());
 for(const literal of invariants){assert.deepEqual(dbTriggerCodes[literal],{kind:'invariant'},literal);assert.equal(dbFailure(err(literal)),null,literal);}
 for(const [literal,[status,code,message]] of Object.entries(expected)){
  const entry=dbTriggerCodes[literal];
  assert.deepEqual(entry,{kind:'conflict',code},literal);
  assert.deepEqual([errorCatalog[code].status,deText(code)],[status,message],`catalog entry of ${code}`);
  assert.deepEqual(dbFailure(err(literal)),failureFor(code),literal);
 }
 assert.equal(customerMissingMessage,enText('apiError.customer.gone'),'the constant is the defaultLocale text of its key');
 assert.equal(translate('de','apiError.customer.gone'),'Den Kunden gibt es nicht mehr. Lade die Seite neu.');
});

test('the constraint registry has exactly the four constraint entries, their catalog entries and the boundary-neutral CUSTOMER_MISSING',()=>{
 const expected={
  'UNIQUE idx_device_group_members_server':[409,'DEVICE_GROUP_MEMBERSHIP_TAKEN','Ein Gerät kann nur einer Gerätegruppe angehören, und dieses Gerät ist inzwischen einer anderen Gruppe zugeordnet. Lade die Ansicht neu und verschiebe es erneut.'],
  'UNIQUE customers_name':[409,'CUSTOMER_NAME_TAKEN','Es gibt bereits einen Kunden mit diesem Namen.'],
  'CHECK customers_settings_valid':[400,'CUSTOMER_SETTINGS_INVALID','Die Kundeneinstellungen sind ungültig. Prüfe die Angaben und speichere erneut.'],
  'CHECK customer_installers_enrollments':[409,'INSTALLER_EXHAUSTED','Mit diesem Installer sind schon alle erlaubten Geräte registriert. Erstelle im Portal einen neuen Installer.'],
 };
 assert.deepEqual(Object.keys(dbConstraintCodes).sort(),Object.keys(expected).sort());
 // Every key names a constraint (CHECK) or unique index (UNIQUE) of the baseline migration.
 const baseline=read('drizzle/0000_baseline.sql');
 for(const key of Object.keys(dbConstraintCodes)){
  const [kind,name]=key.split(' ');
  assert.ok(kind==='CHECK'?baseline.includes(`CONSTRAINT "${name}" CHECK`):baseline.includes(`CREATE UNIQUE INDEX "${name}"`),`${key} exists in the baseline`);
 }
 for(const [key,[status,code,message]] of Object.entries(expected)){
  assert.deepEqual(dbConstraintCodes[key],{kind:'conflict',code},key);
  assert.deepEqual([errorCatalog[code].status,deText(code)],[status,message],`catalog entry of ${code}`);
 }
 assert.equal(deText('CUSTOMER_MISSING'),'Den Kunden gibt es nicht oder er ist dir nicht zugewiesen. Lade die Seite neu.');
 assert.equal(customerUnavailableMessage,enText(errorCatalog.CUSTOMER_MISSING.key));
 assert.equal(errorCatalog.CUSTOMER_MISSING.status,404);
});

test('the catalog has unique UPPER_SNAKE_CASE codes, the required entries and the MFA helper',()=>{
 const codes=Object.keys(errorCatalog);
 assert.equal(new Set(codes).size,codes.length);
 for(const code of codes){assert.match(code,/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/,code);assert.match(errorCatalog[code].key,/^apiError\./,code);assert.ok(Number.isInteger(errorCatalog[code].status),code);}
 const required={VALIDATION_FAILED:400,INTERNAL_ERROR:500,STORAGE_UNAVAILABLE:503,MFA_LOGIN_REQUIRED:403,MFA_STEP_UP_REQUIRED:403,MFA_SETUP_REQUIRED:403,TERMINAL_SEQUENCE_CONFLICT:409,INSTALLER_GROUP_MISSING:409,CUSTOMER_SETTINGS_INVALID:400,CUSTOMER_ASSIGNMENT_SUBJECT_MISSING:409};
 for(const [code,status] of Object.entries(required))assert.equal(errorCatalog[code]?.status,status,code);
 assert.equal(deText('STORAGE_UNAVAILABLE'),'Datenspeicher oder Dienst momentan nicht erreichbar.');
 assert.equal(deText('MFA_SETUP_REQUIRED'),'Für dein Konto ist keine MFA eingerichtet. Richte unter „Mein Konto“ einen Authenticator ein und versuche es erneut.');
 assert.equal(enText(errorCatalog.MFA_SETUP_REQUIRED.key),'Your account has no MFA set up. Set up an authenticator under My account and try again.');
 assert.equal(deText('TERMINAL_SEQUENCE_CONFLICT'),'Die Terminal-Sitzung wurde in einer weiteren Ansicht bedient. Deine wartenden Eingaben wurden nicht übernommen. Gib sie erneut ein.');
 assert.equal(enText(errorCatalog.TERMINAL_SEQUENCE_CONFLICT.key),'The terminal session was used in another view. Your pending input was not accepted. Enter it again.');
 assert.equal(enText(errorCatalog.INTERNAL_ERROR.key),'An internal error occurred in the portal. Try again. If the error persists, give your administrator the reference {reference}.');
 assert.equal(enText(errorCatalog.CUSTOMER_MISSING.key),'The customer does not exist or is not assigned to you. Reload the page.');
 assert.equal(deText('MFA_LOGIN_REQUIRED'),'Melde dich mit MFA an, um fortzufahren.');
 assert.equal(deText('MFA_STEP_UP_REQUIRED'),'Bestätige deine Identität erneut.');
 assert.equal(deText('INSTALLER_GROUP_MISSING'),'Die Gerätegruppe dieses Installers gibt es nicht mehr. Erstelle im Portal einen neuen Installer.');
 // Console enrollment once a second customer exists (app/api/console, docs/customers.md).
 assert.deepEqual([errorCatalog.ENROLL_CUSTOMER_REQUIRED.status,deText('ENROLL_CUSTOMER_REQUIRED')],[400,'Wähle einen Kunden für das neue Gerät. Hat das Portal mehr als einen Kunden, gehört jedes neue Gerät ausdrücklich zu einem Kunden.']);
 // GPU driver jobs: an unsupported OS or model is refused like the GET reason; a vendor fault stays 502 (docs/gpu-driver-updates.md).
 assert.deepEqual(['GPU_DRIVER_UNSUPPORTED_OS','GPU_DRIVER_UNSUPPORTED_MODEL','GPU_DRIVER_LOOKUP_FAILED'].map(code=>[errorCatalog[code].status,errorCatalog[code].key]),[[409,'apiError.gpuDriver.unsupportedOs'],[409,'apiError.gpuDriver.unsupportedModel'],[502,'apiError.gpuDriver.lookupFailed']]);
 assert.deepEqual(['apiError.gpuDriver.unsupportedOs','apiError.gpuDriver.unsupportedModel','apiError.gpuDriver.checkBusy'].map(key=>apiErrorCodes[key]),['GPU_DRIVER_UNSUPPORTED_OS','GPU_DRIVER_UNSUPPORTED_MODEL','RATE_LIMITED']);
 for(const [code,expected] of [['MFA_LOGIN_REQUIRED',true],['MFA_STEP_UP_REQUIRED',true],['MFA_SETUP_REQUIRED',false],['MFA_REQUIRED',false],['SESSION_EXPIRED',false],['VALIDATION_FAILED',false],[undefined,false]])assert.equal(opensMfaPrompt(code),expected,String(code));
});

test('catalog and registry import nothing server-only and load without mocks',()=>{
 for(const file of ['lib/errors/codes.ts','lib/server/errors/db-codes.ts']){
  const imports=[...read(file).matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map(match=>match[1]??match[2]??match[3]);
  for(const name of imports)assert.doesNotMatch(name,/server|^next\/|^cloudflare:|runtime\//,`${file} imports ${name}`);
  assert.equal(typeof sourceLoader()(file),'object');
 }
 assert.deepEqual([...read('lib/server/errors/db-codes.ts').matchAll(/\bfrom\s+'([^']+)'/g)].map(match=>match[1]),['../../i18n/locale','../../i18n/translate','../../errors/api-error-keys','../../errors/codes']);
 assert.deepEqual([...read('lib/errors/codes.ts').matchAll(/\bfrom\s+'([^']+)'/g)].map(match=>match[1]),['../i18n/locale','../i18n/translate','./api-error-keys'],'codes.ts imports only the catalog and the key type');
});

test('the parser finds whole registered codes in message or cause of database constraint errors',()=>{
 const viaCause=Object.assign(new Error('batch failed'),{cause:err('customer-disabled')});
 for(const error of [err('customer-disabled'),viaCause])assert.equal(dbTriggerCode(error),'customer-disabled',error.message);
 assert.equal(dbTriggerCode(err('customer-catalog-mismatch')),'customer-catalog-mismatch');
 assert.equal(dbTriggerCode(err('customer-mismatch')),'customer-mismatch');
 assert.equal(dbTriggerCode(err('Direct WebRTC sessions cannot store stream receipts')),'Direct WebRTC sessions cannot store stream receipts');
 for(const value of [err('fixture-membership-failure'),err('customer-mismatched'),err('xcustomer-disabled'),err('P0001: customer-disabled'),driverError('customer-disabled','23514'),new TypeError('boom'),undefined,null,42])assert.equal(dbTriggerCode(value),null,String(value));
});

test('a registered literal outside a database constraint error is no trigger',()=>{
 for(const error of notDatabaseErrors()){
  assert.equal(dbTriggerCode(error),null,`${error.name} ${error.message} ${error.code}`);
  assert.equal(dbFailure(error),null,`${error.name} ${error.message} ${error.code}`);
 }
 assert.equal(dbTriggerCode('customer-disabled'),null,'a thrown string');
 assert.equal(dbTriggerCode({code:'XX000',cause:{message:'customer-disabled'}}),null,'cause without a driver error');
 assert.equal(dbTriggerCode(err('x')),null,'trigger error without a registered literal');
});

test('the constraint parser reads whole registered targets of database errors only',()=>{
 for(const error of [unique('customers_name'),new Error('batch failed',{cause:unique('customers_name')})]){
  assert.equal(dbConstraintKey(error),'UNIQUE customers_name',error.message);
  assert.deepEqual(dbFailure(error),failureFor('CUSTOMER_NAME_TAKEN'),error.message);
  assert.equal(dbTriggerCode(error),null,'no trigger literal');
 }
 assert.equal(dbConstraintKey(unique('idx_device_group_members_server')),'UNIQUE idx_device_group_members_server');
 assert.equal(dbConstraintKey(checkFailed('customer_installers_enrollments')),'CHECK customer_installers_enrollments');
 assert.equal(dbConstraintKey(checkFailed('customers_settings_valid')),'CHECK customers_settings_valid');
 for(const error of [unique('customers_name_x'),unique('customers_pkey'),unique('local_users_username'),checkFailed('customers_name_present'),checkFailed('customers_name'),
  new Error('duplicate key value violates unique constraint "customers_name"'),new TypeError('customers_name'),Object.assign(new Error('x'),{code:'23505',constraint_name:'customers_name'})]){
  assert.equal(dbConstraintKey(error),null,error.message);
  assert.equal(dbFailure(error),null,error.message);
 }
 // Text overrides keep working; code overrides the key.
 assert.deepEqual(dbFailure(unique('customers_name'),{'UNIQUE customers_name':{message:'Z',code:'C'}}),{status:409,code:'C',key:errorCatalog.CUSTOMER_NAME_TAKEN.key,message:'Z'},'text overrides');
 assert.equal(dbFailure(unique('customers_name'),{},['customer-disabled']),null,'outside the call site’s list');
 assert.deepEqual(dbFailure(unique('customers_name'),{},['UNIQUE customers_name']),failureFor('CUSTOMER_NAME_TAKEN'),'inside the call site’s list');
});

test('the translator applies overrides but keeps the registry status',()=>{
 // A key override brings the code of its key; the status stays the registry's.
 assert.deepEqual(dbFailure(err('customer-mismatch'),{'customer-mismatch':{key:'apiError.installer.groupMissing'}}),{status:409,code:'INSTALLER_GROUP_MISSING',key:'apiError.installer.groupMissing',message:enText('apiError.installer.groupMissing')});
 assert.deepEqual(dbFailure(err('customer-disabled'),{'customer-disabled':{key:'apiError.catalog.customerDisabled'}}),{status:409,code:'CUSTOMER_DISABLED',key:'apiError.catalog.customerDisabled',message:enText('apiError.catalog.customerDisabled')});
 assert.deepEqual(dbFailure(err('customer-disabled'),{'customer-disabled':{message:'Y'}}),{status:409,code:'CUSTOMER_DISABLED',key:errorCatalog.CUSTOMER_DISABLED.key,message:'Y'},'a text override');
 assert.equal(dbFailure(err('usage-data-protected')),null,'invariant');
 assert.equal(dbFailure(err('fixture-x')),null,'unregistered');
 assert.equal(dbFailure(new TypeError('boom')),null);
 assert.equal(dbFailure(err('customer-disabled'),{},['customer-missing']),null,'outside the call site’s list');
});

async function serverFixture(){
 const database=await sourceDatabase(),env={};
 const server=sourceLoader()('lib/server/context.ts',{'cloudflare:workers':{env},'next/headers':{headers:()=>new Headers()}});
 const logs=[],original=console.error;
 const answer=async error=>{console.error=(...args)=>logs.push(args.map(String).join(' '));try{const response=server.failure(error);assert.equal(response.headers.get('Cache-Control'),'no-store');return {status:response.status,body:await response.json()};}finally{console.error=original;}};
 const caught=async run=>{try{await run();}catch(error){return error;}assert.fail('expected the statement to fail');};
 return {database,env,server,logs,answer,caught};
}

test('failure() answers trigger conflicts, validation, storage and programming errors by their class',async()=>{
 const {database,server,logs,answer,caught}=await serverFixture();
 try{
  const assignment=()=>sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${firstCustomer},${'user'},${randomUUID()},${Date.now()},${'fixture'})`;
  const subject=enText(errorCatalog.CUSTOMER_ASSIGNMENT_SUBJECT_MISSING.key),subjectKey=errorCatalog.CUSTOMER_ASSIGNMENT_SUBJECT_MISSING.key;
  logs.length=0;
  const untranslated=await answer(await caught(()=>database.exec(assignment())));
  assert.deepEqual(untranslated,{status:409,body:{error:subject,code:'CUSTOMER_ASSIGNMENT_SUBJECT_MISSING',messageKey:subjectKey}},'untranslated trigger');
  assert.deepEqual(Object.keys(untranslated.body).sort(),['code','error','messageKey'],'no reference, message or stack in the body');
  assert.equal(logs.length,1,'one log entry per conflict');
  assert.ok(logs[0].includes('CUSTOMER_ASSIGNMENT_SUBJECT_MISSING'),'the log names the answered code');
  assert.ok(logs[0].includes('customer-assignment-subject-missing'),'and the trigger literal');
  assert.ok(logs[0].includes('): customer-assignment-subject-missing'),'and the original message');
  assert.match(logs[0],/\n\s+at /,'with the stack frames');
  assert.deepEqual(await answer(await caught(()=>inTransaction(database,[assignment()]))),{status:409,body:{error:subject,code:'CUSTOMER_ASSIGNMENT_SUBJECT_MISSING',messageKey:subjectKey}},'the same trigger inside a batch');
  const disabled=randomUUID();
  await database.exec(enableMultipleCustomers());
  await database.exec(sql`INSERT INTO customers(id,name,status,created_at,updated_at) VALUES(${disabled},${'Disabled '+disabled},'disabled',${Date.now()},${Date.now()})`);
  assert.deepEqual(await answer(await caught(()=>database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES(${randomUUID()},${'Device'},${'fixture'},${Date.now()},${disabled})`))),{status:409,body:{error:customerDisabledMessage,code:'CUSTOMER_DISABLED',messageKey:'apiError.customer.disabled'}},'previously translated trigger');

  const internal=async(error,label)=>{
   const result=await answer(error);
   assert.equal(result.status,500,label);assert.equal(result.body.code,'INTERNAL_ERROR',label);
   assert.match(result.body.reference,/^[0-9a-f]{8}$/,label);
   assert.equal(result.body.error,enText(errorCatalog.INTERNAL_ERROR.key).replace('{reference}',result.body.reference),label);
   assert.equal(result.body.messageKey,'apiError.internalError',label);assert.deepEqual(result.body.params,{reference:result.body.reference},label);
   assert.deepEqual(Object.keys(result.body).sort(),['code','error','messageKey','params','reference'],label);
   return result;
  };
  logs.length=0;
  const invariant=await internal(await caught(()=>database.exec(sql`INSERT INTO usage_data(id,instance_id) VALUES(2,'00000000000000000000000000000000')`)),'invariant trigger');
  assert.equal(logs.length,1);assert.ok(logs[0].includes(invariant.body.reference));assert.ok(logs[0].includes('usage-data-protected'),'the log names the trigger literal');assert.ok(logs[0].includes('P0001'),'and the SQLSTATE');
  await database.exec(sql`CREATE TABLE fixture_failures(x bigint)`);
  await createTrigger(database,'fixture_failures_insert','fixture_failures','BEFORE INSERT',{message:'fixture-x'});
  await internal(await caught(()=>database.exec(sql`INSERT INTO fixture_failures(x) VALUES(1)`)),'unregistered trigger');
  await internal(await caught(()=>database.exec(sql`SELECT * FROM missing_table`)),'an SQL error (42P01)');
  await internal(Object.assign(new Error('duplicate key value violates unique constraint "x_y"'),{code:'23505',severity:'ERROR',constraint_name:'x_y'}),'untranslated constraint');
  for(const error of notDatabaseErrors()){
   logs.length=0;
   const result=await internal(error,`no database error: ${error.name} ${error.message}`);
   assert.equal(logs.length,1);assert.ok(logs[0].includes(result.body.reference));assert.ok(!logs[0].includes('trigger customer-disabled'),'no trigger is named');
  }

  let zodError;try{z.object({a:z.string()}).parse({});}catch(error){zodError=error;}
  assert.deepEqual(await answer(zodError),{status:400,body:{error:enText('apiError.validationFailed'),code:'VALIDATION_FAILED',messageKey:'apiError.validationFailed'}});
  assert.equal(deText('VALIDATION_FAILED'),'Die Angaben sind ungültig. Prüfe die Eingaben und versuche es erneut.');

  logs.length=0;
  const first=await internal(new TypeError('boom'),'programming error'),second=await internal(new TypeError('boom'),'second programming error');
  assert.ok(!first.body.error.includes('boom'),'the body never contains the original message');
  assert.notEqual(first.body.reference,second.body.reference);
  assert.equal(logs.length,2);assert.ok(logs[0].includes(first.body.reference)&&logs[0].includes('boom')&&logs[0].includes('TypeError'),'log carries reference, message and stack');assert.match(logs[0],/\n\s+at /,'with the stack frames');
  await internal(new Error('plain'),'plain Error');
  await internal('a string','non-Error value');
  await internal(Object.create(null),'value without toString');

  const storage=errorCatalog.STORAGE_UNAVAILABLE;
  const driver=(code,message='x')=>Object.assign(new Error(message),{code,severity:'FATAL'});
  for(const [error,label] of [[Object.assign(new Error('x'),{code:'ECONNREFUSED'}),'ECONNREFUSED'],[driver('08006'),'class 08'],[driver('53300'),'class 53'],[driver('57P01'),'57P01'],[driver('40001'),'40001 after the retries'],[driver('40P01'),'40P01 after the retries'],[Object.assign(new Error('x'),{code:'CONNECT_TIMEOUT'}),'CONNECT_TIMEOUT'],[new Error('x',{cause:{code:'ECONNREFUSED'}}),'cause ECONNREFUSED'],[new Error('x',{cause:driver('57P03')}),'cause 57P03']])
   assert.deepEqual(await answer(error),{status:503,body:{error:enText(storage.key),code:'STORAGE_UNAVAILABLE',messageKey:storage.key}},label);
  // db() of lib/server/db.ts without a database (no DATABASE_URL): the shared slot is empty.
  const slot=Symbol.for('serverdesk.runtime.database'),shared=globalThis[slot];
  globalThis[slot]=null;
  const missing=await caught(()=>dbModule().db());
  globalThis[slot]=shared;
  assert.equal(missing.message,'The data storage cannot be reached at the moment.','db() keeps its log message');assert.ok(missing instanceof Error);
  assert.deepEqual(await answer(missing),{status:503,body:{error:enText(storage.key),code:'STORAGE_UNAVAILABLE',messageKey:storage.key}},'db() without a database');

  // The text form of test doubles: an unknown text keeps its code or gets the generic code of its status, without a key.
  assert.deepEqual(await answer(new server.HttpError(418,'t','C')),{status:418,body:{error:'t',code:'C'}});
  assert.deepEqual(await answer(new server.HttpError(409,'without a code')),{status:409,body:{error:'without a code',code:'CONFLICT'}});
  // A constant text (the defaultLocale text of a registered key) carries that key and, without a code, its code.
  assert.deepEqual(await answer(new server.HttpError(409,errorCatalog.CUSTOMER_NAME_TAKEN.message)),{status:409,body:{error:enText('apiError.customer.nameTaken'),code:'CUSTOMER_NAME_TAKEN',messageKey:'apiError.customer.nameTaken'}});
  assert.deepEqual(await answer(new server.HttpError(403,errorCatalog.MFA_STEP_UP_REQUIRED.message,'MFA_STEP_UP_REQUIRED')),{status:403,body:{error:enText('apiError.mfa.stepUpRequired'),code:'MFA_STEP_UP_REQUIRED',messageKey:'apiError.mfa.stepUpRequired'}});
  // A keyed error: status from the code, the exact body keys, params only for placeholders.
  const keyed=await answer(new server.HttpError('apiError.release.sameVersion',{name:'SRV-01',extra:'x'}));
  assert.deepEqual(keyed,{status:409,body:{error:enText('apiError.release.sameVersion').replace('{name}','SRV-01'),code:'CONFLICT',messageKey:'apiError.release.sameVersion',params:{name:'SRV-01'}}});
  assert.equal(keyed.body.error,translate('en','apiError.release.sameVersion',{name:'SRV-01'}));
  assert.deepEqual(Object.keys((await answer(new server.HttpError('apiError.terminal.sessionEnded'))).body).sort(),['code','error','messageKey'],'no params without placeholders');
 }finally{database.close();}
});

test('failure() answers the registered UNIQUE and CHECK conflicts of the real database, also inside a batch',async()=>{
 const {database,logs,answer,caught}=await serverFixture();
 try{
  const at=Date.now(),device=randomUUID(),groups=[randomUUID(),randomUUID()];
  await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES(${device},${'Device'},${'fixture'},${at},${firstCustomer})`);
  for(const id of groups)await database.exec(sql`INSERT INTO device_groups(id,name,created_at,customer_id) VALUES(${id},${'Group '+id},${at},${firstCustomer})`);
  await database.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${device},${groups[0]})`);
  const secondMembership=()=>sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${device},${groups[1]})`;
  const body=code=>({error:enText(errorCatalog[code].key),code,messageKey:errorCatalog[code].key});
  const taken={status:409,body:body('DEVICE_GROUP_MEMBERSHIP_TAKEN')};
  logs.length=0;
  assert.deepEqual(await answer(await caught(()=>database.exec(secondMembership()))),taken,'a second membership of the same device');
  assert.equal(logs.length,1);
  for(const part of ['DEVICE_GROUP_MEMBERSHIP_TAKEN','UNIQUE idx_device_group_members_server','duplicate key value violates unique constraint "idx_device_group_members_server"'])assert.ok(logs[0].includes(part),`the log contains ${part}`);
  assert.match(logs[0],/\n\s+at /,'with the stack frames');
  assert.deepEqual(await answer(await caught(()=>inTransaction(database,[secondMembership()]))),taken,'the same UNIQUE inside a batch');

  const customer=name=>sql`INSERT INTO customers(id,name,status,created_at,updated_at) VALUES(${randomUUID()},${name},'active',${at},${at})`;
  const suffix=randomUUID();
  await database.exec(enableMultipleCustomers());
  await database.exec(customer('Acme '+suffix));
  assert.deepEqual(await answer(await caught(()=>database.exec(customer('ACME '+suffix.toUpperCase())))),{status:409,body:body('CUSTOMER_NAME_TAKEN')},'a name that differs only in case');

  const installer=randomUUID();
  await database.exec(sql`INSERT INTO customer_installers(id,customer_id,name,key_hash,mode,expires_at,max_devices,created_at,created_by) VALUES(${installer},${firstCustomer},${'Installer'},${randomUUID()},'ReadOnly',${at+86400000},1,${at},'fixture')`);
  await database.exec(sql`UPDATE customer_installers SET enrollments=1 WHERE id=${installer}`);
  assert.deepEqual(await answer(await caught(()=>database.exec(sql`UPDATE customer_installers SET enrollments=2 WHERE id=${installer}`))),{status:409,body:body('INSTALLER_EXHAUSTED')},'enrollments above max_devices');
  assert.deepEqual(await answer(await caught(()=>database.exec(sql`UPDATE customers SET maintenance_days=3 WHERE id=${firstCustomer}`))),{status:400,body:body('CUSTOMER_SETTINGS_INVALID')},'half a maintenance window');
 }finally{database.close();}
});

// ---- Static checks: no message parsing of trigger codes, codes on the client branches.
// The error contract itself (lib/errors/ before the lib/server/ move): lib/errors/, lib/server/errors/ and ui/base/api-error-text.ts.
const errorContract=file=>{const name=file.split(path.sep).join('/');return name.startsWith('lib/errors/')||name.startsWith('lib/server/errors/')||name==='ui/base/api-error-text.ts';};
const sourceFiles=dir=>readdirSync(dir).flatMap(name=>{const file=path.join(dir,name);return statSync(file).isDirectory()?sourceFiles(file):/\.(?:ts|tsx)$/.test(name)?[file]:[];});
const parse=file=>ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
function nodes(source,predicate,found=[]){(function visit(node){if(predicate(node))found.push(node);ts.forEachChild(node,visit);})(source);return found;}
const triggerLike=/(?:^|[^\w-])(?:customer|device-group|audit|usage)-[a-z]/;

test('no source file parses a trigger code with includes() or a regular expression',()=>{
 const codes=Object.keys(dbTriggerCodes),offenders=[];
 const mentions=text=>codes.some(code=>text.includes(code))||triggerLike.test(text);
 for(const file of ['lib','app','ui'].flatMap(sourceFiles)){
  if(errorContract(file))continue;
  const source=parse(file);
  for(const node of nodes(source,node=>
   ts.isRegularExpressionLiteral(node)&&mentions(node.text)||
   ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='includes'&&node.arguments.some(arg=>ts.isStringLiteralLike(arg)&&mentions(arg.text))||
   ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='RegExp'&&(node.arguments??[]).some(arg=>ts.isStringLiteralLike(arg)&&mentions(arg.text))
  ))offenders.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line+1} ${node.getText().slice(0,80)}`);
 }
 assert.deepEqual(offenders,[]);
});

test('the server sends the codes the clients branch on',()=>{
 const sequence=coded('lib/server/devices/terminal-sessions.ts','TERMINAL_SEQUENCE_CONFLICT');
 assert.equal(sequence.length,4,'four sequence conflicts');
 for(const {status,message} of sequence)assert.deepEqual([status,message],[409,'apiError.terminal.sequenceConflict']);
 const routeLiterals=nodes(parse('lib/server/devices/terminal-sessions.ts'),ts.isStringLiteralLike).map(node=>node.text);
 assert.deepEqual(routeLiterals.filter(text=>text.includes('equenz')),[],'no technical sequence text is left in the route');
 const setup=coded('lib/server/automation/automation-runbooks.ts','MFA_SETUP_REQUIRED');
 assert.deepEqual(setup.map(({status,message})=>[status,message]),[[403,'apiError.mfa.setupRequired']]);
 const literal=["'MFA",' erforderlich.',"'"].join('');
 for(const file of ['lib','app','ui'].flatMap(sourceFiles))assert.ok(!read(file).includes(literal),`${file} contains ${literal}`);
 for(const file of ['ui/devices/remote/terminal-panel.tsx','ui/account/passkeys-panel.tsx']){
  const text=read(file);
  for(const forbidden of ['/Sequenz|sequenz/','/MFA|Bestätigung',"'MFA_REQUIRED'"])assert.ok(!text.includes(forbidden),`${file} contains ${forbidden}`);
  assert.match(text,/opensMfaPrompt\(e\.code\)/,`${file} uses the catalog helper`);
 }
 const terminal=read('ui/devices/remote/terminal-panel.tsx');
 assert.match(terminal,/e\.code==='TERMINAL_SEQUENCE_CONFLICT'/);
 assert.match(terminal,/stableT\(errorCatalog\.TERMINAL_SEQUENCE_CONFLICT\.key\)/,'the terminal shows the catalog text of the default key in the page language');
 assert.doesNotMatch(terminal,/errorCatalog\.\w+\.message/,'no client reads the server-language text of the catalog');
 assert.ok(!terminal.includes('in einer weiteren Ansicht bedient. Wartende Eingaben wurden verworfen.'),'the old terminal warning is gone');
});

// A keyed `new HttpError(key)` whose key has `code` (lib/errors/api-error-keys.ts), with
// the status of that code and the condition of the enclosing if.
function coded(file,code){
 return nodes(parse(file),node=>ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='HttpError'&&(node.arguments?.length??0)>0&&ts.isStringLiteralLike(node.arguments[0])&&apiErrorCodes[node.arguments[0].text]===code).map(node=>{
  let statement=node.parent;while(statement&&!ts.isIfStatement(statement))statement=statement.parent;
  return {status:errorCatalog[code].status,message:node.arguments[0].text,condition:statement?.expression.getText()??''};
 });
}

test('the pre-checks for group depth and subgroups send the code of their trigger with the catalog text',()=>{
 assert.deepEqual(coded('lib/server/identity/access-admin.ts','DEVICE_GROUP_DEPTH_LIMIT'),[{status:409,message:'apiError.group.depthLimit',condition:'(await deviceGroupAncestors(parentId)).length>4'}]);
 const children=coded('lib/server/identity/rbac.ts','DEVICE_GROUP_HAS_CHILDREN');
 assert.equal(children.length,1);
 assert.deepEqual([children[0].status,children[0].message],[409,'apiError.group.hasChildren']);
 assert.match(children[0].condition,/SELECT id FROM device_groups WHERE parent_id=\$\{groupId\} LIMIT 1/);
 for(const text of ['Eine Gerätegruppe kann höchstens vier Ebenen von Untergruppen haben.','Diese Gruppe hat noch Untergruppen. Lösche oder verschiebe die Untergruppen und versuche es erneut.'])
  for(const file of ['lib/server/identity/access-admin.ts','lib/server/identity/rbac.ts'])assert.ok(!read(file).includes(text),`${file} takes „${text}“ from the catalog`);
});

test('no source file parses a registered constraint target, and the dead wrapper is gone',()=>{
 const targets=/device_group_members\\?\.server_id|customers\\?\.name|customer_installers_enrollments/,offenders=[];
 for(const file of ['lib','app','ui'].flatMap(sourceFiles)){
  if(errorContract(file))continue;
  const source=parse(file);
  for(const node of nodes(source,node=>
   ts.isRegularExpressionLiteral(node)&&targets.test(node.text)||
   ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='includes'&&node.arguments.some(arg=>ts.isStringLiteralLike(arg)&&targets.test(arg.text))||
   ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='RegExp'&&(node.arguments??[]).some(arg=>ts.isStringLiteralLike(arg)&&targets.test(arg.text))
  ))offenders.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line+1} ${node.getText().slice(0,80)}`);
 }
 assert.deepEqual(offenders,[]);
 // Built from parts so this file does not contain the name itself.
 const wrapper=['deviceGroup','HierarchyFailure'].join('');
 const allFiles=dir=>readdirSync(dir).flatMap(name=>{const file=path.join(dir,name);return statSync(file).isDirectory()?allFiles(file):/\.(?:ts|tsx|mjs|js)$/.test(name)?[file]:[];});
 assert.deepEqual(['lib','app','ui','tests'].flatMap(allFiles).filter(file=>read(file).includes(wrapper)),[]);
});

// ---- The keyed contract: codes, message keys and the registry.
test('every code has a status and a default key; every apiError key has exactly one registered code',()=>{
 const {apiErrorCodes}=sourceLoader()('lib/errors/api-error-keys.ts');
 const en=sourceLoader()('lib/i18n/messages/en.ts').default,de=sourceLoader()('lib/i18n/messages/de.ts').default;
 for(const [code,entry] of Object.entries(errorCatalog)){
  assert.ok(Number.isInteger(entry.status)&&entry.status>=400&&entry.status<600,`${code} has an HTTP status`);
  assert.ok(Object.hasOwn(en,entry.key)&&Object.hasOwn(de,entry.key),`${code}: the default key ${entry.key} exists in en and de`);
  assert.equal(apiErrorCodes[entry.key],code,`${code}: its default key maps back to it`);
  assert.equal(entry.message,translate('en',entry.key),`${code}: message is the defaultLocale text for the text form`);
 }
 const keys=Object.keys(en).filter(key=>key.startsWith('apiError.'));
 assert.deepEqual(Object.keys(apiErrorCodes).sort(),keys.sort(),'the registry holds exactly the apiError keys of the catalog');
 for(const [key,code] of Object.entries(apiErrorCodes))assert.ok(Object.hasOwn(errorCatalog,code),`${key} maps to the registered code ${code}`);
});

test('every code and status from before the keyed contract still exists unchanged',()=>{
 // errorCatalog of main before the keyed contract, plus the codes that throws sent without a catalog entry.
 const before={VALIDATION_FAILED:400,INTERNAL_ERROR:500,STORAGE_UNAVAILABLE:503,MFA_LOGIN_REQUIRED:403,MFA_STEP_UP_REQUIRED:403,MFA_SETUP_REQUIRED:403,TERMINAL_SEQUENCE_CONFLICT:409,INSTALLER_GROUP_MISSING:409,INSTALLER_EXHAUSTED:409,ENROLL_CUSTOMER_REQUIRED:400,
  CUSTOMER_DISABLED:409,CUSTOMER_MISMATCH:409,CUSTOMER_MISSING:404,CUSTOMER_ROLE_PERMISSIONS:400,CUSTOMER_ROLE_SCOPE:400,CUSTOMER_CATALOG_MISMATCH:400,CUSTOMER_CATALOG_IMMUTABLE:400,CUSTOMER_DEFAULT_PROTECTED:409,CUSTOMER_INSTALLER_GROUP_MISMATCH:400,CUSTOMER_SETTINGS_INVALID:400,CUSTOMER_ASSIGNMENT_SUBJECT_MISSING:409,
  DEVICE_GROUP_CYCLE:409,DEVICE_GROUP_DEPTH_LIMIT:409,DEVICE_GROUP_HAS_CHILDREN:409,DEVICE_GROUP_MEMBER_MISSING:409,DEVICE_GROUP_MEMBERSHIP_PATH_CONFLICT:409,DEVICE_GROUP_PARENT_MISSING:409,ALERT_RULE_INVALID:400,ALERT_RULE_CHANGED:409,ALERT_RULE_SCOPE_BOUNDARY:403,ALERT_INVALID:400,ALERT_STATE_CHANGED:409,
  OS_ESU_INVALID:400,OS_ESU_CHANGED:409,SOFTWARE_REPORT_INVALID:400,DEVICE_DESCRIPTION_INVALID:400,DEVICE_DESCRIPTION_CHANGED:409,TAG_INVALID:400,TAG_NAME_TAKEN:409,TAG_LIMIT:409,TAG_CHANGED:409,
  MAINTENANCE_OWNER_ONLY:403,MAINTENANCE_RETENTION_INVALID:400,MAINTENANCE_TIME_INVALID:400,MAINTENANCE_TIME_ZONE_INVALID:400,MAINTENANCE_SETTINGS_CONFLICT:409,MAINTENANCE_RUNNING:409,MAINTENANCE_MIGRATIONS_PENDING:409,DEVICE_GROUP_MEMBERSHIP_TAKEN:409,CUSTOMER_NAME_TAKEN:409,
  AGENT_JOB_SIGNING_KEY_INVALID:503,AGENT_JOB_SIGNING_KEY_MISSING:503,INVALID_ACCOUNT_TOKEN:400,AUTH_STATE_CHANGED:409,INSTALLER_INVALID:403,INSTALLER_REVOKED:403,INSTALLER_EXPIRED:403,
  DESIRED_CONFIGURATION_CHANGED:409,DESIRED_EXECUTION_RUNNING:409,DESIRED_ASSIGNMENT_CONFLICT:409,DESIRED_SCHEDULE_CONFLICT:409,DESIRED_ASSIGNMENT_CHANGED:409,DESIRED_APPROVAL_CHANGED:409,DESIRED_DEVICE_BUSY:409,
  ACCESS_NOT_APPROVED:403,DEVICE_REGISTRATION_EXPIRED:403,DEVICE_TOKEN_REJECTED:403,DEVICE_KEY_REQUIRED:409,DEVICE_CHALLENGE_EXPIRED:409,DEVICE_CHALLENGE_CHANGED:409,
  IDENTITY_LOGIN_REQUIRED:401,SESSION_EXPIRED:401,AUTH_RATE_LIMITED:429,INVALID_CREDENTIALS:401,CROSS_CUSTOMER_FORBIDDEN:403,RDP_FEATURE_PAUSED:503,
  AGENT_UNINSTALL_CONFIRMED:403,AGENT_UNINSTALL_NOT_CONFIRMED:409};
 for(const [code,status] of Object.entries(before))assert.equal(errorCatalog[code]?.status,status,code);
 // The two codes of the former license gate are gone (built from parts: tests/repo/single-edition.mjs forbids the names).
 for(const code of ['NOT_ACTIVE','READ_ONLY'].map(rest=>'MSP_'+rest))assert.equal(Object.hasOwn(errorCatalog,code),false,code+' is not in the catalog');
 // The generic codes per status are new and no client or agent branches on them.
 const generic={INVALID_REQUEST:400,UNAUTHORIZED:401,FORBIDDEN:403,NOT_FOUND:404,CONFLICT:409,GONE:410,PAYLOAD_TOO_LARGE:413,RATE_LIMITED:429,BAD_GATEWAY:502,SERVICE_UNAVAILABLE:503};
 for(const [code,status] of Object.entries(generic))assert.equal(errorCatalog[code]?.status,status,code);
 for(const code of Object.keys(generic))assert.equal(opensMfaPrompt(code),false,code);
 const http=read('ui/base/http.ts');for(const code of Object.keys(generic))assert.ok(!http.includes(`'${code}'`),`ui/base/http.ts does not branch on ${code}`);
});

test('a keyed HttpError carries code, status, key and params; the text form maps constant texts to their keys',()=>{
 const {HttpError}=sourceLoader()('lib/errors/http-error.ts');
 const keyed=new HttpError('apiError.access.devicePermissionMissing',{permission:'diagnose'});
 assert.deepEqual([keyed.status,keyed.code,keyed.messageKey,keyed.params,keyed.message],[403,'FORBIDDEN','apiError.access.devicePermissionMissing',{permission:'diagnose'},translate('en','apiError.access.devicePermissionMissing',{permission:'diagnose'})]);
 const constant=new HttpError(404,customerUnavailableMessage);
 assert.deepEqual([constant.status,constant.code,constant.messageKey],[404,'CUSTOMER_MISSING','apiError.customer.unavailable'],'a constant text gives its key and code');
 const otherStatus=new HttpError(403,customerUnavailableMessage);
 assert.deepEqual([otherStatus.status,otherStatus.code,otherStatus.messageKey],[403,'FORBIDDEN','apiError.customer.unavailable'],'a constant text under another status keeps its key but gets the generic code of the status');
 const coded=new HttpError(403,errorCatalog.MFA_STEP_UP_REQUIRED.message,'CUSTOM_CODE');
 assert.deepEqual([coded.code,coded.messageKey],['CUSTOM_CODE','apiError.mfa.stepUpRequired'],'a given code wins over the key code');
 const unknown=new HttpError(409,'Ein Text eines Testdoubles.');
 assert.deepEqual([unknown.status,unknown.code,unknown.messageKey,unknown.message],[409,'CONFLICT',undefined,'Ein Text eines Testdoubles.'],'an unknown text gets the generic code and no key');
 assert.equal(new HttpError(418,'teapot').code,'INVALID_REQUEST','an unlisted 4xx status gets INVALID_REQUEST');
});

// Every HttpError under app/ and lib/ is built from a message key: no text, template or
// concatenation, also not through a wrapper. The text form stays for test doubles only.
function textHttpErrors(file,source=read(file)){
 const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS),found=[];
 const isText=node=>!!node&&(ts.isStringLiteralLike(node)&&!node.text.startsWith('apiError.')||ts.isTemplateExpression(node)||ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken||ts.isConditionalExpression(node)&&(isText(node.whenTrue)||isText(node.whenFalse)));
 (function visit(node){
  if(ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='HttpError'){
   const [first,second]=node.arguments??[];
   const numericStatus=!!first&&(ts.isNumericLiteral(first)||ts.isConditionalExpression(first)&&ts.isNumericLiteral(first.whenTrue));
   const textMessage=!!second&&!ts.isObjectLiteralExpression(second)&&!ts.isIdentifier(second)&&!ts.isPropertyAccessExpression(second);
   if(numericStatus||isText(first)||textMessage&&isText(second)||numericStatus&&second)found.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line+1} ${node.getText().slice(0,90)}`);
  }
  ts.forEachChild(node,visit);
 })(tree);
 return found;
}
test('no file under app/ or lib/ builds an HttpError from a text',()=>{
 // lib/errors/http-error.ts defines the text form.
 const allowed=['lib/errors/http-error.ts'];
 const offenders=['app','ui','lib'].flatMap(sourceFiles).map(file=>file.split(path.sep).join('/')).filter(file=>!allowed.includes(file)).flatMap(file=>textHttpErrors(file));
 assert.deepEqual(offenders,[]);
 // The scanner itself flags literal, template, concatenated and numeric-status forms.
 for(const sample of ["throw new HttpError(400,'Ungültige Anfrage.');","throw new HttpError(403,'Fehlt: '+right);","throw new HttpError(409,`Gerät ${name}`);","const x=new HttpError(404,customerMissingMessage);","throw new HttpError('Agent nicht freigegeben.');","throw new HttpError(c?'apiError.a':'Text');","throw new HttpError(c?401:403,message);"])
  assert.notDeepEqual(textHttpErrors('probe.ts',sample),[],`the scan flags ${sample}`);
 for(const sample of ["throw new HttpError('apiError.request.invalid');","throw new HttpError('apiError.release.sameVersion',{name:d.name});","throw new HttpError(c?'apiError.a':'apiError.b');","throw new HttpError(key,params);","throw new HttpError(conflict.key);","throw new HttpError(errorCatalog[code].key);"])
  assert.deepEqual(textHttpErrors('probe.ts',sample),[],`the scan accepts ${sample}`);
});
