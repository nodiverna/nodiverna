// Self-signed RSA certificates for the certificate credential of the Entra
// tests, made at runtime with node:crypto (no key in the repository), in the
// DER form of tests/support/test-certificate.mjs. `bits` sets the key size,
// `notAfter` the end of validity as UTCTime text, `keyFormat` the PEM of the key:
// 'pkcs8', 'pkcs1' or 'encrypted' (PKCS#8 with a passphrase).
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {certificateSerial} from './test-certificate.mjs';

const length=size=>size<0x80?Buffer.from([size]):(()=>{const bytes=[];for(let rest=size;rest>0;rest>>=8)bytes.unshift(rest&0xff);return Buffer.from([0x80|bytes.length,...bytes]);})();
const tlv=(tag,...parts)=>{const content=Buffer.concat(parts);return Buffer.concat([Buffer.from([tag]),length(content.length),content]);};
const sequence=(...parts)=>tlv(0x30,...parts);
function oid(text){
 const [first,second,...rest]=text.split('.').map(Number),bytes=[40*first+second];
 for(const value of rest){const chunk=[value&0x7f];for(let rest7=Math.floor(value/128);rest7>0;rest7=Math.floor(rest7/128))chunk.unshift(0x80|(rest7&0x7f));bytes.push(...chunk);}
 return tlv(0x06,Buffer.from(bytes));
}
const name=commonName=>sequence(tlv(0x31,sequence(oid('2.5.4.3'),tlv(0x0c,Buffer.from(commonName,'utf8')))));
const time=text=>tlv(0x17,Buffer.from(text,'ascii'));
const rsaSha256=sequence(oid('1.2.840.113549.1.1.11'),tlv(0x05));

/** {certificatePem, privateKeyPem, keyObject, thumbprint (upper-case hex SHA-1 of the DER), der}. */
export function selfSignedCertificate({bits=2048,notAfter='491231235959Z',keyFormat='pkcs8',commonName='Nodiverna Entra test',keyPair}={}){
 const {privateKey,publicKey}=keyPair??generateKeyPairSync('rsa',{modulusLength:bits});
 const tbs=sequence(tlv(0xa0,tlv(0x02,Buffer.from([2]))),tlv(0x02,certificateSerial()),rsaSha256,name(commonName),sequence(time('000101000000Z'),time(notAfter)),name(commonName),publicKey.export({type:'spki',format:'der'}));
 const der=sequence(tbs,rsaSha256,tlv(0x03,Buffer.from([0]),sign('sha256',tbs,privateKey)));
 const certificatePem=`-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
 const privateKeyPem=keyFormat==='pkcs1'?privateKey.export({type:'pkcs1',format:'pem'}):keyFormat==='encrypted'?privateKey.export({type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase:'fixture'}):privateKey.export({type:'pkcs8',format:'pem'});
 return {certificatePem,privateKeyPem,keyObject:privateKey,publicKey,der,thumbprint:createHash('sha1').update(der).digest('hex').toUpperCase()};
}
