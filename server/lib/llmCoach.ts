import crypto from 'node:crypto';
import { config } from '../config.ts';
import type { DashboardData } from './dashboard.ts';
import type { DailyCheckInRecord, PersistedCoachState } from './userStateStore.ts';

type CoachWeekAdjustment = {
  weekIndex: number;
  targetKmDelta: number;
  focus: string | null;
  coachNote: string | null;
};

type CoachWeeklyReview = {
  headline: string;
  summary: string;
  status: 'protect' | 'steady' | 'push';
  nextMove: string;
};

type CoachLatestDebrief = {
  runId: number;
  runName: string;
  summary: string;
  nextStep: string;
  generatedAt: string;
};

export type CoachSnapshot = {
  source: 'gemma4' | 'fallback';
  model: string | null;
  generatedAt: string;
  fitnessTitle: string;
  fitnessBody: string;
  planSummary: string;
  todayMessage: string | null;
  weeklyReview: CoachWeeklyReview | null;
  latestDebrief: CoachLatestDebrief | null;
  weekAdjustments: CoachWeekAdjustment[];
};

type LlmPayload = {
  fitnessTitle?: string;
  fitnessBody?: string;
  planSummary?: string;
  todayMessage?: string | null;
  weeklyReview?: {
    headline?: string;
    summary?: string;
    status?: 'protect' | 'steady' | 'push';
    nextMove?: string;
  };
  latestDebrief?: {
    runId?: number;
    runName?: string;
    summary?: string;
    nextStep?: string;
  };
  weekAdjustments?: Array<{
    weekIndex?: number;
    targetKmDelta?: number;
    focus?: string;
    coachNote?: string;
  }>;
};

type WhatIfScenarioInput = {
  raceDate: string;
  distanceKm: number;
  availableDays: number | null;
  maxWeeklyKm: number | null;
  note: string | null;
};

export type WhatIfScenario = {
  headline: string;
  summary: string;
  risk: 'low' | 'medium' | 'high';
  adjustments: string[];
  recommendedGoal: {
    raceDate: string;
    distanceKm: number;
  };
};

type ToolCallPlan = {
  answer?: string;
  toolCalls?: Array<{
    name?: string;
    args?: Record<string, unknown>;
  }>;
};

export function llmEnabled() {
  return Boolean(config.llmBaseUrl && config.llmModel && config.llmProvider);
}

function latestCheckIn(checkIns: DailyCheckInRecord[]) {
  return checkIns[0] ?? null;
}

function clipText(value: string, maxLength: number) {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildCoachInputHash(dashboard: DashboardData, checkIns: DailyCheckInRecord[]) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        provider: dashboard.provider.key,
        goal: dashboard.goal,
        overview: {
          predictedGoalSeconds: dashboard.overview.predictedGoalSeconds,
          readiness: dashboard.overview.readiness,
          sleepHours: dashboard.overview.sleepHours,
          hrv: dashboard.overview.hrv,
          averageWeeklyKm: dashboard.overview.averageWeeklyKm,
          longestRunKm: dashboard.overview.longestRunKm,
        },
        adaptive: dashboard.adaptive,
        recentRuns: dashboard.recentRuns.slice(0, 5).map((run) => ({
          id: run.id,
          date: run.date,
          distanceKm: run.distanceKm,
          paceSecondsPerKm: run.paceSecondsPerKm,
          trainingLoad: run.trainingLoad,
        })),
        weeks: dashboard.plan.weeks.slice(0, 3).map((week) => ({
          title: week.title,
          focus: week.focus,
          targetKm: week.targetKm,
        })),
        checkIns: checkIns.slice(0, 3),
      }),
    )
    .digest('hex');
}

