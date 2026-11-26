// The checks of an uploaded branding image (docs/branding.md, "Formats and
// limits"). Pure: no database, no request. The format comes only from the
// bytes, never from a file name or a Content-Type header. Raster sizes come
// from the headers (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X); no pixel is
// decoded. SVG files go through cleanSvg, a strict XML tokenizer with an
// allowlist of elements and attributes, and only its output is stored.
import {createHash} from 'node:crypto';
import {HttpError} from '../errors/http-error';
import {brandingBackgroundPixels,brandingIconPixels,brandingLogoPixels,brandingLogoRatio,brandingTooLargeKey,brandingByteLimit,isBrandingBackgroundSlot,type BrandingContentType,type BrandingSlot} from '../branding';

export type BrandingImage={contentType:BrandingContentType;data:Uint8Array;size:number;width:number;height:number;sha256:string};
type Raster={contentType:Exclude<BrandingContentType,'image/svg+xml'>;width:number;height:number;animated:boolean};

const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const ascii=(bytes:Uint8Array,at:number,length:number)=>at+length<=bytes.length?String.fromCharCode(...bytes.subarray(at,at+length)):'';
const u16be=(bytes:Uint8Array,at:number)=>bytes[at]<<8|bytes[at+1];
const u32be=(bytes:Uint8Array,at:number)=>(bytes[at]*2**24)+(bytes[at+1]<<16|bytes[at+2]<<8|bytes[at+3]);
const u24le=(bytes:Uint8Array,at:number)=>bytes[at]|bytes[at+1]<<8|bytes[at+2]<<16;
const u32le=(bytes:Uint8Array,at:number)=>(bytes[at]|bytes[at+1]<<8|bytes[at+2]<<16)+bytes[at+3]*2**24;
const formatError=()=>new HttpError('apiError.branding.format');

const pngSignature=[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a];
const startsWith=(bytes:Uint8Array,prefix:readonly number[])=>bytes.length>=prefix.length&&prefix.every((value,index)=>bytes[index]===value);

/** PNG: the IHDR chunk first; acTL before the first IDAT marks an animated PNG (APNG). */
function png(bytes:Uint8Array):Raster{
 if(bytes.length<33||u32be(bytes,8)!==13||ascii(bytes,12,4)!=='IHDR')throw formatError();
 const width=u32be(bytes,16),height=u32be(bytes,20);
 if(!width||!height)throw formatError();
 let animated=false;
 for(let at=8;at+8<=bytes.length;){
  const length=u32be(bytes,at),type=ascii(bytes,at+4,4);
  if(type==='IDAT'||type==='IEND')break;
  if(type==='acTL'){animated=true;break;}
  at+=12+length;
 }
 return {contentType:'image/png',width,height,animated};
}

/** JPEG: the first SOF marker (C0–CF without DHT C4, JPG C8 and DAC CC) gives the size. */
function jpeg(bytes:Uint8Array):Raster{
 for(let at=2;at<bytes.length;){
  if(bytes[at]!==0xff)throw formatError();
  while(at<bytes.length&&bytes[at]===0xff)at++;
  if(at>=bytes.length)break;
  const marker=bytes[at++];
  // Markers without a length: TEM, RST0–RST7 and a second SOI.
  if(marker===0x01||marker>=0xd0&&marker<=0xd8)continue;
  // The image data or its end before any SOF: no size.
  if(marker===0xd9||marker===0xda)break;
  if(at+2>bytes.length)break;
  const length=u16be(bytes,at);
  if(length<2)break;
  if(marker>=0xc0&&marker<=0xcf&&marker!==0xc4&&marker!==0xc8&&marker!==0xcc){
   if(length<7||at+7>bytes.length)break;
   const height=u16be(bytes,at+3),width=u16be(bytes,at+5);
   if(!width||!height)break;
   return {contentType:'image/jpeg',width,height,animated:false};
  }
  at+=length;
 }
 throw formatError();
}

