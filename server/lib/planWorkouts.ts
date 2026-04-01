import { garminPythonClient } from './garminPythonClient.ts';
import type { GarminSessionAuth } from './garminMcpClient.ts';

export type PlanPaces = {
  easy: string | null;
  steady: string | null;
  tempo: string | null;
  race: string | null;
};

export type PlanDayForWorkout = {
  date: string;
  title: string;
  intensity: 'suave' | 'medio' | 'alto' | 'recuperacion' | 'descanso' | 'carrera';
  distanceKm: number | null;
  notes: string;
};

type WorkoutPayload = Record<string, unknown>;

function parsePaceLabelToSeconds(pace: string | null): number | null {
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

function makeStep(
  stepOrder: number,
  stepTypeKey: 'warmup' | 'cooldown' | 'interval' | 'recovery',
  description: string,
  durationSeconds: number,
): Record<string, unknown> {
  const stepTypeMap = {
    warmup: { stepTypeId: 1, stepTypeKey: 'warmup', displayOrder: 1 },
    cooldown: { stepTypeId: 2, stepTypeKey: 'cooldown', displayOrder: 2 },
    interval: { stepTypeId: 3, stepTypeKey: 'interval', displayOrder: 3 },
    recovery: { stepTypeId: 4, stepTypeKey: 'recovery', displayOrder: 4 },
  } as const;

  return {
    type: 'ExecutableStepDTO',
    stepOrder,
    stepType: stepTypeMap[stepTypeKey],
    description,
    endCondition: {
      conditionTypeId: 2,
      conditionTypeKey: 'time',
      displayOrder: 2,
      displayable: true,
    },
    endConditionValue: durationSeconds,
    targetType: null,
    targetValueOne: null,
    targetValueTwo: null,
    targetValueUnit: null,
    zoneNumber: null,
    strokeType: {
      strokeTypeId: 0,
      strokeTypeKey: null,
      displayOrder: 0,
    },
    equipmentType: {
      equipmentTypeId: 0,
      equipmentTypeKey: null,
      displayOrder: 0,
    },
  };
}

function makeRepeatGroup(
  stepOrder: number,
  iterations: number,
  steps: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: 'RepeatGroupDTO',
    stepOrder,
    stepType: {
      stepTypeId: 6,
      stepTypeKey: 'repeat',
      displayOrder: 6,
    },
    numberOfIterations: iterations,
    workoutSteps: steps,
    endCondition: {
      conditionTypeId: 7,
      conditionTypeKey: 'iterations',
      displayOrder: 7,
      displayable: false,
    },
    endConditionValue: iterations,
    smartRepeat: false,
  };
}

function createRunningWorkoutPayload(
  workoutName: string,
  description: string,
  estimatedDurationInSecs: number,
  estimatedDistanceInMeters: number | null,
  workoutSteps: Array<Record<string, unknown>>,
): WorkoutPayload {
  return {
    workoutName,
    description,
    sportType: {
      sportTypeId: 1,
      sportTypeKey: 'running',
      displayOrder: 1,
    },
    estimatedDurationInSecs,
    estimatedDistanceInMeters,
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: {
          sportTypeId: 1,
          sportTypeKey: 'running',
          displayOrder: 1,
        },
        workoutSteps,
      },
    ],
    author: {},
  };
}

function buildSimpleRunWorkout(day: PlanDayForWorkout, paceLabel: string | null, defaultPaceSeconds: number) {
  const distanceKm = day.distanceKm ?? 0;
  const paceSeconds = parsePaceLabelToSeconds(paceLabel) ?? defaultPaceSeconds;
  const estimatedDurationInSecs = Math.max(900, Math.round(Math.max(distanceKm, 4) * paceSeconds));

  return createRunningWorkoutPayload(
    `${day.title} · ${day.date}`,
    `${day.notes}${paceLabel ? ` Ritmo de referencia: ${paceLabel}.` : ''}`,
    estimatedDurationInSecs,
    distanceKm ? Math.round(distanceKm * 1_000) : null,
    [
      makeStep(
        1,
        'interval',
        `${day.title}${paceLabel ? ` · ${paceLabel}` : ''}`,
        estimatedDurationInSecs,
      ),
    ],
  );
}

export function canSchedulePlanDay(day: PlanDayForWorkout): boolean {
  return day.intensity !== 'descanso' && day.intensity !== 'carrera' && !day.title.includes('Fuerza');
}

