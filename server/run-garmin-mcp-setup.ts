import { spawn } from 'node:child_process';
import { assertGarminCredentials, resolveGarminMcpBuild } from './config.ts';

const { garminEmail, garminPassword } = assertGarminCredentials();

const child = spawn(process.execPath, [resolveGarminMcpBuild('setup')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    GARMIN_EMAIL: garminEmail,
    GARMIN_PASSWORD: garminPassword,
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
