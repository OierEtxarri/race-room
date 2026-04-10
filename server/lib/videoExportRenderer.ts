import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { chromium } from 'playwright';
import {
  HILLSHADE_TILE_URL,
  LABELS_TILE_URL,
  SATELLITE_TILE_URL,
} from '../../src/mapStyle.ts';
import {
  calculateRouteBearingDegrees,
  clampNumber,
  createRouteVideoTimeline,
  distanceBetweenGeoPointsMeters,
  estimateRouteVideoRenderMetrics,
  findRoutePointIndexByDistance,
  lerpNumber,
  routeProgressAtElapsedSeconds,
} from './videoExportMath.ts';
import {
  DEFAULT_ROUTE_VIDEO_EXPORT_PRESET,
  resolveRouteVideoExportPresetConfig,
  type RouteVideoExportPresetConfig,
} from './videoExportPresets.ts';
import type {
  RouteVideoExportPreset,
  RouteVideoPayload,
  RouteVideoRenderResult,
  RouteVideoRenderSummary,
} from './videoExportTypes.ts';

const ROUTE_VIDEO_BOOT_TIMEOUT_MS = 45_000;
const CHROMIUM_RENDER_ARGS = [
  '--use-angle=swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];
const FOLLOW_CAMERA_PITCH = 68;
const FOLLOW_CAMERA_ZOOM = 16.2;
const FOLLOW_CAMERA_BEHIND_METERS = 24;
const FOLLOW_CAMERA_AHEAD_METERS = 52;
const FOLLOW_CAMERA_FOCUS_AHEAD_METERS = 10;
const VIDEO_BASE_MAP_STYLE = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: [SATELLITE_TILE_URL],
      tileSize: 256,
      maxzoom: 19,
    },
    hillshade: {
      type: 'raster',
      tiles: [HILLSHADE_TILE_URL],
      tileSize: 256,
      maxzoom: 19,
    },
    labels: {
      type: 'raster',
      tiles: [LABELS_TILE_URL],
      tileSize: 256,
      maxzoom: 19,
    },
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': '#04070c',
      },
    },
    {
      id: 'satellite',
      type: 'raster',
      source: 'satellite',
      paint: {
        'raster-opacity': 1,
        'raster-saturation': -0.28,
        'raster-contrast': 0.18,
        'raster-brightness-min': 0.06,
        'raster-brightness-max': 0.8,
        'raster-hue-rotate': -4,
      },
    },
    {
      id: 'hillshade',
      type: 'raster',
      source: 'hillshade',
      paint: {
        'raster-opacity': 0.42,
        'raster-saturation': -0.2,
        'raster-contrast': 0.28,
        'raster-brightness-min': 0.04,
        'raster-brightness-max': 0.72,
      },
    },
    {
      id: 'labels',
      type: 'raster',
      source: 'labels',
      paint: {
        'raster-opacity': 0.2,
        'raster-saturation': -0.16,
        'raster-contrast': 0.1,
        'raster-brightness-min': 0.2,
        'raster-brightness-max': 0.92,
      },
    },
  ],
} as const;

type RouteVideoRenderLayout = {
  renderScaleX: number;
  renderScaleY: number;
  followPadding: { top: number; bottom: number; left: number; right: number };
  overviewPadding: { top: number; bottom: number; left: number; right: number };
  finishPadding: { top: number; bottom: number; left: number; right: number };
  scaleRenderPx: (value: number) => number;
};

function scalePadding(
  padding: { top: number; bottom: number; left: number; right: number },
  layout: Pick<RouteVideoRenderLayout, 'renderScaleX' | 'renderScaleY'>,
) {
  return {
    top: Math.round(padding.top * layout.renderScaleY),
    bottom: Math.round(padding.bottom * layout.renderScaleY),
    left: Math.round(padding.left * layout.renderScaleX),
    right: Math.round(padding.right * layout.renderScaleX),
  };
}

function createRouteVideoRenderLayout(preset: RouteVideoExportPresetConfig): RouteVideoRenderLayout {
  const renderScaleX = preset.renderWidth / preset.outputWidth;
  const renderScaleY = preset.renderHeight / preset.outputHeight;
  const scaleRenderPx = (value: number) => Math.round(value * renderScaleX);

  return {
    renderScaleX,
    renderScaleY,
    followPadding: scalePadding(
      {
        top: 980,
        bottom: 240,
        left: 120,
        right: 120,
      },
      { renderScaleX, renderScaleY },
    ),
    overviewPadding: scalePadding(
      {
        top: 190,
        bottom: 270,
        left: 120,
        right: 120,
      },
      { renderScaleX, renderScaleY },
    ),
    finishPadding: scalePadding(
      {
        top: 220,
        bottom: 320,
        left: 140,
        right: 140,
      },
      { renderScaleX, renderScaleY },
    ),
    scaleRenderPx,
  };
}

type RenderFrameState = {
  phase: 'overview' | 'descent' | 'follow' | 'finish';
  phaseProgress: number;
  routeProgress: number;
  centerLat: number;
  centerLng: number;
  bearing: number;
  pitch: number;
  zoom: number;
  terrainExaggeration: number;
  padding: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  currentDistanceKm: number;
  currentElapsedSeconds: number;
  currentPaceSecondsPerKm: number | null;
};

function shortestAngleDelta(from: number, to: number) {
  let delta = ((to - from + 540) % 360) - 180;
  if (delta < -180) {
    delta += 360;
  }
  return delta;
}

function clampAngleStep(previous: number, next: number, maxDelta = 5.5) {
  const delta = shortestAngleDelta(previous, next);
  return (previous + clampNumber(delta, -maxDelta, maxDelta) + 360) % 360;
}

function interpolateRoutePoint(payload: RouteVideoPayload, routeProgress: number) {
  const clampedProgress = clampNumber(routeProgress, 0, 1);
  const totalDistanceMeters = payload.points.at(-1)?.distanceMeters ?? 0;
  const targetDistanceMeters = totalDistanceMeters * clampedProgress;
  const rightIndex = findRoutePointIndexByDistance(payload.points, targetDistanceMeters);
  const endPoint = payload.points[Math.min(rightIndex, payload.points.length - 1)]!;
  const startPoint = payload.points[Math.max(0, rightIndex - 1)] ?? endPoint;
  const span = Math.max(endPoint.distanceMeters - startPoint.distanceMeters, 0.0001);
  const ratio = clampNumber((targetDistanceMeters - startPoint.distanceMeters) / span, 0, 1);

  return {
    lat: lerpNumber(startPoint.lat, endPoint.lat, ratio),
    lng: lerpNumber(startPoint.lng, endPoint.lng, ratio),
    elevationMeters: lerpNumber(startPoint.elevationMeters, endPoint.elevationMeters, ratio),
    timestampSeconds: lerpNumber(startPoint.timestampSeconds, endPoint.timestampSeconds, ratio),
    distanceMeters: lerpNumber(startPoint.distanceMeters, endPoint.distanceMeters, ratio),
    paceSecondsPerKm: endPoint.paceSecondsPerKm ?? startPoint.paceSecondsPerKm,
  };
}

function findOffsetPoint(payload: RouteVideoPayload, distanceMeters: number) {
  const index = findRoutePointIndexByDistance(payload.points, distanceMeters);
  return payload.points[Math.min(index, payload.points.length - 1)] ?? payload.points.at(-1)!;
}

