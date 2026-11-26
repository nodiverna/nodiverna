// The vulnerability check of the software inventory (docs/software-vulnerabilities.md):
// the curated product catalog (lib/vulnerability-catalog.json), the version
// comparison, the conversion of one NVD CVE item or one CVE.org record (CVE
// JSON 5, the optional second source) into version ranges of a catalog
// product, and the verdict of one program version. Pure, without
// server imports: the sync (lib/server/devices/vulnerability-sync.ts), the read views
// (lib/server/devices/vulnerabilities.ts), the demo data, the UI and the tests use it.
import {z} from 'zod';
import * as catalogModule from './vulnerability-catalog.json';

export type Severity='critical'|'high'|'medium'|'low'|'none'|'unknown';
export const severities:readonly Severity[]=['critical','high','medium','low','none','unknown'];
/** One affected version range of a CVE for one product: an exact version, bounds, or neither (every version). */
export type VersionRange={exact:string|null;start:string|null;startInclusive:boolean;end:string|null;endInclusive:boolean};
/** Where the ranges of a CVE come from: the NVD, or a CVE.org record (the optional second source). */
export type VulnerabilitySource='nvd'|'cvelist';
/** A stored CVE with its ranges for one product, from one source. */
export type ProductCve={id:string;severity:Severity;score:number|null;knownExploited:boolean;ranges:readonly VersionRange[];source:VulnerabilitySource};
export type VerdictStatus='vulnerable'|'clean'|'unchecked';
export type Verdict={status:VerdictStatus;count:number;highest:Severity|null;knownExploited:boolean;fixedIn:string|null;noFixCount:number};
/** A vendor and product pair as the affected entries of CVE.org records write it. */
export type CveName={vendor:string;product:string};
export type CatalogProduct={id:string;label:string;cpe:string;names:string[];namePrefixes?:string[];publishers?:string[];cveNames?:CveName[]};
export type VulnerabilityCatalog={checkedAt:string;products:CatalogProduct[]};

// ---- Catalog ----------------------------------------------------------------

// The bundler and the test loaders differ in how a JSON module looks: a default export or the object itself.
const catalogFile:unknown='default' in catalogModule?(catalogModule as {default:unknown}).default:catalogModule;
/** The shape of the catalog file; tests/lib/software-vulnerabilities.mjs checks the file against it. */
export const vulnerabilityCatalogSchema=z.object({
 checkedAt:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
 products:z.array(z.object({
  id:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),label:z.string().min(1),
  // vendor:product of a CPE 2.3 name, with the CPE escapes (for example notepad\+\+).
  cpe:z.string().regex(/^(?:[a-z0-9._-]|\\.)+:(?:[a-z0-9._-]|\\.)+$/),
  names:z.array(z.string().min(1)),namePrefixes:z.array(z.string().min(1)).optional(),publishers:z.array(z.string().min(1)).optional(),
  // Vendor and product pairs of CVE.org records that the other matching rules miss (vendor aliases).
  cveNames:z.array(z.object({vendor:z.string().min(1),product:z.string().min(1)}).strict()).optional(),
 }).strict()).min(1),
}).strict();
/** The catalog of products the check covers. A module loader without JSON support gives an empty catalog. */
const catalogData=catalogFile as Partial<VulnerabilityCatalog>|undefined;
export const vulnerabilityCatalog:VulnerabilityCatalog={checkedAt:catalogData?.checkedAt??'',products:catalogData?.products??[]};
export const catalogProductById=(id:string)=>vulnerabilityCatalog.products.find(product=>product.id===id)??null;

/**
 * The first catalog product whose names contain the normalized name, or one of
 * whose prefixes followed by a space starts it, and whose publishers (when set)
 * have one entry that occurs in the publisher. Otherwise null.
 */
export function catalogProductFor(normalizedName:string,publisher:string|null,products:readonly CatalogProduct[]=vulnerabilityCatalog.products):CatalogProduct|null{
 const vendor=(publisher??'').normalize('NFKC').toLowerCase();
 return products.find(product=>(product.names.includes(normalizedName)||(product.namePrefixes??[]).some(prefix=>normalizedName.startsWith(prefix+' ')))
  &&(!product.publishers?.length||product.publishers.some(part=>vendor.includes(part))))??null;
}

// ---- Versions -----------------------------------------------------------------

