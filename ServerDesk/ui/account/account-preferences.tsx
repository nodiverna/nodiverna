'use client';
// The card "Preferences" of My account: appearance, color scheme, density, language and start page in one
// place. Each Select applies its change at once through the same functions as the account menu and
// the command palette (applyTheme, selectScheme, applyDensity, the locale setter, saveStartPage); there is no Save.
// Only the start page confirms with a toast, because its effect shows on the next start.
// The switch Console background is stored for the account on the server (PUT /api/account/preferences); it applies at
// once, a rejection rolls back with toast.error (kit Switch), and it waits with its reason while the portal has none.
import {SlidersHorizontal} from 'lucide-react';
import {toast} from 'sonner';
import {schemesFor,type SchemeId,type SchemeMode} from '@/lib/color-schemes';
import {parseTheme,type Theme} from '@/lib/theme';
import {parseDensity,type Density} from '@/lib/density';
import {locales,parseLocale,type Locale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';
import type {StartPage} from '@/lib/console-route';
import {Card} from '@/ui/kit/kit';
import {Field,Select,Switch} from '@/ui/kit/field';
import {themeHeading,themeOptions,useTheme} from '@/ui/shell/theme';
import {densityHeading,densityOptions,useDensity} from '@/ui/shell/density';
import {schemeHeading,schemeLabel,schemeModeHeadings,selectScheme,shownSchemeChoice,useEffectiveMode,useSchemeChoice} from '@/ui/shell/color-scheme';
import {useLocale,useT} from '@/ui/base/locale';
import {isStartPage,saveStartPage,startPageOptions,useStartPage} from '@/ui/shell/start-page';

export type PreferenceSetters={
 setTheme?:(theme:Theme)=>void;
 setScheme?:(id:SchemeId,mode:SchemeMode)=>void;
 setDensity?:(density:Density)=>void;
 setLocale?:(locale:Locale)=>void;
 setStartPage?:(page:StartPage)=>void;
};
/** The account's console background switch: whether the portal has one, the stored value and the setter (a promise). */
export type ConsoleBackgroundPreference={available:boolean;checked:boolean;onChange:(next:boolean)=>Promise<unknown>};
export type PreferenceProps=PreferenceSetters&{
 /** The portal has a brand scheme (ConsoleData.branding.scheme): the scheme list leads with the brand colors. */
 brandScheme?:boolean;
 consoleBackground?:ConsoleBackgroundPreference;
};

/** The Preferences card. The setters default to the real ones; tests pass stubs. */
export function PreferencesCard({setTheme,setScheme=selectScheme,setDensity,setLocale,setStartPage=saveStartPage,brandScheme=false,consoleBackground}:PreferenceProps={}){
 const t=useT(),[theme,applyTheme]=useTheme(),[density,applyDensity]=useDensity(),mode=useEffectiveMode(),choice=shownSchemeChoice(useSchemeChoice(),brandScheme),[locale,applyLocale]=useLocale(),startPage=useStartPage();
 const changeTheme=setTheme??applyTheme,changeDensity=setDensity??applyDensity,changeLocale=setLocale??applyLocale;
 const schemes=schemesFor(mode,{brand:brandScheme});
 return <Card title={t('account.preferences.title')} icon={SlidersHorizontal} iconTone="accent" className="sdx-account-preferences">
  <div className="sdx-form-grid sdx-account-preferences-grid">
   <Field label={t(themeHeading)}>
    <Select id="account-pref-theme" value={theme} onChange={event=>changeTheme(parseTheme(event.target.value))}>
     {themeOptions.map(option=><option key={option.theme} value={option.theme}>{t(option.label)}</option>)}
    </Select>
   </Field>
   <Field label={t(schemeHeading)} hint={<><span className="sdx-scheme-swatch" data-scheme-swatch={choice[mode]} aria-hidden="true"/>{t(schemeModeHeadings[mode])}</>}>
    <Select id="account-pref-scheme" value={choice[mode]} onChange={event=>{const scheme=schemes.find(item=>item.id===event.target.value);if(scheme)setScheme(scheme.id,mode);}}>
     {schemes.map(scheme=><option key={scheme.id} value={scheme.id}>{t(schemeLabel(scheme,brandScheme))}</option>)}
    </Select>
   </Field>
   {consoleBackground&&<Switch id="account-pref-console-background" label={t('account.preferences.consoleBackground')} hint={t('account.preferences.consoleBackgroundHint')}
    checked={consoleBackground.checked} blocked={consoleBackground.available?undefined:t('account.preferences.consoleBackgroundNone')} onChange={next=>consoleBackground.onChange(next)}/>}
   <Field label={t(densityHeading)} hint={t('density.hint')}>
    <Select id="account-pref-density" value={density} onChange={event=>changeDensity(parseDensity(event.target.value))}>
     {densityOptions.map(option=><option key={option.density} value={option.density}>{t(option.label)}</option>)}
    </Select>
   </Field>
   <Field label={t('language.heading')}>
    <Select id="account-pref-language" value={locale} onChange={event=>changeLocale(parseLocale(event.target.value))}>
     {locales.map(value=><option key={value} value={value} lang={value}>{translate(value,'language.name')}</option>)}
    </Select>
   </Field>
   <Field label={t('startPage.heading')} hint={t('account.preferences.startHint')}>
    <Select id="account-pref-start" value={startPage} onChange={event=>{const next=event.target.value;if(isStartPage(next)&&next!==startPage){setStartPage(next);toast.success(t('startPage.saved'));}}}>
     {startPageOptions.map(option=><option key={option.page} value={option.page}>{t(option.label)}</option>)}
    </Select>
   </Field>
  </div>
 </Card>;
}
