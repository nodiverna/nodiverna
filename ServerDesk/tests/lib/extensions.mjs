// Agent extensions (lib/extensions.ts, docs/server-roles.md): the detection
// catalog (roles and software, their kinds and devices) and the extension
// catalog, the detection from ServerManager names and the software inventory,
// the Windows Server-only rule and the 'any' devices rule on injected
// catalogs, the software matching with its SQL prefixes, the extension state,
// the fleet rows and counts, the open plugin job helpers of the console reload, and the
// detections of the sample devices. Pure, no server.
import '../support/register.mjs';
import assert from 'node:assert/strict';

const roles=await import('../../lib/extensions.ts');
const {normalizeSoftwareName,normalizeSoftwareVersion}=await import('../../lib/software-inventory.ts');
const {demoData}=await import('../../ui/shell/demo.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

// ---- Catalogs ----
const roleCatalog=roles.detectionCatalog.filter(entry=>entry.kind==='role'),softwareCatalog=roles.detectionCatalog.filter(entry=>entry.kind==='software');
check(roles.detectionCatalog.map(entry=>entry.id),[...roleCatalog,...softwareCatalog].map(entry=>entry.id),'one list: the 16 roles, then the 6 products');
check([roles.detectionCatalog.length,roleCatalog.length,softwareCatalog.length],[22,16,6],'22 entries: 16 roles and 6 products');
check(roles.detectionCatalog.every(entry=>entry.devices==='server'),true,'every entry counts only on Windows Server in this slice');
check(roles.detectionCatalog.some(entry=>Object.hasOwn(entry,'plugin')),false,'no entry names a plugin');
check(roleCatalog.every(entry=>Array.isArray(entry.names)&&!Object.hasOwn(entry,'prefixes')&&!Object.hasOwn(entry,'pattern')),true,'roles match names');
check(softwareCatalog.every(entry=>!Object.hasOwn(entry,'names')&&entry.prefixes.length>0&&entry.pattern instanceof RegExp),true,'products carry prefixes and a pattern');
check(roleCatalog.map(role=>role.id),['ad-ds','dhcp','dns','file-server','dfs','print','iis','hyper-v','rds','wsus','ad-cs','ad-fs','npas','remote-access','wds','failover-clustering'],'role catalog order');
check(roleCatalog.map(role=>role.icon),['Network','Router','Globe','FolderTree','FolderSync','Printer','AppWindow','Boxes','MonitorCog','RefreshCcwDot','BadgeCheck','KeyRound','ShieldCheck','Waypoints','HardDriveDownload','Layers'],'role icons');
check(roles.extensionCatalog,[{name:'dhcp',target:'dhcp'},{name:'dns',target:'dns'}],'the extension catalog: DHCP and DNS');
check(roles.extensionCatalog.every(entry=>roles.detectionIds.includes(entry.target)),true,'every extension target is a detection id');
check([roles.extensionForTarget('dhcp'),roles.extensionForTarget('dns'),roles.extensionForTarget('ad-ds'),roles.extensionForTarget('nope')],[{name:'dhcp',target:'dhcp'},{name:'dns',target:'dns'},undefined,undefined],'extensionForTarget');
check([roles.extensionByName('dns'),roles.extensionByName('ad-ds'),roles.extensionByName('')],[{name:'dns',target:'dns'},undefined,undefined],'extensionByName');
const camel=id=>id.replace(/-(\w)/g,(_match,letter)=>letter.toUpperCase());
check(roleCatalog.every(role=>role.label==='serverRoles.role.'+camel(role.id)),true,'role labels are message keys');
check(roleCatalog.find(role=>role.id==='rds').names,['Remote-Desktop-Services','RDS-RD-Server','RDS-Connection-Broker','RDS-Gateway','RDS-Licensing','RDS-Web-Access'],'RDS names');
check(roleCatalog.flatMap(role=>role.names).filter(name=>/^(FileAndStorage-Services|Storage-Services)$/i.test(name)),[],'the default storage roles are no catalog name');
check(softwareCatalog.map(entry=>entry.id),['sql-server','exchange','sharepoint','veeam-br','veeam-agent','entra-connect'],'software catalog order');
check(softwareCatalog.map(entry=>entry.icon),['Database','Mail','LayoutGrid','DatabaseBackup','ArchiveRestore','CloudCog'],'software icons');
check(softwareCatalog.every(entry=>entry.label==='serverRoles.software.'+camel(entry.id)),true,'software: message keys');
check(roles.detectionSoftwarePrefixes,softwareCatalog.flatMap(entry=>entry.prefixes),'the prefixes of every product');
check(roles.detectionSoftwarePrefixes.every(prefix=>prefix===prefix.toLowerCase()&&prefix.length>0),true,'prefixes are lower case');
check(roles.detectionIds,roles.detectionCatalog.map(entry=>entry.id),'22 ids in catalog order');
check([roles.detectionEntry('dns').kind,roles.detectionEntry('sql-server').kind,roles.detectionEntry('nope')],['role','software',undefined],'detectionEntry');
check([roles.detectionPosition('ad-ds'),roles.detectionPosition('sql-server'),roles.detectionPosition('nope')],[0,16,22],'detectionPosition: unknown ids last');

// ---- Software matching ----
const row=(name,version=null)=>({name,version,normalizedName:normalizeSoftwareName(name,version),normalizedVersion:normalizeSoftwareVersion(version)});
const positives={
 'sql-server':['Microsoft SQL Server 2022 (64-bit)','Microsoft SQL Server 2019','SQL Server 2019 Database Engine Services','Microsoft SQL Server 2008 R2','SQL Server 2025 Database Engine Services','Microsoft SQL Server 2014 (64-bit)'],
 exchange:['Microsoft Exchange Server 2019 Cumulative Update 14','Microsoft Exchange Server 2016 Cumulative Update 23','Microsoft Exchange Server Subscription Edition','Microsoft Exchange Server 2010'],
 sharepoint:['Microsoft SharePoint Server 2019','Microsoft SharePoint Server Subscription Edition','Microsoft SharePoint Server 2016'],
 'veeam-br':['Veeam Backup & Replication'],
 'veeam-agent':['Veeam Agent for Microsoft Windows'],
 'entra-connect':['Microsoft Entra Connect','Microsoft Entra Connect Sync','Microsoft Azure AD Connect'],
};
for(const [id,list] of Object.entries(positives)){
 const entry=softwareCatalog.find(item=>item.id===id);
 for(const name of list){
  check(roles.matchServerSoftware([row(name,'1.0')]).map(match=>match.id),[id],`${name} matches ${id}`);
  ok(entry.prefixes.some(prefix=>normalizeSoftwareName(name,'1.0').startsWith(prefix)),`${name} starts with a prefix of ${id}`);
 }
}
for(const name of ['Microsoft SQL Server Management Studio - 20.2','Microsoft SQL Server 2019 Setup (English)','SQL Server 2022 Common Files','Veeam Backup & Replication Console','Microsoft Exchange Server 2019 Language Pack','Microsoft SQL Server 2022 RsFx Driver','Veeam Agent for Linux','Microsoft Entra Connect Health agent for sync','Google Chrome'])
 check(roles.matchServerSoftware([row(name,'1.0')]),[],`not matched: ${name}`);
// The highest normalized version wins; rows without one lose; the raw version is kept.
const sql=roles.matchServerSoftware([row('Microsoft SQL Server 2019 (64-bit)',null),row('SQL Server 2019 Database Engine Services','15.0.4375.4'),row('SQL Server 2019 Database Engine Services','15.0.2000.5')]);
check(sql,[{id:'sql-server',version:'15.0.4375.4',names:['Microsoft SQL Server 2019 (64-bit)','SQL Server 2019 Database Engine Services']}],'highest version wins, names distinct and sorted');
check(roles.matchServerSoftware([row('Microsoft SQL Server 2019 (64-bit)',null)])[0].version,null,'null when no row has a version');
check(roles.matchServerSoftware([row('Veeam Agent for Microsoft Windows','6.1.10.2'),row('Veeam Agent for Microsoft Windows','6.1.9.99')])[0].version,'6.1.10.2','numeric compare per segment (10 > 9)');
check(roles.matchServerSoftware([row('Veeam Agent for Microsoft Windows','v6.2 build 7')])[0].version,'v6.2 build 7','the raw version of the best row');
const many=['2008','2012','2014','2016','2017','2019','2022'].map(year=>row(`Microsoft SQL Server ${year}`,'1.'+year));
const capped=roles.matchServerSoftware(many)[0];
check([capped.names.length,capped.names,capped.version],[5,['Microsoft SQL Server 2008','Microsoft SQL Server 2012','Microsoft SQL Server 2014','Microsoft SQL Server 2016','Microsoft SQL Server 2017'],'1.2022'],'at most 5 sorted names; the version still comes from all rows');
check(roles.matchServerSoftware([row('Veeam Agent for Microsoft Windows','6'),row('Microsoft SQL Server 2022 (64-bit)','16.0.1')]).map(match=>match.id),['sql-server','veeam-agent'],'catalog order, one entry per product');
check(roles.compareNormalizedVersions('15.0','15.0.0'),0,'missing segments count as 0');

// ---- Role detection ----
const feature=(name,displayName,installed=true,featureType='Role')=>({name,displayName,installed,featureType});
const server=(features,os='Microsoft Windows Server 2022 Datacenter',serverSoftware)=>({snapshot:{os,features},...(serverSoftware?{serverSoftware}:{})});
const ids=list=>list.map(entry=>entry.id);
check(ids(roles.detectTargets(server([feature('DNS','DNS-Server'),feature('DHCP','DHCP-Server'),feature('AD-Domain-Services','Active Directory-Domänendienste')]))),['ad-ds','dhcp','dns'],'three roles in catalog order');
check(roles.detectTargets(server([feature('FileAndStorage-Services','Datei- und Speicherdienste'),feature('Storage-Services','Speicherdienste','Role Service')])),[],'the default storage roles alone give nothing');
check(roles.detectTargets(server([feature('FS-FileServer','Dateiserver',true,'Role Service')])),[{id:'file-server',kind:'role',extension:null,version:null,sources:['Dateiserver']}],'FS-FileServer is a file server');
check(roles.detectTargets(server([feature('RDS-RD-Server','Remotedesktop-Sitzungshost',true,'Role Service')])),[{id:'rds',kind:'role',extension:null,version:null,sources:['Remotedesktop-Sitzungshost']}],'RDS through RDS-RD-Server only');
check(roles.detectTargets(server([feature('DNS','DNS-Server',false),feature('Hyper-V','Hyper-V',false)])),[],'not installed features are ignored');
check(ids(roles.detectTargets(server([feature('dns','DNS-Server'),feature('ad-domain-services','AD DS')]))),['ad-ds','dns'],'names match case-insensitively');
check(roles.detectTargets(server([feature('FS-DFS-Replication','DFS-Replikation',true,'Role Service'),feature('FS-DFS-Namespace','DFS-Namespaces',true,'Role Service')]))[0].sources,['DFS-Namespaces','DFS-Replikation'],'sources are display names in catalog order');
check(roles.detectTargets(server([feature('DHCP','DHCP-Server')]))[0],{id:'dhcp',kind:'role',extension:'dhcp',version:null,sources:['DHCP-Server']},'DHCP names its extension');
// Software from serverSoftware; unknown ids dropped; roles first.
const mixed=roles.detectTargets(server([feature('Web-Server','Webserver (IIS)')],'Microsoft Windows Server 2019 Standard',[{id:'veeam-agent',version:'6.1',names:['Veeam Agent for Microsoft Windows']},{id:'unknown',version:null,names:['X']},{id:'sql-server',version:'16.0.1',names:['Microsoft SQL Server 2022 (64-bit)']}]));
check(mixed,[{id:'iis',kind:'role',extension:null,version:null,sources:['Webserver (IIS)']},{id:'sql-server',kind:'software',extension:null,version:'16.0.1',sources:['Microsoft SQL Server 2022 (64-bit)']},{id:'veeam-agent',kind:'software',extension:null,version:'6.1',sources:['Veeam Agent for Microsoft Windows']}],'roles, then software in catalog order, unknown ids dropped');
// Windows Server only.
check(roles.detectTargets(server([feature('DNS','DNS-Server')],'Microsoft Windows 11 Pro',[{id:'veeam-agent',version:'6',names:['Veeam Agent for Microsoft Windows']}])),[],'Windows 11 with matching names and software gives nothing');
check(roles.detectTargets({snapshot:null,serverSoftware:[{id:'sql-server',version:null,names:['x']}]}),[],'no snapshot gives nothing');
check(roles.detectTargets({snapshot:{os:'windows server 2016 standard',features:undefined}}),[],'a server without features or software gives nothing');
// Device order: planned first inside the roles, the rest in catalog order.
check(ids(roles.deviceTargetOrder(roles.detectTargets(server([feature('AD-Domain-Services','AD DS'),feature('DNS','DNS'),feature('DHCP','DHCP'),feature('Web-Server','IIS')],undefined,[{id:'sql-server',version:null,names:['SQL']}])))),['dhcp','dns','ad-ds','iis','sql-server'],'planned roles first, products after the roles');

// ---- Fleet rows and counts ----
const device=(id,name,features,serverSoftware,os)=>({id,name,...server(features,os,serverSoftware)});
const fleet=[
 device('d3','SRV-10',[feature('DNS','DNS')]),
 device('d1','SRV-2',[feature('DNS','DNS'),feature('AD-Domain-Services','AD DS')]),
 device('d2','SRV-2',[feature('DNS','DNS')],[{id:'sql-server',version:'15',names:['SQL']}]),
 device('d4','PC-1',[feature('DNS','DNS')],[{id:'sql-server',version:'15',names:['SQL']}],'Microsoft Windows 11 Pro'),
];
const rows=roles.fleetTargetRows(fleet);
check(rows.map(item=>[item.entry.id,item.deviceName,item.deviceId]),[['ad-ds','SRV-2','d1'],['dns','SRV-2','d1'],['dns','SRV-2','d2'],['dns','SRV-10','d3'],['sql-server','SRV-2','d2']],'catalog position, then numeric device name, then id; clients never count');
check(rows[0].os,'Microsoft Windows Server 2022 Datacenter','a row carries the OS for the version column');
check([...roles.targetCounts(rows)],[['ad-ds',1],['dns',3],['sql-server',1]],'distinct devices per entry');
check(roles.targetCounts([...rows,rows[1]]).get('dns'),3,'a device counts once per entry');

// ---- Sample devices ----
const {servers}=demoData();
const detected=Object.fromEntries(servers.map(item=>[item.name,roles.detectTargets(item).map(entry=>[entry.id,entry.extension,entry.version])]));
check(detected['SRV-APP01'],[['iis',null,null]],'SRV-APP01: IIS');
check(detected['SRV-DC01'],[['ad-ds',null,null],['dhcp','dhcp',null],['dns','dns',null]],'SRV-DC01: AD DS, DHCP and DNS');
check(detected['SRV-SQL01'],[['sql-server',null,'16.0.4135.4']],'SRV-SQL01: SQL Server 2022 with its version');
const file=servers.find(item=>item.name==='SRV-FILE01');
check(file.serverSoftware,[{id:'veeam-agent',version:'6.1.2.134',names:['Veeam Agent for Microsoft Windows']}],'SRV-FILE01 carries Veeam Agent from its programs');
check([file.snapshot.os,detected['SRV-FILE01']],['Microsoft Windows 10 Enterprise',[]],'SRV-FILE01 reports Windows 10 (the OS support sample), so it shows no roles');
check(servers.find(item=>item.name==='SRV-SQL01').serverSoftware[0].names,['Microsoft SQL Server 2022 (64-bit)'],'the sample product names');
check(new Set(roles.fleetTargetRows(servers).map(item=>item.deviceName)).size,3,'the fleet tab lists the three sample Windows servers');

// ---- Same results as the former detectServerRoles (lib/server-roles.ts before the extension model) ----
// The former algorithm, kept here as the reference: Windows Server only, roles in catalog order from the installed
// features, then the products of serverSoftware in catalog order; plugin is the old name of extension.
const formerPlugins={dhcp:'dhcp',dns:'dns'};
function formerDetect(item){
 if(!/windows server/i.test(item.snapshot?.os??''))return [];
 const installed=new Map();
 for(const entry of item.snapshot?.features??[])if(entry.installed===true){const key=String(entry.name).toLowerCase();if(!installed.has(key))installed.set(key,entry.displayName||entry.name);}
 const found=[];
 for(const role of roleCatalog){
  const sources=[...new Set(role.names.flatMap(name=>{const shown=installed.get(name.toLowerCase());return shown===undefined?[]:[shown];}))];
  if(sources.length)found.push({id:role.id,kind:'role',plugin:formerPlugins[role.id]??null,version:null,sources});
 }
 const products=new Map(),position=id=>softwareCatalog.findIndex(entry=>entry.id===id);
 for(const match of item.serverSoftware??[])if(position(match.id)>=0&&!products.has(match.id))products.set(match.id,{id:match.id,kind:'software',plugin:null,version:match.version??null,sources:[...match.names]});
 return [...found,...[...products.values()].sort((a,b)=>position(a.id)-position(b.id))];
}
const asFormer=list=>list.map(({extension,...entry})=>({...entry,plugin:extension}));
const fixtures=[
 ...servers,...fleet,
 server([feature('DNS','DNS-Server'),feature('DHCP','DHCP-Server'),feature('AD-Domain-Services','Active Directory-Domänendienste')]),
 server([feature('FileAndStorage-Services','Datei- und Speicherdienste'),feature('Storage-Services','Speicherdienste','Role Service')]),
 server([feature('FS-DFS-Replication','DFS-Replikation',true,'Role Service'),feature('FS-DFS-Namespace','DFS-Namespaces',true,'Role Service')]),
 server([feature('dns','DNS-Server'),feature('ad-domain-services','AD DS'),feature('Hyper-V','Hyper-V',false)]),
 server([feature('Web-Server','Webserver (IIS)')],'Microsoft Windows Server 2019 Standard',[{id:'veeam-agent',version:'6.1',names:['Veeam Agent for Microsoft Windows']},{id:'unknown',version:null,names:['X']},{id:'sql-server',version:'16.0.1',names:['Microsoft SQL Server 2022 (64-bit)']},{id:'sql-server',version:'1',names:['second']}]),
 server([feature('DNS','DNS-Server')],'Microsoft Windows 11 Pro',[{id:'veeam-agent',version:'6',names:['Veeam Agent for Microsoft Windows']}]),
 {snapshot:null,serverSoftware:[{id:'sql-server',version:null,names:['x']}]},
 {snapshot:{os:'windows server 2016 standard',features:undefined}},
];
ok(servers.length===4&&formerDetect(servers.find(item=>item.name==='SRV-DC01')).length===3,'the reference sees the sample devices');
for(const [index,item] of fixtures.entries())check(asFormer(roles.detectTargets(item)),formerDetect(item),`fixture ${index} (${item.name??'inline'}): the same detection as before`);

// ---- Injected catalogs: devices 'any' and a feature entry ----
{
 const anyCatalog=[
  {id:'wsl',label:'serverRoles.role.hyperV',icon:'Boxes',kind:'feature',devices:'any',names:['Microsoft-Windows-Subsystem-Linux']},
  {id:'veeam-agent',label:'serverRoles.software.veeamAgent',icon:'ArchiveRestore',kind:'software',devices:'any',prefixes:['veeam agent for microsoft windows'],pattern:/^veeam agent for microsoft windows$/},
 ];
 const serverCatalog=anyCatalog.map(entry=>({...entry,devices:'server'}));
 const extensions=[{name:'wsl-tools',target:'wsl'}];
 const client=server([feature('Microsoft-Windows-Subsystem-Linux','Windows-Subsystem für Linux',true,'OptionalFeature')],'Microsoft Windows 11 Pro',[{id:'veeam-agent',version:'6.2',names:['Veeam Agent for Microsoft Windows']}]);
 const windowsServer={...client,snapshot:{...client.snapshot,os:'Microsoft Windows Server 2022 Standard'}};
 check(roles.detectTargets(client,anyCatalog,extensions),[
  {id:'wsl',kind:'feature',extension:'wsl-tools',version:null,sources:['Windows-Subsystem für Linux']},
  {id:'veeam-agent',kind:'software',extension:null,version:'6.2',sources:['Veeam Agent for Microsoft Windows']},
 ],"devices 'any': a feature and a product are detected on Windows 11, the feature with its injected extension");
 check(roles.detectTargets(client,serverCatalog,extensions),[],"devices 'server': the same entries give nothing on Windows 11");
 check(roles.detectTargets(windowsServer,serverCatalog,extensions).map(entry=>[entry.id,entry.kind,entry.extension]),[['wsl','feature','wsl-tools'],['veeam-agent','software',null]],"devices 'server': detected on Windows Server");
 check(roles.detectTargets(windowsServer,anyCatalog,extensions).length,2,"devices 'any': detected on Windows Server too");
 check(roles.detectTargets({...client,snapshot:null},anyCatalog,extensions),[],"devices 'any': a device without a snapshot gives nothing");
 check(roles.detectTargets(client,anyCatalog).map(entry=>entry.extension),[null,null],'without injected extensions the default extension catalog applies');
 check(roles.detectTargets({snapshot:{os:'Microsoft Windows 11 Pro',features:[feature('Microsoft-Windows-Subsystem-Linux','WSL',false)]}},anyCatalog,extensions),[],'a feature that is not installed is ignored');
 // Device order: role, feature, software; inside a kind the entries with an extension first.
 const entry=(id,kind,extension=null)=>({id,kind,extension,version:null,sources:[]});
 check(roles.deviceTargetOrder([entry('sql-server','software'),entry('wsl','feature'),entry('iis','role'),entry('hyper-v','feature','x'),entry('dns','role','dns')]).map(item=>item.id),['dns','iis','hyper-v','wsl','sql-server'],'kinds in the order role, feature, software, extensions first inside a kind');
}

// ---- Extension state of a detected target ----
{
 const release={id:'r1',name:'dhcp',target:'dhcp',version:'1.1.0',minAgentVersion:'4.16.0',capabilities:['dhcp-read'],changelog:{features:['x'],fixes:[]},createdAt:1};
 const withPlugins=plugins=>({snapshot:{plugins}});
 const ready={name:'dhcp',target:'dhcp',version:'1.0.0',capabilities:['dhcp-read'],state:'ready',networkBlocked:true};
 check(roles.extensionState({extension:'dhcp'},withPlugins([ready]),[release]),{state:'installed',version:'1.0.0'},'installed: the snapshot reports the plugin ready, with its version');
 check(roles.extensionState({extension:'dhcp'},withPlugins([{...ready,state:'damaged',error:'AGENT_PLUGIN_HASH_MISMATCH'}]),[release]),{state:'damaged',error:'AGENT_PLUGIN_HASH_MISMATCH',version:'1.0.0'},'damaged: with its code');
 check(roles.extensionState({extension:'dhcp'},withPlugins([]),[release]),{state:'available',release},'available: an active release exists');
 check(roles.extensionState({extension:'dns'},withPlugins([]),[release]),{state:'planned'},'planned: a plugin name without a release (DNS)');
 check(roles.extensionState({extension:null},withPlugins([ready]),[release]),{state:'none'},'none: a role without a plugin');
 check(roles.extensionState({extension:'dhcp'},{snapshot:null},undefined),{state:'planned'},'no snapshot and no releases: planned');

 // With the device's jobs: no second install right after a succeeded install job.
 const dns={...release,id:'r2',name:'dns',target:'dns',version:'1.0.0'},releases=[release,dns];
 check(roles.PLUGIN_REPORT_GRACE_MS,16*60_000,'the grace time: 16 minutes');
 const at=Date.UTC(2026,10,10,12);
 const job=(extra={})=>({id:'j1',serverId:'s1',action:'plugin-install',target:'dns 1.0.0',state:'pending',createdAt:at,claimedAt:null,lastProgress:null,...extra});
 const device=(plugins,lastSeen=at+30_000)=>({id:'s1',lastSeen,snapshot:{plugins}});
 const dnsReady={...ready,name:'dns',target:'dns',version:'1.0.0',capabilities:['dns-read']};
 const state=(plugins,jobs,lastSeen)=>roles.extensionState({extension:'dns'},device(plugins,lastSeen),releases,jobs);
 check(state([ready],[job()]),{state:'installing',repair:false},'an open install job: installing');
 check(state([ready],[job({state:'running',claimedAt:at+1000})]),{state:'installing',repair:false},'a running install job: installing');
 check(state([ready,{...dnsReady,state:'damaged',error:'AGENT_PLUGIN_HASH_MISMATCH'}],[job()]),{state:'installing',repair:true},'an open install job on a damaged plugin: installing, repair');
 check(state([ready,{...dnsReady,state:'damaged',error:'AGENT_PLUGIN_HASH_MISMATCH'}],[job({state:'succeeded',lastProgress:at+5000})]),{state:'damaged',error:'AGENT_PLUGIN_HASH_MISMATCH',version:'1.0.0'},'a damaged report wins over waiting');
 const succeeded=job({state:'succeeded',claimedAt:at+1000,lastProgress:at+20_000});
 check(state([ready],[succeeded]),{state:'reporting',version:'1.0.0'},'a succeeded install, a snapshot without the plugin and lastSeen inside the grace time: reporting');
 check(state([ready],[succeeded],at+20_000+roles.PLUGIN_REPORT_GRACE_MS-1),{state:'reporting',version:'1.0.0'},'one millisecond before the grace time ends: still reporting');
 check(state([ready],[succeeded],at+20_000+roles.PLUGIN_REPORT_GRACE_MS),{state:'available',release:dns},'lastSeen beyond the grace time: available again');
 check(state([ready],[{...succeeded,lastProgress:null}],at+1000+roles.PLUGIN_REPORT_GRACE_MS-1),{state:'reporting',version:'1.0.0'},'without lastProgress the grace time counts from claimedAt');
 check(state([ready],[{...succeeded,lastProgress:null,claimedAt:null}],at+roles.PLUGIN_REPORT_GRACE_MS),{state:'available',release:dns},'and without claimedAt from createdAt');
 check(state([ready,dnsReady],[succeeded]),{state:'installed',version:'1.0.0'},'a succeeded install and a snapshot that reports it ready: installed');
 check(state([ready],[job({target:'dhcp 1.1.0'})]),{state:'available',release:dns},'an install job of another plugin is ignored');
 check(state([ready],[job({serverId:'s2'})]),{state:'available',release:dns},'an install job of another device is ignored');
 check(state([ready],[job({action:'plugin-remove',target:'dns'})]),{state:'available',release:dns},'a remove job is no install');
 check(state([ready],[{...succeeded,id:'old',createdAt:at-60_000},job({id:'new',createdAt:at+60_000})]),{state:'installing',repair:false},'the newest job wins over an older succeeded one');
 check(state([ready],[job({id:'new',state:'failed',createdAt:at+60_000,lastProgress:at+70_000}),{...succeeded,id:'old',createdAt:at-60_000}]),{state:'available',release:dns},'a newer failed install wins over an older succeeded one');
 check(state([ready],[job({state:'failed',lastProgress:at+5000})]),{state:'available',release:dns},'a failed install: available');
 check(state([ready],[succeeded],null),{state:'reporting',version:'1.0.0'},'a device that was never seen keeps waiting');
 check(roles.extensionState({extension:'dns'},{snapshot:{plugins:[ready]}},releases,[succeeded]),{state:'reporting',version:'1.0.0'},'without an id and lastSeen the jobs count as the device\'s own and the device keeps waiting');
 check(roles.extensionState({extension:null},device([ready]),releases,[succeeded]),{state:'none'},'a role without a plugin ignores jobs');
 // A removal after the install: a newer succeeded remove ends the waiting; an open or older one does not.
 const remove=(extra={})=>job({id:'r',action:'plugin-remove',target:'dns',createdAt:at+60_000,...extra});
 check(state([ready],[succeeded,remove({state:'succeeded',claimedAt:at+61_000,lastProgress:at+70_000})],at+80_000),{state:'available',release:dns},'a newer succeeded remove inside the grace time: available, not reporting');
 check(roles.extensionState({extension:'dns'},device([ready],at+80_000),[release],[succeeded,remove({state:'succeeded'})]),{state:'planned'},'and planned without a release');
 check(state([ready,dnsReady],[succeeded,remove({state:'running',claimedAt:at+61_000})],at+80_000),{state:'installed',version:'1.0.0'},'an open remove with the plugin reported ready: installed');
 check(state([ready],[succeeded,remove({state:'pending'})],at+80_000),{state:'reporting',version:'1.0.0'},'an open remove without the plugin keeps reporting');
 check(state([ready],[succeeded,remove({state:'succeeded',createdAt:at-60_000})],at+80_000),{state:'reporting',version:'1.0.0'},'a remove older than the install keeps reporting');
 check(state([ready],[succeeded,remove({state:'succeeded',serverId:'s2'})],at+80_000),{state:'reporting',version:'1.0.0'},'a remove of another device is ignored');
 check(state([ready],[succeeded,remove({state:'failed'})],at+80_000),{state:'reporting',version:'1.0.0'},'a failed remove keeps reporting');

 // The console reload after a plugin job: the open install and remove jobs, of one device or of all.
 const open=[job({id:'a'}),job({id:'b',serverId:'s2',state:'running'}),job({id:'c',action:'plugin-remove',target:'dns',serverId:'s3'}),job({id:'d',state:'succeeded'}),job({id:'e',action:'plugin-job',target:'dns-read'}),job({id:'f',action:'refresh',serverId:'s2'})];
 check([...roles.openPluginJobIds(open)].sort(),['a','b','c'],'without serverId: the open install and remove jobs of every device');
 check([...roles.openPluginJobIds(open,'s1')],['a'],'with serverId: only that device');
 check([...roles.openPluginJobIds(open,'s9')],[],'a device without jobs: none');
 check([roles.pluginJobSettled(new Set(['a','b']),new Set(['a','b'])),roles.pluginJobSettled(new Set(['a','b']),new Set(['b'])),roles.pluginJobSettled(new Set(),new Set(['a'])),roles.pluginJobSettled(new Set(['a']),new Set(['a','c']))],[false,true,false,false],'settled only when a job that was open is no longer open');
 // The device order: roles with an extension first (installed, damaged, available, planned alike), then catalog order.
 const entry=(id,extension,kind='role')=>({id,kind,extension,version:null,sources:[]});
 check(roles.deviceTargetOrder([entry('ad-ds',null),entry('iis',null),entry('dns','dns'),entry('dhcp','dhcp')]).map(item=>item.id),['dhcp','dns','ad-ds','iis'],'extension roles first, then catalog order');
}

console.log(`PASS extensions (${checks} checks): detection and extension catalogs, devices 'any' on injected catalogs, the same results as before, software patterns and prefixes, highest version and names, role detection, Windows Server only, the plugin state with jobs (installing, reporting within the grace time, newest job wins, a newer succeeded removal ends the waiting), the open plugin job ids of one or all devices, device order, fleet rows and counts, sample devices.`);
