import { startTransition, useEffect, useState } from 'react';
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
import type { DashboardData } from './types';
import './App.css';

type AsyncState =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: DashboardData; error: null }
  | { status: 'error'; data: null; error: string };

type ChartMetric = 'sleepHours' | 'readiness' | 'hrv' | 'steps';

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
    tone: '#0d6b62',
    unit: '',
    description: 'Lectura compuesta de recuperación y disponibilidad para entrenar.',
  },
  {
    key: 'hrv',
    label: 'HRV',
    tone: '#1329a6',
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
    return 'Plan provisional hasta que Garmin vuelva a responder.';
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
  const [state, setState] = useState<AsyncState>({
    status: 'loading',
    data: null,
    error: null,
  });
  const [selectedMetric, setSelectedMetric] = useState<ChartMetric>('sleepHours');
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  const loadDashboard = async (refresh = false) => {
    try {
      const response = await fetch(`/api/dashboard${refresh ? '?refresh=1' : ''}`);
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
      });
    } catch (error) {
      startTransition(() => {
        setState({
          status: 'error',
          data: null,
          error: error instanceof Error ? error.message : 'Fallo inesperado',
        });
      });
    }
  };

  useEffect(() => {
    void loadDashboard();
  }, []);

  if (state.status === 'loading') {
    return (
      <main className="app-shell">
        <section className="status-panel">
          <p className="eyebrow">Garmin Race Room</p>
          <h1>Cargando tus métricas y el plan hacia la media.</h1>
          <p>Consultando Garmin Connect desde Python API y MCP local.</p>
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
          <button className="action-button" onClick={() => void loadDashboard(true)}>
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

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Garmin Race Room</p>
          <h1>{data.athlete.name}</h1>
          <p className="lead">
            Dashboard interactivo para preparar la media maratón del {data.athlete.raceDate}. Cruza
            recuperación, volumen, rendimiento y plan semanal en una sola vista.
          </p>
          <div className="hero-meta">
            <span>{data.athlete.daysToRace} días para carrera</span>
            {data.athlete.primaryDevice ? <span>{data.athlete.primaryDevice}</span> : null}
            {data.athlete.location ? <span>{data.athlete.location}</span> : null}
          </div>
          {data.fallbackReason ? (
            <div className="warning-banner">
              Garmin no ha entregado datos reales en este intento: {data.fallbackReason}
            </div>
          ) : null}
        </div>

        <div className="hero-scoreboard">
          <div className="score-card primary">
            <span className="score-label">Predicción media</span>
            <strong>{formatRace(data.overview.predictedHalfSeconds)}</strong>
            <small>Ritmo objetivo {data.plan.paces.race ?? 'pendiente'}</small>
          </div>
          <div className="score-card">
            <span className="score-label">Readiness</span>
            <strong>{metricValue(data.overview.readiness)}</strong>
            <small>{data.overview.trainingStatus ?? 'Sin estado de carga'}</small>
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
          <small>Último registro en Garmin</small>
        </article>
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
                      fill={entry.runCount >= 4 ? '#0d6b62' : '#c8722b'}
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
                    <stop offset="5%" stopColor="#1329a6" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#1329a6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(29, 34, 42, 0.08)" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} />
                <Tooltip />
                <Area type="monotone" dataKey="value" stroke="#1329a6" fill="url(#vo2Fill)" strokeWidth={2.5} />
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
              <h2>Lo importante hasta el 10 de mayo</h2>
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
            <button className="action-button" onClick={() => void loadDashboard(true)}>
              Refrescar
            </button>
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
                    ? `Training Effect ${selectedRun.trainingEffect.toFixed(1)}. Buena referencia para calibrar si la calidad está dejando el estímulo justo o demasiada fatiga.`
                    : 'Sin Training Effect disponible. Usa esta sesión como referencia de sensaciones, ritmo y deriva cardíaca.'}
                </p>
              </aside>
            </div>
          ) : (
            <p className="chart-description">
              Garmin todavía no ha devuelto actividades recientes. En cuanto sincronice, aquí podrás
              entrar a cada rodaje.
            </p>
          )}
        </article>
      </section>

      <section className="panel plan-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Plan semanal</p>
            <h2>Ruta hacia tu media maratón</h2>
          </div>
          <div className="pace-pills">
            {data.plan.paces.easy ? <span>Easy {data.plan.paces.easy}</span> : null}
            {data.plan.paces.tempo ? <span>Tempo {data.plan.paces.tempo}</span> : null}
            {data.plan.paces.race ? <span>Race {data.plan.paces.race}</span> : null}
          </div>
        </div>

        <p className="plan-summary">{data.plan.summary}</p>

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
                {selectedWeek.days.map((day) => (
                  <div className={`day-row intensity-${day.intensity}`} key={`${selectedWeek.title}-${day.date}`}>
                    <div className="day-date">
                      <strong>{day.weekday.slice(0, 3)}</strong>
                      <span>{day.date}</span>
                    </div>
                    <div className="day-main">
                      <strong>{day.title}</strong>
                      <p>{day.notes}</p>
                    </div>
                    <div className="day-distance">
                      {day.distanceKm ? `${day.distanceKm.toFixed(1)} km` : 'Off'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </section>

      <footer className="footer-note">
        <span>Última sincronización: {new Date(data.fetchedAt).toLocaleString()}</span>
      </footer>
    </main>
  );
}

export default App;
