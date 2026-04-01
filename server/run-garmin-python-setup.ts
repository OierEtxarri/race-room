import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.ts';

const pythonBin = path.join(config.rootDir, '.venv-garmin', 'bin', 'python');
const scriptPath = path.join(config.rootDir, 'server', 'python', 'garmin_setup.py');

const child = spawn(pythonBin, [scriptPath], {
  stdio: 'inherit',
  env: {
    ...process.env,
    GARMIN_EMAIL: config.garminEmail,
    GARMIN_PASSWORD: config.garminPassword,
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
