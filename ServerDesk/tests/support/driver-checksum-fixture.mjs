// The driver list that NativeDriverInventoryTests.cs (--drivers-self-test) and
// tests/api/driver-inventory.mjs both hash: the agent and the portal must compute the
// same checksum. The items cover quotes, a backslash, non-ASCII text, a
// surrogate pair, null values and all three signed states. Change both sides together.
export const driverChecksumItems = [
  { key: '0f1e2d3c4b5a6978', deviceName: 'vJoy Device', deviceClass: 'HIDClass', infName: 'oem42.inf', file: 'vjoy.sys', service: 'vjoy', provider: 'Shaul Eizikovich', version: '2.1.9.1', date: '2019-11-20', signed: false, signer: null },
  { key: '00a1b2c3d4e5f607', deviceName: 'Intel(R) Ethernet Connection "I219-LM"', deviceClass: 'Net', infName: 'oem7.inf', file: 'e1d68x64.sys', service: 'e1dexpress', provider: 'Intel', version: '12.19.2.45', date: '2023-04-12', signed: true, signer: 'Microsoft Windows Hardware Compatibility Publisher' },
  { key: 'ffeeddccbbaa9988', deviceName: 'Gerät \\ Müller ✓ 😀', deviceClass: null, infName: null, file: null, service: null, provider: null, version: '1.0', date: null, signed: null, signer: null },
];
export const driverChecksumExpected = '70bbda527642a6f653812e744083182efce18b931ea6d076cd4d8aa61f85081e';
