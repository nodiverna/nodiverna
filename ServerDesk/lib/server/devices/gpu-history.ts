import {gpuSnapshots} from '../agent/telemetry';
import type {GpuSnapshot} from '../../types';

// Old rows carry NULL. A damaged optional inventory must not replace unknown
// utilization with zero or prevent otherwise valid CPU/RAM history from loading.
export function parseGpuHistory(value:unknown):GpuSnapshot[]|undefined{
 if(typeof value!=='string'||value.length>65536)return undefined;
 try{const parsed=gpuSnapshots.safeParse(JSON.parse(value));return parsed.success?parsed.data:undefined;}
 catch{return undefined;}
}
