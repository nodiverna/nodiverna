// Bounded drift ingest: the compiled policy matcher and the linear
// rename detection keep the former results, globs never backtrack, a stored
// scan is answered before any validation and each device gets at most one new
// report per 30 seconds. Actual lib/server/automation/drift.ts against a PostgreSQL test database.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import ts from 'typescript';
import {sql} from '../../runtime/database.mjs';

import {sourceDatabase} from '../support/source-database.mjs';
import {budgeted,budgetText} from '../support/load-budget.mjs';
const require=createRequire(import.meta.url),d=await sourceDatabase(),cache=new Map(),root=process.cwd(),uuid=()=>crypto.randomUUID();
let clock=Date.now(),checks=0;const timings={};
const HttpError=realHttpError;
const server={db:()=>d,now:()=>clock,guid:value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value),HttpError,log:async()=>{}};
const unused=()=>{throw new Error('Not used by this test.');};
const mocks=new Map([
 ['lib/server/context.ts',server],
 ['lib/server/identity/access.ts',{customerAccessGuard:unused,requireDevice:unused,principal:unused,devicePermissionGuard:unused}],
 ['lib/server/identity/feature-authorization.ts',{featureWriteGuard:unused}]
]);
function load(filename){const absolute=path.resolve(filename),relative=path.relative(root,absolute).replaceAll('\\','/');if(mocks.has(relative))return mocks.get(relative);if(cache.has(absolute))return cache.get(absolute).exports;const mod={exports:{}};cache.set(absolute,mod);const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;new Function('require','module','exports',code)(id=>{if(id.startsWith('.')){const base=path.resolve(path.dirname(absolute),id),file=[base,base+'.ts',base+'.tsx'].find(name=>fs.existsSync(name)&&fs.statSync(name).isFile());if(file)return /[.]m?js$/.test(file)?require(file):load(file);}return require(id);},mod,mod.exports);return mod.exports;}
const drift=load('lib/server/automation/drift.ts');

