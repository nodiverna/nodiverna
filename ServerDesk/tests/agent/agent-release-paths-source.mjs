// Static checks of the agent sources of origin-independent release manifests
// (agent 4.12.0): the version, the release-paths capability, the installer
// request for the path form, the path handling of VerifyManifest and its
// self-test, and that the test-only trust parameter is unreachable from the
// command line. No build; the behaviour runs in --installer-self-test.
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {validateReleaseChangelog} from '../../scripts/release-changelog.mjs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
// Code without comments, so that a comment that names a call does not count.
// A // after a colon belongs to a URL in a string, not to a comment.
const code=file=>read(file).replace(/\/\*[\s\S]*?\*\//g,'').split('\n').map(line=>line.replace(/(?<!:)\/\/.*$/,'')).join('\n');
const version='4.12.0';
// The release paths arrived in 4.12.0; a later agent version keeps them.
const atLeast=value=>{const [a,b,c]=String(value).split('.').map(Number);return a>4||a===4&&(b>12||b===12&&c>=0);};

// ---- Version ----
const project=read('agent/v3/ServerDesk.Agent.csproj').match(/<Version>([^<]*)<\/Version>/)?.[1],program=/internal const string BaseVersion = "([^"]+)";/.exec(read('agent/v3/Program.cs'))?.[1];
ok(atLeast(project),'the project file has <Version>4.12.0 or later');
ok(program===project,'Program.Version is the project version');
const readme=read('agent/v3/README.md');
ok(readme.startsWith(`# ServerDesk native agent ${project}\n`)&&readme.includes(`the executable version are \`${project}\``),'the agent README names the project version');
const notes=JSON.parse(read(`agent/v3/changelogs/${version}.json`));
ok(validateReleaseChangelog(notes,version).features.some(entry=>/origin-independent release manifests/.test(entry)),'the 4.12.0 release notes name the origin-independent manifests as a feature');

// ---- Capability ----
const worker=code('agent/v3/AgentWorker.cs');
ok(/latest\["agentCapabilities"\] = new JsonArray\([^\n]*"release-paths"[^\n]*\);/.test(worker),'the heartbeat reports the capability release-paths');

