#!/usr/bin/env node
/**
 * Measures the six bundled console backgrounds (public/backgrounds/<id>.svg, docs/branding.md):
 *
 *   node scripts/measure-backgrounds.mjs
 *   PLAYWRIGHT_CHANNEL=msedge node scripts/measure-backgrounds.mjs   (an installed browser instead)
 *
 * Renders each SVG at 1920 × 1080 in Playwright Chromium, reads the pixels and runs measureBackdrop (lib/backdrop.ts)
 * on them. Prints the `measure` values of brandingBackgrounds in lib/branding.ts in the source format; copy them there
 * after a bundled background changes. tests/repo/branding-backgrounds.mjs checks the stored values.
 */
import '../tests/support/register.mjs';
import {readFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';

const {brandingBackgrounds}=await import('../lib/branding.ts');
const {measureBackdrop}=await import('../lib/backdrop.ts');
const width=1920,height=1080;

// PLAYWRIGHT_CHANNEL (for example msedge or chrome) uses an installed browser when Playwright's own Chromium is missing.
const browser=await chromium.launch(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{});
try{
 const page=await browser.newPage();
 for(const {id} of brandingBackgrounds){
  const svg=await readFile(new URL(`../public/backgrounds/${id}.svg`,import.meta.url),'utf8');
  const pixels=await page.evaluate(async({svg,width,height})=>{
   const image=new Image();
   image.src=`data:image/svg+xml;base64,${btoa(svg)}`;
   await image.decode();
   const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
   const context=canvas.getContext('2d');
   context.drawImage(image,0,0,width,height);
   // Base64 keeps the 8 MB of pixels small on the way back to Node.
   const data=context.getImageData(0,0,width,height).data;let text='';
   for(let at=0;at<data.length;at+=32768)text+=String.fromCharCode(...data.subarray(at,at+32768));
   return btoa(text);
  },{svg,width,height});
  const measure=measureBackdrop(Buffer.from(pixels,'base64'),width,height);
  console.log(` {id:'${id}',…,measure:{light:{low:'${measure.light.low}',high:'${measure.light.high}'},dark:{low:'${measure.dark.low}',high:'${measure.dark.high}'}}},`);
 }
}finally{
 await browser.close();
}
