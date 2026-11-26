// The upload checks of branding images (lib/server/branding-image.ts, docs/branding.md): the format by content
// (PNG, JPEG baseline and progressive, WebP VP8/VP8L/VP8X, SVG), the header dimensions, animated PNG and WebP, the
// logo and icon limits, the SVG cleaner (allowlisted elements and attributes, local references only, unsafe styles,
// DOCTYPE, ENTITY and malformed XML refused, a list of known XSS payloads, idempotence), the SVG size and the email
// logo URL helper. Fixtures are built in the test.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';

const {checkBrandingImage,cleanSvg,rasterInfo,emailLogoUrl}=await import('../../lib/server/branding-image.ts');

const u32be=value=>[value>>>24&255,value>>>16&255,value>>>8&255,value&255];
const u16be=value=>[value>>8&255,value&255];
const u32le=value=>[value&255,value>>>8&255,value>>>16&255,value>>>24&255];
const u24le=value=>[value&255,value>>8&255,value>>16&255];
const ascii=text=>[...text].map(char=>char.charCodeAt(0));
const bytes=parts=>Uint8Array.from(parts.flat());
const chunk=(type,data=[])=>[...u32be(data.length),...ascii(type),...data,0,0,0,0];
/** A PNG with IHDR, optional acTL before the image data, IDAT and IEND; `pad` adds bytes to reach a file size. */
const png=(width,height,{animated=false,pad=0}={})=>bytes([[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a],chunk('IHDR',[...u32be(width),...u32be(height),8,6,0,0,0]),animated?chunk('acTL',[0,0,0,1,0,0,0,0]):[],chunk('IDAT',new Array(pad).fill(0)),chunk('IEND')]);
/** A JPEG with APP0, a DHT (no size), then the SOF marker (C0 baseline, C2 progressive). */
const jpeg=(width,height,sof=0xc0)=>bytes([[0xff,0xd8],[0xff,0xe0,...u16be(16),...new Array(14).fill(0)],[0xff,0xc4,...u16be(4),0,0],[0xff,sof,...u16be(17),8,...u16be(height),...u16be(width),3,...new Array(9).fill(1)],[0xff,0xda,...u16be(2)],[0xff,0xd9]]);
const riff=chunks=>{const body=chunks.flat();return bytes([ascii('RIFF'),u32le(body.length+4),ascii('WEBP'),body]);};
const webpChunk=(type,data)=>[...ascii(type),...u32le(data.length),...data,...(data.length%2?[0]:[])];
const vp8=(width,height)=>riff([webpChunk('VP8 ',[0x30,0x01,0x00,0x9d,0x01,0x2a,...u16be(width).reverse(),...u16be(height).reverse(),0,0])]);
const vp8l=(width,height)=>riff([webpChunk('VP8L',[0x2f,...u32le((width-1)|((height-1)<<14)),0])]);
const vp8x=(width,height,{animated=false,anim=false}={})=>riff([webpChunk('VP8X',[animated?0x02:0,0,0,0,...u24le(width-1),...u24le(height-1)]),anim?webpChunk('ANIM',[0,0,0,0,0,0]):[],webpChunk('VP8L',[0x2f,...u32le((width-1)|((height-1)<<14)),0])]);
const svg=text=>new TextEncoder().encode(text);
const keyOf=run=>{try{run();return null;}catch(error){return error.messageKey??error.message;}};

test('the format and the size come from the bytes',()=>{
 for(const [name,file,expected] of [
  ['PNG',png(120,40),['image/png',120,40]],['JPEG baseline',jpeg(300,100),['image/jpeg',300,100]],['JPEG progressive (SOF2)',jpeg(64,64,0xc2),['image/jpeg',64,64]],
  ['WebP VP8',vp8(200,50),['image/webp',200,50]],['WebP VP8L',vp8l(333,111),['image/webp',333,111]],['WebP VP8X',vp8x(4096,512),['image/webp',4096,512]],
 ]){const info=rasterInfo(file);assert.deepEqual([info.contentType,info.width,info.height],expected,name);}
 // A PNG body is a PNG whatever the file is called: the routes never read a name or a Content-Type.
 assert.equal(checkBrandingImage('light',png(120,40)).contentType,'image/png');
 const random=Uint8Array.from({length:512},(_,index)=>(index*73+19)%251);
 assert.equal(keyOf(()=>checkBrandingImage('light',random)),'apiError.branding.format','random bytes');
 assert.equal(keyOf(()=>checkBrandingImage('light',svg('GIF89a'))),'apiError.branding.format','a GIF');
 assert.equal(keyOf(()=>checkBrandingImage('light',svg('<html><body></body></html>'))),'apiError.branding.format','HTML');
 assert.equal(keyOf(()=>checkBrandingImage('light',bytes([[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a],[0,0,0,1]]))),'apiError.branding.format','a PNG without IHDR');
 assert.equal(keyOf(()=>checkBrandingImage('light',bytes([[0xff,0xd8,0xff,0xe0,0,16],new Array(14).fill(0),[0xff,0xda,0,2]]))),'apiError.branding.format','a JPEG without SOF');
 assert.equal(keyOf(()=>checkBrandingImage('light',riff([webpChunk('VP8 ',[0,0,0,1,2,3,0,0,0,0])]))),'apiError.branding.format','a VP8 chunk without its start code');
 const stored=checkBrandingImage('light',png(120,40));
 assert.deepEqual([stored.size,stored.sha256],[png(120,40).length,createHash('sha256').update(png(120,40)).digest('hex')],'size and sha256 of the stored bytes');
});