const numeric=/^\d+$/;
const compareNumbers=(a:string,b:string)=>{const x=a.replace(/^0+(?=\d)/,''),y=b.replace(/^0+(?=\d)/,'');return x.length!==y.length?x.length-y.length:x<y?-1:x>y?1:0;};
/**
 * Compares two versions: split on ".", "-" and "_"; numeric segments compare
 * as numbers, a missing segment counts as 0, other segments compare as text
 * without case and sort after numeric ones. Negative, 0 or positive.
 */
export function compareVersions(a:string,b:string):number{
 const left=a.trim().split(/[._-]/),right=b.trim().split(/[._-]/);
 for(let index=0;index<Math.max(left.length,right.length);index++){
  const x=left[index]||'0',y=right[index]||'0',xn=numeric.test(x),yn=numeric.test(y);
  let result:number;
  if(xn&&yn)result=compareNumbers(x,y);
  else if(xn!==yn)result=xn?-1:1;
  else{const lx=x.toLowerCase(),ly=y.toLowerCase();result=lx<ly?-1:lx>ly?1:0;}
  if(result)return Math.sign(result);
 }
 return 0;
}

/**
 * Whether the ranges of one CVE affect the version. A range with an exact
 * version matches that version and its sub-versions ("120.0" matches
 * "120.0.6099.130"); a range with bounds compares; a range with neither matches
 * every version. fixedIn is the smallest exclusive upper bound above the
 * version among the matching ranges, else null.
 */
export function cveAffects(ranges:readonly VersionRange[],version:string):{affected:boolean;fixedIn:string|null}{
 let affected=false,fixedIn:string|null=null;
 for(const range of ranges){
  let matches:boolean;
  if(range.exact!==null)matches=compareVersions(version,range.exact)===0||version.startsWith(range.exact+'.');
  else{
   const start=range.start===null?1:compareVersions(version,range.start),end=range.end===null?-1:compareVersions(version,range.end);
   matches=(start>0||(start===0&&range.startInclusive))&&(end<0||(end===0&&range.endInclusive));
  }
  if(!matches)continue;
  affected=true;
  if(range.exact===null&&range.end!==null&&!range.endInclusive&&compareVersions(range.end,version)>0&&(fixedIn===null||compareVersions(range.end,fixedIn)<0))fixedIn=range.end;
 }
 return {affected,fixedIn};
}

// ---- NVD items ----------------------------------------------------------------

const text=(max:number)=>z.string().max(max);
const cpeMatch=z.object({vulnerable:z.boolean(),criteria:text(2000),versionStartIncluding:text(200).optional(),versionStartExcluding:text(200).optional(),versionEndIncluding:text(200).optional(),versionEndExcluding:text(200).optional()});
const node=z.object({operator:z.string().max(10).optional(),negate:z.boolean().optional(),cpeMatch:z.array(cpeMatch).max(20000).default([])});
const configuration=z.object({operator:z.string().max(10).optional(),negate:z.boolean().optional(),nodes:z.array(node).max(5000).default([])});
const cvssData=z.object({baseScore:z.number().min(0).max(10).optional(),baseSeverity:text(20).optional(),vectorString:text(500).optional()});
const metric=z.object({type:text(40).optional(),baseSeverity:text(20).optional(),cvssData});
const metricList=z.array(metric).max(100).optional();
/** One CVE of the NVD CVE API 2.0, only the fields the check reads; other fields are allowed and dropped. */
export const nvdCve=z.object({
 id:z.string().regex(/^CVE-\d{4}-\d{4,}$/),
 published:text(40),lastModified:text(40),vulnStatus:text(60).optional(),
 descriptions:z.array(z.object({lang:text(20),value:text(100_000)})).max(100).default([]),
 metrics:z.object({cvssMetricV40:metricList,cvssMetricV31:metricList,cvssMetricV30:metricList,cvssMetricV2:metricList}).optional(),
 configurations:z.array(configuration).max(5000).optional(),
 cisaExploitAdd:text(40).optional(),
});
export type NvdCve=z.infer<typeof nvdCve>;
/** One page of GET /rest/json/cves/2.0. */
export const nvdPage=z.object({
 resultsPerPage:z.number().int().min(0),startIndex:z.number().int().min(0),totalResults:z.number().int().min(0),
 vulnerabilities:z.array(z.object({cve:nvdCve})),
});
export type NvdPage=z.infer<typeof nvdPage>;

