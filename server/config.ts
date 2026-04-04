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

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value);
}

const nodeEnv = process.env.NODE_ENV?.trim() || 'development';
const frontendOrigin =
  process.env.FRONTEND_ORIGIN?.trim() ?? 'http://localhost:5173';
const frontendAppUrl =
  process.env.FRONTEND_APP_URL?.trim() ?? frontendOrigin ?? 'http://localhost:5173/';

export const config = {
  rootDir,
  nodeEnv,
  host: process.env.HOST?.trim() || '127.0.0.1',
  port: Number(process.env.PORT ?? 8787),
  garminEmail: process.env.GARMIN_EMAIL?.trim() ?? '',
  garminPassword: process.env.GARMIN_PASSWORD?.trim() ?? '',
  frontendOrigin,
  frontendAppUrl,
  stravaClientId: process.env.STRAVA_CLIENT_ID?.trim() ?? '',
  stravaClientSecret: process.env.STRAVA_CLIENT_SECRET?.trim() ?? '',
  stravaRedirectUri: process.env.STRAVA_REDIRECT_URI?.trim() ?? '',
  publicStravaEnabled: booleanEnv('PUBLIC_STRAVA_ENABLED', nodeEnv !== 'production'),
  sessionCookieSecure: booleanEnv(
    'SESSION_COOKIE_SECURE',
    frontendAppUrl.startsWith('https://'),
  ),
  serveStaticFrontend: booleanEnv('SERVE_STATIC_FRONTEND', nodeEnv === 'production'),
  llmProvider: process.env.LLM_PROVIDER?.trim().toLowerCase() ?? '',
  llmBaseUrl: process.env.LLM_BASE_URL?.trim() ?? '',
  llmApiKey: process.env.LLM_API_KEY?.trim() ?? '',
  llmModel: process.env.LLM_MODEL?.trim() ?? 'gemma4:e2b',
  llmRouterModel: process.env.LLM_ROUTER_MODEL?.trim() ?? 'functiongemma',
  llmEmbeddingModel: process.env.LLM_EMBED_MODEL?.trim() ?? 'embeddinggemma',
  llmMinIntervalMs: Math.max(30, Number(process.env.LLM_MIN_INTERVAL_MINUTES ?? 360)) * 60 * 1_000,
  llmSemanticMemoryLimit: Math.max(20, Number(process.env.LLM_SEMANTIC_MEMORY_LIMIT ?? 120)),
  dashboardCacheTtlMs: Math.max(5, Number(process.env.DASHBOARD_CACHE_TTL_MINUTES ?? 20)) * 60 * 1_000,
  dashboardFallbackCacheTtlMs: Math.max(1, Number(process.env.DASHBOARD_FALLBACK_CACHE_TTL_MINUTES ?? 5)) * 60 * 1_000,
  dashboardBackgroundRefreshMs: Math.max(15, Number(process.env.DASHBOARD_BACKGROUND_REFRESH_MINUTES ?? 60)) * 60 * 1_000,
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
