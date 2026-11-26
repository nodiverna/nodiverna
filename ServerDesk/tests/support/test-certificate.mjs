// A self-signed TLS certificate for the local fake SMTP and HTTPS targets of the
// notification tests, made at runtime with node:crypto (ECDSA P-256), so no
// private key is stored in the repository. The certificate names the host names
// smtp.example.test and hooks.example.test and is valid from 2000 to 2049, so a
// shifted test clock does not matter. The client trusts it through `ca`.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const length = size => size < 0x80 ? Buffer.from([size]) : (() => { const bytes = []; for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff); return Buffer.from([0x80 | bytes.length, ...bytes]); })();
const tlv = (tag, ...parts) => { const content = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), length(content.length), content]); };
const sequence = (...parts) => tlv(0x30, ...parts);
function oid(text) {
  const [first, second, ...rest] = text.split('.').map(Number);
  const bytes = [40 * first + second];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let rest7 = value >> 7; rest7 > 0; rest7 >>= 7) chunk.unshift(0x80 | (rest7 & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
const name = commonName => sequence(tlv(0x31, sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
const time = text => tlv(0x17, Buffer.from(text, 'ascii'));
const ecdsaSha256 = sequence(oid('1.2.840.10045.4.3.2'));

/**
 * The content of a positive, minimal DER INTEGER for the serial. The top bit of
 * the first byte is cleared (positive), and a first byte of zero becomes one
 * (minimal). OpenSSL refuses a serial such as 00 1f … with
 * ERR_OSSL_ASN1_ILLEGAL_PADDING; a plain randomBytes(8) with the top bit cleared
 * gave that in 1 of 256 certificates, and so a test process failed at its first
 * TLS server.
 */
export function certificateSerial(bytes = randomBytes(8)) {
  const serial = Buffer.from(bytes);
  serial[0] = (serial[0] & 0x7f) || 0x01;
  return serial;
}

/**
 * {key, cert} in PEM for node:tls and node:https servers; cert is also the `ca` of the client. `serialBytes` exist for the tests.
 * A client that trusts two of these certificates needs a different `commonName` for each, so the chain finds the right issuer.
 */
export function testCertificate(hosts = ['smtp.example.test', 'hooks.example.test'], { serialBytes, commonName = 'Nodiverna notification test' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const serial = certificateSerial(serialBytes);
  const san = sequence(...hosts.map(host => tlv(0x82, Buffer.from(host, 'ascii'))));
  const extensions = tlv(0xa3, sequence(sequence(oid('2.5.29.17'), tlv(0x04, san))));
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ecdsaSha256,
    name(commonName),
    sequence(time('000101000000Z'), time('491231235959Z')),
    name(commonName),
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = sequence(tbs, ecdsaSha256, tlv(0x03, Buffer.from([0]), signature));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert };
}

/** One certificate per test process, shared by the fake servers and the clients. */
export const testTls = testCertificate();
