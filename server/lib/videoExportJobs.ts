import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { getSession } from './sessionStore.ts';
import { buildRouteVideoPayload } from './videoRoutePayload.ts';
import { renderRouteVideoToMp4 } from './videoExportRenderer.ts';
import type {
  RouteVideoExportJob,
  RouteVideoPayload,
  RouteVideoRenderResult,
  RouteVideoRenderSummary,
} from './videoExportTypes.ts';

type InternalRouteVideoExportJob = RouteVideoExportJob & {
  workDir: string;
};

type RouteVideoExportManagerDeps = {
  buildPayload?: (session: NonNullable<ReturnType<typeof getSession>>, activityId: number) => Promise<RouteVideoPayload>;
  render?: (input: {
    jobId: string;
    workDir: string;
    payload: RouteVideoPayload;
    summary: RouteVideoRenderSummary;
    onProgress?: (progress: number, message: string) => void;
  }) => Promise<RouteVideoRenderResult>;
};

const jobsDir = path.join(config.rootDir, 'data', 'video-exports');
const pruneAfterMs = 24 * 60 * 60 * 1_000;

function nowIso() {
  return new Date().toISOString();
}

function sanitizeSlug(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 48) || 'route-video';
}

export class RouteVideoExportManager {
  private jobs = new Map<string, InternalRouteVideoExportJob>();
  private queue: string[] = [];
  private isRunning = false;
  private readonly buildPayload;
  private readonly render;

  constructor(deps: RouteVideoExportManagerDeps = {}) {
    this.buildPayload = deps.buildPayload ?? buildRouteVideoPayload;
    this.render = deps.render ?? renderRouteVideoToMp4;
  }

  async createJob(sessionId: string, activityId: number, summary: RouteVideoRenderSummary) {
    await this.pruneOldJobs();
    const id = crypto.randomUUID();
    const workDir = path.join(jobsDir, id);
    const createdAt = nowIso();
    const job: InternalRouteVideoExportJob = {
      id,
      sessionId,
      activityId,
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
      progress: 0,
      message: 'En cola para render.',
      summary,
      outputFilename: null,
      downloadUrl: null,
      error: null,
      metrics: {
        totalFrames: null,
        durationSeconds: null,
      },
      workDir,
    };

    this.jobs.set(id, job);
    this.queue.push(id);
    void this.runNext();
    return this.toPublicJob(job);
  }

  getJob(sessionId: string, jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.sessionId !== sessionId) {
      return null;
    }

    return this.toPublicJob(job);
  }

  async resolveDownload(sessionId: string, jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.sessionId !== sessionId || job.status !== 'done' || !job.outputFilename) {
      return null;
    }

    return {
      filePath: path.join(job.workDir, job.outputFilename),
      filename: job.outputFilename,
    };
  }

  private async runNext() {
    if (this.isRunning) {
      return;
    }

    const nextJobId = this.queue.shift();
    if (!nextJobId) {
      return;
    }

    const job = this.jobs.get(nextJobId);
    if (!job) {
      void this.runNext();
      return;
    }

    this.isRunning = true;
    try {
      await fs.mkdir(job.workDir, { recursive: true });
      this.updateJob(job.id, {
        status: 'rendering',
        progress: 0.03,
        message: 'Preparando datos de la ruta.',
        error: null,
      });

      const session = getSession(job.sessionId);
      if (!session) {
        throw new Error('La sesión asociada al export ya no está disponible.');
      }

      const payload = await this.buildPayload(session, job.activityId);
      this.updateJob(job.id, {
        progress: 0.06,
        message: 'Ruta densa y relieve listos.',
      });

      const renderResult = await this.render({
        jobId: job.id,
        workDir: job.workDir,
        payload,
        summary: job.summary,
        onProgress: (progress, message) => {
          this.updateJob(job.id, {
            progress,
            message,
          });
        },
      });

      const safeTitle = sanitizeSlug(job.summary.title);
      const outputFilename = `${safeTitle}-${job.activityId}.mp4`;
      const finalOutputPath = path.join(job.workDir, outputFilename);
      await fs.rename(renderResult.filePath, finalOutputPath);

      this.updateJob(job.id, {
        status: 'done',
        progress: 1,
        message: 'Vídeo listo para descargar.',
        outputFilename,
        downloadUrl: `/api/video-exports/${job.id}/download`,
        metrics: {
          totalFrames: renderResult.totalFrames,
          durationSeconds: renderResult.durationSeconds,
        },
      });
    } catch (error) {
      this.updateJob(job.id, {
        status: 'error',
        message: 'El render ha fallado.',
        error: error instanceof Error ? error.message : 'Fallo desconocido en el export del vídeo.',
      });
    } finally {
      this.isRunning = false;
      void this.runNext();
    }
  }

  private updateJob(jobId: string, patch: Partial<InternalRouteVideoExportJob>) {
    const current = this.jobs.get(jobId);
    if (!current) {
      return;
    }

    this.jobs.set(jobId, {
      ...current,
      ...patch,
      updatedAt: nowIso(),
      metrics: patch.metrics ? patch.metrics : current.metrics,
    });
  }

  private toPublicJob(job: InternalRouteVideoExportJob): RouteVideoExportJob {
    return {
      id: job.id,
      sessionId: job.sessionId,
      activityId: job.activityId,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      progress: job.progress,
      message: job.message,
      summary: job.summary,
      outputFilename: job.outputFilename,
      downloadUrl: job.downloadUrl,
      error: job.error,
      metrics: job.metrics,
    };
  }

  private async pruneOldJobs() {
    const now = Date.now();
    const entries = Array.from(this.jobs.values());
    await fs.mkdir(jobsDir, { recursive: true });

    await Promise.all(
      entries.map(async (job) => {
        if (now - new Date(job.updatedAt).getTime() < pruneAfterMs) {
          return;
        }

        this.jobs.delete(job.id);
        this.queue = this.queue.filter((queuedId) => queuedId !== job.id);
        await fs.rm(job.workDir, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      }),
    );
  }
}

export const routeVideoExportManager = new RouteVideoExportManager();
