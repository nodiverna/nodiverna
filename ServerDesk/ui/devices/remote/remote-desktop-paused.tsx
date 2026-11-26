'use client';

import {MonitorPause} from 'lucide-react';
import {Empty} from '@/ui/kit/kit';
import {useT} from '@/ui/base/locale';
import '@/ui/styles/console.css';

/** The standalone /remote-desktop page while Remote Desktop is paused: one kit Empty in a card, centred on the page. */
export default function RemoteDesktopPaused(){
 const t=useT();
 return <main className="sdx sdx-standalone">
  <div className="sdx-card">
   <Empty icon={MonitorPause} title={t('rdp.paused.title')}>{t('rdp.paused.notice')}</Empty>
  </div>
 </main>;
}
