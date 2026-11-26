// Agent update eligibility of a device (lib/agent-update-state.ts), also for dev builds X.Y.Z-dev.<sha7>.
// The shared loader resolves the extensionless imports of the helper (ui/base/access-capabilities).
import '../../support/register.mjs';
import '../../support/german-default.mjs';
import assert from 'node:assert/strict';
const {compareAgentVersions,latestDeviceReleases,deviceUpdateState,usableDeviceRelease,deliverableDeviceRelease}=await import('../../../lib/agent-update-state.ts');
const {deviceUpdateBlockReason,inspectDeviceUpdates}=await import('../../../ui/devices/device/agent-update-model.ts');
const hash='a'.repeat(64),now=Date.now();let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
function release(version,extra={}){const native=Number(version.split('.')[0])>=4,manifest={version,protocolVersion:3,minProtocolVersion:3,arch:'x64',os:['Windows 11 Pro'],path:'/downloads/agent.zip',sha256:hash,size:100,...(native?{layout:'single-exe',exe:{path:'/downloads/agent.exe',sha256:hash,size:200}}:{})};return {id:'release-'+version,version,signature:'test-signature',sha256:hash,size:100,createdAt:now,manifest,...extra};}
assert.equal(compareAgentVersions('4.10.0','4.9.9'),1);assert.equal(compareAgentVersions('4.4.0','4.4.0'),0);assert.equal(compareAgentVersions('4.3.99','4.4.0'),-1);assert.equal(compareAgentVersions('broken','4.4.0'),null);checks+=4;
const pathsAgent=['agent-update','release-paths'],olderAgent=['agent-update'];
const releases=[release('4.9.0'),release('4.10.0'),release('4.8.0',{createdAt:now+10000}),release('9.0.0',{signature:''}),release('8.0.0',{manifest:'invalid'})];
assert.equal(latestDeviceReleases('4.4.0',releases,pathsAgent).update.version,'4.10.0');assert.equal(latestDeviceReleases('4.10.0',releases,pathsAgent).update,null);assert.equal(latestDeviceReleases('4.11.0',releases,pathsAgent).update,null);assert.equal(latestDeviceReleases(undefined,releases,pathsAgent).update,null);checks+=4;
const legacy=latestDeviceReleases('3.0.0',[release('3.1.1'),release('4.4.0')],pathsAgent);assert.equal(legacy.update.version,'3.1.1');assert.equal(legacy.migration.version,'4.4.0');assert.equal(latestDeviceReleases('3.1.1',[release('4.4.0')],pathsAgent).update,null);checks+=3;
const server={id:'device',management:1,snapshot:{agentVersion:'4.3.0',mode:'Management',protocolVersion:3,agentCapabilities:['agent-update']},permissions:['update']},viewer={id:'user',permissions:[]};
assert.equal(deviceUpdateBlockReason(server,viewer,true),'');assert.match(deviceUpdateBlockReason(server,viewer,false),/nicht online/);assert.match(deviceUpdateBlockReason({...server,management:0},viewer,true),/Nur-Lesen-Modus/);assert.match(deviceUpdateBlockReason({...server,snapshot:{...server.snapshot,agentCapabilities:[]}},viewer,true),/nicht über das Portal aktualisiert/);assert.equal(inspectDeviceUpdates({...server,permissions:['view']},{id:'reader'}),false);assert.equal(inspectDeviceUpdates({...server,permissions:[]},{id:'owner',permissions:['*']}),true);assert.equal(inspectDeviceUpdates({...server,permissions:[]},viewer),false);checks+=6;
const job={id:'job',serverId:server.id,action:'agent-update',target:'4.4.0',state:'pending',createdAt:now,notBefore:now+10000};
assert.equal(deviceUpdateState(server,[job],[],null,now).phase,'scheduled');assert.equal(deviceUpdateState(server,[{...job,notBefore:now}],[],null,now).phase,'queued');assert.equal(deviceUpdateState(server,[{...job,state:'running'}],[],null,now).phase,'installing');assert.equal(deviceUpdateState(server,[{...job,state:'succeeded'}],[],null,now).phase,'waiting');assert.equal(deviceUpdateState(server,[{...job,state:'failed'}],[],null,now).phase,'failed');checks+=5;
const receipt={jobId:'job',version:'4.4.0',createdAt:now};assert.equal(deviceUpdateState(server,[],[],receipt,now).phase,'queued');assert.equal(deviceUpdateState({...server,snapshot:{...server.snapshot,agentVersion:'4.4.0'}},[],[],receipt,now).phase,'verified');assert.equal(deviceUpdateState(server,[{...job,state:'pending'}],[{id:'job',serverId:server.id,version:'4.4.0',state:'succeeded',createdAt:now}],receipt,now).phase,'waiting','new completed campaign is not reverted by stale pending job');checks+=3;
// Path form (4.12.0): usable with valid paths; offered to a device only when it
// lists release-paths. The absolute form is never usable.
function pathRelease(version,extra={},path=name=>'/downloads/'+name){const manifest={version,protocolVersion:3,minProtocolVersion:3,arch:'x64',os:['Windows 11 Pro'],path:path('agent.zip'),sha256:hash,size:100,layout:'single-exe',exe:{path:path('agent.exe'),sha256:hash,size:200,parts:[{path:path('agent.exe.part1'),sha256:hash,size:200}]}};return {id:'path-'+version,version,signature:'test-signature',sha256:hash,size:100,createdAt:now,manifest:JSON.stringify(manifest),...extra};}
const absolute=release('4.12.0');{const manifest={...absolute.manifest,url:'https://serverdesk.test/downloads/agent.zip',exe:{url:'https://serverdesk.test/downloads/agent.exe',sha256:hash,size:200}};delete manifest.path;absolute.manifest=manifest;}
assert.equal(usableDeviceRelease(pathRelease('4.12.0')),true);assert.equal(usableDeviceRelease(release('4.12.0')),true);assert.equal(usableDeviceRelease(absolute),false,'the absolute form');checks+=3;
for(const bad of ['/downloads/../x','/downloads/a/b','/other/x','/downloads/x?y','/downloads/a\b']){assert.equal(usableDeviceRelease(pathRelease('4.12.0',{},name=>name==='agent.exe.part1'?bad:'/downloads/'+name)),false,bad);checks++;}
const mixed=pathRelease('4.12.0');{const manifest=JSON.parse(mixed.manifest);manifest.exe.url='https://serverdesk.test/downloads/agent.exe';delete manifest.exe.path;mixed.manifest=JSON.stringify(manifest);}assert.equal(usableDeviceRelease(mixed),false,'mixed forms');checks++;
const both=pathRelease('4.12.0');{const manifest=JSON.parse(both.manifest);manifest.url='https://serverdesk.test/downloads/agent.zip';both.manifest=JSON.stringify(manifest);}assert.equal(usableDeviceRelease(both),false,'both keys');checks++;
assert.equal(latestDeviceReleases('4.11.0',[pathRelease('4.12.0')],pathsAgent).update.version,'4.12.0');
assert.equal(latestDeviceReleases('4.11.0',[pathRelease('4.12.0')],olderAgent).update,null,'never offered when the deploy would refuse');
assert.equal(latestDeviceReleases('4.11.0',[pathRelease('4.12.0')]).update,null);
assert.equal(latestDeviceReleases('4.11.0',[pathRelease('4.12.0'),release('4.11.5')],olderAgent).update,null,'a device without release-paths is not updatable from the portal');
assert.equal(deliverableDeviceRelease(pathsAgent),true);assert.equal(deliverableDeviceRelease(olderAgent),false);assert.equal(deliverableDeviceRelease(undefined),false);checks+=7;
// The changes between the installed and the offered agent: catalog (any state) and bundled history.
{
 const {agentChangesBetween,agentChangelogHistoryOf}=await import('../../../lib/agent-update-state.ts');
 const notes=(features,fixes=[])=>({features,fixes});
 const target=release('4.16.0',{changelog:notes(['Signed 4.16.0'])});
 const history=[
  {version:'4.16.0',features:['History 4.16.0'],fixes:[]},{version:'4.15.0',features:['History 4.15.0'],fixes:[]},{version:'4.13.2',features:[],fixes:['History 4.13.2']},
  {version:'4.10.0',features:['History 4.10.0'],fixes:[]},{version:'4.9.0',features:[],fixes:['History 4.9.0']},{version:'4.8.0',features:['History 4.8.0'],fixes:[]},
 ];
 const catalog=[target,release('4.15.0',{changelog:notes(['Signed 4.15.0'],['Signed fix 4.15.0']),active:false}),release('4.14.0',{changelog:null}),release('4.13.2',{changelog:null}),release('4.17.0',{changelog:notes(['Later'])})];
 const changes=agentChangesBetween('4.8.0',target,catalog,history);
 assert.deepEqual(changes.map(change=>change.version),['4.16.0','4.15.0','4.14.0','4.13.2','4.10.0','4.9.0'],'installed excluded, target included, newest first, 4.10.0 before 4.9.0, nothing above the target');
 assert.deepEqual(changes[0],{version:'4.16.0',features:['Signed 4.16.0'],fixes:[],published:true},'the signed catalog changelog wins over the history');
 assert.deepEqual(changes[1],{version:'4.15.0',features:['Signed 4.15.0'],fixes:['Signed fix 4.15.0'],published:true},'a disabled release still gives its signed notes');
 assert.deepEqual(changes[2],{version:'4.14.0',features:[],fixes:[],published:false},'catalog without notes and no history');
 assert.deepEqual(changes[3],{version:'4.13.2',features:[],fixes:['History 4.13.2'],published:true},'catalog without notes, history fills in');
 checks+=5;
 // A target without notes anywhere still comes first, unpublished; versions no source knows are missing.
 const bare=release('4.20.0');
 assert.deepEqual(agentChangesBetween('4.15.0',bare,[bare],history),[{version:'4.20.0',features:[],fixes:[],published:false},{version:'4.16.0',features:['History 4.16.0'],fixes:[],published:true}]);
 assert.deepEqual(agentChangesBetween('4.16.0',target,catalog,history).map(change=>change.version),['4.16.0'],'one version only');
 checks+=2;
 // An invalid installed version gives only the target; a missing or broken history counts as none.
 for(const installed of [undefined,'','broken','4.8']){assert.deepEqual(agentChangesBetween(installed,target,catalog,history).map(change=>change.version),['4.16.0'],String(installed));checks++;}
 for(const value of [undefined,null,{},'4.15.0',[null,{version:'4.15'},{version:'4.15.0',features:'x',fixes:[]},{version:'4.15.0',features:[1],fixes:[]}]]){assert.deepEqual(agentChangelogHistoryOf(value),[]);assert.deepEqual(agentChangesBetween('4.8.0',target,[target],value).map(change=>change.version),['4.16.0']);checks+=2;}
}
// Dev builds (X.Y.Z-dev.<sha7>): offered only with devBuilds, by rank, and for the same base by the catalog time.
{
 const at=(version,createdAt,extra={})=>pathRelease(version,{id:'id-'+version,createdAt,...extra});
 const release494=at('4.9.4',now-5000),dev495=at('4.9.5-dev.abc1234',now-3000),dev495b=at('4.9.5-dev.bbbbbbb',now-1000),release495=at('4.9.5',now);
 check(compareAgentVersions('4.9.5','4.9.5-dev.abc1234'),1,'a release ranks above a dev build of its base');
 check(compareAgentVersions('4.9.5-dev.aaaaaaa','4.9.5-dev.bbbbbbb'),0,'two dev builds of a base have equal rank');
 check(compareAgentVersions('4.9.5-dev.ABCDEFG','4.9.4'),null,'a malformed suffix is no version');
 check(latestDeviceReleases('4.9.4',[release494,dev495],pathsAgent).update,null,'without devBuilds no dev build is offered');
 check(latestDeviceReleases('4.9.4',[release494,dev495],pathsAgent,{devBuilds:false}).update,null,'devBuilds false: none');
 check(latestDeviceReleases('4.9.4',[release494,dev495],pathsAgent,{devBuilds:true}).update.version,'4.9.5-dev.abc1234','devBuilds true: a dev build above the installed rank');
 check(latestDeviceReleases('4.9.4',[release494,dev495,dev495b],pathsAgent,{devBuilds:true}).update.version,'4.9.5-dev.bbbbbbb','the newer of two dev builds of a base');
 check(latestDeviceReleases('4.9.4',[release494,dev495,release495],pathsAgent,{devBuilds:true}).update.version,'4.9.5','the release of the base ranks above its dev build');
 check(latestDeviceReleases('4.9.5',[dev495,release495],pathsAgent,{devBuilds:true}).update,null,'no dev build below the installed release');
 check(latestDeviceReleases('4.9.5-dev.abc1234',[dev495,dev495b],pathsAgent,{devBuilds:true}).update.version,'4.9.5-dev.bbbbbbb','same base: a newer catalog entry than the installed one');
 check(latestDeviceReleases('4.9.5-dev.bbbbbbb',[dev495,dev495b],pathsAgent,{devBuilds:true}).update,null,'same base: an older catalog entry is not newer');
 check(latestDeviceReleases('4.9.5-dev.ccccccc',[dev495],pathsAgent,{devBuilds:true}).update.version,'4.9.5-dev.abc1234','same base without a catalog entry of the installed version');
 check(latestDeviceReleases('4.9.5-dev.ccccccc',[dev495],pathsAgent,{devBuilds:false}).update,null,'never while devBuilds is off');
 check(latestDeviceReleases('4.9.5-dev.abc1234',[dev495,release495],pathsAgent).update.version,'4.9.5','a dev agent is offered the release of its base without devBuilds');
 check(usableDeviceRelease(at('4.9.5-dev.abc123',now)),false,'a malformed dev version is not usable');
 // The receipt: verified only when the installed version is the receipt version or ranks above it.
 const dev={...server,snapshot:{...server.snapshot,agentVersion:'4.9.5-dev.bbbbbbb'}},devReceipt={jobId:'job',version:'4.9.5-dev.abc1234',createdAt:now};
 check(deviceUpdateState(dev,[],[],devReceipt,now).phase,'queued','another dev build of the same base does not verify the receipt');
 check(deviceUpdateState({...dev,snapshot:{...dev.snapshot,agentVersion:'4.9.5-dev.abc1234'}},[],[],devReceipt,now).phase,'verified','the receipt version');
 check(deviceUpdateState({...dev,snapshot:{...dev.snapshot,agentVersion:'4.9.5'}},[],[],devReceipt,now).phase,'verified','the release of the base ranks above the receipt');
 check(deviceUpdateState({...dev,snapshot:{...dev.snapshot,agentVersion:'4.9.4'}},[],[],{...devReceipt,version:'4.9.5'},now).phase,'queued','a lower rank does not verify');
}
console.log(`PASS device Agent update eligibility (${checks} assertions): numeric versions, newest valid release, no downgrade/default, legacy/native transition, rights/mode/connectivity/capability, scheduled/running/heartbeat-confirmed progress and the changes between installed and offered agent.`);