function terrainExaggerationForPayload(payload: RouteVideoPayload) {
  if (!payload.points.length) {
    return 1.2;
  }

  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;
  for (const point of payload.points) {
    minElevation = Math.min(minElevation, point.elevationMeters);
    maxElevation = Math.max(maxElevation, point.elevationMeters);
  }

  const reliefMeters = Math.max(maxElevation - minElevation, 0);
  return clampNumber(220 / Math.max(reliefMeters, 120), 1.15, 1.75);
}

function rawFollowCameraForProgress(
  payload: RouteVideoPayload,
  routeProgress: number,
  terrainExaggeration: number,
) {
  const currentPoint = interpolateRoutePoint(payload, routeProgress);
  const behindPoint = findOffsetPoint(
    payload,
    Math.max(0, currentPoint.distanceMeters - FOLLOW_CAMERA_BEHIND_METERS),
  );
  const aheadPoint = findOffsetPoint(
    payload,
    Math.min(
      payload.points.at(-1)?.distanceMeters ?? 0,
      currentPoint.distanceMeters + FOLLOW_CAMERA_AHEAD_METERS,
    ),
  );
  const focusPoint = findOffsetPoint(
    payload,
    Math.min(
      payload.points.at(-1)?.distanceMeters ?? 0,
      currentPoint.distanceMeters + FOLLOW_CAMERA_FOCUS_AHEAD_METERS,
    ),
  );
  const bearing = calculateRouteBearingDegrees(
    { lat: behindPoint.lat, lng: behindPoint.lng },
    { lat: aheadPoint.lat, lng: aheadPoint.lng },
  );

  return {
    centerLat: focusPoint.lat,
    centerLng: focusPoint.lng,
    bearing,
    pitch: FOLLOW_CAMERA_PITCH,
    zoom: FOLLOW_CAMERA_ZOOM,
    terrainExaggeration,
    currentDistanceKm: currentPoint.distanceMeters / 1000,
    currentElapsedSeconds: currentPoint.timestampSeconds,
    currentPaceSecondsPerKm: currentPoint.paceSecondsPerKm,
  };
}

function buildFollowFrames(
  payload: RouteVideoPayload,
  renderFps: number,
  layout: RouteVideoRenderLayout,
) {
  const timeline = createRouteVideoTimeline(payload.totalDistanceKm);
  const followFrameCount = Math.max(1, Math.round(timeline.followSeconds * renderFps));
  const followFrames: RenderFrameState[] = [];
  const terrainExaggeration = terrainExaggerationForPayload(payload);
  let previousBearing = rawFollowCameraForProgress(payload, 0, terrainExaggeration).bearing;
  let previousCenter = rawFollowCameraForProgress(payload, 0, terrainExaggeration);

  for (let frameIndex = 0; frameIndex < followFrameCount; frameIndex += 1) {
    const phaseProgress = followFrameCount <= 1 ? 1 : frameIndex / (followFrameCount - 1);
    const raw = rawFollowCameraForProgress(payload, phaseProgress, terrainExaggeration);
    const angleDelta = Math.abs(shortestAngleDelta(previousBearing, raw.bearing));
    const centerDriftMeters = distanceBetweenGeoPointsMeters(
      { lat: previousCenter.centerLat, lng: previousCenter.centerLng },
      { lat: raw.centerLat, lng: raw.centerLng },
    );
    const maxBearingStep = lerpNumber(7.5, 15, clampNumber(angleDelta / 60, 0, 1));
    const centerCatchup = lerpNumber(0.34, 0.78, clampNumber(centerDriftMeters / 26, 0, 1));
    const bearing =
      frameIndex === 0 ? raw.bearing : clampAngleStep(previousBearing, raw.bearing, maxBearingStep);
    const centerLat =
      frameIndex === 0 ? raw.centerLat : lerpNumber(previousCenter.centerLat, raw.centerLat, centerCatchup);
    const centerLng =
      frameIndex === 0 ? raw.centerLng : lerpNumber(previousCenter.centerLng, raw.centerLng, centerCatchup);

    const frame: RenderFrameState = {
      phase: 'follow',
      phaseProgress,
      routeProgress: phaseProgress,
      centerLat,
      centerLng,
      bearing,
      pitch: raw.pitch,
      zoom: raw.zoom,
      terrainExaggeration: raw.terrainExaggeration,
      padding: layout.followPadding,
      currentDistanceKm: raw.currentDistanceKm,
      currentElapsedSeconds: raw.currentElapsedSeconds,
      currentPaceSecondsPerKm: raw.currentPaceSecondsPerKm,
    };

    followFrames.push(frame);
    previousBearing = bearing;
    previousCenter = frame;
  }

  return followFrames;
}

function buildRenderFrames(payload: RouteVideoPayload, preset: RouteVideoExportPresetConfig) {
  const timeline = createRouteVideoTimeline(payload.totalDistanceKm);
  const layout = createRouteVideoRenderLayout(preset);
  const {
    captureFrames,
    durationSeconds: totalDurationSeconds,
    renderFps,
  } = estimateRouteVideoRenderMetrics(payload.totalDistanceKm, preset.outputFps);
  const followFrames = buildFollowFrames(payload, renderFps, layout);
  const terrainExaggeration = terrainExaggerationForPayload(payload);
  const firstFollowFrame = followFrames[0] ?? rawFollowCameraForProgress(payload, 0, terrainExaggeration);
  const lastFollowFrame = followFrames.at(-1) ?? firstFollowFrame;
  const frames: RenderFrameState[] = [];

  for (let frameIndex = 0; frameIndex < captureFrames; frameIndex += 1) {
    const elapsedSeconds = frameIndex / renderFps;
    const routeProgress = routeProgressAtElapsedSeconds(timeline, elapsedSeconds);
    const overviewEnd = timeline.overviewSeconds;
    const descentEnd = timeline.overviewSeconds + timeline.descentSeconds;
    const finishStart = timeline.totalSeconds - timeline.finishHoldSeconds;

    if (elapsedSeconds <= overviewEnd) {
      frames.push({
        phase: 'overview',
        phaseProgress: timeline.overviewSeconds <= 0 ? 1 : elapsedSeconds / timeline.overviewSeconds,
        routeProgress: 0,
        centerLat: firstFollowFrame.centerLat,
        centerLng: firstFollowFrame.centerLng,
        bearing: 0,
        pitch: 0,
        zoom: 0,
        terrainExaggeration,
        padding: layout.overviewPadding,
        currentDistanceKm: 0,
        currentElapsedSeconds: 0,
        currentPaceSecondsPerKm: payload.points[0]?.paceSecondsPerKm ?? null,
      });
      continue;
    }

    if (elapsedSeconds <= descentEnd) {
      const phaseProgress = (elapsedSeconds - overviewEnd) / timeline.descentSeconds;
      frames.push({
        phase: 'descent',
        phaseProgress,
        routeProgress: 0,
        centerLat: firstFollowFrame.centerLat,
        centerLng: firstFollowFrame.centerLng,
        bearing: firstFollowFrame.bearing,
        pitch: lerpNumber(0, firstFollowFrame.pitch, phaseProgress),
        zoom: lerpNumber(0, firstFollowFrame.zoom, phaseProgress),
        terrainExaggeration,
        padding: {
          top: Math.round(lerpNumber(layout.overviewPadding.top, layout.followPadding.top, phaseProgress)),
          bottom: Math.round(lerpNumber(layout.overviewPadding.bottom, layout.followPadding.bottom, phaseProgress)),
          left: Math.round(lerpNumber(layout.overviewPadding.left, layout.followPadding.left, phaseProgress)),
          right: Math.round(lerpNumber(layout.overviewPadding.right, layout.followPadding.right, phaseProgress)),
        },
        currentDistanceKm: 0,
        currentElapsedSeconds: 0,
        currentPaceSecondsPerKm: payload.points[0]?.paceSecondsPerKm ?? null,
      });
      continue;
    }

    if (elapsedSeconds < finishStart) {
      const followFrameIndex = Math.min(
        followFrames.length - 1,
        Math.max(0, Math.round(routeProgress * Math.max(followFrames.length - 1, 0))),
      );
      frames.push(followFrames[followFrameIndex]!);
      continue;
    }

    frames.push({
      phase: 'finish',
      phaseProgress: (elapsedSeconds - finishStart) / timeline.finishHoldSeconds,
      routeProgress: 1,
      centerLat: lastFollowFrame.centerLat,
      centerLng: lastFollowFrame.centerLng,
      bearing: 0,
      pitch: lerpNumber(lastFollowFrame.pitch, 12, (elapsedSeconds - finishStart) / timeline.finishHoldSeconds),
      zoom: lastFollowFrame.zoom,
      terrainExaggeration: lastFollowFrame.terrainExaggeration,
      padding: layout.finishPadding,
      currentDistanceKm: payload.totalDistanceKm,
      currentElapsedSeconds: payload.totalElapsedSeconds,
      currentPaceSecondsPerKm: payload.points.at(-1)?.paceSecondsPerKm ?? lastFollowFrame.currentPaceSecondsPerKm,
    });
  }

  return {
    frames,
    totalFrames: captureFrames,
    totalDurationSeconds,
    renderFps,
  };
}

