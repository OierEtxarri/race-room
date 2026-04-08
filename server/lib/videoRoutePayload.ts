import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getGarminActivityRouteForVideo,
  getStravaActivityRouteForVideo,
  type ActivityRouteSampleData,
} from './activityRoutes.ts';
import type { SessionRecord } from './sessionStore.ts';
import { isGarminSession } from './sessionStore.ts';
import { populateTerrainElevations } from './videoTerrain.ts';
import { config } from '../config.ts';
import {
  buildRouteVideoBounds,
  densifyRouteVideoSamples,
} from './videoExportMath.ts';
import type { RouteVideoPayload } from './videoExportTypes.ts';
import type { GarminSessionAuth } from './garminMcpClient.ts';

const routePayloadCacheDir = path.join(config.rootDir, 'data', 'video-route-cache');

function sessionToGarminAuth(session: Extract<SessionRecord, { provider: 'garmin' }>): GarminSessionAuth {
  return {
    id: session.id,
    garminEmail: session.garminEmail,
    garminPassword: session.garminPassword,
    homeDir: session.homeDir,
    tokenDirs: session.tokenDirs,
  };
}

function cachePathForActivity(source: 'garmin' | 'strava', activityId: number) {
  return path.join(routePayloadCacheDir, `${source}-${activityId}.json`);
}

function normalizeVideoSamples(
  rawSamples: ActivityRouteSampleData[],
  rawPoints: Array<[number, number]>,
) {
  if (rawSamples.length >= 2) {
    return rawSamples;
  }

  return rawPoints.map((point) => ({
    point,
    paceSecondsPerKm: null,
    timestampSeconds: null,
  }));
}

export async function buildRouteVideoPayload(
  session: SessionRecord,
  activityId: number,
): Promise<RouteVideoPayload> {
  const source = session.provider;
  const filePath = cachePathForActivity(source, activityId);

  try {
    const cached = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(cached) as RouteVideoPayload;
    if (Array.isArray(parsed.points) && parsed.points.length >= 2) {
      return parsed;
    }
  } catch {
    // Rebuild when the cache is missing or invalid.
  }

  const route = isGarminSession(session)
    ? await getGarminActivityRouteForVideo(sessionToGarminAuth(session), activityId)
    : await getStravaActivityRouteForVideo(session, activityId);
  const sourceSamples = normalizeVideoSamples(route.samples, route.points);
  const densePoints = densifyRouteVideoSamples(sourceSamples, 8);

  if (densePoints.length < 2) {
    throw new Error('La actividad no tiene suficientes puntos para generar el vídeo.');
  }

  const elevations = await populateTerrainElevations(densePoints);
  const payload: RouteVideoPayload = {
    activityId,
    source,
    bounds: buildRouteVideoBounds(densePoints),
    points: densePoints.map((point, index) => ({
      lat: point.lat,
      lng: point.lng,
      elevationMeters: elevations[index] ?? 0,
      timestampSeconds: point.timestampSeconds,
      paceSecondsPerKm: point.paceSecondsPerKm,
      distanceMeters: point.distanceMeters,
    })),
    totalDistanceKm: (densePoints.at(-1)?.distanceMeters ?? 0) / 1000,
    totalElapsedSeconds: densePoints.at(-1)?.timestampSeconds ?? 0,
  };

  await fs.mkdir(routePayloadCacheDir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload));
  return payload;
}
