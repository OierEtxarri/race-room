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
import {
  BufferTarget,
  CanvasSource,
  Output,
  WebMOutputFormat,
  QUALITY_HIGH,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import type {
  ActivityRoute,
  DashboardActivitySummary,
  DashboardData,
  RouteVideoExportJob,
  RouteVideoRenderSummary,
  SessionPayload,
  UserGoal,
  WhatIfScenario,
} from './types';
import {
  SATELLITE_TILE_URL,
  HILLSHADE_TILE_URL,
  LABELS_TILE_URL,
  PACE_COLORS,
  ROUTE_LINE_STYLES,
  ROUTE_MARKERS,
  MAP_LAYER_FILTERS,
  MAP_LAYER_OPACITIES,
  TILE_SIZE,
  VIDEO_TILE_ZOOM,
  VIDEO_LAYOUT,
  VIDEO_PHASES,
} from './mapStyle';
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
type HealthPayload = {
  publicAuthProviders?: string[];
  publicStravaEnabled?: boolean;
};
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
  action?: string | null;
  followUp?: string | null;
  memory?: Array<{
    title: string;
    detail: string;
  }>;
  tools?: Array<{
    name: string;
    label: string;
    detail: string;
  }>;
  source?: 'gemma4' | 'fallback';
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
  status: 'idle' | 'requesting' | 'recording' | 'unsupported';
  target: VoiceTarget | null;
  message: string | null;
};
type RouteState =
  | { status: 'idle'; data: null; error: null }
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: ActivityRoute; error: null }
  | { status: 'error'; data: null; error: string };
type RunOverlayTemplateId = 'routeGlass';
type DashboardSectionId = 'summary' | 'sessions' | 'plan' | 'coach' | 'fitness';
type PageTransitionState = {
  from: DashboardSectionId;
  direction: 'forward' | 'backward';
} | null;
type AvatarSize = 'sm' | 'lg';
type StaticRouteMapTile = {
  image: HTMLImageElement | null;
  hillshade: HTMLImageElement | null;
  labels: HTMLImageElement | null;
  offsetX: number;
  offsetY: number;
};
type AnimatedRoutePoint = {
  x: number;
  y: number;
  progress: number;
  distanceKm: number;
  elapsedSeconds: number;
  paceSecondsPerKm: number | null;
};
type AnimatedRouteSegment = {
  start: AnimatedRoutePoint;
  end: AnimatedRoutePoint;
  color: string;
};
type RecentActivity = DashboardActivitySummary;
type PreparedStaticRouteMap = {
  tiles: StaticRouteMapTile[];
  mapSurface: HTMLCanvasElement;
  projectedPoints: Array<readonly [number, number]>;
  animatedPoints: AnimatedRoutePoint[];
  animatedSegments: AnimatedRouteSegment[];
};
type PrepareStaticRouteMapOptions = {
  maxZoom?: number;
  hillshadeOpacity?: number;
  labelOpacity?: number;
  zoomBoost?: number;
};
type RouteStrokeScaleOptions = {
  routeStrokeScale?: number;
};
type ColoredRouteSegment = {
  points: Array<[number, number]>;
  color: string;
};
type VideoExportFormat = {
  mimeType: string;
  extension: 'webm' | 'mp4';
};
type RouteVideoTheme = {
  bg: string;
  bgDeep: string;
  panel: string;
  panelStrong: string;
  surface: string;
  heading: string;
  text: string;
  muted: string;
  line: string;
  lineStrong: string;
  accent: string;
  accentDeep: string;
  accentSoft: string;
  accentWarm: string;
  accentWarmSoft: string;
  warning: string;
  mapBase: string;
};

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

type SpeechRecognitionErrorEventLike = Event & {
  error?: string;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
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
  headline: 'Blur card editorial',
  description: 'Poster glass horizontal con mapa premium, avatar y métricas pensadas para compartir.',
};
const routeVideoDurationMs = 20_000;
const routeVideoFps = 15;
const routeVideoRenderScale = 1;
const routeVideoTileOverscanPx = 280;
const routeVideoHighlightColor = '#ff5a36';
const routeVideoLegacyFallbackEnabled = false;
const routeVideoPerspective = {
  followScale: 2.2,
  sourceWidthMultiplier: 1.22,
  sourceHeightMultiplier: 1.55,
  sourceResolutionScale: 1.45,
  sourceFocusX: 0.5,
  sourceFocusY: 0.88,
  horizonRatio: 0.1,
  runnerRatio: 0.84,
  nearSourceTailRatio: 0.08,
  planeDepth: 3.4,
  planeHalfWidth: 1.48,
  cameraHeight: 1.24,
  cameraDistance: 0.84,
  cameraLookAhead: 2.06,
};
const canvasDisplayFontFamily =
  '"SF Pro Display", "SF Pro Text", "SF Pro Icons", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';
const canvasTextFontFamily =
  '"SF Pro Text", "SF Pro Display", "SF Pro Icons", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';

function canvasDisplayFont(sizePx: number, weight: number | string) {
  return `${weight} ${sizePx}px ${canvasDisplayFontFamily}`;
}

function canvasTextFont(sizePx: number, weight: number | string) {
  return `${weight} ${sizePx}px ${canvasTextFontFamily}`;
}

function cssVar(name: string, fallback: string) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return fallback;
  }

  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function resolveRouteVideoTheme(): RouteVideoTheme {
  return {
    bg: cssVar('--bg', '#121212'),
    bgDeep: cssVar('--bg-deep', '#0d0d0d'),
    panel: cssVar('--panel', '#181818'),
    panelStrong: cssVar('--panel-strong', '#1f1f1f'),
    surface: cssVar('--surface', '#232323'),
    heading: cssVar('--heading', '#ffffff'),
    text: cssVar('--text', 'rgba(255,255,255,0.92)'),
    muted: cssVar('--muted', '#b3b3b3'),
    line: cssVar('--line', 'rgba(255,255,255,0.06)'),
    lineStrong: cssVar('--line-strong', '#4d4d4d'),
    accent: cssVar('--accent', '#539df5'),
    accentDeep: cssVar('--accent-deep', '#2f7de8'),
    accentSoft: cssVar('--accent-soft', 'rgba(83,157,245,0.16)'),
    accentWarm: cssVar('--accent-warm', '#f25774'),
    accentWarmSoft: cssVar('--accent-warm-soft', 'rgba(242,87,116,0.16)'),
    warning: cssVar('--warning', '#ffa42b'),
    mapBase: '#11161d',
  };
}

const routeVideoFormatCandidates: VideoExportFormat[] = [
  {
    mimeType: 'video/webm;codecs=vp9,opus',
    extension: 'webm',
  },
  {
    mimeType: 'video/webm;codecs=vp8,opus',
    extension: 'webm',
  },
  {
    mimeType: 'video/webm',
    extension: 'webm',
  },
  {
    mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    extension: 'mp4',
  },
  {
    mimeType: 'video/mp4',
    extension: 'mp4',
  },
];

// MapStyleConfig moved to src/mapStyle.ts (shared source of truth)
// See: SATELLITE_TILE_URL, HILLSHADE_TILE_URL, LABELS_TILE_URL, MAP_LAYER_OPACITIES

// Removed: VideoCameraPhase, VideoCamera types (old phase-based camera model)
// Replaced by inline camera resolution in exportRunRouteVideo

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

function isLikelyMobileDevice() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.matchMedia?.('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent);
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
  { id: 'coach', label: 'Coach', note: 'Gemma 4, check-in, voz y escenarios' },
  { id: 'fitness', label: 'Fitness', note: 'Estado actual, tendencias y ajuste adaptativo' },
];

function dashboardSectionIndex(sectionId: DashboardSectionId) {
  return dashboardSections.findIndex((section) => section.id === sectionId);
}