test('animated PNG and WebP are refused',()=>{
 assert.equal(keyOf(()=>checkBrandingImage('light',png(120,40,{animated:true}))),'apiError.branding.animated','acTL before IDAT');
 assert.equal(keyOf(()=>checkBrandingImage('light',vp8x(120,40,{animated:true}))),'apiError.branding.animated','the VP8X animation flag');
 assert.equal(keyOf(()=>checkBrandingImage('light',vp8x(120,40,{anim:true}))),'apiError.branding.animated','an ANIM chunk');
});

test('logo limits: 16 to 4096 px, ratio 0.5 to 8, at most 2 MiB',()=>{
 for(const [width,height] of [[15,15],[4097,600],[900,100],[100,300]])assert.equal(keyOf(()=>checkBrandingImage('light',png(width,height))),'apiError.branding.logoDimensions',`${width}×${height}`);
 for(const [width,height] of [[16,16],[4096,512],[512,1024]])assert.equal(keyOf(()=>checkBrandingImage('dark',png(width,height))),null,`${width}×${height}`);
 const base=png(200,50).length,fill=2*1024*1024-base;
 assert.equal(png(200,50,{pad:fill}).length,2*1024*1024);
 assert.equal(keyOf(()=>checkBrandingImage('light',png(200,50,{pad:fill}))),null,'exactly 2 MiB');
 assert.equal(keyOf(()=>checkBrandingImage('light',png(200,50,{pad:fill+1}))),'apiError.branding.logoTooLarge','2 MiB + 1');
 // SVG: only the ratio counts, from the viewBox.
 assert.equal(keyOf(()=>checkBrandingImage('light',svg('<svg viewBox="0 0 9 1"><rect width="9" height="1"/></svg>'))),'apiError.branding.logoDimensions','an SVG of 9:1');
 assert.equal(keyOf(()=>checkBrandingImage('light',svg('<svg viewBox="0 0 8000 1000"><rect width="9" height="1"/></svg>'))),null,'an SVG of 8:1 has no pixel limit');
});

test('icon limits: square, 32 to 1024 px, at most 256 KiB',()=>{
 for(const side of [32,1024])assert.equal(keyOf(()=>checkBrandingImage('icon',png(side,side))),null,`${side} px`);
 for(const [width,height] of [[31,31],[1025,1025],[64,32]])assert.equal(keyOf(()=>checkBrandingImage('icon',png(width,height))),'apiError.branding.iconDimensions',`${width}×${height}`);
 const fill=256*1024-png(64,64).length;
 assert.equal(keyOf(()=>checkBrandingImage('icon',png(64,64,{pad:fill}))),null,'exactly 256 KiB');
 assert.equal(keyOf(()=>checkBrandingImage('icon',png(64,64,{pad:fill+1}))),'apiError.branding.iconTooLarge','256 KiB + 1');
 assert.equal(keyOf(()=>checkBrandingImage('icon',svg('<svg viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>'))),null,'a square SVG of any size');
 assert.equal(keyOf(()=>checkBrandingImage('icon',svg('<svg viewBox="0 0 24 20"><path d="M0 0h24v20z"/></svg>'))),'apiError.branding.iconDimensions','a non-square SVG');
});

const clean=text=>cleanSvg(text).svg;
// The output without the namespace declarations that the cleaner writes on the root.
const body=out=>out.replace(/ xmlns(?::xlink)?="[^"]*"/g,'');
test('cleanSvg removes disallowed elements with their subtree',()=>{
 const out=clean(`<svg viewBox="0 0 10 10"><script>alert(1)</script><foreignObject><div>x</div></foreignObject><image href="https://x/y.png"/><a href="https://x"><path d="M1 1"/></a>
  <animate attributeName="fill" to="red"/><set attributeName="x" to="1"/><unknown><rect width="1" height="1"/></unknown><g><circle r="1"/></g></svg>`);
 for(const part of ['script','alert','foreignObject','<div','<image','<a ','<a>','animate','<set','unknown','<rect'])assert.ok(!out.includes(part),`no ${part}: ${out}`);
 assert.ok(out.includes('<circle r="1"/>'),'allowed elements stay');
});

