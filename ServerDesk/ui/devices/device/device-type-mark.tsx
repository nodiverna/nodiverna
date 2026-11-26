'use client';
import type {Server} from '@/lib/types';
import {deviceType,deviceTypeIcons,deviceTypeLabels} from '@/ui/devices/device/device-type-model';
import {useT} from '@/ui/base/locale';
import {cx} from '@/ui/kit/kit';

const glyphSizes={sm:14,md:18,lg:26} as const;

/** The type tile of a device (server, domain controller, laptop, workstation): the type glyph on the accent-soft tile,
 * the muted pending look while the type is unknown. The label names the type for hover and screen readers. */
export function DeviceTypeMark({server,size='md'}:{server:Pick<Server,'snapshot'>;size?:'sm'|'md'|'lg'}){
 const t=useT(),type=deviceType(server),Icon=deviceTypeIcons[type],label=t(deviceTypeLabels[type]);
 return <span className={cx('sdx-platform','sdx-platform-'+size,type==='unknown'&&'pending')} role="img" aria-label={label} title={label}>
  <Icon size={glyphSizes[size]} aria-hidden/>
 </span>;
}
