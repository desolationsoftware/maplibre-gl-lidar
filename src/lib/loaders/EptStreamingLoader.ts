import { Las } from 'copc';
import proj4 from 'proj4';
import type { NodeKey, StreamingLoaderEvent, StreamingLoaderEventHandler, StreamingLoaderOptions, StreamingProgressEvent, ViewportInfo } from './streaming-types';
import type { EptCachedNode, EptDimension, EptHierarchy, EptMetadata, ParsedDimension } from './ept-types';
import type { AttributeArray, ExtraPointAttributes, PointCloudData, PointNodeRange } from './types';
import type { PointCloudBounds } from '../core/types';
import { getLazPerf } from './CopcStreamingLoader';
import { type BudgetCandidate, clampLatLng, compareNodePriority, loadedKeysWithinBudget, nodeLoadPriority, VIEWPORT_BUFFER_FACTOR } from '../utils/helpers';
import { copyViewPoints, type PointTarget } from './viewPoints';
import { fittedCapacity, grownCapacity, initialCapacity, resizedArray } from './pointBuffers';

/**
 * Configuration for attribute storage types
 */
interface AttributeConfig {
  arrayType: 'float64' | 'float32' | 'uint32' | 'uint16' | 'uint8' | 'int32' | 'int16' | 'int8';
}

/**
 * Known LAS dimension configurations
 */
const DIMENSION_CONFIGS: Record<string, AttributeConfig> = {
  'GpsTime': { arrayType: 'float64' },
  'ReturnNumber': { arrayType: 'uint8' },
  'NumberOfReturns': { arrayType: 'uint8' },
  'ScanDirectionFlag': { arrayType: 'uint8' },
  'EdgeOfFlightLine': { arrayType: 'uint8' },
  'ScanAngleRank': { arrayType: 'int8' },
  'ScanAngle': { arrayType: 'float32' },
  'UserData': { arrayType: 'uint8' },
  'PointSourceId': { arrayType: 'uint16' },
  'ScannerChannel': { arrayType: 'uint8' },
  'Synthetic': { arrayType: 'uint8' },
  'KeyPoint': { arrayType: 'uint8' },
  'Withheld': { arrayType: 'uint8' },
  'Overlap': { arrayType: 'uint8' },
  'ClassFlags': { arrayType: 'uint8' },
  'Nir': { arrayType: 'uint16' },
  'NearInfrared': { arrayType: 'uint16' },
  'OriginId': { arrayType: 'uint32' },
};

/**
 * Core dimensions that are handled separately
 */
const CORE_DIMENSIONS = new Set([
  'X', 'Y', 'Z',
  'Intensity',
  'Classification',
  'Red', 'Green', 'Blue',
]);

/**
 * Creates a typed array of the appropriate type
 */
function createAttributeArray(type: AttributeConfig['arrayType'], length: number): AttributeArray {
  switch (type) {
    case 'float64': return new Float64Array(length);
    case 'float32': return new Float32Array(length);
    case 'uint32': return new Uint32Array(length);
    case 'uint16': return new Uint16Array(length);
    case 'uint8': return new Uint8Array(length);
    case 'int32': return new Int32Array(length);
    case 'int16': return new Int16Array(length);
    case 'int8': return new Int8Array(length);
    default: return new Float32Array(length);
  }
}

/** How long a node that failed to load waits before it is tried again. */
const NODE_RETRY_COOLDOWN_MS = 5000;

/** copc.js's Las.Header.parse requires at least the length of a LAS 1.4 header. */
const MIN_LAS_HEADER_LENGTH = 375;

/**
 * Extracts the PROJCS section from a WKT string (handles COMPD_CS)
 */
function extractProjcsFromWkt(wkt: string): string {
  if (wkt.startsWith('COMPD_CS[')) {
    const projcsStart = wkt.indexOf('PROJCS[');
    if (projcsStart === -1) return wkt;

    let depth = 0;
    let projcsEnd = projcsStart;
    for (let i = projcsStart; i < wkt.length; i++) {
      if (wkt[i] === '[') depth++;
      if (wkt[i] === ']') {
        depth--;
        if (depth === 0) {
          projcsEnd = i + 1;
          break;
        }
      }
    }
    return wkt.substring(projcsStart, projcsEnd);
  }
  return wkt;
}

/**
 * Detects if the WKT uses feet as the linear unit
 */
