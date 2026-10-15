import type { ViewportInfo } from '../loaders/streaming-types';
import { enumerateTileRange, extendBoundsOutwardByFactor, getTileRangeForBounds, type LngLatBounds, rangeContainsTileInclusive, tileDistanceFrom, type TileId, type TileRange } from '../utils/tileMath';
import { isEptUrl } from '../utils/helpers';

/**
 * The slice of `LidarControl` the tile source needs.
 */
export interface TilePointCloudHost {
  /**
   * Loads one tile and resolves to its dataset id.
   */
  loadTile(url: string, label: string): Promise<string>;

  /** Tears down a dataset: loader, deck.gl layers and control state. */
  unloadTile(datasetId: string): void;
}

export interface TilePointCloudSourceOptions {
  /**
   * URL template for a tile, with `{z}`, `{x}` and `{y}` placeholders (XYZ scheme).
   * Relative URLs resolve against the page origin.
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
   * Display zoom below which all tiles unload.
   *
   * @default 16
   */
  minZoom?: number;
  /**
   * Cap on simultaneously resident tiles. Each tile has its own point budget, so this is what
   * bounds memory usage.
   *
   * This bounds loads, not probes: when the map moves, probe if each tile in view exists, but only this
   * many ever get loaded. When more tiles exist than fit, the nearest win -- a tile that
   * finishes probing displaces a resident one only if it is closer to the center of the viewport.
   * @default 8
   */
  maxResidentTiles?: number;
  /**
   * Viewport padding for the ring in which tiles load, as a fraction of viewport size.
   * 0.5 adds half the full width to each side, so tiles one screen out are already warm.
   * @default 0
   */
  loadRingFactor?: number;
  /**
   * Padding for the ring outside which tiles unload.
   * @default 0
   */
  evictRingFactor?: number;
  /** Upper bound on remembered absent tiles, so a long session cannot grow unboundedly. */
  maxNegativeCacheEntries?: number;
  /** Base delay before retrying a tile that failed for a reason other than "absent". */
  retryBackoffMs?: number;
}

type ResidentState = 'probing' | 'loading' | 'active';

interface TileEntry {
  tile: TileId;
  state: ResidentState;
  datasetId?: string;
  abort: AbortController;
}

interface ErrorEntry {
  failures: number;
  retryAt: number;
}

const DEFAULTS = {
  url: '',
  tileZoom: 14,
  minZoom: 16,
  maxResidentTiles: 8,
  loadRingFactor: 0,
  evictRingFactor: 0,
  maxNegativeCacheEntries: 4096,
  retryBackoffMs: 5000,
};

/**
 * Loads and unloads per-tile point clouds as the map moves.
 *
 * One instance owns the whole tile lifecycle for the map. Calling {@link update} refreshes the tiles.
 *
 * Tile availability is discovered optimistically. There is no coverage index; each tile is
 * probed, and a 404 puts it in a negative cache that is never retried for the life of the
 * session. Other failures back off exponentially.
 */
export class TilePointCloudSource {
  private readonly _host: TilePointCloudHost;
  private readonly _options: Required<TilePointCloudSourceOptions>;

  /** Tiles that are resident or on their way in, keyed "z/x/y". */
  private readonly _tiles: Map<string, TileEntry> = new Map();
  /** Tiles known to have no data. Insertion-ordered, pruned oldest-first when full. */
  private readonly _missing: Set<string> = new Set();
  /** Tiles that failed for some other reason, with their backoff deadline. */
  private readonly _errors: Map<string, ErrorEntry> = new Map();

  private _lastViewport?: ViewportInfo;
  private _destroyed: boolean = false;

