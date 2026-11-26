import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { devReleaseChangelog, validateReleaseChangelog } from './release-changelog.mjs';
import { baseVersion, isDevVersion, isReleaseVersion, releaseVersionSource } from '../runtime/release-version.mjs';
import { agentReleasePartSize } from '../runtime/agent-release-verify.mjs';

// Signs the build of scripts/build-agent-v3.mjs with the publisher key of
// SERVERDESK_RELEASE_KEY_FILE and writes the signed record to
// .build/agent-v3-release.json (scripts/agent-release.mjs assets collects the
// release assets from it). The signed manifest has the path form: each file is
// a path below /downloads/ with SHA-256 and size, without an origin, so one
// signature is valid on every installation. Nothing is written to lib/ or public/.
// A dev build (X.Y.Z-dev.<sha7>) takes the changelog of its base X.Y.Z when that
// file exists and is valid, else one generated line (devReleaseChangelog).
const root=fileURLToPath(new URL('..',import.meta.url));
const keyFile=process.env.SERVERDESK_RELEASE_KEY_FILE;
if(!keyFile){
 console.error('Set SERVERDESK_RELEASE_KEY_FILE to the publisher private key file. The record is signed with it and checked against agent/v3/release-public.pem.');
 process.exit(1);
}
const artifact=JSON.parse(fs.readFileSync(path.join(root,'.build/agent-v3-artifact.json'),'utf8'));
const digest=/^[a-f0-9]{64}$/;
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const packagePath=value=>typeof value==='string'&&new RegExp(`^/downloads/ServerDesk-Agent-${releaseVersionSource}-win-x64\\.zip(?:\\.part\\d+)?$`).test(value);
const exePath=(value,part)=>typeof value==='string'&&new RegExp(`^/downloads/ServerDesk-Agent-${releaseVersionSource}-win-x64\\.exe${part?'\\.part\\d+':''}$`).test(value);
if(!isReleaseVersion(artifact.version)||artifact.protocolVersion!==3||artifact.arch!=='x64'||!packagePath(artifact.path)||!digest.test(artifact.sha256)||!Number.isSafeInteger(artifact.size)||artifact.size<1||artifact.size>104857600)throw new Error('Invalid native package metadata.');
if(artifact.parts?.length){
 if(!Array.isArray(artifact.parts)||artifact.parts.length>6||artifact.parts.some(part=>!packagePath(part.path)||!digest.test(part.sha256)||!Number.isSafeInteger(part.size)||part.size<1||part.size>20971520)||artifact.parts.reduce((total,part)=>total+part.size,0)!==artifact.size)throw new Error('Invalid native package parts.');
}
/** Each part must be the consecutive 20 MiB slice of the whole file. */
function checkParts(bytes,parts,label){
 (parts??[]).forEach((part,index)=>{
  const slice=bytes.subarray(index*agentReleasePartSize,Math.min((index+1)*agentReleasePartSize,bytes.length));
  if(part.size!==slice.length||part.sha256!==sha256(slice))throw new Error(`${label} part ${index+1} is not the matching 20 MiB slice of the file.`);
 });
}
// Hash the actual files before their metadata is signed.
const bytes=fs.readFileSync(path.join(root,'.build',path.basename(artifact.path)));
if(bytes.length!==artifact.size||sha256(bytes)!==artifact.sha256)throw new Error('Native package does not match its metadata.');
checkParts(bytes,artifact.parts,'Native package');
if(artifact.layout!=='single-exe'||!artifact.exe||!exePath(artifact.exe.path,false)||!digest.test(artifact.exe.sha256)||!Number.isSafeInteger(artifact.exe.size)||artifact.exe.size<1||artifact.exe.size>250000000)throw new Error('Invalid single-EXE metadata.');
const exeBytes=fs.readFileSync(path.join(root,'.build/agent-v3-publish/ServerDesk.Agent.exe'));
if(exeBytes.length!==artifact.exe.size||sha256(exeBytes)!==artifact.exe.sha256)throw new Error('Executable does not match metadata.');
if(artifact.exe.parts?.length){
 if(artifact.exe.parts.length>12||artifact.exe.parts.reduce((n,p)=>n+p.size,0)!==artifact.exe.size)throw new Error('Invalid executable parts.');
 if(artifact.exe.parts.some(part=>!exePath(part.path,true)||!digest.test(part.sha256)||part.size<1||part.size>20971520))throw new Error('Invalid executable part.');
 checkParts(exeBytes,artifact.exe.parts,'Executable');
}
const target=path.join(root,'.build/agent-v3-release.json');
let previous;try{previous=JSON.parse(fs.readFileSync(target,'utf8'));}catch{/* the first signing of this build */}
// Re-signing the same artifact keeps its release identity, timestamp and notes,
// so the signed manifest stays the same bytes. Every new artifact needs
// reviewed, version-specific publisher notes.
const sameArtifact=previous?.version===artifact.version&&previous.sha256===artifact.sha256;
let changelog;
if(sameArtifact){try{changelog=JSON.parse(previous.manifest).changelog;}catch{changelog=undefined;}}
if(!changelog&&isDevVersion(artifact.version)){
 const notesFile=path.join(root,'agent/v3/changelogs',baseVersion(artifact.version)+'.json');
 let text=null;try{text=fs.readFileSync(notesFile,'utf8');}catch(error){if(error?.code!=='ENOENT')throw error;}
 changelog=devReleaseChangelog(text,artifact.version);
}
if(!changelog){
 const notesFile=path.join(root,'agent/v3/changelogs',artifact.version+'.json');
 let notes;try{notes=JSON.parse(fs.readFileSync(notesFile,'utf8'));}catch{throw new Error(`Add agent/v3/changelogs/${artifact.version}.json with version, features and fixes before publishing a new Agent release.`);}
 changelog=validateReleaseChangelog(notes,artifact.version);
}
const createdAt=sameArtifact&&Number.isSafeInteger(previous.createdAt)?previous.createdAt:Date.now();
const manifest=JSON.stringify({version:artifact.version,protocolVersion:3,minProtocolVersion:3,os:['Windows Server 2022','Windows Server 2025','Windows 11 Pro','Windows 11 Enterprise'],arch:artifact.arch,path:artifact.path,sha256:artifact.sha256,size:artifact.size,layout:'single-exe',exe:{path:artifact.exe.path,sha256:artifact.exe.sha256,size:artifact.exe.size,...(artifact.exe.parts?.length?{parts:artifact.exe.parts.map(part=>({path:part.path,sha256:part.sha256,size:part.size}))}:{})},...(artifact.parts?.length?{parts:artifact.parts.map(part=>({path:part.path,sha256:part.sha256,size:part.size}))}:{}),changelog,createdAt:new Date(createdAt).toISOString()});
// The portal and the agents accept at most 8192 characters.
if(manifest.length>8192)throw new Error('Signed manifest including release notes exceeds 8192 characters. Shorten the release notes.');
const id=sameArtifact&&/^[0-9a-f-]{36}$/i.test(previous.id)?previous.id:crypto.randomUUID();
const key=crypto.createPrivateKey(fs.readFileSync(keyFile));
const pinned=crypto.createPublicKey(fs.readFileSync(path.join(root,'agent/v3/release-public.pem')));
const signature=crypto.sign('sha256',Buffer.from(manifest),{key,dsaEncoding:'der'}).toString('base64');
if(!crypto.verify('sha256',Buffer.from(manifest),pinned,Buffer.from(signature,'base64')))throw new Error('Release signing key does not match the locally pinned publisher key.');
const release={id,version:artifact.version,manifest,signature,sha256:artifact.sha256,size:artifact.size,createdAt};
fs.writeFileSync(target,JSON.stringify(release,null,2)+'\n');
console.log(JSON.stringify({version:artifact.version,size:artifact.size,sha256:artifact.sha256,parts:artifact.parts?.length??0,record:'.build/agent-v3-release.json'}));
