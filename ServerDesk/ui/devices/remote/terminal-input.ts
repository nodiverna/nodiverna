export type QueuedTerminalInput={seq:number;action:'input'|'resize';data?:string;cols?:number;rows?:number;sent?:boolean};

// The first HTTP attempt freezes a frame, even if its response is lost. Only
// untouched frames can coalesce later keystrokes; a retry keeps its payload.
export function appendTerminalInput(queue:QueuedTerminalInput[],data:string,nextSequence:number){
 for(let at=0;at<data.length;){
  const tail=queue.at(-1);
  let merge=tail?.action==='input'&&tail.sent!==true&&(tail.data?.length??0)<4096;
  let take=Math.min(merge?4096-(tail?.data?.length??0):4096,data.length-at);
  if(at+take<data.length&&data.charCodeAt(at+take-1)>=0xD800&&data.charCodeAt(at+take-1)<=0xDBFF)take--;
  // A surrogate pair cannot fit the last remaining character of a frame.
  // Start a fresh frame rather than submitting an empty or malformed input.
  if(take<1){merge=false;take=Math.min(4096,data.length-at);if(at+take<data.length&&data.charCodeAt(at+take-1)>=0xD800&&data.charCodeAt(at+take-1)<=0xDBFF)take--;}
  if(merge)tail!.data=(tail!.data??'')+data.slice(at,at+take);
  else queue.push({seq:nextSequence++,action:'input',data:data.slice(at,at+take)});
  at+=take;
 }
 return nextSequence;
}
