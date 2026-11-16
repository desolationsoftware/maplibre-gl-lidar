import type { View } from 'copc';
import type { AttributeArray, ExtraPointAttributes } from './types';
import { clampLatLng, toUint8Color } from '../utils/helpers';

/**
 * Buffers a streaming loader fills with decoded points, and how to place points in them.
 */
export interface PointTarget {
  positions: Float32Array;
  intensities: Float32Array;
  classifications: Uint8Array;
  colors: Uint8Array | null;
  extraAttributes: ExtraPointAttributes;
  coordinateOrigin: [number, number, number];
  toLngLat: ((coord: [number, number]) => [number, number]) | null;
  verticalUnitFactor: number;
}

/**
 * Copies points from a copc.js view into a loader's buffers.
 *
 * @param view - Decoded LAS point data
 * @param pointCount - Number of points to copy, from the start of the view
 * @param startIndex - Buffer index of the first point
 * @param target - Buffers to fill; each of `target.extraAttributes` the view has is copied
 */
export function copyViewPoints(
  view: View,
  pointCount: number,
  startIndex: number,
  target: PointTarget
): void {
  const { positions, intensities, classifications, colors, extraAttributes, coordinateOrigin, toLngLat } = target;
  const xGetter = view.getter('X');
  const yGetter = view.getter('Y');
  const zGetter = view.getter('Z');
  const intensityGetter = view.getter('Intensity');
  const classGetter = view.getter('Classification');
  const hasColor = !!colors && 'Red' in view.dimensions;
  const redGetter = hasColor ? view.getter('Red') : null;
  const greenGetter = hasColor ? view.getter('Green') : null;
  const blueGetter = hasColor ? view.getter('Blue') : null;

  // Build getters for extra dimensions
  const extraGetters: [AttributeArray, (i: number) => number][] = [];
  for (const [dimName, arr] of Object.entries(extraAttributes)) {
    if (dimName in view.dimensions) {
      extraGetters.push([arr, view.getter(dimName)]);
    }
  }

  for (let i = 0; i < pointCount; i++) {
    const pointIndex = startIndex + i;

    const x = xGetter(i);
    const y = yGetter(i);
    const z = zGetter(i);

    // Transform coordinates to WGS84 if needed
    if (toLngLat) {
      const [rawLng, rawLat ] = toLngLat([x, y]);
      const [lng, lat] = clampLatLng(rawLng, rawLat, '');
      positions[pointIndex * 3] = lng - coordinateOrigin[0];
      positions[pointIndex * 3 + 1] = lat - coordinateOrigin[1];
      positions[pointIndex * 3 + 2] = z * target.verticalUnitFactor;
    } else {
      positions[pointIndex * 3] = x - coordinateOrigin[0];
      positions[pointIndex * 3 + 1] = y - coordinateOrigin[1];
      positions[pointIndex * 3 + 2] = z;
    }

    // Intensity (normalize to 0-1)
    intensities[pointIndex] = intensityGetter(i) / 65535;

    // Classification
    classifications[pointIndex] = classGetter(i);

    // Color (if available)
    if (colors && redGetter && greenGetter && blueGetter) {
      colors[pointIndex * 4] = toUint8Color(redGetter(i));
      colors[pointIndex * 4 + 1] = toUint8Color(greenGetter(i));
      colors[pointIndex * 4 + 2] = toUint8Color(blueGetter(i));
      colors[pointIndex * 4 + 3] = 255;
    }

    // Extra attributes
    for (const [arr, getter] of extraGetters) {
      arr[pointIndex] = getter(i);
    }
  }
}
