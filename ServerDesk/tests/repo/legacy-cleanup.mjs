// The hosting leftovers, the old role model, the pre-pinning token paths and the
// dead modules stay removed. Every remaining "legacy" or "compat" place is a
// listed, reasoned exception. The forbidden names are built from parts so this
// file does not match itself.
// The scans cover the whole product.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {de} from '../support/i18n-stubs.mjs';

const root=process.cwd(),repository=path.resolve(root,'..'),self=path.resolve(root,'tests/repo/legacy-cleanup.mjs');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const relative=file=>path.relative(root,file).replaceAll('\\','/');
let checks=0;
const join=(...parts)=>parts.join('');

// 1. The dead modules, the removed routes and their tests are gone.
const overlay=join('dev','-feedback');
const deleted=[
 'app/portal-users.tsx','app/portal-users.css','app/agent-registrations.tsx','app/agent-registrations.css','app/v3-release-upload.tsx','lib/release-zip.ts',
 'tests/portal-users-view.mjs','tests/agent-registrations-view.mjs',
 `components/${overlay}`,`scripts/check-${overlay}-production.mjs`,...['model','github','production'].map(kind=>`tests/${overlay}-${kind}.mjs`),
 'lib/portal-memberships.ts','lib/release-uploads.ts','app/api/releases/upload/route.ts','app/downloads/releases/[file]/route.ts',
 'app/access-gate.tsx','app/hosting-auth-gate.tsx','app/editor-storage-access.ts',
 'tests/legacy-token-expiry.mjs','tests/access-gate.mjs','tests/portal-membership-races.mjs',
];
for(const file of deleted){assert.equal(fs.existsSync(path.join(root,file)),false,file+' is deleted');checks++;}
// A deleted test stays deleted in every folder below tests/: the check goes by base name.
const testBaseNames=fs.readdirSync(path.join(root,'tests'),{recursive:true}).map(file=>path.basename(String(file)));
const {files:testList}=await import('../../scripts/test.mjs');
for(const name of deleted.filter(file=>file.startsWith('tests/')).map(file=>path.basename(file,'.mjs'))){assert.ok(!testBaseNames.includes(name+'.mjs'),name+'.mjs is in no folder below tests/');assert.ok(!testList.some(entry=>path.posix.basename(entry)===name),name+' is not in the test list');checks++;}

// 2. No source, script, config, test, doc, agent file, workflow or pipeline names a removed item.
const forbidden=[
 join('ALLOW_LEGACY','_ACTIVATION'),join('HOST_AUTH','_REQUIRED'),join('hosting','Message'),join('set-chatgpt','-role'),
 join('shared','Viewers'),join('migration','Identity'),join('activation','Required'),join('release','-zip'),overlay,
 join('legacy','_role'),join('compatibility','Role'),join('legacy','_token_expires_at'),join('legacy','AfterPin'),join('LEGACY','_PINNED_TOKEN_LIFETIME'),
 join('legacy','CrlfChecksum'),join('LEGACY','_SHARD'),join('legacy','Key'),join('X-ServerDesk','-Embedded'),join('Parti','tioned'),
 join('service','Token'),join('SITES','_SERVICE_TOKEN'),join('OAI-Sites','-Authorization'),join('SITES','_PNPM_SHARED_STORE'),join('.sites','-runtime'),join('.wran','gler'),
 join('chatgpt','_roles'),join('portal','_memberships'),join('device','_grants'),join('PRIVATE','_OWNER_EMAIL'),join('PRIVATE','_VIEWER_EMAILS'),
 join('set-portal','-access'),join('revoke','-server'),join('release','_uploads'),join('ensureLocal','IdentityMigration'),join('signout-with','-chatgpt'),
 join('Chat','GPT'),join('CF-Connecting','-IP'),join('oai-authenticated','-'),
];
// The deleted upload module.
const uploadModule=new RegExp(join('v3-release','-upload')+'(?!\\w)');
const binary=/\.(png|jpe?g|gif|ico|webp|svg|exe|dll|pdb|zip|woff2?|ttf|pdf|wasm|db|sqlite)$/i;
const skip=new Set(['node_modules','.next','drizzle','factory','bin','obj','.build']);
function walk(directory,files=[]){
 if(!fs.existsSync(directory))return files;
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  if(skip.has(entry.name))continue;
  const full=path.join(directory,entry.name);
  if(entry.isDirectory())walk(full,files);else if(!binary.test(entry.name)&&full!==self)files.push(full);
 }
 return files;
}
const composeFiles=fs.readdirSync(root).filter(name=>/^compose.*\.ya?ml$/.test(name)).map(name=>path.join(root,name));
const scanned=[
 ...['app','lib','ui','runtime','scripts','deploy','tests','docs','db','e2e','agent'].flatMap(directory=>walk(path.join(root,directory))),
 ...composeFiles,...fs.readdirSync(path.join(root,'public')).filter(name=>name.endsWith('.ps1')).map(name=>path.join(root,'public',name)),
 path.join(root,'.env.example'),path.join(root,'proxy.ts'),path.join(root,'next.config.ts'),path.join(root,'eslint.config.mjs'),
 path.join(root,'Dockerfile'),path.join(root,'package.json'),path.join(root,'pnpm-workspace.yaml'),path.join(root,'.gitignore'),path.join(root,'.dockerignore'),
 ...walk(path.join(repository,'.github')),
].filter(file=>fs.existsSync(file));
assert.ok(scanned.length>100,'the scan sees the source tree');checks++;
for(const file of ['agent/v3/DeviceTokenClient.cs','public/Bootstrap-ServerDesk-V3.ps1','../.github/workflows/agent-release.yml','../.github/workflows/ci.yml','../.github/dependabot.yml']){assert.ok(scanned.includes(path.resolve(root,file)),'the scan covers '+file);checks++;}
// The cookie-only session transport names the former embedded header and the
// partitioned cookie in a few places on purpose: the client strips the header
// from caller requests, and these tests prove that it stays stripped and
// ignored and that no cookie is partitioned.
const embeddedHeader=join('X-ServerDesk','-Embedded'),partitioned=join('Parti','tioned');
const allowed={
 'ui/base/http.ts':[embeddedHeader],
 'tests/api/cookie-only-session.mjs':[embeddedHeader,partitioned],'tests/ui/base/portal-http.mjs':[embeddedHeader],'tests/ui/session/local-identity-ui.mjs':[embeddedHeader],'tests/integration/http-selfhost.mjs':[partitioned],
};
const hits=[];
for(const file of scanned){
 const text=fs.readFileSync(file,'utf8'),exempt=allowed[relative(file)]??[];
 for(const name of forbidden)if(text.includes(name)&&!exempt.includes(name))hits.push(`${relative(file)}: ${name}`);
 if(uploadModule.test(text))hits.push(`${relative(file)}: upload module`);
}
assert.deepEqual(hits,[],'no removed name is left');checks++;

