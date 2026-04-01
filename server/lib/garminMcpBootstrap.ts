import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGarminCredentials } from '../config.ts';

const tokenDir = path.join(os.homedir(), '.garmin-mcp');
const oauth1TokenPath = path.join(tokenDir, 'oauth1_token.json');
const oauth2TokenPath = path.join(tokenDir, 'oauth2_token.json');

let bootstrapPromise: Promise<void> | null = null;

export function hasGarminMcpTokens(): boolean {
  return fs.existsSync(oauth1TokenPath) && fs.existsSync(oauth2TokenPath);
}

export async function ensureGarminMcpTokens(force = false): Promise<void> {
  if (!force && hasGarminMcpTokens()) {
    return;
  }

  if (bootstrapPromise) {
    await bootstrapPromise;
    return;
  }

  bootstrapPromise = (async () => {
    const { garminEmail, garminPassword } = assertGarminCredentials();
    const { GarminAuth } = await import('../../vendor/garmin-connect-mcp/src/client/index.ts');
    const auth = new GarminAuth(garminEmail, garminPassword);

    await auth.request('/userprofile-service/socialProfile');
  })();

  try {
    await bootstrapPromise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('MFA is required')) {
      throw new Error(
        'Garmin requiere MFA interactivo para renovar la sesión. Ejecuta `npm run mcp:garmin:setup` una vez para regrabar ~/.garmin-mcp/.',
      );
    }

    throw new Error(`No se pudo autoautenticar Garmin MCP: ${message}`);
  } finally {
    bootstrapPromise = null;
  }
}
