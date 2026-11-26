// QR code of an authenticator setup: the real component renders an
// inline SVG whose modules decode with jsQR to exactly the otpauth:// URI of
// lib/server/identity/mfa.ts, with a quiet zone, a screen-reader label and an expiry notice.
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import jsQR from 'jsqr';
import {de} from '../../support/i18n-stubs.mjs';
const require=createRequire(import.meta.url),cache=new Map(),root=process.cwd();
let clock=Date.now();
const http={portalNow:()=>clock};
function load(filename){
 const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};
 const source=fs.readFileSync(absolute,'utf8'),mod={exports:{}};cache.set(absolute,mod);
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 function localRequire(id){if(id==='@/ui/base/http')return http;if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),candidate=[base,base+'.ts',base+'.tsx',base+'.js',base+'/index.ts',base+'/index.tsx'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());if(candidate)return load(candidate);}return require(id);}
 new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
}
const {otpauthUri}=load('lib/server/identity/mfa-uri.ts'),{qrMatrix}=load('ui/session/qr-matrix.ts'),MfaQrCode=load('ui/session/mfa-qr-code.tsx').default;
const read=file=>fs.readFileSync(file,'utf8');
// Assert on the markup without dumping a whole QR path into the failure message.
const has=(html,pattern,label)=>assert.ok(pattern.test(html),label);
const render=props=>renderToStaticMarkup(React.createElement(MfaQrCode,props));
const label='QR-Code zum Einrichten der Authenticator-App';
const caption='Scanne den Code mit deiner Authenticator-App oder gib den Schlüssel unten ein.';
const expired='Die Einrichtung ist abgelaufen. Starte sie neu, um einen neuen QR-Code zu erhalten.';

// One URI builder with the unchanged format.
const secret='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
assert.equal(otpauthUri('Nodiverna:anna',secret),`otpauth://totp/Nodiverna%3Aanna?secret=${secret}&issuer=Nodiverna&algorithm=SHA1&digits=6&period=30`);
const mfa=read('lib/server/identity/mfa.ts');
assert.ok(!mfa.includes('otpauth://'),'lib/server/identity/mfa.ts has no otpauth:// literal');
assert.ok(mfa.includes("import {otpauthUri} from './mfa-uri';"),'lib/server/identity/mfa.ts imports otpauthUri');
const body=name=>{const start=mfa.indexOf(`export async function ${name}(`);assert.ok(start>=0,`${name} exists`);const end=mfa.indexOf('\nexport ',start+1);return mfa.slice(start,end<0?undefined:end);};
assert.match(body('beginMfa'),/uri:otpauthUri\(productName\+':'\+\(v\.username\?\?v\.label\),secret\)/,'beginMfa builds its URI with otpauthUri');
assert.match(body('beginAuthenticator'),/uri:otpauthUri\(productName\+':'\+v\.label\+' \('\+name\+'\)',secret\)/,'beginAuthenticator builds its URI with otpauthUri');
const uriSource=read('lib/server/identity/mfa-uri.ts');
assert.deepEqual(uriSource.match(/^import .*$/gm),["import {productName} from '../../brand';"],'lib/server/identity/mfa-uri.ts imports only productName');

// Decode an SVG render: parse viewBox and path, draw 4 px per module, run jsQR.
function decode(html){
 const box=html.match(/viewBox="0 0 (\d+) (\d+)"/);assert.ok(box,'svg has a viewBox');
 const size=Number(box[1]);assert.equal(Number(box[2]),size,'the viewBox is square');
 const paths=html.match(/<path\b[^>]*>/g)??[];assert.equal(paths.length,1,'exactly one path');
 const d=paths[0].match(/\bd="([^"]*)"/)[1];
 assert.match(d,/^(?:M\d+ \d+h1v1h-1z)+$/,'the path holds only unit squares');
 const dark=[...d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(([,x,y])=>[Number(x),Number(y)]);
 const scale=4,width=size*scale,pixels=new Uint8ClampedArray(width*width*4).fill(255);
 for(const [x,y] of dark){
  assert.ok(x>=4&&y>=4&&x<size-4&&y<size-4,`module ${x},${y} stays out of the 4-module quiet zone`);
  for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){const at=((y*scale+dy)*width+x*scale+dx)*4;pixels[at]=pixels[at+1]=pixels[at+2]=0;}
 }
 return {size,dark,decoded:jsQR(pixels,width,width)};
}

