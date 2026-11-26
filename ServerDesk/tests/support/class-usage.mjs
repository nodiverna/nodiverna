// Which CSS classes the code renders, for the dead-class check of tests/ui/kit/frame-cleanup.mjs.
// A class is rendered when it is a whole word in a string or template literal that names a class (a className attribute,
// a cx() call, a property, variable or parameter whose name holds "class", a classList call) in a .ts or .tsx file under
// app/, lib/ or components/ (comments do not count), or when it starts with the static prefix of a class name built
// from such a literal and a value ('sdx-notice-'+tone, `sdx-btn-${variant}`). Third-party classes come from the named
// list in the guard.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Every file below dir (posix paths); a missing dir gives none. */
export const walk=(dir,out=[])=>{if(!fs.existsSync(dir))return out;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.posix.join(dir,entry.name);if(entry.isDirectory())walk(file,out);else out.push(file);}return out;};
const literalKinds=new Set([ts.SyntaxKind.StringLiteral,ts.SyntaxKind.NoSubstitutionTemplateLiteral,ts.SyntaxKind.TemplateHead,ts.SyntaxKind.TemplateMiddle,ts.SyntaxKind.TemplateTail]);

/**
 * A node that names a class: an attribute, property, variable or parameter whose name holds "class" (className,
 * actionsClassName), an assignment to one (element.className = …), a cx() call or a classList call.
 */
const classy=/class/i;
const classContext=node=>ts.isJsxAttribute(node)&&classy.test(node.name.getText())
 ||ts.isCallExpression(node)&&(ts.isIdentifier(node.expression)&&node.expression.text==='cx'||ts.isPropertyAccessExpression(node.expression)&&ts.isPropertyAccessExpression(node.expression.expression)&&node.expression.expression.name.text==='classList')
 ||ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(node.left)&&classy.test(node.left.name.text)
 ||(ts.isPropertyAssignment(node)||ts.isVariableDeclaration(node)||ts.isParameter(node)||ts.isPropertySignature(node)||ts.isBindingElement(node))&&!!node.name&&classy.test(node.name.getText());

/**
 * The class words and class prefixes of the literals in a class context (classContext) of the given source texts: every
 * word of such a literal, and the last word of one that ends in "-" as a prefix ('sdx-notice-'+tone, `sdx-btn-${variant}`).
 */
export function literalWords(sources){
 const words=new Set(),prefixes=new Set();
 for(const [file,text] of sources){
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const visit=(node,inClass)=>{
   const here=inClass||classContext(node);
   if(here&&literalKinds.has(node.kind)){
    const value=node.text;
    for(const word of value.split(/[^\w-]+/))if(word)words.add(word);
    const tail=value.match(/([A-Za-z][\w-]*-)$/);
    if(tail&&tail[1].length>3)prefixes.add(tail[1]);
   }
   ts.forEachChild(node,child=>visit(child,here));
  };
  visit(source,false);
 }
 return {words,prefixes};
}

/** rendered(name): the class is rendered by app/, lib/ or components/, or listed as third-party. */
export function classUsage(thirdParty=[]){
 const files=['app','ui','lib'].flatMap(dir=>walk(dir)).filter(file=>/\.tsx?$/.test(file)&&!file.endsWith('.d.ts'));
 const {words,prefixes}=literalWords(files.map(file=>[file,fs.readFileSync(file,'utf8')]));
 const prefixList=[...prefixes];
 return name=>words.has(name)||prefixList.some(prefix=>name.startsWith(prefix))||thirdParty.some(rule=>rule.test(name));
}

export const withoutComments=css=>css.replace(/\/\*[\s\S]*?\*\//g,match=>match.replace(/[^\n]/g,' '));
/** The parts of a selector list, split at top-level commas only (not inside :is() or [attr]). */
export const selectorParts=selector=>{const parts=[];let depth=0,current='';for(const char of selector){if(char==='('||char==='[')depth++;if(char===')'||char===']')depth--;if(char===','&&depth===0){parts.push(current.trim());current='';}else current+=char;}parts.push(current.trim());return parts.filter(Boolean);};
const classPattern=/(?<![\w%-])\.(-?[_a-zA-Z][\w-]*)/g;
/** The class names of a selector, wherever they stand (also inside :is(), :where(), :has() and :not()); attribute values do not count. */
export const selectorClasses=selector=>[...new Set([...selector.replace(/\[[^\]]*\]/g,'[]').matchAll(classPattern)].map(found=>found[1]))];

/** The rule selectors of a stylesheet (comments removed), each with its offset: rules nested in @media and @supports too. */
export function cssRules(css){
 const text=withoutComments(css),rules=[];
 for(const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
  const raw=match[1],start=raw.lastIndexOf(';')+1,selector=raw.slice(start).trim();
  if(!selector||selector.startsWith('@')||/^(?:from|to|\d+(?:\.\d+)?%)(?:\s*,\s*(?:from|to|\d+(?:\.\d+)?%))*$/.test(selector))continue;
  rules.push({selector,body:match[2],index:match.index+start});
 }
 return rules;
}

/** The class names of every rule selector of a stylesheet that nobody renders, each with its line. */
export function deadClasses(css,rendered){
 const dead=[];
 for(const rule of cssRules(css))for(const name of selectorClasses(rule.selector))if(!rendered(name))dead.push({name,line:css.slice(0,rule.index).split(/\n/).length});
 return dead;
}
