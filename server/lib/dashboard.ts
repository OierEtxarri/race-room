import {
  differenceInCalendarDays,
  endOfWeek,
  format,
  parseISO,
  startOfToday,
  startOfWeek,
  subDays,
  subWeeks,
} from 'date-fns';
import {
  analyzeAdaptiveGuidance,
  analyzePlanExecution,
  createEmptyPlanExecutionReview,
  type AdaptiveGuidance,
  type PlanExecutionReview,
} from './adaptivePlan.ts';
import { garminClient } from './garminClient.ts';
import type { GarminSessionAuth } from './garminMcpClient.ts';
import { canSchedulePlanDay } from './planWorkouts.ts';
import {
  getStravaAthlete,
  getStravaAthleteStats,
  listStravaActivities,
} from './stravaClient.ts';
import type { StravaSessionRecord, UserGoal } from './sessionStore.ts';

type NullableNumber = number | null;

type RawDateValue = {
  date: string;
  value: NullableNumber;
};

type RunSummary = {
  id: number;
  name: string;
  date: string;
  timeLabel: string | null;
  distanceKm: number;
  durationSeconds: number;
  paceSecondsPerKm: number | null;
  averageHeartRate: number | null;
  elevationGain: number | null;
  trainingEffect: number | null;
  trainingLoad: number | null;
  workoutId: number | null;
};

type TrainingDay = {
  date: string;
  weekday: string;
  title: string;
  intent: string;
  intensity: 'suave' | 'medio' | 'alto' | 'recuperacion' | 'descanso' | 'carrera';
  distanceKm: number | null;
  notes: string;
  status: 'planned' | 'done' | 'missed' | 'moved' | 'adjusted';
  outcome: string | null;
  canSendToGarmin: boolean;
};

type TrainingWeek = {
  title: string;
  focus: string;
  targetKm: number | null;
  coachNote?: string | null;
  days: TrainingDay[];
};

type AdviceCard = {
  title: string;
  body: string;
  tone: 'accent' | 'calm' | 'warning';
};

type GoalCategory = 'speed' | 'tenk' | 'half' | 'marathon';

type GoalMeta = {
  raceDate: string;
  distanceKm: number;
  label: string;
  raceTitle: string;
  category: GoalCategory;
  daysToRace: number;
  totalWeeks: number;
};

type DashboardProviderMeta = {
  key: 'garmin' | 'strava';
  label: string;
  supportsWorkoutPush: boolean;
  supportsWellness: boolean;
};

export type DashboardProviderKey = DashboardProviderMeta['key'];

export type DashboardData = {
  provider: DashboardProviderMeta;
  athlete: {
    name: string;
    location: string | null;
    primaryDevice: string | null;
    avatarPath: string | null;
    raceDate: string;
    daysToRace: number;
  };
  goal: GoalMeta;
  overview: {
    steps: number | null;
    activeCalories: number | null;
    distanceKm: number | null;
    sleepHours: number | null;
    sleepScore: number | null;
    hrv: number | null;
    readiness: number | null;
    vo2Max: number | null;
    trainingStatus: string | null;
    weightKg: number | null;
    averageWeeklyKm: number | null;
    longestRunKm: number | null;
    predictedGoalSeconds: number | null;
  };
  wellnessTrend: Array<{
    date: string;
    label: string;
    steps: number | null;
    sleepHours: number | null;
    hrv: number | null;
    readiness: number | null;
  }>;
  weeklyRunning: Array<{
    weekLabel: string;
    distanceKm: number;
    durationHours: number;
    runCount: number;
  }>;
  vo2Trend: Array<{
    date: string;
    label: string;
    value: number | null;
  }>;
  recentRuns: RunSummary[];
  fitnessSummary: {
    title: string;
    body: string;
  };
  adaptive: AdaptiveGuidance;
  advice: AdviceCard[];
  checkIn: {
    needsToday: boolean;
    latest: {
      date: string;
      energy: 'low' | 'ok' | 'high';
      legs: 'heavy' | 'normal' | 'fresh';
      mood: 'flat' | 'steady' | 'great';
      note: string | null;
      createdAt: string;
    } | null;
    recent: Array<{
      date: string;
      energy: 'low' | 'ok' | 'high';
      legs: 'heavy' | 'normal' | 'fresh';
      mood: 'flat' | 'steady' | 'great';
      note: string | null;
      createdAt: string;
    }>;
  };
  coach: {
    enabled: boolean;
    source: 'gemma4' | 'fallback';
    model: string | null;
    generatedAt: string | null;
    todayMessage: string | null;
  };
  plan: {
    summary: string;
    level: 'conservador' | 'equilibrado' | 'ambicioso';
    paces: {
      easy: string | null;
      steady: string | null;
      tempo: string | null;
      race: string | null;
    };
    weeks: TrainingWeek[];
  };
  fetchedAt: string;
  fallbackReason?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;

  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (Number.isNaN(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (!isObject(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = Number(value.replace(',', '.'));
    return Number.isFinite(normalized) ? normalized : null;
  }

  return null;
}

function toStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function collectObjects(source: unknown, maxDepth = 7): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();

  function walk(node: unknown, depth: number): void {
    if (depth > maxDepth || node === null || typeof node !== 'object' || seen.has(node)) {
      return;
    }

    seen.add(node);

    if (isObject(node)) {
      results.push(node);
      Object.values(node).forEach((value) => walk(value, depth + 1));
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item: unknown) => walk(item, depth + 1));
    }
  }

  walk(source, 0);
  return results;
}

function fuzzyNumber(source: unknown, includes: string[]): number | null {
  const needles = includes.map((item) => item.toLowerCase());

  for (const candidate of collectObjects(source)) {
    for (const [key, value] of Object.entries(candidate)) {
      const normalizedKey = key.toLowerCase();
      if (!needles.some((needle) => normalizedKey.includes(needle))) {
        continue;
      }

      const numeric = toNumber(value);
      if (numeric !== null) {
        return numeric;
      }
    }
  }

  return null;
}

function fuzzyString(source: unknown, includes: string[]): string | null {
  const needles = includes.map((item) => item.toLowerCase());

  for (const candidate of collectObjects(source)) {
    for (const [key, value] of Object.entries(candidate)) {
      const normalizedKey = key.toLowerCase();
      if (!needles.some((needle) => normalizedKey.includes(needle))) {
        continue;
      }

      const stringValue = toStringValue(value);
      if (stringValue) {
        return stringValue;
      }
    }
  }

  return null;
}

function pickNumber(source: unknown, paths: string[], fuzzyKeys: string[] = []): number | null {
  for (const path of paths) {
    const numeric = toNumber(getPath(source, path));
    if (numeric !== null) {
      return numeric;
    }
  }

  return fuzzyKeys.length ? fuzzyNumber(source, fuzzyKeys) : null;
}

function pickString(source: unknown, paths: string[], fuzzyKeys: string[] = []): string | null {
  for (const path of paths) {
    const stringValue = toStringValue(getPath(source, path));
    if (stringValue) {
      return stringValue;
    }
  }

  return fuzzyKeys.length ? fuzzyString(source, fuzzyKeys) : null;
}

function normalizeDurationSeconds(value: unknown): number | null {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }

  if (numeric > 100_000) {
    return Math.round(numeric / 1_000);
  }

  return Math.round(numeric);
}

function normalizeWeightKg(value: unknown): number | null {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }

  if (numeric > 250) {
    return round(numeric / 1_000, 1);
  }

  return round(numeric, 1);
}

