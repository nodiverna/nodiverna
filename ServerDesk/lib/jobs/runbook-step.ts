import {operations} from '../management';

// The fixed diagnosis operations a runbook step may run without a script.
export const diagnosisOperations=['refresh','scan-updates','test-connection'] as const;
// A runbook step is read-only only as a valid fixed diagnosis without script.
// Pure, so job requirements can decide the agent mode without the database.
export function isReadOnlyRunbookJob(parameters:unknown){
 if(!parameters||typeof parameters!=='object')return false;const p=parameters as Record<string,unknown>;
 return p.kind==='diagnosis'&&typeof p.operation==='string'&&diagnosisOperations.includes(p.operation as typeof diagnosisOperations[number])&&!p.script&&!!operations[p.operation].schema.safeParse(p.operationParameters??{}).success;
}
