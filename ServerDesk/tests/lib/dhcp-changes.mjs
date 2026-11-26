// The DHCP changes of plugin 1.1.0 without a database (lib/dhcp-changes.ts,
// docs/dhcp-server.md "Change the DHCP server"): one strict schema per
// operation with good, bad, oversized and unknown-key input, every validation
// code against the sample server, the failover partner match, the mirrored
// partner parameters, the scope-apply parts of a scope with 2000
// reservations, the job requirements of a change and the order of the manage
// gate of the view.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const changes=await import('../../lib/dhcp-changes.ts');
const {demoDhcpSnapshot}=await import('../../ui/shell/demo-dhcp.ts');
const {jobRequirements,jobViewRequirements,jobParametersFromTarget}=await import('../../lib/jobs/requirements.ts');
const {pluginOperations,DHCP_CHANGE_OPERATIONS}=await import('../../lib/plugin-catalog.ts');
const {pluginJobLabelKey}=await import('../../lib/job-display.ts');
const {translate}=await import('../../lib/i18n/translate.ts');
const {dhcpSnapshotSchema}=await import('../../lib/dhcp.ts');
const {DHCP_CHANGE_OPERATIONS:operations,dhcpChangeSchemas,validateDhcpChange,dhcpPartnerDevice,dhcpPartnerParameters,dhcpMirror,dhcpScopeApplyParts,dhcpManageBlocked,dhcpChangeObject,normalizeClientId,DHCP_JOB_PARAMETER_LIMIT}=changes;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const now=Date.UTC(2026,10,4,12),snapshot=demoDhcpSnapshot(now);

// ---- The operations and their requirements -----------------------------------------------
check(operations.length,25,'25 change operations');
check(Object.entries(pluginOperations).filter(([,definition])=>definition.readOnly&&definition.plugin==='dhcp').map(([id])=>id),['dhcp-read'],'dhcp-read stays the only DHCP read operation');
for(const operation of DHCP_CHANGE_OPERATIONS){
 check(pluginOperations[operation],{plugin:'dhcp',permission:'dhcp.manage',readOnly:false},`${operation}: plugin dhcp, dhcp.manage, a change`);
 check(jobRequirements('plugin-job',{plugin:'dhcp',operation}),{known:true,permissions:['dhcp.manage'],managementMode:true,mfa:true,privilegedPath:false,securityEvents:false,capabilities:['plugin-host']},`${operation}: dhcp.manage, Management mode, MFA, plugin-host`);
 check(jobViewRequirements('plugin-job',{},{target:operation}).permissions,['dhcp.manage'],`${operation}: a finished job (parameters wiped) still needs dhcp.manage`);
 check(jobParametersFromTarget('plugin-job',operation),{plugin:'dhcp',operation},`${operation}: the target keeps the operation`);
 const label=translate('en',pluginJobLabelKey('plugin-job',operation));
 assert.ok(/DHCP/.test(label)&&!label.startsWith('jobs.'),`${operation}: an English job label`);checks++;
 assert.ok(!translate('de',pluginJobLabelKey('plugin-job',operation)).startsWith('jobs.'),`${operation}: a German job label`);checks++;
}
check(jobRequirements('plugin-job',{plugin:'dhcp',operation:'dhcp-read'}).managementMode,false,'dhcp-read is unchanged');
check(jobRequirements('plugin-job',{plugin:'dns',operation:'dhcp-scope-create'}).known,false,'an operation of another plugin is not known');
check(translate('en',pluginJobLabelKey('plugin-job','dhcp-scope-create')),'Create DHCP scope','the label of a scope create');