// ---- VerifyManifest ----
const updater=code('agent/v3/AgentUpdater.cs');
ok(updater.includes('internal static JsonObject VerifyManifest(string manifest, string signature, string origin) => VerifyManifest(manifest, signature, origin, PublicKey);'),'the production overload always uses the embedded publisher key');
const body=updater.slice(updater.indexOf('internal static JsonObject VerifyManifest(string manifest, string signature, string origin, string trustedPublicKeyPem)'));
ok(body.indexOf('signer.VerifyData(')>0&&body.indexOf('signer.VerifyData(')<body.indexOf('JsonNode.Parse(manifest)'),'the signature over the received bytes is checked before the manifest is parsed');
ok(updater.includes('new(@"^/downloads/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\\z"')&&updater.includes('!value.Contains("..", StringComparison.Ordinal)'),'the path rule matches the rule of the portal and refuses ..');
ok(/bool hasPath = entry\.ContainsKey\("path"\), hasUrl = entry\.ContainsKey\("url"\);\s*if \(hasPath == hasUrl\) throw/.test(updater),'an entry needs exactly one of path and url');
ok(updater.includes('throw new InvalidDataException("The signed release mixes file paths and URLs.")'),'mixed forms are refused');
ok(updater.includes('entry.Remove("path"); entry["url"] = authority + path;')&&updater.includes('ResolveFiles(data, site.GetLeftPart(UriPartial.Authority));'),'a path resolves against scheme, host and port of the registered origin');
ok(updater.indexOf('ResolveFiles(data,')<updater.indexOf('ValidateUrl(data["url"]!.GetValue<string>());'),'resolved URLs pass the same-origin check of the absolute form');
ok(/LocalStore\.ReadProtected\(planPath\)[\s\S]*VerifyManifest\(plan\["manifest"\]!\.GetValue<string>\(\), plan\["signature"\]!\.GetValue<string>\(\), config\["origin"\]!\.GetValue<string>\(\)\)/.test(updater),'ApplyAsync verifies the stored plan again with the same rules');
ok(/await releases\.CopyAsync\(piece\["url"\]!\.GetValue<string>\(\)/.test(updater),'PrepareAsync downloads the resolved URL through the worker relay');

// ---- Installer ----
const installer=code('agent/v3/AgentInstaller.cs');
ok(installer.includes('http.GetAsync(origin + "/Agent-v3-release.json?form=path"')&&!installer.includes('"/Agent-v3-release.json"'),'the native installer requests the path form');
ok(installer.includes('AgentUpdater.VerifyManifest(envelope["manifest"]!.GetValue<string>(), envelope["signature"]!.GetValue<string>(), origin)'),'the installer accepts either form through VerifyManifest');
ok(/http\.GetAsync\(piece\["url"\]!\.GetValue<string>\(\)/.test(installer),'the installer downloads the resolved URL');
ok(/args\[0\] == "--verify-release"[\s\S]*AgentUpdater\.VerifyManifest\(envelope\["manifest"\]!\.GetValue<string>\(\), envelope\["signature"\]!\.GetValue<string>\(\), args\[2\]\)/.test(code('agent/v3/Program.cs')),'--verify-release accepts both forms with the embedded key');

// ---- Self-test ----
const tests=code('agent/v3/NativeInstallerTests.cs');
ok(/VerifyServiceSecurityPolicy\(\);\s*VerifyReleaseForms\(\);/.test(tests),'--installer-self-test runs the release form tests');
ok(tests.includes('const string origin = "https://portal.test:8443";')&&tests.includes('ECDsa.Create(System.Security.Cryptography.ECCurve.NamedCurves.nistP256)'),'the self-test signs with a throwaway key for https://portal.test:8443');
for(const label of ['a foreign origin','/downloads/../x','/downloads/a/b','/other/x','a query','a backslash','mixed forms','an entry with both keys'])ok(tests.includes(`("${label}",`),`the self-test refuses ${label}`);
ok(tests.includes('A changed byte of a signed release was accepted.'),'the self-test refuses a changed byte');
ok(read('scripts/build-agent-v3.mjs').includes("'--installer-self-test'"),'build-agent-v3.mjs runs --installer-self-test');
ok(/args\.Contains\("--installer-self-test"\)\) \{ NativeInstallerTests\.Run\(\); return 0; \}/.test(code('agent/v3/Program.cs')),'the self-test switch takes no arguments');

// The trust parameter: only the self-test passes a fourth argument. Every other
// call, including all in Program.cs, uses the overload with the embedded key.
function calls(source){
 const found=[];let index=0;
 while((index=source.indexOf('VerifyManifest(',index))>=0){
  const before=source.slice(Math.max(0,index-40),index);let depth=0,arguments_=1,end=index+'VerifyManifest('.length;
  if(/JsonObject\s+$/.test(before)){index=end;continue;} // a declaration, not a call
  for(;end<source.length;end++){const character=source[end];if('([{'.includes(character))depth++;else if(')]}'.includes(character)){if(!depth)break;depth--;}else if(character===','&&!depth)arguments_++;}
  found.push({arguments:arguments_,text:source.slice(index,end+1)});index=end;
 }
 return found;
}
const sources=readdirSync('agent/v3').filter(name=>name.endsWith('.cs'));
let production=0,selfTest=0;
for(const name of sources){
 for(const call of calls(code('agent/v3/'+name))){
  if(name==='NativeInstallerTests.cs'){if(call.arguments===4)selfTest++;continue;}
  if(name==='AgentUpdater.cs'&&call.text==='VerifyManifest(manifest, signature, origin, PublicKey)')continue;
  ok(call.arguments===3,`${name}: ${call.text.slice(0,80)} uses the overload with the embedded key`);production++;
 }
}
ok(production>=5&&selfTest>=1,`calls found: ${production} production, ${selfTest} self-test`);
ok(calls(code('agent/v3/Program.cs')).every(call=>call.arguments===3),'Program.cs never reaches the trust parameter');

console.log(`PASS agent release paths source (${checks} checks): version 4.12.0, release-paths, ?form=path, path rule and resolution, self-test and the unreachable trust parameter.`);