  constructor(host: TilePointCloudHost, options?: Partial<TilePointCloudSourceOptions>) {
    this._host = host;
    this._options = { ...DEFAULTS, ...options };
    if (!this._options.url) {
      throw new Error('TilePointCloudSource requires a tileUrl');
    }

    if(!this._options.tileZoom) {
      throw new Error('TilePointCloudSource requires a tileZoom')
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
   * Runs one pass: unload what has left the evict ring, trim to the resident cap, and
   * start loads for newly visible tiles.
   */
  update(viewport: ViewportInfo): void {
    if (this._destroyed) {
      return;
    }
    this._lastViewport = viewport;

    if (Math.ceil(viewport.zoom) < this._options.minZoom) {
      this.unloadAll();
      return;
    }

    console.log('UPDATE PASS');
    const bounds = viewport.bounds;
    const loadRanges = this._rangesFor(bounds, this._options.loadRingFactor);
    const evictRanges = this._rangesFor(bounds, this._options.evictRingFactor);

    this._evictOutsideRanges(evictRanges);
    this._enforceResidentCap(viewport.center);
    this._startLoads(loadRanges, viewport);
  }

  /** Drops every tile, keeping the negative cache so absent tiles are not re-probed. */
  unloadAll(): void {
    for (const entry of this._tiles.values()) {
      this._unload(entry);
    }
  }

  destroy(): void {
    this._destroyed = true;
    this.unloadAll();
    this._missing.clear();
    this._errors.clear();
  }

  private _rangesFor(bounds: LngLatBounds, factor: number): TileRange {
    return getTileRangeForBounds(factor > 0 ? extendBoundsOutwardByFactor(bounds, factor) : bounds, this._options.tileZoom);
  }

  private _evictOutsideRanges(evictRanges: TileRange): void {
    for (const entry of Array.from(this._tiles.values())) {
      if (!rangeContainsTileInclusive(evictRanges, entry.tile)) {
        this._unload(entry);
      }
    }
  }

  /**
   * Tiles that are loaded, or are about to be.
   */
  private _committedTiles(): TileEntry[] {
    return Array.from(this._tiles.values()).filter(
      (entry) => entry.state === 'loading' || entry.state === 'active',
    );
  }

  /**
   * Unloads the tiles furthest from the viewport center until the committed count is back
   * within the cap.
   */
  private _enforceResidentCap(center: [ number, number ]): void {
    const committed = this._committedTiles();
    const excess = committed.length - this._options.maxResidentTiles;
    if (excess <= 0) {
      return;
    }
    const byDistance = committed.sort(
      (a, b) =>
        tileDistanceFrom(b.tile, center) -
        tileDistanceFrom(a.tile, center),
    );
    for (let i = 0; i < excess; i++) {
      this._unload(byDistance[i]);
    }
  }

  /**
   * Probes every tile in the ring that has not been asked about yet to determine
   * if each tile exists.
   */
  private _startLoads(loadRange: TileRange, viewport: ViewportInfo): void {
    const now = Date.now();
    for (const tile of enumerateTileRange(loadRange, viewport.center, this._options.tileZoom)) {
      const key = tile.key;
      if (this._tiles.has(key) || this._missing.has(key)) {
        if (this._tiles.has(key)) {
          console.log('ALREADY LOADED ' + key);
        } else {
          console.log('KNOWN MISSING ' + key);
        }
        continue;
      }
      const failure = this._errors.get(key);
      if (failure != null && failure.retryAt > now) {
        continue;
      }
      this._beginLoad(tile);
    }
  }

  /**
   * Takes one of the `maxResidentTiles` slots for `entry`, displacing a further tile if
   * they are all taken.
   */
  private _claimResidencySlot(entry: TileEntry): boolean {
    const committed = this._committedTiles();
    if (committed.length < this._options.maxResidentTiles) {
      return true;
    }
    if (this._lastViewport == null) {
      return false;
    }
    const center = this._lastViewport.center;
    let furthest = committed[0];
    for (const candidate of committed) {
      if (tileDistanceFrom(candidate.tile, center) > tileDistanceFrom(furthest.tile, center)) {
        furthest = candidate;
      }
    }
    if (tileDistanceFrom(furthest.tile, center) <= tileDistanceFrom(entry.tile, center)) {
      return false;
    }
    this._unload(furthest);
    return true;
  }

  private _beginLoad(tile: TileId): void {
    const entry: TileEntry = {
      tile,
      state: 'probing',
      abort: new AbortController(),
    };
    console.log('PROBING ' + JSON.stringify(tile));
    this._tiles.set(tile.key, entry);
    void this._loadTile(entry);
  }

  private async _loadTile(entry: TileEntry): Promise<void> {
    const url = this.getTileUrl(entry.tile);
    try {
      const status = await this._probe(url, entry.abort.signal);
      if (this._destroyed) {
        return;
      }

      if (status === 404) {
        console.log('MISSING ' + JSON.stringify(entry.tile));
        // The tileset does not have this tile. Remember it and never ask again -- including
        // when this entry has already been superseded.
        this._forget(entry);
        this._rememberMissing(entry.tile.key);
        return;
      }

      // Past this point the work only matters if the tile is still wanted.
      if (this._isStale(entry)) {
        return;
      }
      if (status >= 400) {
        // TODO need retry at the moment?
        this._recordFailure(entry, new Error(`tile probe failed with status ${status}`));
        return;
      }

      if (!this._claimResidencySlot(entry)) {
        // The tile exists, but nearer ones have taken every slot. Forget the entry rather
        // than recording it: it stays a candidate, and the re-probe is a browser cache hit.
        this._tiles.delete(entry.tile.key);
        return;
      }

      console.log('LOADING ' + JSON.stringify(entry.tile));
      entry.state = 'loading';
      const datasetId = await this._host.loadTile(url, entry.tile.key);

      if (this._isStale(entry)) {
        // The tile left the ring while its header was loading; drop what we just built.
        this._host.unloadTile(datasetId);
        return;
      }

      console.log('LOADED ' + JSON.stringify(entry.tile));
      entry.datasetId = datasetId;
      entry.state = 'active';
      this._errors.delete(entry.tile.key);
    } catch (err) {
      if (entry.abort.signal.aborted || this._isStale(entry)) {
        return;
      }
      this._recordFailure(entry, err instanceof Error ? err : new Error(String(err)));
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

  private _rememberMissing(key: string): void {
    this._missing.add(key);
    while (this._missing.size > this._options.maxNegativeCacheEntries) {
      const oldest = this._missing.values().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this._missing.delete(oldest);
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
    console.log('UNLOADING ' + JSON.stringify(entry.tile));
    entry.abort.abort();
    this._tiles.delete(entry.tile.key);
    if (entry.datasetId != null) {
      this._host.unloadTile(entry.datasetId);
    }
  }
}

/**
 * Resolves an origin-relative path against the current origin.
 */
function toAbsoluteUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  return `${window.location.origin}${path.startsWith('/') ? '' : '/'}${path}`;
}