/** The 13 fields of a CPE 2.3 formatted string, escapes kept; null when it is none. */
export function cpeFields(criteria:string):string[]|null{
 const fields:string[]=[];let current='';
 for(let index=0;index<criteria.length;index++){
  const character=criteria[index];
  if(character==='\\'&&index+1<criteria.length){current+=character+criteria[index+1];index++;continue;}
  if(character===':'){fields.push(current);current='';continue;}
  current+=character;
 }
 fields.push(current);
 return fields.length===13&&fields[0]==='cpe'&&fields[1]==='2.3'?fields:null;
}
const unescape=(value:string)=>value.replace(/\\(.)/g,'$1');
const anyValue=(value:string)=>value==='*'||value==='-';
const windowsPlatform=(fields:string[])=>fields[3]==='microsoft'&&fields[4].startsWith('windows');
/** A match a Windows machine can meet: a Windows CPE, or any application (a:) or hardware (h:) CPE. */
const windowsPossible=(criteria:string)=>{const fields=cpeFields(criteria);return !!fields&&(fields[2]==='a'||fields[2]==='h'||(fields[2]==='o'&&windowsPlatform(fields)));};

/**
 * Raise this when the matching rules change: the sync then downloads every
 * product again in full (vulnerability_products.rules_version).
 */
export const vulnerabilityRulesVersion=1;
/** How long after its publication a CVE entry without any version data still counts for every version. */
export const unboundedRangeMaxAgeMs=365*24*3_600_000;
/**
 * Whether a range without version data (every version) of a CVE published at
 * `published` still counts at `now`: at most unboundedRangeMaxAgeMs after the
 * publication. The NVD keeps such old entries (CVE-2012-4929 for Chrome) also
 * when all current versions are safe. productCves (lib/server/devices/vulnerability-verdicts.ts)
 * mirrors this rule in SQL.
 */
export const unboundedRangeCounts=(published:number|null,now:number)=>published!==null&&now-published<=unboundedRangeMaxAgeMs;

/**
 * The ranges of one NVD CVE for one catalog CPE (vendor:product) at `now`.
 * Only vulnerable application matches of the same vendor and product count,
 * with update "*" or "-" and target_sw "*", "-" or "windows". An AND
 * configuration counts only when every platform node (a node without a
 * vulnerable match) has a match a Windows machine can meet, so a node that
 * lists Windows next to other systems counts and an Android-only node does
 * not. A match without any version data counts only within
 * unboundedRangeMaxAgeMs after the CVE was published. Negated nodes and
 * rejected CVEs give no ranges.
 */
export function rangesFromCve(cve:NvdCve,cpe:string,now:number):VersionRange[]{
 if(cve.vulnStatus==='Rejected')return [];
 const [vendor,product]=cpeFields(`cpe:2.3:a:${cpe}:*:*:*:*:*:*:*:*`)?.slice(3,5)??[];
 if(!vendor||!product)return [];
 const unboundedCounts=unboundedRangeCounts(nvdTime(cve.published),now);
 const ranges=new Map<string,VersionRange>();
 for(const config of cve.configurations??[]){
  if(config.negate)continue;
  const nodes=config.nodes.filter(item=>!item.negate);
  if(config.operator==='AND'){
   const platforms=nodes.filter(item=>!item.cpeMatch.some(match=>match.vulnerable));
   if(!platforms.every(item=>item.cpeMatch.some(match=>windowsPossible(match.criteria))))continue;
  }
  for(const match of nodes.flatMap(item=>item.cpeMatch)){
   if(!match.vulnerable)continue;
   const fields=cpeFields(match.criteria);
   if(!fields||fields[2]!=='a'||fields[3]!==vendor||fields[4]!==product)continue;
   if(!anyValue(fields[6])||!(anyValue(fields[10])||fields[10]==='windows'))continue;
   let range:VersionRange;
   if(fields[5]==='*'){
    const start=match.versionStartIncluding??match.versionStartExcluding??null,end=match.versionEndExcluding??match.versionEndIncluding??null;
    if(start===null&&end===null&&!unboundedCounts)continue;
    range={exact:null,start,startInclusive:match.versionStartIncluding!==undefined,end,endInclusive:match.versionEndExcluding===undefined&&match.versionEndIncluding!==undefined};
   }else if(fields[5]==='-')continue;
   else range={exact:unescape(fields[5]),start:null,startInclusive:false,end:null,endInclusive:false};
   ranges.set(JSON.stringify(range),range);
  }
 }
 return [...ranges.values()];
}

