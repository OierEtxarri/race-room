export type RouteVideoPoint = {
  lat: number;
  lng: number;
  elevationMeters: number;
  timestampSeconds: number;
  paceSecondsPerKm: number | null;
  distanceMeters: number;
};

export type RouteVideoBounds = {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
};

export type RouteVideoPayload = {
  activityId: number;
  source: 'garmin' | 'strava';
  bounds: RouteVideoBounds;
  points: RouteVideoPoint[];
  totalDistanceKm: number;
  totalElapsedSeconds: number;
};

export type RouteVideoRenderSummary = {
  title: string;
  date: string;
  timeLabel: string | null;
  activityLabel: string;
  providerLabel: string;
  athleteName: string;
  distanceKm: number;
  durationSeconds: number;
  paceSecondsPerKm: number | null;
  elevationGain: number | null;
};

export type RouteVideoExportPreset = 'fast' | 'high';

export type RouteVideoExportRequest = {
  summary: RouteVideoRenderSummary;
  preset: RouteVideoExportPreset;
};

export type RouteVideoExportJobStatus = 'queued' | 'rendering' | 'done' | 'error';

export type RouteVideoExportJob = {
  id: string;
  sessionId: string;
  activityId: number;
  preset: RouteVideoExportPreset;
  status: RouteVideoExportJobStatus;
  createdAt: string;
  updatedAt: string;
  progress: number;
  message: string;
  summary: RouteVideoRenderSummary;
  outputFilename: string | null;
  downloadUrl: string | null;
  error: string | null;
  metrics: {
    totalFrames: number | null;
    durationSeconds: number | null;
  };
};

export type RouteVideoRenderResult = {
  filePath: string;
  outputFilename: string;
  totalFrames: number;
  durationSeconds: number;
};
