import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRouteBearingDegrees,
  calculateRouteVideoDurationSeconds,
  calculateRouteVideoRenderFps,
  createRouteVideoTimeline,
  densifyRouteVideoSamples,
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

test('calculateRouteBearingDegrees uses lng as x and lat as y so east is 90 degrees', () => {
  const bearing = calculateRouteBearingDegrees(
    { lat: 43.1, lng: -2.1 },
    { lat: 43.1, lng: -2.0 },
  );

  assert.equal(Math.round(bearing), 90);
});

test('calculateRouteVideoDurationSeconds clamps by distance', () => {
  assert.equal(calculateRouteVideoDurationSeconds(1), 12);
  assert.equal(calculateRouteVideoDurationSeconds(10), 24);
  assert.equal(calculateRouteVideoDurationSeconds(80), 50);
});

test('calculateRouteVideoRenderFps scales unique frame density by export length', () => {
  assert.equal(calculateRouteVideoRenderFps(14.4), 18);
  assert.equal(calculateRouteVideoRenderFps(24), 15);
  assert.equal(calculateRouteVideoRenderFps(31.8), 15);
  assert.equal(calculateRouteVideoRenderFps(44), 12);
});

test('routeProgressAtElapsedSeconds only reaches 1 after the follow-cam window ends', () => {
  const timeline = createRouteVideoTimeline(12);
  const beforeFinish = timeline.overviewSeconds + timeline.descentSeconds + timeline.followSeconds - 0.1;
  const followEnd = timeline.overviewSeconds + timeline.descentSeconds + timeline.followSeconds;

  assert.ok(routeProgressAtElapsedSeconds(timeline, beforeFinish) < 1);
  assert.equal(routeProgressAtElapsedSeconds(timeline, followEnd), 1);
  assert.equal(routeProgressAtElapsedSeconds(timeline, timeline.totalSeconds), 1);
});

test('toMapLibreLngLat flips the tuple to lng-lat order', () => {
  assert.deepEqual(toMapLibreLngLat({ lat: 43.262, lng: -2.935 }), [-2.935, 43.262]);
});
