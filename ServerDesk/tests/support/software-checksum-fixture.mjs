// The software list that NativeSoftwareInventoryTests.cs (--software-self-test)
// and tests/api/software-inventory.mjs both hash: the agent and the portal must
// compute the same checksum. The items cover quotes, a backslash, a tab, non-ASCII
// text, a surrogate pair, HTML-sensitive characters, user entries without an
// architecture and null values. Change both sides together.
export const softwareChecksumItems = [
  { key: '{8A69D345-D564-463C-AFF1-A69D9E530F96}', name: 'Google Chrome', version: '120.0.6099.130', publisher: 'Google LLC', installDate: '2026-01-15', architecture: 'x64', scope: 'machine' },
  { key: '7-Zip', name: '7-Zip 23.01 (x64)', version: '23.01', publisher: 'Igor Pavlov', installDate: null, architecture: 'x86', scope: 'machine' },
  { key: 'Spotify', name: 'Spotify', version: '1.2.3', publisher: 'Spotify AB', installDate: null, architecture: null, scope: 'user' },
  { key: 'Tool\tKey', name: 'Tool "Quoted" \\ Back', version: null, publisher: 'Müller GmbH ✓ 😀', installDate: null, architecture: 'x64', scope: 'machine' },
  { key: 'arm', name: "<Arm> & 'tool' +1", version: 'v2', publisher: null, installDate: '2025-12-31', architecture: 'arm64', scope: 'machine' },
];
export const softwareChecksumExpected = '85b4fb63c2997665678542a00ca35b168d02a73e8c50be3b83ba1b016b2e342e';
