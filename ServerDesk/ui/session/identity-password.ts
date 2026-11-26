import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';

export function passwordProblem(password:string,confirmation:string,locale:Locale=defaultLocale){
 if(Array.from(password).length<15)return translate(locale,'password.tooShort');
 if(Array.from(password).length>128||new TextEncoder().encode(password).length>1024)return translate(locale,'password.tooLong');
 if(password!==confirmation)return translate(locale,'password.mismatch');
 return '';
}
export function usernameProblem(username:string,locale:Locale=defaultLocale){return /^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(username.trim().toLowerCase())?'':translate(locale,'password.usernameRule');}
