// An uploaded logo (docs/branding.md) in its light and dark variant. Both images
// are in the markup and the stylesheet shows the one of the resolved appearance
// (data-theme on <html>, prefers-color-scheme for "system"), so the choice needs
// no script and no state; a single variant serves both appearances. The images are
// decorative (alt=""): the link or row around them names the product or customer.
import type {BrandingLogoPair} from '@/lib/branding';
import '@/ui/kit/brand-logo.css';

/** topbar and session: the height is fixed and the width follows the image; avatar: contained in a 20×20 square (the customer avatar). */
export type BrandLogoSize='topbar'|'session'|'avatar';
type Asset=NonNullable<BrandingLogoPair['light']>;
const image=(asset:Asset,variant?:'light'|'dark')=><img className={variant?`sdx-brand-logo-${variant}`:undefined} src={asset.url} alt="" decoding="async" width={asset.width} height={asset.height}/>;

/** The logo pair at a size variant; nothing without a variant. */
export function BrandLogo({light,dark,size}:BrandingLogoPair&{size:BrandLogoSize}){
 const only=light??dark;
 if(!only)return null;
 return <span className={`sdx-brand-logo sdx-brand-logo-size-${size}`}>
  {light&&dark?<>{image(light,'light')}{image(dark,'dark')}</>:image(only)}
 </span>;
}
