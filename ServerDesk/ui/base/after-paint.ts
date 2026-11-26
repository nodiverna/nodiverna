// Work that must not delay the next paint: the callback runs in a task of its own after the next frame. A task queued
// from requestAnimationFrame runs once that frame's rendering (style, layout, paint and the commit to the compositor) is
// done, so the frame shows the state of the event before the work starts. Without frames (a hidden tab, a test without
// a DOM) a timer runs it after at most `latestMs`.

/** Runs work after the next paint; returns a cancel function. */
export function afterNextPaint(work:()=>void,latestMs=250):()=>void{
 const timers:ReturnType<typeof setTimeout>[]=[];
 let done=false,frame:number|null=null;
 const stop=()=>{
  done=true;
  if(frame!==null&&typeof cancelAnimationFrame==='function')cancelAnimationFrame(frame);
  frame=null;
  for(const timer of timers.splice(0))clearTimeout(timer);
 };
 const run=()=>{if(done)return;stop();work();};
 timers.push(setTimeout(run,latestMs));
 if(typeof requestAnimationFrame==='function')frame=requestAnimationFrame(()=>{frame=null;timers.push(setTimeout(run,0));});
 return stop;
}
