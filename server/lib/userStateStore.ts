import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import type { DashboardData } from './dashboard.ts';
import type { UserGoal } from './sessionStore.ts';

type UserStateRow = {
  email: string;
  goal_race_date: string;
  goal_distance_km: number;
  dashboard_json: string | null;
  updated_at: string;
};

export type DailyCheckInRecord = {
  accountKey: string;
  date: string;
  energy: 'low' | 'ok' | 'high';
  legs: 'heavy' | 'normal' | 'fresh';
  mood: 'flat' | 'steady' | 'great';
  note: string | null;
  createdAt: string;
};

type DailyCheckInRow = {
  account_key: string;
  checkin_date: string;
  energy: string;
  legs: string;
  mood: string;
  note: string | null;
  created_at: string;
};

export type PersistedCoachState = {
  accountKey: string;
  inputHash: string;
  snapshotJson: string;
  generatedAt: string;
};

type CoachStateRow = {
  account_key: string;
  input_hash: string;
  snapshot_json: string;
  generated_at: string;
};

export type CoachMemoryRecord = {
  accountKey: string;
  memoryKey: string;
  kind: 'run' | 'checkin' | 'goal' | 'overview' | 'week';
  title: string;
  content: string;
  contentHash: string;
  metadata: Record<string, unknown> | null;
  embedding: number[] | null;
  createdAt: string;
  updatedAt: string;
};

type CoachMemoryRow = {
  account_key: string;
  memory_key: string;
  kind: CoachMemoryRecord['kind'];
  title: string;
  content: string;
  content_hash: string;
  metadata_json: string | null;
  embedding_json: string | null;
  created_at: string;
  updated_at: string;
};

export type PersistedUserState = {
  accountKey: string;
  goal: UserGoal;
  dashboard: DashboardData | null;
  updatedAt: string;
};

const dataDir = path.join(config.rootDir, 'data');
const databasePath = path.join(dataDir, 'garmin-connect.sqlite');

fs.mkdirSync(dataDir, { recursive: true });

const database = new DatabaseSync(databasePath);

database.exec(`
  CREATE TABLE IF NOT EXISTS user_state (
    email TEXT PRIMARY KEY,
    goal_race_date TEXT NOT NULL,
    goal_distance_km REAL NOT NULL,
    dashboard_json TEXT,
    updated_at TEXT NOT NULL
  )
`);

database.exec(`
  CREATE TABLE IF NOT EXISTS daily_checkin (
    account_key TEXT NOT NULL,
    checkin_date TEXT NOT NULL,
    energy TEXT NOT NULL,
    legs TEXT NOT NULL,
    mood TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_key, checkin_date)
  )
`);

database.exec(`
  CREATE TABLE IF NOT EXISTS coach_state (
    account_key TEXT PRIMARY KEY,
    input_hash TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    generated_at TEXT NOT NULL
  )
`);

database.exec(`
  CREATE TABLE IF NOT EXISTS coach_memory (
    account_key TEXT NOT NULL,
    memory_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    metadata_json TEXT,
    embedding_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_key, memory_key)
  )
`);

const selectStateStatement = database.prepare(`
  SELECT email, goal_race_date, goal_distance_km, dashboard_json, updated_at
  FROM user_state
  WHERE email = ?
`);

const upsertGoalStatement = database.prepare(`
  INSERT INTO user_state (email, goal_race_date, goal_distance_km, dashboard_json, updated_at)
  VALUES (?, ?, ?, NULL, ?)
  ON CONFLICT(email) DO UPDATE SET
    goal_race_date = excluded.goal_race_date,
    goal_distance_km = excluded.goal_distance_km,
    dashboard_json = NULL,
    updated_at = excluded.updated_at
`);

const upsertDashboardStatement = database.prepare(`
  INSERT INTO user_state (email, goal_race_date, goal_distance_km, dashboard_json, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(email) DO UPDATE SET
    goal_race_date = excluded.goal_race_date,
    goal_distance_km = excluded.goal_distance_km,
    dashboard_json = excluded.dashboard_json,
    updated_at = excluded.updated_at
`);

const selectRecentCheckInsStatement = database.prepare(`
  SELECT account_key, checkin_date, energy, legs, mood, note, created_at
  FROM daily_checkin
  WHERE account_key = ?
  ORDER BY checkin_date DESC
  LIMIT ?
`);

