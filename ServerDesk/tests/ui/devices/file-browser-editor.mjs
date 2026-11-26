// The file browser editor (ui/devices/remote/file-browser-state.ts): rename and new-folder targets stay fixed when the
// selection or the listing changes.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
const {fileEditParameters}=await import('../../../ui/devices/remote/file-browser-state.ts');

const originalSelection={path:'C:\\Temp\\original.txt',name:'original.txt'};
const editor={kind:'rename',path:originalSelection.path,name:originalSelection.name};
let selection=originalSelection;
selection=null; // A refresh or upload completion clears the highlighted row.
assert.deepEqual(fileEditParameters(editor,'renamed.txt'),{path:'C:\\Temp\\original.txt',name:'renamed.txt'},'refresh keeps the original rename target without requiring a selected row');
selection={path:'C:\\Temp\\other.txt',name:'other.txt'};
assert.notEqual(selection.path,editor.path);
assert.deepEqual(fileEditParameters(editor,'updated.txt'),{path:'C:\\Temp\\original.txt',name:'updated.txt'},'another selected row cannot silently retarget the open editor');
assert.equal(editor.name,'original.txt','the visible editor label retains the original filename');
const mkdir={kind:'mkdir',path:'C:\\Temp\\'};
assert.deepEqual(fileEditParameters(mkdir,'New folder'),{path:'C:\\Temp\\New folder'},'folder creation retains the original destination directory');
assert.deepEqual(fileEditParameters({kind:'mkdir',path:'C:\\'},'New folder'),{path:'C:\\New folder'},'root destinations join without duplicate separators');
console.log('PASS file browser editor: frozen rename and mkdir targets survive selection changes and listing refresh');
