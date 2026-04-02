import { garminClient } from './garminClient.ts';
import type { GarminSessionAuth } from './garminMcpClient.ts';
import { getStravaActivity } from './stravaClient.ts';
import type { StravaSessionRecord } from './sessionStore.ts';

type LatLngTuple = [number, number];

export type ActivityRouteData = {
  points: LatLngTuple[];
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

export async function getGarminActivityRoute(
  auth: GarminSessionAuth,
  activityId: number,
): Promise<ActivityRouteData> {
  const details = await garminClient.callJson(auth, 'get_activity_details', { activityId });
  const points = extractRoutePoints(details);

  if (points.length < 2) {
    throw new Error('Garmin no ha devuelto una ruta utilizable para este entrenamiento.');
  }

  return {
    points,
    source: 'garmin',
  };
}

export async function getStravaActivityRoute(
  session: StravaSessionRecord,
  activityId: number,
): Promise<ActivityRouteData> {
  const activity = await getStravaActivity(session, activityId);
  const points = extractRoutePoints(activity);

  if (points.length < 2) {
    throw new Error('Strava no ha devuelto una ruta utilizable para este entrenamiento.');
  }

  return {
    points,
    source: 'strava',
  };
}
