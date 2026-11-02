import type { AttributeArray, PointCloudData } from '../loaders/types';
import type { ColormapName, ColorRangeConfig, ColorScheme, ColorSchemeConfig } from '../core/types';
import type { ClassificationColorMap, ColorRamp, RGBColor } from './types';
import { computePercentileBounds } from '../utils/helpers';
import { COLORMAPS } from './Colormaps';

/**
 * Color for point clouds that lack the attribute a custom scheme colors by
 */
const MISSING_ATTRIBUTE_COLOR: RGBColor = [ 128, 128, 128 ];

/** Prefix for custom attribute schemes */
const ATTRIBUTE_OPTION_PREFIX = 'attr:';

/**
 * How far, as a fraction of their range, gradient color bounds may move before points that
 * already have colors are recolored. Bounds from a growing point cloud shift a little with
 * every update, partly from sampling noise in percentile bounds, and recoloring every point
 * for that is what makes updates slow.
 */
const BOUNDS_REUSE_TOLERANCE = 0.05;

/**
 * ASPRS LAS classification standard colors
 */
export const CLASSIFICATION_COLORS: ClassificationColorMap = {
  0: [128, 128, 128],   // Created, never classified
  1: [128, 128, 128],   // Unclassified
  2: [165, 113, 78],    // Ground (brown)
  3: [144, 238, 144],   // Low Vegetation (light green)
  4: [34, 139, 34],     // Medium Vegetation (green)
  5: [0, 100, 0],       // High Vegetation (dark green)
  6: [255, 165, 0],     // Building (orange)
  7: [255, 0, 0],       // Low Point (noise) (red)
  8: [128, 128, 128],   // Reserved
  9: [0, 0, 255],       // Water (blue)
  10: [139, 90, 43],    // Rail
  11: [128, 128, 128],  // Road Surface
  12: [128, 128, 128],  // Reserved
  13: [255, 255, 0],    // Wire - Guard (yellow)
  14: [255, 200, 0],    // Wire - Conductor
  15: [200, 200, 0],    // Transmission Tower
  16: [100, 100, 100],  // Wire-Structure Connector
  17: [0, 128, 255],    // Bridge Deck
  18: [255, 0, 255],    // High Noise
};

/**
 * Per-code overrides of a classification's display name and colour, e.g. for
 * custom classes (ASPRS 64-255) an annotation tool defines.
 */
export type ClassificationStyles = Record<number, { name?: string; color?: [number, number, number] }>;

/**
 * The colour a classification code is drawn with.
 *
 * @param code - Classification code
 * @param styles - Optional per-code overrides
 * @returns RGB colour
 */
export function getClassificationColor(
  code: number,
  styles?: ClassificationStyles
): [number, number, number] {
  return styles?.[code]?.color ?? CLASSIFICATION_COLORS[code] ?? [128, 128, 128];
}

/**
 * Options for color generation
 */
export interface ColorOptions {
  /** Whether to use percentile range (2-98%) for elevation/intensity coloring (deprecated) */
  usePercentile?: boolean;
  /** Colormap to use for elevation/intensity coloring */
  colormap?: ColormapName;
  /** Configuration for color range mapping */
  colorRange?: ColorRangeConfig;
  /** Set of classification codes to hide (set alpha to 0) */
  hiddenClassifications?: Set<number>;
  /** Per-code classification name/colour overrides */
  classificationStyles?: ClassificationStyles;
}

/**
 * Result of color processing including computed bounds
 */
export interface ColorResult {
  /** The color array */
  colors: Uint8Array;
  /** The computed bounds used for coloring */
  bounds?: { min: number; max: number };
  /** Full range of the colored values, before any color range or percentile clipping */
  dataBounds?: { min: number; max: number };
  /** First point whose color was written; the colors of earlier points were kept */
  start: number;
}

/**
 * Colors computed earlier for the same point cloud, so only points from `start` need coloring.
 * `colors` is written in place, so it must fit every point, and `bounds` are the ones the
 * colors before `start` were computed with.
 */
