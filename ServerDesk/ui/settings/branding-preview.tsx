'use client';
// Settings › Branding, the card Preview (docs/branding.md): the focal point of the page. One browser window in
// miniature shows where every choice of the page appears: the tab strip with the tab icon and the page title, and
// below it the sign-in page (background, card, logo, primary button) or the console (top bar with the logo, rail,
// navigator, workspace, the blurred background with the scrims of the choice). Two switches choose the page and the
// appearance. The window keeps one appearance (the fixed-scheme rules of app/globals.css) and carries
// data-scheme-swatch="brand", so its colors are the brand colors (the stored scheme, else Aurora) whatever color scheme
// the Owner uses; ui/settings/branding.css reads the --scheme-* variables that the attribute sets. A color selection
// that is not applied yet sets its derived --brand-* values on the window, so the Owner sees it before Apply.
// Everything inside the window is decorative: the window is one image with a name.
import type {CSSProperties} from 'react';
import {Eye} from 'lucide-react';
import {backdropScrimProperties} from '@/lib/backdrop';
import {productName} from '@/lib/brand';
import type {BrandingAssetView,BrandingManageView} from '@/lib/branding';
import {useT} from '@/ui/base/locale';
import {BrandMark} from '@/ui/kit/brand-mark';
import {Card,Segmented,type IconType,type SegmentItem} from '@/ui/kit/kit';
import {themeOptions} from '@/ui/shell/theme';
import '@/ui/shell/console-backdrop.css';
import {pendingSchemeProperties,previewIconUrl,shownBackground,shownLogo,type PreviewAppearance,type PreviewSurface,type SchemeSelection} from '@/ui/settings/branding-model';

/** A logo in the miniature, keyed by its URL, so a new logo fades in. */
function StageLogo({asset}:{asset:BrandingAssetView}){
 return <img key={asset.url} className="sdx-branding-fade sdx-stage-logo" src={asset.url} alt="" decoding="async" width={asset.width} height={asset.height}/>;
}
/** The Nodiverna mark on the gradient of the previewed colors, where no logo is uploaded. */
function StageMark(){
 return <span className="sdx-branding-fade sdx-stage-mark"><BrandMark size={10}/></span>;
}

/** The sign-in page: the background under its light scrim (or the plain surface), and the card with the logo, two fields and the primary button. */
function SigninStage({view,appearance}:{view:BrandingManageView;appearance:PreviewAppearance}){
 const background=shownBackground(view.backgrounds.signin),logo=shownLogo(view.portal,appearance);
 return <div className={background?'sdx-branding-fade sdx-stage-signin is-image':'sdx-branding-fade sdx-stage-signin'}>
  {background&&<img key={background.url} className="sdx-branding-fade sdx-stage-image" src={background.url} alt="" decoding="async"/>}
  <span className="sdx-stage-signin-card">
   <span className="sdx-stage-brand">{logo?<><StageLogo asset={logo}/><i/><span className="sdx-stage-name">{productName}</span></>:<><StageMark/><strong>{productName}</strong></>}</span>
   <b className="sdx-stage-heading"/>
   <b className="sdx-stage-field"/>
   <b className="sdx-stage-field"/>
   <em className="sdx-stage-primary"/>
  </span>
 </div>;
}

/**
 * The console: the top bar with the logo, the rail, the navigator and the workspace. With a background, the image sits
 * blurred behind the whole miniature and each region dims it with the scrim of the choice (the --sdx-scrim-* custom
 * properties of the console, read through .sdx-backdrop-scrims of ui/shell/console-backdrop.css).
 */
function ConsoleStage({view,appearance}:{view:BrandingManageView;appearance:PreviewAppearance}){
 const state=view.backgrounds.console,background=shownBackground(state),scrim=background?state.scrim:null,logo=shownLogo(view.portal,appearance);
 return <div className={background&&scrim?'sdx-branding-fade sdx-stage-console is-image sdx-backdrop-scrims':'sdx-branding-fade sdx-stage-console'} style={scrim?backdropScrimProperties(scrim) as CSSProperties:undefined}>
  {background&&scrim&&<span className="sdx-stage-wallpaper"><img key={background.url} className="sdx-branding-fade sdx-stage-image" src={background.url} alt="" decoding="async"/></span>}
  <span className="sdx-stage-topbar">{logo?<StageLogo asset={logo}/>:<span className="sdx-stage-brand"><StageMark/><strong>{productName}</strong></span>}<i className="sdx-stage-search"/><i className="sdx-stage-avatar"/></span>
  <span className="sdx-stage-rail"><i className="is-active"/><i/><i/></span>
  <span className="sdx-stage-navigator"><b className="is-selected"/><b/><b/><b/></span>
  <span className="sdx-stage-workspace"><b className="sdx-stage-heading"/><em className="sdx-stage-primary"/><b className="sdx-stage-panel"/><b className="sdx-stage-panel"/></span>
 </div>;
}

/** Light and Dark with the labels and icons of the appearance switch (ui/shell/theme.tsx); the preview has no "System". */
const appearanceOptions=themeOptions.flatMap(option=>option.theme==='system'?[]:[{id:option.theme,label:option.label,icon:option.Icon as IconType}]);

/**
 * The card Preview for a loaded view: the shown page and appearance (state of the page, so a background change can
 * switch the page), and the color selection of the card Colors.
 */
export function BrandingPreview({view,surface,appearance,onSurface,onAppearance,selection=null}:{view:BrandingManageView;surface:PreviewSurface;appearance:PreviewAppearance;
 onSurface:(surface:PreviewSurface)=>void;onAppearance:(appearance:PreviewAppearance)=>void;selection?:SchemeSelection|null}){
 const t=useT();
 const surfaces:SegmentItem<PreviewSurface>[]=[{id:'signin',label:t('branding.target.signin')},{id:'console',label:t('branding.target.console')}];
 const modes:SegmentItem<PreviewAppearance>[]=appearanceOptions.map(option=>({...option,label:t(option.label)}));
 const pending=pendingSchemeProperties(selection);
 return <Card title={t('branding.preview.title')} icon={Eye} iconTone="accent" id="sdx-branding-preview">
  <div className="sdx-stage">
   <div className="sdx-stage-controls">
    <Segmented size="sm" label={t('branding.preview.surface')} items={surfaces} value={surface} onChange={onSurface}/>
    <Segmented size="sm" iconOnly label={t('branding.preview.appearance')} items={modes} value={appearance} onChange={onAppearance}/>
   </div>
   <div className={`sdx-stage-window sdx-branding-frame-${appearance}`} data-scheme-swatch="brand" style={pending as CSSProperties|undefined} role="img" aria-label={t(surface==='signin'?'branding.signin.preview':'branding.console.preview')}>
    <div className="sdx-stage-tabstrip" aria-hidden="true">
     <span className="sdx-stage-tab"><img key={previewIconUrl(view.portal.icon)} className="sdx-branding-fade" src={previewIconUrl(view.portal.icon)} alt="" decoding="async" width={16} height={16}/><span>{t('meta.title')}</span></span>
    </div>
    <div className="sdx-stage-screen" aria-hidden="true">
     {surface==='signin'?<SigninStage key="signin" view={view} appearance={appearance}/>:<ConsoleStage key="console" view={view} appearance={appearance}/>}
    </div>
   </div>
   {pending&&<p className="sdx-stage-pending sdx-branding-fade" role="status"><i aria-hidden="true"/>{t('branding.preview.pendingColors')}</p>}
   <p className="sdx-stage-caption">{t(surface==='signin'?'branding.preview.signinCaption':'branding.preview.consoleCaption')}</p>
  </div>
 </Card>;
}
