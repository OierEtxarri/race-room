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
import { config } from '../config.ts';
import {
  analyzeAdaptiveGuidance,
  analyzePlanExecution,
  createEmptyPlanExecutionReview,
  type AdaptiveGuidance,
  type PlanExecutionReview,
} from './adaptivePlan.ts';
import { garminClient } from './garminClient.ts';
import { canSchedulePlanDay } from './planWorkouts.ts';

type NullableNumber = number | null;

type RawDateValue = {
  date: string;
  value: NullableNumber;
};

type RunSummary = {
  id: number;
  name: string;
  date: string;
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
  days: TrainingDay[];
};

type AdviceCard = {
  title: string;
  body: string;
  tone: 'accent' | 'calm' | 'warning';
};

export type DashboardData = {
  athlete: {
    name: string;
    location: string | null;
    primaryDevice: string | null;
    raceDate: string;
    daysToRace: number;
  };
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
    predictedHalfSeconds: number | null;
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
  adaptive: AdaptiveGuidance;
  advice: AdviceCard[];
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

function pickReferenceDate(today: Date): string {
  return isoDate(subDays(today, 1));
}

function normalizeRun(activity: unknown): RunSummary | null {
  const id = pickNumber(activity, ['activityId', 'activityUUID'], ['activityid']);
  const date =
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

  if (id === null || !date || !distanceKm || durationSeconds <= 0) {
    return null;
  }

  const paceSecondsPerKm = distanceKm > 0 ? durationSeconds / distanceKm : null;

  return {
    id,
    name: pickString(activity, ['activityName'], ['name']) ?? 'Entrenamiento',
    date: date.slice(0, 10),
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

      nextDay.canSendToGarmin = nextDay.date >= todayIso && canSchedulePlanDay(nextDay);
      return nextDay;
    }),
  }));
}

