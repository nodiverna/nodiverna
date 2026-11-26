import type {BrandingLogoPair} from '@/lib/branding';
import type {Locale} from '@/lib/i18n/locale';

// The avatar of a customer folder in the navigator (docs/branding.md, "Customer avatars"): the customer logo when it
// fits a square, else the initials of the customer name.

/** A logo fits the 20×20 avatar when width/height is from 0.5 to 2; wide wordmarks do not. */
export const customerAvatarRatio={min:0.5,max:2} as const;

const separators=/[\s\-_.&/]+/u,letterOrDigit=/^[\p{L}\p{N}]/u;

/** The initials of a customer: the first letter or digit of each of the first two words, upper-cased in the locale,
 * graphemes kept whole (Ölwerke Nord → ÖN); '#' when the name has no letter or digit. */
export function customerInitials(name:string,locale:Locale):string{
 const segmenter=new Intl.Segmenter(locale,{granularity:'grapheme'}),initials:string[]=[];
 for(const word of name.split(separators)){
  if(initials.length===2)break;
  for(const {segment} of segmenter.segment(word)){if(letterOrDigit.test(segment)){initials.push(segment);break;}}
 }
 return initials.length?initials.join('').toLocaleUpperCase(locale):'#';
}

/** The logo pair for the avatar, or null (no logo, or a variant outside customerAvatarRatio): then the initials show. */
export function customerAvatarLogo(pair:BrandingLogoPair|null|undefined):BrandingLogoPair|null{
 const variants=pair?[pair.light,pair.dark].filter(variant=>variant!==null):[];
 if(!pair||!variants.length)return null;
 return variants.every(variant=>{const ratio=variant.width/variant.height;return ratio>=customerAvatarRatio.min&&ratio<=customerAvatarRatio.max;})?pair:null;
}
