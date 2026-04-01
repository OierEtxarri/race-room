import crypto from 'node:crypto';
import express from 'express';
import {
  buildDashboardData,
  buildFallbackDashboardData,
  type DashboardData,
} from './lib/dashboard.ts';
import { garminClient } from './lib/garminClient.ts';
import type { GarminSessionAuth } from './lib/garminMcpClient.ts';
import { schedulePlanWorkoutOnGarmin } from './lib/planWorkouts.ts';
import {
  buildStravaAuthorizeUrl,
  exchangeStravaCode,
  isStravaConfigured,
} from './lib/stravaClient.ts';
import {
  buildClearSessionCookie,
  buildGarminAccountKey,
  buildSessionCookie,
  buildStravaAccountKey,
  createGarminSession,
  createStravaSession,
  defaultGoal,
  destroySession,
  getSession,
  isGarminSession,
  listSessions,
  normalizeGoal,
  pruneExpiredSessions,
  sessionCookieName,
  updateSessionGoal,
  type GarminSessionRecord,
  type SessionRecord,
  type UserGoal,
} from './lib/sessionStore.ts';
import {
  getPersistedUserState,
  upsertPersistedDashboard,
  upsertPersistedGoal,
} from './lib/userStateStore.ts';
import { config } from './config.ts';

const app = express();
const cacheTtlMs = 2 * 60 * 1_000;
const fallbackCacheTtlMs = 45 * 1_000;
const backgroundRefreshMs = 2 * 60 * 1_000;
const stravaLoginStateTtlMs = 15 * 60 * 1_000;
const allowedOrigins = new Set(['http://localhost:5173', config.frontendOrigin].filter(Boolean));

type CachedDashboard = {
  data: DashboardData;
  expiresAt: number;
};

type StravaLoginState = {
  goal: UserGoal;
  returnTo: string;
  createdAt: number;
};

const cachedDashboards = new Map<string, CachedDashboard>();
const inflightRefreshes = new Map<string, Promise<DashboardData>>();
const stravaLoginStates = new Map<string, StravaLoginState>();
let refreshTimer: NodeJS.Timeout | null = null;

app.use(express.json());
app.use((request, response, next) => {
  const origin = request.header('origin');

  if (origin && allowedOrigins.has(origin)) {
    response.header('Access-Control-Allow-Origin', origin);
    response.header('Access-Control-Allow-Credentials', 'true');
    response.header('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id');
    response.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    response.header('Vary', 'Origin');
  }

  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }

  next();
});

function parseCookies(headerValue: string | undefined): Record<string, string> {
  if (!headerValue) {
    return {};
  }

  return headerValue.split(';').reduce<Record<string, string>>((accumulator, chunk) => {
    const [rawName, ...rest] = chunk.trim().split('=');
    if (!rawName) {
      return accumulator;
    }

    accumulator[rawName] = decodeURIComponent(rest.join('='));
    return accumulator;
  }, {});
}

function sessionToGarminAuth(session: GarminSessionRecord): GarminSessionAuth {
  return {
    id: session.id,
    garminEmail: session.garminEmail,
    garminPassword: session.garminPassword,
    homeDir: session.homeDir,
    tokenDirs: session.tokenDirs,
  };
}

function maskEmail(email: string): string {
  const [localPart, domain = ''] = email.split('@');
  if (!localPart) {
    return email;
  }

  if (localPart.length <= 2) {
    return `${localPart[0] ?? ''}***@${domain}`;
  }

  return `${localPart.slice(0, 2)}***@${domain}`;
}

function displayLabelForSession(session: SessionRecord): string {
  return isGarminSession(session) ? maskEmail(session.garminEmail) : session.accountLabel;
}

function isTemporaryGarminAuthError(message: string): boolean {
  return message.includes('429') || message.includes('427');
}

function matchingGoal(left: UserGoal, right: UserGoal): boolean {
  return left.raceDate === right.raceDate && Math.abs(left.distanceKm - right.distanceKm) < 0.05;
}

