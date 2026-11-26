import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';

/**
 * The text lines of a scope header (All devices, Ungrouped, a group, a customer): the group
 * description as its own line, and the subtitle with the counts only. The two are never joined,
 * so a long description wraps on its own and the counts stay one short line.
 */
export function fleetHeaderLines({description,count,online,flagged}:{description?:string|null;count:number;online:number;flagged:number},locale:Locale=defaultLocale):{description:string|null;subtitle:string}{
 const text=description?.trim()||null;
 const subtitle=flagged?translate(locale,'console.fleetSubtitleFlagged',{count,online,flagged}):translate(locale,'console.fleetSubtitle',{count,online});
 return {description:text,subtitle};
}
