import {Laptop,Monitor,MonitorSmartphone,Network,Server as ServerIcon,type LucideIcon} from 'lucide-react';
import type {MessageKey} from '@/lib/i18n/translate';
import type {Server} from '@/lib/types';

// The type of a device from what the agent already reports (docs/device-workspace.md, "Device type"). The agent has no
// chassis type: server and domain controller come from Win32_ComputerSystem.DomainRole, laptop and workstation from
// the battery. The first matching rule wins.

export type DeviceType='domain-controller'|'server'|'laptop'|'workstation'|'unknown';

/** The device type: no snapshot → unknown; DomainRole 4/5 → domain controller; 2/3 → server; without security data a
 * server installation type or OS name → server; a present battery → laptop; else workstation. */
export function deviceType(server:Pick<Server,'snapshot'>):DeviceType{
 const snapshot=server.snapshot;
 if(!snapshot)return 'unknown';
 const role=snapshot.security?.domainRole;
 if(role===4||role===5)return 'domain-controller';
 if(role===2||role===3)return 'server';
 if(!snapshot.security&&(/^server/i.test(snapshot.osInfo?.installationType??'')||/server/i.test(snapshot.os??'')))return 'server';
 if(snapshot.battery?.present===true)return 'laptop';
 return 'workstation';
}

/** The lucide glyph of each type. Network for a domain controller: the gear icons mean settings in this console. */
export const deviceTypeIcons:Record<DeviceType,LucideIcon>={
 server:ServerIcon,'domain-controller':Network,laptop:Laptop,workstation:Monitor,unknown:MonitorSmartphone,
};

/** The catalog key of each type label. */
export const deviceTypeLabels:Record<DeviceType,MessageKey>={
 server:'deviceType.server','domain-controller':'deviceType.domainController',laptop:'deviceType.laptop',workstation:'deviceType.workstation',unknown:'deviceType.unknown',
};
