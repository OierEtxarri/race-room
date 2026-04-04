import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, devices } from 'playwright';

const rootDir = process.cwd();
const outDir = path.join(rootDir, 'docs', 'screenshots');
const frontendUrl = 'http://127.0.0.1:5182/';
const db = new DatabaseSync(path.join(rootDir, 'data', 'garmin-connect.sqlite'));

const sessionId = 'readme-demo-session';
const sessionPayload = {
  authenticated: true,
  provider: 'garmin',
  sessionId,
  accountLabel: 'oier.echarri@gmail.com',
  goal: {
    raceDate: '2026-05-10',
    distanceKm: 21.1,
  },
};

function parseJson(raw) {
  return raw ? JSON.parse(raw) : null;
}

function round(value, digits = 1) {
  return Number(value.toFixed(digits));
}

function buildDemoDashboard() {
  const dashboardRow = db
    .prepare(`SELECT dashboard_json FROM user_state WHERE email = 'oier.echarri@gmail.com'`)
    .get();
  const coachRow = db
    .prepare(`SELECT snapshot_json FROM coach_state WHERE account_key = 'garmin:oier.echarri@gmail.com'`)
    .get();
  const checkInRows = db
    .prepare(`
      SELECT account_key, checkin_date, energy, legs, mood, note, created_at
      FROM daily_checkin
      WHERE account_key = 'garmin:oier.echarri@gmail.com'
      ORDER BY checkin_date DESC
      LIMIT 7
    `)
    .all();

  if (!dashboardRow?.dashboard_json) {
    throw new Error('No persisted Garmin dashboard found in data/garmin-connect.sqlite');
  }

  const base = parseJson(dashboardRow.dashboard_json);
  const coachState = parseJson(coachRow?.snapshot_json);
  const latestCheckIn = checkInRows[0]
    ? {
        date: checkInRows[0].checkin_date,
        energy: checkInRows[0].energy,
        legs: checkInRows[0].legs,
        mood: checkInRows[0].mood,
        note: checkInRows[0].note,
        createdAt: checkInRows[0].created_at,
      }
    : null;

  const vo2TrendSeed = [
    50.2,
    50.4,
    50.5,
    50.7,
    50.8,
    51,
    51,
    51.1,
    51.2,
    51.1,
  ];

  const vo2Trend = base.vo2Trend?.some((entry) => entry.value !== null)
    ? base.vo2Trend
    : base.wellnessTrend.slice(-vo2TrendSeed.length).map((entry, index) => ({
        date: entry.date,
        label: entry.label,
        value: vo2TrendSeed[index],
      }));

  const recentRuns = (base.recentRuns ?? []).slice(0, 6).map((run, index) => ({
    ...run,
    timeLabel: ['11:39', '19:45', '20:01', '18:22', '17:58', '09:12'][index] ?? null,
  }));

  const weekAdjustments = new Map(
    (coachState?.weekAdjustments ?? []).map((adjustment) => [adjustment.weekIndex, adjustment]),
  );

  const plan = {
    ...base.plan,
    summary:
      coachState?.planSummary
      ?? base.plan.summary
      ?? 'Carga controlada, base útil y foco claro hacia la media maratón.',
    weeks: base.plan.weeks.map((week, index) => {
      const adjustment = weekAdjustments.get(index);
      if (!adjustment) {
        return week;
      }

      return {
        ...week,
        focus: adjustment.focus ?? week.focus,
        targetKm:
          typeof week.targetKm === 'number'
            ? Math.max(0, round(week.targetKm + (adjustment.targetKmDelta ?? 0), 1))
            : week.targetKm,
        coachNote: adjustment.coachNote ?? null,
      };
    }),
  };

  return {
    provider: {
      key: 'garmin',
      label: 'Garmin',
      supportsWorkoutPush: true,
      supportsWellness: true,
    },
    athlete: {
      name: base.athlete.name ?? 'Oier',
      location: 'Bilbao, Bizkaia',
      primaryDevice: base.athlete.primaryDevice ?? 'Forerunner 965',
      avatarPath: '/api/athlete/avatar',
      raceDate: base.athlete.raceDate ?? base.goal.raceDate,
      daysToRace: base.athlete.daysToRace ?? base.goal.daysToRace,
    },
    goal: base.goal,
    overview: {
      ...base.overview,
      vo2Max: base.overview.vo2Max ?? 51,
    },
    wellnessTrend: base.wellnessTrend,
    weeklyRunning: base.weeklyRunning,
    vo2Trend,
    recentRuns,
    fitnessSummary: {
      title: coachState?.fitnessTitle ?? 'Protección y base',
      body:
        coachState?.fitnessBody
        ?? 'Protege la recuperación. Enfócate en base aeróbica, calidad controlada y piernas frescas.',
    },
    adaptive: base.adaptive,
    advice: base.advice.slice(0, 4),
    checkIn: {
      needsToday: false,
      latest: latestCheckIn,
      recent: checkInRows.map((row) => ({
        date: row.checkin_date,
        energy: row.energy,
        legs: row.legs,
        mood: row.mood,
        note: row.note,
        createdAt: row.created_at,
      })),
    },
    coach: {
      enabled: true,
      source: coachState?.source === 'gemma4' ? 'gemma4' : 'fallback',
      model: coachState?.model ?? 'gemma4:e2b',
      generatedAt: coachState?.generatedAt ?? new Date().toISOString(),
      todayMessage:
        coachState?.todayMessage ?? 'Escucha tu cuerpo. Rodaje suave hoy y deja que la carga asiente.',
      weeklyReview: coachState?.weeklyReview ?? null,
      latestDebrief: coachState?.latestDebrief ?? null,
    },
    plan,
    fetchedAt: new Date().toISOString(),
  };
}