/** WebP: RIFF….WEBP with a VP8, VP8L or VP8X chunk; the VP8X animation flag or an ANIM chunk marks an animated WebP. */
function webp(bytes:Uint8Array):Raster{
 const kind=ascii(bytes,12,4),data=20;
 let width=0,height=0,animated=false;
 if(kind==='VP8 '){
  // Frame tag (3 bytes), start code 9D 01 2A, then 14-bit width and height.
  if(bytes.length<data+10||bytes[data+3]!==0x9d||bytes[data+4]!==0x01||bytes[data+5]!==0x2a)throw formatError();
  width=(bytes[data+6]|bytes[data+7]<<8)&0x3fff;height=(bytes[data+8]|bytes[data+9]<<8)&0x3fff;
 }else if(kind==='VP8L'){
  // Signature 2F, then width-1 and height-1 in 14 bits each.
  if(bytes.length<data+5||bytes[data]!==0x2f)throw formatError();
  const bits=u32le(bytes,data+1);
  width=(bits&0x3fff)+1;height=(Math.floor(bits/0x4000)&0x3fff)+1;
 }else if(kind==='VP8X'){
  // Flags (bit 1: animation), 3 reserved bytes, then canvas width-1 and height-1 in 24 bits each.
  if(bytes.length<data+10)throw formatError();
  animated=(bytes[data]&0x02)!==0;
  width=u24le(bytes,data+4)+1;height=u24le(bytes,data+7)+1;
 }else throw formatError();
 for(let at=12;at+8<=bytes.length;){
  if(ascii(bytes,at,4)==='ANIM'){animated=true;break;}
  const size=u32le(bytes,at+4);
  at+=8+size+(size%2);
 }
 if(!width||!height)throw formatError();
 return {contentType:'image/webp',width,height,animated};
}

// ---- SVG -------------------------------------------------------------------

const svgNamespace='http://www.w3.org/2000/svg',xlinkNamespace='http://www.w3.org/1999/xlink';
const allowedElements=new Set(['svg','g','defs','title','desc','symbol','use','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','linearGradient','radialGradient','stop','clipPath','mask','pattern','style','filter','feGaussianBlur','feOffset','feBlend','feColorMatrix','feFlood','feComposite','feMerge','feMergeNode']);
/** Elements that draw: an SVG without one of them shows nothing. */
const drawableElements=new Set(['path','rect','circle','ellipse','line','polyline','polygon','text','use']);
/** href and xlink:href stay only here, and only as a local #id. */
const referenceElements=new Set(['use','linearGradient','radialGradient','pattern']);
/** Presentation attributes (SVG 1.1/2) and the geometry and filter attributes of the allowed elements. */
const presentationAttributes=['alignment-baseline','baseline-shift','clip-path','clip-rule','color','color-interpolation','color-interpolation-filters','direction','display','dominant-baseline','fill','fill-opacity','fill-rule','filter','flood-color','flood-opacity','font-family','font-size','font-size-adjust','font-stretch','font-style','font-variant','font-weight','isolation','letter-spacing','lighting-color','mask','mix-blend-mode','opacity','overflow','paint-order','shape-rendering','stop-color','stop-opacity','stroke','stroke-dasharray','stroke-dashoffset','stroke-linecap','stroke-linejoin','stroke-miterlimit','stroke-opacity','stroke-width','text-anchor','text-decoration','text-rendering','transform-origin','unicode-bidi','vector-effect','visibility','word-spacing','writing-mode'];
const geometryAttributes=['x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','fx','fy','fr','d','points','pathLength','dx','dy','rotate','textLength','lengthAdjust','offset','gradientUnits','gradientTransform','spreadMethod','patternUnits','patternContentUnits','patternTransform','clipPathUnits','maskUnits','maskContentUnits','filterUnits','primitiveUnits','stdDeviation','in','in2','result','mode','type','values','operator','k1','k2','k3','k4','media'];
const allowedAttributes=new Set([...presentationAttributes,...geometryAttributes,'id','class','style','viewBox','preserveAspectRatio','width','height','transform','xmlns','xmlns:xlink','xml:space','href','xlink:href']);

const invalidSvg=()=>new HttpError('apiError.branding.svgInvalid');
/** A name of letters, digits, '_', '-', '.' and at most one ':' prefix; ASCII only. */
const namePattern=/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
/** XML 1.0 characters: no C0 control except tab, LF and CR, no lone surrogate, no U+FFFE/U+FFFF. */
const forbiddenCharacter=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const namedEntities:Record<string,string>={lt:'<',gt:'>',amp:'&',quot:'"',apos:"'"};

/** The text with its five predefined entities and character references decoded; anything else is not well-formed. */
function decodeEntities(text:string):string{
 return text.replace(/&([^;&<]*);?/g,(whole,reference:string)=>{
  if(!whole.endsWith(';'))throw invalidSvg();
  if(Object.hasOwn(namedEntities,reference))return namedEntities[reference];
  const numeric=/^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(reference);
  if(!numeric)throw invalidSvg();
  const code=numeric[1]!==undefined?parseInt(numeric[1],16):Number(numeric[2]);
  if(code>0x10ffff||code===0||code<0x20&&code!==0x09&&code!==0x0a&&code!==0x0d||code>=0xd800&&code<=0xdfff||code===0xfffe||code===0xffff)throw invalidSvg();
  return String.fromCodePoint(code);
 });
}

