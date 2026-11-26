// The customer installer script. The generated agent/package-v3.ts
// must match the template, the customer variant embeds exactly the enrollment
// credentials, the existing variants keep the enrollment marker at null, and
// the order of the security checks in the script is fixed.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';

let checks=0;
const check=(condition,label)=>{assert.ok(condition,label);checks++;};
const read=file=>fs.readFileSync(file,'utf8');

// 1. The embedded template is the template with the generator's replacements.
const template=read('agent/v3/Install-ServerDesk-V3.template.ps1').replaceAll('\r\n','\n');
const jwk=crypto.createPublicKey(read('agent/v3/release-public.pem')).export({format:'jwk'});
const point=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]).toString('base64');
const expected=template.replaceAll('__PUBLISHER_POINT_BASE64__',point).replaceAll('__DEFAULT_MODE__','ReadOnly');
const generated=read('agent/package-v3.ts');
const line=generated.split(/\r?\n/).find(entry=>entry.startsWith('const template = '));
const embedded=JSON.parse(line.slice('const template = '.length,-1));
check(embedded===expected,'agent/package-v3.ts matches the template; run "node scripts/package-agent-v3.mjs"');
check(!/__(?!(?:CONFIG|ENROLLMENT|PORTAL_ROOT)_JSON__)[A-Z_]+__/.test(embedded),'only the three JSON markers stay open');
for(const marker of ['__CONFIG_JSON__','__ENROLLMENT_JSON__','__PORTAL_ROOT_JSON__'])check(embedded.split(marker).length===2,`${marker} appears exactly once`);
check(read('scripts/package-agent-v3.mjs').includes('ENROLLMENT'),'the generator knows the enrollment marker');
check(read('scripts/package-agent-v3.mjs').includes('PORTAL_ROOT'),'the generator knows the portal root marker');

