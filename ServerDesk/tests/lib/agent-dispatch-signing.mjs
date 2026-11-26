// The job dispatch signer (lib/server/agent/agent-dispatch.ts): PEM and single-line DER keys, the lifetimes and the signature
// the agent checks.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {createPublicKey,generateKeyPairSync,verify} from 'node:crypto';
const {dispatchSigner,DISPATCH_LIFETIME_SECONDS,TERMINAL_LEASE_SECONDS}=await import('../../lib/server/agent/agent-dispatch.ts');

const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const der=pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),pem=pair.privateKey.export({type:'pkcs8',format:'pem'});
const expected=pair.publicKey.export({type:'spki',format:'der'}).toString('base64');
assert.equal(dispatchSigner(''),null);assert.equal(dispatchSigner('  \n'),null);
// PEM and single-line DER name the same key the agent pins at installation.
const signer=dispatchSigner(der);assert.equal(signer.publicKey,expected);assert.equal(dispatchSigner(pem).publicKey,expected);
const device='0f8fad5b-d9cb-469f-a165-70867728950e',time=1_790_000_000_123;
const job={id:'7c9e6679-7425-40de-944b-e07fc1f90ae7',type:'restart-service',target:'Spooler'};
const envelope=signer.sign(device,'job',{job},DISPATCH_LIFETIME_SECONDS,time);
assert.deepEqual(Object.keys(envelope).sort(),['payload','signature']);
assert.deepEqual(JSON.parse(envelope.payload),{job,v:1,kind:'job',deviceId:device,iat:1_790_000_000,exp:1_790_000_000+900});
// IEEE P1363 (r||s), the form .NET's ECDsa.VerifyData expects by default.
const signature=Buffer.from(envelope.signature,'base64');assert.equal(signature.length,64);
const publicKey=createPublicKey({key:Buffer.from(signer.publicKey,'base64'),format:'der',type:'spki'});
assert.ok(verify('sha256',Buffer.from(envelope.payload,'utf8'),{key:publicKey,dsaEncoding:'ieee-p1363'},signature));
assert.ok(!verify('sha256',Buffer.from(envelope.payload.replace('Spooler','WinRM'),'utf8'),{key:publicKey,dsaEncoding:'ieee-p1363'},signature));
// Envelope fields cannot be overridden by the signed body.
const lease=signer.sign(device,'terminal',{sessions:['a'],kind:'job',deviceId:'other'},TERMINAL_LEASE_SECONDS,time);
assert.deepEqual(JSON.parse(lease.payload),{sessions:['a'],v:1,kind:'terminal',deviceId:device,iat:1_790_000_000,exp:1_790_000_060});
// The key errors are keyed 503 AGENT_JOB_SIGNING_KEY_INVALID answers.
assert.throws(()=>dispatchSigner('not a key'),{status:503,code:'AGENT_JOB_SIGNING_KEY_INVALID',messageKey:'apiError.signing.keyUnreadable'});
const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
assert.throws(()=>dispatchSigner(rsa),{code:'AGENT_JOB_SIGNING_KEY_INVALID',messageKey:'apiError.signing.keyType',message:/ECDSA P-256/});
const p384=generateKeyPairSync('ec',{namedCurve:'secp384r1'}).privateKey.export({type:'pkcs8',format:'pem'});
assert.throws(()=>dispatchSigner(p384),{code:'AGENT_JOB_SIGNING_KEY_INVALID',messageKey:'apiError.signing.keyType'});
console.log('agent dispatch signing ok');
