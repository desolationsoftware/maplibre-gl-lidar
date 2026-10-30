import { PointCloudLayer } from '@deck.gl/layers';
import type { PickingInfo } from '@deck.gl/core';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { DeckOverlay } from '../core/DeckOverlay';
import type { PointCloudData } from '../loaders/types';
import type { ColormapName, ColorRangeConfig, ColorScheme, PointCloudBounds } from '../core/types';
import type { PickedPointInfo, PointCloudLayerOptions } from './types';
import { ColorSchemeProcessor, getSchemeFilterValues } from '../colorizers/ColorScheme';

// Web Mercator ground resolution at zoom 0 (meters/pixel at the equator) for a 512px tile.
const WEB_MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 = 78271.51696402048;

/**
 * Converts a pixel size at `referenceZoom` into meters.
 */
function pointSizeMeters(
  sizePixels: number,
  referenceZoom: number,
  latitudeDeg: number,
  minMeters: number,
): number {
  const metersPerPixel =
    (WEB_MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 * Math.cos((latitudeDeg * Math.PI) / 180)) /
    2 ** referenceZoom;
  return Math.max(sizePixels * metersPerPixel, minMeters);
}

/**
 * Chunk size - 1 million points per layer to stay within WebGL limits
 */
const CHUNK_SIZE = 1000000;

/**
 * `colors` when it holds at least `length` bytes, otherwise a larger array with its first `keep`
 * bytes. Grows by half again, so the colors of a streamed cloud aren't reallocated every update.
 */
function colorsWithCapacity(colors: Uint8Array, length: number, keep: number): Uint8Array {
  if (colors.length >= length) {
    return colors;
  }
  const grown = new Uint8Array(Math.max(length, Math.floor(colors.length * 1.5)));
  grown.set(colors.subarray(0, keep));
  return grown;
}

/**
 * Internal point cloud data with computed colors
 */
interface ManagedPointCloud {
  id: string;
  data: PointCloudData;
  /** Per-point RGBA colors. May be longer than the data, to leave room for streamed points. */
  colors: Uint8Array;
  /** Bounds `colors` were computed with, if the color scheme has them */
  colorBounds?: { min: number; max: number };
  coordinateOrigin: [number, number, number]; // [lng, lat, 0] center point
  /** Per-layer visibility (default: true) */
  visible: boolean;
  /** Per-layer opacity override (null means use global) */
  opacityOverride: number | null;
  /** Point counts of the deck.gl chunk layers currently created for this point cloud */
  chunkSizes: number[];
  /** Full range of the gradient-colored values, if the current scheme yielded one */
  dataBounds?: { min: number; max: number };
}

/**
 * Manages deck.gl PointCloudLayer instances for visualization.
 */
export class PointCloudManager {
  private _deckOverlay: DeckOverlay;
  private _pointClouds: Map<string, ManagedPointCloud>;
  private _options: PointCloudLayerOptions;
  private _colorProcessor: ColorSchemeProcessor;
  private _lastComputedBounds?: { min: number; max: number };

  constructor(deckOverlay: DeckOverlay, options: Partial<PointCloudLayerOptions> = {}) {
    this._deckOverlay = deckOverlay;
    this._pointClouds = new Map();
    this._colorProcessor = new ColorSchemeProcessor();
    this._options = {
      pointSize: options.pointSize ?? 2,
      pointSizeReferenceZoom: options.pointSizeReferenceZoom,
      minPointSizeMeters: options.minPointSizeMeters ?? 0,
      opacity: options.opacity ?? 1.0,
      colorScheme: options.colorScheme ?? 'elevation',
      usePercentile: options.usePercentile ?? true,
      colormap: options.colormap ?? 'viridis',
      colorRange: options.colorRange,
      elevationRange: options.elevationRange ?? null,
      filterRange: options.filterRange ?? null,
      pickable: options.pickable ?? false,
      zOffset: options.zOffset ?? 0,
      classificationStyles: options.classificationStyles,
      onHover: options.onHover,
      onClick: options.onClick,
    };
  }