test('cleanSvg removes unsafe attributes and styles',()=>{
 const out=clean(`<svg viewBox="0 0 10 10" onload="alert(1)"><path d="M0 0" onclick="x()" onmouseover="y()"/><use href="https://evil.test/a.svg#x"/><use xlink:href="data:image/svg+xml;base64,AAA"/>
  <use href="java&#x09;script:alert(1)"/><rect width="1" height="1" fill="url(https://x)"/><g style="background:url(http://evil.test/x)"><circle r="1" style="@import 'x.css'"/></g><style>@import url(https://evil.test/a.css);</style><style>.a{fill:url(http://x)}</style></svg>`);
 for(const part of ['onload','onclick','onmouseover','https://','http://','data:','javascript','script','@import','url(h','<style'])assert.ok(!body(out).includes(part),`no ${part}: ${out}`);
});

test('cleanSvg keeps paths, gradients, local references, safe styles, viewBox and title',()=>{
 const source=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 120 40"><title>Contoso</title><defs><linearGradient id="g"><stop offset="0" stop-color="#123456"/></linearGradient><symbol id="a"><path d="M0 0h10v10z"/></symbol></defs>
  <style>.c{fill:url(#g);stroke:#000}</style><use href="#a"/><use xlink:href="#a"/><rect class="c" width="10" height="10" fill="url(#g)"/></svg>`;
 const out=clean(source);
 for(const part of ['viewBox="0 0 120 40"','<title>Contoso</title>','<linearGradient id="g">','stop-color="#123456"','<path d="M0 0h10v10z"/>','<style>.c{fill:url(#g);stroke:#000}</style>','<use href="#a"/>','<use xlink:href="#a"/>','fill="url(#g)"','class="c"','xmlns="http://www.w3.org/2000/svg"','xmlns:xlink="http://www.w3.org/1999/xlink"'])assert.ok(out.includes(part),`keeps ${part}: ${out}`);
 assert.equal(clean(out),out,'cleaning the output again gives the same output');
 assert.deepEqual([cleanSvg(source).width,cleanSvg(source).height],[120,40]);
});

test('cleanSvg refuses DOCTYPE, ENTITY, malformed XML and a non-svg root',()=>{
 for(const [name,text] of [
  ['a DOCTYPE','<!DOCTYPE svg><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'],
  ['an ENTITY','<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 1 1"><text>&x;</text></svg>'],
  ['an unclosed tag','<svg viewBox="0 0 1 1"><g><path d="M0 0"/></svg>'],
  ['a mismatched tag','<svg viewBox="0 0 1 1"><g><path d="M0 0"/></text></svg>'],
  ['a duplicate attribute','<svg viewBox="0 0 1 1"><path d="M0 0" d="M1 1"/></svg>'],
  ['a bad attribute syntax','<svg viewBox="0 0 1 1"><path d=M0/></svg>'],
  ['an undefined entity','<svg viewBox="0 0 1 1"><text>&nbsp;</text></svg>'],
  ['a non-svg root','<html><svg viewBox="0 0 1 1"><path d="M0 0"/></svg></html>'],
  ['two roots','<svg viewBox="0 0 1 1"><path d="M0 0"/></svg><svg/>'],
 ])assert.equal(keyOf(()=>cleanSvg(text)),'apiError.branding.svgInvalid',name);
 assert.equal(keyOf(()=>cleanSvg(Uint8Array.from([0x3c,0x73,0x76,0x67,0x3e,0xff,0xfe,0x3c,0x2f,0x73,0x76,0x67,0x3e]))),'apiError.branding.svgInvalid','text that is not UTF-8');
 // The upload route reaches the cleaner for a DOCTYPE: the file is meant as SVG.
 assert.equal(keyOf(()=>checkBrandingImage('light',svg('<?xml version="1.0"?><!-- logo --><!DOCTYPE svg><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'))),'apiError.branding.svgInvalid');
});

test('an SVG with nothing to draw or without a size is refused',()=>{
 assert.equal(keyOf(()=>cleanSvg('<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>')),'apiError.branding.svgEmpty');
 assert.equal(keyOf(()=>cleanSvg('<svg><path d="M0 0"/></svg>')),'apiError.branding.svgSize');
 assert.equal(keyOf(()=>cleanSvg('<svg width="100%" height="50%"><path d="M0 0"/></svg>')),'apiError.branding.svgSize','percent sizes');
 assert.deepEqual((({width,height})=>[width,height])(cleanSvg('<svg width="100.2px" height="40"><path d="M0 0"/></svg>')),[101,40],'width and height in px, rounded up');
 assert.deepEqual((({width,height})=>[width,height])(cleanSvg('<svg viewBox="0,0,0.3,0.2"><path d="M0 0"/></svg>')),[1,1],'at least 1');
 // A BOM, an XML declaration and comments before the root are fine; the stored bytes are the cleaned ones.
 const stored=checkBrandingImage('light',svg('﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported -->\n<svg viewBox="0 0 120 40"><script>x</script><path d="M0 0"/></svg>'));
 const text=new TextDecoder().decode(stored.data);
 assert.equal(stored.contentType,'image/svg+xml');
 assert.ok(!text.includes('<script')&&text.startsWith('<svg'),text);
 assert.deepEqual([stored.size,stored.sha256],[stored.data.length,createHash('sha256').update(stored.data).digest('hex')],'size and hash of the cleaned bytes');
});

test('known XSS SVG payloads come out without script, handlers, javascript:, data:, external url( or foreignObject',()=>{
 const payloads=[
  '<svg viewBox="0 0 1 1" onload="alert(1)"><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><script type="text/javascript">alert(1)</script><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><script><![CDATA[alert(1)]]></script><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><a href="javascript:alert(1)"><path d="M0 0"/></a><path d="M1 1"/></svg>',
  '<svg viewBox="0 0 1 1"><a xlink:href="javascript:alert(1)"><text>x</text></a><rect width="1" height="1"/></svg>',
  '<svg viewBox="0 0 1 1"><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><animate attributeName="href" to="javascript:alert(1)"/><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><set attributeName="onmouseover" to="alert(1)"/><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><image href="data:image/svg+xml;base64,PHN2Zy8+"/><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><use href="data:image/svg+xml,&lt;svg onload=alert(1)&gt;"/><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><use href="https://evil.test/x.svg#a"/><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><path d="M0 0" style="fill:url(javascript:alert(1))"/></svg>',
  '<svg viewBox="0 0 1 1"><style>*{background:url("https://evil.test/leak")}</style><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><style>@import "https://evil.test/a.css";</style><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><style>.a{background:\\75rl(https://evil.test)}</style><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><path d="M0 0" fill="url(&#104;ttps://evil.test/#a)"/></svg>',
  '<svg viewBox="0 0 1 1"><g onfocusin="alert(1)" tabindex="1"><path d="M0 0"/></g></svg>',
  '<svg viewBox="0 0 1 1"><svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><g xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></g><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><?xml-stylesheet href="https://evil.test/a.css"?><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><path d="M0 0" filter="url(https://evil.test/f.svg#f)"/></svg>',
  '<svg viewBox="0 0 1 1"><text style="behavior:url(x.htc)">x</text><path d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1" xml:base="https://evil.test/"><use href="#a"/><path id="a" d="M0 0"/></svg>',
  '<svg viewBox="0 0 1 1"><handler xmlns:ev="http://www.w3.org/2001/xml-events" ev:event="load">alert(1)</handler><path d="M0 0"/></svg>',
 ];
 assert.ok(payloads.length>=15);
 for(const payload of payloads){
  const out=clean(payload),lower=body(out).toLowerCase();
  for(const bad of ['<script','javascript:','data:','foreignobject','https://evil','http://','xml:base','<handler','xhtml','@import','behavior'])assert.ok(!lower.includes(bad),`${payload} → ${out} has ${bad}`);
  assert.doesNotMatch(out,/\son\w+=/i,`${payload} → ${out} has a handler`);
  assert.doesNotMatch(out,/url\((?!#)/,`${payload} → ${out} has an external url(`);
  assert.equal(clean(out),out,`${payload}: idempotent`);
 }
});

test('the email logo URL: PNG or JPEG light logo on SITE_ORIGIN only',()=>{
 const hash='0123456789abcdef'.repeat(4);
 assert.equal(emailLogoUrl('https://portal.test/',{contentType:'image/png',sha256:hash}),'https://portal.test/api/branding/portal/light?v=0123456789abcdef');
 assert.equal(emailLogoUrl('https://portal.test',{contentType:'image/jpeg',sha256:hash}),'https://portal.test/api/branding/portal/light?v=0123456789abcdef');
 for(const type of ['image/svg+xml','image/webp'])assert.equal(emailLogoUrl('https://portal.test',{contentType:type,sha256:hash}),null,type);
 assert.equal(emailLogoUrl('',{contentType:'image/png',sha256:hash}),null,'without SITE_ORIGIN');
 assert.equal(emailLogoUrl('https://portal.test',null),null,'without a light logo');
});
