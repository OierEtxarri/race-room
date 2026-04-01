import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(rootDir, '.env') });

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  rootDir,
  port: Number(process.env.PORT ?? 8787),
  garminEmail: process.env.GARMIN_EMAIL?.trim() ?? '',
  garminPassword: process.env.GARMIN_PASSWORD?.trim() ?? '',
  frontendOrigin: process.env.FRONTEND_ORIGIN?.trim() ?? 'http://localhost:5173',
  frontendAppUrl: process.env.FRONTEND_APP_URL?.trim() ?? process.env.FRONTEND_ORIGIN?.trim() ?? 'http://localhost:5173/',
  stravaClientId: process.env.STRAVA_CLIENT_ID?.trim() ?? '',
  stravaClientSecret: process.env.STRAVA_CLIENT_SECRET?.trim() ?? '',
  stravaRedirectUri: process.env.STRAVA_REDIRECT_URI?.trim() ?? '',
  raceDate: '2026-05-10',
};

export function assertGarminCredentials(): { garminEmail: string; garminPassword: string } {
  return {
    garminEmail: requiredEnv('GARMIN_EMAIL'),
    garminPassword: requiredEnv('GARMIN_PASSWORD'),
  };
}

export function assertStravaConfig(): {
  stravaClientId: string;
  stravaClientSecret: string;
  stravaRedirectUri: string;
} {
  return {
    stravaClientId: requiredEnv('STRAVA_CLIENT_ID'),
    stravaClientSecret: requiredEnv('STRAVA_CLIENT_SECRET'),
    stravaRedirectUri: requiredEnv('STRAVA_REDIRECT_URI'),
  };
}

export function resolveLocalBin(binName: string): string {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return path.join(config.rootDir, 'node_modules', '.bin', `${binName}${suffix}`);
}

export function resolveGarminMcpBuild(entry: 'index' | 'setup'): string {
  return path.join(config.rootDir, 'vendor', 'garmin-connect-mcp', 'build', `${entry}.js`);
}
