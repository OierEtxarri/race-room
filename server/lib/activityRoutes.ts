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

function parseDurationString(value: string): number | null {
  const normalized = value.trim();
  if (!normalized || normalized.includes('T') || normalized.includes('-') || normalized.includes('Z')) {
    return null;
  }

  const stripped = normalized
    .replace(/\s*(?:min\/km|min\/mi|min\/mile|s\/km|s\/mi|\/km|\/mi|km\/h|kph|mph)\s*$/i, '')
    .replace(/\s+/g, '');

  if (!/^\d{1,3}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(stripped)) {
    return null;
  }

  const parts = stripped.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return minutes * 60 + seconds;
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }

  return null;
}

function parseSecondsLike(value: unknown): number | null {
  const numeric = toNumber(value);
  if (numeric !== null) {
    return numeric;
  }

  if (typeof value !== 'string') {
    return null;
  }

  return parseDurationString(value);
}

function parseTimestampSeconds(value: unknown): number | null {
  const numeric = toNumber(value);
  if (numeric !== null) {
    return numeric > 100_000_000_000 ? numeric / 1000 : numeric;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const parsedNumeric = Number(value);
  if (Number.isFinite(parsedNumeric)) {
    return parsedNumeric > 100_000_000_000 ? parsedNumeric / 1000 : parsedNumeric;
  }

  const parsedDate = Date.parse(value);
  return Number.isFinite(parsedDate) ? parsedDate / 1000 : null;
}

function distanceBetweenGeoPointsKm(start: LatLngTuple, end: LatLngTuple) {
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
    parseSecondsLike(record.paceSecondsPerKm) ??
    parseSecondsLike(record.paceInSecondsPerKilometer) ??
    parseSecondsLike(record.averagePaceInSecondsPerKilometer) ??
    parseSecondsLike(record.averagePaceSecondsPerKilometer) ??
    parseSecondsLike(record.avgPaceSecondsPerKm) ??
    parseSecondsLike(record.avgPaceSecondsPerKilometer) ??
    parseSecondsLike(record.averagePace) ??
    parseSecondsLike(record.avgPace) ??
    parseSecondsLike(record.pace) ??
    parseSecondsLike(record.currentPace) ??
    parseSecondsLike(record.movingPace) ??
    parseSecondsLike(record.speedPaceSecondsPerKilometer);
  const distanceMeters =
    toNumber(record.distanceMeters) ??
    toNumber(record.distanceInMeters) ??
    toNumber(record.sumDistanceMeters) ??
    toNumber(record.totalDistanceMeters) ??
    toNumber(record.distance);
  const durationSeconds =
    parseSecondsLike(record.timerDurationInSeconds) ??
    parseSecondsLike(record.sumDurationInSeconds) ??
    parseSecondsLike(record.elapsedDurationInSeconds) ??
    parseSecondsLike(record.elapsedDuration) ??
    parseSecondsLike(record.movingDurationInSeconds) ??
    parseSecondsLike(record.movingDuration) ??
    parseSecondsLike(record.durationInSeconds) ??
    parseSecondsLike(record.duration);
  const derivedPace = explicitPace ?? toPaceFromSpeed(
    toNumber(record.speed) ??
      toNumber(record.velocity) ??
      toNumber(record.velocity_smooth) ??
      toNumber(record.speedMetersPerSecond) ??
      toNumber(record.enhancedSpeed) ??
      toNumber(record.averageSpeed) ??
      toNumber(record.avgSpeed) ??
      toNumber(record.currentSpeed),
  ) ?? (distanceMeters !== null && durationSeconds !== null && distanceMeters > 0
    ? durationSeconds / (distanceMeters / 1000)
    : null);
  const timestampSeconds =
    parseTimestampSeconds(record.timestampSeconds) ??
    parseTimestampSeconds(record.time) ??
    durationSeconds;

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

type RouteSplitSample = {
  order: number | null;
  distanceMeters: number | null;
  cumulativeDistanceMeters: number | null;
  durationSeconds: number | null;
  cumulativeDurationSeconds: number | null;
  paceSecondsPerKm: number | null;
};

function splitSampleFromObject(source: unknown): RouteSplitSample | null {
  if (!source || typeof source !== 'object') {
    return null;
  }

  const record = source as Record<string, unknown>;
  const order =
    toNumber(record.splitIndex) ??
    toNumber(record.splitNumber) ??
    toNumber(record.splitNumberIndex) ??
    toNumber(record.lapIndex) ??
    toNumber(record.index) ??
    toNumber(record.sequence) ??
    toNumber(record.order);
  const distanceMeters =
    toNumber(record.distanceMeters) ??
    toNumber(record.distanceInMeters) ??
    toNumber(record.splitDistanceMeters) ??
    toNumber(record.splitDistanceInMeters) ??
    toNumber(record.splitDistance) ??
    toNumber(record.distance);
  const cumulativeDistanceMeters =
    toNumber(record.cumulativeDistanceMeters) ??
    toNumber(record.cumulativeDistanceInMeters) ??
    toNumber(record.totalDistanceMeters) ??
    toNumber(record.totalDistanceInMeters) ??
    toNumber(record.sumDistanceMeters) ??
    toNumber(record.sumDistanceInMeters);
  const durationSeconds =
    parseSecondsLike(record.elapsedTime) ??
    parseSecondsLike(record.elapsedDuration) ??
    parseSecondsLike(record.elapsedDurationInSeconds) ??
    parseSecondsLike(record.elapsedDurationInSecs) ??
    parseSecondsLike(record.duration) ??
    parseSecondsLike(record.durationSeconds) ??
    parseSecondsLike(record.movingTime) ??
    parseSecondsLike(record.movingDuration) ??
    parseSecondsLike(record.movingDurationInSeconds) ??
    parseSecondsLike(record.time);
  const cumulativeDurationSeconds =
    parseSecondsLike(record.cumulativeElapsedSeconds) ??
    parseSecondsLike(record.cumulativeDurationSeconds) ??
    parseSecondsLike(record.totalElapsedSeconds) ??
    parseSecondsLike(record.totalDurationSeconds) ??
    parseSecondsLike(record.elapsedDurationSeconds) ??
    parseSecondsLike(record.timerDurationInSeconds) ??
    parseSecondsLike(record.timerDuration) ??
    parseSecondsLike(record.sumDurationInSeconds) ??
    parseSecondsLike(record.sumDurationSeconds);
  const paceSecondsPerKm =
    parseSecondsLike(record.paceSecondsPerKm) ??
    parseSecondsLike(record.paceInSecondsPerKilometer) ??
    parseSecondsLike(record.averagePaceInSecondsPerKilometer) ??
    parseSecondsLike(record.averagePaceSecondsPerKilometer) ??
    parseSecondsLike(record.avgPaceSecondsPerKm) ??
    parseSecondsLike(record.avgPaceSecondsPerKilometer) ??
    parseSecondsLike(record.averagePace) ??
    parseSecondsLike(record.avgPace) ??
    parseSecondsLike(record.pace) ??
    parseSecondsLike(record.splitPace) ??
    parseSecondsLike(record.currentPace) ??
    parseSecondsLike(record.movingPace) ??
    (distanceMeters !== null && distanceMeters > 0 && durationSeconds !== null
      ? durationSeconds / (distanceMeters / 1000)
      : null);

  if (
    order === null &&
    distanceMeters === null &&
    cumulativeDistanceMeters === null &&
    durationSeconds === null &&
    cumulativeDurationSeconds === null &&
    paceSecondsPerKm === null
  ) {
    return null;
  }

  return {
    order,
    distanceMeters,
    cumulativeDistanceMeters,
    durationSeconds,
    cumulativeDurationSeconds,
    paceSecondsPerKm,
  };
}

function normalizeSplitSamples(samples: RouteSplitSample[]): RouteSplitSample[] {
  const filtered = samples.filter(
    (sample) =>
      Number.isFinite(sample.order ?? 0) ||
      Number.isFinite(sample.distanceMeters ?? 0) ||
      Number.isFinite(sample.cumulativeDistanceMeters ?? 0) ||
      Number.isFinite(sample.durationSeconds ?? 0) ||
      Number.isFinite(sample.cumulativeDurationSeconds ?? 0) ||
      Number.isFinite(sample.paceSecondsPerKm ?? 0),
  );

  const sorted = [...filtered].sort((left, right) => {
    const leftOrder = left.order ?? Number.POSITIVE_INFINITY;
    const rightOrder = right.order ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return 0;
  });

  if (sorted.length <= 220) {
    return sorted;
  }

  const step = Math.ceil(sorted.length / 220);
  return sorted.filter((_, index) => index % step === 0 || index === sorted.length - 1);
}

type GarminDetailMetricDescriptor = {
  metricsIndex: number;
  key: string;
};

function buildRouteSamplesFromGarminDetails(source: unknown): ActivityRouteSampleData[] | null {
  if (!source || typeof source !== 'object') {
    return null;
  }

  const record = source as Record<string, unknown>;
  const descriptors = Array.isArray(record.metricDescriptors)
    ? record.metricDescriptors
        .map((descriptor) => {
          if (!descriptor || typeof descriptor !== 'object') {
            return null;
          }

          const descriptorRecord = descriptor as Record<string, unknown>;
          const metricsIndex = toNumber(descriptorRecord.metricsIndex);
          const key = typeof descriptorRecord.key === 'string' ? descriptorRecord.key : null;

          if (metricsIndex === null || key === null) {
            return null;
          }

          return {
            metricsIndex: Math.max(0, Math.floor(metricsIndex)),
            key,
          } satisfies GarminDetailMetricDescriptor;
        })
        .filter((descriptor): descriptor is GarminDetailMetricDescriptor => descriptor !== null)
    : [];
  const rows = Array.isArray(record.activityDetailMetrics) ? record.activityDetailMetrics : [];

  if (descriptors.length < 4 || rows.length < 2) {
    return null;
  }

  const indexByKey = new Map<string, number>();
  descriptors.forEach((descriptor) => {
    indexByKey.set(descriptor.key, descriptor.metricsIndex);
  });

  const latIndex =
    indexByKey.get('directLatitude') ??
    indexByKey.get('latitude') ??
    indexByKey.get('lat') ??
    null;
  const lngIndex =
    indexByKey.get('directLongitude') ??
    indexByKey.get('longitude') ??
    indexByKey.get('lon') ??
    indexByKey.get('lng') ??
    null;
  const speedIndex =
    indexByKey.get('directSpeed') ??
    indexByKey.get('speed') ??
    indexByKey.get('enhancedSpeed') ??
    null;
  const timestampIndex =
    indexByKey.get('directTimestamp') ??
    indexByKey.get('timestamp') ??
    indexByKey.get('time') ??
    null;

  if (latIndex === null || lngIndex === null) {
    return null;
  }

  const samples: ActivityRouteSampleData[] = [];

  rows.forEach((row) => {
    const metrics =
      Array.isArray(row) ? row : Array.isArray((row as Record<string, unknown>).metrics) ? (row as Record<string, unknown>).metrics as unknown[] : null;

    if (!metrics) {
      return;
    }

    const lat = toNumber(metrics[latIndex]);
    const lng = toNumber(metrics[lngIndex]);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return;
    }

    const speed = speedIndex !== null ? toNumber(metrics[speedIndex]) : null;
    const paceSecondsPerKm = speed !== null && speed > 0 ? toPaceFromSpeed(speed) : null;
    const timestampSeconds = timestampIndex !== null ? parseTimestampSeconds(metrics[timestampIndex]) : null;

    samples.push({
      point: [lat, lng],
      paceSecondsPerKm,
      timestampSeconds,
    });
  });

  const normalized = normalizeSamples(samples);
  return normalized.length >= 2 ? normalized : null;
}

function collectOrderedSplitCandidates(source: unknown, maxDepth = 8): RouteSplitSample[] {
  const seen = new Set<unknown>();
  let best: RouteSplitSample[] = [];
  let bestScore = -1;

  function considerArray(value: unknown[]): void {
    const samples = value.map(splitSampleFromObject).filter((sample): sample is RouteSplitSample => sample !== null);

    if (samples.length < 2) {
      return;
    }

    const paceCount = samples.filter((sample) => sample.paceSecondsPerKm !== null).length;
    const durationCount =
      samples.filter((sample) => sample.durationSeconds !== null || sample.cumulativeDurationSeconds !== null).length;
    const distanceCount =
      samples.filter((sample) => sample.distanceMeters !== null || sample.cumulativeDistanceMeters !== null).length;
    if (paceCount + durationCount + distanceCount === 0) {
      return;
    }

    const score = samples.length + paceCount * 8 + durationCount * 4 + distanceCount * 3;

    if (score > bestScore) {
      best = normalizeSplitSamples(samples);
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

function resolveSplitSegments(
  splitSamples: RouteSplitSample[],
  routeDistanceMeters: number,
): Array<{
  startDistanceMeters: number;
  endDistanceMeters: number;
  startElapsedSeconds: number;
  durationSeconds: number;
  paceSecondsPerKm: number | null;
}> {
  if (splitSamples.length < 2 || routeDistanceMeters <= 0) {
    return [];
  }

  const ordered = [...splitSamples].sort((left, right) => {
    const leftOrder = left.order ?? Number.POSITIVE_INFINITY;
    const rightOrder = right.order ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return 0;
  });

  const rawDistances = ordered.map((split, index) => {
    if (split.distanceMeters !== null && split.distanceMeters > 0) {
      return split.distanceMeters;
    }

    if (split.cumulativeDistanceMeters !== null) {
      const previous = ordered[index - 1]?.cumulativeDistanceMeters ?? 0;
      return Math.max(split.cumulativeDistanceMeters - previous, 0);
    }

    return null;
  });

  const knownDistanceTotal: number = rawDistances.reduce<number>(
    (total, distance) => total + (distance ?? 0),
    0,
  );
  const missingDistanceCount = rawDistances.filter((distance): distance is null => distance === null).length;
  const fallbackDistance: number =
    missingDistanceCount > 0
      ? Math.max(routeDistanceMeters - knownDistanceTotal, 0) / missingDistanceCount
      : routeDistanceMeters / ordered.length;
  let resolvedDistances = rawDistances.map((distance) => {
    const fallback = distance ?? fallbackDistance;
    return Math.max(fallback, 0);
  });
  const resolvedDistanceTotal = resolvedDistances.reduce((total, distance) => total + distance, 0);
  if (
    resolvedDistanceTotal > 0 &&
    Math.abs(resolvedDistanceTotal - routeDistanceMeters) / Math.max(routeDistanceMeters, 1) > 0.15
  ) {
    const distanceScale = routeDistanceMeters / resolvedDistanceTotal;
    resolvedDistances = resolvedDistances.map((distance) => Math.max(distance * distanceScale, 0));
  }

  const paceCandidates = ordered
    .map((split, index) => {
      const distanceKm = resolvedDistances[index] ? resolvedDistances[index] / 1000 : null;
      const durationSeconds = split.durationSeconds ?? split.cumulativeDurationSeconds ?? null;
      if (split.paceSecondsPerKm !== null) {
        return split.paceSecondsPerKm;
      }
      if (distanceKm !== null && distanceKm > 0 && durationSeconds !== null) {
        return durationSeconds / distanceKm;
      }
      return null;
    })
    .filter((pace): pace is number => pace !== null && Number.isFinite(pace) && pace > 0)
    .sort((left, right) => left - right);
  const fallbackPaceSecondsPerKm = paceCandidates.length
    ? paceCandidates[Math.floor(paceCandidates.length / 2)] ?? 360
    : 360;

  const resolvedDurations = ordered.map((split, index) => {
    const distanceKm = resolvedDistances[index] / 1000;

    if (split.durationSeconds !== null && split.durationSeconds > 0) {
      return split.durationSeconds;
    }

    if (split.cumulativeDurationSeconds !== null) {
      const previous = ordered[index - 1]?.cumulativeDurationSeconds ?? 0;
      const derived = split.cumulativeDurationSeconds - previous;
      if (derived > 0) {
        return derived;
      }
    }

    const pace = split.paceSecondsPerKm ?? fallbackPaceSecondsPerKm;
    return Math.max(pace * distanceKm, 0.4);
  });

  const segments: Array<{
    startDistanceMeters: number;
    endDistanceMeters: number;
    startElapsedSeconds: number;
    durationSeconds: number;
    paceSecondsPerKm: number | null;
  }> = [];

  let startDistanceMeters = 0;
  let startElapsedSeconds = 0;
  ordered.forEach((split, index) => {
    const durationSeconds = Math.max(resolvedDurations[index] ?? 0, 0.4);
    const endDistanceMeters =
      index === ordered.length - 1
        ? routeDistanceMeters
        : startDistanceMeters + Math.max(resolvedDistances[index] ?? 0, 0);
    const paceSecondsPerKm =
      split.paceSecondsPerKm ?? (resolvedDistances[index] > 0 ? durationSeconds / (resolvedDistances[index] / 1000) : null);

    segments.push({
      startDistanceMeters,
      endDistanceMeters: Math.max(endDistanceMeters, startDistanceMeters),
      startElapsedSeconds,
      durationSeconds,
      paceSecondsPerKm,
    });

    startDistanceMeters = Math.max(endDistanceMeters, startDistanceMeters);
    startElapsedSeconds += durationSeconds;
  });

  return segments;
}

function buildRouteSamplesFromSplitCandidates(
  points: LatLngTuple[],
  splitSamples: RouteSplitSample[],
): ActivityRouteSampleData[] | null {
  if (points.length < 2 || splitSamples.length < 2) {
    return null;
  }

  const routeDistancesMeters: number[] = [];
  let cumulativeDistanceMeters = 0;
  points.forEach((point, index) => {
    if (index > 0) {
      cumulativeDistanceMeters += distanceBetweenGeoPointsKm(points[index - 1]!, point) * 1000;
    }
    routeDistancesMeters.push(cumulativeDistanceMeters);
  });

  const segments = resolveSplitSegments(splitSamples, routeDistancesMeters.at(-1) ?? 0);
  if (segments.length < 2) {
    return null;
  }

  let segmentIndex = 0;
  return points.map((point, index) => {
    const pointDistanceMeters = routeDistancesMeters[index] ?? 0;

    while (
      segmentIndex < segments.length - 1 &&
      pointDistanceMeters > segments[segmentIndex]!.endDistanceMeters
    ) {
      segmentIndex += 1;
    }

    const segment = segments[segmentIndex] ?? segments.at(-1);
    if (!segment) {
      return {
        point,
        paceSecondsPerKm: null,
        timestampSeconds: null,
      };
    }

    const segmentDistanceMeters = Math.max(segment.endDistanceMeters - segment.startDistanceMeters, 0.1);
    const localDistanceMeters = Math.max(pointDistanceMeters - segment.startDistanceMeters, 0);
    const ratio = Math.min(Math.max(localDistanceMeters / segmentDistanceMeters, 0), 1);
    const timestampSeconds = segment.startElapsedSeconds + segment.durationSeconds * ratio;

    return {
      point,
      paceSecondsPerKm: segment.paceSecondsPerKm,
      timestampSeconds,
    };
  });
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
    if (paceCount === 0) {
      return;
    }

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
  const routeStartTime = Date.now();
  const routeTimeoutMs = 10_000; // Global timeout for route fetch

  try {
    // Fetch activity details with timeout
    const details = await Promise.race([
      garminClient.callJson(auth, 'get_activity_details', { activityId }),
      new Promise<any>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout fetching activity details')), 8_000),
      ),
    ]);

    const detailSamples = buildRouteSamplesFromGarminDetails(details);
    const points = extractRoutePoints(details);

    if (detailSamples && detailSamples.length >= 2) {
      console.log(`[perf] getGarminActivityRoute success from details total=${Date.now() - routeStartTime}ms`);
      return {
        points: points.length >= 2 ? points : detailSamples.map((sample) => sample.point),
        samples: detailSamples,
        source: 'garmin',
      };
    }

    const orderedSamples = collectOrderedSampleCandidates(details);

    if (orderedSamples.length >= 2) {
      console.log(`[perf] getGarminActivityRoute success from ordered samples total=${Date.now() - routeStartTime}ms`);
      return {
        points,
        samples: orderedSamples,
        source: 'garmin',
      };
    }

    if (points.length < 2) {
      // No basic points yet, try splits with timeout window
      const splitsStartTime = Date.now();
      const splitsTimeoutMs = Math.max(2_000, routeTimeoutMs - (Date.now() - routeStartTime) - 1_000);

      if (splitsTimeoutMs > 500) {
        const splitSources: unknown[] = [];
        
        for (const toolName of ['get_activity_splits', 'get_activity_split_summaries', 'get_activity_typed_splits']) {
          try {
            splitSources.push(
              await Promise.race([
                garminClient.callJson(auth, toolName, { activityId }),
                new Promise<any>((_, reject) =>
                  setTimeout(() => reject(new Error(`Timeout fetching ${toolName}`)), splitsTimeoutMs / 3),
                ),
              ]),
            );
          } catch (e) {
            const splitElapsed = Date.now() - splitsStartTime;
            if (splitElapsed > splitsTimeoutMs) {
              break; // Stop trying if we're out of time
            }
            // Otherwise ignore and keep trying other tools
          }
        }

        let bestSplitSamples: RouteSplitSample[] = [];
        splitSources.forEach((source) => {
          const candidates = collectOrderedSplitCandidates(source);
          if (candidates.length > bestSplitSamples.length) {
            bestSplitSamples = candidates;
          }
        });

        if (bestSplitSamples.length >= 2) {
          const splitRouteSamples = buildRouteSamplesFromSplitCandidates(points, bestSplitSamples);
          if (splitRouteSamples && splitRouteSamples.length >= 2) {
            console.log(`[perf] getGarminActivityRoute success from splits total=${Date.now() - routeStartTime}ms`);
            return routeDataFromSamples(splitRouteSamples, 'garmin');
          }
        }
      }

      if (points.length < 2) {
        throw new Error('Garmin no ha devuelto una ruta utilizable para este entrenamiento.');
      }
    }

    console.log(`[perf] getGarminActivityRoute fallback to points total=${Date.now() - routeStartTime}ms`);
    return {
      points,
      samples: points.map((point) => ({
        point,
        paceSecondsPerKm: null,
        timestampSeconds: null,
      })),
      source: 'garmin',
    };
  } catch (error) {
    const elapsed = Date.now() - routeStartTime;
    console.error(
      `[perf] getGarminActivityRoute failed total=${elapsed}ms error=${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
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
