import {createHmac,randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {HttpError} from '../../errors/http-error';

// The low-memory OWASP scrypt profile keeps each hash at 16 MiB of memory, so
// parallel sign-ins stay cheap on a small server. It uses native node:crypto.
const cost=16384,blockSize=8,parallelism=5,keyLength=32,maximumMemory=32*1024*1024;
const prefix=`v1$scrypt$${cost}$${blockSize}$${parallelism}$`;
const encoder=new TextEncoder();
const dummySalt=Buffer.alloc(32,0x5d);
const dummyDerived=Buffer.alloc(keyLength);

// A deliberately small, bundled common-password blocklist. This supplements
// length and MFA; it does not claim complete coverage of breached passwords.
const commonPasswords=new Set([
 '123456789012345','1234567890123456','12345678901234567890',
 'passwordpassword','password1234567','password12345678','password123456789',
 'password1234567890','passwordpassword123','passwordpassword123!',
 'qwertyuiopasdfgh','qwertyuiopasdfghjkl','qwerty1234567890',
 'letmeinletmein123','changemechangeme','changeme12345678',
 'thisisapassword','this is a password','correcthorsebatterystaple',
 'correct horse battery staple','adminadminadmin','administrator123',
 'welcome12345678','welcome123456789','testtesttesttest','iloveyouiloveyou',
 'aaaaaaaaaaaaaaa','aaaaaaaaaaaaaaaa','111111111111111','1111111111111111',
]);

function validEncoding(value:string){
 for(const character of value){
  const code=character.charCodeAt(0);
  if(character.length===1&&code>=0xd800&&code<=0xdfff)return false;
 }
 return true;
}

export function validatePassword(value:unknown):string{
 if(typeof value!=='string'||value.length>256||!validEncoding(value))throw new HttpError('apiError.password.length');
 const length=Array.from(value).length;
 if(length<15||length>128||encoder.encode(value).byteLength>1024)throw new HttpError('apiError.password.lengthBytes');
 if(commonPasswords.has(value.toLowerCase()))throw new HttpError('apiError.password.common');
 return value;
}

function pepperKey(pepper:string){
 if(typeof pepper!=='string'||encoder.encode(pepper).byteLength<32)throw new Error('The secure password configuration is not available.');
 return Buffer.from(pepper,'utf8');
}

function protectedDerived(derived:Uint8Array,pepper:Buffer){
 return createHmac('sha256',pepper).update(derived).digest();
}

function derive(password:Uint8Array,salt:Uint8Array):Promise<Buffer>{
 return new Promise((resolve,reject)=>{
  scrypt(password,salt,keyLength,{N:cost,r:blockSize,p:parallelism,maxmem:maximumMemory},(error,result)=>error?reject(error):resolve(result));
 });
}

type PasswordRecord={salt:Buffer;digest:Buffer};
function parseRecord(value:unknown):PasswordRecord|null{
 if(typeof value!=='string'||value.length!==prefix.length+87||!value.startsWith(prefix))return null;
 const fields=value.slice(prefix.length).split('$');
 if(fields.length!==2||fields.some(field=>!/^[A-Za-z0-9_-]{43}$/.test(field)))return null;
 const [salt,digest]=fields.map(field=>Buffer.from(field,'base64url'));
 if(salt.length!==32||digest.length!==keyLength||salt.toString('base64url')!==fields[0]||digest.toString('base64url')!==fields[1])return null;
 return {salt,digest};
}

// A deterministic valid-format dummy needs only an HMAC, never a warmup KDF.
// Unknown-user verification therefore performs exactly one ordinary KDF.
export async function dummyPasswordRecord(pepper:string):Promise<string>{
 return prefix+dummySalt.toString('base64url')+'$'+protectedDerived(dummyDerived,pepperKey(pepper)).toString('base64url');
}

export async function hashPassword(password:unknown,pepper:string):Promise<string>{
 const value=validatePassword(password),key=pepperKey(pepper),salt=randomBytes(32);
 const derived=await derive(encoder.encode(value),salt);
 try{return prefix+salt.toString('base64url')+'$'+protectedDerived(derived,key).toString('base64url');}
 finally{derived.fill(0);}
}

export async function verifyPassword(password:unknown,record:unknown,pepper:string):Promise<boolean>{
 const key=pepperKey(pepper),parsed=parseRecord(record);
 // Verification permits existing passwords that predate a later blocklist.
 // It still bounds attacker-controlled input and rejects invalid Unicode so
 // TextEncoder cannot map different malformed strings to the same bytes.
 const inputValid=typeof password==='string'&&password.length<=256&&validEncoding(password)&&Array.from(password).length>=15&&Array.from(password).length<=128&&encoder.encode(password).byteLength<=1024;
 const bytes=encoder.encode(inputValid?password:'ServerDesk dummy verification password v1');
 const derived=await derive(bytes,parsed?.salt??dummySalt);
 try{
  const actual=protectedDerived(derived,key),expected=parsed?.digest??protectedDerived(dummyDerived,key);
  const matches=timingSafeEqual(actual,expected);
  return !!parsed&&inputValid&&matches;
 }finally{derived.fill(0);}
}
