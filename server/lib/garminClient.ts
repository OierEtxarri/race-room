import fs from 'node:fs';
import path from 'node:path';
import { hasGarminMcpTokens } from './garminMcpBootstrap.ts';
import { garminMcpClient, type GarminSessionAuth } from './garminMcpClient.ts';
import { garminPythonClient } from './garminPythonClient.ts';

type JsonLike = Record<string, unknown> | unknown[] | string | number | boolean | null;
const authFailureCooldownMs = 5 * 60 * 1_000;

// Per-tool timeout config (in ms)
const toolTimeouts: Record<string, number> = {
  get_user_profile: 5_000,
  get_social_profile: 4_000,
  get_devices: 8_000,  // Increased from 3000: non-critical, should not block core profile
  get_daily_summary: 5_000,
  get_sleep_data_range: 5_000,
  get_hrv_range: 5_000,
  get_training_readiness_range: 5_000,
  get_daily_steps_range: 5_000,
  get_max_metrics_range: 5_000,
  get_vo2max_range: 5_000,
  get_training_status: 5_000,
  get_race_predictions: 5_000,
  get_activities_by_date: 6_000,
  get_body_composition: 5_000,
  get_activity_details: 8_000,
  upload_and_schedule_workout: 8_000,
};

function normalizeGarminError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('429')) {
    return 'Garmin Connect está limitando temporalmente el inicio de sesión (429).';
  }

  if (message.includes('427')) {
    return 'Garmin Connect está rechazando temporalmente la autenticación (427).';
  }

  if (message.includes('MFA')) {
    return 'Garmin requiere MFA para este usuario. La renovación automática no puede completar ese paso.';
  }

  if (message.includes('TIMEOUT') || message.includes('timeout')) {
    return 'Garmin Connect está respondiendo lentamente. Reintentando...';
  }

  return message;
}

function isAuthThrottleError(message: string): boolean {
  return message.includes('429') || message.includes('427');
}

function isTransientError(message: string): boolean {
  return (
    message.includes('timeout') ||
    message.includes('TIMEOUT') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ECONNRESET')
  );
}

export class GarminClient {
  private recentFailures = new Map<
    string,
    {
      message: string;
      expiresAt: number;
    }
  >();

  private backendCircuitBreaker = new Map<
    string,
    {
      preferred: 'python' | 'mcp';
      lastFailedAt: number;
      failureCount: number;
    }
  >();

  private rememberFailure(auth: GarminSessionAuth, message: string): void {
    this.recentFailures.set(auth.id, {
      message,
      expiresAt: Date.now() + authFailureCooldownMs,
    });
  }

  private clearFailure(auth: GarminSessionAuth): void {
    this.recentFailures.delete(auth.id);
  }

  private getRecentFailure(auth: GarminSessionAuth): string | null {
    const failure = this.recentFailures.get(auth.id) ?? null;
    if (!failure) {
      return null;
    }

    if (failure.expiresAt <= Date.now()) {
      this.recentFailures.delete(auth.id);
      return null;
    }

    return failure.message;
  }

  private hasPythonTokens(auth: GarminSessionAuth): boolean {
    return (
      fs.existsSync(path.join(auth.tokenDirs.python, 'oauth1_token.json')) &&
      fs.existsSync(path.join(auth.tokenDirs.python, 'oauth2_token.json'))
    );
  }

  private hasMcpTokens(auth: GarminSessionAuth): boolean {
    return hasGarminMcpTokens(auth.tokenDirs.mcp);
  }

  private getPreferredBackend(auth: GarminSessionAuth): 'python' | 'mcp' | null {
    const breaker = this.backendCircuitBreaker.get(auth.id);
    if (!breaker) {
      return null;
    }

    // If failed recently and multiple failures, try other backend
    const recentFailure = Date.now() - breaker.lastFailedAt < 10_000;
    if (recentFailure && breaker.failureCount >= 3) {
      return breaker.preferred === 'python' ? 'mcp' : 'python';
    }

    return breaker.preferred;
  }

  private selectBackend(auth: GarminSessionAuth): 'python' | 'mcp' {
    const preferredBreaker = this.getPreferredBackend(auth);
    if (preferredBreaker) {
      return preferredBreaker;
    }

    // Prefer MCP if available, Python as fallback
    const hasMcp = this.hasMcpTokens(auth);
    const hasPython = this.hasPythonTokens(auth);

    if (hasMcp && !hasPython) {
      return 'mcp';
    }

    return 'python';
  }

