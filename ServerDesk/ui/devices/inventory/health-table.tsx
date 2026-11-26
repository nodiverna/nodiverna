'use client';
// Shared cells of the health signal tables (docs/device-health-signals.md): the
// Signed cell of the driver tables and the signature pill of the autostart
// tables. Sortable heads are the kit SortHead (data-table.tsx).
import type {AutostartSignature} from '@/lib/autostart-inventory';
import {StatusPill,type StatusKind} from '@/ui/kit/kit';
import {useT} from '@/ui/base/locale';

/** Yes, No or Unknown, with No as a warning (an unsigned driver). */
export function SignedCell({signed}:{signed:boolean|null}){
 const t=useT();
 if(signed===null)return <span className="sdx-muted-cell">{t('drivers.signedUnknown')}</span>;
 return signed?<span>{t('common.yes')}</span>:<StatusPill kind="warning">{t('common.no')}</StatusPill>;
}

const signatureKinds:Record<AutostartSignature,StatusKind>={valid:'success',invalid:'critical',unsigned:'warning',unknown:'neutral'};
/** "Signed by <signer>", "Unsigned", "Invalid signature" or "Unknown", with the publisher muted below. */
export function SignatureCell({signature,signer,publisher}:{signature:AutostartSignature;signer:string|null;publisher:string|null}){
 const t=useT();
 const label=signature==='valid'?signer?t('autostart.signature.valid',{signer}):t('autostart.signature.validUnknown'):signature==='invalid'?t('autostart.signature.invalid'):signature==='unsigned'?t('autostart.signature.unsigned'):t('autostart.signature.unknown');
 return <span className="sdx-cell-stack"><StatusPill kind={signatureKinds[signature]}>{label}</StatusPill>{publisher&&publisher!==signer&&<small>{publisher}</small>}</span>;
}