const severityOfScore=(score:number):Severity=>score===0?'none':score<4?'low':score<7?'medium':score<9?'high':'critical';
/**
 * The severity of a CVE: the CVSS of v3.1, then v4.0, then v3.0, then v2
 * (the Primary entry first within a version). unknown without any metric.
 */
export function cveSeverity(cve:Pick<NvdCve,'metrics'>):{severity:Severity;score:number|null;vector:string|null}{
 const metrics=cve.metrics;
 for(const list of [metrics?.cvssMetricV31,metrics?.cvssMetricV40,metrics?.cvssMetricV30,metrics?.cvssMetricV2]){
  if(!list?.length)continue;
  const entry=list.find(item=>item.type==='Primary')??list[0];
  const score=entry.cvssData.baseScore??null,named=(entry.cvssData.baseSeverity??entry.baseSeverity??'').toLowerCase();
  const severity=severities.includes(named as Severity)?named as Severity:score===null?'unknown':severityOfScore(score);
  return {severity,score,vector:entry.cvssData.vectorString??null};
 }
 return {severity:'unknown',score:null,vector:null};
}
/** Listed in the CISA catalog of known exploited vulnerabilities. */
export const cveKnownExploited=(cve:Pick<NvdCve,'cisaExploitAdd'>)=>cve.cisaExploitAdd!==undefined;
/** The English description, trimmed, at most 1000 code points. */
export function cveSummary(cve:Pick<NvdCve,'descriptions'>):string{
 return [...(cve.descriptions.find(item=>item.lang==='en')?.value.trim()??'')].slice(0,1000).join('');
}
/** An NVD time ("2024-01-02T03:04:05.678", UTC without zone) in epoch milliseconds, or null. */
export function nvdTime(value:string):number|null{
 const time=Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(value)?value:value+'Z');
 return Number.isFinite(time)?time:null;
}

// ---- CVE.org records (CVE JSON 5) ----------------------------------------------

const cvssScore=z.object({baseScore:z.number().min(0).max(10).optional(),baseSeverity:text(20).optional(),vectorString:text(500).optional()});
const recordMetric=z.object({cvssV3_1:cvssScore.optional(),cvssV4_0:cvssScore.optional(),cvssV3_0:cvssScore.optional(),cvssV2_0:cvssScore.optional(),other:z.object({type:text(100).optional()}).optional()});
const recordVersion=z.object({version:text(500).optional(),status:text(40).optional(),lessThan:text(500).optional(),lessThanOrEqual:text(500).optional(),versionType:text(100).optional()});
const affectedEntry=z.object({
 vendor:text(2000).optional(),product:text(2000).optional(),platforms:z.array(text(2000)).max(1000).optional(),cpes:z.array(text(2000)).max(10000).optional(),
 defaultStatus:text(40).optional(),versions:z.array(recordVersion).max(20000).optional(),
});
const recordContainer=z.object({
 affected:z.array(affectedEntry).max(5000).default([]),
 descriptions:z.array(z.object({lang:text(20),value:text(100_000)})).max(100).default([]),
 metrics:z.array(recordMetric).max(100).default([]),
});
/**
 * One CVE record of the CVE List (CVE JSON 5), only the fields the check reads;
 * other fields are allowed and dropped. The CNA container holds the vendor's
 * data, the ADP containers enrichments such as the CISA ADP (CPEs, CVSS, KEV).
 */
export const cveRecord=z.object({
 cveMetadata:z.object({cveId:z.string().regex(/^CVE-\d{4}-\d{4,}$/),state:text(40),datePublished:text(40).optional(),dateUpdated:text(40).optional()}),
 containers:z.object({cna:recordContainer.default({affected:[],descriptions:[],metrics:[]}),adp:z.array(recordContainer).max(100).default([])}),
});
export type CveRecord=z.infer<typeof cveRecord>;
/** One page of the CIRCL Vulnerability-Lookup cpesearch with source=cvelistv5; past the last page it is {}. */
export const cveListPage=z.union([z.object({cvelistv5:z.array(cveRecord).max(100)}),z.object({}).strict()]);
export type CveListPage=z.infer<typeof cveListPage>;
/** The records of a page, none past the last page. */
export const cveListRecords=(page:CveListPage):CveRecord[]=>'cvelistv5' in page?page.cvelistv5:[];

