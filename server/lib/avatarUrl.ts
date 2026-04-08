const defaultGarminAvatarBaseUrl = 'https://connect.garmin.com/';

function getPathValue(source: unknown, path: string): unknown {
  if (!source || typeof source !== 'object') {
    return null;
  }

  return path.split('.').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return (value as Record<string, unknown>)[segment];
  }, source);
}

export function normalizeRemoteImageUrl(rawValue: unknown, baseUrl = defaultGarminAvatarBaseUrl): string | null {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return null;
  }

  const trimmed = rawValue.trim();
  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    // Fall through and resolve as relative.
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

export function pickNormalizedImageUrl(
  sources: unknown[],
  keys: string[],
  options: {
    baseUrl?: string;
  } = {},
): string | null {
  for (const source of sources) {
    for (const key of keys) {
      const normalized = normalizeRemoteImageUrl(getPathValue(source, key), options.baseUrl);
      if (normalized) {
        return normalized;
      }
    }
  }

  return null;
}
