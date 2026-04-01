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
