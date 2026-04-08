import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGarminSession, destroySession } from './sessionStore.ts';
import { RouteVideoExportManager } from './videoExportJobs.ts';
import type { RouteVideoPayload, RouteVideoRenderResult, RouteVideoRenderSummary } from './videoExportTypes.ts';

const summary: RouteVideoRenderSummary = {
  title: 'Bilbao Tempo',
  date: '2026-04-08',
  timeLabel: '07:15',
  activityLabel: 'Run',
  providerLabel: 'Garmin',
  athleteName: 'Oier',
  distanceKm: 10,
  durationSeconds: 3_100,
  paceSecondsPerKm: 310,
  elevationGain: 120,
};

const payload: RouteVideoPayload = {
  activityId: 123,
  source: 'garmin',
  bounds: {
    minLat: 43.25,
    minLng: -2.95,
    maxLat: 43.27,
    maxLng: -2.92,
  },
  points: [
    {
      lat: 43.25,
      lng: -2.95,
      elevationMeters: 14,
      timestampSeconds: 0,
      paceSecondsPerKm: 310,
      distanceMeters: 0,
    },
    {
      lat: 43.26,
      lng: -2.94,
      elevationMeters: 32,
      timestampSeconds: 120,
      paceSecondsPerKm: 305,
      distanceMeters: 1_000,
    },
  ],
  totalDistanceKm: 1,
  totalElapsedSeconds: 120,
};

async function waitForSettled(
  manager: RouteVideoExportManager,
  sessionId: string,
  jobId: string,
  timeoutMs = 5_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = manager.getJob(sessionId, jobId);
    if (!job) {
      throw new Error('job missing');
    }

    if (job.status === 'done' || job.status === 'error') {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('job timeout');
}

test('RouteVideoExportManager runs queued jobs to completion', async () => {
  const session = createGarminSession({
    garminEmail: 'video-tests@example.com',
    garminPassword: 'secret',
  });
  const manager = new RouteVideoExportManager({
    buildPayload: async () => payload,
    render: async (input): Promise<RouteVideoRenderResult> => {
      const filePath = path.join(input.workDir, `${input.jobId}.mp4`);
      await fs.mkdir(input.workDir, { recursive: true });
      await fs.writeFile(filePath, 'mp4');
      input.onProgress?.(0.5, 'halfway');
      return {
        filePath,
        outputFilename: `${input.jobId}.mp4`,
        totalFrames: 120,
        durationSeconds: 4,
      };
    },
  });

  try {
    const job = await manager.createJob(session.id, 123, summary);
    const settled = await waitForSettled(manager, session.id, job.id);

    assert.equal(settled.status, 'done');
    assert.equal(settled.metrics.totalFrames, 120);
    assert.ok(settled.downloadUrl);
  } finally {
    destroySession(session.id);
  }
});

test('RouteVideoExportManager surfaces renderer failures', async () => {
  const session = createGarminSession({
    garminEmail: 'video-tests-error@example.com',
    garminPassword: 'secret',
  });
  const manager = new RouteVideoExportManager({
    buildPayload: async () => payload,
    render: async () => {
      throw new Error('renderer exploded');
    },
  });

  try {
    const job = await manager.createJob(session.id, 123, summary);
    const settled = await waitForSettled(manager, session.id, job.id);

    assert.equal(settled.status, 'error');
    assert.match(settled.error ?? '', /renderer exploded/);
  } finally {
    destroySession(session.id);
  }
});
