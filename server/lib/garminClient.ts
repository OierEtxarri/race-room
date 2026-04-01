import fs from 'node:fs';
import path from 'node:path';
import { hasGarminMcpTokens } from './garminMcpBootstrap.ts';
import { garminMcpClient, type GarminSessionAuth } from './garminMcpClient.ts';
import { garminPythonClient } from './garminPythonClient.ts';

type JsonLike = Record<string, unknown> | unknown[] | string | number | boolean | null;
const authFailureCooldownMs = 5 * 60 * 1_000;

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

  return message;
}

function isAuthThrottleError(message: string): boolean {
  return message.includes('429') || message.includes('427');
}

export class GarminClient {
  private recentFailures = new Map<
    string,
    {
      message: string;
      expiresAt: number;
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

  private shouldPreferMcp(auth: GarminSessionAuth): boolean {
    return this.hasMcpTokens(auth) && !this.hasPythonTokens(auth);
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
    const primary = this.shouldPreferMcp(auth) ? 'mcp' : 'python';

    if (primary === 'mcp') {
      try {
        const result = await garminMcpClient.callJson<T>(auth, name, args);
        this.clearFailure(auth);
        return result;
      } catch (mcpError) {
        const normalizedMcpError = normalizeGarminError(mcpError);
        if (isAuthThrottleError(normalizedMcpError)) {
          this.rememberFailure(auth, normalizedMcpError);
          throw new Error(normalizedMcpError);
        }

        console.warn(`[garmin-mcp:${auth.id}] falling back to Python after error in ${name}: ${normalizedMcpError}`);

        try {
          const result = await garminPythonClient.callJson<T>(name, args, pythonEnv);
          this.clearFailure(auth);
          return result;
        } catch (pythonError) {
          const normalizedPythonError = normalizeGarminError(pythonError);
          if (normalizedPythonError === normalizedMcpError) {
            throw new Error(normalizedMcpError);
          }

          throw new Error(
            `MCP y Python API fallaron para ${name}: ${normalizedMcpError} / ${normalizedPythonError}`,
          );
        }
      }
    }

    try {
      const result = await garminPythonClient.callJson<T>(name, args, pythonEnv);
      this.clearFailure(auth);
      return result;
    } catch (pythonError) {
      const normalizedPythonError = normalizeGarminError(pythonError);

      if (isAuthThrottleError(normalizedPythonError)) {
        this.rememberFailure(auth, normalizedPythonError);
        throw new Error(normalizedPythonError);
      }

      console.warn(`[garmin-python:${auth.id}] falling back to MCP after error in ${name}: ${normalizedPythonError}`);

      try {
        const result = await garminMcpClient.callJson<T>(auth, name, args);
        this.clearFailure(auth);
        return result;
      } catch (mcpError) {
        const normalizedMcpError = normalizeGarminError(mcpError);
        if (isAuthThrottleError(normalizedMcpError)) {
          this.rememberFailure(auth, normalizedMcpError);
        }

        if (normalizedMcpError === normalizedPythonError) {
          throw new Error(normalizedPythonError);
        }

        throw new Error(
          `Python API y MCP fallaron para ${name}: ${normalizedPythonError} / ${normalizedMcpError}`,
        );
      }
    }
  }

  async close(sessionId?: string): Promise<void> {
    if (sessionId) {
      this.recentFailures.delete(sessionId);
    } else {
      this.recentFailures.clear();
    }

    await garminMcpClient.close(sessionId);
  }
}

export const garminClient = new GarminClient();
