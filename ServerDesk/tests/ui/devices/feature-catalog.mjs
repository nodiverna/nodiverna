// The Windows feature catalog (ui/devices/management/feature-catalog.ts): hierarchy, German sort order, installed state, partial
// state, fallbacks, broken input and telemetry bounds.
import fs from 'node:fs';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {dirname,resolve} from 'node:path';
const require=createRequire(import.meta.url),ts=require('typescript'),cache=new Map();
function load(file){
 const absolute=resolve(file);if(cache.has(absolute))return cache.get(absolute).exports;
 const loaded={exports:{}};cache.set(absolute,loaded);
 const source=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 // Relative imports inside lib/, alias imports (@/lib/…) from the model in ui/; a plain JavaScript module of runtime/ loads as itself.
 new Function('require','module','exports',source)(name=>name.startsWith('.')&&name.endsWith('.mjs')?require(resolve(dirname(absolute),name)):name.startsWith('.')?load(resolve(dirname(absolute),name)+'.ts'):name.startsWith('@/')?load(resolve(name.slice(2))+'.ts'):require(name),loaded,loaded.exports);
 return loaded.exports;
}
const {buildFeatureCatalog,filterFeatureTree}=load('ui/devices/management/feature-catalog.ts'),{telemetry}=load('lib/server/agent/telemetry.ts');
const feature=(name,displayName,installed,featureType='Role',extra={})=>({name,displayName,installed,featureType,...extra});
const features=[
 feature('Z','Zentrale Dienste',false),feature('Web','Webserver',true,'Role',{parent:null,subFeatures:['Web-Http','Web-Log']}),
 feature('Web-Http','HTTP-Dienste',true,'Role Service',{parent:'Web',subFeatures:['Web-Static']}),
 feature('Web-Static','Statischer Inhalt',false,'Role Service',{parent:'Web-Http'}),
 feature('Web-Log','Anforderungsprotokollierung',true,'Role Service',{parent:'Web'}),
 feature('A','Änderungsdienst',false),feature('NET','Framework',true,'Feature'),
 feature('Web-Fake','Eigenständiger Dienst',true,'Role Service'),
 feature('Partial','Teilweise aktiv',false,'Role',{parent:null}),feature('Partial-Service','Aktiver Dienst',true,'Role Service',{parent:'Partial'})
];
// Older agents report features without hierarchy fields.
const legacyFeature=entry=>{const flat={...entry};delete flat.parent;delete flat.subFeatures;delete flat.depth;return flat;};
const catalog=buildFeatureCatalog(features);
assert.deepEqual(catalog.roles.map(node=>node.feature.name),['A','Partial','Web','Z'],'root roles use German alphabetical labels');
assert.deepEqual(catalog.features.map(node=>node.feature.name),['NET']);
assert.deepEqual(catalog.unassignedServices.map(node=>node.feature.name),['Web-Fake'],'prefix never invents a hierarchy');
const web=catalog.roles.find(node=>node.feature.name==='Web');
assert.deepEqual(web.children.map(node=>node.feature.name),['Web-Log','Web-Http'],'services also sort by localized label');
assert.equal(web.descendantCount,3);assert.equal(web.installedDescendantCount,2);
assert.equal(web.children[1].children[0].feature.name,'Web-Static','nested services remain under their actual parent');
const installed=filterFeatureTree(web,{installedOnly:true});
assert.deepEqual(installed.children.map(node=>node.feature.name),['Web-Log','Web-Http']);
assert.equal(installed.children[1].children.length,0,'installed overview hides uninstalled children');
const query=filterFeatureTree(web,{query:'statischer'});
assert.equal(query.feature.name,'Web');assert.equal(query.children.length,1);assert.equal(query.children[0].children[0].feature.name,'Web-Static','search preserves parent context');
assert.equal(filterFeatureTree(web,{installedOnly:true,query:'statischer'}),null,'installed-only search does not show uninstalled leaves');
assert.equal(filterFeatureTree(web,{query:'WEBSERVER'}).children.length,2,'matching role exposes its services');
assert.equal(filterFeatureTree(catalog.roles[0],{installedOnly:true}),null);
assert.equal(filterFeatureTree(catalog.roles[1],{installedOnly:true}).feature.installed,false,'installed descendant never changes parent state');
const old=buildFeatureCatalog(features.map(legacyFeature));
assert.equal(old.hasHierarchy,false);assert.equal(old.unassignedServices.length,5,'legacy data remains visible without fabricated grouping');
const missing=buildFeatureCatalog([feature('Orphan','Orphan',true,'Role Service',{parent:'Absent'})]);
assert.equal(missing.unassignedServices.length,1);
const subOnly=buildFeatureCatalog([feature('Owner','Owner',false,'Role',{subFeatures:['Child']}),feature('Child','Child',true,'Role Service')]);
assert.equal(subOnly.roles[0].children.length,1,'actual SubFeatures alone can supply hierarchy');
const explicit=buildFeatureCatalog([feature('Owner','Owner',false,'Role',{subFeatures:['Child']}),feature('Child','Child',true,'Role Service',{parent:null})]);
assert.equal(explicit.unassignedServices.length,1,'explicit root wins over conflicting SubFeatures');
const cyclic=buildFeatureCatalog([feature('One','One',true,'Role',{parent:'Two'}),feature('Two','Two',true,'Role Service',{parent:'One'}),feature('Self','Self',false,'Role',{parent:'Self'})]);
const flatten=node=>[node.feature.name,...node.children.flatMap(flatten)];
assert.deepEqual([...cyclic.roles,...cyclic.features,...cyclic.unassignedServices].flatMap(flatten).sort(),['One','Self','Two'],'self/cyclic links remain bounded and every entry visible');
const duplicate=buildFeatureCatalog([feature('Web','Web',true),feature('WEB','Dup',false)]);assert.equal(duplicate.roles.length,1);
const schema=telemetry.shape.features;
assert.equal(schema.safeParse(features).success,true,'new optional metadata accepted');
assert.equal(schema.safeParse(features.map(legacyFeature)).success,true,'old agent payload accepted');
for(const extra of [{depth:-1},{depth:33},{depth:1.2},{parent:3},{subFeatures:['x'.repeat(501)]},{subFeatures:Array(1001).fill('Child')}])assert.equal(schema.safeParse([feature('One','One',true,'Role',extra)]).success,false,'invalid metadata rejected');
assert.equal(schema.parse([feature('One','One',true,'Role',{parent:null,subFeatures:[],depth:1})])[0].parent,null,'root metadata survives schema normalization');
console.log('PASS feature catalog: actual hierarchy, German sorting, nested/installed/query context, partial state, legacy fallback, orphan/cycle/duplicate robustness and telemetry bounds.');
