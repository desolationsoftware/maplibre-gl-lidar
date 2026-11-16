import { Las, type View } from 'copc';
import type { LazPerf } from 'laz-perf';
import proj4 from 'proj4';
import type { AttributeArray, ExtraPointAttributes } from './types';
import { clampLatLng, toUint8Color } from '../utils/helpers';

// Register common projected coordinate systems that might not have WKT in files
// EPSG:2180 - ETRS89 / Poland CS92 (commonly used in Poland)
proj4.defs('EPSG:2180', '+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');

/**
 * Configuration for attribute storage types
 */
export interface AttributeConfig {
  arrayType: 'float64' | 'float32' | 'uint32' | 'uint16' | 'uint8' | 'int32' | 'int16' | 'int8';
}

/**
 * Known LAS dimension configurations
 */
export const DIMENSION_CONFIGS: Record<string, AttributeConfig> = {
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
export const CORE_DIMENSIONS = new Set([
  'X', 'Y', 'Z',
  'Intensity',
  'Classification',
  'Red', 'Green', 'Blue',
]);

/**
 * Creates a typed array of the appropriate type
 */
export function createAttributeArray(type: AttributeConfig['arrayType'], length: number): AttributeArray {
  switch (type) {
    case 'float64':
      return new Float64Array(length);
    case 'float32':
      return new Float32Array(length);
    case 'uint32':
      return new Uint32Array(length);
    case 'uint16':
      return new Uint16Array(length);
    case 'uint8':
      return new Uint8Array(length);
    case 'int32':
      return new Int32Array(length);
    case 'int16':
      return new Int16Array(length);
    case 'int8':
      return new Int8Array(length);
    default:
      return new Float32Array(length);
  }
}

/**
 * Points laz-perf at its WASM binary.
 */
export function locateLazPerfFile(path: string): string {
  // Load WASM from CDN for reliable loading in all environments
  if (path.endsWith('.wasm')) {
    return 'https://unpkg.com/laz-perf@0.0.7/lib/web/laz-perf.wasm';
  }
  return path;
}

/**
 * Memoizes laz-perf instantiation, retrying on the next call if it fails.
 * @param create - laz-perf's module factory, from the build for the current context
 */
export function lazPerfLoader(create: (options: { locateFile: typeof locateLazPerfFile }) => Promise<LazPerf>): () => Promise<LazPerf> {
  let instance: Promise<LazPerf> | null = null;
  return () => {
    instance ??= create({ locateFile: locateLazPerfFile }).catch((error) => {
      instance = null;
      throw error;
    });
    return instance;
  };
}

/** copc.js's Las.Header.parse requires at least the length of a LAS 1.4 header. */
const MIN_LAS_HEADER_LENGTH = 375;

/**
 * A whole LAZ file, used for EPT nodes.
 */
export interface LazFileSource {
  kind: 'file';
  bytes: Uint8Array;
}

/**
 * One compressed chunk of a COPC file. The chunk has no header of its own, so the file's
 * header and extra bytes come with it.
 */
export interface CopcChunkSource {
  kind: 'chunk';
  bytes: Uint8Array;
  header: Las.Header;
  eb: Las.ExtraBytes[];
}

/**
 * Compressed point data to decode.
 */
export type LazSource = LazFileSource | CopcChunkSource;

export interface DecodeRequest {
  source: LazSource;
  coordinateOrigin: [ number, number, number ];
  /** proj4 definition of the source CRS, or null when no transform to lng/lat is needed. */
  projection: string | null;
  verticalUnitFactor: number;
  includeColors: boolean;
  /** Points the data must hold. */
  expectedPointCount: number;
  /** Number of points to decode, from the start of the data. */
  pointCount: number;
  /** Extra dimensions to decode where the data has them, or null for all of them. */
  extraDimensions: string[] | null;
}

/**
 * A loader's point buffers.
 */
export interface PointBuffers {
  positions: Float32Array;
  intensities: Float32Array;
  classifications: Uint8Array;
  colors: Uint8Array | null;
  extraAttributes: ExtraPointAttributes;
}

export interface DecodeMessage {
  id: number;
  request: DecodeRequest;
}

export type DecodeReply =
  | { id: number; decoded: PointBuffers }
  | { id: number; error: string };

const transforms = new Map<string, (coord: [ number, number ]) => [ number, number ]>();

function getTransform(projection: string): (coord: [ number, number ]) => [ number, number ] {
  let transform = transforms.get(projection);
  if (!transform) {
    const converter = proj4(projection, 'EPSG:4326');
    transform = (coord) => converter.forward(coord) as [ number, number ];
    transforms.set(projection, transform);
  }
  return transform;
}

async function createView(source: LazSource, expectedPointCount: number, lazPerf: LazPerf): Promise<View> {
  switch (source.kind) {
    case 'file':
      return createFileView(source, expectedPointCount, lazPerf);
    case 'chunk':
      return createChunkView(source, expectedPointCount, lazPerf);
  }
}

async function createChunkView(source: CopcChunkSource, expectedPointCount: number, lazPerf: LazPerf): Promise<View> {
  const { header, eb } = source;
  const pointData = await Las.PointData.decompressChunk(source.bytes, {
    pointCount: expectedPointCount,
    pointDataRecordFormat: header.pointDataRecordFormat,
    pointDataRecordLength: header.pointDataRecordLength,
  }, lazPerf);
  return Las.View.create(pointData, header, eb);
}

async function createFileView(source: LazFileSource, expectedPointCount: number, lazPerf: LazPerf): Promise<View> {
  // Small LAS 1.2 files can be shorter than the header length copc.js requires
  let bytes = source.bytes;
  if (bytes.byteLength < MIN_LAS_HEADER_LENGTH) {
    const padded = new Uint8Array(MIN_LAS_HEADER_LENGTH);
    padded.set(bytes);
    bytes = padded;
  }
  const header = Las.Header.parse(bytes);
  // Only expectedPointCount points are reserved in the loader's buffers
  if (header.pointCount !== expectedPointCount) {
    throw new Error(`LAZ data has ${header.pointCount} points, expected ${expectedPointCount}`);
  }
  const vlrs = await Las.Vlr.walk(async (begin, end) => bytes.subarray(begin, end), header);
  const ebVlr = Las.Vlr.find(vlrs, 'LASF_Spec', 4);
  const eb = ebVlr
    ? Las.ExtraBytes.parse(bytes.subarray(ebVlr.contentOffset, ebVlr.contentOffset + ebVlr.contentLength))
    : [];
  const pointData = await Las.PointData.decompressFile(bytes, lazPerf);
  return Las.View.create(pointData, header, eb);
}

/**
 * Decompresses LAZ point data and converts it to the layout of a loader's buffers. Runs in a
 * web worker, or on the main thread when workers are unavailable.
 */
export async function decodeLazPoints(request: DecodeRequest, lazPerf: LazPerf): Promise<PointBuffers> {
  const view = await createView(request.source, request.expectedPointCount, lazPerf);
  const { pointCount, coordinateOrigin, verticalUnitFactor, projection } = request;

  const extraNames = request.extraDimensions
    ?? Object.keys(view.dimensions).filter((name) => !CORE_DIMENSIONS.has(name));
  const extraAttributes: ExtraPointAttributes = {};
  const extraGetters: [ AttributeArray, (i: number) => number ][] = [];
  for (const name of extraNames) {
    if (name in view.dimensions) {
      const arr = createAttributeArray(DIMENSION_CONFIGS[name]?.arrayType ?? 'float32', pointCount);
      extraAttributes[name] = arr;
      extraGetters.push([ arr, view.getter(name) ]);
    }
  }

  const toLngLat = projection ? getTransform(projection) : null;
  const positions = new Float32Array(pointCount * 3);
  const intensities = new Float32Array(pointCount);
  const classifications = new Uint8Array(pointCount);
  const colors = request.includeColors ? new Uint8Array(pointCount * 4) : null;

  const xGetter = view.getter('X');
  const yGetter = view.getter('Y');
  const zGetter = view.getter('Z');
  const intensityGetter = view.getter('Intensity');
  const classGetter = view.getter('Classification');
  const hasColor = !!colors && 'Red' in view.dimensions;
  const redGetter = hasColor ? view.getter('Red') : null;
  const greenGetter = hasColor ? view.getter('Green') : null;
  const blueGetter = hasColor ? view.getter('Blue') : null;

  for (let i = 0; i < pointCount; i++) {
    const x = xGetter(i);
    const y = yGetter(i);
    const z = zGetter(i);

    // Transform coordinates to WGS84 if needed
    if (toLngLat) {
      const [ rawLng, rawLat ] = toLngLat([ x, y ]);
      const [ lng, lat ] = clampLatLng(rawLng, rawLat, '');
      positions[i * 3] = lng - coordinateOrigin[0];
      positions[i * 3 + 1] = lat - coordinateOrigin[1];
      positions[i * 3 + 2] = z * verticalUnitFactor;
    } else {
      positions[i * 3] = x - coordinateOrigin[0];
      positions[i * 3 + 1] = y - coordinateOrigin[1];
      positions[i * 3 + 2] = z;
    }

    // Intensity (normalize to 0-1)
    intensities[i] = intensityGetter(i) / 65535;

    // Classification
    classifications[i] = classGetter(i);

    // Color (if available)
    if (colors && redGetter && greenGetter && blueGetter) {
      colors[i * 4] = toUint8Color(redGetter(i));
      colors[i * 4 + 1] = toUint8Color(greenGetter(i));
      colors[i * 4 + 2] = toUint8Color(blueGetter(i));
      colors[i * 4 + 3] = 255;
    }

    // Extra attributes
    for (const [ arr, getter ] of extraGetters) {
      arr[i] = getter(i);
    }
  }

  return { positions, intensities, classifications, colors, extraAttributes };
}

/**
 * The buffers holding decoded points, so they can be transferred rather than copied.
 */
export function decodedTransferables(decoded: PointBuffers): ArrayBuffer[] {
  const arrays = [
    decoded.positions,
    decoded.intensities,
    decoded.classifications,
    ...(decoded.colors ? [ decoded.colors ] : []),
    ...Object.values(decoded.extraAttributes),
  ];
  return arrays.map((array) => array.buffer as ArrayBuffer);
}

/**
 * Copies decoded points into a loader's buffers. Only the extra attributes the buffers have
 * are copied.
 *
 * @param decoded - Decoded points
 * @param startIndex - Buffer index of the first point
 * @param buffers - Buffers to fill
 */
export function writeDecodedPoints(decoded: PointBuffers, startIndex: number, buffers: PointBuffers): void {
  buffers.positions.set(decoded.positions, startIndex * 3);
  buffers.intensities.set(decoded.intensities, startIndex);
  buffers.classifications.set(decoded.classifications, startIndex);
  if (buffers.colors && decoded.colors) {
    buffers.colors.set(decoded.colors, startIndex * 4);
  }
  for (const [ name, array ] of Object.entries(buffers.extraAttributes)) {
    const values = decoded.extraAttributes[name];
    if (values) {
      array.set(values, startIndex);
    }
  }
}