  /**
   * Sets the hover callback.
   *
   * @param callback - Function called when a point is hovered
   */
  setOnHover(callback: ((info: PickedPointInfo | null) => void) | undefined): void {
    this._options.onHover = callback;
  }

  /**
   * Adds a point cloud to the visualization.
   *
   * @param id - Unique identifier for the point cloud
   * @param data - Point cloud data (positions are already offsets from coordinateOrigin)
   */
  addPointCloud(id: string, data: PointCloudData): void {
    const result = this._colorProcessor.getColorsWithBounds(data, this._options.colorScheme, {
      usePercentile: this._options.usePercentile,
      colormap: this._options.colormap,
      colorRange: this._options.colorRange,
      hiddenClassifications: this._options.hiddenClassifications,
      classificationStyles: this._options.classificationStyles,
    });

    // Store the computed bounds for colorbar display
    if (result.bounds) {
      this._lastComputedBounds = result.bounds;
    }

    // Use the coordinate origin from the data - positions are already stored as offsets
    const coordinateOrigin = data.coordinateOrigin;

    this._pointClouds.set(id, {
      id,
      data,
      colors: result.colors,
      colorBounds: result.bounds,
      coordinateOrigin,
      visible: true,
      opacityOverride: null,
      chunkSizes: [],
      dataBounds: result.dataBounds,
    });
    this._createLayer(id);
  }

  /**
   * Updates an existing point cloud with new data.
   * Used for streaming/incremental loading where points are added over time.
   *
   * @param id - Unique identifier for the point cloud
   * @param data - Updated point cloud data
   */
  updatePointCloud(id: string, data: PointCloudData): void {
    const existing = this._pointClouds.get(id);

    if (!data.positions || data.pointCount === 0) {
      if (existing) {
        this._pointClouds.set(id, {
          id,
          data,
          colors: new Uint8Array(0),
          coordinateOrigin: data.coordinateOrigin,
          visible: existing.visible,
          opacityOverride: existing.opacityOverride,
          chunkSizes: existing.chunkSizes,
        });
        this._createLayer(id);
      }
      return;
    }

    if (existing) {
      // Points before `changedFrom` are as they were last update, so they keep their colors
      // and, where a whole chunk of them is unchanged, their layer
      const changedFrom = Math.min(data.changedFrom ?? 0, existing.data.pointCount);
      const result = this._colorProcessor.getColorsWithBounds(data, this._options.colorScheme, {
        usePercentile: this._options.usePercentile,
        colormap: this._options.colormap,
        colorRange: this._options.colorRange,
        hiddenClassifications: this._options.hiddenClassifications,
        classificationStyles: this._options.classificationStyles,
      }, {
        colors: colorsWithCapacity(existing.colors, data.pointCount * 4, changedFrom * 4),
        start: changedFrom,
        bounds: existing.colorBounds,
      });

      // Store the computed bounds for colorbar display
      if (result.bounds) {
        this._lastComputedBounds = result.bounds;
      }

      this._pointClouds.set(id, {
        id,
        data,
        colors: result.colors,
        colorBounds: result.bounds,
        coordinateOrigin: data.coordinateOrigin,
        visible: existing.visible,
        opacityOverride: existing.opacityOverride,
        chunkSizes: existing.chunkSizes,
        dataBounds: result.dataBounds,
      });

      // Recolored points need their layers rebuilt too, and every layer does once the
      // loader reallocates its buffers, so none keeps rendering from the old ones
      const sameBuffers = data.positions.buffer === existing.data.positions?.buffer;
      this._createLayer(id, sameBuffers ? result.start : 0);
    } else {
      // New point cloud - use existing addPointCloud
      this.addPointCloud(id, data);
    }
  }

  /**
   * Gets the current point count for a point cloud.
   *
   * @param id - Point cloud ID
   * @returns Point count or 0 if not found
   */
  getPointCount(id: string): number {
    return this._pointClouds.get(id)?.data.pointCount || 0;
  }

  /**
   * Removes a point cloud from the visualization.
   *
   * @param id - ID of the point cloud to remove
   */
  removePointCloud(id: string): void {
    const pc = this._pointClouds.get(id);
    if (pc) {
      this._removeChunkLayers(id, 0, pc.chunkSizes.length);
    }
    this._pointClouds.delete(id);
  }

