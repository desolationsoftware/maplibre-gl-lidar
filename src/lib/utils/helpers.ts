/**
 * Padding around the viewport, as a fraction of its width and height on each side, within
 * which point cloud data is loaded and kept.
 */
export const VIEWPORT_BUFFER_FACTOR = 0.2;

/**
 * Clamps a value between a minimum and maximum.
 *
 * @param value - The value to clamp
 * @param min - The minimum allowed value
 * @param max - The maximum allowed value
 * @returns The clamped value
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Clamps latitude and longitude values to valid WGS84 ranges.
 * Latitude is clamped to [-90, 90] and longitude to [-180, 180].
 * Logs a warning if clamping occurs and a context is given.
 *
 * @param lng - Longitude value
 * @param lat - Latitude value
 * @param context - Context string for logging,  empty to clamp silently
 * @returns Clamped [lng, lat] tuple
 */
export function clampLatLng(lng: number, lat: number, context: string = ''): [ number, number ] {
  const clampedLng = clamp(lng, -180, 180);
  const clampedLat = clamp(lat, -90, 90);

  if (context && (clampedLng !== lng || clampedLat !== lat)) {
    console.warn(
      `Clamped transformed coordinates to valid WGS84 range (${context}):`,
      `[${lng.toFixed(6)}, ${lat.toFixed(6)}] -> [${clampedLng.toFixed(6)}, ${clampedLat.toFixed(6)}]`,
    );
  }

  return [ clampedLng, clampedLat ];
}

/** Folds a longitude into [-180, 180). */
export function normalizeLng(lng: number): number {
  return (lng % 360 + 360 + 180) % 360 - 180;
}

/**
 * Converts a LAS color channel to 8 bits, leaving values that are already 8-bit as they are.
 *
 * @param value - Color channel value, 8 or 16 bit
 * @returns The 8-bit value
 */
export function toUint8Color(value: number): number {
  return value > 255 ? value >> 8 : value;
}

/**
 * Formats a numeric value with appropriate decimal places based on step size.
 *
 * @param value - The value to format
 * @param step - The step size to determine decimal places
 * @returns The formatted value as a string
 */
export function formatNumericValue(value: number, step: number): string {
  if (step === 0) return value.toString();
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return value.toFixed(decimals);
}

/**
 * Picks a slider step size scaled to a value range, so small domains get
 * fine-grained steps and large domains don't need hundreds of steps.
 *
 * @param bounds - The domain the slider covers
 * @returns A step size appropriate for that domain
 */
export function getAdaptiveRangeStep(bounds: { min: number; max: number }): number {
  const range = bounds.max - bounds.min;
  if (range <= 1) {
    return 0.01;
  } else if (range <= 10) {
    return 0.1;
  } else if (range <= 1000) {
    return 1;
  }
  return Math.round(range / 100);
}

/**
 * Generates a unique ID string.
 *
 * @param prefix - Optional prefix for the ID
 * @returns A unique ID string
 */
export function generateId(prefix?: string): string {
  const id = Math.random().toString(36).substring(2, 9);
  return prefix ? `${prefix}-${id}` : id;
}

/**
 * Whether a URL points at an EPT dataset's `ept.json`.
 */
export function isEptUrl(url: string): boolean {
  return url.endsWith('/ept.json') || url.includes('/ept.json?');
}

/**
 * Load priority for an octree node. Lower values load first.
 *
 * Nodes load coarse-to-fine, nearest the viewport center first within a depth, so a
 * spent budget leaves the whole viewport at lower density rather than a detailed center.
 * Distances are in degrees and never reach the depth stride.
 *
 * @param depth - Octree depth of the node
 * @param distanceFromCenter - Distance from the node's center to the viewport center
 * @returns Priority value
 */
export function nodeLoadPriority(depth: number, distanceFromCenter: number): number {
  return depth * 1000 + distanceFromCenter;
}

/**
 * A node the viewport wants, for deciding which loaded nodes fit the point budget.
 */
export interface BudgetCandidate {
  key: string;
  pointCount: number;
  priority: number;
  loaded: boolean;
}

/**
 * Keys of the loaded candidates that fit within `budget` when every candidate, loaded or
 * not, is taken in priority order. Stops at the first that doesn't fit, as loading does, so
 * loaded nodes past that point give way to nodes that load before them. Nodes larger than
 * the whole budget are skipped, since loading skips them too.
 */