  private recordBackendSuccess(auth: GarminSessionAuth, backend: 'python' | 'mcp'): void {
    this.backendCircuitBreaker.set(auth.id, {
      preferred: backend,
      lastFailedAt: 0,
      failureCount: 0,
    });
  }

  private recordBackendFailure(auth: GarminSessionAuth, backend: 'python' | 'mcp'): void {
    const existing = this.backendCircuitBreaker.get(auth.id) ?? {
      preferred: backend,
      lastFailedAt: Date.now(),
      failureCount: 0,
    };

    this.backendCircuitBreaker.set(auth.id, {
      preferred: existing.preferred,
      lastFailedAt: Date.now(),
      failureCount: existing.failureCount + 1,
    });
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms for ${toolName}`)), timeoutMs),
      ),
    ]);
  }

  async callJson<T extends JsonLike = JsonLike>(
    auth: GarminSessionAuth,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    const recentFailure = this.getRecentFailure(auth);
    const hasReusableTokens = this.hasPythonTokens(auth) || this.hasMcpTokens(auth);

    if (recentFailure && !hasReusableTokens) {
      throw new Error(recentFailure);
    }

    if (recentFailure && hasReusableTokens) {
      this.clearFailure(auth);
    }

    const pythonEnv = {
      HOME: auth.homeDir,
      GARMIN_EMAIL: auth.garminEmail,
      GARMIN_PASSWORD: auth.garminPassword,
      GARMINTOKENS: auth.tokenDirs.python,
    };

    const timeoutMs = toolTimeouts[name] ?? 8_000;
    const backend = this.selectBackend(auth);
    const startTime = Date.now();

    try {
      if (backend === 'mcp') {
        const result = await this.withTimeout(garminMcpClient.callJson<T>(auth, name, args), timeoutMs, name);
        this.recordBackendSuccess(auth, 'mcp');
        this.clearFailure(auth);
        console.log(
          `[perf] garmin call backend=mcp tool=${name} time=${Date.now() - startTime}ms`,
        );
        return result;
      }

      const result = await this.withTimeout(
        garminPythonClient.callJson<T>(name, args, pythonEnv),
        timeoutMs,
        name,
      );
      this.recordBackendSuccess(auth, 'python');
      this.clearFailure(auth);
      console.log(
        `[perf] garmin call backend=python tool=${name} time=${Date.now() - startTime}ms`,
      );
      return result;
    } catch (primaryError) {
      // Extract raw message BEFORE normalization to detect transient errors correctly
      const rawMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const normalizedError = normalizeGarminError(primaryError);
      
      // CRITICAL FIX: Check isTransientError on raw message BEFORE normalization
      // Otherwise timeout gets normalized away and fallback never triggers
      const shouldRetry = isTransientError(rawMessage) && backend === 'python' && this.hasMcpTokens(auth);

      if (shouldRetry) {
        try {
          this.recordBackendFailure(auth, 'python');
          const fallbackResult = await this.withTimeout(
            garminMcpClient.callJson<T>(auth, name, args),
            timeoutMs,
            name,
          );
          this.recordBackendSuccess(auth, 'mcp');
          this.clearFailure(auth);
          console.log(
            `[perf] garmin fallback backend=python->mcp tool=${name} raw_error="${rawMessage.substring(0, 60)}..." time=${Date.now() - startTime}ms`,
          );
          return fallbackResult;
        } catch (fallbackError) {
          const fallbackRawMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          const normalizedFallback = normalizeGarminError(fallbackError);
          if (rawMessage === fallbackRawMessage) {
            throw new Error(normalizedError);
          }

          throw new Error(
            `Garmin ${name} falló en ambos backends: ${normalizedError} / ${normalizedFallback}`,
          );
        }
      }

      // If authentication throttle, remember it
      if (isAuthThrottleError(rawMessage)) {
        this.rememberFailure(auth, normalizedError);
      }

      this.recordBackendFailure(auth, backend);
      throw primaryError;
    }
  }

  async close(sessionId?: string): Promise<void> {
    if (sessionId) {
      this.recentFailures.delete(sessionId);
      this.backendCircuitBreaker.delete(sessionId);
    } else {
      this.recentFailures.clear();
      this.backendCircuitBreaker.clear();
    }

    await garminMcpClient.close(sessionId);
  }
}

export const garminClient = new GarminClient();