function formatCheckInSignals(checkIn: DailyCheckInRecord | null) {
  if (!checkIn) {
    return {
      todayMessage: 'Falta tu check-in de hoy. Completarlo ayuda a afinar mejor el tono del plan.',
      fitnessBodyExtra: 'Hoy todavía no hay lectura subjetiva de energía, piernas y cabeza.',
      targetKmDelta: 0,
    };
  }

  const heavyState = checkIn.energy === 'low' || checkIn.legs === 'heavy' || checkIn.mood === 'flat';
  const positiveState = checkIn.energy === 'high' && checkIn.legs === 'fresh' && checkIn.mood === 'great';

  if (heavyState) {
    return {
      todayMessage: 'Hoy la señal subjetiva viene más tocada. Conviene priorizar control, llegar fresco y no añadir épica.',
      fitnessBodyExtra: 'Tu check-in de hoy sugiere energía justa o piernas cargadas, así que el ajuste debe ir hacia absorber.',
      targetKmDelta: -2,
    };
  }

  if (positiveState) {
    return {
      todayMessage: 'Hoy llegas con buena energía y piernas frescas. Hay margen para consolidar la semana sin pasarte.',
      fitnessBodyExtra: 'La percepción subjetiva de hoy acompaña a los datos, así que se puede tensar un poco sin salir del guion.',
      targetKmDelta: 1,
    };
  }

  return {
    todayMessage: 'La sensación de hoy es bastante neutra. Mantén el plan con control y usa la siguiente sesión para confirmar tendencia.',
    fitnessBodyExtra: 'El check-in de hoy no pide cambios agresivos; mejor continuidad y ritmo controlado.',
    targetKmDelta: 0,
  };
}