function buildDemoRoute() {
  const points = [
    [43.2668, -2.9481],
    [43.2689, -2.9511],
    [43.2708, -2.9558],
    [43.2724, -2.9595],
    [43.2713, -2.9657],
    [43.2682, -2.9705],
    [43.2657, -2.9728],
    [43.2622, -2.9694],
    [43.2598, -2.9641],
    [43.2584, -2.9588],
    [43.2599, -2.9527],
    [43.2627, -2.9484],
    [43.2651, -2.9459],
  ];

  const paceSeries = [388, 381, 374, 366, 358, 351, 346, 352, 360, 371, 378, 369, 362];

  return {
    points,
    samples: points.map((point, index) => ({
      point,
      paceSecondsPerKm: paceSeries[index] ?? null,
      timestampSeconds: index * 300,
    })),
    source: 'garmin',
  };
}

function buildAvatarSvg() {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240" fill="none">
      <defs>
        <linearGradient id="avatar" x1="36" y1="24" x2="204" y2="216" gradientUnits="userSpaceOnUse">
          <stop stop-color="#68B6FF" />
          <stop offset="0.55" stop-color="#2E63FF" />
          <stop offset="1" stop-color="#FF5A4D" />
        </linearGradient>
      </defs>
      <rect width="240" height="240" rx="120" fill="#11161F"/>
      <circle cx="120" cy="120" r="108" fill="url(#avatar)" />
      <circle cx="120" cy="120" r="96" fill="rgba(17, 22, 31, 0.16)" />
      <text x="120" y="142" text-anchor="middle" font-size="92" font-weight="700" font-family="Inter, Arial, sans-serif" fill="white">OE</text>
    </svg>
  `.trim();
}

function buildCoachReply(question) {
  const normalized = question.toLowerCase();

  if (normalized.includes('gemelo') || normalized.includes('dolor') || normalized.includes('molest')) {
    return {
      answer: 'Baja hoy a descanso activo o 20-30 min muy suaves. Si el dolor apareció en apoyo o al subir ritmo, no metas calidad hasta que el gemelo esté estable.',
      action: 'Movilidad suave de tobillo, gemelo y sóleo. Si duele caminando o al trotar, para.',
      followUp: 'Vigila si el dolor mejora tras calentar o si va a más.',
      source: 'gemma4',
      memory: [
        {
          title: 'Check-in reciente',
          detail: 'Piernas pesadas y cansancio declarado hoy.',
        },
      ],
      tools: [
        { name: 'get_latest_run', label: 'Último entreno', detail: 'Lee el rodaje más reciente' },
        { name: 'search_memory', label: 'Memoria', detail: 'Busca patrones parecidos' },
      ],
    };
  }

  if (normalized.includes('mañana')) {
    return {
      answer: 'Mañana haría rodaje fácil y corto para absorber la carga reciente. La prioridad es llegar fresco al siguiente bloque de calidad.',
      action: '40 min suaves, sin progresivos, y termina con movilidad breve.',
      followUp: 'Si amaneces peor, cambia a paseo + core.',
      source: 'gemma4',
      memory: [
        {
          title: 'Semana parecida',
          detail: 'Protección de carga antes de retomar calidad.',
        },
      ],
      tools: [
        { name: 'get_plan_week', label: 'Plan semanal', detail: 'Cruza la semana activa' },
        { name: 'get_recent_runs', label: 'Rodajes recientes', detail: 'Lee la carga de los últimos días' },
      ],
    };
  }

  return {
    answer: 'Tu estado pide control: volumen sostenido, calidad útil y cero épica. Estás mejor consolidando que apretando ahora.',
    action: 'Prioriza una semana limpia y evita sumar fatiga oculta.',
    followUp: 'Si quieres, ajusta mañana o revisa una molestia concreta.',
    source: 'gemma4',
    memory: [
      {
        title: 'Lectura semanal',
        detail: 'Protección de carga y recuperación controlada.',
      },
    ],
    tools: [
      { name: 'get_adaptive_summary', label: 'Lectura adaptativa', detail: 'Cruza carga, recuperación y ritmo' },
    ],
  };
}

async function primeContext(context) {
  await context.addInitScript(({ sid }) => {
    window.sessionStorage.setItem('garmin_race_room_session_id', sid);
    window.sessionStorage.setItem('garmin_race_room_session_provider', 'garmin');
  }, { sid: sessionId });
}

async function installMockApi(context, dashboard) {
  const routeData = buildDemoRoute();
  const avatarSvg = buildAvatarSvg();

  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    const json = async (payload, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });

    if (pathname === '/api/session' && method === 'GET') {
      await json(sessionPayload);
      return;
    }

    if (pathname === '/api/dashboard' && method === 'GET') {
      await json(dashboard);
      return;
    }

    if (pathname.startsWith('/api/activity/') && pathname.endsWith('/route') && method === 'GET') {
      await json(routeData);
      return;
    }

    if (pathname === '/api/athlete/avatar' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: avatarSvg,
      });
      return;
    }

    if (pathname === '/api/coach/chat' && method === 'POST') {
      const payload = parseJson(request.postData() || '{}') ?? {};
      await json(buildCoachReply(payload.question ?? ''));
      return;
    }

    if (pathname === '/api/coach/what-if' && method === 'POST') {
      await json({
        scenario: {
          headline: 'Semana más ligera, mismo objetivo',
          summary: 'Con 4 días útiles mantienes el objetivo, pero conviene recortar un poco la intensidad.',
          risk: 'medium',
          stance: 'Conserva el objetivo y protege la sesión clave.',
          adjustments: [
            'Baja 4-5 km respecto a la semana actual.',
            'Deja solo una sesión de calidad.',
            'Haz la tirada larga controlada.',
          ],
          sampleWeek: [
            'Martes: calidad corta',
            'Jueves: rodaje fácil',
            'Sábado: técnica + soltura',
            'Domingo: tirada larga controlada',
          ],
          recommendedGoal: dashboard.goal,
        },
      });
      return;
    }

    if (pathname === '/api/checkin' && method === 'POST') {
      await json({ ok: true });
      return;
    }

    if (pathname === '/api/session/goal' && method === 'PUT') {
      await json({ goal: dashboard.goal });
      return;
    }

    if (pathname === '/api/session/logout' && method === 'POST') {
      await json({ ok: true });
      return;
    }

    await route.continue();
  });
}

async function waitForPageReady(page, sectionId) {
  await page.goto(`${frontendUrl}#${sectionId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.dashboard-layout', { timeout: 120_000 });
  await page.waitForSelector('.dashboard-page.active', { timeout: 120_000 });
  await page.waitForFunction(
    (section) => {
      const active = document.querySelector('.dashboard-page.active');
      const target = document.getElementById(`section-${section}`);
      return Boolean(active && target && active.contains(target));
    },
    sectionId,
    { timeout: 120_000 },
  );
  await page.waitForTimeout(1200);
}

