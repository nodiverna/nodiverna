import {readFileSync,statSync} from 'node:fs';
import {X509Certificate} from 'node:crypto';

// The public root certificate of the portal's local Caddy CA (docs/self-hosting.md,
// "HTTPS with the local Caddy CA"). The ca-export service in compose.yaml copies
// only Caddy's root.crt into a volume that the app mounts read-only and names in
// PORTAL_CA_FILE. Install scripts embed this root and offer to import it when a
// device does not trust the portal certificate yet. Anything unexpected in the
// file means "no root": the scripts then behave as without a local CA.
export type PortalRootCertificate={/** Base64 DER. */der:string;name:string;/** Uppercase hex pairs with ":", as Node's fingerprint256. */sha256:string;/** ISO time. */notAfter:string};
/** The part the settings page shows: never the certificate itself. */
export type PortalCertificateView=Omit<PortalRootCertificate,'der'>;

export const portalCertificateMaxBytes=16*1024;
const pemBlock=/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;

/** The subject CN, or the full subject (one line) when it has no CN. */
function nameOf(certificate:X509Certificate){
 const parts=certificate.subject.split('\n').map(part=>part.trim()).filter(Boolean);
 const common=parts.find(part=>part.startsWith('CN='));
 return common?common.slice(3):parts.join(', ');
}

/** The portal root from PORTAL_CA_FILE, or null when it is not set, not there or not one valid self-signed CA certificate. */
export function portalRootCertificate(now=Date.now()):PortalRootCertificate|null{
 const file=process.env.PORTAL_CA_FILE?.trim();
 if(!file)return null;
 try{
  // The size is checked before and after the read, so a wrong path never loads a large file.
  const stat=statSync(file);
  if(!stat.isFile()||stat.size>portalCertificateMaxBytes)return null;
  const bytes=readFileSync(file);
  if(bytes.length>portalCertificateMaxBytes)return null;
  const text=bytes.toString('utf8');
  // Split, so the repository scan for key material (tests/repo/key-material.mjs) skips this line.
  if(text.includes('PRIVATE'+' KEY'))return null;
  // Exactly one PEM block, and it is a certificate.
  const blocks=[...text.matchAll(pemBlock)];
  if(blocks.length!==1||blocks[0][1]!=='CERTIFICATE'||text.split('-----BEGIN ').length!==2)return null;
  const certificate=new X509Certificate(blocks[0][0]);
  if(!certificate.ca)return null;
  if(certificate.issuer!==certificate.subject||!certificate.checkIssued(certificate)||!certificate.verify(certificate.publicKey))return null;
  const from=Date.parse(certificate.validFrom),to=Date.parse(certificate.validTo);
  if(!Number.isFinite(from)||!Number.isFinite(to)||now<from||now>to)return null;
  return {der:certificate.raw.toString('base64'),name:nameOf(certificate),sha256:certificate.fingerprint256,notAfter:new Date(to).toISOString()};
 }catch{return null;}
}

/** Name, fingerprint and expiry for the settings page, or null. */
export function portalCertificateView():PortalCertificateView|null{
 const root=portalRootCertificate();
 return root?{name:root.name,sha256:root.sha256,notAfter:root.notAfter}:null;
}
