import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasGarminMcpTokens } from './garminMcpBootstrap.ts';
import { garminMcpClient } from './garminMcpClient.ts';
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

  return message;
}

function isAuthThrottleError(message: string): boolean {
  return message.includes('429') || message.includes('427');
}

export class GarminClient {
  private recentFailure:
    | {
        message: string;
        expiresAt: number;
      }
    | null = null;

  private rememberFailure(message: string): void {
    this.recentFailure = {
      message,
      expiresAt: Date.now() + authFailureCooldownMs,
    };
  }

  private clearFailure(): void {
    this.recentFailure = null;
  }

  private hasPythonTokens(): boolean {
    const tokenDir = path.join(os.homedir(), '.garminconnect');
    return (
      fs.existsSync(path.join(tokenDir, 'oauth1_token.json')) &&
      fs.existsSync(path.join(tokenDir, 'oauth2_token.json'))
    );
  }

  private hasMcpTokens(): boolean {
    return hasGarminMcpTokens();
  }

  private shouldPreferMcp(): boolean {
    return this.hasMcpTokens() && !this.hasPythonTokens();
  }

  async callJson<T extends JsonLike = JsonLike>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    if (this.recentFailure && this.recentFailure.expiresAt > Date.now()) {
      throw new Error(this.recentFailure.message);
    }

    const primary = this.shouldPreferMcp() ? 'mcp' : 'python';

    if (primary === 'mcp') {
      try {
        const result = await garminMcpClient.callJson<T>(name, args);
        this.clearFailure();
        return result;
      } catch (mcpError) {
        const normalizedMcpError = normalizeGarminError(mcpError);
        if (isAuthThrottleError(normalizedMcpError)) {
          this.rememberFailure(normalizedMcpError);
          throw new Error(normalizedMcpError);
        }

        console.warn(`[garmin-mcp] falling back to Python after error in ${name}: ${normalizedMcpError}`);

        try {
          const result = await garminPythonClient.callJson<T>(name, args);
          this.clearFailure();
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
      const result = await garminPythonClient.callJson<T>(name, args);
      this.clearFailure();
      return result;
    } catch (pythonError) {
      const normalizedPythonError = normalizeGarminError(pythonError);

      if (isAuthThrottleError(normalizedPythonError)) {
        this.rememberFailure(normalizedPythonError);
        throw new Error(normalizedPythonError);
      }

      console.warn(
        `[garmin-python] falling back to MCP after error in ${name}: ${normalizedPythonError}`,
      );

      try {
        const result = await garminMcpClient.callJson<T>(name, args);
        this.clearFailure();
        return result;
      } catch (mcpError) {
        const normalizedMcpError = normalizeGarminError(mcpError);
        if (isAuthThrottleError(normalizedMcpError)) {
          this.rememberFailure(normalizedMcpError);
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
}

export const garminClient = new GarminClient();