function normalizeRiskLevel(value: unknown): WhatIfScenario['risk'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function buildFallbackWeeklyReview(dashboard: DashboardData, checkIn: DailyCheckInRecord | null): CoachWeeklyReview {
  const status = dashboard.adaptive.overall;
  const headline =
    status === 'protect'
      ? 'Semana para absorber'
      : status === 'push'
        ? 'Semana con margen'
        : 'Semana de consolidación';

  const summary =
    status === 'protect'
      ? 'Baja ruido, asimila la carga y evita meter épica donde no toca.'
      : status === 'push'
        ? 'Las señales acompañan. Puedes sostener la calidad sin abrir demasiado el volumen.'
        : 'El bloque va razonable. Gana por continuidad y por salir fresco de la sesión clave.';

  const nextMove =
    checkIn?.legs === 'heavy' || checkIn?.energy === 'low'
      ? 'Afloja la siguiente calidad'
      : status === 'push'
        ? 'Consolida y llega entero'
        : 'Mantén volumen y control';

  return {
    headline: clipText(headline, 42),
    summary: clipText(summary, 92),
    status,
    nextMove: clipText(nextMove, 36),
  };
}

function buildFallbackLatestDebrief(dashboard: DashboardData): CoachLatestDebrief | null {
  const latestRun = dashboard.recentRuns[0] ?? null;
  if (!latestRun) {
    return null;
  }

  const pace = latestRun.paceSecondsPerKm ? `a ${Math.round(latestRun.paceSecondsPerKm)} s/km` : 'sin ritmo fiable';
  const trainingEffect = latestRun.trainingEffect !== null ? `TE ${latestRun.trainingEffect.toFixed(1)}` : 'sin TE';
  const summary = `${latestRun.distanceKm.toFixed(1)} km ${pace}. ${trainingEffect}.`;
  const nextStep =
    dashboard.adaptive.overall === 'protect'
      ? 'Recupera antes de volver a tensar.'
      : dashboard.adaptive.overall === 'push'
        ? 'Úsalo como base para la siguiente sesión clave.'
        : 'Mantén control y continuidad.';

  return {
    runId: latestRun.id,
    runName: latestRun.name,
    summary: clipText(summary, 72),
    nextStep: clipText(nextStep, 52),
    generatedAt: new Date().toISOString(),
  };
}

function buildFallbackCoachSnapshot(dashboard: DashboardData, checkIns: DailyCheckInRecord[]): CoachSnapshot {
  const latest = latestCheckIn(checkIns);
  const signals = formatCheckInSignals(latest);
  const generatedAt = new Date().toISOString();
  const overall =
    dashboard.adaptive.overall === 'protect'
      ? 'protección'
      : dashboard.adaptive.overall === 'push'
        ? 'progresión'
        : 'consolidación';
  const firstWeek = dashboard.plan.weeks[0];
  const weekAdjustments: CoachWeekAdjustment[] = firstWeek
    ? [
        {
          weekIndex: 0,
          targetKmDelta: signals.targetKmDelta,
          focus:
            signals.targetKmDelta < 0
              ? 'absorber la carga reciente'
              : signals.targetKmDelta > 0
                ? 'consolidar sin perder frescura'
                : firstWeek.focus,
          coachNote: signals.todayMessage,
        },
      ]
    : [];

  return {
    source: 'fallback',
    model: null,
    generatedAt,
    fitnessTitle:
      latest?.energy === 'low' || latest?.legs === 'heavy'
        ? 'Hoy toca apretar menos y asimilar mejor'
        : latest?.energy === 'high' && latest?.legs === 'fresh'
          ? 'La semana admite un punto más de calidad'
          : dashboard.fitnessSummary.title,
    fitnessBody: clipText(
      `${dashboard.fitnessSummary.body} ${signals.fitnessBodyExtra} Estado global actual: ${overall}.`,
      140,
    ),
    planSummary: clipText(
      `${dashboard.plan.summary} Ajuste subjetivo de hoy: ${signals.todayMessage}`,
      150,
    ),
    todayMessage: clipText(signals.todayMessage, 66),
    weeklyReview: buildFallbackWeeklyReview(dashboard, latest),
    latestDebrief: buildFallbackLatestDebrief(dashboard),
    weekAdjustments,
  };
}

function buildPrompt(dashboard: DashboardData, checkIns: DailyCheckInRecord[]) {
  return `
Eres un entrenador de running pragmático. Trabajas sobre un plan YA calculado y NO debes rehacerlo entero.
Tu trabajo es:
1. Reescribir el resumen fitness.
2. Reescribir el resumen del plan.
3. Dar un mensaje corto para hoy.
4. Generar una revisión semanal MUY corta.
5. Generar un debrief MUY corto del último entreno si existe.
6. Ajustar como mucho 3 semanas con cambios suaves de foco y delta de km.

Restricciones:
- No cambies fechas.
- No inventes métricas.
- targetKmDelta debe estar entre -3 y 3.
- Si la señal subjetiva es mala, protege.
- Si el plan ya está en modo protect, no propongas subir km.
- Sé muy sintético. Nada de párrafos largos.
- fitnessBody <= 2 frases.
- planSummary <= 2 frases.
- todayMessage <= 1 frase.
- weeklyReview.summary <= 1 frase.
- latestDebrief.summary <= 1 frase.
- Responde SOLO JSON válido.

JSON esperado:
{
  "fitnessTitle": "string corto",
  "fitnessBody": "string",
  "planSummary": "string",
  "todayMessage": "string",
  "weeklyReview": {
    "headline": "string corto",
    "summary": "string corto",
    "status": "protect|steady|push",
    "nextMove": "string corto"
  },
  "latestDebrief": {
    "runId": 0,
    "runName": "string",
    "summary": "string corto",
    "nextStep": "string corto"
  },
  "weekAdjustments": [
    { "weekIndex": 0, "targetKmDelta": -1, "focus": "string", "coachNote": "string" }
  ]
}

Contexto:
${JSON.stringify({
    provider: dashboard.provider,
    goal: dashboard.goal,
    overview: dashboard.overview,
    fitnessSummary: dashboard.fitnessSummary,
    adaptive: dashboard.adaptive,
    latestCheckIn: latestCheckIn(checkIns),
    recentRuns: dashboard.recentRuns.slice(0, 5),
    plan: {
      summary: dashboard.plan.summary,
      weeks: dashboard.plan.weeks.slice(0, 3).map((week, weekIndex) => ({
        weekIndex,
        title: week.title,
        focus: week.focus,
        targetKm: week.targetKm,
        days: week.days.map((day) => ({
          date: day.date,
          title: day.title,
          intensity: day.intensity,
          distanceKm: day.distanceKm,
          notes: day.notes,
        })),
      })),
    },
  })}
`.trim();
}

async function callOllama(prompt: string, options: { json?: boolean } = {}): Promise<string> {
  const response = await fetch(new URL('/api/generate', config.llmBaseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llmModel,
      prompt,
      stream: false,
      ...(options.json ? { format: 'json' } : {}),
      options: {
        temperature: 0.2,
      },
    }),
  });

  const payload = (await response.json()) as { response?: string };
  if (!response.ok || typeof payload.response !== 'string') {
    throw new Error('Ollama no ha devuelto una respuesta válida.');
  }

  return payload.response;
}