function cacheDashboard(sessionId: string, data: DashboardData, ttlMs: number): DashboardData {
  cachedDashboards.set(sessionId, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
  return data;
}

function invalidateSessionCache(sessionId: string): void {
  cachedDashboards.delete(sessionId);
}

function fallbackFromBase(
  session: SessionRecord,
  base: DashboardData | null,
  reason: string,
): DashboardData {
  if (!base) {
    return buildFallbackDashboardData(session.goal, reason, session.provider);
  }

  return {
    ...base,
    fallbackReason: reason,
  };
}

function resolveSessionFromRequest(request: express.Request): SessionRecord | null {
  const headerSessionId = request.header('x-session-id')?.trim();
  const cookieSessionId = parseCookies(request.header('cookie'))[sessionCookieName];
  return getSession(headerSessionId || cookieSessionId);
}

function normalizeReturnTo(rawValue: unknown): string {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return config.frontendAppUrl;
  }

  try {
    return new URL(rawValue).toString();
  } catch {
    return config.frontendAppUrl;
  }
}

function buildFrontendRedirect(baseUrl: string, params: Record<string, string>): string {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function pruneStravaLoginStates(): void {
  const cutoff = Date.now() - stravaLoginStateTtlMs;
  for (const [stateId, loginState] of stravaLoginStates.entries()) {
    if (loginState.createdAt < cutoff) {
      stravaLoginStates.delete(stateId);
    }
  }
}

async function liveRefreshDashboardData(
  session: SessionRecord,
  fallbackBase: DashboardData | null = null,
): Promise<DashboardData> {
  const existing = inflightRefreshes.get(session.id);
  if (existing) {
    return existing;
  }

  const refresh = (async () => {
    try {
      const data = isGarminSession(session)
        ? await buildDashboardData({
            provider: 'garmin',
            auth: sessionToGarminAuth(session),
            goal: session.goal,
          })
        : await buildDashboardData({
            provider: 'strava',
            auth: session,
            goal: session.goal,
          });

      upsertPersistedDashboard({
        accountKey: session.accountKey,
        goal: session.goal,
        dashboard: data,
      });

      return cacheDashboard(session.id, data, cacheTtlMs);
    } catch (error) {
      console.error(`[api] dashboard fetch failed for ${session.accountKey}`, error);
      const message =
        error instanceof Error
          ? error.message
          : `No se pudieron cargar los datos de ${session.provider === 'garmin' ? 'Garmin' : 'Strava'}.`;

      return cacheDashboard(session.id, fallbackFromBase(session, fallbackBase, message), fallbackCacheTtlMs);
    } finally {
      inflightRefreshes.delete(session.id);
    }
  })();

  inflightRefreshes.set(session.id, refresh);
  return refresh;
}

async function getDashboardData(
  session: SessionRecord,
  options: { force?: boolean } = {},
): Promise<DashboardData> {
  const force = options.force ?? false;
  const cached = cachedDashboards.get(session.id) ?? null;

  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const persistedState = getPersistedUserState(session.accountKey);
  const persistedDashboard =
    persistedState?.dashboard &&
    matchingGoal(persistedState.goal, session.goal) &&
    persistedState.dashboard.goal &&
    matchingGoal(persistedState.dashboard.goal, session.goal)
      ? persistedState.dashboard
      : null;

  if (!force && persistedDashboard && !cached) {
    cacheDashboard(session.id, persistedDashboard, fallbackCacheTtlMs);
    void liveRefreshDashboardData(session, persistedDashboard);
    return persistedDashboard;
  }

  return liveRefreshDashboardData(session, cached?.data ?? persistedDashboard);
}

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    port: config.port,
    supportsPerUserAuth: true,
    providers: ['garmin', 'strava'],
    stravaConfigured: isStravaConfigured(),
    frontendMode: 'static-ready',
    fetchedAt: new Date().toISOString(),
  });
});

app.get('/api/session', (request, response) => {
  const session = resolveSessionFromRequest(request);
  if (!session) {
    response.status(401).json({
      authenticated: false,
    });
    return;
  }

  response.setHeader('Set-Cookie', buildSessionCookie(session.id));
  response.json({
    authenticated: true,
    provider: session.provider,
    sessionId: session.id,
    accountLabel: displayLabelForSession(session),
    goal: session.goal,
  });
});

