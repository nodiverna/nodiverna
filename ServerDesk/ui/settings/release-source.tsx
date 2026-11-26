'use client';
import {AlertTriangle,CloudDownload,Info,Package,PackageCheck} from 'lucide-react';
import type {ReleaseImportRow,ReleaseSourceState,ReleaseSourceView} from '@/lib/server/agent/release-source';
import {serverMessageText} from '@/lib/server-messages';
import type {MessageKey} from '@/lib/i18n/translate';
import {Card,Facts,IconTile,Notice,StatusPill,exactTime,relativeTime,type IconTone,type StatusKind} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {Switch} from '@/ui/kit/field';
import {isDevVersion} from '@/lib/agent-update-state';
import {useLocale,useT} from '@/ui/base/locale';
import {EMPTY_VALUE} from '@/lib/i18n/format';

// The release source card of Settings → Agent releases (Owners only, docs/self-hosting.md,
// "Agent releases from GitHub"): the state of the last check and, after a failure, its
// danger notice lead the card (the focal point); then Last check and Source as facts, the
// switch "Import dev builds", the no-rollout note and the last imports with their failure
// reasons. The portal reads the public repository without sign-in; the switch is the
// card's one setting and applies at once (optimistic, rolled back on a failure). The page
// (ui/settings/agent-releases-page.tsx) loads the view with the catalog, polls every 5 s
// while a check is queued or running, and has the page primary "Check now". Importing
// never updates a device.
export const releaseSourceRepository='github.com/nodiverna/nodiverna';
const stateKey:Record<ReleaseSourceState,MessageKey>={idle:'releaseSource.state.idle',queued:'releaseSource.state.queued',running:'releaseSource.state.running',failed:'releaseSource.state.failed'};
const stateKind:Record<ReleaseSourceState,StatusKind>={idle:'success',queued:'waiting',running:'waiting',failed:'critical'};
const statusKey:Record<ReleaseImportRow['status'],MessageKey>={imported:'releaseSource.status.imported',present:'releaseSource.status.present',failed:'releaseSource.status.failed'};
const statusIcon={imported:PackageCheck,present:Package,failed:AlertTriangle} as const;
const statusTone:Record<ReleaseImportRow['status'],IconTone>={imported:'success',present:'neutral',failed:'danger'};
/** Whether a check of the source is queued or running: Check now waits, the page polls every 5 s. */
export const releaseSourceWorking=(source:Pick<ReleaseSourceView,'state'>|null|undefined)=>source?.state==='queued'||source?.state==='running';

/** The neutral "Dev build" tag after the version of a dev build (X.Y.Z-dev.<sha7>); never the accent "Latest". */
export function DevBuildTag(){
 const t=useT();
 return <span className="sdx-tag">{t('releases.devBuild')}</span>;
}

export function ReleaseSource({source,now,onDevBuilds,devBuildsBusy=false}:{
 source:ReleaseSourceView;
 /** The time of the last load, for the relative last-check time. */now:number;
 /** Turns Import dev builds on or off; resolves true when the server took it, false to roll back. */
 onDevBuilds?:(enabled:boolean)=>Promise<boolean>;
 /** A change of the switch is out. */
 devBuildsBusy?:boolean;
}){
 const t=useT(),[locale]=useLocale();
 const lastCheck=source.lastFinishedAt??source.lastStartedAt;
 const columns:DataColumn<ReleaseImportRow>[]=[
  {id:'version',label:t('releaseSource.col.version'),primary:true,cell:row=>row.kind==='plugin'?<span className="sdx-release-extension"><span className="mono">{row.tag}</span><span className="sdx-tag">{t('releaseSource.extensionTag')}</span>{isDevVersion(row.version)&&<DevBuildTag/>}</span>:<span className="sdx-release-version"><span className="mono">{row.version}</span>{isDevVersion(row.version)&&<DevBuildTag/>}</span>},
  {id:'result',label:t('releaseSource.col.result'),cell:row=><span className="sdx-release-result"><IconTile icon={statusIcon[row.status]} tone={statusTone[row.status]} size="sm"/><span><strong>{t(statusKey[row.status])}</strong><small>{t(row.source==='folder'?'releaseSource.origin.folder':'releaseSource.origin.github')}</small></span></span>},
  {id:'details',label:t('releaseSource.col.details'),wrap:true,cell:row=>row.reason?serverMessageText(row.reason,t):EMPTY_VALUE},
  {id:'checked',label:t('releaseSource.col.checked'),cell:row=><span className="mono sdx-muted-cell" title={exactTime(row.attemptedAt,locale)}>{relativeTime(row.attemptedAt,now,locale)}</span>},
 ];
 return (
  <Card title={t('releaseSource.title')} icon={CloudDownload} iconTone={source.state==='failed'?'danger':'accent'} meta={t('releaseSource.lead')} className="sdx-release-source" id="sdx-release-source" flush>
   <div className="sdx-release-source-body">
    <div className="sdx-release-source-state" data-state={source.state} aria-live="polite"><StatusPill kind={stateKind[source.state]} size="lg">{t(stateKey[source.state])}</StatusPill></div>
    {source.state==='failed'&&source.lastError&&<Notice tone="danger" icon={AlertTriangle}>{serverMessageText(source.lastError,t)}</Notice>}
    <Facts columns={2} items={[
     {id:'lastCheck',label:t('releaseSource.lastCheck'),value:lastCheck===null?t('releaseSource.never'):<time dateTime={new Date(lastCheck).toISOString()}>{relativeTime(lastCheck,now,locale)}</time>,hint:lastCheck===null?undefined:exactTime(lastCheck,locale)},
     {id:'source',label:t('releaseSource.source'),value:releaseSourceRepository,mono:true},
    ]}/>
    {onDevBuilds&&<Switch label={t('releaseSource.devBuilds.label')} hint={t('releaseSource.devBuilds.hint')} checked={source.devBuilds} busy={devBuildsBusy} onChange={onDevBuilds}/>}
    <p className="sdx-release-source-note"><Info size={14} aria-hidden/>{t('releaseSource.noRollout')}</p>
   </div>
   <h3 className="sdx-release-source-heading">{t('releaseSource.imports')}</h3>
   <DataTable<ReleaseImportRow> columns={columns} rows={source.imports} rowKey={row=>row.tag} label={t('releaseSource.importsCaption')} variant="flush" cards entranceId="release-source-imports"
    empty={{icon:CloudDownload,title:t('releaseSource.emptyTitle'),children:t('releaseSource.emptyBody')}}/>
  </Card>
 );
}
