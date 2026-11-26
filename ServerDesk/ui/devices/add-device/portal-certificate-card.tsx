'use client';
import {ShieldCheck} from 'lucide-react';
import type {PortalCertificateView} from '@/lib/server/agent/portal-certificate';
import type {MessageKey} from '@/lib/i18n/translate';
import {Card,CopyValue,Facts,exactTime} from '@/ui/kit/kit';
import {useLocale,useT} from '@/ui/base/locale';

// The portal's own root certificate (lib/server/agent/portal-certificate.ts) on the page Add device: the value to
// compare with the Windows certificate dialog or an installer script. The console GET carries it for
// the Owner (ConsoleData.portalCertificate); each tab of the page has its own description.
export type CertificateUse='one'|'several';
const descriptions:Record<CertificateUse,{with:MessageKey;without:MessageKey}>={
 one:{with:'addDevice.certificate.one',without:'addDevice.certificate.oneNone'},
 several:{with:'addDevice.certificate.several',without:'addDevice.certificate.severalNone'},
};

/** The certificate card; undefined (console data not there yet) renders nothing, null says that there is no local CA. */
export function PortalCertificateCard({certificate,use}:{certificate:PortalCertificateView|null|undefined;use:CertificateUse}){
 const t=useT(),[locale]=useLocale();
 if(certificate===undefined)return null;
 return <Card className="sdx-portal-certificate" title={t('addDevice.certificate.title')} icon={ShieldCheck} iconTone={certificate?'accent':'neutral'} description={t(certificate?descriptions[use].with:descriptions[use].without)}>
  {certificate&&<Facts stacked items={[
   {id:'name',label:t('addDevice.certificate.name'),value:certificate.name},
   {id:'sha256',label:t('addDevice.certificate.fingerprint'),value:<CopyValue value={certificate.sha256} label={t('addDevice.certificate.copy')} success={t('addDevice.certificate.copied')}/>},
   {id:'valid',label:t('addDevice.certificate.validUntil'),value:exactTime(certificate.notAfter,locale)},
  ]}/>}
 </Card>;
}
