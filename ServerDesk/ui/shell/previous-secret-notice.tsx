'use client';
import {ExternalLink,KeyRound} from 'lucide-react';
import {docsBase} from '@/ui/base/docs-base';
import {Notice} from '@/ui/kit/kit';
import {useT} from '@/ui/base/locale';

// Owner notice when SESSION_SECRET_PREVIOUS is still set although every stored
// secret uses the current key (runtime/previous-secret.mjs decides on the
// server). It cannot be dismissed: it goes away after the variable is removed,
// the portal restarts and the page reloads.
export const previousSecretDocsUrl=docsBase+'docs/self-hosting.md#change-the-session-secret';

export default function PreviousSecretNotice({removable}:{removable:boolean|undefined}){
 const t=useT();
 if(removable!==true)return null;
 // A link styled like Btn size="sm" variant="ghost", which only renders buttons.
 return <Notice tone="warning" icon={KeyRound} action={<a className="sdx-btn sdx-btn-ghost sdx-btn-sm" href={previousSecretDocsUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} aria-hidden/><span>{t('maintenance.guide')}</span></a>}><strong>{t('previousSecret.title')}</strong> {t('previousSecret.text')}</Notice>;
}