type SvgNode={name:string;attributes:[string,string][];children:(SvgNode|string)[]};
const cdataName='#cdata';
const spaces=/\s*/y,tagName=/[^\s/>]+/y,attributePattern=/([^\s=/>]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y,piTarget=/[A-Za-z_][\w.:-]*/y;
const sticky=(pattern:RegExp,text:string,at:number)=>{pattern.lastIndex=at;return pattern.exec(text);};

/** Parses the whole document strictly into a tree. The root must be one svg element; DOCTYPE and ENTITY are refused. */
function parseSvg(text:string):SvgNode{
 if(forbiddenCharacter.test(text))throw invalidSvg();
 const source=text.replace(/\r\n?/g,'\n');
 if(/<!DOCTYPE|<!ENTITY/i.test(source))throw invalidSvg();
 const stack:SvgNode[]=[];let root:SvgNode|null=null,at=0;
 const parent=()=>stack[stack.length-1];
 const expect=(end:string,from:number)=>{const index=source.indexOf(end,from);if(index<0)throw invalidSvg();return index;};
 while(at<source.length){
  const open=source.indexOf('<',at);
  const text=source.slice(at,open<0?source.length:open);
  if(text){
   if(text.includes(']]>'))throw invalidSvg();
   // Outside the root only whitespace may stand.
   if(stack.length)parent().children.push(decodeEntities(text));
   else if(text.trim())throw invalidSvg();
  }
  if(open<0)break;
  if(source.startsWith('<!--',open)){const end=expect('-->',open+4);if(source.slice(open+4,end).includes('--'))throw invalidSvg();at=end+3;continue;}
  if(source.startsWith('<![CDATA[',open)){
   if(!stack.length)throw invalidSvg();
   const end=expect(']]>',open+9);parent().children.push({name:cdataName,attributes:[],children:[source.slice(open+9,end)]});at=end+3;continue;
  }
  if(source.startsWith('<?',open)){
   const end=expect('?>',open+2),target=sticky(piTarget,source,open+2)?.[0];
   if(!target)throw invalidSvg();
   // The XML declaration only before the root.
   if(target.toLowerCase()==='xml'&&(target!=='xml'||root||stack.length))throw invalidSvg();
   at=end+2;continue;
  }
  if(source.startsWith('<!',open))throw invalidSvg();
  if(source.startsWith('</',open)){
   const end=expect('>',open+2),name=source.slice(open+2,end).trimEnd();
   const node=stack.pop();
   if(!node||node.name!==name)throw invalidSvg();
   at=end+1;continue;
  }
  // A start tag: the name, then attributes separated by whitespace, then > or />.
  const name=sticky(tagName,source,open+1)?.[0]??'';
  if(!namePattern.test(name))throw invalidSvg();
  let index=open+1+name.length,closed=false;
  const attributes:[string,string][]=[],seen=new Set<string>();
  for(;;){
   const space=sticky(spaces,source,index)![0];index+=space.length;
   if(source.startsWith('/>',index)){closed=true;index+=2;break;}
   if(source[index]==='>'){index++;break;}
   if(index>=source.length||!space)throw invalidSvg();
   const attribute=sticky(attributePattern,source,index);
   if(!attribute||!namePattern.test(attribute[1])||seen.has(attribute[1]))throw invalidSvg();
   seen.add(attribute[1]);
   // Literal tabs and line ends in a value read as spaces (XML attribute value normalization).
   attributes.push([attribute[1],decodeEntities((attribute[2]??attribute[3]).replace(/[\t\n]/g,' '))]);
   index+=attribute[0].length;
  }
  const node:SvgNode={name,attributes,children:[]};
  if(stack.length)parent().children.push(node);
  else if(root)throw invalidSvg();
  else root=node;
  if(!closed){if(stack.length>=256)throw invalidSvg();stack.push(node);}
  at=index;
 }
 if(stack.length||!root||root.name!=='svg')throw invalidSvg();
 return root;
}

/** The value as the checks read it: lower case, without whitespace, control and invisible characters. */
const squeezed=(value:string)=>value.toLowerCase().replace(/[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]/g,'');
/** Every url( is a local url(#id). */
const localUrls=(plain:string)=>(plain.match(/url\(/g)?.length??0)===(plain.match(/url\((["']?)#[\w.:-]+\1\)/g)?.length??0);
const unsafeValue=(value:string)=>{const plain=squeezed(value);return plain.includes('javascript:')||plain.includes('vbscript:')||plain.includes('data:')||!localUrls(plain);};
/** style text and style attributes: no imports, expressions, external urls, scripts, markup or CSS escapes. */
const unsafeStyle=(value:string)=>{const plain=squeezed(value);return value.includes('\\')||value.includes('<')||unsafeValue(value)||['@import','expression(','-moz-binding','behavior:','image-set('].some(part=>plain.includes(part));};

/** The allowed attributes of an allowed element. The namespace declarations are left out; the serializer writes them on the root. */
function keptAttributes(node:SvgNode):[string,string][]{
 const kept:[string,string][]=[];
 for(const [name,value] of node.attributes){
  if(!allowedAttributes.has(name)||/^on/i.test(name)||name==='xmlns'||name==='xmlns:xlink')continue;
  if(name==='href'||name==='xlink:href'){if(referenceElements.has(node.name)&&/^#[A-Za-z_][\w.:-]*$/.test(value.trim()))kept.push([name,value.trim()]);continue;}
  if(name==='style'?unsafeStyle(value):unsafeValue(value))continue;
  kept.push([name,value]);
 }
 return kept;
}
const escapeText=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const escapeAttribute=(text:string)=>escapeText(text).replace(/"/g,'&quot;').replace(/\t/g,'&#9;').replace(/\n/g,'&#10;');

/** Writes the cleaned document; drawable tells whether a drawing element is left. */
function serialize(root:SvgNode):{svg:string;drawable:boolean;rootAttributes:[string,string][]}{
 let drawable=false,xlink=false;
 const rootAttributes=keptAttributes(root);
 const write=(node:SvgNode):string=>{
  if(!allowedElements.has(node.name))return '';
  const attributes=node===root?rootAttributes:keptAttributes(node);
  if(attributes.some(([name])=>name==='xlink:href'))xlink=true;
  let body='';
  if(node.name==='style'){
   // Only the text of a style element counts (text and CDATA); an unsafe one is dropped with its element.
   const css=node.children.map(child=>typeof child==='string'?child:child.name===cdataName?String(child.children[0]):'').join('');
   if(unsafeStyle(css))return '';
   body=escapeText(css);
  }else for(const child of node.children)body+=typeof child==='string'?escapeText(child):child.name===cdataName?'':write(child);
  if(drawableElements.has(node.name))drawable=true;
  // The root head is written last, so it knows whether an xlink:href is left.
  const namespaces=node===root?` xmlns="${svgNamespace}"${xlink?` xmlns:xlink="${xlinkNamespace}"`:''}`:'';
  const head='<'+node.name+namespaces+attributes.map(([name,value])=>` ${name}="${escapeAttribute(value)}"`).join('');
  return body?`${head}>${body}</${node.name}>`:`${head}/>`;
 };
 return {svg:write(root),drawable,rootAttributes};
}

const lengthNumber=(value:string|undefined)=>{const match=/^\s*([0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)\s*(?:px)?\s*$/i.exec(value??'');return match?Number(match[1]):NaN;};
/** The size of the SVG: the viewBox, else numeric width and height (unitless or px), rounded up, at least 1. */
function svgSize(attributes:[string,string][]):{width:number;height:number}{
 const value=(name:string)=>attributes.find(([key])=>key===name)?.[1];
 const box=value('viewBox')?.trim().split(/[\s,]+/).map(Number);
 let width=NaN,height=NaN;
 if(box&&box.length===4&&box.every(Number.isFinite)&&box[2]>0&&box[3]>0)[width,height]=[box[2],box[3]];
 else{width=lengthNumber(value('width'));height=lengthNumber(value('height'));}
 if(!(width>0)||!(height>0)||!Number.isFinite(width)||!Number.isFinite(height))throw new HttpError('apiError.branding.svgSize');
 return {width:Math.max(1,Math.ceil(width)),height:Math.max(1,Math.ceil(height))};
}

/**
 * Cleans an SVG file: parses it strictly and writes a new document with only
 * the allowed elements and attributes. Refuses DOCTYPE, ENTITY, XML that is
 * not well-formed, a root other than svg and text that is not UTF-8
 * (svgInvalid); an SVG without a drawable element left (svgEmpty) and one
 * without a usable size (svgSize). Cleaning the output again gives the same output.
 */
export function cleanSvg(input:string|Uint8Array):{svg:string;width:number;height:number}{
 let text:string;
 if(typeof input==='string')text=input;
 else{try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(input);}catch{throw invalidSvg();}}
 if(text.charCodeAt(0)===0xfeff)text=text.slice(1);
 const cleaned=serialize(parseSvg(text));
 if(!cleaned.drawable)throw new HttpError('apiError.branding.svgEmpty');
 return {svg:cleaned.svg,...svgSize(cleaned.rootAttributes)};
}

/** Whether the bytes are meant as SVG: text whose first element is svg, after an optional BOM, XML declaration, comments, processing instructions, a DOCTYPE and whitespace. */
function looksLikeSvg(bytes:Uint8Array):boolean{
 let text=new TextDecoder('utf-8',{fatal:false}).decode(bytes.subarray(0,Math.min(bytes.length,256*1024)));
 if(text.charCodeAt(0)===0xfeff)text=text.slice(1);
 for(;;){
  text=text.replace(/^\s+/,'');
  if(text.startsWith('<?')){const end=text.indexOf('?>');if(end<0)return false;text=text.slice(end+2);continue;}
  if(text.startsWith('<!--')){const end=text.indexOf('-->');if(end<0)return false;text=text.slice(end+3);continue;}
  if(/^<!DOCTYPE/i.test(text))return true;
  return /^<svg[\s/>]/.test(text);
 }
}

/** The format and size of a raster image from its header, or null when the bytes are no PNG, JPEG or WebP. */
export function rasterInfo(bytes:Uint8Array):Raster|null{
 if(startsWith(bytes,pngSignature))return png(bytes);
 if(startsWith(bytes,[0xff,0xd8,0xff]))return jpeg(bytes);
 if(ascii(bytes,0,4)==='RIFF'&&ascii(bytes,8,4)==='WEBP')return webp(bytes);
 return null;
}

function checkDimensions(slot:BrandingSlot,width:number,height:number,raster:boolean){
 // Backgrounds: any ratio (they cover the screen), 320 to 7680 px per side for raster images; SVG has no pixel limit.
 if(isBrandingBackgroundSlot(slot)){
  if(raster&&[width,height].some(side=>side<brandingBackgroundPixels.min||side>brandingBackgroundPixels.max))throw new HttpError('apiError.branding.backgroundDimensions');
  return;
 }
 if(slot==='icon'){
  if(width!==height||raster&&(width<brandingIconPixels.min||width>brandingIconPixels.max))throw new HttpError('apiError.branding.iconDimensions');
  return;
 }
 const ratio=width/height;
 if(raster&&[width,height].some(side=>side<brandingLogoPixels.min||side>brandingLogoPixels.max)||ratio<brandingLogoRatio.min||ratio>brandingLogoRatio.max)throw new HttpError('apiError.branding.logoDimensions');
}

/**
 * Checks an upload for a slot and returns what is stored: the format by
 * content, the file size against the slot limit (413), animation, and the
 * pixel size. SVG is cleaned; size and sha256 are those of the cleaned bytes,
 * while the size limit applies to the uploaded file.
 */
export function checkBrandingImage(slot:BrandingSlot,bytes:Uint8Array):BrandingImage{
 if(bytes.length>brandingByteLimit(slot))throw new HttpError(brandingTooLargeKey(slot));
 if(!bytes.length)throw formatError();
 const raster=rasterInfo(bytes);
 if(raster){
  if(raster.animated)throw new HttpError('apiError.branding.animated');
  checkDimensions(slot,raster.width,raster.height,true);
  return {contentType:raster.contentType,data:bytes,size:bytes.length,width:raster.width,height:raster.height,sha256:sha256(bytes)};
 }
 if(!looksLikeSvg(bytes))throw formatError();
 const cleaned=cleanSvg(bytes),data=new TextEncoder().encode(cleaned.svg);
 checkDimensions(slot,cleaned.width,cleaned.height,false);
 return {contentType:'image/svg+xml',data,size:data.length,width:cleaned.width,height:cleaned.height,sha256:sha256(data)};
}

/**
 * The logo of the notification emails: the portal light logo on SITE_ORIGIN,
 * only for PNG and JPEG (WebP and SVG do not show reliably in mail clients),
 * else null.
 */
export function emailLogoUrl(origin:string,light:{contentType:string;sha256:string}|null):string|null{
 if(!origin||!light||!['image/png','image/jpeg'].includes(light.contentType))return null;
 return `${origin.replace(/\/+$/,'')}/api/branding/portal/light?v=${light.sha256.slice(0,16)}`;
}
