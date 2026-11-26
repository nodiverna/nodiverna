// No light islands are left. Every classic panel uses tokens with dark values,
// so dialogs, sheets and popovers that render in a portal on <body> follow the
// theme like everything else: no content element carries the old class
// sd-light-island, and Tailwind's dark variant applies everywhere.
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {postcss} from '../../support/theme-colors.mjs';

const island='sd-light-island';

// The old class occurs in no source file and no stylesheet.
const walk=(dir,pattern)=>!existsSync(dir)?[]:readdirSync(dir).flatMap(name=>{const file=path.posix.join(dir,name);return statSync(file).isDirectory()?walk(file,pattern):pattern.test(file)?[file]:[];});
const sources=['app','ui','lib'].flatMap(dir=>walk(dir,/\.(?:ts|tsx|css)$/));
assert.ok(sources.length>=300,`the source walk finds the portal files (${sources.length})`);
for(const file of sources)assert.ok(!readFileSync(file,'utf8').includes(island),`${file} does not name ${island}`);

// Content elements of radix primitives that render in a portal (also the names the deleted shadcn wrappers used).
const portalTag=/^(?:[A-Z]\w*\.)?(?:Alert)?(?:Dialog|Sheet|Select|Popover|DropdownMenu|ContextMenu|Menubar|Tooltip|HoverCard)\w*?\.?(?:Sub)?Content$/;

const tokens=text=>text.split(/\s+/).filter(Boolean);
const hasIsland=node=>{
 if(!node)return false;
 if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return tokens(node.text).includes(island);
 if(ts.isJsxExpression(node)||ts.isParenthesizedExpression(node))return hasIsland(node.expression);
 if(ts.isConditionalExpression(node))return hasIsland(node.whenTrue)||hasIsland(node.whenFalse);
 if(ts.isTemplateExpression(node))return tokens(node.head.text).includes(island)||node.templateSpans.some(span=>tokens(span.literal.text).includes(island));
 if(ts.isCallExpression(node))return node.arguments.some(arg=>hasIsland(arg));
 return false;
};

// Returns every portal content element of a source file: [tag, line, hasIsland].
const portals=(file,text)=>{
 const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),found=[];
 const visit=node=>{
  if(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)){
   const tag=node.tagName.getText(source);
   if(portalTag.test(tag)){
    const attr=node.attributes.properties.find(prop=>ts.isJsxAttribute(prop)&&prop.name.getText(source)==='className');
    found.push([tag,source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,hasIsland(attr?.initializer)]);
   }
  }
  if(ts.isCallExpression(node)&&node.expression.getText(source).endsWith('createPortal'))found.push(['createPortal',source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,false]);
  ts.forEachChild(node,visit);
 };
 visit(source);
 return found;
};

// The scanner itself: it finds portal content elements and flags the class in every form.
const probe=portals('probe.tsx',`const a=<DialogContent showCloseButton/>;
const b=<DialogContent className="sd-light-island x"/>;
const c=<AlertDialogContent className="x"/>;
const d=<Popover.Content className={open?'a':'sd-light-island'}/>;
const e=<Popover.Content className={open?'a':undefined}/>;
const f=<SheetContent className={cn('sd-light-island',x)}/>;
const g=<DialogPrimitive.Content className="sd-light-island-x"/>;
const h=<DropdownMenu.SubContent className={\`a \${x} sd-light-island\`}/>;
const i=createPortal(<div/>,document.body);
const j=<DialogHeader className="sd-light-island"/>;`);
assert.deepEqual(probe.map(([tag,,marked])=>[tag,marked]),[
 ['DialogContent',false],['DialogContent',true],['AlertDialogContent',false],['Popover.Content',true],['Popover.Content',false],
 ['SheetContent',true],['DialogPrimitive.Content',false],['DropdownMenu.SubContent',true],['createPortal',false],
]);

// No portal content element in any file carries the class.
const files=[...walk('app',/\.tsx$/),...walk('ui',/\.tsx$/)].sort();
const marked=[],scanned=new Map();
for(const file of files){
 const found=portals(file,readFileSync(file,'utf8'));
 if(found.length)scanned.set(file,found.length);
 for(const [tag,line,flag] of found)if(flag)marked.push(`${file}:${line} <${tag}>`);
}
assert.deepEqual(marked,[],`portals no longer opt into a light island:\n${marked.join('\n')}`);

// Guard against a scanner that silently finds nothing: the known classic portals are covered
// (fleet-agent-updates.tsx is not in the list: it uses the kit Drawer and ConfirmDialog; the step-up
// dialog of mfa-step-up.tsx renders through the kit Dialog in confirm-dialog.tsx).
// My account (account-panel.tsx, passkeys-panel.tsx), the customers page and the usage data question render only kit
// Drawers, Dialogs and ConfirmDialogs, which kit.tsx and confirm-dialog.tsx portal.
for(const file of ['ui/kit/kit.tsx','ui/kit/suggest-input.tsx','ui/kit/confirm-dialog.tsx'])assert.ok(scanned.has(file),`${file} has a portal that is checked`);
// 23 once the Automation pages and the notification and release source settings moved to the kit (their shadcn
// dialogs went), and Help and the command palette render through the kit Drawer and Dialog; 19 once Accounts, User
// groups and Roles moved to the kit (the two shadcn dialogs of the old RBAC panel went); fewer once the customers page,
// the former settings page of the usage data and the usage data question did too; 9 radix portals of the kit and its helpers once the shadcn
// components, the classic group panel and the classic detail drawer were deleted. The floor only catches a scanner that finds nothing.
assert.ok([...scanned.values()].reduce((sum,count)=>sum+count,0)>=8,'at least 8 portals are checked');
assert.equal(portals('ui/account/account-panel.tsx',readFileSync('ui/account/account-panel.tsx','utf8')).length,0,'My account has no portal of its own');
assert.ok(portals('ui/kit/confirm-dialog.tsx',readFileSync('ui/kit/confirm-dialog.tsx','utf8')).length>=2,'the confirmation and the step-up dialog (kit Dialog) are checked');

// No Tailwind dark: variant: the shadcn components that used dark: utilities are deleted, so every surface follows the
// theme through the tokens alone.
const globalsText=readFileSync('app/globals.css','utf8');
const globals=postcss.parse(globalsText);
let variant;
globals.walkAtRules('custom-variant',at=>{variant=at;});
assert.equal(variant,undefined,'globals.css has no @custom-variant');
assert.deepEqual([...walk('app',/\.tsx?$/),...walk('ui',/\.tsx?$/)].filter(file=>/(?:^|[\s"'`])dark:[\w-]/.test(readFileSync(file,'utf8'))),[],'no file in app/ uses a Tailwind dark: utility');

// The dark-only workspace background of the old islands is gone.
globals.walkRules(rule=>{
 if(!rule.selector.includes('.sdx-embedded'))return;
 assert.ok(!rule.nodes.some(node=>node.type==='decl'&&/^(?:background|background-color|border-radius|color-scheme)$/.test(node.prop)),`globals.css has no island rule for .sdx-embedded (${rule.selector})`);
});
assert.doesNotMatch(globalsText,/\[data-theme="(?:dark|system)"\]\s*\.sdx-embedded/,'no dark-only .sdx-embedded rule');

console.log('theme islands ok');
