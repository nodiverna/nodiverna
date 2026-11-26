'use client';
// Settings › Branding: the state tag of a setting (docs/branding.md). "Default" is the plain tag, "Custom" the tag of a
// changed value (the look of an override, .sdx-tag-changed), so the two states differ in words and in look. A new
// state remounts the tag (keyed), so it fades in.
import {useT} from '@/ui/base/locale';
import {stateKey} from '@/ui/settings/branding-model';

export function BrandingStateTag({custom}:{custom:boolean}){
 const t=useT();
 return <span key={String(custom)} className={custom?'sdx-tag sdx-tag-sm sdx-tag-changed sdx-branding-fade':'sdx-tag sdx-tag-sm sdx-branding-fade'}>{t(stateKey(custom))}</span>;
}
