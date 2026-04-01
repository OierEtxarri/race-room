import { differenceInCalendarDays, format, parseISO, startOfWeek, subDays } from 'date-fns';

export type AdaptiveRun = {
  id: number;
  date: string;
  distanceKm: number;
  paceSecondsPerKm: number | null;
  trainingEffect: number | null;
  trainingLoad: number | null;
  workoutId: number | null;
  name: string;
};

export type AdaptivePlanDay = {
  date: string;
  title: string;
  intensity: 'suave' | 'medio' | 'alto' | 'recuperacion' | 'descanso' | 'carrera';
  distanceKm: number | null;
  notes: string;
};

export type AdaptivePlanPaces = {
  easy: string | null;
  steady: string | null;
  tempo: string | null;
  race: string | null;
};

export type PlanExecutionMatch = {
  plannedDate: string;
  title: string;
  intensity: AdaptivePlanDay['intensity'];
  status: 'done' | 'missed' | 'moved';
  actualRunId: number | null;
  actualDate: string | null;
  paceDeltaSeconds: number | null;
};

export type PlanExecutionReview = {
  matches: PlanExecutionMatch[];
  plannedSessions7d: number;
  completedSessions7d: number;
  missedSessions7d: number;
  movedSessions7d: number;
  complianceRate7d: number | null;
  missedKeySessionThisWeek: boolean;
  relocation: {
    fromDate: string;
    toDate: string | null;
    title: string;
    distanceKm: number | null;
    intensity: AdaptivePlanDay['intensity'];
    notes: string;
  } | null;
  qualityPaceDeltaSeconds: number | null;
  easyPaceDeltaSeconds: number | null;
};

export type AdaptiveGuidance = {
  overall: 'push' | 'steady' | 'protect';
  primaryNeed: string;
  volume: {
    action: 'subir' | 'mantener' | 'bajar';
    deltaKm: number;
    rationale: string;
  };
  pace: {
    action: 'acelerar' | 'mantener' | 'aflojar';
    secondsPerKm: number;
    rationale: string;
  };
  recovery: {
    action: 'proteger' | 'normal' | 'apretar';
    rationale: string;
  };
  signals: {
    recent7Km: number;
    baselineWeeklyKm: number | null;
    volumeRatio: number | null;
    acuteChronicRatio: number | null;
    loadBalanceFeedback: string | null;
    qualitySessions14d: number;
    lastLongRunKm: number | null;
    plannedSessions7d: number;
    completedSessions7d: number;
    missedSessions7d: number;
    movedSessions7d: number;
    complianceRate7d: number | null;
    missedKeySessionThisWeek: boolean;
    keySessionRelocatedTo: string | null;
    qualityPaceDeltaSeconds: number | null;
    easyPaceDeltaSeconds: number | null;
    lowSleepDays7d: number;
    lowReadinessDays7d: number;
    hrvDelta: number | null;
  };
};

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isoDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