export type ColorReuse = Pick<ColorResult, 'colors' | 'start' | 'bounds'>;

/**
 * Processes point cloud data into color arrays based on color scheme.
 */
export class ColorSchemeProcessor {
  /** Last computed color bounds (for colorbar display) */
  private _lastComputedBounds?: { min: number; max: number };
  /** Whether the categorical-not-implemented warning has been logged */
  private _warnedCategorical = false;

  /**
   * Generates a color array for the point cloud based on the color scheme.
   *
   * @param data - Point cloud data
   * @param scheme - Color scheme to apply
   * @param options - Optional color generation options
   * @returns Uint8Array of RGBA colors (length = pointCount * 4)
   */
  getColors(data: PointCloudData, scheme: ColorScheme, options: ColorOptions = {}): Uint8Array {
    const result = this.getColorsWithBounds(data, scheme, options);
    return result.colors;
  }

  /**
   * Generates a color array and returns the computed bounds.
   *
   * @param data - Point cloud data
   * @param scheme - Color scheme to apply
   * @param options - Optional color generation options
   * @param reuse - Colors from an earlier call for the same point cloud, to color only newer points
   * @returns ColorResult containing colors and computed bounds
   */
  getColorsWithBounds(
    data: PointCloudData,
    scheme: ColorScheme,
    options: ColorOptions = {},
    reuse?: ColorReuse
  ): ColorResult {
    const from: ColorReuse = reuse ?? { colors: new Uint8Array(data.pointCount * 4), start: 0 };
    const colormap = options.colormap ?? 'viridis';
    const colorRange = options.colorRange;
    const usePercentile = options.usePercentile ?? true;

    if (typeof scheme === 'string') {
      switch (scheme) {
        case 'elevation':
          return this._colorByElevation(data, from, colormap, colorRange, usePercentile);
        case 'intensity':
          return this._colorByIntensity(data, from, colormap, colorRange, usePercentile);
        case 'classification':
          return this._colorByClassification(
            data,
            from,
            options.hiddenClassifications,
            options.classificationStyles
          );
        case 'rgb':
          return this._colorByRGB(data, from);
        default:
          return this._colorByElevation(data, from, colormap, colorRange, usePercentile);
      }
    } else {
      return this._colorByCustom(data, from, scheme, colormap, colorRange, usePercentile);
    }
  }

  /**
   * Gets the last computed color bounds (for colorbar display).
   *
   * @returns The last computed bounds or undefined
   */
  getLastComputedBounds(): { min: number; max: number } | undefined {
    return this._lastComputedBounds;
  }

  /**
   * Computes the color bounds based on the configuration.
   *
   * @param values - Array of values to compute bounds for
   * @param dataBounds - Data bounds (min/max)
   * @param colorRange - Color range configuration
   * @param usePercentile - Legacy percentile flag
   * @returns Computed min and max bounds
   */
  private _computeBounds(
    values: ArrayLike<number>,
    dataBounds: { min: number; max: number },
    colorRange?: ColorRangeConfig,
    usePercentile?: boolean
  ): { min: number; max: number } {
    if (colorRange) {
      if (colorRange.mode === 'absolute') {
        return {
          min: colorRange.absoluteMin ?? dataBounds.min,
          max: colorRange.absoluteMax ?? dataBounds.max,
        };
      } else {
        // Percentile mode with configurable values
        const pLow = colorRange.percentileLow ?? 2;
        const pHigh = colorRange.percentileHigh ?? 98;
        return computePercentileBounds(values, pLow, pHigh);
      }
    } else if (usePercentile) {
      // Legacy behavior: 2-98% percentile
      return computePercentileBounds(values, 2, 98);
    } else {
      // Full range
      return dataBounds;
    }
  }

