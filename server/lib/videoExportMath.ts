import type { ActivityRouteSampleData } from './activityRoutes.ts';
import type { RouteVideoBounds, RouteVideoPayload } from './videoExportTypes.ts';

export type DenseRouteVideoPoint = {
  lat: number;
  lng: number;
  timestampSeconds: number;
  paceSecondsPerKm: number | null;
  distanceMeters: number;
};

export type RouteVideoTimeline = {
  overviewSeconds: number;
  descentSeconds: number;
  followSeconds: number;
  finishHoldSeconds: number;
  totalSeconds: number;
};

type RouteDistancePoint = RouteVideoPayload['points'][number];

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function lerpNumber(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}

export function easeOutCubic(amount: number) {
  const clamped = clampNumber(amount, 0, 1);
  return 1 - (1 - clamped) ** 3;
}

export function easeInOutCubic(amount: number) {
  const clamped = clampNumber(amount, 0, 1);
  return clamped < 0.5 ? 4 * clamped ** 3 : 1 - ((-2 * clamped + 2) ** 3) / 2;
}

export function distanceBetweenGeoPointsMeters(
  start: { lat: number; lng: number },
  end: { lat: number; lng: number },
) {
  const earthRadiusMeters = 6_371_000;
  const latDelta = ((end.lat - start.lat) * Math.PI) / 180;
  const lngDelta = ((end.lng - start.lng) * Math.PI) / 180;
  const startLat = (start.lat * Math.PI) / 180;
  const endLat = (end.lat * Math.PI) / 180;
  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(lngDelta / 2) ** 2;

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function routeMedianPace(samples: ActivityRouteSampleData[]) {
  const paces = samples
    .map((sample) => sample.paceSecondsPerKm)
    .filter((pace): pace is number => typeof pace === 'number' && Number.isFinite(pace) && pace > 0)
    .sort((left, right) => left - right);

  if (!paces.length) {
    return null;
  }

  return paces[Math.floor(paces.length / 2)] ?? null;
}

function buildTimedSourcePoints(samples: ActivityRouteSampleData[]) {
  if (samples.length < 2) {
    return [];
  }

  const medianPaceSecondsPerKm = routeMedianPace(samples) ?? 360;
  const timedPoints: Array<{
    lat: number;
    lng: number;
    paceSecondsPerKm: number | null;
    distanceMeters: number;
    timestampSeconds: number;
  }> = [];

  let cumulativeDistanceMeters = 0;
  let cumulativeElapsedSeconds = 0;

  samples.forEach((sample, index) => {
    if (index > 0) {
      const previousSample = samples[index - 1]!;
      const segmentDistanceMeters = distanceBetweenGeoPointsMeters(
        { lat: previousSample.point[0], lng: previousSample.point[1] },
        { lat: sample.point[0], lng: sample.point[1] },
      );
      cumulativeDistanceMeters += segmentDistanceMeters;

      const timestampDurationSeconds =
        sample.timestampSeconds !== null &&
        previousSample.timestampSeconds !== null &&
        sample.timestampSeconds > previousSample.timestampSeconds
          ? sample.timestampSeconds - previousSample.timestampSeconds
          : null;
      const paceCandidateSecondsPerKm =
        sample.paceSecondsPerKm ?? previousSample.paceSecondsPerKm ?? medianPaceSecondsPerKm;
      const paceDurationSeconds =
        paceCandidateSecondsPerKm && segmentDistanceMeters > 0
          ? paceCandidateSecondsPerKm * (segmentDistanceMeters / 1000)
          : null;
      let segmentElapsedSeconds =
        timestampDurationSeconds ?? paceDurationSeconds ?? (segmentDistanceMeters / 1000) * medianPaceSecondsPerKm;

      if (
        timestampDurationSeconds !== null &&
        paceDurationSeconds !== null &&
        timestampDurationSeconds > paceDurationSeconds * 3
      ) {
        segmentElapsedSeconds = paceDurationSeconds;
      }

      cumulativeElapsedSeconds += Math.max(segmentElapsedSeconds, 0.35);
    }

    timedPoints.push({
      lat: sample.point[0],
      lng: sample.point[1],
      paceSecondsPerKm: sample.paceSecondsPerKm,
      distanceMeters: cumulativeDistanceMeters,
      timestampSeconds: cumulativeElapsedSeconds,
    });
  });

  return timedPoints;
}

export function densifyRouteVideoSamples(
  samples: ActivityRouteSampleData[],
  stepMeters = 8,
): DenseRouteVideoPoint[] {
  const timedPoints = buildTimedSourcePoints(samples);
  if (timedPoints.length < 2) {
    return [];
  }

  const densePoints: DenseRouteVideoPoint[] = [];

  timedPoints.forEach((point, index) => {
    if (index === 0) {
      densePoints.push({
        lat: point.lat,
        lng: point.lng,
        timestampSeconds: point.timestampSeconds,
        paceSecondsPerKm: point.paceSecondsPerKm,
        distanceMeters: point.distanceMeters,
      });
      return;
    }

    const previous = timedPoints[index - 1]!;
    const segmentDistanceMeters = Math.max(point.distanceMeters - previous.distanceMeters, 0);
    const segments = Math.max(1, Math.ceil(segmentDistanceMeters / Math.max(stepMeters, 1)));

    for (let segmentIndex = 1; segmentIndex <= segments; segmentIndex += 1) {
      const ratio = segmentIndex / segments;
      const paceSecondsPerKm =
        previous.paceSecondsPerKm !== null && point.paceSecondsPerKm !== null
          ? lerpNumber(previous.paceSecondsPerKm, point.paceSecondsPerKm, ratio)
          : point.paceSecondsPerKm ?? previous.paceSecondsPerKm;

      densePoints.push({
        lat: lerpNumber(previous.lat, point.lat, ratio),
        lng: lerpNumber(previous.lng, point.lng, ratio),
        timestampSeconds: lerpNumber(previous.timestampSeconds, point.timestampSeconds, ratio),
        paceSecondsPerKm,
        distanceMeters: lerpNumber(previous.distanceMeters, point.distanceMeters, ratio),
      });
    }
  });

  const lastPoint = timedPoints.at(-1)!;
  const denseLastPoint = densePoints.at(-1);
  if (!denseLastPoint || denseLastPoint.lat !== lastPoint.lat || denseLastPoint.lng !== lastPoint.lng) {
    densePoints.push({
      lat: lastPoint.lat,
      lng: lastPoint.lng,
      timestampSeconds: lastPoint.timestampSeconds,
      paceSecondsPerKm: lastPoint.paceSecondsPerKm,
      distanceMeters: lastPoint.distanceMeters,
    });
  }

  return densePoints;
}

export function buildRouteVideoBounds(points: Array<{ lat: number; lng: number }>): RouteVideoBounds {
  const latitudes = points.map((point) => point.lat);
  const longitudes = points.map((point) => point.lng);

  return {
    minLat: Math.min(...latitudes),
    minLng: Math.min(...longitudes),
    maxLat: Math.max(...latitudes),
    maxLng: Math.max(...longitudes),
  };
}

export function calculateRouteVideoDurationSeconds(distanceKm: number) {
  return clampNumber(7 + distanceKm * 1.45, 11.5, 44);
}

export function calculateRouteVideoRenderFps(durationSeconds: number) {
  if (durationSeconds >= 34) {
    return 12;
  }

  if (durationSeconds >= 20) {
    return 15;
  }

  return 18;
}

export function estimateRouteVideoRenderMetrics(distanceKm: number, outputFps = 25) {
  const timeline = createRouteVideoTimeline(distanceKm);
  const renderFps = Math.max(Math.round(Math.max(outputFps, 1)), calculateRouteVideoRenderFps(timeline.totalSeconds));
  const captureFrames = Math.max(2, Math.round(timeline.totalSeconds * renderFps));
  const totalFrames = Math.max(2, Math.round(timeline.totalSeconds * Math.max(outputFps, 1)));

  return {
    captureFrames,
    totalFrames,
    durationSeconds: timeline.totalSeconds,
    renderFps,
  };
}

export function createRouteVideoTimeline(distanceKm: number): RouteVideoTimeline {
  const overviewSeconds = 1.35;
  const descentSeconds = 1.75;
  const followSeconds = calculateRouteVideoDurationSeconds(distanceKm);
  const finishHoldSeconds = 1.45;
  const totalSeconds = overviewSeconds + descentSeconds + followSeconds + finishHoldSeconds;

  return {
    overviewSeconds,
    descentSeconds,
    followSeconds,
    finishHoldSeconds,
    totalSeconds,
  };
}

export function routeProgressAtElapsedSeconds(timeline: RouteVideoTimeline, elapsedSeconds: number) {
  const clampedElapsed = clampNumber(elapsedSeconds, 0, timeline.totalSeconds);
  const followStart = timeline.overviewSeconds + timeline.descentSeconds;
  const followEnd = followStart + timeline.followSeconds;

  if (clampedElapsed <= followStart) {
    return 0;
  }

  if (clampedElapsed >= followEnd) {
    return 1;
  }

  return (clampedElapsed - followStart) / timeline.followSeconds;
}

export function findRoutePointIndexByDistance(
  points: Array<{ distanceMeters: number }>,
  targetDistanceMeters: number,
) {
  if (!points.length) {
    return 0;
  }

  let left = 0;
  let right = points.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if ((points[mid]?.distanceMeters ?? 0) < targetDistanceMeters) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  return left;
}

export function toMapLibreLngLat(point: { lat: number; lng: number }): [number, number] {
  return [point.lng, point.lat];
}

export function calculateRouteBearingDegrees(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
) {
  const dx = to.lng - from.lng;
  const dy = to.lat - from.lat;
  const angle = (Math.atan2(dx, dy) * 180) / Math.PI;
  return (angle + 360) % 360;
}

export function interpolateRouteVideoPointByDistance(
  points: RouteDistancePoint[],
  targetDistanceMeters: number,
): RouteDistancePoint {
  if (!points.length) {
    return {
      lat: 0,
      lng: 0,
      elevationMeters: 0,
      timestampSeconds: 0,
      paceSecondsPerKm: null,
      distanceMeters: 0,
    };
  }

  const totalDistanceMeters = points.at(-1)?.distanceMeters ?? 0;
  const clampedDistanceMeters = clampNumber(targetDistanceMeters, 0, totalDistanceMeters);
  const rightIndex = findRoutePointIndexByDistance(points, clampedDistanceMeters);
  const endPoint = points[Math.min(rightIndex, points.length - 1)]!;
  const startPoint = points[Math.max(0, rightIndex - 1)] ?? endPoint;
  const span = Math.max(endPoint.distanceMeters - startPoint.distanceMeters, 0.0001);
  const ratio = clampNumber((clampedDistanceMeters - startPoint.distanceMeters) / span, 0, 1);
  const paceSecondsPerKm =
    startPoint.paceSecondsPerKm !== null && endPoint.paceSecondsPerKm !== null
      ? lerpNumber(startPoint.paceSecondsPerKm, endPoint.paceSecondsPerKm, ratio)
      : endPoint.paceSecondsPerKm ?? startPoint.paceSecondsPerKm;

  return {
    lat: lerpNumber(startPoint.lat, endPoint.lat, ratio),
    lng: lerpNumber(startPoint.lng, endPoint.lng, ratio),
    elevationMeters: lerpNumber(startPoint.elevationMeters, endPoint.elevationMeters, ratio),
    timestampSeconds: lerpNumber(startPoint.timestampSeconds, endPoint.timestampSeconds, ratio),
    distanceMeters: lerpNumber(startPoint.distanceMeters, endPoint.distanceMeters, ratio),
    paceSecondsPerKm,
  };
}

export function calculateSmoothedRouteVideoBearingDegrees(
  points: RouteDistancePoint[],
  currentDistanceMeters: number,
  behindMeters: number,
  aheadMeters: number,
) {
  if (points.length < 2) {
    return 0;
  }

  const totalDistanceMeters = points.at(-1)?.distanceMeters ?? 0;
  const behindPoint = interpolateRouteVideoPointByDistance(points, currentDistanceMeters - behindMeters);
  const aheadPoint = interpolateRouteVideoPointByDistance(
    points,
    Math.min(totalDistanceMeters, currentDistanceMeters + aheadMeters),
  );

  if (distanceBetweenGeoPointsMeters(behindPoint, aheadPoint) < 1) {
    const fallbackAheadPoint = interpolateRouteVideoPointByDistance(
      points,
      Math.min(totalDistanceMeters, currentDistanceMeters + Math.max(aheadMeters * 0.35, 1)),
    );
    return calculateRouteBearingDegrees(behindPoint, fallbackAheadPoint);
  }

  return calculateRouteBearingDegrees(behindPoint, aheadPoint);
}

export function buildRouteVideoPayloadMetrics(payload: RouteVideoPayload) {
  return {
    totalDistanceKm: payload.totalDistanceKm,
    totalElapsedSeconds: payload.totalElapsedSeconds,
    totalPoints: payload.points.length,
  };
}
