import type { SavedLink } from "./SidepanelStateContext";

export interface PersistedSidepanelSettings {
  selectedThemeId?: string;
  savedLinks?: SavedLink[];
}

const STORAGE_KEY = "sidepanelSettings";

export async function loadSidepanelSettings(): Promise<PersistedSidepanelSettings> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return {};
  }

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return (stored?.[STORAGE_KEY] as PersistedSidepanelSettings | undefined) ?? {};
}

export async function saveSidepanelSettings(settings: PersistedSidepanelSettings) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return;
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: settings,
  });
}