// ---- The schemas ------------------------------------------------------------------------
const good={
 'dhcp-scope-create':{family:'ipv4',name:'Lab 2',description:'',startRange:'10.40.0.10',endRange:'10.40.0.200',subnetMask:'255.255.255.0',leaseDurationSeconds:86400,type:'dhcp',activate:true},
 'dhcp-scope-edit':{family:'ipv4',scopeId:'10.30.0.0',name:'Lab',description:'',startRange:'10.30.0.10',endRange:'10.30.0.99',leaseDurationSeconds:null,type:'both'},
 'dhcp-scope-activate':{family:'ipv4',scopeId:'10.30.0.0'},
 'dhcp-scope-deactivate':{family:'ipv6',prefix:'2001:db8:10::'},
 'dhcp-scope-delete':{family:'ipv4',scopeId:'10.30.0.0'},
 'dhcp-superscope-create':{name:'North',scopeIds:['10.30.0.0']},
 'dhcp-superscope-edit':{name:'Campus',newName:'Main',scopeIds:['10.10.0.0']},
 'dhcp-superscope-activate':{name:'Campus'},'dhcp-superscope-deactivate':{name:'Campus'},'dhcp-superscope-delete':{name:'Campus'},
 'dhcp-exclusion-add':{family:'ipv4',scopeId:'10.10.0.0',start:'10.10.0.30',end:'10.10.0.39'},
 'dhcp-exclusion-remove':{family:'ipv4',scopeId:'10.10.0.0',start:'10.10.0.10',end:'10.10.0.19'},
 'dhcp-reservation-add':{family:'ipv4',scopeId:'10.10.0.0',address:'10.10.0.50',clientId:'00155d010203',name:'pc-new',description:'',type:'dhcp'},
 'dhcp-reservation-edit':{family:'ipv4',scopeId:'10.10.0.0',address:'10.10.0.20',newAddress:'10.10.0.22',clientId:'00-1b-a9-4c-22-10',name:'printer',description:'',type:'both'},
 'dhcp-reservation-remove':{family:'ipv4',scopeId:'10.10.0.0',address:'10.10.0.21'},
 'dhcp-lease-delete':{family:'ipv4',scopeId:'10.20.0.0',addresses:['10.20.0.15','10.20.0.16']},
 'dhcp-option-set':{family:'ipv4',level:'scope',scopeId:'10.10.0.0',code:6,vendorClass:null,userClass:null,values:['10.10.1.4','10.10.1.6']},
 'dhcp-option-remove':{family:'ipv4',level:'server',code:15,vendorClass:null,userClass:null},
 'dhcp-policy-create':{scopeId:'10.10.0.0',name:'Cameras',description:'',enabled:true,order:2,condition:'or',criteria:[{type:'mac',operator:'equals',values:['00-40-8C*']}],ranges:[{start:'10.10.0.160',end:'10.10.0.170'}],leaseDurationSeconds:null},
 'dhcp-policy-edit':{scopeId:null,name:'Printers',description:'',enabled:false,order:1,condition:'and',criteria:[{type:'vendorClass',operator:'equals',values:['HP Printer']}],ranges:[],leaseDurationSeconds:3600},
 'dhcp-policy-delete':{scopeId:'10.10.0.0',name:'IP phones'},
 'dhcp-failover-create':{name:'DC01-DC03',partner:'SRV-DC03',serverType:'primary',mode:'loadBalance',loadBalancePercent:60,serverRole:'active',reservePercent:5,mcltSeconds:3600,autoStateTransition:false,stateSwitchIntervalSeconds:null,messageAuthentication:false,scopeIds:['10.30.0.0']},
 'dhcp-failover-edit':{name:'DC01-DC02',loadBalancePercent:70,addScopeIds:['10.30.0.0'],removeScopeIds:[]},
 'dhcp-failover-remove':{name:'DC01-DC02',deletePartnerScopes:true},
 'dhcp-scope-apply':{scopeId:'10.30.0.0',part:1,parts:1,reservations:[],keep:[]},
};
for(const operation of operations){
 const schema=dhcpChangeSchemas[operation];
 check(schema.safeParse(good[operation]).success,true,`${operation}: the good input passes`);
 check(validateDhcpChange(operation,good[operation],snapshot),{ok:true},`${operation}: the good input fits the sample server`);
 check(schema.safeParse({...good[operation],unknown:1}).success,false,`${operation}: an unknown key is refused`);
 check(schema.safeParse(null).success,false,`${operation}: no object is refused`);
}
const oversized=[['dhcp-scope-create',{name:'x'.repeat(257)}],['dhcp-scope-edit',{description:'x'.repeat(1025)}],['dhcp-option-set',{values:Array(33).fill('10.0.0.1')}],['dhcp-option-set',{values:['x'.repeat(513)]}],
 ['dhcp-policy-create',{criteria:Array(33).fill({type:'mac',operator:'equals',values:['00']})}],['dhcp-policy-create',{ranges:Array(33).fill({start:'10.10.0.160',end:'10.10.0.161'})}],['dhcp-lease-delete',{addresses:Array(101).fill('10.20.0.15')}],['dhcp-lease-delete',{addresses:[]}],
 ['dhcp-superscope-create',{scopeIds:Array(501).fill('10.30.0.0')}],['dhcp-scope-create',{leaseDurationSeconds:86_313_601}],['dhcp-failover-create',{mcltSeconds:59}],['dhcp-scope-edit',{type:'other'}]];
