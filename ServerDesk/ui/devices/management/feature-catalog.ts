import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';
import type {WindowsFeature} from '@/lib/types';

export type FeatureNode = {feature:WindowsFeature;children:FeatureNode[];descendantCount:number;installedDescendantCount:number};
export type FeatureCatalog = {roles:FeatureNode[];features:FeatureNode[];unassignedServices:FeatureNode[];hasHierarchy:boolean};
const collator=new Intl.Collator('de',{numeric:true,sensitivity:'base'});
const key=(value:string)=>value.toLowerCase();
const byLabel=(a:FeatureNode,b:FeatureNode)=>collator.compare(a.feature.displayName,b.feature.displayName)||collator.compare(a.feature.name,b.feature.name);

/** Only Windows-provided Parent/SubFeatures relationships are used. Never infer
 * ownership from names, prefixes, indentation or localized display labels. */
export function buildFeatureCatalog(features:readonly WindowsFeature[]):FeatureCatalog{
 const nodes=new Map<string,FeatureNode>(),parents=new Map<string,string>();
 for(const feature of features){const id=key(feature.name);if(!nodes.has(id))nodes.set(id,{feature,children:[],descendantCount:0,installedDescendantCount:0});}
 const ordered=[...nodes.values()].sort(byLabel);
 const attach=(child:string,parent:string)=>{
  if(child===parent||!nodes.has(child)||!nodes.has(parent)||parents.has(child))return;
  let cursor:string|undefined=parent;const seen=new Set<string>();
  while(cursor){if(cursor===child||seen.has(cursor))return;seen.add(cursor);cursor=parents.get(cursor);}
  parents.set(child,parent);
 };
 for(const node of ordered)if(node.feature.parent)attach(key(node.feature.name),key(node.feature.parent));
 // Older collectors may provide only SubFeatures. An explicit Parent (including
 // null for a root) takes precedence, and missing parents stay visible as roots.
 for(const node of ordered)for(const name of node.feature.subFeatures??[]){const child=nodes.get(key(name));if(child&&child.feature.parent===undefined)attach(key(name),key(node.feature.name));}
 for(const [child,parent] of parents)nodes.get(parent)!.children.push(nodes.get(child)!);
 const roots=ordered.filter(node=>!parents.has(key(node.feature.name)));
 const count=(node:FeatureNode)=>{node.children.sort(byLabel);for(const child of node.children){count(child);node.descendantCount+=1+child.descendantCount;node.installedDescendantCount+=(child.feature.installed?1:0)+child.installedDescendantCount;}};
 for(const node of roots)count(node);
 return {roles:roots.filter(node=>node.feature.featureType==='Role'),features:roots.filter(node=>!['Role','Role Service'].includes(node.feature.featureType)),unassignedServices:roots.filter(node=>node.feature.featureType==='Role Service'),hasHierarchy:features.some(feature=>feature.parent!==undefined||feature.subFeatures!==undefined)};
}

export function filterFeatureTree(node:FeatureNode,{installedOnly=false,query='',locale=defaultLocale}:{installedOnly?:boolean;query?:string;locale?:Locale}={}):FeatureNode|null{
 const needle=query.trim().toLocaleLowerCase(locale);
 const selfMatches=!needle||`${node.feature.displayName} ${node.feature.name}`.toLocaleLowerCase(locale).includes(needle);
 const children=node.children.map(child=>filterFeatureTree(child,{installedOnly,query:selfMatches?'':query,locale})).filter((child):child is FeatureNode=>!!child);
 if(installedOnly&&!node.feature.installed&&!children.length)return null;
 if(!selfMatches&&!children.length)return null;
 return {...node,children};
}

export const featureTypeLabel=(feature:WindowsFeature,locale:Locale=defaultLocale)=>translate(locale,feature.featureType==='Role'?'roles.type.role':feature.featureType==='Role Service'?'roles.type.roleService':feature.featureType==='OptionalFeature'?'roles.type.optional':'roles.type.feature');
