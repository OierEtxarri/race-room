import express from 'express';
import { buildDashboardData, buildFallbackDashboardData } from './lib/dashboard.ts';
import { garminMcpClient } from './lib/garminMcpClient.ts';
import { config } from './config.ts';

const app = express();
const cacheTtlMs = 10 * 60 * 1_000;
const fallbackCacheTtlMs = 2 * 60 * 1_000;

let cached:
  | {
      data: Awaited<ReturnType<typeof buildDashboardData>>;
      expiresAt: number;
    }
  | null = null;

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    port: config.port,
    hasGarminCredentials: Boolean(config.garminEmail && config.garminPassword),
    fetchedAt: new Date().toISOString(),
  });
});

app.get('/api/dashboard', async (request, response) => {
  try {
    const forceRefresh = request.query.refresh === '1';

    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      response.json(cached.data);
      return;
    }

    const data = await buildDashboardData();
    cached = {
      data,
      expiresAt: Date.now() + cacheTtlMs,
    };

    response.json(data);
  } catch (error) {
    console.error('[api] dashboard fetch failed', error);
    const message =
      error instanceof Error ? error.message : 'No se pudieron cargar los datos de Garmin.';
    const fallbackData = buildFallbackDashboardData(message);
    cached = {
      data: fallbackData,
      expiresAt: Date.now() + fallbackCacheTtlMs,
    };
    response.json(fallbackData);
  }
});

const server = app.listen(config.port, () => {
  console.info(`[api] Garmin dashboard disponible en http://localhost:${config.port}`);
});

const shutdown = async () => {
  await garminMcpClient.close().catch(() => undefined);
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