async function capturePage(page, sectionId, filename, clipSelector = '.dashboard-layout') {
  await waitForPageReady(page, sectionId);
  const element = page.locator(clipSelector);
  await element.screenshot({ path: path.join(outDir, filename) });
}

async function captureCoachPage(page) {
  await waitForPageReady(page, 'coach');
  const textarea = page.locator('.coach-chat-form textarea');
  await textarea.fill('¿Qué harías mañana con mis datos actuales?');
  await page.locator('.coach-chat-form button[type=\"submit\"]').click();
  await page.waitForSelector('.coach-chat-bubble.assistant:not(.thinking)', { timeout: 120_000 });
  await page.waitForTimeout(600);
  await page.locator('.dashboard-layout').screenshot({ path: path.join(outDir, 'dashboard-coach.png') });
}

async function main() {
  const dashboard = buildDemoDashboard();
  await fs.mkdir(outDir, { recursive: true });

  const desktopBrowser = await chromium.launch({ headless: true });
  const desktopContext = await desktopBrowser.newContext({
    viewport: { width: 1600, height: 1120 },
    deviceScaleFactor: 1.25,
  });
  await primeContext(desktopContext);
  await installMockApi(desktopContext, dashboard);
  const desktopPage = await desktopContext.newPage();

  await capturePage(desktopPage, 'summary', 'dashboard-summary.png');
  await capturePage(desktopPage, 'sessions', 'dashboard-sessions.png');
  await capturePage(desktopPage, 'plan', 'dashboard-plan.png');
  await captureCoachPage(desktopPage);
  await capturePage(desktopPage, 'fitness', 'dashboard-fitness.png');
  await capturePage(desktopPage, 'summary', 'dashboard-desktop.png');

  const mobileBrowser = await chromium.launch({ headless: true });
  const mobileContext = await mobileBrowser.newContext({
    ...devices['iPhone 14 Pro'],
  });
  await primeContext(mobileContext);
  await installMockApi(mobileContext, dashboard);
  const mobilePage = await mobileContext.newPage();
  await waitForPageReady(mobilePage, 'summary');
  await mobilePage.screenshot({ path: path.join(outDir, 'dashboard-mobile.png') });

  await mobileContext.close();
  await mobileBrowser.close();
  await desktopContext.close();
  await desktopBrowser.close();
}

await main();