function pickWarmupFrames(frames: RenderFrameState[]) {
  if (!frames.length) {
    return [];
  }

  const warmupIndexes = new Set<number>([0, frames.length - 1]);
  const descentIndex = frames.findIndex((frame) => frame.phase === 'descent');
  const finishIndex = frames.findIndex((frame) => frame.phase === 'finish');
  if (descentIndex >= 0) {
    warmupIndexes.add(descentIndex);
  }
  if (finishIndex >= 0) {
    warmupIndexes.add(finishIndex);
  }

  const followIndexes = frames.flatMap((frame, index) => (frame.phase === 'follow' ? [index] : []));
  const sampleCount = Math.min(
    followIndexes.length,
    Math.max(18, Math.min(48, Math.ceil(followIndexes.length / 14))),
  );
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const followIndex =
      followIndexes[
        sampleCount <= 1
          ? 0
          : Math.round((sampleIndex / (sampleCount - 1)) * Math.max(followIndexes.length - 1, 0))
      ];
    if (typeof followIndex === 'number') {
      warmupIndexes.add(followIndex);
    }
  }

  return Array.from(warmupIndexes)
    .sort((left, right) => left - right)
    .map((index) => frames[index]!)
    .filter(Boolean);
}

function createRendererHtml(
  payload: RouteVideoPayload,
  summary: RouteVideoRenderSummary,
  preset: RouteVideoExportPresetConfig,
) {
  const layout = createRouteVideoRenderLayout(preset);
  const { scaleRenderPx } = layout;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Route Video Export</title>
    <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.22.0/dist/maplibre-gl.css" />
    <style>
      :root {
        color-scheme: dark;
        --bg: #05080d;
        --surface: rgba(8, 14, 22, 0.72);
        --surface-strong: rgba(10, 16, 26, 0.84);
        --stroke: rgba(255, 255, 255, 0.12);
        --text: rgba(247, 248, 251, 0.96);
        --muted: rgba(214, 220, 229, 0.72);
        --accent: #30b7ff;
        --accent-2: #ff5252;
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        width: ${preset.renderWidth}px;
        height: ${preset.renderHeight}px;
        overflow: hidden;
        background: var(--bg);
        font-family: "SF Pro Display", "Inter", "Segoe UI", sans-serif;
      }
      body {
        position: relative;
      }
      #app {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background:
          radial-gradient(circle at 50% 18%, rgba(68, 120, 178, 0.22), transparent 38%),
          linear-gradient(180deg, #09111b 0%, #06090f 100%);
      }
      #map {
        position: absolute;
        inset: 0;
      }
      .map-fx-top,
      .map-fx-bottom,
      .map-fx-vignette {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }
      .map-fx-top {
        background: linear-gradient(180deg, rgba(4, 8, 12, 0.82) 0%, rgba(4, 8, 12, 0.32) 28%, transparent 100%);
      }
      .map-fx-bottom {
        background: linear-gradient(180deg, transparent 0%, transparent 54%, rgba(4, 8, 12, 0.12) 66%, rgba(4, 8, 12, 0.78) 100%);
      }
      .map-fx-vignette {
        background:
          linear-gradient(90deg, rgba(4, 8, 12, 0.32), transparent 16%, transparent 84%, rgba(4, 8, 12, 0.32)),
          radial-gradient(circle at 50% 40%, transparent 48%, rgba(4, 8, 12, 0.26) 100%);
      }
      .hud-top {
        position: absolute;
        top: ${scaleRenderPx(38)}px;
        left: ${scaleRenderPx(36)}px;
        right: ${scaleRenderPx(36)}px;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: ${scaleRenderPx(20)}px;
      }
      .brand-card {
        padding: ${scaleRenderPx(18)}px ${scaleRenderPx(20)}px ${scaleRenderPx(20)}px;
        border-radius: ${scaleRenderPx(24)}px;
        background: var(--surface);
        border: 1px solid var(--stroke);
        min-width: 0;
        max-width: ${scaleRenderPx(760)}px;
      }
      .brand-card .eyebrow {
        display: inline-block;
        padding: ${scaleRenderPx(7)}px ${scaleRenderPx(12)}px;
        border-radius: 999px;
        background: rgba(255, 109, 61, 0.16);
        color: rgba(255, 191, 163, 0.98);
        font-size: ${scaleRenderPx(16)}px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .brand-card h1 {
        margin: ${scaleRenderPx(14)}px 0 0;
        font-size: ${scaleRenderPx(40)}px;
        line-height: 1.06;
        color: var(--text);
        letter-spacing: -0.03em;
      }
      .brand-card .meta {
        margin-top: ${scaleRenderPx(10)}px;
        font-size: ${scaleRenderPx(22)}px;
        color: var(--muted);
        letter-spacing: -0.01em;
      }
      .hud-bottom {
        position: absolute;
        left: ${scaleRenderPx(36)}px;
        right: ${scaleRenderPx(36)}px;
        bottom: ${scaleRenderPx(42)}px;
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: ${scaleRenderPx(14)}px;
      }
      .stat-card {
        padding: ${scaleRenderPx(18)}px ${scaleRenderPx(18)}px ${scaleRenderPx(20)}px;
        border-radius: ${scaleRenderPx(22)}px;
        background: var(--surface-strong);
        border: 1px solid var(--stroke);
      }
      .stat-card .label {
        display: block;
        font-size: ${scaleRenderPx(15)}px;
        line-height: 1;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(214, 220, 229, 0.7);
      }
      .stat-card .value {
        margin-top: ${scaleRenderPx(10)}px;
        font-size: ${scaleRenderPx(34)}px;
        line-height: 1.02;
        letter-spacing: -0.03em;
        color: var(--text);
        font-weight: 700;
      }
      .progress-strip {
        position: absolute;
        left: ${scaleRenderPx(36)}px;
        right: ${scaleRenderPx(36)}px;
        bottom: ${scaleRenderPx(214)}px;
        height: ${scaleRenderPx(10)}px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(255, 255, 255, 0.14);
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .progress-strip > span {
        display: block;
        height: 100%;
        width: 0%;
        border-radius: inherit;
        background: linear-gradient(90deg, #30b7ff 0%, #25dd76 26%, #f3e44e 52%, #ff9d35 76%, #ff5252 100%);
      }
      .phase-chip {
        position: absolute;
        top: ${scaleRenderPx(40)}px;
        right: ${scaleRenderPx(36)}px;
        padding: ${scaleRenderPx(12)}px ${scaleRenderPx(16)}px;
        border-radius: 999px;
        background: rgba(8, 14, 22, 0.74);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: rgba(247, 248, 251, 0.94);
        font-size: ${scaleRenderPx(16)}px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .maplibregl-ctrl-logo,
      .maplibregl-ctrl-attrib {
        display: none !important;
      }
    </style>
  </head>
  <body>
    <div id="app">
      <div id="map"></div>
      <div class="map-fx-top"></div>
      <div class="map-fx-bottom"></div>
      <div class="map-fx-vignette"></div>
      <div class="hud-top">
        <div class="brand-card">
          <span class="eyebrow" id="eyebrow"></span>
          <h1 id="title"></h1>
          <div class="meta" id="meta"></div>
        </div>
      </div>
      <div class="phase-chip" id="phase-chip"></div>
      <div class="progress-strip"><span id="progress-fill"></span></div>
      <div class="hud-bottom">
        <div class="stat-card"><span class="label">Distance</span><span class="value" id="distance-value"></span></div>
        <div class="stat-card"><span class="label">Pace</span><span class="value" id="pace-value"></span></div>
        <div class="stat-card"><span class="label">Time</span><span class="value" id="time-value"></span></div>
        <div class="stat-card"><span class="label">Elev</span><span class="value" id="elev-value"></span></div>
      </div>
    </div>
    <script src="https://unpkg.com/maplibre-gl@5.22.0/dist/maplibre-gl.js"></script>
    <script>
      const payload = ${JSON.stringify(payload)};
      const summary = ${JSON.stringify(summary)};
      const fullCoords = payload.points.map((point) => [point.lng, point.lat]);

      const overviewPadding = ${JSON.stringify(layout.overviewPadding)};
      const finishPadding = ${JSON.stringify(layout.finishPadding)};
      const terrainSourceId = 'terrain-source';
      const phaseLabels = {
        overview: '2D Overview',
        descent: 'Drop In',
        follow: 'Runner Cam',
        finish: 'Route Complete',
      };
      const routeHeatPalette = ['#30b7ff', '#25dd76', '#f3e44e', '#ff9d35', '#ff5252'];
      const routeBounds = buildRouteBounds();

      const map = new maplibregl.Map({
        container: 'map',
        style: ${JSON.stringify(VIDEO_BASE_MAP_STYLE)},
        center: fullCoords[0],
        zoom: 13,
        pitch: 0,
        bearing: 0,
        interactive: false,
        attributionControl: false,
        fadeDuration: 0,
        antialias: false,
        maxPitch: 85,
        renderWorldCopies: false,
        canvasContextAttributes: {
          antialias: false,
        },
      });

      map.setPixelRatio(${preset.mapRenderPixelRatio});

      const titleEl = document.getElementById('title');
      const metaEl = document.getElementById('meta');
      const eyebrowEl = document.getElementById('eyebrow');
      const phaseEl = document.getElementById('phase-chip');
      const distanceEl = document.getElementById('distance-value');
      const paceEl = document.getElementById('pace-value');
      const timeEl = document.getElementById('time-value');
      const elevEl = document.getElementById('elev-value');
      const progressFillEl = document.getElementById('progress-fill');

      function formatPaceClient(secondsPerKm) {
        if (!secondsPerKm || !Number.isFinite(secondsPerKm) || secondsPerKm <= 0) {
          return '--';
        }
        const minutes = Math.floor(secondsPerKm / 60);
        const seconds = Math.round(secondsPerKm % 60);
        return minutes + ':' + String(seconds).padStart(2, '0') + '/km';
      }

      function formatDurationClient(seconds) {
        const totalSeconds = Math.max(0, Math.round(seconds));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const remainingSeconds = totalSeconds % 60;
        if (hours > 0) {
          return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(remainingSeconds).padStart(2, '0');
        }
        return minutes + ':' + String(remainingSeconds).padStart(2, '0');
      }

      function lerp(start, end, amount) {
        return start + (end - start) * amount;
      }

      function scalePadding(padding, ratio) {
        return {
          top: Math.round(padding.top * ratio),
          bottom: Math.round(padding.bottom * ratio),
          left: Math.round(padding.left * ratio),
          right: Math.round(padding.right * ratio),
        };
      }

      function isValidLngLat(lng, lat) {
        return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
      }

      function pickFallbackCenter() {
        const midpointPoint = payload.points[Math.floor(payload.points.length / 2)] || payload.points[0] || null;
        const candidates = [
          [
            (Number(payload.bounds.minLng) + Number(payload.bounds.maxLng)) / 2,
            (Number(payload.bounds.minLat) + Number(payload.bounds.maxLat)) / 2,
          ],
          midpointPoint ? [midpointPoint.lng, midpointPoint.lat] : null,
          payload.points[0] ? [payload.points[0].lng, payload.points[0].lat] : null,
          [0, 0],
        ];

        for (const candidate of candidates) {
          if (!candidate) {
            continue;
          }
          const [lng, lat] = candidate;
          if (isValidLngLat(lng, lat)) {
            return { lng, lat };
          }
        }

        return { lng: 0, lat: 0 };
      }

      const fallbackCenter = pickFallbackCenter();

      function normalizeCenter(center) {
        if (center && typeof center.lng === 'number' && typeof center.lat === 'number') {
          if (isValidLngLat(center.lng, center.lat)) {
            return { lng: center.lng, lat: center.lat };
          }
        }
        if (Array.isArray(center) && center.length >= 2) {
          const lng = Number(center[0]);
          const lat = Number(center[1]);
          if (isValidLngLat(lng, lat)) {
            return { lng, lat };
          }
        }
        return fallbackCenter;
      }

      function normalizeZoom(zoom) {
        return Number.isFinite(zoom) ? Math.max(0, Math.min(20, zoom)) : 13.2;
      }

      function buildRouteBounds() {
        const lngCandidates = payload.points.map((point) => point.lng).filter(Number.isFinite);
        const latCandidates = payload.points.map((point) => point.lat).filter(Number.isFinite);
        const boundsLng = [Number(payload.bounds.minLng), Number(payload.bounds.maxLng)].filter(Number.isFinite);
        const boundsLat = [Number(payload.bounds.minLat), Number(payload.bounds.maxLat)].filter(Number.isFinite);
        const minLng = Math.min(...(boundsLng.length === 2 ? boundsLng : lngCandidates));
        const maxLng = Math.max(...(boundsLng.length === 2 ? boundsLng : lngCandidates));
        const minLat = Math.min(...(boundsLat.length === 2 ? boundsLat : latCandidates));
        const maxLat = Math.max(...(boundsLat.length === 2 ? boundsLat : latCandidates));

        const safeMinLng = Number.isFinite(minLng) ? minLng : fallbackCenter.lng - 0.001;
        const safeMaxLng = Number.isFinite(maxLng) ? maxLng : fallbackCenter.lng + 0.001;
        const safeMinLat = Number.isFinite(minLat) ? minLat : fallbackCenter.lat - 0.001;
        const safeMaxLat = Number.isFinite(maxLat) ? maxLat : fallbackCenter.lat + 0.001;

        const lngPad = Math.abs(safeMaxLng - safeMinLng) < 0.0002 ? 0.0008 : 0;
        const latPad = Math.abs(safeMaxLat - safeMinLat) < 0.0002 ? 0.0008 : 0;

        return new maplibregl.LngLatBounds(
          [safeMinLng - lngPad, safeMinLat - latPad],
          [safeMaxLng + lngPad, safeMaxLat + latPad],
        );
      }

      function toLineFeature(coords, properties = {}) {
        return {
          type: 'Feature',
          properties,
          geometry: {
            type: 'LineString',
            coordinates: coords,
          },
        };
      }

      function quantile(values, ratio) {
        if (!values.length) {
          return null;
        }
        const index = Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * ratio)));
        return values[index] ?? null;
      }

      function buildRoutePaceScale() {
        const paceValues = payload.points
          .map((point) => point.paceSecondsPerKm)
          .filter((pace) => typeof pace === 'number' && Number.isFinite(pace) && pace > 0)
          .sort((left, right) => left - right);

        if (!paceValues.length) {
          return {
            fast: 300,
            slow: 420,
          };
        }

        const fast = quantile(paceValues, 0.14) ?? paceValues[0];
        const slow = quantile(paceValues, 0.88) ?? paceValues[paceValues.length - 1];
        return {
          fast,
          slow: Math.max(slow, fast + 1),
        };
      }

      const routePaceScale = buildRoutePaceScale();

      function colorForPace(paceSecondsPerKm) {
        if (!paceSecondsPerKm || !Number.isFinite(paceSecondsPerKm)) {
          return routeHeatPalette[0];
        }

        const span = Math.max(routePaceScale.slow - routePaceScale.fast, 1);
        const heat = Math.max(
          0,
          Math.min((routePaceScale.slow - paceSecondsPerKm) / span, 1),
        );

        if (heat < 0.2) {
          return routeHeatPalette[0];
        }
        if (heat < 0.42) {
          return routeHeatPalette[1];
        }
        if (heat < 0.64) {
          return routeHeatPalette[2];
        }
        if (heat < 0.84) {
          return routeHeatPalette[3];
        }
        return routeHeatPalette[4];
      }

      function buildPacedRouteGroups() {
        const groups = [];

        for (let index = 1; index < payload.points.length; index += 1) {
          const startPoint = payload.points[index - 1];
          const endPoint = payload.points[index];
          const segmentColor = colorForPace(endPoint.paceSecondsPerKm ?? startPoint.paceSecondsPerKm ?? null);
          const previousGroup = groups[groups.length - 1];

          if (previousGroup && previousGroup.color === segmentColor) {
            previousGroup.coords.push([endPoint.lng, endPoint.lat]);
            previousGroup.distances.push(endPoint.distanceMeters);
            previousGroup.endDistance = endPoint.distanceMeters;
            continue;
          }

          groups.push({
            color: segmentColor,
            startDistance: startPoint.distanceMeters,
            endDistance: endPoint.distanceMeters,
            coords: [
              [startPoint.lng, startPoint.lat],
              [endPoint.lng, endPoint.lat],
            ],
            distances: [startPoint.distanceMeters, endPoint.distanceMeters],
          });
        }

        return groups;
      }

      const pacedRouteGroups = buildPacedRouteGroups();

      function findRightIndexByProgress(progress) {
        const targetDistance = (payload.points[payload.points.length - 1]?.distanceMeters || 0) * Math.max(0, Math.min(progress, 1));
        let left = 0;
        let right = payload.points.length - 1;
        while (left < right) {
          const mid = Math.floor((left + right) / 2);
          if ((payload.points[mid]?.distanceMeters || 0) < targetDistance) {
            left = mid + 1;
          } else {
            right = mid;
          }
        }
        return left;
      }

      function clipGroupCoords(group, targetDistance) {
        const clippedCoords = [group.coords[0]];

        for (let index = 1; index < group.coords.length; index += 1) {
          const previousDistance = group.distances[index - 1];
          const currentDistance = group.distances[index];
          const currentCoord = group.coords[index];
          const previousCoord = group.coords[index - 1];

          if (targetDistance >= currentDistance) {
            clippedCoords.push(currentCoord);
            continue;
          }

          const ratio = Math.max(
            0,
            Math.min((targetDistance - previousDistance) / Math.max(currentDistance - previousDistance, 0.0001), 1),
          );
          clippedCoords.push([
            lerp(previousCoord[0], currentCoord[0], ratio),
            lerp(previousCoord[1], currentCoord[1], ratio),
          ]);
          break;
        }

        if (clippedCoords.length === 1) {
          clippedCoords.push([...clippedCoords[0]]);
        }

        return clippedCoords;
      }

      function routeSlice(progress) {
        const clampedProgress = Math.max(0, Math.min(progress, 1));
        const rightIndex = findRightIndexByProgress(clampedProgress);
        const endPoint = payload.points[Math.min(rightIndex, payload.points.length - 1)];
        const startPoint = payload.points[Math.max(0, rightIndex - 1)] || endPoint;
        const targetDistance = (payload.points[payload.points.length - 1]?.distanceMeters || 0) * clampedProgress;
        const span = Math.max((endPoint?.distanceMeters || 0) - (startPoint?.distanceMeters || 0), 0.0001);
        const ratio = Math.max(0, Math.min((targetDistance - (startPoint?.distanceMeters || 0)) / span, 1));
        const interpolated = [
          lerp(startPoint.lng, endPoint.lng, ratio),
          lerp(startPoint.lat, endPoint.lat, ratio),
        ];
        return {
          currentColor: colorForPace(endPoint?.paceSecondsPerKm ?? startPoint?.paceSecondsPerKm ?? null),
          currentCoord: interpolated,
          featureCollection: {
            type: 'FeatureCollection',
            features: pacedRouteGroups.flatMap((group) => {
              if (targetDistance >= group.endDistance) {
                return [toLineFeature(group.coords, { color: group.color })];
              }

              if (targetDistance > group.startDistance) {
                return [toLineFeature(clipGroupCoords(group, targetDistance), { color: group.color })];
              }

              return [];
            }),
          },
        };
      }

      function updateRouteSources(progress) {
        const route = routeSlice(progress);
        map.getSource('route-progress').setData(route.featureCollection);
        map.getSource('runner-point').setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {
                color: route.currentColor,
              },
              geometry: {
                type: 'Point',
                coordinates: route.currentCoord,
              },
            },
          ],
        });
      }

      function updateHud(frameState) {
        eyebrowEl.textContent = summary.activityLabel + ' · ' + summary.providerLabel;
        titleEl.textContent = summary.title;
        metaEl.textContent = [summary.athleteName, summary.date, summary.timeLabel].filter(Boolean).join(' · ');
        phaseEl.textContent = phaseLabels[frameState.phase] || frameState.phase;
        distanceEl.textContent = frameState.currentDistanceKm.toFixed(1) + ' km';
        paceEl.textContent = formatPaceClient(frameState.currentPaceSecondsPerKm);
        timeEl.textContent = formatDurationClient(frameState.currentElapsedSeconds);
        elevEl.textContent = Math.round(summary.elevationGain || 0) + ' m';
        progressFillEl.style.width = (frameState.routeProgress * 100).toFixed(2) + '%';
      }

      function cameraForBounds(padding) {
        const widthBudget = Math.max(32, window.innerWidth - 32);
        const heightBudget = Math.max(32, window.innerHeight - 32);
        const paddingWidth = padding.left + padding.right;
        const paddingHeight = padding.top + padding.bottom;
        const fitScale = Math.min(
          1,
          paddingWidth > 0 ? widthBudget / paddingWidth : 1,
          paddingHeight > 0 ? heightBudget / paddingHeight : 1,
        );
        const normalizedPadding = fitScale < 1 ? scalePadding(padding, Math.max(0.14, fitScale)) : padding;
        const candidateRatios = [1, 0.9, 0.76, 0.62, 0.48, 0.34];

        for (const ratio of candidateRatios) {
          const candidatePadding = ratio === 1 ? normalizedPadding : scalePadding(normalizedPadding, ratio);
          try {
            const camera = map.cameraForBounds(routeBounds, {
              padding: candidatePadding,
              bearing: 0,
              pitch: 0,
              maxZoom: 16.2,
            });

            if (camera) {
              const center = normalizeCenter(camera.center);
              const zoom = normalizeZoom(camera.zoom);
              if (center && Number.isFinite(zoom)) {
                return {
                  center,
                  zoom,
                  padding: candidatePadding,
                };
              }
            }
          } catch (_error) {
            // Try a smaller padding profile before falling back to a static center.
          }
        }
        return {
          center: normalizeCenter(routeBounds.getCenter()),
          zoom: Math.min(15.4, Math.max(12.2, normalizeZoom(map.getZoom()))),
          padding: normalizedPadding,
        };
      }

      function waitForTimer(ms) {
        return new Promise((resolve) => {
          setTimeout(resolve, Math.max(0, ms || 0));
        });
      }

      function requestMapRender(forceSync = false) {
        const internalMap = map;
        if (typeof map.redraw === 'function') {
          map.redraw();
        }
        if (typeof map.triggerRepaint === 'function') {
          map.triggerRepaint();
        }
        if (forceSync && internalMap && typeof internalMap._render === 'function') {
          try {
            internalMap._render(performance.now());
            return true;
          } catch (_error) {
            // Fall back to the public repaint APIs when MapLibre internals differ.
          }
        }
        return false;
      }

      function waitForNextMapRender(timeoutMs, forceSync = false) {
        return new Promise((resolve) => {
          let settled = false;
          let timeoutId = null;
          const finish = () => {
            if (settled) {
              return;
            }
            settled = true;
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            resolve();
          };
          map.once('render', finish);
          timeoutId = setTimeout(finish, Math.max(16, timeoutMs || 0));
          requestMapRender(forceSync);
        });
      }

      async function waitForMapSettled(maxWaitMs, mode = 'prewarm') {
        const deadline = performance.now() + Math.max(0, maxWaitMs || 0);
        const forceSync = mode === 'capture';
        const forceRendered = requestMapRender(forceSync);
        if (mode === 'capture') {
          if (!forceRendered) {
            await waitForNextMapRender(Math.min(Math.max(24, maxWaitMs || 0), 90), true);
          }
          await waitForTimer(6);
          return;
        }

        await waitForTimer(18);

        while (performance.now() < deadline) {
          const tilesLoaded = typeof map.areTilesLoaded === 'function' ? map.areTilesLoaded() : true;
          const terrainLoaded = typeof map.isSourceLoaded === 'function' ? map.isSourceLoaded(terrainSourceId) : true;
          if (tilesLoaded && terrainLoaded) {
            break;
          }
          requestMapRender(false);
          await waitForTimer(18);
        }

        requestMapRender(false);
        await waitForTimer(10);
      }

      function jumpToFrame(frameState) {
        updateRouteSources(frameState.routeProgress);
        updateHud(frameState);
        const terrain = map.getTerrain();
        if (!terrain || Math.abs((terrain.exaggeration || 1) - frameState.terrainExaggeration) > 0.01) {
          map.setTerrain({
            source: terrainSourceId,
            exaggeration: frameState.terrainExaggeration,
          });
        }

        if (frameState.phase === 'overview') {
          const overview = cameraForBounds(overviewPadding);
          map.jumpTo({
            center: overview.center,
            zoom: overview.zoom,
            pitch: 0,
            bearing: 0,
            padding: overview.padding,
          });
          requestMapRender();
          return;
        }

        if (frameState.phase === 'descent') {
          const overview = cameraForBounds(overviewPadding);
          const center = [
            lerp(overview.center.lng, frameState.centerLng, frameState.phaseProgress),
            lerp(overview.center.lat, frameState.centerLat, frameState.phaseProgress),
          ];
          map.jumpTo({
            center,
            zoom: lerp(overview.zoom, frameState.zoom, frameState.phaseProgress),
            pitch: frameState.pitch,
            bearing: frameState.bearing * frameState.phaseProgress,
            padding: frameState.padding,
          });
          requestMapRender();
          return;
        }

        if (frameState.phase === 'finish') {
          const finish = cameraForBounds(finishPadding);
          map.jumpTo({
            center: finish.center,
            zoom: finish.zoom,
            pitch: lerp(frameState.pitch, 12, frameState.phaseProgress),
            bearing: 0,
            padding: finish.padding,
          });
          requestMapRender();
          return;
        }

        map.jumpTo({
          center: [frameState.centerLng, frameState.centerLat],
          zoom: frameState.zoom,
          pitch: frameState.pitch,
          bearing: frameState.bearing,
          padding: frameState.padding,
        });
        requestMapRender();
      }

      async function renderFrame(frameState, settleMs, settleMode = 'prewarm') {
        jumpToFrame(frameState);
        await waitForMapSettled(settleMs, settleMode);
      }

      async function prewarmFrames(frames) {
        const totalFrames = Array.isArray(frames) ? frames.length : 0;
        if (!totalFrames) {
          return;
        }

        globalThis.__routeVideoPlaybackState = {
          status: 'warming',
          progress: 0,
          frameIndex: 0,
          totalFrames,
        };

        for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
          await renderFrame(frames[frameIndex], frameIndex === 0 ? 120 : 28);
          globalThis.__routeVideoPlaybackState = {
            status: 'warming',
            progress: totalFrames <= 1 ? 1 : frameIndex / (totalFrames - 1),
            frameIndex,
            totalFrames,
          };
        }

        globalThis.__routeVideoPlaybackState = {
          status: 'idle',
          progress: 0,
          frameIndex: 0,
          totalFrames,
        };
      }

      async function playTimeline(frames, fps) {
        const totalFrames = Array.isArray(frames) ? frames.length : 0;
        if (!totalFrames) {
          globalThis.__routeVideoPlaybackState = {
            status: 'done',
            progress: 1,
            frameIndex: 0,
            totalFrames: 0,
          };
          return {
            elapsedMs: 0,
          };
        }

        const safeFps = Math.max(1, Number.isFinite(fps) ? fps : ${preset.outputFps});
        const frameDurationMs = 1000 / safeFps;
        jumpToFrame(frames[0]);
        await waitForTimer(24);

        return new Promise((resolve) => {
          const startedAt = performance.now();
          let appliedFrameIndex = 0;

          const step = () => {
            jumpToFrame(frames[appliedFrameIndex]);
            globalThis.__routeVideoPlaybackState = {
              status: appliedFrameIndex >= totalFrames - 1 ? 'done' : 'playing',
              progress: totalFrames <= 1 ? 1 : appliedFrameIndex / (totalFrames - 1),
              frameIndex: appliedFrameIndex,
              totalFrames,
            };

            if (appliedFrameIndex >= totalFrames - 1) {
              resolve({
                elapsedMs: performance.now() - startedAt,
              });
              return;
            }

            appliedFrameIndex += 1;
            const targetElapsedMs = appliedFrameIndex * frameDurationMs;
            const delayMs = Math.max(0, targetElapsedMs - (performance.now() - startedAt));
            setTimeout(step, delayMs);
          };

          globalThis.__routeVideoPlaybackState = {
            status: 'playing',
            progress: 0,
            frameIndex: 0,
            totalFrames,
          };
          setTimeout(step, 0);
        });
      }

      function addRouteLayers() {
        map.addSource(terrainSourceId, {
          type: 'raster-dem',
          tiles: ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 15,
          encoding: 'terrarium',
        });
        map.setTerrain({
          source: terrainSourceId,
          exaggeration: ${terrainExaggerationForPayload(payload)},
        });

        map.addSource('route-full', {
          type: 'geojson',
          data: toLineFeature(fullCoords),
        });
        map.addSource('route-progress', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [],
          },
        });
        map.addSource('runner-point', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [],
          },
        });
        map.addSource('route-terminals', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {
                  kind: 'start',
                },
                geometry: {
                  type: 'Point',
                  coordinates: fullCoords[0],
                },
              },
              {
                type: 'Feature',
                properties: {
                  kind: 'finish',
                },
                geometry: {
                  type: 'Point',
                  coordinates: fullCoords[fullCoords.length - 1],
                },
              },
            ],
          },
        });

        map.addLayer({
          id: 'route-full-shadow',
          type: 'line',
          source: 'route-full',
          paint: {
            'line-color': 'rgba(8, 14, 22, 0.92)',
            'line-width': 12,
            'line-opacity': 0.9,
          },
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
          },
        });
        map.addLayer({
          id: 'route-full-base',
          type: 'line',
          source: 'route-full',
          paint: {
            'line-color': 'rgba(120, 188, 255, 0.18)',
            'line-width': 6,
            'line-opacity': 0.8,
          },
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
          },
        });
        map.addLayer({
          id: 'route-progress-glow',
          type: 'line',
          source: 'route-progress',
          paint: {
            'line-color': ['coalesce', ['get', 'color'], routeHeatPalette[0]],
            'line-width': 14,
            'line-blur': 1.2,
            'line-opacity': 0.42,
          },
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
          },
        });
        map.addLayer({
          id: 'route-progress-main',
          type: 'line',
          source: 'route-progress',
          paint: {
            'line-color': ['coalesce', ['get', 'color'], routeHeatPalette[0]],
            'line-width': 7,
            'line-opacity': 0.98,
          },
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
          },
        });
        map.addLayer({
          id: 'route-terminals',
          type: 'circle',
          source: 'route-terminals',
          paint: {
            'circle-radius': [
              'match',
              ['get', 'kind'],
              'start',
              7,
              7,
            ],
            'circle-color': [
              'match',
              ['get', 'kind'],
              'start',
              '#ffffff',
              routeHeatPalette[4],
            ],
            'circle-stroke-color': 'rgba(8, 14, 22, 0.9)',
            'circle-stroke-width': 3,
          },
        });
        map.addLayer({
          id: 'runner-point-halo',
          type: 'circle',
          source: 'runner-point',
          paint: {
            'circle-radius': 22,
            'circle-color': 'rgba(255, 255, 255, 0.16)',
          },
        });
        map.addLayer({
          id: 'runner-point-main',
          type: 'circle',
          source: 'runner-point',
          paint: {
            'circle-radius': 9,
            'circle-color': ['coalesce', ['get', 'color'], routeHeatPalette[0]],
            'circle-stroke-color': 'rgba(255,255,255,0.96)',
            'circle-stroke-width': 3,
          },
        });
      }

      map.once('load', async () => {
        addRouteLayers();
        updateRouteSources(0);
        updateHud({
          phase: 'overview',
          routeProgress: 0,
          currentDistanceKm: 0,
          currentElapsedSeconds: 0,
          currentPaceSecondsPerKm: payload.points[0]?.paceSecondsPerKm || null,
        });
        const overview = cameraForBounds(overviewPadding);
        map.jumpTo({
          center: overview.center,
          zoom: overview.zoom,
          pitch: 0,
          bearing: 0,
          padding: overview.padding,
        });
        await waitForMapSettled(60);
        globalThis.__routeVideoPlaybackState = {
          status: 'idle',
          progress: 0,
          frameIndex: 0,
          totalFrames: 0,
        };
        window.__routeVideoExport = {
          renderFrame,
          prewarmFrames,
          playTimeline,
        };
        window.__routeVideoReady = true;
      });
      map.on('error', (event) => {
        const message =
          event && event.error && event.error.message
            ? event.error.message
            : 'MapLibre no ha podido inicializar la escena del route video.';
        console.error('[route-video-map-error]', message);
      });
    </script>
  </body>
