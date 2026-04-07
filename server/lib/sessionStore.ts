import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';

export type UserGoal = {
  raceDate: string;
  distanceKm: number;
};

export type AuthProvider = 'garmin' | 'strava';

type BaseSessionRecord = {
  id: string;
  provider: AuthProvider;
  accountKey: string;
  accountLabel: string;
  goal: UserGoal;
  createdAt: number;
  updatedAt: number;
};

export type GarminSessionRecord = BaseSessionRecord & {
  provider: 'garmin';
  garminEmail: string;
  garminPassword: string;
  homeDir: string;
  tokenDirs: {
    python: string;
    mcp: string;
  };
};

export type StravaSessionRecord = BaseSessionRecord & {
  provider: 'strava';
  athleteId: number;
  athleteName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  stravaClientId: string;
  stravaClientSecret: string;
  stravaRedirectUri: string;
};

export type SessionRecord = GarminSessionRecord | StravaSessionRecord;

const sessionDirRoot = path.join(os.tmpdir(), 'garmin-race-room-sessions');
const sessionTtlMs = 7 * 24 * 60 * 60 * 1_000;
const sessions = new Map<string, SessionRecord>();
const globalPythonTokenDir = path.join(os.homedir(), '.garminconnect');
const globalMcpTokenDir = path.join(os.homedir(), '.garmin-mcp');

export const sessionCookieName = 'garmin_race_room_session';
export const defaultGoal: UserGoal = {
  raceDate: '2026-05-10',
  distanceKm: 21.1,
};

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

export function buildGarminAccountKey(email: string): string {
  return `garmin:${email.trim().toLowerCase()}`;
}

export function buildStravaAccountKey(athleteId: number): string {
  return `strava:${athleteId}`;
}

export function isGarminSession(session: SessionRecord): session is GarminSessionRecord {
  return session.provider === 'garmin';
}

export function isStravaSession(session: SessionRecord): session is StravaSessionRecord {
  return session.provider === 'strava';
}

function hasTokenPair(dirPath: string): boolean {
  return (
    fs.existsSync(path.join(dirPath, 'oauth1_token.json')) &&
    fs.existsSync(path.join(dirPath, 'oauth2_token.json'))
  );
}

function copyTokenFile(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  fs.copyFileSync(sourcePath, targetPath);

  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {
    // Ignore chmod failures on environments that do not support POSIX perms.
  }
}

function shouldSeedGlobalGarminTokens(email: string): boolean {
  const configuredEmail = config.garminEmail.trim().toLowerCase();
  return Boolean(configuredEmail) && configuredEmail === email.trim().toLowerCase();
}

function seedSessionTokenDirs(tokenDirs: GarminSessionRecord['tokenDirs'], email: string): void {
  if (!shouldSeedGlobalGarminTokens(email)) {
    return;
  }

  const pythonSeedDir = hasTokenPair(globalPythonTokenDir)
    ? globalPythonTokenDir
    : hasTokenPair(globalMcpTokenDir)
      ? globalMcpTokenDir
      : null;

  if (pythonSeedDir) {
    copyTokenFile(
      path.join(pythonSeedDir, 'oauth1_token.json'),
      path.join(tokenDirs.python, 'oauth1_token.json'),
    );
    copyTokenFile(
      path.join(pythonSeedDir, 'oauth2_token.json'),
      path.join(tokenDirs.python, 'oauth2_token.json'),
    );
  }

  if (hasTokenPair(globalMcpTokenDir)) {
    copyTokenFile(
      path.join(globalMcpTokenDir, 'oauth1_token.json'),
      path.join(tokenDirs.mcp, 'oauth1_token.json'),
    );
    copyTokenFile(
      path.join(globalMcpTokenDir, 'oauth2_token.json'),
      path.join(tokenDirs.mcp, 'oauth2_token.json'),
    );
    copyTokenFile(
      path.join(globalMcpTokenDir, 'profile.json'),
      path.join(tokenDirs.mcp, 'profile.json'),
    );
  }
}

function sessionTokenDirs(sessionId: string): GarminSessionRecord['tokenDirs'] {
  const baseDir = path.join(sessionDirRoot, sessionId);
  return {
    python: path.join(baseDir, '.garminconnect'),
    mcp: path.join(baseDir, '.garmin-mcp'),
  };
}

