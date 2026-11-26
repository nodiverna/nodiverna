// The file the mock registry replaces in tests/repo/test-loader.mjs; three importers
// reach it as './target', '../target' and '@/tests/support/fixtures/target'.
export const value = 'real value';
export function other(): string {
  return 'real other';
}
const target = {value};
export default target;