const upsertDailyCheckInStatement = database.prepare(`
  INSERT INTO daily_checkin (account_key, checkin_date, energy, legs, mood, note, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(account_key, checkin_date) DO UPDATE SET
    energy = excluded.energy,
    legs = excluded.legs,
    mood = excluded.mood,
    note = excluded.note,
    created_at = excluded.created_at
`);

const selectCoachStateStatement = database.prepare(`
  SELECT account_key, input_hash, snapshot_json, generated_at
  FROM coach_state
  WHERE account_key = ?
`);

const upsertCoachStateStatement = database.prepare(`
  INSERT INTO coach_state (account_key, input_hash, snapshot_json, generated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(account_key) DO UPDATE SET
    input_hash = excluded.input_hash,
    snapshot_json = excluded.snapshot_json,
    generated_at = excluded.generated_at
`);

const selectCoachMemoriesStatement = database.prepare(`
  SELECT
    account_key,
    memory_key,
    kind,
    title,
    content,
    content_hash,
    metadata_json,
    embedding_json,
    created_at,
    updated_at
  FROM coach_memory
  WHERE account_key = ?
  ORDER BY updated_at DESC
  LIMIT ?
`);

const upsertCoachMemoryStatement = database.prepare(`
  INSERT INTO coach_memory (
    account_key,
    memory_key,
    kind,
    title,
    content,
    content_hash,
    metadata_json,
    embedding_json,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(account_key, memory_key) DO UPDATE SET
    kind = excluded.kind,
    title = excluded.title,
    content = excluded.content,
    content_hash = excluded.content_hash,
    metadata_json = excluded.metadata_json,
    embedding_json = excluded.embedding_json,
    updated_at = excluded.updated_at
`);

function parseDashboard(rawDashboard: string | null): DashboardData | null {
  if (!rawDashboard) {
    return null;
  }

  try {
    return JSON.parse(rawDashboard) as DashboardData;
  } catch {
    return null;
  }
}

function mapRow(row: UserStateRow | undefined): PersistedUserState | null {
  if (!row) {
    return null;
  }

  return {
    accountKey: row.email,
    goal: {
      raceDate: row.goal_race_date,
      distanceKm: row.goal_distance_km,
    },
    dashboard: parseDashboard(row.dashboard_json),
    updatedAt: row.updated_at,
  };
}

function normalizeAccountKey(accountKey: string): string {
  return accountKey.trim().toLowerCase();
}

function resolvePersistedAccountKeys(accountKey: string): string[] {
  const normalized = normalizeAccountKey(accountKey);
  if (!normalized.startsWith('garmin:')) {
    return [normalized];
  }

  const legacyEmail = normalized.slice('garmin:'.length).trim();
  return legacyEmail ? [normalized, legacyEmail] : [normalized];
}

function mapDailyCheckInRow(row: DailyCheckInRow): DailyCheckInRecord {
  return {
    accountKey: row.account_key,
    date: row.checkin_date,
    energy: row.energy as DailyCheckInRecord['energy'],
    legs: row.legs as DailyCheckInRecord['legs'],
    mood: row.mood as DailyCheckInRecord['mood'],
    note: row.note,
    createdAt: row.created_at,
  };
}

