/**
 * Shared map visual configuration
 * Source of truth for all map rendering (web + video)
 * Matches ActivityRouteMap.tsx exactly
 */

// Tile URLs (ArcGIS services)
export const SATELLITE_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const HILLSHADE_TILE_URL =
  'https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}';
export const LABELS_TILE_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

// Pace thresholds (passed through route to compute color)
export const PACE_COLORS = {
  fast: '#df3e3e',     // red
  medium: '#f2a43c',   // orange
  slow: '#5daeff',     // blue
  default: '#7fc5ff',  // light blue (fallback)
};

// Route line rendering
export const ROUTE_LINE_STYLES = {
  glow: {
    width: 14,
    opacity: 0.28,
  },
  shadow: {
    width: 12,
    opacity: 0.75,
    color: 'rgba(10, 16, 24, 0.74)',
  },
  main: {
    width: 6,
    opacity: 0.96,
  },
};

// Route markers
export const ROUTE_MARKERS = {
  start: {
    radius: 7,
    color: '#ffffff',
  },
  finish: {
    radius: 7,
    color: '#ff6d6d',
  },
};

// Map layer opacities
export const MAP_LAYER_OPACITIES = {
  satellite: 1.0,
  hillshade: 0.46,
  labels: 0.22,
};

// Canvas filters to replicate CSS filters from ActivityRouteMap.tsx
// These must be applied via canvas context in order: satellite -> hillshade -> labels
export const MAP_LAYER_FILTERS = {
  satellite: 'saturate(0.72) brightness(0.78) contrast(1.16) hue-rotate(-4deg)',
  hillshade: 'grayscale(0.12) contrast(1.7) brightness(0.72)',
  labels: 'grayscale(0.18) brightness(1.04) contrast(1.10)',
};

// Tile size (standard OSM/ArcGIS tile)
export const TILE_SIZE = 256;

// Default tiling zoom for video rendering
// Higher zoom = more detail, but more tiles to fetch
export const VIDEO_TILE_ZOOM = 14;

// Video layout dimensions (720x1280 vertical format)
export const VIDEO_LAYOUT = {
  canvasWidth: 720,
  canvasHeight: 1280,
  outerPadding: 36,
  header: {
    x: 36,
    y: 42,
    w: 648,
    h: 96,
  },
  mapCard: {
    x: 52,
    y: 234,
    w: 616,
    h: 726,
    r: 22,
  },
  metricsCard: {
    x: 52,
    y: 980,
    w: 616,
    h: 284,
    r: 22,
  },
};

// Video phase timing
export const VIDEO_PHASES = {
  overview: { start: 0.0, end: 0.16 },      // 16% - full route visible
  transition: { start: 0.16, end: 0.30 },   // 14% - smooth camera move
  followCam: { start: 0.30, end: 1.0 },     // 70% - runner cam follow
};

// Camera anchor points (in map card coordinate space)
export const CAMERA_ANCHOR = {
  followX: 0.5,    // 50% of card width
  followY: 0.64,   // 64% of card height
};
