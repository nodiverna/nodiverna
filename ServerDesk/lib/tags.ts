// Tags of devices and device groups: name-value pairs. The types and the
// validation are shared by the server (lib/server/devices/tag-store.ts) and the portal
// (ui/devices/configuration/tags.tsx, the fleet). Pure: no imports, no I/O.
//
// Effective tags of a device: its own tags plus the inheritable tags of its
// group and of every ancestor of that group. For each name (without regard to
// case) the nearest entry wins: device, group, parent groups from near to far.
// Effective tags of a group: its own tags (inheritable or not) plus the
// inheritable tags of its strict ancestors. lib/server/devices/tag-store.ts resolves them.

export const tagNameMax=64;
export const tagValueMax=256;
/** The most tags one device or group can have. */
export const tagLimit=50;
/** The most devices of one bulk change. */
export const tagBulkMax=1000;

export type TagScopeType='device'|'group';
export const isTagScopeType=(value:unknown):value is TagScopeType=>value==='device'||value==='group';

export type TagInput={name:string;value:string;inherit:boolean};
export type TagFieldProblem='required'|'too-long'|'invalid';
export type TagProblems={name?:TagFieldProblem;value?:Exclude<TagFieldProblem,'required'>;inherit?:'invalid'};
export type TagValidation={ok:true;tag:TagInput}|{ok:false;problems:TagProblems};

const controlCharacter=/[\u0000-\u001F\u007F-\u009F]/;
/** The length that the limits count: code points. */
export const tagLength=(text:string)=>[...text].length;
/**
 * The one case rule of tag names: the key under which names are compared,
 * without regard to case. Locale-independent `toLowerCase`, so the browser
 * (drawer, fleet filter) and the server agree without a round trip. The column
 * `tags.name_key` stores its result: lib/server/devices/tag-store.ts sets it from this
 * function with every name it writes, and SQL compares only that column, never
 * PostgreSQL `lower()`, which can disagree for rare characters such as `İ`.
 */
export const tagKey=(name:string)=>name.toLowerCase();

/**
 * Trims name and value and checks them: name 1-64 code points, value 0-256
 * (empty means no value), no control characters, `inherit` a boolean that
 * is false for devices.
 */
export function validateTag(input:{name:unknown;value:unknown;inherit:unknown},scopeType:TagScopeType):TagValidation{
 const problems:TagProblems={};
 const name=typeof input.name==='string'?input.name.trim():null,value=typeof input.value==='string'?input.value.trim():input.value===undefined||input.value===null?'':null;
 if(name===null)problems.name='invalid';
 else if(!name)problems.name='required';
 else if(controlCharacter.test(name))problems.name='invalid';
 else if(tagLength(name)>tagNameMax)problems.name='too-long';
 if(value===null||controlCharacter.test(value))problems.value='invalid';
 else if(tagLength(value)>tagValueMax)problems.value='too-long';
 if(typeof input.inherit!=='boolean'||(scopeType==='device'&&input.inherit))problems.inherit='invalid';
 if(Object.keys(problems).length)return {ok:false,problems};
 return {ok:true,tag:{name:name as string,value:value as string,inherit:input.inherit as boolean}};
}

/** Where an effective tag comes from: the device itself or a group on its path. */
export type TagOrigin={type:'device'}|{type:'group';id:string};
/** One effective tag of a device (effectiveDeviceTags in lib/server/devices/tag-store.ts). */
export type EffectiveDeviceTag={name:string;value:string;origin:TagOrigin};
/** An effective tag as the console sends it with every device. */
export type EffectiveTag={name:string;value:string;inherited:boolean;groupId:string|null};

export type TagOriginView={type:'group';id:string;name:string;visible:boolean};
export type DirectTag={id:string;name:string;value:string;inherit:boolean;updatedAt:number;overrides:{value:string;origin:TagOriginView}|null};
export type InheritedTag={name:string;value:string;origin:TagOriginView};
export type TagEditReason='right';
/** GET /api/tags. */
export type TagView={scope:{type:TagScopeType;id:string;name:string};direct:DirectTag[];inherited:InheritedTag[];canEdit:boolean;reason:TagEditReason|null};
/** GET /api/tags/suggestions. */
export type TagSuggestions={names:{name:string;values:string[]}[]};

/** Sorts by name without regard to case, then by the name itself. */
export function compareTagNames(a:{name:string},b:{name:string}):number{
 const left=tagKey(a.name),right=tagKey(b.name);
 return left<right?-1:left>right?1:a.name<b.name?-1:a.name>b.name?1:0;
}

/** The text of a tag: `Name: Value`, or the name alone without a value. */
export const tagLabel=(tag:{name:string;value:string})=>tag.value?`${tag.name}: ${tag.value}`:tag.name;

/** One chip of the device header: a direct tag (removable) or an effective inherited tag (read-only). */
export type HeaderTagChip={kind:'direct';tag:DirectTag}|{kind:'inherited';tag:InheritedTag};
/**
 * The chips of the device header: the direct tags and the effective inherited
 * tags of the view in one list, sorted by name without regard to case. The
 * server already leaves out inherited tags that a direct tag overrides.
 */
export function headerTagChips(view:Pick<TagView,'direct'|'inherited'>):HeaderTagChip[]{
 const chips:HeaderTagChip[]=[...view.direct.map(tag=>({kind:'direct' as const,tag})),...view.inherited.map(tag=>({kind:'inherited' as const,tag}))];
 return chips.sort((a,b)=>compareTagNames(a.tag,b.tag));
}