// Both URI variants of lib/server/identity/mfa.ts decode exactly.
const name=('Mein iPhone – Büro (Ä) '.repeat(4)).slice(0,79)+'x';
assert.equal(name.length,80,'the authenticator name has 80 characters');
const uris=[
 otpauthUri('Nodiverna:anna',secret),
 otpauthUri('Nodiverna:owner@example.test ('+name+')',secret),
];
for(const uri of uris){
 const html=render({uri,expiresAt:clock+600000});
 has(html,/^<figure class="sd-mfa-qr">/,'a fixed-light figure');
 has(html,/<svg role="img" aria-label="QR-Code zum Einrichten der Authenticator-App"/,'svg is an image with its label');
 assert.ok(html.includes(`aria-label="${label}"`));
 has(html,/shape-rendering="crispEdges"/,'crisp module edges');
 assert.equal((html.match(/<rect\b/g)??[]).length,1,'one background rect');
 has(html,/<rect class="sd-mfa-qr-surface" width="(\d+)" height="\1"><\/rect>/,'the rect covers the whole area');
 assert.equal(html.match(/<rect class="sd-mfa-qr-surface" width="(\d+)"/)[1],html.match(/viewBox="0 0 (\d+)/)[1],'the rect is as large as the viewBox');
 assert.ok(html.includes(`<figcaption>${caption}</figcaption>`),'caption below the code');
 assert.ok(!/style=/.test(html),'no style attribute');
 const {size,dark,decoded}=decode(html),modules=qrMatrix(uri).length;
 assert.equal(size,modules+8,'viewBox side is module count + 8');
 assert.ok(dark.length>0,'the code has dark modules');
 assert.ok(decoded,'jsQR finds the code');
 assert.equal(decoded.data,uri,'the code decodes to exactly the setup URI');
}
// The matrix encodes UTF-8 bytes, so text outside Latin-1 survives as well.
{
 const html=render({uri:'otpauth://totp/Büro – 🔑',expiresAt:clock+1000});
 assert.equal(decode(html).decoded?.data,'otpauth://totp/Büro – 🔑','non-ASCII text decodes unchanged');
}

// At or after expiry (portalNow) only the notice renders.
for(const expiresAt of [clock,clock-1]){
 const html=render({uri:uris[0],expiresAt});
 assert.ok(!html.includes('<svg'),'no svg after expiry');
 assert.equal(html,`<p class="sd-mfa-qr-expired" role="status">${expired}</p>`,'the expiry notice is a status');
}
{
 const setupEnd=clock+600000;assert.ok(render({uri:uris[0],expiresAt:setupEnd}).includes('<svg'),'a running setup shows the code');
 const start=clock;clock=setupEnd;assert.ok(!render({uri:uris[0],expiresAt:setupEnd}).includes('<svg'),'server time from portalNow decides, not Date.now');clock=start;
}

// No network, no raw HTML, no image or data URL in the component or matrix.
for(const file of ['ui/session/mfa-qr-code.tsx','ui/session/qr-matrix.ts','lib/server/identity/mfa-uri.ts']){
 const source=read(file);
 for(const banned of ['fetch','XMLHttpRequest','http://','https://','dangerouslySetInnerHTML','<img','data:','createDataURL','createImgTag','createSvgTag'])assert.ok(!source.includes(banned),`${file} does not contain ${banned}`);
}
const component=read('ui/session/mfa-qr-code.tsx');
assert.match(component,/useMemo\(/,'the matrix is memoised');
assert.match(component,/setTimeout\(/,'a timer switches to the notice');
assert.match(component,/clearTimeout\(timer\)/,'the timer is cleared on unmount');
const matrix=read('ui/session/qr-matrix.ts');
assert.match(matrix,/qrcodeGenerator\(0,'M'\)/,'automatic type number, level M');
assert.match(matrix,/'Byte'\)/,'byte mode');

// Exact pins in package.json and the lockfile.
const pkg=JSON.parse(read('package.json'));
assert.equal(pkg.dependencies['qrcode-generator'],'2.0.4','qrcode-generator is pinned exactly');
assert.equal(pkg.devDependencies.jsqr,'1.4.0','jsqr is pinned exactly as a dev dependency');
assert.equal(pkg.devDependencies['qrcode-generator'],undefined);assert.equal(pkg.dependencies.jsqr,undefined);
const lock=read('pnpm-lock.yaml');
assert.match(lock,/\n {6}qrcode-generator:\n {8}specifier: 2\.0\.4\n {8}version: 2\.0\.4\n/,'lockfile importer pins qrcode-generator 2.0.4');
assert.match(lock,/\n {6}jsqr:\n {8}specifier: 1\.4\.0\n {8}version: 1\.4\.0\n/,'lockfile importer pins jsqr 1.4.0');
assert.deepEqual([...new Set(lock.match(/\n {2}qrcode-generator@[^:]+:/g))].map(line=>line.trim()),['qrcode-generator@2.0.4:'],'one qrcode-generator version');
assert.deepEqual([...new Set(lock.match(/\n {2}jsqr@[^:]+:/g))].map(line=>line.trim()),['jsqr@1.4.0:'],'one jsqr version');

// Tokens only, no color-scheme, scannable size on a 375 px screen.
const css=read('ui/session/mfa-qr-code.css');
assert.doesNotMatch(css,/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-scheme/i,'no color literal and no color-scheme');
assert.match(css,/\.sd-mfa-qr svg\{[^}]*width:min\(100%,224px\)/,'the code is up to 224 px wide and never wider than its box');
assert.match(css,/\.sd-mfa-qr svg\{[^}]*aspect-ratio:1/);
assert.match(css,/\.sd-mfa-qr svg\{[^}]*border:1px solid var\(--sd-line\);border-radius:var\(--sd-radius-sm\)/);
assert.match(css,/\.sd-mfa-qr figcaption\{[^}]*font-size:12px[^}]*color:var\(--sd-muted\)/);

// Both setup screens place the code before the setup key and keep the rest.
const gate=read('ui/session/session-gate.tsx'),security=read('ui/account/account-panel.tsx');
assert.ok(gate.includes("import MfaQrCode from '@/ui/session/mfa-qr-code';")&&security.includes("import MfaQrCode from '@/ui/session/mfa-qr-code';"));
assert.match(gate,/<p>\{t\('session\.addToApp'\)\}<\/p>\s*<MfaQrCode uri=\{setup\.uri\} expiresAt=\{setup\.expiresAt\}\/>\s*<div className="sd-session-secret">/,'session gate: code between intro and setup key');
assert.equal(de('session.addToApp'),'Füge Nodiverna zu deiner Authenticator-App hinzu und bestätige den angezeigten Code.');
assert.match(security,/const drawerIntro=setup\?t\('account\.setupIntro'\)/,'account drawer: the setup intro is the drawer description');
assert.match(security,/\{setup&&<>\s*<MfaQrCode uri=\{setup\.uri\} expiresAt=\{setup\.expiresAt\}\/>\s*<div className="sdx-account-setup-key">/,'account drawer: code before the setup key');
assert.equal(de('account.setupIntro'),'Füge Nodiverna zu deiner App hinzu und bestätige den neuen Eintrag mit dem angezeigten Code.');
console.log('PASS: the authenticator setup QR code decodes to the exact otpauth URI of both setup variants, keeps a 4-module quiet zone, is labelled for screen readers, uses tokens only and turns into a status notice at expiry.');