export function loadedKeysWithinBudget(candidates: BudgetCandidate[], budget: number): Set<string> {
  const sorted = [ ...candidates ].sort((a, b) => a.priority - b.priority);
  const keep = new Set<string>();
  let used = 0;
  for (const candidate of sorted) {
    if (candidate.pointCount > budget) {
      continue;
    }
    if (used + candidate.pointCount > budget) {
      break;
    }
    used += candidate.pointCount;
    if (candidate.loaded) {
      keep.add(candidate.key);
    }
  }
  return keep;
}

/**
 * Sort comparator for nodes by `priority`, with unprioritized nodes last. Zero is a
 * valid priority, so this must not use `||`.
 */
export function compareNodePriority(a: { priority?: number }, b: { priority?: number }): number {
  return (a.priority ?? Infinity) - (b.priority ?? Infinity);
}

/**
 * Debounces a function call.
 *
 * @param fn - The function to debounce
 * @param delay - The delay in milliseconds
 * @returns A debounced version of the function
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Throttles a function call.
 *
 * @param fn - The function to throttle
 * @param limit - The minimum time between calls in milliseconds
 * @returns A throttled version of the function
 */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;

  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

/**
 * Creates a CSS class string from an object of class names.
 *
 * @param classes - Object with class names as keys and boolean values
 * @returns A space-separated string of class names
 */
export function classNames(classes: Record<string, boolean>): string {
  return Object.entries(classes)
    .filter(([, value]) => value)
    .map(([key]) => key)
    .join(' ');
}

/**
 * Formats a number with thousand separators.
 *
 * @param num - The number to format
 * @returns Formatted string with commas
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Formats bytes into human-readable size.
 *
 * @param bytes - Number of bytes
 * @returns Human-readable size string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Extracts filename from a path or URL.
 *
 * @param path - File path or URL
 * @returns Filename without path
 */
export function getFilename(path: string): string {
  // Handle both Unix and Windows path separators
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').pop()?.split('?')[0] || 'unknown';
}

/**
 * Computes the percentile value of an array using the linear interpolation method.
 * Uses sampling for large arrays to improve performance. NaN values (no-data)
 * are ignored.
 *
 * @param arr - The values to compute the percentile from
 * @param percentile - The percentile to compute (0-100)
 * @param maxSamples - Maximum number of samples to use for large arrays (default: 100000)
 * @returns The value at the given percentile, or 0 if there are no values
 */
export function computePercentile(
  arr: ArrayLike<number>,
  percentile: number,
  maxSamples: number = 100000
): number {
  // Sample the array if it's too large (stratified sampling for better
  // representation), skipping NaN
  const count = Math.min(arr.length, maxSamples);
  const step = arr.length / count;
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = arr[Math.floor(i * step)];
    if (!Number.isNaN(value)) {
      values.push(value);
    }
  }
  if (values.length === 0) return 0;

  // Sort the sampled values
  values.sort((a, b) => a - b);

  // Compute the index for the percentile
  const p = percentile / 100;
  const index = p * (values.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return values[lower];
  }

  // Linear interpolation between the two closest values
  const fraction = index - lower;
  return values[lower] * (1 - fraction) + values[upper] * fraction;
}

/**
 * Computes percentile bounds (e.g., 2nd and 98th percentile) for an array.
 *
 * @param arr - The values to compute bounds from
 * @param lowerPercentile - Lower percentile (default: 2)
 * @param upperPercentile - Upper percentile (default: 98)
 * @returns Object with min and max values at the specified percentiles
 */
export function computePercentileBounds(
  arr: ArrayLike<number>,
  lowerPercentile: number = 2,
  upperPercentile: number = 98
): { min: number; max: number } {
  if (arr.length === 0) return { min: 0, max: 1 };

  const min = computePercentile(arr, lowerPercentile);
  const max = computePercentile(arr, upperPercentile);

  // Ensure we have a valid range
  if (min === max) {
    return { min: min - 0.5, max: max + 0.5 };
  }

  return { min, max };
}

/**
 * Checks whether two optional bounds are equal.
 */
export function boundsEqual(a?: { min: number; max: number }, b?: { min: number; max: number }): boolean {
  return a === b || (a !== undefined && b !== undefined && a.min === b.min && a.max === b.max);
}