function getVerticalUnitConversionFactor(wkt: string): number {
  const FEET_TO_METERS = 0.3048;
  const US_SURVEY_FEET_TO_METERS = 0.3048006096012192;

  const wktLower = wkt.toLowerCase();

  if (wktLower.includes('us survey foot') ||
      wktLower.includes('us_survey_foot') ||
      wktLower.includes('foot_us')) {
    return US_SURVEY_FEET_TO_METERS;
  }

  const footPatterns = [
    /unit\s*\[\s*"foot/i,
    /unit\s*\[\s*"international foot/i,
    /,\s*foot\s*\]/i,
    /"ft"/i,
  ];

  for (const pattern of footPatterns) {
    if (pattern.test(wkt)) {
      return FEET_TO_METERS;
    }
  }

  return 1.0;
}

/**
 * How long loaded nodes accumulate before the layer is rebuilt.
 */
const LAYER_UPDATE_BATCH_MS = 100;

/**
 * Default options for streaming loader
 */
const DEFAULT_OPTIONS: Required<StreamingLoaderOptions> = {
  pointBudget: 5_000_000,
  maxConcurrentRequests: 8,
  viewportDebounceMs: 100,
  minDetailZoom: 10,
  maxOctreeDepth: 20,
  maxSubtreesPerViewport: 60,
};

/**
 * Streams Entwine Point Tile (EPT) data on-demand based on viewport.
 * Loads coarse-to-fine, center-first within each depth, and respects point budget.
 *
 * EPT format uses:
 * - ept.json for metadata
 * - ept-hierarchy/ for octree node structure
 * - ept-data/ for point data (LAZ or binary)
 */
export class EptStreamingLoader {
  private _baseUrl: string;
  private _options: Required<StreamingLoaderOptions>;
  private _metadata: EptMetadata | null = null;
  private readonly _abort = new AbortController();

  // Hierarchy cache
  private _hierarchyCache: Map<string, EptHierarchy> = new Map();
  private _hierarchyLoading: Set<string> = new Set();
  private _hierarchyFailures: Map<string, number> = new Map();
  private _subtreeRoots: Set<string> = new Set();
  private _rootHierarchyLoaded: boolean = false;

  // Node cache
  private _nodeCache: Map<string, EptCachedNode> = new Map();

  // Point data buffers
  /** Points the buffers have room for. Grows as points load and shrinks on eviction. */
  private _capacity: number = 0;
  private _positions: Float32Array | null = null;
  private _colors: Uint8Array | null = null;
  private _intensities: Float32Array | null = null;
  private _classifications: Uint8Array | null = null;
  private _extraAttributes: ExtraPointAttributes = {};
  private _coordinateOrigin: [number, number, number] = [0, 0, 0];
  private _bounds: PointCloudBounds | null = null;

  // Loading state
  private _loadingQueue: EptCachedNode[] = [];
  /** Nodes between the start of their fetch and the end of their decode. */
  private _activeRequests: number = 0;
  /**
   * Nodes whose data is still downloading.
   * This is what `maxConcurrentRequests` caps
   */
  private _activeFetches: number = 0;
  /**
   * Points of the nodes still downloading. They count against the point budget, but their
   * buffer space is only reserved once their bytes arrive, so a download that fails or is
   * aborted never leaves a hole beneath nodes that reserved after it.
   */
  private _fetchingPoints: number = 0;
  /** In-flight node downloads, so ones the viewport has left can be abandoned. */
  private _nodeFetchControllers: Map<EptCachedNode, AbortController> = new Map();
  private _paused = false;
  private _hasReservationGaps = false;
  private _totalLoadedPoints: number = 0;
  private _totalLoadedNodes: number = 0;
  private _isInitialized: boolean = false;

  // Coordinate transformation
  private _transformer: ((coord: [number, number]) => [number, number]) | null = null;
  private _verticalUnitFactor: number = 1.0;
  private _needsTransform: boolean = false;
  private _spacingInMeters: number = 0;

  // Point format info
  private _hasColor: boolean = false;
  private _hasIntensity: boolean = false;
  private _totalPointsInFile: number = 0;
  private _pointByteLength: number = 0;
  private _parsedSchema: ParsedDimension[] = [];

  // Extra dimensions detection
  private _availableDimensions: Set<string> = new Set();
  private _dimensionsDetected: boolean = false;

  // Events
  private _eventHandlers: Map<StreamingLoaderEvent, Set<StreamingLoaderEventHandler>> = new Map();

  // Batched layer update
  private _pendingLayerUpdate: boolean = false;
  private _updateBatchTimeout: ReturnType<typeof setTimeout> | null = null;
  private _onPointsLoaded?: (data: PointCloudData) => void;
  private _isResetting: boolean = false;

  /**
   * Creates a new EptStreamingLoader instance.
   *
   * @param eptUrl - URL to ept.json or base EPT directory
   * @param options - Streaming options
   */
  constructor(eptUrl: string, options?: StreamingLoaderOptions) {
    // Normalize base URL (remove trailing /ept.json if present)
    this._baseUrl = eptUrl.endsWith('/ept.json')
      ? eptUrl.slice(0, -9)
      : eptUrl.replace(/\/$/, '');
    this._options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Initializes the EPT dataset - reads metadata and root hierarchy.
   * Must be called before any loading operations.
   *
   * @returns Initial info about the point cloud
   */
  async initialize(signal?: AbortSignal): Promise<{
    bounds: PointCloudBounds;
    totalPoints: number;
    hasRGB: boolean;
    spacing: number;
  }> {
    try {
      const response = await fetch(`${this._baseUrl}/ept.json`, { signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch ept.json: ${response.status} ${response.statusText}`);
      }
      this._metadata = await response.json() as EptMetadata;
    } catch (error) {
      if (error instanceof TypeError && error.message === 'Failed to fetch') {
        throw new Error(
          `Failed to fetch from URL. This is likely a CORS (Cross-Origin Resource Sharing) error. ` +
          `The server doesn't allow requests from this origin. ` +
          `Solutions: (1) Use a CORS proxy, or (2) Host the EPT data on a CORS-enabled server.`
        );
      }
      throw error;
    }

    // Handle both 'numPoints' (standard) and 'points' (some older versions)
    this._totalPointsInFile = this._metadata.numPoints ?? (this._metadata as unknown as { points?: number }).points ?? 0;

    // Parse schema to build dimension getters
    this._parseSchema();

    // Check for color and intensity
    this._hasColor = this._parsedSchema.some(p => p.dimension.name === 'Red');
    this._hasIntensity = this._parsedSchema.some(p => p.dimension.name === 'Intensity');

    // Setup coordinate transformation if WKT is available
    if (this._metadata.srs?.wkt) {
      try {
        const wktToUse = extractProjcsFromWkt(this._metadata.srs.wkt);
        const projConverter = proj4(wktToUse, 'EPSG:4326');
        this._transformer = (coord: [number, number]) =>
          projConverter.forward(coord) as [number, number];
        this._needsTransform = true;
        this._verticalUnitFactor = getVerticalUnitConversionFactor(this._metadata.srs.wkt);
      } catch (e) {
        console.warn('Failed to setup EPT coordinate transformation:', e);
      }
    }

    // Calculate bounds from boundsConforming (tighter bounds)
    const [minX, minY, minZ, maxX, maxY, maxZ] = this._metadata.boundsConforming;

    if (this._needsTransform && this._transformer) {
      const [rawMinLng, rawMinLat] = this._transformer([minX, minY]);
      const [rawMaxLng, rawMaxLat] = this._transformer([maxX, maxY]);

      // Validate transformed coordinates
      if (isNaN(rawMinLng) || isNaN(rawMinLat) || isNaN(rawMaxLng) || isNaN(rawMaxLat) ||
          !isFinite(rawMinLng) || !isFinite(rawMinLat) || !isFinite(rawMaxLng) || !isFinite(rawMaxLat)) {
        console.error('EPT coordinate transformation produced invalid bounds:', {
          input: { minX, minY, maxX, maxY },
          output: { rawMinLng, rawMinLat, rawMaxLng, rawMaxLat }
        });
        // Fall back to source coordinates
        this._bounds = { minX, minY, minZ, maxX, maxY, maxZ };
        this._needsTransform = false;
        this._transformer = null;
      } else {
        // Clamp transformed coordinates to valid WGS84 range
        const [minLng, minLat] = clampLatLng(rawMinLng, rawMinLat, 'header bounds min');
        const [maxLng, maxLat] = clampLatLng(rawMaxLng, rawMaxLat, 'header bounds max');

        this._bounds = {
          minX: Math.min(minLng, maxLng),
          minY: Math.min(minLat, maxLat),
          minZ: minZ * this._verticalUnitFactor,
          maxX: Math.max(minLng, maxLng),
          maxY: Math.max(minLat, maxLat),
          maxZ: maxZ * this._verticalUnitFactor,
        };
      }
    } else {
      this._bounds = { minX, minY, minZ, maxX, maxY, maxZ };
    }

    // Coordinate origin is the center of the bounding box
    this._coordinateOrigin = [
      (this._bounds.minX + this._bounds.maxX) / 2,
      (this._bounds.minY + this._bounds.maxY) / 2,
      0,
    ];

    // Pre-allocate buffers
    this._allocateBuffers();

    this._isInitialized = true;

    // Calculate spacing from bounds and span
    const cubeSize = this._metadata.bounds[3] - this._metadata.bounds[0];
    const spacing = cubeSize / this._metadata.span;


    // Convert spacing to meters. When the source CRS is geographic (lng/lat
    // in degrees), info.spacing is in degrees and must be converted before it
    // can be compared to screen ground resolution in meters. We detect a
    // geographic source as one where no projection transformation was set up
    // and the header bounds fall within valid lng/lat ranges.
    const isGeographic =
      !this._needsTransform &&
      Math.abs(minX) <= 180 &&
      Math.abs(maxX) <= 180 &&
      Math.abs(minY) <= 90 &&
      Math.abs(maxY) <= 90;
    if (isGeographic) {
      const centerLat = (this._bounds.minY + this._bounds.maxY) / 2;
      const metersPerDegreeLng = 111320 * Math.cos((centerLat * Math.PI) / 180);
      this._spacingInMeters = spacing * Math.max(metersPerDegreeLng, 1);
    } else {
      this._spacingInMeters = spacing;
    }

    return {
      bounds: this._bounds,
      totalPoints: this._totalPointsInFile,
      hasRGB: this._hasColor,
      spacing: this._spacingInMeters,
    };
  }

  /**
   * Parses the EPT schema and builds dimension getters.
   */
  private _parseSchema(): void {
    if (!this._metadata) return;

    let byteOffset = 0;
    this._parsedSchema = [];

    for (const dim of this._metadata.schema) {
      const getter = this._createDimensionGetter(dim, byteOffset);
      this._parsedSchema.push({
        dimension: dim,
        byteOffset,
        getter,
      });
      byteOffset += dim.size;
    }

    this._pointByteLength = byteOffset;
  }

  /**
   * Creates a getter function for a dimension.
   *
   * @param dim - Dimension definition
   * @param offset - Byte offset within point record
   * @returns Getter function
   */
  private _createDimensionGetter(
    dim: EptDimension,
    offset: number
  ): (dataView: DataView, pointByteOffset: number) => number {
    const scale = dim.scale ?? 1;
    const dimOffset = dim.offset ?? 0;

    if (dim.type === 'float') {
      if (dim.size === 4) {
        return (dv, po) => dv.getFloat32(po + offset, true) * scale + dimOffset;
      }
      if (dim.size === 8) {
        return (dv, po) => dv.getFloat64(po + offset, true) * scale + dimOffset;
      }
    } else if (dim.type === 'signed') {
      if (dim.size === 1) {
        return (dv, po) => dv.getInt8(po + offset) * scale + dimOffset;
      }
      if (dim.size === 2) {
        return (dv, po) => dv.getInt16(po + offset, true) * scale + dimOffset;
      }
      if (dim.size === 4) {
        return (dv, po) => dv.getInt32(po + offset, true) * scale + dimOffset;
      }
      if (dim.size === 8) {
        // JavaScript doesn't have native int64, use BigInt
        return (dv, po) => Number(dv.getBigInt64(po + offset, true)) * scale + dimOffset;
      }
    } else { // unsigned
      if (dim.size === 1) {
        return (dv, po) => dv.getUint8(po + offset) * scale + dimOffset;
      }
      if (dim.size === 2) {
        return (dv, po) => dv.getUint16(po + offset, true) * scale + dimOffset;
      }
      if (dim.size === 4) {
        return (dv, po) => dv.getUint32(po + offset, true) * scale + dimOffset;
      }
      if (dim.size === 8) {
        return (dv, po) => Number(dv.getBigUint64(po + offset, true)) * scale + dimOffset;
      }
    }

    return () => 0;
  }

  /**
   * Pre-allocates buffers for the point budget.
   */
  private _allocateBuffers(): void {
    const capacity = initialCapacity(this._options.pointBudget);
    this._positions = new Float32Array(capacity * 3);
    this._intensities = new Float32Array(capacity);
    this._classifications = new Uint8Array(capacity);
    if (this._hasColor) {
      this._colors = new Uint8Array(capacity * 4);
    }
    this._capacity = capacity;
  }

  /**
   * Reallocates the buffers to hold `capacity` points, keeping every reserved point. Only
   * safe between writes: decodes look the buffers up when they copy points in.
   */
  private _resizeBuffers(capacity: number): void {
    const keep = this._totalLoadedPoints;
    this._positions = resizedArray(this._positions!, capacity * 3, keep * 3);
    this._intensities = resizedArray(this._intensities!, capacity, keep);
    this._classifications = resizedArray(this._classifications!, capacity, keep);
    if (this._colors) {
      this._colors = resizedArray(this._colors, capacity * 4, keep * 4);
    }
    for (const [ name, arr ] of Object.entries(this._extraAttributes)) {
      this._extraAttributes[name] = resizedArray(arr, capacity, keep);
    }
    this._capacity = capacity;
  }

  /** Grows the buffers, if needed, to hold `needed` points. */
  private _ensureCapacity(needed: number): void {
    const capacity = grownCapacity(this._capacity, needed, this._options.pointBudget);
    if (capacity !== this._capacity) {
      console.log(`GROW CAPCITY FROM ${this._capacity} TO ${capacity}`);
      this._resizeBuffers(capacity);
    }
  }

  /** Shrinks the buffers once they are oversized for the loaded points or the budget. */
  private _fitCapacity(): void {
    const capacity = fittedCapacity(this._capacity, this._totalLoadedPoints, this._options.pointBudget);
    if (capacity !== this._capacity) {
      console.log(`SHRINK CAPCITY FROM ${this._capacity} TO ${capacity}`);
      this._resizeBuffers(capacity);
      // The layer holds views of the old buffers until it's updated.
      this._scheduleLayerUpdate();
    }
  }

  /**
   * Gets the octree spacing value in meters (useful for ViewportManager).
   * Always returned in meters even when the source CRS is geographic.
   */
  getSpacing(): number {
    return this._spacingInMeters;
  }

  /**
   * Parses a node key string to array format.
   *
   * @param key - Node key in format "depth-x-y-z"
   * @returns NodeKey array [depth, x, y, z]
   */
  private _parseNodeKey(key: string): NodeKey {
    const parts = key.split('-').map(Number);
    return [parts[0], parts[1], parts[2], parts[3]];
  }

  /**
   * Calculates the bounding box of an octree node.
   *
   * @param key - Node key [depth, x, y, z]
   * @returns Node bounds in source CRS and WGS84
   */
  private _calculateNodeBounds(key: NodeKey): {
    bounds: PointCloudBounds;
    boundsWgs84: PointCloudBounds;
  } {
    if (!this._metadata) {
      throw new Error('Metadata not loaded');
    }

    const [depth, x, y, z] = key;
    const [cubeMinX, cubeMinY, cubeMinZ, cubeMaxX] = this._metadata.bounds;
    const cubeSize = cubeMaxX - cubeMinX;

    // Each level subdivides by 2 in each dimension
    const scale = 1 / Math.pow(2, depth);
    const nodeSize = cubeSize * scale;

    const minX = cubeMinX + x * nodeSize;
    const minY = cubeMinY + y * nodeSize;
    const minZ = cubeMinZ + z * nodeSize;

    const bounds: PointCloudBounds = {
      minX,
      minY,
      minZ,
      maxX: minX + nodeSize,
      maxY: minY + nodeSize,
      maxZ: minZ + nodeSize,
    };

    // Transform to WGS84 for viewport intersection
    let boundsWgs84 = bounds;
    if (this._needsTransform && this._transformer) {
      const [rawSwLng, rawSwLat] = this._transformer([minX, minY]);
      const [rawNeLng, rawNeLat] = this._transformer([minX + nodeSize, minY + nodeSize]);

      // Clamp transformed coordinates to valid WGS84 range
      const [sw_lng, sw_lat] = clampLatLng(rawSwLng, rawSwLat, 'node bounds SW');
      const [ne_lng, ne_lat] = clampLatLng(rawNeLng, rawNeLat, 'node bounds NE');

      boundsWgs84 = {
        minX: Math.min(sw_lng, ne_lng),
        minY: Math.min(sw_lat, ne_lat),
        minZ: minZ * this._verticalUnitFactor,
        maxX: Math.max(sw_lng, ne_lng),
        maxY: Math.max(sw_lat, ne_lat),
        maxZ: (minZ + nodeSize) * this._verticalUnitFactor,
      };
    }

    return { bounds, boundsWgs84 };
  }

  /**
   * Checks if a node's bounds intersect the viewport.
   *
   * @param nodeBounds - Node bounds in WGS84
   * @param viewport - Current viewport info
   * @returns True if bounds intersect
   */
  private _boundsIntersectsViewport(
    nodeBounds: PointCloudBounds,
    viewport: ViewportInfo
  ): boolean {
    const [west, south, east, north] = viewport.bounds;

    // Add a buffer around viewport
    const width = east - west;
    const height = north - south;
    const bufferX = width * VIEWPORT_BUFFER_FACTOR;
    const bufferY = height * VIEWPORT_BUFFER_FACTOR;

    const bufferedWest = west - bufferX;
    const bufferedEast = east + bufferX;
    const bufferedSouth = south - bufferY;
    const bufferedNorth = north + bufferY;

    return !(
      nodeBounds.maxX < bufferedWest ||
      nodeBounds.minX > bufferedEast ||
      nodeBounds.maxY < bufferedSouth ||
      nodeBounds.minY > bufferedNorth
    );
  }

  /**
   * Calculates node priority based on distance from viewport center.
   *
   * @param nodeBounds - Node bounds in WGS84
   * @param viewport - Current viewport info
   * @returns Priority value (lower = higher priority)
   */
  private _calculateNodePriority(
    nodeBounds: PointCloudBounds,
    viewport: ViewportInfo
  ): number {
    const nodeCenterX = (nodeBounds.minX + nodeBounds.maxX) / 2;
    const nodeCenterY = (nodeBounds.minY + nodeBounds.maxY) / 2;

    const dx = nodeCenterX - viewport.center[0];
    const dy = nodeCenterY - viewport.center[1];

    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Loads hierarchy from a hierarchy JSON file.
   *
   * @param key - Hierarchy key (e.g., "0-0-0-0")
   */
  private async _loadHierarchy(key: string): Promise<void> {
    if (this._hierarchyCache.has(key) || this._hierarchyLoading.has(key)) return;

    const url = `${this._baseUrl}/ept-hierarchy/${key}.json`;
    this._hierarchyLoading.add(key);
    try {
      const response = await fetch(url, { signal: this._abort.signal });
      if (!response.ok) {
        this._hierarchyFailures.set(key, Date.now());
        console.warn(`Failed to load hierarchy ${key}: ${response.status}`);
        return;
      }

      const hierarchy: EptHierarchy = await response.json();
      this._hierarchyCache.set(key, hierarchy);
      this._hierarchyFailures.delete(key);

      // Process hierarchy entries
      for (const [nodeKey, value] of Object.entries(hierarchy)) {
        const keyArray = this._parseNodeKey(nodeKey);
        const { bounds, boundsWgs84 } = this._calculateNodeBounds(keyArray);
        const existingNode = this._nodeCache.get(nodeKey);

        if (value === -1) {
          // Subtree root - create a placeholder entry and mark for later loading
          this._subtreeRoots.add(nodeKey);
          if (!existingNode) {
            this._nodeCache.set(nodeKey, {
              key: nodeKey,
              keyArray,
              state: 'subtree', // Special state for subtree roots
              pointCount: 0,
              bounds,
              boundsWgs84,
            });
          }
        } else if (value > 0) {
          if (existingNode?.state === 'subtree') {
            // Subtree root entries appear again in their own hierarchy file
            existingNode.state = 'pending';
            existingNode.pointCount = value;
            existingNode.bounds = bounds;
            existingNode.boundsWgs84 = boundsWgs84;
          } else if (!existingNode) {
            // Create node cache entry
            this._nodeCache.set(nodeKey, {
              key: nodeKey,
              keyArray,
              state: 'pending',
              pointCount: value,
              bounds,
              boundsWgs84,
            });
          }
        }
      }
    } catch (error) {
      if (this._abort.signal.aborted) {
        return;
      }
      this._hierarchyFailures.set(key, Date.now());
      console.warn(`Error loading hierarchy ${key}:`, error);
    } finally {
      this._hierarchyLoading.delete(key);
    }
  }

  /**
   * Ensures root hierarchy is loaded.
   * Subtree hierarchies are loaded on-demand in selectNodesForViewport.
   */
  private async _ensureHierarchyLoaded(): Promise<void> {
    // Load root hierarchy first
    if (!this._rootHierarchyLoaded) {
      await this._loadHierarchy('0-0-0-0');
      this._rootHierarchyLoaded = true;
    }
    // Note: Subtree hierarchies are loaded on-demand when they intersect the viewport
  }

  /**
   * Finds nodes that intersect the viewport and should be loaded.
   *
   * @param viewport - Current viewport information
   * @returns Sorted array of nodes to load (by priority)
   */
  async selectNodesForViewport(viewport: ViewportInfo): Promise<EptCachedNode[]> {
    if (!this._isInitialized) {
      throw new Error('EptStreamingLoader not initialized. Call initialize() first.');
    }

    // Ensure root hierarchy is loaded
    await this._ensureHierarchyLoaded();

    const targetDepth = viewport.targetDepth;

    // Load subtree hierarchies in multiple passes to discover nested subtrees
    // Each pass may reveal new subtrees that need to be loaded
    const maxSubtreesToLoad = Math.max(1, this._options.maxSubtreesPerViewport);
    const loadedSubtrees = new Set<string>();
    const maxPasses = 3;
    const now = Date.now();
    const hierarchyRetryCooldownMs = 5000;

    for (let pass = 0; pass < maxPasses; pass++) {
      // Find subtrees that intersect viewport and haven't been loaded yet
      const subtreeCandidates: Array<{ key: string; priority: number }> = [];
      for (const [, node] of this._nodeCache) {
        const depth = node.keyArray[0];

        // Only check subtrees within our target depth range
        if (depth > targetDepth + 3) continue;

        // Check if this subtree intersects viewport and hasn't been processed
        const lastFailure = this._hierarchyFailures.get(node.key);
        if (node.state === 'subtree' &&
            !this._hierarchyCache.has(node.key) &&
            !this._hierarchyLoading.has(node.key) &&
            !loadedSubtrees.has(node.key) &&
            (!lastFailure || (now - lastFailure) >= hierarchyRetryCooldownMs) &&
            this._boundsIntersectsViewport(node.boundsWgs84, viewport)) {
          const priority = this._calculateNodePriority(node.boundsWgs84, viewport);
          subtreeCandidates.push({ key: node.key, priority });
        }
      }

      // No more subtrees to load - done
      if (subtreeCandidates.length === 0) break;

      // Sort by priority (closest to center first) and limit per pass
      subtreeCandidates.sort((a, b) => a.priority - b.priority);
      const perPassLimit = Math.ceil(maxSubtreesToLoad / maxPasses);
      const subtreesToProcess = subtreeCandidates.slice(0, perPassLimit).map(s => s.key);

      // Fire requests in parallel
      await Promise.all(subtreesToProcess.map(subtreeKey => this._loadHierarchy(subtreeKey)));
      subtreesToProcess.forEach(key => loadedSubtrees.add(key));

      // If we've loaded enough subtrees total, stop
      if (loadedSubtrees.size >= maxSubtreesToLoad) break;
    }

    // Second pass: collect loadable nodes
    const nodesToLoad: EptCachedNode[] = [];

    for (const [, node] of this._nodeCache) {
      if (!this._viewportWantsNode(node, viewport, now)) continue;

      // Add to load list if not already loaded/loading
      if (node.state !== 'loaded' && node.state !== 'loading') {
        // Coarse-to-fine, then nearest-first within a depth
        node.priority = this._nodeLoadPriority(node, viewport);
        nodesToLoad.push(node);
      }
    }

    // Sort by priority (coarse-to-fine, then center-first)
    nodesToLoad.sort(compareNodePriority);

    return nodesToLoad;
  }

  /**
   * Whether a node is one the viewport loads: it holds points, hasn't failed recently,
   * intersects the viewport and is no deeper than the viewport needs.
   */
  private _viewportWantsNode(node: EptCachedNode, viewport: ViewportInfo, now: number): boolean {
    // Subtree placeholders have no point data
    if (node.state === 'subtree' || node.state === 'error') return false;
    if (node.lastFailedAt && (now - node.lastFailedAt) < NODE_RETRY_COOLDOWN_MS) return false;
    // +2 loads slightly more detailed nodes for better coverage
    if (node.keyArray[0] > viewport.targetDepth + 2) return false;
    return this._boundsIntersectsViewport(node.boundsWgs84, viewport);
  }

  /** Coarse-to-fine, then nearest the viewport center first within a depth. */
  private _nodeLoadPriority(node: EptCachedNode, viewport: ViewportInfo): number {
    return nodeLoadPriority(node.keyArray[0], this._calculateNodePriority(node.boundsWgs84, viewport));
  }

  /**
   * Loaded nodes worth keeping: those in view that still fit the point budget when every
   * node the viewport wants is taken in load order. Deeper nodes give way to coarser ones.
   */
  private _loadedKeysToKeep(viewport: ViewportInfo): Set<string> {
    const now = Date.now();
    const candidates: BudgetCandidate[] = [];
    for (const node of this._nodeCache.values()) {
      const loaded = node.state === 'loaded' && node.bufferStartIndex !== undefined;
      const wanted = loaded
        ? this._boundsIntersectsViewport(node.boundsWgs84, viewport)
        : node.state === 'pending' && this._viewportWantsNode(node, viewport, now);
      if (wanted) {
        candidates.push({
          key: node.key,
          pointCount: node.pointCount,
          priority: this._nodeLoadPriority(node, viewport),
          loaded,
        });
      }
    }
    return loadedKeysWithinBudget(candidates, this._options.pointBudget);
  }

  /**
   * Queues a node for loading.
   *
   * @param node - Node to queue
   */
  queueNode(node: EptCachedNode): void {
    if (node.state !== 'pending') return;
    if (this._loadingQueue.find((n) => n.key === node.key)) return;

    this._loadingQueue.push(node);
    this._loadingQueue.sort(compareNodePriority);
  }

  /**
   * Evicts loaded nodes outside the current viewport, and those that no longer fit the
   * point budget, and compacts point buffers.
   * Hierarchy metadata is kept so evicted nodes can be loaded again later.
   *
   * @param viewport - Current viewport information
   * @returns True if eviction completed, or false if active requests are still writing buffers
   */
  evictLoadedNodesOutsideViewport(viewport: ViewportInfo): boolean {
    if (this._paused || this._activeRequests > 0 || this._isResetting) {
      return false;
    }

    const keepNodeKeys = this._loadedKeysToKeep(viewport);
    const keepNodes = Array.from(this._nodeCache.values())
      .filter((node) => node.state === 'loaded' && node.bufferStartIndex !== undefined && keepNodeKeys.has(node.key))
      .sort((a, b) => a.bufferStartIndex! - b.bufferStartIndex!);

    let nextStart = 0;
    for (const node of keepNodes) {
      const oldStart = node.bufferStartIndex!;
      if (oldStart !== nextStart) {
        this._copyNodeBufferRange(oldStart, nextStart, node.pointCount);
      }
      node.bufferStartIndex = nextStart;
      nextStart += node.pointCount;
    }

    let evictedCount = 0;
    for (const node of this._nodeCache.values()) {
      if (node.state === 'loaded' && keepNodeKeys.has(node.key)) {
        continue;
      }
      if (node.state !== 'loaded' && node.state !== 'error') {
        continue;
      }

      node.state = 'pending';
      node.bufferStartIndex = undefined;
      node.error = undefined;
      node.retryCount = undefined;
      node.lastFailedAt = undefined;
      node.priority = undefined;
      evictedCount++;
    }

    const pointsChanged = nextStart !== this._totalLoadedPoints;
    if (evictedCount > 0 || pointsChanged) {
      this._totalLoadedPoints = nextStart;
      this._totalLoadedNodes = keepNodes.length;
      this._emit('progress', this._getProgressEvent());
      this._scheduleLayerUpdate();
    }
    this._fitCapacity();

    return true;
  }

  /**
   * Copies a node's point data from one buffer range to another.
   *
   * @param fromStart - Source point index
   * @param toStart - Destination point index
   * @param pointCount - Number of points to copy
   */
  private _copyNodeBufferRange(fromStart: number, toStart: number, pointCount: number): void {
    this._positions!.copyWithin(toStart * 3, fromStart * 3, (fromStart + pointCount) * 3);
    this._intensities!.copyWithin(toStart, fromStart, fromStart + pointCount);
    this._classifications!.copyWithin(toStart, fromStart, fromStart + pointCount);

    if (this._colors) {
      this._colors.copyWithin(toStart * 4, fromStart * 4, (fromStart + pointCount) * 4);
    }

    for (const arr of Object.values(this._extraAttributes)) {
      arr.copyWithin(toStart, fromStart, fromStart + pointCount);
    }
  }

  /**
   * Pauses or resumes node dispatch. While paused no queued node is
   * requested, so the loaded points stay put; requests already in flight
   * still complete. Resuming does not drain the queue by itself; call
   * {@link loadQueuedNodes}.
   *
   * @param paused - Whether to pause
   */
  setPaused(paused: boolean): void {
    this._paused = paused;
    if (!paused) this._reclaimFailedReservations();
  }

  /** Whether node dispatch is paused by {@link setPaused}. */
  isPaused(): boolean {
    return this._paused;
  }

  /**
   * Loads nodes from the queue, respecting point budget and concurrency limits.
   */
  async loadQueuedNodes(): Promise<void> {
    if (this._paused) return;
    while (
      this._loadingQueue.length > 0 &&
      this._activeFetches < this._options.maxConcurrentRequests &&
      this._totalLoadedPoints + this._fetchingPoints < this._options.pointBudget
    ) {
      // Left queued if it doesn't fit, so it loads once the budget allows.
      const node = this._loadingQueue[0];

      if (this._totalLoadedPoints + this._fetchingPoints + node.pointCount > this._options.pointBudget) {
        this._emit('budgetreached', this._getProgressEvent());
        break;
      }

      this._loadingQueue.shift();
      this._loadNode(node);
    }
  }

  /**
   * Gets the data URL for a node.
   *
   * @param key - Node key
   * @returns URL to the data file
   */
  private _getDataUrl(key: string): string {
    const ext = this._metadata?.dataType === 'binary' ? 'bin' : 'laz';
    return `${this._baseUrl}/ept-data/${key}.${ext}`;
  }

  /**
   * Loads a single node's point data.
   *
   * @param node - Node to load
   */
  private async _loadNode(node: EptCachedNode): Promise<void> {
    if (node.state === 'loaded' || node.state === 'loading') return;

    node.state = 'loading';
    this._activeRequests++;
    this._activeFetches++;
    this._fetchingPoints += node.pointCount;
    let fetchSlotHeld = true;
    let reservedPoints = 0;
    const fetchController = new AbortController();
    this._nodeFetchControllers.set(node, fetchController);

    try {
      const buffer = await this._fetchNodeData(this._getDataUrl(node.key), fetchController.signal);

      // The download is done, so start the next one before spending main-thread time
      // decoding this one. `_activeRequests` stays held until the decode has written its
      // points, which is what keeps eviction and reset away from the buffers meanwhile.
      this._releaseFetchSlot(node);
      fetchSlotHeld = false;

      const startIndex = this._totalLoadedPoints;
      this._ensureCapacity(startIndex + node.pointCount);
      node.bufferStartIndex = startIndex;
      reservedPoints = node.pointCount;
      this._totalLoadedPoints += reservedPoints;

      this.loadQueuedNodes();

      if (this._metadata?.dataType === 'laszip') {
        // Use copc.js to decompress LAZ files
        await this._decodeLazNode(buffer, node, startIndex);
      } else {
        // Binary format - parse directly
        this._decodeBinaryNode(buffer, node, startIndex);
      }

      node.state = 'loaded';
      this._totalLoadedNodes++;

      this._emit('nodeloaded', node);
      this._emit('progress', this._getProgressEvent());

      this._scheduleLayerUpdate();
    } catch (error) {
      // Destroyed mid-load: the buffers are gone and nothing is waiting on this node.
      if (this._abort.signal.aborted) {
        return;
      }
      // Release the reserved space only when no later node has reserved after
      // it: otherwise a later node could be handed an overlapping range. A gap
      // left behind is reclaimed once no request is in flight
      // (_reclaimFailedReservations).
      if (node.bufferStartIndex !== undefined) {
        if (node.bufferStartIndex + reservedPoints === this._totalLoadedPoints) {
          this._totalLoadedPoints -= reservedPoints;
        } else {
          this._hasReservationGaps = true;
        }
      }
      node.bufferStartIndex = undefined;

      if (fetchController.signal.aborted) {
        // Abandoned rather than failed: it can load again, without penalty, once reselected.
        node.state = 'pending';
        return;
      }

      // Track retry count and set cooldown timestamp
      node.retryCount = (node.retryCount || 0) + 1;
      node.lastFailedAt = Date.now();
      const maxRetries = 3;

      if (node.retryCount < maxRetries) {
        // Mark as pending to allow retry after cooldown
        node.state = 'pending';
        node.error = error instanceof Error ? error.message : String(error);

        // Only log first failure
        if (node.retryCount === 1) {
          console.warn(`Failed to load EPT node ${node.key} (will retry): ${node.error}`);
        }
      } else {
        // Max retries reached, mark as permanently failed
        node.state = 'error';
        node.error = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to load EPT node ${node.key} after ${maxRetries} attempts: ${node.error}`);
      }
    } finally {
      if (fetchSlotHeld) {
        this._releaseFetchSlot(node);
      }
      this._activeRequests--;
      if (!this._abort.signal.aborted) {
        this._reclaimFailedReservations();
        this.loadQueuedNodes();
      }
    }
  }

  /**
   * Closes the gaps failed node requests left in the buffers by moving later
   * nodes down, once no request is in flight (so no reservation can move under
   * a writer). Skipped while paused, when callers rely on indices staying put.
   *
   * @returns True when the buffers were compacted
   */
  private _reclaimFailedReservations(): boolean {
    if (!this._hasReservationGaps || this._activeRequests > 0 || this._paused) return false;
    const loaded = [...this._nodeCache.values()]
      .filter((node) => node.state === 'loaded' && node.bufferStartIndex !== undefined)
      .sort((a, b) => a.bufferStartIndex! - b.bufferStartIndex!);
    let next = 0;
    for (const node of loaded) {
      const from = node.bufferStartIndex!;
      if (from !== next) {
        const count = node.pointCount;
        this._positions!.copyWithin(next * 3, from * 3, (from + count) * 3);
        this._intensities!.copyWithin(next, from, from + count);
        this._classifications!.copyWithin(next, from, from + count);
        this._colors?.copyWithin(next * 4, from * 4, (from + count) * 4);
        for (const arr of Object.values(this._extraAttributes)) {
          arr.copyWithin(next, from, from + count);
        }
        node.bufferStartIndex = next;
      }
      next += node.pointCount;
    }
    this._totalLoadedPoints = next;
    this._hasReservationGaps = false;
    this._scheduleLayerUpdate();
    return true;
  }

  /**
   * Stops counting a node as downloading, once its bytes have arrived or its fetch has failed.
   *
   * @param node - Node whose download has finished
   */
  private _releaseFetchSlot(node: EptCachedNode): void {
    this._activeFetches--;
    this._fetchingPoints -= node.pointCount;
    this._nodeFetchControllers.delete(node);
  }

  /**
   * Downloads a node's data file.
   *
   * @param url - URL to the data file
   * @param signal - Aborts the download
   * @returns The file's bytes
   */
  private async _fetchNodeData(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch node data: ${response.status}`);
    }
    return response.arrayBuffer();
  }

  /**
   * Decodes a LAZ node using copc.js
   *
   * @param buffer - The LAZ file's bytes
   * @param node - Node being loaded
   * @param startIndex - Starting index in buffers
   */
  private async _decodeLazNode(
    buffer: ArrayBuffer,
    node: EptCachedNode,
    startIndex: number
  ): Promise<void> {
    // Small LAS 1.2 files can be shorter than the header length copc.js requires
    let bytes = new Uint8Array(buffer);
    if (bytes.byteLength < MIN_LAS_HEADER_LENGTH) {
      const padded = new Uint8Array(MIN_LAS_HEADER_LENGTH);
      padded.set(bytes);
      bytes = padded;
    }
    const header = Las.Header.parse(bytes);
    // Only node.pointCount points are reserved in the buffers for this node
    if (header.pointCount !== node.pointCount) {
      throw new Error(`LAZ node ${node.key} has ${header.pointCount} points, expected ${node.pointCount}`);
    }
    const vlrs = await Las.Vlr.walk(async (begin, end) => bytes.subarray(begin, end), header);
    const ebVlr = Las.Vlr.find(vlrs, 'LASF_Spec', 4);
    const eb = ebVlr
      ? Las.ExtraBytes.parse(bytes.subarray(ebVlr.contentOffset, ebVlr.contentOffset + ebVlr.contentLength))
      : [];
    const pointData = await Las.PointData.decompressFile(bytes, await getLazPerf());
    const view = Las.View.create(pointData, header, eb);

    // Detect extra dimensions on first node, keeping only those the EPT schema lists
    if (!this._dimensionsDetected) {
      for (const parsed of this._parsedSchema) {
        const dimName = parsed.dimension.name;
        if (!CORE_DIMENSIONS.has(dimName) && dimName in view.dimensions) {
          this._availableDimensions.add(dimName);
          const config = DIMENSION_CONFIGS[dimName] || { arrayType: 'float32' };
          this._extraAttributes[dimName] = createAttributeArray(
            config.arrayType,
            this._capacity,
          );
        }
      }
      this._dimensionsDetected = true;
    }

    const pointCount = Math.min(node.pointCount, this._capacity - startIndex);
    copyViewPoints(view, pointCount, startIndex, this._pointTarget());
  }

  /**
   * The buffers decoded points are copied into, and how to place points in them.
   */
  private _pointTarget(): PointTarget {
    return {
      positions: this._positions!,
      intensities: this._intensities!,
      classifications: this._classifications!,
      colors: this._colors,
      extraAttributes: this._extraAttributes,
      coordinateOrigin: this._coordinateOrigin,
      toLngLat: this._needsTransform && this._transformer ? this._transformer : null,
      verticalUnitFactor: this._verticalUnitFactor,
    };
  }

  /**
   * Decodes a binary node.
   *
   * @param buffer - The binary file's bytes
   * @param node - Node being loaded
   * @param startIndex - Starting index in buffers
   */
  private _decodeBinaryNode(buffer: ArrayBuffer, node: EptCachedNode, startIndex: number): void {
    const dataView = new DataView(buffer);

    // Find dimension getters
    const xGetter = this._parsedSchema.find(p => p.dimension.name === 'X')?.getter;
    const yGetter = this._parsedSchema.find(p => p.dimension.name === 'Y')?.getter;
    const zGetter = this._parsedSchema.find(p => p.dimension.name === 'Z')?.getter;
    const intensityGetter = this._parsedSchema.find(p => p.dimension.name === 'Intensity')?.getter;
    const classGetter = this._parsedSchema.find(p => p.dimension.name === 'Classification')?.getter;
    const redGetter = this._hasColor ? this._parsedSchema.find(p => p.dimension.name === 'Red')?.getter : null;
    const greenGetter = this._hasColor ? this._parsedSchema.find(p => p.dimension.name === 'Green')?.getter : null;
    const blueGetter = this._hasColor ? this._parsedSchema.find(p => p.dimension.name === 'Blue')?.getter : null;
    // EPT colors can be 8-bit or 16-bit depending on schema
    const is16BitColor = this._parsedSchema.find(p => p.dimension.name === 'Red')?.dimension.size === 2;

    if (!xGetter || !yGetter || !zGetter) {
      throw new Error('Missing required X, Y, Z dimensions in EPT schema');
    }

    // Detect extra dimensions on first node
    if (!this._dimensionsDetected) {
      for (const parsed of this._parsedSchema) {
        const dimName = parsed.dimension.name;
        if (!CORE_DIMENSIONS.has(dimName)) {
          this._availableDimensions.add(dimName);
          const config = DIMENSION_CONFIGS[dimName] || { arrayType: 'float32' };
          this._extraAttributes[dimName] = createAttributeArray(
            config.arrayType,
            this._capacity,
          );
        }
      }
      this._dimensionsDetected = true;
    }

    // Build getters for extra dimensions
    const extraGetters: Map<string, ParsedDimension> = new Map();
    for (const dimName of this._availableDimensions) {
      const parsed = this._parsedSchema.find(p => p.dimension.name === dimName);
      if (parsed) {
        extraGetters.set(dimName, parsed);
      }
    }

    for (let i = 0; i < node.pointCount; i++) {
      const pointIndex = startIndex + i;
      if (pointIndex >= this._capacity) break;

      const byteOffset = i * this._pointByteLength;

      const x = xGetter(dataView, byteOffset);
      const y = yGetter(dataView, byteOffset);
      const z = zGetter(dataView, byteOffset);

      // Transform coordinates to WGS84 if needed
      if (this._needsTransform && this._transformer) {
        const [rawLng, rawLat] = this._transformer([x, y]);
        // Clamp to valid WGS84 range (silently - no logging for individual points to avoid console spam)
        const [lng, lat] = clampLatLng(rawLng, rawLat, '');
        this._positions![pointIndex * 3] = lng - this._coordinateOrigin[0];
        this._positions![pointIndex * 3 + 1] = lat - this._coordinateOrigin[1];
        this._positions![pointIndex * 3 + 2] = z * this._verticalUnitFactor;
      } else {
        this._positions![pointIndex * 3] = x - this._coordinateOrigin[0];
        this._positions![pointIndex * 3 + 1] = y - this._coordinateOrigin[1];
        this._positions![pointIndex * 3 + 2] = z;
      }

      // Intensity (normalize to 0-1)
      if (intensityGetter) {
        this._intensities![pointIndex] = intensityGetter(dataView, byteOffset) / 65535;
      }

      // Classification
      if (classGetter) {
        this._classifications![pointIndex] = classGetter(dataView, byteOffset);
      }

      // Color (if available)
      if (this._colors && redGetter && greenGetter && blueGetter) {
        if (is16BitColor) {
          this._colors[pointIndex * 4] = redGetter(dataView, byteOffset) >> 8;
          this._colors[pointIndex * 4 + 1] = greenGetter(dataView, byteOffset) >> 8;
          this._colors[pointIndex * 4 + 2] = blueGetter(dataView, byteOffset) >> 8;
        } else {
          this._colors[pointIndex * 4] = redGetter(dataView, byteOffset);
          this._colors[pointIndex * 4 + 1] = greenGetter(dataView, byteOffset);
          this._colors[pointIndex * 4 + 2] = blueGetter(dataView, byteOffset);
        }
        this._colors[pointIndex * 4 + 3] = 255;
      }

      // Extra attributes
      for (const [dimName, parsed] of extraGetters) {
        const arr = this._extraAttributes[dimName];
        if (arr) {
          arr[pointIndex] = parsed.getter(dataView, byteOffset);
        }
      }
    }
  }

  /**
   * Schedules a batched layer update.
   */
  private _scheduleLayerUpdate(): void {
    if (this._pendingLayerUpdate) return;
    this._pendingLayerUpdate = true;

    this._updateBatchTimeout = setTimeout(() => {
      this._performLayerUpdate();
      this._pendingLayerUpdate = false;
      this._updateBatchTimeout = null;
    }, LAYER_UPDATE_BATCH_MS);
  }

  /**
   * Performs the layer update callback.
   */
  private _performLayerUpdate(): void {
    if (this._onPointsLoaded) {
      const data = this.getLoadedPointCloudData();
      this._onPointsLoaded(data);
    }
  }

  /**
   * Sets the callback for when points are loaded.
   *
   * @param callback - Function to call with updated point cloud data
   */
  setOnPointsLoaded(callback: (data: PointCloudData) => void): void {
    this._onPointsLoaded = callback;
  }

  /**
   * The buffer range of every fully loaded node, ascending by start index.
   * Ranges move when eviction compacts the buffers, so read them afresh with
   * each {@link getLoadedPointCloudData} rather than caching them.
   *
   * @returns One range per loaded node
   */
  getLoadedNodeRanges(): PointNodeRange[] {
    const ranges: PointNodeRange[] = [];
    for (const node of this._nodeCache.values()) {
      if (node.state === 'loaded' && node.bufferStartIndex !== undefined) {
        ranges.push({ key: node.key, start: node.bufferStartIndex, count: node.pointCount });
      }
    }
    return ranges.sort((a, b) => a.start - b.start);
  }

  /**
   * Gets the current loaded point cloud data for rendering.
   *
   * @returns Current loaded data
   */
  getLoadedPointCloudData(): PointCloudData {
    const pointCount = this._totalLoadedPoints;

    // Build trimmed extra attributes
    const trimmedExtraAttributes: ExtraPointAttributes = {};
    for (const [name, arr] of Object.entries(this._extraAttributes)) {
      trimmedExtraAttributes[name] = arr.subarray(0, pointCount) as AttributeArray;
    }

    return {
      positions: this._positions!.subarray(0, pointCount * 3),
      coordinateOrigin: this._coordinateOrigin,
      colors: this._colors?.subarray(0, pointCount * 4),
      intensities: this._intensities!.subarray(0, pointCount),
      classifications: this._classifications!.subarray(0, pointCount),
      extraAttributes:
        Object.keys(trimmedExtraAttributes).length > 0
          ? trimmedExtraAttributes
          : undefined,
      pointCount,
      bounds: this._bounds!,
      hasRGB: this._hasColor,
      hasIntensity: this._hasIntensity,
      hasClassification: true,
      wkt: this._metadata?.srs?.wkt,
      nodeRanges: this.getLoadedNodeRanges(),
    };
  }

  /**
   * Checks whether there are subtree hierarchies still pending for the viewport.
   *
   * @param viewport - Current viewport information
   * @returns True if more subtree hierarchies should be loaded
   */
  hasPendingSubtrees(viewport: ViewportInfo): boolean {
    if (!this._isInitialized) return false;

    const targetDepth = viewport.targetDepth;
    const now = Date.now();
    const hierarchyRetryCooldownMs = 5000;

    for (const [, node] of this._nodeCache) {
      const depth = node.keyArray[0];
      if (depth > targetDepth + 3) continue;

      const lastFailure = this._hierarchyFailures.get(node.key);
      if (node.state === 'subtree' &&
          !this._hierarchyCache.has(node.key) &&
          !this._hierarchyLoading.has(node.key) &&
          (!lastFailure || (now - lastFailure) >= hierarchyRetryCooldownMs) &&
          this._boundsIntersectsViewport(node.boundsWgs84, viewport)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Gets the current streaming progress.
   */
  private _getProgressEvent(): StreamingProgressEvent {
    return {
      totalNodesInView: this._nodeCache.size,
      loadedNodes: this._totalLoadedNodes,
      loadedPoints: this._totalLoadedPoints,
      pointBudget: this._options.pointBudget,
      isLoading: this._activeRequests > 0 || this._loadingQueue.length > 0,
      queueSize: this._loadingQueue.length,
    };
  }

  /**
   * Registers an event handler.
   *
   * @param event - Event type
   * @param handler - Handler function
   */
  on(event: StreamingLoaderEvent, handler: StreamingLoaderEventHandler): void {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, new Set());
    }
    this._eventHandlers.get(event)!.add(handler);
  }

  /**
   * Removes an event handler.
   *
   * @param event - Event type
   * @param handler - Handler function
   */
  off(event: StreamingLoaderEvent, handler: StreamingLoaderEventHandler): void {
    this._eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Emits an event to all registered handlers.
   *
   * @param event - Event type
   * @param data - Event data
   */
  private _emit(
    event: StreamingLoaderEvent,
    data: StreamingProgressEvent | EptCachedNode | Error
  ): void {
    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        // Cast EptCachedNode to unknown first to satisfy the handler type
        // (handlers don't use COPC-specific fields like pointDataOffset)
        handler(event, data as Parameters<StreamingLoaderEventHandler>[1]);
      }
    }
  }

  /**
   * Debug snapshot of loading state for nodes intersecting a viewport.
   */
  debugViewportState(viewport: ViewportInfo): Record<string, unknown> {
    const maxDepth = viewport.targetDepth + 2;
    const byState: Record<string, number> = {};
    const pendingByDepth: Record<number, number> = {};
    let unloadedSubtrees = 0;
    let loadingSubtrees = 0;
    let coolingDown = 0;
    const now = Date.now();
    for (const node of this._nodeCache.values()) {
      if (!this._boundsIntersectsViewport(node.boundsWgs84, viewport)) {
        continue;
      }
      const depth = node.keyArray[0];
      if (node.state === 'subtree') {
        if (depth <= viewport.targetDepth + 3 && !this._hierarchyCache.has(node.key)) {
          if (this._hierarchyLoading.has(node.key)) {
            loadingSubtrees++;
          } else {
            unloadedSubtrees++;
          }
        }
        continue;
      }
      if (depth > maxDepth) {
        continue;
      }
      byState[node.state] = (byState[node.state] ?? 0) + 1;
      if (node.state === 'pending') {
        pendingByDepth[depth] = (pendingByDepth[depth] ?? 0) + 1;
        if (node.lastFailedAt && now - node.lastFailedAt < NODE_RETRY_COOLDOWN_MS) {
          coolingDown++;
        }
      }
    }
    return {
      url: this._baseUrl,
      targetDepth: viewport.targetDepth,
      loadedPoints: this._totalLoadedPoints,
      fetchingPoints: this._fetchingPoints,
      pointBudget: this._options.pointBudget,
      capacity: this._capacity,
      queue: this._loadingQueue.length,
      activeRequests: this._activeRequests,
      activeFetches: this._activeFetches,
      paused: this._paused,
      hasReservationGaps: this._hasReservationGaps,
      nodesInViewByState: byState,
      pendingInViewByDepth: pendingByDepth,
      coolingDown,
      unloadedSubtrees,
      loadingSubtrees,
    };
  }

  /**
   * Gets the total number of loaded points.
   */
  getLoadedPointCount(): number {
    return this._totalLoadedPoints;
  }

  /**
   * Changes the point budget. Loading resumes if it grew; points already loaded past a
   * smaller budget stay until the next {@link evictLoadedNodesOutsideViewport}.
   *
   * @returns True if more points are loaded or loading than the new budget allows
   */
  setPointBudget(pointBudget: number): boolean {
    this._options.pointBudget = pointBudget;
    void this.loadQueuedNodes();
    return this._totalLoadedPoints > pointBudget;
  }

  /**
   * Gets the current point budget.
   */
  getPointBudget(): number {
    return this._options.pointBudget;
  }

  /**
   * Checks if any nodes intersecting the viewport have already been loaded.
   *
   * @param viewport - Current viewport information
   * @returns True if viewport has loaded coverage
   */
  hasLoadedNodesInViewport(viewport: ViewportInfo, minDepth: number = 0): boolean {
    for (const [, node] of this._nodeCache) {
      if (node.state !== 'loaded') continue;
      if (node.keyArray[0] < minDepth) continue;
      if (this._boundsIntersectsViewport(node.boundsWgs84, viewport)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Estimates viewport coverage ratio by loaded nodes.
   * Returns a value from 0 to 1 representing how much of the viewport
   * is covered by loaded tiles.
   *
   * @param viewport - Current viewport information
   * @param minDepth - Minimum octree depth to consider
   * @returns Coverage ratio (0-1)
   */
  getViewportCoverageRatio(viewport: ViewportInfo, minDepth: number = 0): number {
    const [west, south, east, north] = viewport.bounds;
    const viewportArea = (east - west) * (north - south);
    if (viewportArea <= 0) return 0;

    let coveredArea = 0;

    for (const [, node] of this._nodeCache) {
      if (node.state !== 'loaded') continue;
      if (node.keyArray[0] < minDepth) continue;

      // Calculate intersection area with viewport
      const nodeWest = node.boundsWgs84.minX;
      const nodeSouth = node.boundsWgs84.minY;
      const nodeEast = node.boundsWgs84.maxX;
      const nodeNorth = node.boundsWgs84.maxY;

      const intersectWest = Math.max(west, nodeWest);
      const intersectEast = Math.min(east, nodeEast);
      const intersectSouth = Math.max(south, nodeSouth);
      const intersectNorth = Math.min(north, nodeNorth);

      if (intersectWest < intersectEast && intersectSouth < intersectNorth) {
        const intersectArea = (intersectEast - intersectWest) * (intersectNorth - intersectSouth);
        coveredArea += intersectArea;
      }
    }

    // Cap at 1.0 (overlapping nodes can cause > 1)
    return Math.min(1.0, coveredArea / viewportArea);
  }

  /**
   * Gets the total number of loaded nodes.
   */
  getLoadedNodeCount(): number {
    return this._totalLoadedNodes;
  }

  /**
   * Checks if the loader is currently loading.
   */
  isLoading(): boolean {
    return this._activeRequests > 0 || this._loadingQueue.length > 0;
  }

  /**
   * Removes queued nodes that are outside the current viewport, aborts downloads of any
   * in-flight ones, and re-sorts priorities.
   *
   * @param viewport - Current viewport information
   */
  pruneQueueForViewport(viewport: ViewportInfo): void {
    // Downloads the viewport has left would otherwise hold connections the nodes now in view need.
    for (const [ node, controller ] of this._nodeFetchControllers) {
      if (!this._boundsIntersectsViewport(node.boundsWgs84, viewport)) {
        controller.abort();
      }
    }

    if (this._loadingQueue.length === 0) return;

    this._loadingQueue = this._loadingQueue.filter((node) =>
      this._boundsIntersectsViewport(node.boundsWgs84, viewport)
    );

    for (const node of this._loadingQueue) {
      const distPriority = this._calculateNodePriority(node.boundsWgs84, viewport);
      const depth = node.keyArray[0];
      node.priority = nodeLoadPriority(depth, distPriority);
    }

    this._loadingQueue.sort(compareNodePriority);
  }

  /**
   * Resets loaded node data to allow loading a new area.
   * Keeps hierarchy cache intact but clears loaded points and node states.
   *
   * @returns True if reset occurred
   */
  resetLoadedData(): boolean {
    if (this._activeRequests > 0 || this._isResetting) return false;
    this._isResetting = true;

    this._loadingQueue = [];
    this._totalLoadedPoints = 0;
    this._totalLoadedNodes = 0;

    for (const [, node] of this._nodeCache) {
      if (node.state === 'loaded' || node.state === 'loading' || node.state === 'error') {
        node.state = 'pending';
        node.bufferStartIndex = undefined;
        node.error = undefined;
        node.retryCount = undefined;
        node.lastFailedAt = undefined;
      }
    }

    // Force a render update so old points are cleared.
    this._scheduleLayerUpdate();

    this._isResetting = false;
    return true;
  }

  /**
   * Gets the EPT metadata.
   */
  getMetadata(): EptMetadata | null {
    return this._metadata;
  }

  /**
   * Gets the extended EPT metadata for the metadata panel.
   *
   * @returns Extended EPT metadata or undefined if not initialized
   */
  getExtendedMetadata(): import('../core/types').EptExtendedMetadata | undefined {
    if (!this._metadata) return undefined;

    const meta = this._metadata;

    // Build dimension info from EPT schema
    const dimensions: import('../core/types').DimensionInfo[] = [];
    if (meta.schema) {
      for (const dim of meta.schema) {
        dimensions.push({
          name: dim.name,
          type: dim.type,
          size: dim.size,
          scale: dim.scale,
          offset: dim.offset,
        });
      }
    }

    // Calculate nominal point spacing from bbox area: sqrt(area / pointCount)
    let pointSpacing: number | undefined;
    if (meta.bounds && meta.bounds.length >= 6 && this._totalPointsInFile > 0) {
      const width = meta.bounds[3] - meta.bounds[0];
      const height = meta.bounds[4] - meta.bounds[1];
      const area = width * height;
      if (area > 0) {
        const spacingInSourceUnits = Math.sqrt(area / this._totalPointsInFile);
        pointSpacing = spacingInSourceUnits * this._verticalUnitFactor;
      }
    }

    return {
      version: meta.version || '1.0',
      dataType: meta.dataType || 'laszip',
      hierarchyType: meta.hierarchyType || 'json',
      span: meta.span || 128,
      nativeBounds: meta.bounds || [],
      srs: meta.srs ? {
        authority: meta.srs.authority,
        horizontal: meta.srs.horizontal,
        vertical: meta.srs.vertical,
        wkt: meta.srs.wkt,
      } : undefined,
      dimensions,
      pointSpacing,
    };
  }

  /**
   * Destroys the streaming loader and cleans up resources.
   */
  destroy(): void {
    this._abort.abort();
    for (const controller of this._nodeFetchControllers.values()) {
      controller.abort();
    }
    if (this._updateBatchTimeout) {
      clearTimeout(this._updateBatchTimeout);
    }

    this._loadingQueue = [];
    this._nodeCache.clear();
    this._hierarchyCache.clear();
    this._hierarchyLoading.clear();
    this._hierarchyFailures.clear();
    this._subtreeRoots.clear();
    this._eventHandlers.clear();

    this._positions = null;
    this._colors = null;
    this._intensities = null;
    this._classifications = null;
    this._extraAttributes = {};
  }
}
