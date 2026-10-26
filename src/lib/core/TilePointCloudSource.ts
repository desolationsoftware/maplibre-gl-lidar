import type { ViewportInfo } from '../loaders/streaming-types';
import { enumerateTileRange, extendBoundsOutwardByFactor, getTileRangeForBounds, rangeContainsTileInclusive, type TileId } from '../utils/tileMath';
import { isEptUrl, VIEWPORT_BUFFER_FACTOR } from '../utils/helpers';

/**
 * The slice of `LidarControl` the tile source needs.
 */
export interface TilePointCloudHost {
  /**
   * Loads one tile and resolves to its dataset id. Once `signal` aborts, the load should
   * stop and reject without adding the tile to the map.
   */
  loadTile(url: string, label: string, signal: AbortSignal, pointBudget: number): Promise<string>;

  /** Tears down a dataset: loader, deck.gl layers and control state. */
  unloadTile(datasetId: string): void;

  /** Changes a loaded tile's point budget, dropping points past it if it shrank. */
  setTileBudget(datasetId: string, pointBudget: number): void;
}

export interface TilePointCloudSourceOptions {
  /**
   * URL template for a tile, with `{z}`, `{x}` and `{y}` placeholders (XYZ scheme).
   * Relative URLs resolve against the page URL.
   *
   * The format is inferred from the URL the same way as for a single load: a URL ending
   * in `ept.json` streams as EPT, a `.copc.` file streams as COPC, and anything else
   * (plain LAS/LAZ) is downloaded whole.
   *
   * @example 'https://example.com/tiles/{z}/{x}/{y}.copc.laz'
   * @example 'https://example.com/tiles/{z}-{x}-{y}/ept.json'
   */
  url?: string;
  /**
   * Zoom of the tile pyramid the point clouds are published at. Fixed, independent of the
   * display zoom.
   *
   * @default 14
   */
  tileZoom?: number;
  /**
   * Display zoom below which all tiles unload. Also what bounds how many tiles load at once.
   *
   * @default 15
   */
  minZoom?: number;
  /**
   * Points shared across all loaded tiles, which is what bounds memory usage. Split
   * equally among the tiles loaded at the time, so fewer tiles each get more.
   *
   * @default 80000000
   */
  pointBudget?: number;
  /** Upper bound on remembered absent and present tiles, so a long session cannot grow unboundedly. */
  maxNegativeCacheEntries?: number;
  /** Base delay before retrying a tile that failed for a reason other than "absent". */
  retryBackoffMs?: number;
}

type TileState = 'probing' | 'loading' | 'active';

interface TileEntry {
  tile: TileId;
  state: TileState;
  datasetId?: string;
  /** This tile's share of the point budget, as last given to its loader. */
  pointBudget?: number;
  abort: AbortController;
}

interface ErrorEntry {
  failures: number;
  retryAt: number;
}

const DEFAULTS = {
  url: '',
  tileZoom: 14,
  minZoom: 15,
  pointBudget: 80_000_000,
  maxNegativeCacheEntries: 4096,
  retryBackoffMs: 5000,
};

/**
 * Buffer around the viewport within which tiles load. Smaller than the buffer they unload
 * outside of, so tiles at the edge aren't loaded and unloaded as the map rotates.
 */
const LOAD_BUFFER_FACTOR = 0.1;

/**
 * Loads and unloads per-tile point clouds as the map moves.
 *
 * One instance owns the whole tile lifecycle for the map. Calling {@link update} refreshes the tiles.
 *
 * Tile availability is discovered optimistically. There is no coverage index; each tile is
 * probed, and a client error (see {@link isAbsentStatus}) puts it in a negative cache that is
 * never retried for the life of the session. Other failures back off exponentially.
 */
export class TilePointCloudSource {
  private readonly _host: TilePointCloudHost;
  private readonly _options: Required<TilePointCloudSourceOptions>;