  /**
   * Checks if a point cloud exists.
   *
   * @param id - Point cloud ID
   * @returns True if exists
   */
  hasPointCloud(id: string): boolean {
    return this._pointClouds.has(id);
  }

  /**
   * Gets all point cloud IDs.
   *
   * @returns Array of point cloud IDs
   */
  getPointCloudIds(): string[] {
    return Array.from(this._pointClouds.keys());
  }

  /**
   * Gets the bounds of a point cloud.
   *
   * @param id - Point cloud ID
   * @returns Bounds or undefined if not found
   */
  getPointCloudBounds(id: string): PointCloudBounds | undefined {
    return this._pointClouds.get(id)?.data.bounds;
  }

  /**
   * Updates styling options for all point clouds.
   *
   * @param options - New style options
   */
  updateStyle(options: Partial<PointCloudLayerOptions>): void {
    const colorSchemeChanged = options.colorScheme !== undefined &&
      options.colorScheme !== this._options.colorScheme;
    const percentileChanged = options.usePercentile !== undefined &&
      options.usePercentile !== this._options.usePercentile;
    const colormapChanged = options.colormap !== undefined &&
      options.colormap !== this._options.colormap;
    const colorRangeChanged = options.colorRange !== undefined;
    const hiddenClassificationsChanged = options.hiddenClassifications !== undefined;
    const classificationStylesChanged = options.classificationStyles !== undefined;

    this._options = { ...this._options, ...options };

    // If color-related settings changed, recompute colors
    if (
      colorSchemeChanged ||
      percentileChanged ||
      colormapChanged ||
      colorRangeChanged ||
      hiddenClassificationsChanged ||
      classificationStylesChanged
    ) {
      // Drop bounds from the previous settings, which may yield none (e.g. no
      // point cloud has the color-by attribute)
      this._lastComputedBounds = undefined;
      for (const [id, pc] of this._pointClouds) {
        const result = this._colorProcessor.getColorsWithBounds(pc.data, this._options.colorScheme, {
          usePercentile: this._options.usePercentile,
          colormap: this._options.colormap,
          colorRange: this._options.colorRange,
          hiddenClassifications: this._options.hiddenClassifications,
          classificationStyles: this._options.classificationStyles,
        });

        // Store the computed bounds for colorbar display
        if (result.bounds) {
          this._lastComputedBounds = result.bounds;
        }

        this._pointClouds.set(id, {
          ...pc,
          colors: result.colors,
          colorBounds: result.bounds,
          coordinateOrigin: pc.coordinateOrigin,
          visible: pc.visible,
          opacityOverride: pc.opacityOverride,
          dataBounds: result.dataBounds,
        });
      }
    }

    // Recreate all layers with new options
    this._updateAllLayers();
  }

  /**
   * Sets the point size.
   *
   * @param size - Point size in pixels (at `pointSizeReferenceZoom` when set)
   */
  setPointSize(size: number): void {
    this.updateStyle({ pointSize: size });
  }

  /**
   * Sets the global opacity for all point clouds.
   * This also clears any per-layer opacity overrides so the global value takes effect.
   *
   * @param opacity - Opacity value (0-1)
   */
  setOpacity(opacity: number): void {
    // Clear all per-layer opacity overrides so global opacity takes effect
    for (const [id, pc] of this._pointClouds) {
      if (pc.opacityOverride !== null) {
        this._pointClouds.set(id, { ...pc, opacityOverride: null });
      }
    }
    this.updateStyle({ opacity });
  }

  /**
   * Sets the color scheme.
   *
   * @param scheme - Color scheme to apply
   */
  setColorScheme(scheme: ColorScheme): void {
    this.updateStyle({ colorScheme: scheme });
  }

  /**
   * Sets whether to use percentile range for elevation/intensity coloring.
   *
   * @param usePercentile - Whether to use percentile range (2-98%)
   */
  setUsePercentile(usePercentile: boolean): void {
    this.updateStyle({ usePercentile });
  }