/** A name as the matching compares it: NFKC, lower case, trimmed, runs of whitespace as one space. */
const matchName=(value:string|undefined)=>(value??'').normalize('NFKC').toLowerCase().trim().replace(/\s+/g,' ');
/** A CPE vendor or product as a name: unescaped, "_" as a space. */
const cpeName=(value:string)=>matchName(unescape(value).replace(/_/g,' '));
type AffectedEntry=z.infer<typeof affectedEntry>;
/**
 * Whether an affected entry of a record (CNA or ADP) means the catalog
 * product: (a) one of its CPEs is an application CPE of the product's vendor
 * and product with target_sw *, - or windows; (b) it is one of the product's
 * cveNames; (c) its product or vendor + product is one of the product's
 * names, or vendor and product are the CPE's, with a vendor that is empty,
 * n/a or unknown, the CPE vendor, contains one of the publishers, or any
 * vendor when the product has no publishers. An entry with platforms but none
 * that names Windows never matches.
 */
export function affectedMatches(entry:AffectedEntry,product:CatalogProduct):boolean{
 const platforms=entry.platforms??[];
 if(platforms.length&&!platforms.some(item=>item.toLowerCase().includes('windows')))return false;
 const [cpeVendor,cpeProduct]=cpeFields(`cpe:2.3:a:${product.cpe}:*:*:*:*:*:*:*:*`)?.slice(3,5)??[];
 if(!cpeVendor||!cpeProduct)return false;
 if((entry.cpes??[]).some(cpe=>{const fields=cpeFields(cpe.trim().toLowerCase());return !!fields&&fields[2]==='a'&&fields[3]===cpeVendor&&fields[4]===cpeProduct&&(anyValue(fields[10])||fields[10]==='windows');}))return true;
 const vendor=matchName(entry.vendor),name=matchName(entry.product);
 if((product.cveNames??[]).some(pair=>matchName(pair.vendor)===vendor&&matchName(pair.product)===name))return true;
 const catalogVendor=cpeName(cpeVendor),catalogProduct=cpeName(cpeProduct);
 if(vendor===catalogVendor&&name===catalogProduct)return true;
 if(!name||!(product.names.includes(name)||product.names.includes(`${vendor} ${name}`)))return false;
 return vendor===''||vendor==='n/a'||vendor==='unknown'||vendor===catalogVendor||!product.publishers?.length||product.publishers.some(part=>vendor.includes(part));
}

const versionToken=/^v?\d+(?:[._-][0-9A-Za-z]+)*$/;
/** A version token without its leading "v", or null for anything else and for "0". */
function token(value:string|undefined):string|null{
 const trimmed=(value??'').trim();
 if(!versionToken.test(trimmed))return null;
 const version=trimmed.replace(/^v/,'');
 return version==='0'?null:version;
}
const rangeOf=(fields:Partial<VersionRange>):VersionRange=>({exact:null,start:null,startInclusive:false,end:null,endInclusive:false,...fields});
/**
 * The range of a version text without lessThan: a version token (exact), one
 * or two comparisons ("< 25.0.0", ">= 9.11, < 26.01", "= 1.2") with exactly
 * one upper bound or a single "=", or the phrases "<v> and earlier", "<v> and
 * prior" (inclusive end), "before <v>" and "prior to <v>" (exclusive end).
 * Anything else, a lower bound alone included, is null.
 */
function versionTextRange(value:string):VersionRange|null{
 const text=value.trim().replace(/\s+/g,' ');
 const exact=token(text);
 if(exact)return rangeOf({exact});
 const andEarlier=/^(.+?) and (?:earlier|prior)$/i.exec(text);
 if(andEarlier){const end=token(andEarlier[1]);return end?rangeOf({end,endInclusive:true}):null;}
 const before=/^(?:before|prior to) (.+)$/i.exec(text);
 if(before){const end=token(before[1]);return end?rangeOf({end}):null;}
 const parts=text.split(',').map(part=>part.trim());
 if(parts.length>2)return null;
 let range=rangeOf({}),upper=0,lower=0,equal=0;
 for(const part of parts){
  const comparison=/^(<=|>=|<|>|=)\s*(\S+)$/.exec(part);
  if(!comparison||!versionToken.test(comparison[2]))return null;
  const operator=comparison[1],version=comparison[2].replace(/^v/,'');
  if(operator==='<'||operator==='<='){upper++;range={...range,end:version,endInclusive:operator==='<='};}
  else if(operator==='>'||operator==='>='){lower++;if(version!=='0')range={...range,start:version,startInclusive:operator==='>='};}
  else{equal++;range={...range,exact:version};}
 }
 if(equal)return equal===1&&parts.length===1&&range.exact!=='0'?rangeOf({exact:range.exact}):null;
 if(upper!==1||lower>1||range.end==='0')return null;
 return range;
}