function buildAdvice(input: {
  daysToRace: number;
  predictedHalfSeconds: number | null;
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

  if (input.predictedHalfSeconds !== null) {
    const racePace = formatPace(input.predictedHalfSeconds / 21.0975);
    cards.push({
      title: 'Ritmo objetivo',
      body: `Tu predicción actual apunta a ${formatSecondsAsRace(input.predictedHalfSeconds)} en media. Usa ${racePace} como referencia de salida y evita ir por debajo de ese ritmo antes del km 5.`,
      tone: 'accent',
    });
  }

  if ((input.longestRunKm ?? 0) < 16) {
    cards.push({
      title: 'Prioridad de abril',
      body: 'Tu tirada larga aún deja margen. Prioriza 2 fines de semana con tiradas progresivas, sin buscar heroísmos, para llegar con más economía al tramo final de carrera.',
      tone: 'warning',
    });
  } else {
    cards.push({
      title: 'Base suficiente',
      body: 'La tirada larga reciente ya sostiene el objetivo. A partir de aquí compensa más afinar el ritmo de media y llegar fresco que seguir acumulando volumen.',
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
      body: 'Las métricas de sueño y readiness acompañan. Puedes sostener un bloque específico de media maratón, siempre que mantengas fácil de verdad los rodajes suaves.',
      tone: 'calm',
    });
  }

  const taperMessage =
    input.daysToRace <= 40
      ? 'Ya estás dentro del tramo específico: la ganancia ahora viene de combinar una sesión de calidad, una sesión controlada a ritmo de media y un taper serio.'
      : 'Todavía hay margen para construir, pero sin abrir frentes nuevos.';

  cards.push({
    title: 'Gestión del taper',
    body: `${taperMessage} Si Garmin marca ${input.trainingStatus ?? 'carga inestable'}, usa esa señal para priorizar frescura sobre volumen residual.`,
    tone: 'accent',
  });

  if ((input.averageWeeklyKm ?? 0) < 30) {
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
  predictedHalfSeconds: number | null;
  averageWeeklyKm: number | null;
  longestRunKm: number | null;
  recentRuns: RunSummary[];
  adaptive: AdaptiveGuidance;
  execution: PlanExecutionReview | null;
}) {
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

  const averageWeeklyKm = Math.max(18, (input.averageWeeklyKm ?? 28) + volumeDelta);
  const longestRunKm = input.longestRunKm ?? 14;
  const level: DashboardData['plan']['level'] =
    averageWeeklyKm >= 48 ? 'ambicioso' : averageWeeklyKm >= 30 ? 'equilibrado' : 'conservador';
  const peakVolume = Math.max(24, Math.min(70, averageWeeklyKm));
  const peakLongRun = Math.max(14, Math.min(22, roundHalfKm(Math.max(longestRunKm, peakVolume * 0.38))));
  const racePace = input.predictedHalfSeconds ? input.predictedHalfSeconds / 21.0975 : null;
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

  const weeklyTargets = [0.92, 1.02, 0.97, 0.78, 0.64, 0.4].map((factor) => roundHalfKm(peakVolume * factor));
  const weekFocuses = [
    'Reforzar base aeróbica y meter un primer bloque específico.',
    'Semana fuerte con trabajo de umbral y tirada larga controlada.',
    'Último pico de carga antes del taper.',
    'Bajar volumen manteniendo chispa.',
    'Afinar ritmo objetivo sin acumular fatiga.',
    'Llegar fresco a la media maratón.',
  ];

  const TuesdayTitles = [
    'Series largas',
    'Umbral en bloques',
    'Ritmo controlado',
    'Series de afinado',
    'Ritmo de media',
    'Activación',
  ];
  const FridayTitles = [
    'Ritmo de media',
    'Tempo progresivo',
    'Rodaje controlado',
    'Tempo corto',
    'Toque fino',
    'Descarga',
  ];

  const weeks: TrainingWeek[] = [];
  const planStart = startOfWeek(input.today, { weekStartsOn: 1 });
  const todayIso = isoDate(input.today);

  for (let weekIndex = 0; weekIndex < 6; weekIndex += 1) {
    const weekStart = weekIndex === 0 ? planStart : startOfWeek(subDays(endOfWeek(planStart, { weekStartsOn: 1 }), -7 * weekIndex), { weekStartsOn: 1 });
    const monday = subDays(weekStart, 0);
    const dates = Array.from({ length: 7 }, (_, offset) => subDays(monday, -offset));
    const targetKm = weekIndex === 5 ? null : weeklyTargets[weekIndex] ?? null;
    const longRunKm = weekIndex === 5 ? null : roundHalfKm(Math.max(12, peakLongRun - Math.max(0, 3 - weekIndex)));
    const qualityKm = targetKm ? roundHalfKm(targetKm * 0.2) : null;
    const easyKm = targetKm ? roundHalfKm(targetKm * (level === 'conservador' ? 0.16 : 0.18)) : null;
    const recoveryKm = targetKm ? roundHalfKm(targetKm * (level === 'conservador' ? 0.12 : 0.14)) : null;
    const preRaceWeek = weekIndex === 4;
    const raceWeek = weekIndex === 5;
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

      if (raceWeek && iso === config.raceDate) {
        return finalizeDay({
          date: iso,
          weekday: lowerWeekday,
          title: 'Media maratón',
          intent: 'competición',
          intensity: 'carrera',
          distanceKm: 21.1,
          notes: `Salida muy controlada hasta el km 5. Ritmo objetivo ${paces.race ?? 'por sensaciones fuertes y estables'} y toma de carbohidratos cada 25-30 minutos.`,
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
            title: TuesdayTitles[weekIndex] ?? 'Calidad',
            intent: 'trabajo principal',
            intensity: 'alto',
            distanceKm: qualityKm,
            notes: raceWeek
              ? '25-35 min suaves + 5 rectas de 20". Nada de fatiga residual.'
              : weekIndex === 0
                ? `Calentamiento + 5x1 km a ${paces.tempo ?? 'ritmo vivo controlado'} con 90" suaves.${qualityGuardrail}`
                : weekIndex === 1
                  ? `3x2 km a ${paces.tempo ?? 'umbral controlado'} con 2' suaves.${qualityGuardrail}`
                  : weekIndex === 2
                    ? `2x4 km a ${paces.steady ?? 'ritmo sostenido'} con 3' suaves.${qualityGuardrail}`
                    : weekIndex === 3
                      ? `6x800 m vivos con recuperación completa.${qualityGuardrail}`
                      : `4x1 km a ritmo de media con mucha soltura.${qualityGuardrail}`,
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
            title: FridayTitles[weekIndex] ?? 'Control',
            intent: 'economía de carrera',
            intensity: preRaceWeek || raceWeek || input.adaptive.overall === 'protect' ? 'medio' : 'alto',
            distanceKm: preRaceWeek ? roundHalfKm((targetKm ?? 0) * 0.14) : qualityKm,
            notes: raceWeek
              ? '30 min muy suaves. Si te notas pesado, convierte el día en descanso total.'
              : preRaceWeek
                ? `8-10 km con 3 km a ${paces.race ?? 'ritmo de media'} y buenas sensaciones.${qualityGuardrail}`
                : `Rodaje controlado terminando cerca de ${paces.race ?? 'ritmo objetivo'} sin forzar.${qualityGuardrail}`,
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
              : `Tirada larga fácil. Últimos 15-20 min algo más alegres si llegas con buenas piernas; combustible ensayado.${qualityGuardrail}`,
            status: 'planned',
            outcome: null,
          });
      }
    });

    weeks.push({
      title: raceWeek
        ? `Semana de carrera`
        : `Semana ${weekIndex + 1}`,
      focus: weekFocuses[weekIndex] ?? 'Sostener consistencia.',
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

  const summary = `Vas con un nivel ${level}, promediando ${round(averageWeeklyKm, 1)} km/sem y con tirada larga reciente de ${round(longestRunKm, 1)} km.${complianceSentence}${relocationSentence} Ajuste actual: ${describeAdaptiveVolume(input.adaptive)} ${describeAdaptivePace(input.adaptive)} Tus últimos 4 entrenamientos suman ${recentDistance} km, así que el foco está en calidad utilizable, taper progresivo y llegar al 10 de mayo con piernas frescas.`;

  return {
    summary,
    level,
    paces,
    weeks: applyExecutionToWeeks({
      weeks,
      execution: input.execution,
      today: input.today,
      adaptive: input.adaptive,
    }),
  };
}

export async function buildDashboardData(): Promise<DashboardData> {
  const today = startOfToday();
  const raceDate = parseISO(config.raceDate);
  const referenceDate = pickReferenceDate(today);
  const wellnessStart = isoDate(subDays(today, 13));
  const runningStart = isoDate(subWeeks(today, 6));
  const weightStart = isoDate(subWeeks(today, 4));

  const userProfile = await garminClient.callJson('get_user_profile');
  const devices = await garminClient.callJson('get_devices');
  const dailySummary = await garminClient.callJson('get_daily_summary', { date: referenceDate });
  const sleepRange = await garminClient.callJson('get_sleep_data_range', {
    startDate: wellnessStart,
    endDate: referenceDate,
  });
  const hrvRange = await garminClient.callJson('get_hrv_range', {
    startDate: wellnessStart,
    endDate: referenceDate,
  });
  const readinessRange = await garminClient.callJson('get_training_readiness_range', {
    startDate: wellnessStart,
    endDate: referenceDate,
  });
  const stepsRange = await garminClient.callJson('get_daily_steps_range', {
    startDate: wellnessStart,
    endDate: referenceDate,
  });
  const vo2Range = await garminClient.callJson('get_vo2max_range', {
    startDate: runningStart,
    endDate: referenceDate,
  });
  const trainingStatusRaw = await garminClient.callJson('get_training_status', { date: referenceDate });
  const racePredictionsRaw = await garminClient.callJson('get_race_predictions');
  const runningActivitiesRaw = await garminClient.callJson('get_activities_by_date', {
    startDate: runningStart,
    endDate: referenceDate,
    activityType: 'running',
  });
  const bodyCompositionRaw = await garminClient.callJson('get_body_composition', {
    startDate: weightStart,
    endDate: referenceDate,
  });

  const runningActivities = Array.isArray(runningActivitiesRaw)
    ? runningActivitiesRaw.map(normalizeRun).filter((run): run is RunSummary => run !== null)
    : [];

  const weeklyRunning = groupWeeklyRunning(runningActivities);
  const recentRuns = [...runningActivities]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 8);

  const averageWeeklyKm = average(weeklyRunning.map((entry) => entry.distanceKm));
  const longestRunKm = runningActivities.reduce((max, run) => Math.max(max, run.distanceKm), 0) || null;

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
  const predictedHalfSeconds = racePredictions.half ?? null;
  const trainingStatus = extractTrainingStatus(trainingStatusRaw);
  const acuteChronicRatio = extractAcuteChronicRatio(trainingStatusRaw);
  const loadBalanceFeedback = extractLoadBalanceFeedback(trainingStatusRaw);
  const overview = {
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
    averageWeeklyKm: averageWeeklyKm ? round(averageWeeklyKm, 1) : null,
    longestRunKm: longestRunKm ? round(longestRunKm, 1) : null,
    predictedHalfSeconds,
  };

  const readinessAvg = average(readinessSeries.map((entry) => entry.value).filter((value): value is number => value !== null));
  const sleepAvgHours = average(sleepSeries.map((entry) => entry.value).filter((value): value is number => value !== null));
  const recentSleepDays = sleepSeries.filter((entry) => entry.date >= isoDate(subDays(today, 7)));
  const recentReadinessDays = readinessSeries.filter((entry) => entry.date >= isoDate(subDays(today, 7)));
  const lowSleepDays7d = recentSleepDays.filter((entry) => (entry.value ?? 10) < 6.5).length;
  const lowReadinessDays7d = recentReadinessDays.filter((entry) => (entry.value ?? 100) < 60).length;
  const validHrv = hrvSeries.map((entry) => entry.value).filter((value): value is number => value !== null);
  const hrvDelta =
    validHrv.length >= 6
      ? round(
          average(validHrv.slice(-3))! - average(validHrv.slice(0, Math.max(1, validHrv.length - 3)))!,
          1,
        )
      : null;
  const baselineAdaptive = analyzeAdaptiveGuidance({
    today,
    raceDate,
    recentRuns: runningActivities,
    averageWeeklyKm: overview.averageWeeklyKm,
    readinessAvg,
    sleepAvgHours,
    acuteChronicRatio,
    loadBalanceFeedback,
    predictedHalfSeconds,
    execution: createEmptyPlanExecutionReview(),
    lowSleepDays7d,
    lowReadinessDays7d,
    hrvDelta,
  });
  const draftPlan = buildTrainingPlan({
    today,
    raceDate,
    predictedHalfSeconds,
    averageWeeklyKm: overview.averageWeeklyKm,
    longestRunKm: overview.longestRunKm,
    recentRuns,
    adaptive: baselineAdaptive,
    execution: null,
  });
  const execution = analyzePlanExecution({
    today,
    recentRuns: runningActivities,
    weeks: draftPlan.weeks,
    paces: draftPlan.paces,
  });
  const adaptive = analyzeAdaptiveGuidance({
    today,
    raceDate,
    recentRuns: runningActivities,
    averageWeeklyKm: overview.averageWeeklyKm,
    readinessAvg,
    sleepAvgHours,
    acuteChronicRatio,
    loadBalanceFeedback,
    predictedHalfSeconds,
    execution,
    lowSleepDays7d,
    lowReadinessDays7d,
    hrvDelta,
  });

  const athleteName =
    pickString(userProfile, ['fullName', 'displayName', 'userName'], ['name', 'display']) ??
    'Tu perfil Garmin';
  const locationParts = [
    pickString(userProfile, ['location'], ['location']),
    pickString(userProfile, ['city'], ['city']),
    pickString(userProfile, ['countryCode'], ['country']),
  ].filter((item): item is string => Boolean(item));

  const deviceList = Array.isArray(devices) ? devices : [];
  const primaryDevice = pickString(
    deviceList[0],
    ['displayName', 'deviceName', 'partNumber'],
    ['display', 'device', 'name'],
  );

  const advice = buildAdvice({
    daysToRace: differenceInCalendarDays(raceDate, today),
    predictedHalfSeconds,
    averageWeeklyKm: overview.averageWeeklyKm,
    longestRunKm: overview.longestRunKm,
    readinessAvg,
    sleepAvgHours,
    trainingStatus,
    adaptive,
  });

  const plan = buildTrainingPlan({
    today,
    raceDate,
    predictedHalfSeconds,
    averageWeeklyKm: overview.averageWeeklyKm,
    longestRunKm: overview.longestRunKm,
    recentRuns,
    adaptive,
    execution,
  });

  return {
    athlete: {
      name: athleteName,
      location: locationParts.length ? locationParts.join(' · ') : null,
      primaryDevice,
      raceDate: config.raceDate,
      daysToRace: differenceInCalendarDays(raceDate, today),
    },
    overview,
    wellnessTrend,
    weeklyRunning,
    vo2Trend: vo2Series.map((entry) => ({
      date: entry.date,
      label: format(parseISO(entry.date), 'dd/MM'),
      value: entry.value,
    })),
    recentRuns,
    adaptive,
    advice,
    plan,
    fetchedAt: new Date().toISOString(),
  };
}

export function buildFallbackDashboardData(reason: string): DashboardData {
  const today = startOfToday();
  const raceDate = parseISO(config.raceDate);
  const adaptive: AdaptiveGuidance = {
    overall: 'steady',
    primaryNeed: 'Recuperar acceso estable a Garmin antes de afinar el plan con datos reales.',
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
      rationale: 'Usa sensaciones y no fuerces hasta que Garmin vuelva a sincronizar.',
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
    athlete: {
      name: 'Perfil Garmin pendiente',
      location: null,
      primaryDevice: null,
      raceDate: config.raceDate,
      daysToRace: differenceInCalendarDays(raceDate, today),
    },
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
      predictedHalfSeconds: null,
    },
    wellnessTrend: [],
    weeklyRunning: [],
    vo2Trend: [],
    recentRuns: [],
    adaptive,
    advice: [
      {
        title: 'Garmin ha limitado la conexión',
        body: `El dashboard está listo, pero ahora mismo Garmin Connect no está dejando completar la autenticación. Motivo actual: ${reason} Reintenta más tarde con el botón de refresco para cargar tus métricas reales.`,
        tone: 'warning',
      },
      {
        title: 'Plan provisional',
        body: 'Mientras Garmin desbloquea la sesión, te dejo una estructura base de 6 semanas centrada en llegar fresco y con una sola sesión fuerte por semana.',
        tone: 'accent',
      },
    ],
    plan: buildTrainingPlan({
      today,
      raceDate,
      predictedHalfSeconds: null,
      averageWeeklyKm: null,
      longestRunKm: null,
      recentRuns: [],
      adaptive,
      execution: null,
    }),
    fetchedAt: new Date().toISOString(),
    fallbackReason: reason,
  };
}