  /**
   * Sets the colormap for elevation/intensity coloring.
   *
   * @param colormap - Colormap name
   */
  setColormap(colormap: ColormapName): void {
    this.updateStyle({ colormap });
  }

  /**
   * Sets the color range configuration.
   *
   * @param colorRange - Color range configuration
   */
  setColorRange(colorRange: ColorRangeConfig): void {
    this.updateStyle({ colorRange });
  }

  /**
   * Sets the elevation range filter.
   *
   * @param range - [min, max] elevation or null to disable
   */
  setElevationRange(range: [number, number] | null): void {
    this.updateStyle({ elevationRange: range });
  }

  /**
   * Sets the range filter, excluding points whose value for the current
   * color scheme falls outside [min, max].
   *
   * @param range - [min, max] or null to disable
   */
  setFilterRange(range: [number, number] | null): void {
    this.updateStyle({ filterRange: range });
  }

  /**
   * Sets whether points are pickable (enables hover/click interactions).
   *
   * @param pickable - Whether points should be pickable
   */
  setPickable(pickable: boolean): void {
    this.updateStyle({ pickable });
  }

  /**
   * Sets the Z offset for vertical adjustment.
   *
   * @param offset - Z offset in meters
   */
  setZOffset(offset: number): void {
    this.updateStyle({ zOffset: offset });
  }

  /**
   * Sets the hidden classifications for filtering.
   *
   * @param hidden - Set of classification codes to hide
   */
  setHiddenClassifications(hidden: Set<number>): void {
    this.updateStyle({ hiddenClassifications: hidden });
  }

  /**
   * Sets visibility for a specific point cloud.
   *
   * @param id - Point cloud ID
   * @param visible - Whether the point cloud should be visible
   */
  setPointCloudVisibility(id: string, visible: boolean): void {
    const pc = this._pointClouds.get(id);
    if (pc) {
      this._pointClouds.set(id, { ...pc, visible });
      this._createLayer(id);
    }
  }

  /**
   * Gets visibility for a specific point cloud.
   *
   * @param id - Point cloud ID
   * @returns Whether the point cloud is visible, or undefined if not found
   */
  getPointCloudVisibility(id: string): boolean | undefined {
    return this._pointClouds.get(id)?.visible;
  }

  /**
   * Sets opacity for a specific point cloud.
   *
   * @param id - Point cloud ID
   * @param opacity - Opacity value (0-1), or null to use global opacity
   */
  setPointCloudOpacity(id: string, opacity: number | null): void {
    const pc = this._pointClouds.get(id);
    if (pc) {
      this._pointClouds.set(id, { ...pc, opacityOverride: opacity });
      this._createLayer(id);
    }
  }

  /**
   * Gets opacity for a specific point cloud.
   *
   * @param id - Point cloud ID
   * @returns Opacity value (0-1), or undefined if not found
   */
  getPointCloudOpacity(id: string): number | undefined {
    const pc = this._pointClouds.get(id);
    if (!pc) return undefined;
    return pc.opacityOverride ?? this._options.opacity;
  }

  /**
   * Clears all point clouds.
   */
  clear(): void {
    for (const [id, pc] of this._pointClouds) {
      this._removeChunkLayers(id, 0, pc.chunkSizes.length);
    }
    this._pointClouds.clear();
  }

  /**
   * Gets the current options.
   */
  getOptions(): PointCloudLayerOptions {
    return { ...this._options };
  }

  /**
   * Gets the live data of a loaded point cloud. The arrays are the ones the
   * layers render from (for a streamed cloud, views of the loader's buffers),
   * so in-place edits such as reclassification show after {@link refreshColors}.
   *
   * @param id - Point cloud id
   * @returns The data, or null when no such cloud is loaded
   */
  getPointCloudData(id: string): PointCloudData | null {
    return this._pointClouds.get(id)?.data ?? null;
  }

  /**
   * Recomputes every cloud's colours from its current data and rebuilds the
   * layers. Call after editing point attributes (e.g. classifications) in place.
   */
  refreshColors(): void {
    this.updateStyle({ hiddenClassifications: this._options.hiddenClassifications ?? new Set() });
  }