for(const [operation,patch] of oversized)check(dhcpChangeSchemas[operation].safeParse({...good[operation],...patch}).success,false,`${operation}: ${Object.keys(patch)[0]} out of bounds is refused`);

// ---- Validation codes against the sample server ---------------------------------------------
const codes=(operation,patch)=>{const result=validateDhcpChange(operation,{...good[operation],...patch},snapshot);return result.ok?[]:result.errors.map(error=>`${error.field}:${error.code}`);};
check(codes('dhcp-scope-create',{startRange:'10.10.0.10',endRange:'10.10.0.20'}),['startRange:exists'],'a scope that exists');
check(codes('dhcp-scope-create',{startRange:'10.11.0.10',endRange:'10.11.0.20',subnetMask:'255.252.0.0'}),['startRange:overlap'],'a range over another scope');
check(validateDhcpChange('dhcp-scope-create',{...good['dhcp-scope-create'],startRange:'10.11.0.10',endRange:'10.11.0.20',subnetMask:'255.252.0.0'},snapshot).errors[0].params,{scope:'10.10.0.0'},'the overlap names the scope');
check(codes('dhcp-scope-create',{startRange:'10.40.0.300'}),['startRange:ipv4'],'an address that is no IPv4');
check(codes('dhcp-scope-create',{subnetMask:'255.0.255.0'}),['subnetMask:mask'],'a mask that is not contiguous');
check(codes('dhcp-scope-create',{endRange:'10.40.0.5'}),['endRange:order'],'end before start');
check(codes('dhcp-scope-create',{endRange:'10.41.0.5'}),['endRange:subnet'],'start and end in two subnets');
check(codes('dhcp-scope-create',{name:'  '}),['name:required'],'a name is required');
check(codes('dhcp-scope-create',{leaseDurationSeconds:30}),['leaseDurationSeconds:duration'],'a lease below one minute');
check(codes('dhcp-scope-create',{family:'ipv6',prefix:'2001:db8:10::'}).length>0,true,'an IPv6 create needs the IPv6 fields');
check(validateDhcpChange('dhcp-scope-create',{family:'ipv6',prefix:'2001:db8:10::',name:'x',description:'',preference:0,activate:true},snapshot).errors,[{field:'prefix',code:'exists',params:{scope:'2001:db8:10::'}}],'an IPv6 prefix that exists');
check(validateDhcpChange('dhcp-scope-create',{family:'ipv6',prefix:'2001:db8:10::5',name:'x',description:'',preference:0,activate:true},snapshot).errors,[{field:'prefix',code:'prefix'}],'a prefix that is no /64');
check(validateDhcpChange('dhcp-scope-create',{family:'ipv6',prefix:'2001:db8:11::',name:'x',description:'',preference:256,activate:true},snapshot).errors,[{field:'preference',code:'number',params:{min:0,max:255}}],'a preference out of range');
check(codes('dhcp-scope-edit',{scopeId:'10.99.0.0'}),['scopeId:missing'],'an edit of a missing scope');
check(codes('dhcp-scope-edit',{endRange:'10.31.0.5'}),['endRange:subnet'],'an edit keeps the subnet');
check(codes('dhcp-scope-delete',{scopeId:'10.10.0.0'}),['scopeId:inFailover'],'a failover scope cannot be deleted');
check(codes('dhcp-superscope-create',{name:'campus'}),['name:nameTaken'],'a superscope name is unique');
check(codes('dhcp-superscope-create',{scopeIds:['10.99.0.0']}),['scopeIds:missing'],'a superscope of a missing scope');
check(codes('dhcp-superscope-delete',{name:'Nowhere'}),['name:missing'],'a missing superscope');
check(codes('dhcp-exclusion-add',{start:'10.10.0.5'}),['start:outside'],'an exclusion outside the scope range');
check(validateDhcpChange('dhcp-exclusion-add',{...good['dhcp-exclusion-add'],start:'10.10.0.5'},snapshot).errors[0].params,{start:'10.10.0.10',end:'10.10.0.209'},'the range in the error');
check(codes('dhcp-exclusion-remove',{start:'10.10.0.11'}),['start:missing'],'a missing exclusion');
check(codes('dhcp-reservation-add',{address:'10.10.0.20'}),['address:reservationAddress'],'a duplicate reservation address');
check(codes('dhcp-reservation-add',{clientId:'00-1B-A9-4C-22-10'}),['clientId:reservationClient'],'a duplicate client ID (case and separators ignored)');
check(codes('dhcp-reservation-add',{clientId:'zz'}),['clientId:clientId'],'a client ID that is no hex');
check(codes('dhcp-reservation-add',{address:'10.10.0.250'}),['address:outside'],'a reservation outside the range');
check(codes('dhcp-reservation-edit',{address:'10.10.0.99'}),['address:missing'],'an edit of a missing reservation');
check(codes('dhcp-reservation-edit',{newAddress:'10.10.0.21'}),['newAddress:reservationAddress'],'an edit onto another reservation');
check(codes('dhcp-reservation-edit',{newAddress:undefined}),[],'an edit of the same address with its own client ID');
check(codes('dhcp-reservation-remove',{address:'10.10.0.99'}),['address:missing'],'a missing reservation to remove');
check(normalizeClientId('00155d010203'),'00-15-5D-01-02-03','client IDs are normalized');
check(codes('dhcp-option-set',{values:['10.10.1']}),['values:optionValue'],'an IPv4 option value that is no address');
check(validateDhcpChange('dhcp-option-set',{...good['dhcp-option-set'],values:['10.10.1.4','x']},snapshot).errors[0].params,{line:2,type:'ipAddress'},'the line and type of a bad value');
check(codes('dhcp-option-set',{code:51,level:'server',scopeId:undefined,values:['1','2']}),['values:optionSingle'],'a single-valued option with two values');
check(codes('dhcp-option-set',{code:51,level:'server',scopeId:undefined,values:['-5']}),['values:optionValue'],'a DWORD option value');
check(codes('dhcp-option-set',{code:15,level:'server',scopeId:undefined,values:['corp.example']}),[],'a string option');
check(codes('dhcp-option-set',{code:250}),['code:optionUnknown'],'an option the server does not define');
check(validateDhcpChange('dhcp-option-set',{family:'ipv6',level:'server',code:23,vendorClass:null,userClass:null,values:['2001:db8::1','nope']},snapshot).errors,[{field:'values',code:'optionValue',params:{line:2,type:'ipv6Address'}}],'an IPv6 address option');
check(codes('dhcp-option-set',{level:'policy',scopeId:'10.10.0.0',policy:'IP phones'}),[],'a policy option');
check(codes('dhcp-option-set',{level:'policy',scopeId:'10.10.0.0',policy:'Nobody'}),['policy:missing'],'an option of a missing policy');
check(codes('dhcp-option-remove',{code:44}),['code:missing'],'a missing option to remove');
check(codes('dhcp-policy-create',{criteria:[]}),['criteria:criteria'],'a policy without a criterion');
check(codes('dhcp-policy-create',{scopeId:null}),['ranges:rangesServer'],'ranges at server level');
check(codes('dhcp-policy-create',{name:'ip phones'}),['name:nameTaken'],'a policy name is unique in its scope');
check(codes('dhcp-policy-create',{ranges:[{start:'10.10.0.5',end:'10.10.0.9'}]}),['ranges:outside'],'a policy range outside the scope');
check(codes('dhcp-policy-edit',{name:'Nobody'}),['name:missing'],'an edit of a missing policy');
check(codes('dhcp-failover-create',{name:'dc01-dc02'}),['name:nameTaken'],'a relationship name is unique');
check(validateDhcpChange('dhcp-failover-create',{...good['dhcp-failover-create'],scopeIds:['10.10.0.0']},snapshot).errors,[{field:'scopeIds',code:'inFailover',params:{scope:'10.10.0.0',relationship:'DC01-DC02'}}],'a scope already in a relationship');
check(codes('dhcp-failover-create',{scopeIds:[]}),['scopeIds:scopesRequired'],'a relationship needs a scope');
check(codes('dhcp-failover-edit',{removeScopeIds:['10.10.0.0','10.20.0.0'],addScopeIds:[]}),['removeScopeIds:scopesRequired'],'a relationship keeps one scope');
check(codes('dhcp-failover-edit',{removeScopeIds:['10.30.0.0']}),['removeScopeIds:missing'],'a removed scope must be in the relationship');
check(codes('dhcp-failover-remove',{name:'Nobody'}),['name:missing'],'a missing relationship');
check(codes('dhcp-scope-edit',{startRange:2}),['startRange:invalid'],'a schema failure maps to its field');

