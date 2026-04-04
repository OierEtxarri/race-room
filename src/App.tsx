import {
  Suspense,
  lazy,
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type FormEvent,
} from 'react';
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
import { Skeleton } from 'boneyard-js/react';
import type { ActivityRoute, DashboardData, SessionPayload, UserGoal, WhatIfScenario } from './types';
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
type CheckInDraft = {
  energy: 'low' | 'ok' | 'high';
  legs: 'heavy' | 'normal' | 'fresh';
  mood: 'flat' | 'steady' | 'great';
  note: string;
};
type CheckInState = {
  status: 'idle' | 'saving' | 'success' | 'error';
  message: string | null;
  editing: boolean;
};
type CoachChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};
type WhatIfDraft = {
  raceDate: string;
  distanceKm: number;
  availableDays: string;
  maxWeeklyKm: string;
  note: string;
};
type WhatIfState = {
  status: 'idle' | 'sending' | 'success' | 'error';
  message: string | null;
  scenario: WhatIfScenario | null;
};
type VoiceTarget = 'checkin' | 'coach' | 'whatif';
type VoiceState = {
  status: 'idle' | 'recording' | 'unsupported';
  target: VoiceTarget | null;
  message: string | null;
};
type RouteState =
  | { status: 'idle'; data: null; error: null }
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: ActivityRoute; error: null }
  | { status: 'error'; data: null; error: string };
type RunOverlayTemplateId = 'routeGlass';
type DashboardSectionId = 'summary' | 'fitness' | 'plan' | 'sessions';
type AvatarSize = 'sm' | 'lg';

type SpeechRecognitionResultLike = {
  0: {
    transcript: string;
  };
  isFinal: boolean;
  length: number;
};

type SpeechRecognitionEventLike = Event & {
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type ChartMetric = 'sleepHours' | 'readiness' | 'hrv' | 'steps';
const serverRefreshMs = 60 * 60 * 1_000;
const clientPollMs = 10 * 60 * 1_000;
const sessionStorageKey = 'garmin_race_room_session_id';
const sessionProviderStorageKey = 'garmin_race_room_session_provider';
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const idleRouteState: RouteState = {
  status: 'idle',
  data: null,
  error: null,
};
const defaultGoal: UserGoal = {
  raceDate: '2026-05-10',
  distanceKm: 21.1,
};
const defaultCheckInDraft: CheckInDraft = {
  energy: 'ok',
  legs: 'normal',
  mood: 'steady',
  note: '',
};
const defaultWhatIfDraft = (goal: UserGoal): WhatIfDraft => ({
  raceDate: goal.raceDate,
  distanceKm: goal.distanceKm,
  availableDays: '',
  maxWeeklyKm: '',
  note: '',
});
const runOverlayTemplate = {
  id: 'routeGlass' as const,
  label: 'Glass Profile',
  headline: 'Blur card',
  description: 'Tarjeta glass translúcida con avatar, nombre, hora, lugar, descripción y ruta.',
};

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const candidate = (window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }).SpeechRecognition
    ?? (window as Window & {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    }).webkitSpeechRecognition;

  return candidate ?? null;
}