async function callOpenAiCompatible(prompt: string, options: { json?: boolean } = {}): Promise<string> {
  const headers = new Headers({
    'Content-Type': 'application/json',
  });
  if (config.llmApiKey) {
    headers.set('Authorization', `Bearer ${config.llmApiKey}`);
  }

  const response = await fetch(new URL('/chat/completions', config.llmBaseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.llmModel,
      temperature: 0.2,
      ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        {
          role: 'system',
          content: options.json
            ? 'Eres un entrenador de running que responde JSON estricto.'
            : 'Eres un entrenador de running pragmático. Respondes en español, breve, concreto y sin inventar datos.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;

  if (!response.ok || typeof content !== 'string') {
    throw new Error('El endpoint OpenAI-compatible no ha devuelto contenido utilizable.');
  }

  return content;
}

function sanitizeWeekAdjustments(payload: LlmPayload['weekAdjustments']): CoachWeekAdjustment[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((item) => {
      const weekIndex = Number(item.weekIndex);
      const targetKmDelta = Number(item.targetKmDelta ?? 0);
      if (!Number.isInteger(weekIndex) || weekIndex < 0 || weekIndex > 5) {
        return null;
      }

      return {
        weekIndex,
        targetKmDelta: Math.max(-3, Math.min(3, Number.isFinite(targetKmDelta) ? Math.round(targetKmDelta) : 0)),
        focus: typeof item.focus === 'string' && item.focus.trim() ? clipText(item.focus, 90) : null,
        coachNote:
          typeof item.coachNote === 'string' && item.coachNote.trim()
            ? clipText(item.coachNote, 96)
            : null,
      };
    })
    .filter((item): item is CoachWeekAdjustment => item !== null)
    .slice(0, 3);
}

function sanitizeWeeklyReview(payload: LlmPayload['weeklyReview'], fallback: CoachWeeklyReview | null) {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const headline =
    typeof payload.headline === 'string' && payload.headline.trim()
      ? clipText(payload.headline, 38)
      : fallback?.headline ?? 'Lectura semanal';
  const summary =
    typeof payload.summary === 'string' && payload.summary.trim()
      ? clipText(payload.summary, 82)
      : fallback?.summary ?? 'Sin revisión adicional.';
  const nextMove =
    typeof payload.nextMove === 'string' && payload.nextMove.trim()
      ? clipText(payload.nextMove, 34)
      : fallback?.nextMove ?? 'Mantén control.';

  return {
    headline,
    summary,
    status:
      payload.status === 'protect' || payload.status === 'steady' || payload.status === 'push'
        ? payload.status
        : fallback?.status ?? 'steady',
    nextMove,
  };
}

function sanitizeLatestDebrief(
  payload: LlmPayload['latestDebrief'],
  fallback: CoachLatestDebrief | null,
): CoachLatestDebrief | null {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const fallbackRunId = fallback?.runId ?? 0;
  const runId = Number(payload.runId ?? fallbackRunId);
  const runName =
    typeof payload.runName === 'string' && payload.runName.trim()
      ? clipText(payload.runName, 70)
      : fallback?.runName ?? null;
  const summary =
    typeof payload.summary === 'string' && payload.summary.trim()
      ? clipText(payload.summary, 64)
      : fallback?.summary ?? null;
  const nextStep =
    typeof payload.nextStep === 'string' && payload.nextStep.trim()
      ? clipText(payload.nextStep, 44)
      : fallback?.nextStep ?? null;

  if (!Number.isInteger(runId) || runId <= 0 || !runName || !summary || !nextStep) {
    return fallback;
  }

  return {
    runId,
    runName,
    summary,
    nextStep,
    generatedAt: fallback?.generatedAt ?? new Date().toISOString(),
  };
}

function parseCoachPayload(raw: string, fallback: CoachSnapshot): CoachSnapshot {
  const parsed = JSON.parse(raw) as LlmPayload;
  return {
    source: 'gemma4',
    model: config.llmModel,
    generatedAt: new Date().toISOString(),
    fitnessTitle:
      typeof parsed.fitnessTitle === 'string' && parsed.fitnessTitle.trim()
        ? clipText(parsed.fitnessTitle, 80)
        : fallback.fitnessTitle,
    fitnessBody:
      typeof parsed.fitnessBody === 'string' && parsed.fitnessBody.trim()
        ? clipText(parsed.fitnessBody, 140)
        : fallback.fitnessBody,
    planSummary:
      typeof parsed.planSummary === 'string' && parsed.planSummary.trim()
        ? clipText(parsed.planSummary, 150)
        : fallback.planSummary,
    todayMessage:
      typeof parsed.todayMessage === 'string' && parsed.todayMessage.trim()
        ? clipText(parsed.todayMessage, 66)
        : fallback.todayMessage,
    weeklyReview: sanitizeWeeklyReview(parsed.weeklyReview, fallback.weeklyReview),
    latestDebrief: sanitizeLatestDebrief(parsed.latestDebrief, fallback.latestDebrief),
    weekAdjustments: sanitizeWeekAdjustments(parsed.weekAdjustments),
  };
}

export async function generateCoachSnapshot(input: {
  dashboard: DashboardData;
  checkIns: DailyCheckInRecord[];
  persistedState: PersistedCoachState | null;
  forceRegenerate?: boolean;
}): Promise<{ snapshot: CoachSnapshot; inputHash: string }> {
  const inputHash = buildCoachInputHash(input.dashboard, input.checkIns);
  const fallback = buildFallbackCoachSnapshot(input.dashboard, input.checkIns);
  const forceRegenerate = input.forceRegenerate ?? false;

  if (!forceRegenerate && input.persistedState?.inputHash === inputHash) {
    try {
      const snapshot = JSON.parse(input.persistedState.snapshotJson) as CoachSnapshot;
      return {
        snapshot,
        inputHash,
      };
    } catch {
      // Recompute below.
    }
  }

  if (
    !forceRegenerate &&
    input.persistedState &&
    Date.now() - new Date(input.persistedState.generatedAt).getTime() < config.llmMinIntervalMs &&
    input.persistedState.snapshotJson
  ) {
    return {
      snapshot: fallback,
      inputHash,
    };
  }

  if (!llmEnabled()) {
    return {
      snapshot: fallback,
      inputHash,
    };
  }

  try {
    const prompt = buildPrompt(input.dashboard, input.checkIns);
    const raw =
      config.llmProvider === 'ollama'
        ? await callOllama(prompt, { json: true })
        : await callOpenAiCompatible(prompt, { json: true });
    return {
      snapshot: parseCoachPayload(raw, fallback),
      inputHash,
    };
  } catch {
    return {
      snapshot: fallback,
      inputHash,
    };
  }
}

export function applyCoachSnapshotToDashboard(input: {
  dashboard: DashboardData;
  checkIns: DailyCheckInRecord[];
  snapshot: CoachSnapshot;
}): DashboardData {
  const latest = latestCheckIn(input.checkIns);
  const adjustedWeeks = input.dashboard.plan.weeks.map((week, weekIndex) => {
    const adjustment = input.snapshot.weekAdjustments.find((item) => item.weekIndex === weekIndex) ?? null;
    const targetKm =
      adjustment && typeof week.targetKm === 'number'
        ? Math.max(0, Math.round((week.targetKm + adjustment.targetKmDelta) * 10) / 10)
        : week.targetKm;
    const focus = adjustment?.focus ?? week.focus;
    const coachNote = adjustment?.coachNote ?? null;

    return {
      ...week,
      focus,
      targetKm,
      coachNote,
      days: coachNote
        ? week.days.map((day, dayIndex) =>
            dayIndex === 0
              ? {
                  ...day,
                  notes: `${day.notes} ${coachNote}`,
                }
              : day,
          )
        : week.days,
    };
  });

  return {
    ...input.dashboard,
    fitnessSummary: {
      title: input.snapshot.fitnessTitle,
      body: input.snapshot.fitnessBody,
    },
    checkIn: {
      needsToday:
        !latest || latest.date !== new Date(input.dashboard.fetchedAt).toISOString().slice(0, 10),
      latest,
      recent: input.checkIns,
    },
    coach: {
      enabled: llmEnabled(),
      source: input.snapshot.source,
      model: input.snapshot.model,
      generatedAt: input.snapshot.generatedAt,
      todayMessage: input.snapshot.todayMessage,
      weeklyReview: input.snapshot.weeklyReview,
      latestDebrief: input.snapshot.latestDebrief,
    },
    plan: {
      ...input.dashboard.plan,
      summary: input.snapshot.planSummary,
      weeks: adjustedWeeks,
    },
  };
}

function callModel(prompt: string, options: { json?: boolean } = {}) {
  return config.llmProvider === 'ollama'
    ? callOllama(prompt, options)
    : callOpenAiCompatible(prompt, options);
}

function recentRunsWithinDays(dashboard: DashboardData, days: number, limit = 5) {
  const now = new Date(dashboard.fetchedAt).getTime();
  const cutoff = now - Math.max(1, days) * 24 * 60 * 60 * 1_000;
  return dashboard.recentRuns
    .filter((run) => {
      const timestamp = new Date(`${run.date}T00:00:00`).getTime();
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    })
    .slice(0, limit);
}

function buildCoachToolCatalog() {
  return [
    { name: 'get_overview', description: 'Resumen actual de métricas clave del dashboard.', args: {} },
    {
      name: 'get_recent_runs',
      description: 'Últimos rodajes filtrados por ventana temporal.',
      args: { days: 'number', limit: 'number opcional' },
    },
    {
      name: 'get_plan_week',
      description: 'Semana concreta del plan.',
      args: { weekIndex: 'number' },
    },
    {
      name: 'get_checkins',
      description: 'Check-ins subjetivos recientes.',
      args: { days: 'number opcional' },
    },
    {
      name: 'get_weekly_running',
      description: 'Bloques semanales recientes de km, horas y número de rodajes.',
      args: { weeks: 'number opcional' },
    },
    {
      name: 'get_latest_run',
      description: 'Último entreno registrado.',
      args: {},
    },
    {
      name: 'get_adaptive',
      description: 'Lectura adaptativa actual: volumen, ritmo y recuperación.',
      args: {},
    },
  ];
}

function executeCoachTool(input: {
  dashboard: DashboardData;
  checkIns: DailyCheckInRecord[];
}, toolName: string, rawArgs: Record<string, unknown> | undefined) {
  const args = rawArgs ?? {};

  switch (toolName) {
    case 'get_overview':
      return {
        goal: input.dashboard.goal,
        overview: input.dashboard.overview,
        provider: input.dashboard.provider,
      };
    case 'get_recent_runs': {
      const days = Number(args.days ?? 14);
      const limit = Number(args.limit ?? 4);
      return recentRunsWithinDays(input.dashboard, Number.isFinite(days) ? days : 14, Number.isFinite(limit) ? limit : 4);
    }
    case 'get_plan_week': {
      const weekIndex = Number(args.weekIndex ?? 0);
      const week = input.dashboard.plan.weeks[Math.max(0, Math.min(input.dashboard.plan.weeks.length - 1, Number.isFinite(weekIndex) ? weekIndex : 0))];
      return week
        ? {
            title: week.title,
            focus: week.focus,
            targetKm: week.targetKm,
            coachNote: week.coachNote ?? null,
            days: week.days.map((day) => ({
              date: day.date,
              title: day.title,
              intensity: day.intensity,
              distanceKm: day.distanceKm,
              notes: day.notes,
              status: day.status,
            })),
          }
        : null;
    }
    case 'get_checkins': {
      const days = Number(args.days ?? 7);
      return input.checkIns.slice(0, Math.max(1, Math.min(7, Number.isFinite(days) ? days : 7)));
    }
    case 'get_weekly_running': {
      const weeks = Number(args.weeks ?? 4);
      return input.dashboard.weeklyRunning.slice(-Math.max(1, Math.min(6, Number.isFinite(weeks) ? weeks : 4)));
    }
    case 'get_latest_run':
      return input.dashboard.recentRuns[0] ?? null;
    case 'get_adaptive':
      return {
        primaryNeed: input.dashboard.adaptive.primaryNeed,
        overall: input.dashboard.adaptive.overall,
        volume: input.dashboard.adaptive.volume,
        pace: input.dashboard.adaptive.pace,
        recovery: input.dashboard.adaptive.recovery,
        signals: input.dashboard.adaptive.signals,
      };
    default:
      return {
        error: `Tool ${toolName} no soportada.`,
      };
  }
}

function buildToolSelectionPrompt(input: {
  dashboard: DashboardData;
  checkIns: DailyCheckInRecord[];
  question: string;
}) {
  return `
Eres Race Room Coach.
Decide si necesitas herramientas antes de responder.
Devuelve SOLO JSON válido con esta forma:
{
  "toolCalls": [{ "name": "string", "args": {} }],
  "answer": "string o null"
}

Reglas:
- Usa como máximo 2 tools.
- Si puedes responder con seguridad sin tools, deja toolCalls vacío y da la respuesta final.
- La respuesta final debe ser muy breve: máximo 2 frases.
- Máximo 45 palabras.
- No inventes datos.

Contexto base:
${JSON.stringify({
    provider: input.dashboard.provider,
    goal: input.dashboard.goal,
    fitnessSummary: input.dashboard.fitnessSummary,
    coach: input.dashboard.coach,
    latestCheckIn: latestCheckIn(input.checkIns),
    recentRuns: input.dashboard.recentRuns.slice(0, 2).map((run) => ({
      id: run.id,
      name: run.name,
      date: run.date,
      distanceKm: run.distanceKm,
      paceSecondsPerKm: run.paceSecondsPerKm,
    })),
  })}

Tools disponibles:
${JSON.stringify(buildCoachToolCatalog())}

Pregunta:
${input.question}
`.trim();
}

function buildToolAnswerPrompt(input: {
  dashboard: DashboardData;
  checkIns: DailyCheckInRecord[];
  question: string;
  toolResults: Array<{ name: string; result: unknown }>;
}) {
  return `
Eres Race Room Coach.
Responde en español, muy claro y muy corto.
Reglas:
- Máximo 2 frases.
- Máximo 40 palabras.
- Ve directo al consejo.
- Si falta una métrica, dilo en una frase corta.
- No reescribas todo el plan.

Contexto base:
${JSON.stringify({
    goal: input.dashboard.goal,
    coach: input.dashboard.coach,
    latestCheckIn: latestCheckIn(input.checkIns),
  })}

Resultados de herramientas:
${JSON.stringify(input.toolResults)}

Pregunta:
${input.question}
`.trim();
}

function buildChatFallback(input: {
  dashboard: DashboardData;
  checkIns: DailyCheckInRecord[];
  question: string;
}) {
  const latest = latestCheckIn(input.checkIns);
  const energy = latest ? `${latest.energy} · ${latest.legs} · ${latest.mood}` : 'sin check-in';
  return clipText(
    `${input.dashboard.coach.todayMessage ?? 'Sin alerta fuerte hoy.'} Estado: ${energy}. ` +
      `Puedo responder con contexto base, pero no abrir más de lo que ya ve el dashboard.`,
    120,
  );
}

function parseToolPlan(raw: string): ToolCallPlan {
  const parsed = JSON.parse(raw) as ToolCallPlan;
  return {
    answer: typeof parsed.answer === 'string' && parsed.answer.trim() ? parsed.answer.trim() : undefined,
    toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls.slice(0, 2) : [],
  };
}

export async function answerCoachQuestion(input: {
  dashboard: DashboardData;
  checkIns: DailyCheckInRecord[];
  question: string;
}): Promise<string> {
  const fallback = buildChatFallback(input);

  if (!llmEnabled()) {
    return fallback;
  }

  try {
    const planRaw = await callModel(buildToolSelectionPrompt(input), { json: true });
    const plan = parseToolPlan(planRaw);

    if (plan.answer && (!plan.toolCalls || plan.toolCalls.length === 0)) {
      return clipText(plan.answer, 120);
    }

    const toolResults = (plan.toolCalls ?? []).map((toolCall) => ({
      name: typeof toolCall.name === 'string' ? toolCall.name : 'unknown',
      result: executeCoachTool(input, typeof toolCall.name === 'string' ? toolCall.name : 'unknown', toolCall.args),
    }));

    const raw = await callModel(buildToolAnswerPrompt({
      ...input,
      toolResults,
    }));
    return clipText(raw, 120);
  } catch {
    return fallback;
  }
}

function buildWhatIfFallback(input: {
  dashboard: DashboardData;
  scenario: WhatIfScenarioInput;
}): WhatIfScenario {
  const currentDaysToRace = input.dashboard.goal.daysToRace;
  const scenarioDaysToRace = Math.max(
    0,
    Math.round((new Date(input.scenario.raceDate).getTime() - new Date(input.dashboard.fetchedAt).getTime()) / 86_400_000),
  );
  const distanceDelta = input.scenario.distanceKm - input.dashboard.goal.distanceKm;
  const averageWeeklyKm = input.dashboard.overview.averageWeeklyKm ?? input.dashboard.adaptive.signals.recent7Km;
  const risk =
    (input.scenario.availableDays !== null && input.scenario.availableDays <= 3 && input.scenario.distanceKm >= 21.1) ||
    (input.scenario.maxWeeklyKm !== null && input.scenario.maxWeeklyKm < averageWeeklyKm * 0.8) ||
    (distanceDelta > 0 && scenarioDaysToRace < currentDaysToRace)
      ? 'high'
      : scenarioDaysToRace > currentDaysToRace + 10 || distanceDelta < 0
        ? 'low'
        : 'medium';

  const adjustments = [
    input.scenario.availableDays !== null
      ? `Bloquea ${input.scenario.availableDays} días útiles: larga, calidad y un rodaje soporte.`
      : 'Mantén la tirada larga y la sesión clave como anclas.',
    input.scenario.maxWeeklyKm !== null
      ? `Cap semanal: ${input.scenario.maxWeeklyKm.toFixed(0)} km. Recorta relleno antes que la calidad útil.`
      : 'El volumen puede seguir progresando con control.',
    distanceDelta > 0
      ? 'Sube la especificidad y protege más la recuperación.'
      : distanceDelta < 0
        ? 'Puedes afilar ritmo y bajar un poco la tirada larga.'
        : 'Mantén el foco del objetivo actual.',
  ];

  return {
    headline:
      risk === 'high'
        ? 'Escenario exigente'
        : risk === 'low'
          ? 'Escenario asumible'
          : 'Escenario viable con control',
    summary:
      risk === 'high'
        ? 'Se puede intentar, pero obliga a recortar ruido y priorizar recuperación.'
        : risk === 'low'
          ? 'Encaja bien con tu base actual y no pide cambios agresivos.'
          : 'Es viable si ordenas bien la semana y no regalas carga.',
    risk,
    adjustments: adjustments.map((item) => clipText(item, 110)),
    recommendedGoal: {
      raceDate: input.scenario.raceDate,
      distanceKm: input.scenario.distanceKm,
    },
  };
}

function buildWhatIfPrompt(input: {
  dashboard: DashboardData;
  scenario: WhatIfScenarioInput;
}) {
  return `
Eres Race Room Coach.
Valora un escenario what-if para un corredor.
Responde SOLO JSON válido:
{
  "headline": "string corto",
  "summary": "string corto",
  "risk": "low|medium|high",
  "adjustments": ["string corto", "string corto", "string corto"]
}

Reglas:
- Muy breve.
- Máximo 3 ajustes.
- No inventes métricas.
- Si el escenario aprieta demasiado, dilo claro.

Contexto actual:
${JSON.stringify({
    goal: input.dashboard.goal,
    overview: input.dashboard.overview,
    adaptive: input.dashboard.adaptive,
    weeklyRunning: input.dashboard.weeklyRunning.slice(-4),
    recentRuns: input.dashboard.recentRuns.slice(0, 3),
  })}

Escenario:
${JSON.stringify(input.scenario)}
`.trim();
}

export async function planWhatIfScenario(input: {
  dashboard: DashboardData;
  scenario: WhatIfScenarioInput;
}): Promise<WhatIfScenario> {
  const fallback = buildWhatIfFallback(input);

  if (!llmEnabled()) {
    return fallback;
  }

  try {
    const raw = await callModel(buildWhatIfPrompt(input), { json: true });
    const parsed = JSON.parse(raw) as {
      headline?: string;
      summary?: string;
      risk?: WhatIfScenario['risk'];
      adjustments?: string[];
    };

    return {
      headline:
        typeof parsed.headline === 'string' && parsed.headline.trim()
          ? clipText(parsed.headline, 54)
          : fallback.headline,
      summary:
        typeof parsed.summary === 'string' && parsed.summary.trim()
          ? clipText(parsed.summary, 110)
          : fallback.summary,
      risk: normalizeRiskLevel(parsed.risk),
      adjustments: Array.isArray(parsed.adjustments) && parsed.adjustments.length
        ? parsed.adjustments
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .slice(0, 3)
            .map((item) => clipText(item, 80))
        : fallback.adjustments,
      recommendedGoal: fallback.recommendedGoal,
    };
  } catch {
    return fallback;
  }
}
