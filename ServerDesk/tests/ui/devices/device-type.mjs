// The device type (ui/devices/device/device-type-model.ts, ui/devices/device/device-type-mark.tsx): each rule of
// deviceType and its order (no snapshot, domain controller over a battery, server by domain role, by installation type
// and by OS name without security data, laptop with a battery, workstation), the icon and label maps, the DeviceTypeMark
// tile in English and German (role="img", aria-label and title, the pending look for an unknown type, the sizes), and
// that PlatformMark and the hand-drawn Windows logo are gone from ui/.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Laptop,Monitor,MonitorSmartphone,Network,Server} from 'lucide-react';
const h=React.createElement;
const {deviceType,deviceTypeIcons,deviceTypeLabels}=await import('../../../ui/devices/device/device-type-model.ts');
const {DeviceTypeMark}=await import('../../../ui/devices/device/device-type-mark.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

const base={os:'Microsoft Windows 11 Pro',osInfo:{editionId:'Professional',installationType:'Client',displayVersion:'24H2',ubr:1,productName:'Windows 11 Pro',currentBuild:'26100'}};
const security=domainRole=>({domainJoined:true,domainRole,rdpEnabled:false,firewall:[],defender:{available:true,enabled:true,signatureAt:'',realTimeProtection:true},lastBoot:''});
const battery=present=>({collectedAt:'',present,batteries:[]});
const device=snapshot=>({snapshot:snapshot===null?null:{...base,...snapshot}});

// ---- the rules, first match wins ----
check(deviceType({snapshot:null}),'unknown','no snapshot: unknown');
for(const role of [4,5])check(deviceType(device({security:security(role),battery:battery(true)})),'domain-controller',`domain role ${role} wins over a battery`);
for(const role of [2,3])check(deviceType(device({security:security(role),battery:battery(true)})),'server',`domain role ${role}: server, also with a battery`);
check(deviceType(device({osInfo:{...base.osInfo,installationType:'Server Core'}})),'server','no security: a Server installation type');
check(deviceType(device({osInfo:{...base.osInfo,installationType:'server'}})),'server','the installation type case-insensitive');
check(deviceType(device({os:'Microsoft Windows Server 2025 Datacenter',osInfo:undefined})),'server','no security: a server OS name');
check(deviceType(device({os:'Microsoft Windows Server 2022',security:security(1)})),'workstation','with security data the domain role decides, not the OS name');
check(deviceType(device({security:security(1),battery:battery(true)})),'laptop','a present battery: laptop');
check(deviceType(device({battery:battery(true)})),'laptop','a battery without security data');
check(deviceType(device({security:security(0),battery:battery(false)})),'workstation','present:false: workstation');
check(deviceType(device({security:security(0)})),'workstation','no battery data: workstation');
check(deviceType(device({osInfo:undefined})),'workstation','an older agent without osInfo and battery');

// ---- the maps ----
check(deviceTypeIcons,{server:Server,'domain-controller':Network,laptop:Laptop,workstation:Monitor,unknown:MonitorSmartphone},'the lucide glyphs');
check(deviceTypeLabels,{server:'deviceType.server','domain-controller':'deviceType.domainController',laptop:'deviceType.laptop',workstation:'deviceType.workstation',unknown:'deviceType.unknown'},'the label keys');
check(Object.values(deviceTypeLabels).map(key=>translate('en',key)),['Server','Domain controller','Laptop','Workstation','Device type not reported yet'],'English labels');
check(Object.values(deviceTypeLabels).map(key=>translate('de',key)),['Server','Domänencontroller','Laptop','Arbeitsplatzrechner','Gerätetyp noch nicht gemeldet'],'German labels');

// ---- DeviceTypeMark ----
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const laptop=render(h(DeviceTypeMark,{server:device({battery:battery(true)}),size:'sm'}));
ok(/^<span class="sdx-platform sdx-platform-sm" role="img" aria-label="Laptop" title="Laptop">/.test(laptop),'a tile with role img, the label as name and title');
const svg=laptop.match(/<svg[^>]*>/)[0];
ok(/lucide-laptop/.test(svg)&&/width="14"/.test(svg)&&/aria-hidden="true"/.test(svg),'the 14px glyph, hidden from screen readers');
const pending=render(h(DeviceTypeMark,{server:{snapshot:null},size:'lg'}),'de');
ok(/class="sdx-platform sdx-platform-lg pending" role="img" aria-label="Gerätetyp noch nicht gemeldet"/.test(pending),'unknown: the pending look, German label');
ok(/width="26"/.test(pending)&&/lucide-monitor-smartphone/.test(pending),'lg: the 26px MonitorSmartphone glyph');
const dc=render(h(DeviceTypeMark,{server:device({security:security(5)})}),'de');
ok(/class="sdx-platform sdx-platform-md" role="img" aria-label="Domänencontroller" title="Domänencontroller"/.test(dc)&&/width="18"/.test(dc)&&/lucide-network/.test(dc),'md by default: 18px, the Network glyph');

// ---- PlatformMark and the Windows logo are gone ----
const parts=await import('../../../ui/devices/device/device-parts.tsx');
ok(!('PlatformMark' in parts),'device-parts exports no PlatformMark');
const walk=dir=>readdirSync(dir).flatMap(name=>{const file=path.posix.join(dir,name);return statSync(file).isDirectory()?walk(file):/\.(ts|tsx)$/.test(file)?[file]:[];});
const windowsLogo='M2 3h9v9H2zm11 0h9v9h-9zM2 14h9v9H2zm11 0h9v9h-9z';
for(const file of walk('ui')){const text=readFileSync(file,'utf8');assert.ok(!text.includes('PlatformMark')&&!text.includes(windowsLogo),`${file} has no PlatformMark and no Windows logo`);}
checks++;
for(const [file,use] of [['ui/devices/fleet/fleet.tsx','<DeviceTypeMark server={server} size="sm"/>'],['ui/devices/device/device.tsx','icon={<DeviceTypeMark server={server} size="lg"/>}']])ok(readFileSync(file,'utf8').includes(use),`${file} uses DeviceTypeMark`);

console.log(`PASS device type (${checks} checks): the rules in order, the maps, DeviceTypeMark and no PlatformMark.`);
