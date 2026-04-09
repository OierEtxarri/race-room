import type { RouteVideoExportPreset } from './videoExportTypes.ts';

export type RouteVideoExportPresetConfig = {
  key: RouteVideoExportPreset;
  label: string;
  description: string;
  outputWidth: number;
  outputHeight: number;
  renderWidth: number;
  renderHeight: number;
  outputFps: number;
  mapRenderPixelRatio: number;
  jpegQuality: number;
  ffmpegCrf: number;
  ffmpegPreset: 'superfast' | 'veryfast';
};

export const DEFAULT_ROUTE_VIDEO_EXPORT_PRESET: RouteVideoExportPreset = 'high';

export const routeVideoExportPresetConfigs: Record<RouteVideoExportPreset, RouteVideoExportPresetConfig> = {
  fast: {
    key: 'fast',
    label: 'Rápido',
    description: '720x1280, 20 fps, captura ligera',
    outputWidth: 720,
    outputHeight: 1280,
    renderWidth: 360,
    renderHeight: 640,
    outputFps: 20,
    mapRenderPixelRatio: 1,
    jpegQuality: 76,
    ffmpegCrf: 22,
    ffmpegPreset: 'superfast',
  },
  high: {
    key: 'high',
    label: 'Alta calidad',
    description: '1080x1920, 25 fps, máximo detalle',
    outputWidth: 1080,
    outputHeight: 1920,
    renderWidth: 540,
    renderHeight: 960,
    outputFps: 25,
    mapRenderPixelRatio: 1,
    jpegQuality: 82,
    ffmpegCrf: 20,
    ffmpegPreset: 'veryfast',
  },
};

export function isRouteVideoExportPreset(value: unknown): value is RouteVideoExportPreset {
  return value === 'fast' || value === 'high';
}

export function resolveRouteVideoExportPresetConfig(
  preset: RouteVideoExportPreset | null | undefined,
): RouteVideoExportPresetConfig {
  return routeVideoExportPresetConfigs[preset ?? DEFAULT_ROUTE_VIDEO_EXPORT_PRESET];
}
