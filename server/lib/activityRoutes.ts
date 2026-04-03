import { garminClient } from './garminClient.ts';
import type { GarminSessionAuth } from './garminMcpClient.ts';
import { getStravaActivity } from './stravaClient.ts';
import type { StravaSessionRecord } from './sessionStore.ts';

type LatLngTuple = [number, number];

export type ActivityRouteSampleData = {
  point: LatLngTuple;
  paceSecondsPerKm: number | null;
  timestampSeconds: number | null;
};

export type ActivityRouteData = {
  points: LatLngTuple[];
  samples: ActivityRouteSampleData[];
  source: 'garmin' | 'strava';
};

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function decodePolyline(encoded: string): LatLngTuple[] {
  let index = 0;
  let lat = 0;
  let lng = 0;
  const points: LatLngTuple[] = [];

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length + 1);

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    result = 0;
    shift = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length + 1);

    const deltaLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    points.push([lat / 1e5, lng / 1e5]);
  }

  return points;
}

function normalizePoints(points: LatLngTuple[]): LatLngTuple[] {
  const filtered = points.filter(
    (point, index) =>
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1]) &&
      (index === 0 || point[0] !== points[index - 1]?.[0] || point[1] !== points[index - 1]?.[1]),
  );

  if (filtered.length <= 180) {
    return filtered;
  }

  const step = Math.ceil(filtered.length / 180);
  return filtered.filter((_, index) => index % step === 0 || index === filtered.length - 1);
}

function toPaceFromSpeed(speedMetersPerSecond: number | null): number | null {
  if (speedMetersPerSecond === null || speedMetersPerSecond <= 0) {
    return null;
  }

  return 1000 / speedMetersPerSecond;
}

function sampleFromObject(source: unknown): ActivityRouteSampleData | null {
  if (!source || typeof source !== 'object') {
    return null;
  }

  const record = source as Record<string, unknown>;
  const position =
    (record.position && typeof record.position === 'object' ? (record.position as Record<string, unknown>) : null) ??
    (record.location && typeof record.location === 'object' ? (record.location as Record<string, unknown>) : null);

  const lat =
    toNumber(record.latitude) ??
    toNumber(record.lat) ??
    toNumber(record.directLatitude) ??
    toNumber(record.startLatitude) ??
    toNumber(position?.latitude) ??
    toNumber(position?.lat);
  const lng =
    toNumber(record.longitude) ??
    toNumber(record.lon) ??
    toNumber(record.lng) ??
    toNumber(record.directLongitude) ??
    toNumber(record.startLongitude) ??
    toNumber(position?.longitude) ??
    toNumber(position?.lng) ??
    toNumber(position?.lon);

  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }

  const explicitPace =
    toNumber(record.paceSecondsPerKm) ??
    toNumber(record.paceInSecondsPerKilometer) ??
    toNumber(record.averagePaceInSecondsPerKilometer) ??
    toNumber(record.speedPaceSecondsPerKilometer);
  const derivedPace = explicitPace ?? toPaceFromSpeed(
    toNumber(record.speed) ??
      toNumber(record.velocity) ??
      toNumber(record.velocity_smooth) ??
      toNumber(record.speedMetersPerSecond) ??
      toNumber(record.enhancedSpeed),
  );
  const timestampSeconds =
    toNumber(record.timestampSeconds) ??
    toNumber(record.timerDurationInSeconds) ??
    toNumber(record.sumDurationInSeconds) ??
    toNumber(record.elapsedDurationInSeconds) ??
    toNumber(record.elapsedDuration) ??
    toNumber(record.time);

  return {
    point: [lat, lng],
    paceSecondsPerKm: derivedPace,
    timestampSeconds,
  };
}

function normalizeSamples(samples: ActivityRouteSampleData[]): ActivityRouteSampleData[] {
  const filtered = samples.filter(
    (sample, index) =>
      Number.isFinite(sample.point[0]) &&
      Number.isFinite(sample.point[1]) &&
      (index === 0 ||
        sample.point[0] !== samples[index - 1]?.point[0] ||
        sample.point[1] !== samples[index - 1]?.point[1]),
  );

  if (filtered.length <= 220) {
    return filtered;
  }

  const step = Math.ceil(filtered.length / 220);
  return filtered.filter((_, index) => index % step === 0 || index === filtered.length - 1);
}

function collectOrderedSampleCandidates(source: unknown, maxDepth = 8): ActivityRouteSampleData[] {
  const seen = new Set<unknown>();
  let best: ActivityRouteSampleData[] = [];
  let bestScore = -1;

  function considerArray(value: unknown[]): void {
    const samples = value.map(sampleFromObject).filter((sample): sample is ActivityRouteSampleData => sample !== null);

    if (samples.length < 2) {
      return;
    }

    const paceCount = samples.filter((sample) => sample.paceSecondsPerKm !== null).length;
    const timestampCount = samples.filter((sample) => sample.timestampSeconds !== null).length;
    const score = samples.length + paceCount * 8 + timestampCount * 3;

    if (score > bestScore) {
      best = normalizeSamples(samples);
      bestScore = score;
    }
  }

  function walk(value: unknown, depth: number): void {
    if (depth > maxDepth || value === null || typeof value !== 'object' || seen.has(value)) {
      return;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      considerArray(value);
      value.forEach((item) => walk(item, depth + 1));
      return;
    }

    Object.values(value as Record<string, unknown>).forEach((nestedValue) => walk(nestedValue, depth + 1));
  }

  walk(source, 0);
  return best;
}

