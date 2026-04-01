import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.ts';

const execFileAsync = promisify(execFile);

type JsonLike = Record<string, unknown> | unknown[] | string | number | boolean | null;

export class GarminPythonClient {
  async callJson<T extends JsonLike = JsonLike>(
    name: string,
    args?: Record<string, unknown>,
    envOverrides?: Record<string, string>,
  ): Promise<T> {
    const pythonBin = path.join(config.rootDir, '.venv-garmin', 'bin', 'python');
    const scriptPath = path.join(config.rootDir, 'server', 'python', 'garmin_bridge.py');

    try {
      const { stdout } = await execFileAsync(
        pythonBin,
        [scriptPath, name, JSON.stringify(args ?? {})],
        {
          cwd: config.rootDir,
          env: {
            ...process.env,
            ...envOverrides,
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      return JSON.parse(stdout) as T;
    } catch (error) {
      const stderr =
        typeof error === 'object' && error !== null && 'stderr' in error
          ? String(error.stderr ?? '')
          : '';

      if (stderr) {
        const lines = stderr
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);

        for (const line of [...lines].reverse()) {
          let parsed: { error?: string } | null = null;
          try {
            parsed = JSON.parse(line) as { error?: string };
          } catch {
            continue;
          }

          if (parsed.error) {
            throw new Error(parsed.error);
          }
        }

        throw new Error(lines.at(-1) ?? stderr.trim());
      }

      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}

export const garminPythonClient = new GarminPythonClient();
