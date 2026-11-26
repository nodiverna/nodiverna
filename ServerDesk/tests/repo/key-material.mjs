// No private key material in the repository: every file git would commit
// (tracked or untracked, not ignored) has neither a PEM private key marker nor
// a private JWK member "d". Without git the scan walks the tree, without
// node_modules, .next and outputs.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {serverDeskRoot} from '../support/paths.mjs';

const root=serverDeskRoot;
let files;
try{files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024}).split('\0').filter(Boolean);}
catch{files=[];const walk=relative=>{for(const entry of readdirSync(resolve(root,relative),{withFileTypes:true})){const child=relative?relative+'/'+entry.name:entry.name;if(entry.isDirectory()){if(!['node_modules','.next','outputs','.git'].includes(child))walk(child);}else if(entry.isFile())files.push(child);}};walk('');}
assert.ok(files.length>200,'the scan reads the source tree');
// Built from parts, so this file holds no marker itself.
const pem='PRIVATE'+' KEY',jwk=new RegExp('"d"\\s*:\\s*"[A-Za-z0-9_-]{20,}"');
const offenders=files.filter(name=>{let text;try{text=readFileSync(resolve(root,name),'latin1');}catch{return false;}return text.includes(pem)||jwk.test(text);});
assert.deepEqual(offenders,[],'files with private key material');
console.log(`PASS key material: ${files.length} files without a private key.`);
