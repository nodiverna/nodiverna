// The console density cookie (lib/density.ts): the two densities, parseDensity (anything unknown is comfortable) and
// the cookie string in the form of the theme cookie, with and without Secure, never HttpOnly.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const {densities,densityCookieName,parseDensity,densityCookie}=await import('../../lib/density.ts');

assert.deepEqual([...densities],['comfortable','compact']);
assert.equal(densityCookieName,'serverdesk-density');
for(const value of densities)assert.equal(parseDensity(value),value);
for(const value of [undefined,null,'','Compact','COMFORTABLE','dense','compact; x',' compact',1,{}])assert.equal(parseDensity(value),'comfortable',`parseDensity(${JSON.stringify(value)})`);
assert.equal(densityCookie('compact',false),'serverdesk-density=compact; Path=/; Max-Age=31536000; SameSite=Lax');
assert.equal(densityCookie('comfortable',true),'serverdesk-density=comfortable; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
for(const value of densities)for(const secure of [false,true])assert.doesNotMatch(densityCookie(value,secure),/httponly/i);
console.log('PASS density cookie (17 checks): the values, parseDensity and the cookie string.');