function normalizeDistanceKm(value: unknown): number | null {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }

  if (numeric > 500) {
    return round(numeric / 1_000, 1);
  }

  return round(numeric, 1);
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  if (!values.length) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatPace(secondsPerKm: number | null): string | null {
  if (secondsPerKm === null || !Number.isFinite(secondsPerKm)) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round(secondsPerKm));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}/km`;
}

function formatSecondsAsRace(seconds: number | null): string | null {
  if (seconds === null) {
    return null;
  }

  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function isoDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

function classifyGoalDistance(distanceKm: number): GoalCategory {
  if (distanceKm <= 7.5) {
    return 'speed';
  }

  if (distanceKm <= 12.5) {
    return 'tenk';
  }

  if (distanceKm <= 25) {
    return 'half';
  }

  return 'marathon';
}

function formatDistanceLabel(distanceKm: number): string {
  if (Math.abs(distanceKm - 5) < 0.2) {
    return '5K';
  }
  if (Math.abs(distanceKm - 10) < 0.2) {
    return '10K';
  }
  if (Math.abs(distanceKm - 21.1) < 0.3) {
    return 'media maratón';
  }
  if (Math.abs(distanceKm - 42.2) < 0.4) {
    return 'maratón';
  }

  return `${distanceKm.toFixed(distanceKm % 1 === 0 ? 0 : 1)} km`;
}

function formatRaceTitle(distanceKm: number): string {
  if (Math.abs(distanceKm - 5) < 0.2) {
    return 'Carrera 5K';
  }
  if (Math.abs(distanceKm - 10) < 0.2) {
    return 'Carrera 10K';
  }
  if (Math.abs(distanceKm - 21.1) < 0.3) {
    return 'Media maratón';
  }
  if (Math.abs(distanceKm - 42.2) < 0.4) {
    return 'Maratón';
  }

  return `Carrera ${formatDistanceLabel(distanceKm)}`;
}

function countPlanWeeks(today: Date, raceDate: Date): number {
  const todayWeek = startOfWeek(today, { weekStartsOn: 1 });
  const raceWeek = startOfWeek(raceDate, { weekStartsOn: 1 });
  const rawWeeks = Math.floor(differenceInCalendarDays(raceWeek, todayWeek) / 7) + 1;
  return Math.max(1, Math.min(rawWeeks, 16));
}

function buildGoalMeta(goal: UserGoal, today: Date): GoalMeta {
  const raceDate = parseISO(goal.raceDate);

  return {
    raceDate: goal.raceDate,
    distanceKm: goal.distanceKm,
    label: formatDistanceLabel(goal.distanceKm),
    raceTitle: formatRaceTitle(goal.distanceKm),
    category: classifyGoalDistance(goal.distanceKm),
    daysToRace: differenceInCalendarDays(raceDate, today),
    totalWeeks: countPlanWeeks(today, raceDate),
  };
}

function estimateGoalPrediction(
  predictions: Record<string, number>,
  goalDistanceKm: number,
): number | null {
  const knownDistances = [
    { key: '5k', distanceKm: 5 },
    { key: '10k', distanceKm: 10 },
    { key: 'half', distanceKm: 21.0975 },
    { key: 'marathon', distanceKm: 42.195 },
  ] as const;

  for (const candidate of knownDistances) {
    if (Math.abs(candidate.distanceKm - goalDistanceKm) <= 0.25) {
      return predictions[candidate.key] ?? null;
    }
  }

  const available = knownDistances.filter((candidate) => predictions[candidate.key]);
  if (!available.length) {
    return null;
  }

  const base = available.reduce((best, candidate) => {
    if (!best) {
      return candidate;
    }

    return Math.abs(candidate.distanceKm - goalDistanceKm) < Math.abs(best.distanceKm - goalDistanceKm)
      ? candidate
      : best;
  }, null as (typeof available)[number] | null);

  if (!base) {
    return null;
  }

  return Math.round(predictions[base.key]! * (goalDistanceKm / base.distanceKm) ** 1.06);
}

function pickReferenceDate(today: Date): string {
  return isoDate(subDays(today, 1));
}

function normalizeActivityDateParts(rawDate: string): { date: string; timeLabel: string | null } {
  const candidate = rawDate.includes(' ') ? rawDate.replace(' ', 'T') : rawDate;
  const parsed = new Date(candidate);

  if (Number.isNaN(parsed.getTime())) {
    return {
      date: rawDate.slice(0, 10),
      timeLabel: rawDate.length >= 16 ? rawDate.slice(11, 16) : null,
    };
  }

  return {
    date: format(parsed, 'yyyy-MM-dd'),
    timeLabel: format(parsed, 'HH:mm'),
  };
}

function normalizeRun(activity: unknown): RunSummary | null {
  const id = pickNumber(activity, ['activityId', 'activityUUID'], ['activityid']);
  const rawDate =
    pickString(activity, ['startTimeLocal', 'startTimeGMT', 'calendarDate'], ['starttime', 'date']) ??
    null;
  const distanceKm = normalizeDistanceKm(
    getPath(activity, 'distance') ?? getPath(activity, 'distanceInMeters') ?? getPath(activity, 'summaryDTO.distance'),
  );
  const durationSeconds =
    normalizeDurationSeconds(
      getPath(activity, 'movingDuration') ??
        getPath(activity, 'duration') ??
        getPath(activity, 'elapsedDuration') ??
        getPath(activity, 'summaryDTO.duration'),
    ) ?? 0;

  if (id === null || !rawDate || !distanceKm || durationSeconds <= 0) {
    return null;
  }

  const paceSecondsPerKm = distanceKm > 0 ? durationSeconds / distanceKm : null;
  const { date, timeLabel } = normalizeActivityDateParts(rawDate);

  return {
    id,
    name: pickString(activity, ['activityName'], ['name']) ?? 'Entrenamiento',
    date,
    timeLabel,
    distanceKm,
    durationSeconds,
    paceSecondsPerKm: paceSecondsPerKm ? round(paceSecondsPerKm, 0) : null,
    averageHeartRate: pickNumber(activity, ['averageHR', 'summaryDTO.averageHR'], ['averagehr', 'heartrate']),
    elevationGain: pickNumber(activity, ['elevationGain', 'summaryDTO.elevationGain'], ['elevation']),
    trainingEffect: pickNumber(activity, ['aerobicTrainingEffect'], ['trainingeffect']),
    trainingLoad: pickNumber(activity, ['activityTrainingLoad', 'summaryDTO.activityTrainingLoad'], ['trainingload']),
    workoutId: pickNumber(activity, ['workoutId'], ['workoutid']),
  };
}

function isStravaRunActivity(activity: unknown): boolean {
  const sportType = pickString(activity, ['sport_type', 'sportType'], ['sporttype'])?.toLowerCase() ?? '';
  const type = pickString(activity, ['type'], ['type'])?.toLowerCase() ?? '';
  return sportType.includes('run') || type.includes('run');
}

function normalizeStravaRun(activity: unknown): RunSummary | null {
  if (!isStravaRunActivity(activity)) {
    return null;
  }

  const id = pickNumber(activity, ['id'], ['id']);
  const rawDate = pickString(activity, ['start_date_local', 'start_date'], ['startdate']);
  const distanceKm = normalizeDistanceKm(getPath(activity, 'distance'));
  const durationSeconds =
    normalizeDurationSeconds(getPath(activity, 'moving_time') ?? getPath(activity, 'elapsed_time')) ?? 0;

  if (id === null || !rawDate || !distanceKm || durationSeconds <= 0) {
    return null;
  }

  const paceSecondsPerKm = distanceKm > 0 ? durationSeconds / distanceKm : null;
  const workoutType = pickNumber(activity, ['workout_type'], ['workouttype']);
  const { date, timeLabel } = normalizeActivityDateParts(rawDate);

  return {
    id,
    name: pickString(activity, ['name'], ['name']) ?? 'Actividad Strava',
    date,
    timeLabel,
    distanceKm,
    durationSeconds,
    paceSecondsPerKm: paceSecondsPerKm ? round(paceSecondsPerKm, 0) : null,
    averageHeartRate: pickNumber(activity, ['average_heartrate'], ['heartrate']),
    elevationGain: pickNumber(activity, ['total_elevation_gain'], ['elevation']),
    trainingEffect: null,
    trainingLoad: null,
    workoutId: workoutType,
  };
}

function normalizeRangeSeries(
  source: unknown,
  extractor: (value: unknown) => number | null,
): RawDateValue[] {
  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .map((entry) => {
      const date =
        pickString(entry, ['date', 'calendarDate'], ['date']) ??
        pickString(getPath(entry, 'data'), ['calendarDate'], ['date']);

      if (!date) {
        return null;
      }

      const value = extractor(isObject(entry) && 'data' in entry ? entry.data : entry);
      return {
        date: date.slice(0, 10),
        value,
      };
    })
    .filter((entry): entry is RawDateValue => entry !== null);
}

function normalizeSteps(source: unknown): RawDateValue[] {
  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .map((entry) => {
      const date = pickString(entry, ['calendarDate', 'date'], ['date']);
      if (!date) {
        return null;
      }

      return {
        date: date.slice(0, 10),
        value: pickNumber(entry, ['totalSteps', 'steps', 'value'], ['steps']),
      };
    })
    .filter((entry): entry is RawDateValue => entry !== null);
}

function extractSleepHours(value: unknown): number | null {
  const seconds =
    pickNumber(
      value,
      [
        'dailySleepDTO.sleepTimeSeconds',
        'dailySleepDTO.sleepTimeInSeconds',
        'sleepTimeSeconds',
        'sleepTimeInSeconds',
        'sleepSeconds',
      ],
      ['sleeptime', 'sleepseconds'],
    ) ?? null;

  return seconds !== null ? round(seconds / 3_600, 1) : null;
}

function extractSleepScore(value: unknown): number | null {
  return pickNumber(
    value,
    [
      'dailySleepDTO.sleepScores.overallScore',
      'dailySleepDTO.sleepScore',
      'sleepScore',
      'overallScore',
    ],
    ['sleepscore', 'overallscore'],
  );
}

function extractHrv(value: unknown): number | null {
  return pickNumber(
    value,
    ['lastNightAvg', 'lastNightAverage', 'weeklyAvg', 'value'],
    ['hrv', 'nightavg'],
  );
}

function extractReadiness(value: unknown): number | null {
  return pickNumber(
    value,
    ['score', 'readinessScore', 'readiness.value'],
    ['readiness', 'score'],
  );
}

function extractVo2(value: unknown): number | null {
  return pickNumber(
    value,
    ['runningVo2Max', 'vo2MaxPreciseValue', 'vo2Max', 'value'],
    ['vo2', 'runningvo2'],
  );
}

function extractTrainingStatus(value: unknown): string | null {
  const direct =
    pickString(
      value,
      ['mostRecentTrainingStatus.trainingStatus', 'trainingStatus', 'overallTrainingStatus'],
      ['trainingstatus', 'status'],
    ) ?? null;

  if (direct) {
    return direct;
  }

  const statuses = ['productive', 'maintaining', 'recovery', 'peaking', 'detraining', 'overreaching'];
  for (const candidate of collectObjects(value)) {
    for (const item of Object.values(candidate)) {
      const stringValue = toStringValue(item)?.toLowerCase();
      if (!stringValue) {
        continue;
      }

      const matched = statuses.find((status) => stringValue.includes(status));
      if (matched) {
        return matched;
      }
    }
  }

  return null;
}

function extractAcuteChronicRatio(value: unknown): number | null {
  for (const candidate of collectObjects(value)) {
    const acuteTrainingLoad = getPath(candidate, 'acuteTrainingLoadDTO');
    const ratio = toNumber(getPath(acuteTrainingLoad, 'dailyAcuteChronicWorkloadRatio'));

    if (ratio !== null) {
      return ratio;
    }
  }

  return pickNumber(
    value,
    ['mostRecentTrainingStatus.latestTrainingStatusData.acuteTrainingLoadDTO.dailyAcuteChronicWorkloadRatio'],
    ['dailyacutechronicworkloadratio'],
  );
}

function extractLoadBalanceFeedback(value: unknown): string | null {
  return pickString(
    value,
    ['mostRecentTrainingStatus.latestTrainingLoadBalance.trainingBalanceFeedbackPhrase'],
    ['trainingbalancefeedbackphrase', 'loadbalancefeedback', 'balancefeedbackphrase'],
  );
}

function extractRacePredictions(source: unknown): Record<string, number> {
  const predictions: Record<string, number> = {};
  const fieldMap = [
    { label: '5k', paths: ['time5K', 'predicted5KTime', 'fiveK.timeInSeconds'] },
    { label: '10k', paths: ['time10K', 'predicted10KTime', 'tenK.timeInSeconds'] },
    {
      label: 'half',
      paths: ['timeHalfMarathon', 'predictedHalfMarathonTime', 'halfMarathon.timeInSeconds'],
    },
    { label: 'marathon', paths: ['timeMarathon', 'predictedMarathonTime', 'marathon.timeInSeconds'] },
  ] as const;

  for (const field of fieldMap) {
    const rawSeconds = pickNumber(source, [...field.paths], []);
    const normalizedSeconds = normalizeDurationSeconds(rawSeconds);

    if (normalizedSeconds && normalizedSeconds >= 600 && normalizedSeconds <= 30_000) {
      predictions[field.label] = normalizedSeconds;
    }
  }

  for (const candidate of collectObjects(source)) {
    const context = [
      ...Object.keys(candidate),
      ...Object.values(candidate).map((value) => (typeof value === 'string' ? value : '')),
    ]
      .join(' ')
      .toLowerCase();

    const label = context.includes('half')
      ? 'half'
      : context.includes('marathon') && !context.includes('half')
        ? 'marathon'
        : context.includes('10k')
          ? '10k'
          : context.includes('5k')
            ? '5k'
            : null;

    if (!label || predictions[label]) {
      continue;
    }

    const rawSeconds = pickNumber(
      candidate,
      ['predictedTimeInSeconds', 'timeInSeconds', 'timeSeconds', 'predictedTime'],
      ['seconds', 'prediction', 'time'],
    );

    if (rawSeconds === null) {
      continue;
    }

    const normalizedSeconds = normalizeDurationSeconds(rawSeconds);
    if (!normalizedSeconds || normalizedSeconds < 600 || normalizedSeconds > 30_000) {
      continue;
    }

    predictions[label] = normalizedSeconds;
  }

  return predictions;
}

function estimateGoalPredictionFromRuns(runs: RunSummary[], goalDistanceKm: number, today: Date): number | null {
  const minimumDistanceKm = Math.max(4.5, Math.min(goalDistanceKm * 0.45, goalDistanceKm));
  const recentWindowStart = isoDate(subWeeks(today, 12));

  const candidates = runs
    .filter((run) => run.date >= recentWindowStart)
    .filter((run) => run.distanceKm >= minimumDistanceKm)
    .map((run) => ({
      predictedSeconds: run.durationSeconds * (goalDistanceKm / run.distanceKm) ** 1.06,
      distanceGap: Math.abs(run.distanceKm - goalDistanceKm),
      paceSecondsPerKm: run.paceSecondsPerKm ?? run.durationSeconds / run.distanceKm,
    }))
    .filter((candidate) => Number.isFinite(candidate.predictedSeconds))
    .sort((left, right) => {
      if (left.predictedSeconds !== right.predictedSeconds) {
        return left.predictedSeconds - right.predictedSeconds;
      }

      return left.distanceGap - right.distanceGap;
    });

  const best = candidates[0] ?? null;
  if (!best) {
    return null;
  }

  const lowerBound = goalDistanceKm <= 10 ? 900 : goalDistanceKm <= 21.2 ? 3_300 : 8_000;
  const upperBound = goalDistanceKm <= 10 ? 7_200 : goalDistanceKm <= 21.2 ? 14_400 : 24_000;

  return best.predictedSeconds >= lowerBound && best.predictedSeconds <= upperBound
    ? Math.round(best.predictedSeconds)
    : null;
}

function extractLatestWeight(source: unknown): number | null {
  if (!Array.isArray(source)) {
    return normalizeWeightKg(
      getPath(source, 'mostRecentMeasurement.weight') ??
        getPath(source, 'latestMeasurement.weight') ??
        pickNumber(source, ['weight'], ['weight']),
    );
  }

  for (const candidate of [...source].reverse()) {
    const weight = normalizeWeightKg(
      getPath(candidate, 'weight') ??
        getPath(candidate, 'weightInKg') ??
        pickNumber(candidate, ['measurement.weight'], ['weight']),
    );

    if (weight !== null) {
      return weight;
    }
  }

  return null;
}

function mergeWellnessSeries(series: {
  steps: RawDateValue[];
  sleep: RawDateValue[];
  hrv: RawDateValue[];
  readiness: RawDateValue[];
}) {
  const map = new Map<string, { date: string; steps: number | null; sleepHours: number | null; hrv: number | null; readiness: number | null }>();

  for (const step of series.steps) {
    map.set(step.date, {
      date: step.date,
      steps: step.value,
      sleepHours: null,
      hrv: null,
      readiness: null,
    });
  }

  for (const item of series.sleep) {
    const existing = map.get(item.date) ?? { date: item.date, steps: null, sleepHours: null, hrv: null, readiness: null };
    existing.sleepHours = item.value;
    map.set(item.date, existing);
  }

  for (const item of series.hrv) {
    const existing = map.get(item.date) ?? { date: item.date, steps: null, sleepHours: null, hrv: null, readiness: null };
    existing.hrv = item.value;
    map.set(item.date, existing);
  }

  for (const item of series.readiness) {
    const existing = map.get(item.date) ?? { date: item.date, steps: null, sleepHours: null, hrv: null, readiness: null };
    existing.readiness = item.value;
    map.set(item.date, existing);
  }

  return [...map.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((entry) => ({
      ...entry,
      label: format(parseISO(entry.date), 'dd/MM'),
    }));
}

function groupWeeklyRunning(runs: RunSummary[]) {
  const weekly = new Map<string, { distanceKm: number; durationSeconds: number; runCount: number }>();

  for (const run of runs) {
    const weekStart = isoDate(startOfWeek(parseISO(run.date), { weekStartsOn: 1 }));
    const existing = weekly.get(weekStart) ?? { distanceKm: 0, durationSeconds: 0, runCount: 0 };
    existing.distanceKm += run.distanceKm;
    existing.durationSeconds += run.durationSeconds;
    existing.runCount += 1;
    weekly.set(weekStart, existing);
  }

  return [...weekly.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-6)
    .map(([weekStart, values]) => ({
      weekLabel: format(parseISO(weekStart), 'dd MMM'),
      distanceKm: round(values.distanceKm, 1),
      durationHours: round(values.durationSeconds / 3_600, 1),
      runCount: values.runCount,
    }));
}

function describeAdaptiveVolume(adaptive: AdaptiveGuidance): string {
  if (adaptive.volume.action === 'subir') {
    return `Sube alrededor de ${adaptive.volume.deltaKm} km esta semana, repartidos en rodajes suaves o en el final de la tirada larga.`;
  }

  if (adaptive.volume.action === 'bajar') {
    return `Recorta alrededor de ${adaptive.volume.deltaKm} km esta semana para absorber mejor la carga reciente.`;
  }

  return 'Mantén el volumen actual; no hay señal clara para abrir ni cerrar más carga.';
}

function describeAdaptivePace(adaptive: AdaptiveGuidance): string {
  if (adaptive.pace.action === 'acelerar') {
    return `Puedes tensar los ritmos de trabajo unos ${adaptive.pace.secondsPerKm}s/km si las piernas siguen respondiendo.`;
  }

  if (adaptive.pace.action === 'aflojar') {
    return `Conviene aflojar los ritmos de calidad unos ${adaptive.pace.secondsPerKm}s/km hasta que la recuperación vuelva a estabilizarse.`;
  }

  return 'Mantén los ritmos previstos; ahora mismo el plan no necesita más agresividad ni más freno.';
}

function describePrimaryNeed(adaptive: AdaptiveGuidance): string {
  const loadBalance = adaptive.signals.loadBalanceFeedback;

  if (loadBalance?.includes('AEROBIC_HIGH_SHORTAGE')) {
    return 'Te falta trabajo sostenido de calidad. Mejor más bloques controlados cerca del umbral que más series cortas.';
  }

  if (loadBalance?.includes('ANAEROBIC_HIGH_EXCESS')) {
    return 'Ahora mismo te sobra chispa y te falta continuidad. Conviene menos intensidad explosiva y más estabilidad aeróbica.';
  }

  if ((adaptive.signals.lastLongRunKm ?? 0) < 14) {
    return 'Tu prioridad sigue siendo consolidar la tirada larga útil, sin convertirla en una carrera.';
  }

  return adaptive.primaryNeed;
}

function formatExecutionDelta(seconds: number | null): string | null {
  if (seconds === null || seconds === 0) {
    return null;
  }

  if (seconds > 0) {
    return `${seconds}s/km más lento que lo previsto`;
  }

  return `${Math.abs(seconds)}s/km más rápido que lo previsto`;
}

function formatComplianceRate(rate: number | null): string {
  if (rate === null) {
    return 'Sin dato';
  }

  return `${Math.round(rate * 100)}%`;
}

function appendNote(base: string, extra: string | null): string {
  if (!extra) {
    return base;
  }

  return `${base} ${extra}`.trim();
}

function applyExecutionToWeeks(input: {
  weeks: TrainingWeek[];
  execution: PlanExecutionReview | null;
  today: Date;
  adaptive: AdaptiveGuidance;
  canSendWorkouts: boolean;
}): TrainingWeek[] {
  const todayIso = isoDate(input.today);
  const relocation = input.execution?.relocation ?? null;
  const matches = new Map<string, PlanExecutionReview['matches'][number]>(
    (input.execution?.matches ?? []).map((match) => [`${match.plannedDate}|${match.title}`, match] as const),
  );

  return input.weeks.map((week) => ({
    ...week,
    days: week.days.map((day) => {
      const key = `${day.date}|${day.title}`;
      const match = matches.get(key);
      let nextDay = { ...day };

      if (match) {
        if (match.status === 'done') {
          nextDay.status = 'done';
          nextDay.outcome = 'Completado según plan';
          nextDay.notes = appendNote(
            nextDay.notes,
            formatExecutionDelta(match.paceDeltaSeconds)
              ? `Resultado real: ${formatExecutionDelta(match.paceDeltaSeconds)}.`
              : 'Sesión completada en la fecha prevista.',
          );
        } else if (match.status === 'moved') {
          nextDay.status = 'moved';
          nextDay.outcome = `Hecho el ${match.actualDate}`;
          nextDay.notes = appendNote(
            nextDay.notes,
            `La sesión salió el ${match.actualDate}.${formatExecutionDelta(match.paceDeltaSeconds) ? ` Ritmo real ${formatExecutionDelta(match.paceDeltaSeconds)}.` : ''}`,
          );
        } else {
          nextDay.status = 'missed';
          nextDay.outcome = 'No realizado';
          nextDay.notes = appendNote(
            nextDay.notes,
            relocation?.fromDate === day.date && relocation.toDate
              ? `No salió este día. La reubico al ${relocation.toDate}.`
              : 'No salió según lo previsto. No intentes recuperar toda la carga de golpe.',
          );
        }
      }

      if (relocation?.toDate === day.date && day.date >= todayIso) {
        nextDay = {
          ...nextDay,
          title: relocation.title,
          intensity: input.adaptive.overall === 'protect' ? 'medio' : relocation.intensity,
          distanceKm: relocation.distanceKm ?? nextDay.distanceKm,
          status: 'adjusted',
          outcome: `Reubicada desde ${relocation.fromDate}`,
          notes: `Sesión clave reubicada desde ${relocation.fromDate}. ${relocation.notes}`,
        };
      }

      nextDay.canSendToGarmin = input.canSendWorkouts && nextDay.date >= todayIso && canSchedulePlanDay(nextDay);
      return nextDay;
    }),
  }));
}

function buildFitnessSummary(input: {
  provider: DashboardProviderMeta;
  goal: GoalMeta;
  predictedGoalSeconds: number | null;
  averageWeeklyKm: number | null;
  longestRunKm: number | null;
  adaptive: AdaptiveGuidance;
}): DashboardData['fitnessSummary'] {
  const title =
    input.adaptive.overall === 'protect'
      ? 'Carga alta, conviene proteger'
      : input.adaptive.overall === 'push'
        ? 'Bloque sólido, hay margen'
        : 'Estado estable y controlado';

  const raceReference =
    input.predictedGoalSeconds !== null
      ? `Ahora mismo el objetivo se mueve alrededor de ${formatSecondsAsRace(input.predictedGoalSeconds)} para ${input.goal.label}.`
      : `Todavía no hay una predicción sólida para ${input.goal.label}.`;
  const volumeReference =
    input.averageWeeklyKm !== null
      ? `Estás en ${round(input.averageWeeklyKm, 1)} km/sem con tirada larga reciente de ${round(input.longestRunKm ?? 0, 1)} km.`
      : 'Todavía falta volumen útil reciente para afinar mejor el plan.';
  const providerTail =
    input.provider.supportsWellness
      ? `Señal principal: ${describePrimaryNeed(input.adaptive)}`
      : 'Aquí mando sobre todo por consistencia, volumen real y ritmo ejecutado; no por sueño o HRV.';

  return {
    title,
    body: `${raceReference} ${volumeReference} ${providerTail}`,
  };
}

function buildAdvice(input: {
  provider: DashboardProviderMeta;
  goal: GoalMeta;
  predictedGoalSeconds: number | null;
  averageWeeklyKm: number | null;
  longestRunKm: number | null;
  readinessAvg: number | null;
  sleepAvgHours: number | null;
  trainingStatus: string | null;
  adaptive: AdaptiveGuidance;
}) : AdviceCard[] {
  const cards: AdviceCard[] = [];

  cards.push({
    title: 'Ajuste de esta semana',
    body: `${describeAdaptiveVolume(input.adaptive)} ${describeAdaptivePace(input.adaptive)}`,
    tone:
      input.adaptive.overall === 'protect'
        ? 'warning'
        : input.adaptive.overall === 'push'
          ? 'accent'
          : 'calm',
  });

  cards.push({
    title: 'Lo que más necesitas',
    body: describePrimaryNeed(input.adaptive),
    tone: 'accent',
  });

  if (!input.provider.supportsWellness) {
    cards.push({
      title: 'Límite actual de Strava',
      body: 'Con Strava puedo reaccionar a volumen, ritmo y consistencia, pero no a sueño, HRV ni readiness. Si quieres afinar más la recuperación, Garmin sigue aportando más señal.',
      tone: 'calm',
    });
  }

  if (input.adaptive.signals.missedKeySessionThisWeek && input.adaptive.signals.keySessionRelocatedTo) {
    cards.push({
      title: 'Sesión clave reubicada',
      body: `Has perdido la sesión principal de esta semana. La app la mueve al ${input.adaptive.signals.keySessionRelocatedTo}; no metas otra calidad extra además de esa.`,
      tone: 'warning',
    });
  }

  if ((input.adaptive.signals.complianceRate7d ?? 1) < 0.6) {
    cards.push({
      title: 'Cumplimiento primero',
      body: `Tu cumplimiento útil de los últimos 7 días va en ${formatComplianceRate(input.adaptive.signals.complianceRate7d)}. Conviene estabilizar horarios y sacar 3 sesiones buenas antes de endurecer el plan.`,
      tone: 'warning',
    });
  }

  if ((input.adaptive.signals.qualityPaceDeltaSeconds ?? 0) >= 12) {
    cards.push({
      title: 'La calidad va justa',
      body: `Tus sesiones rápidas recientes están saliendo ${formatExecutionDelta(input.adaptive.signals.qualityPaceDeltaSeconds)}. Baja un punto el objetivo esta semana y busca control, no épica.`,
      tone: 'warning',
    });
  } else if ((input.adaptive.signals.qualityPaceDeltaSeconds ?? 0) <= -10) {
    cards.push({
      title: 'La calidad responde',
      body: `La calidad te está saliendo ${formatExecutionDelta(input.adaptive.signals.qualityPaceDeltaSeconds)}. Puedes tensar un poco, pero solo si mantienes suaves de verdad los días fáciles.`,
      tone: 'calm',
    });
  }

  if ((input.adaptive.signals.easyPaceDeltaSeconds ?? 0) <= -15) {
    cards.push({
      title: 'Rodajes suaves demasiado vivos',
      body: `Tus rodajes fáciles van ${formatExecutionDelta(input.adaptive.signals.easyPaceDeltaSeconds)}. Ahí es donde más margen tienes para mejorar la recuperación sin perder forma.`,
      tone: 'warning',
    });
  }

  if (input.predictedGoalSeconds !== null) {
    const racePace = formatPace(input.predictedGoalSeconds / input.goal.distanceKm);
    cards.push({
      title: 'Ritmo objetivo',
      body: `Tu predicción actual apunta a ${formatSecondsAsRace(input.predictedGoalSeconds)} para ${input.goal.label}. Usa ${racePace} como referencia y evita salir por debajo de ese ritmo demasiado pronto.`,
      tone: 'accent',
    });
  }

  const longRunReference =
    input.goal.category === 'marathon' ? 24 : input.goal.category === 'half' ? 16 : input.goal.category === 'tenk' ? 12 : 8;

  if ((input.longestRunKm ?? 0) < longRunReference) {
    cards.push({
      title: 'Prioridad de fondo',
      body: `Tu tirada larga aún deja margen para este objetivo. Prioriza fines de semana con tiradas progresivas y controladas para llegar con más economía al tramo decisivo.`,
      tone: 'warning',
    });
  } else {
    cards.push({
      title: 'Base suficiente',
      body: 'La tirada larga reciente ya sostiene el objetivo. A partir de aquí compensa más afinar el ritmo objetivo y llegar fresco que seguir acumulando volumen.',
      tone: 'calm',
    });
  }

  if ((input.readinessAvg ?? 0) < 55 || (input.sleepAvgHours ?? 0) < 6.8) {
    cards.push({
      title: 'Recuperación bajo vigilancia',
      body: 'Tus métricas de recuperación piden disciplina: baja el volumen del día siguiente si enlazas dos noches malas y protege especialmente el sueño de jueves a domingo.',
      tone: 'warning',
    });
  } else if (input.adaptive.signals.lowSleepDays7d >= 2 || input.adaptive.signals.lowReadinessDays7d >= 2) {
    cards.push({
      title: 'Recuperación irregular',
      body: `Acumulas ${input.adaptive.signals.lowSleepDays7d} noches cortas y ${input.adaptive.signals.lowReadinessDays7d} días de readiness bajo en la última semana. Mejor asegurar descanso y no sumar intensidad oculta.`,
      tone: 'warning',
    });
  } else if ((input.adaptive.signals.hrvDelta ?? 0) <= -6) {
    cards.push({
      title: 'HRV a la baja',
      body: 'Tu HRV reciente está por debajo de su referencia de 14 días. Mantén la semana útil, pero baja ambición en la parte intensa si notas piernas opacas.',
      tone: 'warning',
    });
  } else {
    cards.push({
      title: 'Recuperación estable',
      body: `Las métricas de sueño y readiness acompañan. Puedes sostener un bloque específico hacia ${input.goal.label}, siempre que mantengas fáciles de verdad los rodajes suaves.`,
      tone: 'calm',
    });
  }

  const taperMessage =
    input.goal.daysToRace <= 40
      ? 'Ya estás dentro del tramo específico: la ganancia ahora viene de combinar calidad útil, sesiones a ritmo objetivo y un taper serio.'
      : 'Todavía hay margen para construir, pero sin abrir frentes nuevos.';

  cards.push({
    title: 'Gestión del taper',
    body: `${taperMessage} ${input.trainingStatus ? `Si ${input.provider.label} marca ${input.trainingStatus}, usa esa señal para priorizar frescura sobre volumen residual.` : `Aquí manda sobre todo la combinación entre sensaciones, ritmo real y continuidad.`}`,
    tone: 'accent',
  });

  if ((input.averageWeeklyKm ?? 0) < 30 && input.goal.distanceKm >= 10) {
    cards.push({
      title: 'Nutrición de carrera',
      body: 'Con un volumen semanal moderado, conviene ensayar la nutrición en las tiradas largas: desayuno de carrera, 30-40 g de carbohidrato/h y agua desde el km 5.',
      tone: 'warning',
    });
  }

  return cards.slice(0, 6);
}

function paceBandLabel(minSeconds: number | null, maxSeconds: number | null): string | null {
  if (minSeconds === null || maxSeconds === null) {
    return null;
  }

  const minLabel = formatPace(minSeconds);
  const maxLabel = formatPace(maxSeconds);

  if (!minLabel || !maxLabel) {
    return null;
  }

  return `${minLabel} - ${maxLabel}`;
}

function roundHalfKm(value: number): number {
  return Math.max(0, Math.round(value * 2) / 2);
}

function shiftPaceSeconds(secondsPerKm: number | null, deltaSeconds: number): number | null {
  if (secondsPerKm === null) {
    return null;
  }

  return Math.max(240, Math.round(secondsPerKm + deltaSeconds));
}

function buildTrainingPlan(input: {
  today: Date;
  raceDate: Date;
  goal: GoalMeta;
  predictedGoalSeconds: number | null;
  averageWeeklyKm: number | null;
  longestRunKm: number | null;
  recentRuns: RunSummary[];
  adaptive: AdaptiveGuidance;
  execution: PlanExecutionReview | null;
  canSendWorkouts: boolean;
}) {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const volumeDelta =
    input.adaptive.volume.action === 'subir'
      ? input.adaptive.volume.deltaKm
      : input.adaptive.volume.action === 'bajar'
        ? -input.adaptive.volume.deltaKm
        : 0;
  const paceDelta =
    input.adaptive.pace.action === 'acelerar'
      ? -input.adaptive.pace.secondsPerKm
      : input.adaptive.pace.action === 'aflojar'
        ? input.adaptive.pace.secondsPerKm
        : 0;

  const volumeFloor = input.goal.category === 'marathon' ? 34 : input.goal.category === 'half' ? 22 : 16;
  const volumeCeiling = input.goal.category === 'marathon' ? 90 : input.goal.category === 'half' ? 72 : 56;
  const goalVolumeHint =
    input.goal.category === 'marathon'
      ? input.goal.distanceKm * 1.15
      : input.goal.category === 'half'
        ? input.goal.distanceKm * 1.7
        : input.goal.category === 'tenk'
          ? input.goal.distanceKm * 3.5
          : input.goal.distanceKm * 3.2;

  const averageWeeklyKm = Math.max(volumeFloor, (input.averageWeeklyKm ?? goalVolumeHint) + volumeDelta);
  const longestRunKm = input.longestRunKm ?? (input.goal.category === 'marathon' ? 18 : input.goal.category === 'half' ? 12 : 8);
  const level: DashboardData['plan']['level'] =
    averageWeeklyKm >= 48 ? 'ambicioso' : averageWeeklyKm >= 30 ? 'equilibrado' : 'conservador';
  const peakVolume = clamp(Math.max(averageWeeklyKm, goalVolumeHint), volumeFloor, volumeCeiling);
  const longRunConfig =
    input.goal.category === 'marathon'
      ? { min: 16, peakMultiplier: 0.62, cap: 28, taperDrop: 5 }
      : input.goal.category === 'half'
        ? { min: 10, peakMultiplier: 0.8, cap: 18, taperDrop: 3 }
        : input.goal.category === 'tenk'
          ? { min: 8, peakMultiplier: 1.25, cap: 14, taperDrop: 2 }
          : { min: 6, peakMultiplier: 1.15, cap: 10, taperDrop: 1.5 };
  const peakLongRun = roundHalfKm(
    clamp(
      Math.max(
        Math.min((longestRunKm || longRunConfig.min) + 2, longRunConfig.cap),
        input.goal.distanceKm * longRunConfig.peakMultiplier,
      ),
      longRunConfig.min,
      longRunConfig.cap,
    ),
  );
  const buildWeeksBeforeTaper = Math.max(1, input.goal.totalWeeks - 2);
  const currentLongRun = roundHalfKm(
    clamp(longestRunKm || longRunConfig.min, longRunConfig.min, peakLongRun),
  );
  const startLongRun = buildWeeksBeforeTaper <= 1
    ? peakLongRun
    : roundHalfKm(
        clamp(
          Math.min(currentLongRun, peakLongRun - 0.5 * (buildWeeksBeforeTaper - 1)),
          longRunConfig.min,
          peakLongRun,
        ),
      );
  const buildLongRunStep =
    buildWeeksBeforeTaper <= 1 ? 0 : (peakLongRun - startLongRun) / (buildWeeksBeforeTaper - 1);
  const progressiveLongRunForWeek = (buildWeekIndex: number) =>
    roundHalfKm(
      clamp(
        startLongRun + buildLongRunStep * buildWeekIndex,
        longRunConfig.min,
        peakLongRun,
      ),
    );
  const racePace = input.predictedGoalSeconds ? input.predictedGoalSeconds / input.goal.distanceKm : null;
  const adjustedRacePace = shiftPaceSeconds(racePace, paceDelta);
  const paces = {
    easy: paceBandLabel(
      adjustedRacePace ? adjustedRacePace + 55 : null,
      adjustedRacePace ? adjustedRacePace + 85 : null,
    ),
    steady: formatPace(adjustedRacePace ? adjustedRacePace + 25 : null),
    tempo: paceBandLabel(
      adjustedRacePace ? adjustedRacePace - 5 : null,
      adjustedRacePace ? adjustedRacePace + 8 : null,
    ),
    race: formatPace(adjustedRacePace),
  };
  const tuesdayTitlesByCategory: Record<GoalCategory, string[]> = {
    speed: ['VO2 controlado', 'Cambios de ritmo', 'Series largas', 'Ritmo controlado', 'Afinado corto', 'Activación'],
    tenk: ['Series largas', 'Umbral en bloques', 'Ritmo controlado', 'Series de afinado', 'Ritmo objetivo', 'Activación'],
    half: ['Series largas', 'Umbral en bloques', 'Ritmo controlado', 'Series de afinado', 'Ritmo objetivo', 'Activación'],
    marathon: ['Umbral sostenido', 'Control de maratón', 'Series largas', 'Ritmo controlado', 'Ritmo objetivo', 'Activación'],
  };
  const fridayTitlesByCategory: Record<GoalCategory, string[]> = {
    speed: ['Tempo corto', 'Ritmo objetivo', 'Rodaje controlado', 'Toque fino', 'Descarga', 'Descarga'],
    tenk: ['Ritmo objetivo', 'Tempo progresivo', 'Rodaje controlado', 'Tempo corto', 'Toque fino', 'Descarga'],
    half: ['Ritmo objetivo', 'Tempo progresivo', 'Rodaje controlado', 'Tempo corto', 'Toque fino', 'Descarga'],
    marathon: ['Bloque objetivo', 'Rodaje controlado', 'Tempo progresivo', 'Bloque objetivo', 'Toque fino', 'Descarga'],
  };

  const focusForWeek = (weekIndex: number, fromEnd: number) => {
    if (fromEnd === 0) {
      return `Semana de ${input.goal.raceTitle.toLowerCase()}: llegar fresco y sin ruido.`;
    }
    if (fromEnd === 1) {
      return `Afinar ${input.goal.label} sin acumular fatiga.`;
    }
    if (fromEnd === 2) {
      return 'Bajar volumen manteniendo chispa y control.';
    }
    if (weekIndex <= 1) {
      return 'Construir base específica y ordenar bien la semana.';
    }
    return input.goal.category === 'marathon'
      ? 'Consolidar fondo útil y bloques sostenidos a ritmo objetivo.'
      : 'Consolidar calidad útil, ritmo objetivo y tirada larga controlada.';
  };

  const describeTuesday = (weekIndex: number, raceWeek: boolean, qualityGuardrail: string) => {
    if (raceWeek) {
      return '25-35 min suaves + 5 rectas de 20". Nada de fatiga residual.';
    }

    if (input.goal.category === 'speed') {
      return (
        [
          `Calentamiento + 8x400 m vivos con 200 m trote.${qualityGuardrail}`,
          `6x3' a ${paces.tempo ?? 'ritmo de umbral alto'} con 2' suaves.${qualityGuardrail}`,
          `5x800 m a ritmo controlado.${qualityGuardrail}`,
          `3x1 km a ${paces.race ?? 'ritmo objetivo'} con recuperación completa.${qualityGuardrail}`,
          `6x1' ágiles con mucha soltura.${qualityGuardrail}`,
        ][Math.min(weekIndex, 4)] ?? `Trabajo de calidad controlado.${qualityGuardrail}`
      );
    }

    if (input.goal.category === 'tenk') {
      return (
        [
          `Calentamiento + 5x1 km a ${paces.tempo ?? 'ritmo vivo controlado'} con 90" suaves.${qualityGuardrail}`,
          `3x2 km a ${paces.tempo ?? 'umbral controlado'} con 2' suaves.${qualityGuardrail}`,
          `2x3 km a ${paces.steady ?? 'ritmo sostenido'} con 3' suaves.${qualityGuardrail}`,
          `6x800 m vivos con recuperación completa.${qualityGuardrail}`,
          `4x1 km a ritmo objetivo con mucha soltura.${qualityGuardrail}`,
        ][Math.min(weekIndex, 4)] ?? `Trabajo de calidad controlado.${qualityGuardrail}`
      );
    }

    if (input.goal.category === 'marathon') {
      return (
        [
          `3x3 km a ${paces.tempo ?? 'umbral controlado'} con 3' suaves.${qualityGuardrail}`,
          `2x5 km cerca de ${paces.steady ?? 'ritmo sostenido'} con pausa corta.${qualityGuardrail}`,
          `4x2 km estables con control cardíaco.${qualityGuardrail}`,
          `3x10' a ${paces.tempo ?? 'tempo controlado'} con 2' suaves.${qualityGuardrail}`,
          `2x4 km a ritmo objetivo con mucha soltura.${qualityGuardrail}`,
        ][Math.min(weekIndex, 4)] ?? `Trabajo de calidad controlado.${qualityGuardrail}`
      );
    }

    return (
      [
        `Calentamiento + 5x1 km a ${paces.tempo ?? 'ritmo vivo controlado'} con 90" suaves.${qualityGuardrail}`,
        `3x2 km a ${paces.tempo ?? 'umbral controlado'} con 2' suaves.${qualityGuardrail}`,
        `2x4 km a ${paces.steady ?? 'ritmo sostenido'} con 3' suaves.${qualityGuardrail}`,
        `6x800 m vivos con recuperación completa.${qualityGuardrail}`,
        `4x1 km a ritmo objetivo con mucha soltura.${qualityGuardrail}`,
      ][Math.min(weekIndex, 4)] ?? `Trabajo de calidad controlado.${qualityGuardrail}`
    );
  };

  const describeFriday = (
    weekIndex: number,
    raceWeek: boolean,
    preRaceWeek: boolean,
    qualityGuardrail: string,
  ) => {
    if (raceWeek) {
      return '30 min muy suaves. Si te notas pesado, convierte el día en descanso total.';
    }
    if (preRaceWeek) {
      return `8-10 km con un bloque a ${paces.race ?? 'ritmo objetivo'} y buenas sensaciones.${qualityGuardrail}`;
    }
    if (input.goal.category === 'marathon') {
      return (
        [
          `Rodaje con 6-8 km a ${paces.race ?? 'ritmo objetivo'} sin vaciarte.${qualityGuardrail}`,
          `Rodaje controlado terminando cerca de ${paces.race ?? 'ritmo objetivo'} sin forzar.${qualityGuardrail}`,
          `15' steady + 10' tempo.${qualityGuardrail}`,
          `2 bloques largos a ${paces.race ?? 'ritmo objetivo'} con mucha soltura.${qualityGuardrail}`,
          `Rodaje breve + rectas para afinar.${qualityGuardrail}`,
        ][Math.min(weekIndex, 4)] ?? `Rodaje controlado.${qualityGuardrail}`
      );
    }

    return (
      [
        `Bloque principal a ${paces.race ?? 'ritmo objetivo'}. ${qualityGuardrail}`.trim(),
        `15' steady + 10' tempo. ${qualityGuardrail}`.trim(),
        `Rodaje controlado terminando cerca de ${paces.race ?? 'ritmo objetivo'} sin forzar.${qualityGuardrail}`,
        `10' tempo corto con soltura.${qualityGuardrail}`,
        `Rodaje breve + rectas para afinar.${qualityGuardrail}`,
      ][Math.min(weekIndex, 4)] ??
      `Rodaje controlado cerca de ${paces.race ?? 'ritmo objetivo'}.`
    );
  };

  const weeks: TrainingWeek[] = [];
  const planStart = startOfWeek(input.today, { weekStartsOn: 1 });
  const todayIso = isoDate(input.today);

  for (let weekIndex = 0; weekIndex < input.goal.totalWeeks; weekIndex += 1) {
    const weekStart = weekIndex === 0 ? planStart : startOfWeek(subDays(endOfWeek(planStart, { weekStartsOn: 1 }), -7 * weekIndex), { weekStartsOn: 1 });
    const monday = subDays(weekStart, 0);
    const dates = Array.from({ length: 7 }, (_, offset) => subDays(monday, -offset));
    const weeksFromEnd = input.goal.totalWeeks - weekIndex - 1;
    const raceWeek = dates.some((date) => isoDate(date) === input.goal.raceDate);
    const preRaceWeek = !raceWeek && weeksFromEnd === 1;
    const taperWeek = !raceWeek && weeksFromEnd === 2;
    const buildWeekIndex = Math.min(weekIndex, buildWeeksBeforeTaper - 1);
    const progressiveLongRunKm = progressiveLongRunForWeek(buildWeekIndex);
    const progressionFactor =
      raceWeek
        ? input.goal.category === 'marathon'
          ? 0.46
          : 0.38
        : preRaceWeek
          ? 0.64
          : taperWeek
            ? 0.78
            : clamp(0.88 + Math.min(0.14, weekIndex * 0.03), 0.88, 1.02);
    const targetKm = roundHalfKm(peakVolume * progressionFactor);
    const longRunKm = raceWeek
      ? null
      : preRaceWeek
        ? roundHalfKm(
            clamp(
              progressiveLongRunForWeek(Math.max(0, buildWeeksBeforeTaper - 1)) - longRunConfig.taperDrop,
              longRunConfig.min,
              peakLongRun,
            ),
          )
        : progressiveLongRunKm;
    const qualityKm = targetKm ? roundHalfKm(targetKm * (input.goal.category === 'marathon' ? 0.15 : 0.2)) : null;
    const easyKm = targetKm ? roundHalfKm(targetKm * (level === 'conservador' ? 0.16 : 0.18)) : null;
    const recoveryKm = targetKm ? roundHalfKm(targetKm * (level === 'conservador' ? 0.1 : 0.12)) : null;
    const days: TrainingDay[] = dates.map((date, weekdayIndex) => {
      const iso = isoDate(date);
      const weekday = format(date, 'EEEE');
      const lowerWeekday = weekday.toLowerCase();
      const qualityGuardrail =
        input.adaptive.overall === 'protect'
          ? ' Si sigues cargado o has dormido mal, recorta una repetición o 10-15 min.'
          : input.adaptive.overall === 'push'
            ? ' Si sales muy entero y la FC va estable, puedes añadir 1 km suave al final.'
            : '';
      const recoveryGuardrail =
        input.adaptive.recovery.action === 'proteger'
          ? ' Prioriza soltar piernas y no conviertas este día en trabajo oculto.'
          : input.adaptive.recovery.action === 'apretar'
            ? ' Si te notas muy bien, mete 4-6 rectas de calidad sin fatiga.'
            : '';

      const finalizeDay = (day: Omit<TrainingDay, 'canSendToGarmin'>): TrainingDay => ({
        ...day,
        status: day.status ?? 'planned',
        outcome: day.outcome ?? null,
        canSendToGarmin: day.date >= todayIso && canSchedulePlanDay(day),
      });

      if (iso === input.goal.raceDate) {
        return finalizeDay({
          date: iso,
          weekday: lowerWeekday,
          title: input.goal.raceTitle,
          intent: 'competición',
          intensity: 'carrera',
          distanceKm: input.goal.distanceKm,
          notes: `Salida muy controlada, especialmente al principio. Ritmo objetivo ${paces.race ?? 'por sensaciones fuertes y estables'} y plan de hidratación/nutrición ensayado.`,
          status: 'planned',
          outcome: null,
        });
      }

      switch (weekdayIndex) {
        case 0:
          return finalizeDay({
            date: iso,
            weekday: lowerWeekday,
            title: 'Descanso + movilidad',
            intent: 'recuperar',
            intensity: 'descanso',
            distanceKm: null,
            notes: '20-30 min de movilidad, tobillo y glúteo medio. Si vienes cargado, paseo suave.',
            status: 'planned',
            outcome: null,
          });
        case 1:
          return finalizeDay({
            date: iso,
            weekday: lowerWeekday,
            title: tuesdayTitlesByCategory[input.goal.category][Math.min(weekIndex, 5)] ?? 'Calidad',
            intent: 'trabajo principal',
            intensity: 'alto',
            distanceKm: qualityKm,
            notes: describeTuesday(weekIndex, raceWeek, qualityGuardrail),
            status: 'planned',
            outcome: null,
          });
        case 2:
          return finalizeDay({
            date: iso,
            weekday: lowerWeekday,
            title: 'Rodaje suave',
            intent: 'aeróbico',
            intensity: 'suave',
            distanceKm: easyKm,
            notes: `Mantén el rodaje realmente fácil, idealmente en ${paces.easy ?? 'zona cómoda conversacional'}.${recoveryGuardrail}`,
            status: 'planned',
            outcome: null,
          });
        case 3:
          return finalizeDay({
            date: iso,
            weekday: lowerWeekday,
            title: level === 'conservador' ? 'Fuerza y core' : 'Recuperación activa',
            intent: 'descargar',
            intensity: 'recuperacion',
            distanceKm: level === 'conservador' ? null : recoveryKm,
            notes: level === 'conservador'
              ? '30-40 min de fuerza básica: gemelo, isquio, glúteo, core. Sin carga máxima.'
              : `Rodaje muy suave o bici soltando piernas; termina con 6 rectas cortas.${recoveryGuardrail}`,
            status: 'planned',
            outcome: null,
          });
        case 4:
          return finalizeDay({
            date: iso,
            weekday: lowerWeekday,
            title: fridayTitlesByCategory[input.goal.category][Math.min(weekIndex, 5)] ?? 'Control',
            intent: 'economía de carrera',
            intensity: preRaceWeek || raceWeek || input.adaptive.overall === 'protect' ? 'medio' : 'alto',
            distanceKm: preRaceWeek ? roundHalfKm((targetKm ?? 0) * 0.14) : qualityKm,
            notes: describeFriday(weekIndex, raceWeek, preRaceWeek, qualityGuardrail),
            status: 'planned',
            outcome: null,
          });
        case 5:
          return finalizeDay({
            date: iso,
            weekday: lowerWeekday,
            title: 'Suave + técnica',
            intent: 'soltura',
            intensity: 'suave',
            distanceKm: raceWeek ? 4 : recoveryKm,
            notes: raceWeek
              ? '20-25 min muy suaves o descanso si notas fatiga.'
              : `Rodaje corto y fácil. Añade 4-6 rectas progresivas si estás fino.${recoveryGuardrail}`,
            status: 'planned',
            outcome: null,
          });
        default:
          return finalizeDay({
            date: iso,
            weekday: lowerWeekday,
            title: raceWeek ? 'Descanso total' : 'Tirada larga',
            intent: raceWeek ? 'guardar piernas' : 'resistencia específica',
            intensity: raceWeek ? 'descanso' : 'medio',
            distanceKm: raceWeek ? null : longRunKm,
            notes: raceWeek
              ? 'Descanso, hidratación y preparación del material.'
              : `Tirada larga fácil y controlada. Últimos 15-20 min algo más alegres solo si llegas con buenas piernas; combustible ensayado.${qualityGuardrail}`,
            status: 'planned',
            outcome: null,
          });
      }
    });

    weeks.push({
      title: raceWeek
        ? `Semana de carrera`
        : `Semana ${weekIndex + 1}`,
      focus: focusForWeek(weekIndex, weeksFromEnd),
      targetKm,
      days,
    });
  }

  const recentDistance = round(
    input.recentRuns
      .slice(0, 4)
      .reduce((sum, run) => sum + run.distanceKm, 0),
    1,
  );
  const complianceSentence =
    (input.execution?.complianceRate7d ?? null) !== null
      ? ` Cumplimiento útil reciente: ${formatComplianceRate(input.execution?.complianceRate7d ?? null)}.`
      : '';
  const relocationSentence = input.execution?.relocation?.toDate
    ? ` La sesión clave perdida se recoloca al ${input.execution.relocation.toDate}.`
    : '';

  const summary = `Vas con un nivel ${level}, promediando ${round(averageWeeklyKm, 1)} km/sem y con tirada larga reciente de ${round(longestRunKm, 1)} km.${complianceSentence}${relocationSentence} Ajuste actual: ${describeAdaptiveVolume(input.adaptive)} ${describeAdaptivePace(input.adaptive)} Tus últimos 4 entrenamientos suman ${recentDistance} km, así que el foco está en llegar al ${input.goal.raceDate} listo para ${input.goal.label}, con calidad utilizable, taper progresivo y piernas frescas.`;

  return {
    summary,
    level,
    paces,
    weeks: applyExecutionToWeeks({
      weeks,
      execution: input.execution,
      today: input.today,
      adaptive: input.adaptive,
      canSendWorkouts: input.canSendWorkouts,
    }),
  };
}