// ---- The failover partner ---------------------------------------------------------------------
const candidates=[{id:'a',name:'SRV-DC02',serverName:'srv-dc02.corp.example',addresses:['10.10.1.5']},{id:'b',name:'SRV-DC03',serverName:null,addresses:['10.10.1.6','fe80::1']},{id:'c',name:'SRV-APP',serverName:null,addresses:['10.10.1.7']}];
check(dhcpPartnerDevice('SRV-DC02.corp.example',candidates)?.id,'a','the FQDN matches the DHCP server name, case-insensitive');
check(dhcpPartnerDevice('srv-dc03.corp.example',candidates)?.id,'b','the first DNS label matches the device name');
check(dhcpPartnerDevice('SRV-DC03',candidates)?.id,'b','a short name matches the device name');
check(dhcpPartnerDevice('10.10.1.7',candidates)?.id,'c','an IPv4 partner matches a device address');
check(dhcpPartnerDevice('SRV-DC02',[...candidates,{id:'d',name:'SRV-DC02',serverName:null,addresses:[]}]),null,'two matches give null');
check(dhcpPartnerDevice('SRV-DC09.corp.example',candidates),null,'no match gives null');
check(dhcpPartnerDevice('',candidates),null,'no partner text gives null');

// ---- Mirror and partner parameters ------------------------------------------------------------
check(dhcpMirror('dhcp-reservation-add',good['dhcp-reservation-add'],snapshot),{scopeId:'10.10.0.0',relationship:'DC01-DC02',partner:'SRV-DC02.corp.example'},'a change of a failover scope is mirrored');
check(dhcpMirror('dhcp-option-set',{...good['dhcp-option-set'],level:'policy',policy:'IP phones'},snapshot)?.scopeId,'10.10.0.0','a policy option of a failover scope is mirrored');
for(const [operation,parameters] of [['dhcp-lease-delete',good['dhcp-lease-delete']],['dhcp-option-set',{...good['dhcp-option-set'],level:'server'}],['dhcp-policy-edit',good['dhcp-policy-edit']],['dhcp-superscope-edit',good['dhcp-superscope-edit']],['dhcp-scope-deactivate',good['dhcp-scope-deactivate']],['dhcp-scope-activate',good['dhcp-scope-activate']]])
 check(dhcpMirror(operation,parameters,snapshot),null,`${operation}: not mirrored`);
