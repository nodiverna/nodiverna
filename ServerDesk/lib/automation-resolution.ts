export type AutomationKind='drift'|'desired'|'runbook';
export type AutomationCandidate={id:string;kind:AutomationKind;slot:string;scopeType:'group'|'device';scopeId:string;templateId:string;templateName:string;payload:Record<string,unknown>;disabled:boolean;actor:string;authVersion:number;priority:number;createdAt:number};
export type EffectiveAutomation=AutomationCandidate&{conflict:boolean;candidateIds:string[]};

// Explicit device choices beat group inheritance. A group at a deeper absolute
// level wins over its ancestors. Multiple memberships never grant a random
// winner when equally specific scopes disagree.
export function resolveAutomation(candidates:AutomationCandidate[]):EffectiveAutomation[]{
 const slots=new Map<string,AutomationCandidate[]>();
 for(const candidate of candidates){const key=candidate.kind+':'+candidate.slot;slots.set(key,[...(slots.get(key)??[]),candidate]);}
 return [...slots.values()].map(rows=>{
  const priority=Math.max(...rows.map(row=>row.priority));
  const winners=rows.filter(row=>row.priority===priority).sort((a,b)=>a.id.localeCompare(b.id));
  const first=winners[0];
  const signatures=new Set(winners.map(row=>row.disabled?'disabled':row.templateId));
  return {...first,conflict:signatures.size>1,candidateIds:winners.map(row=>row.id)};
 }).sort((a,b)=>(a.kind+':'+a.slot).localeCompare(b.kind+':'+b.slot));
}
