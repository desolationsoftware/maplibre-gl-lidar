/**
 * Web-mercator tile math for the tile-driven point cloud source.
 *
 * Tile coordinates use the XYZ / "Google" scheme: x increases eastward from the
 * antimeridian, y increases southward from the north edge.
 */

import { clamp, normalizeLng } from './helpers';

/** Latitude beyond which the web-mercator projection is undefined. */
const MERCATOR_MAX_LATITUDE = 85.051129;

/** Bounds as `ViewportInfo` expresses them: [west, south, east, north]. */
export type LngLatBounds = [ number, number, number, number ];

/** An inclusive rectangle of tile coordinates at a single zoom. */
export interface TileRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export class TileId {
  constructor(
    readonly z: number,
    readonly x: number,
    readonly y: number,
  ) {}

  get key(): string {
    return `${this.z}/${this.x}/${this.y}`;
  }
}

/** Tile X index containing a longitude. */
export function lngToTileX(lng: number, zoom: number): number {
  const scale = Math.pow(2, zoom);
  const x = Math.floor(((normalizeLng(lng) + 180) / 360) * scale);
  return Math.max(0, Math.min(scale - 1, x));
}

/** Tile Y index containing a latitude. */
export function latToTileY(lat: number, zoom: number): number {
  const scale = Math.pow(2, zoom);
  const latRad = (clamp(lat, -MERCATOR_MAX_LATITUDE, MERCATOR_MAX_LATITUDE) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale);
  return Math.max(0, Math.min(scale - 1, y));
}

/** West edge of a tile column, in degrees. */
export function tileXToLng(x: number, zoom: number): number {
  return (x / Math.pow(2, zoom)) * 360 - 180;
}

/** North edge of a tile row, in degrees. */
export function tileYToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** Center of a tile as [lng, lat]. */
export function tileCenter(tile: TileId): [ number, number ] {
  const west = tileXToLng(tile.x, tile.z);
  const east = tileXToLng(tile.x + 1, tile.z);
  const north = tileYToLat(tile.y, tile.z);
  const south = tileYToLat(tile.y + 1, tile.z);
  return [ (west + east) / 2, (north + south) / 2 ];
}

/**
 * Grows bounds outward by a factor of their own width and height on each side, so 0.5
 * doubles the width and height.
 */
export function extendBoundsOutwardByFactor(bounds: LngLatBounds, factor: number): LngLatBounds {
  const [ west, south, east, north ] = bounds;
  const dE = (east - west) * factor;
  const dN = (north - south) * factor;
  return [ west - dE, south - dN, east + dE, north + dN ];
}

export function getTileRangeForBounds(bounds: LngLatBounds, zoom: number): TileRange {
  const [ west, south, east, north ] = bounds;
  return {
    minX: lngToTileX(west, zoom),
    maxX: lngToTileX(east, zoom),
    minY: latToTileY(north, zoom),
    maxY: latToTileY(south, zoom),
  };
}

export function rangeContainsTileInclusive(range: TileRange, tile: TileId): boolean {
  return tile.x >= range.minX && tile.x <= range.maxX && tile.y >= range.minY && tile.y <= range.maxY;
}

/** Every tile in the range, nearest to `center` first. */
export function enumerateTileRange(
  range: TileRange,
  center: [ number, number ],
  zoom: number,
): TileId[] {
  const tiles: { tile: TileId, distance: number }[] = [];
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      const tile = new TileId(zoom, x, y);
      tiles.push({ tile, distance: tileDistanceFrom(tile, center) });
    }
  }
  tiles.sort((a, b) => a.distance - b.distance);
  return tiles.map((entry) => entry.tile);
}

/**
 * Squared planar distance from a point to a tile's center, with longitude scaled by
 * cos(latitude). Only meaningful for ordering.
 */
export function tileDistanceFrom(tile: TileId, center: [ number, number ]): number {
  const [ tileLng, tileLat ] = tileCenter(tile);
  const latScale = Math.cos((center[1] * Math.PI) / 180);
  const dLng = normalizeLng(tileLng - center[0]) * latScale;
  const dLat = tileLat - center[1];
  return dLng * dLng + dLat * dLat;
}
