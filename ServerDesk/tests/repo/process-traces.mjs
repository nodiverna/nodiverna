// The product repository carries no traces of the internal build process:
// no job numbers, no acceptance criterion IDs, no paths into the build tooling,
// no spec files, no MSP slice markers and no internal audit IDs. Code, tests,
// comments and docs state the behavior or the rule instead. The scan covers
// ServerDesk/, README.md, CONTRIBUTING.md and .github/ as git lists them,
// including untracked files that are not ignored. Migrations in
// ServerDesk/drizzle/ and binary files are not scanned. Every pattern is built
// from parts, so this file does not match itself.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {repositoryRoot} from '../support/paths.mjs';

const repository=repositoryRoot;
let checks=0;

// 1. The patterns.
const patterns=[
 new RegExp('\\bjob'+'s?\\s+#?\\d+','i'),
 new RegExp('\\bAC'+'-\\d+'),
 new RegExp('factory'+'/'),
 new RegExp('spec'+'\\.md'),
 new RegExp('\\bMSP'+' \\d+/\\d+'),
 new RegExp('\\bSEC'+'-\\d+'),
];
const matches=line=>patterns.flatMap(pattern=>{const found=line.match(pattern);return found?[found[0]]:[];});

// 2. The matcher flags the traces and leaves ordinary words alone.
const flagged=[['see job','066'].join(' '),['(Job','61)'].join(' '),['jobs','055'].join(' '),['AC','14'].join('-'),['factory','jobs','x'].join('/'),['spec','md'].join('.'),['MSP','6/8'].join(' '),['SEC','05'].join('-')];
for(const sample of flagged){assert.ok(matches(sample).length>0,`the matcher flags "${sample}"`);checks++;}
const ignored=['job-1','jobs','cancel-job','a factory function','readme.spec.ts','items.slice(1)','AC power'];
for(const sample of ignored){assert.deepEqual(matches(sample),[],`the matcher ignores "${sample}"`);checks++;}

// 3. The scope: git lists tracked and untracked, not ignored files. Without git,
// the same paths are walked and the usual build output and AI files are skipped.
const roots=['ServerDesk','README.md','CONTRIBUTING.md','.github'];
const excluded=name=>name.startsWith('ServerDesk/drizzle/');
function listed(){
 const result=spawnSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--',...roots],{cwd:repository,encoding:'utf8',maxBuffer:64*1024*1024});
 if(result.status===0&&!result.error)return result.stdout.split('\0').filter(Boolean);
 console.log('git ls-files is not available, so the scan walks the paths instead.');
 const skipped=new Set(['node_modules','.next','drizzle','bin','obj','CLAUDE.md','AGENTS.md','GEMINI.md','copilot-instructions.md']);
 // Local caches and build output that ServerDesk/.gitignore lists; the pnpm
 // store alone holds tens of thousands of files.
 const local=new Set(['.build','.vinext','.data','coverage','test-results','out','dist','outputs','work','certificates','e2e/.auth','e2e/artifacts'].map(name=>'ServerDesk/'+name));
 const files=[];
 const walk=relative=>{
  const full=path.join(repository,relative);
  if(!fs.existsSync(full))return;
  if(!fs.statSync(full).isDirectory()){files.push(relative);return;}
  for(const entry of fs.readdirSync(full,{withFileTypes:true})){
   const next=relative+'/'+entry.name;
   if(!skipped.has(entry.name)&&!local.has(next)&&!/^\.env(?!\.example$)/.test(entry.name))walk(next);
  }
 };
 for(const name of roots)walk(name);
 return files;
}
const files=[...new Set(listed().map(name=>name.replaceAll('\\','/')))].filter(name=>!excluded(name)).sort();

// The scan sees the tree, so an empty list cannot pass.
for(const name of ['ServerDesk/scripts/test.mjs','README.md']){assert.ok(files.includes(name),`the scan covers ${name}`);checks++;}
assert.ok(files.some(name=>/^\.github\/workflows\/[^/]+\.ya?ml$/.test(name)),'the scan covers at least one .github/workflows/*.yml');checks++;
assert.ok(files.includes('ServerDesk/tests/repo/process-traces.mjs'),'the scan covers this file');checks++;

// 4. No scanned text file carries a trace.
function isBinary(file){
 const handle=fs.openSync(file,'r');
 try{const buffer=Buffer.alloc(8000);return buffer.subarray(0,fs.readSync(handle,buffer,0,buffer.length,0)).includes(0);}
 finally{fs.closeSync(handle);}
}
const hits=[];
let scanned=0;
for(const name of files){
 const file=path.join(repository,name);
 if(!fs.existsSync(file)||!fs.statSync(file).isFile()||isBinary(file))continue;
 scanned++;
 fs.readFileSync(file,'utf8').split(/\r?\n/).forEach((line,index)=>{for(const found of matches(line))hits.push({name,line:index+1,found});});
}
// Sorted by path, then by line number.
const report=hits.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:a.line-b.line).map(hit=>`${hit.name}:${hit.line}: ${hit.found}`);
assert.deepEqual(report,[],`Process traces found. Reword each place so it states the behavior or the rule:\n${report.join('\n')}`);checks++;

console.log(`PASS process traces (${checks} assertions): ${scanned} text files under ServerDesk/, README.md, CONTRIBUTING.md and .github/ carry no job number, criterion ID, tooling path, spec file, slice marker or audit ID.`);