export function buildWorkoutFromPlanDay(day: PlanDayForWorkout, paces: PlanPaces): WorkoutPayload {
  const easySeconds = parsePaceLabelToSeconds(paces.easy) ?? 405;
  const steadySeconds = parsePaceLabelToSeconds(paces.steady) ?? 360;
  const tempoSeconds = parsePaceLabelToSeconds(paces.tempo) ?? 335;

  switch (day.title) {
    case 'Series largas':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `5 x 5' a ${paces.tempo ?? 'ritmo de tempo'} con 90" suaves. ${day.notes}`,
        2_700,
        null,
        [
          makeStep(1, 'warmup', `Calentamiento fácil · ${paces.easy ?? 'suave'}`, 600),
          makeRepeatGroup(2, 5, [
            makeStep(3, 'interval', `5' fuertes · ${paces.tempo ?? 'tempo'}`, 300),
            makeStep(4, 'recovery', '90" suaves', 90),
          ]),
          makeStep(5, 'cooldown', 'Vuelta a la calma', 600),
        ],
      );
    case 'Umbral en bloques':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `3 x 10' a ${paces.tempo ?? 'umbral'} con 2' suaves. ${day.notes}`,
        3_060,
        null,
        [
          makeStep(1, 'warmup', `12' fáciles · ${paces.easy ?? 'suave'}`, 720),
          makeRepeatGroup(2, 3, [
            makeStep(3, 'interval', `10' umbral · ${paces.tempo ?? 'tempo'}`, 600),
            makeStep(4, 'recovery', '2\' suaves', 120),
          ]),
          makeStep(5, 'cooldown', '10\' soltando', 600),
        ],
      );
    case 'Ritmo controlado':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `2 x 20' a ${paces.steady ?? 'ritmo sostenido'} con 3' suaves. ${day.notes}`,
        3_540,
        null,
        [
          makeStep(1, 'warmup', `12' fáciles · ${paces.easy ?? 'suave'}`, 720),
          makeRepeatGroup(2, 2, [
            makeStep(3, 'interval', `20' sostenidos · ${paces.steady ?? 'steady'}`, 1_200),
            makeStep(4, 'recovery', '3\' suaves', 180),
          ]),
          makeStep(5, 'cooldown', '10\' soltando', 600),
        ],
      );
    case 'Series de afinado':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `6 x 3' vivos con 2' suaves. ${day.notes}`,
        2_700,
        null,
        [
          makeStep(1, 'warmup', `10' fáciles · ${paces.easy ?? 'suave'}`, 600),
          makeRepeatGroup(2, 6, [
            makeStep(3, 'interval', `3' vivos · referencia ${(tempoSeconds - 8) / 60}:${String(Math.max(0, Math.round((tempoSeconds - 8) % 60))).padStart(2, '0')}/km`, 180),
            makeStep(4, 'recovery', '2\' suaves', 120),
          ]),
          makeStep(5, 'cooldown', '10\' soltando', 600),
        ],
      );
    case 'Ritmo objetivo':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `Bloque principal a ${paces.race ?? 'ritmo objetivo'}. ${day.notes}`,
        2_520,
        null,
        [
          makeStep(1, 'warmup', `12' fáciles · ${paces.easy ?? 'suave'}`, 720),
          makeStep(2, 'interval', `20' a ritmo objetivo · ${paces.race ?? 'objetivo'}`, 1_200),
          makeStep(3, 'cooldown', '10\' soltando', 600),
        ],
      );
    case 'VO2 controlado':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `8 x 2' vivos con 90" suaves. ${day.notes}`,
        2_460,
        null,
        [
          makeStep(1, 'warmup', `12' fáciles · ${paces.easy ?? 'suave'}`, 720),
          makeRepeatGroup(2, 8, [
            makeStep(3, 'interval', `2' vivos · ${paces.tempo ?? 'tempo'}`, 120),
            makeStep(4, 'recovery', '90" suaves', 90),
          ]),
          makeStep(5, 'cooldown', '9\' soltando', 540),
        ],
      );
    case 'Cambios de ritmo':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `6 x 3' vivos con 2' suaves. ${day.notes}`,
        2_700,
        null,
        [
          makeStep(1, 'warmup', `10' fáciles · ${paces.easy ?? 'suave'}`, 600),
          makeRepeatGroup(2, 6, [
            makeStep(3, 'interval', `3' controlados · ${paces.tempo ?? 'tempo'}`, 180),
            makeStep(4, 'recovery', '2\' suaves', 120),
          ]),
          makeStep(5, 'cooldown', '10\' soltando', 600),
        ],
      );
    case 'Umbral sostenido':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `3 x 12' a ${paces.tempo ?? 'umbral controlado'} con 2' suaves. ${day.notes}`,
        3_180,
        null,
        [
          makeStep(1, 'warmup', `12' fáciles · ${paces.easy ?? 'suave'}`, 720),
          makeRepeatGroup(2, 3, [
            makeStep(3, 'interval', `12' umbral · ${paces.tempo ?? 'tempo'}`, 720),
            makeStep(4, 'recovery', '2\' suaves', 120),
          ]),
          makeStep(5, 'cooldown', '10\' soltando', 600),
        ],
      );
    case 'Control de maratón':
    case 'Bloque objetivo':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `Bloque largo a ${paces.race ?? 'ritmo objetivo'}. ${day.notes}`,
        3_120,
        null,
        [
          makeStep(1, 'warmup', `15' fáciles · ${paces.easy ?? 'suave'}`, 900),
          makeStep(2, 'interval', `25' a ritmo objetivo · ${paces.race ?? 'objetivo'}`, 1_500),
          makeStep(3, 'cooldown', '12\' soltando', 720),
        ],
      );
    case 'Afinado corto':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `Rodaje breve + rectas para afinar. ${day.notes}`,
        1_680,
        null,
        [
          makeStep(1, 'interval', `18' fáciles · ${paces.easy ?? 'suave'}`, 1_080),
          makeRepeatGroup(2, 6, [
            makeStep(3, 'interval', '20" progresivos', 20),
            makeStep(4, 'recovery', '40" muy suaves', 40),
          ]),
          makeStep(5, 'cooldown', '4\' soltando', 240),
        ],
      );
    case 'Tempo progresivo':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `15' steady + 10' tempo. ${day.notes}`,
        2_700,
        null,
        [
          makeStep(1, 'warmup', `10' fáciles · ${paces.easy ?? 'suave'}`, 600),
          makeStep(2, 'interval', `15' steady · ${paces.steady ?? 'steady'}`, 900),
          makeStep(3, 'interval', `10' tempo · ${paces.tempo ?? 'tempo'}`, 600),
          makeStep(4, 'cooldown', '10\' soltando', 600),
        ],
      );
    case 'Rodaje controlado':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `Rodaje controlado acabando cerca de ${paces.race ?? 'ritmo objetivo'}. ${day.notes}`,
        2_700,
        null,
        [
          makeStep(1, 'warmup', `12' fáciles · ${paces.easy ?? 'suave'}`, 720),
          makeStep(2, 'interval', `18' steady · ${paces.steady ?? 'steady'}`, 1_080),
          makeStep(3, 'interval', `8' final cerca de ${paces.race ?? 'ritmo objetivo'}`, 480),
          makeStep(4, 'cooldown', '7\' soltando', 420),
        ],
      );
    case 'Tempo corto':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `10' tempo corto con soltura. ${day.notes}`,
        2_100,
        null,
        [
          makeStep(1, 'warmup', `10' fáciles · ${paces.easy ?? 'suave'}`, 600),
          makeStep(2, 'interval', `10' tempo · ${paces.tempo ?? 'tempo'}`, 600),
          makeStep(3, 'cooldown', '15\' soltando', 900),
        ],
      );
    case 'Toque fino':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `Rodaje breve + rectas para afinar. ${day.notes}`,
        2_100,
        null,
        [
          makeStep(1, 'interval', `20' fáciles · ${paces.easy ?? 'suave'}`, 1_200),
          makeRepeatGroup(2, 4, [
            makeStep(3, 'interval', '1\' ágil', 60),
            makeStep(4, 'recovery', '1\' muy suave', 60),
          ]),
          makeStep(5, 'cooldown', '10\' soltando', 600),
        ],
      );
    case 'Activación':
      return createRunningWorkoutPayload(
        `${day.title} · ${day.date}`,
        `Activación pre-carrera. ${day.notes}`,
        1_680,
        null,
        [
          makeStep(1, 'interval', `20' fáciles · ${paces.easy ?? 'suave'}`, 1_200),
          makeRepeatGroup(2, 5, [
            makeStep(3, 'interval', '20" progresivos', 20),
            makeStep(4, 'recovery', '40" muy suaves', 40),
          ]),
          makeStep(5, 'cooldown', '5\' soltando', 300),
        ],
      );
    case 'Tirada larga':
      return buildSimpleRunWorkout(day, paces.easy, easySeconds);
    case 'Recuperación activa':
      return buildSimpleRunWorkout(day, paces.easy, easySeconds);
    case 'Suave + técnica':
      return buildSimpleRunWorkout(day, paces.easy, easySeconds);
    case 'Rodaje suave':
      return buildSimpleRunWorkout(day, paces.easy, easySeconds);
    case 'Control':
      return buildSimpleRunWorkout(day, paces.steady, steadySeconds);
    default:
      if (day.intensity === 'alto') {
        return buildSimpleRunWorkout(day, paces.tempo, tempoSeconds);
      }
      if (day.intensity === 'medio') {
        return buildSimpleRunWorkout(day, paces.steady ?? paces.race, steadySeconds);
      }
      return buildSimpleRunWorkout(day, paces.easy, easySeconds);
  }
}

export async function schedulePlanWorkoutOnGarmin(
  auth: GarminSessionAuth,
  day: PlanDayForWorkout,
  paces: PlanPaces,
): Promise<{ workoutId: number | null; uploaded: unknown; scheduled: unknown }> {
  const workout = buildWorkoutFromPlanDay(day, paces);
  return garminPythonClient.callJson<{ workoutId: number | null; uploaded: unknown; scheduled: unknown }>(
    'upload_and_schedule_workout',
    {
      date: day.date,
      workout,
    },
    {
      HOME: auth.homeDir,
      GARMIN_EMAIL: auth.garminEmail,
      GARMIN_PASSWORD: auth.garminPassword,
      GARMINTOKENS: auth.tokenDirs.python,
    },
  );
}
