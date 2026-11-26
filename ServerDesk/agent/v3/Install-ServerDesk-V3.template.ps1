#requires -Version 5.1
#requires -RunAsAdministrator
# Optional download convenience only. The installed agent is one EXE and does
# not execute this script or require any PowerShell script files at runtime.
[CmdletBinding()]
param([ValidateSet('ReadOnly','Management')][string]$Mode,[switch]$TrustPortalCertificate)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if(-not [Environment]::Is64BitProcess){throw 'Use a 64-bit administrator console.'}
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Security
$Root=Join-Path $env:ProgramData 'ServerDesk'
$Enrollment='__ENROLLMENT_JSON__'|ConvertFrom-Json
$Config='__CONFIG_JSON__'|ConvertFrom-Json
# The public root certificate of the portal's own CA, or null (public certificate).
$PortalRoot='__PORTAL_ROOT_JSON__'|ConvertFrom-Json
if($Enrollment){
 # Customer installer: this device registers itself with the portal first. An
 # existing registration is never replaced, and nothing is sent before this check.
 if(Test-Path -LiteralPath (Join-Path $Root 'config.bin')){throw 'A ServerDesk agent is already registered on this device. The installer does not change an existing registration.'}
 $EnrollUri=$null
 if(-not [Uri]::TryCreate([string]$Enrollment.origin,[UriKind]::Absolute,[ref]$EnrollUri) -or $EnrollUri.Scheme -ne 'https' -or $EnrollUri.AbsolutePath -ne '/' -or $EnrollUri.UserInfo -or $EnrollUri.Query -or $EnrollUri.Fragment -or [string]$Enrollment.installerKey -cnotmatch '^[a-f0-9]{64}$'){throw 'Invalid installer.'}
 $DeviceName=[string]$env:COMPUTERNAME
 if($DeviceName -cnotmatch '^[a-zA-Z0-9._ -]{1,64}$'){throw 'The computer name cannot be used as a device name.'}
}elseif(-not $Config){
 $Path=Join-Path $Root 'config.bin'
 if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw 'For a new device, download the EXE and the registration file in the portal.'}
 $Plain=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($Path),$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
 try{$Config=[Text.Encoding]::UTF8.GetString($Plain)|ConvertFrom-Json}finally{[Array]::Clear($Plain,0,$Plain.Length)}
}
function Assert-Registration($Value){
 $SiteUri=$null
 if(-not [Uri]::TryCreate([string]$Value.origin,[UriKind]::Absolute,[ref]$SiteUri) -or $SiteUri.Scheme -ne 'https' -or $SiteUri.AbsolutePath -ne '/' -or $SiteUri.UserInfo -or $SiteUri.Query -or $SiteUri.Fragment -or $Value.token -notmatch '^[a-fA-F0-9]{64}$'){throw 'Invalid registration.'}
}
if(-not $Enrollment){Assert-Registration $Config}
# The customer installer knows only the embedded origin until it enrolls.
$PortalOrigin=if($Enrollment){[string]$Enrollment.origin}else{[string]$Config.origin}
function Assert-ReleaseURL([string]$Value){
 $URI=[uri]$Value;$Origin=[uri]$PortalOrigin
 if($URI.Scheme -ne 'https' -or $URI.Authority -ne $Origin.Authority -or $URI.UserInfo -or $URI.Query -or $URI.Fragment -or -not $URI.AbsolutePath.StartsWith('/downloads/')){throw 'The release address is outside the registered website.'}
}
# A release names each file either by a path below /downloads/ (path form, the
# same signature on every portal) or by a full address on this website (older
# portals). All files of one release use one form.
function Get-ReleaseFiles($Release){
 $Files=@($Release)
 if($null -ne $Release.parts){$Files+=@($Release.parts)}
 if($null -ne $Release.exe){$Files+=@($Release.exe);if($null -ne $Release.exe.parts){$Files+=@($Release.exe.parts)}}
 return $Files
}
function Test-ReleasePathForm($Release){
 $Paths=0;$URLs=0
 foreach($File in @(Get-ReleaseFiles $Release)){
  $HasPath=$null -ne $File -and $null -ne $File.PSObject.Properties['path']
  $HasURL=$null -ne $File -and $null -ne $File.PSObject.Properties['url']
  if($HasPath -and $HasURL){throw 'The release mixes file paths and full addresses.'}
  if($HasPath){$Paths++}elseif($HasURL){$URLs++}else{throw 'No compatible signed single-EXE release is available.'}
 }
 if($Paths -and $URLs){throw 'The release mixes file paths and full addresses.'}
 return [bool]$Paths
}
# A path resolves against the registered website; a full address keeps its check.
function Resolve-ReleaseURL($File,[bool]$PathForm){
 if($PathForm){
  $Path=[string]$File.path
  if($Path -cnotmatch '^/downloads/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\z' -or $Path.Contains('..')){throw 'The release names a file outside /downloads/ of the registered website.'}
  $Value=([uri]$PortalOrigin).GetLeftPart([UriPartial]::Authority)+$Path
 }else{$Value=[string]$File.url}
 Assert-ReleaseURL $Value
 return $Value
}
# -IgnoreWarnings: PowerShell 7 reports every compiler warning as an error, and
# .NET 6 and later mark the WebClient constructor obsolete (SYSLIB0014), .NET 9
# and later the X509Certificate2 byte constructor (SYSLIB0057). The warnings
# change nothing at run time, so -WarningAction keeps them off the console too.
# Windows PowerShell 5.1 compiles the same code.
Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
public static class ServerDeskReleaseSignature {
 public static bool Verify(byte[] point, byte[] data, byte[] der) {
  if(point.Length!=65 || point[0]!=4) throw new CryptographicException("Invalid P256 trust anchor");
  byte[] x=new byte[32],y=new byte[32];Buffer.BlockCopy(point,1,x,0,32);Buffer.BlockCopy(point,33,y,0,32);
  byte[] signature=new byte[64];int p=0;
  if(der.Length<8 || der[p++]!=0x30)throw new CryptographicException("Invalid signature");
  int length=der[p++];if(length>=128 || length!=der.Length-2)throw new CryptographicException("Invalid signature length");
  for(int component=0;component<2;component++){
   if(p>=der.Length || der[p++]!=2)throw new CryptographicException("Invalid integer");
   if(p>=der.Length)throw new CryptographicException("Invalid integer length");int n=der[p++];
   if(n<1 || n>33 || p+n>der.Length || (der[p]&128)!=0)throw new CryptographicException("Invalid integer");
   if(n==33){if(der[p++]!=0)throw new CryptographicException("Invalid integer padding");n--;}
   Buffer.BlockCopy(der,p,signature,component*32+32-n,n);p+=n;
  }
  if(p!=der.Length)throw new CryptographicException("Trailing signature data");
  // ECDsa.Create() is ECDsaCng on .NET Framework and the platform key on .NET 8 and later.
  using(ECDsa key=ECDsa.Create()){
   ECParameters parameters=new ECParameters();parameters.Curve=ECCurve.NamedCurves.nistP256;parameters.Q=new ECPoint{X=x,Y=y};key.ImportParameters(parameters);
   return key.VerifyData(data,signature,HashAlgorithmName.SHA256);
  }
 }
 }
