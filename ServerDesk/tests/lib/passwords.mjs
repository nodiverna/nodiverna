// Password hashing and checks (lib/server/identity/passwords.ts) with the real Node.js crypto module.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac,scryptSync} from 'node:crypto';
import ts from 'typescript';

const moduleUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const source=await readFile(new URL('../../lib/server/identity/passwords.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const instrumentationUrl=moduleUrl(`
 import {scrypt as nativeScrypt,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
 export {createHmac,randomBytes,timingSafeEqual};
 export let calls=0;
 export function resetCalls(){calls=0;}
 export function scrypt(...args){calls++;return nativeScrypt(...args);}
`);
const cryptoInstrumentation=await import(instrumentationUrl);
// The keyed policy errors come from the real HttpError module, loaded through the shared TypeScript loader.
await import('../support/register.mjs');
const httpErrorUrl=new URL('../../lib/errors/http-error.ts',import.meta.url).href;
const passwords=await import(moduleUrl(compiled.replace('"node:crypto"',JSON.stringify(instrumentationUrl)).replace("'node:crypto'",JSON.stringify(instrumentationUrl)).replace(/(["'])\.\.\/\.\.\/errors\/http-error\1/,JSON.stringify(httpErrorUrl))));
const {validatePassword,hashPassword,verifyPassword,dummyPasswordRecord}=passwords;
const pepper='test-only-password-pepper-at-least-32-bytes';
const otherPepper='different-test-only-pepper-at-least-32-bytes';
const password='An isolated strong test passphrase 2026.';
let checks=0;
async function test(name,run){await run();checks++;console.log('PASS '+name);}

await test('Password policy counts Unicode code points and preserves exact input',async()=>{
 const accepted=['é'.repeat(15),'🙂'.repeat(15),'🙂'.repeat(128),' x'.repeat(8),' '.repeat(15),password];
 for(const value of accepted)assert.equal(validatePassword(value),value);
 for(const value of [null,undefined,123,{},'', 'x'.repeat(14),'🙂'.repeat(129),'x'.repeat(129),'x'.repeat(1025),'x'.repeat(15)+'\ud800','\udfff'+'x'.repeat(15)])assert.throws(()=>validatePassword(value));
});
await test('The bundled common-password blocklist is case insensitive, not a composition rule',async()=>{
 for(const value of ['passwordpassword','Password123456789','correct horse battery staple','123456789012345','QWERTYUIOPASDFGH','administrator123'])assert.throws(()=>validatePassword(value),{status:400,messageKey:'apiError.password.common'});
 assert.equal(validatePassword('a quiet valley at noon'), 'a quiet valley at noon');
});
await test('Hashing uses a fresh 32-byte salt, fixed bounded scrypt parameters and a keyed digest',async()=>{
 const first=await hashPassword(password,pepper),second=await hashPassword(password,pepper);
 assert.notEqual(first,second);
 for(const record of [first,second]){
  const [version,algorithm,n,r,p,salt,digest]=record.split('$');
  assert.equal(version,'v1');assert.equal(algorithm,'scrypt');assert.equal(n,'16384');assert.equal(r,'8');assert.equal(p,'5');
  const saltBytes=Buffer.from(salt,'base64url');assert.equal(saltBytes.length,32);assert.equal(Buffer.from(digest,'base64url').length,32);
  const derived=scryptSync(password,saltBytes,32,{N:16384,r:8,p:5,maxmem:32*1024*1024});
  assert.equal(digest,createHmac('sha256',pepper).update(derived).digest('base64url'));
  assert.notEqual(digest,derived.toString('base64url'),'the stored digest requires the external pepper');
 }
 assert.equal(await verifyPassword(password,first,pepper),true);
 assert.equal(await verifyPassword(password+'wrong',first,pepper),false);
 assert.equal(await verifyPassword(password,first,otherPepper),false);
});
await test('Dummy records are deterministic, structurally valid and require no KDF',async()=>{
 cryptoInstrumentation.resetCalls();
 const first=await dummyPasswordRecord(pepper),second=await dummyPasswordRecord(pepper);
 assert.equal(first,second);assert.equal(cryptoInstrumentation.calls,0);
 assert.notEqual(first,await dummyPasswordRecord(otherPepper));
 const fields=first.split('$');assert.equal(fields.length,7);assert.equal(fields[5].length,43);assert.equal(fields[6].length,43);
 cryptoInstrumentation.resetCalls();assert.equal(await verifyPassword(password,first,pepper),false);assert.equal(cryptoInstrumentation.calls,1);
});
await test('Every attempted verification performs one KDF even for malformed or expansive records',async()=>{
 const record=await hashPassword(password,pepper),parts=record.split('$');
 const changed=(index,value)=>parts.map((part,i)=>i===index?value:part).join('$');
 const malformed=[null,undefined,123,'',record+'$',record+'excess',changed(0,'v2'),changed(1,'pbkdf2'),changed(2,'1073741824'),changed(3,'64'),changed(4,'1000000'),changed(5,'!'.repeat(43)),changed(6,'short'),changed(5,parts[5].slice(0,-1)+'_')];
 // Force a noncanonical base64 tail without changing the decoded bytes.
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
 const tail=alphabet.indexOf(parts[5].at(-1));malformed.push(changed(5,parts[5].slice(0,-1)+alphabet[tail|1]));
 for(const value of malformed){cryptoInstrumentation.resetCalls();assert.equal(await verifyPassword(password,value,pepper),false);assert.equal(cryptoInstrumentation.calls,1);}
 for(const value of [null,undefined,123,'x'.repeat(14),'x'.repeat(2000),password+'\ud800']){
  cryptoInstrumentation.resetCalls();assert.equal(await verifyPassword(value,record,pepper),false);assert.equal(cryptoInstrumentation.calls,1);
 }
});
await test('Whitespace and Unicode are not normalized into another account password',async()=>{
 const value='  A whitespace test passphrase  ',record=await hashPassword(value,pepper);
 assert.equal(await verifyPassword(value,record,pepper),true);
 assert.equal(await verifyPassword(value.trim(),record,pepper),false);
 const composed='é'.repeat(15),unicodeRecord=await hashPassword(composed,pepper);
 assert.equal(await verifyPassword(composed,unicodeRecord,pepper),true);
 assert.equal(await verifyPassword(composed.normalize('NFD'),unicodeRecord,pepper),false);
});
await test('Missing pepper configuration fails closed without an expensive KDF',async()=>{
 for(const secret of ['', 'short', undefined]){
  cryptoInstrumentation.resetCalls();
  await assert.rejects(()=>hashPassword(password,secret),/configuration/i);
  await assert.rejects(()=>verifyPassword(password,'bad-record',secret),/configuration/i);
  await assert.rejects(()=>dummyPasswordRecord(secret),/configuration/i);
  assert.equal(cryptoInstrumentation.calls,0);
 }
});

console.log(`PASS passwords: ${checks} native Node scenarios.`);
