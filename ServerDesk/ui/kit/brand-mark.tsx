// Nodiverna logo: an "N" of two uprights and a diagonal with round nodes at the
// four corners. Draws only with currentColor so the surrounding tile sets it.
export function BrandMark({size}:{size:number}){
 return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
  <path d="M6 18V6l12 12V6"/>
  <circle cx="6" cy="6" r="2" fill="currentColor"/>
  <circle cx="6" cy="18" r="2" fill="currentColor"/>
  <circle cx="18" cy="6" r="2" fill="currentColor"/>
  <circle cx="18" cy="18" r="2" fill="currentColor"/>
 </svg>;
}