const created=dhcpPartnerParameters('dhcp-failover-create',{...good['dhcp-failover-create'],serverAddress:'10.10.1.4',partnerAddress:'10.10.1.6'},'SRV-DC01.corp.example');
check([created.serverType,created.loadBalancePercent,created.partner,created.serverAddress,created.partnerAddress],['secondary',40,'SRV-DC01.corp.example','10.10.1.6','10.10.1.4'],'failover create: secondary, 100−p, the local server as partner, endpoints swapped');
check(dhcpPartnerParameters('dhcp-failover-create',{...good['dhcp-failover-create'],mode:'hotStandby',serverRole:'active'},'x').serverRole,'standby','hot standby: the role is flipped');
check(dhcpPartnerParameters('dhcp-failover-edit',{name:'DC01-DC02',loadBalancePercent:70,removeScopeIds:['10.20.0.0']},'x'),{name:'DC01-DC02',loadBalancePercent:30,removeScopeIds:['10.20.0.0'],deleteRemovedScopes:true},'failover edit: 100−p, and the partner deletes the removed scopes');
check(dhcpPartnerParameters('dhcp-failover-remove',{name:'DC01-DC02',deletePartnerScopes:false},'x'),{name:'DC01-DC02',deletePartnerScopes:true},'failover remove: the partner deletes the scopes');
check(dhcpPartnerParameters('dhcp-reservation-add',good['dhcp-reservation-add'],'x'),good['dhcp-reservation-add'],'a mirrored change keeps its parameters');

