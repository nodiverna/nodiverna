// The free-text description of a device: normalization and validation shared by
// the server (lib/server/devices/device-description-store.ts) and the editor in the portal
// (ui/devices/device/device-description.tsx). Pure: no imports, no I/O.

/** The longest description, in Unicode code points after normalization. */
export const deviceDescriptionMax=500;

export type DeviceDescriptionProblem='too-long'|'invalid';
export type DeviceDescriptionResult={ok:true;text:string}|{ok:false;text:string;problem:DeviceDescriptionProblem};

// Control characters except LF and TAB: C0, DEL and C1.
const controlCharacter=/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
// An HTML tag: `<` followed by a letter, `/` or `!`, through the next `>`.
// `a < b` and `x<5` are plain text.
const htmlTag=/<[A-Za-z/!][^>]*>/;

/** CRLF and CR become LF, then leading and trailing whitespace goes. */
export function normalizeDeviceDescription(text:string):string{return text.replace(/\r\n?/g,'\n').trim();}

/** The length that the limit counts: code points, so an emoji counts as one. */
export function deviceDescriptionLength(text:string):number{return [...text].length;}

/**
 * Normalizes and checks a description. An empty text is valid and clears the
 * description. `text` is always the normalized text.
 */
export function validateDeviceDescription(input:unknown):DeviceDescriptionResult{
 if(typeof input!=='string')return {ok:false,text:'',problem:'invalid'};
 const text=normalizeDeviceDescription(input);
 if(controlCharacter.test(text)||htmlTag.test(text))return {ok:false,text,problem:'invalid'};
 if(deviceDescriptionLength(text)>deviceDescriptionMax)return {ok:false,text,problem:'too-long'};
 return {ok:true,text};
}