  /**
   * Gets the last computed color bounds.
   * Used for displaying accurate colorbar min/max values.
   */
  getLastComputedBounds(): { min: number; max: number } | undefined {
    return this._lastComputedBounds;
  }

  /**
   * Gets the full range of the gradient-colored values across all point clouds.
   * Used as the slider range for absolute color range controls.
   *
   * @returns The combined range, or undefined if no point cloud yielded one
   */
  getDataBounds(): { min: number; max: number } | undefined {
    let bounds: { min: number; max: number } | undefined;
    for (const pc of this._pointClouds.values()) {
      if (pc.dataBounds) {
        bounds = bounds
          ? { min: Math.min(bounds.min, pc.dataBounds.min), max: Math.max(bounds.max, pc.dataBounds.max) }
          : pc.dataBounds;
      }
    }
    return bounds;
  }

  /**
   * Gets merged point cloud data from all loaded point clouds.
   * Used for cross-section profile extraction.
   *
   * @returns Merged point cloud data or null if no data loaded
   */
  getMergedPointCloudData(): PointCloudData | null {
    if (this._pointClouds.size === 0) return null;

    // If only one point cloud, return it directly
    if (this._pointClouds.size === 1) {
      const [first] = this._pointClouds.values();
      return first.data;
    }

    // Merge multiple point clouds
    // Calculate total point count
    let totalPoints = 0;
    for (const pc of this._pointClouds.values()) {
      totalPoints += pc.data.pointCount;
    }

    if (totalPoints === 0) return null;

    // Use the first point cloud's coordinate origin
    const [firstPc] = this._pointClouds.values();
    const originLng = firstPc.coordinateOrigin[0];
    const originLat = firstPc.coordinateOrigin[1];

    // Allocate merged arrays
    const positions = new Float32Array(totalPoints * 3);
    const intensities = new Float32Array(totalPoints);
    const classifications = new Uint8Array(totalPoints);

    let offset = 0;
    for (const pc of this._pointClouds.values()) {
      const data = pc.data;
      const count = data.pointCount;

      // Adjust positions to common origin
      const dLng = pc.coordinateOrigin[0] - originLng;
      const dLat = pc.coordinateOrigin[1] - originLat;

      for (let i = 0; i < count; i++) {
        positions[(offset + i) * 3] = data.positions[i * 3] + dLng;
        positions[(offset + i) * 3 + 1] = data.positions[i * 3 + 1] + dLat;
        positions[(offset + i) * 3 + 2] = data.positions[i * 3 + 2];
      }

      if (data.intensities) {
        intensities.set(data.intensities.subarray(0, count), offset);
      }

      if (data.classifications) {
        classifications.set(data.classifications.subarray(0, count), offset);
      }

      offset += count;
    }

    return {
      positions,
      coordinateOrigin: [originLng, originLat, 0],
      intensities,
      classifications,
      pointCount: totalPoints,
      bounds: firstPc.data.bounds,
      hasRGB: firstPc.data.hasRGB,
      hasIntensity: true,
      hasClassification: true,
    };
  }

