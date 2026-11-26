// Terminal input (ui/devices/remote/terminal-input.ts): retries without change, merged typing, Unicode paste and the order of
// resizes.
import assert from 'node:assert/strict';
import {appendTerminalInput} from '../../../ui/devices/remote/terminal-input.ts';

let queue=[],next=appendTerminalInput(queue,'a',1);
next=appendTerminalInput(queue,'bc',next);
assert.deepEqual(queue,[{seq:1,action:'input',data:'abc'}]);assert.equal(next,2);
// A lost HTTP response must never make a retry carry changed input.
queue[0].sent=true;const attempted=JSON.stringify(queue[0]);
next=appendTerminalInput(queue,'d',next);next=appendTerminalInput(queue,'ef',next);
assert.equal(JSON.stringify(queue[0]),attempted);assert.equal(queue[1].data,'def');assert.equal(next,3);
queue[1].sent=true;const retry=JSON.stringify(queue[1]);next=appendTerminalInput(queue,'ghi',next);
assert.equal(JSON.stringify(queue[1]),retry);assert.equal(queue[2].seq,3);
// Paste segmentation keeps complete UTF-16 pairs and exactly ordered content.
queue=[{seq:1,action:'input',data:'x'.repeat(4095)}];next=appendTerminalInput(queue,'😀z',2);
assert.equal(queue[0].data.length,4095);assert.equal(queue[1].data,'😀z');assert.equal(next,3);
queue=[];const paste='x'.repeat(4095)+'😀'+'y'.repeat(4096);next=appendTerminalInput(queue,paste,1);
assert.equal(queue.map(frame=>frame.data).join(''),paste);assert.ok(queue.every(frame=>frame.data.length>0&&frame.data.length<=4096));assert.deepEqual(queue.map(frame=>frame.seq),[1,2,3]);assert.equal(next,4);
queue=[{seq:1,action:'resize',cols:100,rows:30}];next=appendTerminalInput(queue,'foo',2);
assert.equal(queue[1].seq,2);assert.equal(queue[0].action,'resize');assert.equal(next,3);
assert.equal(appendTerminalInput(queue,'',next),next);
console.log('PASS terminal input: immutable retries, coalesced untouched typing, contiguous Unicode paste and resize ordering.');
