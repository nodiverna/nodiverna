'use client';
// The device area Management → Certificates (docs/device-health-signals.md): the
// machine certificates of the stores My, WebHosting and Remote Desktop from the
// snapshot, soonest expiry first, with the expiry pill, the private key flag and
// what the certificate is bound to. Private keys never leave the device. A KPI row
// (expired, expiring within 30 days, valid) leads; the card tile takes the worst
// status; the table is the kit DataTable (cards on a phone).
import {BadgeCheck,CalendarClock,CircleCheck,CircleX} from 'lucide-react';
import type {CertificateEntry,Server} from '@/lib/types';
import {certificateBindingText,certificateStatus,certificateStatusText,certificateStatusTone,deviceCertificates} from '@/ui/devices/inventory/health-signals';
import {EMPTY_VALUE,formatDate} from '@/lib/i18n/format';
import type {Locale} from '@/lib/i18n/locale';
import type {MessageKey} from '@/lib/i18n/translate';
import {Card,Empty,Kpi,KpiRow,SectionHead,StatusPill,exactTime,type IconTone} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {useLocale,useT} from '@/ui/base/locale';
import {toneKind} from '@/ui/devices/inventory/os-support';

/** The head tile: danger when a certificate is expired, warning when one expires within 30 days, accent otherwise. */
export function certificateHeadTone(items:readonly Pick<CertificateEntry,'notAfter'>[],now:number):IconTone{
 const states=items.map(cert=>certificateStatus(cert,now).status);
 return states.includes('expired')?'danger':states.includes('expiring')?'warning':'accent';
}

function certificateColumns(t:(key:MessageKey)=>string,locale:Locale,now:number):DataColumn<CertificateEntry>[]{
 return [
  {id:'subject',label:t('certificates.col.subject'),primary:true,wrap:true,cell:cert=><>{cert.subject}{cert.sans.length>0&&<small className="sdx-cell-note">{cert.sans.join(', ')}</small>}</>},
  {id:'issuer',label:t('certificates.col.issuer'),wrap:true,cell:cert=><span className="sdx-muted-cell">{cert.issuer}</span>},
  {id:'store',label:t('certificates.col.store'),cell:cert=><span className="sdx-muted-cell">{cert.stores.join(', ')}</span>},
  {id:'validFrom',label:t('certificates.col.validFrom'),hideBelow:1280,cell:cert=><span className="sdx-nowrap">{formatDate(locale,cert.notBefore)}</span>},
  {id:'expires',label:t('certificates.col.expires'),cell:cert=>{const {status}=certificateStatus(cert,now);return <span className="sdx-cell-stack"><span className="sdx-nowrap">{formatDate(locale,cert.notAfter)}</span><StatusPill kind={toneKind[certificateStatusTone[status]]}>{certificateStatusText(cert,now,locale)}</StatusPill></span>;}},
  {id:'privateKey',label:t('certificates.col.privateKey'),cell:cert=>cert.hasPrivateKey?t('common.yes'):t('common.no')},
  {id:'boundTo',label:t('certificates.col.boundTo'),wrap:true,cell:cert=>cert.bindings.length?cert.bindings.map(binding=>certificateBindingText(binding,locale)).join(', '):<span className="sdx-muted-cell">{EMPTY_VALUE}</span>},
  {id:'thumbprint',label:t('certificates.col.thumbprint'),mono:true,wrap:true,cell:cert=><span className="sdx-thumbprint">{cert.thumbprint}</span>},
 ];
}

/** The KPI counts of the machine certificates by certificateStatus. */
export function certificateCounts(items:readonly Pick<CertificateEntry,'notAfter'>[],now:number){
 const counts={expired:0,expiring:0,valid:0};
 for(const cert of items)counts[certificateStatus(cert,now).status]++;
 return counts;
}

export default function DeviceCertificates({server,now}:{server:Pick<Server,'id'|'snapshot'>;now:number}){
 const t=useT(),[locale]=useLocale(),inventory=server.snapshot?.certificates,items=deviceCertificates(server);
 const counts=certificateCounts(items,now);
 return <div className="sdx-health-panel">
  <SectionHead hideTitle title={t('certificates.title')} description={t('certificates.meta')} meta={inventory?t('software.reportedAt',{time:exactTime(inventory.collectedAt,locale)}):undefined}/>
  <KpiRow label={t('certificates.title')} entranceId={'certificates-kpi:'+server.id}>
   <Kpi label={t('certificates.kpi.expired')} value={inventory?counts.expired:null} icon={CircleX} tone={inventory&&counts.expired>0?'critical':'neutral'}/>
   <Kpi label={t('certificates.kpi.expiring')} value={inventory?counts.expiring:null} icon={CalendarClock} tone={inventory&&counts.expiring>0?'warning':'neutral'}/>
   <Kpi label={t('certificates.kpi.valid')} value={inventory?counts.valid:null} icon={CircleCheck} tone={inventory?'success':'neutral'}/>
  </KpiRow>
  <Card title={t('certificates.listTitle')} icon={BadgeCheck} iconTone={certificateHeadTone(items,now)} className="sdx-health-card sdx-device-certificates" flush>
   {!inventory?<Empty icon={BadgeCheck} title={t('certificates.title')}>{t('certificates.notReported')}</Empty>
    :<DataTable variant="flush" label={t('certificates.title')} className="sdx-certificate-table" columns={certificateColumns(t,locale,now)} rows={items} rowKey={cert=>cert.thumbprint} cards entranceId="device-certificates"
      empty={{icon:BadgeCheck,title:t('certificates.empty')}} foot={inventory.truncated?t('certificates.truncated'):undefined}/>}
  </Card>
 </div>;
}
