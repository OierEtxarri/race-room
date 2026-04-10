import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRouteBearingDegrees,
  calculateRouteVideoDurationSeconds,
  calculateRouteVideoRenderFps,
  createRouteVideoTimeline,
  densifyRouteVideoSamples,
  estimateRouteVideoRenderMetrics,
  interpolateRouteVideoPointByDistance,
  routeProgressAtElapsedSeconds,
  toMapLibreLngLat,
} from './videoExportMath.ts';
import type { ActivityRouteSampleData } from './activityRoutes.ts';

test('densifyRouteVideoSamples preserves the last point and interpolates the route', () => {
  const samples: ActivityRouteSampleData[] = [
    {
      point: [43.0, -2.0],
      paceSecondsPerKm: 300,
      timestampSeconds: 0,
    },
    {
      point: [43.0, -1.998],
      paceSecondsPerKm: 305,
      timestampSeconds: 60,
    },
  ];

  const dense = densifyRouteVideoSamples(samples, 8);
  assert.ok(dense.length > samples.length);
  assert.deepEqual(dense.at(-1), {
    lat: 43.0,
    lng: -1.998,
    timestampSeconds: 60,
    paceSecondsPerKm: 305,
    distanceMeters: dense.at(-1)?.distanceMeters ?? 0,
  });
  assert.ok((dense.at(-1)?.distanceMeters ?? 0) > 100);
});


test('interpolateRouteVideoPointByDistance interpolates location and timing between dense points', () => {
  const points = [
    {
      lat: 43.0,
      lng: -2.0,
      elevationMeters: 10,
      timestampSeconds: 0,
      paceSecondsPerKm: 300,
      distanceMeters: 0,
    },
    {
      lat: 43.0,
      lng: -1.998,
      elevationMeters: 30,
      timestampSeconds: 60,
      paceSecondsPerKm: 330,
      distanceMeters: 200,
    },
  ];

  const interpolated = interpolateRouteVideoPointByDistance(points, 50);
  assert.equal(interpolated.lat, 43.0);
  assert.equal(interpolated.lng, -1.9995);
  assert.equal(interpolated.elevationMeters, 15);
  assert.equal(interpolated.timestampSeconds, 15);
  assert.equal(interpolated.distanceMeters, 50);
  assert.equal(interpolated.paceSecondsPerKm, 307.5);
});

test('calculateRouteBearingDegrees uses lng as x and lat as y so east is 90 degrees', () => {
  const bearing = calculateRouteBearingDegrees(
    { lat: 43.1, lng: -2.1 },
    { lat: 43.1, lng: -2.0 },
  );

  assert.equal(Math.round(bearing), 90);
});

test('calculateRouteVideoDurationSeconds clamps by distance', () => {
  assert.equal(calculateRouteVideoDurationSeconds(1), 11.5);
  assert.equal(calculateRouteVideoDurationSeconds(10), 21.5);
  assert.equal(calculateRouteVideoDurationSeconds(80), 44);
});

test('calculateRouteVideoRenderFps scales unique frame density by export length', () => {
  assert.equal(calculateRouteVideoRenderFps(14.4), 18);
  assert.equal(calculateRouteVideoRenderFps(24), 15);
  assert.equal(calculateRouteVideoRenderFps(31.8), 15);
  assert.equal(calculateRouteVideoRenderFps(44), 12);
});

test('estimateRouteVideoRenderMetrics captures at least at output fps to avoid duplicated motion', () => {
  const short = estimateRouteVideoRenderMetrics(10, 30);
  const long = estimateRouteVideoRenderMetrics(80, 30);

  assert.equal(short.renderFps, 30);
  assert.equal(long.renderFps, 30);
  assert.ok(short.captureFrames >= short.totalFrames);
  assert.ok(long.captureFrames >= long.totalFrames);
});

test('routeProgressAtElapsedSeconds only reaches 1 after the follow-cam window ends', () => {
  const timeline = createRouteVideoTimeline(12);
  const beforeFinish = timeline.overviewSeconds + timeline.descentSeconds + timeline.followSeconds - 0.1;
  const followEnd = timeline.overviewSeconds + timeline.descentSeconds + timeline.followSeconds;

  assert.ok(timeline.totalSeconds < 31);
  assert.ok(routeProgressAtElapsedSeconds(timeline, beforeFinish) < 1);
  assert.equal(routeProgressAtElapsedSeconds(timeline, followEnd), 1);
  assert.equal(routeProgressAtElapsedSeconds(timeline, timeline.totalSeconds), 1);
});

test('toMapLibreLngLat flips the tuple to lng-lat order', () => {
  assert.deepEqual(toMapLibreLngLat({ lat: 43.262, lng: -2.935 }), [-2.935, 43.262]);
});
