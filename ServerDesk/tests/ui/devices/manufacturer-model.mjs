// Manufacturer logos (ui/devices/hardware/manufacturer-model.ts, manufacturer-logos.ts, manufacturer-mark.tsx,
// docs/manufacturer-logos.md): each table row with real WMI strings, HPE before HP, the placeholders, the 'other'
// fallback with the trimmed name, no logo for Microsoft and Apple, every logo id with a vendored path and every path in
// use, the path syntax and size, the module header (version, CC0-1.0), simple-icons not in package.json, the docs table
// and trademark notice, the README pointer, deviceManufacturer (inventory first), and the ManufacturerMark render.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {repositoryRoot} from '../../support/paths.mjs';
const h=React.createElement;
const {manufacturerOf,manufacturerTable,deviceManufacturer,manufacturerLogoPath}=await import('../../../ui/devices/hardware/manufacturer-model.ts');
const {manufacturerLogos,simpleIconsVersion}=await import('../../../ui/devices/hardware/manufacturer-logos.ts');
const {ManufacturerMark}=await import('../../../ui/devices/hardware/manufacturer-mark.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');

// ---- the table with real WMI strings ----
for(const [raw,id,name,logo] of [
 ['Dell Inc.','dell','Dell',true],['HP','hp','HP',true],['Hewlett-Packard','hp','HP',true],['Hewlett Packard','hp','HP',true],
 ['Hewlett Packard Enterprise','hpe','HPE',false],['HPE','hpe','HPE',false],['LENOVO','lenovo','Lenovo',true],
 ['ASUSTeK COMPUTER INC.','asus','ASUS',true],['Acer','acer','Acer',true],['Micro-Star International Co., Ltd.','msi','MSI',true],['MSI','msi','MSI',true],
 ['FUJITSU CLIENT COMPUTING LIMITED','fujitsu','Fujitsu',true],['Supermicro','supermicro','Supermicro',true],['Super Micro Computer, Inc.','supermicro','Supermicro',true],
 ['Gigabyte Technology Co., Ltd.','gigabyte','GIGABYTE',false],['SAMSUNG ELECTRONICS CO., LTD.','samsung','Samsung',true],['TOSHIBA','toshiba','Toshiba',true],
 ['Intel Corporation','intel','Intel',true],['VMware, Inc.','vmware','VMware',true],['QEMU','qemu','QEMU',true],['innotek GmbH','virtualbox','VirtualBox',true],
 ['Cisco Systems Inc','cisco','Cisco',true],['HUAWEI','huawei','Huawei',true],['Panasonic Corporation','panasonic','Panasonic',true],['Google','google','Google',true],
 ['Microsoft Corporation','microsoft','Microsoft',false],['Apple Inc.','apple','Apple',false],['Dynabook Inc.','dynabook','Dynabook',false],
 ['MEDION','medion','Medion',false],['WORTMANN AG','wortmann','Wortmann',false],['Xen','xen','Xen',false],['Amazon EC2','amazon','Amazon EC2',false],
])check(manufacturerOf(raw),{id,name,logo},raw);
check(manufacturerOf('  Hewlett Packard Enterprise  ')?.id,'hpe','HPE is not matched as HP');
check(manufacturerOf('HPE Synergy')?.id,'hpe','HPE first, also with more words');
check(manufacturerOf('HPX Labs'),{id:'other',name:'HPX Labs',logo:false},'^hp\\b does not match HPX');
check(manufacturerOf('Acerbic Systems'),{id:'other',name:'Acerbic Systems',logo:false},'^acer\\b does not match Acerbic');
for(const raw of ['','   ',null,undefined,'System manufacturer','System Manufacturer','To be filled by O.E.M.','Default string','O.E.M.','OEM','Not Applicable','Unknown','UNKNOWN',' oem '])check(manufacturerOf(raw),null,`placeholder ${JSON.stringify(raw)}`);
check(manufacturerOf('  Contoso Hardware GmbH '),{id:'other',name:'Contoso Hardware GmbH',logo:false},'an unknown value: other with the trimmed name');
check(['microsoft','apple'].map(id=>manufacturerTable.find(entry=>entry.id===id).slug),[null,null],'Microsoft and Apple never get a logo');