function initialDashboardSection(): DashboardSectionId {
  if (typeof window === 'undefined') {
    return 'summary';
  }

  const hash = window.location.hash.replace(/^#/, '');
  const match = dashboardSections.find((section) => section.id === hash);
  return match?.id ?? 'summary';
}

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

function distanceBetweenGeoPointsKm(start: [number, number], end: [number, number]) {
  const earthRadiusKm = 6_371;
  const latDelta = ((end[0] - start[0]) * Math.PI) / 180;
  const lngDelta = ((end[1] - start[1]) * Math.PI) / 180;
  const startLat = (start[0] * Math.PI) / 180;
  const endLat = (end[0] * Math.PI) / 180;
  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(lngDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function lerpNumber(start: number, end: number, ratio: number) {
  return start + (end - start) * ratio;
}

function drawPolyline(
  context: CanvasRenderingContext2D,
  points: Array<readonly [number, number]>,
  strokeStyle: string,
  lineWidth: number,
) {
  if (points.length < 2) {
    return;
  }

  context.strokeStyle = strokeStyle;
  context.lineWidth = lineWidth;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  points.forEach(([pointX, pointY], index) => {
    if (index === 0) {
      context.moveTo(pointX, pointY);
    } else {
      context.lineTo(pointX, pointY);
    }
  });
  context.stroke();
}

function downloadBlobAsset(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function pickRouteVideoExportFormat(): VideoExportFormat | null {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return null;
  }

  if (typeof MediaRecorder.isTypeSupported !== 'function') {
    return routeVideoFormatCandidates[0] ?? null;
  }

  return routeVideoFormatCandidates.find((candidate) => MediaRecorder.isTypeSupported(candidate.mimeType)) ?? null;
}

function supportsOfflineRouteVideoExport() {
  return typeof window !== 'undefined'
    && typeof HTMLCanvasElement !== 'undefined'
    && typeof VideoEncoder !== 'undefined';
}

function supportsRouteVideoExport() {
  if (typeof window === 'undefined') {
    return false;
  }

  return typeof fetch === 'function';
}

async function encodeRouteVideoCanvasOffline(input: {
  canvas: HTMLCanvasElement;
  totalFrames: number;
  renderFrame: (frameIndex: number) => void;
}): Promise<{ blob: Blob; extension: 'webm' } | null> {
  if (!supportsOfflineRouteVideoExport()) {
    return null;
  }

  const outputFormat = new WebMOutputFormat();
  const codec = await getFirstEncodableVideoCodec(outputFormat.getSupportedVideoCodecs(), {
    width: input.canvas.width,
    height: input.canvas.height,
    bitrate: QUALITY_HIGH,
  });

  if (!codec) {
    return null;
  }

  const output = new Output({
    format: outputFormat,
    target: new BufferTarget(),
  });
  const source = new CanvasSource(input.canvas, {
    codec,
    bitrate: QUALITY_HIGH,
  });

  output.addVideoTrack(source, {
    frameRate: routeVideoFps,
  });

  await output.start();

  try {
    for (let frameIndex = 0; frameIndex < input.totalFrames; frameIndex += 1) {
      input.renderFrame(frameIndex);
      await source.add(frameIndex / routeVideoFps, 1 / routeVideoFps);

      if (frameIndex % 20 === 0) {
        const progress = clampNumber(frameIndex / Math.max(input.totalFrames - 1, 1), 0, 1);
        console.log(`[exportRunRouteVideo] frame ${frameIndex + 1}/${input.totalFrames} progress=${progress.toFixed(3)}`);
      }
    }

    await output.finalize();
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw error;
  }

  const buffer = output.target.buffer;
  if (!buffer) {
    throw new Error('No se pudo componer el archivo de video offline.');
  }

  return {
    blob: new Blob([buffer], { type: outputFormat.mimeType }),
    extension: 'webm',
  };
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
  const lines = buildWrappedCanvasLines(context, text, maxWidth, maxLines);
  lines.forEach((line, index) => {
    context.fillText(line, x, y + index * lineHeight);
  });
  return lines.length;
}

function buildWrappedCanvasLines(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
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

  return lines;
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const clampedRadius = Math.max(0, Math.min(radius, width / 2, height / 2));

  if (clampedRadius <= 0) {
    context.beginPath();
    context.rect(x, y, width, height);
    context.closePath();
    return;
  }

  context.beginPath();
  context.moveTo(x + clampedRadius, y);
  context.lineTo(x + width - clampedRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + clampedRadius);
  context.lineTo(x + width, y + height - clampedRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - clampedRadius, y + height);
  context.lineTo(x + clampedRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - clampedRadius);
  context.lineTo(x, y + clampedRadius);
  context.quadraticCurveTo(x, y, x + clampedRadius, y);
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
    fill?: string | CanvasGradient | CanvasPattern;
    stroke?: string | CanvasGradient | CanvasPattern;
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
  context.font = canvasTextFont(20, 500);
  context.fillText(label, x + 28, y + 40);
  context.fillStyle = '#FFFFFF';
  context.font = accent ? canvasDisplayFont(54, 600) : canvasDisplayFont(42, 700);
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
  context.font = options.font ?? canvasTextFont(18, 500);
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
  context.font = options.font ?? canvasTextFont(18, 500);
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
  context.font = options.labelFont ?? canvasTextFont(20, 500);
  context.fillText(label, x, y);
  context.fillStyle = options.valueColor ?? '#FFFFFF';
  context.font = options.valueFont ?? canvasDisplayFont(52, 700);
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

const staticTileSize = TILE_SIZE;
// Tile URLs are now imported from mapStyle.ts (shared with ActivityRouteMap.tsx)
// See: SATELLITE_TILE_URL, HILLSHADE_TILE_URL, LABELS_TILE_URL
const staticTileCache = new Map<string, Promise<HTMLImageElement>>();
const tileBundleCache = new Map<string, TileBundle>();
const tileBundlePromises = new Map<string, Promise<TileBundle>>();

type TileBundle = {
  satellite: HTMLImageElement;
  hillshade: HTMLImageElement;
  labels: HTMLImageElement;
};

function tileBundleKey(tile: { z: number; x: number; y: number }) {
  return `${tile.z}:${tile.x}:${tile.y}`;
}

function buildTileBundleUrls(tile: { z: number; x: number; y: number }) {
  const replace = (template: string) =>
    template
      .replace('{z}', String(tile.z))
      .replace('{x}', String(tile.x))
      .replace('{y}', String(tile.y));

  return {
    satellite: replace(SATELLITE_TILE_URL),
    hillshade: replace(HILLSHADE_TILE_URL),
    labels: replace(LABELS_TILE_URL),
  };
}

function distinctTileCoordinates(tiles: Array<{ z: number; x: number; y: number }>) {
  const unique = new Map<string, { z: number; x: number; y: number }>();
  tiles.forEach((tile) => {
    const key = tileBundleKey(tile);
    if (!unique.has(key)) {
      unique.set(key, tile);
    }
  });
  return Array.from(unique.values());
}

async function loadRemoteImageAsset(url: string): Promise<HTMLImageElement> {
  if (!staticTileCache.has(url)) {
    const loadPromise = (async () => {
      const maxAttempts = 3;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const controller = new AbortController();
          const timeoutId = window.setTimeout(() => controller.abort(), 15_000);

          const response = await fetch(url, {
            mode: 'cors',
            cache: 'force-cache',
            signal: controller.signal,
          });
          window.clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`Tile fetch failed ${response.status} ${response.statusText}`);
          }

          const blob = await response.blob();
          const blobUrl = URL.createObjectURL(blob);

          try {
            return await loadImageElement(blobUrl);
          } finally {
            URL.revokeObjectURL(blobUrl);
          }
        } catch (error) {
          lastError = error;
          if (attempt === maxAttempts) {
            throw new Error(`Fallo cargando tile ${url}: ${error instanceof Error ? error.message : String(error)}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        }
      }

      throw lastError;
    })();

    staticTileCache.set(url, loadPromise);
    loadPromise.catch(() => {
      staticTileCache.delete(url);
    });
  }

  return staticTileCache.get(url)!;
}

async function preloadTileBundle(tile: { z: number; x: number; y: number }) {
  const key = tileBundleKey(tile);
  if (!tileBundlePromises.has(key)) {
    const promise = (async () => {
      const urls = buildTileBundleUrls(tile);
      const [satellite, hillshade, labels] = await Promise.all([
        loadRemoteImageAsset(urls.satellite),
        loadRemoteImageAsset(urls.hillshade),
        loadRemoteImageAsset(urls.labels),
      ]);

      const bundle = { satellite, hillshade, labels };
      tileBundleCache.set(key, bundle);
      return bundle;
    })();

    tileBundlePromises.set(key, promise);
    promise.catch(() => {
      tileBundlePromises.delete(key);
      tileBundleCache.delete(key);
    });
  }

  return tileBundlePromises.get(key)!;
}

async function preloadVisibleTileBundles(tiles: Array<{ z: number; x: number; y: number }>) {
  const uniqueTiles = distinctTileCoordinates(tiles);
  await Promise.all(uniqueTiles.map(preloadTileBundle));
  return uniqueTiles.length;
}

function getLoadedTileBundle(tile: { z: number; x: number; y: number }) {
  const key = tileBundleKey(tile);
  const bundle = tileBundleCache.get(key);
  if (!bundle) {
    throw new Error(`Tile bundle ${key} no está precargado`);
  }
  return bundle;
}

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

function routeMedianPace(route: ActivityRoute) {
  const paces = route.samples
    .map((sample) => sample.paceSecondsPerKm)
    .filter((pace): pace is number => typeof pace === 'number' && Number.isFinite(pace) && pace > 0)
    .sort((left, right) => left - right);

  if (!paces.length) {
    return null;
  }

  return paces[Math.floor(paces.length / 2)] ?? null;
}

function paceColor(paceSecondsPerKm: number | null, thresholds: ReturnType<typeof paceThresholds>) {
  if (paceSecondsPerKm === null || !thresholds?.fast || !thresholds.medium) {
    return PACE_COLORS.default;
  }

  if (paceSecondsPerKm <= thresholds.fast) {
    return PACE_COLORS.fast;
  }

  if (paceSecondsPerKm <= thresholds.medium) {
    return PACE_COLORS.medium;
  }

  return PACE_COLORS.slow;
}

function buildColoredRouteSegments(route: ActivityRoute): ColoredRouteSegment[] {
  const thresholds = paceThresholds(route);

  if (route.samples.length >= 2) {
    return route.samples.slice(1).map((sample, index) => {
      const previous = route.samples[index]!;
      const segmentPace =
        sample.paceSecondsPerKm !== null && previous.paceSecondsPerKm !== null
          ? (sample.paceSecondsPerKm + previous.paceSecondsPerKm) / 2
          : sample.paceSecondsPerKm ?? previous.paceSecondsPerKm ?? null;

      return {
        points: [previous.point, sample.point],
        color: paceColor(segmentPace, thresholds),
      };
    });
  }

  return [
    {
      points: route.points,
      color: PACE_COLORS.default,
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

function chooseStaticMapZoom(
  points: Array<[number, number]>,
  width: number,
  height: number,
  padding: number,
  maxZoom = 16,
  zoomBoost = 0,
) {
  // Find the highest zoom where the route still fits, then apply an optional
  // zoomBoost allowing a tighter (more zoomed) initial framing for video.
  for (let zoom = maxZoom; zoom >= 3; zoom -= 1) {
    const projected = points.map(([lat, lng]) => mercatorPixel(lat, lng, zoom));
    const xs = projected.map((point) => point.x);
    const ys = projected.map((point) => point.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);

    if (spanX <= width - padding * 2 && spanY <= height - padding * 2) {
      return Math.min(maxZoom, zoom + zoomBoost);
    }
  }

  return Math.min(maxZoom, 3 + zoomBoost);
}

function staticMapViewport(
  route: ActivityRoute,
  width: number,
  height: number,
  padding: number,
  maxZoom = 16,
  zoomBoost = 0,
) {
  const zoom = chooseStaticMapZoom(route.points, width, height, padding, maxZoom, zoomBoost);
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

function drawPreparedRouteMapBase(
  context: CanvasRenderingContext2D,
  prepared: Pick<PreparedStaticRouteMap, 'tiles'>,
  x: number,
  y: number,
  width: number,
  height: number,
  options: {
    hillshadeOpacity?: number;
    labelOpacity?: number;
  } = {},
) {
  const hillshadeOpacity = options.hillshadeOpacity ?? MAP_LAYER_OPACITIES.hillshade;
  const labelOpacity = options.labelOpacity ?? MAP_LAYER_OPACITIES.labels;
  const drawFilteredLayer = (
    imageKey: 'image' | 'hillshade' | 'labels',
    filter: string,
    drawOptions: {
      alpha?: number;
      composite?: GlobalCompositeOperation;
    } = {},
  ) => {
    context.save();
    context.globalAlpha = drawOptions.alpha ?? 1;
    context.globalCompositeOperation = drawOptions.composite ?? 'source-over';
    context.filter = filter;
    prepared.tiles.forEach((tile) => {
      const image = tile[imageKey];
      if (image) {
        context.drawImage(image, x + tile.offsetX, y + tile.offsetY, staticTileSize, staticTileSize);
      }
    });
    context.restore();
  };

  context.save();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.globalCompositeOperation = 'source-over';
  context.fillStyle = '#11161D';
  context.fillRect(x, y, width, height);

  drawFilteredLayer('image', MAP_LAYER_FILTERS.satellite, {
    alpha: MAP_LAYER_OPACITIES.satellite,
  });
  drawFilteredLayer('hillshade', MAP_LAYER_FILTERS.hillshade, {
    alpha: hillshadeOpacity,
    composite: 'screen',
  });
  drawFilteredLayer('hillshade', MAP_LAYER_FILTERS.hillshade, {
    alpha: hillshadeOpacity * 0.16,
    composite: 'multiply',
  });
  drawFilteredLayer('labels', MAP_LAYER_FILTERS.labels, {
    alpha: labelOpacity,
  });

  context.save();
  context.globalCompositeOperation = 'multiply';
  context.fillStyle = 'rgba(10, 16, 24, 0.18)';
  context.fillRect(x, y, width, height);
  context.restore();

  const topGlow = context.createRadialGradient(
    x + width * 0.82,
    y + height * 0.18,
    0,
    x + width * 0.82,
    y + height * 0.18,
    width * 0.24,
  );
  topGlow.addColorStop(0, 'rgba(83, 157, 245, 0.1)');
  topGlow.addColorStop(1, 'rgba(83, 157, 245, 0)');
  context.fillStyle = topGlow;
  context.fillRect(x, y, width, height);

  const accentGlow = context.createRadialGradient(
    x + width * 0.2,
    y + height * 0.16,
    0,
    x + width * 0.2,
    y + height * 0.16,
    width * 0.22,
  );
  accentGlow.addColorStop(0, 'rgba(242, 87, 116, 0.05)');
  accentGlow.addColorStop(1, 'rgba(242, 87, 116, 0)');
  context.fillStyle = accentGlow;
  context.fillRect(x, y, width, height);

  const bottomGlow = context.createRadialGradient(
    x + width * 0.5,
    y + height,
    0,
    x + width * 0.5,
    y + height,
    width * 0.42,
  );
  bottomGlow.addColorStop(0, 'rgba(0, 0, 0, 0.34)');
  bottomGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = bottomGlow;
  context.fillRect(x, y, width, height);

  const atmosphere = context.createLinearGradient(x, y, x, y + height);
  atmosphere.addColorStop(0, 'rgba(20, 24, 31, 0.04)');
  atmosphere.addColorStop(0.68, 'rgba(20, 24, 31, 0.18)');
  atmosphere.addColorStop(1, 'rgba(20, 24, 31, 0.34)');
  context.fillStyle = atmosphere;
  context.fillRect(x, y, width, height);

  const bottomInset = context.createLinearGradient(x, y + height * 0.56, x, y + height);
  bottomInset.addColorStop(0, 'rgba(0, 0, 0, 0)');
  bottomInset.addColorStop(1, 'rgba(0, 0, 0, 0.28)');
  context.fillStyle = bottomInset;
  context.fillRect(x, y, width, height);

  const vignette = context.createRadialGradient(
    x + width * 0.5,
    y + height * 0.5,
    width * 0.42,
    x + width * 0.5,
    y + height * 0.5,
    width * 0.74,
  );
  vignette.addColorStop(0, 'rgba(10, 16, 24, 0)');
  vignette.addColorStop(0.72, 'rgba(10, 16, 24, 0.12)');
  vignette.addColorStop(1, 'rgba(10, 16, 24, 0.32)');
  context.fillStyle = vignette;
  context.fillRect(x, y, width, height);

  context.restore();
}

async function prepareStaticRouteMap(
  route: ActivityRoute,
  width: number,
  height: number,
  padding: number,
  options: PrepareStaticRouteMapOptions = {},
) {
  const viewport = staticMapViewport(route, width, height, padding, options.maxZoom ?? 16, options.zoomBoost ?? 0);
  const startTileX = Math.floor(viewport.originX / staticTileSize);
  const endTileX = Math.floor((viewport.originX + width) / staticTileSize);
  const startTileY = Math.floor(viewport.originY / staticTileSize);
  const endTileY = Math.floor((viewport.originY + height) / staticTileSize);
  const worldTileCount = 2 ** viewport.zoom;
  const tileJobs: Array<Promise<StaticRouteMapTile>> = [];

  for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
    if (tileY < 0 || tileY >= worldTileCount) {
      continue;
    }

    for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
      const wrappedTileX = ((tileX % worldTileCount) + worldTileCount) % worldTileCount;
      const drawX = tileX * staticTileSize - viewport.originX;
      const drawY = tileY * staticTileSize - viewport.originY;
      const replace = (template: string) =>
        template
          .replace('{z}', String(viewport.zoom))
          .replace('{y}', String(tileY))
          .replace('{x}', String(wrappedTileX));

      tileJobs.push(
        Promise.all([
          loadRemoteImageAsset(replace(SATELLITE_TILE_URL)),
          loadRemoteImageAsset(replace(HILLSHADE_TILE_URL)),
          loadRemoteImageAsset(replace(LABELS_TILE_URL)),
        ]).then(([image, hillshade, labels]) => ({
          image,
          hillshade,
          labels,
          offsetX: drawX,
          offsetY: drawY,
        })),
      );
    }
  }

  const tiles = await Promise.all(tileJobs);
  const mapSurface = document.createElement('canvas');
  mapSurface.width = width;
  mapSurface.height = height;
  const mapSurfaceContext = mapSurface.getContext('2d');
  if (mapSurfaceContext) {
    drawPreparedRouteMapBase(mapSurfaceContext, { tiles }, 0, 0, width, height, {
      hillshadeOpacity: options.hillshadeOpacity,
      labelOpacity: options.labelOpacity,
    });
  }

  const projectedPoints = route.points.map(([lat, lng]) => {
    const pixel = mercatorPixel(lat, lng, viewport.zoom);
    return [pixel.x - viewport.originX, pixel.y - viewport.originY] as const;
  });
  const thresholds = paceThresholds(route);
  const medianPaceSecondsPerKm = routeMedianPace(route) ?? 360;
  const animationSource =
    route.samples.length >= 2
      ? route.samples
      : route.points.map((point) => ({
        point,
        paceSecondsPerKm: null,
        timestampSeconds: null,
      }));
  let cumulativeDistanceKm = 0;
  let cumulativeElapsedSeconds = 0;
  const animatedPoints = animationSource.map((sample, index) => {
    if (index > 0) {
      const previousSample = animationSource[index - 1]!;
      const segmentDistanceKm = distanceBetweenGeoPointsKm(previousSample.point, sample.point);
      cumulativeDistanceKm += segmentDistanceKm;

      const timestampDurationSeconds =
        sample.timestampSeconds !== null &&
        previousSample.timestampSeconds !== null &&
        sample.timestampSeconds > previousSample.timestampSeconds
          ? sample.timestampSeconds - previousSample.timestampSeconds
          : null;
      const paceCandidateSecondsPerKm =
        sample.paceSecondsPerKm ?? previousSample.paceSecondsPerKm ?? medianPaceSecondsPerKm;
      const paceDurationSeconds =
        paceCandidateSecondsPerKm && segmentDistanceKm > 0
          ? paceCandidateSecondsPerKm * segmentDistanceKm
          : null;

      let segmentElapsedSeconds = timestampDurationSeconds ?? paceDurationSeconds ?? segmentDistanceKm * medianPaceSecondsPerKm;

      if (
        timestampDurationSeconds !== null &&
        paceDurationSeconds !== null &&
        timestampDurationSeconds > paceDurationSeconds * 3
      ) {
        segmentElapsedSeconds = paceDurationSeconds;
      }

      cumulativeElapsedSeconds += Math.max(segmentElapsedSeconds, 0.35);
    }

    const pixel = mercatorPixel(sample.point[0], sample.point[1], viewport.zoom);
    return {
      x: pixel.x - viewport.originX,
      y: pixel.y - viewport.originY,
      progress: 0,
      distanceKm: cumulativeDistanceKm,
      elapsedSeconds: cumulativeElapsedSeconds,
      paceSecondsPerKm: sample.paceSecondsPerKm,
    };
  });
  const totalElapsedSeconds = animatedPoints.at(-1)?.elapsedSeconds ?? 0;
  animatedPoints.forEach((point, index) => {
    point.progress =
      totalElapsedSeconds > 0
        ? point.elapsedSeconds / totalElapsedSeconds
        : animatedPoints.length <= 1
          ? 1
          : index / (animatedPoints.length - 1);
  });
  const animatedSegments = animatedPoints.slice(1).map((point, index) => {
    const previousPoint = animatedPoints[index]!;
    const previousSample = animationSource[index]!;
    const sample = animationSource[index + 1]!;
    const segmentPace =
      sample.paceSecondsPerKm !== null && previousSample.paceSecondsPerKm !== null
        ? (sample.paceSecondsPerKm + previousSample.paceSecondsPerKm) / 2
        : sample.paceSecondsPerKm ?? previousSample.paceSecondsPerKm ?? null;

    return {
      start: previousPoint,
      end: point,
      color: paceColor(segmentPace, thresholds),
    };
  });

  return {
    tiles,
    mapSurface,
    projectedPoints,
    animatedPoints,
    animatedSegments,
  } satisfies PreparedStaticRouteMap;
}

// Removed: interpolateAnimatedPoint (old snapshot-based animation)
// Replaced by per-frame interpolation in new world pixel space renderer

function drawAnimatedRouteProgress(
  context: CanvasRenderingContext2D,
  prepared: PreparedStaticRouteMap,
  progress: number,
  options: {
    showActiveMarker?: boolean;
    routeStrokeScale?: number;
  } = {},
) {
  const clampedProgress = clampNumber(progress, 0, 1);
  let activePoint = prepared.animatedPoints[0] ?? null;
  const routeStrokeScale = options.routeStrokeScale ?? 1;

  prepared.animatedSegments.forEach((segment) => {
    if (clampedProgress <= segment.start.progress) {
      return;
    }

    const span = Math.max(segment.end.progress - segment.start.progress, 0.0001);
    const localProgress = clampNumber((clampedProgress - segment.start.progress) / span, 0, 1);
    const endPoint =
      localProgress >= 1
        ? [segment.end.x, segment.end.y] as const
        : [
          lerpNumber(segment.start.x, segment.end.x, localProgress),
          lerpNumber(segment.start.y, segment.end.y, localProgress),
        ] as const;

    context.save();
    context.filter = 'blur(1.4px)';
    drawPolyline(
      context,
      [[segment.start.x, segment.start.y], endPoint],
      `${segment.color}${Math.round(ROUTE_LINE_STYLES.glow.opacity * 255)
        .toString(16)
        .padStart(2, '0')}`,
      ROUTE_LINE_STYLES.glow.width * routeStrokeScale,
    );
    context.restore();

    context.save();
    context.shadowColor = 'rgba(83, 157, 245, 0.18)';
    context.shadowBlur = 10;
    drawPolyline(
      context,
      [[segment.start.x, segment.start.y], endPoint],
      segment.color,
      (ROUTE_LINE_STYLES.main.width + 1) * routeStrokeScale,
    );
    context.restore();

    activePoint =
      localProgress >= 1
        ? segment.end
        : {
          x: endPoint[0],
          y: endPoint[1],
          progress: clampedProgress,
          distanceKm: lerpNumber(segment.start.distanceKm, segment.end.distanceKm, localProgress),
          elapsedSeconds: Math.round(lerpNumber(segment.start.elapsedSeconds, segment.end.elapsedSeconds, localProgress)),
          paceSecondsPerKm: segment.end.paceSecondsPerKm ?? segment.start.paceSecondsPerKm,
        };
  });

  if (!activePoint) {
    return null;
  }

  if (options.showActiveMarker !== false) {
    context.save();
    context.shadowColor = 'rgba(255,255,255,0.16)';
    context.shadowBlur = 16;
    context.fillStyle = 'rgba(255,255,255,0.12)';
    context.beginPath();
    context.arc(activePoint.x, activePoint.y, 20, 0, Math.PI * 2);
    context.fill();
    context.restore();

    context.save();
    context.fillStyle = '#DF3E3E';
    context.beginPath();
    context.arc(activePoint.x, activePoint.y, 8, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = '#FFFFFF';
    context.lineWidth = 3;
    context.beginPath();
    context.arc(activePoint.x, activePoint.y, 11, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  return activePoint;
}

function drawPreparedStaticRouteMapCard(
  context: CanvasRenderingContext2D,
  prepared: PreparedStaticRouteMap,
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 28,
  options: {
    routeProgress?: number;
    showGhostRoute?: boolean;
    showGoalMarker?: boolean;
    showActiveMarker?: boolean;
    routeStrokeScale?: number;
  } = {},
) {
  const matteFill = '#0A1015';
  const routeProgress = options.routeProgress ?? 1;
  const routeStrokeScale = options.routeStrokeScale ?? 1;

  context.save();
  context.shadowColor = 'rgba(0,0,0,0.28)';
  context.shadowBlur = 34;
  context.shadowOffsetY = 14;
  fillRoundedPanel(context, x, y, width, height, {
    radius,
    fill: matteFill,
  });
  context.restore();

  context.save();
  drawRoundedRect(context, x, y, width, height, radius);
  context.clip();
  context.globalCompositeOperation = 'source-over';
  context.fillStyle = matteFill;
  context.fillRect(x, y, width, height);

  if (prepared.mapSurface) {
    context.drawImage(prepared.mapSurface, x, y);
  } else {
    drawPreparedRouteMapBase(context, prepared, x, y, width, height);
  }

  context.save();
  context.translate(x, y);
  if (options.showGhostRoute) {
    drawPolyline(
      context,
      prepared.projectedPoints,
      ROUTE_LINE_STYLES.shadow.color,
      ROUTE_LINE_STYLES.shadow.width * routeStrokeScale,
    );
    drawPolyline(context, prepared.projectedPoints, 'rgba(255,255,255,0.18)', 3.5 * routeStrokeScale);
  }
  drawAnimatedRouteProgress(context, prepared, routeProgress, {
    showActiveMarker: options.showActiveMarker,
    routeStrokeScale,
  });

  const routeStart = prepared.projectedPoints[0]
    ?? (prepared.animatedPoints[0] ? [prepared.animatedPoints[0].x, prepared.animatedPoints[0].y] as const : null);
  context.fillStyle = '#F9F6EB';
  if (routeStart) {
    context.beginPath();
    context.arc(routeStart[0], routeStart[1], 5, 0, Math.PI * 2);
    context.fill();
  }

  if (options.showGoalMarker !== false) {
    const routeEnd = prepared.projectedPoints.at(-1)
      ?? (prepared.animatedPoints.at(-1) ? [prepared.animatedPoints.at(-1)!.x, prepared.animatedPoints.at(-1)!.y] as const : null);
    if (routeEnd) {
      context.fillStyle = routeProgress >= 0.999 ? '#DF3E3E' : 'rgba(223,62,62,0.32)';
      context.beginPath();
      context.arc(routeEnd[0], routeEnd[1], routeProgress >= 0.999 ? 6 : 5, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#F9F6EB';
      context.beginPath();
      context.arc(routeEnd[0], routeEnd[1], 2.5, 0, Math.PI * 2);
      context.fill();
    }
  }
  context.restore();

  const overlayGradient = context.createLinearGradient(x, y, x, y + height);
  overlayGradient.addColorStop(0, 'rgba(12, 17, 24, 0)');
  overlayGradient.addColorStop(1, 'rgba(12, 17, 24, 0.02)');
  context.fillStyle = overlayGradient;
  context.fillRect(x, y, width, height);
  context.restore();

  fillRoundedPanel(context, x, y, width, height, {
    radius,
    stroke: 'rgba(255,255,255,0.2)',
    lineWidth: 1.5,
  });
}

async function waitForLeafletTileLayer(layer: {
  isLoading?: () => boolean;
  once: (event: string, handler: () => void) => void;
  off?: (event: string, handler: () => void) => void;
}) {
  if (typeof layer.isLoading === 'function' && !layer.isLoading()) {
    return;
  }

  await new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(timeoutId);
      layer.off?.('load', finish);
      resolve();
    };
    const timeoutId = window.setTimeout(finish, 8_000);
    layer.once('load', finish);
  });
}

function waitForLeafletFrames(count = 2) {
  return new Promise<void>((resolve) => {
    let remaining = Math.max(1, count);
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  });
}

async function captureLeafletRouteMapCanvas(input: {
  route: ActivityRoute;
  title: string;
  width: number;
  height: number;
} & RouteStrokeScaleOptions) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }

  const [{ toCanvas }, leafletModule] = await Promise.all([
    import('html-to-image'),
    import('leaflet'),
  ]);
  const L = leafletModule.default;
  const points = input.route.points as Array<[number, number]>;
  const routeStrokeScale = input.routeStrokeScale ?? 1;

  if (points.length < 2) {
    return null;
  }

  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.width = `${input.width}px`;
  host.style.height = `${input.height}px`;
  host.style.pointerEvents = 'none';
  host.style.opacity = '1';
  host.style.zIndex = '-1';
  host.setAttribute('aria-hidden', 'true');

  const routeMap = document.createElement('div');
  routeMap.className = 'route-map route-map-capture';
  routeMap.style.width = `${input.width}px`;
  routeMap.style.height = `${input.height}px`;

  const routeMapCanvas = document.createElement('div');
  routeMapCanvas.className = 'route-map-canvas';
  routeMapCanvas.style.width = '100%';
  routeMapCanvas.style.height = '100%';
  routeMapCanvas.style.aspectRatio = 'auto';
  routeMapCanvas.style.minHeight = '0';
  routeMapCanvas.style.borderRadius = '0';
  routeMapCanvas.style.border = '0';

  const mapRoot = document.createElement('div');
  mapRoot.className = 'route-map-leaflet';
  mapRoot.style.width = '100%';
  mapRoot.style.height = '100%';
  mapRoot.style.background = '#11161d';

  routeMapCanvas.append(mapRoot);
  routeMap.append(routeMapCanvas);
  host.append(routeMap);
  document.body.append(host);

  let map: import('leaflet').Map | null = null;

  try {
    map = L.map(mapRoot, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      touchZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      preferCanvas: false,
      fadeAnimation: false,
      zoomAnimation: false,
      markerZoomAnimation: false,
      inertia: false,
    });
    const activeMap = map;

    const satelliteLayer = L.tileLayer(SATELLITE_TILE_URL, {
      crossOrigin: true,
      className: 'route-map-satellite',
    }).addTo(activeMap);

    activeMap.createPane('relief');
    const reliefPane = activeMap.getPane('relief');
    if (reliefPane) {
      reliefPane.style.zIndex = '250';
    }

    const hillshadeLayer = L.tileLayer(HILLSHADE_TILE_URL, {
      crossOrigin: true,
      pane: 'relief',
      className: 'route-map-hillshade',
      opacity: MAP_LAYER_OPACITIES.hillshade,
    }).addTo(activeMap);

    activeMap.createPane('labels');
    const labelsPane = activeMap.getPane('labels');
    if (labelsPane) {
      labelsPane.style.zIndex = '320';
    }

    const labelsLayer = L.tileLayer(LABELS_TILE_URL, {
      crossOrigin: true,
      pane: 'labels',
      className: 'route-map-labels',
      opacity: MAP_LAYER_OPACITIES.labels,
    }).addTo(activeMap);

    activeMap.createPane('route-glow');
    const glowPane = activeMap.getPane('route-glow');
    if (glowPane) {
      glowPane.style.zIndex = '410';
    }

    activeMap.createPane('route-shadow');
    const shadowPane = activeMap.getPane('route-shadow');
    if (shadowPane) {
      shadowPane.style.zIndex = '420';
    }

    activeMap.createPane('route-main');
    const mainPane = activeMap.getPane('route-main');
    if (mainPane) {
      mainPane.style.zIndex = '430';
    }

    const segments = buildColoredRouteSegments(input.route);
    segments.forEach((segment) => {
      L.polyline(segment.points, {
        pane: 'route-glow',
        className: 'route-line route-line-glow',
        color: segment.color,
        lineCap: 'round',
        lineJoin: 'round',
        opacity: ROUTE_LINE_STYLES.glow.opacity,
        weight: ROUTE_LINE_STYLES.glow.width * routeStrokeScale,
      }).addTo(activeMap);
    });

    L.polyline(points, {
      pane: 'route-shadow',
      className: 'route-line route-line-shadow',
      color: ROUTE_LINE_STYLES.shadow.color,
      lineCap: 'round',
      lineJoin: 'round',
      opacity: ROUTE_LINE_STYLES.shadow.opacity,
      weight: ROUTE_LINE_STYLES.shadow.width * routeStrokeScale,
    }).addTo(activeMap);

    segments.forEach((segment) => {
      L.polyline(segment.points, {
        pane: 'route-main',
        className: 'route-line route-line-main',
        color: segment.color,
        lineCap: 'round',
        lineJoin: 'round',
        opacity: ROUTE_LINE_STYLES.main.opacity,
        weight: ROUTE_LINE_STYLES.main.width * routeStrokeScale,
      }).addTo(activeMap);
    });

    const startPoint = points[0];
    const finishPoint = points.at(-1);
    if (startPoint) {
      L.circleMarker(startPoint, {
        className: 'route-marker route-marker-start',
        color: ROUTE_MARKERS.start.color,
        fillColor: ROUTE_MARKERS.start.color,
        fillOpacity: 1,
        weight: 3,
        opacity: 1,
        radius: ROUTE_MARKERS.start.radius,
      }).addTo(activeMap);
    }

    if (finishPoint) {
      L.circleMarker(finishPoint, {
        className: 'route-marker route-marker-finish',
        color: ROUTE_MARKERS.finish.color,
        fillColor: ROUTE_MARKERS.finish.color,
        fillOpacity: 1,
        weight: 3,
        opacity: 1,
        radius: ROUTE_MARKERS.finish.radius,
      }).addTo(activeMap);
    }

    const fitRouteBounds = () => {
      const paddingX = Math.round(clampNumber(input.width * 0.08, 28, 44));
      const paddingY = Math.round(clampNumber(input.height * 0.08, 28, 42));
      activeMap.invalidateSize(true);
      activeMap.fitBounds(L.latLngBounds(points), {
        paddingTopLeft: [paddingX, paddingY],
        paddingBottomRight: [paddingX, paddingY],
        maxZoom: 15,
        animate: false,
      });
    };

    activeMap.whenReady(() => {
      fitRouteBounds();
    });
    await waitForLeafletFrames(2);
    fitRouteBounds();

    await Promise.all([
      waitForLeafletTileLayer(satelliteLayer),
      waitForLeafletTileLayer(hillshadeLayer),
      waitForLeafletTileLayer(labelsLayer),
    ]);
    await waitForLeafletFrames(2);
    fitRouteBounds();
    await waitForLeafletFrames(2);

    return await toCanvas(mapRoot, {
      cacheBust: true,
      pixelRatio: 2,
      backgroundColor: '#11161d',
      width: input.width,
      height: input.height,
    });
  } finally {
    map?.remove();
    host.remove();
  }
}

// Removed: drawVideoMapLayer (old snapshot-based rendering)
// Replaced by new frame-by-frame rendering using drawBaseMapForCamera + drawFullRouteOverview/drawRouteProgressFrame

/*
function drawVideoMapLayer(
  context: CanvasRenderingContext2D,
  prepared: PreparedStaticRouteMap,
  camera: VideoCamera,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const matteFill = '#101010';
  const focusX = width / 2;
  const focusY = height * 0.62;

  context.save();
  context.shadowColor = 'rgba(0,0,0,0.34)';
  context.shadowBlur = 28;
  context.shadowOffsetY = 14;
  fillRoundedPanel(context, x, y, width, height, {
    radius,
    fill: matteFill,
  });
  context.restore();

  context.save();
  drawRoundedRect(context, x, y, width, height, radius);
  context.clip();
  context.fillStyle = matteFill;
  context.fillRect(x, y, width, height);

  context.translate(x, y);
  context.translate(focusX, focusY);

  if (camera.phase === 'runnerCam' || camera.phase === 'transition') {
    context.rotate(camera.headingRadians);
  }

  const zoomScale = Math.pow(2, camera.zoom);
  context.scale(zoomScale, zoomScale);
  context.translate(-camera.centerX, -camera.centerY);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(prepared.mapSurface, 0, 0);

  const isShowingProgress = camera.phase !== 'overview';
  const progressAlpha = camera.phase === 'overview' ? 0 : camera.phase === 'transition' ? (camera.zoom - 0) / 1.2 : 1;

  context.globalAlpha = progressAlpha;
  if (isShowingProgress) {
    drawAnimatedRouteProgress(context, prepared, Math.max(0.01, progressAlpha), {
      showActiveMarker: true,
    });
  }
  context.globalAlpha = 1;

  context.restore();

  const vignette = context.createLinearGradient(x, y, x, y + height);
  vignette.addColorStop(0, 'rgba(0,0,0,0.08)');
  vignette.addColorStop(0.5, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.24)');
  context.fillStyle = vignette;
  drawRoundedRect(context, x, y, width, height, radius);
  context.fill();

  fillRoundedPanel(context, x, y, width, height, {
    radius,
    stroke: 'rgba(255,255,255,0.08)',
    lineWidth: 1.5,
  });
}
*/

// ==============================================================================
// NEW VIDEO PIPELINE: World Pixel Space Rendering
// Designed to render frame-by-frame without pre-cooking a giant mapSurface
// ==============================================================================

/**
 * Playback state for a given progress through the video
 * Includes position, pace, elapsed time, and completion percentage
 */
type PlaybackState = {
  progress: number;
  worldX: number;
  worldY: number;
  distanceKm: number;
  elapsedSeconds: number;
  paceSecondsPerKm: number | null;
  segmentHeading: number;
};

// VisibleTile type removed (not used in final implementation)

/**
 * World rectangle for determining visible tiles
 */
type WorldRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Build playback samples from route points
 * Creates a time-indexed map of route progress for smooth interpolation
 */
function buildPlaybackSamples(route: ActivityRoute, zoom: number): PlaybackState[] {
  const animationSource =
    route.samples.length >= 2
      ? route.samples
      : route.points.map((point) => ({
        point,
        paceSecondsPerKm: null,
        timestampSeconds: null,
      }));

  const medianPaceSecondsPerKm = routeMedianPace(route) ?? 360;
  const samples: PlaybackState[] = [];

  let cumulativeDistanceKm = 0;
  let cumulativeElapsedSeconds = 0;

  for (let index = 0; index < animationSource.length; index += 1) {
    const sample = animationSource[index]!;

    if (index > 0) {
      const previousSample = animationSource[index - 1]!;
      const segmentDistanceKm = distanceBetweenGeoPointsKm(previousSample.point, sample.point);
      cumulativeDistanceKm += segmentDistanceKm;

      const timestampDurationSeconds =
        sample.timestampSeconds !== null &&
        previousSample.timestampSeconds !== null &&
        sample.timestampSeconds > previousSample.timestampSeconds
          ? sample.timestampSeconds - previousSample.timestampSeconds
          : null;

      const paceCandidateSecondsPerKm =
        sample.paceSecondsPerKm ?? previousSample.paceSecondsPerKm ?? medianPaceSecondsPerKm;
      const paceDurationSeconds =
        paceCandidateSecondsPerKm && segmentDistanceKm > 0
          ? paceCandidateSecondsPerKm * segmentDistanceKm
          : null;

      let segmentElapsedSeconds = timestampDurationSeconds ?? paceDurationSeconds ?? segmentDistanceKm * medianPaceSecondsPerKm;

      if (
        timestampDurationSeconds !== null &&
        paceDurationSeconds !== null &&
        timestampDurationSeconds > paceDurationSeconds * 3
      ) {
        segmentElapsedSeconds = paceDurationSeconds;
      }

      cumulativeElapsedSeconds += Math.max(segmentElapsedSeconds, 0.35);
    }

    const pixel = mercatorPixel(sample.point[0], sample.point[1], zoom);

    let segmentHeading = 0;
    if (index > 0) {
      const prev = animationSource[index - 1]!;
      const [lat1, lng1] = prev.point;
      const [lat2, lng2] = sample.point;
      const latDiff = lat2 - lat1;
      const lngDiff = lng2 - lng1;
      segmentHeading = Math.atan2(lngDiff, latDiff);
    }

    samples.push({
      progress: 0,
      worldX: pixel.x,
      worldY: pixel.y,
      distanceKm: cumulativeDistanceKm,
      elapsedSeconds: cumulativeElapsedSeconds,
      paceSecondsPerKm: sample.paceSecondsPerKm,
      segmentHeading,
    });
  }

  const totalElapsedSeconds = samples.at(-1)?.elapsedSeconds ?? 0;
  samples.forEach((sample, index) => {
    sample.progress =
      totalElapsedSeconds > 0
        ? sample.elapsedSeconds / totalElapsedSeconds
        : samples.length <= 1
          ? 1
          : index / (samples.length - 1);
  });

  return samples;
}

/**
 * Interpolate playback state for a given progress (0-1)
 * Uses linear interpolation between nearest samples
 */
function interpolatePlaybackState(samples: PlaybackState[], progress: number): PlaybackState {
  const clampedProgress = clampNumber(progress, 0, 1);
  const firstSample = samples[0];
  const lastSample = samples.at(-1);

  if (!firstSample || !lastSample) {
    return {
      progress: clampedProgress,
      worldX: 0,
      worldY: 0,
      distanceKm: 0,
      elapsedSeconds: 0,
      paceSecondsPerKm: null,
      segmentHeading: 0,
    };
  }

  if (clampedProgress <= firstSample.progress) {
    return { ...firstSample, progress: clampedProgress };
  }

  if (clampedProgress >= lastSample.progress) {
    return { ...lastSample, progress: clampedProgress };
  }

  let left = 0;
  let right = samples.length - 1;

  while (left < right - 1) {
    const mid = Math.floor((left + right) / 2);
    if (samples[mid]!.progress <= clampedProgress) {
      left = mid;
    } else {
      right = mid;
    }
  }

  const sample1 = samples[left]!;
  const sample2 = samples[right]!;
  const span = Math.max(sample2.progress - sample1.progress, 0.0001);
  const t = (clampedProgress - sample1.progress) / span;

  return {
    progress: clampedProgress,
    worldX: lerpNumber(sample1.worldX, sample2.worldX, t),
    worldY: lerpNumber(sample1.worldY, sample2.worldY, t),
    distanceKm: lerpNumber(sample1.distanceKm, sample2.distanceKm, t),
    elapsedSeconds: Math.round(lerpNumber(sample1.elapsedSeconds, sample2.elapsedSeconds, t)),
    paceSecondsPerKm: sample2.paceSecondsPerKm ?? sample1.paceSecondsPerKm,
    segmentHeading: sample1.segmentHeading,
  };
}

/**
 * Calculate smoothed heading using look-ahead and look-behind
 * Provides smooth directional changes in follow cam
 */
function resolveSmoothedHeadingRadians(samples: PlaybackState[], progress: number): number {
  const behindProgress = Math.max(0, progress - 0.012);
  const aheadProgress = Math.min(1, progress + 0.024);

  const behindPoint = interpolatePlaybackState(samples, behindProgress);
  const aheadPoint = interpolatePlaybackState(samples, aheadProgress);

  const dx = aheadPoint.worldX - behindPoint.worldX;
  const dy = aheadPoint.worldY - behindPoint.worldY;
  const distSquared = dx * dx + dy * dy;

  if (distSquared < 1) {
    // Vector too short, use segment heading as fallback
    return aheadPoint.segmentHeading;
  }

  return Math.atan2(dy, dx);
}

// Overview camera and follow camera logic moved inline to exportRunRouteVideo

/**
 * Compute visible world rectangle given camera and card dimensions
 */
function computeVisibleWorldRect(
  camera: { centerX: number; centerY: number; scale: number; heading?: number },
  cardWidth: number,
  cardHeight: number,
  overscanPx = 0,
): WorldRect {
  const halfWidth = cardWidth / (2 * camera.scale);
  const halfHeight = cardHeight / (2 * camera.scale);
  const rotation = camera.heading ?? 0;
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const rotatedHalfWidth = halfWidth * cos + halfHeight * sin + overscanPx / camera.scale;
  const rotatedHalfHeight = halfWidth * sin + halfHeight * cos + overscanPx / camera.scale;

  return {
    x: camera.centerX - rotatedHalfWidth,
    y: camera.centerY - rotatedHalfHeight,
    width: rotatedHalfWidth * 2,
    height: rotatedHalfHeight * 2,
  };
}

function cameraCenterForFocus(
  worldX: number,
  worldY: number,
  heading: number,
  cardX: number,
  cardY: number,
  cardWidth: number,
  cardHeight: number,
  focusX: number,
  focusY: number,
  scale: number,
) {
  const anchorX = cardX + cardWidth / 2;
  const anchorY = cardY + cardHeight / 2;
  const dx = focusX - anchorX;
  const dy = focusY - anchorY;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const worldDx = (dx / scale) * cos + (dy / scale) * sin;
  const worldDy = -(dx / scale) * sin + (dy / scale) * cos;

  return {
    centerX: worldX - worldDx,
    centerY: worldY - worldDy,
  };
}

/**
 * Resolve which tiles are visible in the world rect
 * Returns array of tile coordinates that need to be fetched/rendered
 */
function resolveVisibleTiles(worldRect: WorldRect, tileZoom: number): Array<{ z: number; x: number; y: number }> {
  const tileSize = TILE_SIZE;
  const startTileX = Math.floor(worldRect.x / tileSize);
  const endTileX = Math.floor((worldRect.x + worldRect.width) / tileSize);
  const startTileY = Math.floor(worldRect.y / tileSize);
  const endTileY = Math.floor((worldRect.y + worldRect.height) / tileSize);
  const worldTileCount = 2 ** tileZoom;

  const tiles: Array<{ z: number; x: number; y: number }> = [];

  for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
    if (tileY < 0 || tileY >= worldTileCount) {
      continue;
    }

    for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
      const wrappedX = ((tileX % worldTileCount) + worldTileCount) % worldTileCount;
      tiles.push({ z: tileZoom, x: wrappedX, y: tileY });
    }
  }

  return tiles;
}

/**
 * Render base map layer (satellite with hillshade and labels)
 * Maps world pixels to canvas coordinates using camera transform
 */
function drawBaseMapForCamera(
  context: CanvasRenderingContext2D,
  tileCoords: Array<{ z: number; x: number; y: number }>,
  camera: { centerX: number; centerY: number; scale: number; heading: number },
  cardX: number,
  cardY: number,
  cardWidth: number,
  cardHeight: number,
) {
  const tileSize = TILE_SIZE;
  const anchorX = cardX + cardWidth / 2;
  const anchorY = cardY + cardHeight / 2;

  context.save();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.translate(anchorX, anchorY);
  context.rotate(camera.heading);
  context.scale(camera.scale, camera.scale);
  context.translate(-camera.centerX, -camera.centerY);

  context.globalCompositeOperation = 'source-over';

  for (const tileCoord of tileCoords) {
    const bundle = getLoadedTileBundle(tileCoord);
    const tileX = tileCoord.x * tileSize;
    const tileY = tileCoord.y * tileSize;

    context.filter = MAP_LAYER_FILTERS.satellite;
    context.drawImage(bundle.satellite, tileX, tileY, tileSize, tileSize);

    context.globalAlpha = MAP_LAYER_OPACITIES.hillshade;
    context.globalCompositeOperation = 'screen';
    context.filter = MAP_LAYER_FILTERS.hillshade;
    context.drawImage(bundle.hillshade, tileX, tileY, tileSize, tileSize);

    context.globalAlpha = MAP_LAYER_OPACITIES.hillshade * 0.18;
    context.globalCompositeOperation = 'multiply';
    context.drawImage(bundle.hillshade, tileX, tileY, tileSize, tileSize);

    context.globalAlpha = MAP_LAYER_OPACITIES.labels;
    context.globalCompositeOperation = 'source-over';
    context.filter = MAP_LAYER_FILTERS.labels;
    context.drawImage(bundle.labels, tileX, tileY, tileSize, tileSize);
    context.filter = 'none';
    context.globalAlpha = 1;
  }

  context.filter = 'none';
  context.globalCompositeOperation = 'source-over';
  context.restore();
}

/**
 * Draw full route overview (all segments visible, colored by pace)
 */
function drawFullRouteOverview(
  context: CanvasRenderingContext2D,
  camera: { centerX: number; centerY: number; scale: number; heading: number },
  worldPoints: Array<{ x: number; y: number }>,
  worldSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number }; color: string }>,
  cardX: number,
  cardY: number,
  cardWidth: number,
  cardHeight: number,
) {
  context.save();
  context.translate(cardX + cardWidth / 2, cardY + cardHeight / 2);
  context.rotate(camera.heading);
  context.scale(camera.scale, camera.scale);
  context.translate(-camera.centerX, -camera.centerY);

  context.strokeStyle = ROUTE_LINE_STYLES.shadow.color;
  context.lineWidth = ROUTE_LINE_STYLES.shadow.width;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.globalAlpha = ROUTE_LINE_STYLES.shadow.opacity;
  context.beginPath();
  worldPoints.forEach((point, idx) => {
    if (idx === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.stroke();

  context.globalAlpha = ROUTE_LINE_STYLES.glow.opacity;
  worldSegments.forEach((segment) => {
    context.strokeStyle = segment.color;
    context.lineWidth = ROUTE_LINE_STYLES.glow.width;
    context.beginPath();
    context.moveTo(segment.start.x, segment.start.y);
    context.lineTo(segment.end.x, segment.end.y);
    context.stroke();
  });

  context.globalAlpha = ROUTE_LINE_STYLES.main.opacity;
  worldSegments.forEach((segment) => {
    context.strokeStyle = segment.color;
    context.lineWidth = ROUTE_LINE_STYLES.main.width;
    context.beginPath();
    context.moveTo(segment.start.x, segment.start.y);
    context.lineTo(segment.end.x, segment.end.y);
    context.stroke();
  });

  context.globalAlpha = 1;
  context.fillStyle = ROUTE_MARKERS.start.color;
  context.beginPath();
  context.arc(worldPoints[0]!.x, worldPoints[0]!.y, ROUTE_MARKERS.start.radius, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = ROUTE_MARKERS.finish.color;
  context.beginPath();
  context.arc(worldPoints.at(-1)!.x, worldPoints.at(-1)!.y, ROUTE_MARKERS.finish.radius, 0, Math.PI * 2);
  context.fill();

  context.restore();
}

/**
 * Draw route progress (completed segment + current position)
 */
function drawRouteProgressFrame(
  context: CanvasRenderingContext2D,
  camera: { centerX: number; centerY: number; scale: number; heading: number },
  playbackState: PlaybackState,
  worldPoints: Array<{ x: number; y: number }>,
  worldSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number }; color: string }>,
  progression: number,
  cardX: number,
  cardY: number,
  cardWidth: number,
  cardHeight: number,
  options: {
    showActiveMarker?: boolean;
    visualScale?: number;
  } = {},
) {
  const completedPointCount = Math.max(2, Math.ceil((worldPoints.length - 1) * progression) + 1);
  const completedSegmentCount = Math.max(1, Math.ceil(worldSegments.length * progression));
  const visualScale = options.visualScale ?? 1;

  context.save();
  context.translate(cardX + cardWidth / 2, cardY + cardHeight / 2);
  context.rotate(camera.heading);
  context.scale(camera.scale, camera.scale);
  context.translate(-camera.centerX, -camera.centerY);

  context.strokeStyle = ROUTE_LINE_STYLES.shadow.color;
  context.lineWidth = ROUTE_LINE_STYLES.shadow.width * visualScale;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.globalAlpha = ROUTE_LINE_STYLES.shadow.opacity;
  context.beginPath();
  worldPoints.slice(0, completedPointCount).forEach((point, idx) => {
    if (idx === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.stroke();

  worldSegments.forEach((segment, index) => {
    const completed = index < completedSegmentCount;
    context.globalAlpha = completed ? ROUTE_LINE_STYLES.glow.opacity : 0.08;
    context.strokeStyle = segment.color;
    context.lineWidth = completed
      ? ROUTE_LINE_STYLES.glow.width * visualScale
      : ROUTE_LINE_STYLES.glow.width * 0.72 * visualScale;
    context.beginPath();
    context.moveTo(segment.start.x, segment.start.y);
    context.lineTo(segment.end.x, segment.end.y);
    context.stroke();
  });

  worldSegments.forEach((segment, index) => {
    const completed = index < completedSegmentCount;
    context.globalAlpha = completed ? ROUTE_LINE_STYLES.main.opacity : 0.2;
    context.strokeStyle = segment.color;
    context.lineWidth = completed
      ? ROUTE_LINE_STYLES.main.width * visualScale
      : ROUTE_LINE_STYLES.main.width * 0.78 * visualScale;
    context.beginPath();
    context.moveTo(segment.start.x, segment.start.y);
    context.lineTo(segment.end.x, segment.end.y);
    context.stroke();
  });

  context.globalAlpha = 1;
  context.fillStyle = ROUTE_MARKERS.start.color;
  context.beginPath();
  context.arc(worldPoints[0]!.x, worldPoints[0]!.y, ROUTE_MARKERS.start.radius * visualScale, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = ROUTE_MARKERS.finish.color;
  context.beginPath();
  context.arc(
    worldPoints.at(-1)!.x,
    worldPoints.at(-1)!.y,
    ROUTE_MARKERS.finish.radius * visualScale,
    0,
    Math.PI * 2,
  );
  context.fill();

  if (options.showActiveMarker !== false) {
    const markerRadius = 6.5 * visualScale;
    context.fillStyle = 'rgba(255,255,255,0.18)';
    context.globalAlpha = 1;
    context.beginPath();
    context.arc(playbackState.worldX, playbackState.worldY, markerRadius * 2.4, 0, Math.PI * 2);
    context.fill();
    const markerGradient = context.createLinearGradient(
      playbackState.worldX - markerRadius,
      playbackState.worldY - markerRadius,
      playbackState.worldX + markerRadius,
      playbackState.worldY + markerRadius,
    );
    markerGradient.addColorStop(0, '#F25774');
    markerGradient.addColorStop(1, '#FF9B52');
    context.fillStyle = markerGradient;
    context.beginPath();
    context.arc(playbackState.worldX, playbackState.worldY, markerRadius, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = 'rgba(255,255,255,0.94)';
    context.lineWidth = 2.5 * visualScale;
    context.beginPath();
    context.arc(playbackState.worldX, playbackState.worldY, markerRadius * 1.5, 0, Math.PI * 2);
    context.stroke();
  }

  context.restore();
}

function drawRouteVideoMapCardShell(
  context: CanvasRenderingContext2D,
  layout: typeof VIDEO_LAYOUT,
  theme: RouteVideoTheme,
) {
  context.save();
  context.fillStyle = theme.mapBase;
  context.fillRect(layout.mapCard.x, layout.mapCard.y, layout.mapCard.w, layout.mapCard.h);
  context.restore();
}

type RouteVideoGroundProjector = {
  canvas: HTMLCanvasElement;
  render: (sourceCanvas: HTMLCanvasElement) => void;
};

function multiplyMat4(left: Float32Array, right: Float32Array) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let index = 0; index < 4; index += 1) {
        sum += left[index * 4 + row] * right[column * 4 + index];
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function createPerspectiveMat4(fovRadians: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovRadians / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function normalizeVec3([x, y, z]: [number, number, number]): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function subtractVec3(
  [ax, ay, az]: [number, number, number],
  [bx, by, bz]: [number, number, number],
): [number, number, number] {
  return [ax - bx, ay - by, az - bz];
}

function crossVec3(
  [ax, ay, az]: [number, number, number],
  [bx, by, bz]: [number, number, number],
): [number, number, number] {
  return [
    ay * bz - az * by,
    az * bx - ax * bz,
    ax * by - ay * bx,
  ];
}

function dotVec3(
  [ax, ay, az]: [number, number, number],
  [bx, by, bz]: [number, number, number],
) {
  return ax * bx + ay * by + az * bz;
}

function createLookAtMat4(
  eye: [number, number, number],
  target: [number, number, number],
  up: [number, number, number],
) {
  const zAxis = normalizeVec3(subtractVec3(eye, target));
  const xAxis = normalizeVec3(crossVec3(up, zAxis));
  const yAxis = crossVec3(zAxis, xAxis);

  const out = new Float32Array(16);
  out[0] = xAxis[0];
  out[1] = yAxis[0];
  out[2] = zAxis[0];
  out[4] = xAxis[1];
  out[5] = yAxis[1];
  out[6] = zAxis[1];
  out[8] = xAxis[2];
  out[9] = yAxis[2];
  out[10] = zAxis[2];
  out[12] = -dotVec3(xAxis, eye);
  out[13] = -dotVec3(yAxis, eye);
  out[14] = -dotVec3(zAxis, eye);
  out[15] = 1;
  return out;
}

function createShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('No se pudo crear el shader del route video.');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader) ?? 'shader compile error';
    gl.deleteShader(shader);
    throw new Error(`Shader del route video invalido: ${error}`);
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error('No se pudo crear el programa WebGL del route video.');
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const error = gl.getProgramInfoLog(program) ?? 'program link error';
    gl.deleteProgram(program);
    throw new Error(`Programa WebGL del route video invalido: ${error}`);
  }
  return program;
}

function createRouteVideoGroundProjector(width: number, height: number): RouteVideoGroundProjector | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * routeVideoRenderScale));
  canvas.height = Math.max(1, Math.round(height * routeVideoRenderScale));
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: true,
  });

  if (!gl) {
    return null;
  }

  const vertexSource = `
    attribute vec3 a_position;
    attribute vec2 a_texCoord;
    uniform mat4 u_matrix;
    varying vec2 v_texCoord;
    void main() {
      gl_Position = u_matrix * vec4(a_position, 1.0);
      v_texCoord = a_texCoord;
    }
  `;
  const fragmentSource = `
    precision mediump float;
    varying vec2 v_texCoord;
    uniform sampler2D u_texture;
    void main() {
      gl_FragColor = texture2D(u_texture, v_texCoord);
    }
  `;

  const program = createProgram(gl, vertexSource, fragmentSource);
  const positionLocation = gl.getAttribLocation(program, 'a_position');
  const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');
  const matrixLocation = gl.getUniformLocation(program, 'u_matrix');
  const textureLocation = gl.getUniformLocation(program, 'u_texture');
  const positionBuffer = gl.createBuffer();
  const texCoordBuffer = gl.createBuffer();
  const texture = gl.createTexture();

  if (!positionBuffer || !texCoordBuffer || !texture || !matrixLocation || !textureLocation) {
    return null;
  }

  const halfWidth = routeVideoPerspective.planeHalfWidth;
  const planeDepth = routeVideoPerspective.planeDepth;
  const positions = new Float32Array([
    -halfWidth, 0, 0,
    halfWidth, 0, 0,
    -halfWidth, 0, -planeDepth,
    -halfWidth, 0, -planeDepth,
    halfWidth, 0, 0,
    halfWidth, 0, -planeDepth,
  ]);
  const texCoords = new Float32Array([
    0, 1,
    1, 1,
    0, 0,
    0, 0,
    1, 1,
    1, 0,
  ]);

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  let textureInitialized = false;

  const matrix = multiplyMat4(
    createPerspectiveMat4(Math.PI / 3.4, canvas.width / canvas.height, 0.1, 20),
    createLookAtMat4(
      [0, routeVideoPerspective.cameraHeight, routeVideoPerspective.cameraDistance],
      [0, 0, -routeVideoPerspective.cameraLookAhead],
      [0, 1, 0],
    ),
  );

  return {
    canvas,
    render(sourceCanvas) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);

      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.enableVertexAttribArray(texCoordLocation);
      gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (!textureInitialized) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
        textureInitialized = true;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
      }
      gl.uniform1i(textureLocation, 0);
      gl.uniformMatrix4fv(matrixLocation, false, matrix);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
  };
}

function drawPerspectiveGroundPlane(
  context: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  x: number,
  y: number,
  width: number,
  height: number,
  theme: RouteVideoTheme,
  projector: RouteVideoGroundProjector | null = null,
) {
  context.save();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = theme.mapBase;
  context.fillRect(x, y, width, height);
  if (projector) {
    projector.render(sourceCanvas);
    context.drawImage(projector.canvas, x, y, width, height);
  } else {
    context.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, x, y, width, height);
  }

  const topShade = context.createLinearGradient(0, y, 0, y + height * 0.26);
  topShade.addColorStop(0, 'rgba(8,12,18,0.28)');
  topShade.addColorStop(0.4, 'rgba(8,12,18,0.12)');
  topShade.addColorStop(1, 'rgba(8,12,18,0)');
  context.fillStyle = topShade;
  context.fillRect(x, y, width, height * 0.26);

  const atmosphere = context.createLinearGradient(0, y, 0, y + height);
  atmosphere.addColorStop(0, 'rgba(255,255,255,0.02)');
  atmosphere.addColorStop(0.68, 'rgba(10,16,24,0)');
  atmosphere.addColorStop(1, 'rgba(10,16,24,0.14)');
  context.fillStyle = atmosphere;
  context.fillRect(x, y, width, height);

  context.restore();
}

function drawRouteVideoMapCardChrome(
  context: CanvasRenderingContext2D,
  layout: typeof VIDEO_LAYOUT,
  _run: DashboardData['recentRuns'][number],
  _routeSource: ActivityRoute['source'],
) {
  const x = layout.mapCard.x;
  const y = layout.mapCard.y;
  const width = layout.mapCard.w;
  const height = layout.mapCard.h;
  context.save();
  const topFade = context.createLinearGradient(0, y, 0, y + 250);
  topFade.addColorStop(0, 'rgba(8,12,18,0.84)');
  topFade.addColorStop(0.28, 'rgba(8,12,18,0.42)');
  topFade.addColorStop(1, 'rgba(8,12,18,0)');
  context.fillStyle = topFade;
  context.fillRect(x, y, width, 250);

  const bottomFade = context.createLinearGradient(0, y + height, 0, y + height - 220);
  bottomFade.addColorStop(0, 'rgba(8,12,18,0.7)');
  bottomFade.addColorStop(0.52, 'rgba(8,12,18,0.24)');
  bottomFade.addColorStop(1, 'rgba(8,12,18,0)');
  context.fillStyle = bottomFade;
  context.fillRect(x, y + height - 220, width, 220);

  const leftShade = context.createLinearGradient(x, 0, x + width * 0.24, 0);
  leftShade.addColorStop(0, 'rgba(8,12,18,0.32)');
  leftShade.addColorStop(1, 'rgba(8,12,18,0)');
  context.fillStyle = leftShade;
  context.fillRect(x, y, width * 0.24, height);

  const rightShade = context.createLinearGradient(x + width, 0, x + width * 0.76, 0);
  rightShade.addColorStop(0, 'rgba(8,12,18,0.32)');
  rightShade.addColorStop(1, 'rgba(8,12,18,0)');
  context.fillStyle = rightShade;
  context.fillRect(x + width * 0.76, y, width * 0.24, height);

  context.restore();
}

/**
 * Draw video overlay (header, metrics, progress bar)
 */
function drawVideoBackground(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: RouteVideoTheme,
) {
  context.fillStyle = theme.bgDeep;
  context.fillRect(0, 0, width, height);
}

function drawVideoForeground(
  context: CanvasRenderingContext2D,
  layout: typeof VIDEO_LAYOUT,
  playbackState: PlaybackState,
  run: DashboardData['recentRuns'][number],
  athleteName: string,
  _providerLabel: string,
  theme: RouteVideoTheme,
) {
  const width = layout.canvasWidth;
  const paceLabel = playbackState.paceSecondsPerKm !== null
    ? formatPace(playbackState.paceSecondsPerKm)
    : formatPace(run.paceSecondsPerKm);
  const completion = clampNumber(run.distanceKm > 0 ? playbackState.distanceKm / run.distanceKm : playbackState.progress, 0, 1);
  const metricX = layout.metricsCard.x;
  const metricY = layout.metricsCard.y;
  const metricGap = 10;
  const metricWidth = (layout.metricsCard.w - metricGap * 2) / 3;
  const metricHeight = layout.metricsCard.h;

  context.fillStyle = theme.heading;
  context.font = canvasDisplayFont(24, 650);
  wrapCanvasText(context, run.name.toUpperCase(), layout.header.x, layout.header.y + 28, layout.header.w, 26, 2);

  context.fillStyle = 'rgba(255,255,255,0.7)';
  context.font = canvasTextFont(12, 600);
  context.fillText(
    `${athleteName.toUpperCase()} · ${run.date}${run.timeLabel ? ` · ${run.timeLabel}` : ''}`,
    layout.header.x,
    layout.header.y + 64,
  );

  const metricPanels = [
    { label: 'DISTANCE', value: `${playbackState.distanceKm.toFixed(1)}`, suffix: 'km' },
    { label: 'PACE', value: paceLabel ?? '--:--', suffix: '' },
    { label: 'TIME', value: formatDuration(playbackState.elapsedSeconds), suffix: '' },
  ];

  metricPanels.forEach((panel, index) => {
    const panelX = metricX + index * (metricWidth + metricGap);
    fillRoundedPanel(context, panelX, metricY, metricWidth, metricHeight, {
      radius: layout.metricsCard.r,
      fill: 'rgba(7,10,14,0.68)',
      stroke: 'rgba(255,255,255,0.06)',
      lineWidth: 0.8,
    });
    context.fillStyle = 'rgba(255,255,255,0.58)';
    context.font = canvasTextFont(11, 600);
    context.fillText(panel.label, panelX + 16, metricY + 22);
    context.fillStyle = theme.heading;
    context.font = canvasDisplayFont(index === 0 ? 34 : 30, 650);
    context.fillText(panel.value, panelX + 16, metricY + 58);
    if (panel.suffix) {
      context.fillStyle = 'rgba(255,255,255,0.62)';
      context.font = canvasTextFont(12, 600);
      context.fillText(panel.suffix, panelX + 16, metricY + 76);
    }
  });

  fillRoundedPanel(context, layout.outerPadding, metricY + metricHeight + 14, width - layout.outerPadding * 2, 8, {
    radius: 999,
    fill: 'rgba(255,255,255,0.14)',
  });
  const progressGradient = context.createLinearGradient(
    layout.outerPadding, metricY + metricHeight + 14,
    width - layout.outerPadding, metricY + metricHeight + 14,
  );
  progressGradient.addColorStop(0, '#ff7a45');
  progressGradient.addColorStop(0.6, routeVideoHighlightColor);
  progressGradient.addColorStop(1, '#ff3d00');
  fillRoundedPanel(
    context,
    layout.outerPadding,
    metricY + metricHeight + 14,
    (width - layout.outerPadding * 2) * completion,
    8,
    {
      radius: 999,
      fill: progressGradient,
    },
  );
}

async function drawStaticRouteMapCard(
  context: CanvasRenderingContext2D,
  route: ActivityRoute,
  title: string,
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 28,
  options: RouteStrokeScaleOptions = {},
) {
  try {
    const leafletCanvas = await captureLeafletRouteMapCanvas({
      route,
      title,
      width,
      height,
      routeStrokeScale: options.routeStrokeScale,
    });

    if (leafletCanvas) {
      context.save();
      context.shadowColor = 'rgba(0,0,0,0.28)';
      context.shadowBlur = 34;
      context.shadowOffsetY = 14;
      fillRoundedPanel(context, x, y, width, height, {
        radius,
        fill: '#0A1015',
      });
      context.restore();

      context.save();
      drawRoundedRect(context, x, y, width, height, radius);
      context.clip();
      context.drawImage(leafletCanvas, x, y, width, height);
      context.restore();

      fillRoundedPanel(context, x, y, width, height, {
        radius,
        stroke: 'rgba(255,255,255,0.2)',
        lineWidth: 1.5,
      });
      return;
    }
  } catch (error) {
    console.warn('[blur-card-map] fallback to static renderer', error);
  }

  const prepared = await prepareStaticRouteMap(route, width, height, 28);
  drawPreparedStaticRouteMapCard(context, prepared, x, y, width, height, radius, {
    showActiveMarker: false,
    routeStrokeScale: options.routeStrokeScale,
  });
}

function formatOverlayExportPercent(progress: number) {
  const percent = clampNumber(progress, 0, 1) * 100;
  if (percent >= 99.95) {
    return '100%';
  }
  return `${percent.toFixed(1)}%`;
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
    return `Training Effect ${run.trainingEffect.toFixed(1)}${run.trainingLoad ? ` · carga ${run.trainingLoad.toFixed(0)}` : ''}`;
  }

  if (run.averageHeartRate !== null) {
    return `${run.activityLabel} · ${run.averageHeartRate} bpm medios · ${metricValue(run.elevationGain, ' m')} de desnivel`;
  }

  return `${run.activityLabel} de ${formatActivityDistance(run.distanceKm).toLowerCase()} en ${formatDuration(run.durationSeconds).toLowerCase()}.`;
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
  baseGradient.addColorStop(0, 'rgba(98,104,118,0.22)');
  baseGradient.addColorStop(0.52, 'rgba(54,58,68,0.15)');
  baseGradient.addColorStop(1, 'rgba(20,22,28,0.1)');
  context.fillStyle = baseGradient;
  context.fillRect(x, y, width, height);

  const surfaceLight = context.createLinearGradient(x, y, x, y + height * 0.42);
  surfaceLight.addColorStop(0, 'rgba(255,255,255,0.18)');
  surfaceLight.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = surfaceLight;
  context.fillRect(x, y, width, height);

  const veilGradient = context.createLinearGradient(x, y, x + width, y + height);
  veilGradient.addColorStop(0, 'rgba(255,255,255,0.06)');
  veilGradient.addColorStop(0.45, 'rgba(255,255,255,0.02)');
  veilGradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = veilGradient;
  context.fillRect(x, y, width, height);

  const innerBloom = context.createRadialGradient(
    x + width * 0.76,
    y + height * 0.7,
    0,
    x + width * 0.76,
    y + height * 0.7,
    width * 0.24,
  );
  innerBloom.addColorStop(0, 'rgba(255,255,255,0.06)');
  innerBloom.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = innerBloom;
  context.fillRect(x, y, width, height);
  context.restore();

  fillRoundedPanel(context, x, y, width, height, {
    radius,
    stroke: 'rgba(255,255,255,0.68)',
    lineWidth: 1.4,
  });
}

function drawEditorialGlassPanel(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  options: {
    radius?: number;
    accentColor?: string;
    secondaryAccentColor?: string;
  } = {},
) {
  const radius = options.radius ?? 34;
  const accentColor = options.accentColor ?? 'rgba(83,157,245,0.18)';
  const secondaryAccentColor = options.secondaryAccentColor ?? 'rgba(242,87,116,0.14)';

  context.save();
  drawRoundedRect(context, x, y, width, height, radius);
  context.clip();

  const baseGradient = context.createLinearGradient(x, y, x, y + height);
  baseGradient.addColorStop(0, 'rgba(20,24,32,0.94)');
  baseGradient.addColorStop(0.48, 'rgba(13,16,22,0.9)');
  baseGradient.addColorStop(1, 'rgba(8,10,14,0.96)');
  context.fillStyle = baseGradient;
  context.fillRect(x, y, width, height);

  const highlight = context.createLinearGradient(x, y, x, y + height * 0.36);
  highlight.addColorStop(0, 'rgba(255,255,255,0.15)');
  highlight.addColorStop(0.52, 'rgba(255,255,255,0.04)');
  highlight.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = highlight;
  context.fillRect(x, y, width, height);

  const coolBloom = context.createRadialGradient(
    x + width * 0.82,
    y + height * 0.12,
    0,
    x + width * 0.82,
    y + height * 0.12,
    width * 0.7,
  );
  coolBloom.addColorStop(0, accentColor);
  coolBloom.addColorStop(1, 'rgba(83,157,245,0)');
  context.fillStyle = coolBloom;
  context.fillRect(x, y, width, height);

  const warmBloom = context.createRadialGradient(
    x + width * 0.08,
    y + height * 0.96,
    0,
    x + width * 0.08,
    y + height * 0.96,
    width * 0.76,
  );
  warmBloom.addColorStop(0, secondaryAccentColor);
  warmBloom.addColorStop(1, 'rgba(242,87,116,0)');
  context.fillStyle = warmBloom;
  context.fillRect(x, y, width, height);

  const veil = context.createLinearGradient(x, y, x + width, y + height);
  veil.addColorStop(0, 'rgba(255,255,255,0.08)');
  veil.addColorStop(0.35, 'rgba(255,255,255,0.02)');
  veil.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = veil;
  context.fillRect(x, y, width, height);
  context.restore();

  fillRoundedPanel(context, x, y, width, height, {
    radius,
    stroke: 'rgba(255,255,255,0.14)',
    lineWidth: 1.4,
  });

  context.save();
  drawRoundedRect(context, x + 2, y + 2, width - 4, height - 4, Math.max(radius - 2, 0));
  context.strokeStyle = 'rgba(255,255,255,0.05)';
  context.lineWidth = 1;
  context.stroke();
  context.restore();
}

function drawShareMetricCard(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  value: string,
  options: {
    accent?: boolean;
    valueFont?: string;
  } = {},
) {
  drawEditorialGlassPanel(context, x, y, width, height, {
    radius: 28,
    accentColor: options.accent ? 'rgba(242,87,116,0.18)' : 'rgba(83,157,245,0.14)',
    secondaryAccentColor: options.accent ? 'rgba(255,148,89,0.14)' : 'rgba(83,157,245,0.08)',
  });

  const valueFontSize = height >= 96 ? 34 : 28;
  const valueY = y + height - 28;

  context.fillStyle = options.accent ? 'rgba(255,210,200,0.82)' : 'rgba(255,255,255,0.58)';
  context.font = canvasTextFont(16, 600);
  context.fillText(label, x + 22, y + 30);

  context.fillStyle = '#FFFFFF';
  context.font = options.valueFont ?? canvasDisplayFont(valueFontSize, 650);
  context.fillText(value, x + 22, valueY);

  const accentLine = context.createLinearGradient(x + 20, y, x + width - 20, y);
  accentLine.addColorStop(0, options.accent ? 'rgba(242,87,116,0.92)' : 'rgba(83,157,245,0.88)');
  accentLine.addColorStop(1, options.accent ? 'rgba(255,148,89,0.92)' : 'rgba(114,190,255,0.88)');
  fillRoundedPanel(context, x + 20, y + height - 18, width - 40, 4, {
    radius: 999,
    fill: accentLine,
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
    context.font = canvasTextFont(18, 500);
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
  const width = 1080;
  const height = 684;
  const distanceText = `${formatDistanceCompact(input.run.distanceKm)} km`;
  const dateLine = `${input.run.date}${input.run.timeLabel ? ` · ${input.run.timeLabel}` : ''}`;

  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#0E1218');
  background.addColorStop(0.44, '#111722');
  background.addColorStop(1, '#090B0F');
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const skyGlow = context.createRadialGradient(176, 116, 0, 176, 116, 360);
  skyGlow.addColorStop(0, 'rgba(83,157,245,0.2)');
  skyGlow.addColorStop(1, 'rgba(83,157,245,0)');
  context.fillStyle = skyGlow;
  context.fillRect(0, 0, width, height);

  const warmGlow = context.createRadialGradient(918, 560, 0, 918, 560, 320);
  warmGlow.addColorStop(0, 'rgba(242,87,116,0.18)');
  warmGlow.addColorStop(1, 'rgba(242,87,116,0)');
  context.fillStyle = warmGlow;
  context.fillRect(0, 0, width, height);

  context.save();
  context.strokeStyle = 'rgba(255,255,255,0.04)';
  context.lineWidth = 1;
  for (let column = 0; column < width; column += 108) {
    context.beginPath();
    context.moveTo(column, 0);
    context.lineTo(column, height);
    context.stroke();
  }
  context.restore();

  context.save();
  context.fillStyle = 'rgba(255,255,255,0.045)';
  context.font = '700 198px "Space Grotesk", sans-serif';
  context.fillText(formatDistanceCompact(input.run.distanceKm), 556, 214);
  context.font = '600 48px "Space Mono", monospace';
  context.fillText('KM', 894, 214);
  context.restore();

  const leftPanel = {
    x: 36,
    y: 34,
    w: 470,
    h: 616,
  };
  const mapPanel = {
    x: 530,
    y: 34,
    w: 514,
    h: 616,
  };
  const mapFrame = {
    x: mapPanel.x + 22,
    y: mapPanel.y + 82,
    w: mapPanel.w - 44,
    h: 392,
  };

  drawEditorialGlassPanel(context, leftPanel.x, leftPanel.y, leftPanel.w, leftPanel.h, {
    radius: 40,
    accentColor: 'rgba(83,157,245,0.18)',
    secondaryAccentColor: 'rgba(242,87,116,0.12)',
  });
  drawEditorialGlassPanel(context, mapPanel.x, mapPanel.y, mapPanel.w, mapPanel.h, {
    radius: 40,
    accentColor: 'rgba(242,87,116,0.16)',
    secondaryAccentColor: 'rgba(83,157,245,0.16)',
  });

  const providerWidth = measureOverlayPillWidth(context, input.providerLabel.toUpperCase(), {
    paddingX: 18,
    font: canvasTextFont(16, 600),
  });
  drawOverlayPill(context, leftPanel.x + leftPanel.w - 30 - providerWidth, leftPanel.y + 26, input.providerLabel.toUpperCase(), {
    fill: 'rgba(83,157,245,0.12)',
    stroke: 'rgba(83,157,245,0.28)',
    textColor: 'rgba(220,235,255,0.86)',
    font: canvasTextFont(16, 600),
    height: 46,
    paddingX: 18,
  });

  const topRowY = leftPanel.y + 26;
  const topRowHeight = 46;
  const avatarRadius = 24;
  const avatarX = leftPanel.x + 54;
  const avatarY = topRowY + topRowHeight / 2;
  const athleteMetaX = leftPanel.x + 92;
  const athleteMetaWidth = Math.max(180, leftPanel.w - providerWidth - 152);
  context.save();
  context.beginPath();
  context.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
  context.closePath();

  if (input.athleteAvatarImage) {
    context.save();
    context.clip();
    context.drawImage(
      input.athleteAvatarImage,
      avatarX - avatarRadius,
      avatarY - avatarRadius,
      avatarRadius * 2,
      avatarRadius * 2,
    );
    context.restore();
  } else {
    const avatarGradient = context.createLinearGradient(
      avatarX - avatarRadius,
      avatarY - avatarRadius,
      avatarX + avatarRadius,
      avatarY + avatarRadius,
    );
    avatarGradient.addColorStop(0, '#67B6FF');
    avatarGradient.addColorStop(1, '#4D6BFF');
    context.fillStyle = avatarGradient;
    context.fill();
  }
  context.strokeStyle = 'rgba(255,255,255,0.28)';
  context.lineWidth = 2;
  context.beginPath();
  context.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
  context.stroke();

  if (!input.athleteAvatarImage) {
    context.fillStyle = '#FFFFFF';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = canvasDisplayFont(22, 700);
    context.fillText(athleteInitials(input.athleteName), avatarX, avatarY + 1);
  }
  context.restore();

  context.fillStyle = '#FFFFFF';
  context.font = canvasDisplayFont(22, 620);
  wrapCanvasText(context, input.athleteName, athleteMetaX, topRowY + 18, athleteMetaWidth, 24, 1);
  context.fillStyle = 'rgba(255,255,255,0.68)';
  context.font = canvasTextFont(14, 500);
  wrapCanvasText(context, subtitle || input.providerLabel, athleteMetaX, topRowY + 38, athleteMetaWidth, 16, 1);

  const titleX = leftPanel.x + 30;
  const titleTopY = leftPanel.y + 156;
  const titleMaxWidth = leftPanel.w - 60;
  const titleLineHeight = 62;
  context.fillStyle = '#FFFFFF';
  context.font = canvasDisplayFont(56, 620);
  const titleLines = buildWrappedCanvasLines(context, input.run.name, titleMaxWidth, 3);
  titleLines.forEach((line, index) => {
    context.fillText(line, titleX, titleTopY + index * titleLineHeight);
  });

  const descriptionY = titleTopY + Math.max(titleLines.length, 1) * titleLineHeight + 12;
  const descriptionLineHeight = 28;
  context.fillStyle = 'rgba(255,255,255,0.76)';
  context.font = canvasTextFont(22, 500);
  const descriptionLines = buildWrappedCanvasLines(context, description, leftPanel.w - 76, 2);
  descriptionLines.forEach((line, index) => {
    context.fillText(line, titleX, descriptionY + index * descriptionLineHeight);
  });

  const descriptionBottomY =
    descriptionY + Math.max(descriptionLines.length - 1, 0) * descriptionLineHeight;
  const dividerY = Math.max(leftPanel.y + 402, descriptionBottomY + 42);

  fillRoundedPanel(context, leftPanel.x + 30, dividerY, leftPanel.w - 60, 1.5, {
    radius: 999,
    fill: 'rgba(255,255,255,0.1)',
  });

  const statCardWidth = 194;
  const statCardHeight = 82;
  const statCardGap = 16;
  const statStartX = leftPanel.x + 30;
  const statStartY = dividerY + 22;
  const stats = [
    { label: 'DISTANCE', value: distanceText, accent: true },
    { label: 'PACE', value: formatPace(input.run.paceSecondsPerKm) ?? 'Sin dato' },
    { label: 'TIME', value: formatDuration(input.run.durationSeconds) },
    { label: 'AVG HR', value: input.run.averageHeartRate ? `${input.run.averageHeartRate} bpm` : 'Sin FC' },
  ];

  stats.forEach((stat, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    drawShareMetricCard(
      context,
      statStartX + column * (statCardWidth + statCardGap),
      statStartY + row * (statCardHeight + statCardGap),
      statCardWidth,
      statCardHeight,
      stat.label,
      stat.value,
      {
        accent: stat.accent,
      },
    );
  });

  drawOverlayPill(context, mapPanel.x + 24, mapPanel.y + 24, input.run.activityLabel.toUpperCase(), {
    fill: 'rgba(255,255,255,0.06)',
    stroke: 'rgba(255,255,255,0.12)',
    textColor: 'rgba(255,255,255,0.76)',
    font: canvasTextFont(16, 600),
    height: 46,
    paddingX: 18,
  });
  const routePillWidth = measureOverlayPillWidth(context, 'ROUTE STORY', {
    paddingX: 18,
    font: canvasTextFont(16, 600),
  });
  drawOverlayPill(context, mapPanel.x + mapPanel.w - 24 - routePillWidth, mapPanel.y + 24, 'ROUTE STORY', {
    fill: 'rgba(242,87,116,0.12)',
    stroke: 'rgba(242,87,116,0.24)',
    textColor: 'rgba(255,222,229,0.84)',
    font: canvasTextFont(16, 600),
    height: 46,
    paddingX: 18,
  });

  fillRoundedPanel(context, mapFrame.x - 1, mapFrame.y - 1, mapFrame.w + 2, mapFrame.h + 2, {
    radius: 34,
    fill: 'rgba(5,8,12,0.82)',
  });
  await drawStaticRouteMapCard(
    context,
    input.route,
    input.run.name,
    mapFrame.x,
    mapFrame.y,
    mapFrame.w,
    mapFrame.h,
    34,
    {
      routeStrokeScale: 0.82,
    },
  );

  const detailPanelHeight = 86;
  const detailPanelBottomInset = 42;
  const detailPanelY = mapPanel.y + mapPanel.h - detailPanelBottomInset - detailPanelHeight;
  drawEditorialGlassPanel(context, mapPanel.x + 22, detailPanelY, mapPanel.w - 44, 86, {
    radius: 28,
    accentColor: 'rgba(83,157,245,0.12)',
    secondaryAccentColor: 'rgba(242,87,116,0.12)',
  });
  context.fillStyle = 'rgba(255,255,255,0.58)';
  context.font = canvasTextFont(16, 600);
  context.fillText('DATE', mapPanel.x + 48, detailPanelY + 30);
  context.fillStyle = '#FFFFFF';
  context.font = canvasDisplayFont(24, 620);
  context.fillText(dateLine, mapPanel.x + 48, detailPanelY + 62);

  context.fillStyle = 'rgba(255,255,255,0.58)';
  context.font = canvasTextFont(16, 600);
  context.fillText('ELEV', mapPanel.x + 316, detailPanelY + 30);
  context.fillStyle = '#FFFFFF';
  context.font = canvasDisplayFont(24, 620);
  context.fillText(metricValue(input.run.elevationGain, ' m'), mapPanel.x + 316, detailPanelY + 62);
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

  downloadBlobAsset(blob, `run-overlay-${input.templateId}-${input.run.date}-${input.run.id}.png`);
}

// Removed: resolveVideoCameraForProgress (old phase-based camera model)
// Replaced by new inline camera resolution in exportRunRouteVideo with Hermite easing

/*
function resolveVideoCameraForProgress(
  prepared: PreparedStaticRouteMap,
  progress: number,
  cardWidth: number,
  cardHeight: number,
): { camera: VideoCamera; activePoint: AnimatedRoutePoint } {
  const clampedProgress = clampNumber(progress, 0, 1);
  const activePoint = interpolateAnimatedPoint(prepared, clampedProgress) ?? {
    x: prepared.projectedPoints[0]?.[0] ?? 0,
    y: prepared.projectedPoints[0]?.[1] ?? 0,
    progress: clampedProgress,
    distanceKm: 0,
    elapsedSeconds: 0,
    paceSecondsPerKm: null,
  };

  const overviewPhaseEnd = 0.15;
  const transitionPhaseEnd = 0.35;

  const mapW = prepared.mapSurface.width;
  const mapH = prepared.mapSurface.height;
  const overviewCenterX = mapW / 2;
  const overviewCenterY = mapH / 2;
  const overviewZoom = 0;

  let camera: VideoCamera;

  if (clampedProgress <= overviewPhaseEnd) {
    camera = {
      centerX: overviewCenterX,
      centerY: overviewCenterY,
      zoom: overviewZoom,
      headingRadians: 0,
      phase: 'overview',
    };
  } else if (clampedProgress <= transitionPhaseEnd) {
    const transitionLocalProgress = (clampedProgress - overviewPhaseEnd) / (transitionPhaseEnd - overviewPhaseEnd);
    const eased = transitionLocalProgress * transitionLocalProgress * (3 - 2 * transitionLocalProgress);

    const focusX = cardWidth / 2;
    const focusY = cardHeight * 0.62;
    const runnerCenterX = clampNumber(activePoint.x, focusX, mapW - focusX);
    const runnerCenterY = clampNumber(activePoint.y, focusY, mapH - focusY);

    let heading = 0;
    if (prepared.animatedSegments.length > 0) {
      const segment = prepared.animatedSegments.find((s) => clampedProgress <= s.end.progress) ?? prepared.animatedSegments.at(-1);
      if (segment) {
        heading = Math.atan2(segment.end.y - segment.start.y, segment.end.x - segment.start.x);
      }
    }

    camera = {
      centerX: lerpNumber(overviewCenterX, runnerCenterX, eased),
      centerY: lerpNumber(overviewCenterY, runnerCenterY, eased),
      zoom: lerpNumber(overviewZoom, 1.2, eased),
      headingRadians: heading,
      phase: 'transition',
    };
  } else {
    const focusX = cardWidth / 2;
    const focusY = cardHeight * 0.62;
    const clampedX = clampNumber(activePoint.x, focusX, mapW - focusX);
    const clampedY = clampNumber(activePoint.y, focusY, mapH - focusY);

    let heading = 0;
    if (prepared.animatedSegments.length > 0) {
      const segment = prepared.animatedSegments.find((s) => clampedProgress <= s.end.progress) ?? prepared.animatedSegments.at(-1);
      if (segment) {
        const dx = segment.end.x - segment.start.x;
        const dy = segment.end.y - segment.start.y;
        heading = Math.atan2(dy, dx);
      }
    }

    camera = {
      centerX: clampedX,
      centerY: clampedY,
      zoom: 1.2,
      headingRadians: heading,
      phase: 'runnerCam',
    };
  }

  return { camera, activePoint };
}
*/

// Removed: renderRouteVideoFrame (old snapshot-based pipeline)
// Now using new world pixel space rendering in exportRunRouteVideo

async function exportRunRouteVideo(input: {
  run: DashboardData['recentRuns'][number];
  route: ActivityRoute;
  athleteName: string;
  providerLabel: string;
}) {
  await document.fonts.ready.catch(() => undefined);
  console.log('[exportRunRouteVideo] start', { runId: input.run.id, date: input.run.date });

  const fallbackFormat = pickRouteVideoExportFormat();
  if (!supportsOfflineRouteVideoExport() && !fallbackFormat) {
    throw new Error('Este navegador no soporta la exportacion de video desde canvas.');
  }

  const theme = resolveRouteVideoTheme();
  const layout = VIDEO_LAYOUT;
  const tileOverscanPx = routeVideoTileOverscanPx;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(layout.canvasWidth * routeVideoRenderScale);
  canvas.height = Math.round(layout.canvasHeight * routeVideoRenderScale);
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('El navegador no ha podido crear el canvas para el video.');
  }

  const playbackSamples = buildPlaybackSamples(input.route, VIDEO_TILE_ZOOM);
  const totalFrames = Math.max(2, Math.round((routeVideoDurationMs * routeVideoFps) / 1000));
  const frameDurationMs = 1000 / routeVideoFps;
  const worldRoutePoints = input.route.points.map(([lat, lng]) => mercatorPixel(lat, lng, VIDEO_TILE_ZOOM));
  const perspectiveSurfaceScale = routeVideoPerspective.sourceResolutionScale * routeVideoRenderScale;
  const perspectiveTileOverscanPx = tileOverscanPx * routeVideoPerspective.sourceResolutionScale;
  const perspectiveSurface = document.createElement('canvas');
  perspectiveSurface.width = Math.round(
    layout.mapCard.w * routeVideoPerspective.sourceWidthMultiplier * perspectiveSurfaceScale,
  );
  perspectiveSurface.height = Math.round(
    layout.mapCard.h * routeVideoPerspective.sourceHeightMultiplier * perspectiveSurfaceScale,
  );
  const perspectiveContext = perspectiveSurface.getContext('2d');

  if (!perspectiveContext) {
    throw new Error('El navegador no ha podido crear la superficie runner-cam del video.');
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  perspectiveContext.imageSmoothingEnabled = true;
  perspectiveContext.imageSmoothingQuality = 'high';
  const groundProjector = createRouteVideoGroundProjector(layout.mapCard.w, layout.mapCard.h);

  const perspectiveFollowScale = routeVideoPerspective.followScale * perspectiveSurfaceScale;
  const perspectiveFocus = {
    x: perspectiveSurface.width * routeVideoPerspective.sourceFocusX,
    y: perspectiveSurface.height * routeVideoPerspective.sourceFocusY,
  };
  const frameProgressAt = (frameIndex: number) => clampNumber(frameIndex / Math.max(totalFrames - 1, 1), 0, 1);

  const worldSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number }; color: string }> = [];
  for (let index = 1; index < worldRoutePoints.length; index += 1) {
    worldSegments.push({
      start: worldRoutePoints[index - 1],
      end: worldRoutePoints[index],
      color: routeVideoHighlightColor,
    });
  }

  const xs = worldRoutePoints.map((point) => point.x);
  const ys = worldRoutePoints.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const routeWidth = Math.max(1, maxX - minX);
  const routeHeight = Math.max(1, maxY - minY);
  const overviewScale = Math.min(
    Math.max((layout.mapCard.w - 80) / routeWidth, 0.08),
    Math.max((layout.mapCard.h - 80) / routeHeight, 0.08),
  );

  const overviewCamera = {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    scale: overviewScale,
    heading: 0,
  };
  const overviewTiles = resolveVisibleTiles(
    computeVisibleWorldRect(overviewCamera, layout.mapCard.w, layout.mapCard.h, tileOverscanPx),
    VIDEO_TILE_ZOOM,
  );

  const buildPerspectiveCamera = (progress: number) => {
    const playbackState = interpolatePlaybackState(playbackSamples, progress);
    const runnerHeading = resolveSmoothedHeadingRadians(playbackSamples, progress);
    const rotation = -Math.PI / 2 - runnerHeading;
    const center = cameraCenterForFocus(
      playbackState.worldX,
      playbackState.worldY,
      rotation,
      0,
      0,
      perspectiveSurface.width,
      perspectiveSurface.height,
      perspectiveFocus.x,
      perspectiveFocus.y,
      perspectiveFollowScale,
    );

    return {
      centerX: center.centerX,
      centerY: center.centerY,
      scale: perspectiveFollowScale,
      heading: rotation,
    };
  };

  const keyCameras: Array<{ camera: { centerX: number; centerY: number; scale: number; heading: number }; width: number; height: number }> = [
    { camera: overviewCamera, width: layout.mapCard.w, height: layout.mapCard.h },
  ];
  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    const progress = frameProgressAt(frameIndex);
    keyCameras.push({
      camera: buildPerspectiveCamera(progress),
      width: perspectiveSurface.width,
      height: perspectiveSurface.height,
    });
  }

  const visibleTileMap = new Map<string, { z: number; x: number; y: number }>();
  keyCameras.forEach(({ camera, width, height }) => {
    const overscanPx = width === layout.mapCard.w ? tileOverscanPx : perspectiveTileOverscanPx;
    resolveVisibleTiles(computeVisibleWorldRect(camera, width, height, overscanPx), VIDEO_TILE_ZOOM).forEach((tile) => {
      visibleTileMap.set(tileBundleKey(tile), tile);
    });
  });

  const visibleTiles = Array.from(visibleTileMap.values());
  console.log('[exportRunRouteVideo] key cameras', keyCameras.length, 'visible tile bundles', visibleTiles.length);

  const preloadStart = performance.now();
  await preloadVisibleTileBundles(visibleTiles);
  console.log('[exportRunRouteVideo] preload complete', visibleTiles.length, 'tiles in', Math.round(performance.now() - preloadStart), 'ms');

  if (visibleTiles.length === 0) {
    throw new Error('No hay tiles visibles para generar el video.');
  }

  const renderVideoFrame = (progress: number) => {
    const clampedProgress = clampNumber(progress, 0, 1);
    const playbackState = interpolatePlaybackState(playbackSamples, clampedProgress);
    const recapStart = VIDEO_PHASES.recap?.start ?? 0.84;
    const recapEnd = VIDEO_PHASES.recap?.end ?? 1;
    const recapProgress =
      clampedProgress <= recapStart
        ? 0
        : clampNumber(
            (clampedProgress - recapStart) /
              Math.max(recapEnd - recapStart, 0.0001),
            0,
            1,
      );
    const recapEase = recapProgress * recapProgress * (3 - 2 * recapProgress);
    const perspectiveCamera = buildPerspectiveCamera(clampedProgress);
    const perspectiveTiles = resolveVisibleTiles(
      computeVisibleWorldRect(
        perspectiveCamera,
        perspectiveSurface.width,
        perspectiveSurface.height,
        perspectiveTileOverscanPx,
      ),
      VIDEO_TILE_ZOOM,
    );

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(routeVideoRenderScale, 0, 0, routeVideoRenderScale, 0, 0);
    drawVideoBackground(context, layout.canvasWidth, layout.canvasHeight, theme);
    drawRouteVideoMapCardShell(context, layout, theme);

    context.save();
    drawRoundedRect(context, layout.mapCard.x, layout.mapCard.y, layout.mapCard.w, layout.mapCard.h, layout.mapCard.r);
    context.clip();

    perspectiveContext.setTransform(1, 0, 0, 1, 0, 0);
    perspectiveContext.clearRect(0, 0, perspectiveSurface.width, perspectiveSurface.height);
    perspectiveContext.fillStyle = theme.mapBase;
    perspectiveContext.fillRect(0, 0, perspectiveSurface.width, perspectiveSurface.height);
    drawBaseMapForCamera(
      perspectiveContext,
      perspectiveTiles,
      perspectiveCamera,
      0,
      0,
      perspectiveSurface.width,
      perspectiveSurface.height,
    );
    drawRouteProgressFrame(
      perspectiveContext,
      perspectiveCamera,
      playbackState,
      worldRoutePoints,
      worldSegments,
      clampedProgress,
      0,
      0,
      perspectiveSurface.width,
      perspectiveSurface.height,
      {
        showActiveMarker: true,
        visualScale: routeVideoPerspective.sourceResolutionScale,
      },
    );

    drawPerspectiveGroundPlane(
      context,
      perspectiveSurface,
      layout.mapCard.x,
      layout.mapCard.y,
      layout.mapCard.w,
      layout.mapCard.h,
      theme,
      groundProjector,
    );

    if (recapProgress > 0) {
      context.save();
      context.globalAlpha = recapEase;
      drawBaseMapForCamera(
        context,
        overviewTiles,
        overviewCamera,
        layout.mapCard.x,
        layout.mapCard.y,
        layout.mapCard.w,
        layout.mapCard.h,
      );
      drawFullRouteOverview(
        context,
        overviewCamera,
        worldRoutePoints,
        worldSegments,
        layout.mapCard.x,
        layout.mapCard.y,
        layout.mapCard.w,
        layout.mapCard.h,
      );
      context.restore();
    }

    context.restore();
    drawRouteVideoMapCardChrome(context, layout, input.run, input.route.source);
    drawVideoForeground(context, layout, playbackState, input.run, input.athleteName, input.providerLabel, theme);
  };

  console.log('[exportRunRouteVideo] totalFrames', totalFrames, 'durationMs', routeVideoDurationMs, 'fps', routeVideoFps);
  const offlineResult = await encodeRouteVideoCanvasOffline({
    canvas,
    totalFrames,
    renderFrame: (frameIndex) => {
      renderVideoFrame(frameProgressAt(frameIndex));
    },
  });

  if (offlineResult) {
    downloadBlobAsset(offlineResult.blob, `run-route-video-${input.run.date}-${input.run.id}.${offlineResult.extension}`);
    console.log('[exportRunRouteVideo] finished', {
      durationMs: routeVideoDurationMs,
      totalFrames,
      mode: 'offline',
    });
    return;
  }

  renderVideoFrame(0);

  if (typeof canvas.captureStream !== 'function' || !fallbackFormat) {
    throw new Error('Tu navegador no permite grabar el canvas como video.');
  }

  let stream = canvas.captureStream(0);
  let videoTrack = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };

  if (typeof videoTrack.requestFrame !== 'function') {
    stream.getTracks().forEach((track) => track.stop());
    stream = canvas.captureStream(routeVideoFps);
    videoTrack = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  }

  const chunks: Blob[] = [];
  let recorder: MediaRecorder;

  try {
    recorder = new MediaRecorder(stream, {
      mimeType: fallbackFormat.mimeType,
      videoBitsPerSecond: 22_000_000,
    });
  } catch {
    recorder = new MediaRecorder(stream);
  }

  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onerror = () => reject(new Error('No se pudo grabar el video del entrenamiento.'));
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: recorder.mimeType || fallbackFormat.mimeType }));
    };
  });

  recorder.start();
  console.log('[exportRunRouteVideo] recorder started', recorder.state);
  videoTrack.requestFrame?.();

  try {
    await new Promise<void>((resolve, reject) => {
      const recordingStartedAt = performance.now();
      let currentFrame = 1;

      if (totalFrames <= 1) {
        window.setTimeout(resolve, routeVideoDurationMs);
        return;
      }

      const renderFrame = () => {
        try {
          const progress = frameProgressAt(currentFrame);
          renderVideoFrame(progress);
          videoTrack.requestFrame?.();

          if (currentFrame % 20 === 0) {
            console.log(`[exportRunRouteVideo] frame ${currentFrame + 1}/${totalFrames} progress=${progress.toFixed(3)}`);
          }

          currentFrame += 1;
          if (currentFrame >= totalFrames) {
            const elapsedMs = performance.now() - recordingStartedAt;
            const remainingMs = Math.max(32, routeVideoDurationMs - elapsedMs);
            window.setTimeout(resolve, remainingMs);
            return;
          }

          const elapsedMs = performance.now() - recordingStartedAt;
          const targetElapsedMs = currentFrame * frameDurationMs;
          const delayMs = Math.max(0, targetElapsedMs - elapsedMs);
          window.setTimeout(renderFrame, delayMs);
        } catch (error) {
          reject(error);
        }
      };

      window.setTimeout(renderFrame, frameDurationMs);
    });
  } finally {
    if (recorder.state !== 'inactive') {
      recorder.stop();
      console.log('[exportRunRouteVideo] recorder stopped');
    }
  }

  const blob = await finished;
  stream.getTracks().forEach((track) => track.stop());
  downloadBlobAsset(blob, `run-route-video-${input.run.date}-${input.run.id}.${fallbackFormat.extension}`);
  console.log('[exportRunRouteVideo] finished', { durationMs: routeVideoDurationMs, totalFrames });
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

function formatActivityDistance(distanceKm: number) {
  return distanceKm > 0 ? `${distanceKm.toFixed(1)} km` : 'Sin distancia';
}

function activityRouteUnavailableMessage(activity: RecentActivity) {
  return activity.distanceKm > 0
    ? 'Esta actividad no tiene un recorrido GPS utilizable.'
    : 'Esta actividad no tiene distancia ni recorrido GPS disponible.';
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
  const [publicAuthProviders, setPublicAuthProviders] = useState<LoginProvider[]>(['garmin', 'strava']);
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
  const [isExportingRunVideo, setIsExportingRunVideo] = useState(false);
  const [runVideoExportMessage, setRunVideoExportMessage] = useState<string | null>(null);
  const [runVideoExportProgress, setRunVideoExportProgress] = useState<number | null>(null);
  const [runVideoExportDisplayProgress, setRunVideoExportDisplayProgress] = useState<number | null>(null);
  const runVideoExportDisplayProgressRef = useRef<number | null>(null);
  const runVideoExportProgressAnimationRef = useRef<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeSection, setActiveSection] = useState<DashboardSectionId>(initialDashboardSection);
  const [pageTransition, setPageTransition] = useState<PageTransitionState>(null);
  const [scheduleState, setScheduleState] = useState<ScheduleState>({
    key: null,
    status: 'idle',
    message: null,
  });
  const [clockNow, setClockNow] = useState(() => Date.now());
  const refreshInFlightRef = useRef(false);
  const routeCacheRef = useRef<Map<number, ActivityRoute>>(new Map());
  const voiceRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const microphoneReadyRef = useRef(false);
  const checkInNoteRef = useRef<HTMLTextAreaElement | null>(null);
  const coachChatTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const whatIfNoteRef = useRef<HTMLTextAreaElement | null>(null);
  const previousSectionRef = useRef<DashboardSectionId>(initialDashboardSection());
  const isAuthBusy = loginState.status === 'submitting' || loginState.status === 'hydrating';
  const stravaPublicLoginEnabled = publicAuthProviders.includes('strava');
  const canExportRunVideo = supportsRouteVideoExport();
  const resolvedRecentActivities =
    state.status === 'ready'
      ? (state.data.recentActivities.length ? state.data.recentActivities : state.data.recentRuns)
      : [];
  const resolvedSelectedRun =
    resolvedRecentActivities.find((run) => run.id === selectedRunId) ??
    resolvedRecentActivities[0] ??
    null;
  const selectedRouteSignature = resolvedSelectedRun
    ? `${resolvedSelectedRun.id}:${resolvedSelectedRun.distanceKm.toFixed(3)}`
    : null;

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
    routeCacheRef.current.clear();
    setSessionId(null);
    setSessionProvider(null);
    setSessionAccountLabel(null);
    setSelectedRunId(null);
    setRouteState(idleRouteState);
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

  const bootstrapHealth = useEffectEvent(async () => {
    try {
      const response = await fetch(apiUrl('/api/health'));
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as HealthPayload;
      const nextProviders = (payload.publicAuthProviders ?? ['garmin']).filter(
        (provider): provider is LoginProvider => provider === 'garmin' || provider === 'strava',
      );

      if (!nextProviders.length) {
        return;
      }

      setPublicAuthProviders(nextProviders);
      if (!nextProviders.includes('strava')) {
        setLoginProvider((current) => (current === 'strava' ? 'garmin' : current));
      }
    } catch {
      // Keep the optimistic dual-login UI when health metadata is unavailable.
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

    void bootstrapHealth();
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
              action: state.data.coach.weeklyReview?.nextMove ?? null,
              followUp: state.data.coach.latestDebrief?.nextStep ?? null,
              tools: [],
              source: state.data.coach.source,
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

    if (!resolvedSelectedRun) {
      setRouteState((current) => (current.status === 'idle' ? current : idleRouteState));
      return;
    }

    if (resolvedSelectedRun.distanceKm <= 0) {
      setRouteState({
        status: 'error',
        data: null,
        error: activityRouteUnavailableMessage(resolvedSelectedRun),
      });
      return;
    }

    const cachedRoute = routeCacheRef.current.get(resolvedSelectedRun.id);
    if (cachedRoute) {
      setRouteState((current) =>
        current.status === 'ready' && current.data === cachedRoute
          ? current
          : {
              status: 'ready',
              data: cachedRoute,
              error: null,
            },
      );
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
        const response = await apiFetch(`/api/activities/${resolvedSelectedRun.id}/route`);
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.message ?? 'No se pudo cargar el mapa del entrenamiento.');
        }

        if (cancelled) {
          return;
        }

        routeCacheRef.current.set(resolvedSelectedRun.id, payload as ActivityRoute);
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
  }, [state.status, selectedRouteSignature]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const syncFromHash = () => {
      const hash = window.location.hash.replace(/^#/, '');
      const match = dashboardSections.find((section) => section.id === hash);
      if (match) {
        setActiveSection((current) => (current === match.id ? current : match.id));
      }
    };

    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);

    return () => {
      window.removeEventListener('hashchange', syncFromHash);
    };
  }, []);

  useEffect(() => {
    const previousSection = previousSectionRef.current;
    if (previousSection === activeSection) {
      return;
    }

    const nextDirection =
      dashboardSectionIndex(activeSection) >= dashboardSectionIndex(previousSection) ? 'forward' : 'backward';

    setPageTransition({
      from: previousSection,
      direction: nextDirection,
    });
    previousSectionRef.current = activeSection;

    if (typeof window === 'undefined') {
      setPageTransition(null);
      return;
    }

    const transitionTimer = window.setTimeout(() => {
      setPageTransition(null);
    }, 360);

    return () => {
      window.clearTimeout(transitionTimer);
    };
  }, [activeSection]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      runVideoExportDisplayProgressRef.current = runVideoExportProgress;
      setRunVideoExportDisplayProgress(runVideoExportProgress);
      return;
    }

    if (runVideoExportProgressAnimationRef.current !== null) {
      window.cancelAnimationFrame(runVideoExportProgressAnimationRef.current);
      runVideoExportProgressAnimationRef.current = null;
    }

    if (runVideoExportProgress === null) {
      runVideoExportDisplayProgressRef.current = null;
      setRunVideoExportDisplayProgress(null);
      return;
    }

    const target = clampNumber(runVideoExportProgress, 0, 1);
    const startValue = runVideoExportDisplayProgressRef.current ?? target;
    if (Math.abs(target - startValue) < 0.0005) {
      runVideoExportDisplayProgressRef.current = target;
      setRunVideoExportDisplayProgress(target);
      return;
    }

    const startedAt = window.performance.now();
    const durationMs = clampNumber(Math.abs(target - startValue) * 900, 180, 460);

    const animateProgress = (now: number) => {
      const elapsed = now - startedAt;
      const ratio = clampNumber(elapsed / durationMs, 0, 1);
      const easedRatio = 1 - (1 - ratio) ** 3;
      const nextValue = lerpNumber(startValue, target, easedRatio);
      runVideoExportDisplayProgressRef.current = nextValue;
      startTransition(() => {
        setRunVideoExportDisplayProgress(nextValue);
      });

      if (ratio < 1) {
        runVideoExportProgressAnimationRef.current = window.requestAnimationFrame(animateProgress);
        return;
      }

      runVideoExportDisplayProgressRef.current = target;
      startTransition(() => {
        setRunVideoExportDisplayProgress(target);
      });
      runVideoExportProgressAnimationRef.current = null;
    };

    runVideoExportProgressAnimationRef.current = window.requestAnimationFrame(animateProgress);

    return () => {
      if (runVideoExportProgressAnimationRef.current !== null) {
        window.cancelAnimationFrame(runVideoExportProgressAnimationRef.current);
        runVideoExportProgressAnimationRef.current = null;
      }
    };
  }, [runVideoExportProgress]);

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
    if (!stravaPublicLoginEnabled) {
      return;
    }

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

  const focusVoiceTarget = (target: VoiceTarget) => {
    const field =
      target === 'coach'
        ? coachChatTextareaRef.current
        : target === 'checkin'
          ? checkInNoteRef.current
          : whatIfNoteRef.current;

    field?.focus();
    if (field) {
      const length = field.value.length;
      field.setSelectionRange(length, length);
    }
  };

  const getVoiceHint = (target: VoiceTarget) =>
    voiceState.target === target || (voiceState.target === null && voiceState.status === 'unsupported')
      ? voiceState.message
      : null;

  const ensureMicrophoneReady = async () => {
    if (microphoneReadyRef.current || typeof navigator === 'undefined') {
      return true;
    }

    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      microphoneReadyRef.current = true;
      return true;
    } catch {
      return false;
    }
  };

  const toggleVoiceCapture = async (target: VoiceTarget) => {
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
      focusVoiceTarget(target);
      setVoiceState({
        status: 'unsupported',
        target,
        message: 'Abro el campo para que uses el dictado del teclado.',
      });
      return;
    }

    setVoiceState({
      status: 'requesting',
      target,
      message: 'Activando micrófono…',
    });

    const hasMic = await ensureMicrophoneReady();
    if (!hasMic && isLikelyMobileDevice()) {
      focusVoiceTarget(target);
      setVoiceState({
        status: 'unsupported',
        target,
        message: 'En móvil, si falla el micro web, usa el dictado del teclado.',
      });
      return;
    }

    const recognition = new SpeechRecognition();
    voiceRecognitionRef.current = recognition;
    recognition.continuous = isLikelyMobileDevice();
    recognition.interimResults = false;
    recognition.lang = 'es-ES';
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? '')
        .join(' ')
        .trim();
      applyVoiceTranscript(target, transcript);
    };
    recognition.onerror = (event) => {
      const errorCode = event.error ?? '';
      focusVoiceTarget(target);
      setVoiceState({
        status: 'unsupported',
        target,
        message:
          errorCode === 'not-allowed'
            ? 'El navegador no tiene permiso de micrófono.'
            : 'No he podido capturar el audio. Usa el dictado del teclado.',
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
      message: 'Escuchando… toca otra vez para parar.',
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

  const askCoach = async (questionInput: string) => {
    const question = questionInput.trim();
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
          action: (payload.action as string | null | undefined) ?? null,
          followUp: (payload.followUp as string | null | undefined) ?? null,
          memory: Array.isArray(payload.memory)
            ? (payload.memory as Array<{ title: string; detail: string }>)
            : [],
          tools: Array.isArray(payload.tools)
            ? (payload.tools as Array<{ name: string; label: string; detail: string }>)
            : [],
          source: ((payload.source as 'gemma4' | 'fallback' | undefined) ?? 'fallback'),
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

  const submitCoachChat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await askCoach(coachChatDraft);
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

  const saveGoal = async (goal: UserGoal) => {
    if (!sessionIdRef.current) {
      return;
    }

    setIsSavingGoal(true);

    try {
      const response = await apiFetch('/api/session/goal', {
        method: 'PUT',
        body: JSON.stringify(normalizeGoalInput(goal)),
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

  const submitGoal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await saveGoal(goalDraft);
  };

  const applyWhatIfScenario = async () => {
    if (!whatIfState.scenario) {
      return;
    }

    await saveGoal(whatIfState.scenario.recommendedGoal);
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
                <small>{stravaPublicLoginEnabled ? 'Garmin + Strava' : 'Garmin'}</small>
              </div>
            </div>
            <p className="eyebrow">Race Room</p>
            <h1>{stravaPublicLoginEnabled ? 'Entra en Race Room con Garmin o Strava' : 'Entra en Race Room con Garmin'}</h1>
            <p className="lead">
              {stravaPublicLoginEnabled
                ? 'Elige el proveedor con el que quieres cargar tus datos. Garmin entra por credenciales efímeras; Strava entra por OAuth. En ambos casos persisto solo el objetivo y el último dashboard/plan generado.'
                : 'Este despliegue público expone solo Garmin. El login usa credenciales efímeras y la app persiste únicamente tu objetivo y el último dashboard/plan generado.'}
            </p>
            <div className="hero-meta">
              <span>{stravaPublicLoginEnabled ? 'Login dual Garmin + Strava' : 'Login Garmin protegido'}</span>
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
              {stravaPublicLoginEnabled ? (
                <button
                  className={`provider-pill ${loginProvider === 'strava' ? 'selected' : ''}`}
                  disabled={isAuthBusy}
                  onClick={() => setLoginProvider('strava')}
                  type="button"
                >
                  Strava
                </button>
              ) : null}
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
            ) : stravaPublicLoginEnabled ? (
              <button
                className="action-button"
                disabled={isAuthBusy}
                onClick={beginStravaLogin}
                type="button"
              >
                {loginState.status === 'submitting' ? 'Redirigiendo a Strava...' : 'Entrar con Strava'}
              </button>
            ) : null}

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
  const recentActivities = resolvedRecentActivities;
  const selectedMetricMeta = chartOptions.find((option) => option.key === selectedMetric) ?? chartOptions[0];
  const selectedWeek = data.plan.weeks[selectedWeekIndex] ?? data.plan.weeks[0];
  const selectedRun = resolvedSelectedRun;
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
  const weeklyReview = data.coach.weeklyReview;
  const latestDebrief = data.coach.latestDebrief;
  const activeSectionMeta = dashboardSections.find((section) => section.id === activeSection) ?? dashboardSections[0];
  const coachQuickPrompts = [
    {
      label: 'Fitness actual',
      question: '¿Cómo interpretarías mis datos actuales de fitness y recuperación?',
    },
    {
      label: 'Debrief del último entreno',
      question: latestDebrief
        ? `Hazme un debrief útil de ${latestDebrief.runName} y dime qué harías mañana.`
        : 'Hazme un debrief útil del último entreno y dime qué harías mañana.',
    },
    {
      label: 'Qué hago mañana',
      question: '¿Qué entrenamiento me recomiendas mañana con mis señales actuales?',
    },
    {
      label: 'Últimos entrenos',
      question: latestDebrief
        ? `¿Qué me dice ${latestDebrief.runName} sobre esta semana?`
        : '¿Qué te dicen mis últimos entrenos de esta semana?',
    },
    {
      label: 'Patrón pasado',
      question: 'Busca en mi histórico algo parecido a cómo estoy ahora y compáralo.',
    },
    {
      label: 'Me duele el gemelo',
      question: 'Me duele el gemelo después de entrenar. ¿Qué me preguntarías y qué harías hoy?',
    },
  ];
  const nextSyncAt = new Date(data.fetchedAt).getTime() + serverRefreshMs;
  const nextSyncIn = nextSyncAt - clockNow;
  const syncTone = data.fallbackReason ? 'warning' : isRefreshing ? 'syncing' : 'live';
  const syncLabel = data.fallbackReason ? 'Modo provisional' : isRefreshing ? 'Sincronizando' : 'Live';
  const athleteAvatarUrl = data.athlete.avatarPath ? absoluteApiUrl(data.athlete.avatarPath) : null;
  const jumpToSection = (sectionId: DashboardSectionId) => {
    if (sectionId === activeSection) {
      return;
    }

    startTransition(() => {
      setActiveSection(sectionId);
    });
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${sectionId}`);
      window.scrollTo({
        top: 0,
        behavior: 'smooth',
      });
    }
  };
  const shouldRenderSection = (sectionId: DashboardSectionId) =>
    sectionId === activeSection || pageTransition?.from === sectionId;
  const pageClassName = (sectionId: DashboardSectionId) => {
    if (!shouldRenderSection(sectionId)) {
      return 'dashboard-page hidden';
    }

    if (pageTransition?.from === sectionId) {
      return `dashboard-page transition-outgoing ${pageTransition.direction}`;
    }

    if (pageTransition) {
      return `dashboard-page active transition-incoming ${pageTransition.direction}`;
    }

    return 'dashboard-page active';
  };
  const exportSelectedRunImage = async () => {
    if (!selectedRun || isExportingRunImage) {
      return;
    }

    if (routeState.status === 'loading') {
      window.alert('Todavia estoy cargando la ruta de esta actividad. Espera un momento y vuelve a intentarlo.');
      return;
    }

    if (routeState.status !== 'ready') {
      window.alert('Esta actividad no tiene una ruta utilizable para la exportacion.');
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
      window.alert(error instanceof Error ? error.message : 'No se pudo generar la imagen de la actividad.');
    } finally {
      setIsExportingRunImage(false);
    }
  };
  const exportSelectedRunVideo = async () => {
    if (!selectedRun || isExportingRunVideo) {
      return;
    }

    if (!canExportRunVideo) {
      window.alert('Este navegador no soporta la exportacion de video. Prueba desde un navegador de escritorio compatible.');
      return;
    }

    if (selectedRun.distanceKm <= 0) {
      window.alert('Esta actividad no tiene una ruta utilizable para la exportacion.');
      return;
    }

    setIsExportingRunVideo(true);
    setRunVideoExportMessage('Preparando export 3D...');
    setRunVideoExportProgress(0.02);

    try {
      const summary: RouteVideoRenderSummary = {
        title: selectedRun.name,
        date: selectedRun.date,
        timeLabel: selectedRun.timeLabel,
        activityLabel: selectedRun.activityLabel,
        providerLabel: data.provider.label,
        athleteName: data.athlete.name,
        distanceKm: selectedRun.distanceKm,
        durationSeconds: selectedRun.durationSeconds,
        paceSecondsPerKm: selectedRun.paceSecondsPerKm,
        elevationGain: selectedRun.elevationGain,
      };

      const createResponse = await apiFetch(`/api/activities/${selectedRun.id}/video-export`, {
        method: 'POST',
        body: JSON.stringify({
          summary,
        }),
      });
      const createPayload = await createResponse.json();

      if (!createResponse.ok) {
        throw new Error(createPayload.message ?? 'No se pudo crear el export del vídeo.');
      }

      let job = createPayload as RouteVideoExportJob;
      setRunVideoExportMessage(job.message);
      setRunVideoExportProgress(job.progress);

      while (job.status === 'queued' || job.status === 'rendering') {
        await new Promise((resolve) =>
          window.setTimeout(resolve, job.status === 'queued' ? 900 : 350),
        );
        const statusResponse = await apiFetch(`/api/video-exports/${job.id}`);
        const statusPayload = await statusResponse.json();

        if (!statusResponse.ok) {
          throw new Error(statusPayload.message ?? 'No se pudo consultar el estado del vídeo.');
        }

        job = statusPayload as RouteVideoExportJob;
        setRunVideoExportMessage(job.message);
        setRunVideoExportProgress(job.progress);
      }

      if (job.status === 'error') {
        throw new Error(job.error ?? 'El render del vídeo ha fallado.');
      }

      if (!job.downloadUrl) {
        throw new Error('El servidor ha terminado el render pero no ha devuelto la descarga.');
      }

      setRunVideoExportMessage('Descargando MP4...');
      setRunVideoExportProgress(1);
      const downloadResponse = await apiFetch(job.downloadUrl);
      if (!downloadResponse.ok) {
        const errorPayload = await downloadResponse.json().catch(() => ({ message: null }));
        throw new Error(errorPayload.message ?? 'No se pudo descargar el MP4 generado.');
      }

      const blob = await downloadResponse.blob();
      downloadBlobAsset(
        blob,
        job.outputFilename ?? `run-route-video-${selectedRun.date}-${selectedRun.id}.mp4`,
      );

      if (routeVideoLegacyFallbackEnabled && routeState.status === 'ready') {
        await exportRunRouteVideo({
          run: selectedRun,
          route: routeState.data,
          athleteName: data.athlete.name,
          providerLabel: data.provider.label,
        });
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'No se pudo generar el video de la actividad.');
    } finally {
      setIsExportingRunVideo(false);
      setRunVideoExportMessage(null);
      setRunVideoExportProgress(null);
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
      <div className="dashboard-sidebar">
        <div className="dashboard-sidebar-inner">
          <div className="brand-lockup sidebar-brand">
            <span className="brand-badge" aria-hidden="true">RR</span>
            <div className="brand-copy">
              <strong>Race Room</strong>
              <small>{data.provider.label}</small>
            </div>
          </div>
          <nav className="sidebar-nav" aria-label="Secciones del dashboard">
            {dashboardSections.map((section) => (
              <button
                aria-current={activeSection === section.id ? 'page' : undefined}
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
          <div className="dashboard-sidebar-context" aria-live="polite">
            <span>{activeSectionMeta.label}</span>
            <small>{activeSectionMeta.note}</small>
          </div>
        </div>
      </div>

      <div className="dashboard-content">
      <div className="dashboard-page-stack">
      <div className={pageClassName('summary')}>
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
            Cruza recuperación, volumen, sesiones y plan en una sola vista para preparar {data.goal.label} del {data.goal.raceDate}.
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
      </div>

      <div className={pageClassName('sessions')}>
      <section className="dashboard-section" id="section-sessions">
        <article className="panel recent-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Sesiones recientes</p>
              <h2>Detalle de actividad</h2>
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
                <div className="spotlight-heading">
                  <p className="eyebrow">Actividad elegida</p>
                  <span className="session-type-chip large">{selectedRun.activityLabel}</span>
                </div>
                <h3>{selectedRun.name}</h3>
                <p className="run-spotlight-meta">
                  {selectedRun.date}
                  {selectedRun.timeLabel ? ` · ${selectedRun.timeLabel}` : ''}
                  {selectedRun.activityLabel ? ` · ${selectedRun.activityLabel}` : ''}
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
                    <ActivityRouteMap route={routeState.data} title={selectedRun.name} isActive={activeSection === 'sessions'} />
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
                    <strong>{formatActivityDistance(selectedRun.distanceKm)}</strong>
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
                    : `Sin Training Effect disponible. Usa esta ${selectedRun.activityLabel.toLowerCase()} como referencia de sensaciones, ritmo y carga interna.`}
                </p>
                <div className="overlay-export-panel">
                  <div className="overlay-export-copy">
                    <span className="metric-label">Exportes visuales</span>
                    <p>
                      Genera la tarjeta PNG glass o un vídeo vertical con la ruta trazándose sobre mapa en relieve, con km y ritmo en marcha.
                    </p>
                  </div>
                  <div className="overlay-single-card" aria-label="Overlay activo">
                    <span className="overlay-template-tag">GLASS + ROUTE VIDEO</span>
                    <strong>{runOverlayTemplate.headline} + short vertical</strong>
                    <small>PNG con look social más editorial y vídeo tipo reel con trazado progresivo, distancia y pace.</small>
                    <div className="overlay-single-card-meta" aria-hidden="true">
                      <span>avatar</span>
                      <span>mapa premium</span>
                      <span>stats</span>
                    </div>
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
                    <button
                      className="secondary-button"
                      disabled={!canExportRunVideo || isExportingRunVideo || selectedRun.distanceKm <= 0}
                      onClick={() => void exportSelectedRunVideo()}
                      type="button"
                    >
                      {!canExportRunVideo
                        ? 'Vídeo no disponible aquí'
                        : isExportingRunVideo
                          ? runVideoExportMessage ?? 'Generando vídeo...'
                          : selectedRun.distanceKm <= 0
                            ? 'Ruta no exportable'
                            : 'Descargar vídeo ruta'}
                    </button>
                  </div>
                  {isExportingRunVideo && runVideoExportDisplayProgress !== null ? (
                    <div
                      className="overlay-export-progress"
                      aria-label="Progreso del export del vídeo"
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={Math.round(runVideoExportDisplayProgress * 100)}
                      role="progressbar"
                    >
                      <div className="overlay-export-progress-head">
                        <span>{runVideoExportMessage ?? 'Generando vídeo...'}</span>
                        <strong>{formatOverlayExportPercent(runVideoExportDisplayProgress)}</strong>
                      </div>
                      <div className="overlay-export-progress-track">
                        <span
                          className="overlay-export-progress-fill"
                          style={{ width: `${(runVideoExportDisplayProgress * 100).toFixed(3)}%` }}
                        />
                      </div>
                    </div>
                  ) : null}
                  <small className="overlay-export-note">
                    {runVideoExportMessage ?? 'El vídeo se renderiza en servidor como MP4 vertical 1080x1920 con cámara 3D y duración variable.'}
                  </small>
                </div>
              </aside>

              <div className="run-list-panel">
                <p className="eyebrow">Más actividades</p>
                <div className="run-list">
                  {recentActivities.map((run) => (
                    <button
                      className={`run-row run-select ${selectedRun.id === run.id ? 'selected' : ''}`}
                      key={run.id}
                      onClick={() => setSelectedRunId(run.id)}
                      type="button"
                    >
                      <div className="run-row-main">
                        <span className="session-type-chip">{run.activityLabel}</span>
                        <strong>{run.name}</strong>
                        <span>
                          {run.date}
                          {run.timeLabel ? ` · ${run.timeLabel}` : ''}
                        </span>
                      </div>
                      <div className="run-row-metrics">
                        <strong>{formatActivityDistance(run.distanceKm)}</strong>
                        <span>{formatDuration(run.durationSeconds)}</span>
                      </div>
                      <div className="run-row-metrics">
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
              entrar a cada sesión.
            </p>
          )}
        </article>
      </section>
      </div>

      <div className={pageClassName('plan')}>
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
          Primero cargo la última versión persistida y después recalculo sobre el proveedor activo.
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
      </div>

      <div className={pageClassName('coach')}>
      <section className="dashboard-section" id="section-coach">
        <article className="panel coach-chat-panel coach-primary-chat">
          <div className="panel-head coach-chat-hero-head">
            <div>
              <p className="eyebrow">Coach</p>
              <h2>Pregunta a Gemma por tu estado y tus molestias</h2>
              <p className="coach-page-lead">
                Puedes preguntarle por fitness actual, rodajes pasados, qué hacer mañana o cómo actuar si aparece
                dolor tras entrenar. Escribe o dicta y Gemma cruza el contexto del dashboard con tus sesiones reales.
              </p>
            </div>
          </div>

          <div className="coach-chat-messages">
            {coachChatMessages.length ? (
              coachChatMessages.slice(-6).map((message) => (
                <article className={`coach-chat-bubble ${message.role}`} key={message.id}>
                  <div className="coach-chat-bubble-head">
                    <span className="metric-label">{message.role === 'user' ? 'Tú' : 'Race Room Coach'}</span>
                  </div>
                  <p>{message.text}</p>
                  {message.action ? (
                    <div className="coach-chat-action">
                      <span className="metric-label">Haz ahora</span>
                      <strong>{message.action}</strong>
                    </div>
                  ) : null}
                  {message.followUp ? <small className="coach-chat-followup">{message.followUp}</small> : null}
                  {message.memory?.length ? (
                    <div className="coach-tool-trace coach-memory-trace">
                      {message.memory.map((memory, memoryIndex) => (
                        <span className="coach-tool-pill coach-memory-pill" key={`${message.id}-memory-${memoryIndex}`}>
                          <strong>{memory.title}</strong>
                          <small>{memory.detail}</small>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {message.tools?.length ? (
                    <div className="coach-tool-trace">
                      {message.tools.map((tool) => (
                        <span className="coach-tool-pill" key={`${message.id}-${tool.name}`}>
                          <strong>{tool.label}</strong>
                          <small>{tool.detail}</small>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))
            ) : (
              <p className="coach-chat-empty">
                Prueba con algo como: “¿Qué hago mañana?”, “¿Qué dicen mis últimos entrenos?” o “Me duele el gemelo tras correr”.
              </p>
            )}
            {coachChatState.status === 'sending' ? (
              <article className="coach-chat-bubble assistant thinking" aria-live="polite">
                <div className="coach-chat-bubble-head">
                  <span className="metric-label">Race Room Coach</span>
                </div>
                <div className="coach-thinking-row">
                  <div className="coach-thinking-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <p>Gemma está cruzando fitness, entrenos y plan…</p>
                </div>
              </article>
            ) : null}
          </div>

          <div className="coach-chat-quick-prompts">
            {coachQuickPrompts.map((prompt) => (
              <button
                className="coach-prompt-chip"
                disabled={coachChatState.status === 'sending'}
                key={prompt.label}
                onClick={() => void askCoach(prompt.question)}
                type="button"
              >
                {prompt.label}
              </button>
            ))}
          </div>

          <form className="coach-chat-form" onSubmit={submitCoachChat}>
            <textarea
              ref={coachChatTextareaRef}
              disabled={coachChatState.status === 'sending'}
              maxLength={600}
              onChange={(event) => setCoachChatDraft(event.target.value)}
              placeholder={
                data.coach.enabled
                  ? 'Ejemplo: Me duele el gemelo desde ayer. ¿Qué me preguntarías y qué harías hoy?'
                  : 'Gemma no está activa. Puedes preguntar igual y Race Room responderá con el contexto base.'
              }
              rows={3}
              value={coachChatDraft}
            />
            <div className="coach-chat-actions">
              <small>Consejo breve, accionable y apoyado en tus datos actuales.</small>
              <div className="coach-chat-buttons">
                <button className="inline-voice-button" onClick={() => void toggleVoiceCapture('coach')} type="button">
                  {voiceState.status === 'recording' && voiceState.target === 'coach'
                    ? 'Parar dictado'
                    : voiceState.status === 'requesting' && voiceState.target === 'coach'
                      ? 'Activando...'
                      : 'Hablar'}
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
            {getVoiceHint('coach') ? <small className="voice-support-note">{getVoiceHint('coach')}</small> : null}
            {coachChatState.message ? <p className="checkin-feedback error">{coachChatState.message}</p> : null}
          </form>
        </article>

        <article className="panel coach-overview-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Ajuste del día</p>
              <h2>Qué haría hoy con tus señales</h2>
            </div>
          </div>
          <p className="coach-page-lead">
            {data.coach.todayMessage ??
              'Completa el check-in para cruzar mejor las sensaciones con la carga y afinar el plan.'}
          </p>
          <div className="plan-coach-meta">
            <span>
              Último ajuste
              <strong>{formatCoachRelativeTime(data.coach.generatedAt)}</strong>
            </span>
            <span>
              Estado subjetivo
              <strong>
                {latestCheckIn
                  ? `${formatCheckInValue('energy', latestCheckIn.energy)} · ${formatCheckInValue('legs', latestCheckIn.legs)}`
                  : 'Pendiente'}
              </strong>
            </span>
            <span>
              Próximo refresh
              <strong>{formatPollingLabel(serverRefreshMs)}</strong>
            </span>
          </div>
        </article>

        <section className="coach-page-grid">
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
                    ref={checkInNoteRef}
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
                      onClick={() => void toggleVoiceCapture('checkin')}
                      type="button"
                    >
                      {voiceState.status === 'recording' && voiceState.target === 'checkin'
                        ? 'Parar dictado'
                        : voiceState.status === 'requesting' && voiceState.target === 'checkin'
                          ? 'Activando...'
                          : 'Dictar nota'}
                    </button>
                  </div>
                  {getVoiceHint('checkin') ? <small>{getVoiceHint('checkin')}</small> : null}
                </label>

                <div className="checkin-footer">
                  <p className="checkin-help">
                    Son 3 señales rápidas al día para afinar el plan y el tono del coach sin recalcular todo el dashboard.
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

          <div className="coach-insight-grid coach-page-insights">
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
              </div>
              <p className="coach-insight-copy">
                {latestDebrief?.summary ?? 'Cuando entra un rodaje nuevo, Gemma resume qué ha dicho realmente ese entreno.'}
              </p>
              <div className="coach-insight-foot">
                <span className="metric-label">Haz ahora</span>
                <strong>{latestDebrief?.nextStep ?? 'Sin ajuste todavía.'}</strong>
              </div>
            </article>
          </div>
        </section>

        <article className="panel coach-chat-panel coach-whatif-panel">
          <div className="coach-chat-head">
            <div>
              <p className="eyebrow">What-if planner</p>
              <h3>Simula otro objetivo o una semana limitada</h3>
            </div>
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
                ref={whatIfNoteRef}
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
                <button className="inline-voice-button" onClick={() => void toggleVoiceCapture('whatif')} type="button">
                  {voiceState.status === 'recording' && voiceState.target === 'whatif'
                    ? 'Parar dictado'
                    : voiceState.status === 'requesting' && voiceState.target === 'whatif'
                      ? 'Activando...'
                      : 'Dictar contexto'}
                </button>
              </div>
              {getVoiceHint('whatif') ? <small className="voice-support-note">{getVoiceHint('whatif')}</small> : null}
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
              <div className="coach-chat-action">
                <span className="metric-label">Postura recomendada</span>
                <strong>{whatIfState.scenario.stance}</strong>
              </div>
              <div className="whatif-adjustments">
                {whatIfState.scenario.adjustments.map((item) => (
                  <article className="stat-pill" key={item}>
                    <strong>{item}</strong>
                  </article>
                ))}
              </div>
              <div className="whatif-adjustments">
                {whatIfState.scenario.sampleWeek.map((item) => (
                  <article className="stat-pill" key={`sample-${item}`}>
                    <span className="metric-label">Semana tipo</span>
                    <strong>{item}</strong>
                  </article>
                ))}
              </div>
              <div className="whatif-actions">
                <button className="action-button" disabled={isSavingGoal} onClick={() => void applyWhatIfScenario()} type="button">
                  {isSavingGoal ? 'Aplicando...' : 'Usar este escenario'}
                </button>
              </div>
            </div>
          ) : null}
        </article>
      </section>
      </div>

      <div className={pageClassName('fitness')}>
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
      </div>

      </div>

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
