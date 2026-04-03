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

export function getPersistedUserState(accountKey: string): PersistedUserState | null {
  return mapRow(selectStateStatement.get(normalizeAccountKey(accountKey)) as UserStateRow | undefined);
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
