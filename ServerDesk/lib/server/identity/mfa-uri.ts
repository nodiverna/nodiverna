import {productName} from '../../brand';

// The one place that builds the otpauth:// URI of an authenticator setup. The
// setup link and the QR code both show exactly this string.
export function otpauthUri(label:string,secret:string):string{
 return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(productName)}&algorithm=SHA1&digits=6&period=30`;
}
