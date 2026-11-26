// The shared loader resolves the extensionless imports of the helper (ui/base/access-capabilities).
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {i18nRequire} from '../../support/i18n-stubs.mjs';
const agentState=await import('../../../lib/agent-update-state.ts');
const updateModel=await import('../../../ui/devices/device/agent-update-model.ts');
const deviceState=await import('../../../ui/base/ui-device.ts');
const mod={exports:{}};
const code=ts.transpileModule(fs.readFileSync('ui/devices/fleet/fleet-agent-update-state.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
new Function('require','module','exports',code)(id=>i18nRequire(id)??(id==='@/lib/agent-update-state'?agentState:id==='@/ui/devices/device/agent-update-model'?updateModel:id==='@/ui/base/ui-device'?deviceState:(()=>{throw Error('Unexpected '+id);})()),mod,mod.exports);
const {compatibleDeviceRelease,fleetDeviceUpdate,groupFleetUpdates,fleetUpdateLimit}=mod.exports;
const {usableDeviceRelease,latestDeviceReleases}=agentState;

const now=Date.now(),sha='a'.repeat(64),viewer={id:'operator',permissions:[]};
function release(version,extra={}){return {id:`release-${version}`,version,active:true,sha256:sha,size:100,createdAt:now,signature:'signature',manifest:{version,sha256:sha,size:100,protocolVersion:3,minProtocolVersion:3,os:['Windows 11 Pro','Windows Server 2022'],arch:'x64',path:'/downloads/agent.zip',...(Number(version.split('.')[0])>=4?{layout:'single-exe',exe:{path:'/downloads/agent.exe',sha256:sha,size:200}}:{})},...extra};}
const device={id:'device-a',name:'HOST',management:1,lastSeen:now,permissions:['update'],snapshot:{agentVersion:'4.3.0',os:'Microsoft Windows 11 Pro',protocolVersion:3,mode:'Management',agentCapabilities:['agent-update','release-paths']}};
const current=release('4.3.0'),update=release('4.6.0'),retired=release('4.7.0',{active:false});let checks=0;
assert.equal(compatibleDeviceRelease(device,update),true);
assert.equal(compatibleDeviceRelease({...device,snapshot:{...device.snapshot,os:'Microsoft Windows Server 2022 Datacenter Evaluation'}},update),true);
assert.equal(compatibleDeviceRelease({...device,snapshot:{...device.snapshot,os:'Microsoft Windows 10 Pro'}},update),false);
assert.equal(compatibleDeviceRelease({...device,snapshot:{...device.snapshot,os:'Windows 11 ProfessionalFake'}},update),false);
assert.equal(compatibleDeviceRelease({...device,snapshot:{...device.snapshot,os:''}},update),false);
assert.equal(compatibleDeviceRelease(device,{...update,manifest:'invalid'}),false);checks+=6;
assert.equal(usableDeviceRelease(retired),false);assert.equal(latestDeviceReleases('4.3.0',[current,update,retired],device.snapshot.agentCapabilities).update.id,update.id);checks+=2;
const inspect=(server=device,user=viewer,releases=[current,update,retired],jobs=[],campaigns=[],receipt=null,demo=false)=>fleetDeviceUpdate(server,user,demo,releases,jobs,campaigns,receipt,now);
assert.equal(inspect().eligible,true);assert.equal(inspect().update.id,update.id);
assert.equal(inspect({...device,lastSeen:now-300000}).eligible,false);assert.match(inspect({...device,lastSeen:now-300000}).reason,/nicht online/);
assert.equal(inspect({...device,management:0}).eligible,false);assert.match(inspect({...device,management:0}).reason,/Nur-Lesen-Modus/);
assert.equal(inspect({...device,permissions:[]}).inspect,false);assert.equal(inspect({...device,permissions:[]}).update,null);
assert.equal(inspect({...device,permissions:['view']},{id:'reader'}).eligible,false);
assert.equal(inspect({...device,permissions:[]},{...viewer,permissions:['*']}).eligible,true);
assert.equal(inspect(device,viewer,[update],[],[],null,true).eligible,false);
assert.equal(inspect({...device,snapshot:{...device.snapshot,os:'Windows 10 Pro'}}).update,null);
assert.equal(inspect({...device,revoked:1}).eligible,false);checks+=13;
const job={id:'job-a',serverId:device.id,action:'agent-update',target:update.version,state:'pending',createdAt:now};
assert.equal(inspect(device,viewer,[update],[job]).eligible,false);assert.equal(inspect(device,viewer,[update],[job]).state.phase,'queued');
assert.equal(inspect(device,viewer,[update],[{...job,state:'succeeded'}]).state.phase,'waiting');
assert.equal(inspect(device,viewer,[update],[{...job,state:'succeeded'}]).eligible,false);
assert.equal(inspect(device,viewer,[update],[{...job,state:'failed'}]).eligible,true);
const confirmed=inspect({...device,snapshot:{...device.snapshot,agentVersion:update.version}},viewer,[update],[],[],{jobId:job.id,version:update.version,createdAt:now});assert.equal(confirmed.state.phase,'verified');assert.equal(confirmed.update,null);checks+=7;
const legacy=inspect({...device,snapshot:{...device.snapshot,agentVersion:'3.0.0'}},viewer,[release('3.1.1'),update]);assert.equal(legacy.update.version,'3.1.1');assert.equal(legacy.migration.version,update.version);checks+=2;
const target=(id,release)=>({serverId:id,serverName:id,installed:'4.3.0',release});const groups=groupFleetUpdates([target('a',update),target('b',release('3.1.1')),target('c',update)]);assert.equal(groups.length,2);assert.deepEqual(groups[0].targets.map(target=>target.serverId),['a','c']);assert.equal(fleetUpdateLimit,20);checks+=3;
// The fleet view offers a release only when the deploy can deliver it: the
// catalog has only the path form, so only agents that report release-paths.
const olderAgent={...device,snapshot:{...device.snapshot,agentCapabilities:['agent-update']}};
assert.equal(inspect(olderAgent,viewer,[update]).update,null,'not offered to an agent without release-paths');assert.equal(inspect(olderAgent,viewer,[update]).eligible,false);
const {path:zipPath,exe,...rest}=update.manifest,absolute={...update,manifest:{...rest,url:'https://serverdesk.test'+zipPath,exe:{...exe,url:'https://serverdesk.test'+exe.path,path:undefined}}};delete absolute.manifest.exe.path;
assert.equal(usableDeviceRelease(absolute),false,'an absolute-form release is never offered');assert.equal(inspect(device,viewer,[absolute]).update,null);checks+=4;
console.log(`PASS fleet Agent update rules (${checks} assertions): active signed catalog, Windows compatibility, newest supported generation, permissions/mode/connectivity, update progress and deterministic release batching.`);