app.post('/api/session/login', async (request, response) => {
  const provider = typeof request.body?.provider === 'string' ? request.body.provider.trim().toLowerCase() : 'garmin';
  if (provider !== 'garmin') {
    response.status(400).json({
      message: 'El login directo por formulario solo está disponible para Garmin. Strava entra por OAuth.',
    });
    return;
  }

  const garminEmail =
    typeof request.body?.garminEmail === 'string' ? request.body.garminEmail.trim().toLowerCase() : '';
  const garminPassword =
    typeof request.body?.garminPassword === 'string' ? request.body.garminPassword : '';

  if (!garminEmail || !garminPassword) {
    response.status(400).json({
      message: 'Necesito email y password de Garmin para abrir la sesión.',
    });
    return;
  }

  const accountKey = buildGarminAccountKey(garminEmail);
  const persistedState = getPersistedUserState(accountKey);
  const goal = normalizeGoal(request.body?.goal ?? persistedState?.goal ?? defaultGoal);
  const session = createGarminSession({
    garminEmail,
    garminPassword,
    goal,
  });

  upsertPersistedGoal(accountKey, goal);

  const persistedDashboard =
    persistedState?.dashboard &&
    matchingGoal(persistedState.goal, goal) &&
    persistedState.dashboard.goal &&
    matchingGoal(persistedState.dashboard.goal, goal)
      ? persistedState.dashboard
      : null;

  if (persistedDashboard) {
    cacheDashboard(session.id, persistedDashboard, fallbackCacheTtlMs);
  }

  try {
    await garminClient.callJson(sessionToGarminAuth(session), 'get_user_profile');
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'No he podido validar las credenciales contra Garmin.';

    if (isTemporaryGarminAuthError(message)) {
      response.setHeader('Set-Cookie', buildSessionCookie(session.id));
      response.status(202).json({
        ok: true,
        degraded: true,
        provider: 'garmin',
        sessionId: session.id,
        accountLabel: displayLabelForSession(session),
        goal,
        hasStoredPlan: Boolean(persistedDashboard),
        message,
      });
      return;
    }

    destroySession(session.id);
    invalidateSessionCache(session.id);
    await garminClient.close(session.id).catch(() => undefined);

    response.status(401).json({ message });
    return;
  }

  response.setHeader('Set-Cookie', buildSessionCookie(session.id));
  response.json({
    ok: true,
    provider: 'garmin',
    sessionId: session.id,
    accountLabel: displayLabelForSession(session),
    goal,
    hasStoredPlan: Boolean(persistedDashboard),
  });

  void liveRefreshDashboardData(session, persistedDashboard);
});

app.get('/api/session/strava/start', (request, response) => {
  const returnTo = normalizeReturnTo(request.query.returnTo);
  const goal = normalizeGoal({
    raceDate: typeof request.query.raceDate === 'string' ? request.query.raceDate : undefined,
    distanceKm:
      typeof request.query.distanceKm === 'string' ? Number(request.query.distanceKm) : undefined,
  });

  if (!isStravaConfigured()) {
    response.redirect(
      buildFrontendRedirect(returnTo, {
        auth_error: 'Strava no está configurado todavía en el backend.',
      }),
    );
    return;
  }

  pruneStravaLoginStates();
  const state = crypto.randomUUID();
  stravaLoginStates.set(state, {
    goal,
    returnTo,
    createdAt: Date.now(),
  });

  response.redirect(buildStravaAuthorizeUrl(state));
});

app.get('/api/session/strava/callback', async (request, response) => {
  const stateId = typeof request.query.state === 'string' ? request.query.state : '';
  const loginState = stravaLoginStates.get(stateId) ?? null;
  const returnTo = loginState?.returnTo ?? config.frontendAppUrl;

  if (stateId) {
    stravaLoginStates.delete(stateId);
  }

  if (typeof request.query.error === 'string' && request.query.error) {
    response.redirect(
      buildFrontendRedirect(returnTo, {
        auth_error: `Strava ha rechazado la autorización: ${request.query.error}`,
      }),
    );
    return;
  }

  const code = typeof request.query.code === 'string' ? request.query.code : '';
  if (!code || !loginState) {
    response.redirect(
      buildFrontendRedirect(returnTo, {
        auth_error: 'La devolución de Strava no trae un estado válido.',
      }),
    );
    return;
  }

  try {
    const tokenPayload = await exchangeStravaCode(code);
    const athleteId = Number(tokenPayload.athlete?.id);
    if (!Number.isFinite(athleteId)) {
      throw new Error('Strava no ha devuelto un athlete id válido.');
    }

    const athleteName = [tokenPayload.athlete?.firstname, tokenPayload.athlete?.lastname]
      .filter((chunk): chunk is string => typeof chunk === 'string' && chunk.trim().length > 0)
      .join(' ')
      || tokenPayload.athlete?.username
      || `Athlete ${athleteId}`;

    const accountKey = buildStravaAccountKey(athleteId);
    const persistedState = getPersistedUserState(accountKey);
    const goal = normalizeGoal(loginState.goal ?? persistedState?.goal ?? defaultGoal);
    const session = createStravaSession({
      athleteId,
      athleteName,
      accessToken: tokenPayload.access_token,
      refreshToken: tokenPayload.refresh_token,
      expiresAt: tokenPayload.expires_at * 1_000,
      stravaClientId: config.stravaClientId,
      stravaClientSecret: config.stravaClientSecret,
      stravaRedirectUri: config.stravaRedirectUri,
      goal,
    });

    upsertPersistedGoal(accountKey, goal);

    response.setHeader('Set-Cookie', buildSessionCookie(session.id));
    response.redirect(
      buildFrontendRedirect(returnTo, {
        session_id: session.id,
        provider: 'strava',
      }),
    );

    const persistedDashboard =
      persistedState?.dashboard &&
      matchingGoal(persistedState.goal, goal) &&
      persistedState.dashboard.goal &&
      matchingGoal(persistedState.dashboard.goal, goal)
        ? persistedState.dashboard
        : null;

    if (persistedDashboard) {
      cacheDashboard(session.id, persistedDashboard, fallbackCacheTtlMs);
    }

    void liveRefreshDashboardData(session, persistedDashboard);
  } catch (error) {
    response.redirect(
      buildFrontendRedirect(returnTo, {
        auth_error:
          error instanceof Error ? error.message : 'No se pudo completar el login con Strava.',
      }),
    );
  }
});