const garminProviderMeta: DashboardProviderMeta = {
  key: 'garmin',
  label: 'Garmin',
  supportsWorkoutPush: true,
  supportsWellness: true,
};

const stravaProviderMeta: DashboardProviderMeta = {
  key: 'strava',
  label: 'Strava',
  supportsWorkoutPush: false,
  supportsWellness: false,
};

function buildDashboardFromSource(input: {
  provider: DashboardProviderMeta;
  goal: UserGoal;
  today: Date;
  athleteName: string;
  location: string | null;
  primaryDevice: string | null;
  avatarPath: string | null;
  runningActivities: RunSummary[];
  wellnessTrend: DashboardData['wellnessTrend'];
  vo2Trend: DashboardData['vo2Trend'];
  overviewSeed: Omit<DashboardData['overview'], 'averageWeeklyKm' | 'longestRunKm' | 'predictedGoalSeconds'> & {
    predictedGoalSeconds: number | null;
  };
  acuteChronicRatio: number | null;
  loadBalanceFeedback: string | null;
}) : DashboardData {
  const goalMeta = buildGoalMeta(input.goal, input.today);
  const raceDate = parseISO(goalMeta.raceDate);
  const weeklyRunning = groupWeeklyRunning(input.runningActivities);
  const recentRuns = [...input.runningActivities]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 8);
  const averageWeeklyKm = average(weeklyRunning.map((entry) => entry.distanceKm));
  const longestRunKm = input.runningActivities.reduce((max, run) => Math.max(max, run.distanceKm), 0) || null;
  const predictedGoalSeconds =
    input.overviewSeed.predictedGoalSeconds ?? estimateGoalPredictionFromRuns(input.runningActivities, goalMeta.distanceKm, input.today);
  const readinessAvg = average(
    input.wellnessTrend.map((entry) => entry.readiness).filter((value): value is number => value !== null),
  );
  const sleepAvgHours = average(
    input.wellnessTrend.map((entry) => entry.sleepHours).filter((value): value is number => value !== null),
  );
  const recentWindowStart = isoDate(subDays(input.today, 7));
  const lowSleepDays7d = input.wellnessTrend.filter(
    (entry) => entry.date >= recentWindowStart && (entry.sleepHours ?? 10) < 6.5,
  ).length;
  const lowReadinessDays7d = input.wellnessTrend.filter(
    (entry) => entry.date >= recentWindowStart && (entry.readiness ?? 100) < 60,
  ).length;
  const validHrv = input.wellnessTrend
    .map((entry) => entry.hrv)
    .filter((value): value is number => value !== null);
  const hrvDelta =
    validHrv.length >= 6
      ? round(
          average(validHrv.slice(-3))! - average(validHrv.slice(0, Math.max(1, validHrv.length - 3)))!,
          1,
        )
      : null;

  const overview = {
    ...input.overviewSeed,
    averageWeeklyKm: averageWeeklyKm ? round(averageWeeklyKm, 1) : null,
    longestRunKm: longestRunKm ? round(longestRunKm, 1) : null,
    predictedGoalSeconds,
  };

  const baselineAdaptive = analyzeAdaptiveGuidance({
    today: input.today,
    raceDate,
    goalDistanceKm: goalMeta.distanceKm,
    recentRuns: input.runningActivities,
    averageWeeklyKm: overview.averageWeeklyKm,
    readinessAvg,
    sleepAvgHours,
    acuteChronicRatio: input.acuteChronicRatio,
    loadBalanceFeedback: input.loadBalanceFeedback,
    predictedGoalSeconds,
    execution: createEmptyPlanExecutionReview(),
    lowSleepDays7d,
    lowReadinessDays7d,
    hrvDelta,
  });
  const draftPlan = buildTrainingPlan({
    today: input.today,
    raceDate,
    goal: goalMeta,
    predictedGoalSeconds,
    averageWeeklyKm: overview.averageWeeklyKm,
    longestRunKm: overview.longestRunKm,
    recentRuns,
    adaptive: baselineAdaptive,
    execution: null,
    canSendWorkouts: input.provider.supportsWorkoutPush,
  });
  const execution = analyzePlanExecution({
    today: input.today,
    recentRuns: input.runningActivities,
    weeks: draftPlan.weeks,
    paces: draftPlan.paces,
  });
  const adaptive = analyzeAdaptiveGuidance({
    today: input.today,
    raceDate,
    goalDistanceKm: goalMeta.distanceKm,
    recentRuns: input.runningActivities,
    averageWeeklyKm: overview.averageWeeklyKm,
    readinessAvg,
    sleepAvgHours,
    acuteChronicRatio: input.acuteChronicRatio,
    loadBalanceFeedback: input.loadBalanceFeedback,
    predictedGoalSeconds,
    execution,
    lowSleepDays7d,
    lowReadinessDays7d,
    hrvDelta,
  });

  const advice = buildAdvice({
    provider: input.provider,
    goal: goalMeta,
    predictedGoalSeconds,
    averageWeeklyKm: overview.averageWeeklyKm,
    longestRunKm: overview.longestRunKm,
    readinessAvg,
    sleepAvgHours,
    trainingStatus: overview.trainingStatus,
    adaptive,
  });
  const fitnessSummary = buildFitnessSummary({
    provider: input.provider,
    goal: goalMeta,
    predictedGoalSeconds,
    averageWeeklyKm: overview.averageWeeklyKm,
    longestRunKm: overview.longestRunKm,
    adaptive,
  });

  const plan = buildTrainingPlan({
    today: input.today,
    raceDate,
    goal: goalMeta,
    predictedGoalSeconds,
    averageWeeklyKm: overview.averageWeeklyKm,
    longestRunKm: overview.longestRunKm,
    recentRuns,
    adaptive,
    execution,
    canSendWorkouts: input.provider.supportsWorkoutPush,
  });

  return {
    provider: input.provider,
    athlete: {
      name: input.athleteName,
      location: input.location,
      primaryDevice: input.primaryDevice,
      avatarPath: input.avatarPath,
      raceDate: goalMeta.raceDate,
      daysToRace: goalMeta.daysToRace,
    },
    goal: goalMeta,
    overview,
    wellnessTrend: input.wellnessTrend,
    weeklyRunning,
    vo2Trend: input.vo2Trend,
    recentRuns,
    fitnessSummary,
    adaptive,
    advice,
    checkIn: {
      needsToday: true,
      latest: null,
      recent: [],
    },
    coach: {
      enabled: false,
      source: 'fallback',
      model: null,
      generatedAt: null,
      todayMessage: null,
    },
    plan,
    fetchedAt: new Date().toISOString(),
  };
}

