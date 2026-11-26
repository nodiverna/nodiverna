// The amr diagnostic of a refused Microsoft sign-in (docs/entra-id.md, "MFA").
// Pure and client-safe: the callback (lib/server/identity/entra/sign-in.ts, lib/server/identity/entra/confirm.ts)
// writes it into the audit row and the page, the sign-in card
// (ui/session/identity-entry.tsx) reads it back from #entra=mfaMissing&amr=<diagnostic>.
// Only short values of a fixed list leave a token this way, never other claim text.

/** The sign-in method values of RFC 8176 and Microsoft that a diagnostic may name. */
export const amrAllowList:ReadonlySet<string>=new Set(['pwd','rsa','otp','fed','wia','mfa','ngcmfa','wiaormfa','none','fido','face','fpt','hwk','swk','sms','tel','pin','kba','mca','sc','pop','user','geo','iris','retina','rba','vbm']);
/** The value that replaces every value outside the allow-list (an unknown string or a non-string). */
export const amrOther='other';
/** A diagnostic names at most this many values. */
export const amrDiagnosticLimit=10;
/** 'missing' when the token has no amr array; else the allow-listed values in token order (may be empty). */
export type AmrDiagnostic='missing'|readonly string[];

/** The diagnostic of a raw amr claim: deduplicated, unknown values as one 'other', at most 10 entries. */
export function amrDiagnostic(claim:unknown):AmrDiagnostic{
 if(!Array.isArray(claim))return 'missing';
 const values:string[]=[];
 for(const value of claim as unknown[]){
  const kept=typeof value==='string'&&amrAllowList.has(value)?value:amrOther;
  if(!values.includes(kept))values.push(kept);
  if(values.length>=amrDiagnosticLimit)break;
 }
 return values;
}
/** The text form for the audit row and the page: "missing", or the values joined by "," ("" for none). */
export const formatAmrDiagnostic=(diagnostic:AmrDiagnostic):string=>diagnostic==='missing'?'missing':diagnostic.join(',');
/** The diagnostic of its text form, or null for anything that formatAmrDiagnostic cannot write. */
export function parseAmrDiagnostic(text:unknown):AmrDiagnostic|null{
 if(typeof text!=='string')return null;
 if(text==='missing')return 'missing';
 if(text==='')return [];
 const values=text.split(',');
 if(values.length>amrDiagnosticLimit||new Set(values).size!==values.length)return null;
 return values.every(value=>value===amrOther||amrAllowList.has(value))?values:null;
}
/** The detail line of a diagnostic: no values reads as "no sign-in methods", else the values joined by ", ". */
export function amrDetail(diagnostic:AmrDiagnostic):{key:'entra.error.amrMissing'}|{key:'entra.error.amrValues';methods:string}{
 return diagnostic==='missing'||!diagnostic.length?{key:'entra.error.amrMissing'}:{key:'entra.error.amrValues',methods:diagnostic.join(', ')};
}