  /**
   * Creates a deck.gl layer for a point cloud.
   * Chunks large point clouds into multiple layers to avoid WebGL buffer limits.
   * Uses coordinateOrigin + LNGLAT_OFFSETS to maintain Float32 precision.
   * Applies the elevation filter and color scheme range filter if set.
   *
   * @param id - Point cloud id
   * @param changedFrom - First point whose data or color changed since the layers were last
   *   created. Chunks of points before it keep their layers, unless a filter is active.
   */
  private _createLayer(id: string, changedFrom: number = 0): void {
    const pc = this._pointClouds.get(id);
    if (!pc) return;

    const { data, colors, coordinateOrigin, visible, opacityOverride } = pc;
    const elevationRange = this._options.elevationRange;
    const filterRange = this._options.filterRange ?? null;
    const zOffset = this._options.zOffset ?? 0;
    const layerOpacity = opacityOverride ?? this._options.opacity;

    // If layer is not visible, don't create any layers
    if (!visible) {
      this._removeChunkLayers(id, 0, pc.chunkSizes.length);
      this._pointClouds.set(id, { ...pc, chunkSizes: [] });
      return;
    }

    // Build filtered indices list. Schemes without a continuous domain have
    // no filter values, so the range filter passes every point. When no
    // filter is active the list is left null rather than built as the
    // identity, since layers are rebuilt often and filtering is the rare case.
    const filterValues = filterRange ? getSchemeFilterValues(data, this._options.colorScheme) : undefined;
    const rangeFilterActive = filterRange !== null && filterValues !== undefined;
    let filteredIndices: number[] | null = null;

    if (elevationRange !== null || rangeFilterActive) {
      filteredIndices = [];
      for (let i = 0; i < data.pointCount; i++) {
        const elevation = data.positions[i * 3 + 2];
        if (elevationRange !== null &&
            (elevation < elevationRange[0] || elevation > elevationRange[1])) {
          continue;
        }
        if (rangeFilterActive &&
            (filterValues[i] < filterRange[0] || filterValues[i] > filterRange[1])) {
          continue;
        }
        filteredIndices.push(i);
      }
    }
    const visibleCount = filteredIndices?.length ?? data.pointCount;

    // If no points pass the filter, don't create any layers
    if (visibleCount === 0) {
      this._removeChunkLayers(id, 0, pc.chunkSizes.length);
      this._pointClouds.set(id, { ...pc, chunkSizes: [] });
      return;
    }

    const numChunks = Math.ceil(visibleCount / CHUNK_SIZE);
    const chunkSizes: number[] = [];
    // The Z offset is applied through the origin, so unfiltered chunks can render straight
    // from the point cloud's arrays rather than copies of them
    const layerOrigin: [number, number, number] = [
      coordinateOrigin[0],
      coordinateOrigin[1],
      (coordinateOrigin[2] ?? 0) + zOffset,
    ];

    for (let chunk = 0; chunk < numChunks; chunk++) {
      const chunkStart = chunk * CHUNK_SIZE;
      const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, visibleCount);
      const chunkSize = chunkEnd - chunkStart;
      chunkSizes.push(chunkSize);

      // Unchanged since its layer was created: keep the layer, so deck.gl doesn't upload it again
      if (filteredIndices == null && chunkEnd <= changedFrom && pc.chunkSizes[chunk] === chunkSize) {
        continue;
      }

      // Maps an index within this chunk back to the point's index in data.
      const toSourceIndex = (chunkIndex: number): number =>
        filteredIndices != null ? filteredIndices[chunkStart + chunkIndex] : chunkStart + chunkIndex;

      let chunkPositions: Float32Array;
      let chunkColors: Uint8Array;
      if (filteredIndices == null) {
        chunkPositions = data.positions.subarray(chunkStart * 3, chunkEnd * 3);
        chunkColors = colors.subarray(chunkStart * 4, chunkEnd * 4);
      } else {
        chunkPositions = new Float32Array(chunkSize * 3);
        chunkColors = new Uint8Array(chunkSize * 4);
        for (let i = 0; i < chunkSize; i++) {
          const srcIdx = toSourceIndex(i);

          chunkPositions[i * 3] = data.positions[srcIdx * 3];
          chunkPositions[i * 3 + 1] = data.positions[srcIdx * 3 + 1];
          chunkPositions[i * 3 + 2] = data.positions[srcIdx * 3 + 2];

          chunkColors[i * 4] = colors[srcIdx * 4];
          chunkColors[i * 4 + 1] = colors[srcIdx * 4 + 1];
          chunkColors[i * 4 + 2] = colors[srcIdx * 4 + 2];
          chunkColors[i * 4 + 3] = colors[srcIdx * 4 + 3];
        }
      }

      // Describes the picked point of this chunk, or null for a miss.
      const pickedPoint = (info: PickingInfo): PickedPointInfo | null => {
        if (info.index >= 0 && info.picked && info.index < chunkSize) {
          const originalIndex = toSourceIndex(info.index);
          const pointInfo: PickedPointInfo = {
            pointCloudId: id,
            index: originalIndex,
            longitude: coordinateOrigin[0] + chunkPositions[info.index * 3],
            latitude: coordinateOrigin[1] + chunkPositions[info.index * 3 + 1],
            elevation: chunkPositions[info.index * 3 + 2] + zOffset,
            x: info.x,
            y: info.y,
          };

          if (data.intensities) {
            pointInfo.intensity = data.intensities[originalIndex];
          }

          if (data.classifications) {
            pointInfo.classification = data.classifications[originalIndex];
          }

          // Add RGB colors if available
          if (data.colors && data.hasRGB) {
            pointInfo.red = data.colors[originalIndex * 4];
            pointInfo.green = data.colors[originalIndex * 4 + 1];
            pointInfo.blue = data.colors[originalIndex * 4 + 2];
          }

          // Add all extra attributes dynamically
          if (data.extraAttributes) {
            const attributes: Record<string, number> = {};
            for (const [name, arr] of Object.entries(data.extraAttributes)) {
              if (arr && originalIndex < arr.length) {
                attributes[name] = arr[originalIndex];
              }
            }
            if (Object.keys(attributes).length > 0) {
              pointInfo.attributes = attributes;
            }
          }

          return pointInfo;
        }
        return null;
      };
      const handleHover = (info: PickingInfo) => {
        this._options.onHover?.(pickedPoint(info));
      };
      const handleClick = (info: PickingInfo) => {
        const point = pickedPoint(info);
        if (point) this._options.onClick?.(point);
      };

      // Create a unique data fingerprint to force deck.gl to update
      const elevationKey = elevationRange ? `${elevationRange[0]}-${elevationRange[1]}` : 'none';
      const filterKey = filterRange ? `${filterRange[0]}-${filterRange[1]}` : 'none';

      const layer = new PointCloudLayer({
        id: `pointcloud-${id}-chunk${chunk}`,
        coordinateSystem: COORDINATE_SYSTEM.LNGLAT_OFFSETS,
        coordinateOrigin: layerOrigin,
        data: {
          length: chunkSize,
          attributes: {
            getPosition: { value: chunkPositions, size: 3 },
            getColor: { value: chunkColors, size: 4 },
          },
        },
        ...this._getPointSizeProps(coordinateOrigin[1]),
        opacity: layerOpacity,
        getNormal: [0, 0, 1],
        pickable: this._options.pickable,
        onHover: this._options.pickable ? handleHover : undefined,
        onClick: this._options.pickable ? handleClick : undefined,
        autoHighlight: this._options.pickable,
        highlightColor: [255, 255, 0, 200],
        // Force update when these values change
        updateTriggers: {
          getPosition: [elevationKey, filterKey, chunkSize],
          getColor: [elevationKey, filterKey, chunkSize],
        },
      });

      this._deckOverlay.addLayer(`pointcloud-${id}-chunk${chunk}`, layer);
    }

