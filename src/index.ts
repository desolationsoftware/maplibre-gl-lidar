// Import styles
import './lib/styles/lidar-control.css';

// Main entry point - Core exports
export { LidarControl } from './lib/core/LidarControl';
export { DECK_CANVAS_CLASS, DeckOverlay } from './lib/core/DeckOverlay';
export { ViewportManager } from './lib/core/ViewportManager';
export { TilePointCloudSource } from './lib/core/TilePointCloudSource';
export { PointCloudLoader } from './lib/loaders/PointCloudLoader';
export { CopcStreamingLoader } from './lib/loaders/CopcStreamingLoader';
export { EptStreamingLoader } from './lib/loaders/EptStreamingLoader';
export { PointCloudManager } from './lib/layers/PointCloudManager';
export {
  ColorSchemeProcessor,
  getClassificationName,
  getClassificationColor,
  getAttributeValues,
  isGradientColorScheme,
  formatAttributeLabel,
  type ClassificationStyles,
} from './lib/colorizers/ColorScheme';
export { COLORMAPS, COLORMAP_NAMES, COLORMAP_LABELS, getColormap } from './lib/colorizers/Colormaps';

// Tools exports
export { CrossSectionTool, ElevationProfileExtractor } from './lib/tools';

// GUI exports
export { MetadataPanel } from './lib/gui/MetadataPanel';
export { CrossSectionPanel } from './lib/gui/CrossSectionPanel';
export { ElevationProfileChart } from './lib/gui/ElevationProfileChart';

// Layer control adapter
export { LidarLayerAdapter } from './lib/adapters';

// Type exports
export type {
  LidarControlOptions,
  LidarSampleDataset,
  LidarState,
  LidarControlEvent,
  LidarControlEventHandler,
  LidarEventData,
  PointCloudInfo,
  PointCloudBounds,
  ColorScheme,
  ColorSchemeType,
  ColorSchemeConfig,
  CopcLoadingMode,
  PointCloudLoadOptions,
  ColormapName,
  ColorRangeConfig,
  // Metadata types
  DimensionInfo,
  CopcMetadata,
  EptExtendedMetadata,
  PointCloudFullMetadata,
  // Cross-section types
  CrossSectionLine,
  ProfilePoint,
  ElevationProfile,
} from './lib/core/types';

export type {
  PointCloudData,
  PointNodeRange,
  LoaderOptions,
} from './lib/loaders/types';

export type {
  StreamingLoaderOptions,
  StreamingProgressEvent,
  ViewportInfo,
  CachedNode,
  NodeKey,
  NodeState,
  StreamingLoaderEvent,
  StreamingLoaderEventHandler,
  StreamingLoadOptions,
} from './lib/loaders/streaming-types';

export type {
  EptMetadata,
  EptDimension,
  EptSrs,
  EptHierarchy,
  EptCachedNode,
} from './lib/loaders/ept-types';

export type {
  TilePointCloudHost,
  TilePointCloudSourceOptions,
} from './lib/core/TilePointCloudSource';
export { TileId } from './lib/utils/tileMath';
export type { LngLatBounds, TileRange } from './lib/utils/tileMath';

export type {
  PointCloudLayerOptions,
} from './lib/layers/types';

// Utility exports
export {
  clamp,
  formatNumericValue,
  getAdaptiveRangeStep,
  generateId,
  debounce,
  throttle,
  classNames,
  formatNumber,
  formatBytes,
  getFilename,
  LIDAR_SHARE_PARAM,
  LIDAR_SHARE_VERSION,
  createLidarSharePayload,
  encodeLidarSharePayload,
  decodeLidarSharePayload,
  createLidarShareUrl,
  parseLidarSharePayloadFromUrl,
  hasLidarShareParams,
} from './lib/utils';

export type {
  LidarShareMapState,
  LidarShareVisualization,
  LidarSharePayload,
} from './lib/utils';
