export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
export const CACHE_MAX_ENTRIES = 50;
export const CACHE_SESSION_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
export const PRICE_FALLBACK_TIMEOUT_MS = 5_000;
export const MAX_PRICE_FALLBACK_RESULTS = 5;
export const IDENTIFY_TIMEOUT_MS = 8_000;
export const SEARCH_TIMEOUT_MS = 20_000;
export const CHAT_TIMEOUT_MS = 10_000;
export const MAX_CHAT_HISTORY = 20;
export const SIDE_PANEL_WIDTH_PX = 360;

export const CONFIDENCE_THRESHOLDS = {
  high: 0.7,
  medium: 0.4,
} as const;

export const MIN_CONFIDENCE_SCORE = 0.15;

export const MAX_RESULTS_FOR_RANKING = 15;
export const MAX_IMAGES_FOR_RANKING = 5;
export const RANKING_IMAGE_TIMEOUT_MS = 3_000;

export const OVERLAY_ICON_SIZE_PX = 28;
export const OVERLAY_ICON_HOVER_SIZE_PX = 32;
export const MIN_IMAGE_SIZE_PX = 100;
export const OVERLAY_TITLE_HINT_MAX_LENGTH = 200;
