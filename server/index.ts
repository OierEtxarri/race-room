import express from 'express';
import { buildDashboardData, buildFallbackDashboardData } from './lib/dashboard.ts';
import { garminMcpClient } from './lib/garminMcpClient.ts';
import { schedulePlanWorkoutOnGarmin } from './lib/planWorkouts.ts';
import { config } from './config.ts';

const app = express();
const cacheTtlMs = 2 * 60 * 1_000;
const fallbackCacheTtlMs = 45 * 1_000;
const backgroundRefreshMs = 2 * 60 * 1_000;

let cached:
  | {
      data: Awaited<ReturnType<typeof buildDashboardData>>;
      expiresAt: number;
    }
  | null = null;
let inflightRefresh: Promise<Awaited<ReturnType<typeof buildDashboardData>>> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

app.use(express.json());

async function refreshDashboardData(force = false): Promise<Awaited<ReturnType<typeof buildDashboardData>>> {
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  if (inflightRefresh) {
    return inflightRefresh;
  }

  inflightRefresh = (async () => {
    try {
      const data = await buildDashboardData();
      cached = {
        data,
        expiresAt: Date.now() + cacheTtlMs,
      };
      return data;
    } catch (error) {
      console.error('[api] dashboard fetch failed', error);
      const message =
        error instanceof Error ? error.message : 'No se pudieron cargar los datos de Garmin.';

      const fallbackData =
        cached?.data && !cached.data.fallbackReason
          ? {
              ...cached.data,
              fallbackReason: message,
            }
          : buildFallbackDashboardData(message);

      cached = {
        data: fallbackData,
        expiresAt: Date.now() + fallbackCacheTtlMs,
      };
      return fallbackData;
    } finally {
      inflightRefresh = null;
    }
  })();

  return inflightRefresh;
}

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    port: config.port,
    hasGarminCredentials: Boolean(config.garminEmail && config.garminPassword),
    fetchedAt: new Date().toISOString(),
  });
});

app.get('/api/dashboard', async (request, response) => {
  const forceRefresh = request.query.refresh === '1';
  const data = await refreshDashboardData(forceRefresh);
  response.json(data);
});

app.post('/api/plan/workout', async (request, response) => {
  const weekIndex = Number(request.body?.weekIndex);
  const dayIndex = Number(request.body?.dayIndex);

  if (!Number.isInteger(weekIndex) || weekIndex < 0 || !Number.isInteger(dayIndex) || dayIndex < 0) {
    response.status(400).json({
      message: 'weekIndex y dayIndex deben ser enteros válidos.',
    });
    return;
  }

  const data = await refreshDashboardData();

  if (data.fallbackReason) {
    response.status(503).json({
      message: 'Garmin no está disponible ahora mismo para programar entrenamientos.',
    });
    return;
  }

  const week = data.plan.weeks[weekIndex];
  const day = week?.days[dayIndex];

  if (!week || !day) {
    response.status(404).json({
      message: 'No existe ese día dentro del plan actual.',
    });
    return;
  }

  if (!day.canSendToGarmin) {
    response.status(400).json({
      message: 'Ese día no se puede enviar a Garmin desde la app.',
    });
    return;
  }

  try {
    const result = await schedulePlanWorkoutOnGarmin(day, data.plan.paces);
    cached = cached
      ? {
          ...cached,
          expiresAt: 0,
        }
      : null;

    response.json({
      ok: true,
      title: day.title,
      date: day.date,
      result,
    });
  } catch (error) {
    response.status(502).json({
      message:
        error instanceof Error
          ? error.message
          : 'No se pudo subir el entrenamiento a Garmin.',
    });
  }
});

const server = app.listen(config.port, () => {
  console.info(`[api] Garmin dashboard disponible en http://localhost:${config.port}`);
  void refreshDashboardData(true);
  refreshTimer = setInterval(() => {
    void refreshDashboardData(true);
  }, backgroundRefreshMs);
});

const shutdown = async () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  await garminMcpClient.close().catch(() => undefined);
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