app.post('/api/session/logout', async (request, response) => {
  const session = resolveSessionFromRequest(request);
  if (session) {
    destroySession(session.id);
    invalidateSessionCache(session.id);
    inflightRefreshes.delete(session.id);
    if (isGarminSession(session)) {
      await garminClient.close(session.id).catch(() => undefined);
    }
  }

  response.setHeader('Set-Cookie', buildClearSessionCookie());
  response.json({
    ok: true,
  });
});

app.put('/api/session/goal', async (request, response) => {
  const session = resolveSessionFromRequest(request);
  if (!session) {
    response.status(401).json({
      message: 'No hay sesión activa.',
    });
    return;
  }

  const updatedSession = updateSessionGoal(session.id, request.body ?? {});
  if (!updatedSession) {
    response.status(404).json({
      message: 'La sesión ya no existe.',
    });
    return;
  }

  upsertPersistedGoal(updatedSession.accountKey, updatedSession.goal);
  invalidateSessionCache(updatedSession.id);

  response.setHeader('Set-Cookie', buildSessionCookie(updatedSession.id));
  response.json({
    ok: true,
    goal: updatedSession.goal,
  });

  void liveRefreshDashboardData(updatedSession);
});

app.get('/api/dashboard', async (request, response) => {
  const session = resolveSessionFromRequest(request);
  if (!session) {
    response.status(401).json({
      message: 'No hay sesión activa. Inicia sesión con Garmin o Strava.',
    });
    return;
  }

  const forceRefresh = request.query.refresh === '1';
  const data = await getDashboardData(session, { force: forceRefresh });
  response.setHeader('Set-Cookie', buildSessionCookie(session.id));
  response.json(data);
});

app.post('/api/plan/workout', async (request, response) => {
  const session = resolveSessionFromRequest(request);
  if (!session) {
    response.status(401).json({
      message: 'No hay sesión activa.',
    });
    return;
  }

  if (!isGarminSession(session)) {
    response.status(400).json({
      message: 'Enviar entrenamientos al reloj solo está disponible para sesiones Garmin.',
    });
    return;
  }

  const weekIndex = Number(request.body?.weekIndex);
  const dayIndex = Number(request.body?.dayIndex);

  if (!Number.isInteger(weekIndex) || weekIndex < 0 || !Number.isInteger(dayIndex) || dayIndex < 0) {
    response.status(400).json({
      message: 'weekIndex y dayIndex deben ser enteros válidos.',
    });
    return;
  }

  const data = await getDashboardData(session);

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
    const result = await schedulePlanWorkoutOnGarmin(sessionToGarminAuth(session), day, data.plan.paces);
    invalidateSessionCache(session.id);
    void liveRefreshDashboardData(session);

    response.setHeader('Set-Cookie', buildSessionCookie(session.id));
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
  console.info(`[api] Garmin + Strava dashboard disponible en http://localhost:${config.port}`);
  refreshTimer = setInterval(() => {
    pruneExpiredSessions();
    pruneStravaLoginStates();
    for (const session of listSessions()) {
      void liveRefreshDashboardData(session);
    }
  }, backgroundRefreshMs);
});

const shutdown = async () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  await garminClient.close().catch(() => undefined);
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
