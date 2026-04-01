import fs from 'node:fs';
import path from 'node:path';

function oauthTokenPaths(tokenDir: string) {
  return {
    oauth1: path.join(tokenDir, 'oauth1_token.json'),
    oauth2: path.join(tokenDir, 'oauth2_token.json'),
  };
}

export function hasGarminMcpTokens(tokenDir: string): boolean {
  const paths = oauthTokenPaths(tokenDir);
  return fs.existsSync(paths.oauth1) && fs.existsSync(paths.oauth2);
}
