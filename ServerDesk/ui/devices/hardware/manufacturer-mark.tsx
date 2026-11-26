'use client';
import {Factory} from 'lucide-react';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {manufacturerLogoPath,type Manufacturer} from '@/ui/devices/hardware/manufacturer-model';
import '@/ui/devices/hardware/manufacturer-mark.css';

const glyphSizes={sm:16,md:20} as const;

/** The manufacturer a device reports: its monochrome logo in the ink color, then its name; the neutral Factory glyph
 * and the name without a logo; the fallback text (or EMPTY_VALUE) without a manufacturer. The logo is decorative and
 * never stands alone: the name is the text. */
export function ManufacturerMark({manufacturer,size='md',fallback}:{manufacturer:Manufacturer|null;size?:'sm'|'md';fallback?:string}){
 if(!manufacturer)return <>{fallback??EMPTY_VALUE}</>;
 const pixels=glyphSizes[size],path=manufacturer.logo?manufacturerLogoPath(manufacturer.id):undefined;
 return <span className={'sdx-manufacturer sdx-manufacturer-'+size}>
  {path
   ?<svg className="sdx-manufacturer-logo" width={pixels} height={pixels} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={path}/></svg>
   :<Factory className="sdx-manufacturer-fallback" size={pixels} aria-hidden/>}
  <span className="sdx-manufacturer-name">{manufacturer.name}</span>
 </span>;
}