    this._removeChunkLayers(id, numChunks, pc.chunkSizes.length);
    this._pointClouds.set(id, { ...pc, chunkSizes });
  }

  /**
   * Removes a point cloud's chunk layers `from` to `to`, exclusive.
   */
  private _removeChunkLayers(id: string, from: number, to: number): void {
    for (let chunk = from; chunk < to; chunk++) {
      this._deckOverlay.removeLayer(`pointcloud-${id}-chunk${chunk}`);
    }
  }

  /**
   * Gets the deck.gl size props for a point cloud at the given latitude.
   */
  private _getPointSizeProps(latitudeDeg: number): { pointSize: number; sizeUnits: 'pixels' | 'meters' } {
    const { pointSize, pointSizeReferenceZoom, minPointSizeMeters } = this._options;
    if (pointSizeReferenceZoom === undefined) {
      return { pointSize, sizeUnits: 'pixels' };
    }
    return {
      pointSize: pointSizeMeters(pointSize, pointSizeReferenceZoom, latitudeDeg, minPointSizeMeters ?? 0),
      sizeUnits: 'meters',
    };
  }

  /**
   * Updates all layers with current options.
   */
  private _updateAllLayers(): void {
    for (const id of this._pointClouds.keys()) {
      this._createLayer(id);
    }
  }
}