</html>`;
}

function getCaptureFrameSettleMs(frameState: RenderFrameState, frameIndex: number) {
  if (frameIndex === 0) {
    return 140;
  }

  if (frameState.phase === 'overview') {
    return 22;
  }

  if (frameState.phase === 'descent' || frameState.phase === 'finish') {
    return 28;
  }

  return frameIndex % 12 === 0 ? 20 : 12;
}

async function writeChunkToStdin(
  stdin: NonNullable<ReturnType<typeof spawn>['stdin']>,
  chunk: Buffer,
) {
  if (stdin.destroyed || stdin.writableEnded) {
    throw new Error('ffmpeg ha cerrado la entrada de frames antes de tiempo.');
  }

  if (stdin.write(chunk)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const handleDrain = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stdin.off('drain', handleDrain);
      stdin.off('error', handleError);
    };

    stdin.once('drain', handleDrain);
    stdin.once('error', handleError);
  });
}

async function encodeCapturedFramesToMp4(input: {
  outputFilePath: string;
  captureFps: number;
  preset: RouteVideoExportPresetConfig;
  frames: RenderFrameState[];
  page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newPage']>>;
  onFrameCaptured?: (frameIndex: number, totalFrames: number) => void;
}) {
  if (!ffmpegStatic) {
    throw new Error('ffmpeg-static no está disponible en este entorno.');
  }

  await fs.mkdir(path.dirname(input.outputFilePath), { recursive: true });

  const ffmpegProcess = spawn(ffmpegStatic, [
    '-y',
    '-f',
    'image2pipe',
    '-framerate',
    input.captureFps.toFixed(3),
    '-vcodec',
    'mjpeg',
    '-i',
    'pipe:0',
    '-vf',
    `fps=${input.preset.outputFps},scale=${input.preset.outputWidth}:${input.preset.outputHeight}:flags=lanczos`,
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    String(input.preset.ffmpegCrf),
    '-preset',
    input.preset.ffmpegPreset,
    '-movflags',
    '+faststart',
    input.outputFilePath,
  ]);

  const stderrChunks: Buffer[] = [];

  ffmpegProcess.stderr.on('data', (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  const completion = new Promise<void>((resolve, reject) => {
    ffmpegProcess.on('error', (error) => {
      reject(error);
    });
    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          Buffer.concat(stderrChunks).toString('utf8').trim() ||
            `ffmpeg terminó con código ${code ?? 'desconocido'}.`,
        ),
      );
    });
  });

  try {
    for (let frameIndex = 0; frameIndex < input.frames.length; frameIndex += 1) {
      const frameState = input.frames[frameIndex]!;
      await input.page.evaluate(
        ({ state, settleMs }) =>
          ((globalThis as unknown) as {
            __routeVideoExport: {
              renderFrame: (frameState: unknown, waitMs: number, settleMode?: string) => Promise<void>;
            };
          }).__routeVideoExport.renderFrame(state, settleMs, 'capture'),
        {
          state: frameState,
          settleMs: getCaptureFrameSettleMs(frameState, frameIndex),
        },
      );

      const frameBuffer = await input.page.screenshot({
        type: 'jpeg',
        quality: input.preset.jpegQuality,
        timeout: 0,
        animations: 'disabled',
      });
      await writeChunkToStdin(ffmpegProcess.stdin, frameBuffer);
      input.onFrameCaptured?.(frameIndex + 1, input.frames.length);
    }

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        ffmpegProcess.stdin.off('error', handleError);
        reject(error);
      };

      ffmpegProcess.stdin.once('error', handleError);
      ffmpegProcess.stdin.end(() => {
        ffmpegProcess.stdin.off('error', handleError);
        resolve();
      });
    });
    await completion;
  } catch (error) {
    ffmpegProcess.stdin.destroy();
    ffmpegProcess.kill('SIGKILL');
    await completion.catch(() => undefined);
    throw new Error(
      error instanceof Error
        ? error.message
        : 'ffmpeg no pudo codificar el mp4 del route video desde los frames capturados.',
    );
  }
}

export async function renderRouteVideoToMp4(input: {
  jobId: string;
  workDir: string;
  payload: RouteVideoPayload;
  preset?: RouteVideoExportPreset;
  summary: RouteVideoRenderSummary;
  onProgress?: (progress: number, message: string) => void;
}): Promise<RouteVideoRenderResult> {
  const preset = resolveRouteVideoExportPresetConfig(input.preset ?? DEFAULT_ROUTE_VIDEO_EXPORT_PRESET);
  const { frames, totalFrames: captureFrameTotal, totalDurationSeconds, renderFps } = buildRenderFrames(
    input.payload,
    preset,
  );
  const { totalFrames: outputFrameTotal } = estimateRouteVideoRenderMetrics(
    input.payload.totalDistanceKm,
    preset.outputFps,
  );
  const warmupFrames = pickWarmupFrames(frames);
  const outputFilename = `${input.jobId}.mp4`;
  const outputFilePath = path.join(input.workDir, outputFilename);

  await fs.mkdir(input.workDir, { recursive: true });
  input.onProgress?.(0.08, 'Preparando escena 3D.');

  const browser = await chromium.launch({
    headless: true,
    args: CHROMIUM_RENDER_ARGS,
  }).catch((error) => {
    throw new Error(
      `No se pudo abrir Chromium para exportar el vídeo. Instala el navegador con "npx playwright install chromium". ${error instanceof Error ? error.message : ''}`.trim(),
    );
  });

  let context: Awaited<ReturnType<typeof browser.newContext>> | null = null;
  let contextClosed = false;
  try {
    context = await browser.newContext({
      viewport: {
        width: preset.renderWidth,
        height: preset.renderHeight,
      },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const bootstrapErrors: string[] = [];

    page.on('pageerror', (error) => {
      bootstrapErrors.push(`pageerror: ${error.message}`);
    });
    page.on('requestfailed', (request) => {
      bootstrapErrors.push(
        `requestfailed: ${request.url()} ${request.failure()?.errorText ?? 'unknown'}`,
      );
    });
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        bootstrapErrors.push(`console.${message.type()}: ${message.text()}`);
      }
    });

    await page.setContent(createRendererHtml(input.payload, input.summary, preset), {
      waitUntil: 'load',
    });
    try {
      await page.waitForFunction(
        () => Boolean((globalThis as { __routeVideoReady?: unknown }).__routeVideoReady),
        {
          timeout: ROUTE_VIDEO_BOOT_TIMEOUT_MS,
        },
      );
    } catch (error) {
      const diagnostics = bootstrapErrors.length
        ? ` Diagnóstico: ${bootstrapErrors.slice(-6).join(' | ')}`
        : '';
      throw new Error(
        `La escena 3D no ha llegado a inicializarse en Chromium.${diagnostics} ${error instanceof Error ? error.message : String(error)}`.trim(),
      );
    }

    input.onProgress?.(0.14, 'Precargando ruta 3D.');
    await page.evaluate(
      (framesToWarm) =>
        ((globalThis as unknown) as {
          __routeVideoExport: {
            prewarmFrames: (frames: unknown[]) => Promise<void>;
          };
        }).__routeVideoExport.prewarmFrames(framesToWarm),
      warmupFrames,
    );

    await page.evaluate(
      (frameState) =>
        ((globalThis as unknown) as {
          __routeVideoExport: {
            renderFrame: (state: unknown, settleMs: number, settleMode?: string) => Promise<void>;
          };
        }).__routeVideoExport.renderFrame(frameState, 90, 'capture'),
      frames[0],
    );

    input.onProgress?.(0.2, `Renderizando frames 0/${outputFrameTotal}.`);
    const progressStepFrames = Math.max(1, Math.ceil(captureFrameTotal / 180));
    let lastReportedFrame = 0;
    await encodeCapturedFramesToMp4({
      outputFilePath,
      captureFps: renderFps,
      preset,
      frames,
      page,
      onFrameCaptured: (frameIndex, frameTotal) => {
        if (
          frameIndex !== frameTotal &&
          frameIndex - lastReportedFrame < progressStepFrames
        ) {
          return;
        }
        lastReportedFrame = frameIndex;
        const captureProgress = frameTotal <= 0 ? 1 : frameIndex / frameTotal;
        const outputFrameIndex =
          frameIndex >= frameTotal
            ? outputFrameTotal
            : Math.max(1, Math.min(outputFrameTotal, Math.round(captureProgress * outputFrameTotal)));
        input.onProgress?.(
          0.2 + captureProgress * 0.68,
          `Renderizando frames ${outputFrameIndex}/${outputFrameTotal}.`,
        );
      },
    });
    input.onProgress?.(0.92, 'Codificando mp4.');
    await context.close();
    contextClosed = true;
  } finally {
    if (!contextClosed) {
      await context?.close().catch(() => undefined);
    }
    await browser.close().catch(() => undefined);
  }

  input.onProgress?.(1, 'Vídeo listo.');

  return {
    filePath: outputFilePath,
    outputFilename,
    totalFrames: outputFrameTotal,
    durationSeconds: totalDurationSeconds,
  };
}