// ---- Reference copies of the former, unbounded implementation ----
const refNorm=s=>s.replace(/\//g,'\\').replace(/\\+$/,'').toLowerCase();
function refMatchGlob(path,pattern){const regex=pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.');return new RegExp('^'+regex+'$','i').test(path)||new RegExp('^'+regex+'$','i').test(path.split('\\').at(-1)??'');}
function refAllowedPath(policy,e){
 if(e.kind==='config')return policy.config.some(c=>{const category=c.toLowerCase(),key=e.key.toLowerCase(),path=e.path.toLowerCase().replace(/\\/g,'/');return key===`config:${category}`&&path===category||key.startsWith(`config:${category}:`)&&path.startsWith(category+'/');});
 if(e.kind==='registry')return policy.registry.some(r=>refNorm(e.path)===refNorm(r.path)&&(!r.names.length||r.names.includes(''))||refNorm(e.path).startsWith(refNorm(r.path)+'\\')&&(!r.names.length||r.names.some(name=>refNorm(e.path)===refNorm(r.path)+'\\'+name.toLowerCase())));
 const path=refNorm(e.path);return policy.paths.some(p=>path===refNorm(p.path)||path.startsWith(refNorm(p.path)+'\\')&&(p.recursive||!path.slice(refNorm(p.path).length+1).includes('\\')))&&!policy.excludes.some(exclude=>refMatchGlob(e.path,exclude)||policy.paths.some(p=>path.startsWith(refNorm(p.path)+'\\')&&refMatchGlob(e.path.slice(p.path.replace(/\\+$/,'').length+1),exclude)));
}
function refMayKeepText(policy,e){
 if(e.kind==='config')return policy.includeConfigValues&&refAllowedPath(policy,e);if(e.kind==='registry')return policy.registry.some(r=>r.includeValues&&(refNorm(e.path)===refNorm(r.path)||refNorm(e.path).startsWith(refNorm(r.path)+'\\')));if(e.kind!=='file')return false;const path=refNorm(e.path);if(/^c:\\programdata\\serverdesk(?:\\|$)/.test(path))return false;
 return policy.paths.some(p=>p.includeText&&(path===refNorm(p.path)||path.startsWith(refNorm(p.path)+'\\'))&&(!p.extensions.length||p.extensions.some(ext=>path.endsWith(ext.toLowerCase()))));
}
function refCompactEntry(e){const metadata={...e};delete metadata.text;return metadata;}
function refDiffEntries(baseline,current){
 const before=new Map(baseline.map(e=>[e.key,e])),after=new Map(current.map(e=>[e.key,e])),changes=[],removed=[],added=[];
 for(const e of baseline){const n=after.get(e.key);if(!n){removed.push(e);continue;}if(e.hash!==n.hash||e.size!==n.size||e.modifiedAt!==n.modifiedAt){changes.push({key:e.key,path:n.path,kind:n.kind,change:'modified',before:refCompactEntry(e),after:refCompactEntry(n),...(e.text!==undefined&&n.text!==undefined&&e.text!==n.text?{textDiff:drift.textChanges(e.text,n.text)}:{})});}}
 for(const e of current)if(!before.has(e.key))added.push(e);
 const used=new Set();for(const old of removed){const matches=added.filter(e=>e.kind==='file'&&old.kind==='file'&&e.hash===old.hash&&!used.has(e.key));const oldMatches=removed.filter(e=>e.hash===old.hash&&e.kind==='file');if(matches.length===1&&oldMatches.length===1){const n=matches[0];used.add(n.key);changes.push({key:n.key,path:n.path,oldPath:old.path,kind:n.kind,change:'renamed',before:refCompactEntry(old),after:refCompactEntry(n)});}else changes.push({key:old.key,path:old.path,kind:old.kind,change:'removed',before:refCompactEntry(old)});}
 for(const e of added)if(!used.has(e.key))changes.push({key:e.key,path:e.path,kind:e.kind,change:'added',after:refCompactEntry(e)});return changes;
}

// Deterministic PRNG (mulberry32); no Math.random, so failures reproduce.
function prng(seed){let a=seed>>>0;return ()=>{a=a+0x6D2B79F5>>>0;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}
const rand=prng(63);const pick=list=>list[Math.floor(rand()*list.length)];const subset=(list,max=list.length)=>list.filter(()=>rand()<max/list.length/2);
const policyOf=overrides=>({config:[],registry:[],paths:[],excludes:[],includeConfigValues:false,...overrides});
const pathRule=(path,extra={})=>({path,recursive:true,includeText:false,extensions:[],...extra});
const file=(path,extra={})=>({key:'file:'+path.toLowerCase(),kind:'file',path,hash:'a'.repeat(64),...extra});
function same(policy,entry,label){const matcher=drift.compileDriftPolicy(policy);assert.equal(matcher.allowed(entry),refAllowedPath(policy,entry),'allowed: '+label+' '+JSON.stringify({policy,entry}));assert.equal(matcher.mayKeepText(entry),refMayKeepText(policy,entry),'mayKeepText: '+label+' '+JSON.stringify({policy,entry}));checks++;}

// ---- Same semantics, fixed edge cases ----
{
 const files=policyOf({paths:[pathRule('C:\\Data'),pathRule('C:\\Flat\\',{recursive:false,includeText:true,extensions:['.TXT','.cfg']}),pathRule('C:/Slash',{includeText:true})],excludes:['*.log','?.tmp','a+b(1)[x]$^{y}|z.txt','Sub\\*.cfg','*\\deep\\*','.*','FILE.TXT','x.y']});
 for(const p of ['C:\\Data','C:\\Data\\','C:\\data\\a.txt','C:/Data/a.txt','C:\\Data\\x.LOG','C:\\Data\\1.tmp','C:\\Data\\12.tmp','C:\\Data\\a+b(1)[x]$^{y}|z.txt','C:\\Data\\a+b(1)[x]$^{y}|z.TXT','C:\\Data\\aab(1)x$^{y}|z.txt','C:\\Data\\Sub\\a.cfg','C:\\Data\\sub\\a.CFG','C:\\Data\\Other\\Sub\\a.cfg','C:\\Data\\deep\\a.txt','C:\\Data\\x\\deep\\a.txt','C:\\Data\\.hidden','C:\\Data\\file.txt','C:\\Data\\xzy','C:\\Data\\x.y','C:\\Database\\a.txt','C:\\Flat','C:\\Flat\\a.txt','C:\\Flat\\a.TXT','C:\\Flat\\a.md','C:\\Flat\\b\\a.txt','C:\\flat\\a.cfg','C:\\Slash\\a.md','C:/Slash/x/y.md','C:\\Slash','C:\\Other\\a.txt','C:\\Data\\ä.txt','C:\\Data\\K.log','C:\\Data\\ſ.tmp'])
  for(const kind of ['file','directory'])same(files,{...file(p),kind,text:'x'},'files '+kind+' '+p);
 const nested=policyOf({paths:[pathRule('C:\\Data'),pathRule('C:\\Data\\Sub\\\\',{recursive:false})],excludes:['Sub\\x*','a.txt']});
 for(const p of ['C:\\Data\\Sub\\x1','C:\\Data\\Sub\\y','C:\\Data\\Sub\\deep\\x','C:\\Data\\Sub\\a.txt','C:\\Data\\Sub'])same(nested,file(p),'nested '+p);
 const program=policyOf({paths:[pathRule('C:\\ProgramData',{includeText:true})]});
 for(const p of ['C:\\ProgramData\\ServerDesk','C:\\ProgramData\\serverdesk\\agent.json','C:\\ProgramData\\ServerDeskX\\a.txt','C:\\ProgramData\\Other\\a.txt'])same(program,file(p,{text:'x'}),'programdata '+p);
 const registry=policyOf({registry:[{path:'HKLM\\Software\\A',names:[],includeValues:true},{path:'HKLM\\Software\\B\\',names:['X','Y\\Z'],includeValues:false},{path:'hklm/software/c',names:[''],includeValues:true},{path:'HKLM\\Software\\D',names:['','N'],includeValues:false}]});
 for(const p of ['HKLM\\Software\\A','hklm\\software\\a\\x','HKLM\\Software\\AB','HKLM\\Software\\B','HKLM\\Software\\B\\x','HKLM\\Software\\B\\Y\\z','HKLM\\Software\\B\\Q','HKLM\\Software\\C','HKLM\\Software\\C\\x','HKLM/Software/C/','HKLM\\Software\\D','HKLM\\Software\\D\\n','HKLM\\Software\\D\\m','HKCU\\Software\\A'])same(registry,{key:'registry:'+p,kind:'registry',path:p,hash:'a'.repeat(64),text:'v'},'registry '+p);
 for(const includeConfigValues of [false,true]){const config=policyOf({config:['services','localGroups'],includeConfigValues});for(const [key,p] of [['config:services','services'],['config:Services','SERVICES'],['config:services:spooler','services/spooler'],['config:services:spooler','services\\spooler'],['config:services:x','roles/x'],['config:roles','roles'],['config:localgroups:admins','localGroups/admins'],['config:services','services/x']])same(config,{key,kind:'config',path:p,hash:'a'.repeat(64),text:'v'},'config '+key+' '+p);}
}

// ---- Same semantics, generated combinations ----
{
 const filePaths=['C:\\Data','C:\\data\\','C:/Data','C:\\Data\\\\','C:\\Dat','C:\\Data\\Sub','C:\\Other','C:\\ProgramData\\ServerDesk','C:\\ProgramData'];
 const segments=['a.txt','A.TXT','x.log','a+b(1)[x]$^{y}|z.txt','Sub','sub','file.txt','b.cfg','ä.txt','Ä.TXT','ß.txt','K.txt','ı.txt','x.tmp','.hidden','a.b.c','deep','1.tmp','?','*'];
 const excludes=['*a*?.t*t','*\\?ub\\*','*.*.*','*A*.TXT','*.log','*.TMP','?.txt','?.tmp','a+b(1)[x]$^{y}|z.txt','*\\Sub\\*','Sub\\*.cfg','sub\\*','*','**','*a*b?','file.txt','FILE.TXT','*.[t]xt','.*','^x$','{a}','a|b','ä*','*ẞ*','K*','*\\deep\\*','C:\\Data\\*.txt','c:\\data\\sub\\*','*.b.c','x?log','\\*','*\\'];
 const registryPaths=['HKLM\\Software\\A','HKLM\\Software\\A\\','hklm/software/a','HKLM\\Software\\AB','HKCU\\Software\\A'],names=['','X','x','Y\\Z','N.1','n+2'];
 for(let round=0;round<400;round++){
  const policy=policyOf({config:subset(['services','roles','network','firewall','localGroups','tasks']),includeConfigValues:rand()<.5,
   registry:Array.from({length:Math.floor(rand()*3)},()=>({path:pick(registryPaths),names:subset(names,2),includeValues:rand()<.5})),
   paths:Array.from({length:Math.floor(rand()*4)},()=>pathRule(pick(filePaths),{recursive:rand()<.6,includeText:rand()<.6,extensions:subset(['.txt','.TXT','.cfg','.log'],1)})),
   excludes:subset(excludes,4)});
  const matcher=drift.compileDriftPolicy(policy);
  for(let n=0;n<25;n++){
   const kind=pick(['file','file','file','directory','registry','config']);let entry;
   if(kind==='registry'){const p=pick(registryPaths)+(rand()<.6?'\\'+pick(names):'')+(rand()<.2?'\\':'');entry={key:'registry:'+p,kind,path:p,hash:'a'.repeat(64)};}
   else if(kind==='config'){const category=pick(['services','Services','roles','localgroups','localGroups','tasks','other']),item=rand()<.5?'':pick(['x','y\\z']),sep=pick(['/','\\']);entry={key:'config:'+category+(item?':'+item:''),kind,path:pick([category,category.toUpperCase()])+(item?sep+item:''),hash:'a'.repeat(64)};}
   else{const parts=[pick(filePaths)];for(let s=Math.floor(rand()*4);s>0;s--)parts.push(pick(segments));const p=parts.join(rand()<.8?'\\':'/')+(rand()<.1?'\\':'');entry={key:'file:'+p,kind,path:p,hash:'a'.repeat(64)};}
   if(rand()<.5)entry.text='x';
   assert.equal(matcher.allowed(entry),refAllowedPath(policy,entry),'generated allowed '+JSON.stringify({policy,entry}));
   assert.equal(matcher.mayKeepText(entry),refMayKeepText(policy,entry),'generated mayKeepText '+JSON.stringify({policy,entry}));checks++;
  }
 }
}

// CPU-bound spans against a reference of linear work on the same machine: the
// reference runs right before each span, three times each, and the run with
// the smallest ratio counts, so one stall does not decide. `stop()` turns true
// once the span exceeds the limit, so a far too slow matcher fails fast.
const linearPasses=(path,entries,excludes)=>{let sum=0;for(let i=0;i<entries;i++)for(let j=1;j<=excludes;j++)for(let k=0;k<path.length;k++)sum=(sum+path.charCodeAt(k)*j)|0;return sum;};
// The bounded matcher measures about 5 (3.7 to 5.0) on a Windows development
// machine and in a Linux container, also with every core busy; the former
// regular-expression matcher measures about 42, a backtracking glob matcher
// reaches the limit.
const nestedRatioLimit=20;
function linearRatio(reference,span,limit=nestedRatioLimit){
 let best={ratio:Infinity};
 for(let run=0;run<3;run++){
  let start=performance.now();const sink=reference();const referenceMs=Math.max(performance.now()-start,0.5);assert.equal(typeof sink,'number');
  start=performance.now();span(()=>performance.now()-start>referenceMs*limit);const ms=performance.now()-start;
  if(ms/referenceMs<best.ratio)best={ratio:ms/referenceMs,ms,referenceMs};
 }
 return best;
}
const linearRatioText=({ratio,ms,referenceMs})=>`${Math.round(ms)} ms, ${ratio.toFixed(1)} × the linear reference of ${referenceMs.toFixed(1)} ms (limit ${nestedRatioLimit} ×)`;

// ---- No backtracking, directly at the matcher ----
{
 const long='C:\\D\\'+'a'.repeat(1000);
 for(const pattern of ['*a*a*a*a*a*a*a*a*b','*a*a*a*a*a*a*a*a*b*']){const matcher=drift.compileDriftPolicy(policyOf({paths:[pathRule('C:\\D')],excludes:[pattern]}));const start=performance.now(),allowed=matcher.allowed(file(long));const ms=performance.now()-start;assert.equal(allowed,true,'pattern without b never matches');assert.ok(ms<50,`${pattern} took ${ms.toFixed(1)} ms`);checks++;}
 const matcher=drift.compileDriftPolicy(policyOf({paths:[pathRule('C:\\D')],excludes:['*a*a*a*a*a*a*a*a*a']}));assert.equal(matcher.allowed(file(long)),false,'a matching multi-star exclude still excludes');
 // `*` and `?` never cross a line terminator, like the former `.`.
 for(const p of ['C:\\D\\a\nb.txt','C:\\D\\a\rb','C:\\D\\x\u2028y.log','C:\\D\\a\nb\\a.b','C:\\D\\ab\nab'])for(const exclude of ['a*b.txt','a?b','*.log','x*','*y*','a\n*','*a*b*','*\n*','*?\n?*','a*?*b','*b*b','*a?b*','*\nab','?*\\*?'])same(policyOf({paths:[pathRule('C:\\D')],excludes:[exclude]}),file(p),'line terminator');
 // A long literal between two `*` is found with one leftmost
 // search per part, so 1 000 tests against 1 024-character paths stay fast.
 const literal='*'+'A'.repeat(247)+'B*',path1024='C:\\D\\'+'A'.repeat(1019),literalMatcher=drift.compileDriftPolicy(policyOf({paths:[pathRule('C:\\D')],excludes:[literal]}));
 assert.equal(path1024.length,1024);
 let start=performance.now();for(let i=0;i<1000;i++)assert.equal(literalMatcher.allowed(file(path1024)),true,'no B, no match');let ms=performance.now()-start;
 assert.ok(ms<250,`1 000 × *A…AB* against 1 024 characters took ${ms.toFixed(0)} ms`);timings.literal=Math.round(ms);
 assert.equal(literalMatcher.allowed(file('C:\\D\\'+'A'.repeat(1018)+'B')),false,'the same exclude still matches when B follows');
 assert.equal(literalMatcher.allowed(file('C:\\D\\x'+'A'.repeat(247)+'By')),false,'and in the middle of a name');
 const wildMatcher=drift.compileDriftPolicy(policyOf({paths:[pathRule('C:\\D')],excludes:['*'+'A'.repeat(119)+'?B*']}));
 start=performance.now();for(let i=0;i<100;i++)assert.equal(wildMatcher.allowed(file(path1024)),true);ms=performance.now()-start;
 assert.ok(ms<250,`100 × a 120-character part with ? took ${ms.toFixed(0)} ms`);checks++;
}

// ---- Nested candidates, long `?` parts, line breaks ----
{
 // Small alphabets force many overlapping matches; nested policy paths give
 // each entry several relative candidates that share one memo.
 const nested=Array.from({length:6},(_,i)=>'C:\\D'+'\\a'.repeat(i));
 const pathChars=['a','a','b','A','\\','\\','\n','?','*','ä','Ä','\u2028','ſ'],patternChars=['a','b','A','\\','?','?','*','*','\n','ä','\u2028','S'];
 for(let round=0;round<600;round++){
  const excludes=Array.from({length:1+Math.floor(rand()*3)},()=>{let pattern='';for(let i=Math.floor(rand()*9)+1;i>0;i--)pattern+=pick(patternChars);if(rand()<.15)pattern='*'+Array.from({length:33+Math.floor(rand()*40)},()=>pick(['a','?','a','b'])).join('')+'*';return pattern;});
  const policy=policyOf({paths:subset(nested,3).map(p=>pathRule(p,{recursive:rand()<.8})),excludes});if(!policy.paths.length)policy.paths.push(pathRule('C:\\D'));
  const matcher=drift.compileDriftPolicy(policy);
  for(let n=0;n<12;n++){let tail='';for(let i=Math.floor(rand()*(rand()<.2?80:14));i>0;i--)tail+=pick(pathChars);const entry=file(pick(nested)+'\\'+tail);
   assert.equal(matcher.allowed(entry),refAllowedPath(policy,entry),'nested allowed '+JSON.stringify({policy,entry}));checks++;}
 }
 // The review's attack: 100 excludes with a 118-character `?` part, 20 nested
 // policy paths (21 candidates per entry), 1 024-character paths of `A`.
 const deep=Array.from({length:20},(_,i)=>'C:\\D'+'\\A'.repeat(i)),attack=Array.from({length:100},(_,i)=>'*?'+'A'.repeat(117)+'B'+i+'*');
 const entryPath=deep.at(-1)+'\\'+'A'.repeat(1024-deep.at(-1).length-1);assert.equal(entryPath.length,1024);
 const matcher=drift.compileDriftPolicy(policyOf({paths:deep.map(p=>pathRule(p)),excludes:attack}));
 // No fixed wall-clock limit: a CI runner with parallel test files took 1 167 ms
 // where this machine takes 250. The time counts against plain linear work on
 // the same path, measured right before it: one pass over the path per entry
 // and exclude. A slow or busy machine slows both; a matcher whose cost grows
 // super-linearly with the path (backtracking, or no memo shared by the 21
 // candidates) exceeds the ratio many times over and is stopped at the limit.
 const timed=linearRatio(()=>linearPasses(entryPath,200,100),stop=>{for(let i=0;i<200&&!stop();i++)assert.equal(matcher.allowed(file(entryPath)),true);});
 assert.ok(timed.ratio<nestedRatioLimit,`200 entries × 100 long ? excludes × 21 candidates: ${linearRatioText(timed)}`);timings.nested=linearRatioText(timed);
 assert.equal(matcher.allowed(file(deep.at(-1)+'\\x'+'A'.repeat(117)+'B42y')),false,'the same excludes still match');checks++;
}

// ---- Database fixture ----
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
async function device(policyInput,{revoked=0,baseline}={}){
 const id=uuid(),policyId=uuid(),policy=drift.driftPolicySchema.parse({enabled:true,...policyInput});
 await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,revoked) VALUES(${id},${id},${id},${clock},${revoked})`);
 await d.exec(sql`INSERT INTO drift_policies(server_id,id,version,enabled,policy,created_at,updated_at,updated_by) VALUES(${id},${policyId},1,1,${JSON.stringify(policy)},${clock},${clock},'test')`);
 if(baseline)await d.exec(sql`INSERT INTO drift_baselines(id,server_id,policy_version,report_id,entries,created_at,created_by) VALUES(${uuid()},${id},1,${uuid()},${JSON.stringify(baseline)},${clock},'test')`);
 return {id,report:(entries,extra={})=>({policyId,version:1,scanId:uuid(),at:clock,complete:true,entries,errors:[],...extra})};
}

const reports=async id=>(await d.one(sql`SELECT count(*) AS n FROM drift_reports WHERE server_id=${id}`)).n;
const rejects=async(promise,status,message,label)=>{await assert.rejects(promise,error=>{assert.equal(error.status,status,label+': '+error.message);if(message)assert.equal(error.message,message,label);return true;});checks++;};
const simple={paths:[{path:'C:\\Config'}]},entry=file('C:\\Config\\app.txt',{size:10});

// ---- The attack through ingestDrift, schema-valid (`?` part of at most 32 characters) ----
{
 const deep=Array.from({length:20},(_,i)=>'C:\\D'+'\\A'.repeat(i)),entryPath=deep.at(-1)+'\\'+'A'.repeat(1024-deep.at(-1).length-1);
 const policy={maxFiles:5000,paths:deep.map(path=>({path})),excludes:Array.from({length:100},(_,i)=>'*?'+'A'.repeat(28)+'B'+i+'*')};
 const entries=Array.from({length:500},(_,i)=>({key:'k'+i,kind:'file',path:entryPath.slice(0,-String(i).length)+i,hash:sha('k'+i)}));
 // Each timed run sends a new report of a new device (one report per device and 30 seconds).
 const targets=[],timed=await budgeted(d,2000,async i=>{const result=await drift.ingestDrift(targets[i].id,targets[i].report(entries));assert.equal(result.ok,true);return result;},{prepare:async i=>{targets[i]=await device(policy);}});
 assert.ok(timed.ms<timed.budget,`ingest of 500 attack entries: ${budgetText(timed)}`);timings.attack=Math.round(timed.ms);checks++;
}

// ---- Total work per ingest is bounded, even for a worst-case construction ----
// 20 nested policy paths, 100 excludes with 16 `*` (14 × `?b`, then `?z`),
// entries under the deepest path. Every variant must finish in < 2 000 ms
// through ingestDrift: accepted, or rejected by the size bound or the budget.
{
 const storage=serverText('apiError.drift.storageLimit'),budget=serverText('apiError.drift.policyTooComplex');
 const variants=[
  ['identical ?',seg=>'aaaaaaa'+seg,()=>'*'+'?b*'.repeat(14)+'?z*'],
  ['varied ?',seg=>'aaaaaaa'+seg,j=>'*'+'?b*'.repeat(14)+'?z'+j+'*'],
  ['varied literal',seg=>'aaaaaaa'+seg,j=>'*'+'ab*'.repeat(14)+'az'+j+'*'],
  ['head a',seg=>'aaaaaaa'+seg,j=>'a*'+'?b*'.repeat(14)+'?z'+j+'*'],
  ['line breaks',seg=>'aaaaaa\n'+seg,j=>'a*'+'?b*'.repeat(14)+'?z'+j+'*']
 ];
 timings.budget={};
 for(const [label,segment,exclude] of variants){
  const nestedPaths=Array.from({length:20},(_,i)=>'C:\\D'+('\\'+segment('b')).repeat(i)),deepest=nestedPaths.at(-1);
  for(const count of [4000,2400]){
   const policy={maxFiles:5000,paths:nestedPaths.map(path=>({path})),excludes:Array.from({length:100},(_,j)=>exclude(j))};
   const entries=Array.from({length:count},(_,i)=>({key:'k'+i,kind:'file',path:deepest+'\\f'+i,hash:sha(label+i)}));
   // The smaller report is trimmed to fit the storage limit, so the matcher runs on all of it.
   if(count===2400)while(JSON.stringify(entries).length>=800000)entries.pop();
   const targets=[],outcomes=[],timed=await budgeted(d,2000,async i=>{const outcome=await drift.ingestDrift(targets[i].id,targets[i].report(entries)).then(result=>result.ok?'ok':'?',error=>error.status+' '+error.message);outcomes.push(outcome);return outcome;},{prepare:async i=>{targets[i]=await device(policy);}});
   const outcome=timed.value;
   timings.budget[label+' '+count]=Math.round(timed.ms)+' ms '+outcome.slice(0,3);
   assert.ok(timed.ms<timed.budget,`${label}, ${count} entries: ${budgetText(timed)} (${outcome})`);
   for(const outcome of outcomes){
    if(count===4000)assert.equal(outcome,'413 '+storage,'4 000 entries exceed the stored size before any path check');
    else assert.ok(['ok','413 '+budget].includes(outcome),label+': '+outcome);
   }
   checks++;
  }
 }
 assert.match(timings.budget['head a 2400'],/ 413$/,'the head-anchored variant is stopped by the work budget');
}
// ---- `?` in heads is charged per character ----
// Reviewer's construction: 20 nested policy paths C:\b, C:\b\b, …, 100 excludes
// '?'.repeat(240)+'*z'+j+'*', about 1 889 entries <deepest>\ + 242 × a + i.
{
 const nestedPaths=Array.from({length:20},(_,i)=>'C:\\b'+'\\b'.repeat(i)),deepest=nestedPaths.at(-1);
 const entriesFor=label=>{const entries=Array.from({length:1889},(_,i)=>({key:'k'+i,kind:'file',path:deepest+'\\'+'a'.repeat(242)+i,hash:sha(label+i)}));while(JSON.stringify(entries).length>=800000)entries.pop();return entries;};
 const wild=heads=>Array.from({length:100},(_,j)=>'?'.repeat(heads)+'*z'+j+'*');
 timings.wildHead={};
 // As constructed (240 `?`): the schema no longer stores it, and a policy saved
 // before this limit is answered with 409 at once.
 const legacyEntries=entriesFor('legacy'),legacies=[];
 let timed=await budgeted(d,2000,i=>rejects(drift.ingestDrift(legacies[i].id,legacies[i].report(legacyEntries)),409,serverText('apiError.drift.policyNeedsFix'),'240 ? heads in a stored policy'),{prepare:async i=>{
  legacies[i]=await device({maxFiles:5000,paths:nestedPaths.map(path=>({path}))});
  await d.exec(sql`UPDATE drift_policies SET policy=jsonb_set(policy::jsonb,'{excludes}',${JSON.stringify(wild(240))}::jsonb)::text WHERE server_id=${legacies[i].id}`);
 }});
 assert.ok(timed.ms<timed.budget,`240 ? heads through ingestDrift: ${budgetText(timed)}`);timings.wildHead['240 ingest']=Math.round(timed.ms)+' ms 409';
 // At the schema limit (32 `?`) the matcher runs until the work budget stops it.
 const limitEntries=entriesFor('limit'),targets=[],outcomes=[];
 timed=await budgeted(d,2000,async i=>{const outcome=await drift.ingestDrift(targets[i].id,targets[i].report(limitEntries)).then(result=>result.ok?'ok':'?',error=>error.status+' '+error.message);outcomes.push(outcome);return outcome;},{prepare:async i=>{targets[i]=await device({maxFiles:5000,paths:nestedPaths.map(path=>({path})),excludes:wild(32)});}});
 const outcome=timed.value;
 assert.ok(timed.ms<timed.budget,`32 ? heads through ingestDrift: ${budgetText(timed)} (${outcome})`);for(const outcome of outcomes)assert.ok(['ok','413 '+serverText('apiError.drift.policyTooComplex')].includes(outcome),outcome);timings.wildHead['32 ingest']=Math.round(timed.ms)+' ms '+outcome;
 // The 240 `?` construction at matcher level under the same rule as
 // ingestDrift (stop once the work exceeds the budget): the meter now charges
 // each `?` compared, so the run stays within the time limit.
 const matcher=drift.compileDriftPolicy(policyOf({paths:nestedPaths.map(p=>pathRule(p)),excludes:wild(240)})),entries=entriesFor('matcher');let stopped=false;
 const start=performance.now();for(const entry of entries){matcher.allowed(entry);if(matcher.work()>drift.DRIFT_MATCH_BUDGET){stopped=true;break;}}const ms=performance.now()-start;
 assert.ok(ms<2000,`240 ? heads under the budget took ${ms.toFixed(0)} ms`);assert.equal(stopped,true,'the budget stops the 240 ? construction');
 // The meter charges a part with `?` per character at every offset it is
 // compared (21 here), a literal part per 16 characters.
 const one=exclude=>{const m=drift.compileDriftPolicy(policyOf({paths:nestedPaths.map(p=>pathRule(p)),excludes:[exclude]}));m.allowed({key:'k',kind:'file',path:deepest+'\\'+'b'.repeat(300),hash:'a'.repeat(64)});return m.work();},base=one('*q');
 assert.ok(one('?'.repeat(32)+'*z*')-base>=21*33,'wild head charged per character');assert.ok(one('b'.repeat(31)+'?*z*')-base>=21*33,'literal-heavy wild head charged per character');
 assert.ok(one('b'.repeat(32)+'*z*')-base<21*33,'a literal head stays cheaper');
 // Per entry the path's character loops (folding, line breaks) are charged,
 // and a Shift-And scan is charged per character and word.
 const flat=exclude=>{const m=drift.compileDriftPolicy(policyOf({paths:[pathRule('C:\\D')],excludes:[exclude]}));m.allowed({key:'k',kind:'file',path:'C:\\D\\'+'b'.repeat(300),hash:'a'.repeat(64)});return m.work();};
 assert.ok(flat('*q')>=2*305,'per-entry character loops are charged');
 assert.ok(flat('*'+'a?'.repeat(30)+'z*')-flat('*a?z*')>=290,'a two-word Shift-And scan costs about twice a one-word scan');timings.wildHead['240 matcher']=`${Math.round(ms)} ms, ${(matcher.work()/1e6).toFixed(0)}M units, ${(ms*1e6/matcher.work()).toFixed(1)} ns/unit${stopped?', stopped':''}`;checks++;
}
// The size bound counts about 105 bytes per entry besides key and path: these
// keys and paths alone stay below 800 000, the stored JSON would not.
{
 const target=await device({maxFiles:5000,paths:[{path:'C:\\Config'}]}),entries=[file('C:\\Elsewhere\\a.txt'),...Array.from({length:1999},(_,i)=>file('C:\\Config\\'+'x'.repeat(150)+i))];
 assert.ok(entries.reduce((sum,e)=>sum+e.key.length+e.path.length,0)<800000);
 await assert.rejects(drift.ingestDrift(target.id,target.report(entries)),error=>error.status===413&&error.messageKey==='apiError.drift.storageLimit');checks++;
}

// ---- Exclude limits in the policy schema ----
{
 const valid=excludes=>drift.driftPolicySchema.safeParse({paths:[{path:'C:\\Data'}],excludes}).success;
 for(const exclude of ['*.log','*\\*\\*\\*\\*\\*\\*\\*.tmp','*'.repeat(16),'*'+'x'.repeat(120)+'*','C:\\'+'x'.repeat(240),'*'+'x'.repeat(240),'x'.repeat(240)+'*','*?'+'x'.repeat(31)+'*','?'.repeat(32)+'*z*','*z*'+'?'.repeat(32),'backup-????-??-??.zip','?'.repeat(32)])assert.equal(valid([exclude]),true,'accepted: '+exclude.slice(0,40));
 for(const exclude of ['*'+'A'.repeat(247)+'B*','*'.repeat(17),'*a'.repeat(17),'*'+'x'.repeat(121)+'*','a*'+'x'.repeat(121)+'*b','*?'+'x'.repeat(32)+'*','*'+'x'.repeat(32)+'?*','?'+'x'.repeat(200)+'*','?'.repeat(240)+'*z1*','*z*'+'?'.repeat(33),'?'.repeat(33),'C:\\'+'x'.repeat(40)+'?'])assert.equal(valid([exclude]),false,'rejected: '+exclude.slice(0,40));
 checks++;
}

// ---- Linear rename detection, same output and order ----
{
 const e=(key,hash,kind='file',extra={})=>({key,kind,path:'C:\\X\\'+key,hash:hash.repeat(64).slice(0,64),...extra});
 const cases=[
  [[],[]],[[e('a','1')],[]],[[],[e('a','1')]],
  [[e('a','1')],[e('b','1')]],
  [[e('a','1'),e('b','1')],[e('c','1')]],
  [[e('a','1')],[e('c','1'),e('d','1')]],
  [[e('a','1'),e('b','1')],[e('c','1'),e('d','1')]],
  [[e('a','1','registry')],[e('b','1','registry')]],[[e('a','1','config')],[e('b','1')]],[[e('a','1')],[e('b','1','directory')]],
  [[e('a','1'),e('b','1','registry')],[e('c','1'),e('d','1','config')]],
  [[e('a','1',undefined,{text:'x\ny'}),e('b','2',undefined,{text:'x'}),e('c','3',undefined,{size:1})],[e('a','4',undefined,{text:'x\nz'}),e('b','5'),e('c','3',undefined,{size:2})]],
  [[e('a','1'),e('m','2'),e('b','3')],[e('m','9'),e('x','3'),e('y','1'),e('z','7')]]
 ];
 for(const [a,b] of cases){assert.deepStrictEqual(drift.diffEntries(a,b),refDiffEntries(a,b),JSON.stringify({a,b}));checks++;}
 for(let round=0;round<1500;round++){
  const make=prefix=>{const list=[],keys=new Set(),length=Math.floor(rand()*9);for(let i=0;i<length;i++){const key=pick(['a','b','c','d','e','f','g','h'])+(rand()<.5?prefix:'');if(keys.has(key)&&round%10)continue;keys.add(key);const item=e(key,pick(['1','2','3']),pick(['file','file','file','directory','registry','config']));if(rand()<.3)item.size=Math.floor(rand()*3);if(rand()<.3)item.text=pick(['x','y','x\ny']);list.push(item);}return list;};
  const a=make('1'),b=make('2');assert.deepStrictEqual(drift.diffEntries(a,b),refDiffEntries(a,b),JSON.stringify({a,b}));checks++;
 }
}

// ---- Load within the time limit ----
{
 const policy={maxFiles:5000,paths:Array.from({length:20},(_,i)=>({path:'C:\\Data'+i})),excludes:Array.from({length:100},(_,i)=>i%2?'*\\never'+i+'\\'+'q'.repeat(90)+'*'+'q'.repeat(90)+'*.bak':'C:\\Data'+i%20+'\\'+'z'.repeat(191)),registry:Array.from({length:20},(_,i)=>({path:'HKLM\\Software\\R'+i,names:Array.from({length:100},(_,j)=>'n'+j)}))};
 const baseline=Array.from({length:5000},(_,i)=>({key:'b:'+i,kind:'file',path:`C:\\Data${i%20}\\b${i}`,hash:sha('b'+i)}));
 const current=Array.from({length:5000},(_,i)=>i<2500?{key:'r:'+i,kind:'file',path:`C:\\Data${i%20}\\r${i}`,hash:sha('b'+i)}:{key:'n:'+i,kind:'file',path:`C:\\Data${i%20}\\n${i}`,hash:sha('n'+i)});
 assert.ok(JSON.stringify(current).length<800000,'fixture stays below the storage limit');
 const targets=[],timed=await budgeted(d,2000,async i=>{const result=await drift.ingestDrift(targets[i].id,targets[i].report(current));assert.equal(result.state,'drifted');return result;},{prepare:async i=>{targets[i]=await device(policy,{baseline});}});
 const result=timed.value;
 timings.load=Math.round(timed.ms);assert.ok(timed.ms<timed.budget,`5 000 entries: ${budgetText(timed)}`);checks++;
 const stored=JSON.parse((await d.one(sql`SELECT changes FROM drift_reports WHERE id=${result.id}`)).changes);assert.ok(stored.length>0,'changes are stored');
 assert.deepStrictEqual(drift.diffEntries(baseline,current).slice(0,50),refDiffEntries(baseline,current).slice(0,50),'large rename diff keeps the former output');
}

// ---- Pathological exclude against long paths ----
{
 const entries=Array.from({length:500},(_,i)=>({key:'p'+i,kind:'file',path:'C:\\Data\\'+'abc\\'.repeat(247)+'f'+i+'.txt',hash:sha('p'+i)}));
 assert.ok(entries.every(e=>e.path.length>=990&&e.path.length<=1024),'paths are about 1 000 characters');
 const policy={paths:[{path:'C:\\Data'}],excludes:['*\\*\\*\\*\\*\\*\\*\\*.tmp']};
 const targets=[],timed=await budgeted(d,2000,async i=>{const result=await drift.ingestDrift(targets[i].id,targets[i].report(entries));assert.equal(result.ok,true);assert.equal(result.state,'baseline_missing');return result;},{prepare:async i=>{targets[i]=await device(policy);}});
 timings.glob=Math.round(timed.ms);assert.ok(timed.ms<timed.budget,`pathological exclude: ${budgetText(timed)}`);checks++;
}

// ---- Dedupe before validation ----
const first=await device(simple),second=await device(simple);
{
 const t0=clock,a=first.report([entry]),accepted=await drift.ingestDrift(first.id,a);assert.equal(accepted.ok,true);
 clock=t0+1;assert.deepStrictEqual(await drift.ingestDrift(first.id,{...a,entries:'x'}),{ok:true,id:accepted.id,state:accepted.state},'stored scan is answered despite an invalid body');assert.equal(await reports(first.id),1);checks++;
 await d.exec(sql`UPDATE drift_policies SET enabled=0 WHERE server_id=${first.id}`);
 clock=t0+2;assert.deepStrictEqual(await drift.ingestDrift(first.id,a),{ok:true,id:accepted.id,state:accepted.state},'stored scan is answered after a pause');checks++;
 await d.exec(sql`UPDATE drift_policies SET enabled=1 WHERE server_id=${first.id}`);
 await rejects(drift.ingestDrift(first.id,null),400,serverText('apiError.drift.invalidReport'),'null body');
 await rejects(drift.ingestDrift(first.id,'text'),400,serverText('apiError.drift.invalidReport'),'string body');
 await rejects(drift.ingestDrift(first.id,{...a,scanId:'nope'}),400,serverText('apiError.drift.invalidReport'),'invalid scanId');
 await rejects(drift.ingestDrift(first.id,{...a,scanId:undefined}),400,serverText('apiError.drift.invalidReport'),'missing scanId');
 clock=t0+30000;assert.deepStrictEqual(await drift.ingestDrift(first.id,a),{ok:true,id:accepted.id,state:accepted.state});
 const b=await drift.ingestDrift(first.id,first.report([entry]));assert.notEqual(b.id,undefined);assert.equal(b.ok,true,'the replay did not use the slot');checks++;
 const other=await drift.ingestDrift(second.id,second.report([entry],{scanId:a.scanId}));assert.notEqual(other.id,accepted.id,'another device is not deduplicated');assert.equal(await reports(second.id),1);checks++;
}

// ---- One new report per device and 30 seconds ----
{
 const tB=clock;
 await rejects(drift.ingestDrift(first.id,first.report([entry])),429,serverText('apiError.drift.intervalTooShort'),'same instant');
 clock=tB+29999;await rejects(drift.ingestDrift(first.id,first.report([entry])),429,serverText('apiError.drift.intervalTooShort'),'after 29 999 ms');
 assert.equal((await d.one(sql`SELECT last_at FROM agent_channels WHERE server_id=${'drift:'+first.id}`)).last_at,tB,'a throttled call does not move the slot');
 const third=await device(simple),peer=await drift.ingestDrift(third.id,third.report([entry]));assert.equal(peer.ok,true,'another device is not throttled');assert.equal(await reports(third.id),1);
 clock=tB+30000;const c=await drift.ingestDrift(first.id,first.report([entry]));assert.equal(c.ok,true,'after 30 000 ms a new report is processed');checks++;
 // Rejected reports still consume the slot.
 for(const [label,report,status] of [['invalid schema',first.report([{kind:'x'}]),400],['version change',first.report([entry],{version:2}),409],['file limit',first.report(Array.from({length:1001},(_,i)=>file('C:\\Config\\f'+i))),413],['outside policy',first.report([file('C:\\Elsewhere\\a.txt')]),400],['duplicate key',first.report([entry,entry]),400]]){
  clock+=30000;await rejects(drift.ingestDrift(first.id,report),status,null,label);
  clock+=1;await rejects(drift.ingestDrift(first.id,first.report([entry])),429,serverText('apiError.drift.intervalTooShort'),'slot used by '+label);
 }
 const revoked=await device(simple,{revoked:1});
 await rejects(drift.ingestDrift(revoked.id,revoked.report([entry])),409,serverText('apiError.drift.notApproved'),'revoked device');
 assert.equal(await d.one(sql`SELECT 1 FROM agent_channels WHERE server_id=${'drift:'+revoked.id}`),null,'a revoked device takes no slot');checks++;
}

// ---- Unchanged messages and event merging for valid reports ----
{
 clock+=30000;const before=await drift.ingestDrift(first.id,first.report([entry]));
 clock+=30000;const again=await drift.ingestDrift(first.id,first.report([entry]));assert.equal(again.id,before.id,'consecutive identical scans form one event');
 assert.equal((await d.one(sql`SELECT scan_count FROM drift_reports WHERE id=${before.id}`)).scan_count>=2,true);checks++;
 const messages=[[serverText('apiError.drift.duplicateKey'),[entry,entry]],[serverText('apiError.drift.outsidePolicy'),[file('C:\\Elsewhere\\a.txt')]],[serverText('apiError.drift.fileLimit'),Array.from({length:1001},(_,i)=>file('C:\\Config\\f'+i))],[serverText('apiError.drift.storageLimit'),Array.from({length:1000},(_,i)=>file('C:\\Config\\'+'x'.repeat(900)+i))]];
 for(const [message,entries] of messages){clock+=30000;await rejects(drift.ingestDrift(first.id,first.report(entries)),message===serverText('apiError.drift.fileLimit')||message===serverText('apiError.drift.storageLimit')?413:400,message,message);}
 // Keys and paths above the storage limit are rejected before
 // any path check, so an oversized report never reaches the matcher.
 clock+=30000;await rejects(drift.ingestDrift(first.id,first.report([file('C:\\Elsewhere\\a.txt'),...Array.from({length:999},(_,i)=>file('C:\\Config\\'+'x'.repeat(900)+i))])),413,serverText('apiError.drift.storageLimit'),'oversized before path checks');
 clock+=30000;await rejects(drift.ingestDrift(first.id,first.report([entry],{version:2})),409,serverText('apiError.drift.policyReload'),'version');
 // A policy stored before the exclude limits gets a clear 409, not a 500.
 const legacy=await device(simple);await d.exec(sql`UPDATE drift_policies SET policy=jsonb_set(policy::jsonb,'{excludes}',${JSON.stringify(['*'+'A'.repeat(247)+'B*'])}::jsonb)::text WHERE server_id=${legacy.id}`);
 await rejects(drift.ingestDrift(legacy.id,legacy.report([entry])),409,serverText('apiError.drift.policyNeedsFix'),'stored policy over the exclude limits');
}

// ---- Concurrent new reports of one device ----
{
 const target=await device(simple),before=await reports(target.id);
 const results=await Promise.allSettled([drift.ingestDrift(target.id,target.report([entry])),drift.ingestDrift(target.id,target.report([entry]))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'exactly one report is processed');
 assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===429).length,1,'exactly one report is throttled');
 assert.equal(await reports(target.id),before+1);checks++;
}

// ---- Compiled once per ingest, no RegExp or policy normalization per entry ----
{
 const source=fs.readFileSync('lib/server/automation/drift.ts','utf8'),ingest=source.slice(source.indexOf('export async function ingestDrift'),source.indexOf('export async function acceptDriftBaseline'));
 assert.equal(ingest.match(/compileDriftPolicy\(/g)?.length,1,'ingestDrift compiles the policy once');
 const loop=ingest.slice(ingest.indexOf('for(const entry of p.entries)'),ingest.indexOf('if(textBytes>'));assert.ok(loop.includes('matcher.allowed(entry)')&&!/new RegExp|norm\(|allowedPath\(/.test(loop),'the entry loop uses the compiled matcher only');
 assert.ok(!/new RegExp/.test(source),'globs are not compiled to regular expressions');checks++;
}
console.log(`drift ingest bounds: ${checks} checks passed (5 000-entry ingest ${timings.load} ms, pathological exclude ${timings.glob} ms, 1 000 × *A…AB* ${timings.literal} ms, nested ? attack ${timings.nested}, attack ingest ${timings.attack} ms, budget variants ${JSON.stringify(timings.budget)}, ? heads ${JSON.stringify(timings.wildHead)})`);