  /**
   * Colors points by elevation using the specified colormap.
   *
   * @param data - Point cloud data
   * @param from - Output color array, and where coloring starts
   * @param colormap - Colormap name to use
   * @param colorRange - Color range configuration
   * @param usePercentile - Legacy percentile flag
   * @returns ColorResult with colors and computed bounds
   */
  private _colorByElevation(
    data: PointCloudData,
    from: ColorReuse,
    colormap: ColormapName,
    colorRange?: ColorRangeConfig,
    usePercentile?: boolean
  ): ColorResult {
    // Guard against missing positions
    if (!data.positions || data.positions.length === 0) {
      return { colors: from.colors, start: from.start };
    }

    // Extract Z values
    const zValues = getElevationValues(data);

    // Use the header bounds rather than scanning every Z value
    const dataBounds = {
      min: data.bounds?.minZ ?? 0,
      max: data.bounds?.maxZ ?? 1,
    };

    const ramp = COLORMAPS[colormap] || COLORMAPS.viridis;
    return this._colorByValues(data, from, zValues, ramp, colorRange, usePercentile, dataBounds);
  }

  /**
   * Colors points by intensity using the specified colormap.
   *
   * @param data - Point cloud data
   * @param from - Output color array, and where coloring starts
   * @param colormap - Colormap name to use
   * @param colorRange - Color range configuration
   * @param usePercentile - Legacy percentile flag
   * @returns ColorResult with colors and computed bounds
   */
  private _colorByIntensity(
    data: PointCloudData,
    from: ColorReuse,
    colormap: ColormapName,
    colorRange?: ColorRangeConfig,
    usePercentile?: boolean
  ): ColorResult {
    if (!data.hasIntensity || !data.intensities) {
      // Fall back to elevation if no intensity data
      return this._colorByElevation(data, from, colormap, colorRange, usePercentile);
    }

    const ramp = COLORMAPS[colormap] || COLORMAPS.gray;
    return this._colorByValues(data, from, data.intensities, ramp, colorRange, usePercentile);
  }

  /**
   * Colors points by classification using ASPRS standard colors.
   *
   * @param data - Point cloud data
   * @param from - Output color array, and where coloring starts
   * @param hiddenClassifications - Optional set of classification codes to hide (alpha=0)
   * @returns ColorResult with colors
   */
  private _colorByClassification(
    data: PointCloudData,
    from: ColorReuse,
    hiddenClassifications?: Set<number>,
    styles?: ClassificationStyles
  ): ColorResult {
    if (!data.hasClassification || !data.classifications) {
      // Fall back to elevation if no classification data
      const result = this._colorByElevation(data, from, 'viridis', undefined, true);
      return { colors: result.colors, start: result.start };
    }

    const { colors } = from;
    for (let i = from.start; i < data.pointCount; i++) {
      const cls = data.classifications[i];
      const color = getClassificationColor(cls, styles);
      colors[i * 4] = color[0];
      colors[i * 4 + 1] = color[1];
      colors[i * 4 + 2] = color[2];
      // Set alpha to 0 if classification is hidden, otherwise 255
      colors[i * 4 + 3] = hiddenClassifications?.has(cls) ? 0 : 255;
    }
    return { colors, start: from.start };
  }

  /**
   * Uses embedded RGB colors from the point cloud.
   *
   * @param data - Point cloud data
   * @param from - Output color array, and where coloring starts
   * @returns ColorResult with colors
   */
  private _colorByRGB(data: PointCloudData, from: ColorReuse): ColorResult {
    if (!data.hasRGB || !data.colors) {
      // Fall back to elevation if no RGB data
      const result = this._colorByElevation(data, from, 'viridis', undefined, true);
      return { colors: result.colors, start: result.start };
    }

    // data.colors is stored as RGBA (4 bytes per point)
    const { colors } = from;
    for (let i = from.start; i < data.pointCount; i++) {
      colors[i * 4] = data.colors[i * 4];
      colors[i * 4 + 1] = data.colors[i * 4 + 1];
      colors[i * 4 + 2] = data.colors[i * 4 + 2];
      colors[i * 4 + 3] = 255;
    }
    return { colors, start: from.start };
  }

