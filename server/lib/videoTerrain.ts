import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { config } from '../config.ts';

const TERRAIN_TILE_SIZE = 256;
const TERRAIN_TILE_ZOOM = 13;
const TERRAIN_TILE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
const terrainTileCache = new Map<string, PNG>();
const terrainCacheDir = path.join(config.rootDir, 'data', 'video-terrain-cache');

function tileCacheKey(z: number, x: number, y: number) {
  return `${z}/${x}/${y}`;
}

function terrainTilePath(z: number, x: number, y: number) {
  return path.join(terrainCacheDir, String(z), String(x), `${y}.png`);
}

function replaceTileTemplate(z: number, x: number, y: number) {
  return TERRAIN_TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

function mercatorPixel(lat: number, lng: number, zoom: number) {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const scale = TERRAIN_TILE_SIZE * 2 ** zoom;
  const x = ((lng + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

async function readTerrainTile(z: number, x: number, y: number) {
  const key = tileCacheKey(z, x, y);
  const cached = terrainTileCache.get(key);
  if (cached) {
    return cached;
  }

  const filePath = terrainTilePath(z, x, y);
  let buffer: Buffer;

  try {
    buffer = await fs.readFile(filePath);
  } catch {
    const response = await fetch(replaceTileTemplate(z, x, y), {
      headers: {
        Accept: 'image/png',
      },
    });

    if (!response.ok) {
      throw new Error(`No se pudo descargar el tile DEM ${z}/${x}/${y}.`);
    }

    buffer = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
  }

  const parsed = PNG.sync.read(buffer);
  terrainTileCache.set(key, parsed);
  return parsed;
}

function decodeTerrariumElevation(tile: PNG, pixelX: number, pixelY: number) {
  const normalizedX = Math.max(0, Math.min(tile.width - 1, pixelX));
  const normalizedY = Math.max(0, Math.min(tile.height - 1, pixelY));
  const offset = (normalizedY * tile.width + normalizedX) * 4;
  const red = tile.data[offset] ?? 0;
  const green = tile.data[offset + 1] ?? 0;
  const blue = tile.data[offset + 2] ?? 0;
  return red * 256 + green + blue / 256 - 32768;
}

export async function sampleTerrainElevationMeters(lat: number, lng: number, zoom = TERRAIN_TILE_ZOOM) {
  const pixel = mercatorPixel(lat, lng, zoom);
  const worldTileCount = 2 ** zoom;
  const tileX = ((Math.floor(pixel.x / TERRAIN_TILE_SIZE) % worldTileCount) + worldTileCount) % worldTileCount;
  const tileY = Math.floor(pixel.y / TERRAIN_TILE_SIZE);

  if (tileY < 0 || tileY >= worldTileCount) {
    return 0;
  }

  const tile = await readTerrainTile(zoom, tileX, tileY);
  const pixelX = Math.floor(pixel.x - Math.floor(pixel.x / TERRAIN_TILE_SIZE) * TERRAIN_TILE_SIZE);
  const pixelY = Math.floor(pixel.y - tileY * TERRAIN_TILE_SIZE);
  return decodeTerrariumElevation(tile, pixelX, pixelY);
}

export async function populateTerrainElevations<T extends { lat: number; lng: number }>(points: T[]) {
  const worldTileCount = 2 ** TERRAIN_TILE_ZOOM;
  const lookups = points.map((point) => {
    const pixel = mercatorPixel(point.lat, point.lng, TERRAIN_TILE_ZOOM);
    const tileX =
      ((Math.floor(pixel.x / TERRAIN_TILE_SIZE) % worldTileCount) + worldTileCount) % worldTileCount;
    const tileY = Math.floor(pixel.y / TERRAIN_TILE_SIZE);
    return {
      pixel,
      tileX,
      tileY,
      key: tileCacheKey(TERRAIN_TILE_ZOOM, tileX, tileY),
    };
  });

  const uniqueTiles = new Map<string, Promise<PNG>>();
  lookups.forEach((lookup) => {
    if (lookup.tileY < 0 || lookup.tileY >= worldTileCount || uniqueTiles.has(lookup.key)) {
      return;
    }
    uniqueTiles.set(lookup.key, readTerrainTile(TERRAIN_TILE_ZOOM, lookup.tileX, lookup.tileY));
  });

  const resolvedTiles = new Map<string, PNG>();
  await Promise.all(
    Array.from(uniqueTiles.entries()).map(async ([key, tilePromise]) => {
      resolvedTiles.set(key, await tilePromise);
    }),
  );

  return lookups.map((lookup) => {
    if (lookup.tileY < 0 || lookup.tileY >= worldTileCount) {
      return 0;
    }
    const tile = resolvedTiles.get(lookup.key);
    if (!tile) {
      return 0;
    }
    const pixelX = Math.floor(lookup.pixel.x - Math.floor(lookup.pixel.x / TERRAIN_TILE_SIZE) * TERRAIN_TILE_SIZE);
    const pixelY = Math.floor(lookup.pixel.y - lookup.tileY * TERRAIN_TILE_SIZE);
    return decodeTerrariumElevation(tile, pixelX, pixelY);
  });
}