async function buildGarminDashboardData(input: {
  auth: GarminSessionAuth;
  goal: UserGoal;
}): Promise<DashboardData> {
  const today = startOfToday();
  const goalMeta = buildGoalMeta(input.goal, today);
  const referenceDate = pickReferenceDate(today);
  const wellnessStart = isoDate(subDays(today, 13));
  const runningStart = isoDate(subWeeks(today, 6));
  const runningEnd = isoDate(today);
  const weightStart = isoDate(subWeeks(today, 4));

  const userProfile = await garminClient.callJson(input.auth, 'get_user_profile');
  const socialProfile = await garminClient.callJson(input.auth, 'get_social_profile').catch(() => null);
  const devices = await garminClient.callJson(input.auth, 'get_devices');
  const dailySummary = await garminClient.callJson(input.auth, 'get_daily_summary', { date: referenceDate });
  const sleepRange = await garminClient.callJson(input.auth, 'get_sleep_data_range', {
    startDate: wellnessStart,
    endDate: referenceDate,
  });
  const hrvRange = await garminClient.callJson(input.auth, 'get_hrv_range', {
    startDate: wellnessStart,
    endDate: referenceDate,
  });
  const readinessRange = await garminClient.callJson(input.auth, 'get_training_readiness_range', {
    startDate: wellnessStart,
    endDate: referenceDate,
  });
  const stepsRange = await garminClient.callJson(input.auth, 'get_daily_steps_range', {
    startDate: wellnessStart,
    endDate: referenceDate,
  });
  const vo2Range = await garminClient.callJson(input.auth, 'get_vo2max_range', {
    startDate: runningStart,
    endDate: referenceDate,
  });
  const trainingStatusRaw = await garminClient.callJson(input.auth, 'get_training_status', { date: referenceDate });
  const racePredictionsRaw = await garminClient.callJson(input.auth, 'get_race_predictions');
  const runningActivitiesRaw = await garminClient.callJson(input.auth, 'get_activities_by_date', {
    startDate: runningStart,
    endDate: runningEnd,
    activityType: 'running',
  });
  const bodyCompositionRaw = await garminClient.callJson(input.auth, 'get_body_composition', {
    startDate: weightStart,
    endDate: referenceDate,
  });

  const runningActivities = Array.isArray(runningActivitiesRaw)
    ? runningActivitiesRaw.map(normalizeRun).filter((run): run is RunSummary => run !== null)
    : [];
  const sleepSeries = normalizeRangeSeries(sleepRange, extractSleepHours);
  const hrvSeries = normalizeRangeSeries(hrvRange, extractHrv);
  const readinessSeries = normalizeRangeSeries(readinessRange, extractReadiness);
  const stepsSeries = normalizeSteps(stepsRange);
  const vo2Series = normalizeRangeSeries(vo2Range, extractVo2);
  const wellnessTrend = mergeWellnessSeries({
    steps: stepsSeries,
    sleep: sleepSeries,
    hrv: hrvSeries,
    readiness: readinessSeries,
  });
  const racePredictions = extractRacePredictions(racePredictionsRaw);
  const trainingStatus = extractTrainingStatus(trainingStatusRaw);
  const deviceList = Array.isArray(devices) ? devices : [];
  const athleteName =
    pickString(socialProfile, ['fullName', 'displayName', 'userName']) ??
    pickString(userProfile, ['fullName', 'displayName', 'userName']) ??
    input.auth.garminEmail.split('@')[0] ??
    'Tu perfil Garmin';
  const locationParts = [
    pickString(socialProfile, ['location']) ?? pickString(userProfile, ['location'], ['location']),
    pickString(socialProfile, ['city']) ?? pickString(userProfile, ['city'], ['city']),
    pickString(socialProfile, ['countryCode']) ?? pickString(userProfile, ['countryCode'], ['country']),
  ].filter((item): item is string => Boolean(item));
  const primaryDevice = pickString(
    deviceList[0],
    ['displayName', 'deviceName', 'partNumber'],
    ['display', 'device', 'name'],
  );
  const avatarUrl = pickString(
    socialProfile,
    ['profileImageUrlLarge', 'profileImageUrlMedium', 'profileImageUrlSmall', 'profileImageUrl'],
  );

  return buildDashboardFromSource({
    provider: garminProviderMeta,
    goal: input.goal,
    today,
    athleteName,
    location: locationParts.length ? locationParts.join(' · ') : null,
    primaryDevice,
    avatarPath: avatarUrl ? '/api/athlete/avatar' : null,
    runningActivities,
    wellnessTrend,
    vo2Trend: vo2Series.map((entry) => ({
      date: entry.date,
      label: format(parseISO(entry.date), 'dd/MM'),
      value: entry.value,
    })),
    overviewSeed: {
      steps: pickNumber(dailySummary, ['totalSteps', 'steps'], ['steps']),
      activeCalories: pickNumber(dailySummary, ['activeKilocalories', 'activeCalories'], ['calories']),
      distanceKm: normalizeDistanceKm(
        getPath(dailySummary, 'wellnessDistanceMeters') ??
          getPath(dailySummary, 'totalDistanceMeters') ??
          pickNumber(dailySummary, ['distance'], ['distance']),
      ),
      sleepHours: sleepSeries.at(-1)?.value ?? null,
      sleepScore: extractSleepScore(Array.isArray(sleepRange) ? sleepRange.at(-1) : sleepRange),
      hrv: hrvSeries.at(-1)?.value ?? null,
      readiness: readinessSeries.at(-1)?.value ?? null,
      vo2Max: vo2Series.filter((entry) => entry.value !== null).at(-1)?.value ?? null,
      trainingStatus,
      weightKg: extractLatestWeight(bodyCompositionRaw),
      predictedGoalSeconds: estimateGoalPrediction(racePredictions, goalMeta.distanceKm),
    },
    acuteChronicRatio: extractAcuteChronicRatio(trainingStatusRaw),
    loadBalanceFeedback: extractLoadBalanceFeedback(trainingStatusRaw),
  });
}

