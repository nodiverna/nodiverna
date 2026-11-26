// Which logo the top bar shows (docs/branding.md, "Where the logo appears"). Pure:
// the console passes ConsoleData.branding and the customer of what it shows. The
// first match wins:
// 1. Multiple customers is on and the context customer (its scope or Ungrouped
//    scope, one of its groups or devices) has a logo: that customer's logo.
// 2. The viewer sees exactly one customer, not the default customer, and it has
//    a logo: that logo (the accounts of that customer).
// 3. A portal logo (light or dark).
// 4. null: the Nodiverna mark.
import type {BrandingLogoPair,ConsoleBranding} from '@/lib/branding';

export type TopbarLogoInput={
 branding:ConsoleBranding|null|undefined;
 multipleCustomers:boolean;
 /** The customer of the scope, group or device the console shows; null elsewhere. */
 contextCustomerId:string|null|undefined;
 visibleCustomerIds:readonly string[];
 defaultCustomerId:string;
};
const filled=(pair:BrandingLogoPair|null|undefined):pair is BrandingLogoPair=>!!pair&&(!!pair.light||!!pair.dark);

export function topbarLogo({branding,multipleCustomers,contextCustomerId,visibleCustomerIds,defaultCustomerId}:TopbarLogoInput):BrandingLogoPair|null{
 if(!branding)return null;
 const customerLogo=(id:string|null|undefined)=>multipleCustomers&&id&&id!==defaultCustomerId&&Object.hasOwn(branding.customers,id)?branding.customers[id]:null;
 const context=customerLogo(contextCustomerId);
 if(filled(context))return {light:context.light,dark:context.dark};
 const single=visibleCustomerIds.length===1?customerLogo(visibleCustomerIds[0]):null;
 if(filled(single))return {light:single.light,dark:single.dark};
 if(filled(branding.portal))return {light:branding.portal.light,dark:branding.portal.dark};
 return null;
}
