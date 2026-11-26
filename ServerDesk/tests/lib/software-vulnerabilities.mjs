// The vulnerability check without a database (lib/software-vulnerabilities.ts):
// the product catalog (lib/vulnerability-catalog.json), catalog matching, the
// version comparison, the conversion of NVD CVE items into ranges, affected
// versions with the fixed version, severity, known exploited, summary, the
// verdict of a program version and its sort order. Real NVD records
// (tests/fixtures/nvd-cves.json) check the age rule of entries without version
// data and AND configurations whose platform node lists Windows next to others.
// Real CVE.org records (tests/fixtures/cvelist-records.json) check the second
// source: the record schema, the matching of affected entries (CPEs, cveNames,
// names with the vendor check, platforms), the version forms, severity, known
// exploited, summary and a verdict.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const vulnerabilities=await import('../../lib/software-vulnerabilities.ts');
const {normalizeSoftwareName}=await import('../../lib/software-inventory.ts');
const {vulnerabilityCatalogSchema,vulnerabilityCatalog:catalog,catalogProductFor,compareVersions,cveAffects,rangesFromCve,cveSeverity,cveKnownExploited,cveSummary,productVerdict,compareVerdicts,cpeFields,nvdCve,nvdTime,severityPill,compareCves,unboundedRangeCounts,unboundedRangeMaxAgeMs,vulnerabilityRulesVersion}=vulnerabilities;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

// ---- Catalog file ----
check(vulnerabilityCatalogSchema.safeParse(catalog).success,true,'the catalog file has the schema');
ok(/^\d{4}-\d{2}-\d{2}$/.test(catalog.checkedAt)&&new Date(catalog.checkedAt+'T00:00:00Z').toISOString().slice(0,10)===catalog.checkedAt,'checkedAt is an ISO date');
check(new Set(catalog.products.map(product=>product.id)).size,catalog.products.length,'unique ids');
ok(catalog.products.every(product=>/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(product.id)),'ids are kebab-case');
ok(catalog.products.every(product=>{const fields=cpeFields(`cpe:2.3:a:${product.cpe}:*:*:*:*:*:*:*:*`);return !!fields&&fields[3]&&fields[4]&&!fields[3].includes('*')&&!fields[4].includes('*');}),'every cpe is vendor:product');
ok(catalog.products.every(product=>[...product.names,...(product.namePrefixes??[])].every(name=>normalizeSoftwareName(name,null)===name)),'names and prefixes are normalized');
ok(catalog.products.every(product=>(product.publishers??[]).every(part=>part===part.toLowerCase())),'publishers are lower case');
const cpes=Object.fromEntries(catalog.products.map(product=>[product.label,product.cpe]));
for(const [label,cpe] of [['Google Chrome','google:chrome'],['Microsoft Edge','microsoft:edge_chromium'],['Mozilla Firefox','mozilla:firefox'],['Mozilla Thunderbird','mozilla:thunderbird'],['7-Zip','7-zip:7-zip'],['Notepad++','notepad-plus-plus:notepad\\+\\+'],['VLC media player','videolan:vlc_media_player'],['PuTTY','putty:putty'],['WinSCP','winscp:winscp'],['WinRAR','rarlab:winrar'],['FileZilla Client','filezilla-project:filezilla_client'],['KeePass','keepass:keepass'],['Wireshark','wireshark:wireshark'],['Git for Windows','git-scm:git'],['Node.js','nodejs:node.js'],['TeamViewer','teamviewer:teamviewer'],['Adobe Acrobat Reader','adobe:acrobat_reader_dc'],['Foxit PDF Reader','foxit:pdf_reader'],['LibreOffice','libreoffice:libreoffice'],['VMware Tools','vmware:tools'],['Veeam Backup & Replication','veeam:veeam_backup_\\&_replication'],['Apache Tomcat','apache:tomcat'],['OpenSSL','openssl:openssl'],['PostgreSQL','postgresql:postgresql']])check(cpes[label],cpe,`catalog has ${label}`);

// ---- Catalog matching (with real uninstall entries) ----
const match=(name,version,publisher)=>catalogProductFor(normalizeSoftwareName(name,version),publisher)?.id??null;
check(match('Google Chrome','156.0.8078.80','Google LLC'),'google-chrome','exact name with publisher');
check(match('Google Chrome','1.0','Someone Else'),null,'publisher constraint');
check(match('7-Zip 26.02 (x64)','26.02','Igor Pavlov'),'7-zip','7-Zip with version and architecture in the name');
check(match('Notepad++ (64-bit x64)','8.9','Notepad++ Team'),'notepad-plus-plus','prefix match for Notepad++ (64-bit');
check(match('PuTTY release 0.83 (64-bit)','0.83.0.0','Simon Tatham'),'putty','prefix match for PuTTY release');
check(match('WinSCP 6.5.5','6.5.5','Martin Prikryl'),'winscp','WinSCP');
check(match('Git','2.52.0','The Git Development Community'),'git-for-windows','Git');
check(match('TeamViewer','15.83.5','TeamViewer'),'teamviewer','TeamViewer');
check(match('Microsoft Edge WebView2-Laufzeit','156.0.4314.58','Microsoft Corporation'),null,'WebView2 is not Edge');
check(match('Mozilla Firefox ESR (x64 en-US)','115.6.0','Mozilla'),'mozilla-firefox-esr','ESR comes before Firefox');
check(match('Mozilla Firefox (x64 de)','121.0','Mozilla'),'mozilla-firefox','Firefox with language');
check(match('Mozilla Firefoxer','1','Mozilla'),null,'a prefix needs a space after it');
check(match('Spotify','1.2.3','Spotify AB'),null,'not in the catalog');
check(productVerdict(null,'1.0').status,'unchecked','not in the catalog: not checked');
check(productVerdict([],null).status,'unchecked','a program without version is never checked');