async function buildStravaDashboardData(input: {
  auth: StravaSessionRecord;
  goal: UserGoal;
}): Promise<DashboardData> {
  const today = startOfToday();
  const referenceDate = pickReferenceDate(today);
  const runningStart = isoDate(subWeeks(today, 12));

  const athlete = await getStravaAthlete(input.auth);
  const stats = await getStravaAthleteStats(input.auth).catch(() => null);
  const activities = await listStravaActivities(input.auth, { after: runningStart });
  const runningActivities = activities
    .map(normalizeStravaRun)
    .filter((run): run is RunSummary => run !== null);
  const athleteName = [
    pickString(athlete, ['firstname'], ['firstname']),
    pickString(athlete, ['lastname'], ['lastname']),
  ]
    .filter((item): item is string => Boolean(item))
    .join(' ')
    || pickString(athlete, ['username'], ['username'])
    || input.auth.athleteName;
  const locationParts = [
    pickString(athlete, ['city'], ['city']),
    pickString(athlete, ['state'], ['state']),
    pickString(athlete, ['country'], ['country']),
  ].filter((item): item is string => Boolean(item));
  const todayDistanceKm = round(
    runningActivities
      .filter((run) => run.date === referenceDate)
      .reduce((sum, run) => sum + run.distanceKm, 0),
    1,
  );
  const recentRunTotalsDistance = normalizeDistanceKm(getPath(stats, 'recent_run_totals.distance'));

  return buildDashboardFromSource({
    provider: stravaProviderMeta,
    goal: input.goal,
    today,
    athleteName: athleteName || `Strava ${input.auth.athleteId}`,
    location: locationParts.length ? locationParts.join(' · ') : null,
    primaryDevice: null,
    avatarPath: pickString(athlete, ['profile_medium', 'profile'], ['profile']) ? '/api/athlete/avatar' : null,
    runningActivities,
    wellnessTrend: [],
    vo2Trend: [],
    overviewSeed: {
      steps: null,
      activeCalories: null,
      distanceKm: todayDistanceKm || recentRunTotalsDistance || null,
      sleepHours: null,
      sleepScore: null,
      hrv: null,
      readiness: null,
      vo2Max: null,
      trainingStatus: null,
      weightKg: normalizeWeightKg(pickNumber(athlete, ['weight'], ['weight'])),
      predictedGoalSeconds: estimateGoalPredictionFromRuns(runningActivities, input.goal.distanceKm, today),
    },
    acuteChronicRatio: null,
    loadBalanceFeedback: null,
  });
}

