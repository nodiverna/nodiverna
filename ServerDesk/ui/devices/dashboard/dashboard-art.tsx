// The calm illustrations of the Dashboard's empty states (docs/dashboard.md): small line drawings built from a few
// shapes. Every color comes from a class of dashboard-view.css that reads a token, so they follow the theme and the color
// scheme; no text, no emoji. Decorative: the Empty next to them states the fact in words.
import type {ReactNode} from 'react';

export type DashboardArtKind='alarms'|'offline'|'updates'|'jobs'|'alarm-week'|'devices'|'hidden'|'pinned'|'certificates';

const soft=<circle className="sdx-dash-art-soft" cx="48" cy="32" r="26"/>;
const drawings:Readonly<Record<DashboardArtKind,ReactNode>>={
 // A bell at rest with a check: nothing rings.
 alarms:<>
  {soft}
  <path className="sdx-dash-art-line" d="M36 40c2.5-2.5 3-6 3-10a9 9 0 0 1 18 0c0 4 .5 7.5 3 10z"/>
  <path className="sdx-dash-art-line" d="M45 44a3.2 3.2 0 0 0 6 0"/>
  <path className="sdx-dash-art-mark" d="M60 18l4 4 7-8"/>
 </>,
 // Three devices, each with its signal dot.
 offline:<>
  {soft}
  {[18,28,38].map(y=><g key={y}><rect className="sdx-dash-art-panel" x="28" y={y} width="40" height="8" rx="3"/><circle className="sdx-dash-art-dot" cx="34" cy={y+4} r="1.8"/><path className="sdx-dash-art-line" d={`M40 ${y+4}h20`}/></g>)}
 </>,
 // A window that is up to date.
 updates:<>
  {soft}
  <rect className="sdx-dash-art-panel" x="30" y="16" width="36" height="30" rx="4"/>
  <path className="sdx-dash-art-line" d="M30 24h36"/>
  <path className="sdx-dash-art-mark" d="M41 34l5 5 9-10"/>
 </>,
 // A short list that is done.
 jobs:<>
  {soft}
  <rect className="sdx-dash-art-panel" x="31" y="13" width="34" height="38" rx="4"/>
  {[23,32,41].map(y=><path key={y} className="sdx-dash-art-line" d={`M44 ${y}h14`}/>)}
  {[23,32].map(y=><path key={y} className="sdx-dash-art-mark" d={`M36 ${y}l2 2 3-4`}/>)}
  <circle className="sdx-dash-art-line" cx="38.5" cy="41" r="2"/>
 </>,
 // An empty week: seven columns of quiet cells.
 'alarm-week':<>
  {[0,1,2,3].flatMap(row=>[0,1,2,3,4,5,6].map(column=><rect key={`${row}-${column}`} className="sdx-dash-art-cell" x={14+column*10} y={13+row*10} width="8" height="8" rx="2"/>))}
 </>,
 // A device slot that waits for its first device.
 devices:<>
  {soft}
  <rect className="sdx-dash-art-panel" x="28" y="18" width="40" height="12" rx="3"/>
  <rect className="sdx-dash-art-slot" x="28" y="34" width="40" height="12" rx="3"/>
  <circle className="sdx-dash-art-dot" cx="34" cy="24" r="1.8"/>
  <path className="sdx-dash-art-mark" d="M48 36v8M44 40h8"/>
 </>,
 // Four widget places, none filled.
 hidden:<>
  {[[26,14],[50,14],[26,34],[50,34]].map(([x,y])=><rect key={`${x}-${y}`} className="sdx-dash-art-slot" x={x} y={y} width="20" height="16" rx="3"/>)}
 </>,
 // A device that waits for its pin.
 pinned:<>
  {soft}
  <rect className="sdx-dash-art-panel" x="28" y="30" width="40" height="12" rx="3"/>
  <circle className="sdx-dash-art-dot" cx="34" cy="36" r="1.8"/>
  <path className="sdx-dash-art-line" d="M40 36h20"/>
  <path className="sdx-dash-art-mark" d="M48 12v10M43 12h10M44.5 22h7"/>
 </>,
 // A certificate with its seal, in order.
 certificates:<>
  {soft}
  <rect className="sdx-dash-art-panel" x="29" y="15" width="38" height="28" rx="4"/>
  <path className="sdx-dash-art-line" d="M36 24h16M36 31h10"/>
  <circle className="sdx-dash-art-line" cx="58" cy="38" r="5"/>
  <path className="sdx-dash-art-mark" d="M55.5 38l2 2 3.5-4"/>
 </>,
};

export function DashboardArt({kind}:{kind:DashboardArtKind}){
 return <svg className="sdx-dash-art" viewBox="0 0 96 64" width="96" height="64" aria-hidden="true" focusable="false" data-art={kind}>{drawings[kind]}</svg>;
}
