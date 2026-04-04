import crypto from 'node:crypto';
import { config } from '../config.ts';
import type { DashboardData } from './dashboard.ts';
import {
  listCoachMemories,
  type CoachMemoryRecord,
  type DailyCheckInRecord,
  type PersistedCoachState,
  upsertCoachMemories,
} from './userStateStore.ts';

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
  stance: string;
  adjustments: string[];
  sampleWeek: string[];
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

export type CoachChatToolTrace = {
  name: string;
  label: string;
  detail: string;
};

export type CoachChatReply = {
  answer: string;
  action: string | null;
  followUp: string | null;
  tools: CoachChatToolTrace[];
  memory: Array<{
    title: string;
    detail: string;
  }>;
  source: 'gemma4' | 'fallback';
};

type CoachChatPayload = {
  answer?: string;
  action?: string | null;
  followUp?: string | null;
};

type SemanticMemorySeed = {
  memoryKey: string;
  kind: CoachMemoryRecord['kind'];
  title: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
};

type SemanticMemoryHit = {
  memoryKey: string;
  kind: CoachMemoryRecord['kind'];
  title: string;
  content: string;
  metadata: Record<string, unknown> | null;
  score: number;
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

function trimCoachQuestions(value: string, maxQuestions = 1) {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return normalized;
  }

  const sentences = normalized.split(/(?<=[.!?])\s+/u);
  let questions = 0;
  const kept: string[] = [];

  for (const sentence of sentences) {
    const hasQuestion = sentence.includes('¿') || sentence.includes('?');
    if (!hasQuestion) {
      kept.push(sentence);
      continue;
    }

    if (questions >= maxQuestions) {
      continue;
    }

    const firstQuestionEnd = sentence.indexOf('?');
    const trimmedQuestion =
      firstQuestionEnd >= 0 ? sentence.slice(0, firstQuestionEnd + 1).trim() : sentence.trim();

    kept.push(trimmedQuestion);
    questions += 1;
  }

  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

function conciseCoachAnswer(value: string, maxLength: number) {
  return clipText(trimCoachQuestions(value, 1), maxLength);
}

function parseLooseJson<T>(raw: string): T {
  const trimmed = raw.trim();

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.search(/[\[{]/);
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('No hay un bloque JSON reconocible.');
    }

    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  }
}

function formatPacePerKm(seconds: number | null) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const remainingSeconds = whole % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}/km`;
}

function looksLikePainQuestion(question: string) {
  return /(dolor|molest|lesi|cargad|contractur|sobrecarga|gemelo|sóleo|soleo|aquiles|rodilla|tobillo|cadera|isquio|espalda|pinchazo|tend[oó]n|coje|fisio)/i.test(
    question,
  );
}

function hashText(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function tokenizeSearchText(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 3);
}

function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (!leftNorm || !rightNorm) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function lexicalSimilarity(query: string, candidate: string) {
  const queryTokens = tokenizeSearchText(query);
  const candidateTokens = new Set(tokenizeSearchText(candidate));
  if (!queryTokens.length || !candidateTokens.size) {
    return 0;
  }

  const matches = queryTokens.filter((token) => candidateTokens.has(token)).length;
  return matches / queryTokens.length;
}

function normalizeMemoryTimestamp(value: string | undefined) {
  const parsed = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

async function callOllamaEmbed(model: string, input: string[]): Promise<number[][]> {
  const response = await fetch(new URL('/api/embed', config.llmBaseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input,
    }),
  });

  const payload = (await response.json()) as {
    embeddings?: number[][];
  };

  if (!response.ok || !Array.isArray(payload.embeddings)) {
    throw new Error('Ollama no ha devuelto embeddings válidos.');
  }

  return payload.embeddings;
}

async function callOpenAiCompatibleEmbed(model: string, input: string[]): Promise<number[][]> {
  const headers = new Headers({
    'Content-Type': 'application/json',
  });
  if (config.llmApiKey) {
    headers.set('Authorization', `Bearer ${config.llmApiKey}`);
  }

  const response = await fetch(new URL('/embeddings', config.llmBaseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      input,
    }),
  });

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };

  if (!response.ok || !Array.isArray(payload.data)) {
    throw new Error('El endpoint de embeddings no ha devuelto contenido utilizable.');
  }

  return payload.data.map((entry) => (Array.isArray(entry.embedding) ? entry.embedding : []));
}

async function embedTexts(input: string[]): Promise<number[][] | null> {
  if (!llmEnabled() || !config.llmEmbeddingModel || !input.length) {
    return null;
  }

  try {
    return config.llmProvider === 'ollama'
      ? await callOllamaEmbed(config.llmEmbeddingModel, input)
      : await callOpenAiCompatibleEmbed(config.llmEmbeddingModel, input);
  } catch {
    return null;
  }
}

function buildSemanticMemorySeeds(dashboard: DashboardData, checkIns: DailyCheckInRecord[]): SemanticMemorySeed[] {
  const today = dashboard.fetchedAt.slice(0, 10);
  const seeds: SemanticMemorySeed[] = [
    {
      memoryKey: `goal:${dashboard.goal.raceDate}:${dashboard.goal.distanceKm.toFixed(1)}`,
      kind: 'goal',
      title: 'Objetivo actual',
      content: `${dashboard.goal.label} el ${dashboard.goal.raceDate}. ${dashboard.plan.summary}`,
      metadata: {
        raceDate: dashboard.goal.raceDate,
        distanceKm: dashboard.goal.distanceKm,
      },
      createdAt: dashboard.fetchedAt,
    },
    {
      memoryKey: `overview:${today}`,
      kind: 'overview',
      title: 'Estado actual',
      content: [
        dashboard.coach.todayMessage,
        dashboard.fitnessSummary.title,
        dashboard.fitnessSummary.body,
        dashboard.adaptive.primaryNeed,
        dashboard.plan.summary,
      ]
        .filter(Boolean)
        .join(' '),
      metadata: {
        date: today,
        readiness: dashboard.overview.readiness,
        vo2Max: dashboard.overview.vo2Max,
        hrv: dashboard.overview.hrv,
      },
      createdAt: dashboard.fetchedAt,
    },
  ];

  for (const [weekIndex, week] of dashboard.plan.weeks.slice(0, 3).entries()) {
    seeds.push({
      memoryKey: `week:${dashboard.goal.raceDate}:${weekIndex}`,
      kind: 'week',
      title: week.title,
      content: `${week.focus}. Objetivo ${week.targetKm ?? 0} km. ${week.days
        .map((day) => `${day.weekday}: ${day.title}${day.distanceKm ? ` ${day.distanceKm.toFixed(1)} km` : ''}`)
        .join(' · ')}`,
      metadata: {
        weekIndex,
        title: week.title,
        targetKm: week.targetKm,
      },
      createdAt: dashboard.fetchedAt,
    });
  }

  for (const run of dashboard.recentRuns.slice(0, 12)) {
    seeds.push({
      memoryKey: `run:${run.id}`,
      kind: 'run',
      title: run.name,
      content: [
        `${run.date}${run.timeLabel ? ` ${run.timeLabel}` : ''}`,
        `${run.distanceKm.toFixed(1)} km`,
        run.paceSecondsPerKm ? `a ${formatPacePerKm(run.paceSecondsPerKm)}` : null,
        run.averageHeartRate ? `fc media ${Math.round(run.averageHeartRate)}` : null,
        run.elevationGain ? `desnivel ${Math.round(run.elevationGain)} m` : null,
        run.trainingEffect !== null ? `training effect ${run.trainingEffect.toFixed(1)}` : null,
        run.trainingLoad !== null ? `training load ${Math.round(run.trainingLoad)}` : null,
      ]
        .filter(Boolean)
        .join(', '),
      metadata: {
        runId: run.id,
        date: run.date,
        distanceKm: run.distanceKm,
        paceSecondsPerKm: run.paceSecondsPerKm,
      },
      createdAt: `${run.date}T00:00:00.000Z`,
    });
  }

  for (const checkIn of checkIns.slice(0, 10)) {
    seeds.push({
      memoryKey: `checkin:${checkIn.date}`,
      kind: 'checkin',
      title: `Check-in ${checkIn.date}`,
      content: `Energía ${checkIn.energy}, piernas ${checkIn.legs}, cabeza ${checkIn.mood}${checkIn.note ? `. Nota: ${checkIn.note}` : '.'}`,
      metadata: {
        date: checkIn.date,
        energy: checkIn.energy,
        legs: checkIn.legs,
        mood: checkIn.mood,
      },
      createdAt: checkIn.createdAt,
    });
  }

  return seeds;
}

async function syncSemanticMemories(accountKey: string, dashboard: DashboardData, checkIns: DailyCheckInRecord[]) {
  const seeds = buildSemanticMemorySeeds(dashboard, checkIns);
  if (!seeds.length) {
    return;
  }

  const existing = new Map(listCoachMemories(accountKey, 240).map((memory) => [memory.memoryKey, memory]));
  const changedSeeds: SemanticMemorySeed[] = [];

  for (const seed of seeds) {
    const contentHash = hashText(`${seed.title}\n${seed.content}`);
    const current = existing.get(seed.memoryKey);
    if (!current || current.contentHash !== contentHash || !current.embedding?.length) {
      changedSeeds.push(seed);
    }
  }

  if (!changedSeeds.length) {
    return;
  }

  const embeddings = await embedTexts(changedSeeds.map((seed) => `${seed.title}\n${seed.content}`));

  upsertCoachMemories({
    accountKey,
    items: changedSeeds.map((seed, index) => ({
      memoryKey: seed.memoryKey,
      kind: seed.kind,
      title: seed.title,
      content: seed.content,
      contentHash: hashText(`${seed.title}\n${seed.content}`),
      metadata: seed.metadata ?? null,
      embedding: embeddings?.[index] ?? null,
      createdAt: seed.createdAt,
    })),
  });
}

async function searchSemanticMemories(accountKey: string, query: string, limit = 3): Promise<SemanticMemoryHit[]> {
  const memories = listCoachMemories(accountKey, config.llmSemanticMemoryLimit);
  if (!memories.length) {
    return [];
  }

  const embeddedQuery = await embedTexts([query]);
  const queryEmbedding = embeddedQuery?.[0] ?? null;
  const now = Date.now();

  return memories
    .map((memory) => {
      const embeddingScore =
        queryEmbedding && memory.embedding?.length
          ? Math.max(0, cosineSimilarity(queryEmbedding, memory.embedding))
          : 0;
      const lexicalScore = lexicalSimilarity(query, `${memory.title} ${memory.content}`);
      const recencyScore = Math.max(0, 1 - (now - normalizeMemoryTimestamp(memory.updatedAt)) / (1000 * 60 * 60 * 24 * 60));
      const score = embeddingScore > 0 ? embeddingScore * 0.72 + lexicalScore * 0.18 + recencyScore * 0.1 : lexicalScore * 0.75 + recencyScore * 0.25;

      return {
        memoryKey: memory.memoryKey,
        kind: memory.kind,
        title: memory.title,
        content: memory.content,
        metadata: memory.metadata,
        score,
      };
    })
    .filter((item) => item.score > 0.08)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
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

  const pace = formatPacePerKm(latestRun.paceSecondsPerKm);
  const trainingEffectLabel =
    latestRun.trainingEffect !== null
      ? latestRun.trainingEffect >= 3.5
        ? 'sesión que suma'
        : latestRun.trainingEffect >= 2.5
          ? 'carga bien medida'
          : 'rodaje de asimilación'
      : 'rodaje de continuidad';
  const summary = `${trainingEffectLabel}: ${latestRun.distanceKm.toFixed(1)} km${pace ? ` a ${pace}` : ''}.`;
  const nextStep =
    dashboard.adaptive.overall === 'protect'
      ? 'Mañana solo soltar.'
      : dashboard.adaptive.overall === 'push'
        ? 'Mañana puedes empujar.'
        : 'Repite con control.';

  return {
    runId: latestRun.id,
    runName: latestRun.name,
    summary: clipText(summary, 56),
    nextStep: clipText(nextStep, 28),
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
5. Generar un debrief MUY corto del último entreno: qué dijo ese entreno y qué harías después.
6. Ajustar como mucho 3 semanas con cambios suaves de foco y delta de km.

Restricciones:
- No cambies fechas.
- No inventes métricas.
- targetKmDelta debe estar entre -3 y 3.
- Si la señal subjetiva es mala, protege.
- Si el plan ya está en modo protect, no propongas subir km.
- Sé muy sintético. Nada de párrafos largos.
- fitnessBody <= 18 palabras.
- planSummary <= 18 palabras.
- todayMessage <= 10 palabras.
- weeklyReview.summary <= 12 palabras.
- weeklyReview.nextMove <= 6 palabras.
- latestDebrief.summary <= 12 palabras.
- latestDebrief.nextStep <= 5 palabras.
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

const modelCooldownUntil = new Map<string, number>();

function isModelCoolingDown(model: string | null | undefined) {
  if (!model) {
    return false;
  }

  return (modelCooldownUntil.get(model) ?? 0) > Date.now();
}

function markModelCoolingDown(model: string | null | undefined) {
  if (!model) {
    return;
  }

  modelCooldownUntil.set(model, Date.now() + 30 * 60 * 1_000);
}

async function callOllama(
  prompt: string,
  options: { json?: boolean; model?: string } = {},
): Promise<string> {
  const response = await fetch(new URL('/api/generate', config.llmBaseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model ?? config.llmModel,
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

async function callOpenAiCompatible(
  prompt: string,
  options: { json?: boolean; model?: string } = {},
): Promise<string> {
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
      model: options.model ?? config.llmModel,
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
      ? clipText(payload.nextMove, 24)
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
      ? clipText(payload.summary, 56)
      : fallback?.summary ?? null;
  const nextStep =
    typeof payload.nextStep === 'string' && payload.nextStep.trim()
      ? clipText(payload.nextStep, 26)
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
  const parsed = parseLooseJson<LlmPayload>(raw);
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
  accountKey: string;
  dashboard: DashboardData;
  checkIns: DailyCheckInRecord[];
  persistedState: PersistedCoachState | null;
  forceRegenerate?: boolean;
}): Promise<{ snapshot: CoachSnapshot; inputHash: string }> {
  const inputHash = buildCoachInputHash(input.dashboard, input.checkIns);
  const fallback = buildFallbackCoachSnapshot(input.dashboard, input.checkIns);
  const forceRegenerate = input.forceRegenerate ?? false;

  await syncSemanticMemories(input.accountKey, input.dashboard, input.checkIns);

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

async function callModel(prompt: string, options: { json?: boolean; model?: string } = {}) {
  const preferredModel = options.model?.trim() || config.llmModel;
  const fallbackModel = config.llmModel;

  const callWithModel = (model: string) =>
    config.llmProvider === 'ollama'
      ? callOllama(prompt, { ...options, model })
      : callOpenAiCompatible(prompt, { ...options, model });

  if (preferredModel && !isModelCoolingDown(preferredModel)) {
    try {
      return await callWithModel(preferredModel);
    } catch (error) {
      if (preferredModel !== fallbackModel) {
        markModelCoolingDown(preferredModel);
      } else {
        throw error;
      }
    }
  }

  return callWithModel(fallbackModel);
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

function upcomingPlanDays(dashboard: DashboardData, days = 4, limit = 3) {
  const today = new Date(`${dashboard.fetchedAt.slice(0, 10)}T00:00:00`);
  const cutoff = today.getTime() + Math.max(1, days) * 24 * 60 * 60 * 1_000;

  return dashboard.plan.weeks
    .flatMap((week) => week.days)
    .filter((day) => {
      if (day.intensity === 'descanso') {
        return false;
      }

      const timestamp = new Date(`${day.date}T00:00:00`).getTime();
      return Number.isFinite(timestamp) && timestamp >= today.getTime() && timestamp <= cutoff;
    })
    .slice(0, limit)
    .map((day) => ({
      date: day.date,
      title: day.title,
      intent: day.intent,
      intensity: day.intensity,
      distanceKm: day.distanceKm,
      notes: day.notes,
      status: day.status,
    }));
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
      name: 'search_memory',
      description: 'Busca recuerdos semánticos del atleta: entrenos, check-ins, objetivo o semanas parecidas.',
      args: { query: 'string', limit: 'number opcional' },
    },
    {
      name: 'get_upcoming_sessions',
      description: 'Próximas sesiones útiles del plan.',
      args: { days: 'number opcional', limit: 'number opcional' },
    },
    {
      name: 'get_paces',
      description: 'Rangos actuales de ritmo del plan.',
      args: {},
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

async function executeCoachTool(input: {
  accountKey: string;
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
    case 'search_memory': {
      const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : '';
      const limit = Number(args.limit ?? 3);
      if (!query) {
        return [];
      }
      return searchSemanticMemories(input.accountKey, query, Number.isFinite(limit) ? limit : 3);
    }
    case 'get_upcoming_sessions': {
      const days = Number(args.days ?? 4);
      const limit = Number(args.limit ?? 3);
      return upcomingPlanDays(
        input.dashboard,
        Number.isFinite(days) ? days : 4,
        Number.isFinite(limit) ? limit : 3,
      );
    }
    case 'get_paces':
      return input.dashboard.plan.paces;
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
- Usa como máximo 3 tools.
- Si puedes responder con seguridad sin tools, deja toolCalls vacío y da la respuesta final.
- La respuesta final debe ser muy breve: máximo 2 frases.
- Máximo 45 palabras.
- No inventes datos.
- Prioriza responder antes que preguntar.
- Si la pregunta es sobre mañana, próxima sesión o qué hacer ahora, prioriza get_upcoming_sessions y get_adaptive.
- Si la pregunta es sobre ritmos, usa get_paces.
- Si la pregunta es sobre un entreno reciente, usa get_latest_run o get_recent_runs.
- Si la pregunta es sobre dolor, gemelo, molestia o lesión, prioriza get_adaptive, get_latest_run y get_recent_runs.
- Si comparas con otra época o buscas patrones, usa search_memory.
- Si faltan detalles clave de la molestia, haz como máximo 1 pregunta corta.
- No diagnostiques ni des seguridad médica falsa.

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
Responde SOLO JSON válido:
{
  "answer": "string",
  "action": "string o null",
  "followUp": "string o null"
}

Reglas:
- answer <= 38 palabras.
- action <= 8 palabras y en imperativo.
- followUp <= 10 palabras.
- Ve directo al consejo.
- Si falta una métrica, dilo en una frase corta.
- No reescribas todo el plan.
- Si puedes, concreta la próxima acción.
- Si preguntan por dolor o molestia, primero di qué harías hoy.
- Si preguntan por dolor, aclara si hoy toca parar, bajar carga o hacer solo descarga.
- Si preguntas por dolor, puedes sugerir descanso, movilidad suave, fuerza isométrica ligera o consulta profesional si hay señales de alarma.
- Solo haz 1 pregunta si es imprescindible.
- Si puedes aconsejar sin preguntar, no preguntes.
- No diagnostiques.
- Si hay señales de alarma claras, di parar y consultar a un profesional.
- followUp debe ser una indicación breve, no otra batería de preguntas.

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

function buildFallbackCoachReply(input: {
  dashboard: DashboardData;
  checkIns: DailyCheckInRecord[];
  question: string;
}): CoachChatReply {
  const latest = latestCheckIn(input.checkIns);
  const upcoming = upcomingPlanDays(input.dashboard, 3, 1)[0] ?? null;
  const needsProtection = latest?.energy === 'low' || latest?.legs === 'heavy' || input.dashboard.adaptive.overall === 'protect';
  const painQuestion = looksLikePainQuestion(input.question);

  if (painQuestion) {
    return {
      answer: clipText(
        'Hoy evita calidad y baja carga. ¿Te cambia la zancada al correr o al caminar?',
        110,
      ),
      action: clipText('Baja carga hoy', 40),
      followUp: clipText('Si cojeas o hay pinchazo, para.', 52),
      tools: [],
      memory: [],
      source: 'fallback',
    };
  }

  const baseAnswer = upcoming
    ? `Tu siguiente bloque útil es ${upcoming.title.toLowerCase()}. ${needsProtection ? 'Hazlo con margen y sin forzar.' : 'Llega fresco y sostenido.'}`
    : input.dashboard.coach.todayMessage ?? 'Hoy no hay una alerta fuerte en tus señales.';

  return {
    answer: clipText(baseAnswer, 110),
    action: clipText(
      needsProtection
        ? 'Prioriza un rodaje fácil'
        : upcoming?.title ?? 'Mantén el plan actual',
      40,
    ),
    followUp: clipText(
      latest ? `Check-in: ${latest.energy} · ${latest.legs}.` : 'Completa el check-in si cambia algo.',
      52,
    ),
    tools: [],
    memory: [],
    source: 'fallback',
  };
}

function parseToolPlan(raw: string): ToolCallPlan {
  const parsed = parseLooseJson<ToolCallPlan>(raw);
  return {
    answer: typeof parsed.answer === 'string' && parsed.answer.trim() ? parsed.answer.trim() : undefined,
    toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls.slice(0, 3) : [],
  };
}

function sanitizeCoachChatPayload(raw: string, fallback: CoachChatReply, tools: CoachChatToolTrace[]): CoachChatReply {
  const parsed = parseLooseJson<CoachChatPayload>(raw);
  const cleanedFollowUp =
    typeof parsed.followUp === 'string' && parsed.followUp.trim()
      ? trimCoachQuestions(parsed.followUp, 0)
      : '';

  return {
    answer:
      typeof parsed.answer === 'string' && parsed.answer.trim()
        ? conciseCoachAnswer(parsed.answer, 118)
        : fallback.answer,
    action:
      typeof parsed.action === 'string' && parsed.action.trim()
        ? clipText(parsed.action, 42)
        : fallback.action,
    followUp:
      cleanedFollowUp
        ? clipText(cleanedFollowUp, 52)
        : fallback.followUp,
    tools,
    memory: fallback.memory,
    source: 'gemma4',
  };
}

function extractMemoryHits(
  toolResults: Array<{ name: string; result: unknown }>,
): Array<{ title: string; detail: string }> {
  const memoryTool = toolResults.find((tool) => tool.name === 'search_memory');
  if (!memoryTool || !Array.isArray(memoryTool.result)) {
    return [];
  }

  return (memoryTool.result as SemanticMemoryHit[])
    .slice(0, 3)
    .map((memory) => ({
      title: memory.title,
      detail: clipText(memory.content, 72),
    }));
}

function summarizeToolUsage(name: string, args: Record<string, unknown> | undefined): CoachChatToolTrace {
  switch (name) {
    case 'get_overview':
      return { name, label: 'Resumen actual', detail: 'Métricas clave del día.' };
    case 'get_recent_runs':
      return {
        name,
        label: 'Rodajes recientes',
        detail: `${Number(args?.days ?? 14)} días de historial.`,
      };
    case 'search_memory':
      return {
        name,
        label: 'Memoria relevante',
        detail: `${Number(args?.limit ?? 3)} recuerdos cercanos.`,
      };
    case 'get_upcoming_sessions':
      return {
        name,
        label: 'Próximas sesiones',
        detail: `${Number(args?.days ?? 4)} días hacia delante.`,
      };
    case 'get_paces':
      return { name, label: 'Ritmos', detail: 'Rangos easy, steady, tempo y race.' };
    case 'get_plan_week':
      return {
        name,
        label: 'Semana del plan',
        detail: `Semana ${Number(args?.weekIndex ?? 0) + 1}.`,
      };
    case 'get_checkins':
      return {
        name,
        label: 'Check-ins',
        detail: `${Number(args?.days ?? 7)} días subjetivos.`,
      };
    case 'get_weekly_running':
      return {
        name,
        label: 'Carga semanal',
        detail: `${Number(args?.weeks ?? 4)} semanas recientes.`,
      };
    case 'get_latest_run':
      return { name, label: 'Último entreno', detail: 'Última actividad registrada.' };
    case 'get_adaptive':
      return { name, label: 'Lectura adaptativa', detail: 'Volumen, ritmo y recuperación.' };
    default:
      return { name, label: name, detail: 'Consulta usada por el coach.' };
  }
}

export async function answerCoachQuestion(input: {
  accountKey: string;
  dashboard: DashboardData;
  checkIns: DailyCheckInRecord[];
  question: string;
}): Promise<CoachChatReply> {
  const fallback = buildFallbackCoachReply(input);

  if (!llmEnabled()) {
    return fallback;
  }

  try {
    const planRaw = await callModel(buildToolSelectionPrompt(input), {
      json: true,
      model: config.llmRouterModel,
    });
    const plan = parseToolPlan(planRaw);
    const painQuestion = looksLikePainQuestion(input.question);
    const ensuredToolCalls = [...(plan.toolCalls ?? [])];

    if (painQuestion && !ensuredToolCalls.some((tool) => tool?.name === 'search_memory')) {
      ensuredToolCalls.push({
        name: 'search_memory',
        args: {
          query: input.question,
          limit: 2,
        },
      });
    }

    if (painQuestion && !ensuredToolCalls.some((tool) => tool?.name === 'get_latest_run')) {
      ensuredToolCalls.push({
        name: 'get_latest_run',
        args: {},
      });
    }

    if (plan.answer && ensuredToolCalls.length === 0) {
      return {
        ...fallback,
        answer: conciseCoachAnswer(plan.answer, 118),
        source: 'gemma4',
      };
    }

    const toolResults = await Promise.all(
      ensuredToolCalls.slice(0, 4).map(async (toolCall) => {
        const name = typeof toolCall.name === 'string' ? toolCall.name : 'unknown';
        return {
          name,
          args: toolCall.args,
          result: await executeCoachTool(input, name, toolCall.args),
        };
      }),
    );

    const raw = await callModel(buildToolAnswerPrompt({
      ...input,
      toolResults,
    }), { json: true });

    return sanitizeCoachChatPayload(
      raw,
      {
        ...fallback,
        memory: extractMemoryHits(toolResults),
      },
      toolResults.map((tool) => summarizeToolUsage(tool.name, tool.args)),
    );
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

  const stance =
    risk === 'high'
      ? 'Recorta ruido y protege carga.'
      : risk === 'low'
        ? 'Aprovecha para llegar fresco.'
        : 'Sostén continuidad con control.';

  const sampleWeek = [
    input.scenario.availableDays !== null && input.scenario.availableDays <= 3
      ? 'Calidad breve o ritmo controlado.'
      : 'Rodaje suave y activación.',
    'Rodaje soporte o descanso.',
    'Tirada larga progresiva.',
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
    stance,
    adjustments: adjustments.map((item) => clipText(item, 110)),
    sampleWeek: sampleWeek.map((item) => clipText(item, 72)),
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
  "stance": "string corto",
  "risk": "low|medium|high",
  "adjustments": ["string corto", "string corto", "string corto"],
  "sampleWeek": ["string corto", "string corto", "string corto"]
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
    const parsed = parseLooseJson<{
      headline?: string;
      summary?: string;
      stance?: string;
      risk?: WhatIfScenario['risk'];
      adjustments?: string[];
      sampleWeek?: string[];
    }>(raw);

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
      stance:
        typeof parsed.stance === 'string' && parsed.stance.trim()
          ? clipText(parsed.stance, 54)
          : fallback.stance,
      adjustments: Array.isArray(parsed.adjustments) && parsed.adjustments.length
        ? parsed.adjustments
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .slice(0, 3)
            .map((item) => clipText(item, 80))
        : fallback.adjustments,
      sampleWeek: Array.isArray(parsed.sampleWeek) && parsed.sampleWeek.length
        ? parsed.sampleWeek
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .slice(0, 3)
            .map((item) => clipText(item, 72))
        : fallback.sampleWeek,
      recommendedGoal: fallback.recommendedGoal,
    };
  } catch {
    return fallback;
  }
}
