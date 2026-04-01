import { startTransition, useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DashboardData, SessionPayload, UserGoal } from './types';
import './App.css';

type AsyncState =
  | { status: 'loading'; data: null; error: null }
  | { status: 'unauthenticated'; data: null; error: null }
  | { status: 'ready'; data: DashboardData; error: null }
  | { status: 'error'; data: null; error: string };
type ScheduleState = {
  key: string | null;
  status: 'idle' | 'sending' | 'success' | 'error';
  message: string | null;
};
type LoginState =
  | { status: 'idle'; error: null }
  | { status: 'submitting'; error: null }
  | { status: 'hydrating'; error: null }
  | { status: 'error'; error: string };
type LoginProvider = 'garmin' | 'strava';

type ChartMetric = 'sleepHours' | 'readiness' | 'hrv' | 'steps';
const serverRefreshMs = 2 * 60 * 1_000;
const clientPollMs = 30 * 1_000;
const sessionStorageKey = 'garmin_race_room_session_id';
const sessionProviderStorageKey = 'garmin_race_room_session_provider';
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const defaultGoal: UserGoal = {
  raceDate: '2026-05-10',
  distanceKm: 21.1,
};

const chartOptions: Array<{
  key: ChartMetric;
  label: string;
  tone: string;
  unit: string;
  description: string;
}> = [
  {
    key: 'sleepHours',
    label: 'Sueño',
    tone: '#f49d37',
    unit: ' h',
    description: 'Horas de sueño útiles para asimilar la carga.',
  },
  {
    key: 'readiness',
    label: 'Readiness',
    tone: '#9b79ff',
    unit: '',
    description: 'Lectura compuesta de recuperación y disponibilidad para entrenar.',
  },
  {
    key: 'hrv',
    label: 'HRV',
    tone: '#7f8cff',
    unit: '',
    description: 'Tendencia autonómica. Más útil como serie que como valor aislado.',
  },
  {
    key: 'steps',
    label: 'Pasos',
    tone: '#c8722b',
    unit: '',
    description: 'Movimiento diario para detectar fatiga o sedentarismo entre sesiones.',
  },
];

function BrandSpinner({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="spinner-panel" aria-live="polite" aria-busy="true">
      <div className="brand-spinner" aria-hidden="true">
        <div className="brand-spinner-ring" />
        <div className="brand-spinner-core">GR</div>
      </div>
      <strong>{label}</strong>
      <p>{detail}</p>
    </div>
  );
}

function apiUrl(pathname: string) {
  return `${apiBaseUrl}${pathname}`;
}

function absoluteApiUrl(pathname: string) {
  if (typeof window === 'undefined') {
    return apiUrl(pathname);
  }

  return new URL(apiUrl(pathname), window.location.origin).toString();
}