  /** Tiles that are loaded or on their way in, keyed "z/x/y". */
  private readonly _tiles: Map<string, TileEntry> = new Map();
  /** Tiles known to have no data. Insertion-ordered, pruned oldest-first when full. */
  private readonly _missing: Set<string> = new Set();
  /** Tiles known to have data, so they are not probed again. Pruned like `_missing`. */
  private readonly _present: Set<string> = new Set();
  /** Tiles that failed for some other reason, with their backoff deadline. */
  private readonly _errors: Map<string, ErrorEntry> = new Map();

  private _destroyed: boolean = false;

  constructor(host: TilePointCloudHost, options?: Partial<TilePointCloudSourceOptions>) {
    this._host = host;
    this._options = { ...DEFAULTS, ...options };
    if (!this._options.url) {
      throw new Error('TilePointCloudSource requires a url');
    }
    if (!Number.isInteger(this._options.tileZoom) || this._options.tileZoom < 0) {
      throw new Error(`TilePointCloudSource tileZoom must be a non-negative integer, got ${this._options.tileZoom}`);
    }
  }

  getTileUrl(tile: TileId): string {
    const path = this._options.url
      .replace(/\{z\}/g, String(tile.z))
      .replace(/\{x\}/g, String(tile.x))
      .replace(/\{y\}/g, String(tile.y));
    return toAbsoluteUrl(path);
  }

  /**
   * Runs one pass: unloads tiles that have left the viewport, and probes or loads newly
   * visible ones, nearest the center first.
   */
  update(viewport: ViewportInfo): void {
    if (this._destroyed) {
      return;
    }

    if (viewport.zoom < this._options.minZoom) {
      this.unloadAll();
      return;
    }

    const zoom = this._options.tileZoom;
    // Same buffer the loaders keep nodes within, so a tile isn't dropped while its nodes are still wanted.
    const keepRange = getTileRangeForBounds(extendBoundsOutwardByFactor(viewport.bounds, VIEWPORT_BUFFER_FACTOR), zoom);
    const loadRange = getTileRangeForBounds(extendBoundsOutwardByFactor(viewport.bounds, LOAD_BUFFER_FACTOR), zoom);

    for (const entry of Array.from(this._tiles.values())) {
      if (!rangeContainsTileInclusive(keepRange, entry.tile)) {
        this._unload(entry);
      }
    }

    const now = Date.now();
    for (const tile of enumerateTileRange(loadRange, viewport.center, zoom)) {
      const key = tile.key;
      if (this._tiles.has(key) || this._missing.has(key)) {
        continue;
      }
      const failure = this._errors.get(key);
      if (failure != null && failure.retryAt > now) {
        continue;
      }
      const entry: TileEntry = { tile, state: 'probing', abort: new AbortController() };
      this._tiles.set(key, entry);
      if (this._present.has(key)) {
        void this._loadTile(entry);
      } else {
        void this._probeTile(entry);
      }
    }

    this._rebalanceBudgets();
  }

  /** Drops every tile, keeping the absent and present caches so tiles are not re-probed. */
  unloadAll(): void {
    for (const entry of this._tiles.values()) {
      this._unload(entry);
    }
  }

  destroy(): void {
    this._destroyed = true;
    this.unloadAll();
    this._missing.clear();
    this._present.clear();
    this._errors.clear();
  }