function parseJsonRecord<T>(raw: string | null): T | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function mapCoachMemoryRow(row: CoachMemoryRow): CoachMemoryRecord {
  return {
    accountKey: row.account_key,
    memoryKey: row.memory_key,
    kind: row.kind,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash,
    metadata: parseJsonRecord<Record<string, unknown>>(row.metadata_json),
    embedding: parseJsonRecord<number[]>(row.embedding_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function persistedRowScore(row: UserStateRow): number {
  const dashboard = parseDashboard(row.dashboard_json);
  if (!dashboard) {
    return 0;
  }

  let score = dashboard.fallbackReason ? 1 : 3;

  if (dashboard.overview.hrv !== null || dashboard.overview.readiness !== null || dashboard.overview.vo2Max !== null) {
    score += 3;
  }

  if (dashboard.wellnessTrend.some((entry) => entry.hrv !== null || entry.readiness !== null)) {
    score += 3;
  }

  if (dashboard.vo2Trend.some((entry) => entry.value !== null)) {
    score += 2;
  }

  return score;
}

export function getPersistedUserState(accountKey: string): PersistedUserState | null {
  let bestRow: UserStateRow | null = null;
  let bestScore = -1;

  for (const candidate of resolvePersistedAccountKeys(accountKey)) {
    const row = selectStateStatement.get(candidate) as UserStateRow | undefined;
    if (!row) {
      continue;
    }

    const score = persistedRowScore(row);
    if (score > bestScore) {
      bestRow = row;
      bestScore = score;
    }
  }

  return mapRow(bestRow ?? undefined);
}

export function upsertPersistedGoal(accountKey: string, goal: UserGoal): void {
  const normalizedEmail = normalizeAccountKey(accountKey);
  const now = new Date().toISOString();
  upsertGoalStatement.run(normalizedEmail, goal.raceDate, goal.distanceKm, now);
}

export function upsertPersistedDashboard(input: {
  accountKey: string;
  goal: UserGoal;
  dashboard: DashboardData;
}): void {
  const normalizedEmail = normalizeAccountKey(input.accountKey);
  const now = new Date().toISOString();
  upsertDashboardStatement.run(
    normalizedEmail,
    input.goal.raceDate,
    input.goal.distanceKm,
    JSON.stringify(input.dashboard),
    now,
  );
}

export function listRecentDailyCheckIns(accountKey: string, limit = 7): DailyCheckInRecord[] {
  const normalized = normalizeAccountKey(accountKey);
  const rows = selectRecentCheckInsStatement.all(normalized, limit) as DailyCheckInRow[];
  return rows.map(mapDailyCheckInRow);
}

export function upsertDailyCheckIn(input: {
  accountKey: string;
  date: string;
  energy: DailyCheckInRecord['energy'];
  legs: DailyCheckInRecord['legs'];
  mood: DailyCheckInRecord['mood'];
  note?: string | null;
}): DailyCheckInRecord {
  const normalized = normalizeAccountKey(input.accountKey);
  const now = new Date().toISOString();
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
  upsertDailyCheckInStatement.run(normalized, input.date, input.energy, input.legs, input.mood, note, now);
  return {
    accountKey: normalized,
    date: input.date,
    energy: input.energy,
    legs: input.legs,
    mood: input.mood,
    note,
    createdAt: now,
  };
}

export function getPersistedCoachState(accountKey: string): PersistedCoachState | null {
  const row = selectCoachStateStatement.get(normalizeAccountKey(accountKey)) as CoachStateRow | undefined;
  if (!row) {
    return null;
  }

  return {
    accountKey: row.account_key,
    inputHash: row.input_hash,
    snapshotJson: row.snapshot_json,
    generatedAt: row.generated_at,
  };
}

export function upsertPersistedCoachState(input: {
  accountKey: string;
  inputHash: string;
  snapshotJson: string;
  generatedAt: string;
}): void {
  const normalized = normalizeAccountKey(input.accountKey);
  upsertCoachStateStatement.run(normalized, input.inputHash, input.snapshotJson, input.generatedAt);
}

export function listCoachMemories(accountKey: string, limit = 120): CoachMemoryRecord[] {
  const normalized = normalizeAccountKey(accountKey);
  const rows = selectCoachMemoriesStatement.all(normalized, limit) as CoachMemoryRow[];
  return rows.map(mapCoachMemoryRow);
}

export function upsertCoachMemories(input: {
  accountKey: string;
  items: Array<{
    memoryKey: string;
    kind: CoachMemoryRecord['kind'];
    title: string;
    content: string;
    contentHash: string;
    metadata?: Record<string, unknown> | null;
    embedding?: number[] | null;
    createdAt?: string;
  }>;
}): void {
  const normalized = normalizeAccountKey(input.accountKey);
  const now = new Date().toISOString();

  for (const item of input.items) {
    upsertCoachMemoryStatement.run(
      normalized,
      item.memoryKey,
      item.kind,
      item.title,
      item.content,
      item.contentHash,
      item.metadata ? JSON.stringify(item.metadata) : null,
      item.embedding ? JSON.stringify(item.embedding) : null,
      item.createdAt ?? now,
      now,
    );
  }
}