function appReturnUrl() {
  if (typeof window === 'undefined') {
    return '/';
  }

  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

function consumeAuthRedirectParams(): {
  sessionId: string | null;
  provider: LoginProvider | null;
  error: string | null;
} {
  if (typeof window === 'undefined') {
    return {
      sessionId: null as string | null,
      provider: null as LoginProvider | null,
      error: null as string | null,
    };
  }

  const url = new URL(window.location.href);
  const sessionId = url.searchParams.get('session_id');
  const providerParam = url.searchParams.get('provider');
  const error = url.searchParams.get('auth_error');

  if (!sessionId && !providerParam && !error) {
    return {
      sessionId: null,
      provider: null,
      error: null,
    };
  }

  url.searchParams.delete('session_id');
  url.searchParams.delete('provider');
  url.searchParams.delete('auth_error');
  window.history.replaceState({}, document.title, url.toString());

  return {
    sessionId,
    provider: providerParam === 'strava' ? 'strava' : providerParam === 'garmin' ? 'garmin' : null,
    error,
  };
}

function normalizeGoalInput(goal: UserGoal): UserGoal {
  const distanceKm = Number(goal.distanceKm);

  return {
    raceDate: goal.raceDate,
    distanceKm: Number.isFinite(distanceKm) ? distanceKm : defaultGoal.distanceKm,
  };
}

function formatRace(seconds: number | null) {
  if (seconds === null) {
    return 'Sin dato';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function formatPace(seconds: number | null) {
  if (seconds === null) {
    return 'Sin dato';
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}/km`;
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes} min`;
}

function formatCountdown(ms: number) {
  if (ms <= 0) {
    return 'ahora';
  }

  const totalSeconds = Math.ceil(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }

  return `${seconds}s`;
}

function formatTrainingStatus(value: string | null) {
  if (!value) {
    return 'Sin estado';
  }

  return value
    .split('_')
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0) + chunk.slice(1).toLowerCase())
    .join(' ');
}

function formatAdaptiveOverall(value: DashboardData['adaptive']['overall']) {
  if (value === 'protect') {
    return 'Proteger';
  }

  if (value === 'push') {
    return 'Empujar';
  }

  return 'Consolidar';
}

function formatAdaptivePace(data: DashboardData['adaptive']['pace']) {
  if (data.action === 'aflojar') {
    return `+${data.secondsPerKm}s/km`;
  }

  if (data.action === 'acelerar') {
    return `-${data.secondsPerKm}s/km`;
  }

  return 'Sin cambio';
}

function formatAdaptiveVolume(data: DashboardData['adaptive']['volume']) {
  if (data.action === 'bajar') {
    return `-${data.deltaKm} km`;
  }

  if (data.action === 'subir') {
    return `+${data.deltaKm} km`;
  }

  return 'Sin cambio';
}

function formatVolumeRatio(value: number | null) {
  if (value === null) {
    return 'Sin dato';
  }

  return `${value.toFixed(2)}x`;
}

function formatComplianceRate(value: number | null) {
  if (value === null) {
    return 'Sin dato';
  }

  return `${Math.round(value * 100)}%`;
}

function formatExecutionDelta(value: number | null) {
  if (value === null || value === 0) {
    return 'Sin dato';
  }

  if (value > 0) {
    return `${value}s/km más lento`;
  }

  return `${Math.abs(value)}s/km más rápido`;
}

function formatDayStatus(status: DashboardData['plan']['weeks'][number]['days'][number]['status']) {
  switch (status) {
    case 'done':
      return 'Hecho';
    case 'missed':
      return 'Perdido';
    case 'moved':
      return 'Movido';
    case 'adjusted':
      return 'Ajustado';
    default:
      return 'Plan';
  }
}

function metricValue(value: number | null, suffix = '', digits = 0) {
  if (value === null) {
    return 'Sin dato';
  }
  return `${value.toFixed(digits)}${suffix}`;
}

function metricAverage(data: DashboardData['wellnessTrend'], key: ChartMetric) {
  const values = data
    .map((entry) => entry[key])
    .filter((value): value is number => value !== null);

  if (!values.length) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function metricPeak(data: DashboardData['wellnessTrend'], key: ChartMetric) {
  const entries = data.filter((entry) => entry[key] !== null);
  if (!entries.length) {
    return null;
  }

  return entries.reduce((best, current) => {
    if (best[key] === null) {
      return current;
    }

    if ((current[key] ?? 0) > (best[key] ?? 0)) {
      return current;
    }

    return best;
  });
}

function formatChartMetric(key: ChartMetric, value: number | null) {
  if (value === null) {
    return 'Sin dato';
  }

  if (key === 'sleepHours') {
    return `${value.toFixed(1)} h`;
  }

  if (key === 'steps') {
    return Math.round(value).toLocaleString('es-ES');
  }

  return Math.round(value).toLocaleString('es-ES');
}

function plannedDistance(week: DashboardData['plan']['weeks'][number]) {
  return week.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
}

function keySession(week: DashboardData['plan']['weeks'][number]) {
  return (
    week.days.find((day) => day.intensity === 'alto' || day.intensity === 'carrera') ??
    week.days.find((day) => day.intensity === 'medio') ??
    week.days[0]
  );
}

function longRun(week: DashboardData['plan']['weeks'][number]) {
  return week.days.reduce((best, current) => {
    if ((current.distanceKm ?? 0) > (best.distanceKm ?? 0)) {
      return current;
    }
    return best;
  }, week.days[0]);
}

function coachCue(week: DashboardData['plan']['weeks'][number], fallbackReason?: string) {
  if (fallbackReason) {
    return 'Plan provisional hasta que el proveedor vuelva a responder.';
  }

  if (week.title.toLowerCase().includes('carrera')) {
    return 'Reduce ruido. Nada nuevo esta semana: sueño, hidratación y piernas frescas.';
  }

  if (week.focus.toLowerCase().includes('taper')) {
    return 'Protege la intensidad justa y recorta volumen sin negociar.';
  }

  return 'Prioriza consistencia. La sesión clave debe salir bien, no épica.';
}

function App() {
  const [sessionId, setSessionId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : window.sessionStorage.getItem(sessionStorageKey),
  );
  const sessionIdRef = useRef<string | null>(sessionId);
  const [sessionProvider, setSessionProvider] = useState<LoginProvider | null>(() =>
    typeof window === 'undefined'
      ? null
      : ((window.sessionStorage.getItem(sessionProviderStorageKey) as LoginProvider | null) ?? null),
  );
  const [sessionAccountLabel, setSessionAccountLabel] = useState<string | null>(null);
  const [state, setState] = useState<AsyncState>({
    status: 'loading',
    data: null,
    error: null,
  });
  const [loginState, setLoginState] = useState<LoginState>({
    status: 'idle',
    error: null,
  });
  const [loginProvider, setLoginProvider] = useState<LoginProvider>('garmin');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginGoal, setLoginGoal] = useState<UserGoal>(defaultGoal);
  const [goalDraft, setGoalDraft] = useState<UserGoal>(defaultGoal);
  const [isSavingGoal, setIsSavingGoal] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState<ChartMetric>('sleepHours');
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [scheduleState, setScheduleState] = useState<ScheduleState>({
    key: null,
    status: 'idle',
    message: null,
  });
  const [clockNow, setClockNow] = useState(() => Date.now());
  const refreshInFlightRef = useRef(false);
  const isAuthBusy = loginState.status === 'submitting' || loginState.status === 'hydrating';

  useEffect(() => {
    sessionIdRef.current = sessionId;

    if (typeof window === 'undefined') {
      return;
    }

    if (sessionId) {
      window.sessionStorage.setItem(sessionStorageKey, sessionId);
    } else {
      window.sessionStorage.removeItem(sessionStorageKey);
    }
  }, [sessionId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (sessionProvider) {
      window.sessionStorage.setItem(sessionProviderStorageKey, sessionProvider);
    } else {
      window.sessionStorage.removeItem(sessionProviderStorageKey);
    }
  }, [sessionProvider]);

  const apiFetch = async (
    pathname: string,
    init: RequestInit = {},
    explicitSessionId?: string | null,
  ) => {
    const headers = new Headers(init.headers ?? {});
    const activeSessionId = explicitSessionId ?? sessionIdRef.current;

    if (activeSessionId) {
      headers.set('X-Session-Id', activeSessionId);
    }

    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    return fetch(apiUrl(pathname), {
      ...init,
      headers,
      credentials: 'include',
    });
  };

  const clearSession = () => {
    setSessionId(null);
    setSessionProvider(null);
    setSessionAccountLabel(null);
    setGoalDraft(defaultGoal);
    setLoginState({
      status: 'idle',
      error: null,
    });
    setState({
      status: 'unauthenticated',
      data: null,
      error: null,
    });
  };

  const syncSession = (payload: SessionPayload) => {
    setSessionId(payload.sessionId);
    setSessionProvider(payload.provider);
    setSessionAccountLabel(payload.accountLabel);
    setGoalDraft(payload.goal);
    setLoginGoal(payload.goal);
  };

  const loadDashboard = async (refresh = false, explicitSessionId?: string | null) => {
    if (!(explicitSessionId ?? sessionIdRef.current)) {
      setState({
        status: 'unauthenticated',
        data: null,
        error: null,
      });
      return;
    }

    if (refreshInFlightRef.current) {
      return;
    }

    refreshInFlightRef.current = true;
    if (state.status !== 'loading') {
      setIsRefreshing(true);
    }

    try {
      const response = await apiFetch(`/api/dashboard${refresh ? '?refresh=1' : ''}`, {}, explicitSessionId);

      if (response.status === 401) {
        clearSession();
        return;
      }

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.message ?? 'No se pudo cargar el dashboard.');
      }

      startTransition(() => {
        setState({
          status: 'ready',
          data: payload as DashboardData,
          error: null,
        });
        setGoalDraft({
          raceDate: (payload as DashboardData).goal.raceDate,
          distanceKm: (payload as DashboardData).goal.distanceKm,
        });
      });
    } catch (error) {
      startTransition(() => {
        setState({
          status: 'error',
          data: null,
          error: error instanceof Error ? error.message : 'Fallo inesperado',
        });
      });
    } finally {
      refreshInFlightRef.current = false;
      setIsRefreshing(false);
    }
  };

  const bootstrapSession = useEffectEvent(async (explicitSessionId?: string | null) => {
    try {
      const response = await apiFetch('/api/session', {}, explicitSessionId);

      if (response.status === 401) {
        clearSession();
        return;
      }

      const payload = (await response.json()) as SessionPayload | { message?: string };
      if (!response.ok) {
        throw new Error(('message' in payload ? payload.message : null) ?? 'No se pudo restaurar la sesión.');
      }

      syncSession(payload as SessionPayload);
      await loadDashboard(false, (payload as SessionPayload).sessionId);
    } catch (error) {
      startTransition(() => {
        setState({
          status: 'error',
          data: null,
          error: error instanceof Error ? error.message : 'Fallo inesperado',
        });
      });
    }
  });

  const pollDashboard = useEffectEvent(() => {
    if (!sessionIdRef.current) {
      return;
    }

    void loadDashboard();
  });

  useEffect(() => {
    const redirect = consumeAuthRedirectParams();

    if (redirect.provider) {
      setSessionProvider(redirect.provider);
      setLoginProvider(redirect.provider);
    }

    if (redirect.sessionId) {
      setSessionId(redirect.sessionId);
      sessionIdRef.current = redirect.sessionId;
    }

    if (redirect.error) {
      setLoginState({
        status: 'error',
        error: redirect.error,
      });
    }

    void bootstrapSession(redirect.sessionId);

    const pollId = window.setInterval(() => {
      pollDashboard();
    }, clientPollMs);

    const clockId = window.setInterval(() => {
      setClockNow(Date.now());
    }, 1_000);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        pollDashboard();
      }
    };

    const handleFocus = () => {
      pollDashboard();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);

    return () => {
      window.clearInterval(pollId);
      window.clearInterval(clockId);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  useEffect(() => {
    if (state.status !== 'ready') {
      return;
    }

    if (selectedWeekIndex > state.data.plan.weeks.length - 1) {
      setSelectedWeekIndex(0);
    }
  }, [selectedWeekIndex, state]);

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loginProvider !== 'garmin') {
      return;
    }

    setLoginState({
      status: 'submitting',
      error: null,
    });

    try {
      const response = await apiFetch('/api/session/login', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'garmin',
          garminEmail: loginEmail,
          garminPassword: loginPassword,
          goal: normalizeGoalInput(loginGoal),
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.message ?? 'No se pudo iniciar sesión con Garmin.');
      }

      const sessionPayload: SessionPayload = {
        authenticated: true,
        provider: 'garmin',
        sessionId: payload.sessionId,
        accountLabel: payload.accountLabel,
        goal: payload.goal,
      };

      syncSession(sessionPayload);
      setLoginPassword('');
      setLoginState({
        status: 'hydrating',
        error: null,
      });
      await loadDashboard(false, sessionPayload.sessionId);
      setLoginState({
        status: 'idle',
        error: null,
      });
    } catch (error) {
      setLoginState({
        status: 'error',
        error: error instanceof Error ? error.message : 'No se pudo iniciar sesión.',
      });
    }
  };

  const beginStravaLogin = () => {
    setLoginState({
      status: 'submitting',
      error: null,
    });

    const url = new URL(absoluteApiUrl('/api/session/strava/start'));
    url.searchParams.set('raceDate', loginGoal.raceDate);
    url.searchParams.set('distanceKm', String(loginGoal.distanceKm));
    url.searchParams.set('returnTo', appReturnUrl());
    window.location.assign(url.toString());
  };

  const submitGoal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sessionIdRef.current) {
      return;
    }

    setIsSavingGoal(true);

    try {
      const response = await apiFetch('/api/session/goal', {
        method: 'PUT',
        body: JSON.stringify(normalizeGoalInput(goalDraft)),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.message ?? 'No se pudo actualizar el objetivo.');
      }

      setGoalDraft(payload.goal as UserGoal);
      setLoginGoal(payload.goal as UserGoal);
      setSelectedWeekIndex(0);
      await loadDashboard(true);
    } catch (error) {
      setState({
        status: 'error',
        data: null,
        error: error instanceof Error ? error.message : 'No se pudo actualizar el objetivo.',
      });
    } finally {
      setIsSavingGoal(false);
    }
  };

  const logout = async () => {
    try {
      await apiFetch('/api/session/logout', {
        method: 'POST',
      });
    } finally {
      clearSession();
    }
  };

  if (state.status === 'loading') {
    return (
      <main className="app-shell">
        <section className="status-panel">
          <p className="eyebrow">Garmin Race Room</p>
          <BrandSpinner
            label="Cargando tu último estado"
            detail="Primero restauro la sesión y el plan persistido; después refresco el proveedor activo."
          />
        </section>
      </main>
    );
  }

  if (state.status === 'unauthenticated') {
    return (
      <main className="app-shell auth-shell">
        <section className="auth-panel">
          <div className="auth-copy">
            <p className="eyebrow">Garmin Race Room</p>
            <h1>Entra con Garmin o Strava</h1>
            <p className="lead">
              Elige el proveedor con el que quieres cargar tus datos. Garmin entra por credenciales efímeras;
              Strava entra por OAuth. En ambos casos persisto solo el objetivo y el último dashboard/plan generado.
            </p>
            <div className="hero-meta">
              <span>Login dual Garmin + Strava</span>
              <span>Session ID efímero por usuario</span>
              <span>Plan persistido en SQLite</span>
            </div>
          </div>

          <form className="auth-form" onSubmit={submitLogin}>
            <div className="provider-switch">
              <button
                className={`provider-pill ${loginProvider === 'garmin' ? 'selected' : ''}`}
                disabled={isAuthBusy}
                onClick={() => setLoginProvider('garmin')}
                type="button"
              >
                Garmin
              </button>
              <button
                className={`provider-pill ${loginProvider === 'strava' ? 'selected' : ''}`}
                disabled={isAuthBusy}
                onClick={() => setLoginProvider('strava')}
                type="button"
              >
                Strava
              </button>
            </div>

            {loginProvider === 'garmin' ? (
              <>
                <label className="form-field">
                  <span>Email Garmin</span>
                  <input
                    autoComplete="username"
                    disabled={isAuthBusy}
                    onChange={(event) => setLoginEmail(event.target.value)}
                    placeholder="tu@email.com"
                    type="email"
                    value={loginEmail}
                  />
                </label>

                <label className="form-field">
                  <span>Password Garmin</span>
                  <input
                    autoComplete="current-password"
                    disabled={isAuthBusy}
                    onChange={(event) => setLoginPassword(event.target.value)}
                    placeholder="••••••••"
                    type="password"
                    value={loginPassword}
                  />
                </label>
              </>
            ) : (
              <div className="provider-note">
                <strong>Strava usa OAuth.</strong>
                <p>
                  Al pulsar el botón irás a la pantalla oficial de Strava y volverás aquí con la
                  sesión ya abierta. El backend necesita `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`
                  y `STRAVA_REDIRECT_URI`.
                </p>
              </div>
            )}

            <div className="field-grid">
              <label className="form-field">
                <span>Fecha objetivo</span>
                <input
                  disabled={isAuthBusy}
                  onChange={(event) =>
                    setLoginGoal((current) => ({
                      ...current,
                      raceDate: event.target.value,
                    }))
                  }
                  type="date"
                  value={loginGoal.raceDate}
                />
              </label>

              <label className="form-field">
                <span>Distancia</span>
                <input
                  disabled={isAuthBusy}
                  min="3"
                  onChange={(event) =>
                    setLoginGoal((current) => ({
                      ...current,
                      distanceKm: Number(event.target.value),
                    }))
                  }
                  step="0.1"
                  type="number"
                  value={loginGoal.distanceKm}
                />
              </label>
            </div>

            {loginState.error ? <p className="form-error">{loginState.error}</p> : null}

            {loginProvider === 'garmin' ? (
              <button
                className="action-button"
                disabled={isAuthBusy}
                type="submit"
              >
                {loginState.status === 'submitting'
                  ? 'Abriendo sesión...'
                  : loginState.status === 'hydrating'
                    ? 'Cargando dashboard...'
                    : 'Entrar con Garmin'}
              </button>
            ) : (
              <button
                className="action-button"
                disabled={isAuthBusy}
                onClick={beginStravaLogin}
                type="button"
              >
                {loginState.status === 'submitting' ? 'Redirigiendo a Strava...' : 'Entrar con Strava'}
              </button>
            )}

            {isAuthBusy ? (
              <BrandSpinner
                label={
                  loginState.status === 'submitting'
                    ? loginProvider === 'garmin'
                      ? 'Abriendo sesión'
                      : 'Redirigiendo a Strava'
                    : 'Cargando dashboard'
                }
                detail="La sesión ya está en marcha. Bloqueo el formulario hasta terminar la hidratación inicial."
              />
            ) : null}
          </form>
        </section>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main className="app-shell">
        <section className="status-panel error">
          <p className="eyebrow">Error de conexión</p>
          <h1>No he podido levantar el dashboard.</h1>
          <p>{state.error}</p>
          <button className="action-button" onClick={() => void bootstrapSession()}>
            Reintentar
          </button>
        </section>
      </main>
    );
  }

  const data = state.data;
  const selectedMetricMeta = chartOptions.find((option) => option.key === selectedMetric) ?? chartOptions[0];
  const selectedWeek = data.plan.weeks[selectedWeekIndex] ?? data.plan.weeks[0];
  const selectedRun =
    data.recentRuns.find((run) => run.id === selectedRunId) ??
    data.recentRuns[0] ??
    null;
  const averageValue = metricAverage(data.wellnessTrend, selectedMetric);
  const peakValue = metricPeak(data.wellnessTrend, selectedMetric);
  const selectedWeekKm = selectedWeek ? plannedDistance(selectedWeek) : 0;
  const selectedKeySession = selectedWeek ? keySession(selectedWeek) : null;
  const selectedLongRun = selectedWeek ? longRun(selectedWeek) : null;
  const selectedWeekQualityDays = selectedWeek
    ? selectedWeek.days.filter((day) => day.intensity === 'alto' || day.intensity === 'medio' || day.intensity === 'carrera').length
    : 0;
  const nextSyncAt = new Date(data.fetchedAt).getTime() + serverRefreshMs;
  const nextSyncIn = nextSyncAt - clockNow;
  const syncTone = data.fallbackReason ? 'warning' : isRefreshing ? 'syncing' : 'live';
  const syncLabel = data.fallbackReason ? 'Modo provisional' : isRefreshing ? 'Sincronizando' : 'Live';
  const scheduleWorkout = async (weekIndex: number, dayIndex: number) => {
    const day = data.plan.weeks[weekIndex]?.days[dayIndex];
    if (!day) {
      return;
    }

    const requestKey = `${weekIndex}-${dayIndex}`;
    setScheduleState({
      key: requestKey,
      status: 'sending',
      message: null,
    });

    try {
      const response = await apiFetch('/api/plan/workout', {
        method: 'POST',
        body: JSON.stringify({
          weekIndex,
          dayIndex,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.message ?? 'No se pudo enviar el entrenamiento al proveedor activo.');
      }

      setScheduleState({
        key: requestKey,
        status: 'success',
        message: `${day.title} ya está programado para el ${day.date}.`,
      });
      void loadDashboard(true);
    } catch (error) {
      setScheduleState({
        key: requestKey,
        status: 'error',
        message: error instanceof Error ? error.message : 'Error inesperado al programar el entrenamiento.',
      });
    }
  };

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Garmin Race Room</p>
          <h1>{data.athlete.name}</h1>
          <p className="lead">
            Dashboard interactivo para preparar {data.goal.label} del {data.goal.raceDate}. Cruza
            recuperación, volumen, rendimiento y plan semanal en una sola vista y arranca con el plan persistido si ya existe.
          </p>
          <div className="hero-meta">
            <span>{data.provider.label}</span>
            <span>{data.goal.daysToRace} días para {data.goal.raceTitle.toLowerCase()}</span>
            <span>{data.goal.totalWeeks} semanas de plan</span>
            {data.athlete.primaryDevice ? <span>{data.athlete.primaryDevice}</span> : null}
            {data.athlete.location ? <span>{data.athlete.location}</span> : null}
            {sessionAccountLabel ? <span>{sessionAccountLabel}</span> : null}
            <span>
              {data.provider.key === 'garmin'
                ? 'Re-login Garmin automático activo'
                : 'Refresh OAuth de Strava automático activo'}
            </span>
          </div>
          <div className="hero-actions">
            <div className={`sync-chip ${syncTone}`}>
              <span className="metric-label">Estado</span>
              <strong>{syncLabel}</strong>
              <small>
                Última sync {new Date(data.fetchedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
                {' · '}
                Próxima en {formatCountdown(nextSyncIn)}
              </small>
            </div>
            <button
              className="action-button"
              disabled={isRefreshing}
              onClick={() => void loadDashboard(true)}
              type="button"
            >
              {isRefreshing ? 'Actualizando...' : 'Refrescar ahora'}
            </button>
            <button className="secondary-button" onClick={() => void logout()} type="button">
              Cerrar sesión
            </button>
          </div>
          {data.fallbackReason ? (
            <div className="warning-banner">
              {data.provider.label} no ha entregado datos reales en este intento: {data.fallbackReason}
            </div>
          ) : null}
        </div>

        <form className="goal-editor" onSubmit={submitGoal}>
          <div className="panel-head">
            <div>
              <p className="eyebrow">Objetivo</p>
              <h2>{data.goal.raceTitle}</h2>
            </div>
          </div>
          <div className="field-grid">
            <label className="form-field">
              <span>Fecha</span>
              <input
                onChange={(event) =>
                  setGoalDraft((current) => ({
                    ...current,
                    raceDate: event.target.value,
                  }))
                }
                type="date"
                value={goalDraft.raceDate}
              />
            </label>
            <label className="form-field">
              <span>Distancia</span>
              <input
                min="3"
                onChange={(event) =>
                  setGoalDraft((current) => ({
                    ...current,
                    distanceKm: Number(event.target.value),
                  }))
                }
                step="0.1"
                type="number"
                value={goalDraft.distanceKm}
              />
            </label>
          </div>
          <p className="goal-note">
            El objetivo manda sobre el número de semanas, la distribución de calidad y el ritmo sugerido.
          </p>
          <button className="action-button" disabled={isSavingGoal} type="submit">
            {isSavingGoal ? 'Guardando...' : 'Actualizar objetivo'}
          </button>
        </form>

        <div className="hero-scoreboard">
          <div className="score-card primary">
            <span className="score-label">Predicción objetivo</span>
            <strong>{formatRace(data.overview.predictedGoalSeconds)}</strong>
            <small>Ritmo objetivo {data.plan.paces.race ?? 'pendiente'}</small>
          </div>
          <div className="score-card">
            <span className="score-label">Readiness</span>
            <strong>{metricValue(data.overview.readiness)}</strong>
            <small>{formatTrainingStatus(data.overview.trainingStatus)}</small>
          </div>
          <div className="score-card">
            <span className="score-label">Volumen</span>
            <strong>{metricValue(data.overview.averageWeeklyKm, ' km', 1)}</strong>
            <small>Tirada larga {metricValue(data.overview.longestRunKm, ' km', 1)}</small>
          </div>
        </div>
      </section>

      <section className="metrics-grid">
        <article className="metric-card">
          <span className="metric-label">Sueño</span>
          <strong>{metricValue(data.overview.sleepHours, ' h', 1)}</strong>
          <small>Score {metricValue(data.overview.sleepScore)}</small>
        </article>
        <article className="metric-card">
          <span className="metric-label">HRV</span>
          <strong>{metricValue(data.overview.hrv)}</strong>
          <small>Última noche válida</small>
        </article>
        <article className="metric-card">
          <span className="metric-label">VO2 Max</span>
          <strong>{metricValue(data.overview.vo2Max, '', 0)}</strong>
          <small>Tendencia reciente</small>
        </article>
        <article className="metric-card">
          <span className="metric-label">Pasos</span>
          <strong>{metricValue(data.overview.steps)}</strong>
          <small>Resumen del último día completo</small>
        </article>
        <article className="metric-card">
          <span className="metric-label">Calorías activas</span>
          <strong>{metricValue(data.overview.activeCalories)}</strong>
          <small>Actividad diaria</small>
        </article>
        <article className="metric-card">
          <span className="metric-label">Peso</span>
          <strong>{metricValue(data.overview.weightKg, ' kg', 1)}</strong>
          <small>{data.provider.key === 'garmin' ? 'Último registro en Garmin' : 'Dato no disponible en Strava'}</small>
        </article>
      </section>

      <section className="panel adaptive-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Plan adaptativo</p>
            <h2>Ajuste automático según tus últimas sesiones</h2>
          </div>
          <span className={`adaptive-badge ${data.adaptive.overall}`}>
            {formatAdaptiveOverall(data.adaptive.overall)}
          </span>
        </div>

        <p className="chart-description">{data.adaptive.primaryNeed}</p>

        <div className="adaptive-grid">
          <article className="stat-pill">
            <span className="metric-label">Volumen</span>
            <strong>{formatAdaptiveVolume(data.adaptive.volume)}</strong>
            <small>{data.adaptive.volume.rationale}</small>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Ritmos</span>
            <strong>{formatAdaptivePace(data.adaptive.pace)}</strong>
            <small>{data.adaptive.pace.rationale}</small>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Recuperación</span>
            <strong>{formatTrainingStatus(data.adaptive.recovery.action)}</strong>
            <small>{data.adaptive.recovery.rationale}</small>
          </article>
        </div>

        <div className="signal-strip">
          <article className="stat-pill">
            <span className="metric-label">Km 7d</span>
            <strong>{metricValue(data.adaptive.signals.recent7Km, ' km', 1)}</strong>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Base semanal</span>
            <strong>{metricValue(data.adaptive.signals.baselineWeeklyKm, ' km', 1)}</strong>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Ratio carga</span>
            <strong>{formatVolumeRatio(data.adaptive.signals.volumeRatio)}</strong>
          </article>
          <article className="stat-pill">
            <span className="metric-label">ACWR</span>
            <strong>{metricValue(data.adaptive.signals.acuteChronicRatio, '', 2)}</strong>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Calidad 14d</span>
            <strong>{data.adaptive.signals.qualitySessions14d}</strong>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Tirada larga</span>
            <strong>{metricValue(data.adaptive.signals.lastLongRunKm, ' km', 1)}</strong>
          </article>
        </div>

        <div className="signal-strip">
          <article className="stat-pill">
            <span className="metric-label">Cumplimiento 7d</span>
            <strong>{formatComplianceRate(data.adaptive.signals.complianceRate7d)}</strong>
            <small>
              {data.adaptive.signals.completedSessions7d}/{data.adaptive.signals.plannedSessions7d} sesiones
            </small>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Sesiones perdidas</span>
            <strong>{data.adaptive.signals.missedSessions7d}</strong>
            <small>{data.adaptive.signals.movedSessions7d} reubicadas</small>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Calidad real</span>
            <strong>{formatExecutionDelta(data.adaptive.signals.qualityPaceDeltaSeconds)}</strong>
            <small>vs ritmo previsto</small>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Rodajes suaves</span>
            <strong>{formatExecutionDelta(data.adaptive.signals.easyPaceDeltaSeconds)}</strong>
            <small>disciplina de recuperación</small>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Noches cortas</span>
            <strong>{data.adaptive.signals.lowSleepDays7d}</strong>
            <small>últimos 7 días</small>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Readiness bajo</span>
            <strong>{data.adaptive.signals.lowReadinessDays7d}</strong>
            <small>últimos 7 días</small>
          </article>
        </div>

        {data.adaptive.signals.loadBalanceFeedback ? (
          <p className="adaptive-footnote">
            Señal de balance de carga {data.provider.label}:{' '}
            <strong>{formatTrainingStatus(data.adaptive.signals.loadBalanceFeedback)}</strong>
          </p>
        ) : null}
        {data.adaptive.signals.keySessionRelocatedTo ? (
          <p className="adaptive-footnote">
            La sesión clave perdida se ha reubicado automáticamente al{' '}
            <strong>{data.adaptive.signals.keySessionRelocatedTo}</strong>.
          </p>
        ) : null}
      </section>

      <section className="insight-grid">
        <article className="panel chart-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Métrica interactiva</p>
              <h2>{selectedMetricMeta.label} en contexto</h2>
            </div>
            <div className="segmented-control">
              {chartOptions.map((option) => (
                <button
                  key={option.key}
                  className={`segmented-button ${selectedMetric === option.key ? 'selected' : ''}`}
                  onClick={() => setSelectedMetric(option.key)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <p className="chart-description">{selectedMetricMeta.description}</p>

          <div className="chart-wrap tall">
            <ResponsiveContainer width="100%" height="100%">
              {selectedMetric === 'steps' ? (
                <BarChart data={data.wellnessTrend}>
                  <CartesianGrid stroke="rgba(29, 34, 42, 0.08)" vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Bar dataKey="steps" radius={[14, 14, 0, 0]} name="Pasos">
                    {data.wellnessTrend.map((entry) => (
                      <Cell key={entry.date} fill={selectedMetricMeta.tone} />
                    ))}
                  </Bar>
                </BarChart>
              ) : (
                <AreaChart data={data.wellnessTrend}>
                  <defs>
                    <linearGradient id="metricFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={selectedMetricMeta.tone} stopOpacity={0.45} />
                      <stop offset="95%" stopColor={selectedMetricMeta.tone} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(29, 34, 42, 0.08)" vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Area
                    type="monotone"
                    dataKey={selectedMetric}
                    stroke={selectedMetricMeta.tone}
                    fill="url(#metricFill)"
                    strokeWidth={2.5}
                    name={selectedMetricMeta.label}
                  />
                </AreaChart>
              )}
            </ResponsiveContainer>
          </div>

          <div className="chart-stat-strip">
            <article className="stat-pill">
              <span className="metric-label">Media 14d</span>
              <strong>{formatChartMetric(selectedMetric, averageValue)}</strong>
            </article>
            <article className="stat-pill">
              <span className="metric-label">Mejor día</span>
              <strong>{peakValue ? peakValue.label : 'Sin dato'}</strong>
            </article>
            <article className="stat-pill">
              <span className="metric-label">Valor pico</span>
              <strong>{formatChartMetric(selectedMetric, peakValue?.[selectedMetric] ?? null)}</strong>
            </article>
          </div>
        </article>

        <article className="panel chart-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Carga</p>
              <h2>Volumen semanal de running</h2>
            </div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.weeklyRunning}>
                <CartesianGrid stroke="rgba(29, 34, 42, 0.08)" vertical={false} />
                <XAxis dataKey="weekLabel" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} />
                <Tooltip />
                <Bar dataKey="distanceKm" radius={[14, 14, 0, 0]} name="Km">
                  {data.weeklyRunning.map((entry) => (
                    <Cell
                      key={entry.weekLabel}
                      fill={entry.runCount >= 4 ? '#9b79ff' : '#c8722b'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>

        <article className="panel chart-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Rendimiento</p>
              <h2>Tendencia de VO2 Max</h2>
            </div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.vo2Trend}>
                <defs>
                  <linearGradient id="vo2Fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#7f8cff" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#7f8cff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(29, 34, 42, 0.08)" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} />
                <Tooltip />
                <Area type="monotone" dataKey="value" stroke="#7f8cff" fill="url(#vo2Fill)" strokeWidth={2.5} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </article>
      </section>

      <section className="focus-grid">
        <article className="panel advice-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Consejos</p>
              <h2>Lo importante para {data.goal.label}</h2>
            </div>
          </div>
          <div className="advice-list">
            {data.advice.map((item) => (
              <article className={`advice-card ${item.tone}`} key={item.title}>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </article>

        <article className="panel recent-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Sesiones recientes</p>
              <h2>Detalle de rodaje</h2>
            </div>
            <span className="mini-status">
              {isRefreshing
                ? `Actualizando con ${data.provider.label}...`
                : `Auto refresh cada ${Math.round(serverRefreshMs / 60_000)} min`}
            </span>
          </div>

          {selectedRun ? (
            <div className="recent-layout">
              <div className="run-list">
                {data.recentRuns.map((run) => (
                  <button
                    className={`run-row run-select ${selectedRun.id === run.id ? 'selected' : ''}`}
                    key={run.id}
                    onClick={() => setSelectedRunId(run.id)}
                    type="button"
                  >
                    <div>
                      <strong>{run.name}</strong>
                      <span>{run.date}</span>
                    </div>
                    <div>
                      <strong>{metricValue(run.distanceKm, ' km', 1)}</strong>
                      <span>{formatDuration(run.durationSeconds)}</span>
                    </div>
                    <div>
                      <strong>{formatPace(run.paceSecondsPerKm)}</strong>
                      <span>{run.averageHeartRate ? `${run.averageHeartRate} bpm` : 'Sin FC'}</span>
                    </div>
                  </button>
                ))}
              </div>

              <aside className="run-spotlight">
                <p className="eyebrow">Sesión elegida</p>
                <h3>{selectedRun.name}</h3>
                <div className="spotlight-grid">
                  <article className="stat-pill">
                    <span className="metric-label">Distancia</span>
                    <strong>{metricValue(selectedRun.distanceKm, ' km', 1)}</strong>
                  </article>
                  <article className="stat-pill">
                    <span className="metric-label">Ritmo</span>
                    <strong>{formatPace(selectedRun.paceSecondsPerKm)}</strong>
                  </article>
                  <article className="stat-pill">
                    <span className="metric-label">FC media</span>
                    <strong>{metricValue(selectedRun.averageHeartRate)}</strong>
                  </article>
                  <article className="stat-pill">
                    <span className="metric-label">Desnivel</span>
                    <strong>{metricValue(selectedRun.elevationGain, ' m')}</strong>
                  </article>
                </div>
                <p className="spotlight-note">
                  {selectedRun.trainingEffect
                    ? `Training Effect ${selectedRun.trainingEffect.toFixed(1)}${selectedRun.trainingLoad ? ` · carga ${selectedRun.trainingLoad.toFixed(0)}` : ''}. Buena referencia para calibrar si la calidad está dejando el estímulo justo o demasiada fatiga.`
                    : 'Sin Training Effect disponible. Usa esta sesión como referencia de sensaciones, ritmo y deriva cardíaca.'}
                </p>
              </aside>
            </div>
          ) : (
            <p className="chart-description">
              {data.provider.label} todavía no ha devuelto actividades recientes. En cuanto sincronice, aquí podrás
              entrar a cada rodaje.
            </p>
          )}
        </article>
      </section>

      <section className="panel plan-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Plan semanal</p>
            <h2>Ruta hacia tu {data.goal.label}</h2>
          </div>
          <div className="pace-pills">
            {data.plan.paces.easy ? <span>Easy {data.plan.paces.easy}</span> : null}
            {data.plan.paces.tempo ? <span>Tempo {data.plan.paces.tempo}</span> : null}
            {data.plan.paces.race ? <span>Race {data.plan.paces.race}</span> : null}
          </div>
        </div>

        <p className="plan-summary">{data.plan.summary}</p>
        <p className="adaptive-footnote">
          El plan se recalcula con cada sync, pero primero se carga la última versión persistida.
          {data.provider.supportsWorkoutPush
            ? ' Si un día futuro es compatible, puedes enviarlo a Garmin desde aquí.'
            : ' En sesiones Strava el plan es de lectura y ajuste; no hay envío directo de workouts.'}
        </p>

        <div className="week-tabs">
          {data.plan.weeks.map((week, index) => (
            <button
              className={`week-tab ${selectedWeekIndex === index ? 'selected' : ''}`}
              key={week.title}
              onClick={() => setSelectedWeekIndex(index)}
              type="button"
            >
              <strong>{week.title}</strong>
              <span>{week.targetKm ? `${week.targetKm.toFixed(1)} km objetivo` : 'Semana clave'}</span>
            </button>
          ))}
        </div>

        {selectedWeek ? (
          <>
            <div className="plan-kpis">
              <article className="stat-pill">
                <span className="metric-label">Km planificados</span>
                <strong>{selectedWeekKm.toFixed(1)} km</strong>
              </article>
              <article className="stat-pill">
                <span className="metric-label">Sesión clave</span>
                <strong>{selectedKeySession?.title ?? 'Sin dato'}</strong>
              </article>
              <article className="stat-pill">
                <span className="metric-label">Tirada larga</span>
                <strong>{selectedLongRun?.distanceKm ? `${selectedLongRun.distanceKm.toFixed(1)} km` : 'Off'}</strong>
              </article>
              <article className="stat-pill">
                <span className="metric-label">Días de calidad</span>
                <strong>{selectedWeekQualityDays}</strong>
              </article>
            </div>

            <div className="selected-week-panel">
              <div className="week-head">
                <div>
                  <h3>{selectedWeek.title}</h3>
                  <p>{selectedWeek.focus}</p>
                </div>
                <strong>{coachCue(selectedWeek, data.fallbackReason)}</strong>
              </div>

              <div className="day-list">
                {selectedWeek.days.map((day, dayIndex) => {
                  const dayKey = `${selectedWeekIndex}-${dayIndex}`;
                  const isSending = scheduleState.status === 'sending' && scheduleState.key === dayKey;
                  const showFeedback = scheduleState.key === dayKey && scheduleState.message;

                  return (
                    <div className={`day-row intensity-${day.intensity}`} key={`${selectedWeek.title}-${day.date}`}>
                      <div className="day-date">
                        <strong>{day.weekday.slice(0, 3)}</strong>
                        <span>{day.date}</span>
                      </div>
                      <div className="day-main">
                        <div className="day-title-row">
                          <strong>{day.title}</strong>
                          <span className={`day-status ${day.status}`}>{formatDayStatus(day.status)}</span>
                        </div>
                        <p>{day.notes}</p>
                        {day.outcome ? <p className="day-outcome">{day.outcome}</p> : null}
                        {showFeedback ? (
                          <p className={`day-feedback ${scheduleState.status}`}>{scheduleState.message}</p>
                        ) : null}
                      </div>
                      <div className="day-actions">
                        <div className="day-distance">
                          {day.distanceKm ? `${day.distanceKm.toFixed(1)} km` : 'Off'}
                        </div>
                        {day.canSendToGarmin && !data.fallbackReason ? (
                          <button
                            className="day-button"
                            disabled={isSending}
                            onClick={() => void scheduleWorkout(selectedWeekIndex, dayIndex)}
                            type="button"
                          >
                            {isSending ? 'Enviando...' : 'Enviar a Garmin'}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="weeks-grid">
              {data.plan.weeks.map((week, index) => {
                const roadmapLongRun = longRun(week);
                const roadmapKeySession = keySession(week);

                return (
                  <button
                    className={`week-card ${selectedWeekIndex === index ? 'selected' : ''}`}
                    key={`${week.title}-roadmap`}
                    onClick={() => setSelectedWeekIndex(index)}
                    type="button"
                  >
                    <div className="week-head">
                      <div>
                        <h3>{week.title}</h3>
                        <p>{week.focus}</p>
                      </div>
                      <strong>{week.targetKm ? `${week.targetKm.toFixed(1)} km` : 'Carrera'}</strong>
                    </div>
                    <div className="roadmap-kpis">
                      <span>Tirada {roadmapLongRun.distanceKm ? `${roadmapLongRun.distanceKm.toFixed(1)} km` : 'off'}</span>
                      <span>Clave {roadmapKeySession.title}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
      </section>

      <footer className="footer-note">
        <span>
          Última sincronización: {new Date(data.fetchedAt).toLocaleString()} · El frontend consulta la API
          cada 30 s y el backend refresca {data.provider.label} cada {Math.round(serverRefreshMs / 60_000)} min.
        </span>
      </footer>
    </main>
  );
}

export default App;