function collectPolylineCandidates(source: unknown, maxDepth = 8): string[] {
  const seen = new Set<unknown>();
  const candidates: string[] = [];

  function walk(value: unknown, depth: number): void {
    if (depth > maxDepth || value === null || typeof value !== 'object' || seen.has(value)) {
      return;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, depth + 1));
      return;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      if (typeof nestedValue === 'string' && key.toLowerCase().includes('polyline') && nestedValue.length > 10) {
        candidates.push(nestedValue);
      }

      walk(nestedValue, depth + 1);
    }
  }

  walk(source, 0);
  return candidates.sort((left, right) => right.length - left.length);
}

function collectCoordinatePairs(source: unknown, maxDepth = 8): LatLngTuple[] {
  const seen = new Set<unknown>();
  const points: LatLngTuple[] = [];

  function walk(value: unknown, depth: number): void {
    if (depth > maxDepth || value === null || typeof value !== 'object' || seen.has(value)) {
      return;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    const lat =
      toNumber(record.latitude) ??
      toNumber(record.lat) ??
      toNumber(record.startLatitude) ??
      toNumber(record.start_latitude);
    const lng =
      toNumber(record.longitude) ??
      toNumber(record.lon) ??
      toNumber(record.lng) ??
      toNumber(record.startLongitude) ??
      toNumber(record.start_longitude);

    if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      points.push([lat, lng]);
    }

    for (const nestedValue of Object.values(record)) {
      walk(nestedValue, depth + 1);
    }
  }

  walk(source, 0);
  return points;
}

function extractRoutePoints(source: unknown): LatLngTuple[] {
  for (const encoded of collectPolylineCandidates(source)) {
    try {
      const decoded = decodePolyline(encoded);
      if (decoded.length >= 2) {
        return normalizePoints(decoded);
      }
    } catch {
      // Ignore malformed candidates and continue scanning.
    }
  }

  const coordinatePairs = collectCoordinatePairs(source);
  return coordinatePairs.length >= 2 ? normalizePoints(coordinatePairs) : [];
}

function routeDataFromSamples(samples: ActivityRouteSampleData[], source: 'garmin' | 'strava'): ActivityRouteData {
  return {
    points: samples.map((sample) => sample.point),
    samples,
    source,
  };
}

export async function getGarminActivityRoute(
  auth: GarminSessionAuth,
  activityId: number,
): Promise<ActivityRouteData> {
  const details = await garminClient.callJson(auth, 'get_activity_details', { activityId });
  const orderedSamples = collectOrderedSampleCandidates(details);

  if (orderedSamples.length >= 2) {
    return routeDataFromSamples(orderedSamples, 'garmin');
  }

  const points = extractRoutePoints(details);

  if (points.length < 2) {
    throw new Error('Garmin no ha devuelto una ruta utilizable para este entrenamiento.');
  }

  return {
    points,
    samples: points.map((point) => ({
      point,
      paceSecondsPerKm: null,
      timestampSeconds: null,
    })),
    source: 'garmin',
  };
}

type StravaStreamsResponse = {
  latlng?: { data?: Array<[number, number]> };
  velocity_smooth?: { data?: number[] };
  time?: { data?: number[] };
};

export async function getStravaActivityRoute(
  session: StravaSessionRecord,
  activityId: number,
): Promise<ActivityRouteData> {
  try {
    const streams = await getStravaActivity(session, activityId, {
      endpoint: 'streams',
      search: new URLSearchParams({
        keys: 'latlng,velocity_smooth,time',
        key_by_type: 'true',
      }),
    }) as StravaStreamsResponse;
    const latlng = Array.isArray(streams.latlng?.data) ? streams.latlng.data : [];
    const velocities = Array.isArray(streams.velocity_smooth?.data) ? streams.velocity_smooth.data : [];
    const times = Array.isArray(streams.time?.data) ? streams.time.data : [];
    const samples = normalizeSamples(
      latlng.map((point, index) => ({
        point,
        paceSecondsPerKm: toPaceFromSpeed(toNumber(velocities[index])),
        timestampSeconds: toNumber(times[index]),
      })),
    );

    if (samples.length >= 2) {
      return routeDataFromSamples(samples, 'strava');
    }
  } catch {
    // Fall back to polyline extraction below.
  }

  const activity = await getStravaActivity(session, activityId);
  const points = extractRoutePoints(activity);

  if (points.length < 2) {
    throw new Error('Strava no ha devuelto una ruta utilizable para este entrenamiento.');
  }

  return {
    points,
    samples: points.map((point) => ({
      point,
      paceSecondsPerKm: null,
      timestampSeconds: null,
    })),
    source: 'strava',
  };
}
