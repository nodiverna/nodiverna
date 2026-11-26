// The safe answer renderer of the device assistant (docs/ai-assistant.md): it
// turns the answer text of a model into tokens for paragraphs, bullet and
// numbered lists, bold, inline code and code blocks. The UI renders the tokens
// as React elements, so text is always escaped. There is no raw HTML, no link
// and no image: Markdown links and images stay plain text, so no external URL
// is ever loaded. Pure, shared by the client and the tests.

/** The longest answer that is shown; longer text is cut. */
export const answerCharLimit=16_000;
export type AnswerInline={type:'text'|'bold'|'code';text:string}|{type:'break'};
export type AnswerBlock=
 {type:'paragraph';inlines:AnswerInline[]}|
 {type:'heading';inlines:AnswerInline[]}|
 {type:'list';ordered:boolean;start:number;items:AnswerInline[][]}|
 {type:'code';text:string};

const inlinePattern=/(`[^`\n]+`)|(\*\*(?=\S)[^\n]*?\S\*\*)|(__(?=\S)[^\n]*?\S__)/g;
/** Bold (** or __) and inline code; everything else is text, link and image syntax included. */
export function answerInlines(text:string):AnswerInline[]{
 const result:AnswerInline[]=[];let last=0;
 const push=(part:AnswerInline)=>{const previous=result.at(-1);if(part.type==='text'&&previous?.type==='text')previous.text+=part.text;else result.push(part);};
 for(const match of text.matchAll(inlinePattern)){
  if(match.index>last)push({type:'text',text:text.slice(last,match.index)});
  const token=match[0];
  push(match[1]?{type:'code',text:token.slice(1,-1)}:{type:'bold',text:token.slice(2,-2)});
  last=match.index+token.length;
 }
 if(last<text.length)push({type:'text',text:text.slice(last)});
 return result;
}
const linesToInlines=(lines:string[])=>lines.flatMap((line,index)=>index?[{type:'break'} as AnswerInline,...answerInlines(line)]:answerInlines(line));

const fence=/^\s*(```|~~~)/;
const bullet=/^\s*[-*+]\s+(.*)$/;
const numbered=/^\s*(\d{1,9})[.)]\s+(.*)$/;
const heading=/^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
/** The blocks of an answer, cut to answerCharLimit characters. */
export function answerTokens(answer:string):AnswerBlock[]{
 const lines=answer.slice(0,answerCharLimit).replace(/\r\n?/g,'\n').split('\n');
 const blocks:AnswerBlock[]=[];
 let paragraph:string[]=[];let list:{ordered:boolean;start:number;items:string[][]}|null=null;
 const flush=()=>{
  if(paragraph.length)blocks.push({type:'paragraph',inlines:linesToInlines(paragraph)});
  if(list)blocks.push({type:'list',ordered:list.ordered,start:list.start,items:list.items.map(linesToInlines)});
  paragraph=[];list=null;
 };
 for(let index=0;index<lines.length;index++){
  const line=lines[index];
  const open=fence.exec(line);
  if(open){
   flush();
   const code:string[]=[];
   for(index++;index<lines.length&&!lines[index].trim().startsWith(open[1]);index++)code.push(lines[index]);
   blocks.push({type:'code',text:code.join('\n')});
   continue;
  }
  if(!line.trim()){flush();continue;}
  const title=heading.exec(line);
  if(title){flush();blocks.push({type:'heading',inlines:answerInlines(title[1])});continue;}
  const item=bullet.exec(line),number=item?null:numbered.exec(line);
  if(item||number){
   const ordered=!!number;
   if(paragraph.length||list&&list.ordered!==ordered)flush();
   list??={ordered,start:number?Number(number[1]):1,items:[]};
   list.items.push([item?item[1]:number![2]]);
   continue;
  }
  // A line right after a list item that is indented continues that item.
  if(list&&/^\s{2,}\S/.test(line)){list.items.at(-1)!.push(line.trim());continue;}
  if(list)flush();
  paragraph.push(line.trim());
 }
 flush();
 return blocks;
}