// 3. Nothing imports, requires or loads a deleted module.
const sources=scanned.filter(file=>/\.(ts|tsx|mjs|js|cjs)$/.test(file));
const reference=new RegExp(`['"][^'"]*(?:${['portal-users','agent-registrations',join('v3-release','-upload'),join('release','-zip'),join('portal','-memberships'),join('release','-uploads'),join('access','-gate'),join('hosting','-auth-gate'),join('editor','-storage-access')].join('|')})(?:\\.tsx?|\\.css)?['"]`);
assert.deepEqual(sources.filter(file=>reference.test(fs.readFileSync(file,'utf8'))).map(relative),[],'no source loads a deleted module');checks++;

// 4. The account takeover is gone from the identity status and route, and no
// source reads a gateway identity header.
const authRoute=read('app/api/auth/route.ts');
assert.match(authRoute,/return reply\(\{viewer,passwordConfigured:!!viewer,entra\}\);/,'GET /api/auth answers only viewer, passwordConfigured and entra (entraSignInState: whether sign-in with Microsoft and Microsoft sign-in only are on)');
assert.doesNotMatch(authRoute,/action==='activate'/,'POST /api/auth no longer handles activate');checks+=2;
for(const file of ['app','ui','lib'].flatMap(directory=>walk(path.join(root,directory))))
 assert.doesNotMatch(fs.readFileSync(file,'utf8'),/headers\.get\(\s*['"]oai-/i,relative(file)+' reads no gateway identity header');
checks++;

// 5. The identity-change screen and the sign-in page carry no hosting copy and
// no link to open the portal in its own tab.
for(const file of ['ui/session/identity-change-gate.tsx','ui/session/identity-entry.tsx']){assert.doesNotMatch(read(file),new RegExp(['signin-with-chat','gpt|Sites-|Chat','GPT'].join(''),'i'),file);checks++;}
const identityChange=read('ui/session/identity-change-gate.tsx');
assert.match(identityChange,/export default function IdentityChangeGate\(/,'the screen is IdentityChangeGate');
assert.match(identityChange,/\{t\('session\.identityChangeTitle'\)\}/,'it keeps its heading');assert.equal(de('session.identityChangeTitle'),'Verbindung zur Anmeldung prüfen');
assert.match(identityChange,/<PortalRecheck /,'it keeps its recheck');
assert.doesNotMatch(identityChange,/eigenem Tab/,'it has no link to open the portal in its own tab');
assert.doesNotMatch(read('ui/session/session-gate.tsx'),/[Hh]osting/,'the session gate names no hosting state');checks+=5;

// 6. The root layout renders no feedback component, and the dev-mode CSP
// exception in the proxy stays for HMR alone.
assert.doesNotMatch(read('app/layout.tsx'),new RegExp(join('Dev','Feedback|feed','back'),'i'),'the root layout renders no feedback overlay');checks++;
const proxy=read('proxy.ts');
assert.ok(proxy.includes("if (process.env.NODE_ENV !== 'production') return NextResponse.next({ request: { headers } });"),'development still skips the CSP for HMR');
assert.doesNotMatch(proxy,/overlay/i,'the proxy names no overlay');checks+=2;

// 7. Every lint exemption still names an existing file.
const exempted=[...read('eslint.config.mjs').matchAll(/\bfile:\s*"([^"]+)"/g)].map(match=>match[1]);
assert.ok(exempted.length>0);assert.deepEqual(exempted.filter(file=>!fs.existsSync(path.join(root,file))),[],'every lint exemption names an existing file');checks+=2;

// 8. Every remaining "legacy" or "compat" place is a kept, reasoned exception:
// file and number of matches. A new match fails until it is removed or listed
// here with its reason.
const kept={
 // compat-grant roles and the set-grant editor stay (live per-group permission editor).
 'lib/server/identity/access-admin.ts':2,'lib/server/identity/rbac.ts':3,'docs/customers.md':1,
 // The readiness comment and the docs describe the current update behavior.
 'lib/server/readiness.ts':1,'docs/self-hosting.md':2,
 // Live release-compatibility check.
 'ui/devices/fleet/fleet-agent-update-state.ts':2,
 // Capability-negotiated terminal channel of the shipped agent releases.
 'lib/server/devices/terminal-channel.ts':1,
 // Guard for the installed v3 updater limit.
 'scripts/build-agent-v3.mjs':1,
 // The Windows DNS replication scope "Legacy" (all domain controllers in the domain), a value of the DNS server API.
 'lib/dns.ts':2,'lib/dns-changes.ts':5,'ui/devices/extensions/dns-forms.tsx':5,'lib/i18n/messages/en.ts':3,'lib/i18n/messages/de.ts':3,
 // RDP compatibility (mailbox) transport: live fallback without a TURN relay.
 'docs/rdp-contract.md':16,
 // True for the shipped agent releases, or ordinary wording.
 'docs/agent-health.md':1,'docs/hardware-inventory.md':1,'docs/v3-gpu-telemetry.md':1,'docs/v3-process-telemetry.md':2,'docs/native-agent-v4.md':12,'docs/passkeys.md':3,
 // The error key legacyFormUnavailable: an agent before 4.12.0 cannot verify the
 // path form, so the deploy refuses it.
 'app/api/releases/route.ts':1,'lib/errors/api-error-keys.ts':1,'lib/i18n/messages/en-server.ts':1,'lib/i18n/messages/de-server.ts':1,
};
const inventory=[
 ...['app','lib','ui','runtime','scripts','deploy','db','docs'].flatMap(directory=>walk(path.join(root,directory))),
 path.join(root,'proxy.ts'),path.join(root,'next.config.ts'),path.join(root,'eslint.config.mjs'),path.join(root,'package.json'),...composeFiles,path.join(root,'.env.example'),
].filter(file=>fs.existsSync(file));
const found={};
for(const file of inventory){const count=(fs.readFileSync(file,'utf8').match(/legacy|compat/gi)??[]).length;if(count)found[relative(file)]=count;}
assert.deepEqual(found,kept,'every legacy/compat match is a kept place with its count');checks++;

// 9. The docs describe the self-hosted server: no Sites, D1, R2, Cloudflare
// Workers or "the Worker" in the server sense. The agent's Worker service and
// the STUN host stay.
const docs=[...walk(path.join(root,'docs')).filter(file=>file.endsWith('.md')),path.join(root,'agent/v3/README.md')];
const hostingWords=[/\bSites\b/,/\bD1\b/,/\bR2\b/,new RegExp(join('Cloudflare',' Workers')),/\b[Tt]he Worker\b/];
const docHits=[];
for(const file of docs)fs.readFileSync(file,'utf8').split(/\r?\n/).forEach((line,index)=>{for(const word of hostingWords)if(word.test(line))docHits.push(`${relative(file)}:${index+1}: ${word}`);});
assert.deepEqual(docHits,[],'no doc names the former hosting');checks++;
assert.match(read('docs/self-hosting.md'),/^## Backups$/m,'self-hosting.md has the Backups section');
assert.match(read('docs/self-hosting.md'),/\]\(#backups\)/,'the update section links to it');checks+=2;

// 10. SQLite, libSQL and the D1-style statement API are gone (PostgreSQL only).
// The names are built from parts; only this scan names them.
const lite=join('sq','lite'),sqlScope=[
 ...['app','lib','ui','db','runtime','scripts','deploy','tests','e2e','docs'].flatMap(directory=>walk(path.join(root,directory))),
 ...composeFiles,path.join(root,'Dockerfile'),path.join(root,'.env.example'),path.join(root,'README.md'),
 path.join(repository,'README.md'),path.join(repository,'CONTRIBUTING.md'),...walk(path.join(repository,'.github','workflows')),
].filter(file=>fs.existsSync(file)&&!file.endsWith('.png')&&!file.includes(`${path.sep}support${path.sep}fixtures${path.sep}`));
const removedWords=[new RegExp(lite,'i'),new RegExp(join('lib','sql'),'i'),new RegExp(join('server','desk\\.db'),'i'),/\bfile:(?:\/\/)?[^\s'"`]*\.db\b|\bfile::memory:/,new RegExp(join('DATABASE','_AUTH_TOKEN')),new RegExp(join('VAC','UUM')),new RegExp(join('PRAG','MA')),new RegExp(join(lite,'_master')),/\.pre-[^\s'"`]*\.bak/,new RegExp(join('D1','(?:Database|PreparedStatement|Result)\\b')),new RegExp(join('D1','_ERROR')),new RegExp(join('HRANA','_')),new RegExp(join(lite.toUpperCase(),'_'))];
const statementApi=/\b(?:d|db|database|current|source|tx|facade|env\.DB|db\(\))\s*\.\s*(?:prepare|batch|first|raw)\(|\.prepare\([^)]*\)\s*\.\s*(?:bind|first|all|run|raw)\(|\.bind\([^)]*\)\s*\.\s*(?:first|all|run|raw)\(/;
const dialectWords=[/\bjson_extract\(/,/\bjson_each\(/,/\bjson_valid\(/,/\bjson_group_array\(/,new RegExp(join('INSERT',' OR ')),/\bjulianday\(/,/\bchanges\(\)/,/\browid\b/,new RegExp(join('COLLATE',' NOCASE'))];
const liteHits=[];
for(const file of sqlScope){
 const text=fs.readFileSync(file,'utf8'),name=relative(file);
 for(const word of removedWords)if(word.test(text))liteHits.push(`${name}: ${word}`);
 if(/\.(?:ts|tsx|mjs|js)$/.test(file)){
  if(statementApi.test(text))liteHits.push(`${name}: D1-style statement call`);
  for(const word of dialectWords)if(word.test(text))liteHits.push(`${name}: ${word}`);
  if(/(?:FROM|JOIN|INTO|TABLE|UPDATE)\s+\\?`[a-z_]+\\?`/.test(text))liteHits.push(`${name}: backtick-quoted identifier in SQL`);
 }
}
assert.deepEqual(liteHits,[],'no SQLite, libSQL or D1-style text is left');checks++;
const pkg=JSON.parse(read('package.json')),lock=read('pnpm-lock.yaml');
assert.equal(pkg.dependencies?.[join('@lib','sql/client')],undefined,'the libSQL client is no dependency');
assert.match(pkg.dependencies?.postgres??'',/^\d+\.\d+\.\d+$/,'postgres is pinned to an exact version');
assert.ok(!new RegExp(join("^  '?@lib",'sql/client'),'m').test(lock),'the lockfile installs no libSQL client');checks+=3;
{const sqlFiles=fs.readdirSync(path.join(root,'drizzle')).filter(name=>name.endsWith('.sql')).sort();assert.deepEqual([sqlFiles[0],sqlFiles.at(-1)],['0000_baseline.sql','schema.lock.sql'],'the PostgreSQL baseline is the first migration');assert.ok(sqlFiles.slice(1,-1).every(name=>/^\d{4}_[a-z0-9_]+\.sql$/.test(name)&&name>'0000_baseline.sql'),'later migrations follow the baseline');checks+=2;}
assert.ok(!read('cloudflare-env.d.ts').includes('DB?:')&&!read('runtime/env.mjs').includes("key === 'DB'"),'DB is gone from the binding types and the env proxy');checks++;

console.log(`PASS legacy cleanup (${checks} assertions): removed modules, routes and tests are gone, no removed name in source, agent, workflow or docs, every legacy/compat place is a listed exception, and the docs name no former hosting.`);
