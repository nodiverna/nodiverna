// The safe answer renderer of the device assistant (lib/assistant-answer.ts):
// tokens for paragraphs, bullet and numbered lists, bold, inline code and code
// blocks; HTML, Markdown links and images stay plain text; the 16,000 character
// cap. Also the rendered React elements of the device panel. No database.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const {answerTokens,answerInlines,answerCharLimit}=await import('../../lib/assistant-answer.ts');
const {AnswerView}=await import('../../ui/devices/assistant/device-assistant.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

check(answerTokens('First line\nsecond line\n\nNext paragraph.'),[{type:'paragraph',inlines:[{type:'text',text:'First line'},{type:'break'},{type:'text',text:'second line'}]},{type:'paragraph',inlines:[{type:'text',text:'Next paragraph.'}]}],'paragraphs and line breaks');
check(answerTokens('- one\n* two\n+ three'),[{type:'list',ordered:false,start:1,items:[[{type:'text',text:'one'}],[{type:'text',text:'two'}],[{type:'text',text:'three'}]]}],'a bullet list');
check(answerTokens('3. three\n4) four'),[{type:'list',ordered:true,start:3,items:[[{type:'text',text:'three'}],[{type:'text',text:'four'}]]}],'a numbered list keeps its start');
check(answerTokens('Intro\n- a\n1. b'),[{type:'paragraph',inlines:[{type:'text',text:'Intro'}]},{type:'list',ordered:false,start:1,items:[[{type:'text',text:'a'}]]},{type:'list',ordered:true,start:1,items:[[{type:'text',text:'b'}]]}],'a list after a paragraph, and a new list type starts a new list');
check(answerInlines('Use **Restart** and `sc query spooler` now.'),[{type:'text',text:'Use '},{type:'bold',text:'Restart'},{type:'text',text:' and '},{type:'code',text:'sc query spooler'},{type:'text',text:' now.'}],'bold and inline code');
check(answerTokens('```powershell\nGet-Service | Where Status -eq Stopped\n**not bold**\n```\nAfter.'),[{type:'code',text:'Get-Service | Where Status -eq Stopped\n**not bold**'},{type:'paragraph',inlines:[{type:'text',text:'After.'}]}],'a code block keeps its text as it is');
check(answerTokens('## Updates'),[{type:'heading',inlines:[{type:'text',text:'Updates'}]}],'a heading');
check(answerInlines('<script>alert(1)</script>'),[{type:'text',text:'<script>alert(1)</script>'}],'HTML is text');
check(answerInlines('[x](https://evil.example/a) and ![x](https://evil.example/i.png)'),[{type:'text',text:'[x](https://evil.example/a) and ![x](https://evil.example/i.png)'}],'links and images are text');
check(answerCharLimit,16000,'the cap is 16,000 characters');
const long=answerTokens('a'.repeat(20000));
check(long[0].inlines[0].text.length,16000,'longer answers are cut');

const html=renderToStaticMarkup(React.createElement(AnswerView,{text:'Hello **bold** `code`\n\n- item\n\n<script>alert(1)</script> [x](https://evil.example/a) ![y](https://evil.example/i.png)\n\n```\nraw <b>\n```'}));
ok(html.includes('<strong>bold</strong>')&&html.includes('<code>code</code>')&&html.includes('<ul><li>item</li></ul>'),'bold, code and lists render as elements');
ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')&&!html.includes('<script'),'HTML is escaped');
ok(!/<a\s|<img\s|href=|src=/.test(html),'no link and no image element');
ok(html.includes('<pre><code>raw &lt;b&gt;</code></pre>'),'a code block renders escaped in pre');
process.stdout.write(`PASS assistant answer (${checks} assertions): paragraphs, lists, bold, code, code blocks, HTML, links and images as text, 16,000 character cap.\n`);