  /**
   * Applies a custom color scheme configuration, coloring by an arbitrary
   * point attribute.
   *
   * `categorical` configs are not implemented yet and are drawn as gradients,
   * with a one-time warning.
   *
   * @param data - Point cloud data
   * @param from - Output color array, and where coloring starts
   * @param config - Custom color scheme config
   * @param colormap - Colormap name to use when the config has no colors
   * @param colorRange - Color range configuration
   * @param usePercentile - Legacy percentile flag
   * @returns ColorResult with colors and computed bounds
   */
  private _colorByCustom(
    data: PointCloudData,
    from: ColorReuse,
    config: ColorSchemeConfig,
    colormap: ColormapName,
    colorRange?: ColorRangeConfig,
    usePercentile?: boolean
  ): ColorResult {
    if (config.type === 'categorical' && !this._warnedCategorical) {
      // Warn once; this runs for every streamed node
      this._warnedCategorical = true;
      console.warn('Categorical color schemes are not implemented; drawing as a gradient');
    }

    const values = getAttributeValues(data, config.attribute);
    const valueBounds = values ? computeValueBounds(values, data.pointCount) : undefined;
    if (!values || !valueBounds) {
      // This point cloud lacks the attribute (or has only no-data values). Draw
      // it in a neutral color, with no bounds, so it isn't mistaken for colored
      // data and the colorbar keeps the range of a cloud that has the attribute.
      // Points before `from.start` were colored by the attribute if they had bounds.
      const start = from.bounds ? 0 : from.start;
      const { colors } = from;
      for (let i = start; i < data.pointCount; i++) {
        colors[i * 4] = MISSING_ATTRIBUTE_COLOR[0];
        colors[i * 4 + 1] = MISSING_ATTRIBUTE_COLOR[1];
        colors[i * 4 + 2] = MISSING_ATTRIBUTE_COLOR[2];
        colors[i * 4 + 3] = 255;
      }
      return { colors, start };
    }

    const ramp = getCustomColorRamp(config) ?? COLORMAPS[colormap] ?? COLORMAPS.viridis;
    const domain = config.domain ? { min: config.domain[0], max: config.domain[1] } : valueBounds;
    return this._colorByValues(data, from, values, ramp, colorRange, usePercentile, domain);
  }

  /**
   * Colors points along a color ramp by per-point values. NaN values (no-data)
   * are drawn in the missing-attribute color.
   *
   * @param data - Point cloud data
   * @param from - Output color array, and where coloring starts. Coloring starts at 0 instead when the bounds have
   *   moved too far from the ones the earlier points were colored with.
   * @param values - Per-point values (length = data.pointCount)
   * @param ramp - Color ramp to interpolate
   * @param colorRange - Color range configuration
   * @param usePercentile - Legacy percentile flag
   * @param dataBounds - Full range of the values; computed from `values` when omitted
   * @returns ColorResult with colors, computed bounds and data bounds
   */
  private _colorByValues(
    data: PointCloudData,
    from: ColorReuse,
    values: ArrayLike<number>,
    ramp: ColorRamp,
    colorRange?: ColorRangeConfig,
    usePercentile?: boolean,
    dataBounds: { min: number; max: number } = computeValueBounds(values, data.pointCount) ?? { min: 0, max: 1 },
  ): ColorResult {
    // Compute color bounds based on configuration, keeping the earlier points' bounds
    // while they're close enough that those points needn't be recolored
    let bounds = this._computeBounds(values, dataBounds, colorRange, usePercentile);
    let start = 0;
    if (from.start > 0 && from.bounds && boundsWithinTolerance(from.bounds, bounds)) {
      bounds = from.bounds;
      start = from.start;
    }
    this._lastComputedBounds = bounds;

    const { colors } = from;
    const { min, max } = bounds;
    const range = max - min || 1;

    for (let i = start; i < data.pointCount; i++) {
      const value = values[i];
      if (Number.isNaN(value)) {
        colors[i * 4] = MISSING_ATTRIBUTE_COLOR[0];
        colors[i * 4 + 1] = MISSING_ATTRIBUTE_COLOR[1];
        colors[i * 4 + 2] = MISSING_ATTRIBUTE_COLOR[2];
      } else {
        this._writeRampColor(ramp, (value - min) / range, colors, i * 4);
      }
      colors[i * 4 + 3] = 255;
    }

    return { colors, bounds, dataBounds, start };
  }