export async function buildDashboardData(
  input:
    | {
        provider: 'garmin';
        auth: GarminSessionAuth;
        goal: UserGoal;
      }
    | {
        provider: 'strava';
        auth: StravaSessionRecord;
        goal: UserGoal;
      },
): Promise<DashboardData> {
  if (input.provider === 'strava') {
    return buildStravaDashboardData(input);
  }

  return buildGarminDashboardData(input);
}

export function buildFallbackDashboardData(
  goal: UserGoal,
  reason: string,
  providerKey: DashboardProviderKey = 'garmin',
): DashboardData {
  const provider = providerKey === 'strava' ? stravaProviderMeta : garminProviderMeta;
  const today = startOfToday();
  const goalMeta = buildGoalMeta(goal, today);
  const raceDate = parseISO(goalMeta.raceDate);
  const adaptive: AdaptiveGuidance = {
    overall: 'steady',
    primaryNeed: `Recuperar acceso estable a ${provider.label} antes de afinar el plan con datos reales.`,
    volume: {
      action: 'mantener',
      deltaKm: 0,
      rationale: 'Sin datos recientes válidos no conviene mover el volumen automáticamente.',
    },
    pace: {
      action: 'mantener',
      secondsPerKm: 0,
      rationale: 'Sin sesiones recientes no conviene tocar los ritmos del plan.',
    },
    recovery: {
      action: 'normal',
      rationale: `Usa sensaciones y no fuerces hasta que ${provider.label} vuelva a sincronizar.`,
    },
    signals: {
      recent7Km: 0,
      baselineWeeklyKm: null,
      volumeRatio: null,
      acuteChronicRatio: null,
      loadBalanceFeedback: null,
      qualitySessions14d: 0,
      lastLongRunKm: null,
      plannedSessions7d: 0,
      completedSessions7d: 0,
      missedSessions7d: 0,
      movedSessions7d: 0,
      complianceRate7d: null,
      missedKeySessionThisWeek: false,
      keySessionRelocatedTo: null,
      qualityPaceDeltaSeconds: null,
      easyPaceDeltaSeconds: null,
      lowSleepDays7d: 0,
      lowReadinessDays7d: 0,
      hrvDelta: null,
    },
  };

  return {
    provider,
    athlete: {
      name: `Perfil ${provider.label} pendiente`,
      location: null,
      primaryDevice: null,
      avatarPath: null,
      raceDate: goalMeta.raceDate,
      daysToRace: goalMeta.daysToRace,
    },
    goal: goalMeta,
    overview: {
      steps: null,
      activeCalories: null,
      distanceKm: null,
      sleepHours: null,
      sleepScore: null,
      hrv: null,
      readiness: null,
      vo2Max: null,
      trainingStatus: null,
      weightKg: null,
      averageWeeklyKm: null,
      longestRunKm: null,
      predictedGoalSeconds: null,
    },
    wellnessTrend: [],
    weeklyRunning: [],
    vo2Trend: [],
    recentRuns: [],
    fitnessSummary: {
      title: `Sin datos reales de ${provider.label}`,
      body: `Cargo un estado base mientras ${provider.label} vuelve a responder. El plan sigue disponible, pero el ajuste fino está pausado hasta recuperar las sesiones recientes.`,
    },
    adaptive,
    advice: [
      {
        title: `${provider.label} no está respondiendo`,
        body: `El dashboard está listo, pero ahora mismo ${provider.label} no está dejando completar la sincronización. Motivo actual: ${reason} Reintenta más tarde con el botón de refresco para cargar tus métricas reales.`,
        tone: 'warning',
      },
      {
        title: 'Plan provisional',
        body: `Mientras ${provider.label} vuelve a responder, te dejo una estructura base de ${goalMeta.totalWeeks} semanas centrada en llegar fresco a ${goalMeta.label}.`,
        tone: 'accent',
      },
    ],
    checkIn: {
      needsToday: true,
      latest: null,
      recent: [],
    },
    coach: {
      enabled: false,
      source: 'fallback',
      model: null,
      generatedAt: null,
      todayMessage: null,
    },
    plan: buildTrainingPlan({
      today,
      raceDate,
      goal: goalMeta,
      predictedGoalSeconds: null,
      averageWeeklyKm: null,
      longestRunKm: null,
      recentRuns: [],
      adaptive,
      execution: null,
      canSendWorkouts: provider.supportsWorkoutPush,
    }),
    fetchedAt: new Date().toISOString(),
    fallbackReason: reason,
  };
}
