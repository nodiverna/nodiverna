// Hardware and GPU on the kit rules: the stylesheets keep text at 12px or more, the 4px rhythm,
// token radii and no color literals or keyframes; the sources render no unit literals (sizes go
// through formatBytes/formatRate, other units through hardware.unit.*); the catalog keys the
// rebuild left without a user are gone.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {postcss} from '../../support/theme-colors.mjs';

let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
const spacing=new Set(['0','2px','4px','8px','12px','16px','24px','32px']);

// ---- Stylesheets ----
for(const file of ['ui/devices/hardware/device-hardware.css','ui/devices/hardware/device-gpu.css']){
 const css=read(file);
 ok(!/@keyframes/.test(css),file+' adds no @keyframes');
 ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(css),file+' has no hex or rgb(a) value');
 postcss.parse(css).walkDecls(decl=>{
  const where=`${file} ${decl.parent.selector??''} ${decl.prop}: ${decl.value}`;
  if(decl.prop==='font-size'){const px=decl.value.match(/^(\d+(?:\.\d+)?)px$/);ok(px&&Number(px[1])>=12,'text is 12px or larger: '+where);}
  if(/^(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left))?$/.test(decl.prop))for(const part of decl.value.split(/\s+/))ok(spacing.has(part)||part==='auto','4px rhythm: '+where);
  if(decl.prop==='border-radius')ok(/^var\(--sd-radius(?:-sm|-lg)?\)$|^99px$|^inherit$/.test(decl.value),'token radius: '+where);
  if(decl.prop==='box-shadow')ok(/^var\(--sd-shadow-(?:sm|md|lg)\)$|^none$/.test(decl.value),'token shadow: '+where);
 });
}
// The classic tiles, fact cards, empty texts and action rows are gone from code and CSS.
const sources={hardware:read('ui/devices/hardware/device-hardware.tsx'),gpu:read('ui/devices/hardware/device-gpu.tsx'),hardwareCss:read('ui/devices/hardware/device-hardware.css'),gpuCss:read('ui/devices/hardware/device-gpu.css'),driver:read('ui/devices/hardware/device-gpu-driver.tsx'),battery:read('ui/devices/hardware/disk-health.tsx')};
for(const [name,text] of Object.entries(sources))ok(!/dhw-metric|dhw-card|dhw-empty|dhw-actions|dhw-table-wrap|dhw-component|dgp-metric|dgp-card|dgp-notice|dgp-identity/.test(text),name+' has no classic hardware class');
ok(!/className="dhw-|className=\{[^}]*dhw-/.test(sources.battery),'the Battery block uses no dhw class');
for(const name of ['hardware','gpu'])ok(!/fontSize:10\b/.test(sources[name]),name+': no 10px chart ticks');

// ---- Unit literals in rendered strings ----
// String literals, template parts and JSX text of both views must not carry a unit: sizes and
// rates use formatBytes/formatRate, the other units come from the hardware.unit.* keys.
const unit=/(?:^|[\s\d])(?:GiB|MiB|KiB|GB|MB|ms|MHz|°C|W|Bit|bit)(?=$|[\s/.,)])/;
for(const file of ['ui/devices/hardware/device-hardware.tsx','ui/devices/hardware/device-gpu.tsx']){
 const source=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const found=[];
 const visit=node=>{
  if(ts.isImportDeclaration(node))return;
  const text=ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)?node.text:ts.isTemplateHead(node)||ts.isTemplateMiddle(node)||ts.isTemplateTail(node)?node.text:ts.isJsxText(node)?node.getText():null;
  if(text!==null&&(unit.test(text)||text.includes('°C')))found.push(text);
  ts.forEachChild(node,visit);
 };
 visit(source);
 assert.deepEqual(found,[],file+' renders no unit literal');checks++;
}

// ---- Removed catalog keys ----
const en=(await import('../../../lib/i18n/messages/en.ts')).default,de=(await import('../../../lib/i18n/messages/de.ts')).default;
for(const key of ['hardware.mib','hardware.usedGib','hardware.freeOf','hardware.usable','hardware.history.empty','hardware.firstReport','hardware.pending','hardware.title','hardware.manageDrive','hardware.noDrives','device.gpu.noPermission','device.gpu.noHistory','device.gpu.noValue'])ok(!(key in en)&&!(key in de),key+' is gone from both catalogs');
// Durations and temperatures moved to formatDuration and formatTemperature (lib/i18n/format.ts).
for(const key of ['hardware.unit.ms','hardware.unit.celsius'])ok(!(key in en)&&!(key in de),key+' is removed');
for(const key of ['hardware.unit.mhz','hardware.unit.watt','hardware.unit.bit'])ok(en[key]?.startsWith('{value} ')&&de[key]?.startsWith('{value} '),key+' formats a value with its unit');

console.log(`PASS hardware kit (${checks} checks): 12px text, 4px rhythm, token radii and shadows, no literals or keyframes in the hardware and GPU styles, no classic classes, no unit literals, removed catalog keys.`);
