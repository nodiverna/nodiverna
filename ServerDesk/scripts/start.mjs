import { spawn } from 'node:child_process';
import { prepareStandalone, absoluteRuntimePaths } from './prepare-standalone.mjs';

await prepareStandalone();
const child = spawn(process.execPath, ['--import', './runtime/startup.mjs', '.next/standalone/server.js'], {
  env: { ...absoluteRuntimePaths(), HOSTNAME: process.env.HOSTNAME ?? '0.0.0.0' }, stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
