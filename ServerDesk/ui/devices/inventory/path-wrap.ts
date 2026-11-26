// Where a path or command line may break (Management → Autostart, nodiverna-ui §6): only after a path
// separator or a space, never inside a file name, so "ServerDesk.Agent.exe" stays on one line. The
// cell renders <wbr> between the parts and wraps with overflow-wrap: break-word.

/** The text split after every "\", "/" and space; joining the parts gives the text back. An empty text gives ['']. */
export function pathBreakParts(text:string):string[]{
 return text.split(/(?<=[\\/ ])/);
}
