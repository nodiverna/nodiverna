import crypto from 'node:crypto';
// A real RFC 6238 TOTP code for a fixture secret, so tests confirm MFA the same
// way an authenticator app does.
export function fixtureTotp(secret,counter=Math.floor(Date.now()/30000)){
 let bits=0,n=0;const bytes=[];for(const char of secret){n=(n<<5)|'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);bits+=5;if(bits>=8){bytes.push((n>>>(bits-8))&255);bits-=8;}}
 const message=Buffer.alloc(8);message.writeBigUInt64BE(BigInt(counter));const mac=crypto.createHmac('sha1',Buffer.from(bytes)).update(message).digest(),offset=mac[19]&15;
 return String((mac.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