  /**
   * Interpolates a color from a color ramp, writing it to `colors` rather than allocating one.
   *
   * @param ramp - Color ramp array
   * @param t - Interpolation parameter (0-1)
   * @param colors - Color array to write the RGB components to
   * @param offset - Index in `colors` of the red component
   */
  private _writeRampColor(ramp: ColorRamp, t: number, colors: Uint8Array, offset: number): void {
    // Handle NaN or invalid t values
    if (!Number.isFinite(t)) {
      colors[offset] = ramp[0][0];
      colors[offset + 1] = ramp[0][1];
      colors[offset + 2] = ramp[0][2];
      return;
    }

    const clampedT = Math.max(0, Math.min(1, t));
    const idx = Math.min(
      Math.floor(clampedT * (ramp.length - 1)),
      ramp.length - 2
    );
    const localT = clampedT * (ramp.length - 1) - idx;
    const low = ramp[idx];
    const high = ramp[idx + 1];

    colors[offset] = Math.round(low[0] + (high[0] - low[0]) * localT);
    colors[offset + 1] = Math.round(low[1] + (high[1] - low[1]) * localT);
    colors[offset + 2] = Math.round(low[2] + (high[2] - low[2]) * localT);
  }
}

/**
 * Gets the name of a classification code.
 */
export function getClassificationName(code: number, styles?: ClassificationStyles): string {
  const custom = styles?.[code]?.name;
  if (custom) return custom;
  const names: Record<number, string> = {
    0: 'Never Classified',
    1: 'Unclassified',
    2: 'Ground',
    3: 'Low Vegetation',
    4: 'Medium Vegetation',
    5: 'High Vegetation',
    6: 'Building',
    7: 'Low Point (Noise)',
    8: 'Reserved',
    9: 'Water',
    10: 'Rail',
    11: 'Road Surface',
    12: 'Reserved',
    13: 'Wire - Guard',
    14: 'Wire - Conductor',
    15: 'Transmission Tower',
    16: 'Wire-Structure Connector',
    17: 'Bridge Deck',
    18: 'High Noise',
  };
  return names[code] || `Class ${code}`;
}

/**
 * Extracts the set of unique classification codes present in the point cloud data.
 *
 * @param data - Point cloud data
 * @param start - First point to look at
 * @returns Set of classification codes found in the data
 */
export function getAvailableClassifications(data: PointCloudData, start: number = 0): Set<number> {
  const classifications = new Set<number>();
  if (data.hasClassification && data.classifications) {
    for (let i = start; i < data.pointCount; i++) {
      classifications.add(data.classifications[i]);
    }
  }
  return classifications;
}

/**
 * Converts a color scheme into a string domain key.
 */
export function colorSchemeToDomainKey(scheme: ColorScheme): string {
  return typeof scheme === 'string' ? scheme : `${ATTRIBUTE_OPTION_PREFIX}${scheme.attribute}`;
}

/**
 * Converts a domain key back into a gradient color scheme.
 */
export function domainKeyToColorScheme(value: string): ColorScheme {
  if (value.startsWith(ATTRIBUTE_OPTION_PREFIX)) {
    // If extra attributes can be colored other than 'gradient', build machinery to handle that
    return { type: 'gradient', attribute: value.slice(ATTRIBUTE_OPTION_PREFIX.length) };
  }
  return value as ColorScheme;
}

/**
 * Checks whether a color scheme colors points along a continuous gradient
 * (elevation, intensity or a custom attribute) and so uses the colormap,
 * colorbar and color range controls.
 *
 * @param scheme - Color scheme to check
 * @returns True for gradient schemes, false for classification and rgb
 */
