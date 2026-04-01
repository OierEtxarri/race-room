import { assertStravaConfig } from '../config.ts';
import type { StravaSessionRecord } from './sessionStore.ts';

export type StravaAppConfig = {
  stravaClientId: string;
  stravaClientSecret: string;
  stravaRedirectUri: string;
};

type StravaTokenResponse = {
  token_type: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  athlete?: {
    id?: number;
    firstname?: string;
    lastname?: string;
    username?: string;
  };
};

function configOrThrow(overrides?: Partial<StravaAppConfig> | null): StravaAppConfig {
  if (
    overrides?.stravaClientId?.trim() &&
    overrides.stravaClientSecret?.trim() &&
    overrides.stravaRedirectUri?.trim()
  ) {
    return {
      stravaClientId: overrides.stravaClientId.trim(),
      stravaClientSecret: overrides.stravaClientSecret.trim(),
      stravaRedirectUri: overrides.stravaRedirectUri.trim(),
    };
  }

  return assertStravaConfig();
}

function buildBearerHeaders(accessToken: string): Headers {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${accessToken}`);
  headers.set('Accept', 'application/json');
  return headers;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    const errorEntries = Array.isArray(payload.errors) ? payload.errors : [];
    const firstError = errorEntries[0];
    const errorCode =
      typeof firstError === 'object' &&
      firstError !== null &&
      'code' in firstError &&
      typeof firstError.code === 'string'
        ? firstError.code
        : null;
    const message =
      (typeof payload.message === 'string' && payload.message) ||
      errorCode ||
      `Strava API respondió ${response.status}.`;
    throw new Error(message);
  }

  return payload as T;
}

async function tokenRequest(body: URLSearchParams): Promise<StravaTokenResponse> {
  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  return readJsonResponse<StravaTokenResponse>(response);
}

export function isStravaConfigured(overrides?: Partial<StravaAppConfig> | null): boolean {
  try {
    configOrThrow(overrides);
    return true;
  } catch {
    return false;
  }
}

export function buildStravaAuthorizeUrl(state: string, appConfig?: Partial<StravaAppConfig> | null): string {
  const config = configOrThrow(appConfig);
  const url = new URL('https://www.strava.com/oauth/authorize');
  url.searchParams.set('client_id', config.stravaClientId);
  url.searchParams.set('redirect_uri', config.stravaRedirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('approval_prompt', 'auto');
  url.searchParams.set('scope', 'read,activity:read_all');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeStravaCode(
  code: string,
  appConfig?: Partial<StravaAppConfig> | null,
): Promise<StravaTokenResponse> {
  const config = configOrThrow(appConfig);
  const body = new URLSearchParams({
    client_id: config.stravaClientId,
    client_secret: config.stravaClientSecret,
    code,
    grant_type: 'authorization_code',
  });

  return tokenRequest(body);
}

export async function refreshStravaSession(session: StravaSessionRecord): Promise<StravaSessionRecord> {
  if (session.expiresAt > Date.now() + 60_000) {
    return session;
  }

  const config = configOrThrow({
    stravaClientId: session.stravaClientId,
    stravaClientSecret: session.stravaClientSecret,
    stravaRedirectUri: session.stravaRedirectUri,
  });
  const body = new URLSearchParams({
    client_id: config.stravaClientId,
    client_secret: config.stravaClientSecret,
    refresh_token: session.refreshToken,
    grant_type: 'refresh_token',
  });
  const payload = await tokenRequest(body);

  session.accessToken = payload.access_token;
  session.refreshToken = payload.refresh_token;
  session.expiresAt = payload.expires_at * 1_000;
  session.updatedAt = Date.now();
  return session;
}

async function authorizedGet<T>(session: StravaSessionRecord, pathname: string, search?: URLSearchParams): Promise<T> {
  await refreshStravaSession(session);
  const url = new URL(`https://www.strava.com/api/v3${pathname}`);
  if (search) {
    url.search = search.toString();
  }

  const response = await fetch(url, {
    headers: buildBearerHeaders(session.accessToken),
  });

  return readJsonResponse<T>(response);
}

export async function getStravaAthlete(session: StravaSessionRecord): Promise<Record<string, unknown>> {
  return authorizedGet<Record<string, unknown>>(session, '/athlete');
}

export async function getStravaAthleteStats(
  session: StravaSessionRecord,
  athleteId = session.athleteId,
): Promise<Record<string, unknown>> {
  return authorizedGet<Record<string, unknown>>(session, `/athletes/${athleteId}/stats`);
}

export async function listStravaActivities(
  session: StravaSessionRecord,
  options: { after?: string; perPage?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const perPage = Math.max(1, Math.min(options.perPage ?? 200, 200));
  const collected: Array<Record<string, unknown>> = [];
  let page = 1;

  while (page <= 4) {
    const search = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
    });

    if (options.after) {
      const epochSeconds = Math.floor(new Date(options.after).getTime() / 1_000);
      search.set('after', String(epochSeconds));
    }

    const payload = await authorizedGet<Array<Record<string, unknown>>>(session, '/athlete/activities', search);
    collected.push(...payload);

    if (payload.length < perPage) {
      break;
    }

    page += 1;
  }

  return collected;
}