export function normalizeGoal(input: Partial<UserGoal> | null | undefined): UserGoal {
  const raceDateCandidate =
    typeof input?.raceDate === 'string' && input.raceDate.trim() ? input.raceDate.trim() : defaultGoal.raceDate;
  const raceDate = /^\d{4}-\d{2}-\d{2}$/.test(raceDateCandidate) ? raceDateCandidate : defaultGoal.raceDate;
  const numericDistance = Number(input?.distanceKm);
  const distanceKm =
    Number.isFinite(numericDistance) && numericDistance >= 3 && numericDistance <= 100
      ? Math.round(numericDistance * 10) / 10
      : defaultGoal.distanceKm;

  return {
    raceDate,
    distanceKm,
  };
}

export function createGarminSession(input: {
  garminEmail: string;
  garminPassword: string;
  goal?: Partial<UserGoal>;
}): GarminSessionRecord {
  const id = crypto.randomUUID();
  const homeDir = path.join(sessionDirRoot, id);
  const tokenDirs = sessionTokenDirs(id);
  ensureDir(homeDir);
  ensureDir(tokenDirs.python);
  ensureDir(tokenDirs.mcp);
  const normalizedEmail = input.garminEmail.trim().toLowerCase();
  seedSessionTokenDirs(tokenDirs, normalizedEmail);

  const now = Date.now();
  const session: GarminSessionRecord = {
    id,
    provider: 'garmin',
    accountKey: buildGarminAccountKey(normalizedEmail),
    accountLabel: normalizedEmail,
    garminEmail: normalizedEmail,
    garminPassword: input.garminPassword,
    homeDir,
    goal: normalizeGoal(input.goal),
    tokenDirs,
    createdAt: now,
    updatedAt: now,
  };

  sessions.set(id, session);
  return session;
}

export function createStravaSession(input: {
  athleteId: number;
  athleteName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  stravaClientId: string;
  stravaClientSecret: string;
  stravaRedirectUri: string;
  goal?: Partial<UserGoal>;
}): StravaSessionRecord {
  const id = crypto.randomUUID();
  const now = Date.now();
  const athleteName = input.athleteName.trim() || `Athlete ${input.athleteId}`;
  const session: StravaSessionRecord = {
    id,
    provider: 'strava',
    accountKey: buildStravaAccountKey(input.athleteId),
    accountLabel: athleteName,
    athleteId: input.athleteId,
    athleteName,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    stravaClientId: input.stravaClientId,
    stravaClientSecret: input.stravaClientSecret,
    stravaRedirectUri: input.stravaRedirectUri,
    goal: normalizeGoal(input.goal),
    createdAt: now,
    updatedAt: now,
  };

  sessions.set(id, session);
  return session;
}

export function getSession(sessionId: string | null | undefined): SessionRecord | null {
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId) ?? null;
  if (!session) {
    return null;
  }

  if (session.updatedAt + sessionTtlMs < Date.now()) {
    destroySession(session.id);
    return null;
  }

  if (session.provider === 'garmin') {
    seedSessionTokenDirs(session.tokenDirs, session.garminEmail);
  }

  session.updatedAt = Date.now();
  return session;
}

export function updateSessionGoal(sessionId: string, goal: Partial<UserGoal>): SessionRecord | null {
  const session = getSession(sessionId);
  if (!session) {
    return null;
  }

  session.goal = normalizeGoal(goal);
  session.updatedAt = Date.now();
  return session;
}

export function destroySession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }

  sessions.delete(sessionId);
  if (session.provider === 'garmin') {
    fs.rmSync(session.homeDir, { recursive: true, force: true });
  }
}

export function listSessions(): SessionRecord[] {
  return [...sessions.values()];
}

export function pruneExpiredSessions(): void {
  for (const session of sessions.values()) {
    if (session.updatedAt + sessionTtlMs < Date.now()) {
      destroySession(session.id);
    }
  }
}

function cookieAttributes(maxAgeSeconds: number): string {
  const attributes = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (config.sessionCookieSecure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

export function buildSessionCookie(sessionId: string): string {
  return `${sessionCookieName}=${sessionId}; ${cookieAttributes(Math.floor(sessionTtlMs / 1_000))}`;
}

export function buildClearSessionCookie(): string {
  return `${sessionCookieName}=; ${cookieAttributes(0)}`;
}