public sealed class ServerDeskReleaseClient : System.Net.WebClient {
 protected override System.Net.WebRequest GetWebRequest(Uri address) {
  var request = base.GetWebRequest(address);
  var http = request as System.Net.HttpWebRequest;
  if(http != null) { http.AllowAutoRedirect = false; http.Timeout = 300000; http.ReadWriteTimeout = 300000; }
  return request;
 }
}
// What one TLS handshake with the portal showed: its certificate, the chain
// certificates it came with, and whether its name matches the address.
public sealed class ServerDeskPortalProbe {
 public X509Certificate2 Certificate;
 public X509Certificate2Collection Intermediates=new X509Certificate2Collection();
 public bool NameMismatch;
}
public static class ServerDeskPortalTrust {
 // TCP connection and TLS handshake only: no HTTP request, no token and no key
 // are sent. The callback belongs to this stream alone; it copies the
 // certificates and refuses, so the handshake ends there. Global validation
 // settings stay untouched.
 public static ServerDeskPortalProbe Probe(string host,int port,string serverName,int timeout) {
  ServerDeskPortalProbe result=new ServerDeskPortalProbe();
  using(TcpClient tcp=new TcpClient()) {
   IAsyncResult connect=tcp.BeginConnect(host,port,null,null);
   if(!connect.AsyncWaitHandle.WaitOne(timeout)) throw new TimeoutException("The portal does not answer.");
   tcp.EndConnect(connect);
   tcp.ReceiveTimeout=timeout;tcp.SendTimeout=timeout;
   RemoteCertificateValidationCallback capture=delegate(object sender,X509Certificate certificate,X509Chain chain,SslPolicyErrors errors) {
    if(certificate!=null) result.Certificate=new X509Certificate2(certificate.GetRawCertData());
    if(chain!=null) for(int index=1;index<chain.ChainElements.Count;index++) result.Intermediates.Add(new X509Certificate2(chain.ChainElements[index].Certificate.RawData));
    result.NameMismatch=(errors&SslPolicyErrors.RemoteCertificateNameMismatch)!=0;
    return false;
   };
   using(SslStream tls=new SslStream(tcp.GetStream(),false,capture)) {
    try { tls.AuthenticateAsClient(serverName,new X509CertificateCollection(),SslProtocols.Tls12,false); }
    catch(AuthenticationException) { if(result.Certificate==null) throw; }
   }
  }
  if(result.Certificate==null) throw new AuthenticationException("The portal sent no certificate.");
  // .NET Framework does not report a name mismatch for an IP address, so the
  // certificate's own names decide as well.
  if(!NameMatches(result.Certificate,serverName)) result.NameMismatch=true;
  return result;
 }
 // The portal address against the subject alternative names (RFC 6125): an IP
 // address only against an iPAddress entry with the same bytes, a name only
 // against a dNSName entry, a wildcard only as the whole leftmost label. The
 // subject is never used. No names or unreadable names are no match.
 public static bool NameMatches(X509Certificate2 certificate,string host) {
  try {
   if(certificate==null || String.IsNullOrEmpty(host)) return false;
   byte[] names=null;
   foreach(X509Extension extension in certificate.Extensions) {
    if(extension.Oid!=null && extension.Oid.Value=="2.5.29.17") { names=extension.RawData; break; }
   }
   if(names==null) return false;
   string address=host;
   if(address.StartsWith("[") && address.EndsWith("]")) address=address.Substring(1,address.Length-2);
   if(address.IndexOf(':')>=0 && address.IndexOf('%')>=0) address=address.Substring(0,address.IndexOf('%'));
   IPAddress parsed;
   byte[] wanted=null;
   string name=null;
   if(IPAddress.TryParse(address,out parsed)) wanted=parsed.GetAddressBytes();
   else name=new IdnMapping().GetAscii(host.EndsWith(".")?host.Substring(0,host.Length-1):host).ToLowerInvariant();
   // SubjectAltName ::= SEQUENCE OF GeneralName; dNSName is [2], iPAddress is [7].
   int position=0;
   int end;
   if(!DerHeader(names,ref position,names.Length,0x30,out end) || end!=names.Length) return false;
   bool found=false;
   while(position<end) {
    byte tag=names[position];
    int entryEnd;
    if((tag&0x1F)==0x1F || !DerHeader(names,ref position,end,tag,out entryEnd)) return false;
    int length=entryEnd-position;
    if(tag==0x87 && wanted!=null && length==wanted.Length) {
     bool same=true;
     for(int index=0;index<length;index++) if(names[position+index]!=wanted[index]) same=false;
     if(same) found=true;
    }
    if(tag==0x82 && name!=null && DnsNameMatches(names,position,length,name)) found=true;
    position=entryEnd;
   }
   return found;
  } catch(Exception) { return false; }
 }
 // Reads tag and DER length at position; on success position is the start of
 // the contents and end is the index after them, within limit.
 static bool DerHeader(byte[] data,ref int position,int limit,int tag,out int end) {
  end=0;
  if(position+2>limit || data[position]!=tag) return false;
  int first=data[position+1];
  position+=2;
  long length=first;
  if(first>=0x80) {
   int count=first&0x7F;
   if(count<1 || count>4 || position+count>limit) return false;
   length=0;
   for(int index=0;index<count;index++) length=(length<<8)|data[position+index];
   position+=count;
  }
  if(length>limit-position) return false;
  end=position+(int)length;
  return true;
 }
 // One dNSName entry (IA5String) against the ASCII host in lower case.
 static bool DnsNameMatches(byte[] data,int offset,int length,string host) {
  if(length<1) return false;
  char[] characters=new char[length];
  for(int index=0;index<length;index++) {
   byte value=data[offset+index];
   if(value<0x21 || value>0x7E) return false;
   characters[index]=Char.ToLowerInvariant((char)value);
  }
  string entry=new String(characters);
  if(entry.EndsWith(".")) entry=entry.Substring(0,entry.Length-1);
  if(entry.StartsWith("*.")) {
   string suffix=entry.Substring(2);
   int dot=host.IndexOf('.');
   if(suffix.Length==0 || suffix.IndexOf('*')>=0 || dot<1) return false;
   return String.Equals(host.Substring(dot+1),suffix,StringComparison.Ordinal);
  }
  if(entry.IndexOf('*')>=0) return false;
  return String.Equals(host,entry,StringComparison.Ordinal);
 }
 // The chain in the machine context, which the agent service uses. Revocation
 // is not checked, as for the agent's own connections.
 static X509Chain MachineChain(ServerDeskPortalProbe probe) {
  X509Chain chain=new X509Chain(true);
  chain.ChainPolicy.RevocationMode=X509RevocationMode.NoCheck;
  chain.ChainPolicy.ExtraStore.AddRange(probe.Intermediates);
  return chain;
 }
 // The normal check: the name matches and the chain is trusted on this computer.
 public static bool Trusted(ServerDeskPortalProbe probe) {
  if(probe.NameMismatch) return false;
  using(X509Chain chain=MachineChain(probe)) return chain.Build(probe.Certificate);
 }
 // NameMismatch (the certificate is not for the portal address), Trusted,
 // Offer (the only problem is that the embedded root is not trusted yet, and
 // the chain ends at exactly its bytes) or Foreign (anything else).
 public static string Decide(ServerDeskPortalProbe probe,byte[] root) {
  if(probe.NameMismatch) return "NameMismatch";
  if(Trusted(probe)) return "Trusted";
  using(X509Chain chain=MachineChain(probe)) {
   chain.ChainPolicy.ExtraStore.Add(new X509Certificate2(root));
   chain.ChainPolicy.VerificationFlags=X509VerificationFlags.AllowUnknownCertificateAuthority;
   chain.Build(probe.Certificate);
   X509ChainStatusFlags problems=X509ChainStatusFlags.NoError;
   foreach(X509ChainStatus status in chain.ChainStatus) problems|=status.Status;
   if((problems&~X509ChainStatusFlags.UntrustedRoot)!=X509ChainStatusFlags.NoError || chain.ChainElements.Count<1) return "Foreign";
   byte[] last=chain.ChainElements[chain.ChainElements.Count-1].Certificate.RawData;
   if(last.Length!=root.Length) return "Foreign";
   for(int index=0;index<root.Length;index++) if(last[index]!=root[index]) return "Foreign";
   return "Offer";
  }
 }
 // SHA-256 of the DER bytes as uppercase hex pairs with ":", as the portal shows it.
 public static string Fingerprint(byte[] der) {
  using(SHA256 sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(der)).Replace('-',':');
 }
}
'@ -IgnoreWarnings -WarningAction SilentlyContinue
# Portal certificate: only a script with an embedded root checks the trust,
# before any request carries a token or a key. A trusted certificate (public,
# or the root is already imported) continues without output.
if($null -ne $PortalRoot){
 $RootBytes=[Convert]::FromBase64String([string]$PortalRoot.certificate)
 $TrustURI=[uri]$PortalOrigin
 $Decision=[ServerDeskPortalTrust]::Decide([ServerDeskPortalTrust]::Probe($TrustURI.DnsSafeHost,$TrustURI.Port,$TrustURI.DnsSafeHost,30000),$RootBytes)
 # A certificate for another name or address is never offered, also not with -TrustPortalCertificate.
 if($Decision -eq 'NameMismatch'){throw ('The portal certificate is not valid for '+$TrustURI.DnsSafeHost+'. The certificate must contain this name or IP address. Ask the portal administrator to issue the certificate for this address (CADDY_ADDRESS with the same host as SITE_ORIGIN), then run the script again.')}
 if($Decision -ne 'Trusted'){
  if($Decision -ne 'Offer'){throw 'The portal certificate is not trusted on this computer, and it does not come from the root certificate in this script. Check the portal address and its certificate.'}
  $RootCertificate=[Security.Cryptography.X509Certificates.X509Certificate2]::new($RootBytes)
  Write-Host ('The portal '+$PortalOrigin+' uses a certificate from its own certificate authority.')
  Write-Host ('Name: '+$RootCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false))
  Write-Host ('SHA-256: '+[ServerDeskPortalTrust]::Fingerprint($RootBytes))
  if(-not $TrustPortalCertificate){
   $Choices=[Management.Automation.Host.ChoiceDescription[]]@(
    (New-Object Management.Automation.Host.ChoiceDescription '&Import','Import the root certificate and continue the installation.'),
    (New-Object Management.Automation.Host.ChoiceDescription '&Cancel','Stop without changes.'))
   # The default, index 1, is Cancel. A host that cannot ask (non-interactive) throws.
   try{$Choice=$Host.UI.PromptForChoice('Import root certificate','Compare the fingerprint with Settings in the portal. Import this root certificate into the trusted root certificates of this computer (Cert:\LocalMachine\Root)?',$Choices,1)}
   catch{throw 'The portal certificate is not trusted on this computer. Run the script with -TrustPortalCertificate to import the root certificate in this script, or import it by hand.'}
   if($Choice -ne 0){throw 'The root certificate was not imported. The agent cannot connect to the portal without it. Run the script again and import it, or run it with -TrustPortalCertificate.'}
  }
  # Only the embedded root, only into the computer store that the agent service uses.
  $Store=New-Object Security.Cryptography.X509Certificates.X509Store('Root','LocalMachine')
  $Store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  try{$Store.Add($RootCertificate)}finally{$Store.Close()}
  Write-Host ('Root certificate imported into Cert:\LocalMachine\Root (thumbprint '+$RootCertificate.Thumbprint+').')
  if(-not [ServerDeskPortalTrust]::Trusted([ServerDeskPortalTrust]::Probe($TrustURI.DnsSafeHost,$TrustURI.Port,$TrustURI.DnsSafeHost,30000))){throw 'The portal certificate is still not trusted after the import. Check the certificate of the portal.'}
 }
}
$Client=New-Object ServerDeskReleaseClient
# The signed manifest is UTF-8. Without this WebClient decodes it with the ANSI
# code page, and any non-ASCII text in it breaks the signature check.
$Client.Encoding=[Text.Encoding]::UTF8
# The customer installer has no device token yet; the signed release it needs is public.
if(-not $Enrollment){$Client.Headers['Authorization']='Bearer '+$Config.token}
$Work=Join-Path ([IO.Path]::GetTempPath()) ('ServerDesk-'+[guid]::NewGuid().ToString('N'))
try {
 $ReleaseJSON=$Client.DownloadString($PortalOrigin+'/Agent-v3-release.json?form=path')
 if([Text.Encoding]::UTF8.GetByteCount($ReleaseJSON) -gt 32768){throw 'The release manifest is too large.'}
 $Envelope=$ReleaseJSON|ConvertFrom-Json
 $ManifestBytes=[Text.Encoding]::UTF8.GetBytes([string]$Envelope.manifest)
 if(-not [ServerDeskReleaseSignature]::Verify([Convert]::FromBase64String('__PUBLISHER_POINT_BASE64__'),$ManifestBytes,[Convert]::FromBase64String([string]$Envelope.signature))){throw 'The release signature does not match the locally stored publisher.'}
 $Release=$Envelope.manifest|ConvertFrom-Json
 $PathForm=Test-ReleasePathForm $Release
 foreach($File in @(Get-ReleaseFiles $Release)){[void](Resolve-ReleaseURL $File $PathForm)}
 $EXE=$Release.exe
 if($Release.arch -ne 'x64' -or $Release.minProtocolVersion -gt 3 -or $Release.protocolVersion -lt 3 -or -not $EXE -or $EXE.size -lt 1 -or $EXE.size -gt 300000000 -or $EXE.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'No compatible signed single-EXE release is available.'}
 $EXEURL=Resolve-ReleaseURL $EXE $PathForm
 New-Item -ItemType Directory -Path $Work|Out-Null
 $ACL=New-Object Security.AccessControl.DirectorySecurity
 $ACL.SetAccessRuleProtection($true,$false)
 $AdminSID=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
 $ACL.SetOwner($AdminSID)
 foreach($SID in @($AdminSID,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))){
  $Rule=New-Object Security.AccessControl.FileSystemAccessRule($SID,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $ACL.AddAccessRule($Rule)
 }
 Set-Acl -LiteralPath $Work -AclObject $ACL
 $Executable=Join-Path $Work 'ServerDesk.Agent.exe'
 if($EXE.parts -and @($EXE.parts).Count -gt 0){
  if(@($EXE.parts).Count -gt 15){throw 'Too many EXE parts.'}
  $Sum=0L;$Output=[IO.File]::Open($Executable,[IO.FileMode]::CreateNew)
  try{
   foreach($Part in @($EXE.parts)){
    $PartURL=Resolve-ReleaseURL $Part $PathForm
    if($Part.size -lt 1 -or $Part.size -gt 20MB -or $Part.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Invalid EXE part.'}
    $Sum+=$Part.size;if($Sum -gt $EXE.size){throw 'The EXE parts exceed the signed size.'}
    $PartPath=Join-Path $Work 'part.bin';$Client.DownloadFile($PartURL,$PartPath)
    if((Get-Item -LiteralPath $PartPath).Length -ne $Part.size -or (Get-FileHash -LiteralPath $PartPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Part.sha256){throw 'The checksum of an EXE part does not match.'}
    $Input=[IO.File]::OpenRead($PartPath);try{$Input.CopyTo($Output)}finally{$Input.Dispose()};Remove-Item -LiteralPath $PartPath
   }
   if($Sum -ne $EXE.size){throw 'The signed EXE parts are incomplete.'}
  }finally{$Output.Dispose()}
 }else{$Client.DownloadFile($EXEURL,$Executable)}
 if((Get-Item -LiteralPath $Executable).Length -ne $EXE.size -or (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $EXE.sha256){throw 'The EXE does not match the signed release.'}
 # Enroll only now: a release or trust problem costs no device and no slot.
 if($Enrollment){
  # The key goes only into the POST body to the embedded origin, without
  # redirects, and is never written to disk.
  $EnrollClient=New-Object ServerDeskReleaseClient
  try{
   $EnrollClient.Encoding=[Text.Encoding]::UTF8
   $EnrollClient.Headers['Content-Type']='application/json; charset=utf-8'
   $EnrollRequest=[ordered]@{installerKey=[string]$Enrollment.installerKey;name=$DeviceName}|ConvertTo-Json -Compress
   try{$Answer=$EnrollClient.UploadString([string]$Enrollment.origin+'/api/agent/enroll','POST',$EnrollRequest)}
   catch{
    $Reason=$_.Exception.Message;$Problem=$_.Exception
    while($Problem -and -not($Problem -is [Net.WebException])){$Problem=$Problem.InnerException}
    if($Problem -and $Problem.Response){
     try{
      $Reader=New-Object IO.StreamReader($Problem.Response.GetResponseStream(),[Text.Encoding]::UTF8)
      try{$Failure=$Reader.ReadToEnd()|ConvertFrom-Json}finally{$Reader.Dispose()}
      if($Failure.error -is [string] -and $Failure.error){$Reason=$Failure.error}
     }catch{}
    }
    throw ('Registration refused: '+$Reason)
   }
  }finally{$EnrollClient.Dispose()}
  $Registration=$null
  if($Answer -and [Text.Encoding]::UTF8.GetByteCount($Answer) -le 32768){try{$Registration=$Answer|ConvertFrom-Json}catch{$Registration=$null}}
  if(-not $Registration -or [string]$Registration.origin -cne [string]$Enrollment.origin -or [string]$Registration.id -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -or [string]$Registration.token -notmatch '^[a-fA-F0-9]{64}$' -or @('ReadOnly','Management') -cnotcontains [string]$Registration.mode -or -not [string]$Registration.jobSigningKey){throw 'The answer of the portal is not a valid registration.'}
  Write-Host ('Device "'+$DeviceName+'" registered with the customer "'+[string]$Registration.customerName+'". The agent is installed now.')
  # Exactly the known registration fields go to the native installer.
  $Config=[pscustomobject]@{id=[string]$Registration.id;token=[string]$Registration.token;origin=[string]$Registration.origin;jobSigningKey=[string]$Registration.jobSigningKey;mode=[string]$Registration.mode}
  Assert-Registration $Config
 }
 $Arguments=@('--install');if($Mode){$Arguments+=@('--mode',$Mode)}
 $Config|ConvertTo-Json -Depth 8 -Compress|& $Executable @Arguments
 if($LASTEXITCODE -ne 0){throw 'The native installer reports an error. Check the output and the agent log.'}
}finally{$Client.Dispose();if(Test-Path -LiteralPath $Work){Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue}}