const mod={exports:{}};
new Function('module','exports',ts.transpileModule(generated,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod,mod.exports);
const {customerInstallerV3,installerV3,registrationV3}=mod.exports;

// 2. The customer variant: credentials in $Enrollment, $Config null, no open marker.
const embeddedJson=(script,variable)=>{const match=new RegExp(`^\\$${variable}='(.*)'\\|ConvertFrom-Json$`,'m').exec(script);return match?match[1]:null;};
const credentials={origin:"https://portal.test/o'r’i‚g",installerKey:'0123456789abcdef'.repeat(4)};
const customer=customerInstallerV3(credentials);
check(!/__[A-Z_]+__/.test(customer),'no open marker in the customer installer');
check(embeddedJson(customer,'Config')==='null','the configuration marker is null');
const raw=embeddedJson(customer,'Enrollment');
check(!/[‘’‚‛]/.test(raw)&&!/[^\x20-\x7e]/.test(raw),'no typographic quote or other non-ASCII character can end the PowerShell string');
check(!/(?<!')'(?!')/.test(raw),"every ' is doubled");
assert.deepEqual(JSON.parse(raw.replaceAll("''","'")),credentials,'the embedded JSON is exactly {origin,installerKey}');checks++;
assert.deepEqual(Object.keys(JSON.parse(raw.replaceAll("''","'"))),['origin','installerKey']);checks++;
const markerValue=customerInstallerV3({...credentials,origin:'__CONFIG_JSON__ $& $\''});
check(embeddedJson(markerValue,'Config')==='null'&&JSON.parse(embeddedJson(markerValue,'Enrollment').replaceAll("''","'")).origin==='__CONFIG_JSON__ $& $\'','a value can neither fill the other marker nor use replacement patterns');
check(embeddedJson(customer,'PortalRoot')==='null','without a portal root the customer installer embeds null');

// 2b. The portal root: exactly {"certificate":"<base64>"} with it, null without it.
const rootFixture=new crypto.X509Certificate(read('tests/fixtures/portal-ca/root.crt'));
const rootDer=rootFixture.raw.toString('base64');
const customerWithRoot=customerInstallerV3(credentials,rootDer);
check(embeddedJson(customerWithRoot,'PortalRoot')===`{"certificate":"${rootDer}"}`,'the customer installer embeds exactly {"certificate":"<base64>"}');
check(embeddedJson(customerWithRoot,'Enrollment')===raw&&embeddedJson(customerWithRoot,'Config')==='null','the root changes neither $Enrollment nor $Config');
check(!/__[A-Z_]+__/.test(customerWithRoot),'no open marker with a root');
const rootMarker=customerInstallerV3(credentials,'__CONFIG_JSON__ $& $\'');
check(embeddedJson(rootMarker,'Config')==='null'&&embeddedJson(rootMarker,'Enrollment')===raw&&JSON.parse(embeddedJson(rootMarker,'PortalRoot').replaceAll("''","'")).certificate==='__CONFIG_JSON__ $& $\'','a root value fills no other marker and uses no replacement pattern');

// 3. The existing variants: $Enrollment is null and the configuration is unchanged.
const registration={id:'0e7f2e57-3a52-4d55-a8a5-0f0a8c1f8b31',token:'a'.repeat(64),origin:'https://portal.test',jobSigningKey:'MFkwEwYH',mode:'Management'};
const personal=installerV3(registration);
check(embeddedJson(personal,'Enrollment')==='null','installerV3 keeps the enrollment marker at null');
check(embeddedJson(personal,'PortalRoot')==='null','installerV3 without a root embeds null');
const personalWithRoot=installerV3(registration,rootDer);
check(embeddedJson(personalWithRoot,'PortalRoot')===`{"certificate":"${rootDer}"}`&&embeddedJson(personalWithRoot,'Config')===embeddedJson(personal,'Config')&&embeddedJson(personalWithRoot,'Enrollment')==='null','installerV3 embeds the root and keeps $Config and $Enrollment');
assert.deepEqual(JSON.parse(embeddedJson(personal,'Config').replaceAll("''","'")),registration);checks++;
assert.deepEqual(JSON.parse(registrationV3(registration)),registration);checks++;
const bootstrap=read('public/Bootstrap-ServerDesk-V3.ps1');
check(bootstrap.startsWith('﻿'),'the public bootstrap keeps its BOM');
check(['Enrollment','Config','PortalRoot'].every(name=>embeddedJson(bootstrap.replaceAll('\r\n','\n'),name)==='null'),'the public bootstrap has all three markers at null');
check(bootstrap.slice(1).replaceAll('\r\n','\n')===expected.replace('__ENROLLMENT_JSON__','null').replace('__CONFIG_JSON__','null').replace('__PORTAL_ROOT_JSON__','null'),'the public bootstrap is the generated template');

// 4. Order and form of the security checks in the customer path.
const at=needle=>{const index=customer.indexOf(needle);assert.notEqual(index,-1,'missing: '+needle);return index;};
const configCheck=at("if(Test-Path -LiteralPath (Join-Path $Root 'config.bin')){throw 'A ServerDesk agent is already registered on this device. The installer does not change an existing registration.'}");
const request=at("/api/agent/enroll','POST'");
const firstNetwork=Math.min(...['UploadString','DownloadString','DownloadFile','Invoke-WebRequest','Invoke-RestMethod'].map(name=>customer.indexOf(name)).filter(index=>index>=0));
check(configCheck<request&&configCheck<firstNetwork,'the config.bin check comes before any request');
check(at("-cnotmatch '^[a-f0-9]{64}$'")<request,'the key format is checked before the request');
check(at("$DeviceName -cnotmatch '^[a-zA-Z0-9._ -]{1,64}$'){throw 'The computer name cannot be used as a device name.'}")<request,'the computer name is checked before the request');
check(at('[Environment]::Is64BitProcess')<configCheck&&at('#requires -RunAsAdministrator')<configCheck,'admin and 64-bit checks come first');
const uploads=[...customer.matchAll(/UploadString\(([^,]+),/g)].map(match=>match[1]);
check(uploads.length===1&&uploads[0]==="[string]$Enrollment.origin+'/api/agent/enroll'"&&!/enroll\?/.test(customer),'the key is never part of a URL: the only request goes to the bare endpoint');
check(!/Enrollment\.installerKey\s*\+|\+\s*\[string\]\$Enrollment\.installerKey/.test(customer),'the key is never concatenated into a string');
check(/\$EnrollRequest=\[ordered\]@\{installerKey=\[string\]\$Enrollment\.installerKey;name=\$DeviceName\}\|ConvertTo-Json -Compress/.test(customer),'the key travels only in the JSON body');
check(customer.includes('$EnrollClient=New-Object ServerDeskReleaseClient')&&customer.includes('http.AllowAutoRedirect = false'),'the request uses the client without redirects');
check(customer.includes("[string]$Registration.origin -cne [string]$Enrollment.origin"),'the answer must name exactly the embedded origin');
check(at("throw ('Registration refused: '+$Reason)")>request,'a refusal shows the portal error');
check(customer.includes("throw 'The answer of the portal is not a valid registration.'"),'an invalid answer stops the script');
check(customer.includes(`Write-Host ('Device "'+$DeviceName+'" registered with the customer "'+[string]$Registration.customerName+'". The agent is installed now.')`),'the success line names device and customer');
check(/\$Config=\[pscustomobject\]@\{id=\[string\]\$Registration\.id;token=\[string\]\$Registration\.token;origin=\[string\]\$Registration\.origin;jobSigningKey=\[string\]\$Registration\.jobSigningKey;mode=\[string\]\$Registration\.mode\}/.test(customer),'exactly the known registration fields go to the EXE');
check(at('$Config=[pscustomobject]')<at("$Arguments=@('--install')"),'the registration precedes the native installation');
check(!/(Set-Content|Out-File|WriteAllText|WriteAllBytes|Add-Content)[^\n]*Enrollment/.test(customer),'the key is never written to disk');
check(customer.includes("if(-not $Enrollment){Assert-Registration $Config}"),'without $Enrollment the registration is checked as before');
// Enroll only after the signed release is verified and the EXE matches
// its signed hash, so a release or trust problem leaves no orphaned device.
check(at('[ServerDeskReleaseSignature]::Verify(')<request,'the release signature is verified before enrolling');
check(at("throw 'The EXE does not match the signed release.'")<request,'the EXE hash is checked before enrolling');
check(customer.includes("if(-not $Enrollment){$Client.Headers['Authorization']='Bearer '+$Config.token}"),'no device bearer before the device exists');
check(customer.includes("$Client.DownloadString($PortalOrigin+'/Agent-v3-release.json?form=path')")&&customer.includes('$Origin=[uri]$PortalOrigin'),'release downloads are bound to the embedded origin before enrolling');
// Path form of 4.12.0: the script asks for it, checks each path case-sensitively,
// resolves it against the registered website and refuses mixed forms.
check(customer.includes(String.raw`if($Path -cnotmatch '^/downloads/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\z' -or $Path.Contains('..')){throw 'The release names a file outside /downloads/ of the registered website.'}`),'a path matches the path rule case-sensitively and has no ..');
check(customer.includes('$Value=([uri]$PortalOrigin).GetLeftPart([UriPartial]::Authority)+$Path')&&customer.includes(' Assert-ReleaseURL $Value'),'a path resolves against the registered website and keeps the address check');
check(customer.split("throw 'The release mixes file paths and full addresses.'").length===3,'mixed forms and entries with both keys are refused');
check(at('$PathForm=Test-ReleasePathForm $Release')<at('$EXEURL=Resolve-ReleaseURL $EXE $PathForm')&&at('$EXEURL=Resolve-ReleaseURL $EXE $PathForm')<request,'every file is resolved before any download and before enrolling');
check(customer.includes('$Client.DownloadFile($PartURL,$PartPath)')&&customer.includes('$Client.DownloadFile($EXEURL,$Executable)')&&!/DownloadFile\(\[string\]\$(?:EXE|Part)\.url/.test(customer),'downloads use only the resolved addresses');
// The release client decodes the signed manifest as UTF-8: the ANSI default of
// WebClient broke the signature check for a changelog with umlauts.
for(const [name,text] of [['template',read('agent/v3/Install-ServerDesk-V3.template.ps1')],['customer',customer],['personal',personal],['bootstrap',bootstrap]])
 check(/\$Client=New-Object ServerDeskReleaseClient\r?\n(?:#[^\r\n]*\r?\n)*\$Client\.Encoding=\[Text\.Encoding\]::UTF8\r?\n/.test(text),`${name}: the release client sets UTF-8 right after it is created`);
// PowerShell 7 reports compiler warnings as errors: without -IgnoreWarnings the
// obsolete WebClient constructor (SYSLIB0014) stops the script before any check.
// ECDsaCng exists only on Windows; ECDsa.Create() works on .NET Framework and .NET.
for(const [name,text] of [['template',read('agent/v3/Install-ServerDesk-V3.template.ps1')],['customer',customer],['personal',personal],['bootstrap',bootstrap]]){
 const lines=text.replaceAll('\r\n','\n').split('\n');
 const start=lines.indexOf("Add-Type -TypeDefinition @'"),end=lines.findIndex((entry,index)=>index>start&&entry.startsWith("'@"));
 const block=lines.slice(start+1,end).join('\n');
 check(start>=0&&block.includes('public sealed class ServerDeskReleaseClient : System.Net.WebClient')&&lines[end]==="'@ -IgnoreWarnings -WarningAction SilentlyContinue",`${name}: the Add-Type that compiles ServerDeskReleaseClient ignores compiler warnings and prints none`);
 check(!text.includes('new ECDsaCng(')&&block.includes('using(ECDsa key=ECDsa.Create()){'),`${name}: the signature check uses ECDsa.Create(), not the Windows-only ECDsaCng`);
}

// 4b. The portal certificate trust step: placement, form and limits.
const templateText=template;
{
 for(const [name,text] of [['customer',customerWithRoot],['personal',personalWithRoot]]){
  const index=needle=>{const found=text.indexOf(needle);assert.notEqual(found,-1,`${name}: missing ${needle}`);return found;};
  const trust=index('if($null -ne $PortalRoot){');
  const first=Math.min(...['DownloadString','DownloadFile','UploadString'].map(call=>text.indexOf(call)).filter(found=>found>=0));
  check(trust<first,`${name}: the trust step comes before the first portal request`);
  check(index("if(Test-Path -LiteralPath (Join-Path $Root 'config.bin'))")<trust&&index("-cnotmatch '^[a-f0-9]{64}$'")<trust&&index("$DeviceName -cnotmatch")<trust&&index('if(-not $Enrollment){Assert-Registration $Config}')<trust&&index('[Environment]::Is64BitProcess')<trust,`${name}: the trust step comes after the admin, 64-bit, config.bin, key and computer name checks`);
  check(index("Add-Type -TypeDefinition @'")<trust,`${name}: the probe helper is compiled before the trust step`);
 }
 const block=templateText.slice(templateText.indexOf('if($null -ne $PortalRoot){'),templateText.indexOf('$Client=New-Object ServerDeskReleaseClient'));
 const helper=templateText.slice(templateText.indexOf('public static class ServerDeskPortalTrust'),templateText.indexOf("'@"));
 check(/^param\(\[ValidateSet\('ReadOnly','Management'\)\]\[string\]\$Mode,\[switch\]\$TrustPortalCertificate\)$/m.test(templateText),'param() has [switch]$TrustPortalCertificate');
 check(templateText.includes("$PortalRoot='__PORTAL_ROOT_JSON__'|ConvertFrom-Json"),'the template has the $PortalRoot marker');
 check(!templateText.includes('ServerCertificateValidationCallback')&&!/ServicePointManager\]::(?!SecurityProtocol)/.test(templateText),'no global validation callback on ServicePointManager');
 check(helper.includes('new SslStream(tcp.GetStream(),false,capture)')&&helper.includes('SslProtocols.Tls12')&&/AuthenticateAsClient\(serverName,/.test(helper),'the probe uses its own SslStream callback with TLS 1.2 and SNI');
 check(!/\.Write\(|token|installerKey|Authorization|Config/i.test(helper.replace(/\/\/[^\n]*/g,'')),'the probe sends no data, token or key');
 check(/RemoteCertificateValidationCallback capture=delegate\([^)]*\) \{[\s\S]*?return false;\n   \};/.test(helper),'the capture callback refuses, so the handshake ends there');
 check(helper.includes('new X509Chain(true)')&&!helper.includes('new X509Chain()')&&!helper.includes('new X509Chain(false)'),'chains are built in the machine context');
 check(helper.includes('if(probe.NameMismatch) return false;'),'the normal check requires a matching name');
 // The certificate's own names decide as well: SAN only, parsed from DER, no subject fallback.
 check(helper.includes('public static bool NameMatches(X509Certificate2 certificate,string host)')&&helper.includes('"2.5.29.17"'),'NameMatches reads the subject alternative name extension');
 check(!helper.includes('.Format(')&&!/X509NameType\.(?:DnsName|SimpleName)|GetNameInfo/.test(helper),'NameMatches uses neither the locale-dependent Format() nor the subject name');
 check(helper.includes('result.NameMismatch=(errors&SslPolicyErrors.RemoteCertificateNameMismatch)!=0;')&&helper.includes('if(!NameMatches(result.Certificate,serverName)) result.NameMismatch=true;')&&helper.indexOf('if(!NameMatches(result.Certificate,serverName))')<helper.indexOf(' return result;'),'Probe combines the callback flag with NameMatches');
 const decide=helper.slice(helper.indexOf('public static string Decide('));
 check(decide.indexOf('if(probe.NameMismatch) return "NameMismatch";')>=0&&decide.indexOf('if(probe.NameMismatch) return "NameMismatch";')<decide.indexOf('if(Trusted(probe))'),'Decide returns NameMismatch before anything else');
 const nameThrow=block.indexOf("if($Decision -eq 'NameMismatch'){throw ('The portal certificate is not valid for '+$TrustURI.DnsSafeHost+'. The certificate must contain this name or IP address. Ask the portal administrator to issue the certificate for this address (CADDY_ADDRESS with the same host as SITE_ORIGIN), then run the script again.')}");
 check(nameThrow>block.indexOf('$Decision=[ServerDeskPortalTrust]::Decide(')&&['The portal certificate is not trusted on this computer, and it does not come from','Write-Host','if(-not $TrustPortalCertificate)','PromptForChoice','$Store.Add('].every(needle=>block.indexOf(needle)>nameThrow),'a name mismatch stops with S9 before S5, any output, the switch, the prompt and the import');
 check(/chain\.ChainPolicy\.ExtraStore\.Add\(new X509Certificate2\(root\)\);\n   chain\.ChainPolicy\.VerificationFlags=X509VerificationFlags\.AllowUnknownCertificateAuthority;/.test(helper),'the second chain adds only the embedded root and allows the unknown root');
 check(helper.includes('if((problems&~X509ChainStatusFlags.UntrustedRoot)!=X509ChainStatusFlags.NoError')&&helper.indexOf('if(last[index]!=root[index]) return "Foreign";')<helper.indexOf('return "Offer";'),'Offer only with the untrusted root as the only problem and the exact root bytes at the chain end');
 check(block.split("X509Store('Root','LocalMachine')").length===2&&!templateText.includes('CurrentUser'),"the only store is 'Root','LocalMachine', never CurrentUser");
 check(block.split('$Store.Add(').length===2&&block.includes('try{$Store.Add($RootCertificate)}finally{$Store.Close()}')&&block.includes('$Store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)'),'only the embedded root is added, then the store is closed');
 check(block.includes('$RootCertificate=[Security.Cryptography.X509Certificates.X509Certificate2]::new($RootBytes)')&&block.includes('$RootBytes=[Convert]::FromBase64String([string]$PortalRoot.certificate)'),'the imported certificate is the embedded root');
 const offerThrow=block.indexOf("if($Decision -ne 'Offer'){throw 'The portal certificate is not trusted on this computer, and it does not come from the root certificate in this script. Check the portal address and its certificate.'}");
 check(offerThrow>block.indexOf("if($Decision -ne 'Trusted'){")&&offerThrow<block.indexOf('Write-Host')&&offerThrow<block.indexOf('if(-not $TrustPortalCertificate)')&&offerThrow<block.indexOf('$Store.Add('),'a chain that does not end at the embedded root stops before the output, the switch and the import');
 check(/\(New-Object Management\.Automation\.Host\.ChoiceDescription '&Import','Import the root certificate and continue the installation\.'\),\n\s+\(New-Object Management\.Automation\.Host\.ChoiceDescription '&Cancel','Stop without changes\.'\)\)/.test(block),'the choices are &Import and &Cancel');
 check(block.includes("$Host.UI.PromptForChoice('Import root certificate','Compare the fingerprint with Settings in the portal. Import this root certificate into the trusted root certificates of this computer (Cert:\\LocalMachine\\Root)?',$Choices,1)"),'the prompt defaults to index 1, Cancel');
 check(block.includes("if($Choice -ne 0){throw 'The root certificate was not imported."),'only Import (index 0) continues');
 check(block.indexOf('if(-not $TrustPortalCertificate){')<block.indexOf('PromptForChoice')&&block.indexOf('PromptForChoice')<block.indexOf('$Store.Add('),'the switch skips only the question');
 check(block.indexOf("Write-Host ('SHA-256: '+[ServerDeskPortalTrust]::Fingerprint($RootBytes))")<block.indexOf('if(-not $TrustPortalCertificate){'),'name and fingerprint are printed with and without the switch');
 check(block.indexOf('$Store.Add(')<block.indexOf("Write-Host ('Root certificate imported into Cert:\\LocalMachine\\Root (thumbprint '+$RootCertificate.Thumbprint+').')")&&block.includes("[ServerDeskPortalTrust]::Probe($TrustURI.DnsSafeHost,$TrustURI.Port,$TrustURI.DnsSafeHost,30000))){throw 'The portal certificate is still not trusted after the import."),'after the import the normal check runs again');
 check(!/DownloadData|\.(?:crt|cer)\b|Invoke-WebRequest|Invoke-RestMethod/i.test(templateText),'no certificate is fetched over the network');
}

// The release manifest route names its charset.
{
 const {sourceLoader}=await import('../support/source-database.mjs');
 const HttpError=realHttpError;
 const manifest='{"changelog":"Größere Änderungen für Übersicht"}';
 const route=sourceLoader()('app/Agent-v3-release.json/route.ts',{'@/lib/server/agent/releases':{bootstrapLatestRelease:async()=>({id:'00000000-0000-4000-8000-000000000001',version:'4.13.0',manifest,signature:'c2ln',sha256:'a'.repeat(64),size:1,createdAt:1})},'@/lib/server/context':{HttpError,failure:error=>Response.json({error:error.message},{status:error.status??503})}});
 const response=await route.GET(new Request('https://portal.test/Agent-v3-release.json?form=path'));
 check(response.headers.get('content-type')==='application/json; charset=utf-8','/Agent-v3-release.json sends charset=utf-8');
 check(JSON.parse(Buffer.from(await response.arrayBuffer()).toString('utf8')).manifest===manifest,'the manifest bytes are UTF-8');
}

// 5. Parse all three variants with every PowerShell that is available: pwsh
// (PowerShell 7, also the one of the Linux CI runner) and powershell.exe
// (Windows PowerShell 5.1). Sections 6 and 7 run on each of them as well.
const shells=['pwsh','powershell.exe'].filter(shell=>{const probe=spawnSync(shell,['-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.Major'],{encoding:'utf8',timeout:60_000});return probe.status===0;});
if(!shells.length)console.log('SKIP PowerShell parse check: neither pwsh nor powershell.exe is available.');
for(const shell of shells){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'serverdesk-installer-'));
 try{
  const files={customer:'﻿'+customer,personal:'﻿'+personal,bootstrap};
  for(const [name,text] of Object.entries(files))fs.writeFileSync(path.join(directory,name+'.ps1'),text);
  const command=`$failed=0;foreach($file in Get-ChildItem -LiteralPath '${directory.replaceAll("'","''")}' -Filter *.ps1){$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors);if($errors.Count){$failed++;Write-Output ($file.Name+': '+($errors|ForEach-Object Message|Select-Object -First 3) -join '; ')}};exit $failed`;
  const result=spawnSync(shell,['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',timeout:120_000});
  check(result.status===0,`${shell} parses all three variants: ${result.stdout}${result.stderr}`);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
 // 6. Behaviour: the script's own release client, origin selection and signature
 // check verify a manifest with non-ASCII text, served without a charset so the
 // client's own decoding decides. Then the form check and the path resolution of
 // the script run on signed path-form, absolute and invalid manifests.
 const {publicKey,privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const testJwk=publicKey.export({format:'jwk'}),testPoint=Buffer.concat([Buffer.from([4]),Buffer.from(testJwk.x,'base64url'),Buffer.from(testJwk.y,'base64url')]).toString('base64');
 const envelopeOf=manifest=>JSON.stringify({manifest,signature:crypto.sign('sha256',Buffer.from(manifest,'utf8'),privateKey).toString('base64')});
 let envelope=envelopeOf(JSON.stringify({version:'4.7.3',changelog:{features:['Größere Änderungen für die Übersicht'],fixes:['Überprüfung schneller']}}));
 const http=await import('node:http'),{execFile}=await import('node:child_process');
 const requested=[];
 const server=http.createServer((request,response)=>{requested.push(request.url);response.writeHead(request.url.split('?')[0]==='/Agent-v3-release.json'?200:404,{'Content-Type':'application/json'});response.end(Buffer.from(envelope,'utf8'));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const directory2=fs.mkdtempSync(path.join(os.tmpdir(),'serverdesk-release-'));
 try{
  const lines=customer.split('\n');
  const slice=(from,to)=>{const start=lines.findIndex(entry=>entry.startsWith(from)),end=lines.findIndex((entry,index)=>index>=start&&entry.includes(to));assert.ok(start>=0&&end>=start,'segment '+from);return lines.slice(start,end+1).join('\n');};
  const addType=slice("Add-Type -TypeDefinition @'","'@");
  const origin=slice('$PortalOrigin=','$PortalOrigin=');
  const functions=slice('function Assert-ReleaseURL(',' return $Value');
  const client=slice('$Client=New-Object ServerDeskReleaseClient',"$Client.Headers['Authorization']");
  const verify=slice(' $ReleaseJSON=','The release signature does not match').replace(`FromBase64String('${point}')`,`FromBase64String('${testPoint}')`);
  const forms=slice(' $Release=$Envelope.manifest|ConvertFrom-Json',' foreach($File in @(Get-ReleaseFiles $Release))');
  check(verify.includes(testPoint),'the probe checks against the test publisher');
  // The download comes from the local test server; the files resolve against an HTTPS website.
  const run=async resolveFiles=>{
   const resolution=resolveFiles?`$PortalOrigin='https://portal.test:8443'\n${forms}\nforeach($File in @(Get-ReleaseFiles $Release)){Write-Output ('FILE '+(Resolve-ReleaseURL $File $PathForm))}\n`:'';
   const probe=`$ErrorActionPreference='Stop'\n${addType}\n$Enrollment=[pscustomobject]@{origin='http://127.0.0.1:${server.address().port}'}\n$Config=$null\n${origin}\n${functions}\n}\n${client}\ntry{\n${verify}\nWrite-Output 'VERIFIED'\n${resolution}}catch{Write-Output ('FAILED '+$_.Exception.Message)}\n`;
   const file=path.join(directory2,'release.ps1');fs.writeFileSync(file,'﻿'+probe);
   return new Promise(resolve=>execFile(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file],{encoding:'utf8',timeout:120_000},(_error,stdout,stderr)=>resolve(stdout+stderr)));
  };
  const output=await run(false);
  check(/^VERIFIED\s*$/m.test(output),`${shell}: the release client verifies a signed UTF-8 manifest with umlauts: ${output.trim().slice(0,400)}`);
  check(requested.at(-1)==='/Agent-v3-release.json?form=path',`${shell}: the script asks for the path form`);
  const hash='a'.repeat(64),manifest=file=>JSON.stringify({version:'4.12.0',protocolVersion:3,minProtocolVersion:3,os:['Windows 11 Pro'],arch:'x64',...file('agent.zip'),sha256:hash,size:30,layout:'single-exe',exe:{...file('agent.exe'),sha256:hash,size:30,parts:[{...file('agent.exe.part1'),sha256:hash,size:10},{...file('agent.exe.part2'),sha256:hash,size:20}]},createdAt:'2026-11-01T10:00:00.000Z'});
  const files=['agent.zip','agent.exe','agent.exe.part1','agent.exe.part2'].map(name=>'FILE https://portal.test:8443/downloads/'+name).join('\n');
  const outside='FAILED The release names a file outside /downloads/ of the registered website.',mixed='FAILED The release mixes file paths and full addresses.';
  const cases=[
   ['the path form resolves against the registered website',manifest(name=>({path:'/downloads/'+name})),files],
   ['the absolute form on the registered website is accepted',manifest(name=>({url:'https://portal.test:8443/downloads/'+name})),files],
   ['/downloads/../x is refused',manifest(name=>({path:name==='agent.exe.part2'?'/downloads/../x':'/downloads/'+name})),outside],
   ['a path in another case is refused',manifest(name=>({path:(name==='agent.exe'?'/Downloads/':'/downloads/')+name})),outside],
   ['a nested path is refused',manifest(name=>({path:'/downloads/'+(name==='agent.zip'?'a/b':name)})),outside],
   ['a path with a trailing line break is refused',manifest(name=>({path:'/downloads/'+name+(name==='agent.exe'?'\n':'')})),outside],
   ['mixed forms are refused',manifest(name=>name==='agent.exe.part1'?{url:'https://portal.test:8443/downloads/'+name}:{path:'/downloads/'+name}),mixed],
   ['an entry with both keys is refused',manifest(name=>({path:'/downloads/'+name,...(name==='agent.exe'?{url:'https://portal.test:8443/downloads/'+name}:{})})),mixed],
   ['a foreign website is refused',manifest(name=>({url:'https://evil.test:8443/downloads/'+name})),'FAILED The release address is outside the registered website.'],
  ];
  for(const [label,text,expected] of cases){
   envelope=envelopeOf(text);
   const result=(await run(true)).replaceAll('\r\n','\n').trim();
   check(result==='VERIFIED\n'+expected,`${shell}: ${label}: ${result.slice(0,400)}`);
  }
 }finally{server.close();fs.rmSync(directory2,{recursive:true,force:true});}
 await portalTrustBehaviour(shell);
}

// 7. Behaviour of the portal trust step. The fixtures (tests/fixtures/portal-ca)
// feed the decision helper without a network: a chain to the embedded root is
// offered, a foreign root or a name mismatch is not, and the host is matched
// against the certificate's subject alternative names. With openssl, a fresh chain
// with keys serves a local TLS server for the real handshake and for the trust
// step of the script itself, which runs without a console, so it can never import.
async function portalTrustBehaviour(shell){
 const checkOn=(condition,label)=>check(condition,`${shell}: ${label}`);
 const fixture=name=>new crypto.X509Certificate(read(`tests/fixtures/portal-ca/${name}.crt`));
 const b64=certificate=>certificate.raw.toString('base64');
 const lines=customer.split('\n');
 const addType=lines.slice(lines.findIndex(entry=>entry.startsWith("Add-Type -TypeDefinition @'")),lines.findIndex(entry=>entry.startsWith("'@"))+1).join('\n');
 const trustStep=customer.slice(customer.indexOf('if($null -ne $PortalRoot){'),customer.indexOf('$Client=New-Object ServerDeskReleaseClient'));
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'serverdesk-portal-trust-'));
 const runScript=(name,body)=>{
  const file=path.join(directory,name);fs.writeFileSync(file,'﻿'+`$ErrorActionPreference='Stop'\n${addType}\n${body}`);
  return new Promise(resolve=>execFileCallback(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file],{encoding:'utf8',timeout:180_000},(_error,stdout,stderr)=>resolve((stdout+stderr).replaceAll('\r\n','\n'))));
 };
 const {execFile:execFileCallback}=await import('node:child_process');
 try{
  // 7a. Fixtures, no network.
  const certificate=name=>`[Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String('${b64(fixture(name))}'))`;
  const bytes=name=>`[Convert]::FromBase64String('${b64(fixture(name))}')`;
  // NameMatches against the fixtures, then against certificates whose SAN bytes
  // the test writes itself (wildcards, IDN, length forms and broken DER).
  const tlv=(tag,content)=>{const body=Buffer.from(content),size=body.length<128?[body.length]:[0x81,body.length];return Buffer.concat([Buffer.from([tag,...size]),body]);};
  const dns=text=>tlv(0x82,Buffer.from(text,'ascii')),exact=dns('exact.test');
  const custom={
   wildcards:tlv(0x30,Buffer.concat([dns('f*.x.test'),dns('*'),dns('*.*.y.test'),dns('xn--bcher-kva.test'),dns('dot.test.'),tlv(0xa4,Buffer.from([0x30,0]))])),
   longForm:Buffer.concat([Buffer.from([0x30,0x81,exact.length]),exact]),
   empty:Buffer.from([0x30,0]),
   truncated:tlv(0x30,exact).subarray(0,-1),
   indefinite:Buffer.concat([Buffer.from([0x30,0x80]),exact,Buffer.from([0,0])]),
   trailing:Buffer.concat([tlv(0x30,exact),Buffer.from([0])]),
   brokenAfterMatch:Buffer.concat([Buffer.from([0x30,exact.length+3]),exact,Buffer.from([0x82,0x05,0x61])]),
   notSequence:tlv(0x31,exact),
   hugeLength:Buffer.concat([Buffer.from([0x30,0x85,0,0,0,0,exact.length]),exact]),
   highTag:tlv(0x30,Buffer.concat([exact,Buffer.from([0x9f,0x1f,0x01,0x00])])),
  };
  const nameCases=[
   ['leaf','portal.test',true],['leaf','PORTAL.TEST',true],['leaf','127.0.0.1',true],['leaf','127.0.0.2',false],['leaf','other.test',false],['leaf','::1',false],
   ['other-leaf','127.0.0.1',false],['other-leaf','other.test',true],['root','portal.test',false],
   ['san-leaf','a.wild.test',true],['san-leaf','A.Wild.Test',true],['san-leaf','exact.test',true],['san-leaf','exact.test.',true],['san-leaf','10.0.0.5',true],['san-leaf','fd00:0:0::5',true],['san-leaf','[fd00::5]',true],['san-leaf','fd00::5%3',true],
   ['san-leaf','wild.test',false],['san-leaf','a.b.wild.test',false],['san-leaf','.wild.test',false],['san-leaf','10.0.0.6',false],['san-leaf','cn-only.test',false],['san-leaf','fd00::6',false],['san-leaf','',false],
   ['wildcards','fx.x.test',false],['wildcards','foo.x.test',false],['wildcards','anything',false],['wildcards','a.b.y.test',false],['wildcards','bücher.test',true],['wildcards','xn--bcher-kva.test',true],['wildcards','dot.test',true],
   ['longForm','exact.test',true],
   ...['empty','truncated','indefinite','trailing','brokenAfterMatch','notSequence','hugeLength','highTag'].map(name=>[name,'exact.test',false]),
  ];
  const nameCertificate=name=>custom[name]?`(San ([Convert]::FromBase64String('${custom[name].toString('base64')}')))`:certificate(name);
  const decisions=await runScript('decide.ps1',[
   // A throwaway self-signed certificate that carries the given SAN bytes.
   "function San([byte[]]$Names){$Key=[Security.Cryptography.ECDsa]::Create();$Request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=exact.test',$Key,[Security.Cryptography.HashAlgorithmName]::SHA256);$Request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509Extension]::new('2.5.29.17',$Names,$false));$Request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddDays(1))}",
   '$Probe=New-Object ServerDeskPortalProbe',`$Probe.Certificate=${certificate('leaf')}`,`[void]$Probe.Intermediates.Add(${certificate('intermediate')})`,
   `Write-Output ('MATCH '+[ServerDeskPortalTrust]::Decide($Probe,${bytes('root')}))`,
   `Write-Output ('FOREIGN '+[ServerDeskPortalTrust]::Decide($Probe,${bytes('foreign-root')}))`,
   `$Probe.NameMismatch=$true;Write-Output ('NAME '+[ServerDeskPortalTrust]::Decide($Probe,${bytes('root')}))`,
   `$Other=New-Object ServerDeskPortalProbe;$Other.Certificate=${certificate('other-leaf')};[void]$Other.Intermediates.Add(${certificate('intermediate')});$Other.NameMismatch=$true`,
   `Write-Output ('OTHER '+[ServerDeskPortalTrust]::Decide($Other,${bytes('root')}))`,
   `Write-Output ('FINGERPRINT '+[ServerDeskPortalTrust]::Fingerprint(${bytes('root')}))`,
   ...nameCases.map(([name,host],index)=>`Write-Output ('SAN ${index} '+[ServerDeskPortalTrust]::NameMatches(${nameCertificate(name)},'${host}'))`),
  ].join('\n'));
  checkOn(/^MATCH Offer$/m.test(decisions),`a chain that ends at the embedded root is offered: ${decisions.slice(0,600)}`);
  checkOn(/^FOREIGN Foreign$/m.test(decisions),'a foreign embedded root is not offered');
  checkOn(/^NAME NameMismatch$/m.test(decisions)&&/^OTHER NameMismatch$/m.test(decisions),'a name mismatch is not offered and has its own decision');
  checkOn(decisions.includes('FINGERPRINT '+fixture('root').fingerprint256),'the script computes the same fingerprint as Node (fingerprint256)');
  nameCases.forEach(([name,host,expected],index)=>checkOn(new RegExp(`^SAN ${index} ${expected?'True':'False'}$`,'m').test(decisions),`NameMatches(${name}, ${host}) is ${expected}: ${decisions.slice(0,300)}`));
  // 7b. A real handshake and the trust step, only with openssl.
  if(spawnSync('openssl',['version'],{encoding:'utf8'}).status!==0){console.log('SKIP portal trust handshake: openssl is not available.');return;}
  const chain=generatedChain(directory);
  const tls=await import('node:tls');
  const serve=leaf=>new Promise(resolve=>{const server=tls.createServer({key:chain[leaf+'Key'],cert:chain[leaf]+chain.intermediate,minVersion:'TLSv1.2'},socket=>{socket.on('error',()=>{});socket.resume();});server.on('tlsClientError',()=>{});server.listen(0,'127.0.0.1',()=>resolve(server));});
  const portal=await serve('leaf'),other=await serve('otherLeaf'),dnsOnly=await serve('dnsOnly');
  try{
   const rootB64=new crypto.X509Certificate(chain.root).raw.toString('base64'),foreignB64=new crypto.X509Certificate(chain.foreign).raw.toString('base64');
   const thumbprint=new crypto.X509Certificate(chain.root).fingerprint.replaceAll(':','');
   const steps=[
    `$P=[ServerDeskPortalTrust]::Probe('127.0.0.1',${portal.address().port},'portal.test',30000)`,
    `Write-Output ('PROBE '+$P.NameMismatch+' '+$P.Intermediates.Count+' '+$P.Certificate.Thumbprint+' '+[ServerDeskPortalTrust]::Decide($P,[Convert]::FromBase64String('${rootB64}')))`,
    `$O=[ServerDeskPortalTrust]::Probe('127.0.0.1',${other.address().port},'portal.test',30000)`,
    `Write-Output ('OTHERNAME '+$O.NameMismatch+' '+[ServerDeskPortalTrust]::Decide($O,[Convert]::FromBase64String('${rootB64}')))`,
    // A certificate with only DNS:portal.test, reached by IP: .NET Framework reports no name problem, the SAN check does.
    `$D=[ServerDeskPortalTrust]::Probe('127.0.0.1',${dnsOnly.address().port},'127.0.0.1',30000)`,
    `Write-Output ('DNSONLY '+$D.NameMismatch+' '+[ServerDeskPortalTrust]::Decide($D,[Convert]::FromBase64String('${rootB64}')))`,
    // The trust step of the script against https://127.0.0.1:<port>, without a console.
    `$PortalOrigin='https://127.0.0.1:${portal.address().port}'`,
    `$TrustStep={\n${trustStep}\n}`,
    ...[['OFFER',rootB64],['MISMATCH',foreignB64]].map(([label,value])=>`$PortalRoot='{"certificate":"${value}"}'|ConvertFrom-Json\nWrite-Output 'CASE ${label}'\ntry{& $TrustStep;Write-Output 'CONTINUED'}catch{Write-Output ('STOPPED '+$_.Exception.Message)}`),
    `$PortalOrigin='https://127.0.0.1:${dnsOnly.address().port}'`,
    `$TrustPortalCertificate=$true`,
    `$PortalRoot='{"certificate":"${rootB64}"}'|ConvertFrom-Json
Write-Output 'CASE IPNAME'
try{& $TrustStep;Write-Output 'CONTINUED'}catch{Write-Output ('STOPPED '+$_.Exception.Message)}`,
    `Write-Output 'CASE END'`,
    `Write-Output ('IMPORTED '+(Test-Path -LiteralPath 'Cert:\\LocalMachine\\Root\\${thumbprint}')+' '+(Test-Path -LiteralPath 'Cert:\\CurrentUser\\Root\\${thumbprint}'))`,
   ];
   const output=await runScript('handshake.ps1',steps.join('\n'));
   const leafThumbprint=new crypto.X509Certificate(chain.leaf).fingerprint.replaceAll(':','');
   checkOn(new RegExp(`^PROBE False [1-9]\\d* ${leafThumbprint} Offer$`,'m').test(output),`the handshake returns the leaf and the sent intermediate, the name matches, and the chain is offered: ${output.slice(0,800)}`);
   checkOn(/^OTHERNAME True NameMismatch$/m.test(output),'a leaf for another name is a name mismatch and is not offered');
   checkOn(/^DNSONLY True NameMismatch$/m.test(output),`a leaf with only a DNS name, reached by IP, is a name mismatch: ${output.slice(0,800)}`);
   const offer=output.slice(output.indexOf('CASE OFFER'),output.indexOf('CASE MISMATCH')),mismatch=output.slice(output.indexOf('CASE MISMATCH'),output.indexOf('CASE IPNAME')),ipName=output.slice(output.indexOf('CASE IPNAME'),output.indexOf('CASE END'));
   checkOn(offer.includes(`The portal https://127.0.0.1:${portal.address().port} uses a certificate from its own certificate authority.`)&&offer.includes('Name: Generated Test Root')&&offer.includes('SHA-256: '+new crypto.X509Certificate(chain.root).fingerprint256),`S1 to S3 show the origin, the name and Node's fingerprint: ${offer.slice(0,800)}`);
   checkOn(offer.includes('STOPPED The portal certificate is not trusted on this computer. Run the script with -TrustPortalCertificate to import the root certificate in this script, or import it by hand.')&&!offer.includes('CONTINUED')&&!offer.includes('Root certificate imported'),'without a console and without the switch the script stops with S6');
   checkOn(mismatch.includes('STOPPED The portal certificate is not trusted on this computer, and it does not come from the root certificate in this script. Check the portal address and its certificate.')&&!mismatch.includes('SHA-256:')&&!mismatch.includes('Name:'),'a foreign embedded root stops with S5 and shows nothing to import');
   checkOn(ipName.includes('STOPPED The portal certificate is not valid for 127.0.0.1. The certificate must contain this name or IP address. Ask the portal administrator to issue the certificate for this address (CADDY_ADDRESS with the same host as SITE_ORIGIN), then run the script again.')&&!/Name:|SHA-256:|Root certificate imported|CONTINUED/.test(ipName),`an IP origin with a DNS-only certificate stops with S9 even with -TrustPortalCertificate and shows nothing to import: ${ipName.slice(0,800)}`);
   checkOn(/^IMPORTED False False$/m.test(output),'nothing was imported into any root store');
  }finally{portal.close();other.close();dnsOnly.close();}
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}

// A throwaway chain with keys for the handshake test: root, intermediate, a leaf
// for portal.test and 127.0.0.1, a leaf for other.test, a leaf for portal.test
// only and a foreign root.
function generatedChain(directory){
 const file=name=>path.join(directory,name);
 const openssl=(...args)=>{const result=spawnSync('openssl',args,{encoding:'utf8'});assert.equal(result.status,0,`openssl ${args.join(' ')}: ${result.stderr}`);};
 const key=name=>openssl('genpkey','-algorithm','EC','-pkeyopt','ec_paramgen_curve:P-256','-out',file(name+'.key'));
 const ca='basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n';
 for(const [name,subject] of [['root','/CN=Generated Test Root'],['foreign','/CN=Generated Foreign Root']]){key(name);openssl('req','-x509','-key',file(name+'.key'),'-out',file(name+'.crt'),'-subj',subject,'-days','3650','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign');}
 const issue=(name,subject,issuer,extensions,serial)=>{
  key(name);openssl('req','-new','-key',file(name+'.key'),'-subj',subject,'-out',file(name+'.csr'));
  fs.writeFileSync(file(name+'.ext'),extensions);
  openssl('x509','-req','-in',file(name+'.csr'),'-CA',file(issuer+'.crt'),'-CAkey',file(issuer+'.key'),'-out',file(name+'.crt'),'-days','3000','-extfile',file(name+'.ext'),'-set_serial',String(serial));
 };
 issue('intermediate','/CN=Generated Test Intermediate','root',ca,2);
 const leaf=san=>`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=critical,${san}\n`;
 issue('leaf','/CN=portal.test','intermediate',leaf('DNS:portal.test,IP:127.0.0.1'),3);
 issue('other','/CN=other.test','intermediate',leaf('DNS:other.test'),4);
 issue('dnsOnly','/CN=127.0.0.1','intermediate',leaf('DNS:portal.test'),5);
 const text=name=>fs.readFileSync(file(name),'utf8');
 return {root:text('root.crt'),foreign:text('foreign.crt'),intermediate:text('intermediate.crt'),leaf:text('leaf.crt'),leafKey:text('leaf.key'),otherLeaf:text('other.crt'),otherLeafKey:text('other.key'),dnsOnly:text('dnsOnly.crt'),dnsOnlyKey:text('dnsOnly.key')};
}
console.log(`${checks} customer installer script checks passed.`);