/**
 * The ranges of one CVE.org record for one catalog product: the deduplicated
 * ranges of every matching affected entry of the CNA and the ADP containers.
 * Only versions with status "affected" and a versionType other than git count.
 * With lessThan (exclusive) or lessThanOrEqual (inclusive) the end is that
 * version, and the start is the version when it is a version token other than
 * "0" and the end (the Chrome CNA writes version = lessThan). Without them the
 * version text gives the range (versionTextRange). A record that is not
 * PUBLISHED, an entry without version data, a lower bound alone and free text
 * give nothing: the second source never gives a range without a bound or an
 * exact version.
 */
export function rangesFromCveRecord(record:CveRecord,product:CatalogProduct):VersionRange[]{
 if(record.cveMetadata.state!=='PUBLISHED')return [];
 const ranges=new Map<string,VersionRange>();
 for(const container of [record.containers.cna,...record.containers.adp]){
  for(const entry of container.affected){
   if(!affectedMatches(entry,product))continue;
   for(const item of entry.versions??[]){
    if(item.status!=='affected'||item.versionType==='git')continue;
    let range:VersionRange|null;
    if(item.lessThan!==undefined||item.lessThanOrEqual!==undefined){
     const exclusive=token(item.lessThan),end=exclusive??token(item.lessThanOrEqual);
     if(!end)continue;
     const version=token(item.version),start=version!==null&&compareVersions(version,end)!==0?version:null;
     range=rangeOf({start,startInclusive:start!==null,end,endInclusive:exclusive===null});
    }else range=versionTextRange(item.version??'');
    if(range)ranges.set(JSON.stringify(range),range);
   }
  }
 }
 return [...ranges.values()];
}

const recordMetricOrder=['cvssV3_1','cvssV4_0','cvssV3_0','cvssV2_0'] as const;
/**
 * The severity of a CVE.org record: the CNA metrics first, then the ADP
 * metrics, each in the order v3.1, v4.0, v3.0, v2.0. The named severity when
 * it is valid, else the score band, else unknown.
 */
export function cveRecordSeverity(record:CveRecord):{severity:Severity;score:number|null;vector:string|null}{
 for(const container of [record.containers.cna,...record.containers.adp]){
  for(const version of recordMetricOrder){
   const entry=container.metrics.find(item=>item[version])?.[version];
   if(!entry)continue;
   const score=entry.baseScore??null,named=(entry.baseSeverity??'').toLowerCase();
   const severity=severities.includes(named as Severity)?named as Severity:score===null?'unknown':severityOfScore(score);
   return {severity,score,vector:entry.vectorString??null};
  }
 }
 return {severity:'unknown',score:null,vector:null};
}
/** Listed in the CISA catalog of known exploited vulnerabilities: a kev entry in an ADP container. */
export const cveRecordKnownExploited=(record:CveRecord)=>record.containers.adp.some(container=>container.metrics.some(item=>item.other?.type==='kev'));
/** The English CNA description ("en" first, then "en-*"), trimmed, at most 1000 code points. */
export function cveRecordSummary(record:CveRecord):string{
 const list=record.containers.cna.descriptions;
 const entry=list.find(item=>item.lang.toLowerCase()==='en')??list.find(item=>item.lang.toLowerCase().startsWith('en-'));
 return [...(entry?.value.trim()??'')].slice(0,1000).join('');
}
/** The publication of a record (cveMetadata.datePublished) in epoch milliseconds, or null. */
export const cveRecordPublished=(record:CveRecord)=>record.cveMetadata.datePublished?nvdTime(record.cveMetadata.datePublished):null;
/** The last update of a record (cveMetadata.dateUpdated) in epoch milliseconds, or null. */
export const cveRecordUpdated=(record:CveRecord)=>record.cveMetadata.dateUpdated?nvdTime(record.cveMetadata.dateUpdated):null;

