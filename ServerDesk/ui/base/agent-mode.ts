// The agent mode as the UI names it (owner decision D5): "Read-only"/"Nur lesen" and "Management"/"Verwaltung".
// The stored and submitted values stay ReadOnly and Management; every place that shows the mode as a label
// calls agentModeLabel instead of rendering the raw value.
import type {MessageKey} from '@/lib/i18n/translate';

export type AgentMode='ReadOnly'|'Management';
/** The catalog key of a mode label. Any value other than Management is the read-only mode. */
export const agentModeKey=(mode:string|null|undefined):MessageKey=>mode==='Management'?'agentMode.management':'agentMode.readOnly';
/** The label of an agent mode in the console language. */
export const agentModeLabel=(mode:string|null|undefined,t:(key:MessageKey)=>string):string=>t(agentModeKey(mode));