export function isGradientColorScheme(scheme: ColorScheme): boolean {
  return typeof scheme === 'string' ? scheme === 'elevation' || scheme === 'intensity' : true;
}

/**
 * Formats an attribute name for display, splitting CamelCase and
 * underscores into words
 *
 * @param name - Attribute name
 * @returns Display label
 */
export function formatAttributeLabel(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

/**
 * Gets an extra attribute's values, in their stored type
 *
 * @param data - Point cloud data
 * @param attribute - Attribute name (key into data.extraAttributes)
 * @returns Per-point values, or undefined if the point cloud lacks the attribute
 */
export function getAttributeValues(data: PointCloudData, attribute: string): AttributeArray | undefined {
  const source = data.extraAttributes?.[attribute];
  return source && source.length > 0 ? source : undefined;
}

/**
 * Extracts each point's Z (elevation) value.
 *
 * @param data - Point cloud data
 * @returns Per-point Z values
 */
export function getElevationValues(data: PointCloudData): Float32Array {
  const values = new Float32Array(data.pointCount);
  for (let i = 0; i < data.pointCount; i++) {
    values[i] = data.positions[i * 3 + 2] ?? 0;
  }
  return values;
}

/**
 * Resolves the per-point values a color scheme colors by, mirroring each
 * colorizer's fallbacks so a range filter matches what is rendered.
 *
 * @param data - Point cloud data
 * @param scheme - Color scheme to resolve values for
 * @returns Per-point values, or undefined when the scheme has no continuous domain
 */
export function getSchemeFilterValues(data: PointCloudData, scheme: ColorScheme): AttributeArray | undefined {
  if (typeof scheme !== 'string') {
    return getAttributeValues(data, scheme.attribute);
  }
  switch (scheme) {
    case 'classification':
    case 'rgb':
      return undefined;
    case 'intensity':
      return data.hasIntensity && data.intensities ? data.intensities : getElevationValues(data);
    case 'elevation':
    default:
      return getElevationValues(data);
  }
}

/**
 * Gets the custom color ramp of a color scheme, if it has one.
 *
 * @param scheme - Color scheme
 * @returns The ramp from the scheme's `colors`, or undefined to use the colormap
 */
export function getCustomColorRamp(scheme: ColorScheme): ColorRamp | undefined {
  return typeof scheme === 'string' ? undefined : parseColorRamp(scheme.colors);
}

/**
 * Whether `next` bounds are within {@link BOUNDS_REUSE_TOLERANCE} of `previous` ones.
 */
function boundsWithinTolerance(previous: { min: number; max: number }, next: { min: number; max: number }): boolean {
  const tolerance = (previous.max - previous.min) * BOUNDS_REUSE_TOLERANCE;
  return Math.abs(next.min - previous.min) <= tolerance && Math.abs(next.max - previous.max) <= tolerance;
}

/**
 * Computes the min and max of the first `count` values, ignoring NaN.
 *
 * @returns The bounds, or undefined if there are no non-NaN values
 */
function computeValueBounds(values: ArrayLike<number>, count: number): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    const value = values[i];
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  return min <= max ? { min, max } : undefined;
}

/**
 * Parses CSS hex colors (`#rgb` or `#rrggbb`) into a color ramp.
 *
 * @returns The ramp, or undefined unless every color parses and there are at least two
 */
function parseColorRamp(hexColors?: string[]): ColorRamp | undefined {
  if (!hexColors || hexColors.length < 2) {
    return undefined;
  }
  const ramp: ColorRamp = [];
  for (const hex of hexColors) {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
    if (!match) {
      return undefined;
    }
    const digits = match[1].length === 3 ? match[1].replace(/./g, '$&$&') : match[1];
    const n = parseInt(digits, 16);
    ramp.push([ (n >> 16) & 255, (n >> 8) & 255, n & 255 ]);
  }
  return ramp;
}