function isBoneStudioMode() {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('__bones');
}
const ActivityRouteMap = lazy(async () => {
  const module = await import('./components/ActivityRouteMap');
  return {
    default: module.ActivityRouteMap,
  };
});

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
    tone: '#9bc7ff',
    unit: ' h',
    description: 'Horas de sueño útiles para asimilar la carga.',
  },
  {
    key: 'readiness',
    label: 'Readiness',
    tone: '#ffffff',
    unit: '',
    description: 'Lectura compuesta de recuperación y disponibilidad para entrenar.',
  },
  {
    key: 'hrv',
    label: 'HRV',
    tone: '#d7e4ff',
    unit: '',
    description: 'Tendencia autonómica. Más útil como serie que como valor aislado.',
  },
  {
    key: 'steps',
    label: 'Pasos',
    tone: '#7fd1ff',
    unit: '',
    description: 'Movimiento diario para detectar fatiga o sedentarismo entre sesiones.',
  },
];
const checkInOptions = {
  energy: [
    { value: 'low' as const, label: 'Baja' },
    { value: 'ok' as const, label: 'Media' },
    { value: 'high' as const, label: 'Alta' },
  ],
  legs: [
    { value: 'heavy' as const, label: 'Pesadas' },
    { value: 'normal' as const, label: 'Normales' },
    { value: 'fresh' as const, label: 'Frescas' },
  ],
  mood: [
    { value: 'flat' as const, label: 'Plana' },
    { value: 'steady' as const, label: 'Estable' },
    { value: 'great' as const, label: 'Muy buena' },
  ],
};
const dashboardSections: Array<{
  id: DashboardSectionId;
  label: string;
  note: string;
}> = [
  { id: 'summary', label: 'Resumen', note: 'Visión rápida y métricas clave' },
  { id: 'sessions', label: 'Sesiones', note: 'Rodajes recientes y export glass' },
  { id: 'plan', label: 'Plan', note: 'Semanas, sesiones y roadmap' },
  { id: 'fitness', label: 'Fitness', note: 'Estado actual, tendencias y ajuste adaptativo' },
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

function DashboardLoadingFixture() {
  return (
    <div className="dashboard-loading-fixture">
      <div className="dashboard-loading-hero">
        <div className="dashboard-loading-copy">
          <span className="fixture-chip">Race Room</span>
          <div className="fixture-line xl" />
          <div className="fixture-line lg" />
          <div className="fixture-line md" />
        </div>
        <div className="dashboard-loading-scoreboard">
          <div className="fixture-stat" />
          <div className="fixture-stat" />
          <div className="fixture-stat" />
        </div>
      </div>
      <div className="dashboard-loading-grid">
        <div className="fixture-card tall" />
        <div className="fixture-card" />
        <div className="fixture-card" />
      </div>
    </div>
  );
}

function RoutePanelFixture() {
  return (
    <div className="route-loading-fixture">
      <div className="route-loading-map" />
      <div className="route-loading-stats">
        <div className="fixture-line md" />
        <div className="fixture-line sm" />
        <div className="fixture-stat compact" />
        <div className="fixture-stat compact" />
        <div className="fixture-stat compact" />
      </div>
    </div>
  );
}

function AthleteAvatar({
  name,
  avatarUrl,
  size = 'sm',
}: {
  name: string;
  avatarUrl: string | null;
  size?: AvatarSize;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [avatarUrl]);

  if (avatarUrl && !failed) {
    return (
      <span className={`athlete-avatar ${size}`}>
        <img alt={`Perfil de ${name}`} onError={() => setFailed(true)} src={avatarUrl} />
      </span>
    );
  }

  return (
    <span className={`athlete-avatar ${size} fallback`} aria-hidden="true">
      {athleteInitials(name)}
    </span>
  );
}

function projectRoutePoints(points: ActivityRoute['points'], width: number, height: number, padding: number) {
  const latitudes = points.map((point) => point[0]);
  const longitudes = points.map((point) => point[1]);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const latSpan = Math.max(maxLat - minLat, 0.0001);
  const lngSpan = Math.max(maxLng - minLng, 0.0001);

  return points.map(([lat, lng]) => {
    const x = padding + ((lng - minLng) / lngSpan) * (width - padding * 2);
    const y = height - padding - ((lat - minLat) / latSpan) * (height - padding * 2);
    return [x, y] as const;
  });
}

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines = 3,
) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
    }
    current = word;

    if (lines.length >= maxLines - 1) {
      break;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[.,;:!?-]*$/, '')}…`;
  }

  lines.forEach((line, index) => {
    context.fillText(line, x, y + index * lineHeight);
  });
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function fillRoundedPanel(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  options: {
    radius?: number;
    fill?: string;
    stroke?: string;
    lineWidth?: number;
  } = {},
) {
  const radius = options.radius ?? 24;
  drawRoundedRect(context, x, y, width, height, radius);

  if (options.fill) {
    context.fillStyle = options.fill;
    context.fill();
  }

  if (options.stroke) {
    context.strokeStyle = options.stroke;
    context.lineWidth = options.lineWidth ?? 1.5;
    context.stroke();
  }
}

function drawMetricCard(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  value: string,
  accent = false,
) {
  fillRoundedPanel(context, x, y, width, height, {
    radius: 26,
    fill: '#101010',
    stroke: accent ? '#D71921' : '#2F2F2F',
    lineWidth: accent ? 2 : 1.5,
  });

  if (accent) {
    context.fillStyle = 'rgba(215,25,33,0.12)';
    fillRoundedPanel(context, x + 10, y + 10, width - 20, height - 20, {
      radius: 18,
      fill: 'rgba(215,25,33,0.08)',
    });
  }

  context.fillStyle = '#999999';
  context.font = '500 20px "Space Mono", monospace';
  context.fillText(label, x + 28, y + 40);
  context.fillStyle = '#FFFFFF';
  context.font = accent ? '600 54px "Doto", "Space Mono", monospace' : '700 42px "Space Grotesk", sans-serif';
  context.fillText(value, x + 28, y + 104);
}

function drawOverlayPill(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  options: {
    fill?: string;
    stroke?: string;
    textColor?: string;
    paddingX?: number;
    height?: number;
    radius?: number;
    font?: string;
  } = {},
) {
  context.save();
  context.font = options.font ?? '500 18px "Space Mono", monospace';
  const paddingX = options.paddingX ?? 24;
  const height = options.height ?? 54;
  const radius = options.radius ?? 999;
  const textWidth = context.measureText(text).width;
  const width = textWidth + paddingX * 2;

  fillRoundedPanel(context, x, y, width, height, {
    radius,
    fill: options.fill ?? 'rgba(0,0,0,0.22)',
    stroke: options.stroke ?? 'rgba(255,255,255,0.14)',
  });
  context.fillStyle = options.textColor ?? 'rgba(255,255,255,0.76)';
  context.textBaseline = 'middle';
  context.fillText(text, x + paddingX, y + height / 2 + 1);
  context.restore();
  return width;
}

function measureOverlayPillWidth(
  context: CanvasRenderingContext2D,
  text: string,
  options: {
    paddingX?: number;
    font?: string;
  } = {},
) {
  context.save();
  context.font = options.font ?? '500 18px "Space Mono", monospace';
  const paddingX = options.paddingX ?? 24;
  const width = context.measureText(text).width + paddingX * 2;
  context.restore();
  return width;
}

function drawOverlayStat(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  value: string,
  options: {
    align?: CanvasTextAlign;
    labelFont?: string;
    valueFont?: string;
    labelColor?: string;
    valueColor?: string;
  } = {},
) {
  const align = options.align ?? 'left';
  context.save();
  context.textAlign = align;
  context.fillStyle = options.labelColor ?? 'rgba(255,255,255,0.72)';
  context.font = options.labelFont ?? '500 20px "Space Mono", monospace';
  context.fillText(label, x, y);
  context.fillStyle = options.valueColor ?? '#FFFFFF';
  context.font = options.valueFont ?? '700 52px "Space Grotesk", sans-serif';
  context.fillText(value, x, y + 58);
  context.restore();
}

function drawShadowedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: {
    fillStyle?: string;
    font?: string;
    shadowColor?: string;
    shadowBlur?: number;
    shadowOffsetY?: number;
  } = {},
) {
  context.save();
  context.fillStyle = options.fillStyle ?? '#FFFFFF';
  if (options.font) {
    context.font = options.font;
  }
  context.shadowColor = options.shadowColor ?? 'rgba(0,0,0,0.36)';
  context.shadowBlur = options.shadowBlur ?? 24;
  context.shadowOffsetY = options.shadowOffsetY ?? 8;
  context.fillText(text, x, y);
  context.restore();
}

function drawShadowedWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
  options: {
    fillStyle?: string;
    font?: string;
    shadowColor?: string;
    shadowBlur?: number;
    shadowOffsetY?: number;
  } = {},
) {
  context.save();
  context.fillStyle = options.fillStyle ?? '#FFFFFF';
  if (options.font) {
    context.font = options.font;
  }
  context.shadowColor = options.shadowColor ?? 'rgba(0,0,0,0.36)';
  context.shadowBlur = options.shadowBlur ?? 24;
  context.shadowOffsetY = options.shadowOffsetY ?? 8;
  wrapCanvasText(context, text, x, y, maxWidth, lineHeight, maxLines);
  context.restore();
}

function formatDistanceCompact(distanceKm: number) {
  return Math.abs(distanceKm - Math.round(distanceKm)) < 0.12 ? String(Math.round(distanceKm)) : distanceKm.toFixed(1);
}

function athleteInitials(name: string) {
  const tokens = name
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 2);

  return tokens.map((token) => token[0]?.toUpperCase() ?? '').join('') || 'GR';
}

function loadImageElement(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('No se pudo cargar la imagen.'));
    image.src = source;
  });
}

async function resolveAthleteAvatarAsset(avatarPath: string | null, sessionId: string | null) {
  if (!avatarPath) {
    return {
      image: null,
      cleanup: () => undefined,
    };
  }

  const headers = new Headers();
  if (sessionId) {
    headers.set('X-Session-Id', sessionId);
  }

  const response = await fetch(absoluteApiUrl(avatarPath), {
    headers,
    credentials: 'include',
  }).catch(() => null);

  if (!response?.ok) {
    return {
      image: null,
      cleanup: () => undefined,
    };
  }

  const blobUrl = URL.createObjectURL(await response.blob());

  try {
    const image = await loadImageElement(blobUrl);
    return {
      image,
      cleanup: () => URL.revokeObjectURL(blobUrl),
    };
  } catch {
    URL.revokeObjectURL(blobUrl);
    return {
      image: null,
      cleanup: () => undefined,
    };
  }
}

const staticTileSize = 256;
const staticSatelliteTileUrl =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const staticHillshadeTileUrl =
  'https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}';
const staticLabelsTileUrl =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const staticTileCache = new Map<string, Promise<HTMLImageElement | null>>();

function paceThresholds(route: ActivityRoute) {
  const paces = route.samples
    .map((sample) => sample.paceSecondsPerKm)
    .filter((pace): pace is number => typeof pace === 'number' && Number.isFinite(pace) && pace > 0)
    .sort((left, right) => left - right);

  if (paces.length < 6) {
    return null;
  }

  const pick = (ratio: number) => paces[Math.min(paces.length - 1, Math.floor((paces.length - 1) * ratio))] ?? null;
  return {
    fast: pick(0.33),
    medium: pick(0.66),
  };
}

function paceColor(paceSecondsPerKm: number | null, thresholds: ReturnType<typeof paceThresholds>) {
  if (paceSecondsPerKm === null || !thresholds?.fast || !thresholds.medium) {
    return '#7FC5FF';
  }

  if (paceSecondsPerKm <= thresholds.fast) {
    return '#DF3E3E';
  }

  if (paceSecondsPerKm <= thresholds.medium) {
    return '#F2A43C';
  }

  return '#5DAEFF';
}

function routeSegments(route: ActivityRoute) {
  const thresholds = paceThresholds(route);

  if (route.samples.length >= 2) {
    return route.samples.slice(1).map((sample, index) => {
      const previous = route.samples[index]!;
      const segmentPace =
        sample.paceSecondsPerKm !== null && previous.paceSecondsPerKm !== null
          ? (sample.paceSecondsPerKm + previous.paceSecondsPerKm) / 2
          : sample.paceSecondsPerKm ?? previous.paceSecondsPerKm ?? null;

      return {
        points: [previous.point, sample.point] as Array<[number, number]>,
        color: paceColor(segmentPace, thresholds),
      };
    });
  }

  return [
    {
      points: route.points,
      color: '#7FC5FF',
    },
  ];
}

function mercatorPixel(lat: number, lng: number, zoom: number) {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const scale = staticTileSize * 2 ** zoom;
  const x = ((lng + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

function chooseStaticMapZoom(points: Array<[number, number]>, width: number, height: number, padding: number) {
  for (let zoom = 16; zoom >= 3; zoom -= 1) {
    const projected = points.map(([lat, lng]) => mercatorPixel(lat, lng, zoom));
    const xs = projected.map((point) => point.x);
    const ys = projected.map((point) => point.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);

    if (spanX <= width - padding * 2 && spanY <= height - padding * 2) {
      return zoom;
    }
  }

  return 3;
}

function staticMapViewport(route: ActivityRoute, width: number, height: number, padding: number) {
  const zoom = chooseStaticMapZoom(route.points, width, height, padding);
  const projected = route.points.map(([lat, lng]) => mercatorPixel(lat, lng, zoom));
  const xs = projected.map((point) => point.x);
  const ys = projected.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return {
    zoom,
    originX: centerX - width / 2,
    originY: centerY - height / 2,
  };
}

async function loadRemoteImageAsset(url: string) {
  if (!staticTileCache.has(url)) {
    staticTileCache.set(
      url,
      fetch(url)
        .then((response) => (response.ok ? response.blob() : null))
        .then(async (blob) => {
          if (!blob) {
            return null;
          }

          const blobUrl = URL.createObjectURL(blob);
          try {
            return await loadImageElement(blobUrl);
          } finally {
            URL.revokeObjectURL(blobUrl);
          }
        })
        .catch(() => null),
    );
  }

  return staticTileCache.get(url)!;
}

async function drawStaticRouteMapCard(
  context: CanvasRenderingContext2D,
  route: ActivityRoute,
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 28,
) {
  const viewport = staticMapViewport(route, width, height, 28);
  const startTileX = Math.floor(viewport.originX / staticTileSize);
  const endTileX = Math.floor((viewport.originX + width) / staticTileSize);
  const startTileY = Math.floor(viewport.originY / staticTileSize);
  const endTileY = Math.floor((viewport.originY + height) / staticTileSize);
  const worldTileCount = 2 ** viewport.zoom;
  const tileJobs: Array<Promise<{ image: HTMLImageElement | null; hillshade: HTMLImageElement | null; labels: HTMLImageElement | null; drawX: number; drawY: number }>> = [];

  for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
    if (tileY < 0 || tileY >= worldTileCount) {
      continue;
    }

    for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
      const wrappedTileX = ((tileX % worldTileCount) + worldTileCount) % worldTileCount;
      const drawX = x + tileX * staticTileSize - viewport.originX;
      const drawY = y + tileY * staticTileSize - viewport.originY;
      const replace = (template: string) =>
        template
          .replace('{z}', String(viewport.zoom))
          .replace('{y}', String(tileY))
          .replace('{x}', String(wrappedTileX));

      tileJobs.push(
        Promise.all([
          loadRemoteImageAsset(replace(staticSatelliteTileUrl)),
          loadRemoteImageAsset(replace(staticHillshadeTileUrl)),
          loadRemoteImageAsset(replace(staticLabelsTileUrl)),
        ]).then(([image, hillshade, labels]) => ({
          image,
          hillshade,
          labels,
          drawX,
          drawY,
        })),
      );
    }
  }

  const tiles = await Promise.all(tileJobs);

  context.save();
  drawRoundedRect(context, x, y, width, height, radius);
  context.clip();
  context.fillStyle = '#11161D';
  context.fillRect(x, y, width, height);

  tiles.forEach((tile) => {
    if (tile.image) {
      context.drawImage(tile.image, tile.drawX, tile.drawY, staticTileSize, staticTileSize);
    }
  });

  context.save();
  context.globalAlpha = 0.34;
  context.globalCompositeOperation = 'screen';
  tiles.forEach((tile) => {
    if (tile.hillshade) {
      context.drawImage(tile.hillshade, tile.drawX, tile.drawY, staticTileSize, staticTileSize);
    }
  });
  context.restore();

  context.fillStyle = 'rgba(14, 18, 24, 0.32)';
  context.fillRect(x, y, width, height);

  context.save();
  context.globalAlpha = 0.16;
  tiles.forEach((tile) => {
    if (tile.labels) {
      context.drawImage(tile.labels, tile.drawX, tile.drawY, staticTileSize, staticTileSize);
    }
  });
  context.restore();

  const projectedPoints = route.points.map(([lat, lng]) => {
    const pixel = mercatorPixel(lat, lng, viewport.zoom);
    return [x + pixel.x - viewport.originX, y + pixel.y - viewport.originY] as const;
  });
  const segments = routeSegments(route);

  segments.forEach((segment) => {
    const projected = segment.points.map(([lat, lng]) => {
      const pixel = mercatorPixel(lat, lng, viewport.zoom);
      return [x + pixel.x - viewport.originX, y + pixel.y - viewport.originY] as const;
    });

    context.strokeStyle = `${segment.color}44`;
    context.lineWidth = 16;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.beginPath();
    projected.forEach(([pointX, pointY], index) => {
      if (index === 0) {
        context.moveTo(pointX, pointY);
      } else {
        context.lineTo(pointX, pointY);
      }
    });
    context.stroke();

    context.strokeStyle = segment.color;
    context.lineWidth = 6;
    context.beginPath();
    projected.forEach(([pointX, pointY], index) => {
      if (index === 0) {
        context.moveTo(pointX, pointY);
      } else {
        context.lineTo(pointX, pointY);
      }
    });
    context.stroke();
  });

  const [startX, startY] = projectedPoints[0]!;
  const [endX, endY] = projectedPoints.at(-1)!;
  context.fillStyle = '#F9F6EB';
  context.beginPath();
  context.arc(startX, startY, 5, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#DF3E3E';
  context.beginPath();
  context.arc(endX, endY, 6, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#F9F6EB';
  context.beginPath();
  context.arc(endX, endY, 2.5, 0, Math.PI * 2);
  context.fill();

  const overlayGradient = context.createLinearGradient(x, y, x, y + height);
  overlayGradient.addColorStop(0, 'rgba(20, 24, 31, 0.08)');
  overlayGradient.addColorStop(1, 'rgba(20, 24, 31, 0.26)');
  context.fillStyle = overlayGradient;
  context.fillRect(x, y, width, height);
  context.restore();

  fillRoundedPanel(context, x, y, width, height, {
    radius,
    stroke: 'rgba(255,255,255,0.12)',
    lineWidth: 1.5,
  });
}

function buildOverlayHeadline(name: string) {
  const cleaned = name
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/[^a-z0-9\s-]/gi, ' ')
    .replace(/\b(run|carrera|rodaje|entrenamiento|workout)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const firstToken = cleaned.split(/[\s-]+/).filter(Boolean)[0] ?? 'training';
  return `${firstToken} | run`;
}

function buildRunDescription(run: DashboardData['recentRuns'][number]) {
  if (run.trainingEffect !== null) {
    return `Training Effect ${run.trainingEffect.toFixed(1)} · ${formatPace(run.paceSecondsPerKm) ?? 'sin dato'}`;
  }

  if (run.averageHeartRate !== null) {
    return `Rodaje controlado · ${run.averageHeartRate} bpm medios · ${metricValue(run.elevationGain, ' m')} de desnivel`;
  }

  return `Sesión de ${run.distanceKm.toFixed(1)} km en ${formatDuration(run.durationSeconds).toLowerCase()}.`;
}

function drawGlassPanel(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 34,
) {
  context.save();
  drawRoundedRect(context, x, y, width, height, radius);
  context.clip();

  const baseGradient = context.createLinearGradient(x, y, x, y + height);
  baseGradient.addColorStop(0, 'rgba(64,64,68,0.72)');
  baseGradient.addColorStop(1, 'rgba(26,26,28,0.6)');
  context.fillStyle = baseGradient;
  context.fillRect(x, y, width, height);

  const surfaceLight = context.createLinearGradient(x, y, x, y + height * 0.42);
  surfaceLight.addColorStop(0, 'rgba(255,255,255,0.12)');
  surfaceLight.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = surfaceLight;
  context.fillRect(x, y, width, height);

  const innerBloom = context.createRadialGradient(
    x + width * 0.76,
    y + height * 0.7,
    0,
    x + width * 0.76,
    y + height * 0.7,
    width * 0.24,
  );
  innerBloom.addColorStop(0, 'rgba(255,255,255,0.09)');
  innerBloom.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = innerBloom;
  context.fillRect(x, y, width, height);
  context.restore();

  fillRoundedPanel(context, x, y, width, height, {
    radius,
    stroke: 'rgba(255,255,255,0.72)',
    lineWidth: 2,
  });
}

function drawRouteOverlay(input: {
  context: CanvasRenderingContext2D;
  route: ActivityRoute;
  x: number;
  y: number;
  width: number;
  height: number;
  panel?: boolean;
  labelLeft?: string;
  labelRight?: string;
}) {
  const { context, route, x, y, width, height } = input;

  if (input.panel !== false) {
    fillRoundedPanel(context, x, y, width, height, {
      radius: 30,
      fill: 'rgba(0,0,0,0.22)',
      stroke: 'rgba(255,255,255,0.14)',
      lineWidth: 1.5,
    });
  }

  const projected = projectRoutePoints(route.points, width, height, input.panel === false ? 18 : 56);
  context.save();
  context.translate(x, y);
  context.strokeStyle = 'rgba(0,0,0,0.22)';
  context.lineWidth = 18;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  projected.forEach(([pointX, pointY], index) => {
    if (index === 0) {
      context.moveTo(pointX, pointY);
    } else {
      context.lineTo(pointX, pointY);
    }
  });
  context.stroke();

  context.strokeStyle = '#FFFFFF';
  context.lineWidth = 7;
  context.beginPath();
  projected.forEach(([pointX, pointY], index) => {
    if (index === 0) {
      context.moveTo(pointX, pointY);
    } else {
      context.lineTo(pointX, pointY);
    }
  });
  context.stroke();

  const [startX, startY] = projected[0]!;
  const [endX, endY] = projected.at(-1)!;
  context.fillStyle = '#FFFFFF';
  context.beginPath();
  context.arc(startX, startY, 9, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#D71921';
  context.beginPath();
  context.arc(endX, endY, 10, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = 'rgba(255,255,255,0.84)';
  context.lineWidth = 2;
  context.beginPath();
  context.arc(endX, endY, 18, 0, Math.PI * 2);
  context.stroke();
  context.restore();

  if (input.labelLeft || input.labelRight) {
    context.fillStyle = 'rgba(255,255,255,0.62)';
    context.font = '500 18px "Space Mono", monospace';
    if (input.labelLeft) {
      context.fillText(input.labelLeft, x + 24, y + height - 22);
    }
    if (input.labelRight) {
      const widthText = context.measureText(input.labelRight).width;
      context.fillText(input.labelRight, x + width - 24 - widthText, y + height - 22);
    }
  }
}

function renderAuraHeroOverlay(context: CanvasRenderingContext2D, input: {
  run: DashboardData['recentRuns'][number];
  route: ActivityRoute;
  athleteName: string;
  providerLabel: string;
}) {
  const headline = buildOverlayHeadline(input.run.name);

  fillRoundedPanel(context, 68, 72, 226, 56, {
    radius: 999,
    fill: 'rgba(0,0,0,0.24)',
    stroke: 'rgba(255,255,255,0.14)',
  });
  context.fillStyle = 'rgba(255,255,255,0.74)';
  context.font = '500 18px "Space Mono", monospace';
  context.fillText('[ AURA OVERLAY ]', 96, 108);

  drawShadowedText(context, headline, 70, 272, {
    font: '500 110px "Space Grotesk", sans-serif',
    fillStyle: '#FFFFFF',
    shadowBlur: 26,
  });

  context.save();
  context.fillStyle = 'rgba(0,0,0,0.30)';
  context.font = '700 300px "Space Grotesk", sans-serif';
  context.fillText(`${formatDistanceCompact(input.run.distanceKm)}KM`, 84, 930);
  context.restore();

  drawMetricCard(context, 76, 1010, 290, 128, 'DISTANCE', `${input.run.distanceKm.toFixed(1)} km`);
  drawMetricCard(context, 392, 1010, 290, 128, 'TIME', formatDuration(input.run.durationSeconds));
  drawMetricCard(context, 708, 1010, 290, 128, 'PACE', formatPace(input.run.paceSecondsPerKm) ?? 'Sin dato', true);

  drawRouteOverlay({
    context,
    route: input.route,
    x: 76,
    y: 1218,
    width: 320,
    height: 196,
    labelLeft: 'ROUTE',
    labelRight: input.providerLabel.toUpperCase(),
  });

  fillRoundedPanel(context, 824, 1366, 186, 54, {
    radius: 999,
    fill: 'rgba(0,0,0,0.20)',
    stroke: 'rgba(255,255,255,0.12)',
  });
  context.fillStyle = 'rgba(255,255,255,0.76)';
  context.font = '500 18px "Space Mono", monospace';
  context.fillText(input.athleteName.toUpperCase(), 852, 1401);

  context.fillStyle = 'rgba(255,255,255,0.64)';
  context.font = '500 18px "Space Mono", monospace';
  context.fillText(input.run.date, 78, 1458);
}

function renderFloatingStatsOverlay(context: CanvasRenderingContext2D, input: {
  run: DashboardData['recentRuns'][number];
  route: ActivityRoute;
  athleteName: string;
  providerLabel: string;
}) {
  drawOverlayPill(context, 84, 84, 'MAP STATS');
  drawShadowedText(context, buildOverlayHeadline(input.run.name), 84, 228, {
    font: '500 84px "Space Grotesk", sans-serif',
  });

  fillRoundedPanel(context, 88, 312, 432, 520, {
    radius: 34,
    fill: 'rgba(18,18,18,0.38)',
    stroke: 'rgba(255,255,255,0.14)',
  });
  drawRouteOverlay({
    context,
    route: input.route,
    x: 112,
    y: 346,
    width: 384,
    height: 452,
    panel: false,
  });

  drawOverlayPill(context, 112, 770, 'MAP');
  drawOverlayPill(context, 364, 770, input.providerLabel.toUpperCase(), {
    stroke: 'rgba(215,25,33,0.88)',
  });

  drawGlassPanel(context, 262, 1082, 560, 290, 38);
  const gridItems = [
    { x: 320, y: 1160, label: 'DISTANCE', value: `${input.run.distanceKm.toFixed(1)} km` },
    { x: 588, y: 1160, label: 'PACE', value: formatPace(input.run.paceSecondsPerKm) ?? 'Sin dato' },
    { x: 320, y: 1290, label: 'TIME', value: formatDuration(input.run.durationSeconds) },
    { x: 588, y: 1290, label: 'ELEV', value: metricValue(input.run.elevationGain, ' m') },
  ];

  gridItems.forEach((item) => {
    drawOverlayStat(context, item.x, item.y, item.label, item.value, {
      valueFont: '700 42px "Space Grotesk", sans-serif',
    });
  });

  context.fillStyle = 'rgba(255,255,255,0.68)';
  context.font = '500 18px "Space Mono", monospace';
  context.fillText(input.run.date, 88, 1708);
  context.fillText(input.athleteName.toUpperCase(), 818, 1708);
}

function renderMonolithKmOverlay(context: CanvasRenderingContext2D, input: {
  run: DashboardData['recentRuns'][number];
  route: ActivityRoute;
  athleteName: string;
  providerLabel: string;
}) {
  const distanceText = `${formatDistanceCompact(input.run.distanceKm)}KM`;

  context.fillStyle = 'rgba(255,255,255,0.88)';
  context.font = '500 28px "Space Mono", monospace';
  const title = `${input.run.name.toUpperCase()} | ${new Date(input.run.date).getFullYear()}`;
  const titleWidth = context.measureText(title).width;
  context.fillText(title, (1080 - titleWidth) / 2, 108);

  context.save();
  context.fillStyle = 'rgba(0,0,0,0.32)';
  context.font = '700 304px "Space Grotesk", sans-serif';
  context.fillText(distanceText, 86, 1018);
  context.restore();

  drawRouteOverlay({
    context,
    route: input.route,
    x: 116,
    y: 380,
    width: 850,
    height: 430,
    panel: false,
  });

  const rails = [
    { x: 260, label: `DISTANCE · ${input.run.distanceKm.toFixed(1)} KM` },
    { x: 520, label: `TIME · ${formatDuration(input.run.durationSeconds).toUpperCase()}` },
    { x: 770, label: `PACE · ${(formatPace(input.run.paceSecondsPerKm) ?? 'SIN DATO').toUpperCase()}` },
  ];

  rails.forEach((rail) => {
    fillRoundedPanel(context, rail.x - 40, 840, 74, 420, {
      radius: 18,
      fill: 'rgba(0,0,0,0.20)',
      stroke: 'rgba(255,255,255,0.12)',
    });
    context.save();
    context.translate(rail.x, 1212);
    context.rotate(-Math.PI / 2);
    context.fillStyle = 'rgba(255,255,255,0.92)';
    context.font = '500 24px "Space Mono", monospace';
    context.fillText(rail.label, 0, 0);
    context.restore();
  });

  fillRoundedPanel(context, 126, 1510, 828, 68, {
    radius: 999,
    fill: 'rgba(0,0,0,0.18)',
    stroke: 'rgba(255,255,255,0.12)',
  });
  context.fillStyle = 'rgba(255,255,255,0.72)';
  context.font = '500 20px "Space Mono", monospace';
  context.fillText(`${input.run.date}  •  ${input.providerLabel.toUpperCase()}  •  ${input.athleteName.toUpperCase()}`, 164, 1554);
}

function renderSplitEditorialOverlay(context: CanvasRenderingContext2D, input: {
  run: DashboardData['recentRuns'][number];
  route: ActivityRoute;
  athleteName: string;
  providerLabel: string;
}) {
  drawOverlayPill(context, 80, 84, 'SPLIT EDITORIAL');
  drawShadowedWrappedText(context, input.run.name.toLowerCase(), 82, 236, 420, 96, 2, {
    font: '500 86px "Space Grotesk", sans-serif',
    fillStyle: '#FFFFFF',
  });

  context.save();
  context.fillStyle = 'rgba(0,0,0,0.24)';
  context.font = '700 250px "Doto", "Space Mono", monospace';
  context.fillText('PACE', 70, 1030);
  context.restore();

  drawOverlayStat(context, 86, 1078, 'PACE', formatPace(input.run.paceSecondsPerKm) ?? 'Sin dato', {
    valueFont: '700 70px "Space Grotesk", sans-serif',
  });
  drawOverlayStat(context, 86, 1232, 'TIME', formatDuration(input.run.durationSeconds), {
    valueFont: '700 56px "Space Grotesk", sans-serif',
  });
  drawOverlayStat(context, 86, 1362, 'DISTANCE', `${input.run.distanceKm.toFixed(1)} km`, {
    valueFont: '700 56px "Space Grotesk", sans-serif',
  });

  drawRouteOverlay({
    context,
    route: input.route,
    x: 540,
    y: 178,
    width: 420,
    height: 610,
    panel: false,
  });

  fillRoundedPanel(context, 544, 930, 416, 214, {
    radius: 34,
    fill: 'rgba(0,0,0,0.18)',
    stroke: 'rgba(255,255,255,0.14)',
  });
  drawOverlayStat(context, 580, 992, 'AVG HR', input.run.averageHeartRate ? `${input.run.averageHeartRate} bpm` : 'Sin FC', {
    valueFont: '700 44px "Space Grotesk", sans-serif',
  });
  drawOverlayStat(context, 580, 1108, 'ELEV', metricValue(input.run.elevationGain, ' m'), {
    valueFont: '700 44px "Space Grotesk", sans-serif',
  });

  drawOverlayPill(context, 82, 1734, `${input.run.date}  •  ${input.providerLabel.toUpperCase()}`);
  const athleteWidth = measureOverlayPillWidth(context, input.athleteName.toUpperCase());
  drawOverlayPill(context, 1080 - 82 - athleteWidth, 1734, input.athleteName.toUpperCase());
}

async function renderRouteFocusOverlay(context: CanvasRenderingContext2D, input: {
  run: DashboardData['recentRuns'][number];
  route: ActivityRoute;
  athleteName: string;
  athleteLocation?: string | null;
  athleteAvatarImage?: HTMLImageElement | null;
  providerLabel: string;
}) {
  const subtitleParts = [
    input.run.timeLabel ? `${input.run.timeLabel}` : null,
    input.athleteLocation,
  ].filter(Boolean);
  const subtitle = subtitleParts.join(' · ');
  const description = buildRunDescription(input.run);

  const cardX = 24;
  const cardY = 24;
  const cardWidth = 1032;
  const cardHeight = 636;
  const leftX = cardX + 54;
  const leftWidth = 368;
  const mapX = cardX + 456;
  const mapY = cardY + 84;
  const mapWidth = 500;
  const mapHeight = 468;

  drawGlassPanel(context, cardX, cardY, cardWidth, cardHeight, 40);

  context.save();
  const avatarX = leftX + 42;
  const avatarY = cardY + 92;
  context.beginPath();
  context.arc(avatarX, avatarY, 42, 0, Math.PI * 2);
  context.closePath();

  if (input.athleteAvatarImage) {
    context.save();
    context.clip();
    context.drawImage(input.athleteAvatarImage, avatarX - 42, avatarY - 42, 84, 84);
    context.restore();
  } else {
    const avatarGradient = context.createLinearGradient(avatarX - 42, avatarY - 42, avatarX + 42, avatarY + 42);
    avatarGradient.addColorStop(0, '#67B6FF');
    avatarGradient.addColorStop(1, '#4D6BFF');
    context.fillStyle = avatarGradient;
    context.fill();
  }

  context.strokeStyle = 'rgba(255,255,255,0.52)';
  context.lineWidth = 2;
  context.beginPath();
  context.arc(avatarX, avatarY, 42, 0, Math.PI * 2);
  context.stroke();

  if (!input.athleteAvatarImage) {
    context.fillStyle = '#FFFFFF';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = '700 32px "Space Grotesk", sans-serif';
    context.fillText(athleteInitials(input.athleteName), avatarX, avatarY + 1);
  }
  context.restore();

  context.fillStyle = '#FFFFFF';
  context.font = '600 38px "Space Grotesk", sans-serif';
  context.fillText(input.athleteName, leftX + 110, cardY + 78);
  context.fillStyle = 'rgba(255,255,255,0.76)';
  context.font = '500 22px "Space Grotesk", sans-serif';
  context.fillText(subtitle || input.providerLabel, leftX + 110, cardY + 120);

  context.fillStyle = '#FFFFFF';
  context.font = '700 54px "Space Grotesk", sans-serif';
  wrapCanvasText(context, input.run.name, leftX, cardY + 220, leftWidth, 64, 3);

  context.fillStyle = 'rgba(255,255,255,0.84)';
  context.font = '500 24px "Space Grotesk", sans-serif';
  wrapCanvasText(context, description, leftX, cardY + 344, leftWidth, 32, 3);

  const statRows = [
    { y: cardY + 430, label: 'Distancia', value: `${input.run.distanceKm.toFixed(1)} km` },
    { y: cardY + 504, label: 'Tiempo', value: formatDuration(input.run.durationSeconds) },
    { y: cardY + 578, label: 'Ritmo', value: formatPace(input.run.paceSecondsPerKm) ?? 'Sin dato' },
  ];

  statRows.forEach((item) => {
    context.fillStyle = 'rgba(255,255,255,0.7)';
    context.font = '500 20px "Space Grotesk", sans-serif';
    context.fillText(item.label, leftX, item.y);
    context.fillStyle = '#FFFFFF';
    context.font = '700 42px "Space Grotesk", sans-serif';
    context.fillText(item.value, leftX + 136, item.y + 2);
  });

  await drawStaticRouteMapCard(context, input.route, mapX, mapY, mapWidth, mapHeight, 30);
}

function renderRibbonDataOverlay(context: CanvasRenderingContext2D, input: {
  run: DashboardData['recentRuns'][number];
  route: ActivityRoute;
  athleteName: string;
  providerLabel: string;
}) {
  context.save();
  context.fillStyle = 'rgba(0,0,0,0.24)';
  context.font = '700 278px "Doto", "Space Mono", monospace';
  context.fillText(formatDistanceCompact(input.run.distanceKm), 72, 462);
  context.restore();

  drawOverlayPill(context, 82, 86, 'RIBBON DATA');
  drawShadowedText(context, 'training overlay', 82, 598, {
    font: '500 74px "Space Grotesk", sans-serif',
  });
  drawShadowedWrappedText(context, input.run.name, 82, 690, 520, 58, 2, {
    font: '500 50px "Space Grotesk", sans-serif',
  });

  drawRouteOverlay({
    context,
    route: input.route,
    x: 576,
    y: 116,
    width: 410,
    height: 470,
    labelLeft: 'ROUTE',
    labelRight: input.providerLabel.toUpperCase(),
  });

  fillRoundedPanel(context, 70, 1488, 940, 248, {
    radius: 42,
    fill: 'rgba(0,0,0,0.22)',
    stroke: 'rgba(255,255,255,0.15)',
  });

  const ribbonColumns = [
    { x: 132, label: 'DISTANCE', value: `${input.run.distanceKm.toFixed(1)} km` },
    { x: 420, label: 'TIME', value: formatDuration(input.run.durationSeconds) },
    { x: 708, label: 'PACE', value: formatPace(input.run.paceSecondsPerKm) ?? 'Sin dato' },
  ];

  ribbonColumns.forEach((column, index) => {
    drawOverlayStat(context, column.x, 1568, column.label, column.value, {
      valueFont: '700 46px "Space Grotesk", sans-serif',
    });
    if (index < ribbonColumns.length - 1) {
      context.fillStyle = 'rgba(255,255,255,0.12)';
      context.fillRect(column.x + 224, 1536, 1.5, 148);
    }
  });

  drawOverlayPill(context, 82, 1408, `${input.run.date}  •  ${input.athleteName.toUpperCase()}`);
}

function renderStudioCapsuleOverlay(context: CanvasRenderingContext2D, input: {
  run: DashboardData['recentRuns'][number];
  route: ActivityRoute;
  athleteName: string;
  providerLabel: string;
}) {
  drawOverlayPill(context, 82, 86, 'STUDIO CAPSULE');
  drawShadowedText(context, 'run capsule', 82, 250, {
    font: '500 100px "Space Grotesk", sans-serif',
  });

  fillRoundedPanel(context, 74, 344, 932, 720, {
    radius: 54,
    fill: 'rgba(0,0,0,0.14)',
    stroke: 'rgba(255,255,255,0.12)',
  });
  drawRouteOverlay({
    context,
    route: input.route,
    x: 120,
    y: 414,
    width: 840,
    height: 580,
    panel: false,
  });

  const capsules = [
    { x: 82, y: 1126, text: `${input.run.distanceKm.toFixed(1)} km` },
    { x: 374, y: 1126, text: formatDuration(input.run.durationSeconds) },
    { x: 660, y: 1126, text: formatPace(input.run.paceSecondsPerKm) ?? 'Sin dato' },
  ];

  capsules.forEach((capsule, index) => {
    fillRoundedPanel(context, capsule.x, capsule.y, 270, 160, {
      radius: 36,
      fill: 'rgba(0,0,0,0.2)',
      stroke: index === 2 ? 'rgba(215,25,33,0.88)' : 'rgba(255,255,255,0.14)',
      lineWidth: index === 2 ? 2 : 1.5,
    });
    context.fillStyle = 'rgba(255,255,255,0.68)';
    context.font = '500 18px "Space Mono", monospace';
    context.fillText(index === 0 ? 'DISTANCE' : index === 1 ? 'TIME' : 'PACE', capsule.x + 26, capsule.y + 42);
    drawShadowedText(context, capsule.text, capsule.x + 26, capsule.y + 108, {
      font: '700 44px "Space Grotesk", sans-serif',
      shadowBlur: 18,
    });
  });

  drawOverlayPill(context, 82, 1734, `${input.run.date}  •  ${input.providerLabel.toUpperCase()}`);
  const athleteWidth = measureOverlayPillWidth(context, input.athleteName.toUpperCase());
  drawOverlayPill(context, 1080 - 82 - athleteWidth, 1734, input.athleteName.toUpperCase());
}

function renderPulseGridOverlay(context: CanvasRenderingContext2D, input: {
  run: DashboardData['recentRuns'][number];
  route: ActivityRoute;
  athleteName: string;
  providerLabel: string;
}) {
  drawOverlayPill(context, 82, 86, 'PULSE GRID');
  drawShadowedText(context, 'metrics first', 82, 226, {
    font: '500 84px "Space Grotesk", sans-serif',
  });

  const topCards = [
    { x: 82, label: 'DISTANCE', value: `${input.run.distanceKm.toFixed(1)} km` },
    { x: 546, label: 'TIME', value: formatDuration(input.run.durationSeconds) },
  ];
  topCards.forEach((card) => drawMetricCard(context, card.x, 302, 382, 136, card.label, card.value));

  drawRouteOverlay({
    context,
    route: input.route,
    x: 82,
    y: 498,
    width: 916,
    height: 604,
    labelLeft: 'TRACK',
    labelRight: input.providerLabel.toUpperCase(),
  });

  const bottomCards = [
    { x: 82, label: 'PACE', value: formatPace(input.run.paceSecondsPerKm) ?? 'Sin dato', accent: true },
    { x: 396, label: 'AVG HR', value: input.run.averageHeartRate ? `${input.run.averageHeartRate} bpm` : 'Sin FC' },
    { x: 710, label: 'ELEV', value: metricValue(input.run.elevationGain, ' m') },
  ];
  bottomCards.forEach((card) => drawMetricCard(context, card.x, 1228, 288, 142, card.label, card.value, !!card.accent));

  fillRoundedPanel(context, 82, 1454, 916, 118, {
    radius: 34,
    fill: 'rgba(0,0,0,0.18)',
    stroke: 'rgba(255,255,255,0.14)',
  });
  drawOverlayStat(context, 116, 1510, 'ATHLETE', input.athleteName.toUpperCase(), {
    valueFont: '600 38px "Doto", "Space Mono", monospace',
  });
  drawOverlayStat(context, 690, 1510, 'DATE', input.run.date, {
    valueFont: '700 34px "Space Grotesk", sans-serif',
  });
}

function renderGhostBadgeOverlay(context: CanvasRenderingContext2D, input: {
  run: DashboardData['recentRuns'][number];
  route: ActivityRoute;
  athleteName: string;
  providerLabel: string;
}) {
  drawOverlayPill(context, 82, 88, 'MINIMAL BADGE');
  drawShadowedText(context, 'run', 84, 236, {
    font: '500 112px "Space Grotesk", sans-serif',
  });

  drawOverlayPill(context, 84, 304, input.run.name.toUpperCase(), {
    fill: 'rgba(0,0,0,0.14)',
  });

  context.save();
  context.fillStyle = 'rgba(0,0,0,0.18)';
  context.font = '700 260px "Doto", "Space Mono", monospace';
  context.fillText(`${formatDistanceCompact(input.run.distanceKm)}KM`, 78, 1120);
  context.restore();

  drawRouteOverlay({
    context,
    route: input.route,
    x: 86,
    y: 1260,
    width: 360,
    height: 270,
    panel: false,
  });

  drawOverlayStat(context, 612, 1248, 'PACE', formatPace(input.run.paceSecondsPerKm) ?? 'Sin dato', {
    valueFont: '700 50px "Space Grotesk", sans-serif',
  });
  drawOverlayStat(context, 612, 1386, 'TIME', formatDuration(input.run.durationSeconds), {
    valueFont: '700 50px "Space Grotesk", sans-serif',
  });
  drawOverlayStat(context, 612, 1524, 'DATE', `${input.run.date}${input.run.timeLabel ? ` · ${input.run.timeLabel}` : ''}`, {
    valueFont: '700 30px "Space Grotesk", sans-serif',
  });
}

function renderVerticalMetricOverlay(context: CanvasRenderingContext2D, input: {
  run: DashboardData['recentRuns'][number];
  route: ActivityRoute;
  athleteName: string;
  providerLabel: string;
}) {
  drawOverlayPill(context, 88, 86, 'VERTICAL METRIC');

  fillRoundedPanel(context, 88, 178, 120, 1520, {
    radius: 44,
    fill: 'rgba(0,0,0,0.18)',
    stroke: 'rgba(255,255,255,0.14)',
  });
  context.save();
  context.translate(150, 1660);
  context.rotate(-Math.PI / 2);
  context.fillStyle = 'rgba(255,255,255,0.78)';
  context.font = '500 28px "Space Mono", monospace';
  context.fillText(`${input.run.date}  •  ${input.providerLabel.toUpperCase()}  •  ${input.athleteName.toUpperCase()}`, 0, 0);
  context.restore();

  drawShadowedText(context, `${formatDistanceCompact(input.run.distanceKm)}km`, 268, 284, {
    font: '600 104px "Doto", "Space Mono", monospace',
  });

  drawRouteOverlay({
    context,
    route: input.route,
    x: 250,
    y: 376,
    width: 748,
    height: 708,
    panel: false,
  });

  const rails = [
    { x: 330, label: 'DISTANCE', value: `${input.run.distanceKm.toFixed(1)} KM` },
    { x: 572, label: 'PACE', value: (formatPace(input.run.paceSecondsPerKm) ?? 'SIN DATO').toUpperCase(), accent: true },
    { x: 814, label: 'TIME', value: formatDuration(input.run.durationSeconds).toUpperCase() },
  ];

  rails.forEach((rail) => {
    fillRoundedPanel(context, rail.x - 58, 1226, 116, 470, {
      radius: 26,
      fill: 'rgba(0,0,0,0.18)',
      stroke: rail.accent ? 'rgba(215,25,33,0.88)' : 'rgba(255,255,255,0.14)',
      lineWidth: rail.accent ? 2 : 1.5,
    });
    context.save();
    context.translate(rail.x + 16, 1660);
    context.rotate(-Math.PI / 2);
    context.fillStyle = 'rgba(255,255,255,0.72)';
    context.font = '500 18px "Space Mono", monospace';
    context.fillText(rail.label, 0, 0);
    context.fillStyle = '#FFFFFF';
    context.font = rail.accent ? '600 40px "Doto", "Space Mono", monospace' : '700 38px "Space Grotesk", sans-serif';
    context.fillText(rail.value, 0, 56);
    context.restore();
  });
}

void [
  renderAuraHeroOverlay,
  renderFloatingStatsOverlay,
  renderMonolithKmOverlay,
  renderSplitEditorialOverlay,
  renderRibbonDataOverlay,
  renderStudioCapsuleOverlay,
  renderPulseGridOverlay,
  renderGhostBadgeOverlay,
  renderVerticalMetricOverlay,
];

async function exportRunShareImage(input: {
  run: DashboardData['recentRuns'][number];
  route: ActivityRoute;
  athleteName: string;
  athleteLocation: string | null;
  athleteAvatarPath: string | null;
  providerLabel: string;
  sessionId: string | null;
  templateId: RunOverlayTemplateId;
}) {
  await document.fonts.ready.catch(() => undefined);

  const width = 1080;
  const height = 684;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('El navegador no ha podido crear el canvas para la imagen.');
  }

  context.clearRect(0, 0, width, height);
  const avatarAsset = await resolveAthleteAvatarAsset(input.athleteAvatarPath, input.sessionId);

  try {
    await renderRouteFocusOverlay(context, {
      ...input,
      athleteAvatarImage: avatarAsset.image,
    });
  } finally {
    avatarAsset.cleanup();
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) {
        resolve(value);
        return;
      }

      reject(new Error('No se pudo generar el PNG del entrenamiento.'));
    }, 'image/png');
  });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `run-overlay-${input.templateId}-${input.run.date}-${input.run.id}.png`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
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

function formatComplianceRate(value: number | null) {
  if (value === null) {
    return 'Sin dato';
  }

  return `${Math.round(value * 100)}%`;
}

function formatPollingLabel(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (!remainderMinutes) {
    return `${hours} h`;
  }

  return `${hours} h ${remainderMinutes} min`;
}

function formatCoachRelativeTime(value: string | null) {
  if (!value) {
    return 'Pendiente';
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return 'Pendiente';
  }

  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(0, Math.round(diffMs / 60_000));

  if (diffMinutes < 1) {
    return 'Ahora mismo';
  }

  if (diffMinutes < 60) {
    return `Hace ${diffMinutes} min`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `Hace ${diffHours} h`;
  }

  return new Date(value).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: '2-digit',
  });
}

function formatCheckInValue(
  group: keyof Pick<CheckInDraft, 'energy' | 'legs' | 'mood'>,
  value: CheckInDraft[typeof group],
) {
  const options = checkInOptions[group];
  return options.find((option) => option.value === value)?.label ?? value;
}

function coachEngineLabel(coach: DashboardData['coach']) {
  if (coach.source === 'gemma4') {
    return coach.model ?? 'Gemma 4';
  }

  if (coach.enabled) {
    return 'Fallback validado';
  }

  return 'Reglas base';
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
  if (week.coachNote?.trim()) {
    return week.coachNote;
  }

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
  const [checkInDraft, setCheckInDraft] = useState<CheckInDraft>(defaultCheckInDraft);
  const [checkInState, setCheckInState] = useState<CheckInState>({
    status: 'idle',
    message: null,
    editing: true,
  });
  const [coachChatDraft, setCoachChatDraft] = useState('');
  const [coachChatMessages, setCoachChatMessages] = useState<CoachChatMessage[]>([]);
  const [coachChatState, setCoachChatState] = useState<{
    status: 'idle' | 'sending' | 'error';
    message: string | null;
  }>({
    status: 'idle',
    message: null,
  });
  const [whatIfDraft, setWhatIfDraft] = useState<WhatIfDraft>(defaultWhatIfDraft(defaultGoal));
  const [whatIfState, setWhatIfState] = useState<WhatIfState>({
    status: 'idle',
    message: null,
    scenario: null,
  });
  const [voiceState, setVoiceState] = useState<VoiceState>({
    status: 'idle',
    target: null,
    message: null,
  });
  const [selectedMetric, setSelectedMetric] = useState<ChartMetric>('sleepHours');
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [routeState, setRouteState] = useState<RouteState>(idleRouteState);
  const [isExportingRunImage, setIsExportingRunImage] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeSection, setActiveSection] = useState<DashboardSectionId>('summary');
  const [scheduleState, setScheduleState] = useState<ScheduleState>({
    key: null,
    status: 'idle',
    message: null,
  });
  const [clockNow, setClockNow] = useState(() => Date.now());
  const refreshInFlightRef = useRef(false);
  const voiceRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
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
    setCheckInDraft(defaultCheckInDraft);
    setCheckInState({
      status: 'idle',
      message: null,
      editing: true,
    });
    setCoachChatDraft('');
    setCoachChatMessages([]);
    setCoachChatState({
      status: 'idle',
      message: null,
    });
    setWhatIfDraft(defaultWhatIfDraft(defaultGoal));
    setWhatIfState({
      status: 'idle',
      message: null,
      scenario: null,
    });
    setVoiceState({
      status: 'idle',
      target: null,
      message: null,
    });
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

  const loadDashboard = async (
    refresh = false,
    explicitSessionId?: string | null,
    options: { surfaceError?: boolean } = {},
  ) => {
    const surfaceError = options.surfaceError ?? true;
    if (!(explicitSessionId ?? sessionIdRef.current)) {
      setState({
        status: 'unauthenticated',
        data: null,
        error: null,
      });
      throw new Error('No hay una sesión activa para cargar el dashboard.');
    }

    if (refreshInFlightRef.current) {
      return null;
    }

    refreshInFlightRef.current = true;
    if (state.status !== 'loading') {
      setIsRefreshing(true);
    }

    try {
      const response = await apiFetch(`/api/dashboard${refresh ? '?refresh=1' : ''}`, {}, explicitSessionId);

      if (response.status === 401) {
        clearSession();
        throw new Error('La sesión se ha perdido antes de poder cargar el dashboard.');
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
      return payload as DashboardData;
    } catch (error) {
      if (surfaceError) {
        startTransition(() => {
          setState({
            status: 'error',
            data: null,
            error: error instanceof Error ? error.message : 'Fallo inesperado',
          });
        });
      }
      throw (error instanceof Error ? error : new Error('Fallo inesperado'));
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

    void loadDashboard().catch(() => undefined);
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

  useEffect(() => () => {
    voiceRecognitionRef.current?.stop();
    voiceRecognitionRef.current = null;
  }, []);

  useEffect(() => {
    if (state.status !== 'ready') {
      return;
    }

    if (selectedWeekIndex > state.data.plan.weeks.length - 1) {
      setSelectedWeekIndex(0);
    }
  }, [selectedWeekIndex, state]);

  useEffect(() => {
    if (state.status !== 'ready') {
      return;
    }

    const latest = state.data.checkIn.latest;
    setCheckInDraft({
      energy: latest?.energy ?? defaultCheckInDraft.energy,
      legs: latest?.legs ?? defaultCheckInDraft.legs,
      mood: latest?.mood ?? defaultCheckInDraft.mood,
      note: latest?.note ?? '',
    });
    setCheckInState((current) => ({
      status: current.status === 'saving' ? current.status : 'idle',
      message: current.status === 'saving' ? current.message : null,
      editing: state.data.checkIn.needsToday,
    }));
  }, [
    state.status,
    state.status === 'ready' ? state.data.checkIn.latest?.date : null,
    state.status === 'ready' ? state.data.checkIn.latest?.createdAt : null,
    state.status === 'ready' ? state.data.checkIn.needsToday : null,
  ]);

  useEffect(() => {
    if (state.status !== 'ready') {
      return;
    }

    setCoachChatMessages(
      state.data.coach.todayMessage
        ? [
            {
              id: `coach-${state.data.coach.generatedAt ?? state.data.fetchedAt}`,
              role: 'assistant',
              text: state.data.coach.todayMessage,
            },
          ]
        : [],
    );
    setCoachChatDraft('');
    setCoachChatState({
      status: 'idle',
      message: null,
    });
  }, [
    state.status,
    state.status === 'ready' ? state.data.provider.key : null,
    state.status === 'ready' ? state.data.athlete.name : null,
  ]);

  useEffect(() => {
    if (state.status !== 'ready') {
      return;
    }

    setWhatIfDraft((current) => ({
      ...current,
      raceDate: current.raceDate || state.data.goal.raceDate,
      distanceKm: current.distanceKm || state.data.goal.distanceKm,
    }));
  }, [
    state.status,
    state.status === 'ready' ? state.data.goal.raceDate : null,
    state.status === 'ready' ? state.data.goal.distanceKm : null,
  ]);

  useEffect(() => {
    if (state.status !== 'ready') {
      setRouteState((current) => (current.status === 'idle' ? current : idleRouteState));
      return;
    }

    const selectedRun =
      state.data.recentRuns.find((run) => run.id === selectedRunId) ??
      state.data.recentRuns[0] ??
      null;

    if (!selectedRun) {
      setRouteState((current) => (current.status === 'idle' ? current : idleRouteState));
      return;
    }

    let cancelled = false;

    setRouteState({
      status: 'loading',
      data: null,
      error: null,
    });

    void (async () => {
      try {
        const response = await apiFetch(`/api/activities/${selectedRun.id}/route`);
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.message ?? 'No se pudo cargar el mapa del entrenamiento.');
        }

        if (cancelled) {
          return;
        }

        setRouteState({
          status: 'ready',
          data: payload as ActivityRoute,
          error: null,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setRouteState({
          status: 'error',
          data: null,
          error: error instanceof Error ? error.message : 'No se pudo cargar el mapa del entrenamiento.',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedRunId, state]);

  useEffect(() => {
    if (state.status !== 'ready' || typeof window === 'undefined') {
      return;
    }

    const sectionElements = dashboardSections
      .map((section) => document.getElementById(`section-${section.id}`))
      .filter((section): section is HTMLElement => section instanceof HTMLElement);

    if (!sectionElements.length) {
      return;
    }

    let frame = 0;

    const updateActiveSection = () => {
      const viewportOffset = window.innerWidth <= 1100 ? 124 : 116;
      let nextActive = dashboardSections[0]?.id ?? 'summary';

      for (const section of sectionElements) {
        const top = section.getBoundingClientRect().top;
        if (top - viewportOffset <= 0) {
          nextActive = section.id.replace('section-', '') as DashboardSectionId;
          continue;
        }
        break;
      }

      setActiveSection((current) => (current === nextActive ? current : nextActive));
    };

    const requestUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateActiveSection);
    };

    requestUpdate();
    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', requestUpdate);
      window.removeEventListener('resize', requestUpdate);
    };
  }, [state.status]);

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
      setState({
        status: 'loading',
        data: null,
        error: null,
      });
      await loadDashboard(false, sessionPayload.sessionId, {
        surfaceError: false,
      });
      setLoginState({
        status: 'idle',
        error: null,
      });
    } catch (error) {
      clearSession();
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

  const applyVoiceTranscript = (target: VoiceTarget, transcript: string) => {
    const cleaned = transcript.trim();
    if (!cleaned) {
      return;
    }

    if (target === 'coach') {
      setCoachChatDraft((current) => `${current}${current.trim() ? ' ' : ''}${cleaned}`.trim());
      return;
    }

    if (target === 'checkin') {
      setCheckInDraft((current) => ({
        ...current,
        note: `${current.note}${current.note.trim() ? ' ' : ''}${cleaned}`.trim(),
      }));
      return;
    }

    setWhatIfDraft((current) => ({
      ...current,
      note: `${current.note}${current.note.trim() ? ' ' : ''}${cleaned}`.trim(),
    }));
  };

  const toggleVoiceCapture = (target: VoiceTarget) => {
    if (voiceState.status === 'recording' && voiceRecognitionRef.current) {
      voiceRecognitionRef.current.stop();
      setVoiceState({
        status: 'idle',
        target: null,
        message: null,
      });
      return;
    }

    const SpeechRecognition = getSpeechRecognitionCtor();
    if (!SpeechRecognition) {
      setVoiceState({
        status: 'unsupported',
        target: null,
        message: 'Tu navegador no soporta dictado web.',
      });
      return;
    }

    const recognition = new SpeechRecognition();
    voiceRecognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'es-ES';
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? '')
        .join(' ')
        .trim();
      applyVoiceTranscript(target, transcript);
    };
    recognition.onerror = () => {
      setVoiceState({
        status: 'unsupported',
        target: null,
        message: 'No he podido capturar el audio.',
      });
    };
    recognition.onend = () => {
      voiceRecognitionRef.current = null;
      setVoiceState((current) =>
        current.status === 'unsupported'
          ? current
          : {
              status: 'idle',
              target: null,
              message: null,
            },
      );
    };
    setVoiceState({
      status: 'recording',
      target,
      message: null,
    });
    recognition.start();
  };

  const submitCheckIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sessionIdRef.current) {
      return;
    }

    setCheckInState({
      status: 'saving',
      message: null,
      editing: true,
    });

    try {
      const response = await apiFetch('/api/checkin', {
        method: 'POST',
        body: JSON.stringify({
          energy: checkInDraft.energy,
          legs: checkInDraft.legs,
          mood: checkInDraft.mood,
          note: checkInDraft.note.trim() || null,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.message ?? 'No se pudo guardar tu check-in diario.');
      }

      await loadDashboard(false);
      setCheckInState({
        status: 'success',
        message: 'Check-in guardado. El plan y los textos ya están afinados con tu sensación de hoy.',
        editing: false,
      });
    } catch (error) {
      setCheckInState({
        status: 'error',
        message: error instanceof Error ? error.message : 'No se pudo guardar el check-in.',
        editing: true,
      });
    }
  };

  const submitCoachChat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = coachChatDraft.trim();
    if (!sessionIdRef.current || !question || state.status !== 'ready') {
      return;
    }

    const userMessage: CoachChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: question,
    };
    setCoachChatMessages((current) => [...current, userMessage]);
    setCoachChatDraft('');
    setCoachChatState({
      status: 'sending',
      message: null,
    });

    try {
      const response = await apiFetch('/api/coach/chat', {
        method: 'POST',
        body: JSON.stringify({
          question,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.message ?? 'No se pudo consultar al coach.');
      }

      setCoachChatMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          text: payload.answer as string,
        },
      ]);
      setCoachChatState({
        status: 'idle',
        message: null,
      });
    } catch (error) {
      setCoachChatState({
        status: 'error',
        message: error instanceof Error ? error.message : 'No se pudo consultar al coach.',
      });
    }
  };

  const submitWhatIfScenario = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sessionIdRef.current || state.status !== 'ready') {
      return;
    }

    setWhatIfState({
      status: 'sending',
      message: null,
      scenario: null,
    });

    try {
      const response = await apiFetch('/api/coach/what-if', {
        method: 'POST',
        body: JSON.stringify({
          raceDate: whatIfDraft.raceDate,
          distanceKm: whatIfDraft.distanceKm,
          availableDays: whatIfDraft.availableDays ? Number(whatIfDraft.availableDays) : null,
          maxWeeklyKm: whatIfDraft.maxWeeklyKm ? Number(whatIfDraft.maxWeeklyKm) : null,
          note: whatIfDraft.note.trim() || null,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.message ?? 'No se pudo simular el escenario.');
      }

      setWhatIfState({
        status: 'success',
        message: null,
        scenario: payload.scenario as WhatIfScenario,
      });
    } catch (error) {
      setWhatIfState({
        status: 'error',
        message: error instanceof Error ? error.message : 'No se pudo simular el escenario.',
        scenario: null,
      });
    }
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

  if (isBoneStudioMode()) {
    return (
      <main className="app-shell">
        <Skeleton
          name="dashboard-shell"
          loading={false}
          fixture={<DashboardLoadingFixture />}
          className="status-panel"
        >
          <DashboardLoadingFixture />
        </Skeleton>
        <Skeleton
          name="route-panel"
          loading={false}
          fixture={<RoutePanelFixture />}
          className="panel"
        >
          <RoutePanelFixture />
        </Skeleton>
      </main>
    );
  }

  if (state.status === 'loading') {
    return (
      <main className="app-shell">
        <Skeleton
          name="dashboard-shell"
          loading
          fixture={<DashboardLoadingFixture />}
          className="status-panel"
          fallback={
            <section className="status-panel">
              <div className="brand-lockup">
                <span className="brand-badge" aria-hidden="true">RR</span>
                <div className="brand-copy">
                  <strong>Race Room</strong>
                  <small>Adaptive running dashboard</small>
                </div>
              </div>
              <BrandSpinner
                label="Cargando tu último estado"
                detail="Primero restauro la sesión y el plan persistido; después refresco el proveedor activo."
              />
            </section>
          }
        >
          <DashboardLoadingFixture />
        </Skeleton>
      </main>
    );
  }

  if (state.status === 'unauthenticated') {
    return (
      <main className="app-shell auth-shell">
        <section className="auth-panel">
          <div className="auth-copy">
            <div className="brand-lockup">
              <span className="brand-badge" aria-hidden="true">RR</span>
              <div className="brand-copy">
                <strong>Race Room</strong>
                <small>Garmin + Strava</small>
              </div>
            </div>
            <p className="eyebrow">Race Room</p>
            <h1>Entra en Race Room con Garmin o Strava</h1>
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
  const readinessWindow = data.wellnessTrend.filter((entry) => entry.readiness !== null).slice(-14);
  const sleepWindow = data.wellnessTrend.filter((entry) => entry.sleepHours !== null).slice(-14);
  const weeklyRunningWindow = data.weeklyRunning.slice(-6);
  const vo2Window = data.vo2Trend.filter((entry) => entry.value !== null).slice(-10);
  const selectedMetricCurrentValue = data.wellnessTrend.at(-1)?.[selectedMetric] ?? null;
  const readinessLatest = readinessWindow.at(-1)?.readiness ?? null;
  const weeklyRunningLatest = weeklyRunningWindow.at(-1)?.distanceKm ?? null;
  const vo2Latest = vo2Window.at(-1)?.value ?? null;
  const selectedWeekKm = selectedWeek ? plannedDistance(selectedWeek) : 0;
  const selectedKeySession = selectedWeek ? keySession(selectedWeek) : null;
  const selectedLongRun = selectedWeek ? longRun(selectedWeek) : null;
  const selectedWeekQualityDays = selectedWeek
    ? selectedWeek.days.filter((day) => day.intensity === 'alto' || day.intensity === 'medio' || day.intensity === 'carrera').length
    : 0;
  const volumeRatio = data.adaptive.signals.volumeRatio;
  const acuteChronicRatio = data.adaptive.signals.acuteChronicRatio;
  const latestCheckIn = data.checkIn.latest;
  const showCheckInForm = data.checkIn.needsToday || checkInState.editing;
  const coachLabel = coachEngineLabel(data.coach);
  const weeklyReview = data.coach.weeklyReview;
  const latestDebrief = data.coach.latestDebrief;
  const nextSyncAt = new Date(data.fetchedAt).getTime() + serverRefreshMs;
  const nextSyncIn = nextSyncAt - clockNow;
  const syncTone = data.fallbackReason ? 'warning' : isRefreshing ? 'syncing' : 'live';
  const syncLabel = data.fallbackReason ? 'Modo provisional' : isRefreshing ? 'Sincronizando' : 'Live';
  const athleteAvatarUrl = data.athlete.avatarPath ? absoluteApiUrl(data.athlete.avatarPath) : null;
  const jumpToSection = (sectionId: DashboardSectionId) => {
    const target = document.getElementById(`section-${sectionId}`);
    if (!target) {
      return;
    }

    setActiveSection(sectionId);
    target.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  };
  const exportSelectedRunImage = async () => {
    if (!selectedRun || isExportingRunImage) {
      return;
    }

    if (routeState.status === 'loading') {
      window.alert('Todavia estoy cargando la ruta de este rodaje. Espera un momento y vuelve a intentarlo.');
      return;
    }

    if (routeState.status !== 'ready') {
      window.alert('Este rodaje no tiene una ruta utilizable para la exportacion.');
      return;
    }

    setIsExportingRunImage(true);

    try {
      await exportRunShareImage({
        run: selectedRun,
        route: routeState.data,
        athleteName: data.athlete.name,
        athleteLocation: data.athlete.location,
        athleteAvatarPath: data.athlete.avatarPath,
        providerLabel: data.provider.label,
        sessionId,
        templateId: runOverlayTemplate.id,
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'No se pudo generar la imagen del rodaje.');
    } finally {
      setIsExportingRunImage(false);
    }
  };
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
    <main className="dashboard-layout">
      <aside className="dashboard-sidebar">
        <div className="dashboard-sidebar-inner">
          <div className="brand-lockup sidebar-brand">
            <span className="brand-badge" aria-hidden="true">RR</span>
            <div className="brand-copy">
              <strong>Race Room</strong>
              <small>{data.provider.label}</small>
            </div>
          </div>
          <p className="eyebrow">Navegación</p>
          <nav className="sidebar-nav" aria-label="Secciones del dashboard">
            {dashboardSections.map((section) => (
              <button
                className={`sidebar-button ${activeSection === section.id ? 'active' : ''}`}
                key={section.id}
                onClick={() => jumpToSection(section.id)}
                type="button"
              >
                <strong>{section.label}</strong>
                <small>{section.note}</small>
              </button>
            ))}
          </nav>
        </div>
      </aside>

      <div className="dashboard-content">
      <section className="hero-panel dashboard-section" id="section-summary">
        <div className="hero-copy">
          <p className="eyebrow">Race Room</p>
          <div className="hero-identity">
            <AthleteAvatar avatarUrl={athleteAvatarUrl} name={data.athlete.name} size="lg" />
            <div className="hero-identity-copy">
              <h1>{data.athlete.name}</h1>
              <p className="hero-identity-meta">
                {data.provider.label}
                {data.athlete.primaryDevice ? ` · ${data.athlete.primaryDevice}` : ''}
                {sessionAccountLabel ? ` · ${sessionAccountLabel}` : ''}
              </p>
            </div>
          </div>
          <p className="lead">
            Dashboard interactivo para preparar {data.goal.label} del {data.goal.raceDate}. Cruza
            recuperación, volumen, rendimiento y plan semanal en una sola vista y arranca con el plan persistido si ya existe.
          </p>
          <div className="hero-meta">
            <span>{data.provider.label}</span>
            <span>{data.goal.daysToRace} días para {data.goal.raceTitle.toLowerCase()}</span>
            <span>{data.goal.totalWeeks} semanas de plan</span>
            {data.athlete.location ? <span>{data.athlete.location}</span> : null}
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

      <section className="coach-strip">
        <article className={`panel daily-checkin-panel ${data.checkIn.needsToday ? 'attention' : ''}`}>
          <div className="panel-head">
            <div>
              <p className="eyebrow">Check-in diario</p>
              <h2>Cómo llegas hoy</h2>
            </div>
            <span className={`checkin-status ${data.checkIn.needsToday ? 'pending' : 'done'}`}>
              {data.checkIn.needsToday ? 'Pendiente hoy' : 'Hecho hoy'}
            </span>
          </div>

          {showCheckInForm ? (
            <form className="checkin-form" onSubmit={submitCheckIn}>
              <div className="checkin-grid">
                <div className="checkin-question">
                  <span>Energía</span>
                  <div className="checkin-options">
                    {checkInOptions.energy.map((option) => (
                      <button
                        key={option.value}
                        className={`checkin-option ${checkInDraft.energy === option.value ? 'selected' : ''}`}
                        disabled={checkInState.status === 'saving'}
                        onClick={() =>
                          setCheckInDraft((current) => ({
                            ...current,
                            energy: option.value,
                          }))
                        }
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="checkin-question">
                  <span>Piernas</span>
                  <div className="checkin-options">
                    {checkInOptions.legs.map((option) => (
                      <button
                        key={option.value}
                        className={`checkin-option ${checkInDraft.legs === option.value ? 'selected' : ''}`}
                        disabled={checkInState.status === 'saving'}
                        onClick={() =>
                          setCheckInDraft((current) => ({
                            ...current,
                            legs: option.value,
                          }))
                        }
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="checkin-question">
                  <span>Cabeza</span>
                  <div className="checkin-options">
                    {checkInOptions.mood.map((option) => (
                      <button
                        key={option.value}
                        className={`checkin-option ${checkInDraft.mood === option.value ? 'selected' : ''}`}
                        disabled={checkInState.status === 'saving'}
                        onClick={() =>
                          setCheckInDraft((current) => ({
                            ...current,
                            mood: option.value,
                          }))
                        }
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <label className="form-field checkin-note-field">
                <span>Nota opcional</span>
                <textarea
                  disabled={checkInState.status === 'saving'}
                  maxLength={220}
                  onChange={(event) =>
                    setCheckInDraft((current) => ({
                      ...current,
                      note: event.target.value,
                    }))
                  }
                  placeholder="Fatiga acumulada, estrés, molestias o cualquier contexto útil para afinar el plan."
                  rows={3}
                  value={checkInDraft.note}
                />
                <div className="field-inline-actions">
                  <button
                    className="inline-voice-button"
                    disabled={checkInState.status === 'saving'}
                    onClick={() => toggleVoiceCapture('checkin')}
                    type="button"
                  >
                    {voiceState.status === 'recording' && voiceState.target === 'checkin' ? 'Parar dictado' : 'Dictar nota'}
                  </button>
                  {voiceState.message && voiceState.target === null ? <small>{voiceState.message}</small> : null}
                </div>
              </label>

              <div className="checkin-footer">
                <p className="checkin-help">
                  Son solo 3 señales subjetivas al día. Race Room las cruza con Garmin o Strava para ajustar el tono,
                  el texto y los microcambios del plan sin disparar el LLM a cada sync.
                </p>
                <div className="checkin-actions">
                  {!data.checkIn.needsToday ? (
                    <button
                      className="secondary-button"
                      disabled={checkInState.status === 'saving'}
                      onClick={() =>
                        setCheckInState({
                          status: 'idle',
                          message: null,
                          editing: false,
                        })
                      }
                      type="button"
                    >
                      Cancelar
                    </button>
                  ) : null}
                  <button className="action-button" disabled={checkInState.status === 'saving'} type="submit">
                    {checkInState.status === 'saving'
                      ? 'Guardando...'
                      : data.checkIn.needsToday
                        ? 'Guardar check-in de hoy'
                        : 'Actualizar check-in'}
                  </button>
                </div>
              </div>

              {checkInState.message ? (
                <p className={`checkin-feedback ${checkInState.status}`}>{checkInState.message}</p>
              ) : null}
            </form>
          ) : (
            <div className="checkin-complete">
              <p className="checkin-help">
                Hoy ya has dejado señal subjetiva. Si cambias de sensación más tarde, puedes actualizarla y volver a
                afinar el coach.
              </p>
              <div className="checkin-summary-chips">
                <span>
                  Energía
                  <strong>{formatCheckInValue('energy', latestCheckIn?.energy ?? 'ok')}</strong>
                </span>
                <span>
                  Piernas
                  <strong>{formatCheckInValue('legs', latestCheckIn?.legs ?? 'normal')}</strong>
                </span>
                <span>
                  Cabeza
                  <strong>{formatCheckInValue('mood', latestCheckIn?.mood ?? 'steady')}</strong>
                </span>
              </div>
              {latestCheckIn?.note ? <p className="checkin-latest-note">“{latestCheckIn.note}”</p> : null}
              {checkInState.message ? (
                <p className={`checkin-feedback ${checkInState.status}`}>{checkInState.message}</p>
              ) : null}
              <div className="checkin-actions">
                <button
                  className="secondary-button"
                  onClick={() =>
                    setCheckInState({
                      status: 'idle',
                      message: null,
                      editing: true,
                    })
                  }
                  type="button"
                >
                  Actualizar sensación de hoy
                </button>
              </div>
            </div>
          )}
        </article>
      </section>

      <section className="coach-stack">
        <article className="panel coach-daily-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Race Room Coach</p>
              <h2>{data.coach.source === 'gemma4' ? 'Gemma 4 + guardrails' : 'Ajuste validado del día'}</h2>
            </div>
            <span className={`checkin-status ${data.coach.source === 'gemma4' ? 'done' : 'pending'}`}>
              {coachLabel}
            </span>
          </div>

          <p className="coach-daily-message">
            {data.coach.todayMessage ??
              'Todavía no hay una lectura subjetiva de hoy. Completa el check-in para dar contexto a los datos duros.'}
          </p>

          <div className="coach-micro-grid">
            <article className="stat-pill">
              <span className="metric-label">Último ajuste</span>
              <strong>{formatCoachRelativeTime(data.coach.generatedAt)}</strong>
              <small>{data.coach.generatedAt ? new Date(data.coach.generatedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : 'Sin generación todavía'}</small>
            </article>
            <article className="stat-pill">
              <span className="metric-label">Próximo refresh proveedor</span>
              <strong>{formatPollingLabel(serverRefreshMs)}</strong>
              <small>Backend con caché viva y sync más conservador</small>
            </article>
            <article className="stat-pill">
              <span className="metric-label">Estado subjetivo</span>
              <strong>
                {latestCheckIn
                  ? `${formatCheckInValue('energy', latestCheckIn.energy)} · ${formatCheckInValue('legs', latestCheckIn.legs)}`
                  : 'Pendiente'}
              </strong>
              <small>{latestCheckIn ? formatCheckInValue('mood', latestCheckIn.mood) : 'Sin check-in de hoy'}</small>
            </article>
          </div>
        </article>

        <div className="coach-insight-grid">
          <article className="panel coach-insight-card">
            <div className="panel-head compact">
              <div>
                <p className="eyebrow">Revisión semanal</p>
                <h3>{weeklyReview?.headline ?? 'Sin revisión todavía'}</h3>
              </div>
              <span className={`adaptive-badge ${weeklyReview?.status ?? data.adaptive.overall}`}>
                {formatAdaptiveOverall(weeklyReview?.status ?? data.adaptive.overall)}
              </span>
            </div>
            <p className="coach-insight-copy">
              {weeklyReview?.summary ?? 'Gemma sintetiza aquí la lectura de la semana cuando hay suficiente contexto.'}
            </p>
            <div className="coach-insight-foot">
              <span className="metric-label">Próximo movimiento</span>
              <strong>{weeklyReview?.nextMove ?? 'Mantén el bloque actual.'}</strong>
            </div>
          </article>

          <article className="panel coach-insight-card">
            <div className="panel-head compact">
              <div>
                <p className="eyebrow">Debrief post-entreno</p>
                <h3>{latestDebrief?.runName ?? 'Último entreno'}</h3>
              </div>
              <span className={`checkin-status ${latestDebrief ? 'done' : 'pending'}`}>
                {latestDebrief ? 'Listo' : 'Pendiente'}
              </span>
            </div>
            <p className="coach-insight-copy">
              {latestDebrief?.summary ?? 'Cuando entra un rodaje nuevo, Gemma resume qué ha dicho realmente ese entreno.'}
            </p>
            <div className="coach-insight-foot">
              <span className="metric-label">Siguiente paso</span>
              <strong>{latestDebrief?.nextStep ?? 'Sin ajuste todavía.'}</strong>
            </div>
          </article>
        </div>

        <article className="panel coach-chat-panel">
          <div className="coach-chat-head">
            <div>
              <p className="eyebrow">Chat</p>
              <h3>{data.coach.enabled ? 'Pregunta a Gemma sobre tu estado' : 'Pregunta al coach'}</h3>
            </div>
            <span className={`checkin-status ${data.coach.enabled ? 'done' : 'pending'}`}>
              {data.coach.enabled ? 'Gemma on demand' : 'Motor base'}
            </span>
          </div>

          <div className="coach-chat-messages">
            {coachChatMessages.length ? (
              coachChatMessages.slice(-6).map((message) => (
                <article className={`coach-chat-bubble ${message.role}`} key={message.id}>
                  <span className="metric-label">{message.role === 'user' ? 'Tú' : 'Race Room Coach'}</span>
                  <p>{message.text}</p>
                </article>
              ))
            ) : (
              <p className="coach-chat-empty">
                Haz una pregunta concreta sobre fatiga, readiness, volumen, ritmo o cómo interpretar tus últimos
                entrenos.
              </p>
            )}
          </div>

          <form className="coach-chat-form" onSubmit={submitCoachChat}>
            <textarea
              disabled={coachChatState.status === 'sending'}
              maxLength={600}
              onChange={(event) => setCoachChatDraft(event.target.value)}
              placeholder={
                data.coach.enabled
                  ? 'Ejemplo: ¿Tiene sentido aflojar mañana si hoy tengo HRV baja pero piernas buenas?'
                  : 'Gemma no está activa. Puedes preguntar igual y Race Room responderá con el contexto base.'
              }
              rows={3}
              value={coachChatDraft}
            />
            <div className="coach-chat-actions">
              <small>
                {data.coach.enabled
                  ? 'Consulta puntual. Gemma pide datos concretos del dashboard cuando los necesita.'
                  : 'Sin Gemma activa: responde el motor base con el contexto actual.'}
              </small>
              <div className="coach-chat-buttons">
                <button
                  className="inline-voice-button"
                  onClick={() => toggleVoiceCapture('coach')}
                  type="button"
                >
                  {voiceState.status === 'recording' && voiceState.target === 'coach' ? 'Parar dictado' : 'Dictar'}
                </button>
                <button
                  className="secondary-button"
                  disabled={coachChatState.status === 'sending' || !coachChatDraft.trim()}
                  type="submit"
                >
                  {coachChatState.status === 'sending'
                    ? 'Pensando...'
                    : data.coach.enabled
                      ? 'Preguntar a Gemma'
                      : 'Preguntar al coach'}
                </button>
              </div>
            </div>
            {coachChatState.message ? <p className="checkin-feedback error">{coachChatState.message}</p> : null}
          </form>
        </article>

        <article className="panel coach-chat-panel">
          <div className="coach-chat-head">
            <div>
              <p className="eyebrow">What-if planner</p>
              <h3>Simula otro objetivo o una semana limitada</h3>
            </div>
            <span className="checkin-status pending">On demand</span>
          </div>

          <form className="whatif-form" onSubmit={submitWhatIfScenario}>
            <div className="field-grid">
              <label className="form-field">
                <span>Fecha</span>
                <input
                  onChange={(event) =>
                    setWhatIfDraft((current) => ({
                      ...current,
                      raceDate: event.target.value,
                    }))
                  }
                  type="date"
                  value={whatIfDraft.raceDate}
                />
              </label>
              <label className="form-field">
                <span>Distancia</span>
                <input
                  min="3"
                  onChange={(event) =>
                    setWhatIfDraft((current) => ({
                      ...current,
                      distanceKm: Number(event.target.value),
                    }))
                  }
                  step="0.1"
                  type="number"
                  value={whatIfDraft.distanceKm}
                />
              </label>
            </div>

            <div className="field-grid">
              <label className="form-field">
                <span>Días/semana</span>
                <input
                  min="2"
                  max="7"
                  onChange={(event) =>
                    setWhatIfDraft((current) => ({
                      ...current,
                      availableDays: event.target.value,
                    }))
                  }
                  placeholder="Opcional"
                  type="number"
                  value={whatIfDraft.availableDays}
                />
              </label>
              <label className="form-field">
                <span>Km máximos/sem</span>
                <input
                  min="0"
                  onChange={(event) =>
                    setWhatIfDraft((current) => ({
                      ...current,
                      maxWeeklyKm: event.target.value,
                    }))
                  }
                  placeholder="Opcional"
                  step="0.1"
                  type="number"
                  value={whatIfDraft.maxWeeklyKm}
                />
              </label>
            </div>

            <label className="form-field">
              <span>Contexto opcional</span>
              <textarea
                maxLength={240}
                onChange={(event) =>
                  setWhatIfDraft((current) => ({
                    ...current,
                    note: event.target.value,
                  }))
                }
                placeholder="Viajes, menos tiempo, foco en marca, molestias..."
                rows={3}
                value={whatIfDraft.note}
              />
              <div className="field-inline-actions">
                <button className="inline-voice-button" onClick={() => toggleVoiceCapture('whatif')} type="button">
                  {voiceState.status === 'recording' && voiceState.target === 'whatif' ? 'Parar dictado' : 'Dictar contexto'}
                </button>
              </div>
            </label>

            <div className="coach-chat-actions">
              <small>Simulación rápida. No toca tu plan real hasta que tú decidas cambiar el objetivo.</small>
              <button className="secondary-button" disabled={whatIfState.status === 'sending'} type="submit">
                {whatIfState.status === 'sending' ? 'Simulando...' : 'Probar escenario'}
              </button>
            </div>
            {whatIfState.message ? <p className="checkin-feedback error">{whatIfState.message}</p> : null}
          </form>

          {whatIfState.scenario ? (
            <div className={`whatif-result risk-${whatIfState.scenario.risk}`}>
              <div className="panel-head compact">
                <div>
                  <p className="eyebrow">Escenario</p>
                  <h3>{whatIfState.scenario.headline}</h3>
                </div>
                <span className={`checkin-status ${whatIfState.scenario.risk === 'low' ? 'done' : 'pending'}`}>
                  Riesgo {whatIfState.scenario.risk}
                </span>
              </div>
              <p className="coach-insight-copy">{whatIfState.scenario.summary}</p>
              <div className="whatif-adjustments">
                {whatIfState.scenario.adjustments.map((item) => (
                  <article className="stat-pill" key={item}>
                    <strong>{item}</strong>
                  </article>
                ))}
              </div>
            </div>
          ) : null}
        </article>
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
      </section>

      <section className="dashboard-section" id="section-sessions">
        <article className="panel recent-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Sesiones recientes</p>
              <h2>Detalle de rodaje</h2>
            </div>
            <span className="mini-status">
              {isRefreshing
                ? `Actualizando con ${data.provider.label}...`
                : `Auto refresh cada ${formatPollingLabel(serverRefreshMs)}`}
            </span>
          </div>

          {selectedRun ? (
            <div className="recent-layout">
              <aside className="run-spotlight">
                <p className="eyebrow">Sesión elegida</p>
                <h3>{selectedRun.name}</h3>
                <p className="run-spotlight-meta">
                  {selectedRun.date}
                  {selectedRun.timeLabel ? ` · ${selectedRun.timeLabel}` : ''}
                  {data.athlete.location ? ` · ${data.athlete.location}` : ''}
                </p>
                {routeState.status === 'ready' ? (
                  <Suspense
                    fallback={
                      <Skeleton
                        name="route-panel"
                        loading
                        fixture={<RoutePanelFixture />}
                        className="route-skeleton-wrap"
                        fallback={
                          <div className="route-map empty">
                            <span>[ LOADING MAP ]</span>
                          </div>
                        }
                      >
                        <RoutePanelFixture />
                      </Skeleton>
                    }
                  >
                    <ActivityRouteMap route={routeState.data} title={selectedRun.name} />
                  </Suspense>
                ) : routeState.status === 'loading' ? (
                  <Skeleton
                    name="route-panel"
                    loading
                    fixture={<RoutePanelFixture />}
                    className="route-skeleton-wrap"
                    fallback={
                      <div className="route-map empty">
                        <span>[ LOADING ROUTE ]</span>
                      </div>
                    }
                  >
                    <RoutePanelFixture />
                  </Skeleton>
                ) : routeState.status === 'error' ? (
                  <div className="route-map empty">
                    <span>[ ROUTE UNAVAILABLE ]</span>
                    <small>{routeState.error}</small>
                  </div>
                ) : null}
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
                <div className="overlay-export-panel">
                  <div className="overlay-export-copy">
                    <span className="metric-label">PNG glass sin fondo</span>
                    <p>
                      Exporta una sola tarjeta glass, tipo iOS, con avatar, nombre, hora, lugar, resumen y mapa en
                      paralelo a los datos, lista para montarla sobre tu foto.
                    </p>
                  </div>
                  <div className="overlay-single-card" aria-label="Overlay activo">
                    <span className="overlay-template-tag">{runOverlayTemplate.label}</span>
                    <strong>{runOverlayTemplate.headline}</strong>
                    <small>{runOverlayTemplate.description}</small>
                  </div>
                  <div className="spotlight-actions">
                    <button
                      className="secondary-button"
                      disabled={isExportingRunImage || routeState.status === 'loading'}
                      onClick={() => void exportSelectedRunImage()}
                      type="button"
                    >
                      {isExportingRunImage
                        ? 'Generando PNG...'
                        : routeState.status === 'loading'
                          ? 'Cargando ruta...'
                          : 'Descargar PNG glass'}
                    </button>
                  </div>
                </div>
              </aside>

              <div className="run-list-panel">
                <p className="eyebrow">Más sesiones</p>
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
                        <span>
                          {run.date}
                          {run.timeLabel ? ` · ${run.timeLabel}` : ''}
                        </span>
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
              </div>
            </div>
          ) : (
            <p className="chart-description">
              {data.provider.label} todavía no ha devuelto actividades recientes. En cuanto sincronice, aquí podrás
              entrar a cada rodaje.
            </p>
          )}
        </article>
      </section>

      <section className="panel plan-panel dashboard-section" id="section-plan">
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

      <section className="panel fitness-summary-panel dashboard-section" id="section-fitness">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Fitness y tendencias</p>
            <h2>{data.fitnessSummary.title}</h2>
          </div>
          <span className={`adaptive-badge ${data.adaptive.overall}`}>
            {formatAdaptiveOverall(data.adaptive.overall)}
          </span>
        </div>

        <p className="fitness-summary-copy">{data.fitnessSummary.body}</p>

        <div className="fitness-chip-strip">
          <span>
            Necesidad principal
            <strong>{data.adaptive.primaryNeed}</strong>
          </span>
          <span>
            Ratio volumen
            <strong>{volumeRatio !== null ? `${volumeRatio.toFixed(2)}x` : 'Sin dato'}</strong>
          </span>
          <span>
            ACWR
            <strong>{acuteChronicRatio !== null ? acuteChronicRatio.toFixed(2) : 'Sin dato'}</strong>
          </span>
          {data.adaptive.signals.keySessionRelocatedTo ? (
            <span>
              Reubicación
              <strong>{data.adaptive.signals.keySessionRelocatedTo}</strong>
            </span>
          ) : null}
        </div>

        <div className="fitness-summary-grid">
          <article className="stat-pill">
            <span className="metric-label">Volumen</span>
            <strong>{formatAdaptiveVolume(data.adaptive.volume)}</strong>
            <small>{metricValue(data.adaptive.signals.recent7Km, ' km', 1)} en 7 días</small>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Ritmo</span>
            <strong>{formatAdaptivePace(data.adaptive.pace)}</strong>
            <small>{formatExecutionDelta(data.adaptive.signals.qualityPaceDeltaSeconds)}</small>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Cumplimiento</span>
            <strong>{formatComplianceRate(data.adaptive.signals.complianceRate7d)}</strong>
            <small>
              {data.adaptive.signals.completedSessions7d}/{data.adaptive.signals.plannedSessions7d} sesiones
            </small>
          </article>
          <article className="stat-pill">
            <span className="metric-label">Recuperación</span>
            <strong>{formatTrainingStatus(data.adaptive.recovery.action)}</strong>
            <small>
              {data.provider.supportsWellness
                ? `${data.adaptive.signals.lowSleepDays7d} noches cortas · ${data.adaptive.signals.lowReadinessDays7d} días bajos`
                : 'Lectura basada en carga y consistencia'}
            </small>
          </article>
        </div>

        <div className="fitness-lead-grid">
          <article className="fitness-chart-card fitness-chart-card--lead">
            <div className="fitness-chart-head fitness-chart-head--stack">
              <div className="fitness-chart-headline">
                <div>
                  <p className="eyebrow">Tendencia principal</p>
                  <h3>{selectedMetricMeta.label} en contexto</h3>
                </div>
                <div className="fitness-chart-badge">
                  <small>Último valor</small>
                  <strong>{formatChartMetric(selectedMetric, selectedMetricCurrentValue)}</strong>
                </div>
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

            <div className="chart-wrap tall fitness-chart-wrap feature">
              <ResponsiveContainer width="100%" height="100%">
                {selectedMetric === 'steps' ? (
                  <BarChart data={data.wellnessTrend}>
                    <CartesianGrid stroke="rgba(255, 255, 255, 0.08)" vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} />
                    <YAxis tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Bar dataKey="steps" radius={[10, 10, 0, 0]} name="Pasos">
                      {data.wellnessTrend.map((entry, index) => (
                        <Cell
                          key={entry.date}
                          fill={
                            index === data.wellnessTrend.length - 1
                              ? 'var(--accent)'
                              : index === data.wellnessTrend.length - 2
                                ? 'var(--warning)'
                                : 'rgba(255, 255, 255, 0.22)'
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                ) : (
                    <AreaChart data={data.wellnessTrend}>
                      <defs>
                        <linearGradient id="metricFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={selectedMetricMeta.tone} stopOpacity={0.34} />
                        <stop offset="95%" stopColor={selectedMetricMeta.tone} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255, 255, 255, 0.08)" vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} />
                    <YAxis hide />
                    <Tooltip />
                    <Area
                      type="monotone"
                      dataKey={selectedMetric}
                      stroke={selectedMetricMeta.tone}
                      fill="url(#metricFill)"
                      strokeWidth={2.4}
                      name={selectedMetricMeta.label}
                      dot={false}
                      activeDot={{ r: 4.5, stroke: selectedMetricMeta.tone, strokeWidth: 2, fill: '#14181f' }}
                      strokeLinecap="round"
                      strokeLinejoin="round"
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

          <article className="fitness-chart-card fitness-chart-card--signal">
            <div className="fitness-chart-head">
              <div>
                <p className="eyebrow">Recuperación</p>
                <h3>Readiness y sueño</h3>
              </div>
              <div className="fitness-chart-badge">
                <small>{data.provider.supportsWellness ? 'Última readiness' : 'Estado'}</small>
                <strong>{data.provider.supportsWellness ? metricValue(readinessLatest) : 'Sin dato'}</strong>
              </div>
            </div>
            {readinessWindow.length ? (
              <>
                <div className="fitness-chart-wrap compact">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={readinessWindow}>
                      <defs>
                        <linearGradient id="fitnessReadinessFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.32} />
                          <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="rgba(255, 255, 255, 0.06)" vertical={false} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} />
                      <YAxis hide domain={['dataMin - 5', 'dataMax + 5']} />
                      <Tooltip />
                      <Area
                        type="monotone"
                        dataKey="readiness"
                        stroke="var(--accent)"
                        fill="url(#fitnessReadinessFill)"
                        strokeWidth={2.4}
                        name="Readiness"
                        dot={false}
                        activeDot={{ r: 4.5, stroke: 'var(--accent)', strokeWidth: 2, fill: '#14181f' }}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="fitness-chart-stats">
                  <span>
                    Última lectura
                    <strong>{metricValue(readinessWindow.at(-1)?.readiness ?? null)}</strong>
                  </span>
                  <span>
                    Sueño medio
                    <strong>{sleepWindow.length ? `${metricAverage(sleepWindow, 'sleepHours')?.toFixed(1)} h` : 'Sin dato'}</strong>
                  </span>
                  <span>
                    Noches cortas
                    <strong>{data.adaptive.signals.lowSleepDays7d}</strong>
                  </span>
                </div>
              </>
            ) : (
              <p className="fitness-empty-copy">
                Este proveedor no trae señales de recuperación suficientes para dibujar una curva útil.
              </p>
            )}
          </article>
        </div>

        <div className="fitness-visual-grid fitness-visual-grid--wide">
          <article className="fitness-chart-card">
            <div className="fitness-chart-head">
              <div>
                <p className="eyebrow">Carga</p>
                <h3>Volumen reciente</h3>
              </div>
              <div className="fitness-chart-badge">
                <small>Última semana</small>
                <strong>{metricValue(weeklyRunningLatest, ' km', 1)}</strong>
              </div>
            </div>
            {weeklyRunningWindow.length ? (
              <>
                <div className="fitness-chart-wrap compact">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={weeklyRunningWindow}>
                      <CartesianGrid stroke="rgba(255, 255, 255, 0.06)" vertical={false} />
                      <XAxis dataKey="weekLabel" tickLine={false} axisLine={false} />
                      <YAxis hide />
                      <Tooltip />
                      <Bar dataKey="distanceKm" radius={[10, 10, 0, 0]} name="Km">
                        {weeklyRunningWindow.map((entry, index) => (
                          <Cell
                            key={entry.weekLabel}
                            fill={index === weeklyRunningWindow.length - 1 ? 'var(--accent)' : index === weeklyRunningWindow.length - 2 ? 'var(--warning)' : 'rgba(255,255,255,0.22)'}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="fitness-chart-stats">
                  <span>
                    7 días
                    <strong>{metricValue(data.adaptive.signals.recent7Km, ' km', 1)}</strong>
                  </span>
                  <span>
                    Base
                    <strong>{metricValue(data.adaptive.signals.baselineWeeklyKm, ' km', 1)}</strong>
                  </span>
                  <span>
                    Rodajes
                    <strong>{weeklyRunningWindow.at(-1)?.runCount ?? 0}</strong>
                  </span>
                </div>
              </>
            ) : (
              <p className="fitness-empty-copy">Aún no hay histórico suficiente para representar la carga.</p>
            )}
          </article>

          <article className="fitness-chart-card">
            <div className="fitness-chart-head">
              <div>
                <p className="eyebrow">Rendimiento</p>
                <h3>VO2 y consistencia</h3>
              </div>
              <div className="fitness-chart-badge">
                <small>Último VO2</small>
                <strong>{metricValue(vo2Latest, '', 0)}</strong>
              </div>
            </div>
            {vo2Window.length ? (
              <>
                <div className="fitness-chart-wrap compact">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={vo2Window}>
                      <defs>
                        <linearGradient id="fitnessVo2Fill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--warning)" stopOpacity={0.28} />
                          <stop offset="95%" stopColor="var(--warning)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="rgba(255, 255, 255, 0.06)" vertical={false} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} />
                      <YAxis hide domain={['dataMin - 1', 'dataMax + 1']} />
                      <Tooltip />
                      <Area
                        type="monotone"
                        dataKey="value"
                        stroke="var(--warning)"
                        fill="url(#fitnessVo2Fill)"
                        strokeWidth={2.4}
                        name="VO2 Max"
                        dot={false}
                        activeDot={{ r: 4.5, stroke: 'var(--warning)', strokeWidth: 2, fill: '#14181f' }}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="fitness-chart-stats">
                  <span>
                    Último VO2
                    <strong>{metricValue(vo2Window.at(-1)?.value ?? null, '', 0)}</strong>
                  </span>
                  <span>
                    Calidad
                    <strong>{data.adaptive.signals.qualitySessions14d}</strong>
                  </span>
                  <span>
                    Cumplimiento
                    <strong>{formatComplianceRate(data.adaptive.signals.complianceRate7d)}</strong>
                  </span>
                </div>
              </>
            ) : (
              <>
                <p className="fitness-empty-copy">
                  No hay VO2 Max reciente, pero la consistencia sigue mandando el bloque.
                </p>
                <div className="fitness-chart-stats">
                  <span>
                    Calidad 14d
                    <strong>{data.adaptive.signals.qualitySessions14d}</strong>
                  </span>
                  <span>
                    Sesiones hechas
                    <strong>{data.adaptive.signals.completedSessions7d}</strong>
                  </span>
                  <span>
                    Días bajos
                    <strong>{data.adaptive.signals.lowReadinessDays7d}</strong>
                  </span>
                </div>
              </>
            )}
          </article>
        </div>
      </section>

      <footer className="footer-note">
        <span>
          Última sincronización: {new Date(data.fetchedAt).toLocaleString()} · El frontend consulta la API
          cada {formatPollingLabel(clientPollMs)} y el backend refresca {data.provider.label} cada {formatPollingLabel(serverRefreshMs)}.
        </span>
      </footer>
      </div>
    </main>
  );
}

export default App;
