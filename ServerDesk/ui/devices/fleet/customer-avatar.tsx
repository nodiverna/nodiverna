'use client';
import type {BrandingLogoPair} from '@/lib/branding';
import {customerAvatarLogo,customerInitials} from '@/ui/devices/fleet/customer-avatar-model';
import {BrandLogo} from '@/ui/kit/brand-logo';
import {useLocale} from '@/ui/base/locale';
import '@/ui/devices/fleet/customer-avatar.css';

/** The 20×20 avatar of a customer folder: its square logo, else its initials on the accent-soft tile. Decorative: the
 * tree row names the customer. */
export function CustomerAvatar({name,logo}:{name:string;logo?:BrandingLogoPair|null}){
 const [locale]=useLocale(),square=customerAvatarLogo(logo);
 return <span className={square?'sdx-customer-avatar sdx-customer-avatar-logo':'sdx-customer-avatar'} aria-hidden="true">
  {square?<BrandLogo {...square} size="avatar"/>:customerInitials(name,locale)}
 </span>;
}
