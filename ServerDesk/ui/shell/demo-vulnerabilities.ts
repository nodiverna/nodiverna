// Sample data of the vulnerability check for the sample devices
// (docs/software-vulnerabilities.md), served in the browser: the check and the
// CVE.org source are on and their last run finished one hour ago. The CVEs
// follow their NVD entries, and CVE-2026-121131 its CVE.org record (the NVD
// had not analysed it yet); the sample keeps only the ranges that matter for
// the sample versions. The sample devices then show critical programs with
// a known exploited CVE (Google Chrome 109 and 120), a high one (7-Zip 23.01),
// a medium one (Microsoft Edge 130), a clean one (Notepad++) and programs
// outside the catalog that are not checked.
import {catalogProductFor,compareCves,cveAffects,productVerdict,type ProductCve,type Severity,type SoftwareVulnerabilityDetail,type Verdict,type VersionRange,type VulnerabilitySource} from '@/lib/software-vulnerabilities';

const hour=3_600_000;
type SampleCve={id:string;product:string;severity:Severity;score:number;vector:string;knownExploited:boolean;published:string;summary:string;fixedIn:string;source?:VulnerabilitySource};
const below=(fixedIn:string):VersionRange=>({exact:null,start:null,startInclusive:false,end:fixedIn,endInclusive:false});
const sampleCves:SampleCve[]=[
 {id:'CVE-2023-2136',product:'google-chrome',severity:'critical',score:9.6,vector:'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:H',knownExploited:true,published:'2023-04-19',fixedIn:'112.0.5615.137',
  summary:'Integer overflow in Skia in Google Chrome prior to 112.0.5615.137 allowed a remote attacker who had compromised the renderer process to potentially perform a sandbox escape via a crafted HTML page.'},
 {id:'CVE-2024-0519',product:'google-chrome',severity:'high',score:8.8,vector:'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H',knownExploited:true,published:'2024-01-16',fixedIn:'120.0.6099.224',
  summary:'Out of bounds memory access in V8 in Google Chrome prior to 120.0.6099.224 allowed a remote attacker to potentially exploit heap corruption via a crafted HTML page.'},
 // From its CVE.org record (CNA Chrome, CVSS of the CISA ADP).
 {id:'CVE-2026-121131',product:'google-chrome',severity:'critical',score:9.6,vector:'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:H',knownExploited:false,published:'2026-11-03',fixedIn:'157.0.8103.38',source:'cvelist',
  summary:'Use after free in Mobile in Google Chrome prior to 157.0.8103.38 allowed a remote attacker leveraging social engineering to execute arbitrary code outside the sandbox via a crafted Chrome extension. (Chromium security severity: High)'},
 {id:'CVE-2025-0411',product:'7-zip',severity:'high',score:7.0,vector:'CVSS:3.0/AV:L/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:H',knownExploited:true,published:'2025-01-25',fixedIn:'24.09',
  summary:'7-Zip Mark-of-the-Web Bypass Vulnerability. When extracting files from a crafted archive, 7-Zip does not propagate the Mark-of-the-Web to the extracted files.'},
 {id:'CVE-2024-11477',product:'7-zip',severity:'high',score:7.8,vector:'CVSS:3.0/AV:L/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H',knownExploited:false,published:'2024-11-22',fixedIn:'24.07',
  summary:'7-Zip Zstandard Decompression Integer Underflow Remote Code Execution Vulnerability. User interaction is required: the target must open a crafted archive.'},
 {id:'CVE-2024-49054',product:'microsoft-edge',severity:'medium',score:4.3,vector:'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:N',knownExploited:false,published:'2024-11-14',fixedIn:'131.0.2903.48',
  summary:'Microsoft Edge (Chromium-based) Spoofing Vulnerability.'},
];
const sourceOf=(cve:SampleCve)=>cve.source??'nvd';
const productCves=(productId:string):ProductCve[]=>sampleCves.filter(cve=>cve.product===productId).map(cve=>({id:cve.id,severity:cve.severity,score:cve.score,knownExploited:cve.knownExploited,ranges:[below(cve.fixedIn)],source:sourceOf(cve)}));

/** The verdict of a sample program: every catalog product counts as synced, and the CVE.org source is on. */
export function demoVerdict(normalizedName:string,normalizedVersion:string|null,publisher:string|null):Verdict{
 const product=catalogProductFor(normalizedName,publisher);
 return productVerdict(product?productCves(product.id):null,normalizedVersion);
}
/** The CVE detail of a sample program, or null outside the catalog. */
export function demoVulnerabilityDetail(normalizedName:string,normalizedVersion:string,publisher:string|null):SoftwareVulnerabilityDetail|null{
 const product=catalogProductFor(normalizedName,publisher);
 if(!product)return null;
 const cves=sampleCves.filter(cve=>cve.product===product.id&&cveAffects([below(cve.fixedIn)],normalizedVersion).affected)
  .map(cve=>({id:cve.id,severity:cve.severity,score:cve.score,vector:cve.vector,knownExploited:cve.knownExploited,published:Date.parse(cve.published+'T00:00:00Z'),summary:cve.summary,fixedIn:cve.fixedIn,source:sourceOf(cve)})).sort(compareCves);
 return {product:{id:product.id,label:product.label,cpe:product.cpe},verdict:demoVerdict(normalizedName,normalizedVersion,publisher),cves,total:cves.length};
}
/** The status of the check on the sample devices: on, last success one hour ago. */
export const demoVulnerabilityStatus=(time:number)=>({enabled:true,lastSuccessAt:time-hour});
