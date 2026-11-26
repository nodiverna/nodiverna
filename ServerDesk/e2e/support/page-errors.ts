// Page errors and console errors that a smoke path may show without failing.
// Every entry needs a reason; an empty list means every pageerror and every
// console.error fails the path. Add an entry only for a message the app cannot
// avoid, never to hide a bug.
export const allowedPageErrors: ReadonlyArray<{pattern: RegExp; reason: string}> = [];

export function allowedPageError(text: string): boolean {
  return allowedPageErrors.some(entry => entry.pattern.test(text));
}
