// The xterm canvas theme. xterm paints on a canvas and cannot read CSS tokens,
// so the terminal reads the resolved colors of its host element instead:
// ui/devices/remote/terminal.css sets background-color, color, caret-color and outline-color of
// .v3-terminal from tokens, inside the fixed-dark surface of globals.css.

export type TerminalColors = Pick<CSSStyleDeclaration, 'backgroundColor' | 'color' | 'caretColor' | 'outlineColor'>;
export type TerminalTheme = {background: string; foreground: string; cursor: string; selectionBackground: string};

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
const numbers = (text: string) => text.split(/[\s,/]+/).filter(Boolean);
const channel = (part: string, scale: number) => part.endsWith('%') ? parseFloat(part) / 100 * 255 : parseFloat(part) * scale;

/** A computed CSS color (rgb(), rgba() or color(srgb …)) as #rrggbb or #rrggbbaa; other text passes through. */
export function hexColor(value: string): string {
  const text = value.trim();
  const rgb = text.match(/^rgba?\(([^)]*)\)$/i);
  const srgb = text.match(/^color\(srgb\s+([^)]*)\)$/i);
  const parts = rgb ? numbers(rgb[1]) : srgb ? numbers(srgb[1]) : null;
  if (!parts || parts.length < 3 || parts.slice(0, 3).some(part => Number.isNaN(parseFloat(part)))) return text;
  const scale = rgb ? 1 : 255;
  const [r, g, b] = parts.slice(0, 3).map(part => channel(part, scale));
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha < 1 ? hex2(alpha * 255) : ''}`;
}

/** The xterm theme from the computed style of the terminal host. */
export function terminalTheme(style: TerminalColors): TerminalTheme {
  return {
    background: hexColor(style.backgroundColor),
    foreground: hexColor(style.color),
    cursor: hexColor(style.caretColor),
    selectionBackground: hexColor(style.outlineColor),
  };
}