  private async _probeTile(entry: TileEntry): Promise<void> {
    try {
      const status = await this._probe(this.getTileUrl(entry.tile), entry.abort.signal);
      if (this._destroyed) {
        return;
      }

      if (isAbsentStatus(status)) {
        // The tileset does not have this tile. Remember it and never ask again -- including
        // when this entry has already been superseded.
        this._forget(entry);
        this._rememberBounded(this._missing, entry.tile.key);
        return;
      }

      if (status < 400) {
        this._rememberBounded(this._present, entry.tile.key);
      }

      // Past this point the work only matters if the tile is still wanted.
      if (this._isStale(entry)) {
        return;
      }
      if (status >= 400) {
        this._recordFailure(entry, new Error(`tile probe failed with status ${status}`));
        return;
      }

      void this._loadTile(entry);
      this._rebalanceBudgets();
    } catch (err) {
      if (entry.abort.signal.aborted || this._isStale(entry)) {
        return;
      }
      this._recordFailure(entry, err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async _loadTile(entry: TileEntry): Promise<void> {
    entry.state = 'loading';
    entry.pointBudget = this._tileBudget();
    try {
      const datasetId = await this._host.loadTile(
        this.getTileUrl(entry.tile),
        entry.tile.key,
        entry.abort.signal,
        entry.pointBudget,
      );

      if (this._isStale(entry)) {
        // The tile was unloaded while its header was loading; drop what we just built.
        this._host.unloadTile(datasetId);
        return;
      }

      entry.datasetId = datasetId;
      entry.state = 'active';
      this._errors.delete(entry.tile.key);
      this._rebalanceBudgets();
    } catch (err) {
      if (entry.abort.signal.aborted || this._isStale(entry)) {
        return;
      }
      this._recordFailure(entry, err instanceof Error ? err : new Error(String(err)));
      this._rebalanceBudgets();
    }
  }

  /** Each loaded or loading tile's equal share of the point budget. */
  private _tileBudget(): number {
    let tiles = 0;
    for (const entry of this._tiles.values()) {
      if (entry.state !== 'probing') {
        tiles++;
      }
    }
    return Math.floor(this._options.pointBudget / Math.max(1, tiles));
  }

  /**
   * Gives every active tile its current share of the point budget. Tiles still loading
   * are updated once they become active.
   */
  private _rebalanceBudgets(): void {
    const share = this._tileBudget();
    for (const entry of this._tiles.values()) {
      if (entry.state === 'active' && entry.datasetId != null && entry.pointBudget !== share) {
        entry.pointBudget = share;
        this._host.setTileBudget(entry.datasetId, share);
      }
    }
  }

  /**
   * Finds out whether a tile exists, as cheaply as the format allows.
   */
  private async _probe(url: string, signal: AbortSignal): Promise<number> {
    if (isEptUrl(url)) {
      return (await fetch(url, { signal })).status;
    }
    const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal });
    // A server that ignores Range sends the whole file; don't download it twice.
    void response.body?.cancel();
    return response.status;
  }

  /**
   * True once this entry has been superseded or unloaded, so its result is worthless.
   */
  private _isStale(entry: TileEntry): boolean {
    return this._destroyed || this._tiles.get(entry.tile.key) !== entry;
  }

  private _rememberBounded(set: Set<string>, key: string): void {
    set.delete(key);
    set.add(key);
    while (set.size > this._options.maxNegativeCacheEntries) {
      const oldest = set.values().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      set.delete(oldest);
    }
  }

  private _recordFailure(entry: TileEntry, error: Error): void {
    this._tiles.delete(entry.tile.key);
    const previous = this._errors.get(entry.tile.key);
    const failures = (previous?.failures ?? 0) + 1;
    this._errors.set(entry.tile.key, {
      failures,
      retryAt: Date.now() + this._options.retryBackoffMs * Math.pow(2, Math.min(failures - 1, 5)),
    });
    console.warn(`Point cloud tile ${entry.tile.key} failed to load:`, error.message);
  }

  /**
   * Drops the entry if it already exists in the tracked _tiles
   */
  private _forget(entry: TileEntry): void {
    if (this._tiles.get(entry.tile.key) === entry) {
      this._tiles.delete(entry.tile.key);
    }
  }

  private _unload(entry: TileEntry): void {
    entry.abort.abort();
    this._tiles.delete(entry.tile.key);
    if (entry.datasetId != null) {
      this._host.unloadTile(entry.datasetId);
    }
  }
}

/**
 * Whether a probe status means the tile does not exist. Any 4xx counts besides 408 and 429
 */
function isAbsentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Resolves a possibly relative URL against the page URL.
 */
function toAbsoluteUrl(url: string): string {
  return new URL(url, window.location.href).href;
}