// ---- Version comparison ----
const order=[['1.10','1.9',1],['23.01','23.1',0],['12.3.5.22544099','12.4',-1],['1.0','1',0],['1.0.0.0','1',0],['2','10',-1],['1.2a','1.2.1',1],['1.2-beta','1.2.0',1],['1.2_RC1','1.2_rc1',0],['0.80.0.0','0.81',-1],['120.0.6099.130','120.0.6099.224',-1],['007','7',0],['99999999999999999999','99999999999999999998',1]];
for(const [a,b,expected] of order){check(compareVersions(a,b),expected,`${a} vs ${b}`);check(compareVersions(b,a),-expected||0,`${b} vs ${a}`);}

// ---- Ranges from NVD items ----
const cve=(configurations,extra={})=>nvdCve.parse({id:'CVE-2024-12345',published:'2024-01-02T03:04:05.678',lastModified:'2024-02-03T00:00:00.000',vulnStatus:'Analyzed',descriptions:[{lang:'en',value:'Text'}],configurations,...extra});
const node=(matches,extra={})=>({operator:'OR',negate:false,cpeMatch:matches,...extra});
const m=(criteria,extra={})=>({vulnerable:true,criteria,matchCriteriaId:'X',...extra});
const range=(fields)=>({exact:null,start:null,startInclusive:false,end:null,endInclusive:false,...fields});
// The synthetic CVE is published 2024-01-02: one day later its entries without version data still count.
const day=86_400_000,soon=Date.UTC(2024,0,3);
check(rangesFromCve(cve([{nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',{versionStartIncluding:'100.0',versionEndExcluding:'120.0.6099.224'})])]}]),'google:chrome',soon),[range({start:'100.0',startInclusive:true,end:'120.0.6099.224'})],'bounds');
check(rangesFromCve(cve([{nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',{versionStartExcluding:'1.0',versionEndIncluding:'2.0'})])]}]),'google:chrome',soon),[range({start:'1.0',end:'2.0',endInclusive:true})],'exclusive start, inclusive end');
check(rangesFromCve(cve([{nodes:[node([m('cpe:2.3:a:7-zip:7-zip:23.01:*:*:*:*:*:*:*'),m('cpe:2.3:a:7-zip:7-zip:23.01:*:*:*:*:*:*:*')])]}]),'7-zip:7-zip',soon),[range({exact:'23.01'})],'exact version, deduplicated');
check(rangesFromCve(cve([{nodes:[node([m('cpe:2.3:a:notepad-plus-plus:notepad\\+\\+:*:*:*:*:*:*:*:*')])]}]),'notepad-plus-plus:notepad\\+\\+',soon),[range({})],'* without bounds, escaped product');
check(rangesFromCve(cve([{nodes:[node([m('cpe:2.3:a:google:chrome:1.0:beta:*:*:*:*:*:*')])]}]),'google:chrome',soon),[],'update other than * or - is skipped');
check(rangesFromCve(cve([{nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:android:*:*',{versionEndExcluding:'2'}),m('cpe:2.3:a:google:chrome:*:*:*:*:*:windows:*:*',{versionEndExcluding:'3'})])]}]),'google:chrome',soon),[range({end:'3'})],'target_sw android is skipped, windows kept');
check(rangesFromCve(cve([{nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',{vulnerable:false,versionEndExcluding:'2'}),m('cpe:2.3:a:mozilla:firefox:*:*:*:*:*:*:*:*',{versionEndExcluding:'2'})])]}]),'google:chrome',soon),[],'non-vulnerable and other products give nothing');
check(rangesFromCve(cve([{operator:'AND',nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',{versionEndExcluding:'5'})]),node([m('cpe:2.3:o:apple:iphone_os:-:*:*:*:*:*:*:*',{vulnerable:false})])]}]),'google:chrome',soon),[],'AND with iOS gives no range');
check(rangesFromCve(cve([{operator:'AND',nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',{versionEndExcluding:'5'})]),node([m('cpe:2.3:o:microsoft:windows_10:-:*:*:*:*:*:*:*',{vulnerable:false}),m('cpe:2.3:h:any:thing:-:*:*:*:*:*:*:*',{vulnerable:false})])]}]),'google:chrome',soon),[range({end:'5'})],'AND with Windows 10 is kept');
check(rangesFromCve(cve([{operator:'AND',nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',{versionEndExcluding:'5'})]),node([m('cpe:2.3:o:apple:macos:-:*:*:*:*:*:*:*',{vulnerable:false})],{negate:true})]}]),'google:chrome',soon),[range({end:'5'})],'a negated platform node is ignored');
check(rangesFromCve(cve([{nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',{versionEndExcluding:'5'})],{negate:true})]}]),'google:chrome',soon),[],'a negated node gives no range');
check(rangesFromCve(cve([{nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*')])]}],{vulnStatus:'Rejected'}),'google:chrome',soon),[],'a rejected CVE gives no range');
check(rangesFromCve(cve([{nodes:[node([m('cpe:2.3:a:google:chrome:-:*:*:*:*:*:*:*'),m('not a cpe')])]}]),'google:chrome',soon),[],'version - and broken names give nothing');
check(rangesFromCve(cve([{operator:'AND',nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',{versionEndExcluding:'5'})]),node([m('cpe:2.3:o:apple:macos:-:*:*:*:*:*:*:*',{vulnerable:false}),m('cpe:2.3:o:microsoft:windows_11:-:*:*:*:*:*:*:*',{vulnerable:false})])]}]),'google:chrome',soon),[range({end:'5'})],'AND with a platform node of macOS and Windows 11 is kept');
check(rangesFromCve(cve([{operator:'AND',nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',{versionEndExcluding:'5'})]),node([m('cpe:2.3:o:apple:macos:-:*:*:*:*:*:*:*',{vulnerable:false})]),node([m('cpe:2.3:o:microsoft:windows:-:*:*:*:*:*:*:*',{vulnerable:false})])]}]),'google:chrome',soon),[],'AND with a macOS node and a Windows node gives no range: every platform node must be met');
check(rangesFromCve(cve([{operator:'AND',nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',{versionEndExcluding:'5'})]),node([m('cpe:2.3:h:any:thing:-:*:*:*:*:*:*:*',{vulnerable:false})])]}]),'google:chrome',soon),[range({end:'5'})],'AND with a hardware platform is kept');
check(rangesFromCve(cve([{operator:'AND',nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',{versionEndExcluding:'5'})]),node([m('not a cpe',{vulnerable:false})])]}]),'google:chrome',soon),[],'AND with a platform node without a readable CPE gives no range');
check(nvdCve.safeParse({id:'CVE-24-1',published:'x',lastModified:'x'}).success,false,'a malformed CVE id is refused');
check(nvdTime('2024-01-02T03:04:05.678'),Date.UTC(2024,0,2,3,4,5,678),'NVD times are UTC');

// ---- Entries without version data: the age rule ----
check([unboundedRangeMaxAgeMs,vulnerabilityRulesVersion],[365*day,1],'365 days, rules version 1');
const unbounded=published=>rangesFromCve(cve([{nodes:[node([m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*'),m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',{versionStartIncluding:'3'}),m('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',{versionEndExcluding:'2'}),m('cpe:2.3:a:google:chrome:1.5:*:*:*:*:*:*:*')])]}],{published}),'google:chrome',Date.UTC(2026,10,4));
const bounded=[range({start:'3',startInclusive:true}),range({end:'2'}),range({exact:'1.5'})];
check(unbounded('2026-10-30T00:00:00.000'),[range({}),...bounded],'a new CVE without version data counts for every version');
check(unbounded('2012-09-15T18:55:03.187'),bounded,'an old one does not; start-only, bounded and exact ranges stay');
check(unbounded('not a time'),bounded,'nor one whose publication cannot be read');
check([unboundedRangeCounts(Date.UTC(2025,10,4),Date.UTC(2026,10,4)),unboundedRangeCounts(Date.UTC(2025,10,4)-1,Date.UTC(2026,10,4)),unboundedRangeCounts(null,0),unboundedRangeCounts(Date.UTC(2026,10,5),Date.UTC(2026,10,4))],[true,false,false,true],'the helper: exactly 365 days counts, 1 ms more does not, no time never');

// ---- Real NVD records (tests/fixtures/nvd-cves.json) ----
const fixture=JSON.parse(readFileSync(new URL('../fixtures/nvd-cves.json',import.meta.url),'utf8'));
check([fixture.fetchedAt,fixture.cves.length],['2026-11-04',15],'the fixture records its fetch date');
ok(fixture.cves.every(item=>nvdCve.safeParse(item).success),'every real record parses');
const real=Object.fromEntries(fixture.cves.map(item=>[item.id,nvdCve.parse(item)]));
const fetched=Date.UTC(2026,10,4),at=(id,cpe,now=fetched)=>rangesFromCve(real[id],cpe,now);
// Unbounded entries of old CVEs (CRIME, SPDY and others) no longer flag every version.
for(const [id,cpe] of [['CVE-2012-4929','google:chrome'],['CVE-2012-4929','mozilla:firefox'],['CVE-2012-4930','google:chrome'],['CVE-2012-4930','mozilla:firefox'],['CVE-2016-7152','mozilla:firefox'],['CVE-2016-7152','google:chrome'],['CVE-2009-1597','mozilla:firefox'],['CVE-2014-4199','vmware:tools']])check(at(id,cpe),[],`${id} gives no range for ${cpe}`);
// The same CRIME record as a new CVE still counts, for 365 days.
const crime=published=>rangesFromCve({...real['CVE-2012-4929'],published:new Date(published).toISOString().slice(0,-1)},'google:chrome',fetched);
check(crime(fetched-30*day),[range({})],'CVE-2012-4929 published 30 days ago counts for every version');
check(crime(fetched-365*day),[range({})],'at exactly 365 days it counts');
check(crime(fetched-365*day-1),[],'at 365 days and 1 ms it does not');
// AND configurations with a platform node that lists Windows next to other systems.
check(at('CVE-2026-6919','google:chrome'),[range({end:'147.0.7727.116'})],'CVE-2026-6919: android, linux, windows counts');
check(at('CVE-2015-1209','google:chrome'),[range({end:'40.0.2214.111'})],'CVE-2015-1209: the AND config with macos, linux, windows counts; its OR config is Chrome on Android (target_sw) and stays skipped');
check(at('CVE-2013-0879','google:chrome'),[range({end:'25.0.1364.97'})],'CVE-2013-0879: linux and windows counts, iphone_os and mac_os_x does not');
check(at('CVE-2012-4903','google:chrome'),[],'CVE-2012-4903: android only gives nothing');
const chromeMatches=id=>real[id].configurations.flatMap(config=>config.nodes).flatMap(item=>item.cpeMatch).filter(item=>item.vulnerable&&cpeFields(item.criteria)[4]==='chrome');
for(const [id,first] of [['CVE-2010-0658',range({end:'4.0.249.0',endInclusive:true})],['CVE-2010-0647',range({end:'4.0.249.78',endInclusive:true})]]){
 // Every listed version without an update such as beta (3.0.193.2:beta is skipped, as before).
 const exact=[...new Set(chromeMatches(id).map(item=>cpeFields(item.criteria)).filter(fields=>fields[5]!=='*'&&['*','-'].includes(fields[6])).map(fields=>fields[5]))].map(version=>range({exact:version}));
 check(at(id,'google:chrome'),[first,...exact],`${id}: the bounded range and the ${exact.length} exact versions as before`);
}
check(at('CVE-2023-7261','google:chrome'),[],'CVE-2023-7261: Chrome only as the platform of Google Updater gives nothing');
check(at('CVE-2024-20726','adobe:acrobat_reader_dc'),[range({start:'15.008.20082',startInclusive:true,end:'23.008.20533'})],'CVE-2024-20726: Acrobat Reader DC on macos or windows');
check(at('CVE-2025-41244','vmware:tools'),[range({start:'12.5.0',startInclusive:true,end:'12.5.4'}),range({start:'13.0.0.0',startInclusive:true,end:'13.0.5.0'})],'CVE-2025-41244: VMware Tools on linux or windows, nothing from open_vm_tools');
check(at('CVE-2024-6053','teamviewer:teamviewer'),[range({end:'15.57.3'})],'CVE-2024-6053: TeamViewer, nothing from TeamViewer Meeting');
// Verdicts from the real records.
const realCve=(id,cpe)=>({id,severity:'medium',score:null,knownExploited:false,ranges:at(id,cpe)});
check(productVerdict([realCve('CVE-2012-4929','google:chrome'),realCve('CVE-2012-4930','google:chrome')],'156.0.8078.80').status,'clean','Chrome 156 is clean of CRIME and SPDY');
check(productVerdict([realCve('CVE-2026-6919','google:chrome')],'147.0.7727.100'),{status:'vulnerable',count:1,highest:'medium',knownExploited:false,fixedIn:'147.0.7727.116',noFixCount:0},'Chrome 147.0.7727.100 is vulnerable, fixed in 147.0.7727.116');
check(productVerdict([realCve('CVE-2026-6919','google:chrome')],'147.0.7727.116').status,'clean','Chrome 147.0.7727.116 is clean');

// ---- Affected versions and the fixed version ----
check(cveAffects([range({end:'120.0.6099.224'})],'120.0.6099.130'),{affected:true,fixedIn:'120.0.6099.224'},'below the exclusive end');
check(cveAffects([range({end:'120.0.6099.224'})],'120.0.6099.224'),{affected:false,fixedIn:null},'the fixed version is not affected');
check(cveAffects([range({start:'110',startInclusive:true,end:'115',endInclusive:true})],'115.0'),{affected:true,fixedIn:null},'inclusive end, no fixed version');
check(cveAffects([range({start:'110',startInclusive:false,end:'115'})],'110'),{affected:false,fixedIn:null},'exclusive start');
check(cveAffects([range({exact:'120.0'})],'120.0.6099.130'),{affected:true,fixedIn:null},'an exact version matches its sub-versions');
check(cveAffects([range({exact:'23.01'})],'23.1'),{affected:true,fixedIn:null},'an exact version compares by value');
check(cveAffects([range({exact:'120.0'})],'120.01'),{affected:false,fixedIn:null},'no prefix match without a dot');
check(cveAffects([range({})],'1.2.3'),{affected:true,fixedIn:null},'* matches every version');
check(cveAffects([range({end:'9'}),range({start:'1',startInclusive:true,end:'5'}),range({end:'4'})],'3'),{affected:true,fixedIn:'4'},'the smallest fixed version above the version');

// ---- Severity, known exploited, summary ----
const metric=(version,score,severity,type='Primary',vector='V')=>({source:'s',type,...(version==='2'?{baseSeverity:severity,cvssData:{baseScore:score,vectorString:vector}}:{cvssData:{baseScore:score,baseSeverity:severity,vectorString:vector}})});
check(cveSeverity(cve([],{metrics:{cvssMetricV2:[metric('2',5,'MEDIUM')],cvssMetricV30:[metric('3',6,'MEDIUM')],cvssMetricV40:[metric('4',9.3,'CRITICAL')],cvssMetricV31:[metric('3',8.8,'HIGH','Secondary','S'),metric('3',7.5,'HIGH','Primary','P')]}})),{severity:'high',score:7.5,vector:'P'},'v3.1 first, Primary first');
check(cveSeverity(cve([],{metrics:{cvssMetricV2:[metric('2',5,'MEDIUM')],cvssMetricV30:[metric('3',6,'MEDIUM')],cvssMetricV40:[metric('4',9.3,'CRITICAL','Secondary')]}})).severity,'critical','then v4.0 (Secondary when alone)');
check(cveSeverity(cve([],{metrics:{cvssMetricV2:[metric('2',5,'MEDIUM')],cvssMetricV30:[metric('3',3.1,'LOW')]}})).severity,'low','then v3.0');
check(cveSeverity(cve([],{metrics:{cvssMetricV2:[metric('2',9.3,'HIGH')]}})),{severity:'high',score:9.3,vector:'V'},'then v2 with its top-level severity');
check(cveSeverity(cve([],{metrics:{cvssMetricV31:[{type:'Primary',cvssData:{baseScore:0}}]}})).severity,'none','a score without a name');
check(cveSeverity(cve([])),{severity:'unknown',score:null,vector:null},'no metrics');
check([cveKnownExploited(cve([],{cisaExploitAdd:'2024-01-17'})),cveKnownExploited(cve([]))],[true,false],'known exploited from cisaExploitAdd');
check(cveSummary(cve([],{descriptions:[{lang:'es',value:'Texto'},{lang:'en',value:'  Text  '}]})),'Text','the English description, trimmed');
const long='😀'.repeat(1200);
check([...cveSummary(cve([],{descriptions:[{lang:'en',value:long}]}))].length,1000,'at most 1000 code points');

// ---- Verdicts ----
const stored=(id,severity,ranges,knownExploited=false,score=null)=>({id,severity,score,knownExploited,ranges});
const cves=[stored('CVE-1','medium',[range({end:'10'})]),stored('CVE-2','critical',[range({end:'8'})],true),stored('CVE-3','low',[range({start:'5',startInclusive:true,end:'6',endInclusive:true})]),stored('CVE-4','high',[range({end:'2'})])];
check(productVerdict(cves,'7'),{status:'vulnerable',count:2,highest:'critical',knownExploited:true,fixedIn:'10',noFixCount:0},'the highest fixed version when every CVE has one');
check(productVerdict(cves,'5.5'),{status:'vulnerable',count:3,highest:'critical',knownExploited:true,fixedIn:null,noFixCount:1},'no fixed version when one CVE has none');
check(productVerdict(cves,'10'),{status:'clean',count:0,highest:null,knownExploited:false,fixedIn:null,noFixCount:0},'clean');
check(productVerdict([],'1'),{status:'clean',count:0,highest:null,knownExploited:false,fixedIn:null,noFixCount:0},'synced without CVEs is clean');
const verdict=(status,highest,knownExploited=false,count=1)=>({status,count,highest,knownExploited,fixedIn:null,noFixCount:0});
const sorted=[verdict('unchecked',null,false,0),verdict('clean',null,false,0),verdict('vulnerable','medium',false,9),verdict('vulnerable','high',false,1),verdict('vulnerable','high',true,1),verdict('vulnerable','high',true,3)].sort(compareVerdicts);
check(sorted.map(item=>[item.status,item.highest,item.knownExploited,item.count]),[['vulnerable','high',true,3],['vulnerable','high',true,1],['vulnerable','high',false,1],['vulnerable','medium',false,9],['clean',null,false,0],['unchecked',null,false,0]],'status, severity, known exploited, count');
check(['critical','high','medium','low','none','unknown'].map(severityPill),['critical','critical','warning','neutral','neutral','neutral'],'pill kinds');
const detail=(id,severity,knownExploited,score,published)=>({id,severity,score,vector:null,knownExploited,published,summary:'',fixedIn:null});
check([detail('A','high',false,8,1),detail('B','high',true,7,1),detail('C','critical',false,9,1),detail('D','high',true,7,2),detail('E','high',true,7.5,0)].sort(compareCves).map(item=>item.id),['C','E','D','B','A'],'CVE order: severity, known exploited, score, newest');

// ---- CVE.org records (tests/fixtures/cvelist-records.json) ----
const {cveRecord,cveListPage,cveListRecords,rangesFromCveRecord,cveRecordSeverity,cveRecordKnownExploited,cveRecordSummary,cveRecordPublished,cveRecordUpdated,affectedMatches,catalogProductById,cveOrgUrl,nvdCveUrl}=vulnerabilities;
const records=JSON.parse(readFileSync(new URL('../fixtures/cvelist-records.json',import.meta.url),'utf8'));
check([records.fetchedAt,records.source,records.records.length],['2026-11-04','https://cveawg.mitre.org/api/cve/<id>',12],'the CVE.org fixture records its fetch date and source');
ok(records.records.every(item=>cveRecord.safeParse(item).success),'every real CVE.org record parses');
const cveOrg=Object.fromEntries(records.records.map(item=>[item.cveMetadata.cveId,cveRecord.parse(item)]));
check(Object.keys(cveRecord.parse(records.records[0]).cveMetadata).sort(),['cveId','dateUpdated','datePublished','state'].sort(),'other fields are dropped');
check(cveListRecords(cveListPage.parse({})),[],'a page past the last one is {}');
check(cveListRecords(cveListPage.parse({cvelistv5:records.records})).length,12,'a page of records');
check(cveListPage.safeParse({cvelistv5:Array.from({length:101},()=>records.records[0])}).success,false,'more than 100 records are refused');
check(cveListPage.safeParse({error:'x'}).success,false,'another object is refused');
check(cveRecord.safeParse({cveMetadata:{cveId:'CVE-1',state:'PUBLISHED'},containers:{cna:{}}}).success,false,'a malformed CVE id is refused');
check(cveRecord.safeParse({cveMetadata:{cveId:'CVE-2024-1234',state:'PUBLISHED'},containers:{cna:{descriptions:[{lang:'en',value:'x'.repeat(100_001)}]}}}).success,false,'text has length caps');
// The catalog field cveNames.
const withNames=entry=>vulnerabilityCatalogSchema.safeParse({checkedAt:'2026-11-04',products:[{id:'x',label:'X',cpe:'x:x',names:['x'],cveNames:[entry]}]}).success;
check([withNames({vendor:'V',product:'P'}),withNames({vendor:'V',product:'P',extra:1}),withNames({vendor:'',product:'P'})],[true,false,false],'cveNames is strict with non-empty strings');
check(catalogProductById('microsoft-edge').cveNames[0],{vendor:'Microsoft',product:'Microsoft Edge (Chromium-based)'},'Edge has its CVE.org name');
check(catalogProductById('7-zip').cveNames[0],{vendor:'ipavlov',product:'7-Zip'},'7-Zip has its GitHub CNA vendor');
// The real records with the current catalog.
const recordRanges=(id,productId)=>rangesFromCveRecord(cveOrg[id],catalogProductById(productId));
for(const [id,productId,expected,label] of [
 ['CVE-2026-6919','google-chrome',[range({end:'147.0.7727.117'})],'the Chrome CNA writes version = lessThan: no start'],
 ['CVE-2026-121131','google-chrome',[range({end:'157.0.8103.38'})],'a CVE the NVD has not analysed yet'],
 ['CVE-2024-4947','google-chrome',[range({end:'125.0.6422.60'})],'a known exploited one'],
 ['CVE-2024-5700','mozilla-firefox',[range({end:'127'})],'Firefox: CNA and ADP give one range'],
 ['CVE-2024-5700','mozilla-firefox-esr',[range({end:'115.12'})],'Firefox ESR'],
 ['CVE-2024-5700','mozilla-thunderbird',[range({end:'115.12'})],'Thunderbird'],
 ['CVE-2026-66326','microsoft-edge',[range({start:'1.0.0.0',startInclusive:true,end:'151.0.4129.59'})],'Edge through cveNames, with a start'],
 ['CVE-2026-80159','adobe-acrobat-reader',[range({end:'26.002.21900',endInclusive:true})],'Acrobat Reader, not Adobe Acrobat or Acrobat 2024'],
 ['CVE-2026-104086','7-zip',[range({end:'26.03'})],'7-Zip CNA'],
 ['CVE-2025-53816','7-zip',[range({end:'25.0.0'})],'7-Zip through cveNames (ipavlov), "< 25.0.0"'],
 ['CVE-2023-52169','7-zip',[range({end:'24.01'})],'CNA n/a, CISA ADP CPE'],
 ['CVE-2022-47111','7-zip',[range({exact:'22.01'})],'an exact version'],
 ['CVE-2026-48102','7-zip',[],'the fork of vendor mcmilk does not count'],
 ['CVE-2025-0411','7-zip',[],'free text "24.08 (x64)" gives nothing'],
 ['CVE-2026-6919','mozilla-firefox',[],'a Chrome record gives nothing for Firefox'],
])check(recordRanges(id,productId),expected,`${id} → ${productId}: ${label}`);
// Severity, known exploited, summary and dates.
check(cveRecordSeverity(cveOrg['CVE-2026-121131']),{severity:'critical',score:9.6,vector:'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:H'},'no CNA metric: the CISA ADP CVSS 3.1');
check(cveRecordSeverity(cveOrg['CVE-2026-104086']).vector?.startsWith('CVSS:3.1/'),true,'CNA v3.1 before CNA v4.0');
check(cveRecordSeverity(cveOrg['CVE-2025-0411']),{severity:'high',score:7,vector:'CVSS:3.0/AV:L/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:H'},'CNA v3.0');
check(cveRecordSeverity(cveOrg['CVE-2025-53816']).score!==null,true,'CNA v4.0 alone');
const synthetic=(cna,adp=[],state='PUBLISHED')=>cveRecord.parse({cveMetadata:{cveId:'CVE-2026-0001',state,datePublished:'2026-01-02T03:04:05.000Z',dateUpdated:'2026-01-03T00:00:00'},containers:{cna,adp}});
check(cveRecordSeverity(synthetic({metrics:[{cvssV2_0:{baseScore:5}}]},[{metrics:[{cvssV3_1:{baseScore:9.8,baseSeverity:'CRITICAL'}}]}])),{severity:'medium',score:5,vector:null},'CNA first, even v2.0 before an ADP v3.1; a score without a name gives its band');
check(cveRecordSeverity(synthetic({metrics:[{cvssV3_1:{baseScore:8,baseSeverity:'SEVERE'}}]})).severity,'high','an invalid name gives the band of the score');
check(cveRecordSeverity(synthetic({},[{metrics:[{other:{type:'ssvc'}}]}])),{severity:'unknown',score:null,vector:null},'no metric: unknown');
check([cveRecordKnownExploited(cveOrg['CVE-2024-4947']),cveRecordKnownExploited(cveOrg['CVE-2026-121131']),cveRecordKnownExploited(synthetic({metrics:[{other:{type:'kev'}}]}))],[true,false,false],'known exploited from a kev entry in an ADP container only');
check(cveRecordSummary(synthetic({descriptions:[{lang:'de',value:'Text'},{lang:'en-US',value:' US '},{lang:'en',value:'  English  '}]})),'English','the English CNA description, trimmed');
check(cveRecordSummary(synthetic({descriptions:[{lang:'en-US',value:'US'}]})),'US','en-US when there is no en');
check([...cveRecordSummary(synthetic({descriptions:[{lang:'en',value:'😀'.repeat(1200)}]}))].length,1000,'at most 1000 code points');
check([cveRecordPublished(synthetic({})),cveRecordUpdated(synthetic({}))],[Date.UTC(2026,0,2,3,4,5),Date.UTC(2026,0,3)],'publication and update time, a time without zone is UTC');
// Matching and version forms with synthetic entries.
const chromeProduct=catalogProductById('google-chrome'),zipProduct=catalogProductById('7-zip');
const entry=(fields,versions=[{version:'1.0',status:'affected',lessThan:'5.0',versionType:'custom'}])=>({vendor:'Google',product:'Chrome',...fields,versions});
const ranges=(fields,versions,product=chromeProduct,state)=>rangesFromCveRecord(synthetic({affected:[entry(fields,versions)]},[],state),product);
const fiveBelow=[range({start:'1.0',startInclusive:true,end:'5.0'})];
check(ranges({platforms:['Android']}),[],'platforms without Windows: no match');
check(ranges({platforms:['Windows','MacOS']}),fiveBelow,'platforms with Windows keep the range');
check(ranges({platforms:['Microsoft Windows 11']}),fiveBelow,'a platform that contains windows');
check(ranges({},undefined,chromeProduct,'REJECTED'),[],'a rejected record gives nothing');
check(ranges({},[{version:'abc123',status:'affected',lessThan:'def456',versionType:'git'}]),[],'git versions give nothing');
check(ranges({},[{version:'1.0',status:'unaffected',lessThan:'5.0'}]),[],'unaffected versions give nothing');
check(ranges({},[{version:'>= 9.11, < 26.01',status:'affected'}]),[range({start:'9.11',startInclusive:true,end:'26.01'})],'">= 9.11, < 26.01"');
check(ranges({},[{version:'> 2.0, <= 3.1',status:'affected'}]),[range({start:'2.0',end:'3.1',endInclusive:true})],'"> 2.0, <= 3.1"');
check(ranges({},[{version:'>= 1.0',status:'affected'}]),[],'a lower bound alone gives nothing');
check(ranges({},[{version:'< 1.0, < 2.0',status:'affected'}]),[],'two upper bounds give nothing');
check(ranges({},[{version:'= 1.2.3',status:'affected'}]),[range({exact:'1.2.3'})],'a single = is exact');
check(ranges({},[{version:'16.02 and earlier',status:'affected'},{version:'v3.5 and prior',status:'affected'}]),[range({end:'16.02',endInclusive:true}),range({end:'3.5',endInclusive:true})],'"and earlier" and "and prior": inclusive end, a leading v is dropped');
check(ranges({},[{version:'before 5.4',status:'affected'},{version:'Prior to 6.0',status:'affected'}]),[range({end:'5.4'}),range({end:'6.0'})],'"before" and "prior to": exclusive end');
check(rangesFromCveRecord(synthetic({affected:[{vendor:'Google',product:'Chrome',defaultStatus:'affected'}]}),chromeProduct),[],'defaultStatus alone gives nothing');
check(ranges({},[{version:'unspecified',status:'affected'}]),[],'"unspecified" without lessThan gives nothing');
check(ranges({},[{version:'0',status:'affected'},{version:'*',status:'affected'},{version:'-',status:'affected'},{version:'n/a',status:'affected'},{version:'',status:'affected'},{version:'All versions',status:'affected'}]),[],'0, *, -, n/a, empty and free text give nothing');
check(ranges({},[{version:'0',status:'affected',lessThan:'*'},{version:'1',status:'affected',lessThan:'4.*'}]),[],'an upper bound that is no version gives nothing');
check(ranges({},[{version:'unspecified',status:'affected',lessThan:'127'},{version:'0',status:'affected',lessThanOrEqual:'v2.5'}]),[range({end:'127'}),range({end:'2.5',endInclusive:true})],'start null for text or 0, lessThanOrEqual is inclusive');
// Matching rules: (a) CPEs, (b) cveNames, (c) names with the vendor check.
const matchesChrome=fields=>affectedMatches({...fields},chromeProduct);
check([matchesChrome({vendor:'x',product:'y',cpes:['cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*']}),matchesChrome({vendor:'x',product:'y',cpes:['cpe:2.3:a:google:chrome:*:*:*:*:*:windows:*:*']}),matchesChrome({vendor:'x',product:'y',cpes:['cpe:2.3:a:google:chrome:*:*:*:*:*:android:*:*']}),matchesChrome({vendor:'x',product:'y',cpes:['cpe:2.3:o:google:chrome:*:*:*:*:*:*:*:*']})],[true,true,false,false],'(a) an a: CPE of the vendor and product with target_sw *, windows; not android, not o:');
check(affectedMatches({vendor:'x',product:'y',cpes:['cpe:2.3:a:notepad-plus-plus:notepad\\+\\+:*:*:*:*:*:*:*:*']},catalogProductById('notepad-plus-plus')),true,'(a) CPE escapes as in cpeFields');
check([affectedMatches({vendor:' IPAVLOV ',product:'7-zip'},zipProduct),affectedMatches({vendor:'ipavlov',product:'7-Zip Extra'},zipProduct)],[true,false],'(b) cveNames, normalized');
check([matchesChrome({vendor:'Google',product:'Chrome'}),matchesChrome({vendor:'Google LLC',product:'Google  Chrome'}),matchesChrome({vendor:'n/a',product:'Google Chrome'}),matchesChrome({vendor:'',product:'google chrome'}),matchesChrome({vendor:'unknown',product:'Google Chrome'}),matchesChrome({vendor:'Fork',product:'Google Chrome'})],[true,true,true,true,true,false],'(c) names with the vendor check');
check(affectedMatches({vendor:'Mozilla',product:'Firefox ESR'},catalogProductById('mozilla-firefox-esr')),true,'(c) vendor and product equal the CPE ("_" as a space)');
check(affectedMatches({vendor:'Anyone',product:'Notepad++'},catalogProductById('notepad-plus-plus')),true,'(c) a product without publishers takes any vendor');
check(affectedMatches({vendor:'n/a',product:'n/a'},zipProduct),false,'n/a / n/a never matches');
// A verdict from the CVE.org ranges.
const cveOrgCve={id:'CVE-2026-121131',severity:'critical',score:9.6,knownExploited:false,ranges:recordRanges('CVE-2026-121131','google-chrome'),source:'cvelist'};
check(productVerdict([cveOrgCve],'157.0.8103.10'),{status:'vulnerable',count:1,highest:'critical',knownExploited:false,fixedIn:'157.0.8103.38',noFixCount:0},'Chrome 157.0.8103.10 is vulnerable through CVE.org');
check(productVerdict([cveOrgCve],'157.0.8103.38').status,'clean','Chrome 157.0.8103.38 is clean');
check([cveOrgUrl('CVE-2026-121131'),nvdCveUrl('CVE-2026-121131')],['https://www.cve.org/CVERecord?id=CVE-2026-121131','https://nvd.nist.gov/vuln/detail/CVE-2026-121131'],'the links of both sources');

console.log(`PASS software vulnerabilities (${checks} checks): catalog, matching, versions, NVD ranges, the age rule, real NVD records, affected versions, severity, verdicts and order, and CVE.org records (parsing, matching, version forms, severity, verdicts).`);
