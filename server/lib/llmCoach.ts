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

export type CoachSnapshot = {
  source: 'gemma4' | 'fallback';
  model: string | null;
  generatedAt: string;
  fitnessTitle: string;
  fitnessBody: string;
  planSummary: string;
  todayMessage: string | null;
  weekAdjustments: CoachWeekAdjustment[];
};

type LlmPayload = {
  fitnessTitle?: string;
  fitnessBody?: string;
  planSummary?: string;
  todayMessage?: string | null;
  weekAdjustments?: Array<{
    weekIndex?: number;
    targetKmDelta?: number;
    focus?: string;
    coachNote?: string;
  }>;
};

function llmEnabled() {
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
      320,
    ),
    planSummary: clipText(
      `${dashboard.plan.summary} Ajuste subjetivo de hoy: ${signals.todayMessage}`,
      420,
    ),
    todayMessage: signals.todayMessage,
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
4. Ajustar como mucho 3 semanas con cambios suaves de foco y delta de km.

Restricciones:
- No cambies fechas.
- No inventes métricas.
- targetKmDelta debe estar entre -3 y 3.
- Si la señal subjetiva es mala, protege.
- Si el plan ya está en modo protect, no propongas subir km.
- Responde SOLO JSON válido.

JSON esperado:
{
  "fitnessTitle": "string corto",
  "fitnessBody": "string",
  "planSummary": "string",
  "todayMessage": "string",
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

async function callOllama(prompt: string): Promise<string> {
  const response = await fetch(new URL('/api/generate', config.llmBaseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llmModel,
      prompt,
      stream: false,
      format: 'json',
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

async function callOpenAiCompatible(prompt: string): Promise<string> {
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
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Eres un entrenador de running que responde JSON estricto.',
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
            ? clipText(item.coachNote, 180)
            : null,
      };
    })
    .filter((item): item is CoachWeekAdjustment => item !== null)
    .slice(0, 3);
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
        ? clipText(parsed.fitnessBody, 320)
        : fallback.fitnessBody,
    planSummary:
      typeof parsed.planSummary === 'string' && parsed.planSummary.trim()
        ? clipText(parsed.planSummary, 420)
        : fallback.planSummary,
    todayMessage:
      typeof parsed.todayMessage === 'string' && parsed.todayMessage.trim()
        ? clipText(parsed.todayMessage, 180)
        : fallback.todayMessage,
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
        ? await callOllama(prompt)
        : await callOpenAiCompatible(prompt);
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
    },
    plan: {
      ...input.dashboard.plan,
      summary: input.snapshot.planSummary,
      weeks: adjustedWeeks,
    },
  };
}
