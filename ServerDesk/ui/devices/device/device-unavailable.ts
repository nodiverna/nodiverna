// Why a device panel cannot be used (nodiverna-ui §5 "Blocked"): the one concrete reason that the
// kit Unavailable names, instead of a generic "for this device or your permissions". The checks run
// in a fixed order, so the reason the viewer can act on least comes first: a sample device, a
// revoked agent, a missing right, a device that never reported, an agent that is too old, the local
// Management mode and last the connection.
export type UnavailableReason='demo'|'revoked'|'right'|'unreported'|'agent'|'mode'|'offline';

export type UnavailableInput={
 demo:boolean;
 revoked:boolean;
 /** The viewer has the right this panel needs on this device. */
 permitted:boolean;
 /** The device has sent a snapshot. */
 reported:boolean;
 /** The agent version can do this (protocol or capability). */
 supported:boolean;
 /** Only checked when given: the panel needs the locally activated Management mode. */
 management?:boolean;
 /** Only checked when given: the panel needs a connected device. */
 online?:boolean;
};

/** The first reason that blocks the panel, or null when nothing does. */
export function unavailableReason(input:UnavailableInput):UnavailableReason|null{
 if(input.demo)return 'demo';
 if(input.revoked)return 'revoked';
 if(!input.permitted)return 'right';
 if(!input.reported)return 'unreported';
 if(!input.supported)return 'agent';
 if(input.management===false)return 'mode';
 if(input.online===false)return 'offline';
 return null;
}
