import type { SearchResult } from "@shopping-assistant/shared";

export type ProviderStatus = "ok" | "timeout" | "error";

export interface ProviderSearchOutcome {
  results: SearchResult[];
  status: ProviderStatus;
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  timedOutQueries: number;
}

export interface SplitProviderSearchOutcome {
  textOutcome: ProviderSearchOutcome;
  imageOutcome: ProviderSearchOutcome;
  combinedOutcome: ProviderSearchOutcome;
}

export function resolveProviderStatus(
  successfulQueries: number,
  failedQueries: number,
  timedOutQueries: number,
): ProviderStatus {
  if (failedQueries === 0) return "ok";
  if (successfulQueries === 0 && timedOutQueries === failedQueries) return "timeout";
  return "error";
}
