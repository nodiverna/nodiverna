// Branding images (docs/branding.md): the slots, the limits and the views that
// the server sends and the console reads. Pure and shared: no server imports,
// so the Branding page checks a file size with the same numbers as the upload
// route. The checks themselves are in lib/server/branding-image.ts, the
// storage in lib/server/branding.ts.
import type {BackdropMeasure,BackdropScrims} from './backdrop';
import type {ApiErrorKey} from './errors/api-error-keys';
import type {MessageKey} from './i18n/translate';

export const brandingSlots=['light','dark','icon','signin','console'] as const;
/** light and dark: the portal or customer logo; icon: the browser tab icon; signin and console: the backgrounds (icon and the backgrounds: portal only). */
export type BrandingSlot=typeof brandingSlots[number];
export type BrandingLogoSlot='light'|'dark';
/** The two areas with a background: the sign-in page (every session screen) and the console. */
export type BrandingBackgroundSlot='signin'|'console';
export const brandingBackgroundSlots:readonly BrandingBackgroundSlot[]=['signin','console'];
export const isBrandingBackgroundSlot=(value:unknown):value is BrandingBackgroundSlot=>value==='signin'||value==='console';
export const brandingLogoSlots:readonly BrandingLogoSlot[]=['light','dark'];
export const isBrandingSlot=(value:unknown):value is BrandingSlot=>typeof value==='string'&&(brandingSlots as readonly string[]).includes(value);
export const isBrandingLogoSlot=(value:unknown):value is BrandingLogoSlot=>value==='light'||value==='dark';

export const brandingContentTypes=['image/png','image/webp','image/jpeg','image/svg+xml'] as const;
export type BrandingContentType=typeof brandingContentTypes[number];
/** The file name extension of each stored type (Content-Disposition). */
export const brandingExtension:Record<BrandingContentType,string>={'image/png':'png','image/webp':'webp','image/jpeg':'jpg','image/svg+xml':'svg'};
/** The accept list of the file picker. The server decides the format by content, never by this list. */
export const brandingAccept='image/png,image/webp,image/jpeg,image/svg+xml,.svg';

/** A logo file: at most 2 MiB. */
export const brandingLogoMaxBytes=2*1024*1024;
/** An icon file: at most 256 KiB. */
export const brandingIconMaxBytes=256*1024;
/** Raster logos: 16 to 4096 px per side; every logo: width/height from 0.5 to 8. */
export const brandingLogoPixels={min:16,max:4096} as const;
export const brandingLogoRatio={min:0.5,max:8} as const;
/** Raster icons: square, 32 to 1024 px per side. */
export const brandingIconPixels={min:32,max:1024} as const;
/** A background file: at most 8 MiB. */
export const brandingBackgroundMaxBytes=8*1024*1024;
/** Raster backgrounds: 320 to 7680 px per side, any ratio (shown with object-fit: cover). SVG has no pixel limit. */
export const brandingBackgroundPixels={min:320,max:7680} as const;

export const brandingByteLimit=(slot:BrandingSlot)=>slot==='icon'?brandingIconMaxBytes:isBrandingBackgroundSlot(slot)?brandingBackgroundMaxBytes:brandingLogoMaxBytes;
/** The 413 key of a file over the slot limit. */
export const brandingTooLargeKey=(slot:BrandingSlot):ApiErrorKey=>slot==='icon'?'apiError.branding.iconTooLarge':isBrandingBackgroundSlot(slot)?'apiError.branding.backgroundTooLarge':'apiError.branding.logoTooLarge';
/** Whether a file of `size` bytes fits the slot; the client checks it before it sends anything. */
export const brandingFileFits=(slot:BrandingSlot,size:number)=>Number.isFinite(size)&&size<=brandingByteLimit(slot);

/** One stored image as the API shows it. url carries ?v=<first 16 hex of the sha256>, so a new image gets a new URL. */
export type BrandingAssetView={url:string;contentType:BrandingContentType;width:number;height:number;size:number;updatedAt:number};
export type BrandingLogoPair={light:BrandingAssetView|null;dark:BrandingAssetView|null};
/** The portal logos and the tab icon. */
export type BrandingPortalView=BrandingLogoPair&{icon:BrandingAssetView|null};