// ---- Verdicts -----------------------------------------------------------------

const severityRank:Record<Severity,number>={critical:5,high:4,medium:3,low:2,none:1,unknown:0};
/** Positive when a is more severe than b. */
export const compareSeverity=(a:Severity|null,b:Severity|null)=>(a===null?-1:severityRank[a])-(b===null?-1:severityRank[b]);
const unchecked:Verdict={status:'unchecked',count:0,highest:null,knownExploited:false,fixedIn:null,noFixCount:0};
const clean:Verdict={status:'clean',count:0,highest:null,knownExploited:false,fixedIn:null,noFixCount:0};

/**
 * The verdict of one program version. cves is null when the program is not in
 * the catalog or its product was never synced; a null version is never
 * checked. fixedIn is the highest fixed version of the affecting CVEs when
 * every one of them has a fixed version, else null.
 */
export function productVerdict(cves:readonly ProductCve[]|null,version:string|null):Verdict{
 if(cves===null||version===null)return unchecked;
 let count=0,highest:Severity|null=null,knownExploited=false,fixedIn:string|null=null,noFixCount=0;
 for(const cve of cves){
  const result=cveAffects(cve.ranges,version);
  if(!result.affected)continue;
  count++;
  if(compareSeverity(cve.severity,highest)>0)highest=cve.severity;
  knownExploited||=cve.knownExploited;
  if(result.fixedIn===null)noFixCount++;
  else if(fixedIn===null||compareVersions(result.fixedIn,fixedIn)>0)fixedIn=result.fixedIn;
 }
 if(!count)return clean;
 return {status:'vulnerable',count,highest,knownExploited,fixedIn:noFixCount?null:fixedIn,noFixCount};
}
const statusRank:Record<VerdictStatus,number>={vulnerable:2,clean:1,unchecked:0};
/** Sorts the most urgent verdict first: status, highest severity, known exploited, count. */
export function compareVerdicts(a:Verdict,b:Verdict):number{
 return statusRank[b.status]-statusRank[a.status]||compareSeverity(b.highest,a.highest)||Number(b.knownExploited)-Number(a.knownExploited)||b.count-a.count;
}
/**
 * One number that sorts like compareVerdicts, larger = more urgent, for the Vulnerabilities column
 * (ui/base/table-sort.ts): status, then the highest severity, then known exploited, then the count.
 */
export function verdictSortValue(verdict:Verdict|null|undefined):number{
 const value=verdict??unchecked;
 return statusRank[value.status]*1e6+(value.highest===null?0:severityRank[value.highest]+1)*1e5+(value.knownExploited?1e4:0)+Math.min(value.count,9999);
}
/** The pill kind of a severity: critical and high are critical, medium a warning, the rest neutral. */
export const severityPill=(severity:Severity|null):'critical'|'warning'|'neutral'=>severity==='critical'||severity==='high'?'critical':severity==='medium'?'warning':'neutral';
/** The link of a CVE in the NVD. */
export const nvdCveUrl=(id:string)=>`https://nvd.nist.gov/vuln/detail/${encodeURIComponent(id)}`;
/** The link of a CVE record on CVE.org. */
export const cveOrgUrl=(id:string)=>`https://www.cve.org/CVERecord?id=${encodeURIComponent(id)}`;

// ---- CVE detail ---------------------------------------------------------------

/** One CVE of the detail of a program version (GET /api/software/vulnerabilities). */
export type VulnerabilityCve={id:string;severity:Severity;score:number|null;vector:string|null;knownExploited:boolean;published:number|null;summary:string;fixedIn:string|null;source:VulnerabilitySource};
export type SoftwareVulnerabilityDetail={product:{id:string;label:string;cpe:string};verdict:Verdict;cves:VulnerabilityCve[];total:number};

/** Severity, then known exploited, then score, then the newest. */
export function compareCves(a:VulnerabilityCve,b:VulnerabilityCve):number{
 return compareSeverity(b.severity,a.severity)||Number(b.knownExploited)-Number(a.knownExploited)||(b.score??-1)-(a.score??-1)||(b.published??0)-(a.published??0)||(a.id<b.id?-1:a.id>b.id?1:0);
}