// ---- the vendored logo data ----
const withLogo=manufacturerTable.filter(entry=>entry.slug).map(entry=>entry.id);
check(manufacturerLogos.map(logo=>logo.id).sort(),[...withLogo].sort(),'every logo id has an entry and every entry is used');
for(const logo of manufacturerLogos){
 check(logo.slug,manufacturerTable.find(entry=>entry.id===logo.id).slug,`${logo.id}: the slug of the table`);
 ok(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/.test(logo.path),`${logo.id}: plain SVG path data`);
 ok(logo.path.length<=8192,`${logo.id}: at most 8 KiB`);
 check(manufacturerLogoPath(logo.id),logo.path,`${logo.id}: the path by id`);
}
check(manufacturerTable.filter(entry=>!entry.slug).map(entry=>entry.id),['hpe','gigabyte','microsoft','apple','dynabook','medion','wortmann','xen','amazon'],'the manufacturers without a logo');
const logosSource=read('ui/devices/hardware/manufacturer-logos.ts'),header=logosSource.split('\n').filter(line=>line.startsWith('//')).join('\n');
ok(header.includes('simple-icons@16.38.1')&&simpleIconsVersion==='16.38.1','the header names the package and the exact version');
ok(header.includes('CC0-1.0')&&/trademarks of their owners/.test(header)&&/currentColor/.test(header),'the header names the license, the trademark notice and the monochrome rule');
ok(!/#[0-9a-f]{3,8}\b|hex:/i.test(logosSource),'no brand color in the vendored data');
const pkg=JSON.parse(read('package.json'));
ok(![pkg.dependencies,pkg.devDependencies,pkg.optionalDependencies,pkg.peerDependencies].some(list=>list&&'simple-icons' in list),'simple-icons is no dependency');

// ---- the docs and the README ----
const docs=read('docs/manufacturer-logos.md');
const rows=[...docs.matchAll(/^\| `([a-z]+)` \| ([^|]+?) \| (?:`([a-z]+)`|none) \|$/gm)].map(match=>[match[1],match[2],match[3]??null]);
check(rows,manufacturerTable.map(entry=>[entry.id,entry.name,entry.slug]),'the docs list exactly the ids of the table with their names and slugs');
ok(docs.includes('The logos are trademarks of their owners. Nodiverna shows them only to identify the manufacturer that a device reports. This use does not mean that an owner endorses or is affiliated with Nodiverna.'),'the trademark notice');
ok(docs.includes('`16.38.1`')&&docs.includes('CC0-1.0')&&docs.includes('https://simpleicons.org'),'source, version and license');
const readme=read(repositoryRoot+'/README.md'),license=readme.slice(readme.indexOf('## License'));
ok(/\]\(ServerDesk\/docs\/manufacturer-logos\.md\)/.test(license.slice(0,license.indexOf('\n## ',4)>0?license.indexOf('\n## ',4):undefined)),'the README License section links the file');

// ---- deviceManufacturer: the hardware inventory first, else the snapshot ----
const snapshot=(extra={})=>({snapshot:{manufacturer:'LENOVO',model:'20XW',...extra}});
check(deviceManufacturer(snapshot()),{manufacturer:{id:'lenovo',name:'Lenovo',logo:true},raw:'LENOVO',model:'20XW'},'the snapshot values');
check(deviceManufacturer(snapshot({hardware:{collectedAt:'',intervalSeconds:0,complete:true,system:{manufacturer:'Dell Inc.',model:'PowerEdge R750',systemType:null,uuid:null}}})),{manufacturer:{id:'dell',name:'Dell',logo:true},raw:'Dell Inc.',model:'PowerEdge R750'},'the hardware inventory wins');
check(deviceManufacturer(snapshot({hardware:{collectedAt:'',intervalSeconds:0,complete:true,system:{manufacturer:null,model:'',systemType:null,uuid:null}}})).raw,'LENOVO','an empty inventory value falls back to the snapshot');
check(deviceManufacturer({snapshot:null}),{manufacturer:null,raw:'',model:''},'no snapshot');

// ---- ManufacturerMark ----
const render=element=>renderToStaticMarkup(h(LocaleProvider,{locale:'en'},element));
const dell=render(h(ManufacturerMark,{manufacturer:manufacturerOf('Dell Inc.'),size:'sm'}));
ok(/^<span class="sdx-manufacturer sdx-manufacturer-sm"><svg class="sdx-manufacturer-logo" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17\.963/.test(dell),'an inline 16px svg in currentColor, hidden from screen readers');
ok(dell.endsWith('<span class="sdx-manufacturer-name">Dell</span></span>'),'then the name as text');
ok(/width="20"/.test(render(h(ManufacturerMark,{manufacturer:manufacturerOf('HP')}))),'md: 20px');
const microsoft=render(h(ManufacturerMark,{manufacturer:manufacturerOf('Microsoft Corporation'),size:'md'}));
ok(/class="lucide lucide-factory sdx-manufacturer-fallback"[^>]*aria-hidden="true"/.test(microsoft)&&microsoft.includes('>Microsoft</span>')&&!microsoft.includes('viewBox="0 0 24 24" fill="currentColor"'),'without a logo: the Factory glyph and the name');
check(render(h(ManufacturerMark,{manufacturer:null})),'—','null: EMPTY_VALUE');
check(render(h(ManufacturerMark,{manufacturer:null,fallback:'Not reported'})),'Not reported','null with a fallback text');
const css=read('ui/devices/hardware/manufacturer-mark.css');
ok(/\.sdx-manufacturer-logo \{[^}]*color: var\(--sd-ink\)/.test(css)&&/\.sdx-manufacturer-fallback \{[^}]*color: var\(--sd-muted\)/.test(css),'the logo in --sd-ink, the fallback glyph in --sd-muted');

console.log(`PASS manufacturer logos (${checks} checks): the table, the placeholders, the vendored data, the docs and ManufacturerMark.`);
