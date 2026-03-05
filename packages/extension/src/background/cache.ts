import type { CachedSearch, SearchResponse } from "@shopping-assistant/shared";
import { CACHE_TTL_MS, CACHE_MAX_ENTRIES, CACHE_SESSION_THRESHOLD_MS } from "@shopping-assistant/shared";

function cacheKey(productId: string): string {
  return `search_${productId}`;
}

export async function getCached(productId: string): Promise<SearchResponse | null> {
  const key = cacheKey(productId);
  const data = await chrome.storage.local.get(key);
  const entry: CachedSearch | undefined = data[key];
  if (!entry) return null;

  if (Date.now() - entry.cachedAt > (entry.ttl ?? CACHE_TTL_MS)) {
    await chrome.storage.local.remove(key);
    return null;
  }

  // Update last-access time for true LRU eviction
  await chrome.storage.local.set({ [key]: { ...entry, lastAccessedAt: Date.now() } });
  return entry.response;
}

export async function setCached(productId: string, response: SearchResponse): Promise<void> {
  const now = Date.now();
  const entry: CachedSearch = {
    productId,
    response,
    cachedAt: now,
    lastAccessedAt: now,
    ttl: CACHE_TTL_MS,
  };

  await chrome.storage.local.set({ [cacheKey(productId)]: entry });
  await evictIfNeeded();
}

async function evictIfNeeded(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const entries: Array<{ key: string; cachedAt: number }> = [];

  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("search_") && value?.cachedAt) {
      entries.push({ key, cachedAt: value.lastAccessedAt ?? value.cachedAt });
    }
  }

  if (entries.length <= CACHE_MAX_ENTRIES) return;

  // LRU: evict least-recently-accessed entries first
  entries.sort((a, b) => a.cachedAt - b.cachedAt);
  const toRemove = entries.slice(0, entries.length - CACHE_MAX_ENTRIES).map((e) => e.key);
  await chrome.storage.local.remove(toRemove);
}

export async function cleanupStaleEntries(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const toRemove: string[] = [];

  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("search_") && value?.cachedAt) {
      if (now - value.cachedAt > CACHE_SESSION_THRESHOLD_MS) {
        toRemove.push(key);
      }
    }
  }

  if (toRemove.length > 0) {
    await chrome.storage.local.remove(toRemove);
    console.log(`[Personal Shopper] Cleaned up ${toRemove.length} stale cache entries`);
  }
}
