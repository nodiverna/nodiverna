'use client';
import {useState} from 'react';
import {Info} from 'lucide-react';
import {UsageDataCard,useUsageData,type UsageDataView} from '@/ui/settings/usage-data';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {Notice,SettingsPage} from '@/ui/kit/kit';
import {useT} from '@/ui/base/locale';

/**
 * Settings › Usage data (docs/usage-data.md): the page header of the console frame at its top (ui/shell/page-frame.ts),
 * then the usage data card. The focal point is the consent switch of the card; it applies at once and needs no Save.
 * While usage data is off (view.enabled false) the focal point is an info notice instead, and the card below it is
 * blurred, inert and hidden from assistive technology (.sdx-usage-disabled): it only shows what the function will be.
 * First load shows the facts skeleton, a failed load LoadFailed with "Try again". A console refresh loads again and keeps
 * the card visible.
 */
export default function UsageDataPage({frame}:{frame?:PageFrame}){
 const t=useT();
 const usage=useUsageData();
 const [retrying,setRetrying]=useState(false);
 useFrameRefresh(frame,()=>{void usage.load();});
 const retry=async()=>{setRetrying(true);try{await usage.load();}finally{if(usage.mounted.current)setRetrying(false);}};
 const failed=usage.view?'':usage.loadError;
 const card=(view:UsageDataView)=><UsageDataCard view={view} onChange={usage.setView} reload={usage.load}/>;
 return <>{frameHeader(frame)}<SettingsPage label={t('nav.settings.usageData')} loading={!usage.view&&!failed} loadError={failed||undefined} onRetry={()=>void retry()} retrying={retrying}>
  {usage.view&&(usage.view.enabled?card(usage.view):<>
   <Notice tone="info" icon={Info}>{t('usage.disabled.notice')}</Notice>
   <div className="sdx-usage-disabled" inert aria-hidden="true">{card(usage.view)}</div>
  </>)}
 </SettingsPage></>;
}
