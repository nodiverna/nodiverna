// Motion that scripts drive (a counting number, a tile that slides to its new place) cannot be switched off by the
// reduced-motion rules of ui/styles/motion.css, so it asks here first.

/** True when the user asked for reduced motion, and wherever the browser cannot tell (no matchMedia: the server, a test). */
export function reducedMotion():boolean{
 if(typeof window==='undefined'||typeof window.matchMedia!=='function')return true;
 return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