// ---- Replicate parts --------------------------------------------------------------------------
const big=structuredClone(snapshot.ipv4.scopes[0]);
big.subnetMask='255.255.0.0';big.startRange='10.10.0.1';big.endRange='10.10.255.254';
big.reservations=Array.from({length:2000},(_,index)=>({address:`10.10.${Math.floor(index/250)+1}.${index%250+1}`,name:`host-${index}-${'n'.repeat(40)}`,clientId:`00-15-5d-${(index>>8).toString(16).padStart(2,'0')}-${(index&255).toString(16).padStart(2,'0')}-01`,type:'dhcp',description:'Reserved for the test lab, building 7'}));
const parts=dhcpScopeApplyParts(big);
const size=part=>new TextEncoder().encode(JSON.stringify(part)).length;
assert.ok(parts.length>1);checks++;
check(parts.every(part=>size(part)<=DHCP_JOB_PARAMETER_LIMIT),true,'every part is at most 48 KiB');
check(parts.map(part=>[part.part,part.parts]),parts.map((_,index)=>[index+1,parts.length]),'the parts are numbered');
check(parts.map(part=>!!part.settings),parts.map((_,index)=>index===0),'the settings only in part 1');
check(parts.map(part=>!!part.keep),parts.map((_,index)=>index===parts.length-1),'keep only in the last part');
check(parts.flatMap(part=>part.reservations.map(item=>item.address)).sort(),big.reservations.map(item=>item.address).sort(),'the union is every reservation');
check(parts.at(-1).keep.length,2000,'keep names every reservation');
check(parts.every(part=>dhcpChangeSchemas['dhcp-scope-apply'].safeParse(part).success),true,'every part passes the schema');
check(parts[0].settings.policies[0].options,[{code:66,vendorClass:null,userClass:null,values:['voip.corp.example']}],'the scope policies carry their options');
const small=dhcpScopeApplyParts(snapshot.ipv4.scopes[1]);
check([small.length,!!small[0].settings,small[0].keep],[1,true,['10.20.0.11','10.20.0.12']],'a small scope is one part');

