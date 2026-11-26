// The Device Manager problem codes (ConfigManagerErrorCode of Win32_PnPEntity,
// CM_PROB_* in cfg.h): "Code 28: The drivers for this device are not
// installed." for every code from 1 to 56, "Code 99: Unknown problem." for any
// other code. The meanings follow Microsoft's list "Device Manager error codes";
// each sentence is one catalog entry (deviceProblem.code.<n>). Pure.
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';

export const firstProblemCode=1,lastProblemCode=56;
/** True for a code with its own catalog text. */
export const knownProblemCode=(code:number)=>Number.isInteger(code)&&code>=firstProblemCode&&code<=lastProblemCode;
/** "Code <n>: <meaning>" in the given language. */
export function deviceProblemText(code:number,locale:Locale=defaultLocale):string{
 return knownProblemCode(code)?translate(locale,`deviceProblem.code.${code}` as MessageKey):translate(locale,'deviceProblem.unknown',{code});
}
