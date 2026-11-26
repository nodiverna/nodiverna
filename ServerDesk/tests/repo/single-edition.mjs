// One edition: no file that git lists names the former split repository, the
// license gate, the edition modes, the former activation or a commercial
// version. The scan reads every file of `git ls-files` in the repository. It
// leaves out:
// - the released migrations drizzle/0000–0037 with drizzle/meta, and migration
//   0038, which drops the license table and has to name it;
// - tests/fixtures/nvd-cves.json (third-party CVE data);
// - the verbatim third-party license texts (the root LICENSE and
//   agent/v3/THIRD-PARTY-NOTICES.txt, which use the word "commercial");
// - this file.
// The guard has a self-test: an injected text with a forbidden string fails it.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {repositoryRoot} from '../support/paths.mjs';

const repo=repositoryRoot;
// The forbidden strings. Case-sensitive, except those of `anyCase`.
export const forbidden=[
 '@msp','msp/','msp-absent','msp-host','msp-activation','mspActivated','.msp-git','ServerDesk/msp',
 'edition_license','editionLicense','server/edition','edition-messages','use-edition','useEdition','EditionStatus','EditionView','CustomersEdition',
 'MSP_NOT_ACTIVE','MSP_READ_ONLY','apiError.edition.','apiError.msp.','SERVERDESK_TEST_NO_MSP','check:community','community-check',
 'Community Edition','MSP mode','MSP-Modus','MSP License','MSP license','MSP image','nodiverna-msp','LicenseRef-ServerDesk-MSP','PROJECT OWNER NAME',
 'MSP activ','MSP repository','msp-license',
];
export const anyCase=['license key','Lizenzschlüssel','private repository','commercial','first activation',
 'license expires','license or the edition','both editions','every edition','edition check',"../edition'"];
// Short spellings of the former edition that need word bounds: "the CE", "with MSP", "MSP on", "(MSP)".
export const patterns=[/\bCE\b/,/\b(?:with|without|under) MSP\b/,/\bMSP (?:on|case|boundary|catalog)\b/,/\(MSP\)/];
const exempt=file=>/^ServerDesk\/drizzle\/00(?:[0-2]\d|3[0-8])_[^/]+\.sql$/.test(file)||file.startsWith('ServerDesk/drizzle/meta/')
 ||file==='ServerDesk/tests/fixtures/nvd-cves.json'||file==='LICENSE'||file==='ServerDesk/agent/v3/THIRD-PARTY-NOTICES.txt'
 ||file==='ServerDesk/tests/repo/single-edition.mjs';

/** The forbidden strings in `text` of `file`, as "file:line: string"; `patterns:false` skips the short patterns. */
export function findings(file,text,{patterns:withPatterns=true}={}){
 const found=[];
 text.split(/\r?\n/).forEach((line,index)=>{
  const lower=line.toLowerCase();
  for(const needle of forbidden)if(line.includes(needle))found.push(`${file}:${index+1}: ${needle}`);
  for(const needle of anyCase)if(lower.includes(needle.toLowerCase()))found.push(`${file}:${index+1}: ${needle}`);
  if(withPatterns)for(const pattern of patterns)if(pattern.test(line))found.push(`${file}:${index+1}: ${pattern.source}`);
 });
 return found;
}

// Self-test: an injected text with "@msp" fails, a clean text passes, the
// paths of the former split repository fail in every file (also in
// .gitignore), and the exemptions are exact.
assert.deepEqual(findings('ServerDesk/lib/x.ts',"import msp from '@msp';"),['ServerDesk/lib/x.ts:1: @msp'],'an injected @msp fails the guard');
assert.deepEqual(findings('ServerDesk/lib/x.ts','const a=1;\nexport {a};'),[],'a clean text passes');
assert.deepEqual(findings('README.md','A COMMERCIAL version.'),['README.md:1: commercial'],'the anyCase words count in any case');
assert.deepEqual(['after the license expires','checks the License or the Edition','the same in both editions','In every edition','No edition check',"'../edition':{}"].map(text=>findings('x.md',text).length),[1,1,1,1,1,1],'the former license and edition wording fails the guard');
assert.deepEqual(findings('ServerDesk/tests/x.mjs','// Before the First Activation, after the MSP activation.'),['ServerDesk/tests/x.mjs:1: MSP activ','ServerDesk/tests/x.mjs:1: first activation'],'the former activation fails the guard');
assert.deepEqual(['// with the CE','no column without MSP','even with MSP on','**Installer (MSP).**','the MSP repository'].map(text=>findings('x.md',text).length),[1,1,2,1,1],'the short spellings fail the guard');
assert.deepEqual(['the MSP library','portal.msp.crossCustomer','CERT','ACE','with MSPs'].map(text=>findings('x.md',text).length),[0,0,0,0,0],'the kept names and similar words pass');
assert.deepEqual([findings('x.png','\0 CE',{patterns:false}),findings('x.png','\0 MSP mode',{patterns:false}).length],[[],1],'a binary file gets the strings, not the short patterns');
assert.deepEqual(findings('.gitignore','/.msp-git/'),['.gitignore:1: .msp-git'],'a .gitignore line for .msp-git fails the guard');
assert.ok(findings('.gitignore','/ServerDesk/msp/').includes('.gitignore:1: ServerDesk/msp'),'a .gitignore line for ServerDesk/msp fails the guard');
assert.ok(findings('README.md','git --git-dir=.msp-git log').length>=1,'a command on the former split repository fails the guard');
assert.ok(exempt('ServerDesk/drizzle/0034_entra_kept_owner.sql')&&exempt('ServerDesk/drizzle/0038_x.sql')&&!exempt('ServerDesk/drizzle/0039_x.sql')&&!exempt('ServerDesk/drizzle/schema.lock.sql'),'only the migrations up to 0038 are exempt');

const files=execFileSync('git',['ls-files','-z'],{cwd:repo,encoding:'utf8',maxBuffer:64*1024*1024}).split('\0').filter(Boolean).map(name=>name.replaceAll('\\','/'));
assert.ok(files.length>500,'the scan reads the tracked files');
const hits=files.filter(file=>!exempt(file)).flatMap(file=>{
 let text;try{text=readFileSync(path.join(repo,file),'utf8');}catch{return [];}
 // Binary files (images) get the strings only: the short patterns match random bytes.
 return findings(file,text,{patterns:!text.includes('\0')});
});
assert.deepEqual(hits,[],'no tracked file names the former split repository, the license gate or a commercial version');
console.log(`PASS single edition: ${files.length} tracked files, no forbidden string.`);