// ---- Objects and the manage gate ------------------------------------------------------------------
check(dhcpChangeObject('dhcp-scope-create',good['dhcp-scope-create']),'10.40.0.0','a new scope names its subnet');
check(dhcpChangeObject('dhcp-lease-delete',{addresses:['a','b','c','d','e']}),'a, b, c (+2)','many leases');
check(dhcpChangeObject('dhcp-option-set',good['dhcp-option-set']),'6 / 10.10.0.0','an option with its scope');
const ready={name:'dhcp',role:'dhcp',version:'1.1.0',capabilities:['dhcp-read',...DHCP_CHANGE_OPERATIONS],state:'ready',networkBlocked:true};
const device={permissions:['dhcp.manage'],lastSeen:now-10_000,management:1,snapshot:{mode:'Management',plugins:[ready],agentCapabilities:['plugin-host','plugin-secrets','plugin-ad-identity']}};
const viewer={permissions:[]},data={snapshot};
const gate=(patch={},extra={})=>dhcpManageBlocked({...device,...patch},extra.viewer??viewer,extra.demo??false,now,'data' in extra?extra.data:data);
check(gate(),null,'free with the right, online, plugin 1.1.0, Management mode, a running service and data');
check(gate({permissions:[],lastSeen:null,management:0},{demo:true}),'kit.unavailable.demo','1. demo first');
check(gate({permissions:[],lastSeen:null}),'dhcp.blocked.manageRight','2. the right');
check(gate({permissions:[]},{viewer:{permissions:['*']}}),null,'an Owner has every right');
check(gate({lastSeen:now-10*60_000,management:0}),'extensions.blocked.offline','3. offline');
check(gate({management:0,snapshot:{mode:'ReadOnly',plugins:[{...ready,capabilities:['dhcp-read']}]}}),'dhcp.blocked.pluginOld','4. plugin without the operation');
check(gate({management:0,snapshot:{mode:'ReadOnly',plugins:[ready],agentCapabilities:['plugin-host']}}),'pluginAd.blocked.agent','5. an agent without plugin-ad-identity (4.19.0), after the plugin and before ReadOnly');
check(gate({management:0}),'dhcp.blocked.readOnly','6. ReadOnly');
check(gate({snapshot:{...device.snapshot,mode:'ReadOnly'}}),'dhcp.blocked.readOnly','6. the agent mode as well');
check(gate({},{data:{snapshot:{...snapshot,service:'stopped'}}}),'dhcp.blocked.stopped','7. a stopped service');
check(gate({},{data:null}),'dhcp.blocked.noData','8. no data');
check(gate({},{data:undefined}),null,'without data (a partner) the data steps are skipped');
check(dhcpSnapshotSchema.safeParse(snapshot).success,true,'the sample server with option definitions and policy options passes the schema');
const legacy=structuredClone(snapshot);delete legacy.ipv4.optionDefinitions;delete legacy.ipv6.optionDefinitions;for(const scope of legacy.ipv4.scopes)for(const policy of scope.policies)delete policy.options;
check(dhcpSnapshotSchema.safeParse(legacy).success,true,'1.0.0 data without the new keys still pass');

console.log(`PASS DHCP changes (${checks} checks): 25 operations with their requirements and labels, strict schemas, every validation code against the sample server, the partner match, mirroring and partner parameters, the scope-apply parts and the manage gate order.`);