function average(values: number[]): number | null {
  if (!values.length) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sumDistance(runs: AdaptiveRun[]): number {
  return round(runs.reduce((sum, run) => sum + run.distanceKm, 0), 1);
}

function parsePaceSeconds(pace: string | null): number | null {
  if (!pace) {
    return null;
  }

  const first = pace.split(' - ')[0] ?? pace;
  const match = first.match(/(\d+):(\d{2})\/km/);
  if (!match) {
    return null;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

function parsePaceBandCenter(pace: string | null): number | null {
  if (!pace) {
    return null;
  }

  if (!pace.includes(' - ')) {
    return parsePaceSeconds(pace);
  }

  const [left, right] = pace.split(' - ');
  const leftSeconds = parsePaceSeconds(left ?? null);
  const rightSeconds = parsePaceSeconds(right ?? null);

  if (leftSeconds === null || rightSeconds === null) {
    return null;
  }

  return round((leftSeconds + rightSeconds) / 2, 0);
}

function isQualityRun(run: AdaptiveRun): boolean {
  return (run.trainingEffect ?? 0) >= 2.5 || run.workoutId !== null;
}

function isRunnablePlanDay(day: AdaptivePlanDay): boolean {
  return day.intensity !== 'descanso' && day.intensity !== 'carrera' && !day.title.includes('Fuerza');
}

function isQualityPlanDay(day: AdaptivePlanDay): boolean {
  return day.intensity === 'alto' || day.title.includes('Ritmo') || day.title.includes('Series') || day.title.includes('Tempo');
}

function isEasyPlanDay(day: AdaptivePlanDay): boolean {
  return (
    day.intensity === 'suave' ||
    day.intensity === 'recuperacion' ||
    day.title.includes('Rodaje suave') ||
    day.title.includes('Suave') ||
    day.title.includes('Tirada larga')
  );
}

function targetPaceForDay(day: AdaptivePlanDay, paces: AdaptivePlanPaces): number | null {
  if (day.title.includes('Ritmo objetivo') || day.title.includes('Bloque objetivo') || day.intensity === 'carrera') {
    return parsePaceSeconds(paces.race);
  }

  if (day.title.includes('Ritmo controlado') || day.title.includes('Rodaje controlado') || day.title === 'Control') {
    return parsePaceSeconds(paces.steady);
  }

  if (day.title.includes('Tirada larga') || isEasyPlanDay(day)) {
    return parsePaceBandCenter(paces.easy);
  }

  if (day.title.includes('Tempo') || day.title.includes('Series') || day.title.includes('Umbral')) {
    return parsePaceBandCenter(paces.tempo);
  }

  if (day.intensity === 'medio') {
    return parsePaceSeconds(paces.steady) ?? parsePaceBandCenter(paces.easy);
  }

  if (day.intensity === 'alto') {
    return parsePaceBandCenter(paces.tempo) ?? parsePaceSeconds(paces.race);
  }

  return parsePaceBandCenter(paces.easy);
}

function pickBestCandidate(plannedDay: AdaptivePlanDay, unusedRuns: AdaptiveRun[]): AdaptiveRun | null {
  const plannedDate = parseISO(plannedDay.date);
  const minDistance = plannedDay.distanceKm
    ? Math.max(2, plannedDay.distanceKm * (isQualityPlanDay(plannedDay) ? 0.4 : 0.45))
    : isQualityPlanDay(plannedDay)
      ? 2.5
      : 2;

  let best: { run: AdaptiveRun; score: number } | null = null;

  for (const run of unusedRuns) {
    const dateGap = Math.abs(differenceInCalendarDays(parseISO(run.date), plannedDate));
    if (dateGap > 1 || run.distanceKm < minDistance) {
      continue;
    }

    let score = dateGap * 100;
    const runQuality = isQualityRun(run);

    if (isQualityPlanDay(plannedDay) && !runQuality) {
      score += 35;
    }

    if (!isQualityPlanDay(plannedDay) && runQuality) {
      score += 18;
    }

    if (plannedDay.distanceKm) {
      score += Math.abs(run.distanceKm - plannedDay.distanceKm) * 10;
    }

    if (!best || score < best.score) {
      best = { run, score };
    }
  }

  return best?.run ?? null;
}

export function createEmptyPlanExecutionReview(): PlanExecutionReview {
  return {
    matches: [],
    plannedSessions7d: 0,
    completedSessions7d: 0,
    missedSessions7d: 0,
    movedSessions7d: 0,
    complianceRate7d: null,
    missedKeySessionThisWeek: false,
    relocation: null,
    qualityPaceDeltaSeconds: null,
    easyPaceDeltaSeconds: null,
  };
}

export function analyzePlanExecution(input: {
  today: Date;
  recentRuns: AdaptiveRun[];
  weeks: Array<{ title: string; days: AdaptivePlanDay[] }>;
  paces: AdaptivePlanPaces;
}): PlanExecutionReview {
  const todayIso = isoDate(input.today);
  const weekStart = isoDate(startOfWeek(input.today, { weekStartsOn: 1 }));
  const complianceWindowStart = isoDate(subDays(input.today, 7));
  const reviewWindowStart = isoDate(subDays(input.today, 14));
  const plannedDays = input.weeks
    .flatMap((week) => week.days)
    .filter((day) => isRunnablePlanDay(day) && day.date < todayIso && day.date >= reviewWindowStart)
    .sort((left, right) => left.date.localeCompare(right.date));

  const unusedRuns = [...input.recentRuns]
    .filter((run) => run.date >= reviewWindowStart)
    .sort((left, right) => left.date.localeCompare(right.date));
  const matches: PlanExecutionMatch[] = [];
  const qualityPaceDeltas: number[] = [];
  const easyPaceDeltas: number[] = [];

  for (const plannedDay of plannedDays) {
    const candidate = pickBestCandidate(plannedDay, unusedRuns);
    const targetPace = targetPaceForDay(plannedDay, input.paces);

    if (!candidate) {
      matches.push({
        plannedDate: plannedDay.date,
        title: plannedDay.title,
        intensity: plannedDay.intensity,
        status: 'missed',
        actualRunId: null,
        actualDate: null,
        paceDeltaSeconds: null,
      });
      continue;
    }

    const candidateIndex = unusedRuns.findIndex((run) => run.id === candidate.id);
    if (candidateIndex >= 0) {
      unusedRuns.splice(candidateIndex, 1);
    }

    const paceDelta =
      candidate.paceSecondsPerKm !== null && targetPace !== null
        ? round(candidate.paceSecondsPerKm - targetPace, 0)
        : null;

    if (paceDelta !== null && isQualityPlanDay(plannedDay)) {
      qualityPaceDeltas.push(paceDelta);
    }

    if (paceDelta !== null && isEasyPlanDay(plannedDay)) {
      easyPaceDeltas.push(paceDelta);
    }

    matches.push({
      plannedDate: plannedDay.date,
      title: plannedDay.title,
      intensity: plannedDay.intensity,
      status: candidate.date === plannedDay.date ? 'done' : 'moved',
      actualRunId: candidate.id,
      actualDate: candidate.date,
      paceDeltaSeconds: paceDelta,
    });
  }

  const complianceMatches = matches.filter((match) => match.plannedDate >= complianceWindowStart);
  const plannedSessions7d = complianceMatches.length;
  const completedSessions7d = complianceMatches.filter((match) => match.status !== 'missed').length;
  const missedSessions7d = complianceMatches.filter((match) => match.status === 'missed').length;
  const movedSessions7d = complianceMatches.filter((match) => match.status === 'moved').length;
  const complianceRate7d =
    plannedSessions7d > 0 ? round(completedSessions7d / plannedSessions7d, 2) : null;

  const currentWeekQuality = matches.filter(
    (match) =>
      match.plannedDate >= weekStart &&
      (match.intensity === 'alto' || match.intensity === 'medio') &&
      match.title !== 'Tirada larga',
  );
  const missedQuality = currentWeekQuality.find((match) => match.status === 'missed') ?? null;
  const completedQualityThisWeek = currentWeekQuality.some((match) => match.status !== 'missed');
  const futureDaysThisWeek = input.weeks[0]?.days.filter(
    (day) =>
      day.date >= todayIso &&
      isRunnablePlanDay(day) &&
      !day.title.includes('Tirada larga') &&
      day.intensity !== 'alto',
  ) ?? [];
  const relocationTarget =
    missedQuality && !completedQualityThisWeek
      ? futureDaysThisWeek
          .sort((left, right) => {
            const intensityScore = (day: AdaptivePlanDay) =>
              day.intensity === 'recuperacion' ? 0 : day.intensity === 'suave' ? 1 : 2;
            return intensityScore(left) - intensityScore(right) || left.date.localeCompare(right.date);
          })
          .at(0) ?? null
      : null;

  return {
    matches,
    plannedSessions7d,
    completedSessions7d,
    missedSessions7d,
    movedSessions7d,
    complianceRate7d,
    missedKeySessionThisWeek: Boolean(missedQuality && !completedQualityThisWeek),
    relocation:
      missedQuality
        ? {
            fromDate: missedQuality.plannedDate,
            toDate: relocationTarget?.date ?? null,
            title: missedQuality.title,
            distanceKm:
              input.weeks
                .flatMap((week) => week.days)
                .find((day) => day.date === missedQuality.plannedDate && day.title === missedQuality.title)
                ?.distanceKm ?? null,
            intensity: missedQuality.intensity,
            notes:
              input.weeks
                .flatMap((week) => week.days)
                .find((day) => day.date === missedQuality.plannedDate && day.title === missedQuality.title)
                ?.notes ?? '',
          }
        : null,
    qualityPaceDeltaSeconds: round(average(qualityPaceDeltas) ?? 0, 0) || null,
    easyPaceDeltaSeconds: round(average(easyPaceDeltas) ?? 0, 0) || null,
  };
}

export function analyzeAdaptiveGuidance(input: {
  today: Date;
  raceDate: Date;
  goalDistanceKm: number;
  recentRuns: AdaptiveRun[];
  averageWeeklyKm: number | null;
  readinessAvg: number | null;
  sleepAvgHours: number | null;
  acuteChronicRatio: number | null;
  loadBalanceFeedback: string | null;
  predictedGoalSeconds: number | null;
  execution: PlanExecutionReview;
  lowSleepDays7d: number;
  lowReadinessDays7d: number;
  hrvDelta: number | null;
}): AdaptiveGuidance {
  const datedRuns = input.recentRuns.map((run) => ({
    ...run,
    daysAgo: differenceInCalendarDays(input.today, parseISO(run.date)),
  }));

  const recent7 = datedRuns.filter((run) => run.daysAgo >= 0 && run.daysAgo <= 6);
  const baselineWindow = datedRuns.filter((run) => run.daysAgo >= 7 && run.daysAgo <= 27);
  const recent14 = datedRuns.filter((run) => run.daysAgo >= 0 && run.daysAgo <= 13);
  const baselineWeeklyKm =
    baselineWindow.length > 0
      ? round(sumDistance(baselineWindow) / 3, 1)
      : input.averageWeeklyKm;
  const recent7Km = sumDistance(recent7);
  const volumeRatio =
    baselineWeeklyKm && baselineWeeklyKm > 0 ? round(recent7Km / baselineWeeklyKm, 2) : null;
  const qualitySessions14d = recent14.filter((run) => isQualityRun(run)).length;
  const lastLongRunKm =
    recent14.reduce((max, run) => Math.max(max, run.distanceKm), 0) > 0
      ? recent14.reduce((max, run) => Math.max(max, run.distanceKm), 0)
      : null;

  const racePace =
    input.predictedGoalSeconds !== null ? input.predictedGoalSeconds / input.goalDistanceKm : null;
  const sharpRuns = recent14.filter(
    (run) =>
      run.paceSecondsPerKm !== null &&
      run.distanceKm >= 2.5 &&
      run.distanceKm <= 6.5 &&
      isQualityRun(run),
  );
  const bestSharpPace = sharpRuns.reduce<number | null>((best, run) => {
    if (run.paceSecondsPerKm === null) {
      return best;
    }
    if (best === null || run.paceSecondsPerKm < best) {
      return run.paceSecondsPerKm;
    }
    return best;
  }, null);

  let volumeAction: AdaptiveGuidance['volume']['action'] = 'mantener';
  let volumeDelta = 0;
  let volumeRationale = 'La carga reciente no pide una corrección clara del volumen.';

  if (
    (input.acuteChronicRatio ?? 0) >= 1.45 ||
    (input.readinessAvg ?? 100) < 58 ||
    (input.sleepAvgHours ?? 8) < 6.6 ||
    (volumeRatio ?? 1) > 1.2
  ) {
    volumeAction = 'bajar';
    volumeDelta = 2;
    volumeRationale =
      'La carga aguda va alta para tu base reciente. Conviene recortar un poco el volumen inmediato y absorber mejor las sesiones ya hechas.';
  } else if (
    (volumeRatio ?? 1) < 0.75 &&
    (input.readinessAvg ?? 0) >= 70 &&
    (input.sleepAvgHours ?? 0) >= 7 &&
    differenceInCalendarDays(input.raceDate, input.today) > 16
  ) {
    volumeAction = 'subir';
    volumeDelta = 2;
    volumeRationale =
      'Vienes de una semana algo corta y tus métricas de recuperación acompañan. Puedes meter un poco más de trabajo útil, sin saltos bruscos.';
  }

  if ((input.execution.complianceRate7d ?? 1) < 0.6 && volumeAction === 'subir') {
    volumeAction = 'mantener';
    volumeDelta = 0;
    volumeRationale =
      'Antes de subir carga te compensa consolidar cumplimiento. La prioridad es encadenar semanas ordenadas, no sumar km en teoría.';
  }

  if ((input.loadBalanceFeedback ?? '').includes('AEROBIC_HIGH_SHORTAGE') && volumeAction !== 'bajar') {
    volumeRationale =
      'Garmin marca escasez de trabajo aeróbico alto. Mejor meter más bloque sostenido a ritmo controlado que más series cortas.';
  }

  let paceAction: AdaptiveGuidance['pace']['action'] = 'mantener';
  let paceSeconds = 0;
  let paceRationale = 'Tus ritmos objetivo siguen siendo razonables para lo que has enseñado en los últimos entrenamientos.';

  if (
    (input.readinessAvg ?? 100) < 58 ||
    (input.sleepAvgHours ?? 8) < 6.6 ||
    (input.acuteChronicRatio ?? 0) >= 1.55
  ) {
    paceAction = 'aflojar';
    paceSeconds = 6;
    paceRationale =
      'Ahora mismo compensa proteger la asimilación. Afloja un punto los ritmos de calidad y deja que la recuperación vuelva a mandar.';
  } else if (
    racePace !== null &&
    bestSharpPace !== null &&
    bestSharpPace < racePace - 18 &&
    qualitySessions14d >= 2 &&
    (input.readinessAvg ?? 0) >= 70 &&
    ((input.acuteChronicRatio ?? 1) >= 0.8 && (input.acuteChronicRatio ?? 1) <= 1.25)
  ) {
    paceAction = 'acelerar';
    paceSeconds = 4;
    paceRationale =
      'Tus mejores sesiones recientes salen claramente por encima del ritmo objetivo previsto y sin señales de fatiga descontrolada. Se puede tensar un poco el plan.';
  }

  if ((input.execution.qualityPaceDeltaSeconds ?? 0) >= 12) {
    paceAction = 'aflojar';
    paceSeconds = Math.max(paceSeconds, 8);
    paceRationale =
      'Tus sesiones de calidad recientes se están yendo por detrás del ritmo previsto. Conviene aflojar un punto, recuperar mejor y volver a construir desde ahí.';
  } else if (
    (input.execution.qualityPaceDeltaSeconds ?? 0) <= -10 &&
    (input.execution.complianceRate7d ?? 0) >= 0.75 &&
    (input.acuteChronicRatio ?? 1) < 1.25 &&
    input.lowSleepDays7d <= 1
  ) {
    paceAction = 'acelerar';
    paceSeconds = Math.max(paceSeconds, 5);
    paceRationale =
      'La calidad te está saliendo por encima del objetivo con cumplimiento sólido. Hay margen para tensar un poco los ritmos sin hacer el plan temerario.';
  }

  let recoveryAction: AdaptiveGuidance['recovery']['action'] = 'normal';
  let recoveryRationale =
    'La recuperación acompaña lo suficiente como para sostener el bloque actual sin cambios drásticos.';

  if ((input.acuteChronicRatio ?? 0) >= 1.45 || (input.readinessAvg ?? 100) < 60) {
    recoveryAction = 'proteger';
    recoveryRationale =
      'El cuerpo te pide consolidar. Si enlazas una mala noche o piernas pesadas, convierte un rodaje suave en recuperación activa o descanso.';
  } else if (
    (input.readinessAvg ?? 0) >= 74 &&
    (input.sleepAvgHours ?? 0) >= 7 &&
    (input.acuteChronicRatio ?? 1) < 1.15
  ) {
    recoveryAction = 'apretar';
    recoveryRationale =
      'Tus métricas dejan margen para un pequeño empujón, siempre con rodajes suaves realmente suaves.';
  }

  if ((input.execution.easyPaceDeltaSeconds ?? 0) <= -15) {
    recoveryAction = 'proteger';
    recoveryRationale =
      'Tus rodajes suaves están saliendo demasiado vivos respecto al plan. Baja de verdad esos días o la calidad dejará de ser calidad y pasará a ser fatiga.';
  }

  if (input.lowSleepDays7d >= 2 || input.lowReadinessDays7d >= 2 || (input.hrvDelta ?? 0) <= -6) {
    recoveryAction = 'proteger';
    recoveryRationale =
      'Las señales de recuperación reciente no están limpias. Esta semana manda el sueño, la soltura y no encadenar estrés oculto.';
  }

  let overall: AdaptiveGuidance['overall'] = 'steady';
  let primaryNeed = 'Consolidar ritmo y consistencia.';

  if (volumeAction === 'bajar' || paceAction === 'aflojar' || recoveryAction === 'proteger') {
    overall = 'protect';
    primaryNeed = 'Absorber la carga reciente y proteger recuperación.';
  } else if (volumeAction === 'subir' || paceAction === 'acelerar' || recoveryAction === 'apretar') {
    overall = 'push';
    primaryNeed = 'Aprovechar el margen actual para construir un poco más.';
  }

  if ((input.loadBalanceFeedback ?? '').includes('AEROBIC_HIGH_SHORTAGE')) {
    primaryNeed =
      overall === 'protect'
        ? 'Proteger la recuperación y meter calidad sostenida, no series agresivas.'
        : 'Meter más trabajo sostenido cerca del umbral y menos chispa vacía.';
  }

  if ((input.execution.complianceRate7d ?? 1) < 0.6) {
    primaryNeed = 'Recuperar consistencia semanal. Ahora mismo importa más cumplir bien que endurecer el plan.';
  }

  if (input.execution.missedKeySessionThisWeek) {
    primaryNeed = input.execution.relocation?.toDate
      ? `No ha salido la sesión clave de esta semana. La reubico al ${input.execution.relocation.toDate} y evito meter doble calidad.`
      : 'Has perdido la sesión clave de esta semana. Toca recomponer sin intentar recuperar todo de golpe.';
  }

  return {
    overall,
    primaryNeed,
    volume: {
      action: volumeAction,
      deltaKm: volumeDelta,
      rationale: volumeRationale,
    },
    pace: {
      action: paceAction,
      secondsPerKm: paceSeconds,
      rationale: paceRationale,
    },
    recovery: {
      action: recoveryAction,
      rationale: recoveryRationale,
    },
    signals: {
      recent7Km,
      baselineWeeklyKm,
      volumeRatio,
      acuteChronicRatio: input.acuteChronicRatio,
      loadBalanceFeedback: input.loadBalanceFeedback,
      qualitySessions14d,
      lastLongRunKm,
      plannedSessions7d: input.execution.plannedSessions7d,
      completedSessions7d: input.execution.completedSessions7d,
      missedSessions7d: input.execution.missedSessions7d,
      movedSessions7d: input.execution.movedSessions7d,
      complianceRate7d: input.execution.complianceRate7d,
      missedKeySessionThisWeek: input.execution.missedKeySessionThisWeek,
      keySessionRelocatedTo: input.execution.relocation?.toDate ?? null,
      qualityPaceDeltaSeconds: input.execution.qualityPaceDeltaSeconds,
      easyPaceDeltaSeconds: input.execution.easyPaceDeltaSeconds,
      lowSleepDays7d: input.lowSleepDays7d,
      lowReadinessDays7d: input.lowReadinessDays7d,
      hrvDelta: input.hrvDelta,
    },
  };
}
