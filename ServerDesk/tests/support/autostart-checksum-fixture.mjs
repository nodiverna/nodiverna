// The autostart entries that NativeAutostartTests.cs (--autostart-self-test) and
// tests/api/autostart.mjs both hash: the agent and the portal must compute the same
// entry IDs and the same checksum. The items cover a quote, backslashes, a
// masked command, non-ASCII text and null values. Change both sides together.
export const autostartFixture = [
  { category: 'run', scope: 'machine', location: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'SecurityHealth', command: '%windir%\\system32\\SecurityHealthSystray.exe', target: 'C:\\Windows\\system32\\SecurityHealthSystray.exe', signature: 'valid', signer: 'Microsoft Windows', publisher: 'Microsoft Corporation', microsoft: true, userPath: false },
  { category: 'startup-folder', scope: 'user', location: 'C:\\Users\\…\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup', name: 'Updater "Tool".lnk', command: '"C:\\Users\\…\\AppData\\Local\\Temp\\upd.exe" --token=[redacted]', target: 'C:\\Users\\…\\AppData\\Local\\Temp\\upd.exe', signature: 'unsigned', signer: null, publisher: null, microsoft: false, userPath: true },
  { category: 'service', scope: 'machine', location: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Müller ✓', name: 'Müller ✓', command: '', target: null, signature: 'unknown', signer: null, publisher: null, microsoft: false, userPath: false },
];
export const autostartFixtureIds = ['850fdeb4603732974ff7c9aa55cac851e072604e9d6953d0543382e3854027e2', '186c655beb8273d6c19d6af367de70457303782798e40f05963c215a60f7a360', '1c44a9072bb236000177aa66e62a0dbbc541ef8795e5cc190d2660ffe56f937c'];
export const autostartFixtureChecksum = 'af20011a547e9f4710da095c578b3cb52a3f16b2607f32f46c89b9c164aecfe5';