/**
 * The six bundled backgrounds (public/backgrounds/<id>.svg), each with its label key and the measurement of its blurred
 * image for the console scrims (lib/backdrop.ts; `node scripts/measure-backgrounds.mjs` prints the values).
 */
export const brandingBackgrounds=[
 {id:'mist',label:'branding.background.mist',measure:{light:{low:'#cfddee',high:'#f8fafd'},dark:{low:'#bbc6d4',high:'#e0e1e3'}}},
 {id:'dusk',label:'branding.background.dusk',measure:{light:{low:'#181f3b',high:'#46356f'},dark:{low:'#171c32',high:'#3e315e'}}},
 {id:'tide',label:'branding.background.tide',measure:{light:{low:'#0b3b5f',high:'#14667b'},dark:{low:'#0f3450',high:'#195a6a'}}},
 {id:'dune',label:'branding.background.dune',measure:{light:{low:'#e7cca8',high:'#faf0e2'},dark:{low:'#cdb89c',high:'#e0d9cd'}}},
 {id:'slate',label:'branding.background.slate',measure:{light:{low:'#181f29',high:'#303b49'},dark:{low:'#161c23',high:'#2d3540'}}},
 {id:'bloom',label:'branding.background.bloom',measure:{light:{low:'#352452',high:'#77376a'},dark:{low:'#2f2245',high:'#653359'}}},
] as const satisfies readonly {id:string;label:MessageKey;measure:BackdropMeasure}[];
export type BrandingBundledBackground=typeof brandingBackgrounds[number]['id'];
/** The background choice of an area: none, the uploaded image of its slot, or a bundled background. */
export type BrandingBackgroundChoice='none'|'upload'|BrandingBundledBackground;
export const brandingBackgroundChoices:readonly BrandingBackgroundChoice[]=['none','upload',...brandingBackgrounds.map(background=>background.id)];
export const isBrandingBackgroundChoice=(value:unknown):value is BrandingBackgroundChoice=>typeof value==='string'&&(brandingBackgroundChoices as readonly string[]).includes(value);
/** The URL of a bundled background. */
export const bundledBackgroundUrl=(id:BrandingBundledBackground)=>`/backgrounds/${id}.svg`;
/** A background as the pages show it; null is none. */
export type BrandingBackgroundView={kind:'builtin';id:BrandingBundledBackground;url:string}|{kind:'upload';url:string;width:number;height:number};
/** The two colors of the brand color scheme (lowercase #rrggbb), see lib/brand-scheme.ts. */
export type BrandSchemeColors={primary:string;secondary:string};
/** The background of one area on the Branding page: the choice and the stored upload of its slot. */
export type BrandingBackgroundState={choice:BrandingBackgroundChoice;upload:BrandingAssetView|null};

/** GET /api/branding (public): the portal slots and the sign-in background, nothing about the console. */
export type BrandingPublicView={portal:BrandingPortalView;signinBackground:BrandingBackgroundView|null};
export type BrandingCustomerView=BrandingLogoPair&{id:string;name:string;status:'active'|'disabled'};
/**
 * The Console background card: the choice and the upload, whether the upload has a measurement (false without an
 * upload), and the scrims of the current choice (null for none).
 */
export type BrandingConsoleBackgroundState=BrandingBackgroundState&{measured:boolean;scrim:BackdropScrims|null};
/** GET /api/branding/manage (global Owners): the portal slots, the setting and every customer other than the default customer. */
export type BrandingManageView={portal:BrandingPortalView;multipleCustomers:boolean;customers:BrandingCustomerView[];
 backgrounds:{signin:BrandingBackgroundState;console:BrandingConsoleBackgroundState};scheme:BrandSchemeColors|null};
/**
 * The console background as the console shows it: the image, the scrims of each mode and region (lib/backdrop.ts),
 * and whether they come from a measurement (false: the fallback for any image).
 */
export type ConsoleBackgroundView=BrandingBackgroundView&{scrim:BackdropScrims;measured:boolean};
/**
 * ConsoleData.branding: the portal slots, the logos of the customers the viewer sees (only those with a logo), the
 * console background and the stored brand scheme.
 */
export type ConsoleBranding={portal:BrandingPortalView;customers:Record<string,BrandingLogoPair>;consoleBackground:ConsoleBackgroundView|null;scheme:BrandSchemeColors|null};
